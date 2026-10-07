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
import { test as nodeTest, type TestContext } from 'node:test'
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

/**
 * Every test here is bounded. node:test's default timeout is INFINITE, and a
 * test still awaiting a loop that never ended (a regression in the loop, a
 * FakeChild nobody exits) held `tsx --test` open, idle, for hours: the
 * t.after that stops the loop runs only once the test itself has ended. A
 * finite timeout ends the test, t.after then stops the loop, and the file
 * finishes, with or without --test-timeout.
 */
const TEST_TIMEOUT_MS = 20_000
function test(name: string, fn: (t: TestContext) => void | Promise<void>) {
  return nodeTest(name, { timeout: TEST_TIMEOUT_MS }, fn)
}

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

/**
 * The loop's result, or a NAMED failure once `ms` have passed, after which the
 * loop is stopped (so it ends instead of outliving the test).
 */
async function settled<T>(done: Promise<T>, stop: AbortController, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stop.abort()
      reject(new Error(`the supervise loop did not end within ${ms} ms`))
    }, ms)
  })
  try {
    return await Promise.race([done, late])
  } finally {
    clearTimeout(timer)
  }
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
  assert.equal(await settled(done, h.stop), 143)
  assert.equal(h.spawns.length, 2)
  assert.equal(h.spawns[1]!.killedWith, 'SIGTERM')
  assert.equal(h.files.has(SUPERVISOR_PATH), false, 'cleaned up on the way out')
})

// Review 3 F1: on Linux a reader proves this launcher is still the writer of
// supervisor.json on the boot clock, the clock ps measures etime with, so the
// arm and every keep-alive re-stamp carry it beside the wall clock startedAt.
test('review 3 F1: the arm and every keep-alive relaunch stamp supervisor.json with the boot clock, read through hoai\'s own reader', async (t) => {
  const BOOT = '4f3c2a10-8b7e-4d21-9a55-0c1e2f3a4b5c'
  const h = harness()
  t.after(() => h.stop.abort())
  h.files.set('/proc/sys/kernel/random/boot_id', `${BOOT}\n`)
  h.files.set('/proc/uptime', '25.00 40.00\n')
  const done = h.run()
  await until(() => h.spawns.length === 1, 'first launch')
  assert.deepEqual(JSON.parse(h.files.get(SUPERVISOR_PATH)!).boot, { id: BOOT, uptimeMs: 25_000 })
  h.files.set('/proc/uptime', '3625.50 40.00\n')
  h.clock.t += 60_000
  h.spawns[0]!.exit(0)
  await until(() => h.spawns.length === 2, 'keep-alive relaunch')
  assert.deepEqual(JSON.parse(h.files.get(SUPERVISOR_PATH)!).boot, { id: BOOT, uptimeMs: 3_625_500 }, 're-stamped on the boot clock too')
  h.stop.abort()
  assert.equal(await settled(done, h.stop), 143)
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
  await settled(done, h.stop)
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
  await settled(done, h.stop)
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
  await settled(done, h.stop)
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
  await settled(done, h.stop)
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
  assert.equal(await settled(done, h.stop), 0)
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
  await settled(done, h.stop)
})

test('daemon F6: a pin the daemon rewrote while claude ran is what the marker relaunch AND the keep-alive relaunch resume, never the id hoai read at launch', async (t) => {
  const LIVE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const h = harness()
  t.after(() => h.stop.abort())
  const done = h.run()
  await until(() => h.spawns.length === 1, 'launch 1')
  assert.deepEqual(h.spawns[0]!.args, [...BASE, '--resume', PINNED])
  // The daemon found the live session is another resumable one and repinned to it (design 13).
  h.files.set(SESSION_ID_PATH, `${LIVE}\n`)
  h.files.set(`${HOME}/.claude/projects/-agents-athena/${LIVE}.jsonl`, '{}')
  h.files.set(MARKER_PATH, '{}')
  await until(() => h.spawns.length === 2, 'marker relaunch')
  assert.deepEqual(h.spawns[1]!.args, [...BASE, '--resume', LIVE], 'the marker relaunch reads the pin again')
  // Junk on disk is no pin: the last good one stands.
  h.files.set(SESSION_ID_PATH, 'not-a-session')
  h.clock.t += 60_000
  h.spawns[1]!.exit(0)
  await until(() => h.spawns.length === 3, 'keep-alive relaunch')
  assert.deepEqual(h.spawns[2]!.args, [...BASE, '--resume', LIVE], 'junk keeps the pin it had')
  // And a later rewrite reaches the keep-alive relaunch too.
  h.files.set(SESSION_ID_PATH, PINNED)
  h.clock.t += 60_000
  h.spawns[2]!.exit(0)
  await until(() => h.spawns.length === 4, 'second keep-alive relaunch')
  assert.deepEqual(h.spawns[3]!.args, [...BASE, '--resume', PINNED], 'the keep-alive relaunch reads the pin again')
  h.stop.abort()
  await settled(done, h.stop)
})

test('daemon F6: a `hoai --new` whose repin could not be written never takes the abandoned pin back on a relaunch; a pin the daemon writes later is taken', async (t) => {
  const LIVE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const h = harness()
  t.after(() => h.stop.abort())
  let pinWritable = false
  const done = h.run({
    freshSession: true,
    writeFile: (p: string, c: string) => {
      if (p === SESSION_ID_PATH && !pinWritable) return false
      h.files.set(p, c)
      return true
    },
  })
  await until(() => h.spawns.length === 1, 'launch 1')
  assert.deepEqual(h.spawns[0]!.args, BASE, 'an unpinned fresh session, exactly as before')
  h.files.set(MARKER_PATH, '{}')
  await until(() => h.spawns.length === 2, 'marker relaunch')
  assert.deepEqual(h.spawns[1]!.args, BASE, 'never the session the user asked to leave')
  // The daemon pins the live session it found.
  pinWritable = true
  h.files.set(SESSION_ID_PATH, LIVE)
  h.files.set(`${HOME}/.claude/projects/-agents-athena/${LIVE}.jsonl`, '{}')
  h.clock.t += 60_000
  h.spawns[1]!.exit(0)
  await until(() => h.spawns.length === 3, 'keep-alive relaunch')
  assert.deepEqual(h.spawns[2]!.args, [...BASE, '--resume', LIVE])
  h.stop.abort()
  await settled(done, h.stop)
})

test('the file\'s own bound: a loop that never ends is stopped and named within the bound, never awaited for ever', async (t) => {
  const h = harness()
  t.after(() => h.stop.abort())
  const done = h.run()
  await until(() => h.spawns.length === 1, 'launch 1')
  // Nobody exits this child: exactly the wait that hung a run for hours.
  await assert.rejects(settled(done, h.stop, 200), /did not end within 200 ms/)
  assert.equal(h.stop.signal.aborted, true, 'the bound stopped the loop')
  assert.equal(await done, 143, 'and the stopped loop really ended')
})

test('the restart-marker poller never holds the process open by itself (claude\'s own handle does while it runs), so a loop a failed test left behind cannot hang the run', async (t) => {
  const realSetInterval = globalThis.setInterval
  const made: Array<ReturnType<typeof setInterval>> = []
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const timer = realSetInterval(...args)
    made.push(timer)
    return timer
  }) as typeof setInterval
  t.after(() => {
    globalThis.setInterval = realSetInterval
  })
  const h = harness()
  t.after(() => h.stop.abort())
  const done = h.run()
  await until(() => h.spawns.length === 1, 'launch 1')
  assert.ok(made.length >= 1, 'the marker poller runs')
  assert.deepEqual(made.map((timer) => timer.hasRef()), made.map(() => false), 'unref\'d: a FakeChild has no handle, and neither has a leaked loop')
  h.stop.abort()
  assert.equal(await settled(done, h.stop), 143)
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
    assert.equal(await settled(done, stop), 143)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
