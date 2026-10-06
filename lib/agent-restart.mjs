/**
 * agent-restart: restart ONE agent through the strongest restart authority
 * it has, per the ladder in design 1.5 / 7.4:
 *
 *   launcher-live   write ~/.bgos-agent/<id>/restart-requested.json ({}):
 *                   the live hoai supervisor (bin/hoai-core.mjs) sees the
 *                   marker, SIGTERMs claude and relaunches it RESUMING that
 *                   agent's own pinned session. Existence only, contents
 *                   ignored on the other side. Also taken for a SERVICE row
 *                   whose launcher is live (launcherLive): the hoai-core under
 *                   it, or a person's `hoai` the service waits behind (D4).
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
 *                   the dev-channels gate). It needs a pty / a window:
 *                     posix   tmux new-session -d -s hoai-<id> -c <cwd> "..."
 *                             else script (-q /dev/null ... on darwin,
 *                             -qc "..." /dev/null on linux) detached,
 *                             else a visible terminal (osascript Terminal /
 *                             x-terminal-emulator / gnome-terminal / konsole /
 *                             xterm, the bootstrap's fallback order)
 *                     win32   cmd.exe /c start "HOAI agent <id>" /D "<cwd>"
 *                             cmd /k "<node> <core>" (a visible console; the
 *                             user never types in it)
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

import { RESTART_MARKER_FILE_NAME, defaultPidAlive, joinDir, serviceLabel, serviceUnit, validAssistantId } from './agent-inventory.mjs'
import { AGENT_STATE_FILE_NAME, PAIRING_LOCK_FRESH_MS, isAgentStateFresh, parseAgentState, parsePairingLock } from './keepalive-plan.mjs'
import { serviceRestartCommandForHandle } from './service-supervision.mjs'
import { joinRel, nodeExec, nodeFs, nodeSpawnDetached } from './watcher-bundle.mjs'
import { existsSync } from 'node:fs'

/** @typedef {'marker' | 'keepalive' | 'service' | 'task' | 'recipe-tmux' | 'recipe-script' | 'recipe-terminal' | 'recipe-console' | 'none'} RestartHow */

/** The only task name a win32 restart may address: built from a digits-only id
 *  by lib/agent-inventory.mjs agentTaskName, re-checked here because it rides an
 *  argv into schtasks. */
const AGENT_TASK_NAME_RE = /^HOAI Agent \d+$/

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

const LINUX_TERMINALS = [
  { file: 'x-terminal-emulator', prefix: ['-e'] },
  { file: 'gnome-terminal', prefix: ['--'] },
  { file: 'konsole', prefix: ['-e'] },
  { file: 'xterm', prefix: ['-e'] },
]

/** cmd.exe metacharacters that must never ride a verbatim command line. */
const WIN32_CMD_UNSAFE_RE = /["&|<>^%!\r\n]/

/** The relaunch env: the recipe's claudeConfigDir set, or the key removed when the recipe has none. */
export function envForRecipe(env, recipe) {
  const next = { ...(env ?? {}) }
  const dir = String(recipe?.claudeConfigDir ?? '').trim()
  if (dir) next.CLAUDE_CONFIG_DIR = dir
  else delete next.CLAUDE_CONFIG_DIR
  return next
}

/**
 * The pure launch command for a recipe restart, or null when no mechanism is
 * available on this host.
 * @param {{ platform: string, assistantId: string, cwd: string, nodePath: string,
 *   pluginRoot: string, comspec?: string, hasTmux?: boolean, hasScript?: boolean,
 *   hasCommand?: (name: string) => boolean }} params
 * @returns {{ how: RestartHow, file: string, args: string[], spawnOpts: Record<string, unknown> } | null}
 */
export function recipeLaunchCommand({
  platform,
  assistantId,
  cwd,
  nodePath,
  pluginRoot,
  comspec = 'cmd.exe',
  hasTmux = false,
  hasScript = false,
  hasCommand = () => false,
}) {
  const core = hoaiCorePath(pluginRoot)
  if (platform === 'win32') {
    // windowsVerbatimArguments hands cmd.exe the line as-is, so every cmd
    // metacharacter (not only the quote) must be absent from what we embed.
    if ([cwd, nodePath, core].some((v) => WIN32_CMD_UNSAFE_RE.test(String(v)))) return null
    return {
      how: 'recipe-console',
      file: comspec,
      args: ['/c', 'start', `"HOAI agent ${assistantId}"`, '/D', `"${cwd}"`, 'cmd', '/k', `""${nodePath}" "${core}""`],
      spawnOpts: { cwd, windowsVerbatimArguments: true, windowsHide: false },
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
  if (platform === 'darwin') {
    const line = `cd ${shellQuote(cwd)} && ${shellCommand}`
    return {
      how: 'recipe-terminal',
      file: 'osascript',
      args: ['-e', `tell application "Terminal" to do script "${line.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`],
      spawnOpts,
    }
  }
  for (const terminal of LINUX_TERMINALS) {
    if (!hasCommand(terminal.file)) continue
    return {
      how: 'recipe-terminal',
      file: terminal.file,
      args: [...terminal.prefix, 'bash', '-c', `${shellCommand}; exec bash`],
      spawnOpts,
    }
  }
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
 *   env?: Record<string, string | undefined>, uid?: number | null, comspec?: string,
 *   hasTmux?: boolean, hasScript?: boolean, hasCommand?: (name: string) => boolean,
 *   kill?: (pid: number, signal: string) => unknown, pidAlive?: (pid: number) => boolean }} deps
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
  const comspec = deps.comspec ?? (String(env.ComSpec ?? env.COMSPEC ?? '').trim() || 'cmd.exe')
  const kill = deps.kill ?? defaultKill
  const pidAlive = deps.pidAlive ?? defaultPidAlive
  const now = deps.now ?? Date.now
  const id = agent.assistantId

  if (agent.supervisor === 'launcher-live') return writeRestartMarker(agent, fs)

  // The keepalive tier: the signal goes to the claude the VERIFIED marker
  // declared, and to nothing else. A failed signal is reported, never a fall
  // through: the next tier down is the bespoke job, whose restart is exactly
  // the orphaning this tier exists to avoid.
  const keepalive = agent.keepalive
  if (keepalive && Number.isInteger(keepalive.claudePid) && keepalive.claudePid > 1) {
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

  // A LIVE hoai launcher (its supervisor.json) is the process running claude,
  // whatever service sits above or beside it, so the marker restarts claude in
  // place, resuming the pin. On every platform: the Windows task's hoai-core
  // --keep-alive, and on posix both run.sh's own hoai-core in tmux and a
  // person's `hoai` that a canonical run.sh is WAITING behind (decision D4).
  // In that last case a kickstart -k / systemctl restart only restarted the
  // waiting run.sh: nothing restarted, verify failed, and three sweeps later
  // the agent read `failed`.
  if (agent.supervisor === 'service' && agent.launcherLive) return writeRestartMarker(agent, fs)

  if (agent.supervisor === 'service' && agent.service?.kind === 'schtasks') {
    const name = String(agent.service.handle ?? '')
    if (!AGENT_TASK_NAME_RE.test(name)) {
      return { ok: false, how: 'task', message: `refusing to start a task whose name is not "HOAI Agent <id>": ${JSON.stringify(name)}` }
    }
    // The launcher is dead but the agent's claude may not be (Windows does not
    // end children with their parent, and a person may run it by hand): the
    // task's hoai-core has no incumbent wait on win32 and would resume the same
    // pin beside it. It starts once that session has ended.
    const daemon = liveAgentDaemonPid(agent, { fs, now: now(), pidAlive })
    if (daemon !== null) {
      return { ok: false, how: 'task', message: `session_without_launcher: agent ${id} still runs (daemon pid ${daemon}) with no launcher; the task starts once that session ends` }
    }
    const args = ['/Run', '/TN', name]
    const result = await exec('schtasks.exe', args)
    if (result.code === 0) return { ok: true, how: 'task', message: `schtasks.exe ${args.join(' ')} ok`, detail: { command: { file: 'schtasks.exe', args } } }
    const reason = firstLine(result.stderr) || firstLine(result.stdout) || String(result.error ?? '') || 'no output'
    return { ok: false, how: 'task', message: `schtasks.exe ${args.join(' ')} failed (rc ${result.code}): ${reason}` }
  }

  if (agent.supervisor === 'service') {
    const cmd = serviceRestartCommand({ platform, assistantId: id, uid, service: agent.service ?? null })
    if (cmd) {
      const result = await exec(cmd.file, cmd.args)
      if (result.code === 0) {
        return { ok: true, how: 'service', message: `${cmd.file} ${cmd.args.join(' ')} ok`, detail: { command: cmd } }
      }
      const reason = firstLine(result.stderr) || firstLine(result.stdout) || String(result.error ?? '') || 'no output'
      return { ok: false, how: 'service', message: `${cmd.file} ${cmd.args.join(' ')} failed (rc ${result.code}): ${reason}` }
    }
    // A service file with no runnable restart command (no uid on darwin):
    // fall through to the recipe, never a blind service call.
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
  const command = recipeLaunchCommand({ platform, assistantId: id, cwd, nodePath, pluginRoot, comspec, hasTmux, hasScript, hasCommand })
  if (!command) {
    return {
      ok: false,
      how: 'recipe-terminal',
      message: `no_pty_or_terminal_available: install tmux (preferred) or script, or start the agent by hand: cd ${cwd} && hoai`,
    }
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
