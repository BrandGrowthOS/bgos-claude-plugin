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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
  findClaudeAncestor,
  hookTurnSignal,
  isWin32ClaudeProcess,
  memoizeFor,
  memoizeUntilFound,
  nearestClaudeAncestor,
  nearestClaudeAncestorWin32,
  readSessionTranscript,
  removeAgentStateIfOurs,
  writeAgentStateAtomic,
  type AgentStateSnapshot,
  win32AncestryCommand,
} from '../lib/agent-state.ts'
import { SessionTranscriptBinder } from '../lib/session-binding.ts'
import { mungeCwd } from '../lib/usage-report.ts'

const SESSION = '8c1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b'
const T0 = Date.parse('2026-10-06T19:00:00.000Z')

const baseSnapshot = (over: Partial<AgentStateSnapshot> = {}): AgentStateSnapshot => ({
  assistantId: '123',
  claudePid: 4200,
  runningVersion: '0.62.0',
  pendingRestartVersion: '0.62.1',
  turnInFlight: false,
  turnSignal: 'hooks',
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
    turnSignal: 'hooks',
    pendingMessages: 0,
    pendingPermissions: 0,
    activeOperations: 0,
    lastActivityAt: '2026-10-06T19:00:00.000Z',
    sessionId: SESSION,
    updatedAt: '2026-10-06T19:00:30.000Z',
  })
  assert.deepEqual(Object.keys(state!), [
    'schemaVersion', 'assistantId', 'pid', 'claudePid', 'runningVersion', 'pendingRestartVersion',
    'turnInFlight', 'turnSignal', 'pendingMessages', 'pendingPermissions', 'activeOperations', 'lastActivityAt',
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
  // turnSignal is 'hooks' only when the daemon says so: anything else is
  // 'none', the reading under which turnInFlight proves nothing.
  assert.equal(build({ turnSignal: 'none' })!.turnSignal, 'none')
  assert.equal(build({ turnSignal: 'HOOKS' as 'hooks' })!.turnSignal, 'none')
  assert.equal(build({ turnSignal: undefined as unknown as 'none' })!.turnSignal, 'none')
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
  // The contract location (design section 7): next to the cursor file, which
  // is ~/.bgos-plugin-state/<id>/ (BGOS_PLUGIN_STATE_DIR moves it), where the
  // watcher looks.
  assert.match(wiring, /path: pathJoin\(pathDirname\(CURSOR_FILE_PATH\), AGENT_STATE_FILE_NAME\),/)
  assert.match(wiring, /shouldPublish: \(\) => lockHeld/)
  assert.match(wiring, /turnInFlight: hookTurnLive \|\| hookTurn\.carried\.size > 0,/)
  assert.match(wiring, /sessionId: \(hookEndedSessionId === null \? liveSessionId : null\)/)
  assert.match(wiring, /activityAtMs: \[DAEMON_START_MS, lastInboundAtMs, lastHookEventAtMs, /)
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
  // A NEW session restarts the clock the pin's settle window is measured on.
  assert.match(hookBody, /liveSessionId = hookSessionId\n\s*liveSessionSeenAtMs = Date\.now\(\)/)
  assert.match(hookBody, /lastHookEventAtMs = Date\.now\(\)/)
  assert.match(hookBody, /agentStatePublisher\.tick\(\)\s*$/)
  // Both exit paths take the state away (removeAgentStateIfOurs inside).
  const shutdownAt = server.indexOf('const shutdown = (cause: ShutdownCause | string, code: number): void => {')
  const shutdownBody = server.slice(shutdownAt, server.indexOf('process.exit(code)', shutdownAt))
  assert.ok(shutdownBody.includes('agentStatePublisher.shutdown()'))
  const exitAt = server.indexOf("process.on('exit', () => {", shutdownAt)
  assert.ok(server.slice(exitAt, exitAt + 400).includes('agentStatePublisher.shutdown()'))
})

// ── Finding F1 (mission 104 code review): an agent without the hook rail ────
//
// Every turn signal the daemon published came from consumed hook events. A
// clone agent whose folder registers no BGOS hooks (KC's whole fleet on the M6
// today) therefore published a FRESH file with turnInFlight false, sessionId
// null and a lastActivityAt frozen at boot or its last inbound, and the
// watcher's 10 minute window passed in the middle of a long Read/Edit/Task
// job. Now: `turnSignal` says whether turnInFlight means anything (the watcher
// decides what 'none' costs), lastActivityAt counts the transcript the agent
// is writing, and sessionId falls back to the transcript the binding chain
// PROVED, so the watcher can stat the transcript and the spool itself.

const SUB = '1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6'

function transcriptFixture() {
  const root = tempDir()
  const agent = '/Users/kc/agents/vexa'
  const projectDir = join(root, 'projects', mungeCwd(agent))
  mkdirSync(projectDir, { recursive: true })
  const write = (path: string, atMs: number) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{}\n')
    utimesSync(path, atMs / 1000, atMs / 1000)
    return path
  }
  return { root, agent, projectDir, write }
}

test('readSessionTranscript: the bound transcript and its subagents are the activity, a proven one is the session', () => {
  const f = transcriptFixture()
  try {
    const ours = f.write(join(f.projectDir, `${SESSION}.jsonl`), T0 - 9 * 60_000)
    f.write(join(f.projectDir, `${SUB}.jsonl`), T0 - 60_000) // a neighbour in the same folder
    const proven = { path: ours, binding: { name: `${SESSION}.jsonl`, source: 'env' as const } }
    assert.deepEqual(readSessionTranscript({ resolve: () => proven, projectDir: f.projectDir }), {
      activityMs: T0 - 9 * 60_000,
      sessionId: SESSION,
    })
    // Claude Code 2.1 writes a Task subagent's rows beside the transcript, so a
    // long subagent run moves no byte of the main file.
    f.write(join(f.projectDir, SESSION, 'subagents', 'agent-a1.jsonl'), T0 - 5 * 60_000)
    f.write(join(f.projectDir, SESSION, 'subagents', 'agent-a1.meta.json'), T0 - 5 * 60_000)
    assert.equal(readSessionTranscript({ resolve: () => proven, projectDir: f.projectDir }).activityMs, T0 - 5 * 60_000)
    // A workflow's agents sit two dirs further down, one dir per run (the
    // layout 2.1.292 writes on disk): a long workflow is activity too.
    f.write(join(f.projectDir, SESSION, 'subagents', 'workflows', 'wf_458dea5c-4d9', 'agent-b2.jsonl'), T0 - 2 * 60_000)
    assert.equal(readSessionTranscript({ resolve: () => proven, projectDir: f.projectDir }).activityMs, T0 - 2 * 60_000)
    // A guess (newest-mtime) still counts as activity, never as the session,
    // and it adds the folder rather than narrowing to itself (delta F3).
    const guessed = { path: ours, binding: { name: `${SESSION}.jsonl`, source: 'newest-mtime' as const } }
    assert.deepEqual(readSessionTranscript({ resolve: () => guessed, projectDir: f.projectDir, now: T0 }), {
      activityMs: T0 - 60_000,
      sessionId: null,
    })
    // Unbound (the binder refuses to guess between two live transcripts): any
    // transcript in the folder being written is activity, the safe direction.
    assert.deepEqual(readSessionTranscript({ resolve: () => null, projectDir: f.projectDir }), {
      activityMs: T0 - 60_000,
      sessionId: null,
    })
    assert.deepEqual(readSessionTranscript({ resolve: () => null, projectDir: join(f.root, 'missing') }), {
      activityMs: null,
      sessionId: null,
    })
    // A binder that throws costs the reading, never the publish.
    const boom = () => {
      throw new Error('binder')
    }
    assert.deepEqual(readSessionTranscript({ resolve: boom, projectDir: f.projectDir }), { activityMs: null, sessionId: null })
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('a hookless agent writing its transcript a minute ago publishes that minute, its session and turnSignal none', () => {
  const f = transcriptFixture()
  try {
    // hoai launched it with --session-id, so the CLI hands the daemon that id.
    f.write(join(f.projectDir, `${SESSION}.jsonl`), T0 - 60_000)
    const binder = new SessionTranscriptBinder(f.agent, { claudeHome: f.root, envSessionId: SESSION })
    const reading = () => readSessionTranscript({ resolve: () => binder.resolve(T0), projectDir: binder.projectDirectory })
    const lastHookEventAtMs: number | null = null
    const hookEndedSessionId: string | null = null
    const liveSessionId: string | null = null
    const writes: Array<ReturnType<typeof buildAgentState>> = []
    const publisher = new AgentStatePublisher({
      path: join(f.root, AGENT_STATE_FILE_NAME),
      pid: 4242,
      now: () => T0,
      shouldPublish: () => true,
      write: (_path, state) => {
        writes.push(state)
        return true
      },
      // What server.ts publishes, with no hook event ever consumed.
      snapshot: () => ({
        ...baseSnapshot(),
        turnInFlight: false,
        turnSignal: hookTurnSignal({ lastEventAtMs: lastHookEventAtMs, endedSessionId: hookEndedSessionId }),
        activityAtMs: [T0 - 30 * 60_000, null, lastHookEventAtMs, reading().activityMs],
        sessionId: (hookEndedSessionId === null ? liveSessionId : null) ?? reading().sessionId,
      }),
    })
    assert.equal(publisher.tick(), 'written')
    const state = writes[0]!
    assert.equal(state.turnSignal, 'none')
    assert.equal(state.turnInFlight, false)
    assert.equal(state.lastActivityAt, new Date(T0 - 60_000).toISOString(), 'the transcript write, not the boot')
    assert.equal(state.sessionId, SESSION)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

// ── Delta review F3 (mission 104): a guess replaced the folder scan ─────────
//
// The docstring promised that a wrong guess "only makes the agent look
// busier", but any binding at all, a newest-mtime guess or its sticky keep
// included, replaced the project dir scan with ONE file: a neighbour's. The
// agent's own transcript and its Task or workflow subagent files were never
// read, and the unbound scan never walked subagents/ either. A hookless
// agent busy in a long subagent job then read as quiet past the watcher's
// 30 min window. Now only a POSITIVE binding narrows the reading; anything
// else adds every transcript in the folder, and the subagents of each one
// written in the last STALE_TURN_MS.

test('F3: a guessed binding adds the folder, subagents included, to the activity; it never replaces it', () => {
  const f = transcriptFixture()
  try {
    const NEIGHBOUR = SUB
    const DISCARDED = '0f0e0d0c-0b0a-4908-8706-050403020100'
    // A --resume whose env id names no file; at boot only the neighbour wrote
    // in the last 10 min, so the binder guesses it, then keeps it (sticky).
    f.write(join(f.projectDir, `${SESSION}.jsonl`), T0 - 40 * 60_000)
    f.write(join(f.projectDir, `${NEIGHBOUR}.jsonl`), T0 - 60_000)
    const binder = new SessionTranscriptBinder(f.agent, { claudeHome: f.root, envSessionId: DISCARDED })
    assert.equal(binder.resolve(T0)?.binding.source, 'newest-mtime', 'the boot guess')
    // 35 min later only our own Task subagent has written.
    const later = T0 + 35 * 60_000
    f.write(join(f.projectDir, SESSION, 'subagents', 'agent-a1.jsonl'), later - 30_000)
    const guessed = readSessionTranscript({ resolve: () => binder.resolve(later), projectDir: f.projectDir, now: later })
    assert.deepEqual(guessed, { activityMs: later - 30_000, sessionId: null }, 'our subagent, not the idle neighbour')

    // Unbound: two live transcripts and no proof. A subagent writing under
    // one of them is activity as much as the transcript itself.
    const g = transcriptFixture()
    try {
      g.write(join(g.projectDir, `${SESSION}.jsonl`), T0 - 5 * 60_000)
      g.write(join(g.projectDir, `${NEIGHBOUR}.jsonl`), T0 - 3 * 60_000)
      const unbound = new SessionTranscriptBinder(g.agent, { claudeHome: g.root, envSessionId: DISCARDED })
      assert.equal(unbound.resolve(T0), null, 'the binder refuses to guess')
      const at = T0 + 40 * 60_000
      g.write(join(g.projectDir, SESSION, 'subagents', 'workflows', 'wf_1', 'agent-b2.jsonl'), at - 10_000)
      assert.equal(readSessionTranscript({ resolve: () => unbound.resolve(at), projectDir: g.projectDir, now: at }).activityMs, at - 10_000)
      // A transcript idle past STALE_TURN_MS costs no subagent walk.
      const old = transcriptFixture()
      try {
        old.write(join(old.projectDir, `${SESSION}.jsonl`), at - 3 * 60 * 60_000)
        old.write(join(old.projectDir, `${NEIGHBOUR}.jsonl`), at - 3 * 60 * 60_000)
        old.write(join(old.projectDir, SESSION, 'subagents', 'agent-c3.jsonl'), at - 60_000)
        assert.equal(readSessionTranscript({ resolve: () => null, projectDir: old.projectDir, now: at }).activityMs, at - 3 * 60 * 60_000)
      } finally {
        rmSync(old.root, { recursive: true, force: true })
      }
    } finally {
      rmSync(g.root, { recursive: true, force: true })
    }
    // A POSITIVE binding still narrows the reading to our own files.
    const proven = { path: join(f.projectDir, `${SESSION}.jsonl`), binding: { name: `${SESSION}.jsonl`, source: 'marker' as const } }
    f.write(join(f.projectDir, `${NEIGHBOUR}.jsonl`), later)
    assert.deepEqual(readSessionTranscript({ resolve: () => proven, projectDir: f.projectDir, now: later }), {
      activityMs: later - 30_000,
      sessionId: SESSION,
    })
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

// ── Delta review F2 (mission 104): the rail outlived its session ────────────
//
// turnSignal turned 'hooks' at the first consumed event and stayed so for the
// life of the process. After a /clear the old session's SessionEnd is
// consumed and the intake unbinds, but the binder's hook binding still names
// the OLD transcript and outranks every other proof, so the new session's
// events are refused as unproven and its transcript is never read. The file
// then said 'hooks', turnInFlight false and an old activity stamp, and the
// watcher's 10 min window restarted a keyboard job mid turn. Now the rail
// vouches for turnInFlight only while it follows a live session, and the
// ended session's binding proves nothing: the folder is read as for a guess.

test('F2: after the bound session ends, turnSignal is none and the new transcript is the activity', () => {
  const f = transcriptFixture()
  try {
    const OLD = SESSION
    const NEW = SUB
    const old = f.write(join(f.projectDir, `${OLD}.jsonl`), T0 - 30 * 60_000)
    const binder = new SessionTranscriptBinder(f.agent, { claudeHome: f.root })
    binder.noteHookSession(OLD, old)
    // /clear: the person keeps typing in the new session, which the intake
    // never admitted, so only its transcript moves.
    f.write(join(f.projectDir, `${NEW}.jsonl`), T0 - 20_000)
    assert.equal(binder.resolve(T0)?.binding.source, 'hook', 'the binder still names the old file')
    const lastEventAtMs = T0 - 30 * 60_000
    const reading = readSessionTranscript({
      resolve: () => binder.resolve(T0),
      projectDir: f.projectDir,
      now: T0,
      endedSessionId: OLD,
    })
    assert.deepEqual(reading, { activityMs: T0 - 20_000, sessionId: null }, 'the new transcript, and no dead session')
    assert.equal(hookTurnSignal({ lastEventAtMs, endedSessionId: OLD }), 'none', 'the 30 min rule, not the 10 min one')
    // The same binding while its session lives is proof, and the rail counts.
    assert.deepEqual(
      readSessionTranscript({ resolve: () => binder.resolve(T0), projectDir: f.projectDir, now: T0, endedSessionId: null }),
      { activityMs: T0 - 30 * 60_000, sessionId: OLD },
    )
    assert.equal(hookTurnSignal({ lastEventAtMs, endedSessionId: null }), 'hooks')
    // No event ever consumed: nothing to vouch for, ended or not.
    assert.equal(hookTurnSignal({ lastEventAtMs: null, endedSessionId: null }), 'none')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('server.ts drops the hook turn signal at a consumed SessionEnd and takes it back at the next admitted event', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const server = readFileSync(join(root, 'server.ts'), 'utf8')
  assert.ok(server.includes('let hookEndedSessionId: string | null = null'), 'process scoped')
  const at = server.indexOf('function onHookPayload(')
  const body = server.slice(at, server.indexOf('\n}\n', at))
  // Every admitted event decides it: a SessionEnd names the ended session,
  // anything else is a live one again (a new session bound, or a resume).
  assert.match(body, /\n  hookEndedSessionId = event\.name === 'SessionEnd' \? hookSessionId \|\| null : null\n/)
  const wiring = server.slice(server.indexOf('const agentStatePublisher = new AgentStatePublisher('))
  assert.match(wiring, /turnSignal: hookTurnSignal\(\{ lastEventAtMs: lastHookEventAtMs, endedSessionId: hookEndedSessionId \}\),/)
  assert.match(wiring, /sessionId: \(hookEndedSessionId === null \? liveSessionId : null\) \?\? agentTranscript\(\)\.sessionId,/)
  assert.match(
    server,
    /readSessionTranscript\(\{\s*resolve: \(\) => sessionBinder\.resolve\(\),\s*projectDir: sessionBinder\.projectDirectory,\s*endedSessionId: hookEndedSessionId,\s*\}\)/,
  )
})

test('server.ts publishes turnSignal, the transcript activity and the proven session', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const server = readFileSync(join(root, 'server.ts'), 'utf8')
  const at = server.indexOf('const agentStatePublisher = new AgentStatePublisher(')
  const wiring = server.slice(at, server.indexOf('\n})\n', at))
  // 'hooks' while this daemon follows a live session of its own (the intake
  // admits nothing else, and onHookPayload is its only consumer; delta F2).
  assert.match(wiring, /turnSignal: hookTurnSignal\(\{ lastEventAtMs: lastHookEventAtMs, endedSessionId: hookEndedSessionId \}\),/)
  assert.match(wiring, /activityAtMs: \[DAEMON_START_MS, lastInboundAtMs, lastHookEventAtMs, agentTranscript\(\)\.activityMs\]/)
  assert.match(wiring, /sessionId: \(hookEndedSessionId === null \? liveSessionId : null\) \?\? agentTranscript\(\)\.sessionId,/)
  // One binder read per window, not per 1 s tick: it lists the project dir.
  assert.match(
    server,
    /const agentTranscript = memoizeFor\(AGENT_TRANSCRIPT_READ_MS, Date\.now, \(\) =>\s*readSessionTranscript\(\{\s*resolve: \(\) => sessionBinder\.resolve\(\),\s*projectDir: sessionBinder\.projectDirectory,\s*endedSessionId: hookEndedSessionId,\s*\}\),?\s*\)/,
  )
})

// ── Finding F2 (mission 104 code review): claudePid on Windows ──────────────
//
// The ancestor walk only spawned `ps`, which Windows does not have, and the
// name rule wanted exactly 'claude' after the last '/'. So a Windows daemon
// always published claudePid null; with no keepalive marker and no cwd lookup
// on win32 the watcher could never read the agent's process tree, and every
// staged update sat in waiting_idle process_tree_unreadable forever. The walk
// on win32 is one PowerShell call that follows ParentProcessId up from this
// process (Get-CimInstance Win32_Process), and a claude is claude.exe /
// claude, or a node running Claude Code's cli.js (the npm install).

type WinRow = { ProcessId: number; ParentProcessId: number; Name: string; CreationDate: number | null; CommandLine: string | null }
const winRow = (pid: number, ppid: number, name: string, command: string, createdMs: number | null = T0 - (10_000 - pid)): WinRow => ({
  ProcessId: pid,
  ParentProcessId: ppid,
  Name: name,
  CreationDate: createdMs,
  CommandLine: command,
})
const winExec = (rows: WinRow[] | string, code = 0) => {
  const calls: Array<[string, string[]]> = []
  const exec = (file: string, args: string[]) => {
    calls.push([file, args])
    return { code, stdout: typeof rows === 'string' ? rows : JSON.stringify(rows) }
  }
  return { exec, calls }
}
const DAEMON = winRow(4912, 4800, 'bun.exe', 'C:\\Users\\kc\\.bun\\bin\\bun.exe C:\\Users\\kc\\.claude\\plugins\\cache\\hoai\\0.62.0\\server.ts')
const LAUNCH = winRow(4800, 4700, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\kc\\.claude\\plugins\\cache\\hoai\\0.62.0\\bin\\bgos-launch.mjs C:\\Users\\kc\\.claude\\plugins\\cache\\hoai\\0.62.0\\server.ts')
const NATIVE = winRow(4700, 1000, 'claude.exe', '"C:\\Users\\kc\\.local\\bin\\claude.exe" --dangerously-load-development-channels server:bgos')
const EXPLORER = winRow(1000, 900, 'explorer.exe', 'C:\\WINDOWS\\Explorer.EXE')

test('win32: the ancestry is one PowerShell call that follows ParentProcessId up from this process', () => {
  const cmd = win32AncestryCommand(4912)!
  assert.equal(cmd.file, 'powershell.exe')
  assert.deepEqual(cmd.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
  const script = cmd.args[3]!
  assert.match(script, /^\$p = 4912;/, 'starts at this process')
  assert.match(script, /Get-CimInstance Win32_Process -Filter \('ProcessId=' \+ \$p\)/)
  assert.match(script, /\$p = \$x\.ParentProcessId/)
  // No double quote anywhere: Node escapes one as \" on the Windows command
  // line, which is the kind of quoting a PowerShell -Command must not depend on.
  assert.ok(!script.includes('"'))
  assert.equal(win32AncestryCommand(0), null)
  assert.equal(win32AncestryCommand(Number.NaN), null)
})

test('win32: the nearest claude.exe ancestor is the claude pid', () => {
  const { exec, calls } = winExec([DAEMON, LAUNCH, NATIVE, EXPLORER])
  assert.equal(nearestClaudeAncestorWin32(4912, exec), 4700)
  assert.equal(calls.length, 1, 'one call, not one per ancestor')
  // The order of the rows is not trusted: the walk follows the ids.
  assert.equal(nearestClaudeAncestorWin32(4912, winExec([EXPLORER, NATIVE, DAEMON, LAUNCH]).exec), 4700)
})

test('win32: a node running Claude Code cli.js (the npm install) is a claude, quoted or not', () => {
  const npm = winRow(4600, 4500, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe"  "C:\\Users\\kc\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" --resume x')
  const shim = winRow(4500, 1000, 'cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "claude --resume x"')
  const { exec } = winExec([DAEMON, { ...LAUNCH, ParentProcessId: 4600 }, npm, shim, EXPLORER])
  assert.equal(nearestClaudeAncestorWin32(4912, exec), 4600)
  assert.ok(isWin32ClaudeProcess({ name: 'node.exe', command: 'node C:/npm/node_modules/@anthropic-ai/claude-code/cli.js' }))
  assert.ok(isWin32ClaudeProcess({ name: 'CLAUDE.EXE', command: null }))
  assert.ok(isWin32ClaudeProcess({ name: 'claude', command: '' }))
  assert.ok(!isWin32ClaudeProcess({ name: 'node.exe', command: 'node C:/tools/claude-log-tail.js' }))
  assert.ok(!isWin32ClaudeProcess({ name: 'cmd.exe', command: 'cmd /c C:/npm/node_modules/@anthropic-ai/claude-code/cli.js' }), 'a node runs it')
  assert.ok(!isWin32ClaudeProcess({ name: 'notepad.exe', command: 'notepad C:/claude.exe.txt' }))
})

test('win32: no claude, a failed or unreadable call, and a reused parent pid all answer null', () => {
  assert.equal(nearestClaudeAncestorWin32(4912, winExec([DAEMON, LAUNCH, EXPLORER]).exec), null)
  assert.equal(nearestClaudeAncestorWin32(4912, winExec([DAEMON, LAUNCH, NATIVE], 1).exec), null)
  assert.equal(nearestClaudeAncestorWin32(4912, winExec('not json').exec), null)
  assert.equal(nearestClaudeAncestorWin32(4912, winExec([]).exec), null)
  // Self is never the answer, even when named claude.
  assert.equal(nearestClaudeAncestorWin32(4700, winExec([NATIVE, EXPLORER]).exec), null)
  // Windows reuses pids: a "parent" created after its child is a stranger
  // that inherited the dead parent's pid, so the walk stops there.
  const late = { ...NATIVE, CreationDate: T0 + 60_000 }
  assert.equal(nearestClaudeAncestorWin32(4912, winExec([DAEMON, LAUNCH, late, EXPLORER]).exec), null)
  assert.equal(
    nearestClaudeAncestorWin32(4912, () => {
      throw new Error('spawn')
    }),
    null,
  )
})

test('findClaudeAncestor walks with PowerShell on win32 and with ps elsewhere', () => {
  const { exec, calls } = winExec([DAEMON, LAUNCH, NATIVE, EXPLORER])
  assert.equal(findClaudeAncestor({ platform: 'win32', ownPid: 4912, execSync: exec }), 4700)
  assert.equal(calls[0]![0], 'powershell.exe')
  const ppid: Record<number, number> = { 500: 400, 400: 300, 300: 1 }
  const comm: Record<number, string> = { 400: 'bun', 300: '/Users/x/.local/bin/claude' }
  const psCalls: string[][] = []
  const ps = (file: string, args: string[]) => {
    psCalls.push([file, ...args])
    const pid = Number(args[args.length - 1])
    if (args[1] === 'ppid=') return { code: 0, stdout: `${ppid[pid] ?? 0}\n` }
    return { code: 0, stdout: `${comm[pid] ?? 'launchd'}\n` }
  }
  assert.equal(findClaudeAncestor({ platform: 'darwin', ownPid: 500, execSync: ps }), 300)
  assert.ok(psCalls.every((c) => c[0] === 'ps'))
})

test('server.ts finds the claude ancestor through the platform aware walk', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const server = readFileSync(join(root, 'server.ts'), 'utf8')
  assert.match(
    server,
    /const agentClaudePid = memoizeUntilFound\(CLAUDE_ANCESTOR_RETRY_MS, Date\.now, \(\) =>\s*findClaudeAncestor\(\{ platform: process\.platform, ownPid: process\.pid, execSync: defaultExecSync \}\),?\s*\)/,
  )
})
