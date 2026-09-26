/**
 * The Sessions library, Claude Code side (P6 stage 3, C-32, spec 5.7).
 *
 * The app's Sessions sheet lists the sessions in this agent's own folder: the
 * Claude Code project directory its cwd maps to, the same folder the context
 * gauge reads (lib/session-binding.ts), so the list and the gauge can never
 * disagree about which folder is "this agent". A Claude Code agent has one
 * chat, so the folder IS the chat's sessions (D16). This release LISTS only:
 * resuming and renaming a session from the app is a later slice (D20), and
 * lib/voice-rpc.ts answers both `unsupported`.
 *
 * What leaves the machine, and why each rule is here:
 *
 *  - Titles and previews come from the owner's computer, and some of that
 *    text was typed in a terminal and never passed through HOAI. Each one
 *    passes lib/secret-scan.ts, and ANY finding withholds the whole field
 *    (D24): a withheld title is sent as `withheld: 'secret'` with an empty
 *    title, a withheld preview is simply left out. Withholding is simpler to
 *    prove than masking inside a string. A withheld field is never searched
 *    either, so a query cannot probe it.
 *  - The read is bounded. Top level `<session id>.jsonl` only (a subagent's
 *    transcript lives in a folder below, and a name that is not a session id
 *    is not a session), the SESSION_SCAN_MAX newest by mtime, and of each
 *    file only its first and last SESSION_READ_BYTES. Without a query the
 *    scan stops one row past the cap, which is all it needs to know the
 *    answer is cut.
 *  - An unchanged file is not read again: a small cache keyed by name, mtime
 *    and size, pruned to the files the last list considered.
 *
 * Title, in order (the first one present and not empty wins):
 *   1. the latest `custom-title` entry's `customTitle` (the owner's own name
 *      for the session);
 *   2. the latest `ai-title` entry's `aiTitle` (Claude Code 2.1.x writes
 *      `{type:'ai-title', aiTitle, sessionId}`);
 *   3. the first thing the OWNER said: a message typed in the terminal, or a
 *      HOAI channel message with its `<channel ...>` envelope taken off.
 *      Never a tool result, a harness line (a slash command, a caveat, a
 *      task notification), a channel event, or a peer's or the system's
 *      message.
 * Preview: the latest `last-prompt` entry's `lastPrompt`, else the last
 * assistant text. Last activity: the file's mtime. Branch: the latest entry's
 * `gitBranch`.
 *
 * Pure over injected fs (listAgentSessions); AgentSessionLibrary holds the
 * cache and defaults to node's fs. Nothing here throws for a single bad file:
 * an empty, unstattable or unreadable transcript is skipped. Only a folder
 * that exists and cannot be listed throws, and lib/voice-rpc.ts answers that
 * `failed`. A folder that does not exist yet lists nothing.
 */

import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'

import { scanText } from './secret-scan.ts'
import {
  SESSION_BRANCH_MAX,
  SESSION_PREVIEW_MAX,
  SESSION_TITLE_MAX,
  SESSIONS_LIST_MAX,
  type SessionRow,
} from './session-controls-contract.ts'

/** At most this many transcripts, the newest by mtime, are ever read. */
export const SESSION_SCAN_MAX = 200

/** Of each transcript, only the first and the last this many bytes. */
export const SESSION_READ_BYTES = 64 * 1024

/**
 * A Claude Code session id is a UUID, and its transcript is `<id>.jsonl`.
 * Anything else at the top of the folder (an older CLI's `agent-*.jsonl`
 * sidechain, a stray file) is not a session this agent can be bound to.
 */
const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

export interface SessionFileStat {
  mtimeMs: number
  size: number
  isFile: boolean
}

/** The four reads the library makes. Each may throw; the library copes. */
export interface SessionLibraryFs {
  /** Entry names of a folder. A folder that does not exist lists nothing. */
  list(dir: string): string[]
  stat(path: string): SessionFileStat
  /** The first `bytes` bytes, decoded as UTF-8. */
  readHead(path: string, bytes: number): string
  /** The last `bytes` bytes, decoded as UTF-8. */
  readTail(path: string, bytes: number): string
}

/** What one transcript says about itself, before the row is built. */
interface SessionSummary {
  title: string
  titleWithheld: boolean
  preview: string | null
  branch: string | null
}

interface CachedSummary {
  mtimeMs: number
  size: number
  summary: SessionSummary
}

export type SessionSummaryCache = Map<string, CachedSummary>

export interface ListedSessions {
  sessions: SessionRow[]
  truncated: boolean
}

// ── Text ────────────────────────────────────────────────────────────────────

/** Tab, line feed, vertical tab, form feed, carriage return: become a space. */
const BREAKS = /[\u0009-\u000d]/g

/**
 * Deleted outright: every other C0 and C1 control, DEL, and the
 * bidirectional controls a title could reorder itself with. The same set the
 * backend strips (assistant-sessions.model.ts), so what this daemon sends is
 * what the owner reads.
 */
const DROPPED = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/**
 * One line of plain text: breaks become spaces, controls go, whitespace
 * folds, the ends are trimmed, and the result is capped at `max` CHARACTERS
 * (code points, so an emoji is never cut in half).
 */
function oneLine(text: string, max: number): string {
  const folded = text.replace(BREAKS, ' ').replace(DROPPED, '').replace(/\s+/g, ' ').trim()
  const chars = Array.from(folded)
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() : folded
}

/** True when lib/secret-scan.ts finds anything at all in the text. */
function holdsSecret(text: string): boolean {
  return text !== '' && scanText('session', text).length > 0
}

/** Case and accent folded, for the search. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

// ── Transcript entries ──────────────────────────────────────────────────────

type Entry = Record<string, unknown>

function isRecord(v: unknown): v is Entry {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseLines(lines: string[]): Entry[] {
  const out: Entry[] = []
  for (const raw of lines) {
    const text = raw.trim()
    if (!text.startsWith('{')) continue
    try {
      const entry: unknown = JSON.parse(text)
      if (isRecord(entry)) out.push(entry)
    } catch {
      // A line cut by a read window, or a corrupt one: not an entry.
    }
  }
  return out
}

/** The text of a message's content, or '' for a tool result. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    if (part.type === 'tool_result') return ''
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('\n')
}

/** The opening `<channel ...>` tag, with its attributes quoted as the CLI
 *  writes them (a quote inside a value is escaped, so `"[^"]*"` is exact). */
const CHANNEL_OPEN = /^<channel((?:\s+[A-Za-z_][\w-]*="[^"]*")*)\s*>/
const CHANNEL_ATTR = /([A-Za-z_][\w-]*)="([^"]*)"/g

/** Plugin lines inside an owner's channel message that are not what they said. */
const BACKLOG_LINE = /^\[backlog - [^\]\n]*\]$/
const ATTACHED_LINE = /^\[Attached (?:image|video|audio|document): .*\]$/

/** The markers lib/inbound-channel.ts puts on a message that is NOT the owner. */
const NOT_OWNER_MARKER = /^\[(?:Peer message from agent|System message from BGOS)/

/** Claude Code's own lines, recorded as user entries but typed by nobody. */
const HARNESS_TAG =
  /^<(?:command-[a-z-]+|local-command-[a-z-]+|task-notification|system-reminder|bash-[a-z-]+|user-prompt-submit-hook)\b/

/**
 * The owner's words inside a HOAI channel message, or null when the message
 * is an event, a peer's, the system's, or not a well formed envelope.
 */
function channelOwnerBody(text: string): string | null {
  const open = CHANNEL_OPEN.exec(text)
  if (!open) return null
  const attrs: Record<string, string> = {}
  for (const [, key, value] of open[1]!.matchAll(CHANNEL_ATTR)) attrs[key!] = value!
  if (
    attrs.event_type !== undefined ||
    attrs.sender_type === 'agent' ||
    attrs.sender_type === 'system' ||
    attrs.system === 'true'
  ) {
    return null
  }
  let body = text.slice(open[0].length)
  const close = body.lastIndexOf('</channel>')
  if (close >= 0) body = body.slice(0, close)
  if (NOT_OWNER_MARKER.test(body.trimStart())) return null
  const kept = body
    .split('\n')
    .filter((line) => !BACKLOG_LINE.test(line.trim()) && !ATTACHED_LINE.test(line.trim()))
    .join('\n')
    .trim()
  return kept || null
}

/** What the owner said in this entry, or null when it is not the owner's. */
function ownerText(entry: Entry): string | null {
  if (entry.type !== 'user') return null
  if (entry.isSidechain === true || entry.isCompactSummary === true) return null
  const message = isRecord(entry.message) ? entry.message : {}
  const text = contentText(message.content)
  const lead = text.trimStart()
  if (!lead) return null
  // A HOAI message is recorded as a meta line with a channel origin, so the
  // envelope decides, not the meta flag.
  if (lead.startsWith('<channel')) return channelOwnerBody(lead)
  if (entry.isMeta === true) return null
  const origin = isRecord(entry.origin) ? entry.origin : null
  if (origin && typeof origin.kind === 'string' && origin.kind !== 'human') return null
  if (HARNESS_TAG.test(lead)) return null
  return text.trim() || null
}

/** Anything left of a channel envelope in a preview. */
function withoutEnvelopes(text: string): string {
  return text.replace(/<channel\b(?:\s+[A-Za-z_][\w-]*="[^"]*")*\s*>/g, ' ').replace(/<\/channel>/g, ' ')
}

function stringField(entry: Entry, key: string): string | null {
  const value = entry[key]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function assistantText(entry: Entry): string | null {
  if (entry.type !== 'assistant') return null
  if (entry.isSidechain === true || entry.isApiErrorMessage === true) return null
  const message = isRecord(entry.message) ? entry.message : {}
  const text = contentText(message.content)
  return text.trim() ? text : null
}

/**
 * A title or preview field: the text shown, and whether it was withheld. The
 * scan runs over the SOURCE text (all of it, every line) and over what would
 * be shown, so neither a secret past the cap nor one that only appears once
 * lines are folded together can slip through.
 */
function field(source: string | null, max: number): { text: string; withheld: boolean } {
  if (source === null) return { text: '', withheld: false }
  const text = oneLine(source, max)
  return holdsSecret(source) || holdsSecret(text) ? { text: '', withheld: true } : { text, withheld: false }
}

/** Summarise one transcript from its head and tail windows. */
function summarize(head: Entry[], tail: Entry[]): SessionSummary {
  // Latest first: the tail follows the head in the file.
  const latestFirst = [...tail].reverse().concat([...head].reverse())

  const firstOf = <T>(entries: Entry[], pick: (e: Entry) => T | null): T | null => {
    for (const e of entries) {
      const v = pick(e)
      if (v !== null) return v
    }
    return null
  }
  const named = (type: string, key: string) => (e: Entry): string | null =>
    e.type === type && stringField(e, key) !== null && oneLine(stringField(e, key)!, SESSION_TITLE_MAX) !== ''
      ? stringField(e, key)
      : null

  const titleSource =
    firstOf(latestFirst, named('custom-title', 'customTitle')) ??
    firstOf(latestFirst, named('ai-title', 'aiTitle')) ??
    firstOf(head, (e) => {
      const said = ownerText(e)
      return said !== null && oneLine(said, SESSION_TITLE_MAX) !== '' ? said : null
    })
  const title = field(titleSource, SESSION_TITLE_MAX)

  const previewSource =
    firstOf(latestFirst, (e) => {
      if (e.type !== 'last-prompt') return null
      const prompt = stringField(e, 'lastPrompt')
      return prompt !== null && oneLine(withoutEnvelopes(prompt), SESSION_PREVIEW_MAX) !== ''
        ? withoutEnvelopes(prompt)
        : null
    }) ?? firstOf(latestFirst, assistantText)
  const preview = field(previewSource, SESSION_PREVIEW_MAX)

  const branchSource = firstOf(latestFirst, (e) => stringField(e, 'gitBranch'))
  const branch = branchSource === null ? '' : oneLine(branchSource, SESSION_BRANCH_MAX)

  return {
    title: title.text,
    titleWithheld: title.withheld,
    // A withheld preview is left out, never sent empty with a flag.
    preview: preview.withheld || preview.text === '' ? null : preview.text,
    branch: branch === '' ? null : branch,
  }
}

// ── The list ────────────────────────────────────────────────────────────────

interface Candidate {
  name: string
  id: string
  mtimeMs: number
  size: number
}

/**
 * The sessions in `projectDir`, newest first, at most `limit` (never above
 * SESSIONS_LIST_MAX), filtered by `query` before the cap, with the file named
 * `currentName` flagged Current and kept when the cap would cut it.
 */
export function listAgentSessions(args: {
  projectDir: string
  /** The transcript file name this daemon is bound to (`<id>.jsonl`), or null. */
  currentName: string | null
  query?: string
  limit: number
  list: SessionLibraryFs['list']
  stat: SessionLibraryFs['stat']
  readHead: SessionLibraryFs['readHead']
  readTail: SessionLibraryFs['readTail']
  cache?: SessionSummaryCache
}): ListedSessions {
  const { projectDir, currentName, cache } = args
  const cap = Number.isInteger(args.limit) && args.limit >= 1 ? Math.min(args.limit, SESSIONS_LIST_MAX) : SESSIONS_LIST_MAX
  const needle = fold((args.query ?? '').trim())

  const candidates: Candidate[] = []
  for (const name of args.list(projectDir)) {
    const match = SESSION_FILE.exec(name)
    if (!match) continue
    let stat: SessionFileStat
    try {
      stat = args.stat(join(projectDir, name))
    } catch {
      continue
    }
    if (!stat || stat.isFile !== true || !(stat.size > 0) || !Number.isFinite(stat.mtimeMs)) continue
    candidates.push({ name, id: match[1]!, mtimeMs: stat.mtimeMs, size: stat.size })
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const scanned = candidates.slice(0, SESSION_SCAN_MAX)

  if (cache) {
    const keep = new Set(scanned.map((c) => c.name))
    for (const name of [...cache.keys()]) if (!keep.has(name)) cache.delete(name)
  }

  const summaryOf = (c: Candidate): SessionSummary | null => {
    const hit = cache?.get(c.name)
    if (hit && hit.mtimeMs === c.mtimeMs && hit.size === c.size) return hit.summary
    const path = join(projectDir, c.name)
    const whole = c.size <= 2 * SESSION_READ_BYTES
    let summary: SessionSummary
    try {
      const headLines = args.readHead(path, whole ? c.size : SESSION_READ_BYTES).split('\n')
      // The line a window cuts is never parsed: it could be half of anything.
      if (!whole) headLines.pop()
      const tailLines = whole ? [] : args.readTail(path, SESSION_READ_BYTES).split('\n').slice(1)
      summary = summarize(parseLines(headLines), parseLines(tailLines))
    } catch {
      return null
    }
    cache?.set(c.name, { mtimeMs: c.mtimeMs, size: c.size, summary })
    return summary
  }

  const rowOf = (c: Candidate): SessionRow | null => {
    const s = summaryOf(c)
    if (!s) return null
    return {
      id: c.id,
      title: s.titleWithheld ? '' : s.title,
      ...(s.titleWithheld ? { withheld: 'secret' as const } : {}),
      preview: s.preview,
      lastActivityAt: new Date(c.mtimeMs).toISOString(),
      branch: s.branch,
      current: currentName !== null && c.name === currentName,
    }
  }

  // Only what the owner can see is searched: a withheld title is '' and a
  // withheld preview is null, so neither can be probed with a query.
  const matches = (row: SessionRow): boolean =>
    !needle || fold(`${row.title}\n${row.preview ?? ''}`).includes(needle)

  const rows: SessionRow[] = []
  let cut = false
  for (let i = 0; i < scanned.length; i++) {
    const row = rowOf(scanned[i]!)
    if (!row || !matches(row)) continue
    if (rows.length < cap) {
      rows.push(row)
      continue
    }
    // One match past the cap is enough to know the answer is cut. The Current
    // row, if it matches and was cut, takes the last place (as the backend
    // does), so the owner always sees which session is live.
    cut = true
    if (currentName !== null && !rows.some((r) => r.current)) {
      const rest = scanned.slice(i).find((c) => c.name === currentName)
      const current = rest ? rowOf(rest) : null
      if (current && matches(current)) rows[cap - 1] = current
    }
    break
  }

  return { sessions: rows, truncated: cut || candidates.length > SESSION_SCAN_MAX }
}

// ── node's fs, and the library a daemon holds ───────────────────────────────

function readRange(path: string, fromEnd: boolean, bytes: number): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const length = Math.max(0, Math.min(bytes, size))
    const start = fromEnd ? size - length : 0
    const buf = Buffer.alloc(length)
    let got = 0
    while (got < length) {
      const n = readSync(fd, buf, got, length - got, start + got)
      if (n <= 0) break
      got += n
    }
    return buf.subarray(0, got).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** The real fs. A folder that does not exist yet is an agent with no sessions. */
export const NODE_SESSION_FS: SessionLibraryFs = {
  list(dir) {
    try {
      return readdirSync(dir)
    } catch (err) {
      if ((err as { code?: string })?.code === 'ENOENT') return []
      throw err
    }
  },
  stat(path) {
    const s = statSync(path)
    return { mtimeMs: s.mtimeMs, size: s.size, isFile: s.isFile() }
  },
  readHead: (path, bytes) => readRange(path, false, bytes),
  readTail: (path, bytes) => readRange(path, true, bytes),
}

/**
 * One per daemon: the folder, the bound session, and the cache. `currentName`
 * is asked on every list, because the binding moves (a /clear, a restart of
 * the CLI) while the daemon lives.
 */
export class AgentSessionLibrary {
  private readonly projectDir: string
  private readonly currentName: () => string | null
  private readonly fs: SessionLibraryFs
  private readonly cache: SessionSummaryCache = new Map()

  constructor(opts: { projectDir: string; currentName: () => string | null; fs?: SessionLibraryFs }) {
    this.projectDir = opts.projectDir
    this.currentName = opts.currentName
    this.fs = opts.fs ?? NODE_SESSION_FS
  }

  list(input: { query?: string; limit: number }): ListedSessions {
    let current: string | null = null
    try {
      current = this.currentName()
    } catch {
      current = null
    }
    return listAgentSessions({
      projectDir: this.projectDir,
      currentName: current,
      query: input.query,
      limit: input.limit,
      list: (dir) => this.fs.list(dir),
      stat: (path) => this.fs.stat(path),
      readHead: (path, bytes) => this.fs.readHead(path, bytes),
      readTail: (path, bytes) => this.fs.readTail(path, bytes),
      cache: this.cache,
    })
  }
}
