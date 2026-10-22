/**
 * The Claude Code skills inventory (skills view design, section 7 row 3): the
 * skills this agent loads, read from disk for the owner's Abilities screen,
 * and the one Remove the app may do.
 *
 * Claude Code has no list API, so this walks the roots the CLI reads, in this
 * order (design section 3.2), each row tagged with its scope:
 *
 *   agent     <agent folder>/.claude/skills. The agent folder is the launch
 *             folder the launcher passed as BGOS_LAUNCH_CWD and NEVER
 *             process.cwd(), which is the plugin cache on a marketplace
 *             install. With no launch folder there are no agent or repo rows,
 *             and the answer says why (`omitted`).
 *   repo      each parent of the agent folder up to the repo root (the nearest
 *             folder holding .git, so a linked worktree stops at its own
 *             root). Shared by every agent under that repo: never removable.
 *   computer  <config dir>/skills minus `synced`. The config dir is the
 *             resolved CLAUDE_CONFIG_DIR, which REPLACES ~/.claude/skills.
 *   synced    <config dir>/skills/synced (claude.ai skills, read only).
 *   plugin    <installPath>/skills of each plugin in installed_plugins.json
 *             that loads here, named plugin:skill.
 *   managed   the organisation folder for the OS.
 *
 * The walk is symlink safe: a skill FOLDER may be a link (a CLAUDE_CONFIG_DIR
 * is often a folder of links into ~/.claude/skills), but no FILE is read whose
 * realpath leaves its skill folder, a realpath already seen is not walked
 * twice, and an agent root that resolves into the computer, managed or a repo
 * root is not listed as the agent's (so its rows can never be removable).
 *
 * Only the head of each SKILL.md is read (FRONTMATTER_READ_MAX bytes), and only
 * the frontmatter in it is parsed. Name and description go through the
 * plugin's secret scanner: a name with a hit drops the row, a description with
 * a hit is dropped and the row marked shareBlock 'secret'.
 *
 * Remove moves ONE agent scope skill folder into the plugin state trash,
 * outside every skills tree, after refusing anything else: another scope, a
 * path with `.` or `..`, a path that is not exactly <agent root>/<name>, a
 * symlinked `.claude` or `.claude/skills` parent, and an agent root that is the
 * computer's.
 */

import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { scanText } from './secret-scan.ts'

export type SkillScope = 'agent' | 'repo' | 'computer' | 'synced' | 'plugin' | 'managed'
export type SkillShareBlock = 'runs_commands' | 'too_large' | 'binary' | 'secret' | 'scope'

/** One row of list_installed, the section 5 item. Absent fields are omitted, never null. */
export type SkillItem = {
  identifier?: string
  name: string
  description: string
  provenance: 'local' | 'plugin'
  removable: boolean
  scope: SkillScope
  path: string
  hiddenBy?: SkillScope
  files?: number
  bytes?: number
  modifiedAt?: string
  shareable: boolean
  shareBlock?: SkillShareBlock
}

export type SkillsOmitted = { scope: SkillScope; reason: 'no_launch_cwd' | 'agent_is_computer' }
export type SkillsList = { skills: SkillItem[]; omitted?: SkillsOmitted[] }

export type SkillRemoveCode = 'bad_request' | 'scope_refused' | 'not_found' | 'unavailable' | 'write_failed'
export type SkillRemoveAnswer =
  | { ok: true; removed: { name: string; scope: 'agent'; path: string }; trashedTo?: string }
  | { ok: false; code: SkillRemoveCode; message: string }

/** Claude Code's own rule for a skill name, and the design's for every new DTO. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
/** How much of a SKILL.md is ever read. */
export const FRONTMATTER_READ_MAX = 8192
export const SKILL_DESCRIPTION_MAX = 1024
export const SKILL_DISPLAY_NAME_MAX = 128
/** The share caps of design section 4.2, used for the too_large hint only. */
export const SHARE_MAX_FILES = 50
export const SHARE_MAX_FILE_BYTES = 64 * 1024
export const SHARE_MAX_TOTAL_BYTES = 256 * 1024
const SHARE_TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.csv'])
/** Bounds on the size walk inside one skill folder. */
const WALK_MAX_ENTRIES = 2000
const WALK_MAX_DEPTH = 12
/** At most this many skills are read from one root, so a huge folder cannot stall the daemon. */
export const SKILLS_ROOT_MAX = 500
const INSTALLED_PLUGINS_MAX_BYTES = 1024 * 1024
/** Frontmatter keys that pre-approve tools or run commands (section 4.2). */
const EXECUTABLE_KEYS = ['allowed-tools', 'hooks', 'shell']
/** Who wins a name, first first (section 2). Plugin skills are namespaced and never collide. */
const PRECEDENCE: SkillScope[] = ['managed', 'computer', 'synced', 'agent', 'repo']
const SHAREABLE_SCOPES = new Set<SkillScope>(['agent', 'computer'])

// ── Paths ───────────────────────────────────────────────────────────────────

export function managedSkillsDir(platform: NodeJS.Platform, env: Record<string, string | undefined>): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/.claude/skills'
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles?.trim() || 'C:\\Program Files'
    return `${programFiles}\\ClaudeCode\\.claude\\skills`
  }
  return '/etc/claude-code/.claude/skills'
}

/**
 * A path for the app: the home folder as `~`, never a raw username. Under the
 * home it is `~/a/b` on every OS (Windows separators turned to `/`), the form
 * the contract shows and remove takes back. On Windows the home prefix is
 * compared without case (NTFS folds it, and a shell can pass `c:\` for the
 * `C:\` homedir() gives), the rest kept as written.
 */
export function displayPath(path: string, home: string, pathSep: string = sep): string {
  if (!home) return path
  const same = pathSep === '\\' ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase() : (a: string, b: string) => a === b
  if (same(path, home)) return '~'
  if (path.length > home.length && path[home.length] === pathSep && same(path.slice(0, home.length), home)) {
    const rest = path.slice(home.length)
    return '~' + (pathSep === '/' ? rest : rest.split(pathSep).join('/'))
  }
  return path
}

/**
 * The backend's fold of a path, twin of redactHomePath in
 * backend/src/skills/skills-installed-items.ts (the prefixes are copied byte
 * for byte; test/skills-backend-twins.test.ts runs the case table its spec
 * runs). It folds ANY user's home, not only this daemon's, so a row this
 * daemon left absolute (an agent folder in /Users/Shared, a root daemon's
 * project under /home/ubuntu, a drive letter in another case) reaches the app,
 * and comes back from it, as `~...`. Read, write and Remove match that form.
 */
const BACKEND_HOME_PREFIXES: readonly RegExp[] = [
  /^\/+Users\/[^/]+(?=\/|$)/,
  /^\/(?:var\/)?home\/[^/]+(?=\/|$)/,
  /^\/root(?=\/|$)/,
  // Any case (NTFS is case insensitive), with or without the \\?\ prefix.
  /^(?:\\\\\?\\)?[A-Za-z]:[\\/]Users[\\/][^\\/]+(?=[\\/]|$)/i,
]

export function backendFoldedPath(path: string): string {
  for (const prefix of BACKEND_HOME_PREFIXES) {
    if (prefix.test(path)) return path.replace(prefix, '~')
  }
  return path
}

export function realOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** For a file read: a realpath under a realpath, both spelled by realpathSync. */
export function inside(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * The identity string of a stat taken with `{ bigint: true }`. Every identity
 * built or compared for safety goes through it: NTFS file ids pass 2^53 (the
 * sequence number sits in the top 16 bits), and as Numbers two live folders
 * can round to the same id, so an overlap or a same file check could pass for
 * a different folder. The bigint type is required, so a Number stat cannot
 * reach it.
 */
export function statIdentity(st: { dev: bigint; ino: bigint }): string {
  return `${st.dev.toString()}:${st.ino.toString()}`
}

/** A folder's identity on disk, so no spelling (case, NFD, a link) can hide it. Exact: bigint stats. */
export function identOf(path: string, follow = true): string | null {
  try {
    return statIdentity(follow ? statSync(path, { bigint: true }) : lstatSync(path, { bigint: true }))
  } catch {
    return null
  }
}

/** The identities of a folder and of every folder above its real location. */
function chainOf(path: string): string[] {
  const out: string[] = []
  let at = realOrNull(path) ?? resolve(path)
  for (;;) {
    const id = identOf(at)
    if (id) out.push(id)
    const up = dirname(at)
    if (up === at) return out
    at = up
  }
}

/**
 * The same folder, or one inside the other, compared by identity and never by
 * spelling: on APFS and NTFS `/Users/x` and `/users/x` are one folder, and
 * node's realpathSync keeps whichever spelling it was given.
 */
export function overlaps(a: string, b: string): boolean {
  const ia = identOf(a)
  const ib = identOf(b)
  if (!ia || !ib) return false
  return chainOf(a).includes(ib) || chainOf(b).includes(ia)
}

/** `child` is `parent` or inside it, by identity. */
function under(child: string, parent: string): boolean {
  const ip = identOf(parent)
  return !!ip && chainOf(child).includes(ip)
}

/**
 * `child` is or would be inside `root`, for paths that may not exist yet: the
 * nearest existing folder above each is compared by identity, then the part
 * still missing by its spelling, case and NFC folded so a folding file system
 * cannot hide it (on a case sensitive one this only refuses more).
 */
export function wouldBeUnder(child: string, root: string): boolean {
  const childAt = existingAncestor(child)
  if (existsSync(root)) return under(childAt, root)
  const rootAt = existingAncestor(root)
  if (!under(childAt, rootAt)) return false
  const fold = (p: string) => p.normalize('NFC').toLowerCase()
  const childReal = join(realOrNull(childAt) ?? childAt, relative(childAt, resolve(child)))
  const rootReal = join(realOrNull(rootAt) ?? rootAt, relative(rootAt, resolve(root)))
  const c = fold(childReal)
  const r = fold(rootReal)
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep)
}

/** The nearest folder at or above `path` that exists. */
function existingAncestor(path: string): string {
  let at = resolve(path)
  while (!existsSync(at)) {
    const up = dirname(at)
    if (up === at) break
    at = up
  }
  return at
}

/**
 * The folders whose skills are never the agent's: the computer folder under
 * the config dir, the default ~/.claude/skills (every session without a
 * CLAUDE_CONFIG_DIR loads it, whatever this one's says), and the managed one.
 */
export function computerRoots(configDir: string, home: string, managedDir: string | undefined): string[] {
  return [join(configDir, 'skills'), join(home, '.claude', 'skills'), ...(managedDir ? [managedDir] : [])]
}

/** `.claude` and `.claude/skills` of the agent are real folders, not links, and resolve where they say. */
export function agentParentsSafe(agentDir: string): boolean {
  const claudeDir = join(agentDir, '.claude')
  const skillsDir = join(claudeDir, 'skills')
  for (const parent of [claudeDir, skillsDir]) {
    try {
      const st = lstatSync(parent)
      if (st.isSymbolicLink() || !st.isDirectory()) return false
    } catch {
      return false
    }
  }
  const agentReal = realOrNull(agentDir)
  const skillsReal = realOrNull(skillsDir)
  return !!agentReal && !!skillsReal && skillsReal === join(agentReal, '.claude', 'skills')
}

/** The nearest folder at or above `dir` holding .git, or null. */
export function findRepoRoot(dir: string): string | null {
  let at = resolve(dir)
  for (;;) {
    if (existsSync(join(at, '.git'))) return at
    const up = dirname(at)
    if (up === at) return null
    at = up
  }
}

/** The parents of the agent folder up to the repo root, nearest first. */
export function repoLevels(agentDir: string): string[] {
  const root = findRepoRoot(agentDir)
  const start = resolve(agentDir)
  if (!root || root === start) return []
  const levels: string[] = []
  let at = dirname(start)
  for (;;) {
    levels.push(at)
    if (at === root) break
    const up = dirname(at)
    if (up === at) break
    at = up
  }
  return levels
}

// ── Frontmatter ─────────────────────────────────────────────────────────────

/** At most FRONTMATTER_READ_MAX bytes from the start of a file, never the rest. */
/** The frontmatter of a SKILL.md file, read from its head. */
function frontmatterOf(path: string): Frontmatter | null {
  const head = readSkillHead(path)
  // UTF-8 decoding never shortens: under the cap in bytes, the head is the whole file
  return parseFrontmatter(head, Buffer.byteLength(head) < FRONTMATTER_READ_MAX)
}

export function readSkillHead(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(FRONTMATTER_READ_MAX)
    let got = 0
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got)
      if (n <= 0) break
      got += n
    }
    return buf.toString('utf8', 0, got)
  } finally {
    closeSync(fd)
  }
}

export type Frontmatter = { fields: Record<string, string>; keys: Set<string> }

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\nt])/g, (_m, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/**
 * The frontmatter of a SKILL.md head, or null when the head does not open
 * with `---` or the block does not close inside it. Top level scalar keys
 * only: plain, quoted, `|` and `>` blocks, and indented continuations. A key
 * whose value is a nested list or map is recorded in `keys` with no field.
 * A closing `---` on the very last line, no newline after it, closes the
 * block when the head is the `whole` file, as the backend's frontmatter
 * readers take it; in a head cut at the read cap that line may be cut too.
 */
export function parseFrontmatter(head: string, whole = true): Frontmatter | null {
  const text = head.replace(/^\uFEFF/, '')
  const open = /^---[ \t]*\r?\n/.exec(text)
  if (!open) return null
  const lines = text.slice(open[0].length).split(/\r?\n/)
  const close = lines.findIndex((line, i) => /^---[ \t]*$/.test(line) && (whole || i < lines.length - 1))
  if (close < 0) return null
  const block = lines.slice(0, close)

  const fields: Record<string, string> = {}
  const keys = new Set<string>()
  for (let i = 0; i < block.length; i++) {
    const m = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/.exec(block[i]!)
    if (!m) continue
    const key = m[1]!
    keys.add(key)
    const raw = (m[2] ?? '').replace(/[ \t]+#.*$/, '').trim()
    const more: string[] = []
    while (i + 1 < block.length && (/^[ \t]+/.test(block[i + 1]!) || block[i + 1]!.trim() === '')) {
      more.push(block[i + 1]!)
      i += 1
    }
    const body = more.map((l) => l.trim())
    if (/^[|>][+-]?$/.test(raw)) {
      while (body.length && body[body.length - 1] === '') body.pop()
      fields[key] = raw.startsWith('|') ? body.join('\n') : body.filter(Boolean).join(' ')
    } else if (raw === '') {
      // a nested list or map: present, but not a scalar
      if (!body.some((l) => l.startsWith('-') || /^[A-Za-z0-9_-]+:/.test(l)) && body.some(Boolean)) {
        fields[key] = body.filter(Boolean).join(' ')
      }
    } else {
      fields[key] = unquote([raw, ...body.filter(Boolean)].join(' '))
    }
  }
  return { fields, keys }
}

/**
 * The characters no listed name or description carries: C0, DEL, C1, and the
 * bidi marks, embeddings, overrides and isolates (U+061C, U+200E, U+200F,
 * U+202A to U+202E, U+2066 to U+2069). The backend's read DTO refuses a name
 * holding any of them (SKILL_LISTED_NAME_PATTERN), so the list replaces them
 * and read_skill refuses them, and no row is listed that cannot be read. That
 * holds for a name taken from a folder too (listedEntryName): a SKILL.md with
 * no `name:` is listed under its folder name cleaned the same way. A row's
 * PATH is never cleaned (it must name the folder): see entryPathRefused.
 */
export const LISTED_TEXT_CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/
const LISTED_TEXT_CONTROLS = new RegExp(LISTED_TEXT_CONTROL.source + '+', 'g')

function clean(text: string, max: number): string {
  const one = text.replace(LISTED_TEXT_CONTROLS, ' ').replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 3).trimEnd() + '...' : one
}

/**
 * The name the list shows for a skill folder whose SKILL.md has no `name:`:
 * the folder entry, cleaned as every listed name is ('' when nothing is left).
 * Every place that matches a listed name back to a folder (share's lookup,
 * Remove and write's name check) compares against this same form.
 */
export function listedEntryName(entry: string): string {
  return clean(entry, SKILL_DISPLAY_NAME_MAX)
}

/**
 * Twin of SKILL_DISPLAY_PATH_PATTERN in the bgos backend,
 * backend/src/dto/skills-store.dto.ts, copied byte for byte (its case table
 * is test/skills-backend-twins.test.ts DISPLAY_PATH_CASES). It is the path
 * the app sends back to read, write or Remove a row: `~` for home, no NUL or
 * other C0 control or DEL, no drive relative start (`C:x`), no segment that
 * ends in a dot or a space, at most 1024 characters. Change both or neither.
 */
export const SKILL_DISPLAY_PATH_PATTERN =
  // The control character class IS the rule: a path may carry none.
  // eslint-disable-next-line no-control-regex
  /^(?![A-Za-z]:(?![\\/]))(?!(?:.*[\\/])?[^\\/]*[. ](?:[\\/]|$))[^\u0000-\u001f\u007f]{1,1024}$/;

/**
 * Whether the list skips the entry `entry` of the root folder `dir` on its
 * name alone: the row's path could never come back from the app. A row's
 * path carries the entry as it is on disk (it must name the folder), and the
 * backend refuses a path past 1024 characters as the daemon sent it and one
 * whose fold (backendFoldedPath, what the app sees and sends back) fails
 * SKILL_DISPLAY_PATH_PATTERN: a C0 control or DEL anywhere, or a name ending
 * in a dot or a space (`tidy.`, `notes `, both legal on macOS and Linux).
 * Such a row could never be read, edited or removed, so it is not listed.
 * This ONE predicate is the list's (readSkill), rowAt's (an entry it skips
 * claims no folder) and share's (findSkillFolder). A bidi mark in an entry
 * stays in the path: the backend accepts it there and the app sanitizes the
 * path for display; only the row's name is cleaned of it.
 */
export function entryPathRefused(dir: string, entry: string, home: string): boolean {
  const shown = displayPath(join(dir, entry), home)
  return shown.length > PATH_MAX || !SKILL_DISPLAY_PATH_PATTERN.test(backendFoldedPath(shown))
}

/**
 * The name Claude Code loads a skill under: the frontmatter name as written,
 * else the folder entry, neither cleaned (listSkills keys hiddenBy on it,
 * through nameKey). The row's `name` is the cleaned form, for display and
 * for matching a request back to its folder.
 */
const loadedNames = new WeakMap<SkillItem, string>()

function hasSecret(label: string, text: string): boolean {
  return text !== '' && scanText(label, text).length > 0
}

// ── One skill folder ────────────────────────────────────────────────────────

type Size = { files: number; bytes: number; tooLarge: boolean }

/** Files and bytes under a skill folder, never past a link that leaves it, never twice. */
function sizeOf(skillReal: string): Size {
  const seen = new Set<string>([skillReal])
  const stack: Array<[string, number]> = [[skillReal, 0]]
  let files = 0
  let bytes = 0
  let shareFiles = 0
  let shareBytes = 0
  let bigFile = false
  let entries = 0
  while (stack.length) {
    const [dir, depth] = stack.pop()!
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (++entries > WALK_MAX_ENTRIES) return { files, bytes, tooLarge: true }
      let real = join(dir, name)
      let st
      try {
        const l = lstatSync(real)
        if (l.isSymbolicLink()) {
          const r = realOrNull(real)
          if (!r || !inside(r, skillReal)) continue
          real = r
        }
        st = statSync(real)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (seen.has(real) || depth + 1 > WALK_MAX_DEPTH) continue
        seen.add(real)
        stack.push([real, depth + 1])
      } else if (st.isFile()) {
        files += 1
        bytes += st.size
        const rel = real.slice(skillReal.length + 1)
        const sent = SHARE_TEXT_EXTENSIONS.has(extname(name).toLowerCase()) && !rel.split(sep).some((s) => s.startsWith('.'))
        if (sent) {
          shareFiles += 1
          shareBytes += st.size
          if (st.size > SHARE_MAX_FILE_BYTES) bigFile = true
        }
      }
    }
  }
  return {
    files,
    bytes,
    tooLarge: bigFile || shareFiles > SHARE_MAX_FILES || shareBytes > SHARE_MAX_TOTAL_BYTES,
  }
}

type Root = {
  scope: SkillScope
  /** Where the agent sees it, for display and for Remove. */
  dir: string
  skip?: string
  plugin?: { name: string; id: string }
  /** Only an agent root whose parents passed the Remove checks has removable rows. */
  removable?: boolean
}

/** A skill folder that passed the realpath, SKILL.md and nlink checks, its frontmatter head read. */
type Probe = { lexical: string; skillReal: string; mdStat: Stats; front: Frontmatter | null }

/**
 * The checks every entry gets on its realpath, listed or not: a folder whose
 * realpath this root has not given yet, holding a SKILL.md inside it that is
 * a regular file and not hard linked. Only then is the head of that SKILL.md
 * read (frontmatterOf), never more. `log` is the list's, or a no-op for an
 * entry refused on its path (its path may hold the control character itself).
 */
function probeSkill(root: Root, entry: string, home: string, seen: Set<string>, log: (m: string) => void): Probe | null {
  const lexical = join(root.dir, entry)
  const skillReal = realOrNull(lexical)
  if (!skillReal || seen.has(skillReal)) return null
  try {
    if (!statSync(skillReal).isDirectory()) return null
  } catch {
    return null
  }
  const skillMd = join(skillReal, 'SKILL.md')
  try {
    lstatSync(skillMd)
  } catch {
    return null
  }
  const mdReal = realOrNull(skillMd)
  if (!mdReal || !inside(mdReal, skillReal)) {
    log(`skills: ${displayPath(lexical, home)} skipped, its SKILL.md leaves the skill folder`)
    return null
  }
  let mdStat
  try {
    mdStat = statSync(mdReal)
    if (!mdStat.isFile()) return null
  } catch {
    return null
  }
  if (mdStat.nlink > 1) {
    // a hard link can be a file from anywhere: its realpath cannot tell
    log(`skills: ${displayPath(lexical, home)} skipped, its SKILL.md is a hard link`)
    return null
  }
  let front: Frontmatter | null = null
  try {
    front = frontmatterOf(mdReal)
  } catch {
    front = null
  }
  return { lexical, skillReal, mdStat, front }
}

/** The name Claude Code loads a skill folder under: the frontmatter name as written, else the raw entry. */
function loadedNameOf(front: Frontmatter | null, entry: string): string {
  return (front?.fields.name ?? '').trim() || entry
}

/**
 * The name Claude Code loads the entry `entry` under when the list skips it
 * on its path alone (entryPathRefused): Claude Code still loads that folder,
 * so it still wins its name over a lower scope (listSkills' hiddenBy). It is
 * found under the same checks a listed entry gets (probeSkill: realpath,
 * SKILL.md inside, not hard linked, the frontmatter head only), and the entry
 * is never listed, read or shared. It does not claim its realpath in `seen`,
 * as it never did (rowAt's earlier-entry rule rests on that). Null for an
 * entry the list does not skip on its path, or one that names no skill.
 */
function refusedLoadedName(root: Root, entry: string, home: string, seen: Set<string>): string | null {
  if (!entryPathRefused(root.dir, entry, home)) return null
  const probe = probeSkill(root, entry, home, seen, () => {})
  return probe ? loadedNameOf(probe.front, entry) : null
}

function readSkill(
  root: Root,
  entry: string,
  home: string,
  seen: Set<string>,
  log: (m: string) => void,
  // the loaded name of a folder Claude Code loads that is not listed (its name looks like a secret): hiddenBy only
  unlisted: (loaded: string) => void = () => {},
): SkillItem | null {
  if (entryPathRefused(root.dir, entry, home)) {
    // never the raw entry or path in a log line: it may hold the control character itself
    log(`skills: a skill in ${root.scope} skipped, its path is not one the app can send back`)
    return null
  }
  const probe = probeSkill(root, entry, home, seen, log)
  if (!probe) return null
  const { lexical, skillReal, mdStat, front } = probe
  seen.add(skillReal)

  // A folder name is cleaned like a frontmatter one for the row's NAME, so the
  // row stays readable by its name. Its path keeps the raw entry, a bidi mark
  // included (the backend accepts it in a path, and the app sanitizes the path
  // for display); an entry whose path the app could not send back was skipped
  // above (entryPathRefused).
  const rawName = clean(front?.fields.name ?? '', SKILL_DISPLAY_NAME_MAX) || listedEntryName(entry)
  if (hasSecret('name', rawName) || hasSecret('name', entry)) {
    log(`skills: a skill in ${root.scope} skipped, its name looks like a secret`)
    unlisted(loadedNameOf(front, entry))
    return null
  }
  if (!rawName) {
    log(`skills: a skill in ${root.scope} skipped, its folder name is only control or bidi marks`)
    return null
  }
  let description = clean(front?.fields.description ?? '', SKILL_DESCRIPTION_MAX)
  let secret = false
  if (hasSecret('description', description)) {
    description = ''
    secret = true
  }
  const runsCommands = EXECUTABLE_KEYS.some((k) => front?.keys.has(k))
  const size = sizeOf(skillReal)

  const shareBlock: SkillShareBlock | undefined = !SHAREABLE_SCOPES.has(root.scope)
    ? 'scope'
    : secret
      ? 'secret'
      : runsCommands
        ? 'runs_commands'
        : size.tooLarge
          ? 'too_large'
          : undefined

  const row: SkillItem = {
    ...(root.plugin ? { identifier: root.plugin.id } : {}),
    name: root.plugin ? `${root.plugin.name}:${rawName}` : rawName,
    description,
    provenance: root.plugin ? 'plugin' : 'local',
    removable: root.scope === 'agent' && root.removable === true,
    scope: root.scope,
    path: displayPath(lexical, home),
    files: size.files,
    bytes: size.bytes,
    modifiedAt: mdStat.mtime.toISOString(),
    shareable: shareBlock === undefined,
    ...(shareBlock ? { shareBlock } : {}),
  }
  loadedNames.set(row, loadedNameOf(front, entry))
  return row
}

/** The entries of a root the list reads, in its order: no dot entry, not `skip`, sorted, at most SKILLS_ROOT_MAX. */
function rootEntries(root: Root, home: string, log: (m: string) => void): string[] {
  const real = realOrNull(root.dir)
  if (!real) return []
  let names: string[]
  try {
    names = readdirSync(real).sort()
  } catch {
    return []
  }
  const candidates = names.filter((name) => !name.startsWith('.') && name !== root.skip)
  if (candidates.length > SKILLS_ROOT_MAX) {
    log(`skills: ${displayPath(root.dir, home)} holds ${candidates.length} entries, only the first ${SKILLS_ROOT_MAX} are read`)
  }
  return candidates.slice(0, SKILLS_ROOT_MAX)
}

/**
 * The rows of one root, and the names Claude Code loads from the entries of
 * it the list skips on their path (refusedLoadedName) or because their name
 * looks like a secret: those enter hiddenBy's winner map only, never the list.
 */
function listRoot(root: Root, home: string, log: (m: string) => void): { rows: SkillItem[]; refusedNames: string[] } {
  const seen = new Set<string>()
  const rows: SkillItem[] = []
  const refusedNames: string[] = []
  for (const name of rootEntries(root, home, log)) {
    const row = readSkill(root, name, home, seen, log, (loaded) => refusedNames.push(loaded))
    if (row) {
      rows.push(row)
      continue
    }
    const loaded = refusedLoadedName(root, name, home, seen)
    if (loaded !== null) refusedNames.push(loaded)
  }
  return { rows, refusedNames }
}

/**
 * The row listRoot gives for ONE entry of a root, or null when it gives
 * none, with no other entry read: the entry must be one rootEntries keeps,
 * and an earlier entry with the same realpath claims the folder first, as
 * listRoot's `seen` does. An earlier entry readSkill skips on its name
 * (entryPathRefused, the one check before `seen` that is not on the
 * realpath) claims nothing, as it never reaches `seen` in listRoot either.
 * readSkill's other checks before it adds to `seen` depend on the realpath
 * alone, so any other earlier entry passed them whenever this one would.
 */
function rowAt(root: Root, entry: string, home: string, log: (m: string) => void): SkillItem | null {
  const names = rootEntries(root, home, () => {})
  const at = names.indexOf(entry)
  if (at < 0) return null
  const skillReal = realOrNull(join(root.dir, entry))
  if (!skillReal) return null
  const seen = new Set<string>()
  const claimed = names
    .slice(0, at)
    .some((earlier) => !entryPathRefused(root.dir, earlier, home) && realOrNull(join(root.dir, earlier)) === skillReal)
  if (claimed) seen.add(skillReal)
  return readSkill(root, entry, home, seen, log)
}

// ── Plugins ─────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function readJson(path: string): unknown {
  try {
    // a FIFO or device would block readFileSync forever: regular files only
    const st = statSync(path)
    if (!st.isFile() || st.size > INSTALLED_PLUGINS_MAX_BYTES) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** The plugin skill roots that load for this agent, from installed_plugins.json. */
function pluginRoots(configDir: string, agentDir: string | null): Root[] {
  const doc = readJson(join(configDir, 'plugins', 'installed_plugins.json'))
  if (!isRecord(doc) || !isRecord(doc.plugins)) return []
  const settings = readJson(join(configDir, 'settings.json'))
  const enabled = isRecord(settings) && isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {}
  const roots: Root[] = []
  for (const id of Object.keys(doc.plugins).sort()) {
    if (enabled[id] === false) continue
    const raw = doc.plugins[id]
    const records = (Array.isArray(raw) ? raw : [raw]).filter(isRecord)
    const entry = records.find(
      (r) =>
        r.scope === 'user' ||
        (typeof r.projectPath === 'string' && agentDir !== null && resolve(r.projectPath) === resolve(agentDir)),
    )
    if (!entry || typeof entry.installPath !== 'string' || !isAbsolute(entry.installPath)) continue
    // The plugin half of a row's name: no control or bidi mark either (clean), never cut.
    const name = clean(id.split('@')[0] || id, Infinity) || clean(id, Infinity)
    roots.push({ scope: 'plugin', dir: join(entry.installPath, 'skills'), plugin: { name, id } })
  }
  return roots
}

// ── The list ────────────────────────────────────────────────────────────────

export type ListSkillsInput = {
  /** The launch folder, or null when BGOS_LAUNCH_CWD was not passed. */
  agentDir: string | null
  configDir: string
  home: string
  managedDir: string
  log?: (msg: string) => void
}

export function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

/** The roots the list walks, in its order, and the scopes it leaves out and why. */
function skillRoots(input: ListSkillsInput): { roots: Root[]; omitted: SkillsOmitted[] } {
  const { home } = input
  const computerDir = join(input.configDir, 'skills')
  const omitted: SkillsOmitted[] = []

  // Roots no agent or repo root may resolve into: their rows are not the agent's.
  const foreign = computerRoots(input.configDir, home, input.managedDir).filter((r) => existsSync(r))

  const agentRoots: Root[] = []
  if (input.agentDir === null) {
    omitted.push({ scope: 'agent', reason: 'no_launch_cwd' }, { scope: 'repo', reason: 'no_launch_cwd' })
  } else {
    const agentDir = resolve(input.agentDir)
    const agentSkills = join(agentDir, '.claude', 'skills')
    const exists = existsSync(agentSkills)
    if (exists && foreign.some((f) => overlaps(agentSkills, f))) {
      omitted.push({ scope: 'agent', reason: 'agent_is_computer' })
    } else {
      agentRoots.push({ scope: 'agent', dir: agentSkills, removable: agentParentsSafe(agentDir) })
      if (exists) foreign.push(agentSkills)
    }
    for (const level of repoLevels(agentDir)) {
      const dir = join(level, '.claude', 'skills')
      if (!existsSync(dir) || foreign.some((f) => overlaps(dir, f))) continue
      foreign.push(dir)
      agentRoots.push({ scope: 'repo', dir })
    }
  }

  const roots: Root[] = [
    ...agentRoots,
    { scope: 'computer', dir: computerDir, skip: 'synced' },
    { scope: 'synced', dir: join(computerDir, 'synced') },
    ...pluginRoots(input.configDir, input.agentDir),
    { scope: 'managed', dir: input.managedDir },
  ]
  return { roots, omitted }
}

export function listSkills(input: ListSkillsInput): SkillsList {
  const log = input.log ?? (() => {})
  const { home } = input
  const { roots, omitted } = skillRoots(input)
  const walked = roots.map((root) => ({ scope: root.scope, ...listRoot(root, home, log) }))
  const skills = walked.flatMap((w) => w.rows)

  // hiddenBy: the first scope in precedence order wins a name, the name
  // Claude Code loads (never the cleaned one the row shows: 'tidy' plus U+200F
  // and 'tidy' are two skills to Claude Code, though both are listed 'tidy').
  // A folder the list skips on its path (`notes ` with name: notes) is still
  // loaded by Claude Code, so its loaded name wins here too, with no row.
  const keyOf = (s: SkillItem) => nameKey(loadedNames.get(s) ?? s.name)
  const winner = new Map<string, SkillScope>()
  for (const scope of PRECEDENCE) {
    for (const w of walked) {
      if (w.scope !== scope) continue
      for (const key of [...w.rows.map(keyOf), ...w.refusedNames.map(nameKey)]) {
        if (!winner.has(key)) winner.set(key, scope)
      }
    }
  }
  for (const s of skills) {
    if (s.scope === 'plugin') continue
    const win = winner.get(keyOf(s))
    if (win && win !== s.scope) s.hiddenBy = win
  }

  return omitted.length ? { skills, omitted } : { skills }
}

/**
 * The one row listSkills would show under `scope` at `rawPath`, found with
 * no list walk: only the roots of that scope whose entry the path names are
 * looked at, and in each only that entry (rowAt), under the same row rules.
 * The match is listSkills' own: the first row whose path is `rawPath`
 * exactly, else the one row whose backend fold (backendFoldedPath) is, and
 * none when two rows fold alike. `hiddenBy` is not set, as no other row is read.
 */
export function listedSkillAt(input: ListSkillsInput, scope: SkillScope, rawPath: string): SkillItem | null {
  const log = input.log ?? (() => {})
  const { home } = input
  // The entry is the last segment: a POSIX name may hold a backslash, a Windows one neither separator.
  const entries = new Set([rawPath.slice(rawPath.lastIndexOf('/') + 1), rawPath.split(/[\\/]/).pop() ?? ''])
  const folded: SkillItem[] = []
  for (const root of skillRoots(input).roots) {
    if (root.scope !== scope) continue
    for (const entry of entries) {
      if (!entry) continue
      const shown = displayPath(join(root.dir, entry), home)
      const exact = shown === rawPath
      if (!exact && backendFoldedPath(shown) !== rawPath) continue
      const row = rowAt(root, entry, home, log)
      if (!row) continue
      if (exact) return row
      folded.push(row)
    }
  }
  return folded.length === 1 ? folded[0]! : null
}

// ── Remove ──────────────────────────────────────────────────────────────────

export type RemoveSkillInput = {
  agentDir: string | null
  configDir: string
  home: string
  /** In the plugin state folder, outside every skills tree. */
  trashDir: string
  now: () => number
  payload: Record<string, unknown>
  managedDir?: string
  /** The move; renameSync unless a test stands in for it. */
  rename?: (from: string, to: string) => void
  log?: (msg: string) => void
}

function refuse(code: SkillRemoveCode, message: string): SkillRemoveAnswer {
  return { ok: false, code, message }
}

/** The longest path a skills frame may carry. */
export const PATH_MAX = 1024

/**
 * The frontmatter name of a skill folder (a link followed, as the list does),
 * read under the list's own rules: a SKILL.md inside the folder, a regular
 * file, not hard linked. Null otherwise.
 */
export function listedNameOf(folder: string): string | null {
  try {
    const real = realOrNull(folder)
    if (!real || !statSync(real).isDirectory()) return null
    const md = realOrNull(join(real, 'SKILL.md'))
    if (!md || !inside(md, real)) return null
    const mdSt = statSync(md)
    if (!mdSt.isFile() || mdSt.nlink > 1) return null
    const name = clean(frontmatterOf(md)?.fields.name ?? '', SKILL_DISPLAY_NAME_MAX)
    return name || null
  } catch {
    return null
  }
}

/** A path as the list shows it, `~` turned back into the home folder. */
export function expandHome(path: string, home: string): string {
  return path === '~' || path.startsWith('~/') || path.startsWith('~\\') ? home + path.slice(1) : path
}

/**
 * The absolute path a request for an agent skill names. When it is the path
 * the list showed for an entry directly in the agent skills folder, or the
 * backend's fold of it (backendFoldedPath), it is that entry: a folder
 * outside this home, or spelled with another drive letter case, comes back
 * as `~...` and no `~` expansion would find it. Otherwise `~` is expanded
 * against this home. Every other check runs on the result unchanged.
 */
function requestedAgentPath(rawPath: string, agentSkills: string, home: string): string {
  const entry = rawPath.split(/[\\/]/).pop() ?? ''
  if (entry !== '' && entry !== '.' && entry !== '..') {
    const candidate = join(agentSkills, entry)
    const shown = displayPath(candidate, home)
    if (rawPath === shown || rawPath === backendFoldedPath(shown)) return candidate
  }
  return expandHome(rawPath, home)
}

export type AgentSkillTarget = {
  ok: true
  agentDir: string
  agentSkills: string
  /** <agent>/.claude/skills/<folder>, lexical, not yet lstat'ed. */
  target: string
  folder: string
  /** The computer roots (computerRoots), which the agent skills folder overlaps none of. */
  foreign: string[]
}

export type SkillTargetRefusal = { ok: false; code: SkillRemoveCode; message: string }

/**
 * The one agent skill folder a path names, the rule Remove and an edit share:
 * the path the list showed or the backend's fold of it (requestedAgentPath),
 * absolute, no `.` or `..` segment, exactly <agent>/.claude/skills/<name>
 * with a name Claude Code takes, the `.claude` and `.claude/skills` parents
 * real folders and not links, and the agent skills folder none of the
 * computer's. Nothing is lstat'ed below it.
 */
export function agentSkillTarget(
  input: { agentDir: string | null; configDir: string; home: string; managedDir?: string },
  rawPath: unknown,
): AgentSkillTarget | SkillTargetRefusal {
  const no = (code: SkillRemoveCode, message: string): SkillTargetRefusal => ({ ok: false, code, message })
  if (typeof rawPath !== 'string' || !rawPath || rawPath.length > PATH_MAX || rawPath.includes('\0')) {
    return no('bad_request', 'the path is missing or not a path')
  }
  if (input.agentDir === null) {
    return no('unavailable', 'this agent was started without its launch folder, so it has no agent skills')
  }

  // The path must be exactly <agent>/.claude/skills/<name>, as the list showed it.
  const agentDir = resolve(input.agentDir)
  const agentSkills = join(agentDir, '.claude', 'skills')
  const expanded = requestedAgentPath(rawPath, agentSkills, input.home)
  if (!isAbsolute(expanded)) return no('scope_refused', 'the path must be the one the skills list showed')
  if (expanded.split(/[\\/]+/).some((seg) => seg === '..' || seg === '.')) {
    return no('scope_refused', 'the path may not contain . or .. segments')
  }
  const target = resolve(expanded)
  const folder = basename(target)
  if (dirname(target) !== agentSkills || !SKILL_NAME_RE.test(folder)) {
    return no('scope_refused', 'the path is not a skill in this agent folder')
  }

  // No symlinked parent: .claude and .claude/skills must be real folders.
  if (!existsSync(agentSkills)) return no('not_found', 'this agent has no skills folder')
  if (!agentParentsSafe(agentDir)) {
    return no('scope_refused', 'the skills folder of this agent is a link, so nothing in it is changed')
  }
  const foreign = computerRoots(input.configDir, input.home, input.managedDir)
  if (foreign.some((f) => overlaps(agentSkills, f))) {
    return no('scope_refused', 'the skills folder of this agent is the computer skills folder')
  }
  return { ok: true, agentDir, agentSkills, target, folder, foreign }
}

export function removeAgentSkill(input: RemoveSkillInput): SkillRemoveAnswer {
  const { payload, home } = input
  const log = input.log ?? (() => {})
  const rename = input.rename ?? renameSync
  if (payload.scope !== 'agent') return refuse('scope_refused', 'only skills in this agent folder can be removed here')
  if (
    typeof payload.name !== 'string' ||
    !payload.name ||
    payload.name.length > SKILL_DISPLAY_NAME_MAX ||
    /[\\/\u0000-\u001f]/.test(payload.name) ||
    payload.name === '.' ||
    payload.name === '..'
  ) {
    return refuse('bad_request', 'the skill name is not a valid skill name')
  }
  const at = agentSkillTarget(input, payload.path)
  if (!at.ok) return at
  const { agentDir, agentSkills, target, folder, foreign } = at

  let st
  try {
    st = lstatSync(target, { bigint: true })
  } catch {
    return refuse('not_found', 'that skill is not in this agent folder')
  }
  if (!st.isSymbolicLink()) {
    if (!st.isDirectory()) return refuse('not_found', 'that skill is not in this agent folder')
    try {
      lstatSync(join(target, 'SKILL.md'))
    } catch {
      return refuse('not_found', 'that folder is not a skill')
    }
  }
  // The name is the folder's, or the name the list showed for it.
  if (payload.name !== listedEntryName(folder) && payload.name !== listedNameOf(target)) {
    return refuse('bad_request', 'the skill name does not match the folder the path names')
  }

  // The trash is outside every skills root, or Claude Code would load the removed skill again.
  const trashDir = resolve(input.trashDir)
  const roots = [agentSkills, ...foreign, ...repoLevels(agentDir).map((l) => join(l, '.claude', 'skills'))]
  if (roots.some((r) => wouldBeUnder(trashDir, r))) {
    return refuse('write_failed', 'the trash folder is inside a skills folder, so nothing was moved')
  }

  const shown = displayPath(target, home)
  const targetId = statIdentity(st)
  const skillsId = identOf(agentSkills, false)
  let dest: string
  try {
    mkdirSync(trashDir, { recursive: true })
    const stamp = String(input.now()).padStart(15, '0')
    dest = join(trashDir, `${stamp}-${folder}`)
    for (let n = 2; existsSync(dest) || existsSync(dest + '.json'); n++) dest = join(trashDir, `${stamp}-${n}-${folder}`)
  } catch (err) {
    log(`skills: remove of ${shown} failed preparing the trash: ${displayPath(String((err as Error)?.message ?? err), home)}`)
    return refuse('write_failed', 'the trash folder could not be prepared, so nothing was moved')
  }

  // Checked again right before the move, and the moved entry checked after it:
  // a parent swapped for a link in between would otherwise move a computer skill.
  if (!agentParentsSafe(agentDir) || identOf(agentSkills, false) !== skillsId) {
    return refuse('scope_refused', 'the skills folder of this agent changed while removing, so nothing was moved')
  }
  try {
    // rename moves a link itself, never what it points at.
    rename(target, dest)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    log(`skills: remove of ${shown} failed: ${displayPath(String((err as Error)?.message ?? err), home)}`)
    if (code === 'EXDEV') {
      return refuse('write_failed', 'the trash is on another drive than this agent folder, so the skill was not moved')
    }
    return refuse('write_failed', 'the skill could not be moved to the trash')
  }
  if (identOf(dest, false) !== targetId || !agentParentsSafe(agentDir) || identOf(agentSkills, false) !== skillsId) {
    try {
      // put back with the real move, wherever the path now leads: it came from there
      renameSync(dest, target)
    } catch (err) {
      log(`skills: remove of ${shown} moved the wrong entry and could not put it back: ${String((err as Error)?.message ?? err)}`)
    }
    return refuse('scope_refused', 'the skills folder of this agent changed while removing, so it was put back')
  }
  try {
    writeFileSync(
      dest + '.json',
      JSON.stringify({ name: folder, scope: 'agent', path: shown, removedAt: new Date(input.now()).toISOString() }, null, 1),
    )
  } catch {
    // the skill is already in the trash; the note beside it is only a label
  }
  return { ok: true, removed: { name: folder, scope: 'agent', path: shown }, trashedTo: dest }
}
