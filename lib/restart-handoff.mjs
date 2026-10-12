/**
 * restart-handoff: the helper that carries out a restart-marker takeover
 * (Windows). The daemon (lib/marker-takeover.mjs) spawns it detached and hidden
 * through bin/hoai-restart-handoff.mjs once its hoai launcher left a fresh
 * restart-requested.json unanswered (the launcher's 3-per-hour budget latch,
 * bin/hoai-core.mjs:2228/:2293/:2295-2299).
 *
 * It is the ONLY actor, and it changes nothing until every check has passed:
 *   1. one helper per agent: an O_EXCL restart-handoff.lock;
 *   2. the loop guard again, under that lock (restart-takeovers.json, the
 *      launcher's own 3 per rolling hour);
 *   3. one hidden process listing, and the chain daemon -> claude -> launcher:
 *      the launcher supervisor.json names must be claude's parent (or its
 *      grandparent through the cmd.exe of an npm claude.cmd), run hoai-core.mjs
 *      and be the writer of supervisor.json; no other claude carries the pin;
 *   4. the way back is planned from the same inventory row it will restart
 *      with: the launcher itself when it is --keep-alive (the "HOAI Agent
 *      <id>" task is one), else that task when it is registered for this
 *      folder, else the hidden recipe launch. No way back, nothing is touched.
 * Then: claim a stranded marker (atomic rename), record the takeover, check
 * claude's creation time and the daemon's pairing lock once more, end claude
 * (TerminateProcess, what the launcher's own restart does), wait for claude,
 * the daemon and the launcher to let go, settle, and start the agent through
 * the unchanged restart ladder (lib/agent-restart.mjs restartAgent), handing it
 * a filesystem that cannot write a restart marker. Every route resumes the
 * agent's pinned session: hoai-core reads ~/.bgos-agent/<id>/session-id.
 *
 * It never starts anything while a launcher or a daemon of the agent is live,
 * never loops, and exits after at most about nine minutes.
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe; every effect is
 * injected (tests drive it over a fake process world).
 */

import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'

import { MAX_RELAUNCHES_PER_WINDOW, RESTART_MARKER_FILE_NAME } from '../bin/hoai-core.mjs'
import {
  SUPERVISOR_FILE_NAME,
  AGENT_TASK_LAUNCHER_FILE_NAME,
  isSupervisorWriter,
  joinDir,
  parseSupervisorRecord,
  runsHoaiLauncher,
} from './agent-inventory.mjs'
import { liveAgentDaemonPid, recipeLaunchCommand, restartTierFor } from './agent-restart.mjs'
import { PAIRING_LOCK_FRESH_MS, parsePairingLock } from './keepalive-plan.mjs'
import {
  CLAIMED_MARKER_FILE_NAME,
  HANDOFF_LOCK_FILE_NAME,
  HANDOFF_LOCK_STALE_MS,
  REFUSED_MARKER_FILE_NAME,
  TAKEOVER_LEDGER_FILE_NAME,
  handoffEnv,
  handoffLockLive,
  ledgerBodyWith,
  mcpEnvKeys,
  parseHandoffLock,
  parseTakeoverLedger,
  takeoverBudget,
} from './marker-takeover.mjs'
import { findAgentClaudePids, isClaudeCommand } from './process-tree.mjs'
import { vbsString } from './win32-script-text.mjs'

export const HANDOFF_SESSION_END_MS = 30_000
export const HANDOFF_FAST_POLL_MS = 250
export const HANDOFF_POLL_MS = 1_000
export const HANDOFF_LAUNCHER_WAIT_MS = 300_000
export const HANDOFF_SETTLE_MS = 20_000
export const HANDOFF_VERIFY_MS = 90_000
export const HANDOFF_EXEC_TIMEOUT_MS = 30_000
/** claude's parent is the launcher, or a cmd.exe (npm claude.cmd) whose parent is. */
export const LAUNCHER_HOPS_MAX = 2
export const CLAIM_TRIES = 3
export const CLAIM_RETRY_MS = 500
const AGENT_TASK_NAME_RE = /^HOAI Agent \d+$/

// -- pure pieces ------------------------------------------------------------------

function argv0Base(command) {
  const text = String(command ?? '').trim()
  const first = text.startsWith('"') ? text.slice(1, Math.max(1, text.indexOf('"', 1))) : text.split(/\s+/)[0]
  return first.slice(Math.max(first.lastIndexOf('/'), first.lastIndexOf('\\')) + 1).toLowerCase()
}

/**
 * Prove from one process listing that this daemon runs under a claude whose
 * launcher is the one supervisor.json names. A parent created after its child
 * is a reused pid, which ends the walk (nearestClaudeAncestorWin32's rule).
 * @param {{ processes: Array<{ pid: number, ppid: number, startedAtMs: number | null, command: string }>,
 *   daemonPid: number, expectedClaudePid: number, launcherPid: number }} input
 */
export function sessionChain({ processes, daemonPid, expectedClaudePid, launcherPid }) {
  const byPid = new Map((Array.isArray(processes) ? processes : []).map((p) => [p.pid, p]))
  const parentOf = (child) => {
    const parent = byPid.get(child.ppid)
    if (!parent || parent.pid === child.pid) return null
    if (Number.isFinite(parent.startedAtMs) && Number.isFinite(child.startedAtMs) && parent.startedAtMs > child.startedAtMs) return null
    return parent
  }
  const daemon = byPid.get(daemonPid)
  if (!daemon) return { ok: false, reason: 'session_already_ended' }
  let claude = null
  let cur = daemon
  for (let hop = 0; hop < 6 && cur; hop++) {
    const parent = parentOf(cur)
    if (!parent) break
    if (isClaudeCommand(parent.command)) {
      claude = parent
      break
    }
    cur = parent
  }
  if (!claude) return { ok: false, reason: 'claude_not_ancestor' }
  if (expectedClaudePid > 1 && claude.pid !== expectedClaudePid) return { ok: false, reason: 'claude_ambiguous', detail: `claude ${claude.pid}, expected ${expectedClaudePid}` }
  let launcher = null
  let hop = parentOf(claude)
  for (let i = 0; i < LAUNCHER_HOPS_MAX && hop; i++) {
    if (hop.pid === launcherPid) {
      launcher = hop
      break
    }
    if (argv0Base(hop.command) !== 'cmd.exe') break
    hop = parentOf(hop)
  }
  if (!launcher) {
    const parent = byPid.get(claude.ppid)
    return { ok: false, reason: 'not_our_launcher', detail: `claude ${claude.pid} parent ${parent ? `${parent.pid} ${argv0Base(parent.command)}` : `${claude.ppid} (gone)`}` }
  }
  if (!runsHoaiLauncher(launcher.command)) return { ok: false, reason: 'not_our_launcher', detail: `launcher ${launcher.pid} does not run hoai-core.mjs` }
  return {
    ok: true,
    claudePid: claude.pid,
    claudeCreatedAtMs: claude.startedAtMs ?? null,
    launcherCommand: launcher.command,
    launcherStartedAtMs: launcher.startedAtMs ?? null,
    keepAlive: /(^|\s)--keep-alive(\s|$)/.test(String(launcher.command ?? '')),
  }
}

/** Two folder spellings name the same folder: case folded, one slash style, no trailing slash, no realpath. */
export function sameFolder(a, b) {
  const norm = (p) => String(p ?? '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const x = norm(a)
  return x !== '' && x === norm(b)
}

/** Does the agent task's run-agent.vbs start hoai-core in exactly this folder spelling? */
export function taskFolderIs(vbsText, cwd) {
  const folder = String(cwd ?? '').trim().replace(/\//g, '\\').replace(/\\+$/, '')
  if (!folder || typeof vbsText !== 'string') return false
  const want = `shell.currentdirectory = ${vbsString(folder)}`.toLowerCase()
  return vbsText.split(/\r?\n/).some((line) => line.trim().toLowerCase() === want)
}

/**
 * The way back, planned BEFORE anything changes and again after the launcher
 * let go, from the inventory row the restart will use.
 * @returns {{ route: { kind: 'keep-alive', fallback: object | null } | { kind: 'task' | 'recipe-hidden', row: object } | null, reason: string }}
 */
export function planHandoffRoute({ row, keepAlive, launchCwd, taskVbsText, pluginRoot }) {
  if (!row) return { route: null, reason: 'no_inventory_row' }
  const tierRow = { ...row, supervisor: row.supervisor === 'launcher-live' ? 'none' : row.supervisor, launcherLive: false, keepalive: null }
  let tierRoute = null
  let reason = ''
  const tier = restartTierFor(tierRow, { platform: 'win32' })
  if (tier === 'task' && AGENT_TASK_NAME_RE.test(String(row.service?.handle ?? '')) && taskFolderIs(taskVbsText, launchCwd)) {
    tierRoute = { kind: 'task', row: tierRow }
  } else {
    if (tier === 'task') reason = 'task_registered_for_another_folder_spelling'
    const recipe = row.recipe
    if (!recipe) reason = reason || 'no_launch_recipe'
    else if (!sameFolder(recipe.cwd, launchCwd)) reason = reason || 'recipe_folder_differs'
    else if (
      !recipeLaunchCommand({ platform: 'win32', assistantId: row.assistantId, cwd: recipe.cwd, nodePath: recipe.node || 'node', pluginRoot, stateDir: row.stateDir ?? null })
    ) {
      reason = reason || 'hidden_launch_unavailable'
    } else {
      tierRoute = { kind: 'recipe-hidden', row: { ...tierRow, supervisor: 'none', service: null } }
    }
  }
  if (keepAlive) return { route: { kind: 'keep-alive', fallback: tierRoute }, reason: 'keep_alive' }
  if (tierRoute) return { route: tierRoute, reason: tierRoute.kind }
  const notes = Array.isArray(row.notes) && row.notes.length ? ` ${row.notes.join(',')}` : ''
  return { route: null, reason: `${reason || 'no_route'}${notes}` }
}

/**
 * What the launcher did after its claude was ended.
 *   relaunched      the same launcher re-stamped supervisor.json (--keep-alive
 *                   does before every relaunch, hoai-core.mjs:2448)
 *   released        the launcher process is gone (an interactive one returns and
 *                   removes supervisor.json in its finally, :2453)
 *   other-launcher  a different live launcher owns the agent now
 *   held            still there, unchanged, past the wait (a frozen console)
 *   wait            keep looking
 */
export function decideLauncherStep({ launcherPid, rawAtKill, rawNow, launcherAlive, otherAlive, waitedMs, maxMs }) {
  const now = parseSupervisorRecord(rawNow)
  if (now && now.pid !== launcherPid && otherAlive) return 'other-launcher'
  // Released only once the launcher PROCESS is gone: a launcher still running
  // whose supervisor.json vanished could relaunch beside anything started now.
  if (!launcherAlive) return 'released'
  if (now && now.pid === launcherPid && rawNow !== rawAtKill) return 'relaunched'
  return waitedMs >= maxMs ? 'held' : 'wait'
}

/** The fs restartAgent gets from the helper: anything but a restart marker. */
export function noMarkerFs(fs, markerPath) {
  const same = (p) => String(p ?? '').toLowerCase() === String(markerPath).toLowerCase()
  return {
    ...fs,
    writeFile: (path, text, opts) => {
      if (same(path)) throw new Error('the restart takeover helper never writes a restart marker')
      return fs.writeFile(path, text, opts)
    },
  }
}

// -- the run ------------------------------------------------------------------------

/**
 * @param {{ assistantId: string, kind: 'stranded' | 'swallowed', markerMtimeMs: number, bootAtMs: number,
 *   daemonPid: number, claudePid: number, launcherPid: number, stateDir: string, home: string,
 *   launchCwd: string, logPath: string, pluginStateDir: string, credentialsPath: string, pluginRoot: string }} params
 * @param {{ ownPid: number, now: () => number, sleep: (ms: number) => Promise<void>, log: (line: string) => void,
 *   pidAlive: (pid: number) => boolean, kill: (pid: number, signal: string) => unknown,
 *   fs: { readFile: Function, stat: Function, rename: Function, writeAtomic: Function, openExclusive: Function, unlink: Function },
 *   env: Record<string, string>, listProcesses: () => Promise<any>, listAgents: (opts: object) => any[],
 *   readLauncherProcesses: (pids: number[]) => Map<number, any>, restartAgent: Function, restartDeps: Record<string, any> }} deps
 * @returns {Promise<{ outcome: string }>}
 */
export async function runRestartHandoff(params, deps) {
  const p = params
  const startedAt = deps.now()
  const say = (text) => {
    try {
      deps.log(text)
    } catch {}
  }
  const path = (name) => joinDir(p.stateDir, name)
  const markerPath = path(RESTART_MARKER_FILE_NAME)
  const supervisorPath = path(SUPERVISOR_FILE_NAME)
  const ledgerPath = path(TAKEOVER_LEDGER_FILE_NAME)
  const lockPath = path(HANDOFF_LOCK_FILE_NAME)
  const pin = String(deps.fs.readFile(path('session-id')) ?? '').trim()
  const finish = (outcome, text) => {
    if (text) say(text)
    say(`done (${outcome}) after ${deps.now() - startedAt}ms`)
    return { outcome }
  }
  const not = (outcome, detail = '') => finish(outcome, `NOT ending claude ${p.claudePid || 'unknown'}: ${outcome}${detail ? ` (${detail})` : ''}`)
  say(`start for agent ${p.assistantId} (${p.kind}): claude ${p.claudePid || 'unknown'}, daemon ${p.daemonPid}, launcher ${p.launcherPid}, pin ${pin || 'none'}`)

  // 1. One helper per agent.
  const lockBody = JSON.stringify({ pid: deps.ownPid, at: new Date(deps.now()).toISOString() })
  let locked = deps.fs.openExclusive(lockPath, lockBody)
  if (locked === 'exists') {
    const held = parseHandoffLock(deps.fs.readFile(lockPath))
    if (handoffLockLive(held, { now: deps.now(), pidAlive: deps.pidAlive })) return not('another_handoff_running', `helper pid ${held?.pid}`)
    deps.fs.unlink(lockPath)
    locked = deps.fs.openExclusive(lockPath, lockBody)
  }
  if (locked !== 'ok') return not(locked === 'exists' ? 'another_handoff_running' : 'lock_unavailable', 'the lock could not be taken')
  // Two helpers that both found a stale lock: only the one named in it goes on.
  if (parseHandoffLock(deps.fs.readFile(lockPath))?.pid !== deps.ownPid) return not('another_handoff_running', 'another helper holds the lock')
  try {
    return await runLocked()
  } finally {
    const held = parseHandoffLock(deps.fs.readFile(lockPath))
    if (held?.pid === deps.ownPid) deps.fs.unlink(lockPath)
  }

  async function runLocked() {
    // 2. The loop guard, authoritative here.
    const ledger = parseTakeoverLedger(deps.fs.readFile(ledgerPath), { now: deps.now(), fileMtimeMs: deps.fs.stat(ledgerPath)?.mtimeMs ?? null })
    if (ledger.unreadable && Number(ledger.junkBlocksUntilMs) > deps.now()) return not('ledger_unreadable')
    if (p.markerMtimeMs > 0 && ledger.entries.some((e) => e.markerMtimeMs === p.markerMtimeMs)) return not('already_taken_over')
    const budget = takeoverBudget(ledger.entries, deps.now())
    if (!budget.allow) {
      if (p.kind === 'stranded') {
        const st = deps.fs.stat(markerPath)
        if (st && st.mtimeMs === p.markerMtimeMs) deps.fs.rename(markerPath, path(REFUSED_MARKER_FILE_NAME))
      }
      return finish('cap', `REFUSED (loop guard): ${MAX_RELAUNCHES_PER_WINDOW} takeovers in the last hour; claude ${p.claudePid || 'unknown'} left running`)
    }

    // 3. The process table, and 4. the chain.
    const listed = await deps.listProcesses()
    if (!listed?.ok) return not('process_list_failed', String(listed?.error ?? 'no listing'))
    const chain = sessionChain({ processes: listed.processes, daemonPid: p.daemonPid, expectedClaudePid: p.claudePid, launcherPid: p.launcherPid })
    if (!chain.ok) return not(chain.reason, chain.detail)
    const rawAtKill = deps.fs.readFile(supervisorPath)
    const record = parseSupervisorRecord(rawAtKill)
    if (
      !record ||
      record.pid !== p.launcherPid ||
      !record.capabilities.includes('relaunch') ||
      record.declaredLauncher ||
      !isSupervisorWriter(record, { command: chain.launcherCommand, startedAtMs: chain.launcherStartedAtMs })
    ) {
      return not('not_our_launcher', 'not the writer of supervisor.json')
    }
    const claudePid = chain.claudePid
    // 5. No other session of this agent.
    const others = findAgentClaudePids({ processes: listed.processes, sessionIds: pin ? [pin] : [] }).pids.filter((pid) => pid !== claudePid)
    if (others.length) return not('another_session_running', `claude pids ${others.join(',')}`)

    // 6. The way back, before anything changes.
    const rowFor = () => {
      const rows = deps.listAgents({ includeIds: [p.assistantId] }) ?? []
      const row = rows.find((r) => r?.assistantId === p.assistantId)
      return row ? { ...row, pluginStateDir: p.pluginStateDir, credentialsPath: p.credentialsPath, stateDir: row.stateDir ?? p.stateDir } : null
    }
    const taskVbs = () => deps.fs.readFile(path(AGENT_TASK_LAUNCHER_FILE_NAME))
    const row0 = rowFor()
    const plan0 = planHandoffRoute({ row: row0, keepAlive: chain.keepAlive, launchCwd: p.launchCwd, taskVbsText: taskVbs(), pluginRoot: p.pluginRoot })
    if (!plan0.route) return not('no_way_back', plan0.reason)
    const routeName = (route) => (route.kind === 'task' ? `task "${route.row.service?.handle}"` : route.kind === 'recipe-hidden' ? `recipe-hidden in ${route.row.recipe?.cwd ?? p.launchCwd}` : 'keep-alive')
    say(`route ${routeName(plan0.route)}`)

    // 7. The same session, still: the daemon holds the agent's lock, claude is the same process.
    //    Checked before anything is claimed or recorded, so a refusal here spends nothing.
    const lock = parsePairingLock(deps.fs.readFile(`${p.credentialsPath}.lock`))
    if (!lock || lock.pid !== p.daemonPid || Math.abs(deps.now() - lock.heartbeatAt) > PAIRING_LOCK_FRESH_MS) return not('daemon_lost_pairing_lock')
    const procs = deps.readLauncherProcesses([claudePid, p.daemonPid])
    const c = procs.get(claudePid)
    if (!c || !procs.get(p.daemonPid) || c.startedAtMs !== chain.claudeCreatedAtMs) return not('session_changed')

    // 8. Claim a stranded marker: atomic, so no launcher or other helper acts on it too.
    if (p.kind === 'stranded') {
      const st = deps.fs.stat(markerPath)
      if (!st || !(st.mtimeMs > p.bootAtMs)) return not('claimed_by_other', st ? 'only a stale marker is on disk' : 'the marker is gone')
      let claimed = 'busy'
      for (let i = 0; i < CLAIM_TRIES && claimed === 'busy'; i++) {
        claimed = deps.fs.rename(markerPath, path(CLAIMED_MARKER_FILE_NAME))
        if (claimed === 'busy') await deps.sleep(CLAIM_RETRY_MS)
      }
      if (claimed === 'gone') return not('claimed_by_other', 'the launcher took it first')
      if (claimed !== 'ok') return not('marker_busy')
      say(`claimed the marker as ${CLAIMED_MARKER_FILE_NAME}`)
    }

    // 9. Record it before anything can be killed.
    const entry = { atMs: deps.now(), kind: p.kind, markerMtimeMs: p.markerMtimeMs > 0 ? p.markerMtimeMs : null, claudePid, launcherPid: p.launcherPid, daemonPid: p.daemonPid, pin: pin || null, route: plan0.route.kind }
    if (!deps.fs.writeAtomic(ledgerPath, ledgerBodyWith(ledger.entries, entry, deps.now()))) return not('ledger_unwritable')

    // 10. End claude, exactly as the launcher's own restart does (TerminateProcess).
    say(`ending claude ${claudePid} (created ${Number.isFinite(chain.claudeCreatedAtMs) ? new Date(chain.claudeCreatedAtMs).toISOString() : 'unknown'})`)
    try {
      deps.kill(claudePid, 'SIGTERM')
    } catch (err) {
      return finish('kill_failed', `ending claude ${claudePid} failed (${err?.code ?? err?.message ?? err}); nothing started`)
    }

    // 11. The session ends: claude, and the daemon with it.
    const killedAt = deps.now()
    while (deps.pidAlive(claudePid) || deps.pidAlive(p.daemonPid)) {
      if (deps.now() - killedAt >= HANDOFF_SESSION_END_MS) return finish('session_did_not_end', `claude ${claudePid} or daemon ${p.daemonPid} still alive after ${HANDOFF_SESSION_END_MS / 1000}s; nothing started`)
      await deps.sleep(HANDOFF_FAST_POLL_MS)
    }
    say(`claude ${claudePid} and daemon ${p.daemonPid} ended after ${deps.now() - killedAt}ms`)
    // Seen dead once, dead for good: an abrupt end (claude's job) leaves the
    // daemon's lock and state on disk naming its pid, and Windows reuses pids.
    const ended = new Set([claudePid, p.daemonPid])
    const alive = (pid) => !ended.has(pid) && deps.pidAlive(pid)

    // 12. What the launcher does about it.
    const liveLauncherPid = () => {
      const now = parseSupervisorRecord(deps.fs.readFile(supervisorPath))
      if (!now || !now.capabilities.includes('relaunch') || !alive(now.pid)) return null
      const proc = deps.readLauncherProcesses([now.pid]).get(now.pid) ?? null
      return isSupervisorWriter(now, proc) ? now.pid : null
    }
    // The launcher we proved, by pid AND creation time (a reused pid is not it).
    const launcherStillRunning = () => {
      if (!deps.pidAlive(p.launcherPid)) return false
      const seen = deps.readLauncherProcesses([p.launcherPid]).get(p.launcherPid)
      return !(seen && Number.isFinite(seen.startedAtMs) && Number.isFinite(chain.launcherStartedAtMs) && seen.startedAtMs !== chain.launcherStartedAtMs)
    }
    let step = 'wait'
    const waitFrom = deps.now()
    let route = plan0.route
    while (true) {
      const rawNow = deps.fs.readFile(supervisorPath)
      const named = parseSupervisorRecord(rawNow)
      step = decideLauncherStep({
        launcherPid: p.launcherPid,
        rawAtKill,
        rawNow,
        launcherAlive: launcherStillRunning(),
        otherAlive: Boolean(named && named.pid !== p.launcherPid && liveLauncherPid() === named.pid),
        waitedMs: deps.now() - waitFrom,
        maxMs: HANDOFF_LAUNCHER_WAIT_MS,
      })
      if (step !== 'wait') break
      await deps.sleep(HANDOFF_POLL_MS)
    }
    if (step === 'relaunched') return finish('relaunched_by_launcher', `launcher ${p.launcherPid} relaunched claude itself; nothing started`)
    if (step === 'other-launcher') return finish('other_launcher', `another launcher owns agent ${p.assistantId}; nothing started`)
    if (step === 'held') return finish('launcher_held', `launcher ${p.launcherPid} still holds agent ${p.assistantId} after ${HANDOFF_LAUNCHER_WAIT_MS / 1000}s; nothing started`)
    say(`launcher ${p.launcherPid} exited after ${deps.now() - waitFrom}ms`)
    if (route.kind === 'keep-alive') {
      if (!route.fallback) return finish('restart_failed', `HANDOFF FAILED: the --keep-alive launcher exited instead of relaunching and no other way back is planned; start it by hand: cd ${p.launchCwd} && hoai`)
      route = route.fallback
    }

    // 13. Settle: a fleet script, the watcher or a person may start it now.
    const daemonRow = { ...row0, pluginStateDir: p.pluginStateDir, credentialsPath: p.credentialsPath }
    const liveDaemon = () => liveAgentDaemonPid(daemonRow, { fs: { readFile: deps.fs.readFile }, now: deps.now(), pidAlive: alive })
    const settleFrom = deps.now()
    while (deps.now() - settleFrom < HANDOFF_SETTLE_MS) {
      const launcher = liveLauncherPid()
      if (launcher !== null) return finish('already_running', `agent ${p.assistantId} already running again (launcher pid ${launcher}); nothing started`)
      const daemon = liveDaemon()
      if (daemon !== null) return finish('already_running', `agent ${p.assistantId} already running again (daemon pid ${daemon}); nothing started`)
      await deps.sleep(HANDOFF_POLL_MS)
    }

    // 14. Start it, through the ladder, never through a marker.
    const row1 = rowFor()
    if (!row1) return finish('restart_failed', `HANDOFF FAILED: agent ${p.assistantId} has no inventory row any more; start it by hand: cd ${p.launchCwd} && hoai`)
    if (row1.launcherLive || row1.supervisor === 'launcher-live') return finish('launcher_live_again', `a launcher of agent ${p.assistantId} is live again; nothing started`)
    const plan1 = planHandoffRoute({ row: row1, keepAlive: false, launchCwd: p.launchCwd, taskVbsText: taskVbs(), pluginRoot: p.pluginRoot })
    if (!plan1.route) return finish('restart_failed', `HANDOFF FAILED: no way back any more (${plan1.reason}); start it by hand: cd ${p.launchCwd} && hoai`)
    const env = handoffEnv(deps.env, {
      platform: 'win32',
      extraKeys: mcpEnvKeys(deps.fs.readFile(joinDir(joinDir(p.pluginRoot, '.claude-plugin'), 'plugin.json')), deps.fs.readFile(joinDir(p.launchCwd, '.mcp.json'))),
    })
    const restartDeps = {
      ...deps.restartDeps,
      platform: 'win32',
      pluginRoot: p.pluginRoot,
      fs: noMarkerFs(deps.restartDeps.fs, markerPath),
      env,
      pidAlive: alive,
      now: deps.now,
    }
    // Last look before starting anything: a claude carrying this agent's pin
    // (one a person started by hand during the settle) means it already runs.
    const last = await deps.listProcesses()
    if (!last?.ok) return finish('restart_failed', `HANDOFF FAILED: the process list could not be read before the start (${last?.error ?? 'no listing'}); start it by hand: cd ${p.launchCwd} && hoai`)
    const pinned = findAgentClaudePids({ processes: last.processes, sessionIds: pin ? [pin] : [] }).pids.filter((pid) => alive(pid))
    if (pinned.length) return finish('already_running', `agent ${p.assistantId} already running again (claude pid ${pinned.join(',')}); nothing started`)
    const start = async (r) => {
      const tier = restartTierFor(r.row, { platform: 'win32' })
      if (tier !== 'task' && tier !== 'recipe') return { ok: false, how: tier, message: `refusing the ${tier} tier` }
      return deps.restartAgent(r.row, restartDeps)
    }
    let result = await start(plan1.route)
    say(`restartAgent ${result?.ok ? 'ok' : 'FAILED'} how=${result?.how}: ${result?.message ?? ''}`)
    if (!result?.ok) return finish('restart_failed', `HANDOFF FAILED: start it by hand: cd ${p.launchCwd} && hoai`)

    // 15. Back? A live launcher that wrote supervisor.json after the kill, and a new daemon.
    const back = () => {
      const launcher = liveLauncherPid()
      const daemon = liveDaemon()
      const rewritten = deps.fs.readFile(supervisorPath) !== rawAtKill
      return launcher !== null && rewritten && daemon !== null && daemon !== p.daemonPid ? { launcher, daemon } : null
    }
    const verify = async () => {
      const from = deps.now()
      while (deps.now() - from < HANDOFF_VERIFY_MS) {
        const ok = back()
        if (ok) return ok
        await deps.sleep(HANDOFF_POLL_MS)
      }
      return back()
    }
    let ok = await verify()
    if (!ok && plan1.route.kind === 'task' && liveLauncherPid() === null && liveDaemon() === null) {
      const fallback = planHandoffRoute({ row: { ...row1, supervisor: 'none', service: null }, keepAlive: false, launchCwd: p.launchCwd, taskVbsText: null, pluginRoot: p.pluginRoot })
      if (fallback.route) {
        say(`nothing live ${HANDOFF_VERIFY_MS / 1000}s after the task start; one fallback through the hidden recipe`)
        result = await start(fallback.route)
        say(`restartAgent ${result?.ok ? 'ok' : 'FAILED'} how=${result?.how}: ${result?.message ?? ''}`)
        if (result?.ok) ok = await verify()
      }
    }
    if (!ok) return finish('not_back', `HANDOFF FAILED: agent ${p.assistantId} not back after ${HANDOFF_VERIFY_MS / 1000}s; start it by hand: cd ${p.launchCwd} && hoai`)
    const pinNow = String(deps.fs.readFile(path('session-id')) ?? '').trim()
    return finish('restarted', `agent ${p.assistantId} is back: launcher pid ${ok.launcher}, daemon pid ${ok.daemon}, session pin ${pinNow || 'none'} (${pinNow === pin ? 'same' : 'CHANGED'})`)
  }
}

// -- node adapters for bin/hoai-restart-handoff.mjs ------------------------------------------

/** spawnSync with no console window, for PowerShell and schtasks probes from a console-less helper. */
export function hiddenExecSync(file, args) {
  const r = spawnSync(file, [...args], { encoding: 'utf8', windowsHide: true, timeout: HANDOFF_EXEC_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })
  return { code: typeof r.status === 'number' ? r.status : 1, stdout: String(r.stdout ?? '') }
}

/** The helper's own filesystem surface. Reads never throw. */
export function nodeHandoffFs() {
  return {
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
    stat: (p) => {
      try {
        const s = statSync(p)
        return s.isFile() ? { mtimeMs: Math.floor(s.mtimeMs) } : null
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
    writeAtomic: (p, text) => {
      const tmp = `${p}.${process.pid}.tmp`
      try {
        writeFileSync(tmp, text)
        renameSync(tmp, p)
        return true
      } catch {
        try {
          unlinkSync(tmp)
        } catch {}
        return false
      }
    },
    openExclusive: (p, text) => {
      try {
        const fd = openSync(p, 'wx')
        try {
          writeSync(fd, text)
        } finally {
          closeSync(fd)
        }
        return 'ok'
      } catch (err) {
        return err?.code === 'EEXIST' ? 'exists' : 'error'
      }
    },
    unlink: (p) => {
      try {
        unlinkSync(p)
        return true
      } catch {
        return false
      }
    },
  }
}

export { HANDOFF_LOCK_STALE_MS }
