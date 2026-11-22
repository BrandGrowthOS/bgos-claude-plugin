/**
 * claude-stamp: each agent's claude carries its own agent's id, so the watcher can say for certain
 * that a stopped agent runs no claude while the same person runs other agents (lone repair).
 *
 * Before: the watcher named a stopped agent it may not restart (`keepAlive.looked`, which lets the
 * app's Helper check it up alone) only when NO claude of that person ran at all, because a claude it
 * could not place might be the stopped agent's. Most people run several agents, so that was never.
 *
 * The stamp: `~/.bgos-plugin-state/<id>/claude-stamp.json`, written by the agent's daemon while it
 * holds the pairing lock (one writer per agent). It names the agent id, its claude's pid and that
 * claude's START TIME. The pid is the daemon's own claude (its nearest claude ancestor: the daemon is
 * that claude's MCP child), never a guess about another process. The start time is read the way the
 * watcher's listing reads it (`ps -o lstart=` of that one pid, or the Windows walk's CreationDate),
 * so a pid the system reused later never matches. The file is kept when the daemon stops: a claude
 * whose channel died is still that agent's, and pid plus start time say whether a stamp still holds.
 *
 * The watcher reads only these files, for the agents it lists: never another process's command line
 * or environment for this. A claude counts as another agent's only when exactly one stamp matches it,
 * pid AND start time, and that stamp names another agent. Anything else (no stamp, an older plugin,
 * a person's own session, the desktop app, two stamps, a start that cannot be read, a stamp naming the
 * stopped agent itself) leaves the agent out of `looked`, as before: Not running, with Fix to press.
 *
 * Plain JavaScript, node >= 18, import-safe, never throws.
 */

import { parseLstart } from './process-tree.mjs'

export const CLAUDE_STAMP_FILE_NAME = 'claude-stamp.json'
export const CLAUDE_STAMP_SCHEMA_VERSION = 1
/** How long a failed start read waits before the next try (one ps of one pid; the tick is 1 s). */
export const CLAUDE_STAMP_RETRY_MS = 30_000
/** How often the lock holder reads its claude's start again and writes the stamp again (see the writer). */
export const CLAUDE_STAMP_REFRESH_MS = 5 * 60_000

const ID_RE = /^\d{1,16}$/

const validPid = (pid) => typeof pid === 'number' && Number.isInteger(pid) && pid > 1
const validMs = (ms) => typeof ms === 'number' && Number.isFinite(ms) && ms > 0
const validId = (id) => (typeof id === 'string' || typeof id === 'number') && ID_RE.test(String(id).trim()) ? String(id).trim() : null

/**
 * The file body, or null when any part is missing: no stamp is better than a wrong one.
 * @param {{ assistantId: unknown, claudePid: unknown, claudeStartedAtMs: unknown, nowMs: number }} input
 */
export function buildClaudeStamp(input) {
  const assistantId = validId(input?.assistantId)
  if (!assistantId || !validPid(input.claudePid) || !validMs(input.claudeStartedAtMs)) return null
  let stampedAt
  try {
    stampedAt = new Date(input.nowMs).toISOString()
  } catch {
    return null
  }
  return { schemaVersion: CLAUDE_STAMP_SCHEMA_VERSION, assistantId, claudePid: input.claudePid, claudeStartedAtMs: input.claudeStartedAtMs, stampedAt }
}

/**
 * The stamp in an agent's folder, or null. It counts only for the agent whose folder holds it: a
 * stamp copied (or written) into another agent's folder names nobody.
 * @param {string | null | undefined} text
 * @param {string} folderAssistantId
 * @returns {{ assistantId: string, pid: number, startedAtMs: number } | null}
 */
export function parseClaudeStamp(text, folderAssistantId) {
  if (typeof text !== 'string' || !text.trim()) return null
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.schemaVersion !== CLAUDE_STAMP_SCHEMA_VERSION) return null
  const assistantId = typeof raw.assistantId === 'string' ? validId(raw.assistantId) : null
  if (!assistantId || assistantId !== validId(folderAssistantId)) return null
  if (!validPid(raw.claudePid) || !validMs(raw.claudeStartedAtMs)) return null
  return { assistantId, pid: raw.claudePid, startedAtMs: raw.claudeStartedAtMs }
}

/** The one call that reads a claude's start on macOS and Linux: that pid's start column, in the C locale. */
export function claudeStartCommand(pid) {
  return { file: 'env', args: ['LC_ALL=C', 'ps', '-o', 'lstart=', '-p', String(pid)] }
}

/**
 * The daemon's own claude's start time, epoch ms, or null. Windows: the ancestor walk already read it
 * (lib/agent-state.ts readClaudeAncestorWin32), so nothing runs. Elsewhere: one ps of that pid's start.
 * @param {{ platform: string, pid: number, execSync: (file: string, args: string[]) => { code: number, stdout: string }, win32StartedAtMs: number | null }} input
 */
export function readClaudeStartMs(input) {
  if (input.platform === 'win32') return validMs(input.win32StartedAtMs) ? input.win32StartedAtMs : null
  if (!validPid(input.pid)) return null
  try {
    const cmd = claudeStartCommand(input.pid)
    const result = input.execSync(cmd.file, cmd.args)
    if (!result || result.code !== 0) return null
    const ms = parseLstart(String(result.stdout ?? '').trim())
    return validMs(ms) ? ms : null
  } catch {
    return null
  }
}

/**
 * Is every claude in this listing proven ANOTHER agent's? `claudes` are the listing's claudes this user
 * could own (the watcher's ownClaudes); `stamps` are the parsed stamps of every agent the watcher lists.
 *   stamp_names_this_agent  a stamp of THIS agent matches a live process: its claude runs
 *   claude_unstamped        a claude no stamp matches (pid and start time), or whose start is unknown
 *   claude_two_stamps       two agents claim one claude
 * @param {{ listing: Array<{ pid: number, startedAtMs: number | null }>, claudes: Array<{ pid: number, startedAtMs: number | null }>,
 *   stamps: Array<{ assistantId: string, pid: number, startedAtMs: number }>, assistantId: string }} input
 * @returns {{ ok: boolean, reason: 'no_claude' | 'stamped_elsewhere' | 'stamp_names_this_agent' | 'claude_unstamped' | 'claude_two_stamps' }}
 */
export function decideClaudesAccounted(input) {
  // A parsed stamp always has a start, so a listing row whose start is unknown (null) never matches one.
  const same = (p, s) => p.pid === s.pid && p.startedAtMs === s.startedAtMs
  const own = String(input.assistantId)
  const stamps = Array.isArray(input.stamps) ? input.stamps : []
  // Checked over the whole listing (every claude is in it): this agent's own stamp on any live process.
  if (stamps.some((s) => s.assistantId === own && input.listing.some((p) => same(p, s)))) return { ok: false, reason: 'stamp_names_this_agent' }
  if (input.claudes.length === 0) return { ok: true, reason: 'no_claude' }
  for (const claude of input.claudes) {
    const matches = stamps.filter((s) => same(claude, s))
    if (matches.length === 0) return { ok: false, reason: 'claude_unstamped' }
    if (matches.length > 1) return { ok: false, reason: 'claude_two_stamps' }
  }
  return { ok: true, reason: 'stamped_elsewhere' }
}

/**
 * The daemon side. Ticked beside the agent state (server.ts, every second); writes only as the lock
 * holder: at once for a new claude, or after the lock came back (another daemon of this agent may have
 * stamped its own claude meanwhile), and every CLAUDE_STAMP_REFRESH_MS after that. Each refresh reads
 * the start again (on Linux a stepped wall clock moves what ps shows for every process) and writes the
 * file again (a daemon that still believed it held the lock may have written last). Never throws.
 * @param {{ path: string, platform: string, now: () => number, assistantId: () => unknown, claudePid: () => number | null,
 *   win32StartedAtMs: () => number | null, shouldStamp: () => boolean,
 *   execSync: (file: string, args: string[]) => { code: number, stdout: string },
 *   write: (path: string, body: string) => boolean, retryMs?: number, refreshMs?: number }} deps
 */
export function createClaudeStamper(deps) {
  let written = null
  let startFor = null
  let triedAt = Number.NEGATIVE_INFINITY
  const retryMs = deps.retryMs ?? CLAUDE_STAMP_RETRY_MS
  const refreshMs = deps.refreshMs ?? CLAUDE_STAMP_REFRESH_MS
  return {
    /** @returns {'written' | 'unchanged' | 'skipped' | 'failed'} */
    tick() {
      try {
        if (!deps.shouldStamp()) {
          written = null
          return 'skipped'
        }
        const assistantId = validId(deps.assistantId())
        const pid = deps.claudePid()
        if (!assistantId || !validPid(pid)) return 'skipped'
        if (written && written.pid === pid && written.assistantId === assistantId) {
          if (deps.now() - written.at < refreshMs) return 'unchanged'
          // A refresh: read the start again, as for a new claude (a read that just failed keeps its retry wait).
          if (startFor?.pid === pid) startFor = null
        }
        if (!startFor || startFor.pid !== pid) {
          const now = deps.now()
          if (deps.platform !== 'win32' && startFor?.pid === null && now - triedAt < retryMs) return 'skipped'
          if (deps.platform !== 'win32') triedAt = now
          const ms = readClaudeStartMs({ platform: deps.platform, pid, execSync: deps.execSync, win32StartedAtMs: deps.win32StartedAtMs() })
          startFor = ms === null ? { pid: null, ms: null } : { pid, ms }
          if (ms === null) return 'skipped'
        }
        const body = buildClaudeStamp({ assistantId, claudePid: pid, claudeStartedAtMs: startFor.ms, nowMs: deps.now() })
        if (!body) return 'skipped'
        if (!deps.write(deps.path, `${JSON.stringify(body)}\n`)) return 'failed'
        written = { pid, assistantId, at: deps.now() }
        return 'written'
      } catch {
        return 'failed'
      }
    },
  }
}
