/**
 * hoai --keep-alive (design section 4, the Windows per agent task).
 *
 * Windows has no launchd or systemd to bring an agent back, so the logon task
 * runs `hoai-core.mjs --keep-alive` and hoai itself is the loop: when claude
 * exits on its own (not a marker relaunch) it relaunches it RESUMING the pinned
 * session (finding 7: the identity-safe session args, never --continue) after a
 * backoff of 5 s, 10 s, 20 s, 40 s, then 60 s, reset once a session has stayed
 * up for 10 minutes; three or more exits inside 5 minutes are a crash loop and
 * are recorded in launch-status, so a broken agent is visible instead of
 * silently churning (fact 5 is the same failure, in the watcher). The one-shot
 * fresh fallback for a fast-dying resume still applies, and supervisor.json
 * stays valid across the relaunches so the daemon keeps seeing a live restart
 * authority.
 *
 * Pure decisions are table tested; the loop runs on fake spawn, fake fs, an
 * injected clock and sleep, and an AbortSignal that stops it.
 *
 * Run: npx tsx --test test/hoai-core.keepalive.test.ts
 */

import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CRASH_LOOP_EXITS,
  CRASH_LOOP_WINDOW_MS,
  EXIT_UNATTENDED_NEEDS_PERSON,
  KEEP_ALIVE_HEALTHY_RESET_MS,
  LAUNCH_STATUS_FILE_NAME,
  RESTART_MARKER_FILE_NAME,
  SESSION_ID_FILE_NAME,
  SUPERVISOR_FILE_NAME,
  USAGE,
  classifyRunFlag,
  decideCrashLoop,
  decideKeepAliveBackoff,
  main,
  resolveHoaiAction,
  superviseClaude,
} from '../bin/hoai-core.mjs'

const HOME = '/home/kc'
const CWD = '/agents/athena'
const SCRIPT_DIR = '/home/kc/bgos-claude-plugin/bin'
const STATE_DIR = `${HOME}/.bgos-agent/871`
const SUPERVISOR_PATH = `${STATE_DIR}/${SUPERVISOR_FILE_NAME}`
const SESSION_ID_PATH = `${STATE_DIR}/${SESSION_ID_FILE_NAME}`
const MARKER_PATH = `${STATE_DIR}/${RESTART_MARKER_FILE_NAME}`
const STATUS_PATH = `${STATE_DIR}/${LAUNCH_STATUS_FILE_NAME}`
const PINNED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FRESH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TRANSCRIPT = `${HOME}/.claude/projects/-agents-athena/${PINNED}.jsonl`
const BASE = ['--dangerously-skip-permissions', '--dangerously-load-development-channels', 'server:bgos']

// -- the pure decisions -------------------------------------------------------

test('decideKeepAliveBackoff: 5 s, 10 s, 20 s, 40 s, then 60 s, and a 10 minute healthy run starts again at 5 s', () => {
  const quick = 1_000
  const table: Array<[number, number, number, number]> = [
    // streak so far, how long the session ran, delay, streak after
    [0, quick, 5_000, 1],
    [1, quick, 10_000, 2],
    [2, quick, 20_000, 3],
    [3, quick, 40_000, 4],
    [4, quick, 60_000, 5],
    [5, quick, 60_000, 6],
    [40, quick, 60_000, 41],
    [1e9, quick, 60_000, 1e9 + 1],
    // healthy for 10 minutes: the streak is over, back to the first step
    [4, KEEP_ALIVE_HEALTHY_RESET_MS, 5_000, 1],
    [9, KEEP_ALIVE_HEALTHY_RESET_MS + 1, 5_000, 1],
    // a second short of healthy is still the streak
    [4, KEEP_ALIVE_HEALTHY_RESET_MS - 1_000, 60_000, 5],
    // junk never throws and never waits less than the first step
    [Number.NaN, Number.NaN, 5_000, 1],
    [-3, quick, 5_000, 1],
  ]
  for (const [streak, ranMs, delayMs, next] of table) {
    assert.deepEqual(decideKeepAliveBackoff({ streak, ranMs }), { delayMs, streak: next }, `streak ${streak}, ran ${ranMs}`)
  }
  assert.equal(KEEP_ALIVE_HEALTHY_RESET_MS, 10 * 60 * 1000)
})

test('decideCrashLoop: three or more exits inside five minutes is a crash loop; older exits fall out of the window', () => {
  const now = 50_000_000
  assert.equal(CRASH_LOOP_EXITS, 3)
  assert.equal(CRASH_LOOP_WINDOW_MS, 5 * 60 * 1000)
  const table: Array<[number[], boolean, number]> = [
    [[now], false, 1],
    [[now - 60_000, now], false, 2],
    [[now - 60_000, now - 30_000, now], true, 3],
    [[now - 240_000, now - 120_000, now - 1, now], true, 4],
    // exactly five minutes ago is outside the window
    [[now - CRASH_LOOP_WINDOW_MS, now - 30_000, now], false, 2],
    [[now - CRASH_LOOP_WINDOW_MS + 1, now - 30_000, now], true, 3],
    // junk is dropped, never counted
    [[Number.NaN, Infinity, now - 1, now], false, 2],
  ]
  for (const [exitsAt, crashLoop, count] of table) {
    const decision = decideCrashLoop({ exitsAt, now })
    assert.equal(decision.crashLoop, crashLoop, JSON.stringify(exitsAt))
    assert.equal(decision.recent.length, count, JSON.stringify(exitsAt))
  }
})

test('--keep-alive is a run flag: routes to run, combines with --force, and leaves every other route exactly as it was', () => {
  assert.equal(classifyRunFlag('--keep-alive'), 'keep-alive')
  const keep = { action: 'run', rest: [], fresh: false, force: false, keepAlive: true }
  assert.deepEqual(resolveHoaiAction(['--keep-alive']), keep)
  assert.deepEqual(resolveHoaiAction(['run', '--keep-alive']), keep)
  assert.deepEqual(resolveHoaiAction(['--keep-alive', '--force']), { ...keep, force: true })
  // Absent unless given, so the existing route shapes are untouched.
  assert.deepEqual(resolveHoaiAction([]), { action: 'run', rest: [], fresh: false, force: false })
  assert.deepEqual(resolveHoaiAction(['--keep-alive-please']).action, 'help')
  assert.match(USAGE, /hoai --keep-alive/)
})

// -- the loop -----------------------------------------------------------------

class FakeChild extends EventEmitter {
  args: string[]
  killedWith: string | null = null
  constructor(args: readonly string[]) {
    super()
    this.args = [...args]
  }
  kill(signal?: string) {
    this.killedWith = signal ?? 'SIGTERM'
    setTimeout(() => this.emit('exit', null, 'SIGTERM'), 1)
    return true
  }
  exit(code: number) {
    this.emit('exit', code, null)
  }
}

function harness({ transcript = true, pinned = true }: { transcript?: boolean; pinned?: boolean } = {}) {
  const files = new Map<string, string>()
  if (pinned) files.set(SESSION_ID_PATH, PINNED)
  if (transcript) files.set(TRANSCRIPT, '{}')
  const spawns: FakeChild[] = []
  const sleeps: number[] = []
  const prints: string[] = []
  const clock = { t: 1_000_000_000 }
  const stop = new AbortController()
  const ids = [FRESH]
  const run = (extra: Record<string, unknown> = {}) =>
    superviseClaude(BASE, {
      platform: 'linux',
      env: {},
      home: HOME,
      cwd: CWD,
      scriptDir: SCRIPT_DIR,
      readFile: (p: string) => (p === `${CWD}/.bgos-agent-id` ? '871' : files.get(p) ?? null),
      listDir: () => [],
      spawnImpl: ((_file: string, args: readonly string[]) => {
        const child = new FakeChild(args)
        spawns.push(child)
        return child
      }) as never,
      writeErr: () => {},
      exists: (p: string) => files.has(p),
      writeFile: (p: string, c: string) => {
        files.set(p, c)
        return true
      },
      removeFile: (p: string) => files.delete(p),
      pollMs: 5,
      print: (l: string) => prints.push(l),
      now: () => clock.t,
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
      listProcesses: () => [],
      hasExpect: false,
      // The deferred fresh-retry pin never commits in these runs: a fresh session that
      // dies inside the health window must leave the pin on the real session.
      setTimer: (() => 0) as never,
      clearTimer: () => {},
      generateId: () => ids.shift() ?? FRESH,
      keepAlive: true,
      signal: stop.signal,
      ...extra,
    })
  return { files, spawns, sleeps, prints, clock, stop, run }
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

test('keep-alive: an exit on its own relaunches after 5 s RESUMING the pinned session, and supervisor.json stays valid across it', async (t) => {
  const h = harness()
  t.after(() => h.stop.abort())
  const done = h.run()
  await until(() => h.spawns.length === 1, 'first launch')
  assert.deepEqual(h.spawns[0]!.args, [...BASE, '--resume', PINNED])
  // Something removed the authority file while claude ran (a stale-file sweep, an operator):
  // the relaunch must put it back, or the daemon stops seeing a live restart authority.
  h.files.delete(SUPERVISOR_PATH)
  h.clock.t += 60_000
  h.spawns[0]!.exit(0)
  await until(() => h.spawns.length === 2, 'keep-alive relaunch')
  assert.deepEqual(h.sleeps, [5_000])
  assert.deepEqual(h.spawns[1]!.args, [...BASE, '--resume', PINNED], 'the same session, by id, never --continue')
  assert.equal(h.spawns[1]!.args.includes('--continue'), false)
  const sup = JSON.parse(h.files.get(SUPERVISOR_PATH) ?? 'null')
  assert.equal(sup?.pid, process.pid)
  assert.deepEqual(sup?.capabilities, ['relaunch'])
  assert.equal(h.files.get(SESSION_ID_PATH), PINNED, 'the pin is untouched')
  // Stopping the launcher stops the agent and does NOT relaunch it.
  h.stop.abort()
  assert.equal(await done, 143)
  assert.equal(h.spawns.length, 2)
  assert.equal(h.spawns[1]!.killedWith, 'SIGTERM')
  assert.equal(h.files.has(SUPERVISOR_PATH), false, 'cleaned up on the way out')
})

test('keep-alive: quick exits back off 5, 10, 20, 40, 60, 60 s, and a session that stayed up 10 minutes starts again at 5 s', async (t) => {
  const h = harness()
  t.after(() => h.stop.abort())
  const done = h.run()
  for (let lap = 1; lap <= 6; lap++) {
    await until(() => h.spawns.length === lap, `launch ${lap}`)
    h.clock.t += 2_000
    h.spawns[lap - 1]!.exit(0)
  }
  await until(() => h.spawns.length === 7, 'launch 7')
  assert.deepEqual(h.sleeps, [5_000, 10_000, 20_000, 40_000, 60_000, 60_000])
  h.clock.t += KEEP_ALIVE_HEALTHY_RESET_MS
  h.spawns[6]!.exit(0)
  await until(() => h.spawns.length === 8, 'launch 8')
  assert.equal(h.sleeps.at(-1), 5_000, 'the streak ended with the healthy session')
  h.stop.abort()
  await done
})

test('keep-alive: three exits inside five minutes are recorded in launch-status as a crash loop', async (t) => {
  const h = harness()
  t.after(() => h.stop.abort())
  const done = h.run()
  await until(() => h.spawns.length === 1, 'launch 1')
  h.clock.t += 30_000
  h.spawns[0]!.exit(0)
  await until(() => h.spawns.length === 2, 'launch 2')
  assert.match(h.files.get(STATUS_PATH) ?? '', /outcome=keep-alive-relaunch exit=0 ran=30s delay=5s/)
  assert.doesNotMatch(h.files.get(STATUS_PATH) ?? '', /crash-loop/)
  h.clock.t += 30_000
  h.spawns[1]!.exit(3)
  await until(() => h.spawns.length === 3, 'launch 3')
  h.clock.t += 30_000
  h.spawns[2]!.exit(3)
  await until(() => h.spawns.length === 4, 'launch 4')
  const status = h.files.get(STATUS_PATH) ?? ''
  assert.match(status, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} outcome=crash-loop exits=3 window=300s exit=3 delay=20s\n$/, status)
  assert.ok(h.prints.some((l) => /crash loop/i.test(l)), h.prints.join('\n'))
  h.stop.abort()
  await done
})

test('keep-alive: the one-shot fresh fallback for a fast-dying resume still applies, then the backoff, and the pin stays on the real session', async (t) => {
  const h = harness()
  t.after(() => h.stop.abort())
  const done = h.run()
  await until(() => h.spawns.length === 1, 'launch 1')
  h.clock.t += 1_000
  h.spawns[0]!.exit(1) // a rejected resume
  await until(() => h.spawns.length === 2, 'fresh retry')
  assert.deepEqual(h.sleeps, [], 'the fresh retry is immediate, exactly as without --keep-alive')
  assert.deepEqual(h.spawns[1]!.args, [...BASE, '--session-id', FRESH])
  h.clock.t += 1_000
  h.spawns[1]!.exit(1) // and the fresh one dies fast too: an environment fault
  await until(() => h.spawns.length === 3, 'keep-alive relaunch')
  assert.deepEqual(h.sleeps, [5_000])
  assert.deepEqual(h.spawns[2]!.args, [...BASE, '--resume', PINNED], 'back to the agent\'s real session')
  assert.equal(h.files.get(SESSION_ID_PATH), PINNED)
  h.stop.abort()
  await done
})

test('keep-alive: a session that stayed up past the health window earns the fresh fallback again, so a later rejected resume is retried at once', async (t) => {
  const h = harness()
  t.after(() => h.stop.abort())
  const done = h.run()
  await until(() => h.spawns.length === 1, 'launch 1')
  h.clock.t += 1_000
  h.spawns[0]!.exit(1) // rejected resume: the one-shot fresh retry is spent here
  await until(() => h.spawns.length === 2, 'fresh retry')
  h.clock.t += 60_000 // the fresh session is healthy for a minute, then exits
  h.spawns[1]!.exit(0)
  await until(() => h.spawns.length === 3, 'keep-alive relaunch')
  assert.deepEqual(h.sleeps, [5_000])
  h.clock.t += 1_000
  h.spawns[2]!.exit(1) // the resume is rejected again, days of uptime later
  await until(() => h.spawns.length === 4, 'second fresh retry')
  assert.deepEqual(h.sleeps, [5_000], 'retried at once, not left to the backoff')
  assert.ok(h.spawns[3]!.args.includes('--session-id'), h.spawns[3]!.args.join(' '))
  h.stop.abort()
  await done
})

test('keep-alive: a stop request during the backoff wait ends the loop there, and nothing is relaunched', async (t) => {
  const h = harness()
  t.after(() => h.stop.abort())
  const done = h.run({
    sleep: async (ms: number) => {
      h.sleeps.push(ms)
      h.stop.abort() // the logon task ends while hoai waits to relaunch
    },
  })
  await until(() => h.spawns.length === 1, 'launch 1')
  h.clock.t += 60_000
  h.spawns[0]!.exit(0)
  assert.equal(await done, 0)
  assert.deepEqual(h.sleeps, [5_000])
  assert.equal(h.spawns.length, 1, 'stopped while waiting: no relaunch')
  assert.equal(h.files.has(SUPERVISOR_PATH), false)
})

test('keep-alive: a restart marker still relaunches at once (no backoff), exactly as without the flag', async (t) => {
  const h = harness()
  t.after(() => h.stop.abort())
  const done = h.run()
  await until(() => h.spawns.length === 1, 'launch 1')
  h.files.set(MARKER_PATH, '{}')
  await until(() => h.spawns.length === 2, 'marker relaunch')
  assert.deepEqual(h.sleeps, [])
  assert.equal(h.spawns[0]!.killedWith, 'SIGTERM')
  assert.deepEqual(h.spawns[1]!.args, [...BASE, '--resume', PINNED])
  h.stop.abort()
  await done
})

test('keep-alive: a launch with no identity at all is REFUSED by name, because every relaunch would be a fresh unpinned session (finding 7)', async () => {
  const prints: string[] = []
  let spawned = 0
  const code = await superviseClaude(BASE, {
    platform: 'linux',
    env: {},
    home: HOME,
    cwd: '/agents/nobody',
    scriptDir: SCRIPT_DIR,
    readFile: () => null,
    listDir: () => [],
    // A child that exits at once, so a launch that should not have happened is
    // a clean failure of this test, never a hang.
    spawnImpl: (() => {
      spawned += 1
      const child = new FakeChild([])
      setImmediate(() => child.exit(0))
      return child
    }) as never,
    print: (l: string) => prints.push(l),
    writeErr: () => {},
    listProcesses: () => [],
    hasExpect: false,
    keepAlive: true,
    signal: AbortSignal.abort(),
  })
  assert.equal(code, EXIT_UNATTENDED_NEEDS_PERSON)
  assert.equal(spawned, 0)
  assert.ok(prints.some((l) => /identity-unknown/.test(l)), prints.join('\n'))
})

test('main(): --keep-alive reaches the loop (an exit is relaunched), and the stop signal ends it', async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'hoai-ka-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'hoai-ka-agent-'))
  writeFileSync(join(cwd, '.bgos-agent-id'), '871\n')
  const stop = new AbortController()
  t.after(() => stop.abort())
  const spawns: FakeChild[] = []
  const sleeps: number[] = []
  try {
    const done = main(['--keep-alive'], {
      platform: 'linux',
      env: {},
      home,
      cwd,
      scriptDir: SCRIPT_DIR,
      listProcesses: () => [],
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
      signal: stop.signal,
      print: () => {},
      spawnImpl: ((_f: string, args: readonly string[]) => {
        const child = new FakeChild(args)
        spawns.push(child)
        return child
      }) as never,
    } as never)
    await until(() => spawns.length === 1, 'launch 1')
    spawns[0]!.exit(0)
    await until(() => spawns.length === 2, 'relaunch')
    assert.deepEqual(sleeps, [5_000])
    stop.abort()
    assert.equal(await done, 143)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
