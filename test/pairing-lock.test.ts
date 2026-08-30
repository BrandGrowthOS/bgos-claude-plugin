/**
 * Reclaimable single-instance pairing lock + beacon heartbeat (0.38.6).
 *
 * The bug (board 01a05185): several daemons resolving to one pairing on a
 * shared-credentials host all join the same Socket.IO room, dispatch
 * broadcasts to all, and a rival drops the message ("Rejected dispatch to
 * unauthorized chat_id") so the real agent goes unreachable while alive. The
 * lib under test makes exactly one daemon per pairing connect: it holds a
 * heartbeat lock; rivals stay passive; a rival RECLAIMS when the holder is
 * gone (dead pid, or a heartbeat older than 3 intervals) rather than being
 * locked out first-come by a short-lived transient.
 *
 * Run with:  node --test test/pairing-lock.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  LOCK_HEARTBEAT_INTERVAL_MS,
  LOCK_STALENESS_WINDOWS,
  lockStalenessMs,
  parseLockRecord,
  serializeLockRecord,
  decideLockAction,
  shouldHeartbeatNow,
  pairingLockPath,
  acquirePairingLock,
  refreshPairingLock,
  releasePairingLock,
  touchBeaconHeartbeat,
  BEACON_HEARTBEAT_FILE,
  serializeBeaconHeartbeat,
  formatPassiveBanner,
  processAlive,
  type LockIo,
  type LockRecord,
} from '../lib/pairing-lock.ts'

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

const STALE = lockStalenessMs() // 15_000 at the default interval

// ── An in-memory LockIo, so no real files and no real processes ───────────────
function makeIo(opts?: {
  files?: Record<string, string>
  alive?: number[]
  failRead?: boolean
  failWrite?: boolean
}): LockIo & {
  files: Map<string, string>
  alive: Set<number>
  writes: number
} {
  const files = new Map<string, string>(Object.entries(opts?.files ?? {}))
  const alive = new Set<number>(opts?.alive ?? [])
  let writes = 0
  const io: LockIo & { files: Map<string, string>; alive: Set<number>; writes: number } = {
    files,
    alive,
    get writes() {
      return writes
    },
    readText(path: string): string | null {
      if (opts?.failRead) throw new Error('boom read')
      return files.has(path) ? (files.get(path) as string) : null
    },
    writeFile(path: string, data: string): void {
      if (opts?.failWrite) throw new Error('boom write')
      writes++
      files.set(path, data)
    },
    unlink(path: string): void {
      files.delete(path)
    },
    isProcessAlive(pid: number): boolean {
      return alive.has(pid)
    },
  }
  return io
}

const LOCK = '/state/.bgos-agent/credentials-42.json.lock'

// ── Pure: constants + staleness maths ─────────────────────────────────────────

test('staleness window is three heartbeat intervals', () => {
  assert.equal(LOCK_STALENESS_WINDOWS, 3)
  assert.equal(lockStalenessMs(), LOCK_HEARTBEAT_INTERVAL_MS * 3)
  assert.equal(lockStalenessMs(1000), 3000)
})

test('pairingLockPath is the credentials file plus .lock', () => {
  assert.equal(
    pairingLockPath('/home/u/.bgos-agent/credentials-42.json'),
    '/home/u/.bgos-agent/credentials-42.json.lock',
  )
})

// ── Pure: parse / serialize ───────────────────────────────────────────────────

test('parseLockRecord accepts a valid record and round-trips', () => {
  const rec: LockRecord = { pid: 123, heartbeatAt: 1000, bootedAt: 900 }
  const round = parseLockRecord(serializeLockRecord(rec))
  assert.deepEqual(round, rec)
})

test('parseLockRecord omits bootedAt when absent', () => {
  const round = parseLockRecord(serializeLockRecord({ pid: 5, heartbeatAt: 10 }))
  assert.deepEqual(round, { pid: 5, heartbeatAt: 10 })
})

test('parseLockRecord returns null for junk, null, non-object, or a bad pid/heartbeat', () => {
  assert.equal(parseLockRecord(null), null)
  assert.equal(parseLockRecord(undefined), null)
  assert.equal(parseLockRecord(''), null)
  assert.equal(parseLockRecord('not json'), null)
  assert.equal(parseLockRecord('[]'), null)
  assert.equal(parseLockRecord('"x"'), null)
  assert.equal(parseLockRecord(JSON.stringify({ heartbeatAt: 1 })), null) // no pid
  assert.equal(parseLockRecord(JSON.stringify({ pid: 0, heartbeatAt: 1 })), null) // pid <= 0
  assert.equal(parseLockRecord(JSON.stringify({ pid: 1.5, heartbeatAt: 1 })), null) // non-int pid
  assert.equal(parseLockRecord(JSON.stringify({ pid: 1 })), null) // no heartbeat
  assert.equal(parseLockRecord(JSON.stringify({ pid: 1, heartbeatAt: 'x' })), null)
})

// ── Pure: the core decision (the four DoD scenarios) ──────────────────────────

test('decideLockAction: no record on disk -> acquire (unlocked)', () => {
  const d = decideLockAction({
    existing: null,
    now: 10_000,
    selfPid: 100,
    stalenessMs: STALE,
    isHolderAlive: () => true,
  })
  assert.deepEqual(d, { action: 'acquire', reason: 'unlocked' })
})

test('decideLockAction: our own pid -> acquire (own), so a re-acquire refreshes', () => {
  const d = decideLockAction({
    existing: { pid: 100, heartbeatAt: 9_000 },
    now: 10_000,
    selfPid: 100,
    stalenessMs: STALE,
    isHolderAlive: () => true,
  })
  assert.deepEqual(d, { action: 'acquire', reason: 'own' })
})

test('FRESH lock (heartbeat within window, holder alive) -> PASSIVE', () => {
  const d = decideLockAction({
    existing: { pid: 200, heartbeatAt: 8_000 },
    now: 10_000, // 2s old, well within the 15s window
    selfPid: 100,
    stalenessMs: STALE,
    isHolderAlive: (pid) => pid === 200,
  })
  assert.deepEqual(d, { action: 'passive', holderPid: 200 })
})

test('STALE lock (heartbeat older than the window) -> RECLAIM, even if pid looks alive', () => {
  const d = decideLockAction({
    existing: { pid: 200, heartbeatAt: 0 },
    now: 20_000, // 20s old > 15s window
    selfPid: 100,
    stalenessMs: STALE,
    isHolderAlive: () => true, // pid recycled by an unrelated process: staleness still wins
  })
  assert.deepEqual(d, { action: 'acquire', reason: 'stale' })
})

test('HOLDER EXIT: fresh heartbeat but holder pid dead -> RECLAIM (holder-dead), instant takeover', () => {
  const d = decideLockAction({
    existing: { pid: 200, heartbeatAt: 9_500 },
    now: 10_000, // only 0.5s old, NOT stale
    selfPid: 100,
    stalenessMs: STALE,
    isHolderAlive: () => false, // the transient exited
  })
  assert.deepEqual(d, { action: 'acquire', reason: 'holder-dead' })
})

test('decideLockAction: staleness boundary is inclusive (age === window -> stale)', () => {
  const atBoundary = decideLockAction({
    existing: { pid: 200, heartbeatAt: 0 },
    now: STALE,
    selfPid: 100,
    stalenessMs: STALE,
    isHolderAlive: () => true,
  })
  assert.equal(atBoundary.action, 'acquire')
  const justInside = decideLockAction({
    existing: { pid: 200, heartbeatAt: 1 },
    now: STALE,
    selfPid: 100,
    stalenessMs: STALE,
    isHolderAlive: () => true,
  })
  assert.equal(justInside.action, 'passive')
})

// ── Pure: heartbeat throttle ──────────────────────────────────────────────────

test('shouldHeartbeatNow: first beat always fires; then only once per interval', () => {
  assert.equal(shouldHeartbeatNow({ lastAt: null, now: 0, intervalMs: 5000 }), true)
  assert.equal(shouldHeartbeatNow({ lastAt: 1000, now: 2000, intervalMs: 5000 }), false)
  assert.equal(shouldHeartbeatNow({ lastAt: 1000, now: 6000, intervalMs: 5000 }), true)
  assert.equal(shouldHeartbeatNow({ lastAt: 1000, now: 5999, intervalMs: 5000 }), false)
})

// ── Effectful: acquire ────────────────────────────────────────────────────────

test('acquire on an unlocked pairing takes the lock and writes our record', () => {
  const io = makeIo()
  const r = acquirePairingLock({ lockPath: LOCK, selfPid: 100, now: 1000, bootedAt: 900, io })
  assert.equal(r.acquired, true)
  assert.equal(r.reason, 'unlocked')
  const written = parseLockRecord(io.files.get(LOCK) ?? null)
  assert.deepEqual(written, { pid: 100, heartbeatAt: 1000, bootedAt: 900 })
})

test('acquire against a FRESH rival stays passive and does NOT write', () => {
  const io = makeIo({
    files: { [LOCK]: serializeLockRecord({ pid: 200, heartbeatAt: 9000 }) },
    alive: [200],
  })
  const r = acquirePairingLock({ lockPath: LOCK, selfPid: 100, now: 10_000, io })
  assert.equal(r.acquired, false)
  assert.equal(r.holderPid, 200)
  assert.equal(io.writes, 0) // we never touched the file
  // The rival's record is untouched.
  assert.equal(parseLockRecord(io.files.get(LOCK) ?? null)?.pid, 200)
})

test('acquire against a STALE lock reclaims it (overwrites with our record)', () => {
  const io = makeIo({
    files: { [LOCK]: serializeLockRecord({ pid: 200, heartbeatAt: 0 }) },
    alive: [200],
  })
  const r = acquirePairingLock({ lockPath: LOCK, selfPid: 100, now: 20_000, io })
  assert.equal(r.acquired, true)
  assert.equal(r.reason, 'stale')
  assert.equal(parseLockRecord(io.files.get(LOCK) ?? null)?.pid, 100)
})

test('acquire against a DEAD holder reclaims it', () => {
  const io = makeIo({
    files: { [LOCK]: serializeLockRecord({ pid: 200, heartbeatAt: 9_500 }) },
    alive: [], // pid 200 gone
  })
  const r = acquirePairingLock({ lockPath: LOCK, selfPid: 100, now: 10_000, io })
  assert.equal(r.acquired, true)
  assert.equal(r.reason, 'holder-dead')
  assert.equal(parseLockRecord(io.files.get(LOCK) ?? null)?.pid, 100)
})

test('acquire never throws on an IO failure; it just fails to acquire', () => {
  const ioRead = makeIo({ failRead: true })
  assert.doesNotThrow(() => acquirePairingLock({ lockPath: LOCK, selfPid: 100, now: 1, io: ioRead }))
  assert.equal(acquirePairingLock({ lockPath: LOCK, selfPid: 100, now: 1, io: ioRead }).acquired, false)
  const ioWrite = makeIo({ failWrite: true })
  assert.equal(acquirePairingLock({ lockPath: LOCK, selfPid: 100, now: 1, io: ioWrite }).acquired, false)
})

// ── Effectful: HEARTBEAT REFRESH KEEPS A LOCK FRESH (DoD) ──────────────────────

test('heartbeat refresh keeps a lock fresh: a rival that would otherwise reclaim stays passive', () => {
  // Holder pid 100 takes the lock at t=0.
  const io = makeIo({ alive: [100] })
  assert.equal(acquirePairingLock({ lockPath: LOCK, selfPid: 100, now: 0, io }).acquired, true)

  // Without a refresh, by t=20s (> 15s window) the record is stale and a rival
  // pid 200 would reclaim it.
  const staleView = decideLockAction({
    existing: parseLockRecord(io.files.get(LOCK) ?? null),
    now: 20_000,
    selfPid: 200,
    stalenessMs: STALE,
    isHolderAlive: (pid) => io.alive.has(pid),
  })
  assert.equal(staleView.action, 'acquire') // proves the window would have lapsed

  // The holder refreshes at t=18s (its poll tick), re-stamping the heartbeat.
  assert.equal(refreshPairingLock({ lockPath: LOCK, selfPid: 100, now: 18_000, io }), true)
  assert.equal(parseLockRecord(io.files.get(LOCK) ?? null)?.heartbeatAt, 18_000)

  // Now the same rival at t=20s sees a fresh heartbeat (2s old) and stays passive.
  const freshView = decideLockAction({
    existing: parseLockRecord(io.files.get(LOCK) ?? null),
    now: 20_000,
    selfPid: 200,
    stalenessMs: STALE,
    isHolderAlive: (pid) => io.alive.has(pid),
  })
  assert.deepEqual(freshView, { action: 'passive', holderPid: 100 })
})

test('refresh returns false when a DIFFERENT pid now holds the lock (we were reclaimed)', () => {
  const io = makeIo({ files: { [LOCK]: serializeLockRecord({ pid: 999, heartbeatAt: 5000 }) } })
  assert.equal(refreshPairingLock({ lockPath: LOCK, selfPid: 100, now: 6000, io }), false)
  // We did NOT overwrite the new holder's record (that would recreate the bug).
  assert.equal(parseLockRecord(io.files.get(LOCK) ?? null)?.pid, 999)
})

test('refresh on an absent lock re-creates it as ours (self-heal after an errant unlink)', () => {
  const io = makeIo({ alive: [100] })
  assert.equal(refreshPairingLock({ lockPath: LOCK, selfPid: 100, now: 6000, io }), true)
  assert.equal(parseLockRecord(io.files.get(LOCK) ?? null)?.pid, 100)
})

// ── Effectful: HOLDER EXIT LETS A WAITER RECLAIM (DoD) ─────────────────────────

test('holder exit via release lets a waiter reclaim immediately', () => {
  // Holder pid 100 takes and then releases the lock on shutdown.
  const io = makeIo({ alive: [100, 200] })
  assert.equal(acquirePairingLock({ lockPath: LOCK, selfPid: 100, now: 0, io }).acquired, true)
  releasePairingLock({ lockPath: LOCK, selfPid: 100, io })
  assert.equal(io.files.has(LOCK), false) // lock gone

  // Waiter pid 200 reclaims an unlocked pairing at once, no staleness wait.
  const r = acquirePairingLock({ lockPath: LOCK, selfPid: 200, now: 100, io })
  assert.equal(r.acquired, true)
  assert.equal(r.reason, 'unlocked')
  assert.equal(parseLockRecord(io.files.get(LOCK) ?? null)?.pid, 200)
})

test('holder exit via death (no clean release) lets a waiter reclaim on the next check', () => {
  // Holder pid 100 takes the lock, then its process dies (removed from alive)
  // WITHOUT releasing the file (SIGKILL / crash).
  const io = makeIo({ alive: [100, 200] })
  assert.equal(acquirePairingLock({ lockPath: LOCK, selfPid: 100, now: 0, io }).acquired, true)
  io.alive.delete(100)

  // The waiter's very next recheck reclaims via the dead-holder path, long
  // before the staleness window would have expired.
  const r = acquirePairingLock({ lockPath: LOCK, selfPid: 200, now: 1000, io })
  assert.equal(r.acquired, true)
  assert.equal(r.reason, 'holder-dead')
  assert.equal(parseLockRecord(io.files.get(LOCK) ?? null)?.pid, 200)
})

test('release does NOT delete a lock owned by someone else', () => {
  const io = makeIo({ files: { [LOCK]: serializeLockRecord({ pid: 999, heartbeatAt: 1 }) } })
  releasePairingLock({ lockPath: LOCK, selfPid: 100, io })
  assert.equal(io.files.has(LOCK), true) // untouched
  assert.equal(parseLockRecord(io.files.get(LOCK) ?? null)?.pid, 999)
})

// ── A boot-storm end-to-end: transient wins first, real agent takes over ──────

test('boot storm: a transient grabs the lock first, the real agent takes over when it exits', () => {
  const io = makeIo({ alive: [1, 2] }) // 1 = transient subagent, 2 = real long-lived agent

  // The transient wins the race a beat earlier.
  assert.equal(acquirePairingLock({ lockPath: LOCK, selfPid: 1, now: 0, io }).acquired, true)

  // The real agent boots, sees a fresh lock held by a live transient -> passive.
  const boot = acquirePairingLock({ lockPath: LOCK, selfPid: 2, now: 500, io })
  assert.equal(boot.acquired, false)
  assert.equal(boot.holderPid, 1)

  // 30 seconds later the transient exits (process gone). The real agent's
  // recheck reclaims it and connects. It was never permanently locked out,
  // which is the whole reason a naive first-come flock is wrong here.
  io.alive.delete(1)
  const takeover = acquirePairingLock({ lockPath: LOCK, selfPid: 2, now: 30_000, io })
  assert.equal(takeover.acquired, true)
  assert.equal(parseLockRecord(io.files.get(LOCK) ?? null)?.pid, 2)
})

// ── Beacon heartbeat (part 2) ─────────────────────────────────────────────────

test('touchBeaconHeartbeat writes a beacon record whose contents carry the timestamp', () => {
  const io = makeIo()
  const path = '/state/plugin/channel-beacon.json'
  touchBeaconHeartbeat({ path, now: 12_345, pid: 100, io })
  const parsed = JSON.parse(io.files.get(path) as string)
  assert.equal(parsed.beaconAt, 12_345)
  assert.equal(parsed.pid, 100)
})

test('touchBeaconHeartbeat never throws on an IO failure', () => {
  const io = makeIo({ failWrite: true })
  assert.doesNotThrow(() =>
    touchBeaconHeartbeat({ path: '/x', now: 1, pid: 1, io }),
  )
})

test('beacon file name is a sibling of channel-live.json, and serialize round-trips', () => {
  assert.equal(BEACON_HEARTBEAT_FILE, 'channel-beacon.json')
  const round = JSON.parse(serializeBeaconHeartbeat({ beaconAt: 7, pid: 3 }))
  assert.deepEqual(round, { beaconAt: 7, pid: 3 })
})

// ── processAlive + banner ─────────────────────────────────────────────────────

test('processAlive reports true for this very process and false for a bogus pid', () => {
  assert.equal(processAlive(process.pid), true)
  assert.equal(processAlive(0), false)
  assert.equal(processAlive(-1), false)
  // A pid that is almost certainly not a live process on the test host.
  assert.equal(processAlive(2_000_000_000), false)
})

test('formatPassiveBanner names the holder pid and states we stay off the pairing', () => {
  const b = formatPassiveBanner(4242)
  assert.match(b, /passive/)
  assert.match(b, /pid 4242/)
  assert.match(b, /will NOT connect the pairing/)
  // Degrades gracefully when the pid is unknown.
  assert.match(formatPassiveBanner(undefined), /another process/)
})

// ── Wiring guard: server.ts actually uses the lock at the WS-connect point ─────
//
// A pure lib that server.ts never calls would pass every test above and fix
// nothing. These assertions pin that the daemon imports the lock and gates the
// pairing WebSocket on holding it.

test('server.ts imports the pairing lock module', () => {
  assert.match(serverSource, /from '\.\/lib\/pairing-lock\.js'/)
})

test('server.ts acquires the lock and can stay passive instead of connecting the WS', () => {
  assert.match(serverSource, /acquirePairingLock/)
  assert.match(serverSource, /formatPassiveBanner/)
  // The passive path must not connect the pairing WebSocket.
  assert.match(serverSource, /releasePairingLock/)
})

test('server.ts drives the lock heartbeat and the beacon heartbeat from the poll loop', () => {
  assert.match(serverSource, /refreshPairingLock/)
  assert.match(serverSource, /touchBeaconHeartbeat/)
  assert.match(serverSource, /shouldHeartbeatNow/)
})
