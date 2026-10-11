/**
 * THE content rules of a shared skill (skills view design 4.2), ported from
 * the backend's backend/src/skills/skill-share-content-rules.ts (BGOS branch
 * feat/skills-share-backend, rules version 1). The source daemon runs it to
 * build the preview and the bundle, the target daemon runs it again on the
 * bundle it is asked to install, and the backend runs it a third time on what
 * it stores. lib/skill-share-content-fixture.ts is the backend's fixture copied
 * byte for byte, and test/skill-share-content-rules.test.ts asserts the same
 * verdicts over it and pins its sha256, so a rule changed on one side only
 * turns that side red.
 *
 * Two outcomes per file:
 *   - EXCLUDED: stays behind on the source computer, by design (scripts, dot
 *     paths, secret looking names, the Codex tool manifest).
 *   - BLOCK: the whole share is refused (bad path, NUL byte, caps, a secret,
 *     executable frontmatter or shell lines). Never stripped and resent.
 *
 * The one difference from the backend: the secret scan is this plugin's twin
 * (lib/secret-scan.ts, same rule names, same SECRET_SCAN_RULES_VERSION).
 */

import { createHash } from 'node:crypto'

import { scanText } from './secret-scan.ts'

export const SKILL_SHARE_RULES_VERSION = 1

export const SKILL_SHARE_MAX_FILES = 50
export const SKILL_SHARE_MAX_FILE_BYTES = 64 * 1024
export const SKILL_SHARE_MAX_TOTAL_BYTES = 256 * 1024
const MAX_PATH_LENGTH = 255

/** Text only (KC decision 3): scripts stay behind. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.csv'])

/** Claude Code frontmatter keys that grant tools or run commands. */
const EXECUTABLE_FRONTMATTER_KEYS: ReadonlySet<string> = new Set(['allowedtools', 'hooks', 'shell'])

/**
 * Control characters, the Windows forbidden set, and the bidi and zero width
 * marks that can make a name read as another on the card.
 */
const FORBIDDEN_PATH_CHARACTER =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f\\:<>|?*"\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u2028\u2029\u00a0]/

/** Names Windows reserves for devices, with any extension. */
export const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\.|$)/i

/** A skill folder name: Claude Code's own rule (spec 4.1). */
const STRICT_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

export type SkillShareExclusionReason = 'hidden' | 'tool_manifest' | 'secret_name' | 'not_text'

export type SkillShareBlockCode = 'invalid' | 'binary' | 'too_large' | 'secret' | 'runs_commands'

export interface SkillShareInputFile {
  path: string
  content: string
}

export interface SkillShareFileManifest {
  path: string
  bytes: number
  sha256: string
}

export interface SkillShareVerdict {
  /** null when the bundle may be shared. */
  block: SkillShareBlockCode | null
  /** Files that stay behind, with why. In input order. */
  excluded: { path: string; reason: SkillShareExclusionReason }[]
  /** Files that would be sent, sorted by path. */
  files: SkillShareFileManifest[]
  /** sha256 over the sorted manifest, see bundleSha256. */
  sha256: string
  /** The secret scan. Rule ids only, never a matched value. */
  scan: { clean: boolean; rules: string[] }
}

export function isStrictSkillName(name: unknown): name is string {
  return typeof name === 'string' && STRICT_SKILL_NAME.test(name)
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

/** Paths in UTF-8 byte order, which is code point order, the same in every daemon. */
function byPathBytes(a: { path: string }, b: { path: string }): number {
  return Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8'))
}

/**
 * The whole bundle hash: the files sorted by path (UTF-8 byte order), then
 * sha256 over `path\nsha256\n` per file.
 */
export function bundleSha256(files: readonly SkillShareFileManifest[]): string {
  const sorted = [...files].sort(byPathBytes)
  return sha256Hex(sorted.map((f) => `${f.path}\n${f.sha256}\n`).join(''))
}

/**
 * A path the bundle may carry at all: relative, `/` only, no empty, `.` or
 * `..` segment, no segment ending in a dot or space, no control character,
 * NFC, bounded length.
 */
export function isValidBundlePath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false
  if (path.length > MAX_PATH_LENGTH) return false
  if (path.normalize('NFC') !== path) return false
  if (FORBIDDEN_PATH_CHARACTER.test(path)) return false
  // An empty segment refuses a leading `/` (absolute) and `//`; a segment
  // ending in a dot refuses `.` and `..` as well as Windows' folded names.
  return path
    .split('/')
    .every((segment) => segment.length > 0 && !/[. ]$/.test(segment) && !WINDOWS_RESERVED.test(segment))
}

/** Why a path stays behind, or null when it is sent. Reads the path only. */
export function exclusionOf(path: string): SkillShareExclusionReason | null {
  const segments = path.split('/')
  if (segments.some((segment) => segment.startsWith('.'))) return 'hidden'
  const lower = path.toLowerCase()
  // Codex declares tool dependencies here.
  if (lower === 'agents/openai.yaml') return 'tool_manifest'
  const base = segments[segments.length - 1]!.toLowerCase()
  if (
    base.includes('.env') ||
    base.includes('secret') ||
    base.includes('credential') ||
    base.startsWith('id_') ||
    /\.(pem|key|p12|pfx)$/.test(base)
  ) {
    return 'secret_name'
  }
  const dot = base.lastIndexOf('.')
  const extension = dot >= 0 ? base.slice(dot) : ''
  if (!TEXT_EXTENSIONS.has(extension)) return 'not_text'
  return null
}

/** Executable keys, compared without case, `-` or `_`. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '')
}

const BLOCK_SCALAR = /^[|>][+-]?$/

export interface SkillFrontmatter {
  /**
   * false when the block is not the plain shape this check can read with
   * certainty. FAIL CLOSED: only unquoted ASCII `key: value` lines at column
   * 0, indented continuation lines under a key, blank lines and comments, a
   * closing `---`, no key twice.
   */
  ok: boolean
  /** Top level keys, normalized (normalizeKey). */
  keys: string[]
  /** The `description:` value, quotes and block scalars folded. */
  description: string
}

/** Read the leading `---` frontmatter block of a SKILL.md. Pure. */
export function readSkillFrontmatter(content: string): SkillFrontmatter {
  // Every line ending YAML knows, a bare carriage return included.
  const lines = content.split(/\r\n|\r|\n/)
  const none: SkillFrontmatter = { ok: true, keys: [], description: '' }
  const refused: SkillFrontmatter = { ok: false, keys: [], description: '' }
  // trim() also drops a byte order mark.
  const first = lines.findIndex((line) => line.trim() !== '')
  if (first < 0 || !lines[first]!.trim().startsWith('---')) return none
  if (first !== 0 || lines[0]!.trim() !== '---') return refused
  const keys: string[] = []
  let current: string | null = null
  let descriptionMode: 'none' | 'fold' | 'quoted' = 'none'
  const parts: string[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '---') {
      return { ok: true, keys, description: parts.filter(Boolean).join(' ').slice(0, 1_024) }
    }
    if (line.trim() === '' || /^[ \t]*#/.test(line)) continue
    if (/^[ \t]/.test(line)) {
      if (current === null) return refused
      if (current === 'description') {
        if (descriptionMode === 'quoted') return refused
        parts.push(line.trim())
      }
      continue
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:(?:[ \t]+(.*))?$/.exec(line)
    if (!match) return refused
    const key = normalizeKey(match[1]!)
    if (keys.includes(key)) return refused
    keys.push(key)
    current = key
    if (key === 'description') {
      const value = (match[2] ?? '').trim()
      if (BLOCK_SCALAR.test(value)) {
        descriptionMode = 'fold'
      } else if (/^["']/.test(value)) {
        const quoted = /^(["'])(.*)\1(?:[ \t]+#.*)?$/.exec(value)
        if (!quoted) return refused
        parts.push(quoted[2]!)
        descriptionMode = 'quoted'
      } else {
        parts.push(value.replace(/[ \t]+#.*$/, ''))
        descriptionMode = 'fold'
      }
    }
  }
  // An unclosed block.
  return refused
}

/**
 * Shell that runs when the skill loads: an inline `` !`cmd` `` (a newline
 * inside the backticks too), or a fence of three or more backticks or tildes
 * opened with `!`.
 */
function hasShellLine(content: string): boolean {
  return /!`[^`]+`/.test(content) || /^[ \t]*(`{3,}|~{3,})[ \t]*!/m.test(content)
}

function casefoldKey(path: string): string {
  return path.normalize('NFC').toLowerCase()
}

function secretRules(label: string, text: string): string[] {
  return scanText(label, text).map((finding) => finding.rule)
}

/** The verdict for a set of files read from one skill folder. Pure. */
export function checkSkillShareBundle(input: readonly SkillShareInputFile[]): SkillShareVerdict {
  const excluded: SkillShareVerdict['excluded'] = []
  const included: SkillShareInputFile[] = []
  let invalid = false
  const seen = new Set<string>()
  const ruleIds = new Set<string>()

  for (const file of input) {
    if (!file || typeof file.content !== 'string' || !isValidBundlePath(file.path)) {
      invalid = true
      continue
    }
    const key = casefoldKey(file.path)
    if (seen.has(key)) invalid = true
    seen.add(key)
    // A secret shaped path is caught even when the file stays behind: the
    // excluded list itself is shown and stored.
    for (const rule of secretRules(file.path, file.path)) ruleIds.add(rule)
    const reason = exclusionOf(file.path)
    if (reason) {
      excluded.push({ path: file.path, reason })
      continue
    }
    included.push(file)
  }

  if (!included.some((file) => file.path === 'SKILL.md')) invalid = true

  let binary = false
  let tooLarge = included.length > SKILL_SHARE_MAX_FILES
  let runsCommands = false
  let total = 0
  const files: SkillShareFileManifest[] = []
  for (const file of included) {
    const bytes = Buffer.byteLength(file.content, 'utf8')
    total += bytes
    if (bytes > SKILL_SHARE_MAX_FILE_BYTES) tooLarge = true
    if (file.content.includes('\u0000')) binary = true
    for (const rule of secretRules(file.path, file.content)) ruleIds.add(rule)
    if (file.path === 'SKILL.md') {
      const frontmatter = readSkillFrontmatter(file.content)
      if (!frontmatter.ok) invalid = true
      if (frontmatter.keys.some((key) => EXECUTABLE_FRONTMATTER_KEYS.has(key))) runsCommands = true
    }
    if (hasShellLine(file.content)) runsCommands = true
    files.push({ path: file.path, bytes, sha256: sha256Hex(file.content) })
  }
  if (total > SKILL_SHARE_MAX_TOTAL_BYTES) tooLarge = true
  files.sort(byPathBytes)

  const rules = [...ruleIds].sort()
  const block: SkillShareBlockCode | null = invalid
    ? 'invalid'
    : binary
      ? 'binary'
      : tooLarge
        ? 'too_large'
        : rules.length > 0
          ? 'secret'
          : runsCommands
            ? 'runs_commands'
            : null

  return { block, excluded, files, sha256: bundleSha256(files), scan: { clean: rules.length === 0, rules } }
}

/**
 * The check of a bundle that arrived from elsewhere (the backend's stored
 * bundle, this daemon's install_bundle): a file the source should have left
 * behind means it is not following the rules, so the bundle is refused.
 */
export function verifyStoredBundle(input: readonly SkillShareInputFile[]): SkillShareVerdict {
  const verdict = checkSkillShareBundle(input)
  if (verdict.block === null && verdict.excluded.length > 0) return { ...verdict, block: 'invalid' }
  return verdict
}
