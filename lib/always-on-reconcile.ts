/**
 * The always-on reconcile decision (server.ts reconcileAlwaysOn), pure.
 *
 * WHY (design G11, 2026-10-06). "Installed" used to mean `bgos-agent
 * is-installed`, which checks only the CANONICAL service file
 * (ai.bgos.agent.<id> / bgos-agent-<id>). An agent already kept alive by
 * something else, this Mac's bespoke `ai.bgos.session.<id>` keepalive jobs or
 * a hand-written systemd unit on kc-server, therefore got a SECOND supervisor
 * from its own daemon the moment always_on turned true. Two supervisors then
 * race to relaunch the same agent: the second waits behind the first, takes
 * over when the first ends a session, and the agent comes back twice. Turning
 * on "Keep agents running" for a computer sets always_on for every agent on
 * it, so the switch would have triggered this on every bespoke agent at once.
 *
 * The fix asks, before installing, whether ANOTHER live, reboot-surviving
 * supervisor already holds the agent (readAlwaysOnSupervision). What counts:
 *   - a keepalive.json whose script is alive (the watcher's keepaliveDeclared
 *     rule, lib/agent-inventory.mjs readDeclaredKeepalive);
 *   - a service-manager job found by discovery (lib/service-supervision.mjs:
 *     a loaded launchd job / systemd --user unit whose recipe names this
 *     agent's state dir or working directory), however many there are;
 *   - a declared service-manager job (supervisor.json written at boot), while
 *     that job is LOADED. A daemon that discovered a bespoke job at boot
 *     writes it there (decideSupervisorWrite 'detected-launchd'), so ignoring
 *     it would leave G11 open for exactly the agents it is about.
 * A job whose handle IS the canonical label/unit is ours, not another one: a
 * supervisor.json declared from the canonical job keeps naming it after
 * `bgos-agent uninstall` removed the file, and it must never block its own
 * reinstall. A live hoai launcher (supervisor.json 'launcher') does NOT count:
 * it relaunches claude on request but does not survive a reboot, which is the
 * whole point of always-on, so the canonical supervisor is still installed.
 *
 * Why not the update ladder's detection (lib/update-readiness.ts
 * resolveSupervision) as it stands (code review F3, F4, F5, 2026-10-07). It
 * answers "who can restart me", and for that question failing closed to
 * "nobody" is right. For G11 "nobody" means INSTALL, and a second supervisor
 * stays for good (the next cycle sees the canonical file and leaves it):
 *   F3  its keepalive tier needs the marker's claude to be our ancestor, which
 *       aims a SIGTERM. A looping keepalive rewrites the marker only seconds
 *       after it relaunched claude, and the boot reconcile runs first, so the
 *       relaunch promise is real while the proof is not yet.
 *   F4  a failed or timed out job listing, and a tie between two loaded jobs
 *       naming the agent, both resolve to no service. A tie is two other
 *       supervisors, and an unreadable listing is "could not tell": the
 *       reconcile now WAITS for the next cycle instead of installing.
 *   F5  its declared tier counts while supervisor.json's pid is alive, and
 *       that pid is the daemon's own. A bespoke job booted out and deleted
 *       under a live tmux session kept every reconcile deferring to nothing.
 * Install happens only on a definite answer: the job list was read and no job
 * other than ours names this agent.
 *
 * Removal on always_on=false is unchanged and touches only the canonical
 * supervisor: a bespoke job was installed by someone else, for their reasons.
 */

import { readDeclaredKeepalive } from './agent-inventory.mjs'
import {
  listLoadedJobs,
  parseLaunchctlList,
  parseSystemctlUnitList,
  resolveSupervisingService,
} from './service-supervision.mjs'
import {
  defaultPidAlive,
  parseSupervisorFile,
  resolveKeepalive,
  serviceLabel,
  serviceUnit,
  supervisorFilePath,
  type SupervisionProbe,
  type SyncExecResult,
  validAssistantId,
} from './update-readiness.js'

/** The other supervisor a reconcile deferred to. `via` is the evidence. */
export interface OtherSupervisor {
  kind: 'keepalive' | 'launchd' | 'systemd'
  /** The launchd label / systemd unit, or the keepalive's tmux session name
   *  (log only, never acted on); null when none was declared. */
  handle: string | null
  via: 'keepalive-marker' | 'keepalive-declared' | 'state-dir' | 'working-directory' | 'declared'
}

/** What the G11 reading found: another supervisor, a definite none, or a
 *  question the machine could not answer this time. */
export type AlwaysOnSupervision =
  | { state: 'other'; other: OtherSupervisor }
  | { state: 'none' }
  | { state: 'unknown'; reason: 'listing-unreadable' | 'error' }

export type AlwaysOnReconcileDecision =
  | { action: 'install' }
  | { action: 'remove' }
  | { action: 'leave' }
  | { action: 'defer'; other: OtherSupervisor }
  | { action: 'wait'; reason: 'listing-unreadable' | 'error' | 'unread' }

/** Is `handle` this agent's canonical bin/bgos-agent job? systemd discovery
 *  reports `<unit>.service`, the canonical name has no suffix, so the suffix
 *  is dropped before comparing. */
function isCanonicalHandle(kind: 'launchd' | 'systemd', handle: string, assistantId: string | null): boolean {
  if (!assistantId) return false
  if (kind === 'launchd') return handle === serviceLabel(assistantId)
  return handle.replace(/\.service$/, '') === serviceUnit(assistantId)
}

/** The exact listing commands lib/service-supervision.mjs runs, so the memo
 *  below serves both from one call. */
const LAUNCHD_LIST: [string, string[]] = ['launchctl', ['list']]
const SYSTEMD_LIST: [string, string[]] = ['systemctl', ['--user', 'list-units', '--type=service', '--all', '--no-legend', '--plain']]

/** One reading, one listing: every identical call inside it is answered once. */
function memoExec(exec: (file: string, args: string[]) => SyncExecResult) {
  const seen = new Map<string, SyncExecResult>()
  return (file: string, args: string[]): SyncExecResult => {
    const key = [file, ...args].join('\u0000')
    const hit = seen.get(key)
    if (hit) return hit
    const result = exec(file, args)
    seen.set(key, result)
    return result
  }
}

/** The loaded handles, or null when the listing could not be read. A real
 *  launchd domain and a real systemd --user manager are never empty, so an
 *  empty listing is a failed one (lib/service-supervision.mjs reads it so). */
function loadedHandles(platform: string, exec: (file: string, args: string[]) => SyncExecResult): Set<string> | null {
  const [file, args] = platform === 'darwin' ? LAUNCHD_LIST : SYSTEMD_LIST
  const result = exec(file, args)
  if (result.code !== 0) return null
  const loaded = platform === 'darwin' ? parseLaunchctlList(result.stdout) : parseSystemctlUnitList(result.stdout)
  return loaded.size > 0 ? loaded : null
}

/**
 * Is this agent already kept alive by a live, reboot-surviving supervisor
 * other than the canonical one? Read for the reconcile's install row only.
 * Never throws: an unexpected failure is unknown, which waits.
 */
export function readAlwaysOnSupervision(probe: SupervisionProbe): AlwaysOnSupervision {
  try {
    const id = validAssistantId(probe.assistantId)
    const alive = probe.pidAlive ?? defaultPidAlive
    // A keepalive whose script is alive has promised a relaunch (F3). The
    // proven tier only names it better in the log. The exec is what lets the
    // watcher's reuse rule (F6) run here too: without a ps table a retired
    // script's pid, reused after a reboot by a root daemon, read as the script
    // and deferred every reconcile to nothing (delta review F1).
    const declaredKeepalive = id
      ? readDeclaredKeepalive({
          platform: probe.platform,
          home: probe.home,
          assistantId: id,
          readFile: probe.readFile,
          pidAlive: alive,
          execSync: probe.execSync,
          uid: probe.uid,
        })
      : null
    if (declaredKeepalive) {
      const proven = resolveKeepalive(probe)
      return {
        state: 'other',
        other: {
          kind: 'keepalive',
          handle: (proven ?? declaredKeepalive).tmuxSession ?? null,
          via: proven ? 'keepalive-marker' : 'keepalive-declared',
        },
      }
    }
    if (probe.platform !== 'darwin' && probe.platform !== 'linux') return { state: 'none' }
    if (!probe.execSync) return { state: 'unknown', reason: 'listing-unreadable' }
    const exec = memoExec(probe.execSync)
    const loaded = loadedHandles(probe.platform, exec)
    if (!loaded) return { state: 'unknown', reason: 'listing-unreadable' }
    const kind: 'launchd' | 'systemd' = probe.platform === 'darwin' ? 'launchd' : 'systemd'
    const isLoaded = (handle: string) => loaded.has(handle) || (kind === 'systemd' && loaded.has(`${handle}.service`))

    // A job declared at boot, while it is loaded right now (F5).
    const supervisorPath = supervisorFilePath(probe.home, probe.assistantId)
    const declared = supervisorPath ? parseSupervisorFile(probe.readFile(supervisorPath))?.declared : null
    if (
      declared &&
      declared.kind === kind &&
      declared.handle &&
      !isCanonicalHandle(kind, declared.handle, id) &&
      isLoaded(declared.handle)
    ) {
      return { state: 'other', other: { kind, handle: declared.handle, via: 'declared' } }
    }

    // Discovery, the cheap anchored path first: it inspects only job files
    // that mention this agent's state dir or folder.
    const io = {
      platform: probe.platform,
      home: probe.home,
      assistantId: probe.assistantId,
      cwd: probe.cwd ?? null,
      readFile: probe.readFile,
      execSync: exec,
    }
    const sole = resolveSupervisingService({ ...io, listDir: probe.listDir })
    if (sole && !isCanonicalHandle(sole.kind, sole.handle, id)) {
      return { state: 'other', other: { kind: sole.kind, handle: sole.handle, via: sole.via as OtherSupervisor['via'] } }
    }
    // No single answer: a tie (F4) or nothing. Every loaded job is matched on
    // its own, with the resolver's own anchors and folder veto, and ANY job
    // other than ours that names this agent is another supervisor. Only here
    // does a reading pay for the whole job list, which is just before an
    // install.
    if (typeof probe.listDir === 'function') {
      const jobs = listLoadedJobs({ platform: probe.platform, home: probe.home, listDir: probe.listDir, readFile: probe.readFile, execSync: exec })
      for (const via of ['state-dir', 'working-directory'] as const) {
        for (const job of jobs) {
          if (isCanonicalHandle(job.kind, job.handle, id)) continue
          if (resolveSupervisingService({ ...io, jobs: [job] })?.via === via) {
            return { state: 'other', other: { kind: job.kind, handle: job.handle, via } }
          }
        }
      }
    }
    return { state: 'none' }
  } catch {
    return { state: 'unknown', reason: 'error' }
  }
}

/**
 * The exec for the G11 reading: systemctl --user reaches the user bus through
 * XDG_RUNTIME_DIR, and a daemon started outside a login session (cron, a bare
 * ssh) may not have it. bin/bgos-agent defaults it to /run/user/<uid> and its
 * install then succeeds; without the same default here the listing would read
 * as unknown on every cycle and the reconcile would never install. Linux only,
 * systemctl only, and only when the variable is unset.
 */
export function userBusExecSync(
  exec: (file: string, args: string[]) => SyncExecResult,
  ctx: { platform: string; env: Record<string, string | undefined>; uid: number | null },
): (file: string, args: string[]) => SyncExecResult {
  if (ctx.platform !== 'linux') return exec
  if (String(ctx.env.XDG_RUNTIME_DIR ?? '').trim()) return exec
  if (typeof ctx.uid !== 'number' || !Number.isInteger(ctx.uid) || ctx.uid < 0) return exec
  const runtimeDir = `/run/user/${ctx.uid}`
  return (file, args) => (file === 'systemctl' ? exec('env', [`XDG_RUNTIME_DIR=${runtimeDir}`, file, ...args]) : exec(file, args))
}

/**
 * What the reconcile does this cycle.
 *   desired + canonical installed      leave
 *   not desired + canonical installed  remove (the caller still applies the
 *                                      install grace, lib/always-on-grace.ts)
 *   not desired + not installed        leave
 *   desired + not installed            defer when another live supervisor
 *                                      holds the agent, install on a definite
 *                                      none, else wait for the next cycle
 * `supervision` is only consulted on the last row, so a caller may pass null
 * everywhere else and skip the platform query.
 */
export function decideAlwaysOnReconcile(input: {
  desired: boolean
  canonicalInstalled: boolean
  supervision: AlwaysOnSupervision | null
}): AlwaysOnReconcileDecision {
  if (input.canonicalInstalled) return input.desired ? { action: 'leave' } : { action: 'remove' }
  if (!input.desired) return { action: 'leave' }
  const s = input.supervision
  if (s?.state === 'other') return { action: 'defer', other: s.other }
  if (s?.state === 'none') return { action: 'install' }
  return { action: 'wait', reason: s?.reason ?? 'unread' }
}

/** The supervisor named in one human sentence, for the log line. */
export function describeOtherSupervisor(other: OtherSupervisor): string {
  if (other.kind === 'keepalive') {
    return `a keepalive script (keepalive.json${other.handle ? `, tmux ${other.handle}` : ''})`
  }
  const what = other.kind === 'launchd' ? 'launchd job' : 'systemd unit'
  return `the ${what} ${other.handle ?? '(unnamed)'} (found by ${other.via})`
}
