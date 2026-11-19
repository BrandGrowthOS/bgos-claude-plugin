import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  appendFileSync,
  symlinkSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { applyHelperAccount } from '../lib/helper-account-launch.mjs'
import { sessionTranscriptPath, superviseClaude } from '../bin/hoai-core.mjs'
import { detectInstallMethod } from '../bin/bgos-install-method.mjs'
import { createAccountWatcher } from '../lib/helper-account-watcher.mjs'
import { nodeFs } from '../lib/watcher-bundle.mjs'

test('the ordinary supervisor starts its pinned conversation using the computer default and the current HOAI install', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'launch-account-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const id = randomUUID(),
    pin = randomUUID()
  const cwd = join(home, 'work'),
    root = join(home, '.bgos-agent', 'helper-accounts'),
    dest = join(root, id)
  mkdirSync(dest, { recursive: true, mode: 0o700 })
  const write = (file: string, content: string) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  write(
    join(root, 'registry.json'),
    JSON.stringify({
      version: 1,
      machineId: 'machine-12345',
      pairingId: 23,
      ownerUserId: 'owner',
      accounts: [{ id, label: 'Fixture A' }],
      targets: { computer: { choice: id } },
    }),
  )
  write(
    join(home, '.bgos-agent', 'watcher', 'credentials.json'),
    JSON.stringify({ machineId: 'machine-12345', pairingId: 23, backendUrl: 'http://127.0.0.1:1' }),
  )
  write(
    join(home, '.bgos-agent', 'credentials-41.json'),
    JSON.stringify({ assistantId: 41, userId: 'owner', pairingId: 13, backendUrl: 'http://127.0.0.1:1' }),
  )
  const source = sessionTranscriptPath(home, cwd, pin)
  write(source, 'first turn\n')
  const plugin = join(home, '.claude', 'plugins', 'cache', 'hoai', 'hoai', '0.90.11')
  write(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'hoai' }))
  write(
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'hoai@hoai': [{ scope: 'user', installPath: plugin, version: '0.90.11' }],
        'other@else': [{ scope: 'user', installPath: home }],
      },
    }),
  )
  const scriptDir = join(plugin, 'bin')
  mkdirSync(scriptDir)
  const env: any = { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-ambient-credential' }
  applyHelperAccount({ home, cwd, env, assistantId: '41', sessionId: pin, sessionTranscriptPath, scriptDir })
  assert.equal(env.CLAUDE_CONFIG_DIR, dest)
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
  const resumed = sessionTranscriptPath(home, cwd, pin, dest)
  assert.equal(readFileSync(resumed, 'utf8'), 'first turn\n')
  appendFileSync(resumed, 'second turn\n')
  assert.equal(readFileSync(source, 'utf8'), 'first turn\nsecond turn\n')
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dest, 'plugins', 'installed_plugins.json'), 'utf8')).plugins), [
    'hoai@hoai',
  ])
  assert.equal(
    detectInstallMethod({ env, home, scriptPath: join(scriptDir, 'bgos-install-method.mjs') }).channelSpec,
    'plugin:hoai@hoai',
  )
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(home, '.bgos-agent', '41'), { recursive: true })
  writeFileSync(join(cwd, '.bgos-agent-id'), '41')
  writeFileSync(join(home, '.bgos-agent', '41', 'session-id'), pin)
  const launches: any[] = []
  const exit = await superviseClaude(['--dangerously-load-development-channels', 'plugin:hoai@hoai'], {
    platform: 'darwin',
    home,
    cwd,
    scriptDir,
    env: { BGOS_ASSISTANT_ID: '41' },
    hasExpect: false,
    probeIdentityFlag: () => null,
    pidAlive: () => false,
    pidProcess: () => null,
    listProcesses: () => [],
    fetchImpl: async () => {
      throw new Error('no network in this fixture')
    },
    print: () => {},
    writeErr: () => {},
    spawnImpl: (name: string, args: string[], opts: any) => {
      launches.push({ name, args, dir: opts.env.CLAUDE_CONFIG_DIR })
      const fake = new EventEmitter()
      setImmediate(() => fake.emit('exit', 0, null))
      return fake
    },
  })
  assert.equal(exit, 0)
  assert.deepEqual(
    launches.map((x) => x.dir),
    [dest],
  )
  assert.deepEqual(launches[0].args.slice(-2), ['--resume', pin])
  const oldSlot = join(home, '.bgos-agent', 'credentials.json')
  write(oldSlot, readFileSync(join(home, '.bgos-agent', 'credentials-41.json'), 'utf8'))
  rmSync(join(home, '.bgos-agent', 'credentials-41.json'))
  const legacy: any = {}
  applyHelperAccount({ home, cwd, env: legacy, assistantId: '41', sessionId: pin, sessionTranscriptPath })
  assert.equal(legacy.CLAUDE_CONFIG_DIR, dest)
  const outsider = join(home, 'elsewhere')
  mkdirSync(outsider)
  const project = dirname(resumed)
  rmSync(project, { recursive: true })
  symlinkSync(outsider, project, 'dir')
  assert.throws(() => applyHelperAccount({ home, cwd, env: {}, assistantId: '41', sessionId: pin, sessionTranscriptPath }))
  assert.equal(existsSync(join(outsider, pin + '.jsonl')), false)
  write(
    join(home, '.bgos-agent', 'credentials-41.json'),
    JSON.stringify({ assistantId: 41, userId: 'another', pairingId: 13, backendUrl: 'http://127.0.0.1:1' }),
  )
  const other: any = {}
  applyHelperAccount({ home, cwd, env: other, assistantId: '41', sessionId: pin, sessionTranscriptPath })
  assert.equal(other.CLAUDE_CONFIG_DIR, undefined)
  assert.throws(() => applyHelperAccount({
    home, cwd, env: { CLAUDE_CONFIG_DIR: dest }, assistantId: '41', sessionId: pin, sessionTranscriptPath,
  }), /account_profile_unavailable/)
})

test('the desktop status command runs only in the registered login with ambient auth removed', { skip: process.platform === 'win32' }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'account-cli-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const bin = join(home, '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  const id = randomUUID()
  const profile = join(home, '.bgos-agent', 'helper-accounts', id)
  writeFileSync(join(bin, 'claude'), [
    '#!' + process.execPath,
    'const args = process.argv.slice(2).join(" ")',
    'if (args === "--version") console.log("2.1.317 (Claude Code)")',
    'else if (args === "auth status --json") console.log(JSON.stringify({',
    '  loggedIn: process.env.CLAUDE_CONFIG_DIR === ' + JSON.stringify(profile) + ' &&',
    '    !process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.anthropic_api_key,',
    '  authMethod: "claude.ai", email: "discarded@fixture.invalid"',
    '}))',
    'else process.exit(2)',
  ].join('\n'), { mode: 0o700 })
  const machineId = 'machine12345'
  const watcher = createAccountWatcher({
    home, now: Date.now, credentials: { machineId, pairingId: 9 }, fs: nodeFs(),
    env: { HOME: home, PATH: bin, CLAUDE_CODE_OAUTH_TOKEN: 'fixture', anthropic_api_key: 'fixture' },
  }, { uuid: () => id, list: () => [] })
  await watcher.run(randomUUID(), {
    op: 'helper_accounts', requestedBy: 'owner', ownerUserId: 'fixture', machineId, watcherPairingId: 9,
    targets: [], accountCommand: { action: 'add', label: 'Fixture' },
  })
  const snapshot = await watcher.snapshot()
  assert.deepEqual(snapshot.accounts, [{ id, label: 'Fixture', signedIn: true, usage: null }])
  assert.ok(!JSON.stringify(snapshot).includes('discarded'))
})
