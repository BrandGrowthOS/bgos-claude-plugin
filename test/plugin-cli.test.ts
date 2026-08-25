/**
 * plugin-cli tests: the `claude plugin ...` adapter behind the zero-terminal
 * lifecycle (marketplace register / refresh / install / update / uninstall /
 * list), split into three layers so every failure names its layer:
 *
 *   1. Pure classifiers over {code, stdout, stderr, timedOut}: every REAL
 *      Claude Code 2.1.241 phrase from the design's ground-truth probe (and
 *      the binary's own message templates) maps to exactly one verdict,
 *      unrecognised rc-0 output is `garbage` (never a success), rc != 0 is
 *      `failed` unless the phrase is the one known benign case, and no input
 *      shape can make them throw.
 *   2. Pure readers over text and an injected fs: `claude plugin list --json`
 *      with leading noise, marketplace.json ref parsing (v prefix, semver
 *      validation), and observeMarketplaceInstall over an in-memory fs.
 *   3. The runner: runClaudeCli against the sandbox's REAL fake CLI process
 *      (success / failure / garbage / hang / wrong version / call log) and the
 *      win32 spawn candidate chain with an injected spawn, so the real
 *      `claude` binary is never invoked by the suite.
 *
 * Run: npx tsx --test test/plugin-cli.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  HOAI_MARKETPLACE_SOURCE,
  HOAI_MARKETPLACE,
  HOAI_PLUGIN_ID,
  NETWORK_TIMEOUT_MS,
  LIST_TIMEOUT_MS,
  CLI_NOT_FOUND_EXIT_CODE,
  defaultTimeoutMs,
  marketplaceAddArgs,
  marketplaceUpdateArgs,
  installArgs,
  updateArgs,
  uninstallArgs,
  listJsonArgs,
  claudeCliCandidates,
  runClaudeCli,
  normalizeCliResult,
  classifyMarketplaceAdd,
  classifyMarketplaceUpdate,
  classifyInstall,
  classifyUpdate,
  classifyUninstall,
  scrubOneLiner,
  parsePluginListJson,
  readMarketplaceLatest,
  marketplaceConfigPaths,
  observeMarketplaceInstall,
} from '../lib/plugin-cli.mjs'
import { makeSandbox, cliRunnerFor, type Sandbox } from './helpers/sandbox.ts'

/** A CLI result literal, the shape runClaudeCli resolves with. */
function res(code: number | null, stdout = '', stderr = '', timedOut = false) {
  return { code, stdout, stderr, timedOut }
}

/** The real "already on disk" line carries U+2014; built via the escape so
 *  the source itself holds no dash character. */
const REAL_ALREADY_ON_DISK = `\u2714 Marketplace 'hoai' already on disk \u2014 declared in user settings\n`

// ---------------------------------------------------------------------------
// Constants and command builders
// ---------------------------------------------------------------------------

test('constants name the hoai marketplace and plugin exactly', () => {
  assert.equal(HOAI_MARKETPLACE_SOURCE, 'BrandGrowthOS/hoai-marketplace')
  assert.equal(HOAI_MARKETPLACE, 'hoai')
  assert.equal(HOAI_PLUGIN_ID, 'hoai@hoai')
  assert.equal(NETWORK_TIMEOUT_MS, 180_000)
  assert.equal(LIST_TIMEOUT_MS, 30_000)
  assert.equal(CLI_NOT_FOUND_EXIT_CODE, 127)
})

test('command builders: exact argv, install/update/uninstall carry -y and user scope, list is --json', () => {
  assert.deepEqual(marketplaceAddArgs(), ['plugin', 'marketplace', 'add', 'BrandGrowthOS/hoai-marketplace'])
  assert.deepEqual(marketplaceUpdateArgs(), ['plugin', 'marketplace', 'update', 'hoai'])
  assert.deepEqual(installArgs(), ['plugin', 'install', 'hoai@hoai', '--scope', 'user', '-y'])
  assert.deepEqual(updateArgs(), ['plugin', 'update', 'hoai@hoai', '--scope', 'user', '-y'])
  assert.deepEqual(uninstallArgs(), ['plugin', 'uninstall', 'hoai@hoai', '--scope', 'user', '-y'])
  assert.deepEqual(listJsonArgs(), ['plugin', 'list', '--json'])
  // Builders hand out fresh arrays: a caller mutating one cannot poison the next.
  const first = installArgs()
  first.push('--oops')
  assert.deepEqual(installArgs(), ['plugin', 'install', 'hoai@hoai', '--scope', 'user', '-y'])
})

test('defaultTimeoutMs: 30 s for list, 180 s for every network command', () => {
  assert.equal(defaultTimeoutMs(listJsonArgs()), LIST_TIMEOUT_MS)
  assert.equal(defaultTimeoutMs(marketplaceAddArgs()), NETWORK_TIMEOUT_MS)
  assert.equal(defaultTimeoutMs(marketplaceUpdateArgs()), NETWORK_TIMEOUT_MS)
  assert.equal(defaultTimeoutMs(installArgs()), NETWORK_TIMEOUT_MS)
  assert.equal(defaultTimeoutMs(updateArgs()), NETWORK_TIMEOUT_MS)
  assert.equal(defaultTimeoutMs(uninstallArgs()), NETWORK_TIMEOUT_MS)
  assert.equal(defaultTimeoutMs([]), NETWORK_TIMEOUT_MS)
})

// ---------------------------------------------------------------------------
// Classifiers (real 2.1.241 strings)
// ---------------------------------------------------------------------------

test('classifyMarketplaceAdd: registered / already on disk / failed / garbage', () => {
  const added = classifyMarketplaceAdd(res(0, '\u2714 Successfully added marketplace: hoai (declared in user settings)\n'))
  assert.equal(added.kind, 'registered')
  assert.match(added.message, /Successfully added marketplace: hoai/)

  const again = classifyMarketplaceAdd(res(0, REAL_ALREADY_ON_DISK))
  assert.equal(again.kind, 'already')
  assert.match(again.message, /already on disk/)

  const failed = classifyMarketplaceAdd(res(1, '', '\u2718 Failed to add marketplace: repository not found\n'))
  assert.equal(failed.kind, 'failed')
  assert.equal(failed.message, 'Failed to add marketplace: repository not found')

  // rc 0 with nothing we recognise is NOT a success.
  assert.equal(classifyMarketplaceAdd(res(0, 'Done.\n')).kind, 'garbage')
  assert.equal(classifyMarketplaceAdd(res(0, '')).kind, 'garbage')
  // A benign phrase with a non-zero rc is still a failure.
  assert.equal(classifyMarketplaceAdd(res(1, REAL_ALREADY_ON_DISK)).kind, 'failed')
})

test('classifyMarketplaceUpdate: updated / nothing needed updating / failed / garbage', () => {
  const updated = classifyMarketplaceUpdate(res(0, '\u2714 Successfully updated marketplace: hoai\n'))
  assert.equal(updated.kind, 'updated')
  assert.match(updated.message, /Successfully updated marketplace: hoai/)
  assert.equal(classifyMarketplaceUpdate(res(0, 'No marketplaces needed updating\n')).kind, 'updated')

  const failed = classifyMarketplaceUpdate(res(1, '', '\u2718 Failed to update marketplace "hoai": Marketplace "hoai" not found\n'))
  assert.equal(failed.kind, 'failed')
  assert.match(failed.message, /Marketplace "hoai" not found/)

  assert.equal(classifyMarketplaceUpdate(res(0, 'ok\n')).kind, 'garbage')
})

test('classifyInstall: installed / already installed / failed / garbage / timed out', () => {
  const installed = classifyInstall(res(0, '\u2714 Successfully installed plugin: hoai@hoai (scope: user)\n'))
  assert.equal(installed.kind, 'installed')
  assert.match(installed.message, /Successfully installed plugin: hoai@hoai/)

  const already = classifyInstall(res(0, 'Plugin "hoai@hoai" is already installed (scope: user)\n'))
  assert.equal(already.kind, 'already')

  const failed = classifyInstall(res(1, '', '\u2718 Failed to install plugin "hoai@hoai": Marketplace "hoai" not found\n'))
  assert.equal(failed.kind, 'failed')
  assert.match(failed.message, /not found/)

  assert.equal(classifyInstall(res(0, 'Installing...\n')).kind, 'garbage')

  const timedOut = classifyInstall(res(null, '', '', true))
  assert.equal(timedOut.kind, 'failed')
  assert.match(timedOut.message, /timed out/i)
})

/** The real 2.1.241 transition captured on 2026-08-25 (local marketplace, 0.38.3 to 0.38.4). */
const REAL_UPDATE_STDOUT =
  'Checking for updates for plugin "hoai@hoai" at user scope\u2026\n' +
  '\u2714 Plugin "hoai" updated from 0.38.3 to 0.38.4 for scope user. Restart to apply changes.\n'

test('classifyUpdate: real "updated from a to b" line with both versions captured', () => {
  const updated = classifyUpdate(res(0, REAL_UPDATE_STDOUT))
  assert.equal(updated.kind, 'updated')
  assert.equal(updated.fromVersion, '0.38.3')
  assert.equal(updated.toVersion, '0.38.4')
  assert.equal(updated.version, null)
  // The message is the line that carries the verdict, not the progress line.
  assert.match(updated.message, /updated from 0\.38\.3 to 0\.38\.4/)
  // Older phrasings still count as updated, without versions.
  const legacy = classifyUpdate(res(0, 'hoai@hoai updated, restart required to apply\n'))
  assert.equal(legacy.kind, 'updated')
  assert.equal(legacy.fromVersion, null)
  assert.equal(legacy.toVersion, null)
})

test('classifyUpdate: already at latest (version captured) / failed not found / garbage', () => {
  const latest = classifyUpdate(
    res(0, 'Checking for updates for plugin "hoai@hoai" at user scope\u2026\nhoai@hoai is already at the latest version (0.38.3).\n'),
  )
  assert.equal(latest.kind, 'already_latest')
  assert.equal(latest.version, '0.38.3')
  assert.equal(latest.fromVersion, null)
  assert.equal(latest.toVersion, null)
  assert.match(latest.message, /already at the latest version \(0\.38\.3\)/)

  const notFound = classifyUpdate(res(1, '', '\u2718 Failed to update plugin "nope@hoai": Plugin "nope" not found\n'))
  assert.equal(notFound.kind, 'failed')
  assert.match(notFound.message, /Plugin "nope" not found/)
  assert.equal(notFound.version, null)

  // The progress line alone (rc 0, no verdict line) is garbage, not success.
  assert.equal(classifyUpdate(res(0, 'Checking for updates for plugin "hoai@hoai" at user scope\u2026\n')).kind, 'garbage')
  assert.equal(classifyUpdate(res(2, '', '')).kind, 'failed')
})

test('classifyUninstall: uninstalled / not installed (rc 1 benign) / failed / garbage', () => {
  const gone = classifyUninstall(res(0, '\u2714 Successfully uninstalled plugin: hoai@hoai (scope: user)\n'))
  assert.equal(gone.kind, 'uninstalled')

  const notInstalled = classifyUninstall(
    res(1, '', '\u2718 Failed to uninstall plugin "hoai@hoai": Plugin "hoai@hoai" not found in installed plugins\n'),
  )
  assert.equal(notInstalled.kind, 'not_installed')
  assert.match(notInstalled.message, /not found in installed plugins/)
  // The other real phrasing for the same state.
  assert.equal(classifyUninstall(res(1, '', 'Plugin "hoai@hoai" is not installed\n')).kind, 'not_installed')
  assert.equal(
    classifyUninstall(res(1, '', 'Plugin "hoai@hoai" is not installed at scope user\n')).kind,
    'not_installed',
  )

  const failed = classifyUninstall(res(1, '', 'EACCES: permission denied, unlink installed_plugins.json\n'))
  assert.equal(failed.kind, 'failed')
  assert.match(failed.message, /EACCES/)

  assert.equal(classifyUninstall(res(0, 'Removing...\n')).kind, 'garbage')
})

test('classifiers never throw: null, undefined fields, binary junk, Buffer output', () => {
  const junk = Buffer.from([0x00, 0xff, 0xfe, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x41])
  const inputs = [
    null,
    undefined,
    {},
    { code: 0 },
    { code: 0, stdout: junk as unknown as string },
    { code: 0, stdout: junk.toString('latin1') },
    { code: 'x' as unknown as number, stdout: 12 as unknown as string },
  ]
  for (const input of inputs) {
    for (const classify of [
      classifyMarketplaceAdd,
      classifyMarketplaceUpdate,
      classifyInstall,
      classifyUpdate,
      classifyUninstall,
    ]) {
      const verdict = classify(input)
      assert.equal(typeof verdict.kind, 'string')
      assert.equal(typeof verdict.message, 'string')
      assert.ok(['garbage', 'failed'].includes(verdict.kind), `${classify.name}: ${verdict.kind}`)
    }
  }
})

test('scrubOneLiner: strips ANSI and glyphs, keeps the first meaningful line, drops control bytes, caps length', () => {
  assert.equal(
    scrubOneLiner('\u001b[32m\u2714\u001b[39m Successfully installed plugin: hoai@hoai (scope: user)\n'),
    'Successfully installed plugin: hoai@hoai (scope: user)',
  )
  assert.equal(scrubOneLiner('\n\n   \n  second   line  here \nthird\n'), 'second line here')
  assert.equal(scrubOneLiner('a\u0000b\u0007c\td'), 'abc d')
  assert.equal(scrubOneLiner(''), '')
  assert.equal(scrubOneLiner(undefined), '')
  const long = scrubOneLiner('x'.repeat(500))
  assert.ok(long.length <= 200, `capped, got ${long.length}`)
  assert.ok(long.endsWith('...'))
})

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

test('parsePluginListJson: golden 2.1.241 shape, leading noise tolerated, garbage is null', () => {
  const golden = JSON.stringify([
    {
      id: 'hoai@hoai',
      version: '0.38.3',
      scope: 'user',
      enabled: true,
      installPath: '/home/kc/.claude/plugins/cache/hoai/hoai/0.38.3',
      installedAt: '2026-08-24T19:41:00.000Z',
    },
  ])
  const parsed = parsePluginListJson(golden)
  assert.ok(parsed)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].id, 'hoai@hoai')
  assert.equal(parsed[0].version, '0.38.3')
  assert.equal(parsed[0].installPath, '/home/kc/.claude/plugins/cache/hoai/hoai/0.38.3')
  assert.equal(parsed[0].scope, 'user')
  assert.equal(parsed[0].enabled, true)

  // A warning line before the JSON (seen with stale marketplaces) is skipped.
  const noisy = `Warning: marketplace "hoai" was last updated 9 days ago\n${golden}\n`
  assert.deepEqual(parsePluginListJson(noisy)?.map((p) => p.id), ['hoai@hoai'])

  assert.deepEqual(parsePluginListJson('[]'), [])
  assert.equal(parsePluginListJson(''), null)
  assert.equal(parsePluginListJson('not json at all'), null)
  assert.equal(parsePluginListJson('{"plugins": []}'), null)
  assert.equal(parsePluginListJson('[1, 2, 3'), null)
  // Entries without a string id are dropped, not thrown on.
  const mixed = parsePluginListJson('[{"id":"a@b"}, 5, null, {"version":"1.0.0"}]')
  assert.deepEqual(mixed?.map((p) => p.id), ['a@b'])
  assert.equal(mixed?.[0].version, null)
  assert.equal(mixed?.[0].installPath, null)
})

test('readMarketplaceLatest: strips the v prefix, validates semver, null for missing plugin or malformed text', () => {
  const doc = (ref: string, name = 'hoai') =>
    JSON.stringify({
      name: 'hoai',
      plugins: [{ name, source: { source: 'url', url: 'https://github.com/BrandGrowthOS/bgos-claude-plugin.git', ref } }],
    })
  assert.deepEqual(readMarketplaceLatest(doc('v0.38.3')), { version: '0.38.3', ref: 'v0.38.3' })
  assert.deepEqual(readMarketplaceLatest(doc('0.38.4')), { version: '0.38.4', ref: '0.38.4' })
  assert.equal(readMarketplaceLatest(doc('v0.38.3', 'other')), null)
  assert.equal(readMarketplaceLatest(doc('main')), null)
  assert.equal(readMarketplaceLatest(doc('v1.2')), null)
  assert.equal(readMarketplaceLatest(doc('v01.2.3')), null)
  assert.equal(readMarketplaceLatest('{not json'), null)
  assert.equal(readMarketplaceLatest(''), null)
  assert.equal(readMarketplaceLatest('null'), null)
  assert.equal(readMarketplaceLatest(JSON.stringify({ plugins: [{ name: 'hoai' }] })), null)
  assert.equal(readMarketplaceLatest(JSON.stringify({ plugins: 'nope' })), null)
})

test('readMarketplaceLatest: a top-level version wins over the ref; file:// and plain-path sources are read', () => {
  const entry = (plugin: Record<string, unknown>) => JSON.stringify({ name: 'hoai', plugins: [{ name: 'hoai', ...plugin }] })
  // E2E / staging shape: version declared on the entry, source is a file:// url with a ref.
  assert.deepEqual(
    readMarketplaceLatest(entry({ version: '0.38.4', source: { source: 'url', url: 'file:///E:/oneclick-e2e/plugin.git', ref: 'v0.38.3' } })),
    { version: '0.38.4', ref: 'v0.38.3' },
  )
  // Version with a v prefix on the entry is normalised too.
  assert.equal(readMarketplaceLatest(entry({ version: 'v0.38.5', source: { source: 'url', url: 'x', ref: 'v0.38.3' } }))?.version, '0.38.5')
  // A bogus top-level version falls back to the ref.
  assert.deepEqual(
    readMarketplaceLatest(entry({ version: 'latest', source: { source: 'url', url: 'x', ref: 'v0.38.3' } })),
    { version: '0.38.3', ref: 'v0.38.3' },
  )
  // Plain relative-path source: only a top-level version can name the release.
  assert.deepEqual(readMarketplaceLatest(entry({ version: '0.38.4', source: './plugins/hoai' })), { version: '0.38.4', ref: null })
  assert.equal(readMarketplaceLatest(entry({ source: './plugins/hoai' })), null)
  // An already parsed object is accepted as well as text.
  assert.deepEqual(readMarketplaceLatest({ plugins: [{ name: 'hoai', source: { source: 'url', url: 'x', ref: 'v0.38.3' } }] }), {
    version: '0.38.3',
    ref: 'v0.38.3',
  })
})

test('marketplaceConfigPaths: joined in the config dir separator style', () => {
  const posix = marketplaceConfigPaths('/home/kc/.claude')
  assert.equal(posix.knownMarketplaces, '/home/kc/.claude/plugins/known_marketplaces.json')
  assert.equal(posix.marketplaceJson, '/home/kc/.claude/plugins/marketplaces/hoai/.claude-plugin/marketplace.json')
  assert.equal(posix.installedPlugins, '/home/kc/.claude/plugins/installed_plugins.json')
  assert.equal(posix.settings, '/home/kc/.claude/settings.json')
  assert.equal(posix.cacheDir, '/home/kc/.claude/plugins/cache/hoai/hoai')

  const win = marketplaceConfigPaths('C:\\Users\\x\\.claude\\')
  assert.equal(win.knownMarketplaces, 'C:\\Users\\x\\.claude\\plugins\\known_marketplaces.json')
  assert.equal(win.settings, 'C:\\Users\\x\\.claude\\settings.json')
})

/** An in-memory fs for observeMarketplaceInstall. */
function memoryFs(files: Record<string, string>) {
  return {
    readFile: (path: string) => {
      if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return files[path]
    },
    exists: (path: string) => path in files,
  }
}

const CFG = '/home/kc/.claude'
const P = marketplaceConfigPaths(CFG)
const KNOWN = JSON.stringify({
  hoai: {
    source: { source: 'github', repo: 'BrandGrowthOS/hoai-marketplace' },
    installLocation: '/home/kc/.claude/plugins/marketplaces/hoai',
    lastUpdated: '2026-08-24T19:40:50.953Z',
  },
})
const MARKETPLACE = JSON.stringify({
  name: 'hoai',
  plugins: [{ name: 'hoai', source: { source: 'url', url: 'x', ref: 'v0.38.3' } }],
})
const INSTALLED = JSON.stringify({
  version: 2,
  plugins: {
    'hoai@hoai': [
      {
        scope: 'user',
        installPath: '/home/kc/.claude/plugins/cache/hoai/hoai/0.38.3',
        version: '0.38.3',
        installedAt: '2026-08-24T19:41:00.000Z',
        lastUpdated: '2026-08-24T19:41:00.000Z',
        gitCommitSha: 'abc',
      },
    ],
  },
})

test('observeMarketplaceInstall: nothing on disk', async () => {
  const seen = await observeMarketplaceInstall({ configDir: CFG, ...memoryFs({}) })
  assert.deepEqual(seen, {
    marketplaceRegistered: false,
    marketplaceInstallLocation: null,
    marketplaceLatest: null,
    installed: { present: false, version: null, installPath: null },
    enabled: false,
  })
})

test('observeMarketplaceInstall: marketplace registered, nothing installed', async () => {
  const seen = await observeMarketplaceInstall({
    configDir: CFG,
    ...memoryFs({
      [P.knownMarketplaces]: KNOWN,
      [P.marketplaceJson]: MARKETPLACE,
      [P.installedPlugins]: JSON.stringify({ version: 2, plugins: {} }),
      [P.settings]: JSON.stringify({ enabledPlugins: {}, extraKnownMarketplaces: { hoai: {} } }),
    }),
  })
  assert.equal(seen.marketplaceRegistered, true)
  assert.deepEqual(seen.marketplaceLatest, { version: '0.38.3', ref: 'v0.38.3' })
  assert.deepEqual(seen.installed, { present: false, version: null, installPath: null })
  assert.equal(seen.enabled, false)
  // GitHub source: the CLI clones under the config dir and records that as installLocation.
  assert.equal(seen.marketplaceInstallLocation, '/home/kc/.claude/plugins/marketplaces/hoai')
})

test('observeMarketplaceInstall: installed and enabled', async () => {
  const seen = await observeMarketplaceInstall({
    configDir: CFG,
    ...memoryFs({
      [P.knownMarketplaces]: KNOWN,
      [P.marketplaceJson]: MARKETPLACE,
      [P.installedPlugins]: INSTALLED,
      [P.settings]: JSON.stringify({ enabledPlugins: { 'hoai@hoai': true } }),
    }),
  })
  assert.equal(seen.marketplaceRegistered, true)
  assert.deepEqual(seen.installed, {
    present: true,
    version: '0.38.3',
    installPath: '/home/kc/.claude/plugins/cache/hoai/hoai/0.38.3',
  })
  assert.equal(seen.enabled, true)
})

test('observeMarketplaceInstall: installed but disabled, and malformed files read as absent', async () => {
  const disabled = await observeMarketplaceInstall({
    configDir: CFG,
    ...memoryFs({
      [P.knownMarketplaces]: KNOWN,
      [P.marketplaceJson]: MARKETPLACE,
      [P.installedPlugins]: INSTALLED,
      [P.settings]: JSON.stringify({ enabledPlugins: { 'hoai@hoai': false } }),
    }),
  })
  assert.equal(disabled.installed.present, true)
  assert.equal(disabled.enabled, false)

  const broken = await observeMarketplaceInstall({
    configDir: CFG,
    ...memoryFs({
      [P.knownMarketplaces]: '{ not json',
      [P.marketplaceJson]: '',
      [P.installedPlugins]: '[]',
      [P.settings]: 'null',
    }),
  })
  assert.deepEqual(broken, {
    marketplaceRegistered: false,
    marketplaceInstallLocation: null,
    marketplaceLatest: null,
    installed: { present: false, version: null, installPath: null },
    enabled: false,
  })

  // A readFile that throws (permission denied) is absent too, never a throw.
  const throwing = await observeMarketplaceInstall({
    configDir: CFG,
    readFile: () => {
      throw new Error('EACCES')
    },
    exists: () => true,
  })
  assert.equal(throwing.marketplaceRegistered, false)
  assert.equal(throwing.installed.present, false)
})

test('observeMarketplaceInstall: a directory-source marketplace is read from installLocation, nothing under plugins/marketplaces', async () => {
  // win32 shaped install location, posix config dir: the marketplace.json path
  // follows the install location's own separator style.
  const win = await observeMarketplaceInstall({
    configDir: CFG,
    ...memoryFs({
      [P.knownMarketplaces]: JSON.stringify({
        hoai: { source: { source: 'directory', path: 'E:\\oneclick-e2e\\marketplace' }, installLocation: 'E:\\oneclick-e2e\\marketplace' },
      }),
      ['E:\\oneclick-e2e\\marketplace\\.claude-plugin\\marketplace.json']: JSON.stringify({
        name: 'hoai',
        plugins: [{ name: 'hoai', version: '0.38.4', source: { source: 'url', url: 'file:///E:/oneclick-e2e/plugin.git', ref: 'v0.38.4' } }],
      }),
    }),
  })
  assert.equal(win.marketplaceRegistered, true)
  assert.equal(win.marketplaceInstallLocation, 'E:\\oneclick-e2e\\marketplace')
  assert.deepEqual(win.marketplaceLatest, { version: '0.38.4', ref: 'v0.38.4' })

  const posix = await observeMarketplaceInstall({
    configDir: CFG,
    ...memoryFs({
      [P.knownMarketplaces]: JSON.stringify({ hoai: { source: { source: 'directory', path: '/srv/mkt' }, installLocation: '/srv/mkt' } }),
      ['/srv/mkt/.claude-plugin/marketplace.json']: MARKETPLACE,
      // A stale copy at the default location must NOT be consulted.
      [P.marketplaceJson]: JSON.stringify({ plugins: [{ name: 'hoai', source: { source: 'url', url: 'x', ref: 'v9.9.9' } }] }),
    }),
  })
  assert.equal(posix.marketplaceInstallLocation, '/srv/mkt')
  assert.deepEqual(posix.marketplaceLatest, { version: '0.38.3', ref: 'v0.38.3' })

  // installLocation set but its marketplace.json missing: null, no silent fallback.
  const missing = await observeMarketplaceInstall({
    configDir: CFG,
    ...memoryFs({
      [P.knownMarketplaces]: JSON.stringify({ hoai: { source: { source: 'directory', path: '/srv/gone' }, installLocation: '/srv/gone' } }),
      [P.marketplaceJson]: MARKETPLACE,
    }),
  })
  assert.equal(missing.marketplaceRegistered, true)
  assert.equal(missing.marketplaceInstallLocation, '/srv/gone')
  assert.equal(missing.marketplaceLatest, null)
})

test('observeMarketplaceInstall: default marketplace.json path is the fallback only when the registry entry lacks installLocation', async () => {
  const noLocation = await observeMarketplaceInstall({
    configDir: CFG,
    ...memoryFs({
      [P.knownMarketplaces]: JSON.stringify({ hoai: { source: { source: 'github', repo: 'BrandGrowthOS/hoai-marketplace' } } }),
      [P.marketplaceJson]: MARKETPLACE,
    }),
  })
  assert.equal(noLocation.marketplaceRegistered, true)
  assert.equal(noLocation.marketplaceInstallLocation, null)
  assert.deepEqual(noLocation.marketplaceLatest, { version: '0.38.3', ref: 'v0.38.3' })

  // Not registered at all, but a leftover marketplace.json exists: still read (it is the only evidence), registered stays false.
  const unregistered = await observeMarketplaceInstall({ configDir: CFG, ...memoryFs({ [P.marketplaceJson]: MARKETPLACE }) })
  assert.equal(unregistered.marketplaceRegistered, false)
  assert.equal(unregistered.marketplaceInstallLocation, null)
  assert.deepEqual(unregistered.marketplaceLatest, { version: '0.38.3', ref: 'v0.38.3' })
})

// ---------------------------------------------------------------------------
// runClaudeCli: normalisation and the injected runner
// ---------------------------------------------------------------------------

test('runClaudeCli: a throwing runner becomes code 127, never a rejection', async () => {
  const result = await runClaudeCli(listJsonArgs(), {
    runner: async () => {
      throw new Error('boom')
    },
  })
  assert.deepEqual(result, { code: CLI_NOT_FOUND_EXIT_CODE, stdout: '', stderr: 'boom', timedOut: false })
})

test('runClaudeCli: partial runner results are normalised and the runner sees CI=1 plus the default budget', async () => {
  const seen: Array<{ args: string[]; timeoutMs: number; env: Record<string, string | undefined> }> = []
  const result = await runClaudeCli(listJsonArgs(), {
    env: { EXTRA: 'yes' },
    runner: async (args, opts) => {
      seen.push({ args, timeoutMs: opts.timeoutMs, env: opts.env })
      return { code: 0, stdout: Buffer.from('[]') as unknown as string }
    },
  })
  assert.deepEqual(result, { code: 0, stdout: '[]', stderr: '', timedOut: false })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].args, ['plugin', 'list', '--json'])
  assert.equal(seen[0].timeoutMs, LIST_TIMEOUT_MS)
  assert.equal(seen[0].env.CI, '1')
  assert.equal(seen[0].env.EXTRA, 'yes')

  const explicit = await runClaudeCli(installArgs(), {
    timeoutMs: 1234,
    runner: async (_args, opts) => ({ code: 0, stdout: `${opts.timeoutMs}` }),
  })
  assert.equal(explicit.stdout, '1234')
})

test('normalizeCliResult: bad shapes collapse to a valid CliResult', () => {
  assert.deepEqual(normalizeCliResult(undefined), { code: null, stdout: '', stderr: '', timedOut: false })
  assert.deepEqual(normalizeCliResult({ code: '0' as unknown as number, stdout: 5 as unknown as string }), {
    code: null,
    stdout: '5',
    stderr: '',
    timedOut: false,
  })
  assert.deepEqual(normalizeCliResult({ code: 1, stderr: 'x', timedOut: true }), {
    code: 1,
    stdout: '',
    stderr: 'x',
    timedOut: true,
  })
})

// ---------------------------------------------------------------------------
// runClaudeCli: default runner + win32 candidate chain (injected spawn)
// ---------------------------------------------------------------------------

type SpawnStep = { error?: string; code?: number; stdout?: string; stderr?: string; hang?: boolean }

/** A scripted spawn: each call consumes the next step and replays it on a
 *  fake child (error / exit code / output / hang until killed). */
function scriptedSpawn(steps: SpawnStep[]) {
  const calls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = []
  const spawnImpl = (file: string, args: string[], opts: object) => {
    const step = steps[calls.length] ?? { code: 0 }
    calls.push({ file, args, opts: opts as Record<string, unknown> })
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      pid: number
      killed: boolean
      kill: () => boolean
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 4242
    child.killed = false
    child.kill = () => {
      child.killed = true
      process.nextTick(() => child.emit('close', null, 'SIGTERM'))
      return true
    }
    process.nextTick(() => {
      if (step.error) {
        child.emit('error', Object.assign(new Error(`spawn ${file} ${step.error}`), { code: step.error }))
        return
      }
      if (step.hang) return
      if (step.stdout) child.stdout.emit('data', Buffer.from(step.stdout))
      if (step.stderr) child.stderr.emit('data', Buffer.from(step.stderr))
      child.emit('exit', step.code ?? 0, null)
      child.emit('close', step.code ?? 0, null)
    })
    return child
  }
  return { spawnImpl, calls }
}

test('claudeCliCandidates mirrors hoai-core: single claude on posix, claude / ComSpec claude.cmd / claude.exe on win32', () => {
  assert.deepEqual(claudeCliCandidates(['plugin', 'list'], 'linux', {}), [
    { file: 'claude', args: ['plugin', 'list'], notFoundExitCodes: [] },
  ])
  assert.deepEqual(claudeCliCandidates(['plugin', 'list'], 'darwin', { ComSpec: 'ignored' }), [
    { file: 'claude', args: ['plugin', 'list'], notFoundExitCodes: [] },
  ])
  assert.deepEqual(claudeCliCandidates(['plugin', 'list'], 'win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }), [
    { file: 'claude', args: ['plugin', 'list'], notFoundExitCodes: [] },
    { file: 'C:\\Windows\\system32\\cmd.exe', args: ['/c', 'claude.cmd', 'plugin', 'list'], notFoundExitCodes: [9009] },
    { file: 'claude.exe', args: ['plugin', 'list'], notFoundExitCodes: [] },
  ])
  assert.equal(claudeCliCandidates([], 'win32', { COMSPEC: 'D:\\cmd.exe' })[1].file, 'D:\\cmd.exe')
  assert.equal(claudeCliCandidates([], 'win32', {})[1].file, 'cmd.exe')
})

test('claudeCliCandidates never drifts from bin/hoai-core.mjs claudeSpawnCandidates', async () => {
  const { claudeSpawnCandidates } = await import('../bin/hoai-core.mjs')
  const args = ['plugin', 'install', 'hoai@hoai', '--scope', 'user', '-y']
  for (const [platform, env] of [
    ['linux', {}],
    ['darwin', {}],
    ['win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }],
    ['win32', { COMSPEC: 'D:\\cmd.exe' }],
    ['win32', {}],
  ] as Array<[string, Record<string, string>]>) {
    assert.deepEqual(claudeCliCandidates(args, platform, env), claudeSpawnCandidates(args, platform, env), platform)
  }
})

test('win32 chain: ENOENT on claude, 9009 from cmd /c claude.cmd, claude.exe answers', async () => {
  const { spawnImpl, calls } = scriptedSpawn([{ error: 'ENOENT' }, { code: 9009 }, { code: 0, stdout: '[]' }])
  const result = await runClaudeCli(listJsonArgs(), {
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    spawnImpl,
  })
  assert.deepEqual(result, { code: 0, stdout: '[]', stderr: '', timedOut: false })
  assert.deepEqual(
    calls.map((c) => [c.file, ...c.args]),
    [
      ['claude', 'plugin', 'list', '--json'],
      ['C:\\Windows\\system32\\cmd.exe', '/c', 'claude.cmd', 'plugin', 'list', '--json'],
      ['claude.exe', 'plugin', 'list', '--json'],
    ],
  )
  // Non-TTY contract: stdin ignored, output piped, no shell, hidden window.
  for (const call of calls) {
    assert.deepEqual(call.opts.stdio, ['ignore', 'pipe', 'pipe'])
    assert.equal(call.opts.shell, false)
    assert.equal(call.opts.windowsHide, true)
    assert.equal((call.opts.env as Record<string, string>).CI, '1')
  }
})

test('win32 chain: EINVAL also means not found; the first candidate that runs wins even with rc 1', async () => {
  const { spawnImpl, calls } = scriptedSpawn([{ error: 'EINVAL' }, { code: 1, stderr: 'boom' }])
  const result = await runClaudeCli(installArgs(), { platform: 'win32', env: { ComSpec: 'cmd.exe' }, spawnImpl })
  assert.deepEqual(result, { code: 1, stdout: '', stderr: 'boom', timedOut: false })
  assert.equal(calls.length, 2)
})

test('chain exhausted: 127 with an install hint; posix tries claude once', async () => {
  const win = scriptedSpawn([{ error: 'ENOENT' }, { code: 9009 }, { error: 'ENOENT' }])
  const missing = await runClaudeCli(listJsonArgs(), { platform: 'win32', env: { ComSpec: 'cmd.exe' }, spawnImpl: win.spawnImpl })
  assert.equal(missing.code, CLI_NOT_FOUND_EXIT_CODE)
  assert.match(missing.stderr, /claude was not found/)
  assert.equal(win.calls.length, 3)

  const posix = scriptedSpawn([{ error: 'ENOENT' }])
  const none = await runClaudeCli(listJsonArgs(), { platform: 'linux', spawnImpl: posix.spawnImpl })
  assert.equal(none.code, CLI_NOT_FOUND_EXIT_CODE)
  assert.equal(posix.calls.length, 1)
  assert.equal(posix.calls[0].file, 'claude')
})

test('a spawn error that is not "not found" stops the chain with 127 and names the candidate', async () => {
  const { spawnImpl, calls } = scriptedSpawn([{ error: 'EACCES' }, { code: 0, stdout: 'never' }])
  const result = await runClaudeCli(listJsonArgs(), { platform: 'win32', env: { ComSpec: 'cmd.exe' }, spawnImpl })
  assert.equal(result.code, CLI_NOT_FOUND_EXIT_CODE)
  assert.match(result.stderr, /could not start claude/)
  assert.match(result.stderr, /EACCES/)
  assert.equal(calls.length, 1)
})

test('default runner: a hanging child is killed at the budget and reports timedOut with code null', async () => {
  const { spawnImpl, calls } = scriptedSpawn([{ hang: true }])
  const result = await runClaudeCli(listJsonArgs(), { platform: 'linux', spawnImpl, timeoutMs: 50 })
  assert.equal(result.timedOut, true)
  assert.equal(result.code, null)
  assert.equal(calls.length, 1)
})

// ---------------------------------------------------------------------------
// The sandbox fake CLI (a real child process)
// ---------------------------------------------------------------------------

/** Run one test body with a fresh sandbox, cleaned up whatever happens. */
async function withSandbox(body: (sandbox: Sandbox) => Promise<void>) {
  const sandbox = makeSandbox()
  try {
    await body(sandbox)
  } finally {
    sandbox.cleanup()
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

test('fake claude: the full lifecycle mutates the config dir the way 2.1.241 does', async () => {
  await withSandbox(async (sandbox) => {
    const runner = cliRunnerFor(sandbox)
    const run = (args: string[]) => runClaudeCli(args, { runner, timeoutMs: 20_000 })
    const paths = marketplaceConfigPaths(sandbox.configDir)
    sandbox.writeScenario({ state: { version: '0.38.3' } })

    // 1. marketplace add: registers, then is idempotent.
    const added = await run(marketplaceAddArgs())
    assert.equal(added.code, 0, added.stderr)
    assert.equal(classifyMarketplaceAdd(added).kind, 'registered')
    assert.ok(existsSync(paths.knownMarketplaces))
    assert.ok(existsSync(paths.marketplaceJson))
    const known = readJson(paths.knownMarketplaces) as Record<string, { source: { repo: string }; installLocation: string }>
    assert.equal(known.hoai.source.repo, 'BrandGrowthOS/hoai-marketplace')
    assert.equal(known.hoai.installLocation, join(sandbox.configDir, 'plugins', 'marketplaces', 'hoai'))
    const settings1 = readJson(paths.settings) as { extraKnownMarketplaces: Record<string, unknown> }
    assert.ok(settings1.extraKnownMarketplaces.hoai)
    assert.deepEqual(readMarketplaceLatest(readFileSync(paths.marketplaceJson, 'utf8')), { version: '0.38.3', ref: 'v0.38.3' })

    const again = await run(marketplaceAddArgs())
    assert.equal(classifyMarketplaceAdd(again).kind, 'already')

    // 2. marketplace update: refreshes, nothing newer declared.
    const refreshed = await run(marketplaceUpdateArgs())
    assert.equal(classifyMarketplaceUpdate(refreshed).kind, 'updated')
    assert.equal(refreshed.stdout, 'Updating marketplace: hoai...\n✔ Successfully updated marketplace: hoai\n')

    // 3. install: cache dir + installed_plugins entry + enabledPlugins.
    const installed = await run(installArgs())
    assert.equal(classifyInstall(installed).kind, 'installed', installed.stderr)
    const cache0383 = join(paths.cacheDir, '0.38.3')
    assert.ok(existsSync(join(cache0383, '.claude-plugin', 'plugin.json')))
    const installedDoc = readJson(paths.installedPlugins) as {
      version: number
      plugins: Record<string, Array<{ scope: string; version: string; installPath: string }>>
    }
    assert.equal(installedDoc.version, 2)
    assert.equal(installedDoc.plugins['hoai@hoai'][0].scope, 'user')
    assert.equal(installedDoc.plugins['hoai@hoai'][0].version, '0.38.3')
    assert.equal(installedDoc.plugins['hoai@hoai'][0].installPath, cache0383)
    const settings2 = readJson(paths.settings) as { enabledPlugins: Record<string, boolean> }
    assert.equal(settings2.enabledPlugins['hoai@hoai'], true)

    assert.equal(classifyInstall(await run(installArgs())).kind, 'already')

    // 4. list --json reads back the install.
    const listed = await run(listJsonArgs())
    assert.equal(listed.code, 0)
    const entries = parsePluginListJson(listed.stdout)
    assert.ok(entries)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].id, 'hoai@hoai')
    assert.equal(entries[0].version, '0.38.3')
    assert.equal(entries[0].installPath, cache0383)
    assert.equal(entries[0].enabled, true)

    // 5. update with nothing newer.
    const current = classifyUpdate(await run(updateArgs()))
    assert.equal(current.kind, 'already_latest')
    assert.equal(current.version, '0.38.3')
    const entryBefore = (readJson(paths.installedPlugins) as { plugins: Record<string, Array<Record<string, string>>> }).plugins['hoai@hoai'][0]

    // 6. The observer over the real fs agrees with the files.
    const seen = await observeMarketplaceInstall({ configDir: sandbox.configDir })
    assert.equal(seen.marketplaceRegistered, true)
    assert.deepEqual(seen.marketplaceLatest, { version: '0.38.3', ref: 'v0.38.3' })
    assert.deepEqual(seen.installed, { present: true, version: '0.38.3', installPath: cache0383 })
    assert.equal(seen.enabled, true)

    // 7. A newer release lands in the marketplace: refresh, then update.
    sandbox.writeScenario({ state: { version: '0.38.3', nextVersion: '0.38.4' } })
    assert.equal(classifyMarketplaceUpdate(await run(marketplaceUpdateArgs())).kind, 'updated')
    assert.deepEqual(readMarketplaceLatest(readFileSync(paths.marketplaceJson, 'utf8')), { version: '0.38.4', ref: 'v0.38.4' })
    const updated = await run(updateArgs())
    // The exact 2.1.241 stdout of a real update, so the classifier is pinned on reality.
    assert.equal(updated.stdout, REAL_UPDATE_STDOUT)
    const verdict = classifyUpdate(updated)
    assert.equal(verdict.kind, 'updated', updated.stdout + updated.stderr)
    assert.equal(verdict.fromVersion, '0.38.3')
    assert.equal(verdict.toVersion, '0.38.4')
    const cache0384 = join(paths.cacheDir, '0.38.4')
    assert.ok(existsSync(join(cache0384, '.claude-plugin', 'plugin.json')))
    assert.ok(existsSync(cache0383), 'the old cache dir stays on disk after update')
    const after = await observeMarketplaceInstall({ configDir: sandbox.configDir })
    assert.deepEqual(after.installed, { present: true, version: '0.38.4', installPath: cache0384 })
    // installed_plugins.json is re-pointed (installPath, version, lastUpdated); installedAt and
    // gitCommitSha stay as they were (the real CLI leaves the sha stale, never rely on it).
    const entryAfter = (readJson(paths.installedPlugins) as { plugins: Record<string, Array<Record<string, string>>> }).plugins['hoai@hoai'][0]
    assert.equal(entryAfter.version, '0.38.4')
    assert.equal(entryAfter.installPath, cache0384)
    assert.equal(entryAfter.installedAt, entryBefore.installedAt)
    assert.equal(entryAfter.gitCommitSha, entryBefore.gitCommitSha)
    assert.notEqual(entryAfter.lastUpdated, entryBefore.lastUpdated)
    assert.equal(classifyUpdate(await run(updateArgs())).kind, 'already_latest')

    // 8. uninstall: entry gone, cache dirs survive, second uninstall is the benign rc 1.
    assert.equal(classifyUninstall(await run(uninstallArgs())).kind, 'uninstalled')
    const gone = await observeMarketplaceInstall({ configDir: sandbox.configDir })
    assert.deepEqual(gone.installed, { present: false, version: null, installPath: null })
    assert.equal(gone.enabled, false)
    assert.equal(gone.marketplaceRegistered, true)
    assert.ok(existsSync(cache0383))
    assert.ok(existsSync(cache0384))
    assert.deepEqual(parsePluginListJson((await run(listJsonArgs())).stdout), [])
    const twice = await run(uninstallArgs())
    assert.equal(twice.code, 1)
    assert.equal(classifyUninstall(twice).kind, 'not_installed')

    // 9. The call log is the exact command sequence.
    const log = sandbox.readCallLog()
    assert.deepEqual(
      log.map((entry) => entry.argv.join(' ')),
      [
        marketplaceAddArgs(),
        marketplaceAddArgs(),
        marketplaceUpdateArgs(),
        installArgs(),
        installArgs(),
        listJsonArgs(),
        updateArgs(),
        marketplaceUpdateArgs(),
        updateArgs(),
        updateArgs(),
        uninstallArgs(),
        listJsonArgs(),
        uninstallArgs(),
      ].map((argv) => argv.join(' ')),
    )
    assert.ok(log.every((entry) => entry.outcome === 'success'))
  })
})

test('fake claude: install before marketplace add fails realistically and mutates nothing', async () => {
  await withSandbox(async (sandbox) => {
    sandbox.writeScenario({})
    const result = await runClaudeCli(installArgs(), { runner: cliRunnerFor(sandbox), timeoutMs: 20_000 })
    assert.equal(result.code, 1)
    const verdict = classifyInstall(result)
    assert.equal(verdict.kind, 'failed')
    assert.match(verdict.message, /Marketplace "hoai" not found/)
    assert.ok(!existsSync(marketplaceConfigPaths(sandbox.configDir).installedPlugins))
  })
})

test('fake claude: scripted failure outcome returns the scenario rc and stderr, touches no files', async () => {
  await withSandbox(async (sandbox) => {
    const runner = cliRunnerFor(sandbox)
    sandbox.writeScenario({ state: { version: '0.38.3' } })
    await runClaudeCli(marketplaceAddArgs(), { runner, timeoutMs: 20_000 })
    sandbox.writeScenario({
      state: { version: '0.38.3' },
      commands: {
        [installArgs().join(' ')]: {
          outcome: 'failure',
          code: 3,
          stderr: '\u2718 Failed to install plugin "hoai@hoai": git clone failed: network unreachable\n',
        },
      },
    })
    const result = await runClaudeCli(installArgs(), { runner, timeoutMs: 20_000 })
    assert.equal(result.code, 3)
    const verdict = classifyInstall(result)
    assert.equal(verdict.kind, 'failed')
    assert.equal(verdict.message, 'Failed to install plugin "hoai@hoai": git clone failed: network unreachable')
    const seen = await observeMarketplaceInstall({ configDir: sandbox.configDir })
    assert.equal(seen.installed.present, false)
    assert.equal(sandbox.readCallLog().at(-1)?.outcome, 'failure')
    // A failure with no explicit text still names the command.
    sandbox.writeScenario({ default: { outcome: 'failure' } })
    const bare = await runClaudeCli(updateArgs(), { runner, timeoutMs: 20_000 })
    assert.equal(bare.code, 1)
    assert.match(classifyUpdate(bare).message, /Failed to update plugin/)
  })
})

test('fake claude: garbage outcome is rc 0 with junk bytes and every classifier says garbage', async () => {
  await withSandbox(async (sandbox) => {
    const runner = cliRunnerFor(sandbox)
    sandbox.writeScenario({ default: { outcome: 'garbage' } })
    const list = await runClaudeCli(listJsonArgs(), { runner, timeoutMs: 20_000 })
    assert.equal(list.code, 0)
    assert.ok(list.stdout.length > 0)
    assert.equal(parsePluginListJson(list.stdout), null)
    const install = await runClaudeCli(installArgs(), { runner, timeoutMs: 20_000 })
    assert.equal(install.code, 0)
    assert.equal(classifyInstall(install).kind, 'garbage')
    assert.equal(classifyMarketplaceAdd(await runClaudeCli(marketplaceAddArgs(), { runner, timeoutMs: 20_000 })).kind, 'garbage')
    assert.equal(classifyUpdate(await runClaudeCli(updateArgs(), { runner, timeoutMs: 20_000 })).kind, 'garbage')
    assert.equal(classifyUninstall(await runClaudeCli(uninstallArgs(), { runner, timeoutMs: 20_000 })).kind, 'garbage')
    assert.ok(!existsSync(marketplaceConfigPaths(sandbox.configDir).knownMarketplaces))
  })
})

test('fake claude: hang outcome is killed at the budget, timedOut true, code null, still logged', async () => {
  await withSandbox(async (sandbox) => {
    sandbox.writeScenario({ commands: { [updateArgs().join(' ')]: { outcome: 'hang' } } })
    const started = Date.now()
    const result = await runClaudeCli(updateArgs(), { runner: cliRunnerFor(sandbox), timeoutMs: 400 })
    const elapsed = Date.now() - started
    assert.equal(result.timedOut, true)
    assert.equal(result.code, null)
    assert.ok(elapsed < 10_000, `killed promptly, took ${elapsed} ms`)
    assert.equal(classifyUpdate(result).kind, 'failed')
    assert.equal(sandbox.readCallLog().at(-1)?.outcome, 'hang')
  })
})

test('fake claude: success_wrong_version prints success but installs another version', async () => {
  await withSandbox(async (sandbox) => {
    const runner = cliRunnerFor(sandbox)
    sandbox.writeScenario({
      state: { version: '0.38.3' },
      commands: { [installArgs().join(' ')]: { outcome: 'success_wrong_version', version: '0.38.1' } },
    })
    await runClaudeCli(marketplaceAddArgs(), { runner, timeoutMs: 20_000 })
    const result = await runClaudeCli(installArgs(), { runner, timeoutMs: 20_000 })
    assert.equal(classifyInstall(result).kind, 'installed')
    const seen = await observeMarketplaceInstall({ configDir: sandbox.configDir })
    assert.equal(seen.installed.version, '0.38.1')
    assert.deepEqual(seen.marketplaceLatest, { version: '0.38.3', ref: 'v0.38.3' })
    const listed = parsePluginListJson((await runClaudeCli(listJsonArgs(), { runner, timeoutMs: 20_000 })).stdout)
    assert.equal(listed?.[0].version, '0.38.1')
  })
})

test('fake claude: delayMs delays the outcome, explicit stdout overrides the realistic text', async () => {
  await withSandbox(async (sandbox) => {
    const runner = cliRunnerFor(sandbox)
    sandbox.writeScenario({
      commands: { [marketplaceAddArgs().join(' ')]: { delayMs: 150, stdout: 'custom text\n' } },
    })
    const started = Date.now()
    const result = await runClaudeCli(marketplaceAddArgs(), { runner, timeoutMs: 20_000 })
    assert.ok(Date.now() - started >= 140)
    assert.equal(result.code, 0)
    assert.equal(result.stdout, 'custom text\n')
    // The mutation still happened: the scenario only overrode the text.
    assert.ok(existsSync(marketplaceConfigPaths(sandbox.configDir).knownMarketplaces))
    assert.equal(classifyMarketplaceAdd(result).kind, 'garbage')
  })
})

test('fake claude: missing scenario or config dir exits 2 with a named reason', async () => {
  await withSandbox(async (sandbox) => {
    const noScenario = await runClaudeCli(listJsonArgs(), {
      runner: cliRunnerFor(sandbox, { env: { FAKE_CLAUDE_SCENARIO: join(sandbox.root, 'missing.json') } }),
      timeoutMs: 20_000,
    })
    assert.equal(noScenario.code, 2)
    assert.match(noScenario.stderr, /FAKE_CLAUDE_SCENARIO/)
    const noConfig = await runClaudeCli(listJsonArgs(), {
      runner: cliRunnerFor(sandbox, { env: { CLAUDE_CONFIG_DIR: '' } }),
      timeoutMs: 20_000,
    })
    assert.equal(noConfig.code, 2)
    assert.match(noConfig.stderr, /CLAUDE_CONFIG_DIR/)
  })
})

test('fake claude: a directory marketplace registers with installLocation outside the config dir and copies nothing', async () => {
  await withSandbox(async (sandbox) => {
    const runner = cliRunnerFor(sandbox)
    const run = (args: string[]) => runClaudeCli(args, { runner, timeoutMs: 20_000 })
    const paths = marketplaceConfigPaths(sandbox.configDir)
    sandbox.writeScenario({})
    const dir = sandbox.writeLocalMarketplace('0.38.3')
    assert.ok(existsSync(join(dir, '.claude-plugin', 'marketplace.json')))

    const added = await run(['plugin', 'marketplace', 'add', dir])
    assert.equal(classifyMarketplaceAdd(added).kind, 'registered', added.stderr)
    const known = readJson(paths.knownMarketplaces) as Record<string, { source: Record<string, string>; installLocation: string }>
    assert.deepEqual(known.hoai.source, { source: 'directory', path: dir })
    assert.equal(known.hoai.installLocation, dir)
    assert.ok(!existsSync(join(sandbox.configDir, 'plugins', 'marketplaces', 'hoai')), 'nothing is copied under the config dir')
    assert.equal(classifyMarketplaceAdd(await run(['plugin', 'marketplace', 'add', dir])).kind, 'already')

    const seen = await observeMarketplaceInstall({ configDir: sandbox.configDir })
    assert.equal(seen.marketplaceRegistered, true)
    assert.equal(seen.marketplaceInstallLocation, dir)
    assert.deepEqual(seen.marketplaceLatest, { version: '0.38.3', ref: 'v0.38.3' })

    // install reads the version the directory declares.
    assert.equal(classifyInstall(await run(installArgs())).kind, 'installed')
    assert.equal((await observeMarketplaceInstall({ configDir: sandbox.configDir })).installed.version, '0.38.3')

    // A new release lands in the directory; marketplace update re-validates it (the real
    // directory-source stdout), then plugin update moves to it.
    sandbox.writeLocalMarketplace('0.38.4')
    const refreshed = await run(marketplaceUpdateArgs())
    assert.equal(refreshed.stdout, 'Updating marketplace: hoai...Validating local marketplace\n✔ Successfully updated marketplace: hoai\n')
    assert.equal(classifyMarketplaceUpdate(refreshed).kind, 'updated')
    assert.deepEqual((await observeMarketplaceInstall({ configDir: sandbox.configDir })).marketplaceLatest, { version: '0.38.4', ref: 'v0.38.4' })
    const updated = classifyUpdate(await run(updateArgs()))
    assert.equal(updated.kind, 'updated')
    assert.equal(updated.fromVersion, '0.38.3')
    assert.equal(updated.toVersion, '0.38.4')
    assert.equal((await observeMarketplaceInstall({ configDir: sandbox.configDir })).installed.version, '0.38.4')

    // A directory that is not a marketplace is refused, and nothing is registered.
    const fresh = makeSandbox()
    try {
      fresh.writeScenario({})
      const bad = await runClaudeCli(['plugin', 'marketplace', 'add', join(fresh.root, 'not-a-marketplace')], {
        runner: cliRunnerFor(fresh),
        timeoutMs: 20_000,
      })
      assert.equal(classifyMarketplaceAdd(bad).kind, 'failed')
      assert.equal((await observeMarketplaceInstall({ configDir: fresh.configDir })).marketplaceRegistered, false)
    } finally {
      fresh.cleanup()
    }
  })
})

test('sandbox: seed helpers write the same shapes the fake CLI does', async () => {
  await withSandbox(async (sandbox) => {
    sandbox.seedMarketplace('0.38.3')
    sandbox.seedInstalled('0.38.2')
    const seen = await observeMarketplaceInstall({ configDir: sandbox.configDir })
    assert.equal(seen.marketplaceRegistered, true)
    assert.deepEqual(seen.marketplaceLatest, { version: '0.38.3', ref: 'v0.38.3' })
    assert.equal(seen.installed.version, '0.38.2')
    assert.equal(seen.enabled, true)
    sandbox.writeScenario({})
    const updated = await runClaudeCli(updateArgs(), { runner: cliRunnerFor(sandbox), timeoutMs: 20_000 })
    assert.equal(classifyUpdate(updated).kind, 'updated')
    assert.equal((await observeMarketplaceInstall({ configDir: sandbox.configDir })).installed.version, '0.38.3')
    assert.ok(existsSync(join(sandbox.configDir, 'plugins', 'cache', 'hoai', 'hoai', '0.38.2')))
    const disabled = makeSandbox()
    try {
      disabled.seedMarketplace('0.38.3')
      disabled.seedInstalled('0.38.3', { enabled: false })
      const d = await observeMarketplaceInstall({ configDir: disabled.configDir })
      assert.equal(d.installed.present, true)
      assert.equal(d.enabled, false)
    } finally {
      disabled.cleanup()
    }
  })
})
