/**
 * clone-hooks: register the HOAI hooks for a CLONE agent workspace from inside
 * the plugin, with no CLI in the loop (board bbbf3438 follow-up).
 *
 * WHY THIS EXISTS. A clone install gets its hooks only from the workspace's
 * own `.claude/settings.local.json`. Since 0.67.0 a boards, schedule or browser
 * call also needs the private turn hook there, and `bgos-agent update` was the
 * only thing that wrote it. A daemon that updates itself (lib/self-update.ts)
 * or that the watcher updates (lib/update-executor.mjs) never ran the CLI, so
 * the first restart onto 0.67.x left every private call refused: 15 agents of
 * one other user on a MacBook-Air-2 (0.67.1) and 4 on kc-server were one
 * restart away from it.
 *
 * Two callers, one rule:
 *   - lib/self-update.ts, through bin/hoai-register-hooks.mjs, right after the
 *     pull and BEFORE the restart, so the new session reads the hooks at launch
 *     (the CLI reads them once, at launch). Run as a child of the NEW checkout
 *     so it is the new code that writes them.
 *   - server.ts at EVERY boot of a clone (registerCloneHooksAtBoot), so the
 *     NEXT launch has the current set however this one was started (board row
 *     f83db4b7). `hoai run` rewrites the hooks before every launch; an agent
 *     started any other way (KC's Windows hoai-switch.ps1 starts claude
 *     directly) had only this, and it used to run only while the private turn
 *     hook was missing, so once a folder had that one entry no later hook
 *     change ever reached it.
 *
 * The rule: only a workspace whose `.mcp.json` names a `bgos` server that
 * THIS checkout serves is touched (its `server.ts`, or the stable wrapper with
 * this checkout as `--plugin-dir`). "This checkout" is asked of the disk, not
 * of the spelling (sameOnDisk below): a home may be aliased, and on Windows
 * one folder has many spellings (the drive letter's case, each name's case, an
 * 8.3 short name, the \\?\ prefix). Compared as text, a Windows workspace that
 * spelled its checkout any other way than the daemon does was taken for
 * another checkout's: no boot and no update wrote it a hook, and nothing said
 * so. A marketplace install is never touched, its hooks come from
 * the plugin's hooks.json and a second entry would run each hook twice. A
 * folder that never carried the activity rail gets the rail and the private
 * turn hook, NOT the blocking floor hook: a held action on an unattended agent
 * is the owner's decision, not an update's. A folder that already carries the
 * rail keeps its full set. Note what that rule does and does not do: it holds
 * for the registration that WRITES the rail. The next registration finds the
 * rail and writes the full set, floor included; that used to be the next
 * update, and with registration at every boot it is the next boot, so the
 * floor is withheld for one launch, not for good (test/clone-hooks.boot.test.ts
 * pins it). A durable "no floor" would need a record of who wrote the rail.
 * The owner's own command, `hoai hooks` (bin/hoai-core.mjs), is not under this
 * rule: it writes what a `hoai` launch writes, the floor included.
 *
 * The scripts the hooks run come from the install that writes them, never from
 * the folder: not from a checkout its .mcp.json names, not from a path its
 * settings file already holds. All four come from that install's own bin
 * folder by its real path (trustedHookScripts), and each must be a plain file
 * there, not a link and not missing; otherwise nothing is written. A launcher
 * and a boot both write that real path, so neither rewrites the other's block.
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe; file access is
 * injectable so tests run on a temp dir.
 */

import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { ensureHookEntries } from './claude-preseed.mjs'
import { fileIdentity } from './file-identity.mjs'

/**
 * @typedef {{ readFile: (p: string) => string | null, realpath: (p: string) => string | null,
 *   identity?: (p: string) => string | null,
 *   kind?: (p: string) => 'file' | 'dir' | 'link' | 'other' | null }} CloneFs
 */

/** The most a .mcp.json may hold before it is not read at all: 1 MiB, far more than any agent folder's. */
export const CONFIG_FILE_MAX_BYTES = 1024 * 1024
/** The most server entries a .mcp.json may hold before it is not read as an agent folder's. */
const MAX_SERVER_ENTRIES = 64

/** The plugin's four hook scripts, by file name, all in an install's bin folder. */
export const HOOK_SCRIPT_NAMES = Object.freeze(['hoai-hook.mjs', 'hoai-floor-hook.mjs', 'hoai-private-turn-hook.mjs', 'hoai-mission-turn-hook.mjs'])

/** A JSON object, not an array and not null. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A file's text when it is a file of at most `max` bytes, else null. Never reads more than that. */
function readTextUpTo(path, max) {
  let fd
  try {
    fd = openSync(path, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > max) return null
    const buffer = Buffer.alloc(max + 1)
    let length = 0
    for (;;) {
      const got = readSync(fd, buffer, length, buffer.length - length, null)
      if (got === 0) break
      length += got
      if (length > max) return null
    }
    return buffer.subarray(0, length).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** @returns {CloneFs} */
function nodeCloneFs() {
  return {
    // A .mcp.json larger than any agent folder's is not read whole: it reads as no file at all.
    readFile: (p) => readTextUpTo(p, CONFIG_FILE_MAX_BYTES),
    // The volume's own spelling when it gives one. On Windows the portable
    // realpath (node's and bun's alike) resolves a link and keeps the rest as
    // the caller wrote it, and node's refuses a \\?\ path; the native one
    // answers one spelling for one folder.
    realpath: (p) => {
      try {
        return realpathSync.native(p)
      } catch {
        // A volume the native call cannot name (some RAM and virtual disks): the portable walk.
      }
      try {
        return realpathSync(p)
      } catch {
        return null
      }
    },
    // What the volume itself calls this folder or file (its volume and file
    // id): the same under every spelling, and another folder's is another.
    // Unknown (a number the volume does not keep) is null, never a match.
    identity: (p) => fileIdentity(p),
    // What is at a path itself, a link not followed.
    kind: (p) => {
      try {
        const stat = lstatSync(p)
        return stat.isSymbolicLink() ? 'link' : stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : 'other'
      } catch {
        return null
      }
    },
  }
}

/**
 * Do two paths name one folder (or one file) on disk? Their real paths as text
 * first: the volume's own spelling is one text for one folder, whatever case,
 * short name, prefix, link or subst drive the caller used. Where the two still
 * differ only in letter case (a volume that could not give its own spelling
 * keeps the caller's), the volume's id for each decides. Only then: an id
 * alone is not enough, a disk cloned from another gives two folders one id.
 * One of them missing, or a volume that cannot say, is "no": in doubt nothing
 * is written.
 * @param {string} a
 * @param {string} b
 * @param {CloneFs} fs
 */
function sameOnDisk(a, b, fs) {
  const realA = fs.realpath(a)
  const realB = fs.realpath(b)
  // Only a path that was answered counts: two paths with no answer are not one folder.
  if (typeof realA !== 'string' || realA === '' || typeof realB !== 'string' || realB === '') return false
  if (realA === realB) return true
  if (realA.toLowerCase() !== realB.toLowerCase() || typeof fs.identity !== 'function') return false
  const idA = fs.identity(realA)
  return typeof idA === 'string' && idA !== '' && idA === fs.identity(realB)
}

/**
 * A Windows path without its \\?\ prefix (\\?\UNC\host\share becomes
 * \\host\share). The prefix names the same folder, and node cannot start a
 * script whose path carries it, so no hook path may be built from it or kept
 * with it.
 * @param {unknown} path
 * @returns {string}
 */
export function withoutLongPathPrefix(path) {
  const text = String(path ?? '')
  const unc = /^([\\/])\1\?[\\/]UNC[\\/]/i.exec(text)
  if (unc) return `${unc[1]}${unc[1]}${text.slice(unc[0].length)}`
  return text.replace(/^[\\/]{2}\?[\\/]/, '')
}

/**
 * The checkout a workspace's .mcp.json starts for its server, as written there:
 * the folder of the server.ts it runs (the bootstraps' and `hoai`'s form), or
 * the --plugin-dir handed to the stable wrapper (bin/bgos-claim.mjs
 * buildMcpJson, bin/bgos-agent write_mcp_json), whose args name no server.ts.
 * '' when it names neither. Relative paths stay relative: the caller resolves
 * them against the workspace. A \\?\ prefix is dropped (withoutLongPathPrefix).
 * @param {string | null | undefined} raw  the .mcp.json text
 * @param {string} [serverName]
 * @returns {string}
 */
export function declaredCheckout(raw, serverName = 'bgos') {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  let args
  try {
    args = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)?.mcpServers?.[serverName]?.args
  } catch {
    return ''
  }
  return checkoutFromArgs(args)
}

/** The checkout one server entry's args start: its server.ts's folder, or the --plugin-dir; '' for neither. */
function checkoutFromArgs(args) {
  if (!Array.isArray(args)) return ''
  const server = args.find((a) => typeof a === 'string' && a.endsWith('server.ts'))
  if (server) return withoutLongPathPrefix(dirname(server))
  const flag = args.indexOf('--plugin-dir')
  const dir = flag >= 0 && typeof args[flag + 1] === 'string' ? args[flag + 1].trim() : ''
  return withoutLongPathPrefix(dir)
}

/**
 * The names of the server entries in one .mcp.json text that start THIS checkout (its server.ts, or the wrapper
 * with it as --plugin-dir), asked of the disk, and when there is none, why (one clause). The text is read once by
 * the caller and parsed once here, so the folder is decided from one answer and not from two reads that may differ.
 * An entry's name, or a key in its env, makes nothing this checkout's: only what the entry starts does. Bounded: a
 * text over CONFIG_FILE_MAX_BYTES, or one with more than MAX_SERVER_ENTRIES entries, is not read as a folder's.
 * @param {{ raw: string | null | undefined, workdir: string, pluginDir: string, fs?: CloneFs }} input
 * @returns {{ names: string[], why: string }}
 */
export function serversStartingCheckout({ raw, workdir, pluginDir, fs = nodeCloneFs() }) {
  if (typeof raw !== 'string' || raw.length === 0) return { names: [], why: 'it has no .mcp.json that can be read' }
  if (raw.length > CONFIG_FILE_MAX_BYTES) return { names: [], why: 'its .mcp.json is larger than any agent folder needs' }
  let servers
  try {
    servers = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)?.mcpServers
  } catch {
    return { names: [], why: 'its .mcp.json is not JSON' }
  }
  if (!isPlainObject(servers)) return { names: [], why: 'its .mcp.json has no server entries' }
  const entries = Object.entries(servers)
  if (entries.length > MAX_SERVER_ENTRIES) return { names: [], why: 'its .mcp.json has more server entries than any agent folder needs' }
  const names = []
  for (const [name, entry] of entries) {
    const dir = isPlainObject(entry) ? checkoutFromArgs(entry.args) : ''
    if (dir && sameOnDisk(resolve(workdir, dir), resolve(pluginDir), fs)) names.push(name)
  }
  return { names, why: names.length === 0 ? 'its .mcp.json has no server entry that starts this checkout' : '' }
}

/** A real path the hook scripts can be named by: the prefix dropped, and '' for none node can start. */
function startablePath(path, fs) {
  const real = fs.realpath(path)
  if (typeof real !== 'string' || real === '') return ''
  const plain = withoutLongPathPrefix(real)
  // A volume with no drive letter is named only with the prefix (\\?\Volume{...}): no hook path can be built on it.
  return /^([A-Za-z]:[\\/]|[\\/])/.test(plain) ? plain : ''
}

/**
 * The hook scripts of the install at `pluginDir`, from its own bin folder by its real path, or why not. Each of the
 * four must be a plain file in that folder: one that is missing, a link, or anything else is refused, and so is a
 * bin folder that is itself a link. `pluginDir` is the install that is running (the daemon's own folder, the
 * launcher's own checkout), never a path from an agent folder.
 * @param {{ pluginDir: string, fs?: CloneFs }} input
 * @returns {{ ok: true, bin: string, forwarderPath: string } | { ok: false, why: string }}
 */
export function trustedHookScripts({ pluginDir, fs = nodeCloneFs() }) {
  const asked = String(pluginDir ?? '').trim()
  const root = asked ? startablePath(resolve(asked), fs) : ''
  if (!root) return { ok: false, why: `the checkout ${oneLine(asked) || '(none named)'} cannot be found` }
  const bin = startablePath(join(root, 'bin'), fs)
  if (bin !== join(root, 'bin')) return { ok: false, why: `the bin folder of ${root} is missing or is a link` }
  for (const name of HOOK_SCRIPT_NAMES) {
    const script = join(bin, name)
    const kind = typeof fs.kind === 'function' ? fs.kind(script) : null
    if (kind !== 'file' || startablePath(script, fs) !== script) {
      const what = kind === null ? 'missing' : kind === 'link' ? 'a link' : 'not a plain file'
      return { ok: false, why: `the hook script ${script} is ${what}` }
    }
  }
  return { ok: true, bin, forwarderPath: join(bin, 'hoai-hook.mjs') }
}

/**
 * Write a launch's hook entries from the launcher's own install: `forwarderPath` names that install's
 * bin/hoai-hook.mjs (bin/hoai-core.mjs hookRegistrationFor, from the launcher's own folder), and the entries are
 * written with the real paths trustedHookScripts gives, all four verified. Throws, writing nothing, when they
 * cannot be (the caller turns that into its one line).
 * @param {{ settingsPath: string, forwarderPath: string, floorHookPath?: string | null, fs?: CloneFs,
 *   register?: typeof ensureHookEntries }} input
 */
export function registerTrustedHooks({ settingsPath, forwarderPath, floorHookPath, fs = nodeCloneFs(), register = ensureHookEntries }) {
  const forwarder = String(forwarderPath ?? '').trim()
  const bin = dirname(forwarder)
  if (basename(forwarder) !== 'hoai-hook.mjs' || basename(bin).toLowerCase() !== 'bin') {
    throw new Error(`no hook was written: ${oneLine(forwarder)} is not a checkout's bin/hoai-hook.mjs`)
  }
  const scripts = trustedHookScripts({ pluginDir: dirname(bin), fs })
  if (!scripts.ok) throw new Error(`no hook was written: ${scripts.why}`)
  return register({ settingsPath, forwarderPath: scripts.forwarderPath, ...(floorHookPath === undefined ? {} : { floorHookPath }) })
}

/**
 * Text from a file the folder's owner wrote, made fit for one log line: no
 * line break or other control character, and at most `max` characters.
 * @param {unknown} text
 * @param {number} [max]
 */
function oneLine(text, max = 200) {
  const flat = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat
}

/**
 * Does this workspace's .mcp.json start THIS checkout, and when it does not,
 * what does the folder name instead (one clause, for the log)?
 * @param {{ workdir: string, pluginDir: string, fs: CloneFs }} input
 * @returns {{ ours: boolean, why: string }}
 */
function cloneVerdict({ workdir, pluginDir, fs }) {
  const raw = fs.readFile(join(workdir, '.mcp.json'))
  if (raw == null) return { ours: false, why: 'it has no .mcp.json that can be read' }
  const dir = declaredCheckout(raw)
  if (!dir) return { ours: false, why: 'its .mcp.json names no bgos server of a checkout' }
  if (sameOnDisk(resolve(workdir, dir), resolve(pluginDir), fs)) return { ours: true, why: '' }
  return { ours: false, why: `its .mcp.json starts ${oneLine(dir)}` }
}

/**
 * Does this workspace's .mcp.json start THIS checkout (its server.ts, or the
 * wrapper with this checkout as --plugin-dir)? Asked of the disk (sameOnDisk),
 * so every spelling of this checkout is this checkout, and no other folder is.
 * @param {{ workdir: string, pluginDir: string, fs?: CloneFs }} input
 */
export function workspaceNamesThisClone({ workdir, pluginDir, fs = nodeCloneFs() }) {
  return cloneVerdict({ workdir, pluginDir, fs }).ours
}

/**
 * Register the hooks for one workspace when it is a clone workspace of this
 * checkout. Never throws. The scripts are this checkout's own (trustedHookScripts),
 * whatever the settings file named before; the floor hook is decided from the
 * file's own entries (ensureHookEntries with floorHookPath null): written where the
 * file has the rail or the floor hook, and never removed.
 * @param {{ workdir: string, pluginDir: string, fs?: CloneFs,
 *   register?: typeof ensureHookEntries }} input
 * @returns {{ outcome: 'registered' | 'already' | 'not_clone' | 'failed', detail?: string, floor: boolean }}
 */
export function registerCloneHooks({ workdir, pluginDir, fs = nodeCloneFs(), register = ensureHookEntries }) {
  try {
    const verdict = cloneVerdict({ workdir, pluginDir, fs })
    if (!verdict.ours) return { outcome: 'not_clone', detail: verdict.why, floor: false }
    const scripts = trustedHookScripts({ pluginDir, fs })
    if (!scripts.ok) return { outcome: 'failed', detail: `no hook was written: ${scripts.why}`, floor: false }
    const settingsPath = join(workdir, '.claude', 'settings.local.json')
    const result = register({ settingsPath, forwarderPath: scripts.forwarderPath, floorHookPath: null })
    const floor = result?.floor === true
    if (result?.reason === 'not_persisted') return { outcome: 'failed', detail: 'the settings write did not persist', floor }
    return { outcome: result?.changed ? 'registered' : 'already', floor }
  } catch (error) {
    return { outcome: 'failed', detail: String(error?.message ?? error), floor: false }
  }
}

/**
 * The daemon's boot registration (board row f83db4b7): whatever `hoai run`
 * writes before a launch, written by the daemon itself on EVERY boot of a clone
 * workspace, however the session was started. Idempotent (a folder whose hooks
 * already hold is 'already' and is not touched), never throws, and leaves a
 * marketplace install alone (its hooks come from the plugin's hooks.json, and a
 * second entry would run each hook twice).
 *
 * It cannot reach the session that is running: the CLI read its hooks at
 * launch. So it serves the NEXT launch, and only a boot that found the private
 * turn hook missing hands its outcomes on to the one restart that brings it in
 * at once (lib/hook-restart.mjs). A boot that only refreshed a folder that
 * already had the hook asks for nothing: the 2026-10-12 restart loop was a
 * restart nobody needed, and a refreshed hook can wait for the next launch.
 * @param {{ folders: readonly string[], pluginDir: string, installMethod: string,
 *   privateHookRegistered: boolean, fs?: CloneFs, register?: typeof ensureHookEntries }} input
 * @returns {{ results: Array<{ folder: string, outcome: 'registered' | 'already' | 'not_clone' | 'failed', detail?: string, floor: boolean, checkout?: true }>,
 *   restartOutcomes: string[] }}
 *
 * A result carries `checkout: true` when its folder is this checkout itself
 * (the daemon's own working folder is one of the session's folders): it is not
 * an agent's folder, so cloneHooksSkippedLine leaves it out.
 */
export function registerCloneHooksAtBoot({ folders, pluginDir, installMethod, privateHookRegistered, fs, register }) {
  if (installMethod === 'marketplace') return { results: [], restartOutcomes: [] }
  const results = []
  for (const folder of new Set((Array.isArray(folders) ? folders : []).filter(Boolean))) {
    const result = { folder, ...registerCloneHooks({ workdir: folder, pluginDir, fs, register }) }
    results.push(isCheckoutItself(folder, pluginDir, fs) ? { ...result, checkout: true } : result)
  }
  return { results, restartOutcomes: privateHookRegistered ? [] : results.map((r) => r.outcome) }
}

/** Is this folder the checkout itself? Never throws: in doubt it is not. */
function isCheckoutItself(folder, pluginDir, fs = nodeCloneFs()) {
  try {
    return sameOnDisk(resolve(folder), resolve(pluginDir), fs)
  } catch {
    return false
  }
}

/**
 * A folder name or a detail made fit for the daemon's log: a line break, a terminal escape or any other control
 * character is shown as an escape (\n, \u001b) instead of starting a line of its own, and it is cut at `max`.
 * @param {unknown} text
 * @param {number} [max]
 */
function logLabel(text, max = 400) {
  const shown = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (c) =>
    c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
  return shown.length > max ? `${shown.slice(0, max - 3)}...` : shown
}

/**
 * The line a boot logs for one folder it registered, or whose write failed, or null when there is nothing to say
 * (already current, not this checkout's). The folder and the detail are escaped (logLabel): a folder's name is
 * the folder's to choose, and it must not write a log line of its own.
 * @param {{ folder: string, outcome: string, detail?: string, floor?: boolean } | null | undefined} result
 * @returns {string | null}
 */
export function cloneHooksResultLine(result) {
  if (!result) return null
  if (result.outcome === 'registered') return `hooks: registered the current agent hooks in ${logLabel(result.folder)}; they load at this agent's next launch`
  if (result.outcome === 'failed') return `hooks: could not register the agent hooks in ${logLabel(result.folder)}: ${logLabel(result.detail ?? 'unknown')}`
  return null
}

/**
 * The one line a clone's boot logs when it wrote no hooks because not one of
 * the session's folders starts this checkout from its .mcp.json, or null when
 * there is nothing to say (a folder was registered or was current, a write
 * failed and has its own line, or this is a marketplace install). That boot
 * used to log nothing at all, so a folder taken for another checkout's went
 * without hooks and nobody could see why. The checkout's own folder does not
 * count either way: the daemon runs in it, and a developer's checkout with a
 * .mcp.json of its own would otherwise speak for a skipped agent folder. What
 * to change is said in words, the same for every folder.
 * @param {ReadonlyArray<{ folder: string, outcome: string, detail?: string, checkout?: boolean, floor?: boolean }> | null | undefined} results
 * @returns {string | null}
 */
export function cloneHooksSkippedLine(results) {
  const list = (Array.isArray(results) ? results : []).filter((result) => result && result.checkout !== true)
  if (list.length === 0 || list.some((result) => result.outcome !== 'not_clone')) return null
  const folders = list.map((result) => `${logLabel(result.folder)}: ${logLabel(result.detail || 'not this checkout')}`).join('; ')
  return (
    `hooks: none written, because no folder of this session starts this checkout from its .mcp.json (${folders}). ` +
    "Make the agent folder's .mcp.json start this checkout's server.ts, then run hoai hooks there"
  )
}
