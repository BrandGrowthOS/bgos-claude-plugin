/**
 * browser-host-supervisor: the daemon starts this machine's browser host for
 * its own pairing (bin/hoai-browser-host.mjs), and stops it when it exits.
 *
 * WHY THE DAEMON. server.ts already holds the pairing credentials, and until
 * now nothing started the host at all: a person had to run it by hand, so no
 * agent's browser could live where the agent lives.
 *
 * WHY UNCONDITIONALLY. The backend elects an agent host ONLY for an agent
 * whose browser placement is `daemon` (BGOS backend,
 * agent-browser-relay.service.ts: the election reads the placement row, :690,
 * through `daemonPlaced`, :786). A desktop-placed agent's host therefore never
 * receives a frame, so starting it on every paired daemon is safe BY
 * CONSTRUCTION, not by a flag someone has to remember to set. Chromium and
 * playwright-core load only on the first frame, so an idle host is one node
 * process (about 80 MB resident, measured on macOS) holding one socket. The one
 * exception is the kill switch, HOAI_BROWSER_HOST=off, which skips the spawn
 * entirely. A daemon with no pairing token (the legacy api-key lane) has
 * nothing to start: the host's handshake needs a pairing.
 *
 * ONE HOST PER PAIRING ON A MACHINE. Several daemons can share a pairing (a
 * pairing that backs several agents, or a stray session that resolved to the
 * same credentials). Each tries the reclaimable lock of lib/pairing-lock.ts,
 * at a path keyed by the pairing rather than by the credentials file (the
 * daemon's own channel lock is per credentials file, which is per agent, so it
 * cannot see a sibling agent of the same pairing). The holder spawns the host
 * and heartbeats the lock; the others wait and take over when the holder is
 * gone, exactly as the channel lock does.
 *
 * NEVER TAKES THE DAEMON DOWN. A spawn that throws, a spawn error event (node
 * missing at that path), a host that crashes or exits: each is logged, the
 * lock is released so a sibling daemon can take over, and this daemon carries
 * on without a host. It does not respawn one: a host that died here is not
 * restarted by the daemon that saw it die.
 *
 * DETACHED FROM STDIO. The daemon's stdout is its MCP channel, so the child
 * never inherits it: stdin is ignored and the host's output goes to its own
 * log file next to the lock. It stays in the daemon's process group and is
 * stopped with SIGTERM when the daemon exits (the host closes Chrome cleanly
 * on SIGTERM); if the daemon is killed outright, the host notices the
 * daemon's pid is gone (HOAI_BROWSER_HOST_PARENT_PID) and stops itself.
 *
 * No credential is logged; the lock and log names carry a digest, never the
 * token.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  LOCK_HEARTBEAT_INTERVAL_MS,
  acquirePairingLock,
  defaultLockIo,
  lockStalenessMs,
  parseLockRecord,
  refreshPairingLockDetailed,
  releasePairingLock,
  type LockIo,
} from './pairing-lock.js'

/** The kill switch. `off` (or 0, false, no; any case) skips the spawn. */
export const BROWSER_HOST_KILL_SWITCH_ENV = 'HOAI_BROWSER_HOST'

/** How often a daemon without the host lock checks whether it can take it. */
export const BROWSER_HOST_RECHECK_MS = 15_000

/** Names that look like a credential; the host is given none of them. */
const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_?KEY)/i

/**
 * The daemon's environment as the host gets it: without the daemon's own
 * BGOS_ settings and without anything named like a credential. The host
 * needs PATH, HOME and its own HOAI_ settings; the one secret it needs, the
 * pairing token, is added explicitly by the caller.
 */
export function hostEnv(env: Env): Env {
  const out: Env = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || /^BGOS_/i.test(k) || SECRET_ENV_NAME.test(k)) continue
    out[k] = v
  }
  return out
}

/** The host's log is rotated to `.1` once it passes this at spawn time. */
export const BROWSER_HOST_LOG_MAX_BYTES = 5 * 1024 * 1024

/** The env the daemon hands the host so it serves this pairing only. */
export const HOST_ENV = {
  pairingToken: 'HOAI_BROWSER_HOST_PAIRING_TOKEN',
  backendUrl: 'HOAI_BROWSER_HOST_BACKEND_URL',
  assistantId: 'HOAI_BROWSER_HOST_ASSISTANT_ID',
  parentPid: 'HOAI_BROWSER_HOST_PARENT_PID',
} as const

type Env = Record<string, string | undefined>

/** True when HOAI_BROWSER_HOST says off. Unset or anything else means on. */
export function browserHostKillSwitchOn(env: Env): boolean {
  const value = String(env[BROWSER_HOST_KILL_SWITCH_ENV] ?? '')
    .trim()
    .toLowerCase()
  return value === 'off' || value === '0' || value === 'false' || value === 'no'
}

/** The backend root, as the host and the socket use it (no /api/v1). */
function backendBase(url: string): string {
  return String(url ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/v1$/, '')
}

/**
 * The pairing's name on disk: a digest of the backend and the pairing token,
 * the two things every daemon of one pairing shares. Never the token itself.
 */
export function browserHostPairingKey(backendUrl: string, pairingToken: string): string {
  return createHash('sha256').update(`${backendBase(backendUrl)}\n${pairingToken}`).digest('hex').slice(0, 16)
}

export function browserHostLockPath(agentRoot: string, key: string): string {
  return join(agentRoot, `browser-host-${key}.lock`)
}

export function browserHostLogPath(agentRoot: string, key: string): string {
  return join(agentRoot, `browser-host-${key}.log`)
}

/** Opens the host's log for append (rotating a large one), or 'ignore'. */
function openHostLog(path: string): number | 'ignore' {
  try {
    try {
      if (statSync(path).size > BROWSER_HOST_LOG_MAX_BYTES) renameSync(path, `${path}.1`)
    } catch {}
    return openSync(path, 'a', 0o600)
  } catch {
    return 'ignore'
  }
}

export type BrowserHostState = 'off' | 'waiting' | 'running' | 'ended'

export interface BrowserHostSupervisor {
  /** off: never started (kill switch, no pairing, no node). waiting: another
   *  daemon holds the pairing's host. running: this daemon's child is up.
   *  ended: this daemon's child is gone and it will not start another. */
  readonly state: BrowserHostState
  readonly child: ChildProcess | null
  readonly lockPath: string | null
  /** Stops the host (SIGTERM) and releases the lock. Safe to call twice, and
   *  synchronous, so the daemon's process 'exit' hook can call it. */
  stop(): void
}

export interface BrowserHostSupervisorOptions {
  /** The daemon's environment; the host gets hostEnv() of it. */
  env: Env
  auth: { mode: string; complete: boolean; backendUrl: string; pairingToken: string; assistantId: string }
  /** ~/.bgos-agent: where the lock and the host's log live. */
  agentRoot: string
  /** bin/hoai-browser-host.mjs of this plugin. */
  hostScript: string
  /** The node binary (lib/watcher-install.mjs resolveNodePath), or null. */
  nodePath: string | null
  log: (line: string) => void
  selfPid?: number
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  lockIo?: LockIo
  now?: () => number
  heartbeatMs?: number
  recheckMs?: number
  openLog?: (path: string) => number | 'ignore'
}

/**
 * Starts the supervisor and returns its handle. Never throws: whatever goes
 * wrong is a log line and a state, never an exception into the daemon.
 */
export function startBrowserHostSupervisor(opts: BrowserHostSupervisorOptions): BrowserHostSupervisor {
  const log = (line: string) => {
    try {
      opts.log(`browser host: ${line}`)
    } catch {}
  }
  let state: BrowserHostState = 'off'
  let child: ChildProcess | null = null
  let lockPath: string | null = null
  let stopping = false
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let recheck: ReturnType<typeof setInterval> | null = null
  let saidWaiting = false
  // The heartbeat of a live but stale holder, as first seen (see tryStart).
  let staleSeen: number | null = null

  const handle: BrowserHostSupervisor = {
    get state() {
      return state
    },
    get child() {
      return child
    },
    get lockPath() {
      return lockPath
    },
    stop,
  }

  if (browserHostKillSwitchOn(opts.env)) {
    log(`off (${BROWSER_HOST_KILL_SWITCH_ENV}=${opts.env[BROWSER_HOST_KILL_SWITCH_ENV]}); not started`)
    return handle
  }
  const { auth } = opts
  if (auth.mode !== 'pairing' || !auth.complete || !auth.pairingToken) {
    log('not started: the host connects with a pairing token, and this daemon has none')
    return handle
  }
  if (!opts.nodePath) {
    log('not started: node was not found on PATH (the host runs under node); the daemon carries on without it')
    return handle
  }

  const selfPid = opts.selfPid ?? process.pid
  const now = opts.now ?? Date.now
  const spawn = opts.spawn ?? nodeSpawn
  const nodePath = opts.nodePath
  const key = browserHostPairingKey(auth.backendUrl, auth.pairingToken)
  lockPath = browserHostLockPath(opts.agentRoot, key)
  const logPath = browserHostLogPath(opts.agentRoot, key)
  try {
    mkdirSync(opts.agentRoot, { recursive: true, mode: 0o700 })
  } catch {}

  const io = opts.lockIo ?? defaultLockIo
  state = 'waiting'
  tryStart()
  if (state === 'waiting') startRecheck()
  return handle

  function startRecheck(): void {
    if (recheck) return
    recheck = setInterval(() => {
      if (state === 'waiting') tryStart()
    }, opts.recheckMs ?? BROWSER_HOST_RECHECK_MS)
    recheck.unref?.()
  }

  function tryStart(): void {
    // A holder that is ALIVE but has not beaten for the staleness window is
    // what every daemon on a machine that just woke from sleep looks like,
    // until the holder's own timer fires. Reclaiming then would start a
    // second host beside the first. So a live holder's stale lock is taken
    // only when the SAME stale heartbeat is still there a full recheck later;
    // a dead holder's lock is taken at once, as pairing-lock.ts does.
    try {
      const held = parseLockRecord(io.readText(lockPath!))
      const staleButAlive =
        !!held && held.pid !== selfPid && now() - held.heartbeatAt >= lockStalenessMs() && io.isProcessAlive(held.pid)
      if (!staleButAlive) staleSeen = null
      else if (staleSeen !== held!.heartbeatAt) {
        staleSeen = held!.heartbeatAt
        return
      }
    } catch {
      return
    }
    const got = acquirePairingLock({ lockPath: lockPath!, selfPid, now: now(), bootedAt: now(), io: opts.lockIo })
    if (!got.acquired) {
      if (!saidWaiting) {
        saidWaiting = true
        log(`this pairing's host is already run by the daemon with pid ${got.holderPid ?? '?'}; taking over if it goes`)
      }
      return
    }
    if (recheck) clearInterval(recheck)
    recheck = null
    spawnHost()
  }

  function spawnHost(): void {
    const out = (opts.openLog ?? openHostLog)(logPath)
    let started: ChildProcess
    try {
      started = spawn(nodePath, [opts.hostScript], {
        stdio: ['ignore', out, out],
        env: {
          ...hostEnv(opts.env),
          [HOST_ENV.pairingToken]: auth.pairingToken,
          [HOST_ENV.backendUrl]: auth.backendUrl,
          [HOST_ENV.assistantId]: String(auth.assistantId),
          [HOST_ENV.parentPid]: String(selfPid),
        },
        windowsHide: true,
      })
    } catch (err) {
      end(`could not start (${errText(err)})`)
      return
    } finally {
      if (typeof out === 'number') {
        try {
          closeSync(out)
        } catch {}
      }
    }
    child = started
    state = 'running'
    // A missing binary arrives here, not as a throw: without this listener
    // the error event would be thrown into the daemon. Both only speak for the
    // CURRENT child: one stood down earlier is allowed to exit quietly.
    started.on('error', (err) => {
      if (child === started) end(`failed (${errText(err)})`)
    })
    started.on('exit', (code, signal) => {
      if (child === started) end(`exited (code ${code ?? '-'}, signal ${signal ?? '-'})`)
    })
    started.unref()
    heartbeat = setInterval(refresh, opts.heartbeatMs ?? LOCK_HEARTBEAT_INTERVAL_MS)
    heartbeat.unref?.()
    // No pid means the spawn already failed; its error event says so.
    if (started.pid !== undefined) log(`started (pid ${started.pid}) for this pairing; its log is ${logPath}`)
  }

  function refresh(): void {
    const outcome = refreshPairingLockDetailed({ lockPath: lockPath!, selfPid, now: now(), io: opts.lockIo })
    if (outcome.held) return
    // Another daemon reclaimed the pairing's host (our heartbeat stalled,
    // for instance while the machine slept): two hosts for one pairing is
    // what the lock exists to stop, so ours goes. This daemon was not the
    // one that failed, so it waits to take the host back if that one goes.
    log(`the daemon with pid ${outcome.holderPid ?? '?'} took this pairing's host over; stopping ours and waiting to take it back`)
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    stopChild()
    child = null
    state = 'waiting'
    saidWaiting = true
    staleSeen = null
    startRecheck()
  }

  function end(reason: string): void {
    if (state === 'ended') return
    state = 'ended'
    if (heartbeat) clearInterval(heartbeat)
    if (recheck) clearInterval(recheck)
    heartbeat = null
    recheck = null
    if (lockPath) releasePairingLock({ lockPath, selfPid, io: opts.lockIo })
    if (!stopping) log(`${reason}; the daemon carries on without it and does not restart it`)
  }

  function stopChild(): void {
    const c = child
    if (c && c.exitCode === null && c.signalCode === null) {
      try {
        c.kill('SIGTERM')
      } catch {}
    }
  }

  function stop(): void {
    if (stopping) return
    stopping = true
    stopChild()
    end('stopped with the daemon')
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
