/**
 * lib/watcher-health.mjs and the crash-safe entry of bin/hoai-watcher.mjs
 * (design 8, fact 5, G6).
 *
 * Fact 5: a 0.61.1 watcher crash looped every 5 s on a missing
 * known-good-store.mjs and nobody was told, because the entry imported
 * watcher-core statically: the import failure killed the process before the
 * logger or the heartbeat existed. This file pins the fix by REPRODUCING that
 * failure: a temp bundle whose watcher-core.mjs imports a known-good-store.mjs
 * that is not there, loaded through the guard, in a temp HOME (no real ~ is
 * touched, the heartbeat goes to a recording fetch). Then:
 *
 *   crash.json      {at, message}, scrubbed (the temp home reads as ~)
 *   heartbeat       a minimal builtins-only POST carrying env.watcherHealth
 *                   {status, bootsLastHour, lastFatal}, pairing auth from credentials.json
 *   crash loop      3 or more starts within 10 minutes with no successful poll
 *                   between: the guard waits 30 s, doubling to 10 min, before exiting
 *   boots.json      a ring of the last 20 starts
 *
 * Run: npx tsx --test test/watcher-health.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  BOOTS_RING_SIZE,
  CRASH_BACKOFF_MAX_MS,
  CRASH_BACKOFF_MIN_MS,
  bootsPath,
  buildWatcherHealth,
  crashLoopVerdict,
  crashPath,
  healthHome,
  readBoots,
  recordBoot,
  runGuarded,
  scrubFatal,
} from '../lib/watcher-health.mjs'
import { watcherHome, watcherStatePath } from '../lib/watcher-bundle.mjs'
import { EXIT, WATCHER_INTENTS, loadWatcherModules, main } from '../bin/hoai-watcher.mjs'
import { EXIT_NO_CREDENTIALS, EXIT_SELF_REFRESH, INTENTS } from '../lib/watcher-core.mjs'
import { memoryFs } from './helpers/memory-fs.ts'

const T0 = Date.parse('2026-10-06T19:00:00.000Z')
const MIN = 60_000
const TOKEN = 'bgp_' + 'S3cretPairingTokenValue0123456789'

function boot(atMs: number, extra: Record<string, unknown> = {}) {
  return { startedAt: new Date(atMs).toISOString(), startedAtMs: atMs, pid: 100, version: '0.62.1', ...extra }
}

// -- pure pieces -----------------------------------------------------------------------------

test('healthHome mirrors the bundle layout (~/.bgos-agent/watcher), both separator styles', () => {
  assert.equal(healthHome('/home/kc'), watcherHome('/home/kc'))
  assert.equal(healthHome('C:\\Users\\kc'), watcherHome('C:\\Users\\kc'))
  assert.equal(bootsPath('/home/kc'), '/home/kc/.bgos-agent/watcher/boots.json')
  assert.equal(crashPath('/home/kc'), '/home/kc/.bgos-agent/watcher/crash.json')
})

test('crashLoopVerdict: 3 starts within 10 min with no successful poll between; 30 s doubling to 10 min; a good poll resets', () => {
  const rows: Array<[string, any[], number | null, boolean, number]> = [
    ['one start', [boot(T0)], null, false, 0],
    ['two starts', [boot(T0 - MIN), boot(T0)], null, false, 0],
    ['three starts in 2 min', [boot(T0 - 2 * MIN), boot(T0 - MIN), boot(T0)], null, true, CRASH_BACKOFF_MIN_MS],
    ['three starts over 11 min', [boot(T0 - 11 * MIN), boot(T0 - MIN), boot(T0)], null, false, 0],
    ['a poll succeeded after the first two', [boot(T0 - 2 * MIN), boot(T0 - MIN), boot(T0)], T0 - 30_000, false, 0],
    ['a poll long ago does not excuse new failures', [boot(T0 - 2 * MIN), boot(T0 - MIN), boot(T0)], T0 - 60 * MIN, true, CRASH_BACKOFF_MIN_MS],
    ['already waited once: the loop holds even when spread out, and doubles', [boot(T0 - 20 * MIN), boot(T0 - 15 * MIN), boot(T0 - 12 * MIN, { backoffMs: 30_000 }), boot(T0)], null, true, 60_000],
    ['waited five times: capped at 10 min', [boot(T0 - 50 * MIN), ...[1, 2, 3, 4, 5].map((i) => boot(T0 - (50 - i * 8) * MIN, { backoffMs: 1 })), boot(T0)], null, true, CRASH_BACKOFF_MAX_MS],
  ]
  for (const [name, boots, lastPollOkAtMs, crashLoop, backoffMs] of rows) {
    const v = crashLoopVerdict({ boots, lastPollOkAtMs, now: T0 })
    assert.equal(v.crashLoop, crashLoop, name)
    assert.equal(v.backoffMs, backoffMs, name)
  }
  assert.equal(CRASH_BACKOFF_MIN_MS, 30_000)
  assert.equal(CRASH_BACKOFF_MAX_MS, 10 * MIN)
})

test('recordBoot: boots.json is a ring of the last 20 starts {startedAt, pid, version}', () => {
  const fs = memoryFs()
  for (let i = 0; i < 25; i++) recordBoot('/home/kc', { startedAt: new Date(T0 + i * MIN).toISOString(), pid: 1000 + i, version: '0.62.1' }, fs)
  const boots = readBoots('/home/kc', fs)
  assert.equal(boots.length, BOOTS_RING_SIZE)
  assert.equal(boots[0]!.pid, 1005)
  assert.equal(boots[19]!.pid, 1024)
  assert.deepEqual(JSON.parse(fs.files.get(bootsPath('/home/kc'))!)[19], { startedAt: new Date(T0 + 24 * MIN).toISOString(), pid: 1024, version: '0.62.1' })
  fs.writeFile(bootsPath('/home/kc'), 'junk')
  assert.deepEqual(readBoots('/home/kc', fs), [])
})

test('buildWatcherHealth: ok, degraded after a recent fatal or 3+ boots in the hour; strings bounded to 120, agents to 64', () => {
  assert.deepEqual(buildWatcherHealth({ boots: [boot(T0 - 2 * 60 * MIN)], crash: null, now: T0 }), { status: 'ok', bootsLastHour: 0 })
  const crash = { at: new Date(T0 - 10 * MIN).toISOString(), message: `Cannot find module ${'x'.repeat(300)}` }
  const h = buildWatcherHealth({ boots: [boot(T0 - 5 * MIN)], crash, now: T0 })
  assert.equal(h.status, 'degraded')
  assert.equal(h.bootsLastHour, 1)
  assert.equal(h.lastFatal!.message.length, 120)
  assert.equal(buildWatcherHealth({ boots: [boot(T0 - 3 * MIN), boot(T0 - 2 * MIN), boot(T0 - MIN)], crash: null, now: T0 }).status, 'degraded')
  assert.equal(buildWatcherHealth({ boots: [], crash: { at: new Date(T0 - 2 * 60 * MIN).toISOString(), message: 'old' }, now: T0 }).status, 'ok', 'an old fatal is history, not a status')
  const agents = Array.from({ length: 70 }, (_, i) => ({ id: String(i), state: 'supervised', since: 'x' }))
  const withKeepAlive = buildWatcherHealth({ boots: [], crash: null, now: T0, keepAlive: { enabled: true, agents } })
  assert.equal(withKeepAlive.keepAlive!.agents.length, 64)
  assert.equal(withKeepAlive.keepAlive!.enabled, true)
  assert.equal(buildWatcherHealth({ boots: [], crash: null, now: T0, status: 'crash_loop' }).status, 'crash_loop')
})

test('scrubFatal: the home path, the username, the pairing token and token shapes never leave the machine', () => {
  const out = scrubFatal(`Cannot find module '/Users/kc/.bgos-agent/watcher/lib/x.mjs' token ${TOKEN} X-BGOS-Pairing: abc123456 user kc`, {
    home: '/Users/kc',
    username: 'kc',
    secrets: [TOKEN],
  })
  assert.equal(out, "Cannot find module '~/.bgos-agent/watcher/lib/x.mjs' token <redacted> X-BGOS-Pairing: <redacted> user <user>")
  assert.equal(scrubFatal('C:\\Users\\kc\\x', { home: 'C:\\Users\\kc', username: '', secrets: [] }), '~\\x')
})

// -- the guard, against the real fact 5 failure ---------------------------------------------------

function sandbox() {
  // realpath: on macOS tmpdir() is a symlink (/var -> /private/var) and node reports the real path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-watcher-guard-')))
  const home = join(root, 'home')
  const bundle = join(home, '.bgos-agent', 'watcher')
  mkdirSync(join(bundle, 'lib'), { recursive: true })
  // The exact fact 5 shape: watcher-core imports a sibling the bundle does not carry.
  writeFileSync(join(bundle, 'lib', 'watcher-core.mjs'), "import { readKnownGood } from './known-good-store.mjs'\nexport async function runWatcher() { return readKnownGood }\n")
  writeFileSync(join(bundle, 'manifest.json'), JSON.stringify({ version: '0.61.1', fingerprint: 'f', pluginRoot: '/x', files: [] }))
  writeFileSync(join(bundle, 'credentials.json'), JSON.stringify({ pairingId: 77, token: TOKEN, backendUrl: 'https://api.example.test', machineId: 'machine-1234' }))
  writeFileSync(join(home, '.bgos-agent', 'credentials-912.json'), '{}')
  const load = () => import(pathToFileURL(join(bundle, 'lib', 'watcher-core.mjs')).href)
  return { root, home, bundle, load, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function recordingFetch(status = 200) {
  const calls: Array<{ url: string; init: any; body: any }> = []
  const fetch = async (url: string, init: any) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    return { ok: status < 400, status, text: async () => '{}' }
  }
  return { calls, fetch }
}

test('guard: a missing module before the loop writes crash.json, sends the minimal heartbeat, and exits 1 (first start: degraded, no wait)', async () => {
  const box = sandbox()
  try {
    const hb = recordingFetch()
    const sleeps: number[] = []
    const errs: string[] = []
    const code = await runGuarded({
      home: box.home,
      env: {},
      platform: 'linux',
      username: 'nobody-here',
      load: box.load,
      run: async () => 0,
      fetch: hb.fetch as any,
      now: () => T0,
      sleep: async (ms: number) => void sleeps.push(ms),
      pid: 4321,
      err: (l: string) => errs.push(l),
    })
    assert.equal(code, 1)
    const crash = JSON.parse(readFileSync(join(box.bundle, 'crash.json'), 'utf8'))
    assert.equal(crash.at, new Date(T0).toISOString())
    assert.match(crash.message, /Cannot find module/)
    assert.match(crash.message, /known-good-store\.mjs/)
    assert.equal(crash.message.includes(box.home), false, 'the temp home is scrubbed to ~')
    assert.match(crash.message, /~[\\/]\.bgos-agent[\\/]watcher[\\/]lib[\\/]known-good-store\.mjs/)
    assert.equal(hb.calls.length, 1)
    assert.equal(hb.calls[0]!.url, 'https://api.example.test/api/v1/integrations/heartbeat')
    assert.equal(hb.calls[0]!.init.method, 'POST')
    assert.equal(hb.calls[0]!.init.headers['X-BGOS-Pairing'], TOKEN)
    assert.deepEqual(hb.calls[0]!.body, {
      daemonVersion: '0.61.1',
      env: {
        platform: 'linux',
        machineId: 'machine-1234',
        role: 'watcher',
        agents: ['912'],
        watcherHealth: { status: 'degraded', bootsLastHour: 1, lastFatal: { at: crash.at, message: crash.message.slice(0, 120) } },
      },
    })
    assert.deepEqual(sleeps, [], 'one failed start is not a loop')
    const boots = JSON.parse(readFileSync(join(box.bundle, 'boots.json'), 'utf8'))
    assert.deepEqual(boots, [{ startedAt: new Date(T0).toISOString(), pid: 4321, version: '0.61.1' }])
    assert.ok(errs.some((l) => l.includes('Cannot find module')))
    assert.ok(readFileSync(join(box.bundle, 'logs', 'watcher.log'), 'utf8').includes('fatal before the loop'))
  } finally {
    box.cleanup()
  }
})

test('guard: the third start within 10 min with no good poll is a crash loop: heartbeat says crash_loop, waits 30 s, then 60 s, before exiting', async () => {
  const box = sandbox()
  try {
    const run = async (at: number, pid: number) => {
      const hb = recordingFetch()
      const sleeps: number[] = []
      const code = await runGuarded({ home: box.home, env: {}, platform: 'darwin', load: box.load, run: async () => 0, fetch: hb.fetch as any, now: () => at, sleep: async (ms: number) => void sleeps.push(ms), pid })
      return { code, hb, sleeps }
    }
    await run(T0, 1)
    await run(T0 + 10_000, 2)
    const third = await run(T0 + 20_000, 3)
    assert.equal(third.code, 1)
    assert.equal(third.hb.calls[0]!.body.env.watcherHealth.status, 'crash_loop')
    assert.deepEqual(third.sleeps, [30_000])
    const boots = JSON.parse(readFileSync(join(box.bundle, 'boots.json'), 'utf8'))
    assert.equal(boots[2].backoffMs, 30_000, 'the wait is recorded on the boot, so the next one doubles')
    const fourth = await run(T0 + 70_000, 4)
    assert.deepEqual(fourth.sleeps, [60_000])
    // A successful poll recorded by the loop (state.json lastPollOkAt) ends the loop.
    writeFileSync(watcherStatePath(box.home), JSON.stringify({ lastPollOkAt: new Date(T0 + 200_000).toISOString() }))
    const after = await run(T0 + 210_000, 5)
    assert.deepEqual(after.sleeps, [])
    assert.equal(after.hb.calls[0]!.body.env.watcherHealth.status, 'degraded')
  } finally {
    box.cleanup()
  }
})

test('guard: a failure thrown by the loop itself is caught the same way; no credentials means no heartbeat but crash.json is still written', async () => {
  const box = sandbox()
  try {
    rmSync(join(box.bundle, 'credentials.json'))
    const hb = recordingFetch()
    const code = await runGuarded({
      home: box.home,
      env: {},
      platform: 'linux',
      load: async () => ({ ok: true }),
      run: async () => {
        throw new Error('loadLifecycleModules: Cannot find module update-executor.mjs')
      },
      fetch: hb.fetch as any,
      now: () => T0,
      sleep: async () => {},
      pid: 9,
    })
    assert.equal(code, 1)
    assert.equal(hb.calls.length, 0)
    assert.match(JSON.parse(readFileSync(join(box.bundle, 'crash.json'), 'utf8')).message, /update-executor/)
  } finally {
    box.cleanup()
  }
})

test('guard: a healthy start records the boot and returns the loop exit code untouched (75 after a self refresh)', async () => {
  const box = sandbox()
  try {
    const hb = recordingFetch()
    const code = await runGuarded({ home: box.home, env: {}, platform: 'linux', load: async () => ({ core: true }), run: async (loaded: any) => (loaded.core ? 75 : 0), fetch: hb.fetch as any, now: () => T0, sleep: async () => {}, pid: 9 })
    assert.equal(code, 75)
    assert.equal(hb.calls.length, 0)
    assert.equal(JSON.parse(readFileSync(join(box.bundle, 'boots.json'), 'utf8')).length, 1)
    assert.throws(() => readFileSync(join(box.bundle, 'crash.json')), /ENOENT/)
  } finally {
    box.cleanup()
  }
})

// -- the entry ------------------------------------------------------------------------------------

test('hoai-watcher run goes through the guard: a module that does not load is crash.json and exit 1, not a silent death', async () => {
  const box = sandbox()
  try {
    const hb = recordingFetch()
    const code = await main(['run'], { home: box.home, env: {}, platform: 'linux', loadModules: box.load, fetch: hb.fetch as any, now: () => T0, sleep: async () => {}, err: () => {}, out: () => {} } as any)
    assert.equal(code, 1)
    assert.match(JSON.parse(readFileSync(join(box.bundle, 'crash.json'), 'utf8')).message, /known-good-store/)
    assert.equal(hb.calls.length, 1)
  } finally {
    box.cleanup()
  }
})

test('hoai-watcher help proves the whole bundle loads (the staged-bundle probe): a missing module is exit 1', async () => {
  const errs: string[] = []
  const box = sandbox()
  try {
    const code = await main(['help'], { home: box.home, env: {}, loadModules: box.load, err: (l: string) => errs.push(l), out: () => {} } as any)
    assert.equal(code, 1)
    assert.ok(errs.some((l) => l.includes('known-good-store')))
  } finally {
    box.cleanup()
  }
})

test('the entry restates watcher-core INTENTS and its exit codes (builtins only), and they agree', () => {
  assert.deepEqual([...WATCHER_INTENTS], [...INTENTS])
  assert.equal(EXIT.SELF_REFRESH, EXIT_SELF_REFRESH)
  assert.equal(EXIT.NO_CONFIG, EXIT_NO_CREDENTIALS)
})

test('loadWatcherModules loads the whole closure, lifecycle modules included (so `help` probes what `run` needs)', async () => {
  const m = await loadWatcherModules()
  assert.equal(typeof m.core.runWatcher, 'function')
  assert.equal(typeof m.lifecycle.planMachine, 'function')
  assert.equal(typeof m.lifecycle.executePlan, 'function')
  assert.equal(typeof m.bundle.nodeFs, 'function')
  assert.equal(typeof m.service.readWatcherCredentials, 'function')
  assert.equal(typeof m.inventory.listAgents, 'function')
  assert.equal(typeof m.installMethod.pluginRootFromScriptPath, 'function')
})
