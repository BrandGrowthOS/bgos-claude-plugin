/**
 * lib/watcher-service.mjs: HOAI_SERVICE_NAMESPACE, the side by side install
 * (design section 4, "Side by side installs").
 *
 * A second, isolated install on the same user account (a staging install, and
 * the end to end proof in design section 11) must never boot out the live
 * watcher. launchd labels live in ONE gui/<uid> domain and systemd --user
 * units in ONE user manager, so a sandboxed HOME is not enough: the second
 * install's `launchctl bootout gui/<uid>/ai.bgos.watcher` would stop KC's live
 * watcher. With the namespace set, every name the service is known by moves
 * into it, and the service carries the variable so a reinstall from inside the
 * namespaced watcher stays namespaced.
 *
 * Unset (or invalid, which means unset) the output is byte for byte today's:
 * test/watcher-service.test.ts is unchanged and still green, and the first
 * test below pins the equality directly.
 *
 * Run: npx tsx --test test/watcher-service.namespace.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { serviceNamespace, watcherServiceNames, watcherServiceSpec } from '../lib/watcher-service.mjs'

const POSIX = { home: '/home/kc', nodePath: '/usr/local/bin/node', bundleDir: '/home/kc/.bgos-agent/watcher', uid: 501, username: 'kc' }
const WIN = {
  home: 'C:\\Users\\kc',
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  bundleDir: 'C:\\Users\\kc\\.bgos-agent\\watcher',
  uid: null,
  username: 'kc',
}
const NS = { HOAI_SERVICE_NAMESPACE: 'stage1' }

test('serviceNamespace: ^[a-z0-9]{1,16}$ or nothing; an invalid value means unset, never a guess', () => {
  assert.equal(serviceNamespace({ HOAI_SERVICE_NAMESPACE: 'stage1' }), 'stage1')
  assert.equal(serviceNamespace({ HOAI_SERVICE_NAMESPACE: 'a' }), 'a')
  assert.equal(serviceNamespace({ HOAI_SERVICE_NAMESPACE: 'x'.repeat(16) }), 'x'.repeat(16))
  for (const bad of ['', 'Stage1', 'stage-1', 'stage 1', ' stage1', 'stage1\n', 'x'.repeat(17), '../x', 'a.b']) {
    assert.equal(serviceNamespace({ HOAI_SERVICE_NAMESPACE: bad }), '', JSON.stringify(bad))
  }
  assert.equal(serviceNamespace({}), '')
  assert.equal(serviceNamespace(undefined), '')
})

test('unset or invalid: every platform spec is exactly the un-namespaced one (byte identical)', () => {
  for (const [platform, base] of [['darwin', POSIX], ['linux', POSIX], ['win32', WIN]] as const) {
    const today = watcherServiceSpec({ platform, ...base, env: {} })
    assert.deepEqual(watcherServiceSpec({ platform, ...base, env: { HOAI_SERVICE_NAMESPACE: 'NOT-valid' } }), today, platform)
    assert.deepEqual(watcherServiceSpec({ platform, ...base, env: { HOAI_SERVICE_NAMESPACE: '' } }), today, platform)
  }
  assert.deepEqual(watcherServiceNames(''), {
    namespace: '',
    launchdLabel: 'ai.bgos.watcher',
    systemdUnit: 'bgos-watcher',
    taskName: 'HOAI Watcher',
    runValue: 'HOAIWatcher',
  })
})

test('darwin, namespaced: label, plist path, every launchctl target and the service env all move into the namespace', () => {
  const spec = watcherServiceSpec({ platform: 'darwin', ...POSIX, env: NS })
  assert.equal(spec.label, 'ai.bgos.watcher.stage1')
  assert.equal(spec.files[0]!.path, '/home/kc/Library/LaunchAgents/ai.bgos.watcher.stage1.plist')
  const plist = spec.files[0]!.content
  assert.match(plist, /<key>Label<\/key><string>ai\.bgos\.watcher\.stage1<\/string>/)
  assert.match(plist, /<key>HOAI_SERVICE_NAMESPACE<\/key><string>stage1<\/string>/)
  const all = [...spec.installCommands, ...spec.startCommands, ...spec.stopCommands, ...spec.uninstallCommands, ...spec.statusCommands]
  for (const cmd of all) {
    const line = cmd.args.join(' ')
    // The live label must never be addressed: `gui/501/ai.bgos.watcher` followed by a space or the end.
    assert.doesNotMatch(line, /ai\.bgos\.watcher(\s|$)/, line)
  }
  assert.deepEqual(spec.installCommands.map((c) => c.args.join(' ')), [
    'bootout gui/501/ai.bgos.watcher.stage1',
    'bootstrap gui/501 /home/kc/Library/LaunchAgents/ai.bgos.watcher.stage1.plist',
  ])
  assert.deepEqual(spec.startCommands.map((c) => c.args.join(' ')), ['kickstart -k gui/501/ai.bgos.watcher.stage1'])
  assert.deepEqual(spec.statusCommands.map((c) => c.args.join(' ')), ['print gui/501/ai.bgos.watcher.stage1'])
})

test('linux, namespaced: unit file, Description, every systemctl call and the service env all move into the namespace', () => {
  const spec = watcherServiceSpec({ platform: 'linux', ...POSIX, env: NS })
  assert.equal(spec.label, 'bgos-watcher-stage1')
  assert.equal(spec.files[0]!.path, '/home/kc/.config/systemd/user/bgos-watcher-stage1.service')
  const unit = spec.files[0]!.content
  assert.match(unit, /^Description=HOAI per-machine watcher \(bgos-watcher-stage1\)$/m)
  assert.match(unit, /^Environment=HOAI_SERVICE_NAMESPACE=stage1$/m)
  assert.deepEqual(spec.installCommands.map((c) => c.args.join(' ')), [
    '--user daemon-reload',
    '--user enable --now bgos-watcher-stage1',
    'enable-linger kc',
  ])
  assert.deepEqual(spec.startCommands.map((c) => c.args.join(' ')), ['--user restart bgos-watcher-stage1'])
  assert.deepEqual(spec.stopCommands.map((c) => c.args.join(' ')), ['--user stop bgos-watcher-stage1'])
  assert.deepEqual(spec.uninstallCommands.map((c) => c.args.join(' ')), ['--user disable --now bgos-watcher-stage1', '--user daemon-reload'])
  assert.deepEqual(spec.statusCommands.map((c) => c.args.join(' ')), ['--user is-active bgos-watcher-stage1'])
})

test('win32, namespaced: the task name, the Run key value and the launcher env all move into the namespace', () => {
  const spec = watcherServiceSpec({ platform: 'win32', ...WIN, env: NS })
  assert.equal(spec.label, 'HOAI Watcher (stage1)')
  const [vbs, ps1] = spec.files
  assert.match(vbs!.content, /the Scheduled Task 'HOAI Watcher \(stage1\)' runs this at logon/)
  // The process environment of the launcher shell is what node inherits.
  assert.ok(vbs!.content.includes('shell.Environment("Process")("HOAI_SERVICE_NAMESPACE") = "stage1"'), vbs!.content)
  assert.ok(vbs!.content.indexOf('HOAI_SERVICE_NAMESPACE') < vbs!.content.indexOf('shell.Run'), 'set before node starts')
  assert.match(ps1!.content, /^\$name = 'HOAI Watcher \(stage1\)'\r?$/m)
  // The Run key fallback must not overwrite the live watcher's value either.
  assert.match(ps1!.content, /^\$runValue = 'HOAIWatcher-stage1'\r?$/m)
  assert.doesNotMatch(ps1!.content, /'HOAI Watcher'/)
})

test('the namespace is read from process.env by default, so no call site has to change', () => {
  const before = process.env.HOAI_SERVICE_NAMESPACE
  try {
    process.env.HOAI_SERVICE_NAMESPACE = 'stage1'
    assert.equal(watcherServiceSpec({ platform: 'linux', ...POSIX }).label, 'bgos-watcher-stage1')
    delete process.env.HOAI_SERVICE_NAMESPACE
    assert.equal(watcherServiceSpec({ platform: 'linux', ...POSIX }).label, 'bgos-watcher')
  } finally {
    if (before === undefined) delete process.env.HOAI_SERVICE_NAMESPACE
    else process.env.HOAI_SERVICE_NAMESPACE = before
  }
})
