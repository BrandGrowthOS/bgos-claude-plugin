/**
 * The watcher reaches the installed plugin's bundle by itself (board row 0c659c85).
 *
 * Up to 0.65.3 the watcher refreshed its own bundle only inside a reconcile job
 * (lib/watcher-core.mjs runReconcileJob), and its manifest names the versioned
 * cache folder it was copied from, which a marketplace update leaves on disk
 * unchanged. On a computer nobody sent a job to (AlienAres, Windows 11) the
 * watcher ran 0.61.1 from 2026-10-05 while the plugin moved to 0.63.2, so it
 * never had the supervisor arm 0.62.0 added, and its heartbeat said nothing.
 *
 * These tests run the real loop (runWatcher) over an in-memory home with a real
 * installed_plugins.json, read by the real lib/plugin-cli.mjs
 * observeMarketplaceInstall, and the real bundle installer. No job is ever sent
 * unless a test says so.
 *
 * The window and process layer is always a fake (test/helpers/fake-window-host.ts, through the
 * harness): a refresh that does not end the loop goes on to the windows pass, which on win32 lists
 * every process and closes every HOAI viewer it lists while Show agent windows is off. The sentinel,
 * imported first, refuses any real listing, signal or launch that still gets through, so this file
 * is safe to run on the owner's own computer (board row afa70b0c, test/watcher-real-os.guard.test.ts).
 *
 * Run: npx tsx --test test/watcher-self-refresh.test.ts
 */

import './helpers/real-os-sentinel.ts'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EXIT_SELF_REFRESH, refreshWatcherIfStale } from '../lib/watcher-core.mjs'
import { SWAPPABLE_ENTRIES, WATCHER_BUNDLE_FILES, installWatcherBundle, readBundleManifest, watcherImportClosure } from '../lib/watcher-bundle.mjs'
import { memoryFs } from './helpers/memory-fs.ts'
import {
  MACHINE_ID,
  MINUTE,
  POSIX,
  T0,
  TOKEN,
  WINDOWS,
  at,
  cacheRoot,
  configDir,
  fakeBackend,
  liveEntry,
  probesOf,
  realFilesRun,
  staleMachine,
  stagedEntry,
  stateOf,
  watcherDir,
  watcherRun,
  writeCgroup,
  writeInstalled,
  writeRoot,
} from './helpers/watcher-self-refresh-harness.ts'

// -- the bug -----------------------------------------------------------------------------------

test('a watcher whose manifest names an old versioned cache folder reaches the newer install with no job (posix and win32)', async () => {
  for (const L of [POSIX, WINDOWS]) {
    const { fs, newRoot } = await staleMachine(L)
    const before = new Map(fs.files)
    const w = watcherRun(L, fs)
    const code = await w.run()

    assert.equal(fs.readFile(liveEntry(L)), '// bin/hoai-watcher.mjs 0.63.2\n', `${L.name}: the live bundle is the installed plugin's`)
    const manifest = readBundleManifest(L.home, fs)!
    assert.equal(manifest.version, '0.63.2', L.name)
    assert.equal(manifest.pluginRoot, newRoot, L.name)
    // The same staged swap as a job: the staged copy was probed under the service's node first.
    assert.deepEqual(probesOf(w.execs), [{ file: L.node, args: [stagedEntry(L), 'help'] }], L.name)
    if (L.platform === 'win32') {
      assert.equal(code, 0, L.name)
      assert.deepEqual(w.spawns, [{ file: 'wscript.exe', args: ['//B', at(L, watcherDir(L), 'run-hidden.vbs')] }], L.name)
    } else {
      assert.equal(code, EXIT_SELF_REFRESH, L.name)
      assert.deepEqual(w.spawns, [], L.name)
    }
    // No job: nothing was acked, fetched or reported for one.
    assert.equal(w.backend.calls.some((c) => c.path.includes('/machine-rpc/') && !c.path.includes('/pending')), false, L.name)
    // Nothing outside the watcher's own folder was written or removed.
    const inWatcher = (key: string) => key.startsWith(watcherDir(L) + L.sep)
    for (const [key, text] of before) if (!inWatcher(key)) assert.equal(fs.files.get(key), text, `${L.name}: ${key} changed`)
    for (const key of fs.files.keys()) if (!inWatcher(key)) assert.equal(before.has(key), true, `${L.name}: ${key} written`)
  }
})

test('the heartbeat names the running bundle, the installed plugin and whether the bundle is stale', async () => {
  const { fs } = await staleMachine(POSIX)
  const w = watcherRun(POSIX, fs)
  await w.run()
  const beat = w.backend.beats()[0]!
  assert.equal(beat.daemonVersion, '0.61.1')
  assert.deepEqual(beat.env.watcherHealth.bundle, { bundleVersion: '0.61.1', installedVersion: '0.63.2', stale: true })
})

test('the refreshed watcher stays put: its successor reads the bundle as current, swaps nothing and reports when it refreshed', async () => {
  const { fs } = await staleMachine(POSIX)
  assert.equal(await watcherRun(POSIX, fs).run(), EXIT_SELF_REFRESH)
  // An installer a release older than the root hashes a different file list, so the fingerprint it
  // records need not be the one this code computes. The files are what count.
  const manifestPath = at(POSIX, watcherDir(POSIX), 'manifest.json')
  fs.writeFile(manifestPath, JSON.stringify({ ...JSON.parse(fs.readFile(manifestPath)!), fingerprint: 'computed-by-an-older-installer' }))
  for (const after of [1, 30, 120]) {
    const successor = watcherRun(POSIX, fs, { now: T0 + after * MINUTE })
    assert.equal(await successor.run(), 0, `${after} min`)
    assert.deepEqual(probesOf(successor.execs), [], `${after} min: no second probe`)
    assert.equal(fs.readFile(liveEntry(POSIX)), '// bin/hoai-watcher.mjs 0.63.2\n')
    assert.deepEqual(successor.backend.beats()[0]!.env.watcherHealth.bundle, {
      bundleVersion: '0.63.2',
      installedVersion: '0.63.2',
      stale: false,
      lastRefresh: { at: new Date(T0).toISOString(), outcome: 'watcher_bundle_refreshed:0.63.2' },
    })
  }
})

test('a job in flight is never interrupted: the heartbeat inside it reports the stale bundle and nothing is swapped until it ends', async () => {
  const L = POSIX
  const fs = memoryFs()
  const oldRoot = cacheRoot(L, '0.61.1')
  writeRoot(fs, L, oldRoot, '0.61.1')
  await installWatcherBundle({ pluginRoot: oldRoot, home: L.home, fs, now: () => T0 })
  writeInstalled(fs, L, oldRoot, '0.61.1')
  fs.writeFile(at(L, watcherDir(L), 'credentials.json'), JSON.stringify({ pairingId: 77, token: TOKEN, backendUrl: 'https://api.example.test', machineId: MACHINE_ID }))
  const newRoot = cacheRoot(L, '0.63.2')
  const backend = fakeBackend({ frames: [{ rpcId: 'j', op: 'reconcile' }], jobs: { j: { op: 'update', intent: 'update', targets: [] } } })
  const seenInJob: { entry: string | null; beats: number; probes: number; staleInBeat: unknown } = { entry: null, beats: 0, probes: 0, staleInBeat: null }
  let w: ReturnType<typeof watcherRun>
  w = watcherRun(L, fs, {
    backend,
    modules: {
      planMachine: () => ({ verdict: 'plan', targetVersion: '0.63.2', steps: [{ id: 's01-update_plugin', kind: 'update_plugin', onFailure: 'escalate', why: 'x' }] }),
      // The plugin moves while the job runs, and the job outlives a heartbeat interval.
      executePlan: async (_plan: any, deps: any, report: any) => {
        writeRoot(fs, L, newRoot, '0.63.2')
        writeInstalled(fs, L, newRoot, '0.63.2')
        await deps.sleep(2 * MINUTE)
        await report('s01-update_plugin', { state: 'ok', message: 'updated' })
        seenInJob.entry = fs.readFile(liveEntry(L))
        seenInJob.beats = backend.beats().length
        seenInJob.probes = probesOf(w.execs).length
        seenInJob.staleInBeat = backend.beats().at(-1)?.env?.watcherHealth?.bundle?.stale
        return { ok: true, verdict: 'done', failedStep: null, rolledBack: false, targetVersion: '0.63.2', installedVersion: '0.63.2', steps: [{ id: 's01-update_plugin', kind: 'update_plugin', state: 'ok', message: 'updated' }] }
      },
    },
  })
  await w.run()
  assert.equal(seenInJob.beats, 2, 'a heartbeat went out inside the job')
  assert.equal(seenInJob.staleInBeat, true, 'and it said the bundle is stale')
  assert.equal(seenInJob.entry, '// bin/hoai-watcher.mjs 0.61.1\n', 'the bundle was not swapped inside the job')
  assert.equal(seenInJob.probes, 0, 'no staged bundle was even probed inside the job')
  // The job reached its own end and reported it.
  const progress = backend.calls.filter((c) => c.path.endsWith('/machine-rpc/j/progress')).map((c) => c.body.state)
  assert.equal(progress.at(-1), 'done')
})

test('a staged bundle that does not load keeps the old one, is reported, and is not retried for an hour, even across a restart', async () => {
  const { fs } = await staleMachine(POSIX)
  const first = watcherRun(POSIX, fs, { probeCode: 1 })
  assert.equal(await first.run(), 0, 'the watcher goes on (it polls)')
  assert.equal(fs.readFile(liveEntry(POSIX)), '// bin/hoai-watcher.mjs 0.61.1\n')
  assert.equal(readBundleManifest(POSIX.home, fs)!.version, '0.61.1')
  assert.equal([...fs.files.keys()].some((k) => k.includes('/watcher/next/')), false, 'staging cleared')
  assert.equal(probesOf(first.execs).length, 1)
  assert.equal(first.logs.some((l) => l.includes('does not load')), true)
  assert.deepEqual(stateOf(POSIX, fs).bundleRefresh?.outcome, 'watcher_refresh_failed:staged_bundle_unloadable')

  const restarted = watcherRun(POSIX, fs, { now: T0 + 30 * MINUTE, probeCode: 1 })
  assert.equal(await restarted.run(), 0)
  assert.equal(probesOf(restarted.execs).length, 0, 'not retried inside the hour')
  assert.deepEqual(restarted.backend.beats()[0]!.env.watcherHealth.bundle, {
    bundleVersion: '0.61.1',
    installedVersion: '0.63.2',
    stale: true,
    lastRefresh: { at: new Date(T0).toISOString(), outcome: 'watcher_refresh_failed:staged_bundle_unloadable' },
  })

  const later = watcherRun(POSIX, fs, { now: T0 + 61 * MINUTE })
  assert.equal(await later.run(), EXIT_SELF_REFRESH, 'retried after the hour, and this time it loads')
  assert.equal(fs.readFile(liveEntry(POSIX)), '// bin/hoai-watcher.mjs 0.63.2\n')
})

test('after a refresh the next one waits ten minutes (no restart loop), and a later plugin update is still followed', async () => {
  const L = POSIX
  const { fs } = await staleMachine(L)
  assert.equal(await watcherRun(L, fs).run(), EXIT_SELF_REFRESH)
  // The plugin updates again a minute later.
  const newest = cacheRoot(L, '0.64.0')
  writeRoot(fs, L, newest, '0.64.0')
  writeInstalled(fs, L, newest, '0.64.0')
  const soon = watcherRun(L, fs, { now: T0 + 2 * MINUTE })
  assert.equal(await soon.run(), 0)
  assert.deepEqual(probesOf(soon.execs), [])
  assert.equal(soon.backend.beats()[0]!.env.watcherHealth.bundle.stale, true)
  const after = watcherRun(L, fs, { now: T0 + 11 * MINUTE })
  assert.equal(await after.run(), EXIT_SELF_REFRESH)
  assert.equal(fs.readFile(liveEntry(L)), '// bin/hoai-watcher.mjs 0.64.0\n')
})

test("a swap keeps the agents' Claude config dir in the manifest (the service env does not carry it)", async () => {
  const L = POSIX
  const custom = '/srv/claude-kc'
  const { fs, newRoot } = await staleMachine(L, { claudeConfigDir: custom })
  const exec = async () => ({ code: 0, stdout: '', stderr: '', error: null, timedOut: false })
  const out = await refreshWatcherIfStale({ home: L.home, fs, now: () => T0, manifest: readBundleManifest(L.home, fs), pluginRoot: newRoot, exec, nodePath: L.node })
  assert.equal(out.ok, true)
  assert.equal(readBundleManifest(L.home, fs)!.version, '0.63.2')
  assert.equal(readBundleManifest(L.home, fs)!.claudeConfigDir, custom)
})

test('the watcher finds the install under a custom Claude config dir by itself', async () => {
  const L = POSIX
  const { fs, newRoot } = await staleMachine(L, { claudeConfigDir: '/srv/claude-kc' })
  assert.equal(await watcherRun(L, fs).run(), EXIT_SELF_REFRESH)
  assert.equal(readBundleManifest(L.home, fs)!.pluginRoot, newRoot)
})

test('never an automatic downgrade, and never on Windows without the launcher a successor needs', async () => {
  const older = await staleMachine(POSIX, { installed: '0.60.9' })
  const w = watcherRun(POSIX, older.fs)
  assert.equal(await w.run(), 0)
  assert.equal(older.fs.readFile(liveEntry(POSIX)), '// bin/hoai-watcher.mjs 0.61.1\n')
  assert.deepEqual(probesOf(w.execs), [])
  assert.equal(stateOf(POSIX, older.fs).bundleRefresh?.outcome, 'refused:installed_older')

  const noVbs = await staleMachine(WINDOWS, { vbs: false })
  const v = watcherRun(WINDOWS, noVbs.fs)
  assert.equal(await v.run(), 0)
  assert.equal(noVbs.fs.readFile(liveEntry(WINDOWS)), '// bin/hoai-watcher.mjs 0.61.1\n')
  assert.deepEqual(v.spawns, [])
  assert.equal(stateOf(WINDOWS, noVbs.fs).bundleRefresh?.outcome, 'refused:no_successor_launcher')
})

test('without a manifest (a checkout running its own entry) nothing is swapped and staleness is unknown, not claimed', async () => {
  const { fs } = await staleMachine(POSIX)
  fs.rm(at(POSIX, watcherDir(POSIX), 'manifest.json'))
  const w = watcherRun(POSIX, fs)
  assert.equal(await w.run(), 0)
  assert.deepEqual(probesOf(w.execs), [])
  assert.deepEqual(w.backend.beats()[0]!.env.watcherHealth.bundle, { bundleVersion: null, installedVersion: null, stale: null, reason: 'no_manifest' })
})

// -- review findings ---------------------------------------------------------------------------

test('a manifest that lost claudeConfigDir (a job swap before 0.65.4 dropped it) still finds its install, and the swap writes the dir back', async () => {
  const L = POSIX
  const custom = '/srv/claude-kc'
  const { fs, newRoot } = await staleMachine(L, { claudeConfigDir: custom })
  const manifestPath = at(L, watcherDir(L), 'manifest.json')
  fs.writeFile(manifestPath, JSON.stringify({ ...JSON.parse(fs.readFile(manifestPath)!), claudeConfigDir: null }))
  const w = watcherRun(L, fs)
  assert.equal(await w.run(), EXIT_SELF_REFRESH)
  assert.equal(readBundleManifest(L.home, fs)!.pluginRoot, newRoot)
  assert.equal(readBundleManifest(L.home, fs)!.claudeConfigDir, custom)
})

test('a release that no longer ships a file the running code lists is still followed, and then reads current', async () => {
  const L = POSIX
  const { fs, newRoot } = await staleMachine(L)
  fs.rm(at(L, newRoot, 'lib', 'known-good-store.mjs'))
  assert.equal(await watcherRun(L, fs).run(), EXIT_SELF_REFRESH)
  assert.equal(fs.readFile(liveEntry(L)), '// bin/hoai-watcher.mjs 0.63.2\n')
  const successor = watcherRun(L, fs, { now: T0 + 30 * MINUTE })
  assert.equal(await successor.run(), 0)
  assert.deepEqual(probesOf(successor.execs), [])
  assert.equal(successor.backend.beats()[0]!.env.watcherHealth.bundle.stale, false)
})

test('Linux: no self restart while anything else shares the watcher cgroup (systemd would kill it on exit), nor when the cgroup cannot be read', async () => {
  for (const [cgroup, outcome] of [
    [[process.pid, 4242], 'refused:cgroup_shared:1'],
    [null, 'refused:cgroup_unreadable'],
  ] as const) {
    const { fs } = await staleMachine(POSIX, { cgroup: cgroup as number[] | null })
    const w = watcherRun(POSIX, fs)
    assert.equal(await w.run(), 0, outcome)
    assert.equal(fs.readFile(liveEntry(POSIX)), '// bin/hoai-watcher.mjs 0.61.1\n', outcome)
    assert.deepEqual(probesOf(w.execs), [], outcome)
    assert.equal(stateOf(POSIX, fs).bundleRefresh?.outcome, outcome)
  }
})

test('a target that a swap already reached is never swapped to again, so a swap that leaves the bundle reading stale cannot loop', async () => {
  const L = POSIX
  const { fs, newRoot } = await staleMachine(L)
  // Two things at once make a swap that cannot settle: the release dropped a listed file, so the
  // manifest's fingerprint is not the checker's, and the new entry imports a file outside bin/ and
  // lib/, which is staged but never promoted (a swap moves bin/, lib/ and the manifest), so the live
  // bundle still differs from the install afterwards.
  fs.rm(at(L, newRoot, 'lib', 'known-good-store.mjs'))
  fs.writeFile(at(L, newRoot, 'bin', 'hoai-watcher.mjs'), "import '../extra/x.mjs'\n// bin/hoai-watcher.mjs 0.63.2\n")
  fs.writeFile(at(L, newRoot, 'extra', 'x.mjs'), '// extra\n')
  assert.equal(await watcherRun(L, fs).run(), EXIT_SELF_REFRESH)
  for (const after of [11, 120, 24 * 60]) {
    const again = watcherRun(L, fs, { now: T0 + after * MINUTE })
    assert.equal(await again.run(), 0, `${after} min`)
    assert.deepEqual(probesOf(again.execs), [], `${after} min`)
    assert.equal(again.backend.beats()[0]!.env.watcherHealth.bundle.stale, true, `${after} min: still reported`)
  }
})

test('the stale flag is about the code this watcher RUNS: a bundle replaced under it reads stale until it restarts', async () => {
  const L = POSIX
  const fs = memoryFs()
  const oldRoot = cacheRoot(L, '0.61.1')
  writeRoot(fs, L, oldRoot, '0.61.1')
  await installWatcherBundle({ pluginRoot: oldRoot, home: L.home, fs, now: () => T0 })
  writeInstalled(fs, L, oldRoot, '0.61.1')
  fs.writeFile(at(L, watcherDir(L), 'credentials.json'), JSON.stringify({ pairingId: 77, token: TOKEN, backendUrl: 'https://api.example.test', machineId: MACHINE_ID }))
  writeCgroup(fs, [process.pid])
  const newRoot = cacheRoot(L, '0.63.2')
  const backend = fakeBackend({ frames: [{ rpcId: 'j', op: 'reconcile' }], jobs: { j: { op: 'reconcile', intent: 'reconcile', targets: [] } } })
  let staleInJob: unknown = null
  const w = watcherRun(L, fs, {
    backend,
    modules: {
      planMachine: () => ({ verdict: 'plan', targetVersion: '0.63.2', steps: [{ id: 's01-snapshot', kind: 'snapshot', onFailure: 'stop', why: 'x' }] }),
      executePlan: async (_plan: any, deps: any, report: any) => {
        // Someone installs the newer bundle over this running watcher's files (a hand run install).
        writeRoot(fs, L, newRoot, '0.63.2')
        writeInstalled(fs, L, newRoot, '0.63.2')
        await installWatcherBundle({ pluginRoot: newRoot, home: L.home, fs, now: () => T0 })
        await deps.sleep(2 * MINUTE)
        await report('s01-snapshot', { state: 'ok', message: 'x' })
        staleInJob = backend.beats().at(-1)?.env?.watcherHealth?.bundle?.stale
        return { ok: true, verdict: 'done', failedStep: null, rolledBack: false, targetVersion: '0.63.2', installedVersion: '0.63.2', steps: [{ id: 's01-snapshot', kind: 'snapshot', state: 'ok', message: 'x' }] }
      },
    },
  })
  await w.run()
  assert.equal(staleInJob, true)
})

test('refresh outcomes on the heartbeat and in state.json carry no home path', async () => {
  const L = POSIX
  const { fs, newRoot } = await staleMachine(L)
  // A root whose package.json has no version: the installer refuses and names the file.
  fs.writeFile(at(L, newRoot, 'package.json'), JSON.stringify({ name: 'claude-channel-bgos' }))
  assert.equal(await watcherRun(L, fs).run(), 0)
  const outcome = String(stateOf(L, fs).bundleRefresh?.outcome)
  assert.match(outcome, /^watcher_refresh_failed:/)
  assert.equal(outcome.includes(L.home), false, outcome)
  const next = watcherRun(L, fs, { now: T0 + 5 * MINUTE })
  await next.run()
  assert.equal(JSON.stringify(next.backend.beats()[0]!.env.watcherHealth.bundle).includes(L.home), false)
})

test('win32: when the successor did not start, this watcher stays up instead of leaving none', async () => {
  const { fs } = await staleMachine(WINDOWS)
  const w = watcherRun(WINDOWS, fs, { spawnPid: null })
  assert.equal(await w.run(), 0)
  assert.equal(w.logs.some((l) => l.includes('exiting with')), false)
  assert.equal(w.backend.calls.some((c) => c.path.includes('/machine-rpc/pending')), true, 'it went on polling')
  // Recorded as what happened, not as a refresh: the bundle on disk moved, the running code did not.
  assert.equal(stateOf(WINDOWS, fs).bundleRefresh?.outcome, 'watcher_bundle_refreshed:0.63.2:no_successor')
  assert.equal(stateOf(WINDOWS, fs).bundleRefresh?.ok, false)
})

test('an install the watcher cannot read as current is reported by reason: plugin not installed, install folder gone', async () => {
  const notInstalled = await staleMachine(POSIX)
  notInstalled.fs.writeFile(at(POSIX, configDir(POSIX), 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }))
  const a = watcherRun(POSIX, notInstalled.fs)
  await a.run()
  assert.deepEqual(a.backend.beats()[0]!.env.watcherHealth.bundle, { bundleVersion: '0.61.1', installedVersion: null, stale: null, reason: 'not_installed' })

  const gone = await staleMachine(POSIX)
  gone.fs.rm(gone.newRoot)
  const b = watcherRun(POSIX, gone.fs)
  assert.equal(await b.run(), 0)
  assert.deepEqual(b.backend.beats()[0]!.env.watcherHealth.bundle, { bundleVersion: '0.61.1', installedVersion: null, stale: null, reason: 'plugin_root_missing' })
  assert.deepEqual(probesOf(b.execs), [])
})

test('an incomplete install is never staged as the live bundle, and a refresh record from the future does not block for ever', async () => {
  const L = POSIX
  const { fs, newRoot } = await staleMachine(L)
  fs.writeFile(at(L, newRoot, 'bin', 'hoai-watcher.mjs'), "import '../lib/gone.mjs'\n// 0.63.2\n")
  const statePath = at(L, watcherDir(L), 'state.json')
  fs.writeFile(statePath, JSON.stringify({ bundleRefresh: { at: new Date(T0 + 3 * 60 * MINUTE).toISOString(), ok: false, fingerprint: 'x', outcome: 'from a clock that ran ahead' } }))
  const w = watcherRun(L, fs)
  assert.equal(await w.run(), 0)
  assert.equal(fs.readFile(liveEntry(L)), '// bin/hoai-watcher.mjs 0.61.1\n')
  assert.deepEqual(probesOf(w.execs), [], 'an incomplete copy is never probed')
  assert.match(String(stateOf(L, fs).bundleRefresh?.outcome), /^watcher_refresh_failed:bundle_incomplete:lib\/gone\.mjs/)
})

test('the real bundle of this checkout is staged, passes the real probe under this node, and is swapped in (real files)', async () => {
  const repo = dirname(dirname(fileURLToPath(import.meta.url)))
  const base = mkdtempSync(join(tmpdir(), 'watcher-self-refresh-'))
  try {
    const { code, platform, live, execs, spawns, host } = await realFilesRun(repo, base)
    assert.equal(code, platform === 'win32' ? 0 : EXIT_SELF_REFRESH)
    assert.deepEqual(execs, [[process.execPath, join(live, 'next', 'bin', 'hoai-watcher.mjs'), 'help']], 'the real probe ran once')
    assert.equal(readFileSync(join(live, 'bin', 'hoai-watcher.mjs'), 'utf8'), readFileSync(join(repo, 'bin', 'hoai-watcher.mjs'), 'utf8'))
    assert.equal(readFileSync(join(live, 'lib', 'watcher-core.mjs'), 'utf8'), readFileSync(join(repo, 'lib', 'watcher-core.mjs'), 'utf8'))
    assert.equal(JSON.parse(readFileSync(join(live, 'manifest.json'), 'utf8')).pluginRoot, repo)
    assert.deepEqual(spawns, platform === 'win32' ? ['wscript.exe'] : [])
    // A refresh that ends the loop never reaches its windows pass: nothing listed, nothing signalled.
    assert.deepEqual(host.listings, [])
    assert.deepEqual(host.kills, [])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('every file of the real bundle lives where a swap moves it (bin/ or lib/), so a swapped bundle is the whole bundle', () => {
  const repo = dirname(dirname(fileURLToPath(import.meta.url)))
  const walk = watcherImportClosure(repo)
  assert.equal(walk.ok, true)
  const dirs = SWAPPABLE_ENTRIES.filter((entry) => entry !== 'manifest.json')
  assert.deepEqual(dirs, ['bin', 'lib'])
  for (const rel of [...WATCHER_BUNDLE_FILES, ...walk.files]) assert.equal(dirs.includes(rel.split('/')[0]!), true, rel)
})

test('the reached-target guard holds only while the watcher runs what that swap installed: a bundle moved away by other means is brought back', async () => {
  const L = POSIX
  const { fs, newRoot } = await staleMachine(L)
  assert.equal(await watcherRun(L, fs).run(), EXIT_SELF_REFRESH)
  // Something other than this path (a job's swap, a hand run install) puts a different bundle of the
  // same version in place, from another cache folder; installed_plugins.json still names newRoot.
  const other = cacheRoot(L, '0.63.2-repair')
  for (const rel of WATCHER_BUNDLE_FILES) fs.writeFile(at(L, other, ...rel.split('/')), `// ${rel} 0.63.2 repair\n`)
  fs.writeFile(at(L, other, 'package.json'), JSON.stringify({ version: '0.63.2' }))
  await installWatcherBundle({ pluginRoot: other, home: L.home, fs, now: () => T0 })
  const later = watcherRun(L, fs, { now: T0 + 11 * MINUTE })
  assert.equal(await later.run(), EXIT_SELF_REFRESH)
  assert.equal(fs.readFile(liveEntry(L)), '// bin/hoai-watcher.mjs 0.63.2\n')
  assert.equal(readBundleManifest(L.home, fs)!.pluginRoot, newRoot)
})
