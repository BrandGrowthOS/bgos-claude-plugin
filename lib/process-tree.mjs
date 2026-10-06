/**
 * process-tree: the process table the keep-alive sweep reads (design 6,
 * finding 9, G10).
 *
 * Two questions, both about an agent's `claude` process:
 *   1. Is a BACKGROUND JOB running under it? Claude Code runs every Bash and
 *      Monitor tool command as a child of claude whose command line carries
 *      `shell-snapshots/snapshot-` (lib/keepalive-plan.mjs isBackgroundJobCommand),
 *      and a backgrounded one outlives the turn. Guru's live monitor was one:
 *      restarting the agent blindly would have killed it. So the sweep lists
 *      the whole table once and walks the descendants of claude.
 *   2. Which claude IS the agent's, when the daemon published no claudePid
 *      (a daemon too old to write agent-state.json)? The one whose working
 *      directory is the agent folder: lsof on darwin, /proc/<pid>/cwd on
 *      linux; on win32 there is no cheap equivalent, so the answer is none and
 *      the sweep stays on the strict side.
 *
 * The listing carries each process's START TIME too: the legacy pending rule
 * ("claude started before the installed version landed") needs it.
 *
 *   posix  ps -a -x -ww -o pid=,ppid=,lstart=,command=   (darwin: -e means
 *          "show the environment" there) / ps -e -ww -o pid=,ppid=,lstart=,args=
 *          (linux), under LC_ALL=C so lstart has English month names
 *   win32  PowerShell Get-CimInstance Win32_Process as compressed JSON
 *          (ProcessId, ParentProcessId, CreationDate as epoch ms, CommandLine)
 *
 * FAIL CLOSED: a listing with any line that does not parse is unreadable as a
 * whole, never partial. A skipped line could be the very job the safe moment
 * must see, and the sweep reads "unreadable" as process_tree_unreadable, which
 * waits instead of restarting.
 *
 * Every OS call goes through an injected exec (lib/watcher-bundle.mjs Exec).
 * Plain JavaScript, node >= 18, import-safe.
 */

/**
 * @typedef {{ pid: number, ppid: number, startedAtMs: number | null, command: string }} ProcessRow
 * @typedef {(file: string, args: readonly string[], opts?: { env?: Record<string, string | undefined>,
 *   timeoutMs?: number, cwd?: string }) => Promise<{ code: number | null, stdout: string, stderr: string }>} Exec
 */

export const PROCESS_LIST_TIMEOUT_MS = 30_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// -- posix ps ---------------------------------------------------------------------------

/** The ps invocation for a posix platform: one listing, start time included, unlimited width. */
export function psCommand(platform) {
  if (platform === 'darwin') return { file: 'ps', args: ['-a', '-x', '-ww', '-o', 'pid=,ppid=,lstart=,command='] }
  return { file: 'ps', args: ['-e', '-ww', '-o', 'pid=,ppid=,lstart=,args='] }
}

/** lstart's five tokens ("Tue Oct  6 18:00:00 2026") as LOCAL epoch ms, or null. */
function lstartMs(month, day, time, year) {
  const mon = MONTHS.indexOf(month)
  const d = Number(day)
  const y = Number(year)
  const t = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(time)
  if (mon < 0 || !Number.isInteger(d) || d < 1 || d > 31 || !Number.isInteger(y) || !t) return null
  const [h, m, s] = [Number(t[1]), Number(t[2]), Number(t[3])]
  if (h > 23 || m > 59 || s > 60) return null
  const ms = new Date(y, mon, d, h, m, s).getTime()
  return Number.isFinite(ms) ? ms : null
}

const PS_LINE_RE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s(.*))?$/

/**
 * Parse `ps pid=,ppid=,lstart=,command=` output. Null when ANY non-empty line
 * fails to parse, or when there is no process at all (a real table is never
 * empty). An unparseable start time keeps the row with startedAtMs null.
 * @param {string} text
 * @returns {ProcessRow[] | null}
 */
export function parsePsOutput(text) {
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const m = PS_LINE_RE.exec(line)
    if (!m) return null
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      // m[3] is the weekday, which says nothing the date does not.
      startedAtMs: lstartMs(m[4], m[5], m[6], m[7]),
      command: String(m[8] ?? '').trim(),
    })
  }
  return rows.length > 0 ? rows : null
}

// -- win32 ------------------------------------------------------------------------------

/** CreationDate is converted to epoch ms inside PowerShell, so the JSON never
 *  carries Windows PowerShell 5.1's "/Date(...)/" or a locale formatted date. */
export const WIN32_PROCESS_SCRIPT = [
  'Get-CimInstance Win32_Process | ForEach-Object {',
  '[pscustomobject]@{',
  'ProcessId = $_.ProcessId;',
  'ParentProcessId = $_.ParentProcessId;',
  'CreationDate = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null });',
  'CommandLine = $_.CommandLine',
  '} } | ConvertTo-Json -Compress',
].join(' ')

export function win32ProcessCommand() {
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', WIN32_PROCESS_SCRIPT] }
}

function win32Ms(value) {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const legacy = /^\/Date\((-?\d+)\)\/$/.exec(value)
  if (legacy) return Number(legacy[1])
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Parse the PowerShell JSON (an array, or a lone object for one process).
 * Null when it is not JSON, is empty, or any entry lacks integer ids.
 * @param {string} text
 * @returns {ProcessRow[] | null}
 */
export function parseWin32ProcessJson(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text ?? ''))
  } catch {
    return null
  }
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : []
  if (list.length === 0) return null
  const rows = []
  for (const item of list) {
    if (!item || typeof item !== 'object') return null
    const pid = item.ProcessId
    const ppid = item.ParentProcessId
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return null
    rows.push({ pid, ppid, startedAtMs: win32Ms(item.CreationDate), command: typeof item.CommandLine === 'string' ? item.CommandLine : '' })
  }
  return rows
}

// -- listing ----------------------------------------------------------------------------

/**
 * List every process on this machine through the injected exec.
 * @param {{ platform: string, exec: Exec, env?: Record<string, string | undefined> }} params
 * @returns {Promise<{ ok: true, processes: ProcessRow[] } | { ok: false, error: string }>}
 */
export async function listProcesses({ platform, exec, env = {} }) {
  const win = platform === 'win32'
  const cmd = win ? win32ProcessCommand() : psCommand(platform)
  // LC_ALL=C: lstart prints localized month names under another locale, and a
  // listing this module cannot parse is a listing the sweep must not act on.
  const runEnv = win ? { ...env } : { ...env, LC_ALL: 'C', LANG: 'C' }
  let res
  try {
    res = await exec(cmd.file, cmd.args, { env: runEnv, timeoutMs: PROCESS_LIST_TIMEOUT_MS })
  } catch (err) {
    return { ok: false, error: `${cmd.file}_failed:${String(err?.message ?? err)}` }
  }
  const tool = win ? 'powershell' : 'ps'
  if (!res || res.code !== 0) return { ok: false, error: `${tool}_failed:${res?.code ?? 'null'}` }
  const rows = win ? parseWin32ProcessJson(res.stdout) : parsePsOutput(res.stdout)
  if (!rows) return { ok: false, error: `${tool}_unparseable` }
  return { ok: true, processes: rows }
}

/**
 * Every process below `rootPid` (children, their children, ...), never the
 * root itself. A visited set makes a ppid cycle (pid reuse) terminate.
 * @param {ProcessRow[]} processes
 * @param {number} rootPid
 * @returns {ProcessRow[]}
 */
export function descendantsOf(processes, rootPid) {
  const byParent = new Map()
  for (const p of Array.isArray(processes) ? processes : []) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, [])
    byParent.get(p.ppid).push(p)
  }
  const out = []
  const seen = new Set([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift()
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      out.push(child)
      queue.push(child.pid)
    }
  }
  return out
}

// -- which claude is the agent's ----------------------------------------------------------

/** The first argv token of a command line, unquoted (win32 quotes a path with spaces). */
function argv0(command) {
  const text = String(command ?? '').trim()
  if (!text) return ''
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1)
    return end > 0 ? text.slice(1, end) : text.slice(1)
  }
  return text.split(/\s+/)[0]
}

/**
 * Is this command line a claude session? The native binary by basename
 * (`claude`, `claude.exe`), or the node-hosted npm install's cli.js. A process
 * that merely mentions claude (a tail of a log, an editor) is not one.
 * @param {string | null | undefined} command
 */
export function isClaudeCommand(command) {
  const first = argv0(command)
  if (!first) return false
  const base = first.slice(Math.max(first.lastIndexOf('/'), first.lastIndexOf('\\')) + 1).toLowerCase()
  if (base === 'claude' || base === 'claude.exe') return true
  return /[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.m?js(?:\s|$)/.test(String(command))
}

/** The claude processes in a listing. */
export function claudeCandidates(processes) {
  return (Array.isArray(processes) ? processes : []).filter((p) => isClaudeCommand(p.command))
}

/** `lsof -Fn` output (p<pid>, f<fd>, n<name> lines) into pid -> cwd. */
export function parseLsofCwd(text) {
  const map = new Map()
  let pid = null
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1))
      pid = Number.isInteger(n) && n > 0 ? n : null
    } else if (line.startsWith('n') && pid !== null && !map.has(pid)) {
      map.set(pid, line.slice(1))
    }
  }
  return map
}

/**
 * The working directory of each pid. darwin: one lsof for all of them (it
 * exits 1 when one pid has gone, yet prints the rest, so the output is read
 * whatever the code). linux: readlink /proc/<pid>/cwd per pid. win32: none.
 * @param {{ platform: string, exec: Exec, pids: number[] }} params
 * @returns {Promise<Map<number, string>>}
 */
export async function readProcessCwds({ platform, exec, pids }) {
  const list = (Array.isArray(pids) ? pids : []).filter((p) => Number.isInteger(p) && p > 0)
  if (list.length === 0 || platform === 'win32') return new Map()
  if (platform === 'darwin') {
    try {
      const res = await exec('lsof', ['-a', '-d', 'cwd', '-p', list.join(','), '-Fn'], { timeoutMs: PROCESS_LIST_TIMEOUT_MS })
      return parseLsofCwd(res?.stdout)
    } catch {
      return new Map()
    }
  }
  const map = new Map()
  for (const pid of list) {
    try {
      const res = await exec('readlink', [`/proc/${pid}/cwd`], { timeoutMs: PROCESS_LIST_TIMEOUT_MS })
      const cwd = String(res?.stdout ?? '').trim()
      if (res?.code === 0 && cwd) map.set(pid, cwd)
    } catch {
      // a vanished pid has no cwd
    }
  }
  return map
}

function normDir(path) {
  return String(path ?? '').trim().replace(/[\\/]+$/, '')
}

/**
 * The claude pids whose working directory is the agent folder.
 * @param {{ processes: ProcessRow[], cwds: Map<number, string>, cwd: string | null }} params
 * @returns {number[]}
 */
export function findClaudePidsByCwd({ processes, cwds, cwd }) {
  const want = normDir(cwd)
  if (!want) return []
  return claudeCandidates(processes)
    .filter((p) => normDir(cwds.get(p.pid)) === want)
    .map((p) => p.pid)
}
