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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as privateTurnModule from '../lib/private-turn.mjs'
import { createPrivateTurnTracker, privateMarkerPath, privateRevokeLine, requirePrivateTurn, voiceConsultActor } from '../lib/private-turn.mjs'
import { floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import { recordPrivateBoundary } from '../bin/hoai-private-turn-hook.mjs'

// Read through the module so this file loads on a head without the ledger (#227 alone): there the tests fail on the
// behaviour they pin, not on an import.
const createFireLedger: (options: { path: string, now?: () => number }) => any = (privateTurnModule as any).createFireLedger ?? (() => null)
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
  let session = 0
  function life() {
    const replays: string[] = []
    const revokes: string[] = []
    const outcomes: string[] = []
    const tracker = createPrivateTurnTracker({
      now: () => clock.now,
      fires: createFireLedger({ path: firesPath, now: () => clock.now }),
      onReplay: (replay) => replays.push(privateReplayLine(replay)),
      onRevoke: (info) => revokes.push(privateRevokeLine(info)),
    } as any)
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
    return { tracker, submit, consult, wake, call, stop, replays, revokes, outcomes }
  }
  const ledgerKeys = () => Object.keys((JSON.parse(readFileSync(firesPath, 'utf8')) as any).fires)
  return { life, clock, ledgerKeys }
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
