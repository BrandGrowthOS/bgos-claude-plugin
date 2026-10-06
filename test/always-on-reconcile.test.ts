/**
 * lib/always-on-reconcile.ts: the always-on reconcile decision, and the one
 * place server.ts must consult it (design G11, section 4 last paragraph).
 *
 * G11: "installed" used to mean `bgos-agent is-installed`, which checks only
 * the CANONICAL service file. An agent already kept alive by a bespoke launchd
 * job / systemd unit (found by lib/service-supervision.mjs) or by a verified
 * keepalive.json got a SECOND, canonical supervisor from its own daemon the
 * moment always_on turned true, and two supervisors raced to relaunch the same
 * agent. The fix reads the detection the update ladder already uses
 * (lib/update-readiness.ts resolveSupervision) and installs nothing when it
 * names another live supervisor. A live hoai launcher alone does not count: it
 * does not survive a reboot.
 *
 * Run: npx tsx --test test/always-on-reconcile.test.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  decideAlwaysOnReconcile,
  describeOtherSupervisor,
  otherLiveSupervisor,
} from '../lib/always-on-reconcile.ts'
import type { Supervision } from '../lib/update-readiness.ts'

const ID = '910'

const none: Supervision = { supervised: 'none', service: null }
const launcher: Supervision = { supervised: 'launcher', service: null }
const keepalive: Supervision = {
  supervised: 'keepalive',
  service: null,
  keepalive: { pid: 4100, claudePid: 4200, tmuxSession: 'agent-910' },
}
const bespokeLaunchd: Supervision = {
  supervised: 'launchd',
  service: { kind: 'launchd', handle: 'ai.bgos.session.910', via: 'state-dir', file: '/h/Library/LaunchAgents/ai.bgos.session.910.plist' },
}
const bespokeSystemd: Supervision = {
  supervised: 'systemd',
  service: { kind: 'systemd', handle: 'ava-agent.service', via: 'working-directory', file: '/h/.config/systemd/user/ava-agent.service' },
}
const declaredBespoke: Supervision = {
  supervised: 'launchd',
  service: { kind: 'launchd', handle: 'com.example.agent', via: 'declared', file: null },
}
// supervisor.json written at boot from a detection of the canonical job keeps
// naming it after `bgos-agent uninstall` removed the file: that is OUR
// supervisor, not another one, and must never block its own reinstall.
const declaredCanonical: Supervision = {
  supervised: 'launchd',
  service: { kind: 'launchd', handle: `ai.bgos.agent.${ID}`, via: 'declared', file: null },
}
const discoveredCanonicalUnit: Supervision = {
  supervised: 'systemd',
  service: { kind: 'systemd', handle: `bgos-agent-${ID}.service`, via: 'state-dir', file: null },
}
const canonicalFile: Supervision = {
  supervised: 'launchd',
  service: { kind: 'launchd', handle: `ai.bgos.agent.${ID}`, via: 'canonical-file', file: '/h/x.plist' },
}

test('the decision table: install, remove, leave, or defer to another live supervisor', () => {
  const rows: Array<[string, boolean, boolean, Supervision | null, string]> = [
    // desired, canonical installed, detection, expected action
    ['wanted and installed', true, true, keepalive, 'leave'],
    ['off and installed: removal touches only the canonical supervisor', false, true, keepalive, 'remove'],
    ['off and not installed, a bespoke job stays untouched', false, false, bespokeLaunchd, 'leave'],
    ['wanted, nothing supervises', true, false, none, 'install'],
    ['wanted, only a live hoai launcher (does not survive a reboot)', true, false, launcher, 'install'],
    ['wanted, a verified keepalive.json holds it', true, false, keepalive, 'defer'],
    ['wanted, a discovered bespoke launchd job', true, false, bespokeLaunchd, 'defer'],
    ['wanted, a discovered bespoke systemd unit', true, false, bespokeSystemd, 'defer'],
    ['wanted, a declared bespoke service-manager job', true, false, declaredBespoke, 'defer'],
    ['wanted, the declared job is our own canonical label', true, false, declaredCanonical, 'install'],
    ['wanted, the discovered unit is our own canonical unit', true, false, discoveredCanonicalUnit, 'install'],
    ['wanted, the canonical file appeared after is-installed', true, false, canonicalFile, 'install'],
    ['wanted, detection could not be read', true, false, null, 'install'],
  ]
  for (const [name, desired, canonicalInstalled, supervision, expected] of rows) {
    const decision = decideAlwaysOnReconcile({ desired, canonicalInstalled, supervision, assistantId: ID })
    assert.equal(decision.action, expected, name)
  }
})

test('a defer names the supervisor it deferred to, for the once-only log line', () => {
  const ka = decideAlwaysOnReconcile({ desired: true, canonicalInstalled: false, supervision: keepalive, assistantId: ID })
  assert.deepEqual(ka, { action: 'defer', other: { kind: 'keepalive', handle: 'agent-910', via: 'keepalive-marker' } })
  const job = decideAlwaysOnReconcile({ desired: true, canonicalInstalled: false, supervision: bespokeLaunchd, assistantId: ID })
  assert.deepEqual(job, { action: 'defer', other: { kind: 'launchd', handle: 'ai.bgos.session.910', via: 'state-dir' } })
  assert.match(describeOtherSupervisor({ kind: 'launchd', handle: 'ai.bgos.session.910', via: 'state-dir' }), /launchd job ai\.bgos\.session\.910/)
  assert.match(describeOtherSupervisor({ kind: 'keepalive', handle: null, via: 'keepalive-marker' }), /keepalive/)
})

test('otherLiveSupervisor is null for everything that is not a second, reboot-surviving supervisor', () => {
  for (const s of [none, launcher, declaredCanonical, discoveredCanonicalUnit, canonicalFile, null, undefined]) {
    assert.equal(otherLiveSupervisor(s as Supervision | null, ID), null, JSON.stringify(s))
  }
  // An unparseable id cannot name a canonical handle, so nothing is excluded
  // as "ours" and a bespoke job still defers.
  assert.notEqual(otherLiveSupervisor(bespokeLaunchd, ''), null)
})

test('server.ts reconcile asks the shared detection, defers before installing, and logs the defer once', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const server = readFileSync(join(root, 'server.ts'), 'utf8')
  const start = server.indexOf('async function reconcileAlwaysOn(')
  const body = server.slice(start, server.indexOf('\n// ── Startup', start))
  assert.ok(start > 0 && body.length > 0)
  assert.ok(body.includes('decideAlwaysOnReconcile('), 'the pure decision drives the reconcile')
  assert.ok(body.includes('resolveSupervision(supervisionProbe())'), 'the SAME detection the update ladder uses')
  const deferAt = body.indexOf("if (decision.action === 'defer') {")
  const installAt = body.indexOf("['install'")
  assert.ok(deferAt > 0 && deferAt < installAt, 'the defer branch comes before any install spawn')
  const deferBranch = body.slice(deferAt, body.indexOf("if (decision.action === 'install') {"))
  assert.match(deferBranch, /\n\s*return\s*\n\s*\}\s*$/, 'and it returns: nothing is installed beside another supervisor')
  assert.match(deferBranch, /if \(!alwaysOnDeferLogged\) \{\s*alwaysOnDeferLogged = true/, 'the defer line is latched to once per process')
  assert.ok(server.includes('let alwaysOnDeferLogged = false'), 'the latch is process scoped')
  // The removal still goes only through the canonical uninstall.
  const removeBranch = body.slice(body.indexOf("} else if (decision.action === 'remove') {"))
  assert.ok(removeBranch.includes("['uninstall', '--assistant', ASSISTANT_ID]"))
})
