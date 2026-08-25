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

import { PROBE_REWRITE_MS, liveMarkerProves, parseLiveMarker, verifyAgent } from '../lib/agent-verify.mjs'
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

test('parseLiveMarker mirrors lib/boot-hello.ts (both fields, one field, junk)', () => {
  assert.deepEqual(parseLiveMarker(JSON.stringify({ firstLiveAt: 'a', lastLiveAt: 'b' })), { firstLiveAt: 'a', lastLiveAt: 'b' })
  assert.deepEqual(parseLiveMarker(JSON.stringify({ lastLiveAt: 'b' })), { firstLiveAt: 'b', lastLiveAt: 'b' })
  assert.deepEqual(parseLiveMarker(JSON.stringify({ firstLiveAt: 'a' })), { firstLiveAt: 'a', lastLiveAt: 'a' })
  assert.equal(parseLiveMarker('{}'), null)
  assert.equal(parseLiveMarker('junk'), null)
  assert.equal(parseLiveMarker(null), null)
})

test('liveMarkerProves: lastLiveAt strictly after the restart proves; equal or older does not; mtime only when lastLiveAt is unparseable', () => {
  const newer = JSON.stringify({ lastLiveAt: new Date(T0 + 5000).toISOString() })
  const older = JSON.stringify({ lastLiveAt: new Date(T0 - 5000).toISOString() })
  const same = JSON.stringify({ lastLiveAt: new Date(T0).toISOString() })
  assert.deepEqual(liveMarkerProves({ raw: newer, mtimeMs: 0, restartedAtMs: T0 }), { proven: true, via: 'lastLiveAt', lastLiveAt: new Date(T0 + 5000).toISOString() })
  assert.deepEqual(liveMarkerProves({ raw: older, mtimeMs: T0 + 99_999, restartedAtMs: T0 }), { proven: false, via: null, lastLiveAt: new Date(T0 - 5000).toISOString() })
  assert.equal(liveMarkerProves({ raw: same, mtimeMs: T0 + 1, restartedAtMs: T0 }).proven, false, 'a parseable but stale lastLiveAt is never rescued by mtime')
  // Unparseable lastLiveAt: the mtime is the secondary evidence.
  const junkTime = JSON.stringify({ lastLiveAt: 'yesterday' })
  assert.deepEqual(liveMarkerProves({ raw: junkTime, mtimeMs: T0 + 1, restartedAtMs: T0 }), { proven: true, via: 'mtime', lastLiveAt: 'yesterday' })
  assert.equal(liveMarkerProves({ raw: junkTime, mtimeMs: T0, restartedAtMs: T0 }).proven, false)
  assert.deepEqual(liveMarkerProves({ raw: 'not json', mtimeMs: T0 + 1, restartedAtMs: T0 }), { proven: true, via: 'mtime', lastLiveAt: null })
  assert.deepEqual(liveMarkerProves({ raw: null, mtimeMs: null, restartedAtMs: T0 }), { proven: false, via: null, lastLiveAt: null })
})

test('verifyAgent: writes the probe immediately, polls every 3s, succeeds when lastLiveAt passes the restart instant', async () => {
  const fs = memoryFs()
  const clock = fakeClock(T0, (nowMs, tick) => {
    // The daemon answers the probe on the 4th tick: first tool call -> marker.
    if (tick === 4) fs.writeFile(MARKER, JSON.stringify({ firstLiveAt: 'x', lastLiveAt: new Date(nowMs).toISOString() }))
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

test('verifyAgent: mtime is accepted only for an unparseable lastLiveAt', async () => {
  const fs = memoryFs({ [MARKER]: '{"lastLiveAt":"soon"}' })
  fs.touch(MARKER, T0 + 500)
  const clock = fakeClock(T0)
  const result = await verifyAgent(agentRow(), { restartedAtMs: T0, fs, now: clock.now, sleep: clock.sleep })
  assert.equal(result.ok, true)
  assert.equal(result.evidence.via, 'mtime')
  assert.equal(result.evidence.mtimeMs, T0 + 500)
  assert.equal(clock.sleeps.length, 0)
})

test('verifyAgent: requestProbe:false never touches the probe file (a fresh pairing proves itself with the boot hello)', async () => {
  const fs = memoryFs({ [MARKER]: JSON.stringify({ lastLiveAt: new Date(T0 + 1).toISOString() }) })
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
    if (tick === 1) fs.files.set(MARKER, JSON.stringify({ lastLiveAt: new Date(nowMs).toISOString() }))
  })
  const result = await verifyAgent(agentRow(), { restartedAtMs: T0, fs, now: clock.now, sleep: clock.sleep, log: (l: string) => logs.push(l) })
  assert.equal(result.ok, true)
  assert.equal(logs.some((l) => l.includes('probe write failed') && l.includes('EACCES')), true)
})
