/**
 * end_run: the agent ends one run of its routine without posting (When a routine runs, 2026-11-22).
 *
 * Why. A routine set to message only when something changes wakes the agent with a hint in its event payload
 * (quietEnd). The app's run end door (POST scheduled-tasks/agent/:id/run-end) takes no_change (post nothing) or
 * could_not_check (the owner gets a Could not check card with the reason). A Claude Code agent had no way to call it:
 * the hint named a raw HTTP call with a credential the model does not hold. So a quiet run on a Claude Code agent
 * always looked silent, and the server's sweep turned it into a red Could not check card. end_run is that call, made by
 * the daemon with its own credential and the X-Caller-Assistant-Id header, exactly as the board grant end
 * (scheduled-tasks/agent/:id/grant/end) is.
 *
 * Two promises held here besides the wire shape:
 *   1. end_run stays OUTSIDE the private turn gate and the turn aware list. The owner's own wake would usually pass
 *      them, but they also refuse when the private turn machinery is missing (no hook, an unverified marker, a daemon
 *      without the active connection), and a refused end_run would itself leave the run silent: the very red card it
 *      exists to avoid. The server decides instead (only the latest run of the owner's own routine on this agent).
 *   2. Every answer reads as one plain sentence: ended, already ended, the server's own 409 sentence, and for a 404
 *      or a 400 a plain line that says to reply normally instead.
 *
 * Everything here runs against fakes: a fake post, never a real server.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
import { PRIVATE_TOOL_MATCHER } from '../lib/private-turn.mjs'
import { PRIVATE_TOOL_MATCHER as PRESEED_MATCHER } from '../lib/claude-preseed.mjs'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const FIRE = 'scheduled-wake:41:2026-11-22T09:00:00.000Z'

/** The server's own 409 sentence for a run that must answer (the server's RUN_END_NOT_ALLOWED). */
const NOT_ALLOWED =
  'This run must answer: it is the first run of this routine, a run your owner asked for, or a routine set to message every run. Say what you found.'

function execute(body: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings))
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

test('a blank reason is left out, a reason of 300 characters is kept, a longer one is refused in plain words', () => {
  for (const reason of [undefined, null, '', '   ']) {
    const built = buildScheduleRunEndRequest({ taskId: 41, fireId: FIRE, outcome: 'could_not_check', reason })
    assert.equal(built.ok, true, String(reason))
    assert.equal('reason' in (built as { body: object }).body, false, `${JSON.stringify(reason)} sends no reason`)
  }
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

const caseStart = server.indexOf("    case 'end_run': {")
const endRunCase = server.slice(caseStart, server.indexOf("    case 'create_mission': {", caseStart))

function runEndRunCase(rawArgs: Record<string, unknown>, post: (...args: unknown[]) => Promise<unknown>) {
  return execute(`return (async () => { switch(name) { ${endRunCase} } })();`, {
    name: 'end_run',
    rawArgs,
    buildScheduleRunEndRequest,
    sendRunEnd,
    log: () => {},
    bgosPeerPost: post,
  }) as Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>
}

test('the real end_run case posts the run end through the daemon\'s own peer post, with no private headers', async () => {
  assert.ok(caseStart > 0, 'server.ts has a case for end_run')
  const calls: unknown[][] = []
  const result = await runEndRunCase(
    { task_id: '41', fire_id: FIRE, outcome: 'could_not_check', reason: 'The site was down.' },
    async (...args) => { calls.push(args); return { ended: true, outcome: 'could_not_check' } },
  )
  assert.notEqual(result.isError, true, result.content[0].text)
  assert.equal(result.content[0].text, RUN_END_COULD_NOT_CHECK_TEXT)
  assert.equal(calls.length, 1)
  // The grant end precedent: bgosPeerPost(path, body), its own auth plus X-Caller-Assistant-Id, nothing else.
  assert.deepEqual(calls[0], ['scheduled-tasks/agent/41/run-end', { fireId: FIRE, outcome: 'could_not_check', reason: 'The site was down.' }])
  assert.doesNotMatch(endRunCase, /privateCall/, 'outside the private gates: no private turn, no acting user header')
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

// ── outside every private gate ──────────────────────────────────────────────

test('end_run is admitted with no private turn: never refused by the strict gate or the turn aware list', async () => {
  const admissionStart = server.indexOf('  // Freeze private authority at request admission')
  assert.ok(admissionStart > 0, 'the admission block moved')
  const admissionSource = server.slice(admissionStart, server.indexOf('  return trackMessageOperation(async () => {', admissionStart))
  let strict = 0
  let aware = 0
  for (const lockHeld of [true, false]) {
    const privateCall = await execute(admissionSource + '\nreturn privateCall;', {
      req: { params: { name: 'end_run', arguments: { task_id: 41, fire_id: FIRE, outcome: 'no_change' } } },
      lockHeld,
      privateTurns: {},
      PRIVATE_MARKER_PATHS: [],
      PRIVATE_HOOK: { registered: true },
      PRIVATE_HOOK_MISSING_REFUSAL: 'hook missing',
      USER_ID: 'user_owner',
      requirePrivateTurn: () => { strict++; throw new Error('private action did not start') },
      turnAwarePrivateTurn: () => { aware++; throw new Error('private action did not start') },
      requireBoardsTurn: () => { strict++; throw new Error('private action did not start') },
      scheduleGrantRuns: {},
    })
    assert.equal(privateCall, null, `lockHeld ${lockHeld}: no private turn is asked for`)
  }
  assert.equal(strict, 0)
  assert.equal(aware, 0)
  // The helper guard (the PreToolUse private turn hook) never refuses it either.
  const hooks = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'))
  const guard = hooks.hooks.PreToolUse.find((entry: any) => entry.hooks.some((h: any) => String(h.args?.[0]).endsWith('hoai-private-turn-hook.mjs')))
  for (const matcher of [PRIVATE_TOOL_MATCHER, PRESEED_MATCHER, guard.matcher]) {
    for (const tool of ['mcp__plugin_hoai_bgos__end_run', 'mcp__bgos__end_run']) {
      assert.equal(new RegExp(matcher).test(tool), false, `${tool} against ${matcher}`)
    }
  }
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
  assert.doesNotMatch(schema, /[\u2013\u2014]/)
})
