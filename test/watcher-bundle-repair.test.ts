/**
 * A watcher bundle installed by OLDER code from a NEWER plugin root (e2e
 * finding E4, the fact 5 failure class).
 *
 * installWatcherBundle used to copy the INSTALLER's own WATCHER_BUNDLE_FILES
 * list, and the installer is usually older than the root it copies from: the
 * daemon that runs "Set up the watcher" is still on the previous version
 * while the plugin on disk is already updated, and a watcher's self refresh
 * runs the old watcher's code. Measured on 2026-10-07: a bundle installed
 * from the 0.62.0 root by older code crash looped on "Cannot find module
 * .../lib/win32-script-text.mjs". Worse, the 0.61.4 list lacks
 * lib/watcher-health.mjs, which the entry used to import STATICALLY, so a
 * watcher installed by a 0.61.4 daemon died on load before its crash-safe
 * guard existed: a silent crash loop.
 *
 * These tests build exactly that bundle FROM THIS CHECKOUT with ONLY the
 * 0.61.4 list and run the real entry under real node in a temp HOME:
 *
 *   repair     the first run sees the missing modules, repairs the bundle from
 *              manifest.pluginRoot (this checkout) and exits; the second run
 *              loads cleanly
 *   no root    with the plugin root gone, the first `run` records crash.json
 *              and boots.json and ATTEMPTS the minimal crash heartbeat (a
 *              closed 127.0.0.1 port), and nothing hangs
 *   bounded    one repair attempt per 10 minutes
 *
 * No services, no real HOME, no network beyond a refused loopback connect.
 *
 * Run: npx tsx --test test/watcher-bundle-repair.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  FALLBACK_GUARD,
  HIDDEN_LAUNCHER_FILE,
  NO_REPAIR_ENV,
  main,
  missingBundleModule,
  restartAfterRepair,
  runFallbackGuard,
  scrubText,
} from '../bin/hoai-watcher.mjs'
import {
  BUNDLE_REPAIR_INTERVAL_MS,
  WATCHER_BUNDLE_FILES,
  bundleFingerprint,
  nodeFs,
  relativeImportSpecifiers,
  repairWatcherBundle,
} from '../lib/watcher-bundle.mjs'
import * as health from '../lib/watcher-health.mjs'
import { WATCHER_HIDDEN_LAUNCHER_FILE } from '../lib/watcher-service.mjs'

const REPO = realpathSync(join(import.meta.dirname, '..'))
const PLUGIN_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version as string

/**
 * WATCHER_BUNDLE_FILES as 0.61.4 shipped it (`git show origin/main:lib/watcher-bundle.mjs`
 * on 2026-10-07), hard coded so the test does not move when main does. This is
 * the list a 0.61.4 daemon copies when it runs "Set up the watcher" against a
 * newer plugin root.
 */
const LIST_0_61_4 = [
  'bin/hoai-watcher.mjs',
  'bin/bgos-install-method.mjs',
  'lib/plugin-cli.mjs',
  'lib/update-planner.mjs',
  'lib/update-executor.mjs',
  'lib/known-good-store.mjs',
  'lib/update-diagnostics.mjs',
  'lib/machine-id.mjs',
  'lib/watcher-core.mjs',
  'lib/watcher-service.mjs',
  'lib/watcher-bundle.mjs',
  'lib/agent-inventory.mjs',
  'lib/agent-restart.mjs',
  'lib/service-supervision.mjs',
  'lib/agent-verify.mjs',
  'lib/claude-preseed.mjs',
]

/** What the 0.62.0 entry needs and the 0.61.4 list never named. */
const NOT_IN_0_61_4 = [
  'lib/watcher-health.mjs',
  'lib/watcher-keepalive.mjs',
  'lib/keepalive-plan.mjs',
  'lib/process-tree.mjs',
  'lib/agent-task-win32.mjs',
  'lib/win32-script-text.mjs',
]

const TOKEN = 'bgp_' + 'RepairTestPairingTokenValue0123456789'

function sandbox(pluginRoot = REPO) {
  // realpath: on macOS tmpdir() is a symlink (/var -> /private/var) and node reports the real path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-watcher-repair-')))
  const home = join(root, 'home')
  const bundle = join(home, '.bgos-agent', 'watcher')
  // Exactly what an OLD installWatcherBundle wrote: its own list, copied from
  // the new root, and a manifest naming that root.
  for (const rel of LIST_0_61_4) {
    mkdirSync(dirname(join(bundle, rel)), { recursive: true })
    copyFileSync(join(REPO, rel), join(bundle, rel))
  }
  writeFileSync(
    join(bundle, 'manifest.json'),
    `${JSON.stringify({ version: PLUGIN_VERSION, fingerprint: 'f'.repeat(64), installedAt: '2026-10-07T01:21:00.000Z', pluginRoot, claudeConfigDir: null, files: LIST_0_61_4 }, null, 2)}\n`,
  )
  return { root, home, bundle, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function runEntry(bundle: string, home: string, args: string[], extraEnv: Record<string, string> = {}) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [join(bundle, 'bin', 'hoai-watcher.mjs'), ...args], {
    cwd: home,
    // A minimal env: the temp HOME is the only home the entry can see.
    env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, USER: 'hoai-test-user', USERNAME: 'hoai-test-user', ...extraEnv },
    encoding: 'utf8',
    timeout: 45_000,
  })
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ms: Date.now() - started }
}

async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

test('the 0.61.4-list bundle from this checkout: the first run repairs it from manifest.pluginRoot and exits, the second run loads cleanly', () => {
  const box = sandbox()
  try {
    for (const rel of NOT_IN_0_61_4) assert.equal(existsSync(join(box.bundle, rel)), false, `fixture: ${rel} is absent`)
    const first = runEntry(box.bundle, box.home, ['help'])
    assert.equal(first.signal, null, `the first run did not hang: ${first.stderr}`)
    assert.doesNotMatch(first.stderr, /^Error \[ERR_MODULE_NOT_FOUND\]/m, 'never an uncaught load failure')
    assert.match(first.stderr, /repaired/i, first.stderr)
    for (const rel of NOT_IN_0_61_4) assert.equal(existsSync(join(box.bundle, rel)), true, `${rel} was repaired into the bundle`)
    for (const rel of NOT_IN_0_61_4) assert.equal(readFileSync(join(box.bundle, rel), 'utf8'), readFileSync(join(REPO, rel), 'utf8'))
    const manifest = JSON.parse(readFileSync(join(box.bundle, 'manifest.json'), 'utf8'))
    for (const rel of [...LIST_0_61_4, ...NOT_IN_0_61_4]) assert.ok(manifest.files.includes(rel), `manifest.files lists ${rel}`)
    assert.equal(manifest.pluginRoot, REPO)
    const log = readFileSync(join(box.bundle, 'logs', 'watcher.log'), 'utf8')
    assert.match(log, /bundle repair/, log)
    assert.ok(log.includes('lib/watcher-health.mjs'), log)
    assert.equal(log.includes(box.home), false, 'the log is scrubbed: the temp home reads as ~')
    const state = JSON.parse(readFileSync(join(box.bundle, 'state.json'), 'utf8'))
    assert.equal(typeof state.bundleRepair?.at, 'string', 'the attempt is recorded in the bundle state')

    const second = runEntry(box.bundle, box.home, ['help'])
    assert.equal(second.status, 0, second.stderr)
    assert.match(second.stdout, /hoai-watcher: the per-machine watcher/)
    assert.doesNotMatch(second.stderr, /repair|Cannot find module/i, second.stderr)
  } finally {
    box.cleanup()
  }
})

test('the 0.61.4-list bundle with its plugin root gone: `run` records crash.json and boots.json, attempts the crash heartbeat, and does not hang', async () => {
  const port = await closedPort()
  const box = sandbox('/nonexistent/hoai-plugin-root-that-is-gone')
  try {
    writeFileSync(
      join(box.bundle, 'credentials.json'),
      JSON.stringify({ pairingId: 77, token: TOKEN, backendUrl: `http://127.0.0.1:${port}`, machineId: 'machine-repair-1' }),
    )
    const first = runEntry(box.bundle, box.home, ['run'])
    assert.equal(first.signal, null, `the run did not hang: ${first.stderr}`)
    assert.ok(first.ms < 30_000, `bounded: ${first.ms} ms`)
    assert.equal(first.status, 1, first.stderr)
    const crash = JSON.parse(readFileSync(join(box.bundle, 'crash.json'), 'utf8'))
    assert.match(crash.message, /Cannot find module/)
    assert.match(crash.message, /watcher-health\.mjs/)
    assert.equal(crash.message.includes(box.home), false, 'scrubbed')
    const boots = JSON.parse(readFileSync(join(box.bundle, 'boots.json'), 'utf8'))
    assert.equal(boots.length, 1)
    assert.equal(boots[0].version, PLUGIN_VERSION)
    const log = readFileSync(join(box.bundle, 'logs', 'watcher.log'), 'utf8')
    assert.match(log, /fatal before the loop/, log)
    assert.match(log, /plugin root .* is missing/, log)
    assert.match(log, /crash heartbeat .*not delivered/, log)
    assert.equal(log.includes(TOKEN), false, 'the pairing token never reaches the log')
    for (const rel of NOT_IN_0_61_4) assert.equal(existsSync(join(box.bundle, rel)), false, `${rel} stays absent: nothing to repair from`)
    assert.match(first.stderr, /fatal before the loop/)
  } finally {
    box.cleanup()
  }
})

test('the repair is bounded: one attempt per 10 minutes, recorded in the bundle state', () => {
  const box = sandbox()
  try {
    writeFileSync(join(box.bundle, 'state.json'), JSON.stringify({ bundleRepair: { at: new Date(Date.now() - 60_000).toISOString(), outcome: 'repaired' } }))
    const first = runEntry(box.bundle, box.home, ['help'])
    assert.equal(first.status, 1, first.stderr)
    assert.match(first.stderr, /does not load/)
    assert.match(first.stderr, /repair skipped.*10 min/i, first.stderr)
    for (const rel of NOT_IN_0_61_4) assert.equal(existsSync(join(box.bundle, rel)), false, `${rel} was not copied`)
    // Eleven minutes later the next attempt is allowed.
    writeFileSync(join(box.bundle, 'state.json'), JSON.stringify({ bundleRepair: { at: new Date(Date.now() - 11 * 60_000).toISOString(), outcome: 'repaired' } }))
    const later = runEntry(box.bundle, box.home, ['help'])
    assert.equal(later.status, 0, later.stderr)
    assert.equal(existsSync(join(box.bundle, 'lib', 'watcher-health.mjs')), true)
  } finally {
    box.cleanup()
  }
})

// -- B1: the entry loads beside nothing but itself ---------------------------------------------------

test('B1: the entry imports node builtins only, statically; alone in a dir it still loads and fails by name, never an uncaught load error', () => {
  const source = readFileSync(join(REPO, 'bin', 'hoai-watcher.mjs'), 'utf8')
  const statics = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => String(m[1]))
  assert.ok(statics.length >= 4, 'the scan reads the import block')
  assert.deepEqual(statics.filter((spec) => !spec.startsWith('node:')), [], 'no static import of any file at all')
  // Every relative import it does make is dynamic and inside the 0.61.4 list or the guard module.
  for (const spec of relativeImportSpecifiers(source)) {
    const rel = join('bin', spec).split('\\').join('/')
    assert.ok(LIST_0_61_4.includes(rel) || rel === 'lib/watcher-health.mjs', `${spec} -> ${rel}`)
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-watcher-alone-')))
  try {
    const home = join(root, 'home')
    const bundle = join(home, '.bgos-agent', 'watcher')
    mkdirSync(join(bundle, 'bin'), { recursive: true })
    copyFileSync(join(REPO, 'bin', 'hoai-watcher.mjs'), join(bundle, 'bin', 'hoai-watcher.mjs'))
    const help = runEntry(bundle, home, ['help'])
    assert.equal(help.status, 1)
    assert.doesNotMatch(help.stderr, /^Error \[ERR_MODULE_NOT_FOUND\]/m)
    assert.match(help.stderr, /the watcher bundle does not load/)
    assert.match(help.stderr, /bundle repair skipped: the bundle has no manifest\.json/)
    // `run` alone: the builtins-only guard still writes what the app reads.
    const run = runEntry(bundle, home, ['run'])
    assert.equal(run.status, 1, run.stderr)
    assert.match(JSON.parse(readFileSync(join(bundle, 'crash.json'), 'utf8')).message, /watcher-health\.mjs/)
    assert.equal(JSON.parse(readFileSync(join(bundle, 'boots.json'), 'utf8')).length, 1)
    assert.match(readFileSync(join(bundle, 'logs', 'watcher.log'), 'utf8'), /crash heartbeat: not sent \(no credentials\.json\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B2, the case measured on 2026-10-07: a 0.62.0 bundle missing win32-script-text.mjs repairs itself under `run` and exits 75; `help` then loads cleanly', () => {
  const box = sandbox()
  try {
    // What an older installer copied from the 0.62.0 root: everything but the newest leaf.
    for (const rel of WATCHER_BUNDLE_FILES) {
      if (rel === 'lib/win32-script-text.mjs') continue
      mkdirSync(dirname(join(box.bundle, rel)), { recursive: true })
      copyFileSync(join(REPO, rel), join(box.bundle, rel))
    }
    const run = runEntry(box.bundle, box.home, ['run'])
    assert.equal(run.signal, null, run.stderr)
    assert.equal(run.status, 75, `posix: exit 75 so the service manager starts the repaired bundle\n${run.stderr}`)
    assert.match(run.stderr, /fatal before the loop: Cannot find module .*win32-script-text\.mjs.*; bundle repaired: lib\/win32-script-text\.mjs was missing; copied 1 file\(s\)/)
    assert.equal(existsSync(join(box.bundle, 'lib', 'win32-script-text.mjs')), true)
    assert.match(JSON.parse(readFileSync(join(box.bundle, 'crash.json'), 'utf8')).message, /win32-script-text\.mjs/, 'the fatal is still on record')
    assert.match(readFileSync(join(box.bundle, 'logs', 'watcher.log'), 'utf8'), /bundle repair: copied 1 file\(s\) from .*: lib\/win32-script-text\.mjs/)
    const help = runEntry(box.bundle, box.home, ['help'])
    assert.equal(help.status, 0, help.stderr)
    assert.equal(help.stderr, '')
  } finally {
    box.cleanup()
  }
})

// -- the fallback guard keeps watcher-health's files and wire shape ----------------------------------

function guardBox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-watcher-fallback-')))
  const home = join(root, 'home')
  const bundle = join(home, '.bgos-agent', 'watcher')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, 'manifest.json'), JSON.stringify({ version: '0.61.4', fingerprint: 'f', pluginRoot: '/x', files: [] }))
  writeFileSync(join(bundle, 'credentials.json'), JSON.stringify({ pairingId: 77, token: TOKEN, backendUrl: 'https://api.example.test/', machineId: 'machine-1234' }))
  writeFileSync(join(home, '.bgos-agent', 'credentials-912.json'), '{}')
  writeFileSync(join(home, '.bgos-agent', 'credentials-31.json'), '{}')
  const error = Object.assign(new Error(`Cannot find module '${join(bundle, 'lib', 'watcher-health.mjs')}' imported from ${join(bundle, 'bin', 'hoai-watcher.mjs')}`), {
    code: 'ERR_MODULE_NOT_FOUND',
    url: pathToFileURL(join(bundle, 'lib', 'watcher-health.mjs')).href,
  })
  return { root, home, bundle, error, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function recordingFetch() {
  const calls: Array<{ url: string; init: any; body: any }> = []
  const fetch = async (url: string, init: any) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    return { ok: true, status: 200 }
  }
  return { calls, fetch }
}

const T0 = Date.parse('2026-10-07T02:00:00.000Z')

test('runFallbackGuard writes the same crash.json and boots.json and sends the same heartbeat as watcher-health runGuarded', async () => {
  const a = guardBox()
  const b = guardBox()
  try {
    const fa = recordingFetch()
    const fb = recordingFetch()
    const common = { env: {}, platform: 'darwin', username: 'nobody-here', now: () => T0, sleep: async () => {}, pid: 4321, err: () => {} }
    const codeA = await runFallbackGuard({ ...common, home: a.home, error: a.error, fetch: fa.fetch as any })
    const codeB = await health.runGuarded({ ...common, home: b.home, fetch: fb.fetch as any, load: async () => { throw b.error }, run: async () => 0 })
    assert.equal(codeA, 1)
    assert.equal(codeB, 1)
    const norm = (box: { home: string }, text: string) => text.split(box.home).join('<HOME>')
    for (const file of ['crash.json', 'boots.json']) {
      assert.equal(norm(a, readFileSync(join(a.bundle, file), 'utf8')), norm(b, readFileSync(join(b.bundle, file), 'utf8')), file)
    }
    assert.equal(fa.calls.length, 1)
    assert.equal(fb.calls.length, 1)
    assert.equal(fa.calls[0]!.url, 'https://api.example.test/api/v1/integrations/heartbeat')
    assert.equal(fa.calls[0]!.url, fb.calls[0]!.url)
    assert.equal(fa.calls[0]!.init.method, 'POST')
    assert.deepEqual(fa.calls[0]!.init.headers, fb.calls[0]!.init.headers)
    assert.equal(fa.calls[0]!.init.headers['X-BGOS-Pairing'], TOKEN)
    assert.deepEqual(fa.calls[0]!.body, fb.calls[0]!.body)
    assert.deepEqual(fa.calls[0]!.body.env.agents, ['31', '912'])
    assert.equal(fa.calls[0]!.body.env.watcherHealth.status, 'degraded')
    assert.equal(fa.calls[0]!.body.daemonVersion, '0.61.4')
    assert.match(readFileSync(join(a.bundle, 'logs', 'watcher.log'), 'utf8'), /crash heartbeat to https:\/\/api\.example\.test\/api\/v1\/integrations\/heartbeat: delivered \(HTTP 200\)/)
  } finally {
    a.cleanup()
    b.cleanup()
  }
})

test('runFallbackGuard: the third start within 10 min with no good poll is a crash loop: crash_loop on the wire, waits 30 s then 60 s', async () => {
  const box = guardBox()
  try {
    const start = async (at: number, pid: number) => {
      const hb = recordingFetch()
      const sleeps: number[] = []
      const code = await runFallbackGuard({ home: box.home, error: box.error, platform: 'linux', fetch: hb.fetch as any, now: () => at, sleep: async (ms: number) => void sleeps.push(ms), pid })
      return { code, hb, sleeps }
    }
    assert.deepEqual((await start(T0, 1)).sleeps, [])
    assert.deepEqual((await start(T0 + 10_000, 2)).sleeps, [])
    const third = await start(T0 + 20_000, 3)
    assert.equal(third.code, 1)
    assert.deepEqual(third.sleeps, [30_000])
    assert.equal(third.hb.calls[0]!.body.env.watcherHealth.status, 'crash_loop')
    assert.equal(third.hb.calls[0]!.body.env.watcherHealth.bootsLastHour, 3)
    assert.equal(JSON.parse(readFileSync(join(box.bundle, 'boots.json'), 'utf8'))[2].backoffMs, 30_000)
    assert.deepEqual((await start(T0 + 70_000, 4)).sleeps, [60_000])
    // The same file, read by the real verdict, agrees.
    const verdict = health.crashLoopVerdict({ boots: health.readBoots(box.home), lastPollOkAtMs: null, now: T0 + 70_000 })
    assert.equal(verdict.backoffMs, 120_000, 'the next start would double again')
  } finally {
    box.cleanup()
  }
})

test('the fallback and the entry restate watcher-health and watcher-service, and they agree', () => {
  assert.deepEqual(
    { ...FALLBACK_GUARD },
    {
      BOOTS_RING_SIZE: health.BOOTS_RING_SIZE,
      CRASH_LOOP_WINDOW_MS: health.CRASH_LOOP_WINDOW_MS,
      CRASH_LOOP_MIN_BOOTS: health.CRASH_LOOP_MIN_BOOTS,
      CRASH_BACKOFF_MIN_MS: health.CRASH_BACKOFF_MIN_MS,
      CRASH_BACKOFF_MAX_MS: health.CRASH_BACKOFF_MAX_MS,
      HEALTH_STRING_MAX: health.HEALTH_STRING_MAX,
      CRASH_MESSAGE_MAX: health.CRASH_MESSAGE_MAX,
      FATAL_HEARTBEAT_TIMEOUT_MS: health.FATAL_HEARTBEAT_TIMEOUT_MS,
      EXIT_FATAL: health.EXIT_FATAL,
    },
  )
  assert.equal(HIDDEN_LAUNCHER_FILE, WATCHER_HIDDEN_LAUNCHER_FILE)
  const samples = [
    `Cannot find module '/Users/kc/.bgos-agent/watcher/lib/x.mjs' token ${TOKEN} X-BGOS-Pairing: abc123456 user kc`,
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 sk-abcdefghijklmnopqrstuvwxyz password=hunter2hunter2',
    'C:\\Users\\kc\\x and c:/Users/kc/y',
  ]
  for (const sample of samples) {
    for (const opts of [{ home: '/Users/kc', username: 'kc', secrets: [TOKEN] }, { home: 'C:\\Users\\kc', username: 'kc', secrets: [] }]) {
      assert.equal(scrubText(sample, opts), health.scrubFatal(sample, opts), sample)
    }
  }
})

// -- B2 pieces ------------------------------------------------------------------------------------------

test('missingBundleModule: only a module missing INSIDE the bundle dir is a bundle to repair', () => {
  const bundle = '/home/kc/.bgos-agent/watcher'
  const missing = (path: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(`Cannot find module '${path}' imported from ${bundle}/lib/watcher-core.mjs`), { code: 'ERR_MODULE_NOT_FOUND', url: pathToFileURL(path).href, ...extra })
  assert.equal(missingBundleModule(missing(`${bundle}/lib/win32-script-text.mjs`), bundle), 'lib/win32-script-text.mjs')
  assert.equal(missingBundleModule(missing(`${bundle}/lib/x.mjs`, { url: undefined, code: undefined }), bundle), 'lib/x.mjs', 'the message alone is enough')
  assert.equal(missingBundleModule(missing('/somewhere/else/lib/x.mjs'), bundle), null, 'outside the bundle')
  assert.equal(missingBundleModule(missing(`${bundle}-other/lib/x.mjs`), bundle), null, 'a sibling dir with the same prefix')
  assert.equal(missingBundleModule(Object.assign(new Error("Cannot find package 'zod' imported from x"), { code: 'ERR_MODULE_NOT_FOUND' }), bundle), null)
  assert.equal(missingBundleModule(new Error('boom'), bundle), null)
  assert.equal(missingBundleModule(null, bundle), null)
})

test('restartAfterRepair: posix exits 75; win32 starts the successor through run-hidden.vbs and exits 0, else 75', () => {
  const spawns: Array<{ file: string; args: string[] }> = []
  const spawnDetached = (file: string, args: string[]) => {
    spawns.push({ file, args })
    return { pid: 1 }
  }
  assert.equal(restartAfterRepair({ platform: 'darwin', bundleDir: '/b', spawnDetached, exists: () => true }), 75)
  assert.equal(restartAfterRepair({ platform: 'linux', bundleDir: '/b', spawnDetached, exists: () => true }), 75)
  assert.deepEqual(spawns, [])
  assert.equal(restartAfterRepair({ platform: 'win32', bundleDir: '/b', spawnDetached, exists: (p: string) => p === join('/b', 'run-hidden.vbs') }), 0)
  assert.deepEqual(spawns, [{ file: 'wscript.exe', args: ['//B', join('/b', 'run-hidden.vbs')] }])
  assert.equal(restartAfterRepair({ platform: 'win32', bundleDir: '/b', spawnDetached, exists: () => false }), 75)
  const throwing = () => {
    throw new Error('ENOENT wscript')
  }
  assert.equal(restartAfterRepair({ platform: 'win32', bundleDir: '/b', spawnDetached: throwing, exists: () => true }), 75)
})

/** A temp bundle whose watcher-core imports a sibling it does not carry, loaded for real. */
function brokenBundle() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-watcher-main-')))
  const home = join(root, 'home')
  const bundle = join(home, '.bgos-agent', 'watcher')
  mkdirSync(join(bundle, 'lib'), { recursive: true })
  writeFileSync(join(bundle, 'lib', 'watcher-core.mjs'), "import { psString } from './win32-script-text.mjs'\nexport const runWatcher = () => psString\n")
  writeFileSync(join(bundle, 'manifest.json'), JSON.stringify({ version: '0.62.0', fingerprint: 'f', pluginRoot: '/x', files: [] }))
  writeFileSync(join(bundle, 'credentials.json'), JSON.stringify({ pairingId: 77, token: TOKEN, backendUrl: 'https://api.example.test', machineId: 'm-1' }))
  const load = () => import(pathToFileURL(join(bundle, 'lib', 'watcher-core.mjs')).href)
  return { root, home, bundle, load, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function fakeRepair(result: Record<string, unknown>) {
  const calls: unknown[] = []
  const loadRepairModule = async () => ({
    repairWatcherBundle: (args: unknown) => {
      calls.push(args)
      return { pluginRoot: '/x', copied: ['lib/win32-script-text.mjs'], ...result }
    },
  })
  return { calls, loadRepairModule }
}

test('main run: a module missing inside the bundle is repaired through the guard: crash.json, no heartbeat, no wait, exit 75 (posix) or a win32 successor and 0', async () => {
  for (const platform of ['linux', 'win32'] as const) {
    const box = brokenBundle()
    try {
      writeFileSync(join(box.bundle, 'run-hidden.vbs'), "' launcher")
      const hb = recordingFetch()
      const repair = fakeRepair({ repaired: true, reason: 'repaired' })
      const spawns: unknown[][] = []
      const sleeps: number[] = []
      const errs: string[] = []
      const code = await main(['run'], {
        home: box.home,
        bundleDir: box.bundle,
        env: {},
        platform,
        loadModules: box.load,
        loadRepairModule: repair.loadRepairModule,
        spawnDetached: (...args: unknown[]) => void spawns.push(args),
        fetch: hb.fetch as any,
        now: () => T0,
        sleep: async (ms: number) => void sleeps.push(ms),
        err: (l: string) => void errs.push(l),
        out: () => {},
      } as any)
      assert.equal(code, platform === 'win32' ? 0 : 75, platform)
      assert.equal(spawns.length, platform === 'win32' ? 1 : 0, platform)
      assert.equal(repair.calls.length, 1)
      assert.equal(hb.calls.length, 0, 'a repaired start sends no crash heartbeat: the repaired bundle reports for itself')
      assert.deepEqual(sleeps, [])
      assert.match(JSON.parse(readFileSync(join(box.bundle, 'crash.json'), 'utf8')).message, /win32-script-text/)
      assert.ok(errs.some((l) => l.includes('bundle repaired: lib/win32-script-text.mjs was missing')), errs.join('\n'))
    } finally {
      box.cleanup()
    }
  }
})

test('main run: no repair possible (plugin root gone) is the plain guarded crash: the reason on the fatal line, the heartbeat sent', async () => {
  const box = brokenBundle()
  try {
    const hb = recordingFetch()
    const repair = fakeRepair({ repaired: false, reason: 'plugin_root_missing', copied: [] })
    const errs: string[] = []
    const code = await main(['run'], { home: box.home, bundleDir: box.bundle, env: {}, platform: 'linux', loadModules: box.load, loadRepairModule: repair.loadRepairModule, fetch: hb.fetch as any, now: () => T0, sleep: async () => {}, err: (l: string) => void errs.push(l), out: () => {} } as any)
    assert.equal(code, 1)
    assert.equal(hb.calls.length, 1)
    assert.ok(errs.some((l) => /fatal before the loop: .*; bundle repair skipped: the plugin root \/x is missing/.test(l)), errs.join('\n'))
  } finally {
    box.cleanup()
  }
})

test('main run: when the guard module itself does not load, the fallback guard repairs first, and reports when it cannot', async () => {
  const box = brokenBundle()
  try {
    const missingHealth = Object.assign(new Error(`Cannot find module '${join(box.bundle, 'lib', 'watcher-health.mjs')}'`), {
      code: 'ERR_MODULE_NOT_FOUND',
      url: pathToFileURL(join(box.bundle, 'lib', 'watcher-health.mjs')).href,
    })
    const loadHealth = async () => {
      throw missingHealth
    }
    const repaired = fakeRepair({ repaired: true, reason: 'repaired' })
    const hb = recordingFetch()
    const code = await main(['run'], { home: box.home, bundleDir: box.bundle, env: {}, platform: 'darwin', loadHealth, loadRepairModule: repaired.loadRepairModule, fetch: hb.fetch as any, now: () => T0, sleep: async () => {}, err: () => {}, out: () => {} } as any)
    assert.equal(code, 75)
    assert.equal(hb.calls.length, 0)
    assert.match(readFileSync(join(box.bundle, 'logs', 'watcher.log'), 'utf8'), /the crash guard module did not load either\): .*watcher-health\.mjs.*; bundle repaired/)
    const none = fakeRepair({ repaired: false, reason: 'rate_limited', lastAttemptAt: 'then', copied: [] })
    const code2 = await main(['run'], { home: box.home, bundleDir: box.bundle, env: {}, platform: 'darwin', loadHealth, loadRepairModule: none.loadRepairModule, fetch: hb.fetch as any, now: () => T0 + 1000, sleep: async () => {}, err: () => {}, out: () => {} } as any)
    assert.equal(code2, 1)
    assert.equal(hb.calls.length, 1, 'the minimal heartbeat goes out from the fallback')
    assert.equal(hb.calls[0]!.body.env.watcherHealth.lastFatal.message.includes('watcher-health.mjs'), true)
  } finally {
    box.cleanup()
  }
})

test('main help: a repaired bundle runs the command again once, with repair switched off; HOAI_WATCHER_NO_REPAIR stops the repair altogether', async () => {
  const box = brokenBundle()
  try {
    const repair = fakeRepair({ repaired: true, reason: 'repaired' })
    const reruns: any[] = []
    const errs: string[] = []
    const code = await main(['help'], {
      home: box.home,
      bundleDir: box.bundle,
      env: { PATH: '/bin' },
      loadModules: box.load,
      loadRepairModule: repair.loadRepairModule,
      rerun: (input: any) => {
        reruns.push(input)
        return 0
      },
      err: (l: string) => void errs.push(l),
      out: () => {},
    } as any)
    assert.equal(code, 0, 'the re-run answers: a repaired bundle passes the staged-bundle probe')
    assert.equal(reruns.length, 1)
    assert.deepEqual(reruns[0].argv, ['help'])
    assert.equal(reruns[0].command, 'help')
    assert.ok(errs.some((l) => l.includes('running the command again')))
    const off = fakeRepair({ repaired: true, reason: 'repaired' })
    const code2 = await main(['help'], { home: box.home, bundleDir: box.bundle, env: { [NO_REPAIR_ENV]: '1' }, loadModules: box.load, loadRepairModule: off.loadRepairModule, rerun: () => 0, err: () => {}, out: () => {} } as any)
    assert.equal(code2, 1)
    assert.equal(off.calls.length, 0)
  } finally {
    box.cleanup()
  }
})

// -- repairWatcherBundle, on real files -----------------------------------------------------------------

function repairFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-watcher-repairfn-')))
  const plugin = join(root, 'plugin')
  const bundle = join(root, 'home', '.bgos-agent', 'watcher')
  const fs = nodeFs()
  for (const rel of WATCHER_BUNDLE_FILES) fs.writeFile(join(plugin, rel), `// ${rel}\n`)
  fs.writeFile(join(plugin, 'package.json'), '{"version":"0.62.1"}')
  fs.writeFile(join(plugin, 'bin', 'hoai-watcher.mjs'), "export const go = () => import('../lib/watcher-core.mjs')\n")
  fs.writeFile(join(plugin, 'lib', 'watcher-core.mjs'), "import { thing } from './new-thing.mjs'\nimport './watcher-health.mjs'\nexport { thing }\n")
  fs.writeFile(join(plugin, 'lib', 'new-thing.mjs'), 'export const thing = 1\n')
  // The bundle an older installer made: the entry and watcher-core only, watcher-health STALE.
  for (const rel of ['bin/hoai-watcher.mjs', 'lib/watcher-core.mjs']) fs.copyFile(join(plugin, rel), join(bundle, rel))
  fs.writeFile(join(bundle, 'lib', 'watcher-health.mjs'), '// an older watcher-health\n')
  fs.writeFile(
    join(bundle, 'manifest.json'),
    JSON.stringify({ version: '0.62.0', fingerprint: 'old', installedAt: 'x', pluginRoot: plugin, claudeConfigDir: '/cfg', files: ['bin/hoai-watcher.mjs', 'lib/watcher-core.mjs', 'lib/watcher-health.mjs'] }),
  )
  return { root, plugin, bundle, fs, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('repairWatcherBundle: copies what is missing or changed from the root closure, rewrites the manifest, records the attempt, logs it', () => {
  const fx = repairFixture()
  try {
    const logs: string[] = []
    const result = repairWatcherBundle({ bundleDir: fx.bundle, now: () => T0, log: (l: string) => void logs.push(l) })
    assert.equal(result.repaired, true, result.reason)
    assert.deepEqual([...result.copied].sort(), ['lib/new-thing.mjs', 'lib/watcher-health.mjs'], 'missing AND changed; identical files are left alone')
    assert.equal(readFileSync(join(fx.bundle, 'lib', 'watcher-health.mjs'), 'utf8'), '// lib/watcher-health.mjs\n')
    const manifest = JSON.parse(readFileSync(join(fx.bundle, 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.files, ['bin/hoai-watcher.mjs', 'lib/watcher-core.mjs', 'lib/watcher-health.mjs', 'lib/new-thing.mjs'])
    assert.equal(manifest.fingerprint, bundleFingerprint(fx.plugin), 'the next refresh sees the bundle as current')
    assert.equal(manifest.version, '0.62.1')
    assert.equal(manifest.claudeConfigDir, '/cfg', 'every other field is kept')
    assert.equal(manifest.repairedAt, new Date(T0).toISOString())
    const state = JSON.parse(readFileSync(join(fx.bundle, 'state.json'), 'utf8'))
    assert.equal(state.bundleRepair.outcome, 'repaired')
    assert.equal(state.bundleRepair.at, new Date(T0).toISOString())
    assert.equal(logs.length, 1)
    assert.match(logs[0]!, /^bundle repair: copied 2 file\(s\) from /)
  } finally {
    fx.cleanup()
  }
})

test('repairWatcherBundle: bounded to one attempt per 10 minutes, whatever the outcome', () => {
  const fx = repairFixture()
  try {
    writeFileSync(join(fx.bundle, 'state.json'), JSON.stringify({ lastPollOkAt: 'kept', bundleRepair: { at: new Date(T0).toISOString(), outcome: 'started' } }))
    const early = repairWatcherBundle({ bundleDir: fx.bundle, now: () => T0 + BUNDLE_REPAIR_INTERVAL_MS - 1 })
    assert.equal(early.repaired, false)
    assert.equal(early.reason, 'rate_limited')
    assert.equal(early.lastAttemptAt, new Date(T0).toISOString())
    assert.equal(existsSync(join(fx.bundle, 'lib', 'new-thing.mjs')), false)
    const due = repairWatcherBundle({ bundleDir: fx.bundle, now: () => T0 + BUNDLE_REPAIR_INTERVAL_MS })
    assert.equal(due.repaired, true)
    assert.equal(JSON.parse(readFileSync(join(fx.bundle, 'state.json'), 'utf8')).lastPollOkAt, 'kept', 'the rest of state.json is kept')
    assert.equal(BUNDLE_REPAIR_INTERVAL_MS, 10 * 60_000)
  } finally {
    fx.cleanup()
  }
})

test('repairWatcherBundle: never with the plugin root gone, a closure that does not resolve, no manifest, or a root that is the bundle itself', () => {
  const fx = repairFixture()
  try {
    // The root's own code imports a file it does not ship: no copy at all, the attempt recorded.
    rmSync(join(fx.plugin, 'lib', 'new-thing.mjs'))
    const walk = repairWatcherBundle({ bundleDir: fx.bundle, now: () => T0 })
    assert.equal(walk.repaired, false)
    assert.equal(walk.reason, 'closure_walk_failed: lib/new-thing.mjs (imported by lib/watcher-core.mjs)')
    assert.equal(readFileSync(join(fx.bundle, 'lib', 'watcher-health.mjs'), 'utf8'), '// an older watcher-health\n', 'nothing copied')
    assert.equal(JSON.parse(readFileSync(join(fx.bundle, 'state.json'), 'utf8')).bundleRepair.outcome, 'closure_walk_failed')
    rmSync(join(fx.bundle, 'state.json'))
    // The plugin root is gone: not even an attempt.
    rmSync(fx.plugin, { recursive: true, force: true })
    const gone = repairWatcherBundle({ bundleDir: fx.bundle, now: () => T0 })
    assert.deepEqual({ repaired: gone.repaired, reason: gone.reason }, { repaired: false, reason: 'plugin_root_missing' })
    assert.equal(existsSync(join(fx.bundle, 'state.json')), false)
    // A checkout running its own entry: the manifest names the bundle dir itself.
    writeFileSync(join(fx.bundle, 'manifest.json'), JSON.stringify({ version: '0.62.0', fingerprint: 'f', pluginRoot: `${fx.bundle}/`, files: [] }))
    assert.equal(repairWatcherBundle({ bundleDir: fx.bundle, now: () => T0 }).reason, 'plugin_root_is_the_bundle')
    rmSync(join(fx.bundle, 'manifest.json'))
    assert.equal(repairWatcherBundle({ bundleDir: fx.bundle, now: () => T0 }).reason, 'no_manifest')
  } finally {
    fx.cleanup()
  }
})

test('repairWatcherBundle: a bundle that already matches its root has nothing to repair (a plain crash, reported as one)', () => {
  const fx = repairFixture()
  try {
    assert.equal(repairWatcherBundle({ bundleDir: fx.bundle, now: () => T0 }).repaired, true)
    const again = repairWatcherBundle({ bundleDir: fx.bundle, now: () => T0 + BUNDLE_REPAIR_INTERVAL_MS })
    assert.deepEqual({ repaired: again.repaired, reason: again.reason }, { repaired: false, reason: 'nothing_to_repair' })
    assert.equal(JSON.parse(readFileSync(join(fx.bundle, 'state.json'), 'utf8')).bundleRepair.outcome, 'nothing_to_repair')
  } finally {
    fx.cleanup()
  }
})
