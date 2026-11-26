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
 * Plain JavaScript, node >= 18 builtins only, import-safe; file access is
 * injectable so tests run on a temp dir.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { ensureHookEntries } from './claude-preseed.mjs'

/**
 * @typedef {{ readFile: (p: string) => string | null, realpath: (p: string) => string | null,
 *   identity?: (p: string) => string | null }} CloneFs
 */

/** @returns {CloneFs} */
function nodeCloneFs() {
  return {
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
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
    identity: (p) => {
      try {
        const stat = statSync(p, { bigint: true })
        return stat.ino > 0n ? `${stat.dev}:${stat.ino}` : null
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
 * The checkout a workspace's .mcp.json starts for its server, as written there:
 * the folder of the server.ts it runs (the bootstraps' and `hoai`'s form), or
 * the --plugin-dir handed to the stable wrapper (bin/bgos-claim.mjs
 * buildMcpJson, bin/bgos-agent write_mcp_json), whose args name no server.ts.
 * '' when it names neither. Relative paths stay relative: the caller resolves
 * them against the workspace.
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
  if (!Array.isArray(args)) return ''
  const server = args.find((a) => typeof a === 'string' && a.endsWith('server.ts'))
  if (server) return dirname(server)
  const flag = args.indexOf('--plugin-dir')
  const dir = flag >= 0 && typeof args[flag + 1] === 'string' ? args[flag + 1].trim() : ''
  return dir
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
 * checkout. Never throws.
 * @param {{ workdir: string, pluginDir: string, fs?: CloneFs,
 *   register?: typeof ensureHookEntries }} input
 * @returns {{ outcome: 'registered' | 'already' | 'not_clone' | 'failed', detail?: string, floor: boolean }}
 */
export function registerCloneHooks({ workdir, pluginDir, fs = nodeCloneFs(), register = ensureHookEntries }) {
  try {
    const verdict = cloneVerdict({ workdir, pluginDir, fs })
    if (!verdict.ours) return { outcome: 'not_clone', detail: verdict.why, floor: false }
    const settingsPath = join(workdir, '.claude', 'settings.local.json')
    const existing = fs.readFile(settingsPath)
    // A folder that already carries the rail keeps its full set, floor hook included.
    const hadRail = existing != null && existing.includes('hoai-hook.mjs')
    const result = register({
      settingsPath,
      forwarderPath: forwarderSpelling({ existing, ours: join(resolve(pluginDir), 'bin', 'hoai-hook.mjs'), fs }),
      ...(hadRail ? {} : { floorHookPath: null }),
    })
    if (result.reason === 'not_persisted') return { outcome: 'failed', detail: 'the settings write did not persist', floor: hadRail }
    return { outcome: result.changed ? 'registered' : 'already', floor: hadRail }
  } catch (error) {
    return { outcome: 'failed', detail: String(error?.message ?? error), floor: false }
  }
}

/**
 * The forwarder path to write: ours, unless the settings already name a
 * forwarder that IS ours under another spelling (an aliased home, the path the
 * launcher took to this checkout, on Windows another case of the same names).
 * ensureHookEntries compares paths as strings,
 * so without this a boot after every `hoai run` would rewrite the whole block
 * to its own spelling, and the next `hoai run` rewrite it back.
 * @param {{ existing: string | null, ours: string, fs: CloneFs }} input
 * @returns {string}
 */
function forwarderSpelling({ existing, ours, fs }) {
  if (existing == null) return ours
  let parsed
  try {
    parsed = JSON.parse(existing.charCodeAt(0) === 0xfeff ? existing.slice(1) : existing)
  } catch {
    return ours
  }
  const hooks = parsed?.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return ours
  if (typeof fs.realpath(ours) !== 'string') return ours
  /** @type {Set<string>} */
  const asked = new Set()
  for (const matchers of Object.values(hooks)) {
    for (const matcher of Array.isArray(matchers) ? matchers : []) {
      for (const hook of Array.isArray(matcher?.hooks) ? matcher.hooks : []) {
        const arg = Array.isArray(hook?.args) && hook.args.length === 1 ? hook.args[0] : null
        if (typeof arg !== 'string' || arg === ours || asked.has(arg) || !/[\\/]hoai-hook\.mjs$/.test(arg)) continue
        asked.add(arg)
        if (sameOnDisk(arg, ours, fs)) return arg
      }
    }
  }
  return ours
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
 * The one line a clone's boot logs when it wrote no hooks because not one of
 * the session's folders starts this checkout from its .mcp.json, or null when
 * there is nothing to say (a folder was registered or was current, a write
 * failed and has its own line, or this is a marketplace install). That boot
 * used to log nothing at all, so a folder taken for another checkout's went
 * without hooks and nobody could see why. The checkout's own folder does not
 * count either way: the daemon runs in it, and a developer's checkout with a
 * .mcp.json of its own would otherwise speak for a skipped agent folder.
 * @param {ReadonlyArray<{ folder: string, outcome: string, detail?: string, checkout?: boolean }> | null | undefined} results
 * @returns {string | null}
 */
export function cloneHooksSkippedLine(results) {
  const list = (Array.isArray(results) ? results : []).filter((result) => result && result.checkout !== true)
  if (list.length === 0 || list.some((result) => result.outcome !== 'not_clone')) return null
  const folders = list.map((result) => `${result.folder}: ${result.detail || 'not this checkout'}`).join('; ')
  return (
    `hooks: none written, because no folder of this session starts this checkout from its .mcp.json (${folders}). ` +
    "To write them now, run hoai hooks in the agent's folder"
  )
}
