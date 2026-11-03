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
 * Elsewhere: `ps -o stat= -o lstart=`. A zombie counts as gone. Erasable
 * TypeScript only. No em or en dashes in this file.
 */

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

type Run = (command: string, args: string[], opts: Record<string, unknown>) => { status: number | null; stdout?: string | Buffer }

/** The process's start stamp while it is alive (not a zombie), else null. */
export function processStamp(
  pid: number,
  deps: { platform?: NodeJS.Platform; readFile?: (path: string) => string; run?: Run } = {},
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') return null
  if (platform === 'linux') {
    try {
      const stat = (deps.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(`/proc/${pid}/stat`)
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
    const run: Run = deps.run ?? (spawnSync as unknown as Run)
    const out = run('ps', ['-o', 'stat=', '-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 })
    const line = String(out.stdout ?? '').trim()
    if (out.status !== 0 || line === '') return null
    const [state, ...start] = line.split(/\s+/)
    if (!state || state.startsWith('Z') || start.length === 0) return null
    return start.join(' ')
  } catch {
    return null
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
