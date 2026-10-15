/**
 * agent-restart: restart ONE agent through the strongest restart authority
 * it has, per the ladder in design 1.5 / 7.4:
 *
 *   launcher-live   write ~/.bgos-agent/<id>/restart-requested.json ({}):
 *                   the live hoai supervisor (bin/hoai-core.mjs) sees the
 *                   marker, SIGTERMs claude and relaunches it RESUMING that
 *                   agent's own pinned session. Existence only, contents
 *                   ignored on the other side. Also taken for a SERVICE row
 *                   whose launcher is live (launcherLive) when that launcher
 *                   is a person's `hoai` the service waits behind (D4), the
 *                   Windows task's, or a non-canonical service's. The canonical
 *                   v2 service's OWN hoai restarts through the service instead
 *                   (launcherIsServiceChild), so hoai itself lands on the new code,
 *                   unless its tmux server holds anything else (a job the agent
 *                   started there with `tmux new-session -d`): run.sh's trap would
 *                   kill that whole server, so the marker again.
 *   keepalive       a bespoke keepalive script that declared itself in
 *                   ~/.bgos-agent/<id>/keepalive.json and VERIFIES (the script
 *                   alive, claudePid alive and named claude, and provably this
 *                   agent's: under the script, in the agent folder, or named by
 *                   the agent's own daemon; never a reused pid; lib/agent-inventory.mjs
 *                   verifyKeepaliveMarker): SIGTERM that claude and the script
 *                   relaunches it, exactly as the daemon's own ladder does
 *                   (lib/update-readiness.ts). Preferred over 'service': this
 *                   Mac's ai.bgos.session.<id> jobs run claude in a tmux session
 *                   that outlives a `kickstart -k` of the job, so a service
 *                   restart would kill the script, leave the old claude
 *                   running and the new job waiting behind it (design 5).
 *   task (win32)    the canonical agent task "HOAI Agent <id>"
 *                   (lib/agent-task-win32.mjs). Its launcher is hoai-core
 *                   --keep-alive: while it is live the marker above restarts
 *                   claude; when it is dead, `schtasks /Run /TN "HOAI Agent
 *                   <id>"` starts it again (design 4, Windows bullet).
 *   service         launchctl kickstart -k gui/<uid>/<label> on darwin,
 *                   systemctl --user restart <unit> on linux, where the label
 *                   or unit is the one lib/agent-inventory.mjs RESOLVED for
 *                   this agent: the always-on per-agent service from
 *                   bin/bgos-agent when that is what is installed, otherwise
 *                   whichever loaded job the platform reported as this
 *                   agent's supervisor (lib/service-supervision.mjs). Either
 *                   way the supervisor re-runs its own launch recipe.
 *   recipe          no live authority, but a validated launch recipe: start
 *                   `node <CURRENT pluginRoot>/bin/hoai-core.mjs` in the
 *                   recipe cwd. hoai-core then owns supervision (identity
 *                   from the folder pin, its own session pin, supervisor.json,
 *                   the dev-channels gate). It needs a pty or a console, and it
 *                   is ALWAYS HIDDEN (board row d133ddb2: every agent starts
 *                   hidden; a window is only a viewer beside it, opened by the
 *                   watcher's windows pass, lib/agent-windows.mjs):
 *                     posix   tmux new-session -d -s hoai-<id> -c <cwd> "..."
 *                             else script (-q /dev/null ... on darwin,
 *                             -qc "..." /dev/null on linux) detached, else
 *                             no_pty_available: never a visible Terminal or
 *                             terminal emulator
 *                     win32   wscript //B <statedir>\launch-hidden.vbs, which
 *                             runs "<node>" "<core>" in a console of window
 *                             style 0 (hidden) and does not wait, unattended as
 *                             this agent (HOAI_SUPERVISED, as the agent task's
 *                             own launcher does). Never cmd /k: that console
 *                             stayed open, empty, after the agent ended.
 *   none            manual_restart_required, named, never silent.
 *
 * Landmine 3: NOTHING here passes --resume, --continue, --session-id or a
 * session id. The CURRENT plugin root (post-update) is used for the launch,
 * never the root recorded in the recipe (a marketplace update moves the
 * cache dir), falling back to the recipe's only when the caller has none.
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe; every effect
 * (fs, exec, spawnDetached, tool presence) injected.
 */

import {
  RESTART_MARKER_FILE_NAME,
  SUPERVISOR_FILE_NAME,
  agentServiceNamesFor,
  defaultPidAlive,
  joinDir,
  parseSupervisorFile,
  serviceLabel,
  serviceUnit,
  validAssistantId,
} from './agent-inventory.mjs'
import { readBackAgentService } from './agent-service.mjs'
import { agentTaskRegistration, runAgentTask } from './agent-task-win32.mjs'
import {
  AGENT_STATE_FILE_NAME,
  LAUNCH_STATUS_FILE_NAME,
  PAIRING_LOCK_FRESH_MS,
  SUPERVISOR_GENERATION_CURRENT,
  isAgentStateFresh,
  parseAgentState,
  parseLaunchStatusOutcome,
  parsePairingLock,
} from './keepalive-plan.mjs'
import { listProcesses } from './process-tree.mjs'
import { serviceRestartCommandForHandle } from './service-supervision.mjs'
import { joinRel, nodeExec, nodeFs, nodeSpawnDetached } from './watcher-bundle.mjs'
import { vbsString } from './win32-script-text.mjs'
import { existsSync } from 'node:fs'

/** @typedef {'marker' | 'keepalive' | 'service' | 'task' | 'recipe-tmux' | 'recipe-script' | 'recipe-hidden' | 'none'} RestartHow */

/**
 * How long a service restart or task start command may run. `systemctl --user
 * restart` returns only once the unit has stopped (SIGTERM to its whole
 * cgroup, then up to TimeoutStopSec, 90 s by default, before SIGKILL) and
 * started again, and a hung user bus never returns; nodeExec's default timeout
 * is none, and the watcher's job loop and heartbeat wait on this call. Past
 * the 90 s stop, so a slow but finishing stop is not cut short.
 */
export const RESTART_EXEC_TIMEOUT_MS = 2 * 60_000

/** The only task names a win32 restart may address: built from a digits-only id
 *  by lib/agent-inventory.mjs agentServiceNames (this HOME's `home-<hid>` name,
 *  or the old one of an agent not renamed yet), re-checked here because it
 *  rides an argv into schtasks. */
const AGENT_TASK_NAME_RE = /^HOAI Agent \d+( home-[0-9a-f]{8})?$/

/**
 * The HOME an agent row belongs to: the inventory says so (listAgents rows
 * carry it); a row built elsewhere is read from its state dir
 * (<home>/.bgos-agent/<id>). Null when neither says.
 */
export function agentHomeOf(agent) {
  if (typeof agent?.home === 'string' && agent.home.trim()) return agent.home
  const m = /^(.+?)[\\/]\.bgos-agent[\\/]\d+[\\/]?$/.exec(String(agent?.stateDir ?? ''))
  return m ? m[1] : null
}

/** The tmux sockets an agent's own service server may be on: this HOME's, then the old `hoai-<id>` of a supervisor not renamed yet. */
export function agentTmuxSockets(agent, platform = process.platform) {
  const home = agentHomeOf(agent)
  const names = home ? agentServiceNamesFor(agent.assistantId, home, platform) : null
  return names ? [names.current.tmuxSocket, names.legacy.tmuxSocket] : [`hoai-${agent?.assistantId}`]
}

/** The hoai launcher inside a plugin root, in that root's separator style. */
export function hoaiCorePath(pluginRoot) {
  return joinRel(pluginRoot, 'bin/hoai-core.mjs')
}

/** POSIX single-quote shell quoting (safe for tmux / script -c / bash -c). */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

/**
 * The immediate service restart command (mirror of lib/update-readiness.ts
 * serviceRestartCommand WITHOUT the self-restart delay: the watcher is not
 * the process being restarted). Null when the platform has no service, the
 * id is invalid, or darwin has no uid.
 *
 * `service` is the job lib/agent-inventory.mjs actually RESOLVED for this
 * agent (canonical or discovered); the restart is addressed to that job so it
 * goes back through the supervisor holding the agent, which then re-runs its
 * own launch recipe in its own working directory. Without one the canonical
 * bin/bgos-agent label/unit is used, which is what this did before discovery.
 */
export function serviceRestartCommand({ platform, assistantId, uid, service = null }) {
  // serviceRestartCommandForHandle owns the handle-safety rule; a second copy
  // of it here would mask the first, so neither could be proven by a test.
  if (service) return serviceRestartCommandForHandle({ kind: service.kind, handle: service.handle, uid })
  const id = validAssistantId(assistantId)
  if (!id) return null
  if (platform === 'linux') {
    return serviceRestartCommandForHandle({ kind: 'systemd', handle: serviceUnit(id), uid })
  }
  if (platform === 'darwin') {
    return serviceRestartCommandForHandle({ kind: 'launchd', handle: serviceLabel(id), uid })
  }
  return null
}

/** The win32 one shot launcher, in the agent's own state dir (~\.bgos-agent\<id>). */
export const HIDDEN_LAUNCHER_FILE_NAME = 'launch-hidden.vbs'

/** A quote cannot be embedded in the vbs launch line; WshShell.Run expands a %VAR%
 *  in it; a line break would end the vbs statement. Refused, never escaped. */
const WIN32_LAUNCH_LINE_UNSAFE_RE = /["%\r\n]/
const WIN32_FOLDER_UNSAFE_RE = /["\r\n]/

/**
 * The win32 one shot launcher: hoai-core once, in a console of window style 0
 * (hidden), and nothing waits on it. Pure ASCII whatever the paths hold
 * (vbsString). The environment is the agent task's (lib/agent-task-win32.mjs):
 * nobody can answer a prompt in a hidden console, so hoai-core runs unattended
 * as this agent and stops by name where it would otherwise wait for a person.
 * @param {{ assistantId: string, cwd: string, nodePath: string, corePath: string }} params
 */
export function hiddenLauncherVbs({ assistantId, cwd, nodePath, corePath }) {
  return [
    `' HOAI agent ${assistantId}: start this agent's hoai launcher once, in a hidden console (no window).`,
    "' Generated by lib/agent-restart.mjs for an agent with no supervisor; wscript runs it with //B and nothing waits on it.",
    'Set shell = CreateObject("WScript.Shell")',
    "' Unattended, and for this agent only (bin/hoai-core.mjs SUPERVISED_ENV): nobody can answer a prompt in a hidden console.",
    'Set env = shell.Environment("PROCESS")',
    'env("HOAI_SUPERVISED") = "1"',
    `env("HOAI_SUPERVISED_ASSISTANT_ID") = "${assistantId}"`,
    `shell.CurrentDirectory = ${vbsString(cwd)}`,
    `shell.Run ${vbsString(`"${nodePath}" "${corePath}"`)}, 0, False`,
    '',
  ].join('\r\n')
}

/** The relaunch env: the recipe's claudeConfigDir set, or the key removed when the recipe has none. */
export function envForRecipe(env, recipe) {
  const next = { ...(env ?? {}) }
  const dir = String(recipe?.claudeConfigDir ?? '').trim()
  if (dir) next.CLAUDE_CONFIG_DIR = dir
  else delete next.CLAUDE_CONFIG_DIR
  return next
}

/**
 * The pure launch command for a recipe restart, or null when no HIDDEN
 * mechanism is available on this host. `files` are written before the spawn
 * (the win32 launcher, in the agent's state dir).
 * @param {{ platform: string, assistantId: string, cwd: string, nodePath: string,
 *   pluginRoot: string, stateDir?: string | null, hasTmux?: boolean, hasScript?: boolean }} params
 * @returns {{ how: RestartHow, file: string, args: string[], spawnOpts: Record<string, unknown>, files?: Array<{ path: string, content: string }> } | null}
 */
export function recipeLaunchCommand({ platform, assistantId, cwd, nodePath, pluginRoot, stateDir = null, hasTmux = false, hasScript = false }) {
  const core = hoaiCorePath(pluginRoot)
  if (platform === 'win32') {
    if (!stateDir || !validAssistantId(assistantId)) return null
    if (WIN32_FOLDER_UNSAFE_RE.test(String(cwd)) || [nodePath, core].some((v) => WIN32_LAUNCH_LINE_UNSAFE_RE.test(String(v)))) return null
    const launcher = joinDir(stateDir, HIDDEN_LAUNCHER_FILE_NAME)
    return {
      how: 'recipe-hidden',
      file: 'wscript.exe',
      args: ['//B', launcher],
      spawnOpts: { cwd, windowsHide: true },
      files: [{ path: launcher, content: hiddenLauncherVbs({ assistantId, cwd, nodePath, corePath: core }) }],
    }
  }
  const shellCommand = `${shellQuote(nodePath)} ${shellQuote(core)}`
  const spawnOpts = { cwd, windowsHide: true }
  if (hasTmux) {
    return {
      how: 'recipe-tmux',
      file: 'tmux',
      args: ['new-session', '-d', '-s', `hoai-${assistantId}`, '-c', cwd, shellCommand],
      spawnOpts,
    }
  }
  if (hasScript) {
    return platform === 'darwin'
      ? { how: 'recipe-script', file: 'script', args: ['-q', '/dev/null', nodePath, core], spawnOpts }
      : { how: 'recipe-script', file: 'script', args: ['-qc', shellCommand, '/dev/null'], spawnOpts }
  }
  // No visible Terminal or terminal emulator fallback any more: a window is a
  // viewer beside a running agent (lib/agent-windows.mjs), never its launch.
  return null
}

function firstLine(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? ''
}

function writeRestartMarker(agent, fs) {
  const path = joinDir(agent.stateDir, RESTART_MARKER_FILE_NAME)
  try {
    fs.writeFile(path, '{}')
    return {
      ok: true,
      how: 'marker',
      message: 'restart marker written; the live hoai launcher relaunches the agent as itself',
      detail: { path },
    }
  } catch (err) {
    return { ok: false, how: 'marker', message: `restart marker write failed at ${path}: ${String(err?.message ?? err)}` }
  }
}

/**
 * The pid of this agent's LIVE daemon, or null: the writer of a fresh
 * agent-state.json, else the holder of its pairing lock (`<credentials>.lock`,
 * stamped every 5 s by every daemon since 0.38.6, a legacy one included). A
 * live daemon means a live claude: the daemon is claude's MCP child and ends
 * with it. Windows has no cwd lookup and hoai-core no incumbent wait there, so
 * this is what stops a `schtasks /Run` from starting a second session beside an
 * orphaned claude or a person's own (F4, decision D4).
 * @param {Record<string, any>} agent
 * @param {{ fs: { readFile: (path: string) => string | null }, now: number, pidAlive: (pid: number) => boolean }} probe
 * @returns {number | null}
 */
export function liveAgentDaemonPid(agent, { fs, now, pidAlive }) {
  const state = agent?.pluginStateDir ? parseAgentState(fs.readFile(joinDir(agent.pluginStateDir, AGENT_STATE_FILE_NAME)), agent.assistantId) : null
  if (state && isAgentStateFresh(state, { now, pidAlive })) return state.pid
  const lock = agent?.credentialsPath ? parsePairingLock(fs.readFile(`${agent.credentialsPath}.lock`)) : null
  if (lock && Math.abs(now - lock.heartbeatAt) <= PAIRING_LOCK_FRESH_MS && pidAlive(lock.pid)) return lock.pid
  return null
}

/** launch-status outcomes only a SUPERVISED hoai writes (its expect gate, at
 *  startup): a person's own hoai writes no launch-status at all, and run.sh
 *  writes `starting` before hoai runs and `waiting-for-incumbent` while it
 *  waits behind a hand-run session. */
const SUPERVISED_LAUNCH_OUTCOMES = new Set(['live', 'live-but-not-signed-in', 'no-live-marker'])

/** Is this command line the agent's own service process: its tmux server on
 *  the agent's socket (`hoai-<id>-home-<hid>`, or the old `hoai-<id>`: one
 *  socket or a list, agentTmuxSockets; as started, `tmux -L <socket> ...`, or as
 *  Linux shows it once tmux has set its title, `tmux: server (/tmp/tmux-<uid>/<socket>)`),
 *  or its `<statedir>/run.sh`? */
export function isOwnServiceProcess(command, socket, runSh) {
  if (isOwnTmuxServer(command, socket)) return true
  return String(command ?? '').trim().split(/\s+/).includes(runSh)
}

/** The tmux half of isOwnServiceProcess: the server on one of the agent's sockets. */
function isOwnTmuxServer(command, socket) {
  const sockets = (Array.isArray(socket) ? socket : [socket]).filter((s) => typeof s === 'string' && s)
  const text = String(command ?? '').trim()
  if (text.startsWith('tmux: server (') && sockets.some((s) => text.endsWith(`/${s})`))) return true
  const argv = text.split(/\s+/)
  const base = (argv[0] ?? '').slice((argv[0] ?? '').lastIndexOf('/') + 1)
  return base === 'tmux' && argv.some((arg, i) => sockets.some((s) => arg === `-L${s}` || (arg === '-L' && argv[i + 1] === s)))
}

/**
 * Does the agent's own tmux server hold anything besides the launcher's pane?
 * run.sh's trap kills that WHOLE server on a service restart, and an agent's
 * Bash tool that runs `tmux new-session -d ...` (its $TMUX names this server)
 * puts a job there, outside claude's tree where the job scan looks. Unknown
 * (no table) counts as yes; no tmux server above the launcher is no.
 */
function ownTmuxServerHoldsMore({ processes, pid, socket }) {
  if (!Array.isArray(processes)) return true
  const byPid = new Map(processes.map((p) => [p.pid, p]))
  const seen = new Set()
  for (let child = byPid.get(pid); child && !seen.has(child.pid); child = byPid.get(child.ppid)) {
    seen.add(child.pid)
    const parent = byPid.get(child.ppid)
    if (parent && isOwnTmuxServer(parent.command, socket)) return processes.some((p) => p.ppid === parent.pid && p.pid !== child.pid)
  }
  return false
}

/**
 * Is the LIVE hoai launcher (supervisor.json) this agent's own canonical
 * service's child, rather than a person's `hoai` the service waits behind,
 * so that restarting the SERVICE restarts it and nothing else of the agent's?
 * Any one of: supervisor.json says `supervised: true`; the launcher descends
 * from the agent's tmux server (socket `hoai-<id>`) or its run.sh; or
 * launch-status carries an outcome only a supervised launch writes, written
 * at or after this launcher armed. Nothing at all proves it: a person's.
 * And its tmux server holds nothing else (ownTmuxServerHoldsMore): else the
 * service restart would kill a job the marker leaves running.
 * @param {{ agent: Record<string, any>, fs: { readFile: (p: string) => string | null, stat?: (p: string) => { mtimeMs: number } | null },
 *   processes: Array<{ pid: number, ppid: number, command: string }> | null }} input
 */
export function launcherIsServiceChild({ agent, fs, processes, platform = process.platform }) {
  if (!launcherProvenServiceChild({ agent, fs, processes, platform })) return false
  const pid = parseSupervisorFile(fs.readFile(joinDir(agent.stateDir, SUPERVISOR_FILE_NAME)))?.pid
  return !ownTmuxServerHoldsMore({ processes, pid, socket: agentTmuxSockets(agent, platform) })
}

function launcherProvenServiceChild({ agent, fs, processes, platform }) {
  const supervisorPath = joinDir(agent.stateDir, SUPERVISOR_FILE_NAME)
  const raw = fs.readFile(supervisorPath)
  try {
    if (JSON.parse(raw ?? 'null')?.supervised === true) return true
  } catch {
    // junk is not a declaration
  }
  const pid = parseSupervisorFile(raw)?.pid
  if (pid && Array.isArray(processes)) {
    const byPid = new Map(processes.map((p) => [p.pid, p]))
    const socket = agentTmuxSockets(agent, platform)
    const runSh = joinDir(agent.stateDir, 'run.sh')
    const seen = new Set([pid])
    let current = byPid.get(pid)
    while (current) {
      const parent = byPid.get(current.ppid)
      if (!parent || seen.has(parent.pid)) break
      if (isOwnServiceProcess(parent.command, socket, runSh)) return true
      seen.add(parent.pid)
      current = parent
    }
  }
  const statusPath = joinDir(agent.stateDir, LAUNCH_STATUS_FILE_NAME)
  if (!SUPERVISED_LAUNCH_OUTCOMES.has(parseLaunchStatusOutcome(fs.readFile(statusPath)))) return false
  const statusAt = fs.stat?.(statusPath)?.mtimeMs
  const armedAt = fs.stat?.(supervisorPath)?.mtimeMs
  return typeof statusAt === 'number' && typeof armedAt === 'number' && statusAt >= armedAt
}

/** A canonical bin/bgos-agent service of generation 2 (run.sh starting hoai) on launchd or systemd. */
export function canonicalV2Service(agent, platform) {
  if (platform === 'win32') return false
  const service = agent.service
  if (service?.via !== 'canonical-file' || (service.kind !== 'launchd' && service.kind !== 'systemd')) return false
  return typeof agent.supervisorGeneration === 'number' && agent.supervisorGeneration >= SUPERVISOR_GENERATION_CURRENT
}

/**
 * Which tier restartAgent takes for this agent, in its own order, pure: the
 * sweep asks BEFORE it acts, because a service restart on Linux kills the
 * unit's whole cgroup and must first be judged against it (F5), while the
 * marker and keepalive tiers only ever touch claude.
 * @param {Record<string, any>} agent
 * @param {{ platform: string, launcherServiceChild?: boolean, uid?: number | null }} input
 * @returns {'marker' | 'keepalive' | 'task' | 'service' | 'recipe'}
 */
export function restartTierFor(agent, { platform, launcherServiceChild = false, uid = null }) {
  if (agent.supervisor === 'launcher-live') return 'marker'
  const keepalive = agent.keepalive
  if (keepalive && Number.isInteger(keepalive.claudePid) && keepalive.claudePid > 1) return 'keepalive'
  if (agent.supervisor === 'service' && agent.launcherLive && !(launcherServiceChild && canonicalV2Service(agent, platform))) return 'marker'
  if (agent.supervisor === 'service' && agent.service?.kind === 'schtasks') return 'task'
  // A service file with no runnable restart command (no uid on darwin): the
  // recipe, never a blind service call.
  if (agent.supervisor === 'service' && serviceRestartCommand({ platform, assistantId: agent.assistantId, uid, service: agent.service ?? null })) return 'service'
  return 'recipe'
}

function defaultKill(pid, signal) {
  return process.kill(pid, signal)
}

function defaultHasCommand(name) {
  const dirs = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']
  return dirs.some((dir) => {
    try {
      return existsSync(`${dir}/${name}`)
    } catch {
      return false
    }
  })
}

/**
 * Restart an agent (an AgentRow from lib/agent-inventory.mjs listAgents).
 * Never throws; every outcome names its mechanism.
 * @param {import('./agent-inventory.mjs').AgentRow | Record<string, any>} agent
 * @param {{ platform?: string, pluginRoot?: string | null, nodePath?: string | null,
 *   fs?: import('./watcher-bundle.mjs').WatcherFs, exec?: import('./watcher-bundle.mjs').Exec,
 *   spawnDetached?: import('./watcher-bundle.mjs').SpawnDetached, now?: () => number,
 *   env?: Record<string, string | undefined>, uid?: number | null,
 *   hasTmux?: boolean, hasScript?: boolean, hasCommand?: (name: string) => boolean,
 *   kill?: (pid: number, signal: string) => unknown, pidAlive?: (pid: number) => boolean,
 *   processes?: Array<{ pid: number, ppid: number, command: string }> | null,
 *   launcherServiceChild?: boolean }} deps
 * @returns {Promise<{ ok: boolean, how: RestartHow, message: string, detail?: Record<string, unknown> }>}
 */
export async function restartAgent(agent, deps = {}) {
  const platform = deps.platform ?? process.platform
  const fs = deps.fs ?? nodeFs()
  const exec = deps.exec ?? nodeExec()
  const spawnDetached = deps.spawnDetached ?? nodeSpawnDetached()
  const env = deps.env ?? process.env
  const hasCommand = deps.hasCommand ?? defaultHasCommand
  const hasTmux = deps.hasTmux ?? (platform !== 'win32' && hasCommand('tmux'))
  const hasScript = deps.hasScript ?? (platform !== 'win32' && hasCommand('script'))
  const uid = deps.uid === undefined ? (typeof process.getuid === 'function' ? process.getuid() : null) : deps.uid
  const kill = deps.kill ?? defaultKill
  const pidAlive = deps.pidAlive ?? defaultPidAlive
  const now = deps.now ?? Date.now
  const id = agent.assistantId

  // A LIVE hoai launcher (its supervisor.json) is the process running claude.
  // A person's `hoai` that a canonical run.sh is WAITING behind (decision D4)
  // restarts through the marker: a kickstart -k / systemctl restart would only
  // restart the waiting run.sh (nothing restarted, verify failed, and three
  // sweeps later the agent read `failed`). So does the Windows task's hoai-core
  // --keep-alive, and any non-canonical service. But the marker leaves HOAI
  // ITSELF on the old code: when the live hoai is the canonical v2 service's
  // own child, the service restart is the right one, since run.sh resolves the
  // CURRENT plugin root and starts a new hoai from it, which resumes the pin.
  let serviceChild = false
  if (agent.supervisor === 'service' && agent.launcherLive && !agent.keepalive && canonicalV2Service(agent, platform)) {
    if (typeof deps.launcherServiceChild === 'boolean') serviceChild = deps.launcherServiceChild
    else {
      let processes = Array.isArray(deps.processes) ? deps.processes : null
      if (!processes) {
        const listed = await listProcesses({ platform, exec, env })
        processes = listed.ok ? listed.processes : null
      }
      serviceChild = launcherIsServiceChild({ agent, fs, processes, platform })
    }
  }
  const tier = restartTierFor(agent, { platform, launcherServiceChild: serviceChild, uid })
  if (tier === 'marker') return writeRestartMarker(agent, fs)

  // The keepalive tier: the signal goes to the claude the VERIFIED marker
  // declared, and to nothing else. A failed signal is reported, never a fall
  // through: the next tier down is the bespoke job, whose restart is exactly
  // the orphaning this tier exists to avoid.
  const keepalive = agent.keepalive
  if (tier === 'keepalive') {
    try {
      kill(keepalive.claudePid, 'SIGTERM')
      return {
        ok: true,
        how: 'keepalive',
        message: `SIGTERM sent to claude ${keepalive.claudePid}; its keepalive script (pid ${keepalive.pid}) relaunches it`,
        detail: { pid: keepalive.claudePid, keepalivePid: keepalive.pid },
      }
    } catch (err) {
      return { ok: false, how: 'keepalive', message: `SIGTERM to claude ${keepalive.claudePid} failed: ${String(err?.code ?? err?.message ?? err)}` }
    }
  }

  if (tier === 'task') {
    const name = String(agent.service.handle ?? '')
    if (!AGENT_TASK_NAME_RE.test(name)) {
      return { ok: false, how: 'task', message: `refusing to start a task whose name is not "HOAI Agent <id> home-<hid>": ${JSON.stringify(name)}` }
    }
    // The launcher is dead but the agent's claude may not be (Windows does not
    // end children with their parent, and a person may run it by hand): the
    // task's hoai-core has no incumbent wait on win32 and would resume the same
    // pin beside it. It starts once that session has ended.
    const daemon = liveAgentDaemonPid(agent, { fs, now: now(), pidAlive })
    if (daemon !== null) {
      return { ok: false, how: 'task', message: `session_without_launcher: agent ${id} still runs (daemon pid ${daemon}) with no launcher; the task starts once that session ends` }
    }
    // Which task is THIS HOME's is read back first (lib/agent-task-win32.mjs
    // runAgentTask): its own, or its old one while it is not renamed yet;
    // another HOME's task, or one whose HOME cannot be read, is never started.
    const home = agentHomeOf(agent)
    let reg = null
    try {
      reg = home ? agentTaskRegistration({ assistantId: id, home }) : null
    } catch {
      reg = null
    }
    if (!reg) return { ok: false, how: 'task', message: `refused: which HOME agent ${id}'s task belongs to is unknown (no HOME on the row); nothing was started` }
    const started = await runAgentTask(reg, { exec, fs, timeoutMs: RESTART_EXEC_TIMEOUT_MS })
    if (started.ok) {
      return { ok: true, how: 'task', message: started.message, detail: { command: { file: 'schtasks.exe', args: ['/Run', '/TN', started.name] }, notes: started.notes } }
    }
    return { ok: false, how: 'task', message: started.message, detail: { notes: started.notes } }
  }

  if (tier === 'service') {
    const cmd = serviceRestartCommand({ platform, assistantId: id, uid, service: agent.service ?? null })
    // A canonical agent service (this HOME's name, or its old one) is read back
    // before it is restarted: one another HOME installed is never kicked.
    if (agent.service?.via === 'canonical-file') {
      const home = agentHomeOf(agent)
      const read = home
        ? await readBackAgentService({ platform, home, assistantId: id, uid, handle: agent.service.handle }, { exec: (file, args) => exec(file, args, { timeoutMs: RESTART_EXEC_TIMEOUT_MS }), fs })
        : { state: 'unknown', refusal: `refused: which HOME agent ${id}'s service belongs to is unknown (no HOME on the row); nothing was restarted` }
      if (read.state === 'foreign' || read.state === 'unknown') return { ok: false, how: 'service', message: read.refusal }
    }
    const result = await exec(cmd.file, cmd.args, { timeoutMs: RESTART_EXEC_TIMEOUT_MS })
    if (result.code === 0) {
      return { ok: true, how: 'service', message: `${cmd.file} ${cmd.args.join(' ')} ok`, detail: { command: cmd } }
    }
    const reason = firstLine(result.stderr) || firstLine(result.stdout) || String(result.error ?? '') || 'no output'
    return { ok: false, how: 'service', message: `${cmd.file} ${cmd.args.join(' ')} failed (rc ${result.code}${result.timedOut ? ', timed out' : ''}): ${reason}` }
  }

  const recipe = agent.recipe
  const cwd = recipe?.cwd || agent.cwd
  if (!recipe || !cwd) {
    const why = (agent.notes ?? []).join(', ')
    return {
      ok: false,
      how: 'none',
      message: `manual_restart_required: no live launcher, no service, no usable launch recipe${why ? ` (${why})` : ''}`,
    }
  }
  const pluginRoot = String(deps.pluginRoot ?? '').trim() || recipe.pluginRoot
  const nodePath = String(deps.nodePath ?? '').trim() || recipe.node || 'node'
  if (!pluginRoot) {
    return { ok: false, how: 'none', message: 'manual_restart_required: no plugin root known for the relaunch' }
  }
  if (platform === 'win32') {
    // The task tier's guard (F4, D4), for the hidden one shot too: Windows does not end children
    // with their launcher and hoai-core has no incumbent wait there, so a session this agent still
    // runs with no launcher (an orphaned claude, a person's own) would get a second one beside it.
    const daemon = liveAgentDaemonPid(agent, { fs, now: now(), pidAlive })
    if (daemon !== null) {
      return { ok: false, how: 'recipe-hidden', message: `session_without_launcher: agent ${id} still runs (daemon pid ${daemon}) with no launcher; not starting a second session beside it` }
    }
  }
  const command = recipeLaunchCommand({ platform, assistantId: id, cwd, nodePath, pluginRoot, stateDir: agent.stateDir ?? null, hasTmux, hasScript })
  if (!command) {
    if (platform === 'win32') {
      return {
        ok: false,
        how: 'none',
        message: !agent.stateDir
          ? `hidden_launch_unavailable: no state folder for agent ${id} to hold its launcher; start the agent by hand: cd ${cwd} && hoai`
          : `hidden_launch_unavailable: a quote or a percent sign in the agent folder, node or plugin path cannot be launched hidden; start the agent by hand: cd ${cwd} && hoai`,
      }
    }
    return {
      ok: false,
      how: 'none',
      message: `no_pty_available: install tmux (preferred) or script, or start the agent by hand: cd ${cwd} && hoai`,
    }
  }
  try {
    for (const file of command.files ?? []) fs.writeFile(file.path, file.content)
  } catch (err) {
    return { ok: false, how: command.how, message: `launch file write failed: ${String(err?.message ?? err)}` }
  }
  try {
    // The AGENT's Claude config dir, not the watcher's: a recipe that
    // recorded none was launched without the variable, so it is removed.
    const spawned = spawnDetached(command.file, command.args, { ...command.spawnOpts, env: envForRecipe(env, recipe) })
    return {
      ok: true,
      how: command.how,
      message: `launched ${command.file} in ${cwd}`,
      detail: { command: { file: command.file, args: command.args }, pid: spawned?.pid ?? null },
    }
  } catch (err) {
    return { ok: false, how: command.how, message: `launch via ${command.file} failed: ${String(err?.message ?? err)}` }
  }
}
