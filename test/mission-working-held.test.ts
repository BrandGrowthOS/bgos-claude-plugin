/**
 * Held working marks (KC 2026-11-17 1048 msg 241497).
 *
 * THE GAP. set_goal_working marks goals so the mission card animates them,
 * and the daemon cleared every mark when the agent's turn ended (Stop,
 * SessionEnd, a new prompt) or after 15 minutes without tool activity. An
 * agent that runs workers in the background between turns saw its card go
 * blank seconds after it marked its goals. The rule: every worker that serves
 * a goal shows on that goal while it runs.
 *
 * THE FIX. set_goal_working takes an optional hold. A held mark is kept by
 * the daemon for background work: Stop, SessionEnd, a new prompt and idle
 * time leave it on, the daemon's sweep refreshes it every 10 minutes so the
 * server's 30 minute lapse never reads it as stale, and it ends only when its
 * hold runs out, when the agent sends working: false, or when the goal is
 * ticked. A mark sent without a hold behaves exactly as before.
 *
 * Run with: npx tsx --test test/mission-working-held.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMissionWorkingTracker, MISSION_WORKING_SWEEP_MS } from '../lib/mission-working.ts'

const minute = 60_000
const scope = { sessionId: 'session-a', missionId: 77, goalId: 3, headers: { 'X-BGOS-Acting-User': 'user_recipient' } }
const openMission = (done: number[] = [], status = 'active', ids = [2, 3, 4]) => ({
  id: 77,
  status,
  miniGoals: ids.map(id => ({ id, done: done.includes(id) })),
})

function rig() {
  let now = 1_000_000
  let failure = 0
  const calls: Array<{ goalId: number; working: boolean; actor: string | undefined }> = []
  const tracker = createMissionWorkingTracker({
    now: () => now,
    isArmed: () => true,
    patch: async (s, working) => {
      calls.push({ goalId: s.goalId, working, actor: s.headers['X-BGOS-Acting-User'] })
      if (failure) throw Object.assign(new Error('refused'), { status: failure })
      return { mission: openMission() }
    },
  })
  const event = (name: string, sessionId = scope.sessionId) =>
    tracker.onHook({ hook_event_name: name, session_id: sessionId, tool_name: 'Bash' }, now)
  /** Run the daemon's 30 second sweep until `ms` has passed, as the real timer does. */
  const idle = async (ms: number) => {
    const end = now + ms
    while (now < end) {
      now = Math.min(end, now + MISSION_WORKING_SWEEP_MS)
      await tracker.sweep()
    }
  }
  return {
    tracker, calls, event, idle,
    advance: (ms: number) => { now += ms },
    setFailure: (status: number) => { failure = status },
    bodies: () => calls.map(c => c.working),
  }
}

test('a held mark survives Stop, SessionEnd and a new prompt', async () => {
  const r = rig()
  await r.tracker.mark({ ...scope, working: true, holdMs: 120 * minute })
  for (const boundary of ['Stop', 'SessionEnd', 'UserPromptSubmit']) await r.event(boundary)
  assert.deepEqual(r.bodies(), [true], 'no turn boundary may clear a held mark')
  // Still owned after the boundaries: the daemon keeps it fresh on its own.
  await r.idle(10 * minute)
  assert.deepEqual(r.bodies(), [true, true])
  assert.equal(r.calls.at(-1)?.actor, 'user_recipient', 'a refresh keeps the original actor')
})

test('a held mark survives idle time: the sweep refreshes it every 10 minutes and never clears it inside the hold', async () => {
  const r = rig()
  await r.tracker.mark({ ...scope, working: true, holdMs: 120 * minute })
  await r.event('Stop')
  await r.idle(120 * minute - 1)
  // The mark at 0, then one refresh at 10, 20, ... 110 minutes: the server's
  // 30 minute lapse never sees it stale, and the 15 minute idle rule never fires.
  assert.deepEqual(r.bodies(), Array(12).fill(true))
})

test('a held mark lapses at its hold time, not before', async () => {
  const r = rig()
  await r.tracker.mark({ ...scope, working: true, holdMs: 30 * minute })
  await r.event('Stop')
  await r.idle(30 * minute - 1)
  assert.ok(!r.bodies().includes(false), 'still held one millisecond before the hold ends')
  await r.idle(1)
  assert.equal(r.bodies().at(-1), false, 'the hold ran out, so the mark is cleared')
  const count = r.calls.length
  await r.idle(60 * minute)
  await r.event('PreToolUse')
  await r.event('Stop')
  assert.equal(r.calls.length, count, 'a lapsed hold is forgotten: nothing refreshes or clears it again')
})

test('calling again with a hold refreshes the hold time', async () => {
  const r = rig()
  await r.tracker.mark({ ...scope, working: true, holdMs: 30 * minute })
  await r.idle(20 * minute)
  await r.tracker.mark({ ...scope, working: true, holdMs: 30 * minute })
  await r.idle(15 * minute)
  assert.ok(!r.bodies().includes(false), 'the second call moved the end to 50 minutes')
  await r.idle(15 * minute)
  assert.equal(r.bodies().at(-1), false)
})

test('working: false clears a held mark at once and nothing revives it', async () => {
  const r = rig()
  await r.tracker.mark({ ...scope, working: true, holdMs: 120 * minute })
  await r.tracker.mark({ ...scope, working: false })
  assert.deepEqual(r.bodies(), [true, false])
  await r.idle(30 * minute)
  await r.event('PreToolUse')
  await r.event('Stop')
  assert.deepEqual(r.bodies(), [true, false])
})

test('a tick ends a held mark: the ticked goal is dropped with no write, and nothing refreshes or clears it later', async () => {
  const r = rig()
  await r.tracker.mark({ ...scope, working: true, holdMs: 120 * minute })
  await r.tracker.mark({ ...scope, goalId: 4, working: true, holdMs: 120 * minute })
  // The server ends the mark on a tick by itself; the daemon only forgets it.
  r.tracker.noteMission(openMission([3]))
  await r.idle(10 * minute)
  assert.deepEqual(r.calls.map(c => [c.goalId, c.working]), [[3, true], [4, true], [4, true]],
    'goal 4 is still held and refreshed, the ticked goal 3 is not')
  await r.event('Stop')
  await r.idle(120 * minute)
  assert.ok(!r.calls.some(c => c.goalId === 3 && !c.working), 'a ticked goal takes no clear')
})

test('a cancelled goal or a closed mission ends a held mark the same way', async () => {
  for (const mission of [openMission([], 'active', [2, 4]), openMission([], 'completed'), openMission([], 'abandoned'), openMission([], 'failed')]) {
    const r = rig()
    await r.tracker.mark({ ...scope, working: true, holdMs: 120 * minute })
    r.tracker.noteMission(mission)
    await r.idle(30 * minute)
    assert.deepEqual(r.bodies(), [true], `${mission.status} with goals ${mission.miniGoals.map(g => g.id)}`)
  }
})

test('a mission frame that is malformed, for another mission, or with the goal still open changes nothing', async () => {
  const r = rig()
  await r.tracker.mark({ ...scope, working: true, holdMs: 120 * minute })
  for (const frame of [null, 'x', { id: 77 }, { id: 77, miniGoals: 'no' }, { ...openMission([3]), id: 78 }, openMission(), openMission([], 'paused')]) {
    assert.doesNotThrow(() => r.tracker.noteMission(frame))
  }
  await r.idle(10 * minute)
  assert.deepEqual(r.bodies(), [true, true])
})

test('a ticked goal missed by every frame still ends the hold: the refresh is refused (409) and the goal is dropped', async () => {
  const r = rig()
  await r.tracker.mark({ ...scope, working: true, holdMs: 120 * minute })
  r.setFailure(409)
  await r.idle(10 * minute)
  r.setFailure(0)
  await r.idle(110 * minute)
  assert.deepEqual(r.bodies(), [true, true], 'one refused refresh, then nothing')
})

test('an unheld mark still clears on Stop, SessionEnd and a new prompt (unchanged)', async () => {
  for (const boundary of ['Stop', 'SessionEnd', 'UserPromptSubmit']) {
    const r = rig()
    await r.tracker.mark({ ...scope, working: true })
    await r.event(boundary)
    assert.deepEqual(r.bodies(), [true, false], boundary)
  }
})

test('an unheld mark still clears after 15 minutes without tool activity, and the sweep alone never refreshes it (unchanged)', async () => {
  const r = rig()
  await r.tracker.mark({ ...scope, working: true })
  await r.idle(15 * minute - 1)
  assert.deepEqual(r.bodies(), [true])
  await r.idle(1)
  assert.deepEqual(r.bodies(), [true, false])
})

test('a tick frame leaves an unheld mark to today\'s rules', async () => {
  const r = rig()
  await r.tracker.mark({ ...scope, working: true })
  r.tracker.noteMission(openMission([3]))
  await r.event('Stop')
  assert.deepEqual(r.bodies(), [true, false])
})

test('calling again without a hold makes the mark an ordinary one, so Stop clears it', async () => {
  const r = rig()
  await r.tracker.mark({ ...scope, working: true, holdMs: 120 * minute })
  await r.tracker.mark({ ...scope, working: true })
  await r.event('Stop')
  assert.deepEqual(r.bodies(), [true, true, false])
})

test('a held mark from a session not bound to the hook intake is still kept and lapses at its hold time', async () => {
  const r = rig()
  await r.tracker.mark({ ...scope, sessionId: '', working: true, holdMs: 20 * minute })
  await r.event('Stop')
  await r.idle(20 * minute)
  assert.deepEqual(r.bodies(), [true, true, false], 'refreshed at 10 minutes, cleared at 20')
})

test('a held mark from another session is not touched by this session\'s Stop or by a stranger\'s', async () => {
  const r = rig()
  await r.tracker.mark({ ...scope, working: true, holdMs: 120 * minute })
  await r.event('Stop', 'session-b')
  await r.event('Stop')
  assert.deepEqual(r.bodies(), [true])
})

test('stand-down still clears a held mark: no daemon is left to keep it fresh', async () => {
  const r = rig()
  await r.tracker.mark({ ...scope, working: true, holdMs: 120 * minute })
  await r.tracker.stop()
  assert.deepEqual(r.bodies(), [true, false])
})
