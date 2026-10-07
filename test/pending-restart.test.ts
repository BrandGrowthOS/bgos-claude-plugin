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
 * E5 (end to end run, 2026-10-07): on a CLONE install the answer came only
 * from the daemon's own self updater (its live state, else auto-update.json
 * validationPending), so a clone moved by git pull, bgos-agent update or any
 * other path reported nothing pending; the watcher believes a fresh daemon
 * (decidePendingRestart, review daemon F7), so both sandbox agents stayed
 * 'supervised' on 0.61.5 with 0.62.0 on disk. The clone answer now falls back
 * to the version in the package.json of the root this daemon runs from,
 * against the version captured at boot. The self updater still wins when set.
 *
 * Run: npx tsx --test test/pending-restart.test.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  installedPluginsPath,
  readInstalledPluginVersion,
  resolvePendingRestartVersion,
} from '../lib/pending-restart.ts'
import { readOwnVersion } from '../lib/version-heartbeat.ts'
import { decidePendingRestart } from '../lib/keepalive-plan.mjs'

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
  // The marketplace answer stays as it was (E5 changes the clone only): the
  // checkout package.json is never consulted there.
  let checkoutReads = 0
  for (const [name, running, raw, expected] of cases) {
    const got = resolvePendingRestartVersion({
      installMethod: 'marketplace',
      runningVersion: running,
      updaterPending: () => '9.9.9',
      stagedTargetVersion: () => '8.8.8',
      readInstalledPlugins: () => raw,
      readCheckoutVersion: () => {
        checkoutReads += 1
        return '7.7.7'
      },
    })
    assert.equal(got, expected, name)
  }
  assert.equal(checkoutReads, 0, 'a marketplace install never reads the checkout package.json')
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
      readCheckoutVersion: () => '0.62.0',
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
      readCheckoutVersion: () => '0.62.0',
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
      readCheckoutVersion: () => '0.62.1',
    }),
    null,
  )
  assert.equal(reads, 0)
})

test('clone (E5): the checkout package.json against the running version, after the self updater', () => {
  type Reader = () => string | null
  const boom: Reader = () => {
    throw new Error('EACCES')
  }
  const cases: Array<[string, string | null, Reader, Reader, Reader, string | null]> = [
    // name, running, self updater live answer, auto-update.json staged target, checkout package.json version, expected
    ['the E5 case: a clone moved outside the self updater (git pull, bgos-agent update)', '0.61.5', () => null, () => null, () => '0.62.0', '0.62.0'],
    ['checkout equals running: nothing pending', '0.62.0', () => null, () => null, () => '0.62.0', null],
    ['the self updater wins over the checkout when set', '0.61.5', () => '0.62.1', () => null, () => '0.62.0', '0.62.1'],
    ['the staged auto-update.json target wins over the checkout when set', '0.61.5', () => null, () => '0.62.1', () => '0.62.0', '0.62.1'],
    ['a staged target equal to running (validating it) leaves the checkout to answer', '0.62.0', () => null, () => '0.62.0', () => '0.62.1', '0.62.1'],
    ['an older checkout (rolled back on disk) also differs', '0.62.0', () => null, () => null, () => '0.61.5', '0.61.5'],
    ['checkout unreadable (missing, mid write, not x.y.z)', '0.61.5', () => null, () => null, () => null, null],
    ['checkout blank', '0.61.5', () => null, () => null, () => '  ', null],
    ['checkout padded is trimmed', '0.61.5', () => null, () => null, () => ' 0.62.0 ', '0.62.0'],
    ['running version unknown (unreadable at boot)', null, () => null, () => null, () => '0.62.0', null],
    ['the checkout reader throws: nothing pending, never a throw', '0.61.5', () => null, () => null, boom, null],
    ['the checkout reader throws but the self updater answered', '0.61.5', () => '0.62.1', () => null, boom, '0.62.1'],
    ['the self updater throws: the checkout still answers', '0.61.5', boom, () => null, () => '0.62.0', '0.62.0'],
    ['auto-update.json read throws: the checkout still answers', '0.61.5', () => null, boom, () => '0.62.0', '0.62.0'],
    ['the self updater names an empty string: not a version, the checkout answers', '0.61.5', () => '', () => null, () => '0.62.0', '0.62.0'],
  ]
  for (const [name, running, updaterPending, stagedTargetVersion, readCheckoutVersion, expected] of cases) {
    const got = resolvePendingRestartVersion({
      installMethod: 'clone',
      runningVersion: running,
      updaterPending,
      stagedTargetVersion,
      readInstalledPlugins: () => installedDoc('7.7.7'),
      readCheckoutVersion,
    })
    assert.equal(got, expected, name)
  }
})

test('clone (E5): the checkout is read only when the self updater has nothing, and on every call (no cache)', () => {
  let checkoutReads = 0
  let onDisk = '0.61.5'
  const input = (updater: string | null) => ({
    installMethod: 'clone' as const,
    runningVersion: '0.61.5',
    updaterPending: () => updater,
    stagedTargetVersion: () => null,
    readInstalledPlugins: () => null,
    readCheckoutVersion: () => {
      checkoutReads += 1
      return onDisk
    },
  })
  assert.equal(resolvePendingRestartVersion(input('0.62.1')), '0.62.1')
  assert.equal(checkoutReads, 0, 'the self updater answered: the checkout is not read')
  assert.equal(resolvePendingRestartVersion(input(null)), null)
  onDisk = '0.62.0'
  assert.equal(resolvePendingRestartVersion(input(null)), '0.62.0', 'a later call sees the moved checkout')
  assert.equal(checkoutReads, 2)
})

test('clone (E5), with the real reader: a checkout moved under a running daemon is reported, and the watcher restarts it', () => {
  const root = mkdtempSync(join(tmpdir(), 'pending-restart-e5-'))
  try {
    const writeVersion = (version: string) =>
      writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'claude-channel-bgos', version }, null, 2)}\n`)
    writeVersion('0.61.5')
    // Captured ONCE at boot, from the same root, exactly as server.ts does.
    const runningVersion = readOwnVersion(root)
    assert.equal(runningVersion, '0.61.5')
    const pending = () =>
      resolvePendingRestartVersion({
        installMethod: 'clone',
        runningVersion,
        // The sandbox case: no self updater value, no auto-update.json target.
        updaterPending: () => null,
        stagedTargetVersion: () => null,
        readInstalledPlugins: () => null,
        readCheckoutVersion: () => readOwnVersion(root),
      })
    assert.equal(pending(), null, 'nothing moved yet')
    writeVersion('0.62.0')
    assert.equal(pending(), '0.62.0', 'git pull moved the checkout: 0.62.0 is on disk, 0.61.5 runs')
    writeFileSync(join(root, 'package.json'), '{"name": "claude-channel-bgos", "vers')
    assert.equal(pending(), null, 'a package.json caught mid write is nothing pending, never a throw')
    rmSync(join(root, 'package.json'))
    assert.equal(pending(), null, 'a missing package.json is nothing pending')
    writeVersion('0.62.0')
    // What the watcher does with the fresh daemon's answer (decidePendingRestart,
    // review daemon F7): before E5 it read null here and the agent stayed 'supervised'.
    assert.deepEqual(
      decidePendingRestart({
        canonical: true,
        generation: 2,
        stateFresh: true,
        runningVersion,
        pendingRestartVersion: pending(),
        installedVersion: null,
        claudeStartedAtMs: null,
        installLandedAtMs: null,
      } as any),
      { kind: 'update_pending', target: '0.62.0', reason: 'running_differs_from_installed' },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
      readCheckoutVersion: () => '0.62.1',
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

test('server.ts (E5): a clone reads the package.json of the root RUNNING_VERSION came from, on every readiness and agent-state read', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const server = readFileSync(join(root, 'server.ts'), 'utf8')
  // One root for both readings: the version captured at boot and the version
  // on disk now. The root this process actually runs from, never
  // CLAUDE_PLUGIN_ROOT or another install's root.
  assert.match(server, /\nconst RUNNING_ROOT = import\.meta\.dir\n/)
  assert.match(server, /\nconst RUNNING_VERSION = readOwnVersion\(RUNNING_ROOT\)\n/)
  const start = server.indexOf('function daemonPendingRestartVersion(')
  assert.ok(start > 0)
  const helper = server.slice(start, server.indexOf('\n}\n', start))
  assert.match(helper, /readCheckoutVersion: \(\) => readOwnVersion\(RUNNING_ROOT\),/)
  assert.doesNotMatch(helper, /PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|INSTALL_DETECTION/)
  // The self updater's live answer still goes in first.
  assert.match(helper, /updaterPending: \(\) => selfUpdater\?\.pendingRestartVersion\(\) \?\? null,/)
  // Re-read on the existing cadences, never cached at boot: the heartbeat's
  // readiness computes it per send and per readiness poll, agent-state.json at
  // most every AGENT_STATE_MAX_INTERVAL_MS, both through this one function.
  const snapStart = server.indexOf('function updateReadinessSnapshot(): UpdateReadiness {')
  const snap = server.slice(snapStart, server.indexOf('\n}\n', snapStart))
  assert.match(snap, /pendingRestartVersion: daemonPendingRestartVersion\(state\),/)
  assert.match(server, /const agentStatePendingRestart = memoizeFor\(AGENT_STATE_MAX_INTERVAL_MS, Date\.now, \(\) =>\s*daemonPendingRestartVersion\(\),?\s*\)/)
  assert.match(server, /updateReadiness: updateReadinessSnapshot,/)
})

test('server.ts (E5b): the one-click handler restarts onto the same pending answer the heartbeat and agent-state.json carry', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const server = readFileSync(join(root, 'server.ts'), 'utf8')
  const start = server.indexOf('const updateRpc = new UpdateRpcHandler({')
  assert.ok(start > 0)
  const deps = server.slice(start, server.indexOf('\n})\n', start))
  assert.match(deps, /\n  pendingRestartVersion: \(\) => daemonPendingRestartVersion\(\),\n/)
  // The handler asks only that: the self updater's own answer is no longer a
  // second source beside it (lib/update-rpc.ts updateNow).
  const rpc = readFileSync(join(root, 'lib', 'update-rpc.ts'), 'utf8')
  assert.match(rpc, /let targetVersion = this\.deps\.pendingRestartVersion\(\)\n/)
  assert.doesNotMatch(rpc, /updater\.pendingRestartVersion\(\)/)
})
