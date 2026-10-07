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
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BUNDLE_INCOMPLETE_CODE,
  MANIFEST_FILE_NAME,
  WATCHER_BUNDLE_FILES,
  WatcherBundleIncompleteError,
  assertWatcherBundleComplete,
  bundleFingerprint,
  installWatcherBundle,
  nodeFs,
  readBundleManifest,
  relativeImportSpecifiers,
  swapStagedBundle,
  watcherHome,
  watcherImportClosure,
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
    // Added 2026-10-05 with the file itself: update-executor imports it, the
    // list never named it, and the 0.61.1 watcher crashed on start on every
    // machine that installed it. This pinned copy is the reason a one-line
    // bundle change cannot land quietly.
    'lib/known-good-store.mjs',
    'lib/update-diagnostics.mjs',
    'lib/machine-id.mjs',
    'lib/watcher-core.mjs',
    'lib/watcher-service.mjs',
    'lib/watcher-bundle.mjs',
    'lib/agent-inventory.mjs',
    'lib/agent-restart.mjs',
    // The shared restart-authority resolver both agent-inventory and
    // agent-restart import; the watcher runs from this bundle, so leaving it
    // out is an import error at reconcile time, not a missing feature.
    'lib/service-supervision.mjs',
    'lib/agent-verify.mjs',
    'lib/claude-preseed.mjs',
    // The crash-safe entry (design 8): bin/hoai-watcher.mjs imports it
    // statically and everything else dynamically, inside the guard.
    'lib/watcher-health.mjs',
    // The keep-alive sweep (design 5) and its imports.
    'lib/watcher-keepalive.mjs',
    'lib/keepalive-plan.mjs',
    'lib/process-tree.mjs',
    'lib/agent-task-win32.mjs',
    // The shared ASCII-only vbs/ps1 strings (the watcher's own service files and the agent task).
    'lib/win32-script-text.mjs',
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
    claudeConfigDir: null,
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
    readBundleManifest(HOME, memoryFs({ '/home/kc/.bgos-agent/watcher/manifest.json': JSON.stringify({ version: '0.38.3-e2e.1', fingerprint: 'abc', claudeConfigDir: null }) })),
    { version: '0.38.3-e2e.1', fingerprint: 'abc', installedAt: null, pluginRoot: null, claudeConfigDir: null, files: [] },
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

/**
 * THE BUNDLE LIST MUST COVER EVERY FILE THE WATCHER ACTUALLY IMPORTS.
 *
 * On 2026-10-05 it did not. `lib/update-executor.mjs` imports
 * `./known-good-store.mjs` and the list never named it, so every machine that
 * installed the 0.61.1 watcher staged an incomplete bundle and
 * `hoai-watcher run` died on start with "Cannot find module ...
 * known-good-store.mjs".
 *
 * THE PART THAT MADE IT EXPENSIVE WAS NOT THE MISSING LINE, IT WAS THE
 * SILENCE. The Scheduled Task read Ready with LastTaskResult 0, the app logged
 * "watcher starting" twice and then sat on "Setting up the watcher" for ever,
 * and nothing anywhere said a module was missing. A crash nobody is told about
 * is indistinguishable from slow setup.
 *
 * So this walks the real import graph from the watcher's entry point and
 * asserts the closure is a SUBSET of the list. A hand-maintained list beside a
 * growing import graph drifts the first time somebody adds an import, and the
 * place that drift shows up is a customer's machine, not a review.
 */
test('the bundle list covers the entire import closure of the watcher entry point', () => {
  const root = join(import.meta.dirname, '..')
  const seen = new Set<string>()
  const queue = ['bin/hoai-watcher.mjs']

  while (queue.length > 0) {
    const rel = queue.shift() as string
    if (seen.has(rel)) continue
    seen.add(rel)
    const source = readFileSync(join(root, rel), 'utf8')
    // BOTH static and DYNAMIC specifiers, and the dynamic half is the half
    // that matters here. `watcher-core.mjs` loads the lifecycle modules with
    // `await import('./update-executor.mjs')` so tests can inject fakes, and
    // its own comment says a partial bundle "fails by name at run time",
    // which is precisely what happened. A walk that followed only `from`
    // reaches 10 files, never reaches update-executor, and therefore reports
    // a clean list whether or not known-good-store is in it. I wrote that
    // version first and the control below is what caught it.
    //
    // Relative specifiers only: node: builtins and bare package names are not
    // files this bundle has to carry.
    for (const m of source.matchAll(/(?:from\s+|import\()\s*'(\.[^']+)'/g)) {
      const spec = m[1] as string
      const resolved = join(rel, '..', spec).split('\\').join('/')
      queue.push(resolved)
    }
  }

  const missing = [...seen].filter((f) => !WATCHER_BUNDLE_FILES.includes(f))
  assert.deepEqual(
    missing,
    [],
    `these files are imported by the watcher and are NOT in WATCHER_BUNDLE_FILES: ${missing.join(', ')}`,
  )

  // POSITIVE CONTROL. A walk that resolved nothing would also report no
  // missing files, which is the same green as a correct list. The closure has
  // to be a real graph, and it has to include the file this test was written
  // for.
  assert.ok(
    seen.size >= 10,
    `the import walk only reached ${seen.size} files, so it is not reading the graph`,
  )
  assert.ok(
    seen.has('lib/known-good-store.mjs'),
    'the walk did not reach known-good-store.mjs, the very file whose absence caused this test to exist',
  )
})

// -- e2e E4: what is copied comes from the ROOT's real code, not from the caller's list ----------

/** A small real plugin root in a temp dir: every listed file as a stub, then the overrides. */
function tinyRoot(root: string, overrides: Record<string, string> = {}) {
  const fs = nodeFs()
  for (const rel of WATCHER_BUNDLE_FILES) fs.writeFile(join(root, rel), `// ${rel}\n`)
  fs.writeFile(join(root, 'package.json'), '{"version":"0.62.1"}')
  for (const [rel, body] of Object.entries(overrides)) fs.writeFile(join(root, rel), body)
  return fs
}

const ENTRY_IMPORTING_CORE_AND_HEALTH = [
  "// the entry: builtins only at load, everything else inside the guard",
  "export const loadHealth = () => import('../lib/watcher-health.mjs')",
  "export const loadCore = () => import('../lib/watcher-core.mjs')",
  '',
].join('\n')

test('installWatcherBundle copies the import closure of the GIVEN root: lib/new-thing.mjs, imported by watcher-core and absent from the list passed in, is copied anyway (e2e E4)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hoai-bundle-closure-'))
  try {
    const root = join(dir, 'plugin')
    const home = join(dir, 'home')
    const fs = tinyRoot(root, {
      'bin/hoai-watcher.mjs': ENTRY_IMPORTING_CORE_AND_HEALTH,
      'lib/watcher-core.mjs': "import {\n  thing,\n} from './new-thing.mjs'\nexport { thing }\n",
      'lib/new-thing.mjs': 'export const thing = 1\n',
    })
    assert.equal(WATCHER_BUNDLE_FILES.includes('lib/new-thing.mjs'), false, 'fixture: the list does not name it')
    const result = await installWatcherBundle({ pluginRoot: root, home, fs, files: WATCHER_BUNDLE_FILES })
    const bundle = watcherHome(home)
    assert.equal(readFileSync(join(bundle, 'lib', 'new-thing.mjs'), 'utf8'), 'export const thing = 1\n')
    assert.deepEqual(result.files, [...WATCHER_BUNDLE_FILES, 'lib/new-thing.mjs'], 'the list in its order, then what the closure added')
    assert.deepEqual(JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8')).files, result.files, 'manifest.files lists what was copied')
    assert.equal(result.fingerprint, bundleFingerprint(root, fs))
    assert.equal(bundleFingerprint(bundle, fs), result.fingerprint, 'the copy fingerprints like its source')

    // An OLDER installer's shorter list (0.61.4 named no watcher-health.mjs) gets the same bundle.
    const older = WATCHER_BUNDLE_FILES.filter((f) => f !== 'lib/watcher-health.mjs')
    const home2 = join(dir, 'home2')
    const fromOlder = await installWatcherBundle({ pluginRoot: root, home: home2, fs, files: older })
    assert.equal(existsSync(join(watcherHome(home2), 'lib', 'watcher-health.mjs')), true)
    assert.equal(existsSync(join(watcherHome(home2), 'lib', 'new-thing.mjs')), true)
    assert.deepEqual([...fromOlder.files].sort(), [...result.files].sort())

    // A file ONLY the closure names still moves the fingerprint (a refresh is then due).
    const before = bundleFingerprint(root, fs)
    writeFileSync(join(root, 'lib', 'new-thing.mjs'), 'export const thing = 2\n')
    assert.notEqual(bundleFingerprint(root, fs), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the completeness check names a missing file: WatcherBundleIncompleteError by name, and no manifest for a bundle that cannot load', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hoai-bundle-complete-'))
  try {
    const fs = nodeFs()
    // 1. A bundle dir whose watcher-core imports a file the bundle does not hold.
    const bundle = join(dir, 'bundle')
    fs.writeFile(join(bundle, 'bin', 'hoai-watcher.mjs'), "export const go = () => import('../lib/watcher-core.mjs')\n")
    fs.writeFile(join(bundle, 'lib', 'watcher-core.mjs'), "import { x } from './gone.mjs'\nexport { x }\n")
    assert.throws(
      () => assertWatcherBundleComplete(bundle, ['bin/hoai-watcher.mjs'], fs),
      (err: any) => {
        assert.ok(err instanceof WatcherBundleIncompleteError)
        assert.equal(err.code, BUNDLE_INCOMPLETE_CODE)
        assert.equal(err.summary, 'lib/gone.mjs (imported by lib/watcher-core.mjs)')
        assert.deepEqual(err.missing, ['lib/gone.mjs'])
        assert.match(err.message, /watcher bundle incomplete: lib\/gone\.mjs \(imported by lib\/watcher-core\.mjs\)/)
        return true
      },
    )
    fs.writeFile(join(bundle, 'lib', 'gone.mjs'), 'export const x = 1\n')
    assert.deepEqual(assertWatcherBundleComplete(bundle, ['bin/hoai-watcher.mjs'], fs).sort(), ['bin/hoai-watcher.mjs', 'lib/gone.mjs', 'lib/watcher-core.mjs'])

    // 2. A root whose own code imports a file it does not ship: named, and NOTHING is written.
    const root = join(dir, 'plugin')
    const home = join(dir, 'home')
    tinyRoot(root, {
      'bin/hoai-watcher.mjs': ENTRY_IMPORTING_CORE_AND_HEALTH,
      'lib/watcher-core.mjs': "import { thing } from './new-thing.mjs'\nexport { thing }\n",
    })
    await assert.rejects(
      () => installWatcherBundle({ pluginRoot: root, home, fs }),
      (err: any) => err.code === BUNDLE_INCOMPLETE_CODE && err.summary === 'lib/new-thing.mjs (imported by lib/watcher-core.mjs)',
    )
    assert.equal(existsSync(watcherHome(home)), false, 'nothing half copied')

    // 3. A copy that silently drops a file: the COPY is checked, by name, before the manifest exists.
    fs.writeFile(join(root, 'lib', 'new-thing.mjs'), 'export const thing = 1\n')
    const lossy = { ...fs, copyFile: (from: string, to: string) => (from.endsWith('new-thing.mjs') ? undefined : fs.copyFile(from, to)) }
    await assert.rejects(
      () => installWatcherBundle({ pluginRoot: root, home, fs: lossy }),
      (err: any) => err.code === BUNDLE_INCOMPLETE_CODE && err.missing.includes('lib/new-thing.mjs'),
    )
    assert.equal(existsSync(join(watcherHome(home), 'manifest.json')), false, 'no manifest names a bundle that cannot load')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('relativeImportSpecifiers: static, export from, side effect and dynamic literal imports; never bare names, builtins, template holes or comments', () => {
  const source = [
    '/**',
    " * @param {import('./typedef-only.mjs').T} x   a JSDoc type, not an import",
    ' */',
    "import { a } from './a.mjs'",
    'import {',
    '  b,',
    '  c,',
    "} from '../lib/b.mjs'",
    "import './side-effect.mjs'",
    "export { d } from './d.js'",
    "export * from './e.mjs'",
    "import fs from 'node:fs'",
    "import zod from 'zod'",
    "const lazy = () => import('./lazy.mjs')",
    'const two = await import("./double-quoted.mjs")',
    'const tpl = await import(`./template.mjs`)',
    'const computed = await import(`./${name}.mjs`)',
    "// import { old } from './commented-out.mjs'",
    "const notAnImport = Array.from('./not-a-path')",
  ].join('\n')
  assert.deepEqual(relativeImportSpecifiers(source).sort(), [
    '../lib/b.mjs',
    './a.mjs',
    './d.js',
    './double-quoted.mjs',
    './e.mjs',
    './lazy.mjs',
    './side-effect.mjs',
    './template.mjs',
  ])
})

test('watcherImportClosure: resolved per file, confined to the root, missing and escaping imports named', () => {
  const fs = memoryFs({
    '/r/bin/hoai-watcher.mjs': "const core = () => import('../lib/watcher-core.mjs')\n",
    '/r/lib/watcher-core.mjs': "import './sub/inner.mjs'\nimport { y } from './absent.mjs'\n",
    '/r/lib/sub/inner.mjs': "import { z } from '../../../outside.mjs'\nimport { w } from '../watcher-core.mjs'\n",
  })
  const walk = watcherImportClosure('/r', { fs })
  assert.equal(walk.ok, false)
  assert.deepEqual(walk.files, ['bin/hoai-watcher.mjs', 'lib/watcher-core.mjs', 'lib/sub/inner.mjs'])
  assert.deepEqual(walk.missing, [{ file: 'lib/absent.mjs', importedBy: 'lib/watcher-core.mjs' }])
  assert.deepEqual(walk.escaped, [{ specifier: '../../../outside.mjs', importedBy: 'lib/sub/inner.mjs' }])
})

test('watcherImportClosure of THIS checkout: complete, inside the list, and the same graph the naive walk of the test above reads', () => {
  const root = join(import.meta.dirname, '..')
  const walk = watcherImportClosure(root)
  assert.equal(walk.ok, true, JSON.stringify({ missing: walk.missing, escaped: walk.escaped }))
  for (const rel of ['lib/known-good-store.mjs', 'lib/watcher-health.mjs', 'lib/win32-script-text.mjs', 'lib/watcher-keepalive.mjs']) {
    assert.ok(walk.files.includes(rel), `the shared walk reaches ${rel}`)
  }
  assert.deepEqual(walk.files.filter((f) => !WATCHER_BUNDLE_FILES.includes(f)), [])
  // The independent naive walk (the test below) must agree, so neither can drift alone.
  const seen = new Set<string>()
  const queue = ['bin/hoai-watcher.mjs']
  while (queue.length > 0) {
    const rel = queue.shift() as string
    if (seen.has(rel)) continue
    seen.add(rel)
    for (const m of readFileSync(join(root, rel), 'utf8').matchAll(/(?:from\s+|import\()\s*'(\.[^']+)'/g)) {
      queue.push(join(rel, '..', m[1] as string).split('\\').join('/'))
    }
  }
  assert.deepEqual([...walk.files].sort(), [...seen].sort())
})

test('lib/watcher-bundle.mjs imports node builtins only: the entry reaches the self repair through it when nothing else loads', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'lib', 'watcher-bundle.mjs'), 'utf8')
  const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1])
  assert.ok(specifiers.length >= 3, 'the scan reads the import block')
  assert.deepEqual(specifiers.filter((s) => !String(s).startsWith('node:')), [])
  assert.deepEqual(relativeImportSpecifiers(source), [], 'and no relative import at all, static or dynamic')
})
