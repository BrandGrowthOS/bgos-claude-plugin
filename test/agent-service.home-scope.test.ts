/**
 * The per-agent macOS and Linux services, and every reader of an agent service name, follow the
 * HOME the service was installed from (board row d6198bb6, mission 154 goal 8): the launchd label
 * `ai.bgos.agent.<id>.home-<hid>`, the systemd unit `bgos-agent-<id>-home-<hid>` and the tmux
 * socket `hoai-<id>-home-<hid>` (#237's watcherHomeId), the old names still found and supervised
 * while an agent is not renamed yet, and a restart that reads the registration back first and
 * refuses one another HOME installed.
 *
 * Every launchctl and systemctl call goes through test/helpers/fake-service-host.ts (a faked
 * gui/<uid> domain and systemd --user manager). Nothing real is touched.
 *
 * Run: npx tsx --test test/agent-service.home-scope.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { agentServiceNames, listAgents } from '../lib/agent-inventory.mjs'
import { agentServiceRecord, readBackAgentService } from '../lib/agent-service.mjs'
import { isOwnServiceProcess, restartAgent } from '../lib/agent-restart.mjs'
import { classifyRegistration, readProbe } from '../lib/watcher-service.mjs'
import { resolveSupervision } from '../lib/update-readiness.ts'
import { readAlwaysOnSupervision } from '../lib/always-on-reconcile.ts'
import { main as agentServiceMain, PROBE_TIMEOUT_MS } from '../bin/hoai-agent-service.mjs'
import { memoryFs, type MemoryFs } from './helpers/memory-fs.ts'
import { fakeServiceHost } from './helpers/fake-service-host.ts'

const ID = '912'
const MAC = '/Users/kc'
const LINUX = '/home/kc'
const SCRATCH = '/tmp/rig/scratch-home'
const MAC_ID = '5156882f'
const LINUX_ID = 'dc88e57d'
const SCRATCH_ID = '2ef4c967'
const UID = 501

const plistPath = (home: string, label: string) => `${home}/Library/LaunchAgents/${label}.plist`
const unitPath = (home: string, unit: string) => `${home}/.config/systemd/user/${unit}.service`

/** The plist bin/bgos-agent writes, reduced to what the fake domain and the read-back look at. */
function agentPlist(home: string, label: string, id = ID) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${label}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/bash</string>',
    `    <string>${home}/.bgos-agent/${id}/run.sh</string>`,
    '  </array>',
    `  <key>WorkingDirectory</key><string>${home}/hoai-agents/ava</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>HOME</key><string>${home}</string>`,
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

/** The unit bin/bgos-agent writes, reduced likewise. */
function agentUnit(home: string, id = ID) {
  return [
    '[Unit]',
    `Description=BGOS Claude Code agent ${id}`,
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${home}/hoai-agents/ava`,
    `ExecStart=/bin/bash "${home}/.bgos-agent/${id}/run.sh"`,
    `Environment=HOME=${home}`,
    '',
  ].join('\n')
}

function row(home: string, service: Record<string, unknown>) {
  return {
    assistantId: ID,
    home,
    supervisor: 'service',
    launcherLive: false,
    keepalive: null,
    service: { via: 'canonical-file', home, ...service },
    stateDir: `${home}/.bgos-agent/${ID}`,
    pluginStateDir: `${home}/.bgos-plugin-state/${ID}`,
    credentialsPath: `${home}/.bgos-agent/credentials-${ID}.json`,
    recipe: null,
    notes: [],
  }
}

// -- the read-back of an agent's own records -----------------------------------------------------------

test('an agent registration is read back with #237\'s reader: its plist path, its HOME, and the run.sh of THIS agent id; another agent\'s run.sh is no record of this one', () => {
  const fs = memoryFs()
  const host = fakeServiceHost({ platform: 'darwin', fs, uid: UID })
  const label = `ai.bgos.agent.${ID}`
  host.seed.launchd(plistPath(MAC, label), agentPlist(MAC, label))
  return host.exec('launchctl', ['print', `gui/${UID}/${label}`]).then((result) => {
    const read = readProbe('launchd', result, null, agentServiceRecord(ID))
    assert.deepEqual(read, [{ what: 'job', homes: [MAC, MAC, MAC], active: true, path: plistPath(MAC, label) }])
    assert.equal(classifyRegistration({ home: MAC, platform: 'darwin' }, read).state, 'own')
    assert.equal(classifyRegistration({ home: SCRATCH, platform: 'darwin' }, read).state, 'foreign')
    // The watcher's reader finds none of the agent's own records: the record is per service.
    const asWatcher = readProbe('launchd', result)
    assert.deepEqual(asWatcher?.[0]?.homes, [MAC, MAC])
    // A win32 probe of an agent task has no Run key line, and needs none.
    const win = readProbe('schtasks', { code: 0, stdout: `task present Ready - ${Buffer.from('wscript.exe //B "C:\\Users\\kc\\.bgos-agent\\912\\run-agent.vbs"').toString('base64')}\r\n` }, null, agentServiceRecord(ID))
    assert.deepEqual(win, [{ what: 'task', homes: ['C:\\Users\\kc'], active: true, path: 'C:\\Users\\kc\\.bgos-agent\\912\\run-agent.vbs', taskState: 'Ready' }])
    const otherAgent = readProbe('schtasks', { code: 0, stdout: `task present Ready - ${Buffer.from('wscript.exe //B "C:\\Users\\kc\\.bgos-agent\\77\\run-agent.vbs"').toString('base64')}\r\n` }, null, agentServiceRecord(ID))
    assert.deepEqual(otherAgent?.[0]?.homes, [], 'agent 77\'s launcher records nothing about agent 912')
  })
})

test('readBackAgentService (linux): the unit the user manager LOADED is judged by its file: fragment path, HOME and run.sh', async () => {
  const fs = memoryFs()
  const host = fakeServiceHost({ platform: 'linux', fs, managerHome: LINUX })
  host.seed.unit(`bgos-agent-${ID}`, agentUnit(LINUX))
  const own = await readBackAgentService({ platform: 'linux', home: LINUX, assistantId: ID, uid: UID, handle: `bgos-agent-${ID}` }, { exec: host.exec, fs })
  assert.equal(own.state, 'own')
  const scratch = await readBackAgentService({ platform: 'linux', home: SCRATCH, assistantId: ID, uid: UID, handle: `bgos-agent-${ID}` }, { exec: host.exec, fs })
  assert.equal(scratch.state, 'foreign')
  assert.equal(scratch.home, LINUX)
  const absent = await readBackAgentService({ platform: 'linux', home: SCRATCH, assistantId: ID, uid: UID, handle: `bgos-agent-${ID}-home-${SCRATCH_ID}` }, { exec: host.exec, fs })
  assert.equal(absent.state, 'absent')
})

// -- restarts read back first ---------------------------------------------------------------------------

test('restart (macOS): this HOME\'s job is kicked; the owner\'s old job seen from a scratch HOME is refused by name and never kicked', async () => {
  const fs = memoryFs()
  const host = fakeServiceHost({ platform: 'darwin', fs, uid: UID })
  const scoped = `ai.bgos.agent.${ID}.home-${MAC_ID}`
  host.seed.launchd(plistPath(MAC, scoped), agentPlist(MAC, scoped))
  const ok = await restartAgent(row(MAC, { kind: 'launchd', handle: scoped, file: plistPath(MAC, scoped) }) as any, { platform: 'darwin', fs, exec: host.exec, uid: UID, pidAlive: () => false })
  assert.equal(ok.ok, true, ok.message)
  assert.deepEqual(host.calls, [`launchctl print gui/${UID}/${scoped}`, `launchctl kickstart -k gui/${UID}/${scoped}`])
  // The owner's 0.69.2 job; the scratch HOME still holds an old plist file of its own for the same agent.
  const legacy = `ai.bgos.agent.${ID}`
  host.seed.launchd(plistPath(MAC, legacy), agentPlist(MAC, legacy))
  fs.writeFile(plistPath(SCRATCH, legacy), agentPlist(SCRATCH, legacy))
  host.calls.length = 0
  const refused = await restartAgent(row(SCRATCH, { kind: 'launchd', handle: legacy, file: plistPath(SCRATCH, legacy) }) as any, { platform: 'darwin', fs, exec: host.exec, uid: UID, pidAlive: () => false })
  assert.equal(refused.ok, false)
  assert.equal(refused.how, 'service')
  assert.match(refused.message, new RegExp(`^refused: the launchd job "${legacy}" records another HOME \\(${MAC}\\), not this one \\(${SCRATCH}\\)`))
  assert.deepEqual(host.calls, [`launchctl print gui/${UID}/${legacy}`], 'read, never kicked')
})

test('restart (Linux): the unit is read back before systemctl restart; another HOME\'s unit under the old name is refused', async () => {
  const fs = memoryFs()
  const host = fakeServiceHost({ platform: 'linux', fs, managerHome: LINUX })
  host.seed.unit(`bgos-agent-${ID}`, agentUnit(LINUX))
  const before = host.startsOf(`${LINUX}/hoai-agents/ava`)
  const refused = await restartAgent(row(SCRATCH, { kind: 'systemd', handle: `bgos-agent-${ID}`, file: unitPath(SCRATCH, `bgos-agent-${ID}`) }) as any, { platform: 'linux', fs, exec: host.exec, uid: UID, pidAlive: () => false })
  assert.equal(refused.ok, false)
  assert.match(refused.message, /^refused: the systemd unit "bgos-agent-912" records another HOME \(\/home\/kc\)/)
  assert.equal(host.calls.some((c) => c.includes(' restart ')), false)
  assert.equal(host.startsOf(`${LINUX}/hoai-agents/ava`), before)
  const own = await restartAgent(row(LINUX, { kind: 'systemd', handle: `bgos-agent-${ID}`, file: unitPath(LINUX, `bgos-agent-${ID}`) }) as any, { platform: 'linux', fs, exec: host.exec, uid: UID, pidAlive: () => false })
  assert.equal(own.ok, true, own.message)
  assert.ok(host.calls.includes(`systemctl --user restart bgos-agent-${ID}`))
})

// -- discovery during the migration: both names --------------------------------------------------------

function posixFs(home: string, files: Record<string, string>): MemoryFs {
  return memoryFs({ [`${home}/.bgos-agent/credentials-${ID}.json`]: '{}', ...files })
}
const inventoryFs = (fs: MemoryFs) => ({ exists: fs.exists, readFile: fs.readFile, listDir: fs.listDir })

test('inventory (posix): the new service file of this HOME is the canonical service; an agent not renamed yet is still canonical under its OLD name; rows carry their HOME', () => {
  const scoped = `ai.bgos.agent.${ID}.home-${MAC_ID}`
  const legacy = `ai.bgos.agent.${ID}`
  const both = posixFs(MAC, { [plistPath(MAC, scoped)]: '<plist/>', [plistPath(MAC, legacy)]: '<plist/>' })
  const [renamed] = listAgents({ home: MAC, platform: 'darwin', fs: inventoryFs(both), execSync: () => ({ code: 1, stdout: '' }), pidAlive: () => false })
  assert.deepEqual(renamed!.service, { kind: 'launchd', handle: scoped, via: 'canonical-file', file: plistPath(MAC, scoped) })
  assert.equal(renamed!.home, MAC)
  const old = posixFs(MAC, { [plistPath(MAC, legacy)]: '<plist/>' })
  const [unrenamed] = listAgents({ home: MAC, platform: 'darwin', fs: inventoryFs(old), execSync: () => ({ code: 1, stdout: '' }), pidAlive: () => false })
  assert.deepEqual(unrenamed!.service, { kind: 'launchd', handle: legacy, via: 'canonical-file', file: plistPath(MAC, legacy) })
  const unit = `bgos-agent-${ID}-home-${LINUX_ID}`
  const linux = posixFs(LINUX, { [unitPath(LINUX, unit)]: '[Service]\n' })
  const [lrow] = listAgents({ home: LINUX, platform: 'linux', fs: inventoryFs(linux), execSync: () => ({ code: 1, stdout: '' }), pidAlive: () => false })
  assert.equal(lrow!.service!.handle, unit)
})

test('the daemon\'s own canonical tier (update-readiness) finds the new name first, the old one while not renamed', () => {
  const scoped = `bgos-agent-${ID}-home-${LINUX_ID}`
  const exists = (files: string[]) => (p: string) => files.includes(p)
  const probe = (files: string[]) => ({ platform: 'linux', home: LINUX, assistantId: ID, cwd: null, ownPid: 1, exists: exists(files), readFile: () => null, listDir: () => [], execSync: () => ({ code: 1, stdout: '' }) })
  assert.deepEqual(resolveSupervision(probe([unitPath(LINUX, scoped), unitPath(LINUX, `bgos-agent-${ID}`)]) as any).service, { kind: 'systemd', handle: scoped, via: 'canonical-file', file: unitPath(LINUX, scoped) })
  assert.deepEqual(resolveSupervision(probe([unitPath(LINUX, `bgos-agent-${ID}`)]) as any).service, { kind: 'systemd', handle: `bgos-agent-${ID}`, via: 'canonical-file', file: unitPath(LINUX, `bgos-agent-${ID}`) })
})

test('always-on (G11): this HOME\'s renamed job is its own canonical supervisor, never "another supervisor" the reconcile defers to', () => {
  const unit = `bgos-agent-${ID}-home-${LINUX_ID}`
  const files: Record<string, string> = { [unitPath(LINUX, unit)]: agentUnit(LINUX) }
  const fs = memoryFs(files)
  const execSync = (file: string, args: string[]) =>
    file === 'systemctl' && args.includes('list-units') ? { code: 0, stdout: `${unit}.service loaded active running BGOS Claude Code agent 912\nother.service loaded active running other\n` } : { code: 1, stdout: '' }
  const reading = readAlwaysOnSupervision({ platform: 'linux', home: LINUX, assistantId: ID, cwd: `${LINUX}/hoai-agents/ava`, ownPid: 1, exists: fs.exists, readFile: fs.readFile, listDir: fs.listDir, execSync, pidAlive: () => false } as any)
  assert.deepEqual(reading, { state: 'none' })
  // Another HOME's scoped unit file found in this HOME is not ours: it is another supervisor.
  const other = `bgos-agent-${ID}-home-${SCRATCH_ID}`
  const ofs = memoryFs({ [unitPath(LINUX, other)]: agentUnit(LINUX) })
  const oexec = (file: string, args: string[]) => (file === 'systemctl' && args.includes('list-units') ? { code: 0, stdout: `${other}.service loaded active running x\n` } : { code: 1, stdout: '' })
  const otherReading = readAlwaysOnSupervision({ platform: 'linux', home: LINUX, assistantId: ID, cwd: `${LINUX}/hoai-agents/ava`, ownPid: 1, exists: ofs.exists, readFile: ofs.readFile, listDir: ofs.listDir, execSync: oexec, pidAlive: () => false } as any)
  assert.equal(otherReading.state, 'other')
})

test('tmux: the agent\'s own server is found on its NEW socket and on its old one, never on another HOME\'s socket', () => {
  const names = agentServiceNames(ID, LINUX_ID)!
  const sockets = [names.tmuxSocket, `hoai-${ID}`]
  const runSh = `${LINUX}/.bgos-agent/${ID}/run.sh`
  assert.equal(isOwnServiceProcess(`tmux -f /dev/null -L ${names.tmuxSocket} new-session -d -s ${names.tmuxSocket}`, sockets, runSh), true)
  assert.equal(isOwnServiceProcess(`tmux: server (/tmp/tmux-501/${names.tmuxSocket})`, sockets, runSh), true)
  assert.equal(isOwnServiceProcess(`tmux: server (/tmp/tmux-501/hoai-${ID})`, sockets, runSh), true)
  assert.equal(isOwnServiceProcess(`tmux -L hoai-${ID}-home-${SCRATCH_ID} new-session -d`, sockets, runSh), false)
  // A single socket still works as before.
  assert.equal(isOwnServiceProcess(`tmux -L hoai-${ID} new-session -d`, `hoai-${ID}`, runSh), true)
})

test('bin/hoai-agent-service.mjs bounds every read-back (a hung user bus is an unreadable probe, never a hung hoai-agent), and a probe that times out is refused', async () => {
  const seen: Array<{ file: string; args: string[]; opts: any }> = []
  const hung = async (file: string, args: readonly string[], opts: any = {}) => {
    seen.push({ file, args: [...args], opts })
    return { code: null, stdout: '', stderr: '', error: 'Command failed: killed', timedOut: true }
  }
  const out: string[] = []
  const code = await agentServiceMain(['probe', '--assistant', ID, '--which', 'own', '--os', 'Linux', '--uid', String(UID)], { env: { HOME: LINUX }, exec: hung as any, fs: memoryFs() as any, out: (l: string) => out.push(l), err: () => {} })
  assert.equal(code, 0)
  assert.ok(seen.length >= 1)
  for (const call of seen) assert.equal(call.opts?.timeoutMs, PROBE_TIMEOUT_MS, `${call.file} ${call.args.join(' ')}`)
  assert.ok(out.includes('state=unknown'), out.join('\n'))
  assert.match(out.find((l) => l.startsWith('say='))!, /^say=refused: which HOME the systemd unit "bgos-agent-912-home-dc88e57d" belongs to could not be read/)
})
