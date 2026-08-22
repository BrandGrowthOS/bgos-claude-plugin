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

import type { UpdateReadiness } from './update-readiness.js'

/** Read the plugin version from package.json next to the server entry. Never throws. */
export function readOwnVersion(rootDir: string): string | null {
  try {
    const raw = readFileSync(join(rootDir, 'package.json'), 'utf8')
    const v = (JSON.parse(raw) as { version?: unknown }).version
    return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v : null
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
 * Pure and total: it reads process state and cannot throw, so the telemetry
 * rule above still holds.
 */
export function heartbeatEnv(proc: {
  cwd: () => string;
  platform: string;
}): { cwd?: string; platform?: string } {
  const env: { cwd?: string; platform?: string } = {}
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
  return env
}

/** Pure decision: should this process send version heartbeats at all? */
export function shouldSendVersionHeartbeat(authMode: string, version: string | null): boolean {
  return authMode === 'pairing' && version !== null
}

export const VERSION_HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000

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
}): { timer: ReturnType<typeof setInterval>; sendNow: () => void } | null {
  const version = readOwnVersion(deps.rootDir)
  if (!shouldSendVersionHeartbeat(deps.authMode, version)) return null
  const send = async () => {
    try {
      const body: Record<string, unknown> = {
        daemonVersion: version,
        env: heartbeatEnv(process),
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
        } catch {}
      }
      await deps.post('integrations/heartbeat', body)
    } catch {
      // Telemetry only: never let a heartbeat failure surface.
    }
  }
  void send()
  deps.log(`version heartbeat armed (v${version}, every 6h)`)
  const timer = setInterval(send, VERSION_HEARTBEAT_INTERVAL_MS)
  timer.unref?.()
  return { timer, sendNow: () => void send() }
}
