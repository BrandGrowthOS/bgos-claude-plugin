/**
 * lib/watcher-bundle.mjs: the watcher bundle copied OUT of the plugin folder
 * (~/.bgos-agent/watcher/) so a plugin reinstall/uninstall never kills the
 * watcher: the exported file list (design 7.5), fingerprinting, install with
 * a manifest, the staged swap a post-update reconcile performs, and the
 * shared node adapters. Everything runs against an in-memory fs; one test
 * uses the real node adapters in a temp dir.
 *
 * Run: npx tsx --test test/watcher-bundle.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MANIFEST_FILE_NAME,
  WATCHER_BUNDLE_FILES,
  bundleFingerprint,
  installWatcherBundle,
  nodeFs,
  readBundleManifest,
  swapStagedBundle,
  watcherHome,
  watcherLogPath,
  watcherStatePath,
} from '../lib/watcher-bundle.mjs'
import { memoryFs } from './helpers/memory-fs.ts'

const HOME = '/home/kc'
const ROOT = '/home/kc/.claude/plugins/cache/hoai/hoai/0.38.3'

function pluginRootFiles(root: string, marker = 'v1') {
  const files: Record<string, string> = { [`${root}/package.json`]: JSON.stringify({ name: 'x', version: '0.38.3' }) }
  for (const rel of WATCHER_BUNDLE_FILES) files[`${root}/${rel}`] = `// ${rel} ${marker}\n`
  return files
}

test('WATCHER_BUNDLE_FILES is exactly the design 7.5 list (order and names)', () => {
  assert.deepEqual(WATCHER_BUNDLE_FILES, [
    'bin/hoai-watcher.mjs',
    'bin/bgos-install-method.mjs',
    'lib/plugin-cli.mjs',
    'lib/update-planner.mjs',
    'lib/update-executor.mjs',
    'lib/update-diagnostics.mjs',
    'lib/machine-id.mjs',
    'lib/watcher-core.mjs',
    'lib/watcher-service.mjs',
    'lib/watcher-bundle.mjs',
    'lib/agent-inventory.mjs',
    'lib/agent-restart.mjs',
    'lib/agent-verify.mjs',
    'lib/claude-preseed.mjs',
  ])
  assert.equal(Object.isFrozen(WATCHER_BUNDLE_FILES), true)
})

test('layout: watcher home, log, state, manifest paths (separator preserving)', () => {
  assert.equal(watcherHome(HOME), '/home/kc/.bgos-agent/watcher')
  assert.equal(watcherHome('C:\\Users\\kc'), 'C:\\Users\\kc\\.bgos-agent\\watcher')
  assert.equal(watcherLogPath(HOME), '/home/kc/.bgos-agent/watcher/logs/watcher.log')
  assert.equal(watcherStatePath(HOME), '/home/kc/.bgos-agent/watcher/state.json')
  assert.equal(MANIFEST_FILE_NAME, 'manifest.json')
})

test('bundleFingerprint: sha256 over sorted relative paths + contents; content change or missing file changes it', () => {
  const a = memoryFs(pluginRootFiles(ROOT))
  const fp1 = bundleFingerprint(ROOT, a)
  assert.match(fp1, /^[0-9a-f]{64}$/)
  assert.equal(bundleFingerprint(ROOT, a), fp1, 'deterministic')
  const b = memoryFs(pluginRootFiles(ROOT, 'v2'))
  assert.notEqual(bundleFingerprint(ROOT, b), fp1)
  const c = memoryFs(pluginRootFiles(ROOT))
  c.files.delete(`${ROOT}/lib/agent-verify.mjs`)
  assert.notEqual(bundleFingerprint(ROOT, c), fp1)
  // Another root with identical contents fingerprints identically (the
  // fingerprint is about the code, not where it sits).
  const d = memoryFs(pluginRootFiles('/elsewhere'))
  assert.equal(bundleFingerprint('/elsewhere', d), fp1)
})

test('installWatcherBundle: copies bin/ + lib/ preserving layout, writes the manifest, returns the summary', async () => {
  const fs = memoryFs(pluginRootFiles(ROOT))
  const result = await installWatcherBundle({
    pluginRoot: ROOT,
    home: HOME,
    fs,
    now: () => Date.parse('2026-08-25T01:02:03.000Z'),
  })
  assert.equal(result.bundleDir, '/home/kc/.bgos-agent/watcher')
  assert.equal(result.version, '0.38.3', 'version read from the plugin package.json when not given')
  assert.deepEqual(result.files, [...WATCHER_BUNDLE_FILES])
  assert.equal(result.fingerprint, bundleFingerprint(ROOT, fs))
  for (const rel of WATCHER_BUNDLE_FILES) {
    assert.equal(fs.files.get(`/home/kc/.bgos-agent/watcher/${rel}`), `// ${rel} v1\n`)
  }
  const manifest = JSON.parse(fs.files.get('/home/kc/.bgos-agent/watcher/manifest.json')!)
  assert.deepEqual(manifest, {
    version: '0.38.3',
    fingerprint: result.fingerprint,
    installedAt: '2026-08-25T01:02:03.000Z',
    pluginRoot: ROOT,
    files: [...WATCHER_BUNDLE_FILES],
  })
  assert.deepEqual(readBundleManifest(HOME, fs), manifest)
  // The bundle's own copies fingerprint the same as the source.
  assert.equal(bundleFingerprint('/home/kc/.bgos-agent/watcher', fs), result.fingerprint)
})

test('installWatcherBundle: an explicit pluginVersion wins; a missing bundle file is a named failure, nothing half-written', async () => {
  const fs = memoryFs(pluginRootFiles(ROOT))
  const ok = await installWatcherBundle({ pluginRoot: ROOT, home: HOME, pluginVersion: '9.9.9', fs })
  assert.equal(ok.version, '9.9.9')
  const broken = memoryFs(pluginRootFiles(ROOT))
  broken.files.delete(`${ROOT}/lib/update-executor.mjs`)
  await assert.rejects(
    () => installWatcherBundle({ pluginRoot: ROOT, home: HOME, fs: broken }),
    /bundle file missing: lib\/update-executor\.mjs/,
  )
  assert.equal([...broken.files.keys()].some((k) => k.startsWith('/home/kc/.bgos-agent/watcher/')), false)
})

test('installWatcherBundle: targetDir stages into <watcherHome>/next without touching the live bundle', async () => {
  const fs = memoryFs({ ...pluginRootFiles(ROOT), ...pluginRootFiles('/new-root', 'v2') })
  await installWatcherBundle({ pluginRoot: ROOT, home: HOME, fs })
  const staged = await installWatcherBundle({
    pluginRoot: '/new-root',
    home: HOME,
    fs,
    targetDir: '/home/kc/.bgos-agent/watcher/next',
  })
  assert.equal(staged.bundleDir, '/home/kc/.bgos-agent/watcher/next')
  assert.equal(fs.files.get('/home/kc/.bgos-agent/watcher/lib/watcher-core.mjs'), '// lib/watcher-core.mjs v1\n')
  assert.equal(fs.files.get('/home/kc/.bgos-agent/watcher/next/lib/watcher-core.mjs'), '// lib/watcher-core.mjs v2\n')
})

test('swapStagedBundle: next/ replaces bin/, lib/ and the manifest; credentials, state and logs are untouched; staging dirs are gone', async () => {
  const fs = memoryFs({ ...pluginRootFiles(ROOT), ...pluginRootFiles('/new-root', 'v2') })
  await installWatcherBundle({ pluginRoot: ROOT, home: HOME, fs })
  fs.files.set('/home/kc/.bgos-agent/watcher/credentials.json', '{"token":"t"}')
  fs.files.set('/home/kc/.bgos-agent/watcher/state.json', '{}')
  fs.files.set('/home/kc/.bgos-agent/watcher/logs/watcher.log', 'line\n')
  const staged = await installWatcherBundle({ pluginRoot: '/new-root', home: HOME, fs, targetDir: '/home/kc/.bgos-agent/watcher/next' })
  const result = swapStagedBundle({ home: HOME, fs })
  assert.deepEqual(result, { ok: true, swapped: ['bin', 'lib', 'manifest.json'], message: 'swapped' })
  for (const rel of WATCHER_BUNDLE_FILES) {
    assert.equal(fs.files.get(`/home/kc/.bgos-agent/watcher/${rel}`), `// ${rel} v2\n`)
  }
  assert.equal(readBundleManifest(HOME, fs)?.fingerprint, staged.fingerprint)
  assert.equal(readBundleManifest(HOME, fs)?.pluginRoot, '/new-root')
  assert.equal(fs.files.get('/home/kc/.bgos-agent/watcher/credentials.json'), '{"token":"t"}')
  assert.equal(fs.files.get('/home/kc/.bgos-agent/watcher/state.json'), '{}')
  assert.equal(fs.files.get('/home/kc/.bgos-agent/watcher/logs/watcher.log'), 'line\n')
  assert.equal([...fs.files.keys()].some((k) => k.includes('/watcher/next/') || k.includes('/watcher/prev/')), false)
})

test('swapStagedBundle: nothing staged is a named no-op; a failed rename restores the previous bundle', async () => {
  const fs = memoryFs(pluginRootFiles(ROOT))
  await installWatcherBundle({ pluginRoot: ROOT, home: HOME, fs })
  assert.deepEqual(swapStagedBundle({ home: HOME, fs }), { ok: false, swapped: [], message: 'nothing_staged' })
  const staged = memoryFs({ ...pluginRootFiles(ROOT), ...pluginRootFiles('/new-root', 'v2') })
  await installWatcherBundle({ pluginRoot: ROOT, home: HOME, fs: staged })
  await installWatcherBundle({ pluginRoot: '/new-root', home: HOME, fs: staged, targetDir: '/home/kc/.bgos-agent/watcher/next' })
  const before = new Map(staged.files)
  let renames = 0
  const flaky = {
    ...staged,
    rename: (from: string, to: string) => {
      renames += 1
      // The lib/ move (third rename: bin out, bin in, lib out) blows up.
      if (renames === 3) throw new Error('EACCES: simulated')
      staged.rename(from, to)
    },
  }
  const result = swapStagedBundle({ home: HOME, fs: flaky })
  assert.equal(result.ok, false)
  assert.match(result.message, /EACCES/)
  // Restored: every live bundle file is the v1 copy again.
  for (const rel of WATCHER_BUNDLE_FILES) {
    assert.equal(staged.files.get(`/home/kc/.bgos-agent/watcher/${rel}`), before.get(`/home/kc/.bgos-agent/watcher/${rel}`))
  }
})

test('readBundleManifest: null for absent or junk or a non-semver version', () => {
  assert.equal(readBundleManifest(HOME, memoryFs({})), null)
  assert.equal(readBundleManifest(HOME, memoryFs({ '/home/kc/.bgos-agent/watcher/manifest.json': 'junk' })), null)
  assert.equal(
    readBundleManifest(HOME, memoryFs({ '/home/kc/.bgos-agent/watcher/manifest.json': JSON.stringify({ version: 'latest', fingerprint: 'x' }) })),
    null,
  )
  assert.deepEqual(
    readBundleManifest(HOME, memoryFs({ '/home/kc/.bgos-agent/watcher/manifest.json': JSON.stringify({ version: '0.38.3-e2e.1', fingerprint: 'abc' }) })),
    { version: '0.38.3-e2e.1', fingerprint: 'abc', installedAt: null, pluginRoot: null, files: [] },
  )
})

test('nodeFs: the real adapter round trips a bundle install in a temp dir (mode, copy, rename, rm, stat)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hoai-bundle-'))
  try {
    const fs = nodeFs()
    const root = join(dir, 'plugin')
    for (const rel of WATCHER_BUNDLE_FILES) fs.writeFile(join(root, rel), `// ${rel}\n`)
    fs.writeFile(join(root, 'package.json'), '{"version":"0.38.3"}')
    const home = join(dir, 'home')
    const result = await installWatcherBundle({ pluginRoot: root, home, fs })
    assert.equal(existsSync(join(home, '.bgos-agent', 'watcher', 'bin', 'hoai-watcher.mjs')), true)
    assert.equal(readFileSync(join(home, '.bgos-agent', 'watcher', 'manifest.json'), 'utf8').includes(result.fingerprint), true)
    assert.equal(fs.stat(join(home, '.bgos-agent', 'watcher'))?.isDirectory, true)
    assert.equal(fs.stat(join(home, 'nope')), null)
    assert.deepEqual(fs.listDir(join(home, 'nope')), [])
    assert.equal(fs.readFile(join(home, 'nope')), null)
    fs.writeFile(join(home, 'secret.json'), '{}', { mode: 0o600 })
    fs.rename(join(home, 'secret.json'), join(home, 'moved.json'))
    assert.equal(fs.exists(join(home, 'moved.json')), true)
    fs.rm(join(home, '.bgos-agent'))
    assert.equal(fs.exists(join(home, '.bgos-agent')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
