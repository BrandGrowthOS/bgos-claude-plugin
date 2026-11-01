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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BRIDGE = join(ROOT, 'bin', 'hoai-statusline-bridge.mjs')
const CLI = join(ROOT, 'bin', 'hoai-model-control.mjs')

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'hoai-model-control-'))
}

const SID = '6f1c2b8e-3d4a-4f5b-9c0d-1e2f3a4b5c6d'

/**
 * Seven cases assert POSIX behaviour: forward slash paths, owner only file
 * modes (the store skips its mode check on win32 by design, see
 * lib/model-control-store.mjs) and the owner's status line run through a
 * POSIX shell. model_effort_picker is never declared on Windows (server.ts),
 * so the store never runs there; these skip on win32 rather than assert
 * something the code deliberately does not do (CI test (windows), 7 failures
 * on ce62db1).
 */
const POSIX_ONLY =
  process.platform === 'win32'
    ? 'POSIX paths, modes and status line shell; the picker is never declared on Windows'
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
    input, env: { ...process.env, BGOS_PLUGIN_STATE_DIR: state }, encoding: 'utf8', timeout: 10_000,
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
    input: 'garbage', env: { ...process.env, BGOS_PLUGIN_STATE_DIR: state }, encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(run.status, 0)
  assert.equal(existsSync(join(state, 'model-control', 'observations')), false)
})

test('the owner CLI turns control on for one agent, installing the bridge, and off again', { skip: POSIX_ONLY }, () => {
  const state = tmp()
  const config = tmp()
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo hi' } }))
  const env = { ...process.env, BGOS_PLUGIN_STATE_DIR: state, CLAUDE_CONFIG_DIR: config }
  const on = spawnSync(process.execPath, [CLI, 'on', '--assistant', '42'], { env, encoding: 'utf8' })
  assert.equal(on.status, 0, on.stderr)
  const dir = join(state, 'model-control')
  assert.equal(readOptIn(dir, '42'), true)
  const settings = JSON.parse(readFileSync(join(config, 'settings.json'), 'utf8'))
  assert.match(settings.statusLine.command, /hoai-statusline-bridge\.mjs/)
  // The status line runs the stable copy in the owner only folder, never the
  // plugin's own file, whose folder a marketplace update moves.
  assert.ok(settings.statusLine.command.includes(join(dir, 'bridge', 'bin', 'hoai-statusline-bridge.mjs')))
  assert.ok(!settings.statusLine.command.includes(join(ROOT, 'bin')))
  // And the copy really works as a status line.
  const sid = '99999999-8888-4777-8666-555555555555'
  const copy = spawnSync(process.execPath, [join(dir, 'bridge', 'bin', 'hoai-statusline-bridge.mjs')], {
    input: JSON.stringify({ session_id: sid, model: { id: 'claude-fable-5-1' } }), env, encoding: 'utf8',
  })
  assert.equal(copy.status, 0, copy.stderr)
  assert.equal(copy.stdout, 'hi\n', 'the owner\'s own line still prints')
  assert.equal(readObservation(dir, sid)!.modelId, 'claude-fable-5-1')
  const status = spawnSync(process.execPath, [CLI, 'status', '--assistant', '42'], { env, encoding: 'utf8' })
  assert.equal(status.status, 0)
  assert.match(status.stdout, /on for agent 42/)
  const off = spawnSync(process.execPath, [CLI, 'off', '--assistant', '42'], { env, encoding: 'utf8' })
  assert.equal(off.status, 0, off.stderr)
  assert.equal(readOptIn(dir, '42'), false)
  assert.deepEqual(JSON.parse(readFileSync(join(config, 'settings.json'), 'utf8')).statusLine, { type: 'command', command: 'echo hi' })
  const bad = spawnSync(process.execPath, [CLI, 'on'], { env, encoding: 'utf8' })
  assert.notEqual(bad.status, 0, 'no agent named, nothing is turned on')
})
