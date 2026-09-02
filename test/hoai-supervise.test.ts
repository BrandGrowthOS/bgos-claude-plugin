import { readFileSync } from 'node:fs'
/**
 * Launcher-loop supervisor tests (one-click updates): pure decision pieces
 * plus the full superviseClaude loop with fake spawn and fake fs. The loop
 * is the restart authority for interactive sessions (Windows included), so
 * this suite pins: normal exits stay exactly as before (no relaunch), a
 * restart marker SIGTERMs the child and relaunches resuming the agent's OWN
 * pinned session (identity-safe, never --continue), marker contents are never
 * read, the 3-per-hour budget, the stale-marker sweep at start, the singleton
 * guard, never-leave-dead recovery, the dev-channels gate auto-accept, and
 * supervisor.json lifecycle.
 *
 * Run: npm test (routed to tsx --test) or npx tsx --test test/hoai-supervise.test.ts
 */

import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EXIT_ALREADY_SUPERVISED,
  MARKER_POLL_MS,
  MAX_RELAUNCHES_PER_WINDOW,
  RELAUNCH_HEALTHY_MS,
  RELAUNCH_WINDOW_MS,
  RESTART_MARKER_FILE_NAME,
  SESSION_ID_FILE_NAME,
  SUPERVISOR_FILE_NAME,
  buildGateAutoAcceptExpect,
  decideMarkerRelaunch,
  decideRelaunchRecovery,
  decideSupervisorArming,
  ensurePinnedSessionId,
  mungeSessionCwd,
  relaunchClaudeArgs,
  relaunchNeedsGateAutoAccept,
  win32GateHelperArgs,
  sessionArgsFor,
  sessionTranscriptPath,
  superviseAssistantId,
  superviseClaude,
  supervisorFileBody,
} from '../bin/hoai-core.mjs'

const POSIX_HOME = '/home/kc'
const CLONE_SCRIPT_DIR = '/home/kc/bgos-claude-plugin/bin'
const MARKETPLACE_SCRIPT_DIR =
  'C:\\Users\\x\\.claude\\plugins\\cache\\hoai\\hoai\\0.38.0\\bin'

// -- decideMarkerRelaunch -----------------------------------------------------

test('decideMarkerRelaunch: allows up to the budget inside a rolling hour', () => {
  const now = 1_000_000_000
  assert.deepEqual(decideMarkerRelaunch([], now), { allow: true, recent: [] })
  const two = [now - 1000, now - 2000]
  assert.deepEqual(decideMarkerRelaunch(two, now), { allow: true, recent: two })
  const three = [now - 1000, now - 2000, now - 3000]
  assert.equal(decideMarkerRelaunch(three, now).allow, false)
  assert.equal(MAX_RELAUNCHES_PER_WINDOW, 3)
})

test('decideMarkerRelaunch: the window slides, old relaunches expire', () => {
  const now = 1_000_000_000
  const stale = [now - RELAUNCH_WINDOW_MS, now - RELAUNCH_WINDOW_MS - 1]
  const decision = decideMarkerRelaunch([...stale, now - 1000], now)
  assert.equal(decision.allow, true)
  assert.deepEqual(decision.recent, [now - 1000])
})

test('decideMarkerRelaunch: junk timestamps are dropped, never counted', () => {
  const now = 1_000_000_000
  assert.deepEqual(decideMarkerRelaunch([NaN, Infinity, 'x' as unknown as number], now), {
    allow: true,
    recent: [],
  })
})

// -- relaunchClaudeArgs -------------------------------------------------------

test('relaunchClaudeArgs: clone install re-detects the clone spec and appends the session args (never --continue)', () => {
  const args = relaunchClaudeArgs({
    scriptDir: CLONE_SCRIPT_DIR,
    env: {},
    home: POSIX_HOME,
    sessionArgs: ['--resume', 'abc-123'],
  })
  assert.deepEqual(args, [
    '--dangerously-skip-permissions',
    '--dangerously-load-development-channels',
    'server:bgos',
    '--resume',
    'abc-123',
  ])
  assert.equal(args.includes('--continue'), false)
})

test('relaunchClaudeArgs: marketplace install re-detects, keeps the plugin spec, appends session args', () => {
  const args = relaunchClaudeArgs({
    scriptDir: MARKETPLACE_SCRIPT_DIR,
    env: {},
    home: 'C:\\Users\\x',
    sessionArgs: ['--session-id', 'new-uuid'],
  })
  assert.deepEqual(args, [
    '--dangerously-skip-permissions',
    '--dangerously-load-development-channels',
    'plugin:hoai@hoai',
    '--session-id',
    'new-uuid',
  ])
})

// -- GAP 1: identity-safe session args ---------------------------------------

test('mungeSessionCwd mirrors Claude Code project-dir munge (every non-alnum -> -)', () => {
  assert.equal(mungeSessionCwd('/Users/fitecho/BGOS'), '-Users-fitecho-BGOS')
  assert.equal(mungeSessionCwd('/agents/athena'), '-agents-athena')
  assert.equal(mungeSessionCwd('C:\\Users\\x'), 'C--Users-x')
})

test('sessionTranscriptPath points at ~/.claude/projects/<munged-cwd>/<id>.jsonl', () => {
  assert.equal(
    sessionTranscriptPath('/home/kc', '/agents/athena', 'af3ea950-c006'),
    '/home/kc/.claude/projects/-agents-athena/af3ea950-c006.jsonl',
  )
})

test('sessionArgsFor: resume an existing session, create a missing one, empty without an id', () => {
  assert.deepEqual(sessionArgsFor('u1', true), ['--resume', 'u1'])
  assert.deepEqual(sessionArgsFor('u1', false), ['--session-id', 'u1'])
  assert.deepEqual(sessionArgsFor('', true), [])
  assert.deepEqual(sessionArgsFor('', false), [])
})

test('ensurePinnedSessionId: reads a valid existing UUID pin, never regenerates it', () => {
  const existing = '12345678-1234-4123-8123-1234567890ab'
  const files = new Map<string, string>([['/state/session-id', `${existing}\n`]])
  const id = ensurePinnedSessionId({
    path: '/state/session-id',
    readFile: (p) => files.get(p) ?? null,
    writeFile: () => {
      throw new Error('must not write when a valid pin exists')
    },
    generateId: () => '00000000-0000-4000-8000-000000000000',
  })
  assert.equal(id, existing)
})

test('ensurePinnedSessionId: generates and persists a pin when none exists', () => {
  const fresh = 'abcdef01-2345-4678-8abc-def012345678'
  const files = new Map<string, string>()
  const id = ensurePinnedSessionId({
    path: '/state/session-id',
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => {
      files.set(p, c)
      return true
    },
    generateId: () => fresh,
  })
  assert.equal(id, fresh)
  assert.equal(files.get('/state/session-id'), fresh)
})

test('ensurePinnedSessionId: a malformed (non-UUID) pin is replaced, never passed on', () => {
  const files = new Map<string, string>([['/state/session-id', 'garbage-not-a-uuid']])
  const fresh = 'abcdef01-2345-4678-8abc-def012345678'
  const id = ensurePinnedSessionId({
    path: '/state/session-id',
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => {
      files.set(p, c)
      return true
    },
    generateId: () => fresh,
  })
  assert.equal(id, fresh)
  assert.equal(files.get('/state/session-id'), fresh)
})

// -- GAP 2: dev-channels prompt-stranding auto-accept -------------------------

test('relaunchNeedsGateAutoAccept: clone AND marketplace installs prompt on 2.1.241 (verified live on Windows)', () => {
  assert.equal(relaunchNeedsGateAutoAccept('clone'), true)
  assert.equal(relaunchNeedsGateAutoAccept('marketplace'), true)
})

test('buildGateAutoAcceptExpect: spawns claude with brace-quoted args and auto-accepts the confirm gate', () => {
  const script = buildGateAutoAcceptExpect({
    claudePath: '/usr/bin/claude',
    args: ['--dangerously-load-development-channels', 'server:bgos', '--resume', 'abc'],
  })
  // Spawns the command with each arg brace-quoted (Tcl literal, no injection).
  assert.equal(
    script.includes(
      'spawn /usr/bin/claude {--dangerously-load-development-channels} {server:bgos} {--resume} {abc}',
    ),
    true,
  )
  // Sends Enter on the single-word "confirm" footer (the run.expect lesson).
  assert.equal(/confirm/.test(script) && /send .\\r./.test(script), true)
  // A SIGTERM trap kills the spawned claude so a supervisor kill never orphans it.
  assert.equal(/trap .* SIGTERM/.test(script) && script.includes('exp_pid'), true)
  // Hands off to interact so a human is still relayed and kill still ends it.
  assert.equal(script.includes('interact'), true)
})

// -- superviseAssistantId -----------------------------------------------------

test('superviseAssistantId: folder pin, then env pin, then sole paired agent, else off', () => {
  const pinFile = `/agents/athena/.bgos-agent-id`
  assert.equal(
    superviseAssistantId({
      cwd: '/agents/athena',
      env: {},
      home: POSIX_HOME,
      readFile: (p) => (p === pinFile ? '871\n' : null),
      listDir: () => [],
    }),
    '871',
  )
  assert.equal(
    superviseAssistantId({
      cwd: '/x',
      env: { BGOS_ASSISTANT_ID: '42' },
      home: POSIX_HOME,
      readFile: () => null,
      listDir: () => [],
    }),
    '42',
  )
  assert.equal(
    superviseAssistantId({
      cwd: '/x',
      env: {},
      home: POSIX_HOME,
      readFile: () => null,
      listDir: () => ['credentials-7.json'],
    }),
    '7',
  )
  // Two paired agents and no pin: ambiguous, supervision stays off.
  assert.equal(
    superviseAssistantId({
      cwd: '/x',
      env: {},
      home: POSIX_HOME,
      readFile: () => null,
      listDir: () => ['credentials-7.json', 'credentials-8.json'],
    }),
    '',
  )
  // A non-numeric env pin cannot name a state dir: supervision off.
  assert.equal(
    superviseAssistantId({
      cwd: '/x',
      env: { BGOS_ASSISTANT_ID: 'athena' },
      home: POSIX_HOME,
      readFile: () => null,
      listDir: () => [],
    }),
    '',
  )
})

test('supervisorFileBody: pid + relaunch capability + startedAt', () => {
  const parsed = JSON.parse(supervisorFileBody(4242, '2026-08-22T00:00:00.000Z'))
  assert.deepEqual(parsed, {
    pid: 4242,
    capabilities: ['relaunch'],
    startedAt: '2026-08-22T00:00:00.000Z',
  })
})

// -- superviseClaude (the loop) ----------------------------------------------

const STATE_DIR = `${POSIX_HOME}/.bgos-agent/871`
const SUPERVISOR_PATH = `${STATE_DIR}/${SUPERVISOR_FILE_NAME}`
const MARKER_PATH = `${STATE_DIR}/${RESTART_MARKER_FILE_NAME}`
const SESSION_ID_PATH = `${STATE_DIR}/${SESSION_ID_FILE_NAME}`
// Distinct valid-UUID pins the fake launcher hands out in order.
const UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
]

class FakeChild extends EventEmitter {
  args: string[]
  killedWith: string | null = null
  constructor(args: readonly string[]) {
    super()
    this.args = [...args]
  }
  kill(signal?: string) {
    this.killedWith = signal ?? 'SIGTERM'
    // A SIGTERM'd claude exits shortly after; model that asynchronously.
    setTimeout(() => this.emit('exit', null, 'SIGTERM'), 1)
    return true
  }
  exit(code: number) {
    this.emit('exit', code, null)
  }
}

function loopHarness(opts: { markerBudgetUsed?: number[] } = {}) {
  const files = new Map<string, string>()
  const spawns: FakeChild[] = []
  const prints: string[] = []
  let idIdx = 0
  const spawnImpl = (_file: string, args: readonly string[]) => {
    const child = new FakeChild(args)
    spawns.push(child)
    return child
  }
  const run = (args: string[]) =>
    superviseClaude(args, {
      platform: 'linux',
      env: {},
      home: POSIX_HOME,
      cwd: '/agents/athena',
      scriptDir: CLONE_SCRIPT_DIR,
      readFile: (p: string) =>
        p === '/agents/athena/.bgos-agent-id' ? '871' : files.get(p) ?? null,
      listDir: () => [],
      spawnImpl: spawnImpl as never,
      writeErr: () => {},
      exists: (p: string) => files.has(p),
      writeFile: (p: string, content: string) => {
        files.set(p, content)
        return true
      },
      removeFile: (p: string) => files.delete(p),
      pollMs: 5,
      print: (line: string) => prints.push(line),
      // Deterministic pins; hasExpect:false keeps the direct claude spawn so the
      // The deferred fresh-retry pin (0.38.13) commits only after the fresh
      // session outlives the health window; this harness fires that timer at
      // once, so the never-leave-dead tests below observe the pin as before.
      // The window itself is covered in test/hoai-core.test.ts.
      setTimer: ((fn: () => void) => {
        fn()
        return 0
      }) as never,
      clearTimer: () => {},
      // tests can assert claude args (the expect wrapper has its own test).
      generateId: () => UUIDS[idIdx++] ?? UUIDS[UUIDS.length - 1]!,
      hasExpect: false,
    })
  void opts
  return { files, spawns, prints, run }
}

async function waitUntil(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

const BASE_ARGS = [
  '--dangerously-skip-permissions',
  '--dangerously-load-development-channels',
  'server:bgos',
]

test('superviseClaude: a normal exit relaunches nothing and cleans up supervisor.json', async () => {
  const h = loopHarness()
  const done = h.run(BASE_ARGS)
  await waitUntil(() => h.spawns.length === 1, 'first spawn')
  assert.equal(h.files.has(SUPERVISOR_PATH), true)
  const supervisor = JSON.parse(h.files.get(SUPERVISOR_PATH)!)
  assert.deepEqual(supervisor.capabilities, ['relaunch'])
  assert.equal(typeof supervisor.pid, 'number')
  h.spawns[0]!.exit(7)
  assert.equal(await done, 7)
  assert.equal(h.spawns.length, 1)
  assert.equal(h.files.has(SUPERVISOR_PATH), false)
})

test('superviseClaude: the first launch creates the agents OWN session by id (never --continue)', async () => {
  const h = loopHarness()
  const done = h.run(BASE_ARGS)
  await waitUntil(() => h.spawns.length === 1, 'first spawn')
  // Identity-safe: the agent creates its own pinned session, not --continue.
  assert.deepEqual(h.spawns[0]!.args, [...BASE_ARGS, '--session-id', UUIDS[0]])
  assert.equal(h.spawns[0]!.args.includes('--continue'), false)
  assert.equal(h.files.get(SESSION_ID_PATH), UUIDS[0])
  h.spawns[0]!.exit(0)
  assert.equal(await done, 0)
})

test('superviseClaude: a marker kills the child and relaunches resuming the agents OWN session', async () => {
  const h = loopHarness()
  const done = h.run(BASE_ARGS)
  await waitUntil(() => h.spawns.length === 1, 'first spawn')
  // The session wrote its transcript, so it can be resumed.
  h.files.set(`${POSIX_HOME}/.claude/projects/-agents-athena/${UUIDS[0]}.jsonl`, '{}')
  // Marker contents are hostile on purpose: only existence may matter.
  h.files.set(MARKER_PATH, JSON.stringify({ exec: 'rm -rf /' }))
  await waitUntil(() => h.spawns.length === 2, 'relaunch after marker')
  assert.equal(h.spawns[0]!.killedWith, 'SIGTERM')
  assert.equal(h.files.has(MARKER_PATH), false)
  // The relaunch RESUMES this agent's own pinned session, never --continue.
  assert.deepEqual(h.spawns[1]!.args, [...BASE_ARGS, '--resume', UUIDS[0]])
  assert.equal(h.spawns[1]!.args.includes('--continue'), false)
  h.spawns[1]!.exit(0)
  assert.equal(await done, 0)
  assert.equal(h.files.has(SUPERVISOR_PATH), false)
})

test('superviseClaude: a marker relaunch of a session with NO transcript creates it again by the SAME id (one launch, pin kept)', async () => {
  const h = loopHarness()
  const done = h.run(BASE_ARGS)
  await waitUntil(() => h.spawns.length === 1, 'first spawn')
  assert.deepEqual(h.spawns[0]!.args, [...BASE_ARGS, '--session-id', UUIDS[0]])
  // A channel-only session writes no transcript: --resume would be rejected
  // on the spot and cost a doomed launch plus a new id. Not tried.
  h.files.set(MARKER_PATH, '{}')
  await waitUntil(() => h.spawns.length === 2, 'relaunch after marker')
  assert.deepEqual(h.spawns[1]!.args, [...BASE_ARGS, '--session-id', UUIDS[0]])
  assert.equal(h.files.get(SESSION_ID_PATH), UUIDS[0])
  // Runs on healthily: nothing else is spawned.
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(h.spawns.length, 2)
  h.spawns[1]!.exit(0)
  assert.equal(await done, 0)
})

test('superviseClaude: a marker relaunch by id (no transcript) that dies fast non-zero still gets the one-shot fresh retry (never-leave-dead)', async () => {
  const h = loopHarness()
  const done = h.run(BASE_ARGS)
  await waitUntil(() => h.spawns.length === 1, 'first spawn')
  h.files.set(MARKER_PATH, '{}')
  await waitUntil(() => h.spawns.length === 2, 'relaunch after marker')
  assert.deepEqual(h.spawns[1]!.args, [...BASE_ARGS, '--session-id', UUIDS[0]])
  // A broken relaunch: dies fast, non-zero. Before, only a --resume got the
  // fresh retry; this shape returned the exit code and left the agent dead.
  h.spawns[1]!.exit(1)
  await waitUntil(() => h.spawns.length === 3, 'fresh fallback relaunch')
  assert.deepEqual(h.spawns[2]!.args, [...BASE_ARGS, '--session-id', UUIDS[1]])
  assert.equal(h.files.get(SESSION_ID_PATH), UUIDS[1])
  h.spawns[2]!.exit(0)
  assert.equal(await done, 0)
})

test('superviseClaude: the relaunch budget stops the loop, the session runs on', async () => {
  const h = loopHarness()
  const done = h.run(BASE_ARGS)
  for (let round = 0; round < MAX_RELAUNCHES_PER_WINDOW; round += 1) {
    await waitUntil(() => h.spawns.length === round + 1, `spawn ${round + 1}`)
    h.files.set(MARKER_PATH, '{}')
    await waitUntil(() => h.spawns.length === round + 2, `relaunch ${round + 1}`)
  }
  // Budget exhausted: the next marker is consumed but ignored.
  const last = h.spawns[h.spawns.length - 1]!
  h.files.set(MARKER_PATH, '{}')
  await waitUntil(() => !h.files.has(MARKER_PATH), 'marker consumed')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(h.spawns.length, MAX_RELAUNCHES_PER_WINDOW + 1)
  assert.equal(last.killedWith, null)
  assert.equal(
    h.prints.some((line) => line.includes('Not relaunching again')),
    true,
  )
  last.exit(0)
  assert.equal(await done, 0)
})

test('superviseClaude: a stale marker from a dead launcher is swept, never acted on', async () => {
  const h = loopHarness()
  h.files.set(MARKER_PATH, '{}')
  const done = h.run(BASE_ARGS)
  await waitUntil(() => h.spawns.length === 1, 'first spawn')
  assert.equal(h.files.has(MARKER_PATH), false)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(h.spawns.length, 1)
  assert.equal(h.spawns[0]!.killedWith, null)
  h.spawns[0]!.exit(0)
  assert.equal(await done, 0)
})

test('superviseClaude: no resolvable assistant id means plain unsupervised launch', async () => {
  const files = new Map<string, string>()
  const spawns: FakeChild[] = []
  const done = superviseClaude(BASE_ARGS, {
    platform: 'linux',
    env: {},
    home: POSIX_HOME,
    cwd: '/x',
    scriptDir: CLONE_SCRIPT_DIR,
    readFile: () => null,
    listDir: () => ['credentials-7.json', 'credentials-8.json'],
    spawnImpl: ((_file: string, args: readonly string[]) => {
      const child = new FakeChild(args)
      spawns.push(child)
      return child
    }) as never,
    writeErr: () => {},
    exists: (p: string) => files.has(p),
    writeFile: (p: string, content: string) => {
      files.set(p, content)
      return true
    },
    removeFile: (p: string) => files.delete(p),
    pollMs: 5,
    print: () => {},
    hasExpect: false,
  })
  await waitUntil(() => spawns.length === 1, 'plain spawn')
  assert.equal(files.size, 0)
  spawns[0]!.exit(3)
  assert.equal(await done, 3)
})

test('MARKER_POLL_MS default stays at 3 seconds', () => {
  assert.equal(MARKER_POLL_MS, 3000)
})

// -- decideSupervisorArming (singleton guard) --------------------------------

test('decideSupervisorArming: no existing supervisor arms', () => {
  assert.deepEqual(
    decideSupervisorArming({ existingRaw: null, ownPid: 100, pidAlive: () => true }),
    { arm: true },
  )
  assert.deepEqual(
    decideSupervisorArming({ existingRaw: '', ownPid: 100, pidAlive: () => true }),
    { arm: true },
  )
})

test('decideSupervisorArming: a live foreign supervisor refuses the second launch', () => {
  const existingRaw = supervisorFileBody(999, '2026-08-24T00:00:00.000Z')
  assert.deepEqual(
    decideSupervisorArming({
      existingRaw,
      ownPid: 100,
      pidAlive: (pid) => pid === 999,
    }),
    { arm: false, ownerPid: 999 },
  )
})

test('decideSupervisorArming: a dead pid is reclaimed as stale', () => {
  const existingRaw = supervisorFileBody(999, '2026-08-24T00:00:00.000Z')
  assert.deepEqual(
    decideSupervisorArming({ existingRaw, ownPid: 100, pidAlive: () => false }),
    { arm: true, reclaimedStale: true },
  )
})

test('decideSupervisorArming: our own pid is not a foreign owner', () => {
  const existingRaw = supervisorFileBody(100, '2026-08-24T00:00:00.000Z')
  assert.deepEqual(
    decideSupervisorArming({ existingRaw, ownPid: 100, pidAlive: () => true }),
    { arm: true, reclaimedStale: true },
  )
})

test('decideSupervisorArming: malformed or non-relaunch supervisor is reclaimed, never a lie', () => {
  assert.deepEqual(
    decideSupervisorArming({ existingRaw: 'not json', ownPid: 100, pidAlive: () => true }),
    { arm: true, reclaimedStale: true },
  )
  // A live pid but WITHOUT the relaunch capability is not a restart authority.
  const noCap = JSON.stringify({ pid: 999, capabilities: [] })
  assert.deepEqual(
    decideSupervisorArming({ existingRaw: noCap, ownPid: 100, pidAlive: () => true }),
    { arm: true, reclaimedStale: true },
  )
})

// -- decideRelaunchRecovery (relaunch-verify, never-leave-dead) ---------------

test('decideRelaunchRecovery: a resume attempt that dies fast non-zero retries fresh', () => {
  assert.deepEqual(
    decideRelaunchRecovery({
      isResumeAttempt: true,
      exitCode: 1,
      elapsedMs: 1200,
      freshTried: false,
      healthyMs: RELAUNCH_HEALTHY_MS,
    }),
    { action: 'retry-fresh' },
  )
})

test('decideRelaunchRecovery: a clean quit (code 0) of a resumed session is never hijacked', () => {
  assert.deepEqual(
    decideRelaunchRecovery({
      isResumeAttempt: true,
      exitCode: 0,
      elapsedMs: 1200,
      freshTried: false,
      healthyMs: RELAUNCH_HEALTHY_MS,
    }),
    { action: 'return' },
  )
})

test('decideRelaunchRecovery: a relaunch that survived the health window returns normally', () => {
  assert.deepEqual(
    decideRelaunchRecovery({
      isResumeAttempt: true,
      exitCode: 1,
      elapsedMs: RELAUNCH_HEALTHY_MS + 1,
      freshTried: false,
      healthyMs: RELAUNCH_HEALTHY_MS,
    }),
    { action: 'return' },
  )
})

test('decideRelaunchRecovery: a fresh CREATE (non-resume) never triggers a fresh retry', () => {
  assert.deepEqual(
    decideRelaunchRecovery({
      isResumeAttempt: false,
      exitCode: 3,
      elapsedMs: 5,
      freshTried: false,
      healthyMs: RELAUNCH_HEALTHY_MS,
    }),
    { action: 'return' },
  )
})

test('decideRelaunchRecovery: the fresh fallback is one-shot, it never loops', () => {
  assert.deepEqual(
    decideRelaunchRecovery({
      isResumeAttempt: true,
      exitCode: 1,
      elapsedMs: 5,
      freshTried: true,
      healthyMs: RELAUNCH_HEALTHY_MS,
    }),
    { action: 'return' },
  )
})

test('RELAUNCH_HEALTHY_MS matches the keepalive.sh resume-death window (25s)', () => {
  assert.equal(RELAUNCH_HEALTHY_MS, 25_000)
})

// -- superviseClaude: singleton guard (loop integration) ---------------------

test('superviseClaude: refuses to double-launch when a live supervisor already owns the agent', async () => {
  const files = new Map<string, string>()
  // A live foreign supervisor already holds this agent.
  files.set(SUPERVISOR_PATH, supervisorFileBody(4242, '2026-08-24T00:00:00.000Z'))
  const spawns: FakeChild[] = []
  const prints: string[] = []
  const code = await superviseClaude(BASE_ARGS, {
    platform: 'linux',
    env: {},
    home: POSIX_HOME,
    cwd: '/agents/athena',
    scriptDir: CLONE_SCRIPT_DIR,
    readFile: (p: string) =>
      p === '/agents/athena/.bgos-agent-id' ? '871' : files.get(p) ?? null,
    listDir: () => [],
    spawnImpl: ((_file: string, args: readonly string[]) => {
      const child = new FakeChild(args)
      spawns.push(child)
      return child
    }) as never,
    writeErr: () => {},
    exists: (p: string) => files.has(p),
    writeFile: (p: string, content: string) => {
      files.set(p, content)
      return true
    },
    removeFile: (p: string) => files.delete(p),
    pollMs: 5,
    now: () => 1_000,
    pidAlive: (pid: number) => pid === 4242,
    print: (line: string) => prints.push(line),
  })
  assert.equal(code, EXIT_ALREADY_SUPERVISED)
  // No second claude session was started.
  assert.equal(spawns.length, 0)
  // The live owner's supervisor.json was left intact, never clobbered.
  assert.equal(files.get(SUPERVISOR_PATH), supervisorFileBody(4242, '2026-08-24T00:00:00.000Z'))
  assert.equal(
    prints.some((line) => line.includes('already supervised') && line.includes('4242')),
    true,
  )
})

// -- superviseClaude: never-leave-dead (loop integration) --------------------

test('superviseClaude: a resumed relaunch that dies fast falls back to a fresh OWN session', async () => {
  const h = loopHarness()
  const done = h.run(BASE_ARGS)
  await waitUntil(() => h.spawns.length === 1, 'first spawn')
  // Marker relaunch: kills child 0, relaunches child 1 resuming the OWN session.
  // The session wrote its transcript, so the marker relaunch resumes it.
  h.files.set(`${POSIX_HOME}/.claude/projects/-agents-athena/${UUIDS[0]}.jsonl`, '{}')
  h.files.set(MARKER_PATH, '{}')
  await waitUntil(() => h.spawns.length === 2, 'relaunch after marker')
  assert.deepEqual(h.spawns[1]!.args, [...BASE_ARGS, '--resume', UUIDS[0]])
  // The resumed session dies fast NON-ZERO on its OWN (no new marker): a
  // rejected resume, the keepalive.sh failure. The supervisor must not leave the
  // agent dead; it retries a brand-new OWN session (a fresh pinned id), never
  // --continue.
  h.spawns[1]!.exit(1)
  await waitUntil(() => h.spawns.length === 3, 'fresh fallback relaunch')
  assert.deepEqual(h.spawns[2]!.args, [...BASE_ARGS, '--session-id', UUIDS[1]])
  assert.equal(h.spawns[2]!.args.includes('--continue'), false)
  assert.equal(h.files.get(SESSION_ID_PATH), UUIDS[1])
  assert.equal(
    h.prints.some((line) => line.toLowerCase().includes('fresh')),
    true,
  )
  // The fresh session comes up and runs normally; a normal exit is returned.
  h.spawns[2]!.exit(0)
  assert.equal(await done, 0)
  assert.equal(h.files.has(SUPERVISOR_PATH), false)
})

test('superviseClaude: a cross-process initial --resume that dies fast falls back to a fresh session', async () => {
  // A fresh hoai process (e.g. the external keepalive restarted it) whose pinned
  // session ALREADY exists on disk resumes it. If that resume is rejected
  // (locked/corrupt), the initial launch must still self-heal to a fresh session
  // rather than letting the external supervisor loop on the same rejection.
  const files = new Map<string, string>()
  files.set(SESSION_ID_PATH, UUIDS[0]!)
  // The transcript for the pinned id exists -> the initial launch uses --resume.
  const transcript = `${POSIX_HOME}/.claude/projects/-agents-athena/${UUIDS[0]}.jsonl`
  files.set(transcript, '{}')
  const spawns: FakeChild[] = []
  const done = superviseClaude(BASE_ARGS, {
    platform: 'linux',
    env: {},
    home: POSIX_HOME,
    cwd: '/agents/athena',
    scriptDir: CLONE_SCRIPT_DIR,
    readFile: (p: string) =>
      p === '/agents/athena/.bgos-agent-id' ? '871' : files.get(p) ?? null,
    listDir: () => [],
    spawnImpl: ((_file: string, args: readonly string[]) => {
      const child = new FakeChild(args)
      spawns.push(child)
      return child
    }) as never,
    writeErr: () => {},
    exists: (p: string) => files.has(p),
    writeFile: (p: string, content: string) => {
      files.set(p, content)
      return true
    },
    removeFile: (p: string) => files.delete(p),
    pollMs: 5,
    print: () => {},
    generateId: () => UUIDS[1]!,
    hasExpect: false,
  })
  await waitUntil(() => spawns.length === 1, 'initial resume spawn')
  // The initial launch RESUMED the existing pinned session.
  assert.deepEqual(spawns[0]!.args, [...BASE_ARGS, '--resume', UUIDS[0]])
  spawns[0]!.exit(1) // rejected resume, dies fast non-zero
  await waitUntil(() => spawns.length === 2, 'fresh fallback after rejected initial resume')
  assert.deepEqual(spawns[1]!.args, [...BASE_ARGS, '--session-id', UUIDS[1]])
  spawns[1]!.exit(0)
  assert.equal(await done, 0)
})

test('superviseClaude: if the deferred re-pin write fails, the fresh session still launches by its own id and the previous pin stands', async () => {
  const files = new Map<string, string>()
  const spawns: FakeChild[] = []
  let sessionWrites = 0
  const done = superviseClaude(BASE_ARGS, {
    platform: 'linux',
    env: {},
    home: POSIX_HOME,
    cwd: '/agents/athena',
    scriptDir: CLONE_SCRIPT_DIR,
    readFile: (p: string) =>
      p === '/agents/athena/.bgos-agent-id' ? '871' : files.get(p) ?? null,
    listDir: () => [],
    spawnImpl: ((_file: string, args: readonly string[]) => {
      const child = new FakeChild(args)
      spawns.push(child)
      return child
    }) as never,
    writeErr: () => {},
    exists: (p: string) => files.has(p),
    writeFile: (p: string, content: string) => {
      // The FIRST session-id pin succeeds; the fresh-fallback re-pin FAILS.
      if (p === SESSION_ID_PATH) {
        sessionWrites += 1
        if (sessionWrites > 1) return false
      }
      files.set(p, content)
      return true
    },
    removeFile: (p: string) => files.delete(p),
    pollMs: 5,
    print: () => {},
    generateId: () => UUIDS[sessionWrites]!,
    hasExpect: false,
    // Commit the deferred pin at once (see loopHarness); here the write FAILS.
    setTimer: ((fn: () => void) => {
      fn()
      return 0
    }) as never,
    clearTimer: () => {},
  })
  await waitUntil(() => spawns.length === 1, 'first spawn')
  // The session wrote its transcript, so the marker relaunch resumes it.
  files.set(`${POSIX_HOME}/.claude/projects/-agents-athena/${UUIDS[0]}.jsonl`, '{}')
  files.set(MARKER_PATH, '{}')
  await waitUntil(() => spawns.length === 2, 'marker relaunch')
  spawns[1]!.exit(1) // resumed relaunch dies fast non-zero -> fresh fallback
  await waitUntil(() => spawns.length === 3, 'fresh fallback')
  // 0.38.13: a failed pin write no longer changes what is LAUNCHED, only what
  // is RECORDED. The fresh session runs by its own new id (a fresh uuid cannot
  // collide), never --resume; and because the pin could not be written, the
  // previous pin stands, so the next hoai resumes the agent's real session.
  assert.deepEqual(spawns[2]!.args, [...BASE_ARGS, '--session-id', UUIDS[1]])
  assert.equal(spawns[2]!.args.includes('--resume'), false)
  assert.equal(files.get(SESSION_ID_PATH), UUIDS[0])
  spawns[2]!.exit(0)
  assert.equal(await done, 0)
})

// -- superviseClaude: GAP 2 gate auto-accept wiring --------------------------

test('superviseClaude: a clone launch with expect available spawns claude UNDER expect (auto-accept)', async () => {
  const files = new Map<string, string>()
  const captured: Array<{ file: string; args: string[] }> = []
  const children: FakeChild[] = []
  const done = superviseClaude(BASE_ARGS, {
    platform: 'linux',
    env: {},
    home: POSIX_HOME,
    cwd: '/agents/athena',
    scriptDir: CLONE_SCRIPT_DIR,
    readFile: (p: string) =>
      p === '/agents/athena/.bgos-agent-id' ? '871' : files.get(p) ?? null,
    listDir: () => [],
    spawnImpl: ((file: string, args: readonly string[]) => {
      captured.push({ file, args: [...args] })
      const child = new FakeChild(args)
      children.push(child)
      return child
    }) as never,
    writeErr: () => {},
    exists: (p: string) => files.has(p),
    writeFile: (p: string, content: string) => {
      files.set(p, content)
      return true
    },
    removeFile: (p: string) => files.delete(p),
    pollMs: 5,
    print: () => {},
    generateId: () => UUIDS[0]!,
    hasExpect: true,
  })
  await waitUntil(() => captured.length === 1, 'first spawn')
  // The gate is auto-accepted: claude runs UNDER expect, not spawned directly.
  assert.equal(captured[0]!.file, 'expect')
  assert.equal(captured[0]!.args[0], '-c')
  const script = captured[0]!.args[1]!
  assert.equal(script.includes('spawn claude'), true)
  // The identity-safe session args ride inside the expect-spawned command
  // (brace-quoted per arg).
  assert.equal(script.includes(`{--session-id} {${UUIDS[0]}}`), true)
  assert.equal(/confirm/.test(script), true)
  children[0]!.exit(0)
  assert.equal(await done, 0)
})

// -- Launch recipe (design 1.7: the per-machine watcher's relaunch input) ----

test('superviseClaude: writes the launch recipe when it arms and rewrites it on every relaunch; never a session id, never a token', async () => {
  const h = loopHarness()
  const done = h.run(BASE_ARGS)
  await waitUntil(() => h.spawns.length === 1, 'first spawn')
  const recipePath = `${STATE_DIR}/launch.json`
  const firstText = h.files.get(recipePath)
  assert.ok(firstText, 'launch.json written at arm time')
  const first = JSON.parse(firstText!)
  assert.equal(first.schemaVersion, 1)
  assert.equal(first.assistantId, '871')
  assert.equal(first.cwd, '/agents/athena')
  // The channel flags only: what a relaunch needs, and nothing identity-bound.
  assert.deepEqual(first.argv, BASE_ARGS)
  assert.equal(first.installMethod, 'clone')
  assert.equal(first.pluginRoot, '/home/kc/bgos-claude-plugin')
  assert.equal(first.launcher, 'hoai')
  assert.equal(first.pid, process.pid)
  assert.equal(typeof first.node, 'string')
  assert.equal(typeof first.startedAt, 'string')
  for (const banned of ['--session-id', '--resume', '--continue', UUIDS[0]!, 'pairingToken', 'apiKey']) {
    assert.equal(firstText!.includes(banned), false, `recipe must not contain ${banned}`)
  }
  // A marker relaunch (which resumes the pinned session) rewrites the recipe,
  // still without the session args it launched with.
  // The session wrote its transcript, so the marker relaunch resumes it.
  h.files.set(`${POSIX_HOME}/.claude/projects/-agents-athena/${UUIDS[0]}.jsonl`, '{}')
  h.files.set(MARKER_PATH, '{}')
  await waitUntil(() => h.spawns.length === 2, 'relaunch after marker')
  assert.deepEqual(h.spawns[1]!.args, [...BASE_ARGS, '--resume', UUIDS[0]])
  const secondText = h.files.get(recipePath)!
  const second = JSON.parse(secondText)
  assert.deepEqual(second.argv, BASE_ARGS)
  assert.equal(secondText.includes('--resume'), false)
  assert.equal(secondText.includes(UUIDS[0]!), false)
  h.spawns[1]!.exit(0)
  assert.equal(await done, 0)
  // The recipe outlives the session (existence-only for the watcher; the
  // supervisor.json is what says "live").
  assert.equal(h.files.has(recipePath), true)
  assert.equal(h.files.has(SUPERVISOR_PATH), false)
})

test('superviseClaude: a failed recipe write changes nothing about the launch', async () => {
  const files = new Map<string, string>()
  const spawns: FakeChild[] = []
  const done = superviseClaude(BASE_ARGS, {
    platform: 'linux',
    env: {},
    home: POSIX_HOME,
    cwd: '/agents/athena',
    scriptDir: CLONE_SCRIPT_DIR,
    readFile: (p: string) =>
      p === '/agents/athena/.bgos-agent-id' ? '871' : files.get(p) ?? null,
    listDir: () => [],
    spawnImpl: ((_file: string, args: readonly string[]) => {
      const child = new FakeChild(args)
      spawns.push(child)
      return child
    }) as never,
    writeErr: () => {},
    exists: (p: string) => files.has(p),
    writeFile: (p: string, content: string) => {
      if (p.endsWith('/launch.json')) return false
      files.set(p, content)
      return true
    },
    removeFile: (p: string) => files.delete(p),
    pollMs: 5,
    print: () => {},
    generateId: () => UUIDS[0]!,
    hasExpect: false,
  })
  await waitUntil(() => spawns.length === 1, 'first spawn')
  assert.equal(files.has(`${STATE_DIR}/launch.json`), false)
  assert.deepEqual(spawns[0]!.args, [...BASE_ARGS, '--session-id', UUIDS[0]])
  spawns[0]!.exit(0)
  assert.equal(await done, 0)
})

test('win32GateHelperArgs: the helper is powershell -File <bin>/win32-accept-dev-channels.ps1 with the console pid and a timeout', () => {
  assert.deepEqual(win32GateHelperArgs({ scriptDir: 'C:\\p\\bin', consolePid: 4321 }), [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'C:\\p\\bin\\win32-accept-dev-channels.ps1',
    '-ConsolePid',
    '4321',
    '-TimeoutSeconds',
    '120',
  ])
})

test('win32 gate helper source: only ever presses Enter after the gate marker is on screen, never blindly', () => {
  const src = readFileSync(new URL('../bin/win32-accept-dev-channels.ps1', import.meta.url), 'utf8')
  assert.match(src, /Loading development channels/)
  assert.match(src, /Contains\(\$Marker\)/)
  assert.match(src, /WriteConsoleInputW/)
  assert.ok(!src.includes('SendKeys'), 'no focus-dependent SendKeys')
  assert.equal(src.includes('\r'), false, 'LF only')
})
