import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import * as core from '../lib/lane-core.mjs'
import { prepareLaneLaunch } from '../lib/lane-supervisor.mjs'
import { buildGateAutoAcceptExpect } from '../bin/hoai-core.mjs'

function rig() {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'lane-safety-')))
  const paths = core.lanePaths({ home, assistantId: '1076', userId: 'user_test' })
  fs.mkdirSync(paths.workDir, { recursive: true })
  fs.mkdirSync(join(home, '.bgos-agent'), { recursive: true })
  const logs: string[] = []
  const launch = (mode: string) => prepareLaneLaunch({
    o: { home, assistantId: '1076', userId: 'user_test', ownerEnv: {}, nodePath: process.execPath, pluginRoot: process.cwd() },
    fs, paths, platform: process.platform, login: { mode, configDir: paths.configDir },
    launchFacts: async () => ({ policy: { v: 1, shell: true }, read: true }),
    readClaudeJson: () => null, log: (line: string) => logs.push(line), now: Date.now,
  } as never)
  return { home, paths, logs, launch, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

test('the daemon carries its transcript folder explicitly', async () => {
  const r = rig()
  try {
    await r.launch('own_token')
    const env = JSON.parse(fs.readFileSync(r.paths.mcpPath, 'utf8')).mcpServers.bgos.env
    assert.equal(env.HOAI_LANE_CLAUDE_CONFIG_DIR, r.paths.configDir)
    const source = fs.readFileSync(new URL('../lane-server.ts', import.meta.url), 'utf8')
    assert.match(source, /laneClaudeHome\(process.env, HOME\)/)
    const homeFor = core.laneClaudeHome
    assert.equal(typeof homeFor, 'function')
    assert.equal(homeFor({ HOAI_LANE_CLAUDE_CONFIG_DIR: '/lane-config', CLAUDE_CONFIG_DIR: '/other' }, '/home'), '/lane-config')
    assert.equal(homeFor({ CLAUDE_CONFIG_DIR: '/custom' }, '/home'), '/custom')
    assert.equal(homeFor({}, '/home'), join('/home', '.claude'))
  } finally { r.cleanup() }
})

test('an unattended lane closes on a pending CLI event', { skip: process.platform === 'win32' }, () => {
  const r = rig()
  try {
    const scriptPath = join(r.home, 'child.sh')
    fs.writeFileSync(scriptPath, 'sleep 0.2\nprintf "Do you want to create check.txt?\\n1. Yes\\n2. No\\n"\nread answer\nprintf "%s" "$answer" > accepted\n')
    fs.writeFileSync(join(r.paths.laneDir, 'permission-pending'), '1')
    const script = buildGateAutoAcceptExpect({ claudePath: '/bin/sh', args: [scriptPath], gateBlock: 'set hoai_outcome live\nset hoai_answered {}\nset hoai_screen {}', supervised: { stateDir: r.paths.laneDir, interactive: false, compact: '', denyPermissionPrompts: true } } as never)
    const result = spawnSync('expect', ['-c', script], { cwd: r.paths.workDir, encoding: 'utf8', timeout: 4_000 })
    assert.equal(result.status, 88, `${result.error ?? ''} ${result.stdout} ${result.stderr}`)
    assert.equal(fs.existsSync(join(r.paths.workDir, 'accepted')), false)
  } finally { r.cleanup() }
})

test('the current lane release note stays plain', () => {
  const text = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  assert.ok(text.includes('Running commands is not available for people you share with yet.'))
  assert.ok(text.includes('Your own tools are not available for people you share with yet.'))
  assert.doesNotMatch(text, /shell-host|Shell requires|`shell` is honoured|`ownerMcpServers` copies/)
  assert.ok(text.includes('An independent review led to stricter lane settings, with tests and mutations.'))
})

test('an unattended lane keeps an ordinary question running', { skip: process.platform === 'win32' }, () => {
  const r = rig()
  try {
    const scriptPath = join(r.home, 'child.sh')
    fs.writeFileSync(scriptPath, 'printf "Do you want to see the result?\\n"\nsleep 0.2\n')
    const script = buildGateAutoAcceptExpect({ claudePath: '/bin/sh', args: [scriptPath], gateBlock: 'set hoai_outcome live\nset hoai_answered {}\nset hoai_screen {}', supervised: { stateDir: r.paths.laneDir, interactive: false, compact: '', denyPermissionPrompts: true } } as never)
    const result = spawnSync('expect', ['-c', script], { cwd: r.paths.workDir, encoding: 'utf8', timeout: 4_000 })
    assert.equal(result.status, 0, `${result.error ?? ''} ${result.stdout} ${result.stderr}`)
  } finally { r.cleanup() }
})

for (const active of [false, true]) {
  test(`the unattended tail keeps an ${active ? 'active' : 'idle'} lane running`, { skip: process.platform === 'win32' }, () => {
    const r = rig()
    try {
      fs.writeFileSync(r.paths.laneJsonPath, JSON.stringify({ inFlight: active }))
      const scriptPath = join(r.home, 'child.sh')
      fs.writeFileSync(scriptPath, 'sleep 2\n')
      const script = buildGateAutoAcceptExpect({ claudePath: '/bin/sh', args: [scriptPath], gateBlock: 'set hoai_outcome live\nset hoai_answered {}\nset hoai_screen {}', supervised: { stateDir: r.paths.laneDir, interactive: false, compact: '', denyPermissionPrompts: true } } as never).replace('set timeout 300', 'set timeout 1')
      const result = spawnSync('expect', ['-c', script], { cwd: r.paths.workDir, encoding: 'utf8', timeout: 4_000 })
      assert.equal(result.status, 0, `${result.error ?? ''} ${result.stdout} ${result.stderr}`)
    } finally { r.cleanup() }
  })
}
