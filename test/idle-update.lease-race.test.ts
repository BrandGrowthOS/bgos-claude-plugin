/**
 * lib/idle-update.mjs createMachineLease: two agents that both read one expired
 * lease never both end it, so no two agents on one computer restart together
 * (#291 review follow up 2; docs/idle-update/DESIGN.md, Lease, spacing and canary).
 *
 * The lease is synchronous over an injected fs, so these tests race real lease
 * code against real lease code: one agent's whole take (or release) runs inside
 * another agent's file operation, at every operation in turn. An agent that read
 * the lease before the race began reads it as it was until it changes a lease
 * file itself. After every race, at most one agent holds the lease, the lease on
 * disk is the holder's (a live lease nobody holds would stall the computer), and
 * no agent ever moved a live lease that was not its own (the window in which a
 * third agent took the lease too).
 *
 * Run: npx tsx --test test/idle-update.lease-race.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

const mod: any = await import('../lib/idle-update.mjs')

function need(): any {
  if (typeof mod.createMachineLease !== 'function') assert.fail('lib/idle-update.mjs createMachineLease is missing: the lease has no unit a race can drive')
  return mod
}

const T0 = Date.parse('2026-11-13T12:00:00.000Z')
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DIR = join('/home/a/.bgos-agent', 'idle-update')
const LEASE = join(DIR, 'lease.json')
const D = mod.DEFAULT_DURATIONS

type Files = Map<string, { text: string; mtimeMs: number }>

function world() {
  const files: Files = new Map()
  const clock = { now: T0 }
  const base = {
    readFile: (p: string) => files.get(p)?.text ?? null,
    mtimeMs: (p: string) => files.get(p)?.mtimeMs ?? null,
    createExclusive: (p: string, text: string): 'ok' | 'exists' | 'error' => {
      if (files.has(p)) return 'exists'
      files.set(p, { text, mtimeMs: clock.now })
      return 'ok'
    },
    writeAtomic: (p: string, text: string) => {
      files.set(p, { text, mtimeMs: clock.now })
      return true
    },
    rename: (from: string, to: string) => {
      const f = files.get(from)
      if (!f) return false
      files.delete(from)
      files.set(to, f)
      return true
    },
    remove: (p: string) => files.delete(p),
    listDir: (dir: string) => {
      const names = new Set<string>()
      for (const p of files.keys()) if (p.startsWith(`${dir}/`)) names.add(p.slice(dir.length + 1).split('/')[0])
      return [...names]
    },
  }
  return { files, clock, base }
}

type World = ReturnType<typeof world>

/** The lease the race starts from: agent 913's, an hour old, so expired. */
const EXPIRED = JSON.stringify({ assistantId: '913', target: '0.81.0', nonce: 'n-913', at: new Date(T0 - HOUR).toISOString() })

const isLiveLeaseOf = (raw: string | null, now: number) => {
  try {
    const lease = JSON.parse(String(raw))
    return now - Date.parse(lease.at) < D.leaseTtlMs ? String(lease.nonce) : null
  } catch {
    return null
  }
}

/**
 * One agent on the shared disk. `stale`: it read lease.json before the race began, and reads it so until it changes
 * a lease file itself. `inject`: runs before this agent's file operation number `at` (0 based). `dies`: no file
 * operation of this agent lands after its first exclusive create.
 */
function actor(w: World, id: string, o: { stale?: Files; inject?: { at: number; run: () => void }; dies?: boolean; violations: string[] }) {
  const me = { assistantId: id, nonce: `n-${id}` }
  let ops = 0
  let changed = false
  let dead = false
  const wrap = (name: string, fn: (...args: any[]) => any, mutates: boolean) => (...args: any[]) => {
    if (dead) throw new Error('this process has ended')
    if (o.inject && ops === o.inject.at) o.inject.run()
    ops += 1
    const p = String(args[0])
    if (!mutates && p === LEASE && o.stale && !changed) {
      const f = o.stale.get(p)
      return name === 'readFile' ? (f?.text ?? null) : (f?.mtimeMs ?? null)
    }
    if (name === 'rename' && p === LEASE) {
      const holder = isLiveLeaseOf(w.base.readFile(LEASE), w.clock.now)
      if (holder !== null && holder !== me.nonce) o.violations.push(`${id} moved the live lease of ${holder}`)
    }
    const out = fn(...args)
    if (mutates && p.startsWith(join(DIR, 'lease.'))) changed = true
    if (o.dies && name === 'createExclusive' && out === 'ok') dead = true
    return out
  }
  const fs = {
    readFile: wrap('readFile', w.base.readFile, false),
    mtimeMs: wrap('mtimeMs', w.base.mtimeMs, false),
    listDir: wrap('listDir', w.base.listDir, false),
    createExclusive: wrap('createExclusive', w.base.createExclusive, true),
    writeAtomic: wrap('writeAtomic', w.base.writeAtomic, true),
    rename: wrap('rename', w.base.rename, true),
    remove: wrap('remove', w.base.remove, true),
  }
  const lease = need().createMachineLease({ dir: DIR, fs, now: () => w.clock.now, durations: D, onExpired: () => true })
  return { id, me, lease, ops: () => ops }
}

type Step = 'take' | 'release'
interface Party {
  id: string
  step: Step
  stale?: boolean
  /** Another party runs inside this one, before its file operation `at`. */
  inner?: { party: Party; at: number }
}

/** Runs `party`, and the party nested inside it at its operation `inner.at`, and so on down; collects who took the lease. */
function run(w: World, party: Party, before: Files, violations: string[], holders: string[]) {
  const a = actor(w, party.id, {
    stale: party.stale ? before : undefined,
    inject: party.inner ? { at: party.inner.at, run: () => run(w, party.inner!.party, before, violations, holders) } : undefined,
    violations,
  })
  let ok = false
  try {
    ok = party.step === 'take' ? a.lease.take('0.82.0', a.me) === true : a.lease.release(a.me) === true
  } catch {
    ok = false
  }
  if (ok && party.step === 'take') holders.push(a.me.nonce)
}

/** How many file operations `party` makes on a disk nobody else touches. */
function opsAlone(step: Step) {
  const w = world()
  w.base.writeAtomic(LEASE, EXPIRED)
  const a = actor(w, '914', { violations: [] })
  if (step === 'take') a.lease.take('0.82.0', a.me)
  else a.lease.release({ assistantId: '913', nonce: 'n-913' })
  return a.ops()
}

/**
 * Agent 914 takes the expired lease; `others` run inside it before each of its file operations in turn (and the
 * innermost inside the outer at each of its operations). Every schedule must leave one holder, its lease on disk,
 * and no live lease moved by another agent.
 */
function raceAll(name: string, outer: Party, mid: Party, innermost: Party | null) {
  const n = opsAlone('take') + 2
  const m = innermost ? 14 : 1
  let schedules = 0
  for (let at = 0; at <= n; at += 1) {
    for (let j = 0; j < m; j += 1) {
      const w = world()
      w.base.writeAtomic(LEASE, EXPIRED)
      const before = new Map(w.files)
      const violations: string[] = []
      const holders: string[] = []
      const midParty: Party = innermost ? { ...mid, inner: { party: innermost, at: j } } : mid
      run(w, { ...outer, inner: { party: midParty, at } }, before, violations, holders)
      schedules += 1
      const where = `${name}, at ${at}${innermost ? `, inner at ${j}` : ''}`
      assert.deepEqual(violations, [], `${where}: a live lease was moved by an agent that does not hold it`)
      assert.ok(holders.length <= 1, `${where}: two agents hold the lease at once (${holders.join(', ')})`)
      // Nobody holding it is fine while the lease is free or the old one stands: the next look takes it. A live lease
      // nobody holds is not: it stalls the computer a lease's length for nothing.
      assert.equal(isLiveLeaseOf(w.base.readFile(LEASE), w.clock.now), holders[0] ?? null, `${where}: the lease on disk is not the holder's`)
      if (holders.length === 0) assert.ok(isLiveLeaseOf(w.base.readFile(LEASE), w.clock.now) === null, `${where}: a live lease nobody holds`)
      if (!innermost && outer.step === 'take' && mid.step === 'take') assert.equal(holders.length, 1, `${where}: two agents raced for an expired lease and neither took it`)
    }
  }
  return schedules
}

test('two agents that both read one expired lease: at every interleaving exactly one takes it, and nobody moves the live lease', () => {
  need()
  const schedules = raceAll('914 and a late 915', { id: '914', step: 'take' }, { id: '915', step: 'take', stale: true }, null)
  assert.ok(schedules > 5)
})

test('two breakers and a third agent: at every interleaving of all three, one restart lease, never two', () => {
  need()
  raceAll('914, a late 915, and 916 inside it', { id: '914', step: 'take' }, { id: '915', step: 'take', stale: true }, { id: '916', step: 'take' })
  raceAll('914, a fresh 915, and 916 inside it', { id: '914', step: 'take' }, { id: '915', step: 'take' }, { id: '916', step: 'take' })
})

test('the holder releasing its expired lease while another agent breaks it, and a third agent: one lease, never two', () => {
  need()
  raceAll('914 breaking, 913 releasing inside it, 916 inside that', { id: '914', step: 'take' }, { id: '913', step: 'release' }, { id: '916', step: 'take' })
})

test('a breaker that died mid break holds the end of that lease only for a while: the next agent breaks it once that runs out, not before', () => {
  const m = need()
  const w = world()
  w.base.writeAtomic(LEASE, EXPIRED)
  const violations: string[] = []
  const dead = actor(w, '915', { dies: true, violations })
  assert.equal(dead.lease.take('0.82.0', dead.me), false, 'it died before it took anything')
  const next = actor(w, '914', { violations })
  assert.equal(next.lease.take('0.82.0', next.me), false, 'a breaker that may still be at work is waited for')
  w.clock.now += D.leaseEndStaleMs ?? 2 * MIN
  assert.equal(next.lease.take('0.82.0', next.me), true, 'past its time it is a breaker that died')
  assert.equal(isLiveLeaseOf(w.base.readFile(LEASE), w.clock.now), 'n-914')
  assert.deepEqual(violations, [])
  assert.deepEqual([...w.files.keys()].filter((p) => p.startsWith(join(DIR, 'lease.')) && p !== LEASE), [], 'no claim or aside file is left behind')
  assert.equal(typeof m.decideLeaseEndClaim, 'function')
})

test('a break that stops short (its holder could not be put on the record) leaves no claim: the next look breaks it at once', () => {
  need()
  const w = world()
  w.base.writeAtomic(LEASE, EXPIRED)
  let record = false
  const fs = w.base
  const lease = mod.createMachineLease({ dir: DIR, fs, now: () => w.clock.now, durations: D, onExpired: () => record })
  const me = { assistantId: '914', nonce: 'n-914' }
  assert.equal(lease.take('0.82.0', me), false)
  assert.equal(w.base.readFile(LEASE), EXPIRED, 'the lease stays where it is')
  record = true
  assert.equal(lease.take('0.82.0', me), true)
  assert.deepEqual([...w.files.keys()].filter((p) => p.startsWith(join(DIR, 'lease.')) && p !== LEASE), [])
})

test('a claim on ending a lease: standing while young or undated, stale once old or stamped past a lease ahead', () => {
  const m = need()
  if (typeof m.decideLeaseEndClaim !== 'function') assert.fail('lib/idle-update.mjs decideLeaseEndClaim is missing')
  const stale = D.leaseEndStaleMs
  assert.equal(m.decideLeaseEndClaim({ mtimeMs: T0, now: T0 }, D), 'standing')
  assert.equal(m.decideLeaseEndClaim({ mtimeMs: T0 - stale + 1, now: T0 }, D), 'standing')
  assert.equal(m.decideLeaseEndClaim({ mtimeMs: T0 - stale, now: T0 }, D), 'stale')
  assert.equal(m.decideLeaseEndClaim({ mtimeMs: null, now: T0 }, D), 'standing', 'a claim nobody can date is never taken over')
  assert.equal(m.decideLeaseEndClaim({ mtimeMs: T0 + D.leaseTtlMs + 1, now: T0 }, D), 'stale', 'a clock that jumped holds nothing for ever')
  assert.equal(m.decideLeaseEndClaim({ mtimeMs: T0 + MIN, now: T0 }, D), 'standing', 'a little ahead is a clock that moved back a little')
  assert.ok(stale < D.leaseTtlMs && stale >= 30 * SEC, 'long enough for a break, far shorter than a lease')
})
