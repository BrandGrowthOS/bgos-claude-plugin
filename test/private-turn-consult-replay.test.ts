/**
 * Release 0.68.4: a voice consult's private turn (#227) and the fire ledger (#229), together.
 *
 * #227 opens a private turn scoped to one stamped voice consult, ends it with the consult, and refuses a consult id
 * delivered a second time (consultsSeen, in memory). #229 keeps the scheduled fires an agent handled on disk
 * (private-fires.json, 48 hours): a fire delivered again after a restart reaches the agent as text and opens no
 * private turn. Together:
 *
 *   - a replayed fire opens no turn even when its delivery carries a consult stamp;
 *   - a fresh consult after a replay still opens its own turn;
 *   - a consult frame delivered again is refused in the same daemon life (#227) AND after a restart: the consult is
 *     a fire of its own (`consult:<consult id>`) in the agent's ledger, since consultsSeen dies with the process.
 *
 * Each "daemon life" is a new tracker over the same ledger file, as server.ts builds them.
 *
 * Run: npx tsx --test test/private-turn-consult-replay.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, utimesSync, writeFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import * as privateTurnModule from '../lib/private-turn.mjs'
import { createPrivateTurnTracker, privateMarkerPath, privateRevokeLine, requirePrivateTurn, voiceConsultActor } from '../lib/private-turn.mjs'
import { floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import { recordPrivateBoundary } from '../bin/hoai-private-turn-hook.mjs'

// Read through the module so this file loads on a head without the ledger (#227 alone): there the tests fail on the
// behaviour they pin, not on an import.
const createFireLedger: (options: { path: string, now?: () => number, readTranscript?: (session: string) => string }) => any = (privateTurnModule as any).createFireLedger ?? (() => null)
const privateFiresPath: (root: string, id: string) => string =
  (privateTurnModule as any).privateFiresPath ?? ((root: string, id: string) => join(root, id, 'private-fires.json'))
const privateReplayLine: (replay: Record<string, unknown>) => string =
  (privateTurnModule as any).privateReplayLine ?? ((replay: Record<string, unknown>) => `(no replay line: ${JSON.stringify(replay)})`)

const OWNER = 'user_owner'
const AGENT = '1040'
const T0 = Date.parse('2026-10-13T04:30:00.000Z')

/** The voice_rpc consult frame exactly as the backend stamps it (#227's fixture shape). */
function stamped(rpcId: string, expiresInMs = 45_000) {
  return {
    rpcId, op: 'consult', assistantId: AGENT, agentRoute: '', chatId: '10',
    payload: {
      callId: 'tool-1', name: 'agent_consult', args: { question: 'Remind me to call Sam at five' }, voiceSessionId: '501',
      eventMeta: { source: 'voice_consult', payload: { actingUserId: OWNER, consultId: rpcId, assistantId: AGENT, voiceSessionId: '501', expiresAt: new Date(T0 + expiresInMs).toISOString() } },
    },
  }
}

/** One agent folder and its ledger; `life()` is one daemon process over them. */
function agentHome(t: any) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-consult-replay-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'agent')
  mkdirSync(cwd)
  const env = { ...process.env, BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: cwd }
  markFloorAttached({ root, folders: [cwd] })
  const markerPaths = [privateMarkerPath(root, floorKey(cwd))]
  const firesPath = privateFiresPath(root, AGENT)
  const clock = { now: T0 }
  const transcripts = new Map<string, string>()
  let session = 0
  function life() {
    const replays: string[] = []
    const revokes: string[] = []
    const outcomes: string[] = []
    const tracker = createPrivateTurnTracker({
      now: () => clock.now,
      markerPaths,
      fires: createFireLedger({ path: firesPath, now: () => clock.now, readTranscript: id => transcripts.get(id) ?? '' }),
      onReplay: (replay) => replays.push(privateReplayLine(replay)),
      onRevoke: (info) => revokes.push(privateRevokeLine(info)),
    })
    const sessionId = `session-${++session}`
    /** Claude Code submits a delivered card through the real synchronous hook; the daemon begins it. */
    const submit = (prompt: string) => {
      recordPrivateBoundary({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd, prompt }, env)
      outcomes.push(tracker.begin({ prompt, sessionId }))
    }
    /** server.ts's voice notify: a consult card through deliver(), the owner only from the backend stamp. */
    const consult = (frame: ReturnType<typeof stamped>, extra: Record<string, unknown> = {}) => {
      const actor = voiceConsultActor({ frame, assistantId: AGENT, ownerUserId: OWNER, now: clock.now })
      return tracker.deliver({
        content: '[voice_consult] Remind me to call Sam at five',
        actingUserId: actor?.actingUserId ?? null, chatId: String(frame.chatId),
        consult: { consultId: frame.rpcId, deadline: actor?.deadline ?? null },
        ...extra,
      } as any)
    }
    /** A native scheduled wake through a message lane. */
    const wake = (fireId: string) => tracker.deliver({
      content: '[System message] Check the boards', actingUserId: OWNER, chatId: '10', fireKey: `native:${fireId}`,
    } as any)
    /** The daemon's answer to the model's first private call: the acting user, or null when refused. */
    const call = () => { try { return requirePrivateTurn(tracker, markerPaths, OWNER).actingUserId } catch { return null } }
    const stop = () => {
      recordPrivateBoundary({ hook_event_name: 'Stop', session_id: sessionId, cwd }, env)
      tracker.end()
    }
    const act = (tool: string) => tracker.noteOutbound(tool, markerPaths)
    return { tracker, submit, consult, wake, call, act, stop, sessionId, replays, revokes, outcomes }
  }
  const ledgerKeys = (): string[] => { try { return Object.keys((JSON.parse(readFileSync(firesPath, 'utf8')) as any).fires) } catch { return [] } }
  const startupPrompt = (sessionId: string) => recordPrivateBoundary({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd,
    prompt: '<task-notification><status>killed</status></task-notification>',
  }, env)
  return { life, clock, ledgerKeys, transcripts, firesPath, startupPrompt }
}

test('a normal stop closes an admitted message even after its private authority was revoked', (t) => {
  const home = agentHome(t)
  const first = home.life()
  const key = 'owner:1'
  first.submit(first.tracker.deliver({ actingUserId: OWNER, chatId: 'first', content: 'continue', fireKey: key }))
  first.tracker.noteUntracked({ chatId: 'second' })
  assert.equal(first.call(), null)
  assert.equal(home.life().tracker.canRecover(key), true)
  first.stop()
  assert.equal(home.life().tracker.canRecover(key), false)
})

for (const interruption of ['another chat', 'another person', 'peer', 'meeting', 'startup prompt', 'combined']) {
  test(`an unanswered started message survives ${interruption}`, (t) => {
    const home = agentHome(t)
    const message = { content: 'Carry on', actingUserId: OWNER, chatId: 'first', fireKey: 'owner:1' }
    const first = home.life()
    const card = first.tracker.deliver(message)
    first.submit(card)
    assert.equal(first.call(), OWNER)
    home.transcripts.set(first.sessionId, [
      { type: 'user', message: { content: card } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'background_task' }] } },
      { type: 'assistant', isApiErrorMessage: true, apiError: 'usage_limit_reached' },
    ].map(row => JSON.stringify(row)).join('\n'))
    if (interruption === 'another chat' || interruption === 'combined') {
      first.tracker.deliver({ content: 'update', chatId: 'second', actingUserId: OWNER })
    } else if (interruption === 'peer') {
      first.tracker.deliver({ content: 'update', chatId: 'first', peerSourceAssistantId: 'peer' })
    } else if (interruption === 'another person') {
      first.tracker.deliver({ content: 'update', chatId: 'first', actingUserId: 'user_other' })
    } else if (interruption === 'meeting') {
      first.tracker.noteUntracked({ chatId: 'first' })
    }
    if (interruption === 'startup prompt' || interruption === 'combined') {
      home.clock.now = T0 + 3_000
      home.startupPrompt(first.sessionId)
    }
    home.clock.now = T0 + 5_000
    let answers = 0
    for (let boot = 0; boot < 2; boot++) {
      const next = home.life()
      assert.equal(next.tracker.canRecover(message.fireKey), boot === 0)
      if (next.tracker.canRecover(message.fireKey)) {
        const redelivery = next.tracker.deliver({ ...message, recoveryWithoutReply: true })
        assert.match(redelivery, /^\[Interrupted:/)
        next.submit(redelivery)
        assert.equal(next.call(), OWNER)
        next.act('reply')
        next.tracker.noteHandled('reply:1')
        answers++
      }
    }
    assert.equal(answers, 1)
  })
}

test('an explicit reply closes an open message despite startup marker drift', (t) => {
  const home = agentHome(t)
  const first = home.life()
  const key = 'owner:1'
  first.submit(first.tracker.deliver({ actingUserId: OWNER, chatId: 'first', content: 'continue', fireKey: key }))
  assert.equal(first.call(), OWNER)
  first.tracker.noteHandled('reply:1')
  home.startupPrompt(first.sessionId)
  assert.equal(home.life().tracker.canRecover(key), false)
})

test('restart recovery can answer a killed turn once, even after another boot', (t) => {
  const home = agentHome(t)
  const id = home.clock.now
  const message = { content: 'continue', actingUserId: OWNER, chatId: 'chat', fireKey: `owner:${id}` }
  const first = home.life()
  first.submit(first.tracker.deliver(message))
  assert.equal(first.call(), OWNER)
  const recovered = home.life()
  const prompt = recovered.tracker.deliver({ ...message, recoveryWithoutReply: true })
  assert.match(prompt, /^\[Interrupted: check what you already did before acting again\.\]/)
  recovered.submit(prompt)
  assert.equal(recovered.call(), OWNER)
  const again = home.life()
  again.submit(again.tracker.deliver({ ...message, recoveryWithoutReply: true }))
  assert.equal(again.call(), null)
  assert.deepEqual(again.outcomes, ['replayed'])
})

test('a claim write error skips delivery without calling the message handled', (t) => {
  const home = agentHome(t)
  const message = { content: 'continue', actingUserId: OWNER, chatId: 'chat', fireKey: `owner:${home.clock.now}` }
  const first = home.life()
  first.submit(first.tracker.deliver(message))
  assert.equal(first.call(), OWNER)
  const next = home.life()
  const original = fs.writeFileSync
  const fault = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof original>) => {
    if (String(args[0]).endsWith('.claimed')) throw new Error('fixture write failure')
    return original(...args)
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => next.tracker.deliver({ ...message, recoveryWithoutReply: true }), {
      message: 'Could not save the recovery claim. Skipped the interrupted message.',
    })
    assert.equal(next.call(), null)
    assert.deepEqual(next.replays, [])
  } finally {
    fault.mock.restore()
    syncBuiltinESMExports()
  }
})

test('boot cleans only recovery files older than seven days', (t) => {
  const home = agentHome(t)
  const dir = join(dirname(home.firesPath), 'interrupted-turns')
  mkdirSync(dir, { recursive: true })
  const cutoff = home.clock.now - 7 * 24 * 3600_000
  for (const [name, at] of [
    ['a'.repeat(64) + '.open', cutoff - 1000],
    ['a'.repeat(64) + '.claimed', cutoff - 1000],
    ['a'.repeat(64) + '.attempt', cutoff - 1000],
    ['a'.repeat(64) + '.tool', cutoff - 1000],
    ['b'.repeat(64) + '.claimed', cutoff],
    ['unrelated', cutoff - 1000],
  ] as const) {
    const path = join(dir, name)
    writeFileSync(path, '')
    utimesSync(path, new Date(at), new Date(at))
  }
  home.life()
  for (const suffix of ['open', 'claimed', 'attempt', 'tool']) assert.equal(existsSync(join(dir, 'a'.repeat(64) + '.' + suffix)), false)
  assert.ok(existsSync(join(dir, 'b'.repeat(64) + '.claimed')))
  assert.ok(existsSync(join(dir, 'unrelated')))
})

for (const work of ['none', 'tool record', 'tool hook', 'other prompt', 'other error']) {
  test(`a refused recovery gives back its chance only for its own tool-free turn: ${work}`, (t) => {
    const home = agentHome(t)
    const key = `owner:${home.clock.now}`
    const message = { content: 'continue', actingUserId: OWNER, chatId: 'chat', fireKey: key }
    const first = home.life()
    first.submit(first.tracker.deliver(message))
    assert.equal(first.call(), OWNER)
    const limited = home.life()
    const card = limited.tracker.deliver({ ...message, recoveryWithoutReply: true })
    limited.submit(card)
    assert.equal(limited.call(), OWNER)
    if (work === 'tool hook') limited.act('read')
    const rows = [
      { type: 'user', message: { content: work === 'other prompt' ? 'another request' : card } },
      ...(work === 'tool record' ? [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'read' }] } }] : []),
      { type: 'assistant', isApiErrorMessage: true, apiError: work === 'other error' ? 'authentication_failed' : 'usage_limit_reached' },
    ]
    home.transcripts.set(limited.sessionId, rows.map(row => JSON.stringify(row)).join('\n'))
    limited.stop()
    const next = home.life()
    assert.equal(next.tracker.canRecover(key), work === 'none')
    if (work !== 'none') return
    const retry = next.tracker.deliver({ ...message, recoveryWithoutReply: true })
    assert.equal(home.life().tracker.canRecover(key), false, 'a second boot cannot spend the same refusal twice')
    next.submit(retry)
    assert.equal(next.call(), OWNER)
    next.act('reply')
    next.tracker.noteHandled(`reply:${home.clock.now}`)
    next.stop()
    assert.equal(home.life().tracker.canRecover(key), false)
  })
}

for (const action of ['react', 'call_owner', 'reply', 'meeting_reply', 'edit_message', 'ask_user_input', 'stop', 'restart yourself']) {
  test(`recovery excludes a message handled by ${action}`, (t) => {
    const home = agentHome(t)
    const message = { content: action === 'restart yourself' ? action : 'continue',
      actingUserId: OWNER, chatId: 'chat', fireKey: `owner:${home.clock.now}` }
    const first = home.life()
    first.submit(first.tracker.deliver(message))
    assert.equal(first.call(), OWNER)
    if (action === 'stop') first.stop()
    else if (action !== 'restart yourself') first.act(action)
    const next = home.life()
    next.submit(next.tracker.deliver({ ...message, recoveryWithoutReply: true }))
    assert.equal(next.call(), null)
    assert.deepEqual(next.outcomes, ['replayed'])
  })
}

test('a replayed fire opens no turn even when its delivery carries a consult stamp', (t) => {
  const home = agentHome(t)
  const first = home.life()
  first.submit(first.wake('F1'))
  assert.equal(first.call(), OWNER, 'the fire opens the owner turn the first time')
  first.stop()
  // The next daemon life: the same fire comes back, this time on a card that also carries a valid consult stamp.
  const second = home.life()
  const card = second.consult(stamped('11111111-1111-4111-8111-111111111111'), { fireKey: 'native:F1' })
  assert.match(card, /^\[replayed: /)
  second.submit(card)
  assert.equal(second.call(), null, 'no consult turn for a fire already handled')
  assert.deepEqual(second.outcomes, ['replayed'])
  assert.equal(second.replays.length, 1)
})

test('a fresh consult after a replay still opens its own turn, and it ends with the consult', (t) => {
  const home = agentHome(t)
  const first = home.life()
  first.submit(first.wake('F2'))
  assert.equal(first.call(), OWNER)
  first.stop()
  const second = home.life()
  second.submit(second.wake('F2'))
  assert.equal(second.call(), null, 'the replay opens nothing')
  second.stop()
  const rpc = '22222222-2222-4222-8222-222222222222'
  second.submit(second.consult(stamped(rpc)))
  assert.equal(second.call(), OWNER, 'a fresh consult opens its turn')
  assert.equal(second.tracker.endConsult(rpc), true)
  assert.equal(second.call(), null, 'and its turn ends with the consult (#227)')
})

test('a replayed consult frame is refused in the same daemon life (#227), and its card says it is a replay', (t) => {
  const home = agentHome(t)
  const one = home.life()
  const frame = stamped('33333333-3333-4333-8333-333333333333')
  one.submit(one.consult(frame))
  assert.equal(one.call(), OWNER)
  one.tracker.endConsult(frame.rpcId)
  const again = one.consult(frame)
  assert.match(again, /^\[replayed: this voice consult was already handled at /)
  one.submit(again)
  assert.equal(one.call(), null, 'a consult id delivered a second time names nobody')
})

test('a replayed consult frame is refused after a restart, too: the consult is a fire of its own in the ledger', (t) => {
  const home = agentHome(t)
  const first = home.life()
  const frame = stamped('44444444-4444-4444-8444-444444444444')
  first.submit(first.consult(frame))
  assert.equal(first.call(), OWNER, 'the consult opens its turn once')
  // The daemon restarts within the consult's window, and the same frame arrives again.
  home.clock.now += 5_000
  const second = home.life()
  const card = second.consult(frame)
  assert.match(card, /^\[replayed: this voice consult was already handled at 2026-10-13T04:30:00\.000Z; it opens no private turn\]/)
  second.submit(card)
  assert.equal(second.call(), null, 'no second turn for the same consult')
  assert.deepEqual(second.outcomes, ['replayed'])
  assert.match(second.replays[0]!, /^private turn: replayed fire consult:44444444-4444-4444-8444-444444444444, already handled at 2026-10-13T04:30:00\.000Z$/)
  assert.ok(home.ledgerKeys().includes(`consult:${frame.rpcId}`))
})

test('a consult that never became usable is not used up: delivered again after a restart, it opens', (t) => {
  const home = agentHome(t)
  const first = home.life()
  const frame = stamped('55555555-5555-4555-8555-555555555555')
  first.consult(frame)
  // Never submitted (the daemon died first): nothing recorded.
  const second = home.life()
  second.submit(second.consult(frame))
  assert.equal(second.call(), OWNER)
})

test('a replay injected into a consult\'s turn ends it, for #227\'s reason', (t) => {
  const home = agentHome(t)
  const first = home.life()
  first.submit(first.wake('F6'))
  assert.equal(first.call(), OWNER)
  first.stop()
  const second = home.life()
  second.submit(second.consult(stamped('66666666-6666-4666-8666-666666666666')))
  assert.equal(second.call(), OWNER)
  second.wake('F6')
  assert.equal(second.call(), null)
  assert.match(second.revokes.at(-1)!, /^private turn: a delivery that is not this voice consult \(chat 10\) ended the private turn/)
})

test('a consult answered or expired before its card was submitted is not used up, though another prompt began first', (t) => {
  const home = agentHome(t)
  const first = home.life()
  const frame = stamped('77777777-7777-4777-8777-777777777777')
  first.consult(frame)
  // The consult ends (answered, timed out, or its delivery failed) before its card is submitted.
  first.tracker.endConsult(frame.rpcId)
  // Another prompt begins, and the turn ends: neither records the consult's fire.
  first.submit(first.wake('F7'))
  first.stop()
  assert.ok(!home.ledgerKeys().includes(`consult:${frame.rpcId}`), 'never usable, so never recorded')
  // After a restart, inside its window, the same frame still opens its one turn.
  const second = home.life()
  second.submit(second.consult(frame))
  assert.equal(second.call(), OWNER)
})

test('an unstamped consult is no fire: it never enters the ledger', (t) => {
  const home = agentHome(t)
  const one = home.life()
  const unstamped = { ...stamped('88888888-8888-4888-8888-888888888888'), payload: { callId: 'tool-1', name: 'agent_consult', args: {}, voiceSessionId: '501' } }
  one.submit(one.consult(unstamped as any))
  assert.equal(one.call(), null, 'an unstamped consult opens nothing (#227)')
  one.stop()
  // Another unstamped consult the CLI never submits on its own (injected into the next prompt's turn): still no fire.
  one.consult({ ...unstamped, rpcId: '88888888-8888-4888-8888-888888888889' } as any)
  one.submit(one.wake('F8'))
  one.stop()
  assert.ok(!home.ledgerKeys().some((key) => key.startsWith('consult:')), home.ledgerKeys().join(', '))
})

test('a consult with a very long id is keyed by its hash, so no key outgrows the ledger', (t) => {
  const home = agentHome(t)
  const first = home.life()
  const long = 'c'.repeat(600)
  const frame = stamped(long)
  first.submit(first.consult(frame))
  assert.equal(first.call(), OWNER)
  const keys = home.ledgerKeys().filter((key) => key.startsWith('consult:'))
  assert.equal(keys.length, 1)
  assert.match(keys[0]!, /^consult:#[a-f0-9]{32}$/)
  const second = home.life()
  const card = second.consult(frame)
  assert.match(card, /^\[replayed: this voice consult was already handled at /, 'and the hashed key still catches its replay')
})
