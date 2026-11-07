import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import {
  BEGIN_WITHIN_MS,
  SCHEDULE_GRANT_HEADER,
  SCHEDULE_GRANT_MAX_MS,
  createScheduleGrantRuns,
  holdChannelCardsDuringGrantedRun,
  requireBoardsTurn,
  scheduleGrantOf,
} from '../lib/schedule-grant-run.mjs'
import { PRIVATE_TURN_REFUSAL } from '../lib/private-turn.mjs'
import { holdChannelCardsWhileBusy } from '../lib/model-effort-control.ts'
import { buildScheduleCreateBody } from '../lib/schedule.js'

// A scheduled run keeps the permission of the person who scheduled it (0.86.20, round 3): one choke point holds every
// channel card while a granted run is live, the run begins only on the wake's own prompt, and a boards call never runs
// on the grant alone. Unit tests of the run and the choke point, then the real server.ts wiring.

const OWNER = 'user_owner'
const MEMBER = 'user_member'
const FIRED = Date.parse('2026-11-07T02:00:00.000Z')
const fireIdOf = (task: number, at = FIRED) => `scheduled-wake:${task}:${new Date(at).toISOString()}`
const wakeMeta = (task = 41, over: Record<string, unknown> = {}) => ({
  source: 'scheduler',
  payload: {
    scheduledTaskId: task,
    fireId: fireIdOf(task),
    actingUserId: OWNER,
    boardGrant: { boards: 1, expiresAt: new Date(FIRED + SCHEDULE_GRANT_MAX_MS).toISOString() },
    ...over,
  },
})
const grantAt = (now: number, meta: Record<string, unknown> = wakeMeta(), actingUserId = OWNER) =>
  scheduleGrantOf({ senderType: 'system', eventMeta: meta, actingUserId, chatId: 900, now })
const TOKEN = '11111111-2222-4333-8444-555555555555'
const OTHER_TOKEN = '99999999-2222-4333-8444-555555555555'
const tag = (id: string) => `<hoai-private-turn id="${id}"/>`

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
const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() }

/** A run store and the choke point over a recording sender. */
function rig() {
  const clock = fakeClock()
  const ended: string[] = []
  const runs = createScheduleGrantRuns({ ...clock, onEnded: (_run: unknown, reason: string) => { ended.push(reason) } })
  const sent: string[] = []
  const notify = holdChannelCardsDuringGrantedRun(runs, async (n: { params: { content: string } }) => { sent.push(n.params.content) })
  const card = (content: string, scheduleGrant?: unknown, built?: string[]) => ({
    method: 'notifications/claude/channel',
    params: () => { built?.push(content); return { content, meta: {} } },
    ...(scheduleGrant ? { scheduleGrant } : {}),
  })
  return { clock, runs, sent, ended, notify, card }
}

test('a granted wake carries a grant; anything else does not', () => {
  const g = grantAt(FIRED + 1000)
  assert.ok(g)
  assert.equal(g!.taskId, 41)
  assert.equal(g!.fireId, fireIdOf(41))
  assert.equal(grantAt(FIRED, wakeMeta(41, { boardGrant: undefined })), null)
  assert.equal(grantAt(FIRED, { ...wakeMeta(), status: 'could_not_start' }), null)
  assert.equal(grantAt(FIRED, wakeMeta(41, { kind: 'routine_created' })), null)
  assert.equal(grantAt(FIRED, wakeMeta(41, { fireId: fireIdOf(42) })), null)
  assert.equal(scheduleGrantOf({ senderType: 'user', eventMeta: wakeMeta(), actingUserId: OWNER, chatId: 1, now: FIRED }), null)
  assert.equal(scheduleGrantOf({ senderType: 'system', eventMeta: wakeMeta(), actingUserId: null, chatId: 1, now: FIRED }), null)
})

test('a payload never makes the window longer than twenty minutes after the fire, and an ended window grants nothing', () => {
  // Round 4 (Data's rule 3): the run is capped at twenty minutes, on the server's clock and here.
  assert.equal(SCHEDULE_GRANT_MAX_MS, 20 * 60 * 1000)
  const long = grantAt(FIRED, wakeMeta(41, { boardGrant: { boards: 1, expiresAt: new Date(FIRED + 10 * SCHEDULE_GRANT_MAX_MS).toISOString() } }))
  assert.equal(long!.expiresAtMs, FIRED + SCHEDULE_GRANT_MAX_MS)
  assert.equal(grantAt(FIRED + SCHEDULE_GRANT_MAX_MS), null)
})

// The lib hold: while the run is live any card waits and is not even BUILT (so the private turn tracker never sees it
// and cannot revoke the run's turn). It goes out once the run's turn ends. The real lanes of server.ts are driven
// under a live run in test/external-email-label.test.ts and test/message-edits.test.ts (round 4, F4).
test('hold: a card mid run waits, unbuilt, until the run\'s turn ends', async () => {
  const { runs, sent, notify, card, clock } = rig()
  await notify(card(`wake ${tag(TOKEN)}`, grantAt(clock.now())))
  runs.noteBegin(`the wake ${tag(TOKEN)}`)
  const built: string[] = []
  const held = notify(card('a group member\'s message', undefined, built))
  await flush()
  assert.deepEqual(built, [], 'not built while held')
  assert.deepEqual(sent, [`wake ${tag(TOKEN)}`])
  runs.noteStop()
  await held
  assert.deepEqual(built, ['a group member\'s message'])
  assert.deepEqual(sent, [`wake ${tag(TOKEN)}`, 'a group member\'s message'])
})

test('F2: a card released at the run\'s end goes through the model and effort lock again, stamped when it really goes out', async () => {
  const clock = fakeClock()
  const runs = createScheduleGrantRuns(clock)
  const sent: string[] = []
  const stamps: string[] = []
  let busy = false
  let idle: () => void = () => {}
  const lock = { get busy() { return busy }, whenIdle: () => new Promise<void>((resolve) => { idle = resolve }) }
  // The production order: the grant hold inside, the lock outermost, and a release resends through the whole chain.
  let chain: (n: any) => Promise<unknown> = async () => undefined
  const inner = holdChannelCardsDuringGrantedRun(runs, async (n: { params: { content: string } }) => { sent.push(n.params.content) }, { resend: (n: unknown) => chain(n) })
  chain = holdChannelCardsWhileBusy(lock, inner, () => { stamps.push(`stamp ${sent.length}`) })
  const card = (content: string, scheduleGrant?: unknown) => ({ method: 'notifications/claude/channel', params: () => ({ content }), ...(scheduleGrant ? { scheduleGrant } : {}) })
  await chain(card(`wake ${tag(TOKEN)}`, grantAt(clock.now())))
  runs.noteBegin(tag(TOKEN))
  const held = chain(card('a group member\'s message'))
  await flush()
  stamps.length = 0
  // The owner opens the model picker just as the run ends: the released card must wait for the lock.
  busy = true
  runs.noteStop()
  await flush()
  assert.deepEqual(sent, [`wake ${tag(TOKEN)}`], 'a released card never goes out while the lock is busy')
  busy = false
  idle()
  await held
  assert.deepEqual(sent, [`wake ${tag(TOKEN)}`, 'a group member\'s message'])
  assert.deepEqual(stamps, ['stamp 1'], 'the lock stamped the card when it really went out, after the release')
})

test('F5: a newer granted wake held behind other cards is released first, alone, and the rest wait for its run', async () => {
  const { runs, sent, notify, card, clock } = rig()
  await notify(card(`first ${tag(TOKEN)}`, grantAt(clock.now(), wakeMeta(41))))
  runs.noteBegin(tag(TOKEN))
  const message = notify(card('a group member\'s message'))
  const wake = notify(card(`second ${tag(OTHER_TOKEN)}`, grantAt(clock.now(), wakeMeta(42))))
  await flush()
  runs.noteStop()
  await wake
  await flush()
  assert.deepEqual(sent, [`first ${tag(TOKEN)}`, `second ${tag(OTHER_TOKEN)}`], 'the newer wake goes out first and alone')
  assert.equal(runs.live()!.taskId, 42)
  runs.noteBegin(tag(OTHER_TOKEN))
  runs.noteStop()
  await message
  assert.deepEqual(sent.at(-1), 'a group member\'s message')
})

test('a newer granted wake never supersedes a live run: it waits, then opens its own run', async () => {
  const { runs, sent, notify, card, clock, ended } = rig()
  await notify(card(`first ${tag(TOKEN)}`, grantAt(clock.now(), wakeMeta(41))))
  runs.noteBegin(tag(TOKEN))
  const queued = notify(card(`second ${tag(OTHER_TOKEN)}`, grantAt(clock.now(), wakeMeta(42), MEMBER)))
  await flush()
  assert.deepEqual(sent, [`first ${tag(TOKEN)}`])
  assert.equal(runs.live()!.taskId, 41)
  // Asked directly, the store refuses to open a second run over a live one.
  assert.equal(runs.open(grantAt(clock.now(), wakeMeta(44), MEMBER)), false)
  assert.equal(runs.live()!.taskId, 41)
  runs.noteStop()
  await queued
  assert.deepEqual(ended, ['turn ended'])
  assert.equal(runs.live()!.taskId, 42)
  assert.equal(runs.live()!.actingUserId, MEMBER)
})

test('the run begins only on the prompt that is the wake alone', async () => {
  const { runs, notify, card, clock, ended } = rig()
  await notify(card(`wake ${tag(TOKEN)}`, grantAt(clock.now())))
  runs.noteBegin(`an earlier queued message ${tag(OTHER_TOKEN)}`)
  assert.equal(runs.live()!.begun, false)
  runs.noteBegin(`two at once ${tag(OTHER_TOKEN)} ${tag(TOKEN)}`)
  assert.equal(runs.live()!.begun, false)
  // That earlier turn's Stop does not end the run.
  runs.noteStop()
  assert.equal(runs.live()!.ended, false)
  runs.noteBegin(`the wake ${tag(TOKEN)}`)
  assert.equal(runs.live()!.begun, true)
  runs.noteStop()
  assert.deepEqual(ended, ['turn ended'])
})

test('a run whose turn never begins ends, and what waited goes out (the agent never goes deaf)', async () => {
  const { notify, card, clock, ended, sent } = rig()
  await notify(card(`wake ${tag(TOKEN)}`, grantAt(clock.now())))
  void notify(card('later'))
  clock.advance(BEGIN_WITHIN_MS)
  await flush()
  assert.deepEqual(ended, ['never began'])
  assert.equal(sent.at(-1), 'later')
})

test('a wake that could not be handed over opens no run', async () => {
  const { runs, notify, clock, ended } = rig()
  await notify({ method: 'notifications/claude/channel', params: () => null, scheduleGrant: grantAt(clock.now()) })
  assert.equal(runs.live(), null)
  assert.deepEqual(ended, ['not delivered'])
  const failing = holdChannelCardsDuringGrantedRun(runs, async () => { throw new Error('pipe closed') })
  await assert.rejects(failing({ method: 'notifications/claude/channel', params: () => ({ content: tag(TOKEN) }), scheduleGrant: grantAt(clock.now(), wakeMeta(43)) }))
  assert.equal(runs.live(), null)
})

test('the window running out ends the run and releases what waited; the same fire never reopens', async () => {
  const { runs, sent, notify, card, clock, ended } = rig()
  const grant = grantAt(clock.now())
  await notify(card(`wake ${tag(TOKEN)}`, grant))
  runs.noteBegin(tag(TOKEN))
  const held = notify(card('later'))
  clock.advance(SCHEDULE_GRANT_MAX_MS)
  await held
  assert.deepEqual(ended, ['expired'])
  assert.equal(sent.at(-1), 'later')
  assert.equal(runs.open(grant), false)
})

test('boards: the grant rides only the scheduler\'s verified turn of the wake; a refused turn stays refused', async () => {
  const { runs, notify, card, clock } = rig()
  const verified = () => ({ actingUserId: OWNER, chatId: '900', headers: {} })
  const revoked = () => { throw new Error(PRIVATE_TURN_REFUSAL) }
  const call = (requirePrivateTurn: () => unknown) =>
    requireBoardsTurn({ requirePrivateTurn: requirePrivateTurn as never, tracker: {}, markerPaths: [], ownerUserId: OWNER, runs })
  await notify(card(`wake ${tag(TOKEN)}`, grantAt(clock.now())))
  // Before the wake's own turn begins, the owner's earlier turn keeps its full reach: no grant.
  assert.deepEqual(call(verified).headers, {})
  runs.noteBegin(tag(TOKEN))
  assert.deepEqual(call(verified).headers, { [SCHEDULE_GRANT_HEADER]: fireIdOf(41) })
  // No admission on the grant alone: a refused turn is refused, run or no run.
  assert.throws(() => call(revoked), { message: PRIVATE_TURN_REFUSAL })
  // Another person's verified turn never carries this run's grant.
  assert.deepEqual(call(() => ({ actingUserId: MEMBER, chatId: '900', headers: { 'X-BGOS-Acting-User': MEMBER } })).headers, { 'X-BGOS-Acting-User': MEMBER })
  runs.noteStop()
  assert.deepEqual(call(verified).headers, {})
})

// ── the schedule tool names the boards its runs may use ──────────────────────────────────────────────────────────
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

// ── server.ts, the real code ────────────────────────────────────────────────────────────────────────────────────
const source = readFileSync('server.ts', 'utf8')
function execute(body: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings))
}
const admissionStart = source.indexOf('  // Freeze private authority at request admission')
const admissionSource = source.slice(admissionStart, source.indexOf('  return trackMessageOperation(async () => {', admissionStart))

test('server: a boards call in the wake\'s turn carries the grant, and a refused turn is refused', async () => {
  const { runs, notify, card, clock } = rig()
  await notify(card(`wake ${tag(TOKEN)}`, grantAt(clock.now())))
  runs.noteBegin(tag(TOKEN))
  const bindings = {
    req: { params: { name: 'boards_query' } }, lockHeld: true, privateTurns: {}, PRIVATE_MARKER_PATHS: [],
    PRIVATE_HOOK: { registered: true }, PRIVATE_HOOK_MISSING_REFUSAL: 'hook missing', USER_ID: OWNER, log: () => {},
    requirePrivateTurn: () => ({ actingUserId: OWNER, chatId: '900', headers: {} }),
    requireBoardsTurn, scheduleGrantRuns: runs,
    recordPeerRefusal: () => ({ line: '' }), CURSOR_FILE_PATH: '/tmp/x', ASSISTANT_ID: '7',
  }
  const privateCall = await execute(admissionSource + '\nreturn privateCall;', bindings)
  assert.equal(privateCall.headers[SCHEDULE_GRANT_HEADER], fireIdOf(41))
  const refused = await execute(admissionSource + '\nreturn privateCall;', { ...bindings, requirePrivateTurn: () => { throw new Error(PRIVATE_TURN_REFUSAL) } })
  assert.equal(refused.isError, true)
  // A non boards private tool never carries the grant.
  const schedule = await execute(admissionSource + '\nreturn privateCall;', { ...bindings, req: { params: { name: 'schedule' } } })
  assert.equal(schedule.headers[SCHEDULE_GRANT_HEADER], undefined)
})

test('server: every channel card goes through the one choke point, built when sent', () => {
  // GUARD: the method is spelled once, in channelNotify. A new card that calls mcp.notification with it directly
  // bypasses the hold and fails here.
  const spelled = source.match(/method: 'notifications\/claude\/channel'/g) ?? []
  assert.equal(spelled.length, 1, 'notifications/claude/channel is sent only through channelNotify')
  // channelNotify hands the builder itself to the chain, never a built card.
  assert.match(source, /method: 'notifications\/claude\/channel',\n\s*params: build,/)
  // Every card is a builder, and the tracker is reached only inside one.
  assert.ok((source.match(/channelNotify\(\(\) =>/g) ?? []).length >= 29)
  // The meeting lines and the invitation record their untracked tag inside their builder, never before the send.
  assert.doesNotMatch(source, /noteUntracked\(\{ chatId \}\)\n\s*const meetingHandoff/)
  assert.equal((source.match(/channelNotify\(\(\) => \{\n(?:\s*\/\/[^\n]*\n)?\s*card\.content \+= privateTurns\.noteUntracked/g) ?? []).length, 3)
  assert.match(source, /channelNotify\(\(\) => \{\n(?:\s*\/\/[^\n]*\n)?\s*const untracked = privateTurns\.noteUntracked/)
  // The chain: the grant hold sits outside the raw card record and inside the model and effort lock.
  const chain = source.slice(source.indexOf('const sendMcpNotification = mcp.notification.bind(mcp)'), source.indexOf('function publishBrowserPrivateTurn'))
  const rawAt = chain.indexOf('privateTurns.rawCard(')
  const holdAt = chain.indexOf('holdChannelCardsDuringGrantedRun(scheduleGrantRuns,')
  const effortAt = chain.indexOf('holdChannelCardsWhileBusy(modelEffortControl,')
  assert.ok(rawAt > 0 && holdAt > rawAt && effortAt > holdAt, 'raw card < grant hold < effort lock')
  // A released card goes back through the whole chain (F2).
  assert.match(chain, /resend: \(notification: [^)]*\) => mcp\.notification\(notification\)/)
})

test('server: the real channelNotify hands a granted wake\'s grant to the hold, so the wake opens its run (F4 A)', async () => {
  const { runs } = rig()
  const fn = source.slice(source.indexOf('function channelNotify('), source.indexOf('\n}\n', source.indexOf('function channelNotify(')) + 3)
  const sent: string[] = []
  const mcp = { notification: holdChannelCardsDuringGrantedRun(runs, async (n: { params: { content: string } }) => { sent.push(n.params.content) }) }
  const channelNotify = execute(fn + '\nreturn channelNotify;', { mcp })
  const grant = grantAt(FIRED + 60_000)
  await channelNotify(() => ({ content: `wake ${tag(TOKEN)}` }), { scheduleGrant: grant })
  assert.equal(runs.live()?.fireId, grant!.fireId, 'the wake opened its run')
  assert.deepEqual(sent, [`wake ${tag(TOKEN)}`])
  const built: string[] = []
  const held = channelNotify(() => { built.push('member'); return { content: 'member' } })
  await flush()
  assert.deepEqual(built, [], 'a card sent through the real channelNotify waits unbuilt')
  runs.end('turn ended')
  await held
  assert.deepEqual(sent, [`wake ${tag(TOKEN)}`, 'member'])
})

test('server: every private turn tracker call of a card is inside that card\'s channelNotify builder (F4 B)', () => {
  // A deliver or noteUntracked made before the card is handed to channelNotify runs while the card waits, and a held
  // card would then revoke the run's turn. Read from the syntax tree, whatever the formatting.
  const file = ts.createSourceFile('server.ts', source, ts.ScriptTarget.ES2022, true)
  const sites: string[] = []
  const outside: string[] = []
  const insideBuilder = (node: ts.Node): boolean => {
    for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
      if (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) {
        const call: ts.Node | undefined = at.parent
        if (call && ts.isCallExpression(call) && call.arguments[0] === at && ts.isIdentifier(call.expression) && call.expression.text === 'channelNotify') return true
      }
      if (ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) return false
    }
    return false
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'privateTurns' && ['deliver', 'noteUntracked'].includes(node.expression.name.text)) {
      const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1
      sites.push(String(line))
      if (!insideBuilder(node)) outside.push(`server.ts:${line} ${node.expression.name.text}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(sites.length >= 10, `found ${sites.length} tracker calls`)
  assert.deepEqual(outside, [], 'every tracker call of a card runs inside its builder')
})

test('server: the three message lanes name the wake\'s grant, and the CLI turn boundaries drive the run', () => {
  assert.equal((source.match(/scheduleGrant: (poll|stream|ws)Grant/g) ?? []).length, 3)
  assert.match(source, /scheduleGrantRuns\.noteBegin\(payload\.prompt\)/)
  assert.match(source, /scheduleGrantRuns\.noteStop\(\)/)
  assert.match(source, /if \(event\.name === 'SessionEnd'\) scheduleGrantRuns\.end\('session ended'\)/)
  assert.match(source, /onEnded: \(run, reason\) => \{[\s\S]*?grant\/end/)
})

test('server: the schedule tool offers boards and passes them through', () => {
  const schema = source.slice(source.indexOf("name: 'schedule',"), source.indexOf("required: ['kind', 'topic', 'when']"))
  assert.match(schema, /boards: \{\n\s+type: 'array'/)
  assert.match(source, /boards: rawArgs\.boards,\n\s+\}\)/)
})
