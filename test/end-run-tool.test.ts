/**
 * end_run: the agent ends one run of its routine without posting (When a routine runs, 2026-11-22).
 *
 * Why. A routine set to message only when something changes wakes the agent with a hint in its event payload
 * (quietEnd). The app's run end door (POST scheduled-tasks/agent/:id/run-end) takes no_change (post nothing) or
 * could_not_check (the owner gets a Could not check card with the reason). A Claude Code agent had no way to call it:
 * the hint named a raw HTTP call with a credential the model does not hold. So a quiet run on a Claude Code agent
 * always looked silent, and the server's sweep turned it into a red Could not check card. end_run is that call, made by
 * the daemon with its own credential and the X-Caller-Assistant-Id header.
 *
 * Three promises held here besides the wire shape:
 *   1. end_run is behind the daemon's private turn gate, as schedule and every other write tool are. A turn an email, a
 *      webhook or another agent's text opened (or reached) is refused with the private turn sentence and sends
 *      nothing, so the run stays open. The owner's routine wake is a private turn (its payload names the owner as
 *      acting user), so the wake's own turn ends its run, and a refused end leaves nothing behind that blocks the next
 *      private turn. On a share recipient's turn the post names that person, as schedule's does.
 *   2. could_not_check needs a reason: the owner reads it on the card. no_change needs none.
 *   3. Every answer reads as one plain sentence: ended, already ended, the server's own 409 sentence, and for a 404
 *      or a 400 a plain line that says to reply normally instead.
 *
 * Everything here runs against fakes: a fake post, never a real server.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

import { RUN_END_FIRE_ID_MAX, RUN_END_OUTCOMES, RUN_END_REASON_MAX, buildScheduleRunEndRequest } from '../lib/schedule.ts'
import {
  RUN_END_COULD_NOT_CHECK_TEXT,
  RUN_END_NOT_TAKEN_TEXT,
  RUN_END_NO_CHANGE_TEXT,
  RUN_END_UNREAD_TEXT,
  httpFailure,
  sendRunEnd,
} from '../lib/schedule-send.ts'
import { OWN_MCP_TOOLS } from '../lib/hook-events.ts'
import {
  PRIVATE_TOOL_MATCHER,
  PRIVATE_TURN_REFUSAL,
  RUN_END_TURN_REFUSAL,
  createPrivateTurnTracker,
  privateActor,
  privateFireKey,
  privateMarkerPath,
  requirePrivateTurn,
  turnAwarePrivateTurn,
} from '../lib/private-turn.mjs'
import { createScheduleGrantRuns, requireBoardsTurn } from '../lib/schedule-grant-run.mjs'
import { PRIVATE_TOOL_MATCHER as PRESEED_MATCHER } from '../lib/claude-preseed.mjs'
import { floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import { recordPrivateBoundary } from '../bin/hoai-private-turn-hook.mjs'
import { scratchDir } from './helpers/scratch-dirs'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const FIRE = 'scheduled-wake:41:2026-11-22T09:00:00.000Z'

/** The server's own 409 sentence for a run that must answer (the server's RUN_END_NOT_ALLOWED). */
const NOT_ALLOWED =
  'This run must answer: it is the first run of this routine, a run your owner asked for, or a routine set to message every run. Say what you found.'

function execute(body: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings))
}

const OWNER = 'user_owner'
const RECIPIENT = 'user_recipient'

const caseStart = server.indexOf("    case 'end_run': {")
const endRunCase = server.slice(caseStart, server.indexOf("    case 'create_mission': {", caseStart))

/** The real end_run case alone, on a turn the gate already admitted (the owner's, unless one is given). */
function runEndRunCase(
  rawArgs: Record<string, unknown>,
  post: (...args: unknown[]) => Promise<unknown>,
  privateCall: { actingUserId: string; chatId: string | null; headers: Record<string, string> } = { actingUserId: OWNER, chatId: null, headers: {} },
) {
  return execute(`return (async () => { switch(name) { ${endRunCase} } })();`, {
    name: 'end_run',
    rawArgs,
    privateCall,
    buildScheduleRunEndRequest,
    sendRunEnd,
    log: () => {},
    bgosPeerPost: post,
  }) as Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>
}

// ── the request builder ─────────────────────────────────────────────────────

test('end_run builds the run end path and the body the server takes', () => {
  assert.deepEqual([...RUN_END_OUTCOMES], ['no_change', 'could_not_check'])
  assert.equal(RUN_END_REASON_MAX, 300)
  assert.equal(RUN_END_FIRE_ID_MAX, 160)
  assert.deepEqual(buildScheduleRunEndRequest({ taskId: 41, fireId: FIRE, outcome: 'no_change' }), {
    ok: true,
    path: 'scheduled-tasks/agent/41/run-end',
    body: { fireId: FIRE, outcome: 'no_change' },
  })
  // The id as the model often copies it: a string, with spaces round it.
  assert.deepEqual(buildScheduleRunEndRequest({ taskId: ' 41 ', fireId: ` ${FIRE} `, outcome: 'could_not_check', reason: '  The site was down.  ' }), {
    ok: true,
    path: 'scheduled-tasks/agent/41/run-end',
    body: { fireId: FIRE, outcome: 'could_not_check', reason: 'The site was down.' },
  })
})

test('no_change needs no reason: a blank one is left out', () => {
  for (const reason of [undefined, null, '', '   ']) {
    const built = buildScheduleRunEndRequest({ taskId: 41, fireId: FIRE, outcome: 'no_change', reason })
    assert.equal(built.ok, true, String(reason))
    assert.equal('reason' in (built as { body: object }).body, false, `${JSON.stringify(reason)} sends no reason`)
  }
})

test('could_not_check without a reason is refused in one plain sentence, and nothing is sent', async () => {
  // The owner reads the reason on the Could not check card. Without one the card would say the agent gave no message
  // and no report, which is not true: the agent did report.
  for (const reason of [undefined, null, '', '   ', '\n\t']) {
    const built = buildScheduleRunEndRequest({ taskId: 41, fireId: FIRE, outcome: 'could_not_check', reason })
    assert.equal(built.ok, false, JSON.stringify(reason))
    assert.equal(
      (built as { error: string }).error,
      'reason is required for could_not_check: say in a few plain words why you could not do the check, and call end_run again.',
    )
  }
  let posted = 0
  const result = await runEndRunCase({ task_id: 41, fire_id: FIRE, outcome: 'could_not_check', reason: '  ' }, async () => { posted++; return { ended: true } })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /^Error: reason is required for could_not_check: /)
  assert.equal(posted, 0, 'nothing is sent')
})

test('a reason of 300 characters is kept, a longer one is refused in plain words', () => {
  const full = 'x'.repeat(300)
  const kept = buildScheduleRunEndRequest({ taskId: 41, fireId: FIRE, outcome: 'could_not_check', reason: full })
  assert.equal(kept.ok && kept.body.reason, full)
  const long = buildScheduleRunEndRequest({ taskId: 41, fireId: FIRE, outcome: 'could_not_check', reason: 'x'.repeat(301) })
  assert.equal(long.ok, false)
  assert.match((long as { error: string }).error, /reason is too long \(301 characters, at most 300\)/)
  const notText = buildScheduleRunEndRequest({ taskId: 41, fireId: FIRE, outcome: 'could_not_check', reason: 7 })
  assert.equal(notText.ok, false)
})

test('an outcome other than no_change or could_not_check is refused, the server only one included', () => {
  for (const outcome of ['no_answer', 'done', 'NO_CHANGE', '', undefined, null, 1]) {
    const built = buildScheduleRunEndRequest({ taskId: 41, fireId: FIRE, outcome })
    assert.equal(built.ok, false, JSON.stringify(outcome))
    assert.match((built as { error: string }).error, /outcome must be no_change or could_not_check/)
  }
})

test('a task id that is not a whole number above 0 is refused before anything is sent', () => {
  for (const taskId of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, '0', '041', 'abc', '4 1', '', null, undefined, {}]) {
    const built = buildScheduleRunEndRequest({ taskId, fireId: FIRE, outcome: 'no_change' })
    assert.equal(built.ok, false, JSON.stringify(taskId))
    assert.match((built as { error: string }).error, /task_id/)
  }
})

test('a missing, blank or over long fire id is refused, and so is one that names another routine', () => {
  for (const fireId of [undefined, null, '', '   ', 41, 'x'.repeat(161)]) {
    const built = buildScheduleRunEndRequest({ taskId: 41, fireId, outcome: 'no_change' })
    assert.equal(built.ok, false, JSON.stringify(fireId))
    assert.match((built as { error: string }).error, /fire_id/)
  }
  const other = buildScheduleRunEndRequest({ taskId: 41, fireId: 'scheduled-wake:42:2026-11-22T09:00:00.000Z', outcome: 'no_change' })
  assert.equal(other.ok, false)
  assert.match((other as { error: string }).error, /routine 42, not to task_id 41/)
  // A fire id in a shape this add-on does not read is the server's to judge.
  assert.equal(buildScheduleRunEndRequest({ taskId: 41, fireId: 'x'.repeat(160), outcome: 'no_change' }).ok, true)
})

// ── the answers, one plain sentence each ────────────────────────────────────

async function answerTo(post: (path: string, body: Record<string, unknown>) => Promise<unknown>, outcome: 'no_change' | 'could_not_check' = 'no_change') {
  const built = buildScheduleRunEndRequest({ taskId: 41, fireId: FIRE, outcome, reason: outcome === 'could_not_check' ? 'The site was down.' : undefined })
  assert.equal(built.ok, true)
  if (!built.ok) throw new Error('unreachable')
  return sendRunEnd({ path: built.path, body: built.body, post })
}

test('a taken run end says the run ended, and what the owner sees', async () => {
  const calls: Array<[string, Record<string, unknown>]> = []
  const quiet = await answerTo(async (path, body) => { calls.push([path, body]); return { ended: true, outcome: 'no_change' } })
  assert.deepEqual(quiet, { ok: true, text: RUN_END_NO_CHANGE_TEXT })
  assert.deepEqual(calls, [['scheduled-tasks/agent/41/run-end', { fireId: FIRE, outcome: 'no_change' }]])
  const red = await answerTo(async () => ({ ended: true, outcome: 'could_not_check' }), 'could_not_check')
  assert.deepEqual(red, { ok: true, text: RUN_END_COULD_NOT_CHECK_TEXT })
  assert.match(RUN_END_NO_CHANGE_TEXT, /Post nothing more for this run\./)
  assert.match(RUN_END_COULD_NOT_CHECK_TEXT, /Could not check card/)
})

test('a run already ended says so, with how it ended, and is not an error', async () => {
  assert.deepEqual(await answerTo(async () => ({ ended: false, outcome: 'no_change' })), {
    ok: true,
    text: 'This run was already ended (no change). Nothing more to do for it.',
  })
  // The server ends a run itself when it heard nothing (no answer, could not check): said in words, never a code.
  assert.deepEqual(await answerTo(async () => ({ ended: false, outcome: 'no_answer' })), {
    ok: true,
    text: 'This run was already ended (no answer). Nothing more to do for it.',
  })
  // A word this add-on does not know is left out, never printed as it came.
  assert.deepEqual(await answerTo(async () => ({ ended: false, outcome: 'constructor' })), {
    ok: true,
    text: 'This run was already ended. Nothing more to do for it.',
  })
})

test('a 409 relays the server sentence as it is', async () => {
  const refused = await answerTo(async () => { throw httpFailure('POST', 409, NOT_ALLOWED) })
  assert.deepEqual(refused, { ok: false, text: NOT_ALLOWED })
  const stale = await answerTo(async () => { throw httpFailure('POST', 409, 'That fire is no longer the latest run of this task.') })
  assert.deepEqual(stale, { ok: false, text: 'That fire is no longer the latest run of this task.' })
  // A 409 with no sentence still reads as one.
  const blank = await answerTo(async () => { throw httpFailure('POST', 409, '  ') })
  assert.deepEqual(blank, { ok: false, text: 'The run end did not go through (409). Reply normally instead.' })
})

test('a 404 says the server did not take it and to reply normally instead', async () => {
  for (const detail of ['Not Found', 'Scheduled task not found.', 'That run was not found.']) {
    assert.deepEqual(await answerTo(async () => { throw httpFailure('POST', 404, detail) }), { ok: false, text: RUN_END_NOT_TAKEN_TEXT })
  }
  assert.match(RUN_END_NOT_TAKEN_TEXT, /Reply normally instead\.$/)
})

test('a 400 names the server sentence and says to check the ids or reply normally', async () => {
  const bad = await answerTo(async () => { throw httpFailure('POST', 400, 'fireId is not valid for this task.') })
  assert.deepEqual(bad, {
    ok: false,
    text: "The server refused this run end: fireId is not valid for this task. Copy task_id and fire_id from the same wake's event payload, or reply normally instead.",
  })
  // A sentence with no full stop of its own gets one.
  const bare = await answerTo(async () => { throw httpFailure('POST', 400, 'Only a wake run can be ended this way') })
  assert.match((bare as { text: string }).text, /^The server refused this run end: Only a wake run can be ended this way\. Copy/)
})

test('no usable answer, or any other refusal, says to reply normally instead', async () => {
  assert.deepEqual(await answerTo(async () => { throw new Error('POST scheduled-tasks/agent/41/run-end timed out') }), { ok: false, text: RUN_END_UNREAD_TEXT })
  const failed = await answerTo(async () => { throw httpFailure('POST', 500, 'Internal server error') })
  assert.deepEqual(failed, { ok: false, text: 'The run end did not go through (500: Internal server error). Reply normally instead.' })
  const odd = await answerTo(async () => ({ hello: 'world' }))
  assert.equal(odd.ok, false)
  assert.match(odd.text, /Reply normally instead\.$/)
})

// ── the real handler, run against a fake post ───────────────────────────────

test('the real end_run case posts the run end through the daemon\'s peer post, with the admitted turn\'s headers', async () => {
  assert.ok(caseStart > 0, 'server.ts has a case for end_run')
  const calls: unknown[][] = []
  const result = await runEndRunCase(
    { task_id: '41', fire_id: FIRE, outcome: 'could_not_check', reason: 'The site was down.' },
    async (...args) => { calls.push(args); return { ended: true, outcome: 'could_not_check' } },
  )
  assert.notEqual(result.isError, true, result.content[0].text)
  assert.equal(result.content[0].text, RUN_END_COULD_NOT_CHECK_TEXT)
  // As schedule posts: bgosPeerPost(path, body, the turn's headers). The owner's turn names nobody.
  assert.deepEqual(calls, [['scheduled-tasks/agent/41/run-end', { fireId: FIRE, outcome: 'could_not_check', reason: 'The site was down.' }, {}]])
  const recipient = { actingUserId: RECIPIENT, chatId: '200', headers: { 'X-BGOS-Acting-User': RECIPIENT } }
  const recipientCalls: unknown[][] = []
  await runEndRunCase({ task_id: 41, fire_id: FIRE, outcome: 'no_change' }, async (...args) => { recipientCalls.push(args); return { ended: true } }, recipient)
  assert.deepEqual(recipientCalls, [['scheduled-tasks/agent/41/run-end', { fireId: FIRE, outcome: 'no_change' }, { 'X-BGOS-Acting-User': RECIPIENT }]])
})

test('the real end_run case hands the agent the server sentence on a refusal, and posts nothing for bad ids', async () => {
  const refused = await runEndRunCase({ task_id: 41, fire_id: FIRE, outcome: 'no_change' }, async () => { throw httpFailure('POST', 409, NOT_ALLOWED) })
  assert.equal(refused.isError, true)
  assert.equal(refused.content[0].text, NOT_ALLOWED)
  let posted = 0
  const bad = await runEndRunCase({ task_id: 0, fire_id: FIRE, outcome: 'no_change' }, async () => { posted++; return {} })
  assert.equal(bad.isError, true)
  assert.match(bad.content[0].text, /^Error: task_id/)
  assert.equal(posted, 0)
})

// ── behind the private turn gate, like every other write tool ───────────────
//
// The real tracker, the real marker files and the real admission block of server.ts, then the real end_run case:
// what an injected turn can and cannot make the agent do.

const OWN_CHAT = '40'

interface TurnShape {
  senderType: string
  senderUserId?: string | null
  agentOrigin?: Record<string, unknown> | null
  eventMeta?: Record<string, unknown> | null
  messageId: number
  chatId: string
}

/** The routine's wake as the scheduler posts it: its payload names the person it acts for. */
const wakeTurn = (actingUserId = OWNER): TurnShape => ({
  senderType: 'system',
  eventMeta: { source: 'scheduler', title: 'Price check', payload: { scheduledTaskId: 41, fireId: FIRE, actingUserId, quietEnd: true } },
  messageId: 9050,
  chatId: OWN_CHAT,
})
const OWNER_MESSAGE: TurnShape = { senderType: 'user', senderUserId: OWNER, messageId: 9070, chatId: OWN_CHAT }
/** Turns that are not private: nobody this agent acts for sent them. */
const PUBLIC_TURNS: Record<string, TurnShape> = {
  email: { senderType: 'external_email', senderUserId: null, messageId: 9060, chatId: '41' },
  webhook: { senderType: 'system', eventMeta: { source: 'webhook', title: 'Inbound webhook' }, messageId: 9061, chatId: OWN_CHAT },
  peer: { senderType: 'agent', agentOrigin: { sourceAssistantId: 901 }, messageId: 9062, chatId: OWN_CHAT },
}

function turnFixture(t: { after: (fn: () => void) => void }) {
  const root = scratchDir('hoai-end-run-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'agent')
  mkdirSync(cwd)
  const env = { ...process.env, BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: cwd }
  markFloorAttached({ root, folders: [cwd] })
  const markerPaths = [privateMarkerPath(root, floorKey(cwd))]
  // The tracker as server.ts builds it: told the owner and the markers to read.
  const tracker = createPrivateTurnTracker({ ownerUserId: OWNER, markerPaths })
  /** Deliver one card exactly as the lanes do. Returns the prompt that carries it. */
  const deliver = (turn: TurnShape) =>
    tracker.deliver({
      content: `turn text for message ${turn.messageId}`,
      chatId: turn.chatId,
      peerSourceAssistantId: (turn.agentOrigin?.sourceAssistantId as number | undefined) ?? null,
      fireKey: privateFireKey({ senderType: turn.senderType, eventMeta: turn.eventMeta ?? null, messageId: turn.messageId }),
      actingUserId: privateActor({ senderType: turn.senderType, senderUserId: turn.senderUserId ?? null, agentOrigin: turn.agentOrigin ?? null, eventMeta: turn.eventMeta ?? null }),
    } as never) as string
  /** The prompt that carries `prompt` starts a CLI turn (the private turn hook, then the tracker, as live). */
  const begin = (prompt: string, session = 'session-a') => {
    recordPrivateBoundary({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd, prompt }, env)
    tracker.begin({ prompt, sessionId: session })
  }
  const start = (turn: TurnShape) => {
    const prompt = deliver(turn)
    begin(prompt)
    return prompt
  }
  /** The CLI ends the turn: the hook closes the marker, then the Stop reaches the tracker. */
  const stop = (session = 'session-a') => {
    recordPrivateBoundary({ hook_event_name: 'Stop', session_id: session, cwd }, env)
    tracker.end()
  }
  return { markerPaths, tracker, deliver, begin, start, stop }
}

const gateStart = server.indexOf('  // Freeze private authority at request admission')
const gateSource = server.slice(gateStart, server.indexOf('  return trackMessageOperation(async () => {', gateStart))

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean }

/**
 * One end_run call as the daemon takes it: the real admission block, and when it admits the call, the real end_run
 * case. Every post the case makes is recorded with its headers.
 */
async function callThroughGate(
  f: ReturnType<typeof turnFixture>,
  name: string,
  rawArgs: Record<string, unknown>,
  { lockHeld = true, hookRegistered = true }: { lockHeld?: boolean; hookRegistered?: boolean } = {},
) {
  assert.ok(gateStart > 0, 'the admission block moved')
  const posts: unknown[][] = []
  const result = (await execute(
    `${gateSource}\nreturn (async () => { switch (req.params.name) { ${endRunCase} } return { content: [{ type: 'text', text: 'admitted' }] } })();`,
    {
      req: { params: { name, arguments: rawArgs } },
      rawArgs,
      lockHeld,
      privateTurns: f.tracker,
      PRIVATE_MARKER_PATHS: f.markerPaths,
      PRIVATE_HOOK: { registered: hookRegistered },
      PRIVATE_HOOK_MISSING_REFUSAL: 'hook missing',
      RUN_END_TURN_REFUSAL,
      USER_ID: OWNER,
      requirePrivateTurn,
      turnAwarePrivateTurn,
      requireBoardsTurn,
      scheduleGrantRuns: createScheduleGrantRuns(),
      recordPeerRefusal: () => ({ line: 'peer private call refused' }),
      pathDirname: () => '/state/12',
      CURSOR_FILE_PATH: '/state/12/cursor.json',
      ASSISTANT_ID: 12,
      log: () => {},
      buildScheduleRunEndRequest,
      sendRunEnd,
      bgosPeerPost: async (...args: unknown[]) => { posts.push(args); return { ended: true, outcome: (args[1] as { outcome: string }).outcome } },
    },
  )) as ToolResult
  return { result, posts }
}

const END_ARGS = { task_id: 41, fire_id: FIRE, outcome: 'could_not_check', reason: 'Your sign in expired, verify at the link.' }

test('a turn an email, a webhook or another agent opened calls end_run: refused like schedule, and nothing is sent', async (t) => {
  for (const [kind, turn] of Object.entries(PUBLIC_TURNS)) {
    const f = turnFixture(t)
    f.start(turn)
    const ended = await callThroughGate(f, 'end_run', END_ARGS)
    assert.equal(ended.result.isError, true, `${kind}: refused`)
    assert.equal(ended.result.content[0].text, RUN_END_TURN_REFUSAL, `${kind}: told to reply normally`)
    assert.deepEqual(ended.posts, [], `${kind}: no request, so the run stays open`)
    // One gate: schedule is refused in the same turn, in its own words for a person.
    const scheduled = await callThroughGate(f, 'schedule', { kind: 'wake', topic: 'x', when: { everyHours: 2 } })
    assert.equal(scheduled.result.isError, true, `${kind}: schedule is refused too`)
    assert.equal(scheduled.result.content[0].text, PRIVATE_TURN_REFUSAL, `${kind}: schedule keeps its sentence`)
  }
})

test('with no active connection, or no private turn hook, end_run is refused as schedule is, and nothing is sent', async (t) => {
  // A daemon without the active connection refuses even the owner's wake; with no hook registered, a turn that could
  // not be verified is refused too. Both refused as schedule is; only end_run's words differ.
  const wake = turnFixture(t)
  wake.start(wakeTurn())
  const unverified = turnFixture(t)
  unverified.start(PUBLIC_TURNS.email)
  for (const [f, shape, text] of [
    [wake, { lockHeld: false }, /does not hold the active agent connection/],
    [unverified, { hookRegistered: false }, /^hook missing$/],
  ] as const) {
    const ended = await callThroughGate(f, 'end_run', END_ARGS, shape)
    const scheduled = await callThroughGate(f, 'schedule', { kind: 'wake', topic: 'x', when: { everyHours: 2 } }, shape)
    assert.equal(ended.result.isError, true, JSON.stringify(shape))
    assert.equal(ended.result.content[0].text, RUN_END_TURN_REFUSAL, JSON.stringify(shape))
    assert.equal(scheduled.result.isError, true, JSON.stringify(shape))
    assert.match(scheduled.result.content[0].text, text, JSON.stringify(shape))
    assert.deepEqual(ended.posts, [], JSON.stringify(shape))
  }
})

test('an email injected into the owner\'s own turn closes it to end_run too, and nothing is sent', async (t) => {
  const f = turnFixture(t)
  f.start(OWNER_MESSAGE)
  // The CLI can inject a card mid turn with no new prompt: the turn is no longer the owner's alone.
  f.deliver(PUBLIC_TURNS.email)
  const ended = await callThroughGate(f, 'end_run', { task_id: 41, fire_id: FIRE, outcome: 'no_change' })
  assert.equal(ended.result.isError, true)
  assert.equal(ended.result.content[0].text, RUN_END_TURN_REFUSAL)
  assert.deepEqual(ended.posts, [])
})

test('a card landing in a quiet wake: end_run is still refused, and its words send the agent to a normal reply, never to a person', async (t) => {
  const f = turnFixture(t)
  f.start(wakeTurn())
  f.deliver(PUBLIC_TURNS.email)
  const ended = await callThroughGate(f, 'end_run', { task_id: 41, fire_id: FIRE, outcome: 'no_change' })
  assert.equal(ended.result.isError, true)
  assert.deepEqual(ended.posts, [], 'the gate holds: no request, the run stays open')
  const words = ended.result.content[0].text
  assert.match(words, /Reply normally instead\.$/)
  assert.match(words, /do not repeat it/)
  assert.doesNotMatch(words, /send a new message|try again|HOAI chat|restart|ask the|owner|sender/i)
})

test('the owner\'s routine wake is a private turn: end_run on the wake\'s own turn ends its run, as the owner', async (t) => {
  const f = turnFixture(t)
  f.start(wakeTurn())
  const ended = await callThroughGate(f, 'end_run', { task_id: 41, fire_id: FIRE, outcome: 'no_change' })
  assert.notEqual(ended.result.isError, true, ended.result.content[0].text)
  assert.equal(ended.result.content[0].text, RUN_END_NO_CHANGE_TEXT)
  // The owner's turn carries no acting user header, exactly as schedule posts on it.
  assert.deepEqual(ended.posts, [['scheduled-tasks/agent/41/run-end', { fireId: FIRE, outcome: 'no_change' }, {}]])
})

test('a wake that arrived while the turn was public is ended on the next private turn: nothing stale blocks it', async (t) => {
  for (const [kind, turn] of Object.entries(PUBLIC_TURNS)) {
    // The wake reaches the session while the public turn runs, and the agent tries to end it there: refused.
    const f = turnFixture(t)
    f.start(turn)
    const wakePrompt = f.deliver(wakeTurn())
    const early = await callThroughGate(f, 'end_run', END_ARGS)
    assert.equal(early.result.isError, true, `${kind}: refused in the public turn`)
    assert.deepEqual(early.posts, [], `${kind}: nothing sent in the public turn`)
    f.stop()
    // The CLI then runs the held wake as a turn of its own: private, so the same ids end the run, once.
    f.begin(wakePrompt)
    const later = await callThroughGate(f, 'end_run', END_ARGS)
    assert.notEqual(later.result.isError, true, `${kind}: ${later.result.content[0].text}`)
    assert.equal(later.result.content[0].text, RUN_END_COULD_NOT_CHECK_TEXT)
    assert.deepEqual(later.posts, [['scheduled-tasks/agent/41/run-end', { fireId: FIRE, outcome: 'could_not_check', reason: END_ARGS.reason }, {}]])
  }
  // Or the owner's own next message is the next private turn: it ends the run just the same.
  const f = turnFixture(t)
  f.start(PUBLIC_TURNS.email)
  f.deliver(wakeTurn())
  assert.equal((await callThroughGate(f, 'end_run', END_ARGS)).result.isError, true)
  f.stop()
  f.start(OWNER_MESSAGE)
  const next = await callThroughGate(f, 'end_run', END_ARGS)
  assert.notEqual(next.result.isError, true, next.result.content[0].text)
  assert.equal(next.posts.length, 1)
})

test('on a share recipient\'s wake end_run names that person, as schedule does, so the server judges it for them', async (t) => {
  const f = turnFixture(t)
  f.start(wakeTurn(RECIPIENT))
  const ended = await callThroughGate(f, 'end_run', { task_id: 41, fire_id: FIRE, outcome: 'no_change' })
  assert.notEqual(ended.result.isError, true, ended.result.content[0].text)
  assert.deepEqual(ended.posts, [['scheduled-tasks/agent/41/run-end', { fireId: FIRE, outcome: 'no_change' }, { 'X-BGOS-Acting-User': RECIPIENT }]])
})

test('end_run is the channel\'s own tool, so it draws no tool row on the owner\'s card', () => {
  assert.ok((OWN_MCP_TOOLS as readonly string[]).includes('end_run'))
})

// ── what the model reads about the tool ─────────────────────────────────────

/** Every plain string literal of the tool's description, unescaped and joined, as the tool list sends it. */
function toolDescription(name: string): string {
  const at = server.indexOf(`      name: '${name}',\n      description:`)
  assert.ok(at >= 0, `the ${name} tool is declared inline`)
  const end = server.indexOf('inputSchema:', at)
  const literals = server.slice(at, end).match(/'(?:[^'\\]|\\.)*'/g) ?? []
  return literals.slice(1).map((l) => l.slice(1, -1).replace(/\\(.)/g, '$1')).join('')
}

test('the end_run tool says when to use each outcome, and never instead of a reply', () => {
  const description = toolDescription('end_run')
  assert.match(description, /no_change only when .*quietEnd.* nothing changed/)
  assert.match(description, /could_not_check when you could not do the check/)
  assert.match(description, /Never use it instead of a reply when you found something/)
  assert.match(description, /scheduledTaskId and fireId/)
  assert.doesNotMatch(description, /[\u2013\u2014]/, 'no em or en dashes in what the model reads')
  const at = server.indexOf("      name: 'end_run',")
  const schema = server.slice(at, server.indexOf("required: ['task_id', 'fire_id', 'outcome']", at))
  assert.ok(schema.length > 0 && server.indexOf("required: ['task_id', 'fire_id', 'outcome']", at) > at, 'task_id, fire_id and outcome are required')
  assert.match(schema, /outcome: \{\n\s+type: 'string',\n\s+enum: \['no_change', 'could_not_check'\],/)
  assert.match(schema, /reason: \{\n\s+type: 'string',\n\s+maxLength: 300,/)
  // The model reads that could_not_check needs a reason, and no_change does not.
  assert.match(schema, /'Required for could_not_check: why, in a few plain words your ' \+\n\s+'owner reads \(at most 300 characters\)\. Not needed for no_change\.'/)
  assert.doesNotMatch(schema, /[\u2013\u2014]/)
})

// The helper guard is the second half of "gated like every other write tool": a helper agent started in an earlier
// turn may not call a private tool in a later one. schedule is on its list in every install, so end_run is too.
test('end_run is a private tool for the helper guard, under any install prefix, in every install', () => {
  const marketplace = JSON.parse(readFileSync('hooks/hooks.json', 'utf8'))
  const guard = marketplace.hooks.PreToolUse.find((entry: any) => entry.hooks.some((h: any) => String(h.args?.[0]).endsWith('hoai-private-turn-hook.mjs')))
  for (const matcher of [PRIVATE_TOOL_MATCHER, PRESEED_MATCHER, guard.matcher]) {
    const re = new RegExp(matcher)
    for (const name of ['mcp__bgos__end_run', 'mcp__plugin_hoai_bgos__end_run']) assert.equal(re.test(name), true, `${name} against ${matcher}`)
    // Controls: schedule is on the same list; an ordinary tool and a look-alike name stay outside.
    assert.equal(re.test('mcp__bgos__schedule'), true)
    assert.equal(re.test('mcp__bgos__reply'), false)
    assert.equal(re.test('mcp__bgos__end_run_now'), false)
  }
})

test('a helper started in an earlier turn cannot end a run in the owner\'s next turn', () => {
  const root = scratchDir('hoai-end-run-helper-')
  const cwd = join(root, 'agent')
  mkdirSync(cwd)
  const env = { ...process.env, BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: cwd }
  markFloorAttached({ root, folders: [cwd] })
  const tracker = createPrivateTurnTracker()
  const start = (actor: string, text: string) => {
    const prompt = tracker.deliver({ content: text, actingUserId: actor, chatId: actor === 'user_owner' ? '10' : '20' })
    recordPrivateBoundary({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd, prompt }, env)
    tracker.begin({ prompt, sessionId: 's' })
  }
  const hook = (payload: Record<string, unknown>) => spawnSync(process.execPath, ['bin/hoai-private-turn-hook.mjs'], {
    env, input: JSON.stringify({ session_id: 's', cwd, ...payload }), encoding: 'utf8',
  })
  const call = (tool: string, agentId?: string) => hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, ...(agentId ? { agent_id: agentId, agent_type: 'general-purpose' } : {}) })
  start('user_alice', 'end the routine run')
  assert.equal(hook({ hook_event_name: 'SubagentStart', agent_id: 'agent-a', agent_type: 'general-purpose' }).status, 0)
  // The owner's turn begins while the helper still runs: end_run is refused under both install prefixes, as schedule is.
  start('user_owner', 'anything new?')
  for (const tool of ['mcp__bgos__end_run', 'mcp__plugin_hoai_bgos__end_run']) {
    const refused = call(tool, 'agent-a')
    assert.equal(refused.status, 2, `${tool} from a helper of an earlier turn must be refused`)
    assert.equal(refused.stderr.trim(), RUN_END_TURN_REFUSAL, `${tool}: told to reply normally, never to ask a person`)
  }
  const scheduled = call('mcp__bgos__schedule', 'agent-a')
  assert.equal(scheduled.status, 2, 'schedule from a helper of an earlier turn must be refused')
  assert.match(scheduled.stderr, /earlier turn|started/)
  // The main agent is left to the daemon's own gate.
  assert.equal(call('mcp__bgos__end_run').status, 0)
})
