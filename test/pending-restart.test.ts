/**
 * lib/pending-restart.ts: the daemon's pendingRestartVersion, for both
 * install methods (design fact 6 and section 7).
 *
 * Fact 6: on a marketplace install selfUpdater is null and auto-update.json is
 * written only by the clone updater, so updateReadiness.pendingRestartVersion
 * was ALWAYS null there. A marketplace agent whose plugin Claude Code had
 * already updated reported nothing pending, and the app could not even say it
 * was staged. The marketplace answer is the installed version in
 * <config>/plugins/installed_plugins.json against the version captured at boot.
 *
 * Run: npx tsx --test test/pending-restart.test.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  installedPluginsPath,
  readInstalledPluginVersion,
  resolvePendingRestartVersion,
} from '../lib/pending-restart.ts'

const installedDoc = (version: string | null, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 2,
    plugins: {
      'hoai@hoai': [
        { scope: 'project', projectPath: '/elsewhere', version: '0.1.0', installPath: '/c/p' },
        { scope: 'user', version, installPath: `/c/plugins/cache/hoai/hoai/${version}`, ...extra },
      ],
    },
  })

test('marketplace: the installed version that is not the running one is the pending restart', () => {
  const cases: Array<[string, string | null, string | null, string | null]> = [
    // name, running, installed_plugins.json text, expected
    ['installed ahead of running', '0.62.0', installedDoc('0.62.1'), '0.62.1'],
    ['installed equals running', '0.62.1', installedDoc('0.62.1'), null],
    ['no installed_plugins.json', '0.62.0', null, null],
    ['malformed json', '0.62.0', '{"plugins": ', null],
    ['no hoai entry', '0.62.0', JSON.stringify({ version: 2, plugins: { 'other@x': [{ version: '1.0.0' }] } }), null],
    ['entry without a version', '0.62.0', installedDoc(null), null],
    ['running version unknown', null, installedDoc('0.62.1'), null],
  ]
  for (const [name, running, raw, expected] of cases) {
    const got = resolvePendingRestartVersion({
      installMethod: 'marketplace',
      runningVersion: running,
      updaterPending: () => '9.9.9',
      stagedTargetVersion: () => '8.8.8',
      readInstalledPlugins: () => raw,
    })
    assert.equal(got, expected, name)
  }
})

test('clone: the git updater answers first, then the staged target; installed_plugins.json is never read', () => {
  let reads = 0
  const readInstalledPlugins = () => {
    reads += 1
    return installedDoc('7.7.7')
  }
  assert.equal(
    resolvePendingRestartVersion({
      installMethod: 'clone',
      runningVersion: '0.62.0',
      updaterPending: () => '0.62.2',
      stagedTargetVersion: () => '0.62.1',
      readInstalledPlugins,
    }),
    '0.62.2',
  )
  assert.equal(
    resolvePendingRestartVersion({
      installMethod: 'clone',
      runningVersion: '0.62.0',
      updaterPending: () => null,
      stagedTargetVersion: () => '0.62.1',
      readInstalledPlugins,
    }),
    '0.62.1',
  )
  assert.equal(
    resolvePendingRestartVersion({
      installMethod: 'clone',
      runningVersion: '0.62.1',
      updaterPending: () => null,
      stagedTargetVersion: () => '0.62.1',
      readInstalledPlugins,
    }),
    null,
  )
  assert.equal(reads, 0)
})

test('never throws: a reader that throws is "nothing pending"', () => {
  assert.equal(
    resolvePendingRestartVersion({
      installMethod: 'marketplace',
      runningVersion: '0.62.0',
      updaterPending: () => null,
      stagedTargetVersion: () => null,
      readInstalledPlugins: () => {
        throw new Error('EACCES')
      },
    }),
    null,
  )
})

test('the installed_plugins.json path and reader follow the config dir (CLAUDE_CONFIG_DIR moves it)', () => {
  assert.equal(installedPluginsPath('/h/.claude'), '/h/.claude/plugins/installed_plugins.json')
  assert.equal(installedPluginsPath('/h/.claude-alt'), '/h/.claude-alt/plugins/installed_plugins.json')
  const seen: string[] = []
  const version = readInstalledPluginVersion('/h/.claude', (p) => {
    seen.push(p)
    return installedDoc('0.63.0')
  })
  assert.equal(version, '0.63.0')
  assert.deepEqual(seen, ['/h/.claude/plugins/installed_plugins.json'])
})

test('server.ts: the heartbeat readiness takes pendingRestartVersion from the shared composition', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const server = readFileSync(join(root, 'server.ts'), 'utf8')
  const start = server.indexOf('function updateReadinessSnapshot(): UpdateReadiness {')
  const body = server.slice(start, server.indexOf('\n}\n', start))
  assert.ok(start > 0)
  assert.match(body, /pendingRestartVersion: daemonPendingRestartVersion\(/)
  const helper = server.slice(server.indexOf('function daemonPendingRestartVersion('))
  assert.match(helper.slice(0, 1500), /resolvePendingRestartVersion\(\{[\s\S]*installMethod: INSTALL_METHOD[\s\S]*runningVersion: RUNNING_VERSION/)
})
