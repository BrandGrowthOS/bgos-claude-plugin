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
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs, { existsSync, utimesSync, writeFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import * as privateTurnModule from '../lib/private-turn.mjs'
import { createPrivateTurnTracker, privateMarkerPath, privateRevokeLine, requirePrivateTurn, voiceConsultActor } from '../lib/private-turn.mjs'
import { floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import { spoolPath } from '../bin/hoai-hook.mjs'
import { recordPrivateBoundary } from '../bin/hoai-private-turn-hook.mjs'

// Read through the module so this file loads on a head without the ledger (#227 alone): there the tests fail on the
// behaviour they pin, not on an import.
const createFireLedger: (options: { path: string, now?: () => number, readTranscript?: (session: string) => string, log?: (line: string) => void }) => any = (privateTurnModule as any).createFireLedger ?? (() => null)
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
  const logs: string[] = []
  let session = 0
  function life() {
    const replays: string[] = []
    const revokes: string[] = []
    const outcomes: string[] = []
    const tracker = createPrivateTurnTracker({
      now: () => clock.now,
      markerPaths,
      fires: createFireLedger({ path: firesPath, now: () => clock.now, readTranscript: id => transcripts.get(id) ?? '', log: line => logs.push(line) }),
      onReplay: (replay) => replays.push(privateReplayLine(replay)),
      onRevoke: (info) => revokes.push(privateRevokeLine(info)),
    })
    const sessionId = `session-${++session}`
    /** Claude Code submits a delivered card through the real synchronous hook; the daemon begins it. */
    const submit = (prompt: string, release = true) => {
      const recorded = recordPrivateBoundary({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd, prompt }, env)
      if (recorded && release) privateTurnModule.recoveryPromptDecision(prompt, recorded.path, root, sessionId, process.pid, clock.now)
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
    const stopHook = () => recordPrivateBoundary({ hook_event_name: 'Stop', session_id: sessionId, cwd }, env)
    const stop = () => {
      stopHook()
      tracker.end()
    }
    const act = (tool: string, chat?: string) => tracker.noteOutbound(tool, markerPaths,
      chat ?? (tool === 'reply' ? tracker.current({ markerPaths })?.chatId : undefined))
    const dispatch = (tool: string) => tracker.outboundCompletion(tool, markerPaths)
    return { tracker, stopHook, dispatch, submitWithoutRelease: (prompt: string) => submit(prompt, false), submit, consult, wake, call, act, stop, sessionId, replays, revokes, outcomes }
  }
  const ledgerKeys = (): string[] => { try { return Object.keys((JSON.parse(readFileSync(firesPath, 'utf8')) as any).fires) } catch { return [] } }
  const startupPrompt = (sessionId: string) => recordPrivateBoundary({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd,
    prompt: '<task-notification><status>killed</status></task-notification>',
  }, env)
  const runPromptHook = (sessionId: string, prompt: string) => {
    const hook = fileURLToPath(new URL('../bin/hoai-private-turn-hook.mjs', import.meta.url))
    const child = spawnSync(process.execPath, [hook], { env, encoding: 'utf8', windowsHide: true,
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd, prompt }) })
    assert.equal(child.status, 0, child.stderr)
    return child.stdout.trim() ? JSON.parse(child.stdout) : null
  }
  const runUnservedHook = (sessionId: string, prompt: string) => {
    markFloorAttached({ root, folders: [cwd], sessionId: 'other-session' })
    const hook = fileURLToPath(new URL('../bin/hoai-private-turn-hook.mjs', import.meta.url))
    const child = spawnSync(process.execPath, [hook], { env, encoding: 'utf8',
      windowsHide: true, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd, prompt }) })
    assert.equal(child.stdout.trim(), '')
    assert.equal(child.status, 1, child.stderr)
  }
  return { runUnservedHook, runPromptHook, paths: markerPaths, life, clock, ledgerKeys, transcripts, firesPath, startupPrompt, logs, markerPath: markerPaths[0]! }
}

for (const [card, action] of [['peer', 'call_owner'], ['other chat', 'meeting_reply'], ['meeting', 'send_to_peer']]) {
  test(`a live delivery tag ties ${action} to its request after a ${card} card`, t => {
    const home = agentHome(t)
    const first = home.life()
    const key = 'owner:1'
    first.submit(first.tracker.deliver({ content: 'continue', chatId: 'first', actingUserId: OWNER, fireKey: key }))
    assert.equal(first.call(), OWNER)
    if (card === 'peer') first.tracker.deliver({ content: 'update', chatId: 'first', peerSourceAssistantId: 'peer' })
    else if (card === 'meeting') first.tracker.noteUntracked({ chatId: 'first' })
    else first.tracker.deliver({ content: 'update', chatId: 'second', actingUserId: OWNER })
    assert.equal(first.call(), null)
    first.act(action!)
    assert.equal(home.life().tracker.canRecover(key), false)
  })
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

for (const interruption of ['another chat', 'another person', 'peer', 'meeting', 'startup prompt']) {
  test(`an unanswered started message survives ${interruption}`, (t) => {
    const home = agentHome(t)
    const message = { content: 'Carry on', actingUserId: OWNER, chatId: 'first', fireKey: 'owner:1' }
    const first = home.life()
    const card = first.tracker.deliver(message)
    first.submit(card)
    assert.equal(first.call(), OWNER)
    if (interruption === 'another chat') {
      first.tracker.deliver({ content: 'update', chatId: 'second', actingUserId: OWNER })
    } else if (interruption === 'peer') {
      first.tracker.deliver({ content: 'update', chatId: 'first', peerSourceAssistantId: 'peer' })
    } else if (interruption === 'another person') {
      first.tracker.deliver({ content: 'update', chatId: 'first', actingUserId: 'user_other' })
    } else if (interruption === 'meeting') {
      first.tracker.noteUntracked({ chatId: 'first' })
    }
    if (interruption === 'startup prompt') {
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
        assert.match(redelivery, /^<hoai-recovery /)
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
  assert.match(prompt, /^<hoai-recovery /)
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
    ['a'.repeat(64) + '.closed', cutoff - 1000],
    ['a'.repeat(64) + '.claimed', cutoff - 1000],
    ['a'.repeat(64) + '.shown', cutoff - 1000],
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
  for (const suffix of ['open', 'closed', 'claimed', 'shown', 'attempt', 'tool']) assert.equal(existsSync(join(dir, 'a'.repeat(64) + '.' + suffix)), false)
  assert.ok(existsSync(join(dir, 'b'.repeat(64) + '.claimed')))
  assert.ok(existsSync(join(dir, 'unrelated')))
})

for (const shape of ['held behind refused probe', 'expired before admission', 'ambiguous submission']) {
  test(`an interrupted offer spends its chance at admission: ${shape}`, (t) => {
    const home = agentHome(t)
    const key = 'owner:1'
    const message = { content: 'continue', actingUserId: OWNER, chatId: 'first', fireKey: key }
    const original = home.life()
    original.submit(original.tracker.deliver(message))
    assert.equal(original.call(), OWNER)
    const limited = home.life()
    limited.submit('probe')
    home.transcripts.set(limited.sessionId, JSON.stringify({ type: 'assistant', isApiErrorMessage: true, apiError: 'usage_limit_reached' }))
    const held = limited.tracker.deliver({ ...message, recoveryWithoutReply: true })
    if (shape === 'expired before admission') {
      home.clock.now += 24 * 60 * 60_000
      limited.submit(held)
      assert.equal(limited.outcomes.at(-1), 'expired')
    } else if (shape === 'ambiguous submission') {
      limited.submit(held + held)
      assert.equal(limited.outcomes.at(-1), 'ambiguous')
    }
    const working = home.life()
    assert.equal(working.tracker.canRecover(key), true)
    const retry = working.tracker.deliver({ ...message, recoveryWithoutReply: true })
    assert.match(retry, /^<hoai-recovery /)
    working.submit(retry)
    assert.equal(working.call(), OWNER)
    working.act('reply')
    working.tracker.noteHandled('reply:1')
    assert.equal(home.life().tracker.canRecover(key), false)
  })
}

test('an older live marker without tags closes only its adopted request', t => {
  const home = agentHome(t)
  const first = home.life()
  const message = { content: 'continue', chatId: 'first', actingUserId: OWNER, fireKey: 'owner:1' }
  first.submit(first.tracker.deliver(message))
  const marker = JSON.parse(readFileSync(home.markerPath, 'utf8'))
  delete marker.tags
  delete marker.cliTurn
  writeFileSync(home.markerPath, JSON.stringify(marker))
  assert.equal(first.call(), OWNER)
  first.act('call_owner')
  assert.equal(home.life().tracker.canRecover(message.fireKey), false)
})

test('a late Stop from another session cannot close the matching turn', t => {
  const home = agentHome(t)
  const first = home.life()
  const message = { content: 'continue', chatId: 'first', actingUserId: OWNER, fireKey: 'owner:1' }
  first.submit(first.tracker.deliver(message))
  first.stopHook()
  home.startupPrompt(first.sessionId)
  const path = home.markerPath + '.stopped'
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...saved, sessionId: 'other' }))
  first.tracker.end()
  assert.equal(home.life().tracker.canRecover(message.fireKey), true)
})

test('an unrelated claim filename cannot suppress an ordinary delivery', t => {
  const home = agentHome(t)
  const key = 'owner:1'
  const dir = join(dirname(home.firesPath), 'interrupted-turns')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, privateTurnModule.privatePromptHash(key) + '.claimed'), '')
  const ledger = createFireLedger({ path: home.firesPath })
  assert.equal(ledger.claimed(key), false)
})

test('a late Stop drained after the next prompt closes only its original message', t => {
  const home = agentHome(t)
  const first = home.life()
  const message = { content: 'continue', chatId: 'first', actingUserId: OWNER, fireKey: 'owner:1' }
  first.submit(first.tracker.deliver(message))
  assert.equal(first.call(), OWNER)
  first.stopHook()
  home.startupPrompt(first.sessionId)
  const next = { ...message, fireKey: 'owner:2' }
  first.submit(first.tracker.deliver(next))
  first.tracker.end()
  const boot = home.life()
  assert.equal(boot.tracker.canRecover(message.fireKey), false)
  assert.equal(boot.tracker.canRecover(next.fireKey), true)
})


for (const guard of ['token', 'content', 'daemon', 'marker list', 'folder', 'key', 'slot', 'timestamp', 'age', 'closed', 'open', 'tool']) {
  test(`the release hook withholds the request for an invalid ${guard}`, t => {
    const home = agentHome(t)
    home.clock.now = Date.now()
    const message = { content: 'summarize the document', chatId: 'first', actingUserId: OWNER, fireKey: 'owner:1' }
    const first = home.life()
    first.submit(first.tracker.deliver(message))
    const next = home.life()
    const card = next.tracker.deliver({ ...message, recoveryWithoutReply: true })
    const dir = join(dirname(home.firesPath), 'interrupted-turns')
    const offerPath = join(dir, fs.readdirSync(dir).find(name => name.endsWith('.claimed'))!)
    const offer = JSON.parse(readFileSync(offerPath, 'utf8'))
    const source = join(dir, privateTurnModule.privatePromptHash(offer.key))
    switch (guard) {
      case 'token': offer.token = ''; break
      case 'content': offer.content = 1; break
      case 'daemon': offer.pid++; break
      case 'marker list': offer.markers = offer.markers[0]; break
      case 'folder': offer.markers = []; break
      case 'key':
        offer.key = 'invalid'
        fs.copyFileSync(source + '.open', join(dir, privateTurnModule.privatePromptHash(offer.key) + '.open'))
        break
      case 'slot': offer.slot = 'invalid.attempt'; break
      case 'timestamp': delete offer.at; break
      case 'age': offer.at -= privateTurnModule.PRIVATE_TURN_MAX_AGE_MS + 1; break
      case 'closed': writeFileSync(source + '.closed', ''); break
      case 'open': fs.unlinkSync(source + '.open'); break
      case 'tool': writeFileSync(join(dir, offer.slot.replace(/\.attempt$/, '.tool')), ''); break
    }
    writeFileSync(offerPath, JSON.stringify(offer))
    const decision = privateTurnModule.recoveryPromptDecision(card, home.markerPath, dirname(dirname(home.firesPath)), next.sessionId, process.pid)
    assert.equal(decision?.decision, 'block')
    assert.doesNotMatch(JSON.stringify(decision), /summarize the document/)
    assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.shown') || name.endsWith('.attempt')), false)
  })
}

test('an answer before the recovery prompt removes the card before the model can reply', t => {
  const home = agentHome(t)
  home.clock.now = Date.now()
  const first = home.life()
  const message = { content: 'summarize the document', chatId: 'chat', actingUserId: OWNER, fireKey: 'owner:1' }
  first.submit(first.tracker.deliver(message))
  const next = home.life()
  const card = next.tracker.deliver({ ...message, recoveryWithoutReply: true })
  next.tracker.noteHandled('reply:1')
  let answers = 1
  const decision = home.runPromptHook(next.sessionId, card)
  if (decision?.decision !== 'block') answers++
  assert.equal(answers, 1)
  const submission = { prompt: card, sessionId: next.sessionId, promptId: 'submission' }
  assert.equal(next.tracker.begin(submission), 'cancelled-retry')
  assert.equal(next.tracker.begin(submission), 'cancelled-retry')
  assert.doesNotMatch(card, /Interrupted|summarize the document/)
  assert.doesNotMatch(JSON.stringify(decision), /Interrupted|summarize the document/)
  assert.equal(home.life().tracker.canRecover(message.fireKey), false)
})

test('showing a retry beside another prompt leaves its own admission unspent', t => {
  const home = agentHome(t)
  home.clock.now = Date.now()
  const first = home.life()
  const message = { content: 'summarize the document', chatId: 'chat', actingUserId: OWNER, fireKey: 'owner:1' }
  first.submit(first.tracker.deliver(message))
  const next = home.life()
  const retry = next.tracker.deliver({ ...message, recoveryWithoutReply: true })
  const other = next.tracker.deliver({ content: 'new question', chatId: 'second', actingUserId: OWNER })
  const batch = retry + '\n' + other
  const shown = home.runPromptHook(next.sessionId, batch)
  assert.match(shown?.hookSpecificOutput?.additionalContext ?? '', /summarize the document/)
  next.submit(batch)
  assert.equal(next.outcomes.at(-1), 'ambiguous')
  assert.equal(home.life().tracker.canRecover(message.fireKey), true)
})

test('the hook releases an unanswered retry once and keeps fresh work beside a cancelled retry', t => {
  const home = agentHome(t)
  home.clock.now = Date.now()
  const first = home.life()
  const message = { content: 'summarize the document', chatId: 'chat', actingUserId: OWNER, fireKey: 'owner:1' }
  first.submit(first.tracker.deliver(message))
  const next = home.life()
  const card = next.tracker.deliver({ ...message, recoveryWithoutReply: true })
  assert.doesNotMatch(card, /summarize the document/)
  const opened = home.runPromptHook(next.sessionId, card)
  assert.match(opened?.hookSpecificOutput?.additionalContext ?? '', /summarize the document/)
  next.submit(card)
  assert.equal(next.call(), OWNER)
  assert.equal(home.runPromptHook(next.sessionId, card), null)
  next.tracker.noteHandled('reply:1')
  const fresh = next.tracker.deliver({ ...message, content: 'fresh question', fireKey: 'owner:2' })
  assert.equal(home.runPromptHook(next.sessionId, card + '\n' + fresh), null)
  assert.equal(home.life().tracker.canRecover(message.fireKey), false)
})

test('a reply recorded between hook release and admission prevents a second answer', t => {
  const home = agentHome(t)
  home.clock.now = Date.now()
  const message = { content: 'continue', chatId: 'first', actingUserId: OWNER, fireKey: 'owner:1' }
  const first = home.life()
  first.submit(first.tracker.deliver(message))
  const next = home.life()
  const card = next.tracker.deliver({ ...message, recoveryWithoutReply: true })
  assert.ok(home.runPromptHook(next.sessionId, card)?.hookSpecificOutput)
  next.tracker.noteHandled('reply:1')
  next.submitWithoutRelease(card)
  assert.equal(next.outcomes.at(-1), 'cancelled-retry')
  assert.equal(next.call(), null)
})

for (const skipped of [false, true]) {
  test(`an unreleased retry stays available after restart (hook skipped: ${skipped})`, t => {
    const home = agentHome(t)
    home.clock.now = Date.now()
    const message = { content: 'first question', chatId: 'first', actingUserId: OWNER, fireKey: 'owner:1' }
    const first = home.life()
    first.submit(first.tracker.deliver(message))
    const retry = home.life()
    const card = retry.tracker.deliver({ ...message, recoveryWithoutReply: true })
    if (skipped) {
      home.runUnservedHook(retry.sessionId, card)
    }
    if (skipped) retry.tracker.begin({ prompt: card, sessionId: retry.sessionId })
    else {
      retry.submitWithoutRelease(card)
      assert.equal(retry.call(), null)
    }
    assert.equal(home.life().tracker.canRecover(message.fireKey), true)
  })
}

test('the forwarder leaves an unreleased retry for the hook that shows its words', t => {
  const home = agentHome(t)
  home.clock.now = Date.now()
  const first = home.life()
  const request = { content: 'summarize the document', chatId: 'first', actingUserId: OWNER, fireKey: 'owner:1' }
  first.submit(first.tracker.deliver(request))
  const next = home.life()
  const card = next.tracker.deliver({ ...request, recoveryWithoutReply: true })
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: next.sessionId, prompt: card }
  const env = { ...process.env, BGOS_PLUGIN_STATE_DIR: dirname(dirname(home.firesPath)) }
  const forwarder = fileURLToPath(new URL('../bin/hoai-hook.mjs', import.meta.url))
  const early = spawnSync(process.execPath, [forwarder], { env, encoding: 'utf8', windowsHide: true, input: JSON.stringify(payload) })
  assert.equal(early.status, 0, early.stderr)
  const spool = spoolPath(next.sessionId, env)
  assert.equal(existsSync(spool), false)
  assert.match(home.runPromptHook(next.sessionId, card)?.hookSpecificOutput.additionalContext, /summarize the document/)
  const lines = readFileSync(spool, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  next.submitWithoutRelease(JSON.parse(lines[0]!).payload.prompt)
  assert.equal(next.call(), OWNER)
})

test('an unreleased retry with an attempt record but no shown record cannot open', t => {
  const home = agentHome(t)
  home.clock.now = Date.now()
  const first = home.life()
  const request = { content: 'first question', chatId: 'first', actingUserId: OWNER, fireKey: 'owner:1' }
  first.submit(first.tracker.deliver(request))
  const retry = home.life()
  const card = retry.tracker.deliver({ ...request, recoveryWithoutReply: true })
  assert.ok(home.runPromptHook(retry.sessionId, card)?.hookSpecificOutput)
  const dir = join(dirname(home.firesPath), 'interrupted-turns')
  fs.unlinkSync(join(dir, fs.readdirSync(dir).find(name => name.endsWith('.shown'))!))
  retry.submitWithoutRelease(card)
  assert.equal(retry.outcomes.at(-1), 'cancelled-retry')
  assert.equal(retry.call(), null)
})

test('retry admission requires its saved offer from this boot', t => {
  const home = agentHome(t)
  const message = { content: 'continue', chatId: 'first', actingUserId: OWNER, fireKey: 'owner:1' }
  const first = home.life()
  first.submit(first.tracker.deliver(message))
  const next = home.life()
  const card = next.tracker.deliver({ ...message, recoveryWithoutReply: true })
  const dir = join(dirname(home.firesPath), 'interrupted-turns')
  const offers = fs.readdirSync(dir).filter(name => name.endsWith('.claimed'))
  assert.equal(offers.length, 1)
  fs.unlinkSync(join(dir, offers[0]!))
  next.submit(card)
  assert.equal(next.outcomes.at(-1), 'cancelled-retry')
  assert.equal(next.call(), null)
  assert.equal(home.life().tracker.canRecover(message.fireKey), true)
})

test('a locked open record lets the reply finish, logs once and stays closed on restart', t => {
  const home = agentHome(t)
  const first = home.life()
  const key = 'owner:1'
  first.submit(first.tracker.deliver({ content: 'continue', chatId: 'first', actingUserId: OWNER, fireKey: key }))
  assert.equal(first.call(), OWNER)
  const unlink = fs.unlinkSync
  const fault = t.mock.method(fs, 'unlinkSync', (path: Parameters<typeof unlink>[0]) => {
    if (String(path).endsWith('.open')) throw Object.assign(new Error('file is busy'), { code: 'EPERM' })
    unlink(path)
  })
  syncBuiltinESMExports()
  try {
    assert.doesNotThrow(() => first.act('reply'))
    assert.doesNotThrow(() => first.act('reply'))
    assert.equal(home.life().tracker.canRecover(key), false)
    assert.deepEqual(home.logs, ['Could not remove the completed message record.'])
  } finally {
    fault.mock.restore()
    syncBuiltinESMExports()
  }
})

test('a failed tool marker logs once, allows the tool and keeps the attempt spent', (t) => {
  const home = agentHome(t)
  const key = 'owner:1'
  const message = { content: 'continue', actingUserId: OWNER, chatId: 'first', fireKey: key }
  const first = home.life()
  first.submit(first.tracker.deliver(message))
  const next = home.life()
  const card = next.tracker.deliver({ ...message, recoveryWithoutReply: true })
  next.submit(card)
  assert.equal(next.call(), OWNER)
  const write = fs.writeFileSync
  const fault = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof write>) => {
    if (String(args[0]).includes('.tool')) throw new Error('fixture write failure')
    return write(...args)
  })
  syncBuiltinESMExports()
  try {
    assert.doesNotThrow(() => next.tracker.noteRetryTool(next.sessionId))
    assert.doesNotThrow(() => next.act('read'))
  } finally {
    fault.mock.restore()
    syncBuiltinESMExports()
  }
  assert.deepEqual(home.logs, ['Could not save the tool record for the interrupted message.'])
  home.transcripts.set(next.sessionId, [
    { type: 'user', message: { content: card } },
    { type: 'assistant', isApiErrorMessage: true, apiError: 'usage_limit_reached' },
  ].map(row => JSON.stringify(row)).join('\n'))
  assert.equal(home.life().tracker.canRecover(key), false)
})

for (const work of ['none', 'tool record', 'tool hook', 'other prompt', 'other error', 'tool after task notification', 'tool in a later chat']) {
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
    const later: unknown[] = []
    if (work === 'tool after task notification' || work === 'tool in a later chat') {
      const another = limited.tracker.deliver({ content: 'next', actingUserId: OWNER, chatId: 'other' })
      later.push({ type: 'user', message: { content: work === 'tool in a later chat'
        ? `<channel message_id="2">\n${another}</channel>` : '<task-notification>background task finished</task-notification>' } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'read' }] } })
    }
    home.transcripts.set(limited.sessionId, [...rows, ...later].map(row => JSON.stringify(row)).join('\n'))
    limited.stop()
    const next = home.life()
    const mayRetry = work === 'none' || work === 'tool in a later chat'
    assert.equal(next.tracker.canRecover(key), mayRetry)
    if (!mayRetry) return
    const retry = next.tracker.deliver({ ...message, recoveryWithoutReply: true })
    const concurrent = home.life()
    assert.equal(concurrent.tracker.canRecover(key), true, 'an unadmitted offer can survive another boot')
    const competingOffer = concurrent.tracker.deliver({ ...message, recoveryWithoutReply: true })
    next.submit(retry)
    assert.equal(next.call(), OWNER)
    concurrent.submit(competingOffer)
    assert.equal(concurrent.call(), null, 'only one admission spends the same refusal')
    next.act('reply')
    next.tracker.noteHandled(`reply:${home.clock.now}`)
    next.stop()
    assert.equal(home.life().tracker.canRecover(key), false)
  })
}

test('only successful changes close the delivery tagged when the tool started', t => {
  const home = agentHome(t)
  const first = home.life()
  const message = { content: 'continue', chatId: 'first', actingUserId: OWNER, fireKey: 'owner:1' }
  first.submit(first.tracker.deliver(message))
  const failed = first.dispatch('email_send')
  failed?.({ isError: true })
  assert.equal(home.life().tracker.canRecover(message.fireKey), true)
  const sent = first.dispatch('email_send')
  first.stop()
  const other = { ...message, fireKey: 'owner:2' }
  first.submit(first.tracker.deliver(other))
  sent?.({})
  assert.equal(home.life().tracker.canRecover(other.fireKey), true)
})

for (const action of ['email_send', 'email_draft', 'artifact_create', 'artifact_update', 'boards_insert',
  'vault_request_login', 'schedule', 'show_component']) {
  test(`a confirmed ${action} closes its message before Stop`, t => {
    const home = agentHome(t)
    const first = home.life()
    const key = 'owner:1'
    first.submit(first.tracker.deliver({ content: 'continue', chatId: 'first', actingUserId: OWNER, fireKey: key }))
    first.act(action)
    assert.equal(home.life().tracker.canRecover(key), false)
  })
}

test('a confirmed action after revocation keeps a refused recovery spent', t => {
  const home = agentHome(t)
  const first = home.life()
  const message = { content: 'continue', chatId: 'first', actingUserId: OWNER, fireKey: 'owner:1' }
  first.submit(first.tracker.deliver(message))
  const retry = home.life()
  const card = retry.tracker.deliver({ ...message, recoveryWithoutReply: true })
  retry.submit(card)
  retry.tracker.noteUntracked({ chatId: 'second' })
  retry.act('send_to_peer')
  home.transcripts.set(retry.sessionId, [
    { type: 'user', message: { content: card } },
    { type: 'assistant', isApiErrorMessage: true, apiError: 'usage_limit_reached' },
  ].map(row => JSON.stringify(row)).join('\n'))
  assert.equal(home.life().tracker.canRecover(message.fireKey), false)
})

for (const sender of ['owner', 'peer']) {
  test(`a reply for a later ${sender} prompt keeps the refused request open`, t => {
    const home = agentHome(t)
    const first = home.life()
    const request = { content: 'first question', chatId: 'first', actingUserId: OWNER, fireKey: 'owner:1' }
    first.submit(first.tracker.deliver(request))
    assert.equal(first.call(), OWNER)
    const refused = JSON.stringify({ type: 'assistant', isApiErrorMessage: true, apiError: 'usage_limit_reached' })
    home.transcripts.set(first.sessionId, refused)
    const other = sender === 'owner'
      ? { content: 'next question', chatId: 'second', actingUserId: OWNER, fireKey: 'owner:2' }
      : { content: 'peer question', chatId: 'first', peerSourceAssistantId: 'peer' }
    first.submit(first.tracker.deliver(other))
    first.act(sender === 'owner' ? 'reply' : 'send_to_peer', other.chatId)
    home.transcripts.set(first.sessionId, [refused, refused].join('\n'))
    const next = home.life()
    assert.equal(next.tracker.canRecover('owner:2'), false)
    assert.equal(next.tracker.canRecover(request.fireKey), true)
    next.submit(next.tracker.deliver({ ...request, recoveryWithoutReply: true }))
    assert.equal(next.call(), OWNER)
    next.act('reply')
    assert.equal(home.life().tracker.canRecover(request.fireKey), false)
  })
}

const limitRecord = JSON.stringify({ type: 'assistant', isApiErrorMessage: true, apiError: 'usage_limit_reached' })

for (const limited of [false, true]) {
  test(`a peer send for an earlier request and a later reply each count once after Stop (refused first: ${limited})`, t => {
    const home = agentHome(t)
    home.clock.now = Date.now()
    const first = home.life()
    const one = { content: 'ask the peer', chatId: 'first', actingUserId: OWNER, fireKey: 'owner:1' }
    const two = { ...one, content: 'second question', chatId: 'second', fireKey: 'owner:2' }
    const answers = [0, 0]
    const submit = (message: typeof one) => {
      const card = first.tracker.deliver(message)
      first.submit(card)
      return JSON.stringify({ type: 'user', message: { content: `<channel message_id="${message.fireKey.slice(6)}">${card}</channel>` } })
    }
    const tail = [submit(one)]
    if (limited) tail.push(limitRecord)
    tail.push(submit(two))
    first.act('send_to_peer')
    answers[0]++
    first.act('reply', two.chatId)
    first.tracker.noteHandled('reply:2')
    answers[1]++
    home.transcripts.set(first.sessionId, tail.join('\n'))
    first.stop()
    for (let boot = 0; boot < 2; boot++) {
      const resumed = home.life()
      for (const [index, request] of [one, two].entries()) {
        if (!resumed.tracker.canRecover(request.fireKey)) continue
        const card = resumed.tracker.deliver({ ...request, recoveryWithoutReply: true })
        assert.ok(home.runPromptHook(resumed.sessionId, card)?.hookSpecificOutput.additionalContext.includes(request.content))
        resumed.submit(card)
        assert.equal(resumed.call(), OWNER)
        resumed.act('reply')
        answers[index]++
      }
    }
    assert.deepEqual(answers, [1, 1])
  })
}

test('the end of a later prompt leaves a refused message available', t => {
  const home = agentHome(t)
  const first = home.life()
  const message = { content: 'first question', chatId: 'first', actingUserId: OWNER, fireKey: 'owner:1' }
  const card = first.tracker.deliver(message)
  first.submit(card)
  home.transcripts.set(first.sessionId, [JSON.stringify({ type: 'user', message: { content: card } }), limitRecord].join('\n'))
  first.submit(first.tracker.deliver({ ...message, content: 'next question', chatId: 'second', fireKey: 'owner:2' }))
  first.stop()
  const boot = home.life()
  assert.equal(boot.tracker.canRecover(message.fireKey), true)
  assert.equal(boot.tracker.canRecover('owner:2'), false)
})

test('a tool in the next prompt cannot spend the earlier refused retry', t => {
  const home = agentHome(t)
  const first = home.life()
  const message = { content: 'first question', chatId: 'chat', actingUserId: OWNER, fireKey: 'owner:1' }
  first.submit(first.tracker.deliver(message))
  const next = home.life()
  const retry = next.tracker.deliver({ ...message, recoveryWithoutReply: true })
  next.submit(retry)
  next.submit(next.tracker.deliver({ ...message, content: 'second question', fireKey: 'owner:2' }))
  next.tracker.noteRetryTool(next.sessionId)
  next.act('reply')
  home.transcripts.set(next.sessionId, [
    { type: 'user', message: { content: retry } },
    { type: 'assistant', isApiErrorMessage: true, apiError: 'usage_limit_reached' },
  ].map(row => JSON.stringify(row)).join('\n'))
  assert.equal(home.life().tracker.canRecover(message.fireKey), true)
})

test('a parentless reply to another chat leaves the live request open', t => {
  const home = agentHome(t)
  const first = home.life()
  const request = { content: 'first question', chatId: 'first', actingUserId: OWNER, fireKey: 'owner:1' }
  first.submit(first.tracker.deliver(request))
  first.submit(first.tracker.deliver({ ...request, content: 'next question', chatId: 'second', fireKey: 'owner:2' }))
  const complete = first.tracker.outboundCompletion('reply', home.paths)
  complete?.({}, 'first')
  assert.equal(home.life().tracker.canRecover('owner:2'), true)
  complete?.({}, 'second')
  assert.equal(home.life().tracker.canRecover('owner:2'), false)
})

test('an explicit reply to an earlier request leaves the current question open', t => {
  const home = agentHome(t)
  const first = home.life()
  const message = { content: 'question', chatId: 'chat', actingUserId: OWNER, fireKey: 'owner:1' }
  first.submit(first.tracker.deliver(message))
  first.submit(first.tracker.deliver({ ...message, fireKey: 'owner:2' }))
  first.tracker.outboundCompletion('reply', home.paths, 1)?.({})
  first.tracker.noteHandled('reply:1')
  const next = home.life()
  assert.equal(next.tracker.canRecover(message.fireKey), false)
  assert.equal(next.tracker.canRecover('owner:2'), true)
})

for (const read of ['boards_download', 'vault_fill_prepare', 'unlisted_tool', 'set_status', 'set_goal_working', 'set_goal_waiting']) {
  test(`a request interrupted after ${read} receives one answer on restart`, t => {
    const home = agentHome(t)
    const first = home.life()
    const message = { content: 'summarize the document', chatId: 'chat', actingUserId: OWNER, fireKey: 'owner:1' }
    first.submit(first.tracker.deliver(message))
    first.act(read)
    home.transcripts.set(first.sessionId, JSON.stringify({ type: 'assistant', isApiErrorMessage: true, apiError: 'usage_limit_reached' }))

    const next = home.life()
    assert.equal(next.tracker.canRecover(message.fireKey), true)
    next.submit(next.tracker.deliver({ ...message, recoveryWithoutReply: true }))
    assert.equal(next.call(), OWNER)
    next.act('reply')
    assert.equal(home.life().tracker.canRecover(message.fireKey), false)
  })
}

type RestartRequest = { content: string; chatId: string; actingUserId: string; fireKey: string }

function answerAfterRestart(home: ReturnType<typeof agentHome>, requests: RestartRequest[], answers: number[]) {
  for (let boot = 0; boot < 2; boot++) {
    const next = home.life()
    for (const [index, request] of requests.entries()) {
      if (!next.tracker.canRecover(request.fireKey)) continue
      next.submit(next.tracker.deliver({ ...request, recoveryWithoutReply: true }))
      assert.equal(next.call(), OWNER)
      next.act('reply', request.chatId)
      next.tracker.noteHandled(`reply:${request.fireKey.slice(6)}`)
      answers[index]++
    }
  }
}

for (const tool of ['create_mission', 'set_mission_goals', 'add_mission_goals', 'tick_mini_goal']) {
  test(`planning with ${tool} before a usage refusal leaves exactly one answer due`, t => {
    const home = agentHome(t)
    const request = { content: 'prepare the report', chatId: 'chat', actingUserId: OWNER, fireKey: 'owner:1' }
    const first = home.life()
    const card = first.tracker.deliver(request)
    first.submit(card)
    first.act(tool)
    home.transcripts.set(first.sessionId, [JSON.stringify({ type: 'user', message: { content: card } }), limitRecord].join('\n'))
    const answers = [0]
    answerAfterRestart(home, [request], answers)
    assert.deepEqual(answers, [1])
  })
}

test('a Stop after a progress update and a refusal leaves one answer due', t => {
  const home = agentHome(t)
  const request = { content: 'finish the document', chatId: 'first', actingUserId: OWNER, fireKey: 'owner:1' }
  const first = home.life()
  const card = first.tracker.deliver(request)
  first.submit(card)
  first.act('set_status')
  home.transcripts.set(first.sessionId, [
    { type: 'user', message: { content: card } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'progress', name: 'mcp__bgos__set_status' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'progress', content: 'saved' }] } },
  ].map(row => JSON.stringify(row)).concat(limitRecord).join('\n'))
  first.stop()
  let answers = 0
  for (let boot = 0; boot < 2; boot++) {
    const next = home.life()
    if (!next.tracker.canRecover(request.fireKey)) continue
    next.submit(next.tracker.deliver({ ...request, recoveryWithoutReply: true }))
    assert.equal(next.call(), OWNER)
    next.act('reply', request.chatId)
    answers++
  }
  assert.equal(answers, 1)
})

test('plain reads leave their request open', t => {
  const home = agentHome(t)
  const first = home.life()
  const key = 'owner:1'
  first.submit(first.tracker.deliver({ content: 'continue', chatId: 'first', actingUserId: OWNER, fireKey: key }))
  for (const read of ['artifact_list', 'artifact_read', 'artifact_versions', 'boards_query', 'boards_get_row', 'vault_items',
    'list_schedules', 'list_peers', 'list_chats', 'peer_status', 'list_health_events', 'bgos_capabilities']) {
    first.act(read)
    assert.equal(home.life().tracker.canRecover(key), true, read)
  }
})

test('a reaction acknowledges the request and leaves its answer due', t => {
  const home = agentHome(t)
  const message = { content: 'continue', chatId: 'first', actingUserId: OWNER, fireKey: 'owner:1' }
  const first = home.life()
  first.submit(first.tracker.deliver(message))
  assert.equal(first.call(), OWNER)
  first.act('react')
  const next = home.life()
  assert.equal(next.tracker.canRecover(message.fireKey), true)
  next.submit(next.tracker.deliver({ ...message, recoveryWithoutReply: true }))
  assert.equal(next.call(), OWNER)
  next.act('reply')
  assert.equal(home.life().tracker.canRecover(message.fireKey), false)
})

for (const action of ['call_owner', 'reply', 'meeting_reply', 'edit_message', 'ask_user_input', 'stop', 'restart yourself']) {
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
