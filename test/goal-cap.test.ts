/**
 * The two stops the daemon holds, as a pure decision.
 *
 * Claude Code has its own competing pause and retry loop, with its own words
 * ("Goal paused, goal checks kept finding it unmet this turn"), and it runs in
 * interactive sessions, which every BGOS agent is. The daemon's stop wins and
 * is the only one the owner sees: the runtime's pause is just another quiet
 * turn to this module, and when one of these two rules trips the shell clears
 * the native goal so the runtime's loop cannot resume behind the owner's back.
 *
 * Mutations these tests are proven against (task C1):
 *   - trip the cap above the budget instead of at it -> the cap test goes red
 *   - trip the stall at two in a row                 -> the streak test red
 *   - compare the raw reason text                    -> the wording test red
 *   - drop the closed guard                          -> the never stopped test red
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  GOAL_STALL_STREAK,
  decideGoalStop,
  normalizeGoalReason,
  sameReasonStreak,
  type GoalCapInput,
} from '../lib/goal-cap.ts'

const REASON = 'The file gate.txt has not been created yet.'

const armed = (over: Partial<GoalCapInput> = {}): GoalCapInput => ({
  armed: true,
  closed: false,
  checks: 0,
  turnCap: 20,
  reasons: [],
  ...over,
})

test('the cap trips at exactly the budget and never before it', () => {
  assert.equal(decideGoalStop(armed({ checks: 18 })), null)
  assert.equal(decideGoalStop(armed({ checks: 19 })), null, 'one check short is not the limit')

  const stopped = decideGoalStop(armed({ checks: 20 }))
  assert.equal(stopped?.kind, 'turn_cap')
  assert.equal(stopped?.text, 'Stopped at 20 turns, the limit you set')

  const over = decideGoalStop(armed({ checks: 41, turnCap: 40 }))
  assert.equal(over?.kind, 'turn_cap')
  assert.equal(over?.text, 'Stopped at 40 turns, the limit you set', 'the owner own number, not a constant')
})

test('three checks in a row that found the same thing stop the goal, and two do not', () => {
  assert.equal(GOAL_STALL_STREAK, 3)
  assert.equal(sameReasonStreak([]), 0)
  assert.equal(sameReasonStreak([REASON]), 1)
  assert.equal(sameReasonStreak([REASON, REASON]), 2)
  assert.equal(sameReasonStreak(['something else', REASON, REASON]), 2, 'the streak is the trailing run')

  assert.equal(decideGoalStop(armed({ checks: 2, reasons: [REASON, REASON] })), null, 'two in a row is not a stall')

  const stalled = decideGoalStop(armed({ checks: 3, reasons: [REASON, REASON, REASON] }))
  assert.equal(stalled?.kind, 'no_progress')
  assert.equal(stalled?.text, 'Stopped after 3 checks with no progress')

  const moved = decideGoalStop(
    armed({ checks: 4, reasons: [REASON, REASON, REASON, 'It now fails on the second line instead.'] }),
  )
  assert.equal(moved, null, 'a changed reason resets the streak, because that IS progress')
})

test('a reason is compared after trimming, collapsing whitespace and lowercasing', () => {
  assert.equal(normalizeGoalReason('  The File   Gate.txt\n was NOT found  '), 'the file gate.txt was not found')
  assert.equal(normalizeGoalReason(''), '')

  const sameThingSaidThreeWays = [
    REASON,
    `  ${REASON.toUpperCase()}  `,
    REASON.replace(/ /g, '\n  '),
  ]
  assert.equal(sameReasonStreak(sameThingSaidThreeWays), 3)

  const stalled = decideGoalStop(armed({ checks: 3, reasons: sameThingSaidThreeWays }))
  assert.equal(stalled?.kind, 'no_progress', 'the same finding reworded is still the same finding')
})

test('a goal that is closed, cleared or uncapped is never stopped by this daemon', () => {
  const full = { checks: 40, reasons: [REASON, REASON, REASON, REASON] }

  assert.equal(
    decideGoalStop(armed({ ...full, closed: true })),
    null,
    'a met or impossible verdict ended it, so there is nothing left to stop',
  )
  assert.equal(
    decideGoalStop(armed({ ...full, armed: false })),
    null,
    'a cleared goal stops counting',
  )
  assert.equal(
    decideGoalStop(armed({ ...full, turnCap: null })),
    null,
    'both stops are the owner Keep working instruction; a goal a person typed in their own terminal has no cap and this daemon never stops it',
  )
  for (const cap of [0, -3, 1.5, Number.NaN]) {
    assert.equal(decideGoalStop(armed({ ...full, turnCap: cap })), null, `a cap of ${cap} is not a limit`)
  }
})

test('the cap is answered before the stall, because it is the number the owner chose', () => {
  const both = decideGoalStop(armed({ checks: 20, reasons: [REASON, REASON, REASON] }))
  assert.equal(both?.kind, 'turn_cap')
})
