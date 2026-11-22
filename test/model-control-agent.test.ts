/**
 * Owner model control turned on by the Helper, per agent: the status line
 * bridge goes into THAT agent's own
 * `<folder>/.claude/settings.local.json`, never the shared
 * `~/.claude/settings.json`, and the opt in is recorded `by: helper`. The
 * owner's own status line keeps running behind the bridge; an owner's own
 * `hoai-model-control off` is remembered and never undone. The app's Settings
 * switch stays the owner's choice, off by default.
 *
 * Real files in scratch folders; the bridge runs as a real child of node.
 *
 * Run: npx tsx --test test/model-control-agent.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  bridgeCommandFor,
  ensureHelperModelControl,
  installAgentBridge,
  installBridge,
  readObservation,
  readOptIn,
  readWrappedStatusLine,
  uninstallAgentBridge,
  writeOptIn,
} from '../lib/model-control-store.mjs'
import { scratchDir } from './helpers/scratch-dirs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BRIDGE = join(ROOT, 'bin', 'hoai-statusline-bridge.mjs')
const SID = '6f1c2b8e-3d4a-4f5b-9c0d-1e2f3a4b5c6d'

function world() {
  const state = scratchDir('hoai-mc-agent-')
  const dir = join(state, 'model-control')
  const folder = join(scratchDir('hoai-mc-folder-'), 'agent-42')
  const config = scratchDir('hoai-mc-config-')
  // The owner's home, with this machine's paired agents in it: only the names
  // of their ~/.bgos-agent/credentials-<id>.json files are ever read.
  const home = scratchDir('hoai-mc-home-')
  mkdirSync(join(home, '.bgos-agent'), { recursive: true })
  writeFileSync(join(home, '.bgos-agent', 'credentials-42.json'), '{}')
  mkdirSync(join(folder, '.claude'), { recursive: true })
  const local = join(folder, '.claude', 'settings.local.json')
  const project = join(folder, '.claude', 'settings.json')
  const shared = join(config, 'settings.json')
  return { state, dir, folder, config, local, project, shared, home }
}

const LINE = (command: string) => ({ type: 'command', command })
// The store knows its own bridge by the script's name in the command, as
// every real bridge command (bridgeCommandFor) carries it.
const AGENT_BRIDGE = 'node /b/hoai-statusline-bridge.mjs --agent 42'
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

test('the bridge goes into the agent\'s own local settings and wraps that file\'s own line', () => {
  const w = world()
  writeFileSync(w.local, JSON.stringify({ hooks: { Stop: [] }, statusLine: { ...LINE('echo mine'), padding: 1 } }))
  const out = installAgentBridge({ settingsPath: w.local, dir: w.dir, assistantId: '42', bridgeCommand: 'node /b/hoai-statusline-bridge.mjs --agent 42', fallbackSettingsPaths: [w.project, w.shared] })
  assert.equal(out.installed, true)
  const local = readJson(w.local)
  assert.deepEqual(local.hooks, { Stop: [] }, 'the file\'s other keys are kept')
  assert.equal(local.statusLine.command, 'node /b/hoai-statusline-bridge.mjs --agent 42')
  assert.equal(local.statusLine.padding, 1)
  assert.equal(readWrappedStatusLine(w.dir, '42')?.command, 'echo mine')
  assert.equal(readWrappedStatusLine(w.dir), null, 'the machine wide record is not this agent\'s')
  // Again, as every launch does: the wrapped line is kept, not replaced by the bridge.
  installAgentBridge({ settingsPath: w.local, dir: w.dir, assistantId: '42', bridgeCommand: 'node /b/hoai-statusline-bridge.mjs --agent 42', fallbackSettingsPaths: [w.project, w.shared] })
  assert.equal(readWrappedStatusLine(w.dir, '42')?.command, 'echo mine')
})

test('with no local line the owner\'s project line, else user line, runs behind the bridge, and neither file is touched', () => {
  const w = world()
  const sharedText = JSON.stringify({ statusLine: LINE('echo user') }, null, 4)
  writeFileSync(w.shared, sharedText)
  installAgentBridge({ settingsPath: w.local, dir: w.dir, assistantId: '42', bridgeCommand: AGENT_BRIDGE, fallbackSettingsPaths: [w.project, w.shared] })
  assert.equal(readWrappedStatusLine(w.dir, '42')?.command, 'echo user')
  assert.equal(readFileSync(w.shared, 'utf8'), sharedText, 'the shared settings file is byte for byte as it was')
  const projectText = JSON.stringify({ statusLine: LINE('echo project') })
  writeFileSync(w.project, projectText)
  installAgentBridge({ settingsPath: w.local, dir: w.dir, assistantId: '42', bridgeCommand: AGENT_BRIDGE, fallbackSettingsPaths: [w.project, w.shared] })
  assert.equal(readWrappedStatusLine(w.dir, '42')?.command, 'echo project', 'the project line wins, read again each launch')
  assert.equal(readFileSync(w.project, 'utf8'), projectText)
})

test('a fallback line that is itself the bridge is never wrapped', () => {
  const w = world()
  writeFileSync(w.shared, JSON.stringify({ statusLine: LINE('node /x/hoai-statusline-bridge.mjs') }))
  installAgentBridge({ settingsPath: w.local, dir: w.dir, assistantId: '42', bridgeCommand: AGENT_BRIDGE, fallbackSettingsPaths: [w.project, w.shared] })
  assert.equal(readWrappedStatusLine(w.dir, '42'), null)
})

// An older `hoai-model-control on` put the machine wide bridge in the shared settings and kept the
// owner's own line in its machine wide record. The agent's bridge must wrap that line, not skip the
// older bridge and wrap nothing, or the owner's line stops printing.
test('a user line run by the older machine wide bridge keeps printing behind the agent\'s bridge', () => {
  const w = world()
  writeFileSync(w.shared, JSON.stringify({ statusLine: LINE('echo owner') }))
  installBridge({ settingsPath: w.shared, dir: w.dir, bridgeCommand: 'node /b/hoai-statusline-bridge.mjs' })
  assert.equal(readWrappedStatusLine(w.dir)?.command, 'echo owner', 'the older on kept the owner\'s line')
  installAgentBridge({ settingsPath: w.local, dir: w.dir, assistantId: '42', bridgeCommand: AGENT_BRIDGE, fallbackSettingsPaths: [w.project, w.shared] })
  assert.equal(readWrappedStatusLine(w.dir, '42')?.command, 'echo owner')
})

// A folder paired again becomes another agent, and its file still holds the bridge of the agent it
// was. That bridge's own record holds the folder's line; skipping it would let an off delete the
// folder's line for good.
test('a bridge left in the folder by the agent it was before keeps the folder\'s own line, and off puts it back', () => {
  const w = world()
  writeFileSync(w.local, JSON.stringify({ statusLine: LINE('echo mine') }))
  installAgentBridge({ settingsPath: w.local, dir: w.dir, assistantId: '41', bridgeCommand: 'node /b/hoai-statusline-bridge.mjs --agent 41', fallbackSettingsPaths: [] })
  writeFileSync(w.shared, JSON.stringify({ statusLine: LINE('echo user') }))
  installAgentBridge({ settingsPath: w.local, dir: w.dir, assistantId: '42', bridgeCommand: AGENT_BRIDGE, fallbackSettingsPaths: [w.project, w.shared] })
  assert.equal(readWrappedStatusLine(w.dir, '42')?.command, 'echo mine')
  assert.equal(readJson(w.local).statusLine.command, AGENT_BRIDGE)
  uninstallAgentBridge({ settingsPath: w.local, dir: w.dir, assistantId: '42' })
  assert.deepEqual(readJson(w.local).statusLine, LINE('echo mine'))
})

test('uninstallAgentBridge puts the local file\'s own line back, or takes the line out', () => {
  const w = world()
  writeFileSync(w.local, JSON.stringify({ statusLine: LINE('echo mine') }))
  installAgentBridge({ settingsPath: w.local, dir: w.dir, assistantId: '42', bridgeCommand: AGENT_BRIDGE, fallbackSettingsPaths: [] })
  assert.equal(uninstallAgentBridge({ settingsPath: w.local, dir: w.dir, assistantId: '42' }).removed, true)
  assert.deepEqual(readJson(w.local).statusLine, LINE('echo mine'))
  const v = world()
  writeFileSync(v.shared, JSON.stringify({ statusLine: LINE('echo user') }))
  installAgentBridge({ settingsPath: v.local, dir: v.dir, assistantId: '42', bridgeCommand: AGENT_BRIDGE, fallbackSettingsPaths: [v.shared] })
  uninstallAgentBridge({ settingsPath: v.local, dir: v.dir, assistantId: '42' })
  assert.equal('statusLine' in readJson(v.local), false, 'the user line was never the local file\'s')
})

test('bridgeCommandFor quotes for the shell Claude Code runs the line in, and refuses a path it cannot quote', () => {
  assert.equal(
    bridgeCommandFor({ nodePath: '/usr/local/bin/node', bridgePath: "/home/o'k/b.mjs", assistantId: '42', platform: 'linux' }),
    `'/usr/local/bin/node' '/home/o'\\''k/b.mjs' --agent 42`,
  )
  assert.equal(
    bridgeCommandFor({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', bridgePath: 'C:\\Users\\a b\\.bgos-plugin-state\\model-control\\bridge\\bin\\hoai-statusline-bridge.mjs', assistantId: '42', platform: 'win32' }),
    '"C:/Program Files/nodejs/node.exe" "C:/Users/a b/.bgos-plugin-state/model-control/bridge/bin/hoai-statusline-bridge.mjs" --agent 42',
  )
  for (const bad of ['C:\\100%\\node.exe', 'C:\\a"b\\node.exe', 'C:\\a!b\\node.exe', 'C:\\$x\\node.exe', 'C:\\a`b\\node.exe']) {
    assert.equal(bridgeCommandFor({ nodePath: bad, bridgePath: 'C:\\b.mjs', assistantId: '42', platform: 'win32' }), null, bad)
  }
  assert.equal(bridgeCommandFor({ nodePath: '/n', bridgePath: '/b', assistantId: '42; rm', platform: 'linux' }), null)
})

const ensure = (w: ReturnType<typeof world>, platform: NodeJS.Platform = 'linux', nowMs = 1_000) =>
  ensureHelperModelControl({ cwd: w.folder, assistantId: '42', dir: w.dir, pluginRoot: ROOT, nodePath: '/usr/bin/node', platform, configDir: w.config, nowMs, home: w.home })

test('the Helper turns control on for its agent: the opt in by helper, the bridge with --agent in the local file, the shared file untouched', () => {
  const w = world()
  const sharedText = JSON.stringify({ theme: 'dark' })
  writeFileSync(w.shared, sharedText)
  const out = ensure(w)
  assert.deepEqual(out, { on: true, reason: 'on' })
  assert.equal(readOptIn(w.dir, '42'), true)
  const optIn = readJson(join(w.dir, 'opt-in.json'))
  assert.equal(optIn.assistants['42'].by, 'helper')
  assert.match(readJson(w.local).statusLine.command, /hoai-statusline-bridge\.mjs' --agent 42$/)
  assert.ok(existsSync(join(w.dir, 'bridge', 'bin', 'hoai-statusline-bridge.mjs')), 'the stable copy')
  assert.equal(readFileSync(w.shared, 'utf8'), sharedText)
  // Every launch: the same answer, nothing doubled.
  assert.deepEqual(ensure(w, 'linux', 2_000), { on: true, reason: 'on' })
  assert.equal(readJson(join(w.dir, 'opt-in.json')).assistants['42'].enabledAt, 1_000, 'the first opt in stands')
})

test('an owner\'s own off is never undone by the Helper', () => {
  const w = world()
  writeOptIn(w.dir, '42', true, 1)
  writeOptIn(w.dir, '42', false, 2)
  assert.deepEqual(ensure(w), { on: false, reason: 'owner_off' })
  assert.equal(readOptIn(w.dir, '42'), false)
  assert.equal(existsSync(w.local), false, 'no settings written')
  writeOptIn(w.dir, '42', true, 3)
  assert.equal(readOptIn(w.dir, '42'), true, 'the owner\'s own on turns it back on')
})

// An `off` made with plugin 0.90.x deleted the agent's entry and rewrote the file without the mark
// this version writes (keepsOffs). In such a file no entry can be an owner's off, so the Helper
// treats it as one, then and on every later launch; only the owner's own on turns it back on.
test('an off made with an older plugin, which left no entry, is never undone by the Helper', () => {
  const w = world()
  writeOptIn(w.dir, '7', true, 1)
  // Exactly what 0.90.x wrote after `on` for 7 and `on` then `off` for 42.
  writeFileSync(join(w.dir, 'opt-in.json'), JSON.stringify({ version: 1, assistants: { '7': { enabledAt: 1 } } }, null, 2))
  assert.deepEqual(ensure(w), { on: false, reason: 'owner_off' })
  assert.equal(readOptIn(w.dir, '42'), false)
  assert.equal(existsSync(w.local), false, 'no settings written')
  assert.equal(readOptIn(w.dir, '7'), true, 'the older plugin\'s own on stands')
  // Still off after this version writes the file for another agent, and on every later launch.
  writeOptIn(w.dir, '9', true, 5, { by: 'helper' })
  assert.deepEqual(ensure(w, 'linux', 6_000), { on: false, reason: 'owner_off' })
  const out = ensureHelperModelControl({ cwd: w.folder, assistantId: '42', dir: w.dir, pluginRoot: ROOT, nodePath: '/usr/bin/node', platform: 'linux', configDir: w.config, nowMs: 7_000, owner: true, home: w.home })
  assert.deepEqual(out, { on: true, reason: 'on' })
  assert.deepEqual(ensure(w, 'linux', 8_000), { on: true, reason: 'on' }, 'the owner\'s own on stands')
})

// An older off is kept per agent, not for every agent on the machine: the agents this machine had
// when this version first read the older file, less those with an entry. Kept machine wide, no
// agent would ever be turned on again after an older opt in, new ones too.
test('an older off is kept per agent: an agent added after the upgrade gets control from the Helper', () => {
  const w = world()
  writeFileSync(join(w.home, '.bgos-agent', 'credentials-7.json'), '{}')
  writeOptIn(w.dir, '7', true, 1)
  // Exactly what 0.90.x wrote after `on` for 7, and `on` then `off` for 42.
  writeFileSync(join(w.dir, 'opt-in.json'), JSON.stringify({ version: 1, assistants: { '7': { enabledAt: 1 } } }, null, 2))
  assert.deepEqual(ensure(w), { on: false, reason: 'owner_off' }, 'an agent this machine had before stays off')
  assert.deepEqual(readJson(join(w.dir, 'opt-in.json')).olderOffs, ['42'])
  // An agent paired after the upgrade.
  const folder = join(scratchDir('hoai-mc-folder-'), 'agent-55')
  mkdirSync(join(folder, '.claude'), { recursive: true })
  writeFileSync(join(w.home, '.bgos-agent', 'credentials-55.json'), '{}')
  const added = ensureHelperModelControl({ cwd: folder, assistantId: '55', dir: w.dir, pluginRoot: ROOT, nodePath: '/usr/bin/node', platform: 'linux', configDir: w.config, nowMs: 2_000, home: w.home })
  assert.deepEqual(added, { on: true, reason: 'on' })
  assert.deepEqual(readJson(join(w.dir, 'opt-in.json')).olderOffs, ['42'], 'the new agent was never one of them')
  // The owner's own on clears that agent's older off, and only its.
  ensureHelperModelControl({ cwd: w.folder, assistantId: '42', dir: w.dir, pluginRoot: ROOT, nodePath: '/usr/bin/node', platform: 'linux', configDir: w.config, nowMs: 3_000, owner: true, home: w.home })
  assert.equal(readJson(join(w.dir, 'opt-in.json')).olderOffs, undefined)
  assert.equal(readOptIn(w.dir, '7'), true)
})

// An agent run in the home folder would have its bridge written into ~/.claude/settings.local.json,
// beside Claude Code's own settings. Refused, and nothing is written.
test('an agent whose folder is the home folder is refused, and nothing is written there', () => {
  const w = world()
  mkdirSync(join(w.home, '.claude'), { recursive: true })
  const at = (cwd: string, configDir: string, owner = false) =>
    ensureHelperModelControl({ cwd, assistantId: '42', dir: w.dir, pluginRoot: ROOT, nodePath: '/usr/bin/node', platform: 'linux', configDir, nowMs: 1_000, owner, home: w.home })
  assert.deepEqual(at(w.home, w.config), { on: false, reason: 'home_folder' })
  assert.deepEqual(at(`${w.home}/`, w.config, true), { on: false, reason: 'home_folder' }, 'the owner\'s own on too')
  assert.equal(existsSync(join(w.home, '.claude', 'settings.local.json')), false)
  // The same for a folder whose .claude is Claude Code's own config folder.
  assert.deepEqual(at(w.folder, join(w.folder, '.claude')), { on: false, reason: 'home_folder' })
  assert.equal(existsSync(w.local), false)
  assert.equal(readOptIn(w.dir, '42'), false)
  assert.equal(existsSync(join(w.dir, 'opt-in.json')), false, 'no opt in recorded')
})

test('the home folder is known in any case on Windows, and through a link to it', () => {
  const w = world()
  const at = (cwd: string, home: string, platform: NodeJS.Platform) =>
    ensureHelperModelControl({ cwd, assistantId: '42', dir: w.dir, pluginRoot: ROOT, nodePath: '/usr/bin/node', platform, configDir: w.config, nowMs: 1_000, home })
  // Windows names one folder in any case: the real home, and a home path no file system can settle.
  assert.deepEqual(at(w.home.toUpperCase(), w.home, 'win32'), { on: false, reason: 'home_folder' })
  const ghost = join(w.home, 'Not-There', 'Mark')
  assert.deepEqual(at(ghost.toUpperCase(), ghost, 'win32'), { on: false, reason: 'home_folder' })
  // A junction (a folder link on POSIX) to the home folder is the home folder.
  const link = join(scratchDir('hoai-mc-link-'), 'home-link')
  symlinkSync(w.home, link, 'junction')
  assert.deepEqual(at(link, w.home, 'linux'), { on: false, reason: 'home_folder' })
  assert.equal(existsSync(join(w.home, '.claude', 'settings.local.json')), false)
  assert.equal(existsSync(join(w.dir, 'opt-in.json')), false, 'no opt in recorded')
})

test('a file this version wrote, without this agent, still lets the Helper turn control on', () => {
  const w = world()
  writeOptIn(w.dir, '7', true, 1, { by: 'helper' })
  assert.deepEqual(ensure(w), { on: true, reason: 'on' })
  assert.equal(readJson(join(w.dir, 'opt-in.json')).assistants['42'].by, 'helper')
})

test('an opt in file that cannot be read keeps the Helper from turning control on, and is not overwritten', () => {
  const w = world()
  writeOptIn(w.dir, '7', true, 1)
  writeFileSync(join(w.dir, 'opt-in.json'), '{ not json')
  assert.deepEqual(ensure(w), { on: false, reason: 'owner_off' })
  assert.equal(readFileSync(join(w.dir, 'opt-in.json'), 'utf8'), '{ not json', 'the file is left as it was')
  assert.equal(existsSync(w.local), false, 'no settings written')
})

test('the owner\'s own on (the CLI) undoes an earlier off and records no helper', () => {
  const w = world()
  writeOptIn(w.dir, '42', false, 2)
  const out = ensureHelperModelControl({ cwd: w.folder, assistantId: '42', dir: w.dir, pluginRoot: ROOT, nodePath: '/usr/bin/node', platform: 'linux', configDir: w.config, nowMs: 9, owner: true })
  assert.deepEqual(out, { on: true, reason: 'on' })
  assert.deepEqual(readJson(join(w.dir, 'opt-in.json')).assistants['42'], { enabledAt: 9 })
  assert.match(readJson(w.local).statusLine.command, /--agent 42$/)
})

test('on Windows an owner status line elsewhere leaves control off rather than run it in the wrong shell', () => {
  const w = world()
  writeFileSync(w.shared, JSON.stringify({ statusLine: LINE('bash ~/.claude/line.sh') }))
  assert.deepEqual(ensure(w, 'win32'), { on: false, reason: 'own_status_line' })
  assert.equal(existsSync(w.local), false)
  assert.equal(readOptIn(w.dir, '42'), false)
  const v = world()
  assert.equal(ensure(v, 'win32').on, true, 'with no owner line it turns on')
  assert.match(readJson(v.local).statusLine.command, /^"\/usr\/bin\/node" ".*hoai-statusline-bridge\.mjs" --agent 42$/)
})

test('a folder settings file that is not plain JSON is left alone', () => {
  const w = world()
  writeFileSync(w.local, '{ // a comment\n }')
  assert.equal(ensure(w).on, false)
  assert.equal(readFileSync(w.local, 'utf8'), '{ // a comment\n }')
  assert.equal(readOptIn(w.dir, '42'), false)
})

test('the bridge with --agent records the observation and runs that agent\'s own wrapped line', () => {
  const w = world()
  mkdirSync(w.dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(w.dir, 'statusline-agent-42.json'), JSON.stringify({
    version: 1,
    wrapped: LINE(`"${process.execPath}" -e "process.stdout.write('agent42')"`),
    from: 'local',
  }), { mode: 0o600 })
  const run = spawnSync(process.execPath, [BRIDGE, '--agent', '42'], {
    input: JSON.stringify({ session_id: SID, model: { id: 'claude-opus-5-5' }, effort: { level: 'high' } }),
    // A fake home, so no test ever sees the real one.
    env: { ...process.env, HOME: w.home, USERPROFILE: w.home, BGOS_PLUGIN_STATE_DIR: w.state },
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, 'agent42')
  assert.equal(readObservation(w.dir, SID)?.effort, 'high')
})
