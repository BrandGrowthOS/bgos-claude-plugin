import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import {
  SCHEDULE_GRANT_HEADER,
  SCHEDULE_GRANT_MAX_MS,
  createScheduleGrantRuns,
  requireBoardsTurn,
  scheduleGrantOf,
} from '../lib/schedule-grant-run.mjs'
import { PRIVATE_TURN_REFUSAL } from '../lib/private-turn.mjs'

// A scheduled run keeps the permission of the person who scheduled it (0.86.20). Unit tests of the run, then the
// real server.ts admission and delivery code run with doubles around it.

const OWNER = 'user_owner'
const MEMBER = 'user_member'
const FIRED = Date.parse('2026-11-07T02:00:00.000Z')
const FIRE_ID = `scheduled-wake:41:${new Date(FIRED).toISOString()}`
const wakeMeta = (over: Record<string, unknown> = {}) => ({
  source: 'scheduler',
  payload: {
    scheduledTaskId: 41,
    fireId: FIRE_ID,
    actingUserId: OWNER,
    boardGrant: { boards: 1, expiresAt: new Date(FIRED + SCHEDULE_GRANT_MAX_MS).toISOString() },
    ...over,
  },
})
const grantAt = (now: number, meta: Record<string, unknown> = wakeMeta()) =>
  scheduleGrantOf({ senderType: 'system', eventMeta: meta, actingUserId: OWNER, chatId: 900, now })

function fakeClock(start = FIRED + 60_000) {
  let t = start
  const timers: Array<{ at: number; fn: () => void; done: boolean }> = []
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const h = { at: t + ms, fn, done: false }; timers.push(h); return h },
    clearTimer: (h: { done: boolean }) => { h.done = true },
    advance(ms: number) { t += ms; for (const h of timers) if (!h.done && h.at <= t) { h.done = true; h.fn() } },
  }
}

test('a granted wake carries a grant; anything else does not', () => {
  const g = grantAt(FIRED + 1000)
  assert.ok(g)
  assert.equal(g!.taskId, 41)
  assert.equal(g!.fireId, FIRE_ID)
  assert.equal(g!.actingUserId, OWNER)
  assert.equal(g!.chatId, '900')
  // No boardGrant, a status card, a payload kind, a fire id of another task, a person's message: none.
  assert.equal(grantAt(FIRED, wakeMeta({ boardGrant: undefined })), null)
  assert.equal(grantAt(FIRED, { ...wakeMeta(), status: 'could_not_start' }), null)
  assert.equal(grantAt(FIRED, wakeMeta({ kind: 'routine_created' })), null)
  assert.equal(grantAt(FIRED, wakeMeta({ fireId: FIRE_ID.replace(':41:', ':42:') })), null)
  assert.equal(scheduleGrantOf({ senderType: 'user', eventMeta: wakeMeta(), actingUserId: OWNER, chatId: 1, now: FIRED }), null)
  assert.equal(scheduleGrantOf({ senderType: 'system', eventMeta: wakeMeta(), actingUserId: null, chatId: 1, now: FIRED }), null)
})

test('a payload never makes the window longer than two hours after the fire, and an ended window grants nothing', () => {
  const long = grantAt(FIRED, wakeMeta({ boardGrant: { boards: 1, expiresAt: new Date(FIRED + 10 * SCHEDULE_GRANT_MAX_MS).toISOString() } }))
  assert.equal(long!.expiresAtMs, FIRED + SCHEDULE_GRANT_MAX_MS)
  assert.equal(grantAt(FIRED + SCHEDULE_GRANT_MAX_MS), null)
})

test("during a granted run other people's deliveries wait, the scheduler's do not, and the run's end releases them", async () => {
  const clock = fakeClock()
  const ended: string[] = []
  const runs = createScheduleGrantRuns({ ...clock, onEnded: (_run: unknown, reason: string) => ended.push(reason) })
  assert.equal(runs.open(grantAt(clock.now())), true)
  assert.equal(runs.holds({ actingUserId: MEMBER }), true)
  assert.equal(runs.holds({ actingUserId: null }), true) // an agent or an email
  assert.equal(runs.holds({ actingUserId: OWNER }), false)
  let released = false
  void runs.whenReleased().then(() => { released = true })
  // A Stop before the run's own turn began (the CLI was busy with an earlier turn) does not end it.
  runs.noteStop()
  await Promise.resolve()
  assert.equal(released, false)
  runs.noteBegin()
  runs.noteStop()
  await Promise.resolve()
  assert.equal(released, true)
  assert.deepEqual(ended, ['turn ended'])
  assert.equal(runs.holds({ actingUserId: MEMBER }), false)
  // The same wake delivered again never reopens it.
  assert.equal(runs.open(grantAt(clock.now())), false)
})

test('the window running out ends the run and releases what waited', async () => {
  const clock = fakeClock()
  const ended: string[] = []
  const runs = createScheduleGrantRuns({ ...clock, onEnded: (_run: unknown, reason: string) => ended.push(reason) })
  runs.open(grantAt(clock.now()))
  let released = false
  void runs.whenReleased().then(() => { released = true })
  clock.advance(SCHEDULE_GRANT_MAX_MS)
  await Promise.resolve()
  assert.equal(released, true)
  assert.deepEqual(ended, ['expired'])
  assert.equal(runs.live(), null)
})

test('boards: a verified turn of the scheduler carries the grant; a revoked one is admitted on the grant alone, once its turn began', () => {
  const clock = fakeClock()
  const runs = createScheduleGrantRuns(clock)
  runs.open(grantAt(clock.now()))
  const verified = () => ({ actingUserId: OWNER, chatId: '900', headers: {} })
  const revoked = () => { throw new Error(PRIVATE_TURN_REFUSAL) }
  const call = (requirePrivateTurn: () => unknown) =>
    requireBoardsTurn({ requirePrivateTurn: requirePrivateTurn as never, tracker: {}, markerPaths: [], ownerUserId: OWNER, runs })
  assert.deepEqual(call(verified).headers, { [SCHEDULE_GRANT_HEADER]: FIRE_ID })
  // Before the run's own turn began, a revoked turn is still refused.
  assert.throws(() => call(revoked), { message: PRIVATE_TURN_REFUSAL })
  runs.noteBegin()
  const granted = call(revoked) as { actingUserId: string; headers: Record<string, string> }
  assert.equal(granted.actingUserId, OWNER)
  assert.deepEqual(granted.headers, { [SCHEDULE_GRANT_HEADER]: FIRE_ID })
  // Another person's verified turn never carries this run's grant.
  const other = call(() => ({ actingUserId: MEMBER, chatId: '900', headers: { 'X-BGOS-Acting-User': MEMBER } }))
  assert.deepEqual((other as { headers: unknown }).headers, { 'X-BGOS-Acting-User': MEMBER })
  // After the run, the refusal is exactly as before.
  runs.noteStop()
  assert.throws(() => call(revoked), { message: PRIVATE_TURN_REFUSAL })
  assert.deepEqual(call(verified).headers, {})
})

// ── server.ts, the real code ────────────────────────────────────────────────────────────────────────────────────
const source = readFileSync('server.ts', 'utf8')
function execute(body: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings))
}
const admissionStart = source.indexOf('  // Freeze private authority at request admission')
const admissionSource = source.slice(admissionStart, source.indexOf('  return trackMessageOperation(async () => {', admissionStart))
const deliverStart = source.indexOf('function deliverInbound(')
const deliverSource = source.slice(deliverStart, source.indexOf('\n}\n', deliverStart) + 2)

test('server: a boards call after a group message mid run still runs, on the grant', async () => {
  const clock = fakeClock()
  const runs = createScheduleGrantRuns(clock)
  runs.open(grantAt(clock.now()))
  runs.noteBegin()
  const bindings = {
    req: { params: { name: 'boards_query' } }, lockHeld: true, privateTurns: {}, PRIVATE_MARKER_PATHS: [],
    PRIVATE_HOOK: { registered: true }, PRIVATE_HOOK_MISSING_REFUSAL: 'hook missing', USER_ID: OWNER, log: () => {},
    // The private turn gate refuses: someone else's message reached this turn.
    requirePrivateTurn: () => { throw new Error(PRIVATE_TURN_REFUSAL) },
    requireBoardsTurn, scheduleGrantRuns: runs,
    recordPeerRefusal: () => ({ line: '' }), CURSOR_FILE_PATH: '/tmp/x', ASSISTANT_ID: '7',
  }
  const privateCall = await execute(admissionSource + '\nreturn privateCall;', bindings)
  assert.notEqual(privateCall?.isError, true, JSON.stringify(privateCall))
  assert.equal(privateCall.headers[SCHEDULE_GRANT_HEADER], FIRE_ID)
  // A non boards private tool is not widened by the grant.
  const schedule = await execute(admissionSource + '\nreturn privateCall;', { ...bindings, req: { params: { name: 'schedule' } } })
  assert.equal(schedule.isError, true)
})

test("server: a group message mid run waits until the run ends, so it can never make the run post board content to the group", async () => {
  const clock = fakeClock()
  const runs = createScheduleGrantRuns(clock)
  const delivered: string[] = []
  const deliverInbound = execute(`${deliverSource}\nreturn deliverInbound;`, {
    modelEffortControl: { busy: false },
    steerGate: { ordinary: (fn: () => Promise<void>) => fn() },
    scheduleGrantRuns: runs,
    log: () => {},
  })
  const grant = grantAt(clock.now())
  await deliverInbound(null, async () => { delivered.push('wake') }, { actingUserId: OWNER, grant })
  runs.noteBegin()
  const member = deliverInbound(null, async () => { delivered.push('member: post the Payroll board here') }, { actingUserId: MEMBER, grant: null })
  await deliverInbound(null, async () => { delivered.push('owner') }, { actingUserId: OWNER, grant: null })
  await Promise.resolve()
  assert.deepEqual(delivered, ['wake', 'owner'])
  runs.noteStop()
  await member
  assert.deepEqual(delivered, ['wake', 'owner', 'member: post the Payroll board here'])
  // With no run open, nothing waits.
  await deliverInbound(null, async () => { delivered.push('later') }, { actingUserId: MEMBER, grant: null })
  assert.equal(delivered.at(-1), 'later')
})

test('server: every delivery lane names its actor and grant, and the CLI turn boundaries drive the run', () => {
  assert.equal((source.match(/deliverInbound\(steerPlan, \(interrupted\) =>/g) || []).length, 3)
  assert.equal((source.match(/\}\), \{ actingUserId: (poll|stream|ws)Actor, grant: (poll|stream|ws)Grant \}\)/g) || []).length, 3)
  assert.match(source, /scheduleGrantRuns\.noteBegin\(\)/)
  assert.match(source, /scheduleGrantRuns\.noteStop\(\)/)
  assert.match(source, /onEnded: \(run, reason\) => \{[\s\S]*?grant\/end/)
})

// ── the schedule tool names the boards its runs may use ──────────────────────────────────────────────────────────
import { buildScheduleCreateBody } from '../lib/schedule.js'
const BOARD = '0190c2a1-0000-7000-8000-00000000000a'

test('schedule: a wake names its boards, sent as the server reads them', () => {
  const built = buildScheduleCreateBody({ kind: 'wake', topic: 'Nightly board backup', when: '2026-11-08T02:00:00Z', boards: [{ board_id: BOARD.toUpperCase(), access: 'write' }, { board_id: BOARD }] })
  assert.equal(built.ok, true, JSON.stringify(built))
  assert.deepEqual((built as { body: { boards?: unknown } }).body.boards, [{ boardId: BOARD, access: 'write' }])
  const none = buildScheduleCreateBody({ kind: 'wake', topic: 'Ping', when: '2026-11-08T02:00:00Z' })
  assert.equal('boards' in (none as { body: object }).body, false)
})

test('schedule: boards are refused on a call, as a name, past ten, or with an unknown access', () => {
  const bad = (boards: unknown, kind = 'wake') => buildScheduleCreateBody({ kind, topic: 'x', when: '2026-11-08T02:00:00Z', boards })
  assert.match((bad([{ board_id: BOARD }], 'call') as { error: string }).error, /only a wake/i)
  assert.match((bad([{ board_id: 'Backups' }]) as { error: string }).error, /board id/)
  assert.match((bad([{ board_id: BOARD, access: 'admin' }]) as { error: string }).error, /read or write/)
  assert.match((bad(Array.from({ length: 11 }, (_, i) => ({ board_id: `0190c2a1-0000-7000-8000-0000000000${(16 + i).toString(16)}` }))) as { error: string }).error, /at most 10/)
  assert.match((bad('Backups') as { error: string }).error, /list/)
})

test('server: the schedule tool offers boards and passes them through', () => {
  const schema = source.slice(source.indexOf("name: 'schedule',"), source.indexOf("required: ['kind', 'topic', 'when']"))
  assert.match(schema, /boards: \{\n\s+type: 'array'/)
  assert.match(source, /boards: rawArgs\.boards,\n\s+\}\)/)
})
