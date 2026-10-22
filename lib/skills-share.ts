/**
 * Share a skill (skills view design, section 7 row 6, Claude Code part): the
 * two skills_rpc ops that move a skill between agents.
 *
 *   export_skill    reads ONE skill folder of this agent (scope agent) or of
 *                   this computer (scope computer, KC decision 4), symlink
 *                   safe, applies the shared content rules
 *                   (lib/skill-share-content-rules.ts) and answers the files
 *                   the rules send, with their sha256 and the bundle's.
 *                   Reading only: dryRun changes one thing, a blocked skill
 *                   answers its verdict for the preview but is REFUSED for
 *                   the real export, so its content never leaves to be stored.
 *                   A skill blocked for a secret, too large or binary is
 *                   refused for the preview too: no credential, whole or
 *                   cut, ever leaves this computer.
 *   install_bundle  writes a bundle the owner approved into this agent's OWN
 *                   skills folder, <agent folder>/.claude/skills/<name>, and
 *                   nowhere else (design 4.4): never ~/.claude/skills, never
 *                   the config dir, never a repo level. Every file's sha256
 *                   and the bundle's are checked, then the content rules run
 *                   again (a file the source should have left behind refuses
 *                   the bundle), then the files are written into a temp
 *                   folder beside the skills folder and renamed into place.
 *
 * Refused before anything is written: a name outside Claude Code's rule, a
 * bundle path that is absolute, has a `.` or `..` segment or a backslash, a
 * `.claude` or `.claude/skills` that is a link, an agent skills folder that is
 * the computer's, and an existing skill of the same name (case folded, NFC)
 * unless replace, which moves the old one to the plugin state trash first.
 *
 * The resend rule: the backend re emits once, and the owner can tap Install
 * again after a timeout, with a new rpcId each time. A skill already on disk
 * under that name whose files hash to the bundle's sha256 is answered as
 * installed, which survives a daemon restart (the memory dedupe on offerId is
 * in lib/skills-rpc.ts).
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
  constants as fsConstants,
  type Stats,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import {
  SKILL_SHARE_MAX_FILES,
  SKILL_SHARE_MAX_FILE_BYTES,
  SKILL_SHARE_MAX_TOTAL_BYTES,
  SKILL_SHARE_RULES_VERSION,
  WINDOWS_RESERVED,
  bundleSha256,
  checkSkillShareBundle,
  exclusionOf,
  isStrictSkillName,
  isValidBundlePath,
  readSkillFrontmatter,
  sha256Hex,
  verifyStoredBundle,
  type SkillShareInputFile,
} from './skill-share-content-rules.ts'
import { scanText } from './secret-scan.ts'
import {
  SKILLS_ROOT_MAX,
  agentParentsSafe,
  computerRoots,
  displayPath,
  entryPathRefused,
  identOf,
  inside,
  listedEntryName,
  listedNameOf,
  nameKey,
  overlaps,
  realOrNull,
  removeAgentSkill,
  repoLevels,
  statIdentity,
  wouldBeUnder,
} from './skills-inventory.ts'

/** Why a file the walk found stays behind, beyond the rules' own reasons. */
export type WalkExclusion = 'hidden' | 'not_text' | 'symlink' | 'outside'

export type ShareFailureCode =
  | 'bad_request'
  | 'not_found'
  | 'unavailable'
  | 'share_blocked'
  | 'name_taken'
  | 'hash_mismatch'
  | 'not_supported'
  | 'write_failed'
  | 'scope_refused'
  | 'read_failed'

export type ShareFailure = { ok: false; code: ShareFailureCode; message: string }

export type ExportedFile = { path: string; content: string; bytes: number; sha256: string }

export type ExportAnswer =
  | {
      ok: true
      payload: {
        name: string
        scope: 'agent' | 'computer'
        description: string
        rulesVersion: number
        files: ExportedFile[]
        excluded: { path: string; reason: string }[]
        sha256: string
        scan: { clean: boolean; rules: string[] }
        block?: string
      }
    }
  | ShareFailure

export type InstallAnswer = { ok: true; payload: { path: string; name: string } } | ShareFailure

/** Bounds on one skill folder walk. */
const WALK_MAX_ENTRIES = 2000
const WALK_MAX_DEPTH = 12
/** Excluded rows sent back at most (the backend keeps 200). */
const EXCLUDED_MAX = 200
/** Files an install_bundle may carry before anything is hashed (the backend refuses past 500). */
const BUNDLE_FILES_MAX = 500
const OFFER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const TEMP_PREFIX = '.skill-install-'

function fail(code: ShareFailureCode, message: string): ShareFailure {
  return { ok: false, code, message }
}

// ── Reading one skill folder ────────────────────────────────────────────────

export type FolderRead = {
  /** Every file the walk found, for the rules: content '' only for a path the rules exclude or refuse by name. */
  input: SkillShareInputFile[]
  /** What the walk itself left behind, before the rules saw anything. */
  walkExcluded: { path: string; reason: WalkExclusion }[]
  /** The walk stopped at a bound (entries, depth, files or bytes): the folder is too large to share. */
  truncated: boolean
  /** A file the rules would send could not be read: the folder cannot be shared as it is. */
  unreadable: boolean
}

/** What a reader may ask of readHead beyond the bytes (lib/skills-edit.ts). */
export type ReadHeadOptions = {
  /**
   * Handed the open file's fstat (Numbers, for its size, mode and mtime) and
   * its exact identity, so a caller can check it is the file it meant. The
   * identity comes from a bigint fstat of the same fd (statIdentity): a
   * Number stat rounds an NTFS id past 2^53.
   */
  stat?: (st: Stats, id: string) => void
}

/**
 * At most `max` bytes of a regular file, opened without following a link.
 * Nothing past `max` is ever read: a multi GB file costs no more than the cap.
 */
export function readHead(path: string, max: number, opts: ReadHeadOptions = {}): Buffer | null {
  let fd: number
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0))
  } catch {
    return null
  }
  try {
    // a FIFO or device would block or never end, and a hard link swapped in
    // after the walk's lstat could be any file: regular, single link files only
    const st = fstatSync(fd, { bigint: true })
    if (!st.isFile() || st.nlink > 1n) return null
    if (opts.stat) opts.stat(fstatSync(fd), statIdentity(st))
    const buf = Buffer.alloc(max)
    let got = 0
    while (got < max) {
      const n = readSync(fd, buf, got, max - got, got)
      if (n <= 0) break
      got += n
    }
    return buf.subarray(0, got)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

export const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * The files of one skill folder, keyed by their path relative to it (`/`
 * separated, NFC). Symlink safe: no link is ever followed (a link inside the
 * folder could name a dot or secret file under a harmless name, security
 * review 2), a hard linked file (it can be any file on the disk) and anything
 * that is not a regular file stay behind, and a dot folder is not walked at
 * all. Bounded: at most SKILL_SHARE_MAX_FILES + 1 files are read, each at
 * most SKILL_SHARE_MAX_FILE_BYTES + 1 bytes, which is enough for the rules to
 * say too_large; past any bound the walk stops and says `truncated`, never
 * handing the rules an unread file as if it were empty (security review 3).
 */
export function readSkillFolder(skillReal: string): FolderRead {
  const input: SkillShareInputFile[] = []
  const walkExcluded: FolderRead['walkExcluded'] = []
  const stack: Array<[string, string[]]> = [[skillReal, []]]
  let entries = 0
  let readFiles = 0
  let readBytes = 0
  let unreadable = false
  const done = (truncated: boolean): FolderRead => ({ input, walkExcluded, truncated, unreadable })
  while (stack.length) {
    const [dir, segments] = stack.pop()!
    let names: string[]
    try {
      names = readdirSync(dir).sort()
    } catch {
      // a folder that cannot be listed would leave its files out silently
      unreadable = true
      continue
    }
    for (const name of names) {
      if (++entries > WALK_MAX_ENTRIES) return done(true)
      const rel = [...segments, name].join('/').normalize('NFC')
      const abs = join(dir, name)
      let st
      try {
        st = lstatSync(abs)
      } catch {
        unreadable = true
        continue
      }
      if (st.isSymbolicLink()) {
        walkExcluded.push({ path: rel, reason: 'symlink' })
        continue
      }
      if (st.isDirectory()) {
        if (name.startsWith('.')) {
          walkExcluded.push({ path: rel, reason: 'hidden' })
        } else if (segments.length + 1 <= WALK_MAX_DEPTH) {
          stack.push([abs, [...segments, name]])
        } else {
          return done(true)
        }
        continue
      }
      if (!st.isFile() || st.nlink > 1) {
        walkExcluded.push({ path: rel, reason: 'outside' })
        continue
      }
      // A path the rules exclude or refuse is never read: its name is all they need.
      if (!isValidBundlePath(rel) || exclusionOf(rel) !== null) {
        input.push({ path: rel, content: '' })
        continue
      }
      if (readFiles > SKILL_SHARE_MAX_FILES || readBytes > SKILL_SHARE_MAX_TOTAL_BYTES) return done(true)
      const head = readHead(abs, SKILL_SHARE_MAX_FILE_BYTES + 1)
      if (head === null) {
        unreadable = true
        continue
      }
      let content: string
      if (head.length > SKILL_SHARE_MAX_FILE_BYTES) {
        // too large either way; the cut may split a character, which no longer matters
        content = head.toString('utf8')
      } else {
        try {
          content = UTF8.decode(head)
        } catch {
          // not UTF-8 is not text: it stays behind rather than ship altered
          walkExcluded.push({ path: rel, reason: 'not_text' })
          continue
        }
      }
      // only what reaches the rules counts toward the bounds
      readFiles += 1
      readBytes += head.length
      input.push({ path: rel, content })
    }
  }
  return done(false)
}

/**
 * A shell block Claude Code runs on load wherever it opens, not only at the
 * start of a line: Claude Code 2.1.296 matches ```! with no line anchor
 * (security review 1). The shared rules (version 1) only see a fence at the
 * start of a line, so this daemon refuses the wider shape on top of them, on
 * export and on install. Stricter than the rules, never looser; the backend
 * twin should adopt it with a rules version bump.
 */
export function runsShellAnywhere(content: string): boolean {
  return /(`{3,}|~{3,})[ \t]*!/.test(content)
}

// ── export_skill ────────────────────────────────────────────────────────────

export type ExportSkillInput = {
  agentDir: string | null
  configDir: string
  home: string
  managedDir: string
  payload: Record<string, unknown>
  log?: (msg: string) => void
}

/**
 * A folder the list shows as a skill (lib/skills-inventory.ts readSkill): a
 * folder holding a SKILL.md that is a regular file inside it and not hard
 * linked. Export reads nothing the list does not show.
 */
function listable(folder: string): boolean {
  // the list drops a skill whose folder or listed name looks like a secret
  const listed = listedNameOf(folder)
  if (scanText('name', basename(folder)).length > 0 || (listed && scanText('name', listed).length > 0)) return false
  try {
    const real = realOrNull(folder)
    if (!real || !statSync(real).isDirectory()) return false
    const md = join(real, 'SKILL.md')
    lstatSync(md)
    const mdReal = realOrNull(md)
    if (!mdReal || !inside(mdReal, real)) return false
    const st = statSync(mdReal)
    return st.isFile() && st.nlink <= 1
  } catch {
    return false
  }
}

/**
 * The skill folder whose list row is named `name`, resolved the way the list
 * names a row (its frontmatter name, else its folder name cleaned), so a share never
 * reads a different skill than the row the owner tapped (security review 5).
 * Null when none matches, 'ambiguous' when more than one does.
 */
function findSkillFolder(root: string, name: string, home: string, skip?: string): string | null | 'ambiguous' {
  let names: string[]
  try {
    names = readdirSync(root).sort()
  } catch {
    return null
  }
  const matches = names
    .filter((n) => !n.startsWith('.') && n !== skip)
    .slice(0, SKILLS_ROOT_MAX)
    // a folder with no frontmatter name is listed under its entry cleaned
    // (listedEntryName); one whose path the app could not send back is not
    // listed (entryPathRefused, the list's own predicate)
    .filter((n) => !entryPathRefused(root, n, home))
    .filter((n) => listable(join(root, n)) && (listedNameOf(join(root, n)) ?? listedEntryName(n)) === name)
  if (matches.length > 1) return 'ambiguous'
  return matches.length === 1 ? join(root, matches[0]!) : null
}

export function exportSkill(input: ExportSkillInput): ExportAnswer {
  const { payload, home } = input
  const log = input.log ?? (() => {})
  const name = payload.name
  const scope = payload.scope
  // Only a literal `dryRun: true` is a preview; anything else is the real export.
  const dryRun = payload.dryRun === true
  if (!isStrictSkillName(name)) return fail('bad_request', 'the skill name is not a valid skill name')
  if (scope !== 'agent' && scope !== 'computer') {
    return fail('scope_refused', 'only a skill of this agent or of this computer can be shared')
  }

  const foreign = computerRoots(input.configDir, home, input.managedDir).filter((r) => existsSync(r))
  let root: string
  if (scope === 'agent') {
    if (input.agentDir === null) {
      return fail('unavailable', 'this agent was started without its launch folder, so it has no agent skills')
    }
    root = join(resolve(input.agentDir), '.claude', 'skills')
    if (existsSync(root) && foreign.some((f) => overlaps(root, f))) {
      return fail('scope_refused', 'the skills folder of this agent is the computer skills folder')
    }
  } else {
    if (name === 'synced') return fail('scope_refused', 'synced skills are not shareable')
    root = join(input.configDir, 'skills')
  }

  // the computer root lists synced as its own read only scope
  const found = findSkillFolder(root, name, home, scope === 'computer' ? 'synced' : undefined)
  if (found === 'ambiguous') return fail('bad_request', 'more than one skill in this folder has that name')
  const folder = found
  const skillReal = folder ? realOrNull(folder) : null
  if (!folder || !skillReal) return fail('not_found', 'that skill is not in this folder')
  try {
    if (!statSync(skillReal).isDirectory()) return fail('not_found', 'that skill is not a folder')
  } catch {
    return fail('not_found', 'that skill is not in this folder')
  }

  const read = readSkillFolder(skillReal)
  if (read.unreadable) return fail('read_failed', 'a file of this skill could not be read')
  const ruled = checkSkillShareBundle(read.input)
  // The rules' order: invalid, binary, too_large, secret, runs_commands.
  const verdict = {
    ...ruled,
    block:
      read.truncated && ruled.block !== 'invalid' && ruled.block !== 'binary'
        ? ('too_large' as const)
        : ruled.block === null && read.input.some((f) => runsShellAnywhere(f.content))
          ? ('runs_commands' as const)
          : ruled.block,
  }
  const byPath = new Map(read.input.map((f) => [f.path, f.content]))
  const files: ExportedFile[] = verdict.files.map((f) => ({ ...f, content: byPath.get(f.path) ?? '' }))
  const excluded = [
    ...verdict.excluded,
    ...read.walkExcluded.filter((e) => isValidBundlePath(e.path)),
  ].slice(0, EXCLUDED_MAX)
  // The rules scan the names of the files they leave behind; the walk's own
  // are shown and stored the same way, so they are scanned the same way.
  const walkSecret = read.walkExcluded.some((e) => scanText(e.path, e.path).length > 0)
  const skillMd = byPath.get('SKILL.md')
  const description = typeof skillMd === 'string' ? readSkillFrontmatter(skillMd).description : ''

  // The real export never carries a blocked skill's content, and a secret
  // never leaves this computer at all, not even for a preview, whatever block
  // outranks it: the backend that asks may not be the one the owner trusts.
  if (!ruled.scan.clean || walkSecret) {
    log(`skills: export of ${displayPath(folder, home)} refused, a secret`)
    return fail('share_blocked', 'this skill cannot be shared (secret)')
  }
  // A too large or binary file may be cut mid secret, below what the scan
  // can see, or decoded lossily: such a skill sends no content even for a
  // preview. The list already marks it, so the sheet is not offered.
  if (verdict.block !== null && (!dryRun || verdict.block === 'too_large' || verdict.block === 'binary')) {
    log(`skills: export of ${displayPath(folder, home)} refused, ${verdict.block}`)
    return fail('share_blocked', `this skill cannot be shared (${verdict.block})`)
  }
  return {
    ok: true,
    payload: {
      name,
      scope,
      description,
      rulesVersion: SKILL_SHARE_RULES_VERSION,
      files,
      excluded,
      sha256: verdict.sha256,
      scan: verdict.scan,
      ...(verdict.block !== null ? { block: verdict.block } : {}),
    },
  }
}

// ── install_bundle ──────────────────────────────────────────────────────────

export type InstallBundleInput = {
  agentDir: string | null
  configDir: string
  home: string
  managedDir: string
  /** The plugin state trash Replace moves the old copy to. */
  trashDir: string
  platform: NodeJS.Platform
  now: () => number
  payload: Record<string, unknown>
  progress?: (stage: 'verifying' | 'writing') => void | Promise<void>
  /** The final move; renameSync unless a test stands in for it. */
  rename?: (from: string, to: string) => void
  log?: (msg: string) => void
}

type BundleFile = { path: string; sha256: string; content: string }

function bundleFiles(raw: unknown): BundleFile[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > BUNDLE_FILES_MAX) return null
  const out: BundleFile[] = []
  for (const f of raw) {
    if (!f || typeof f !== 'object') return null
    const { path, sha256, content } = f as Record<string, unknown>
    if (typeof path !== 'string' || typeof sha256 !== 'string' || typeof content !== 'string') return null
    out.push({ path, sha256, content })
  }
  return out
}

/** The bundle sha256 of a folder on disk, the way an export would compute it, or null. */
function folderSha256(folder: string): string | null {
  try {
    const st = lstatSync(folder)
    if (st.isSymbolicLink() || !st.isDirectory()) return null
  } catch {
    return null
  }
  const read = readSkillFolder(folder)
  if (read.walkExcluded.length > 0 || read.truncated || read.unreadable) return null
  const verdict = verifyStoredBundle(read.input)
  return verdict.block === null ? verdict.sha256 : null
}

function removeTemp(temp: string | null, log: (m: string) => void): void {
  if (!temp) return
  try {
    // rmSync never follows a link inside the folder it removes
    rmSync(temp, { recursive: true, force: true })
  } catch (err) {
    log(`skills: install could not clean its temp folder: ${String((err as Error)?.message ?? err)}`)
  }
}

/** A real folder at `path`, made when missing; false when it is a link or not a folder. */
function ensureRealDir(path: string): boolean {
  try {
    const st = lstatSync(path)
    return !st.isSymbolicLink() && st.isDirectory()
  } catch {
    try {
      mkdirSync(path)
    } catch {
      return false
    }
    try {
      const st = lstatSync(path)
      return !st.isSymbolicLink() && st.isDirectory()
    } catch {
      return false
    }
  }
}

export async function installBundle(input: InstallBundleInput): Promise<InstallAnswer> {
  const { payload, home } = input
  const log = input.log ?? (() => {})
  const rename = input.rename ?? renameSync
  const progress = async (stage: 'verifying' | 'writing') => {
    try {
      await input.progress?.(stage)
    } catch {
      // progress is best effort
    }
  }

  // ── The bundle itself ──
  if (typeof payload.offerId !== 'string' || !OFFER_ID_RE.test(payload.offerId)) {
    return fail('write_failed', 'the offer id is missing or not an offer id')
  }
  const name = payload.name
  if (!isStrictSkillName(name)) return fail('scope_refused', 'the skill name is not a valid skill name')
  if (input.platform === 'win32' && WINDOWS_RESERVED.test(name)) {
    return fail('scope_refused', 'that skill name is reserved on Windows')
  }
  const files = bundleFiles(payload.files)
  if (!files) return fail('write_failed', 'the bundle has no files or is not a bundle')
  if (typeof payload.sha256 !== 'string' || !SHA256_RE.test(payload.sha256)) {
    return fail('hash_mismatch', 'the bundle carries no sha256')
  }
  const replace = payload.replace === true

  await progress('verifying')
  for (const f of files) {
    if (sha256Hex(f.content) !== f.sha256) return fail('hash_mismatch', 'a file does not match its sha256')
  }
  const verdict = verifyStoredBundle(files.map((f) => ({ path: f.path, content: f.content })))
  if (verdict.block !== null) {
    return fail('scope_refused', `the bundle breaks the share rules (${verdict.block})`)
  }
  if (files.some((f) => runsShellAnywhere(f.content))) {
    return fail('scope_refused', 'the bundle breaks the share rules (runs_commands)')
  }
  if (verdict.files.length !== files.length || bundleSha256(verdict.files) !== payload.sha256) {
    return fail('hash_mismatch', 'the bundle does not match its sha256')
  }

  // ── Where it goes: this agent's own skills folder, nothing else ──
  if (input.agentDir === null) {
    return fail('not_supported', 'this agent was started without its launch folder, so it has no skills folder of its own')
  }
  const agentDir = resolve(input.agentDir)
  try {
    if (!statSync(agentDir).isDirectory()) return fail('not_supported', 'the agent folder is not a folder')
  } catch {
    return fail('not_supported', 'the agent folder does not exist')
  }
  const claudeDir = join(agentDir, '.claude')
  const agentSkills = join(claudeDir, 'skills')
  const foreign = computerRoots(input.configDir, home, input.managedDir)
  const sharedRoots = [...foreign, ...repoLevels(agentDir).map((l) => join(l, '.claude', 'skills'))]
  if (sharedRoots.some((r) => wouldBeUnder(agentSkills, r) || (existsSync(r) && existsSync(agentSkills) && overlaps(agentSkills, r)))) {
    return fail('scope_refused', 'the skills folder of this agent is a shared skills folder')
  }
  if (!ensureRealDir(claudeDir) || !ensureRealDir(agentSkills) || !agentParentsSafe(agentDir)) {
    return fail('scope_refused', 'the skills folder of this agent is a link, so nothing is written in it')
  }
  if (sharedRoots.some((r) => existsSync(r) && overlaps(agentSkills, r))) {
    return fail('scope_refused', 'the skills folder of this agent is a shared skills folder')
  }
  const skillsId = identOf(agentSkills, false)
  const dest = join(agentSkills, name)
  const shown = displayPath(dest, home)

  // ── Already there (a resend, or a tap after a timeout) ──
  if (folderSha256(dest) === payload.sha256) {
    log(`skills: install of ${shown} answered from disk, it is already installed`)
    return { ok: true, payload: { path: shown, name } }
  }

  let taken: string[]
  try {
    taken = readdirSync(agentSkills).filter((n) => nameKey(n) === nameKey(name))
  } catch {
    return fail('write_failed', 'the skills folder of this agent could not be read')
  }
  if (taken.length > 0 && !replace) return fail('name_taken', 'this agent already has a skill of that name')

  // ── Write into a temp folder beside the skills folder, never inside it ──
  await progress('writing')
  let temp: string | null = null
  try {
    temp = mkdtempSync(join(claudeDir, TEMP_PREFIX))
    for (const f of files) {
      const target = resolve(temp, ...f.path.split('/'))
      if (!inside(target, temp)) throw new Error('a bundle path left the temp folder')
      mkdirSync(dirname(target), { recursive: true })
      // wx: never through a link, never over a file
      writeFileSync(target, f.content, { flag: 'wx', mode: 0o644 })
    }
  } catch (err) {
    removeTemp(temp, log)
    log(`skills: install of ${shown} failed writing: ${displayPath(String((err as Error)?.message ?? err), home)}`)
    return fail('write_failed', 'the skill could not be written')
  }
  if (folderSha256(temp) !== payload.sha256) {
    removeTemp(temp, log)
    return fail('write_failed', 'the written skill does not match the bundle')
  }

  // ── Replace: the old copy goes to the trash first ──
  const trashed: Array<{ from: string; to: string }> = []
  const putBack = () => {
    for (const t of trashed.reverse()) {
      try {
        renameSync(t.to, t.from)
      } catch (err) {
        log(`skills: install could not put ${displayPath(t.from, home)} back from the trash: ${String((err as Error)?.message ?? err)}`)
      }
    }
  }
  for (const old of taken) {
    const removed = removeAgentSkill({
      agentDir: input.agentDir,
      configDir: input.configDir,
      home,
      managedDir: input.managedDir,
      trashDir: input.trashDir,
      now: input.now,
      payload: { scope: 'agent', name: old, path: join(agentSkills, old) },
      log,
    })
    if (!removed.ok) {
      putBack()
      removeTemp(temp, log)
      return fail('name_taken', `the skill of that name could not be replaced: ${removed.message}`)
    }
    if (removed.trashedTo) trashed.push({ from: join(agentSkills, old), to: removed.trashedTo })
  }

  // ── Into place ──
  if (!agentParentsSafe(agentDir) || identOf(agentSkills, false) !== skillsId) {
    putBack()
    removeTemp(temp, log)
    return fail('scope_refused', 'the skills folder of this agent changed while installing, so nothing was written')
  }
  let claimed = false
  try {
    if (input.platform !== 'win32') {
      // Claim the name first: mkdir fails on anything already there, and a
      // rename onto an EMPTY folder replaces it in one step, never a full one.
      mkdirSync(dest)
      claimed = true
    } else if (existsSync(dest)) {
      throw Object.assign(new Error('the name is taken'), { code: 'EEXIST' })
    }
    rename(temp, dest)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (claimed) {
      try {
        rmdirSync(dest)
      } catch {
        // not empty means someone else's: leave it
      }
    }
    putBack()
    removeTemp(temp, log)
    log(`skills: install of ${shown} failed moving into place: ${displayPath(String((err as Error)?.message ?? err), home)}`)
    if (code === 'EEXIST') return fail('name_taken', 'this agent already has a skill of that name')
    return fail('write_failed', 'the skill could not be moved into the skills folder')
  }
  log(`skills: installed ${shown}${taken.length ? ' (replaced, the old copy is in the trash)' : ''}`)
  return { ok: true, payload: { path: shown, name } }
}
