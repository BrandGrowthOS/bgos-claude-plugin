/**
 * Version heartbeat: report this daemon's plugin version to the backend so
 * the app's plugin-update prompt (isPairingOutdated vs MIN_PLUGIN_VERSIONS)
 * can see it. Pairing-auth daemons only: the backend heartbeat route
 * (POST integrations/heartbeat) authenticates with X-BGOS-Pairing and writes
 * daemon_version onto the pairing row; legacy X-API-Key installs have no
 * pairing row, so there is nothing to write and we skip entirely.
 *
 * Telemetry rules: never throw (a failed heartbeat must never touch the
 * daemon), fire at startup then every 6 hours, unref'd so it cannot hold the
 * process open.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { MACHINE_ID_RE } from './machine-id.mjs'
import { SESSION_STATUS_TICK_MS, sessionStatusDue, sessionStatusSignature } from './session-status.ts'
import type { SessionStatusReport } from './session-status-contract.ts'
import type { UpdateReadiness } from './update-readiness.js'

/**
 * The version shape this daemon reports, the SAME one the backend heartbeat
 * DTO (DAEMON_VERSION_REGEX) and the watcher (VERSION_RE in
 * watcher-bundle.mjs, keepalive-plan.mjs) accept: X.Y.Z plus an optional
 * prerelease or build suffix. Until 0.62.1 this reader alone demanded strict
 * X.Y.Z, so a clone on `0.62.1-local` reported runningVersion null and the
 * watcher never restarted it onto the staged update (mission 104 goal 4
 * proof, finding F1). Self-update still compares strict X.Y.Z only
 * (parseSemver), so a prerelease running version is skipped there as before.
 */
export const OWN_VERSION_RE = /^\d+\.\d+\.\d+[-\w.]*$/

/** Read the plugin version from package.json next to the server entry. Never throws. */
export function readOwnVersion(rootDir: string): string | null {
  try {
    const raw = readFileSync(join(rootDir, 'package.json'), 'utf8')
    const v = (JSON.parse(raw) as { version?: unknown }).version
    return typeof v === 'string' && v.length <= 32 && OWN_VERSION_RE.test(v) ? v : null
  } catch {
    return null
  }
}

/**
 * The environment this daemon is running in, as IT sees it.
 *
 * `cwd` is the load-bearing one. Claude Code reads an agent's CLAUDE.md and its
 * memory from its working directory, so an agent pointed at the wrong folder
 * keeps answering while silently missing its persona and its history. Six
 * agents ran that way for weeks and nothing in the app could show it, because
 * the daemon never reported where it actually was. The backend has accepted
 * this field all along (HeartbeatEnvDto.cwd) and deliberately refuses to infer
 * a default, so until the daemon says it, the owner sees "not reported" rather
 * than a comforting guess.
 *
 * `machineId` (zero-terminal lifecycle, design 2.1) is what lets the backend
 * group every agent and the watcher on one host under one machine; it comes
 * from an injected provider (lib/machine-id.mjs) and is omitted, never
 * guessed, when the provider throws or yields a shape the backend rejects.
 * `role` is always 'agent' here: the watcher sends its own heartbeat.
 *
 * Pure and total: it reads process state and cannot throw, so the telemetry
 * rule above still holds.
 */
export interface HeartbeatEnv {
  cwd?: string
  platform?: string
  machineId?: string
  role: 'agent'
  /** Non secret fingerprint of the Claude credential store (lib/claude-login.ts). */
  claudeAccountKey?: string
  /** The signed in Claude account's email, when the CLI recorded one. */
  claudeAccountLabel?: string
}

/** What lib/claude-login.ts knows about this session's Claude login. */
export interface ClaudeAccountIdentity {
  key: string
  label: string | null
}

export function heartbeatEnv(
  proc: {
    cwd: () => string;
    platform: string;
  },
  providers: { machineId?: () => string; claudeAccount?: () => ClaudeAccountIdentity | null } = {},
): HeartbeatEnv {
  const env: HeartbeatEnv = { role: 'agent' }
  try {
    const cwd = proc.cwd()
    // The backend caps cwd at 512 chars. Send nothing rather than a truncated
    // path, because half a path shown as fact is worse than an honest blank.
    if (typeof cwd === 'string' && cwd.length > 0 && cwd.length <= 512) {
      env.cwd = cwd
    }
  } catch {
    // A process without a readable cwd still reports its platform.
  }
  if (typeof proc.platform === 'string' && proc.platform.length > 0) {
    env.platform = proc.platform
  }
  try {
    const machineId = providers.machineId?.()
    if (typeof machineId === 'string' && MACHINE_ID_RE.test(machineId)) {
      env.machineId = machineId
    }
  } catch {
    // An unreadable machine id is omitted; the rest of the env still rides.
  }
  // Which Claude login this session shares with the other agents here, so the
  // backend can say "the login on this computer" once instead of once per
  // agent. Same shapes the backend accepts (8 to 16 hex, one line of 120);
  // anything else is omitted rather than sent to be dropped.
  try {
    const account = providers.claudeAccount?.()
    if (account && /^[a-f0-9]{8,16}$/.test(account.key)) {
      env.claudeAccountKey = account.key
      if (typeof account.label === 'string' && account.label.length > 0 && account.label.length <= 120) {
        env.claudeAccountLabel = account.label
      }
    }
  } catch {
    // An unreadable account is omitted; the rest of the env still rides.
  }
  return env
}

/** Pure decision: should this process send version heartbeats at all? */
export function shouldSendVersionHeartbeat(authMode: string, version: string | null): boolean {
  return authMode === 'pairing' && version !== null
}

export const VERSION_HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000
/** How often the readiness snapshot is re-read for CHANGE; a changed snapshot
 *  is re-sent at once, an unchanged one costs nothing on the wire. Without
 *  this the block rode only the 6h beat and a lifted latch stayed on the
 *  app's badge for hours (board row 01a061fb, 2026-09-02). */
export const READINESS_POLL_MS = 60 * 1000

/** One-click update telemetry providers (wire contract v1 section 1),
 *  evaluated per send because the launcher supervisor and the latch files
 *  can change under a running daemon. */
export interface HeartbeatUpdateStatus {
  latestKnownVersion: () => string | null
  updateReadiness: () => UpdateReadiness
}

/**
 * Start the heartbeat loop. `post` is the plugin's authenticated POST helper.
 * Returns { timer, sendNow } (timer unref'd) or null when skipped, for tests
 * and for the update_rpc handler, whose 'staged' path fires sendNow so
 * pendingRestartVersion does not wait up to 6 hours (the backend's own
 * >=10s per-pairing debounce still applies).
 */
export function startVersionHeartbeat(deps: {
  authMode: string
  rootDir: string
  post: (path: string, body: Record<string, unknown>) => Promise<unknown>
  log: (msg: string) => void
  updateStatus?: HeartbeatUpdateStatus
  /** lib/machine-id.mjs ensureMachineId, injected so tests never touch a home dir. */
  machineId?: () => string
  /** lib/claude-login.ts identity of this session's Claude login, injected likewise. */
  claudeAccount?: () => ClaudeAccountIdentity | null
  /**
   * Current daemon-level fault, or null when healthy. Sent on EVERY beat: the
   * backend clears the stored columns on an explicit null, so recovery needs no
   * separate call. Guarded like the update providers below, because telemetry
   * must never be the reason a heartbeat fails.
   */
  lastError?: () => { code: string; message: string; at: string } | null
  /**
   * What this daemon reports it can do (lib/declared-capabilities.ts). The
   * backend REPLACES the stored declaration wholesale with whatever arrives,
   * so this rides every beat and an updated daemon starts declaring on its
   * next one with no re-pair. An EMPTY list is omitted rather than sent: an
   * empty array would clear a declaration the daemon still honours. Guarded
   * like the providers above, because telemetry must never be the reason a
   * heartbeat fails.
   */
  capabilities?: () => string[]
  /** Test seam for the readiness change poll (default READINESS_POLL_MS). */
  readinessPollMs?: number
  /**
   * What the session behind this daemon is doing (lib/session-status.ts,
   * HOAI board row 9c3d6b2c), or null when this daemon must not report (it is
   * not the pairing lock holder: a passive daemon's idle state would paint
   * over the live session's). Rides EVERY full beat, and its own small beat
   * (`{ daemonVersion, sessionStatus }`) within a minute of a change and
   * every 2 minutes while work is owed (sessionStatusDue). Guarded like the
   * providers above: telemetry is never the reason a beat fails.
   */
  sessionStatus?: () => SessionStatusReport | null
  /** Test seam for the status clock (default Date.now). */
  now?: () => number
}): {
  timer: ReturnType<typeof setInterval>
  readinessTimer: ReturnType<typeof setInterval>
  statusTimer: ReturnType<typeof setInterval>
  sendNow: () => void
  pollReadiness: () => Promise<void>
  pollSessionStatus: () => Promise<void>
} | null {
  const version = readOwnVersion(deps.rootDir)
  if (!shouldSendVersionHeartbeat(deps.authMode, version)) return null
  // The readiness block as last SENT, so the poll below can tell a change
  // from a repeat without keeping the object itself around.
  let lastSentReadiness: string | null = null
  // The session status as last TRIED and as last TAKEN by the server: the gap
  // runs from a try (a down server is not hammered), the news is measured
  // against what the server took (a failed send is tried again).
  const clock = deps.now ?? Date.now
  let lastStatusAttemptAtMs: number | null = null
  let lastStatusSentSignature: string | null = null
  const readStatus = (): SessionStatusReport | null => {
    if (!deps.sessionStatus) return null
    try {
      return deps.sessionStatus()
    } catch {
      return null
    }
  }
  const send = async () => {
    try {
      const body: Record<string, unknown> = {
        daemonVersion: version,
        env: heartbeatEnv(process, { machineId: deps.machineId, claudeAccount: deps.claudeAccount }),
      }
      const sessionReport = readStatus()
      if (sessionReport) {
        body.sessionStatus = sessionReport
        lastStatusAttemptAtMs = clock()
      }
      // Guarded per provider: readiness must still ride when the
      // latest-version probe throws, and vice versa. The backend ignores
      // invalid values rather than 400ing, so null is always safe to send.
      const status = deps.updateStatus
      if (status) {
        try {
          body.latestKnownVersion = status.latestKnownVersion()
        } catch {}
        try {
          body.updateReadiness = status.updateReadiness()
          lastSentReadiness = JSON.stringify(body.updateReadiness)
        } catch {}
      }
      if (deps.lastError) {
        try {
          body.lastError = deps.lastError()
        } catch {}
      }
      if (deps.capabilities) {
        try {
          const declared = deps.capabilities()
          if (Array.isArray(declared) && declared.length > 0) body.capabilities = declared
        } catch {}
      }
      await deps.post('integrations/heartbeat', body)
      if (sessionReport) lastStatusSentSignature = sessionStatusSignature(sessionReport)
    } catch {
      // Telemetry only: never let a heartbeat failure surface.
    }
  }
  // The session status's own small beat. Cheap when nothing is due: one
  // in-memory read and a string compare per tick, no I/O.
  const pollSessionStatus = async (): Promise<void> => {
    const status = readStatus()
    if (!status) return
    const now = clock()
    const due = sessionStatusDue({
      nowMs: now,
      lastAttemptAtMs: lastStatusAttemptAtMs,
      lastSentSignature: lastStatusSentSignature,
      report: status,
    })
    if (due === null) return
    lastStatusAttemptAtMs = now
    try {
      await deps.post('integrations/heartbeat', { daemonVersion: version, sessionStatus: status })
      lastStatusSentSignature = sessionStatusSignature(status)
    } catch {
      // Tried again once the gap allows; never surfaces.
    }
  }
  // Change-driven readiness resend: re-read the snapshot cheaply and post
  // only when it differs from what the backend last received. Guarded like
  // the providers themselves: a throwing probe means "no change seen".
  const pollReadiness = async (): Promise<void> => {
    const status = deps.updateStatus
    if (!status) return
    let current: string
    try {
      current = JSON.stringify(status.updateReadiness())
    } catch {
      return
    }
    if (lastSentReadiness !== null && current === lastSentReadiness) return
    await send()
  }
  void send()
  deps.log(
    `version heartbeat armed (v${version}, every 6h; readiness re-sent within a minute of a change` +
      `${deps.sessionStatus ? '; session status within a minute of a change and every 2 min while busy' : ''})`,
  )
  const timer = setInterval(send, VERSION_HEARTBEAT_INTERVAL_MS)
  timer.unref?.()
  const readinessTimer = setInterval(() => void pollReadiness(), deps.readinessPollMs ?? READINESS_POLL_MS)
  readinessTimer.unref?.()
  const statusTimer = setInterval(() => void pollSessionStatus(), SESSION_STATUS_TICK_MS)
  statusTimer.unref?.()
  return { timer, readinessTimer, statusTimer, sendNow: () => void send(), pollReadiness, pollSessionStatus }
}
