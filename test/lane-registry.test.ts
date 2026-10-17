/**
 * PERSON LANES, the registry, the singleton and the caps (shared agents
 * Phase 3, P3; design 4.2 "Who owns the lanes" and "Caps", decision K6).
 *
 *   - Two supervisors for ONE lane: the second finds the first alive and does
 *     not start; a dead holder (or a lock with no readable holder) is
 *     reclaimed, so a crash never blocks the person forever.
 *   - The machine registry is read, pruned (dead supervisors) and written in
 *     one locked step, so a restarted owner daemon re-reads running lanes and
 *     a crashed supervisor never holds a place.
 *   - Caps: 2 lanes per agent, a machine ceiling from available memory
 *     (floor((available - 4 GiB) / 1 GiB), at least 1); over a cap the least
 *     recently used IDLE lane is evicted, and all busy answers busy. The cap
 *     counts across agents.
 *
 * Run with: npx tsx --test test/lane-registry.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  availableBytesFromMeminfo,
  availableBytesFromVmStat,
  decideLaneCaps,
  laneMachineCeiling,
} from '../lib/lane-core.mjs'
import {
  acquireLaneLock,
  createLockFile,
  liveLaneSupervisor,
  readRegistry,
  releaseLaneLock,
  takeOverStaleLock,
  updateRegistry,
  withFileLock,
} from '../lib/lane-registry.mjs'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'lane-registry-'))
}

test('the lane singleton: a second supervisor for one lane does not start', () => {
  const dir = scratch()
  try {
    const lock = join(dir, 'people', 'user_ana', 'launcher.lock')
    const alive = new Set([1001, 1002])
    const isAlive = (pid: number) => alive.has(pid)
    assert.deepEqual(acquireLaneLock(lock, { selfPid: 1001, isAlive }), { acquired: true, reclaimed: false })
    assert.deepEqual(acquireLaneLock(lock, { selfPid: 1002, isAlive }), { acquired: false, holderPid: 1001 })
    assert.equal(liveLaneSupervisor(lock, { isAlive }), 1001)
    // Only the holder releases.
    releaseLaneLock(lock, { selfPid: 1002 })
    assert.ok(existsSync(lock))
    releaseLaneLock(lock, { selfPid: 1001 })
    assert.ok(!existsSync(lock))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the lane singleton: a dead holder or an unreadable lock is reclaimed', () => {
  const dir = scratch()
  try {
    const lock = join(dir, 'launcher.lock')
    writeFileSync(lock, JSON.stringify({ pid: 4242 }))
    assert.deepEqual(acquireLaneLock(lock, { selfPid: 1001, isAlive: () => false }), { acquired: true, reclaimed: true })
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, 1001)
    // An unreadable (or empty) lock is someone still making it while young,
    // and abandoned only once old (security review finding 2).
    writeFileSync(lock, '')
    assert.equal(acquireLaneLock(lock, { selfPid: 1003, isAlive: () => true }).acquired, false, 'a young empty lock is held')
    writeFileSync(lock, 'not json')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    assert.equal(acquireLaneLock(lock, { selfPid: 1003, isAlive: () => true }).acquired, true, 'an old unreadable lock is taken over')
    assert.equal(liveLaneSupervisor(join(dir, 'missing.lock')), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the registry is pruned of dead supervisors in the same locked step', () => {
  const dir = scratch()
  try {
    const path = join(dir, 'lanes-machine.json')
    writeFileSync(path, JSON.stringify({ v: 1, lanes: [
      { assistantId: 1076, userId: 'user_ana', supervisorPid: 11, startedAt: '2026-10-17T10:00:00Z' },
      { assistantId: 1076, userId: 'user_ben', supervisorPid: 12, startedAt: '2026-10-17T10:01:00Z' },
    ] }))
    const seen = updateRegistry(path, (registry) => ({ result: registry.lanes.map((l: { userId: string }) => l.userId) }), { isAlive: (pid) => pid === 12 })
    assert.deepEqual(seen, ['user_ben'])
    assert.deepEqual(readRegistry(path).lanes.map((l: { userId: string }) => l.userId), ['user_ben'], 'the dead entry was written away')
    updateRegistry(path, (registry) => ({ registry: { v: 1, lanes: [...registry.lanes, { assistantId: '7', userId: 'user_cy', supervisorPid: 13 }] }, result: null }), { isAlive: () => true })
    assert.deepEqual(readRegistry(path).lanes.map((l: { assistantId: string; userId: string }) => `${l.assistantId}/${l.userId}`), ['1076/user_ben', '7/user_cy'])
    assert.ok(!existsSync(`${path}.lock`), 'the lock is released')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the registry lock: a stale lock is taken over, a live one waits then gives up', () => {
  const dir = scratch()
  try {
    const path = join(dir, 'r.json')
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: 99999, at: Date.now() }))
    assert.equal(withFileLock(path, () => 'ran', { pidAlive: () => false }), 'ran')
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }))
    let t = 0
    assert.throws(() => withFileLock(path, () => 'never', { pidAlive: () => true, waitMs: 100, now: () => (t += 60), sleep: () => {} }), /held/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lock races: a lock never exists empty, and a takeover never removes a lock that changed', () => {
  const dir = scratch()
  try {
    const lock = join(dir, 'x.lock')
    assert.equal(createLockFile(lock, '{"pid":1}'), true)
    assert.equal(readFileSync(lock, 'utf8'), '{"pid":1}', 'it appears with its content')
    assert.equal(createLockFile(lock, '{"pid":2}'), false, 'never over an existing lock')
    assert.equal(readFileSync(lock, 'utf8'), '{"pid":1}')
    // A racing taker judged an OLD text stale; the lock now holds a fresh one.
    assert.equal(takeOverStaleLock(lock, '{"pid":0}'), false)
    assert.equal(readFileSync(lock, 'utf8'), '{"pid":1}', 'the fresh lock is put back')
    assert.equal(takeOverStaleLock(lock, '{"pid":1}'), true)
    assert.ok(!existsSync(lock))
    assert.deepEqual(readdirSync(dir), [], 'no temp or aside files left behind')
    // The registry lock removes only its own file.
    const path = join(dir, 'r.json')
    withFileLock(path, () => {
      writeFileSync(`${path}.lock`, '{"pid":424242,"at":1}')
    })
    assert.equal(readFileSync(`${path}.lock`, 'utf8'), '{"pid":424242,"at":1}', 'a lock that is not ours is left')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const lane = (assistantId: string, userId: string, lastActivityAtMs: number, inFlight = false) => ({ assistantId, userId, lastActivityAtMs, inFlight })

test('caps: a free place starts; a lane already running is not started twice', () => {
  assert.deepEqual(decideLaneCaps({ lanes: [], assistantId: '1', userId: 'a', machineCeiling: 10 }), { action: 'start' })
  assert.deepEqual(decideLaneCaps({ lanes: [lane('1', 'a', 5)], assistantId: '1', userId: 'a', machineCeiling: 10 }), { action: 'running' })
})

test('caps: the third lane on an agent evicts the least recently used IDLE one', () => {
  const lanes = [lane('1', 'ana', 300), lane('1', 'ben', 100), lane('2', 'cy', 1)]
  assert.deepEqual(decideLaneCaps({ lanes, assistantId: '1', userId: 'dee', machineCeiling: 10 }), { action: 'evict', victim: { assistantId: '1', userId: 'ben' } })
  // The lane in flight is never evicted, even when it is the oldest.
  const busyBen = [lane('1', 'ana', 300), lane('1', 'ben', 100, true)]
  assert.deepEqual(decideLaneCaps({ lanes: busyBen, assistantId: '1', userId: 'dee', machineCeiling: 10 }), { action: 'evict', victim: { assistantId: '1', userId: 'ana' } })
})

test('caps: with every lane of the agent busy the answer is busy, never another lane', () => {
  const lanes = [lane('1', 'ana', 300, true), lane('1', 'ben', 100, true)]
  assert.deepEqual(decideLaneCaps({ lanes, assistantId: '1', userId: 'dee', machineCeiling: 10 }), { action: 'busy', cap: 'agent' })
})

test('caps: the machine ceiling counts across agents', () => {
  const lanes = [lane('1', 'ana', 300, true), lane('2', 'ben', 100)]
  assert.deepEqual(decideLaneCaps({ lanes, assistantId: '3', userId: 'cy', machineCeiling: 2 }), { action: 'evict', victim: { assistantId: '2', userId: 'ben' } })
  const allBusy = [lane('1', 'ana', 300, true), lane('2', 'ben', 100, true)]
  assert.deepEqual(decideLaneCaps({ lanes: allBusy, assistantId: '3', userId: 'cy', machineCeiling: 2 }), { action: 'busy', cap: 'machine' })
})

test('the machine ceiling: floor((available - 4 GiB) / 1 GiB), at least 1', () => {
  const GiB = 1024 ** 3
  assert.equal(laneMachineCeiling(0), 1)
  assert.equal(laneMachineCeiling(3 * GiB), 1)
  assert.equal(laneMachineCeiling(4 * GiB), 1)
  assert.equal(laneMachineCeiling(6.5 * GiB), 2)
  assert.equal(laneMachineCeiling(36 * GiB), 32)
  assert.equal(laneMachineCeiling(Number.NaN), 1)
})

test('available memory: the operating system\'s own figure, never os.freemem()', () => {
  const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               10000.\nPages active:                            900000.\nPages inactive:                          20000.\nPages speculative:                        5000.\nPages purgeable:                          3000.\n'
  assert.equal(availableBytesFromVmStat(vm), (10000 + 20000 + 3000) * 16384)
  assert.equal(availableBytesFromVmStat('garbage'), 0)
  assert.equal(availableBytesFromMeminfo('MemTotal: 100 kB\nMemFree: 5 kB\nMemAvailable:    2048 kB\n'), 2048 * 1024)
})
