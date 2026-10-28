/**
 * The readings server.ts hands the idle update controller (lib/idle-update.mjs
 * createIdleUpdate), and the marketplace half of its rollback
 * (docs/idle-update/DESIGN.md, "Rollback" and "Platforms"). Every reading goes
 * through an injected fs or exec and never throws; an answer it cannot be
 * sure of is the one that waits (null), never a guess that restarts.
 *
 * Tested in test/idle-update.host.test.ts. Plain JavaScript, import-safe.
 */

import { RESTART_MARKER_FILE_NAME, SUPERVISOR_FILE_NAME, joinDir } from './agent-inventory.mjs'
import { agentTmuxSockets, isOwnServiceProcess } from './agent-restart.mjs'
import { findTool } from './agent-windows.mjs'
import { holdMarketplaceEnrolment, installedPluginsPointsAt, repointInstalledPlugins } from './idle-update.mjs'
import { LAUNCH_STATUS_FILE_NAME, parseLaunchStatusOutcome } from './keepalive-plan.mjs'
import { parseCgroupProcs, parseSystemctlShow, strayCgroupMembers } from './process-tree.mjs'
import { keepAliveStatePath } from './watcher-keepalive.mjs'

/** In the computer's idle update folder: the marketplace auto-update this plugin switched off, and for which version. */
export const ENROLMENT_HOLD_FILE_NAME = 'enrolment-hold.json'
/** The Windows agent task's launcher script (lib/agent-inventory.mjs AGENT_TASK_LAUNCHER_FILE_NAME). */
const RUN_AGENT_VBS = 'run-agent.vbs'
/** One tmux query; a hung server must not hold a poll. */
const TMUX_TIMEOUT_MS = 5_000
const VERSION_RE = /^\d+\.\d+\.\d+$/

function safe(fn, fallback) {
  try {
    const value = fn()
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

function parseJson(raw) {
  if (typeof raw !== 'string' || !raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function finite(n) {
  return typeof n === 'number' && Number.isFinite(n)
}

// -- The launcher ---------------------------------------------------------------------------------

/**
 * The hoai launcher supervisor.json names, when it promises to relaunch on a
 * marker and its pid is alive: the pid, the start it claims (hoai rewrites the
 * claim before every relaunch), where its marker goes, and when the claim was
 * written. Null otherwise.
 * @param {{ stateDir: string, fs: { readFile: (p: string) => string | null, mtimeMs: (p: string) => number | null }, alive: (pid: number) => boolean }} input
 */
export function readLauncherClaim({ stateDir, fs, alive }) {
  const path = joinDir(stateDir, SUPERVISOR_FILE_NAME)
  const claim = parseJson(safe(() => fs.readFile(path), null))
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return null
  const pid = claim.pid
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (!Array.isArray(claim.capabilities) || !claim.capabilities.includes('relaunch')) return null
  if (safe(() => alive(pid), false) !== true) return null
  const startedAtMs = typeof claim.startedAt === 'string' ? Date.parse(claim.startedAt) : Number.NaN
  const mtimeMs = safe(() => fs.mtimeMs(path), null)
  return {
    pid,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
    markerPath: joinDir(stateDir, RESTART_MARKER_FILE_NAME),
    supervisorMtimeMs: finite(mtimeMs) ? mtimeMs : null,
  }
}

/** When the waiting restart marker was written, or null when none waits. */
export function readMarkerMtimeMs({ stateDir, fs }) {
  const at = safe(() => fs.mtimeMs(joinDir(stateDir, RESTART_MARKER_FILE_NAME)), null)
  return finite(at) ? at : null
}

/**
 * What lib/idle-update.mjs proveUnattended reads besides the process table:
 * this HOME's tmux sockets for the agent, its run.sh, launch-status and
 * run-agent.vbs as they are on disk now.
 */
export function readUnattendedInputs({ platform, home, assistantId, stateDir, fs }) {
  const statusPath = joinDir(stateDir, LAUNCH_STATUS_FILE_NAME)
  const vbsPath = joinDir(stateDir, RUN_AGENT_VBS)
  const statusMtime = safe(() => fs.mtimeMs(statusPath), null)
  const vbsMtime = safe(() => fs.mtimeMs(vbsPath), null)
  return {
    ownSockets: safe(() => agentTmuxSockets({ assistantId: String(assistantId), home, stateDir }, platform), []),
    runShPath: joinDir(stateDir, 'run.sh'),
    launchStatus: { outcome: parseLaunchStatusOutcome(safe(() => fs.readFile(statusPath), null)), mtimeMs: finite(statusMtime) ? statusMtime : null },
    runAgentVbs: { text: safe(() => fs.readFile(vbsPath), null), mtimeMs: finite(vbsMtime) ? vbsMtime : null },
    runAgentVbsPath: vbsPath,
  }
}

/** The tmux binary a launchd or systemd PATH may lack (Homebrew, /usr/local): null when there is none. */
export function findTmux({ env, home }) {
  return safe(() => findTool('tmux', { env: env ?? {}, home: home ?? '' }), null)
}

// -- A person at the agent's tmux session ---------------------------------------------------------

const NO_SERVER_RE = /no server running|error connecting to|No such file or directory/i
/** Nothing tmux says counts as "nobody there" for a keepalive: a session it cannot find is unknown, never absent. */
const NEVER_ABSENT_RE = /(?!)/

function withoutTmux(env) {
  const next = { ...(env ?? {}) }
  delete next.TMUX
  delete next.TMUX_PANE
  return next
}

/** 'rw' when a read-write client is listed, 'none' when none is (or nothing is there), null when tmux did not answer. */
async function clientsOf(exec, tmuxPath, args, env, absentRe) {
  let res
  try {
    res = await exec(tmuxPath, args, { timeoutMs: TMUX_TIMEOUT_MS, env: withoutTmux(env) })
  } catch {
    return null
  }
  if (!res || res.timedOut) return null
  if (res.code === 0) {
    return String(res.stdout ?? '')
      .split(/\r?\n/)
      .some((line) => line.trim() === '0')
      ? 'rw'
      : 'none'
  }
  return absentRe.test(`${res.stderr ?? ''}\n${res.stdout ?? ''}`) ? 'none' : null
}

/**
 * Is a person attached read-write to the agent's own tmux server (on any of
 * its sockets), or, for a keepalive, to the session the daemon itself runs
 * in? A read-only viewer (Show agent windows attaches with -r) is nobody
 * typing. Windows has no tmux: its unattended proof requires the hidden task
 * instead. No tmux to ask, or a tmux that did not answer, is unknown (null),
 * which waits.
 *
 * A keepalive is asked where it really runs: the tmux server and pane named
 * by TMUX and TMUX_PANE in the daemon's own environment (inherited from the
 * pane claude runs in), first; its declared tmuxSession on the default server
 * only when the daemon is in no tmux. The declared name is a label for the log
 * line, so a session tmux cannot find, a server that is not there, or nothing
 * to ask at all is unknown, never "nobody".
 * @returns {Promise<boolean | null>}
 */
export async function readPersonAttached({ platform, sockets, keepalive, keepaliveSession, tmuxPath, exec, env }) {
  if (platform === 'win32') return false
  if (typeof tmuxPath !== 'string' || !tmuxPath) return null
  for (const socket of Array.isArray(sockets) ? sockets : []) {
    if (typeof socket !== 'string' || !socket) continue
    const seen = await clientsOf(exec, tmuxPath, ['-L', socket, 'list-clients', '-F', '#{client_readonly}'], env, NO_SERVER_RE)
    if (seen !== 'none') return seen === 'rw' ? true : null
  }
  const declared = typeof keepaliveSession === 'string' && keepaliveSession ? keepaliveSession : null
  if (keepalive === true || declared) return keepaliveAttached({ declared, tmuxPath, exec, env })
  return false
}

async function keepaliveAttached({ declared, tmuxPath, exec, env }) {
  const socket = String(env?.TMUX ?? '').split(',')[0].trim()
  const pane = String(env?.TMUX_PANE ?? '').trim()
  if (socket && pane) {
    let res
    try {
      res = await exec(tmuxPath, ['-S', socket, 'display', '-p', '-t', pane, '#{session_name}'], { timeoutMs: TMUX_TIMEOUT_MS, env: withoutTmux(env) })
    } catch {
      return null
    }
    const name = res && !res.timedOut && res.code === 0 ? String(res.stdout ?? '').trim() : ''
    if (!name) return null
    const seen = await clientsOf(exec, tmuxPath, ['-S', socket, 'list-clients', '-t', `=${name}`, '-F', '#{client_readonly}'], env, NEVER_ABSENT_RE)
    return seen === null ? null : seen === 'rw'
  }
  if (!declared) return null
  const seen = await clientsOf(exec, tmuxPath, ['list-clients', '-t', `=${declared}`, '-F', '#{client_readonly}'], env, NEVER_ABSENT_RE)
  return seen === null ? null : seen === 'rw'
}

// -- The watcher, the schedule --------------------------------------------------------------------

/**
 * Is the per-machine watcher's keep-alive sweep running on this HOME? Its
 * state file says enabled and was written within `freshMs`. One restart
 * authority per computer: where it sweeps, the idle update stands down.
 */
export function readWatcherSweepActive({ home, fs, now, freshMs }) {
  const state = parseJson(safe(() => fs.readFile(keepAliveStatePath(home)), null))
  if (!state || typeof state !== 'object' || state.enabled !== true) return false
  const at = typeof state.updatedAt === 'string' ? Date.parse(state.updatedAt) : Number.NaN
  // A stamp a little in the future (a clock that jumped back) is active: the watcher may well be sweeping. One
  // further ahead than a stamp stays fresh is stale: a watcher that still sweeps rewrites it on the new clock.
  return Number.isFinite(at) && now - at < freshMs && at - now <= freshMs
}

/** The bound on the one systemctl read (the watcher's process list bound). */
const SYSTEMCTL_TIMEOUT_MS = 10_000

/**
 * What a restart through this agent's owning systemd unit would end beyond
 * the agent: systemd ends the unit's whole cgroup (KillMode=control-group),
 * and a job orphaned out of claude's tree (a Bash tool's `nohup job &` whose
 * shell exited) is still in it, where the job scan under claude cannot see it.
 * The watcher's own check (lib/watcher-keepalive.mjs unitStrays), for this
 * agent's unit. Only a systemd unit ends a group: anything else reads nothing.
 * Fails closed: {ok:false} when the group cannot be read.
 * @returns {Promise<{ ok: boolean, strays: number[] }>}
 */
export async function readServiceStrays({ service, processes, claudePid, sockets, runShPath, exec, fs, env }) {
  if (service?.kind !== 'systemd') return { ok: true, strays: [] }
  const fail = { ok: false, strays: [] }
  if (typeof service.handle !== 'string' || !service.handle || !Array.isArray(processes)) return fail
  let res
  try {
    res = await exec('systemctl', ['--user', 'show', '-p', 'MainPID', '-p', 'ControlGroup', service.handle], { env, timeoutMs: SYSTEMCTL_TIMEOUT_MS })
  } catch {
    return fail
  }
  if (res?.code !== 0) return fail
  const show = parseSystemctlShow(res.stdout)
  // No group: the unit runs nothing, so its restart ends nothing.
  if (!show.controlGroup) return { ok: true, strays: [] }
  const procs = (base) => safe(() => fs.readFile(`${base}${show.controlGroup}/cgroup.procs`), null)
  const members = parseCgroupProcs(procs('/sys/fs/cgroup') ?? procs('/sys/fs/cgroup/systemd'))
  if (!members) return fail
  const inGroup = new Set(members)
  const byPid = new Map(processes.map((p) => [p.pid, p]))
  const roots = [show.mainPid]
  if (Number.isInteger(claudePid)) {
    roots.push(claudePid)
    // claude's ancestors inside the group: run.sh, expect, hoai, the tmux server.
    for (let up = byPid.get(byPid.get(claudePid)?.ppid); up && inGroup.has(up.pid) && !roots.includes(up.pid); up = byPid.get(up.ppid)) roots.push(up.pid)
  }
  for (const pid of members) if (isOwnServiceProcess(byPid.get(pid)?.command, sockets, runShPath)) roots.push(pid)
  return { ok: true, strays: strayCgroupMembers({ members, processes, roots }) }
}

/**
 * The agent's active scheduled tasks (GET scheduled-tasks/agent?status=active,
 * AgentScheduledTaskViewDto[], with X-Caller-Assistant-Id). Anything but a
 * list is unknown, which waits.
 * @param {(path: string) => Promise<unknown>} get
 */
export async function readWakeSchedule(get) {
  try {
    const body = await get('scheduled-tasks/agent?status=active')
    return Array.isArray(body) ? { ok: true, tasks: body } : { ok: false, tasks: null }
  } catch {
    return { ok: false, tasks: null }
  }
}

// -- Versions held here, and the marketplace enrolment ---------------------------------------------

/** The X.Y.Z versions latched bad on this computer (`<machineDir>/<version>/bad`). */
export function listHeldBadVersions({ machineDir, fs }) {
  const names = safe(() => fs.listDir(machineDir), null) ?? []
  return names.filter((name) => VERSION_RE.test(name) && safe(() => fs.readFile(joinDir(joinDir(machineDir, name), 'bad')), null) !== null).sort()
}

/**
 * What the boot enrolment does with Claude Code's own plugin update for this
 * marketplace: 'hold' while its latest version is latched bad here (or not
 * known while one is), 'reclaim' once it is not and the switch-off on record
 * is this plugin's own for this marketplace IN THIS Claude config folder (the
 * hold is per HOME, the switch per config folder: another folder's false is a
 * person's), else 'normal' (today's enrolment, which never overturns a
 * person's false).
 * @returns {'hold' | 'reclaim' | 'normal'}
 */
export function decideEnrolment({ holdRaw, marketplace, latestKnownVersion, badVersions, configDir }) {
  if (holdMarketplaceEnrolment({ latestKnownVersion, badVersions })) return 'hold'
  const hold = parseJson(holdRaw)
  const ours =
    hold && typeof hold === 'object' && hold.marketplace === marketplace && typeof hold.configDir === 'string' && hold.configDir !== '' && hold.configDir === configDir
  return ours ? 'reclaim' : 'normal'
}

/**
 * The marketplace rollback: installed_plugins.json points the hoai entry back
 * at the old version's folder (only while that folder still holds it), then
 * Claude Code's own startup update is switched off so the relaunch does not
 * reinstall the build being left. The switch-off is recorded only when this
 * call made it, with the config folder it was made in: a false the person set
 * stays theirs. installed_plugins.json is read back after each write (a
 * concurrent claude may write its own snapshot over it) and written again, up
 * to three times. A switch-off that did not persist fails the rollback: the
 * restart would only reinstall the build being left.
 * @param {{ record: any, installedPluginsPath: string, holdPath: string, marketplace: string | null | undefined,
 *   configDir?: string | null,
 *   fs: { readFile: (p: string) => string | null, writeAtomic: (p: string, text: string) => boolean },
 *   setAutoUpdate: (enabled: boolean) => { changed: boolean, reason: string }, now: number }} input
 * @returns {Promise<{ ok: true, enrolment: string } | { ok: false, reason: string }>}
 */
export async function rollbackMarketplaceInstall({ record, installedPluginsPath, holdPath, marketplace, configDir, fs, setAutoUpdate, now }) {
  if (record?.installMethod !== 'marketplace') return { ok: false, reason: 'not_marketplace' }
  const from = record.from
  const fromRoot = record.fromRoot
  if (typeof from !== 'string' || !VERSION_RE.test(from) || typeof fromRoot !== 'string' || !fromRoot) return { ok: false, reason: 'from_root_missing' }
  const manifest = parseJson(safe(() => fs.readFile(joinDir(joinDir(fromRoot, '.claude-plugin'), 'plugin.json')), null))
  if (manifest?.version !== from) return { ok: false, reason: 'from_root_missing' }
  let held = false
  for (let attempt = 0; attempt < 3 && !held; attempt += 1) {
    const raw = safe(() => fs.readFile(installedPluginsPath), null)
    if (raw === null) return { ok: false, reason: 'unreadable' }
    const repointed = repointInstalledPlugins(raw, { version: from, installPath: fromRoot, now })
    if (!repointed.ok) return { ok: false, reason: repointed.reason }
    if (safe(() => fs.writeAtomic(installedPluginsPath, repointed.text), false) !== true) return { ok: false, reason: 'write_failed' }
    held = installedPluginsPointsAt(safe(() => fs.readFile(installedPluginsPath), null), { version: from, installPath: fromRoot })
  }
  if (!held) return { ok: false, reason: 'not_persisted' }
  if (typeof marketplace !== 'string' || !marketplace) return { ok: true, enrolment: 'no_marketplace' }
  let result
  try {
    result = setAutoUpdate(false)
  } catch {
    return { ok: false, reason: 'auto_update_still_on' }
  }
  let enrolment = String(result?.reason ?? 'unknown')
  if (enrolment === 'not_persisted') return { ok: false, reason: 'auto_update_still_on' }
  if (result?.changed === true) {
    const hold = { marketplace, ...(typeof configDir === 'string' && configDir ? { configDir } : {}), version: record.target, at: new Date(now).toISOString() }
    if (safe(() => fs.writeAtomic(holdPath, `${JSON.stringify(hold)}\n`), false) !== true) enrolment = 'set_unrecorded'
  }
  return { ok: true, enrolment }
}
