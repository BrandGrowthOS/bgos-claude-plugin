/**
 * Mission tools act for the verified sender of the turn (shared agents Phase 0,
 * item 0.4; BGOS docs/reports/2026-10-14-shared-agents-review PLAN.md and
 * MATRIX M4.3, M4.5).
 *
 * THE DEFECT. On a share recipient's turn with no chat named, create_mission
 * and the goal tools landed in the OWNER's chat: pickImplicitMissionChat
 * skipped the recipient's DM (its last inbound was not the owner) and fell
 * back to an owner chat, or to null, which the backend reads as the owner's
 * main chat. The row was then the owner's mission, written on the recipient's
 * ask. The mission tools were not private tools either, so no turn was
 * checked and no acting header was sent.
 *
 * WHAT THESE TESTS HOLD.
 *   - the six mission tools are in the helper guard (PRIVATE_TOOL_MATCHER, all
 *     three installs) and in the daemon's admission gate;
 *   - on a recipient's turn the implicit chat is that turn's own chat, never
 *     an owner chat and never null, and a recipient turn that names no chat
 *     is refused rather than sent to the owner's main chat;
 *   - every mission request on a recipient's turn carries the turn's headers,
 *     so the backend can refuse it with one sentence (its half of 0.4);
 *   - on the owner's own turn the chat choice and every request are what they
 *     were: no header is added and the cached read path is unchanged.
 *
 * Run with: npx tsx --test test/mission-private.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { PRIVATE_TOOL_MATCHER, createPrivateTurnTracker } from '../lib/private-turn.mjs'
import { PRIVATE_TOOL_MATCHER as PRESEED_MATCHER } from '../lib/claude-preseed.mjs'
import { markFloorAttached } from '../lib/floor-state.mjs'
import { recordPrivateBoundary } from '../bin/hoai-private-turn-hook.mjs'
import * as missions from '../lib/missions.ts'

const MISSION_TOOLS = ['create_mission', 'tick_mini_goal', 'set_mission_goals', 'add_mission_goals', 'cancel_mission_goal', 'complete_mission']
const OWNER = 'user_owner'
const RECIPIENT = 'user_recipient'
const OWNER_CHAT = '4403'
const RECIPIENT_CHAT = '7788'

const source = readFileSync('server.ts', 'utf8')
const admissionStart = source.indexOf('  // Freeze private authority at request admission')
const admissionSource = source.slice(admissionStart, source.indexOf('  return trackMessageOperation(async () => {', admissionStart))
const missionCases = source.slice(source.indexOf("    case 'create_mission': {"), source.indexOf("    case 'log_health_event': {"))
const missionHelpers = source.slice(source.indexOf('function resolveMissionToolChat('), source.indexOf('function resolveAuthorizedChat('))

function execute(body: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings))
}

test('the six mission tools are private for the helper guard, under any install prefix, in every install', () => {
  const marketplace = JSON.parse(readFileSync('hooks/hooks.json', 'utf8'))
  const guard = marketplace.hooks.PreToolUse.find((entry: any) => entry.hooks.some((h: any) => String(h.args?.[0]).endsWith('hoai-private-turn-hook.mjs')))
  for (const matcher of [PRIVATE_TOOL_MATCHER, PRESEED_MATCHER, guard.matcher]) {
    const re = new RegExp(matcher)
    for (const tool of MISSION_TOOLS) {
      for (const name of [`mcp__bgos__${tool}`, `mcp__plugin_hoai_bgos__${tool}`]) assert.equal(re.test(name), true, `${name} against ${matcher}`)
    }
    assert.equal(re.test('mcp__bgos__reply'), false)
    assert.equal(re.test('mcp__bgos__create_mission_x'), false)
  }
})

test('a helper started in an earlier turn cannot write a mission for the current sender', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hoai-mission-private-'))
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()))); rmSync(root, { recursive: true, force: true }) })
  const cwd = join(root, 'agent')
  mkdirSync(cwd)
  const env = { ...process.env, BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: cwd }
  markFloorAttached({ root, folders: [cwd] })
  const tracker = createPrivateTurnTracker()
  const start = (actor: string, text: string) => {
    const prompt = tracker.deliver({ content: text, actingUserId: actor, chatId: actor === OWNER ? OWNER_CHAT : RECIPIENT_CHAT })
    recordPrivateBoundary({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd, prompt }, env)
    tracker.begin({ prompt, sessionId: 's' })
  }
  const hook = (payload: Record<string, unknown>) => spawnSync(process.execPath, ['bin/hoai-private-turn-hook.mjs'], {
    env, input: JSON.stringify({ session_id: 's', cwd, ...payload }), encoding: 'utf8',
  })
  start(RECIPIENT, 'plan my week as a mission')
  assert.equal(hook({ hook_event_name: 'SubagentStart', agent_id: 'agent-a', agent_type: 'general-purpose' }).status, 0)
  start(OWNER, 'how is the launch going?')
  for (const tool of MISSION_TOOLS) {
    const refused = hook({ hook_event_name: 'PreToolUse', tool_name: `mcp__plugin_hoai_bgos__${tool}`, tool_input: {}, agent_id: 'agent-a', agent_type: 'general-purpose' })
    assert.equal(refused.status, 2, `${tool} from a helper of an earlier turn must be refused`)
  }
})

test('the admission gate freezes the verified turn for every mission tool, and refuses an unverified one', async () => {
  for (const name of MISSION_TOOLS) {
    const bindings = {
      req: { params: { name } }, lockHeld: true, privateTurns: {}, PRIVATE_MARKER_PATHS: [],
      PRIVATE_HOOK: { registered: true }, PRIVATE_HOOK_MISSING_REFUSAL: 'hook missing', USER_ID: OWNER,
    }
    let called = 0
    const refused = await execute(admissionSource + '\nreturn privateCall;', {
      ...bindings, requirePrivateTurn: () => { called++; throw new Error('This private action did not start because its current sender could not be verified.') },
    })
    assert.equal(called, 1, `the gate ran for ${name}`)
    assert.equal(refused?.isError, true, `${name}: an unverified sender writes no mission`)
    const frozen = { actingUserId: RECIPIENT, chatId: RECIPIENT_CHAT, headers: { 'X-BGOS-Acting-User': RECIPIENT } }
    assert.deepEqual(await execute(admissionSource + '\nreturn privateCall;', { ...bindings, requirePrivateTurn: () => frozen }), frozen)
  }
})

// ── the implicit chat rule (lib/missions.ts pickImplicitMissionChat) ─────────

const senders = new Map([[RECIPIENT_CHAT, RECIPIENT], [OWNER_CHAT, OWNER]])
const base = {
  monitoredChatIds: [OWNER_CHAT, RECIPIENT_CHAT],
  ownerUserId: OWNER,
  isRoom: (id: string) => id === '9001',
  lastInboundUserId: (id: string) => senders.get(id) ?? null,
}

test('on a recipient turn the implicit chat is that turn own chat, never an owner chat', () => {
  const recipientTurn = { actingUserId: RECIPIENT, chatId: RECIPIENT_CHAT }
  // The turn chat tracker agrees with the private turn.
  assert.equal(missions.pickImplicitMissionChat({ ...base, turnChatId: RECIPIENT_CHAT, privateTurn: recipientTurn } as any), RECIPIENT_CHAT)
  // It names the owner's chat (another card arrived since): the private turn's own chat still wins.
  assert.equal(missions.pickImplicitMissionChat({ ...base, turnChatId: OWNER_CHAT, privateTurn: recipientTurn } as any), RECIPIENT_CHAT)
  // No turn chat at all: never the first monitored chat, which is the owner's here.
  assert.equal(missions.pickImplicitMissionChat({ ...base, turnChatId: null, privateTurn: recipientTurn } as any), RECIPIENT_CHAT)
  // A recipient turn in a room: the room, which the backend refuses, never a fall back to the owner.
  assert.equal(missions.pickImplicitMissionChat({ ...base, turnChatId: '9001', privateTurn: { actingUserId: RECIPIENT, chatId: '9001' } } as any), '9001')
})

test('a recipient turn that names no chat is refused, never null (null is the owner main chat)', () => {
  for (const chatId of ['', '   ', null, undefined]) {
    assert.throws(
      () => missions.pickImplicitMissionChat({ ...base, turnChatId: OWNER_CHAT, privateTurn: { actingUserId: RECIPIENT, chatId } } as any),
      (err: unknown) => err instanceof Error && err.message === (missions as any).RECIPIENT_MISSION_CHAT_REFUSAL,
      `chat ${JSON.stringify(chatId)}`,
    )
  }
  assert.match(String((missions as any).RECIPIENT_MISSION_CHAT_REFUSAL), /did not start/)
})

test('on the owner own turn, and with no private turn, the implicit chat is exactly what it was', () => {
  const scenarios = [
    { turnChatId: OWNER_CHAT },
    { turnChatId: RECIPIENT_CHAT },
    { turnChatId: '9001' },
    { turnChatId: null },
    { turnChatId: RECIPIENT_CHAT, monitoredChatIds: [RECIPIENT_CHAT] },
    { turnChatId: null, monitoredChatIds: [] },
  ]
  for (const scenario of scenarios) {
    const before = missions.pickImplicitMissionChat({ ...base, ...scenario })
    for (const privateTurn of [{ actingUserId: OWNER, chatId: OWNER_CHAT }, { actingUserId: OWNER, chatId: RECIPIENT_CHAT }, null, undefined]) {
      assert.equal(missions.pickImplicitMissionChat({ ...base, ...scenario, privateTurn } as any), before, JSON.stringify({ scenario, privateTurn }))
    }
  }
})

// ── the six tools, executed from server.ts ───────────────────────────────────

type Sent = { method: string; path: string; body?: unknown; headers: Record<string, string> }

function rig(privateCall: { actingUserId: string; chatId: string; headers: Record<string, string> }) {
  const sent: Sent[] = []
  const answer = { mission: { id: 77, title: 'Launch', status: 'active', miniGoals: [] } }
  const headersOf = (value: unknown) => ({ ...((value ?? {}) as Record<string, string>) })
  const bindings: Record<string, unknown> = {
    ...missions, privateCall, ASSISTANT_ID: '900', USER_ID: OWNER, log: () => {},
    monitoredChatIds: [OWNER_CHAT, RECIPIENT_CHAT],
    meetingIdByChatId: new Map(),
    lastInboundUserByChat: new Map(senders),
    turnChat: { current: () => ({ chatId: privateCall.chatId }) },
    resolveAuthorizedChat: (chatId: string) => ({ ok: true, chatId }),
    formatMissionSummary: () => 'summary',
    rememberMissionSelfWrite: () => {}, noteMissionPendingSelfWrite: () => {},
    bgosGetCachedOn304: async (path: string) => { sent.push({ method: 'GET cached', path, headers: {} }); return answer },
    bgosGet: async (path: string, opts?: { headers?: Record<string, string> }) => { sent.push({ method: 'GET', path, headers: headersOf(opts?.headers) }); return answer },
    bgosPost: async (path: string, body: unknown, opts?: { headers?: Record<string, string> }) => { sent.push({ method: 'POST', path, body, headers: headersOf(opts?.headers) }); return answer },
    bgosPatch: async (path: string, body: unknown, headers?: Record<string, string>) => { sent.push({ method: 'PATCH', path, body, headers: headersOf(headers) }); return answer },
    bgosPut: async (path: string, body: unknown, headers?: Record<string, string>) => { sent.push({ method: 'PUT', path, body, headers: headersOf(headers) }); return answer },
    bgosDelete: async (path: string, headers?: Record<string, string>) => { sent.push({ method: 'DELETE', path, headers: headersOf(headers) }); return answer },
  }
  const run = async (name: string, rawArgs: Record<string, unknown>) =>
    execute(`${missionHelpers}\nreturn (async () => { switch(name) { ${missionCases} } })();`, { ...bindings, name, rawArgs })
  return { sent, run }
}

const ARGS: Record<string, Record<string, unknown>> = {
  create_mission: { title: 'Plan the week', mini_goals: [{ name: 'Draft', done_when: 'a draft exists' }, { name: 'Review', done_when: 'it was reviewed' }] },
  tick_mini_goal: { goal_id: 3, evidence: 'done' },
  set_mission_goals: { mini_goals: [{ name: 'Draft', done_when: 'a draft exists' }, { name: 'Review', done_when: 'it was reviewed' }] },
  add_mission_goals: { mini_goals: [{ name: 'Ship', done_when: 'it shipped' }] },
  cancel_mission_goal: { goal_id: 3 },
  complete_mission: { summary: 'All done' },
}

test('on a recipient turn every mission request names them, in their own chat, with no chat named', async () => {
  const recipientCall = { actingUserId: RECIPIENT, chatId: RECIPIENT_CHAT, headers: { 'X-BGOS-Acting-User': RECIPIENT } }
  for (const name of MISSION_TOOLS) {
    const r = rig(recipientCall)
    const result = await r.run(name, ARGS[name]!)
    assert.notEqual(result?.isError, true, `${name}: ${JSON.stringify(result)}`)
    assert.ok(r.sent.length > 0, `${name} sent nothing`)
    for (const call of r.sent) {
      assert.deepEqual(call.headers, { 'X-BGOS-Acting-User': RECIPIENT }, `${name}: ${call.method} ${call.path}`)
      assert.notEqual(call.method, 'GET cached', `${name}: a recipient read never rides the shared ETag cache`)
    }
    if (name === 'create_mission') assert.equal((r.sent[0]!.body as { chatId?: number }).chatId, Number(RECIPIENT_CHAT), 'the recipient own chat, not the owner')
    else assert.equal(r.sent[0]!.path, `assistants/900/missions/active?chatId=${RECIPIENT_CHAT}`, `${name} looks up the recipient own chat`)
  }
})

test('on the owner own turn every mission request is what it was: no header, the cached read, the same chat', async () => {
  const ownerCall = { actingUserId: OWNER, chatId: OWNER_CHAT, headers: {} }
  for (const name of MISSION_TOOLS) {
    const r = rig(ownerCall)
    const result = await r.run(name, ARGS[name]!)
    assert.notEqual(result?.isError, true, `${name}: ${JSON.stringify(result)}`)
    for (const call of r.sent) assert.deepEqual(call.headers, {}, `${name}: ${call.method} ${call.path}`)
    if (name === 'create_mission') assert.equal((r.sent[0]!.body as { chatId?: number }).chatId, Number(OWNER_CHAT))
    else assert.deepEqual([r.sent[0]!.method, r.sent[0]!.path], ['GET cached', `assistants/900/missions/active?chatId=${OWNER_CHAT}`])
  }
})

test('a recipient turn with no chat of its own writes nothing and says why, for every mission tool', async () => {
  for (const name of MISSION_TOOLS) {
    const r = rig({ actingUserId: RECIPIENT, chatId: '', headers: { 'X-BGOS-Acting-User': RECIPIENT } })
    const result = await r.run(name, ARGS[name]!)
    assert.equal(result?.isError, true, name)
    assert.equal(result.content[0].text, (missions as any).RECIPIENT_MISSION_CHAT_REFUSAL, name)
    assert.deepEqual(r.sent, [], `${name} sent nothing`)
  }
})
