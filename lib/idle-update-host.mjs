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
import { agentTmuxSockets } from './agent-restart.mjs'
import { findTool } from './agent-windows.mjs'
import { holdMarketplaceEnrolment, repointInstalledPlugins } from './idle-update.mjs'
import { LAUNCH_STATUS_FILE_NAME, parseLaunchStatusOutcome } from './keepalive-plan.mjs'
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
  }
}

/** The tmux binary a launchd or systemd PATH may lack (Homebrew, /usr/local): null when there is none. */
export function findTmux({ env, home }) {
  return safe(() => findTool('tmux', { env: env ?? {}, home: home ?? '' }), null)
}

// -- A person at the agent's tmux session ---------------------------------------------------------

const NO_SERVER_RE = /no server running|error connecting to|No such file or directory/i
const NO_SESSION_RE = /can't find session|no server running|error connecting to|No such file or directory/i

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
 * its sockets), or to the keepalive's session on the default server? A
 * read-only viewer (Show agent windows attaches with -r) is nobody typing.
 * Windows has no tmux: its unattended proof requires the hidden task instead.
 * No tmux to ask, or a tmux that did not answer, is unknown (null), which waits.
 * @returns {Promise<boolean | null>}
 */
export async function readPersonAttached({ platform, sockets, keepaliveSession, tmuxPath, exec, env }) {
  if (platform === 'win32') return false
  if (typeof tmuxPath !== 'string' || !tmuxPath) return null
  for (const socket of Array.isArray(sockets) ? sockets : []) {
    if (typeof socket !== 'string' || !socket) continue
    const seen = await clientsOf(exec, tmuxPath, ['-L', socket, 'list-clients', '-F', '#{client_readonly}'], env, NO_SERVER_RE)
    if (seen !== 'none') return seen === 'rw' ? true : null
  }
  if (typeof keepaliveSession === 'string' && keepaliveSession) {
    const seen = await clientsOf(exec, tmuxPath, ['list-clients', '-t', `=${keepaliveSession}`, '-F', '#{client_readonly}'], env, NO_SESSION_RE)
    if (seen !== 'none') return seen === 'rw' ? true : null
  }
  return false
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
  return Number.isFinite(at) && now - at >= 0 && now - at < freshMs
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
 * is this plugin's own for this marketplace, else 'normal' (today's enrolment,
 * which never overturns a person's false).
 * @returns {'hold' | 'reclaim' | 'normal'}
 */
export function decideEnrolment({ holdRaw, marketplace, latestKnownVersion, badVersions }) {
  if (holdMarketplaceEnrolment({ latestKnownVersion, badVersions })) return 'hold'
  const hold = parseJson(holdRaw)
  return hold && typeof hold === 'object' && hold.marketplace === marketplace ? 'reclaim' : 'normal'
}

/**
 * The marketplace rollback: installed_plugins.json points the hoai entry back
 * at the old version's folder (only while that folder still holds it), then
 * Claude Code's own startup update is switched off so the relaunch does not
 * reinstall the build being left. The switch-off is recorded only when this
 * call made it: a false the person set stays theirs.
 * @param {{ record: any, installedPluginsPath: string, holdPath: string, marketplace: string | null | undefined,
 *   fs: { readFile: (p: string) => string | null, writeAtomic: (p: string, text: string) => boolean },
 *   setAutoUpdate: (enabled: boolean) => { changed: boolean, reason: string }, now: number }} input
 * @returns {Promise<{ ok: true, enrolment: string } | { ok: false, reason: string }>}
 */
export async function rollbackMarketplaceInstall({ record, installedPluginsPath, holdPath, marketplace, fs, setAutoUpdate, now }) {
  if (record?.installMethod !== 'marketplace') return { ok: false, reason: 'not_marketplace' }
  const from = record.from
  const fromRoot = record.fromRoot
  if (typeof from !== 'string' || !VERSION_RE.test(from) || typeof fromRoot !== 'string' || !fromRoot) return { ok: false, reason: 'from_root_missing' }
  const manifest = parseJson(safe(() => fs.readFile(joinDir(joinDir(fromRoot, '.claude-plugin'), 'plugin.json')), null))
  if (manifest?.version !== from) return { ok: false, reason: 'from_root_missing' }
  const raw = safe(() => fs.readFile(installedPluginsPath), null)
  if (raw === null) return { ok: false, reason: 'unreadable' }
  const repointed = repointInstalledPlugins(raw, { version: from, installPath: fromRoot, now })
  if (!repointed.ok) return { ok: false, reason: repointed.reason }
  if (safe(() => fs.writeAtomic(installedPluginsPath, repointed.text), false) !== true) return { ok: false, reason: 'write_failed' }
  if (typeof marketplace !== 'string' || !marketplace) return { ok: true, enrolment: 'no_marketplace' }
  let enrolment
  try {
    const result = setAutoUpdate(false)
    enrolment = String(result?.reason ?? 'unknown')
    if (result?.changed === true) {
      const hold = { marketplace, version: record.target, at: new Date(now).toISOString() }
      if (safe(() => fs.writeAtomic(holdPath, `${JSON.stringify(hold)}\n`), false) !== true) enrolment = 'set_unrecorded'
    }
  } catch (err) {
    enrolment = `error: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`
  }
  return { ok: true, enrolment }
}
