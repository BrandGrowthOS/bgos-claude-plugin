/**
 * Pure checkup diagnosis and reporting. Every state receives owner actions;
 * checkup never starts, restarts, signals or takes over an agent. Pairing
 * checks report status without changing credentials.
 */

import { REPORT_STRING_MAX } from './keepalive-plan.mjs'

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
  C10: 'pairing_revoked',
  C11: 'process_unknown',
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

const REPORT_ORDER = ['C10', 'C8', 'C9', 'C11', 'C4', 'C3', 'C5', 'C6', 'C7']

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
 *   action: 'report',
 *   causes: string[], outcome: 'planned', reason: null,
 *   code: string, ownerAction: OwnerAction,
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
 *   processState: 'alive' | 'stopped' | 'unknown', // includes launchers, daemons and background processes
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
 *   pairingRevoked?: boolean | null,           // ONLY an explicit pairing_revoked server response
 * }} Observation
 */

/**
 * Name every cause the observation shows, including uncertainty about complete
 * process absence. Findings require owner action in every process state.
 * @param {Observation} obs
 */
export function diagnoseAgent(obs) {
  /** @type {Finding[]} */
  const out = []
  const now = obs.now
  const launchOutcome = typeof obs.launchStatus?.outcome === 'string' ? obs.launchStatus.outcome : null

  if (obs.pairingRevoked === true) {
    out.push(finding('C10', 'pairing_revoked', false, 'the server explicitly revoked this agent pairing'))
  }

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
    const evidence = resetAt ? `usage limit, resets at ${resetAt}` : 'usage limit, reset time unknown'
    out.push(finding('C9', 'usage_limit', false, evidence, { resetAt }))
  }
  const explained = signedOut || limited

  if (obs.processState !== 'alive' && obs.processState !== 'stopped') {
    out.push(finding('C11', 'process_unknown', false, 'the target could not be confirmed completely stopped'))
  }

  // C3 / C4 / C5: the process table.
  if (obs.claudeAlive === true) {
    if (obs.daemonAlive === false) {
      out.push(finding('C3', 'daemon_down', false, 'claude is running and no daemon is'))
    } else {
      const beat = msOf(obs.beaconHeartbeatAtMs)
      if (beat !== null && now - beat > BEACON_STALE_MS) {
        out.push(finding('C3', 'beacon_stale', false, `the beacon last beat ${Math.round((now - beat) / 60_000)} min ago while claude runs`))
      }
    }
    if (!explained) {
      const delivered = msOf(obs.messagesDeliveredAtMs)
      const lastActivity = msOf(obs.lastTranscriptActivityAtMs)
      if (typeof obs.stuckScreen === 'string' && obs.stuckScreen) {
        out.push(finding('C5', 'stuck_screen', false, `stuck on a screen nobody can answer: ${obs.stuckScreen}`, { screen: obs.stuckScreen }))
      } else if (delivered !== null && now - delivered >= WEDGE_WINDOW_MS && (lastActivity === null || lastActivity < delivered)) {
        out.push(finding('C5', 'no_reply', false, `no reply to a message delivered ${Math.round((now - delivered) / 60_000)} min ago`))
      }
    }
  } else if (obs.processState === 'stopped' && obs.claudeAlive === false && obs.daemonAlive === false) {
    if (launchOutcome === SIGNED_OUT_OUTCOME) {
      // Already C8 above: the launch is explained, a start would only fail again.
    } else if (launchOutcome !== null && (NAMED_LAUNCH_FAILURES.has(launchOutcome) || launchOutcome.startsWith('gate-'))) {
      out.push(finding('C4', 'launch_failed', false, `the last launch failed: ${launchOutcome}`, { outcome: launchOutcome }))
    } else if (!obs.hasSupervisor && !obs.hasLaunchRecipe) {
      out.push(finding('C4', 'needs_first_launch', false, 'not running, and nothing here knows how to start it'))
    } else {
      out.push(finding('C4', 'not_running', false, 'no claude and no daemon for this agent'))
    }
  }

  if (obs.processState === 'alive' && obs.claudeAlive !== true) {
    out.push(finding('C3', 'process_alive', false, 'a launcher, daemon or background process for this agent is still alive'))
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
        false,
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
  if (stuck.length > 0) out.push(finding('C7', stuck[0], false, `the update is stuck: ${stuck.join(', ')}`, { reasons: stuck }))

  return out.sort((a, b) => Number(a.cause.slice(1)) - Number(b.cause.slice(1)))
}

// -- The planner ------------------------------------------------------------------------------

/** @param {Finding} f @returns {OwnerAction} */
function ownerActionFor(f) {
  switch (f.code) {
    case 'pairing_revoked':
      return { kind: 're_pair', text: 'This agent pairing was revoked. Confirm re-pairing this agent with a new pair code from the HOAI app, or run hoai pair with that code in its folder.' }
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
          : 'The Claude usage limit was reached; the reset time is unknown. Check the agent window.',
      }
    case 'launch_failed':
      return { kind: 'fix_launch', text: `The last start did not come up (${f.outcome}). Open the agent on the computer to see why, then tap Restart now when you choose.` }
    case 'needs_first_launch':
      return { kind: 'first_launch', text: 'This agent has not been started on this computer yet. Tap Restart now, or start it once from its folder.' }
    default:
      return { kind: 'restart', text: `${f.evidence}. Tap Restart now to restart this agent when you choose.` }
  }
}

/**
 * Report every finding, regardless of process state or recovery budget.
 * Only an owner action through the existing restart job may restart an agent.
 * @param {Finding[]} findings
 * @returns {Action[]}
 */
export function planRepairs(findings) {
  return [...findings]
    .sort((a, b) => REPORT_ORDER.indexOf(a.cause) - REPORT_ORDER.indexOf(b.cause))
    .map((f) => ({ action: 'report', causes: [f.cause], outcome: 'planned', reason: null, code: f.code, ownerAction: ownerActionFor(f) }))
}

// -- The pass ---------------------------------------------------------------------------------

/**
 * Classify and plan in one call: what the watcher posts as `findings` and `actions`.
 * @param {Observation} obs
 */
export function checkupPass(obs) {
  const findings = diagnoseAgent(obs)
  return { findings, actions: planRepairs(findings) }
}
