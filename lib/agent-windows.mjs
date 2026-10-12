/**
 * agent-windows: the watcher's windows pass for Show agent windows (board row d133ddb2), run right
 * after every keep-alive sweep, whatever the computer's Keep agents running switch says. The rules
 * are in lib/agent-windows-plan.mjs; this module looks at the machine and acts on them.
 *
 * Every agent runs hidden (lib/agent-restart.mjs, lib/agent-task-win32.mjs, bin/bgos-agent's tmux).
 * A window is only a VIEWER beside a running agent:
 *
 *   Windows       bin/hoai-agent-viewer.vbs (wscript //B, so no console flashes) runs
 *                 bin/hoai-agent-viewer.ps1, which attaches to the agent's hidden console (its
 *                 hoai launcher's, supervisor.json) and mirrors the screen in a window of its own.
 *                 Watch only (Kc's choice 3): it reads the screen buffer and has no way to type.
 *                 The agent's name rides HOAI_VIEWER_NAME; every argument is digits.
 *   Mac           <statedir>/view-agent.command, opened with `open -g -a Terminal` (no Apple
 *                 events, so no Automation prompt): a read only `tmux attach-session -r` on the
 *                 agent's session.
 *   Linux         the first terminal emulator found, running the same read only attach, when the
 *                 watcher has a screen (DISPLAY or WAYLAND_DISPLAY).
 *
 * Closing: on Windows the viewer process (found by its command line, never anything else) ends; on
 * a Mac or Linux the READ ONLY tmux clients of the agent's session are detached (a person's own
 * read-write `hoai-agent attach` never is). Nothing here starts, stops or restarts an agent, sends
 * a key, or runs a tmux command that touches a session.
 *
 * Windows also hides in place, once per launcher, a console a supervisor left on screen: the
 * minimized console of a task launcher written before style 0, and the visible console of the old
 * `cmd /k` create_agent launch. Only when the launcher's parent is that wscript run-agent.vbs or that
 * cmd /k, so a person's own console is never touched; hiding is ShowWindow(SW_HIDE), never a close.
 *
 * Every effect is injected (fs, exec, spawnDetached, kill, listAgents, the process table), so the
 * whole pass runs against fakes in test/agent-windows.test.ts. Plain JavaScript, node >= 18.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { AGENT_TASK_LAUNCHER_FILE_NAME, SUPERVISOR_FILE_NAME, joinDir, listAgents, parseSupervisorRecord, validAssistantId } from './agent-inventory.mjs'
import { shellQuote } from './agent-restart.mjs'
import { emptyViewerMemory, planViewers, windowsCapability } from './agent-windows-plan.mjs'
import { listProcesses } from './process-tree.mjs'

export const VIEWER_SCRIPT_FILE_NAME = 'hoai-agent-viewer.ps1'
export const VIEWER_LAUNCHER_FILE_NAME = 'hoai-agent-viewer.vbs'
export const POSIX_VIEWER_FILE_NAME = 'view-agent.command'

/** How long one tmux query, the hide helper or `open` may take. */
const COMMAND_TIMEOUT_MS = 30_000
/** At most this many launcher pids are remembered as already looked at (hide in place). */
const CHECKED_MAX = 256

const LINUX_TERMINALS = [
  { file: 'x-terminal-emulator', prefix: ['-e'] },
  { file: 'gnome-terminal', prefix: ['--'] },
  { file: 'konsole', prefix: ['-e'] },
  { file: 'xterm', prefix: ['-e'] },
]

/** The bin folder beside this module: the watcher bundle's own (or the plugin's, run from a checkout). */
export function defaultViewerDir() {
  return fileURLToPath(new URL('../bin/', import.meta.url)).replace(/[\\/]+$/, '')
}

/**
 * A command's absolute path: PATH first, then the fixed dirs a service PATH may lack (Homebrew,
 * /usr/local, ~/.local/bin, /usr/bin, /bin). Null when it is nowhere.
 * @param {string} name
 * @param {{ env?: Record<string, string | undefined>, home?: string, exists?: (path: string) => boolean }} params
 */
export function findTool(name, { env = {}, home = '', exists = existsSync } = {}) {
  const dirs = String(env.PATH ?? '')
    .split(':')
    .filter((d) => d.startsWith('/'))
  for (const extra of ['/opt/homebrew/bin', '/usr/local/bin', home ? `${home}/.local/bin` : '', '/usr/bin', '/bin']) {
    if (extra && !dirs.includes(extra)) dirs.push(extra)
  }
  for (const dir of dirs) {
    const path = `${dir}/${name}`
    try {
      if (exists(path)) return path
    } catch {
      // unreadable dir: next
    }
  }
  return null
}

/** The agent's name as its folder spells it, for a window title; `Agent <id>` when there is none. */
function viewerName(row) {
  const base = String(row?.cwd ?? '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop()
  const clean = String(base ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 60)
  return clean || `Agent ${row?.assistantId ?? ''}`.trim()
}

function withoutTmux(env) {
  const next = { ...(env ?? {}) }
  delete next.TMUX
  delete next.TMUX_PANE
  return next
}

/**
 * What this computer can show, without looking at agents or the setting.
 * @param {{ platform: string, env?: Record<string, string | undefined>, home?: string, fs?: { exists?: (p: string) => boolean },
 *   hasTmux?: boolean, tmuxPath?: string | null, hasCommand?: (name: string) => boolean }} ctx
 */
export function windowsCapabilityFor(ctx) {
  const { platform } = ctx
  const env = ctx.env ?? {}
  const exists = typeof ctx.fs?.exists === 'function' ? (p) => ctx.fs.exists(p) : existsSync
  if (platform === 'win32') return { ...windowsCapability({ platform }), tmuxPath: null, terminal: null }
  let tmuxPath = ctx.tmuxPath !== undefined ? ctx.tmuxPath : findTool('tmux', { env, home: ctx.home, exists })
  if (!tmuxPath && ctx.hasTmux === true) tmuxPath = 'tmux'
  if (ctx.hasTmux === false) tmuxPath = null
  const hasCommand = ctx.hasCommand ?? ((name) => findTool(name, { env, home: ctx.home, exists }) !== null)
  const terminal = platform === 'linux' ? LINUX_TERMINALS.find((t) => hasCommand(t.file)) ?? null : null
  const capability = windowsCapability({
    platform,
    hasTmux: Boolean(tmuxPath),
    hasScreen: Boolean(String(env.DISPLAY ?? '').trim() || String(env.WAYLAND_DISPLAY ?? '').trim()),
    hasTerminal: terminal !== null,
  })
  return { ...capability, tmuxPath, terminal }
}

/** The heartbeat's windows block before this watcher's first pass: what it can do, the setting read as off. */
export function initialWindowsReport(ctx) {
  const capability = windowsCapabilityFor(ctx)
  return capability.mode === 'none' ? { mode: 'none', reason: capability.reason } : { mode: capability.mode, reason: 'setting_off' }
}

function reportFor(mode, show, failed) {
  if (!show) return { mode, reason: 'setting_off' }
  return { mode, reason: failed ? 'open_failed' : 'showing' }
}

/**
 * One windows pass. Never throws past its own effects' failures (each is caught and counted).
 * @param {{ platform: string, home: string, env: Record<string, string | undefined>,
 *   fs: import('./watcher-bundle.mjs').WatcherFs, exec: import('./watcher-bundle.mjs').Exec,
 *   spawnDetached: import('./watcher-bundle.mjs').SpawnDetached, kill?: (pid: number, signal: string) => unknown,
 *   now: () => number, log?: (line: string) => void, show: boolean, memory?: ReturnType<typeof emptyViewerMemory> | null,
 *   pidAlive?: (pid: number) => boolean, execSync?: (file: string, args: string[]) => { code: number, stdout: string },
 *   uid?: number | null, listAgents?: (params: Record<string, unknown>) => Array<Record<string, any>>,
 *   viewerDir?: string, hasTmux?: boolean, tmuxPath?: string | null, hasCommand?: (name: string) => boolean }} ctx
 * @returns {Promise<{ report: { mode: string, reason: string }, memory: import("./agent-windows-plan.mjs").ViewerMemory }>}
 */
export async function runWindowsPass(ctx) {
  const prior = { ...emptyViewerMemory(), ...(ctx.memory ?? {}) }
  const show = ctx.show === true
  const capability = windowsCapabilityFor(ctx)
  if (capability.mode === 'none') {
    return { report: { mode: 'none', reason: capability.reason ?? 'unsupported' }, memory: { ...prior, lastShow: show, scanned: true } }
  }
  return ctx.platform === 'win32' ? win32Pass(ctx, prior, show) : tmuxPass(ctx, prior, show, capability)
}

function agentRows(ctx) {
  const list = ctx.listAgents ?? listAgents
  return list({
    home: ctx.home,
    env: ctx.env,
    platform: ctx.platform,
    fs: ctx.fs,
    ...(ctx.pidAlive ? { pidAlive: ctx.pidAlive } : {}),
    ...(ctx.execSync ? { execSync: ctx.execSync } : {}),
    now: ctx.now(),
    ...(ctx.uid !== undefined ? { uid: ctx.uid } : {}),
  })
}

// -- Windows ----------------------------------------------------------------------------------

/** A viewer's command line: powershell running hoai-agent-viewer.ps1 in view mode, and its two digits. */
function parseViewerCommand(command) {
  const text = String(command ?? '')
  if (!text.toLowerCase().includes(VIEWER_SCRIPT_FILE_NAME)) return null
  if (/-Mode\s+hide\b/i.test(text)) return null
  const id = /-AssistantId\s+(\d+)\b/i.exec(text)?.[1]
  const consolePid = /-ConsolePid\s+(\d+)\b/i.exec(text)?.[1]
  return id && consolePid ? { id, consolePid: Number(consolePid) } : null
}

/** The launcher's parent is a supervisor's launch that may have shown a console: 'task' (the agent
 *  task's wscript of run-agent.vbs, style 7 before this release) or 'recipe' (the old create_agent
 *  `cmd /k`); null for anything else, a person's own shell above all. */
function supervisorConsoleParent(parentCommand) {
  const text = String(parentCommand ?? '')
  if (/wscript(\.exe)?"?\s/i.test(text) && /run-agent\.vbs/i.test(text)) return 'task'
  return /(^|[\\/\s"])cmd(\.exe)?"?\s+\/k\s/i.test(text) && /hoai-core\.mjs/i.test(text) ? 'recipe' : null
}

/** A task launcher started from a hidden (style 0) run-agent.vbs that was already on disk then:
 *  its console was never shown, so there is nothing to hide (no PowerShell spent on it). */
function startedHidden(ctx, row, startedAtMs) {
  const path = joinDir(row.stateDir, AGENT_TASK_LAUNCHER_FILE_NAME)
  const text = String(ctx.fs.readFile(path) ?? '')
  const writtenAt = ctx.fs.stat?.(path)?.mtimeMs
  return /, 0, True\)\s*$/.test(text) && typeof writtenAt === 'number' && typeof startedAtMs === 'number' && writtenAt < startedAtMs
}

/** Live launcher pids from the agents' supervisor.json files: files only, no process query. */
function liveLauncherPids(ctx) {
  const root = joinDir(ctx.home, '.bgos-agent')
  let names = []
  try {
    names = ctx.fs.listDir(root) ?? []
  } catch {
    names = []
  }
  const pidAlive = ctx.pidAlive ?? (() => false)
  const pids = []
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const record = parseSupervisorRecord(ctx.fs.readFile(joinDir(joinDir(root, name), SUPERVISOR_FILE_NAME)))
    if (record && !record.declaredLauncher && pidAlive(record.pid)) pids.push(record.pid)
  }
  return pids
}

async function win32Pass(ctx, prior, show) {
  const log = ctx.log ?? (() => {})
  const checked = new Set(prior.consolesChecked ?? [])
  const livePids = liveLauncherPids(ctx)
  const unchecked = livePids.some((pid) => !checked.has(pid))
  if (!show && prior.lastShow !== true && prior.scanned && !unchecked) {
    return { report: { mode: 'viewer', reason: 'setting_off' }, memory: { ...prior, lastShow: false } }
  }
  const table = await listProcesses({ platform: 'win32', exec: ctx.exec, env: ctx.env })
  if (!table.ok) {
    log(`windows: process table unreadable (${table.error}); no viewer opened or closed this pass`)
    return { report: reportFor('viewer', show, true), memory: prior }
  }
  const byPid = new Map(table.processes.map((p) => [p.pid, p]))
  const viewerDir = String(ctx.viewerDir ?? defaultViewerDir()).replace(/[\\/]+$/, '')
  const script = joinDir(viewerDir, VIEWER_SCRIPT_FILE_NAME)
  const launcher = joinDir(viewerDir, VIEWER_LAUNCHER_FILE_NAME)

  const agents = []
  for (const row of agentRows(ctx)) {
    const id = validAssistantId(row.assistantId)
    if (!id || !row.launcherLive || !row.stateDir) continue
    const record = parseSupervisorRecord(ctx.fs.readFile(joinDir(row.stateDir, SUPERVISOR_FILE_NAME)))
    if (!record || record.declaredLauncher) continue
    const proc = byPid.get(record.pid)
    if (!proc) continue
    agents.push({ id, session: `pid:${record.pid}`, startedAtMs: record.startedAtMs ?? proc.startedAtMs ?? null, pid: record.pid, name: viewerName(row) })
    if (!checked.has(record.pid)) {
      checked.add(record.pid)
      const parent = supervisorConsoleParent(byPid.get(proc.ppid)?.command)
      if (parent === 'recipe' || (parent === 'task' && !startedHidden(ctx, row, proc.startedAtMs))) {
        const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ConsolePid', String(record.pid), '-AssistantId', id, '-Mode', 'hide']
        try {
          const res = await ctx.exec('powershell.exe', args, { timeoutMs: COMMAND_TIMEOUT_MS, env: ctx.env })
          const outcome =
            res?.code === 0
              ? 'hidden in place'
              : res?.code === 4
                ? "not hidden: Windows Terminal hosts it (it shows until the agent's next start, which is hidden)"
                : `not hidden (rc ${res?.code ?? 'null'})`
          log(`windows: agent ${id}: its console (launcher ${record.pid}) ${outcome}`)
        } catch (err) {
          log(`windows: agent ${id}: console not hidden: ${String(err?.message ?? err)}`)
        }
      }
    }
  }
  const viewers = []
  for (const p of table.processes) {
    const parsed = parseViewerCommand(p.command)
    if (parsed) viewers.push({ id: parsed.id, session: `pid:${parsed.consolePid}`, handle: p.pid })
  }

  const plan = planViewers({ show, agents, viewers, memory: prior, now: ctx.now() })
  for (const viewer of plan.close) {
    try {
      ctx.kill?.(viewer.handle, 'SIGTERM')
      log(`windows: viewer ${viewer.handle} of agent ${viewer.id} closed`)
    } catch {
      // already gone
    }
  }
  let failed = false
  for (const agent of plan.open) {
    try {
      ctx.spawnDetached('wscript.exe', ['//B', launcher, '-ConsolePid', String(agent.pid), '-AssistantId', agent.id], {
        cwd: viewerDir,
        windowsHide: true,
        env: { ...ctx.env, HOAI_VIEWER_NAME: agent.name },
      })
      log(`windows: viewer opened for agent ${agent.id}`)
    } catch (err) {
      failed = true
      log(`windows: viewer for agent ${agent.id} not opened: ${String(err?.message ?? err)}`)
    }
  }
  // Every live pid a supervisor.json names has now been looked at, launcher or not (a pid reused
  // by another process included): an off setting then costs no process listing until one changes.
  for (const pid of livePids) checked.add(pid)
  const memory = {
    ...plan.memory,
    scanned: true,
    consolesChecked: [...checked].slice(-CHECKED_MAX),
    openFailed: show && (plan.memory.openFailed || failed),
  }
  return { report: reportFor('viewer', show, memory.openFailed), memory }
}

// -- Mac and Linux (tmux) -------------------------------------------------------------------------

async function tmuxQuery(ctx, tmuxPath, socket, args) {
  const full = socket ? ['-L', socket, ...args] : args
  try {
    const res = await ctx.exec(tmuxPath, full, { timeoutMs: COMMAND_TIMEOUT_MS, env: withoutTmux(ctx.env) })
    return res?.code === 0 ? String(res.stdout ?? '') : null
  } catch {
    return null
  }
}

async function tmuxServer(ctx, tmuxPath, socket) {
  const sessionsOut = await tmuxQuery(ctx, tmuxPath, socket, ['list-sessions', '-F', '#{session_name}\t#{session_created}'])
  if (sessionsOut === null) return { sessions: new Map(), clients: [] }
  const sessions = new Map()
  for (const line of sessionsOut.split('\n')) {
    const [name, created] = line.split('\t')
    if (name) sessions.set(name, Number(created) || 0)
  }
  const clientsOut = (await tmuxQuery(ctx, tmuxPath, socket, ['list-clients', '-F', '#{client_name}\t#{client_pid}\t#{client_readonly}\t#{session_name}'])) ?? ''
  const clients = []
  for (const line of clientsOut.split('\n')) {
    const [name, pid, readonly, session] = line.split('\t')
    if (name && session) clients.push({ name, pid: Number(pid) || null, readonly: readonly === '1', session })
  }
  return { sessions, clients }
}

function commandFileText({ id, name, tmuxPath, socket, session }) {
  const target = `=${session}`
  return [
    '#!/bin/sh',
    `# HOAI agent ${id}: a read only window on this agent's tmux session (Show agent windows).`,
    '# Written by lib/agent-windows.mjs. Closing this window only detaches it; the agent keeps running.',
    `printf '\\033]0;%s\\007' ${shellQuote(`HOAI ${name} (watch only)`)}`,
    'unset TMUX',
    `exec ${shellQuote(tmuxPath)}${socket ? ` -L ${shellQuote(socket)}` : ''} attach-session -r -t ${shellQuote(target)}`,
    '',
  ].join('\n')
}

async function tmuxPass(ctx, prior, show, capability) {
  const log = ctx.log ?? (() => {})
  if (!show && prior.lastShow !== true && prior.scanned) {
    return { report: { mode: capability.mode, reason: 'setting_off' }, memory: { ...prior, lastShow: false } }
  }
  const tmuxPath = capability.tmuxPath
  const rows = agentRows(ctx).filter((row) => validAssistantId(row.assistantId))
  const defaultServer = await tmuxServer(ctx, tmuxPath, null)
  const agents = []
  const viewers = []
  for (const row of rows) {
    const id = row.assistantId
    const own = await tmuxServer(ctx, tmuxPath, `hoai-${id}`)
    let target = null
    if (own.sessions.has(`hoai-${id}`)) target = { socket: `hoai-${id}`, session: `hoai-${id}`, server: own }
    else if (defaultServer.sessions.has(`hoai-${id}`)) target = { socket: null, session: `hoai-${id}`, server: defaultServer }
    else if (row.keepalive?.tmuxSession && defaultServer.sessions.has(row.keepalive.tmuxSession)) target = { socket: null, session: row.keepalive.tmuxSession, server: defaultServer }
    if (!target) continue
    const created = target.server.sessions.get(target.session) ?? 0
    const key = `${target.socket ?? 'default'}:${target.session}:${created}`
    agents.push({ id, session: key, startedAtMs: created ? created * 1000 : null, target, row })
    for (const client of target.server.clients) {
      if (client.session === target.session && client.readonly) viewers.push({ id, session: key, handle: { socket: target.socket, client: client.name } })
    }
  }
  const plan = planViewers({ show, agents, viewers, memory: prior, now: ctx.now() })
  for (const viewer of plan.close) {
    await tmuxQuery(ctx, tmuxPath, viewer.handle.socket, ['detach-client', '-t', viewer.handle.client])
    log(`windows: viewer of agent ${viewer.id} detached`)
  }
  let failed = false
  for (const agent of plan.open) {
    const { socket, session } = agent.target
    if (ctx.platform === 'darwin') {
      const path = joinDir(agent.row.stateDir, POSIX_VIEWER_FILE_NAME)
      try {
        ctx.fs.writeFile(path, commandFileText({ id: agent.id, name: viewerName(agent.row), tmuxPath, socket, session }), { mode: 0o700 })
        const res = await ctx.exec('open', ['-g', '-a', 'Terminal', path], { timeoutMs: COMMAND_TIMEOUT_MS })
        if (res?.code !== 0) {
          failed = true
          log(`windows: Terminal could not be opened for agent ${agent.id} (rc ${res?.code ?? 'null'})`)
        } else log(`windows: viewer opened for agent ${agent.id}`)
      } catch (err) {
        failed = true
        log(`windows: viewer for agent ${agent.id} not opened: ${String(err?.message ?? err)}`)
      }
      continue
    }
    const terminal = capability.terminal
    try {
      ctx.spawnDetached(terminal.file, [...terminal.prefix, tmuxPath, ...(socket ? ['-L', socket] : []), 'attach-session', '-r', '-t', `=${session}`], {
        cwd: ctx.home,
        env: withoutTmux(ctx.env),
      })
      log(`windows: viewer opened for agent ${agent.id}`)
    } catch (err) {
      failed = true
      log(`windows: viewer for agent ${agent.id} not opened: ${String(err?.message ?? err)}`)
    }
  }
  const memory = { ...plan.memory, scanned: true, openFailed: show && (plan.memory.openFailed || failed) }
  return { report: reportFor(capability.mode, show, memory.openFailed), memory }
}
