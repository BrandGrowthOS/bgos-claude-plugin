/**
 * marker-takeover: the daemon's half of a restart that its hoai launcher
 * refused (Windows only, board report 2026-10-12, agent 909).
 *
 * WHY THIS EXISTS. bin/hoai-core.mjs (byte identical at v0.66.1 and main, the
 * same logic at v0.44.0) allows MAX_RELAUNCHES_PER_WINDOW (3) marker relaunches
 * per rolling hour per launcher PROCESS. The fourth marker is deleted before
 * the budget is even checked (:2295 before :2296) and then ignored, and the
 * `exhausted` latch it sets (:2299, declared once at :2228) is never reset, so
 * every later marker stays on disk for the life of that launcher (:2293). A
 * release train of three updates inside an hour (0.67.3, 0.67.4 and 0.67.5 were
 * tagged within 53 minutes) spends the budget by itself. The launchers already
 * running in the field cannot be changed, and no daemon ever read the marker
 * (0.67.x only writes it, server.ts writeMarker), so nobody acted: Mark wrote
 * one, it vanished and claude kept its pid; he wrote another, it stayed.
 *
 * WHAT THIS DOES. The ACTIVE daemon (the pairing lock holder) watches its own
 * ~/.bgos-agent/<id>/restart-requested.json and, only when the launcher
 * provably left a FRESH marker unanswered, spawns ONE detached hidden helper
 * (bin/hoai-restart-handoff.mjs, lib/restart-handoff.mjs). The helper does
 * everything that changes state (the claim, the ledger, ending claude, the
 * relaunch), after it has proven from the process table that the launcher
 * holds this daemon's claude and planned how the agent comes back. This
 * module claims nothing, writes nothing but a capped refusal, kills nothing,
 * and runs no PowerShell.
 *
 *   stranded   a fresh marker still on disk STRANDED_AFTER_MS after it was
 *              first seen: a launcher that reads markers takes one within a
 *              poll (MARKER_POLL_MS, 3 s), so 5 polls means it stopped reading.
 *   swallowed  a fresh marker gone within SWALLOW_MAX_LIFETIME_MS of being seen
 *              (the launcher's deny branch deletes it on its next poll) while
 *              this session keeps running SWALLOW_CONFIRM_MS longer, with
 *              supervisor.json and launch.json unchanged. A launcher that
 *              honours a marker deletes it and TerminateProcesses claude in the
 *              same poll, and this daemon dies with claude; launch.json is
 *              rewritten before every relaunch (recordRecipe), which also
 *              catches an npm claude.cmd wrapper whose kill left this session
 *              behind while the launcher started another.
 *
 * FRESH means written after this daemon started (mtime > bootAtMs): any
 * session that started after a request already runs the newest installed code,
 * the launcher's own stale rule (:2157-2159). So a marker cannot restart the
 * session that followed it, and a leftover can never act twice.
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe; every effect is
 * injected so tests run it on a fake disk and clock.
 */

import { renameSync, statSync, readFileSync } from 'node:fs'

import {
  MARKER_POLL_MS,
  MAX_RELAUNCHES_PER_WINDOW,
  RELAUNCH_WINDOW_MS,
  RESTART_MARKER_FILE_NAME,
  decideMarkerRelaunch,
} from '../bin/hoai-core.mjs'
import { LAUNCH_RECIPE_FILE_NAME, SUPERVISOR_FILE_NAME, joinDir, parseSupervisorRecord, validAssistantId } from './agent-inventory.mjs'
import { parseInstalledPluginRecord } from './keepalive-plan.mjs'

/** How often the daemon looks at the marker (a folder watch also wakes it). */
export const MARKER_TAKEOVER_POLL_MS = 500
/** A marker still on disk after five launcher polls was not read. */
export const STRANDED_AFTER_MS = 5 * MARKER_POLL_MS
/** The launcher's deny branch deletes a marker on its next poll, 0 to 3 s after
 *  the write; two polls plus a second of slack. Removed later than this, a
 *  marker was removed by someone else, never refused. */
export const SWALLOW_MAX_LIFETIME_MS = 2 * MARKER_POLL_MS + 1_000
/** This session still running this long after the marker vanished proves the
 *  launcher did not restart it. */
export const SWALLOW_CONFIRM_MS = 10_000
/** No takeover before this daemon has run a minute. Its uptime is a lower
 *  bound for claude's, so the launcher never sees the exit inside its
 *  RELAUNCH_HEALTHY_MS (25 s) window, where decideRelaunchRecovery retries
 *  with a NEW session id; a crash looping session is never taken over either. */
export const MIN_SESSION_UP_MS = 60_000
/** One line, once, if the helper has not ended this session by then. */
export const STILL_RUNNING_LOG_MS = 180_000
/** The ledger keeps a day, at most 20 entries. */
export const LEDGER_KEEP_MS = 24 * 3_600_000
export const LEDGER_KEEP_MAX = 20
/** A handoff lock older than this is a dead helper's. */
export const HANDOFF_LOCK_STALE_MS = 15 * 60_000

export const TAKEOVER_LEDGER_FILE_NAME = 'restart-takeovers.json'
export const CLAIMED_MARKER_FILE_NAME = 'restart-requested.claimed.json'
export const REFUSED_MARKER_FILE_NAME = 'restart-requested.refused.json'
export const HANDOFF_LOCK_FILE_NAME = 'restart-handoff.lock'
export const HANDOFF_HELPER_REL = 'bin/hoai-restart-handoff.mjs'
/** HOAI_MARKER_TAKEOVER=off turns the whole thing off on a host. */
export const TAKEOVER_OFF_ENV = 'HOAI_MARKER_TAKEOVER'

/**
 * Claude Code's session markers and the keys only this daemon's own launch
 * sets. None of them may reach the helper or a claude it relaunches: CLAUDECODE
 * makes a new claude refuse to start as a nested session, and the rest name
 * THIS session, not the next one. The keys the plugin manifest and the folder's
 * .mcp.json inject are dropped too (mcpEnvKeys), so the agent's API key never
 * reaches the relaunched claude's tools.
 */
export const SESSION_ENV_KEYS = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_DATA',
  'BGOS_LAUNCH_CWD',
  'BGOS_ASSISTANT_ID',
  'BGOS_CREDENTIALS_PATH',
  'HOAI_SUPERVISED',
  'HOAI_SUPERVISED_ASSISTANT_ID',
])

// -- observation --------------------------------------------------------------

/**
 * Fold one reading of the marker into the observation state.
 *
 * reading: { present, mtimeMs, source: 'poll' | 'watch-named' | 'watch-other',
 *   supervisorRaw?, launchMtimeMs? } (the last two are read at a sighting).
 * Only a marker ON DISK makes a sighting: a folder event with no file is never
 * one, because deleting a stale marker fires the same event as writing one.
 * @param {null | { tracker: object | null, settled: string[] }} state
 * @param {{ present: boolean, mtimeMs: number | null, source?: string, supervisorRaw?: string | null, launchMtimeMs?: number | null }} reading
 * @param {{ now: number, bootAtMs: number }} ctx
 * @returns {{ state: null | { tracker: object | null, settled: string[] }, events: string[], candidate: null | object }}
 */
export function observeMarker(state, reading, ctx) {
  const settled = state?.settled ?? []
  const tracker = state?.tracker ?? null
  const done = (next, events = [], candidate = null) => ({
    state: next.tracker === null && next.settled.length === 0 ? null : next,
    events,
    candidate,
  })
  if (reading.present) {
    const mtimeMs = Number(reading.mtimeMs)
    const key = `m${mtimeMs}`
    if (!Number.isFinite(mtimeMs) || mtimeMs <= ctx.bootAtMs) {
      if (tracker?.key === key) return done({ tracker, settled })
      return done({ tracker: { key, stale: true, markerMtimeMs: mtimeMs }, settled }, ['stale'])
    }
    if (settled.includes(key)) return done({ tracker: null, settled })
    if (!tracker || tracker.key !== key || tracker.stale) {
      const fresh = {
        key,
        stale: false,
        markerMtimeMs: mtimeMs,
        firstSeenAtMs: ctx.now,
        vanishedAtMs: null,
        supervisorRawAtSight: reading.supervisorRaw ?? null,
        launchMtimeAtSight: reading.launchMtimeMs ?? null,
      }
      return done({ tracker: fresh, settled }, ['seen'])
    }
    const again = tracker.vanishedAtMs === null ? tracker : { ...tracker, vanishedAtMs: null }
    if (ctx.now - again.firstSeenAtMs >= STRANDED_AFTER_MS) return done({ tracker: again, settled }, [], candidateOf(again, 'stranded'))
    return done({ tracker: again, settled })
  }
  if (!tracker) return done({ tracker: null, settled })
  if (tracker.stale) return done({ tracker: null, settled })
  if (tracker.vanishedAtMs === null) {
    const lifetime = ctx.now - tracker.firstSeenAtMs
    if (lifetime <= SWALLOW_MAX_LIFETIME_MS) return done({ tracker: { ...tracker, vanishedAtMs: ctx.now }, settled }, ['vanished'])
    return done({ tracker: null, settled: [...settled, tracker.key] }, ['removed_by_other'])
  }
  if (ctx.now - tracker.vanishedAtMs >= SWALLOW_CONFIRM_MS) return done({ tracker, settled }, [], candidateOf(tracker, 'swallowed'))
  return done({ tracker, settled })
}

function candidateOf(tracker, kind) {
  return {
    kind,
    key: tracker.key,
    markerMtimeMs: tracker.markerMtimeMs,
    firstSeenAtMs: tracker.firstSeenAtMs,
    vanishedAtMs: tracker.vanishedAtMs,
    supervisorRawAtSight: tracker.supervisorRawAtSight,
    launchMtimeAtSight: tracker.launchMtimeAtSight,
  }
}

// -- the ledger (the loop guard, shared by every daemon and helper of the agent) --

/**
 * restart-takeovers.json, {schemaVersion: 1, takeovers: [{at, kind,
 * markerMtimeMs, claudePid, launcherPid, daemonPid, pin, route}]}. Junk fails
 * closed for one hour from the file's mtime (loudly), then reads as empty and
 * the next write replaces it: nobody has to delete a file by hand.
 * @param {string | null | undefined} raw
 * @param {{ now: number, fileMtimeMs: number | null }} at
 */
export function parseTakeoverLedger(raw, { now, fileMtimeMs }) {
  if (typeof raw !== 'string' || raw.trim() === '') return { entries: [], unreadable: false, junkBlocksUntilMs: null }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.takeovers)) {
    return { entries: [], unreadable: true, junkBlocksUntilMs: (Number.isFinite(fileMtimeMs) ? fileMtimeMs : now) + RELAUNCH_WINDOW_MS }
  }
  const entries = []
  for (const item of parsed.takeovers) {
    if (!item || typeof item !== 'object') continue
    const atMs = typeof item.at === 'string' ? Date.parse(item.at) : Number.NaN
    if (!Number.isFinite(atMs)) continue
    entries.push({
      atMs,
      kind: item.kind === 'swallowed' ? 'swallowed' : 'stranded',
      markerMtimeMs: Number.isFinite(item.markerMtimeMs) ? item.markerMtimeMs : null,
      claudePid: Number.isInteger(item.claudePid) ? item.claudePid : null,
      launcherPid: Number.isInteger(item.launcherPid) ? item.launcherPid : null,
      daemonPid: Number.isInteger(item.daemonPid) ? item.daemonPid : null,
      pin: typeof item.pin === 'string' ? item.pin : null,
      route: typeof item.route === 'string' ? item.route : null,
    })
  }
  return { entries, unreadable: false, junkBlocksUntilMs: null }
}

/** The launcher's own policy, 3 per rolling hour; an entry dated in the future counts. */
export function takeoverBudget(entries, now) {
  const decision = decideMarkerRelaunch((entries ?? []).map((e) => e.atMs), now)
  const oldest = decision.recent.length ? Math.min(...decision.recent) : null
  return { allow: decision.allow, recent: decision.recent, nextSlotAtMs: decision.allow || oldest === null ? null : oldest + RELAUNCH_WINDOW_MS }
}

/** The ledger body with `entry` appended, pruned to a day and LEDGER_KEEP_MAX. */
export function ledgerBodyWith(entries, entry, now) {
  const kept = [...(entries ?? []), entry]
    .filter((e) => Number.isFinite(e.atMs) && now - e.atMs < LEDGER_KEEP_MS)
    .slice(-LEDGER_KEEP_MAX)
    .map((e) => ({
      at: new Date(e.atMs).toISOString(),
      kind: e.kind,
      markerMtimeMs: e.markerMtimeMs ?? null,
      claudePid: e.claudePid ?? null,
      launcherPid: e.launcherPid ?? null,
      daemonPid: e.daemonPid ?? null,
      pin: e.pin ?? null,
      route: e.route ?? null,
    }))
  return `${JSON.stringify({ schemaVersion: 1, takeovers: kept }, null, 2)}\n`
}

// -- the helper's lock ----------------------------------------------------------

/** restart-handoff.lock body {pid, at}, or null. */
export function parseHandoffLock(raw) {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const parsed = JSON.parse(raw)
    const pid = parsed?.pid
    const atMs = typeof parsed?.at === 'string' ? Date.parse(parsed.at) : Number.NaN
    if (!Number.isInteger(pid) || pid <= 1 || !Number.isFinite(atMs)) return null
    return { pid, atMs }
  } catch {
    return null
  }
}

export function handoffLockLive(lock, { now, pidAlive }) {
  if (!lock) return false
  if (Math.abs(now - lock.atMs) >= HANDOFF_LOCK_STALE_MS) return false
  return Boolean(pidAlive(lock.pid))
}

// -- the decision ----------------------------------------------------------------

/**
 * Should this daemon hand the candidate to a helper? Cheapest gate first; a
 * 'refuse' is final for that marker, a 'wait' keeps it.
 * @param {{ platform: string, now: number, bootAtMs: number, active: boolean, ownPid: number,
 *   claudePid: number | null, supervisorRaw: string | null, launcherAlive: boolean, launchMtimeMs: number | null,
 *   ledger: { entries: object[], unreadable: boolean, junkBlocksUntilMs: number | null },
 *   handoffLockLive: boolean, candidate: object | null }} f
 * @returns {{ action: 'none' | 'wait' | 'refuse' | 'act', reason: string, kind?: string, nextSlotAtMs?: number | null }}
 */
export function decideMarkerTakeover(f) {
  if (f.platform !== 'win32') return { action: 'none', reason: 'not_win32' }
  const c = f.candidate
  if (!c) return { action: 'none', reason: 'no_candidate' }
  const kind = c.kind
  // Age first: a young daemon may only be on its way to the pairing lock.
  if (f.now - f.bootAtMs < MIN_SESSION_UP_MS) return { action: 'wait', reason: 'session_too_young', kind }
  if (!f.active) return { action: 'refuse', reason: 'passive', kind }
  const supervisor = parseSupervisorRecord(f.supervisorRaw)
  if (
    !supervisor ||
    !supervisor.capabilities.includes('relaunch') ||
    supervisor.declaredLauncher ||
    supervisor.pid === f.ownPid ||
    supervisor.pid === f.claudePid ||
    !f.launcherAlive
  ) {
    return { action: 'refuse', reason: 'no_live_hoai_launcher', kind }
  }
  if (f.supervisorRaw !== c.supervisorRawAtSight) return { action: 'refuse', reason: 'launcher_changed', kind }
  if (kind === 'swallowed' && f.launchMtimeMs !== c.launchMtimeAtSight) return { action: 'refuse', reason: 'launcher_relaunched', kind }
  const ledger = f.ledger ?? { entries: [], unreadable: false, junkBlocksUntilMs: null }
  if (ledger.unreadable && Number(ledger.junkBlocksUntilMs) > f.now) return { action: 'refuse', reason: 'ledger_unreadable', kind }
  if (c.markerMtimeMs !== null && ledger.entries.some((e) => e.markerMtimeMs === c.markerMtimeMs)) return { action: 'refuse', reason: 'already_taken_over', kind }
  const budget = takeoverBudget(ledger.entries, f.now)
  if (!budget.allow) return { action: 'refuse', reason: 'cap', kind, nextSlotAtMs: budget.nextSlotAtMs }
  if (f.handoffLockLive) return { action: 'refuse', reason: 'handoff_in_progress', kind }
  return { action: 'act', reason: 'unanswered', kind }
}

// -- what the helper is handed ---------------------------------------------------

/** Every env key name under mcpServers.<name>.env in each JSON text (junk ignored). */
export function mcpEnvKeys(...texts) {
  const keys = new Set()
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      continue
    }
    const servers = parsed?.mcpServers
    if (!servers || typeof servers !== 'object') continue
    for (const server of Object.values(servers)) {
      const env = server && typeof server === 'object' ? server.env : null
      if (!env || typeof env !== 'object') continue
      for (const key of Object.keys(env)) keys.add(key)
    }
  }
  return keys
}

/**
 * A copy of env without SESSION_ENV_KEYS and extraKeys (case-insensitive on win32).
 * @param {Record<string, string | undefined>} env
 * @param {{ platform?: string, extraKeys?: Set<string> }} [opts]
 * @returns {Record<string, string>}
 */
export function handoffEnv(env, { platform = process.platform, extraKeys = new Set() } = {}) {
  const fold = (k) => (platform === 'win32' ? String(k).toUpperCase() : String(k))
  const drop = new Set([...SESSION_ENV_KEYS, ...extraKeys].map(fold))
  /** @type {Record<string, string>} */
  const out = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined || drop.has(fold(key))) continue
    out[key] = value
  }
  return out
}

const HANDOFF_ARGS = [
  ['assistant', 'assistantId', 'id'],
  ['kind', 'kind', 'kind'],
  ['marker-mtime', 'markerMtimeMs', 'ms'],
  ['boot-at', 'bootAtMs', 'ms'],
  ['daemon-pid', 'daemonPid', 'pid'],
  ['claude-pid', 'claudePid', 'pid0'],
  ['launcher-pid', 'launcherPid', 'pid'],
  ['state-dir', 'stateDir', 'path'],
  ['home', 'home', 'path'],
  ['launch-cwd', 'launchCwd', 'path'],
  ['log', 'logPath', 'path'],
  ['plugin-state-dir', 'pluginStateDir', 'path'],
  ['credentials', 'credentialsPath', 'path'],
  ['plugin-root', 'pluginRoot', 'path'],
]

/** The helper's argv: one --flag value pair per field, strings only. */
export function handoffArgv(params) {
  const out = []
  for (const [flag, key] of HANDOFF_ARGS) out.push(`--${flag}`, String(params[key] ?? ''))
  return out
}

function absoluteWin32OrPosix(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

/** Parse the helper's argv back; any junk field makes the whole thing null. */
export function parseHandoffArgv(argv) {
  const list = Array.isArray(argv) ? argv.map(String) : []
  const out = {}
  for (const [flag, key, type] of HANDOFF_ARGS) {
    const i = list.indexOf(`--${flag}`)
    if (i < 0 || i + 1 >= list.length) return null
    const value = list[i + 1]
    if (type === 'id') {
      const id = validAssistantId(value)
      if (!id || id !== value) return null
      out[key] = id
    } else if (type === 'kind') {
      if (value !== 'stranded' && value !== 'swallowed') return null
      out[key] = value
    } else if (type === 'ms') {
      if (!/^\d+$/.test(value)) return null
      out[key] = Number(value)
    } else if (type === 'pid' || type === 'pid0') {
      if (!/^\d+$/.test(value)) return null
      const pid = Number(value)
      if (!Number.isSafeInteger(pid) || (type === 'pid' ? pid <= 1 : pid === 1)) return null
      out[key] = pid
    } else {
      if (!value || /[\r\n"]/.test(value) || !absoluteWin32OrPosix(value) || /(^|[\\/])\.\.([\\/]|$)/.test(value)) return null
      out[key] = value
    }
  }
  return out
}

/**
 * The root a relaunch must run hoai-core from. A clone runs from its checkout.
 * A marketplace install's RUNNING root is the cache dir of the version this
 * daemon started on, which is the OLD one exactly when an update waits for a
 * restart: installed_plugins.json names the installed one.
 */
export function currentPluginRootFor({ installMethod, pluginRoot, installedPluginsRaw, exists }) {
  if (installMethod !== 'marketplace') return pluginRoot
  const record = parseInstalledPluginRecord(installedPluginsRaw)
  const path = record?.installPath ? String(record.installPath) : ''
  if (path && exists(joinDir(joinDir(path, 'bin'), 'hoai-core.mjs'))) return path
  return pluginRoot
}

// -- the controller ---------------------------------------------------------------

/**
 * Rename the marker aside as restart-requested.refused.json, only while it is
 * still the marker of that mtime: the launcher's deny branch deletes a refused
 * marker, so a refused one must not act an hour later when the window frees.
 */
export function refuseMarkerForCap({ stateDir, markerMtimeMs, fs }) {
  const marker = joinDir(stateDir, RESTART_MARKER_FILE_NAME)
  const st = fs.stat(marker)
  if (!st || st.mtimeMs !== markerMtimeMs) return 'gone'
  return fs.rename(marker, joinDir(stateDir, REFUSED_MARKER_FILE_NAME))
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown'
}

/**
 * The daemon's watcher of its own marker. tick() is synchronous and returns
 * the decision it took (or null), so tests drive it directly.
 * @param {{ platform: string, assistantId: string, stateDir: string, bootAtMs: number, now: () => number,
 *   ownPid: number, active: () => boolean, claudePid: () => number | null,
 *   fs: { stat: (p: string) => { mtimeMs: number } | null, readFile: (p: string) => string | null, rename: (a: string, b: string) => 'ok' | 'gone' | 'busy' },
 *   pidAlive: (pid: number) => boolean, setInterval: Function, clearInterval: Function, setTimeout: Function,
 *   watch: Function, spawnHelper: (argv: string[], env: Record<string, string>) => { pid: number | null },
 *   helperParams: () => Record<string, unknown>, helperEnv: () => Record<string, string>, log: (line: string) => void }} deps
 */
export function createMarkerTakeover(deps) {
  const markerPath = joinDir(deps.stateDir, RESTART_MARKER_FILE_NAME)
  const supervisorPath = joinDir(deps.stateDir, SUPERVISOR_FILE_NAME)
  const launchPath = joinDir(deps.stateDir, LAUNCH_RECIPE_FILE_NAME)
  const ledgerPath = joinDir(deps.stateDir, TAKEOVER_LEDGER_FILE_NAME)
  const lockPath = joinDir(deps.stateDir, HANDOFF_LOCK_FILE_NAME)
  const log = (text) => {
    try {
      deps.log(`restart takeover: ${text}`)
    } catch {
      // A log that throws must never stop the session.
    }
  }
  let state = null
  let done = false
  let interval = null
  let watcher = null
  const said = new Set()
  const once = (key, text) => {
    if (said.has(key)) return
    said.add(key)
    log(text)
  }
  const launcherPidOf = (raw) => parseSupervisorRecord(raw)?.pid ?? null

  const settle = (key) => {
    state = { tracker: null, settled: [...(state?.settled ?? []), key] }
  }

  const tick = (source = 'poll') => {
    if (done || deps.platform !== 'win32') return null
    let decision = null
    try {
      const st = deps.fs.stat(markerPath)
      const reading = { present: Boolean(st), mtimeMs: st ? st.mtimeMs : null, source }
      if (st && state?.tracker?.key !== `m${st.mtimeMs}`) {
        reading.supervisorRaw = deps.fs.readFile(supervisorPath)
        reading.launchMtimeMs = deps.fs.stat(launchPath)?.mtimeMs ?? null
      }
      const now = deps.now()
      const out = observeMarker(state, reading, { now, bootAtMs: deps.bootAtMs })
      state = out.state
      const t = state?.tracker
      for (const event of out.events) {
        if (event === 'stale') once(`stale:${reading.mtimeMs}`, `stale marker on disk (written ${iso(reading.mtimeMs)}, before this daemon started at ${iso(deps.bootAtMs)}); never acted on`)
        else if (event === 'seen') log(`marker seen (written ${iso(t?.markerMtimeMs)}); hoai launcher pid ${launcherPidOf(t?.supervisorRawAtSight) ?? 'none'} has ${STRANDED_AFTER_MS / 1000}s to act on it`)
        else if (event === 'vanished') log(`marker removed ${t ? now - t.firstSeenAtMs : 0}ms after it was seen while this session runs; checking for ${SWALLOW_CONFIRM_MS / 1000}s that launcher pid ${launcherPidOf(t?.supervisorRawAtSight) ?? 'none'} restarted claude`)
        else if (event === 'removed_by_other') log('marker removed later than a launcher poll after it was seen; not a refusal, not acting')
      }
      if (!out.candidate) return null
      const c = out.candidate
      const supervisorRaw = deps.fs.readFile(supervisorPath)
      const launcherPid = launcherPidOf(supervisorRaw)
      const ledgerRaw = deps.fs.readFile(ledgerPath)
      const ledger = parseTakeoverLedger(ledgerRaw, { now, fileMtimeMs: deps.fs.stat(ledgerPath)?.mtimeMs ?? null })
      const lock = parseHandoffLock(deps.fs.readFile(lockPath))
      const claudePid = deps.claudePid() ?? null
      decision = decideMarkerTakeover({
        platform: deps.platform,
        now,
        bootAtMs: deps.bootAtMs,
        active: Boolean(deps.active()),
        ownPid: deps.ownPid,
        claudePid,
        supervisorRaw,
        launcherAlive: launcherPid !== null && Boolean(deps.pidAlive(launcherPid)),
        launchMtimeMs: deps.fs.stat(launchPath)?.mtimeMs ?? null,
        ledger,
        handoffLockLive: handoffLockLive(lock, { now, pidAlive: deps.pidAlive }),
        candidate: c,
      })
      const written = iso(c.markerMtimeMs)
      if (decision.action === 'wait') {
        once(`wait:${c.key}:${decision.reason}`, `waiting (${decision.reason}: this daemon started ${Math.round((now - deps.bootAtMs) / 1000)}s ago, a takeover needs ${MIN_SESSION_UP_MS / 1000}s)`)
        return decision
      }
      if (decision.action === 'refuse') {
        settle(c.key)
        if (decision.reason === 'cap') {
          let aside = ''
          if (c.kind === 'stranded') {
            const renamed = refuseMarkerForCap({ stateDir: deps.stateDir, markerMtimeMs: c.markerMtimeMs, fs: deps.fs })
            aside = renamed === 'ok' ? ` (kept as ${REFUSED_MARKER_FILE_NAME})` : ''
          }
          log(`REFUSED (loop guard): ${MAX_RELAUNCHES_PER_WINDOW} takeovers in the last hour (next slot ${iso(decision.nextSlotAtMs)}); the marker written ${written} is dropped${aside}; restart agent ${deps.assistantId} by hand`)
        } else {
          const detail = decision.reason === 'passive' ? 'passive, pairing lock held by another daemon' : decision.reason === 'handoff_in_progress' ? `handoff_in_progress (helper pid ${lock?.pid ?? '?'})` : decision.reason === 'ledger_unreadable' ? `ledger_unreadable until ${iso(ledger.junkBlocksUntilMs)}` : decision.reason
          log(`NOT acting on the marker written ${written}: ${detail}`)
        }
        return decision
      }
      if (decision.action !== 'act') return decision
      // Act: one helper per daemon process, marked before the spawn so a
      // re-entrant watch event can never spawn twice.
      done = true
      const takeoverNumber = takeoverBudget(ledger.entries, now).recent.length + 1
      const params = {
        ...deps.helperParams(),
        assistantId: deps.assistantId,
        kind: c.kind,
        markerMtimeMs: c.markerMtimeMs ?? 0,
        bootAtMs: deps.bootAtMs,
        daemonPid: deps.ownPid,
        claudePid: claudePid ?? 0,
        launcherPid,
        stateDir: deps.stateDir,
      }
      let helper
      try {
        helper = deps.spawnHelper(handoffArgv(params), deps.helperEnv())
      } catch (err) {
        log(`HANDOFF DID NOT START (${err?.message ?? err}); this session keeps running`)
        stop()
        return decision
      }
      log(
        `ACT (${c.kind}): hoai launcher pid ${launcherPid} left the marker written ${written} unanswered; ` +
          `takeover ${takeoverNumber} of ${MAX_RELAUNCHES_PER_WINDOW} this hour; helper pid ${helper?.pid ?? '?'} checks this session, ` +
          `ends claude pid ${claudePid ?? 'unknown'} and brings agent ${deps.assistantId} back on its pinned session`,
      )
      stop()
      try {
        const timer = deps.setTimeout(() => log(`this session still runs ${STILL_RUNNING_LOG_MS / 1000}s after helper pid ${helper?.pid ?? '?'} started; see its lines`), STILL_RUNNING_LOG_MS)
        timer?.unref?.()
      } catch {
        // Only a log line.
      }
      return decision
    } catch (err) {
      once(`error:${err?.message ?? err}`, `tick failed (${err?.message ?? err}); next tick tries again`)
      return decision
    }
  }

  function stop() {
    if (interval !== null) {
      try {
        deps.clearInterval(interval)
      } catch {}
      interval = null
    }
    if (watcher) {
      try {
        watcher.close()
      } catch {}
      watcher = null
    }
  }

  const armedLine =
    `armed for ${markerPath} (Windows; acts only when the hoai launcher leaves a fresh marker unanswered: ` +
    `still there after ${STRANDED_AFTER_MS / 1000}s, or removed within ${SWALLOW_MAX_LIFETIME_MS / 1000}s while this session runs ` +
    `${SWALLOW_CONFIRM_MS / 1000}s more; session up ${MIN_SESSION_UP_MS / 1000}s first; at most ${MAX_RELAUNCHES_PER_WINDOW} per hour; ` +
    'only while this daemon holds the pairing lock)'

  return {
    armedLine,
    tick,
    stop,
    start() {
      if (deps.platform !== 'win32' || done) return
      log(armedLine)
      tick('poll')
      interval = deps.setInterval(() => tick('poll'), MARKER_TAKEOVER_POLL_MS)
      interval?.unref?.()
      try {
        watcher = deps.watch(deps.stateDir, { persistent: false }, (_event, name) => {
          tick(String(name ?? '') === RESTART_MARKER_FILE_NAME ? 'watch-named' : 'watch-other')
        })
        watcher?.on?.('error', (err) => {
          log(`folder watch failed (${err?.message ?? err}); polling every ${MARKER_TAKEOVER_POLL_MS}ms only`)
          try {
            watcher?.close()
          } catch {}
          watcher = null
        })
      } catch (err) {
        log(`folder watch unavailable (${err?.message ?? err}); polling every ${MARKER_TAKEOVER_POLL_MS}ms only`)
        watcher = null
      }
    },
  }
}

/** The node-backed fs the daemon wires in. Never throws. */
export function nodeTakeoverFs() {
  return {
    stat: (p) => {
      try {
        const s = statSync(p)
        // Whole milliseconds: NTFS mtimes are fractional, and the value rides
        // the helper's argv and the ledger, where it must compare exactly.
        return s.isFile() ? { mtimeMs: Math.floor(s.mtimeMs) } : null
      } catch {
        return null
      }
    },
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
    rename: (from, to) => {
      try {
        renameSync(from, to)
        return 'ok'
      } catch (err) {
        return err?.code === 'ENOENT' ? 'gone' : 'busy'
      }
    },
  }
}
