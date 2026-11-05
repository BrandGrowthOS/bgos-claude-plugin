import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMissionWorkingTracker } from '../lib/mission-working.ts'

const minute = 60_000
const scope = { sessionId: 'session-a', missionId: 77, goalId: 3, headers: { 'X-BGOS-Acting-User': 'user_recipient' } }

function rig() {
  let now = 1_000_000
  let armed = true
  let response: unknown = { mission: { id: 77 } }
  const writes: Array<{ missionId: number; goalId: number; working: boolean; headers: Record<string, string> }> = []
  const tracker = createMissionWorkingTracker({ now: () => now, isArmed: () => armed,
    patch: async (s, working) => { writes.push({ missionId: s.missionId, goalId: s.goalId, working, headers: s.headers }); return response },
  })
  return { tracker, writes, advance: (ms: number) => { now += ms }, setArmed: (value: boolean) => { armed = value },
    noMission: () => { response = {} },
    hook: (name: string, sessionId = scope.sessionId, at = now) => tracker.onHook({ hook_event_name: name, session_id: sessionId }, at),
  }
}

for (const hook of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse']) {
  test(`${hook} refreshes only chosen goals at the three-minute boundary, including parallel bursts`, async () => {
    const r = rig()
    await r.tracker.mark({ ...scope, working: true })
    await r.tracker.mark({ ...scope, goalId: 4, working: true })
    await r.tracker.mark({ ...scope, goalId: 5, working: false })
    r.advance(3 * minute - 1)
    await Promise.all(Array.from({ length: 20 }, () => r.hook(hook)))
    assert.equal(r.writes.length, 3)
    r.advance(1)
    await Promise.all(Array.from({ length: 20 }, () => r.hook(hook)))
    assert.deepEqual(r.writes.slice(3), [
      { missionId: 77, goalId: 3, working: true, headers: scope.headers },
      { missionId: 77, goalId: 4, working: true, headers: scope.headers },
    ])
    r.advance(3 * minute - 1)
    await r.hook(hook)
    assert.equal(r.writes.length, 5)
  })
}

test('hooks with no selected goal or no returned mission cannot invent a working mark', async () => {
  const r = rig()
  for (const name of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) await r.hook(name)
  await r.tracker.sweep()
  assert.equal(r.writes.length, 0)
  r.noMission()
  await r.tracker.mark({ ...scope, working: true })
  r.advance(3 * minute)
  for (const name of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse']) await r.hook(name)
  assert.equal(r.writes.filter(write => write.working).length, 1, 'only the explicit write may be sent')
})

test('Stop leaves the confirmed lease to lapse and late tools cannot refresh it', async () => {
  const r = rig()
  await r.tracker.mark({ ...scope, working: true })
  await r.hook('Stop')
  for (let i = 0; i < 40; i++) {
    r.advance(minute)
    await r.hook('PreToolUse')
    await r.hook('PostToolUse')
    await r.tracker.sweep()
  }
  assert.equal(r.writes.length, 1, 'Stop and all later tools/sweeps must leave the lease alone')
})

test('a newer prompt resumes the same explicit choices, while an older prompt cannot resume Stop', async () => {
  const r = rig()
  await r.tracker.mark({ ...scope, working: true })
  r.advance(minute)
  await r.hook('Stop')
  r.advance(3 * minute)
  await r.hook('UserPromptSubmit', scope.sessionId, 1_000_000)
  await r.hook('PreToolUse')
  assert.equal(r.writes.length, 1)
  await r.hook('UserPromptSubmit')
  assert.equal(r.writes.length, 2)
  assert.equal(r.writes.at(-1)?.working, true)
  await r.tracker.mark({ ...scope, working: false })
  r.advance(3 * minute)
  await r.hook('UserPromptSubmit')
  assert.equal(r.writes.length, 3, 'a cleared choice cannot be resumed')
})

test('unrelated and disarmed sessions cannot refresh another session choices', async () => {
  const r = rig()
  await r.tracker.mark({ ...scope, working: true })
  r.advance(3 * minute)
  await r.hook('UserPromptSubmit', 'session-b')
  await r.hook('PreToolUse', 'session-b')
  r.setArmed(false)
  await r.hook('UserPromptSubmit')
  await r.hook('PostToolUse')
  await r.tracker.sweep()
  assert.equal(r.writes.length, 1)
})

test('Stop suspends an in-flight refresh without sending a clear or admitting a queued refresh', async () => {
  let now = 1_000_000
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const writes: boolean[] = []
  const tracker = createMissionWorkingTracker({ now: () => now, isArmed: () => true,
    patch: async (_scope, working) => {
      writes.push(working)
      if (writes.length === 2) await held
      return { mission: { id: 77 } }
    },
  })
  await tracker.mark({ ...scope, working: true })
  now += 3 * minute
  const refreshing = tracker.onHook({ hook_event_name: 'PreToolUse', session_id: scope.sessionId })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(writes.length, 2, 'refresh must start at three minutes')
  const stopped = tracker.onHook({ hook_event_name: 'Stop', session_id: scope.sessionId })
  const late = tracker.onHook({ hook_event_name: 'PostToolUse', session_id: scope.sessionId })
  release()
  await Promise.all([refreshing, stopped, late])
  now += 20 * minute
  await tracker.sweep()
  assert.deepEqual(writes, [true, true])
})

test('Stop cancels a refresh waiting for the write lock before it can send', async () => {
  let now = 1_000_000
  let blocked = false
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const writes: boolean[] = []
  const tracker = createMissionWorkingTracker({ now: () => now, isArmed: () => true,
    withWriteLock: async work => { if (blocked) await held; return work() },
    patch: async (_scope, working) => { writes.push(working); return { mission: { id: 77 } } },
  })
  await tracker.mark({ ...scope, working: true })
  now += 3 * minute
  blocked = true
  const refreshing = tracker.onHook({ hook_event_name: 'PreToolUse', session_id: scope.sessionId })
  await new Promise(resolve => setImmediate(resolve))
  const stopped = tracker.onHook({ hook_event_name: 'Stop', session_id: scope.sessionId })
  release()
  await Promise.all([refreshing, stopped])
  assert.deepEqual(writes, [true], 'a refresh must recheck Stop after acquiring the write lock')
})

for (const stopDuringClear of [false, true]) {
  test(`Stop preserves a failed explicit-clear retry, in-flight=${stopDuringClear}`, async () => {
    let now = 1_000_000
    let fail = true
    const writes: boolean[] = []
    const tracker = createMissionWorkingTracker({ now: () => now, isArmed: () => true,
      patch: async (_scope, working) => {
        writes.push(working)
        if (!working && fail) {
          if (stopDuringClear) void tracker.onHook({ hook_event_name: 'Stop', session_id: scope.sessionId })
          throw Object.assign(new Error('unavailable'), { status: 503 })
        }
        return { mission: { id: 77 } }
      },
    })
    await tracker.mark({ ...scope, working: true })
    await assert.rejects(tracker.mark({ ...scope, working: false }), /unavailable/)
    if (!stopDuringClear) await tracker.onHook({ hook_event_name: 'Stop', session_id: scope.sessionId })
    fail = false
    now += 30_000
    await tracker.sweep()
    assert.deepEqual(writes, [true, false, false], 'Stop cannot discard a requested clear that failed')
  })
}

test('SessionEnd still clears a confirmed lease after Stop suspended its refresh', async () => {
  const r = rig()
  await r.tracker.mark({ ...scope, working: true })
  await r.hook('Stop')
  assert.equal(r.writes.length, 1)
  await r.hook('SessionEnd')
  assert.deepEqual(r.writes.map(write => write.working), [true, false])
})

test('a delayed Stop from the previous turn cannot suspend a resumed choice', async () => {
  const r = rig()
  await r.tracker.mark({ ...scope, working: true })
  r.advance(minute)
  await r.hook('Stop')
  r.advance(3 * minute)
  await r.hook('UserPromptSubmit')
  assert.equal(r.writes.length, 2)
  await r.hook('Stop', scope.sessionId, 1_000_000 + minute)
  r.advance(3 * minute)
  await r.hook('PostToolUse')
  assert.deepEqual(r.writes.map(write => write.working), [true, true, true])
})

for (const endPrevious of [false, true]) {
  for (const endPending of [false, true]) {
    test(`a pending new owner's boundary prevents adoption, old ended=${endPrevious}, new ended=${endPending}`, async () => {
      let now = 1_000_000
      const writes: Array<[string, boolean]> = []
      const tracker = createMissionWorkingTracker({ now: () => now, isArmed: () => true,
        patch: async (s, working) => {
          writes.push([s.sessionId, working])
          if (s.sessionId === 'session-b' && working) {
            void tracker.onHook({ hook_event_name: 'Stop', session_id: 'session-b' })
            if (endPending) void tracker.onHook({ hook_event_name: 'SessionEnd', session_id: 'session-b' })
          }
          return { mission: { id: 77 } }
        },
      })
      await tracker.mark({ ...scope, working: true })
      if (endPrevious) await tracker.onHook({ hook_event_name: 'SessionEnd', session_id: scope.sessionId })
      now++
      await tracker.mark({ ...scope, sessionId: 'session-b', working: true })
      await tracker.sweep()
      assert.deepEqual(writes, [
        ['session-a', true],
        ...(endPrevious ? [['session-a', false] as [string, boolean]] : []),
        ['session-b', true],
        ['session-b', false],
      ])
      if (!endPending) {
        now += 3 * minute
        await tracker.onHook({ hook_event_name: 'UserPromptSubmit', session_id: scope.sessionId })
        assert.equal(writes.at(-1)?.[0], 'session-b', 'the previous owner cannot resume the replacement')
      }
    })
  }
}

test('shutdown supersedes Stop while an initial mark is in flight and cannot revive its choice', async () => {
  let now = 1_000_000
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const writes: boolean[] = []
  const tracker = createMissionWorkingTracker({ now: () => now, isArmed: () => true,
    patch: async (_scope, working) => {
      writes.push(working)
      if (writes.length === 1) await held
      return { mission: { id: 77 } }
    },
  })
  const marking = tracker.mark({ ...scope, working: true })
  await new Promise(resolve => setImmediate(resolve))
  const stopped = tracker.onHook({ hook_event_name: 'Stop', session_id: scope.sessionId })
  const shutdown = tracker.stop()
  release()
  await Promise.all([marking, stopped, shutdown])
  assert.deepEqual(writes, [true, false])
  now += 3 * minute
  await tracker.onHook({ hook_event_name: 'UserPromptSubmit', session_id: scope.sessionId })
  assert.deepEqual(writes, [true, false], 'shutdown must retire choices even if the tracker is armed again')
})
