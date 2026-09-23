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
 *   SubagentStop                                  -> a child agent's row settles
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
 * 4. A HELPER IS NOT A FINISHED TOOL CALL (stage 8). The Agent tool LAUNCHES a
 *    child and answers in a few milliseconds; the child runs on its own and
 *    reports at its own SubagentStop, which may arrive long after the parent's
 *    turn ended. So a child row stays running across the launch response, it
 *    is keyed on the agent id that response minted, and a turn that ends with a
 *    child still working leaves its whole card behind in `carried` for that
 *    child to finish into.
 * 5. ONE DELEGATING TURN IS ONE CARD. A child goes on working after its
 *    parent's Stop, and its own tool events carry the parent's prompt id, so
 *    they used to re open a turn and post a SECOND card for the same piece of
 *    work. A child's events belong to the card its helper row is on: the rows
 *    go there, the qualifier goes there, and no live turn is opened for
 *    them.
 *
 * Wire limits are the backend DTO's: tools[] max 50, icon 16, name 64, args
 * 120, path 200, detail 120; steps max 30 rows of 200 chars.
 */

import {
  RESULT_MAX,
  clipResultHead,
  helperQualifier,
  isAsyncLaunch,
  launchedAgentId,
} from './helpers.ts'
import { scanText } from './secret-scan.ts'
import {
  clipCardOutput,
  clipOutputTail,
  editCountsFor,
  exitCodeFor,
  interpretationFor,
  outputFor,
} from './tool-outcome.ts'

// ── Limits (the backend DTOs own these numbers) ──────────────────────────────

export const TOOL_ROWS_MAX = 50
export const TOOL_NAME_MAX = 64
/** A row's own identity. A value over the cap is DROPPED and never cut: half an
 *  identity is not an identity, and the backend refuses a whole card over one
 *  field this long, which would cost the owner every row on it. */
export const TOOL_ID_MAX = 64
export const TOOL_ARGS_MAX = 120
export const TOOL_PATH_MAX = 200
export const TOOL_DETAIL_MAX = 120
export const STEPS_MAX_ROWS = 30
export const STEPS_MAX_TEXT = 200
export const MARKER_WHAT_MAX = 80
export const MARKER_REASON_MAX = 60
export const MARKER_TOKENS_MAX = 16

/**
 * `output` is the only field in this file measured in kilobytes, and the whole
 * tools array rides EVERY PATCH (one per 600 ms while a turn is live) and every
 * WS frame to every viewer of a shared agent. So the per card budget matters
 * more than the per row cap: at most 8192 characters of output on a card, spent
 * newest first, on top of 2048 characters and 200 lines per row.
 */
export const TOOL_OUTPUT_MAX = 2048
export const TOOL_OUTPUT_LINES_MAX = 200
export const CARD_OUTPUT_BUDGET = 8192

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
  'SubagentStop',
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
  /** The TAIL of what a command printed: stdout, then, only when stderr is not
   *  empty, a line reading exactly `stderr:` and the stderr. One field, masked
   *  before it is clipped, and never a second one (stage 7). */
  output?: string
  /** Minus one to 255. Absent when the runtime reported none, which is not the
   *  same as zero: a grep that found nothing reports no code at all. */
  exitCode?: number
  linesAdded?: number
  linesRemoved?: number
  /** The sender's own stable identity for this row (stage 8). A child row
   *  carries the runtime's agent id, which is what lets the app keep one row's
   *  open state while the rows around it change. */
  id?: string
  /** Epoch milliseconds: the receipt of the line that OPENED this row, and the
   *  only source of the elapsed time a running helper ticks. ISO on the wire,
   *  converted once in lib/hook-card-body.ts, so the range guard lives in one
   *  place and this module stays free of formatting. */
  startedAt?: number
  /** A child's last message when it finished, masked and then cut to its first
   *  240 characters. Never `output`: output is what a command printed, it is
   *  what the chevron opens, and it is what the per card output budget spends. */
  result?: string
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

/**
 * The card of a turn that ENDED while a child agent was still working.
 *
 * It is a field of its own and not a set of live fields, because the live ones
 * must still be cleared at a Stop: leaving them set is how a turn inherits the
 * previous turn's start. The whole row list is kept, not only the children's,
 * because the update that finally settles it REPLACES the card's rows and
 * dropping the parent's work would erase what the owner is reading.
 */
export interface CarriedCard {
  /** The card's OWN key, minted at the Stop from the key the turn drew it
   *  under plus that Stop's receipt. The prefix is the whole point: a child
   *  stamps the PARENT's prompt id on its own hook events, so any turn re
   *  opened under that id would otherwise mint the very key this card had and
   *  patch ITS rows onto the message the owner is watching this helper on. A
   *  key no turn state can produce cannot be minted by accident. */
  cardKey: string
  /** The key the card answered to while its turn was live, which is the key
   *  the message was posted under. The daemon moves the message onto `cardKey`
   *  at the turn end, and this is what it moves it from. */
  turnKey: string
  toolOrder: string[]
  tools: Map<string, ToolRow>
  agentRows: Map<string, string>
  startedAt: number
  /** The receipt of the Stop that ended the parent's turn. The card's own
   *  finish is the moment its LAST row settles, which is later than this. */
  finishedAt: number
}

export interface TurnState {
  turnId: string | null
  toolOrder: string[]
  tools: Map<string, ToolRow>
  /** Session scoped, not turn scoped: Claude Code's task list outlives a turn. */
  tasks: Map<string, TaskRecord>
  /** A child's agent id to the key of the row that launched it. Every later
   *  event a child tags with that id finds its row through this. */
  agentRows: Map<string, string>
  /** The cards of turns that ended while a child agent was still working,
   *  keyed on each card's own key, oldest first. More than one, because a
   *  second turn can end the same way while the first card is still waiting:
   *  a single slot dropped the older card without settling it, and the child
   *  it was waiting for could then never close it. */
  carried: Map<string, CarriedCard>
  startedAt: number
  lastActivityAt: number
  lastCompactMarkerAt: number | null
}

/** How many cards a turn state holds for working children at once.
 *
 * Half the daemon's own card id limit, which also has the live turn's card in
 * it and keeps slack. Bounded for the reason every map in this rail is: a
 * process that runs for weeks may not grow one for ever. Losing the oldest
 * costs that one card its settle, which is what a single slot did to every
 * card but the newest. */
export const CARRIED_CARDS_MAX = 4

export function emptyTurn(): TurnState {
  return {
    turnId: null,
    toolOrder: [],
    tools: new Map(),
    tasks: new Map(),
    agentRows: new Map(),
    carried: new Map(),
    startedAt: 0,
    lastActivityAt: 0,
    lastCompactMarkerAt: null,
  }
}

export type MarkerKind = 'context_compacted' | 'turn_continues'

export type Effect =
  /**
   * `startedAt` and `finishedAt` are epoch milliseconds and are the TURN's own
   * clock, taken from the receipt the hook process stamped (stage 7). They are
   * the only source of the minutes the card shows: nothing anywhere works them
   * out from when a message was created. `startedAt` rides every card once the
   * turn has opened; `finishedAt` exists only on the card a Stop or a
   * SessionEnd settles, because that is the only moment a turn is over.
   */
  | {
      kind: 'tool_card'
      state: 'running' | 'done'
      tools: ToolRow[]
      text: string
      /**
       * Which card this is, for a daemon that may now be holding more than one:
       * a turn whose child outlived it leaves a card behind, and a later update
       * has to reach THAT message rather than post a second one. Stable for the
       * life of a card and different for every turn.
       */
      cardKey: string
      startedAt?: number
      finishedAt?: number
    }
  | { kind: 'steps'; turnId: string | null; steps: StepRow[] }
  | {
      kind: 'marker'
      markerKind: MarkerKind
      title: string
      text: string
      peek?: string
      payload: Record<string, unknown>
    }
  /** `keepCard` is true when a child agent is still working: the turn is over,
   *  its card is not, and the daemon must keep being able to address it. */
  | { kind: 'turn_end'; keepCard: boolean }
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
  // The plan card posts its own bubble, so a tool progress row saying
  // "propose_plan" beside it would narrate the machinery of a card the owner is
  // already looking at.
  'propose_plan',
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

/** The tools that RUN something: a row of theirs can carry what it printed and
 *  an exit code. PowerShell is the Windows agent's shell and its result shape
 *  is Bash's, so leaving it out would give a Windows owner empty rows. */
export const SHELL_TOOLS = ['Bash', 'PowerShell'] as const

/** The tools that CHANGE a file: a row of theirs can carry its plus and minus
 *  counts. Nothing else derives either pair, so a Read draws as it always did. */
export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const

export function isShellTool(name: string): boolean {
  return (SHELL_TOOLS as readonly string[]).includes(baseToolName(name))
}

export function isEditTool(name: string): boolean {
  return (EDIT_TOOLS as readonly string[]).includes(baseToolName(name))
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

/** The one line a private key's body is collapsed into. */
export const PRIVATE_KEY_BODY_PLACEHOLDER = '[private key removed]'

/** The rule whose header opens a block, and a cheap reject so the scan below
 *  only runs on a candidate line. The RULE is the authority: keeping a second
 *  copy of its pattern here is how the two would drift apart. */
const PRIVATE_KEY_RULE = 'private_key_block'
const PRIVATE_KEY_HEADER_HINT = '-----BEGIN'
const PRIVATE_KEY_FOOTER_HINT = '-----END'

const opensPrivateKeyBlock = (line: string): boolean =>
  line.includes(PRIVATE_KEY_HEADER_HINT) &&
  scanText('hook', line).some((finding) => finding.rule === PRIVATE_KEY_RULE)

/**
 * Mask every secret the scan finds, in place, as `[redacted:<rule>]`.
 *
 * scanText reports the rule and a four character excerpt, never the secret's
 * offset, so the span is located by walking from the excerpt prefix to the end
 * of its token and verifying, by re-scanning, that the replacement actually
 * silenced that rule. A finding whose span cannot be located redacts the whole
 * line rather than shipping it: a finding always redacts.
 *
 * A private key is the one secret whose VALUE is not on the line that gives it
 * away. Every rule here is line anchored, the header rule matches the
 * `-----BEGIN ... PRIVATE KEY-----` line alone, and the base64 body lines that
 * follow match nothing at all, so a pass that looked at one line at a time
 * stored the key whole. A header therefore takes the WHOLE line with it and
 * swallows everything up to and including the first `-----END` line, or the
 * rest of the text when there is no END line, into one placeholder.
 */
export function redactForWire(text: string): string {
  if (typeof text !== 'string' || text === '') return ''
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (!opensPrivateKeyBlock(line)) {
      out.push(redactLine(line))
      continue
    }
    // The whole header line, not just the matched span: a one line PEM carries
    // its body on this same line, after the header the rule matched.
    out.push(PLACEHOLDER(PRIVATE_KEY_RULE))
    if (index + 1 >= lines.length) continue
    let end = index + 1
    while (end < lines.length && !lines[end]!.includes(PRIVATE_KEY_FOOTER_HINT)) end++
    out.push(PRIVATE_KEY_BODY_PLACEHOLDER)
    index = Math.min(end, lines.length - 1)
  }
  return out.join('\n')
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
 *
 * With ONE exception, added in stage 8: a child agent that is still working is
 * exempt from the front drop. It is the one old row whose state is still
 * changing, and a helper that vanished from the card while it worked and came
 * back at the end would read as a fault. It takes its slot out of the kept
 * tail, so the total is still at most `max`: a card of 51 rows is refused by
 * the backend outright.
 */
export function clipToolRows(rows: ToolRow[], max: number = TOOL_ROWS_MAX): ToolRow[] {
  if (rows.length <= max) return rows
  const budget = max - 1
  const tail = rows.slice(-budget)
  const front = rows.slice(0, rows.length - tail.length)
  const live = front
    .filter((row) => row.kind === 'subagent' && row.status === 'running')
    .slice(-budget)
  const kept = tail.slice(live.length)
  const dropped = rows.length - live.length - kept.length
  const earlier: ToolRow = {
    icon: '…',
    name: 'earlier',
    args: `${dropped} earlier tools not shown`,
    status: 'done',
  }
  return [earlier, ...live, ...kept]
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

const cloneCarried = (carried: CarriedCard): CarriedCard => ({
  cardKey: carried.cardKey,
  turnKey: carried.turnKey,
  toolOrder: [...carried.toolOrder],
  tools: new Map(carried.tools),
  agentRows: new Map(carried.agentRows),
  startedAt: carried.startedAt,
  finishedAt: carried.finishedAt,
})

const cloneCarriedCards = (cards: Map<string, CarriedCard>): Map<string, CarriedCard> => {
  const out = new Map<string, CarriedCard>()
  for (const [key, card] of cards) out.set(key, cloneCarried(card))
  return out
}

const cloneTurn = (state: TurnState): TurnState => ({
  turnId: state.turnId,
  toolOrder: [...state.toolOrder],
  tools: new Map(state.tools),
  tasks: new Map(state.tasks),
  agentRows: new Map(state.agentRows),
  carried: cloneCarriedCards(state.carried),
  startedAt: state.startedAt,
  lastActivityAt: state.lastActivityAt,
  lastCompactMarkerAt: state.lastCompactMarkerAt,
})

const rowsOf = (state: TurnState): ToolRow[] =>
  state.toolOrder.map((key) => state.tools.get(key)).filter((r): r is ToolRow => r !== undefined)

/**
 * One card state, with the turn's own clock on it.
 *
 * `finishedAt` is a PARAMETER and not a field of the turn, because only the
 * caller knows whether the turn is actually over: a closed ROW is not a closed
 * TURN. Three moments end one, and no others: a Stop, a SessionEnd, and a
 * prompt arriving while rows are still open, which is a turn no Stop is coming
 * for (the owner interrupted it, or a child's own tools opened it after its
 * parent had stopped) and whose rows that prompt is about to throw away.
 */
const cardFrom = (
  rows: ToolRow[],
  cardKey: string,
  done: boolean,
  startedAt: number,
  finishedAt?: number,
): Effect => {
  const tools = clipCardOutput(clipToolRows(rows), CARD_OUTPUT_BUDGET)
  return {
    kind: 'tool_card',
    state: done ? 'done' : 'running',
    tools,
    text: buildCardText(tools, done),
    cardKey,
    ...(startedAt > 0 ? { startedAt } : {}),
    ...(typeof finishedAt === 'number' && finishedAt > 0 ? { finishedAt } : {}),
  }
}

/**
 * One card, for the life of one turn.
 *
 * The prompt id when there is one, the turn's own start when there is not (a
 * daemon that attached mid turn), and the key of the FIRST row on the card
 * when there is neither: a tool_use_id, which one call has and no other. Never
 * a constant, which is what the last arm used to be: two turns that each
 * opened on a tool the mapper could not date then shared one key, and the
 * second turn's rows patched the first turn's message.
 */
const cardKeyOf = (state: TurnState): string => {
  if (state.turnId) return state.turnId
  if (state.startedAt > 0) return `turn:${state.startedAt}`
  return `turn:${state.toolOrder[0] ?? state.lastActivityAt}`
}

/**
 * The key a card answers to once its turn has ended with a child still working.
 *
 * Minted at the Stop, from the key the card was drawn under and that Stop's
 * receipt. A card key identifies a CARD and never a prompt, and this prefix is
 * what makes that true: every hook event a child sends carries the PARENT's
 * prompt id, so a turn re opened under that id would mint exactly the key this
 * card had, and its rows would land on the message the helper row is on. The
 * child's OWN rows do land there, deliberately (header rule 5); a later turn's
 * must not, and a key no turn state can produce is what stops them.
 */
const carriedKeyOf = (turnKey: string, finishedAt: number): string =>
  `carried:${turnKey}:${finishedAt}`

const cardEffect = (state: TurnState, done: boolean, finishedAt?: number): Effect =>
  cardFrom(rowsOf(state), cardKeyOf(state), done, state.startedAt, finishedAt)

const carriedRows = (carried: CarriedCard): ToolRow[] =>
  carried.toolOrder
    .map((key) => carried.tools.get(key))
    .filter((row): row is ToolRow => row !== undefined)

const carriedCard = (carried: CarriedCard, done: boolean, finishedAt?: number): Effect =>
  cardFrom(carriedRows(carried), carried.cardKey, done, carried.startedAt, finishedAt)

const isLiveHelper = (row: ToolRow): boolean => row.kind === 'subagent' && row.status === 'running'

/** The child this payload belongs to, or empty for the parent's own work. */
const childAgentId = (raw: Record<string, unknown>): string => str(raw.agent_id).trim()

/** The card a turn left behind whose child this is, searched over every one of
 *  them: two turns can each end with their own live helper, and each child has
 *  to find the card its own row is on. */
function carriedHolding(state: TurnState, agentId: string): CarriedCard | null {
  for (const carried of state.carried.values()) {
    if (carried.agentRows.has(agentId)) return carried
  }
  return null
}

/**
 * The rows of one card: a live turn's, or a card an earlier turn left behind
 * for a working child.
 *
 * Both hold the same three fields, and every row rule below is written against
 * THIS rather than against either one. The row key, the launch link and the
 * repaint are the same rules wherever the row lands, and the way two sets of
 * rules drift apart is by being written twice.
 */
interface RowSink {
  toolOrder: string[]
  tools: Map<string, ToolRow>
  agentRows: Map<string, string>
}

/** Where a child's own event belongs: the helper row it is working under, and
 *  the card that row is on. */
interface ChildOwner {
  /** The card an earlier turn left behind, or null when the helper row is on
   *  the LIVE turn's card. */
  carried: CarriedCard | null
  /** The key of the helper row itself, inside that card. */
  rowKey: string
}

/**
 * Resolve a child's own event to the helper row it belongs to.
 *
 * The LIVE turn first and then the cards earlier turns left behind, so a child
 * that outlived its parent's turn is answered by the card it is actually on
 * rather than by whatever the parent is doing now. Null for the parent's own
 * work (no agent id at all) and for a child this daemon never saw launched:
 * both keep the ordinary path.
 */
function childOwnerFor(state: TurnState, raw: Record<string, unknown>): ChildOwner | null {
  const agentId = childAgentId(raw)
  if (!agentId) return null
  const liveKey = state.agentRows.get(agentId)
  if (liveKey !== undefined) return { carried: null, rowKey: liveKey }
  const carried = carriedHolding(state, agentId)
  if (carried === null) return null
  const key = carried.agentRows.get(agentId)
  if (key === undefined) return null
  return { carried, rowKey: key }
}

/**
 * Say what a child is doing right now on the child's own row.
 *
 * True when the row actually moved, which is what tells the caller the card
 * has to be repainted: a qualifier that did not change is not news.
 */
function noteChildQualifier(
  tools: Map<string, ToolRow>,
  key: string,
  raw: Record<string, unknown>,
  cwd: string,
): boolean {
  const row = tools.get(key)
  if (row === undefined || row.status !== 'running') return false
  const toolName = baseToolName(str(raw.tool_name))
  const detail = clipForWire(
    redactForWire(helperQualifier(toolName, summarizeToolArgs(toolName, raw.tool_input, cwd))),
    TOOL_DETAIL_MAX,
  )
  if (!detail || row.detail === detail) return false
  tools.set(key, { ...row, detail })
  return true
}

/** A child has reported: its row closes, with what it said and how long it ran. */
function settleChildRow(row: ToolRow, now: number, result: string): ToolRow {
  const settled: ToolRow = { ...row, status: 'done' }
  // The qualifier said what it WAS doing, and it is not doing it any more.
  delete settled.detail
  if (typeof row.startedAt === 'number' && row.startedAt > 0) {
    const span = now - row.startedAt
    if (Number.isFinite(span) && span >= 0) settled.durationMs = Math.round(span)
  }
  if (result) settled.result = result
  return settled
}

/** Every child still working in this row list gives up, with no result: it
 *  never said anything, and there is no moment to measure to either. */
function abandonHelpers(order: string[], tools: Map<string, ToolRow>): void {
  for (const key of order) {
    const row = tools.get(key)
    if (row === undefined || !isLiveHelper(row)) continue
    const abandoned: ToolRow = { ...row, status: 'error' }
    delete abandoned.detail
    tools.set(key, abandoned)
  }
}

const rowKey = (raw: Record<string, unknown>, sink: RowSink): string => {
  const id = str(raw.tool_use_id).trim()
  if (id) return id
  return `anon:${str(raw.tool_name)}:${sink.toolOrder.length}`
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
    // The description is the row's ARGS, the way every other row carries what
    // its call was about, which leaves `detail` free for the running qualifier:
    // what this child is doing right now.
    const args = isRecord(input) ? str(input.description).trim() : ''
    if (args) row.args = clipForWire(redactForWire(args), TOOL_ARGS_MAX)
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

/**
 * A tool call OPENING, as a row on whichever card it belongs to. True when the
 * card has something new to say.
 */
function applyPreToolRow(
  sink: RowSink,
  raw: Record<string, unknown>,
  cwd: string,
  now: number,
): boolean {
  const key = rowKey(raw, sink)
  const previous = sink.tools.get(key)
  const row = buildRow(raw, cwd, 'running')
  if (row.kind === 'subagent') {
    // A helper's own start, the receipt of the line that opened it. It never
    // moves afterwards: it is the number the app ticks from.
    row.startedAt = previous?.startedAt ?? now
    if (previous?.id) row.id = previous.id
  }
  if (sameRow(previous, row)) return false
  if (!sink.tools.has(key)) sink.toolOrder.push(key)
  sink.tools.set(key, row)
  return true
}

/**
 * A tool call CLOSING, on the same card and the same terms.
 */
function applyPostToolRow(
  sink: RowSink,
  raw: Record<string, unknown>,
  cwd: string,
  status: ToolRowStatus,
): boolean {
  const name = str(raw.tool_name)
  const key = rowKey(raw, sink)
  const previous = sink.tools.get(key)
  const row: ToolRow = previous
    ? { ...previous, status }
    : { ...buildRow(raw, cwd, status), status }
  // An async LAUNCH is not a finished call, and it is read off the RESPONSE:
  // never off the tool name, never off the event name. The gate's two
  // launches answered in 5 ms and 2 ms while their children ran for 4.6 and
  // 3.9 seconds, so writing this duration would report a five millisecond
  // helper.
  const launch = isAsyncLaunch(raw.tool_response)
  if (launch) {
    row.status = 'running'
    const agentId = launchedAgentId(raw.tool_response)
    if (agentId) {
      if (agentId.length <= TOOL_ID_MAX) row.id = agentId
      // The link is this daemon's own, and it is kept whatever the wire
      // would accept: the child still has to find its row. It is kept on the
      // card the launch happened on, so a child launched BY a child finds the
      // carried card its parent's row is on.
      sink.agentRows.set(agentId, key)
    }
  }
  const duration = raw.duration_ms
  if (!launch && typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
    row.durationMs = Math.round(duration)
  }
  // What the call actually did (stage 7). It lands BEFORE the sameRow check so
  // the comparison sees the WHOLE row: a row that differs only in what it
  // printed is a row the card still has to repaint.
  if (isShellTool(name)) {
    const interpretation = interpretationFor(raw)
    if (interpretation) row.detail = clipForWire(redactForWire(interpretation), TOOL_DETAIL_MAX)
    const printed = outputFor(raw)
    if (printed) {
      // REDACT BEFORE YOU CLIP (header rule 2), then the TAIL.
      const tail = clipOutputTail(redactForWire(printed), TOOL_OUTPUT_MAX, TOOL_OUTPUT_LINES_MAX)
      if (tail) row.output = tail
    }
    const code = exitCodeFor(raw)
    if (code !== null) row.exitCode = code
  } else if (isEditTool(name)) {
    const { linesAdded, linesRemoved } = editCountsFor(raw)
    if (typeof linesAdded === 'number') row.linesAdded = linesAdded
    if (typeof linesRemoved === 'number') row.linesRemoved = linesRemoved
  }
  if (sameRow(previous, row)) return false
  if (!previous) sink.toolOrder.push(key)
  sink.tools.set(key, row)
  return true
}

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
      // The links ride with the rows they point at. `carried` does NOT: a
      // resume keeps the session id, so a child that was working across it can
      // still report, and the card it belongs to has to still be reachable.
      next.agentRows = new Map()
      // The clock belongs to the TURN, and a session opening is not a turn
      // opening. Setting it here would hand the first turn of the session a
      // start from whenever the daemon attached, and would stop the PreToolUse
      // fallback below ever running for a turn that had no prompt hook.
      next.startedAt = 0
      return { next, effects }
    }

    case 'UserPromptSubmit': {
      // A card still open HERE is a card no Stop is coming for: a turn the
      // owner interrupted, or the pseudo turn a child's own tools opened after
      // its parent stopped. The reset below throws its rows away, so it is
      // settled first rather than left reading "Working" for the rest of the
      // session. A child still running on it never reported and never will:
      // this prompt clears the link its stop would have resolved through.
      if (next.toolOrder.length > 0) {
        abandonHelpers(next.toolOrder, next.tools)
        effects.push(cardEffect(next, true, now))
      }
      next.turnId = event.promptId
      next.toolOrder = []
      next.tools = new Map()
      next.agentRows = new Map()
      // `carried` is deliberately untouched. Each child's completion is
      // delivered to its parent as a prompt carrying a task notification, and
      // that prompt resets the live turn: clearing the carried card here would
      // land the child's own stop on a card that is about the notification.
      next.startedAt = now
      return { next, effects }
    }

    case 'PreToolUse': {
      const name = str(raw.tool_name)
      if (isSkippedTool(name)) return { next, effects }
      const owner = childOwnerFor(next, raw)
      if (owner !== null && owner.carried !== null) {
        // ONE DELEGATING TURN IS ONE CARD (header rule 5). This child's parent
        // has already stopped, so its work belongs to the card its own helper
        // row is on: the qualifier and the row both go there, and no live turn
        // is opened. A live card here is a SECOND message for one turn, minted
        // under the parent's prompt id, which is the id every event a child
        // sends carries.
        const card = owner.carried
        const moved = noteChildQualifier(card.tools, owner.rowKey, raw, event.cwd)
        const drew = applyPreToolRow(card, raw, event.cwd, now)
        if (moved || drew) effects.push(carriedCard(card, false))
        return { next, effects }
      }
      if (next.turnId === null && event.promptId) next.turnId = event.promptId
      // The daemon attached mid turn, so no prompt ever opened it: the first
      // tool of the turn is the earliest moment the runtime reported. Late by
      // however long the model thought, and honest, which is the trade the
      // stage's own rule asks for.
      if (next.startedAt === 0) next.startedAt = now
      // A child of the turn that is still live says what its helper is doing,
      // and then goes on to draw its own row exactly as it does today: the
      // command, what it printed and its exit code are what 0.43.0 shows and
      // taking them away would be a visible loss for anyone who delegates
      // heavily.
      const moved =
        owner === null ? false : noteChildQualifier(next.tools, owner.rowKey, raw, event.cwd)
      const drew = applyPreToolRow(next, raw, event.cwd, now)
      if (!moved && !drew) return { next, effects }
      effects.push(cardEffect(next, false))
      return { next, effects }
    }

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const name = str(raw.tool_name)
      const owner = childOwnerFor(next, raw)
      const onCarried = owner !== null && owner.carried !== null
      // A child whose parent has already stopped is not opening a turn. Its
      // events carry the PARENT's prompt id, and adopting that here mints the
      // very key the card its helper row is on was drawn under.
      if (!onCarried && next.turnId === null && event.promptId) next.turnId = event.promptId
      if (isTaskTool(name)) {
        // A child planning its own work is not the parent planning: the Steps
        // strip is the PARENT's list, and a child's task tools used to push
        // their rows into it.
        if (childAgentId(raw)) return { next, effects }
        if (event.name === 'PostToolUse' && applyTaskTool(next, raw)) {
          effects.push({ kind: 'steps', turnId: next.turnId, steps: stepsFromTasks(next.tasks.values()) })
        }
        return { next, effects }
      }
      if (isSkippedTool(name)) return { next, effects }
      const status: ToolRowStatus = event.name === 'PostToolUseFailure' ? 'error' : 'done'
      if (owner !== null && owner.carried !== null) {
        // The closing half of header rule 5, and it has to be its own site:
        // this is the second place that reads the dead prompt id, and it would
        // open that second card on its own.
        const card = owner.carried
        const moved = noteChildQualifier(card.tools, owner.rowKey, raw, event.cwd)
        const drew = applyPostToolRow(card, raw, event.cwd, status)
        if (moved || drew) effects.push(carriedCard(card, false))
        return { next, effects }
      }
      const moved =
        owner === null ? false : noteChildQualifier(next.tools, owner.rowKey, raw, event.cwd)
      const drew = applyPostToolRow(next, raw, event.cwd, status)
      if (!moved && !drew) return { next, effects }
      effects.push(cardEffect(next, false))
      return { next, effects }
    }

    case 'PreCompact':
    case 'PostCompact': {
      effects.push(...markCompacted(next, raw, now))
      return { next, effects }
    }

    case 'Stop': {
      // The turn is over HERE, so this is the one card that carries a finish.
      // Unless a child agent is still working: a card folds when it settles,
      // and a helper ticking behind a fold helps nobody.
      const keepCard = rowsOf(next).some(isLiveHelper)
      if (next.toolOrder.length > 0) {
        effects.push(keepCard ? cardEffect(next, false) : cardEffect(next, true, now))
      }
      if (next.tasks.size > 0) effects.push({ kind: 'steps', turnId: next.turnId, steps: [] })
      const marker = turnContinuesMarker(raw)
      if (marker) effects.push(marker)
      // Before turn_end, which every reader of this file may assume is last.
      effects.push({ kind: 'goal_poll' })
      if (keepCard) {
        const turnKey = cardKeyOf(next)
        const carried: CarriedCard = {
          cardKey: carriedKeyOf(turnKey, now),
          turnKey,
          toolOrder: [...next.toolOrder],
          tools: new Map(next.tools),
          agentRows: new Map(next.agentRows),
          startedAt: next.startedAt,
          finishedAt: now,
        }
        next.carried.set(carried.cardKey, carried)
        // Oldest first, and a dropped card is the only card that loses its
        // settle. A single slot did that to every card but the newest one.
        while (next.carried.size > CARRIED_CARDS_MAX) {
          const oldest = next.carried.keys().next().value
          if (oldest === undefined) break
          next.carried.delete(oldest)
        }
      }
      effects.push({ kind: 'turn_end', keepCard })
      next.turnId = null
      next.toolOrder = []
      next.tools = new Map()
      next.agentRows = new Map()
      // The clock belongs to the TURN. Leaving it set would hand the next turn
      // a start from the last one, and a turn the owner pushed from their
      // phone (no prompt hook of its own) would then report the minutes since
      // whatever was typed here last.
      next.startedAt = 0
      return { next, effects }
    }

    case 'SubagentStop': {
      // RESOLVE THE ID OR RETURN, and it is the first thing this case does.
      // The composer's suggestion generator fires two of these per turn with an
      // empty agent_type, one of them carrying a prose apology as its last
      // message and one carrying no last message at all. A row drawn for those
      // is a helper the owner never asked for.
      const agentId = childAgentId(raw)
      if (!agentId) return { next, effects }
      const liveKey = next.agentRows.get(agentId)
      const carried = liveKey === undefined ? carriedHolding(next, agentId) : null
      if (liveKey === undefined && carried === null) return { next, effects }
      // MASK, THEN CUT (header rule 2), and the cut keeps the HEAD: an answer
      // is worth reading from its first sentence.
      const result = clipResultHead(redactForWire(str(raw.last_assistant_message)), RESULT_MAX)
      if (liveKey !== undefined) {
        const row = next.tools.get(liveKey)
        if (row === undefined) return { next, effects }
        next.tools.set(liveKey, settleChildRow(row, now, result))
        effects.push(cardEffect(next, false))
        return { next, effects }
      }
      // Not null here: the guard above returned when neither card held it.
      const card = carried!
      const carriedKey = card.agentRows.get(agentId)!
      const row = card.tools.get(carriedKey)
      if (row === undefined) return { next, effects }
      card.tools.set(carriedKey, settleChildRow(row, now, result))
      const over = !carriedRows(card).some(isLiveHelper)
      effects.push(carriedCard(card, over, over ? now : undefined))
      // The card is off the books only when its LAST helper has settled: a
      // card waiting on a second child is still a card a later stop has to
      // reach.
      if (over) next.carried.delete(card.cardKey)
      return { next, effects }
    }

    case 'SessionEnd': {
      // The session is gone, so every child that never reported gives up here.
      // A Stop does NOT do this: a live child after its parent stopped is the
      // normal case this whole lane exists for.
      for (const carried of next.carried.values()) {
        abandonHelpers(carried.toolOrder, carried.tools)
        effects.push(carriedCard(carried, true, now))
      }
      next.carried = new Map()
      if (next.toolOrder.length > 0) {
        abandonHelpers(next.toolOrder, next.tools)
        effects.push(cardEffect(next, true, now))
      }
      effects.push({ kind: 'turn_end', keepCard: false })
      next.turnId = null
      next.toolOrder = []
      next.tools = new Map()
      next.agentRows = new Map()
      next.startedAt = 0
      return { next, effects }
    }

    default:
      return { next, effects }
  }
}
