/**
 * Reclaimable single-instance pairing lock + beacon heartbeat (0.38.6).
 *
 * THE BUG (board 01a05185, confirmed on a live fleet). On a host where one
 * clone holds the sole credentials file, credentials resolution picks that
 * file via the 'sole-per-assistant' rule for ANY session started under the
 * same OS user with no identity pin: KC's own plain `claude` sessions, a
 * default-config subagent, a stray shell. Each such session's daemon resolves
 * to the SAME pairing and connects its own pairing WebSocket, so several
 * daemons join one Socket.IO pairing room. Server-side dispatch broadcasts to
 * every socket in that room; a daemon whose session is not the intended
 * chat's owner answers with "Rejected dispatch to unauthorized chat_id" and
 * DROPS the message. The real agent is one of the room members but not
 * necessarily the one the broadcast reaches first, so the user's message can
 * be swallowed by a rival while the real agent's process sits there healthy
 * and unreachable. Nothing in the logs of the real agent shows a problem.
 *
 * THE FIX. Before a daemon connects its pairing WebSocket it must first hold
 * an exclusive, RECLAIMABLE lock keyed to the resolved credentials file (a
 * `<credentials>.lock` sibling). Exactly one daemon per pairing holds it and
 * connects; every other daemon stays PASSIVE, keeping its MCP tool surface up
 * (so the session is still usable) but NEVER joining the pairing room and
 * NEVER touching the pairing.
 *
 * WHY NOT A NAIVE flock. A plain first-come OS lock is WRONG here. During a
 * boot storm a 30-second transient subagent can grab the lock a beat before
 * the real long-lived session boots, and a naive lock would then keep the
 * real agent out for the transient's whole life (and forever if the transient
 * dies holding a non-reclaimable lock). So the lock is HEARTBEAT-BASED and
 * RECLAIMABLE: the holder stamps its pid plus a heartbeat timestamp and
 * refreshes it on the existing poll tick; a rival reclaims a lock whose holder
 * has plainly gone (its pid is dead, or its heartbeat is older than the
 * staleness window), and only defers to a lock that is demonstrably still
 * alive. Reclaim-when-gone, not first-come-forever, is the whole point.
 *
 * The staleness window is 3x the heartbeat interval (LOCK_STALENESS_WINDOWS):
 * a live holder refreshing every interval never approaches it, while a holder
 * that stopped refreshing is reclaimed after three missed beats even when its
 * pid was reused by an unrelated process (the case pid-liveness alone cannot
 * see). The two reclaim triggers are complementary: pid-death gives INSTANT
 * takeover when a transient exits cleanly-or-not, and staleness is the
 * backstop against a stale record whose pid now points at something else.
 *
 * CHANNEL TAKEOVER (0.63.2, assistant 873). Two daemons for one pairing can
 * run in ONE session: a clone loaded as the session's channel and the
 * marketplace plugin enabled globally, whose channel that session never
 * registered. Whichever won the lock owned the pairing, and when the plugin
 * won every inbound message went into a channel Claude Code drops. So each
 * daemon records whether its channel is loaded (lib/channel-presence.ts,
 * read off the claude command line), and decideLockAction lets a daemon whose
 * channel IS loaded take the lock from a live holder that recorded
 * channelLoaded=false. Never the other way round, and an unknown on either
 * side (null, or a record from an older daemon without the field) keeps the
 * rules above exactly as they were.
 *
 * ROUTE TAKEOVER (0.65.0, board fc75c7c3). The lock picked whoever came
 * first, and on a one agent computer whose agent was down that was any Claude
 * Code session in a folder with no pin: it found the agent by elimination and
 * kept the channel while the real agent, started from its pinned folder, sat
 * passive behind it. So each daemon also records its ROUTE, one word: 'pin'
 * (a folder pin), 'env' (BGOS_ASSISTANT_ID or BGOS_CREDENTIALS_PATH) or
 * 'elimination' (lib/agent-credentials.ts lockRouteFor). A pinned daemon (pin
 * or env) takes the lock from a live holder that came by elimination. It never
 * takes it from a holder pinned to this same agent, so two pinned sessions
 * never take it from each other (Data's guard), and a daemon that came by
 * elimination never takes it from a pinned holder, not even through the
 * channel rule, so the two cannot flap. A record without a route (0.64.x) is
 * unknown and never taken over by route, and a daemon whose channel is proven
 * not loaded never takes a live channel, as before. No folder is stored.
 *
 * This module is the PURE core (decideLockAction, the staleness maths, the
 * serialize/parse pair, the heartbeat throttle) plus a thin, fully-injectable
 * effectful shell (acquire / refresh / release / touchBeaconHeartbeat). All
 * filesystem and process-liveness access is behind LockIo so the logic is
 * testable with no real files and no real processes. It never logs or echoes
 * any credential: the lock records only a pid, timestamps, the channel flag
 * and the route word.
 */

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'

import type { IdentityRoute } from './agent-credentials.js'

/** The three route words a lock record may carry; anything else is dropped. */
const LOCK_ROUTES: ReadonlySet<string> = new Set(['pin', 'env', 'elimination'])

function isLockRoute(value: unknown): value is IdentityRoute {
  return typeof value === 'string' && LOCK_ROUTES.has(value)
}

/** Pinned to this agent: a folder pin or an env pin. */
function isPinnedRoute(route: IdentityRoute | null | undefined): boolean {
  return route === 'pin' || route === 'env'
}

/**
 * How often the holder refreshes its heartbeat. Tied to the daemon's existing
 * poll tick (2s) rather than a timer of its own; the throttle below means the
 * refresh actually lands roughly this often regardless of tick cadence.
 */
export const LOCK_HEARTBEAT_INTERVAL_MS = 5_000

/**
 * A lock is stale (reclaimable on the timestamp alone) once its heartbeat is
 * this many heartbeat-intervals old. Three: a live holder that refreshes every
 * interval has to miss three beats before anyone reclaims it, which never
 * happens to a healthy process but resolves a genuinely dead one promptly.
 */
export const LOCK_STALENESS_WINDOWS = 3

/** The staleness window in ms for a given heartbeat interval. */
export function lockStalenessMs(intervalMs: number = LOCK_HEARTBEAT_INTERVAL_MS): number {
  return intervalMs * LOCK_STALENESS_WINDOWS
}

/**
 * The on-disk lock record. Deliberately minimal and secret-free: a pid and
 * two timestamps, nothing about the pairing itself (the FILE PATH carries the
 * pairing identity, so its contents never need to).
 */
export interface LockRecord {
  /** OS pid of the holder. */
  pid: number
  /** Epoch ms of the holder's most recent heartbeat refresh. */
  heartbeatAt: number
  /** Epoch ms the holder booted. Informational (log lines, tie-breaks). */
  bootedAt?: number
  /** Whether the holder's channel is loaded in its session. Absent when it
   *  could not tell (or predates 0.63.2): absent never invites a takeover. */
  channelLoaded?: boolean
  /** How the holder found its identity. Absent on a record written by 0.64.x,
   *  which is unknown and never taken over by route. */
  route?: IdentityRoute
}

/** Why a daemon may take the lock. 'channel-takeover': a live holder whose
 *  channel is not loaded gives way to one whose channel is. 'route-takeover':
 *  a live holder that came by elimination gives way to a pinned daemon. */
export type AcquireReason =
  | 'unlocked'
  | 'own'
  | 'holder-dead'
  | 'stale'
  | 'channel-takeover'
  | 'route-takeover'

type TakeoverReason = 'channel-takeover' | 'route-takeover'

/**
 * What a booting (or rechecking) daemon should do about the lock it found.
 *   acquire -> this daemon may take the lock and connect its pairing WS.
 *   passive -> another daemon demonstrably holds it; stay off the pairing.
 * `holderPid` rides on a channel takeover (whom we took it from) and on
 * passive; `holderChannelLoaded` on passive, so the banner can say why.
 */
export type LockDecision =
  | { action: 'acquire'; reason: Exclude<AcquireReason, TakeoverReason> }
  | { action: 'acquire'; reason: TakeoverReason; holderPid: number }
  | {
      action: 'passive'
      holderPid: number
      holderChannelLoaded?: boolean
      holderRoute?: IdentityRoute
    }

/**
 * Parse a lock file's raw contents into a LockRecord, or null when the file is
 * absent, empty, malformed, or missing a usable pid / heartbeat. A null result
 * is treated by decideLockAction exactly like an unlocked pairing, so junk on
 * disk never wedges a daemon into permanent passivity.
 */
export function parseLockRecord(raw: string | null | undefined): LockRecord | null {
  if (raw == null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  const pid = Number(obj.pid)
  const heartbeatAt = Number(obj.heartbeatAt)
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (!Number.isFinite(heartbeatAt) || heartbeatAt < 0) return null
  const bootedAt = Number(obj.bootedAt)
  return {
    pid,
    heartbeatAt,
    ...(Number.isFinite(bootedAt) && bootedAt >= 0 ? { bootedAt } : {}),
    // Only a real boolean counts: a string "false" from a hand edit must not
    // turn a live holder into a takeover target.
    ...(typeof obj.channelLoaded === 'boolean' ? { channelLoaded: obj.channelLoaded } : {}),
    // Only the three words count, exactly: anything else reads as unknown,
    // which is never taken over by route.
    ...(isLockRoute(obj.route) ? { route: obj.route } : {}),
  }
}

/** Serialize a lock record for the disk. Pretty-printed for human debugging. */
export function serializeLockRecord(record: LockRecord): string {
  const out: LockRecord = {
    pid: record.pid,
    heartbeatAt: record.heartbeatAt,
    ...(record.bootedAt != null ? { bootedAt: record.bootedAt } : {}),
    ...(typeof record.channelLoaded === 'boolean' ? { channelLoaded: record.channelLoaded } : {}),
    ...(isLockRoute(record.route) ? { route: record.route } : {}),
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

/**
 * THE PURE DECISION. Given the lock currently on disk (or null), decide
 * whether this daemon may acquire it or must stay passive.
 *
 *   - No record on disk           -> acquire ('unlocked').
 *   - Record is our own pid       -> acquire ('own'); a re-acquire refreshes.
 *   - Heartbeat older than window -> acquire ('stale'); the holder stopped
 *                                    refreshing (backstop, survives pid reuse).
 *   - Heartbeat fresh, holder pid
 *     no longer a live process    -> acquire ('holder-dead'); instant takeover
 *                                    when a transient exits.
 *   - Heartbeat fresh, holder alive,
 *     holder came by elimination,
 *     we are pinned (pin or env),
 *     and our channel is not
 *     proven unloaded             -> acquire ('route-takeover').
 *   - Heartbeat fresh, holder alive,
 *     holder recorded channelLoaded
 *     false, and OUR channel is
 *     loaded (selfChannelLoaded
 *     true), unless we came by
 *     elimination and the holder
 *     is pinned                   -> acquire ('channel-takeover').
 *   - Heartbeat fresh AND holder
 *     pid alive                   -> passive; a real daemon is on this pairing.
 *
 * The takeover needs BOTH sides proven: the holder's false and our true. A
 * null on our side, or a holder record without the field, is passive exactly
 * as before, which is the fail open rule. A daemon whose channel is not
 * loaded never takes over from anyone alive, so a channel-loaded holder (or
 * one that just took over) keeps the lock.
 *
 * The route takeover needs both sides proven too: our route pinned and the
 * holder's 'elimination'. A holder pinned to this same agent (pin or env) is
 * never taken over by route, and a holder with no route (0.64.x) is unknown.
 * Neither takeover can undo the other: a route takeover leaves an elimination
 * daemon behind, which may not take the lock back from a pinned holder by the
 * channel rule, and a channel takeover's loser is proven unloaded, which may
 * not take a live channel by route.
 *
 * Staleness is checked BEFORE pid-liveness on purpose: a stale record whose
 * pid was recycled by some unrelated process would look "alive" to a pid probe
 * and wrongly pin us passive, so the timestamp gets the first and final say on
 * the backstop path.
 */
export function decideLockAction(input: {
  existing: LockRecord | null
  now: number
  selfPid: number
  stalenessMs: number
  isHolderAlive: (pid: number) => boolean
  /** This daemon's channel presence: true / false when proven, null or
   *  absent when unknown (today's behaviour). */
  selfChannelLoaded?: boolean | null
  /** How this daemon found its identity; absent is unknown (no takeover). */
  selfRoute?: IdentityRoute | null
}): LockDecision {
  const { existing, now, selfPid, stalenessMs, isHolderAlive } = input
  if (!existing) return { action: 'acquire', reason: 'unlocked' }
  if (existing.pid === selfPid) return { action: 'acquire', reason: 'own' }
  if (now - existing.heartbeatAt >= stalenessMs) {
    return { action: 'acquire', reason: 'stale' }
  }
  if (!isHolderAlive(existing.pid)) {
    return { action: 'acquire', reason: 'holder-dead' }
  }
  const selfPinned = isPinnedRoute(input.selfRoute)
  if (selfPinned && existing.route === 'elimination' && input.selfChannelLoaded !== false) {
    return { action: 'acquire', reason: 'route-takeover', holderPid: existing.pid }
  }
  const strayOverPinned = input.selfRoute === 'elimination' && isPinnedRoute(existing.route)
  if (input.selfChannelLoaded === true && existing.channelLoaded === false && !strayOverPinned) {
    return { action: 'acquire', reason: 'channel-takeover', holderPid: existing.pid }
  }
  return {
    action: 'passive',
    holderPid: existing.pid,
    ...(typeof existing.channelLoaded === 'boolean' ? { holderChannelLoaded: existing.channelLoaded } : {}),
    ...(existing.route ? { holderRoute: existing.route } : {}),
  }
}

/**
 * Heartbeat throttle. The refresh is driven from the 2s poll tick, but it need
 * not (and should not) write the file every tick. True when at least one
 * interval has elapsed since the last successful refresh, or none has happened
 * yet. Pure so both the lock heartbeat and the beacon heartbeat share it.
 */
export function shouldHeartbeatNow(input: {
  lastAt: number | null
  now: number
  intervalMs: number
}): boolean {
  if (input.lastAt === null) return true
  return input.now - input.lastAt >= input.intervalMs
}

/** The lock file path for a resolved credentials file. */
export function pairingLockPath(credentialsPath: string): string {
  return `${credentialsPath}.lock`
}

// ── Effectful shell (all IO behind LockIo, defaulted to the real world) ───────

/**
 * Every filesystem / process touch this module makes, behind one injectable
 * seam. `writeFile` overwrites (reclaim is last-writer-wins, verified by a
 * read-back below); `isProcessAlive` answers the pid-liveness question.
 */
export interface LockIo {
  readText(path: string): string | null
  writeFile(path: string, data: string): void
  unlink(path: string): void
  isProcessAlive(pid: number): boolean
  /** Create the file ONLY if it does not exist. True when this call created it.
   *  This is what makes an unlocked-file race first-writer-wins rather than
   *  last-writer-wins; read-then-write cannot decide a simultaneous race. */
  tryCreateExclusive(path: string, data: string): boolean
}

/** True when a signal-0 to `pid` finds a live process. EPERM counts as alive
 *  (the process exists, we simply may not signal it); ESRCH means it is gone. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/** The real-world LockIo: node:fs plus processAlive. */
export const defaultLockIo: LockIo = {
  readText(path: string): string | null {
    try {
      return readFileSync(path, 'utf8')
    } catch (err) {
      // ONLY a missing file reads as null, because null means "no lock on
      // disk" to decideLockAction, which then hands the pairing to whoever
      // asked. Swallowing every read error meant a lock file we merely could
      // not read (EACCES, an EISDIR from a stray directory at that path, a
      // transient share violation on Windows) was overwritten as ours while a
      // live holder kept using it: the dual-holder bug through the back door.
      // Everything else throws on to the callers, whose try/catch already turn
      // it into { acquired: false } or { held: true, ioError }, so the daemon
      // still never dies over a lock read.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw err
    }
  },
  writeFile(path: string, data: string): void {
    writeFileSync(path, data)
  },
  unlink(path: string): void {
    try {
      unlinkSync(path)
    } catch {
      // Already gone, or not ours to remove: never throw over a lock unlink.
    }
  },
  isProcessAlive: processAlive,
  tryCreateExclusive(path: string, data: string): boolean {
    try {
      // 'wx' fails with EEXIST rather than truncating an existing file.
      writeFileSync(path, data, { flag: 'wx' })
      return true
    } catch {
      return false
    }
  },
}

export interface AcquireResult {
  acquired: boolean
  /** The reason we acquired (when acquired), for the boot log line. */
  reason?: AcquireReason
  /** The pid we deferred to (when passive), the pid that beat us in a race,
   *  or (on a channel takeover) the pid we took the lock from. */
  holderPid?: number
  /** What the holder we deferred to recorded about its channel, when it did. */
  holderChannelLoaded?: boolean
  /** The route the holder we deferred to recorded, when it did. */
  holderRoute?: IdentityRoute
}

/**
 * Try to take the lock. Reads the current record, runs decideLockAction, and
 * on 'acquire' writes our record then READS IT BACK to confirm we won: if two
 * daemons reclaim the same stale/dead lock in the same instant, the last write
 * wins and the loser sees a foreign pid on read-back and yields (it will
 * recheck later and reclaim if that winner turns out to be a dying transient).
 * This converges to exactly one holder without needing a real OS lock. Never
 * throws: any IO failure yields a non-acquire so the caller can degrade.
 */
export function acquirePairingLock(input: {
  lockPath: string
  selfPid: number
  now: number
  bootedAt?: number
  stalenessMs?: number
  /** This daemon's channel presence, recorded in the lock and used for the
   *  takeover rule. null / absent: unknown, nothing recorded. */
  channelLoaded?: boolean | null
  /** How this daemon found its identity, recorded in the lock and used for
   *  the route takeover. null / absent: unknown, nothing recorded. */
  route?: IdentityRoute | null
  io?: LockIo
}): AcquireResult {
  const io = input.io ?? defaultLockIo
  const stalenessMs = input.stalenessMs ?? lockStalenessMs()
  const ours = (): string =>
    serializeLockRecord({
      pid: input.selfPid,
      heartbeatAt: input.now,
      ...(input.bootedAt != null ? { bootedAt: input.bootedAt } : {}),
      ...(typeof input.channelLoaded === 'boolean' ? { channelLoaded: input.channelLoaded } : {}),
      ...(isLockRoute(input.route) ? { route: input.route } : {}),
    })
  // A lost race names the winner AND what it recorded about its channel and
  // route, so the passive banner can say why this daemon yields on that path too.
  const lostTo = (winner: LockRecord | null): AcquireResult => ({
    acquired: false,
    holderPid: winner?.pid,
    ...(typeof winner?.channelLoaded === 'boolean' ? { holderChannelLoaded: winner.channelLoaded } : {}),
    ...(winner?.route ? { holderRoute: winner.route } : {}),
  })
  try {
    const existing = parseLockRecord(io.readText(input.lockPath))
    const decision = decideLockAction({
      existing,
      now: input.now,
      selfPid: input.selfPid,
      stalenessMs,
      isHolderAlive: io.isProcessAlive.bind(io),
      selfChannelLoaded: input.channelLoaded,
      selfRoute: input.route,
    })
    if (decision.action === 'passive') {
      return {
        acquired: false,
        holderPid: decision.holderPid,
        ...(decision.holderChannelLoaded !== undefined
          ? { holderChannelLoaded: decision.holderChannelLoaded }
          : {}),
        ...(decision.holderRoute ? { holderRoute: decision.holderRoute } : {}),
      }
    }
    if (decision.reason === 'unlocked') {
      // Nothing on disk: whoever creates the file first owns the pairing.
      const record = ours()
      if (io.tryCreateExclusive(input.lockPath, record)) {
        return { acquired: true, reason: decision.reason }
      }
      // A rival created it in the same instant. Yield to whoever won.
      return lostTo(parseLockRecord(io.readText(input.lockPath)))
    }
    // A reclaim (own / stale / holder-dead / either takeover) overwrites
    // deliberately: the file exists and an exclusive create would always
    // fail. The read-back below is what decides a simultaneous reclaim. On a
    // takeover the old holder learns it on its next refresh, which finds our
    // pid and stands it down; its recheck then reads our channelLoaded=true
    // and stays passive.
    io.writeFile(input.lockPath, ours())
    const readback = parseLockRecord(io.readText(input.lockPath))
    if (readback && readback.pid === input.selfPid) {
      return {
        acquired: true,
        reason: decision.reason,
        ...(decision.reason === 'channel-takeover' || decision.reason === 'route-takeover'
          ? { holderPid: decision.holderPid }
          : {}),
      }
    }
    // Lost the write race: a rival overwrote us in the same instant. Yield to
    // it; our caller's recheck loop reclaims if it proves short-lived.
    return lostTo(readback)
  } catch {
    return { acquired: false }
  }
}

/** What a heartbeat refresh discovered. `held:false` carries the rival's pid so
 *  the caller can name it in a log line and stand down against it. `held:true`
 *  carries an `ioError` when the heartbeat could not actually be written: we
 *  keep the channel (a hiccup is not proof of reclaim) but the caller must be
 *  able to SAY so, because a holder whose writes keep failing goes stale after
 *  three intervals and is reclaimed while still believing it is the holder. */
export type RefreshOutcome =
  | { held: true; ioError?: string }
  | {
      held: false
      holderPid: number | undefined
      holderChannelLoaded?: boolean
      holderRoute?: IdentityRoute
    }

/**
 * Refresh our heartbeat and report what we found.
 *
 * `held:false` means a DIFFERENT pid holds the lock, so this daemon has been
 * reclaimed and must stop acting as the channel owner. We deliberately do NOT
 * re-stamp the file in that case: last-writer-wins here would let two daemons
 * ping-pong the lock forever, each believing it owns the channel, which is the
 * exact dual-holder bug this module exists to prevent.
 *
 * This USED to be documented as unreachable in steady state. It is not. On
 * 2026-09-04 a live host ran three daemons for one pairing and logged this
 * condition every six seconds for hours, because the caller treated it as a
 * warning and kept polling. See the plan's evidence section.
 *
 * Never throws.
 */
export function refreshPairingLockDetailed(input: {
  lockPath: string
  selfPid: number
  now: number
  bootedAt?: number
  /** Re-recorded on every refresh, so a takeover rival always reads it. */
  channelLoaded?: boolean | null
  /** Re-recorded on every refresh too, for the same reason. */
  route?: IdentityRoute | null
  io?: LockIo
}): RefreshOutcome {
  const io = input.io ?? defaultLockIo
  try {
    const existing = parseLockRecord(io.readText(input.lockPath))
    if (existing && existing.pid !== input.selfPid) {
      return {
        held: false,
        holderPid: existing.pid,
        ...(typeof existing.channelLoaded === 'boolean' ? { holderChannelLoaded: existing.channelLoaded } : {}),
        ...(existing.route ? { holderRoute: existing.route } : {}),
      }
    }
    io.writeFile(
      input.lockPath,
      serializeLockRecord({
        pid: input.selfPid,
        heartbeatAt: input.now,
        ...(input.bootedAt != null ? { bootedAt: input.bootedAt } : {}),
        ...(typeof input.channelLoaded === 'boolean' ? { channelLoaded: input.channelLoaded } : {}),
        ...(isLockRoute(input.route) ? { route: input.route } : {}),
      }),
    )
    return { held: true }
  } catch (err) {
    // A filesystem hiccup is not proof we were reclaimed. Claim we still hold
    // it: a false stand-down costs a live channel, a delayed stand-down costs
    // one duplicated poll cycle. The next refresh re-checks. The error rides
    // along so the caller can warn once instead of looking healthy forever.
    return { held: true, ioError: err instanceof Error ? err.message : String(err) }
  }
}

/** Boolean form, kept so existing callers and tests are unaffected. */
export function refreshPairingLock(input: {
  lockPath: string
  selfPid: number
  now: number
  bootedAt?: number
  channelLoaded?: boolean | null
  route?: IdentityRoute | null
  io?: LockIo
}): boolean {
  return refreshPairingLockDetailed(input).held
}

/**
 * Release the lock on graceful shutdown, but ONLY when we still own it: a
 * daemon that was reclaimed while alive must not delete the new holder's lock.
 * Lets a waiter reclaim instantly instead of waiting out the staleness window.
 * Never throws.
 */
export function releasePairingLock(input: {
  lockPath: string
  selfPid: number
  io?: LockIo
}): void {
  const io = input.io ?? defaultLockIo
  try {
    const existing = parseLockRecord(io.readText(input.lockPath))
    if (existing && existing.pid === input.selfPid) {
      io.unlink(input.lockPath)
    }
  } catch {
    // Best effort; the staleness window is the backstop.
  }
}

// ── Beacon heartbeat (part 2): a mtime-driven channel-liveness signal ─────────
//
// The lock heartbeat above proves the HOLDER PROCESS is alive and keeps rivals
// off the pairing. It is refreshed unconditionally while we hold the lock, so
// it says nothing about whether the CHANNEL is actually delivering. The
// external supervisor needs the second question answered: is this process
// still a working channel, or is it a live process with a dead channel?
//
// channel-live.json cannot answer that: it is edge-triggered (written on the
// first tool call of a boot and on connect), so a healthy long-lived channel
// and a channel that died an hour ago have the SAME channel-live.json mtime.
// So this is a SEPARATE file, touched on every successful beacon (a healthy WS
// or a successful poll cycle), whose mtime IS a liveness signal: a supervisor
// watching it can spot a dead channel behind a live process and restart it.
//
// TWO FILES, ONE DRIVER, on purpose. The lock lives next to the CREDENTIALS
// file (it is about mutual exclusion between peer daemons); the beacon lives
// next to channel-live.json in the plugin STATE dir (it is about liveness for
// an external watcher). Different directories, different consumers, different
// lifecycles (the lock is deleted on release; the beacon persists as a record).
// Folding them into one file would couple mutual-exclusion to observability.
// They share the ONE throttle above so their cadence can never drift.

/** File name inside the plugin state dir, beside channel-live.json. */
export const BEACON_HEARTBEAT_FILE = 'channel-beacon.json'

export interface BeaconHeartbeat {
  /** Epoch ms of the most recent successful beacon. */
  beaconAt: number
  /** Holder pid, so a supervisor can correlate with the lock record. */
  pid: number
}

export function serializeBeaconHeartbeat(hb: BeaconHeartbeat): string {
  return `${JSON.stringify(hb, null, 2)}\n`
}

/** Best-effort write of the beacon heartbeat; its mtime is the real payload.
 *  Never throws: a heartbeat write must never crash the daemon. */
export function touchBeaconHeartbeat(input: {
  path: string
  now: number
  pid: number
  io?: LockIo
}): void {
  const io = input.io ?? defaultLockIo
  try {
    io.writeFile(
      input.path,
      serializeBeaconHeartbeat({ beaconAt: input.now, pid: input.pid }),
    )
  } catch {
    // Telemetry only.
  }
}

/**
 * The clause that says WHY this daemon yields to a channel-loaded holder, or
 * '' when that is not the reason (an unknown on either side, or both loaded).
 * `selfReason` is lib/channel-presence.ts's reason for our own false.
 */
export function formatChannelYieldReason(input: {
  holderChannelLoaded: boolean | undefined
  selfChannelLoaded: boolean | null | undefined
  selfReason?: string
}): string {
  if (input.holderChannelLoaded !== true || input.selfChannelLoaded !== false) return ''
  const why = input.selfReason ? ` (${input.selfReason})` : ''
  return (
    `yielding the pairing lock: the holder's channel is loaded in its session ` +
    `and this daemon's channel is not${why}`
  )
}

/** The one line a daemon logs when it takes the lock over from a live holder
 *  whose channel is not loaded. */
export function formatChannelTakeoverLine(input: {
  selfPid: number
  holderPid: number | undefined
  selfReason?: string
}): string {
  const who = input.holderPid && input.holderPid > 0 ? `pid ${input.holderPid}` : 'the holder'
  const why = input.selfReason ? ` (${input.selfReason})` : ''
  return (
    `pid ${input.selfPid}: pairing lock taken over from ${who}: it recorded ` +
    `channelLoaded=false and this daemon's channel is loaded${why}`
  )
}

/** How a route reads in a log line. */
function routePhrase(route: IdentityRoute | null | undefined): string {
  if (route === 'pin') return 'the folder pin'
  if (route === 'env') return 'BGOS_ASSISTANT_ID or BGOS_CREDENTIALS_PATH'
  return 'elimination'
}

/** The one line a daemon logs when it takes the lock over from a live holder
 *  that found its identity by elimination. */
export function formatRouteTakeoverLine(input: {
  selfPid: number
  holderPid: number | undefined
  selfRoute: IdentityRoute | null | undefined
}): string {
  const who = input.holderPid && input.holderPid > 0 ? `pid ${input.holderPid}` : 'the holder'
  return (
    `pid ${input.selfPid}: pairing lock taken over from ${who}: it found this agent by ` +
    `elimination and this daemon is pinned to it (${routePhrase(input.selfRoute)})`
  )
}

/**
 * The clause that says WHY this daemon yields to the holder by route, or ''
 * when that is not the reason: the holder is pinned to this agent and this
 * daemon came by elimination, so it will not take over while that holder lives.
 */
export function formatLockYieldReason(input: {
  holderRoute: IdentityRoute | null | undefined
  selfRoute: IdentityRoute | null | undefined
}): string {
  if (!isPinnedRoute(input.holderRoute) || input.selfRoute !== 'elimination') return ''
  return (
    `yielding the pairing lock: the holder is pinned to this agent ` +
    `(${routePhrase(input.holderRoute)}) and this daemon found it by elimination`
  )
}

/** The banner a passive daemon logs so an operator reading the log knows this
 *  session is deliberately off the pairing, and which pid holds it. With a
 *  `yieldReason` (formatChannelYieldReason) it also says why it will NOT take
 *  over while that holder lives. */
export function formatPassiveBanner(holderPid: number | undefined, yieldReason = ''): string {
  const who = holderPid && holderPid > 0 ? `pid ${holderPid}` : 'another process'
  return (
    `passive: the pairing is already held by ${who} on this host, so this ` +
    `daemon will NOT connect the pairing channel (its MCP tools stay available). ` +
    (yieldReason
      ? `${yieldReason[0].toUpperCase()}${yieldReason.slice(1)}. It takes over only if that holder exits or stops heartbeating.`
      : `It will take over automatically if that holder exits.`)
  )
}
