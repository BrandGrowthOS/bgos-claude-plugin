import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { unescapeAgentButtonValue } from './message-text.ts'
import { knownNumbers } from './file-numbers.mjs'
import { REAL_IDENT_FS, SKILL_NAME_RE, identLook, type IdentFs, type SkillItem, type SkillsList } from './skills-inventory.ts'
import { OWN_MCP_TOOLS } from './hook-events.ts'
import { deliveredNeedle, promptCarriesDelivered, type TurnChatNote } from './turn-chat.ts'

export type SkillOrigin = 'taught' | 'made' | 'installed' | 'shared' | 'repo' | 'synced'
export const TEACH_APPROVE = 'teach_approve'
export const TEACH_WINDOW_MS = 15 * 60_000
/** Added to the owner's Approve card when it opens a window: the one write that can mark the skill taught. */
export const TEACH_WRITE_FIRST = 'Teach approved: write this skill\'s SKILL.md now with the Write tool, before any other tool. If any other tool or message comes first, the skill shows no Taught mark.'

let originLog: (msg: string) => void = () => {}

/** Where origin errors go: the daemon's own log (server.ts sets it once). Until then they are dropped. */
export function logOriginsTo(log: (msg: string) => void): void {
  originLog = log
}

function failed(): void {
  try { originLog('skills: origin unavailable') } catch { /* best effort */ }
}

type TeachTap = {
  chatId: string
  messageId?: unknown
  assistantId: unknown
  tapperUserId: unknown
  ownerUserId: unknown
  callbackData: unknown
  customText?: unknown
  /** The click's own humanPrincipal, raw: only exactly true says a person tapped. */
  humanPrincipal?: unknown
  posted: unknown
  /** Exactly true when no turn could overlap the window: createCardDeliveries' idle, read as the tap card goes out. */
  idle?: unknown
  /** The tap card's text as built: the prompt that carries it starts the turn the window lives in. */
  card?: unknown
  now: number
}

/**
 * Whether a click says a person tapped: humanPrincipal exactly true (camelCase, boolean) at the top level of the click
 * row (beside its answer payload, on the poll and update stream rows) or of a live click event. The server sets it;
 * it is never read inside the answer payload, and any other value is not a person. The one reader every tap site
 * uses. Never throws.
 */
export function isHumanClick(row: unknown): boolean {
  try {
    return row !== null && typeof row === 'object' && (row as Record<string, unknown>).humanPrincipal === true
  } catch { failed(); return false }
}

function windowKey(chatId: unknown, assistantId: unknown): string | null {
  if (typeof chatId !== 'string' || !chatId || typeof assistantId !== 'string' || !assistantId) return null
  return JSON.stringify([assistantId, chatId])
}

/**
 * The owner's own tap as a person: on a button this daemon posted, the click says a person made it (humanPrincipal
 * exactly true), no words were typed with it, and the tapper is the owner (both non-blank). A signed-in teammate is a
 * person too, so the owner check stays.
 */
/** The owner's own teach Approve as a person: what noteTap opens a window for, when the agent is idle. */
export function teachTapOpens(t: Omit<TeachTap, 'chatId' | 'assistantId' | 'now'>): boolean {
  try {
    return ownPersonTap(t) && typeof t.callbackData === 'string' && unescapeAgentButtonValue(t.callbackData) === TEACH_APPROVE
  } catch { failed(); return false }
}

function ownPersonTap(t: Omit<TeachTap, 'chatId' | 'assistantId' | 'now'>): boolean {
  return !!t.posted && t.humanPrincipal === true &&
    !(t.customText != null && String(t.customText) !== '') &&
    typeof t.ownerUserId === 'string' && !!t.ownerUserId.trim() &&
    typeof t.tapperUserId === 'string' && !!t.tapperUserId.trim() &&
    t.tapperUserId === t.ownerUserId
}

/**
 * The teach windows of this daemon life, in memory. A window opens only on an idle agent (no turn that anyone else
 * started could overlap it), and it lives only in the one turn the owner's tap card starts: the next prompt must carry
 * that card, any other prompt or that turn's end closes it, and a write before that prompt marks nothing. Each one
 * keeps the tap's wall clock time (`at`, to refuse a write from before the tap) and a monotonic reading (`since`), so
 * a clock set back never keeps a window open past TEACH_WINDOW_MS from the tap. `monotonic` is for tests.
 */
export function createTeachWindows(opts: { monotonic?: () => number } = {}) {
  const monotonic = opts.monotonic ?? (() => performance.now())
  const windows = new Map<string, { by: string; at: number; since: number; needle: string | null; started: boolean }>()
  const expired = (window: { at: number; since: number }, now: number): boolean =>
    now - window.at > TEACH_WINDOW_MS || monotonic() - window.since > TEACH_WINDOW_MS
  return {
    noteTap(t: TeachTap): void {
      try {
        const key = windowKey(t.chatId, t.assistantId)
        const needle = typeof t.card === 'string' ? deliveredNeedle(t.card) : null
        if (key === null || !Number.isFinite(t.now) || t.idle !== true || !teachTapOpens(t)) return
        for (const [open, window] of windows) {
          if (expired(window, t.now)) windows.delete(open)
        }
        windows.set(key, { by: String(t.tapperUserId), at: t.now, since: monotonic(), needle, started: false })
      } catch { failed() }
    },
    /** A delivery in this chat that is not the owner's own tap: the window no longer means what the owner approved. */
    close(chatId: string, assistantId: string): void {
      try {
        const key = windowKey(chatId, assistantId)
        if (key !== null) windows.delete(key)
      } catch { failed() }
    },
    /** A card reached the session that is not the owner's own tap: its turn may be filed under any chat. */
    closeAll(): void {
      windows.clear()
    },
    /**
     * A turn began (a UserPromptSubmit hook line). A window waiting for its tap card's turn starts when the prompt
     * carries that card; every other window closes: a prompt that does not carry the tap card, or a second prompt, is
     * not the turn the owner approved.
     */
    beginTurn(prompt: unknown): void {
      try {
        for (const [key, window] of windows) {
          // A tap card too short to know its prompt by (or none) never starts.
          if (!window.started && window.needle !== null && promptCarriesDelivered(prompt, window.needle)) window.started = true
          else windows.delete(key)
        }
      } catch { failed(); windows.clear() }
    },
    take(chatId: string, assistantId: string, now: number): { by: string } | null {
      try {
        const key = windowKey(chatId, assistantId)
        if (key === null) return null
        const window = windows.get(key)
        // A write from before the tap (or a clock set back) is not what the owner approved: it leaves the window,
        // which still ends TEACH_WINDOW_MS after the tap on the monotonic clock.
        if (!window || !Number.isFinite(now) || now < window.at) return null
        windows.delete(key)
        // A write before the tap card's turn began is not that turn's.
        if (!window.started) return null
        if (expired(window, now)) return null
        return { by: window.by }
      } catch { failed(); return null }
    },
  }
}

export type TeachWindows = ReturnType<typeof createTeachWindows>

/** Where a tap is noted as its chat's delivery: closingTeachWindows' tracker. */
type TapDeliveries = { note(input: TurnChatNote): void; noteOwnTap(input: TurnChatNote): void }

/**
 * A tap reached the session (server.ts privateTapCardNoting, all six tap sites). The owner's own teach Approve opens a
 * window; any tap that is not the owner's own closes the window of its chat. The tap is also noted as its chat's
 * delivery, without text (a tap's words prove nothing about which session this daemon feeds), so the turn it starts
 * is filed under the tapped chat even when a peer message or a wake arrived just before. True for the owner's own
 * tap. Never throws.
 */
export function noteTeachTap(
  deps: { windows: Pick<TeachWindows, 'noteTap' | 'close'>; assistantId: string; deliveries?: TapDeliveries },
  t: Omit<TeachTap, 'assistantId'>,
): boolean {
  try {
    const own = ownPersonTap(t)
    if (!own) deps.windows.close(t.chatId, deps.assistantId)
    deps.windows.noteTap({ ...t, assistantId: deps.assistantId })
    if (deps.deliveries) {
      const delivery: TurnChatNote = { chatId: t.chatId, messageId: typeof t.messageId === 'number' && Number.isFinite(t.messageId) ? t.messageId : null, kind: 'user', now: t.now }
      if (own) deps.deliveries.noteOwnTap(delivery)
      else deps.deliveries.note(delivery)
    }
    return own
  } catch { failed(); return false }
}

/**
 * Every channel card as it reaches the session (server.ts, the card record step, after every hold): any card but the
 * owner's own tap card closes every teach window, whatever chat it names. A voice card, a mission notice or a card
 * held before the tap and released after it is not the write the owner approved, and the turn it starts may be filed
 * under the tapped chat. `ownTap` names the text of the owner's own tap card as it was built (the latest one only);
 * that text reaching the session once keeps the window.
 *
 * It also keeps when the last card went out, and when the last turn began (`prompt`, a UserPromptSubmit line's
 * receivedAt) and ended (`stopped`, a Stop line's): `idle` says no turn could overlap a window opened now. No hook
 * turn or helper agent is live, nothing is being typed into the pane, and every card sent has had a turn begin after
 * it and that turn has ended. A card the CLI still holds, queued behind a Stop, starts a turn no one has seen begin.
 * Never throws.
 */
export function createCardDeliveries(windows: Pick<TeachWindows, 'closeAll' | 'beginTurn'>, now: () => number = Date.now) {
  let ownTapCard: string | null = null
  let cardAt = -Infinity
  let promptAt = -Infinity
  let stopAt = -Infinity
  const at = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : now()
  return {
    ownTap(content: unknown): void {
      ownTapCard = typeof content === 'string' ? content : null
    },
    delivered(content: unknown): void {
      try {
        cardAt = now()
        if (ownTapCard !== null && content === ownTapCard) {
          ownTapCard = null
          return
        }
        windows.closeAll()
      } catch { failed(); try { windows.closeAll() } catch { /* nothing more to close */ } }
    },
    prompt(text: unknown, receivedAt?: unknown): void {
      try {
        promptAt = at(receivedAt)
        windows.beginTurn(text)
      } catch { failed(); try { windows.closeAll() } catch { /* nothing more to close */ } }
    },
    stopped(receivedAt?: unknown): void {
      try {
        stopAt = at(receivedAt)
        windows.closeAll()
      } catch { failed() }
    },
    idle(session: { turnLive: unknown; injecting: unknown }): boolean {
      try {
        return session.turnLive === false && session.injecting === false && promptAt >= cardAt && stopAt >= promptAt
      } catch { failed(); return false }
    },
  }
}

/**
 * The turn chat tracker, with every delivery it notes closing that chat's teach window: an email, a peer message, a
 * wake, a meeting or a typed message after the Approve is not the write the owner approved. `noteOwnTap` notes the
 * owner's own tap without closing it.
 */
export function closingTeachWindows<T extends { note(input: TurnChatNote): void }>(
  tracker: T, windows: Pick<TeachWindows, 'close'>, assistantId: string,
): T & { noteOwnTap(input: TurnChatNote): void } {
  const note = (input: TurnChatNote): void => tracker.note(input)
  return {
    ...tracker,
    note(input: TurnChatNote): void {
      try { windows.close(String(input?.chatId ?? '').trim(), assistantId) } catch { failed() }
      note(input)
    },
    noteOwnTap: note,
  }
}

type WriteFs = Pick<typeof import('node:fs'), 'lstatSync' | 'realpathSync'>

const DRIVE = /^[A-Za-z]:/

/** Equal real paths. On Windows a drive letter may differ in case alone; any other difference is no match. */
function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  if (a === b) return true
  return platform === 'win32' && DRIVE.test(a) && DRIVE.test(b) &&
    a[0]!.toLowerCase() === b[0]!.toLowerCase() && a.slice(1) === b.slice(1)
}

export function skillFolderOfWrite(filePath: unknown, agentDir: string | null, fs: WriteFs = { lstatSync, realpathSync }, platform: NodeJS.Platform = process.platform): string | null {
  try {
    if (typeof filePath !== 'string' || !agentDir || basename(filePath) !== 'SKILL.md') return null
    const folderPath = dirname(resolve(filePath))
    const folder = basename(folderPath)
    if (!SKILL_NAME_RE.test(folder)) return null
    const stat = fs.lstatSync(folderPath)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    const expected = join(fs.realpathSync(agentDir), '.claude', 'skills', folder)
    return samePath(fs.realpathSync(folderPath), expected, platform) ? folder : null
  } catch { failed(); return null }
}

/** A birth time the filesystem gave: left out, or a zero, is none. */
const known = (v: unknown): boolean => v !== undefined && v !== null && String(v) !== '0'

/**
 * A skill folder's identity for its mark, never following a link: its file number (dev:ino) and, where the filesystem
 * keeps one, its birth time in nanoseconds. A folder deleted and made again gets a new identity even where the file
 * number comes back (ext4), as long as it is made again after the filesystem's clock tick; on a filesystem with no
 * birth time a reused file number keeps the mark. Birth time is checked on Windows only (node and bun). On Linux
 * without statx node reads the change time as the birth time, which moves when a file is added or renamed inside: the
 * mark drops, never a wrong one. Null when either number is unknown by lib/file-numbers.mjs's rule (left out, zero,
 * all ones, or a plain number past 2^53), which on ReFS, a Dev Drive or a volume not known yet the file number always
 * is (identLook). Never throws.
 */
export function originIdentOf(path: string, fs: IdentFs = REAL_IDENT_FS): string | null {
  try {
    const st = identLook(path, false, fs) as { dev?: unknown; ino?: unknown; birthtimeNs?: unknown }
    if (!knownNumbers(st)) return null
    const base = `${String(st.dev)}:${String(st.ino)}`
    return known(st.birthtimeNs) ? `${base}:${String(st.birthtimeNs)}` : base
  } catch { return null }
}

export type OriginStamp = { origin: SkillOrigin; at: number; ident: string; offerId?: string }
export type Origins = { v: 1; skills: Record<string, OriginStamp> }
const empty = (): Origins => ({ v: 1, skills: {} })
const ORIGINS = new Set<SkillOrigin>(['taught', 'made', 'installed', 'shared', 'repo', 'synced'])

function stampOf(value: unknown): OriginStamp | null {
  const stamp = value as OriginStamp | null
  if (!stamp || typeof stamp !== 'object' || !ORIGINS.has(stamp.origin) || !Number.isFinite(stamp.at) ||
    typeof stamp.ident !== 'string' || !stamp.ident ||
    (stamp.offerId !== undefined && typeof stamp.offerId !== 'string')) return null
  return { origin: stamp.origin, at: stamp.at, ident: stamp.ident, ...(stamp.offerId !== undefined ? { offerId: stamp.offerId } : {}) }
}

/** Every entry under a skill name whose value is an object, as written: what a stamp keeps when it rewrites the file. */
function rawEntries(file: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (parsed?.v !== 1 || !parsed.skills || typeof parsed.skills !== 'object' || Array.isArray(parsed.skills)) throw new Error('invalid origins')
  for (const [folder, value] of Object.entries(parsed.skills)) {
    if (SKILL_NAME_RE.test(folder) && value !== null && typeof value === 'object' && !Array.isArray(value)) out[folder] = value
  }
  return out
}

/** The marks this build can read. One bad entry is skipped; only a file that is not a marks file at all reads empty. */
export function readOrigins(file: string): Origins {
  try {
    const out = empty()
    let skipped = false
    for (const [folder, value] of Object.entries(rawEntries(file))) {
      const stamp = stampOf(value)
      if (stamp) out.skills[folder] = stamp
      else skipped = true
    }
    if (skipped) failed()
    return out
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') failed()
    return empty()
  }
}

export function stampOrigin(file: string, folder: string, stamp: Omit<OriginStamp, 'at'>, now = Date.now()): void {
  let temp: string | undefined
  try {
    if (!SKILL_NAME_RE.test(folder) || !ORIGINS.has(stamp.origin) || !stamp.ident || !Number.isFinite(now)) return
    // Every other entry stays as written, a newer build's mark this build cannot read included (a downgrade). Only a
    // missing file starts empty: a file that cannot be read, or is not a v1 marks file, is never written over.
    let skills: Record<string, unknown>
    try { skills = rawEntries(file) } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') { failed(); return }
      skills = {}
    }
    skills[folder] = { origin: stamp.origin, at: now, ident: stamp.ident,
      ...(stamp.offerId !== undefined ? { offerId: stamp.offerId } : {}) }
    mkdirSync(dirname(file), { recursive: true })
    temp = `${file}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify({ v: 1, skills }), { flag: 'wx', mode: 0o600 })
    renameSync(temp, file)
    temp = undefined
  } catch { failed() } finally {
    if (temp) { try { unlinkSync(temp) } catch { /* no completed stamp */ } }
  }
}

/**
 * A Write the hook spool saw: stamps the skill taught when it is the immediate agent skill folder's SKILL.md, the
 * folder holds no stamp for its identity yet, and the owner's teach window for this chat and assistant was open when
 * the write happened (`writtenAt`, the hook line's receivedAt, never the drain time). A write with an unknown
 * identity still takes the window, so no later write inherits that approval. Never throws.
 */
export function stampTaughtWrite(input: {
  filePath: unknown
  agentDir: string | null
  file: string
  windows: Pick<TeachWindows, 'take'>
  chatId: string
  assistantId: string
  writtenAt: number
  identFs?: IdentFs
}): boolean {
  try {
    const folder = skillFolderOfWrite(input.filePath, input.agentDir)
    if (!folder || !input.agentDir) return false
    const ident = originIdentOf(join(input.agentDir, '.claude', 'skills', folder), input.identFs)
    // Any write into the skills folder uses the window, a stamped folder's or one of unknown identity included.
    const window = input.windows.take(input.chatId, input.assistantId, input.writtenAt)
    if (!window || ident === null) return false
    if (readOrigins(input.file).skills[folder]?.ident === ident) return false
    stampOrigin(input.file, folder, { origin: 'taught', ident })
    return true
  } catch { failed(); return false }
}

/** The file tools whose path the daemon can place: a Write of a SKILL.md is the only tool use that can mark. */
const PATH_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
/** Tools that write no file. Every other tool (a shell, NotebookEdit, a helper agent, any other MCP tool, one this
 *  build does not know) may write anywhere, so it closes every window. */
const WRITES_NO_FILE = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'ToolSearch',
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'Skill'])
/** This plugin's own MCP tools write no file, but boards_download, which saves one. */
const OWN_NO_FILE = new Set<string>(OWN_MCP_TOOLS.filter((name) => name !== 'boards_download'))
/** This plugin's MCP server by its exact names: `bgos` (the server's own name) and `plugin_hoai_bgos` (as the hoai plugin loads it). */
const OWN_TOOL = /^mcp__(?:bgos|plugin_hoai_bgos)__(.+)$/

function writesNoFile(toolName: string): boolean {
  const own = OWN_TOOL.exec(toolName)
  return own ? OWN_NO_FILE.has(own[1]!) : WRITES_NO_FILE.has(toolName)
}

/** Inside the agent's skills folder, by the launch folder's path or its real path, the target's real path included
 *  (a linked folder). Case blind on Windows. */
function inAgentSkills(filePath: string, agentDir: string, platform: NodeJS.Platform): boolean {
  const fold = (p: string): string => platform === 'win32' ? p.toLowerCase() : p
  const lexical = resolve(agentDir, filePath)
  const targets = [fold(lexical)]
  for (const at of [lexical, dirname(lexical)]) {
    try { targets.push(fold(realpathSync(at))); break } catch { /* not there: its folder, or the path alone */ }
  }
  const roots = [resolve(agentDir)]
  try { roots.push(realpathSync(agentDir)) } catch { /* the launch path alone */ }
  return roots.some((dir) => {
    const root = fold(join(dir, '.claude', 'skills'))
    return targets.some((target) => target === root || target.startsWith(root + sep))
  })
}

/**
 * A tool use the hook spool saw (PreToolUse, PostToolUse or PostToolUseFailure), judged at `writtenAt`, the hook
 * line's receivedAt. Fails closed: only a Write of an agent skill's SKILL.md that ran (PostToolUse) can mark, through
 * stampTaughtWrite. Any other Write, Edit or MultiEdit into the agent skills folder uses the window and marks nothing;
 * one outside it, or a tool that writes no file, leaves the window. Every other tool use (Bash or PowerShell whatever
 * the command, NotebookEdit, a helper agent, any MCP tool but this plugin's own, a tool this build does not know, a
 * file tool with no path) closes every window, at its first hook line. A blank mark is fine; a wrong one is not.
 * Never throws.
 */
export function noteSkillToolUse(input: {
  event?: unknown
  toolName: unknown
  toolInput: unknown
  agentDir: string | null
  file: string
  windows: Pick<TeachWindows, 'take' | 'closeAll'>
  chatId: string
  assistantId: string
  writtenAt: number
  identFs?: IdentFs
  platform?: NodeJS.Platform
}): boolean {
  try {
    const event = input.event ?? 'PostToolUse'
    const toolName = String(input.toolName ?? '')
    const args = input.toolInput !== null && typeof input.toolInput === 'object' ? input.toolInput as Record<string, unknown> : {}
    const path = args.file_path
    if (PATH_TOOLS.has(toolName) && typeof path === 'string' && path !== '') {
      // Judged once it ran: its PreToolUse keeps the window for the write itself.
      if (event === 'PreToolUse' || !input.agentDir) return false
      if (event === 'PostToolUse' && toolName === 'Write' && skillFolderOfWrite(path, input.agentDir) !== null) {
        return stampTaughtWrite({ ...input, filePath: path })
      }
      if (inAgentSkills(path, input.agentDir, input.platform ?? process.platform)) input.windows.take(input.chatId, input.assistantId, input.writtenAt)
      return false
    }
    if (!PATH_TOOLS.has(toolName) && writesNoFile(toolName)) return false
    input.windows.closeAll()
    return false
  } catch {
    failed()
    try { input.windows.closeAll() } catch { /* nothing more to close */ }
    return false
  }
}

export function originForRow(row: Pick<SkillItem, 'scope'>, stamp: OriginStamp | undefined, identNow: string | null): SkillOrigin | undefined {
  try {
    if (row.scope === 'plugin' || row.scope === 'managed') return 'installed'
    if (row.scope === 'repo') return 'repo'
    if (row.scope === 'synced') return 'synced'
    if (row.scope === 'agent' && identNow !== null && stamp?.ident === identNow) return stamp.origin
  } catch { failed() }
  return undefined
}

export function applyOrigins(list: SkillsList, file: string, fs?: IdentFs): SkillsList {
  try {
    const stamps = readOrigins(file)
    return { ...list, skills: list.skills.map((row) => {
      const path = row.path.startsWith('~/') || row.path.startsWith('~\\') ? join(homedir(), row.path.slice(2)) : row.path
      const origin = originForRow(row, stamps.skills[basename(path)], row.scope === 'agent' ? originIdentOf(path, fs) : null)
      return origin === undefined ? row : { ...row, origin }
    }) }
  } catch { failed(); return list }
}
