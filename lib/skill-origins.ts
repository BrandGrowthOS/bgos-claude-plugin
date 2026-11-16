import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { unescapeAgentButtonValue } from './message-text.ts'
import { identOf, SKILL_NAME_RE, type IdentFs, type SkillItem, type SkillsList } from './skills-inventory.ts'

export type SkillOrigin = 'taught' | 'made' | 'installed' | 'shared' | 'repo' | 'synced'
export const TEACH_APPROVE = 'teach_approve'
export const TEACH_WINDOW_MS = 15 * 60_000

function failed(): void {
  try { console.error('skills: origin unavailable') } catch { /* best effort */ }
}

type TeachTap = {
  chatId: string
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

/** The humanPrincipal field of a click's answer payload, raw (camelCase only), for noteTap to judge. */
export function clickHumanPrincipal(answerPayload: unknown): unknown {
  try {
    return answerPayload !== null && typeof answerPayload === 'object' ? (answerPayload as Record<string, unknown>).humanPrincipal : undefined
  } catch { failed(); return undefined }
}

function windowKey(chatId: unknown, assistantId: unknown): string | null {
  if (typeof chatId !== 'string' || !chatId || typeof assistantId !== 'string' || !assistantId) return null
  return JSON.stringify([assistantId, chatId])
}

export function createTeachWindows() {
  const windows = new Map<string, { by: string; at: number }>()
  return {
    noteTap(t: TeachTap): void {
      try {
        const key = windowKey(t.chatId, t.assistantId)
        // An owner id alone proves no person tapped: pairing and API key callers are stamped as the owner too.
        if (key === null || !Number.isFinite(t.now) || !t.posted || t.humanPrincipal !== true ||
          (t.customText != null && String(t.customText) !== '') ||
          typeof t.ownerUserId !== 'string' || !t.ownerUserId.trim() ||
          typeof t.tapperUserId !== 'string' || !t.tapperUserId.trim() ||
          t.tapperUserId !== t.ownerUserId ||
          typeof t.callbackData !== 'string' ||
          unescapeAgentButtonValue(t.callbackData) !== TEACH_APPROVE) return
        for (const [open, window] of windows) {
          if (t.now - window.at > TEACH_WINDOW_MS) windows.delete(open)
        }
        windows.set(key, { by: t.tapperUserId, at: t.now })
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

type WriteFs = Pick<typeof import('node:fs'), 'lstatSync' | 'realpathSync'>

export function skillFolderOfWrite(filePath: unknown, agentDir: string | null, fs: WriteFs = { lstatSync, realpathSync }): string | null {
  try {
    if (typeof filePath !== 'string' || !agentDir || basename(filePath) !== 'SKILL.md') return null
    const folderPath = dirname(resolve(filePath))
    const folder = basename(folderPath)
    if (!SKILL_NAME_RE.test(folder)) return null
    const stat = fs.lstatSync(folderPath)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    const expected = join(fs.realpathSync(agentDir), '.claude', 'skills', folder)
    return fs.realpathSync(folderPath) === expected ? folder : null
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
    // Every other entry stays as written, a newer build's mark this build cannot read included (a downgrade).
    let skills: Record<string, unknown> = {}
    try { skills = rawEntries(file) } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') failed()
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
    if (ident !== null && readOrigins(input.file).skills[folder]?.ident === ident) return false
    const window = input.windows.take(input.chatId, input.assistantId, input.writtenAt)
    if (!window || ident === null) return false
    stampOrigin(input.file, folder, { origin: 'taught', ident })
    return true
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
