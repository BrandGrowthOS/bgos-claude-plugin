/**
 * Update readiness: what would restart this daemon, and how the heartbeat
 * reports it (one-click updates, wire contract v1). Shared by the version
 * heartbeat (updateReadiness telemetry) and the update_rpc restart ladder
 * (which restart authority to use, lib/update-rpc.ts).
 *
 * Restart authorities, strongest first (path naming mirrors bin/bgos-agent's
 * label_for / unit_for / plist_for / unitfile_for / statedir_for):
 *   - an installed always-on service file for this assistant AT THE CANONICAL
 *     NAME bin/bgos-agent installs: launchd plist on macOS, systemd --user
 *     unit on Linux;
 *   - a loaded service-manager job DISCOVERED by asking the platform, for the
 *     agents some other launcher installed under a name of its own. See
 *     lib/service-supervision.mjs: it enumerates the loaded launchd jobs /
 *     systemd --user units and keeps the one whose own launch recipe names
 *     this agent (its state dir, or its working directory), failing closed on
 *     no match and on an ambiguous one. Without this tier, every agent not
 *     installed by bin/bgos-agent reported 'none' and the app withheld the
 *     one-click update button from a daemon its supervisor would have
 *     restarted on request;
 *   - a live launcher supervisor: bin/hoai-core.mjs writes
 *     ~/.bgos-agent/<id>/supervisor.json while its supervise loop runs and
 *     relaunches claude when ~/.bgos-agent/<id>/restart-requested.json
 *     appears. The marker's CONTENTS are ignored, existence only, so the
 *     marker can never carry commands;
 *   - none: the daemon must never exit (the kc-server invariant,
 *     lib/self-update.ts shouldExitAfterUpdate), it stages instead.
 *
 * Whichever tier answers also carries the HANDLE it was resolved by (the
 * launchd label / systemd unit), and the restart command is built from that
 * handle, so a restart always goes back through the supervisor that is
 * actually holding the agent. The supervisor then re-runs its own launch
 * recipe, in its own working directory, reading its own .mcp.json, which is
 * the property that keeps a restart from bleeding one agent's identity into
 * another (docs/learnings, fleet-restart shared-folder identity bleed).
 *
 * Pure and injectable throughout so every decision is unit-testable.
 */

import { join } from 'node:path'

import {
  resolveSupervisingService,
  serviceRestartCommandForHandle,
  type ResolvedService,
  type SyncExecResult,
} from './service-supervision.mjs'

export type { ResolvedService, SyncExecResult }

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
  /** This daemon's working directory, the anchor a discovered job is matched
   *  by (an agent's identity comes from the .mcp.json of the folder it runs
   *  in, so a job that re-runs in that folder brings back THIS agent). */
  cwd?: string | null
  /** Discovery probes. Both must be supplied for the discovery tier to run at
   *  all; without them detection falls back to the canonical name, which is
   *  the pre-discovery behaviour and is fail-closed. */
  listDir?: (path: string) => string[]
  execSync?: (file: string, args: string[]) => SyncExecResult
}

export interface Supervision {
  supervised: SupervisedKind
  /** The job a restart must go through, when one was resolved. */
  service: ResolvedService | null
}

/** The service authority installed under the canonical bin/bgos-agent name,
 *  or null. Kept as its own tier so the discovery tier below is purely
 *  additive: an agent that reported a service before still does, with the
 *  same handle, without consulting the platform at all. */
function canonicalService(probe: SupervisionProbe): ResolvedService | null {
  const file = serviceFilePath(probe.platform, probe.home, probe.assistantId)
  if (!file || !probe.exists(file)) return null
  const id = validAssistantId(probe.assistantId)
  if (!id) return null
  return probe.platform === 'darwin'
    ? { kind: 'launchd', handle: serviceLabel(id), via: 'canonical-file', file }
    : { kind: 'systemd', handle: serviceUnit(id), via: 'canonical-file', file }
}

/** What would restart this daemon right now, strongest evidence first, WITH
 *  the handle a restart must be addressed to. A supervisor.json only counts
 *  when its launcher pid is still alive AND it declared the relaunch
 *  capability; a stale file is 'none', never a lie. A discovered job only
 *  counts when the platform reports it LOADED and exactly one loaded job
 *  names this agent. */
export function resolveSupervision(probe: SupervisionProbe): Supervision {
  const canonical = canonicalService(probe)
  if (canonical) {
    return { supervised: canonical.kind === 'launchd' ? 'launchd' : 'systemd', service: canonical }
  }
  const discovered = resolveSupervisingService({
    platform: probe.platform,
    home: probe.home,
    assistantId: probe.assistantId,
    cwd: probe.cwd ?? null,
    listDir: probe.listDir,
    readFile: probe.readFile,
    execSync: probe.execSync,
  })
  if (discovered) {
    return { supervised: discovered.kind === 'launchd' ? 'launchd' : 'systemd', service: discovered }
  }
  const supervisorPath = supervisorFilePath(probe.home, probe.assistantId)
  if (supervisorPath) {
    const supervisor = parseSupervisorFile(probe.readFile(supervisorPath))
    if (
      supervisor &&
      supervisor.capabilities.includes('relaunch') &&
      (probe.pidAlive ?? defaultPidAlive)(supervisor.pid)
    ) {
      return { supervised: 'launcher', service: null }
    }
  }
  return { supervised: 'none', service: null }
}

/** The wire enum alone (heartbeat readiness). */
export function detectSupervision(probe: SupervisionProbe): SupervisedKind {
  return resolveSupervision(probe).supervised
}

/** Seconds the self-restart waits so the daemon's 'restarting' progress
 *  report leaves the process before the restart kills it. */
export const SELF_RESTART_DELAY_SECONDS = 2

/** The detached command that restarts this assistant's always-on service
 *  AFTER a short delay. `service` names the job to address; without one the
 *  canonical bin/bgos-agent label/unit for this id is used, which is what
 *  every caller did before discovery existed. A discovered handle comes off
 *  disk, so it is validated (SERVICE_HANDLE_RE) before it reaches a command
 *  line; the uid is a validated integer; nothing else is interpolated. */
export function serviceRestartCommand(opts: {
  platform: string
  assistantId: string | number | null | undefined
  uid: number | null
  service?: ResolvedService | null
}): { file: string; args: string[] } | null {
  const service = opts.service ?? null
  // serviceRestartCommandForHandle owns the handle-safety rule; a second copy
  // of it here would mask the first, so neither could be proven by a test.
  if (service) {
    return serviceRestartCommandForHandle({
      kind: service.kind,
      handle: service.handle,
      uid: opts.uid,
      delaySeconds: SELF_RESTART_DELAY_SECONDS,
    })
  }
  const id = validAssistantId(opts.assistantId)
  if (!id) return null
  if (opts.platform === 'linux') {
    return serviceRestartCommandForHandle({
      kind: 'systemd',
      handle: serviceUnit(id),
      uid: opts.uid,
      delaySeconds: SELF_RESTART_DELAY_SECONDS,
    })
  }
  if (opts.platform === 'darwin') {
    return serviceRestartCommandForHandle({
      kind: 'launchd',
      handle: serviceLabel(id),
      uid: opts.uid,
      delaySeconds: SELF_RESTART_DELAY_SECONDS,
    })
  }
  return null
}

export type RestartAuthority =
  | { kind: 'service'; command: { file: string; args: string[] } }
  | { kind: 'launcher'; markerPath: string }
  | { kind: 'staged' }

/** The restart ladder's selection (update_rpc, wire contract v1 section 3):
 *  an installed service beats the launcher beats staging. The command is
 *  addressed to the SAME job the detection resolved, so the restart goes
 *  back through the supervisor that is holding this agent and that
 *  supervisor re-runs its own launch recipe. A service with no runnable
 *  restart command (no uid on darwin) falls through to staged: staging is
 *  always safe, a bad restart never is. */
export function chooseRestartAuthority(
  probe: SupervisionProbe & { uid: number | null },
): RestartAuthority {
  const { supervised, service } = resolveSupervision(probe)
  if (supervised === 'systemd' || supervised === 'launchd') {
    const command = serviceRestartCommand({
      platform: probe.platform,
      assistantId: probe.assistantId,
      uid: probe.uid,
      service,
    })
    if (command) return { kind: 'service', command }
  }
  if (supervised === 'launcher') {
    const markerPath = restartMarkerPath(probe.home, probe.assistantId)
    if (markerPath) return { kind: 'launcher', markerPath }
  }
  return { kind: 'staged' }
}
