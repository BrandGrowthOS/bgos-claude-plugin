/**
 * agent-inventory: which HOAI agents live on this machine, and how each one
 * can be restarted (the per-machine watcher plans against this; bin/hoai-core
 * writes the launch recipe it reads).
 *
 * Two state dirs, never mixed up (design 7.1):
 *   ~/.bgos-agent/                    credentials-<id>.json (SECRET, never read
 *                                     here beyond its NAME), machine-id, watcher/
 *   ~/.bgos-agent/<id>/               supervisor.json, restart-requested.json,
 *                                     session-id, launch.json (the recipe),
 *                                     probe-requested.json
 *   ~/.bgos-plugin-state/<id>/        channel-live.json (the liveness proof),
 *                                     chat-cursors.json (override root via
 *                                     BGOS_PLUGIN_STATE_DIR; key = the id when
 *                                     it matches ^[A-Za-z0-9_-]{1,64}$, else a
 *                                     cwd hash; mirror of lib/cursor-store.ts)
 *
 * Restart authorities (mirror of lib/update-readiness.ts detectSupervision,
 * restated here in plain JS because the watcher runs under bare node from a
 * bundle copied out of the plugin and must not import TS):
 *   'service'        an installed launchd plist / systemd --user unit
 *   'launcher-live'  a supervisor.json whose pid is ALIVE and declares the
 *                    relaunch capability (bin/hoai-core.mjs supervise loop)
 *   'none'           nothing; a recipe (launch.json) may still relaunch it
 *
 * The launch recipe is what hoai-core knew at launch time: cwd, the channel
 * flags, install method, plugin root, node path. It NEVER carries a session
 * id (identity is resumed from the agent's own session-id pin by hoai-core
 * itself), never a token. On read every recipe is validated against the disk:
 * the cwd must exist and its folder pin must name this agent, otherwise the
 * recipe is dropped with a named note rather than trusted, because launching
 * hoai in a folder pinned to another agent would start the wrong identity.
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe, every probe
 * injectable so the whole inventory is testable in a fake HOME.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Mirror of bin/hoai-core.mjs / lib/update-readiness.ts file names. */
export const SUPERVISOR_FILE_NAME = 'supervisor.json'
export const RESTART_MARKER_FILE_NAME = 'restart-requested.json'
export const SESSION_ID_FILE_NAME = 'session-id'
/** The launch recipe hoai-core writes at every supervised launch. */
export const LAUNCH_RECIPE_FILE_NAME = 'launch.json'
export const LAUNCH_RECIPE_SCHEMA_VERSION = 1
/** The watcher's liveness-probe request (existence only, design 7.2). */
export const PROBE_MARKER_FILE_NAME = 'probe-requested.json'
/** Mirror of lib/boot-hello.ts LIVE_MARKER_FILE. */
export const LIVE_MARKER_FILE_NAME = 'channel-live.json'
/** Mirror of lib/cursor-store.ts default state root name. */
export const PLUGIN_STATE_DIR_NAME = '.bgos-plugin-state'
/** Mirror of bin/bgos-pair.mjs FOLDER_PIN_FILE_NAME. */
export const FOLDER_PIN_FILE_NAME = '.bgos-agent-id'

/**
 * @typedef {{
 *   schemaVersion: number,
 *   assistantId: string,
 *   cwd: string,
 *   argv: string[],
 *   installMethod: string | null,
 *   pluginRoot: string | null,
 *   node: string | null,
 *   claudeConfigDir: string | null,
 *   startedAt: string | null,
 *   launcher: 'hoai',
 *   pid: number | null,
 * }} LaunchRecipe
 */

/**
 * @typedef {{
 *   assistantId: string,
 *   cwd: string | null,
 *   recipe: LaunchRecipe | null,
 *   supervisor: 'launcher-live' | 'service' | 'none',
 *   running: boolean,
 *   serviceFile: string | null,
 *   sessionId: string | null,
 *   stateDir: string,
 *   pluginStateDir: string,
 *   liveMarkerPath: string,
 *   credentialsPath: string,
 *   notes: string[],
 * }} AgentRow
 */

/**
 * @typedef {{
 *   exists: (path: string) => boolean,
 *   readFile: (path: string) => string | null,
 *   listDir: (path: string) => string[],
 * }} InventoryFs
 */

// -- Default probes (node fs) --------------------------------------------------

function defaultExists(path) {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

function defaultReadText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function defaultListDir(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function defaultWriteText(path, content) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    return true
  } catch {
    return false
  }
}

/** Is this pid alive on THIS host? Mirror of hoai-core defaultPidAlive. */
export function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/** The node-backed read-only probe set. */
export function defaultInventoryFs() {
  return { exists: defaultExists, readFile: defaultReadText, listDir: defaultListDir }
}

// -- Path builders (separator preserving, mirror of hoai-core joinDir) --------

/** Join dir + name preserving the dir's separator style. */
export function joinDir(dir, name) {
  const base = String(dir ?? '').replace(/[\\/]+$/, '')
  if (!base) return String(name ?? '')
  const sep = base.includes('\\') || /^[A-Za-z]:$/.test(base) ? '\\' : '/'
  return `${base}${sep}${name}`
}

/** Assistant ids are digits-only everywhere; anything else builds no path. */
export function validAssistantId(id) {
  const value = String(id ?? '').trim()
  return /^\d+$/.test(value) ? value : null
}

export function agentDir(home) {
  return joinDir(home, '.bgos-agent')
}

export function agentStateDir(home, assistantId) {
  const id = validAssistantId(assistantId)
  return id ? joinDir(agentDir(home), id) : null
}

export function credentialsPath(home, assistantId) {
  const id = validAssistantId(assistantId)
  return id ? joinDir(agentDir(home), `credentials-${id}.json`) : null
}

function stateFile(home, assistantId, name) {
  const dir = agentStateDir(home, assistantId)
  return dir ? joinDir(dir, name) : null
}

export function launchRecipePath(home, assistantId) {
  return stateFile(home, assistantId, LAUNCH_RECIPE_FILE_NAME)
}

export function supervisorPath(home, assistantId) {
  return stateFile(home, assistantId, SUPERVISOR_FILE_NAME)
}

export function restartMarkerPath(home, assistantId) {
  return stateFile(home, assistantId, RESTART_MARKER_FILE_NAME)
}

export function probeMarkerPath(home, assistantId) {
  return stateFile(home, assistantId, PROBE_MARKER_FILE_NAME)
}

export function sessionIdPath(home, assistantId) {
  return stateFile(home, assistantId, SESSION_ID_FILE_NAME)
}

/** launchd label, mirror of bin/bgos-agent label_for. */
export function serviceLabel(assistantId) {
  return `ai.bgos.agent.${assistantId}`
}

/** systemd --user unit name, mirror of bin/bgos-agent unit_for. */
export function serviceUnit(assistantId) {
  return `bgos-agent-${assistantId}`
}

/** The per-agent always-on service file, or null (win32 has none). */
export function serviceFilePath(platform, home, assistantId) {
  const id = validAssistantId(assistantId)
  if (!id) return null
  if (platform === 'darwin') {
    return joinDir(joinDir(joinDir(home, 'Library'), 'LaunchAgents'), `${serviceLabel(id)}.plist`)
  }
  if (platform === 'linux') {
    return joinDir(
      joinDir(joinDir(joinDir(home, '.config'), 'systemd'), 'user'),
      `${serviceUnit(id)}.service`,
    )
  }
  return null
}

/** The plugin-state root: BGOS_PLUGIN_STATE_DIR (trimmed) else ~/.bgos-plugin-state. */
export function pluginStateRoot({ env = {}, home } = {}) {
  const override = String(env?.BGOS_PLUGIN_STATE_DIR ?? '').trim()
  return override || joinDir(home, PLUGIN_STATE_DIR_NAME)
}

/**
 * Mirror of bin/bgos-doctor.mjs liveMarkerPathFor / lib/cursor-store.ts key rule.
 * @param {{ env?: Record<string, string | undefined>, home?: string, assistantId?: string, cwd?: string }} [opts]
 */
export function pluginStateDirFor({ env = {}, home, assistantId = '', cwd = '' } = {}) {
  const raw = String(assistantId ?? '').trim()
  const key = /^[A-Za-z0-9_-]{1,64}$/.test(raw)
    ? raw
    : `cwd-${createHash('sha256').update(String(cwd ?? '')).digest('hex').slice(0, 16)}`
  return joinDir(pluginStateRoot({ env, home }), key)
}

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string, assistantId?: string, cwd?: string }} [opts]
 */
export function liveMarkerPathFor({ env = {}, home, assistantId = '', cwd = '' } = {}) {
  return joinDir(pluginStateDirFor({ env, home, assistantId, cwd }), LIVE_MARKER_FILE_NAME)
}

// -- Small readers ----------------------------------------------------------------

/** Ids with a credentials-<id>.json under ~/.bgos-agent, ascending numerically. */
export function listPairedAssistantIds(home, listDir = defaultListDir) {
  return listDir(agentDir(home))
    .map((name) => /^credentials-(\d+)\.json$/.exec(name)?.[1])
    .filter((found) => Boolean(found))
    .sort((a, b) => Number(a) - Number(b))
}

/** The numeric id in <cwd>/.bgos-agent-id, or '' when absent or junk. */
export function readFolderPin(cwd, readFile = defaultReadText) {
  const dir = String(cwd ?? '').trim()
  if (!dir) return ''
  const raw = readFile(joinDir(dir, FOLDER_PIN_FILE_NAME))
  if (raw == null) return ''
  const id = String(raw).trim()
  return /^\d+$/.test(id) ? id : ''
}

/** Fail-closed supervisor.json parse (mirror of lib/update-readiness.ts). */
export function parseSupervisorFile(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const pid = parsed.pid
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  const capabilities = Array.isArray(parsed.capabilities)
    ? parsed.capabilities.filter((c) => typeof c === 'string')
    : []
  return { pid, capabilities }
}

function isSessionIdLike(value) {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    String(value ?? '').trim(),
  )
}

// -- Launch recipe -----------------------------------------------------------------

/** Session-identity args never belong in a recipe: hoai-core resumes the
 *  agent's own pinned session itself. */
const SESSION_FLAGS_WITH_VALUE = new Set(['--resume', '--session-id'])
const SESSION_FLAGS_BARE = new Set(['--continue'])

/** Strip every session-identity arg (and its value) from an argv. */
export function stripSessionArgs(argv) {
  const out = []
  const list = Array.isArray(argv) ? argv : []
  for (let i = 0; i < list.length; i++) {
    const arg = String(list[i] ?? '')
    if (SESSION_FLAGS_BARE.has(arg)) continue
    if (SESSION_FLAGS_WITH_VALUE.has(arg)) {
      i += 1
      continue
    }
    out.push(arg)
  }
  return out
}

function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Build a recipe from what the launcher knows. Pure. The argv is stripped of
 * session args so a recipe can never carry (or leak) a session id.
 * @param {{ assistantId: string | number, cwd: string, argv?: readonly string[],
 *   installMethod?: string | null, pluginRoot?: string | null, node?: string | null,
 *   startedAt?: string | null, pid?: number | null }} input
 * @returns {LaunchRecipe}
 */
export function buildLaunchRecipe(input) {
  const pid = input?.pid
  return {
    schemaVersion: LAUNCH_RECIPE_SCHEMA_VERSION,
    assistantId: String(input?.assistantId ?? '').trim(),
    cwd: String(input?.cwd ?? ''),
    argv: stripSessionArgs(input?.argv),
    installMethod: optionalString(input?.installMethod),
    pluginRoot: optionalString(input?.pluginRoot),
    node: optionalString(input?.node),
    // The Claude config dir the agent runs under (CLAUDE_CONFIG_DIR at launch),
    // so a watcher reconciles the SAME install and relaunches into it.
    claudeConfigDir: optionalString(input?.claudeConfigDir),
    startedAt: optionalString(input?.startedAt),
    launcher: 'hoai',
    pid: typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null,
  }
}

/**
 * Parse a recipe file body. Strict on the load-bearing fields (schema, a
 * digits-only id, a non-empty cwd, a string argv, launcher 'hoai'), tolerant
 * on the informational ones (absent -> null). Null for anything else.
 * @param {string | null | undefined} raw
 * @returns {LaunchRecipe | null}
 */
export function parseLaunchRecipe(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (parsed.schemaVersion !== LAUNCH_RECIPE_SCHEMA_VERSION) return null
  const assistantId = validAssistantId(parsed.assistantId)
  if (!assistantId) return null
  if (typeof parsed.cwd !== 'string' || parsed.cwd.length === 0) return null
  if (!Array.isArray(parsed.argv) || !parsed.argv.every((a) => typeof a === 'string')) return null
  if (parsed.launcher !== 'hoai') return null
  const pid = parsed.pid
  return {
    schemaVersion: LAUNCH_RECIPE_SCHEMA_VERSION,
    assistantId,
    cwd: parsed.cwd,
    argv: stripSessionArgs(parsed.argv),
    installMethod: optionalString(parsed.installMethod),
    pluginRoot: optionalString(parsed.pluginRoot),
    node: optionalString(parsed.node),
    claudeConfigDir: optionalString(parsed.claudeConfigDir),
    startedAt: optionalString(parsed.startedAt),
    launcher: 'hoai',
    pid: typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null,
  }
}

/**
 * Persist a recipe at ~/.bgos-agent/<id>/launch.json (pretty JSON, LF).
 * Returns false (never throws) on a bad id or a failed write.
 * @param {{ home: string, assistantId: string | number, recipe: LaunchRecipe,
 *   writeFile?: (path: string, content: string) => boolean }} params
 */
export function writeLaunchRecipe({ home, assistantId, recipe, writeFile = defaultWriteText }) {
  const path = launchRecipePath(home, assistantId)
  if (!path || !recipe) return false
  try {
    return Boolean(writeFile(path, `${JSON.stringify(recipe, null, 2)}\n`))
  } catch {
    return false
  }
}

/**
 * Read + parse the recipe for an agent; null when absent, junk, or bad id.
 * @param {{ home: string, assistantId: string | number, readFile?: (path: string) => string | null }} params
 */
export function readLaunchRecipe({ home, assistantId, readFile = defaultReadText }) {
  const path = launchRecipePath(home, assistantId)
  if (!path) return null
  return parseLaunchRecipe(readFile(path))
}

// -- Supervisor detection --------------------------------------------------------

/**
 * What would restart this agent right now, strongest evidence first (mirror
 * of lib/update-readiness.ts detectSupervision, in the watcher's vocabulary).
 * @param {{ platform: string, home: string, assistantId: string | number,
 *   exists: (path: string) => boolean, readFile: (path: string) => string | null,
 *   pidAlive?: (pid: number) => boolean }} probe
 * @returns {'service' | 'launcher-live' | 'none'}
 */
export function detectSupervisor({ platform, home, assistantId, exists, readFile, pidAlive = defaultPidAlive }) {
  const service = serviceFilePath(platform, home, assistantId)
  if (service && exists(service)) return 'service'
  const path = supervisorPath(home, assistantId)
  if (path) {
    const supervisor = parseSupervisorFile(readFile(path))
    if (supervisor && supervisor.capabilities.includes('relaunch') && pidAlive(supervisor.pid)) {
      return 'launcher-live'
    }
  }
  return 'none'
}

// -- The inventory -----------------------------------------------------------------

/**
 * Validate a parsed recipe against the disk. Returns the recipe to keep (or
 * null) and the notes explaining a drop. Rules:
 *   - assistantId must equal the state dir's id;
 *   - cwd must exist;
 *   - the cwd's folder pin must name this id; an unpinned cwd is accepted
 *     only on a single-agent host (hoai resolves the sole paired agent), a
 *     pin naming another agent is always a drop (wrong identity).
 * @param {{ recipe: LaunchRecipe | null, raw: string | null, assistantId: string,
 *   pairedCount: number, exists: (p: string) => boolean, readFile: (p: string) => string | null }} params
 */
export function validateRecipeOnDisk({ recipe, raw, assistantId, pairedCount, exists, readFile }) {
  const notes = []
  if (!recipe) {
    if (raw != null) notes.push('recipe_unreadable')
    return { recipe: null, notes }
  }
  if (recipe.assistantId !== assistantId) {
    notes.push(`recipe_assistant_mismatch:${recipe.assistantId}`)
    return { recipe: null, notes }
  }
  if (!exists(recipe.cwd)) {
    notes.push(`recipe_cwd_missing:${recipe.cwd}`)
    return { recipe: null, notes }
  }
  const pin = readFolderPin(recipe.cwd, readFile)
  if (pin && pin !== assistantId) {
    notes.push(`recipe_cwd_pinned_to_other_agent:${pin}`)
    return { recipe: null, notes }
  }
  if (!pin && pairedCount > 1) {
    notes.push('recipe_cwd_unpinned_on_multi_agent_host')
    return { recipe: null, notes }
  }
  return { recipe, notes }
}

/**
 * Every paired agent on this machine (ids from credentials-<id>.json), with
 * its restart authority, its validated recipe, and every path the watcher
 * needs. Ascending id order (stable, the planner relies on it). Never reads
 * a credentials file's CONTENT; never throws.
 * @param {{ home: string, env?: Record<string, string | undefined>, platform?: string,
 *   fs?: InventoryFs, pidAlive?: (pid: number) => boolean }} params
 * @returns {AgentRow[]}
 */
export function listAgents({ home, env = {}, platform = process.platform, fs = defaultInventoryFs(), pidAlive = defaultPidAlive }) {
  const exists = fs.exists ?? defaultExists
  const readFile = fs.readFile ?? defaultReadText
  const listDir = fs.listDir ?? defaultListDir
  const ids = listPairedAssistantIds(home, listDir)
  return ids.map((assistantId) => {
    const stateDir = agentStateDir(home, assistantId)
    const raw = readFile(launchRecipePath(home, assistantId))
    const validated = validateRecipeOnDisk({
      recipe: parseLaunchRecipe(raw),
      raw,
      assistantId,
      pairedCount: ids.length,
      exists,
      readFile,
    })
    const supervisor = detectSupervisor({ platform, home, assistantId, exists, readFile, pidAlive })
    const service = serviceFilePath(platform, home, assistantId)
    const sessionRaw = String(readFile(sessionIdPath(home, assistantId)) ?? '').trim()
    const cwd = validated.recipe ? validated.recipe.cwd : null
    return {
      assistantId,
      cwd,
      recipe: validated.recipe,
      supervisor,
      running: supervisor !== 'none',
      serviceFile: service && exists(service) ? service : null,
      sessionId: isSessionIdLike(sessionRaw) ? sessionRaw : null,
      stateDir,
      pluginStateDir: pluginStateDirFor({ env, home, assistantId, cwd: cwd ?? '' }),
      liveMarkerPath: liveMarkerPathFor({ env, home, assistantId, cwd: cwd ?? '' }),
      credentialsPath: credentialsPath(home, assistantId),
      notes: validated.notes,
    }
  })
}
