/**
 * set_goal_working and set_goal_waiting (board row 9d7880bf, KC 1048 msg
 * 170414, "it is a must").
 *
 * THE GAP. BGOS #3575 (5.26.0) shipped the working mark: PATCH
 * integrations/assistants/:id/missions/:missionId/goals/:goalId/working with
 * { working: boolean }, and the card animates every goal so marked. Its
 * sibling .../goals/:goalId/waiting ({ waiting: { on, who, why } | null })
 * shipped before it. The plugin had no tool for either, so a Claude Code agent
 * could never say which goals it was working on, and the card only ever
 * animated the first unticked one.
 *
 * WHAT THESE TESTS HOLD, against the REAL server.ts cases (lifted and run with
 * fake HTTP helpers, the rig test/mission-private.test.ts uses):
 *   - the path is the pairing family route, by PATCH, one call per goal id, in
 *     the order given, with the body the backend DTO takes;
 *   - every call carries the turn's caller headers through the same bgosPatch
 *     the other mission tools use (bgosPatch adds the auth headers itself);
 *   - a bad id or a bad flag is refused before ANY request, naming the value;
 *   - a backend refusal is surfaced to the agent word for word, the other goals
 *     are still sent, and the result is an error;
 *   - the tools are declared, turn aware, private for the helper guard, named
 *     in the MCP instructions and the bundled fallback, and the daemon declares
 *     mission_goal_working so the served canon tells the agent the rule.
 *
 * Run with: npx tsx --test test/goal-marks.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as missions from '../lib/missions.ts'
import { BGOS_CAPABILITIES_FALLBACK } from '../lib/capabilities.ts'
import { DECLARED_CAPABILITIES_BASE, declaredCapabilities } from '../lib/declared-capabilities.ts'
import { OWN_MCP_TOOLS } from '../lib/hook-events.ts'
import { PRIVATE_TOOL_MATCHER } from '../lib/private-turn.mjs'
import { PRIVATE_TOOL_MATCHER as PRESEED_MATCHER } from '../lib/claude-preseed.mjs'
import { createMissionSelfWriteLedger } from '../lib/mission-events.ts'

const m = missions as any
const source = readFileSync('server.ts', 'utf8').replace(/\r\n/g, '\n')
const missionCases = source.slice(source.indexOf("    case 'create_mission': {"), source.indexOf("    case 'log_health_event': {"))
const missionHelpers = source.slice(source.indexOf('function resolveMissionToolChat('), source.indexOf('function resolveAuthorizedChat('))
const OWNER = 'user_owner'
const OWNER_CHAT = '4403'
const RECIPIENT = 'user_recipient'
const RECIPIENT_CHAT = '7788'
const TOOLS = ['set_goal_working', 'set_goal_waiting']

function execute(body: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings))
}

type Sent = { method: string; path: string; body?: unknown; headers: Record<string, string> }
type Patch = (path: string, body: unknown, headers?: Record<string, string>) => Promise<unknown>

const MISSION = {
  id: 77,
  title: 'Launch',
  status: 'active',
  miniGoals: [
    { id: 2, name: 'Draft', doneWhen: 'a draft exists', done: false, doneAt: null, evidence: null },
    { id: 3, name: 'Review', doneWhen: 'it was reviewed', done: false, doneAt: null, evidence: null },
    { id: 4, name: 'Ship', doneWhen: 'it shipped', done: false, doneAt: null, evidence: null },
  ],
}

function rig(privateCall: { actingUserId: string; chatId: string; headers: Record<string, string> }, patch?: Patch, open: unknown = MISSION) {
  const sent: Sent[] = []
  const stamped: number[] = []
  const remembered: number[] = []
  const answer = { mission: MISSION }
  const read = { mission: open }
  const headersOf = (value: unknown) => ({ ...((value ?? {}) as Record<string, string>) })
  const bindings: Record<string, unknown> = {
    ...missions, privateCall, ASSISTANT_ID: '900', USER_ID: OWNER, log: () => {},
    monitoredChatIds: [OWNER_CHAT, RECIPIENT_CHAT],
    meetingIdByChatId: new Map(),
    lastInboundUserByChat: new Map([[OWNER_CHAT, OWNER], [RECIPIENT_CHAT, RECIPIENT]]),
    turnChat: { current: () => ({ chatId: privateCall.chatId }) },
    resolveAuthorizedChat: (chatId: string) => ({ ok: true, chatId }),
    formatMissionSummary: () => 'summary',
    rememberMissionSelfWrite: (mission: { id: number }) => { remembered.push(mission.id) },
    noteMissionPendingSelfWrite: (id: number) => { stamped.push(id) },
    bgosGetCachedOn304: async (path: string) => { sent.push({ method: 'GET cached', path, headers: {} }); return read },
    bgosGet: async (path: string, opts?: { headers?: Record<string, string> }) => { sent.push({ method: 'GET', path, headers: headersOf(opts?.headers) }); return read },
    bgosPost: async (path: string, body: unknown, opts?: { headers?: Record<string, string> }) => { sent.push({ method: 'POST', path, body, headers: headersOf(opts?.headers) }); return answer },
    bgosPatch: async (path: string, body: unknown, headers?: Record<string, string>) => {
      sent.push({ method: 'PATCH', path, body, headers: headersOf(headers) })
      return patch ? patch(path, body, headers) : answer
    },
    bgosPut: async (path: string, body: unknown, headers?: Record<string, string>) => { sent.push({ method: 'PUT', path, body, headers: headersOf(headers) }); return answer },
    bgosDelete: async (path: string, headers?: Record<string, string>) => { sent.push({ method: 'DELETE', path, headers: headersOf(headers) }); return answer },
  }
  const run = async (name: string, rawArgs: Record<string, unknown>) =>
    execute(`${missionHelpers}\nreturn (async () => { switch(name) { ${missionCases} } })();`, { ...bindings, name, rawArgs })
  const writes = () => sent.filter((c) => c.method === 'PATCH')
  return { sent, writes, run, stamped, remembered }
}

const ownerCall = { actingUserId: OWNER, chatId: OWNER_CHAT, headers: {} as Record<string, string> }
const recipientCall = { actingUserId: RECIPIENT, chatId: RECIPIENT_CHAT, headers: { 'X-BGOS-Acting-User': RECIPIENT } }
const textOf = (result: any) => String(result?.content?.[0]?.text ?? '')

// ── the pure builders (lib/missions.ts) ──────────────────────────────────────

test('the working and waiting paths are the pairing family routes, one goal each', () => {
  assert.deepEqual(m.buildMissionGoalWorkingPath('900', 77, 3), { ok: true, path: 'integrations/assistants/900/missions/77/goals/3/working' })
  assert.deepEqual(m.buildMissionGoalWaitingPath('900', 77, 3), { ok: true, path: 'integrations/assistants/900/missions/77/goals/3/waiting' })
  for (const build of [m.buildMissionGoalWorkingPath, m.buildMissionGoalWaitingPath]) {
    assert.equal(build(undefined, 77, 3).ok, false, 'no assistant id')
    assert.equal(build('900', 0, 3).ok, false, 'bad mission id')
    for (const bad of [0, -1, 1.5, 'x', null, undefined, Number.NaN]) {
      const built = build('900', 77, bad)
      assert.equal(built.ok, false, `goal ${String(bad)}`)
      assert.match(built.error, /goal_id must be a positive integer/)
    }
  }
})

test('set_goal_working input: one or more positive integer ids and a boolean, anything else refused with the value named', () => {
  assert.deepEqual(m.buildMissionGoalWorkingInput({ goal_ids: [2, 3], working: true }), { ok: true, body: { goalIds: [2, 3], working: true } })
  assert.deepEqual(m.buildMissionGoalWorkingInput({ goal_ids: [4], working: false }), { ok: true, body: { goalIds: [4], working: false } })
  // A repeated id is one goal, so it is one call, in first seen order.
  assert.deepEqual(m.buildMissionGoalWorkingInput({ goal_ids: [3, 2, 3], working: true }), { ok: true, body: { goalIds: [3, 2], working: true } })
  const refusals: Array<[unknown, RegExp]> = [
    [{ goal_ids: [], working: true }, /goal_ids must list 1 to 12/],
    [{ goal_ids: 3, working: true }, /goal_ids must list 1 to 12/],
    [{ working: true }, /goal_ids must list 1 to 12/],
    [{ goal_ids: Array.from({ length: 13 }, (_, i) => i + 1), working: true }, /goal_ids must list 1 to 12/],
    [{ goal_ids: [2, 0], working: true }, /goal_ids\[1\] must be a positive integer.*got 0/],
    [{ goal_ids: [-1], working: true }, /got -1/],
    [{ goal_ids: [1.5], working: true }, /got 1\.5/],
    [{ goal_ids: ['3'], working: true }, /got "3"/],
    [{ goal_ids: [2], working: 'yes' }, /working must be true or false/],
    [{ goal_ids: [2] }, /working must be true or false/],
  ]
  for (const [input, error] of refusals) {
    const built = m.buildMissionGoalWorkingInput(input)
    assert.equal(built.ok, false, JSON.stringify(input))
    assert.match(built.error, error, JSON.stringify(input))
  }
})

test('set_goal_waiting body: { on, who, why } trimmed, or null to clear, judged as the backend judges it', () => {
  assert.deepEqual(
    m.buildMissionGoalWaitingBody({ on: 'owner', who: ' Kc ', why: ' needs the API key ' }),
    { ok: true, body: { waiting: { on: 'owner', who: 'Kc', why: 'needs the API key' } } },
  )
  assert.deepEqual(m.buildMissionGoalWaitingBody({ on: 'agent', who: 'Ares', why: 'reviews the PR' }).body.waiting.on, 'agent')
  assert.deepEqual(m.buildMissionGoalWaitingBody({ clear: true }), { ok: true, body: { waiting: null } })
  const refusals: Array<[unknown, RegExp]> = [
    [{ on: 'team', who: 'Kc', why: 'x' }, /on must be "owner" or "agent"/],
    [{ who: 'Kc', why: 'x' }, /on must be "owner" or "agent"/],
    [{ on: 'owner', who: '  ', why: 'x' }, /who must name them/],
    [{ on: 'owner', who: 'K'.repeat(81), why: 'x' }, /who is too long \(81 chars, max 80\)/],
    [{ on: 'owner', who: 'Kc\nX', why: 'x' }, /who must be one line/],
    [{ on: 'owner', who: 'Kc', why: '' }, /why must say what they owe/],
    [{ on: 'owner', who: 'Kc', why: 'w'.repeat(201) }, /why is too long \(201 chars, max 200\)/],
    [{ clear: true, on: 'owner', who: 'Kc', why: 'x' }, /clear: true takes no on, who or why/],
    [{ clear: 'yes' }, /clear must be true/],
  ]
  for (const [input, error] of refusals) {
    const built = m.buildMissionGoalWaitingBody(input)
    assert.equal(built.ok, false, JSON.stringify(input))
    assert.match(built.error, error, JSON.stringify(input))
  }
})

// ── set_goal_working, the real server.ts case ────────────────────────────────

test('set_goal_working sends one PATCH per goal id, in order, to the working route, with { working }', async () => {
  const r = rig(ownerCall)
  const result = await r.run('set_goal_working', { goal_ids: [2, 3, 4], working: true })
  assert.notEqual(result?.isError, true, textOf(result))
  assert.deepEqual(r.sent[0], { method: 'GET cached', path: `assistants/900/missions/active?chatId=${OWNER_CHAT}`, headers: {} })
  assert.deepEqual(r.writes().map((c) => [c.method, c.path, c.body]), [
    ['PATCH', 'integrations/assistants/900/missions/77/goals/2/working', { working: true }],
    ['PATCH', 'integrations/assistants/900/missions/77/goals/3/working', { working: true }],
    ['PATCH', 'integrations/assistants/900/missions/77/goals/4/working', { working: true }],
  ])
  assert.equal(r.sent.length, 4, 'one read, then exactly one write per goal')
  for (const call of r.writes()) assert.deepEqual(call.headers, {}, 'the owner turn adds no header, as every mission write')
  assert.deepEqual(r.stamped, [], 'no PENDING stamp: a mark only emits mission_updated, which never spends one')
  assert.deepEqual(r.remembered, [77, 77, 77], 'each landed write is stamped')
  assert.match(textOf(result), /2, 3, 4/)
  assert.match(textOf(result), /30 minutes/, 'the result restates the refresh rule')
})

test('set_goal_working with working false clears each mark the same way', async () => {
  const r = rig(ownerCall)
  const result = await r.run('set_goal_working', { goal_ids: [3], working: false })
  assert.notEqual(result?.isError, true, textOf(result))
  assert.deepEqual(r.writes().map((c) => [c.path, c.body]), [['integrations/assistants/900/missions/77/goals/3/working', { working: false }]])
  assert.match(textOf(result), /cleared/i)
})

test('set_goal_working on a recipient turn carries their caller header on every write', async () => {
  const r = rig(recipientCall)
  const result = await r.run('set_goal_working', { goal_ids: [2, 3], working: true })
  assert.notEqual(result?.isError, true, textOf(result))
  assert.equal(r.writes().length, 2)
  for (const call of r.sent) assert.deepEqual(call.headers, { 'X-BGOS-Acting-User': RECIPIENT }, `${call.method} ${call.path}`)
})

test('set_goal_working with an explicit mission_id targets it, with no read on the owner turn', async () => {
  const r = rig(ownerCall)
  await r.run('set_goal_working', { goal_ids: [2], working: true, mission_id: 555 })
  assert.deepEqual(r.sent.map((c) => [c.method, c.path]), [['PATCH', 'integrations/assistants/900/missions/555/goals/2/working']])
})

test('set_goal_working refuses a bad id or flag before ANY request, naming the value', async () => {
  for (const args of [
    { goal_ids: [2, 0], working: true },
    { goal_ids: [2, 'x'], working: true },
    { goal_ids: [], working: true },
    { goal_ids: [2], working: 'true' },
  ]) {
    const r = rig(ownerCall)
    const result = await r.run('set_goal_working', args)
    assert.equal(result?.isError, true, JSON.stringify(args))
    assert.match(textOf(result), /^Error: /)
    assert.deepEqual(r.sent, [], `${JSON.stringify(args)} sent nothing`)
  }
})

test('set_goal_working surfaces a refusal word for word, still sends the other goals, and is an error', async () => {
  const r = rig(ownerCall, async (path) => {
    if (path.endsWith('/goals/3/working')) throw new Error('PATCH 409: Goal 3 is already ticked, so nobody is working on it.')
    return { mission: MISSION }
  })
  const result = await r.run('set_goal_working', { goal_ids: [2, 3, 4], working: true })
  assert.equal(result?.isError, true)
  assert.equal(r.writes().length, 3, 'goal 4 is still sent after goal 3 is refused')
  const text = textOf(result)
  assert.match(text, /PATCH 409: Goal 3 is already ticked, so nobody is working on it\./)
  assert.match(text, /goal 3/i)
  assert.match(text, /2, 4/, 'the goals that did take the mark are named')
  assert.deepEqual(r.remembered, [77, 77], 'only landed writes are remembered')
})

test('set_goal_working with every goal refused names each failure', async () => {
  const r = rig(ownerCall, async (path) => { throw new Error(`PATCH 403: refused ${path.split('/').slice(-2, -1)[0]}`) })
  const result = await r.run('set_goal_working', { goal_ids: [2, 3], working: true })
  assert.equal(result?.isError, true)
  assert.match(textOf(result), /PATCH 403: refused 2/)
  assert.match(textOf(result), /PATCH 403: refused 3/)
})

test('with no open mission in the chat neither tool writes, and each says so', async () => {
  for (const [tool, args] of [['set_goal_working', { goal_ids: [2], working: true }], ['set_goal_waiting', { goal_id: 2, clear: true }]] as const) {
    const r = rig(ownerCall, undefined, null)
    const result = await r.run(tool, args)
    assert.equal(result?.isError, true, tool)
    assert.match(textOf(result), /No active mission/, tool)
    assert.deepEqual(r.writes(), [], `${tool} wrote nothing`)
  }
})

// ── set_goal_waiting, the real server.ts case ────────────────────────────────

test('set_goal_waiting sends one PATCH to the waiting route with { waiting: { on, who, why } }', async () => {
  const r = rig(recipientCall)
  const result = await r.run('set_goal_waiting', { goal_id: 4, on: 'owner', who: 'Kc', why: 'needs to send the API key' })
  assert.notEqual(result?.isError, true, textOf(result))
  assert.deepEqual(r.writes().map((c) => [c.method, c.path, c.body]), [
    ['PATCH', 'integrations/assistants/900/missions/77/goals/4/waiting', { waiting: { on: 'owner', who: 'Kc', why: 'needs to send the API key' } }],
  ])
  for (const call of r.sent) assert.deepEqual(call.headers, { 'X-BGOS-Acting-User': RECIPIENT }, `${call.method} ${call.path}`)
  assert.deepEqual(r.stamped, [])
  assert.deepEqual(r.remembered, [77])
  assert.match(textOf(result), /waiting on Kc/i)
})

test('set_goal_waiting with clear: true sends { waiting: null }', async () => {
  const r = rig(ownerCall)
  const result = await r.run('set_goal_waiting', { goal_id: 4, clear: true })
  assert.notEqual(result?.isError, true, textOf(result))
  assert.deepEqual(r.writes().map((c) => [c.path, c.body, c.headers]), [['integrations/assistants/900/missions/77/goals/4/waiting', { waiting: null }, {}]])
})

test('set_goal_waiting refuses a bad goal id or shape before ANY request', async () => {
  for (const args of [
    { goal_id: 0, on: 'owner', who: 'Kc', why: 'x' },
    { goal_id: 'four', on: 'owner', who: 'Kc', why: 'x' },
    { on: 'owner', who: 'Kc', why: 'x' },
    { goal_id: 4, on: 'everyone', who: 'Kc', why: 'x' },
    { goal_id: 4, on: 'owner', who: '', why: 'x' },
  ]) {
    const r = rig(ownerCall)
    const result = await r.run('set_goal_waiting', args)
    assert.equal(result?.isError, true, JSON.stringify(args))
    assert.match(textOf(result), /^Error: /)
    assert.deepEqual(r.sent, [], `${JSON.stringify(args)} sent nothing`)
  }
})

test('set_goal_waiting surfaces the backend refusal word for word', async () => {
  const r = rig(ownerCall, async () => { throw new Error('PATCH 409: Goal 4 is ticked; a ticked goal waits on nobody.') })
  const result = await r.run('set_goal_waiting', { goal_id: 4, on: 'agent', who: 'Ares', why: 'reviews it' })
  assert.equal(result?.isError, true)
  assert.match(textOf(result), /PATCH 409: Goal 4 is ticked; a ticked goal waits on nobody\./)
})

// ── the self write ledger: a mark must never swallow the owner's next change ──

test("after a mark the owner's next Pause and Resume are still heard (found in review)", async () => {
  // The pending stamp is spent only by a created, paused, resumed, completed,
  // abandoned or failed frame with no cleared_by. A mark only ever emits
  // mission_updated, so a pending stamp taken for it would linger and the
  // backend's pause and resume, which carry no cleared_by, would read as the
  // agent's own write: the owner taps Pause and the agent is never told.
  for (const [tool, args] of [['set_goal_working', { goal_ids: [2, 3], working: true }], ['set_goal_waiting', { goal_id: 4, on: 'owner', who: 'Kc', why: 'needs the key' }]] as const) {
    const ledger = createMissionSelfWriteLedger()
    const real = rig(ownerCall)
    ;(real as any).run = async (name: string, rawArgs: Record<string, unknown>) =>
      execute(`${missionHelpers}\nreturn (async () => { switch(name) { ${missionCases} } })();`, {
        ...missions, privateCall: ownerCall, ASSISTANT_ID: '900', USER_ID: OWNER, log: () => {},
        monitoredChatIds: [OWNER_CHAT], meetingIdByChatId: new Map(), lastInboundUserByChat: new Map([[OWNER_CHAT, OWNER]]),
        turnChat: { current: () => ({ chatId: OWNER_CHAT }) }, resolveAuthorizedChat: (chatId: string) => ({ ok: true, chatId }),
        formatMissionSummary: () => 'summary',
        rememberMissionSelfWrite: (mission: unknown) => ledger.noteWritten(mission),
        noteMissionPendingSelfWrite: (id: unknown) => ledger.notePending(id),
        bgosGetCachedOn304: async () => ({ mission: MISSION }), bgosGet: async () => ({ mission: MISSION }),
        bgosPatch: async () => ({ mission: { ...MISSION, updatedAt: '2026-10-31T10:00:00.000Z' } }),
        name, rawArgs,
      })
    const result = await (real as any).run(tool, args)
    assert.notEqual(result?.isError, true, `${tool}: ${textOf(result)}`)
    const owner = (frame: string, updatedAt: string) => ({ frame, mission: { ...MISSION, updatedAt }, clearedBy: null }) as any
    assert.equal(ledger.isSelfAuthored(owner('mission_paused', '2026-10-31T10:05:00.000Z')), false, `${tool}: the owner Pause after it is heard`)
    assert.equal(ledger.isSelfAuthored(owner('mission_resumed', '2026-10-31T10:09:00.000Z')), false, `${tool}: and so is the Resume`)
    // The echo of the mark itself is still recognised by the landed stamp.
    assert.equal(ledger.isSelfAuthored(owner('mission_updated', '2026-10-31T10:00:00.000Z')), true, `${tool}: its own frame is its own`)
  }
})

test('set_goal_waiting takes a goal id only as a number, as set_goal_working does', async () => {
  for (const goal_id of ['3', ' 3', '0x10', '1e1']) {
    const r = rig(ownerCall)
    const result = await r.run('set_goal_waiting', { goal_id, on: 'owner', who: 'Kc', why: 'x' })
    assert.equal(result?.isError, true, JSON.stringify(goal_id))
    assert.match(textOf(result), /goal_id must be a positive integer/)
    assert.deepEqual(r.sent, [], `${JSON.stringify(goal_id)} sent nothing`)
  }
})

test('who refuses the line and paragraph separators the backend refuses', () => {
  for (const sep of ['\u2028', '\u2029']) {
    const built = m.buildMissionGoalWaitingBody({ on: 'owner', who: `Kc${sep}X`, why: 'x' })
    assert.equal(built.ok, false, JSON.stringify(sep))
    assert.match(built.error, /who must be one line/)
  }
})

// ── declarations, admission, the hook guard, the canon ───────────────────────

function declaration(tool: string): string {
  const at = source.indexOf(`      name: '${tool}',`)
  assert.ok(at > 0, `${tool} must be declared`)
  const end = source.indexOf("\n    {\n      name: '", at)
  return source.slice(at, end > 0 ? end : at + 6000)
}

test('both tools are declared with the brief schema, chat_id and mission_id optional', () => {
  const working = declaration('set_goal_working')
  assert.match(working, /goal_ids: \{\s+type: 'array'/)
  assert.match(working, /items: \{ type: 'number' \}/)
  assert.match(working, /working: \{\s+type: 'boolean'/)
  assert.match(working, /required: \['goal_ids', 'working'\]/)
  // The DESCRIPTION, joined as the model reads it, not the schema below it:
  // the refresh rule must be the tool's own instruction, not a field hint.
  const description = working.slice(working.indexOf('description:'), working.indexOf('inputSchema:')).replace(/'\s*\+\s*'/g, '')
  assert.match(description, /call this again with working: true within 30 minutes for every goal you are still working on/, 'the refresh rule is in the description')
  assert.match(description, /working: false when you stop/)
  assert.match(working, /integrations\/assistants\/:id\/missions\/:missionId\/goals\/:goalId\/working/)
  const waiting = declaration('set_goal_waiting')
  assert.match(waiting, /enum: \['owner', 'agent'\]/)
  assert.match(waiting, /required: \['goal_id'\]/)
  assert.match(waiting, /integrations\/assistants\/:id\/missions\/:missionId\/goals\/:goalId\/waiting/)
  for (const decl of [working, waiting]) {
    assert.match(decl, /mission_id: \{/)
    assert.match(decl, /chat_id: \{/)
    assert.doesNotMatch(decl, /[\u2013\u2014]/, 'no em or en dashes in what the model reads')
  }
})

test('both tools are turn aware at admission, private for the helper guard in every install, and own tools for the hook rows', () => {
  const gate = source.slice(source.indexOf("  } else if (['call_owner', 'list_chats', 'create_mission'"), source.indexOf('.includes(req.params.name)) {', source.indexOf("  } else if (['call_owner', 'list_chats', 'create_mission'")))
  const hooks = JSON.parse(readFileSync('hooks/hooks.json', 'utf8'))
  const guard = hooks.hooks.PreToolUse.find((entry: any) => entry.hooks.some((h: any) => String(h.args?.[0]).endsWith('hoai-private-turn-hook.mjs')))
  for (const tool of TOOLS) {
    assert.ok(gate.includes(`'${tool}'`), `${tool} in the admission gate`)
    for (const matcher of [PRIVATE_TOOL_MATCHER, PRESEED_MATCHER, guard.matcher]) {
      assert.ok(new RegExp(matcher).test(`mcp__plugin_hoai_bgos__${tool}`), `${tool} against ${matcher}`)
    }
    assert.ok((OWN_MCP_TOOLS as readonly string[]).includes(tool), `${tool} is the channel's own tool`)
  }
})

test('the MCP instructions and the bundled fallback name both tools and the 30 minute refresh', () => {
  const missionsSection = source.slice(source.indexOf("'## Missions ("), source.indexOf("'## Sending Files & Media'"))
  for (const text of [missionsSection, BGOS_CAPABILITIES_FALLBACK]) {
    assert.ok(text.includes('set_goal_working'))
    assert.ok(text.includes('set_goal_waiting'))
    assert.match(text.replace(/',\s*'/g, ' '), /30\s+minutes/)
    assert.doesNotMatch(text, /[\u2013\u2014]/)
  }
})

test('mission_goal_working is declared on every host, so the served canon tells the agent the working rule', () => {
  assert.ok(DECLARED_CAPABILITIES_BASE.includes('mission_goal_working'))
  for (const canInjectGoal of [true, false]) {
    for (const authMode of ['pairing', 'api_key']) {
      assert.ok(declaredCapabilities({ canInjectGoal, floorHook: true, authMode } as any).includes('mission_goal_working'))
    }
  }
})
