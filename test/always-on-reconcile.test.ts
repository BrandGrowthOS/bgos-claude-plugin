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
import { resolveSupervision, type Supervision } from '../lib/update-readiness.ts'
import { buildServiceRecord, verifyServiceRecord } from '../lib/service-supervision.mjs'

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
  assert.ok(body.includes('resolveSupervision({ ...supervisionProbe(), '), 'the SAME detection the update ladder uses')
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

// Mission 104 fix round (C1). On a marketplace install bin/bgos-launch.mjs
// relocates this process into the plugin cache so bun resolves its
// dependencies, and the agent's own folder travels as BGOS_LAUNCH_CWD
// (server.ts LAUNCH_CWD). The reconcile used the relocated cwd for both its
// legs: `bgos-agent install --dir <plugin cache>` died with "not a proven
// paired folder" on every config event and every 15 minutes, so adoption
// (design 3.2 step 2) never gave a marketplace agent its supervisor; and the
// G11 probe matched bespoke jobs against the cache, where no job's
// WorkingDirectory ever points.
test('server.ts installs and probes from the agent folder (LAUNCH_CWD), never the relocated cwd', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const server = readFileSync(join(root, 'server.ts'), 'utf8')
  const start = server.indexOf('async function reconcileAlwaysOn(')
  const body = server.slice(start, server.indexOf('\n// ── Startup', start))
  assert.ok(start > 0 && body.length > 0)
  // A name of its own keeps the counted identity literal (`cwd: LAUNCH_CWD`,
  // test/agent-credentials.test.ts) at six, as SESSION_PIN_WORKDIR does.
  assert.match(server, /\nconst ALWAYS_ON_WORKDIR = LAUNCH_CWD\n/, 'the folder claude runs the agent in')
  assert.ok(
    body.includes("['install', '--assistant', ASSISTANT_ID, '--dir', ALWAYS_ON_WORKDIR, '--always-on', '--no-clone']"),
    'the install names the agent folder, the one bgos-agent can prove',
  )
  assert.doesNotMatch(body, /'--dir', process\.cwd\(\)/)
  assert.ok(
    body.includes('resolveSupervision({ ...supervisionProbe(), cwd: ALWAYS_ON_WORKDIR })'),
    'the G11 probe matches a bespoke job by the agent folder too',
  )
  assert.doesNotMatch(body, /resolveSupervision\(supervisionProbe\(\)\)/)
})

test('G11 on a marketplace install: a bespoke unit found by working directory defers only when probed from the agent folder', () => {
  const HOME = '/home/kc'
  const AGENT = '/home/kc/agents/vexa'
  const CACHE = '/home/kc/.claude/plugins/cache/hoai-marketplace/hoai/0.62.0'
  const UNIT = `${HOME}/.config/systemd/user/vexa-agent.service`
  const files: Record<string, string> = {
    [UNIT]: ['[Service]', 'ExecStart=/usr/bin/hoai', `WorkingDirectory=${AGENT}`, 'Restart=always'].join('\n'),
    // A paired marketplace folder declares this agent by its folder pin.
    [`${AGENT}/.bgos-agent-id`]: ID,
  }
  const probe = (cwd: string) => ({
    platform: 'linux',
    home: HOME,
    assistantId: ID,
    cwd,
    exists: (p: string) => p in files,
    readFile: (p: string) => files[p] ?? null,
    listDir: (dir: string) =>
      Object.keys(files)
        .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map((p) => p.slice(dir.length + 1)),
    execSync: (file: string) =>
      file === 'systemctl'
        ? { code: 0, stdout: 'vexa-agent.service loaded active running Vexa' }
        : { code: 127, stdout: '' },
    pidAlive: () => false,
  })
  const decide = (cwd: string) =>
    decideAlwaysOnReconcile({
      desired: true,
      canonicalInstalled: false,
      supervision: resolveSupervision(probe(cwd)),
      assistantId: ID,
    })
  assert.equal(decide(CACHE).action, 'install', 'from the plugin cache the bespoke unit is invisible: a second supervisor')
  assert.deepEqual(decide(AGENT), {
    action: 'defer',
    other: { kind: 'systemd', handle: 'vexa-agent.service', via: 'working-directory' },
  })
})

// Verifier item c (mission 104 fix round). supervisionProbe() fed every
// restart-authority read (the boot supervisor.json, the update ladder, the
// readiness heartbeat) the relocated process.cwd(), and publishServiceRecord
// wrote that cwd into service.json, the anchor the watcher re-verifies with.
// On a marketplace install that is the plugin cache, where no job's
// WorkingDirectory points: a bespoke job anchored by the agent folder was never
// found at boot (so no declared supervisor.json, and G11 rested on the
// reconcile's own probe alone), the update ladder only staged, and the record
// could never verify. The agent folder is what a job's WorkingDirectory names.
test('server.ts anchors the supervision probe and the published service record on the agent folder', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const server = readFileSync(join(root, 'server.ts'), 'utf8')
  const decl = server.indexOf('\nconst SUPERVISION_WORKDIR = LAUNCH_CWD\n')
  assert.ok(decl > 0, 'a name of its own keeps the counted identity literal at six')
  const probeAt = server.indexOf('function supervisionProbe() {')
  assert.ok(decl < probeAt, 'declared before the probe reads it')
  const probe = server.slice(probeAt, server.indexOf('\n}\n', probeAt))
  assert.match(probe, /\n\s*cwd: SUPERVISION_WORKDIR,\n/)
  assert.doesNotMatch(probe, /process\.cwd\(\)/)
  const recordAt = server.indexOf('function publishServiceRecord(')
  const record = server.slice(recordAt, server.indexOf('\n}\n', recordAt))
  assert.match(record, /buildServiceRecord\(\{[\s\S]*?\n\s*cwd: SUPERVISION_WORKDIR,\n/)
  assert.doesNotMatch(record, /process\.cwd\(\)/)
})

test('a service record published from the agent folder re-verifies for the watcher; one from the plugin cache never does', () => {
  const HOME = '/home/kc'
  const AGENT = '/home/kc/agents/vexa'
  const CACHE = '/home/kc/.claude/plugins/cache/hoai-marketplace/hoai/0.62.0'
  const UNIT = `${HOME}/.config/systemd/user/vexa-agent.service`
  const files: Record<string, string> = {
    [UNIT]: ['[Service]', 'ExecStart=/usr/bin/hoai', `WorkingDirectory=${AGENT}`, 'Restart=always'].join('\n'),
    [`${AGENT}/.bgos-agent-id`]: ID,
  }
  const io = {
    platform: 'linux',
    home: HOME,
    assistantId: ID,
    exists: (p: string) => p in files,
    readFile: (p: string) => files[p] ?? null,
    listDir: (dir: string) =>
      Object.keys(files)
        .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map((p) => p.slice(dir.length + 1)),
    execSync: (file: string) =>
      file === 'systemctl'
        ? { code: 0, stdout: 'vexa-agent.service loaded active running Vexa' }
        : { code: 127, stdout: '' },
    pidAlive: () => false,
  }
  const published = (cwd: string) => {
    const service = resolveSupervision({ ...io, cwd }).service
    return service ? buildServiceRecord({ assistantId: ID, service, cwd }) : null
  }
  assert.equal(published(CACHE), null, 'from the plugin cache the daemon resolves nothing to publish')
  const record = published(AGENT)
  assert.ok(record)
  assert.equal(record.cwd, AGENT)
  const verified = verifyServiceRecord({ record, ...io })
  assert.equal(verified?.handle, 'vexa-agent.service')
})
