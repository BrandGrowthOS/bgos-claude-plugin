/**
 * The uncapped stall stop, driven from the runtime's OWN goal_status rows.
 *
 * test/goal-cap.test.ts proves the pure rule on hand built reasons. This one
 * feeds REAL rows (test/fixtures/goal-status-interactive.jsonl, captured from
 * an interactive claude 2.1.278 session) through the same fold server.ts
 * runs (applyGoalRecords, then a goal_check effect's reason pushed onto the
 * lane), into decideGoalStop with NO cap. It is the closest this repo can get
 * to a live uncapped stop without arming a goal on a real mission.
 *
 * Mutations proven (each applied, run red, restored):
 *   - gate the stall on the cap again in lib/goal-cap.ts -> the stop test red
 *   - drop the keepWorking guard                         -> the typed goal test red
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

import { decideGoalStop } from '../lib/goal-cap.ts'
import { applyGoalRecords, emptyGoalLane, parseGoalStatusLine } from '../lib/goal-status.ts'

const rows = readFileSync(new URL('./fixtures/goal-status-interactive.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '')
const SET_GATE = rows[3]!
const CHECK_GATE = rows[4]!

/** The same not met check, as the runtime writes it on three later turns. */
const checkOnTurn = (n: number): string => {
  const entry = JSON.parse(CHECK_GATE) as Record<string, unknown>
  return JSON.stringify({
    ...entry,
    uuid: `00000000-0000-4000-8000-00000000000${n}`,
    timestamp: new Date(Date.parse(String(entry.timestamp)) + n * 60_000).toISOString(),
  })
}

/** What server.ts folds: the lane state, the checks it counted, the reasons. */
function fold(lines: string[]) {
  const records = lines.map((line) => {
    const record = parseGoalStatusLine(line)
    assert.ok(record, 'a captured row must parse')
    return record
  })
  const { next, effects } = applyGoalRecords(emptyGoalLane(), records)
  const reasons: string[] = []
  let checks = 0
  for (const effect of effects) {
    if (effect.kind === 'goal_check') {
      checks = effect.check
      reasons.push(effect.reason)
    }
  }
  return { lane: next, checks, reasons }
}

test('three real not met checks with the same finding stop an UNCAPPED Keep working goal', () => {
  const { lane, checks, reasons } = fold([SET_GATE, checkOnTurn(1), checkOnTurn(2), checkOnTurn(3)])
  assert.equal(checks, 3, 'three checks were counted off the transcript')
  assert.equal(lane.closed, false)

  const two = fold([SET_GATE, checkOnTurn(1), checkOnTurn(2)])
  assert.equal(
    decideGoalStop({ armed: two.lane.condition !== null, closed: two.lane.closed, checks: two.checks, turnCap: null, keepWorking: true, reasons: two.reasons }),
    null,
    'two is not a stall',
  )

  const stop = decideGoalStop({
    armed: lane.condition !== null,
    closed: lane.closed,
    checks,
    turnCap: null,
    keepWorking: true,
    reasons,
  })
  assert.equal(stop?.kind, 'no_progress')
  assert.equal(stop?.text, 'Stopped after 3 checks with no progress')
})

test('the same real rows on a goal a person typed (no cap, no Keep working) stop nothing', () => {
  const { lane, checks, reasons } = fold([SET_GATE, checkOnTurn(1), checkOnTurn(2), checkOnTurn(3)])
  assert.equal(
    decideGoalStop({ armed: lane.condition !== null, closed: lane.closed, checks, turnCap: null, keepWorking: false, reasons }),
    null,
  )
})
