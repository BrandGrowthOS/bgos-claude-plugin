/**
 * Update readiness: what would restart this daemon, and how the heartbeat
 * reports it (one-click updates, wire contract v1). Shared by the version
 * heartbeat (updateReadiness telemetry) and the update_rpc restart ladder
 * (which restart authority to use, lib/update-rpc.ts).
 *
 * Restart authorities, strongest first (path naming mirrors bin/bgos-agent's
 * label_for / unit_for / plist_for / unitfile_for / statedir_for):
 *   - an installed always-on service file for this assistant: launchd plist
 *     on macOS, systemd --user unit on Linux;
 *   - a live launcher supervisor: bin/hoai-core.mjs writes
 *     ~/.bgos-agent/<id>/supervisor.json while its supervise loop runs and
 *     relaunches claude when ~/.bgos-agent/<id>/restart-requested.json
 *     appears. The marker's CONTENTS are ignored, existence only, so the
 *     marker can never carry commands;
 *   - none: the daemon must never exit (the kc-server invariant,
 *     lib/self-update.ts shouldExitAfterUpdate), it stages instead.
 *
 * Pure and injectable throughout so every decision is unit-testable.
 */

import { join } from 'node:path'

/** Mirror of bin/hoai-core.mjs SUPERVISOR_FILE_NAME / RESTART_MARKER_FILE_NAME
 *  (pinned by test/update-readiness.test.ts, which imports both sides). */
export const SUPERVISOR_FILE = 'supervisor.json'
export const RESTART_MARKER_FILE = 'restart-requested.json'

/** The wire enum for updateReadiness.supervised. This plugin only ever
 *  reports systemd | launchd | launcher | none; supervise-npm and pm2 belong
 *  to other channel daemons sharing the contract. */
export type SupervisedKind =
  | 'systemd'
  | 'launchd'
  | 'launcher'
  | 'supervise-npm'
  | 'pm2'
  | 'none'

export interface UpdateReadiness {
  supervised: SupervisedKind
  autoUpdateEnabled: boolean
  rollbackLatched: boolean
  pendingRestartVersion: string | null
}

/** Assistant ids are digits-only everywhere (bin/bgos-agent valid_id).
 *  Anything else builds no path and selects no restart authority. */
export function validAssistantId(
  id: string | number | null | undefined,
): string | null {
  const value = String(id ?? '').trim()
  return /^\d+$/.test(value) ? value : null
}

/** launchd label, mirror of bin/bgos-agent label_for. */
export function serviceLabel(assistantId: string): string {
  return `ai.bgos.agent.${assistantId}`
}

/** systemd --user unit name, mirror of bin/bgos-agent unit_for. */
export function serviceUnit(assistantId: string): string {
  return `bgos-agent-${assistantId}`
}

/** The installed always-on service file for this assistant, or null when the
 *  platform has none (Windows) or the id is invalid. */
export function serviceFilePath(
  platform: string,
  home: string,
  assistantId: string | number | null | undefined,
): string | null {
  const id = validAssistantId(assistantId)
  if (!id) return null
  if (platform === 'darwin') {
    return join(home, 'Library', 'LaunchAgents', `${serviceLabel(id)}.plist`)
  }
  if (platform === 'linux') {
    return join(home, '.config', 'systemd', 'user', `${serviceUnit(id)}.service`)
  }
  return null
}

/** The per-agent state dir, mirror of bin/bgos-agent statedir_for. */
export function agentStateDir(
  home: string,
  assistantId: string | number | null | undefined,
): string | null {
  const id = validAssistantId(assistantId)
  return id ? join(home, '.bgos-agent', id) : null
}

export function supervisorFilePath(
  home: string,
  assistantId: string | number | null | undefined,
): string | null {
  const dir = agentStateDir(home, assistantId)
  return dir ? join(dir, SUPERVISOR_FILE) : null
}

export function restartMarkerPath(
  home: string,
  assistantId: string | number | null | undefined,
): string | null {
  const dir = agentStateDir(home, assistantId)
  return dir ? join(dir, RESTART_MARKER_FILE) : null
}

export interface LauncherSupervisor {
  pid: number
  capabilities: string[]
}

/** Parse a supervisor.json body. Fail-closed: anything malformed is null,
 *  which reads as "no launcher", never as a restart authority. */
export function parseSupervisorFile(raw: string | null): LauncherSupervisor | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null
    }
    const pid = parsed.pid
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
    const capabilities = Array.isArray(parsed.capabilities)
      ? parsed.capabilities.filter((c): c is string => typeof c === 'string')
      : []
    return { pid, capabilities }
  } catch {
    return null
  }
}

/** Is this pid alive on THIS host? Signal 0 probes without touching the
 *  process; EPERM means it exists under another user, which is still alive. */
export function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === 'EPERM'
  }
}

export interface SupervisionProbe {
  platform: string
  home: string
  assistantId: string | number | null | undefined
  exists: (path: string) => boolean
  readFile: (path: string) => string | null
  pidAlive?: (pid: number) => boolean
}

/** What would restart this daemon right now, strongest evidence first. A
 *  supervisor.json only counts when its launcher pid is still alive AND it
 *  declared the relaunch capability; a stale file is 'none', never a lie. */
export function detectSupervision(probe: SupervisionProbe): SupervisedKind {
  const service = serviceFilePath(probe.platform, probe.home, probe.assistantId)
  if (service && probe.exists(service)) {
    return probe.platform === 'darwin' ? 'launchd' : 'systemd'
  }
  const supervisorPath = supervisorFilePath(probe.home, probe.assistantId)
  if (supervisorPath) {
    const supervisor = parseSupervisorFile(probe.readFile(supervisorPath))
    if (
      supervisor &&
      supervisor.capabilities.includes('relaunch') &&
      (probe.pidAlive ?? defaultPidAlive)(supervisor.pid)
    ) {
      return 'launcher'
    }
  }
  return 'none'
}

/** The detached command that restarts this assistant's always-on service
 *  AFTER a short delay, so the daemon's 'restarting' progress report leaves
 *  the process before the restart kills it. The id and uid are validated
 *  integers and the label/unit are built from the id, so the fixed strings
 *  below have no injection surface. */
export function serviceRestartCommand(opts: {
  platform: string
  assistantId: string | number | null | undefined
  uid: number | null
}): { file: string; args: string[] } | null {
  const id = validAssistantId(opts.assistantId)
  if (!id) return null
  if (opts.platform === 'linux') {
    return {
      file: 'systemd-run',
      args: ['--user', '--on-active=2', 'systemctl', '--user', 'restart', serviceUnit(id)],
    }
  }
  if (opts.platform === 'darwin') {
    if (opts.uid === null || !Number.isInteger(opts.uid) || opts.uid < 0) return null
    return {
      file: '/bin/sh',
      args: ['-c', `sleep 2 && launchctl kickstart -k gui/${opts.uid}/${serviceLabel(id)}`],
    }
  }
  return null
}

export type RestartAuthority =
  | { kind: 'service'; command: { file: string; args: string[] } }
  | { kind: 'launcher'; markerPath: string }
  | { kind: 'staged' }

/** The restart ladder's selection (update_rpc, wire contract v1 section 3):
 *  an installed service beats the launcher beats staging. A service file
 *  with no runnable restart command (no uid on darwin) falls through to
 *  staged: staging is always safe, a bad restart never is. */
export function chooseRestartAuthority(
  probe: SupervisionProbe & { uid: number | null },
): RestartAuthority {
  const supervised = detectSupervision(probe)
  if (supervised === 'systemd' || supervised === 'launchd') {
    const command = serviceRestartCommand({
      platform: probe.platform,
      assistantId: probe.assistantId,
      uid: probe.uid,
    })
    if (command) return { kind: 'service', command }
  }
  if (supervised === 'launcher') {
    const markerPath = restartMarkerPath(probe.home, probe.assistantId)
    if (markerPath) return { kind: 'launcher', markerPath }
  }
  return { kind: 'staged' }
}
