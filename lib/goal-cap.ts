/**
 * The goal lane's two stops, as a pure decision (stage 6 of the Mission
 * program).
 *
 * The owner turns Keep working on and chooses a turn cap. From that moment the
 * DAEMON holds both stop rules and the server holds neither: the server never
 * declares a stop the daemon did not take, and this module is where the daemon
 * takes it. When one trips, the shell clears the native goal, posts the stop,
 * and the server turns the mission to Needs you carrying the reason.
 *
 *   turn cap    the checks since the goal was armed reached the owner's number
 *   no progress three checks in a row found the same thing
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
 * 2. It never stops a goal that has no cap. Both rules are the owner's Keep
 *    working instruction, and a goal a person typed into their own terminal
 *    has no cap and no owner instruction behind it: that mission still shows
 *    its last check, its turns and its time, and this daemon leaves it alone.
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
  /** The owner's turn cap for this mission, null when Keep working is off. */
  turnCap: number | null
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
  if (cap === null) return null
  if (input.checks >= cap) {
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
