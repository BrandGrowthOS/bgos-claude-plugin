/**
 * This agent's Claude Code auto memory, as the owner's Memory screen sees it
 * (HOAI P7 stage 2, C-39). Pure over an injected fs; `nodeMemoryFs` at the end
 * is the real disk.
 *
 * WHERE IT LIVES. The CLI keeps one folder per project,
 * `<config dir>/projects/<key>/memory/`, with `MEMORY.md` as an index (one line
 * per memory) and one note file per memory. Only the INDEX reaches the model
 * at the start of a session; a note's body is read only when the model opens
 * it (measured, P7 stage 2 gate, measurement 2). So an entry here is one index
 * line, and the note file is where the full text is kept.
 *
 * WHICH FOLDER, and why this file refuses rather than guesses. The wrong folder
 * looks exactly like the right one: a write lands, the screen shows it, and the
 * agent never reads it. The CLI's own rule is followed per frame:
 *   - off when CLAUDE_CODE_DISABLE_AUTO_MEMORY is true, or when the first
 *     settings file that sets autoMemoryEnabled sets it false (local, then
 *     project, then user; the CLI's switch set false forces it on);
 *   - moved by the first settings file that sets autoMemoryDirectory, which
 *     must be a full path (or start with ~/);
 *   - else keyed by the git root of the agent folder (a worktree follows its
 *     commondir to the main repository, which is how the CLI shares memory
 *     across worktrees), every character that is not a letter or digit turned
 *     into a hyphen, and refused past 200 characters (the CLI changed that rule
 *     in 2.1.224 and the new one was not measured).
 * The CLI creates the folder at every session start, so a missing folder means
 * the answer is wrong or memory is not in use: it is refused and NOTHING is
 * created. The config dir is the one the daemon was given, never ~/.claude.
 *
 * WRITES. The model and the CLI's background extractor write the same folder.
 * Every file goes through a temp file and a rename; the index is read again
 * right before it is replaced and, if it moved, the write starts over once and
 * then answers store_busy. A note is written before the line that points at it,
 * and a line is removed before its note, so no line ever points at a note that
 * is not there.
 *
 * UNDO. There is no native undo, so whatever a write takes away goes into a
 * trash OUTSIDE the memory folder (the CLI would read anything inside it). An
 * add whose words match a trash record puts the note and its line back where
 * they were; failing that, a note this store listed earlier in this process
 * (the "remembered entries") comes back whole, which is how an Undo restores
 * what the agent removed on its own.
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'

export type MemoryTarget = 'memory' | 'user'

/** The disk surface the store needs (test/helpers/memory-fs.ts implements it in memory). */
export type MemoryFs = {
  exists: (path: string) => boolean
  /** The file's text, or null when it is not there. */
  readFile: (path: string) => string | null
  writeFile: (path: string, text: string) => void
  rename: (from: string, to: string) => void
  rm: (path: string) => void
  /** Names directly inside a folder, or [] when it is not there. */
  listDir: (path: string) => string[]
  stat: (path: string) => { mtimeMs: number; isDirectory: boolean } | null
  /** Recursive. Used for the trash only: the memory folder is never created. */
  mkdir: (path: string) => void
}

export type MemoryErrorCode =
  | 'bad_request'
  | 'unavailable'
  | 'memory_off'
  | 'no_match'
  | 'ambiguous'
  | 'over_budget'
  | 'store_busy'
  | 'write_failed'

export type MemoryFailure = { ok: false; code: MemoryErrorCode; message: string }
export type MemoryFolderAnswer = { ok: true; memDir: string } | MemoryFailure

export type MemoryEntryView = { text: string; flagged: false; patterns: string[] }
export type MemoryStoreView = { entries: MemoryEntryView[]; chars: number; limit: number }
export type MemoryStores = { memory: MemoryStoreView; user: MemoryStoreView }
export type MemoryAnswer = { ok: true; stores: MemoryStores } | MemoryFailure

export type ClaudeMemoryStore = {
  list: () => MemoryAnswer
  add: (target: MemoryTarget, content: string) => MemoryAnswer
  replace: (target: MemoryTarget, oldText: string, newContent: string) => MemoryAnswer
  remove: (target: MemoryTarget, oldText: string) => MemoryAnswer
}

export const MEMORY_INDEX_FILE = 'MEMORY.md'
/** The CLI truncates the index at 200 lines and 25 KB when it loads it. */
export const MEMORY_INDEX_MAX_LINES = 200
export const MEMORY_INDEX_MAX_BYTES = 25_000
export const MEMORY_KEY_MAX = 200
export const MEMORY_HOOK_MAX = 300
export const MEMORY_TRASH_KEEP = 50
export const MEMORY_REMEMBER_MAX = 256
const SLUG_MAX = 48
const TEMP_SUFFIX = '.bgos-tmp'

const MSG = {
  off: 'auto memory is turned off for this agent',
  notFullPath: 'the memory folder setting is not a full path',
  tooLong: 'the agent folder path is too long to find its memory',
  noFolder: 'no memory folder found for this agent',
  blank: 'the text is missing',
  noMatch: 'no memory entry matches that text exactly',
  ambiguous: 'more than one memory entry matches that text',
  full: 'the memory index is full',
  busy: 'the memory index changed while saving, try again',
  writeFailed: 'could not save the memory files',
} as const

function fail(code: MemoryErrorCode, message: string): MemoryFailure {
  return { ok: false, code, message }
}

// ── Paths (separator aware, so a Windows host joins with its own) ───────────

function sepOf(p: string): '/' | '\\' {
  return p.includes('\\') && !p.includes('/') ? '\\' : '/'
}

function joinPath(base: string, ...parts: string[]): string {
  const sep = sepOf(base)
  let out = base
  for (const raw of parts) {
    const part = raw.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')
    if (!part) continue
    out = /[\\/]$/.test(out) ? out + part : out + sep + part
  }
  return out
}

function stripTrailing(p: string): string {
  const t = p.replace(/[\\/]+$/, '')
  if (t === '') return p ? p.slice(0, 1) : p
  return /^[A-Za-z]:$/.test(t) ? t + (p[2] ?? '\\') : t
}

function parentDir(p: string): string | null {
  const t = p.replace(/[\\/]+$/, '')
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'))
  if (i < 0) return null
  const head = t.slice(0, i)
  if (head === '') return t[i]
  if (/^[A-Za-z]:$/.test(head)) return head + t[i]
  return head
}

function isAbsolutePath(p: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(p)
}

function normalizePath(p: string): string {
  const sep = sepOf(p)
  const drive = /^[A-Za-z]:/.test(p) ? p.slice(0, 2) : ''
  const rest = p.slice(drive.length)
  const rooted = /^[\\/]/.test(rest)
  const out: string[] = []
  for (const seg of rest.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!rooted) out.push('..')
      continue
    }
    out.push(seg)
  }
  return drive + (rooted ? sep : '') + out.join(sep)
}

function resolveFrom(base: string, target: string): string {
  return isAbsolutePath(target) ? normalizePath(target) : normalizePath(joinPath(base, target))
}

// ── Which folder ─────────────────────────────────────────────────────────────

/** The CLI's project key: every character that is not a letter or digit becomes a hyphen. */
export function mungeMemoryKey(root: string): string {
  return String(root ?? '').replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * The repository the CLI keys memory by: the nearest folder holding `.git`. A
 * `.git` FILE is a worktree (or a submodule): its gitdir's `commondir` names
 * the main repository's git folder, whose parent is the main repository. With
 * no commondir (a submodule) the folder holding the file is the root. No `.git`
 * anywhere: the agent folder itself.
 */
function gitRootOf(fs: MemoryFs, start: string): string {
  const origin = stripTrailing(start)
  let dir = origin
  for (let depth = 0; depth < 256; depth += 1) {
    const dotGit = joinPath(dir, '.git')
    const found = fs.stat(dotGit)
    if (found) {
      if (found.isDirectory) return dir
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFile(dotGit) ?? '')
      if (!pointer) return dir
      const gitDir = resolveFrom(dir, pointer[1])
      const common = (fs.readFile(joinPath(gitDir, 'commondir')) ?? '').trim()
      if (!common) return dir
      return parentDir(resolveFrom(gitDir, common)) ?? dir
    }
    const up = parentDir(dir)
    if (!up || up === dir) break
    dir = up
  }
  return origin
}

function readSettings(fs: MemoryFs, path: string): Record<string, unknown> | null {
  const text = fs.readFile(path)
  if (text == null) return null
  try {
    const parsed = JSON.parse(text.replace(/^﻿/, ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** true, false, or null when the variable says neither (the CLI's reading of a switch). */
function envSwitch(value: string | undefined): boolean | null {
  const v = String(value ?? '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'off'].includes(v)) return false
  return null
}

export function resolveMemoryFolder(input: {
  fs: MemoryFs
  agentDir: string
  configDir: string
  home: string
  env: Record<string, string | undefined>
}): MemoryFolderAnswer {
  const { fs } = input
  const agentDir = String(input.agentDir ?? '').trim()
  const configDir = String(input.configDir ?? '').trim()
  const home = String(input.home ?? '').trim()
  if (!agentDir || !configDir) return fail('unavailable', MSG.noFolder)

  // The CLI's precedence: local project settings, then project, then user.
  const settings = [
    readSettings(fs, joinPath(agentDir, '.claude', 'settings.local.json')),
    readSettings(fs, joinPath(agentDir, '.claude', 'settings.json')),
    readSettings(fs, joinPath(configDir, 'settings.json')),
  ]
  const first = (key: string, ok: (v: unknown) => boolean): unknown => {
    for (const s of settings) if (s && ok(s[key])) return s[key]
    return undefined
  }

  const disable = envSwitch(input.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY)
  if (disable === true) return fail('memory_off', MSG.off)
  if (disable === null && first('autoMemoryEnabled', (v) => typeof v === 'boolean') === false) {
    return fail('memory_off', MSG.off)
  }

  let memDir: string
  const moved = first('autoMemoryDirectory', (v) => typeof v === 'string' && v.trim() !== '')
  if (typeof moved === 'string') {
    const setting = moved.trim()
    if (setting.startsWith('~/') && home) memDir = joinPath(home, setting.slice(2))
    else if (isAbsolutePath(setting)) memDir = setting
    else return fail('unavailable', MSG.notFullPath)
  } else {
    const key = mungeMemoryKey(gitRootOf(fs, agentDir))
    if (key.length > MEMORY_KEY_MAX) return fail('unavailable', MSG.tooLong)
    memDir = joinPath(configDir, 'projects', key, 'memory')
  }
  memDir = stripTrailing(memDir)
  if (fs.stat(memDir)?.isDirectory !== true) return fail('unavailable', MSG.noFolder)
  return { ok: true, memDir }
}

// ── What an entry is ─────────────────────────────────────────────────────────

export type MemoryIndexLine = { title: string; fileName: string; hook: string; text: string }

const INDEX_LINE = /^\s*-\s*\[([^\]]*)\]\(([^)]*)\)\s*(?:[-:\u2013\u2014]\s*)?(.*)$/

function isNoteName(name: string): boolean {
  return (
    /^[^\\/]+\.md$/i.test(name) &&
    !name.includes('..') &&
    name.toLowerCase() !== MEMORY_INDEX_FILE.toLowerCase()
  )
}

/**
 * One index line, or null when it is not an entry. The CLI writes an em dash
 * between the link and the hook, this store a hyphen; both parse. The text of
 * an entry is its hook, or its title when the hook is empty. A link that is not
 * a plain note name inside the folder is not an entry.
 */
export function parseMemoryIndexLine(line: string): MemoryIndexLine | null {
  const m = INDEX_LINE.exec(String(line ?? '').replace(/\r$/, ''))
  if (!m) return null
  const fileName = m[2].trim()
  if (!isNoteName(fileName)) return null
  const title = m[1].trim()
  const hook = m[3].trim()
  const text = hook || title
  if (!text) return null
  return { title, fileName, hook, text }
}

function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}

/** A note's frontmatter lines and where its body starts, or null when it has none. */
function frontmatterOf(content: string): { lines: string[]; bodyAt: number } | null {
  const lines = content.replace(/^﻿/, '').split('\n')
  if (lines[0]?.replace(/\r$/, '').trim() !== '---') return null
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].replace(/\r$/, '').trim() === '---') {
      return { lines: lines.slice(1, i).map((l) => l.replace(/\r$/, '')), bodyAt: i + 1 }
    }
  }
  return null
}

/** `metadata.type` (nested block or inline map), else a top level `type:`. */
function noteTypeOf(content: string | null): string | null {
  if (content == null) return null
  const fm = frontmatterOf(content)
  if (!fm) return null
  let inMeta = false
  let metaType: string | null = null
  let topType: string | null = null
  for (const line of fm.lines) {
    if (/^\S/.test(line)) {
      inMeta = false
      const meta = /^metadata\s*:\s*(.*)$/.exec(line)
      if (meta) {
        const rest = meta[1].trim()
        if (rest === '') inMeta = true
        else if (rest.startsWith('{')) {
          const t = /(?:^|[{,])\s*type\s*:\s*([^,}]*)/.exec(rest)
          if (t) metaType = unquote(t[1])
        }
        continue
      }
      const top = /^type\s*:\s*(.*)$/.exec(line)
      if (top) topType = unquote(top[1])
    } else if (inMeta) {
      const t = /^\s+type\s*:\s*(.*)$/.exec(line)
      if (t) metaType = unquote(t[1])
    }
  }
  return metaType ?? topType
}

function storeOfNote(content: string | null): MemoryTarget {
  return (noteTypeOf(content) ?? '').toLowerCase() === 'user' ? 'user' : 'memory'
}

// ── The index as lines ───────────────────────────────────────────────────────

type IndexDoc = { lines: string[]; eol: string; trailing: boolean }

function parseIndex(text: string | null): IndexDoc {
  const raw = text ?? ''
  if (raw === '') return { lines: [], eol: '\n', trailing: false }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const trailing = raw.endsWith('\n')
  const body = trailing ? raw.replace(/\r?\n$/, '') : raw
  return { lines: body.split(/\r?\n/), eol, trailing }
}

function serializeIndex(doc: IndexDoc): string {
  if (doc.lines.length === 0) return ''
  return doc.lines.join(doc.eol) + (doc.trailing ? doc.eol : '')
}

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length
}

function overBudget(text: string): boolean {
  return parseIndex(text).lines.length > MEMORY_INDEX_MAX_LINES || bytesOf(text) > MEMORY_INDEX_MAX_BYTES
}

// ── Words ────────────────────────────────────────────────────────────────────

/** The one line the model reads: white space folded, cut at a word to 300 with "...". */
export function memoryHookOf(content: string): string {
  const folded = String(content ?? '').replace(/\s+/g, ' ').trim()
  if (folded.length <= MEMORY_HOOK_MAX) return folded
  const room = MEMORY_HOOK_MAX - 3
  let cut = folded.slice(0, room)
  if (folded[room] !== ' ') {
    const space = cut.lastIndexOf(' ')
    if (space >= room / 2) cut = cut.slice(0, space)
  }
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  return cut.trimEnd() + '...'
}

function slugOf(hook: string): string {
  let slug = ''
  for (const word of hook.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const next = slug ? `${slug}-${word}` : word.slice(0, SLUG_MAX)
    if (next.length > SLUG_MAX) break
    slug = next
  }
  return slug || `memory-${createHash('sha256').update(hook).digest('hex').slice(0, 8)}`
}

function titleOf(hook: string, slug: string): string {
  const title = hook.split(' ').slice(0, 6).join(' ').replace(/[[\]]/g, '').trim()
  return title || slug
}

function lineFor(title: string, fileName: string, hook: string): string {
  return `- [${title}](${fileName}) - ${hook}`
}

function bodyOf(content: string): string {
  return String(content ?? '').replace(/\r\n/g, '\n').trim()
}

function freshNote(input: { name: string; hook: string; type: string; iso: string; body: string }): string {
  return [
    '---',
    `name: ${input.name}`,
    `description: ${JSON.stringify(input.hook)}`,
    'metadata:',
    '  node_type: memory',
    `  type: ${input.type}`,
    `  modified: ${input.iso}`,
    '---',
    '',
    input.body,
    '',
  ].join('\n')
}

/**
 * The same note with a new description, a new `modified` and a new body. Every
 * other frontmatter line (the CLI's node_type, originSessionId, the type) is
 * kept as it was.
 */
function rewrittenNote(
  content: string | null,
  input: { name: string; hook: string; type: string; iso: string; body: string },
): string {
  const fm = content == null ? null : frontmatterOf(content)
  if (!fm) return freshNote(input)
  const description = `description: ${JSON.stringify(input.hook)}`
  const out: string[] = []
  let described = false
  let modified = false
  let inMeta = false
  let metaEnd = -1
  let skipping = false
  for (const line of fm.lines) {
    const topLevel = /^\S/.test(line)
    // The indented lines of a folded or literal description belong to the old words.
    if (skipping && !topLevel) continue
    skipping = false
    if (topLevel && inMeta) {
      inMeta = false
      metaEnd = out.length
    }
    if (/^description\s*:/.test(line)) {
      out.push(description)
      described = true
      skipping = /^description\s*:\s*([>|].*)?$/.test(line)
      continue
    }
    if (topLevel) {
      const meta = /^metadata\s*:\s*(.*)$/.exec(line)
      const rest = meta ? meta[1].trim() : ''
      if (meta && rest === '') {
        inMeta = true
        out.push(line)
        continue
      }
      if (meta && rest.startsWith('{')) {
        const stamp = /(^\{|,)\s*modified\s*:\s*[^,}]*/
        out.push(
          `metadata: ${
            stamp.test(rest)
              ? rest.replace(stamp, `$1 modified: ${input.iso}`)
              : rest.replace(/\}\s*$/, `, modified: ${input.iso}}`)
          }`,
        )
        modified = true
        continue
      }
      if (/^modified\s*:/.test(line)) {
        out.push(`modified: ${input.iso}`)
        modified = true
        continue
      }
      out.push(line)
      continue
    }
    if (inMeta && /^\s+modified\s*:/.test(line)) {
      out.push(line.replace(/^(\s+modified\s*:).*$/, `$1 ${input.iso}`))
      modified = true
      continue
    }
    out.push(line)
  }
  if (inMeta) metaEnd = out.length
  if (!modified) {
    if (metaEnd >= 0) out.splice(metaEnd, 0, `  modified: ${input.iso}`)
    else out.push('metadata:', `  modified: ${input.iso}`)
  }
  if (!described) out.splice(out.findIndex((l) => /^name\s*:/.test(l)) + 1, 0, description)
  return ['---', ...out, '---', '', input.body, ''].join('\n')
}

// ── The store ────────────────────────────────────────────────────────────────

type Entry = {
  store: MemoryTarget
  text: string
  title: string
  line: string
  position: number
  fileName: string
  fileContent: string | null
}

type TrashLine = { text: string; position: number }

type TrashRecord = {
  at: string
  op: 'remove' | 'replace'
  target: MemoryTarget
  text: string
  fileName: string
  fileContent: string | null
  lines: TrashLine[]
}

/** Something to bring back: a trash record, or a note this store listed earlier. */
type Restorable = {
  fileName: string
  fileContent: string | null
  lines: TrashLine[]
  trashName: string | null
}

type FileWrite = { name: string; content: string; previous: string | null }

type Plan =
  | MemoryFailure
  | { ok: true; noop: true }
  | {
      ok: true
      noop?: false
      trash: TrashRecord | null
      files: FileWrite[]
      index: string
      removeFiles: string[]
      used: string | null
    }

function isTrashRecord(value: unknown): value is TrashRecord {
  const r = value as TrashRecord
  return (
    !!r &&
    typeof r === 'object' &&
    (r.target === 'memory' || r.target === 'user') &&
    typeof r.text === 'string' &&
    typeof r.fileName === 'string' &&
    isNoteName(r.fileName) &&
    (r.fileContent === null || typeof r.fileContent === 'string') &&
    Array.isArray(r.lines) &&
    r.lines.every((l) => l && typeof l.text === 'string' && Number.isInteger(l.position))
  )
}

export function createClaudeMemoryStore(deps: {
  fs: MemoryFs
  /** Which folder, asked per call and never cached: the agent may have moved it. */
  resolve: () => MemoryFolderAnswer
  /** Where removed and replaced notes are kept for an Undo. OUTSIDE the memory folder. */
  trashDir: string
  now: () => number
}): ClaudeMemoryStore {
  const { fs } = deps
  /** Every listed entry, newest last in insertion order, keyed by store and text. */
  const remembered = new Map<string, Entry>()
  let trashSeq = 0

  const indexPathOf = (memDir: string) => joinPath(memDir, MEMORY_INDEX_FILE)
  const tempFor = (dir: string, name: string) => joinPath(dir, `.${name}${TEMP_SUFFIX}`)
  const isoNow = () => new Date(deps.now()).toISOString()

  function entriesOf(memDir: string, doc: IndexDoc): Entry[] {
    const out: Entry[] = []
    doc.lines.forEach((raw, position) => {
      const parsed = parseMemoryIndexLine(raw)
      if (!parsed) return
      const fileContent = fs.readFile(joinPath(memDir, parsed.fileName))
      out.push({
        store: storeOfNote(fileContent),
        text: parsed.text,
        title: parsed.title,
        line: raw.replace(/\r$/, ''),
        position,
        fileName: parsed.fileName,
        fileContent,
      })
    })
    return out
  }

  function remember(entries: Entry[]): void {
    for (const entry of entries) {
      if (entry.fileContent == null) continue
      const key = `${entry.store}\u0000${entry.text}`
      remembered.delete(key)
      remembered.set(key, entry)
    }
    while (remembered.size > MEMORY_REMEMBER_MAX) {
      const oldest = remembered.keys().next().value
      if (oldest === undefined) break
      remembered.delete(oldest)
    }
  }

  function viewOf(entries: Entry[], store: MemoryTarget): MemoryStoreView {
    const mine = entries.filter((e) => e.store === store)
    return {
      entries: mine.map((e) => ({ text: e.text, flagged: false as const, patterns: [] })),
      chars: mine.map((e) => e.line).join('\n').length,
      limit: MEMORY_INDEX_MAX_BYTES,
    }
  }

  function answerFor(memDir: string): MemoryAnswer {
    const entries = entriesOf(memDir, parseIndex(fs.readFile(indexPathOf(memDir))))
    remember(entries)
    return { ok: true, stores: { memory: viewOf(entries, 'memory'), user: viewOf(entries, 'user') } }
  }

  // ── The trash ──

  function readTrash(): Array<{ name: string; record: TrashRecord }> {
    const out: Array<{ name: string; record: TrashRecord }> = []
    const names = fs
      .listDir(deps.trashDir)
      .filter((n) => n.endsWith('.json'))
      .sort()
      .reverse()
    for (const name of names) {
      try {
        const record = JSON.parse(fs.readFile(joinPath(deps.trashDir, name)) ?? '')
        if (isTrashRecord(record)) out.push({ name, record })
      } catch {
        // A record that does not parse is not a record.
      }
    }
    return out
  }

  function writeTrash(record: TrashRecord): string {
    fs.mkdir(deps.trashDir)
    let name = ''
    do {
      trashSeq += 1
      name = `${String(deps.now()).padStart(15, '0')}-${String(trashSeq).padStart(6, '0')}.json`
    } while (fs.exists(joinPath(deps.trashDir, name)))
    fs.writeFile(joinPath(deps.trashDir, name), JSON.stringify(record, null, 1))
    const all = fs
      .listDir(deps.trashDir)
      .filter((n) => n.endsWith('.json'))
      .sort()
    for (const old of all.slice(0, Math.max(0, all.length - MEMORY_TRASH_KEEP))) {
      try {
        fs.rm(joinPath(deps.trashDir, old))
      } catch {
        // A record that cannot be pruned is only a little extra disk.
      }
    }
    return name
  }

  function dropTrash(name: string | null): void {
    if (!name) return
    try {
      fs.rm(joinPath(deps.trashDir, name))
    } catch {
      // Best effort: a stale record can only restore what it saved.
    }
  }

  /** A trash record with these words in this store, newest first; else a remembered note. */
  function restorableFor(target: MemoryTarget, text: string): Restorable | null {
    const hit = readTrash().find((t) => t.record.target === target && t.record.text === text)
    if (hit) {
      return {
        fileName: hit.record.fileName,
        fileContent: hit.record.fileContent,
        lines: hit.record.lines,
        trashName: hit.name,
      }
    }
    const seen = remembered.get(`${target}\u0000${text}`)
    if (seen && seen.fileContent != null) {
      return {
        fileName: seen.fileName,
        fileContent: seen.fileContent,
        lines: [{ text: seen.line, position: seen.position }],
        trashName: null,
      }
    }
    return null
  }

  function freeName(memDir: string, base: string, taken: Set<string>): string {
    for (let n = 1; n <= 10_000; n += 1) {
      const name = n === 1 ? `${base}.md` : `${base}-${n}.md`
      if (!isNoteName(name) || taken.has(name.toLowerCase())) continue
      if (!fs.exists(joinPath(memDir, name))) return name
    }
    throw new Error('no free note name')
  }

  // ── Writing ──

  function writeAtomic(dir: string, name: string, content: string): void {
    const temp = tempFor(dir, name)
    fs.writeFile(temp, content)
    try {
      fs.rename(temp, joinPath(dir, name))
    } catch (err) {
      try {
        fs.rm(temp)
      } catch {
        // Nothing more to take back.
      }
      throw err
    }
  }

  /** Puts back what a lost or failed write changed, best effort. */
  function rollBack(memDir: string, done: FileWrite[], trashName: string | null): void {
    for (const file of [...done].reverse()) {
      try {
        if (file.previous == null) fs.rm(joinPath(memDir, file.name))
        else writeAtomic(memDir, file.name, file.previous)
      } catch {
        // Best effort.
      }
    }
    dropTrash(trashName)
  }

  function write(build: (memDir: string, doc: IndexDoc, entries: Entry[]) => Plan): MemoryAnswer {
    const where = deps.resolve()
    if (!where.ok) return where
    const memDir = where.memDir
    const indexPath = indexPathOf(memDir)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = fs.readFile(indexPath)
      const doc = parseIndex(before)
      const plan = build(memDir, doc, entriesOf(memDir, doc))
      if (!plan.ok) return plan
      if (plan.noop) return answerFor(memDir)
      const done: FileWrite[] = []
      let trashName: string | null = null
      try {
        if (plan.trash) trashName = writeTrash(plan.trash)
        // Notes first, so no line ever points at a note that is not there yet.
        for (const file of plan.files) {
          writeAtomic(memDir, file.name, file.content)
          done.push(file)
        }
        const temp = tempFor(memDir, MEMORY_INDEX_FILE)
        fs.writeFile(temp, plan.index)
        // Another writer may have changed the index since it was read: never overwrite that.
        if (fs.readFile(indexPath) !== before) {
          try {
            fs.rm(temp)
          } catch {
            // The next attempt writes it again.
          }
          rollBack(memDir, done, trashName)
          continue
        }
        try {
          fs.rename(temp, indexPath)
        } catch (err) {
          try {
            fs.rm(temp)
          } catch {
            // Nothing more to take back.
          }
          throw err
        }
      } catch {
        rollBack(memDir, done, trashName)
        return fail('write_failed', MSG.writeFailed)
      }
      // The line is gone, so its note can go: a failure here leaves an unlisted note, never a broken line.
      for (const name of plan.removeFiles) {
        try {
          fs.rm(joinPath(memDir, name))
        } catch {
          // An orphan note is not an entry.
        }
      }
      dropTrash(plan.used)
      return answerFor(memDir)
    }
    return fail('store_busy', MSG.busy)
  }

  function matchOne(entries: Entry[], target: MemoryTarget, oldText: string): Entry | MemoryFailure {
    const want = String(oldText ?? '').trim()
    const matches = entries.filter((e) => e.store === target && e.text === want)
    if (matches.length === 0) return fail('no_match', MSG.noMatch)
    if (matches.length > 1) return fail('ambiguous', MSG.ambiguous)
    return matches[0]
  }

  /** Inserts lines at their old positions (clamped), in order, into a copy of the index. */
  function withLines(doc: IndexDoc, lines: TrashLine[], relink: (text: string) => string): IndexDoc {
    const next = [...doc.lines]
    for (const line of [...lines].sort((a, b) => a.position - b.position)) {
      const at = Math.min(Math.max(0, line.position), next.length)
      next.splice(at, 0, relink(line.text))
    }
    return { ...doc, lines: next, trailing: true }
  }

  function add(target: MemoryTarget, content: string): MemoryAnswer {
    const hook = memoryHookOf(content)
    if (!hook) return fail('bad_request', MSG.blank)
    return write((memDir, doc, entries) => {
      if (entries.some((e) => e.store === target && e.text === hook)) return { ok: true, noop: true }
      const source = restorableFor(target, hook)
      const taken = new Set(entries.map((e) => e.fileName.toLowerCase()))
      let files: FileWrite[] = []
      let next: IndexDoc
      if (source) {
        let fileName = source.fileName
        if (source.fileContent != null) {
          const existing = fs.readFile(joinPath(memDir, fileName))
          if (existing == null) files = [{ name: fileName, content: source.fileContent, previous: null }]
          else if (existing !== source.fileContent) {
            fileName = freeName(memDir, fileName.replace(/\.md$/i, ''), taken)
            files = [{ name: fileName, content: source.fileContent, previous: null }]
          }
        }
        const from = `](${source.fileName})`
        next = withLines(doc, source.lines, (text) =>
          fileName === source.fileName ? text : text.split(from).join(`](${fileName})`),
        )
      } else {
        const slug = slugOf(hook)
        const fileName = freeName(memDir, slug, taken)
        files = [
          {
            name: fileName,
            content: freshNote({
              name: fileName.replace(/\.md$/i, ''),
              hook,
              type: target === 'user' ? 'user' : 'feedback',
              iso: isoNow(),
              body: bodyOf(content),
            }),
            previous: null,
          },
        ]
        next = { ...doc, lines: [...doc.lines, lineFor(titleOf(hook, slug), fileName, hook)], trailing: true }
      }
      const index = serializeIndex(next)
      if (overBudget(index)) return fail('over_budget', MSG.full)
      return { ok: true, trash: null, files, index, removeFiles: [], used: source?.trashName ?? null }
    })
  }

  function replace(target: MemoryTarget, oldText: string, newContent: string): MemoryAnswer {
    const hook = memoryHookOf(newContent)
    if (!hook) return fail('bad_request', MSG.blank)
    return write((memDir, doc, entries) => {
      const entry = matchOne(entries, target, oldText)
      if ('ok' in entry) return entry
      // An Undo of a correction brings the old note back whole, not only its words.
      const source = hook === entry.text ? null : restorableFor(target, hook)
      const content =
        source?.fileContent ??
        rewrittenNote(entry.fileContent, {
          name: entry.fileName.replace(/\.md$/i, ''),
          hook,
          type: target === 'user' ? 'user' : 'feedback',
          iso: isoNow(),
          body: bodyOf(newContent),
        })
      const lines = [...doc.lines]
      lines[entry.position] = lineFor(entry.title || titleOf(hook, slugOf(hook)), entry.fileName, hook)
      const index = serializeIndex({ ...doc, lines })
      if (overBudget(index) && bytesOf(index) > bytesOf(serializeIndex(doc))) return fail('over_budget', MSG.full)
      return {
        ok: true,
        trash: {
          at: isoNow(),
          op: 'replace',
          target,
          text: entry.text,
          fileName: entry.fileName,
          fileContent: entry.fileContent,
          lines: [{ text: entry.line, position: entry.position }],
        },
        files: [{ name: entry.fileName, content, previous: entry.fileContent }],
        index,
        removeFiles: [],
        used: source?.trashName ?? null,
      }
    })
  }

  function remove(target: MemoryTarget, oldText: string): MemoryAnswer {
    return write((_memDir, doc, entries) => {
      const entry = matchOne(entries, target, oldText)
      if ('ok' in entry) return entry
      const kept: string[] = []
      const gone: TrashLine[] = []
      doc.lines.forEach((raw, position) => {
        if (parseMemoryIndexLine(raw)?.fileName === entry.fileName) {
          gone.push({ text: raw.replace(/\r$/, ''), position })
        } else kept.push(raw)
      })
      return {
        ok: true,
        trash: {
          at: isoNow(),
          op: 'remove',
          target,
          text: entry.text,
          fileName: entry.fileName,
          fileContent: entry.fileContent,
          lines: gone,
        },
        files: [],
        index: serializeIndex({ ...doc, lines: kept }),
        removeFiles: entry.fileContent == null ? [] : [entry.fileName],
        used: null,
      }
    })
  }

  return {
    list: () => {
      const where = deps.resolve()
      return where.ok ? answerFor(where.memDir) : where
    },
    add,
    replace,
    remove,
  }
}

// ── The real disk ────────────────────────────────────────────────────────────

function codeOf(err: unknown): string {
  return (err as { code?: string })?.code ?? ''
}

export const nodeMemoryFs: MemoryFs = {
  exists: (path) => existsSync(path),
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch (err) {
      // Absent reads as null. Anything else (no permission) is thrown, so an
      // unreadable index is never shown as an empty memory.
      if (codeOf(err) === 'ENOENT' || codeOf(err) === 'ENOTDIR') return null
      throw err
    }
  },
  writeFile: (path, text) => writeFileSync(path, text, 'utf8'),
  rename: (from, to) => renameSync(from, to),
  rm: (path) => rmSync(path, { force: true }),
  listDir: (path) => {
    try {
      return readdirSync(path)
    } catch (err) {
      if (codeOf(err) === 'ENOENT' || codeOf(err) === 'ENOTDIR') return []
      throw err
    }
  },
  stat: (path) => {
    try {
      const s = statSync(path)
      return { mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() }
    } catch {
      return null
    }
  },
  mkdir: (path) => {
    mkdirSync(path, { recursive: true })
  },
}
