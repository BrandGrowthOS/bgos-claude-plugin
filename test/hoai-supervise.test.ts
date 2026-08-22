/**
 * Launcher-loop supervisor tests (one-click updates): pure decision pieces
 * plus the full superviseClaude loop with fake spawn and fake fs. The loop
 * is the restart authority for interactive sessions (Windows included), so
 * this suite pins: normal exits stay exactly as before (no relaunch), a
 * restart marker SIGTERMs the child and relaunches with --continue, marker
 * contents are never read, the 3-per-hour budget, the stale-marker sweep at
 * start, and supervisor.json lifecycle.
 *
 * Run: npm test (routed to tsx --test) or npx tsx --test test/hoai-supervise.test.ts
 */

import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MARKER_POLL_MS,
  MAX_RELAUNCHES_PER_WINDOW,
  RELAUNCH_WINDOW_MS,
  RESTART_MARKER_FILE_NAME,
  SUPERVISOR_FILE_NAME,
  decideMarkerRelaunch,
  relaunchClaudeArgs,
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

test('relaunchClaudeArgs: clone install relaunches with the clone spec plus --continue', () => {
  const args = relaunchClaudeArgs({ scriptDir: CLONE_SCRIPT_DIR, env: {}, home: POSIX_HOME })
  assert.deepEqual(args, [
    '--dangerously-skip-permissions',
    '--dangerously-load-development-channels',
    'server:bgos',
    '--continue',
  ])
})

test('relaunchClaudeArgs: marketplace install re-detects and keeps the plugin spec', () => {
  const args = relaunchClaudeArgs({
    scriptDir: MARKETPLACE_SCRIPT_DIR,
    env: {},
    home: 'C:\\Users\\x',
  })
  assert.deepEqual(args, [
    '--dangerously-skip-permissions',
    '--dangerously-load-development-channels',
    'plugin:hoai@hoai',
    '--continue',
  ])
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

test('superviseClaude: a marker kills the child and relaunches with --continue', async () => {
  const h = loopHarness()
  const done = h.run(BASE_ARGS)
  await waitUntil(() => h.spawns.length === 1, 'first spawn')
  // Marker contents are hostile on purpose: only existence may matter.
  h.files.set(MARKER_PATH, JSON.stringify({ exec: 'rm -rf /' }))
  await waitUntil(() => h.spawns.length === 2, 'relaunch after marker')
  assert.equal(h.spawns[0]!.killedWith, 'SIGTERM')
  assert.equal(h.files.has(MARKER_PATH), false)
  assert.deepEqual(h.spawns[1]!.args, [...BASE_ARGS, '--continue'])
  h.spawns[1]!.exit(0)
  assert.equal(await done, 0)
  assert.equal(h.files.has(SUPERVISOR_PATH), false)
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
  })
  await waitUntil(() => spawns.length === 1, 'plain spawn')
  assert.equal(files.size, 0)
  spawns[0]!.exit(3)
  assert.equal(await done, 3)
})

test('MARKER_POLL_MS default stays at 3 seconds', () => {
  assert.equal(MARKER_POLL_MS, 3000)
})
