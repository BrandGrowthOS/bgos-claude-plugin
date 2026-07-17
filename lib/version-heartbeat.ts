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

/** Pure decision: should this process send version heartbeats at all? */
export function shouldSendVersionHeartbeat(authMode: string, version: string | null): boolean {
  return authMode === 'pairing' && version !== null
}

export const VERSION_HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Start the heartbeat loop. `post` is the plugin's authenticated POST helper.
 * Returns the timer (unref'd) or null when skipped, for tests.
 */
export function startVersionHeartbeat(deps: {
  authMode: string
  rootDir: string
  post: (path: string, body: Record<string, unknown>) => Promise<unknown>
  log: (msg: string) => void
}): ReturnType<typeof setInterval> | null {
  const version = readOwnVersion(deps.rootDir)
  if (!shouldSendVersionHeartbeat(deps.authMode, version)) return null
  const send = async () => {
    try {
      await deps.post('integrations/heartbeat', { daemonVersion: version })
    } catch {
      // Telemetry only: never let a heartbeat failure surface.
    }
  }
  void send()
  deps.log(`version heartbeat armed (v${version}, every 6h)`)
  const timer = setInterval(send, VERSION_HEARTBEAT_INTERVAL_MS)
  timer.unref?.()
  return timer
}
