import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { lanePaths } from '../lib/lane-core.mjs'
import { prepareLaneLaunch } from '../lib/lane-supervisor.mjs'
import { buildGateAutoAcceptExpect } from '../bin/hoai-core.mjs'

function rig() {
  const home = fs.realpathSync(fs.mkdtempSync(join(process.cwd(), 'node_modules/lane-admission-')))
  const paths = lanePaths({ home, assistantId: '1076', userId: 'user_test' })
  fs.mkdirSync(paths.workDir, { recursive: true })
  return { home, paths, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

test('the unattended tail follows CLI events', { skip: process.platform === 'win32' }, () => {
  const r = rig()
  try {
    const childPath = join(r.home, 'child.sh')
    fs.writeFileSync(childPath, 'sleep 0.2\nprintf "Would you like to proceed? 1) Yes 2) No\\n"\nsleep 1.5\n')
    const script = buildGateAutoAcceptExpect({ claudePath: '/bin/sh', args: [childPath], gateBlock: 'set hoai_outcome live\nset hoai_answered {}\nset hoai_screen {}', supervised: { stateDir: r.paths.laneDir, interactive: false, compact: '', denyPermissionPrompts: true } } as never)
    fs.writeFileSync(r.paths.laneJsonPath, '{"inFlight":true}')
    const ordinary = spawnSync('expect', ['-c', script.replace('set timeout 300', 'set timeout 1')], { cwd: r.paths.workDir, encoding: 'utf8', timeout: 5000 })
    assert.equal(ordinary.status, 0, ordinary.stdout)
    fs.writeFileSync(join(r.paths.laneDir, 'permission-pending'), '1')
    const pending = spawnSync('expect', ['-c', script], { cwd: r.paths.workDir, encoding: 'utf8', timeout: 5000 })
    assert.equal(pending.status, 88, pending.stdout)
  } finally { r.cleanup() }
})

test('lane policy hooks block on failure', async () => {
  const r = rig()
  try {
    await prepareLaneLaunch({
      o: { home: r.home, assistantId: '1076', userId: 'user_test', ownerEnv: {}, nodePath: process.execPath, pluginRoot: process.cwd() },
      fs, paths: r.paths, platform: process.platform, login: { mode: 'inherit' },
      launchFacts: async () => ({ policy: { v: 1 }, read: true }),
      log: () => {}, now: Date.now,
    })
    const settings = JSON.parse(fs.readFileSync(r.paths.settingsPath, 'utf8'))
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].onFailure, 'block')
  } finally { r.cleanup() }
})
