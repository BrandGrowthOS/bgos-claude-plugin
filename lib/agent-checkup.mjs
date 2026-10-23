/**
 * agent-checkup: the PURE classifier and planner of the check up pass
 * (PLAN-doctor.md section 4.2, packet P2).
 *
 * The watcher builds ONE observation per agent from the observers the keep-alive
 * sweep already has (process tree, agent-state.json, launch-status, beacon
 * heartbeat, transcript tail, update state), then asks THIS module two things:
 *
 *   diagnoseAgent(obs)             -> findings, naming the cause C3 to C9
 *   planRepairs(findings, gates)   -> actions, the safe step for each finding
 *
 * Nothing here touches a file, a process, a clock or the network: `now` is a
 * field of the observation, so every rule is a table in test/agent-checkup.test.ts
 * and a one-line mutant of any guard turns a named row red. The executor that
 * acts on the plan is the existing one; only a `restart` or `start` step ever
 * touches a process.
 *
 * Causes (C1 and C2 are the backend's, they need no computer):
 *
 *   C3 daemon_down | beacon_stale      claude lives, the daemon is gone or its beacon is stale
 *   C4 not_running | launch_failed |   no claude and no daemon; a named launch failure or an agent
 *      needs_first_launch              never started is REPORTED, never retried in a loop
 *   C5 no_reply | stuck_screen         owner messages delivered and no transcript activity for the
 *                                      wedge window, or a screen nobody can answer
 *   C6 stale_plugin                    the running version is below the installed or published one
 *   C7 job_past_deadline | validation_stalled | drain_too_long | staged_not_applied
 *   C8 login_expired                   authentication_failed; REPORT ONLY
 *   C9 usage_limit                     rate_limit; REPORT ONLY
 *
 * Plan rules, in the order the plan lists them:
 *
 *   report first   C8, C9 and every cause the watcher may not fix, because a restart cannot help them.
 *   never restart  a restart or start is NEVER planned while C8 or C9 is a finding (a restart of a
 *                  signed out session only adds a failed launch), nor after a named launch failure.
 *                  The one exception is C3 (packet P3, the brief's decision): claude runs and only its
 *                  connector is down. The connector is not the model, restarting it needs no login and
 *                  no quota, and it is what carries the login or limit report and the owner's next
 *                  message, so the pass fixes it in the same pass that reports C8 or C9. It still goes
 *                  through the safe table and the budget; a C4 start stays blocked.
 *   then update    C6 `update`, C7 `repair` (one of them, repair covers both); file level, they touch
 *                  no process, so they run even when the moment is unsafe.
 *   then restart   C3, C4 (`start`), C5, and the restart that applies an update. ONE per pass. It goes
 *                  through the keep-alive gates: decideSafeMoment (never a kill of an unsafe session,
 *                  finding 9; unknown is unsafe), then decideRestartBudget (1 per 30 min, 3 attempts
 *                  then `failed`). A held step is `skipped` with its reason and `waiting_idle`.
 *   then verify    once, by the boot hello, only after a restart or start was planned.
 *
 * Plain JavaScript, node >= 18. The only import is the pure keep-alive plan.
 */

import { REPORT_STRING_MAX, decideRestartBudget, decideSafeMoment } from './keepalive-plan.mjs'

// -- Contract constants -----------------------------------------------------------------------

/** Owner messages delivered and no transcript activity for this long is a wedge (plan 7.2, proposal). */
export const WEDGE_WINDOW_MS = 10 * 60_000
/** A beacon heartbeat older than this, while claude runs, is a daemon that stopped beating. */
export const BEACON_STALE_MS = 5 * 60_000
/** validationPending older than this is an update that never validated. */
export const VALIDATION_WINDOW_MS = 10 * 60_000
/** A daemon in drain mode longer than this is stuck (plan 3, C7 "more than N minutes"). */
export const DRAIN_MAX_MS = 15 * 60_000
/** The whole pass, inside the backend's 75 s result window (plan 4.2). */
export const PASS_DEADLINE_MS = 75_000
/** The owner action text is bounded like every other string the backend takes. */
export const OWNER_TEXT_MAX = 240

export const CAUSES = Object.freeze({
  C3: 'daemon_down',
  C4: 'dead_session',
  C5: 'wedged_session',
  C6: 'stale_plugin',
  C7: 'stuck_update',
  C8: 'login_expired',
  C9: 'usage_limit',
})

/** launch-status outcomes that mean a launch FAILED and said why (bin/bgos-agent). */
const NAMED_LAUNCH_FAILURES = new Set([
  'exited-during-startup',
  'plugin-root-missing',
  'node-missing',
  'hoai-exited-without-status',
  'tmux-failed',
])
const SIGNED_OUT_OUTCOME = 'live-but-not-signed-in'

const REPORT_ORDER = ['C8', 'C9', 'C4']

// -- Small helpers ----------------------------------------------------------------------------

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)([-\w.]*)$/

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clip(value, max = REPORT_STRING_MAX) {
  const text = String(value ?? '')
  return text.length > max ? text.slice(0, max) : text
}

function msOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Numeric version compare: negative, 0, positive; null when either side does not parse. */
export function compareVersions(a, b) {
  const left = typeof a === 'string' ? VERSION_RE.exec(a) : null
  const right = typeof b === 'string' ? VERSION_RE.exec(b) : null
  if (!left || !right) return null
  for (let i = 1; i <= 3; i++) {
    const diff = Number(left[i]) - Number(right[i])
    if (diff !== 0) return diff
  }
  // 0.75.0-rc1 is below 0.75.0.
  if (left[4] === right[4]) return 0
  if (!left[4]) return 1
  if (!right[4]) return -1
  return left[4] < right[4] ? -1 : 1
}

function newestVersion(versions) {
  let best = null
  for (const version of versions) {
    if (typeof version !== 'string' || !VERSION_RE.test(version)) continue
    if (best === null || compareVersions(version, best) > 0) best = version
  }
  return best
}

/**
 * @typedef {{
 *   cause: string, code: string, fixable: boolean, evidence: string,
 *   from?: string | null, to?: string | null, resetAt?: string | null,
 *   outcome?: string, screen?: string, reasons?: string[],
 * }} Finding
 * @typedef {{ kind: string, text: string }} OwnerAction
 * @typedef {{
 *   action: 'report' | 'update' | 'repair' | 'restart' | 'start' | 'verify',
 *   causes: string[], outcome: 'planned' | 'skipped', reason: string | null,
 *   state?: string, code?: string, ownerAction?: OwnerAction, via?: string, deadlineMs?: number,
 * }} Action
 */

/**
 * @param {string} cause
 * @param {string} code
 * @param {boolean} fixable
 * @param {string} evidence
 * @param {Partial<Finding>} [extra]
 * @returns {Finding}
 */
function finding(cause, code, fixable, evidence, extra = {}) {
  return { cause, code, fixable, evidence: clip(evidence), ...extra }
}

// -- The classifier ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   now: number,
 *   assistantId: string,
 *   claudeAlive: boolean | null,        // a live claude for this agent; null = process table unreadable
 *   daemonAlive: boolean | null,        // a live daemon pid for it; null = unknown
 *   descendants: string[] | null,       // claude's descendant command lines; null = unreadable
 *   agentState: object | null,          // parsed agent-state.json (keepalive-plan parseAgentState)
 *   stateFresh: boolean,
 *   activityMs: Array<number | null>,   // lastActivityAt, events.jsonl mtime, transcript mtime
 *   beaconHeartbeatAtMs: number | null,
 *   launchStatus: { outcome: string } | null,
 *   hasSupervisor: boolean,
 *   hasLaunchRecipe: boolean,
 *   messagesDeliveredAtMs: number | null,      // newest owner message the daemon delivered
 *   lastTranscriptActivityAtMs: number | null, // newest real model activity
 *   stuckScreen: string | null,                // a named screen nobody can answer
 *   runningVersion: string | null,
 *   installedVersion: string | null,
 *   publishedVersion: string | null,
 *   belowFloor: boolean,                       // the backend's isPairingOutdated, when it told us
 *   update: { jobDeadlineAtMs, validationPendingSinceMs, drainSinceMs, stagedNeverApplied },
 *   transcriptError: { kind: 'authentication_failed' | 'rate_limit', resetAt: string | null } | null,
 *   lastRestartAtMs: number | null,
 *   attempts: number,
 * }} Observation
 */

/**
 * Name every cause the observation shows. Unknown is not a diagnosis: a process
 * table that could not be read names no process cause (C3 to C5).
 * @param {Observation} obs
 */
export function diagnoseAgent(obs) {
  /** @type {Finding[]} */
  const out = []
  const now = obs.now
  const launchOutcome = typeof obs.launchStatus?.outcome === 'string' ? obs.launchStatus.outcome : null

  // C8 / C9: the transcript envelope, or a launch that came up signed out.
  const errorKind = obs.transcriptError?.kind ?? null
  const signedOut = errorKind === 'authentication_failed' || launchOutcome === SIGNED_OUT_OUTCOME
  const limited = errorKind === 'rate_limit'
  if (signedOut) {
    out.push(
      finding('C8', 'login_expired', false, errorKind ? 'the transcript ends in authentication_failed' : 'the last launch came up signed out'),
    )
  }
  if (limited) {
    const resetAt = typeof obs.transcriptError.resetAt === 'string' ? obs.transcriptError.resetAt : null
    out.push(finding('C9', 'usage_limit', false, resetAt ? `usage limit, resets at ${resetAt}` : 'usage limit, reset time unknown', { resetAt }))
  }
  const explained = signedOut || limited

  // C3 / C4 / C5: the process table.
  if (obs.claudeAlive === true) {
    if (obs.daemonAlive === false) {
      out.push(finding('C3', 'daemon_down', true, 'claude is running and no daemon is'))
    } else {
      const beat = msOf(obs.beaconHeartbeatAtMs)
      if (beat !== null && now - beat > BEACON_STALE_MS) {
        out.push(finding('C3', 'beacon_stale', true, `the beacon last beat ${Math.round((now - beat) / 60_000)} min ago while claude runs`))
      }
    }
    if (!explained) {
      const delivered = msOf(obs.messagesDeliveredAtMs)
      const lastActivity = msOf(obs.lastTranscriptActivityAtMs)
      if (typeof obs.stuckScreen === 'string' && obs.stuckScreen) {
        out.push(finding('C5', 'stuck_screen', true, `stuck on a screen nobody can answer: ${obs.stuckScreen}`, { screen: obs.stuckScreen }))
      } else if (delivered !== null && now - delivered >= WEDGE_WINDOW_MS && (lastActivity === null || lastActivity < delivered)) {
        out.push(finding('C5', 'no_reply', true, `no reply to a message delivered ${Math.round((now - delivered) / 60_000)} min ago`))
      }
    }
  } else if (obs.claudeAlive === false && obs.daemonAlive === false) {
    if (launchOutcome === SIGNED_OUT_OUTCOME) {
      // Already C8 above: the launch is explained, a start would only fail again.
    } else if (launchOutcome !== null && (NAMED_LAUNCH_FAILURES.has(launchOutcome) || launchOutcome.startsWith('gate-'))) {
      out.push(finding('C4', 'launch_failed', false, `the last launch failed: ${launchOutcome}`, { outcome: launchOutcome }))
    } else if (!obs.hasSupervisor && !obs.hasLaunchRecipe) {
      out.push(finding('C4', 'needs_first_launch', false, 'not running, and nothing here knows how to start it'))
    } else {
      out.push(finding('C4', 'not_running', true, 'no claude and no daemon for this agent'))
    }
  }

  // C6: running below what is installed, published, pending, or the backend's floor.
  const target = newestVersion([
    obs.installedVersion,
    obs.publishedVersion,
    obs.stateFresh ? obs.agentState?.pendingRestartVersion : null,
  ])
  const behind = target !== null && compareVersions(obs.runningVersion, target) < 0
  if (behind || obs.belowFloor === true) {
    out.push(
      finding(
        'C6',
        'stale_plugin',
        true,
        behind ? `running ${obs.runningVersion}, ${target} is available` : `running ${obs.runningVersion ?? 'an unknown version'}, below the app minimum`,
        { from: obs.runningVersion ?? null, to: behind ? target : null },
      ),
    )
  }

  // C7: an update that is past a deadline or a window.
  const update = isRecord(obs.update) ? obs.update : {}
  const stuck = []
  const deadline = msOf(update.jobDeadlineAtMs)
  if (deadline !== null && now > deadline) stuck.push('job_past_deadline')
  const validating = msOf(update.validationPendingSinceMs)
  if (validating !== null && now - validating > VALIDATION_WINDOW_MS) stuck.push('validation_stalled')
  const draining = msOf(update.drainSinceMs)
  if (draining !== null && now - draining > DRAIN_MAX_MS) stuck.push('drain_too_long')
  if (update.stagedNeverApplied === true) stuck.push('staged_not_applied')
  if (stuck.length > 0) out.push(finding('C7', stuck[0], true, `the update is stuck: ${stuck.join(', ')}`, { reasons: stuck }))

  return out.sort((a, b) => Number(a.cause.slice(1)) - Number(b.cause.slice(1)))
}

// -- The gates --------------------------------------------------------------------------------

/**
 * The keep-alive gates for this observation: the safe moment (design 6 table)
 * and the restart budget inputs. Pure; the planner reads only this.
 * @param {Observation} obs
 */
export function buildGates(obs) {
  const state = obs.stateFresh === true ? (obs.agentState ?? null) : null
  return {
    now: obs.now,
    lastRestartAtMs: msOf(obs.lastRestartAtMs),
    attempts: Number.isInteger(obs.attempts) ? obs.attempts : 0,
    safeMoment: decideSafeMoment({
      running: obs.claudeAlive,
      stateFresh: obs.stateFresh === true && state !== null,
      state,
      descendants: obs.descendants,
      activityMs: obs.activityMs,
      now: obs.now,
    }),
  }
}

// -- The planner ------------------------------------------------------------------------------

/** @param {Finding} f @returns {OwnerAction} */
function ownerActionFor(f) {
  switch (f.code) {
    case 'login_expired':
      return {
        kind: 'login',
        text: 'Claude Code is signed out on this computer. Open the agent and type /login; every agent on this login comes back.',
      }
    case 'usage_limit':
      return {
        kind: 'wait',
        text: f.resetAt
          ? `The Claude usage limit was reached; it resets at ${f.resetAt}.`
          : 'The Claude usage limit was reached. The agent comes back on its own when the limit resets.',
      }
    case 'launch_failed':
      return { kind: 'fix_launch', text: `The last start did not come up (${f.outcome}). Open the agent on the computer to see why.` }
    case 'needs_first_launch':
      return { kind: 'first_launch', text: 'This agent has not been started on this computer yet. Start it once from its folder.' }
    default:
      return { kind: 'check', text: f.evidence }
  }
}

/**
 * The safe step for each finding.
 * @param {Finding[]} findings
 * @param {{
 *   now: number, lastRestartAtMs: number | null, attempts: number,
 *   safeMoment: { safe: boolean, reason: string },
 * }} gates
 * @returns {Action[]}
 */
export function planRepairs(findings, gates) {
  const has = (/** @type {string} */ cause) => findings.some((f) => f.cause === cause)
  /** @type {Action[]} */
  const actions = []

  // 1. Report the causes the watcher may not fix, first.
  const reported = findings
    .filter((f) => !f.fixable)
    .sort((a, b) => REPORT_ORDER.indexOf(a.cause) - REPORT_ORDER.indexOf(b.cause))
  for (const f of reported) {
    actions.push({ action: 'report', causes: [f.cause], outcome: 'planned', reason: null, code: f.code, ownerAction: ownerActionFor(f) })
  }

  // 2. Files: one update or repair. Repair covers a stale plugin too.
  const stuckUpdate = has('C7')
  const stale = has('C6')
  /** @type {string[]} */
  const fileCauses = []
  if (stale) fileCauses.push('C6')
  if (stuckUpdate) fileCauses.push('C7')
  if (fileCauses.length > 0) {
    actions.push({ action: stuckUpdate ? 'repair' : 'update', causes: fileCauses, outcome: 'planned', reason: null })
  }

  // 3. Process: one restart or start for every cause that wants one.
  const restartCauses = findings
    .filter((f) => (f.cause === 'C3' || f.cause === 'C4' || f.cause === 'C5') && f.fixable)
    .map((f) => f.cause)
  if (stale) restartCauses.push('C6')
  if (stuckUpdate) restartCauses.push('C7')
  if (restartCauses.length > 0) {
    /** @type {'start' | 'restart'} */
    const action = findings.some((f) => f.cause === 'C4' && f.fixable) ? 'start' : 'restart'
    const causes = [...new Set(restartCauses)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
    const blocked = restartBlock(findings, gates)
    if (blocked) {
      actions.push({ action, causes, outcome: 'skipped', reason: blocked.reason, state: blocked.state })
    } else {
      actions.push({ action, causes, outcome: 'planned', reason: null })
      // 4. Verify once, by the boot hello, after something booted.
      actions.push({ action: 'verify', causes, outcome: 'planned', reason: null, via: 'boot_hello', deadlineMs: PASS_DEADLINE_MS })
    }
  }

  return actions
}

/**
 * Why the restart may not happen, or null when it may. The first answer wins.
 * @param {Finding[]} findings
 * @param {{ now: number, lastRestartAtMs: number | null, attempts: number, safeMoment: { safe: boolean, reason: string } }} gates
 * @returns {{ reason: string, state: string } | null}
 */
function restartBlock(findings, gates) {
  // A restart cannot fix a login or a usage limit, and a restart of a signed out session only adds a failed launch.
  // A dead connector under a live claude (C3) is the exception: its restart needs neither, and it carries the report.
  const connectorDown = findings.some((f) => f.cause === 'C3')
  if (!connectorDown && findings.some((f) => f.cause === 'C8')) return { reason: 'blocked_by_login', state: 'blocked' }
  if (!connectorDown && findings.some((f) => f.cause === 'C9')) return { reason: 'blocked_by_usage_limit', state: 'blocked' }
  // A launch that failed and said why is reported, never retried in a loop.
  const launch = findings.find((f) => f.cause === 'C4' && !f.fixable)
  if (launch) return { reason: launch.code, state: 'blocked' }
  // Never a kill of an unsafe session; unknown is unsafe.
  if (!gates.safeMoment || gates.safeMoment.safe !== true) {
    return { reason: gates.safeMoment?.reason ?? 'process_tree_unreadable', state: 'waiting_idle' }
  }
  const budget = decideRestartBudget({
    now: gates.now,
    lastRestartAtMs: gates.lastRestartAtMs,
    attempts: gates.attempts,
    pendingKind: 'waiting_idle',
  })
  if (!budget.allowed) return { reason: budget.reason, state: budget.state }
  return null
}

// -- The pass ---------------------------------------------------------------------------------

/**
 * Classify and plan in one call: what the watcher posts as `findings` and `actions`.
 * @param {Observation} obs
 */
export function checkupPass(obs) {
  const findings = diagnoseAgent(obs)
  return { findings, actions: planRepairs(findings, buildGates(obs)) }
}
