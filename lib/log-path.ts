/**
 * Stable daemon log path (fix 06, one-click onboarding).
 *
 * WHY: server.ts used to default the log to join(os.tmpdir(),
 * 'bgos-plugin-<id>.log'), and os.tmpdir() is not one place. macOS launchd
 * hands every session its own per-session $TMPDIR while a login shell gives
 * /tmp, so the "predictable" path moved with how the daemon was launched and
 * nobody (human or remote agent Read tool) could reliably find the log. The
 * fix is one documented location under the plugin state root:
 *   <home>/.bgos-agent/logs/bgos-plugin-<assistantId>.log
 * with BGOS_LOG_FILE still winning as an explicit per-deployment override.
 *
 * Directory creation is best effort: logging must never crash the daemon, so
 * ensureLogDir swallows every mkdir error and the appendFileSync in server.ts
 * keeps its own try/catch as the last line of defense.
 */

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Resolve the daemon's log file path. `env` and `home` are injectable for
 * tests; production passes process.env + os.homedir(). A non-empty (trimmed)
 * BGOS_LOG_FILE wins; otherwise the stable home-rooted default, keyed by the
 * assistant id ('unknown' when the id is missing or blank).
 */
export function resolveLogPath(opts: {
  env: Record<string, string | undefined>
  home: string
  assistantId: string | null | undefined
}): string {
  const override = (opts.env.BGOS_LOG_FILE ?? '').trim()
  if (override) return override
  const id = String(opts.assistantId ?? '').trim() || 'unknown'
  return join(opts.home, '.bgos-agent', 'logs', `bgos-plugin-${id}.log`)
}

/**
 * Best-effort recursive create of the log file's directory. Never throws:
 * a daemon that cannot mkdir its log dir must still boot (stderr keeps
 * working, and the append call in server.ts swallows its own failures).
 * `mkdir` is injectable for tests; production uses node:fs mkdirSync.
 */
export function ensureLogDir(
  logPath: string,
  mkdir: (dir: string, opts: { recursive: true }) => unknown = mkdirSync,
): void {
  try {
    mkdir(dirname(logPath), { recursive: true })
  } catch {
    /* best effort only */
  }
}
