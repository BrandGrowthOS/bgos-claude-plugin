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
 *      (a daemon too old to write agent-state.json, or win32 where it could
 *      not)? The claude ABOVE the agent's live daemon (nearestClaudeAncestor:
 *      the daemon is claude's MCP child, on every platform), else the one whose
 *      working directory is the agent folder: lsof on darwin, /proc/<pid>/cwd
 *      on linux, compared by realpath (the kernel reports the physical path).
 *      A cwd lookup that FAILED is reported as failed, never as an empty
 *      answer: "no claude in the folder" would let the sweep restart over a
 *      live job (F1). win32 has no cheap cwd lookup: failed, i.e. unknown.
 *
 * The listing carries each process's START TIME too: the legacy pending rule
 * ("claude started before the installed version landed") needs it.
 *
 *   posix  ps -a -x -ww -o pid=,ppid=,uid=,lstart=,command=   (darwin: -e means
 *          "show the environment" there) / ps -e -ww -o pid=,ppid=,uid=,lstart=,args=
 *          (linux), under LC_ALL=C so lstart has English month names. The owner
 *          uid says which claude could be this user's agent at all: another
 *          user's claude has no cwd we may read, and is never ours.
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
 * @typedef {{ pid: number, ppid: number, uid: number | null, startedAtMs: number | null, command: string }} ProcessRow
 * @typedef {(file: string, args: readonly string[], opts?: { env?: Record<string, string | undefined>,
 *   timeoutMs?: number, cwd?: string }) => Promise<{ code: number | null, stdout: string, stderr: string }>} Exec
 */

export const PROCESS_LIST_TIMEOUT_MS = 30_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// -- posix ps ---------------------------------------------------------------------------

/** The ps invocation for a posix platform: one listing, start time included, unlimited width. */
export function psCommand(platform) {
  if (platform === 'darwin') return { file: 'ps', args: ['-a', '-x', '-ww', '-o', 'pid=,ppid=,uid=,lstart=,command='] }
  return { file: 'ps', args: ['-e', '-ww', '-o', 'pid=,ppid=,uid=,lstart=,args='] }
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

const PS_LINE_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3})\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s(.*))?$/

/**
 * Parse `ps pid=,ppid=,uid=,lstart=,command=` output. Null when ANY non-empty line
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
      uid: Number(m[3]),
      // m[4] is the weekday, which says nothing the date does not.
      startedAtMs: lstartMs(m[5], m[6], m[7], m[8]),
      command: String(m[9] ?? '').trim(),
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
    // No owner here: Win32_Process carries none without a GetOwner call per process.
    rows.push({ pid, ppid, uid: null, startedAtMs: win32Ms(item.CreationDate), command: typeof item.CommandLine === 'string' ? item.CommandLine : '' })
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
  // A win32 command line quotes the script path, so a closing quote may follow.
  return /[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.m?js["']?(?:\s|$)/.test(String(command))
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
 *
 * `ok: false` when the lookup itself FAILED: lsof timed out, could not run, or
 * answered nothing at all; every readlink failed; win32. The caller must read
 * that as UNKNOWN. An empty map used to stand for both "failed" and "every
 * claude is elsewhere", and the first was read as the second: the agent
 * "stopped", and the sweep reinstalled its supervisor over a live job (F1).
 * A pid missing from an ok answer is one that vanished or could not be read;
 * the caller decides which by liveness.
 * @param {{ platform: string, exec: Exec, pids: number[] }} params
 * @returns {Promise<{ ok: boolean, cwds: Map<number, string>, error?: string }>}
 */
export async function readProcessCwds({ platform, exec, pids }) {
  const list = (Array.isArray(pids) ? pids : []).filter((p) => Number.isInteger(p) && p > 0)
  if (platform === 'win32') return { ok: false, cwds: new Map(), error: 'no_cwd_lookup_on_win32' }
  if (list.length === 0) return { ok: true, cwds: new Map() }
  if (platform === 'darwin') {
    let res
    try {
      res = await exec('lsof', ['-a', '-d', 'cwd', '-p', list.join(','), '-Fn'], { timeoutMs: PROCESS_LIST_TIMEOUT_MS })
    } catch (err) {
      return { ok: false, cwds: new Map(), error: `lsof_failed:${String(err?.message ?? err)}` }
    }
    const cwds = parseLsofCwd(res?.stdout)
    if (res?.code == null) return { ok: false, cwds: new Map(), error: 'lsof_timed_out' }
    if (res.code !== 0 && cwds.size === 0) return { ok: false, cwds, error: `lsof_failed:${res.code}` }
    return { ok: true, cwds }
  }
  const cwds = new Map()
  for (const pid of list) {
    try {
      const res = await exec('readlink', [`/proc/${pid}/cwd`], { timeoutMs: PROCESS_LIST_TIMEOUT_MS })
      const cwd = String(res?.stdout ?? '').trim()
      if (res?.code === 0 && cwd) cwds.set(pid, cwd)
    } catch {
      // a vanished pid has no cwd
    }
  }
  if (cwds.size === 0) return { ok: false, cwds, error: 'readlink_failed' }
  return { ok: true, cwds }
}

function normDir(path) {
  return String(path ?? '').trim().replace(/[\\/]+$/, '')
}

/** The spellings a folder may be reported under: as given, and its realpath. */
function folderSpellings(cwd, realpath) {
  const out = new Set()
  const given = normDir(cwd)
  if (!given) return out
  out.add(given)
  if (typeof realpath === 'function') {
    try {
      const real = normDir(realpath(given))
      if (real) out.add(real)
    } catch {
      // a folder that cannot be resolved is compared as spelled
    }
  }
  return out
}

/**
 * The claude pids whose working directory is the agent folder. The kernel
 * reports the PHYSICAL path (symlinks resolved, the on-disk letter case);
 * the folder may be recorded through a symlink, so it is compared both as
 * spelled and by its realpath (F1).
 * @param {{ processes: ProcessRow[], cwds: Map<number, string>, cwd: string | null,
 *   realpath?: (path: string) => string }} params
 * @returns {number[]}
 */
export function findClaudePidsByCwd({ processes, cwds, cwd, realpath }) {
  const want = folderSpellings(cwd, realpath)
  if (want.size === 0) return []
  return claudeCandidates(processes)
    .filter((p) => cwds.has(p.pid) && want.has(normDir(cwds.get(p.pid))))
    .map((p) => p.pid)
}

/**
 * The nearest claude ABOVE a pid: the agent's daemon is claude's MCP child
 * (with a launcher such as bin/bgos-launch.mjs between them), so its claude is
 * found from the daemon's pid on every platform, win32 included, where neither
 * a cwd lookup nor (from an older daemon) a published claudePid exists (F2).
 * Null when none is listed above it; a ppid cycle (pid reuse) ends the walk.
 * @param {ProcessRow[]} processes
 * @param {number} pid
 * @returns {number | null}
 */
export function nearestClaudeAncestor(processes, pid) {
  const byPid = new Map((Array.isArray(processes) ? processes : []).map((p) => [p.pid, p]))
  const seen = new Set([pid])
  let current = byPid.get(pid)
  while (current) {
    const parent = byPid.get(current.ppid)
    if (!parent || seen.has(parent.pid)) return null
    if (isClaudeCommand(parent.command)) return parent.pid
    seen.add(parent.pid)
    current = parent
  }
  return null
}

// -- a systemd unit's cgroup (F5) ----------------------------------------------------------

/**
 * `systemctl --user show -p MainPID -p ControlGroup <unit>` (key=value lines)
 * as {mainPid, controlGroup}; an inactive unit has MainPID=0 and no group.
 * @param {string} text
 * @returns {{ mainPid: number | null, controlGroup: string | null }}
 */
export function parseSystemctlShow(text) {
  const out = { mainPid: null, controlGroup: null }
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key === 'MainPID' && /^\d+$/.test(value) && Number(value) > 0) out.mainPid = Number(value)
    // A cgroup path is absolute and never climbs: anything else is not read.
    if (key === 'ControlGroup' && value.startsWith('/') && !value.split('/').includes('..')) out.controlGroup = value
  }
  return out
}

/** cgroup.procs (one pid per line) as pids, or null when it is not one. */
export function parseCgroupProcs(text) {
  if (typeof text !== 'string') return null
  const pids = []
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim()
    if (!value) continue
    if (!/^\d+$/.test(value)) return null
    pids.push(Number(value))
  }
  return pids
}

/**
 * The members of a unit's cgroup that belong to NEITHER the supervisor nor the
 * agent's claude: what a `systemctl --user restart` kills along with them
 * (KillMode=control-group, the default both unit generations keep), and the
 * job scan under claude cannot see. A Bash tool's `nohup job &` is exactly
 * this once its shell has exited: reparented to systemd --user, out of
 * claude's tree, without the shell-snapshots marker, still in the cgroup (F5).
 * `roots` are the unit's main pid, the agent's claude and its ancestors in the
 * group, and the agent's own tmux server and run.sh: they and every process
 * under them are accounted for. A member no longer listed has exited.
 * @param {{ members: number[], processes: ProcessRow[], roots: number[] }} input
 * @returns {number[]}
 */
export function strayCgroupMembers({ members, processes, roots }) {
  const listed = new Set((Array.isArray(processes) ? processes : []).map((p) => p.pid))
  const accounted = new Set()
  for (const root of roots) {
    if (!Number.isInteger(root) || root <= 0) continue
    accounted.add(root)
    for (const p of descendantsOf(processes, root)) accounted.add(p.pid)
  }
  return (Array.isArray(members) ? members : []).filter((pid) => listed.has(pid) && !accounted.has(pid))
}
