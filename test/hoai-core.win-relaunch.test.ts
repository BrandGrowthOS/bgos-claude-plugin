/**
 * The Windows relaunch weak spots the #246 review left open (HOAI board rows 978da5db and 31583f86).
 *
 *   1. KILL. claude installed by npm is `claude.cmd`, which hoai starts as `cmd.exe /c claude.cmd`.
 *      On Windows `child.kill()` is TerminateProcess on that cmd.exe alone, and the real claude
 *      (node running cli.js) is not in libuv's kill-on-close job either (it breaks away silently),
 *      so it ran on beside the relaunched one. Every relaunch, and a stop, now ends the claude under
 *      the shim and then the shim; never deeper, so what the daemon detached to outlive claude (its
 *      browser host, a person lane's supervisor) lives on, as with a native claude.exe.
 *   2. STALE GATE TEXT. A relaunch shares the console with the claude it replaced, and a killed
 *      claude leaves its last screen there. The new launch's gate helper reads the screen before
 *      the new claude has drawn anything, so a gate left on screen got the new launch's one Enter.
 *      hoai now clears the console before every relaunch, never before the first launch.
 *   3. FRESH-SESSION WINDOW. A fresh retry's id is pinned only once that session outlives the
 *      health window. A relaunch hoai itself asked for inside that window (an update, an unproven
 *      gate, no heartbeat) fell back to the previous pin, the session that had just been rejected.
 *      Such a relaunch is no verdict on the fresh session: it resumes the fresh one, judged again.
 *   4. Health relaunches (exit 6, no heartbeat) have their own budget, 3 per hour, apart from the
 *      update restarts' 3 per hour: neither can use up the other's.
 *   5. The 3 minute rule does not relaunch when the Claude login every agent of this computer shares
 *      has failed (the CLI's own `authentication_failed` record in their transcripts, the rule
 *      lib/claude-login.ts reads): no relaunch fixes that, so it alerts and says how.
 *
 * Every effect is a fake: claude (and the cmd.exe of its npm shim), the gate helper, the console,
 * the process tree, the files and the clock.
 *
 * Run: npx tsx --test test/hoai-core.win-relaunch.test.ts
 */

import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as core from '../bin/hoai-core.mjs'
import { extractLoginSignal } from '../lib/claude-login.ts'

const { FOLDER_PIN_FILE, LAUNCH_STATUS_FILE_NAME, MAX_RELAUNCHES_PER_WINDOW, RESTART_MARKER_FILE_NAME, SESSION_ID_FILE_NAME, sessionTranscriptPath, superviseClaude } = core
/** New in this change: read off the namespace so a missing export fails a test instead of the import. */
const fixed = core as unknown as {
  MAX_HEALTH_RELAUNCHES_PER_WINDOW?: number
  WIN32_CONSOLE_CLEAR?: string
  clearWin32Console?: (stream: { isTTY?: boolean; write: (text: string) => unknown }) => boolean
  endWin32ShimTree?: (pid: number, opts: { spawnSyncImpl: unknown; env: Record<string, string>; kill?: (pid: number) => unknown }) => boolean
  parseWin32ProcessRows?: (stdout: string) => { pid: number; ppid: number; startedAtMs: number | null; name: string }[]
  win32ShimTargets?: (processes: { pid: number; ppid: number; startedAtMs: number | null; name: string }[], rootPid: number) => number[]
  fleetClaudeLoginFailure?: (input: {
    configDir: string
    now: number
    listDir: (path: string) => string[]
    mtimeMs: (path: string) => number | null
    readTail: (path: string) => string | null
  }) => { at: number; text: string } | null
  loginSignalOf?: (chunk: string, nowMs: number) => unknown
  readFileTail?: (path: string, bytes: number) => string | null
  fileMtimeMs?: (path: string) => number | null
}

const HOME = 'C:\\Users\\mark'
const CWD = 'C:\\agents\\888'
const SCRIPT_DIR = 'C:\\Users\\mark\\.claude\\plugins\\cache\\hoai\\hoai\\0.71.1\\bin'
const COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
const STATE_DIR = `${HOME}\\.bgos-agent\\888`
const STATUS_PATH = `${STATE_DIR}\\${LAUNCH_STATUS_FILE_NAME}`
const MARKER_PATH = `${STATE_DIR}\\${RESTART_MARKER_FILE_NAME}`
const PIN_PATH = `${STATE_DIR}\\${SESSION_ID_FILE_NAME}`
const SUPERVISED = { HOAI_SUPERVISED: '1', HOAI_SUPERVISED_ASSISTANT_ID: '888', ComSpec: COMSPEC }
const BASE_ARGS = ['--dangerously-skip-permissions', '--dangerously-load-development-channels', 'plugin:hoai@hoai']
const PIN = '88888888-8888-4888-8888-888888888888'
const FRESH = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0'
const UNPROVEN = 6
const THREE_MIN = 3 * 60_000
const HEALTHY_MS = 25_000
const T0 = Date.UTC(2026, 9, 18, 7, 0, 0)
const GATE_TEXT = 'WARNING: Loading development channels'

/** A process hoai spawned: cmd.exe running the npm shim, or anything else it starts. */
class FakeProc extends EventEmitter {
  pid: number
  file: string
  args: string[]
  killed = false
  treeEnded = false
  ended = false
  exitCode: number | null = null
  signalCode: string | null = null
  constructor(pid: number, file: string, args: readonly string[]) {
    super()
    this.pid = pid
    this.file = file
    this.args = [...args]
  }
  /** TerminateProcess on this one process, which is all node's kill() is on Windows. */
  kill() {
    this.killed = true
    setImmediate(() => this.end(1, 'SIGTERM'))
    return true
  }
  end(code: number | null, signal: string | null) {
    if (this.ended) return
    this.ended = true
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
  exit(code: number) {
    this.end(code, null)
  }
}

class FakeHelper extends EventEmitter {
  pid: number
  /** What the helper read on screen when it started: the gate marker, or nothing. */
  sawAtStart: boolean
  constructor(pid: number, sawAtStart: boolean) {
    super()
    this.pid = pid
    this.sawAtStart = sawAtStart
  }
}

interface FakeTimer {
  fn: () => void
  ms: number
  at: number
  cleared: boolean
  fired: boolean
}

interface HarnessOpts {
  env?: Record<string, string>
  keepAlive?: boolean
  /** Inject the tree ender (true: a fake that ends the fake tree; 'fail': one that cannot; false: none). */
  endTree?: boolean | 'fail'
  /** The fake console: a clear empties it. false: no clear injected. */
  console?: boolean
  ids?: string[]
  files?: Record<string, string>
  /** The shared-login detector (absent: the default one, which reads nothing here). */
  claudeLoginFailure?: () => { at: number; text: string } | null
  spawnSyncImpl?: (...args: unknown[]) => unknown
}

/**
 * hoai on Windows with claude installed by npm: `claude` and `claude.exe` are not found, so every
 * launch is `cmd.exe /c claude.cmd ...` (spawnClaude's second candidate).
 */
function harness(o: HarnessOpts = {}) {
  const files = new Map<string, string>(Object.entries(o.files ?? {}))
  /** Every cmd.exe that ran the shim, in launch order. */
  const claudes: FakeProc[] = []
  const helpers: FakeHelper[] = []
  const prints: string[] = []
  const timers: FakeTimer[] = []
  const treeEnds: number[] = []
  const events: string[] = []
  /** The console hoai and every claude share: lines on screen. */
  const screen: string[] = []
  const clock = { now: T0 }
  const stop = new AbortController()
  const ids = [...(o.ids ?? [PIN])]
  let nextPid = 25184
  const procs = new Map<number, FakeProc>()
  const endTree =
    o.endTree === false
      ? undefined
      : (pid: number) => {
          treeEnds.push(pid)
          events.push(`end-tree:${pid}`)
          if (o.endTree === 'fail') return false
          const proc = procs.get(pid)
          if (proc) {
            proc.treeEnded = true
            // taskkill /F: TerminateProcess, exit code 1, no signal.
            setImmediate(() => proc.end(1, null))
          }
          return true
        }
  const done = superviseClaude(BASE_ARGS, {
    platform: 'win32',
    env: o.env ?? SUPERVISED,
    home: HOME,
    cwd: CWD,
    scriptDir: SCRIPT_DIR,
    readFile: (p: string) => (p === `${CWD}\\${FOLDER_PIN_FILE}` ? '888' : files.get(p) ?? null),
    listDir: () => [],
    spawnImpl: ((file: string, args: readonly string[]) => {
      const proc = new FakeProc(nextPid, file, args)
      nextPid += 4
      if (file !== COMSPEC) {
        // No claude.exe on PATH: node reports ENOENT after the spawn call returns.
        setImmediate(() => proc.emit('error', Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' })))
        return proc
      }
      procs.set(proc.pid, proc)
      claudes.push(proc)
      events.push(`spawn-claude:${proc.pid}`)
      return proc
    }) as never,
    ...(o.spawnSyncImpl ? { spawnSyncImpl: o.spawnSyncImpl } : {}),
    ...(endTree ? { endProcessTree: endTree } : {}),
    ...(o.console === false
      ? {}
      : {
          clearConsole: () => {
            events.push('clear-console')
            screen.length = 0
          },
        }),
    ...(o.claudeLoginFailure ? { claudeLoginFailure: o.claudeLoginFailure } : {}),
    spawnGateHelper: () => {
      const helper = new FakeHelper(30000 + helpers.length, screen.some((line) => line.includes(GATE_TEXT)))
      helpers.push(helper)
      events.push(`helper:${helper.pid}`)
      return helper
    },
    writeErr: () => {},
    exists: (p: string) => files.has(p),
    writeFile: (p: string, content: string) => {
      files.set(p, content)
      return true
    },
    removeFile: (p: string) => files.delete(p),
    print: (line: string) => prints.push(line),
    now: () => clock.now,
    setTimer: ((fn: () => void, ms: number) => {
      const timer: FakeTimer = { fn, ms, at: clock.now, cleared: false, fired: false }
      timers.push(timer)
      return timer
    }) as never,
    clearTimer: ((timer: FakeTimer | null) => {
      if (timer) timer.cleared = true
    }) as never,
    sleep: async () => {},
    pollMs: 5,
    healthyMs: HEALTHY_MS,
    keepAlive: o.keepAlive ?? true,
    signal: stop.signal,
    listProcesses: () => [],
    pidProcess: () => null,
    pidAlive: () => false,
    generateId: () => ids.shift() ?? PIN,
  } as never)
  const armed = (ms: number) => timers.filter((t) => t.ms === ms && !t.cleared && !t.fired).at(-1)
  /** Moves the clock to that timer's moment and runs it, as a real timer would. */
  const fire = (ms: number) => {
    const timer = armed(ms)
    assert.ok(timer, `a ${ms} ms timer is armed`)
    clock.now = timer.at + timer.ms
    timer.fired = true
    timer.fn()
  }
  /** The live claude draws the dev-channels gate on the shared console. */
  const drawGate = () => screen.push(GATE_TEXT, '  1. I am using this for local development', '  2. Exit')
  const end = async () => {
    stop.abort()
    return done
  }
  return { files, claudes, helpers, prints, timers, treeEnds, events, screen, clock, done, armed, fire, drawGate, abort: () => stop.abort(), end }
}

async function waitUntil(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

/** Lets every queued callback run, so "nothing happened" is a measured answer. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 3))
}

const launched = (h: ReturnType<typeof harness>, n: number) =>
  waitUntil(() => h.claudes.length === n && h.helpers.length === n, `launch ${n} (claude through its npm shim, and its gate helper)`)

const sessionArgsOf = (proc: FakeProc) => proc.args.slice(-2)
const transcript = (id: string) => sessionTranscriptPath(HOME, CWD, id, '')

// -- 1. the process tree ---------------------------------------------------------------------------

test('the harness is the npm shim shape: claude runs as cmd.exe /c claude.cmd', async () => {
  const h = harness()
  await launched(h, 1)
  assert.equal(h.claudes[0]!.file, COMSPEC)
  assert.deepEqual(h.claudes[0]!.args.slice(0, 2), ['/c', 'claude.cmd'])
  await h.end()
})

test('a restart marker on Windows ends claudes whole process tree, not only the cmd.exe of its npm shim', async () => {
  const h = harness()
  await launched(h, 1)
  h.files.set(MARKER_PATH, '{}')
  await launched(h, 2)
  assert.deepEqual(h.treeEnds, [h.claudes[0]!.pid], 'the tree under the shim was ended')
  assert.equal(h.claudes[0]!.killed, false, 'no bare TerminateProcess on cmd.exe alone')
  await h.end()
})

test('an unproven gate (exit 6) on Windows ends the whole tree before the relaunch', async () => {
  const h = harness()
  await launched(h, 1)
  h.helpers[0]!.emit('exit', UNPROVEN, null)
  await launched(h, 2)
  assert.deepEqual(h.treeEnds, [h.claudes[0]!.pid])
  assert.equal(h.claudes[0]!.killed, false)
  await h.end()
})

test('no channel heartbeat at 3 minutes on Windows ends the whole tree before the relaunch', async () => {
  const h = harness()
  await launched(h, 1)
  h.fire(THREE_MIN)
  await launched(h, 2)
  assert.deepEqual(h.treeEnds, [h.claudes[0]!.pid])
  assert.equal(h.claudes[0]!.killed, false)
  await h.end()
})

test('a stop request on Windows ends the whole tree too: the launcher never leaves the real claude behind', async () => {
  const h = harness()
  await launched(h, 1)
  h.abort()
  await h.done
  assert.deepEqual(h.treeEnds, [h.claudes[0]!.pid])
  assert.equal(h.claudes[0]!.killed, false)
  assert.equal(h.claudes.length, 1, 'nothing relaunched')
})

test('a tree that cannot be ended still gets its first process ended, and the launcher says so', async () => {
  const h = harness({ endTree: 'fail' })
  await launched(h, 1)
  h.files.set(MARKER_PATH, '{}')
  await launched(h, 2)
  assert.deepEqual(h.treeEnds, [h.claudes[0]!.pid])
  assert.equal(h.claudes[0]!.killed, true, 'TerminateProcess on cmd.exe, as before, rather than nothing')
  assert.ok(h.prints.some((line) => line.includes('processes under claude') && line.includes(String(h.claudes[0]!.pid))), h.prints.join('\n'))
  await h.end()
})

test('a claude that already exited is never sent to the tree ender (its pid may belong to someone else now)', async () => {
  const h = harness()
  await launched(h, 1)
  const first = h.claudes[0]!
  // claude ends by itself; keep-alive relaunches it.
  first.exit(1)
  await launched(h, 2)
  h.files.set(MARKER_PATH, '{}')
  await launched(h, 3)
  assert.deepEqual(h.treeEnds, [h.claudes[1]!.pid], 'only the live claude, never the pid of one that is gone')
  await h.end()
})

test('a claude whose exit is already recorded (node sets exitCode just before it emits exit) is never sent to the tree ender', async () => {
  const h = harness()
  await launched(h, 1)
  const first = h.claudes[0]!
  first.exitCode = 1
  h.files.set(MARKER_PATH, '{}')
  await waitUntil(() => first.killed, 'the restart to end claude')
  assert.deepEqual(h.treeEnds, [], 'its pid may be someone else by now: only its own kill(), a no-op on an exited child')
  await launched(h, 2)
  await h.end()
})

test('posix is unchanged: a marker relaunch is a plain kill, no tree ender', async () => {
  const files = new Map<string, string>()
  const spawns: FakeProc[] = []
  const treeEnds: number[] = []
  const stop = new AbortController()
  const done = superviseClaude(BASE_ARGS, {
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    home: '/home/mark',
    cwd: '/agents/888',
    scriptDir: '/home/mark/bgos-claude-plugin/bin',
    readFile: (p: string) => (p === `/agents/888/${FOLDER_PIN_FILE}` ? '888' : files.get(p) ?? null),
    listDir: () => [],
    spawnImpl: ((file: string, args: readonly string[]) => {
      const proc = new FakeProc(4000 + spawns.length, file, args)
      spawns.push(proc)
      return proc
    }) as never,
    endProcessTree: (pid: number) => {
      treeEnds.push(pid)
      return true
    },
    writeErr: () => {},
    exists: (p: string) => files.has(p),
    writeFile: (p: string, content: string) => {
      files.set(p, content)
      return true
    },
    removeFile: (p: string) => files.delete(p),
    print: () => {},
    pollMs: 5,
    hasExpect: false,
    signal: stop.signal,
    listProcesses: () => [],
    pidProcess: () => null,
    pidAlive: () => false,
    generateId: () => PIN,
  } as never)
  await waitUntil(() => spawns.length === 1, 'the first launch')
  files.set('/home/mark/.bgos-agent/888/restart-requested.json', '{}')
  await waitUntil(() => spawns.length === 2, 'the relaunch')
  assert.equal(spawns[0]!.killed, true)
  assert.deepEqual(treeEnds, [])
  stop.abort()
  await done
})

test('a launch through an injected spawn never reaches the real process listing or kill: the default tree ender is for real children only', async () => {
  const calls: unknown[][] = []
  const h = harness({
    // A SystemRoot, so the System32 listing could be named: only the guard keeps it from running.
    env: { ...SUPERVISED, SystemRoot: 'C:\\Windows' },
    endTree: false,
    spawnSyncImpl: (...args: unknown[]) => {
      calls.push(args)
      return { status: 0 }
    },
  })
  await launched(h, 1)
  h.files.set(MARKER_PATH, '{}')
  await launched(h, 2)
  assert.deepEqual(calls, [], 'a fake child is ended by its own kill(), never by a kill aimed at its made up pid')
  assert.equal(h.claudes[0]!.killed, true)
  await h.end()
})

/** One Win32_Process row as the shim tree query prints it: pid, parent pid, start (ms), name. */
const row = (pid: number, ppid: number, startedAtMs: number | null, name: string) => `${pid} ${ppid} ${startedAtMs ?? '-'} ${name}`

/** hoai (1000) > cmd.exe shim (2000) > claude (3000) > daemon (4000, an MCP server) > browser host
 *  (5000, detached by the daemon, built to close Chrome after the daemon is gone), and a person
 *  lane's supervisor (6000, detached by the daemon, running another person's claude). */
const SHIM_LISTING = [
  row(1000, 900, 100, 'node.exe'),
  row(2000, 1000, 200, 'cmd.exe'),
  row(3000, 2000, 300, 'node.exe'),
  row(4000, 3000, 400, 'bun.exe'),
  row(5000, 4000, 500, 'node.exe'),
  row(6000, 4000, 600, 'node.exe'),
  row(7000, 2000, 150, 'Some Old App.exe'),
].join('\r\n')

test('win32ShimTargets: the shim s own children, born after it, through further cmd.exe layers only, never deeper', () => {
  assert.equal(typeof fixed.win32ShimTargets, 'function')
  const procs = fixed.parseWin32ProcessRows!(SHIM_LISTING)
  assert.deepEqual(procs.find((p) => p.pid === 7000), { pid: 7000, ppid: 2000, startedAtMs: 150, name: 'Some Old App.exe' })
  // claude only: its MCP servers end with claude's own job, and the daemon's detached browser host
  // and lane supervisors (5000, 6000) are never touched. 7000 is older than the shim: a pid Windows
  // reused, not its child.
  assert.deepEqual(fixed.win32ShimTargets!(procs, 2000), [3000])
  // A .cmd that runs another through cmd /c: the inner shim and the claude it started.
  const nested = fixed.parseWin32ProcessRows!([row(2000, 1000, 200, 'cmd.exe'), row(2100, 2000, 210, 'CMD.EXE'), row(3000, 2100, 300, 'claude.exe'), row(4000, 3000, 400, 'bun.exe')].join('\n'))
  assert.deepEqual(fixed.win32ShimTargets!(nested, 2000), [2100, 3000])
  // An unknown start time is no proof of a child: never ended.
  assert.deepEqual(fixed.win32ShimTargets!(fixed.parseWin32ProcessRows!([row(2000, 1000, 200, 'cmd.exe'), row(3000, 2000, null, 'node.exe')].join('\n')), 2000), [])
  assert.deepEqual(fixed.win32ShimTargets!(procs, 9999), [], 'a shim not in the listing has nothing under it to end')
})

test('endWin32ShimTree: lists processes with System32 powershell, ends the claude under the shim and then the shim, nothing deeper', () => {
  assert.equal(typeof fixed.endWin32ShimTree, 'function')
  const calls: { file: string; args: string[]; opts: Record<string, unknown> }[] = []
  const killed: number[] = []
  const spawnSyncImpl = (file: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ file, args, opts })
    return { status: 0, stdout: SHIM_LISTING }
  }
  const env = { SystemRoot: 'C:\\Windows' }
  assert.equal(fixed.endWin32ShimTree!(2000, { spawnSyncImpl, env, kill: (pid: number) => killed.push(pid) }), true)
  assert.equal(calls[0]!.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.match(calls[0]!.args.join(' '), /Get-CimInstance Win32_Process/)
  assert.doesNotMatch(calls[0]!.args.join(' '), /CommandLine/, 'pid, parent pid, start and name only')
  assert.equal(calls[0]!.opts.windowsHide, true)
  assert.ok(Number(calls[0]!.opts.timeout) > 0, 'bounded')
  assert.deepEqual(killed, [3000, 2000], 'claude first, then the shim; the daemon s browser host and lane supervisors live on')
  // A target already gone is no failure.
  killed.length = 0
  const gone = (pid: number) => {
    killed.push(pid)
    if (pid === 3000) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
  }
  assert.equal(fixed.endWin32ShimTree!(2000, { spawnSyncImpl, env, kill: gone }), true)
  assert.deepEqual(killed, [3000, 2000])
})

test('endWin32ShimTree fails closed: no SystemRoot, a failed or timed out listing, a shim not listed, a junk pid: false, nothing ended', () => {
  const killed: number[] = []
  const kill = (pid: number) => killed.push(pid)
  const listing = (status: number | null, stdout = SHIM_LISTING) => () => ({ status, stdout })
  const env = { SystemRoot: 'C:\\Windows' }
  let asked = 0
  const counting = () => {
    asked += 1
    return { status: 0, stdout: SHIM_LISTING }
  }
  assert.equal(fixed.endWin32ShimTree!(2000, { spawnSyncImpl: counting, env: {}, kill }), false, 'never a bare powershell.exe looked up from the agent folder')
  assert.equal(asked, 0)
  assert.equal(fixed.endWin32ShimTree!(2000, { spawnSyncImpl: listing(1), env, kill }), false)
  assert.equal(fixed.endWin32ShimTree!(2000, { spawnSyncImpl: listing(null), env, kill }), false, 'timed out')
  assert.equal(fixed.endWin32ShimTree!(2000, { spawnSyncImpl: listing(0, row(1000, 900, 100, 'node.exe')), env, kill }), false, 'the shim is not listed')
  const throwing = () => {
    throw new Error('boom')
  }
  assert.equal(fixed.endWin32ShimTree!(2000, { spawnSyncImpl: throwing, env, kill }), false)
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.equal(fixed.endWin32ShimTree!(bad, { spawnSyncImpl: counting, env, kill }), false, `pid ${bad}`)
  }
  assert.equal(asked, 0, 'a junk pid is never even looked up')
  assert.deepEqual(killed, [], 'a failure ends nothing: the caller falls back to its own kill()')
})

// -- 2. the console a killed claude leaves behind ---------------------------------------------------

test('a relaunch clears the console before the new claude starts: the new helper never reads the killed claudes gate', async () => {
  const h = harness()
  await launched(h, 1)
  h.drawGate()
  // The first claude's gate stays on screen (an Enter that never took); then an update restart.
  h.files.set(MARKER_PATH, '{}')
  await launched(h, 2)
  assert.equal(h.helpers[1]!.sawAtStart, false, 'the new helper must not see the old gate before the new claude draws one')
  const second = h.events.indexOf(`spawn-claude:${h.claudes[1]!.pid}`)
  const cleared = h.events.lastIndexOf('clear-console')
  assert.ok(cleared >= 0 && cleared < second, `cleared before the relaunch spawn: ${h.events.join(', ')}`)
  assert.ok(h.events.indexOf(`end-tree:${h.claudes[0]!.pid}`) < cleared, 'and only once the old claude was ended')
  await h.end()
})

test('every relaunch path clears first: unproven gate, no heartbeat, keep-alive after an exit', async () => {
  const h = harness()
  await launched(h, 1)
  h.drawGate()
  h.helpers[0]!.emit('exit', UNPROVEN, null)
  await launched(h, 2)
  assert.equal(h.helpers[1]!.sawAtStart, false, 'after an unproven gate')
  h.drawGate()
  h.fire(THREE_MIN)
  await launched(h, 3)
  assert.equal(h.helpers[2]!.sawAtStart, false, 'after no heartbeat')
  h.drawGate()
  h.claudes[2]!.exit(1)
  await launched(h, 4)
  assert.equal(h.helpers[3]!.sawAtStart, false, 'after claude exited by itself')
  assert.equal(h.events.filter((e) => e === 'clear-console').length, 3)
  await h.end()
})

test('the first launch never clears: a person running hoai keeps their screen', async () => {
  const h = harness({ env: { ComSpec: COMSPEC }, keepAlive: false })
  h.screen.push('a person typed something here')
  await launched(h, 1)
  assert.equal(h.events.includes('clear-console'), false)
  assert.deepEqual(h.screen, ['a person typed something here'])
  await h.end()
})

test('clearWin32Console: leaves a stale alternate screen, erases the screen and the scrollback, homes the cursor; a TTY only', () => {
  assert.equal(fixed.WIN32_CONSOLE_CLEAR, '\x1b[?1049l\x1b[2J\x1b[3J\x1b[H')
  const writes: string[] = []
  assert.equal(fixed.clearWin32Console!({ isTTY: true, write: (text: string) => writes.push(text) }), true)
  assert.deepEqual(writes, [fixed.WIN32_CONSOLE_CLEAR])
  assert.equal(fixed.clearWin32Console!({ isTTY: false, write: (text: string) => writes.push(text) }), false)
  assert.equal(
    fixed.clearWin32Console!({
      isTTY: true,
      write: () => {
        throw new Error('EPIPE')
      },
    }),
    false,
  )
  assert.equal(writes.length, 1, 'a redirected stdout gets nothing: claude does not draw there either')
})

// -- 3. a relaunch inside the fresh session's window ------------------------------------------------

/** The pin names PIN with a transcript; its resume is rejected at once; the fresh retry is FRESH. */
async function freshWindow() {
  const h = harness({ ids: [FRESH], files: { [PIN_PATH]: PIN, [transcript(PIN)]: '{}\n' } })
  await launched(h, 1)
  assert.deepEqual(sessionArgsOf(h.claudes[0]!), ['--resume', PIN])
  h.claudes[0]!.exit(1)
  await launched(h, 2)
  assert.deepEqual(sessionArgsOf(h.claudes[1]!), ['--session-id', FRESH], 'the one fresh retry')
  assert.equal(h.files.get(PIN_PATH), PIN, 'not pinned yet: inside its window')
  return h
}

test('an unproven gate inside the fresh sessions window relaunches the FRESH session, not the rejected one', async () => {
  const h = await freshWindow()
  h.helpers[1]!.emit('exit', UNPROVEN, null)
  await launched(h, 3)
  assert.deepEqual(sessionArgsOf(h.claudes[2]!), ['--session-id', FRESH])
  assert.equal(h.claudes[2]!.args.includes(PIN), false, 'never back to the session whose resume was just rejected')
  await h.end()
})

test('an update restart inside the window resumes the fresh session once it has a transcript', async () => {
  const h = await freshWindow()
  h.files.set(transcript(FRESH), '{}\n')
  h.files.set(MARKER_PATH, '{}')
  await launched(h, 3)
  assert.deepEqual(sessionArgsOf(h.claudes[2]!), ['--resume', FRESH])
  await h.end()
})

test('the fresh session carried through a relaunch is judged again: pinned once THAT launch outlives the window', async () => {
  const h = await freshWindow()
  h.files.set(MARKER_PATH, '{}')
  await launched(h, 3)
  assert.equal(h.files.get(PIN_PATH), PIN, 'still the previous pin right after the relaunch')
  h.fire(HEALTHY_MS)
  assert.equal(h.files.get(PIN_PATH), FRESH, 'the relaunched fresh session stayed up, so it is the pin now')
  await h.end()
})

test('the window still does its job: a fresh session that dies by itself inside it leaves the previous pin', async () => {
  const h = await freshWindow()
  h.claudes[1]!.exit(1)
  await launched(h, 3)
  assert.deepEqual(sessionArgsOf(h.claudes[2]!), ['--resume', PIN])
  assert.equal(h.files.get(PIN_PATH), PIN)
  await h.end()
})

test('a pin the daemon rewrote inside the window names the live session, and wins over the carry', async () => {
  const h = await freshWindow()
  const LIVE = 'abababab-abab-4bab-8bab-abababababab'
  h.files.set(PIN_PATH, LIVE)
  h.files.set(transcript(LIVE), '{}\n')
  h.files.set(MARKER_PATH, '{}')
  await launched(h, 3)
  assert.deepEqual(sessionArgsOf(h.claudes[2]!), ['--resume', LIVE])
  await h.end()
})

test('after the window committed the fresh session, a relaunch resumes the pin as always', async () => {
  const h = await freshWindow()
  h.fire(HEALTHY_MS)
  assert.equal(h.files.get(PIN_PATH), FRESH)
  h.files.set(transcript(FRESH), '{}\n')
  h.files.set(MARKER_PATH, '{}')
  await launched(h, 3)
  assert.deepEqual(sessionArgsOf(h.claudes[2]!), ['--resume', FRESH])
  await h.end()
})

// -- 4. a budget of their own -----------------------------------------------------------------------

test('health relaunches have their own budget: 3 of them in an hour leave the update restarts theirs', async () => {
  assert.equal(fixed.MAX_HEALTH_RELAUNCHES_PER_WINDOW, 3)
  const h = harness()
  for (let n = 1; n <= 3; n += 1) {
    await launched(h, n)
    h.helpers[n - 1]!.emit('exit', UNPROVEN, null)
  }
  await launched(h, 4)
  h.files.set(MARKER_PATH, '{}')
  await launched(h, 5)
  assert.ok(!h.prints.some((line) => line.includes('restart marker ignored')), h.prints.join('\n'))
  await h.end()
})

test('update restarts have their own budget: 3 of them in an hour leave the health relaunches theirs', async () => {
  const h = harness()
  for (let n = 1; n <= MAX_RELAUNCHES_PER_WINDOW; n += 1) {
    await launched(h, n)
    h.files.set(MARKER_PATH, '{}')
  }
  await launched(h, MAX_RELAUNCHES_PER_WINDOW + 1)
  h.helpers[MAX_RELAUNCHES_PER_WINDOW]!.emit('exit', UNPROVEN, null)
  await launched(h, MAX_RELAUNCHES_PER_WINDOW + 2)
  assert.match(h.files.get(STATUS_PATH) ?? '', /outcome=health-relaunch reason=gate-accept-unproven/)
  await h.end()
})

test('the health budget still bounds itself: the fourth health relaunch in an hour is refused, and names its own budget', async () => {
  const h = harness()
  for (let n = 1; n <= 3; n += 1) {
    await launched(h, n)
    h.helpers[n - 1]!.emit('exit', UNPROVEN, null)
  }
  await launched(h, 4)
  h.fire(THREE_MIN)
  await settle()
  assert.equal(h.claudes.length, 4)
  assert.match(h.files.get(STATUS_PATH) ?? '', /outcome=health-relaunch-refused reason=no-channel-heartbeat/)
  assert.ok(h.prints.some((line) => line.includes('3 health relaunches in the last hour')), h.prints.join('\n'))
  await h.end()
})

test('the health budget is a rolling hour too', async () => {
  const h = harness()
  for (let n = 1; n <= 3; n += 1) {
    await launched(h, n)
    h.helpers[n - 1]!.emit('exit', UNPROVEN, null)
  }
  await launched(h, 4)
  h.clock.now += 60 * 60_000
  h.helpers[3]!.emit('exit', UNPROVEN, null)
  await launched(h, 5)
  await h.end()
})

// -- 5. a Claude login every agent here shares has failed -------------------------------------------

test('no heartbeat at 3 minutes while the shared Claude login has failed: an alert, no relaunch', async () => {
  const h = harness({ claudeLoginFailure: () => ({ at: T0 + 30_000, text: 'Login expired · Please run /login' }) })
  await launched(h, 1)
  h.fire(THREE_MIN)
  await settle()
  assert.equal(h.claudes.length, 1, 'no relaunch: a new claude meets the same expired login')
  assert.deepEqual(h.treeEnds, [])
  assert.match(h.files.get(STATUS_PATH) ?? '', /outcome=claude-login-expired /)
  const alert = h.prints.find((line) => line.includes('ALERT (claude-login-expired)'))
  assert.ok(alert, h.prints.join('\n'))
  assert.match(alert, /\/login/)
  assert.match(alert, /Login expired/)
  await h.end()
})

test('the login alert spends nothing: once the login works again, a launch without a heartbeat is relaunched once', async () => {
  let failure: { at: number; text: string } | null = { at: T0, text: 'Not logged in · Please run /login' }
  const files = new Map<string, string>()
  const claudes: FakeProc[] = []
  const timers: FakeTimer[] = []
  const clock = { now: T0 }
  const stop = new AbortController()
  const done = superviseClaude(BASE_ARGS, {
    platform: 'win32',
    env: SUPERVISED,
    home: HOME,
    cwd: CWD,
    scriptDir: SCRIPT_DIR,
    readFile: (p: string) => (p === `${CWD}\\${FOLDER_PIN_FILE}` ? '888' : files.get(p) ?? null),
    listDir: () => [],
    spawnImpl: ((file: string, args: readonly string[]) => {
      const proc = new FakeProc(26000 + claudes.length, file, args)
      if (file !== COMSPEC) {
        setImmediate(() => proc.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })))
        return proc
      }
      claudes.push(proc)
      return proc
    }) as never,
    endProcessTree: (pid: number) => {
      const proc = claudes.find((c) => c.pid === pid)
      setImmediate(() => proc?.end(1, null))
      return true
    },
    clearConsole: () => {},
    claudeLoginFailure: () => failure,
    spawnGateHelper: () => new FakeHelper(31000, false),
    writeErr: () => {},
    exists: (p: string) => files.has(p),
    writeFile: (p: string, content: string) => {
      files.set(p, content)
      return true
    },
    removeFile: (p: string) => files.delete(p),
    print: () => {},
    now: () => clock.now,
    setTimer: ((fn: () => void, ms: number) => {
      const timer: FakeTimer = { fn, ms, at: clock.now, cleared: false, fired: false }
      timers.push(timer)
      return timer
    }) as never,
    clearTimer: ((timer: FakeTimer | null) => {
      if (timer) timer.cleared = true
    }) as never,
    sleep: async () => {},
    pollMs: 5,
    keepAlive: true,
    signal: stop.signal,
    listProcesses: () => [],
    pidProcess: () => null,
    pidAlive: () => false,
    generateId: () => PIN,
  } as never)
  await waitUntil(() => claudes.length === 1, 'launch 1')
  const check = timers.find((t) => t.ms === THREE_MIN && !t.cleared)!
  clock.now = check.at + check.ms
  check.fired = true
  check.fn()
  await settle()
  assert.equal(claudes.length, 1)
  assert.match(files.get(`${STATE_DIR}\\${LAUNCH_STATUS_FILE_NAME}`) ?? '', /outcome=claude-login-expired/)
  // Someone signs in again; an update restart; that launch never brings its channel up.
  failure = null
  files.set(MARKER_PATH, '{}')
  await waitUntil(() => claudes.length === 2, 'the update restart')
  const next = timers.filter((t) => t.ms === THREE_MIN && !t.cleared && !t.fired).at(-1)!
  clock.now = next.at + next.ms
  next.fired = true
  next.fn()
  await waitUntil(() => claudes.length === 3, 'the one heartbeat relaunch, unspent by the alert')
  stop.abort()
  await done
})

test('the check comes back after a login alert: alerted once while the login stays failed, then the one relaunch once it works', async () => {
  let failure: { at: number; text: string } | null = { at: T0 + 30_000, text: 'Login expired · Please run /login' }
  const h = harness({ claudeLoginFailure: () => failure })
  await launched(h, 1)
  h.fire(THREE_MIN)
  await settle()
  const alerts = () => h.prints.filter((line) => line.includes('ALERT (claude-login-expired)')).length
  assert.equal(alerts(), 1)
  h.fire(THREE_MIN)
  await settle()
  assert.equal(h.claudes.length, 1, 'still failing: no relaunch')
  assert.equal(alerts(), 1, 'and no second alert for the same launch')
  // Someone runs /login; this launch's channel is still silent: a different cause, the one relaunch.
  failure = null
  h.fire(THREE_MIN)
  await launched(h, 2)
  assert.match(h.files.get(STATUS_PATH) ?? '', /outcome=health-relaunch reason=no-channel-heartbeat/)
  await h.end()
})

test('a heartbeat that arrives after a login alert ends the checks: nothing relaunched, nothing armed', async () => {
  let failure: { at: number; text: string } | null = { at: T0 + 30_000, text: 'Login expired · Please run /login' }
  const h = harness({ claudeLoginFailure: () => failure })
  await launched(h, 1)
  h.fire(THREE_MIN)
  await settle()
  failure = null
  h.files.set(`${HOME}\\.bgos-plugin-state\\888\\channel-beacon.json`, JSON.stringify({ beaconAt: T0 + 4 * 60_000, pid: 7140 }))
  h.fire(THREE_MIN)
  await settle()
  assert.equal(h.claudes.length, 1)
  assert.equal(h.armed(THREE_MIN), undefined)
  await h.end()
})

test('the login alert names the newest failure it read, and when', async () => {
  const h = harness({ claudeLoginFailure: () => ({ at: T0 + 30_000, text: 'Login expired · Please run /login' }) })
  await launched(h, 1)
  h.fire(THREE_MIN)
  await settle()
  assert.match(h.files.get(STATUS_PATH) ?? '', /outcome=claude-login-expired waited=180s lastFailedAt=2026-10-18T07:00:30.000Z /)
  assert.ok(h.prints.some((line) => line.includes('the newest failure recorded at 2026-10-18T07:00:30.000Z')), h.prints.join('\n'))
  await h.end()
})

test('a heartbeat in time never asks about the login', async () => {
  let asked = 0
  const h = harness({
    claudeLoginFailure: () => {
      asked += 1
      return { at: T0, text: 'Login expired · Please run /login' }
    },
  })
  await launched(h, 1)
  h.files.set(`${HOME}\\.bgos-plugin-state\\888\\channel-beacon.json`, JSON.stringify({ beaconAt: T0 + 20_000, pid: 7140 }))
  h.fire(THREE_MIN)
  await settle()
  assert.equal(h.claudes.length, 1)
  assert.equal(h.files.has(STATUS_PATH), false)
  assert.equal(asked, 0, 'the transcripts are read only for a launch that has no heartbeat')
  await h.end()
})

// -- 5. the detector: the newest login record across every agent of this credential store ----------

const CONFIG = 'C:\\Users\\mark\\.claude'
const PROJECTS = `${CONFIG}\\projects`
const NOW = T0

function record(kind: 'failed' | 'activity' | 'sidechain-activity' | 'synthetic' | 'rate-limit', at: number, text = 'Login expired · Please run /login') {
  const timestamp = new Date(at).toISOString()
  if (kind === 'failed') {
    return JSON.stringify({ type: 'assistant', timestamp, isApiErrorMessage: true, error: 'authentication_failed', message: { model: '<synthetic>', content: [{ type: 'text', text }] } })
  }
  if (kind === 'rate-limit') {
    return JSON.stringify({ type: 'assistant', timestamp, isApiErrorMessage: true, error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: 'limit' }] } })
  }
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    ...(kind === 'sidechain-activity' ? { isSidechain: true } : {}),
    message: { model: kind === 'synthetic' ? '<synthetic>' : 'claude-opus', content: [{ type: 'text', text: 'hi' }] },
  })
}

/** A fake credential store: projects/<agent folder>/<session>.jsonl with an mtime each. */
function store(transcripts: Record<string, { mtime: number; lines: string[] }>) {
  const dirs = new Map<string, string[]>()
  for (const path of Object.keys(transcripts)) {
    const [dir, name] = path.split('/') as [string, string]
    dirs.set(dir, [...(dirs.get(dir) ?? []), name])
  }
  const reads: string[] = []
  return {
    reads,
    input: {
      configDir: CONFIG,
      now: NOW,
      listDir: (path: string) => {
        if (path === PROJECTS) return [...dirs.keys(), 'not-a-dir.txt']
        const dir = path.slice(PROJECTS.length + 1)
        if (!dirs.has(dir)) throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' })
        return [...dirs.get(dir)!, 'memory.md']
      },
      mtimeMs: (path: string) => {
        const key = path.slice(PROJECTS.length + 1).replace('\\', '/')
        return transcripts[key]?.mtime ?? null
      },
      readTail: (path: string) => {
        reads.push(path)
        const key = path.slice(PROJECTS.length + 1).replace('\\', '/')
        const t = transcripts[key]
        return t ? `${t.lines.join('\n')}\n` : null
      },
    },
  }
}

test('fleetClaudeLoginFailure: the newest login record across every agent here is a failure: failing, with the CLIs words', () => {
  assert.equal(typeof fixed.fleetClaudeLoginFailure, 'function')
  const s = store({
    'C--agents-888/a.jsonl': { mtime: NOW - 60_000, lines: [record('activity', NOW - 9 * 60_000), record('failed', NOW - 60_000)] },
    'C--agents-871/b.jsonl': { mtime: NOW - 30_000, lines: [record('failed', NOW - 30_000, 'Not logged in · Please run /login')] },
  })
  assert.deepEqual(fixed.fleetClaudeLoginFailure!(s.input), { at: NOW - 30_000, text: 'Not logged in · Please run /login' })
})

test('fleetClaudeLoginFailure: any agent that answered after the newest failure proves the login works', () => {
  const s = store({
    'C--agents-888/a.jsonl': { mtime: NOW - 60_000, lines: [record('failed', NOW - 60_000)] },
    'C--agents-871/b.jsonl': { mtime: NOW - 10_000, lines: [record('activity', NOW - 10_000)] },
  })
  assert.equal(fixed.fleetClaudeLoginFailure!(s.input), null)
})

test('fleetClaudeLoginFailure: only fresh records count (10 minutes, the daemons rule), and stale files are not even read', () => {
  const s = store({
    'C--agents-888/a.jsonl': { mtime: NOW - 11 * 60_000, lines: [record('failed', NOW - 11 * 60_000)] },
    'C--agents-871/b.jsonl': { mtime: NOW - 60_000, lines: [record('failed', NOW - 11 * 60_000)] },
  })
  assert.equal(fixed.fleetClaudeLoginFailure!(s.input), null)
  assert.deepEqual(s.reads, [`${PROJECTS}\\C--agents-871\\b.jsonl`], 'the file untouched for 11 minutes was skipped by its mtime')
})

test('fleetClaudeLoginFailure: a sidechain or synthetic turn is no proof the login works; a usage cap is not a login failure', () => {
  const s = store({
    'C--agents-888/a.jsonl': {
      mtime: NOW,
      lines: [record('failed', NOW - 60_000), record('sidechain-activity', NOW - 50_000), record('synthetic', NOW - 40_000), record('rate-limit', NOW - 30_000)],
    },
  })
  assert.deepEqual(fixed.fleetClaudeLoginFailure!(s.input), { at: NOW - 60_000, text: 'Login expired · Please run /login' })
})

test('fleetClaudeLoginFailure: nothing to read (no projects folder, junk lines) is no failure', () => {
  const none = {
    configDir: CONFIG,
    now: NOW,
    listDir: () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    mtimeMs: () => null,
    readTail: () => null,
  }
  assert.equal(fixed.fleetClaudeLoginFailure!(none), null)
  const s = store({ 'C--agents-888/a.jsonl': { mtime: NOW, lines: ['{not json', '[]', 'null', JSON.stringify({ type: 'user' })] } })
  assert.equal(fixed.fleetClaudeLoginFailure!(s.input), null)
})

test('loginSignalOf mirrors lib/claude-login.ts extractLoginSignal on every record shape (hoai runs under bare node, no TS import)', () => {
  assert.equal(typeof fixed.loginSignalOf, 'function')
  const chunks = [
    [record('failed', NOW - 1000)],
    [record('activity', NOW - 1000)],
    [record('failed', NOW - 2000), record('activity', NOW - 1000)],
    [record('activity', NOW - 2000), record('failed', NOW - 1000, 'Please run /login · API Error: 401 OAuth access token has expired')],
    [record('sidechain-activity', NOW - 1000)],
    [record('synthetic', NOW - 1000)],
    [record('rate-limit', NOW - 1000)],
    [record('failed', NOW - 11 * 60_000)],
    [record('failed', NOW - 1000, `control\u0007chars\nand a very long line ${'x'.repeat(300)}`)],
    [JSON.stringify({ type: 'assistant', message: { content: [] } })],
    [JSON.stringify({ type: 'assistant', timestamp: 'nonsense', message: { model: 'm', content: [] } })],
    ['{broken', ''],
  ]
  for (const lines of chunks) {
    const chunk = `${lines.join('\n')}\n`
    assert.deepEqual(fixed.loginSignalOf!(chunk, NOW), extractLoginSignal(chunk, NOW), chunk.slice(0, 200))
  }
})

/** superviseClaude on Windows with the DEFAULT login detector, fed through `listDir`. */
function bare(env: Record<string, string>, listDir: (path: string) => string[]) {
  const files = new Map<string, string>()
  const claudes: FakeProc[] = []
  const timers: FakeTimer[] = []
  const prints: string[] = []
  const clock = { now: T0 }
  const stop = new AbortController()
  const done = superviseClaude(BASE_ARGS, {
    platform: 'win32',
    env,
    home: HOME,
    cwd: CWD,
    scriptDir: SCRIPT_DIR,
    readFile: (p: string) => (p === `${CWD}\\${FOLDER_PIN_FILE}` ? '888' : files.get(p) ?? null),
    listDir,
    spawnImpl: ((file: string, args: readonly string[]) => {
      const proc = new FakeProc(27000 + claudes.length, file, args)
      if (file !== COMSPEC) {
        setImmediate(() => proc.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })))
        return proc
      }
      claudes.push(proc)
      return proc
    }) as never,
    endProcessTree: (pid: number) => {
      const proc = claudes.find((c) => c.pid === pid)
      setImmediate(() => proc?.end(1, null))
      return true
    },
    clearConsole: () => {},
    spawnGateHelper: () => new FakeHelper(32000, false),
    writeErr: () => {},
    exists: (p: string) => files.has(p),
    writeFile: (p: string, content: string) => {
      files.set(p, content)
      return true
    },
    removeFile: (p: string) => files.delete(p),
    print: (line: string) => prints.push(line),
    now: () => clock.now,
    setTimer: ((fn: () => void, ms: number) => {
      const timer: FakeTimer = { fn, ms, at: clock.now, cleared: false, fired: false }
      timers.push(timer)
      return timer
    }) as never,
    clearTimer: ((timer: FakeTimer | null) => {
      if (timer) timer.cleared = true
    }) as never,
    sleep: async () => {},
    pollMs: 5,
    keepAlive: true,
    signal: stop.signal,
    listProcesses: () => [],
    pidProcess: () => null,
    pidAlive: () => false,
    generateId: () => PIN,
  } as never)
  const fireHeartbeatCheck = () => {
    const check = timers.filter((t) => t.ms === THREE_MIN && !t.cleared && !t.fired).at(-1)!
    clock.now = check.at + check.ms
    check.fired = true
    check.fn()
  }
  const end = async () => {
    stop.abort()
    await done
  }
  return { files, claudes, prints, fireHeartbeatCheck, end }
}

test('superviseClaude reads the store the CLI signs in through: CLAUDE_CONFIG_DIR when set, else <home>\\.claude', async () => {
  // Pinned through the default detector's inputs: the injected listDir sees which projects folder is asked for.
  const asked: string[] = []
  for (const env of [SUPERVISED, { ...SUPERVISED, CLAUDE_CONFIG_DIR: 'D:\\claude-store' }]) {
    const b = bare(env, (path) => {
      asked.push(path)
      return []
    })
    await waitUntil(() => b.claudes.length === 1, 'launch 1')
    b.fireHeartbeatCheck()
    await waitUntil(() => b.claudes.length === 2, 'no failure found: the relaunch, as before')
    await b.end()
  }
  assert.ok(asked.includes(`${HOME}\\.claude\\projects`), asked.join('\n'))
  assert.ok(asked.includes('D:\\claude-store\\projects'), asked.join('\n'))
})

test('the default detector reads real transcripts: an expired login another agent recorded on disk is an alert, not a relaunch', async () => {
  const store = mkdtempSync(join(tmpdir(), 'hoai-login-store-'))
  const agent = join(store, 'projects', 'C--agents-871')
  mkdirSync(agent, { recursive: true })
  // Written now (a fresh mtime), recorded 30 s before the fake clock's launch check.
  writeFileSync(join(agent, 'b.jsonl'), `${record('activity', T0 - 60_000)}\n${record('failed', T0 + THREE_MIN - 30_000)}\n`)
  const b = bare({ ...SUPERVISED, CLAUDE_CONFIG_DIR: store }, (path) => (path.startsWith(store) ? readdirSync(path) : []))
  await waitUntil(() => b.claudes.length === 1, 'launch 1')
  b.fireHeartbeatCheck()
  await settle()
  assert.equal(b.claudes.length, 1)
  assert.ok(b.prints.some((line) => line.includes('ALERT (claude-login-expired)') && line.includes('Login expired')), b.prints.join('\n'))
  await b.end()
})

test('readFileTail and fileMtimeMs on real files: the tail starts at a whole line, a missing file is null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hoai-login-tail-'))
  const file = join(dir, 'a.jsonl')
  const lines = [record('activity', NOW - 3000), record('failed', NOW - 2000), record('failed', NOW - 1000, 'Not logged in · Please run /login')]
  writeFileSync(file, `${lines.join('\n')}\n`)
  // The last line and 10 bytes of the one before it: those 10 bytes are dropped, never parsed.
  assert.equal(fixed.readFileTail!(file, Buffer.byteLength(`${lines[2]}\n`) + 10), `${lines[2]}\n`)
  assert.equal(fixed.readFileTail!(file, 1 << 20), `${lines.join('\n')}\n`)
  assert.equal(fixed.readFileTail!(join(dir, 'none.jsonl'), 1024), null)
  assert.ok(Math.abs(fixed.fileMtimeMs!(file)! - Date.now()) < 60_000)
  assert.equal(fixed.fileMtimeMs!(join(dir, 'none.jsonl')), null)
})
