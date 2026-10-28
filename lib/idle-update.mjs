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
 * canary), and the version is held on this computer so no other agent
 * follows. Agents on one computer never restart together: each draws a
 * jitter, one restart lease is held at a time, and a 2 minute spacing follows
 * every restart. Never an interactive session a person may be typing in:
 * only a launch proven unattended qualifies. BGOS_AUTO_UPDATE off means never.
 *
 * This file holds the pure rules, each tested on its own in
 * test/idle-update.test.ts. Plain JavaScript, node >= 18 builtins only,
 * import-safe.
 */

import { TURN_SIGNAL_HOOKS, QUIET_WINDOW_MS, LEGACY_QUIET_WINDOW_MS, decideSafeMoment, isBackgroundJobCommand } from './keepalive-plan.mjs'
import { isOwnServiceProcess } from './agent-restart.mjs'
import { isClaudeCommand, nearestClaudeAncestor } from './process-tree.mjs'

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
  leaseTtlMs: 10 * MIN,
  spacingMs: 2 * MIN,
  canaryHoldMs: 24 * HOUR,
  backoffBaseMs: 24 * HOUR,
  backoffMaxMs: 7 * DAY,
  /** lib/keepalive-plan.mjs MARKER_PENDING_MS: a marker hoai has not taken by then never will be. */
  markerStrandedMs: 5 * MIN,
  callRecentMs: 30 * MIN,
  browserRecentMs: 30 * MIN,
  wakeGuardMs: 10 * MIN,
  watcherFreshMs: 5 * MIN,
  validateHoldMs: 60 * SEC,
  validateDeadlineMs: 5 * MIN,
  beaconFreshMs: 2 * MIN,
  rollbackQuietMs: 2 * MIN,
  didNotArriveMs: 3.5 * MIN,
  wakeRefreshMs: 5 * MIN,
  scale: 1,
})

/** Attempt outcomes that are a failed attempt for the back-off. */
const FAILED_OUTCOMES = new Set(['no_authority', 'did_not_arrive', 'came_back_old', 'context_lost', 'second_boot', 'deadline', 'failed', 'rolled_back', 'rollback_failed'])
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
export function scaleFromEnv(raw) {
  const n = typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN
  if (!Number.isFinite(n) || n <= 1) return 1
  return Math.min(MAX_SCALE, n)
}

/** Every duration divided by the scale (never below 1 ms), the scale carried along. */
export function scaledDurations(scale) {
  const s = Number.isFinite(scale) && scale >= 1 ? Math.min(MAX_SCALE, scale) : 1
  const out = {}
  for (const [key, value] of Object.entries(DEFAULT_DURATIONS)) {
    out[key] = key === 'scale' ? s : Math.max(1, Math.floor(value / s))
  }
  return Object.freeze(out)
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
 *    9 young                  the first minute of a daemon
 *   10 turn_in_flight / pending_messages / pending_permission   the watcher's safe moment
 *   11 open_ask   12 goal_running   13 call_active   14 browser_in_use   15 person_attached
 *   16 recent_activity        the safe moment's quiet window (10 min with the hook signal, 30 without)
 *   17 jitter                 the quiet window plus this agent's own draw
 *   18 machine_busy / spacing another agent holds the computer's restart lease, or released it moments ago
 *   19 canary_unconfirmed     the first agent onto this version has not confirmed it yet
 *   20 process_tree_unreadable / background_job   read last: it is a process listing
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
  if (!finite(f.bootAtMs) || now - f.bootAtMs < d.minUpMs) return wait('young')

  // The watcher's own safe moment, with boot counted as activity. The tree is
  // judged at gate 20 (it is a process listing, read last), so here it is
  // given as clean; a stale turn behind a background job still waits there.
  const stamps = [...(Array.isArray(f.activityMs) ? f.activityMs : []), f.bootAtMs].filter(finite)
  const dilated = stamps.map((s) => now - (now - s) * d.scale)
  const safe = decideSafeMoment({ running: true, stateFresh: true, state: f.safe, descendants: [], activityMs: dilated, now })
  if (!safe.safe && safe.reason !== 'recent_activity') return wait(safe.reason)

  if (f.openAsks > 0) return wait('open_ask')
  if (f.goalRunning) return wait('goal_running')
  const call = f.call ?? {}
  if (call.pendingConsults > 0 || call.openContinuations > 0 || call.openMeetings > 0 || within(now, call.lastVoiceAtMs, d.callRecentMs)) {
    return wait('call_active')
  }
  if (within(now, f.lastBrowserToolAtMs, d.browserRecentMs)) return wait('browser_in_use')
  if (f.personAttached !== false) return wait('person_attached')
  if (!safe.safe) return wait(safe.reason)

  const window = (f.safe?.turnSignal === TURN_SIGNAL_HOOKS ? QUIET_WINDOW_MS : LEGACY_QUIET_WINDOW_MS) / d.scale
  const newest = stamps.length > 0 ? Math.max(...stamps) : now
  if (now - newest < window + (finite(f.jitterMs) ? Math.max(0, f.jitterMs) : d.jitterMaxMs)) return wait('jitter')

  const machine = f.machine ?? {}
  if (!['free', 'mine', 'expired'].includes(machine.lease)) return wait('machine_busy')
  if (finite(machine.spacingUntilMs) && now < machine.spacingUntilMs) return wait('spacing')
  if (machine.canary === 'latch_bad' || machine.canary === 'bad') return wait('version_held_bad')
  if (!['none', 'validated', 'next', 'mine'].includes(machine.canary)) return wait('canary_unconfirmed')

  if (f.claudeKnown !== true || !Array.isArray(f.descendants)) return wait('process_tree_unreadable')
  if (f.descendants.some(isBackgroundJobCommand)) return wait('background_job')

  const wake = f.wake ?? {}
  if (wake.known !== true) return wait('wake_schedule_unknown')
  if (finite(wake.nextDueAtMs) && Math.abs(wake.nextDueAtMs - now) < d.wakeGuardMs) return wait('wake_due')

  return { action: 'restart', reason: safe.reason }
}

/**
 * The soonest wake or call that matters to a restart now: due within the
 * guard behind or anywhere ahead. One overdue by more than the guard is not
 * landing in the next minutes, and must not hide the next real one.
 * @param {Array<{ nextRunAt?: string | null }> | null} tasks
 * @param {number} now
 * @returns {number | null}
 */
export function nextWakeDueMs(tasks, now, d = DEFAULT_DURATIONS) {
  let soonest = null
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const at = typeof task?.nextRunAt === 'string' ? Date.parse(task.nextRunAt) : Number.NaN
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
  const canaries = (Array.isArray(files.canaries) ? files.canaries : []).filter((c) => Number.isInteger(c?.n) && c.n > 0)
  if (canaries.length === 0) return { state: 'none', next: 1 }
  const voids = new Set(Array.isArray(files.voids) ? files.voids : [])
  const next = Math.max(...canaries.map((c) => c.n)) + 1
  const live = canaries.filter((c) => !voids.has(c.n)).sort((a, b) => a.n - b.n)
  if (live.length === 0) return { state: 'next', next }
  const latest = live[live.length - 1]
  if (latest.assistantId === me.assistantId) return { state: 'mine', n: latest.n }
  const silent = live.filter((c) => !within(now, c.at, d.leaseTtlMs))
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
    if (typeof parsed.target !== 'string' || !Array.isArray(parsed.attempts)) return null
    return parsed
  } catch {
    return null
  }
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
 *   second_boot      the target booted again before it validated: the new build is failing
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
  const lostFields = { state: 'arrived', lockBoots: 1, arrivedAt: iso, contextLost: true, pin, pinBefore: record.pinBefore ?? record.pin }
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
    return { record: withAttempt(record, now, 'second_boot', { lockBoots }), event: 'second_boot' }
  }
  if (record.state === 'rolled_back') {
    if (onTarget) return { record: withAttempt(record, now, 'rollback_failed', { state: 'rollback_failed' }), event: 'rollback_failed' }
    if (!record.reportedAt) return { record: { ...record, reportedAt: iso }, event: 'rolled_back' }
  }
  return { record, event: 'none' }
}

// -- Validation and rollback ---------------------------------------------------------------------

/**
 * Did the new build come up healthy? Every proof at once: startup complete, a
 * backend heartbeat accepted at the new version since it arrived, a channel
 * beacon this daemon touched while delivering, no deaf verdict, held for
 * validateHoldMs. No proof by validateDeadlineMs after arrival is the
 * deadline, except while the shared login has expired: then nothing on this
 * computer can prove anything, and that is not the build's fault.
 * @returns {'validated' | 'pending' | 'deadline'}
 */
export function decideValidation({ arrivedAtMs, now, startupComplete, heartbeatOkAtMs, beaconAtMs, deaf, loginExpired }, d = DEFAULT_DURATIONS) {
  if (!finite(arrivedAtMs)) return 'pending'
  const proven =
    startupComplete === true &&
    finite(heartbeatOkAtMs) &&
    heartbeatOkAtMs >= arrivedAtMs &&
    finite(beaconAtMs) &&
    now - beaconAtMs < d.beaconFreshMs &&
    deaf !== true &&
    now - arrivedAtMs >= d.validateHoldMs
  if (proven) return 'validated'
  if (loginExpired !== true && now - arrivedAtMs >= d.validateDeadlineMs) return 'deadline'
  return 'pending'
}

/**
 * Who undoes a failed build: only the canary rolls back the shared install
 * (and latches the version bad); any other agent reports. An expired login
 * does neither: the build was never the cause.
 * @returns {'rollback' | 'report_only' | 'none'}
 */
export function decideRollback({ canary, loginExpired }) {
  if (loginExpired) return 'none'
  return canary ? 'rollback' : 'report_only'
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

/**
 * Is this session's launch proven unattended, so no person can be typing in
 * it? A keepalive script and a service that owns the daemon are, by
 * construction. A hoai launcher only with proof:
 *   - Windows: its parent is wscript running the agent task's run-agent.vbs,
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
    if (!/wscript(\.exe)?"?\s/i.test(text) || !/run-agent\.vbs/i.test(text)) return { unattended: false, how: 'not_the_agent_task' }
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
  const raw = doc && typeof doc === 'object' && doc.plugins && typeof doc.plugins === 'object' ? doc.plugins[HOAI_PLUGIN_ID] : null
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []
  const entry = list.find((item) => item && typeof item === 'object' && item.scope === 'user') ?? (Array.isArray(raw) ? null : list[0])
  if (!entry) return { ok: false, reason: 'no_entry' }
  entry.version = version
  entry.installPath = installPath
  entry.lastUpdated = new Date(now).toISOString()
  return { ok: true, text: `${JSON.stringify(doc, null, 2)}\n` }
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
        `Plugin ${target} did not come up healthy, so this agent went back to ${record.from}. ${target} is held on this computer until a newer version.`,
        lastAt,
      )
    case 'rollback_failed':
      return bounded(
        'idle_update_rollback_failed',
        `Plugin ${target} did not come up healthy and going back to ${record.from} did not take; this agent runs ${running}. Restart it by hand.`,
        lastAt,
      )
    case 'failed':
      return bounded('idle_update_failed', `Plugin ${target} did not come up healthy on this agent; it runs ${running}. Another agent on this computer decides the rollback.`, lastAt)
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

/** The heartbeat's lastError for a wait that stands and needs a person, or null. */
export function idleUpdateWaitError(reason, { target, runningVersion, now }) {
  const at = new Date(now).toISOString()
  if (reason === 'version_held_bad') {
    return bounded('idle_update_held', `Plugin ${target} is held on this computer after it failed here; this agent stays on ${runningVersion}.`, at)
  }
  if (reason === 'launcher_latched') {
    return bounded('idle_update_launcher_latched', `Plugin ${target} is ready but this agent's launcher stopped taking restart requests; restart the agent once by hand.`, at)
  }
  return null
}
