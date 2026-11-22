/**
 * Owner model and effort control (Route A): the owner's opt in, the status
 * line bridge and the observations it keeps (lib/model-control-store.mjs,
 * bin/hoai-statusline-bridge.mjs, bin/hoai-model-control.mjs).
 *
 * The bridge is the confirmation source: Claude Code runs a status line
 * command with its OWN session JSON on stdin (session_id, model.id,
 * effort.level), and the bridge stores only those facts, numbered by a
 * monotonically increasing sequence, in an owner only folder. A daemon cache,
 * an echoed keystroke or a settings file is never confirmation; a newer
 * observation from the same session is.
 *
 * Everything here runs on temp folders. No real settings file is touched.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BRIDGE_REFRESH_SECONDS,
  bridgeCopyPath,
  installBridge,
  modelControlDir,
  parseStatusLineInput,
  readObservation,
  readOptIn,
  recordObservation,
  refreshBridgeCopy,
  uninstallBridge,
  writeBridgeCopy,
  writeOptIn,
} from '../lib/model-control-store.mjs'
import { scratchDir } from './helpers/scratch-dirs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BRIDGE = join(ROOT, 'bin', 'hoai-statusline-bridge.mjs')
const CLI = join(ROOT, 'bin', 'hoai-model-control.mjs')

function tmp(): string {
  return scratchDir('hoai-model-control-')
}

/** The environment of a spawned CLI or bridge: this process's, with a fresh fake home, so no test ever sees the real one. */
function isolatedEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = tmp()
  return { ...process.env, HOME: home, USERPROFILE: home, ...over }
}

const SID = '6f1c2b8e-3d4a-4f5b-9c0d-1e2f3a4b5c6d'

/**
 * Seven cases assert POSIX behaviour: forward slash paths, owner only file
 * modes (the store skips its mode check on win32 by design, see
 * lib/model-control-store.mjs) and the owner's status line run through a
 * POSIX shell. The store runs on Windows too, for the restart route, but
 * without those: there the Helper never wraps an owner's
 * line (test/model-control-agent.test.ts), so these skip on win32 rather than
 * assert something the code deliberately does not do (CI test (windows)
 * failed 7 of them).
 */
const POSIX_ONLY =
  process.platform === 'win32'
    ? 'POSIX paths, modes and status line shell, which the store does not use on Windows'
    : false

function statusJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: SID,
    transcript_path: `/Users/x/.claude/projects/p/${SID}.jsonl`,
    model: { id: 'claude-opus-5-5', display_name: 'Opus' },
    version: '2.1.309',
    effort: { level: 'high' },
    fast_mode: false,
    ...over,
  })
}

test('the folder is the plugin state root, overridable for tests', { skip: POSIX_ONLY }, () => {
  assert.equal(modelControlDir({ env: {}, home: '/h' }), '/h/.bgos-plugin-state/model-control')
  assert.equal(modelControlDir({ env: { BGOS_PLUGIN_STATE_DIR: '/s' }, home: '/h' }), '/s/model-control')
})

test('the status line input is read for the few facts it needs and nothing else', () => {
  assert.deepEqual(parseStatusLineInput(statusJson()), {
    sessionId: SID,
    modelId: 'claude-opus-5-5',
    modelDisplayName: 'Opus',
    effort: 'high',
    version: '2.1.309',
  })
  // Effort is absent when the model does not support it.
  assert.equal(parseStatusLineInput(statusJson({ effort: undefined }))!.effort, null)
  for (const bad of [
    '', 'not json', '[]', '{}',
    statusJson({ session_id: '../../etc/passwd' }),
    statusJson({ session_id: 'a b' }),
    statusJson({ model: { id: '' } }),
    statusJson({ model: 'opus' }),
    statusJson({ model: { id: 'x'.repeat(300) } }),
    'x'.repeat(300_000),
  ]) {
    assert.equal(parseStatusLineInput(bad), null, bad.slice(0, 60))
  }
  // An effort that is not a plain word is dropped, not trusted.
  assert.equal(parseStatusLineInput(statusJson({ effort: { level: 'high; rm' } }))!.effort, null)
})

test('each observation gets the next sequence number, in an owner only file', { skip: POSIX_ONLY }, () => {
  const dir = join(tmp(), 'model-control')
  const a = recordObservation(dir, parseStatusLineInput(statusJson())!, 1000)
  const b = recordObservation(dir, parseStatusLineInput(statusJson({ effort: { level: 'max' } }))!, 2000)
  assert.equal(a!.seq, 1)
  assert.equal(b!.seq, 2)
  const read = readObservation(dir, SID)
  assert.deepEqual(read, {
    sessionId: SID, modelId: 'claude-opus-5-5', modelDisplayName: 'Opus', effort: 'max',
    version: '2.1.309', seq: 2, observedAtMs: 2000,
  })
  const file = join(dir, 'observations', `${SID}.json`)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(readObservation(dir, 'another-session'), null)
  assert.equal(readObservation(dir, '../x'), null)
})

test('a symlinked or group readable observation is refused', { skip: POSIX_ONLY }, () => {
  const dir = join(tmp(), 'model-control')
  recordObservation(dir, parseStatusLineInput(statusJson())!, 1000)
  const file = join(dir, 'observations', `${SID}.json`)
  chmodSync(file, 0o644)
  assert.equal(readObservation(dir, SID), null, 'not owner only')
  chmodSync(file, 0o600)
  const other = join(tmp(), 'planted.json')
  writeFileSync(other, readFileSync(file), { mode: 0o600 })
  const linkSid = '11111111-2222-3333-4444-555555555555'
  symlinkSync(other, join(dir, 'observations', `${linkSid}.json`))
  assert.equal(readObservation(dir, linkSid), null, 'a symlink is never followed')
})

test('the opt in is per agent, off by default, and refuses a planted file', { skip: POSIX_ONLY }, () => {
  const dir = join(tmp(), 'model-control')
  assert.equal(readOptIn(dir, '42'), false)
  writeOptIn(dir, '42', true, 5)
  assert.equal(readOptIn(dir, '42'), true)
  assert.equal(readOptIn(dir, '43'), false, 'another agent on this machine is not opted in')
  assert.equal(readOptIn(dir, ''), false)
  const file = join(dir, 'opt-in.json')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  chmodSync(file, 0o666)
  assert.equal(readOptIn(dir, '42'), false, 'a world writable opt in is nobody\'s consent')
  chmodSync(file, 0o600)
  writeOptIn(dir, '42', false, 6)
  assert.equal(readOptIn(dir, '42'), false)
  // A symlinked opt in is refused.
  const d2 = join(tmp(), 'model-control')
  mkdirSync(d2, { recursive: true, mode: 0o700 })
  const planted = join(tmp(), 'opt-in.json')
  writeFileSync(planted, JSON.stringify({ version: 1, assistants: { '42': { enabledAt: 1 } } }), { mode: 0o600 })
  symlinkSync(planted, join(d2, 'opt-in.json'))
  assert.equal(readOptIn(d2, '42'), false)
})

test('installing the bridge composes with the owner\'s status line and restores it on removal', () => {
  const home = tmp()
  const settingsPath = join(home, 'settings.json')
  const dir = join(home, 'model-control')
  const theirs = { type: 'command', command: '~/bin/my-status.sh', padding: 1, refreshInterval: 10 }
  writeFileSync(settingsPath, JSON.stringify({ theme: 'dark', statusLine: theirs }, null, 2))
  const out = installBridge({ settingsPath, dir, bridgeCommand: 'node /p/bin/hoai-statusline-bridge.mjs' })
  assert.equal(out.installed, true)
  const after = JSON.parse(readFileSync(settingsPath, 'utf8'))
  assert.equal(after.theme, 'dark', 'every other setting is kept')
  assert.deepEqual(after.statusLine, {
    type: 'command',
    command: 'node /p/bin/hoai-statusline-bridge.mjs',
    padding: 1,
    refreshInterval: BRIDGE_REFRESH_SECONDS,
  })
  // Installing twice never wraps the bridge in itself.
  installBridge({ settingsPath, dir, bridgeCommand: 'node /p/bin/hoai-statusline-bridge.mjs' })
  const config = JSON.parse(readFileSync(join(dir, 'statusline.json'), 'utf8'))
  assert.deepEqual(config.wrapped, theirs)
  uninstallBridge({ settingsPath, dir })
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')).statusLine, theirs)
})

test('installing on a settings file with no status line adds one and removal takes it away', () => {
  const home = tmp()
  const settingsPath = join(home, 'settings.json')
  const dir = join(home, 'model-control')
  installBridge({ settingsPath, dir, bridgeCommand: 'node /b/hoai-statusline-bridge.mjs' })
  assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).statusLine.command, 'node /b/hoai-statusline-bridge.mjs')
  uninstallBridge({ settingsPath, dir })
  assert.equal('statusLine' in JSON.parse(readFileSync(settingsPath, 'utf8')), false)
})

test('a settings file that is not valid JSON is never overwritten', () => {
  const home = tmp()
  const settingsPath = join(home, 'settings.json')
  writeFileSync(settingsPath, '{ "theme": "dark", // a comment\n }')
  const out = installBridge({ settingsPath, dir: join(home, 'mc'), bridgeCommand: 'node /b/hoai-statusline-bridge.mjs' })
  assert.equal(out.installed, false)
  assert.equal(readFileSync(settingsPath, 'utf8'), '{ "theme": "dark", // a comment\n }')
})

test('the bridge records the observation and prints the wrapped status line', { skip: POSIX_ONLY }, () => {
  const state = tmp()
  const dir = join(state, 'model-control')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'statusline.json'), JSON.stringify({
    version: 1,
    wrapped: { type: 'command', command: 'printf "mine:%s" "$(cat | wc -c | tr -d " ")"' },
  }), { mode: 0o600 })
  const input = statusJson()
  const run = spawnSync(process.execPath, [BRIDGE], {
    input, env: isolatedEnv({ BGOS_PLUGIN_STATE_DIR: state }), encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, `mine:${Buffer.byteLength(input)}`, 'the owner\'s own line, fed the same JSON')
  assert.equal(readObservation(dir, SID)!.seq, 1)
})

test('the daemon refreshes an existing copy only while an agent is opted in, and never creates one', { skip: POSIX_ONLY }, () => {
  const dir = join(tmp(), 'model-control')
  assert.equal(refreshBridgeCopy(dir, ROOT), false, 'nobody opted in, nothing written')
  assert.equal(existsSync(bridgeCopyPath(dir)), false)
  writeOptIn(dir, '42', true, 1)
  assert.equal(refreshBridgeCopy(dir, ROOT), false, 'no copy yet: the owner\'s own `on` makes it')
  writeBridgeCopy(dir, ROOT)
  writeFileSync(bridgeCopyPath(dir), 'old', { mode: 0o600 })
  assert.equal(refreshBridgeCopy(dir, ROOT), true)
  assert.equal(readFileSync(bridgeCopyPath(dir), 'utf8'), readFileSync(BRIDGE, 'utf8'))
  assert.equal(statSync(bridgeCopyPath(dir)).mode & 0o777, 0o600)
})

test('the bridge never fails the status line, even on garbage', () => {
  const state = tmp()
  const run = spawnSync(process.execPath, [BRIDGE], {
    input: 'garbage', env: isolatedEnv({ BGOS_PLUGIN_STATE_DIR: state }), encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(run.status, 0)
  assert.equal(existsSync(join(state, 'model-control', 'observations')), false)
})

test('the owner CLI turns control on for one agent in its own folder, never in the shared settings, and off again', () => {
  const state = tmp()
  const config = tmp()
  const folder = join(tmp(), 'agent-42')
  mkdirSync(join(folder, '.claude'), { recursive: true })
  const sharedText = JSON.stringify({ theme: 'dark' })
  writeFileSync(join(config, 'settings.json'), sharedText)
  const env = isolatedEnv({ BGOS_PLUGIN_STATE_DIR: state, CLAUDE_CONFIG_DIR: config })
  const local = join(folder, '.claude', 'settings.local.json')
  const on = spawnSync(process.execPath, [CLI, 'on', '--assistant', '42', '--folder', folder], { env, encoding: 'utf8' })
  assert.equal(on.status, 0, on.stderr)
  const dir = join(state, 'model-control')
  assert.equal(readOptIn(dir, '42'), true)
  assert.equal(readFileSync(join(config, 'settings.json'), 'utf8'), sharedText, 'the shared settings file is byte for byte as it was')
  const command = JSON.parse(readFileSync(local, 'utf8')).statusLine.command as string
  assert.match(command, /hoai-statusline-bridge\.mjs["']? --agent 42$/)
  // The status line runs the stable copy in the owner only folder, never the
  // plugin's own file, whose folder a marketplace update moves.
  const fwd = (p: string) => p.replace(/\\/g, '/')
  assert.ok(fwd(command).includes(fwd(join(dir, 'bridge', 'bin', 'hoai-statusline-bridge.mjs'))))
  assert.ok(!fwd(command).includes(fwd(join(ROOT, 'bin'))))
  // And the copy really works as this agent's status line.
  const sid = '99999999-8888-4777-8666-555555555555'
  const copy = spawnSync(process.execPath, [join(dir, 'bridge', 'bin', 'hoai-statusline-bridge.mjs'), '--agent', '42'], {
    input: JSON.stringify({ session_id: sid, model: { id: 'claude-fable-5-1' } }), env, encoding: 'utf8',
  })
  assert.equal(copy.status, 0, copy.stderr)
  assert.equal(readObservation(dir, sid)!.modelId, 'claude-fable-5-1')
  const status = spawnSync(process.execPath, [CLI, 'status', '--assistant', '42', '--folder', folder], { env, encoding: 'utf8' })
  assert.equal(status.status, 0)
  assert.match(status.stdout, /on for agent 42; the status line bridge is installed/)
  const off = spawnSync(process.execPath, [CLI, 'off', '--assistant', '42', '--folder', folder], { env, encoding: 'utf8' })
  assert.equal(off.status, 0, off.stderr)
  assert.equal(readOptIn(dir, '42'), false)
  assert.equal('statusLine' in JSON.parse(readFileSync(local, 'utf8')), false)
  assert.equal(readFileSync(join(config, 'settings.json'), 'utf8'), sharedText)
  // The owner's own on works again after their off (the Helper's never does).
  const again = spawnSync(process.execPath, [CLI, 'on', '--assistant', '42', '--folder', folder], { env, encoding: 'utf8' })
  assert.equal(again.status, 0, again.stderr)
  assert.equal(readOptIn(dir, '42'), true)
  const bad = spawnSync(process.execPath, [CLI, 'on'], { env, encoding: 'utf8' })
  assert.notEqual(bad.status, 0, 'no agent named, nothing is turned on')
})

// Nothing here ever writes the shared user settings, not even to take an older version's bridge out
// of it: `off` tells the owner the bridge is there and that they may remove it.
test('the owner CLI off leaves an older bridge in the shared settings byte for byte, and says the owner can remove it', () => {
  const state = tmp()
  const config = tmp()
  const home = tmp()
  const folder = join(tmp(), 'agent-42')
  mkdirSync(join(folder, '.claude'), { recursive: true })
  const dir = join(state, 'model-control')
  const shared = join(config, 'settings.json')
  // Exactly what an older `hoai-model-control on` left: its bridge in the shared file, the owner's line kept aside.
  writeFileSync(shared, JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'echo mine' } }, null, 2))
  installBridge({ settingsPath: shared, dir, bridgeCommand: 'node /old/hoai-statusline-bridge.mjs' })
  const sha = () => createHash('sha256').update(readFileSync(shared)).digest('hex')
  const before = sha()
  const env = isolatedEnv({ BGOS_PLUGIN_STATE_DIR: state, CLAUDE_CONFIG_DIR: config, HOME: home, USERPROFILE: home })
  const off = spawnSync(process.execPath, [CLI, 'off', '--assistant', '42', '--folder', folder], { env, encoding: 'utf8' })
  assert.equal(off.status, 0, off.stderr)
  assert.equal(sha(), before, 'the shared settings file is byte for byte as it was')
  assert.match(off.stdout, /older version left its status line bridge in .*settings\.json.*You can remove it from that file yourself.*did not change that file/s)
  // With no older bridge there, nothing is said about it.
  writeFileSync(shared, JSON.stringify({ theme: 'dark' }))
  const quiet = spawnSync(process.execPath, [CLI, 'off', '--assistant', '42', '--folder', folder], { env, encoding: 'utf8' })
  assert.equal(quiet.status, 0, quiet.stderr)
  assert.doesNotMatch(quiet.stdout, /older version/)
})

test('the owner CLI refuses an agent folder that is the home folder, and writes nothing there', () => {
  const state = tmp()
  const config = tmp()
  const home = tmp()
  mkdirSync(join(home, '.claude'), { recursive: true })
  const env = isolatedEnv({ BGOS_PLUGIN_STATE_DIR: state, CLAUDE_CONFIG_DIR: config, HOME: home, USERPROFILE: home })
  const on = spawnSync(process.execPath, [CLI, 'on', '--assistant', '42', '--folder', home], { env, encoding: 'utf8' })
  assert.notEqual(on.status, 0)
  assert.match(on.stderr, /home folder.*Nothing was changed/s)
  assert.equal(existsSync(join(home, '.claude', 'settings.local.json')), false)
  assert.equal(readOptIn(join(state, 'model-control'), '42'), false)
  // An off there records the off and leaves the home folder's .claude files as they are.
  const homeLocal = join(home, '.claude', 'settings.local.json')
  writeFileSync(homeLocal, JSON.stringify({ statusLine: { type: 'command', command: 'node /x/hoai-statusline-bridge.mjs --agent 42' } }))
  const before = readFileSync(homeLocal, 'utf8')
  const off = spawnSync(process.execPath, [CLI, 'off', '--assistant', '42', '--folder', home], { env, encoding: 'utf8' })
  assert.equal(off.status, 0, off.stderr)
  assert.equal(readFileSync(homeLocal, 'utf8'), before)
  const status = spawnSync(process.execPath, [CLI, 'status', '--assistant', '42', '--folder', home], { env, encoding: 'utf8' })
  assert.match(status.stdout, /off for agent 42; its folder is your home folder, where nothing is written\./)
})

// A `~` the shell did not expand (quoted, or passed by a program) is a folder named `~` under
// wherever the command runs, and `on` would create it there. Refused, by every verb, and so is
// `~name`, another person's home in a shell, which is no more expanded here.
test('the owner CLI refuses a folder with a ~ the shell did not expand, and creates nothing', () => {
  const state = tmp()
  const config = tmp()
  const here = tmp()
  const env = isolatedEnv({ BGOS_PLUGIN_STATE_DIR: state, CLAUDE_CONFIG_DIR: config })
  for (const raw of ['~', '~/agent-42', '~\\agent-42', '~bob', '~bob/agent-42', '~bob\\agent-42']) {
    for (const verb of ['on', 'off', 'status']) {
      const run = spawnSync(process.execPath, [CLI, verb, '--assistant', '42', '--folder', raw], { env, cwd: here, encoding: 'utf8' })
      assert.notEqual(run.status, 0, `${verb} ${raw}`)
      assert.match(run.stderr, /starts with ~, which was not turned into your home folder.*full path.*Nothing was changed/s, `${verb} ${raw}`)
    }
  }
  assert.deepEqual(readdirSync(here), [], 'no folder made where the command ran')
  assert.equal(existsSync(join(state, 'model-control', 'opt-in.json')), false)
})

test('the owner CLI finds the agent\'s folder from its launch record, and refuses rather than guess without one', () => {
  const state = tmp()
  const config = tmp()
  const home = tmp()
  const folder = join(tmp(), 'agent-43')
  mkdirSync(join(folder, '.claude'), { recursive: true })
  const here = tmp()
  mkdirSync(join(here, '.claude'), { recursive: true })
  const env = {
    ...isolatedEnv(), BGOS_PLUGIN_STATE_DIR: state, CLAUDE_CONFIG_DIR: config, HOME: home, USERPROFILE: home,
  }
  const dir = join(state, 'model-control')
  // No --folder and no launch record: nothing is turned on, and the folder
  // the command happens to run in is never written.
  const guess = spawnSync(process.execPath, [CLI, 'on', '--assistant', '43'], { env, cwd: here, encoding: 'utf8' })
  assert.notEqual(guess.status, 0)
  assert.match(guess.stderr, /no record of where agent 43 runs.*--folder.*Nothing was changed/s)
  assert.equal(readOptIn(dir, '43'), false)
  assert.equal(existsSync(join(here, '.claude', 'settings.local.json')), false)
  // With the launch record, its folder is the one turned on.
  mkdirSync(join(home, '.bgos-agent', '43'), { recursive: true })
  writeFileSync(join(home, '.bgos-agent', '43', 'launch.json'), JSON.stringify({ cwd: folder }))
  const on = spawnSync(process.execPath, [CLI, 'on', '--assistant', '43'], { env, cwd: here, encoding: 'utf8' })
  assert.equal(on.status, 0, on.stderr)
  assert.equal(readOptIn(dir, '43'), true)
  const local = JSON.parse(readFileSync(join(folder, '.claude', 'settings.local.json'), 'utf8'))
  assert.match(local.statusLine.command as string, /--agent 43$/)
  assert.equal(existsSync(join(here, '.claude', 'settings.local.json')), false)
})

test('the owner CLI keeps the owner\'s own user line printing behind the bridge, and puts nothing back in the shared file', { skip: POSIX_ONLY }, () => {
  const state = tmp()
  const config = tmp()
  const folder = join(tmp(), 'agent-42')
  mkdirSync(join(folder, '.claude'), { recursive: true })
  const sharedText = JSON.stringify({ statusLine: { type: 'command', command: 'echo hi' } })
  writeFileSync(join(config, 'settings.json'), sharedText)
  const env = isolatedEnv({ BGOS_PLUGIN_STATE_DIR: state, CLAUDE_CONFIG_DIR: config })
  const on = spawnSync(process.execPath, [CLI, 'on', '--assistant', '42', '--folder', folder], { env, encoding: 'utf8' })
  assert.equal(on.status, 0, on.stderr)
  const dir = join(state, 'model-control')
  const copy = spawnSync(process.execPath, [join(dir, 'bridge', 'bin', 'hoai-statusline-bridge.mjs'), '--agent', '42'], {
    input: JSON.stringify({ session_id: SID, model: { id: 'claude-fable-5-1' } }), env, encoding: 'utf8',
  })
  assert.equal(copy.status, 0, copy.stderr)
  assert.equal(copy.stdout, 'hi\n', 'the owner\'s own line still prints')
  const off = spawnSync(process.execPath, [CLI, 'off', '--assistant', '42', '--folder', folder], { env, encoding: 'utf8' })
  assert.equal(off.status, 0, off.stderr)
  assert.equal(readFileSync(join(config, 'settings.json'), 'utf8'), sharedText)
})
