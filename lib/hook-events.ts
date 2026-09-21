/**
 * The pure Claude Code hook mapper (stage 4 of the BGOS Mission program).
 *
 * One hook payload in, a small list of EFFECTS out. Nothing here does I/O,
 * reads the clock, touches the network or knows a chat id: the daemon shell
 * (server.ts, task C2) owns all of that and simply executes the effects.
 *
 *   PreToolUse / PostToolUse / PostToolUseFailure -> tool_progress card rows
 *   PostToolUse on TaskCreate / TaskUpdate        -> the live Steps snapshot
 *   PreCompact / PostCompact / SessionStart       -> the context_compacted marker
 *   Stop                                          -> the card settles, Steps clear,
 *                                                    and the turn_continues marker
 *                                                    when background work is left
 *   Stop / SessionStart                           -> goal_poll, the wake that sends
 *                                                    the shell to read the goal
 *                                                    verdict out of the transcript
 *
 * Three rules this file exists to hold:
 *
 * 1. THE PLUGIN ALWAYS SENDS AND NEVER READS THE SWITCH. The owner's per agent
 *    "Show technical details" setting hides rows in the app; the backend still
 *    derives the agent's live working status from the rows arriving, and a
 *    shared agent has several viewers. Nothing in this module gates, batches or
 *    suppresses a row because of a setting. It does not know the setting exists.
 * 2. REDACT BEFORE YOU CLIP. Every string built from tool input runs through
 *    lib/secret-scan.ts and only then gets cut to its wire length. Clipping
 *    first can slice a token in half and hand the scanner a value its pattern
 *    no longer matches, which is how a secret ships.
 * 3. THE OWN TOOLS ARE NOT WORK. The channel's own MCP tools (reply, the ask
 *    tool, the mission tools, the boards tools) and the task tools are plumbing
 *    or feed another lane, so they never draw a tool row.
 *
 * Wire limits are the backend DTO's: tools[] max 50, icon 16, name 64, args
 * 120, path 200, detail 120; steps max 30 rows of 200 chars.
 */

import { scanText } from './secret-scan.ts'

// ── Limits (the backend DTOs own these numbers) ──────────────────────────────

export const TOOL_ROWS_MAX = 50
export const TOOL_NAME_MAX = 64
export const TOOL_ARGS_MAX = 120
export const TOOL_PATH_MAX = 200
export const TOOL_DETAIL_MAX = 120
export const STEPS_MAX_ROWS = 30
export const STEPS_MAX_TEXT = 200
export const MARKER_WHAT_MAX = 80
export const MARKER_REASON_MAX = 60
export const MARKER_TOKENS_MAX = 16

/** A second compaction inside this window is the same compaction, seen from
 *  another hook (PreCompact, then PostCompact, then SessionStart source
 *  compact all fire for one /compact). */
export const COMPACT_DEDUPE_MS = 60_000

// ── The event envelope ───────────────────────────────────────────────────────

export const HOOK_EVENT_NAMES = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
] as const

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number]

export interface HookEvent {
  name: HookEventName
  sessionId: string
  transcriptPath: string
  cwd: string
  promptId: string | null
  raw: Record<string, unknown>
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Accept a raw hook payload, or return null. Never throws: a hook payload is
 * untrusted input arriving from a subprocess, and a mapper that throws takes
 * the daemon's intake down with it.
 */
export function parseHookEvent(raw: unknown): HookEvent | null {
  if (!isRecord(raw)) return null
  const name = str(raw.hook_event_name)
  if (!(HOOK_EVENT_NAMES as readonly string[]).includes(name)) return null
  const sessionId = str(raw.session_id).trim()
  if (!sessionId) return null
  const promptId = str(raw.prompt_id).trim()
  return {
    name: name as HookEventName,
    sessionId,
    transcriptPath: str(raw.transcript_path),
    cwd: str(raw.cwd),
    promptId: promptId || null,
    raw,
  }
}

// ── Rows, steps and the turn ─────────────────────────────────────────────────

export type ToolRowStatus = 'running' | 'done' | 'error'

export interface ToolRow {
  icon: string
  name: string
  args?: string
  status: ToolRowStatus
  /** Absent reads as 'tool' on every consumer; never send a class default. */
  kind?: 'tool' | 'subagent'
  path?: string
  pathCount?: number
  detail?: string
  durationMs?: number
}

export type StepStatus = 'pending' | 'running' | 'done' | 'waiting'

export interface StepRow {
  text: string
  status: StepStatus
  waitsFor?: number
}

export interface TaskRecord {
  id: string
  text: string
  status: StepStatus
}

export interface TurnState {
  turnId: string | null
  toolOrder: string[]
  tools: Map<string, ToolRow>
  /** Session scoped, not turn scoped: Claude Code's task list outlives a turn. */
  tasks: Map<string, TaskRecord>
  startedAt: number
  lastActivityAt: number
  lastCompactMarkerAt: number | null
}

export function emptyTurn(): TurnState {
  return {
    turnId: null,
    toolOrder: [],
    tools: new Map(),
    tasks: new Map(),
    startedAt: 0,
    lastActivityAt: 0,
    lastCompactMarkerAt: null,
  }
}

export type MarkerKind = 'context_compacted' | 'turn_continues'

export type Effect =
  | { kind: 'tool_card'; state: 'running' | 'done'; tools: ToolRow[]; text: string }
  | { kind: 'steps'; turnId: string | null; steps: StepRow[] }
  | {
      kind: 'marker'
      markerKind: MarkerKind
      title: string
      text: string
      peek?: string
      payload: Record<string, unknown>
    }
  | { kind: 'turn_end' }
  /**
   * A moment when a goal verdict may now exist. The mapper decides NOTHING
   * about the goal: Claude Code's own /goal writes its verdict into the
   * session transcript and into no hook payload at all, and the checker runs
   * as a second hook inside the same Stop batch, so this is a WAKE and the
   * transcript is the source. The shell reads it (lib/goal-tail.ts) and maps
   * it (lib/goal-status.ts).
   */
  | { kind: 'goal_poll' }

// ── The skip list ────────────────────────────────────────────────────────────

/** The task tools feed the Steps lane, never the card. */
export const TASK_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'] as const

/**
 * The channel's own MCP tools, read off the ListTools declarations in
 * server.ts (and lib/boards-tools.ts for the boards family). Calling reply is
 * the agent talking to the owner, not the agent doing work, so it never draws
 * a row. test/hook-events.test.ts re-reads those declarations and fails if a
 * new tool is added without landing here.
 */
export const OWN_MCP_TOOLS = [
  'bgos_capabilities',
  'reply',
  'edit_message',
  'rename_chat',
  'set_status',
  'ask_user_input',
  'complete_voice_task',
  'voice_consult_reply',
  'list_peers',
  'list_chats',
  'send_to_peer',
  'complete_peer_thread',
  'peer_status',
  'complete_side_thread',
  'meeting_reply',
  'add_to_meeting',
  'call_owner',
  'schedule',
  'list_schedules',
  'cancel_schedule',
  'create_mission',
  'tick_mini_goal',
  'complete_mission',
  'log_health_event',
  'list_health_events',
  'undo_health_event',
  'show_health_tracker',
  'show_component',
  'channel_ack',
  'boards_list',
  'boards_describe',
  'boards_create',
  'boards_update_schema',
  'boards_query',
  'boards_get_row',
  'boards_insert',
  'boards_update',
  'boards_attach',
  'boards_search',
  'boards_changes',
  'boards_grant',
] as const

export const SKIPPED_TOOLS: string[] = [
  ...TASK_TOOLS,
  'ToolSearch',
  ...OWN_MCP_TOOLS,
]

const SKIPPED_SET = new Set<string>(SKIPPED_TOOLS)

/** `mcp__bgos__reply` and `reply` are the same tool wearing two names. */
export function baseToolName(name: string): string {
  const parts = String(name ?? '').split('__')
  if (parts.length >= 3 && parts[0] === 'mcp') return parts.slice(2).join('__')
  return String(name ?? '')
}

export function isSkippedTool(name: string): boolean {
  return SKIPPED_SET.has(baseToolName(name))
}

export function isTaskTool(name: string): boolean {
  return (TASK_TOOLS as readonly string[]).includes(baseToolName(name))
}

/** The subagent tool: one row per handoff, named by the subagent type. */
export const SUBAGENT_TOOL = 'Agent'
export const SUBAGENT_ICON = '🔀'

// ── Redaction and clipping ───────────────────────────────────────────────────

const PLACEHOLDER = (rule: string): string => `[redacted:${rule}]`

const isBoundaryChar = (ch: string): boolean =>
  ch === ' ' || ch === '\t' || ch === '"' || ch === "'" || ch === '`'

/** The first four characters of a placeholder: scanText's excerpt for a
 *  finding that is really one of OUR masks, not a secret. */
const MASK_EXCERPT_PREFIX = '[red'

const isMaskFinding = (excerpt: string): boolean => excerpt.startsWith(MASK_EXCERPT_PREFIX)

/** Findings of one rule that are NOT a placeholder we already wrote.
 *  `[redacted:generic_secret_assignment]` is itself a long unquoted value
 *  after an `=`, so counting raw findings would never see progress. */
const countRule = (line: string, rule: string): number =>
  scanText('hook', line).filter((f) => f.rule === rule && !isMaskFinding(f.excerpt)).length

interface Span {
  start: number
  end: number
}

const overlaps = (spans: Span[], start: number, end: number): boolean =>
  spans.some((s) => start < s.end && end > s.start)

/**
 * Mask every secret the scan finds, in place, as `[redacted:<rule>]`.
 *
 * scanText reports the rule and a four character excerpt, never the secret's
 * offset, so the span is located by walking from the excerpt prefix to the end
 * of its token and verifying, by re-scanning, that the replacement actually
 * silenced that rule. A finding whose span cannot be located redacts the whole
 * line rather than shipping it: a finding always redacts.
 */
export function redactForWire(text: string): string {
  if (typeof text !== 'string' || text === '') return ''
  return text
    .split(/\r?\n/)
    .map((line) => redactLine(line))
    .join('\n')
}

/** Enough passes for a pathological line; the fail closed exit below covers
 *  anything worse, because a line we ran out of passes on must not ship. */
const REDACT_MAX_PASSES = 200

function redactLine(line: string): string {
  let current = line
  const masked: Span[] = []
  for (let pass = 0; pass < REDACT_MAX_PASSES; pass++) {
    const findings = scanText('hook', current).filter((f) => !isMaskFinding(f.excerpt))
    if (findings.length === 0) return current
    let progressed = false
    for (const finding of findings) {
      const prefix = finding.excerpt.endsWith('...')
        ? finding.excerpt.slice(0, -3)
        : finding.excerpt
      if (!prefix) continue
      const replaced = maskFirstMatch(current, prefix, finding.rule, masked)
      if (!replaced) continue
      current = replaced.line
      masked.length = 0
      masked.push(...replaced.masked)
      progressed = true
      break
    }
    if (!progressed) {
      // Every remaining finding sits inside a mask we already wrote (the
      // placeholder itself can look like an assignment value), so we are done.
      return current
    }
  }
  // Out of passes with real findings still on the line: drop the line rather
  // than ship the part we did not get to.
  const left = scanText('hook', current).filter((f) => !isMaskFinding(f.excerpt))
  return left.length > 0 ? PLACEHOLDER(left[0]!.rule) : current
}

function maskFirstMatch(
  line: string,
  prefix: string,
  rule: string,
  masked: Span[],
): { line: string; masked: Span[] } | null {
  const before = countRule(line, rule)
  for (let start = line.indexOf(prefix); start !== -1; start = line.indexOf(prefix, start + 1)) {
    let runEnd = start
    while (runEnd < line.length && !isBoundaryChar(line[runEnd]!)) runEnd++
    const ends: number[] = []
    for (let e = start + prefix.length; e <= runEnd; e++) {
      const ch = line[e]
      if (e === runEnd || ch === '@' || ch === '/' || ch === ',' || ch === ';' || ch === ')') {
        ends.push(e)
      }
    }
    for (const end of ends) {
      if (end <= start) continue
      if (overlaps(masked, start, end)) continue
      const token = PLACEHOLDER(rule)
      const candidate = line.slice(0, start) + token + line.slice(end)
      if (countRule(candidate, rule) >= before) continue
      const shift = token.length - (end - start)
      const next = masked.map((s) =>
        s.start >= end ? { start: s.start + shift, end: s.end + shift } : s,
      )
      next.push({ start, end: start + token.length })
      return { line: candidate, masked: next }
    }
  }
  // Could not localise it (a multi line PEM block, say): redact the line.
  return { line: PLACEHOLDER(rule), masked: [{ start: 0, end: PLACEHOLDER(rule).length }] }
}

/**
 * Cut to max characters without leaving a lone high surrogate at the cut (the
 * same guard lib/missions.ts uses for mission summaries). The ellipsis marks
 * the cut, exactly as the Codex poster does at 120.
 */
export function clipForWire(text: string, max: number): string {
  if (typeof text !== 'string') return ''
  if (text.length <= max) return text
  let cut = text.slice(0, max - 1)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return `${cut}…`
}

// ── Paths and per tool argument summaries ────────────────────────────────────

const PATH_FIELD_BY_TOOL: Record<string, string> = {
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
  Glob: 'path',
  Grep: 'path',
}

export interface ToolPathInfo {
  path?: string
  pathCount?: number
}

const normalizeSlashes = (p: string): string => p.replace(/\\/g, '/')

/**
 * Shorten a path for the wire: relative to the session cwd when it is inside
 * it, else the basename plus one parent segment. An absolute path leaks the
 * machine layout and a home directory leaks a username, and neither helps the
 * owner read the row.
 */
export function shortenPath(raw: string, cwd: string): string {
  const p = normalizeSlashes(String(raw ?? '').trim())
  if (!p) return ''
  const base = normalizeSlashes(String(cwd ?? '').trim()).replace(/\/+$/, '')
  if (base && (p === base || p.toLowerCase().startsWith(`${base.toLowerCase()}/`))) {
    const rel = p.slice(base.length + 1)
    return clipForWire(rel || '.', TOOL_PATH_MAX)
  }
  const parts = p.split('/').filter(Boolean)
  const tail = parts.slice(-2).join('/')
  return clipForWire(tail || p, TOOL_PATH_MAX)
}

/**
 * Home directory prefixes as they are spelled on the three platforms. Matched
 * on the text itself rather than read from the environment, so the module
 * stays pure AND a command naming ANOTHER account's home is shortened too.
 */
const HOME_PREFIX_RE =
  /(\/home\/[^/\\\s"':]+|\/Users\/[^/\\\s"':]+|[A-Za-z]:[\\/]Users[\\/][^/\\\s"':]+)/g

const escapeForRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Shorten absolute paths INSIDE a free text command, the way shortenPath does
 * for the row's own path slot: the session cwd becomes a relative path and a
 * home directory becomes `~`.
 *
 * A Bash row ships the command itself, so without this the owner's row reads
 * `cat /home/karim/.bgos-agent/credentials-901.json` and the machine layout
 * (and the account name) is on the wire. Runs BEFORE the redaction and the 120
 * character clip, so a shortened path is what gets measured.
 */
export function shortenPathsInText(raw: string, cwd: string): string {
  let text = String(raw ?? '')
  if (!text) return ''
  const base = normalizeSlashes(String(cwd ?? '').trim()).replace(/\/+$/, '')
  if (base) {
    const either = escapeForRegex(base).replace(/\//g, '[\\\\/]')
    // The cwd with something after it becomes that something.
    text = text.replace(new RegExp(`${either}[\\\\/]`, 'gi'), '')
    // The bare cwd is the directory itself.
    text = text.replace(new RegExp(`${either}(?=$|[\\s"\':;,)])`, 'gi'), '.')
  }
  return text.replace(HOME_PREFIX_RE, '~')
}

/** The file (and how many more) a tool call touched, for the row's path slot. */
export function pathForTool(toolName: string, toolInput: unknown, cwd: string): ToolPathInfo {
  const field = PATH_FIELD_BY_TOOL[baseToolName(toolName)]
  if (!field || !isRecord(toolInput)) return {}
  const many = toolInput[`${field}s`]
  if (Array.isArray(many)) {
    const paths = many.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    if (paths.length === 0) return {}
    const info: ToolPathInfo = { path: clipForWire(redactForWire(shortenPath(paths[0]!, cwd)), TOOL_PATH_MAX) }
    if (paths.length > 1) info.pathCount = paths.length
    return info
  }
  const one = toolInput[field]
  if (typeof one !== 'string' || one.trim() === '') return {}
  return { path: clipForWire(redactForWire(shortenPath(one, cwd)), TOOL_PATH_MAX) }
}

const FALLBACK_ARG_FIELDS = [
  'command',
  'pattern',
  'query',
  'url',
  'prompt',
  'description',
  'file_path',
  'notebook_path',
  'path',
  'name',
  'subject',
]

function rawArgsFor(toolName: string, toolInput: unknown, cwd: string): string {
  if (!isRecord(toolInput)) return ''
  const name = baseToolName(toolName)
  // The command ships as the row's args, so every absolute path inside it is
  // shortened first (see shortenPathsInText).
  if (name === 'Bash') return shortenPathsInText(str(toolInput.command), cwd)
  if (name === SUBAGENT_TOOL) return str(toolInput.description)
  if (name === 'Glob' || name === 'Grep') {
    const pattern = str(toolInput.pattern)
    const where = str(toolInput.path)
    if (pattern && where) return `${pattern} in ${shortenPath(where, cwd)}`
    return pattern || (where ? shortenPath(where, cwd) : '')
  }
  const field = PATH_FIELD_BY_TOOL[name]
  if (field) {
    const one = str(toolInput[field])
    if (one) return shortenPath(one, cwd)
  }
  for (const key of FALLBACK_ARG_FIELDS) {
    const v = toolInput[key]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return ''
}

/**
 * The row's `args`: what this call was about, in at most 120 characters.
 * REDACTED FIRST, then clipped, never the other way round.
 */
export function summarizeToolArgs(toolName: string, toolInput: unknown, cwd: string): string {
  const raw = rawArgsFor(toolName, toolInput, cwd)
  if (!raw) return ''
  return clipForWire(redactForWire(raw).trim(), TOOL_ARGS_MAX)
}

// ── Icons (ported verbatim from the Codex poster) ────────────────────────────

/**
 * Ported from the Codex plugin's defaultIconForToolName so one owner reading
 * two agents sees one vocabulary. Lowercase comparison already covers Claude
 * Code's own Bash / Read / Edit / Grep names.
 */
export function iconForToolName(name: string): string {
  const t = baseToolName(name).toLowerCase()
  if (t === 'bash' || t === 'terminal' || t.startsWith('exec')) return '💻'
  if (t === 'read' || t === 'read_file' || t.startsWith('read')) return '📖'
  if (t === 'edit' || t === 'write' || t === 'write_file') return '📝'
  if (t === 'grep' || t === 'search' || t.startsWith('search')) return '🔎'
  if (t === 'glob' || t === 'find' || t === 'ls' || t.startsWith('list')) return '📂'
  if (t === 'fetch' || t === 'web_fetch' || t === 'curl') return '🌐'
  if (t === 'task' || t === 'todowrite' || t === 'todo_write') return '✅'
  if (t.includes('test')) return '🧪'
  if (t.includes('install') || t.includes('npm') || t.includes('pip')) return '📦'
  if (t.includes('db') || t.includes('sql') || t.includes('psql')) return '🗃️'
  return '🔧'
}

// ── The card ─────────────────────────────────────────────────────────────────

/**
 * Byte identical to the Codex plugin's buildSummary: the two channels must not
 * disagree about what the card says.
 */
export function buildCardText(tools: ToolRow[], done: boolean): string {
  if (tools.length === 0) {
    return done ? 'No tools used' : 'Working…'
  }
  const names = tools.slice(0, 4).map((t) => t.name)
  const tail = tools.length > 4 ? `, +${tools.length - 4} more` : ''
  if (done) {
    const noun = tools.length === 1 ? 'tool' : 'tools'
    return `Used ${tools.length} ${noun} · ${names.join(', ')}${tail}`
  }
  return `Working… · ${names.join(', ')}${tail}`
}

/**
 * The backend caps tools[] at 50. Keep the TAIL: the end of a long turn is what
 * the owner is looking at, and the first fifty things that happened are a
 * museum. One synthetic row says how many were dropped.
 */
export function clipToolRows(rows: ToolRow[], max: number = TOOL_ROWS_MAX): ToolRow[] {
  if (rows.length <= max) return rows
  const kept = rows.slice(-(max - 1))
  const dropped = rows.length - kept.length
  const earlier: ToolRow = {
    icon: '…',
    name: 'earlier',
    args: `${dropped} earlier tools not shown`,
    status: 'done',
  }
  return [earlier, ...kept]
}

// ── Steps ────────────────────────────────────────────────────────────────────

export function statusForTaskStatus(status: unknown): StepStatus | 'deleted' {
  const s = str(status).toLowerCase()
  if (s === 'in_progress') return 'running'
  if (s === 'completed') return 'done'
  if (s === 'deleted') return 'deleted'
  return 'pending'
}

export function stepsFromTasks(tasks: Iterable<TaskRecord>): StepRow[] {
  const rows: StepRow[] = []
  for (const task of tasks) {
    const text = clipForWire(task.text, STEPS_MAX_TEXT)
    if (!text) continue
    rows.push({ text, status: task.status })
    if (rows.length >= STEPS_MAX_ROWS) break
  }
  return rows
}

const taskFileOrdinal = (name: string): number => {
  const m = /^(\d+)/.exec(String(name ?? ''))
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}

/**
 * Rebuild the task list from ~/.claude/tasks/<session_id>/*.json after a
 * SessionStart, so a daemon that attaches mid session still shows the Steps.
 * File shape, verified on disk: { id, subject, description, status, activeForm? }.
 */
export function stepsFromTaskFiles(files: Array<{ name: string; json: unknown }>): StepRow[] {
  const ordered = [...files].sort((a, b) => {
    const d = taskFileOrdinal(a.name) - taskFileOrdinal(b.name)
    return d !== 0 ? d : String(a.name).localeCompare(String(b.name))
  })
  const tasks: TaskRecord[] = []
  for (const file of ordered) {
    if (!isRecord(file.json)) continue
    const status = statusForTaskStatus(file.json.status)
    if (status === 'deleted') continue
    const text = str(file.json.activeForm).trim() || str(file.json.subject).trim()
    if (!text) continue
    tasks.push({
      id: str(file.json.id) || String(taskFileOrdinal(file.name)),
      text: redactForWire(text),
      status,
    })
  }
  return stepsFromTasks(tasks)
}

export function taskDirFor(claudeHome: string, sessionId: string): string {
  return `${String(claudeHome).replace(/[/\\]+$/, '')}/tasks/${sessionId}`
}

// ── The turn machine ─────────────────────────────────────────────────────────

const cloneTurn = (state: TurnState): TurnState => ({
  turnId: state.turnId,
  toolOrder: [...state.toolOrder],
  tools: new Map(state.tools),
  tasks: new Map(state.tasks),
  startedAt: state.startedAt,
  lastActivityAt: state.lastActivityAt,
  lastCompactMarkerAt: state.lastCompactMarkerAt,
})

const rowsOf = (state: TurnState): ToolRow[] =>
  state.toolOrder.map((key) => state.tools.get(key)).filter((r): r is ToolRow => r !== undefined)

const cardEffect = (state: TurnState, done: boolean): Effect => {
  const tools = clipToolRows(rowsOf(state))
  return { kind: 'tool_card', state: done ? 'done' : 'running', tools, text: buildCardText(tools, done) }
}

const rowKey = (raw: Record<string, unknown>, state: TurnState): string => {
  const id = str(raw.tool_use_id).trim()
  if (id) return id
  return `anon:${str(raw.tool_name)}:${state.toolOrder.length}`
}

function buildRow(raw: Record<string, unknown>, cwd: string, status: ToolRowStatus): ToolRow {
  const toolName = baseToolName(str(raw.tool_name))
  const input = raw.tool_input
  if (toolName === SUBAGENT_TOOL) {
    const type = isRecord(input) ? str(input.subagent_type).trim() : ''
    const row: ToolRow = {
      icon: SUBAGENT_ICON,
      name: clipForWire(redactForWire(type || 'subagent'), TOOL_NAME_MAX),
      status,
      kind: 'subagent',
    }
    const detail = isRecord(input) ? str(input.description).trim() : ''
    if (detail) row.detail = clipForWire(redactForWire(detail), TOOL_DETAIL_MAX)
    return row
  }
  const row: ToolRow = {
    icon: iconForToolName(toolName),
    name: clipForWire(toolName || 'tool', TOOL_NAME_MAX),
    status,
  }
  const args = summarizeToolArgs(toolName, input, cwd)
  if (args) row.args = args
  const { path, pathCount } = pathForTool(toolName, input, cwd)
  if (path) row.path = path
  if (pathCount !== undefined) row.pathCount = pathCount
  return row
}

const sameRow = (a: ToolRow | undefined, b: ToolRow): boolean =>
  a !== undefined && JSON.stringify(a) === JSON.stringify(b)

function applyTaskTool(state: TurnState, raw: Record<string, unknown>): boolean {
  const tool = baseToolName(str(raw.tool_name))
  const input = isRecord(raw.tool_input) ? raw.tool_input : {}
  const response = isRecord(raw.tool_response) ? raw.tool_response : {}
  if (tool === 'TaskCreate') {
    const created = isRecord(response.task) ? response.task : {}
    const id = str(created.id).trim() || String(state.tasks.size + 1)
    const text =
      str(input.activeForm).trim() || str(created.subject).trim() || str(input.subject).trim()
    if (!text) return false
    const createdStatus = statusForTaskStatus(input.status)
    state.tasks.set(id, {
      id,
      text: redactForWire(text),
      status: createdStatus === 'deleted' ? 'pending' : createdStatus,
    })
    return true
  }
  if (tool === 'TaskUpdate') {
    const id = str(input.taskId).trim() || str(response.taskId).trim()
    if (!id) return false
    const previous = state.tasks.get(id)
    const status = statusForTaskStatus(input.status)
    if (status === 'deleted') {
      if (!previous) return false
      state.tasks.delete(id)
      return true
    }
    const text =
      str(input.activeForm).trim() || str(input.subject).trim() || previous?.text || `Task ${id}`
    state.tasks.set(id, { id, text: redactForWire(text), status })
    return true
  }
  return false
}

const compactMarker = (
  reason: string,
  before: string,
  after: string,
): Effect => {
  const payload: Record<string, unknown> = { kind: 'context_compacted' }
  if (before) payload.before = clipForWire(before, MARKER_TOKENS_MAX)
  if (after) payload.after = clipForWire(after, MARKER_TOKENS_MAX)
  if (reason) payload.reason = clipForWire(redactForWire(reason), MARKER_REASON_MAX)
  const title = 'Context compacted'
  return {
    kind: 'marker',
    markerKind: 'context_compacted',
    title,
    text: reason ? `${title} (${payload.reason as string})` : title,
    payload,
  }
}

const reasonForTrigger = (trigger: string): string => {
  if (trigger === 'manual') return 'manual /compact'
  if (trigger === 'auto') return 'the context filled up'
  return trigger
}

const tokenText = (raw: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const v = raw[key]
    if (typeof v === 'number' && Number.isFinite(v)) return String(Math.round(v))
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return ''
}

function markCompacted(next: TurnState, raw: Record<string, unknown>, now: number): Effect[] {
  if (next.lastCompactMarkerAt !== null && now - next.lastCompactMarkerAt < COMPACT_DEDUPE_MS) {
    return []
  }
  next.lastCompactMarkerAt = now
  const reason = reasonForTrigger(str(raw.trigger).trim())
  const before = tokenText(raw, ['before_tokens', 'pre_tokens', 'tokens_before'])
  const after = tokenText(raw, ['after_tokens', 'post_tokens', 'tokens_after'])
  return [compactMarker(reason, before, after)]
}

const backgroundWhat = (raw: Record<string, unknown>): string => {
  const list = Array.isArray(raw.background_tasks) ? raw.background_tasks : []
  const first = list[0]
  if (typeof first === 'string') return first.trim()
  if (isRecord(first)) {
    for (const key of ['description', 'subject', 'name', 'prompt', 'command']) {
      const v = first[key]
      if (typeof v === 'string' && v.trim() !== '') return v.trim()
    }
  }
  return ''
}

function turnContinuesMarker(raw: Record<string, unknown>): Effect | null {
  const list = Array.isArray(raw.background_tasks) ? raw.background_tasks : []
  if (list.length === 0) return null
  const what = clipForWire(redactForWire(backgroundWhat(raw)), MARKER_WHAT_MAX)
  const payload: Record<string, unknown> = { kind: 'turn_continues' }
  if (what) payload.what = what
  const title = 'Work continues in the background'
  return {
    kind: 'marker',
    markerKind: 'turn_continues',
    title,
    text: what ? `${title}: ${what}` : title,
    payload,
  }
}

/**
 * The whole mapper. Pure: the state handed in is never mutated, the clock is
 * the caller's, and the effects are a plain list the shell executes in order.
 */
export function applyHookEventToTurn(
  state: TurnState,
  event: HookEvent,
  now: number,
): { next: TurnState; effects: Effect[] } {
  const next = cloneTurn(state)
  next.lastActivityAt = now
  const raw = event.raw
  const effects: Effect[] = []

  switch (event.name) {
    case 'SessionStart': {
      // Both arms: a resume and a compaction restart are each a moment to
      // re read the goal this session may already be under.
      effects.push({ kind: 'goal_poll' })
      if (str(raw.source) === 'compact') {
        effects.push(...markCompacted(next, raw, now))
        return { next, effects }
      }
      next.turnId = null
      next.toolOrder = []
      next.tools = new Map()
      next.tasks = new Map()
      next.startedAt = now
      return { next, effects }
    }

    case 'UserPromptSubmit': {
      next.turnId = event.promptId
      next.toolOrder = []
      next.tools = new Map()
      next.startedAt = now
      return { next, effects }
    }

    case 'PreToolUse': {
      const name = str(raw.tool_name)
      if (isSkippedTool(name)) return { next, effects }
      if (next.turnId === null && event.promptId) next.turnId = event.promptId
      const key = rowKey(raw, next)
      const row = buildRow(raw, event.cwd, 'running')
      if (sameRow(next.tools.get(key), row)) return { next, effects }
      if (!next.tools.has(key)) next.toolOrder.push(key)
      next.tools.set(key, row)
      effects.push(cardEffect(next, false))
      return { next, effects }
    }

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const name = str(raw.tool_name)
      if (next.turnId === null && event.promptId) next.turnId = event.promptId
      if (isTaskTool(name)) {
        if (event.name === 'PostToolUse' && applyTaskTool(next, raw)) {
          effects.push({ kind: 'steps', turnId: next.turnId, steps: stepsFromTasks(next.tasks.values()) })
        }
        return { next, effects }
      }
      if (isSkippedTool(name)) return { next, effects }
      const key = rowKey(raw, next)
      const status: ToolRowStatus = event.name === 'PostToolUseFailure' ? 'error' : 'done'
      const previous = next.tools.get(key)
      const row: ToolRow = previous
        ? { ...previous, status }
        : { ...buildRow(raw, event.cwd, status), status }
      const duration = raw.duration_ms
      if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
        row.durationMs = Math.round(duration)
      }
      if (sameRow(previous, row)) return { next, effects }
      if (!previous) next.toolOrder.push(key)
      next.tools.set(key, row)
      effects.push(cardEffect(next, false))
      return { next, effects }
    }

    case 'PreCompact':
    case 'PostCompact': {
      effects.push(...markCompacted(next, raw, now))
      return { next, effects }
    }

    case 'Stop': {
      if (next.toolOrder.length > 0) effects.push(cardEffect(next, true))
      if (next.tasks.size > 0) effects.push({ kind: 'steps', turnId: next.turnId, steps: [] })
      const marker = turnContinuesMarker(raw)
      if (marker) effects.push(marker)
      // Before turn_end, which every reader of this file may assume is last.
      effects.push({ kind: 'goal_poll' })
      effects.push({ kind: 'turn_end' })
      next.turnId = null
      next.toolOrder = []
      next.tools = new Map()
      return { next, effects }
    }

    case 'SessionEnd': {
      if (next.toolOrder.length > 0) effects.push(cardEffect(next, true))
      effects.push({ kind: 'turn_end' })
      next.turnId = null
      next.toolOrder = []
      next.tools = new Map()
      return { next, effects }
    }

    default:
      return { next, effects }
  }
}
