/**
 * model-control-store: the owner's opt in to remote model and effort control,
 * and the status line bridge that is its confirmation source (Route A, KC
 * 2026-10-23: "A separate owner opt-in for remote model and effort control
 * (the compact permission does not count)").
 *
 * THE OPT IN is per agent and lives on the agent's own machine, written only
 * by the owner's own command (bin/hoai-model-control.mjs on --assistant <id>).
 * Nothing on the wire can turn it on. The daemon reads it per request, so an
 * `off` takes effect on the next request.
 *
 * THE CONFIRMATION SOURCE is Claude Code's own status line JSON. The CLI runs
 * the configured status line command with its session facts on stdin
 * (session_id, model.id, effort.level, version), and effort.level "reflects
 * the live session value, including mid-session /effort changes"
 * (code.claude.com/docs/en/statusline). The bridge (bin/hoai-statusline-bridge.mjs)
 * stores only those facts, numbered by a sequence that grows with every
 * write, then runs the owner's own status line command, if there was one,
 * with the same stdin and prints its output, so the owner's line is kept.
 * Installing it is part of the opt in, never a silent overwrite, and `off`
 * puts the owner's line back.
 *
 * The CLI re-runs a status line on events, and a /model or /effort change is
 * not listed among them, so the bridge is installed with a refreshInterval of
 * BRIDGE_REFRESH_SECONDS: a change is observed within that time while the
 * session sits idle.
 *
 * OWNER ONLY. Everything is written 0600 in a 0700 folder under the plugin
 * state root, outside every project folder. Every read refuses a symlink, a
 * file another user owns, and a file group or other can read or write. A
 * hostile process running as the same OS user is outside this guarantee, as
 * the proposal says.
 *
 * Plain JavaScript, node builtins only, because the bridge runs under bare
 * node on every status line refresh and must start fast and never fail.
 */

import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
  chmodSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Seconds between status line refreshes while the bridge is installed. */
export const BRIDGE_REFRESH_SECONDS = 2

/** The status line JSON the bridge will read at most. */
export const STATUS_INPUT_MAX_BYTES = 256 * 1024

/** The bridge's file name: how an installed status line is recognised as ours. */
export const BRIDGE_SCRIPT_NAME = 'hoai-statusline-bridge.mjs'

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const MODEL_ID_RE = /^[\w./:[\]-]{1,160}$/
const EFFORT_RE = /^[a-z]{1,20}$/
const VERSION_RE = /^[\w.+-]{1,40}$/
const ASSISTANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const FILE_MAX_BYTES = 64 * 1024

/**
 * @typedef {object} StatusFacts
 * @property {string} sessionId
 * @property {string} modelId
 * @property {string | null} modelDisplayName
 * @property {string | null} effort
 * @property {string | null} version
 */

/**
 * @typedef {StatusFacts & { seq: number, observedAtMs: number }} ModelObservation
 */

/**
 * The model control folder under the plugin state root.
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [opts]
 * @returns {string}
 */
export function modelControlDir(opts = {}) {
  const env = opts.env ?? process.env
  const root = env.BGOS_PLUGIN_STATE_DIR?.trim() || join(opts.home ?? homedir(), '.bgos-plugin-state')
  return join(root, 'model-control')
}

/**
 * The few facts the bridge keeps, or null for input it will not trust.
 * @param {string} raw
 * @returns {StatusFacts | null}
 */
export function parseStatusLineInput(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > STATUS_INPUT_MAX_BYTES) return null
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const sessionId = data.session_id
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null
  const model = data.model
  if (!model || typeof model !== 'object') return null
  if (typeof model.id !== 'string' || !MODEL_ID_RE.test(model.id)) return null
  const display = typeof model.display_name === 'string' && model.display_name.length <= 80 ? model.display_name : null
  const level = data.effort && typeof data.effort === 'object' ? data.effort.level : undefined
  return {
    sessionId,
    modelId: model.id,
    modelDisplayName: display,
    effort: typeof level === 'string' && EFFORT_RE.test(level) ? level : null,
    version: typeof data.version === 'string' && VERSION_RE.test(data.version) ? data.version : null,
  }
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

/** An owner only regular file (or folder): never a symlink, never shared. */
function ownerOnly(path, kind) {
  let st
  try {
    st = lstatSync(path)
  } catch {
    return false
  }
  if (st.isSymbolicLink()) return false
  if (kind === 'file' ? !st.isFile() : !st.isDirectory()) return false
  const uid = currentUid()
  if (uid !== null && st.uid !== uid) return false
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) return false
  return true
}

function readOwnerJson(path, folder) {
  if (!ownerOnly(folder, 'dir') || !ownerOnly(path, 'file')) return null
  try {
    const text = readFileSync(path, 'utf8')
    if (text.length > FILE_MAX_BYTES) return null
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function ensureOwnerDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const st = lstatSync(path)
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('model control folder is not a plain folder')
  if (process.platform !== 'win32') chmodSync(path, 0o700)
}

/** Write a file 0600 by rename, so a reader never sees half of it. */
function writeOwnerFile(path, text) {
  ensureOwnerDir(dirname(path))
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeSync(fd, text)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

function observationPath(dir, sessionId) {
  return join(dir, 'observations', `${sessionId}.json`)
}

/**
 * Store one observation with the next sequence number.
 * @param {string} dir
 * @param {StatusFacts} facts
 * @param {number} nowMs
 * @returns {ModelObservation | null}
 */
export function recordObservation(dir, facts, nowMs) {
  if (!facts || !SESSION_ID_RE.test(facts.sessionId)) return null
  ensureOwnerDir(dir)
  const previous = readObservation(dir, facts.sessionId)
  /** @type {ModelObservation} */
  const observation = {
    sessionId: facts.sessionId,
    modelId: facts.modelId,
    modelDisplayName: facts.modelDisplayName,
    effort: facts.effort,
    version: facts.version,
    seq: (previous?.seq ?? 0) + 1,
    observedAtMs: nowMs,
  }
  writeOwnerFile(observationPath(dir, facts.sessionId), JSON.stringify(observation))
  return observation
}

/**
 * The latest observation of one session, or null.
 * @param {string} dir
 * @param {string} sessionId
 * @returns {ModelObservation | null}
 */
export function readObservation(dir, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null
  if (!ownerOnly(dir, 'dir')) return null
  const v = readOwnerJson(observationPath(dir, sessionId), join(dir, 'observations'))
  if (!v) return null
  if (v.sessionId !== sessionId) return null
  if (typeof v.modelId !== 'string' || !MODEL_ID_RE.test(v.modelId)) return null
  if (!Number.isSafeInteger(v.seq) || v.seq < 1) return null
  if (typeof v.observedAtMs !== 'number' || !Number.isFinite(v.observedAtMs)) return null
  return {
    sessionId,
    modelId: v.modelId,
    modelDisplayName: typeof v.modelDisplayName === 'string' ? v.modelDisplayName : null,
    effort: typeof v.effort === 'string' && EFFORT_RE.test(v.effort) ? v.effort : null,
    version: typeof v.version === 'string' && VERSION_RE.test(v.version) ? v.version : null,
    seq: v.seq,
    observedAtMs: v.observedAtMs,
  }
}

function optInPath(dir) {
  return join(dir, 'opt-in.json')
}

function readOptInFile(dir) {
  const v = readOwnerJson(optInPath(dir), dir)
  if (!v || v.version !== 1 || !v.assistants || typeof v.assistants !== 'object') return { version: 1, assistants: {} }
  return v
}

/**
 * Has the owner turned remote model and effort control on for this agent?
 * @param {string} dir
 * @param {string} assistantId
 * @returns {boolean}
 */
export function readOptIn(dir, assistantId) {
  if (typeof assistantId !== 'string' || !ASSISTANT_ID_RE.test(assistantId)) return false
  const entry = readOptInFile(dir).assistants[assistantId]
  return Boolean(entry && typeof entry === 'object' && typeof entry.enabledAt === 'number')
}

/**
 * The agents this machine's owner turned control on for.
 * @param {string} dir
 * @returns {string[]}
 */
export function listOptedIn(dir) {
  return Object.keys(readOptInFile(dir).assistants).filter((id) => readOptIn(dir, id))
}

/**
 * Turn control on or off for one agent.
 * @param {string} dir
 * @param {string} assistantId
 * @param {boolean} enabled
 * @param {number} nowMs
 */
export function writeOptIn(dir, assistantId, enabled, nowMs) {
  if (!ASSISTANT_ID_RE.test(String(assistantId))) throw new Error('not an agent id')
  ensureOwnerDir(dir)
  const file = readOptInFile(dir)
  const assistants = { ...file.assistants }
  if (enabled) assistants[assistantId] = { enabledAt: nowMs }
  else delete assistants[assistantId]
  writeOwnerFile(optInPath(dir), JSON.stringify({ version: 1, assistants }, null, 2))
}

function bridgeConfigPath(dir) {
  return join(dir, 'statusline.json')
}

/**
 * The owner's own status line the bridge wraps, or null.
 * @param {string} dir
 * @returns {{ command: string } & Record<string, unknown> | null}
 */
export function readWrappedStatusLine(dir) {
  const v = readOwnerJson(bridgeConfigPath(dir), dir)
  const wrapped = v?.wrapped
  if (!wrapped || typeof wrapped !== 'object' || typeof wrapped.command !== 'string') return null
  if (wrapped.command.includes(BRIDGE_SCRIPT_NAME)) return null
  return wrapped
}

function isBridge(statusLine) {
  return Boolean(statusLine && typeof statusLine === 'object' && typeof statusLine.command === 'string' && statusLine.command.includes(BRIDGE_SCRIPT_NAME))
}

function readSettings(settingsPath) {
  let text
  try {
    text = readFileSync(settingsPath, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, settings: {} }
    return { ok: false, reason: 'the settings file cannot be read' }
  }
  try {
    const settings = JSON.parse(text)
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { ok: false, reason: 'the settings file is not a JSON object' }
    return { ok: true, settings }
  } catch {
    return { ok: false, reason: 'the settings file is not plain JSON, so it is left as it is' }
  }
}

function writeSettings(settingsPath, settings) {
  mkdirSync(dirname(settingsPath), { recursive: true })
  const tmp = `${settingsPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeSync(fd, `${JSON.stringify(settings, null, 2)}\n`)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, settingsPath)
}

/**
 * Put the bridge in front of the owner's status line, keeping theirs.
 * @param {{ settingsPath: string, dir: string, bridgeCommand: string }} input
 * @returns {{ installed: boolean, reason?: string, wrapped?: unknown }}
 */
export function installBridge({ settingsPath, dir, bridgeCommand }) {
  const read = readSettings(settingsPath)
  if (!read.ok) return { installed: false, reason: read.reason }
  const settings = read.settings
  const current = settings.statusLine
  let wrapped
  if (isBridge(current)) {
    wrapped = readWrappedStatusLine(dir)
  } else {
    wrapped = current && typeof current === 'object' && typeof current.command === 'string' ? current : null
    writeOwnerFile(bridgeConfigPath(dir), JSON.stringify({ version: 1, wrapped }, null, 2))
  }
  const theirRefresh = wrapped && typeof wrapped.refreshInterval === 'number' ? wrapped.refreshInterval : null
  settings.statusLine = {
    type: 'command',
    command: bridgeCommand,
    ...(wrapped && typeof wrapped.padding === 'number' ? { padding: wrapped.padding } : {}),
    refreshInterval: theirRefresh !== null && theirRefresh >= 1 ? Math.min(theirRefresh, BRIDGE_REFRESH_SECONDS) : BRIDGE_REFRESH_SECONDS,
  }
  writeSettings(settingsPath, settings)
  return { installed: true, wrapped }
}

/**
 * Take the bridge out and put the owner's own status line back.
 * @param {{ settingsPath: string, dir: string }} input
 * @returns {{ removed: boolean, reason?: string }}
 */
export function uninstallBridge({ settingsPath, dir }) {
  const read = readSettings(settingsPath)
  if (!read.ok) return { removed: false, reason: read.reason }
  const settings = read.settings
  if (!isBridge(settings.statusLine)) return { removed: false, reason: 'the bridge is not installed in this settings file' }
  const wrapped = readWrappedStatusLine(dir)
  if (wrapped) settings.statusLine = wrapped
  else delete settings.statusLine
  writeSettings(settingsPath, settings)
  rmSync(bridgeConfigPath(dir), { force: true })
  return { removed: true }
}

/** The files of the bridge's stable copy, relative to the plugin root. */
export const BRIDGE_COPY_FILES = Object.freeze(['bin/hoai-statusline-bridge.mjs', 'lib/model-control-store.mjs'])

/**
 * Where the status line points: a COPY of the bridge in the owner only
 * folder, not the plugin's own file. A marketplace install lives in a folder
 * named for its version, so a status line pointing into it would break on the
 * first update; the copy's path never moves, and the daemon refreshes its
 * contents at boot while any agent is opted in (refreshBridgeCopy).
 * @param {string} dir
 * @returns {string}
 */
export function bridgeCopyPath(dir) {
  return join(dir, 'bridge', 'bin', BRIDGE_SCRIPT_NAME)
}

/**
 * Write (or rewrite) the bridge's stable copy from this plugin's files.
 * @param {string} dir
 * @param {string} pluginRoot
 * @returns {string} the copy's script path
 */
export function writeBridgeCopy(dir, pluginRoot) {
  for (const rel of BRIDGE_COPY_FILES) {
    writeOwnerFile(join(dir, 'bridge', ...rel.split('/')), readFileSync(join(pluginRoot, ...rel.split('/')), 'utf8'))
  }
  return bridgeCopyPath(dir)
}

/**
 * At daemon boot: bring an existing copy up to this plugin's version. Only
 * when an agent is opted in and a copy is already there; never creates one
 * and never touches a settings file. Never throws.
 * @param {string} dir
 * @param {string} pluginRoot
 * @returns {boolean} whether the copy was refreshed
 */
export function refreshBridgeCopy(dir, pluginRoot) {
  try {
    if (listOptedIn(dir).length === 0) return false
    if (!ownerOnly(bridgeCopyPath(dir), 'file')) return false
    writeBridgeCopy(dir, pluginRoot)
    return true
  } catch {
    return false
  }
}

/**
 * Is the bridge the status line of this settings file?
 * @param {string} settingsPath
 * @returns {boolean}
 */
export function bridgeInstalled(settingsPath) {
  const read = readSettings(settingsPath)
  return read.ok && isBridge(read.settings.statusLine)
}
