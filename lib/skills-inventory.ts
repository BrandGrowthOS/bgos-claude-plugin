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
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'

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
  | { ok: true; removed: { name: string; scope: 'agent'; path: string } }
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

/** A path for the app: the home folder as `~`, never a raw username. */
export function displayPath(path: string, home: string): string {
  if (home && path === home) return '~'
  if (home && path.startsWith(home + sep)) return '~' + path.slice(home.length)
  return path
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function inside(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/** Equal, or one inside the other. */
function overlaps(a: string, b: string): boolean {
  return a === b || inside(a, b) || inside(b, a)
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
function repoLevels(agentDir: string): string[] {
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
 */
export function parseFrontmatter(head: string): Frontmatter | null {
  const text = head.replace(/^\uFEFF/, '')
  const open = /^---[ \t]*\r?\n/.exec(text)
  if (!open) return null
  const lines = text.slice(open[0].length).split(/\r?\n/)
  const close = lines.findIndex((line, i) => /^---[ \t]*$/.test(line) && i < lines.length - 1)
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

function clean(text: string, max: number): string {
  const one = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 3).trimEnd() + '...' : one
}

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
}

function readSkill(root: Root, entry: string, home: string, seen: Set<string>, log: (m: string) => void): SkillItem | null {
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
  seen.add(skillReal)

  let front: Frontmatter | null = null
  try {
    front = parseFrontmatter(readSkillHead(mdReal))
  } catch {
    front = null
  }
  const rawName = clean(front?.fields.name ?? '', SKILL_DISPLAY_NAME_MAX) || entry
  if (hasSecret('name', rawName) || hasSecret('name', entry)) {
    log(`skills: a skill in ${root.scope} skipped, its name looks like a secret`)
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

  return {
    ...(root.plugin ? { identifier: root.plugin.id } : {}),
    name: root.plugin ? `${root.plugin.name}:${rawName}` : rawName,
    description,
    provenance: root.plugin ? 'plugin' : 'local',
    removable: root.scope === 'agent',
    scope: root.scope,
    path: displayPath(lexical, home),
    files: size.files,
    bytes: size.bytes,
    modifiedAt: mdStat.mtime.toISOString(),
    shareable: shareBlock === undefined,
    ...(shareBlock ? { shareBlock } : {}),
  }
}

function listRoot(root: Root, home: string, log: (m: string) => void): SkillItem[] {
  const real = realOrNull(root.dir)
  if (!real) return []
  let names: string[]
  try {
    names = readdirSync(real).sort()
  } catch {
    return []
  }
  const seen = new Set<string>()
  const out: SkillItem[] = []
  for (const name of names) {
    if (name.startsWith('.') || name === root.skip) continue
    const row = readSkill(root, name, home, seen, log)
    if (row) out.push(row)
  }
  return out
}

// ── Plugins ─────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function readJson(path: string): unknown {
  try {
    if (statSync(path).size > INSTALLED_PLUGINS_MAX_BYTES) return null
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
    const name = id.split('@')[0] || id
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

function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

export function listSkills(input: ListSkillsInput): SkillsList {
  const log = input.log ?? (() => {})
  const { home } = input
  const computerDir = join(input.configDir, 'skills')
  const omitted: SkillsOmitted[] = []

  // Roots no agent or repo root may resolve into: their rows are not the agent's.
  const foreign = [realOrNull(computerDir), realOrNull(input.managedDir)].filter((r): r is string => !!r)

  const agentRoots: Root[] = []
  if (input.agentDir === null) {
    omitted.push({ scope: 'agent', reason: 'no_launch_cwd' }, { scope: 'repo', reason: 'no_launch_cwd' })
  } else {
    const agentDir = resolve(input.agentDir)
    const agentSkills = join(agentDir, '.claude', 'skills')
    const agentReal = realOrNull(agentSkills)
    if (agentReal && foreign.some((f) => overlaps(agentReal, f))) {
      omitted.push({ scope: 'agent', reason: 'agent_is_computer' })
    } else {
      agentRoots.push({ scope: 'agent', dir: agentSkills })
      if (agentReal) foreign.push(agentReal)
    }
    for (const level of repoLevels(agentDir)) {
      const dir = join(level, '.claude', 'skills')
      const real = realOrNull(dir)
      if (!real || foreign.some((f) => overlaps(real, f))) continue
      foreign.push(real)
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
  const skills = roots.flatMap((root) => listRoot(root, home, log))

  // hiddenBy: the first scope in precedence order wins a name.
  const winner = new Map<string, SkillScope>()
  for (const scope of PRECEDENCE) {
    for (const s of skills) {
      if (s.scope === scope && !winner.has(nameKey(s.name))) winner.set(nameKey(s.name), scope)
    }
  }
  for (const s of skills) {
    if (s.scope === 'plugin') continue
    const win = winner.get(nameKey(s.name))
    if (win && win !== s.scope) s.hiddenBy = win
  }

  return omitted.length ? { skills, omitted } : { skills }
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
}

function refuse(code: SkillRemoveCode, message: string): SkillRemoveAnswer {
  return { ok: false, code, message }
}

const PATH_MAX = 1024

export function removeAgentSkill(input: RemoveSkillInput): SkillRemoveAnswer {
  const { payload, home } = input
  if (payload.scope !== 'agent') return refuse('scope_refused', 'only skills in this agent folder can be removed here')
  if (typeof payload.name !== 'string' || !SKILL_NAME_RE.test(payload.name)) {
    return refuse('bad_request', 'the skill name is not a valid skill name')
  }
  const rawPath = payload.path
  if (typeof rawPath !== 'string' || !rawPath || rawPath.length > PATH_MAX || rawPath.includes('\0')) {
    return refuse('bad_request', 'the path is missing or not a path')
  }
  if (input.agentDir === null) {
    return refuse('unavailable', 'this agent was started without its launch folder, so it has no agent skills')
  }

  // The path must be exactly <agent>/.claude/skills/<name>, as the list showed it.
  const expanded =
    rawPath === '~' || rawPath.startsWith('~/') || rawPath.startsWith('~\\') ? home + rawPath.slice(1) : rawPath
  if (!isAbsolute(expanded)) return refuse('scope_refused', 'the path must be the one the skills list showed')
  if (expanded.split(/[\\/]+/).some((seg) => seg === '..' || seg === '.')) {
    return refuse('scope_refused', 'the path may not contain . or .. segments')
  }
  const agentDir = resolve(input.agentDir)
  const claudeDir = join(agentDir, '.claude')
  const agentSkills = join(claudeDir, 'skills')
  const target = resolve(expanded)
  const folder = basename(target)
  if (dirname(target) !== agentSkills || !SKILL_NAME_RE.test(folder)) {
    return refuse('scope_refused', 'the path is not a skill in this agent folder')
  }

  // No symlinked parent: .claude and .claude/skills must be real folders.
  for (const parent of [claudeDir, agentSkills]) {
    let st
    try {
      st = lstatSync(parent)
    } catch {
      return refuse('not_found', 'this agent has no skills folder')
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return refuse('scope_refused', 'the skills folder of this agent is a link, so nothing in it is removed')
    }
  }
  const agentReal = realOrNull(agentDir)
  const skillsReal = realOrNull(agentSkills)
  if (!agentReal || !skillsReal || skillsReal !== join(agentReal, '.claude', 'skills')) {
    return refuse('scope_refused', 'the skills folder of this agent resolves somewhere else')
  }
  const foreign = [realOrNull(join(input.configDir, 'skills')), input.managedDir ? realOrNull(input.managedDir) : null]
  if (foreign.some((f) => f && overlaps(skillsReal, f))) {
    return refuse('scope_refused', 'the skills folder of this agent is the computer skills folder')
  }

  let st
  try {
    st = lstatSync(target)
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

  const trashDir = resolve(input.trashDir)
  if (overlaps(trashDir, agentSkills) || overlaps(trashDir, skillsReal)) {
    return refuse('write_failed', 'the trash folder is inside the skills folder')
  }
  const shown = displayPath(target, home)
  try {
    mkdirSync(trashDir, { recursive: true })
    const stamp = String(input.now()).padStart(15, '0')
    let dest = join(trashDir, `${stamp}-${folder}`)
    for (let n = 2; existsSync(dest) || existsSync(dest + '.json'); n++) dest = join(trashDir, `${stamp}-${n}-${folder}`)
    // rename moves a link itself, never what it points at.
    renameSync(target, dest)
    writeFileSync(
      dest + '.json',
      JSON.stringify({ name: folder, scope: 'agent', path: shown, removedAt: new Date(input.now()).toISOString() }, null, 1),
    )
  } catch (err) {
    return refuse('write_failed', `the skill could not be moved to the trash: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { ok: true, removed: { name: folder, scope: 'agent', path: shown } }
}
