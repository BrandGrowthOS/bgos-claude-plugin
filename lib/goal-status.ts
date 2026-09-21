/**
 * The goal lane's pure mapper (stage 6 of the BGOS Mission program).
 *
 * Claude Code's own /goal is a session scoped Stop hook plus one piece of app
 * state, and the verdict it produces is in NO hook payload: the Stop input
 * schema carries hook_event_name, stop_hook_active, last_assistant_message,
 * background_tasks and session_crons and nothing else, and the goal checker
 * runs as a SECOND hook in the same Stop batch. The hook is a WAKE and the
 * session transcript is the SOURCE. This module is the reading half: a chunk
 * of transcript in, typed records out, then a small state machine that turns
 * those records into the effects the daemon shell writes onto the mission.
 *
 * Like ./hook-events.ts it is pure and total. No I/O, no clock, no network, no
 * chat id, and it NEVER throws: a transcript line is untrusted input arriving
 * from another process, and a mapper that throws takes the lane down with it.
 *
 * The five shapes, every one of them verbatim from the stage 6 gate (four
 * captured live, the fifth read out of the emitter in the binary):
 *
 *   set sentinel     { type:'goal_status', met:false, sentinel:true, condition }
 *   clear sentinel   { type:'goal_status', met:true,  sentinel:true, condition }
 *   check, not met   { type:'goal_status', met:false, condition, reason }
 *   terminal, met    { type:'goal_status', met:true,  condition, reason,
 *                      iterations, durationMs, tokens }
 *   terminal, failed { type:'goal_status', met:false, failed:true, condition,
 *                      reason, iterations, durationMs, tokens }
 *
 * `sentinel: true` marks a STATE TRANSITION, armed or released, never an
 * evaluation, and only a terminal row carries iterations, durationMs or
 * tokens. A not met check reports no turns and no time at all, which is why
 * the lane counts its own checks and why nothing here invents an elapsed time.
 *
 * Three rules this file exists to hold:
 *
 * 1. REDACT BEFORE YOU CLIP, the same rule ./hook-events.ts states at :22. A
 *    judge reason quotes the tool output it read, so a real key can land in
 *    one; clipping first can slice a token in half and hand the scanner a
 *    value its pattern no longer matches, which is how a secret ships.
 * 2. THE CONDITION IS THE LANE KEY, so it is capped and never redacted. A set
 *    is matched to its own checks by that exact text, and a masked condition
 *    would stop matching the goal it names. It is the owner's own words, the
 *    same trust level as a mission title.
 * 3. A VERDICT BELONGS TO THE GOAL THAT IS ARMED. A record whose condition is
 *    not the open lane's is ignored rather than adopted: adopting one would
 *    attach a verdict from a goal this daemon never armed to this owner's
 *    mission.
 */

import { clipForWire, redactForWire } from './hook-events.ts'

/** The runtime's own cap on a /goal condition. */
export const GOAL_CONDITION_MAX = 4000

/** The backend's MissionVerdictInputDto.reason limit. */
export const GOAL_REASON_MAX = 240

/** The backend's MissionFeedEntryInputDto.text limit. The shell composes the
 *  feed line ("Not yet: <reason>") and clips it with this; the cap lives here
 *  so both halves of the lane read one number. */
export const GOAL_FEED_TEXT_MAX = 200

export type GoalRecordKind = 'set' | 'cleared' | 'check' | 'met' | 'impossible'

export interface GoalStatusRecord {
  kind: GoalRecordKind
  /** The goal's own text, capped, never masked. See rule 2. */
  condition: string
  /** The judge's words, redacted then clipped. Null on both sentinels. */
  reason: string | null
  /** The runtime's own turn count. Terminal rows only. */
  iterations: number | null
  /** The runtime's own elapsed time. Terminal rows only. */
  durationMs: number | null
  tokens: number | null
  /** The transcript row's own timestamp, in epoch ms, or 0 when unreadable. */
  at: number
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const intOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null

/**
 * One transcript line in, one goal record or null out. NEVER throws.
 *
 * A row is read only when it is an `attachment` entry whose attachment type is
 * `goal_status` and which is not a sidechain row: a goal is a main loop Stop
 * hook, so a sidechain row carrying one would be a subagent's transcript
 * replayed into ours (./resting.ts:318 skips sidechain activity for the same
 * reason).
 */
export function parseGoalStatusLine(line: string): GoalStatusRecord | null {
  let entry: unknown
  try {
    entry = JSON.parse(String(line ?? '').trim())
  } catch {
    return null
  }
  if (!isRecord(entry)) return null
  if (entry.type !== 'attachment') return null
  if (entry.isSidechain === true) return null
  const attachment = entry.attachment
  if (!isRecord(attachment)) return null
  if (attachment.type !== 'goal_status') return null
  const rawCondition = attachment.condition
  if (typeof rawCondition !== 'string') return null

  const met = attachment.met === true
  const sentinel = attachment.sentinel === true
  const failed = attachment.failed === true
  const kind: GoalRecordKind = sentinel
    ? met
      ? 'cleared'
      : 'set'
    : failed
      ? 'impossible'
      : met
        ? 'met'
        : 'check'

  const rawReason = attachment.reason
  const reason =
    typeof rawReason === 'string' && rawReason !== ''
      ? clipForWire(redactForWire(rawReason), GOAL_REASON_MAX)
      : null

  const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) || 0 : 0

  return {
    kind,
    condition: clipForWire(rawCondition, GOAL_CONDITION_MAX),
    reason,
    iterations: intOrNull(attachment.iterations),
    durationMs: intOrNull(attachment.durationMs),
    tokens: intOrNull(attachment.tokens),
    at,
  }
}

/**
 * Every goal record in a chunk of transcript, oldest first.
 *
 * Unparsable lines are skipped, which is normal at a live file's tail, and a
 * record older than `sinceMs` is dropped. That floor is what makes a bounded
 * startup re-read safe: a resumed session replays its parent's rows with their
 * ORIGINAL timestamps, and completing a mission off a goal that closed
 * yesterday is exactly the failure this lane must not have. A row with no
 * readable timestamp reads as 0 and is therefore dropped by any real floor.
 */
export function extractGoalRecords(chunk: string, sinceMs: number): GoalStatusRecord[] {
  const out: GoalStatusRecord[] = []
  for (const line of String(chunk ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const record = parseGoalStatusLine(trimmed)
    if (!record) continue
    if (record.at < sinceMs) continue
    out.push(record)
  }
  return out
}

// ── The lane ─────────────────────────────────────────────────────────────────

export type GoalVerdict = 'not_yet' | 'met' | 'impossible'

export interface GoalLaneState {
  /** The goal that is armed, or null when none is. */
  condition: string | null
  setAt: number | null
  /** Non sentinel records since the current set. The runtime does not report
   *  its own iterations until the goal closes, so this is the honest live
   *  "check n", and it is the number the cap is held against. */
  checks: number
  lastReason: string | null
  lastVerdict: GoalVerdict | null
  /** True once a terminal row landed: the goal is over but the condition is
   *  remembered, so a clear sentinel that follows it is not a second event. */
  closed: boolean
}

export function emptyGoalLane(): GoalLaneState {
  return {
    condition: null,
    setAt: null,
    checks: 0,
    lastReason: null,
    lastVerdict: null,
    closed: false,
  }
}

export type GoalEffect =
  | { kind: 'goal_set'; condition: string; at: number }
  | { kind: 'goal_cleared'; condition: string; at: number }
  | {
      kind: 'goal_check'
      condition: string
      verdict: 'not_yet'
      reason: string
      check: number
      at: number
    }
  | {
      kind: 'goal_met'
      condition: string
      reason: string
      check: number
      iterations: number | null
      durationMs: number | null
      tokens: number | null
      at: number
    }
  | {
      kind: 'goal_impossible'
      condition: string
      reason: string
      check: number
      iterations: number | null
      durationMs: number | null
      tokens: number | null
      at: number
    }

const isOpen = (state: GoalLaneState): boolean => state.condition !== null && !state.closed

/**
 * Fold a batch of records into the lane, returning the new state and the
 * effects the shell writes onto the mission.
 *
 * The lane keys on the CONDITION and never on a clear. A superseding goal
 * emits only a new set sentinel and no clear for the one it replaced (the
 * runtime records that as "superseded" in telemetry and appends nothing
 * else), so a state machine that waits for a cleared row before accepting a
 * new set hangs forever. A set with a different condition closes the lane that
 * was open first, so the mission it owned stops collecting verdicts; a set
 * with the SAME condition is that lane re-armed and closes nothing.
 *
 * The check ordinal on a terminal effect is the runtime's own `iterations`
 * when it reported one, and the lane's own count otherwise. Nothing here
 * derives a time: `durationMs` is the runtime's or it is null.
 */
export function applyGoalRecords(
  state: GoalLaneState,
  records: readonly GoalStatusRecord[],
): { next: GoalLaneState; effects: GoalEffect[] } {
  let next: GoalLaneState = { ...state }
  const effects: GoalEffect[] = []

  for (const record of records) {
    switch (record.kind) {
      case 'set': {
        if (isOpen(next) && next.condition !== record.condition) {
          effects.push({ kind: 'goal_cleared', condition: next.condition!, at: record.at })
        }
        next = {
          condition: record.condition,
          setAt: record.at,
          checks: 0,
          lastReason: null,
          lastVerdict: null,
          closed: false,
        }
        effects.push({ kind: 'goal_set', condition: record.condition, at: record.at })
        break
      }

      case 'cleared': {
        if (!isOpen(next) || next.condition !== record.condition) break
        effects.push({ kind: 'goal_cleared', condition: next.condition!, at: record.at })
        next = emptyGoalLane()
        break
      }

      case 'check': {
        if (!isOpen(next) || next.condition !== record.condition) break
        const checks = next.checks + 1
        const reason = record.reason ?? ''
        effects.push({
          kind: 'goal_check',
          condition: record.condition,
          verdict: 'not_yet',
          reason,
          check: checks,
          at: record.at,
        })
        next = { ...next, checks, lastReason: reason, lastVerdict: 'not_yet' }
        break
      }

      case 'met':
      case 'impossible': {
        if (!isOpen(next) || next.condition !== record.condition) break
        const checks = next.checks + 1
        const check =
          record.iterations !== null && record.iterations > 0 ? record.iterations : checks
        const reason = record.reason ?? ''
        effects.push({
          kind: record.kind === 'met' ? 'goal_met' : 'goal_impossible',
          condition: record.condition,
          reason,
          check,
          iterations: record.iterations,
          durationMs: record.durationMs,
          tokens: record.tokens,
          at: record.at,
        })
        next = {
          ...next,
          checks,
          lastReason: reason,
          lastVerdict: record.kind === 'met' ? 'met' : 'impossible',
          closed: true,
        }
        break
      }
    }
  }

  return { next, effects }
}
