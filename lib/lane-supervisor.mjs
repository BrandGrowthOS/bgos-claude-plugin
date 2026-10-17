/**
 * PERSON LANES, the supervisor of ONE lane (shared agents Phase 3, P3; design
 * 4.2 "When a lane starts", "Idle stop", "Caps", "Crash mid turn").
 *
 * bin/hoai-lane.mjs runs this, detached, when the owner's daemon receives a
 * `lane_wake` for a person whose lane is down. The supervisor is the OWNER's
 * process: it may read the owner's login mode file and the credential store,
 * but nothing it hands the lane carries the pairing token, and the lane's
 * environment is an allow list (lib/lane-core.mjs laneChildEnv).
 *
 *   1. SINGLETON: the lane's lock file. A second supervisor for the same
 *      person finds the first alive and leaves, so two wakes never start two
 *      Claudes for one lane.
 *   2. LOGIN (K2): `inherit` or `own_token`. An own token that is missing
 *      never falls back: Claude is not started, the lane daemon runs once in
 *      notice mode to find the person's chat, and the owner's daemon posts the
 *      sentence there and reports `lane_failed`.
 *   3. CAPS, under the machine registry's lock: 2 lanes per agent, a ceiling
 *      per machine from available memory; over a cap the least recently used
 *      IDLE lane is asked to stop, and with every lane busy the answer is
 *      `lane_busy` (never another lane).
 *   4. LAUNCH: the lane's files (settings, mcp config, pin), then `claude`
 *      under expect with the locked argv (laneLaunchArgsFor), so the
 *      development channels screen is answered as the owner's is, in a pty
 *      of its own (never the owner's pane).
 *   5. WATCH: a stop request (the owner's daemon on revoke or eviction, the
 *      lane daemon on revoke, a refused login or a lost session) or idleness
 *      (lane.json, 20 minutes, no turn in flight) stops the lane; Claude
 *      exiting on its own is a crash, relaunched with the SAME pin at most 3
 *      times an hour, else `lane_failed`.
 *
 * Every effect is a parameter, so tests drive it with fakes.
 *
 * No em or en dashes in this file.
 */
import * as nodeFs from 'node:fs'
import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

import {
  availableBytesFromMeminfo,
  availableBytesFromVmStat,
  decideLaneCaps,
  decideLaneIdle,
  decideLaneRelaunch,
  laneChildEnv,
  laneDaemonEnv,
  laneEventLine,
  laneLaunchArgsFor,
  laneMachineCeiling,
  laneMcpConfigBody,
  lanePaths,
  laneSessionArgs,
  laneSettingsBody,
  LANE_ENV_KEEP,
  LANE_LOGIN_OWN_TOKEN,
  readLaneState,
} from './lane-core.mjs'
import { laneConfigSeed, laneTokenStore, loginModeFor, resolveLaneLogin } from './lane-login.mjs'
import { acquireLaneLock, isLiveSupervisor, releaseLaneLock, updateRegistry } from './lane-registry.mjs'
import {
  buildGateAutoAcceptExpect,
  ensurePinnedSessionId,
  EXIT_SUPERVISED_SIGNED_OUT,
  sessionTranscriptPath,
  tclQuote,
} from '../bin/hoai-core.mjs'

/**
 * The shared expect builder brace-quotes each argument with no escaping and
 * puts the claude path in as a bare word (security review finding 5). The
 * lane hands it a Tcl-quoted path and refuses any argument a brace word cannot
 * carry, rather than change the owner's builder.
 */
export function laneArgsTclSafe(args) {
  return args.every((a) => !/[{}\\]/.test(String(a)))
}

/** How often the supervisor looks at its lane. */
export const LANE_WATCH_MS = 5_000
/** How long a stopped Claude gets before it is killed. */
export const LANE_STOP_GRACE_MS = 10_000
/** Failed starts (no session, wrong identity) that turn a stop into `lane_failed`. */
export const LANE_START_FAILURES_MAX = 3
export const LANE_START_FAILURES_WINDOW_MS = 60 * 60_000
/** How long the notice mode daemon may take. */
export const LANE_NOTICE_TIMEOUT_MS = 90_000

/** Stop reasons that mean the lane could not run, not that it was done. */
const START_FAILURE_REASONS = new Set(['no_session', 'identity'])

function writeJsonPrivate(fs, path, value) {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, path)
}

function readJson(fs, path) {
  try {
    return JSON.parse(String(fs.readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

/** The operating system's figure for memory it can hand out. */
export function defaultAvailableBytes({ platform = process.platform, run = spawnSync, fs = nodeFs } = {}) {
  try {
    if (platform === 'darwin') return availableBytesFromVmStat(String(run('vm_stat', [], { encoding: 'utf8', timeout: 5000 }).stdout ?? ''))
    if (platform === 'linux') return availableBytesFromMeminfo(String(fs.readFileSync('/proc/meminfo', 'utf8')))
  } catch { /* unknown: the ceiling is 1 */ }
  return 0
}

/** Start `expect -c <script>` for the lane's Claude, in its own pty. */
export function defaultSpawnExpect(script, { cwd, env, logPath, fs = nodeFs, spawn = nodeSpawn }) {
  let errFd = 'ignore'
  try { errFd = fs.openSync(logPath, 'a', 0o600) } catch { /* no log */ }
  const child = spawn('expect', ['-c', script], { cwd, env, stdio: ['ignore', 'ignore', errFd] })
  if (typeof errFd === 'number') try { fs.closeSync(errFd) } catch { /* closed */ }
  return child
}

/** Run the lane daemon once in notice mode (no Claude), and wait for it. */
export function defaultRunNotice({ nodePath, pluginRoot, env, cwd, spawn = nodeSpawn, timeoutMs = LANE_NOTICE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(nodePath, [join(pluginRoot, 'bin', 'bgos-launch.mjs'), join(pluginRoot, 'lane-server.ts')], { cwd, env, stdio: 'ignore' })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* gone */ }
    }, timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}

function minimalEnv(ownerEnv) {
  const env = {}
  for (const name of LANE_ENV_KEEP) {
    if (typeof ownerEnv?.[name] === 'string' && ownerEnv[name] !== '') env[name] = ownerEnv[name]
  }
  return env
}

/**
 * Supervise one lane until it stops.
 *
 * @param {{
 *   assistantId: string, userId: string, home: string, ownerEnv: Record<string, string | undefined>,
 *   backendUrl: string, pluginRoot: string, nodePath: string, claudePath: string,
 *   platform?: string, fs?: typeof nodeFs, now?: () => number, sleep?: (ms: number) => Promise<void>,
 *   spawnExpect?: typeof defaultSpawnExpect, runNotice?: typeof defaultRunNotice,
 *   availableBytes?: () => number, isAlive?: (pid: number) => boolean, selfPid?: number,
 *   tokenStore?: ReturnType<typeof laneTokenStore>, log?: (line: string) => void,
 *   watchMs?: number, stopGraceMs?: number, gateBlock?: string, generateId?: () => string,
 * }} o
 * @returns {Promise<{ outcome: 'already_running' | 'busy' | 'stopped' | 'failed', reason?: string }>}
 */
export async function superviseLane(o) {
  const fs = o.fs ?? nodeFs
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const platform = o.platform ?? process.platform
  const selfPid = o.selfPid ?? process.pid
  const isAlive = o.isAlive ?? ((pid) => isLiveSupervisor(pid))
  const log = o.log ?? (() => {})
  const watchMs = o.watchMs ?? LANE_WATCH_MS
  const stopGraceMs = o.stopGraceMs ?? LANE_STOP_GRACE_MS
  const spawnExpect = o.spawnExpect ?? defaultSpawnExpect
  const runNotice = o.runNotice ?? defaultRunNotice
  const availableBytes = o.availableBytes ?? (() => defaultAvailableBytes({ platform }))
  const paths = lanePaths({ home: o.home, assistantId: o.assistantId, userId: o.userId, stateRoot: o.ownerEnv?.BGOS_PLUGIN_STATE_DIR, platform })
  const tokenStore = o.tokenStore ?? laneTokenStore({ platform, fs, fileStoreDir: () => paths.stateDir })

  fs.mkdirSync(paths.workDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(paths.laneDir, 0o700) } catch { /* best effort */ }

  const lock = acquireLaneLock(paths.launcherLockPath, { fs, selfPid, isAlive })
  if (!lock.acquired) {
    log(`lane already supervised by pid ${lock.holderPid}`)
    return { outcome: 'already_running' }
  }

  const event = (e) => {
    try {
      fs.appendFileSync(paths.eventsPath, laneEventLine(e, new Date(now()).toISOString()), { mode: 0o600 })
    } catch (err) {
      log(`could not record ${e.event}: ${String(err)}`)
    }
  }
  const noticeEnv = (notice) => ({
    ...minimalEnv(o.ownerEnv),
    ...laneDaemonEnv({
      assistantId: o.assistantId,
      userId: o.userId,
      workDir: paths.workDir,
      laneDir: paths.laneDir,
      stateDir: paths.stateDir,
      backendUrl: o.backendUrl,
      loginMode: LANE_LOGIN_OWN_TOKEN,
    }),
    HOAI_LANE_NOTICE: notice,
  })
  let registered = false

  try {
    try { fs.unlinkSync(paths.stopRequestPath) } catch { /* none */ }
    // A revoke that landed while this supervisor was starting (only a fresh
    // wake clears the marker).
    if (fs.existsSync(paths.revokedPath)) {
      log('lane revoked; not starting')
      return { outcome: 'stopped', reason: 'revoked' }
    }

    // ── 2. Login (K2) ──
    const mode = loginModeFor(paths.loginModesPath, o.userId, { fs })
    const resolved = resolveLaneLogin({ mode, assistantId: o.assistantId, userId: o.userId, configDir: paths.configDir, store: tokenStore })
    if (!resolved.ok) {
      log(`lane login: ${resolved.notice} (${resolved.reason}); Claude is not started and the owner's login is not used`)
      await runNotice({ nodePath: o.nodePath, pluginRoot: o.pluginRoot, env: noticeEnv(resolved.notice), cwd: paths.workDir })
      event({ event: 'lane_failed' })
      return { outcome: 'failed', reason: resolved.notice }
    }
    const login = resolved.login

    // ── 3. Caps, under the machine registry's lock ──
    const decision = updateRegistry(paths.machineRegistryPath, (registry) => {
      const lanes = registry.lanes.map((l) => {
        let state = { lastActivityAtMs: null, inFlight: false }
        try {
          const lp = lanePaths({ home: o.home, assistantId: l.assistantId, userId: l.userId, stateRoot: o.ownerEnv?.BGOS_PLUGIN_STATE_DIR, platform })
          state = readLaneState(fs.readFileSync(lp.laneJsonPath, 'utf8'))
        } catch { /* no state yet: least recently used */ }
        const started = Date.parse(String(l.startedAt ?? ''))
        return {
          assistantId: l.assistantId,
          userId: l.userId,
          lastActivityAtMs: state.lastActivityAtMs ?? (Number.isFinite(started) ? started : 0),
          inFlight: state.inFlight,
        }
      })
      const caps = decideLaneCaps({ lanes, assistantId: o.assistantId, userId: o.userId, machineCeiling: laneMachineCeiling(availableBytes()) })
      if (caps.action === 'busy' || caps.action === 'running') return { result: caps }
      if (caps.action === 'evict') {
        try {
          const victim = lanePaths({ home: o.home, assistantId: caps.victim.assistantId, userId: caps.victim.userId, stateRoot: o.ownerEnv?.BGOS_PLUGIN_STATE_DIR, platform })
          writeJsonPrivate(fs, victim.stopRequestPath, { reason: 'evicted', at: new Date(now()).toISOString(), by: 'supervisor' })
        } catch (err) {
          log(`could not ask the evicted lane to stop: ${String(err)}`)
        }
      }
      const entry = { assistantId: String(o.assistantId), userId: o.userId, supervisorPid: selfPid, startedAt: new Date(now()).toISOString() }
      return { registry: { v: 1, lanes: [...registry.lanes, entry] }, result: caps }
    }, { fs, isAlive })
    if (decision.action === 'busy') {
      log(`lane busy: the ${decision.cap} cap is full of busy lanes`)
      event({ event: 'lane_busy' })
      return { outcome: 'busy', reason: decision.cap }
    }
    if (decision.action === 'running') {
      // A registry entry of a live supervisor for this very lane, while this
      // process holds the lane lock: impossible unless the files were edited.
      log('lane already listed as running; leaving it')
      return { outcome: 'already_running' }
    }
    registered = true
    if (decision.action === 'evict') log(`asked lane ${decision.victim.assistantId}/${decision.victim.userId} to stop for room`)

    // ── 4. The lane's files ──
    const laneEnv = laneChildEnv({
      ownerEnv: o.ownerEnv,
      platform,
      login,
      assistantId: o.assistantId,
      userId: o.userId,
      workDir: paths.workDir,
      laneDir: paths.laneDir,
      stateDir: paths.stateDir,
      backendUrl: o.backendUrl,
    })
    writeJsonPrivate(fs, paths.settingsPath, laneSettingsBody({
      workDir: paths.workDir,
      userId: o.userId,
      nodePath: o.nodePath,
      floorHookPath: join(o.pluginRoot, 'bin', 'hoai-lane-floor-hook.mjs'),
      platform,
    }))
    writeJsonPrivate(fs, paths.mcpPath, laneMcpConfigBody({
      nodePath: o.nodePath,
      pluginRoot: o.pluginRoot,
      platform,
      env: laneDaemonEnv({
        assistantId: o.assistantId,
        userId: o.userId,
        workDir: paths.workDir,
        laneDir: paths.laneDir,
        stateDir: paths.stateDir,
        backendUrl: o.backendUrl,
        loginMode: login.mode,
      }),
    }))
    if (login.mode === LANE_LOGIN_OWN_TOKEN) {
      const seedPath = join(paths.configDir, '.claude.json')
      writeJsonPrivate(fs, seedPath, laneConfigSeed({ workDir: paths.workDir, existing: readJson(fs, seedPath) }))
    }
    const pin = ensurePinnedSessionId({
      path: paths.sessionIdPath,
      readFile: (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } },
      writeFile: (p, c) => { try { fs.writeFileSync(p, `${c}\n`, { mode: 0o600 }); return true } catch { return false } },
      generateId: o.generateId ?? randomUUID,
    })
    if (!pin) throw new Error('could not write the lane\'s session pin')
    const configDirForTranscript = login.mode === LANE_LOGIN_OWN_TOKEN ? paths.configDir : (o.ownerEnv?.CLAUDE_CONFIG_DIR ?? '')
    const transcript = sessionTranscriptPath(o.home, paths.workDir, pin, configDirForTranscript)

    // ── 5. Launch and watch ──
    let relaunchesAtMs = []
    for (;;) {
      const sessionArgs = laneSessionArgs(pin, fs.existsSync(transcript))
      // Under the person's own token the CLI's debug log is where a refused
      // token shows (the lane daemon reads it); emptied at every launch.
      const debugFile = login.mode === LANE_LOGIN_OWN_TOKEN ? paths.claudeDebugPath : undefined
      if (debugFile) {
        try { fs.writeFileSync(debugFile, '', { mode: 0o600 }) } catch { /* the CLI creates it */ }
      }
      const args = laneLaunchArgsFor({ mcpConfigPath: paths.mcpPath, settingsPath: paths.settingsPath, sessionArgs, debugFile })
      if (!laneArgsTclSafe(args)) {
        log('a lane argument holds a brace or a backslash; not launching')
        event({ event: 'lane_failed' })
        return { outcome: 'failed', reason: 'unsafe_args' }
      }
      const script = buildGateAutoAcceptExpect({
        claudePath: tclQuote(o.claudePath),
        args,
        ...(o.gateBlock !== undefined ? { gateBlock: o.gateBlock } : {}),
        supervised: { stateDir: paths.laneDir, interactive: false, compact: 'compact=off reason=lane' },
      })
      const startedAtMs = now()
      const child = spawnExpect(script, { cwd: paths.workDir, env: laneEnv, logPath: paths.launcherLogPath, fs })
      log(`lane started (pid ${child.pid ?? '?'}, ${sessionArgs[0]} ${pin}, login ${login.mode})`)
      const result = await watchLane({ child, paths, fs, now, sleep, startedAtMs, watchMs, stopGraceMs, log })
      if (result.kind === 'stop') {
        try { fs.unlinkSync(paths.stopRequestPath) } catch { /* gone */ }
        if (result.reason === 'login_failed') {
          event({ event: 'lane_failed' })
          return { outcome: 'failed', reason: result.reason }
        }
        if (START_FAILURE_REASONS.has(result.reason) && recordStartFailure({ fs, paths, now })) {
          event({ event: 'lane_failed' })
          return { outcome: 'failed', reason: result.reason }
        }
        event({ event: 'lane_stopped' })
        return { outcome: 'stopped', reason: result.reason }
      }
      if (result.code === EXIT_SUPERVISED_SIGNED_OUT) {
        // Claude came up signed out. Under the person's own token that is a
        // refused token: tell them, never retry on another login.
        log('lane Claude came up signed out')
        if (login.mode === LANE_LOGIN_OWN_TOKEN) {
          await runNotice({ nodePath: o.nodePath, pluginRoot: o.pluginRoot, env: noticeEnv('login_token_failed'), cwd: paths.workDir })
        }
        event({ event: 'lane_failed' })
        return { outcome: 'failed', reason: 'signed_out' }
      }
      const again = decideLaneRelaunch({ relaunchesAtMs, nowMs: now() })
      if (!again.relaunch) {
        log(`lane crashed ${relaunchesAtMs.length} times this hour; giving up`)
        event({ event: 'lane_failed' })
        return { outcome: 'failed', reason: 'crash_loop' }
      }
      relaunchesAtMs = again.recent
      log(`lane Claude exited (code ${String(result.code)}); relaunching with the same pin`)
    }
  } finally {
    if (registered) {
      try {
        updateRegistry(paths.machineRegistryPath, (registry) => ({
          registry: { v: 1, lanes: registry.lanes.filter((l) => !(String(l.assistantId) === String(o.assistantId) && l.userId === o.userId && l.supervisorPid === selfPid)) },
          result: null,
        }), { fs, isAlive })
      } catch (err) {
        log(`could not leave the registry: ${String(err)}`)
      }
    }
    releaseLaneLock(paths.launcherLockPath, { fs, selfPid })
  }
}

/** Count one failed start; true when they now reach the hourly budget. */
function recordStartFailure({ fs, paths, now }) {
  const path = join(paths.laneDir, 'start-failures.json')
  const nowMs = now()
  const prior = Array.isArray(readJson(fs, path)) ? readJson(fs, path) : []
  const recent = [...prior.filter((t) => Number.isFinite(t) && nowMs - t < LANE_START_FAILURES_WINDOW_MS), nowMs]
  try { writeJsonPrivate(fs, path, recent) } catch { /* best effort */ }
  return recent.length >= LANE_START_FAILURES_MAX
}

/**
 * Watch one running Claude. Resolves `{kind: 'stop', reason}` once a stop was
 * asked for (or idleness decided it) and Claude is gone, or
 * `{kind: 'exit', code}` when Claude exited on its own.
 */
export function watchLane({ child, paths, fs, now, sleep, startedAtMs, watchMs, stopGraceMs, log }) {
  return new Promise((resolve) => {
    let stopping = null
    let exited = false
    let exitCode = null
    child.on('exit', (code) => {
      exited = true
      exitCode = code
      if (stopping === null) resolve({ kind: 'exit', code })
    })
    child.on('error', (err) => {
      log(`lane spawn error: ${String(err?.message ?? err)}`)
      exited = true
      if (stopping === null) resolve({ kind: 'exit', code: null })
    })
    const stop = async (reason) => {
      if (stopping !== null || exited) return
      stopping = reason
      log(`stopping the lane: ${reason}`)
      try { child.kill('SIGTERM') } catch { /* gone */ }
      const deadline = now() + stopGraceMs
      while (!exited && now() < deadline) await sleep(Math.min(250, watchMs))
      if (!exited) {
        try { child.kill('SIGKILL') } catch { /* gone */ }
      }
      resolve({ kind: 'stop', reason, code: exitCode })
    }
    const look = async () => {
      while (!exited && stopping === null) {
        await sleep(watchMs)
        if (exited || stopping !== null) return
        const asked = readJson(fs, paths.stopRequestPath)
        if (asked) {
          await stop(typeof asked.reason === 'string' ? asked.reason : 'requested')
          return
        }
        let state = { lastActivityAtMs: null, inFlight: false, inFlightSinceMs: null }
        try { state = readLaneState(fs.readFileSync(paths.laneJsonPath, 'utf8')) } catch { /* not written yet */ }
        const idle = decideLaneIdle({ ...state, startedAtMs, nowMs: now() })
        if (idle.stop) {
          try {
            writeJsonPrivate(fs, paths.stopRequestPath, { reason: idle.reason, at: new Date(now()).toISOString(), by: 'supervisor' })
          } catch { /* the kill still stops it */ }
          await stop(idle.reason)
          return
        }
      }
    }
    void look()
  })
}
