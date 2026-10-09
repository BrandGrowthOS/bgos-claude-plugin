/**
 * The pairing lock yields to the daemon whose channel is loaded (0.63.2).
 *
 * Assistant 873, kc-server, 2026-10-09: one session ran the clone (loaded as
 * its channel via --dangerously-load-development-channels server:bgos) and the
 * globally enabled hoai@hoai plugin (no channel). Both raced for the lock; when
 * the plugin won, every inbound message went into a channel the session never
 * registered, for five hours. The rule under test: a daemon whose channel is
 * loaded takes the lock from a live holder that recorded channelLoaded=false;
 * a daemon whose channel is not loaded never takes it from a live holder; an
 * unknown on either side is exactly the old behaviour.
 *
 * Run with:  npx tsx --test test/pairing-lock-channel.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  acquirePairingLock,
  decideLockAction,
  defaultLockIo,
  formatChannelTakeoverLine,
  formatChannelYieldReason,
  formatPassiveBanner,
  lockStalenessMs,
  parseLockRecord,
  refreshPairingLockDetailed,
  serializeLockRecord,
  type LockIo,
  type LockRecord,
} from '../lib/pairing-lock.ts'

const STALE = lockStalenessMs()
const LOCK = join('state', '.bgos-agent', 'credentials-873.json.lock')
const HOAI = 3732258 // the plugin daemon, no channel
const CLONE = 3732285 // the clone daemon, the session's channel

function memIo(alive: number[]): LockIo & { files: Map<string, string> } {
  const files = new Map<string, string>()
  const live = new Set(alive)
  return {
    files,
    readText: (p) => (files.has(p) ? (files.get(p) as string) : null),
    writeFile: (p, d) => void files.set(p, d),
    unlink: (p) => void files.delete(p),
    isProcessAlive: (pid) => live.has(pid),
    tryCreateExclusive: (p, d) => {
      if (files.has(p)) return false
      files.set(p, d)
      return true
    },
  }
}

// ── The record carries channelLoaded ────────────────────────────────────────────

test('channelLoaded round-trips through serialize/parse, both values', () => {
  for (const channelLoaded of [true, false]) {
    const rec: LockRecord = { pid: 7, heartbeatAt: 100, bootedAt: 50, channelLoaded }
    assert.deepEqual(parseLockRecord(serializeLockRecord(rec)), rec)
  }
})

test('a record without channelLoaded parses without it (an older daemon), and a non boolean is ignored', () => {
  assert.equal('channelLoaded' in (parseLockRecord('{"pid":7,"heartbeatAt":1}') as object), false)
  assert.equal('channelLoaded' in (parseLockRecord('{"pid":7,"heartbeatAt":1,"channelLoaded":"false"}') as object), false)
  assert.equal('channelLoaded' in (parseLockRecord('{"pid":7,"heartbeatAt":1,"channelLoaded":0}') as object), false)
})

// ── decideLockAction: the decision table against a LIVE, FRESH holder ────────────

const NOW = 1_000_000
type Side = true | false | null
const TABLE: Array<{ self: Side; holder: Side; expect: 'acquire' | 'passive' }> = [
  { self: true, holder: false, expect: 'acquire' },
  { self: true, holder: true, expect: 'passive' },
  { self: true, holder: null, expect: 'passive' },
  { self: false, holder: false, expect: 'passive' },
  { self: false, holder: true, expect: 'passive' },
  { self: false, holder: null, expect: 'passive' },
  { self: null, holder: false, expect: 'passive' },
  { self: null, holder: true, expect: 'passive' },
  { self: null, holder: null, expect: 'passive' },
]

for (const row of TABLE) {
  test(`decideLockAction: self channelLoaded=${row.self}, live holder recorded ${row.holder} -> ${row.expect}`, () => {
    const existing: LockRecord = {
      pid: HOAI,
      heartbeatAt: NOW - 1_000,
      ...(row.holder === null ? {} : { channelLoaded: row.holder }),
    }
    const d = decideLockAction({
      existing,
      now: NOW,
      selfPid: CLONE,
      stalenessMs: STALE,
      isHolderAlive: () => true,
      selfChannelLoaded: row.self,
    })
    assert.equal(d.action, row.expect)
    if (d.action === 'acquire') {
      assert.equal(d.reason, 'channel-takeover')
      assert.equal(d.reason === 'channel-takeover' && d.holderPid, HOAI)
    } else {
      assert.equal(d.holderPid, HOAI)
      assert.equal(d.holderChannelLoaded, row.holder === null ? undefined : row.holder)
    }
  })
}

test('decideLockAction: an omitted selfChannelLoaded is unknown, never a takeover', () => {
  const d = decideLockAction({
    existing: { pid: HOAI, heartbeatAt: NOW, channelLoaded: false },
    now: NOW,
    selfPid: CLONE,
    stalenessMs: STALE,
    isHolderAlive: () => true,
  })
  assert.equal(d.action, 'passive')
})

test('decideLockAction: stale and dead holders are still reclaimed by anyone, channel or not', () => {
  const holder: LockRecord = { pid: CLONE, heartbeatAt: NOW - 1_000, channelLoaded: true }
  const dead = decideLockAction({ existing: holder, now: NOW, selfPid: HOAI, stalenessMs: STALE, isHolderAlive: () => false, selfChannelLoaded: false })
  assert.deepEqual(dead, { action: 'acquire', reason: 'holder-dead' })
  const stale = decideLockAction({ existing: { ...holder, heartbeatAt: NOW - STALE }, now: NOW, selfPid: HOAI, stalenessMs: STALE, isHolderAlive: () => true, selfChannelLoaded: false })
  assert.deepEqual(stale, { action: 'acquire', reason: 'stale' })
})

// ── The shell: acquire / refresh carry the field ────────────────────────────────

test('acquire records channelLoaded; a takeover overwrites the holder and names it', () => {
  const io = memIo([HOAI, CLONE])
  const first = acquirePairingLock({ lockPath: LOCK, selfPid: HOAI, now: NOW, channelLoaded: false, io })
  assert.deepEqual(first, { acquired: true, reason: 'unlocked' })
  assert.equal(parseLockRecord(io.files.get(LOCK))?.channelLoaded, false)
  const take = acquirePairingLock({ lockPath: LOCK, selfPid: CLONE, now: NOW + 1, channelLoaded: true, io })
  assert.deepEqual(take, { acquired: true, reason: 'channel-takeover', holderPid: HOAI })
  assert.deepEqual(parseLockRecord(io.files.get(LOCK)), { pid: CLONE, heartbeatAt: NOW + 1, channelLoaded: true })
})

test('acquire passive reports what the holder recorded about its channel', () => {
  const io = memIo([HOAI, CLONE])
  acquirePairingLock({ lockPath: LOCK, selfPid: CLONE, now: NOW, channelLoaded: true, io })
  assert.deepEqual(acquirePairingLock({ lockPath: LOCK, selfPid: HOAI, now: NOW + 1, channelLoaded: false, io }), {
    acquired: false,
    holderPid: CLONE,
    holderChannelLoaded: true,
  })
})

test('losing the unlocked create race still reports what the winner recorded about its channel', () => {
  // The plugin reads no lock, then the clone creates it a beat before the
  // plugin's exclusive create: the plugin must still learn why it yields.
  const io = memIo([HOAI, CLONE])
  const realRead = io.readText
  let reads = 0
  io.readText = (p) => {
    reads++
    if (reads === 1) {
      const r = realRead(p)
      acquirePairingLock({ lockPath: LOCK, selfPid: CLONE, now: NOW, channelLoaded: true, io: { ...io, readText: realRead } })
      return r
    }
    return realRead(p)
  }
  assert.deepEqual(acquirePairingLock({ lockPath: LOCK, selfPid: HOAI, now: NOW, channelLoaded: false, io }), {
    acquired: false,
    holderPid: CLONE,
    holderChannelLoaded: true,
  })
})

test('a takeover that lands inside the holders refresh (read, takeover, write) heals to the channel daemon', () => {
  const io = memIo([HOAI, CLONE])
  const hoai = new SimDaemon('hoai', HOAI, false, io, LOCK)
  const clone = new SimDaemon('clone', CLONE, true, io, LOCK)
  hoai.boot(NOW)
  // The plugin's refresh reads its own record; before it writes, the clone
  // takes over; then the plugin's write lands on top of the clone's.
  const realRead = io.readText
  let armed = true
  io.readText = (p) => {
    const r = realRead(p)
    if (armed) {
      armed = false
      io.readText = realRead
      clone.boot(NOW + 100)
    }
    return r
  }
  hoai.tick(NOW + 5_000)
  assert.equal(clone.held, true) // the clone read itself back before the overwrite
  assert.equal(parseLockRecord(io.files.get(LOCK))?.pid, HOAI) // the plugin's write won the file
  // Both believe they hold for one tick. The clone's next refresh sees the
  // plugin's pid and stands down; its recheck then takes over again, and the
  // plugin's next refresh stands it down for good.
  let now = NOW + 5_000
  for (let i = 0; i < 6; i++) {
    now += 5_000
    clone.tick(now)
    hoai.tick(now)
  }
  assert.equal(clone.held, true)
  assert.equal(hoai.held, false)
  assert.equal(parseLockRecord(io.files.get(LOCK))?.pid, CLONE)
})

test('an unknown daemon records nothing, so nobody can take over from it', () => {
  const io = memIo([HOAI, CLONE])
  acquirePairingLock({ lockPath: LOCK, selfPid: HOAI, now: NOW, channelLoaded: null, io })
  assert.equal('channelLoaded' in (parseLockRecord(io.files.get(LOCK)) as object), false)
  assert.equal(acquirePairingLock({ lockPath: LOCK, selfPid: CLONE, now: NOW + 1, channelLoaded: true, io }).acquired, false)
})

test('refresh keeps channelLoaded in the record, and a lost refresh reports the new holders value', () => {
  const io = memIo([HOAI, CLONE])
  acquirePairingLock({ lockPath: LOCK, selfPid: HOAI, now: NOW, channelLoaded: false, io })
  assert.deepEqual(refreshPairingLockDetailed({ lockPath: LOCK, selfPid: HOAI, now: NOW + 5_000, channelLoaded: false, io }), { held: true })
  assert.equal(parseLockRecord(io.files.get(LOCK))?.channelLoaded, false)
  acquirePairingLock({ lockPath: LOCK, selfPid: CLONE, now: NOW + 6_000, channelLoaded: true, io })
  assert.deepEqual(refreshPairingLockDetailed({ lockPath: LOCK, selfPid: HOAI, now: NOW + 10_000, channelLoaded: false, io }), {
    held: false,
    holderPid: CLONE,
    holderChannelLoaded: true,
  })
})

// ── 873's race, end to end over the boot / tick / recheck loop ───────────────────

/** The lock half of one daemon, driven the way server.ts drives it: acquire
 *  at boot, refresh on the tick while held (stand down on a loss), acquire on
 *  the recheck while passive. */
class SimDaemon {
  held = false
  readonly log: string[] = []
  constructor(
    readonly name: string,
    readonly pid: number,
    readonly channelLoaded: boolean | null,
    readonly io: LockIo,
    readonly lockPath: string,
  ) {}
  boot(now: number): void {
    const r = acquirePairingLock({ lockPath: this.lockPath, selfPid: this.pid, now, channelLoaded: this.channelLoaded, io: this.io })
    this.held = r.acquired
    this.log.push(r.acquired ? `acquired ${r.reason}` : `passive behind ${r.holderPid}`)
  }
  tick(now: number): void {
    if (this.held) {
      const r = refreshPairingLockDetailed({ lockPath: this.lockPath, selfPid: this.pid, now, channelLoaded: this.channelLoaded, io: this.io })
      if (!r.held) {
        this.held = false
        this.log.push(`stood down for ${r.holderPid}`)
      }
      return
    }
    const r = acquirePairingLock({ lockPath: this.lockPath, selfPid: this.pid, now, channelLoaded: this.channelLoaded, io: this.io })
    if (r.acquired) {
      this.held = true
      this.log.push(`acquired ${r.reason}`)
    }
  }
}

function race(io: LockIo, lockPath: string, first: SimDaemon, second: SimDaemon, start: number) {
  let now = start
  first.boot(now)
  now += 400 // the second daemon boots a beat later in the same session
  second.boot(now)
  // A takeover at boot leaves both believing they hold until the old holder's
  // next heartbeat refresh stands it down (at most one heartbeat interval):
  // the same window a stale reclaim has always had. Pinned, not hidden.
  if (second.log[0] === 'acquired channel-takeover') assert.equal(first.held && second.held, true)
  // Two minutes of 5 s ticks, alternating which daemon goes first in a tick.
  for (let i = 0; i < 24; i++) {
    now += 5_000
    if (i % 2 === 0) {
      first.tick(now)
      second.tick(now)
    } else {
      second.tick(now)
      first.tick(now)
    }
    assert.ok(!(first.held && second.held), `both hold after tick ${i}`)
  }
  return parseLockRecord(io.readText(lockPath))
}

test('873 race: the channel-less plugin wins the boot, the channel-loaded clone ends up holding', () => {
  const io = memIo([HOAI, CLONE])
  const hoai = new SimDaemon('hoai', HOAI, false, io, LOCK)
  const clone = new SimDaemon('clone', CLONE, true, io, LOCK)
  const finalRecord = race(io, LOCK, hoai, clone, NOW)
  assert.equal(clone.held, true)
  assert.equal(hoai.held, false)
  assert.equal(finalRecord?.pid, CLONE)
  assert.equal(finalRecord?.channelLoaded, true)
  assert.deepEqual(clone.log, ['acquired channel-takeover'])
  assert.deepEqual(hoai.log, ['acquired unlocked', `stood down for ${CLONE}`])
})

test('873 race, other order: the clone wins the boot and the plugin never takes it', () => {
  const io = memIo([HOAI, CLONE])
  const clone = new SimDaemon('clone', CLONE, true, io, LOCK)
  const hoai = new SimDaemon('hoai', HOAI, false, io, LOCK)
  race(io, LOCK, clone, hoai, NOW)
  assert.equal(clone.held, true)
  assert.equal(hoai.held, false)
  assert.deepEqual(hoai.log, [`passive behind ${CLONE}`])
})

test('873 race with no channel knowledge (unknown on both): todays first-come behaviour is unchanged', () => {
  const io = memIo([HOAI, CLONE])
  const hoai = new SimDaemon('hoai', HOAI, null, io, LOCK)
  const clone = new SimDaemon('clone', CLONE, null, io, LOCK)
  race(io, LOCK, hoai, clone, NOW)
  assert.equal(hoai.held, true)
  assert.equal(clone.held, false)
})

test('873 race on a REAL lock file with two live pids: the channel daemon ends up holding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-channel-'))
  try {
    const lockPath = join(dir, 'credentials-873.json.lock')
    // Both pids genuinely alive, so processAlive answers true for each.
    const hoai = new SimDaemon('hoai', process.ppid, false, defaultLockIo, lockPath)
    const clone = new SimDaemon('clone', process.pid, true, defaultLockIo, lockPath)
    const finalRecord = race(defaultLockIo, lockPath, hoai, clone, Date.now())
    assert.equal(clone.held, true)
    assert.equal(hoai.held, false)
    assert.equal(finalRecord?.pid, process.pid)
    assert.match(readFileSync(lockPath, 'utf8'), /"channelLoaded": true/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── The log lines name the reason ───────────────────────────────────────────────

test('the takeover line names both pids and why', () => {
  const line = formatChannelTakeoverLine({ selfPid: CLONE, holderPid: HOAI, selfReason: 'server:bgos is on the claude command line' })
  assert.match(line, new RegExp(`^pid ${CLONE}: pairing lock taken over from pid ${HOAI}`))
  assert.match(line, /channelLoaded=false/)
  assert.match(line, /server:bgos is on the claude command line/)
})

test('the yield clause appears only when a channel-loaded holder is the reason', () => {
  const why = formatChannelYieldReason({ holderChannelLoaded: true, selfChannelLoaded: false, selfReason: 'the claude command line loads server:bgos, not plugin:hoai@hoai' })
  assert.match(why, /^yielding the pairing lock: the holder's channel is loaded/)
  assert.match(why, /not plugin:hoai@hoai/)
  assert.equal(formatChannelYieldReason({ holderChannelLoaded: true, selfChannelLoaded: null }), '')
  assert.equal(formatChannelYieldReason({ holderChannelLoaded: undefined, selfChannelLoaded: false }), '')
  assert.equal(formatChannelYieldReason({ holderChannelLoaded: true, selfChannelLoaded: true }), '')
  const banner = formatPassiveBanner(CLONE, why)
  assert.match(banner, new RegExp(`held by pid ${CLONE}`))
  assert.match(banner, /Yielding the pairing lock/)
  assert.match(banner, /takes over only if that holder exits or stops heartbeating/)
  assert.match(formatPassiveBanner(CLONE), /take over automatically if that holder exits/)
})

// ── server.ts wiring (source scans, LF normalised as the sibling tests do) ───────

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('server.ts hands its channel presence to EVERY acquire and refresh call', () => {
  const calls = server.match(/(?:acquirePairingLock|refreshPairingLockDetailed)\(\{[\s\S]*?\n\s*\}\)/g) ?? []
  assert.equal(calls.length, 5)
  for (const call of calls) assert.match(call, /channelLoaded: (?:channelPresence\(\)|bootPresence)\.loaded/)
})

test('server.ts reads the presence off the claude command line with its own install spec', () => {
  // The probe gets the spec computed just above it, not a blank (a blank is
  // unknown, which would silently switch the whole rule off).
  assert.match(server, /probeChannelLoaded\(\{[^}]*\bownSpec,[^}]*\}\)/)
  assert.match(server, /marketplaceChannelSpec\(INSTALL_DETECTION\.marketplace\)/)
  assert.match(server, /CLONE_CHANNEL_SPEC/)
})

test('server.ts logs the takeover and the yield reason', () => {
  assert.equal((server.match(/formatChannelTakeoverLine\(/g) ?? []).length, 2)
  assert.match(server, /formatPassiveBanner\(lockAtBoot\.holderPid, channelYieldReason\(lockAtBoot\.holderChannelLoaded\)\)/)
  assert.equal((server.match(/channelYieldReason\((?:gateRefresh|refreshed)\.holderChannelLoaded\)/g) ?? []).length, 3)
})
