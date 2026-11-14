/**
 * lost-login: is an agent with no login file here a lost login, or an agent that lives elsewhere?
 * (board row 23415823)
 *
 * The check up and the owner's Restart (lib/watcher-core.mjs runCheckupJob, runOwnerRestartJob)
 * find their agent in lib/agent-inventory.mjs listAgents, which starts from the login files
 * (~/.bgos-agent/credentials-<id>.json) and the folders of loaded service jobs. An agent whose login
 * file was deleted or moved aside is therefore not listed, and both jobs used to refuse it as
 * `agent_not_on_this_machine:<id>`. Found 2026-11-13 by the Helper test on Windows (the file moved
 * aside for a paired agent: the row read offline, not seen, refused); the 13 Nov wipe on a Mac
 * deleted every agent's login file the same way. The Helper then never named the cause or the fix.
 *
 * This module answers with what the computer keeps about the agent besides the login file. Any one
 * of these is the agent's own, written on this computer by its install, its launches or its daemon:
 *
 *   - its records in ~/.bgos-agent/<id>/ (RECORD_FILES): the launch recipe hoai-core writes at every
 *     supervised launch, the launcher's supervisor.json, the pinned session id, the service record the
 *     daemon publishes, the keepalive marker, the supervisor generation of a v2 install, and the
 *     Windows task's run-agent.vbs;
 *   - its always on service file (macOS LaunchAgent, Linux systemd user unit), by this HOME's name or
 *     the old one;
 *   - a daemon of this agent running now: a fresh agent-state.json from a live pid, or the pairing
 *     lock beside the login file still stamped by a live pid (lib/agent-restart.mjs liveAgentDaemonPid).
 *
 * Deliberately NOT evidence, because each outlives the agent leaving this computer:
 *   - the watcher's own keep-alive record (keepalive-state.json): the removal cleanup
 *     (lib/agent-unbound.mjs) does not clear it, so it proves only that the agent was here once;
 *   - restart-requested.json and probe-requested.json: the watcher writes them itself;
 *   - ~/.bgos-agent/.removed/<id>-<date>: the archive a removal leaves on purpose;
 *   - an empty ~/.bgos-agent/<id> folder, and the plugin state folder alone.
 * A removal (an agent deleted in HOAI or handed to another owner) archives ~/.bgos-agent/<id> and
 * removes the service file BEFORE it removes the login file, so it leaves none of the evidence above.
 *
 * The records say the agent LIVED here; only the server knows where its pairing lives NOW (round 2,
 * the review's blocking finding). An agent re-paired onto another computer by the same owner leaves
 * its records here (lib/agent-unbound.mjs removes nothing when the server still returns the agent as
 * the owner's), and the server lists it on both computers. If its old login file here is gone too,
 * "Pair it again" would be wrong advice: pairing here pulls the agent back from the computer it now
 * lives on. So before a lost login is named, the watcher asks the server, live, with its own pairing:
 * GET integrations/watchers/keep-alive, whose `agentWindows` map is keyed by every agent the server
 * places on THIS computer (backend keep-alive.model.ts windowAgents): one whose current ACTIVE
 * pairing reports this machine id (isProvenOnMachine), or one this watcher named whose pairing names
 * no computer at all. Never one whose pairing places it elsewhere. Only an agent in that map is a lost
 * login (serverPlacesAgentHere). Everything else is ambiguous and keeps agent_not_on_this_machine:
 * not in the map, a failed or refused call, an answer that is not one, and an older server that
 * sends no map. The cached answer is never used: it can be older than the move.
 *
 * One exception keeps the old answer: an agent whose login never was a file. `bgos-claim` (the Agent
 * Pack) and `bgos-agent install --key` write the API key into the agent folder's .mcp.json and no
 * credentials-<id>.json at all (lib/agent-inventory.mjs discoverFolderAgents). When the folder its
 * launch recipe names declares this agent with a key (or a BGOS_CREDENTIALS_PATH to a file that
 * exists), nothing is lost, so it is not reported as a lost login; it stays as before.
 *
 * Reads only: never writes or restores a login file (plugin draft PR 370 is the daemon side that
 * rewrites its own lost file), never reads a login file's content, never throws.
 */

import {
  AGENT_TASK_LAUNCHER_FILE_NAME,
  KEEPALIVE_MARKER_FILE_NAME,
  LAUNCH_RECIPE_FILE_NAME,
  SESSION_ID_FILE_NAME,
  SUPERVISOR_FILE_NAME,
  SUPERVISOR_GENERATION_FILE_NAME,
  agentHomeId,
  agentStateDir,
  credentialsPath,
  joinDir,
  pluginStateDirFor,
  serviceFilePath,
  validAssistantId,
} from './agent-inventory.mjs'
import { liveAgentDaemonPid } from './agent-restart.mjs'
import { parseKeepAliveResponse } from './keepalive-plan.mjs'
import { MCP_CONFIG_FILE_NAME, SERVICE_RECORD_FILE_NAME, mcpEnvValues, parseMcpAssistantId } from './service-supervision.mjs'

/** The reason, a backend token (CHECKUP_TOKEN_REGEX): the check up's finding cause and the refusal's prefix. */
export const LOGIN_FILE_MISSING = 'login_file_missing'

/** The Helper card's words (board row 23415823), exactly: the finding's `fix`. */
export const LOGIN_FILE_MISSING_WORDS = "This agent's login file is missing on this computer. Pair it again to fix it."

/**
 * The one fix there is for a broken HOAI login: pair again from the agent's folder. It is the remedy
 * lib/auth-rejection.ts already offers for a refused login ("Re-pairing is the one remedy correct
 * under every one of those causes"), in the same words.
 */
export const PAIR_AGAIN_FIX = 'On this computer, in the agent\'s folder, run: hoai pair <code from the HOAI app> (or /hoai:pair in its Claude Code).'

/** The agent's own records in ~/.bgos-agent/<id>/, in the order they are reported. */
export const RECORD_FILES = Object.freeze([
  LAUNCH_RECIPE_FILE_NAME,
  SUPERVISOR_FILE_NAME,
  SESSION_ID_FILE_NAME,
  SERVICE_RECORD_FILE_NAME,
  KEEPALIVE_MARKER_FILE_NAME,
  SUPERVISOR_GENERATION_FILE_NAME,
  AGENT_TASK_LAUNCHER_FILE_NAME,
])

function safely(fn, fallback) {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/**
 * What this computer keeps about one agent besides its login file, as short tokens with no path in
 * them (a record's file name, `service_file`, `running_daemon`). Empty: nothing here says the agent
 * lives on this computer.
 * @param {{ home: string, env?: Record<string, string | undefined>, platform: string,
 *   fs: { exists?: (path: string) => boolean, readFile: (path: string) => string | null },
 *   assistantId: string | number, now: number, pidAlive: (pid: number) => boolean }} params
 * @returns {string[]}
 */
export function localAgentEvidence({ home, env = {}, platform, fs, assistantId, now, pidAlive }) {
  const id = validAssistantId(assistantId)
  if (!id || !String(home ?? '').trim()) return []
  const exists = (path) => Boolean(path) && safely(() => (typeof fs.exists === 'function' ? fs.exists(path) : fs.readFile(path) != null), false)
  const out = []

  const stateDir = agentStateDir(home, id)
  for (const name of RECORD_FILES) {
    if (exists(joinDir(stateDir, name))) out.push(name)
  }

  if (platform === 'darwin' || platform === 'linux') {
    const homeId = safely(() => agentHomeId(home, platform), '')
    const files = [...new Set([serviceFilePath(platform, home, id, homeId), serviceFilePath(platform, home, id, '')])]
    if (files.some((path) => exists(path))) out.push('service_file')
  }

  const daemonPid = safely(
    () =>
      liveAgentDaemonPid(
        { assistantId: id, pluginStateDir: pluginStateDirFor({ env, home, assistantId: id }), credentialsPath: credentialsPath(home, id) },
        { fs: { readFile: (path) => safely(() => fs.readFile(path), null) }, now, pidAlive },
      ),
    null,
  )
  if (daemonPid != null) out.push('running_daemon')
  return out
}

/** The finding's detail: what was found, by name only (no path reaches the server). */
export function lostLoginDetail(evidence) {
  return `No login file for this agent here, but this computer keeps its own records (${evidence.join(', ')}): the login file was deleted or moved.`
}

/**
 * Does the agent's own folder hold its login (bgos-claim, `bgos-agent install --key`)? The folder is
 * the cwd of its launch recipe; it must declare this agent in .mcp.json, with a non empty
 * BGOS_API_KEY or a BGOS_CREDENTIALS_PATH to a file that exists. Never returns a value it read.
 * @param {{ home: string, fs: { exists?: (path: string) => boolean, readFile: (path: string) => string | null }, assistantId: string | number }} params
 */
export function folderHoldsLogin({ home, fs, assistantId }) {
  const id = validAssistantId(assistantId)
  if (!id) return false
  return safely(() => {
    const recipe = JSON.parse(String(fs.readFile(joinDir(agentStateDir(home, id), LAUNCH_RECIPE_FILE_NAME)) ?? 'null'))
    const cwd = typeof recipe?.cwd === 'string' ? recipe.cwd.trim() : ''
    if (!cwd) return false
    const raw = fs.readFile(joinDir(cwd, MCP_CONFIG_FILE_NAME))
    if (parseMcpAssistantId(raw) !== id) return false
    if (mcpEnvValues(raw, 'BGOS_API_KEY').some((value) => value !== '')) return true
    const exists = (path) => (typeof fs.exists === 'function' ? fs.exists(path) : fs.readFile(path) != null)
    return mcpEnvValues(raw, 'BGOS_CREDENTIALS_PATH').some((path) => path !== '' && exists(path))
  }, false)
}

/**
 * An agent the inventory did not list: its login file lost here, or not here at all.
 * @param {Parameters<typeof localAgentEvidence>[0]} params
 * @returns {{ lost: true, evidence: string[] } | { lost: false, evidence: string[] }}
 */
export function unlistedAgent(params) {
  const evidence = localAgentEvidence(params)
  if (evidence.length === 0 || folderHoldsLogin(params)) return { lost: false, evidence }
  return { lost: true, evidence }
}

/**
 * Does the server place this agent's pairing on THIS computer? Asked live through `ask`, the
 * watcher's own GET integrations/watchers/keep-alive. `here` is true only when the answer parses and
 * its `agentWindows` map names the agent; `why` says what was seen, for the log only.
 * @param {{ ask: () => Promise<{ ok?: boolean, status?: number, json?: unknown } | null | undefined>, assistantId: string | number }} params
 * @returns {Promise<{ here: boolean, why: 'placed_here' | 'placed_elsewhere' | 'no_map' | 'not_an_answer' | 'unreachable' | string }>}
 */
export async function serverPlacesAgentHere({ ask, assistantId }) {
  const id = validAssistantId(assistantId)
  if (!id) return { here: false, why: 'not_an_answer' }
  let res
  try {
    res = await ask()
  } catch {
    return { here: false, why: 'unreachable' }
  }
  if (!res?.ok) return { here: false, why: Number.isInteger(res?.status) && res.status > 0 ? `status_${res.status}` : 'unreachable' }
  const answer = parseKeepAliveResponse(res.json)
  if (!answer) return { here: false, why: 'not_an_answer' }
  if (!answer.agentWindows) return { here: false, why: 'no_map' }
  return Object.prototype.hasOwnProperty.call(answer.agentWindows, id) ? { here: true, why: 'placed_here' } : { here: false, why: 'placed_elsewhere' }
}

/**
 * The whole answer for an agent the inventory did not list: a lost login only when this computer keeps
 * the agent's own records, its login is not in its folder, AND the server places its pairing here.
 * The server is asked only when the records alone would name a lost login.
 * @param {Parameters<typeof localAgentEvidence>[0] & { ask: Parameters<typeof serverPlacesAgentHere>[0]['ask'] }} params
 * @returns {Promise<{ lost: boolean, evidence: string[], server: string | null }>}
 */
export async function lostLoginHere(params) {
  const local = unlistedAgent(params)
  if (!local.lost) return { lost: false, evidence: local.evidence, server: null }
  const placed = await serverPlacesAgentHere({ ask: params.ask, assistantId: params.assistantId })
  return { lost: placed.here, evidence: local.evidence, server: placed.why }
}
