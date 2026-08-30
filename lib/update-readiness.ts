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
  isSafeServiceHandle,
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

/** A relaunch command a launcher declared verbatim (structured, never a shell
 *  string): file + argv, run detached to bring the session back. */
export interface DeclaredRestartCommand {
  file: string
  args: string[]
}

/** The restart authority a LAUNCHER declared to the daemon, at boot, through
 *  the daemon's own environment (BGOS_SUPERVISOR_*). This is the guess turned
 *  into a declared fact: the daemon no longer has to ASK the platform which
 *  job holds it (a query that goes dark on every bespoke, per-machine label,
 *  e.g. the legacy ai.bgos.claude.session with no per-agent id) because the
 *  thing that started it TOLD it. Trusted on its own precisely because the
 *  env can only have been set by whatever launched this process. */
export interface DeclaredSupervisor {
  kind: 'launchd' | 'systemd' | 'launcher'
  /** launchd label / systemd unit; required for launchd|systemd, null for a
   *  marker-watching launcher. */
  handle: string | null
  /** An explicit relaunch command that OVERRIDES the handle-built one (used
   *  for launchers a standard `launchctl kickstart` / `systemctl restart`
   *  cannot address). */
  restartCommand: DeclaredRestartCommand | null
}

export interface LauncherSupervisor {
  pid: number
  capabilities: string[]
  /** Present only when the body carried a valid declared authority. */
  declared?: DeclaredSupervisor
}

/** Parse the optional `supervisor` block of a supervisor.json body. Fail-closed
 *  (mirrors the whole-file posture): an unknown kind, a launchd/systemd
 *  declaration without a SAFE handle, or a malformed restartCommand all read as
 *  "no declaration" rather than a wrong authority. */
export function parseDeclaredSupervisor(value: unknown): DeclaredSupervisor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const kind = raw.kind
  if (kind !== 'launchd' && kind !== 'systemd' && kind !== 'launcher') return null
  const restartCommand = parseDeclaredRestartCommand(raw.restartCommand)
  if (restartCommand === 'invalid') return null
  if (kind === 'launchd' || kind === 'systemd') {
    const handle = typeof raw.handle === 'string' ? raw.handle.trim() : ''
    if (!handle || !isSafeServiceHandle(handle)) return null
    return { kind, handle, restartCommand }
  }
  return { kind: 'launcher', handle: null, restartCommand }
}

/** Parse a declared restart command. `null` (absent) is fine; a present-but-
 *  malformed value is 'invalid', which fails the whole declaration closed. */
function parseDeclaredRestartCommand(
  value: unknown,
): DeclaredRestartCommand | null | 'invalid' {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid'
  const raw = value as Record<string, unknown>
  const file = typeof raw.file === 'string' ? raw.file.trim() : ''
  if (!file) return 'invalid'
  if (raw.args !== undefined && !Array.isArray(raw.args)) return 'invalid'
  const args = Array.isArray(raw.args) ? raw.args : []
  if (!args.every((a) => typeof a === 'string')) return 'invalid'
  return { file, args: args as string[] }
}

/** Parse a supervisor.json body. Fail-closed: anything malformed is null,
 *  which reads as "no launcher", never as a restart authority. The optional
 *  `declared` block is only attached when it is itself valid; a body with a
 *  junk declaration still parses as a plain {pid, capabilities} launcher (or
 *  as none), never as a wrong authority. */
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
    const declared = parseDeclaredSupervisor(parsed.supervisor)
    const result: LauncherSupervisor = { pid, capabilities }
    if (declared) result.declared = declared
    return result
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

  // Read the daemon's own supervisor.json ONCE; both the declared tier below
  // and the marker-launcher tier at the end consult it.
  const supervisorPath = supervisorFilePath(probe.home, probe.assistantId)
  const supervisor = supervisorPath ? parseSupervisorFile(probe.readFile(supervisorPath)) : null
  const alive = probe.pidAlive ?? defaultPidAlive

  // Declared SERVICE authority: the launcher told THIS daemon, at boot, which
  // service-manager job holds it (BGOS_SUPERVISOR_*, written by the boot
  // writer below). This is the guess turned into a declared fact, and it
  // stands on its own without the platform query agreeing, which is the whole
  // point: the query goes dark on the bespoke per-machine labels this fixes.
  // It counts only while the declaring daemon's pid is alive, so a stale file
  // from a crashed daemon reads as no authority, never as a lie (the fresh
  // daemon rewrites it at its next boot).
  if (
    supervisor?.declared &&
    (supervisor.declared.kind === 'launchd' || supervisor.declared.kind === 'systemd') &&
    supervisor.declared.handle &&
    isSafeServiceHandle(supervisor.declared.handle) &&
    alive(supervisor.pid)
  ) {
    const service: ResolvedService = {
      kind: supervisor.declared.kind,
      handle: supervisor.declared.handle,
      via: 'declared',
      file: null,
      ...(supervisor.declared.restartCommand
        ? { restartCommand: supervisor.declared.restartCommand }
        : {}),
    }
    return { supervised: supervisor.declared.kind, service }
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

  // A live marker-watching launcher (the hoai supervise loop, or a launcher
  // that declared kind:'launcher'): a supervisor.json that declares the
  // 'relaunch' capability and whose pid is still alive.
  if (
    supervisor &&
    supervisor.capabilities.includes('relaunch') &&
    alive(supervisor.pid)
  ) {
    return { supervised: 'launcher', service: null }
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

/** Wrap a launcher-declared relaunch command so it runs AFTER a short delay
 *  (the same report-flush window serviceRestartCommandForHandle uses). The
 *  declared file+args are passed to `sh` as POSITIONAL parameters ($0 $@),
 *  never spliced into the command string, so nothing user-declared is ever
 *  interpreted by the shell: injection-safe by construction. Delay 0 (or a
 *  bad file) runs the command verbatim / returns null. */
export function delayedDeclaredCommand(
  command: { file: string; args: string[] } | null | undefined,
  delaySeconds: number,
): { file: string; args: string[] } | null {
  if (!command || typeof command.file !== 'string' || command.file.trim().length === 0) {
    return null
  }
  const file = command.file
  const args = Array.isArray(command.args)
    ? command.args.filter((a): a is string => typeof a === 'string')
    : []
  const delay = Number.isInteger(delaySeconds) && delaySeconds > 0 ? delaySeconds : 0
  if (delay > 0) {
    return { file: '/bin/sh', args: ['-c', `sleep ${delay} && exec "$0" "$@"`, file, ...args] }
  }
  return { file, args }
}

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
    // A launcher-declared explicit command wins: it is how a supervisor that a
    // standard `launchctl kickstart` / `systemctl restart` cannot address says
    // exactly how to bring the session back.
    if (service?.restartCommand) {
      const declared = delayedDeclaredCommand(service.restartCommand, SELF_RESTART_DELAY_SECONDS)
      if (declared) return { kind: 'service', command: declared }
    }
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

// -- The boot writer: declare the supervisor as a fact -------------------------
//
// NOTHING wrote supervisor.json on the fleet (checked: 0 of 8 agents had one),
// so every agent fell back to the platform guess, which cannot resolve a
// bespoke per-machine label (the legacy ai.bgos.claude.session), so the update
// could not find a restart authority and either sat in restart-pending limbo
// or fired a restart at the wrong job. The fix is to have the daemon WRITE its
// supervisor.json at boot, turning the guess into a declared fact whenever the
// launcher cooperates. Pure decision here; the disk write is server.ts.

/** The environment a launcher sets to declare what supervises this session.
 *  Only the process that started the daemon can set its env, so a declaration
 *  carried here is trusted on its own. */
export const SUPERVISOR_ENV_KIND = 'BGOS_SUPERVISOR_KIND'
export const SUPERVISOR_ENV_HANDLE = 'BGOS_SUPERVISOR_HANDLE'
export const SUPERVISOR_ENV_RESTART_CMD = 'BGOS_SUPERVISOR_RESTART_CMD'

/**
 * The declared supervisor a launcher put in the environment, or null.
 *
 * Contract:
 *   BGOS_SUPERVISOR_KIND        launchd | systemd | launcher (required to
 *                               declare anything; absent => null, use detection)
 *   BGOS_SUPERVISOR_HANDLE      the launchd label / systemd unit; REQUIRED and
 *                               SERVICE_HANDLE_RE-safe for launchd|systemd,
 *                               ignored for launcher
 *   BGOS_SUPERVISOR_RESTART_CMD OPTIONAL JSON {"file":string,"args":string[]},
 *                               an explicit relaunch command
 *
 * Fail-closed: an unknown kind, a launchd/systemd declaration without a safe
 * handle, or a present-but-malformed restart command all return null. A caller
 * distinguishes "no env" from "bad env" by re-checking BGOS_SUPERVISOR_KIND, so
 * a bad declaration writes NOTHING rather than a wrong file.
 */
export function parseDeclaredSupervisorEnv(
  env: Record<string, string | undefined>,
): DeclaredSupervisor | null {
  const kind = (env[SUPERVISOR_ENV_KIND] ?? '').trim()
  if (!kind) return null
  if (kind !== 'launchd' && kind !== 'systemd' && kind !== 'launcher') return null
  const restartCommand = parseDeclaredRestartCommand(
    parseRestartCmdEnvValue(env[SUPERVISOR_ENV_RESTART_CMD]),
  )
  if (restartCommand === 'invalid') return null
  if (kind === 'launchd' || kind === 'systemd') {
    const handle = (env[SUPERVISOR_ENV_HANDLE] ?? '').trim()
    if (!handle || !isSafeServiceHandle(handle)) return null
    return { kind, handle, restartCommand }
  }
  return { kind: 'launcher', handle: null, restartCommand }
}

/** Turn the raw BGOS_SUPERVISOR_RESTART_CMD string into the value
 *  parseDeclaredRestartCommand expects: absent/empty => undefined (no
 *  command), otherwise the parsed JSON, or a sentinel that fails closed. */
function parseRestartCmdEnvValue(raw: string | undefined): unknown {
  if (raw === undefined || raw.trim().length === 0) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return { __invalid__: true }
  }
}

/** Is the declaring daemon's own pid the natural liveness anchor for the file
 *  it writes; the marker capability is declared only for a marker-watching
 *  launcher, never for a service manager (a launchd/systemd job is restarted
 *  by the manager, not by anyone watching the marker, so declaring 'relaunch'
 *  for it would make the marker tier and the cross-agent watcher misread it as
 *  a marker launcher). */
export function buildDeclaredSupervisorBody(opts: {
  declared: DeclaredSupervisor
  pid: number
  startedAt: string
}): string {
  const { declared, pid, startedAt } = opts
  const capabilities = declared.kind === 'launcher' ? ['relaunch'] : []
  const supervisor: Record<string, unknown> = { kind: declared.kind }
  if (declared.handle) supervisor.handle = declared.handle
  if (declared.restartCommand) supervisor.restartCommand = declared.restartCommand
  return JSON.stringify({ pid, capabilities, startedAt, supervisor })
}

export type SupervisorWriteDecision =
  | { action: 'write'; body: string; reason: string }
  | { action: 'skip'; reason: string }

/**
 * Whether (and what) to write to supervisor.json at daemon boot. Pure so the
 * whole decision is unit-testable; the caller (server.ts) does the disk write.
 *
 * The order encodes the safety rules:
 *   1. NEVER clobber a supervisor.json a DIFFERENT, still-live supervisor owns
 *      (a running hoai supervise loop, or another process): its authority is
 *      real and the marker/singleton machinery depends on its pid staying in
 *      the file. Skip.
 *   2. If the launcher DECLARED a supervisor in the env, write that fact. A
 *      present-but-malformed declaration writes NOTHING (a wrong file is worse
 *      than none).
 *   3. Otherwise fall back to detection: write the file only when detection
 *      resolved a CONFIDENT service (launchd/systemd) authority; write nothing
 *      for a marker launcher (its own launcher already owns the file) or none.
 */
export function decideSupervisorWrite(input: {
  env: Record<string, string | undefined>
  existingRaw: string | null
  ownPid: number
  startedAt: string
  detection: Supervision
  pidAlive?: (pid: number) => boolean
}): SupervisorWriteDecision {
  const alive = input.pidAlive ?? defaultPidAlive
  const existing = parseSupervisorFile(input.existingRaw)
  if (
    existing &&
    existing.pid !== input.ownPid &&
    (existing.capabilities.includes('relaunch') || existing.declared !== undefined) &&
    alive(existing.pid)
  ) {
    return { action: 'skip', reason: 'live-supervisor-owns' }
  }

  const kindPresent = (input.env[SUPERVISOR_ENV_KIND] ?? '').trim().length > 0
  if (kindPresent) {
    const declared = parseDeclaredSupervisorEnv(input.env)
    if (!declared) return { action: 'skip', reason: 'invalid-env' }
    return {
      action: 'write',
      body: buildDeclaredSupervisorBody({ declared, pid: input.ownPid, startedAt: input.startedAt }),
      reason: 'env-declared',
    }
  }

  const { supervised, service } = input.detection
  if ((supervised === 'launchd' || supervised === 'systemd') && service && isSafeServiceHandle(service.handle)) {
    const declared: DeclaredSupervisor = { kind: supervised, handle: service.handle, restartCommand: null }
    return {
      action: 'write',
      body: buildDeclaredSupervisorBody({ declared, pid: input.ownPid, startedAt: input.startedAt }),
      reason: `detected-${supervised}`,
    }
  }
  return { action: 'skip', reason: 'no-confident-authority' }
}
