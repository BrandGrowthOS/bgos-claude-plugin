import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

import {
  EMPTY_WRAPPER_STATE,
  HEALTHY_AFTER_MS,
  daemonSpawnSpec,
  installStableWrapper,
  isIntentionalRollbackExit,
  isIntentionalUpdateExit,
  normalizeCoreState,
  normalizeWrapperState,
  pendingTargetForCommit,
  rollbackInstalledUpdate,
  stableWrapperPath,
  superviseDaemon,
  transitionWrapperBoot,
  validateAndInstallStableWrapper,
  wrapperFlagMode,
} from '../bin/bgos-daemon-wrapper.mjs'

const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)

function pendingCoreState() {
  return {
    schemaVersion: 1,
    disabled: false,
    resetArmed: false,
    previousCommit: COMMIT_A,
    previousVersion: '0.25.0',
    targetCommit: COMMIT_B,
    targetVersion: '0.26.0',
    crashCount: 0,
    validationPending: true,
    validationBootStartedAt: null,
    rollbackPending: false,
    lastRollbackFromCommit: null,
    lastRollbackFromVersion: null,
  }
}

test('wrapper flag handling is exact and off wins as reset mode', () => {
  assert.equal(wrapperFlagMode('on'), 'monitor')
  assert.equal(wrapperFlagMode('off'), 'reset')
  for (const value of [undefined, '', 'ON', 'true', 'off ']) {
    assert.equal(wrapperFlagMode(value), 'transparent')
  }
})

test('wrapper counts two consecutive fast boots before rollback', () => {
  const first = transitionWrapperBoot(EMPTY_WRAPPER_STATE, COMMIT_B, 1_000)
  assert.equal(first.action, 'none')
  assert.ok(first.state)
  assert.equal(first.state.crashCount, 0)
  assert.equal(first.state.bootStartedAt, 1_000)

  const second = transitionWrapperBoot(first.state, COMMIT_B, 2_000)
  assert.equal(second.action, 'none')
  assert.ok(second.state)
  assert.equal(second.state.crashCount, 1)

  const third = transitionWrapperBoot(second.state, COMMIT_B, 3_000)
  assert.equal(third.action, 'rollback')
  assert.ok(third.state)
  assert.equal(third.state.crashCount, 2)
  assert.equal(third.state.bootStartedAt, null)
})

test('wrapper healthy window breaks the crash streak', () => {
  const prior = {
    schemaVersion: 1,
    targetCommit: COMMIT_B,
    crashCount: 1,
    bootStartedAt: 1_000,
  }
  const next = transitionWrapperBoot(
    prior,
    COMMIT_B,
    1_000 + HEALTHY_AFTER_MS,
  )
  assert.equal(next.action, 'none')
  assert.ok(next.state)
  assert.equal(next.state.crashCount, 0)
  assert.equal(next.state.bootStartedAt, 1_000 + HEALTHY_AFTER_MS)
})

test('malformed wrapper state fails closed', () => {
  assert.equal(
    normalizeWrapperState({
      schemaVersion: 1,
      targetCommit: '../../not-a-commit',
      crashCount: 99,
      bootStartedAt: 1,
    }),
    null,
  )
})

test('wrapper monitors only the recorded installed target', () => {
  const state = pendingCoreState()
  assert.equal(pendingTargetForCommit(state, COMMIT_B), COMMIT_B)
  assert.equal(pendingTargetForCommit(state, COMMIT_A), null)
  assert.equal(pendingTargetForCommit({ ...state, disabled: true }, COMMIT_B), null)
  assert.equal(
    pendingTargetForCommit({ ...state, rollbackPending: true }, COMMIT_B),
    null,
  )
})

test('intentional update exit requires exit zero, a moved checkout, and pending target', () => {
  const coreState = pendingCoreState()
  assert.equal(
    isIntentionalUpdateExit({
      code: 0,
      startedCommit: COMMIT_A,
      installedCommit: COMMIT_B,
      coreState,
    }),
    true,
  )
  assert.equal(
    isIntentionalUpdateExit({
      code: 1,
      startedCommit: COMMIT_A,
      installedCommit: COMMIT_B,
      coreState,
    }),
    false,
  )
  assert.equal(
    isIntentionalUpdateExit({
      code: 0,
      startedCommit: COMMIT_B,
      installedCommit: COMMIT_B,
      coreState,
    }),
    false,
  )
})

test('intentional rollback exit requires the durable disabled state', () => {
  const coreState = {
    ...pendingCoreState(),
    disabled: true,
    previousCommit: null,
    previousVersion: null,
    targetCommit: null,
    targetVersion: null,
    validationPending: false,
    lastRollbackFromCommit: COMMIT_B,
    lastRollbackFromVersion: '0.26.0',
  }
  assert.equal(
    isIntentionalRollbackExit({
      code: 0,
      startedCommit: COMMIT_B,
      installedCommit: COMMIT_A,
      coreState,
    }),
    true,
  )
  assert.equal(
    isIntentionalRollbackExit({
      code: 1,
      startedCommit: COMMIT_B,
      installedCommit: COMMIT_A,
      coreState,
    }),
    false,
  )
})

test('daemon spawn uses fixed bun argv without a shell', () => {
  assert.deepEqual(daemonSpawnSpec('/opt/bgos plugin'), {
    file: 'bun',
    args: ['/opt/bgos plugin/server.ts'],
  })
})

test('unset flag is transparent and performs no update state or git work', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-wrapper-off-'))
  const stateDir = join(home, '.bgos-plugin-state', '42')
  const wrapperStatePath = join(stateDir, 'auto-update-wrapper.json')
  await mkdir(stateDir, { recursive: true })
  await writeFile(wrapperStatePath, 'leave this untouched\n')
  let execCalls = 0
  const code = await superviseDaemon({
    pluginDir: '/opt/plugin',
    installedWrapperPath: '/opt/wrapper',
    env: { BGOS_ASSISTANT_ID: '42' },
    home,
    handleSignals: false,
    exec: async () => {
      execCalls += 1
      throw new Error('git must not run')
    },
    spawnChild: () => ({}),
    waitForChild: async () => ({ code: 0, signal: null }),
  })
  assert.equal(code, 0)
  assert.equal(execCalls, 0)
  assert.equal(await readFile(wrapperStatePath, 'utf8'), 'leave this untouched\n')
})

test('wrapper writes the boot marker before spawning mutable code', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-wrapper-boot-'))
  const stateDir = join(home, '.bgos-plugin-state', '42')
  const coreStatePath = join(stateDir, 'auto-update.json')
  const wrapperStatePath = join(stateDir, 'auto-update-wrapper.json')
  await mkdir(stateDir, { recursive: true })
  await writeFile(coreStatePath, JSON.stringify(pendingCoreState()))
  let markerSeenBeforeSpawn = false
  const code = await superviseDaemon({
    pluginDir: '/opt/plugin',
    installedWrapperPath: '/opt/wrapper',
    env: { BGOS_AUTO_UPDATE: 'on', BGOS_ASSISTANT_ID: '42' },
    home,
    now: () => 4_000,
    handleSignals: false,
    exec: async () => ({ stdout: `${COMMIT_B}\n`, stderr: '' }),
    spawnChild: () => {
      const marker = JSON.parse(readFileSync(wrapperStatePath, 'utf8'))
      markerSeenBeforeSpawn = marker.targetCommit === COMMIT_B
      return {}
    },
    waitForChild: async () => ({ code: 1, signal: null }),
  })
  assert.equal(code, 1)
  assert.equal(markerSeenBeforeSpawn, true)
  const marker = JSON.parse(await readFile(wrapperStatePath, 'utf8'))
  assert.equal(marker.bootStartedAt, 4_000)
})

test('update child exits zero without replacing the stable wrapper before health', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bgos-wrapper-update-exit-'))
  const home = join(root, 'home')
  const pluginDir = join(root, 'plugin')
  const installedWrapperPath = stableWrapperPath(home)
  const stateDir = join(home, '.bgos-plugin-state', '42')
  const coreStatePath = join(stateDir, 'auto-update.json')
  await mkdir(join(pluginDir, 'bin'), { recursive: true })
  await mkdir(join(installedWrapperPath, '..'), { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await writeFile(
    join(pluginDir, 'bin', 'bgos-daemon-wrapper.mjs'),
    'new wrapper\n',
  )
  await writeFile(installedWrapperPath, 'old wrapper\n')
  let revParseCalls = 0
  const code = await superviseDaemon({
    pluginDir,
    installedWrapperPath,
    env: { BGOS_AUTO_UPDATE: 'on', BGOS_ASSISTANT_ID: '42' },
    home,
    log: () => {},
    handleSignals: false,
    exec: async () => {
      revParseCalls += 1
      return {
        stdout: `${revParseCalls === 1 ? COMMIT_A : COMMIT_B}\n`,
        stderr: '',
      }
    },
    spawnChild: () => ({}),
    waitForChild: async () => {
      await writeFile(coreStatePath, JSON.stringify(pendingCoreState()))
      return { code: 0, signal: null }
    },
  })
  assert.equal(code, 0)
  assert.equal(await readFile(installedWrapperPath, 'utf8'), 'old wrapper\n')
})

test('candidate wrapper is validated before atomic stable replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bgos-wrapper-validate-'))
  const source = join(root, 'candidate.mjs')
  const target = join(root, 'stable.mjs')
  await writeFile(source, 'candidate\n')
  await writeFile(target, 'stable\n')
  const calls: Array<{ file: string; args: readonly string[] }> = []
  const exec = async (file: string, args: readonly string[]) => {
    calls.push({ file, args: [...args] })
    return { stdout: '', stderr: '' }
  }
  assert.equal(
    await validateAndInstallStableWrapper({
      sourcePath: source,
      targetPath: target,
      exec,
    }),
    target,
  )
  assert.deepEqual(calls, [
    { file: 'bun', args: [source, '--validate'] },
  ])
  assert.equal(await readFile(target, 'utf8'), 'candidate\n')
})

test('failed candidate validation keeps the previous stable wrapper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bgos-wrapper-invalid-candidate-'))
  const source = join(root, 'candidate.mjs')
  const target = join(root, 'stable.mjs')
  await writeFile(source, 'broken candidate\n')
  await writeFile(target, 'stable\n')
  assert.equal(
    await validateAndInstallStableWrapper({
      sourcePath: source,
      targetPath: target,
      exec: async () => {
        throw new Error('parse failed')
      },
      log: () => {},
    }),
    null,
  )
  assert.equal(await readFile(target, 'utf8'), 'stable\n')
})

test('strict core parser rejects impossible pending transitions', () => {
  const valid = pendingCoreState()
  assert.notEqual(normalizeCoreState(valid), null)
  assert.equal(
    normalizeCoreState({ ...valid, targetVersion: '1.0.0' }),
    null,
  )
  assert.equal(
    normalizeCoreState({ ...valid, targetVersion: '0.25.0' }),
    null,
  )
  assert.equal(
    normalizeCoreState({ ...valid, crashCount: 1 }),
    null,
  )
  assert.equal(
    normalizeCoreState({
      ...valid,
      crashCount: 1,
      rollbackPending: true,
    }),
    null,
  )
  assert.equal(
    normalizeCoreState({ ...valid, previousVersion: null }),
    null,
  )
  assert.equal(
    normalizeCoreState({ ...valid, lastRollbackFromCommit: COMMIT_A }),
    null,
  )
})

test('pending update refuses to spawn when checkout identity cannot be read', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-wrapper-head-fail-'))
  const stateDir = join(home, '.bgos-plugin-state', '42')
  await mkdir(stateDir, { recursive: true })
  await writeFile(
    join(stateDir, 'auto-update.json'),
    JSON.stringify(pendingCoreState()),
  )
  let spawned = false
  const code = await superviseDaemon({
    pluginDir: '/opt/plugin',
    installedWrapperPath: '/opt/wrapper',
    env: { BGOS_AUTO_UPDATE: 'on', BGOS_ASSISTANT_ID: '42' },
    home,
    handleSignals: false,
    log: () => {},
    exec: async () => {
      throw new Error('git unavailable')
    },
    spawnChild: () => {
      spawned = true
      return {}
    },
  })
  assert.equal(code, 1)
  assert.equal(spawned, false)
})

test('pending update refuses to spawn when boot marker cannot be saved', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-wrapper-marker-fail-'))
  const stateDir = join(home, '.bgos-plugin-state', '42')
  await mkdir(stateDir, { recursive: true })
  await writeFile(
    join(stateDir, 'auto-update.json'),
    JSON.stringify(pendingCoreState()),
  )
  let spawned = false
  const code = await superviseDaemon({
    pluginDir: '/opt/plugin',
    installedWrapperPath: '/opt/wrapper',
    env: { BGOS_AUTO_UPDATE: 'on', BGOS_ASSISTANT_ID: '42' },
    home,
    handleSignals: false,
    log: () => {},
    exec: async () => ({ stdout: `${COMMIT_B}\n`, stderr: '' }),
    saveState: () => false,
    spawnChild: () => {
      spawned = true
      return {}
    },
  })
  assert.equal(code, 1)
  assert.equal(spawned, false)
})

test('pending update refuses to spawn with a malformed wrapper marker', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-wrapper-marker-corrupt-'))
  const stateDir = join(home, '.bgos-plugin-state', '42')
  await mkdir(stateDir, { recursive: true })
  await writeFile(
    join(stateDir, 'auto-update.json'),
    JSON.stringify(pendingCoreState()),
  )
  await writeFile(join(stateDir, 'auto-update-wrapper.json'), '{bad json')
  let spawned = false
  const code = await superviseDaemon({
    pluginDir: '/opt/plugin',
    installedWrapperPath: '/opt/wrapper',
    env: { BGOS_AUTO_UPDATE: 'on', BGOS_ASSISTANT_ID: '42' },
    home,
    handleSignals: false,
    log: () => {},
    exec: async () => ({ stdout: `${COMMIT_B}\n`, stderr: '' }),
    spawnChild: () => {
      spawned = true
      return {}
    },
  })
  assert.equal(code, 1)
  assert.equal(spawned, false)
})

test('auto-update on refuses to spawn with malformed core state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bgos-wrapper-core-corrupt-'))
  const stateDir = join(home, '.bgos-plugin-state', '42')
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(stateDir, 'auto-update.json'), '{bad json')
  let spawned = false
  let execCalls = 0
  const code = await superviseDaemon({
    pluginDir: '/opt/plugin',
    installedWrapperPath: '/opt/wrapper',
    env: { BGOS_AUTO_UPDATE: 'on', BGOS_ASSISTANT_ID: '42' },
    home,
    handleSignals: false,
    log: () => {},
    exec: async () => {
      execCalls += 1
      return { stdout: `${COMMIT_B}\n`, stderr: '' }
    },
    spawnChild: () => {
      spawned = true
      return {}
    },
  })
  assert.equal(code, 1)
  assert.equal(spawned, false)
  assert.equal(execCalls, 0)
})

test('stable wrapper installation is atomic and executable outside checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bgos-wrapper-install-'))
  const source = join(root, 'checkout', 'bin', 'bgos-daemon-wrapper.mjs')
  const target = stableWrapperPath(join(root, 'home'))
  await mkdir(join(root, 'checkout', 'bin'), { recursive: true })
  await writeFile(source, '#!/usr/bin/env node\nprocess.exit(0)\n')
  await chmod(source, 0o644)
  installStableWrapper(source, target)
  assert.equal(await readFile(target, 'utf8'), await readFile(source, 'utf8'))
  assert.equal((await stat(target)).mode & 0o777, 0o755)
  assert.equal(target.startsWith(join(root, 'checkout')), false)
})

test('rollback uses fixed argv, restores dependencies, and disables updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bgos-wrapper-rollback-'))
  const stateDir = join(root, 'state')
  const coreStatePath = join(stateDir, 'auto-update.json')
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await writeFile(coreStatePath, JSON.stringify(pendingCoreState()))
  const calls: Array<{ file: string; args: readonly string[] }> = []
  const exec = async (file: string, args: readonly string[]) => {
    calls.push({ file, args: [...args] })
    if (file === 'git' && args[0] === 'rev-parse') {
      return { stdout: `${COMMIT_B}\n`, stderr: '' }
    }
    if (file === 'git' && args[0] === 'status') {
      return { stdout: '', stderr: '' }
    }
    if (file === 'git' && args[0] === 'diff') {
      return { stdout: 'bun.lock\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  assert.equal(
    await rollbackInstalledUpdate({ rootDir: root, coreStatePath, exec }),
    true,
  )
  assert.deepEqual(
    calls.find((call) => call.file === 'git' && call.args[0] === 'checkout'),
    {
      file: 'git',
      args: ['checkout', '--detach', COMMIT_A],
    },
  )
  assert.deepEqual(calls.find((call) => call.file === 'bun'), {
    file: 'bun',
    args: ['install', '--frozen-lockfile'],
  })
  assert.equal(calls.some((call) => call.file.includes('sh')), false)
  const saved = JSON.parse(await readFile(coreStatePath, 'utf8'))
  assert.equal(saved.disabled, true)
  assert.equal(saved.validationPending, false)
  const shared = JSON.parse(
    await readFile(
      join(root, '.git', 'bgos-auto-update-disabled.json'),
      'utf8',
    ),
  )
  assert.deepEqual(shared, {
    schemaVersion: 1,
    disabled: true,
    resetArmed: false,
  })
})

test('rollback never changes a dirty checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bgos-wrapper-dirty-'))
  const stateDir = join(root, 'state')
  const coreStatePath = join(stateDir, 'auto-update.json')
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await writeFile(coreStatePath, JSON.stringify(pendingCoreState()))
  const calls: Array<readonly string[]> = []
  const exec = async (_file: string, args: readonly string[]) => {
    calls.push([...args])
    if (args[0] === 'rev-parse') return { stdout: `${COMMIT_B}\n`, stderr: '' }
    if (args[0] === 'status') return { stdout: ' M server.ts\n', stderr: '' }
    return { stdout: '', stderr: '' }
  }
  assert.equal(
    await rollbackInstalledUpdate({ rootDir: root, coreStatePath, exec }),
    false,
  )
  assert.equal(calls.some((args) => args[0] === 'checkout'), false)
})

test('rollback proceeds when only untracked files are present', async () => {
  // KC incident 2026-08-24: a stray untracked file must not block a legitimate
  // rollback (nor disable auto-updates); checkout --detach is untracked-safe.
  const root = await mkdtemp(join(tmpdir(), 'bgos-wrapper-untracked-'))
  const stateDir = join(root, 'state')
  const coreStatePath = join(stateDir, 'auto-update.json')
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await writeFile(coreStatePath, JSON.stringify(pendingCoreState()))
  const calls: Array<{ file: string; args: readonly string[] }> = []
  const exec = async (file: string, args: readonly string[]) => {
    calls.push({ file, args: [...args] })
    if (file === 'git' && args[0] === 'rev-parse') {
      return { stdout: `${COMMIT_B}\n`, stderr: '' }
    }
    if (file === 'git' && args[0] === 'status') {
      return { stdout: '?? report.md\n', stderr: '' }
    }
    if (file === 'git' && args[0] === 'diff') {
      return { stdout: 'bun.lock\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  assert.equal(
    await rollbackInstalledUpdate({ rootDir: root, coreStatePath, exec }),
    true,
  )
  assert.deepEqual(
    calls.find((call) => call.file === 'git' && call.args[0] === 'checkout'),
    { file: 'git', args: ['checkout', '--detach', COMMIT_A] },
  )
})

test('rollback restores dependencies when another daemon already moved HEAD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bgos-wrapper-shared-rollback-'))
  const stateDir = join(root, 'state')
  const coreStatePath = join(stateDir, 'auto-update.json')
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await writeFile(coreStatePath, JSON.stringify(pendingCoreState()))
  const calls: Array<{ file: string; args: readonly string[] }> = []
  const exec = async (file: string, args: readonly string[]) => {
    calls.push({ file, args: [...args] })
    if (file === 'git' && args[0] === 'rev-parse') {
      return { stdout: `${COMMIT_A}\n`, stderr: '' }
    }
    if (file === 'git' && args[0] === 'status') {
      return { stdout: '', stderr: '' }
    }
    if (file === 'git' && args[0] === 'diff') {
      return { stdout: 'package.json\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  assert.equal(
    await rollbackInstalledUpdate({ rootDir: root, coreStatePath, exec }),
    true,
  )
  assert.equal(
    calls.some((call) => call.file === 'git' && call.args[0] === 'checkout'),
    false,
  )
  assert.deepEqual(calls.find((call) => call.file === 'bun'), {
    file: 'bun',
    args: ['install', '--frozen-lockfile'],
  })
  const saved = JSON.parse(await readFile(coreStatePath, 'utf8'))
  assert.equal(saved.disabled, true)
  assert.equal(saved.validationPending, false)
})

test('recommended generator and manual setup point at the stable wrapper', async () => {
  const root = new URL('..', import.meta.url)
  const agent = await readFile(new URL('bin/bgos-agent', root), 'utf8')
  const readme = await readFile(new URL('README.md', root), 'utf8')
  assert.match(agent, /WRAPPER_PATH=.*bgos-daemon-wrapper\.mjs/)
  assert.match(agent, /args: \[e\.BGOS_WRAPPER, "--plugin-dir", e\.BGOS_PLUGIN\]/)
  assert.match(readme, /\.bgos-agent\/runtime\/bgos-daemon-wrapper\.mjs/)
  assert.match(readme, /"--plugin-dir"/)
})
