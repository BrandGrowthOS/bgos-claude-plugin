/**
 * call_owner, the mission tools and list_chats are TURN AWARE, not turn gated
 * (shared agents Phase 0, items 0.3, 0.4, 0.7, as the delegated review of the
 * branch found, in two rounds).
 *
 * WHY NOT GATED. The owner's own work runs on turns no delivery opened: the
 * native goal lane types `/goal` into the composer and runs every
 * continuation after a Stop has ended the private turn, the mission_started
 * and mission_resumed cards and a button tap reach the session with no
 * delivery token, and a peer agent's message has no person behind it. Gated
 * like boards, a Keep working mission could never tick or complete a goal.
 *
 * WHY THE TRACKER AND NOT THE CHAT. The first fix refused when the turn's
 * chat was a recipient's. A typed `/goal` and a mission card inherit the chat
 * of whatever was delivered last, so a goal run could be refused for good,
 * and a recipient's message injected into a running owner turn left the
 * owner's chat in place and ran as the owner. The private turn tracker knows
 * both facts directly: who the delivery the prompt carried named, and which
 * people's deliveries reached the turn since it began.
 *
 * WHAT THESE TESTS HOLD (lib/private-turn.mjs turnAwarePrivateTurn and the
 * tracker's turnSenders, with the real tracker; and the admission gate in
 * server.ts that uses them):
 *   - a verified turn is used as requirePrivateTurn answers it;
 *   - no verified turn, and the prompt's delivery named someone other than the
 *     owner, or another person's delivery reached the turn: refused;
 *   - otherwise the owner, with no headers, as every such call was on main;
 *   - boards and schedule stay gated exactly as on main.
 *
 * Run with: npx tsx --test test/turn-aware-tools.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import * as privateTurn from '../lib/private-turn.mjs'
import { floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import { recordPrivateBoundary } from '../bin/hoai-private-turn-hook.mjs'

const OWNER = 'user_owner'
const RECIPIENT = 'user_recipient'
const TURN_AWARE = ['call_owner', 'list_chats', 'create_mission', 'tick_mini_goal', 'set_mission_goals', 'add_mission_goals', 'cancel_mission_goal', 'set_goal_waiting', 'complete_mission']
const source = readFileSync('server.ts', 'utf8')
const admissionStart = source.indexOf('  // Freeze private authority at request admission')
const admissionSource = source.slice(admissionStart, source.indexOf('  return trackMessageOperation(async () => {', admissionStart))
const { TURN_AWARE_REFUSAL, turnAwarePrivateTurn } = privateTurn as any

function execute(body: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings))
}

/** The real tracker and the real private turn hook, on a temp state folder. */
function session(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'hoai-turn-aware-'))
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()))); rmSync(root, { recursive: true, force: true }) })
  const cwd = join(root, 'agent')
  mkdirSync(cwd)
  const env = { ...process.env, BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: cwd }
  markFloorAttached({ root, folders: [cwd] })
  const markerPaths = [privateTurn.privateMarkerPath(root, floorKey(cwd))]
  const tracker = privateTurn.createPrivateTurnTracker()
  let n = 0
  /** A delivery, as a lane hands it over: the card text the session will see. */
  const deliver = (actingUserId: string | null, chatId: string, peer = false) =>
    tracker.deliver({ content: `message ${++n}`, actingUserId, chatId, peerSourceAssistantId: peer ? 947 : null })
  /** A prompt submitted in the session: a delivered card, or something typed (the goal lane's `/goal`). */
  const prompt = (text: string, { record = true } = {}) => {
    if (record) recordPrivateBoundary({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd, prompt: text }, env)
    tracker.begin({ prompt: text, sessionId: 's' })
  }
  // The CLI's Stop: the private turn hook closes the marker, then the daemon drains the Stop line.
  const stop = () => { recordPrivateBoundary({ hook_event_name: 'Stop', session_id: 's', cwd }, env); tracker.end() }
  const call = () => {
    try { return turnAwarePrivateTurn({ tracker, markerPaths, ownerUserId: OWNER }) } catch (err) { return { refused: (err as Error).message } }
  }
  return { deliver, prompt, stop, call, tracker, markerPaths }
}

test('a verified turn is used as requirePrivateTurn answers it', (t) => {
  const s = session(t)
  s.prompt(s.deliver(RECIPIENT, '20'))
  assert.deepEqual([s.call().actingUserId, s.call().chatId, s.call().headers], [RECIPIENT, '20', { 'X-BGOS-Acting-User': RECIPIENT }])
  s.stop()
  s.prompt(s.deliver(OWNER, '10'))
  assert.deepEqual([s.call().actingUserId, s.call().headers], [OWNER, {}])
})

test('the goal lane: a typed /goal and its continuations run as the owner, whoever spoke last', (t) => {
  const s = session(t)
  // A recipient spoke last before the owner switched Keep working on.
  s.prompt(s.deliver(RECIPIENT, '20'))
  s.stop()
  s.prompt('/goal ship the landing page')
  assert.deepEqual([s.call().actingUserId, s.call().headers], [OWNER, {}], 'the typed /goal')
  s.stop()
  // A continuation after a Stop: no prompt at all.
  assert.deepEqual([s.call().actingUserId, s.call().headers], [OWNER, {}], 'a continuation')
  // A mission card pushed with no delivery token, then its prompt.
  s.prompt('[mission_resumed] Keep working on mission 77')
  assert.deepEqual([s.call().actingUserId, s.call().headers], [OWNER, {}], 'a mission card')
})

test('a recipient prompt that could not be verified is refused, never done as the owner', (t) => {
  const s = session(t)
  // Their delivery's prompt began, but no marker was written for it (a hook that did not run).
  s.prompt(s.deliver(RECIPIENT, '20'), { record: false })
  assert.equal(s.call().refused, TURN_AWARE_REFUSAL)
  assert.match(String(TURN_AWARE_REFUSAL), /did not start/)
})

test('a recipient message that reaches a running owner turn is refused until the next prompt', (t) => {
  const s = session(t)
  s.prompt(s.deliver(OWNER, '10'))
  assert.equal(s.call().actingUserId, OWNER)
  s.deliver(RECIPIENT, '20')
  assert.equal(s.call().refused, TURN_AWARE_REFUSAL, 'the owner turn was broken into by another person')
  // The recipient's own prompt is theirs, verified.
  s.stop()
  s.prompt(s.deliver(RECIPIENT, '20'))
  assert.equal(s.call().actingUserId, RECIPIENT)
  // And an unverified owner continuation after the Stop is the owner again.
  s.stop()
  assert.deepEqual([s.call().actingUserId, s.call().headers], [OWNER, {}])
})

test('a recipient message during an unverified owner turn (the goal lane) is refused too, until the turn ends', (t) => {
  const s = session(t)
  s.prompt('/goal ship the landing page')
  s.deliver(RECIPIENT, '20')
  assert.equal(s.call().refused, TURN_AWARE_REFUSAL)
  // A prompt with no Stop before it is the same CLI turn (several prompts submitted together, a second hook source,
  // a late forwarder line): the recipient's words are still in it (board row f81a527c).
  s.prompt('/goal ship the landing page, still')
  assert.equal(s.call().refused, TURN_AWARE_REFUSAL, 'a new prompt of the same turn does not clear it')
  s.stop()
  s.prompt('/goal ship the landing page, still')
  assert.equal(s.call().actingUserId, OWNER, 'the next turn, after a Stop, is the owner\'s')
})

test('a peer agent message, mid turn or as its own prompt, is the owner, as on main', (t) => {
  const s = session(t)
  s.prompt(s.deliver(OWNER, '10'))
  s.deliver(null, 'a2a-55', true)
  assert.deepEqual([s.call().actingUserId, s.call().headers], [OWNER, {}], 'mid turn')
  s.stop()
  s.prompt(s.deliver(null, 'a2a-55', true))
  assert.deepEqual([s.call().actingUserId, s.call().headers], [OWNER, {}], 'its own prompt')
})

test('turnSenders names the prompt and the people who reached it; a Stop starts a fresh record', (t) => {
  const s = session(t)
  assert.deepEqual(s.tracker.turnSenders(), { prompt: null, people: [] }, 'before any prompt')
  s.prompt(s.deliver(OWNER, '10'))
  s.deliver(RECIPIENT, '20')
  s.deliver(null, 'a2a-55', true)
  // The prompt's own sender is among the people too: one CLI turn runs from Stop to Stop (board row f81a527c).
  assert.deepEqual(s.tracker.turnSenders(), { prompt: OWNER, people: [OWNER, RECIPIENT] })
  s.stop()
  assert.deepEqual(s.tracker.turnSenders(), { prompt: null, people: [] }, 'after Stop')
})

test('a recipient message after a Stop reaches the goal continuation that runs with no prompt: refused', (t) => {
  const s = session(t)
  s.prompt('/goal ship the landing page')
  s.stop()
  assert.equal(s.call().actingUserId, OWNER, 'the continuation, alone')
  const card = s.deliver(RECIPIENT, '20')
  assert.equal(s.call().refused, TURN_AWARE_REFUSAL, 'it may be injected into the continuation')
  s.prompt(card)
  assert.equal(s.call().actingUserId, RECIPIENT, 'their own prompt is theirs')
})

function admit(name: string, tracker: unknown, lockHeld = true) {
  let strictCalls = 0
  const result = execute(admissionSource + '\nreturn privateCall;', {
    req: { params: { name } }, lockHeld, privateTurns: tracker, PRIVATE_MARKER_PATHS: [],
    PRIVATE_HOOK: { registered: true }, PRIVATE_HOOK_MISSING_REFUSAL: 'hook missing', USER_ID: OWNER, log: () => {},
    requirePrivateTurn: (...args: any[]) => { strictCalls++; return (privateTurn as any).requirePrivateTurn(...args) },
    turnAwarePrivateTurn,
    recordPeerRefusal: () => ({ line: '' }), pathDirname: () => '/s', CURSOR_FILE_PATH: '/s/c', ASSISTANT_ID: 900,
  })
  return { result, strictCalls }
}
const stubTracker = (turn: unknown, senders: unknown) => ({ current: () => turn, turnSenders: () => senders, explain: () => '' })

test('the admission gate, for every turn aware tool: verified, someone else unverified, the owner', async () => {
  for (const name of TURN_AWARE) {
    const verified = await admit(name, stubTracker({ actingUserId: RECIPIENT, chatId: '20', turnId: 't' }, { prompt: RECIPIENT, people: [] })).result
    assert.deepEqual([verified.actingUserId, verified.chatId, verified.headers], [RECIPIENT, '20', { 'X-BGOS-Acting-User': RECIPIENT }], name)
    for (const senders of [{ prompt: RECIPIENT, people: [] }, { prompt: OWNER, people: [RECIPIENT] }, { prompt: null, people: [RECIPIENT] }]) {
      const refused = await admit(name, stubTracker(null, senders)).result
      assert.equal(refused?.isError, true, `${name} ${JSON.stringify(senders)}`)
      assert.equal(refused.content[0].text, TURN_AWARE_REFUSAL, name)
    }
    for (const senders of [null, { prompt: null, people: [] }, { prompt: OWNER, people: [OWNER] }]) {
      const owner = await admit(name, stubTracker(null, senders)).result
      assert.deepEqual([owner.actingUserId, owner.headers], [OWNER, {}], `${name} ${JSON.stringify(senders)}`)
    }
    // A passive daemon (no lock) answers as on main: the owner.
    const passive = await admit(name, stubTracker(null, null), false).result
    assert.deepEqual([passive.actingUserId, passive.headers], [OWNER, {}], `${name} passive`)
  }
})

test('boards and schedule stay gated exactly as on main', async () => {
  for (const name of ['schedule', 'list_schedules', 'cancel_schedule', 'boards_list']) {
    const { result, strictCalls } = admit(name, stubTracker(null, null))
    const refused = await result
    assert.equal(strictCalls, 1, name)
    assert.equal(refused?.isError, true, `${name}: an unverified turn is refused, wherever it is`)
  }
  assert.match(admissionSource, /if \(req\.params\.name\.startsWith\('boards_'\) \|\| \['schedule', 'list_schedules', 'cancel_schedule'\]\.includes\(req\.params\.name\)\) \{/, 'the strict list is main\'s, unchanged')
})

test('a prompt carrying several deliveries at once (queued messages, the boot sweep) counts every sender', (t) => {
  const s = session(t)
  s.prompt(`${s.deliver(OWNER, '10')}\n${s.deliver(RECIPIENT, '20')}`)
  assert.equal(s.call().refused, TURN_AWARE_REFUSAL, 'a recipient delivery rode in with the owner one')
  assert.deepEqual(s.tracker.turnSenders(), { prompt: null, people: [OWNER, RECIPIENT] })
  s.stop()
  s.prompt(`${s.deliver(OWNER, '10')}\n${s.deliver(OWNER, '11')}`)
  assert.deepEqual([s.call().actingUserId, s.call().headers], [OWNER, {}], 'two owner deliveries are the owner')
})
