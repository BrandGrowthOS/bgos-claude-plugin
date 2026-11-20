/**
 * lib/agent-verify.mjs: proof that a restarted agent HEARS the channel, per
 * design 7.2 / landmine 4. "Connected" is never accepted; the only proof is
 * the channel-live marker (~/.bgos-plugin-state/<id>/channel-live.json,
 * written by the daemon on the first tool call after a boot) with a
 * lastLiveAt newer than the restart instant, the mtime accepted only as
 * secondary evidence when lastLiveAt is unparseable. The watcher asks for
 * that first tool call by writing ~/.bgos-agent/<id>/probe-requested.json
 * (existence only), re-writing it every 30s while waiting. All with a fake
 * clock, so nothing here waits for real.
 *
 * Run: npx tsx --test test/agent-verify.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LIVE_BEFORE_STALE_MS,
  LIVE_BEFORE_TIMEOUT_MS,
  PROBE_REWRITE_MS,
  liveMarkerProves,
  parseLiveMarker,
  proveLiveBefore,
  verifyAgent,
} from '../lib/agent-verify.mjs'
import { memoryFs } from './helpers/memory-fs.ts'

const MARKER = '/home/kc/.bgos-plugin-state/912/channel-live.json'
const PROBE = '/home/kc/.bgos-agent/912/probe-requested.json'
const T0 = Date.parse('2026-08-25T10:00:00.000Z')

function agentRow() {
  return {
    assistantId: '912',
    cwd: '/home/kc/hoai-agents/ava',
    recipe: null,
    supervisor: 'launcher-live',
    running: true,
    serviceFile: null,
    sessionId: null,
    stateDir: '/home/kc/.bgos-agent/912',
    pluginStateDir: '/home/kc/.bgos-plugin-state/912',
    liveMarkerPath: MARKER,
    credentialsPath: '/home/kc/.bgos-agent/credentials-912.json',
    notes: [],
  }
}

/** A fake clock whose sleep advances time and runs an optional per-tick hook. */
function fakeClock(start: number, onTick?: (nowMs: number, tick: number) => void) {
  let nowMs = start
  let tick = 0
  const sleeps: number[] = []
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      nowMs += ms
      tick += 1
      onTick?.(nowMs, tick)
    },
    sleeps,
    advance: (ms: number) => {
      nowMs += ms
    },
  }
}

test('owner verification fails at the deadline with only a fresh lock', async () => {
  const fs = memoryFs()
  const clock = fakeClock(T0)
  const result = await verifyAgent(agentRow(), {
    fs, restartedAtMs: T0, now: clock.now, sleep: clock.sleep, timeoutMs: 75_000, ownerProgress: () => 'new_daemon',
  })
  assert.equal(result.ok, false)
  assert.equal(result.evidence.via, null)
  assert.equal(result.message, 'agent_deaf_after_restart')
  assert.equal(clock.now(), T0 + 75_000)
  assert.equal(JSON.parse(fs.readFile(PROBE)!).afterBootMs, T0)
})

test('parseLiveMarker mirrors lib/boot-hello.ts (both fields, one field, junk)', () => {
  assert.deepEqual(parseLiveMarker(JSON.stringify({ firstLiveAt: 'a', lastLiveAt: 'b' })), { firstLiveAt: 'a', lastLiveAt: 'b' })
  assert.deepEqual(parseLiveMarker(JSON.stringify({ lastLiveAt: 'b' })), { firstLiveAt: 'b', lastLiveAt: 'b' })
  assert.deepEqual(parseLiveMarker(JSON.stringify({ firstLiveAt: 'a' })), { firstLiveAt: 'a', lastLiveAt: 'a' })
  assert.equal(parseLiveMarker('{}'), null)
  assert.equal(parseLiveMarker('junk'), null)
  assert.equal(parseLiveMarker(null), null)
})

// Review of #396, round 5: an old daemon's reply with no boot stamp
// passed, and so did a torn marker judged by its modified time; one such
// false witness kept a bad build. Proof now needs a whole marker stamped
// with a boot after the restart (every build since 2026-08-25 writes one).
test('liveMarkerProves: a whole marker, booted after the restart, with lastLiveAt strictly after it; nothing else proves', () => {
  const boot = new Date(T0 + 1000).toISOString()
  const newer = JSON.stringify({ lastLiveAt: new Date(T0 + 5000).toISOString(), bootedAt: boot })
  const older = JSON.stringify({ lastLiveAt: new Date(T0 - 5000).toISOString(), bootedAt: boot })
  const same = JSON.stringify({ lastLiveAt: new Date(T0).toISOString(), bootedAt: boot })
  assert.deepEqual(liveMarkerProves({ raw: newer, mtimeMs: 0, restartedAtMs: T0 }), { proven: true, via: 'lastLiveAt', lastLiveAt: new Date(T0 + 5000).toISOString() })
  assert.deepEqual(liveMarkerProves({ raw: older, mtimeMs: T0 + 99_999, restartedAtMs: T0 }), { proven: false, via: null, lastLiveAt: new Date(T0 - 5000).toISOString() })
  assert.equal(liveMarkerProves({ raw: same, mtimeMs: T0 + 1, restartedAtMs: T0 }).proven, false, 'a parseable but stale lastLiveAt is never rescued by mtime')
  // A torn or junk marker is never rescued by its modified time.
  const junkTime = JSON.stringify({ lastLiveAt: 'yesterday', bootedAt: boot })
  assert.deepEqual(liveMarkerProves({ raw: junkTime, mtimeMs: T0 + 1, restartedAtMs: T0 }), { proven: false, via: null, lastLiveAt: 'yesterday' })
  assert.deepEqual(liveMarkerProves({ raw: 'not json', mtimeMs: T0 + 1, restartedAtMs: T0 }), { proven: false, via: null, lastLiveAt: null })
  // No boot stamp, however fresh: not proof.
  const unstamped = JSON.stringify({ lastLiveAt: new Date(T0 + 5000).toISOString() })
  assert.equal(liveMarkerProves({ raw: unstamped, mtimeMs: T0 + 5000, restartedAtMs: T0 }).proven, false)
  assert.deepEqual(liveMarkerProves({ raw: null, mtimeMs: null, restartedAtMs: T0 }), { proven: false, via: null, lastLiveAt: null })
})

test('verifyAgent: writes the probe immediately, polls every 3s, succeeds when lastLiveAt passes the restart instant', async () => {
  const fs = memoryFs()
  const clock = fakeClock(T0, (nowMs, tick) => {
    // The daemon answers the probe on the 4th tick: first tool call -> marker.
    if (tick === 4) fs.writeFile(MARKER, JSON.stringify({ firstLiveAt: 'x', lastLiveAt: new Date(nowMs).toISOString(), bootedAt: new Date(T0 + 1000).toISOString() }))
  })
  const result = await verifyAgent(agentRow(), { restartedAtMs: T0, fs, now: clock.now, sleep: clock.sleep })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.message, 'channel proven live after the restart')
  assert.equal(result.evidence.markerPath, MARKER)
  assert.equal(result.evidence.probePath, PROBE)
  assert.equal(result.evidence.via, 'lastLiveAt')
  assert.equal(result.evidence.lastLiveAt, new Date(T0 + 4 * 3000).toISOString())
  assert.deepEqual(clock.sleeps, [3000, 3000, 3000, 3000])
  // The probe was requested (existence only; the body is informational).
  const probe = JSON.parse(fs.files.get(PROBE)!)
  assert.equal(probe.requestedAt, new Date(T0).toISOString())
  assert.equal(probe.by, 'hoai-watcher')
})

test('verifyAgent: a marker that predates the restart is NOT proof; the probe is re-written every 30s; timeout names agent_deaf_after_restart', async () => {
  const fs = memoryFs({ [MARKER]: JSON.stringify({ firstLiveAt: 'x', lastLiveAt: new Date(T0 - 60_000).toISOString() }) })
  fs.touch(MARKER, T0 + 1) // an mtime after the restart must not rescue a stale lastLiveAt
  const probeWrites: number[] = []
  const inner = fs.writeFile
  fs.writeFile = (p, text, opts) => {
    if (p === PROBE) probeWrites.push(JSON.parse(text).requestedAt)
    inner(p, text, opts)
  }
  const clock = fakeClock(T0)
  const result = await verifyAgent(agentRow(), { restartedAtMs: T0, fs, now: clock.now, sleep: clock.sleep, timeoutMs: 120_000, pollMs: 3000 })
  assert.equal(result.ok, false)
  assert.equal(result.message, 'agent_deaf_after_restart')
  assert.equal(result.evidence.lastLiveAt, new Date(T0 - 60_000).toISOString())
  assert.equal(result.evidence.via, null)
  assert.equal(clock.sleeps.length, 40, '120s / 3s polls before giving up')
  assert.equal(PROBE_REWRITE_MS, 30_000)
  // Probe at t0, then every 30s: t0, +30, +60, +90 (the +120 deadline returns first).
  assert.deepEqual(
    probeWrites,
    [0, 30_000, 60_000, 90_000].map((ms) => new Date(T0 + ms).toISOString()),
  )
})

test('verifyAgent: no marker at all times out too (never a false positive on absence)', async () => {
  const clock = fakeClock(T0)
  const result = await verifyAgent(agentRow(), { restartedAtMs: T0, fs: memoryFs(), now: clock.now, sleep: clock.sleep, timeoutMs: 9000, pollMs: 3000 })
  assert.equal(result.ok, false)
  assert.equal(result.message, 'agent_deaf_after_restart')
  assert.equal(result.evidence.lastLiveAt, null)
  assert.equal(result.evidence.mtimeMs, null)
})

test('verifyAgent: a marker whose lastLiveAt cannot be read is not proof, whatever its modified time', async () => {
  const fs = memoryFs({ [MARKER]: '{"lastLiveAt":"soon"}' })
  fs.touch(MARKER, T0 + 500)
  const clock = fakeClock(T0)
  const result = await verifyAgent(agentRow(), { restartedAtMs: T0, fs, now: clock.now, sleep: clock.sleep, timeoutMs: 9000, pollMs: 3000 })
  assert.equal(result.ok, false)
  assert.equal(result.evidence.via, null)
})

test('verifyAgent: requestProbe:false never touches the probe file (a fresh pairing proves itself with the boot hello)', async () => {
  const fs = memoryFs({ [MARKER]: JSON.stringify({ lastLiveAt: new Date(T0 + 1).toISOString(), bootedAt: new Date(T0 + 1).toISOString() }) })
  const clock = fakeClock(T0)
  const result = await verifyAgent(agentRow(), { restartedAtMs: T0, fs, now: clock.now, sleep: clock.sleep, requestProbe: false })
  assert.equal(result.ok, true)
  assert.equal(fs.files.has(PROBE), false)
})

test('verifyAgent: a probe write failure is logged, not fatal (the boot hello or the user can still prove liveness)', async () => {
  const fs = memoryFs()
  fs.writeFile = () => {
    throw new Error('EACCES')
  }
  const logs: string[] = []
  const clock = fakeClock(T0, (nowMs, tick) => {
    if (tick === 1) fs.files.set(MARKER, JSON.stringify({ lastLiveAt: new Date(nowMs).toISOString(), bootedAt: new Date(nowMs).toISOString() }))
  })
  const result = await verifyAgent(agentRow(), { restartedAtMs: T0, fs, now: clock.now, sleep: clock.sleep, log: (l: string) => logs.push(l) })
  assert.equal(result.ok, true)
  assert.equal(logs.some((l) => l.includes('probe write failed') && l.includes('EACCES')), true)
})

test('liveMarkerProves: a marker whose writer booted BEFORE the restart is never proof, however fresh its lastLiveAt; a later boot is; no bootedAt is not proof', () => {
  const stale = JSON.stringify({ firstLiveAt: 'x', lastLiveAt: new Date(T0 + 4000).toISOString(), bootedAt: new Date(T0 - 3_600_000).toISOString() })
  assert.deepEqual(liveMarkerProves({ raw: stale, mtimeMs: T0 + 4000, restartedAtMs: T0 }), { proven: false, via: null, lastLiveAt: new Date(T0 + 4000).toISOString() })
  const fresh = JSON.stringify({ firstLiveAt: 'x', lastLiveAt: new Date(T0 + 4000).toISOString(), bootedAt: new Date(T0 + 2000).toISOString() })
  assert.deepEqual(liveMarkerProves({ raw: fresh, mtimeMs: 0, restartedAtMs: T0 }), { proven: true, via: 'lastLiveAt', lastLiveAt: new Date(T0 + 4000).toISOString() })
  const legacy = JSON.stringify({ firstLiveAt: 'x', lastLiveAt: new Date(T0 + 4000).toISOString() })
  assert.equal(liveMarkerProves({ raw: legacy, mtimeMs: 0, restartedAtMs: T0 }).proven, false, 'no boot stamp is no proof (round 5)')
  assert.deepEqual(parseLiveMarker(stale), { firstLiveAt: 'x', lastLiveAt: new Date(T0 + 4000).toISOString(), bootedAt: new Date(T0 - 3_600_000).toISOString() })
})

test('verifyAgent: the OLD session answering the probe during its teardown (bootedAt before the restart) is not proof; the run times out honestly', async () => {
  const fs = memoryFs()
  const clock = fakeClock(T0, (nowMs, tick) => {
    if (tick === 2) fs.writeFile(MARKER, JSON.stringify({ firstLiveAt: 'x', lastLiveAt: new Date(nowMs).toISOString(), bootedAt: new Date(T0 - 60_000).toISOString() }))
  })
  const result = await verifyAgent(agentRow(), { restartedAtMs: T0, fs, now: clock.now, sleep: clock.sleep, timeoutMs: 30_000 })
  assert.equal(result.ok, false)
  assert.equal(result.message, 'agent_deaf_after_restart')
  assert.equal(result.evidence.via, null)
})

test('verifyAgent: the probe is asked again the moment the launcher consumes the restart marker (no extra wait, no extra polls)', async () => {
  const RESTART = '/home/kc/.bgos-agent/912/restart-requested.json'
  const fs = memoryFs({ [RESTART]: '{}' })
  const probeWrites: string[] = []
  const inner = fs.writeFile
  fs.writeFile = (p, text, opts) => {
    if (p === PROBE) probeWrites.push(JSON.parse(text).requestedAt)
    inner(p, text, opts)
  }
  const clock = fakeClock(T0, (nowMs, tick) => {
    if (tick === 2) fs.files.delete(RESTART) // the launcher saw the marker
    if (tick === 4) fs.writeFile(MARKER, JSON.stringify({ lastLiveAt: new Date(nowMs).toISOString(), bootedAt: new Date(T0 + 1000).toISOString() }))
  })
  const result = await verifyAgent(agentRow(), { restartedAtMs: T0, fs, now: clock.now, sleep: clock.sleep })
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(probeWrites, [new Date(T0).toISOString(), new Date(T0 + 2 * 3000).toISOString()])
  assert.deepEqual(clock.sleeps, [3000, 3000, 3000, 3000])
})

test('verifyAgent: a clock that never reaches the deadline still ends the wait (a lap bound), never a loop that starves every timer', async () => {
  // Every lap awaits only the injected sleep. With a sleep that does not move
  // the clock (a test's fake, or a wall clock stepped back) the loop never
  // yielded to a timer, so not even --test-timeout could stop it: a watcher
  // test run sat at 100% CPU for 50 minutes.
  let sleeps = 0
  const sleep = async () => {
    sleeps += 1
    // Only so the defect fails this test instead of hanging the file.
    if (sleeps > 1000) throw new Error('verify did not stop polling')
  }
  const result = await verifyAgent(agentRow(), { restartedAtMs: T0, fs: memoryFs(), now: () => T0, sleep, timeoutMs: 30_000, pollMs: 3000 })
  assert.equal(result.ok, false)
  assert.equal(result.message, 'agent_deaf_after_restart')
  assert.equal(sleeps, 11, 'one lap per poll the timeout allows, plus one')
})

// -- Before an update: does this agent hear the channel NOW? ---------------------------------
//
// An update restarts every agent and verifies each one; a deaf agent rolls the
// whole computer back to the old version. That is right only when the update
// made it deaf. On 17 Nov 2026 an agent that had been deaf for days (Bug board
// rows 66450e01 and 367b861a) rolled a good install back twice. So before an
// update mutates anything, the watcher asks each agent the same question the
// verify asks afterwards, and the answer has three values:
//   true   it answered the probe now;
//   false  it did not answer, and its marker shows no sign of life either
//          (absent, or older than LIVE_BEFORE_STALE_MS): deaf before;
//   null   it did not answer but acted on the channel recently: it may be in
//          the middle of a long turn, so the update can still be blamed.

const iso = (ms: number) => new Date(ms).toISOString()
const liveMarker = (lastLiveAtMs: number, bootedAtMs?: number) =>
  JSON.stringify({
    firstLiveAt: iso(lastLiveAtMs),
    lastLiveAt: iso(lastLiveAtMs),
    ...(bootedAtMs === undefined ? {} : { bootedAt: iso(bootedAtMs) }),
  })

test('proveLiveBefore: an agent that answers the probe is live, as soon as it answers', async () => {
  const fs = memoryFs()
  // The daemon booted days ago: the verify's bootedAt rule must NOT apply here.
  fs.writeFile(MARKER, liveMarker(T0 - 3 * 86_400_000, T0 - 3 * 86_400_000))
  const clock = fakeClock(T0, (nowMs, tick) => {
    if (tick === 2) fs.writeFile(MARKER, liveMarker(nowMs, T0 - 3 * 86_400_000))
  })
  const out = await proveLiveBefore(agentRow(), { fs, now: clock.now, sleep: clock.sleep })
  assert.equal(out.live, true)
  assert.equal(clock.sleeps.length, 2, 'it stopped waiting the moment the marker moved')
  assert.ok(fs.files.has(PROBE), 'a probe was asked for')
})

test('proveLiveBefore: it asks with the same probe file the verify uses, at once', async () => {
  const fs = memoryFs()
  const clock = fakeClock(T0)
  await proveLiveBefore(agentRow(), { fs, now: clock.now, sleep: clock.sleep, timeoutMs: 3_000 })
  const probe = JSON.parse(String(fs.readFile(PROBE)))
  assert.equal(probe.by, 'hoai-watcher')
  assert.equal(probe.requestedAt, iso(T0))
})

test('proveLiveBefore: no answer and no marker at all is deaf before the update', async () => {
  const fs = memoryFs()
  const clock = fakeClock(T0)
  const out = await proveLiveBefore(agentRow(), { fs, now: clock.now, sleep: clock.sleep })
  assert.equal(out.live, false)
  assert.match(out.detail, /^no_answer_in_\d+ms;never_live$/)
  assert.ok(clock.now() - T0 >= LIVE_BEFORE_TIMEOUT_MS, 'it waited the whole window before saying so')
  assert.ok(clock.now() - T0 < LIVE_BEFORE_TIMEOUT_MS + 10_000, 'and not much longer')
})

test('proveLiveBefore: no answer and a marker last moved days ago is deaf before the update (the 17 Nov case)', async () => {
  const fs = memoryFs()
  fs.writeFile(MARKER, liveMarker(T0 - 8 * 86_400_000, T0 - 9 * 86_400_000))
  const clock = fakeClock(T0)
  const out = await proveLiveBefore(agentRow(), { fs, now: clock.now, sleep: clock.sleep })
  assert.equal(out.live, false)
  assert.match(out.detail, /^no_answer_in_\d+ms;last_live_/)
})

test('proveLiveBefore: no answer but it acted on the channel recently is UNKNOWN, never "deaf": it may be in a long turn', async () => {
  const fs = memoryFs()
  fs.writeFile(MARKER, liveMarker(T0 - 40 * 60_000))
  const clock = fakeClock(T0)
  const out = await proveLiveBefore(agentRow(), { fs, now: clock.now, sleep: clock.sleep })
  assert.equal(out.live, null)
  // The edge: exactly the stale window is still "recent"; one ms older is not.
  for (const [age, expected] of [
    [LIVE_BEFORE_STALE_MS, null],
    [LIVE_BEFORE_STALE_MS + 1, false],
  ] as const) {
    const edgeFs = memoryFs()
    edgeFs.writeFile(MARKER, liveMarker(T0 - age))
    const edgeClock = fakeClock(T0)
    const edge = await proveLiveBefore(agentRow(), { fs: edgeFs, now: edgeClock.now, sleep: edgeClock.sleep, timeoutMs: 3_000 })
    assert.equal(edge.live, expected, `age ${age}`)
  }
})

test('proveLiveBefore: a marker that moved BEFORE the question is not an answer, however close', async () => {
  const fs = memoryFs()
  fs.writeFile(MARKER, liveMarker(T0 - 1))
  const clock = fakeClock(T0)
  const out = await proveLiveBefore(agentRow(), { fs, now: clock.now, sleep: clock.sleep, timeoutMs: 6_000 })
  assert.equal(out.live, null, 'recent, so unknown; but not "answered"')
})

test('proveLiveBefore: junk in the marker is no sign of life; an agent with no marker path cannot be judged', async () => {
  const fs = memoryFs()
  fs.writeFile(MARKER, 'junk')
  const clock = fakeClock(T0)
  const junk = await proveLiveBefore(agentRow(), { fs, now: clock.now, sleep: clock.sleep, timeoutMs: 3_000 })
  assert.equal(junk.live, false)
  const noPath = await proveLiveBefore({ ...agentRow(), liveMarkerPath: '' }, { fs, now: clock.now, sleep: clock.sleep, timeoutMs: 3_000 })
  assert.equal(noPath.live, null)
  assert.equal(noPath.detail, 'no_marker_path')
})

test('proveLiveBefore: a clock that never reaches the deadline still ends the wait', async () => {
  const fs = memoryFs()
  let laps = 0
  const out = await proveLiveBefore(agentRow(), {
    fs,
    now: () => T0,
    sleep: async () => {
      laps += 1
      if (laps > 10_000) throw new Error('never ended')
    },
  })
  assert.equal(out.live, false)
  assert.ok(laps < 100)
})

// Review of #396 (C1): the live marker moves only on a boot's first
// tool call and on channel_ack, so a healthy session that has been up for
// more than six hours and is in a long turn, or simply slow for 20 s, has an
// old marker and does not answer in time. The daemon's own published state
// (agent-state.json, parseAgentState) says whether it is busy: a fresh one
// that shows work in hand or recent activity is UNKNOWN, never "deaf".
const AGENT_STATE = '/home/kc/.bgos-plugin-state/912/agent-state.json'
const agentState = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    assistantId: '912',
    pid: 4242,
    claudePid: 4243,
    turnInFlight: false,
    pendingMessages: 0,
    pendingPermissions: 0,
    activeOperations: 0,
    updatedAt: new Date(T0 - 5_000).toISOString(),
    lastActivityAt: new Date(T0 - 9 * 3_600_000).toISOString(),
    turnSignal: 'hooks',
    ...over,
  })
const alive = (pid: number) => pid === 4242

test('proveLiveBefore: a healthy session up for hours, mid turn, with an old marker, is UNKNOWN, never deaf (review C1)', async () => {
  for (const [label, over] of [
    ['a turn in flight', { turnInFlight: true }],
    ['messages waiting', { pendingMessages: 2 }],
    ['a permission waiting', { pendingPermissions: 1 }],
    ['an operation running', { activeOperations: 1 }],
    ['activity inside the window', { lastActivityAt: new Date(T0 - 20 * 60_000).toISOString() }],
  ] as const) {
    const fs = memoryFs()
    fs.writeFile(MARKER, liveMarker(T0 - 8 * 3_600_000, T0 - 30 * 3_600_000))
    fs.writeFile(AGENT_STATE, agentState(over))
    const clock = fakeClock(T0)
    const out = await proveLiveBefore(agentRow(), { fs, now: clock.now, sleep: clock.sleep, timeoutMs: 3_000, pidAlive: alive })
    assert.equal(out.live, null, label)
    assert.match(out.detail, /;busy_/, label)
  }
})

test('proveLiveBefore: the published state vouches only when it is fresh, its writer alive, and it shows work or recent activity', async () => {
  const cases = [
    ['idle, last activity long ago', agentState()],
    ['written long ago', agentState({ turnInFlight: true, updatedAt: new Date(T0 - 3_600_000).toISOString() })],
    ['its writer is gone', agentState({ turnInFlight: true, pid: 999 })],
    ['the state of another agent', agentState({ turnInFlight: true, assistantId: '913' })],
    ['junk', 'junk'],
  ] as const
  for (const [label, raw] of cases) {
    const fs = memoryFs()
    fs.writeFile(MARKER, liveMarker(T0 - 8 * 86_400_000))
    fs.writeFile(AGENT_STATE, raw)
    const clock = fakeClock(T0)
    const out = await proveLiveBefore(agentRow(), { fs, now: clock.now, sleep: clock.sleep, timeoutMs: 3_000, pidAlive: alive })
    assert.equal(out.live, false, label)
  }
  // No state file at all (a daemon older than design 7): as before.
  const fs = memoryFs()
  fs.writeFile(MARKER, liveMarker(T0 - 8 * 86_400_000))
  const clock = fakeClock(T0)
  const none = await proveLiveBefore(agentRow(), { fs, now: clock.now, sleep: clock.sleep, timeoutMs: 3_000, pidAlive: alive })
  assert.equal(none.live, false)
})

test('proveLiveBefore: a marker that cannot be read at the end keeps the last good read (review minor)', async () => {
  const fs = memoryFs()
  fs.writeFile(MARKER, liveMarker(T0 - 40 * 60_000))
  const clock = fakeClock(T0, (_nowMs, tick) => {
    if (tick >= 1) fs.writeFile(MARKER, '{"lastLive')
  })
  const out = await proveLiveBefore(agentRow(), { fs, now: clock.now, sleep: clock.sleep, timeoutMs: 3_000, pidAlive: alive })
  assert.equal(out.live, null, 'recently live by the last good read, not "never live"')
  assert.match(out.detail, /recently_live_/)
})

// Review of #396 (minors): the edges no test held.
test('proveLiveBefore: a marker that moved at the very moment of the question is not an answer', async () => {
  const fs = memoryFs()
  fs.writeFile(MARKER, liveMarker(T0))
  const clock = fakeClock(T0)
  const out = await proveLiveBefore(agentRow(), { fs, now: clock.now, sleep: clock.sleep, timeoutMs: 3_000 })
  assert.notEqual(out.live, true)
  assert.notEqual(out.detail, 'answered')
})

test('proveLiveBefore: an agent with no state folder cannot be judged, and writes no probe anywhere', async () => {
  const fs = memoryFs()
  const clock = fakeClock(T0)
  const out = await proveLiveBefore({ ...agentRow(), stateDir: '' }, { fs, now: clock.now, sleep: clock.sleep, timeoutMs: 3_000 })
  assert.deepEqual(out, { live: null, detail: 'no_marker_path', lastLiveAt: null })
  assert.equal(fs.files.size, 0)
})

test('proveLiveBefore: a zero, negative or junk timeout is the full window, never an instant "deaf"', async () => {
  for (const timeoutMs of [0, -5, Number.NaN, 'soon' as unknown as number]) {
    const fs = memoryFs()
    const clock = fakeClock(T0)
    const out = await proveLiveBefore(agentRow(), { fs, now: clock.now, sleep: clock.sleep, timeoutMs })
    assert.equal(out.live, false, String(timeoutMs))
    assert.ok(clock.now() - T0 >= LIVE_BEFORE_TIMEOUT_MS, `it waited the whole window for ${String(timeoutMs)}`)
    assert.match(out.detail, new RegExp(`^no_answer_in_${LIVE_BEFORE_TIMEOUT_MS}ms;`))
  }
})

test('proveLiveBefore: its probe says it is the question before an update, so the card claims no restart', async () => {
  const fs = memoryFs()
  const clock = fakeClock(T0)
  await proveLiveBefore(agentRow(), { fs, now: clock.now, sleep: clock.sleep, timeoutMs: 3_000 })
  assert.equal(JSON.parse(fs.readFile(PROBE) as string).purpose, 'before_update')
})

// Review of #396, round 3 (minor): the verify's own windows. A zero or junk
// timeout ended the verify before it looked; a zero poll spun without sleep.
test('verifyAgent: a zero, negative or junk window or poll is the default, never an instant failure or a spin', async () => {
  for (const bad of [0, -5, Number.NaN]) {
    const fs = memoryFs()
    const clock = fakeClock(T0)
    const out = await verifyAgent(agentRow(), {
      restartedAtMs: T0,
      fs,
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: bad,
      pollMs: bad,
      probeRewriteMs: bad,
    })
    assert.equal(out.ok, false, String(bad))
    assert.ok(clock.now() - T0 >= 20_000, `${String(bad)}: it waited a real window (${clock.now() - T0} ms)`)
    assert.ok(clock.sleeps.every((ms) => ms > 0), `${String(bad)}: every poll sleeps`)
  }
})

// Round 4: the rewrite window had no case of its own, so dropping
// its guard kept every test green. Unguarded, a zero window asks again on
// every poll.
test('verifyAgent: a zero, negative or junk probe rewrite window is the default, not a new question every poll', async () => {
  for (const bad of [0, -5, Number.NaN]) {
    const fs = memoryFs()
    const clock = fakeClock(T0)
    const asked: number[] = []
    const write = fs.writeFile
    fs.writeFile = (path, text, opts) => {
      if (path === PROBE) asked.push(clock.now() - T0)
      write(path, text, opts)
    }
    await verifyAgent(agentRow(), {
      restartedAtMs: T0,
      fs,
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 120_000,
      pollMs: 3_000,
      probeRewriteMs: bad,
    })
    // Round 5 (minor): exactly the default's rhythm, every 30 s, up
    // to the 120 s deadline (which ends the wait before a fifth question).
    assert.deepEqual(asked, [0, PROBE_REWRITE_MS, 2 * PROBE_REWRITE_MS, 3 * PROBE_REWRITE_MS], String(bad))
  }
})

test('proveLiveBefore: a zero poll sleeps the default, never spins', async () => {
  const fs = memoryFs()
  const clock = fakeClock(T0)
  await proveLiveBefore(agentRow(), { fs, now: clock.now, sleep: clock.sleep, timeoutMs: 3_000, pollMs: 0 })
  assert.ok(clock.sleeps.length > 0 && clock.sleeps.every((ms) => ms > 0))
})

test('proveLiveBefore: a marker path that is not a string cannot be judged (review minor 6)', async () => {
  const fs = memoryFs()
  const clock = fakeClock(T0)
  for (const liveMarkerPath of [42, null, undefined, {}]) {
    const out = await proveLiveBefore({ ...agentRow(), liveMarkerPath } as never, { fs, now: clock.now, sleep: clock.sleep, timeoutMs: 3_000 })
    assert.deepEqual(out, { live: null, detail: 'no_marker_path', lastLiveAt: null })
  }
  assert.equal(fs.files.size, 0)
})
