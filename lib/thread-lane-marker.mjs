/**
 * The mark an owner's full access thread carries in its environment
 * (lib/thread-lane-args.ts threadFullArgs, 0.88.0).
 *
 * A full access thread is a true fork of the agent's main session: it runs in
 * the agent's own folder with the owner's own settings, hooks, plugins and
 * MCP servers. That would also start a SECOND COPY OF THIS PLUGIN inside the
 * thread: its channel server (which would hold the chat tools and could post
 * in the main chat as the agent) and its browser server. A confined lane
 * keeps them out with `--strict-mcp-config` and an empty config; a full
 * access thread cannot, because that flag drops every MCP server the owner
 * has, and the thread is meant to have them.
 *
 * So the daemon starts the thread's CLI with HOAI_THREAD_LANE set to the
 * path of that thread's own lane state file, which names the CLI's process id
 * (written the moment it is spawned) and, from its first frame on, its
 * session id. This plugin then keeps itself out, and only itself:
 *
 *  - bin/bgos-launch.mjs, bin/hoai-browser-launch.mjs and
 *    bin/bgos-daemon-wrapper.mjs exit 0 at once when THEIR PARENT IS THAT CLI
 *    (startedByThreadLane), and server.ts does the same as its first
 *    statement, one level further up (an installed wrapper from before
 *    0.88.0 still starts it). The CLI lists the two servers as failed and
 *    goes on with every other one (measured on CLI 2.1.322: the variable
 *    reaches an MCP server the CLI starts, and a server that exits at start
 *    does not stop the session).
 *  - the plugin's own blocking Stop hooks do nothing for THAT SESSION
 *    (threadLaneSkipsHook): they end the main session's private turn and
 *    hold its mission goals, and a thread is neither. Confined lanes have
 *    never run them (threadLaneHooks leaves Stop out); every other hook of
 *    the plugin runs in a thread as before, "Always ask" included.
 *
 * The mark is inherited by everything the thread starts, so it is never
 * believed on its own: an agent the thread launches from its Bash (another
 * Claude Code session with this plugin) has a different parent and a
 * different session id, and its plugin starts and its hooks run as normal.
 * A mark whose file is gone or unreadable names no thread.
 *
 * Plain JavaScript, node builtins only: the launchers and the hooks load it
 * before anything else. No em or en dashes in this file.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export const THREAD_LANE_ENV = 'HOAI_THREAD_LANE'

/**
 * The mark's value (a lane state file's path), or null when there is none.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function threadLaneMark(env = process.env) {
  const value = env?.[THREAD_LANE_ENV]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * What the marked thread's lane state says: its CLI's process id and its
 * session id (each null until known). Null when there is no mark, or its
 * file is gone, unreadable or not a lane state.
 */
/**
 * @param {Record<string, string | undefined>} [env]
 * @param {(path: string) => string} [readFile]
 * @returns {{ pid: number | null, forkSessionId: string | null } | null}
 */
export function threadLaneState(env = process.env, readFile = (path) => readFileSync(path, 'utf8')) {
  const path = threadLaneMark(env)
  if (path === null) return null
  try {
    const state = JSON.parse(readFile(path))
    if (!state || typeof state !== 'object' || Array.isArray(state)) return null
    return {
      pid: Number.isInteger(state.pid) && state.pid > 0 ? state.pid : null,
      forkSessionId: typeof state.forkSessionId === 'string' && state.forkSessionId !== '' ? state.forkSessionId : null,
    }
  } catch {
    return null
  }
}

/**
 * A process's parent, or null (Windows, a process that is gone, a ps that failed).
 *
 * @param {number} pid
 * @param {string} [platform]
 * @returns {number | null}
 */
export function parentPid(pid, platform = process.platform) {
  if (platform === 'win32' || !Number.isInteger(pid) || pid <= 1) return null
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] })
    const parent = Number(String(out).trim())
    return Number.isInteger(parent) && parent > 0 ? parent : null
  } catch {
    return null
  }
}

/**
 * True when this process was started by the marked thread's own CLI: its
 * parent is the process the lane state names. `parentOf` (server.ts only)
 * also accepts that CLI as the grandparent, for a server a wrapper started.
 *
 * @param {{ env?: Record<string, string | undefined>, ppid?: number, readFile?: (path: string) => string, parentOf?: (pid: number) => number | null }} [input]
 */
export function startedByThreadLane({ env = process.env, ppid = process.ppid, readFile, parentOf } = {}) {
  const state = threadLaneState(env, readFile)
  if (state === null || state.pid === null) return false
  if (state.pid === ppid) return true
  return typeof parentOf === 'function' && parentOf(ppid) === state.pid
}

/** The plugin's hook events that do nothing inside a thread. */
export const THREAD_LANE_SKIPPED_HOOK_EVENTS = Object.freeze(['Stop'])

/**
 * True when this hook call must do nothing: a Stop hook of the plugin, for
 * the very session the mark's lane state names.
 *
 * @param {{ env?: Record<string, string | undefined>, event?: unknown, sessionId?: unknown, readFile?: (path: string) => string }} [input]
 */
export function threadLaneSkipsHook({ env = process.env, event, sessionId, readFile } = {}) {
  if (!THREAD_LANE_SKIPPED_HOOK_EVENTS.includes(event)) return false
  if (typeof sessionId !== 'string' || sessionId === '') return false
  const state = threadLaneState(env, readFile)
  return state !== null && state.forkSessionId !== null && state.forkSessionId.toLowerCase() === sessionId.toLowerCase()
}
