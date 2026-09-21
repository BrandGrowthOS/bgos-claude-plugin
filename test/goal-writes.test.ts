/**
 * The goal lane's judgement, as a pure decision (stage 6 of the Mission
 * program, task C2).
 *
 * The read half (lib/goal-status.ts, lib/goal-tail.ts, lib/goal-cap.ts) turns
 * the session transcript into records, effects and a stop. This module is the
 * WRITE half's judgement: which mission write one effect deserves, what the
 * owner's own mission frames tell the lane to do with the native goal, and
 * what a goal a person typed in their own terminal gets its own mission card
 * from. server.ts is left with the wiring, and the wiring has no opinions.
 *
 * Mutations these tests are proven against (task C2):
 *   - put a workingMs on a not met check   -> the live check test goes red
 *   - drop turnsBefore from the count      -> the raised cap count test red
 *   - write progress for a met verdict     -> the completion test red
 *   - send 'met' on the fail write         -> the impossible test red
 *   - complete the mission on a clear      -> the cleared test red
 *   - narrate a clear this daemon injected -> the self cleared test red
 *   - write anything on a set sentinel     -> the attach test red
 *   - default a missing cap to 20          -> the no cap test red
 *   - clip the reason with the feed limit  -> the judge words test red
 *   - prefer the title over the done when  -> the condition test red
 *   - arm on a mission with the switch off -> the arm test red
 *   - restart the count on a raised cap    -> the carry test red
 *   - arm again on an unchanged frame      -> the quiet frame test red
 *   - forget the goal on a pause           -> the resume test red
 *   - clear on the daemon's own completion -> the self write test red
 *   - read the mission from the arm record -> the typed goal control tests red
 *   - drop the pending arm check            -> the in flight frame test red
 *   - block every mission while one arms    -> the other mission test red
 *   - never re arm a goal that looks dead   -> the released record test red
 *   - re arm the condition already armed    -> the never confirmed test red
 *   - let a Pause pass an arm in flight by  -> the stop marks the record red
 *   - attach a sentinel whose record is     -> the stop wins at the sentinel
 *     marked stopped                           test red
 *   - mark a frame that types no clear      -> the no drift test red
 *   - drop doneWhen from the derived create-> the typed goal test red
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import type { GoalEffect } from '../lib/goal-status.ts'
import { MISSION_FRAMES } from '../lib/mission-events.ts'
import type { MissionSnapshot } from '../lib/missions.ts'
import {
  GOAL_CLEARED_FEED_TEXT,
  buildGoalMissionCreateBody,
  goalCommandForMissionFrame,
  goalConditionFor,
  goalPendingStopFor,
  goalSentinelActionFor,
  goalWriteFor,
  type GoalArmRecord,
  type GoalPendingArm,
  type GoalReportRecord,
} from '../lib/goal-writes.ts'

const CONDITION = 'the file gate.txt exists and contains the word done'
const REASON = 'gate.txt is still empty, write the word done into it'

const check = (over: Partial<Extract<GoalEffect, { kind: 'goal_check' }>> = {}) =>
  ({
    kind: 'goal_check',
    condition: CONDITION,
    verdict: 'not_yet',
    reason: REASON,
    check: 1,
    at: 1_700_000_000_000,
    ...over,
  }) as GoalEffect

const met = (over: Record<string, unknown> = {}) =>
  ({
    kind: 'goal_met',
    condition: CONDITION,
    reason: 'gate.txt now contains the word done',
    check: 3,
    iterations: 3,
    durationMs: 8490,
    tokens: 542,
    at: 1_700_000_000_000,
    ...over,
  }) as GoalEffect

const impossible = (over: Record<string, unknown> = {}) =>
  ({
    kind: 'goal_impossible',
    condition: CONDITION,
    reason: 'the folder is read only, so the file can never be written',
    check: 2,
    iterations: 2,
    durationMs: 4100,
    tokens: 220,
    at: 1_700_000_000_000,
    ...over,
  }) as GoalEffect

const mission = (over: Partial<MissionSnapshot> = {}): MissionSnapshot => ({
  id: 77,
  title: 'Get the gate file written',
  status: 'active',
  miniGoals: [],
  doneWhen: CONDITION,
  keepWorking: true,
  turnCap: 20,
  ...over,
})

const armed = (over: Partial<GoalArmRecord> = {}): GoalArmRecord => ({
  missionId: 77,
  condition: CONDITION,
  turnCap: 20,
  turns: 0,
  live: true,
  ...over,
})

// ── One effect, one write ────────────────────────────────────────────────────

test('a not met check reports the turns and NO working time, because none was counted', () => {
  // The runtime reports no elapsed time at all until the goal closes: a not
  // met row carries no iterations, no durationMs and no tokens. Sending a
  // time here would mean working one out from the clock, which is the exact
  // lie this stage exists to prevent.
  const write = goalWriteFor(check(), { turnCap: 20, turnsBefore: 0 })
  assert.equal(write.route, 'progress')
  if (write.route !== 'progress') return
  assert.equal(write.body.runReport?.workingMs, undefined)
  assert.deepEqual(write.body.runReport, { turnsUsed: 1, turnCap: 20 })
  assert.deepEqual(write.body.verdict, {
    verdict: 'not_yet',
    reason: REASON,
    by: 'checker',
    check: 1,
  })
  assert.deepEqual(write.body.feedEntry, { kind: 'checked', text: `Not yet: ${REASON}` })
})

test('the turns a raised cap already spent are carried, never restarted at one', () => {
  // "Give it 10 more turns" raises the cap and arms the same goal again, and
  // the runtime starts its own count over at the new set sentinel. Reporting
  // that raw count would drop the owner's card from "20 of 20" back to
  // "1 of 30", which reads as work that never happened.
  const write = goalWriteFor(check({ check: 1 }), { turnCap: 30, turnsBefore: 20 })
  assert.equal(write.route, 'progress')
  if (write.route !== 'progress') return
  assert.equal(write.body.runReport?.turnsUsed, 21)
  assert.equal(write.body.verdict?.check, 21)
})

test('a met verdict completes the mission with the runtime own turns and its time', () => {
  const write = goalWriteFor(met(), { turnCap: 20, turnsBefore: 0 })
  assert.equal(write.route, 'complete')
  if (write.route !== 'complete') return
  assert.equal(write.body.verdict?.verdict, 'met')
  assert.equal(write.body.verdict?.by, 'checker')
  assert.equal(write.body.verdict?.check, 3)
  assert.deepEqual(write.body.runReport, { turnsUsed: 3, turnCap: 20, workingMs: 8490 })
  // The judge's own words are what the owner reads as the summary, so an app
  // that knows nothing about verdicts still says why it closed.
  assert.equal(write.body.summary, 'gate.txt now contains the word done')
})

test('a cannot be done verdict FAILS the mission and keeps the judge reason as the summary', () => {
  const write = goalWriteFor(impossible(), { turnCap: 20, turnsBefore: 0 })
  assert.equal(write.route, 'fail')
  if (write.route !== 'fail') return
  assert.equal(write.body.verdict?.verdict, 'impossible')
  assert.equal(
    write.body.summary,
    'the folder is read only, so the file can never be written',
  )
  assert.deepEqual(write.body.runReport, { turnsUsed: 2, turnCap: 20, workingMs: 4100 })
})

test('a goal the person cleared writes ONE plain line and leaves the mission open', () => {
  // A cleared goal is not a finished mission and not a set aside one: the
  // person stopped the loop, and they may set another goal in a moment.
  const write = goalWriteFor(
    { kind: 'goal_cleared', condition: CONDITION, at: 1_700_000_000_000 },
    { turnCap: 20, turnsBefore: 4 },
  )
  assert.equal(write.route, 'progress')
  if (write.route !== 'progress') return
  assert.deepEqual(write.body.feedEntry, { kind: 'checked', text: GOAL_CLEARED_FEED_TEXT })
  assert.equal(write.body.verdict, undefined)
  assert.equal(write.body.runReport, undefined)
})

test('a clear THIS daemon injected is not narrated back to the owner', () => {
  // The cap, the stall rule, a pause and an abandon all clear the goal by
  // typing the same keystrokes, and each of those already tells the owner
  // what happened in its own words. The runtime answers every one of them
  // with a clear sentinel, and printing "the goal was cleared" under the
  // sentence that just explained why would read as two separate events.
  const write = goalWriteFor(
    { kind: 'goal_cleared', condition: CONDITION, at: 1_700_000_000_000 },
    { turnCap: 20, turnsBefore: 4, selfCleared: true },
  )
  assert.equal(write.route, 'none')
})

test('a set sentinel writes nothing: a goal is ATTACHED to a mission, not reported', () => {
  const write = goalWriteFor(
    { kind: 'goal_set', condition: CONDITION, at: 1_700_000_000_000 },
    { turnCap: 20, turnsBefore: 0 },
  )
  assert.equal(write.route, 'none')
})

test('a goal nobody capped sends no cap, because no owner set one', () => {
  // A goal a person typed in their own terminal has no Keep working switch
  // behind it. It still shows its last check and its turns; what it must not
  // show is a limit the owner never chose.
  const write = goalWriteFor(check(), { turnCap: null, turnsBefore: 0 })
  assert.equal(write.route, 'progress')
  if (write.route !== 'progress') return
  assert.deepEqual(write.body.runReport, { turnsUsed: 1 })
  assert.equal('turnCap' in write.body.runReport!, false)
})

test('the feed line is cut to what the feed carries, and the verdict keeps the judge words', () => {
  // The two limits are different (200 on a feed line, 240 on a verdict
  // reason) and the verdict is the one the owner reads as Last check, so
  // cutting the reason to the feed's limit would shorten the sentence that
  // matters to save the one that does not.
  const long = 'x'.repeat(230)
  const write = goalWriteFor(check({ reason: long }), { turnCap: 20, turnsBefore: 0 })
  assert.equal(write.route, 'progress')
  if (write.route !== 'progress') return
  assert.equal(write.body.verdict?.reason, long)
  assert.equal(write.body.feedEntry?.text.length, 200)
  assert.ok(write.body.feedEntry?.text.startsWith('Not yet: xxx'))
})

// ── The owner's own mission frames ───────────────────────────────────────────

test('the owner Done when line is the condition, and the title is the fallback', () => {
  assert.equal(goalConditionFor(mission()), CONDITION)
  assert.equal(
    goalConditionFor(mission({ doneWhen: '   ' })),
    'Get the gate file written',
  )
  assert.equal(goalConditionFor(mission({ doneWhen: null, title: '  ' })), null)
})

test('a mission created with Keep working ON arms the goal, and one with it off does not', () => {
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_created',
      mission: mission(),
      selfAuthored: false,
      armed: null,
    }),
    { kind: 'arm', missionId: 77, condition: CONDITION, turnCap: 20, turnsBefore: 0 },
  )
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_created',
      mission: mission({ keepWorking: false }),
      selfAuthored: false,
      armed: null,
    }),
    { kind: 'none' },
  )
})

test('a raised cap arms the same goal again and CARRIES the turns already spent', () => {
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_updated',
      mission: mission({ turnCap: 30 }),
      selfAuthored: false,
      armed: armed({ turns: 20 }),
    }),
    { kind: 'arm', missionId: 77, condition: CONDITION, turnCap: 30, turnsBefore: 20 },
  )
})

test('a frame that changes nothing about the goal arms nothing', () => {
  // Every mission write emits a frame, so an unguarded re arm would type a
  // fresh /goal into the person's composer on every tick.
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_updated',
      mission: mission(),
      selfAuthored: false,
      armed: armed({ turns: 6 }),
    }),
    { kind: 'none' },
  )
  // A goal the runtime is no longer holding IS re armed, which is what covers
  // a daemon that restarted while the mission stayed open.
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_updated',
      mission: mission(),
      selfAuthored: false,
      armed: armed({ turns: 6, live: false }),
    }),
    { kind: 'arm', missionId: 77, condition: CONDITION, turnCap: 20, turnsBefore: 6 },
  )
})

test('Pause clears the goal and REMEMBERS it; Resume arms the same one again', () => {
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_paused',
      mission: mission({ status: 'paused' }),
      selfAuthored: false,
      armed: armed({ turns: 6 }),
    }),
    { kind: 'clear', forget: false },
  )
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_resumed',
      mission: mission(),
      selfAuthored: false,
      armed: armed({ turns: 6, live: false }),
    }),
    { kind: 'arm', missionId: 77, condition: CONDITION, turnCap: 20, turnsBefore: 6 },
  )
})

test('Set aside clears the goal and FORGETS it', () => {
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_abandoned',
      mission: mission({ status: 'abandoned' }),
      selfAuthored: false,
      armed: armed({ turns: 6 }),
    }),
    { kind: 'clear', forget: true },
  )
})

test('the owner Mark done clears the goal, and the daemon own completion does not', () => {
  // A goal that met its condition closed itself in the runtime already, and
  // the completion that followed is this daemon's own write. Typing a clear
  // for it would put "No goal set" into the person's terminal for nothing.
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_completed',
      mission: mission({ status: 'completed' }),
      selfAuthored: false,
      armed: armed({ turns: 6 }),
    }),
    { kind: 'clear', forget: true },
  )
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_completed',
      mission: mission({ status: 'completed' }),
      selfAuthored: true,
      armed: armed({ turns: 6 }),
    }),
    { kind: 'none' },
  )
})

test('a frame about SOMEBODY ELSE mission never touches the goal this lane holds', () => {
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_abandoned',
      mission: mission({ id: 99, status: 'abandoned' }),
      selfAuthored: false,
      armed: armed({ turns: 6 }),
    }),
    { kind: 'none' },
  )
})

// ── The goal this lane REPORTS on, which nobody armed from the app ───────────

// A goal a person typed into their own terminal gets a derived mission and no
// arm record at all, and the owner sees the same Pause, Resume and Set aside
// on it as on any other open mission of this agent, because the daemon
// declared it can enforce them. What it can enforce IS clearing the native
// goal, so every one of those frames has to be read against the mission this
// lane is REPORTING on, not only against the one the owner's switch armed.

const reported = (over: Partial<GoalReportRecord> = {}): GoalReportRecord => ({
  missionId: 42,
  condition: CONDITION,
  turnCap: null,
  turns: 4,
  live: true,
  ...over,
})

const typed = (over: Partial<MissionSnapshot> = {}): MissionSnapshot =>
  mission({ id: 42, keepWorking: false, turnCap: null, ...over })

test('Pause and Set aside reach a goal a PERSON typed, which this lane never armed', () => {
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_paused',
      mission: typed({ status: 'paused' }),
      selfAuthored: false,
      armed: null,
      reporting: reported(),
    }),
    { kind: 'clear', forget: false },
  )
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_abandoned',
      mission: typed({ status: 'abandoned' }),
      selfAuthored: false,
      armed: null,
      reporting: reported(),
    }),
    { kind: 'clear', forget: true },
  )
})

test('Resume arms the remembered condition again with the switch never on', () => {
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_resumed',
      mission: typed(),
      selfAuthored: false,
      armed: null,
      reporting: reported({ live: false }),
    }),
    { kind: 'arm', missionId: 42, condition: CONDITION, turnCap: null, turnsBefore: 4 },
  )
  // A Resume and nothing else: a create or an update with the switch off
  // arms nothing, which is what keeps a mission nobody switched on quiet.
  for (const frame of ['mission_created', 'mission_updated'] as const) {
    assert.deepEqual(
      goalCommandForMissionFrame({
        frame,
        mission: typed(),
        selfAuthored: false,
        armed: null,
        reporting: reported({ live: false }),
      }),
      { kind: 'none' },
    )
  }
  // And never typed twice: a runtime already holding the condition is left
  // alone, exactly as an armed goal is.
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_resumed',
      mission: typed(),
      selfAuthored: false,
      armed: null,
      reporting: reported(),
    }),
    { kind: 'none' },
  )
})

test('Give it 10 more turns on a goal nobody armed CARRIES the turns already spent', () => {
  // The owner's keep working route is allowed on a derived mission, so the
  // gold button lands here too. Reading the arm record alone dropped the card
  // from 20 of 20 back to 1 of 30, which reads as work that never happened.
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_updated',
      mission: typed({ keepWorking: true, turnCap: 30 }),
      selfAuthored: false,
      armed: null,
      reporting: reported({ turns: 20, live: false }),
    }),
    { kind: 'arm', missionId: 42, condition: CONDITION, turnCap: 30, turnsBefore: 20 },
  )
})

test('a frame about somebody else mission never reaches the goal this lane reports on', () => {
  for (const frame of ['mission_paused', 'mission_resumed', 'mission_abandoned'] as const) {
    assert.deepEqual(
      goalCommandForMissionFrame({
        frame,
        mission: mission({ id: 99, keepWorking: false, turnCap: null }),
        selfAuthored: false,
        armed: null,
        reporting: reported(),
      }),
      { kind: 'none' },
    )
  }
})

// ── An arm this daemon has typed, before the runtime has answered ────────────

// `live` is folded from the TRANSCRIPT, and the transcript says nothing about
// a goal until its set sentinel is read: injected keystrokes queue behind a
// turn that is already running, and the confirmation gives the sentinel up to
// four minutes. For that whole window a goal that is ARMING looks exactly like
// one the runtime dropped, and the backend emits mission_updated on EVERY
// progress write, so the rule that re arms a dropped goal typed a SECOND
// /goal into the person's composer and started a second confirmation watcher,
// again on the next frame, for as long as the window lasted. The pending
// record is the lane saying "I have already typed this one", and it is the
// only thing that tells the two apart.

const pendingArm = (over: Partial<GoalPendingArm> = {}): GoalPendingArm => ({
  missionId: 77,
  condition: CONDITION,
  ...over,
})

test('a frame landing while the arm is in flight types nothing, however dead the goal looks', () => {
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_updated',
      mission: mission(),
      selfAuthored: false,
      armed: armed({ turns: 6, live: false }),
      pending: pendingArm(),
    }),
    { kind: 'none' },
  )
  // A cap the owner raised inside the window does not get past it either: the
  // arm already typed is what must not be doubled, and the raise is read
  // again on the next frame once the sentinel has landed.
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_updated',
      mission: mission({ turnCap: 30 }),
      selfAuthored: false,
      armed: armed({ turns: 6, live: false }),
      pending: pendingArm(),
    }),
    { kind: 'none' },
  )
  // Nor does a Resume on a goal a person typed, which has the switch off and
  // arms from the report record instead.
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_resumed',
      mission: typed(),
      selfAuthored: false,
      armed: null,
      reporting: reported({ live: false }),
      pending: pendingArm({ missionId: 42 }),
    }),
    { kind: 'none' },
  )
  // A stop is NOT a second goal, so the owner's own Pause still reaches it
  // while the arm is in flight. Making them wait four minutes to stop a
  // runtime that is looping would be the same defect wearing the other hat.
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_paused',
      mission: mission({ status: 'paused' }),
      selfAuthored: false,
      armed: armed({ turns: 6, live: false }),
      pending: pendingArm(),
    }),
    { kind: 'clear', forget: false },
  )
})

test('an arm in flight for ONE mission never stops another mission arming its own', () => {
  // The record is held per mission on purpose. A goal for another mission
  // supersedes this one in the runtime, which is a real thing the owner can
  // ask for, and it is the serialisation in server.ts that keeps two arms for
  // the SAME mission from overlapping.
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_created',
      mission: mission({ id: 91 }),
      selfAuthored: false,
      armed: null,
      pending: pendingArm(),
    }),
    { kind: 'arm', missionId: 91, condition: CONDITION, turnCap: 20, turnsBefore: 0 },
  )
})

test('the set sentinel releases the record, and the frame after it may arm again', () => {
  // attachGoalToMission clears the pending arm the moment the sentinel is
  // read, so the window closes on the runtime's answer and not on a timer.
  // What must survive is the lane's ability to re arm a goal the runtime
  // really did drop, which is what a daemon restarted mid mission depends on.
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_updated',
      mission: mission(),
      selfAuthored: false,
      armed: armed({ turns: 6, live: false }),
      pending: null,
    }),
    { kind: 'arm', missionId: 77, condition: CONDITION, turnCap: 20, turnsBefore: 6 },
  )
  // And the cap the owner raised while the arm was in flight is picked up
  // here, which is what makes the suppression above a delay and not a loss.
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_updated',
      mission: mission({ turnCap: 30 }),
      selfAuthored: false,
      armed: armed({ turns: 6 }),
      pending: null,
    }),
    { kind: 'arm', missionId: 77, condition: CONDITION, turnCap: 30, turnsBefore: 6 },
  )
})

test('an arm that never confirmed releases the record too, and what arms next is what the mission says NOW', () => {
  // The confirmation gives up after four minutes, tells the owner plainly,
  // and releases the record on its way out; that release is guarded in
  // test/mission-ws-wiring.test.ts, which is the only place that can see it.
  // This is the half that has to hold afterwards: the owner's next frame arms
  // the mission's CURRENT done when line, not the condition that failed to
  // arm, and it carries the checks already counted, because a re arm that
  // restarts at one reads as work that never happened.
  const rewritten = 'gate.txt exists and its first line is the word done'
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_updated',
      mission: mission({ doneWhen: rewritten }),
      selfAuthored: false,
      armed: armed({ turns: 12, live: false }),
      pending: null,
    }),
    { kind: 'arm', missionId: 77, condition: rewritten, turnCap: 20, turnsBefore: 12 },
  )
})

// ── The owner's stop, landing while the arm is still in flight ───────────────

// The clear a Pause types can only reach a goal the runtime is already
// holding, and inside the confirmation window there is none: the goal arrives
// AFTER the owner stopped the mission. Left there, the sentinel restored the
// mission id and the runtime carried on looping on a mission the owner had
// paused or set aside. So the stop is recorded ON the pending arm and settled
// at the sentinel, which is the first moment anything can act on it.

test("the owner's stop while an arm is in flight MARKS the record it cannot reach yet", () => {
  assert.equal(
    goalPendingStopFor({
      frame: 'mission_paused',
      mission: mission({ status: 'paused' }),
      selfAuthored: false,
      pending: pendingArm(),
    }),
    'paused',
  )
  // Set aside, Mark done and a failure are the same stop with nothing kept:
  // the mission the goal was for is closed, so the goal is forgotten too.
  for (const frame of ['mission_abandoned', 'mission_completed', 'mission_failed'] as const) {
    assert.equal(
      goalPendingStopFor({
        frame,
        mission: mission({ status: 'abandoned' }),
        selfAuthored: false,
        pending: pendingArm(),
      }),
      'cleared',
    )
  }
  // This daemon's OWN completion is not the owner stopping anything: a goal
  // that met its condition closed itself in the runtime already.
  assert.equal(
    goalPendingStopFor({
      frame: 'mission_completed',
      mission: mission({ status: 'completed' }),
      selfAuthored: true,
      pending: pendingArm(),
    }),
    null,
  )
  // A stop on another mission, and a stop with no arm in flight at all,
  // record nothing: there is no window to carry anything across.
  assert.equal(
    goalPendingStopFor({
      frame: 'mission_paused',
      mission: mission({ id: 91, status: 'paused' }),
      selfAuthored: false,
      pending: pendingArm(),
    }),
    null,
  )
  assert.equal(
    goalPendingStopFor({
      frame: 'mission_paused',
      mission: mission({ status: 'paused' }),
      selfAuthored: false,
      pending: null,
    }),
    null,
  )
})

test('a sentinel answering a record the owner stopped is a STOP, never an attach', () => {
  // This is the moment the goal exists, and the moment the owner's stop can
  // finally be enforced: no mission is taken, and the goal is cleared again.
  assert.deepEqual(
    goalSentinelActionFor({ condition: CONDITION, pending: pendingArm({ stopped: 'paused' }) }),
    { kind: 'stop', stopped: 'paused' },
  )
  assert.deepEqual(
    goalSentinelActionFor({ condition: CONDITION, pending: pendingArm({ stopped: 'cleared' }) }),
    { kind: 'stop', stopped: 'cleared' },
  )
  // An arm nobody stopped attaches, which is every ordinary arm.
  assert.deepEqual(
    goalSentinelActionFor({ condition: CONDITION, pending: pendingArm() }),
    { kind: 'attach' },
  )
  // A sentinel for a DIFFERENT condition is a different goal: the stopped
  // record is not what this one answers, and adopting its stop would clear a
  // goal the owner never stopped.
  assert.deepEqual(
    goalSentinelActionFor({
      condition: 'something else entirely',
      pending: pendingArm({ stopped: 'paused' }),
    }),
    { kind: 'attach' },
  )
  // And a goal a person typed in their own terminal has no record at all.
  assert.deepEqual(goalSentinelActionFor({ condition: CONDITION, pending: null }), {
    kind: 'attach',
  })
})

test('the mark and the clear never drift: a frame marks the record exactly when it clears', () => {
  // Two rules reading the same frames is how a lane rots. The mark exists to
  // carry a clear that could not land, so it must be taken on exactly the
  // frames that ask for one, with the same meaning of forget.
  for (const frame of MISSION_FRAMES) {
    for (const selfAuthored of [false, true]) {
      const shape = { mission: mission({ status: 'paused' }), selfAuthored, pending: pendingArm() }
      const command = goalCommandForMissionFrame({ frame, armed: armed(), ...shape })
      const stop = goalPendingStopFor({ frame, ...shape })
      assert.equal(
        command.kind === 'clear',
        stop !== null,
        `${frame} (selfAuthored ${selfAuthored}) marks the record and clears, or does neither`,
      )
      if (command.kind === 'clear') {
        assert.equal(
          command.forget,
          stop === 'cleared',
          `${frame} must forget the goal and the record together`,
        )
      }
    }
  }
})

// ── A goal a person typed gets a mission of its own ──────────────────────────

test('a typed goal gets a derived mission titled by the condition and done when it holds', () => {
  const built = buildGoalMissionCreateBody(CONDITION, '4403')
  assert.equal(built.ok, true)
  if (!built.ok) return
  assert.deepEqual(built.body, {
    title: CONDITION,
    doneWhen: CONDITION,
    origin: 'derived',
    chatId: 4403,
  })
})

test('a derived create names a chat only when there is one, and never sends a null', () => {
  // The backend runs whitelist: true, so a chatId of null is stripped in
  // silence and the mission lands in the main chat with nothing to say it
  // moved. Absent is the honest way to mean "the main chat".
  const built = buildGoalMissionCreateBody(CONDITION, null)
  assert.equal(built.ok, true)
  if (!built.ok) return
  assert.equal('chatId' in built.body, false)
})

test('a condition too long for a title or a done when line is cut for each, not refused', () => {
  const long = 'k'.repeat(400)
  const built = buildGoalMissionCreateBody(long, null)
  assert.equal(built.ok, true)
  if (!built.ok) return
  assert.equal(built.body.title.length, 200)
  assert.equal(built.body.doneWhen.length, 200)
})

test('a blank condition builds no mission at all', () => {
  const built = buildGoalMissionCreateBody('   ', null)
  assert.equal(built.ok, false)
})
