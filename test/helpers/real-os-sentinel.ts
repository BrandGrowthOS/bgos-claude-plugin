/**
 * A sentinel on the real window and process layer (board row afa70b0c), for every test file that
 * drives the watcher loop (runWatcher). Imported as such a file's FIRST import, it replaces
 * process.kill and every node:child_process launcher, in that test process only, with a refusal
 * that records the call and throws before anything starts or is signalled. A test that reaches the
 * real layer (a real process listing, a real signal, a real window opened or closed) then fails by
 * name, and the computer it runs on, very often its owner's own, is never touched.
 *
 * Why: runWatcher goes on to its windows pass (lib/agent-windows.mjs runWindowsPass) whenever the
 * self refresh does not end the process. On win32 that pass lists every process through PowerShell
 * (lib/process-tree.mjs listProcesses, through the deps' exec) and, with Show agent windows off,
 * ends every HOAI viewer it lists (deps.kill, whose default is process.kill). A test that handed
 * the loop a real exec and no kill closed the owner's real viewer windows when its refresh failed.
 *
 * Two children stay allowed, both started by the test itself, neither able to list, signal or
 * close anything else: the staged bundle probe of the real files run (this node running a
 * .../bin/hoai-watcher.mjs with `help`), and tsx's own esbuild service. A signal is allowed only
 * to a child one of those started, or to this test process itself.
 *
 * One narrow door, for the start time case of test/watcher-real-os.guard.test.ts only: inside
 * throughStartTimeProbe, and only for the launch made synchronously inside it, three shapes may run
 * (a node child that only waits for its stdin to close, the watcher's own posix `ps` listing, and the
 * daemon's `ps -o lstart=` of one pid). None of them can signal or close anything, and none is added
 * to the children a signal may reach: a door launch can never be signalled from the test.
 *
 * The production defaults are unchanged (the watcher still uses process.kill and the real
 * execFile/spawn); this only makes a test that forgot to inject its fakes fail instead of acting.
 * Every refusal is kept: the file's root after hook fails while any is left untaken, so a refusal
 * that the code under test caught and only logged (runWatcher's windows pass catches everything)
 * still fails the run. A test that reaches the sentinel on purpose takes its refusals with
 * takeRealOsRefusals().
 */

import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'
import { after } from 'node:test'

import { claudeStartCommand } from '../../lib/claude-stamp.mjs'
import { psCommand } from '../../lib/process-tree.mjs'

export type RealOsRefusal = { api: string; target: string }

export class RealOsRefused extends Error {
  readonly refusal: RealOsRefusal
  constructor(refusal: RealOsRefusal) {
    super(`the real OS layer was reached from a test and refused: ${refusal.api} ${refusal.target}`)
    this.name = 'RealOsRefused'
    this.refusal = refusal
  }
}

const refusals: RealOsRefusal[] = []
const ownChildren = new Set<number>()
const LAUNCHERS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'] as const

/** Every refusal so far, and none kept: for a test that reaches the sentinel on purpose. */
export function takeRealOsRefusals(): RealOsRefusal[] {
  return refusals.splice(0)
}

/** True once this module has replaced the launchers and process.kill in this process. */
export function realOsSentinelInstalled(): boolean {
  return (childProcess.execFile as { realOsSentinel?: boolean }).realOsSentinel === true && (process.kill as { realOsSentinel?: boolean }).realOsSentinel === true
}

const sameFile = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

/** The only real children a watcher test may start: the staged bundle probe and tsx's esbuild. */
export function allowedRealChild(file: unknown, args: readonly unknown[]): boolean {
  const path = String(file ?? '')
  if (/^esbuild(\.exe)?$/i.test(basename(path))) return true
  return sameFile(path, process.execPath) && args.length === 2 && /[\\/]bin[\\/]hoai-watcher\.mjs$/.test(String(args[0])) && args[1] === 'help'
}

/** The child the start time case starts: it waits for its stdin to close, then exits by itself. */
export const START_PROBE_CHILD_SOURCE = "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"

let startTimeProbeOpen = false

/** Run one launch with the start time door open. The launch must happen synchronously inside it. */
export function throughStartTimeProbe<T>(launch: () => T): T {
  startTimeProbeOpen = true
  try {
    return launch()
  } finally {
    startTimeProbeOpen = false
  }
}

const sameArgs = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i])

/** The three shapes the door lets through, and only while it is open. */
export function startTimeProbeChild(file: unknown, args: readonly unknown[]): boolean {
  if (!startTimeProbeOpen || process.platform === 'win32') return false
  const path = String(file ?? '')
  if (sameFile(path, process.execPath)) return sameArgs(args, ['-e', START_PROBE_CHILD_SOURCE])
  const list = psCommand(process.platform)
  if (path === list.file) return sameArgs(args, list.args)
  const pid = Number(args.at(-1))
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  const one = claudeStartCommand(pid)
  return path === one.file && sameArgs(args, one.args)
}

function refuse(api: string, target: string): never {
  const refusal = { api, target: target.length > 240 ? `${target.slice(0, 240)}...` : target }
  refusals.push(refusal)
  throw new RealOsRefused(refusal)
}

if (!realOsSentinelInstalled()) {
  for (const api of LAUNCHERS) {
    const real = childProcess[api] as (...a: unknown[]) => unknown
    const sentinel = function (this: unknown, file: unknown, ...rest: unknown[]) {
      const args = Array.isArray(rest[0]) ? (rest[0] as unknown[]) : []
      // exec and execSync take a shell command line, and fork runs a module: never a probe.
      const probe = api !== 'exec' && api !== 'execSync' && api !== 'fork' && allowedRealChild(file, args)
      // A door launch runs but is never added to ownChildren, so no signal may reach it.
      if (probe || (api !== 'exec' && api !== 'execSync' && api !== 'fork' && startTimeProbeChild(file, args))) {
        const child = real.call(this, file, ...rest) as { pid?: number } | undefined
        if (probe && typeof child?.pid === 'number') ownChildren.add(child.pid)
        return child
      }
      return refuse(`child_process.${api}`, [file, ...args].map(String).join(' '))
    }
    Object.defineProperty(sentinel, 'realOsSentinel', { value: true })
    ;(childProcess as Record<string, unknown>)[api] = sentinel
  }
  const realKill = process.kill.bind(process)
  const kill = function (pid: number, signal?: string | number) {
    if (Number(pid) === process.pid || ownChildren.has(Number(pid))) return realKill(pid, signal)
    return refuse('process.kill', `pid ${pid} signal ${signal ?? 'SIGTERM'}`)
  }
  Object.defineProperty(kill, 'realOsSentinel', { value: true })
  process.kill = kill as typeof process.kill
  // The lib modules import the launchers by name (import { execFile } from 'node:child_process'):
  // this carries the replacements into those bindings too.
  syncBuiltinESMExports()

  after(() => {
    const left = takeRealOsRefusals()
    if (left.length > 0) {
      throw new Error(`a test reached the real window or process layer (refused, nothing ran): ${left.map((r) => `${r.api} ${r.target}`).join(' | ')}`)
    }
  })
}
