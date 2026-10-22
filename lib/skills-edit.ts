/**
 * Preview and edit a skill (skills view plan, decision 8, the Claude Code
 * part): the two skills_rpc ops behind the owner's preview sheet.
 *
 *   read_skill   answers ONE listed SKILL.md whole, for any scope the list
 *                shows. It reads nothing the list does not show: the row must
 *                be one listSkills shows under the same scope and display
 *                path, with the same name, so every list rule (a secret
 *                looking name, a hard link, a SKILL.md that leaves its folder,
 *                an agent root that is the computer's) holds here too. Only
 *                the root and entry the path names are read for that
 *                (listedSkillAt), never the whole list. The file is opened
 *                with O_NOFOLLOW where the platform has it (win32 has not, so
 *                there the open follows a link), must be a regular single
 *                link file, and its fstat identity must be what a NO-FOLLOW
 *                lstat of the path finds after the open (a regular file, not
 *                a link), so a link swapped in is refused on every platform;
 *                the lexical <skill>/SKILL.md must be that file or a link
 *                that still resolves to it. It is read up to
 *                SKILL_READ_MAX_BYTES. A file past that, binary or holding a
 *                secret is WITHHELD, never cut: no credential, whole or cut,
 *                leaves this computer (the export rule). `editable` is
 *                computed live, never from a list the backend cached.
 *   write_skill  saves ONE agent scope SKILL.md, synchronously so two saves
 *                never interleave. Remove's target rule (agentSkillTarget),
 *                no repo level overlap, the skill folder and SKILL.md real by
 *                lstat and not links, a single link SKILL.md, and one with
 *                its owner write bit (a read only file answers read_only
 *                before any backup or temp, and read's editBlock says so:
 *                Windows cannot rename over it, so every save would fail
 *                after keeping a backup). An identical
 *                resend answers unchanged, a different current hash
 *                changed_since_preview. The shared content rules and
 *                runsShellAnywhere must pass. The old bytes go to the plugin
 *                state trash first; the new bytes go to a temp file in the
 *                same folder (exclusive create at 0o600, the old file's mode
 *                only once the temp is placed, fsync), every identity and the
 *                hash are checked again, then one rename. No temp is left
 *                behind on a failure, but one: a skill folder swapped for a
 *                link and back inside the open call itself can leave an empty
 *                0o600 file the save cannot find again, in whatever folder
 *                the link led to (no openat in Node). Every identity compared
 *                (folder, SKILL.md, temp) is a bigint dev:ino (statIdentity):
 *                NTFS ids pass 2^53, where Numbers round two files alike.
 *
 * Refusals are short, one line, lowercase and carry no absolute path.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
  constants as fsConstants,
  type BigIntStats,
  type Stats,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { checkSkillShareBundle, isStrictSkillName, readSkillFrontmatter } from './skill-share-content-rules.ts'
import { scanText } from './secret-scan.ts'
import {
  LISTED_TEXT_CONTROL,
  PATH_MAX,
  SHARE_MAX_FILE_BYTES,
  SHARE_MAX_TOTAL_BYTES,
  agentParentsSafe,
  agentSkillTarget,
  displayPath,
  expandHome,
  identOf,
  inside,
  listedEntryName,
  listedNameOf,
  listedSkillAt,
  overlaps,
  realOrNull,
  repoLevels,
  statIdentity,
  wouldBeUnder,
  type ListSkillsInput,
  type SkillScope,
} from './skills-inventory.ts'
import { UTF8, readHead, runsShellAnywhere } from './skills-share.ts'

/** A preview reads the whole file, and scans the whole file. */
export const SKILL_READ_MAX_BYTES = SHARE_MAX_TOTAL_BYTES
/** An edited skill stays shareable: one file at most the share cap. */
export const SKILL_WRITE_MAX_BYTES = SHARE_MAX_FILE_BYTES
/** The longest listed name a read takes: a plugin row is `plugin:` plus a 128 character name. */
export const SKILL_READ_NAME_MAX = 200
const EDIT_TEMP_PREFIX = '.SKILL.md.hoai-edit-'
const SHA256_RE = /^[0-9a-f]{64}$/
const SCOPES = new Set<string>(['agent', 'repo', 'computer', 'synced', 'plugin', 'managed'])
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

export type SkillEditBlock = 'scope' | 'linked' | 'read_only' | 'too_large' | 'binary' | 'secret' | 'runs_commands' | 'invalid'
export type SkillEditCode =
  | 'bad_request'
  | 'scope_refused'
  | 'not_found'
  | 'unavailable'
  | 'changed_since_preview'
  | 'read_only'
  | 'content_refused'
  | 'read_failed'
  | 'write_failed'

export type SkillEditRefusal = { ok: false; code: SkillEditCode; message: string }

export type ReadSkillInput = ListSkillsInput & {
  payload: Record<string, unknown>
  /**
   * Where a test steps in to swap SKILL.md or what it leads to: after the
   * realpath and inside checks, right before the open.
   */
  step?: (at: 'open') => void
}
export type ReadSkillAnswer =
  | {
      ok: true
      payload: {
        scope: SkillScope
        path: string
        name: string
        /** Over the whole file; absent for a file withheld too_large, whose bytes past the cap are never read. */
        sha256?: string
        bytes: number
        modifiedAt: string
        content?: string
        withheld?: 'too_large' | 'binary' | 'secret'
        editable: boolean
        editBlock?: SkillEditBlock
      }
    }
  | SkillEditRefusal

export type WriteSkillInput = {
  agentDir: string | null
  configDir: string
  home: string
  managedDir: string
  /** The plugin state trash the old bytes go to, outside every skills tree. */
  trashDir: string
  now: () => number
  payload: Record<string, unknown>
  platform: NodeJS.Platform
  /** The final move; renameSync unless a test stands in for it. */
  rename?: (from: string, to: string) => void
  /**
   * Where a test steps in to swap a folder or look: right before the temp
   * file opens, right after it opened (before its placement is checked),
   * right after each writeSync into it (inside the write loop, so a test sees
   * every write the moment it lands), and right before the checks the rename
   * waits on.
   */
  step?: (at: 'open_temp' | 'opened' | 'wrote' | 'recheck') => void
  log?: (msg: string) => void
}
export type WriteSkillAnswer =
  | {
      ok: true
      payload: {
        scope: 'agent'
        path: string
        name: string
        sha256: string
        bytes: number
        modifiedAt: string
        unchanged?: true
      }
    }
  | SkillEditRefusal

function refuse(code: SkillEditCode, message: string): SkillEditRefusal {
  return { ok: false, code, message }
}

/** Exact identities only: bigint stats (statIdentity), never a Number dev or ino. */
const idOf = (st: BigIntStats) => statIdentity(st)

/** No owner write bit: Windows' read only attribute, or a POSIX mode without u+w. A rename over it fails on Windows. */
const readOnly = (st: { mode: number | bigint }) => (Number(st.mode) & 0o200) === 0
const READ_ONLY_MESSAGE = 'the skill file is read only on the computer, so it is not edited here'

function validPath(path: unknown): path is string {
  return typeof path === 'string' && !!path && path.length <= PATH_MAX && !path.includes('\0')
}

// ── The edit target, shared by read's `editable` and the write ──────────────

type EditTarget = {
  ok: true
  agentDir: string
  agentSkills: string
  target: string
  folder: string
  md: string
  /** Where the skill folder really is: <real agent folder>/.claude/skills/<folder>. */
  targetReal: string
  /** Every skills root the backup may never land under. */
  roots: string[]
  skillsId: string
  targetId: string
  mdId: string
}

type EditTargetRefusal = SkillEditRefusal & { block: 'scope' | 'linked' }

/**
 * The agent SKILL.md a path names, under Remove's rule and then the stricter
 * one an edit needs: no repo level overlap (install's rule), the skill folder
 * a real folder where the agent folder says it is, and SKILL.md a regular,
 * single link file that is not a link.
 */
function editTarget(input: Omit<WriteSkillInput, 'trashDir' | 'now' | 'payload' | 'platform' | 'step' | 'rename'>, rawPath: unknown): EditTarget | EditTargetRefusal {
  const no = (code: SkillEditCode, message: string, block: 'scope' | 'linked' = 'scope'): EditTargetRefusal => ({
    ok: false,
    code,
    message,
    block,
  })
  const at = agentSkillTarget(input, rawPath)
  if (!at.ok) {
    const linked = at.code === 'scope_refused' && input.agentDir !== null && !agentParentsSafe(resolve(input.agentDir))
    return no(at.code, at.message, linked ? 'linked' : 'scope')
  }
  const { agentDir, agentSkills, target, folder, foreign } = at
  const levels = repoLevels(agentDir).map((l) => join(l, '.claude', 'skills'))
  if (levels.some((r) => existsSync(r) && overlaps(agentSkills, r))) {
    return no('scope_refused', 'the skills folder of this agent is a shared skills folder')
  }
  let st: BigIntStats
  try {
    st = lstatSync(target, { bigint: true })
  } catch {
    return no('not_found', 'that skill is not in this agent folder')
  }
  // a linked skill folder can lead to a computer skill
  if (st.isSymbolicLink()) return no('scope_refused', 'that skill folder is a link, so it is not edited here', 'linked')
  if (!st.isDirectory()) return no('not_found', 'that skill is not in this agent folder')
  const agentReal = realOrNull(agentDir)
  const targetReal = agentReal ? join(agentReal, '.claude', 'skills', folder) : null
  if (!targetReal || realOrNull(target) !== targetReal) {
    return no('scope_refused', 'that skill folder is not where this agent folder says it is', 'linked')
  }
  const md = join(target, 'SKILL.md')
  let mdSt: BigIntStats
  try {
    mdSt = lstatSync(md, { bigint: true })
  } catch {
    return no('not_found', 'that folder is not a skill')
  }
  if (mdSt.isSymbolicLink()) return no('scope_refused', 'the SKILL.md of that skill is a link, so it is not edited here', 'linked')
  if (!mdSt.isFile()) return no('not_found', 'that folder is not a skill')
  // a hard link can be a file from anywhere
  if (mdSt.nlink > 1n) return no('scope_refused', 'the SKILL.md of that skill is a hard link, so it is not edited here', 'linked')
  const skillsId = identOf(agentSkills, false)
  if (!skillsId) return no('not_found', 'this agent has no skills folder')
  return {
    ok: true,
    agentDir,
    agentSkills,
    target,
    folder,
    md,
    targetReal,
    roots: [agentSkills, ...foreign, ...levels],
    skillsId,
    targetId: idOf(st),
    mdId: idOf(mdSt),
  }
}

/** What the shared content rules, and the wider shell shape, refuse in a SKILL.md. */
function contentBlock(content: string): 'invalid' | 'binary' | 'too_large' | 'secret' | 'runs_commands' | null {
  const verdict = checkSkillShareBundle([{ path: 'SKILL.md', content }])
  if (verdict.block !== null) return verdict.block
  return runsShellAnywhere(content) ? 'runs_commands' : null
}

/** A frontmatter scalar as written: quotes folded, a trailing comment cut. */
function scalarOf(value: string): string {
  const quoted = /^(["'])(.*)\1(?:[ \t]+#.*)?$/.exec(value)
  if (quoted) return quoted[2]!
  // An opening quote that does not close on this line: not one name.
  if (/^["']/.test(value)) return ''
  return value.replace(/[ \t]+#.*$/, '')
}

/**
 * The `name:` of a SKILL.md's leading frontmatter as the BACKEND reads it,
 * twin of frontmatterNameOf in backend/src/skills/skill-content.ts (copied,
 * test/skills-backend-twins.test.ts runs the case table its spec runs), or
 * undefined when it has none. A save is refused name_changed when this is
 * not the row's name, so read's `editable` and write's name check use it.
 * Read only after readSkillFrontmatter accepted the block, so the shape is
 * the plain one; a key is compared as that function compares it
 * (no case, `-` or `_`), and a value folded onto indented lines reads as no
 * name at all (''), which never equals a folder name.
 */
export function frontmatterNameOf(content: string): string | undefined {
  const lines = content.split(/\r\n|\r|\n/)
  // trim() also drops a byte order mark, as readSkillFrontmatter does.
  if (lines.length === 0 || lines[0]!.trim() !== '---') return undefined
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '---') return undefined
    const match = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:(?:[ \t]+(.*))?$/.exec(line)
    if (!match) continue
    if (match[1]!.toLowerCase().replace(/[-_]/g, '') !== 'name') continue
    const next = lines[i + 1]
    if (next !== undefined && /^[ \t]/.test(next) && next.trim() !== '') {
      return ''
    }
    return scalarOf((match[2] ?? '').trim())
  }
  return undefined
}

/** A frontmatter `name:` Claude Code would refuse, when there is one. */
function badFrontmatterName(content: string): boolean {
  const name = frontmatterNameOf(content)
  return name !== undefined && !isStrictSkillName(name.trim())
}

/** The backend refuses this save as name_changed (skillWriteRefusal): a `name:` key that does not read as `name`. */
function nameChangedFor(content: string, name: string): boolean {
  return readSkillFrontmatter(content).keys.includes('name') && frontmatterNameOf(content) !== name
}

// ── read_skill ──────────────────────────────────────────────────────────────

export function readSkillFile(input: ReadSkillInput): ReadSkillAnswer {
  const { payload, home } = input
  const log = input.log ?? (() => {})
  const scope = payload.scope
  if (typeof scope !== 'string' || !SCOPES.has(scope)) return refuse('bad_request', 'the scope is not a skills scope')
  const name = payload.name
  if (typeof name !== 'string' || !name || name.length > SKILL_READ_NAME_MAX || LISTED_TEXT_CONTROL.test(name)) {
    return refuse('bad_request', 'the skill name is not a valid skill name')
  }
  const rawPath = payload.path
  if (!validPath(rawPath)) return refuse('bad_request', 'the path is missing or not a path')

  // Read nothing the list does not show: the same scope, path and name, exactly.
  // The path is the row's as shown, or as the backend folded it (any user's
  // home to `~`), which the app sends back; a fold two rows share names none.
  // Only the root and entry the path names are read (listedSkillAt), never
  // the whole list, so a preview does not walk every skill on the computer.
  const row = listedSkillAt(
    { agentDir: input.agentDir, configDir: input.configDir, home, managedDir: input.managedDir, log },
    scope as SkillScope,
    rawPath,
  )
  if (!row || row.name !== name) return refuse('not_found', 'that skill is not in the skills list')

  const skillReal = realOrNull(resolve(expandHome(row.path, home)))
  try {
    if (!skillReal || !statSync(skillReal).isDirectory()) return refuse('not_found', 'that skill is not in the skills list')
  } catch {
    return refuse('not_found', 'that skill is not in the skills list')
  }
  const mdLexical = join(resolve(expandHome(row.path, home)), 'SKILL.md')
  const mdReal = realOrNull(mdLexical)
  if (!mdReal || !inside(mdReal, skillReal)) return refuse('not_found', 'that skill is not in the skills list')

  // A regular single link file, and the very file the path names. Never past
  // the cap: a file past it is withheld whole and carries no hash. Where the
  // platform has O_NOFOLLOW (not win32) the open itself follows no link;
  // everywhere, the open file's identity must be what a NO-FOLLOW lstat finds
  // at mdReal after the open, a regular file and not a link, so a link
  // swapped in after the realpath check is refused on Windows too: a link's
  // own identity is never its target's (finding H7). The lexical
  // <skill>/SKILL.md the list names must still be that file, or a link that
  // still resolves to it (a SKILL.md linked inside its folder reads, preview
  // only).
  const opened: { st?: Stats; id?: string } = {}
  input.step?.('open')
  const head = readHead(mdReal, SKILL_READ_MAX_BYTES + 1, { stat: (st, id) => Object.assign(opened, { st, id }) })
  const st = opened.st
  const readId = opened.id
  if (!head || !st || !readId || !namesOpenedFile(mdReal, mdLexical, readId)) {
    log(`skills: preview of ${rawPath} refused, its SKILL.md could not be read as the listed file`)
    return refuse('read_failed', 'the skill file could not be read')
  }

  let content: string | undefined
  let withheld: 'too_large' | 'binary' | 'secret' | undefined
  if (head.length > SKILL_READ_MAX_BYTES) {
    withheld = 'too_large'
  } else {
    try {
      content = UTF8.decode(head)
    } catch {
      withheld = 'binary'
    }
    if (content !== undefined && content.includes('\0')) {
      content = undefined
      withheld = 'binary'
    } else if (content !== undefined && scanText('SKILL.md', content).length > 0) {
      content = undefined
      withheld = 'secret'
    }
  }

  const editBlock = readEditBlock(input, scope as SkillScope, row.path, name, readId, readOnly(st), st.size, withheld, content)
  return {
    ok: true,
    payload: {
      scope: scope as SkillScope,
      path: rawPath,
      name,
      ...(withheld === 'too_large' ? {} : { sha256: createHash('sha256').update(head).digest('hex') }),
      bytes: st.size,
      modifiedAt: st.mtime.toISOString(),
      ...(content !== undefined ? { content } : {}),
      ...(withheld ? { withheld } : {}),
      editable: editBlock === null,
      ...(editBlock ? { editBlock } : {}),
    },
  }
}

/**
 * Whether the file opened as `readId` is still what `mdReal` names with no
 * link followed (a regular file, not a link, the same bigint identity), and
 * the lexical SKILL.md is that same file or a link that still resolves to
 * mdReal. Taken after the open, so a swap before it cannot pass.
 */
function namesOpenedFile(mdReal: string, mdLexical: string, readId: string): boolean {
  const regularWithId = (path: string): string | null => {
    try {
      const st = lstatSync(path, { bigint: true })
      return st.isSymbolicLink() || !st.isFile() ? null : idOf(st)
    } catch {
      return null
    }
  }
  if (regularWithId(mdReal) !== readId) return false
  if (mdLexical === mdReal) return true
  try {
    if (lstatSync(mdLexical, { bigint: true }).isSymbolicLink()) return realOrNull(mdLexical) === mdReal
  } catch {
    return false
  }
  return regularWithId(mdLexical) === readId
}

/** Why Edit is not offered for this file, or null when a write would take it. Computed live. */
function readEditBlock(
  input: ReadSkillInput,
  scope: SkillScope,
  rawPath: string,
  name: string,
  readId: string,
  isReadOnly: boolean,
  bytes: number,
  withheld: 'too_large' | 'binary' | 'secret' | undefined,
  content: string | undefined,
): SkillEditBlock | null {
  if (scope !== 'agent') return 'scope'
  const t = editTarget(input, rawPath)
  if (!t.ok) return t.block
  if (t.mdId !== readId) return 'linked'
  // Every save of a read only file would fail at the rename (Windows) after keeping a backup.
  if (isReadOnly) return 'read_only'
  if (withheld) return withheld
  if (bytes > SKILL_WRITE_MAX_BYTES || content === undefined) return 'too_large'
  const block = contentBlock(content)
  if (block) return block
  // A save takes the strict name only, held to the frontmatter name the backend reads.
  if (!isStrictSkillName(name) || badFrontmatterName(content) || nameChangedFor(content, name)) return 'invalid'
  return null
}

// ── write_skill ─────────────────────────────────────────────────────────────

const CONTENT_REFUSED: Record<string, string> = {
  invalid: 'this edit has a frontmatter block the skill rules cannot read (invalid)',
  binary: 'this edit is not text (binary)',
  too_large: 'this edit is too large (too_large)',
  secret: 'this edit holds what looks like a secret (secret)',
  runs_commands: 'this edit would let the skill run commands (runs_commands)',
}

/** Synchronous on purpose: frames run concurrently, and two saves must never interleave. */
export function writeAgentSkill(input: WriteSkillInput): WriteSkillAnswer {
  const { payload, home } = input
  const log = input.log ?? (() => {})
  const rename = input.rename ?? renameSync

  // ── The edit itself ──
  if (payload.scope !== 'agent') return refuse('scope_refused', 'only a skill in this agent folder can be edited here')
  const name = payload.name
  if (!isStrictSkillName(name)) return refuse('bad_request', 'the skill name is not a valid skill name')
  const expectSha256 = payload.expectSha256
  if (typeof expectSha256 !== 'string' || !SHA256_RE.test(expectSha256)) {
    return refuse('bad_request', 'the edit does not carry the sha256 of the copy it changes')
  }
  const content = payload.content
  if (typeof content !== 'string' || LONE_SURROGATE.test(content)) {
    return refuse('bad_request', 'the edit is not text')
  }
  const next = Buffer.from(content, 'utf8')
  if (next.length > SKILL_WRITE_MAX_BYTES) return refuse('content_refused', CONTENT_REFUSED.too_large!)
  if (content.includes('\0')) return refuse('content_refused', CONTENT_REFUSED.binary!)

  // ── Where: one agent SKILL.md, by scope plus path ──
  const t = editTarget(input, payload.path)
  if (!t.ok) return refuse(t.code, t.message)
  if (name !== listedEntryName(t.folder) && name !== listedNameOf(t.target)) {
    return refuse('bad_request', 'the skill name does not match the folder the path names')
  }
  const shown = displayPath(t.target, home)

  // ── The copy on disk now ──
  const opened: { st?: Stats; id?: string } = {}
  const current = readHead(t.md, SKILL_WRITE_MAX_BYTES + 1, { stat: (st, id) => Object.assign(opened, { st, id }) })
  const currentSt = opened.st
  if (!current || !currentSt || !opened.id) return refuse('read_failed', 'the skill file could not be read')
  if (opened.id !== t.mdId) return refuse('changed_since_preview', 'the skill changed on the computer since you opened it')
  // Before any backup or temp: a save of a read only file can never land (read answers editBlock read_only).
  if (readOnly(currentSt)) return refuse('read_only', READ_ONLY_MESSAGE)
  if (current.length > SKILL_WRITE_MAX_BYTES) {
    return refuse('content_refused', 'the skill file is too large to edit here (too_large)')
  }
  const currentSha = createHash('sha256').update(current).digest('hex')
  const nextSha = createHash('sha256').update(next).digest('hex')
  // A second Save tap, or a re emit under a new rpcId, is the same edit: not a conflict.
  if (nextSha === currentSha) {
    return {
      ok: true,
      payload: {
        scope: 'agent',
        path: shown,
        name,
        sha256: currentSha,
        bytes: current.length,
        modifiedAt: currentSt.mtime.toISOString(),
        unchanged: true,
      },
    }
  }
  if (currentSha !== expectSha256) return refuse('changed_since_preview', 'the skill changed on the computer since you opened it')

  // ── The content rules ──
  const block = contentBlock(content)
  if (block) return refuse('content_refused', CONTENT_REFUSED[block]!)
  if (badFrontmatterName(content)) return refuse('bad_request', 'the frontmatter name is not a valid skill name')
  if (nameChangedFor(content, name)) return refuse('bad_request', 'the frontmatter name is not the name of this skill')

  // ── The old bytes go to the trash first, outside every skills root ──
  const trashDir = resolve(input.trashDir)
  if (t.roots.some((r) => wouldBeUnder(trashDir, r))) {
    return refuse('write_failed', 'the trash folder is inside a skills folder, so nothing was saved')
  }
  try {
    mkdirSync(trashDir, { recursive: true })
    const stamp = String(input.now()).padStart(15, '0')
    let backup = join(trashDir, `${stamp}-${t.folder}.SKILL.md`)
    for (let n = 2; existsSync(backup) || existsSync(backup + '.json'); n++) {
      backup = join(trashDir, `${stamp}-${n}-${t.folder}.SKILL.md`)
    }
    // wx: never through a link, never over a file
    writeFileSync(backup, current, { flag: 'wx', mode: 0o600 })
    try {
      writeFileSync(
        backup + '.json',
        JSON.stringify(
          { name, scope: 'agent', path: shown, editedAt: new Date(input.now()).toISOString(), sha256: currentSha },
          null,
          1,
        ),
        { flag: 'wx' },
      )
    } catch {
      // the old bytes are kept; the note beside them is only a label
    }
  } catch (err) {
    log(`skills: edit of ${shown} failed keeping the old copy: ${displayPath(String((err as Error)?.message ?? err), home)}`)
    return refuse('write_failed', 'the old copy could not be kept in the trash, so nothing was saved')
  }

  // ── The new bytes, in a temp file beside SKILL.md ──
  const temp = join(t.target, `${EDIT_TEMP_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}`)
  // Where the temp must really be: O_NOFOLLOW guards only the last segment
  // (and Windows ignores it), so a skill folder swapped for a link at the open
  // puts the temp wherever the link leads.
  const tempAt = join(t.targetReal, basename(temp))
  let tempId: string | null = null
  let tempReal: string | null = null
  const dropTemp = () => {
    // Only the file this save made, by identity, at the path it was made by
    // and where it really landed (taken right after the open).
    for (const at of new Set([temp, tempReal])) {
      if (at === null) continue
      try {
        if (tempId === null ? at === temp : identOf(at, false) === tempId) rmSync(at, { force: true })
      } catch (err) {
        log(`skills: edit of ${shown} could not clean its temp file: ${displayPath(String((err as Error)?.message ?? err), home)}`)
      }
    }
  }
  let misplaced = false
  try {
    input.step?.('open_temp')
    // A fixed owner only mode at the create: a temp made through a swapped
    // folder, which the save may not find again, never takes a mode from the
    // agent's own SKILL.md.
    const fd = openSync(
      temp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      input.step?.('opened')
      tempId = idOf(fstatSync(fd, { bigint: true }))
      tempReal = realOrNull(temp)
      // Found in the real skill folder before a byte goes in, or nothing goes in.
      misplaced = tempReal !== tempAt || identOf(temp, false) !== tempId
      if (!misplaced) {
        for (let at = 0; at < next.length; ) {
          at += writeSync(fd, next, at, next.length - at)
          input.step?.('wrote')
        }
        // Placed: now the old file's mode, exactly (never wider), on this fd.
        fchmodSync(fd, currentSt.mode & 0o777)
        fsyncSync(fd)
      }
    } finally {
      closeSync(fd)
    }
  } catch (err) {
    dropTemp()
    log(`skills: edit of ${shown} failed writing: ${displayPath(String((err as Error)?.message ?? err), home)}`)
    return refuse('write_failed', 'the skill could not be saved')
  }
  if (misplaced) {
    dropTemp()
    log(`skills: edit of ${shown} refused, its temp file was not made in the skill folder`)
    return refuse('scope_refused', 'the skill folder changed while saving, so nothing was saved')
  }

  // ── Checked again right before the rename: a swap in between would write elsewhere ──
  // The rename's source too: the temp this save wrote, reachable at its path,
  // in the real skill folder (its parent is t.target), so neither end of the
  // rename can lead out of the agent folder.
  input.step?.('recheck')
  if (
    !agentParentsSafe(t.agentDir) ||
    identOf(t.agentSkills, false) !== t.skillsId ||
    identOf(t.target, false) !== t.targetId ||
    realOrNull(t.target) !== t.targetReal ||
    identOf(temp, false) !== tempId ||
    realOrNull(temp) !== tempAt
  ) {
    dropTemp()
    return refuse('scope_refused', 'the skill folder changed while saving, so nothing was saved')
  }
  let mdNow: BigIntStats
  try {
    mdNow = lstatSync(t.md, { bigint: true })
  } catch {
    dropTemp()
    return refuse('changed_since_preview', 'the skill changed on the computer since you opened it')
  }
  if (mdNow.isSymbolicLink() || !mdNow.isFile() || mdNow.nlink > 1n) {
    dropTemp()
    return refuse('scope_refused', 'the skill file changed while saving, so nothing was saved')
  }
  if (readOnly(mdNow)) {
    dropTemp()
    return refuse('read_only', READ_ONLY_MESSAGE)
  }
  const again = readHead(t.md, SKILL_WRITE_MAX_BYTES + 1)
  if (idOf(mdNow) !== t.mdId || !again || createHash('sha256').update(again).digest('hex') !== currentSha) {
    dropTemp()
    return refuse('changed_since_preview', 'the skill changed on the computer since you opened it')
  }

  try {
    rename(temp, t.md)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    dropTemp()
    log(`skills: edit of ${shown} failed moving into place: ${displayPath(String((err as Error)?.message ?? err), home)}`)
    if (input.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
      return refuse('write_failed', 'the skill file is in use, try again')
    }
    return refuse('write_failed', 'the skill could not be saved')
  }

  // ── And checked after it: the saved file is the temp, where the agent folder says ──
  if (identOf(t.md, false) !== tempId) {
    log(`skills: edit of ${shown} found another file in place after the rename`)
    return refuse('write_failed', 'the saved skill file is not the one written')
  }
  if (
    !agentParentsSafe(t.agentDir) ||
    identOf(t.agentSkills, false) !== t.skillsId ||
    identOf(t.target, false) !== t.targetId
  ) {
    log(`skills: edit of ${shown} found the skill folder changed while saving`)
    return refuse('scope_refused', 'the skill folder changed while saving')
  }
  let saved: Stats
  try {
    saved = statSync(t.md)
  } catch {
    return refuse('write_failed', 'the saved skill file could not be read back')
  }
  log(`skills: edited ${shown} (the old copy is in the trash)`)
  return {
    ok: true,
    payload: { scope: 'agent', path: shown, name, sha256: nextSha, bytes: next.length, modifiedAt: saved.mtime.toISOString() },
  }
}
