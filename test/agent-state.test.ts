/**
 * lib/agent-state.ts: the daemon's published state, the contract between the
 * daemon and the per-machine watcher (design section 7, finding 9).
 *
 * The watcher restarts an agent onto a staged update only at a safe moment,
 * and only the daemon knows whether a turn is in flight, a reply is owed, a
 * permission is open or a delivery is running. It publishes exactly that at
 * ~/.bgos-plugin-state/<id>/agent-state.json, atomically, on every change and
 * at least every 30 s, and takes it away on a clean shutdown.
 *
 * Run: npx tsx --test test/agent-state.test.ts
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AGENT_STATE_FILE_NAME,
  AGENT_STATE_MAX_INTERVAL_MS,
  AgentStatePublisher,
  buildAgentState,
  memoizeFor,
  memoizeUntilFound,
  nearestClaudeAncestor,
  removeAgentStateIfOurs,
  writeAgentStateAtomic,
  type AgentStateSnapshot,
} from '../lib/agent-state.ts'

const SESSION = '8c1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b'
const T0 = Date.parse('2026-10-06T19:00:00.000Z')

const baseSnapshot = (over: Partial<AgentStateSnapshot> = {}): AgentStateSnapshot => ({
  assistantId: '123',
  claudePid: 4200,
  runningVersion: '0.62.0',
  pendingRestartVersion: '0.62.1',
  turnInFlight: false,
  pendingMessages: 0,
  pendingPermissions: 0,
  activeOperations: 0,
  activityAtMs: [T0 - 60_000],
  sessionId: SESSION,
  ...over,
})

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'agent-state-test-'))
}

test('buildAgentState is exactly the section 7 contract, field for field, in order', () => {
  const state = buildAgentState({ ...baseSnapshot(), pid: 4242, lastActivityAtMs: T0, nowMs: T0 + 30_000 })
  assert.deepEqual(state, {
    schemaVersion: 1,
    assistantId: '123',
    pid: 4242,
    claudePid: 4200,
    runningVersion: '0.62.0',
    pendingRestartVersion: '0.62.1',
    turnInFlight: false,
    pendingMessages: 0,
    pendingPermissions: 0,
    activeOperations: 0,
    lastActivityAt: '2026-10-06T19:00:00.000Z',
    sessionId: SESSION,
    updatedAt: '2026-10-06T19:00:30.000Z',
  })
  assert.deepEqual(Object.keys(state!), [
    'schemaVersion', 'assistantId', 'pid', 'claudePid', 'runningVersion', 'pendingRestartVersion',
    'turnInFlight', 'pendingMessages', 'pendingPermissions', 'activeOperations', 'lastActivityAt',
    'sessionId', 'updatedAt',
  ])
})

test('buildAgentState fails closed on what it cannot vouch for', () => {
  const build = (over: Partial<AgentStateSnapshot>, lastActivityAtMs: number | null = null) =>
    buildAgentState({ ...baseSnapshot(over), pid: 4242, lastActivityAtMs, nowMs: T0 })
  // No valid id: no file at all (the watcher keys agents by digits-only ids).
  assert.equal(build({ assistantId: 'cwd-abc' }), null)
  assert.equal(build({ assistantId: null }), null)
  // A session id that is not a UUID is never published (the pin rules use it).
  assert.equal(build({ sessionId: 'not-a-uuid' })!.sessionId, null)
  assert.equal(build({ sessionId: null })!.sessionId, null)
  // Counts are non-negative integers (they are Map sizes and a counter, so
  // junk cannot occur in practice; the clamp keeps the contract typed).
  const s = build({ pendingMessages: 2.7, pendingPermissions: -1, activeOperations: Number.NaN })!
  assert.equal(s.pendingMessages, 2)
  assert.equal(s.pendingPermissions, 0)
  assert.equal(s.activeOperations, 0)
  assert.equal(build({ claudePid: 1 })!.claudePid, null)
  assert.equal(build({ runningVersion: '' })!.runningVersion, null)
  assert.equal(build({ pendingRestartVersion: undefined })!.pendingRestartVersion, null)
  assert.equal(build({})!.lastActivityAt, null)
})

test('nearestClaudeAncestor walks up from the parent and stops at the first claude', () => {
  const comms: Record<number, string | null> = {
    500: 'claude', // self is never the answer, even if named claude
    400: 'bun',
    300: '/Users/x/.local/bin/claude',
    200: 'claude',
    1: 'launchd',
  }
  const commOf = (pid: number) => comms[pid] ?? null
  assert.equal(nearestClaudeAncestor([500, 400, 300, 200, 1], commOf), 300)
  assert.equal(nearestClaudeAncestor([500, 400, 1], commOf), null)
  assert.equal(nearestClaudeAncestor([500], commOf), null)
  assert.equal(nearestClaudeAncestor([], commOf), null)
  assert.equal(nearestClaudeAncestor([500, 400, 300], () => null), null)
  assert.equal(
    nearestClaudeAncestor([500, 400, 300], () => {
      throw new Error('ps')
    }),
    null,
  )
})

test('writeAgentStateAtomic writes through a temp file and a rename, creating the dir', () => {
  const dir = tempDir()
  try {
    const path = join(dir, '123', AGENT_STATE_FILE_NAME)
    const state = buildAgentState({ ...baseSnapshot(), pid: 4242, lastActivityAtMs: T0, nowMs: T0 })!
    assert.equal(writeAgentStateAtomic(path, state), true)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), state)
    assert.deepEqual(readdirSync(join(dir, '123')), [AGENT_STATE_FILE_NAME], 'no temp file left behind')
    const next = { ...state, turnInFlight: true }
    assert.equal(writeAgentStateAtomic(path, next), true)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).turnInFlight, true)
    // A path that cannot be written (its parent is a FILE) is false, not a throw.
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    assert.equal(writeAgentStateAtomic(join(blocker, AGENT_STATE_FILE_NAME), state), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the write is atomic: the body goes to a temp file and only a rename makes it visible', () => {
  const calls: string[] = []
  const state = buildAgentState({ ...baseSnapshot(), pid: 4242, lastActivityAtMs: T0, nowMs: T0 })!
  const ok = writeAgentStateAtomic('/s/123/agent-state.json', state, {
    mkdir: (d) => calls.push(`mkdir ${d}`),
    writeFile: (p) => calls.push(`write ${p}`),
    rename: (a, b) => calls.push(`rename ${a} ${b}`),
    unlink: (p) => calls.push(`unlink ${p}`),
  })
  assert.equal(ok, true)
  const tmp = `/s/123/agent-state.json.${process.pid}.tmp`
  assert.deepEqual(calls, ['mkdir /s/123', `write ${tmp}`, `rename ${tmp} /s/123/agent-state.json`])
  // A failed rename cleans the temp file up and reports false.
  const failed: string[] = []
  assert.equal(
    writeAgentStateAtomic('/s/123/agent-state.json', state, {
      mkdir: () => {},
      writeFile: (p) => failed.push(`write ${p}`),
      rename: () => {
        throw new Error('EXDEV')
      },
      unlink: (p) => failed.push(`unlink ${p}`),
    }),
    false,
  )
  assert.deepEqual(failed, [`write ${tmp}`, `unlink ${tmp}`])
})

test('removeAgentStateIfOurs removes only a file this pid wrote', () => {
  const dir = tempDir()
  try {
    const path = join(dir, AGENT_STATE_FILE_NAME)
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, pid: 999 }))
    assert.equal(removeAgentStateIfOurs(path, 4242), false)
    assert.ok(existsSync(path), "a rival holder's file is left alone")
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, pid: 4242 }))
    assert.equal(removeAgentStateIfOurs(path, 4242), true)
    assert.ok(!existsSync(path))
    assert.equal(removeAgentStateIfOurs(path, 4242), false, 'missing is fine')
    writeFileSync(path, '{garbage')
    assert.equal(removeAgentStateIfOurs(path, 4242), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function harness(over: { holder?: boolean } = {}) {
  const dir = tempDir()
  const path = join(dir, '123', AGENT_STATE_FILE_NAME)
  let now = T0
  let snap = baseSnapshot()
  let holder = over.holder ?? true
  const writes: number[] = []
  const publisher = new AgentStatePublisher({
    path,
    pid: 4242,
    now: () => now,
    snapshot: () => snap,
    shouldPublish: () => holder,
    write: (p, state) => {
      writes.push(now)
      return writeAgentStateAtomic(p, state)
    },
  })
  return {
    path,
    publisher,
    writes,
    read: () => JSON.parse(readFileSync(path, 'utf8')),
    advance: (ms: number) => {
      now += ms
    },
    set: (over: Partial<AgentStateSnapshot>) => {
      snap = { ...snap, ...over }
    },
    setHolder: (value: boolean) => {
      holder = value
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('the publisher writes on every change and at least every 30 s, and nothing in between', () => {
  const h = harness()
  try {
    assert.equal(h.publisher.tick(), 'written')
    assert.equal(h.read().updatedAt, new Date(T0).toISOString())
    h.advance(1_000)
    assert.equal(h.publisher.tick(), 'unchanged')
    h.set({ turnInFlight: true })
    assert.equal(h.publisher.tick(), 'written', 'a turn starting is published at once')
    assert.equal(h.read().turnInFlight, true)
    h.advance(1_000)
    h.set({ pendingPermissions: 1 })
    assert.equal(h.publisher.tick(), 'written')
    h.advance(AGENT_STATE_MAX_INTERVAL_MS - 1)
    assert.equal(h.publisher.tick(), 'unchanged')
    h.advance(1)
    assert.equal(h.publisher.tick(), 'written', 'an unchanged state is still refreshed every 30 s')
    assert.equal(h.writes.length, 4)
  } finally {
    h.cleanup()
  }
})

test('only the lock holder publishes, and a daemon that regains the lock publishes at once', () => {
  const h = harness({ holder: false })
  try {
    assert.equal(h.publisher.tick(), 'skipped')
    assert.ok(!existsSync(h.path))
    h.setHolder(true)
    assert.equal(h.publisher.tick(), 'written')
    h.setHolder(false)
    h.advance(1_000)
    h.set({ pendingMessages: 3 })
    assert.equal(h.publisher.tick(), 'skipped')
    h.setHolder(true)
    h.advance(1_000)
    assert.equal(h.publisher.tick(), 'written')
    assert.equal(h.read().pendingMessages, 3)
  } finally {
    h.cleanup()
  }
})

test('lastActivityAt is the newest activity, and being busy IS activity until it ends', () => {
  const h = harness()
  try {
    h.set({ activityAtMs: [T0 - 120_000, null, T0 - 60_000] })
    h.publisher.tick()
    assert.equal(h.read().lastActivityAt, new Date(T0 - 60_000).toISOString())
    h.advance(5_000)
    h.set({ pendingMessages: 1 })
    h.publisher.tick()
    assert.equal(h.read().lastActivityAt, new Date(T0 + 5_000).toISOString())
    h.advance(5_000)
    h.advance(1_000)
    assert.equal(h.publisher.tick(), 'unchanged', 'staying busy is not news: no rewrite every tick')
    h.set({ pendingMessages: 0 })
    h.publisher.tick()
    assert.equal(h.read().lastActivityAt, new Date(T0 + 11_000).toISOString(), 'the quiet window starts when the work ended')
    h.advance(5_000)
    assert.equal(h.publisher.tick(), 'unchanged')
    assert.equal(h.read().lastActivityAt, new Date(T0 + 11_000).toISOString())
  } finally {
    h.cleanup()
  }
})

test('the publisher never throws, and its shutdown removes only its own file', () => {
  const h = harness()
  try {
    h.publisher.tick()
    assert.ok(existsSync(h.path))
    h.publisher.shutdown()
    assert.ok(!existsSync(h.path), 'a clean shutdown takes the state away')
    assert.equal(h.publisher.tick(), 'skipped', 'and nothing is published after it')
    const broken = new AgentStatePublisher({
      path: h.path,
      pid: 4242,
      now: () => T0,
      snapshot: () => {
        throw new Error('boom')
      },
      shouldPublish: () => true,
    })
    assert.equal(broken.tick(), 'failed')
    broken.shutdown()
  } finally {
    h.cleanup()
  }
})

test('memoizeFor recomputes only after its ttl', () => {
  let now = 0
  let calls = 0
  const get = memoizeFor(30_000, () => now, () => {
    calls += 1
    return `v${calls}`
  })
  assert.equal(get(), 'v1')
  now = 29_999
  assert.equal(get(), 'v1')
  now = 30_000
  assert.equal(get(), 'v2')
  assert.equal(calls, 2)
})

test('memoizeUntilFound keeps an answer forever and retries a miss only after the retry window', () => {
  let now = 0
  let calls = 0
  let answer: number | null = null
  const get = memoizeUntilFound(600_000, () => now, () => {
    calls += 1
    return answer
  })
  assert.equal(get(), null)
  now = 599_999
  assert.equal(get(), null)
  assert.equal(calls, 1, 'a miss is not retried inside the window')
  answer = 4200
  now = 600_000
  assert.equal(get(), 4200)
  answer = 9999
  now = 10_000_000
  assert.equal(get(), 4200, 'a found reading never changes')
  assert.equal(calls, 2)
  const throwing = memoizeUntilFound(1, () => 0, () => {
    throw new Error('ps')
  })
  assert.equal(throwing(), null)
})

test('server.ts publishes the real daemon state, from the lock holder, and removes it on shutdown', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const server = readFileSync(join(root, 'server.ts'), 'utf8')
  const at = server.indexOf('const agentStatePublisher = new AgentStatePublisher(')
  assert.ok(at > 0, 'the publisher is wired')
  const wiring = server.slice(at, server.indexOf('\n})\n', at))
  assert.match(wiring, /shouldPublish: \(\) => lockHeld/)
  assert.match(wiring, /turnInFlight: hookTurnLive \|\| hookTurn\.carried\.size > 0,/)
  assert.match(wiring, /sessionId: liveSessionId/)
  assert.match(wiring, /activityAtMs: \[DAEMON_START_MS, lastInboundAtMs, lastHookEventAtMs\]/)
  assert.match(wiring, /claudePid: agentClaudePid\(\)/)
  assert.match(wiring, /pendingMessages: pendingInbounds\.size/)
  assert.match(wiring, /pendingPermissions: pendingPermissions\.size/)
  assert.match(wiring, /activeOperations: messageActivity\.activeOperations/)
  assert.match(wiring, /runningVersion: RUNNING_VERSION/)
  assert.match(wiring, /pendingRestartVersion: agentStatePendingRestart\(\)/)
  assert.match(server, /const agentStatePendingRestart = memoizeFor\([\s\S]{0,200}daemonPendingRestartVersion\(\)/)
  assert.match(server, /setInterval\(\(\) => agentStatePublisher\.tick\(\), AGENT_STATE_TICK_MS\)\.unref\(\)/)
  // The live session id is learned from the daemon's OWN admitted hook events,
  // and every hook event pokes a publish (a turn start is news at once).
  const hookAt = server.indexOf('function onHookPayload(')
  const hookBody = server.slice(hookAt, server.indexOf('\n}\n', hookAt))
  assert.match(hookBody, /liveSessionId = hookSessionId/)
  assert.match(hookBody, /lastHookEventAtMs = Date\.now\(\)/)
  assert.match(hookBody, /agentStatePublisher\.tick\(\)\s*$/)
  // Both exit paths take the state away (removeAgentStateIfOurs inside).
  const shutdownAt = server.indexOf('const shutdown = (cause: ShutdownCause | string, code: number): void => {')
  const shutdownBody = server.slice(shutdownAt, server.indexOf('process.exit(code)', shutdownAt))
  assert.ok(shutdownBody.includes('agentStatePublisher.shutdown()'))
  const exitAt = server.indexOf("process.on('exit', () => {", shutdownAt)
  assert.ok(server.slice(exitAt, exitAt + 400).includes('agentStatePublisher.shutdown()'))
})
