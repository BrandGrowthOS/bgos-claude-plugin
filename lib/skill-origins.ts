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
  tapperUserId: unknown
  ownerUserId: unknown
  callbackData: unknown
  posted: unknown
  now: number
}

export function createTeachWindows() {
  const windows = new Map<string, { by: string; at: number }>()
  return {
    noteTap(t: TeachTap): void {
      try {
        if (!t.chatId || !Number.isFinite(t.now) || !t.posted ||
          typeof t.ownerUserId !== 'string' || !t.ownerUserId.trim() ||
          typeof t.tapperUserId !== 'string' || !t.tapperUserId.trim() ||
          t.tapperUserId !== t.ownerUserId ||
          typeof t.callbackData !== 'string' ||
          unescapeAgentButtonValue(t.callbackData) !== TEACH_APPROVE) return
        for (const [chat, window] of windows) {
          if (t.now - window.at > TEACH_WINDOW_MS) windows.delete(chat)
        }
        windows.set(t.chatId, { by: t.tapperUserId, at: t.now })
      } catch { failed() }
    },
    take(chatId: string, now: number): { by: string } | null {
      try {
        const window = windows.get(chatId)
        windows.delete(chatId)
        if (!window || !Number.isFinite(now) || now < window.at || now - window.at > TEACH_WINDOW_MS) return null
        return { by: window.by }
      } catch { failed(); return null }
    },
  }
}

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

export function readOrigins(file: string): Origins {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed?.v !== 1 || !parsed.skills || typeof parsed.skills !== 'object' || Array.isArray(parsed.skills)) throw new Error('invalid origins')
    const out = empty()
    for (const [folder, value] of Object.entries(parsed.skills)) {
      const stamp = value as OriginStamp | null
      if (!SKILL_NAME_RE.test(folder) || !stamp || !ORIGINS.has(stamp.origin) ||
        !Number.isFinite(stamp.at) || typeof stamp.ident !== 'string' || !stamp.ident ||
        (stamp.offerId !== undefined && typeof stamp.offerId !== 'string')) throw new Error('invalid origin')
      out.skills[folder] = { origin: stamp.origin, at: stamp.at, ident: stamp.ident,
        ...(stamp.offerId !== undefined ? { offerId: stamp.offerId } : {}) }
    }
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
    const out = readOrigins(file)
    out.skills[folder] = { origin: stamp.origin, at: now, ident: stamp.ident,
      ...(stamp.offerId !== undefined ? { offerId: stamp.offerId } : {}) }
    mkdirSync(dirname(file), { recursive: true })
    temp = `${file}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(out), { flag: 'wx', mode: 0o600 })
    renameSync(temp, file)
    temp = undefined
  } catch { failed() } finally {
    if (temp) { try { unlinkSync(temp) } catch { /* no completed stamp */ } }
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
      const origin = originForRow(row, stamps.skills[basename(path)], row.scope === 'agent' ? identOf(path, false, fs) : null)
      return origin === undefined ? row : { ...row, origin }
    }) }
  } catch { failed(); return list }
}
