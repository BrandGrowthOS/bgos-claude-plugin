/**
 * Remote compact capability detection resilience (peer-871-3): on kc-server
 * a normal relaunch concluded "remote compact capability OFF" where the
 * identical setup previously printed ON with a tmux target - a startup race
 * where detection runs before the tmux pane is queryable. The detection now
 * retries with backoff for a bounded window (3 attempts over 30s) before
 * concluding OFF, and after an OFF conclusion a periodic touchpoint may make
 * a ONE-TIME late upgrade to ON. The capability itself (what /compact
 * injection does) is unchanged.
 *
 * Run with:  bun test test/compact-capability.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { TmuxTarget } from '../lib/compact-inject.ts'
import {
  detectCompactCapability,
  formatCompactDetection,
  formatLateCompactUpgrade,
  LateCompactUpgrader,
  COMPACT_DETECT_DELAYS_MS,
  LATE_UPGRADE_PROBE_INTERVAL_MS,
  LATE_UPGRADE_MAX_ATTEMPTS,
} from '../lib/compact-capability.ts'

const TARGET: TmuxTarget = { target: '%5', socketArgs: ['-S', '/tmp/tmux-1/default'], source: 'tmux-pane' }

// ── Bounded startup retry window ─────────────────────────────────────────────

test('detection window is 3 attempts over 30 seconds', () => {
  assert.equal(COMPACT_DETECT_DELAYS_MS.length, 3)
  assert.equal(
    COMPACT_DETECT_DELAYS_MS.reduce((a, b) => a + b, 0),
    30_000,
  )
  assert.equal(COMPACT_DETECT_DELAYS_MS[0], 0, 'first attempt runs immediately')
})

test('immediate success resolves ON at attempt 1 without sleeping, log line unchanged', async () => {
  const sleeps: number[] = []
  const outcome = await detectCompactCapability({
    resolveTarget: () => TARGET,
    probe: async () => true,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  assert.equal(outcome.state, 'on')
  if (outcome.state === 'on') {
    assert.equal(outcome.attempt, 1)
    assert.equal(outcome.target, TARGET)
  }
  assert.deepEqual(sleeps, [], 'no backoff sleeps on immediate success')
  // The healthy-boot line stays byte-identical to what the fleet greps for.
  assert.equal(
    formatCompactDetection(outcome),
    'remote compact capability ON (tmux target %5 via tmux-pane)',
  )
})

test('success on attempt 2 resolves ON and the log line says detection succeeded late', async () => {
  let calls = 0
  const sleeps: number[] = []
  const outcome = await detectCompactCapability({
    resolveTarget: () => TARGET,
    probe: async () => ++calls >= 2,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  assert.equal(outcome.state, 'on')
  if (outcome.state === 'on') assert.equal(outcome.attempt, 2)
  assert.deepEqual(sleeps, [COMPACT_DETECT_DELAYS_MS[1]], 'slept once before attempt 2')
  const line = formatCompactDetection(outcome)
  assert.ok(line.includes('remote compact capability ON'))
  assert.ok(line.includes('detection succeeded late'))
  assert.ok(line.includes('attempt 2 of 3'))
})

test('a target that only becomes resolvable on a later attempt still turns ON', async () => {
  // The kc-server shape: at attempt 1 nothing resolves; by attempt 3 it does.
  let attempt = 0
  const outcome = await detectCompactCapability({
    resolveTarget: () => (++attempt >= 3 ? TARGET : null),
    probe: async () => true,
    sleep: async () => {},
  })
  assert.equal(outcome.state, 'on')
  if (outcome.state === 'on') assert.equal(outcome.attempt, 3)
})

test('all attempts failing concludes OFF after the full window', async () => {
  let probes = 0
  const sleeps: number[] = []
  const outcome = await detectCompactCapability({
    resolveTarget: () => TARGET,
    probe: async () => {
      probes++
      return false
    },
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  assert.equal(outcome.state, 'off')
  if (outcome.state === 'off') {
    assert.equal(outcome.attempts, 3)
    assert.equal(outcome.windowMs, 30_000)
  }
  assert.equal(probes, 3)
  assert.deepEqual(sleeps, [COMPACT_DETECT_DELAYS_MS[1], COMPACT_DETECT_DELAYS_MS[2]])
  const line = formatCompactDetection(outcome)
  assert.ok(line.includes('remote compact capability OFF'))
  assert.ok(line.includes('no tmux control of the CLI detected'))
  assert.ok(line.includes('3 attempts over 30s'))
})

test('an absent tmux binary (probe rejects) concludes OFF with no unhandled rejection', async () => {
  const outcome = await detectCompactCapability({
    resolveTarget: () => TARGET,
    probe: async () => {
      throw Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' })
    },
    sleep: async () => {},
  })
  assert.equal(outcome.state, 'off')
})

test('no resolvable target means OFF without ever probing', async () => {
  let probes = 0
  const outcome = await detectCompactCapability({
    resolveTarget: () => null,
    probe: async () => {
      probes++
      return true
    },
    sleep: async () => {},
  })
  assert.equal(outcome.state, 'off')
  assert.equal(probes, 0)
})

// ── One-time late upgrade from a periodic touchpoint ─────────────────────────

test('late upgrader flips ON once, then goes quiet forever', async () => {
  let probes = 0
  const up = new LateCompactUpgrader({
    resolveTarget: () => TARGET,
    probe: async () => {
      probes++
      return true
    },
  })
  const t0 = 1_000_000
  const got = await up.check(t0)
  assert.equal(got, TARGET)
  assert.equal(up.finished, true)
  // Any further checks are no-ops (one-time upgrade).
  assert.equal(await up.check(t0 + LATE_UPGRADE_PROBE_INTERVAL_MS * 2), null)
  assert.equal(probes, 1)
  const line = formatLateCompactUpgrade(TARGET)
  assert.ok(line.includes('remote compact capability ON'))
  assert.ok(line.includes('detection succeeded'))
  assert.ok(line.includes('after the startup window'))
  assert.ok(line.includes('%5'))
})

test('late upgrader throttles probes to its minimum interval', async () => {
  let probes = 0
  const up = new LateCompactUpgrader({
    resolveTarget: () => TARGET,
    probe: async () => {
      probes++
      return false
    },
  })
  const t0 = 1_000_000
  await up.check(t0)
  await up.check(t0 + 1_000) // inside the throttle window: no probe
  assert.equal(probes, 1)
  await up.check(t0 + LATE_UPGRADE_PROBE_INTERVAL_MS)
  assert.equal(probes, 2)
})

test('late upgrader gives up after its bounded attempt budget', async () => {
  let probes = 0
  const up = new LateCompactUpgrader({
    resolveTarget: () => TARGET,
    probe: async () => {
      probes++
      return false
    },
  })
  let now = 1_000_000
  for (let i = 0; i < LATE_UPGRADE_MAX_ATTEMPTS + 5; i++) {
    await up.check(now)
    now += LATE_UPGRADE_PROBE_INTERVAL_MS
  }
  assert.equal(probes, LATE_UPGRADE_MAX_ATTEMPTS)
  assert.equal(up.finished, true)
})

test('late upgrader survives a rejecting probe (absent tmux) without throwing', async () => {
  const up = new LateCompactUpgrader({
    resolveTarget: () => TARGET,
    probe: async () => {
      throw Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' })
    },
  })
  const got = await up.check(1_000_000)
  assert.equal(got, null)
  assert.equal(up.finished, false)
})

test('late upgrader with no resolvable target consumes attempts without probing', async () => {
  let probes = 0
  const up = new LateCompactUpgrader({
    resolveTarget: () => null,
    probe: async () => {
      probes++
      return true
    },
  })
  assert.equal(await up.check(1_000_000), null)
  assert.equal(probes, 0)
})
