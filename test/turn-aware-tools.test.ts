/**
 * call_owner, the mission tools and list_chats are TURN AWARE, not turn gated
 * (shared agents Phase 0, items 0.3, 0.4, 0.7, as the delegated review of the
 * branch found).
 *
 * WHY NOT GATED. The owner's own work runs on turns no delivery opened: the
 * native goal lane types `/goal` into the composer and runs every
 * continuation after a Stop has ended the private turn, the mission_started
 * and mission_resumed cards and a button tap reach the session with no
 * delivery token, and a peer agent's message has no person behind it. Gated
 * like boards, a Keep working mission could never tick or complete a goal.
 *
 * WHAT THESE TESTS HOLD (lib/private-turn.mjs turnAwarePrivateTurn, and the
 * admission gate in server.ts that uses it):
 *   - a verified turn is used exactly as requirePrivateTurn answers it: the
 *     owner's with no headers, a share recipient's naming them;
 *   - no verified turn, and the chat the session is working in is known to be
 *     a share recipient's: refused, never done as the owner;
 *   - otherwise the owner, with no headers, as every such call was before;
 *   - boards and schedule stay gated exactly as on main.
 *
 * Run with: npx tsx --test test/turn-aware-tools.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as privateTurn from '../lib/private-turn.mjs'

const OWNER = 'user_owner'
const RECIPIENT = 'user_recipient'
const TURN_AWARE = ['call_owner', 'list_chats', 'create_mission', 'tick_mini_goal', 'set_mission_goals', 'add_mission_goals', 'cancel_mission_goal', 'complete_mission']
const source = readFileSync('server.ts', 'utf8')
const admissionStart = source.indexOf('  // Freeze private authority at request admission')
const admissionSource = source.slice(admissionStart, source.indexOf('  return trackMessageOperation(async () => {', admissionStart))

function execute(body: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings))
}

const turnAware = (input: Record<string, unknown>) => {
  const fn = (privateTurn as any).turnAwarePrivateTurn
  assert.equal(typeof fn, 'function', 'lib/private-turn.mjs exports turnAwarePrivateTurn')
  return fn(input)
}
const tracker = (turn: unknown) => ({ current: () => turn })
const others = new Set(['20'])
const isOthers = (chatId: string) => others.has(chatId)

test('a verified turn is used as requirePrivateTurn answers it', () => {
  const recipientTurn = { actingUserId: RECIPIENT, chatId: '20', turnId: 't' }
  const got = turnAware({ tracker: tracker(recipientTurn), markerPaths: [], ownerUserId: OWNER, turnChatId: '20', othersChat: isOthers })
  assert.equal(got.actingUserId, RECIPIENT)
  assert.equal(got.chatId, '20')
  assert.deepEqual(got.headers, { 'X-BGOS-Acting-User': RECIPIENT })
  const owner = turnAware({ tracker: tracker({ actingUserId: OWNER, chatId: '10', turnId: 't' }), markerPaths: [], ownerUserId: OWNER, turnChatId: '10', othersChat: isOthers })
  assert.deepEqual([owner.actingUserId, owner.headers], [OWNER, {}])
})

test('no verified turn in a share recipient chat is refused, never done as the owner', () => {
  const refusal = (privateTurn as any).TURN_AWARE_REFUSAL
  assert.match(String(refusal), /did not start/)
  assert.throws(() => turnAware({ tracker: tracker(null), markerPaths: [], ownerUserId: OWNER, turnChatId: '20', othersChat: isOthers }), (err: unknown) => err instanceof Error && err.message === refusal)
})

test('no verified turn anywhere else (the goal lane, a mission card, a tap, a peer) is the owner, as before', () => {
  for (const turnChatId of ['10', null, undefined, '', 'a2a-55']) {
    const got = turnAware({ tracker: tracker(null), markerPaths: [], ownerUserId: OWNER, turnChatId, othersChat: isOthers })
    assert.deepEqual({ actingUserId: got.actingUserId, chatId: got.chatId, headers: got.headers }, { actingUserId: OWNER, chatId: null, headers: {} }, String(turnChatId))
  }
})

function admit(name: string, opts: { turn: unknown; turnChatId?: string | null; lockHeld?: boolean }) {
  let strictCalls = 0
  const result = execute(admissionSource + '\nreturn privateCall;', {
    req: { params: { name } }, lockHeld: opts.lockHeld ?? true, privateTurns: tracker(opts.turn), PRIVATE_MARKER_PATHS: [],
    PRIVATE_HOOK: { registered: true }, PRIVATE_HOOK_MISSING_REFUSAL: 'hook missing', USER_ID: OWNER, log: () => {},
    requirePrivateTurn: (...args: any[]) => { strictCalls++; return (privateTurn as any).requirePrivateTurn(...args) },
    turnAwarePrivateTurn: (privateTurn as any).turnAwarePrivateTurn,
    turnChat: { current: () => (opts.turnChatId == null ? null : { chatId: opts.turnChatId }) },
    chatOwnership: { isOthers },
    recordPeerRefusal: () => ({ line: '' }), pathDirname: () => '/s', CURSOR_FILE_PATH: '/s/c', ASSISTANT_ID: 900,
  })
  return { result, strictCalls }
}

test('the admission gate: a turn aware tool on an unverified owner turn runs as the owner, with no headers', async () => {
  for (const name of TURN_AWARE) {
    const { result } = admit(name, { turn: null, turnChatId: '10' })
    const call = await result
    assert.notEqual(call?.isError, true, `${name}: ${JSON.stringify(call)}`)
    assert.deepEqual([call.actingUserId, call.headers], [OWNER, {}], name)
    // A passive daemon (no lock) answers as before too: the owner.
    const passive = await admit(name, { turn: null, turnChatId: null, lockHeld: false }).result
    assert.deepEqual([passive.actingUserId, passive.headers], [OWNER, {}], `${name} passive`)
  }
})

test('the admission gate: a turn aware tool on an unverified turn in a recipient chat is refused', async () => {
  for (const name of TURN_AWARE) {
    const refused = await admit(name, { turn: null, turnChatId: '20' }).result
    assert.equal(refused?.isError, true, name)
    assert.equal(refused.content[0].text, (privateTurn as any).TURN_AWARE_REFUSAL, name)
  }
})

test('the admission gate: a verified recipient turn names them for every turn aware tool', async () => {
  for (const name of TURN_AWARE) {
    const call = await admit(name, { turn: { actingUserId: RECIPIENT, chatId: '20', turnId: 't' }, turnChatId: '20' }).result
    assert.deepEqual([call.actingUserId, call.chatId, call.headers], [RECIPIENT, '20', { 'X-BGOS-Acting-User': RECIPIENT }], name)
  }
})

test('boards and schedule stay gated exactly as on main', async () => {
  for (const name of ['schedule', 'list_schedules', 'cancel_schedule', 'boards_list']) {
    const { result, strictCalls } = admit(name, { turn: null, turnChatId: '10' })
    const refused = await result
    assert.equal(strictCalls, 1, name)
    assert.equal(refused?.isError, true, `${name}: an unverified turn is refused, wherever it is`)
  }
  assert.match(admissionSource, /if \(req\.params\.name\.startsWith\('boards_'\) \|\| \['schedule', 'list_schedules', 'cancel_schedule'\]\.includes\(req\.params\.name\)\) \{/, 'the strict list is main\'s, unchanged')
})
