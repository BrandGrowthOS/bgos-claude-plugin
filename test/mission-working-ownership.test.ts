import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMissionWorkingTracker } from '../lib/mission-working.ts'
import { boundedFetch } from '../lib/bounded-fetch.ts'
import * as writeLocks from '../lib/mission-working-lock.ts'

const scope = { sessionId: 'session-a', missionId: 77, goalId: 3, headers: {} }
const mission = { mission: { id: 77 } }
const event = (name: string, sessionId = scope.sessionId) => ({ hook_event_name: name, session_id: sessionId })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

// The external write gate is shared by separate daemons. Its filesystem
// implementation is exercised separately; this keeps backend races exact.
function sharedWriteGate() {
  let tail = Promise.resolve()
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work)
    tail = next.then(() => {}, () => {})
    return next
  }
}

test('two trackers: a daemon losing the pairing cannot clear its successor mark', async () => {
  let owner = 'A'
  let backend = false
  const writes: string[] = []
  const withWriteLock = sharedWriteGate()
  const make = (name: string) => {
    const options = { isArmed: () => owner === name, hasAuthority: () => owner === name, withWriteLock,
      patch: async (_scope: typeof scope, working: boolean) => { writes.push(`${name}:${working}`); backend = working; return mission },
    }
    return createMissionWorkingTracker(options)
  }
  const a = make('A'), b = make('B')
  await a.mark({ ...scope, working: true })
  owner = 'B'
  await b.mark({ ...scope, sessionId: 'session-b', working: true })
  await a.stop()
  await b.onHook(event('PreToolUse', 'session-b'))
  assert.equal(backend, true, 'B must remain marked inside its refresh window')
  assert.deepEqual(writes, ['A:true', 'B:true'])
  owner = 'A'
  await a.sweep()
  assert.equal(backend, true, 'a later re-arm must not revive A cleanup')
})

test('two trackers: a delayed predecessor clear finishes before the successor mark', async () => {
  let owner = 'A'
  let backend = false
  const entered = deferred(), release = deferred()
  const writes: string[] = []
  const withWriteLock = sharedWriteGate()
  const make = (name: string) => {
    const options = { isArmed: () => owner === name, hasAuthority: () => owner === name, withWriteLock,
      patch: async (_scope: typeof scope, working: boolean) => {
        if (name === 'A' && !working) { entered.resolve(); await release.promise }
        writes.push(`${name}:${working}`)
        backend = working
        return mission
      },
    }
    return createMissionWorkingTracker(options)
  }
  const a = make('A'), b = make('B')
  await a.mark({ ...scope, working: true })
  const clearing = a.stop()
  await entered.promise
  owner = 'B'
  const selecting = b.mark({ ...scope, sessionId: 'session-b', working: true })
  await new Promise(done => setImmediate(done))
  release.resolve()
  await Promise.all([clearing, selecting])
  assert.equal(backend, true)
  assert.deepEqual(writes, ['A:true', 'A:false', 'B:true'])
})

for (const binds of [false, true]) {
  test(`unbound replacement cancels old retries and replayed frames, later binding=${binds}`, async () => {
    let now = 1_000_000
    let failClear = false
    let backend = false
    const writes: string[] = []
    const tracker = createMissionWorkingTracker({ now: () => now, isArmed: () => true,
      patch: async (s, working) => {
        writes.push(`${s.sessionId || 'unbound'}:${working}`)
        if (!working && failClear) throw Object.assign(new Error('unavailable'), { status: 503 })
        backend = working
        return mission
      },
    })
    await tracker.mark({ ...scope, working: true })
    failClear = true
    await tracker.onHook(event('SessionEnd'))
    failClear = false
    await tracker.mark({ ...scope, sessionId: '', working: true })
    if (binds) await tracker.onHook(event('SessionStart', 'session-b'))
    now += 30_000
    await tracker.onHook(event('SessionEnd'))
    await tracker.onHook(event('Stop', 'session-b'))
    await tracker.sweep()
    assert.equal(backend, true)
    assert.deepEqual(writes, ['session-a:true', 'session-a:false', 'unbound:true'])
  })
}

test('unbound replacement waits for an in-flight old clear before catching up', async () => {
  let backend = false
  const entered = deferred(), release = deferred()
  const writes: boolean[] = []
  const tracker = createMissionWorkingTracker({ isArmed: () => true,
    patch: async (_scope, working) => {
      if (!working) { entered.resolve(); await release.promise }
      writes.push(working)
      backend = working
      return mission
    },
  })
  await tracker.mark({ ...scope, working: true })
  const clearing = tracker.onHook(event('SessionEnd'))
  await entered.promise
  const selecting = tracker.mark({ ...scope, sessionId: '', working: true })
  await new Promise(done => setImmediate(done))
  release.resolve()
  await Promise.all([clearing, selecting])
  await tracker.sweep()
  assert.equal(backend, true)
  assert.deepEqual(writes, [true, false, true])
})

for (const restoration of [false, true]) {
  test(`a committed true write with a lost response remains clearable, idle restoration=${restoration}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'working-uncertain-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    let now = 1_000_000
    let loseResponse = !restoration
    let backend = false
    const writes: boolean[] = []
    const tracker = createMissionWorkingTracker({ now: () => now, isArmed: () => true,
      withWriteLock: writeLocks.createMissionWorkingWriteLock(root),
      generation: writeLocks.createMissionWorkingGeneration(root),
      hasUnconfirmedWrite: s => writeLocks.hasUnconfirmedWorkingWrite(root, s),
      patch: async (_scope, working) => {
        writes.push(working)
        backend = working
        if (working && loseResponse) { loseResponse = false; throw new Error('socket closed after commit') }
        return mission
      },
    })
    if (restoration) {
      await tracker.mark({ ...scope, working: true })
      now += 900_000
      await tracker.sweep()
      assert.equal(backend, false)
      loseResponse = true
      await tracker.onHook(event('PreToolUse'))
    } else {
      await assert.rejects(tracker.mark({ ...scope, working: true }))
    }
    assert.equal(backend, true, 'the server committed despite the lost response')
    await tracker.onHook(event('Stop'))
    await tracker.sweep()
    assert.equal(backend, false)
    assert.deepEqual(writes, restoration ? [true, false, true, false] : [true, false])
  })
}

test('a deleted uncertain goal is retired after one 404 cleanup refusal', async () => {
  let now = 1_000_000
  const writes: boolean[] = []
  const tracker = createMissionWorkingTracker({ now: () => now, isArmed: () => true,
    patch: async (_scope, working) => {
      writes.push(working)
      if (working) throw new Error('response lost after commit')
      throw Object.assign(new Error('mission deleted'), { status: 404 })
    },
  })
  await assert.rejects(tracker.mark({ ...scope, working: true }))
  await tracker.onHook(event('Stop'))
  for (let i = 0; i < 20; i++) {
    now += 30_000
    await tracker.sweep()
    await tracker.onHook(event('Stop'))
  }
  assert.deepEqual(writes, [true, false])
})

test('shutdown invalidates an unbound selection waiting behind another daemon write', async () => {
  const gate = sharedWriteGate()
  const entered = deferred(), release = deferred()
  const holding = gate(async () => { await release.promise })
  const writes: boolean[] = []
  const options = { isArmed: () => true,
    withWriteLock: <T>(work: () => Promise<T>) => { entered.resolve(); return gate(work) },
    patch: async (_scope: typeof scope, working: boolean) => { writes.push(working); return mission },
  }
  const tracker = createMissionWorkingTracker(options)
  const selecting = tracker.mark({ ...scope, sessionId: '', working: true })
  await entered.promise
  const rejected = assert.rejects(selecting, /session ended/i)
  const stopping = tracker.stop()
  release.resolve()
  await Promise.all([holding, rejected, stopping])
  assert.deepEqual(writes, [], 'a late manual write must not land after shutdown')
})

test('a queued request checks pairing ownership after acquiring the write gate', async () => {
  let owns = true
  const gate = sharedWriteGate()
  const entered = deferred(), release = deferred()
  const holding = gate(async () => { await release.promise })
  const writes: boolean[] = []
  const options = { isArmed: () => true, hasAuthority: () => owns,
    withWriteLock: <T>(work: () => Promise<T>) => { entered.resolve(); return gate(work) },
    patch: async (_scope: typeof scope, working: boolean) => { writes.push(working); return mission },
  }
  const tracker = createMissionWorkingTracker(options)
  const selecting = tracker.mark({ ...scope, working: true })
  await entered.promise
  const rejected = assert.rejects(selecting, /no longer owns/i)
  owns = false
  release.resolve()
  await Promise.all([holding, rejected])
  await tracker.stop()
  assert.deepEqual(writes, [])
})

test('an uncertain predecessor write cannot clear a new daemon successful selection', async () => {
  let owner = 'A', backend = false
  const writes: string[] = []
  const withWriteLock = sharedWriteGate()
  const make = (name: string) => {
    const options = { isArmed: () => owner === name, hasAuthority: () => owner === name, withWriteLock,
      patch: async (_scope: typeof scope, working: boolean) => {
        writes.push(`${name}:${working}`)
        backend = working
        if (name === 'A' && working) throw new Error('response lost after commit')
        return mission
      },
    }
    return createMissionWorkingTracker(options)
  }
  const a = make('A'), b = make('B')
  await assert.rejects(a.mark({ ...scope, working: true }))
  owner = 'B'
  await b.mark({ ...scope, sessionId: 'session-b', working: true })
  await a.onHook(event('Stop'))
  await a.stop()
  assert.equal(backend, true)
  assert.deepEqual(writes, ['A:true', 'B:true'])
})

test('a failed stand-down gate cannot revive old cleanup after the pairing is reclaimed', async () => {
  let owner = 'A', backend = false, gateFails = false, now = 1_000_000
  const writes: string[] = []
  const withWriteLock = async <T>(work: () => Promise<T>) => {
    if (gateFails) throw new Error('gate timed out')
    return work()
  }
  const make = (name: string) => {
    const options = { now: () => now, isArmed: () => owner === name, hasAuthority: () => owner === name, withWriteLock,
      patch: async (_scope: typeof scope, working: boolean) => { writes.push(`${name}:${working}`); backend = working; return mission },
    }
    return createMissionWorkingTracker(options)
  }
  const a = make('A'), b = make('B')
  await a.mark({ ...scope, working: true })
  owner = 'B'
  await b.mark({ ...scope, sessionId: 'session-b', working: true })
  gateFails = true
  await a.stop()
  gateFails = false
  owner = 'A'
  now += 30_000
  await a.sweep()
  await a.onHook(event('Stop'))
  assert.equal(backend, true)
  assert.deepEqual(writes, ['A:true', 'B:true'])
})

test('a locally timed-out clear fences later selections while its remote commit can still arrive', async t => {
  const root = mkdtempSync(join(tmpdir(), 'working-fence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const release = deferred(), committed = deferred()
  let owner = 'A', backend = false
  const writes: string[] = []
  const make = (name: string) => {
    const options = { isArmed: () => owner === name, hasAuthority: () => owner === name,
      withWriteLock: writeLocks.createMissionWorkingWriteLock(root),
      generation: writeLocks.createMissionWorkingGeneration(root),
      hasUnconfirmedWrite: (s: typeof scope) => writeLocks.hasUnconfirmedWorkingWrite(root, s),
      patch: async (_scope: typeof scope, working: boolean) => {
        if (name === 'A' && !working) {
          return boundedFetch({ url: 'unused', timeoutMs: 10, label: 'clear' }, async () => mission, {
            fetchImpl: async () => {
              await release.promise
              writes.push('A:false')
              backend = false
              committed.resolve()
              return {}
            },
          })
        }
        writes.push(`${name}:${working}`)
        backend = working
        return mission
      },
    }
    return createMissionWorkingTracker(options)
  }
  const a = make('A'), b = make('B')
  await a.mark({ ...scope, working: true })
  // boundedFetch's deadline is unrefed; keep the test live until it fires.
  const keepAlive = setInterval(() => {}, 100)
  try {
    await a.onHook(event('Stop'))
    owner = 'B'
    await assert.rejects(b.mark({ ...scope, sessionId: 'session-b', working: true }), /unconfirmed write/i)
    release.resolve()
    await committed.promise
    assert.equal(backend, false)
    assert.deepEqual(writes, ['A:true', 'A:false'], 'B must not claim a successful mark that A can still erase')
    const restarted = make('B')
    await assert.rejects(restarted.mark({ ...scope, sessionId: 'session-b', working: true }), /unconfirmed write/i)
  } finally {
    clearInterval(keepAlive)
    release.resolve()
  }
})

test('a delayed true after local timeout is cleared again without admitting a successor mark', async t => {
  const root = mkdtempSync(join(tmpdir(), 'working-true-fence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const release = deferred(), committed = deferred()
  let now = 1_000_000, backend = false
  const writes: boolean[] = []
  const options = { now: () => now, isArmed: () => true,
    withWriteLock: writeLocks.createMissionWorkingWriteLock(root),
    generation: writeLocks.createMissionWorkingGeneration(root),
    hasUnconfirmedWrite: (s: typeof scope) => writeLocks.hasUnconfirmedWorkingWrite(root, s),
    patch: async (_scope: typeof scope, working: boolean) => {
      if (working) return boundedFetch({ url: 'unused', timeoutMs: 10, label: 'mark' }, async () => mission, {
        fetchImpl: async () => {
          await release.promise
          writes.push(true)
          backend = true
          committed.resolve()
          return {}
        },
      })
      writes.push(false)
      backend = false
      return mission
    },
  }
  const tracker = createMissionWorkingTracker(options)
  const keepAlive = setInterval(() => {}, 100)
  try {
    await assert.rejects(tracker.mark({ ...scope, working: true }), /timed out/)
    await tracker.onHook(event('Stop'))
    assert.equal(backend, false)
    release.resolve()
    await committed.promise
    assert.equal(backend, true, 'the remote true really arrives after the first clear')
    now += 30_000
    await tracker.sweep()
    assert.equal(backend, false, 'the unresolved write remains a cleanup obligation')
    assert.deepEqual(writes, [false, true, false])
    await assert.rejects(tracker.mark({ ...scope, sessionId: 'session-b', working: true }), /unconfirmed write/i)
  } finally {
    clearInterval(keepAlive)
    release.resolve()
  }
})

test('an uncertain first write survives a failed cleanup and its retry window', async () => {
  let now = 1_000_000, clearFails = true, backend = false
  const writes: boolean[] = []
  const tracker = createMissionWorkingTracker({ now: () => now, isArmed: () => true,
    patch: async (_scope, working) => {
      writes.push(working)
      if (working) { backend = true; throw new Error('response lost') }
      if (clearFails) throw Object.assign(new Error('unavailable'), { status: 503 })
      backend = false
      return mission
    },
  })
  await assert.rejects(tracker.mark({ ...scope, working: true }))
  await tracker.onHook(event('Stop'))
  await tracker.sweep()
  clearFails = false
  now += 30_000
  await tracker.sweep()
  assert.equal(backend, false)
  assert.deepEqual(writes, [true, false, false])
})

test('a passive manual clear preserves cleanup of an older unresolved true', async t => {
  const root = mkdtempSync(join(tmpdir(), 'working-passive-fence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const release = deferred(), committed = deferred()
  let now = 1_000_000, backend = false
  const writes: string[] = []
  const make = (name: string) => createMissionWorkingTracker({ now: () => now,
    isArmed: () => name === 'A', hasAuthority: () => name === 'A',
    withWriteLock: writeLocks.createMissionWorkingWriteLock(root),
    generation: writeLocks.createMissionWorkingGeneration(root),
    hasUnconfirmedWrite: s => writeLocks.hasUnconfirmedWorkingWrite(root, s),
    patch: async (_scope, working) => {
      if (name === 'A' && working) return boundedFetch({ url: 'unused', timeoutMs: 10, label: 'mark' }, async () => mission, {
        fetchImpl: async () => {
          await release.promise
          writes.push('A:true')
          backend = true
          committed.resolve()
          return {}
        },
      })
      writes.push(`${name}:${working}`)
      backend = working
      return mission
    },
  })
  const a = make('A'), b = make('B')
  const keepAlive = setInterval(() => {}, 100)
  try {
    await assert.rejects(a.mark({ ...scope, working: true }), /timed out/)
    await b.mark({ ...scope, sessionId: '', working: false })
    await a.onHook(event('Stop'))
    release.resolve()
    await committed.promise
    assert.equal(backend, true, 'the older remote write really arrives after the passive clear')
    now += 30_000
    await a.sweep()
    assert.equal(backend, false, 'the active daemon must keep the unresolved cleanup obligation')
    assert.deepEqual(writes, ['B:false', 'A:false', 'A:true', 'A:false'])
    await assert.rejects(b.mark({ ...scope, sessionId: '', working: true }), /unconfirmed write/i)
  } finally {
    clearInterval(keepAlive)
    release.resolve()
  }
})
