/**
 * Attach scope, the launcher half (board row bab90cdb, design BGOS #1244).
 *
 * The daemon can only tell a right agent from a wrong one when the LAUNCHER
 * says which agent it launched. `hoai` (bin/hoai-core.mjs) is the launcher
 * every current agent starts through (run.sh, the Windows logon task, a hand
 * typed `hoai`), so its run plan names the agent in HOAI_ATTACH_SCOPE and the
 * launch sets it, OVERRIDING an inherited one: an agent's Bash tool that runs
 * `hoai` in another agent's folder must not pass its own scope down.
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FOLDER_PIN_FILE, applyAttachScope, buildRunPlan, main } from '../bin/hoai-core.mjs'
import { ATTACH_SCOPE_DIR_ENV, ATTACH_SCOPE_ENV } from '../lib/attach-scope.mjs'

const POSIX_HOME = '/home/kc'
const CLONE_SCRIPT_DIR = '/home/kc/bgos-claude-plugin/bin'
const noDir = () => [] as string[]
const noFiles = () => null

function readFileServing(path: string, content: string) {
  return (p: string) => (p === path ? content : null)
}

test('run plan: a folder pin scopes the launch to that agent', () => {
  const cwd = '/home/kc/agents/ava'
  const plan = buildRunPlan({
    cwd,
    env: {},
    home: POSIX_HOME,
    readFile: readFileServing(`${cwd}/${FOLDER_PIN_FILE}`, '42\n'),
    listDir: noDir,
    scriptDir: CLONE_SCRIPT_DIR,
  })
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.equal(plan.attachScope, '42')
  assert.equal(plan.attachScopeDir, cwd, 'and the folder it launches in')
})

test('run plan: a BGOS_ASSISTANT_ID env pin scopes the launch to that agent', () => {
  const plan = buildRunPlan({
    cwd: '/home/kc/somewhere',
    env: { BGOS_ASSISTANT_ID: '77' },
    home: POSIX_HOME,
    readFile: noFiles,
    listDir: noDir,
    scriptDir: CLONE_SCRIPT_DIR,
  })
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.equal(plan.attachScope, '77')
})

test('run plan: a supervised launch with a pinless folder scopes to the service agent', () => {
  const plan = buildRunPlan({
    cwd: '/home/kc/somewhere',
    env: { HOAI_SUPERVISED: '1', HOAI_SUPERVISED_ASSISTANT_ID: '900' },
    home: POSIX_HOME,
    readFile: noFiles,
    listDir: () => ['credentials-7.json', 'credentials-900.json'],
    scriptDir: CLONE_SCRIPT_DIR,
  })
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.equal(plan.attachScope, '900')
})

test('run plan: the sole paired agent scopes the launch; no pairing names nobody', () => {
  const sole = buildRunPlan({
    cwd: '/home/kc/somewhere',
    env: {},
    home: POSIX_HOME,
    readFile: noFiles,
    listDir: () => ['credentials-871.json'],
    scriptDir: CLONE_SCRIPT_DIR,
  })
  assert.equal(sole.ok, true)
  if (sole.ok) assert.equal(sole.attachScope, '871')
  const none = buildRunPlan({
    cwd: '/home/kc/somewhere',
    env: {},
    home: POSIX_HOME,
    readFile: noFiles,
    listDir: noDir,
    scriptDir: CLONE_SCRIPT_DIR,
  })
  assert.equal(none.ok, true)
  if (none.ok) {
    assert.equal(none.attachScope, '')
    assert.equal(none.attachScopeDir, '/home/kc/somewhere', 'hoai still says it launched this folder')
  }
})

test('applyAttachScope: the scope folder is set and overridden with the scope, and cleared with nothing to name', () => {
  const env: Record<string, string | undefined> = { [ATTACH_SCOPE_DIR_ENV]: '/agents/parent' }
  applyAttachScope(env, '900', '/agents/child')
  assert.equal(env[ATTACH_SCOPE_DIR_ENV], '/agents/child')
  applyAttachScope(env, '', '/agents/other')
  assert.equal(env[ATTACH_SCOPE_DIR_ENV], '/agents/other', 'hoai launched it even when it names no agent')
  assert.equal(ATTACH_SCOPE_ENV in env, false)
  applyAttachScope(env, '', '')
  assert.equal(ATTACH_SCOPE_DIR_ENV in env, false)
})

test('applyAttachScope: the launcher OVERRIDES an inherited scope, and clears one it cannot name', () => {
  const inherited: Record<string, string | undefined> = { [ATTACH_SCOPE_ENV]: '7', PATH: '/bin' }
  applyAttachScope(inherited, '900')
  assert.equal(inherited[ATTACH_SCOPE_ENV], '900', 'never the parent agent\'s scope')
  const unnamed: Record<string, string | undefined> = { [ATTACH_SCOPE_ENV]: '7' }
  applyAttachScope(unnamed, '')
  assert.equal(ATTACH_SCOPE_ENV in unnamed, false, 'an inherited scope is not passed off as this launch\'s')
  assert.equal(inherited.PATH, '/bin', 'nothing else is touched')
})

// ── end to end: the env claude (and so the daemon) inherits ─────────────────

function childExiting(code: number) {
  const child = new EventEmitter() as EventEmitter & { kill: () => void }
  child.kill = () => child.emit('exit', null, 'SIGTERM')
  setImmediate(() => child.emit('exit', code, null))
  return child
}

test('main: a supervised launch hands the daemon its scope, over an inherited one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'attach-scope-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'attach-scope-agent-'))
  try {
    mkdirSync(join(home, '.bgos-agent'), { recursive: true })
    writeFileSync(join(cwd, FOLDER_PIN_FILE), '900\n')
    // Inherited from a parent agent (7) whose Bash tool ran this launcher.
    const launchEnv: Record<string, string | undefined> = {
      HOAI_SUPERVISED: '1',
      HOAI_SUPERVISED_ASSISTANT_ID: '900',
      [ATTACH_SCOPE_ENV]: '7',
    }
    const spawned: Array<Record<string, string | undefined>> = []
    const code = await main([], {
      platform: 'linux',
      env: launchEnv,
      home,
      cwd,
      scriptDir: CLONE_SCRIPT_DIR,
      listProcesses: () => [],
      print: () => {},
      healthyMs: 60_000,
      hasExpect: true,
      spawnImpl: ((_file: string, _args: readonly string[], opts: { env?: Record<string, string | undefined> }) => {
        spawned.push({ ...(opts?.env ?? {}) })
        return childExiting(0)
      }) as never,
    } as never)
    assert.equal(code, 0)
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0]![ATTACH_SCOPE_ENV], '900', 'the env claude is spawned with, which the daemon inherits')
    assert.equal(spawned[0]![ATTACH_SCOPE_DIR_ENV], cwd, 'and the folder claude is launched in')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
