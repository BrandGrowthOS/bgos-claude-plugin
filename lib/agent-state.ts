/**
 * The daemon's published state: ~/.bgos-plugin-state/<id>/agent-state.json,
 * the contract between this daemon and the per-machine watcher (design
 * section 7).
 *
 * WHY (finding 9 and gap G10, 2026-10-06). The watcher's keep-alive sweep
 * restarts an agent onto a staged update, or onto an upgraded supervisor, but
 * only at a SAFE moment (design section 6), and the watcher is a different
 * process: it cannot see a turn in flight, a reply the agent still owes, an
 * open permission card or a delivery that is running. Only this daemon can.
 * Before this file nothing outside the daemon could tell a busy agent from an
 * idle one, so the only safe restart was one a human chose. The watcher also
 * needs the RUNNING version (an installed version is not a running version)
 * and the claude pid it would be restarting, and both are facts only the
 * daemon has first hand.
 *
 * The rules, each with its reason:
 *   - Exactly the section 7 fields, schemaVersion 1. The watcher parses this
 *     file; a field it does not know is noise and a missing one is a guess.
 *   - Atomic (temp file then rename): the watcher reads at any moment, and a
 *     torn read must never parse as "idle".
 *   - Written on every change of a published field and at least every 30 s,
 *     so `updatedAt` is a liveness signal: the watcher only trusts a file
 *     written in the last 120 s by a live pid.
 *   - Written by the pairing LOCK HOLDER only. Several daemons can resolve one
 *     assistant on a shared host (lib/pairing-lock.ts); a passive one (a
 *     subagent's, a `claude -p`'s) would publish its own idle state over the
 *     live agent's busy one and invite a restart mid turn.
 *   - Removed on a clean shutdown, and only when the file is still ours (a
 *     rival may have become the holder and written its own).
 *   - Never throws: publishing is telemetry, and a full disk must not take a
 *     live agent down.
 *
 * `turnInFlight` is the hook turn state (set at UserPromptSubmit, cleared at
 * Stop); server.ts also counts a turn whose child agent is still working
 * after its parent's Stop, because restarting then kills that child mid job
 * (finding 9). `lastActivityAt` is the newest of the activity times the
 * daemon knows AND the moment it was last seen going busy or going idle, so
 * the watcher's quiet window starts when the work ended, not when it began.
 *
 * `turnSignal` (code review F1, 2026-10-07) says whether `turnInFlight` means
 * anything: 'hooks' once this daemon consumed a hook event of its own session
 * in this process, else 'none'. A clone agent whose folder registers no BGOS
 * hooks (the whole fleet on KC's Mac when it was reviewed) never sees one, so
 * its turnInFlight is false for good, and the watcher must not read that as
 * idle. The one field added to section 7, at schemaVersion 1: the watcher's
 * parser ignores a field it does not know, and the meaning of every other
 * field is unchanged. For the same agents `lastActivityAt` also counts the
 * transcript it is writing (readSessionTranscript), and `sessionId` falls
 * back to the transcript the binding chain proved, so the watcher can stat
 * the transcript and the spool itself.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { isSessionIdLike } from '../bin/hoai-core.mjs'
import { type BindingSource, POSITIVE_BINDING_SOURCES } from './session-binding.js'
import {
  isKeepaliveSessionProcess,
  readProcessAncestry,
  readProcessComm,
  type SyncExecResult,
  validAssistantId,
} from './update-readiness.js'

export const AGENT_STATE_FILE_NAME = 'agent-state.json'
export const AGENT_STATE_SCHEMA_VERSION = 1
/** The longest the file may go unwritten while this daemon holds the lock. */
export const AGENT_STATE_MAX_INTERVAL_MS = 30_000

/** The file, field for field and in this order (design section 7). */
export interface AgentState {
  schemaVersion: 1
  assistantId: string
  pid: number
  claudePid: number | null
  runningVersion: string | null
  pendingRestartVersion: string | null
  turnInFlight: boolean
  turnSignal: TurnSignal
  pendingMessages: number
  pendingPermissions: number
  activeOperations: number
  lastActivityAt: string | null
  sessionId: string | null
  updatedAt: string
}

/** Where turnInFlight comes from: the hook rail, or nothing at all. */
export type TurnSignal = 'hooks' | 'none'

/** What the daemon reads off its live state for one publish. */
export interface AgentStateSnapshot {
  assistantId: string | number | null | undefined
  claudePid: number | null
  runningVersion: string | null | undefined
  pendingRestartVersion: string | null | undefined
  turnInFlight: boolean
  turnSignal: TurnSignal
  pendingMessages: number
  pendingPermissions: number
  activeOperations: number
  /** Every activity time the daemon knows (epoch ms; null when never). */
  activityAtMs: Array<number | null | undefined>
  sessionId: string | null | undefined
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isoOrNull(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  try {
    return new Date(ms).toISOString()
  } catch {
    return null
  }
}

/**
 * The file body, or null when there is no digits-only assistant id to key it
 * by (the watcher addresses agents by id; a cwd-hash state dir has none).
 */
export function buildAgentState(
  input: Omit<AgentStateSnapshot, 'activityAtMs'> & {
    pid: number
    lastActivityAtMs: number | null
    nowMs: number
  },
): AgentState | null {
  const assistantId = validAssistantId(input.assistantId)
  if (!assistantId) return null
  const claudePid =
    typeof input.claudePid === 'number' && Number.isInteger(input.claudePid) && input.claudePid > 1
      ? input.claudePid
      : null
  const session = text(input.sessionId)
  return {
    schemaVersion: AGENT_STATE_SCHEMA_VERSION,
    assistantId,
    pid: input.pid,
    claudePid,
    runningVersion: text(input.runningVersion),
    pendingRestartVersion: text(input.pendingRestartVersion),
    turnInFlight: input.turnInFlight === true,
    // Fail closed toward 'none': a turn signal the daemon cannot vouch for is
    // the reading under which turnInFlight proves nothing.
    turnSignal: input.turnSignal === 'hooks' ? 'hooks' : 'none',
    pendingMessages: count(input.pendingMessages),
    pendingPermissions: count(input.pendingPermissions),
    activeOperations: count(input.activeOperations),
    lastActivityAt: isoOrNull(input.lastActivityAtMs),
    sessionId: session && isSessionIdLike(session) ? session : null,
    updatedAt: isoOrNull(input.nowMs) ?? new Date(0).toISOString(),
  }
}

/** Everything but `updatedAt`: two states with the same signature are the
 *  same news, and only the 30 s refresh may rewrite it. */
export function agentStateSignature(state: AgentState): string {
  const { updatedAt: _updatedAt, ...rest } = state
  return JSON.stringify(rest)
}

/**
 * The claude process this daemon serves: the NEAREST ancestor whose name is
 * claude (lib/update-readiness.ts isKeepaliveSessionProcess, the same name
 * rule the keepalive tier measured). `ancestry` is self first
 * (readProcessAncestry), and self is never the answer. Null when none is
 * found or the reading fails: the watcher then finds the agent's claude by its
 * working directory instead (design section 6).
 */
export function nearestClaudeAncestor(
  ancestry: number[],
  commOf: (pid: number) => string | null,
): number | null {
  try {
    if (!Array.isArray(ancestry)) return null
    for (const pid of ancestry.slice(1)) {
      if (!Number.isInteger(pid) || pid <= 1) continue
      if (isKeepaliveSessionProcess(commOf(pid))) return pid
    }
  } catch {
    return null
  }
  return null
}

// ── The claude pid on Windows (code review F2) ──────────────────────────────
//
// readProcessAncestry and readProcessComm spawn `ps`, which Windows does not
// have, and the posix name rule wants exactly 'claude' after the last '/'. So
// a Windows daemon published claudePid null forever; with no keepalive marker
// and no cwd lookup on win32 the watcher then had no way to read the agent's
// process tree, and every staged update waited in process_tree_unreadable.

/**
 * One PowerShell call that follows ParentProcessId up from `ownPid`, one
 * filtered Get-CimInstance per link (a whole-table listing is far more output
 * than a chain of a few processes). Bounded at 64 links and stopped at a
 * process that is its own parent. No double quote anywhere in the script:
 * Node escapes one as \" on the Windows command line, and a -Command must not
 * depend on how that is read back. CreationDate is converted to epoch ms
 * inside PowerShell, as lib/process-tree.mjs does, so the JSON never carries
 * a locale formatted date. Null for a pid that is not a positive integer (it
 * is the one value interpolated).
 */
export function win32AncestryCommand(ownPid: number): { file: string; args: string[] } | null {
  if (!Number.isInteger(ownPid) || ownPid <= 0) return null
  const script = [
    `$p = ${ownPid};`,
    '$out = @();',
    'for ($i = 0; $i -lt 64 -and $p -gt 0; $i++) {',
    "$x = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p);",
    'if (-not $x) { break };',
    '$out += [pscustomobject]@{',
    'ProcessId = $x.ProcessId;',
    'ParentProcessId = $x.ParentProcessId;',
    'Name = $x.Name;',
    'CreationDate = $(if ($x.CreationDate) { ([DateTimeOffset]$x.CreationDate).ToUnixTimeMilliseconds() } else { $null });',
    'CommandLine = $x.CommandLine',
    '};',
    'if ($x.ParentProcessId -eq $p) { break };',
    '$p = $x.ParentProcessId',
    '};',
    'ConvertTo-Json -Compress -InputObject $out',
  ].join(' ')
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] }
}

interface Win32ProcessLink {
  pid: number
  ppid: number
  name: string
  command: string | null
  createdAtMs: number | null
}

function parseWin32Ancestry(stdout: string): Win32ProcessLink[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(stdout ?? ''))
  } catch {
    return null
  }
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : []
  const out: Win32ProcessLink[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') return null
    const row = item as Record<string, unknown>
    if (!Number.isInteger(row.ProcessId) || !Number.isInteger(row.ParentProcessId)) return null
    out.push({
      pid: row.ProcessId as number,
      ppid: row.ParentProcessId as number,
      name: typeof row.Name === 'string' ? row.Name : '',
      command: typeof row.CommandLine === 'string' ? row.CommandLine : null,
      createdAtMs: typeof row.CreationDate === 'number' && Number.isFinite(row.CreationDate) ? row.CreationDate : null,
    })
  }
  return out
}

/** Claude Code's npm entry point on a command line, quoted or not. */
const CLAUDE_CODE_CLI_RE = /[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.m?js(?=["'\s]|$)/i

/**
 * Is this Windows process a claude session? The native binary by its image
 * name (claude.exe, or claude), or a node running Claude Code's cli.js, which
 * is what the npm install's claude.cmd shim starts (the path is quoted there,
 * so the match allows a closing quote). Anything that merely mentions claude
 * is not one.
 */
export function isWin32ClaudeProcess(proc: { name: string | null | undefined; command: string | null | undefined }): boolean {
  const name = String(proc.name ?? '').trim().toLowerCase()
  if (name === 'claude.exe' || name === 'claude') return true
  if (name !== 'node.exe' && name !== 'node') return false
  return CLAUDE_CODE_CLI_RE.test(String(proc.command ?? ''))
}

/**
 * The claude this daemon serves on Windows: the NEAREST ancestor that
 * isWin32ClaudeProcess accepts, self excluded, or null. Windows reuses pids,
 * so a "parent" created after its child is a stranger that inherited a dead
 * parent's pid, and the walk stops there rather than adopt it. Never throws.
 */
export function nearestClaudeAncestorWin32(
  ownPid: number,
  execSync: (file: string, args: string[]) => SyncExecResult,
): number | null {
  try {
    const cmd = win32AncestryCommand(ownPid)
    if (!cmd) return null
    const result = execSync(cmd.file, cmd.args)
    if (result.code !== 0) return null
    const links = parseWin32Ancestry(result.stdout)
    if (!links) return null
    const byPid = new Map(links.map((link) => [link.pid, link]))
    const seen = new Set<number>()
    let child = byPid.get(ownPid)
    while (child && !seen.has(child.pid)) {
      seen.add(child.pid)
      const parent = byPid.get(child.ppid)
      if (!parent || parent.pid <= 0 || parent.pid === child.pid) return null
      if (parent.createdAtMs !== null && child.createdAtMs !== null && parent.createdAtMs > child.createdAtMs) return null
      if (isWin32ClaudeProcess(parent)) return parent.pid
      child = parent
    }
    return null
  } catch {
    return null
  }
}

/** The claude ancestor on this platform: PowerShell on win32, ps elsewhere. */
export function findClaudeAncestor(input: {
  platform: string
  ownPid: number
  execSync: (file: string, args: string[]) => SyncExecResult
}): number | null {
  if (input.platform === 'win32') return nearestClaudeAncestorWin32(input.ownPid, input.execSync)
  return nearestClaudeAncestor(readProcessAncestry(input.ownPid, input.execSync), (pid) =>
    readProcessComm(pid, input.execSync),
  )
}

/** The two reads readSessionTranscript makes, injectable. */
export interface TranscriptActivityFs {
  mtimeMs: (path: string) => number | null
  listDir: (dir: string) => string[]
}

const nodeTranscriptActivityFs: TranscriptActivityFs = {
  mtimeMs: (path) => {
    try {
      return statSync(path).mtimeMs
    } catch {
      return null
    }
  },
  listDir: (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  },
}

/** What the transcripts say about this agent (code review F1). */
export interface SessionTranscriptReading {
  /** The newest write to this session's transcript files, or null. */
  activityMs: number | null
  /** The session the binding chain PROVED, or null. */
  sessionId: string | null
}

/**
 * Read the activity and the session off the transcripts, for an agent whose
 * hook rail may be silent (F1). `resolve` is the session binder's answer
 * (lib/session-binding.ts resolve()) with ANY binding source, because a wrong
 * guess here only makes the agent look busier, which is the safe direction for
 * a restart. The session id is published only from a POSITIVE binding: it
 * names a transcript and a spool the watcher stats, and the pin rules key on
 * it. The activity is the newest of:
 *   - the transcript itself;
 *   - its subagents' files, which Claude Code 2.1 writes beside it at
 *     <project dir>/<session id>/subagents/[<subdir>/]agent-<id>.jsonl, so a
 *     long Task subagent moves no byte of the main transcript;
 *   - while the binder cannot tell which transcript is ours (two live ones and
 *     no proof yet), every transcript in the project dir: someone in this
 *     agent's folder is writing, and it may be the agent.
 * Never throws; a missing file or dir is simply no reading.
 */
export function readSessionTranscript(input: {
  /** The binder's answer, asked inside this function so a throw from it
   *  costs the reading, never the publish. */
  resolve: () => { path: string; binding: { source: BindingSource } } | null
  projectDir: string
  fs?: TranscriptActivityFs
}): SessionTranscriptReading {
  const fs = input.fs ?? nodeTranscriptActivityFs
  try {
    const times: number[] = []
    const note = (ms: number | null) => {
      if (typeof ms === 'number' && Number.isFinite(ms)) times.push(ms)
    }
    const jsonl = (dir: string) => fs.listDir(dir).filter((name) => name.endsWith('.jsonl'))
    const resolved = input.resolve()
    let sessionId: string | null = null
    if (resolved && resolved.path) {
      note(fs.mtimeMs(resolved.path))
      const id = basename(resolved.path).replace(/\.jsonl$/, '')
      const subagents = join(dirname(resolved.path), id, 'subagents')
      for (const name of fs.listDir(subagents)) {
        if (name.endsWith('.jsonl')) {
          note(fs.mtimeMs(join(subagents, name)))
          continue
        }
        for (const nested of jsonl(join(subagents, name))) note(fs.mtimeMs(join(subagents, name, nested)))
      }
      if (POSITIVE_BINDING_SOURCES.includes(resolved.binding.source) && isSessionIdLike(id)) sessionId = id
    } else if (input.projectDir) {
      for (const name of jsonl(input.projectDir)) note(fs.mtimeMs(join(input.projectDir, name)))
    }
    return { activityMs: times.length > 0 ? Math.max(...times) : null, sessionId }
  } catch {
    return { activityMs: null, sessionId: null }
  }
}

/** The filesystem calls the writer makes, injectable so a test can prove the
 *  order (temp file first, rename last) rather than only the end result. */
export interface AgentStateFs {
  mkdir: (dir: string) => void
  writeFile: (path: string, body: string) => void
  rename: (from: string, to: string) => void
  unlink: (path: string) => void
}

const nodeAgentStateFs: AgentStateFs = {
  mkdir: (dir) => {
    mkdirSync(dir, { recursive: true })
  },
  writeFile: (path, body) => writeFileSync(path, body, { mode: 0o600 }),
  rename: (from, to) => renameSync(from, to),
  unlink: (path) => unlinkSync(path),
}

/** Write `body` through `<path>.<pid>.tmp` and a rename, creating the
 *  directory, so a reader sees the old file or the new one and never half of
 *  either. False on any failure (the temp file is cleaned up); never throws.
 *  Shared with the session pin (lib/session-pin.ts). */
export function writeTextAtomic(path: string, body: string, fs: AgentStateFs = nodeAgentStateFs): boolean {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    fs.mkdir(dirname(path))
    fs.writeFile(tmp, body)
    fs.rename(tmp, path)
    return true
  } catch {
    try {
      fs.unlink(tmp)
    } catch {
      /* never created, or already gone */
    }
    return false
  }
}

/** The agent-state.json body, written atomically (writeTextAtomic). */
export function writeAgentStateAtomic(
  path: string,
  state: AgentState,
  fs: AgentStateFs = nodeAgentStateFs,
): boolean {
  return writeTextAtomic(path, `${JSON.stringify(state, null, 2)}\n`, fs)
}

/** Remove the file when it names `pid`; a file another daemon wrote is left
 *  for that daemon. True only when something was removed. Never throws. */
export function removeAgentStateIfOurs(path: string, pid: number): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown } | null
    if (!parsed || parsed.pid !== pid) return false
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

/** A value recomputed at most once per `ttlMs` (a file read the 1 s publish
 *  tick must not repeat every second). */
export function memoizeFor<T>(ttlMs: number, now: () => number, compute: () => T): () => T {
  let at = Number.NEGATIVE_INFINITY
  let value: T
  return () => {
    const t = now()
    if (t - at >= ttlMs) {
      value = compute()
      at = t
    }
    return value
  }
}

/**
 * A reading kept FOREVER once it answers, and retried at most once per
 * `retryMs` while it does not. For the claude ancestor: it cannot change under
 * a live daemon (when that claude dies our stdin closes and we exit), the
 * ancestry walk is a chain of synchronous `ps` spawns (one PowerShell call
 * on Windows), and a host where it cannot answer (a claude under another
 * process name) must not pay for it every second.
 */
export function memoizeUntilFound<T>(
  retryMs: number,
  now: () => number,
  compute: () => T | null,
): () => T | null {
  let found: T | null = null
  let triedAt = Number.NEGATIVE_INFINITY
  return () => {
    if (found !== null) return found
    const t = now()
    if (t - triedAt < retryMs) return null
    triedAt = t
    try {
      found = compute()
    } catch {
      found = null
    }
    return found
  }
}

export type AgentStateTick = 'written' | 'unchanged' | 'skipped' | 'failed'

/**
 * The publish loop's state machine. The caller ticks it often (server.ts:
 * every second, plus a poke on every hook event); it writes only when the
 * published fields changed or the 30 s refresh is due, so a tick costs one
 * small object and a string compare.
 */
export class AgentStatePublisher {
  private readonly deps: {
    path: string
    pid: number
    now: () => number
    snapshot: () => AgentStateSnapshot
    shouldPublish: () => boolean
    write?: (path: string, state: AgentState) => boolean
    maxIntervalMs?: number
  }
  private lastSignature: string | null = null
  private lastWriteAt = Number.NEGATIVE_INFINITY
  private lastBusyAt: number | null = null
  private wasBusy = false
  private stopped = false

  constructor(deps: AgentStatePublisher['deps']) {
    this.deps = deps
  }

  tick(): AgentStateTick {
    if (this.stopped) return 'skipped'
    try {
      if (!this.deps.shouldPublish()) {
        // Lost (or never had) the lock: the holder publishes. Forget what we
        // wrote, so regaining the lock publishes at once.
        this.lastSignature = null
        return 'skipped'
      }
      const now = this.deps.now()
      const snap = this.deps.snapshot()
      const busy =
        snap.turnInFlight === true ||
        count(snap.pendingMessages) > 0 ||
        count(snap.pendingPermissions) > 0 ||
        count(snap.activeOperations) > 0
      // Stamp the EDGES of busy, not every busy tick: the start and the end
      // are the news (while busy the counts themselves keep the watcher off),
      // and a stamp that moved every second would rewrite the file every
      // second for the whole length of a turn.
      if (busy !== this.wasBusy) this.lastBusyAt = now
      this.wasBusy = busy
      const times = [...(Array.isArray(snap.activityAtMs) ? snap.activityAtMs : []), this.lastBusyAt].filter(
        (t): t is number => typeof t === 'number' && Number.isFinite(t),
      )
      const state = buildAgentState({
        ...snap,
        pid: this.deps.pid,
        lastActivityAtMs: times.length > 0 ? Math.max(...times) : null,
        nowMs: now,
      })
      if (!state) return 'skipped'
      const signature = agentStateSignature(state)
      const maxInterval = this.deps.maxIntervalMs ?? AGENT_STATE_MAX_INTERVAL_MS
      if (signature === this.lastSignature && now - this.lastWriteAt < maxInterval) return 'unchanged'
      const write = this.deps.write ?? writeAgentStateAtomic
      if (!write(this.deps.path, state)) return 'failed'
      this.lastSignature = signature
      this.lastWriteAt = now
      return 'written'
    } catch {
      return 'failed'
    }
  }

  /** Clean shutdown: stop publishing and take our file away. */
  shutdown(): void {
    this.stopped = true
    removeAgentStateIfOurs(this.deps.path, this.deps.pid)
  }
}
