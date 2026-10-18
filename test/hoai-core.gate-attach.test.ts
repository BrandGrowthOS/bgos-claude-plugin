/**
 * A Windows launch whose dev-channels gate was never proven passed, and a launch that never brings
 * its channel up (board row d806c69f; agent 888, 16 Oct 07:59Z, a cold start right after logon).
 *
 * 888's win32-gate-helper.log had `start` and, 16 s later, `accepted`, but no `attached`, where
 * every earlier boot had all three. claude stayed alive and never spawned its MCP server, and the
 * agent sat offline for 10 minutes until a restart marker brought it back. The helper's `Note`
 * swallowed a failed log write (PowerShell 5.1 Add-Content refuses a file another process has open
 * for reading, as a NON-terminating error the `catch {}` never sees), and `accepted` only ever
 * meant "an Enter was written to the console input", so hoai had nothing to act on. The rules:
 *
 *   a. a helper that pressed Enter without having recorded both `attached` and `accepted` exits 6
 *      (WIN32_GATE_EXIT_UNPROVEN), and an unattended hoai relaunches claude for it, on the agent's
 *      own session, under the restart budget (3 per rolling hour);
 *   b. attached then accepted (exit 0) changes nothing, nor does any other helper exit;
 *   c. an unattended launch whose channel has sent no heartbeat (channel-beacon.json, touched by a
 *      delivering daemon about every 5 s) 3 minutes after launch is relaunched ONCE; the next
 *      launch without one is reported through launch-status and left running, never a loop.
 *
 * Every effect is a fake: claude, the gate helper, the files and the clock.
 *
 * Run: npx tsx --test test/hoai-core.gate-attach.test.ts
 */

import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as core from '../bin/hoai-core.mjs'
import * as inventory from '../lib/agent-inventory.mjs'
import { resolveCursorFilePath } from '../lib/cursor-store.ts'
import { BEACON_HEARTBEAT_FILE } from '../lib/pairing-lock.ts'

const { FOLDER_PIN_FILE, LAUNCH_STATUS_FILE_NAME, MAX_RELAUNCHES_PER_WINDOW, RESTART_MARKER_FILE_NAME, superviseClaude } = core
/** New in this fix: read off the namespace so a missing export fails a test instead of the import. */
const fixed = core as unknown as { WIN32_GATE_EXIT_UNPROVEN?: number; CHANNEL_HEARTBEAT_WAIT_MS?: number }

const HOME = 'C:\\Users\\mark'
const CWD = 'C:\\agents\\888'
const SCRIPT_DIR = 'C:\\Users\\mark\\.claude\\plugins\\cache\\hoai\\hoai\\0.69.6\\bin'
const STATE_DIR = `${HOME}\\.bgos-agent\\888`
const STATUS_PATH = `${STATE_DIR}\\${LAUNCH_STATUS_FILE_NAME}`
const MARKER_PATH = `${STATE_DIR}\\${RESTART_MARKER_FILE_NAME}`
const BEACON_PATH = `${HOME}\\.bgos-plugin-state\\888\\channel-beacon.json`
const SUPERVISED = { HOAI_SUPERVISED: '1', HOAI_SUPERVISED_ASSISTANT_ID: '888' }
const BASE_ARGS = ['--dangerously-skip-permissions', '--dangerously-load-development-channels', 'plugin:hoai@hoai']
const PIN = '88888888-8888-4888-8888-888888888888'
/** The helper's exit for "pressed Enter, but attached/accepted not both recorded". */
const UNPROVEN = 6
const THREE_MIN = 3 * 60_000
const T0 = Date.UTC(2026, 9, 16, 7, 59, 0)

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

function harness({ env = SUPERVISED as Record<string, string>, keepAlive = true } = {}) {
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

// -- a. the 888 shape ---------------------------------------------------------------------------

test('the 888 shape: the gate helper pressed Enter without having recorded attached (exit 6), so hoai relaunches claude on the agents own session', async () => {
  const h = harness()
  await launched(h, 1)
  h.helpers[0]!.emit('exit', UNPROVEN, null)
  await launched(h, 2)
  assert.equal(h.claudes[0]!.killed, true, 'the claude whose gate is unproven is ended')
  assert.deepEqual(h.claudes[1]!.args, [...BASE_ARGS, '--session-id', PIN], 'its own pinned session, never --continue')
  assert.match(h.files.get(STATUS_PATH) ?? '', /outcome=health-relaunch reason=gate-accept-unproven/)
  assert.ok(h.prints.some((line) => line.includes('exit 6') && line.includes('attached')), h.prints.join('\n'))
  assert.equal(h.claudes[1]!.killed, false)
  await h.end()
})

test('the 888 shape without --keep-alive (a supervised launch on its own) relaunches the same way', async () => {
  const h = harness({ keepAlive: false })
  await launched(h, 1)
  h.helpers[0]!.emit('exit', UNPROVEN, null)
  await launched(h, 2)
  assert.equal(h.claudes[0]!.killed, true)
  await h.end()
})

test('the relaunch for an unproven gate spends the restart budget: after 3 in an hour the next is refused and reported, never a loop', async () => {
  const h = harness()
  for (let n = 1; n <= MAX_RELAUNCHES_PER_WINDOW; n += 1) {
    await launched(h, n)
    h.helpers[n - 1]!.emit('exit', UNPROVEN, null)
  }
  await launched(h, MAX_RELAUNCHES_PER_WINDOW + 1)
  h.helpers[MAX_RELAUNCHES_PER_WINDOW]!.emit('exit', UNPROVEN, null)
  await settle()
  assert.equal(h.claudes.length, MAX_RELAUNCHES_PER_WINDOW + 1, 'the fourth unproven gate in an hour relaunches nothing')
  assert.equal(h.claudes.at(-1)!.killed, false, 'and the running claude is left alone')
  assert.match(h.files.get(STATUS_PATH) ?? '', /outcome=health-relaunch-refused reason=gate-accept-unproven/)
  await h.end()
})

test('a helper exit belongs to its own launch: an exit 6 from an earlier launchs helper never ends the current claude', async () => {
  const h = harness()
  await launched(h, 1)
  h.files.set(MARKER_PATH, '{}')
  await launched(h, 2)
  h.helpers[0]!.emit('exit', UNPROVEN, null)
  await settle()
  assert.equal(h.claudes.length, 2)
  assert.equal(h.claudes[1]!.killed, false)
  await h.end()
})

test('a helper exit belongs to its own launch: one arriving after that claude exited by itself (the keep-alive relaunch) changes nothing', async () => {
  const h = harness()
  await launched(h, 1)
  h.claudes[0]!.exit(1)
  await launched(h, 2)
  const status = h.files.get(STATUS_PATH)
  assert.match(status ?? '', /outcome=keep-alive-relaunch/)
  h.helpers[0]!.emit('exit', UNPROVEN, null)
  await settle()
  assert.equal(h.claudes.length, 2)
  assert.equal(h.claudes[1]!.killed, false)
  assert.equal(h.files.get(STATUS_PATH), status, 'nothing recorded for a launch that is over')
  await h.end()
})

test('a person at the terminal (not supervised, no --keep-alive): an exit 6 relaunches nothing and no heartbeat check is armed', async () => {
  const h = harness({ env: {}, keepAlive: false })
  await launched(h, 1)
  h.helpers[0]!.emit('exit', UNPROVEN, null)
  await settle()
  assert.equal(h.claudes.length, 1)
  assert.equal(h.claudes[0]!.killed, false)
  assert.equal(h.heartbeatTimer(), undefined)
  await h.end()
})

// -- b. attached then accepted --------------------------------------------------------------------

test('attached then accepted (exit 0) changes nothing, and neither does any other helper exit', async () => {
  for (const code of [0, 2, 3, 4, 5, null]) {
    const h = harness()
    await launched(h, 1)
    h.helpers[0]!.emit('exit', code, null)
    await settle()
    assert.equal(h.claudes.length, 1, `helper exit ${code}: no relaunch`)
    assert.equal(h.claudes[0]!.killed, false, `helper exit ${code}: claude left running`)
    assert.equal(h.files.has(STATUS_PATH), false, `helper exit ${code}: no launch-status written`)
    await h.end()
  }
})

// -- c. no channel heartbeat 3 minutes after launch ----------------------------------------------

test('no channel heartbeat 3 minutes after launch: relaunched ONCE, then the next launch without one is reported and left running', async () => {
  assert.equal(fixed.CHANNEL_HEARTBEAT_WAIT_MS, THREE_MIN)
  const h = harness()
  await launched(h, 1)
  h.helpers[0]!.emit('exit', 0, null)
  h.fireHeartbeatCheck()
  await launched(h, 2)
  assert.equal(h.claudes[0]!.killed, true)
  assert.deepEqual(h.claudes[1]!.args, [...BASE_ARGS, '--session-id', PIN])
  assert.match(h.files.get(STATUS_PATH) ?? '', /outcome=health-relaunch reason=no-channel-heartbeat/)
  h.helpers[1]!.emit('exit', 0, null)
  h.fireHeartbeatCheck()
  await settle()
  assert.equal(h.claudes.length, 2, 'the second launch without a heartbeat is not relaunched')
  assert.equal(h.claudes[1]!.killed, false)
  assert.match(h.files.get(STATUS_PATH) ?? '', /outcome=no-channel-heartbeat /)
  assert.ok(h.prints.some((line) => line.includes('no-channel-heartbeat') && line.includes(BEACON_PATH)), h.prints.join('\n'))
  assert.equal(h.heartbeatTimer(), undefined, 'and nothing is armed to try again')
  await h.end()
})

test('a channel heartbeat in time does nothing', async () => {
  const h = harness()
  await launched(h, 1)
  h.beacon(T0 + 40_000, 7140)
  h.fireHeartbeatCheck()
  await settle()
  assert.equal(h.claudes.length, 1)
  assert.equal(h.claudes[0]!.killed, false)
  assert.equal(h.files.has(STATUS_PATH), false)
  await h.end()
})

test('a beacon from before this launch is not its heartbeat (the last boot left it behind)', async () => {
  const h = harness()
  h.beacon(T0 - 60_000, 7140)
  await launched(h, 1)
  h.fireHeartbeatCheck()
  await launched(h, 2)
  assert.equal(h.claudes[0]!.killed, true)
  await h.end()
})

test('a beacon dated before the launch counts for nothing even when there was none at launch (a restored file, a writer whose clock is behind)', async () => {
  const h = harness()
  await launched(h, 1)
  h.beacon(T0 - 1_000, 9100)
  h.fireHeartbeatCheck()
  await launched(h, 2)
  assert.equal(h.claudes[0]!.killed, true)
  await h.end()
})

test('channelHeartbeatSince and parseChannelBeacon, on their own', () => {
  const since = (core as unknown as { channelHeartbeatSince: (i: object) => boolean }).channelHeartbeatSince
  const parse = (core as unknown as { parseChannelBeacon: (raw: unknown) => unknown }).parseChannelBeacon
  assert.equal(since({ beacon: null, startedAt: T0 }), false)
  assert.equal(since({ beacon: { beaconAt: T0 - 1, pid: 9100 }, startedAt: T0, stalePid: null }), false, 'before the launch')
  assert.equal(since({ beacon: { beaconAt: T0, pid: 9100 }, startedAt: T0, stalePid: 7140 }), true, 'another daemon, at the launch')
  assert.equal(since({ beacon: { beaconAt: T0 + 59_999, pid: 7140 }, startedAt: T0, stalePid: 7140 }), false, 'the predecessor, inside the minute')
  assert.equal(since({ beacon: { beaconAt: T0 + 60_000, pid: 7140 }, startedAt: T0, stalePid: 7140 }), true, 'the same daemon a minute on')
  assert.deepEqual(parse('{"beaconAt": 5, "pid": 12}\n'), { beaconAt: 5, pid: 12 })
  for (const junk of [null, '', 'nope', '[]', '{"beaconAt":"x","pid":1}', '{"beaconAt":1,"pid":0}', '{"beaconAt":1,"pid":1.5}', '{"beaconAt":1}']) {
    assert.equal(parse(junk), null, String(junk))
  }
})

test('a beacon the predecessor daemon wrote after this launch started is not its heartbeat either', async () => {
  const h = harness()
  h.beacon(T0 - 5_000, 7140)
  await launched(h, 1)
  // The previous claude's daemon (pid 7140) is still winding down and beacons once more.
  h.beacon(T0 + 2_000, 7140)
  h.fireHeartbeatCheck()
  await launched(h, 2)
  assert.equal(h.claudes[0]!.killed, true)
  await h.end()
})

test('a daemon that was beaconing before the launch and still is a minute on is a live channel (another session of the agent holds it): nothing relaunched', async () => {
  const h = harness()
  h.beacon(T0 - 5_000, 7140)
  await launched(h, 1)
  h.beacon(T0 + 170_000, 7140)
  h.fireHeartbeatCheck()
  await settle()
  assert.equal(h.claudes.length, 1)
  assert.equal(h.claudes[0]!.killed, false)
  await h.end()
})

test('a launch that did send a heartbeat earns the one relaunch back for a later launch', async () => {
  const h = harness()
  await launched(h, 1)
  h.fireHeartbeatCheck()
  await launched(h, 2)
  h.beacon(h.clock.now + 30_000, 9100)
  h.fireHeartbeatCheck()
  await settle()
  assert.equal(h.claudes.length, 2)
  // An update restart later on; that launch never brings its channel up.
  h.files.set(MARKER_PATH, '{}')
  await launched(h, 3)
  h.fireHeartbeatCheck()
  await launched(h, 4)
  assert.equal(h.claudes[2]!.killed, true, 'relaunched, not just reported')
  await h.end()
})

test('the heartbeat check is cleared when claude ends first: a dead launch is never judged', async () => {
  const h = harness()
  await launched(h, 1)
  const timer = h.heartbeatTimer()
  assert.ok(timer)
  h.files.set(MARKER_PATH, '{}')
  await launched(h, 2)
  assert.equal(timer.cleared, true)
  await h.end()
})

test('a stop request that comes before the check fires: nothing is relaunched or recorded, the launcher just ends', async () => {
  const h = harness()
  await launched(h, 1)
  h.abort()
  h.fireHeartbeatCheck()
  await h.done
  assert.equal(h.claudes.length, 1)
  assert.equal(h.files.has(STATUS_PATH), false)
  assert.ok(!h.prints.some((line) => line.includes('Relaunching')), h.prints.join('\n'))
})

test('a heartbeat relaunch past the restart budget is refused and reported, and claude is left as it is', async () => {
  const h = harness()
  for (let n = 1; n <= MAX_RELAUNCHES_PER_WINDOW; n += 1) {
    await launched(h, n)
    h.helpers[n - 1]!.emit('exit', UNPROVEN, null)
  }
  await launched(h, MAX_RELAUNCHES_PER_WINDOW + 1)
  h.fireHeartbeatCheck()
  await settle()
  assert.equal(h.claudes.length, MAX_RELAUNCHES_PER_WINDOW + 1)
  assert.equal(h.claudes.at(-1)!.killed, false)
  assert.match(h.files.get(STATUS_PATH) ?? '', /outcome=health-relaunch-refused reason=no-channel-heartbeat/)
  await h.end()
})

test('posix, supervised under expect: no heartbeat at 3 minutes relaunches the expect session once, on the agents own session', async () => {
  const files = new Map<string, string>()
  const spawns: FakeClaude[] = []
  const timers: FakeTimer[] = []
  const clock = { now: T0 }
  const stop = new AbortController()
  const done = superviseClaude(BASE_ARGS, {
    platform: 'linux',
    env: { ...SUPERVISED, PATH: '/usr/bin' },
    home: '/home/mark',
    cwd: '/agents/888',
    scriptDir: '/home/mark/bgos-claude-plugin/bin',
    readFile: (p: string) => (p === `/agents/888/${FOLDER_PIN_FILE}` ? '888' : files.get(p) ?? null),
    listDir: () => [],
    spawnImpl: ((_file: string, args: readonly string[]) => {
      const child = new FakeClaude(4000 + spawns.length, args)
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
    print: () => {},
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
    signal: stop.signal,
    hasExpect: true,
    stdinIsTTY: false,
    listProcesses: () => [],
    pidProcess: () => null,
    pidAlive: () => false,
    generateId: () => PIN,
  } as never)
  await waitUntil(() => spawns.length === 1, 'the expect session')
  const timer = timers.find((t) => t.ms === THREE_MIN && !t.cleared)
  assert.ok(timer, 'the check is armed on posix too')
  clock.now = timer.at + timer.ms
  timer.fn()
  await waitUntil(() => spawns.length === 2, 'the relaunch')
  assert.equal(spawns[0]!.killed, true)
  assert.match(files.get(`/home/mark/.bgos-agent/888/${LAUNCH_STATUS_FILE_NAME}`) ?? '', /outcome=health-relaunch reason=no-channel-heartbeat/)
  assert.ok(spawns[1]!.args.some((arg) => arg.includes(PIN)), 'the relaunch is the same pinned session')
  stop.abort()
  await done
})

test('hoai reads the beacon in the folder the daemon writes it to (pluginStateDirFor = dirname of resolveCursorFilePath)', () => {
  const home = join(tmpdir(), 'hoai-home')
  for (const env of [{}, { BGOS_PLUGIN_STATE_DIR: join(tmpdir(), 'state-root') }]) {
    assert.equal(
      inventory.pluginStateDirFor({ env, home, assistantId: '888', cwd: join(tmpdir(), 'agents', '888') }),
      dirname(resolveCursorFilePath({ assistantId: '888', cwd: join(tmpdir(), 'agents', '888'), env, home })),
    )
  }
})

// -- the contracts the two sides share -----------------------------------------------------------

test('the helper and hoai agree on exit 6, and the helper documents it', () => {
  assert.equal(fixed.WIN32_GATE_EXIT_UNPROVEN, UNPROVEN)
  const src = readFileSync(new URL('../bin/win32-accept-dev-channels.ps1', import.meta.url), 'utf8')
  assert.match(src, /^# Exit codes: 0 accepted.* 6 /m)
  assert.match(src, /\bexit 6\b/)
})

test('the helper appends without refusing readers (append-only, sharing ReadWrite and Delete), and says when a line is lost', () => {
  const src = readFileSync(new URL('../bin/win32-accept-dev-channels.ps1', import.meta.url), 'utf8')
  const code = src
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
  assert.match(code, /New-Object System\.IO\.FileStream\(\$LogFile, \[System\.IO\.FileMode\]::Append, \[System\.Security\.AccessControl\.FileSystemRights\]::AppendData, \[System\.IO\.FileShare\]'ReadWrite, Delete'/)
  assert.doesNotMatch(code, /Add-Content/, 'Add-Content shares no read: any reader made it fail (the 888 line)')
  assert.match(code, /return \$false/)
  assert.match(code, /\$host\.UI\.WriteErrorLine\('log write refused, one line lost: '/)
})

test('the helper exits 0 only when attached AND accepted are both on record', () => {
  const src = readFileSync(new URL('../bin/win32-accept-dev-channels.ps1', import.meta.url), 'utf8')
  assert.match(src, /\$attachedNoted = Note "attached"/)
  assert.match(src, /if \(\$attachedNoted -and \(Note "accepted"\)\) \{ exit 0 \}/)
  assert.equal(src.match(/\bexit 0\b/g)?.length, 1, 'no other way to exit 0')
})

test('hoai looks for the beacon the daemon writes: the file name mirrors lib/pairing-lock.ts', () => {
  assert.equal((inventory as unknown as { BEACON_HEARTBEAT_FILE_NAME?: string }).BEACON_HEARTBEAT_FILE_NAME, BEACON_HEARTBEAT_FILE)
})

test('the proof Mark runs for 888 passes a start only on start, attached AND accepted from ONE helper, never on accepted alone', () => {
  const src = readFileSync(new URL('../docs/evidence/2026-10-16-gate-attach/gate-proof.ps1', import.meta.url), 'utf8')
  assert.match(src, /\$ok = \(\$h\.words -contains 'start'\) -and \(\$h\.words -contains 'attached'\) -and \(\$h\.words -contains 'accepted'\)/)
  assert.match(src, /if \(\$ok\) \{ \$passAt = \$h\.acceptedAt \}/)
  assert.match(src, /\$pass = \$passAt -and \$boot -and \$beaconAt -and \$beaconAt -ge \$passAt/)
  assert.match(src, /accepted WITHOUT attached: the 888 shape/)
  // The log is shared by every agent: only helpers of THIS agent's launcher count.
  assert.match(src, /if \(\$ConsolePid -gt 0 -and \$h\.console -ne \$ConsolePid\) \{ Say "helper pid \$hp : another launcher's/)
})
