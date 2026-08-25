/**
 * lib/agent-restart.mjs: restart one agent through the strongest authority
 * it has (design 1.5 / 7.4): a live hoai supervisor -> the restart marker; a
 * per-agent service -> launchctl kickstart -k / systemctl --user restart; a
 * validated launch recipe -> relaunch hoai-core in the recipe cwd under a pty
 * (tmux, script) or a visible terminal / console; nothing -> named as manual.
 * Every argv is pinned per platform and mechanism, and NO mechanism ever
 * passes --resume / --continue / --session-id or a session id (hoai-core
 * resumes the agent's OWN pinned session by itself; landmine 3).
 *
 * Run: npx tsx --test test/agent-restart.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  hoaiCorePath,
  recipeLaunchCommand,
  restartAgent,
  serviceRestartCommand,
  shellQuote,
} from '../lib/agent-restart.mjs'
import { memoryFs } from './helpers/memory-fs.ts'

const SESSION = '11111111-1111-4111-8111-111111111111'
const ROOT = '/home/kc/.claude/plugins/cache/hoai/hoai/0.38.3'
const WIN_ROOT = 'C:\\Users\\kc\\.claude\\plugins\\cache\\hoai\\hoai\\0.38.3'

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    assistantId: '912',
    cwd: '/home/kc/hoai-agents/ava',
    recipe: {
      schemaVersion: 1,
      assistantId: '912',
      cwd: '/home/kc/hoai-agents/ava',
      argv: ['--dangerously-skip-permissions', '--dangerously-load-development-channels', 'plugin:hoai@hoai'],
      installMethod: 'marketplace',
      pluginRoot: '/home/kc/.claude/plugins/cache/hoai/hoai/0.38.2',
      node: '/usr/local/bin/node',
      startedAt: '2026-08-25T00:00:00.000Z',
      launcher: 'hoai',
      pid: 4242,
    },
    supervisor: 'none',
    running: false,
    serviceFile: null,
    sessionId: SESSION,
    stateDir: '/home/kc/.bgos-agent/912',
    pluginStateDir: '/home/kc/.bgos-plugin-state/912',
    liveMarkerPath: '/home/kc/.bgos-plugin-state/912/channel-live.json',
    credentialsPath: '/home/kc/.bgos-agent/credentials-912.json',
    notes: [],
    ...overrides,
  }
}

/** Assert an argv carries no session identity (landmine 3). */
function assertNoSessionArgs(argv: readonly string[]) {
  const joined = argv.join(' ')
  for (const flag of ['--resume', '--continue', '--session-id']) {
    assert.equal(joined.includes(flag), false, `argv must not carry ${flag}: ${joined}`)
  }
  assert.equal(joined.includes(SESSION), false, `argv must not carry the session id: ${joined}`)
}

function recordingSpawn() {
  const spawns: Array<{ file: string; args: string[]; opts: any }> = []
  const spawnDetached = (file: string, args: readonly string[], opts: any) => {
    spawns.push({ file, args: [...args], opts })
    return { pid: 999 }
  }
  return { spawns, spawnDetached }
}

function recordingExec(code = 0, stderr = '') {
  const calls: Array<{ file: string; args: string[] }> = []
  const exec = async (file: string, args: readonly string[]) => {
    calls.push({ file, args: [...args] })
    return { code, stdout: '', stderr, error: null, timedOut: false }
  }
  return { calls, exec }
}

const BASE_DEPS = {
  pluginRoot: ROOT,
  nodePath: '/usr/local/bin/node',
  env: {},
  now: () => 1_700_000_000_000,
  uid: 501,
  comspec: 'C:\\Windows\\System32\\cmd.exe',
}

// -- pure builders --------------------------------------------------------------------

test('hoaiCorePath + shellQuote', () => {
  assert.equal(hoaiCorePath(ROOT), `${ROOT}/bin/hoai-core.mjs`)
  assert.equal(hoaiCorePath(WIN_ROOT), `${WIN_ROOT}\\bin\\hoai-core.mjs`)
  assert.equal(shellQuote('/usr/local/bin/node'), "'/usr/local/bin/node'")
  assert.equal(shellQuote("/Users/o'brien/node"), "'/Users/o'\\''brien/node'")
})

test('serviceRestartCommand: immediate kickstart -k (darwin) / systemctl --user restart (linux); none on win32 or without a uid', () => {
  assert.deepEqual(serviceRestartCommand({ platform: 'darwin', assistantId: '912', uid: 501 }), {
    file: 'launchctl',
    args: ['kickstart', '-k', 'gui/501/ai.bgos.agent.912'],
  })
  assert.deepEqual(serviceRestartCommand({ platform: 'linux', assistantId: '912', uid: null }), {
    file: 'systemctl',
    args: ['--user', 'restart', 'bgos-agent-912'],
  })
  assert.equal(serviceRestartCommand({ platform: 'darwin', assistantId: '912', uid: null }), null)
  assert.equal(serviceRestartCommand({ platform: 'win32', assistantId: '912', uid: null }), null)
  assert.equal(serviceRestartCommand({ platform: 'linux', assistantId: 'x; rm', uid: null }), null)
})

test('recipeLaunchCommand posix: tmux when available (detached session named hoai-<id>, -c cwd, one shell-quoted command)', () => {
  const cmd = recipeLaunchCommand({ platform: 'linux', assistantId: '912', cwd: '/home/kc/hoai-agents/ava', nodePath: '/usr/local/bin/node', pluginRoot: ROOT, hasTmux: true, hasScript: true })
  assert.deepEqual(cmd, {
    how: 'recipe-tmux',
    file: 'tmux',
    args: ['new-session', '-d', '-s', 'hoai-912', '-c', '/home/kc/hoai-agents/ava', `'/usr/local/bin/node' '${ROOT}/bin/hoai-core.mjs'`],
    spawnOpts: { cwd: '/home/kc/hoai-agents/ava', windowsHide: true },
  })
  assertNoSessionArgs(cmd!.args)
})

test('recipeLaunchCommand darwin: script -q /dev/null node core when no tmux', () => {
  const cmd = recipeLaunchCommand({ platform: 'darwin', assistantId: '912', cwd: '/Users/kc/ava', nodePath: '/opt/homebrew/bin/node', pluginRoot: ROOT, hasTmux: false, hasScript: true })
  assert.deepEqual(cmd, {
    how: 'recipe-script',
    file: 'script',
    args: ['-q', '/dev/null', '/opt/homebrew/bin/node', `${ROOT}/bin/hoai-core.mjs`],
    spawnOpts: { cwd: '/Users/kc/ava', windowsHide: true },
  })
})

test('recipeLaunchCommand linux: script -qc "<node> <core>" /dev/null when no tmux', () => {
  const cmd = recipeLaunchCommand({ platform: 'linux', assistantId: '912', cwd: '/home/kc/ava', nodePath: '/usr/bin/node', pluginRoot: ROOT, hasTmux: false, hasScript: true })
  assert.deepEqual(cmd, {
    how: 'recipe-script',
    file: 'script',
    args: ['-qc', `'/usr/bin/node' '${ROOT}/bin/hoai-core.mjs'`, '/dev/null'],
    spawnOpts: { cwd: '/home/kc/ava', windowsHide: true },
  })
})

test('recipeLaunchCommand posix terminal fallback: osascript Terminal (darwin) / the first terminal emulator on PATH (linux), else null', () => {
  const mac = recipeLaunchCommand({ platform: 'darwin', assistantId: '912', cwd: '/Users/kc/ava', nodePath: '/usr/local/bin/node', pluginRoot: ROOT, hasTmux: false, hasScript: false, hasCommand: () => false })
  assert.deepEqual(mac, {
    how: 'recipe-terminal',
    file: 'osascript',
    args: ['-e', `tell application "Terminal" to do script "cd '/Users/kc/ava' && '/usr/local/bin/node' '${ROOT}/bin/hoai-core.mjs'"`],
    spawnOpts: { cwd: '/Users/kc/ava', windowsHide: true },
  })
  const gnome = recipeLaunchCommand({ platform: 'linux', assistantId: '912', cwd: '/home/kc/ava', nodePath: '/usr/bin/node', pluginRoot: ROOT, hasTmux: false, hasScript: false, hasCommand: (n: string) => n === 'gnome-terminal' })
  assert.deepEqual(gnome, {
    how: 'recipe-terminal',
    file: 'gnome-terminal',
    args: ['--', 'bash', '-c', `'/usr/bin/node' '${ROOT}/bin/hoai-core.mjs'; exec bash`],
    spawnOpts: { cwd: '/home/kc/ava', windowsHide: true },
  })
  const xterm = recipeLaunchCommand({ platform: 'linux', assistantId: '912', cwd: '/home/kc/ava', nodePath: '/usr/bin/node', pluginRoot: ROOT, hasTmux: false, hasScript: false, hasCommand: (n: string) => n === 'xterm' })
  assert.deepEqual(xterm?.file, 'xterm')
  assert.deepEqual(xterm?.args, ['-e', 'bash', '-c', `'/usr/bin/node' '${ROOT}/bin/hoai-core.mjs'; exec bash`])
  // x-terminal-emulator outranks the others, mirroring open_terminal_with.
  const xte = recipeLaunchCommand({ platform: 'linux', assistantId: '912', cwd: '/home/kc/ava', nodePath: '/usr/bin/node', pluginRoot: ROOT, hasTmux: false, hasScript: false, hasCommand: () => true })
  assert.equal(xte?.file, 'x-terminal-emulator')
  assert.equal(
    recipeLaunchCommand({ platform: 'linux', assistantId: '912', cwd: '/home/kc/ava', nodePath: '/usr/bin/node', pluginRoot: ROOT, hasTmux: false, hasScript: false, hasCommand: () => false }),
    null,
  )
})

test('recipeLaunchCommand win32: cmd.exe /c start "HOAI agent <id>" /D "<cwd>" cmd /k "<node> <core>", verbatim args, visible window', () => {
  const cmd = recipeLaunchCommand({
    platform: 'win32',
    assistantId: '912',
    cwd: 'C:\\Users\\kc\\hoai-agents\\ava',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    pluginRoot: WIN_ROOT,
    comspec: 'C:\\Windows\\System32\\cmd.exe',
  })
  assert.deepEqual(cmd, {
    how: 'recipe-console',
    file: 'C:\\Windows\\System32\\cmd.exe',
    args: [
      '/c',
      'start',
      '"HOAI agent 912"',
      '/D',
      '"C:\\Users\\kc\\hoai-agents\\ava"',
      'cmd',
      '/k',
      `""C:\\Program Files\\nodejs\\node.exe" "${WIN_ROOT}\\bin\\hoai-core.mjs""`,
    ],
    spawnOpts: { cwd: 'C:\\Users\\kc\\hoai-agents\\ava', windowsVerbatimArguments: true, windowsHide: false },
  })
  assertNoSessionArgs(cmd!.args)
  // A double quote in a path cannot be represented on that command line.
  assert.equal(
    recipeLaunchCommand({ platform: 'win32', assistantId: '912', cwd: 'C:\\x"y', nodePath: 'node', pluginRoot: WIN_ROOT, comspec: 'cmd.exe' }),
    null,
  )
})

// -- restartAgent --------------------------------------------------------------------

test('restartAgent: launcher-live writes the restart marker ({}) and nothing else', async () => {
  const fs = memoryFs()
  const { spawns, spawnDetached } = recordingSpawn()
  const { calls, exec } = recordingExec()
  const result = await restartAgent(agentRow({ supervisor: 'launcher-live', running: true }), { ...BASE_DEPS, platform: 'linux', fs, exec, spawnDetached })
  assert.deepEqual(result, { ok: true, how: 'marker', message: 'restart marker written; the live hoai launcher relaunches the agent as itself', detail: { path: '/home/kc/.bgos-agent/912/restart-requested.json' } })
  assert.equal(fs.files.get('/home/kc/.bgos-agent/912/restart-requested.json'), '{}')
  assert.equal(spawns.length, 0)
  assert.equal(calls.length, 0)
})

test('restartAgent: a marker write failure is reported, not thrown', async () => {
  const fs = memoryFs()
  fs.writeFile = () => {
    throw new Error('EROFS')
  }
  const result = await restartAgent(agentRow({ supervisor: 'launcher-live' }), { ...BASE_DEPS, platform: 'linux', fs, exec: recordingExec().exec, spawnDetached: recordingSpawn().spawnDetached })
  assert.equal(result.ok, false)
  assert.equal(result.how, 'marker')
  assert.match(result.message, /EROFS/)
})

test('restartAgent: service on darwin runs launchctl kickstart -k; on linux systemctl --user restart; a non-zero rc is a named failure', async () => {
  const { calls, exec } = recordingExec()
  const mac = await restartAgent(agentRow({ supervisor: 'service', serviceFile: '/x.plist' }), { ...BASE_DEPS, platform: 'darwin', fs: memoryFs(), exec, spawnDetached: recordingSpawn().spawnDetached })
  assert.deepEqual(calls, [{ file: 'launchctl', args: ['kickstart', '-k', 'gui/501/ai.bgos.agent.912'] }])
  assert.equal(mac.ok, true)
  assert.equal(mac.how, 'service')
  const linux = recordingExec()
  await restartAgent(agentRow({ supervisor: 'service', serviceFile: '/x.service' }), { ...BASE_DEPS, platform: 'linux', fs: memoryFs(), exec: linux.exec, spawnDetached: recordingSpawn().spawnDetached })
  assert.deepEqual(linux.calls, [{ file: 'systemctl', args: ['--user', 'restart', 'bgos-agent-912'] }])
  const failing = recordingExec(5, 'Failed to restart bgos-agent-912.service: Unit not found.')
  const bad = await restartAgent(agentRow({ supervisor: 'service', serviceFile: '/x.service' }), { ...BASE_DEPS, platform: 'linux', fs: memoryFs(), exec: failing.exec, spawnDetached: recordingSpawn().spawnDetached })
  assert.equal(bad.ok, false)
  assert.equal(bad.how, 'service')
  assert.equal(bad.message, 'systemctl --user restart bgos-agent-912 failed (rc 5): Failed to restart bgos-agent-912.service: Unit not found.')
})

test('restartAgent: service on darwin without a uid falls through to the recipe (never a blind service call)', async () => {
  const { spawns, spawnDetached } = recordingSpawn()
  const { calls, exec } = recordingExec()
  const result = await restartAgent(agentRow({ supervisor: 'service', serviceFile: '/x.plist' }), { ...BASE_DEPS, platform: 'darwin', uid: null, fs: memoryFs(), exec, spawnDetached, hasTmux: true })
  assert.equal(calls.length, 0)
  assert.equal(result.how, 'recipe-tmux')
  assert.equal(spawns.length, 1)
})

test('restartAgent: recipe-only on linux launches node <CURRENT pluginRoot>/bin/hoai-core.mjs in the recipe cwd under tmux (never the stale recipe root)', async () => {
  const { spawns, spawnDetached } = recordingSpawn()
  const result = await restartAgent(agentRow(), { ...BASE_DEPS, platform: 'linux', fs: memoryFs(), exec: recordingExec().exec, spawnDetached, hasTmux: true, hasScript: true })
  assert.equal(result.ok, true)
  assert.equal(result.how, 'recipe-tmux')
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0]!.file, 'tmux')
  assert.deepEqual(spawns[0]!.args, ['new-session', '-d', '-s', 'hoai-912', '-c', '/home/kc/hoai-agents/ava', `'/usr/local/bin/node' '${ROOT}/bin/hoai-core.mjs'`])
  assert.equal(spawns[0]!.opts.cwd, '/home/kc/hoai-agents/ava')
  assert.equal(spawns[0]!.args.join(' ').includes('0.38.2'), false, 'the recipe plugin root (old version) must not be used')
  assertNoSessionArgs(spawns[0]!.args)
})

test('restartAgent: recipe-only on win32 opens a visible cmd /k console in the recipe cwd', async () => {
  const { spawns, spawnDetached } = recordingSpawn()
  const agent = agentRow({
    cwd: 'C:\\Users\\kc\\hoai-agents\\ava',
    recipe: { ...agentRow().recipe, cwd: 'C:\\Users\\kc\\hoai-agents\\ava', pluginRoot: WIN_ROOT, node: 'C:\\Program Files\\nodejs\\node.exe' },
    stateDir: 'C:\\Users\\kc\\.bgos-agent\\912',
  })
  const result = await restartAgent(agent, { ...BASE_DEPS, platform: 'win32', pluginRoot: WIN_ROOT, nodePath: 'C:\\Program Files\\nodejs\\node.exe', fs: memoryFs(), exec: recordingExec().exec, spawnDetached })
  assert.equal(result.ok, true)
  assert.equal(result.how, 'recipe-console')
  assert.equal(spawns[0]!.file, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(spawns[0]!.args, [
    '/c',
    'start',
    '"HOAI agent 912"',
    '/D',
    '"C:\\Users\\kc\\hoai-agents\\ava"',
    'cmd',
    '/k',
    `""C:\\Program Files\\nodejs\\node.exe" "${WIN_ROOT}\\bin\\hoai-core.mjs""`,
  ])
  assert.deepEqual(spawns[0]!.opts, { cwd: 'C:\\Users\\kc\\hoai-agents\\ava', windowsVerbatimArguments: true, windowsHide: false, env: {} })
  assertNoSessionArgs(spawns[0]!.args)
})

test('restartAgent: recipe-only falls back to the recipe node/pluginRoot when deps carry none', async () => {
  const { spawns, spawnDetached } = recordingSpawn()
  const result = await restartAgent(agentRow(), { platform: 'darwin', env: {}, now: Date.now, uid: 501, fs: memoryFs(), exec: recordingExec().exec, spawnDetached, hasTmux: false, hasScript: true })
  assert.equal(result.how, 'recipe-script')
  assert.deepEqual(spawns[0]!.args, ['-q', '/dev/null', '/usr/local/bin/node', '/home/kc/.claude/plugins/cache/hoai/hoai/0.38.2/bin/hoai-core.mjs'])
})

test('restartAgent: a spawn failure is a named failure; no pty or terminal is a named failure', async () => {
  const boom = () => {
    throw new Error('spawn tmux ENOENT')
  }
  const failed = await restartAgent(agentRow(), { ...BASE_DEPS, platform: 'linux', fs: memoryFs(), exec: recordingExec().exec, spawnDetached: boom, hasTmux: true })
  assert.equal(failed.ok, false)
  assert.equal(failed.how, 'recipe-tmux')
  assert.match(failed.message, /spawn tmux ENOENT/)
  const nothing = await restartAgent(agentRow(), { ...BASE_DEPS, platform: 'linux', fs: memoryFs(), exec: recordingExec().exec, spawnDetached: recordingSpawn().spawnDetached, hasTmux: false, hasScript: false, hasCommand: () => false })
  assert.deepEqual(nothing, { ok: false, how: 'recipe-terminal', message: 'no_pty_or_terminal_available: install tmux (preferred) or script, or start the agent by hand: cd /home/kc/hoai-agents/ava && hoai' })
})

test('restartAgent: no supervisor and no usable recipe is manual_restart_required, nothing spawned', async () => {
  const { spawns, spawnDetached } = recordingSpawn()
  const result = await restartAgent(agentRow({ recipe: null, cwd: null, notes: ['recipe_cwd_missing:/gone'] }), { ...BASE_DEPS, platform: 'linux', fs: memoryFs(), exec: recordingExec().exec, spawnDetached, hasTmux: true })
  assert.deepEqual(result, { ok: false, how: 'none', message: 'manual_restart_required: no live launcher, no service, no usable launch recipe (recipe_cwd_missing:/gone)' })
  assert.equal(spawns.length, 0)
})
