/**
 * The goal lane's judgement (stage 6 of the BGOS Mission program).
 *
 * The read half answers "what did the runtime's own checker say": the mapper
 * (./goal-status.ts) turns transcript rows into records and effects, the
 * tailer (./goal-tail.ts) feeds it, and the cap rule (./goal-cap.ts) says when
 * this daemon stops its own loop. This module is the write half's judgement,
 * and it holds the three decisions that would otherwise live as opinions
 * inside server.ts:
 *
 *   1. which mission write ONE goal effect deserves, and with what numbers;
 *   2. what the owner's own mission frames tell the lane to do with the
 *      native goal (arm it, clear it, remember it, forget it);
 *   3. what a goal a person typed into their own terminal gets a mission card
 *      from, when the lane armed nothing.
 *
 * Pure and total, like every other lib/ module the lane uses: no I/O, no
 * clock, no network, and it never throws. server.ts is left with the wiring,
 * and the wiring has no opinions of its own.
 *
 * Five rules are written into this file and tested:
 *
 * - TIME AND TURNS ONLY WHERE A RUNTIME COUNTED THEM. A not met check carries
 *   no iterations, no durationMs and no tokens at all, so a live check reports
 *   the check count and NO working time. The time arrives with the terminal
 *   record or it never arrives.
 * - THE TURNS ALREADY SPENT ARE CARRIED. "Give it 10 more turns" raises the
 *   cap and arms the same goal again, and the runtime starts its own count
 *   over at the new set sentinel. Reporting that raw count would drop the
 *   owner's card from "20 of 20" back to "1 of 30", which reads as work that
 *   never happened, so the lane adds what it already counted.
 * - THE VERDICT IS THE CHECKER'S. Every verdict this lane sends carries
 *   `by: 'checker'`, because Claude Code's goal check IS a separate judge: a
 *   session scoped Stop hook of type prompt, evaluated after the turn by
 *   something other than the agent. The server still coerces the claim down
 *   to 'agent' unless this daemon declared mission_goal_checks, which is the
 *   honest order: the daemon says what it knows and the server decides what
 *   it will vouch for.
 * - A CLEAR THIS DAEMON TYPED IS NOT AN EVENT. The cap, the stall rule, a
 *   pause and an abandon all clear the goal with the same keystrokes, and
 *   each already tells the owner what happened in its own words. The runtime
 *   answers every one of them with a clear sentinel, and narrating that too
 *   would read as two separate things happening.
 * - AN ARM ALREADY TYPED IS NOT A GOAL THE RUNTIME DROPPED. `live` is folded
 *   from the transcript, which says nothing about a goal until its set
 *   sentinel is read, and that can be minutes after the keystrokes left. So
 *   the lane carries a PENDING record for an arm it has typed and not yet had
 *   answered, and a frame for that mission decides nothing about arming while
 *   it stands. Without it, every mission_updated inside the window (the
 *   backend emits one on every progress write) typed a second /goal into the
 *   person's composer and started another confirmation watcher.
 * - A STOP THE OWNER PRESSED WINS OVER A SENTINEL THAT ARRIVES AFTER IT. The
 *   clear a Pause types can only reach a goal the runtime is already holding,
 *   and inside the arming window there is none: the goal arrives after the
 *   owner stopped the mission. So the stop is recorded ON the pending arm and
 *   settled when the sentinel lands, which is the first moment anything can
 *   act on it. Without that, the owner's Pause typed a clear into thin air
 *   and the sentinel then handed the runtime a mission they had just stopped.
 * - A CONTROL THE OWNER PRESSED REACHES THE GOAL THIS LANE IS REPORTING ON.
 *   Pause, Resume and Set aside are offered on every open mission of a daemon
 *   that said it can enforce them, and the enforcement IS clearing the native
 *   goal. So these frames are read against the mission this lane writes its
 *   checks onto, not only against the one the owner's switch armed: a goal a
 *   person typed in their own terminal gets a derived mission and the same
 *   three buttons, and reading the arm record alone left all three doing
 *   nothing while the runtime carried on looping.
 */

import { GOAL_CONDITION_MAX, GOAL_FEED_TEXT_MAX, type GoalEffect } from './goal-status.ts'
import type { MissionFrame } from './mission-events.ts'
import {
  MISSION_DONE_WHEN_MAX,
  MISSION_TITLE_MAX,
  buildMissionCompleteBody,
  buildMissionFailBody,
  buildMissionProgressBody,
  type MissionCompleteBody,
  type MissionFailBody,
  type MissionProgressBody,
  type MissionSnapshot,
} from './missions.ts'

/** The runtime's own cap on a /goal condition, re-exported so a caller that
 *  builds one reads the same number the mapper reads. */
export { GOAL_CONDITION_MAX }

/** The one line the owner reads when a person cleared the goal themselves. */
export const GOAL_CLEARED_FEED_TEXT = 'The goal was cleared, so no more checks will run.'

/** The lead-in on the feed line a not met check writes. */
export const GOAL_NOT_YET_PREFIX = 'Not yet: '

export type GoalWrite =
  | { route: 'none' }
  | { route: 'refused'; error: string }
  | { route: 'progress'; body: MissionProgressBody }
  | { route: 'complete'; body: MissionCompleteBody }
  | { route: 'fail'; body: MissionFailBody }

export interface GoalWriteContext {
  /** The owner's turn limit for this mission, null when nobody set one. */
  turnCap: number | null
  /** Checks counted for this mission BEFORE the current set sentinel. */
  turnsBefore: number
  /** True when this daemon typed the clear that produced the record. */
  selfCleared?: boolean
}

/**
 * One goal effect in, one mission write out.
 *
 * `none` means the effect is real and deserves no write: a set sentinel
 * ATTACHES a goal to a mission and reports nothing, and a clear this daemon
 * typed is already explained by whatever made it type. `refused` means the
 * body could not be built, which is a bug in this file rather than a thing
 * the owner should ever see, so the caller logs it and moves on.
 */
export function goalWriteFor(effect: GoalEffect, context: GoalWriteContext): GoalWrite {
  const turnCap = context.turnCap
  switch (effect.kind) {
    case 'goal_set':
      return { route: 'none' }

    case 'goal_cleared': {
      if (context.selfCleared === true) return { route: 'none' }
      return asProgress(
        buildMissionProgressBody({
          feedEntry: { kind: 'checked', text: GOAL_CLEARED_FEED_TEXT },
        }),
      )
    }

    case 'goal_check': {
      const check = context.turnsBefore + effect.check
      return asProgress(
        buildMissionProgressBody({
          feedEntry: { kind: 'checked', text: notYetLine(effect.reason) },
          verdict: { verdict: 'not_yet', reason: effect.reason, by: 'checker', check },
          // No workingMs: a not met check reports no elapsed time, and there
          // is nowhere honest to get one from.
          runReport: { turnsUsed: check, turnCap },
        }),
      )
    }

    case 'goal_met': {
      const check = context.turnsBefore + effect.check
      const built = buildMissionCompleteBody({
        summary: effect.reason,
        verdict: { verdict: 'met', reason: effect.reason, by: 'checker', check },
        runReport: { turnsUsed: check, turnCap, workingMs: effect.durationMs },
      })
      return built.ok ? { route: 'complete', body: built.body } : { route: 'refused', error: built.error }
    }

    case 'goal_impossible': {
      const check = context.turnsBefore + effect.check
      const built = buildMissionFailBody({
        summary: effect.reason,
        verdict: { verdict: 'impossible', reason: effect.reason, by: 'checker', check },
        runReport: { turnsUsed: check, turnCap, workingMs: effect.durationMs },
      })
      return built.ok ? { route: 'fail', body: built.body } : { route: 'refused', error: built.error }
    }
  }
}

/**
 * The feed line a not met check writes.
 *
 * Cut HERE, to the feed's own limit, and never by shortening the reason
 * first: the verdict carries the judge's words up to 240 characters and it is
 * what the owner reads as Last check, so trimming the sentence that matters to
 * fit the one that does not would lose the point of the check.
 */
function notYetLine(reason: string): string {
  return cut(`${GOAL_NOT_YET_PREFIX}${reason}`, GOAL_FEED_TEXT_MAX)
}

function asProgress(
  built: ReturnType<typeof buildMissionProgressBody>,
): GoalWrite {
  return built.ok ? { route: 'progress', body: built.body } : { route: 'refused', error: built.error }
}

/** Trim, cap, and never leave a lone high surrogate at the cut. */
function cut(raw: string, max: number): string {
  let trimmed = String(raw ?? '').trim().slice(0, max)
  const last = trimmed.charCodeAt(trimmed.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) trimmed = trimmed.slice(0, -1)
  return trimmed
}

/** One line of the owner's own words, whitespace collapsed. */
function oneLine(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim()
}

// ── The owner's own mission frames ───────────────────────────────────────────

/** What the OWNER'S Keep working armed, as the frame reader needs to see it. */
export interface GoalArmRecord {
  missionId: number
  condition: string
  turnCap: number | null
  /** Every check counted for this mission so far, across re arms. */
  turns: number
  /** Is the runtime holding this exact condition at this moment. */
  live: boolean
}

/**
 * The same shape, read for the goal this lane is REPORTING on rather than the
 * one the owner's switch armed.
 *
 * Every goal the lane writes checks for has one of these, and a goal a person
 * typed into their own terminal has ONLY this: it never went through the
 * owner's switch, so there is no arm record for it at all. It survives a
 * pause, because a Resume has to put the same condition back.
 */
export type GoalReportRecord = GoalArmRecord

/**
 * An arm this daemon has TYPED whose set sentinel has not come back yet.
 *
 * It is held per mission and not per condition, because the harm is a second
 * set of keystrokes for the same mission, whatever they would say. It is
 * taken before the keystrokes leave and released two ways: by the set
 * sentinel, which is the runtime answering, and by the confirmation giving
 * up, which is the lane admitting nothing was armed. Both are wired in
 * server.ts and guarded in test/mission-ws-wiring.test.ts, because a record
 * that is never released is a mission that can never arm again.
 */
export interface GoalPendingArm {
  missionId: number
  condition: string
  /** The owner's stop, arriving while this arm was in flight and settled when
   *  its sentinel lands. `paused` keeps the goal for a Resume to put back;
   *  `cleared` is a mission that is closed, so nothing is kept. */
  stopped?: GoalPendingStop | null
}

/** Which stop the owner pressed, in the words the lane already uses: a pause
 *  REMEMBERS the goal and everything else forgets it. */
export type GoalPendingStop = 'paused' | 'cleared'

export type GoalCommand =
  | { kind: 'none' }
  | {
      kind: 'arm'
      missionId: number
      condition: string
      turnCap: number | null
      turnsBefore: number
    }
  | { kind: 'clear'; forget: boolean }

const NONE: GoalCommand = { kind: 'none' }

/**
 * The condition a mission's goal is armed with: the owner's own Done when
 * line, and the title when they did not write one.
 *
 * Done when first because that is the sentence the owner wrote as the test
 * for the whole mission, which is exactly what a goal condition is. A title
 * is a headline and makes a vaguer condition, but a vague condition the owner
 * wrote beats no goal at all. Null means there is nothing to arm with.
 */
export function goalConditionFor(mission: MissionSnapshot): string | null {
  const doneWhen = oneLine(mission.doneWhen)
  const condition = doneWhen !== '' ? doneWhen : oneLine(mission.title)
  if (condition === '') return null
  return cut(condition, GOAL_CONDITION_MAX)
}

const capOf = (mission: MissionSnapshot): number | null => {
  const raw = mission.turnCap
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null
}

/**
 * What one mission frame tells the lane to do.
 *
 * The rules, and why each one is here:
 *
 *   an arm for THIS mission already typed and not yet answered
 *     nothing about arming, for either route. The set sentinel has not been
 *     read, so `live` is false for a goal that is arming exactly as it is for
 *     one the runtime dropped, and re arming on that reading is a second
 *     /goal in the person's composer and a second watcher behind it. A stop
 *     is not a second goal, so Pause and Set aside still reach it: making the
 *     owner wait out the window to stop a runtime that is looping would be
 *     the same defect wearing the other hat.
 *   created / resumed / updated with the switch ON and the mission ACTIVE
 *     arm it, unless the runtime is already holding this exact condition for
 *     this mission and the cap did not move. Every mission write emits a
 *     frame, so an unguarded re arm would type a fresh /goal into the
 *     person's composer on every tick.
 *   a cap the owner RAISED
 *     arm it again and carry the turns already spent, which is what makes
 *     "Give it 10 more turns" mean ten more rather than a whole new budget.
 *   paused
 *     clear the goal and REMEMBER it, because Resume has to arm the same one.
 *   resumed with the switch OFF, on a goal this lane is reporting on
 *     arm the remembered condition again. The switch is off on the mission a
 *     goal a person typed gets, and the owner's Pause cleared that goal, so
 *     without this their Resume would leave the runtime with nothing to work
 *     toward and the card still checking for a verdict that never comes.
 *   abandoned, completed or failed, and NOT this daemon's own write
 *     clear and forget: the person closed the mission the goal was for.
 *   this daemon's OWN completion
 *     nothing. A goal that met its condition closed itself in the runtime
 *     already, and typing a clear for it would put "No goal set" into the
 *     person's terminal for no reason.
 *   any frame about another mission
 *     nothing, ever. A goal belongs to the mission it is held for, and "this
 *     mission" means the one this lane holds a goal for whichever way it got
 *     one: the owner's switch armed some, a person's own /goal derived the
 *     rest, and both answer to the same buttons.
 */
export function goalCommandForMissionFrame(input: {
  frame: MissionFrame
  mission: MissionSnapshot
  selfAuthored: boolean
  armed: GoalArmRecord | null
  reporting?: GoalReportRecord | null
  /** An arm this daemon has typed for some mission and not yet had answered. */
  pending?: GoalPendingArm | null
}): GoalCommand {
  const { frame, mission, selfAuthored, armed } = input
  const reporting = input.reporting ?? null
  const pending = input.pending ?? null
  // The goal this lane holds FOR THIS MISSION, whoever typed it. The arm
  // record answers for a goal the owner's switch armed; the report record
  // answers for one a person typed in their own terminal, which has a derived
  // mission and no arm record at all.
  const held =
    armed !== null && armed.missionId === mission.id
      ? armed
      : reporting !== null && reporting.missionId === mission.id
        ? reporting
        : null
  const ours = held !== null

  switch (frame) {
    case 'mission_created':
    case 'mission_resumed':
    case 'mission_updated': {
      // An arm for this mission is in flight: already typed, not yet
      // answered. Both arming routes below read `live`, and `live` cannot
      // tell "arming" from "dropped", so neither may decide anything until
      // the record is released.
      if (pending !== null && pending.missionId === mission.id) return NONE
      if (mission.status !== 'active') return NONE
      if (mission.keepWorking !== true) {
        // The switch is off, so the mission itself asks for no goal. A Resume
        // is the one exception: this lane cleared a goal it was reporting on
        // when the owner paused, and their Resume puts the same one back.
        if (frame !== 'mission_resumed' || held === null) return NONE
        if (held.condition === '' || held.live) return NONE
        return {
          kind: 'arm',
          missionId: mission.id,
          condition: held.condition,
          turnCap: held.turnCap,
          turnsBefore: held.turns,
        }
      }
      const condition = goalConditionFor(mission)
      if (condition === null) return NONE
      const turnCap = capOf(mission)
      if (held === null) {
        return { kind: 'arm', missionId: mission.id, condition, turnCap, turnsBefore: 0 }
      }
      const raised =
        turnCap !== null && (held.turnCap === null || turnCap > held.turnCap)
      const same = held.condition === condition
      if (held.live && same && !raised) return NONE
      return {
        kind: 'arm',
        missionId: mission.id,
        condition,
        turnCap,
        turnsBefore: held.turns,
      }
    }

    case 'mission_paused':
      return ours ? { kind: 'clear', forget: false } : NONE

    case 'mission_abandoned':
    case 'mission_completed':
    case 'mission_failed':
      if (!ours || selfAuthored) return NONE
      return { kind: 'clear', forget: true }

    default:
      return NONE
  }
}

/**
 * Does this frame stop the arm that is in flight.
 *
 * It answers for the PENDING record only, and it is the same judgement the
 * clear above makes: a frame marks the record exactly when it asks for a
 * clear, with the same meaning of forget, which is pinned by a test rather
 * than left to two readers agreeing by eye. The reason it is a second answer
 * at all is that the clear has nowhere to land yet, and the record is the
 * only thing that outlives the window.
 */
export function goalPendingStopFor(input: {
  frame: MissionFrame
  mission: MissionSnapshot
  selfAuthored: boolean
  pending: GoalPendingArm | null
}): GoalPendingStop | null {
  const pending = input.pending
  if (pending === null || pending.missionId !== input.mission.id) return null
  switch (input.frame) {
    case 'mission_paused':
      return 'paused'

    case 'mission_abandoned':
    case 'mission_completed':
    case 'mission_failed':
      // This daemon's own completion is not the owner stopping anything: a
      // goal that met its condition closed itself in the runtime already.
      return input.selfAuthored ? null : 'cleared'

    default:
      return null
  }
}

/** What a set sentinel is answering: the arm as it was typed, or an arm the
 *  owner stopped while it was in the air. */
export type GoalSentinelAction =
  | { kind: 'attach' }
  | { kind: 'stop'; stopped: GoalPendingStop }

/**
 * What the lane does with the goal a set sentinel just announced.
 *
 * `stop` is the owner's Pause or Set aside being enforced at the only moment
 * it can be: the goal exists as of this record and not before it, so this is
 * where the clear they asked for is finally typed and where the mission they
 * stopped is NOT taken back on. Everything else attaches, which is every
 * ordinary arm and every goal a person typed in their own terminal.
 *
 * Matched on the condition, because that is all a sentinel carries and it is
 * what says which arm this answers: a newer goal that superseded the stopped
 * one must not inherit its stop.
 */
export function goalSentinelActionFor(input: {
  condition: string
  pending: GoalPendingArm | null
}): GoalSentinelAction {
  const pending = input.pending
  if (pending === null) return { kind: 'attach' }
  const stopped = pending.stopped ?? null
  if (stopped === null) return { kind: 'attach' }
  if (pending.condition !== input.condition) return { kind: 'attach' }
  return { kind: 'stop', stopped }
}

// ── A goal a person typed gets a mission of its own ──────────────────────────

/** The create body for a goal nobody armed from the app. */
export interface GoalMissionCreateBody {
  title: string
  doneWhen: string
  origin: 'derived'
  /** Present ONLY when a chat was resolved. Never null: the backend runs
   *  whitelist: true, so a null is stripped in silence and the mission would
   *  land in the main chat with nothing to say it moved. */
  chatId?: number
}

export type GoalMissionCreateResult =
  | { ok: true; body: GoalMissionCreateBody }
  | { ok: false; error: string }

/**
 * The mission a goal a PERSON typed into their own terminal gets.
 *
 * It is `derived` because it came from the agent's own runtime and not from
 * the owner's Start form, which is the same word Codex's plan lane uses and
 * the word the server reads when it decides the owner cannot edit it. There
 * are no mini goals: the condition IS the whole test, and it rides `doneWhen`
 * so the card reads the way the owner's own Done when line reads. This is the
 * whole of the Windows story: no switch, and everything else.
 */
export function buildGoalMissionCreateBody(
  condition: string,
  chatId: string | number | null,
): GoalMissionCreateResult {
  const clean = oneLine(condition)
  if (clean === '') {
    return { ok: false, error: 'a goal needs a condition before it can have a mission.' }
  }
  const body: GoalMissionCreateBody = {
    title: cut(clean, MISSION_TITLE_MAX),
    doneWhen: cut(clean, MISSION_DONE_WHEN_MAX),
    origin: 'derived',
  }
  const numeric = Number(chatId)
  if (chatId != null && chatId !== '' && Number.isInteger(numeric) && numeric > 0) {
    body.chatId = numeric
  }
  return { ok: true, body }
}
