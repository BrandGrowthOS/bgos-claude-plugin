/**
 * watcher-bundle: the per-machine watcher's installed bundle, copied OUT of
 * the plugin folder so a plugin reinstall / uninstall / cache-dir move never
 * kills the watcher that performs them.
 *
 * Layout (design 1.5 / 7.1), all under <home>/.bgos-agent/watcher/:
 *   bin/hoai-watcher.mjs, bin/bgos-install-method.mjs, lib/*.mjs   the bundle
 *   manifest.json       {version, fingerprint, installedAt, pluginRoot, files}
 *   credentials.json    (0600, written by lib/watcher-service.mjs)
 *   state.json          runtime state (last heartbeat, last job)
 *   logs/watcher.log    scrubbed log
 *   next/               a staged bundle awaiting swapStagedBundle
 *
 * The fingerprint is a sha256 over the bundle files' contents in a fixed
 * order, so a post-update reconcile can tell "the plugin changed but the
 * watcher code did not" from "the watcher must refresh itself" without
 * trusting version strings.
 *
 * This module also hosts the node adapters (nodeFs / nodeExec /
 * nodeSpawnDetached) every watcher module defaults to, so the daemon-side
 * installer (lib/watcher-install.mjs) and the tests share one injectable
 * surface. Plain JavaScript, node >= 18 builtins only, import-safe.
 */

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

/** The files copied into the bundle, relative to the plugin root (design 7.5). */
export const WATCHER_BUNDLE_FILES = Object.freeze([
  'bin/hoai-watcher.mjs',
  'bin/bgos-install-method.mjs',
  'lib/plugin-cli.mjs',
  'lib/update-planner.mjs',
  'lib/update-executor.mjs',
  'lib/update-diagnostics.mjs',
  'lib/machine-id.mjs',
  'lib/watcher-core.mjs',
  'lib/watcher-service.mjs',
  'lib/watcher-bundle.mjs',
  'lib/agent-inventory.mjs',
  'lib/agent-restart.mjs',
  'lib/agent-verify.mjs',
  'lib/claude-preseed.mjs',
])

export const MANIFEST_FILE_NAME = 'manifest.json'
export const STAGING_DIR_NAME = 'next'
export const PREVIOUS_DIR_NAME = 'prev'
/** The top-level entries a swap replaces (everything else is runtime state). */
export const SWAPPABLE_ENTRIES = Object.freeze(['bin', 'lib', MANIFEST_FILE_NAME])

/** daemonVersion on the wire must look like a semver (design 7.5). */
export const VERSION_RE = /^\d+\.\d+\.\d+[-\w.]*$/

/**
 * @typedef {{
 *   exists: (path: string) => boolean,
 *   readFile: (path: string) => string | null,
 *   writeFile: (path: string, text: string, opts?: { mode?: number }) => void,
 *   mkdir: (path: string) => void,
 *   listDir: (path: string) => string[],
 *   stat: (path: string) => { mtimeMs: number, isDirectory: boolean } | null,
 *   rm: (path: string) => void,
 *   rename: (from: string, to: string) => void,
 *   copyFile: (from: string, to: string) => void,
 *   chmod: (path: string, mode: number) => void,
 * }} WatcherFs
 */

/**
 * @typedef {{
 *   version: string,
 *   fingerprint: string,
 *   installedAt: string | null,
 *   pluginRoot: string | null,
 *   files: string[],
 * }} BundleManifest
 */

// -- Paths ---------------------------------------------------------------------

/** Join preserving the directory's separator style. */
export function joinDir(dir, name) {
  const base = String(dir ?? '').replace(/[\\/]+$/, '')
  if (!base) return String(name ?? '')
  const sep = base.includes('\\') || /^[A-Za-z]:$/.test(base) ? '\\' : '/'
  return `${base}${sep}${name}`
}

/** Join a relative bundle path ('lib/x.mjs') under a dir in that dir's style. */
export function joinRel(dir, rel) {
  return String(rel)
    .split('/')
    .reduce((acc, part) => joinDir(acc, part), String(dir))
}

export function watcherHome(home) {
  return joinDir(joinDir(home, '.bgos-agent'), 'watcher')
}

export function watcherLogPath(home) {
  return joinDir(joinDir(watcherHome(home), 'logs'), 'watcher.log')
}

export function watcherStatePath(home) {
  return joinDir(watcherHome(home), 'state.json')
}

export function manifestPath(bundleDir) {
  return joinDir(bundleDir, MANIFEST_FILE_NAME)
}

// -- Node adapters ------------------------------------------------------------------

/** The real filesystem behind the WatcherFs surface. Reads never throw
 *  (null / [] / false), writes do (the caller decides how to report). */
export function nodeFs() {
  return {
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
    writeFile: (path, text, opts = {}) => {
      mkdirSync(dirname(path), { recursive: true })
      if (opts.mode != null) {
        writeFileSync(path, text, { mode: opts.mode })
        try {
          chmodSync(path, opts.mode)
        } catch {
          // win32 has no POSIX modes; the caller applies an ACL instead.
        }
      } else {
        writeFileSync(path, text)
      }
    },
    mkdir: (path) => {
      mkdirSync(path, { recursive: true })
    },
    listDir: (path) => {
      try {
        return readdirSync(path)
      } catch {
        return []
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
    rm: (path) => {
      rmSync(path, { recursive: true, force: true })
    },
    rename: (from, to) => {
      renameSync(from, to)
    },
    copyFile: (from, to) => {
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
    },
    chmod: (path, mode) => {
      try {
        chmodSync(path, mode)
      } catch {
        // best effort (win32)
      }
    },
  }
}

/**
 * @typedef {(file: string, args: readonly string[], opts?: { cwd?: string,
 *   env?: Record<string, string | undefined>, timeoutMs?: number, input?: string })
 *   => Promise<{ code: number | null, stdout: string, stderr: string, error: string | null, timedOut: boolean }>} Exec
 */

/** execFile that never throws: a spawn failure is {code:null, error}. */
export function nodeExec() {
  return (file, args, opts = {}) =>
    new Promise((resolve) => {
      let child
      try {
        child = execFile(
          file,
          [...args],
          {
            cwd: opts.cwd,
            env: opts.env ?? process.env,
            timeout: opts.timeoutMs ?? 0,
            maxBuffer: 8 * 1024 * 1024,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            const timedOut = Boolean(error && error.killed && opts.timeoutMs)
            resolve({
              code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? ''),
              error: error && typeof error.code !== 'number' ? String(error.message ?? error) : null,
              timedOut,
            })
          },
        )
      } catch (err) {
        resolve({ code: null, stdout: '', stderr: '', error: String(err?.message ?? err), timedOut: false })
        return
      }
      if (opts.input != null && child.stdin) {
        child.stdin.end(opts.input)
      }
    })
}

/**
 * @typedef {(file: string, args: readonly string[], opts?: { cwd?: string,
 *   env?: Record<string, string | undefined>, windowsVerbatimArguments?: boolean,
 *   windowsHide?: boolean }) => { pid: number | null }} SpawnDetached
 */

/** A fire-and-forget child: detached, stdio ignored, unref'd. Throws only on
 *  a synchronous spawn failure (the caller reports it). */
export function nodeSpawnDetached() {
  return (file, args, opts = {}) => {
    const child = spawn(file, [...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: opts.windowsVerbatimArguments ?? false,
      windowsHide: opts.windowsHide ?? false,
    })
    child.on('error', () => {})
    child.unref()
    return { pid: child.pid ?? null }
  }
}

// -- Fingerprint --------------------------------------------------------------------

/**
 * sha256 over the bundle files: for each relative path in sorted order,
 * `<rel>\0<content or <missing>>\0`. Missing files are part of the hash so a
 * partial bundle never fingerprints like a complete one.
 * @param {string} pluginRoot
 * @param {WatcherFs} fs
 */
export function bundleFingerprint(pluginRoot, fs = nodeFs()) {
  const hash = createHash('sha256')
  for (const rel of [...WATCHER_BUNDLE_FILES].sort()) {
    const content = fs.readFile(joinRel(pluginRoot, rel))
    hash.update(rel)
    hash.update('\0')
    hash.update(content == null ? '<missing>' : content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

// -- Manifest --------------------------------------------------------------------------

/** Parse a manifest body; null for junk or a non-semver version. */
export function parseBundleManifest(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const version = String(parsed.version ?? '').trim()
  if (!VERSION_RE.test(version)) return null
  const fingerprint = String(parsed.fingerprint ?? '').trim()
  if (!fingerprint) return null
  return {
    version,
    fingerprint,
    installedAt: typeof parsed.installedAt === 'string' ? parsed.installedAt : null,
    pluginRoot: typeof parsed.pluginRoot === 'string' && parsed.pluginRoot ? parsed.pluginRoot : null,
    files: Array.isArray(parsed.files) ? parsed.files.filter((f) => typeof f === 'string') : [],
  }
}

/** The installed bundle's manifest, or null. */
export function readBundleManifest(home, fs = nodeFs()) {
  return parseBundleManifest(fs.readFile(manifestPath(watcherHome(home))))
}

/** The plugin's own version from <pluginRoot>/package.json, or null. */
export function readPluginVersion(pluginRoot, fs = nodeFs()) {
  const raw = fs.readFile(joinDir(pluginRoot, 'package.json'))
  if (raw == null) return null
  try {
    const version = String(JSON.parse(raw)?.version ?? '').trim()
    return VERSION_RE.test(version) ? version : null
  } catch {
    return null
  }
}

// -- Install ---------------------------------------------------------------------------

/**
 * Copy the bundle files from a plugin root into the watcher home (or a staging
 * dir), preserving the bin/ + lib/ layout, and write the manifest. Every source
 * file is checked BEFORE anything is written, so a missing file fails by name
 * with nothing half-copied.
 * @param {{ pluginRoot: string, home: string, pluginVersion?: string | null,
 *   fs?: WatcherFs, now?: () => number, targetDir?: string }} params
 * @returns {Promise<{ bundleDir: string, files: string[], fingerprint: string, version: string }>}
 */
export async function installWatcherBundle({ pluginRoot, home, pluginVersion = null, fs = nodeFs(), now = Date.now, targetDir }) {
  const root = String(pluginRoot ?? '').trim()
  if (!root) throw new Error('installWatcherBundle: pluginRoot is required')
  const bundleDir = targetDir || watcherHome(home)
  for (const rel of WATCHER_BUNDLE_FILES) {
    if (!fs.exists(joinRel(root, rel))) throw new Error(`bundle file missing: ${rel} (under ${root})`)
  }
  const version = String(pluginVersion ?? '').trim() || readPluginVersion(root, fs)
  if (!version || !VERSION_RE.test(version)) {
    throw new Error(`installWatcherBundle: no usable plugin version (pass pluginVersion or fix ${joinDir(root, 'package.json')})`)
  }
  const fingerprint = bundleFingerprint(root, fs)
  fs.mkdir(bundleDir)
  for (const rel of WATCHER_BUNDLE_FILES) {
    fs.copyFile(joinRel(root, rel), joinRel(bundleDir, rel))
  }
  /** @type {BundleManifest} */
  const manifest = {
    version,
    fingerprint,
    installedAt: new Date(now()).toISOString(),
    pluginRoot: root,
    files: [...WATCHER_BUNDLE_FILES],
  }
  fs.writeFile(manifestPath(bundleDir), `${JSON.stringify(manifest, null, 2)}\n`)
  return { bundleDir, files: [...WATCHER_BUNDLE_FILES], fingerprint, version }
}

// -- Staged swap ------------------------------------------------------------------------

/**
 * Promote <watcherHome>/next/ over the live bundle: for bin, lib and the
 * manifest, move the live entry to prev/ and the staged entry into place.
 * Each move is an atomic rename; a failure part-way restores every entry
 * already moved from prev/, so the watcher is never left without a bundle.
 * Runtime state (credentials, state.json, logs) is never touched.
 * @param {{ home: string, fs?: WatcherFs }} params
 * @returns {{ ok: boolean, swapped: string[], message: string }}
 */
export function swapStagedBundle({ home, fs = nodeFs() }) {
  const live = watcherHome(home)
  const next = joinDir(live, STAGING_DIR_NAME)
  const prev = joinDir(live, PREVIOUS_DIR_NAME)
  if (!fs.exists(manifestPath(next))) return { ok: false, swapped: [], message: 'nothing_staged' }
  try {
    fs.rm(prev)
  } catch {
    // A leftover prev/ that cannot be removed is reported by the rename below.
  }
  fs.mkdir(prev)
  const swapped = []
  const movedOut = []
  try {
    for (const entry of SWAPPABLE_ENTRIES) {
      const livePath = joinDir(live, entry)
      const nextPath = joinDir(next, entry)
      const prevPath = joinDir(prev, entry)
      if (!fs.exists(nextPath)) continue
      if (fs.exists(livePath)) {
        fs.rename(livePath, prevPath)
        movedOut.push(entry)
      }
      fs.rename(nextPath, livePath)
      swapped.push(entry)
    }
  } catch (err) {
    // Restore: put back every entry we moved out (the staged copy, if it
    // landed, is moved aside first so the rename target is free).
    for (const entry of movedOut) {
      const livePath = joinDir(live, entry)
      const prevPath = joinDir(prev, entry)
      try {
        if (fs.exists(livePath) && swapped.includes(entry)) fs.rename(livePath, joinDir(next, entry))
        fs.rename(prevPath, livePath)
      } catch {
        // Leave prev/ in place for a human; the log names it.
      }
    }
    return { ok: false, swapped: [], message: `swap_failed: ${String(err?.message ?? err)}` }
  }
  try {
    fs.rm(next)
    fs.rm(prev)
  } catch {
    // Leftover staging dirs are harmless; the next swap clears them.
  }
  return { ok: true, swapped, message: 'swapped' }
}
