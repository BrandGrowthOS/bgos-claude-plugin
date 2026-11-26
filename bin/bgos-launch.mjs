#!/usr/bin/env node
/**
 * bgos-launch: node launch shim for the plugin's bun MCP server.
 *
 * Why it exists: .claude-plugin/plugin.json used to launch the MCP server with
 * a bare `bun` command. On a machine where bun is installed but NOT on the
 * PATH Claude Code captured at launch, that spawn died with a silent ENOENT
 * and the channel simply never connected (real failure, 2026-08-21). node is
 * always present (Claude Code runs on it), so the manifest launches THIS shim
 * with node, and the shim finds bun in the places a stale PATH misses, then
 * spawns it with the exact argv it was given.
 *
 * Probe order, first hit wins:
 *   1. $BUN_INSTALL/bin/bun   (the installer's own env var)
 *   2. <home>/.bun/bin/bun    (the installer's default location)
 *   3. every PATH entry, joined with bun
 * then the same three again for bunx as a last resort. On win32 the .exe
 * names are probed alongside the bare ones (some shims ship without .exe).
 *
 * When nothing resolves, the user gets a plain install hint on stderr and
 * exit 127. A raw ENOENT stack is never the user-visible error.
 *
 * On Windows bun also gets WIN32_JSC_THREAD_OPTIONS in its environment, once
 * one `bun -e 0` with them has run: bun 1.3 there leaks every thread that
 * exits, and without them JavaScriptCore starts and stops threads all day
 * (board rows a8646712 and dc37e2ac).
 *
 * Before bun starts the server it checks that the server's packages are there
 * (ensureServerPackages). Claude Code installs a new version's packages itself,
 * with a short cap, and a failed install is only a warning: the version still
 * loads and the server then died at its first import, on every start, until a
 * person fixed the folder by hand (a Mac agent sat offline for 3 days). When a
 * package is missing the launcher copies node_modules from the newest sibling
 * version folder whose bun.lock is byte equal (no network), else runs
 * `bun install --frozen-lockfile --production`, waiting a little less than
 * Claude Code waits for the server (the install runs on, past a start that
 * stops), else says so in one plain line and exits 69, trying the install
 * again at most every 10 min. When the check cannot help at all (no bun to
 * install with, a folder it cannot write) bun starts as it did before.
 * The launcher itself writes only inside the server's own folder (bun's install
 * also fills bun's own package cache, as any bun install does).
 *
 * Self-contained plain JavaScript: node >= 18 builtins only, no imports from
 * the TS plugin sources (lib/browser-profile-node-runtime.mjs is plain and
 * pure: on a Node older than the Agent Browser's floor, 22.12.0, this launcher
 * says so in one plain line and still starts bun). Import-safe: every helper is exported and main() only
 * runs when the file is executed directly, so tests can import the pure pieces.
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, win32 as win32Path, posix as posixPath } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { nodeFloorNotice } from '../lib/browser-profile-node-runtime.mjs'

/** POSIX convention for "command not found"; scripts and humans both read it. */
export const LAUNCH_EXIT_NOT_FOUND = 127

/**
 * EX_UNAVAILABLE: the server's packages are missing and could not be brought
 * back, so bun was never started. Distinct from 127 (no bun) and from anything
 * the server itself exits with before it is up.
 */
export const LAUNCH_EXIT_PACKAGES_MISSING = 69

/** Exit codes for a child that died on a signal (128 + signal number). */
export const SIGNAL_EXIT_CODES = Object.freeze({
  SIGINT: 130,
  SIGTERM: 143,
})

// ── Small pure helpers ───────────────────────────────────────────────────────

/** The node:path flavor for a platform, so tests exercise both on one OS. */
export function pathFlavor(platform) {
  return platform === 'win32' ? win32Path : posixPath
}

/**
 * The executable names to probe for a tool on a platform. win32 gets the .exe
 * name first (the canonical shape) AND the bare name (some shims exist without
 * .exe); everything else gets only the bare name.
 */
export function executableNames(tool, platform) {
  return platform === 'win32' ? [`${tool}.exe`, tool] : [tool]
}

/**
 * Find a runnable bun (or, failing that, bunx) without trusting PATH alone.
 *
 * Returns { path, via } where via names which probe hit:
 *   'bun-install' | 'home' | 'path' for bun,
 *   'bunx-install' | 'bunx-home' | 'bunx-path' for the bunx fallback.
 * Returns null when nothing exists anywhere.
 *
 * Pure given its inputs: env, home, platform, and the exists probe are all
 * injectable, and path joining/splitting uses the node:path flavor for the
 * REQUESTED platform, so tests can exercise win32 and posix on one OS.
 * pathSeparator overrides the flavor's PATH delimiter only when a test needs
 * a nonstandard one.
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   platform?: string,
 *   exists?: (path: string) => boolean,
 *   pathSeparator?: string,
 * }} [opts]
 * @returns {{ path: string, via: string } | null}
 */
export function resolveBunPath({
  env = {},
  home = '',
  platform = process.platform,
  exists = existsSync,
  pathSeparator,
} = {}) {
  const p = pathFlavor(platform)
  const delimiter = pathSeparator ?? p.delimiter
  const tools = [
    { tool: 'bun', vias: { install: 'bun-install', home: 'home', path: 'path' } },
    { tool: 'bunx', vias: { install: 'bunx-install', home: 'bunx-home', path: 'bunx-path' } },
  ]
  for (const { tool, vias } of tools) {
    /** @type {Array<{ dir: string, via: string }>} */
    const dirs = []
    const bunInstall = String(env.BUN_INSTALL ?? '').trim()
    if (bunInstall) dirs.push({ dir: p.join(bunInstall, 'bin'), via: vias.install })
    const homeDir = String(home ?? '').trim()
    if (homeDir) dirs.push({ dir: p.join(homeDir, '.bun', 'bin'), via: vias.home })
    for (const entry of String(env.PATH ?? '').split(delimiter)) {
      const dir = entry.trim()
      if (dir) dirs.push({ dir, via: vias.path })
    }
    for (const { dir, via } of dirs) {
      for (const name of executableNames(tool, platform)) {
        const candidate = p.join(dir, name)
        if (exists(candidate)) return { path: candidate, via }
      }
    }
  }
  return null
}

/** The one-line install command for a platform, straight from bun.sh. */
export function bunInstallHint(platform) {
  return platform === 'win32'
    ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
    : 'curl -fsSL https://bun.sh/install | bash'
}

/**
 * The full stderr message shown when bun cannot be found. It names bun, says
 * why the plugin needs it, gives the exact install command, and tells the user
 * that both bun and bunx must be on PATH afterwards. This message is the whole
 * user-visible error; a raw ENOENT never is.
 */
export function missingBunMessage(platform) {
  return [
    '[bgos-launch] bun was not found on this machine (checked BUN_INSTALL, ~/.bun/bin, and every PATH entry, for both bun and bunx).',
    '[bgos-launch] The HOAI channel plugin runs its MCP server with bun, so it cannot start until bun is installed.',
    '[bgos-launch] Install it with:',
    `[bgos-launch]   ${bunInstallHint(platform)}`,
    '[bgos-launch] After installing, make sure both bun and bunx are on the PATH of the process that starts Claude Code, then restart Claude Code.',
  ].join('\n')
}

/**
 * The cwd for the spawned bun. When the first arg is the server entry
 * (ends with server.ts), bun runs from the directory containing it, the folder
 * whose packages the start check makes sure of. (bun's own auto-install is no
 * help there: it needs the network, and bun turns it off whenever a node_modules
 * exists in the folder or any parent of it.) Any other argv
 * shape (a wrapper .mjs with flags) keeps the inherited cwd.
 * @param {readonly string[]} argv
 * @returns {string | undefined}
 */
export function resolveLaunchCwd(argv, platform = process.platform) {
  const first = String(argv?.[0] ?? '')
  if (!first.endsWith('server.ts')) return undefined
  return pathFlavor(platform).dirname(first)
}

/**
 * Runtime options for bun on Windows (board rows a8646712 and dc37e2ac).
 *
 * On Windows, bun 1.3 leaks every thread that exits: its handle stays open
 * and about 0.3 MB of committed memory stays with it. JavaScriptCore keeps two
 * pools of threads that it starts when there is work and lets exit a few
 * seconds after: the garbage collector's helpers (parallel markers and the
 * concurrent collector thread) and the JIT's compiler threads. An idle daemon
 * collects and compiles every so often, so it made and lost threads all day:
 * its committed memory grew 100 to 330 MB an hour while its working set stayed
 * flat (the lost memory is never touched again), until a PC with seven agents
 * reached 98% commit and jobs were killed. With one marker, no concurrent
 * collector and no concurrent compiler, both pools stay empty: the daemon
 * collects and compiles on its own thread, and nothing starts or exits. Its
 * JavaScript heap is about 13 MB, and on the rig it used less CPU this way.
 *
 * Only Windows: the Mac fleet stays flat on the same bun, so macOS and Linux
 * launch exactly as before. bin/bgos-daemon-wrapper.mjs, copied out of the
 * checkout and importing nothing from it, holds the same table (a test keeps
 * the two equal) and lib/marker-takeover.mjs keeps these keys from a claude it
 * relaunches.
 */
export const WIN32_JSC_THREAD_OPTIONS = Object.freeze({
  BUN_JSC_numberOfGCMarkers: '1',
  BUN_JSC_useConcurrentGC: '0',
  BUN_JSC_useConcurrentJIT: '0',
})

/**
 * The runtime options to add to bun's environment on this platform. A key the
 * operator already set, even to an empty value, is left to them.
 * @param {{ env: Record<string, string | undefined>, platform: string }} input
 * @returns {Record<string, string>}
 */
export function bunRuntimeEnv({ env, platform }) {
  if (platform !== 'win32') return {}
  /** @type {Record<string, string>} */
  const out = {}
  for (const [key, value] of Object.entries(WIN32_JSC_THREAD_OPTIONS)) {
    if (env[key] === undefined) out[key] = value
  }
  return out
}

/**
 * True when this bun refuses `env`'s JSC options. bun exits before any script
 * runs on a BUN_JSC_ option it does not know ("invalid JSC environment
 * variable"), and those options change between bun releases, so one `bun -e 0`
 * with them (about 0.1 s) tells. Anything else, a timeout included, is not a
 * refusal.
 * @param {string} bunPath
 * @param {Record<string, string | undefined>} env
 * @param {typeof spawnSync} [spawnSyncImpl]
 */
export function bunRefusesOptions(bunPath, env, spawnSyncImpl = spawnSync) {
  const probe = spawnSyncImpl(bunPath, ['-e', '0'], { env, encoding: 'utf8', timeout: 15_000, windowsHide: true })
  return /invalid JSC environment variable/i.test(String(probe?.stderr ?? ''))
}

/**
 * The boot line of a daemon that runs on Windows without the thread options,
 * because something other than this launcher started it (a hand written
 * .mcp.json running `bun server.ts`). Null when nothing is missing or off
 * Windows. The daemon logs it once, so a growing helper explains itself.
 * @param {{ env: Record<string, string | undefined>, platform: string }} input
 * @returns {string | null}
 */
export function threadOptionsWarning({ env, platform }) {
  const missing = Object.keys(bunRuntimeEnv({ env, platform }))
  if (missing.length === 0) return null
  return (
    `this daemon runs on Windows without ${missing.join(', ')}: bun there loses memory with every thread ` +
    "it lets go, so its committed memory grows while it runs. bin/bgos-launch.mjs (the plugin's own launch) " +
    'and the Agent Pack wrapper set them whenever this bun accepts them.'
  )
}

/** Map a child's (code, signal) exit to this process's exit code. */
export function exitCodeForChild(code, signal) {
  if (signal) return SIGNAL_EXIT_CODES[signal] ?? 1
  return code ?? 1
}

// ── Start check: the server's packages ───────────────────────────────────────

/** The fallback install: what Claude Code itself runs, without devDependencies. */
export const PACKAGES_INSTALL_ARGS = Object.freeze(['install', '--frozen-lockfile', '--production', '--ignore-scripts', '--no-summary'])
/**
 * The longest a start waits in all, for another start and its own copy and
 * install together. Claude Code stops waiting for an MCP server after
 * MCP_TIMEOUT (about 30 s when unset) and does not try a stdio server again by
 * itself, so a start waits a little less than that (startWaitMs), never more
 * than this.
 */
export const PACKAGES_START_WAIT_MAX_MS = 120_000
/** The install's own cap. It outlives the start that began it, so its keeper enforces this. */
export const PACKAGES_INSTALL_TIMEOUT_MS = 10 * 60_000
/** At most one install attempt per folder in this window, so a restart loop never becomes an install loop. */
export const PACKAGES_RETRY_MS = 10 * 60_000
/** Work names inside the server's own folder. The launcher writes nowhere else. */
export const PACKAGES_LOCK_DIR = '.bgos-packages.lock'
export const PACKAGES_PARTIAL_DIR = '.bgos-node_modules.partial'
export const PACKAGES_OLD_DIR = '.bgos-node_modules.old'
export const PACKAGES_ATTEMPT_FILE = '.bgos-packages-attempt.json'
export const PACKAGES_INSTALL_LOG = '.bgos-packages-install.log'
/** Present while a start copies: one cut off mid copy (Claude Code stopped it) leaves it, and the next start installs instead. */
export const PACKAGES_COPY_FILE = '.bgos-packages-copy.json'
/**
 * Reasons the check could not help at all (no bun to install with, a folder it
 * cannot write): bun starts anyway, as it did before this check, with the line.
 */
export const START_ANYWAY_REASONS = new Set(['no_bun', 'not_writable'])
const PACKAGES_LOCK_POLL_MS = 500
/** A holder (a start, or the install it left running) older than this is hung, alive or not. */
const PACKAGES_LOCK_STALE_MS = PACKAGES_INSTALL_TIMEOUT_MS + 60_000
/** A lock whose owner record cannot be read is taken over after this long. */
const PACKAGES_LOCK_UNOWNED_MS = 10_000
const SIBLINGS_MAX = 20

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function readBytes(path) {
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}

/** The names a package.json requires at run time. devDependencies, optional and peer ones are not required. */
function dependencyNames(manifest) {
  const deps = manifest?.dependencies
  return deps && typeof deps === 'object' && !Array.isArray(deps) ? Object.keys(deps) : []
}

/**
 * Where node (and bun) find package `name` imported from a file in `fromDir`:
 * <dir>/node_modules/<name> for fromDir and then every parent, as the resolver
 * walks. Returns the package's folder and its manifest, or null.
 */
function findPackage(name, fromDir) {
  let dir = fromDir
  for (;;) {
    if (basename(dir) !== 'node_modules') {
      const candidate = join(dir, 'node_modules', ...name.split('/'))
      const manifest = readJson(join(candidate, 'package.json'))
      if (manifest) return { dir: candidate, manifest }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * The packages of `dir`'s production dependency closure that do not resolve
 * from it, transitive ones included, in the order they were looked for. A
 * half finished install (top level packages there, one of theirs not) is
 * missing too: that is what a timed out install leaves.
 * @param {string} dir
 * @param {string[]} [deps] the top level names; defaults to dir/package.json's dependencies
 * @returns {string[]}
 */
export function missingPackages(dir, deps = dependencyNames(readJson(join(dir, 'package.json')))) {
  /** @type {Set<string>} */
  const missing = new Set()
  /** @type {Set<string>} */
  const seen = new Set()
  const queue = deps.map((name) => ({ name, from: dir }))
  for (let i = 0; i < queue.length; i++) {
    const { name, from } = queue[i]
    const found = findPackage(name, from)
    if (!found) {
      missing.add(name)
      continue
    }
    if (seen.has(found.dir)) continue
    seen.add(found.dir)
    for (const dep of dependencyNames(found.manifest)) queue.push({ name: dep, from: found.dir })
  }
  return [...missing]
}

function versionParts(name) {
  const m = /^v?(\d+(?:\.\d+)*)/.exec(name)
  return m ? m[1].split('.').map(Number) : null
}

/**
 * The other version folders beside serverDir, newest version first; folders
 * whose name is no version come last. Only real folders, never serverDir.
 * @param {string} serverDir
 * @returns {string[]}
 */
export function siblingsNewestFirst(serverDir) {
  const parent = dirname(serverDir)
  const self = basename(serverDir)
  let entries
  try {
    entries = readdirSync(parent, { withFileTypes: true })
  } catch {
    return []
  }
  const names = entries.filter((e) => e.isDirectory() && e.name !== self && !e.name.startsWith('.')).map((e) => e.name)
  names.sort((a, b) => {
    const va = versionParts(a)
    const vb = versionParts(b)
    if (va && !vb) return -1
    if (!va && vb) return 1
    if (va && vb) {
      for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const d = (vb[i] ?? 0) - (va[i] ?? 0)
        if (d !== 0) return d
      }
    }
    return a < b ? -1 : a > b ? 1 : 0
  })
  return names.slice(0, SIBLINGS_MAX).map((name) => join(parent, name))
}

/** Copy a folder as it is: relative links stay relative (never pointing into the sibling); APFS clones. */
function defaultCopyDir(from, to) {
  cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, mode: fsConstants.COPYFILE_FICLONE })
}

function removeOwn(path) {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // left for the next start's holder
  }
}

function pathExists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Windows: a virus scanner holding a file that was just written fails a rename for a moment. */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_RETRY_DELAYS_MS = [100, 200, 400, 800, 1000, 1000, 1000]

async function renameWithRetry(from, to, { rename, sleep }) {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to)
      return
    } catch (err) {
      const code = /** @type {any} */ (err)?.code
      if (!RENAME_RETRY_CODES.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err
      await sleep(RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

/**
 * Copy <source>/node_modules into serverDir under a work name, then rename it
 * into place, so a copy that stops half way never sits under the real name.
 * A half installed node_modules already there is moved aside first and put
 * back if the rename fails; the sibling is only read.
 */
async function copyPackagesFrom(source, serverDir, { copyDir, pid, rename, sleep }) {
  const partial = join(serverDir, `${PACKAGES_PARTIAL_DIR}-${pid}`)
  const old = join(serverDir, `${PACKAGES_OLD_DIR}-${pid}`)
  const target = join(serverDir, 'node_modules')
  removeOwn(partial)
  try {
    copyDir(join(source, 'node_modules'), partial)
  } catch (error) {
    removeOwn(partial)
    return { ok: false, error }
  }
  let movedOld = false
  try {
    if (pathExists(target)) {
      await renameWithRetry(target, old, { rename, sleep })
      movedOld = true
    }
    await renameWithRetry(partial, target, { rename, sleep })
  } catch (error) {
    if (movedOld && !pathExists(target)) {
      try {
        await renameWithRetry(old, target, { rename, sleep })
      } catch {
        // left for the next holder's sweep of gone starts' work
      }
    }
    removeOwn(partial)
    return { ok: false, error }
  }
  if (movedOld) removeOwn(old)
  return { ok: true, error: null }
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0) // signal 0: a probe, nothing is sent
    return true
  } catch (err) {
    return /** @type {any} */ (err)?.code === 'EPERM'
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** How long a start waits in all: a little under Claude Code's wait for the MCP server. */
export function startWaitMs(env = {}) {
  const configured = Number(env?.MCP_TIMEOUT)
  const claudeWaits = Number.isFinite(configured) && configured > 0 ? configured : 30_000
  const wait = claudeWaits >= 10_000 ? claudeWaits - 5_000 : Math.floor(claudeWaits / 2)
  return Math.min(PACKAGES_START_WAIT_MAX_MS, wait)
}

/**
 * The packages bun was believed over: an install that exited 0 while this
 * check still could not find them. While nothing beyond those is missing,
 * a start does no work, so a mistake of the check never costs an install per start.
 */
function trustedUnresolved(serverDir) {
  const record = readJson(join(serverDir, PACKAGES_ATTEMPT_FILE))
  return record?.outcome === 'installed' && Array.isArray(record.unresolved) ? new Set(record.unresolved.map(String)) : null
}

/** True when something of the closure does not resolve, beyond what bun was believed over. */
function needsWork(serverDir, deps) {
  const missing = missingPackages(serverDir, deps)
  if (missing.length === 0) return false
  const trusted = trustedUnresolved(serverDir)
  return !(trusted && missing.every((name) => trusted.has(name)))
}

function lockPaths(serverDir) {
  const dir = join(serverDir, PACKAGES_LOCK_DIR)
  return { dir, owner: join(dir, 'owner.json') }
}

/**
 * Replace the owner record of a lock this start holds (the caller has checked
 * ownsLock). Written aside and renamed over, so a start looking at the lock
 * never reads it half written and takes a live lock for an unowned one.
 */
async function writeOwner(serverDir, record, { rename, sleep }) {
  const { dir, owner } = lockPaths(serverDir)
  const aside = join(dir, `owner.json.${randomUUID().slice(0, 8)}`)
  writeFileSync(aside, JSON.stringify(record))
  try {
    await renameWithRetry(aside, owner, { rename, sleep })
  } catch {
    removeOwn(aside) // the record stays as it was: the lock is still ours, only less precise
  }
}

function ownsLock(serverDir, token) {
  return readJson(lockPaths(serverDir).owner)?.token === token
}

/**
 * Release the lock only if it is still ours: a start taken over as hung never
 * removes its successor's. The lock moves to a name of its own first, so a
 * start that takes the folder while it is being removed keeps its new lock.
 */
function releaseLock(serverDir, token, rename) {
  if (!ownsLock(serverDir, token)) return
  const { dir } = lockPaths(serverDir)
  const done = join(serverDir, `${PACKAGES_LOCK_DIR}.done-${token}`)
  try {
    rename(dir, done)
  } catch {
    removeOwn(dir)
    return
  }
  removeOwn(done)
}

/**
 * Take over a lock judged stale. The lock is renamed aside first, which only
 * one start can do, and its owner record read again: if another start took
 * the folder between the look and the rename, its lock goes back, and when it
 * cannot go back it is left aside, never deleted. The gone holder's half copy
 * goes with its lock. True when the lock was moved.
 */
async function takeOverLock(serverDir, seen, { pid, rename, sleep }) {
  const { dir } = lockPaths(serverDir)
  const aside = join(serverDir, `${PACKAGES_LOCK_DIR}.stale-${pid}-${randomUUID().slice(0, 8)}`)
  try {
    await renameWithRetry(dir, aside, { rename, sleep })
  } catch {
    return false
  }
  const moved = readJson(join(aside, 'owner.json'))
  if ((moved?.token ?? null) !== (seen?.token ?? null)) {
    try {
      await renameWithRetry(aside, dir, { rename, sleep })
    } catch {
      // a lock that may be live stays aside rather than gone
    }
    return true
  }
  for (const holder of [seen?.pid, seen?.installPid]) {
    if (!Number.isInteger(holder)) continue
    removeOwn(join(serverDir, `${PACKAGES_PARTIAL_DIR}-${holder}`))
    removeOwn(join(serverDir, `${PACKAGES_OLD_DIR}-${holder}`))
  }
  removeOwn(aside)
  return true
}

/**
 * Take serverDir's lock, so several agents starting the same new version at
 * once fix it once. The lock is made whole under a work name and renamed into
 * place, so it is never seen without its owner. A start that finds it held
 * waits until `deadline` and comes back with `present` as soon as the packages
 * are there. A holder is alive while its start or the install it left running
 * is alive, and for at most PACKAGES_LOCK_STALE_MS; past that it is taken
 * over. Every pass that cannot make progress sleeps and checks the deadline.
 * @returns {Promise<{ token: string } | { result: Record<string, unknown> }>}
 */
async function acquireLock(serverDir, deps, { now, sleep, isAlive, pid, rename, deadline }) {
  const { dir, owner: ownerFile } = lockPaths(serverDir)
  const pace = async () => {
    await sleep(Math.min(PACKAGES_LOCK_POLL_MS, Math.max(1, deadline - now())))
  }
  for (;;) {
    const token = `${pid}-${randomUUID()}`
    const fresh = join(serverDir, `${PACKAGES_LOCK_DIR}.new-${token}`)
    try {
      mkdirSync(fresh)
      writeFileSync(join(fresh, 'owner.json'), JSON.stringify({ pid, at: now(), token }))
    } catch (err) {
      removeOwn(fresh)
      return { result: { status: 'missing', reason: 'not_writable', detail: String(/** @type {any} */ (err)?.message ?? err) } }
    }
    try {
      rename(fresh, dir)
      return { token }
    } catch {
      removeOwn(fresh) // held (or the name is briefly blocked): look at the holder
    }
    const owner = readJson(ownerFile)
    let at = Number(owner?.at)
    if (!Number.isFinite(at)) {
      try {
        at = statSync(dir).mtimeMs
      } catch {
        at = NaN
      }
    }
    if (Number.isFinite(at)) {
      const age = now() - at
      const holders = [owner?.pid, owner?.installPid].filter((p) => Number.isInteger(p))
      const holderGone = holders.length > 0 && !holders.some((p) => isAlive(p))
      if (holderGone || age > PACKAGES_LOCK_STALE_MS || (!owner && age > PACKAGES_LOCK_UNOWNED_MS)) {
        if (await takeOverLock(serverDir, owner, { pid, rename, sleep })) continue
        if (now() >= deadline) {
          return { result: { status: 'missing', reason: 'not_writable', detail: 'a lock left by an earlier start could not be cleared' } }
        }
        await pace()
        continue
      }
      if (!needsWork(serverDir, deps)) return { result: { status: 'present' } }
    }
    if (now() >= deadline) {
      return Number.isFinite(at)
        ? { result: { status: 'missing', reason: 'installing' } }
        : { result: { status: 'missing', reason: 'not_writable', detail: 'the lock could not be made' } }
    }
    await pace()
  }
}

/**
 * Remove the work that starts which are gone left behind: half copies, and
 * locks half made, half released or moved aside. A lock moved aside goes only
 * once its own holders are gone too. This start's own work is never touched.
 */
function clearGoneStartsWork(serverDir, { pid, isAlive }) {
  let names = []
  try {
    names = readdirSync(serverDir)
  } catch {
    return
  }
  const prefixes = [`${PACKAGES_PARTIAL_DIR}-`, `${PACKAGES_OLD_DIR}-`, `${PACKAGES_LOCK_DIR}.new-`, `${PACKAGES_LOCK_DIR}.done-`, `${PACKAGES_LOCK_DIR}.stale-`]
  for (const name of names) {
    const prefix = prefixes.find((p) => name.startsWith(p))
    if (!prefix) continue
    const maker = Number(name.slice(prefix.length).split('-')[0])
    if (!Number.isInteger(maker) || maker <= 0 || maker === pid || isAlive(maker)) continue
    if (prefix.endsWith('.stale-')) {
      const held = readJson(join(serverDir, name, 'owner.json'))
      if ([held?.pid, held?.installPid].some((p) => Number.isInteger(p) && p !== pid && isAlive(p))) continue
    }
    removeOwn(join(serverDir, name))
  }
}

/** The child's end, or null when ms pass first. */
function raceTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve({ code: null, signal: null })
      },
    )
  })
}

function logTail(path) {
  const bytes = readBytes(path)
  return bytes ? oneLine(bytes.subarray(Math.max(0, bytes.length - 4000)).toString('utf8')) : ''
}

/**
 * Make sure the server in serverDir can import its packages, before bun starts.
 * The whole of it, lock, copy and install, fits in one wait (waitMs).
 *
 *   present   nothing was missing: no copy, no install (the common start)
 *   skipped   no package.json or bun.lock: not a folder this check knows
 *   copied    node_modules came from `from`, a sibling with a byte equal bun.lock
 *   installed the fallback install exited 0 (believed even if the check still
 *             names `unresolved` packages: a start bun would have made is never refused)
 *   missing   still missing; `reason` says why: installing (it runs on, past this
 *             start), install_failed, recent_attempt (one try per PACKAGES_RETRY_MS),
 *             and the START_ANYWAY_REASONS no_bun (only bunx) and not_writable
 *
 * @param {{
 *   serverDir: string, bunPath: string | null, env?: Record<string, string | undefined>,
 *   now?: () => number, sleep?: (ms: number) => Promise<unknown>,
 *   copyDir?: (from: string, to: string) => void,
 *   rename?: (from: string, to: string) => void,
 *   runInstall?: typeof startInstall,
 *   siblings?: (serverDir: string) => string[],
 *   isAlive?: (pid: number) => boolean, pid?: number, waitMs?: number,
 * }} input
 */
export async function ensureServerPackages({
  serverDir,
  bunPath,
  env = {},
  now = Date.now,
  sleep = defaultSleep,
  copyDir = defaultCopyDir,
  rename = renameSync,
  runInstall = startInstall,
  siblings = siblingsNewestFirst,
  isAlive = defaultIsAlive,
  pid = process.pid,
  waitMs = startWaitMs(env),
}) {
  const manifest = readJson(join(serverDir, 'package.json'))
  const lock = readBytes(join(serverDir, 'bun.lock'))
  if (!manifest || !lock) return { status: 'skipped', serverDir }
  const deps = dependencyNames(manifest)
  if (!needsWork(serverDir, deps)) return { status: 'present', serverDir }
  const deadline = now() + waitMs
  const done = (outcome) =>
    outcome.status === 'missing' ? { ...outcome, serverDir, missing: missingPackages(serverDir, deps) } : { ...outcome, serverDir }

  const held = await acquireLock(serverDir, deps, { now, sleep, isAlive, pid, rename, deadline })
  if ('result' in held) return done(held.result)
  const lockDir = lockPaths(serverDir).dir
  let keepLock = false
  try {
    if (!needsWork(serverDir, deps)) return done({ status: 'present' })
    clearGoneStartsWork(serverDir, { pid, isAlive })

    // 1. A sibling version folder with the very same lockfile has the very same packages: copy, no network.
    // The copy blocks, so a start Claude Code stops mid copy leaves its record; the next start installs
    // instead of copying again, so a copy too slow for the wait never repeats on every start.
    let copyNote = ''
    const copyPath = join(serverDir, PACKAGES_COPY_FILE)
    const lastCopy = readJson(copyPath)
    const lastCopyAt = Number(lastCopy?.at)
    const copyCutOff =
      Number.isInteger(lastCopy?.pid) && lastCopy.pid !== pid && !isAlive(lastCopy.pid) &&
      Number.isFinite(lastCopyAt) && now() >= lastCopyAt && now() - lastCopyAt < PACKAGES_RETRY_MS
    if (copyCutOff) copyNote = 'the last copy from another version was cut off'
    for (const sibling of copyCutOff ? [] : siblings(serverDir)) {
      const theirs = readBytes(join(sibling, 'bun.lock'))
      if (!theirs || !theirs.equals(lock)) continue
      if (!pathExists(join(sibling, 'node_modules')) || missingPackages(sibling, deps).length > 0) continue
      writeFileSync(copyPath, JSON.stringify({ pid, at: now() }))
      let copied
      try {
        copied = await copyPackagesFrom(sibling, serverDir, { copyDir, pid, rename, sleep })
      } finally {
        removeOwn(copyPath)
      }
      if (copied.ok && missingPackages(serverDir, deps).length === 0) return done({ status: 'copied', from: sibling })
      copyNote = `copying them from ${basename(sibling)} failed: ${oneLine(copied.error?.message ?? 'still incomplete')}`
      break // one copy per start; a full disk fails the next sibling too
    }

    // 2. The install, at most once per PACKAGES_RETRY_MS.
    const fail = (reason, detail, retryAt) => done({ status: 'missing', reason, detail: [copyNote, detail].filter(Boolean).join('; '), retryAt })
    if (!bunPath) return fail('no_bun', '', null)
    const attemptPath = join(serverDir, PACKAGES_ATTEMPT_FILE)
    const logPath = join(serverDir, PACKAGES_INSTALL_LOG)
    const last = readJson(attemptPath)
    const lastAt = Number(last?.at)
    if (!last?.outcome && Number.isFinite(lastAt) && now() >= lastAt && now() - lastAt < PACKAGES_RETRY_MS) {
      return fail('recent_attempt', String(last?.detail ?? '') || logTail(logPath), lastAt + PACKAGES_RETRY_MS)
    }
    const at = now()
    writeFileSync(attemptPath, JSON.stringify({ at }))
    const child = runInstall(bunPath, [...PACKAGES_INSTALL_ARGS], { cwd: serverDir, env, logPath, attemptPath, lockDir, token: held.token, at })
    // The install runs on its own: if Claude Code stops this start, the install still finishes, and
    // the lock names it, so no start begins a second one beside it.
    if (Number.isInteger(child.pid) && ownsLock(serverDir, held.token)) await writeOwner(serverDir, { pid, installPid: child.pid, at, token: held.token }, { rename, sleep })
    const end = await raceTimeout(child.done, Math.max(0, deadline - now()))
    if (end === null) {
      // Still going: it keeps the folder (its keeper lets go when bun ends), and a start meanwhile waits for it.
      if (Number.isInteger(child.pid) && ownsLock(serverDir, held.token)) {
        await writeOwner(serverDir, { pid: child.pid, at, token: held.token }, { rename, sleep })
        keepLock = true
      }
      child.unref?.()
      return fail('installing', '', null)
    }
    const unresolved = missingPackages(serverDir, deps)
    if (end.code === 0 || unresolved.length === 0) {
      if (unresolved.length > 0) writeFileSync(attemptPath, JSON.stringify({ at, outcome: 'installed', unresolved }))
      else removeOwn(attemptPath)
      removeOwn(logPath)
      removeOwn(copyPath)
      return done({ status: 'installed', unresolved })
    }
    const recorded = readJson(attemptPath)
    const detail =
      (recorded?.reason === 'install_failed' ? oneLine(recorded.detail) : '') ||
      logTail(logPath) ||
      (end.code != null ? `bun exited ${end.code}` : oneLine(end.error ?? ''))
    writeFileSync(attemptPath, JSON.stringify({ at, reason: 'install_failed', detail }))
    return fail('install_failed', detail, at + PACKAGES_RETRY_MS)
  } finally {
    if (!keepLock) releaseLock(serverDir, held.token, rename)
  }
}

function oneLine(text) {
  return String(text ?? '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop()
    ?.slice(0, 240) ?? ''
}

/**
 * The install's keeper, a tiny node script run detached: it runs bun with
 * stdout nowhere and stderr into the log, stops it at its cap, and when bun
 * ends records how it went and lets go of the lock, if the lock is still the
 * one its start held. So an install that outlives its start (Claude Code
 * stopped waiting) still leaves the folder in order. Builtins only.
 */
const INSTALL_KEEPER = `
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const o = JSON.parse(process.argv[process.argv.length - 1])
const lastLine = () => {
  try {
    const lines = fs.readFileSync(o.logPath, 'utf8').slice(-4000).replace(/\\x1b\\[[0-9;]*[A-Za-z]/g, '').split(/\\r?\\n/).map((l) => l.trim()).filter(Boolean)
    return (lines.pop() || '').slice(0, 240)
  } catch {
    return ''
  }
}
let err = 'ignore'
try { err = fs.openSync(o.logPath, 'w') } catch {}
let timedOut = false
let ended = false
const end = (code, error) => {
  if (ended) return
  ended = true
  clearTimeout(timer)
  try {
    if (code === 0) fs.rmSync(o.attemptPath, { force: true })
    else {
      const detail = timedOut ? 'installing them took longer than ' + Math.round(o.timeoutMs / 1000) + ' s' : lastLine() || error || 'bun exited ' + code
      fs.writeFileSync(o.attemptPath, JSON.stringify({ at: o.at, reason: 'install_failed', detail }))
    }
  } catch {}
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(o.lockDir, 'owner.json'), 'utf8'))
    if (owner && owner.token === o.token) {
      const done = o.lockDir + '.done-' + o.token
      try { fs.renameSync(o.lockDir, done) } catch { fs.rmSync(o.lockDir, { recursive: true, force: true }) }
      fs.rmSync(done, { recursive: true, force: true })
    }
  } catch {}
  process.exit(code === 0 ? 0 : typeof code === 'number' && code > 0 ? code : 1)
}
const child = spawn(o.file, o.args, { cwd: o.cwd, env: process.env, stdio: ['ignore', 'ignore', err], windowsHide: true })
const timer = setTimeout(() => {
  timedOut = true
  try { child.kill('SIGKILL') } catch {}
}, o.timeoutMs)
child.on('error', (e) => end(null, String((e && e.message) || e)))
child.on('exit', (code) => end(code))
`

/**
 * Start the install through its keeper (INSTALL_KEEPER): detached, so a stop
 * of this start does not stop it (its own process group on macOS and Linux),
 * with nothing on this launcher's stdout, which is the MCP channel. Never throws.
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd: string, env: Record<string, string | undefined>, logPath: string, attemptPath?: string,
 *   lockDir?: string, token?: string, at?: number, timeoutMs?: number }} opts
 * @returns {{ pid: number | null, done: Promise<{ code: number | null, signal: string | null, error?: string }>, unref: () => void }}
 */
export function startInstall(file, args, { cwd, env, logPath, attemptPath, lockDir, token, at, timeoutMs = PACKAGES_INSTALL_TIMEOUT_MS }) {
  const spec = JSON.stringify({ file, args, cwd, logPath, attemptPath, lockDir, token, at, timeoutMs })
  try {
    const child = spawn(process.execPath, ['-e', INSTALL_KEEPER, spec], { cwd, env, stdio: 'ignore', detached: true, windowsHide: true })
    const done = new Promise((resolve) => {
      child.once('error', (err) => resolve({ code: null, signal: null, error: String(err?.message ?? err) }))
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    return { pid: child.pid ?? null, done, unref: () => child.unref() }
  } catch (err) {
    return { pid: null, done: Promise.resolve({ code: null, signal: null, error: String(/** @type {any} */ (err)?.message ?? err) }), unref: () => {} }
  }
}

function listNames(names) {
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')
}

function clockTime(ms) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The one plain line for a folder whose packages are still missing: what is
 * wrong, why, what happens next, and the fix by hand (in words, no shell syntax).
 * @param {{ serverDir: string, status?: string, missing?: string[], reason?: string, detail?: string, retryAt?: number | null }} result
 */
export function packagesMissingMessage(result) {
  const detail = oneLine(result.detail ?? '')
  const with_ = (text) => `${text}${detail ? ` (${detail})` : ''}`
  const why = {
    install_failed: with_('installing them failed'),
    installing: 'they are being installed now, which can take a few minutes on a slow link',
    recent_attempt: with_('the last try to install them failed'),
    no_bun: with_('only bunx was found, so they could not be installed'),
    not_writable: with_('this folder cannot be written to'),
  }[String(result.reason)] ?? with_('they could not be brought back')
  const next = START_ANYWAY_REASONS.has(String(result.reason))
    ? 'starting anyway'
    : result.reason === 'installing'
      ? 'once they are in, restart Claude Code or reconnect this server in /mcp'
      : typeof result.retryAt === 'number' && result.retryAt > 0
        ? `it tries again on a start after ${clockTime(result.retryAt)}`
        : 'it tries again on the next start'
  const lead = START_ANYWAY_REASONS.has(String(result.reason)) ? 'This plugin version' : 'This agent cannot start: this plugin version'
  return (
    `[bgos-launch] ${lead} is missing packages (${listNames(result.missing ?? [])}) and ${why}; ${next}. ` +
    `To fix it now, run bun install --production in "${result.serverDir}"`
  )
}

/**
 * True when serverDir has a package.json and a bun.lock and something of its
 * closure does not resolve. A check that throws is no reason to hold the start.
 */
export function packagesNeedWork(serverDir, writeErr = () => {}) {
  try {
    const manifest = readJson(join(serverDir, 'package.json'))
    if (!manifest || !existsSync(join(serverDir, 'bun.lock'))) return false
    return needsWork(serverDir, dependencyNames(manifest))
  } catch (err) {
    writeErr(`[bgos-launch] start check failed: ${oneLine(/** @type {any} */ (err)?.message ?? err)}; starting anyway\n`)
    return false
  }
}

/**
 * The start check as main runs it. True when bun should start. A check that
 * throws, or one that could not help (START_ANYWAY_REASONS), never stops a
 * start that might have worked.
 */
async function startCheck({ serverDir, bunPath, env, writeErr, packages }) {
  try {
    const result = await ensureServerPackages({ serverDir, bunPath, env, ...packages })
    if (result.status === 'copied') {
      writeErr(`[bgos-launch] this version was missing packages; copied them from ${result.from} (same bun.lock)\n`)
    } else if (result.status === 'installed') {
      const unresolved = /** @type {string[]} */ (result.unresolved ?? [])
      writeErr(
        unresolved.length > 0
          ? `[bgos-launch] this version was missing packages; bun installed them, though this check still cannot find ${listNames(unresolved)}; starting anyway\n`
          : '[bgos-launch] this version was missing packages; installed them\n',
      )
    }
    if (result.status !== 'missing') return true
    writeErr(`${packagesMissingMessage(result)}\n`)
    return START_ANYWAY_REASONS.has(String(result.reason))
  } catch (err) {
    writeErr(`[bgos-launch] start check failed: ${oneLine(/** @type {any} */ (err)?.message ?? err)}; starting anyway\n`)
    return true
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

/**
 * Resolve bun, check the server's packages (ensureServerPackages), and hand bun
 * the exact argv this shim received. Resolves with the exit code this process
 * should report: the child's own code (128 + n when it died on a signal), 127
 * with the install hint on stderr when bun cannot be found or spawned, or 69
 * with one plain line when the server's packages are missing and stay missing.
 * @param {string[]} [argv]
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   platform?: string,
 *   exists?: (path: string) => boolean,
 *   spawnImpl?: typeof spawn,
 *   spawnSyncImpl?: typeof spawnSync,
 *   writeErr?: (text: string) => void,
 *   onSignal?: (signal: string, handler: () => void) => void,
 *   nodeVersion?: string,
 *   packages?: Partial<Parameters<typeof ensureServerPackages>[0]>,
 * }} [opts]
 * @returns {Promise<number>}
 */
export function main(argv = process.argv.slice(2), opts = {}) {
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const platform = opts.platform ?? process.platform
  const exists = opts.exists ?? existsSync
  const spawnImpl = opts.spawnImpl ?? spawn
  const writeErr = opts.writeErr ?? ((text) => process.stderr.write(text))
  const onSignal = opts.onSignal ?? ((signal, handler) => process.on(signal, handler))
  const floor = nodeFloorNotice(opts.nodeVersion ?? process.versions.node)
  if (floor) writeErr(`[bgos-launch] ${floor}\n`)

  return new Promise((resolve, reject) => {
    const resolved = resolveBunPath({ env, home, platform, exists })
    if (!resolved) {
      writeErr(`${missingBunMessage(platform)}\n`)
      resolve(LAUNCH_EXIT_NOT_FOUND)
      return
    }
    const cwd = resolveLaunchCwd(argv, platform)
    // The common start (packages there, or no folder this check knows) spawns in
    // this same tick, exactly as before; only a folder with work to do waits.
    if (!cwd || !packagesNeedWork(cwd, writeErr)) {
      launch(resolved, cwd)
      return
    }
    // The bunx last resort is no bun to install with: the check copies, or says so.
    const bunPath = resolved.via.startsWith('bunx') ? null : resolved.path
    startCheck({ serverDir: cwd, bunPath, env, writeErr, packages: opts.packages }).then((ok) => {
      // A launch that throws here reaches the caller as it does on the same-tick path, never unhandled.
      try {
        if (ok) launch(resolved, cwd)
        else resolve(LAUNCH_EXIT_PACKAGES_MISSING)
      } catch (err) {
        reject(err)
      }
    })

    function launch(resolved, cwd) {
      // Carry the ORIGINAL working directory across the relocation.
      //
      // 2026-08-27: relocating cwd (so bun can resolve the server's dependencies)
      // silently broke the folder pin for every marketplace install. Claude Code
      // launches us as `node bgos-launch.mjs <plugin>/server.ts`, so the server's
      // process.cwd() became the PLUGIN CACHE directory, and the identity lookup
      // read `<plugin>/.bgos-agent-id` instead of the user's own folder. The pin
      // could never be found, and the refusal then told the user to create the
      // very file it had just made unreadable. A partner did exactly that, twice,
      // correctly, and lost an evening to it.
      //
      // We could not simply stop relocating: the relocation is what makes bun
      // resolve dependencies. So the original directory travels in the
      // environment, which survives the switch, and the server prefers it for
      // the pin lookup only. Everything else still runs from the plugin dir.
      //
      // On Windows bun also gets its thread options (WIN32_JSC_THREAD_OPTIONS),
      // unless this bun refuses them: then it starts without them, as before.
      // The bunx last resort starts as before too: `bunx -e 0` is no check of bun's.
      let runtime = resolved.via.startsWith('bunx') ? {} : bunRuntimeEnv({ env, platform })
      if (Object.keys(runtime).length > 0 && bunRefusesOptions(resolved.path, { ...env, ...runtime }, opts.spawnSyncImpl)) {
        writeErr(`[bgos-launch] this bun refuses ${Object.keys(runtime).join(', ')}; starting it without them\n`)
        runtime = {}
      }
      const extra = {
        ...runtime,
        ...(cwd ? { BGOS_LAUNCH_CWD: env.BGOS_LAUNCH_CWD || process.cwd() } : {}),
      }
      const child = spawnImpl(resolved.path, argv, {
        stdio: 'inherit',
        ...(cwd ? { cwd } : {}),
        ...(Object.keys(extra).length > 0 ? { env: { ...env, ...extra } } : {}),
      })
      // Forward termination to the child so a stopped shim never strands a bun
      // process holding the MCP stdio pipes. Signal listeners do not hold the
      // event loop open, so the shim still exits when the child does.
      const forward = (signal) => {
        try {
          child.kill(signal)
        } catch {
          // already gone; nothing to forward to.
        }
      }
      onSignal('SIGTERM', () => forward('SIGTERM'))
      onSignal('SIGINT', () => forward('SIGINT'))
      child.on('error', (err) => {
        // A resolved path that still fails to spawn (EACCES, a broken install)
        // gets the same guidance as a missing bun, never a bare stack.
        writeErr(`[bgos-launch] could not start ${resolved.path}: ${err?.message ?? err}\n`)
        writeErr(`${missingBunMessage(platform)}\n`)
        resolve(LAUNCH_EXIT_NOT_FOUND)
      })
      child.on('exit', (code, signal) => {
        resolve(exitCodeForChild(code, signal))
      })
    }
  })
}

/**
 * True when this file is the process entry point. Compares REAL paths on both
 * sides so a symlinked bin (npm/npx puts a shim in node_modules/.bin, and paths
 * under /tmp resolve through /private/tmp on macOS) still runs main(); a plain
 * href compare would fail those and silently do nothing.
 */
export function isRunAsMain(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (typeof argv1 !== 'string') return false
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1)
  } catch {
    return moduleUrl === pathToFileURL(argv1).href
  }
}

if (isRunAsMain()) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      console.error(`[bgos-launch] fatal: ${err?.message ?? err}`)
      process.exitCode = LAUNCH_EXIT_NOT_FOUND
    })
}
