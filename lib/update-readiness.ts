/**
 * Update readiness: what would restart this daemon, and how the heartbeat
 * reports it (one-click updates, wire contract v1). Shared by the version
 * heartbeat (updateReadiness telemetry) and the update_rpc restart ladder
 * (which restart authority to use, lib/update-rpc.ts).
 *
 * Restart authorities, strongest first (path naming mirrors bin/bgos-agent's
 * label_for / unit_for / plist_for / unitfile_for / statedir_for):
 *   - a live KEEPALIVE script that declared itself in
 *     ~/.bgos-agent/<id>/keepalive.json (bin/hoai-keepalive-marker.mjs). It
 *     goes first because it is the only tier whose ownership is PROVEN when it
 *     is resolved: the declaring pid must be alive AND the claude session it
 *     declares must be one of this process's own ancestors. Every tier below
 *     is a NAME whose ownership is only checked later, in lib/update-rpc.ts.
 *     Without this tier the keepalive-launched agents (a launchd job running a
 *     script that starts claude in a detached tmux) had no authority the
 *     ownership rule would accept, and a one-click update on them could only
 *     ever end in restart-pending limbo;
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
 * A service tier is only an authority when the job it names HOLDS this
 * process: its main pid must be an ancestor of ours. The 2026-09-11 forced
 * update muted 9 of 21 daemons because their declared launchd job was a
 * keepalive SCRIPT that had started a detached tmux; the job's pid was nowhere
 * in the daemon's ancestry, the kickstart killed nothing, and the drained
 * daemon sat deaf. serviceOwnsProcess / probeServiceOwnership below are that
 * check; lib/update-rpc.ts refuses such a job before draining.
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
 *  / KEEPALIVE_MARKER_FILE_NAME (pinned by test/update-readiness.test.ts,
 *  which imports both sides). */
export const SUPERVISOR_FILE = 'supervisor.json'
export const RESTART_MARKER_FILE = 'restart-requested.json'
export const KEEPALIVE_MARKER_FILE = 'keepalive.json'

/** The supervisor kinds this daemon reasons with. 'keepalive' is INTERNAL: it
 *  is the tier below, and it is mapped to the nearest wire value by
 *  wireSupervisedKind before a heartbeat carries it (see that function for the
 *  measured reason). The rest are the wire enum for
 *  updateReadiness.supervised; supervise-npm and pm2 belong to other channel
 *  daemons sharing the contract. */
export type SupervisedKind =
  | 'systemd'
  | 'launchd'
  | 'launcher'
  | 'keepalive'
  | 'supervise-npm'
  | 'pm2'
  | 'none'

/**
 * What a 'keepalive' supervision reports on the wire.
 *
 * Measured 2026-09-13 before choosing it: the backend's
 * UPDATE_SUPERVISED_MODES (backend/src/integrations/pairing-update-state.ts)
 * has no 'keepalive', and sanitizeUpdateReadiness maps anything outside that
 * list to 'none' rather than 400ing. The app then gates the one-click button
 * on `supervised !== "none"` (frontend updateStateModel.ts isOneClickEligible).
 * So sending the honest new token today would take the update button AWAY from
 * exactly the sessions this tier makes restartable, which is worse than the bug
 * it fixes. 'launcher' is the truthful neighbour: a live launcher process that
 * relaunches this session, which is precisely what a keepalive is.
 *
 * To make 'keepalive' visible end to end: add it to UPDATE_SUPERVISED_MODES
 * (backend) and to PairingUpdateReadiness.supervised (frontend
 * queries/integrationPairingsQuery.ts), then flip this one constant.
 */
export const KEEPALIVE_WIRE_SUPERVISED: SupervisedKind = 'launcher'

/** The wire value for a resolved supervision kind. */
export function wireSupervisedKind(kind: SupervisedKind): SupervisedKind {
  return kind === 'keepalive' ? KEEPALIVE_WIRE_SUPERVISED : kind
}

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

export function keepaliveMarkerPath(
  home: string,
  assistantId: string | number | null | undefined,
): string | null {
  const dir = agentStateDir(home, assistantId)
  return dir ? join(dir, KEEPALIVE_MARKER_FILE) : null
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

/**
 * What a keepalive script declares in ~/.bgos-agent/<id>/keepalive.json every
 * time it launches the session (bin/hoai-keepalive-marker.mjs writes it,
 * bin/hoai-core.mjs keepaliveMarkerBody builds it).
 *
 *   pid         the keepalive script's own pid, the thing that promises the
 *               relaunch; it must still be ALIVE for the promise to stand
 *   claudePid   the claude session it launched. This is the binding that makes
 *               the marker OURS and the process a restart has to signal
 *   tmuxSession the pane name, for the log line only; never acted on
 *
 * The pids are the whole contract, so both are validated as integers above 1
 * (pid 1 is init: it is everyone's ancestor and it restarts no one).
 */
export interface KeepaliveMarker {
  pid: number
  claudePid: number
  tmuxSession: string | null
}

function positivePid(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 1 ? value : null
}

/**
 * Parse a keepalive.json body. Fail-closed exactly like parseSupervisorFile:
 * anything malformed is null, which reads as "no keepalive" and falls through
 * to the older tiers, never as a restart authority. `kind` is required so a
 * file that is not this contract can never be misread as one, and the
 * 'relaunch' capability is the explicit promise: a script that writes the
 * marker without it is saying it will NOT bring the session back.
 */
export function parseKeepaliveMarker(raw: string | null | undefined): KeepaliveMarker | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (parsed.kind !== 'keepalive') return null
  const capabilities = Array.isArray(parsed.capabilities) ? parsed.capabilities : []
  if (!capabilities.includes('relaunch')) return null
  const pid = positivePid(parsed.pid)
  const claudePid = positivePid(parsed.claudePid)
  if (pid === null || claudePid === null) return null
  // The one free-text field, and it reaches a daemon log line, so it is
  // whitespace-collapsed and capped: nothing here is ever acted on, but a
  // newline in it would split a log line in two.
  const declared = typeof parsed.tmuxSession === 'string' ? parsed.tmuxSession : ''
  const tmuxSession = declared.replace(/\s+/g, ' ').trim().slice(0, 64)
  return { pid, claudePid, tmuxSession: tmuxSession || null }
}

/**
 * Does the keepalive this marker describes actually hold THIS process?
 *
 * The rule the 2026-09-11 mute teaches is that an authority only counts when
 * it can reach us, and the reading that proves it is our own pid ancestry. For
 * a keepalive the ancestry link is the SESSION it launched, not the script
 * itself: measured on KC's Mac on 2026-09-13, a session chains
 * claude > expect > tmux server > launchd, because the keepalive starts claude
 * inside a DETACHED tmux and then only waits on it. The keepalive's own pid is
 * in nobody's ancestry, so requiring it there would reject every real case, and
 * a check that can only say no is not a check. The claude pid it declares IS
 * our ancestor, and it is also the pid the restart signals, so it is both the
 * proof and the target.
 *
 * It is the declared SESSION pid that must be in the chain, and nothing else is
 * accepted in its place: the pid we prove has to be the pid we signal. A marker
 * whose own script pid is an ancestor cannot vouch for a claudePid that is not
 * one, or a writer that raced and recorded the wrong session would have the
 * daemon SIGTERM an unrelated process and restart nothing. An exec-chain
 * keepalive (one that really is our parent) still binds, because the claude it
 * launched is our ancestor too. A marker written by ANOTHER agent's keepalive
 * names a session we do not descend from, so it is refused.
 */
export function keepaliveOwnsProcess(
  ancestorPids: number[],
  marker: KeepaliveMarker | null | undefined,
): boolean {
  if (!marker || !Array.isArray(ancestorPids) || ancestorPids.length === 0) return false
  // STRICT ancestor: readProcessAncestry puts self first, and the invariant the
  // restart needs is "killing this pid takes this process with it". Our own pid
  // fails that: signalling ourselves kills the daemon while claude lives on, so
  // the keepalive never relaunches and the agent is simply gone.
  return ancestorPids.slice(1).some((pid) => pid === marker.claudePid)
}

/** The process name a keepalive's declared session must have. */
export const KEEPALIVE_SESSION_COMM = 'claude'

/**
 * Is the process the marker points at actually a claude SESSION?
 *
 * Being an ancestor is necessary and NOT sufficient, because ancestry is not
 * private to one session. Measured on KC's Mac on 2026-09-13: a single tmux
 * server (pid 798) is a strict ancestor of every agent on the host, so a marker
 * naming 798 would bind to all nine daemons at once and the restart would
 * SIGTERM the tmux server, killing the whole fleet mid-turn from one agent's
 * update. The same is true of any shared wrapper. So the target must also BE
 * what the marker claims it is: a claude process. `ps -o comm=` prints either a
 * bare name or the absolute path the binary was launched by, so the comparison
 * is on the basename.
 *
 * Fail-closed: an unreadable or unexpected name is refused, never assumed. A
 * claude hosted under another process name (the node-hosted install
 * bin/bgos-agent's run.sh already documents as undetectable) therefore gets no
 * keepalive tier and falls back to the older rules, which is the pre-keepalive
 * behaviour and safe.
 */
export function isKeepaliveSessionProcess(comm: string | null | undefined): boolean {
  if (typeof comm !== 'string') return false
  const name = comm.trim()
  if (!name) return false
  const base = name.slice(name.lastIndexOf('/') + 1)
  return base === KEEPALIVE_SESSION_COMM
}

/** `ps -o comm= -p <pid>` prints exactly one line; anything else is null. */
export function parseCommOutput(stdout: string): string | null {
  const text = String(stdout ?? '').trim()
  if (!text || text.includes('\n')) return null
  return text
}

/** The process name of `pid`, or null when ps could not answer. */
export function readProcessComm(
  pid: number,
  execSync: (file: string, args: string[]) => SyncExecResult,
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const result = execSync('ps', ['-o', 'comm=', '-p', String(pid)])
  return result.code === 0 ? parseCommOutput(result.stdout) : null
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
  /** This process's own pid, the anchor of the ancestry walk the keepalive
   *  tier proves ownership with. REQUIRED for that tier: without it there is
   *  no chain to check a marker against, so the tier does not fire at all
   *  (fail-closed, and the pre-keepalive behaviour is unchanged). */
  ownPid?: number
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
  /** The keepalive that holds this session, when one was proven. */
  keepalive?: KeepaliveMarker | null
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
/**
 * The keepalive that holds this session, or null. Three things must all hold,
 * and each one is a separate reading:
 *   1. a marker parses (the script declared a relaunch promise at all),
 *   2. the declaring script is still ALIVE (a stale file from a keepalive that
 *      has exited promises nothing),
 *   3. the session the marker names is one of OUR ancestors (this marker is
 *      about this process, not about the agent next door).
 * Any of them missing is null, which falls through to the tiers below exactly
 * as if no marker existed.
 */
export function resolveKeepalive(probe: SupervisionProbe): KeepaliveMarker | null {
  const execSync = probe.execSync
  const ownPid = probe.ownPid
  if (!execSync || typeof ownPid !== 'number' || !Number.isInteger(ownPid) || ownPid <= 0) {
    return null
  }
  const path = keepaliveMarkerPath(probe.home, probe.assistantId)
  if (!path) return null
  const marker = parseKeepaliveMarker(probe.readFile(path))
  if (!marker) return null
  const alive = probe.pidAlive ?? defaultPidAlive
  if (!alive(marker.pid)) return null
  if (!keepaliveOwnsProcess(readProcessAncestry(ownPid, execSync), marker)) return null
  // Ancestry alone is not identity: one tmux server is an ancestor of every
  // session on the host. The declared pid must also BE a claude session, or a
  // marker naming a shared ancestor would have us signal it. Read last, so the
  // extra ps only happens for a marker that already passed everything else.
  return isKeepaliveSessionProcess(readProcessComm(marker.claudePid, execSync)) ? marker : null
}

export function resolveSupervision(probe: SupervisionProbe): Supervision {
  // The keepalive tier goes FIRST because it is the only one whose ownership
  // is PROVEN at resolve time (a live script plus an ancestry walk). Every
  // service tier below is a name that is only checked for ownership later, in
  // lib/update-rpc.ts, and on these sessions it resolves to a launchd job that
  // holds nothing: that is the 2026-09-11 mute and tonight's nine 'restart
  // pending' sessions. A proven authority must not lose to an unproven one.
  //
  // It resolves with NO service, deliberately. server.ts publishes the
  // resolved service to ~/.bgos-agent/<id>/service.json for the per-machine
  // watcher, and a record naming the keepalive's launchd job would invite the
  // watcher to `launchctl kickstart -k` it, which kills the keepalive script
  // (not the session), restarts nothing, and leaves the marker stale.
  const keepalive = resolveKeepalive(probe)
  if (keepalive) return { supervised: 'keepalive', service: null, keepalive }

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

/** The service-manager job a service authority was resolved by: what the
 *  restart command is addressed to, and what the ownership check is asked
 *  about (probeServiceOwnership). */
export interface RestartAuthorityService {
  kind: 'launchd' | 'systemd'
  handle: string
}

export type RestartAuthority =
  | { kind: 'service'; service: RestartAuthorityService; command: { file: string; args: string[] } }
  | { kind: 'launcher'; markerPath: string }
  /** A live keepalive script: SIGTERM `sessionPid` and it relaunches the
   *  session on the new version. No command, no handle, nothing to kickstart. */
  | { kind: 'keepalive'; sessionPid: number; keepalivePid: number; tmuxSession: string | null }
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
  const { supervised, service, keepalive } = resolveSupervision(probe)
  // A proven keepalive first, same order as the detection above: the restart
  // is a signal to the session it declared, which resolveKeepalive has already
  // shown to be one of our own ancestors.
  if (supervised === 'keepalive' && keepalive) {
    return {
      kind: 'keepalive',
      sessionPid: keepalive.claudePid,
      keepalivePid: keepalive.pid,
      tmuxSession: keepalive.tmuxSession,
    }
  }
  // Every service tier resolves WITH the job it found (canonical, declared,
  // discovered). Without one there is no handle to address a restart to or to
  // verify ownership against, so it is no authority: staged.
  if ((supervised === 'systemd' || supervised === 'launchd') && service) {
    const resolved: RestartAuthorityService = { kind: service.kind, handle: service.handle }
    // A launcher-declared explicit command wins: it is how a supervisor that a
    // standard `launchctl kickstart` / `systemctl restart` cannot address says
    // exactly how to bring the session back.
    if (service.restartCommand) {
      const declared = delayedDeclaredCommand(service.restartCommand, SELF_RESTART_DELAY_SECONDS)
      if (declared) return { kind: 'service', service: resolved, command: declared }
    }
    const command = serviceRestartCommand({
      platform: probe.platform,
      assistantId: probe.assistantId,
      uid: probe.uid,
      service,
    })
    if (command) return { kind: 'service', service: resolved, command }
  }
  if (supervised === 'launcher') {
    const markerPath = restartMarkerPath(probe.home, probe.assistantId)
    if (markerPath) return { kind: 'launcher', markerPath }
  }
  return { kind: 'staged' }
}

// -- Ownership: does the resolved job actually hold this process? ------------
//
// A service authority is addressed to a launchd label / systemd unit, and the
// restart is `launchctl kickstart -k` / `systemctl --user restart` on it. That
// only replaces THIS process when this process is inside that job. On the
// 2026-09-11 forced update, nine daemons' declared job was a keepalive SCRIPT
// that had started a detached tmux server: the job's main pid was nowhere in
// the daemon's ancestry, the kickstart re-ran a script whose singleton guard
// saw the session alive and waited, nothing died, and the daemon (already
// drained, 'restarting' already reported) sat deaf for 50 minutes. Two raw
// readings decide it, both pure to parse and injectable to take: this
// process's pid ancestry (ps -o ppid= walked to 1) and the job's main pid
// (launchctl print's `pid = N` / systemctl show's `MainPID=N`).

/** A ppid walk never needs more than a handful of hops; the bound is against
 *  a ps that lies (a cycle is caught separately). */
export const ANCESTRY_MAX_DEPTH = 64

/** Does the service-manager job with main pid `servicePid` own this process,
 *  i.e. is that pid in `ancestorPids` (self first, then parents up to 1)?
 *  Fail-closed on every non-answer: no pid (the job is not running), an
 *  empty ancestry (ps could not be read), or pid 1 (init is everyone's
 *  ancestor and restarts no one). */
export function serviceOwnsProcess(ancestorPids: number[], servicePid: number | null): boolean {
  if (servicePid === null || !Number.isInteger(servicePid) || servicePid <= 1) return false
  if (!Array.isArray(ancestorPids)) return false
  return ancestorPids.some((pid) => pid === servicePid)
}

/** `ps -o ppid= -p <pid>` prints one integer (leading spaces on some ps
 *  builds); anything else is null. */
export function parsePpidOutput(stdout: string): number | null {
  const match = /^\s*(\d+)\s*$/.exec(String(stdout ?? ''))
  if (!match) return null
  const ppid = Number(match[1])
  return Number.isSafeInteger(ppid) ? ppid : null
}

/** This process's pid ancestry, self first, up to pid 1 or the first link ps
 *  cannot read (a ppid of 0 is the kernel, also the end). Bounded and
 *  cycle-safe, because a reading that gates an update must not hang it. */
export function readProcessAncestry(
  ownPid: number,
  execSync: (file: string, args: string[]) => SyncExecResult,
  maxDepth: number = ANCESTRY_MAX_DEPTH,
): number[] {
  const chain: number[] = []
  const seen = new Set<number>()
  let pid = ownPid
  while (chain.length < maxDepth) {
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) break
    seen.add(pid)
    chain.push(pid)
    if (pid === 1) break
    const result = execSync('ps', ['-o', 'ppid=', '-p', String(pid)])
    if (result.code !== 0) break
    const ppid = parsePpidOutput(result.stdout)
    if (ppid === null || ppid === 0) break
    pid = ppid
  }
  return chain
}

/** The `pid = N` line of `launchctl print gui/<uid>/<label>`. A loaded job
 *  that is not running prints no pid line; an unknown label prints an error;
 *  both are null. */
export function parseLaunchctlPrintPid(stdout: string): number | null {
  const match = /^\s*pid = (\d+)\s*$/m.exec(String(stdout ?? ''))
  if (!match) return null
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/** `MainPID=N` from `systemctl --user show -p MainPID <unit>`; 0 is what an
 *  inactive unit reports, so it is null. */
export function parseSystemctlMainPid(stdout: string): number | null {
  const match = /^MainPID=(\d+)\s*$/m.exec(String(stdout ?? ''))
  if (!match) return null
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/** The main pid of the job `handle`, or null when it is not running, unknown,
 *  unaddressable (no uid for a launchd gui domain) or unsafe to put on a
 *  command line. Null always reads as "does not own us". */
export function readServiceMainPid(opts: {
  kind: 'launchd' | 'systemd'
  handle: string
  uid: number | null
  execSync: (file: string, args: string[]) => SyncExecResult
}): number | null {
  if (!isSafeServiceHandle(opts.handle)) return null
  if (opts.kind === 'launchd') {
    const uid = opts.uid
    if (uid === null || !Number.isInteger(uid) || uid < 0) return null
    const result = opts.execSync('launchctl', ['print', `gui/${uid}/${opts.handle}`])
    return result.code === 0 ? parseLaunchctlPrintPid(result.stdout) : null
  }
  const result = opts.execSync('systemctl', ['--user', 'show', '-p', 'MainPID', opts.handle])
  return result.code === 0 ? parseSystemctlMainPid(result.stdout) : null
}

/** The two raw readings the ownership decision is made from. Raw on purpose:
 *  the handler decides with serviceOwnsProcess and logs both pids, so a
 *  refusal names what was declared and what actually holds the process. */
export interface ServiceOwnershipReading {
  ownPid: number
  ancestorPids: number[]
  servicePid: number | null
}

export function probeServiceOwnership(opts: {
  ownPid: number
  service: RestartAuthorityService
  uid: number | null
  execSync: (file: string, args: string[]) => SyncExecResult
}): ServiceOwnershipReading {
  return {
    ownPid: opts.ownPid,
    ancestorPids: readProcessAncestry(opts.ownPid, opts.execSync),
    servicePid: readServiceMainPid({
      kind: opts.service.kind,
      handle: opts.service.handle,
      uid: opts.uid,
      execSync: opts.execSync,
    }),
  }
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
