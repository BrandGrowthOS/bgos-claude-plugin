/**
 * lib/always-on-reconcile.ts: the always-on reconcile decision, and the one
 * place server.ts must consult it (design G11, section 4 last paragraph).
 *
 * G11: "installed" used to mean `bgos-agent is-installed`, which checks only
 * the CANONICAL service file. An agent already kept alive by a bespoke launchd
 * job / systemd unit (found by lib/service-supervision.mjs) or by a verified
 * keepalive.json got a SECOND, canonical supervisor from its own daemon the
 * moment always_on turned true, and two supervisors raced to relaunch the same
 * agent. The fix reads whether another live supervisor holds the agent
 * (readAlwaysOnSupervision) and installs nothing when one does. A live hoai
 * launcher alone does not count: it does not survive a reboot. Since the code
 * review (F3 to F5) it installs only on a DEFINITE none: a live keepalive
 * script counts before its marker is proven, a tie is two supervisors, an
 * unreadable job list waits, and a declared job counts only while loaded.
 *
 * Run: npx tsx --test test/always-on-reconcile.test.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  type AlwaysOnSupervision,
  decideAlwaysOnReconcile,
  describeOtherSupervisor,
  readAlwaysOnSupervision,
  userBusExecSync,
} from '../lib/always-on-reconcile.ts'
import { buildServiceRecord, verifyServiceRecord } from '../lib/service-supervision.mjs'
import { resolveSupervision } from '../lib/update-readiness.ts'

const ID = '910'

const none: AlwaysOnSupervision = { state: 'none' }
const keepalive: AlwaysOnSupervision = {
  state: 'other',
  other: { kind: 'keepalive', handle: 'agent-910', via: 'keepalive-marker' },
}
const bespokeLaunchd: AlwaysOnSupervision = {
  state: 'other',
  other: { kind: 'launchd', handle: 'ai.bgos.session.910', via: 'state-dir' },
}
const unreadable: AlwaysOnSupervision = { state: 'unknown', reason: 'listing-unreadable' }

test('the decision table: install, remove, leave, defer to another live supervisor, or wait', () => {
  const rows: Array<[string, boolean, boolean, AlwaysOnSupervision | null, string]> = [
    // desired, canonical installed, the G11 reading, expected action
    ['wanted and installed', true, true, keepalive, 'leave'],
    ['off and installed: removal touches only the canonical supervisor', false, true, keepalive, 'remove'],
    ['off and not installed, a bespoke job stays untouched', false, false, bespokeLaunchd, 'leave'],
    ['wanted, the job list was read and nothing names this agent', true, false, none, 'install'],
    ['wanted, a keepalive holds it', true, false, keepalive, 'defer'],
    ['wanted, a bespoke service-manager job holds it', true, false, bespokeLaunchd, 'defer'],
    // F4: "could not tell" is not "nobody". One failed listing used to add a
    // canonical supervisor beside the bespoke one for good.
    ['wanted, the job list could not be read', true, false, unreadable, 'wait'],
    ['wanted, the reading never happened', true, false, null, 'wait'],
  ]
  for (const [name, desired, canonicalInstalled, supervision, expected] of rows) {
    const decision = decideAlwaysOnReconcile({ desired, canonicalInstalled, supervision })
    assert.equal(decision.action, expected, name)
  }
})

test('a defer names the supervisor it deferred to, for the once-only log line', () => {
  const ka = decideAlwaysOnReconcile({ desired: true, canonicalInstalled: false, supervision: keepalive })
  assert.deepEqual(ka, { action: 'defer', other: { kind: 'keepalive', handle: 'agent-910', via: 'keepalive-marker' } })
  const job = decideAlwaysOnReconcile({ desired: true, canonicalInstalled: false, supervision: bespokeLaunchd })
  assert.deepEqual(job, { action: 'defer', other: { kind: 'launchd', handle: 'ai.bgos.session.910', via: 'state-dir' } })
  assert.deepEqual(decideAlwaysOnReconcile({ desired: true, canonicalInstalled: false, supervision: unreadable }), {
    action: 'wait',
    reason: 'listing-unreadable',
  })
  assert.match(describeOtherSupervisor({ kind: 'launchd', handle: 'ai.bgos.session.910', via: 'state-dir' }), /launchd job ai\.bgos\.session\.910/)
  assert.match(describeOtherSupervisor({ kind: 'keepalive', handle: null, via: 'keepalive-marker' }), /keepalive/)
  assert.match(describeOtherSupervisor({ kind: 'keepalive', handle: 'agent-910', via: 'keepalive-declared' }), /keepalive/)
})

// ── The G11 reading, on a fake Mac ───────────────────────────────────────────
//
// readAlwaysOnSupervision answers ONE question for the install row: is this
// agent already kept alive by something other than the canonical supervisor?
// The update ladder's detection (resolveSupervision) answers a different one,
// "who can restart me", and rightly fails closed to "nobody" on a failed
// listing, a tie or an unproven marker. For G11 "nobody" means install, so
// the reading tells a definite none from an unknown, and trusts a declaration
// only while its job is loaded.

const MAC_HOME = '/Users/kc'
const AGENT_DIR = '/Users/kc/Voxor/Vexa'
const STATE_DIR = `${MAC_HOME}/.bgos-agent/${ID}`
const LA = `${MAC_HOME}/Library/LaunchAgents`

interface FakeMac {
  files: Record<string, string>
  plists: Record<string, Record<string, unknown>>
  loaded: string[] | null
  alive: Set<number>
  calls: string[]
}

function fakeMac(over: Partial<FakeMac> = {}): FakeMac {
  return { files: {}, plists: {}, loaded: [], alive: new Set(), calls: [], ...over }
}

function macProbe(m: FakeMac) {
  const all = () => ({ ...m.files, ...Object.fromEntries(Object.entries(m.plists).map(([p, d]) => [p, JSON.stringify(d)])) })
  return {
    platform: 'darwin',
    home: MAC_HOME,
    assistantId: ID,
    cwd: AGENT_DIR,
    ownPid: 7000,
    exists: (p: string) => p in all(),
    readFile: (p: string) => all()[p] ?? null,
    listDir: (dir: string) =>
      Object.keys(all())
        .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map((p) => p.slice(dir.length + 1)),
    pidAlive: (pid: number) => m.alive.has(pid),
    execSync: (file: string, args: string[]) => {
      m.calls.push([file, ...args].join(' '))
      if (file === 'launchctl' && args[0] === 'list') {
        if (m.loaded === null) return { code: 1, stdout: '' }
        return { code: 0, stdout: ['PID\tStatus\tLabel', ...m.loaded.map((l) => `-\t0\t${l}`)].join('\n') }
      }
      if (file === 'plutil') {
        const d = m.plists[args[args.length - 1]!]
        return d ? { code: 0, stdout: JSON.stringify(d) } : { code: 1, stdout: '' }
      }
      // ps: no ancestry is readable, so a keepalive marker is never VERIFIED here.
      return { code: 1, stdout: '' }
    },
  }
}

const sessionPlist = (label: string, workdir = AGENT_DIR) => ({
  Label: label,
  ProgramArguments: ['/bin/bash', `${MAC_HOME}/.bgos-session-910/keepalive.sh`],
  WorkingDirectory: workdir,
})

test('F3: a keepalive whose script is alive defers even before its marker names the new claude', () => {
  // KC's keepalive.sh relaunches claude under the SAME script pid and rewrites
  // keepalive.json only 5 s later; the daemon's boot reconcile runs about 1 s
  // after startup, so the marker still names the old, dead claude. Ancestry
  // (what a SIGTERM needs) fails; the relaunch promise (what G11 needs) holds.
  const m = fakeMac({
    files: {
      [`${STATE_DIR}/keepalive.json`]: JSON.stringify({ kind: 'keepalive', capabilities: ['relaunch'], pid: 4622, claudePid: 6000, tmuxSession: 'agent-910' }),
    },
    alive: new Set([4622]),
    loaded: ['com.apple.something'],
  })
  assert.equal(resolveSupervision(macProbe(m)).supervised, 'none', 'the ladder rightly sees no PROVEN keepalive')
  assert.deepEqual(readAlwaysOnSupervision(macProbe(m)), {
    state: 'other',
    other: { kind: 'keepalive', handle: 'agent-910', via: 'keepalive-declared' },
  })
  // A marker whose script has exited promises nothing.
  m.alive.clear()
  assert.deepEqual(readAlwaysOnSupervision(macProbe(m)), { state: 'none' })
})

test('F4: a failed job listing is unknown, never "no other supervisor"', () => {
  const m = fakeMac({
    plists: { [`${LA}/ai.bgos.session.910.plist`]: sessionPlist('ai.bgos.session.910') },
    loaded: null,
  })
  assert.deepEqual(readAlwaysOnSupervision(macProbe(m)), { state: 'unknown', reason: 'listing-unreadable' })
  assert.equal(decideAlwaysOnReconcile({ desired: true, canonicalInstalled: false, supervision: readAlwaysOnSupervision(macProbe(m)) }).action, 'wait')
  // The same machine with a readable listing defers to the bespoke job.
  m.loaded = ['ai.bgos.session.910']
  assert.deepEqual(readAlwaysOnSupervision(macProbe(m)), {
    state: 'other',
    other: { kind: 'launchd', handle: 'ai.bgos.session.910', via: 'working-directory' },
  })
})

test('F4: two loaded jobs naming this agent are two supervisors, never none', () => {
  // A Finder copy or an old and a new plist with the same WorkingDirectory:
  // pickSoleMatch rightly refuses to pick a restart target, and that refusal
  // used to read as "nothing supervises it" and install a third.
  const m = fakeMac({
    plists: {
      [`${LA}/ai.bgos.session.910.plist`]: sessionPlist('ai.bgos.session.910'),
      [`${LA}/ai.bgos.vexa.plist`]: sessionPlist('ai.bgos.vexa'),
    },
    loaded: ['ai.bgos.session.910', 'ai.bgos.vexa'],
  })
  assert.equal(resolveSupervision(macProbe(m)).service, null, 'the ladder has no single target')
  const reading = readAlwaysOnSupervision(macProbe(m))
  assert.equal(reading.state, 'other')
  assert.equal(reading.state === 'other' && reading.other.via, 'working-directory')
  // A canonical job loaded without its file is ours, and never defers.
  const canonicalOnly = fakeMac({
    plists: { [`${LA}/ai.bgos.agent.910.copy.plist`]: sessionPlist('ai.bgos.agent.910') },
    loaded: ['ai.bgos.agent.910'],
  })
  assert.deepEqual(readAlwaysOnSupervision(macProbe(canonicalOnly)), { state: 'none' })
  // A readable listing with nothing naming this agent is the one install.
  assert.deepEqual(readAlwaysOnSupervision(macProbe(fakeMac({ loaded: ['com.apple.x'] }))), { state: 'none' })
})

test('F5: a declared job in supervisor.json counts only while it is loaded', () => {
  // supervisor.json carries the DAEMON's own pid (decideSupervisorWrite), so
  // "its pid is alive" is true for the daemon's whole life. After the bespoke
  // job is booted out and deleted, the agent's claude and daemon live on in a
  // detached tmux, and the declaration alone kept every reconcile deferring
  // to a job that no longer exists: nothing supervised the agent.
  const m = fakeMac({
    files: {
      [`${STATE_DIR}/supervisor.json`]: JSON.stringify({
        pid: 7000,
        capabilities: ['relaunch'],
        supervisor: { kind: 'launchd', handle: 'ai.bgos.session.910' },
      }),
    },
    alive: new Set([7000]),
    loaded: ['com.apple.x'],
  })
  assert.equal(resolveSupervision(macProbe(m)).service?.via, 'declared', 'the ladder still trusts the declaration')
  assert.deepEqual(readAlwaysOnSupervision(macProbe(m)), { state: 'none' }, 'G11 does not: the job is gone')
  m.loaded = ['ai.bgos.session.910']
  assert.deepEqual(readAlwaysOnSupervision(macProbe(m)), {
    state: 'other',
    other: { kind: 'launchd', handle: 'ai.bgos.session.910', via: 'declared' },
  })
  // Declared from the canonical job: ours, never a reason to wait.
  m.files[`${STATE_DIR}/supervisor.json`] = JSON.stringify({ pid: 7000, capabilities: ['relaunch'], supervisor: { kind: 'launchd', handle: `ai.bgos.agent.${ID}` } })
  m.loaded = [`ai.bgos.agent.${ID}`]
  assert.deepEqual(readAlwaysOnSupervision(macProbe(m)), { state: 'none' })
  // And the listing is read once for the whole decision.
  m.calls.length = 0
  readAlwaysOnSupervision(macProbe(m))
  assert.equal(m.calls.filter((c) => c === 'launchctl list').length, 1)
})

test('the user bus default: systemctl gets XDG_RUNTIME_DIR the way bin/bgos-agent sets it', () => {
  // A daemon started outside a login session (cron, a bare ssh) has no
  // XDG_RUNTIME_DIR, so systemctl --user cannot reach the bus. bgos-agent
  // install defaults it and succeeds; without the same default here the
  // listing would read as unknown forever and the reconcile would never install.
  const calls: string[][] = []
  const exec = (file: string, args: string[]) => {
    calls.push([file, ...args])
    return { code: 0, stdout: '' }
  }
  userBusExecSync(exec, { platform: 'linux', env: {}, uid: 1001 })('systemctl', ['--user', 'list-units'])
  assert.deepEqual(calls.pop(), ['env', 'XDG_RUNTIME_DIR=/run/user/1001', 'systemctl', '--user', 'list-units'])
  userBusExecSync(exec, { platform: 'linux', env: {}, uid: 1001 })('plutil', ['x'])
  assert.deepEqual(calls.pop(), ['plutil', 'x'])
  assert.equal(userBusExecSync(exec, { platform: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/7' }, uid: 1001 }), exec)
  assert.equal(userBusExecSync(exec, { platform: 'darwin', env: {}, uid: 501 }), exec)
  assert.equal(userBusExecSync(exec, { platform: 'linux', env: {}, uid: null }), exec)
})

test('server.ts reconcile asks the shared detection, defers before installing, and logs the defer once', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const server = readFileSync(join(root, 'server.ts'), 'utf8')
  const start = server.indexOf('async function reconcileAlwaysOn(')
  const body = server.slice(start, server.indexOf('\n// ── Startup', start))
  assert.ok(start > 0 && body.length > 0)
  assert.ok(body.includes('decideAlwaysOnReconcile('), 'the pure decision drives the reconcile')
  assert.ok(body.includes('readAlwaysOnSupervision({ ...supervisionProbe(), '), 'the shared probe, read for G11')
  const deferAt = body.indexOf("if (decision.action === 'defer') {")
  const installAt = body.indexOf("['install'")
  assert.ok(deferAt > 0 && deferAt < installAt, 'the defer branch comes before any install spawn')
  const deferBranch = body.slice(deferAt, body.indexOf("if (decision.action === 'install') {"))
  assert.match(deferBranch, /\n\s*return\s*\n\s*\}\s*$/, 'and it returns: nothing is installed beside another supervisor')
  assert.match(deferBranch, /if \(!alwaysOnDeferLogged\) \{\s*alwaysOnDeferLogged = true/, 'the defer line is latched to once per process')
  assert.ok(server.includes('let alwaysOnDeferLogged = false'), 'the latch is process scoped')
  // F4: an unknown reading waits, says so once, and installs nothing.
  const waitAt = body.indexOf("if (decision.action === 'wait') {")
  assert.ok(waitAt > 0 && waitAt < installAt, 'the wait branch comes before any install spawn')
  const waitBranch = body.slice(waitAt, body.indexOf('\n    }\n', waitAt) + 6)
  assert.match(waitBranch, /\n\s*return\s*\n\s*\}\s*$/, 'and it returns')
  assert.match(waitBranch, /if \(!alwaysOnWaitLogged\) \{\s*alwaysOnWaitLogged = true/)
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
    body.includes('readAlwaysOnSupervision({ ...supervisionProbe(), cwd: ALWAYS_ON_WORKDIR, execSync: alwaysOnExecSync })'),
    'the G11 probe matches a bespoke job by the agent folder too, with the user bus default',
  )
  assert.match(
    server,
    /const alwaysOnExecSync = userBusExecSync\(defaultExecSync, \{\s*platform: process\.platform,\s*env: process\.env,\s*uid: typeof process\.getuid === 'function' \? process\.getuid\(\) : null,\s*\}\)/,
  )
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
      supervision: readAlwaysOnSupervision(probe(cwd)),
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
