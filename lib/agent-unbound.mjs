/**
 * agent-unbound: what this computer does when the owner DELETES one of its
 * agents in HOAI (board row 5b45611f6b0d, the plugin half of "deleting an
 * agent removes everything").
 *
 * The notice. After the delete commits the backend tells the pairing room
 * `assistant_unbound` {pairingId, assistantId} (EventType.ASSISTANT_UNBOUND,
 * the gateway's cutUnboundAssistant), and stores one pairing_notices row that
 * it replays as the SAME event, with an ack, on the pairing's next connect,
 * for at most 7 days (backend/src/integrations/pairing-notices.ts). An ack
 * retires the row. The same event is also sent when an agent is re-paired
 * onto another computer or handed to a new owner.
 *
 * Every daemon of a pairing joins `pairing:<id>`, so each one hears every
 * agent's notice. A daemon acts only on (judgeUnboundNotice):
 *   - its OWN agent id (another agent's notice is left for that agent's own
 *     daemon);
 *   - its OWN pairing id, read from its credentials file (a notice naming
 *     another pairing, or none, is not its server's; a daemon that does not
 *     know its pairing cannot tell, and does nothing);
 *   - and only once the paired server itself answers that the agent is gone
 *     (classifyOwnAgentRead): GET assistants/<id>, sent with this daemon's own
 *     credentials to its own backend, is 200 and null for a deleted agent
 *     (and for one handed to another owner), and returns the row for one that
 *     still is ours (a re-pair), which is left alone. A frame nobody at the
 *     server sent can therefore never remove anything.
 *
 * No notice is ever acked here. The daemon that launches the cleanup is
 * stopped by it and can never learn whether it finished, so an ack would
 * retire the only retry there is: unacked, the notice is replayed on every
 * connect for the backend's week, a later life of the same agent (its auto
 * start still in place because a step failed) checks again and runs the
 * idempotent cleanup again, and every other daemon ignores it.
 *
 * The cleanup (cleanUpUnboundAgent), run by bin/hoai-agent-unbound.mjs in a
 * process detached from the agent, because stopping the agent ends its whole
 * process tree, the daemon that heard the notice included:
 *   - stop the session: a hand-run hoai launcher (macOS, Linux) gets SIGTERM,
 *     which ends its claude and never relaunches it; a service's session is
 *     ended by the service's own stop below; on Windows the task's
 *     `hoai-core --keep-alive` tree is ended (taskkill /T /F) once its task
 *     is unregistered, so the task cannot start it again. Only a launcher
 *     lib/agent-inventory.mjs proves live and this agent's is ever signalled.
 *   - remove the auto start entry: `bin/bgos-agent uninstall --assistant <id>`
 *     on macOS and Linux (this HOME's launchd plist or systemd unit, read back
 *     first, another HOME's refused), and the watcher's own
 *     uninstallAgentTask on Windows (this HOME's logon task, read back first).
 *   - ARCHIVE ~/.bgos-agent/<id> to ~/.bgos-agent/.removed/<id>-<date>, never
 *     delete it (removedArchivePath). On macOS and Linux it moves BEFORE the
 *     uninstall, whose state wipe would otherwise delete its files; on Windows
 *     after the task's tree has ended, retried while a file is still held.
 *   - remove the agent's credentials file, credentials-<id>.json, and the
 *     legacy credentials.json only when it names this agent, and only once
 *     its auto start is removed (or there was none): an agent whose service
 *     or task is still there keeps them, so its next life can retry.
 * On Windows a logon task the read back does not show gone stops the
 * cleanup there: nothing is ended, moved or removed, and the replay retries.
 *
 * Idempotent: a replayed notice finds no folder, no credentials and no
 * service file, and does nothing at all (no command, no second archive). No
 * other agent's folder, file, job, unit or task is ever named.
 *
 * Every effect is injected (fs, exec, kill, pidAlive, sleep, clock). Plain
 * JavaScript, node >= 18, import-safe.
 */

import {
  agentDir,
  agentHomeId,
  agentStateDir,
  credentialsPath,
  joinDir,
  serviceFilePath,
  validAssistantId,
} from './agent-inventory.mjs'
import { agentTaskRegistration, agentTaskStatus, uninstallAgentTask } from './agent-task-win32.mjs'

/** The backend's EventType.ASSISTANT_UNBOUND. */
export const ASSISTANT_UNBOUND_EVENT = 'assistant_unbound'
/** Where a deleted agent's folder goes, under ~/.bgos-agent (not all digits: no reader takes it for an agent). */
export const REMOVED_DIR_NAME = '.removed'
/** bin/bgos-agent uninstall waits up to 60 s for an install of the same agent; this is generous, never unbounded. */
export const UNINSTALL_TIMEOUT_MS = 3 * 60_000
/** How long a stopped launcher is given to end its claude and exit. */
export const STOP_WAIT_MS = 20_000
/** How long a Windows folder still held open by an ending process is retried. */
export const ARCHIVE_RETRY_MS = 30_000
const POLL_MS = 500

function digits(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  if (typeof value === 'string' && /^\d+$/.test(value)) return value.replace(/^0+(?=\d)/, '')
  return null
}

/**
 * Is this `assistant_unbound` frame about THIS agent, from THIS agent's
 * pairing? Pure.
 * @param {unknown} payload
 * @param {{ assistantId: unknown, pairingId: unknown }} own
 * @returns {{ act: true } | { act: false, reason: 'malformed' | 'own_pairing_unknown' | 'other_pairing' | 'other_agent' }}
 */
export function judgeUnboundNotice(payload, own) {
  const ownAgent = digits(own?.assistantId)
  const ownPairing = digits(own?.pairingId)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { act: false, reason: 'malformed' }
  const agent = digits(payload.assistantId)
  const pairing = digits(payload.pairingId)
  if (!agent || !pairing) return { act: false, reason: 'malformed' }
  if (!ownAgent || !ownPairing) return { act: false, reason: 'own_pairing_unknown' }
  if (pairing !== ownPairing) return { act: false, reason: 'other_pairing' }
  if (agent !== ownAgent) return { act: false, reason: 'other_agent' }
  return { act: true }
}

/**
 * What the paired server answered to GET assistants/<id>: 200 with an empty or
 * null body is a deleted agent (the endpoint's contract is 200 + null for a
 * missing agent, and Nest may send a null as an empty body); 200 with this
 * agent's row is present; anything else (an error status, junk, another id)
 * proves nothing. Pure.
 * @param {{ status: number, body: string } | null | undefined} read
 * @param {string | number} assistantId
 * @returns {'deleted' | 'present' | 'unknown'}
 */
export function classifyOwnAgentRead(read, assistantId) {
  if (!read || read.status !== 200) return 'unknown'
  const text = String(read.body ?? '').trim()
  if (text === '' || text === 'null') return 'deleted'
  let row
  try {
    row = JSON.parse(text)
  } catch {
    return 'unknown'
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) return 'unknown'
  const id = digits(row.id)
  return id !== null && id === digits(assistantId) ? 'present' : 'unknown'
}

/**
 * The daemon's `assistant_unbound` handler: judge the frame, ask the server,
 * then launch the cleanup once. A notice already handled (the replay racing
 * the live emit) launches nothing. Never acks (see the header).
 * @param {{ assistantId: string, pairingId: unknown,
 *   readOwnAgent: () => Promise<{ status: number, body: string } | null>,
 *   launchCleanup: () => { ok: boolean, detail: string },
 *   log: (line: string) => void }} deps
 * @returns {(payload: unknown) => Promise<string>}
 */
export function createUnboundNoticeHandler({ assistantId, pairingId, readOwnAgent, launchCleanup, log }) {
  /** idle, busy (a notice is being confirmed), done (the cleanup was launched) */
  let state = 'idle'
  return async (payload) => {
    const verdict = judgeUnboundNotice(payload, { assistantId, pairingId })
    if (!verdict.act) {
      const named = payload && typeof payload === 'object' ? ` (agent ${digits(payload.assistantId) ?? '?'}, pairing ${digits(payload.pairingId) ?? '?'})` : ''
      log(`assistant_unbound ignored${named}: ${verdict.reason}`)
      return `ignored:${verdict.reason}`
    }
    if (state !== 'idle') return 'already_handled'
    state = 'busy'
    let read = null
    try {
      read = await readOwnAgent()
    } catch (err) {
      log(`assistant_unbound for this agent: the server could not be asked (${String(err?.message ?? err)}); nothing removed, the replay asks again`)
      state = 'idle'
      return 'ignored:unconfirmed'
    }
    const answer = classifyOwnAgentRead(read, assistantId)
    if (answer === 'present') {
      log('assistant_unbound for this agent, but the server still returns it as ours (a re-pair, or a stale notice); nothing removed')
      state = 'idle'
      return 'ignored:still_present'
    }
    if (answer !== 'deleted') {
      log(`assistant_unbound for this agent: the server did not confirm it is deleted (status ${read?.status ?? 'none'}); nothing removed, the replay asks again`)
      state = 'idle'
      return 'ignored:unconfirmed'
    }
    let launched
    try {
      launched = launchCleanup()
    } catch (err) {
      launched = { ok: false, detail: String(err?.message ?? err) }
    }
    if (!launched?.ok) {
      log(`assistant_unbound: agent ${assistantId} is deleted, but its cleanup did not start (${launched?.detail ?? 'no detail'}); the replay tries again`)
      state = 'idle'
      return 'cleanup_failed'
    }
    log(`assistant_unbound: agent ${assistantId} was deleted in HOAI (confirmed by the server); its cleanup started (${launched.detail}): session stopped, auto start removed, folder archived under ~/.bgos-agent/${REMOVED_DIR_NAME}, credentials removed`)
    state = 'done'
    return 'cleanup_launched'
  }
}

/**
 * ~/.bgos-agent/.removed/<id>-<YYYY-MM-DD> (the UTC day), with -2, -3 when
 * that name is taken. Null for a junk id.
 * @param {{ home: string, assistantId: string | number, now: number, exists: (path: string) => boolean }} input
 */
export function removedArchivePath({ home, assistantId, now, exists }) {
  const id = validAssistantId(assistantId)
  if (!id || String(assistantId).trim() !== id) return null
  const base = joinDir(joinDir(agentDir(home), REMOVED_DIR_NAME), `${id}-${new Date(now).toISOString().slice(0, 10)}`)
  if (!exists(base)) return base
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`
    if (!exists(candidate)) return candidate
  }
}

/** Counted, never timed: an injected clock that does not move can never make it spin. */
async function waitUntilGone(pid, { pidAlive, sleep }, limitMs) {
  for (let tries = Math.ceil(limitMs / POLL_MS); pidAlive(pid); tries -= 1) {
    if (tries <= 0) return false
    await sleep(POLL_MS)
  }
  return true
}

function errorText(err) {
  return String(err?.code ?? err?.message ?? err)
}

/**
 * Remove everything a deleted agent left on this computer. Never throws.
 * @param {{ platform: string, home: string, assistantId: string,
 *   fs: import('./watcher-bundle.mjs').WatcherFs, exec: import('./watcher-bundle.mjs').Exec,
 *   bgosAgentBin?: string, now?: () => number,
 *   readLauncher?: () => ({ pid: number, supervisor: string } | null),
 *   kill?: (pid: number, signal: string) => unknown, pidAlive?: (pid: number) => boolean,
 *   sleep?: (ms: number) => Promise<void>, log?: (line: string) => void }} deps
 * @returns {Promise<{ ok: boolean, archivedTo: string | null, credentialsRemoved: string[], notes: string[] }>}
 */
export async function cleanUpUnboundAgent(deps) {
  const { platform, home, fs, exec } = deps
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const pidAlive = deps.pidAlive ?? (() => false)
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal))
  const readLauncher = deps.readLauncher ?? (() => null)
  const notes = []
  const credentialsRemoved = []
  let archivedTo = null
  let ok = true
  const say = (line) => {
    notes.push(line)
    log(line)
  }

  const id = validAssistantId(deps.assistantId)
  const stateDir = id && String(deps.assistantId).trim() === id ? agentStateDir(home, id) : null
  if (!stateDir) {
    say(`refused: ${JSON.stringify(String(deps.assistantId))} is not an agent id; nothing was touched`)
    return { ok: false, archivedTo, credentialsRemoved, notes }
  }

  const credentialFiles = [credentialsPath(home, id)]
  const legacy = joinDir(agentDir(home), 'credentials.json')
  try {
    const parsed = JSON.parse(fs.readFile(legacy) ?? 'null')
    if (parsed && digits(parsed.assistantId) === id) credentialFiles.push(legacy)
  } catch {
    // an unreadable legacy file is nobody's we can prove; it stays
  }
  let homeId = ''
  try {
    homeId = platform === 'win32' ? '' : agentHomeId(home, platform)
  } catch {
    homeId = ''
  }
  const serviceFiles = platform === 'win32' ? [] : [serviceFilePath(platform, home, id, homeId), serviceFilePath(platform, home, id, '')].filter((p) => p && fs.exists(p))
  const hadFolder = fs.exists(stateDir)
  const hadCredentials = credentialFiles.some((p) => fs.exists(p))
  if (!hadFolder && !hadCredentials && serviceFiles.length === 0) {
    say(`agent ${id}: nothing of it is left on this computer (already cleaned up)`)
    return { ok, archivedTo, credentialsRemoved, notes }
  }

  const archive = async ({ retry }) => {
    if (!fs.exists(stateDir)) return null
    const target = removedArchivePath({ home, assistantId: id, now: now(), exists: (p) => fs.exists(p) })
    for (let tries = retry ? Math.ceil(ARCHIVE_RETRY_MS / POLL_MS) : 0; ; tries -= 1) {
      try {
        fs.mkdir(joinDir(agentDir(home), REMOVED_DIR_NAME))
        fs.rename(stateDir, target)
        say(`agent ${id}: its folder ${stateDir} is archived at ${target}`)
        return target
      } catch (err) {
        if (tries <= 0) {
          ok = false
          say(`agent ${id}: its folder ${stateDir} could not be archived (${errorText(err)}); it is left exactly where it is`)
          return null
        }
        await sleep(POLL_MS)
      }
    }
  }

  const removeCredentials = () => {
    for (const path of credentialFiles) {
      if (!fs.exists(path)) continue
      try {
        fs.rm(path)
        credentialsRemoved.push(path)
        say(`agent ${id}: its credentials file ${path} is removed`)
      } catch (err) {
        ok = false
        say(`agent ${id}: its credentials file ${path} could not be removed (${errorText(err)})`)
      }
    }
  }

  const launcher = (() => {
    try {
      return readLauncher()
    } catch {
      return null
    }
  })()
  const launcherPid = launcher && Number.isInteger(launcher.pid) && launcher.pid > 1 ? launcher.pid : null

  if (platform === 'win32') {
    // The task first: a launcher ended while its task is registered is started
    // again by the task's own restart (RestartCount 999). The watcher's own
    // uninstall, read back first; `files: []` keeps every file in the folder,
    // which moves whole below. It writes its script into the folder, so it runs
    // only while the folder is there (a replay never makes it again).
    if (hadFolder) {
      let gone = false
      try {
        const reg = agentTaskRegistration({ assistantId: id, home })
        const res = await uninstallAgentTask({ ...reg, files: [] }, { exec, fs, timeoutMs: UNINSTALL_TIMEOUT_MS })
        for (const note of res.notes ?? []) say(`agent ${id}: ${note}`)
        // uninstallAgentTask is ok when it could not read the task back at all
        // (it only notes that), so the task is read back again: only `absent`
        // is gone.
        const after = await agentTaskStatus(reg, { exec, fs, timeoutMs: UNINSTALL_TIMEOUT_MS })
        gone = res.ok && after.state === 'absent'
        if (gone) say(`agent ${id}: its logon task "${reg.taskName}" is removed`)
        else say(`agent ${id}: its logon task "${reg.taskName}" is not shown removed (${res.ok ? after.line : res.message})`)
      } catch (err) {
        say(`agent ${id}: its logon task was not removed: ${errorText(err)}`)
      }
      if (!gone) {
        say(`agent ${id}: stopping here, so the task is never left pointing at a moved folder; nothing else was ended, moved or removed, and the next replay of the notice tries again`)
        return { ok: false, archivedTo, credentialsRemoved, notes }
      }
    }
    if (launcherPid !== null) {
      const res = await exec('taskkill.exe', ['/PID', String(launcherPid), '/T', '/F'], { timeoutMs: 60_000 })
      if (res?.code === 0) say(`agent ${id}: its session (launcher pid ${launcherPid} and everything under it) is ended`)
      else say(`agent ${id}: taskkill of its launcher pid ${launcherPid} answered rc ${res?.code ?? 'none'}`)
      if (!(await waitUntilGone(launcherPid, { pidAlive, sleep }, STOP_WAIT_MS))) say(`agent ${id}: its launcher pid ${launcherPid} is still alive`)
    }
    archivedTo = await archive({ retry: true })
    removeCredentials()
    return { ok, archivedTo, credentialsRemoved, notes }
  }

  // macOS and Linux. A hand-run hoai (no service) is stopped first: its SIGTERM
  // handler ends claude and does not relaunch it, and its way out still finds
  // its own folder. A service's session is ended by the uninstall below.
  if (launcherPid !== null && launcher.supervisor === 'launcher-live') {
    try {
      kill(launcherPid, 'SIGTERM')
      say(`agent ${id}: its hoai launcher (pid ${launcherPid}) is asked to end its session (SIGTERM)`)
      if (!(await waitUntilGone(launcherPid, { pidAlive, sleep }, STOP_WAIT_MS))) say(`agent ${id}: its launcher pid ${launcherPid} is still alive`)
    } catch (err) {
      say(`agent ${id}: SIGTERM to its launcher pid ${launcherPid} failed (${errorText(err)})`)
    }
  }
  // The folder moves BEFORE the uninstall: its state wipe would delete what is
  // in it, and its stop may end this very process (a systemd unit's cgroup).
  archivedTo = await archive({ retry: false })
  let autostartGone = true
  if (serviceFiles.length > 0 || hadFolder) {
    const bin = deps.bgosAgentBin
    if (!bin) {
      ok = false
      autostartGone = false
      say(`agent ${id}: no bin/bgos-agent to remove its auto start with`)
    } else {
      say(`agent ${id}: removing its auto start (${bin} uninstall --assistant ${id})`)
      const res = await exec(bin, ['uninstall', '--assistant', id], { timeoutMs: UNINSTALL_TIMEOUT_MS })
      const out = `${res?.stdout ?? ''}\n${res?.stderr ?? ''}`.trim()
      if (res?.code === 0) say(`agent ${id}: its auto start is removed${out ? `: ${out.split(/\r?\n/).filter(Boolean).slice(-1)[0]}` : ''}`)
      else {
        ok = false
        autostartGone = false
        say(`agent ${id}: its auto start was not removed (rc ${res?.code ?? 'none'}): ${out || res?.error || 'no output'}`)
      }
    }
  }
  // Only once nothing will start the agent again: one whose service is still
  // there keeps its credentials, so its next life hears the replay and retries.
  if (autostartGone) removeCredentials()
  else say(`agent ${id}: its credentials are kept while its auto start is still there`)
  // A process on its way out may have written into the folder again.
  if (fs.exists(stateDir)) {
    const late = await archive({ retry: false })
    if (late) say(`agent ${id}: files written after the move are archived at ${late}`)
  }
  return { ok, archivedTo, credentialsRemoved, notes }
}

/**
 * How the daemon's helper (bin/hoai-agent-unbound.mjs --stage launch) starts
 * the stage that does the work, in order of preference. The work must outlive
 * the agent's stop: on Linux a unit's stop kills its whole cgroup, so the run
 * stage asks for its own transient unit first; everywhere the launch stage
 * exits at once, so a detached run stage is nobody's child (taskkill /T, which
 * ends the agent's tree on Windows, follows parent pids). Pure; empty for a
 * junk id.
 * The transient unit gets the user manager's environment, not the daemon's,
 * so the daemon's PATH (where bin/bgos-agent finds bun or node) and HOME are
 * handed to it.
 * @param {{ platform: string, execPath: string, helperPath: string, assistantId: string | number, home: string, path?: string }} input
 * @returns {Array<{ how: 'systemd-run' | 'detached', file: string, args: string[] }>}
 */
export function unboundRunStageCommands({ platform, execPath, helperPath, assistantId, home, path = '' }) {
  const id = validAssistantId(assistantId)
  if (!id || String(assistantId).trim() !== id) return []
  const run = [helperPath, '--stage', 'run', '--assistant', id, '--home', home]
  const detached = { how: 'detached', file: execPath, args: run }
  const setenv = [`--setenv=HOME=${home}`, ...(path ? [`--setenv=PATH=${path}`] : [])]
  if (platform === 'linux') return [{ how: 'systemd-run', file: 'systemd-run', args: ['--user', '--collect', '--quiet', ...setenv, '--', execPath, ...run] }, detached]
  return [detached]
}

/**
 * The socket side of the notice: what the daemon does with each
 * `assistant_unbound` frame. It never calls the ack the backend passes with a
 * replay (see the header). A frame that lands before the daemon is armed (the
 * replay rides the connect, which at boot comes first) is held when it is this
 * agent's own, and handed over once the daemon arms; another agent's never
 * takes its place. A passive daemon never arms, so it never acts.
 * @param {{ isArmed: () => boolean, own: { assistantId: unknown, pairingId: unknown }, handle: (payload: unknown) => void }} deps
 */
export function createUnboundFrameRouter({ isArmed, own, handle }) {
  let held = null
  return {
    /**
     * @param {unknown} payload the frame
     * @param {unknown} [_ack] the backend's ack for a replay, never called on purpose
     */
    onFrame(payload, _ack) {
      if (isArmed()) {
        handle(payload)
        return 'handled'
      }
      if (!judgeUnboundNotice(payload, own).act) return 'dropped'
      held = payload
      return 'held'
    },
    /** Call right after the daemon arms; true when a held notice was handed over. */
    onArmed() {
      if (held == null) return false
      const payload = held
      held = null
      handle(payload)
      return true
    },
  }
}
