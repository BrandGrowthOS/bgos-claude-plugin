/**
 * agent-restart: restart ONE agent through the strongest restart authority
 * it has, per the ladder in design 1.5 / 7.4:
 *
 *   launcher-live   write ~/.bgos-agent/<id>/restart-requested.json ({}):
 *                   the live hoai supervisor (bin/hoai-core.mjs) sees the
 *                   marker, SIGTERMs claude and relaunches it RESUMING that
 *                   agent's own pinned session. Existence only, contents
 *                   ignored on the other side.
 *   service         launchctl kickstart -k gui/<uid>/ai.bgos.agent.<id> on
 *                   darwin, systemctl --user restart bgos-agent-<id> on linux
 *                   (the always-on per-agent service from bin/bgos-agent).
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

import { RESTART_MARKER_FILE_NAME, joinDir, serviceLabel, serviceUnit, validAssistantId } from './agent-inventory.mjs'
import { joinRel, nodeExec, nodeFs, nodeSpawnDetached } from './watcher-bundle.mjs'
import { existsSync } from 'node:fs'

/** @typedef {'marker' | 'service' | 'recipe-tmux' | 'recipe-script' | 'recipe-terminal' | 'recipe-console' | 'none'} RestartHow */

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
 */
export function serviceRestartCommand({ platform, assistantId, uid }) {
  const id = validAssistantId(assistantId)
  if (!id) return null
  if (platform === 'linux') return { file: 'systemctl', args: ['--user', 'restart', serviceUnit(id)] }
  if (platform === 'darwin') {
    if (uid === null || uid === undefined || !Number.isInteger(uid) || uid < 0) return null
    return { file: 'launchctl', args: ['kickstart', '-k', `gui/${uid}/${serviceLabel(id)}`] }
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
 *   hasTmux?: boolean, hasScript?: boolean, hasCommand?: (name: string) => boolean }} deps
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
  const id = agent.assistantId

  if (agent.supervisor === 'launcher-live') {
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

  if (agent.supervisor === 'service') {
    const cmd = serviceRestartCommand({ platform, assistantId: id, uid })
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
