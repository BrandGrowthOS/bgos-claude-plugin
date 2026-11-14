/**
 * hoai's half of the way back for a staged build that dies at import (Data's review of #291, follow up 1; board row
 * 5a455021). The idle updater's restart relaunches claude onto the new build; its daemon throws at import, so the
 * channel never sends a heartbeat and the record still says `requested`. hoai's channel heartbeat check, 3 min after
 * the launch, is the one supervisor cycle that sees it: it asks the idle update's way back
 * (bin/hoai-core.mjs idleRollbackNeverArrived, lib/idle-update.mjs rollBackNeverArrived) BEFORE its own one relaunch,
 * so that relaunch boots the old build. No new restart path: the relaunch is the one hoai already makes for a launch
 * with no heartbeat, on the same budget.
 *
 * The harness is test/hoai-core.gate-attach.test.ts's: every effect is a fake, claude, the files and the clock.
 *
 * Run: npx tsx --test test/hoai-core.idle-never-arrived.test.ts
 */

import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as core from '../bin/hoai-core.mjs'

const { FOLDER_PIN_FILE, LAUNCH_STATUS_FILE_NAME, superviseClaude } = core

const HOME = 'C:\\Users\\mark'
const CWD = 'C:\\agents\\888'
const SCRIPT_DIR = 'C:\\Users\\mark\\.claude\\plugins\\cache\\hoai\\hoai\\0.69.6\\bin'
const STATE_DIR = `${HOME}\\.bgos-agent\\888`
const STATUS_PATH = `${STATE_DIR}\\${LAUNCH_STATUS_FILE_NAME}`
const BEACON_PATH = `${HOME}\\.bgos-plugin-state\\888\\channel-beacon.json`
const SUPERVISED = { HOAI_SUPERVISED: '1', HOAI_SUPERVISED_ASSISTANT_ID: '888' }
const BASE_ARGS = ['--dangerously-skip-permissions', '--dangerously-load-development-channels', 'plugin:hoai@hoai']
const PIN = '88888888-8888-4888-8888-888888888888'
const THREE_MIN = 3 * 60_000
const T0 = Date.UTC(2026, 10, 13, 9, 0, 0)

class FakeClaude extends EventEmitter {
  pid: number
  args: string[]
  killed = false
  constructor(pid: number, args: readonly string[]) {
    super()
    this.pid = pid
    this.args = [...args]
  }
  kill() {
    this.killed = true
    setImmediate(() => this.emit('exit', null, 'SIGTERM'))
    return true
  }
  exit(code: number) {
    this.emit('exit', code, null)
  }
}

class FakeHelper extends EventEmitter {
  pid: number
  constructor(pid: number) {
    super()
    this.pid = pid
  }
}

interface FakeTimer {
  fn: () => void
  ms: number
  at: number
  cleared: boolean
  fired: boolean
}

function harness({ env = SUPERVISED as Record<string, string>, keepAlive = true, idleRollback = undefined as any } = {}) {
  const files = new Map<string, string>()
  const claudes: FakeClaude[] = []
  const helpers: FakeHelper[] = []
  const prints: string[] = []
  const timers: FakeTimer[] = []
  const clock = { now: T0 }
  const stop = new AbortController()
  let nextPid = 25184
  const done = superviseClaude(BASE_ARGS, {
    platform: 'win32',
    env,
    home: HOME,
    cwd: CWD,
    scriptDir: SCRIPT_DIR,
    readFile: (p: string) => (p === `${CWD}\\${FOLDER_PIN_FILE}` ? '888' : files.get(p) ?? null),
    listDir: () => [],
    spawnImpl: ((_file: string, args: readonly string[]) => {
      const child = new FakeClaude(nextPid, args)
      nextPid += 4
      claudes.push(child)
      return child
    }) as never,
    spawnGateHelper: () => {
      const helper = new FakeHelper(30000 + helpers.length)
      helpers.push(helper)
      return helper
    },
    writeErr: () => {},
    exists: (p: string) => files.has(p),
    writeFile: (p: string, content: string) => {
      files.set(p, content)
      return true
    },
    removeFile: (p: string) => files.delete(p),
    print: (line: string) => prints.push(line),
    now: () => clock.now,
    setTimer: ((fn: () => void, ms: number) => {
      const timer: FakeTimer = { fn, ms, at: clock.now, cleared: false, fired: false }
      timers.push(timer)
      return timer
    }) as never,
    clearTimer: ((timer: FakeTimer | null) => {
      if (timer) timer.cleared = true
    }) as never,
    sleep: async () => {},
    pollMs: 5,
    keepAlive,
    idleRollback,
    signal: stop.signal,
    listProcesses: () => [],
    pidProcess: () => null,
    pidAlive: () => false,
    generateId: () => PIN,
  } as never)
  /** The armed, not yet fired 3 minute check (the latest launch's), or undefined. */
  const heartbeatTimer = () => timers.filter((t) => t.ms === THREE_MIN && !t.cleared && !t.fired).at(-1)
  /** Moves the clock to that check's moment and runs it, as a real timer would. */
  const fireHeartbeatCheck = () => {
    const timer = heartbeatTimer()
    assert.ok(timer, 'a 3 minute channel heartbeat check is armed for this launch')
    clock.now = timer.at + timer.ms
    timer.fired = true
    timer.fn()
  }
  const beacon = (beaconAt: number, pid: number) => files.set(BEACON_PATH, `${JSON.stringify({ beaconAt, pid }, null, 2)}\n`)
  const abort = () => stop.abort()
  const end = async () => {
    stop.abort()
    await done
  }
  return { files, claudes, helpers, prints, timers, clock, done, heartbeatTimer, fireHeartbeatCheck, beacon, abort, end }
}

async function waitUntil(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

/** Lets every queued callback run, so "nothing happened" is a measured answer. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 3))
}

const launched = (h: ReturnType<typeof harness>, n: number) =>
  waitUntil(() => h.claudes.length === n && h.helpers.length === n, `launch ${n} (claude and its gate helper)`)


const ROLLED_BACK = { outcome: 'rolled_back', reason: 'no_daemon', record: { target: '0.81.0', from: '0.80.0' } }

/** A fake way back that records when it was asked, and answers only when let go. */
function wayBack(answer: () => Promise<any> = async () => ROLLED_BACK) {
  const asks: any[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const fn = async (input: any) => {
    asks.push(input)
    await gate
    return answer()
  }
  return { fn, asks, release }
}

test('no channel heartbeat 3 minutes after a launch: the way back is asked first, and only then the one relaunch', async () => {
  const w = wayBack()
  const h = harness({ idleRollback: w.fn })
  await launched(h, 1)
  h.helpers[0]!.emit('exit', 0, null)
  h.fireHeartbeatCheck()
  await waitUntil(() => w.asks.length === 1, 'the way back is asked')
  assert.deepEqual(w.asks[0], { assistantId: '888', stateDir: STATE_DIR, home: HOME, env: SUPERVISED, cwd: CWD, launchedAtMs: T0, now: T0 + THREE_MIN })
  await settle()
  assert.equal(h.claudes[0]!.killed, false, 'claude is not ended while the install is being moved')
  assert.equal(h.claudes.length, 1)
  w.release()
  await launched(h, 2)
  assert.equal(h.claudes[0]!.killed, true)
  assert.deepEqual(h.claudes[1]!.args, [...BASE_ARGS, '--session-id', PIN], 'the same relaunch as before: its own pinned session')
  assert.match(h.files.get(STATUS_PATH) ?? '', /outcome=health-relaunch reason=no-channel-heartbeat/)
  assert.equal(h.prints.filter((l) => l.includes('never reported in') && l.includes('back on 0.80.0') && l.includes('0.81.0 is held')).length, 1, h.prints.join('\n'))
  await h.end()
})

test('a way back that throws, or has nothing to do, changes nothing: the one relaunch still comes, and nothing is printed for it', async () => {
  for (const answer of [async () => {
    throw new Error('import failed')
  }, async () => ({ outcome: 'none', reason: 'not_requested', record: null })]) {
    const w = wayBack(answer)
    w.release()
    const h = harness({ idleRollback: w.fn })
    await launched(h, 1)
    h.helpers[0]!.emit('exit', 0, null)
    h.fireHeartbeatCheck()
    await launched(h, 2)
    assert.equal(w.asks.length, 1)
    assert.equal(h.prints.some((l) => l.includes('never reported in')), false)
    await h.end()
  }
})

test('a channel heartbeat in time: the way back is never asked', async () => {
  const w = wayBack()
  w.release()
  const h = harness({ idleRollback: w.fn })
  await launched(h, 1)
  h.files.set(BEACON_PATH, `${JSON.stringify({ beaconAt: T0 + 40_000, pid: 7140 })}\n`)
  h.fireHeartbeatCheck()
  await settle()
  assert.equal(w.asks.length, 0)
  assert.equal(h.claudes.length, 1)
  await h.end()
})

test('the second launch without a heartbeat asks again, then reports and is left running, never a loop', async () => {
  const w = wayBack(async () => ({ outcome: 'none', reason: 'not_requested', record: null }))
  w.release()
  const h = harness({ idleRollback: w.fn })
  await launched(h, 1)
  h.helpers[0]!.emit('exit', 0, null)
  h.fireHeartbeatCheck()
  await launched(h, 2)
  h.helpers[1]!.emit('exit', 0, null)
  h.fireHeartbeatCheck()
  await waitUntil(() => w.asks.length === 2, 'asked on the second launch too')
  await settle()
  assert.equal(w.asks[1].launchedAtMs > w.asks[0].launchedAtMs, true, "the second launch's own start")
  assert.equal(h.claudes.length, 2, 'no further relaunch')
  assert.match(h.files.get(STATUS_PATH) ?? '', /outcome=no-channel-heartbeat /)
  await h.end()
})

test('a launcher asked to stop while the way back runs relaunches nothing', async () => {
  const w = wayBack()
  const h = harness({ idleRollback: w.fn })
  await launched(h, 1)
  h.helpers[0]!.emit('exit', 0, null)
  h.fireHeartbeatCheck()
  await waitUntil(() => w.asks.length === 1, 'the way back is asked')
  h.abort()
  w.release()
  await h.done
  assert.equal(h.claudes.length, 1)
})

test('a launcher asked to stop while the second launch\'s way back runs raises no alert for a claude it has ended', async () => {
  let n = 0
  const second = wayBack()
  const fn = async (input: any) => {
    n += 1
    return n === 1 ? { outcome: 'none', reason: 'not_requested', record: null } : second.fn(input)
  }
  const h = harness({ idleRollback: fn })
  await launched(h, 1)
  h.helpers[0]!.emit('exit', 0, null)
  h.fireHeartbeatCheck()
  await launched(h, 2)
  h.helpers[1]!.emit('exit', 0, null)
  h.fireHeartbeatCheck()
  await waitUntil(() => second.asks.length === 1, 'the second way back is asked')
  h.abort()
  await waitUntil(() => h.claudes[1]!.killed, 'the stop ends claude')
  await settle()
  second.release()
  await h.done
  await settle()
  assert.doesNotMatch(h.files.get(STATUS_PATH) ?? '', /outcome=no-channel-heartbeat /)
  assert.equal(h.prints.some((l) => l.includes('ALERT (no-channel-heartbeat)')), false, h.prints.join('\n'))
})

test('a launcher whose files are faked and passes no way back asks none (the existing tests run as before)', async () => {
  const h = harness()
  await launched(h, 1)
  h.helpers[0]!.emit('exit', 0, null)
  h.fireHeartbeatCheck()
  await launched(h, 2)
  await h.end()
})

// -- main(): what the real launcher runs ----------------------------------------------------------

class PlainChild extends EventEmitter {
  pid = 4242
  args: string[]
  killed = false
  constructor(args: readonly string[]) {
    super()
    this.args = [...args]
  }
  kill() {
    this.killed = true
    setImmediate(() => this.emit('exit', null, 'SIGTERM'))
    return true
  }
}

async function underMain(o: { idleRollback?: any; record?: (cache: string) => unknown }) {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'hoai-na-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'hoai-na-agent-'))
  writeFileSync(join(cwd, '.bgos-agent-id'), '871\n')
  const cache = join(home, '.claude', 'plugins', 'cache', 'hoai', 'hoai')
  for (const v of ['0.80.0', '0.81.0']) {
    mkdirSync(join(cache, v, '.claude-plugin'), { recursive: true })
    writeFileSync(join(cache, v, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'hoai', version: v }))
  }
  const at = new Date(T0).toISOString()
  writeFileSync(
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'hoai@hoai': [{ scope: 'user', installPath: join(cache, '0.81.0'), version: '0.81.0', installedAt: at, lastUpdated: at }] } }),
  )
  if (o.record) {
    mkdirSync(join(home, '.bgos-agent', '871'), { recursive: true })
    writeFileSync(join(home, '.bgos-agent', '871', 'idle-update.json'), JSON.stringify(o.record(cache)))
  }
  const stop = new AbortController()
  const spawns: PlainChild[] = []
  const timers: Array<{ fn: () => void; ms: number; fired: boolean }> = []
  const clock = { now: T0 + 5_000 }
  const done = core.main(['--keep-alive'], {
    platform: 'linux',
    env: {},
    home,
    cwd,
    scriptDir: SCRIPT_DIR.replace(/\\/g, '/'),
    listProcesses: () => [],
    sleep: async () => {},
    signal: stop.signal,
    print: () => {},
    hasExpect: false,
    now: () => clock.now,
    setTimer: ((fn: () => void, ms: number) => {
      const timer = { fn, ms, fired: false }
      timers.push(timer)
      return timer
    }) as never,
    clearTimer: (() => {}) as never,
    spawnImpl: ((_f: string, args: readonly string[]) => {
      const child = new PlainChild(args)
      spawns.push(child)
      return child
    }) as never,
    ...(o.idleRollback !== undefined ? { idleRollback: o.idleRollback } : {}),
  } as never)
  const fire = () => {
    const timer = timers.filter((t) => t.ms === THREE_MIN && !t.fired).at(-1)
    assert.ok(timer, 'the channel heartbeat check is armed')
    clock.now += THREE_MIN
    timer.fired = true
    timer.fn()
  }
  const end = async () => {
    stop.abort()
    await done.catch(() => null)
    const { rmSync } = await import('node:fs')
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
  return { home, cwd, cache, spawns, fire, end }
}

test('main() hands the way back on to the launch it supervises', async (t) => {
  const asks: any[] = []
  const h = await underMain({ idleRollback: async (input: any) => (asks.push(input), null) })
  t.after(h.end)
  await waitUntil(() => h.spawns.length === 1, 'launch 1')
  h.fire()
  await waitUntil(() => h.spawns.length === 2, 'the one relaunch')
  assert.equal(asks.length, 1)
  assert.equal(asks[0].assistantId, '871')
})

test('main() on the real files takes the real way back: a requested record, the install on the build, no heartbeat, and the install goes back before the relaunch', async (t) => {
  const { readFileSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const h = await underMain({
    record: (cache) => ({
      schema: 1,
      target: '0.81.0',
      from: '0.80.0',
      fromRoot: join(cache, '0.80.0'),
      fromCommit: null,
      installMethod: 'marketplace',
      pin: null,
      nonce: 'n1',
      canaryN: 1,
      state: 'requested',
      attempts: [{ at: new Date(T0).toISOString(), outcome: 'requested' }],
      lockBoots: 0,
    }),
  })
  t.after(h.end)
  await waitUntil(() => h.spawns.length === 1, 'launch 1')
  h.fire()
  await waitUntil(() => h.spawns.length === 2, 'the one relaunch')
  const installed = JSON.parse(readFileSync(join(h.home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins['hoai@hoai'][0]
  assert.equal(installed.version, '0.80.0')
  assert.ok(existsSync(join(h.home, '.bgos-agent', 'idle-update', '0.81.0', 'bad')))
  assert.equal(JSON.parse(readFileSync(join(h.home, '.bgos-agent', '871', 'idle-update.json'), 'utf8')).state, 'rolled_back')
})
