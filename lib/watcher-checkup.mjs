/**
 * watcher-checkup: what the watcher's `checkup` job reads for ONE agent, and how its answer travels
 * (check up plan 4.2, packet P3). The job itself (observe, plan, execute, verify, progress) is
 * runCheckupJob in lib/watcher-core.mjs, beside the reconcile and create_agent jobs; the decisions
 * are the PURE lib/agent-checkup.mjs (checkupPass). This module turns what the computer shows into
 * that module's observation, and its findings and actions into the backend's progress DTO.
 *
 * The facts, each from the place the keep-alive sweep already reads (lib/watcher-keepalive.mjs):
 *
 *   processes   one listing (lib/process-tree.mjs): the agent's claude by its pin or folder on the
 *               command line, its state's claudePid, the claude above its live daemon, its keepalive's
 *               claude; a cwd lookup only when none is found. Unreadable, or a live daemon with no
 *               claude visible above it, is UNKNOWN (null), which names no process cause.
 *   daemon      liveAgentDaemonPid: the writer of a fresh agent-state.json, else the live holder of
 *               the pairing lock.
 *   beacon      the mtime of <plugin state>/channel-beacon.json, stamped on every successful beacon.
 *   launch      <statedir>/launch-status (its outcome word) and a supervisor or a launch recipe.
 *   transcript  the tail of the pinned session's transcript: the newest real assistant turn, the
 *               newest OWNER channel message (the CLI records it as a user entry whose text opens
 *               with <channel ...>), and the CLI's own error envelope (authentication_failed,
 *               rate_limit). The chat cursor file is NOT the delivery evidence: it advances on the
 *               agent's own replies too, so it would call every quiet agent wedged.
 *   versions    the fresh state's runningVersion, the installed plugin (installed_plugins.json, or a
 *               clone's package.json) and the marketplace's latest (local files, no network).
 *   update      auto-update.json validationPending, a keep-alive act left in flight (a watcher
 *               killed mid install or restart), and a restart that did not pick up the install.
 *   budget      the agent's keep-alive record (lastRestartAt, attempts), which the sweep shares, so
 *               a check up can never get round one restart per 30 min and three attempts.
 *
 * Plain JavaScript, node >= 18, every effect injected.
 */

import { realpathSync } from 'node:fs'

import { claudeConfigDir, installedPluginsPath, isUnderPluginsDir } from '../bin/bgos-install-method.mjs'
import { BEACON_HEARTBEAT_FILE_NAME, LAUNCH_RECIPE_FILE_NAME, joinDir, parseLaunchRecipe, validAssistantId } from './agent-inventory.mjs'
import { CAUSES, compareVersions } from './agent-checkup.mjs'
import { liveAgentDaemonPid } from './agent-restart.mjs'
import {
  AGENT_STATE_FILE_NAME,
  LAUNCH_STATUS_FILE_NAME,
  LEGACY_QUIET_WINDOW_MS,
  advanceAgentRecord,
  isAgentStateFresh,
  parseAgentState,
  parseInstalledPluginRecord,
  parseLaunchStatusOutcome,
} from './keepalive-plan.mjs'
import { claudeCandidates, descendantsOf, findAgentClaudePids, findClaudePidsByCwd, listProcesses, nearestClaudeAncestor, readProcessCwds } from './process-tree.mjs'
import { joinRel, readPluginVersion } from './watcher-bundle.mjs'
import { KEEPALIVE_STATE_SCHEMA_VERSION, hookSpoolPathFor, keepAliveStatePath, transcriptPathFor } from './watcher-keepalive.mjs'

/** The job intent (BGOS backend MACHINE_JOB_INTENTS, packet P1); `op: 'checkup'` is read the same. */
export const CHECKUP_INTENT = 'checkup'
/** The keep-alive record's `target` for a restart the check up spent (attempts count per target). */
export const CHECKUP_RESTART_TARGET = 'checkup'
/** How much of the transcript's end is read: the last turns, never the whole history. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024
/** A session cap always resets inside its 5 hour window; older, it says nothing about now. */
export const USAGE_LIMIT_FRESH_MS = 5 * 60 * 60_000
/** A weekly or monthly cap can hold for days. */
export const LONG_USAGE_LIMIT_FRESH_MS = 7 * 24 * 60 * 60_000
/** A keep-alive act still marked in flight after this long is a job past its deadline (C7). */
export const ACT_IN_FLIGHT_DEADLINE_MS = 20 * 60_000
/** The backend's caps (MachineRpcProgressDto, packet P1). */
export const CHECKUP_DETAIL_MAX = 400
export const MAX_CHECKUP_FINDINGS = 24
export const MAX_CHECKUP_ACTIONS = 24

const AGENT_ID_RE = /^\d{1,16}$/

function clip(value, max = CHECKUP_DETAIL_MAX) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) : text
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The physical path of a folder, which is how lsof and /proc report a process's cwd; as given when it cannot be resolved. */
function defaultRealpath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

function isoMs(value) {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

// -- The job ----------------------------------------------------------------------------------

/** Is this job body a check up? The backend sends op `reconcile` with intent `checkup`. */
export function isCheckupJob(job, op) {
  return op === CHECKUP_INTENT || job?.op === CHECKUP_INTENT || job?.intent === CHECKUP_INTENT
}

/**
 * The ONE agent a check up is about. Never the whole computer: no target, or several, is refused
 * by name (the same scope "Restart now" uses).
 * @returns {{ ok: true, assistantId: string } | { ok: false, message: string }}
 */
export function checkupTarget(job) {
  const ids = [...new Set((Array.isArray(job?.targets) ? job.targets : []).map((t) => validAssistantId(t?.assistantId ?? t)).filter(Boolean))]
  if (ids.length !== 1) return { ok: false, message: `checkup_needs_one_agent:${ids.length}` }
  return { ok: true, assistantId: ids[0] }
}

// -- The transcript tail ------------------------------------------------------------------------

/** The last `maxBytes` of a file, from its first whole line. fs.readTail when the fs has one. */
export function readTail(fs, path, maxBytes = TRANSCRIPT_TAIL_BYTES) {
  if (typeof fs.readTail === 'function') return fs.readTail(path, maxBytes)
  const text = fs.readFile(path)
  if (text == null || text.length <= maxBytes) return text
  const cut = text.slice(text.length - maxBytes)
  const nl = cut.indexOf('\n')
  return nl >= 0 ? cut.slice(nl + 1) : ''
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

const CHANNEL_OPEN = /^<channel((?:\s+[A-Za-z_][\w-]*="[^"]*")*)\s*>/
const CHANNEL_ATTR = /([A-Za-z_][\w-]*)="([^"]*)"/g
/** Lines lib/inbound-channel.ts puts on a message that is not the owner's (lib/session-library.ts). */
const NOT_OWNER_LINE = /^\s*\[(?:Peer message from agent|System message from BGOS|Email from outside HOAI)/

/** Is this user entry text an OWNER message the channel delivered (not an event, a peer, the system)? */
export function isOwnerChannelText(text) {
  const lead = String(text ?? '').trimStart()
  const open = CHANNEL_OPEN.exec(lead)
  if (!open) return false
  const attrs = {}
  for (const [, key, value] of open[1].matchAll(CHANNEL_ATTR)) attrs[key] = value
  if (attrs.event_type !== undefined || attrs.system === 'true') return false
  if (attrs.sender_type === 'agent' || attrs.sender_type === 'system' || attrs.sender_type === 'external_email') return false
  return !NOT_OWNER_LINE.test(lead.slice(open[0].length))
}

/**
 * What the end of a transcript says (the CLI's envelopes, measured in lib/claude-login.ts and
 * lib/resting.ts): the newest real assistant turn, the newest owner message, and the error the
 * session is in now. A real turn AFTER an error ends it (the login works, the cap lifted). A login
 * failure stays until proven otherwise; a cap older than its window says nothing about now.
 * @param {string | null} text
 * @param {number} now
 * @returns {{ lastActivityAtMs: number | null, ownerDeliveredAtMs: number | null,
 *   error: { kind: 'authentication_failed' | 'rate_limit', resetAt: string | null, atMs: number } | null }}
 */
export function parseTranscriptTail(text, now) {
  let lastActivityAtMs = null
  let ownerDeliveredAtMs = null
  let error = null
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isRecord(entry)) continue
    const at = isoMs(entry.timestamp)
    if (at === null) continue
    const message = isRecord(entry.message) ? entry.message : {}
    if (entry.type === 'user') {
      if (entry.isSidechain === true) continue
      if (isOwnerChannelText(contentText(message.content))) ownerDeliveredAtMs = Math.max(ownerDeliveredAtMs ?? at, at)
      continue
    }
    if (entry.type !== 'assistant') continue
    if (entry.isApiErrorMessage === true) {
      if (entry.error !== 'authentication_failed' && entry.error !== 'rate_limit') continue
      const words = contentText(message.content)
      const reset = /\bresets?\s+(?:at\s+)?(.+?)\s*$/i.exec(words.replace(/[\u0000-\u001f\u007f]/g, ' ').trim())
      error = { kind: entry.error, resetAt: reset ? clip(reset[1], 80) : null, atMs: at, long: /\b(?:weekly|monthly)\b/i.test(words) }
      continue
    }
    if (entry.isSidechain === true || message.model === '<synthetic>') continue
    lastActivityAtMs = Math.max(lastActivityAtMs ?? at, at)
    if (error && at >= error.atMs) error = null
  }
  if (error?.kind === 'rate_limit' && now - error.atMs > (error.long ? LONG_USAGE_LIMIT_FRESH_MS : USAGE_LIMIT_FRESH_MS)) error = null
  return { lastActivityAtMs, ownerDeliveredAtMs, error: error ? { kind: error.kind, resetAt: error.resetAt, atMs: error.atMs } : null }
}

// -- The install ----------------------------------------------------------------------------------

/**
 * The plugin this agent runs on: its config dir, the installed version and when it landed, the
 * marketplace's latest (local files only), and the CURRENT root a restart launches from.
 */
export async function observeInstall({ row, env, home, fs, modules, manifest, pluginRootOverride = null }) {
  const watcherConfig = claudeConfigDir({ env, home })
  const configDir = String(row.recipe?.claudeConfigDir ?? '').trim() || watcherConfig
  const rootHint = String(pluginRootOverride ?? '').trim() || manifest?.pluginRoot || row.recipe?.pluginRoot || null
  const marketplace = rootHint ? isUnderPluginsDir(rootHint, { env, home }) : true
  if (!marketplace) {
    return {
      configDir,
      installMethod: 'clone',
      pluginRoot: rootHint,
      installedVersion: rootHint ? readPluginVersion(rootHint, fs) : null,
      landedAtMs: rootHint ? fs.stat(joinRel(rootHint, 'package.json'))?.mtimeMs ?? null : null,
      publishedVersion: null,
    }
  }
  const record = parseInstalledPluginRecord(fs.readFile(installedPluginsPath(configDir)))
  let publishedVersion = null
  let observedRoot = null
  let observedVersion = null
  try {
    const readFile = (path) => {
      const text = fs.readFile(path)
      if (text == null) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return text
    }
    const seen = await modules.observeMarketplaceInstall({ configDir, readFile, exists: fs.exists })
    publishedVersion = seen?.marketplaceLatest?.version ?? null
    observedRoot = seen?.installed?.installPath ?? null
    observedVersion = seen?.installed?.version ?? null
  } catch {
    // the marketplace files are advisory here: no published version, no C6 from them
  }
  return {
    configDir,
    installMethod: 'marketplace',
    pluginRoot: record?.installPath || observedRoot || (configDir === watcherConfig ? rootHint : null),
    installedVersion: record?.version ?? observedVersion ?? null,
    landedAtMs: record?.lastUpdatedMs ?? null,
    publishedVersion,
  }
}

// -- The keep-alive record ------------------------------------------------------------------------

function readKeepAliveFile(home, fs) {
  try {
    const parsed = JSON.parse(fs.readFile(keepAliveStatePath(home)) ?? 'null')
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** This agent's keep-alive record (the sweep's), or null. */
export function readKeepAliveRecord(home, fs, id) {
  const agents = readKeepAliveFile(home, fs).agents
  const record = isRecord(agents) ? agents[id] : null
  return isRecord(record) ? record : null
}

/**
 * Write this agent's record back, every other agent and field as it was. The watcher runs one job
 * or one sweep at a time, so nothing writes this file between the read and the write.
 */
export function writeKeepAliveRecord(home, fs, id, record, now) {
  const doc = readKeepAliveFile(home, fs)
  const agents = isRecord(doc.agents) ? doc.agents : {}
  try {
    fs.writeFile(
      keepAliveStatePath(home),
      `${JSON.stringify({ ...doc, schemaVersion: KEEPALIVE_STATE_SCHEMA_VERSION, updatedAt: new Date(now).toISOString(), enabled: doc.enabled === true, agents: { ...agents, [id]: record } }, null, 2)}\n`,
    )
  } catch {
    // advisory, like the sweep's own write
  }
}

/** The record with one more checkup restart spent (before the act, so a crash still counts it). */
export function spendCheckupRestart(prev, now) {
  const sameTarget = prev?.target === CHECKUP_RESTART_TARGET
  const attempts = sameTarget && Number.isInteger(prev?.attempts) ? prev.attempts : 0
  return advanceAgentRecord(
    { ...(prev ?? {}), target: CHECKUP_RESTART_TARGET, attempts: attempts + 1, lastRestartAt: new Date(now).toISOString() },
    { state: 'restarted', reason: 'checkup_restarting' },
    now,
  )
}

// -- The observation --------------------------------------------------------------------------------

/**
 * One observation of the agent for checkupPass, plus what the job needs to act on it.
 * @param {{ row: Record<string, any>, install: Awaited<ReturnType<typeof observeInstall>>, home: string,
 *   env: Record<string, string | undefined>, platform: string, fs: any, exec: any, now: number,
 *   pidAlive: (pid: number) => boolean, uid: number | null, realpath?: (path: string) => string }} params
 */
export async function observeAgentForCheckup({ row, install, home, env, platform, fs, exec, now, pidAlive, uid, realpath }) {
  const id = row.assistantId
  const agentState = parseAgentState(fs.readFile(joinDir(row.pluginStateDir, AGENT_STATE_FILE_NAME)), id)
  const fresh = isAgentStateFresh(agentState, { now, pidAlive })
  const daemonPid = liveAgentDaemonPid(row, { fs, now, pidAlive })
  const sessionId = agentState?.sessionId || row.sessionId || null
  const transcriptPath = sessionId && row.cwd ? transcriptPathFor({ configDir: install.configDir, cwd: row.cwd, sessionId }) : null
  const activityMs = [
    agentState?.lastActivityAtMs ?? null,
    sessionId ? fs.stat(hookSpoolPathFor({ env, home, sessionId }))?.mtimeMs ?? null : null,
    transcriptPath ? fs.stat(transcriptPath)?.mtimeMs ?? null : null,
  ]

  // The process table: which claude is this agent's, and what runs under it.
  let claudeAlive = null
  let descendants = null
  const snap = await listProcesses({ platform, exec, env })
  if (!snap.ok) {
    claudeAlive = fresh ? true : null
  } else {
    const claudes = new Set(claudeCandidates(snap.processes).map((p) => p.pid))
    const pids = new Set()
    if (agentState?.claudePid && claudes.has(agentState.claudePid) && pidAlive(agentState.claudePid)) pids.add(agentState.claudePid)
    const above = daemonPid ? nearestClaudeAncestor(snap.processes, daemonPid) : null
    if (above) pids.add(above)
    if (row.keepalive && claudes.has(row.keepalive.claudePid)) pids.add(row.keepalive.claudePid)
    const found = findAgentClaudePids({
      processes: snap.processes,
      sessionIds: [row.sessionId, agentState?.sessionId],
      cwd: row.cwd,
      known: [{ pid: agentState?.claudePid, atMs: agentState?.updatedAtMs }],
    })
    for (const pid of found.pids) pids.add(pid)
    let unsure = found.unsure
    if (pids.size === 0 && row.cwd) {
      // A claude of ours whose folder only a cwd lookup can tell (a hand-run session).
      const mine = claudeCandidates(snap.processes).filter((p) => uid === null || p.uid == null || p.uid === uid)
      if (mine.length > 0) {
        const lookup = await readProcessCwds({ platform, exec, pids: mine.map((p) => p.pid) })
        for (const pid of findClaudePidsByCwd({ processes: mine, cwds: lookup.cwds, cwd: row.cwd, realpath: realpath ?? defaultRealpath })) pids.add(pid)
        if (pids.size === 0 && mine.some((p) => !lookup.cwds.has(p.pid) && pidAlive(p.pid))) unsure = true
      }
    }
    if (pids.size > 0) {
      claudeAlive = true
      descendants = [...pids].flatMap((pid) => descendantsOf(snap.processes, pid).map((p) => p.command))
    } else if (daemonPid !== null || unsure) {
      // A live daemon proves a session even when its claude is not visible above it: unknown, never
      // "dead" (the sweep's rule), so no start beside a session this watcher cannot see.
      claudeAlive = null
    } else if (activityMs.some((ms) => typeof ms === 'number' && now - ms < LEGACY_QUIET_WINDOW_MS && ms <= now + 60_000)) {
      // No claude visible but the session wrote moments ago: not provably stopped.
      claudeAlive = null
    } else {
      claudeAlive = false
      descendants = []
    }
  }

  const tail = transcriptPath ? parseTranscriptTail(readTail(fs, transcriptPath), now) : { lastActivityAtMs: null, ownerDeliveredAtMs: null, error: null }
  const launchOutcome = parseLaunchStatusOutcome(fs.readFile(joinDir(row.stateDir, LAUNCH_STATUS_FILE_NAME)))
  const beaconDir = String(row.liveMarkerPath ?? '').replace(/[\\/][^\\/]*$/, '') || row.pluginStateDir
  const beaconMs = fs.stat(joinDir(beaconDir, BEACON_HEARTBEAT_FILE_NAME))?.mtimeMs ?? null

  // C7: what an update left behind.
  let validationPendingSinceMs = null
  try {
    const autoPath = joinDir(row.pluginStateDir, 'auto-update.json')
    const auto = JSON.parse(fs.readFile(autoPath) ?? 'null')
    if (isRecord(auto) && auto.validationPending === true) {
      validationPendingSinceMs = typeof auto.validationBootStartedAt === 'number' ? auto.validationBootStartedAt : fs.stat(autoPath)?.mtimeMs ?? null
    }
  } catch {
    // unreadable: no evidence
  }
  const record = readKeepAliveRecord(home, fs, id)
  let jobDeadlineAtMs = null
  if (record?.reason === 'install_in_progress') jobDeadlineAtMs = (isoMs(record.lastInstallAt) ?? now) + ACT_IN_FLIGHT_DEADLINE_MS
  else if (record?.reason === 'restarting' || record?.reason === 'checkup_restarting') jobDeadlineAtMs = (isoMs(record.lastRestartAt) ?? now) + ACT_IN_FLIGHT_DEADLINE_MS
  const runningVersion = fresh ? agentState?.runningVersion ?? null : null
  const launchStartedMs = isoMs(parseLaunchRecipe(fs.readFile(joinDir(row.stateDir, LAUNCH_RECIPE_FILE_NAME)))?.startedAt)
  const stagedNeverApplied =
    runningVersion !== null &&
    install.installedVersion !== null &&
    compareVersions(runningVersion, install.installedVersion) < 0 &&
    typeof install.landedAtMs === 'number' &&
    launchStartedMs !== null &&
    launchStartedMs > install.landedAtMs

  const sameTarget = record?.target === CHECKUP_RESTART_TARGET
  const observation = {
    now,
    assistantId: id,
    claudeAlive,
    daemonAlive: daemonPid !== null,
    descendants,
    agentState,
    stateFresh: fresh,
    activityMs,
    beaconHeartbeatAtMs: beaconMs,
    launchStatus: launchOutcome ? { outcome: launchOutcome } : null,
    hasSupervisor: row.supervisor !== 'none' || Boolean(row.keepalive),
    hasLaunchRecipe: Boolean(row.recipe && row.cwd),
    messagesDeliveredAtMs: tail.ownerDeliveredAtMs,
    lastTranscriptActivityAtMs: tail.lastActivityAtMs,
    stuckScreen: claudeAlive === true && typeof launchOutcome === 'string' && launchOutcome.startsWith('gate-') ? launchOutcome.slice('gate-'.length) : null,
    runningVersion,
    installedVersion: install.installedVersion,
    publishedVersion: install.publishedVersion,
    // The backend's floor does not ride the job body yet (packet P4): unknown, never assumed.
    belowFloor: false,
    update: { jobDeadlineAtMs, validationPendingSinceMs, drainSinceMs: null, stagedNeverApplied },
    transcriptError: tail.error ? { kind: tail.error.kind, resetAt: tail.error.resetAt } : null,
    lastRestartAtMs: isoMs(record?.lastRestartAt),
    attempts: sameTarget && Number.isInteger(record?.attempts) ? record.attempts : 0,
  }
  return { observation, daemonPid, transcriptPath, record }
}

// -- The answer ---------------------------------------------------------------------------------------

/** The backend's cause token for a plan cause (C3 -> daemon_down ...). */
export function causeToken(cause) {
  return CAUSES[cause] ?? 'unknown_cause'
}

/** C6 and C9 are warnings (the agent still runs or comes back by itself); the rest fail. */
const WARN_CAUSES = new Set(['C6', 'C9'])

/**
 * The terminal report's findings: one per finding, with the owner's fix for what the watcher may
 * not fix (the report actions carry its words).
 */
export function wireFindings(findings, actions, assistantId) {
  const target = AGENT_ID_RE.test(String(assistantId)) ? String(assistantId) : undefined
  return findings.slice(0, MAX_CHECKUP_FINDINGS).map((f) => {
    const report = actions.find((a) => a.action === 'report' && a.causes.includes(f.cause) && a.code === f.code)
    const fix = report?.ownerAction?.text
    return {
      cause: causeToken(f.cause),
      ...(target ? { target } : {}),
      status: WARN_CAUSES.has(f.cause) ? 'WARN' : 'FAIL',
      detail: clip(f.evidence || f.code),
      ...(fix ? { fix: clip(fix) } : {}),
    }
  })
}

const HELD_WORDS = {
  turn_in_flight: 'it is in the middle of a turn',
  pending_messages: 'messages are on their way to it',
  pending_permission: 'it is waiting for a permission answer',
  background_job: 'a background job is running under it',
  recent_activity: 'it was active in the last minutes',
  process_tree_unreadable: 'its processes could not be read',
  restart_rate_limited: 'it was restarted less than 30 minutes ago',
  attempts_exhausted: 'three restarts did not bring it back',
  blocked_by_login: 'a restart cannot sign it back in',
  blocked_by_usage_limit: 'a restart cannot lift the usage limit',
  launch_failed: 'its last start failed and said why',
  needs_first_launch: 'it has never been started on this computer',
  update_not_applied: 'the update it needed did not land',
  pass_deadline: 'the check up ran out of time',
}

/** Why a restart was held, in words, with the reason token kept for the app and the logs. */
export function heldDetail(reason, state) {
  const words = HELD_WORDS[reason] ?? 'a safety rule held it'
  if (state === 'waiting_idle' && reason !== 'restart_rate_limited') return clip(`It looks busy (${reason}: ${words}); I did not interrupt it.`)
  return clip(`Not restarted (${reason}: ${words}).`)
}
