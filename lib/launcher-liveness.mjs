/**
 * Is a hoai launcher still supervising a claude? (board row fabeef45, kc-server
 * agent 867, 2026-10-22: down two days, 5,393 restarts of its service.)
 *
 * The launcher named in supervisor.json was alive and was the process that
 * wrote the file, so every new launch read "already supervised" and stopped
 * with exit 3. Its claude was a zombie: the launcher's event loop had stopped,
 * so it never reaped that child, never relaunched it, never released the claim,
 * and the SIGTERM handler main() wires never ran (only SIGKILL ended it). A
 * live pid proves the launcher exists, not that it supervises anything. What
 * does is a live child: the claude it started (posix: through expect, the
 * expect is the child), and a zombie is not one.
 *
 * Two readers of that one fact:
 *   - readChildProcesses: the direct children of a pid, each with whether it
 *     is a zombie. bin/hoai-core.mjs decideSupervisorArming asks it about the
 *     holder of supervisor.json before it believes "already supervised".
 *   - the watchdog: a worker thread inside every armed launcher. Its own
 *     clock keeps running when the main thread's loop does not, so when that
 *     loop has not ticked for WATCHDOG_WEDGE_MS AND the launcher has no live
 *     child, on two looks in a row, it removes the claim (only while the
 *     claim still names this launcher) and ends the launcher with SIGKILL,
 *     the one signal a stopped loop cannot ignore. The service restarts it from there. A stopped loop
 *     over a LIVE claude is left alone: the agent is up, and ending its
 *     launcher would orphan it.
 *
 * Both clocks are monotonic (process.hrtime), so a wall clock step changes
 * nothing. Plain JavaScript, import safe, never throws.
 */

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'

/** How long the launcher's loop may go without a tick before the watchdog
 *  looks at its children. Far above any synchronous call the loop makes (the
 *  longest is a 10 s PowerShell timeout), and the keep-alive backoff is a
 *  timer, so the loop ticks right through it. */
export const WATCHDOG_WEDGE_MS = 60_000
/** How often the watchdog looks. */
export const WATCHDOG_CHECK_MS = 5_000
/** How long one child listing may take. */
export const CHILD_LIST_TIMEOUT_MS = 2_000
/** PowerShell's cold start is the slow one (mirror of PID_COMMAND_LINE_TIMEOUT_MS). */
export const WIN32_CHILD_LIST_TIMEOUT_MS = 10_000
/** A Windows process that hosts a console for its parent, not a child it started. */
const CONSOLE_HOSTS = new Set(['conhost.exe', 'openconsole.exe'])

/**
 * @typedef {{ pid: number, zombie: boolean, name: string, startedAtMs: number | null }} ChildProcessRow
 */

/**
 * One /proc/<pid>/stat line as {pid, ppid, state, name}, or null. The name is
 * between the first '(' and the LAST ')' (a name may hold either), and the
 * state and ppid are the two fields after it.
 * @param {string} text
 */
export function parseProcStat(text) {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const pid = Number(text.slice(0, open).trim())
  const [state, ppid] = text.slice(close + 2).split(' ')
  if (!Number.isInteger(pid) || !state || !Number.isInteger(Number(ppid))) return null
  return { pid, ppid: Number(ppid), state, name: text.slice(open + 1, close) }
}

/**
 * `ps -Ao pid=,ppid=,stat=,comm=` output as the children of `parentPid`, or
 * null when a line does not parse (a partial table proves nothing).
 * @param {string} stdout
 * @param {number} parentPid
 * @returns {ChildProcessRow[] | null}
 */
export function parsePsChildren(stdout, parentPid) {
  const out = []
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.trim()) continue
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) return null
    if (Number(m[2]) !== parentPid) continue
    out.push({ pid: Number(m[1]), zombie: m[3].startsWith('Z'), name: m[4].trim().split('/').at(-1) ?? '', startedAtMs: null })
  }
  return out
}

/**
 * Windows: Get-CimInstance's JSON (one object or an array) as children, minus
 * the console hosts. A process that has exited is not listed there.
 * @param {string} stdout
 * @returns {ChildProcessRow[] | null}
 */
export function parseWin32Children(stdout) {
  const text = String(stdout ?? '').trim()
  if (!text) return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const out = []
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!item || typeof item !== 'object' || !Number.isInteger(item.ProcessId)) return null
    const name = String(item.Name ?? '')
    if (CONSOLE_HOSTS.has(name.toLowerCase())) continue
    const started = typeof item.StartedAtMs === 'number' && Number.isFinite(item.StartedAtMs) ? item.StartedAtMs : null
    out.push({ pid: item.ProcessId, zombie: false, name, startedAtMs: started })
  }
  return out
}

/**
 * The direct children of `pid` on THIS host, or null when they cannot be read.
 *   linux   every /proc/<n>/stat whose ppid is `pid` (state Z is a zombie)
 *   darwin  one ps table, ps's own Z
 *   win32   one CIM query on ParentProcessId; a child that has exited is not
 *           listed, and the caller drops one older than its parent (Windows
 *           keeps a dead parent's pid in ParentProcessId, and reuses pids)
 * @param {{ platform?: string, pid: number, readFile?: (path: string) => string | null,
 *   listDir?: (path: string) => string[] | null, run?: typeof spawnSync }} opts
 * @returns {ChildProcessRow[] | null}
 */
export function readChildProcesses({ platform = process.platform, pid, readFile = readText, listDir = listNames, run = spawnSync }) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    if (platform === 'linux') {
      const names = listDir('/proc')
      if (!Array.isArray(names)) return null
      const out = []
      for (const name of names) {
        if (!/^\d+$/.test(name)) continue
        const row = parseProcStat(String(readFile(`/proc/${name}/stat`) ?? ''))
        // A process that ended between the listing and the read is simply not there.
        if (!row || row.ppid !== pid) continue
        out.push({ pid: row.pid, zombie: row.state === 'Z', name: row.name, startedAtMs: null })
      }
      return out
    }
    if (platform === 'win32') {
      const script =
        `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | ForEach-Object { ` +
        '[pscustomobject]@{ ProcessId = $_.ProcessId; Name = $_.Name; ' +
        'StartedAtMs = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }) } } | ConvertTo-Json -Compress'
      const res = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout: WIN32_CHILD_LIST_TIMEOUT_MS,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      if (res?.status !== 0) return null
      return withoutLister(parseWin32Children(res.stdout), res)
    }
    const res = run('ps', ['-Ao', 'pid=,ppid=,stat=,comm='], { encoding: 'utf8', timeout: CHILD_LIST_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })
    if (res?.status !== 0 || !res.stdout) return null
    return withoutLister(parsePsChildren(res.stdout, pid), res)
  } catch {
    return null
  }
}

/** The ps or PowerShell that made the listing is in it, and is a child of the
 *  process that ran it: a watchdog asking about its own launcher would count
 *  it as a live child every time (review 1). */
function withoutLister(children, res) {
  if (!Array.isArray(children)) return children
  return children.filter((child) => child.pid !== res?.pid)
}

/**
 * The watchdog's one decision. 'release' only when the loop has stopped
 * (no tick for wedgeMs) AND no child of the launcher is alive: a zombie or no
 * child at all. Children that cannot be read prove nothing.
 * @param {{ beatAgeMs: number, wedgeMs: number, children: Array<{ zombie: boolean }> | null }} input
 * @returns {'release' | 'none'}
 */
export function decideWatchdogAction({ beatAgeMs, wedgeMs, children }) {
  if (!(beatAgeMs >= wedgeMs)) return 'none'
  if (!Array.isArray(children)) return 'none'
  return children.some((child) => child && child.zombie !== true) ? 'none' : 'release'
}

/** Stale looks in a row, WATCHDOG_CHECK_MS apart, before the watchdog acts:
 *  after a VM resumes or a host wakes, the worker can look before the main
 *  thread has ticked once (review 1). */
export const WATCHDOG_STRIKES = 2

/**
 * One watchdog look, run every check interval: 'release' (and `release` is
 * called) only on the WATCHDOG_STRIKES-th look in a row that finds the loop
 * stopped and no live child; 'wait' on the looks before it; 'none' otherwise,
 * which starts the count over.
 * @param {{ wedgeMs: number, beatAgeMs: () => number, readChildren: () => Array<{ zombie: boolean }> | null,
 *   release: (beatAgeMs: number, children: Array<{ zombie: boolean }>) => void, strikes?: number }} input
 * @returns {() => 'release' | 'wait' | 'none'}
 */
export function createWatchdogCheck({ wedgeMs, beatAgeMs, readChildren, release, strikes = WATCHDOG_STRIKES }) {
  let seen = 0
  return () => {
    const age = beatAgeMs()
    const children = age >= wedgeMs ? readChildren() : null
    if (decideWatchdogAction({ beatAgeMs: age, wedgeMs, children }) !== 'release') {
      seen = 0
      return 'none'
    }
    seen += 1
    if (seen < strikes) return 'wait'
    release(age, children ?? [])
    return 'release'
  }
}

/**
 * Arm the watchdog for the launcher `pid` holding `claimPath`. Windows too: it
 * has no zombies, but a launcher whose loop stopped over a claude that exited
 * has no child in the CIM table, and nothing else ends it there (the agent
 * task ignores a new start while that instance runs, review 1).
 * `statusPath` is where the reason goes (launch-status beside the claim by
 * default; null writes none). The worker and the beat timer never keep the
 * process alive. Null when there is nothing to arm.
 * @param {{ claimPath: string, pid: number, platform?: string, statusPath?: string | null,
 *   wedgeMs?: number, checkMs?: number }} opts
 * @returns {{ stop: () => void } | null}
 */
export function startLauncherWatchdog({ claimPath, pid, platform = process.platform, statusPath, wedgeMs = WATCHDOG_WEDGE_MS, checkMs = WATCHDOG_CHECK_MS }) {
  if (!claimPath || !Number.isInteger(pid)) return null
  try {
    const beat = new SharedArrayBuffer(8)
    const beats = new BigInt64Array(beat)
    const tick = () => Atomics.store(beats, 0, process.hrtime.bigint())
    tick()
    const timer = setInterval(tick, Math.max(50, Math.min(1_000, Math.floor(wedgeMs / 4))))
    timer.unref?.()
    const worker = new Worker(new URL('./launcher-watchdog-worker.mjs', import.meta.url), {
      workerData: {
        beat,
        claimPath,
        statusPath: statusPath === undefined ? join(dirname(claimPath), 'launch-status') : statusPath,
        pid,
        platform,
        wedgeMs,
        checkMs,
      },
      stdout: false,
      stderr: false,
    })
    worker.unref()
    worker.on('error', () => {})
    return {
      stop() {
        clearInterval(timer)
        worker.terminate().catch(() => {})
      },
    }
  } catch {
    return null
  }
}

/**
 * The watchdog's act, run inside the worker: the claim goes only while it
 * still names this launcher (a claim another launcher took over is not ours
 * to remove), the reason goes to launch-status, and then SIGKILL.
 * @param {{ claimPath: string, statusPath: string | null, pid: number, beatAgeMs: number,
 *   children: ChildProcessRow[], kill?: (pid: number, signal: string) => void, now?: Date }} input
 */
export function releaseWedgedLauncher({ claimPath, statusPath, pid, beatAgeMs, children, kill = (p, s) => process.kill(p, s), now = new Date() }) {
  try {
    const claim = JSON.parse(readFileSync(claimPath, 'utf8'))
    if (claim && claim.pid === pid) unlinkSync(claimPath)
  } catch {
    // No claim, or not ours: nothing to release.
  }
  if (statusPath) {
    const zombies = children.filter((child) => child.zombie).map((child) => child.pid)
    const line =
      `${statusStamp(now)} outcome=launcher-wedged pid=${pid} stalled=${Math.round(beatAgeMs / 1000)}s` +
      (zombies.length > 0 ? ` zombie=${zombies.join(',')}` : ' child=none')
    try {
      writeFileSync(statusPath, `${line}\n`)
    } catch {
      // Best effort: the release matters more than its note.
    }
  }
  kill(pid, 'SIGKILL')
}

/** Mirror of bin/hoai-core.mjs launchStatusStamp: local time, seconds. */
function statusStamp(at) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function listNames(path) {
  try {
    return readdirSync(path)
  } catch {
    return null
  }
}
