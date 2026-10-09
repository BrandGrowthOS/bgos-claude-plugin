/**
 * The goal lane's two stops, as a pure decision (stage 6 of the Mission
 * program).
 *
 * The owner turns Keep working on, with a turn cap or without one. From then the
 * DAEMON holds both stop rules and the server holds neither: the server never
 * declares a stop the daemon did not take, and this module is where the daemon
 * takes it. When one trips, the shell clears the native goal, posts the stop,
 * and the server turns the mission to Needs you carrying the reason.
 *
 *   turn cap    the checks since the goal was armed reached the owner's number,
 *               only when they chose one
 *   no progress three checks in a row found the same thing, with or without
 *               a cap
 *
 * Pure: no clock, no I/O, no state of its own. The lane hands it what it has
 * counted and it answers with a stop or with null.
 *
 * Two things it deliberately does NOT do:
 *
 * 1. It never counts Stop hook events. A Stop fires with or without a goal
 *    check (the gate's own gated run shows one), so the count it is given is
 *    the number of non sentinel goal_status records, which ARE the checks and
 *    are what the runtime's own `iterations` counts when the goal closes.
 * 2. It never stops a goal nobody asked it to hold. Both rules are the owner's
 *    Keep working instruction, and a goal a person typed into their own
 *    terminal has no cap and no owner instruction behind it: that mission
 *    still shows its last check, its turns and its time, and this daemon
 *    leaves it alone.
 *
 * The two rules are gated SEPARATELY, and that is the point of the split. The
 * turn cap needs a number, so it runs only when the owner chose one. The stall
 * rule needs no number, so it runs whenever the owner's Keep working armed the
 * goal, cap or no cap. Keep working runs with no cap by default (KC,
 * 2026-09-28), and a stall rule that also waited for a cap would leave every
 * such goal free to loop forever on the same finding: it is the one stop that
 * still holds when there is no number to stop at.
 */

/** Three checks in a row that found the same thing is a stall. */
export const GOAL_STALL_STREAK = 3

export type GoalStopKind = 'turn_cap' | 'no_progress'

export interface GoalStop {
  kind: GoalStopKind
  /** The daemon's own sentence, which the owner reads as the reason. */
  text: string
}

export interface GoalCapInput {
  /** Is a goal armed on this session right now. */
  armed: boolean
  /** Has a terminal verdict already landed (met or impossible). */
  closed: boolean
  /** Non sentinel goal_status records since the goal was armed. */
  checks: number
  /** The owner's turn cap for this mission, null when they chose none or
   *  Keep working is off. */
  turnCap: number | null
  /** Did the owner's Keep working arm this goal. False for a goal a person
   *  typed into their own terminal, which this daemon never stops. */
  keepWorking: boolean
  /** The not met reasons since the goal was armed, oldest first. */
  reasons: readonly string[]
}

/**
 * The comparable form of a judge's reason: trimmed, whitespace collapsed,
 * lowercased. A judge rewords the same finding between turns, and treating two
 * wordings of one finding as progress is exactly how a goal loops forever.
 */
export function normalizeGoalReason(raw: string): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** How many of the most recent reasons say the same thing, newest backwards. */
export function sameReasonStreak(reasons: readonly string[]): number {
  if (reasons.length === 0) return 0
  const last = normalizeGoalReason(reasons[reasons.length - 1]!)
  let streak = 0
  for (let i = reasons.length - 1; i >= 0; i--) {
    if (normalizeGoalReason(reasons[i]!) !== last) break
    streak++
  }
  return streak
}

const capOf = (value: number | null): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null

/**
 * The stop this daemon takes, or null to keep going.
 *
 * The cap is answered before the stall, because the cap is the number the
 * owner chose and it is the one they will recognise on the card.
 */
export function decideGoalStop(input: GoalCapInput): GoalStop | null {
  if (!input.armed || input.closed) return null
  const cap = capOf(input.turnCap)
  // Neither an owner instruction nor a number: a goal a person typed.
  if (cap === null && input.keepWorking !== true) return null
  if (cap !== null && input.checks >= cap) {
    return { kind: 'turn_cap', text: `Stopped at ${cap} turns, the limit you set` }
  }
  if (sameReasonStreak(input.reasons) >= GOAL_STALL_STREAK) {
    return {
      kind: 'no_progress',
      text: `Stopped after ${GOAL_STALL_STREAK} checks with no progress`,
    }
  }
  return null
}
