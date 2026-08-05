/**
 * compact-capability: resilient detection for the remote /compact capability
 * (peer-871-3).
 *
 * The capability itself (lib/compact-inject.ts, unchanged) needs a tmux
 * target resolved from the environment and a queryable pane. Detection used
 * to be a single synchronous check at boot; on kc-server a normal relaunch
 * concluded OFF ("no tmux control of the CLI detected") where the identical
 * setup previously printed ON - a startup race where detection ran before
 * the tmux pane was queryable. Detection now:
 *
 *   1. retries with backoff for a bounded window (3 attempts over 30s,
 *      COMPACT_DETECT_DELAYS_MS) before concluding OFF, re-running BOTH the
 *      env resolution and the aliveness probe each attempt;
 *   2. after an OFF conclusion, a periodic touchpoint may drive a ONE-TIME
 *      late upgrade to ON via LateCompactUpgrader (throttled, bounded).
 *
 * A rejecting probe (e.g. no tmux binary: execFile ENOENT) is treated as a
 * failed attempt, never an unhandled rejection. What the capability DOES is
 * untouched; only when the daemon concludes it exists changes.
 */

import type { TmuxTarget } from './compact-inject.js'

/** Startup retry window: attempt delays (before each attempt), 3 over 30s. */
export const COMPACT_DETECT_DELAYS_MS: readonly number[] = [0, 10_000, 20_000]

/** Minimum spacing between late-upgrade probes at the periodic touchpoint. */
export const LATE_UPGRADE_PROBE_INTERVAL_MS = 60_000
/** Bounded late-upgrade budget (~30 minutes at the minimum spacing). */
export const LATE_UPGRADE_MAX_ATTEMPTS = 30

export interface CompactDetectDeps {
  /** Env resolution (resolveTmuxTarget); re-run each attempt. */
  resolveTarget: () => TmuxTarget | null
  /** Aliveness probe (tmux display-message on the target). May reject. */
  probe: (t: TmuxTarget) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
}

export type CompactDetection =
  | { state: 'on'; target: TmuxTarget; attempt: number; attempts: number }
  | { state: 'off'; attempts: number; windowMs: number }

async function safeProbe(
  deps: Pick<CompactDetectDeps, 'probe'>,
  t: TmuxTarget,
): Promise<boolean> {
  try {
    return await deps.probe(t)
  } catch {
    // Absent tmux binary, dead server, timeout: a failed attempt, not a crash.
    return false
  }
}

/**
 * Detect the capability with a bounded retry window. Resolves ON as soon as
 * one attempt both resolves a target and probes it alive; otherwise OFF
 * after the last attempt.
 */
export async function detectCompactCapability(
  deps: CompactDetectDeps,
  delaysMs: readonly number[] = COMPACT_DETECT_DELAYS_MS,
): Promise<CompactDetection> {
  for (let i = 0; i < delaysMs.length; i++) {
    const delay = delaysMs[i] ?? 0
    if (delay > 0) await deps.sleep(delay)
    const target = deps.resolveTarget()
    if (target && (await safeProbe(deps, target))) {
      return { state: 'on', target, attempt: i + 1, attempts: delaysMs.length }
    }
  }
  return {
    state: 'off',
    attempts: delaysMs.length,
    windowMs: delaysMs.reduce((a, b) => a + b, 0),
  }
}

/** The boot log line for a detection outcome (attempt-1 ON stays byte-identical). */
export function formatCompactDetection(d: CompactDetection): string {
  if (d.state === 'on') {
    const base = `remote compact capability ON (tmux target ${d.target.target} via ${d.target.source}`
    return d.attempt <= 1
      ? `${base})`
      : `${base}; detection succeeded late, attempt ${d.attempt} of ${d.attempts})`
  }
  return (
    'remote compact capability OFF (no tmux control of the CLI detected ' +
    `after ${d.attempts} attempts over ${Math.round(d.windowMs / 1000)}s)`
  )
}

/** The log line for a one-time late upgrade after the startup window. */
export function formatLateCompactUpgrade(t: TmuxTarget): string {
  return (
    `remote compact capability ON (tmux target ${t.target} via ${t.source}; ` +
    'detection succeeded after the startup window)'
  )
}

/**
 * One-time late upgrade driven from a periodic touchpoint. check(now) is
 * cheap and reentrancy-safe: it throttles to a minimum probe spacing, stops
 * for good after a bounded attempt budget or the first success, and treats a
 * rejecting probe as a failed attempt.
 */
export class LateCompactUpgrader {
  private attempts = 0
  private lastProbeAtMs = Number.NEGATIVE_INFINITY
  private done = false
  private inFlight = false

  constructor(
    private readonly deps: Pick<CompactDetectDeps, 'resolveTarget' | 'probe'>,
    private readonly opts: { intervalMs?: number; maxAttempts?: number } = {},
  ) {}

  /** True once upgraded or the budget is exhausted; callers may stop ticking. */
  get finished(): boolean {
    return this.done
  }

  /** Returns the target on the (single) successful upgrade, else null. */
  async check(nowMs: number): Promise<TmuxTarget | null> {
    if (this.done || this.inFlight) return null
    const interval = this.opts.intervalMs ?? LATE_UPGRADE_PROBE_INTERVAL_MS
    if (nowMs - this.lastProbeAtMs < interval) return null
    const budget = this.opts.maxAttempts ?? LATE_UPGRADE_MAX_ATTEMPTS
    if (this.attempts >= budget) {
      this.done = true
      return null
    }
    this.lastProbeAtMs = nowMs
    this.attempts++
    const target = this.deps.resolveTarget()
    if (!target) return null
    this.inFlight = true
    let alive = false
    try {
      alive = await safeProbe(this.deps, target)
    } finally {
      this.inFlight = false
    }
    if (!alive) return null
    this.done = true
    return target
  }
}
