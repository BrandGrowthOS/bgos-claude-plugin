/**
 * The pure goal_status mapper: the five shapes, the lane state machine, and
 * the reason's redact-then-clip contract (stage 6 of the Mission program).
 *
 * Every goal_status line below is a REAL one, copied verbatim out of the
 * stage 6 feasibility gate's own evidence into test/fixtures/:
 *   goal-status-interactive.jsonl  from stage6-gate/claude/evidence/
 *                                  goal-records.jsonl, an interactive PTY
 *                                  session on claude 2.1.278
 *   goal-status-stream-json.jsonl  from stage6-gate/claude/evidence2/
 *                                  transcript-stream-json-input.jsonl,
 *                                  claude -p --input-format stream-json
 * The fifth shape, the impossible verdict, has never been produced by a run:
 * it is built below from the emitter GATE-2 section 5 read out of the binary,
 * and the comment names it so nobody mistakes it for a capture.
 *
 * Mutations these tests are proven against (task C1):
 *   - classify a sentinel row as a check      -> the five shapes test goes red
 *   - accept an isSidechain row               -> the skipped rows test red
 *   - clip the reason before redacting it     -> the redaction test goes red
 *   - wait for a cleared record before a set  -> both superseding tests red
 *   - adopt a condition off a check record    -> the unowned verdict test red *   - count every goal row, sentinels included, the way counting Stop
 *     events would    -> the check count test goes red
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

import {
  GOAL_CONDITION_MAX,
  GOAL_REASON_MAX,
  applyGoalRecords,
  emptyGoalLane,
  extractGoalRecords,
  parseGoalStatusLine,
  type GoalEffect,
  type GoalStatusRecord,
} from '../lib/goal-status.ts'

const fixture = (name: string): string[] =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

const INTERACTIVE = fixture('goal-status-interactive.jsonl')
const STREAM_JSON = fixture('goal-status-stream-json.jsonl')
/** The SAME gated session's Stop hook payloads, verbatim out of
 *  stage6-gate/claude/evidence/hooks-interactive.jsonl. They are here as the
 *  counter example, not as input: nothing in this lane reads a hook payload. */
const GATED_RUN_STOPS = fixture('goal-status-stops.jsonl').map(
  (line) => JSON.parse(line) as Record<string, unknown>,
)

const parsedLine = (line: string): GoalStatusRecord => {
  const record = parseGoalStatusLine(line)
  assert.ok(record, `line should parse: ${line.slice(0, 90)}`)
  return record
}

/** The interactive fixture, row by row, in the order the runtime wrote them. */
const SET_DONE = 0
const SET_ACTIVE = 1
const CLEARED_ACTIVE = 2
const SET_GATE = 3
const CHECK_GATE = 4
const MET_GATE = 5
const SET_P = 6

const kindsOf = (effects: GoalEffect[]): string[] => effects.map((e) => e.kind)

// A goal_status row with everything a real row carries except the parts the
// case under test changes. Built from a captured row rather than invented:
// json in, json out, so a field flip stays honest.
const rowFrom = (
  line: string,
  patch: Record<string, unknown> & { _attachment?: Record<string, unknown> },
): string => {
  const entry = JSON.parse(line) as Record<string, unknown>
  const attachment = entry.attachment as Record<string, unknown>
  const { _attachment, ...rest } = patch
  return JSON.stringify({
    ...entry,
    ...rest,
    attachment: { ...attachment, ..._attachment },
  })
}

// ── The five shapes ──────────────────────────────────────────────────────────

test('the five goal_status shapes are parsed from the runtime own rows', () => {
  const records = INTERACTIVE.map(parsedLine)
  assert.deepEqual(
    records.map((r) => r.kind),
    ['set', 'set', 'cleared', 'set', 'check', 'met', 'set'],
    'sentinel true with met false is armed, sentinel true with met true is released',
  )

  const set = records[SET_DONE]!
  assert.match(set.condition, /^the file done\.txt exists/)
  assert.equal(set.reason, null, 'a set sentinel is a state transition, never an evaluation')
  assert.equal(set.iterations, null)
  assert.equal(set.durationMs, null)
  assert.equal(set.tokens, null)
  assert.equal(set.at, Date.parse('2026-09-20T19:35:13.278Z'))

  const cleared = records[CLEARED_ACTIVE]!
  assert.equal(cleared.condition, 'active', '/goal active sets a goal called active, it is not a query')

  const check = records[CHECK_GATE]!
  assert.match(check.reason ?? '', /^The file gate\.txt has not been created yet\./)
  assert.equal(check.iterations, null, 'a not met check reports no turns')
  assert.equal(check.durationMs, null, 'and no time at all')
  assert.equal(check.tokens, null)

  const met = records[MET_GATE]!
  assert.equal(met.iterations, 2)
  assert.equal(met.durationMs, 9211)
  assert.equal(met.tokens, 699)
  assert.match(met.reason ?? '', /^The transcript shows the assistant replied/)

  const stream = STREAM_JSON.map(parsedLine)
  assert.deepEqual(stream.map((r) => r.kind), ['set', 'met'], 'the sdk input path writes the same rows')
  assert.equal(stream[1]!.iterations, 1)
  assert.equal(stream[1]!.durationMs, 13246)
  assert.equal(stream[1]!.tokens, 762)

  // The impossible row, from the emitter itself (GATE-2 section 5):
  //   if (Xe.impossible) yield ln({type:"goal_status", met:false, failed:true,
  //     condition, reason, iterations, durationMs, tokens})
  // No probe run has ever produced one, so this is a build and not a capture.
  const impossible = parsedLine(
    rowFrom(INTERACTIVE[MET_GATE]!, {
      _attachment: {
        met: false,
        failed: true,
        reason: 'The folder is read only, so the file can never be created.',
        iterations: 3,
        durationMs: 12000,
        tokens: 880,
      },
    }),
  )
  assert.equal(impossible.kind, 'impossible', 'failed true is terminal and lost')
  assert.equal(impossible.iterations, 3)
  assert.equal(impossible.durationMs, 12000)
})

// ── Rows this lane must not read ─────────────────────────────────────────────

test('a sidechain row, a foreign row and a half written row are all skipped', () => {
  const sidechain = rowFrom(INTERACTIVE[CHECK_GATE]!, { isSidechain: true })
  assert.equal(parseGoalStatusLine(sidechain), null, 'a goal is main loop only')

  const otherAttachment = rowFrom(INTERACTIVE[CHECK_GATE]!, {
    _attachment: { type: 'selected_lines_in_ide' },
  })
  assert.equal(parseGoalStatusLine(otherAttachment), null)

  for (const junk of ['', '   ', 'not json', '{}', '[]', 'null', '{"type":"user"}']) {
    assert.equal(parseGoalStatusLine(junk), null, `should refuse ${JSON.stringify(junk)}`)
  }

  // A live file's tail: the last line is still being appended.
  const truncated = INTERACTIVE[CHECK_GATE]!.slice(0, 120)
  const chunk = `${INTERACTIVE[SET_GATE]!}\n${INTERACTIVE[CHECK_GATE]!}\n${truncated}`
  const records = extractGoalRecords(chunk, 0)
  assert.deepEqual(records.map((r) => r.kind), ['set', 'check'], 'the half written row is dropped, not thrown on')

  const later = Date.parse('2026-09-20T19:38:56.000Z')
  assert.deepEqual(
    extractGoalRecords(chunk, later).map((r) => r.kind),
    [],
    'a replayed transcript older than the cursor floor never signals',
  )
})

// ── Redact, then clip ────────────────────────────────────────────────────────

test('a judge reason is redacted BEFORE it is clipped', () => {
  // A judge reason quotes tool output, so a real key can land in it. The token
  // starts before the cut and ends after it, so clipping first would leave the
  // live head of a key on the wire with no rule left to match it.
  const token = `ZZtok${'b'.repeat(35)}`
  const head = token.slice(0, 8)
  const padding = `${'The transcript shows the run. '.repeat(6)}It said ok exact. `
  const reason = `${padding}curl -H "Authorization: Bearer ${token}" https://api.example.com and the condition is not satisfied yet.`
  const startsAt = reason.indexOf(token)
  assert.ok(startsAt < GOAL_REASON_MAX, 'the fixture must start the token before the cut')
  assert.ok(startsAt + token.length > GOAL_REASON_MAX, 'and end it after the cut')
  assert.ok(
    GOAL_REASON_MAX - startsAt < 20,
    'and leave too little of it for any rule to match, which is the whole trap',
  )

  const record = parsedLine(rowFrom(INTERACTIVE[CHECK_GATE]!, { _attachment: { reason } }))
  // The mask is itself cut by the clip that follows it, so the proof is that a
  // mask STARTED where the key was and that none of the key survived.
  assert.ok(record.reason!.includes('[redacted:'), 'the key must be masked before the clip')
  assert.ok(!record.reason!.includes(head), 'the head of the key reached the wire')
  assert.ok(record.reason!.length <= GOAL_REASON_MAX, 'and the reason is still within the wire limit')
})

test('the condition is capped at the runtime own limit and is never redacted', () => {
  // The condition is the lane KEY: a set is matched to its checks by this
  // exact text, so masking it would break the match the whole lane turns on.
  const long = 'x'.repeat(GOAL_CONDITION_MAX + 500)
  const record = parsedLine(rowFrom(INTERACTIVE[SET_GATE]!, { _attachment: { condition: long } }))
  assert.equal(record.condition.length, GOAL_CONDITION_MAX)
})

// ── The lane ─────────────────────────────────────────────────────────────────

test('a superseding set with no intervening cleared is accepted and resets the check count', () => {
  // The runtime records a replaced goal as "superseded" in telemetry and
  // appends only the NEW set sentinel. A lane that waits for a cleared row
  // hangs forever, which is why both rows below are real ones in file order.
  const armed = applyGoalRecords(emptyGoalLane(), [
    parsedLine(INTERACTIVE[SET_GATE]!),
    parsedLine(INTERACTIVE[CHECK_GATE]!),
  ])
  assert.equal(armed.next.checks, 1)
  assert.equal(armed.next.lastVerdict, 'not_yet')

  const superseded = applyGoalRecords(armed.next, [parsedLine(INTERACTIVE[SET_P]!)])
  assert.ok(kindsOf(superseded.effects).includes('goal_set'), 'the new set is accepted')
  assert.match(superseded.next.condition ?? '', /^the file p\.txt exists/)
  assert.equal(superseded.next.checks, 0, 'the check counter belongs to the goal, not the session')
  assert.equal(superseded.next.lastReason, null)
  assert.equal(superseded.next.lastVerdict, null)
  assert.equal(superseded.next.closed, false)
})

test('a set with a different condition closes the lane that was open', () => {
  const armed = applyGoalRecords(emptyGoalLane(), [parsedLine(INTERACTIVE[SET_GATE]!)])
  const superseded = applyGoalRecords(armed.next, [parsedLine(INTERACTIVE[SET_P]!)])
  assert.deepEqual(
    kindsOf(superseded.effects),
    ['goal_cleared', 'goal_set'],
    'the old lane is closed first, so the mission it owned stops collecting verdicts',
  )
  const closed = superseded.effects[0] as Extract<GoalEffect, { kind: 'goal_cleared' }>
  assert.match(closed.condition, /^the file gate\.txt exists/, 'the cleared effect names the OLD condition')

  // The same condition set again is the same lane re-armed, not a new one.
  const rearmed = applyGoalRecords(armed.next, [parsedLine(INTERACTIVE[SET_GATE]!)])
  assert.deepEqual(kindsOf(rearmed.effects), ['goal_set'])
})

test('a verdict for a condition this lane does not own is ignored', () => {
  // A check can only ever belong to the goal that is armed. Adopting one would
  // attach another session's verdict to this owner's mission.
  const armed = applyGoalRecords(emptyGoalLane(), [parsedLine(INTERACTIVE[SET_P]!)])
  const stray = applyGoalRecords(armed.next, [parsedLine(INTERACTIVE[CHECK_GATE]!)])
  assert.deepEqual(kindsOf(stray.effects), [], 'no effect at all')
  assert.equal(stray.next.checks, 0)
  assert.match(stray.next.condition ?? '', /^the file p\.txt exists/, 'and the armed lane is untouched')

  const unarmed = applyGoalRecords(emptyGoalLane(), [parsedLine(INTERACTIVE[CHECK_GATE]!)])
  assert.deepEqual(kindsOf(unarmed.effects), [], 'a verdict with no set before it arms nothing')
  assert.equal(unarmed.next.condition, null)
})

test('the whole interactive session folds into the effects the shell writes', () => {
  const records = INTERACTIVE.map(parsedLine)
  const { next, effects } = applyGoalRecords(emptyGoalLane(), records)
  assert.deepEqual(kindsOf(effects), [
    'goal_set', // done.txt armed
    'goal_cleared', // superseded by /goal active, with no cleared row of its own
    'goal_set',
    'goal_cleared', // /goal clear
    'goal_set', // gate.txt armed
    'goal_check',
    'goal_met',
    'goal_set', // p.txt armed
  ])

  const check = effects[5] as Extract<GoalEffect, { kind: 'goal_check' }>
  assert.equal(check.verdict, 'not_yet')
  assert.equal(check.check, 1, 'the first check since the set')

  const met = effects[6] as Extract<GoalEffect, { kind: 'goal_met' }>
  assert.equal(met.check, 2, 'the runtime own iterations count wins when it reports one')
  assert.equal(met.durationMs, 9211)
  assert.equal(met.tokens, 699)

  assert.match(next.condition ?? '', /^the file p\.txt exists/)
  assert.equal(next.closed, false, 'the last row armed a new goal')
})

test('the check count comes from the goal rows and never from the Stop hooks', () => {
  // A Stop fires with or without a goal check, so counting Stops over reports
  // the owner's turns and would trip a 20 turn cap on a goal that was only
  // checked twice. Both captures below come from ONE real gated session.
  assert.equal(GATED_RUN_STOPS.length, 3, 'the gated run fired three Stop hooks')
  assert.ok(
    GATED_RUN_STOPS.some((stop) => stop.stop_hook_active === false),
    'and at least one of them ran with no goal loop driving it',
  )

  // The /goal active lane in that same session: armed, then released, with no
  // evaluation between the two, while Stop hooks kept firing around it.
  const activeLane = applyGoalRecords(emptyGoalLane(), [
    parsedLine(INTERACTIVE[SET_ACTIVE]!),
    parsedLine(INTERACTIVE[CLEARED_ACTIVE]!),
  ])
  assert.deepEqual(kindsOf(activeLane.effects), ['goal_set', 'goal_cleared'])
  assert.equal(activeLane.next.checks, 0, 'a goal nobody evaluated has used no turns')

  // The gate.txt lane in that same session: one not met check and one terminal.
  const gateLane = applyGoalRecords(emptyGoalLane(), [
    parsedLine(INTERACTIVE[SET_GATE]!),
    parsedLine(INTERACTIVE[CHECK_GATE]!),
    parsedLine(INTERACTIVE[MET_GATE]!),
  ])
  assert.equal(gateLane.next.checks, 2, 'two non sentinel rows, which is what iterations counts')
  assert.notEqual(
    gateLane.next.checks,
    GATED_RUN_STOPS.length,
    'the session Stop count is not this goal turn count, and never was',
  )
})

test('a met row closes the lane and a later clear adds nothing', () => {
  const run = applyGoalRecords(emptyGoalLane(), [
    parsedLine(INTERACTIVE[SET_GATE]!),
    parsedLine(INTERACTIVE[CHECK_GATE]!),
    parsedLine(INTERACTIVE[MET_GATE]!),
  ])
  assert.equal(run.next.closed, true)
  assert.equal(run.next.lastVerdict, 'met')

  const cleared = rowFrom(INTERACTIVE[MET_GATE]!, { _attachment: { sentinel: true } })
  const after = applyGoalRecords(run.next, [parsedLine(cleared)])
  assert.deepEqual(kindsOf(after.effects), [], 'the auto clear of a goal already reported met is not a second event')
})
