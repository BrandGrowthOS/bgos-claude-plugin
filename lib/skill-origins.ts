import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { unescapeAgentButtonValue } from './message-text.ts'
import { identOf, SKILL_NAME_RE, type IdentFs, type SkillItem, type SkillsList } from './skills-inventory.ts'
import type { TurnChatNote } from './turn-chat.ts'

export type SkillOrigin = 'taught' | 'made' | 'installed' | 'shared' | 'repo' | 'synced'
export const TEACH_APPROVE = 'teach_approve'
export const TEACH_WINDOW_MS = 15 * 60_000

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
function ownPersonTap(t: Omit<TeachTap, 'chatId' | 'assistantId' | 'now'>): boolean {
  return !!t.posted && t.humanPrincipal === true &&
    !(t.customText != null && String(t.customText) !== '') &&
    typeof t.ownerUserId === 'string' && !!t.ownerUserId.trim() &&
    typeof t.tapperUserId === 'string' && !!t.tapperUserId.trim() &&
    t.tapperUserId === t.ownerUserId
}

export function createTeachWindows() {
  const windows = new Map<string, { by: string; at: number }>()
  return {
    noteTap(t: TeachTap): void {
      try {
        const key = windowKey(t.chatId, t.assistantId)
        if (key === null || !Number.isFinite(t.now) || !ownPersonTap(t) ||
          typeof t.callbackData !== 'string' ||
          unescapeAgentButtonValue(t.callbackData) !== TEACH_APPROVE) return
        for (const [open, window] of windows) {
          if (t.now - window.at > TEACH_WINDOW_MS) windows.delete(open)
        }
        windows.set(key, { by: String(t.tapperUserId), at: t.now })
      } catch { failed() }
    },
    /** A delivery in this chat that is not the owner's own tap: the window no longer means what the owner approved. */
    close(chatId: string, assistantId: string): void {
      try {
        const key = windowKey(chatId, assistantId)
        if (key !== null) windows.delete(key)
      } catch { failed() }
    },
    take(chatId: string, assistantId: string, now: number): { by: string } | null {
      try {
        const key = windowKey(chatId, assistantId)
        if (key === null) return null
        const window = windows.get(key)
        // A write from before the tap (or a clock set back) is not what the owner approved: it leaves the window.
        if (!window || !Number.isFinite(now) || now < window.at) return null
        windows.delete(key)
        if (now - window.at > TEACH_WINDOW_MS) return null
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
 * is filed under the tapped chat even when a peer message or a wake arrived just before. Never throws.
 */
export function noteTeachTap(
  deps: { windows: Pick<TeachWindows, 'noteTap' | 'close'>; assistantId: string; deliveries?: TapDeliveries },
  t: Omit<TeachTap, 'assistantId'>,
): void {
  try {
    const own = ownPersonTap(t)
    if (!own) deps.windows.close(t.chatId, deps.assistantId)
    deps.windows.noteTap({ ...t, assistantId: deps.assistantId })
    if (deps.deliveries) {
      const delivery: TurnChatNote = { chatId: t.chatId, messageId: typeof t.messageId === 'number' && Number.isFinite(t.messageId) ? t.messageId : null, kind: 'user', now: t.now }
      if (own) deps.deliveries.noteOwnTap(delivery)
      else deps.deliveries.note(delivery)
    }
  } catch { failed() }
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
    const ident = identOf(join(input.agentDir, '.claude', 'skills', folder), false, input.identFs)
    // Any write into the skills folder uses the window, a stamped folder's or one of unknown identity included.
    const window = input.windows.take(input.chatId, input.assistantId, input.writtenAt)
    if (!window || ident === null) return false
    if (readOrigins(input.file).skills[folder]?.ident === ident) return false
    stampOrigin(input.file, folder, { origin: 'taught', ident })
    return true
  } catch { failed(); return false }
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
/** A shell command that names a .claude skills folder, by any path. */
const SKILLS_IN_COMMAND = /\.claude[\\/]+skills(?![\w-])/i

/** Inside the agent's skills folder, by the launch folder's path or its real path. Case blind on Windows. */
function inAgentSkills(filePath: unknown, agentDir: string, platform: NodeJS.Platform): boolean {
  if (typeof filePath !== 'string' || !filePath) return false
  const fold = (p: string): string => platform === 'win32' ? p.toLowerCase() : p
  const target = fold(resolve(agentDir, filePath))
  const roots = [resolve(agentDir)]
  try { roots.push(realpathSync(agentDir)) } catch { /* the launch path alone */ }
  return roots.some((dir) => {
    const root = fold(join(dir, '.claude', 'skills'))
    return target === root || target.startsWith(root + sep)
  })
}

/**
 * A tool use the hook spool saw (PostToolUse), judged at `writtenAt`, the hook line's receivedAt. A Write of an agent
 * skill's SKILL.md goes to stampTaughtWrite. Any other write into the agent skills folder (Write, Edit, MultiEdit,
 * NotebookEdit, or a Bash command that names a .claude skills folder) uses the window and stamps nothing, so the
 * approval means the write the owner approved and nothing after it. Never throws.
 */
export function noteSkillToolUse(input: {
  toolName: unknown
  toolInput: unknown
  agentDir: string | null
  file: string
  windows: Pick<TeachWindows, 'take'>
  chatId: string
  assistantId: string
  writtenAt: number
  identFs?: IdentFs
  platform?: NodeJS.Platform
}): boolean {
  try {
    if (!input.agentDir) return false
    const args = input.toolInput !== null && typeof input.toolInput === 'object' ? input.toolInput as Record<string, unknown> : {}
    const path = input.toolName === 'NotebookEdit' ? args.notebook_path : args.file_path
    if (input.toolName === 'Write' && skillFolderOfWrite(path, input.agentDir) !== null) {
      return stampTaughtWrite({ ...input, filePath: path })
    }
    const touches = input.toolName === 'Bash'
      ? typeof args.command === 'string' && SKILLS_IN_COMMAND.test(args.command)
      : FILE_TOOLS.has(String(input.toolName)) && inAgentSkills(path, input.agentDir, input.platform ?? process.platform)
    if (touches) input.windows.take(input.chatId, input.assistantId, input.writtenAt)
    return false
  } catch { failed(); return false }
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
      const origin = originForRow(row, stamps.skills[basename(path)], row.scope === 'agent' ? identOf(path, false, fs) : null)
      return origin === undefined ? row : { ...row, origin }
    }) }
  } catch { failed(); return list }
}
