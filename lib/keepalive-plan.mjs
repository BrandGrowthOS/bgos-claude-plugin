/**
 * keepalive-plan: the PURE decisions of the watcher's keep-alive sweep
 * (design sections 5 and 6, findings 7 to 9, gaps G1, G3, G5, G10).
 *
 * The sweep (lib/watcher-keepalive.mjs) reads the disk, the process table and
 * the backend, then asks THIS module what to do. Nothing here touches a file, a
 * process or the network, so every rule is a table in
 * test/keepalive-plan.test.ts and a one-line mutant of any guard turns a named
 * row red. The rules, in the order the sweep applies them per agent:
 *
 *   consent      only an id the backend cleared (always_on, this machine) is
 *                acted on, and only while the switch is on. A failed fetch
 *                falls back to a cached answer younger than 24 h, else OFF: the
 *                sweep pauses rather than act on stale consent (design 3.4, the
 *                second half of the G3 fix).
 *   supervise    `none` + a known folder => install the product supervisor
 *                (G1, G7); no folder => needs_first_launch. NEVER over a
 *                bespoke or discovered job or a verified keepalive.json: a
 *                second supervisor racing the first is G11.
 *   pending      a canonical generation 1 supervisor => upgrade_pending
 *                (findings 7 and 8: v1 starts a fresh session and has no tmux,
 *                so no remote compact); running != installed => update_pending
 *                (G5); a daemon too old to publish its state is judged by time.
 *   safe moment  the design 6 table. Unknown is UNSAFE: a guard that fails open
 *                would kill a live job (finding 9, G10). A turn flag nothing
 *                has backed for 2 h (no activity, no job) is stale, not busy.
 *   gates        1 restart per agent per 30 min, 3 attempts per target version
 *                then `failed` (visible, never a silent retry loop), 1 restart
 *                per sweep (a fleet converges one agent at a time), a failed
 *                install retried at most once an hour; a Windows task whose
 *                launcher is dead started at most once per 30 min and 3 times
 *                per death episode, then `failed task_start_failed`.
 *
 * Plain JavaScript, node >= 18, no imports at all, import-safe.
 */

// -- Contract constants ---------------------------------------------------------------

/** ~/.bgos-plugin-state/<id>/agent-state.json, written by the daemon (design 7). */
export const AGENT_STATE_FILE_NAME = 'agent-state.json'
export const AGENT_STATE_SCHEMA_VERSION = 1
/** Fresh = written in the last 120 s by a live pid (design 6, first row). */
export const AGENT_STATE_FRESH_MS = 120_000
/** Quiet window when the daemon publishes its state. */
export const QUIET_WINDOW_MS = 10 * 60_000
/** Quiet window for a daemon that publishes no state: it cannot say a turn is in
 *  flight, so silence has to be longer before it counts as idle. */
export const LEGACY_QUIET_WINDOW_MS = 30 * 60_000
/** <statedir>/launch-status: one line, `<stamp> outcome=<word> key=value ...`
 *  (bin/bgos-agent run.sh and bin/hoai-core.mjs launchStatusLine). */
export const LAUNCH_STATUS_FILE_NAME = 'launch-status'
/** run.sh's singleton wait rewrites launch-status every 5 s; a wait older than
 *  this is not one in progress (run.sh moved on, or died waiting). */
export const LAUNCH_STATUS_FRESH_MS = 120_000
/** A turn flag with NO activity from any source for this long, and no
 *  background job under claude, is stale: an interrupted turn (Esc, a crash
 *  mid tool) never gets its Stop hook, so the flag alone would hold the agent
 *  in waiting_idle forever. */
export const STALE_TURN_MS = 2 * 60 * 60_000
export const RESTART_MIN_INTERVAL_MS = 30 * 60_000
export const MAX_ATTEMPTS_PER_TARGET = 3
export const MAX_RESTARTS_PER_SWEEP = 1
/** Not in the design text: installs are not restarts, but each one runs
 *  `bun install`, so a fleet of seven installed in one sweep would block the
 *  watcher's job polling for minutes. One per sweep, same convergence idea. */
export const MAX_INSTALLS_PER_SWEEP = 1
export const INSTALL_RETRY_MS = 60 * 60_000
/** A Windows agent task whose launcher is dead gets the restart limits (a
 *  `schtasks /Run` IS the restart there): one start per agent per 30 min ... */
export const TASK_START_MIN_INTERVAL_MS = RESTART_MIN_INTERVAL_MS
/** ... and 3 per launcher death episode, then `failed task_start_failed`. */
export const MAX_TASK_STARTS_PER_EPISODE = MAX_ATTEMPTS_PER_TARGET
/** A launcher that has stayed alive this long ends its death episode. */
export const LAUNCHER_STABLE_MS = 10 * 60_000
/** After this long in waiting_idle the heartbeat carries waitingSince and the app
 *  offers Restart now (design 6, "or ask", decision D6). */
export const WAITING_ASK_AFTER_MS = 24 * 60 * 60_000
/** ~/.bgos-agent/watcher/keepalive.json older than this is not consent (design 3.4). */
export const KEEPALIVE_CACHE_MAX_AGE_MS = 24 * 60 * 60_000
export const KEEPALIVE_CACHE_SCHEMA_VERSION = 1
/** <statedir>/supervisor-generation of a v2 supervisor; absent means 1. */
export const SUPERVISOR_GENERATION_CURRENT = 2
export const UPGRADE_TARGET = 'supervisor-generation-2'
/** The backend bounds every heartbeat string (design 8). */
export const REPORT_STRING_MAX = 120

export const AGENT_STATES = Object.freeze([
  'supervised',
  'installing',
  'needs_first_launch',
  'upgrade_pending',
  'update_pending',
  'waiting_idle',
  'restarted',
  'failed',
])

export const UNSAFE_REASONS = Object.freeze([
  'turn_in_flight',
  'pending_messages',
  'pending_permission',
  'background_job',
  'recent_activity',
  'process_tree_unreadable',
])

// -- Small helpers ---------------------------------------------------------------------

const VERSION_RE = /^\d+\.\d+\.\d+[-\w.]*$/
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A pid worth signalling or probing: an integer above 1 (pid 1 is init). */
function pidOf(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 1 ? value : null
}

function countOf(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function digitsId(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return value.trim()
  return null
}

function msOf(value) {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function clip(value, max = REPORT_STRING_MAX) {
  const text = String(value ?? '')
  return text.length > max ? text.slice(0, max) : text
}

// -- agent-state.json (design 7) ------------------------------------------------------------

/**
 * @typedef {{
 *   assistantId: string, pid: number, claudePid: number | null,
 *   runningVersion: string | null, pendingRestartVersion: string | null,
 *   turnInFlight: boolean, pendingMessages: number, pendingPermissions: number,
 *   activeOperations: number, lastActivityAtMs: number | null, sessionId: string | null,
 *   updatedAtMs: number,
 * }} AgentState
 */

/**
 * Parse the daemon's published state, FAIL CLOSED: any malformed load-bearing
 * field makes the whole file null, which the sweep reads as "this daemon
 * publishes no state" and judges by the stricter legacy rules (30 min quiet,
 * the process tree). A half-trusted file is worse than none: a missing
 * turnInFlight read as false would let a restart through mid turn.
 * @param {string | null | undefined} raw
 * @param {string | number | null} [expectedId]
 * @returns {AgentState | null}
 */
export function parseAgentState(raw, expectedId = null) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed.schemaVersion !== AGENT_STATE_SCHEMA_VERSION) return null
  const assistantId = digitsId(parsed.assistantId)
  if (!assistantId) return null
  if (expectedId != null && assistantId !== String(expectedId)) return null
  const pid = pidOf(parsed.pid)
  if (pid === null) return null
  const claudePid = parsed.claudePid == null ? null : pidOf(parsed.claudePid)
  if (parsed.claudePid != null && claudePid === null) return null
  if (typeof parsed.turnInFlight !== 'boolean') return null
  const pendingMessages = countOf(parsed.pendingMessages)
  const pendingPermissions = countOf(parsed.pendingPermissions)
  const activeOperations = countOf(parsed.activeOperations)
  if (pendingMessages === null || pendingPermissions === null || activeOperations === null) return null
  const updatedAtMs = msOf(parsed.updatedAt)
  if (updatedAtMs === null) return null
  const lastActivityAtMs = parsed.lastActivityAt == null ? null : msOf(parsed.lastActivityAt)
  if (parsed.lastActivityAt != null && lastActivityAtMs === null) return null
  const version = (v) => (typeof v === 'string' && VERSION_RE.test(v.trim()) ? v.trim() : null)
  const sessionId = typeof parsed.sessionId === 'string' && UUID_RE.test(parsed.sessionId.trim()) ? parsed.sessionId.trim() : null
  return {
    assistantId,
    pid,
    claudePid,
    runningVersion: version(parsed.runningVersion),
    pendingRestartVersion: version(parsed.pendingRestartVersion),
    turnInFlight: parsed.turnInFlight,
    pendingMessages,
    pendingPermissions,
    activeOperations,
    lastActivityAtMs,
    sessionId,
    updatedAtMs,
  }
}

/**
 * Fresh = updatedAt within 120 s (either side, so a clock jump cannot make an
 * old file look new) AND the writing daemon is alive. A stale file from a dead
 * daemon would otherwise vouch for an idle agent that is in fact mid turn under
 * a NEW daemon that has not written yet.
 * @param {AgentState | null} state
 * @param {{ now: number, pidAlive: (pid: number) => boolean }} probe
 */
export function isAgentStateFresh(state, { now, pidAlive }) {
  if (!state) return false
  if (Math.abs(now - state.updatedAtMs) > AGENT_STATE_FRESH_MS) return false
  return Boolean(pidAlive(state.pid))
}

// -- The background job marker (finding 9) ---------------------------------------------------

/**
 * Claude Code runs every Bash and Monitor tool command as
 * `$SHELL -c source <config>/shell-snapshots/snapshot-...`, a child of the
 * claude process that outlives the turn when backgrounded (measured
 * 2026-10-06: every Bash tool process carries it, MCP servers never do).
 * Either slash style, case-insensitively: a Windows path may be spelled
 * either way, and over-matching only ever makes the sweep WAIT.
 * @param {string | null | undefined} command
 */
export function isBackgroundJobCommand(command) {
  if (typeof command !== 'string' || !command) return false
  return /shell-snapshots[\\/]+snapshot-/i.test(command)
}

// -- The safe moment (design 6) --------------------------------------------------------------

/**
 * @param {{
 *   running: boolean | null,           // false only when the agent is surely not running
 *   stateFresh: boolean,
 *   state: AgentState | null,
 *   descendants: string[] | null,      // the claude descendants' command lines; null = unreadable
 *   activityMs: Array<number | null | undefined>,  // lastActivityAt, events.jsonl mtime, transcript mtime
 *   now: number,
 * }} input
 * @returns {{ safe: boolean, reason: string }}
 */
export function decideSafeMoment(input) {
  // Restarting an agent that is not running is starting it.
  if (input.running === false) return { safe: true, reason: 'not_running' }
  const fresh = input.stateFresh === true && input.state ? input.state : null
  let staleTurn = false
  if (fresh) {
    if (fresh.turnInFlight) {
      // Only PROVABLY stale is stale: every activity source quiet for 2 h and
      // a readable tree with no job in it. Then the turn flag stops counting,
      // and every other check below still runs, so a stale turn hides no owed
      // reply or job and leads to the normal restart path, never a kill.
      staleTurn = isStaleTurn(input)
      if (!staleTurn) return { safe: false, reason: 'turn_in_flight' }
    }
    if (fresh.pendingMessages > 0) return { safe: false, reason: 'pending_messages' }
    if (fresh.pendingPermissions > 0) return { safe: false, reason: 'pending_permission' }
    // "a delivery is running" has no reason of its own in the design 6 table;
    // a delivery in flight is a message on its way, so it reports as one.
    if (fresh.activeOperations > 0) return { safe: false, reason: 'pending_messages' }
  }
  // Unknown running state, or a claude whose descendants could not be listed:
  // UNSAFE. Failing open here is exactly the kill finding 9 forbids.
  if (input.running !== true || !Array.isArray(input.descendants)) {
    return { safe: false, reason: 'process_tree_unreadable' }
  }
  if (input.descendants.some(isBackgroundJobCommand)) return { safe: false, reason: 'background_job' }
  const window = fresh ? QUIET_WINDOW_MS : LEGACY_QUIET_WINDOW_MS
  const stamps = activityStamps(input.activityMs)
  if (stamps.length > 0) {
    const newest = Math.max(...stamps)
    // A stamp in the future (clock skew) reads as recent: waiting is the safe error.
    if (input.now - newest < window) return { safe: false, reason: 'recent_activity' }
  }
  return { safe: true, reason: staleTurn ? 'stale_turn' : 'idle' }
}

/** The activity stamps that are real instants. */
function activityStamps(activityMs) {
  return (Array.isArray(activityMs) ? activityMs : []).filter((ms) => typeof ms === 'number' && Number.isFinite(ms))
}

/**
 * A turn flag nothing has backed for STALE_TURN_MS. Unknown is NOT stale: no
 * activity evidence at all, or a process tree that could not be read, keeps
 * the turn (failing open here would restart mid turn).
 * @param {{ descendants: string[] | null, activityMs: Array<number | null | undefined>, now: number }} input
 */
function isStaleTurn(input) {
  if (!Array.isArray(input.descendants) || input.descendants.some(isBackgroundJobCommand)) return false
  const stamps = activityStamps(input.activityMs)
  if (stamps.length === 0) return false
  return input.now - Math.max(...stamps) >= STALE_TURN_MS
}

// -- Pending restart (design 5 step 2) ---------------------------------------------------------

/**
 * @param {{
 *   canonical: boolean,               // installed by bin/bgos-agent (or the watcher's agent task)
 *   generation: number | null,        // <statedir>/supervisor-generation, absent = 1, canonical only
 *   stateFresh: boolean,
 *   runningVersion: string | null,
 *   pendingRestartVersion: string | null,
 *   installedVersion: string | null,
 *   claudeStartedAtMs: number | null,
 *   installLandedAtMs: number | null,
 * }} input
 * @returns {{ kind: 'upgrade_pending' | 'update_pending', target: string, reason: string } | null}
 */
export function decidePendingRestart(input) {
  // First: the reinstall that an upgrade is also restarts onto the installed
  // version, so one restart closes both gaps.
  if (input.canonical && typeof input.generation === 'number' && input.generation < SUPERVISOR_GENERATION_CURRENT) {
    return { kind: 'upgrade_pending', target: UPGRADE_TARGET, reason: 'supervisor_generation_1' }
  }
  if (input.stateFresh) {
    const installed = input.installedVersion || input.pendingRestartVersion || null
    if (input.runningVersion && installed && input.runningVersion !== installed) {
      return { kind: 'update_pending', target: installed, reason: 'running_differs_from_installed' }
    }
    return null
  }
  // A daemon too old to publish its state: judged by time. Its claude started
  // before the installed version landed, so it is still running the old one.
  const started = input.claudeStartedAtMs
  const landed = input.installLandedAtMs
  if (typeof started === 'number' && Number.isFinite(started) && typeof landed === 'number' && Number.isFinite(landed) && started < landed) {
    return { kind: 'update_pending', target: input.installedVersion || `landed:${landed}`, reason: 'started_before_install' }
  }
  return null
}

// -- A hand-run session behind the canonical supervisor (decision D4) ---------------------------------

/**
 * The outcome word of a launch-status file, read from its FIRST line only
 * (the file is one line by contract), or null.
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function parseLaunchStatusOutcome(raw) {
  if (typeof raw !== 'string' || !raw) return null
  const line = raw.split(/\r?\n/)[0] ?? ''
  const match = /(?:^|\s)outcome=([A-Za-z0-9_.-]+)(?=\s|$)/.exec(line)
  return match ? match[1] : null
}

/**
 * Is the agent's claude a session a PERSON started by hand, with the canonical
 * supervisor waiting behind it? run.sh's singleton wait says so itself,
 * rewriting launch-status (`outcome=waiting-for-incumbent`) every 5 s while it
 * waits (decision D4: install now, take over when the manual session ends).
 * Such a claude has no launcher of ours above it: a service restart restarts
 * only the WAITING run.sh (nothing restarts, verify fails, 3 sweeps later the
 * agent reads `failed`), and the only other lever is a kill of a session
 * someone may be typing in. So the update waits, spends no attempt, and lands
 * by itself: the supervisor takes over on the installed version the moment the
 * person's session ends. A live hoai launcher (the marker restarts claude in
 * place) or a verified keepalive (its loop relaunches claude) is NOT a plain
 * hand-run session; those restart the normal way at a safe moment.
 * @param {{ canonical: boolean, launcherLive: boolean, keepaliveVerified: boolean,
 *   statusOutcome: string | null, statusAgeMs: number | null }} input
 * @returns {boolean}
 */
export function decideManualSession(input) {
  if (input.canonical !== true || input.launcherLive === true || input.keepaliveVerified === true) return false
  if (input.statusOutcome !== 'waiting-for-incumbent') return false
  return typeof input.statusAgeMs === 'number' && Math.abs(input.statusAgeMs) <= LAUNCH_STATUS_FRESH_MS
}

// -- Supervise (design 5 step 1) ----------------------------------------------------------------

/**
 * @param {{ cleared: boolean, supervisor: 'service' | 'launcher-live' | 'none',
 *   serviceVia: string | null, keepaliveVerified: boolean, cwd: string | null }} input
 * @returns {{ action: 'install' | 'none', state: string | null, reason: string | null }}
 */
export function decideSupervise(input) {
  // The second half of the G3 fix: never a supervisor for an agent the backend
  // has not marked always-on, or its own daemon removes it again.
  if (!input.cleared) return { action: 'none', state: null, reason: 'not_cleared' }
  // A bespoke keepalive already relaunches this agent; a second supervisor
  // would race it (G11), even when its launchd job is not discoverable.
  if (input.keepaliveVerified) return { action: 'none', state: 'supervised', reason: 'keepalive' }
  if (input.supervisor === 'service') {
    return { action: 'none', state: 'supervised', reason: input.serviceVia === 'canonical-file' ? 'canonical' : 'bespoke' }
  }
  if (input.supervisor === 'launcher-live') return { action: 'none', state: 'supervised', reason: 'launcher' }
  if (input.supervisor !== 'none') return { action: 'none', state: 'supervised', reason: 'unknown_supervisor' }
  const cwd = typeof input.cwd === 'string' ? input.cwd.trim() : ''
  if (!cwd) return { action: 'none', state: 'needs_first_launch', reason: 'no_known_folder' }
  return { action: 'install', state: 'installing', reason: null }
}

/**
 * A Windows agent task runs hoai-core --keep-alive, which relaunches claude by
 * itself; the sweep starts the TASK only when that launcher is dead (design 4,
 * Windows bullet). It never starts one beside a session it may not see: on
 * Windows there is no cwd lookup, so recent activity counts as "maybe running".
 * @param {{ platform: string, canonicalTask: boolean, launcherLive: boolean,
 *   running: boolean | null, recentActivity: boolean }} input
 */
export function decideTaskStart(input) {
  return (
    input.platform === 'win32' &&
    input.canonicalTask === true &&
    input.launcherLive !== true &&
    input.running === false &&
    input.recentActivity !== true
  )
}

/**
 * The bookkeeping of one launcher DEATH EPISODE on a Windows agent task: the
 * task starts spent on it (`taskStarts`) and since when the launcher has been
 * seen alive without a break (`launcherAliveSince`). An episode ends only once
 * the launcher has STAYED alive LAUNCHER_STABLE_MS: one that comes back and
 * dies a minute later is the same failure, and resetting on every brief
 * revival would hand a crash loop a fresh 3 starts each time, which is the
 * unbounded `schtasks /Run` this exists to stop. Junk bookkeeping reads as none.
 * @param {Record<string, any> | null} prev
 * @param {{ launcherLive: boolean, now: number }} input
 * @returns {{ taskStarts: number, launcherAliveSince: string | null }}
 */
export function advanceLauncherEpisode(prev, { launcherLive, now }) {
  const base = isRecord(prev) ? prev : {}
  const taskStarts = countOf(base.taskStarts) ?? 0
  if (!launcherLive) return { taskStarts, launcherAliveSince: null }
  const aliveSinceMs = msOf(base.launcherAliveSince) ?? now
  return {
    taskStarts: now - aliveSinceMs >= LAUNCHER_STABLE_MS ? 0 : taskStarts,
    launcherAliveSince: new Date(aliveSinceMs).toISOString(),
  }
}

/**
 * May the sweep start a Windows agent task whose launcher is dead? The same
 * limits as an update restart (design 5): at most one start per agent per 30
 * min, at most 3 per death episode, then `failed task_start_failed`, visible
 * and never a silent `schtasks /Run` every minute. While a start waits out its
 * interval the task is still the supervisor (its own RestartCount keeps
 * trying), so the row stays `supervised` and says why nothing ran.
 * @param {{ now: number, lastTaskStartAtMs: number | null, taskStarts: number }} input
 * @returns {{ allowed: boolean, state: string, reason: string | null }}
 */
export function decideTaskStartGate(input) {
  if (input.taskStarts >= MAX_TASK_STARTS_PER_EPISODE) return { allowed: false, state: 'failed', reason: 'task_start_failed' }
  if (typeof input.lastTaskStartAtMs === 'number' && input.now - input.lastTaskStartAtMs < TASK_START_MIN_INTERVAL_MS) {
    return { allowed: false, state: 'supervised', reason: 'task_start_rate_limited' }
  }
  return { allowed: true, state: 'supervised', reason: null }
}

// -- Gates ---------------------------------------------------------------------------------------

/**
 * The agent's OWN restart limits: 3 attempts per target, then `failed`, and
 * one restart per 30 min. They are history, not a reading of the moment, so
 * the sweep judges them BEFORE the safe moment: a spent target is `failed`
 * whether or not the agent happens to be busy, instead of flipping between
 * waiting_idle (busy) and failed (idle) and resetting `since` at each flip,
 * which hid the failure and restarted the 24 h "or ask" clock.
 * @param {{ now: number, lastRestartAtMs: number | null, attempts: number, pendingKind: string }} input
 * @returns {{ allowed: boolean, state: string, reason: string | null }}
 */
export function decideRestartBudget(input) {
  if (input.attempts >= MAX_ATTEMPTS_PER_TARGET) return { allowed: false, state: 'failed', reason: 'attempts_exhausted' }
  if (typeof input.lastRestartAtMs === 'number' && input.now - input.lastRestartAtMs < RESTART_MIN_INTERVAL_MS) {
    return { allowed: false, state: input.pendingKind, reason: 'restart_rate_limited' }
  }
  return { allowed: true, state: input.pendingKind, reason: null }
}

/**
 * The full gate: the agent's own budget, then the fleet's one restart per
 * sweep. The sweep cap is a scheduling detail that changes every sweep, so the
 * sweep applies it only once the moment is safe: a busy agent keeps reporting
 * WHY it waits, rather than a passing one_restart_per_sweep.
 * @param {{ now: number, lastRestartAtMs: number | null, attempts: number,
 *   restartsThisSweep: number, pendingKind: string }} input
 * @returns {{ allowed: boolean, state: string, reason: string | null }}
 */
export function decideRestartGate(input) {
  const budget = decideRestartBudget(input)
  if (!budget.allowed) return budget
  if (input.restartsThisSweep >= MAX_RESTARTS_PER_SWEEP) return { allowed: false, state: input.pendingKind, reason: 'one_restart_per_sweep' }
  return budget
}

/**
 * @param {{ now: number, lastInstallAtMs: number | null, lastInstallError: string | null,
 *   installsThisSweep: number }} input
 * @returns {{ allowed: boolean, state: string, reason: string | null }}
 */
export function decideInstallGate(input) {
  if (typeof input.lastInstallAtMs === 'number' && input.now - input.lastInstallAtMs < INSTALL_RETRY_MS) {
    return input.lastInstallError
      ? { allowed: false, state: 'failed', reason: input.lastInstallError }
      : { allowed: false, state: 'installing', reason: 'install_retry_wait' }
  }
  if (input.installsThisSweep >= MAX_INSTALLS_PER_SWEEP) return { allowed: false, state: 'installing', reason: 'one_install_per_sweep' }
  return { allowed: true, state: 'installing', reason: null }
}

// -- Consent (design 3.4) -------------------------------------------------------------------------

/**
 * The backend's answer, or null for anything that is not one. Ids become
 * digit strings (the watcher's inventory vocabulary), invalid entries dropped.
 * @param {unknown} json
 * @returns {{ enabled: boolean, enabledAt: string | null, assistantIds: string[] } | null}
 */
export function parseKeepAliveResponse(json) {
  if (!isRecord(json)) return null
  if (typeof json.enabled !== 'boolean') return null
  if (!Array.isArray(json.assistantIds)) return null
  const ids = [...new Set(json.assistantIds.map(digitsId).filter((id) => id !== null))].sort((a, b) => Number(a) - Number(b))
  return {
    enabled: json.enabled,
    enabledAt: typeof json.enabledAt === 'string' && json.enabledAt ? json.enabledAt : null,
    assistantIds: ids,
  }
}

/** The cache file body (design 3.4 shape). */
export function buildKeepAliveCache(consent, now) {
  return `${JSON.stringify(
    {
      schemaVersion: KEEPALIVE_CACHE_SCHEMA_VERSION,
      enabled: Boolean(consent.enabled),
      enabledAt: consent.enabledAt ?? null,
      assistantIds: [...(consent.assistantIds ?? [])],
      fetchedAt: new Date(now).toISOString(),
    },
    null,
    2,
  )}\n`
}

/** @returns {{ enabled: boolean, enabledAt: string | null, assistantIds: string[], fetchedAtMs: number } | null} */
export function parseKeepAliveCache(raw) {
  if (typeof raw !== 'string' || !raw) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== KEEPALIVE_CACHE_SCHEMA_VERSION) return null
  const body = parseKeepAliveResponse(parsed)
  const fetchedAtMs = msOf(parsed.fetchedAt)
  if (!body || fetchedAtMs === null) return null
  return { ...body, fetchedAtMs }
}

/**
 * @param {{ live: ReturnType<typeof parseKeepAliveResponse>, cache: ReturnType<typeof parseKeepAliveCache>, now: number }} input
 * @returns {{ enabled: boolean, enabledAt: string | null, assistantIds: string[], source: 'live' | 'cache' | 'none' }}
 */
export function decideKeepAliveConsent({ live, cache, now }) {
  if (live) return { enabled: live.enabled, enabledAt: live.enabledAt, assistantIds: [...live.assistantIds], source: 'live' }
  if (cache && cache.fetchedAtMs <= now && now - cache.fetchedAtMs < KEEPALIVE_CACHE_MAX_AGE_MS) {
    return { enabled: cache.enabled, enabledAt: cache.enabledAt, assistantIds: [...cache.assistantIds], source: 'cache' }
  }
  return { enabled: false, enabledAt: null, assistantIds: [], source: 'none' }
}

// -- The installed version (design 5 step 2) --------------------------------------------------------

/**
 * The hoai plugin entry of <config>/plugins/installed_plugins.json: version,
 * path and when it landed (lastUpdated, else installedAt). The landing time is
 * the legacy rule's evidence. Prefers the `hoai@hoai` marketplace, then any
 * `hoai@<marketplace>`, and a scope:user record within an entry.
 * @param {string | null | undefined} raw
 * @returns {{ version: string | null, installPath: string | null, lastUpdatedMs: number | null } | null}
 */
export function parseInstalledPluginRecord(raw) {
  if (typeof raw !== 'string' || !raw) return null
  let doc
  try {
    doc = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(doc) || !isRecord(doc.plugins)) return null
  const keys = Object.keys(doc.plugins).filter((key) => key.startsWith('hoai@') && key.length > 'hoai@'.length)
  keys.sort((a, b) => (a === 'hoai@hoai' ? -1 : b === 'hoai@hoai' ? 1 : a < b ? -1 : a > b ? 1 : 0))
  for (const key of keys) {
    const value = doc.plugins[key]
    const records = Array.isArray(value) ? value.filter(isRecord) : isRecord(value) ? [value] : []
    const entry = records.find((r) => r.scope === 'user') ?? records[0]
    if (!entry) continue
    const version = typeof entry.version === 'string' && VERSION_RE.test(entry.version.trim()) ? entry.version.trim() : null
    const installPath = typeof entry.installPath === 'string' && entry.installPath.trim() ? entry.installPath.trim() : null
    const lastUpdatedMs = msOf(entry.lastUpdated) ?? msOf(entry.installedAt)
    return { version, installPath, lastUpdatedMs }
  }
  return null
}

// -- Bookkeeping and the heartbeat entry (design 8) -----------------------------------------------------

/**
 * Move an agent's record to its new state. `since` holds while the state holds
 * (the reason may change under it) and resets on a change; every other field
 * (attempts, lastRestartAt, lastInstallAt ...) rides along untouched.
 * @param {Record<string, any> | null} prev
 * @param {{ state: string, reason: string | null }} next
 * @param {number} now
 * @returns {Record<string, any>}
 */
export function advanceAgentRecord(prev, { state, reason }, now) {
  const base = isRecord(prev) ? prev : {}
  const since = base.state === state && typeof base.since === 'string' ? base.since : new Date(now).toISOString()
  return { ...base, state, reason: reason ?? null, since }
}

/**
 * The heartbeat's per agent entry: {id, state, reason?, since, waitingSince?},
 * every string bounded to 120 characters (the backend DTO bound).
 * @param {string} id
 * @param {{ state: string, reason?: string | null, since?: string }} record
 * @param {number} now
 * @returns {{ id: string, state: string, reason?: string, since?: string, waitingSince?: string }}
 */
export function reportEntry(id, record, now) {
  const entry = { id: clip(id), state: clip(record.state) }
  if (record.reason) entry.reason = clip(record.reason)
  if (record.since) entry.since = clip(record.since)
  const sinceMs = msOf(record.since)
  if (record.state === 'waiting_idle' && sinceMs !== null && now - sinceMs >= WAITING_ASK_AFTER_MS) {
    entry.waitingSince = clip(record.since)
  }
  return entry
}
