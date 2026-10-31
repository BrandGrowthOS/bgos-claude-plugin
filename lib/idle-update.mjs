/**
 * idle-update: an idle agent loads its staged plugin update by itself (lane
 * idleupd, board row 5a455021, Data's shape; docs/idle-update/DESIGN.md).
 *
 * WHY THIS EXISTS. A staged build loads only when the session restarts, and
 * nothing restarts an idle one. Alex's Mac had 15 agents with 0.74.3 staged
 * (pendingRestartVersion, auto update on, supervised launchd) still running
 * 0.69.12 to 0.74.0: a marketplace install never asks for a restart (Claude
 * Code rewrites installed_plugins.json and the daemon only reports the
 * difference), a clone's scheduled update asks once and stages when the
 * service does not own the daemon (every gen-2 agent: run.sh starts hoai in a
 * detached tmux server), and the watcher's keep-alive sweep, which would
 * restart them, is opt-in.
 *
 * THE RULE. A build is staged and the agent has been idle for N minutes: no
 * turn, nothing owed, no running goal, no open ask card, no call, no browser
 * in use, no person attached, no wake due. Then the supervised session
 * restarts through the existing restart authority (the pinned resume keeps
 * the conversation) and the new daemon reports its version. Busy agents wait.
 * A failed restart is tried once per version and then backs off; a build that
 * does not come up healthy is rolled back by the first agent onto it (the
 * canary), or once by any other agent it fails on, and the version is held on
 * this computer so no other agent follows. Agents on one computer never restart together: each draws a
 * jitter, one restart lease is held at a time, and a 2 minute spacing follows
 * every restart. Never an interactive session a person may be typing in:
 * only a launch proven unattended qualifies. BGOS_AUTO_UPDATE off means never.
 *
 * This file holds the pure rules, each tested on its own in
 * test/idle-update.test.ts. Plain JavaScript, node >= 18 builtins only,
 * import-safe.
 */

import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { TURN_SIGNAL_HOOKS, QUIET_WINDOW_MS, LEGACY_QUIET_WINDOW_MS, STALE_TURN_MS, decideSafeMoment, isBackgroundJobCommand } from './keepalive-plan.mjs'
import { isOwnServiceProcess } from './agent-restart.mjs'
import { descendantsOf, isClaudeCommand, nearestClaudeAncestor } from './process-tree.mjs'

/** The per-agent record, in ~/.bgos-agent/<id>/. */
export const IDLE_UPDATE_FILE_NAME = 'idle-update.json'
export const IDLE_UPDATE_SCHEMA_VERSION = 1
/** The per-computer folder, ~/.bgos-agent/idle-update/: the lease and the per-version files. */
export const IDLE_UPDATE_DIR_NAME = 'idle-update'
/** The quiet windows are minutes long; a half-minute poll is plenty. */
export const IDLE_UPDATE_POLL_MS = 30_000
/** Two canaries that never came back latch the version bad: a build that kills silently costs at most two agents. */
export const MAX_CANARIES = 2
/** The rig shrinks every window by BGOS_IDLE_UPDATE_SCALE, never more than this. */
export const MAX_SCALE = 600

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Every duration the rules use, at scale 1. */
export const DEFAULT_DURATIONS = Object.freeze({
  /** The marker takeover's floor (lib/marker-takeover.mjs MIN_SESSION_UP_MS): a fresh session is never cut. */
  minUpMs: 60 * SEC,
  jitterMaxMs: 10 * MIN,
  /** Outlasts a failing agent's verdict, through hoai's 3 min relaunch wait, a 2 min start and the deadline: any shorter and the next agent walks onto a build about to be held bad. */
  leaseTtlMs: 25 * MIN,
  spacingMs: 2 * MIN,
  canaryHoldMs: 24 * HOUR,
  backoffBaseMs: 24 * HOUR,
  backoffMaxMs: 7 * DAY,
  /** lib/keepalive-plan.mjs MARKER_PENDING_MS: a marker hoai has not taken by then never will be. */
  markerStrandedMs: 5 * MIN,
  callRecentMs: 30 * MIN,
  browserRecentMs: 30 * MIN,
  /** A wakeup fires within the hour, so one the last Stop showed this long ago was cancelled or lost, and holds nothing. */
  sessionWakeHoldMs: 2 * HOUR,
  wakeGuardMs: 10 * MIN,
  watcherFreshMs: 5 * MIN,
  /** A build stays live this long before it is called good. A fault that takes a minute or two to show passed 60 s. */
  validateHoldMs: 5 * MIN,
  /**
   * From this boot's startup complete: no live proof by then is the build failing. Leaves room for a break late in
   * the hold, which starts it again: at or under the hold, this would fail every healthy build.
   */
  validateDeadlineMs: 15 * MIN,
  /** A startup that never completes is the build failing too, but a slow one is not: its own bound from arrival. */
  startupDeadlineMs: 15 * MIN,
  /** The rollback restart waits this long for a proven authority, or for a stray in its unit's group to end, before it asks for a restart by hand. */
  rollbackProofGraceMs: 10 * MIN,
  /** Past the 2 h a stale turn takes: no quiet moment by then asks for a person, because the app already says the agent went back. */
  rollbackWaitMaxMs: 3 * HOUR,
  /** An outage holds the validation deadline this long at most: past it, a build that cannot reach the backend is failing. */
  unreachableCapMs: 60 * MIN,
  /**
   * A canary is silent (never came back) only once it is older than the slowest validation this side of an expired
   * login: the startup bound, an hour of outage forgiven, the deadline, and a margin. Before that it may still be
   * validating, and the others hold.
   */
  canarySilentMs: 100 * MIN,
  /** A refused launch proof is read again this far on: never every close look (a person's own hoai), never never (one unreadable input). */
  unattendedRecheckMs: 60 * MIN,
  beaconFreshMs: 2 * MIN,
  rollbackQuietMs: 2 * MIN,
  didNotArriveMs: 3.5 * MIN,
  wakeRefreshMs: 5 * MIN,
  pollMs: IDLE_UPDATE_POLL_MS,
  /** After the process tree, a person or the schedule said wait, the next close look is this far off. */
  listBackoffMs: 5 * MIN,
  scale: 1,
})

/** Attempt outcomes that are a failed attempt for the back-off. */
const FAILED_OUTCOMES = new Set(['no_authority', 'did_not_arrive', 'came_back_old', 'context_lost', 'second_boot', 'deadline', 'failed', 'rolled_back', 'rollback_failed'])
/** Record states that are an arrived attempt's verdict. */
const VERDICT_STATES = new Set(['validated', 'failed', 'came_back_old', 'rolled_back', 'rollback_failed'])
/** Failure verdicts given while the record still says arrived: the boot that gave one goes on to roll back. */
const ROLLBACK_OUTCOMES = new Set(['second_boot', 'deadline'])
/** Restart authorities that can carry an unattended restart; 'staged' and anything unknown cannot. */
const RESTART_KINDS = new Set(['keepalive', 'service', 'launcher'])
/** launch-status outcomes only a SUPERVISED hoai writes (lib/agent-restart.mjs). */
const SUPERVISED_LAUNCH_OUTCOMES = new Set(['live', 'live-but-not-signed-in', 'no-live-marker'])

// -- Version order and durations ----------------------------------------------------------------

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/

/**
 * Numeric X.Y.Z order: -1, 0 or 1, or null when either side is not a plain
 * X.Y.Z (a text compare puts 0.80.10 before 0.80.9, and pendingRestartVersion
 * is a plain inequality, so a rollback would read as an update).
 * @param {unknown} a
 * @param {unknown} b
 * @returns {-1 | 0 | 1 | null}
 */
export function compareVersions(a, b) {
  const pa = typeof a === 'string' ? VERSION_RE.exec(a) : null
  const pb = typeof b === 'string' ? VERSION_RE.exec(b) : null
  if (!pa || !pb) return null
  for (let i = 1; i <= 3; i += 1) {
    const x = Number(pa[i])
    const y = Number(pb[i])
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Is `candidate` strictly newer than `base`? Unreadable is not newer. */
export function isNewerVersion(candidate, base) {
  return compareVersions(candidate, base) === 1
}

/** BGOS_IDLE_UPDATE_SCALE: 1 unless a positive number, at most MAX_SCALE. */
export function scaleFromEnv(raw, { backendUrl } = {}) {
  if (!isLoopbackUrl(backendUrl)) return 1
  const n = typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN
  if (!Number.isFinite(n) || n <= 1) return 1
  return Math.min(MAX_SCALE, n)
}

/** Is this backend this computer itself (the rig's stub)? Only then may a scale shrink the windows. */
function isLoopbackUrl(url) {
  let host
  try {
    host = new URL(String(url ?? '')).hostname
  } catch {
    return false
  }
  return host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * Two windows no scale shrinks below a floor: a real relaunch (hoai's marker
 * poll, claude, the daemon's boot) takes real time to arrive, and the beacon is
 * touched on a 5 s heartbeat, so it needs room to read as fresh.
 */
const SCALE_FLOORS = Object.freeze({ didNotArriveMs: DEFAULT_DURATIONS.didNotArriveMs, beaconFreshMs: 30 * SEC })

/**
 * Every duration divided by the scale (never below 1 ms, nor below its floor), the scale carried along.
 * @param {number} scale
 * @returns {typeof DEFAULT_DURATIONS}
 */
export function scaledDurations(scale) {
  const s = Number.isFinite(scale) && scale >= 1 ? Math.min(MAX_SCALE, scale) : 1
  /** @type {Record<string, number>} */
  const out = {}
  for (const [key, value] of Object.entries(DEFAULT_DURATIONS)) {
    out[key] = key === 'scale' ? s : Math.max(SCALE_FLOORS[key] ?? 1, Math.floor(value / s))
  }
  return /** @type {typeof DEFAULT_DURATIONS} */ (Object.freeze(out))
}

function clamp01(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return 0.5
  return Math.min(1, Math.max(0, x))
}

/** This agent's jitter: uniform over 0 to jitterMaxMs, drawn once per daemon. */
export function drawJitterMs(random, d = DEFAULT_DURATIONS) {
  return Math.round(clamp01(random) * d.jitterMaxMs)
}

/** How long after the last failed attempt the next may run: 24 h, doubling, at most 7 days. */
export function attemptBackoffMs(failed, d = DEFAULT_DURATIONS) {
  if (!Number.isFinite(failed) || failed <= 0) return 0
  return Math.min(d.backoffMaxMs, d.backoffBaseMs * 2 ** Math.min(30, failed - 1))
}

function finite(ms) {
  return typeof ms === 'number' && Number.isFinite(ms)
}

/** A stamp inside a window; a stamp in the future (clock skew) reads as inside: waiting is the safe error. */
function within(now, at, windowMs) {
  return finite(at) && now - at < windowMs
}

// -- The decision --------------------------------------------------------------------------------

/**
 * May this daemon restart its session onto the staged build now? Pure. The
 * gates run in this order, and the first that holds is the answer:
 *    1 updates_disabled       BGOS_AUTO_UPDATE off (action 'off')
 *    2 nothing_staged         no staged version strictly newer than this one (action 'off')
 *    3 passive                not the pairing lock holder, or shutting down
 *    4 watcher_owns_updates   the watcher's keep-alive sweep is active on this HOME
 *    5 version_held_bad       the staged version is latched bad on this computer
 *    6 no_unattended_authority  no restart authority, or a launch not proven unattended
 *    7 attempted              one attempt per version, then a doubling back-off; a rolled back version never again
 *    8 update_in_flight / launcher_latched   draining, the update lock held, or a restart marker waiting
 *    9 young                  the first minute of a daemon, or its startup not complete yet
 *   10 turn_in_flight / pending_messages / pending_permission   the watcher's safe moment
 *   11 open_ask   12 goal_running   12b session_wake (a wakeup the last Stop showed: --resume restores no self-paced /loop)
 *   13 call_active   14 browser_in_use   15 person_attached
 *   16 recent_activity / no_turn_signal   the safe moment's quiet window (10 min with the hook signal, 30 without,
 *                            and then never: with no hook signal a turn cannot be seen, so quiet proves nothing)
 *   17 jitter                 the quiet window plus this agent's own draw
 *   18 machine_busy / spacing another agent holds the computer's restart lease, or released it moments ago
 *   19 canary_unconfirmed     the first agent onto this version has not confirmed it yet
 *   20 process_tree_unreadable / background_job   read last: it is a process listing (and, for an owning
 *                            systemd unit, its cgroup: a restart ends the whole group, a job orphaned out of claude's tree too)
 *   21 wake_due / wake_schedule_unknown   a wake or call due within 10 min, or a schedule that cannot be read
 * The scale shrinks every window for the rig; the activity stamps are dilated
 * by it, so the safe moment's own windows shrink with the rest.
 * @param {any} f the facts (test/idle-update.test.ts idle() lists them)
 * @param {typeof DEFAULT_DURATIONS} [d]
 * @returns {{ action: 'restart' | 'wait' | 'off', reason: string }}
 */
export function decideIdleUpdate(f, d = DEFAULT_DURATIONS) {
  const now = f.now
  const wait = (reason) => ({ action: 'wait', reason })
  if (f.autoUpdateEnabled !== true) return { action: 'off', reason: 'updates_disabled' }
  if (!isNewerVersion(f.stagedVersion, f.runningVersion)) return { action: 'off', reason: 'nothing_staged' }
  if (f.active !== true) return wait('passive')
  if (f.watcherSweepActive) return wait('watcher_owns_updates')
  if (f.heldBad) return wait('version_held_bad')
  if (!RESTART_KINDS.has(f.authority?.kind) || f.authority?.unattended !== true) return wait('no_unattended_authority')
  const attempt = f.attempt ?? {}
  if (attempt.rolledBack || attempt.inFlight) return wait('attempted')
  if (attempt.failed > 0 && !(finite(attempt.lastAtMs) && now - attempt.lastAtMs >= attemptBackoffMs(attempt.failed, d))) {
    return wait('attempted')
  }
  if (f.draining || f.updateLockHeld) return wait('update_in_flight')
  if (finite(f.markerAgeMs)) return wait(f.markerAgeMs >= d.markerStrandedMs ? 'launcher_latched' : 'update_in_flight')
  if (!finite(f.bootAtMs) || now - f.bootAtMs < d.minUpMs || f.startupComplete !== true) return wait('young')

  // The watcher's own safe moment, with boot counted as activity. The tree is
  // judged at gate 20 (it is a process listing, read last), so here it is
  // given as clean; a stale turn behind a background job still waits there.
  const stamps = [...(Array.isArray(f.activityMs) ? f.activityMs : []), f.bootAtMs].filter(finite)
  const dilated = stamps.map((s) => now - (now - s) * d.scale)
  const safe = decideSafeMoment({ running: true, stateFresh: true, state: f.safe, descendants: [], activityMs: dilated, now })
  if (!safe.safe && safe.reason !== 'recent_activity') return wait(safe.reason)

  if (f.openAsks > 0) return wait('open_ask')
  if (f.goalRunning) return wait('goal_running')
  if (within(now, f.sessionWakeAtMs, d.sessionWakeHoldMs)) return wait('session_wake')
  const call = f.call ?? {}
  if (call.pendingConsults > 0 || call.openContinuations > 0 || call.openMeetings > 0 || within(now, call.lastVoiceAtMs, d.callRecentMs)) {
    return wait('call_active')
  }
  if (within(now, f.lastBrowserToolAtMs, d.browserRecentMs)) return wait('browser_in_use')
  if (f.personAttached !== false) return wait('person_attached')
  if (!safe.safe) return wait(safe.reason)
  // Past the 30 min a daemon with no hook signal uses: the moment it would have gone blind, it says so instead.
  if (f.safe?.turnSignal !== TURN_SIGNAL_HOOKS) return wait('no_turn_signal')

  const newest = stamps.length > 0 ? Math.max(...stamps) : now
  if (now - newest < QUIET_WINDOW_MS / d.scale + (finite(f.jitterMs) ? Math.max(0, f.jitterMs) : d.jitterMaxMs)) return wait('jitter')

  const machine = f.machine ?? {}
  if (!['free', 'mine', 'expired'].includes(machine.lease)) return wait('machine_busy')
  if (finite(machine.spacingUntilMs) && now < machine.spacingUntilMs) return wait('spacing')
  if (machine.canary === 'latch_bad' || machine.canary === 'bad') return wait('version_held_bad')
  if (!['none', 'validated', 'next', 'mine'].includes(machine.canary)) return wait('canary_unconfirmed')

  if (f.claudeKnown !== true || !Array.isArray(f.descendants)) return wait('process_tree_unreadable')
  if (f.descendants.some(isBackgroundJobCommand)) return wait('background_job')
  const strays = f.serviceStrays
  if (strays?.ok !== true || !Array.isArray(strays.strays)) return wait('process_tree_unreadable')
  if (strays.strays.length > 0) return wait('background_job')

  const wake = f.wake ?? {}
  if (wake.known !== true) return wait('wake_schedule_unknown')
  if (finite(wake.nextDueAtMs) && Math.abs(wake.nextDueAtMs - now) < d.wakeGuardMs) return wait('wake_due')

  return { action: 'restart', reason: safe.reason }
}

/**
 * The soonest wake or call that matters to a restart now: due within the
 * guard behind or anywhere ahead. One overdue by more than the guard is not
 * landing in the next minutes, and must not hide the next real one. The
 * tasks are the backend's agent view (GET scheduled-tasks/agent?status=active,
 * AgentScheduledTaskViewDto.nextFireAt).
 * @param {Array<{ nextFireAt?: string | null }> | null} tasks
 * @param {number} now
 * @returns {number | null}
 */
export function nextWakeDueMs(tasks, now, d = DEFAULT_DURATIONS) {
  let soonest = null
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const at = typeof task?.nextFireAt === 'string' ? Date.parse(task.nextFireAt) : Number.NaN
    if (!Number.isFinite(at) || at <= now - d.wakeGuardMs) continue
    if (soonest === null || at < soonest) soonest = at
  }
  return soonest
}

// -- The computer's lease and the version's canary ----------------------------------------------

/**
 * Who holds ~/.bgos-agent/idle-update/lease.json? Absent is free; my own
 * nonce is mine; another's under leaseTtlMs old is held, older is expired (the
 * controller renames it aside, then takes the lease exclusively). A file that
 * does not parse is held while young and expired once old, never free: it may
 * be another agent's lease half written.
 * @param {{ raw: string | null, mtimeMs: number | null, now: number, me: { assistantId: string, nonce: string } }} input
 * @param {typeof DEFAULT_DURATIONS} [d]
 * @returns {{ state: 'free' | 'mine' | 'held' | 'expired', lease?: any }}
 */
export function decideLease({ raw, mtimeMs, now, me }, d = DEFAULT_DURATIONS) {
  if (raw === null || raw === undefined) return { state: 'free' }
  let lease = null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && typeof parsed.assistantId === 'string' && typeof parsed.nonce === 'string') lease = parsed
  } catch {
    lease = null
  }
  if (lease && lease.assistantId === me.assistantId && lease.nonce === me.nonce) return { state: 'mine', lease }
  const stamped = lease && typeof lease.at === 'string' ? Date.parse(lease.at) : Number.NaN
  const at = Number.isFinite(stamped) ? stamped : mtimeMs
  // A stamp further ahead than a lease lives is a clock that jumped, not a holder: it would hold forever.
  if (finite(at) && at - now > d.leaseTtlMs) return { state: 'expired', lease }
  if (!finite(at) || within(now, at, d.leaseTtlMs)) return { state: 'held', lease }
  return { state: 'expired', lease }
}

/**
 * Where the staged version stands on this computer, from its folder
 * ~/.bgos-agent/idle-update/<version>/: `canary-<n>` files (created
 * exclusively, {assistantId, at}), `void-<n>` (that attempt ended with no
 * verdict, not the build's fault), `validated`, `bad`.
 *   bad        latched bad: nobody restarts onto it
 *   validated  a canary came up healthy on it: everyone may follow
 *   none       no canary yet: I would be canary 1
 *   mine       the latest live canary is mine
 *   pending    another agent's canary is restarting or validating now (inside the lease)
 *   hold       another agent's canary never came back: hold the version for canaryHoldMs
 *   next       the last canary voided, or held long enough: I would be the next
 *   latch_bad  MAX_CANARIES canaries never came back: latch it bad
 * @param {{ files: { canaries: Array<{ n: number, assistantId: string, at: number }>, voids: number[], validated: boolean, bad: boolean },
 *   now: number, me: { assistantId: string } }} input
 * @param {typeof DEFAULT_DURATIONS} [d]
 */
export function decideCanary({ files, now, me }, d = DEFAULT_DURATIONS) {
  if (files.bad) return { state: 'bad' }
  if (files.validated) return { state: 'validated' }
  // A canary stamped further ahead than a lease lives is a clock that jumped: read as long silent, never as live.
  const canaries = (Array.isArray(files.canaries) ? files.canaries : [])
    .filter((c) => Number.isInteger(c?.n) && c.n > 0)
    .map((c) => (finite(c.at) && c.at - now > d.leaseTtlMs ? { ...c, at: Number.NEGATIVE_INFINITY } : c))
  if (canaries.length === 0) return { state: 'none', next: 1 }
  const voids = new Set(Array.isArray(files.voids) ? files.voids : [])
  const next = Math.max(...canaries.map((c) => c.n)) + 1
  const live = canaries.filter((c) => !voids.has(c.n)).sort((a, b) => a.n - b.n)
  if (live.length === 0) return { state: 'next', next }
  const latest = live[live.length - 1]
  if (latest.assistantId === me.assistantId) return { state: 'mine', n: latest.n }
  const silent = live.filter((c) => !within(now, c.at, d.canarySilentMs))
  if (silent.length >= MAX_CANARIES) return { state: 'latch_bad' }
  if (within(now, latest.at, d.leaseTtlMs)) return { state: 'pending' }
  if (within(now, latest.at, d.canaryHoldMs)) return { state: 'hold' }
  return { state: 'next', next }
}

// -- The record ----------------------------------------------------------------------------------

/** ~/.bgos-agent/<id>/idle-update.json, or null when absent, junk or another schema. */
export function parseIdleUpdateRecord(raw) {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || parsed.schema !== IDLE_UPDATE_SCHEMA_VERSION) return null
    if (!Array.isArray(parsed.attempts)) return null
    // Both name folders (<machineDir>/<target>/, the rollback's from): only a plain X.Y.Z ever does.
    if (typeof parsed.target !== 'string' || !VERSION_RE.test(parsed.target)) return null
    if (typeof parsed.from !== 'string' || !VERSION_RE.test(parsed.from)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Whether the record on disk is no longer the one this daemon settled: another attempt (another nonce), the
 * same attempt settled again by a later boot (a later arrivedAt), or given its verdict or a failed attempt by another
 * daemon of this agent that held the lock since (one that adopted it), while this daemon did not hold the lock. A disk
 * that refused this daemon's own write holds an older state of the same attempt, which is not superseded: the
 * daemon still acts on what it kept. Nothing readable on disk supersedes nothing.
 * @param {any} mine
 * @param {any} onDisk
 * @returns {boolean}
 */
export function isRecordSuperseded(mine, onDisk) {
  if (!mine || !onDisk) return false
  if (onDisk.nonce !== mine.nonce) return true
  if (VERDICT_STATES.has(onDisk.state) && onDisk.state !== mine.state) return true
  if (Array.isArray(onDisk.attempts) && Array.isArray(mine.attempts) && onDisk.attempts.length > mine.attempts.length) return true
  const theirs = Date.parse(onDisk.arrivedAt)
  const ours = Date.parse(mine.arrivedAt)
  return Number.isFinite(theirs) && (!Number.isFinite(ours) || theirs > ours)
}

/**
 * The attempt facts for the staged version: how many attempts failed, when
 * the last one was, whether it was rolled back, and whether one is in flight.
 * A record for another version says nothing about this one.
 */
export function attemptFactsFor(record, target) {
  if (!record || record.target !== target) return { failed: 0, lastAtMs: null, rolledBack: false, inFlight: false }
  const attempts = Array.isArray(record.attempts) ? record.attempts : []
  const last = attempts.length > 0 ? Date.parse(attempts[attempts.length - 1]?.at) : Number.NaN
  return {
    failed: attempts.filter((a) => FAILED_OUTCOMES.has(a?.outcome)).length,
    lastAtMs: Number.isFinite(last) ? last : null,
    rolledBack: record.state === 'rolled_back' || record.state === 'rollback_failed',
    inFlight: record.state === 'requested',
  }
}

function withAttempt(record, now, outcome, fields = {}) {
  return { ...record, ...fields, attempts: [...record.attempts, { at: new Date(now).toISOString(), outcome }] }
}

/**
 * What this boot of the pairing lock holder means for the record. Settled
 * once per boot, by the lock holder only (a nested `claude -p` or a health
 * spawn never holds the lock), so `lockBoots` counts boots of the agent.
 *   arrived          a requested restart came up on the target with the same pin
 *   context_lost     ... with a NEW pin: hoai retried fresh, the conversation is gone (a failed attempt, said).
 *                    Also a later boot of the target on a new session: never a reason to roll back (a resume
 *                    that died is claude's or the transcript's, not the build's). The new pin is kept, so the
 *                    next boot on it still counts. An unknown pin (null) proves nothing either way.
 *   came_back_old    a requested restart came up on another version
 *   arrived_again    the target booted again after it proved live (every proof but the hold, liveAt), or after
 *                    its last boot ended cleanly (endedAt, whatever its age: its daemon's shutdown when its claude
 *                    went away, a person's restart, hoai relaunching a slow startup, a computer shut down
 *                    overnight), not the build. Once per record; the arrival restarts. A recent poll proves nothing: a daemon that
 *                    crashed or hung polled too, until it stopped.
 *   second_boot      the target booted again before it validated, with no clean end on record: the new build is
 *                    failing (the arrival restarts with it, so a held deadline counts from the boot that is running)
 *   rollback_failed  the target booted after a rollback: said once, never a second rollback
 *   rolled_back      back on the old version after a rollback: reported once
 *   none             nothing to settle
 * @param {any} record
 * @param {{ runningVersion: string | null, pin: string | null, now: number }} at
 * @returns {{ record: any, event: string }}
 */
export function settleRecordAtBoot(record, { runningVersion, pin, now }) {
  if (!record) return { record, event: 'none' }
  const iso = new Date(now).toISOString()
  const onTarget = runningVersion === record.target
  const newSession = typeof record.pin === 'string' && typeof pin === 'string' && pin !== '' && record.pin !== pin
  // A clean end or a live proof vouches only for the boot that wrote it: a boot on a new session starts with neither.
  const lostFields = { state: 'arrived', lockBoots: 1, arrivedAt: iso, liveAt: null, endedAt: null, contextLost: true, pin, pinBefore: record.pinBefore ?? record.pin }
  if (record.state === 'requested' || record.state === 'did_not_arrive') {
    if (onTarget) {
      if (newSession) return { record: withAttempt(record, now, 'context_lost', lostFields), event: 'context_lost' }
      return { record: { ...record, state: 'arrived', lockBoots: 1, arrivedAt: iso, contextLost: false }, event: 'arrived' }
    }
    if (record.state === 'did_not_arrive') return { record, event: 'none' }
    return { record: withAttempt(record, now, 'came_back_old', { state: 'came_back_old' }), event: 'came_back_old' }
  }
  if (record.state === 'arrived' && onTarget && newSession) {
    return { record: record.contextLost ? { ...record, ...lostFields } : withAttempt(record, now, 'context_lost', lostFields), event: 'context_lost' }
  }
  if (record.state === 'arrived' && onTarget) {
    const lockBoots = (Number.isInteger(record.lockBoots) ? record.lockBoots : 1) + 1
    const endedCleanly = typeof record.endedAt === 'string' && Number.isFinite(Date.parse(record.endedAt))
    if ((typeof record.liveAt === 'string' || endedCleanly) && record.rearrived !== true) {
      return { record: { ...record, lockBoots, arrivedAt: iso, liveAt: null, endedAt: null, rearrived: true }, event: 'arrived_again' }
    }
    return { record: withAttempt(record, now, 'second_boot', { lockBoots, arrivedAt: iso }), event: 'second_boot' }
  }
  if (record.state === 'rolled_back') {
    if (onTarget) return { record: withAttempt(record, now, 'rollback_failed', { state: 'rollback_failed' }), event: 'rollback_failed' }
    if (!record.reportedAt) return { record: { ...record, reportedAt: iso }, event: 'rolled_back' }
  }
  return { record, event: 'none' }
}

// -- Validation and rollback ---------------------------------------------------------------------

/**
 * Is the new build live: startup complete, a backend heartbeat accepted at the
 * new version since it arrived, a channel beacon this daemon touched while
 * delivering, no deaf verdict? Every proof but the hold.
 */
export function isLiveBuild({ arrivedAtMs, now, startupComplete, heartbeatOkAtMs, beaconAtMs, deaf }, d = DEFAULT_DURATIONS) {
  return (
    finite(arrivedAtMs) &&
    startupComplete === true &&
    finite(heartbeatOkAtMs) &&
    heartbeatOkAtMs >= arrivedAtMs &&
    finite(beaconAtMs) &&
    now - beaconAtMs < d.beaconFreshMs &&
    deaf !== true
  )
}

/**
 * Did the new build come up healthy? Live (isLiveBuild) without a break since
 * `liveSinceMs` on this boot, for validateHoldMs, with the beacon touched and
 * a heartbeat landed during the hold (one reading still fresh from before it
 * proves nothing about it). No proof by validateDeadlineMs after this boot's
 * startup completed (`startupCompleteAtMs`) is the deadline: a slow startup is
 * not the build failing. A startup that never completes has its own bound,
 * startupDeadlineMs after arrival. Either counts only time this computer could
 * prove anything: never while the shared login has expired, and never the
 * time asleep, not the lock holder or under an expired login (`suspendedMs`).
 * An outage (`unreachableMs`) is forgiven for unreachableCapMs at most: past
 * that, a build that cannot reach the backend is the one failing.
 * @returns {'validated' | 'pending' | 'deadline'}
 */
export function decideValidation(input, d = DEFAULT_DURATIONS) {
  const { arrivedAtMs, now, loginExpired, backendUnreachable, suspendedMs, unreachableMs, liveSinceMs, startupCompleteAtMs, beaconAtMs, heartbeatOkAtMs } = input
  if (!finite(arrivedAtMs)) return 'pending'
  const held = finite(liveSinceMs) && liveSinceMs >= arrivedAtMs && now - liveSinceMs >= d.validateHoldMs
  if (isLiveBuild(input, d) && held && beaconAtMs > liveSinceMs && heartbeatOkAtMs >= liveSinceMs) return 'validated'
  if (loginExpired === true) return 'pending'
  const down = finite(unreachableMs) && unreachableMs > 0 ? unreachableMs : 0
  if (backendUnreachable === true && down < d.unreachableCapMs) return 'pending'
  const started = finite(startupCompleteAtMs)
  const from = started ? Math.max(arrivedAtMs, startupCompleteAtMs) : arrivedAtMs
  const counted = now - from - (finite(suspendedMs) && suspendedMs > 0 ? suspendedMs : 0) - Math.min(down, d.unreachableCapMs)
  return counted >= (started ? d.validateDeadlineMs : d.startupDeadlineMs) ? 'deadline' : 'pending'
}

/** Did a backend call reach a working backend? Any answer below 500 did; a 5xx, or no answer at all (null), did not. */
export function isBackendAnswer(status) {
  return Number.isInteger(status) && status < 500
}

/**
 * The daemon's shutdown causes that mean its claude went away (lib/process-lifecycle.ts ShutdownCause): stdin ended
 * or closed; a signal (a person, hoai, the keepalive; a hangup when claude's pty went and the kernel hung up its
 * whole process group, which reaches shutdown only while the clean end signals are open); a broken pipe on the
 * daemon's own stdout or stderr, whose reader is claude. Not
 * 'broken-pipe': the fault handlers' write after end on ANY stream, as likely a fault in the build.
 */
const CLEAN_END_CAUSES = new Set(['stdin-end', 'stdin-close', 'SIGTERM', 'SIGINT', 'SIGHUP', 'stdout-epipe'])

/**
 * Did this daemon end because its claude went away, not because the build failed?
 * @param {unknown} cause
 */
export function isCleanEnd(cause) {
  return CLEAN_END_CAUSES.has(cause)
}

/**
 * Who undoes a failed build. The canary's failure is the version's verdict, so
 * it always rolls back the shared install (and latches the version bad). Any
 * other agent has that way back too, but once until it next validates a build:
 * as a follower, one agent broken for its own reasons costs this computer one
 * release, not every one. Past that it reports. An expired login does none of
 * this: the build was never the cause.
 * @returns {'rollback' | 'report_only' | 'none'}
 */
export function decideRollback({ canary, wentBack, loginExpired }) {
  if (loginExpired) return 'none'
  return canary || !wentBack ? 'rollback' : 'report_only'
}

/**
 * What a rollback goes back to: the newer of this agent's own build and the one
 * the canary left (`<target>/validated`), so one agent that came from an older
 * build does not take the whole computer further back than it has to. Never one
 * held bad here while the other is good, and with both held, its own: it ran
 * here until this restart. The canary's counts only beside this
 * agent's own in the same marketplace cache: another config folder's, or a
 * checkout's, is no build this install can stand on. A clone goes back on its
 * own checkout: another agent's commit names nothing in it.
 * @param {any} mine
 * @param {any} canary the body of `<target>/validated`
 * @param {{ heldBad?: (version: string) => boolean, holds?: (source: { from: string, fromRoot: string }) => boolean }} [checks]
 * @returns {{ from: string, fromRoot: string | null, fromCommit: string | null }}
 */
export function rollbackSourceFor(mine, canary, { heldBad = () => false, holds = () => true } = {}) {
  const own = { from: mine.from, fromRoot: mine.fromRoot, fromCommit: mine.fromCommit ?? null }
  const beside =
    mine.installMethod === 'marketplace' &&
    typeof canary?.fromRoot === 'string' &&
    typeof mine.fromRoot === 'string' &&
    dirname(canary.fromRoot) === dirname(mine.fromRoot)
  if (!beside || !VERSION_RE.test(String(canary.from)) || heldBad(canary.from) || !holds(canary)) return own
  return heldBad(mine.from) || isNewerVersion(canary.from, mine.from) ? { from: canary.from, fromRoot: canary.fromRoot, fromCommit: null } : own
}

/**
 * What a Stop's `session_crons` says a restart would lose. Claude Code restores
 * a recurring task on --resume, but not a pending wakeup (a self-paced /loop),
 * which it lists with `recurring: false`. Anything not plainly recurring counts:
 * the safe side holds. No array is no reading: an older Claude Code sends none.
 * @returns {boolean | null}
 */
export function sessionWakePending(crons) {
  if (!Array.isArray(crons)) return null
  return crons.some((task) => task?.recurring !== true)
}

// -- Unattended and own launcher proofs ----------------------------------------------------------

function rowsByPid(processes) {
  return new Map(processes.map((p) => [p.pid, p]))
}

/** The ancestors of a pid, nearest first; a ppid cycle (pid reuse) ends the walk. */
function ancestorsOf(processes, pid) {
  const byPid = rowsByPid(processes)
  const out = []
  const seen = new Set([pid])
  let current = byPid.get(pid)
  while (current) {
    const parent = byPid.get(current.ppid)
    if (!parent || seen.has(parent.pid)) break
    out.push(parent)
    seen.add(parent.pid)
    current = parent
  }
  return out
}

/** Does this command line name exactly `path` (any case, either slash), as a whole argument? */
function namesFile(command, path) {
  if (typeof path !== 'string' || !path) return false
  const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase()
  const escaped = norm(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[\\s"])${escaped}(?=["\\s]|$)`).test(norm(command))
}

/**
 * Is this session's launch proven unattended, so no person can be typing in
 * it? A keepalive script and a service that owns the daemon are, by
 * construction. A hoai launcher only with proof:
 *   - Windows: its parent is wscript running THIS agent's run-agent.vbs (runAgentVbsPath),
 *     that file runs the launcher hidden (`, 0, True)`) and was on disk before
 *     the launcher started (lib/agent-windows.mjs startedHidden). A typed
 *     `hoai --keep-alive` is not proof: the help tells people to type it.
 *   - macOS and Linux: an ancestor is the agent's own service process (its
 *     tmux server, or its run.sh: lib/agent-restart.mjs isOwnServiceProcess),
 *     or a supervised launch-status (only the supervised expect gate writes
 *     one) written at or after the claim in supervisor.json.
 * No process table on Windows is no proof.
 * @returns {{ unattended: boolean, how: string }}
 */
export function proveUnattended(input) {
  const { platform, authorityKind, launcherPid, processes } = input
  if (authorityKind === 'keepalive' || authorityKind === 'service') return { unattended: true, how: authorityKind }
  if (authorityKind !== 'launcher' || !Number.isInteger(launcherPid)) return { unattended: false, how: 'no_launcher' }
  const table = Array.isArray(processes) ? processes : null
  if (platform === 'win32') {
    if (!table) return { unattended: false, how: 'process_tree_unreadable' }
    const launcher = rowsByPid(table).get(launcherPid)
    const parent = launcher ? rowsByPid(table).get(launcher.ppid) : null
    const text = String(parent?.command ?? '')
    if (!/wscript(\.exe)?"?\s/i.test(text) || !namesFile(text, input.runAgentVbsPath)) return { unattended: false, how: 'not_the_agent_task' }
    const vbs = input.runAgentVbs ?? {}
    const hidden = /, 0, True\)\s*$/.test(String(vbs.text ?? ''))
    if (!hidden || !finite(vbs.mtimeMs) || !finite(input.launcherStartedAtMs) || vbs.mtimeMs >= input.launcherStartedAtMs) {
      return { unattended: false, how: 'task_not_hidden' }
    }
    return { unattended: true, how: 'agent_task' }
  }
  const status = input.launchStatus ?? {}
  if (SUPERVISED_LAUNCH_OUTCOMES.has(status.outcome) && finite(status.mtimeMs) && finite(input.supervisorMtimeMs) && status.mtimeMs >= input.supervisorMtimeMs) {
    return { unattended: true, how: 'launch_status' }
  }
  if (table) {
    const service = ancestorsOf(table, launcherPid).find((p) => isOwnServiceProcess(p.command, input.ownSockets ?? [], input.runShPath))
    if (service) return { unattended: true, how: 'own_service' }
  }
  return { unattended: false, how: table ? 'no_service_above' : 'process_tree_unreadable' }
}

/**
 * Is `launcherPid` the hoai that supervises THIS daemon's session? It must be
 * a strict live ancestor whose command is hoai-core.mjs, and the nearest
 * claude above this daemon must be hoai's own (no other claude between them):
 * the pid proven is the pid a marker relaunch replaces, so a nested `claude -p`
 * whose daemon took the lock never gets the outer session killed under it
 * (the keepaliveOwnsProcess rule, lib/update-readiness.ts).
 * @param {{ ownPid: number, launcherPid: number | null, processes: Array<{ pid: number, ppid: number, command: string }> | null }} input
 * @returns {{ proven: boolean, reason: string }}
 */
export function proveOwnLauncher({ ownPid, launcherPid, processes }) {
  if (!Array.isArray(processes)) return { proven: false, reason: 'process_tree_unreadable' }
  if (!Number.isInteger(launcherPid) || launcherPid === ownPid) return { proven: false, reason: 'no_launcher' }
  const ancestors = ancestorsOf(processes, ownPid)
  const at = ancestors.findIndex((p) => p.pid === launcherPid)
  if (at < 0) return { proven: false, reason: 'not_an_ancestor' }
  if (!/hoai-core\.mjs/i.test(String(ancestors[at].command ?? ''))) return { proven: false, reason: 'not_hoai' }
  const claude = nearestClaudeAncestor(processes, ownPid)
  const claudeAt = ancestors.findIndex((p) => p.pid === claude)
  if (claude === null || claudeAt < 0 || claudeAt > at) return { proven: false, reason: 'no_claude' }
  if (ancestors.slice(claudeAt + 1, at).some((p) => isClaudeCommand(p.command))) return { proven: false, reason: 'nested_claude' }
  return { proven: true, reason: 'own_launcher' }
}

// -- Marketplace rollback ------------------------------------------------------------------------

const HOAI_PLUGIN_ID = 'hoai@hoai'

/** The user-scope hoai entry of a parsed installed_plugins.json (the one Claude Code loads), or null. */
function hoaiUserEntry(doc) {
  const raw = doc && typeof doc === 'object' && doc.plugins && typeof doc.plugins === 'object' ? doc.plugins[HOAI_PLUGIN_ID] : null
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []
  return list.find((item) => item && typeof item === 'object' && item.scope === 'user') ?? (Array.isArray(raw) ? null : (list[0] ?? null))
}

/**
 * installed_plugins.json with the user-scope hoai entry pointed back at the
 * old version and folder (Claude Code loads the plugin from installPath, so
 * the next launch boots the old build). Every other entry and field is kept.
 * Refused, never rewritten, when the document does not parse or has no entry.
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function repointInstalledPlugins(rawText, { version, installPath, now }) {
  let doc
  try {
    doc = JSON.parse(rawText)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  const entry = hoaiUserEntry(doc)
  if (!entry) return { ok: false, reason: 'no_entry' }
  entry.version = version
  entry.installPath = installPath
  entry.lastUpdated = new Date(now).toISOString()
  return { ok: true, text: `${JSON.stringify(doc, null, 2)}\n` }
}

/** Does installed_plugins.json's hoai entry (the one repointInstalledPlugins writes) say this version and folder? */
export function installedPluginsPointsAt(rawText, { version, installPath }) {
  let doc
  try {
    doc = JSON.parse(rawText)
  } catch {
    return false
  }
  const entry = hoaiUserEntry(doc)
  return Boolean(entry) && entry.version === version && entry.installPath === installPath
}

/**
 * Keep Claude Code's own startup plugin update off for the marketplace while
 * its latest version is one latched bad here (it would reinstall the build the
 * rollback just left), or while the latest is not known. A newer version
 * than the bad one lets it run again.
 */
export function holdMarketplaceEnrolment({ latestKnownVersion, badVersions }) {
  const bad = Array.isArray(badVersions) ? badVersions : []
  if (bad.length === 0) return false
  if (typeof latestKnownVersion !== 'string' || !latestKnownVersion) return true
  return bad.includes(latestKnownVersion)
}

// -- Reporting -----------------------------------------------------------------------------------

const MESSAGE_MAX = 300

function bounded(code, message, at) {
  return { code, message: message.length > MESSAGE_MAX ? `${message.slice(0, MESSAGE_MAX - 3)}...` : message, at }
}

/**
 * The heartbeat's lastError for the record, or null (which clears a standing
 * one). A restart that did not arrive or came back old uses the app's standing
 * code for a failed automatic update, with when it will try again.
 * @param {any} record
 * @param {{ runningVersion: string | null }} at
 */
export function idleUpdateLastError(record, { runningVersion }, d = DEFAULT_DURATIONS) {
  if (!record) return null
  const attempts = Array.isArray(record.attempts) ? record.attempts : []
  const lastAt = attempts.length > 0 ? String(attempts[attempts.length - 1]?.at ?? '') : new Date(0).toISOString()
  const target = record.target
  const running = runningVersion ?? 'unknown'
  switch (record.state) {
    case 'no_authority':
    case 'did_not_arrive':
    case 'came_back_old': {
      if (record.markerStranded) return launcherLatchedError(target, lastAt)
      const facts = attemptFactsFor(record, target)
      const nextAt = finite(facts.lastAtMs) ? new Date(facts.lastAtMs + attemptBackoffMs(facts.failed, d)).toISOString() : 'later'
      return bounded(
        'scheduled_update_failed',
        `The restart onto plugin ${target} did not take; this agent still runs ${running}. It will try again after ${nextAt}.`,
        lastAt,
      )
    }
    case 'rolled_back':
      return bounded(
        'idle_update_rolled_back',
        `Plugin ${target} did not come up healthy, so this agent went back to ${record.from}. ` +
          (record.installMethod === 'marketplace'
            ? `${target} is held on this computer until a newer version.`
            : 'Updates on this checkout stay paused until a person boots it once with BGOS_AUTO_UPDATE off, then once with it on.'),
        lastAt,
      )
    case 'rollback_failed':
      return bounded(
        'idle_update_rollback_failed',
        `Plugin ${target} did not come up healthy and going back to ${record.from} did not take; this agent runs ${running}. A restart by hand loads what is installed, which may be this same build.`,
        lastAt,
      )
    case 'failed':
      return bounded(
        'idle_update_failed',
        `Plugin ${target} did not come up healthy on this agent; it runs ${running}. It has used its one way back and has not validated a build since, so it leaves the install alone. A restart by hand loads what is installed, which may be this same build.`,
        lastAt,
      )
    case 'arrived':
    case 'validated':
      if (record.contextLost) {
        return bounded('idle_update_context_lost', `The restart onto plugin ${target} could not resume the conversation; this agent started a new one.`, lastAt)
      }
      return null
    default:
      return null
  }
}

function launcherLatchedError(target, at) {
  return bounded('idle_update_launcher_latched', `Plugin ${target} is ready but this agent's launcher stopped taking restart requests; restart the agent once by hand.`, at)
}

/** The heartbeat's lastError for a wait that stands and needs a person, or null. */
export function idleUpdateWaitError(reason, { target, runningVersion, now }) {
  const at = new Date(now).toISOString()
  if (reason === 'version_held_bad') {
    return bounded('idle_update_held', `Plugin ${target} is held on this computer after it failed here; this agent stays on ${runningVersion}.`, at)
  }
  if (reason === 'launcher_latched') return launcherLatchedError(target, at)
  if (reason === 'no_turn_signal') {
    return bounded(
      'idle_update_no_turn_signal',
      `Plugin ${target} is ready, but no hook event is on record for this session, so it cannot tell when it is idle and stays on ${runningVersion}. A hook event ends this wait; if it has no hooks, restart it once by hand.`,
      at,
    )
  }
  return null
}

// -- The rollback restart's moment ---------------------------------------------------------------

/**
 * May an agent that went back restart onto the old build now? A shorter quiet than
 * the update's (rollbackQuietMs since the newest activity, boot included; the
 * 30 min quiet with no hook signal, since then a turn cannot be seen, and never
 * held for the signal itself: a deaf build gets no turns, so it may never come),
 * but the same respect as the update restart: the lock holder only, never
 * while draining, only through an authority proven unattended (never a
 * session a person may be typing in), no turn, nothing owed, no permission
 * card, no open ask, no goal, no call, no browser in use, nobody attached, no
 * background job, a readable tree, no wake due. A schedule the failing build
 * cannot read does not hold it: that would keep it on the build that fails.
 * A deaf build gets no turns, so this comes quickly where it matters, and a
 * turn that was already open when it went deaf never reaches its Stop, so a
 * turn flag nothing has backed for 2 h stops counting, as at gate 10.
 * @returns {{ go: boolean, reason: string }}
 */
export function decideRollbackMoment(f, d = DEFAULT_DURATIONS) {
  const no = (reason) => ({ go: false, reason })
  if (f.active !== true) return no('passive')
  if (f.draining) return no('update_in_flight')
  if (!RESTART_KINDS.has(f.authority?.kind) || f.authority?.unattended !== true) return no('no_unattended_authority')
  const s = f.safe ?? {}
  const stamps = [...(Array.isArray(f.activityMs) ? f.activityMs : []), f.bootAtMs].filter(finite)
  const newest = stamps.length > 0 ? Math.max(...stamps) : null
  const staleTurn = newest !== null && f.now - newest >= STALE_TURN_MS / d.scale && Array.isArray(f.descendants) && !f.descendants.some(isBackgroundJobCommand)
  if (s.turnInFlight && !staleTurn) return no('turn_in_flight')
  if (s.pendingMessages > 0 || s.activeOperations > 0) return no('pending_messages')
  if (s.pendingPermissions > 0) return no('pending_permission')
  if (f.openAsks > 0) return no('open_ask')
  if (f.goalRunning) return no('goal_running')
  const call = f.call ?? {}
  if (call.pendingConsults > 0 || call.openContinuations > 0 || call.openMeetings > 0 || within(f.now, call.lastVoiceAtMs, d.callRecentMs)) {
    return no('call_active')
  }
  if (within(f.now, f.lastBrowserToolAtMs, d.browserRecentMs)) return no('browser_in_use')
  if (f.personAttached !== false) return no('person_attached')
  if (f.claudeKnown !== true || !Array.isArray(f.descendants)) return no('process_tree_unreadable')
  if (f.descendants.some(isBackgroundJobCommand)) return no('background_job')
  const strays = f.serviceStrays
  if (strays?.ok !== true || !Array.isArray(strays.strays)) return no('process_tree_unreadable')
  if (strays.strays.length > 0) return no('background_job')
  const quiet = s.turnSignal === TURN_SIGNAL_HOOKS ? d.rollbackQuietMs : LEGACY_QUIET_WINDOW_MS / d.scale
  if (newest !== null && f.now - newest < quiet) return no('recent_activity')
  const wake = f.wake ?? {}
  if (wake.known === true && finite(wake.nextDueAtMs) && Math.abs(wake.nextDueAtMs - f.now) < d.wakeGuardMs) return no('wake_due')
  return { go: true, reason: 'quiet' }
}

// -- The controller ------------------------------------------------------------------------------

const LEASE_FILE = 'lease.json'
const RELEASED_FILE = 'released.json'
/** Record states whose report stands whatever is staged now: they say what happened to this agent. */
const ALWAYS_SHOWN = new Set(['rolled_back', 'rollback_failed', 'failed'])

/** Is `version` latched bad on this computer (`<machineDir>/<version>/bad`)? Only a plain X.Y.Z names a folder. */
export function isVersionHeldBad(version, { machineDir, fs }) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) return false
  try {
    return fs.readFile(join(machineDir, version, 'bad')) !== null
  } catch {
    return false
  }
}

function parseJsonOrNull(raw) {
  if (typeof raw !== 'string' || !raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const SESSION_ON_LINE_RE = /(?:^|\s)--(?:resume|session-id)(?:=|\s+)"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"?(?=\s|$)/i

/** The session id hoai passed claude (`--resume <id>` or `--session-id <id>`), or null. */
export function sessionIdFromCommand(command) {
  const match = SESSION_ON_LINE_RE.exec(String(command ?? ''))
  return match ? match[1].toLowerCase() : null
}

const CONTINUE_RE = /(?:^|\s)(?:--continue|-c)(?=\s|$)/

/**
 * Does this claude command resume a pinned session, and never bare --continue?
 * A keepalive script restarts claude with the command it ran before; one that
 * says --continue in a shared folder resumes whoever spoke last there (the
 * 2026-08-23 identity bleed), so its restart is never taken.
 */
export function resumesPinnedSession(command) {
  return sessionIdFromCommand(command) !== null && !CONTINUE_RE.test(String(command ?? ''))
}

function oneLine(value) {
  const text = value instanceof Error ? value.message : String(value ?? '')
  return text.replace(/\s+/g, ' ').trim().slice(0, 200) || 'empty'
}

/** A dependency read that never throws: telemetry and facts must never stop the session. */
function read(fn, fallback) {
  try {
    const value = fn()
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

/**
 * The daemon's controller. Armed by server.ts after "startup complete"; every
 * tick it first settles the record once (only as the pairing lock holder),
 * then does what its phase needs:
 *   watch      decideIdleUpdate on the cheap facts; only when that says
 *              restart, a close look (the process table, a person attached,
 *              the wake schedule read fresh, the session id), then every rule
 *              again on the real facts, then the act: the lease, the canary,
 *              the record (no record, no restart), the drain, the ladder.
 *   requested  waiting to be replaced; still here after didNotArriveMs is a
 *              failed attempt (the ladder's own watchdog un-drains), and the
 *              marker it left, if hoai never read it, is taken back.
 *   validate   the new daemon proves the new build (decideValidation).
 *   rollback   the agent a build failed on undoes it, latches it bad, and
 *              restarts onto the old one at a quiet moment.
 * Each reason to wait is logged once per staged version. Every effect is
 * injected (test/idle-update.controller.test.ts).
 * @param {any} deps
 */
export function createIdleUpdate(deps) {
  const d = deps.durations ?? DEFAULT_DURATIONS
  const fs = deps.fs
  const dir = deps.paths.machineDir
  const wentBackPath = join(dir, `went-back-${deps.assistantId}`)
  const now = () => deps.now()
  const iso = (ms) => new Date(ms).toISOString()
  const log = (text) => {
    try {
      deps.log(`idle update: ${text}`)
    } catch {
      // A log that throws must never stop the session.
    }
  }
  const jitterMs = drawJitterMs(read(deps.random, 0.5), d)
  let phase = 'settle'
  let record = null
  let busy = false
  let interval = null
  let listAfterMs = 0
  let requestedAtMs = null
  let rollbackWaitSinceMs = 0
  let rollbackStage = null
  let unattendedCache = null
  let transientError = null
  /** Validation's clocks: the last tick (wall and monotonic), and the time it could not count (unreachable, asleep). */
  let lastValidateAt = null
  let suspendedMs = 0
  /** The minutes the backend could not be reached during validation: forgiven up to unreachableCapMs. */
  let unreachableMs = 0
  /** Since when a stray in the owning unit's group has held the rollback restart. */
  let straysSinceMs = null
  /** This boot's startup complete, as the validation first saw it: the deadline counts from it. */
  let startupCompleteAtMs = null
  /** Since when every proof but the hold has held without a break: the hold counts from it. */
  let liveSinceMs = null
  /** Since when the rollback restart's authority has read as not proven. */
  let unprovenSinceMs = null
  let reportedKey
  let watchedTarget
  /** Whether the clean end signals are open (lib/process-lifecycle.ts createCleanEndSignals). */
  let guarded = false
  /** The restart marker the last ask left, by its exact mtime: nothing in the file names its writer. */
  let askedMarkerMs = null
  const said = new Set()

  const waiting = (decision) => {
    const key = `${decision.action}:${decision.reason}`
    if (decision.reason === 'young' || said.has(key)) return
    said.add(key)
    log(decision.action === 'off' ? `off: ${decision.reason}` : `waiting: ${decision.reason}`)
  }

  /**
   * A second boot of a new build is a failed build unless the first ended cleanly or had proved live, so only that
   * window needs its clean end noted whatever ends it. Every other daemon keeps main's signals.
   */
  const syncCleanEndSignals = () => {
    const open = read(deps.active, false) === true && phase === 'validate' && record?.state === 'arrived' && !record.liveAt
    if (open === guarded) return
    guarded = open
    read(() => deps.guardCleanEnd(open), null)
  }

  const writeRecord = (next) => {
    let ok = false
    try {
      ok = fs.writeAtomic(deps.paths.record, `${JSON.stringify(next, null, 2)}\n`) === true
    } catch {
      ok = false
    }
    if (!ok) log(`could not write ${deps.paths.record}`)
    return ok
  }
  /** The record on disk, when another boot settled it (or another attempt replaced it) since this daemon did. */
  const supersededOnDisk = () => {
    const onDisk = parseIdleUpdateRecord(read(() => fs.readFile(deps.paths.record), null))
    return isRecordSuperseded(record, onDisk) ? onDisk : null
  }
  /** A transition after the ask: kept in memory even when the disk refuses it, so this daemon still acts on it. */
  const settleTo = (next) => {
    writeRecord(next)
    record = next
    return next
  }

  const publish = (waitReason) => {
    const staged = read(deps.stagedVersion, null)
    let err = transientError
    if (!err && record && (record.target === staged || record.target === deps.runningVersion || ALWAYS_SHOWN.has(record.state))) {
      err = idleUpdateLastError(record, { runningVersion: deps.runningVersion }, d)
    }
    if (!err && waitReason) err = idleUpdateWaitError(waitReason, { target: staged, runningVersion: deps.runningVersion, now: now() })
    const key = err ? `${err.code}|${err.message}` : 'none'
    if (key === reportedKey) return
    reportedKey = key
    try {
      deps.report(err ?? null)
    } catch {
      // Reporting is never control flow.
    }
  }

  // -- the computer's files ----------------------------------------------------------------------

  const create = (path, body) => {
    try {
      return fs.createExclusive(path, `${JSON.stringify(body)}\n`)
    } catch {
      return 'error'
    }
  }
  const leasePath = join(dir, LEASE_FILE)
  const readLease = (me) => {
    const raw = read(() => fs.readFile(leasePath), null)
    return { raw, ...decideLease({ raw, mtimeMs: read(() => fs.mtimeMs(leasePath), null), now: now(), me }, d) }
  }
  /**
   * Move the lease aside only if it is still the one read (`expectedRaw`); one that changed meanwhile is put back.
   * The tag carries a nonce read from disk, so only a plain one may name the file: never a path.
   */
  const moveLeaseAside = (expectedRaw, tag) => {
    if (typeof tag !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(tag)) return false
    const aside = join(dir, `lease.${tag}.json`)
    if (!read(() => fs.rename(leasePath, aside), false)) return false
    const moved = read(() => fs.readFile(aside), null)
    if (moved !== expectedRaw) {
      if (moved !== null) read(() => fs.createExclusive(leasePath, moved), 'error')
      read(() => fs.remove(aside), false)
      return false
    }
    read(() => fs.remove(aside), false)
    return true
  }
  const takeLease = (target, me) => {
    const lease = readLease(me)
    if (lease.state === 'mine') return true
    if (lease.state === 'held') return false
    if (lease.state === 'expired' && !moveLeaseAside(lease.raw, `broken-${me.nonce}`)) return false
    if (create(leasePath, { assistantId: me.assistantId, target, nonce: me.nonce, at: iso(now()) }) !== 'ok') return false
    return readLease(me).state === 'mine'
  }
  const releaseLease = (nonce, target) => {
    if (typeof nonce !== 'string' || !nonce) return false
    const lease = readLease({ assistantId: deps.assistantId, nonce })
    if (lease.state !== 'mine') return false
    read(() => fs.writeAtomic(join(dir, RELEASED_FILE), `${JSON.stringify({ assistantId: deps.assistantId, target, at: iso(now()) })}\n`), false)
    return moveLeaseAside(lease.raw, `released-${nonce}`)
  }
  const versionFiles = (target) => {
    const vdir = join(dir, target)
    const canaries = []
    const voids = []
    for (const name of read(() => fs.listDir(vdir), null) ?? []) {
      const canary = /^canary-(\d+)$/.exec(name)
      if (canary) {
        const body = parseJsonOrNull(read(() => fs.readFile(join(vdir, name)), null))
        const at = Date.parse(body?.at)
        canaries.push({ n: Number(canary[1]), assistantId: String(body?.assistantId ?? ''), at: Number.isFinite(at) ? at : read(() => fs.mtimeMs(join(vdir, name)), 0) })
        continue
      }
      const voided = /^void-(\d+)$/.exec(name)
      if (voided) voids.push(Number(voided[1]))
    }
    const has = (name) => read(() => fs.readFile(join(vdir, name)), null) !== null
    return { canaries, voids, validated: has('validated'), bad: has('bad') }
  }
  const voidCanary = (rec, reason) => {
    if (!rec || !Number.isInteger(rec.canaryN)) return
    create(join(dir, rec.target, `void-${rec.canaryN}`), { assistantId: deps.assistantId, at: iso(now()), reason })
  }
  const markVersion = (target, name, body) => create(join(dir, target, name), { assistantId: deps.assistantId, at: iso(now()), ...body })

  // -- the facts ---------------------------------------------------------------------------------

  const cheapAuthority = () => {
    const kind = read(deps.authorityKind, 'staged')
    if (!RESTART_KINDS.has(kind)) return { kind: 'staged', unattended: false }
    const key = `${kind}:${read(deps.launcher, null)?.pid ?? ''}`
    const hit = unattendedCache?.key === key && now() < unattendedCache.until
    return { kind, unattended: hit ? unattendedCache.value : true }
  }

  const baseFacts = (staged) => {
    const n = now()
    const newer = read(deps.autoUpdateEnabled, false) === true && isNewerVersion(staged, deps.runningVersion)
    const me = { assistantId: deps.assistantId, nonce: '' }
    let machine = { lease: 'free', spacingUntilMs: null, canary: 'none' }
    if (newer) {
      const lease = readLease(me)
      const released = parseJsonOrNull(read(() => fs.readFile(join(dir, RELEASED_FILE)), null))
      const releasedAt = typeof released?.at === 'string' ? Date.parse(released.at) : Number.NaN
      // A release stamped further ahead than the spacing is a clock that jumped, not a release: it holds nothing.
      const spacing = Number.isFinite(releasedAt) && releasedAt - n <= d.spacingMs
      machine = {
        lease: lease.state,
        spacingUntilMs: spacing ? releasedAt + d.spacingMs : null,
        canary: decideCanary({ files: versionFiles(staged), now: n, me }, d).state,
      }
      // Two canaries never came back: the version is latched bad where every reader of the latch looks.
      if (machine.canary === 'latch_bad') markVersion(staged, 'bad', { reason: 'canaries_silent' })
    }
    const marker = read(deps.markerMtimeMs, null)
    return {
      now: n,
      autoUpdateEnabled: read(deps.autoUpdateEnabled, false),
      runningVersion: deps.runningVersion,
      stagedVersion: staged,
      active: read(deps.active, false),
      watcherSweepActive: read(deps.watcherSweepActive, false),
      heldBad: newer && isVersionHeldBad(staged, { machineDir: dir, fs }),
      attempt: attemptFactsFor(record, staged),
      draining: read(deps.draining, false),
      updateLockHeld: read(deps.updateLockHeld, false),
      markerAgeMs: finite(marker) ? n - marker : null,
      bootAtMs: deps.bootAtMs,
      startupComplete: read(deps.startupComplete, false),
      safe: read(deps.safeState, null) ?? { turnInFlight: true },
      openAsks: read(deps.openAsks, 1),
      goalRunning: read(deps.goalRunning, true),
      sessionWakeAtMs: read(deps.sessionWakeAtMs, null),
      call: read(deps.call, null) ?? { pendingConsults: 1 },
      lastBrowserToolAtMs: read(deps.lastBrowserToolAtMs, null),
      // An activity reading that fails is activity now: never quiet by accident.
      activityMs: read(deps.activityMs, [n]),
      jitterMs,
      machine,
    }
  }

  /** The authority this restart can really use, from the process table: the own launcher rung's proof included. */
  const resolveAuthority = (processes, claudePid) => {
    const kind = read(deps.authorityKind, 'staged')
    if (kind === 'keepalive' || (kind === 'service' && read(deps.serviceOwnsUs, false) === true)) {
      // The keepalive relaunches claude as it ran, an owning job as its unit says: only a claude resuming a pinned
      // session keeps the conversation (a bare --continue resumes whoever spoke last; a gen-1 run.sh starts it
      // fresh, and nothing would say the conversation was lost).
      const row = processes && claudePid !== null ? processes.find((p) => p.pid === claudePid) : null
      // A table that could not be read (or has no claude row) proves nothing either way: not remembered.
      if (!row) return { kind, unattended: false, proof: null }
      const pinned = resumesPinnedSession(row.command)
      unattendedCache = { key: `${kind}:${read(deps.launcher, null)?.pid ?? ''}`, value: pinned, until: Number.POSITIVE_INFINITY }
      return { kind, unattended: pinned, proof: null }
    }
    if (!RESTART_KINDS.has(kind)) return { kind: 'staged', unattended: false, proof: null }
    const launcher = read(deps.launcher, null)
    if (!launcher || !processes) return { kind, unattended: false, proof: null }
    const own = proveOwnLauncher({ ownPid: deps.ownPid, launcherPid: launcher.pid, processes })
    // The launcher process's own start where the table has it: hoai rewrites
    // its claim (and its startedAt) before every relaunch, so the claim can
    // postdate a run-agent.vbs rewritten after the launcher really started.
    const row = processes.find((p) => p.pid === launcher.pid)
    const unattended = proveUnattended({
      platform: deps.platform,
      authorityKind: 'launcher',
      launcherPid: launcher.pid,
      processes,
      ...(read(deps.unattendedInputs, null) ?? {}),
      supervisorMtimeMs: launcher.supervisorMtimeMs,
      launcherStartedAtMs: finite(row?.startedAtMs) ? row.startedAtMs : launcher.startedAtMs,
    })
    const proven = own.proven && unattended.unattended
    // A proof is remembered for this launcher. A refusal is read again unattendedRecheckMs on: a person's own hoai
    // stays refused without a listing every 5 min, and one on a row missing from a listing or a file that could not
    // be read is not held for the daemon's life.
    unattendedCache = { key: `${kind}:${launcher.pid}`, value: proven, until: proven ? Number.POSITIVE_INFINITY : now() + d.unattendedRecheckMs }
    if (kind === 'launcher') return { kind, unattended: proven, proof: null }
    return proven ? { kind: 'launcher', unattended: true, proof: { markerPath: launcher.markerPath, launcherPid: launcher.pid } } : { kind, unattended: false, proof: null }
  }

  const readTable = async () => {
    let listing = null
    try {
      listing = await deps.listProcesses()
    } catch (err) {
      listing = { ok: false, error: oneLine(err) }
    }
    const processes = listing?.ok && Array.isArray(listing.processes) ? listing.processes : null
    let claude = read(deps.claudePid, null)
    if (claude === null && processes) claude = nearestClaudeAncestor(processes, deps.ownPid)
    return { processes, claude }
  }

  /**
   * The session claude runs now: the id on its command line first (hoai
   * starts it with --resume <pin>, or --session-id <id> for a fresh one, and
   * repins only after the fresh one survived 25 s), else the pin file.
   */
  const currentSession = async (table) => {
    const row = table.processes && table.claude !== null ? table.processes.find((p) => p.pid === table.claude) : null
    const onLine = sessionIdFromCommand(row?.command)
    if (onLine) return onLine
    try {
      return (await deps.sessionId()) ?? null
    } catch {
      return null
    }
  }

  /**
   * What a restart through an owning service would end beyond the agent: a
   * systemd unit ends its whole cgroup. Read only for that authority; a
   * reading that fails or throws is unreadable.
   */
  const readServiceStrays = async (authority, processes, claude) => {
    if (authority.kind !== 'service' || authority.unattended !== true || authority.proof) return { ok: true, strays: [] }
    try {
      const got = await deps.serviceStrays(processes, claude)
      return got?.ok === true && Array.isArray(got.strays) ? got : { ok: false, strays: [] }
    } catch {
      return { ok: false, strays: [] }
    }
  }

  /** The reads that cost something, done only when everything cheap says restart. */
  const lookClosely = async () => {
    const table = await readTable()
    const { processes, claude } = table
    const descendants = processes && claude !== null ? descendantsOf(processes, claude).map((p) => p.command) : null
    const authority = resolveAuthority(processes, claude)
    const serviceStrays = await readServiceStrays(authority, processes, claude)
    let wake = null
    try {
      wake = await deps.wakeSchedule()
    } catch {
      wake = null
    }
    // A person is read after the schedule call: one who attached while it was out still holds the restart.
    let attached = null
    try {
      attached = await deps.personAttached()
    } catch {
      attached = null
    }
    const session = await currentSession(table)
    return {
      processes,
      claudeKnown: processes !== null && claude !== null,
      descendants,
      serviceStrays,
      authority,
      personAttached: attached,
      wake: wake?.ok && Array.isArray(wake.tasks) ? { known: true, nextDueAtMs: nextWakeDueMs(wake.tasks, now(), d) } : { known: false, nextDueAtMs: null },
      session,
    }
  }

  // -- the phases --------------------------------------------------------------------------------

  const settle = async () => {
    if (!read(deps.active, false)) return 'passive'
    const found = parseIdleUpdateRecord(read(() => fs.readFile(deps.paths.record), null))
    // Only a record this boot has to settle is worth a process listing.
    const session = found && ['requested', 'did_not_arrive', 'arrived'].includes(found.state) ? await currentSession(await readTable()) : null
    const { record: next, event } = settleRecordAtBoot(found, { runningVersion: deps.runningVersion, pin: session, now: now() })
    record = next
    if (next !== found) writeRecord(next)
    phase = 'watch'
    if (!record) return null
    const where = `${record.target} (from ${record.from})`
    switch (event) {
      case 'arrived':
        log(`back on ${where}, resumed pinned session ${record.pin}; validating the new build on live delivery`)
        phase = 'validate'
        break
      case 'context_lost':
        log(`back on ${where}, but on a NEW session ${record.pin}: the conversation ${record.pinBefore} could not be resumed; validating the new build`)
        phase = 'validate'
        break
      case 'arrived_again':
        log(`${record.target} booted again after it proved live, or while its last boot was alive (boot ${record.lockBoots}); validating it on this boot`)
        phase = 'validate'
        break
      case 'second_boot':
        log(`${record.target} booted again before it validated (boot ${record.lockBoots}): the new build is failing`)
        return failBuild('second_boot')
      case 'came_back_old':
        voidCanary(record, 'came_back_old')
        releaseLease(record.nonce, record.target)
        log(`the restart onto ${record.target} came back on ${deps.runningVersion}; recorded as a failed attempt`)
        break
      case 'rolled_back':
        releaseLease(record.nonce, record.target)
        log(`back on ${deps.runningVersion} after rolling ${record.target} back; ${record.target} is held on this computer`)
        break
      case 'rollback_failed':
        releaseLease(record.nonce, record.target)
        log(`${record.target} booted again after it was rolled back; nothing more is tried. A restart by hand loads what is installed`)
        break
      default:
        break
    }
    return null
  }

  /**
   * A restart that did not arrive takes back the marker it left. hoai polls every 3 s, so one still there was never
   * read, and hoai's next poll, whenever that is, kills claude with no turn check. Only the file this ask left: a
   * person's restart writes the same one. Says whether one was left: the launcher stopped taking them.
   */
  const takeBackMarker = () => {
    const ours = finite(askedMarkerMs) && read(deps.markerMtimeMs, null) === askedMarkerMs
    if (ours) read(deps.removeMarker, false)
    askedMarkerMs = null
    return ours
  }

  const failAsk = (outcome, why, fields = {}) => {
    const rec = settleTo(withAttempt(record, now(), outcome, { state: outcome, ...fields }))
    voidCanary(rec, outcome)
    releaseLease(rec.nonce, rec.target)
    phase = 'watch'
    const facts = attemptFactsFor(rec, rec.target)
    log(`${why}; recorded as a failed attempt, the next one not before ${iso((facts.lastAtMs ?? now()) + attemptBackoffMs(facts.failed, d))}`)
    publish(null)
    return outcome === 'no_authority' ? 'staged' : outcome
  }

  const act = async (target, close, reason) => {
    const nonce = String(read(deps.nonce, '') || `${deps.ownPid}-${now()}`)
    const me = { assistantId: deps.assistantId, nonce }
    if (!takeLease(target, me)) {
      waiting({ action: 'wait', reason: 'machine_busy' })
      return 'machine_busy'
    }
    const canary = decideCanary({ files: versionFiles(target), now: now(), me }, d)
    let canaryN = null
    if (canary.state === 'none' || canary.state === 'next') {
      if (create(join(dir, target, `canary-${canary.next}`), { assistantId: deps.assistantId, at: iso(now()) }) !== 'ok') {
        releaseLease(nonce, target)
        return 'canary_unconfirmed'
      }
      canaryN = canary.next
    } else if (canary.state === 'mine') {
      canaryN = canary.n
    } else if (canary.state !== 'validated') {
      releaseLease(nonce, target)
      return 'canary_unconfirmed'
    }
    const n = now()
    const previous = record && record.target === target && Array.isArray(record.attempts) ? record.attempts : []
    const next = {
      schema: IDLE_UPDATE_SCHEMA_VERSION,
      target,
      from: deps.runningVersion,
      fromRoot: deps.fromRoot ?? null,
      fromCommit: deps.fromCommit ?? null,
      installMethod: deps.installMethod,
      pin: close.session,
      pinBefore: null,
      nonce,
      canaryN,
      state: 'requested',
      attempts: [...previous, { at: iso(n), outcome: 'requested' }],
      lockBoots: 0,
      arrivedAt: null,
      validatedAt: null,
      contextLost: false,
      reportedAt: null,
    }
    if (!writeRecord(next)) {
      voidCanary({ target, canaryN }, 'record_failed')
      releaseLease(nonce, target)
      listAfterMs = n + d.listBackoffMs
      log('no record, no restart: one attempt per version cannot be guaranteed without it')
      return 'record_failed'
    }
    record = next
    const quietMin = Math.round((n - Math.max(deps.bootAtMs, ...(read(deps.activityMs, [n]) ?? []).filter(finite))) / 60_000)
    log(
      `restarting onto ${target} from ${deps.runningVersion}: idle (${reason}), quiet ${quietMin} min, jitter ${Math.round(jitterMs / 1000)}s` +
        `${canaryN ? `, canary ${canaryN} for this computer` : ''}, through ${close.authority.proof ? `the own hoai launcher (pid ${close.authority.proof.launcherPid})` : `the ${close.authority.kind} authority`}; ` +
        `the session resumes ${close.session ?? 'its pinned session'}`,
    )
    phase = 'asking'
    let took = false
    try {
      deps.drain(true)
      took = await deps.restart(target, close.authority.proof)
    } catch (err) {
      try {
        deps.drain(false)
      } catch {
        // Nothing more to lift.
      }
      return failAsk('no_authority', `the restart request failed (${oneLine(err)})`)
    }
    if (!took) return failAsk('no_authority', 'the restart ladder could only stage')
    phase = 'requested'
    requestedAtMs = now()
    askedMarkerMs = read(deps.markerMtimeMs, null)
    return 'requested'
  }

  const watch = async () => {
    const staged = read(deps.stagedVersion, null)
    if (staged !== watchedTarget) {
      watchedTarget = staged
      said.clear()
      unattendedCache = null
    }
    const placeholders = { personAttached: false, claudeKnown: true, descendants: [], serviceStrays: { ok: true, strays: [] }, wake: { known: true, nextDueAtMs: null } }
    const first = decideIdleUpdate({ ...baseFacts(staged), authority: cheapAuthority(), ...placeholders }, d)
    if (first.action !== 'restart') {
      waiting(first)
      publish(first.reason)
      return first.reason
    }
    if (now() < listAfterMs) {
      publish(null)
      return 'busy'
    }
    const close = await lookClosely()
    if (phase !== 'watch') return phase
    // Again, after the awaits, on the real facts: the moment has to still be safe.
    const second = decideIdleUpdate(
      {
        ...baseFacts(staged),
        authority: { kind: close.authority.kind, unattended: close.authority.unattended },
        personAttached: close.personAttached,
        claudeKnown: close.claudeKnown,
        descendants: close.descendants,
        serviceStrays: close.serviceStrays,
        wake: close.wake,
      },
      d,
    )
    if (second.action !== 'restart') {
      listAfterMs = now() + d.listBackoffMs
      waiting(second)
      publish(second.reason)
      return second.reason
    }
    return act(staged, close, second.reason)
  }

  const validate = () => {
    const n = now()
    const mono = read(deps.monotonicNow, null)
    const unreachable = read(deps.backendUnreachable, false) === true
    const loginExpired = read(deps.loginExpired, false) === true
    // The deadline counts only time this computer could prove anything: not a sleep (the wall clock moved, the
    // monotonic one did not), not the minutes under an expired login, and the minutes the backend could not be
    // reached only past their cap.
    if (lastValidateAt) {
      const wallGap = n - lastValidateAt.wall
      const monoGap = finite(mono) && finite(lastValidateAt.mono) ? mono - lastValidateAt.mono : wallGap
      if (wallGap > monoGap) suspendedMs += wallGap - monoGap
      const awake = Math.max(0, Math.min(wallGap, monoGap))
      if (loginExpired) suspendedMs += awake
      else if (unreachable) unreachableMs += awake
    }
    lastValidateAt = { wall: n, mono }
    const startupComplete = read(deps.startupComplete, false)
    // This boot's startup complete: the deadline counts from it, so only what was held since it counts.
    if (startupComplete === true && startupCompleteAtMs === null) {
      startupCompleteAtMs = n
      suspendedMs = 0
      unreachableMs = 0
    }
    const arrivedAtMs = Date.parse(record?.arrivedAt)
    const heartbeatOkAtMs = read(deps.heartbeatOkAtMs, null)
    const input = {
      arrivedAtMs,
      now: n,
      startupComplete,
      startupCompleteAtMs,
      heartbeatOkAtMs,
      beaconAtMs: read(deps.beaconAtMs, null),
      deaf: read(deps.deaf, false),
      loginExpired,
      backendUnreachable: unreachable,
      suspendedMs,
      unreachableMs,
      liveSinceMs: null,
    }
    const live = isLiveBuild(input, d)
    liveSinceMs = live ? (liveSinceMs ?? n) : null
    input.liveSinceMs = liveSinceMs
    // The boot beat can land before this record settled, and the hold needs a beat that landed during it; until
    // one has, one is asked for (the heartbeat's own sendNow, once per tick at most).
    const beatSince = Math.max(arrivedAtMs, liveSinceMs ?? arrivedAtMs)
    if (!(finite(heartbeatOkAtMs) && heartbeatOkAtMs >= beatSince)) read(deps.requestHeartbeat, null)
    const verdict = decideValidation(input, d)
    if (verdict === 'pending') {
      // Live before the hold ran out: on the record, so one more boot (a person's restart) is not a failing build.
      if (!record.liveAt && live) settleTo({ ...record, liveAt: iso(n) })
      publish(null)
      return 'validating'
    }
    if (verdict === 'deadline') {
      // No live proof left on the record: a crash before the repoint reads as a failed boot, so the next one finishes it.
      settleTo(withAttempt(record, now(), 'deadline', { liveAt: null }))
      log(
        startupCompleteAtMs === null
          ? `${record.target} did not complete its startup within ${Math.round(d.startupDeadlineMs / 1000)}s of booting`
          : `${record.target} did not prove live delivery within ${Math.round(d.validateDeadlineMs / 1000)}s of its startup completing`,
      )
      return failBuild('deadline')
    }
    const rec = settleTo({ ...record, state: 'validated', validatedAt: iso(now()) })
    if (Number.isInteger(rec.canaryN)) markVersion(rec.target, 'validated', { canary: rec.canaryN, from: rec.from, fromRoot: rec.fromRoot })
    read(() => fs.remove(wentBackPath), false)
    releaseLease(rec.nonce, rec.target)
    const arrived = Date.parse(rec.arrivedAt)
    log(
      `restarted onto ${rec.target} from ${rec.from}, ` +
        `${rec.contextLost ? `on a NEW session ${rec.pin} (the conversation ${rec.pinBefore} could not be resumed)` : `resumed pinned session ${rec.pin}`}; ` +
        `validated ${Number.isFinite(arrived) ? Math.round((now() - arrived) / 1000) : '?'}s after boot` +
        `${Number.isInteger(rec.canaryN) ? `; canary ${rec.canaryN}: the other agents on this computer may follow` : ''}`,
    )
    phase = 'watch'
    publish(null)
    return 'validated'
  }

  const failBuild = async (why) => {
    // Still the canary only while its attempt has a verdict to give: a voided attempt, or a version another agent
    // validated meanwhile, is this agent's failure, not the version's. A way back it took for this same target is
    // one a crash cut short, so the boot after it may finish: gate 7 never lets this agent onto that target again.
    const files = record ? versionFiles(record.target) : null
    const canary = Number.isInteger(record?.canaryN) && !files.voids.includes(record.canaryN) && !files.validated
    const spent = parseJsonOrNull(read(() => fs.readFile(wentBackPath), null))
    const wentBack = spent !== null && spent.target !== record?.target
    const verdict = decideRollback({ canary, wentBack, loginExpired: read(deps.loginExpired, false) })
    if (verdict === 'none') {
      phase = 'validate'
      publish(null)
      return 'validating'
    }
    if (verdict === 'report_only') {
      const rec = settleTo({ ...record, state: 'failed' })
      releaseLease(rec.nonce, rec.target)
      log(`${rec.target} failed on this agent (${why}); it has used its one way back and has not validated a build since, so the shared install stays`)
      phase = 'watch'
      publish(null)
      return 'failed'
    }
    if (!canary) {
      create(wentBackPath, { assistantId: deps.assistantId, at: iso(now()), target: record.target, reason: why })
      const canaryLeft = parseJsonOrNull(read(() => fs.readFile(join(dir, record.target, 'validated')), null))
      const heldBad = (version) => isVersionHeldBad(version, { machineDir: dir, fs })
      const holds = ({ from, fromRoot }) => parseJsonOrNull(read(() => fs.readFile(join(fromRoot, '.claude-plugin', 'plugin.json')), null))?.version === from
      settleTo({ ...record, ...rollbackSourceFor(record, canaryLeft, { heldBad, holds }) })
    }
    phase = 'rollback'
    rollbackStage = 'install'
    return rollback(why)
  }

  const rollback = async (why = 'failed') => {
    if (rollbackStage === 'install') {
      // This build failed here: no other agent restarts onto it, whatever the install does next.
      markVersion(record.target, 'bad', { reason: why })
      let result = null
      try {
        result = await deps.rollbackInstall(record)
      } catch (err) {
        result = { ok: false, reason: oneLine(err) }
      }
      if (!result?.ok) {
        const rec = settleTo(withAttempt(record, now(), 'rollback_failed', { state: 'rollback_failed' }))
        releaseLease(rec.nonce, rec.target)
        log(`could not roll the install back to ${rec.from} (${result?.reason ?? 'unknown'}); ${rec.target} is held on this computer. A restart by hand loads what is installed`)
        phase = 'watch'
        publish(null)
        return 'rollback_failed'
      }
      settleTo(withAttempt(record, now(), 'rolled_back', { state: 'rolled_back' }))
      log(`rolled the install back to ${record.from}; ${record.target} is held on this computer; restarting onto ${record.from} at the next quiet moment`)
      rollbackStage = 'restart'
      rollbackWaitSinceMs = now()
      publish(null)
      return 'rollback'
    }
    if (rollbackStage === 'restart') {
      const close = await lookClosely()
      const n = now()
      const moment = decideRollbackMoment(
        {
          now: n,
          bootAtMs: deps.bootAtMs,
          active: read(deps.active, false),
          draining: read(deps.draining, false),
          authority: { kind: close.authority.kind, unattended: close.authority.unattended },
          safe: read(deps.safeState, null) ?? { turnInFlight: true },
          activityMs: read(deps.activityMs, [n]),
          openAsks: read(deps.openAsks, 1),
          goalRunning: read(deps.goalRunning, true),
          call: read(deps.call, null) ?? { pendingConsults: 1 },
          lastBrowserToolAtMs: read(deps.lastBrowserToolAtMs, null),
          personAttached: close.personAttached,
          claudeKnown: close.claudeKnown,
          descendants: close.descendants,
          serviceStrays: close.serviceStrays,
          wake: close.wake,
        },
        d,
      )
      if (RESTART_KINDS.has(close.authority.kind) && close.authority.unattended === true) unprovenSinceMs = null
      const strayed = close.serviceStrays?.ok === true && close.serviceStrays.strays.length > 0
      straysSinceMs = strayed ? (straysSinceMs ?? n) : null
      if (!moment.go) {
        // Never a session a person may be typing in: the old build is installed again, a person restarts it. One
        // reading that did not prove the launch (a listing that failed, a launch-status mid-rewrite) is not that:
        // it waits rollbackProofGraceMs for a proven one first.
        if (moment.reason === 'no_unattended_authority') {
          if (unprovenSinceMs === null) unprovenSinceMs = n
          if (!RESTART_KINDS.has(close.authority.kind) || n - unprovenSinceMs >= d.rollbackProofGraceMs) {
            return rollbackStuck(`${record.from} is installed again, but this agent's launch is not proven unattended, so it is not restarted automatically`)
          }
        }
        // A job in the unit's group that never ends (a daemonised agent a tool left there) would hold it for good.
        if (moment.reason === 'background_job' && strayed && n - straysSinceMs >= d.rollbackProofGraceMs) {
          return rollbackStuck(`${record.from} is installed again, but a job in this agent's service group has not ended, and restarting the service would end it`)
        }
        // Every other reason would wait without limit, while the app says this agent went back.
        if (n - rollbackWaitSinceMs >= d.rollbackWaitMaxMs) {
          return rollbackStuck(`${record.from} is installed again, but no quiet moment came to restart onto it (${moment.reason})`)
        }
        waiting({ action: 'wait', reason: `rollback_${moment.reason}` })
        return 'rollback_waiting'
      }
      let took = false
      try {
        deps.drain(true)
        took = await deps.restartRollback(record.from, close.authority.proof)
      } catch (err) {
        try {
          deps.drain(false)
        } catch {
          // Nothing more to lift.
        }
        log(`the rollback restart failed (${oneLine(err)})`)
        took = false
      }
      if (took) {
        rollbackStage = 'requested'
        requestedAtMs = now()
        askedMarkerMs = read(deps.markerMtimeMs, null)
        return 'rollback_requested'
      }
      return rollbackStuck(`${record.from} is installed again but no restart authority took the restart onto it`)
    }
    if (rollbackStage === 'requested') {
      if (now() - requestedAtMs < d.didNotArriveMs) return 'rollback_requested'
      takeBackMarker()
      return rollbackStuck(`the restart onto ${record.from} did not arrive`)
    }
    return 'rollback_staged'
  }

  const rollbackStuck = (why) => {
    transientError = {
      code: 'idle_update_rollback_failed',
      message: `Plugin ${record.target} did not come up healthy; ${why}. Restart this agent by hand.`.slice(0, 300),
      at: iso(now()),
    }
    rollbackStage = 'staged'
    log(`${why}; restart this agent by hand`)
    publish(null)
    return 'rollback_staged'
  }

  const tick = async () => {
    if (phase === 'done') return 'done'
    if (busy) return 'busy'
    busy = true
    try {
      if (phase === 'settle') {
        const settled = await settle()
        if (settled) return settled
      }
      switch (phase) {
        case 'watch':
          return await watch()
        case 'requested':
          if (now() - requestedAtMs < d.didNotArriveMs) return 'requested'
          {
            const markerStranded = takeBackMarker()
            return failAsk('did_not_arrive', `the restart onto ${record.target} did not arrive within ${Math.round(d.didNotArriveMs / 1000)}s`, { markerStranded })
          }
        case 'validate':
          if (!read(deps.active, false)) {
            // Not the lock holder: it can prove nothing meanwhile, so the time is not counted, and the hold restarts.
            const n = now()
            if (lastValidateAt) suspendedMs += Math.max(0, n - lastValidateAt.wall)
            lastValidateAt = { wall: n, mono: read(deps.monotonicNow, null) }
            liveSinceMs = null
            return 'passive'
          }
          {
            // Another session of this agent held the lock meanwhile and settled the record on its own boot. Writing
            // this daemon's copy would go over the newer record. The same attempt with no verdict yet is still this
            // boot's to give (the other boot no longer holds the lock): it carries on with that record, so every later
            // write extends it. Another attempt, or one with its verdict (a failed boot or a missed deadline the other
            // boot gave, its rollback the next boot's to finish), is not this daemon's to act on. This daemon's own
            // failed boot, given under an expired login with no rollback, is no rollback under way.
            const newer = supersededOnDisk()
            const theirs = newer?.attempts.slice(record.attempts.length) ?? []
            if (newer && newer.nonce === record.nonce && newer.state === 'arrived' && !theirs.some((a) => ROLLBACK_OUTCOMES.has(a?.outcome))) {
              log(`${record.target}: another boot settled this attempt while this one did not hold the lock; validating it on that record`)
              // The deadline counts from that boot's arrival, and none of the time since was this daemon's to prove
              // anything in. Its clean end and live proof were that boot's, never this one's.
              suspendedMs = Math.max(0, now() - Date.parse(newer.arrivedAt))
              unreachableMs = 0
              liveSinceMs = null
              record = newer.liveAt || newer.endedAt ? settleTo({ ...newer, liveAt: null, endedAt: null }) : newer
            } else if (newer) {
              log(`${record.target}: the record on disk moved on (another attempt, or a verdict) while this daemon did not hold the lock, so it stands down from validating`)
              record = newer
              phase = 'watch'
              publish(null)
              return 'superseded'
            }
          }
          return await validate()
        case 'rollback':
          if (!read(deps.active, false)) return 'passive'
          return await rollback()
        default:
          return phase
      }
    } catch (err) {
      log(`a check failed and is retried at the next poll: ${oneLine(err)}`)
      return 'error'
    } finally {
      busy = false
      syncCleanEndSignals()
    }
  }

  return {
    tick,
    jitterMs,
    phase: () => phase,
    /**
     * This daemon is ending. When `clean` (isCleanEnd: its claude went away, stdin closed or a signal: a person's
     * restart, hoai relaunching a slow startup) and validating, that goes on the record, so the next boot of the
     * target knows this one was running, not crashed. Sync, and never on a fault: a crash leaves no clean end. Only
     * the pairing lock holder writes the record (`holdsLock`, asked without the shutdown that `active` folds in).
     */
    noteEnded: (clean) => {
      if (clean !== true || phase !== 'validate' || record?.state !== 'arrived') return
      if (read(deps.holdsLock, false) !== true) return
      read(() => {
        if (!supersededOnDisk()) settleTo({ ...record, endedAt: iso(now()) })
      }, null)
    },
    stop: () => {
      phase = 'done'
      syncCleanEndSignals()
      if (interval !== null) deps.clearInterval(interval)
      interval = null
    },
    start: () => {
      if (interval !== null || phase === 'done') return
      log(
        `armed on ${deps.runningVersion}: when a newer build is staged and this agent has been idle and quiet, it restarts onto it ` +
          `through its restart authority (jitter ${Math.round(jitterMs / 1000)}s, poll ${Math.round(d.pollMs / 1000)}s` +
          `${d.scale !== 1 ? `, every duration divided by BGOS_IDLE_UPDATE_SCALE=${d.scale}` : ''}; record ${deps.paths.record})`,
      )
      interval = deps.setInterval(() => {
        void tick()
      }, d.pollMs)
      interval?.unref?.()
      void tick()
    },
  }
}

/**
 * The controller's files on the real disk: exclusive create for every shared
 * fact, temp file and rename for the record. Never throws.
 */
export function nodeIdleUpdateFs() {
  return {
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
    mtimeMs: (p) => {
      try {
        return statSync(p).mtimeMs
      } catch {
        return null
      }
    },
    createExclusive: (p, text) => {
      try {
        mkdirSync(dirname(p), { recursive: true })
        const fd = openSync(p, 'wx')
        try {
          writeSync(fd, text)
        } finally {
          closeSync(fd)
        }
        return 'ok'
      } catch (err) {
        return err?.code === 'EEXIST' ? 'exists' : 'error'
      }
    },
    writeAtomic: (p, text) => {
      const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      try {
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(tmp, text)
        renameSync(tmp, p)
        return true
      } catch {
        try {
          unlinkSync(tmp)
        } catch {
          // Nothing was written.
        }
        return false
      }
    },
    rename: (from, to) => {
      try {
        renameSync(from, to)
        return true
      } catch {
        return false
      }
    },
    remove: (p) => {
      try {
        unlinkSync(p)
        return true
      } catch {
        return false
      }
    },
    listDir: (p) => {
      try {
        return readdirSync(p)
      } catch {
        return null
      }
    },
  }
}
