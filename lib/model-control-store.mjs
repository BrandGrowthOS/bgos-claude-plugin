/**
 * model-control-store: the owner's opt in to remote model and effort control,
 * and the status line bridge that is its confirmation source (Route A, KC
 * 2026-10-23: "A separate owner opt-in for remote model and effort control
 * (the compact permission does not count)").
 *
 * THE OPT IN is per agent and lives on the agent's own machine. The Helper's
 * agent launcher (bin/hoai-core.mjs) turns it on for its own agent when it
 * starts it (ensureHelperModelControl, so there is
 * no command to type), and the owner's own command does the same now
 * (bin/hoai-model-control.mjs on --assistant <id>). The owner's own `off` is
 * remembered and the Helper never undoes it. Whether the app SHOWS the picker
 * stays the owner's choice in the app's Settings, off by default. Nothing on
 * the wire can turn the opt in on. The daemon reads it per request, so an
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
 * puts the owner's line back. It is installed per agent, in that agent's own
 * `<folder>/.claude/settings.local.json` (installAgentBridge), never in the
 * shared ~/.claude/settings.json, so no other session on the machine is
 * touched; the line it wraps (the folder's own, else the owner's project or
 * user line, which the local file would otherwise hide) is kept per agent.
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
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
  chmodSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

/** Every agent with no entry may have been turned off (an older file not settled yet, or one that cannot be read). */
const ALL_OLDER_OFFS = 'all'

/**
 * The opt in file, and the agents with no entry that may still have been
 * turned off by their owner (`olderOffs`). Before 0.91.0 an `off` deleted the
 * agent's entry, so in a file that version wrote no entry can mean off; a file
 * this version writes says `keepsOffs`, keeps every `off` as an entry, and
 * names the agents an older off may cover: the ones this machine had when this
 * version first read the older file (settleOlderOffs). Until then, and for a
 * file that is there but cannot be read, every agent with no entry: nobody can
 * say.
 */
function readOptInFile(dir) {
  const path = optInPath(dir)
  const v = readOwnerJson(path, dir)
  if (!v || v.version !== 1 || !v.assistants || typeof v.assistants !== 'object' || Array.isArray(v.assistants)) {
    let there = false
    try {
      lstatSync(path)
      there = true
    } catch {
      there = false
    }
    return { version: 1, assistants: {}, olderOffs: there ? ALL_OLDER_OFFS : [], unreadable: there }
  }
  let olderOffs = ALL_OLDER_OFFS
  if (v.keepsOffs === true && v.olderOffs !== true) {
    olderOffs = Array.isArray(v.olderOffs) ? v.olderOffs.filter((id) => typeof id === 'string' && ASSISTANT_ID_RE.test(id)) : []
  }
  return { version: 1, assistants: v.assistants, olderOffs, unreadable: false }
}

/**
 * The agents paired on this machine: the ids in the NAMES of
 * ~/.bgos-agent/credentials-<id>.json (lib/agent-inventory.mjs
 * listPairedAssistantIds; restated because the bridge's copy of this file
 * imports nothing). The files themselves are never opened. Null when the
 * folder cannot be listed.
 */
function pairedAgentIds(home) {
  try {
    return readdirSync(join(home, '.bgos-agent'))
      .map((name) => /^credentials-(\d+)\.json$/.exec(name)?.[1])
      .filter((id) => id !== undefined)
  } catch {
    return null
  }
}

/** The agents an older off may cover, as a list once it can be (the paired agents with no entry), else still all. */
function olderOffsList(file, home) {
  if (file.olderOffs !== ALL_OLDER_OFFS) return file.olderOffs
  const paired = home ? pairedAgentIds(home) : null
  return paired ? paired.filter((id) => !Object.prototype.hasOwnProperty.call(file.assistants, id)) : ALL_OLDER_OFFS
}

function writeOptInBody(dir, assistants, olderOffs) {
  const older = olderOffs === ALL_OLDER_OFFS ? { olderOffs: true } : olderOffs.length > 0 ? { olderOffs } : {}
  writeOwnerFile(optInPath(dir), JSON.stringify({ version: 1, keepsOffs: true, ...older, assistants }, null, 2))
}

/**
 * The first read of an older file by this version names the agents its offs
 * may cover, so an agent paired after the upgrade is never one of them. A file
 * that cannot be read is left as it is.
 */
function settleOlderOffs(dir, home) {
  const file = readOptInFile(dir)
  if (file.olderOffs !== ALL_OLDER_OFFS || file.unreadable) return
  const list = olderOffsList(file, home)
  if (list === ALL_OLDER_OFFS) return
  writeOptInBody(dir, { ...file.assistants }, list)
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
 * Turn control on or off for one agent. An `off` is remembered (disabledAt),
 * so the Helper never turns it back on; only an owner's own `on` does.
 * @param {string} dir
 * @param {string} assistantId
 * @param {boolean} enabled
 * @param {number} nowMs
 * @param {{ by?: 'helper', home?: string }} [opts] `home`: where the paired agents are read when an older file is settled
 */
export function writeOptIn(dir, assistantId, enabled, nowMs, opts = {}) {
  if (!ASSISTANT_ID_RE.test(String(assistantId))) throw new Error('not an agent id')
  ensureOwnerDir(dir)
  const file = readOptInFile(dir)
  const assistants = { ...file.assistants }
  if (enabled) assistants[assistantId] = { enabledAt: nowMs, ...(opts.by === 'helper' ? { by: 'helper' } : {}) }
  else assistants[assistantId] = { disabledAt: nowMs }
  // The other agents an older off may cover stay off; this one has its own entry now.
  const older = olderOffsList(file, opts.home)
  writeOptInBody(dir, assistants, older === ALL_OLDER_OFFS ? older : older.filter((id) => id !== String(assistantId)))
}

/**
 * Did the owner turn control off for this agent themselves? Also true for an
 * agent an older off may cover: no entry, in a file an older plugin wrote,
 * where an off left none.
 */
function ownerTurnedOff(dir, assistantId) {
  const file = readOptInFile(dir)
  const entry = file.assistants[assistantId]
  if (!entry || typeof entry !== 'object') {
    return file.olderOffs === ALL_OLDER_OFFS || file.olderOffs.includes(String(assistantId))
  }
  return typeof entry.disabledAt === 'number' && typeof entry.enabledAt !== 'number'
}

/** A folder as the file system names it: its real path when there is one, without a trailing separator, any case on Windows. */
function sameFolder(a, b, platform) {
  const canon = (p) => {
    let out = resolve(String(p))
    try {
      out = realpathSync.native(out)
    } catch {
      // A folder that is not there yet is compared as written.
    }
    out = out.replace(/[\\/]+$/, '') || out
    return platform === 'win32' || process.platform === 'win32' ? out.toLowerCase() : out
  }
  return canon(a) === canon(b)
}

/**
 * Is the agent's folder the home folder, or one whose .claude is Claude Code's
 * own settings folder? Its .claude/settings.local.json would then sit beside
 * the settings every session on this machine reads.
 */
export function isHomeFolder(cwd, home, configDir, platform) {
  return (Boolean(home) && sameFolder(cwd, home, platform)) || (Boolean(configDir) && sameFolder(join(cwd, '.claude'), configDir, platform))
}

function bridgeConfigPath(dir) {
  return join(dir, 'statusline.json')
}

function agentBridgeConfigPath(dir, assistantId) {
  return join(dir, `statusline-agent-${assistantId}.json`)
}

/**
 * The owner's own status line the bridge wraps, or null: the one agent's
 * when `assistantId` is given (installAgentBridge), else the machine wide one
 * an older `hoai-model-control on` wrote.
 * @param {string} dir
 * @param {string} [assistantId]
 * @returns {{ command: string } & Record<string, unknown> | null}
 */
export function readWrappedStatusLine(dir, assistantId) {
  if (assistantId !== undefined && !ASSISTANT_ID_RE.test(String(assistantId))) return null
  const path = assistantId === undefined ? bridgeConfigPath(dir) : agentBridgeConfigPath(dir, assistantId)
  const v = readOwnerJson(path, dir)
  return commandLine(v?.wrapped)
}

/** A status line that runs a command and is not the bridge, or null. */
function commandLine(statusLine) {
  if (!statusLine || typeof statusLine !== 'object' || Array.isArray(statusLine) || typeof statusLine.command !== 'string') return null
  if (statusLine.command.includes(BRIDGE_SCRIPT_NAME)) return null
  return statusLine
}

function readAgentRecord(dir, assistantId) {
  const v = readOwnerJson(agentBridgeConfigPath(dir, assistantId), dir)
  if (!v || v.version !== 1) return null
  return { wrapped: commandLine(v.wrapped), from: v.from === 'local' ? 'local' : v.from === 'fallback' ? 'fallback' : null }
}

/**
 * The first command status line of these settings files, the bridge skipped.
 * The machine wide bridge an older `hoai-model-control on` put in the shared
 * settings runs the owner's own line from its machine wide record: that line
 * is the one to keep printing.
 */
function fallbackLine(paths, dir) {
  for (const path of paths ?? []) {
    const read = readSettings(path)
    if (!read.ok) continue
    const line = commandLine(read.settings.statusLine)
    if (line) return line
    if (isBridge(read.settings.statusLine)) {
      const older = readWrappedStatusLine(dir)
      if (older) return older
    }
  }
  return null
}

/** The agent a bridge line names (`... --agent <id>`, bridgeCommandFor), or null. */
function bridgeAgentOf(statusLine) {
  const m = /\s--agent\s+([A-Za-z0-9_-]{1,64})\s*$/.exec(String(statusLine?.command ?? ''))
  return m ? m[1] : null
}

/** What the bridge in this settings file would run behind it, and where that line lives. */
function lineToWrap(settings, dir, assistantId, fallbackSettingsPaths) {
  const current = settings.statusLine
  if (isBridge(current)) {
    // A folder paired again holds the bridge of the agent it was: that agent's
    // record holds the folder's own line.
    const named = bridgeAgentOf(current)
    const record = readAgentRecord(dir, assistantId) ?? (named && named !== String(assistantId) ? readAgentRecord(dir, named) : null)
    if (record && record.from === 'local') return { wrapped: record.wrapped, from: record.wrapped ? 'local' : null }
  } else {
    const own = commandLine(current)
    if (own) return { wrapped: own, from: 'local' }
  }
  const fallback = fallbackLine(fallbackSettingsPaths, dir)
  return { wrapped: fallback, from: fallback ? 'fallback' : null }
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
 * Put the bridge in one agent's own settings file (its folder's
 * .claude/settings.local.json), keeping what that file hides: its own line,
 * else the first of `fallbackSettingsPaths` (the folder's project settings,
 * then the owner's user settings) that has one, read again on every install
 * so a line the owner changes there is followed at the next launch. Those
 * files are only read. The bridge command names the agent (`--agent <id>`),
 * so it runs that agent's wrapped line.
 * @param {{ settingsPath: string, dir: string, assistantId: string, bridgeCommand: string, fallbackSettingsPaths?: string[] }} input
 * @returns {{ installed: boolean, reason?: string, wrapped?: unknown }}
 */
export function installAgentBridge({ settingsPath, dir, assistantId, bridgeCommand, fallbackSettingsPaths = [] }) {
  if (!ASSISTANT_ID_RE.test(String(assistantId))) return { installed: false, reason: 'not an agent id' }
  const read = readSettings(settingsPath)
  if (!read.ok) return { installed: false, reason: read.reason }
  const settings = read.settings
  const { wrapped, from } = lineToWrap(settings, dir, assistantId, fallbackSettingsPaths)
  writeOwnerFile(agentBridgeConfigPath(dir, assistantId), JSON.stringify({ version: 1, wrapped, from }, null, 2))
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
 * Take the bridge out of one agent's own settings file: the file's own line
 * back when the bridge wrapped it, else no line (a project or user line was
 * never this file's).
 * @param {{ settingsPath: string, dir: string, assistantId: string }} input
 * @returns {{ removed: boolean, reason?: string }}
 */
export function uninstallAgentBridge({ settingsPath, dir, assistantId }) {
  if (!ASSISTANT_ID_RE.test(String(assistantId))) return { removed: false, reason: 'not an agent id' }
  const read = readSettings(settingsPath)
  if (!read.ok) return { removed: false, reason: read.reason }
  const settings = read.settings
  if (!isBridge(settings.statusLine)) return { removed: false, reason: 'the bridge is not installed in this settings file' }
  const record = readAgentRecord(dir, assistantId)
  if (record && record.from === 'local' && record.wrapped) settings.statusLine = record.wrapped
  else delete settings.statusLine
  writeSettings(settingsPath, settings)
  rmSync(agentBridgeConfigPath(dir, assistantId), { force: true })
  return { removed: true }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Characters a double quoted Windows path cannot carry safely through bash, cmd.exe or a shell's expansion. */
const WIN_UNQUOTABLE = /["$`%!\r\n]/

/**
 * The status line command for one agent's bridge, quoted for the shell
 * Claude Code runs status lines in: POSIX single quotes; on Windows (Git Bash,
 * or cmd.exe) double quotes around forward slash paths, refusing a path with
 * a character either would expand. Null when it cannot be quoted safely.
 * @param {{ nodePath: string, bridgePath: string, assistantId: string, platform: string }} input
 * @returns {string | null}
 */
export function bridgeCommandFor({ nodePath, bridgePath, assistantId, platform }) {
  if (!ASSISTANT_ID_RE.test(String(assistantId))) return null
  const node = String(nodePath ?? '')
  const bridge = String(bridgePath ?? '')
  if (!node || !bridge) return null
  if (platform === 'win32') {
    if (WIN_UNQUOTABLE.test(node) || WIN_UNQUOTABLE.test(bridge)) return null
    const fwd = (p) => p.replace(/\\/g, '/')
    return `"${fwd(node)}" "${fwd(bridge)}" --agent ${assistantId}`
  }
  if (/[\r\n]/.test(node) || /[\r\n]/.test(bridge)) return null
  return `${shellQuote(node)} ${shellQuote(bridge)} --agent ${assistantId}`
}

/**
 * The Helper turns owner model control on for the agent it is about to start
 * (bin/hoai-core.mjs, before every launch): the bridge in the agent's own
 * folder settings, a stable copy of it, and the opt in recorded `by: helper`.
 * Never when the owner turned it off themselves. On Windows, never when it
 * would have to run an owner status line behind it: that line was written for
 * the shell Claude Code runs status lines in, and the bridge's own runner is
 * cmd.exe there, so it would stop printing. Never throws; says why not.
 * Never for an agent whose folder is the home folder (isHomeFolder): nothing
 * is written there. `owner: true` is the owner's own `hoai-model-control on`:
 * the same steps, and it undoes their earlier `off`. `home` is where the
 * paired agents are read when an older opt in file is settled.
 * @param {{ cwd: string, assistantId: string, dir: string, pluginRoot: string, nodePath: string, platform: string, configDir: string, nowMs: number, owner?: boolean, home?: string }} input
 * @returns {{ on: boolean, reason: string }}
 */
export function ensureHelperModelControl({ cwd, assistantId, dir, pluginRoot, nodePath, platform, configDir, nowMs, owner = false, home }) {
  try {
    if (!ASSISTANT_ID_RE.test(String(assistantId)) || !cwd) return { on: false, reason: 'no_agent' }
    if (isHomeFolder(cwd, home, configDir, platform)) return { on: false, reason: 'home_folder' }
    if (home) settleOlderOffs(dir, home)
    if (!owner && ownerTurnedOff(dir, assistantId)) return { on: false, reason: 'owner_off' }
    const settingsPath = join(cwd, '.claude', 'settings.local.json')
    const fallbackSettingsPaths = [join(cwd, '.claude', 'settings.json'), join(configDir, 'settings.json')]
    const read = readSettings(settingsPath)
    if (!read.ok) return { on: false, reason: 'settings_unreadable' }
    if (platform === 'win32' && lineToWrap(read.settings, dir, assistantId, fallbackSettingsPaths).wrapped) {
      // The owner's line must keep printing: a bridge put in by an earlier
      // launch comes out again.
      if (isBridge(read.settings.statusLine)) uninstallAgentBridge({ settingsPath, dir, assistantId })
      return { on: false, reason: 'own_status_line' }
    }
    const bridgeCommand = bridgeCommandFor({ nodePath, bridgePath: bridgeCopyPath(dir), assistantId, platform })
    if (!bridgeCommand) return { on: false, reason: 'unquotable_path' }
    writeBridgeCopy(dir, pluginRoot)
    const out = installAgentBridge({ settingsPath, dir, assistantId, bridgeCommand, fallbackSettingsPaths })
    if (!out.installed) return { on: false, reason: 'settings_unreadable' }
    if (owner) writeOptIn(dir, assistantId, true, nowMs, { home })
    else if (!readOptIn(dir, assistantId)) writeOptIn(dir, assistantId, true, nowMs, { by: 'helper', home })
    return { on: true, reason: 'on' }
  } catch {
    return { on: false, reason: 'failed' }
  }
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
