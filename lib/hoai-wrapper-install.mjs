/**
 * hoai-wrapper-install: put the `hoai` command itself on this machine's PATH.
 *
 * KC's ask, 2026-08-25: "aliases created automatically at install so people can
 * type one word". The one-click bootstrap already did this (bin/hoai-bootstrap.sh
 * symlinks ~/.local/bin/hoai, bin/hoai-bootstrap.ps1 copies the two Windows
 * shims into %LOCALAPPDATA%\hoai\bin and leaves a hoai-plugin-root.txt
 * breadcrumb), but the CLI onboarding path `hoai setup <CODE>` did not, so a
 * machine onboarded from the app's pasted line ended up with the plugin
 * installed, the agent paired, and no `hoai` to type.
 *
 * This module is that same mechanism, callable from node so `hoai setup` and
 * `hoai install-cli` can do it on macOS, Linux and Windows alike. It targets
 * EXACTLY the locations the bootstrap and lib/update-executor.mjs refreshAlias
 * already agree on, so a later one-click update re-points the very same shim:
 *
 *   posix  <home>/.local/bin/hoai            symlink to <pluginRoot>/bin/hoai
 *   win32  %LOCALAPPDATA%\hoai\bin\hoai.cmd  copy of <pluginRoot>\bin\hoai.cmd
 *          %LOCALAPPDATA%\hoai\bin\hoai.ps1  copy of <pluginRoot>\bin\hoai.ps1
 *          %LOCALAPPDATA%\hoai\bin\hoai-plugin-root.txt   the breadcrumb both
 *                                            shims read to find hoai-core.mjs
 *
 * WHAT THIS DELIBERATELY NEVER WRITES: a shell alias carrying a channel spec.
 * There is one on a fleet machine right now reading
 *   alias hoai='claude --resume ... --dangerously-load-development-channels server:bgos'
 * and on a marketplace install that spec matches nothing and silently drops
 * every inbound message (the 2026-08-21 incident). The correct flag is only
 * knowable at RUN time from install-method detection, so it must be resolved by
 * hoai on every launch and can never be frozen into a string. The only thing
 * written to a shell profile here is a PATH line, the same one the bootstrap
 * writes, which carries no flags at all.
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe (no side effects at
 * load) and effect-injected, so the whole decision surface is unit-testable.
 * No em dashes or en dashes anywhere.
 */

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { parsePath } from '../bin/bgos-install-method.mjs'

// -- Constants ----------------------------------------------------------------

/** The breadcrumb the Windows shims read to find the plugin root. Mirror of
 *  lib/update-executor.mjs ALIAS_BREADCRUMB_FILE and bin/hoai.ps1 / bin/hoai. */
export const WRAPPER_BREADCRUMB_FILE = 'hoai-plugin-root.txt'

/** The Windows shims copied next to the breadcrumb (bin/hoai-bootstrap.ps1
 *  copies exactly these two). */
export const WIN_WRAPPER_FILES = Object.freeze(['hoai.ps1', 'hoai.cmd'])

/** The posix shim, symlinked into ~/.local/bin (it resolves its own directory
 *  THROUGH symlinks, so the link alone is enough, no breadcrumb needed). */
export const POSIX_WRAPPER_FILE = 'hoai'

/** The profile line the bootstrap appends, verbatim, so a machine that has
 *  been through either path never grows two different lines. */
export const PROFILE_PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"'
/** The marker comment above it (same wording as bin/hoai-bootstrap.sh). */
export const PROFILE_PATH_COMMENT =
  '# added by hoai-bootstrap (keeps bun, bunx and hoai resolvable)'
/** The substring the bootstrap greps for before appending; matching it keeps
 *  the two writers idempotent with respect to each other. */
export const PROFILE_PATH_NEEDLE = '.local/bin'

/** The profiles a posix PATH line is appended to when they exist. */
export const POSIX_PROFILE_FILES = Object.freeze(['.zshrc', '.bashrc'])

/** The PowerShell helper that adds a directory to the User PATH (registry).
 *  Same [Environment]::SetEnvironmentVariable('Path', ..., 'User') mechanism
 *  as bin/hoai-bootstrap.ps1 Ensure-OnPath, extracted so the CLI can use it. */
export const WIN_PATH_HELPER_FILE = 'hoai-add-to-path.ps1'

// -- Pure path helpers --------------------------------------------------------

/** Join parts under a base in the base's own separator style. */
export function joinUnder(base, ...parts) {
  const { prefix, sep, segments } = parsePath(base)
  return `${prefix}${[...segments, ...parts].join(sep)}`
}

/**
 * The directory the `hoai` shim is installed into.
 *   win32  <localAppData>\hoai\bin   (mirror of hoai-bootstrap.ps1 $HoaiBin)
 *   posix  <home>/.local/bin         (mirror of hoai-bootstrap.sh LOCAL_BIN and
 *                                     update-executor.mjs aliasSymlinkPath)
 * Returns '' on win32 when LOCALAPPDATA is unknown, which is the one case with
 * no honest answer.
 * @param {{ platform?: string, home?: string, localAppData?: string | null }} [opts]
 */
export function wrapperBinDir({ platform = process.platform, home = homedir(), localAppData = null } = {}) {
  if (platform === 'win32') {
    const base = String(localAppData ?? '').trim()
    return base ? joinUnder(base, 'hoai', 'bin') : ''
  }
  return joinUnder(home, '.local', 'bin')
}

/**
 * The files this install writes, as a pure plan. Every entry is
 * { kind, from, to }: 'symlink' points `to` at `from`, 'copy' copies
 * `from` to `to`, 'breadcrumb' writes the plugin root into `to`.
 * @param {{ platform?: string, home?: string, localAppData?: string | null,
 *   pluginRoot: string }} opts
 * @returns {{ ok: true, binDir: string, entries: Array<{kind: string, from: string, to: string}> }
 *          | { ok: false, reason: string }}
 */
export function planWrapperInstall({ platform = process.platform, home = homedir(), localAppData = null, pluginRoot } = {}) {
  const root = String(pluginRoot ?? '').trim()
  if (!root) return { ok: false, reason: 'no plugin root to point the hoai command at' }
  const binDir = wrapperBinDir({ platform, home, localAppData })
  if (!binDir) {
    return { ok: false, reason: 'LOCALAPPDATA is not set, so there is no per-user bin dir to install into' }
  }
  if (platform === 'win32') {
    const entries = WIN_WRAPPER_FILES.map((name) => ({
      kind: 'copy',
      from: joinUnder(root, 'bin', name),
      to: joinUnder(binDir, name),
    }))
    // The shims are COPIES, so they cannot find hoai-core.mjs by their own
    // location; the breadcrumb is what makes them work at all.
    entries.push({ kind: 'breadcrumb', from: root, to: joinUnder(binDir, WRAPPER_BREADCRUMB_FILE) })
    return { ok: true, binDir, entries }
  }
  return {
    ok: true,
    binDir,
    entries: [
      {
        kind: 'symlink',
        from: joinUnder(root, 'bin', POSIX_WRAPPER_FILE),
        to: joinUnder(binDir, POSIX_WRAPPER_FILE),
      },
    ],
  }
}

/**
 * Does this profile text still need the PATH line? Mirror of the bootstrap's
 * `grep -qF ".local/bin"` guard: a profile that already mentions the directory,
 * however the user spelled it, is left alone. Ignores null (missing file), which
 * the bootstrap also skips.
 * @param {string | null} existingText
 * @returns {boolean}
 */
export function profileNeedsPathLine(existingText) {
  if (existingText == null) return false
  return !String(existingText).includes(PROFILE_PATH_NEEDLE)
}

/** The exact block appended to a profile: a blank line, the marker comment,
 *  then the PATH line. Byte-identical to bin/hoai-bootstrap.sh. */
export function profilePathBlock() {
  return `\n${PROFILE_PATH_COMMENT}\n${PROFILE_PATH_LINE}\n`
}

/**
 * Is `dir` already on this PATH string? Segment compare, tolerant of a trailing
 * separator and (on win32) of case.
 * @param {string} pathValue
 * @param {string} dir
 * @param {string} [platform]
 */
export function pathContainsDir(pathValue, dir, platform = process.platform) {
  const sep = platform === 'win32' ? ';' : ':'
  const trim = (value) => String(value ?? '').replace(/[\\/]+$/, '')
  const fold = (value) => (platform === 'win32' ? trim(value).toLowerCase() : trim(value))
  const wanted = fold(dir)
  if (!wanted) return false
  return String(pathValue ?? '')
    .split(sep)
    .some((part) => fold(part) === wanted)
}

// -- Default effects ----------------------------------------------------------

const defaultEffects = {
  exists: (path) => {
    try {
      return existsSync(path)
    } catch {
      return false
    }
  },
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  writeFile: (path, content) => {
    try {
      mkdirSync(dirOf(path), { recursive: true })
      writeFileSync(path, content)
      return true
    } catch {
      return false
    }
  },
  appendFile: (path, content) => {
    try {
      writeFileSync(path, content, { flag: 'a' })
      return true
    } catch {
      return false
    }
  },
  mkdirp: (path) => {
    try {
      mkdirSync(path, { recursive: true })
      return true
    } catch {
      return false
    }
  },
  copyFile: (from, to) => {
    try {
      mkdirSync(dirOf(to), { recursive: true })
      copyFileSync(from, to)
      return true
    } catch {
      return false
    }
  },
  symlink: (target, link) => {
    try {
      mkdirSync(dirOf(link), { recursive: true })
      // lstat, never exists: a link pointing at a deleted plugin root is a
      // broken link, which exists() reports as absent and symlink() then
      // refuses with EEXIST. Replacing it is the whole point of a re-run.
      try {
        lstatSync(link)
        unlinkSync(link)
      } catch {
        // nothing there to replace
      }
      symlinkSync(target, link)
      return true
    } catch {
      return false
    }
  },
  readlink: (link) => {
    try {
      return readlinkSync(link)
    } catch {
      return null
    }
  },
  chmodX: (path) => {
    try {
      chmodSync(path, 0o755)
      return true
    } catch {
      return false
    }
  },
}

/** The directory part of a path, in the path's own separator style. */
function dirOf(path) {
  const { prefix, sep, segments } = parsePath(path)
  return `${prefix}${segments.slice(0, -1).join(sep)}`
}

// -- The install --------------------------------------------------------------

/**
 * Install (or repair) the `hoai` shim and make its directory stick on PATH.
 *
 * Never throws and never fails a caller: every step is best effort and reported
 * as a short token, because a missing shim must not abort onboarding halfway
 * through (the plugin is installed and the agent is paired either way).
 *
 * @param {{
 *   pluginRoot: string,
 *   platform?: string,
 *   home?: string,
 *   env?: Record<string, string | undefined>,
 *   effects?: Partial<typeof defaultEffects>,
 *   runPathHelper?: (binDir: string) => boolean,
 * }} opts
 * @returns {{ ok: boolean, binDir: string, wrote: string[], notes: string[],
 *             onPath: boolean, profiles: string[] }}
 */
export function installWrapper({
  pluginRoot,
  platform = process.platform,
  home = homedir(),
  env = process.env,
  effects = {},
  runPathHelper = null,
} = {}) {
  const fx = { ...defaultEffects, ...effects }
  const wrote = []
  const notes = []
  const profiles = []
  const localAppData = String(env?.LOCALAPPDATA ?? '').trim() || null
  const plan = planWrapperInstall({ platform, home, localAppData, pluginRoot })
  if (!plan.ok) return { ok: false, binDir: '', wrote, notes: [plan.reason], onPath: false, profiles }

  fx.mkdirp(plan.binDir)
  let ok = true
  for (const entry of plan.entries) {
    if (entry.kind === 'breadcrumb') {
      if (fx.writeFile(entry.to, `${entry.from}\n`)) wrote.push(entry.to)
      else {
        ok = false
        notes.push(`could not write ${entry.to}`)
      }
      continue
    }
    if (entry.kind === 'copy') {
      if (!fx.exists(entry.from)) {
        ok = false
        notes.push(`missing ${entry.from}`)
        continue
      }
      if (fx.copyFile(entry.from, entry.to)) wrote.push(entry.to)
      else {
        ok = false
        notes.push(`could not copy ${entry.from}`)
      }
      continue
    }
    // symlink
    if (!fx.exists(entry.from)) {
      ok = false
      notes.push(`missing ${entry.from}`)
      continue
    }
    fx.chmodX(entry.from)
    if (entry.from === entry.to) {
      // Already the real file (a clone whose bin IS ~/.local/bin); nothing to link.
      wrote.push(entry.to)
      continue
    }
    if (fx.symlink(entry.from, entry.to)) wrote.push(entry.to)
    else {
      ok = false
      notes.push(`could not link ${entry.to}`)
    }
  }

  // PATH persistence. posix: the same profile line the bootstrap appends.
  // win32: the same User-PATH registry write the bootstrap does, through the
  // PowerShell helper (node cannot write the registry by itself).
  let onPath = pathContainsDir(env?.PATH ?? env?.Path ?? '', plan.binDir, platform)
  if (platform === 'win32') {
    if (!onPath && typeof runPathHelper === 'function') {
      onPath = runPathHelper(plan.binDir) === true
      if (!onPath) notes.push('could not add the bin dir to your User PATH; add it by hand')
    }
  } else {
    for (const name of POSIX_PROFILE_FILES) {
      const profile = joinUnder(home, name)
      const text = fx.readFile(profile)
      if (!profileNeedsPathLine(text)) continue
      if (fx.appendFile(profile, profilePathBlock())) profiles.push(profile)
      else notes.push(`could not add the PATH line to ${profile}`)
    }
  }

  return { ok, binDir: plan.binDir, wrote, notes, onPath, profiles }
}
