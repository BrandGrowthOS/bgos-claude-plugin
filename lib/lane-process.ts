/**
 * A thread lane's process, found again after a daemon crash (gate review
 * finding 3).
 *
 * A lane is a detached `claude -p` leading its own process group
 * (lib/stream-json-child.ts). A daemon that dies outright closes the lane's
 * stdin, and `claude -p` ends on that, but only after it has finished the turn
 * it is on: a restarted daemon that started the thread again meanwhile would
 * run a second lane on the same session and worktree. So the lane manager
 * writes each lane's pid and its START STAMP into the lane state, and stops a
 * process still alive under that pid and stamp before it starts the thread
 * again. The stamp is what makes the pid safe to signal: a pid the system has
 * since given to another process has another start time.
 *
 * Linux: the start time in clock ticks from /proc/<pid>/stat (field 22).
 * Elsewhere: `ps -o stat= -o lstart=`. A zombie counts as gone. Every read
 * is asynchronous. When no stamp could be read at spawn, the pid is still
 * saved, and the process is known by the folder it runs in (processRunsIn). Erasable
 * TypeScript only. No em or en dashes in this file.
 */

import { readFile as readFileAsync, readlink, realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'

type RunResult = { status: number | null; stdout?: string }
type Run = (command: string, args: string[]) => Promise<RunResult>

/** execFile as a promise that never rejects: the exit status and stdout. Never blocks the event loop. */
const runAsync: Run = (command, args) =>
  new Promise((done) => {
    try {
      execFile(command, args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 }, (err, stdout) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
        done({ status: code, stdout: String(stdout ?? '') })
      })
    } catch {
      done({ status: null, stdout: '' })
    }
  })

/**
 * The process's start stamp while it is alive (not a zombie), else null.
 * Asynchronous (follow up to finding 3): a stop polls it every 250 ms, and a
 * synchronous ps there blocked the daemon's event loop each time.
 */
export async function processStamp(
  pid: number,
  deps: { platform?: NodeJS.Platform; readFile?: (path: string) => Promise<string>; run?: Run } = {},
): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') return null
  if (platform === 'linux') {
    try {
      const stat = await (deps.readFile ?? ((p: string) => readFileAsync(p, 'utf8')))(`/proc/${pid}/stat`)
      // The command name is in parentheses and may hold spaces: count after the last one.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
      const state = fields[0] ?? ''
      const start = fields[19] ?? ''
      if (state === 'Z' || state === 'X' || !/^\d+$/.test(start)) return null
      return `linux:${start}`
    } catch {
      return null
    }
  }
  try {
    const out = await (deps.run ?? runAsync)('ps', ['-o', 'stat=', '-o', 'lstart=', '-p', String(pid)])
    const line = String(out.stdout ?? '').trim()
    if (out.status !== 0 || line === '') return null
    const [state, ...start] = line.split(/\s+/)
    if (!state || state.startsWith('Z') || start.length === 0) return null
    return start.join(' ')
  } catch {
    return null
  }
}

/**
 * The process is alive and runs in `dir` (its working directory, both real
 * paths): how a lane's process is told from a stranger when no start stamp
 * could be saved for it. Linux reads /proc/<pid>/cwd, elsewhere lsof. False
 * when it cannot be told (then nothing is signalled).
 */
export async function processRunsIn(
  pid: number,
  dir: string,
  deps: { platform?: NodeJS.Platform; run?: Run } = {},
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0 || dir === '') return false
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') return false
  let want: string
  try {
    want = await realpath(dir)
  } catch {
    return false
  }
  let cwd: string | null = null
  if (platform === 'linux') {
    try {
      cwd = await readlink(`/proc/${pid}/cwd`)
    } catch {
      return false
    }
  } else {
    const out = await (deps.run ?? runAsync)('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    if (out.status !== 0) return false
    cwd = String(out.stdout ?? '').split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? null
  }
  if (!cwd) return false
  try {
    return (await realpath(cwd)) === want
  } catch {
    return cwd === want
  }
}

/** Signal the process group the lane leads (its tools with it), else the process alone. */
export function killProcessGroup(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    process.kill(-pid, signal)
    return
  } catch {}
  try {
    process.kill(pid, signal)
  } catch {}
}
