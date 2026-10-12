/**
 * lib/agent-windows-plan.mjs + lib/agent-windows.mjs: Show agent windows (board row d133ddb2).
 *
 * Every agent always runs hidden. A window is only a VIEWER beside it: a Terminal on the agent's
 * tmux session (read only) on a Mac or Linux computer, a watch only mirror of its hidden console on
 * Windows. The rules pinned here:
 *
 *   - no window is ever opened while the owner's setting is off (absent reads off);
 *   - switching it off closes the viewers, and only the viewers: never an agent process, never a
 *     person's own read-write tmux attach, never a tmux server or session;
 *   - a viewer the owner closed restarts nothing, kills nothing, and is not reopened for that agent
 *     session; it comes back at the agent's next start, or when the setting goes off and on;
 *   - at most 4 viewers open per minute, oldest agent first;
 *   - what the computer can do rides the heartbeat as {mode, reason}, both from fixed lists;
 *   - a Windows agent console a supervisor started minimized (the old task launcher, style 7) or in
 *     a visible cmd /k (the old create_agent launch) is hidden in place once, never restarted; a
 *     person's own console is never touched.
 *
 * Every effect (process table, tmux, spawn, kill, files) is injected; nothing runs for real.
 *
 * Run: npx tsx --test test/agent-windows.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  VIEWER_OPENS_PER_MINUTE,
  VIEWER_REOPEN_MIN_MS,
  WINDOW_MODES,
  WINDOW_REASONS,
  emptyViewerMemory,
  planViewers,
  viewerMemoryForState,
  viewerMemoryFromState,
  windowsCapability,
  windowsHealth,
} from '../lib/agent-windows-plan.mjs'
import { POSIX_VIEWER_FILE_NAME, VIEWER_LAUNCHER_FILE_NAME, VIEWER_SCRIPT_FILE_NAME, findTool, runWindowsPass } from '../lib/agent-windows.mjs'
import { supervisorFileBody } from '../bin/hoai-core.mjs'
import { memoryFs } from './helpers/memory-fs.ts'

const T0 = Date.parse('2026-10-12T12:00:00.000Z')
const MIN = 60_000

// -- the fixed lists ---------------------------------------------------------------------------

test('vocabulary: window modes and reasons are fixed lists (the backend keeps only these; no free text)', () => {
  assert.deepEqual(WINDOW_MODES, ['tmux', 'viewer', 'none'])
  assert.deepEqual(WINDOW_REASONS, ['setting_off', 'showing', 'no_tmux', 'no_screen', 'no_terminal', 'open_failed', 'unsupported'])
  assert.equal(Object.isFrozen(WINDOW_MODES), true)
  assert.equal(Object.isFrozen(WINDOW_REASONS), true)
  assert.equal(VIEWER_OPENS_PER_MINUTE, 4)
})

test('windowsCapability: Windows always has the watch only viewer; a Mac needs tmux; Linux needs tmux, a screen and a terminal; anything else is unsupported', () => {
  const rows: Array<[string, any, { mode: string; reason: string | null }]> = [
    ['windows', { platform: 'win32' }, { mode: 'viewer', reason: null }],
    ['windows ignores tmux', { platform: 'win32', hasTmux: false }, { mode: 'viewer', reason: null }],
    ['mac with tmux', { platform: 'darwin', hasTmux: true }, { mode: 'tmux', reason: null }],
    ['mac without tmux', { platform: 'darwin', hasTmux: false }, { mode: 'none', reason: 'no_tmux' }],
    ['linux desktop', { platform: 'linux', hasTmux: true, hasScreen: true, hasTerminal: true }, { mode: 'tmux', reason: null }],
    ['linux without tmux', { platform: 'linux', hasTmux: false, hasScreen: true, hasTerminal: true }, { mode: 'none', reason: 'no_tmux' }],
    ['linux server', { platform: 'linux', hasTmux: true, hasScreen: false, hasTerminal: true }, { mode: 'none', reason: 'no_screen' }],
    ['linux, no terminal emulator', { platform: 'linux', hasTmux: true, hasScreen: true, hasTerminal: false }, { mode: 'none', reason: 'no_terminal' }],
    ['freebsd', { platform: 'freebsd', hasTmux: true, hasScreen: true, hasTerminal: true }, { mode: 'none', reason: 'unsupported' }],
  ]
  for (const [name, input, expected] of rows) assert.deepEqual(windowsCapability(input), expected, name)
})

test('windowsHealth: only listed values leave the machine; anything else is none/unsupported', () => {
  assert.deepEqual(windowsHealth({ mode: 'viewer', reason: 'showing' }), { mode: 'viewer', reason: 'showing' })
  assert.deepEqual(windowsHealth({ mode: 'tmux', reason: 'setting_off' }), { mode: 'tmux', reason: 'setting_off' })
  assert.deepEqual(windowsHealth({ mode: 'kitty', reason: 'showing' }), { mode: 'none', reason: 'unsupported' })
  assert.deepEqual(windowsHealth({ mode: 'viewer', reason: 'could not open C:\\Users\\kc' }), { mode: 'none', reason: 'unsupported' })
  assert.deepEqual(windowsHealth(null), { mode: 'none', reason: 'unsupported' })
})

// -- planViewers: the pure rules ----------------------------------------------------------------

const agent = (id: string, session: string, startedAtMs: number) => ({ id, session, startedAtMs })

test('planViewers: the setting off opens nothing and closes EVERY viewer (only viewers are ever listed to close)', () => {
  const memory = { ...emptyViewerMemory(), lastShow: true, opened: { '7': 'pid:70' } }
  const out = planViewers({
    show: false,
    agents: [agent('7', 'pid:70', T0 - 5 * MIN), agent('8', 'pid:80', T0 - 4 * MIN)],
    viewers: [{ id: '7', session: 'pid:70', handle: 1007 }, { id: '9', session: 'pid:90', handle: 1009 }],
    memory,
    now: T0,
  })
  assert.deepEqual(out.open, [])
  assert.deepEqual(out.close.map((v: any) => v.handle), [1007, 1009])
  assert.deepEqual(out.memory.opened, {})
  assert.deepEqual(out.memory.closed, {})
  assert.equal(out.memory.lastShow, false)
})

test('planViewers: on, every running agent without a viewer gets one, oldest first, at most 4 a minute; the rest follow in later minutes', () => {
  const agents = Array.from({ length: 9 }, (_, i) => agent(String(100 + i), `pid:${1000 + i}`, T0 - (20 - i) * MIN)).reverse()
  let memory = emptyViewerMemory()
  const first = planViewers({ show: true, agents, viewers: [], memory, now: T0 })
  assert.deepEqual(first.open.map((a: any) => a.id), ['100', '101', '102', '103'])
  assert.deepEqual(first.close, [])
  memory = first.memory
  // 30 s later: the four are open, the budget is spent.
  const viewers = first.open.map((a: any) => ({ id: a.id, session: a.session, handle: Number(a.id) }))
  const soon = planViewers({ show: true, agents, viewers, memory, now: T0 + 30_000 })
  assert.deepEqual(soon.open, [])
  // A minute later the next four.
  const next = planViewers({ show: true, agents, viewers, memory: soon.memory, now: T0 + MIN })
  assert.deepEqual(next.open.map((a: any) => a.id), ['104', '105', '106', '107'])
})

test('planViewers: a viewer the owner CLOSED is not reopened for that agent session, and nothing else happens; it comes back at the next agent start, or after off then on', () => {
  const a7 = agent('7', 'pid:70', T0 - 5 * MIN)
  const opened = planViewers({ show: true, agents: [a7], viewers: [], memory: emptyViewerMemory(), now: T0 })
  assert.deepEqual(opened.open.map((a: any) => a.id), ['7'])
  // The owner closes the window: the next pass sees no viewer for the same session.
  const closed = planViewers({ show: true, agents: [a7], viewers: [], memory: opened.memory, now: T0 + MIN })
  assert.deepEqual(closed.open, [], 'not reopened')
  assert.deepEqual(closed.close, [], 'nothing to close')
  assert.deepEqual(closed.memory.closed, { '7': 'pid:70' })
  const still = planViewers({ show: true, agents: [a7], viewers: [], memory: closed.memory, now: T0 + 5 * MIN })
  assert.deepEqual(still.open, [], 'still closed later in the same session')
  // The agent's next start (a new launcher): its window comes back.
  const restarted = planViewers({ show: true, agents: [agent('7', 'pid:71', T0 + 6 * MIN)], viewers: [], memory: still.memory, now: T0 + 6 * MIN })
  assert.deepEqual(restarted.open.map((a: any) => a.id), ['7'])
  // Or off then on.
  const off = planViewers({ show: false, agents: [a7], viewers: [], memory: still.memory, now: T0 + 7 * MIN })
  const on = planViewers({ show: true, agents: [a7], viewers: [], memory: off.memory, now: T0 + 8 * MIN })
  assert.deepEqual(on.open.map((a: any) => a.id), ['7'])
})

test('planViewers: an open viewer is adopted (never a second one for the same agent); extra viewers of one agent are closed down to one', () => {
  const a7 = agent('7', 'pid:70', T0 - 5 * MIN)
  const adopted = planViewers({ show: true, agents: [a7], viewers: [{ id: '7', session: 'pid:70', handle: 1 }], memory: emptyViewerMemory(), now: T0 })
  assert.deepEqual(adopted.open, [])
  assert.deepEqual(adopted.memory.opened, { '7': 'pid:70' })
  const twice = planViewers({ show: true, agents: [a7], viewers: [{ id: '7', session: 'pid:70', handle: 1 }, { id: '7', session: 'pid:70', handle: 2 }], memory: adopted.memory, now: T0 })
  assert.deepEqual(twice.close.map((v: any) => v.handle), [2])
})

test('planViewers (review): a viewer left on a session that ended is closed and never counts for the new one, which gets its own viewer', () => {
  const memory = { ...emptyViewerMemory(), lastShow: true, opened: { '7': 'pid:70' } }
  const out = planViewers({ show: true, agents: [agent('7', 'pid:71', T0)], viewers: [{ id: '7', session: 'pid:70', handle: 70 }], memory, now: T0 + 10 * MIN })
  assert.deepEqual(out.close.map((v: any) => v.handle), [70])
  assert.deepEqual(out.open.map((a: any) => a.session), ['pid:71'])
  assert.deepEqual(out.memory.closed, {}, 'the new session is not marked closed by the owner')
  // A viewer of an agent that is not running any more is closed too.
  const gone = planViewers({ show: true, agents: [], viewers: [{ id: '8', session: 'pid:80', handle: 80 }], memory, now: T0 })
  assert.deepEqual(gone.close.map((v: any) => v.handle), [80])
})

test('planViewers (review): an agent that restarts in a loop gets a new viewer at most once every 5 minutes, not every pass', () => {
  assert.equal(VIEWER_REOPEN_MIN_MS, 5 * MIN)
  const first = planViewers({ show: true, agents: [agent('7', 'pid:70', T0)], viewers: [], memory: emptyViewerMemory(), now: T0 })
  assert.equal(first.open.length, 1)
  const lap = planViewers({ show: true, agents: [agent('7', 'pid:71', T0 + MIN)], viewers: [], memory: first.memory, now: T0 + MIN })
  assert.deepEqual(lap.open, [], 'a new session one minute later waits')
  const later = planViewers({ show: true, agents: [agent('7', 'pid:72', T0 + 5 * MIN)], viewers: [], memory: lap.memory, now: T0 + 5 * MIN })
  assert.deepEqual(later.open.map((a: any) => a.session), ['pid:72'])
})

test('viewerMemoryForState / viewerMemoryFromState: opened, closed, the cool-down and the last setting survive a watcher restart; junk does not', () => {
  const memory = { ...emptyViewerMemory(), opened: { '7': 'pid:70' }, closed: { '8': 'pid:80' }, lastOpenAt: { '7': T0 }, lastShow: true, opens: [T0], scanned: true }
  const saved = JSON.parse(JSON.stringify(viewerMemoryForState(memory)))
  assert.deepEqual(saved, { opened: { '7': 'pid:70' }, closed: { '8': 'pid:80' }, lastOpenAt: { '7': T0 }, lastShow: true })
  const back = viewerMemoryFromState(saved)
  assert.deepEqual({ opened: back.opened, closed: back.closed, lastOpenAt: back.lastOpenAt, lastShow: back.lastShow, scanned: back.scanned }, { opened: { '7': 'pid:70' }, closed: { '8': 'pid:80' }, lastOpenAt: { '7': T0 }, lastShow: true, scanned: false })
  assert.deepEqual(viewerMemoryFromState({ opened: { x: 'a', '9': 5 }, closed: [], lastOpenAt: { '9': 'soon' }, lastShow: 'yes' }), emptyViewerMemory())
  assert.deepEqual(viewerMemoryFromState(null), emptyViewerMemory())
})

// -- runWindowsPass, Windows ---------------------------------------------------------------------

const HOME = 'C:\\Users\\kc'
const VIEWER_DIR = 'C:\\Users\\kc\\.bgos-agent\\watcher\\bin'
const VBS = `${VIEWER_DIR}\\${VIEWER_LAUNCHER_FILE_NAME}`
const PS1 = `${VIEWER_DIR}\\${VIEWER_SCRIPT_FILE_NAME}`

function winRow(id: string, cwd: string, extra: Record<string, unknown> = {}) {
  return { assistantId: id, cwd, stateDir: `${HOME}\\.bgos-agent\\${id}`, launcherLive: true, supervisor: 'launcher-live', keepalive: null, ...extra }
}

function winMachine(launchers: Record<string, number>) {
  const fs = memoryFs()
  for (const [id, pid] of Object.entries(launchers)) fs.writeFile(`${HOME}\\.bgos-agent\\${id}\\supervisor.json`, supervisorFileBody(pid, new Date(T0 - pid).toISOString()))
  return fs
}

function proc(pid: number, ppid: number, command: string) {
  return { ProcessId: pid, ParentProcessId: ppid, CreationDate: T0 - 60_000, CommandLine: command }
}

const viewerCommand = (consolePid: number, id: string) => `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File "${PS1}" -ConsolePid ${consolePid} -AssistantId ${id}`

function winEffects(table: any[]) {
  const execs: Array<{ file: string; args: string[] }> = []
  const spawns: Array<{ file: string; args: string[]; opts: any }> = []
  const kills: Array<[number, string]> = []
  return {
    execs,
    spawns,
    kills,
    exec: async (file: string, args: readonly string[]) => {
      execs.push({ file, args: [...args] })
      if (file === 'powershell.exe' && args.includes('-Command')) return { code: 0, stdout: JSON.stringify(table), stderr: '', error: null, timedOut: false }
      return { code: 0, stdout: '', stderr: '', error: null, timedOut: false }
    },
    spawnDetached: (file: string, args: readonly string[], opts: any) => {
      spawns.push({ file, args: [...args], opts })
      return { pid: 5555 }
    },
    kill: (pid: number, signal: string) => {
      kills.push([pid, signal])
    },
  }
}

function winCtx(fx: ReturnType<typeof winEffects>, fs: any, rows: any[], show: boolean, memory = emptyViewerMemory(), at = T0) {
  return { platform: 'win32', home: HOME, env: { PATH: 'C:\\Windows' }, fs, exec: fx.exec, spawnDetached: fx.spawnDetached, kill: fx.kill, now: () => at, log: () => {}, pidAlive: () => true, listAgents: () => rows, viewerDir: VIEWER_DIR, show, memory }
}

/** Never anything that restarts, starts or stops an agent: no schtasks, no wscript of an agent launcher, no hoai, no kill of a launcher. */
function assertAgentUntouched(fx: ReturnType<typeof winEffects>, launcherPids: number[]) {
  assert.equal(fx.execs.some((c) => /schtasks/i.test(c.file) || c.args.some((a) => /schtasks|Start-ScheduledTask|Stop-Process|taskkill/i.test(a))), false, 'no task started or stopped')
  assert.equal(fx.spawns.some((s) => s.args.some((a) => /run-agent\.vbs|launch-hidden\.vbs|hoai-core\.mjs/.test(a))), false, 'no agent launch')
  for (const pid of launcherPids) assert.equal(fx.kills.some(([k]) => k === pid), false, `launcher ${pid} never killed`)
}

test('runWindowsPass win32, setting ON: one viewer per running agent through the bundled vbs (wscript //B, digits only), the agent name in the environment; nothing else is started', async () => {
  const fs = winMachine({ '912': 4242, '7': 4343 })
  const rows = [winRow('912', 'C:\\Users\\kc\\hoai-agents\\Wolf'), winRow('7', 'C:\\Users\\kc\\hoai-agents\\ava'), winRow('8', 'C:\\Users\\kc\\hoai-agents\\down', { launcherLive: false, supervisor: 'none' })]
  const fx = winEffects([proc(4242, 1, 'node hoai-core.mjs'), proc(4343, 1, 'node hoai-core.mjs')])
  const out = await runWindowsPass(winCtx(fx, fs, rows, true) as any)
  assert.deepEqual(out.report, { mode: 'viewer', reason: 'showing' })
  assert.deepEqual(
    fx.spawns.map((s) => [s.file, ...s.args]),
    [
      ['wscript.exe', '//B', VBS, '-ConsolePid', '4343', '-AssistantId', '7'],
      ['wscript.exe', '//B', VBS, '-ConsolePid', '4242', '-AssistantId', '912'],
    ],
    'oldest launcher first (4343 started before 4242), the stopped agent 8 gets nothing',
  )
  assert.equal(fx.spawns[1]!.opts.env.HOAI_VIEWER_NAME, 'Wolf')
  assert.equal(fx.spawns[1]!.opts.windowsHide, true)
  assertAgentUntouched(fx, [4242, 4343])
  assert.deepEqual(fx.kills, [])
})

test('runWindowsPass win32, setting OFF: no viewer is opened, and every open viewer (and only a viewer, matched by its command line) is closed', async () => {
  const fs = winMachine({ '912': 4242 })
  const rows = [winRow('912', 'C:\\Users\\kc\\hoai-agents\\Wolf')]
  const table = [
    proc(4242, 1, 'node hoai-core.mjs'),
    proc(6001, 1, viewerCommand(4242, '912')),
    // Look-alikes that are NOT viewers: a person's PowerShell, the startup gate helper on the agent console.
    proc(6002, 1, 'powershell.exe -NoProfile'),
    proc(6003, 4242, `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\x\\bin\\win32-accept-dev-channels.ps1 -ConsolePid 4242`),
  ]
  const fx = winEffects(table)
  const memory = { ...emptyViewerMemory(), lastShow: true, scanned: true, opened: { '912': 'pid:4242' } }
  const out = await runWindowsPass(winCtx(fx, fs, rows, false, memory) as any)
  assert.deepEqual(out.report, { mode: 'viewer', reason: 'setting_off' })
  assert.deepEqual(fx.spawns, [], 'nothing opened')
  assert.deepEqual(fx.kills, [[6001, 'SIGTERM']], 'only the viewer')
  assertAgentUntouched(fx, [4242])
})

test('runWindowsPass win32: the setting off and already handled is a no-op (no process listing every minute); the first pass of a watcher still looks once, to close viewers left open', async () => {
  const fs = winMachine({ '912': 4242 })
  const rows = [winRow('912', 'C:\\Users\\kc\\hoai-agents\\Wolf')]
  const idle = winEffects([proc(4242, 1, 'node hoai-core.mjs')])
  const quiet = await runWindowsPass(winCtx(idle, fs, rows, false, { ...emptyViewerMemory(), lastShow: false, scanned: true, consolesChecked: [4242] }) as any)
  assert.deepEqual(quiet.report, { mode: 'viewer', reason: 'setting_off' })
  assert.deepEqual(idle.execs, [])
  const first = winEffects([proc(4242, 1, 'node hoai-core.mjs'), proc(6001, 1, viewerCommand(4242, '912'))])
  const out = await runWindowsPass(winCtx(first, fs, rows, false) as any)
  assert.deepEqual(first.kills, [[6001, 'SIGTERM']])
  assert.equal(out.memory.scanned, true)
})

test('runWindowsPass win32 (review): a supervisor.json whose pid now belongs to something else is looked at once; with the setting off nothing is listed again', async () => {
  const fs = winMachine({ '912': 4242 })
  // The row says no live launcher (pid 4242 was reused by another program).
  const rows = [winRow('912', 'C:\\a\\Wolf', { launcherLive: false, supervisor: 'none' })]
  const first = winEffects([proc(4242, 1, 'notepad.exe')])
  const out = await runWindowsPass(winCtx(first, fs, rows, false) as any)
  assert.equal(first.execs.length, 1, 'the first pass lists once')
  const second = winEffects([proc(4242, 1, 'notepad.exe')])
  await runWindowsPass(winCtx(second, fs, rows, false, out.memory) as any)
  assert.deepEqual(second.execs, [], 'nothing listed again for the same pid')
})

test('runWindowsPass win32: a viewer the owner closed restarts nothing, kills nothing, opens nothing for the rest of that agent session', async () => {
  const fs = winMachine({ '912': 4242 })
  const rows = [winRow('912', 'C:\\Users\\kc\\hoai-agents\\Wolf')]
  const opening = winEffects([proc(4242, 1, 'node hoai-core.mjs')])
  const first = await runWindowsPass(winCtx(opening, fs, rows, true) as any)
  assert.equal(opening.spawns.length, 1)
  // The owner closed it: the viewer process is gone from the table; the agent is still there.
  const after = winEffects([proc(4242, 1, 'node hoai-core.mjs')])
  const second = await runWindowsPass(winCtx(after, fs, rows, true, first.memory) as any)
  assert.deepEqual(after.spawns, [], 'not reopened')
  assert.deepEqual(after.kills, [], 'nothing killed')
  assertAgentUntouched(after, [4242])
  assert.deepEqual(second.report, { mode: 'viewer', reason: 'showing' })
  // The agent's next start (new launcher pid), past the per agent cool-down: its viewer comes back.
  const fs2 = winMachine({ '912': 4999 })
  const restarted = winEffects([proc(4999, 1, 'node hoai-core.mjs')])
  await runWindowsPass(winCtx(restarted, fs2, rows, true, second.memory, T0 + 6 * MIN) as any)
  assert.deepEqual(restarted.spawns.map((s) => s.args.slice(2)), [['-ConsolePid', '4999', '-AssistantId', '912']])
})

test('runWindowsPass win32: a console a supervisor left on screen (the old minimized task launcher, the old cmd /k create launch) is hidden in place ONCE; a person\'s own console never is', async () => {
  const fs = winMachine({ '1': 101, '2': 202, '3': 303, '4': 404 })
  // Agent 4's task launcher was started from a style 0 run-agent.vbs already on disk: never shown, nothing to hide.
  fs.writeFile(`${HOME}\\.bgos-agent\\4\\run-agent.vbs`, 'WScript.Quit shell.Run("x", 0, True)\r\n')
  fs.touch(`${HOME}\\.bgos-agent\\4\\run-agent.vbs`, T0 - 10 * MIN)
  const rows = [winRow('1', 'C:\\a\\task'), winRow('2', 'C:\\a\\recipe'), winRow('3', 'C:\\a\\person'), winRow('4', 'C:\\a\\hidden-task')]
  const table = [
    proc(44, 1, `"C:\\Windows\\System32\\wscript.exe" //B "${HOME}\\.bgos-agent\\4\\run-agent.vbs"`),
    proc(404, 44, '"C:\\node.exe" "C:\\root\\bin\\hoai-core.mjs" --keep-alive'),
    proc(11, 1, `"C:\\Windows\\System32\\wscript.exe" //B "${HOME}\\.bgos-agent\\1\\run-agent.vbs"`),
    proc(101, 11, '"C:\\node.exe" "C:\\root\\bin\\hoai-core.mjs" --keep-alive'),
    proc(22, 1, 'cmd  /k ""C:\\node.exe" "C:\\root\\bin\\hoai-core.mjs""'),
    proc(202, 22, '"C:\\node.exe" "C:\\root\\bin\\hoai-core.mjs"'),
    proc(33, 1, '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"'),
    proc(303, 33, 'node C:\\root\\bin\\hoai-core.mjs'),
  ]
  const fx = winEffects(table)
  const out = await runWindowsPass(winCtx(fx, fs, rows, false, { ...emptyViewerMemory(), lastShow: false, scanned: true }) as any)
  const hides = fx.execs.filter((c) => c.args.includes('hide'))
  assert.deepEqual(
    hides.map((c) => [c.file, ...c.args]),
    [
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-ConsolePid', '101', '-AssistantId', '1', '-Mode', 'hide'],
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-ConsolePid', '202', '-AssistantId', '2', '-Mode', 'hide'],
    ],
  )
  assertAgentUntouched(fx, [101, 202, 303, 404])
  assert.deepEqual(fx.spawns, [])
  // Once: the next pass does not ask again.
  const again = winEffects(table)
  await runWindowsPass(winCtx(again, fs, rows, false, out.memory) as any)
  assert.deepEqual(again.execs.filter((c) => c.args.includes('hide')), [])
})

test('runWindowsPass win32: a console Windows Terminal hosts is left as it is (the helper answers 4), said once in the log, never asked again', async () => {
  const fs = winMachine({ '2': 202 })
  const rows = [winRow('2', 'C:\\a\\recipe')]
  const table = [proc(22, 1, 'cmd  /k ""C:\\node.exe" "C:\\root\\bin\\hoai-core.mjs""'), proc(202, 22, '"C:\\node.exe" "C:\\root\\bin\\hoai-core.mjs"')]
  const fx = winEffects(table)
  const exec = fx.exec
  fx.exec = async (file: string, args: readonly string[]) => (args.includes('hide') ? (fx.execs.push({ file, args: [...args] }), { code: 4, stdout: '', stderr: '', error: null, timedOut: false }) : exec(file, args))
  const logs: string[] = []
  const out = await runWindowsPass({ ...winCtx(fx, fs, rows, false), log: (l: string) => logs.push(l) } as any)
  assert.equal(fx.execs.filter((c) => c.args.includes('hide')).length, 1)
  assert.ok(logs.some((l) => l.includes('not hidden: Windows Terminal hosts it')), logs.join('\n'))
  assertAgentUntouched(fx, [202])
  const again = winEffects(table)
  await runWindowsPass(winCtx(again, fs, rows, false, out.memory) as any)
  assert.deepEqual(again.execs, [])
})

test('runWindowsPass win32: an unreadable process table opens nothing (a second viewer could not be ruled out) and is said as open_failed', async () => {
  const fs = winMachine({ '912': 4242 })
  const fx = winEffects([])
  fx.exec = async (file: string, args: readonly string[]) => {
    fx.execs.push({ file, args: [...args] })
    return { code: 1, stdout: '', stderr: 'Access denied', error: null, timedOut: false }
  }
  const out = await runWindowsPass(winCtx(fx, fs, [winRow('912', 'C:\\a\\Wolf')], true) as any)
  assert.deepEqual(fx.spawns, [])
  assert.deepEqual(out.report, { mode: 'viewer', reason: 'open_failed' })
})

// -- runWindowsPass, Mac and Linux --------------------------------------------------------------

const PHOME = '/Users/kc'
const TMUX = '/opt/homebrew/bin/tmux'

/** A fake tmux: sessions and clients per socket ('' = the default server). */
function tmuxEffects(servers: Record<string, { sessions: Array<[string, number]>; clients: Array<[string, number, 0 | 1, string]> }>, opts: { openCode?: number } = {}) {
  const execs: Array<{ file: string; args: string[] }> = []
  const spawns: Array<{ file: string; args: string[]; opts: any }> = []
  const kills: Array<[number, string]> = []
  const exec = async (file: string, args: readonly string[]) => {
    execs.push({ file, args: [...args] })
    if (file === 'open') return { code: opts.openCode ?? 0, stdout: '', stderr: opts.openCode ? 'LSOpenURLsWithRole() failed' : '', error: null, timedOut: false }
    if (file !== TMUX) return { code: 0, stdout: '', stderr: '', error: null, timedOut: false }
    const list = [...args]
    let socket = ''
    if (list[0] === '-L') {
      socket = list[1]!
      list.splice(0, 2)
    }
    const server = servers[socket]
    if (!server) return { code: 1, stdout: '', stderr: `no server running on /tmp/tmux-501/${socket || 'default'}`, error: null, timedOut: false }
    if (list[0] === 'list-sessions') return { code: 0, stdout: server.sessions.map(([n, c]) => `${n}\t${c}`).join('\n') + '\n', stderr: '', error: null, timedOut: false }
    if (list[0] === 'list-clients') return { code: 0, stdout: server.clients.map(([n, p, ro, s]) => `${n}\t${p}\t${ro}\t${s}`).join('\n') + '\n', stderr: '', error: null, timedOut: false }
    return { code: 0, stdout: '', stderr: '', error: null, timedOut: false }
  }
  return {
    execs,
    spawns,
    kills,
    exec,
    spawnDetached: (file: string, args: readonly string[], o: any) => {
      spawns.push({ file, args: [...args], opts: o })
      return { pid: 7777 }
    },
    kill: (pid: number, signal: string) => {
      kills.push([pid, signal])
    },
  }
}

function posixRow(id: string, cwd: string, extra: Record<string, unknown> = {}) {
  return { assistantId: id, cwd, stateDir: `${PHOME}/.bgos-agent/${id}`, launcherLive: true, supervisor: 'service', keepalive: null, ...extra }
}

function posixCtx(platform: string, fx: ReturnType<typeof tmuxEffects>, fs: any, rows: any[], show: boolean, memory = emptyViewerMemory(), env: Record<string, string> = {}) {
  return { platform, home: PHOME, env: { PATH: '/usr/bin:/bin', ...env }, fs, exec: fx.exec, spawnDetached: fx.spawnDetached, kill: fx.kill, now: () => T0, log: () => {}, listAgents: () => rows, tmuxPath: TMUX, show, memory }
}

const NO_TMUX_KILL = (fx: ReturnType<typeof tmuxEffects>) =>
  assert.equal(fx.execs.some((c) => c.args.some((a) => /^(kill-server|kill-session|kill-pane|kill-window|send-keys|respawn-pane|new-session)$/.test(a))), false, 'never a tmux command that touches the agent')

test('runWindowsPass darwin, setting ON: a read only Terminal per agent session (own socket, or the default server for a one shot), opened with open -a Terminal; no Automation prompt, nothing typed', async () => {
  const fs = memoryFs()
  const rows = [posixRow('912', '/Users/kc/hoai-agents/Wolf'), posixRow('55', '/Users/kc/hoai-agents/Nova', { supervisor: 'launcher-live' })]
  const fx = tmuxEffects({ 'hoai-912': { sessions: [['hoai-912', 1000]], clients: [] }, '': { sessions: [['hoai-55', 900], ['scratch', 10]], clients: [] } })
  const out = await runWindowsPass(posixCtx('darwin', fx, fs, rows, true) as any)
  assert.deepEqual(out.report, { mode: 'tmux', reason: 'showing' })
  const opens = fx.execs.filter((c) => c.file === 'open')
  assert.deepEqual(opens.map((c) => c.args), [
    ['-g', '-a', 'Terminal', `${PHOME}/.bgos-agent/55/${POSIX_VIEWER_FILE_NAME}`],
    ['-g', '-a', 'Terminal', `${PHOME}/.bgos-agent/912/${POSIX_VIEWER_FILE_NAME}`],
  ])
  const own = fs.files.get(`${PHOME}/.bgos-agent/912/${POSIX_VIEWER_FILE_NAME}`)!
  assert.match(own, /^#!\/bin\/sh\n/)
  assert.match(own, /\nexec '\/opt\/homebrew\/bin\/tmux' -L 'hoai-912' attach-session -r -t '=hoai-912'\n$/)
  const oneShot = fs.files.get(`${PHOME}/.bgos-agent/55/${POSIX_VIEWER_FILE_NAME}`)!
  assert.match(oneShot, /\nexec '\/opt\/homebrew\/bin\/tmux' attach-session -r -t '=hoai-55'\n$/)
  assert.equal(fs.modes.get(`${PHOME}/.bgos-agent/912/${POSIX_VIEWER_FILE_NAME}`), 0o700, 'Terminal runs a .command only when it is executable')
  assert.equal(fx.execs.some((c) => c.file === 'osascript'), false, 'no Apple events')
  NO_TMUX_KILL(fx)
})

test('runWindowsPass darwin, setting OFF: each READ ONLY client (a viewer) is detached; a person\'s own read-write attach is left alone; the agent session is never touched', async () => {
  const fs = memoryFs()
  const rows = [posixRow('912', '/Users/kc/hoai-agents/Wolf')]
  const fx = tmuxEffects({ 'hoai-912': { sessions: [['hoai-912', 1000]], clients: [['/dev/ttys003', 3003, 1, 'hoai-912'], ['/dev/ttys004', 3004, 0, 'hoai-912']] } })
  const out = await runWindowsPass(posixCtx('darwin', fx, fs, rows, false, { ...emptyViewerMemory(), lastShow: true, scanned: true }) as any)
  assert.deepEqual(out.report, { mode: 'tmux', reason: 'setting_off' })
  const detaches = fx.execs.filter((c) => c.args.includes('detach-client'))
  assert.deepEqual(detaches.map((c) => c.args), [['-L', 'hoai-912', 'detach-client', '-t', '/dev/ttys003']])
  assert.deepEqual(fx.kills, [])
  assert.equal(fx.execs.some((c) => c.file === 'open'), false)
  NO_TMUX_KILL(fx)
})

test('runWindowsPass darwin: Terminal could not be opened is said as open_failed; a Mac without tmux opens nothing and says no_tmux', async () => {
  const rows = [posixRow('912', '/Users/kc/hoai-agents/Wolf')]
  const failing = tmuxEffects({ 'hoai-912': { sessions: [['hoai-912', 1000]], clients: [] } }, { openCode: 1 })
  const out = await runWindowsPass(posixCtx('darwin', failing, memoryFs(), rows, true) as any)
  assert.deepEqual(out.report, { mode: 'tmux', reason: 'open_failed' })
  const bare = tmuxEffects({})
  const none = await runWindowsPass({ ...posixCtx('darwin', bare, memoryFs(), rows, true), tmuxPath: null, hasTmux: false } as any)
  assert.deepEqual(none.report, { mode: 'none', reason: 'no_tmux' })
  assert.deepEqual(bare.execs, [])
})

test('runWindowsPass linux: with a screen, the first terminal on PATH runs a read only tmux attach (no wrapper shell); with no screen nothing runs and it says no_screen', async () => {
  const rows = [posixRow('912', '/home/kc/hoai-agents/Wolf', { stateDir: '/home/kc/.bgos-agent/912' })]
  const fx = tmuxEffects({ 'hoai-912': { sessions: [['hoai-912', 1000]], clients: [] } })
  const ctx = { ...posixCtx('linux', fx, memoryFs(), rows, true, emptyViewerMemory(), { DISPLAY: ':0' }), home: '/home/kc', hasCommand: (n: string) => n === 'gnome-terminal' }
  const out = await runWindowsPass(ctx as any)
  assert.deepEqual(out.report, { mode: 'tmux', reason: 'showing' })
  assert.deepEqual(fx.spawns.map((s) => [s.file, ...s.args]), [['gnome-terminal', '--', TMUX, '-L', 'hoai-912', 'attach-session', '-r', '-t', '=hoai-912']])
  assert.equal(fx.spawns[0]!.opts.env.TMUX, undefined)
  const dark = tmuxEffects({ 'hoai-912': { sessions: [['hoai-912', 1000]], clients: [] } })
  const none = await runWindowsPass({ ...posixCtx('linux', dark, memoryFs(), rows, true), home: '/home/kc', hasCommand: () => true } as any)
  assert.deepEqual(none.report, { mode: 'none', reason: 'no_screen' })
  assert.deepEqual(dark.execs, [])
  assert.deepEqual(dark.spawns, [])
})

test('findTool: PATH first, then the fixed dirs (Homebrew, /usr/local, ~/.local/bin, /usr/bin, /bin); null when nowhere', () => {
  const exists = (p: string) => p === '/opt/homebrew/bin/tmux' || p === '/custom/bin/tmux'
  assert.equal(findTool('tmux', { env: { PATH: '/custom/bin:/usr/bin' }, home: '/Users/kc', exists }), '/custom/bin/tmux')
  assert.equal(findTool('tmux', { env: { PATH: '/usr/bin' }, home: '/Users/kc', exists }), '/opt/homebrew/bin/tmux')
  assert.equal(findTool('tmux', { env: { PATH: '/usr/bin' }, home: '/Users/kc', exists: (p: string) => p === '/Users/kc/.local/bin/tmux' }), '/Users/kc/.local/bin/tmux')
  assert.equal(findTool('tmux', { env: {}, home: '/Users/kc', exists: () => false }), null)
})
