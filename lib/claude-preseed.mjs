/**
 * claude-preseed: pre-seed Claude Code's one-time prompts for an agent folder
 * so an UNATTENDED first launch never stops on a hidden question.
 *
 * A verbatim port (behaviour, not just intent) of the preseed snippet both
 * bootstraps embed (bin/hoai-bootstrap.sh ~544-581, bin/hoai-bootstrap.ps1
 * ~400-445), kept as a library so the per-machine watcher can create an agent
 * with no terminal at all:
 *   <configDir>/.claude.json   hasCompletedOnboarding (default true) and theme
 *                              (default "dark") for the first-run wizard, and
 *                              projects[<cwd>] = the FULL entry shape Claude
 *                              Code itself writes on a real trust accept. A
 *                              minimal {hasTrustDialogAccepted:true} entry is
 *                              NOT honoured (verified live 2026-08-22 on
 *                              2.1.239: the dialog still rendered until the
 *                              sibling fields existed), and the key must match
 *                              process.cwd() byte for byte, so a win32 cwd is
 *                              seeded under both slash spellings (the ps1 rule).
 *   <configDir>/settings.json  skipDangerousModePermissionPrompt = true: the
 *                              bypass warning's DEFAULT answer is exit, so it
 *                              must never be blind-Entered (landmine 2).
 *
 * Merge rule per project entry, exactly the snippet's:
 *   Object.assign({defaults}, existing, {hasTrustDialogAccepted: true})
 * so a user's own allowedTools survive and the trust flag always wins.
 * Idempotent: a second run rewrites identical bytes.
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe; the fs is injected
 * (readFile -> string|null, writeFile(path, text)) so tests run in memory.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

/** The default entry fields, in the bootstrap's key order (the trust flag is
 *  applied last, on top, so it is not part of the defaults object). */
export const TRUST_ENTRY_DEFAULTS = Object.freeze({
  allowedTools: [],
  disabledMcpjsonServers: [],
  enabledMcpjsonServers: [],
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
  mcpContextUris: [],
  projectOnboardingSeenCount: 1,
  hasCompletedProjectOnboarding: true,
})

/** @typedef {{ readFile: (path: string) => string | null, writeFile: (path: string, text: string) => void,
 *   rename?: (from: string, to: string) => void
 * }} PreseedFs */

/** @returns {PreseedFs} */
function defaultPreseedFs() {
  return {
    rename: (from, to) => renameSync(from, to),
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    writeFile: (path, text) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    },
  }
}

/** The snippet's load(): parse JSON, or {} for absent / empty / corrupt. */
function loadJsonOrEmpty(readFile, path) {
  const raw = readFile(path)
  if (raw == null) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Join preserving the directory's separator style (a win32 config dir stays win32). */
function joinDir(dir, name) {
  const base = String(dir ?? '').replace(/[\\/]+$/, '')
  const sep = base.includes('\\') || /^[A-Za-z]:$/.test(base) ? '\\' : '/'
  return `${base}${sep}${name}`
}

/**
 * One seeded project entry: defaults, then the existing entry, then the trust
 * flag forced on. Pure.
 * @param {Record<string, unknown> | undefined | null} existing
 */
export function seedProjectEntry(existing) {
  const current = existing && typeof existing === 'object' ? existing : {}
  return Object.assign(
    { ...TRUST_ENTRY_DEFAULTS, allowedTools: [], disabledMcpjsonServers: [], enabledMcpjsonServers: [], mcpContextUris: [] },
    current,
    { hasTrustDialogAccepted: true },
  )
}

/** The ps1 rule: the other slash spelling of a path (every separator flipped). */
export function alternateSlashSpelling(path) {
  const value = String(path ?? '')
  return value.includes('\\') ? value.split('\\').join('/') : value.split('/').join('\\')
}

/** A win32-shaped cwd (drive letter or a backslash) gets both spellings seeded. */
function looksWin32(path) {
  const value = String(path ?? '')
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')
}

/**
 * Pre-seed trust + prompt acceptance for `cwd` under `configDir`.
 * @param {{ configDir: string, cwd: string, fs?: PreseedFs }} params
 * @returns {{ configPath: string, settingsPath: string, seededKeys: string[] }}
 */
/** Write-then-rename when the fs offers rename, so a concurrent reader (a live
 *  claude process) never sees a half-written .claude.json / settings.json. */
function writeJsonAtomic(fs, path, value) {
  const text = JSON.stringify(value, null, 2)
  if (typeof fs.rename !== 'function') {
    fs.writeFile(path, text)
    return
  }
  const tmp = `${path}.${process.pid}.tmp`
  fs.writeFile(tmp, text)
  fs.rename(tmp, path)
}

export function preseedClaudeTrust({ configDir, cwd, fs = defaultPreseedFs() }) {
  const dir = String(configDir ?? '').trim()
  const workdir = String(cwd ?? '')
  if (!dir) throw new Error('preseedClaudeTrust: configDir is required')
  if (!workdir.trim()) throw new Error('preseedClaudeTrust: cwd is required')

  const configPath = joinDir(dir, '.claude.json')
  const cfg = loadJsonOrEmpty(fs.readFile, configPath)
  if (cfg.hasCompletedOnboarding === undefined) cfg.hasCompletedOnboarding = true
  if (cfg.theme === undefined) cfg.theme = 'dark'
  cfg.projects = cfg.projects && typeof cfg.projects === 'object' ? cfg.projects : {}
  const seededKeys = [workdir]
  if (looksWin32(workdir)) seededKeys.push(alternateSlashSpelling(workdir))
  for (const key of seededKeys) cfg.projects[key] = seedProjectEntry(cfg.projects[key])
  writeJsonAtomic(fs, configPath, cfg)

  const settingsPath = joinDir(dir, 'settings.json')
  const settings = loadJsonOrEmpty(fs.readFile, settingsPath)
  settings.skipDangerousModePermissionPrompt = true
  writeJsonAtomic(fs, settingsPath, settings)

  return { configPath, settingsPath, seededKeys }
}

/**
 * Enrol a marketplace in Claude Code's own plugin auto-update.
 *
 * WHY THIS EXISTS. Claude Code refreshes marketplaces and updates their plugins by itself, on
 * startup, with nothing typed. That behaviour is opt-in per marketplace: it defaults ON for a fixed
 * list of Anthropic's own marketplace names and OFF for everybody else. Ours is not on that list, so
 * without this key a machine stays on whatever version it first installed, forever, while every
 * check reports success.
 *
 * The cost is not hypothetical. On the author's own machine, openai-codex, the most-used plugin
 * there by a wide margin, had not been refreshed once since the day it was installed four months
 * earlier, for exactly this reason, and nothing anywhere said a word about it.
 *
 * The setting is confirmed in the shipped Claude Code binary, whose own schema describes it as
 * "Whether to automatically update this marketplace and its installed plugins on startup". There is
 * no CLI flag for it: `claude plugin marketplace add --help` offers only --scope and --sparse, and
 * `marketplace list` does not report it. So writing the key ourselves is the only route.
 *
 * ORDER MATTERS AT THE CALL SITES. `claude plugin marketplace add` rewrites the entry to just its
 * source, on both the "added" and the "already on disk" branches. Ensuring BEFORE an add is silently
 * undone. Every caller must ensure AFTER.
 *
 * WHAT THIS DELIBERATELY WILL NOT DO. It never creates a marketplace entry. If the user has not
 * declared this marketplace, writing one would silently register a source on their machine that they
 * never asked for. Absent entry means we do nothing and say so.
 *
 * @param {object} opts
 * @param {string} opts.configDir      the Claude config dir holding settings.json
 * @param {string} [opts.marketplace]  the marketplace NAME as registered on THIS machine. Callers
 *   should pass the detected name rather than assuming 'hoai': a machine that added the marketplace
 *   by another route can hold a different name, which has already confused an external tester twice.
 * @param {boolean} [opts.enabled]     false turns enrolment back off
 * @param {object} [opts.fs]
 * @returns {{changed: boolean, reason: 'set'|'already'|'no_entry'|'declined'}}
 */
export function ensureMarketplaceAutoUpdate({
  configDir,
  marketplace = 'hoai',
  enabled = true,
  fs = defaultPreseedFs(),
}) {
  const dir = String(configDir ?? '').trim()
  if (!dir) throw new Error('ensureMarketplaceAutoUpdate: configDir is required')

  const name = String(marketplace ?? '').trim()
  if (!name) throw new Error('ensureMarketplaceAutoUpdate: marketplace is required')

  const settingsPath = joinDir(dir, 'settings.json')
  // Corrupt or absent parses to {}, so a half-written settings.json can never fail a daemon boot.
  const settings = loadJsonOrEmpty(fs.readFile, settingsPath)

  const entries = settings.extraKnownMarketplaces
  const haveEntries = entries && typeof entries === 'object' && !Array.isArray(entries)
  // Own-property only. The marketplace name is read off the FILESYSTEM (a cache directory name), so
  // a machine with a directory called __proto__ would otherwise reach Object.prototype here: the
  // lookup would return a truthy object and the write would land on the prototype, not on settings.
  const entry =
    haveEntries && Object.prototype.hasOwnProperty.call(entries, name) ? entries[name] : undefined

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { changed: false, reason: 'no_entry' }
  }

  if (entry.autoUpdate === enabled) return { changed: false, reason: 'already' }

  // An explicit false is a DECISION, and this function runs at every daemon boot. Turning it back on
  // would override a user who deliberately opted out, silently, on a schedule they cannot see. Only
  // an ABSENT key means "never asked", which is the case this exists to fix.
  if (enabled && entry.autoUpdate === false) {
    return { changed: false, reason: 'declined' }
  }

  entry.autoUpdate = enabled
  writeJsonAtomic(fs, settingsPath, settings)
  return { changed: true, reason: 'set' }
}
