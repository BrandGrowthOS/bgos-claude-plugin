/**
 * The pairing lock records how its holder found its identity, and a pinned
 * daemon takes the channel back from a stray (0.65.0, option D, board
 * fc75c7c3).
 *
 * The lock picked whoever came first. On a one agent computer whose agent was
 * down, that was any Claude Code session in a folder with no pin: it found the
 * agent by elimination, took the lock, and kept it while the real agent,
 * started from its pinned folder, sat passive behind it. The lock now records
 * one word, the route ('pin', 'env' or 'elimination'), and:
 *   - a daemon pinned to this agent (a folder pin or an env pin) takes the
 *     lock from a live holder that came by ELIMINATION;
 *   - it never takes it from a holder that is pinned to this same agent, so
 *     two pinned sessions never take it from each other (Data's guard);
 *   - a daemon that came by elimination never takes it from a pinned holder,
 *     not even through the channel rule, so the two cannot flap;
 *   - a record with no route (written by 0.64.x) is unknown: never taken over,
 *     so mixed versions behave as today.
 *
 * Run with:  npx tsx --test test/pairing-lock-route.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  acquirePairingLock,
  decideLockAction,
  formatLockYieldReason,
  formatRouteTakeoverLine,
  lockStalenessMs,
  parseLockRecord,
  refreshPairingLockDetailed,
  serializeLockRecord,
  type LockIo,
  type LockRecord,
} from '../lib/pairing-lock.ts'

const STALE = lockStalenessMs()
const LOCK = '/state/.bgos-agent/credentials-1040.json.lock'
const STRAY = 52001
const AGENT = 52002
const NOW = 2_000_000

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

type Route = 'pin' | 'env' | 'elimination'

// ── The record carries the route ─────────────────────────────────────────────

test('the route round-trips through serialize and parse, all three words', () => {
  for (const route of ['pin', 'env', 'elimination'] as const) {
    const rec: LockRecord = { pid: 7, heartbeatAt: 100, bootedAt: 50, route }
    assert.deepEqual(parseLockRecord(serializeLockRecord(rec)), rec)
  }
})

test('a record without a route (0.64.x) parses without one, and anything but the three words is ignored', () => {
  assert.equal('route' in (parseLockRecord('{"pid":7,"heartbeatAt":1}') as object), false)
  for (const junk of ['"Pin"', '"folder-pin"', '"pinned"', '1', 'true', 'null', '""']) {
    const rec = parseLockRecord(`{"pid":7,"heartbeatAt":1,"route":${junk}}`) as object
    assert.equal('route' in rec, false, `route ${junk}`)
  }
  // Nor is a junk route ever written.
  const out = serializeLockRecord({ pid: 7, heartbeatAt: 1, route: 'nonsense' as Route })
  assert.equal(JSON.parse(out).route, undefined)
})

// ── decideLockAction against a LIVE, FRESH holder: the route table ───────────

const ROUTES: Array<Route | undefined> = ['pin', 'env', 'elimination', undefined]

for (const self of ROUTES) {
  for (const holder of ROUTES) {
    const takes = (self === 'pin' || self === 'env') && holder === 'elimination'
    test(`decideLockAction: self route ${self ?? 'unknown'}, live holder route ${holder ?? 'unknown'} -> ${takes ? 'route-takeover' : 'passive'}`, () => {
      const existing: LockRecord = { pid: STRAY, heartbeatAt: NOW - 1_000, ...(holder ? { route: holder } : {}) }
      const d = decideLockAction({
        existing,
        now: NOW,
        selfPid: AGENT,
        stalenessMs: STALE,
        isHolderAlive: () => true,
        selfRoute: self,
      })
      if (takes) {
        assert.deepEqual(d, { action: 'acquire', reason: 'route-takeover', holderPid: STRAY })
      } else {
        assert.equal(d.action, 'passive')
        assert.equal(d.action === 'passive' && d.holderPid, STRAY)
        assert.equal(d.action === 'passive' && d.holderRoute, holder)
      }
    })
  }
}

test('a pinned daemon whose channel is proven not loaded never takes a live channel, even from a stray', () => {
  // 0.63.2's rule, kept: a daemon that cannot deliver never takes the lock
  // from a live holder.
  const d = decideLockAction({
    existing: { pid: STRAY, heartbeatAt: NOW, route: 'elimination' },
    now: NOW,
    selfPid: AGENT,
    stalenessMs: STALE,
    isHolderAlive: () => true,
    selfRoute: 'pin',
    selfChannelLoaded: false,
  })
  assert.equal(d.action, 'passive')
  // Unknown channel state on our side does not veto (no ps on Windows).
  const unknown = decideLockAction({
    existing: { pid: STRAY, heartbeatAt: NOW, route: 'elimination' },
    now: NOW,
    selfPid: AGENT,
    stalenessMs: STALE,
    isHolderAlive: () => true,
    selfRoute: 'pin',
    selfChannelLoaded: null,
  })
  assert.equal(unknown.action, 'acquire')
})

test('a daemon that came by elimination never takes the lock from a pinned holder, not even by the channel rule', () => {
  for (const holderRoute of ['pin', 'env'] as const) {
    const d = decideLockAction({
      existing: { pid: AGENT, heartbeatAt: NOW, route: holderRoute, channelLoaded: false },
      now: NOW,
      selfPid: STRAY,
      stalenessMs: STALE,
      isHolderAlive: () => true,
      selfRoute: 'elimination',
      selfChannelLoaded: true,
    })
    assert.equal(d.action, 'passive', `holder ${holderRoute}`)
  }
})

test('the 0.63.2 channel rule is unchanged everywhere the route does not decide', () => {
  // Same route on both sides, or a holder with no route: a loaded channel
  // still takes the lock from a holder that recorded channelLoaded=false.
  const pairs: Array<[Route | undefined, Route | undefined]> = [
    ['pin', 'pin'],
    ['env', 'pin'],
    ['elimination', 'elimination'],
    ['elimination', undefined],
    [undefined, undefined],
    ['pin', undefined],
  ]
  for (const [self, holder] of pairs) {
    const d = decideLockAction({
      existing: { pid: STRAY, heartbeatAt: NOW, channelLoaded: false, ...(holder ? { route: holder } : {}) },
      now: NOW,
      selfPid: AGENT,
      stalenessMs: STALE,
      isHolderAlive: () => true,
      selfRoute: self,
      selfChannelLoaded: true,
    })
    assert.deepEqual(d, { action: 'acquire', reason: 'channel-takeover', holderPid: STRAY }, `${self} over ${holder}`)
  }
})

test('the gone-holder rules come first: a stale or dead stray is reclaimed as before', () => {
  const stale = decideLockAction({
    existing: { pid: STRAY, heartbeatAt: NOW - STALE, route: 'pin' },
    now: NOW,
    selfPid: AGENT,
    stalenessMs: STALE,
    isHolderAlive: () => true,
    selfRoute: 'elimination',
  })
  assert.deepEqual(stale, { action: 'acquire', reason: 'stale' })
  const dead = decideLockAction({
    existing: { pid: STRAY, heartbeatAt: NOW, route: 'pin' },
    now: NOW,
    selfPid: AGENT,
    stalenessMs: STALE,
    isHolderAlive: () => false,
    selfRoute: 'elimination',
  })
  assert.deepEqual(dead, { action: 'acquire', reason: 'holder-dead' })
})

// ── The effectful shell writes the route and keeps it ────────────────────────

test('acquire records the route, the refresh keeps it, and the stray stands down on its next heartbeat', () => {
  const io = memIo([STRAY, AGENT])
  const first = acquirePairingLock({ lockPath: LOCK, selfPid: STRAY, now: NOW, route: 'elimination', io })
  assert.deepEqual(first, { acquired: true, reason: 'unlocked' })
  assert.equal(parseLockRecord(io.files.get(LOCK))?.route, 'elimination')
  assert.deepEqual(refreshPairingLockDetailed({ lockPath: LOCK, selfPid: STRAY, now: NOW + 5_000, route: 'elimination', io }), { held: true })
  assert.equal(parseLockRecord(io.files.get(LOCK))?.route, 'elimination', 'a refresh never drops the route')

  const agent = acquirePairingLock({ lockPath: LOCK, selfPid: AGENT, now: NOW + 6_000, route: 'pin', io })
  assert.deepEqual(agent, { acquired: true, reason: 'route-takeover', holderPid: STRAY })
  assert.equal(parseLockRecord(io.files.get(LOCK))?.route, 'pin')

  const strayRefresh = refreshPairingLockDetailed({ lockPath: LOCK, selfPid: STRAY, now: NOW + 10_000, route: 'elimination', io })
  assert.deepEqual(strayRefresh, { held: false, holderPid: AGENT, holderRoute: 'pin' })
  // Its recheck loop stays passive while the agent lives.
  const recheck = acquirePairingLock({ lockPath: LOCK, selfPid: STRAY, now: NOW + 15_000, route: 'elimination', channelLoaded: true, io })
  assert.deepEqual(recheck, { acquired: false, holderPid: AGENT, holderRoute: 'pin' })
})

test('no flapping: whatever the routes and channel states, the holder changes at most once', () => {
  const channels: Array<boolean | null> = [true, false, null]
  for (const aRoute of ROUTES) {
    for (const bRoute of ROUTES) {
      for (const aCh of channels) {
        for (const bCh of channels) {
          const io = memIo([STRAY, AGENT])
          const a = { pid: STRAY, route: aRoute, channelLoaded: aCh }
          const b = { pid: AGENT, route: bRoute, channelLoaded: bCh }
          const holders: number[] = []
          const step = (d: typeof a, now: number) => {
            const held = parseLockRecord(io.files.get(LOCK))?.pid === d.pid
            if (held) refreshPairingLockDetailed({ lockPath: LOCK, selfPid: d.pid, now, route: d.route, channelLoaded: d.channelLoaded, io })
            else acquirePairingLock({ lockPath: LOCK, selfPid: d.pid, now, route: d.route, channelLoaded: d.channelLoaded, io })
            const holder = parseLockRecord(io.files.get(LOCK))?.pid as number
            if (holders[holders.length - 1] !== holder) holders.push(holder)
          }
          for (let i = 0; i < 20; i++) {
            step(a, NOW + i * 5_000)
            step(b, NOW + i * 5_000 + 1_000)
          }
          const label = `a ${aRoute}/${aCh} b ${bRoute}/${bCh}: holders ${holders.join(' > ')}`
          assert.ok(holders.length <= 2, label)
        }
      }
    }
  }
})

// ── What the logs say ────────────────────────────────────────────────────────

test('the takeover and the yield each say why in one line', () => {
  const take = formatRouteTakeoverLine({ selfPid: AGENT, holderPid: STRAY, selfRoute: 'pin' })
  assert.match(take, new RegExp(`pid ${AGENT}`))
  assert.match(take, new RegExp(`pid ${STRAY}`))
  assert.match(take, /elimination/)
  assert.match(take, /folder pin/)
  assert.match(formatRouteTakeoverLine({ selfPid: AGENT, holderPid: STRAY, selfRoute: 'env' }), /BGOS_ASSISTANT_ID or BGOS_CREDENTIALS_PATH/)

  assert.match(formatLockYieldReason({ holderRoute: 'pin', selfRoute: 'elimination' }), /pinned to this agent/)
  assert.equal(formatLockYieldReason({ holderRoute: 'pin', selfRoute: 'pin' }), '')
  assert.equal(formatLockYieldReason({ holderRoute: undefined, selfRoute: 'elimination' }), '')
  assert.equal(formatLockYieldReason({ holderRoute: 'elimination', selfRoute: 'elimination' }), '')
})

// ── server.ts hands its route to every lock call ─────────────────────────────

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('server.ts records its route on EVERY acquire and refresh, and logs a route takeover on both paths', () => {
  assert.match(server, /\nconst LOCK_ROUTE = lockRouteFor\(CREDENTIALS_SELECTION\.via\)\n/)
  const calls = server.match(/(?:acquirePairingLock|refreshPairingLockDetailed)\(\{[\s\S]*?\n\s*\}\)/g) ?? []
  assert.equal(calls.length, 5)
  for (const call of calls) assert.match(call, /\n\s*route: LOCK_ROUTE,\n/)
  assert.match(server, /lockAtBoot\.reason === 'route-takeover'\s*\?\s*`\$\{formatRouteTakeoverLine\(/)
  assert.match(server, /res\.reason === 'route-takeover'\) \{\s*log\(\s*`\$\{formatRouteTakeoverLine\(/)
})
