/**
 * watcher-keepalive: the watcher's keep-alive sweep (design section 5), the part
 * of "Keep agents running" that runs on the computer.
 *
 * Once a minute, right after the heartbeat, and only while the computer's switch
 * is ON:
 *
 *   consent   GET /integrations/watchers/keep-alive (pairing auth) answers
 *             {enabled, enabledAt, assistantIds}. Cached in
 *             ~/.bgos-agent/watcher/keepalive.json; a failure (a 404 before the
 *             backend ships included) uses a cache younger than 24 h, else the
 *             sweep is OFF. Only cleared ids are touched (the G3 fix: the backend
 *             marks an agent always-on BEFORE the watcher supervises it, so its
 *             own daemon never removes the new supervisor).
 *   per agent, in ascending id order (lib/keepalive-plan.mjs decides, this runs):
 *     1 supervise  `none` + a known folder: install the product supervisor from
 *                  the CURRENT plugin root (`bash <root>/bin/bgos-agent install
 *                  --assistant <id> --dir <cwd> --always-on --no-clone`, or the
 *                  Windows agent task), only when that root carries it (a v2
 *                  bgos-agent; a hoai-core with --keep-alive on win32), else
 *                  supervisor_v2_unavailable. An agent running by hand is not touched:
 *                  run.sh's singleton wait takes over when it ends (D4). No
 *                  folder: needs_first_launch. A failed install: retried hourly.
 *     2 pending    upgrade_pending (canonical generation 1 supervisor) or
 *                  update_pending (running version != installed; legacy: claude
 *                  started before the install landed).
 *     3 safe       the design 6 table from agent-state.json, the process tree
 *                  (lib/process-tree.mjs) and the activity mtimes. Unsafe:
 *                  waiting_idle with the reason, and NEVER a kill (finding 9).
 *                  Safe: restart through the strongest authority
 *                  (lib/agent-restart.mjs: marker, keepalive, service, recipe) or
 *                  reinstall for an upgrade, then verify with the boot hello
 *                  probe (lib/agent-verify.mjs). An update for a plain hand-run
 *                  claude the canonical supervisor waits behind (run.sh's
 *                  fresh waiting-for-incumbent) is waiting_idle manual_session,
 *                  no attempt: it lands when that session ends (D4).
 *   gates     one restart per sweep, one per agent per 30 min, 3 attempts per
 *             target then `failed`, one install per sweep; the same limits for
 *             a Windows task start (per launcher death episode, which ends once
 *             the launcher has stayed alive 10 min).
 *   state     ~/.bgos-agent/watcher/keepalive-state.json, and the per agent
 *             entries the next heartbeat carries (env.watcherHealth.keepAlive).
 *
 * Every effect is injected (fs, exec, execSync, spawnDetached, kill, clock,
 * the backend fetch). Never throws: one agent's failure is that agent's
 * `failed` row, never the sweep's. Plain JavaScript, node >= 18, import-safe.
 */

import { claudeConfigDir, installedPluginsPath, isUnderPluginsDir } from '../bin/bgos-install-method.mjs'
import { defaultExecSync } from './service-supervision.mjs'
import { joinDir, listAgents, pluginStateRoot } from './agent-inventory.mjs'
import { envForRecipe, restartAgent } from './agent-restart.mjs'
import { agentTaskSpec, installAgentTask } from './agent-task-win32.mjs'
import { verifyAgent } from './agent-verify.mjs'
import {
  AGENT_STATE_FILE_NAME,
  LAUNCH_STATUS_FILE_NAME,
  LEGACY_QUIET_WINDOW_MS,
  REPORT_STRING_MAX,
  advanceAgentRecord,
  advanceLauncherEpisode,
  buildKeepAliveCache,
  decideInstallGate,
  decideKeepAliveConsent,
  decideManualSession,
  decidePendingRestart,
  decideRestartBudget,
  decideRestartGate,
  decideSafeMoment,
  decideSupervise,
  decideTaskStart,
  decideTaskStartGate,
  isAgentStateFresh,
  parseAgentState,
  parseInstalledPluginRecord,
  parseKeepAliveCache,
  parseKeepAliveResponse,
  parseLaunchStatusOutcome,
  reportEntry,
} from './keepalive-plan.mjs'
import { claudeCandidates, descendantsOf, findClaudePidsByCwd, listProcesses, readProcessCwds } from './process-tree.mjs'
import { joinRel, readPluginVersion, watcherHome } from './watcher-bundle.mjs'

export const KEEPALIVE_CACHE_FILE_NAME = 'keepalive.json'
export const KEEPALIVE_STATE_FILE_NAME = 'keepalive-state.json'
export const KEEPALIVE_STATE_SCHEMA_VERSION = 1
/** bgos-agent install runs `bun install`; ten minutes is generous, not unbounded. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000
/** The backend bounds the heartbeat list (design 8). */
export const REPORT_MAX_AGENTS = 64
export const KEEPALIVE_ENDPOINT = 'integrations/watchers/keep-alive'

export function keepAliveCachePath(home) {
  return joinDir(watcherHome(home), KEEPALIVE_CACHE_FILE_NAME)
}

export function keepAliveStatePath(home) {
  return joinDir(watcherHome(home), KEEPALIVE_STATE_FILE_NAME)
}

// -- Small helpers ---------------------------------------------------------------------

function firstLine(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? ''
}

function msOf(value) {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function iso(ms) {
  return new Date(ms).toISOString()
}

/** Claude Code's project dir munge (mirror of bin/hoai-core.mjs mungeSessionCwd). */
export function mungeCwd(cwd) {
  return String(cwd ?? '').replace(/[^a-zA-Z0-9]/g, '-')
}

/** Where a session's transcript lives (mirror of bin/hoai-core.mjs sessionTranscriptPath). */
export function transcriptPathFor({ configDir, cwd, sessionId }) {
  return joinDir(joinDir(joinDir(configDir, 'projects'), mungeCwd(cwd)), `${sessionId}.jsonl`)
}

/** The hook spool of a session (mirror of bin/hoai-hook.mjs spoolPath for a UUID id). */
export function hookSpoolPathFor({ env, home, sessionId }) {
  return joinDir(joinDir(joinDir(pluginStateRoot({ env, home }), 'hooks'), sessionId), 'events.jsonl')
}

/** The text only a v2 bin/bgos-agent carries: it stamps <statedir>/supervisor-generation. */
export const SUPERVISOR_V2_MARKER = 'supervisor-generation'

/**
 * Is the bgos-agent at this plugin root the v2 product supervisor (hoai in tmux,
 * resuming the pinned session)? A v1 script installs run.expect, which starts a
 * FRESH session on every restart (finding 7) and has no tmux, so no remote
 * compact (finding 8): installing or reinstalling with it would make the very
 * restart this sweep exists for lose the conversation. The watcher bundle and
 * bgos-agent ship in one release, so this only bites a mismatched install.
 */
export function supervisorV2At(pluginRoot, fs) {
  if (!pluginRoot) return false
  return String(fs.readFile(joinRel(pluginRoot, 'bin/bgos-agent')) ?? '').includes(SUPERVISOR_V2_MARKER)
}

/** The text only a hoai-core that understands --keep-alive carries (its
 *  RUN_KEEP_ALIVE_FLAGS); an older one never mentions the flag at all. */
export const KEEP_ALIVE_LAUNCHER_MARKER = '--keep-alive'

/**
 * Is the hoai-core at this plugin root one the Windows agent task can run?
 * The task's vbs starts `hoai-core.mjs --keep-alive`; an older hoai-core has no
 * such flag, so it would launch claude once and return (no relaunch, no pinned
 * resume after a crash), and the task would read as supervision that is not
 * there. The win32 twin of supervisorV2At, checked before any task is
 * registered, started, or repointed at this root.
 */
export function keepAliveLauncherAt(pluginRoot, fs) {
  if (!pluginRoot) return false
  return String(fs.readFile(joinRel(pluginRoot, 'bin/hoai-core.mjs')) ?? '').includes(KEEP_ALIVE_LAUNCHER_MARKER)
}

/** The product supervisor this platform installs is available at this root. */
function productSupervisorAt(platform, pluginRoot, fs) {
  return platform === 'win32' ? keepAliveLauncherAt(pluginRoot, fs) : supervisorV2At(pluginRoot, fs)
}

/** The supervise / upgrade command: bin/bgos-agent from the CURRENT plugin root. */
export function supervisorInstallCommand({ pluginRoot, assistantId, cwd }) {
  return {
    file: 'bash',
    args: [joinRel(pluginRoot, 'bin/bgos-agent'), 'install', '--assistant', String(assistantId), '--dir', String(cwd), '--always-on', '--no-clone'],
  }
}

// -- Persisted state ---------------------------------------------------------------------

function readStateFile(home, fs) {
  let parsed = null
  try {
    parsed = JSON.parse(fs.readFile(keepAliveStatePath(home)) ?? 'null')
  } catch {
    parsed = null
  }
  const agents = parsed && typeof parsed === 'object' && parsed.agents && typeof parsed.agents === 'object' && !Array.isArray(parsed.agents) ? parsed.agents : {}
  return {
    enabled: parsed?.enabled === true,
    consentSource: typeof parsed?.consentSource === 'string' ? parsed.consentSource : null,
    agents,
  }
}

function writeStateFile(home, fs, body, now) {
  try {
    fs.writeFile(
      keepAliveStatePath(home),
      `${JSON.stringify({ schemaVersion: KEEPALIVE_STATE_SCHEMA_VERSION, updatedAt: iso(now), ...body }, null, 2)}\n`,
    )
  } catch {
    // The state is advisory: the next sweep recomputes every decision from disk.
  }
}

/**
 * The heartbeat's keepAlive block from the persisted state: {enabled, agents},
 * ascending ids, at most 64 entries (design 8 bound).
 * @param {{ home: string, fs: import('./watcher-bundle.mjs').WatcherFs, now: number }} params
 */
export function readKeepAliveReport({ home, fs, now }) {
  const state = readStateFile(home, fs)
  const ids = Object.keys(state.agents).filter((id) => /^\d+$/.test(id)).sort((a, b) => Number(a) - Number(b))
  return {
    enabled: state.enabled,
    agents: ids.slice(0, REPORT_MAX_AGENTS).map((id) => reportEntry(id, state.agents[id], now)),
  }
}

// -- Consent -------------------------------------------------------------------------------

/**
 * Ask the backend, cache a good answer, fall back to a fresh cache.
 * @returns {Promise<ReturnType<typeof decideKeepAliveConsent> & { status: number | null }>}
 */
export async function fetchKeepAliveConsent({ fetchKeepAlive, fs, home, now }) {
  let live = null
  let status = null
  try {
    const res = await fetchKeepAlive()
    status = Number(res?.status ?? 0)
    if (res?.ok) live = parseKeepAliveResponse(res.json)
  } catch {
    live = null
  }
  if (live) {
    try {
      fs.writeFile(keepAliveCachePath(home), buildKeepAliveCache(live, now))
    } catch {
      // A cache that cannot be written only shortens how long a later outage is bridged.
    }
  }
  const cache = live ? null : parseKeepAliveCache(fs.readFile(keepAliveCachePath(home)))
  return { ...decideKeepAliveConsent({ live, cache, now }), status }
}

// -- The sweep -------------------------------------------------------------------------------

/**
 * @param {{
 *   home: string, env: Record<string, string | undefined>, platform: string,
 *   fs: import('./watcher-bundle.mjs').WatcherFs, exec: import('./watcher-bundle.mjs').Exec,
 *   execSync?: (file: string, args: string[]) => { code: number, stdout: string },
 *   spawnDetached: import('./watcher-bundle.mjs').SpawnDetached, kill?: (pid: number, signal: string) => unknown,
 *   now: () => number, sleep: (ms: number) => Promise<unknown>, log?: (line: string) => void,
 *   scrub?: (text: string) => string, pidAlive: (pid: number) => boolean, nodePath: string,
 *   uid: number | null, manifest: { pluginRoot?: string | null } | null, pluginRootOverride?: string | null,
 *   fetchKeepAlive: () => Promise<{ ok: boolean, status: number, json: any }>,
 *   hasTmux?: boolean, hasScript?: boolean, hasCommand?: (name: string) => boolean, verifyTimeoutMs?: number,
 * }} ctx
 * @returns {Promise<{ enabled: boolean, source: string, agents: Array<Record<string, string>> }>}
 */
export async function runKeepAliveSweep(ctx) {
  const { home, env, platform, fs, exec, now, pidAlive } = ctx
  const log = ctx.log ?? (() => {})
  const scrub = ctx.scrub ?? ((text) => text)
  const execSync = ctx.execSync ?? defaultExecSync
  const prior = readStateFile(home, fs)

  const consent = await fetchKeepAliveConsent({ fetchKeepAlive: ctx.fetchKeepAlive, fs, home, now: now() })
  if (consent.source !== prior.consentSource || consent.enabled !== prior.enabled) {
    log(
      `keep-alive: ${consent.enabled ? 'ON' : 'off'} (source ${consent.source}${consent.status != null ? `, status ${consent.status}` : ''}, ${consent.assistantIds.length} cleared)`,
    )
  }
  if (!consent.enabled) {
    // Never act when the switch is off (decision D2): agents and their supervisors stay as they are.
    writeStateFile(home, fs, { enabled: false, consentSource: consent.source, agents: prior.agents }, now())
    return { enabled: false, source: consent.source, agents: [] }
  }
  const cleared = new Set(consent.assistantIds)

  const rows = listAgents({ home, env, platform, fs, pidAlive, execSync }).filter((row) => cleared.has(row.assistantId))
  const watcherConfigDir = claudeConfigDir({ env, home })
  const rootHint = String(ctx.pluginRootOverride ?? '').trim() || ctx.manifest?.pluginRoot || null

  // The installed plugin per Claude config dir: version, CURRENT root, when it
  // landed. Marketplace or clone is a property of the machine's install (the
  // root the watcher bundle came from), decided once; an agent with its own
  // CLAUDE_CONFIG_DIR then reads ITS installed_plugins.json, never ours.
  const machineMarketplace = rootHint ? isUnderPluginsDir(rootHint, { env, home }) : true
  const installedByConfig = new Map()
  const installedFor = (row) => {
    const configDir = String(row.recipe?.claudeConfigDir ?? '').trim() || watcherConfigDir
    if (installedByConfig.has(configDir)) return installedByConfig.get(configDir)
    let info
    if (machineMarketplace) {
      const record = parseInstalledPluginRecord(fs.readFile(installedPluginsPath(configDir)))
      info = {
        configDir,
        pluginRoot: record?.installPath || (configDir === watcherConfigDir ? rootHint : null),
        version: record?.version ?? null,
        landedAtMs: record?.lastUpdatedMs ?? null,
      }
    } else {
      info = {
        configDir,
        pluginRoot: rootHint,
        version: rootHint ? readPluginVersion(rootHint, fs) : null,
        landedAtMs: rootHint ? fs.stat(joinDir(rootHint, 'package.json'))?.mtimeMs ?? null : null,
      }
    }
    installedByConfig.set(configDir, info)
    return info
  }

  // One process listing and one cwd lookup per sweep, only when some agent needs them.
  let processesPromise = null
  const processes = () => (processesPromise ??= listProcesses({ platform, exec, env }))
  let cwdsPromise = null
  const claudeCwds = async () => {
    if (!cwdsPromise) {
      cwdsPromise = (async () => {
        const snap = await processes()
        if (!snap.ok) return new Map()
        return readProcessCwds({ platform, exec, pids: claudeCandidates(snap.processes).map((p) => p.pid) })
      })()
    }
    return cwdsPromise
  }

  const activityFor = (row, agentState) => {
    const stamps = [agentState?.lastActivityAtMs ?? null]
    const sessionId = agentState?.sessionId || row.sessionId
    if (sessionId) {
      stamps.push(fs.stat(hookSpoolPathFor({ env, home, sessionId }))?.mtimeMs ?? null)
      if (row.cwd) stamps.push(fs.stat(transcriptPathFor({ configDir: installedFor(row).configDir, cwd: row.cwd, sessionId }))?.mtimeMs ?? null)
    }
    return stamps
  }
  const recentlyActive = (stamps) => stamps.some((ms) => typeof ms === 'number' && now() - ms < LEGACY_QUIET_WINDOW_MS)

  /** Is the agent running, which claude is it, what runs under it. */
  const observe = async (row, agentState, fresh) => {
    const activityMs = activityFor(row, agentState)
    const snap = await processes()
    if (!snap.ok) {
      return { running: fresh ? true : null, descendants: null, startedAtMs: null, activityMs, treeError: snap.error }
    }
    // Only a pid that is still a claude counts: a stale state's claudePid may
    // have been reused by an unrelated process since.
    const claudes = new Set(claudeCandidates(snap.processes).map((p) => p.pid))
    const pids = new Set()
    if (agentState?.claudePid && claudes.has(agentState.claudePid) && pidAlive(agentState.claudePid)) pids.add(agentState.claudePid)
    if (row.keepalive && claudes.has(row.keepalive.claudePid)) pids.add(row.keepalive.claudePid)
    if (pids.size === 0 && row.cwd) {
      for (const pid of findClaudePidsByCwd({ processes: snap.processes, cwds: await claudeCwds(), cwd: row.cwd })) pids.add(pid)
    }
    if (pids.size === 0) {
      // A fresh state proves the agent runs, yet its claude is not visible:
      // its descendants cannot be checked, which is unreadable, never "no job".
      if (fresh) return { running: true, descendants: null, startedAtMs: null, activityMs }
      // No claude seen and no state: stopped, unless it was active recently.
      // A session this watcher cannot see (another folder spelling, win32)
      // must not be read as stopped while it is still talking.
      return { running: recentlyActive(activityMs) ? true : false, descendants: [], startedAtMs: null, activityMs }
    }
    const starts = snap.processes.filter((p) => pids.has(p.pid)).map((p) => p.startedAtMs).filter((ms) => typeof ms === 'number')
    const descendants = [...pids].flatMap((pid) => descendantsOf(snap.processes, pid).map((p) => p.command))
    return { running: true, descendants, startedAtMs: starts.length ? Math.min(...starts) : null, activityMs }
  }

  /** run.sh's singleton wait, fresh, behind a claude no launcher of ours relaunches (D4). */
  const waitingBehindManualSession = (row) => {
    const path = joinDir(row.stateDir, LAUNCH_STATUS_FILE_NAME)
    const mtimeMs = fs.stat(path)?.mtimeMs
    return decideManualSession({
      canonical: row.service?.via === 'canonical-file' && row.service?.kind !== 'schtasks',
      launcherLive: Boolean(row.launcherLive),
      keepaliveVerified: Boolean(row.keepalive),
      statusOutcome: parseLaunchStatusOutcome(fs.readFile(path)),
      statusAgeMs: typeof mtimeMs === 'number' ? now() - mtimeMs : null,
    })
  }

  let restartsThisSweep = 0
  let installsThisSweep = 0
  const reason = (text) => scrub(String(text ?? '')).replace(/\s+/g, ' ').trim().slice(0, REPORT_STRING_MAX)

  const installSupervisor = async (row) => {
    const root = installedFor(row).pluginRoot
    if (!root) return { ok: false, message: 'plugin_root_unknown' }
    if (platform === 'win32') {
      let spec
      try {
        spec = agentTaskSpec({ assistantId: row.assistantId, home, nodePath: ctx.nodePath, pluginRoot: root, cwd: row.cwd })
      } catch (err) {
        return { ok: false, message: String(err?.message ?? err) }
      }
      // Started now only when nothing says the agent runs: no cwd lookup on
      // win32, so a fresh state or recent activity counts as "maybe running".
      const agentState = parseAgentState(fs.readFile(joinDir(row.pluginStateDir, AGENT_STATE_FILE_NAME)), row.assistantId)
      const maybeRunning = isAgentStateFresh(agentState, { now: now(), pidAlive }) || recentlyActive(activityFor(row, agentState))
      return installAgentTask(spec, { exec, fs, start: !maybeRunning })
    }
    const cmd = supervisorInstallCommand({ pluginRoot: root, assistantId: row.assistantId, cwd: row.cwd })
    const res = await exec(cmd.file, cmd.args, { cwd: home, env: row.recipe ? envForRecipe(env, row.recipe) : env, timeoutMs: INSTALL_TIMEOUT_MS })
    if (res?.code === 0) return { ok: true, message: 'installed' }
    const detail = firstLine(res?.stderr) || firstLine(res?.stdout) || String(res?.error ?? '') || 'no output'
    return { ok: false, message: `bgos-agent install rc ${res?.code ?? 'null'}${res?.timedOut ? ' (timed out)' : ''}: ${detail}` }
  }

  /** Keep a Windows task's launcher on the CURRENT plugin root (a marketplace update moves it). */
  const refreshTaskLauncher = (row) => {
    const root = installedFor(row).pluginRoot
    if (!root || !row.cwd) return
    try {
      const spec = agentTaskSpec({ assistantId: row.assistantId, home, nodePath: ctx.nodePath, pluginRoot: root, cwd: row.cwd })
      const launcher = spec.files[0]
      if (fs.readFile(launcher.path) !== launcher.content) {
        fs.writeFile(launcher.path, launcher.content)
        log(`keep-alive ${row.assistantId}: task launcher now points at ${root}`)
      }
    } catch (err) {
      log(`keep-alive ${row.assistantId}: task launcher not refreshed: ${String(err?.message ?? err)}`)
    }
  }

  const evaluate = async (row, prev) => {
    const id = row.assistantId
    const sup = decideSupervise({
      cleared: true,
      supervisor: row.supervisor,
      serviceVia: row.service?.via ?? null,
      keepaliveVerified: Boolean(row.keepalive),
      keepaliveDeclared: Boolean(row.keepaliveDeclared),
      cwd: row.cwd,
    })
    if (sup.action === 'install') {
      if (!productSupervisorAt(platform, installedFor(row).pluginRoot, fs)) {
        return advanceAgentRecord(prev, { state: 'failed', reason: 'supervisor_v2_unavailable' }, now())
      }
      const gate = decideInstallGate({ now: now(), lastInstallAtMs: msOf(prev?.lastInstallAt), lastInstallError: prev?.lastInstallError ?? null, installsThisSweep })
      if (!gate.allowed) return advanceAgentRecord(prev, { state: gate.state, reason: gate.reason }, now())
      installsThisSweep += 1
      const result = await installSupervisor(row)
      const lastInstallError = result.ok ? null : reason(`install_failed:${result.message}`)
      log(`keep-alive ${id}: supervisor install ${result.ok ? 'ok' : `FAILED (${lastInstallError})`}`)
      const rec = { ...(prev ?? {}), lastInstallAt: iso(now()), lastInstallError }
      return advanceAgentRecord(rec, result.ok ? { state: 'installing', reason: 'installed' } : { state: 'failed', reason: lastInstallError }, now())
    }
    if (sup.state !== 'supervised') return advanceAgentRecord(prev, { state: sup.state, reason: sup.reason }, now())

    const agentState = parseAgentState(fs.readFile(joinDir(row.pluginStateDir, AGENT_STATE_FILE_NAME)), id)
    const fresh = isAgentStateFresh(agentState, { now: now(), pidAlive })
    const installed = installedFor(row)
    const windowsTask = platform === 'win32' && row.service?.kind === 'schtasks'
    let probe = null

    if (windowsTask) {
      // Which launcher death episode this is, carried on the record: the task
      // starts below are limited per episode, like restarts per target.
      prev = { ...(prev ?? {}), ...advanceLauncherEpisode(prev, { launcherLive: Boolean(row.launcherLive), now: now() }) }
      // The task runs `hoai-core --keep-alive` from the CURRENT root; a root
      // whose hoai-core lacks the flag is never pointed at, and a dead launcher
      // is never started onto it (here or by an update's schtasks /Run below).
      const launcherOk = keepAliveLauncherAt(installed.pluginRoot, fs)
      if (launcherOk) refreshTaskLauncher(row)
      else if (!row.launcherLive) return advanceAgentRecord(prev, { state: 'failed', reason: 'supervisor_v2_unavailable' }, now())
      if (!row.launcherLive) {
        const activity = activityFor(row, agentState)
        const start = decideTaskStart({
          platform,
          canonicalTask: true,
          launcherLive: Boolean(row.launcherLive),
          running: fresh ? true : false,
          recentActivity: recentlyActive(activity),
        })
        if (start) {
          // A start IS this platform's restart, so it gets the restart limits:
          // without them a launcher that cannot stay up was started every sweep.
          const gate = decideTaskStartGate({ now: now(), lastTaskStartAtMs: msOf(prev.lastTaskStartAt), taskStarts: prev.taskStarts })
          if (!gate.allowed) return advanceAgentRecord(prev, { state: gate.state, reason: gate.reason }, now())
          // Counted before the start, so a throw still counts.
          const acted = { ...prev, taskStarts: prev.taskStarts + 1, lastTaskStartAt: iso(now()) }
          // The restart ladder's task tier: schtasks /Run /TN "HOAI Agent <id>".
          const ran = await restartAgent(row, { platform, fs, exec, spawnDetached: ctx.spawnDetached, now, env, uid: ctx.uid })
          log(`keep-alive ${id}: launcher dead, task start ${acted.taskStarts} ${ran.ok ? 'ok' : `FAILED (${ran.message})`}`)
          return advanceAgentRecord(acted, ran.ok ? { state: 'supervised', reason: 'task_started' } : { state: 'failed', reason: reason(`task_start_failed:${ran.message}`) }, now())
        }
      }
    }

    // A daemon that publishes no state is judged by its claude's start time.
    if (!fresh) probe = await observe(row, agentState, fresh)
    const pending = decidePendingRestart({
      canonical: row.service?.via === 'canonical-file' && row.service?.kind !== 'schtasks',
      generation: row.supervisorGeneration ?? null,
      stateFresh: fresh,
      runningVersion: agentState?.runningVersion ?? null,
      pendingRestartVersion: agentState?.pendingRestartVersion ?? null,
      installedVersion: installed.version,
      claudeStartedAtMs: probe?.startedAtMs ?? null,
      installLandedAtMs: installed.landedAtMs,
    })
    if (!pending) return advanceAgentRecord(prev, { state: 'supervised', reason: sup.reason }, now())

    if (pending.kind === 'upgrade_pending' && !supervisorV2At(installed.pluginRoot, fs)) {
      return advanceAgentRecord(prev, { state: 'upgrade_pending', reason: 'supervisor_v2_unavailable' }, now())
    }
    // An upgrade is a reinstall, which needs the folder; without one it is
    // reported, and spends neither an attempt nor this sweep's one restart.
    if (pending.kind === 'upgrade_pending' && !row.cwd) {
      return advanceAgentRecord(prev, { state: 'upgrade_pending', reason: 'no_known_folder' }, now())
    }
    const sameTarget = prev?.target === pending.target
    const attempts = sameTarget && Number.isInteger(prev?.attempts) ? prev.attempts : 0
    const base = { ...(prev ?? {}), target: pending.target, attempts }
    // D4: a person's own claude that the canonical supervisor waits behind has
    // no launcher of ours to restart it, so the update waits for that session
    // to end (run.sh then takes over on the installed version) and spends no
    // attempt. An UPGRADE still goes ahead at a safe moment: reinstalling the
    // waiting supervisor never touches the person's session, and it makes the
    // takeover a generation 2 one (resuming the pin) instead of a fresh one.
    if (pending.kind === 'update_pending' && waitingBehindManualSession(row)) {
      return advanceAgentRecord(base, { state: 'waiting_idle', reason: 'manual_session' }, now())
    }
    // G11: a keepalive that is declared but not verified (its claude between
    // two relaunches, or its marker not yet naming the new one) still owns the
    // restart, and an unverified marker never aims a SIGTERM. Every other tier
    // would race its loop (a service kick orphans its tmux claude, a recipe
    // launch starts a second session), so the update waits for it to verify.
    if (pending.kind === 'update_pending' && row.keepaliveDeclared && !row.keepalive) {
      return advanceAgentRecord(base, { state: pending.kind, reason: 'keepalive_unverified' }, now())
    }
    // The agent's own limits first, whatever it is doing right now: a spent
    // target stays `failed`, it does not flip back to waiting_idle while busy.
    const budget = decideRestartBudget({ now: now(), lastRestartAtMs: msOf(prev?.lastRestartAt), attempts, pendingKind: pending.kind })
    if (!budget.allowed) return advanceAgentRecord(base, { state: budget.state, reason: budget.reason }, now())
    probe = probe ?? (await observe(row, agentState, fresh))
    const safe = decideSafeMoment({ running: probe.running, stateFresh: fresh, state: agentState, descendants: probe.descendants, activityMs: probe.activityMs, now: now() })
    if (!safe.safe) return advanceAgentRecord(base, { state: 'waiting_idle', reason: safe.reason }, now())
    const gate = decideRestartGate({ now: now(), lastRestartAtMs: msOf(prev?.lastRestartAt), attempts, restartsThisSweep, pendingKind: pending.kind })
    if (!gate.allowed) return advanceAgentRecord(base, { state: gate.state, reason: gate.reason }, now())

    // Act: at most one per sweep, counted before the attempt so a throw still counts.
    restartsThisSweep += 1
    const restartedAtMs = now()
    const acted = { ...base, attempts: attempts + 1, lastRestartAt: iso(restartedAtMs) }
    let how
    if (pending.kind === 'upgrade_pending') {
      const result = await installSupervisor(row)
      log(`keep-alive ${id}: ${pending.reason}, reinstall ${result.ok ? 'ok' : `FAILED (${result.message})`}`)
      if (!result.ok) return advanceAgentRecord(acted, { state: 'failed', reason: reason(`reinstall_failed:${result.message}`) }, now())
      how = 'reinstall'
    } else {
      const out = await restartAgent(row, {
        platform,
        pluginRoot: installed.pluginRoot,
        nodePath: ctx.nodePath,
        fs,
        exec,
        spawnDetached: ctx.spawnDetached,
        now,
        env,
        uid: ctx.uid,
        hasTmux: ctx.hasTmux,
        hasScript: ctx.hasScript,
        hasCommand: ctx.hasCommand,
        kill: ctx.kill,
      })
      log(`keep-alive ${id}: ${pending.reason} (target ${pending.target}), restart via ${out.how} ${out.ok ? 'ok' : `FAILED (${out.message})`}`)
      if (!out.ok) return advanceAgentRecord(acted, { state: 'failed', reason: reason(`restart_failed:${out.message}`) }, now())
      how = out.how
    }
    const verified = await verifyAgent(row, { restartedAtMs, fs, now, sleep: ctx.sleep, timeoutMs: ctx.verifyTimeoutMs, requestProbe: true, log })
    log(`keep-alive ${id}: verify ${verified.ok ? 'live' : `FAILED (${verified.message})`}`)
    return advanceAgentRecord(acted, verified.ok ? { state: 'restarted', reason: how } : { state: 'failed', reason: reason(verified.message) }, now())
  }

  const next = {}
  for (const row of rows) {
    const prev = prior.agents[row.assistantId] ?? null
    let record
    try {
      record = await evaluate(row, prev)
    } catch (err) {
      record = advanceAgentRecord(prev, { state: 'failed', reason: reason(`internal_error:${String(err?.message ?? err)}`) }, now())
    }
    if (prev?.state !== record.state || prev?.reason !== record.reason) {
      log(`keep-alive ${row.assistantId}: ${record.state}${record.reason ? ` (${record.reason})` : ''}`)
    }
    next[row.assistantId] = record
  }
  writeStateFile(home, fs, { enabled: true, consentSource: consent.source, agents: next }, now())
  const at = now()
  return {
    enabled: true,
    source: consent.source,
    agents: Object.keys(next)
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, REPORT_MAX_AGENTS)
      .map((id) => reportEntry(id, next[id], at)),
  }
}
