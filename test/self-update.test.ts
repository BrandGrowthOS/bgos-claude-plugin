import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EMPTY_AUTO_UPDATE_STATE,
  EMPTY_SHARED_UPDATE_SAFETY,
  MessageActivityTracker,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_HEALTHY_AFTER_MS,
  UPDATE_JITTER_MAX_MS,
  compareSemver,
  describePendingRestart,
  decideCheckoutAction,
  shouldExitAfterUpdate,
  decideDrain,
  decideVersionUpdate,
  initializeSelfUpdater,
  inspectGitUpdate,
  isAutoUpdateEnabled,
  loadAutoUpdateState,
  loadSharedUpdateSafety,
  nextUpdateCheckDelayMs,
  parseSemver,
  resolveAutoUpdateStatePath,
  runSelfUpdateDryRun,
  saveAutoUpdateState,
  saveSharedUpdateSafety,
  transitionFlagLatch,
  transitionRollbackState,
  transitionSharedSafety,
  tryAcquireUpdateLock,
  type AutoUpdateState,
  type CommandRunner,
} from '../lib/self-update'

const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)
const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  tempDirs.length = 0
})

function installedState(): AutoUpdateState {
  return transitionRollbackState(
    { ...EMPTY_AUTO_UPDATE_STATE },
    {
      kind: 'update-installed',
      previousCommit: COMMIT_A,
      previousVersion: '0.26.0',
      targetCommit: COMMIT_B,
      targetVersion: '0.27.0',
    },
  ).state
}

function gitRunner(opts: {
  status?: string
  latestVersion?: string
  dependencyChanges?: string
  calls?: Array<{ file: string; args: readonly string[] }>
} = {}): CommandRunner {
  return async (file, args) => {
    opts.calls?.push({ file, args: [...args] })
    const key = args.join(' ')
    if (file === 'bun') return { stdout: '', stderr: '' }
    if (key === 'status --porcelain --untracked-files=normal') {
      return { stdout: opts.status ?? '', stderr: '' }
    }
    if (key === 'fetch --quiet origin main') return { stdout: '', stderr: '' }
    if (key === 'rev-parse HEAD') return { stdout: `${COMMIT_A}\n`, stderr: '' }
    if (key === 'rev-parse refs/remotes/origin/main') {
      return { stdout: `${COMMIT_B}\n`, stderr: '' }
    }
    if (key === `show ${COMMIT_B}:package.json`) {
      return {
        stdout: JSON.stringify({ version: opts.latestVersion ?? '0.27.0' }),
        stderr: '',
      }
    }
    if (key === `merge-base HEAD ${COMMIT_B}`) {
      return { stdout: `${COMMIT_A}\n`, stderr: '' }
    }
    if (key.startsWith('diff --name-only ')) {
      return { stdout: opts.dependencyChanges ?? '', stderr: '' }
    }
    if (key === `merge --ff-only --no-edit ${COMMIT_B}`) {
      return { stdout: 'Updating checkout\n', stderr: '' }
    }
    if (key.startsWith('cat-file -e ')) return { stdout: '', stderr: '' }
    if (key.startsWith('checkout --detach ')) return { stdout: '', stderr: '' }
    throw new Error(`unexpected command: ${file} ${key}`)
  }
}

describe('default-on flag (KC 2026-07-18)', () => {
  test('unset and empty default to enabled; explicit non-on values disable', () => {
    expect(isAutoUpdateEnabled('on')).toBe(true)
    expect(isAutoUpdateEnabled(undefined)).toBe(true)
    expect(isAutoUpdateEnabled('')).toBe(true)
    for (const value of ['off', 'ON', 'true', '1', 'onn']) {
      expect(isAutoUpdateEnabled(value)).toBe(false)
    }
  })

  test('flag off performs no git, timer, exit, or log work', async () => {
    for (const flag of ['off']) {
      let commands = 0
      let timers = 0
      let exits = 0
      const updater = await initializeSelfUpdater({
        rootDir: tempDir('self-update-off-root-'),
        stateFilePath: join(tempDir('self-update-off-state-'), 'auto-update.json'),
        env: { BGOS_AUTO_UPDATE: flag },
        runningVersion: '0.26.0',
        log: () => {
          throw new Error('flag off must not log')
        },
        drainSnapshot: () => ({
          activeOperations: 0,
          pendingMessages: 0,
          pendingPermissions: 0,
        }),
        setDrainMode: () => {
          throw new Error('flag off must not drain')
        },
        exit: () => {
          exits += 1
        },
        runner: async () => {
          commands += 1
          throw new Error('flag off must not run a command')
        },
        schedule: () => {
          timers += 1
          return setTimeout(() => {}, 1)
        },
      })
      expect(updater).toBeNull()
      expect({ commands, timers, exits }).toEqual({ commands: 0, timers: 0, exits: 0 })
    }
  })

  test('rollback disable survives on restarts until explicit off then on', async () => {
    const rootDir = tempDir('self-update-reset-root-')
    mkdirSync(join(rootDir, '.git'))
    const stateFilePath = join(tempDir('self-update-reset-state-'), 'auto-update.json')
    const disabled = {
      ...EMPTY_AUTO_UPDATE_STATE,
      disabled: true,
      lastRollbackFromCommit: COMMIT_B,
      lastRollbackFromVersion: '0.27.0',
    }
    saveAutoUpdateState(stateFilePath, disabled)
    let commands = 0
    const common = {
      rootDir,
      stateFilePath,
      runningVersion: '0.26.0',
      log: () => {},
      drainSnapshot: () => ({
        activeOperations: 0,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
      setDrainMode: () => {},
      exit: () => {},
      runner: (async () => {
        commands += 1
        return { stdout: `${COMMIT_A}\n`, stderr: '' }
      }) as CommandRunner,
    }

    expect(await initializeSelfUpdater({ ...common, env: { BGOS_AUTO_UPDATE: 'on' } })).toBeNull()
    expect(commands).toBe(0)
    expect(loadAutoUpdateState(stateFilePath).disabled).toBe(true)

    expect(await initializeSelfUpdater({ ...common, env: { BGOS_AUTO_UPDATE: 'off' } })).toBeNull()
    expect(commands).toBe(0)
    expect(loadAutoUpdateState(stateFilePath).resetArmed).toBe(true)

    const enabled = await initializeSelfUpdater({
      ...common,
      env: { BGOS_AUTO_UPDATE: 'on' },
    })
    expect(enabled).not.toBeNull()
    expect(commands).toBe(1)
    expect(loadAutoUpdateState(stateFilePath).disabled).toBe(false)
    expect(loadAutoUpdateState(stateFilePath).resetArmed).toBe(false)
  })
})

describe('version decision', () => {
  test('parses and compares strict numeric semver', () => {
    expect(parseSemver('2.10.3')).toEqual({ major: 2, minor: 10, patch: 3 })
    expect(parseSemver('v2.10.3')).toBeNull()
    expect(parseSemver('2.10.3-beta')).toBeNull()
    expect(compareSemver(parseSemver('1.2.3')!, parseSemver('1.3.0')!)).toBe(-1)
  })

  test('allows only a newer version in the same major', () => {
    expect(decideVersionUpdate('1.2.3', '1.2.4').kind).toBe('update')
    expect(decideVersionUpdate('1.2.3', '1.3.0').kind).toBe('update')
    expect(decideVersionUpdate('1.2.3', '2.0.0')).toEqual({
      kind: 'skip',
      reason: 'major-change',
    })
    expect(decideVersionUpdate('1.2.3', '1.2.3')).toEqual({
      kind: 'skip',
      reason: 'not-newer',
    })
    expect(decideVersionUpdate('1.2.3', '1.1.9')).toEqual({
      kind: 'skip',
      reason: 'not-newer',
    })
  })

  test('rejects missing or malformed versions', () => {
    expect(decideVersionUpdate(null, '1.2.3')).toEqual({
      kind: 'skip',
      reason: 'invalid-version',
    })
    expect(decideVersionUpdate('1.2.3', 'latest')).toEqual({
      kind: 'skip',
      reason: 'invalid-version',
    })
  })
})

describe('schedule and drain decisions', () => {
  test('jitter stays within zero and six hours after the 24 hour interval', () => {
    expect(nextUpdateCheckDelayMs(0)).toBe(UPDATE_CHECK_INTERVAL_MS)
    expect(nextUpdateCheckDelayMs(1)).toBe(
      UPDATE_CHECK_INTERVAL_MS + UPDATE_JITTER_MAX_MS,
    )
    expect(nextUpdateCheckDelayMs(-10)).toBe(UPDATE_CHECK_INTERVAL_MS)
    expect(nextUpdateCheckDelayMs(10)).toBe(
      UPDATE_CHECK_INTERVAL_MS + UPDATE_JITTER_MAX_MS,
    )
  })

  test('drain is ready only when every message activity counter is zero', () => {
    expect(
      decideDrain({ activeOperations: 0, pendingMessages: 0, pendingPermissions: 0 }),
    ).toBe('ready')
    expect(
      decideDrain({ activeOperations: 1, pendingMessages: 0, pendingPermissions: 0 }),
    ).toBe('wait')
    expect(
      decideDrain({ activeOperations: 0, pendingMessages: 1, pendingPermissions: 0 }),
    ).toBe('wait')
    expect(
      decideDrain({ activeOperations: 0, pendingMessages: 0, pendingPermissions: 1 }),
    ).toBe('wait')
  })

  test('tracked async WS work keeps drain blocked until it settles', async () => {
    const tracker = new MessageActivityTracker()
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const tracked = tracker.track(() => pending)
    expect(tracker.activeOperations).toBe(1)
    expect(
      decideDrain({
        activeOperations: tracker.activeOperations,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
    ).toBe('wait')
    finish()
    await tracked
    expect(tracker.activeOperations).toBe(0)
    expect(
      decideDrain({
        activeOperations: tracker.activeOperations,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
    ).toBe('ready')
  })

  test('live message entry points close admission and track admitted async work', () => {
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
    const handlerBody = (event: string): string => {
      const start = source.indexOf(`realtimeSocket.on('${event}'`)
      expect(start).toBeGreaterThan(-1)
      const next = source.indexOf('realtimeSocket.on(', start + 1)
      return source.slice(start, next === -1 ? source.length : next)
    }
    for (const event of [
      'voice_task_dispatch',
      'inbound_message',
      'peer_conversation_closed',
      'meeting_invitation',
      'meeting_message',
      'meeting_turn_changed',
      'meeting_state_resync',
      'meeting_closed',
      'meeting_participant_left',
      'meeting_participant_added',
      'meeting_policy_changed',
    ]) {
      expect(handlerBody(event)).toContain('if (updateDrainMode) return')
    }
    for (const event of [
      'voice_task_dispatch',
      'inbound_message',
      'peer_conversation_closed',
      'meeting_invitation',
      'meeting_message',
      'meeting_turn_changed',
      'meeting_state_resync',
      'meeting_closed',
    ]) {
      expect(handlerBody(event)).toContain('trackMessageOperation(() => mcp.notification')
    }
    expect(source).not.toContain('void handleRemoteCompact(')
    expect(source).toContain('if (updateDrainMode) {\n    return Promise.resolve({')
    expect(source).toContain(
      'if (updateDrainMode) return Promise.resolve()\n  return trackMessageOperation',
    )
    expect(source).toContain(
      'function checkReplyOverdue(): void {\n  if (updateDrainMode) return',
    )
  })

  test('the validation health window is exactly 60 seconds', () => {
    expect(UPDATE_HEALTHY_AFTER_MS).toBe(60_000)
  })
})

describe('rollback state machine', () => {
  test('two validation boots that fail before healthy request rollback', () => {
    const installed = installedState()
    const bootOne = transitionRollbackState(installed, {
      kind: 'boot',
      currentCommit: COMMIT_B,
      now: 100,
    })
    expect(bootOne.action).toBe('none')
    expect(bootOne.state.crashCount).toBe(0)
    expect(bootOne.state.validationBootStartedAt).toBe(100)

    const bootTwo = transitionRollbackState(bootOne.state, {
      kind: 'boot',
      currentCommit: COMMIT_B,
      now: 200,
    })
    expect(bootTwo.action).toBe('none')
    expect(bootTwo.state.crashCount).toBe(1)

    const bootThree = transitionRollbackState(bootTwo.state, {
      kind: 'boot',
      currentCommit: COMMIT_B,
      now: 300,
    })
    expect(bootThree.action).toBe('rollback')
    expect(bootThree.state.crashCount).toBe(2)
    expect(bootThree.state.rollbackPending).toBe(true)
  })

  test('a healthy 60 second boot clears rollback tracking', () => {
    const boot = transitionRollbackState(installedState(), {
      kind: 'boot',
      currentCommit: COMMIT_B,
      now: 100,
    }).state
    const healthy = transitionRollbackState(boot, {
      kind: 'healthy',
      currentCommit: COMMIT_B,
    })
    expect(healthy.state.validationPending).toBe(false)
    expect(healthy.state.previousCommit).toBeNull()
    expect(healthy.state.crashCount).toBe(0)
  })

  test('an interrupted update clears validation when boot still has the old commit', () => {
    const boot = transitionRollbackState(installedState(), {
      kind: 'boot',
      currentCommit: COMMIT_A,
      now: 100,
    })
    expect(boot.action).toBe('none')
    expect(boot.state.validationPending).toBe(false)
    expect(boot.state.targetCommit).toBeNull()
    expect(boot.state.previousCommit).toBeNull()
  })

  test('a graceful stop does not count as a crash', () => {
    const boot = transitionRollbackState(installedState(), {
      kind: 'boot',
      currentCommit: COMMIT_B,
      now: 100,
    }).state
    const stopped = transitionRollbackState(boot, {
      kind: 'graceful-stop',
      currentCommit: COMMIT_B,
    }).state
    const restarted = transitionRollbackState(stopped, {
      kind: 'boot',
      currentCommit: COMMIT_B,
      now: 200,
    }).state
    expect(restarted.crashCount).toBe(0)
    expect(restarted.validationBootStartedAt).toBe(200)
  })

  test('a graceful stop breaks an earlier crash streak', () => {
    const first = transitionRollbackState(installedState(), {
      kind: 'boot',
      currentCommit: COMMIT_B,
      now: 100,
    }).state
    const afterCrash = transitionRollbackState(first, {
      kind: 'boot',
      currentCommit: COMMIT_B,
      now: 200,
    }).state
    expect(afterCrash.crashCount).toBe(1)
    const stopped = transitionRollbackState(afterCrash, {
      kind: 'graceful-stop',
      currentCommit: COMMIT_B,
    }).state
    const restarted = transitionRollbackState(stopped, {
      kind: 'boot',
      currentCommit: COMMIT_B,
      now: 300,
    })
    expect(restarted.action).toBe('none')
    expect(restarted.state.crashCount).toBe(0)
  })

  test('a boot observed after 60 seconds is healthy, not an early crash', () => {
    const first = transitionRollbackState(installedState(), {
      kind: 'boot',
      currentCommit: COMMIT_B,
      now: 100,
    }).state
    const later = transitionRollbackState(first, {
      kind: 'boot',
      currentCommit: COMMIT_B,
      now: 100 + UPDATE_HEALTHY_AFTER_MS,
    })
    expect(later.action).toBe('none')
    expect(later.state.validationPending).toBe(false)
    expect(later.state.crashCount).toBe(0)
  })

  test('successful rollback latches updates disabled', () => {
    const pending = {
      ...installedState(),
      rollbackPending: true,
      crashCount: 2,
    }
    const rolledBack = transitionRollbackState(pending, {
      kind: 'rollback-succeeded',
    }).state
    expect(rolledBack.disabled).toBe(true)
    expect(rolledBack.resetArmed).toBe(false)
    expect(rolledBack.lastRollbackFromCommit).toBe(COMMIT_B)
    expect(rolledBack.previousCommit).toBeNull()
  })

  test('off arms a disabled latch and a later exact on clears it', () => {
    const disabled = { ...EMPTY_AUTO_UPDATE_STATE, disabled: true }
    const stillDisabled = transitionFlagLatch(disabled, 'on')
    expect(stillDisabled.disabled).toBe(true)
    const armed = transitionFlagLatch(disabled, 'off')
    expect(armed.resetArmed).toBe(true)
    const enabled = transitionFlagLatch(armed, 'on')
    expect(enabled.disabled).toBe(false)
    expect(enabled.resetArmed).toBe(false)
  })
})

describe('durable state and shared lock', () => {
  test('state lives next to daemon state and round trips atomically at mode 600', () => {
    const dir = tempDir('self-update-state-')
    const path = resolveAutoUpdateStatePath(join(dir, 'chat-cursors.json'))
    expect(path).toBe(join(dir, 'auto-update.json'))
    const state = installedState()
    expect(saveAutoUpdateState(path, state)).toBe(true)
    expect(loadAutoUpdateState(path)).toEqual(state)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8')).targetCommit).toBe(COMMIT_B)
  })

  test('missing state is fresh while corrupt and unreadable state fail closed', () => {
    const dir = tempDir('self-update-corrupt-')
    const missing = join(dir, 'missing.json')
    expect(loadAutoUpdateState(missing)).toEqual(EMPTY_AUTO_UPDATE_STATE)
    const corrupt = join(dir, 'corrupt.json')
    writeFileSync(corrupt, '{bad json')
    expect(loadAutoUpdateState(corrupt).disabled).toBe(true)
    chmodSync(corrupt, 0o000)
    expect(loadAutoUpdateState(corrupt).disabled).toBe(true)
  })

  test('structured but impossible rollback states fail closed', () => {
    const dir = tempDir('self-update-invalid-state-')
    const cases: AutoUpdateState[] = [
      {
        ...installedState(),
        validationPending: false,
        crashCount: 2,
      },
      {
        ...installedState(),
        rollbackPending: true,
        crashCount: 1,
      },
      {
        ...installedState(),
        validationPending: false,
        rollbackPending: false,
        crashCount: 0,
        validationBootStartedAt: null,
      },
    ]
    for (const [index, state] of cases.entries()) {
      const path = join(dir, `invalid-${index}.json`)
      writeFileSync(path, JSON.stringify(state))
      expect(loadAutoUpdateState(path)).toEqual({
        ...EMPTY_AUTO_UPDATE_STATE,
        disabled: true,
      })
    }
  })

  test('only one daemon acquires the shared checkout lock', () => {
    const lockPath = join(tempDir('self-update-lock-'), 'update.lock')
    const first = tryAcquireUpdateLock(lockPath, 1_000)
    expect(first.kind).toBe('acquired')
    expect(tryAcquireUpdateLock(lockPath, 1_001)).toEqual({ kind: 'held' })
    if (first.kind === 'acquired') first.release()
    const second = tryAcquireUpdateLock(lockPath, 1_002)
    expect(second.kind).toBe('acquired')
    if (second.kind === 'acquired') second.release()
  })

  test('shared rollback latch blocks every daemon until off then on', async () => {
    const rootDir = tempDir('self-update-shared-root-')
    const gitDir = join(rootDir, '.git')
    mkdirSync(gitDir)
    const safetyPath = join(gitDir, 'bgos-auto-update-disabled.json')
    expect(
      saveSharedUpdateSafety(safetyPath, {
        ...EMPTY_SHARED_UPDATE_SAFETY,
        disabled: true,
      }),
    ).toBe(true)
    expect(loadSharedUpdateSafety(safetyPath).disabled).toBe(true)
    const armed = transitionSharedSafety(loadSharedUpdateSafety(safetyPath), 'off')
    expect(armed.resetArmed).toBe(true)
    const enabled = transitionSharedSafety(armed, 'on')
    expect(enabled).toEqual(EMPTY_SHARED_UPDATE_SAFETY)

    let commands = 0
    const stateFilePath = join(tempDir('self-update-shared-daemon-'), 'auto-update.json')
    const base = {
      rootDir,
      stateFilePath,
      runningVersion: '0.26.0',
      log: () => {},
      drainSnapshot: () => ({
        activeOperations: 0,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
      setDrainMode: () => {},
      exit: () => {},
      runner: (async () => {
        commands += 1
        return { stdout: `${COMMIT_A}\n`, stderr: '' }
      }) as CommandRunner,
    }
    expect(await initializeSelfUpdater({ ...base, env: { BGOS_AUTO_UPDATE: 'on' } })).toBeNull()
    expect(commands).toBe(0)
    expect(await initializeSelfUpdater({ ...base, env: { BGOS_AUTO_UPDATE: 'off' } })).toBeNull()
    expect(commands).toBe(0)
    expect(loadSharedUpdateSafety(safetyPath).resetArmed).toBe(true)
    expect(await initializeSelfUpdater({ ...base, env: { BGOS_AUTO_UPDATE: 'on' } })).not.toBeNull()
    expect(commands).toBe(1)
    expect(loadSharedUpdateSafety(safetyPath)).toEqual(EMPTY_SHARED_UPDATE_SAFETY)
  })

  test('already-running updater honors a shared latch written by another daemon', async () => {
    const rootDir = tempDir('self-update-live-shared-root-')
    const gitDir = join(rootDir, '.git')
    mkdirSync(gitDir)
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const exits: number[] = []
    const logs: string[] = []
    const runner: CommandRunner = async (file, args) => {
      calls.push({ file, args: [...args] })
      if (args.join(' ') === 'rev-parse HEAD') {
        return { stdout: `${COMMIT_A}\n`, stderr: '' }
      }
      throw new Error(`shared latch should prevent command: ${file} ${args.join(' ')}`)
    }
    const updater = await initializeSelfUpdater({
      rootDir,
      stateFilePath: join(tempDir('self-update-live-shared-state-'), 'auto-update.json'),
      env: { BGOS_AUTO_UPDATE: 'on' },
      runningVersion: '0.26.0',
      log: (message) => logs.push(message),
      drainSnapshot: () => ({
        activeOperations: 0,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
      setDrainMode: () => {},
      exit: (code) => exits.push(code),
      runner,
      schedule: () => setTimeout(() => {}, 60_000),
    })
    expect(updater).not.toBeNull()
    expect(
      saveSharedUpdateSafety(join(gitDir, 'bgos-auto-update-disabled.json'), {
        schemaVersion: 1,
        disabled: true,
        resetArmed: false,
      }),
    ).toBe(true)
    await updater!.checkNow()
    expect(calls).toEqual([{ file: 'git', args: ['rev-parse', 'HEAD'] }])
    expect(calls.some((call) => call.args[0] === 'fetch')).toBe(false)
    expect(calls.some((call) => call.args[0] === 'merge')).toBe(false)
    expect(exits).toEqual([])
    expect(logs.some((line) => line.includes('shared checkout is rollback-disabled'))).toBe(true)
  })
})

describe('checkout safety decisions', () => {
  test('dirty tree always skips before lock or pull decisions', () => {
    expect(
      decideCheckoutAction({
        dirty: true,
        lockHeld: false,
        currentCommit: COMMIT_A,
        targetCommit: COMMIT_B,
        canFastForward: true,
      }),
    ).toEqual({ kind: 'skip', reason: 'dirty-tree' })
  })

  test('lock held makes this daemon restart without pulling', () => {
    expect(
      decideCheckoutAction({
        dirty: false,
        lockHeld: true,
        currentCommit: COMMIT_A,
        targetCommit: COMMIT_B,
        canFastForward: true,
      }),
    ).toEqual({ kind: 'restart', reason: 'lock-held' })
  })

  test('diverged checkout skips and a clean ancestor uses fast-forward pull', () => {
    expect(
      decideCheckoutAction({
        dirty: false,
        lockHeld: false,
        currentCommit: COMMIT_A,
        targetCommit: COMMIT_B,
        canFastForward: false,
      }),
    ).toEqual({ kind: 'skip', reason: 'not-fast-forward' })
    expect(
      decideCheckoutAction({
        dirty: false,
        lockHeld: false,
        currentCommit: COMMIT_A,
        targetCommit: COMMIT_B,
        canFastForward: true,
      }),
    ).toEqual({ kind: 'pull' })
  })
})

describe('real git check in dry-run mode', () => {
  test('uses fixed argv, fetches metadata, and never invokes merge or checkout', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const result = await inspectGitUpdate({
      rootDir: tempDir('self-update-inspect-'),
      runningVersion: '0.26.0',
      runner: gitRunner({ calls }),
    })
    expect(result.kind).toBe('checked')
    expect(calls).toContainEqual({
      file: 'git',
      args: ['fetch', '--quiet', 'origin', 'main'],
    })
    expect(calls).toContainEqual({
      file: 'git',
      args: ['show', `${COMMIT_B}:package.json`],
    })
    expect(calls.every((call) => call.file === 'git')).toBe(true)
    expect(calls.some((call) => call.args.includes('merge'))).toBe(false)
    expect(calls.some((call) => call.args.includes('checkout'))).toBe(false)
  })

  test('dirty inspection stops before fetching remote metadata', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const result = await inspectGitUpdate({
      rootDir: tempDir('self-update-dirty-'),
      runningVersion: '0.26.0',
      runner: gitRunner({ status: ' M server.ts\n', calls }),
    })
    expect(result).toEqual({ kind: 'dirty-tree' })
    expect(calls).toHaveLength(1)
  })

  test('dry-run logs the correct decision and cannot execute an update', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const logs: string[] = []
    const result = await runSelfUpdateDryRun({
      rootDir: tempDir('self-update-dry-run-'),
      runningVersion: '0.26.0',
      log: (message) => logs.push(message),
      runner: gitRunner({ calls }),
    })
    expect(result.kind).toBe('checked')
    expect(logs).toEqual([
      'Auto-update dry run: 0.26.0 to 0.27.0, fast-forward available.',
    ])
    expect(calls.some((call) => call.args[0] === 'merge')).toBe(false)
    expect(calls.some((call) => call.args[0] === 'checkout')).toBe(false)
    expect(calls.some((call) => call.file === 'bun')).toBe(false)
  })

  // Supervised host: this test predates the kc-server outage and pins the
  // exit path, so it now opts in explicitly (BGOS_EXIT_AFTER_UPDATE). The
  // behavior it asserts is unchanged FOR A SUPERVISED HOST; what changed is
  // that exiting is no longer the assumption everywhere else.
  test('live apply releases its lock before exit after a drained ff-only merge', async () => {
    const rootDir = tempDir('self-update-apply-root-')
    mkdirSync(join(rootDir, '.git'))
    const lockPath = join(rootDir, '.git', 'bgos-auto-update.lock')
    const stateFilePath = join(tempDir('self-update-apply-state-'), 'auto-update.json')
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const exits: number[] = []
    const drainModes: boolean[] = []
    const updater = await initializeSelfUpdater({
      rootDir,
      stateFilePath,
      env: { BGOS_AUTO_UPDATE: 'on', BGOS_EXIT_AFTER_UPDATE: '1' },
      runningVersion: '0.26.0',
      log: () => {},
      drainSnapshot: () => ({
        activeOperations: 0,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
      setDrainMode: (enabled) => drainModes.push(enabled),
      exit: (code) => {
        expect(existsSync(lockPath)).toBe(false)
        exits.push(code)
      },
      runner: gitRunner({ calls, dependencyChanges: 'bun.lock\n' }),
      schedule: () => setTimeout(() => {}, 60_000),
    })
    expect(updater).not.toBeNull()
    await updater!.checkNow()
    expect(drainModes).toEqual([true])
    expect(exits).toEqual([0])
    expect(calls).toContainEqual({
      file: 'git',
      args: ['merge', '--ff-only', '--no-edit', COMMIT_B],
    })
    expect(calls).toContainEqual({
      file: 'bun',
      args: ['install', '--frozen-lockfile'],
    })
    expect(calls.some((call) => call.args.includes('reset'))).toBe(false)
    expect(calls.some((call) => call.args.includes('--force'))).toBe(false)
    expect(loadAutoUpdateState(stateFilePath).previousCommit).toBe(COMMIT_A)
    expect(loadAutoUpdateState(stateFilePath).targetCommit).toBe(COMMIT_B)
  })

  test('lock loser waits for the holder and restarts without merge', async () => {
    const rootDir = tempDir('self-update-lock-loser-root-')
    mkdirSync(join(rootDir, '.git'))
    const stateFilePath = join(tempDir('self-update-lock-loser-state-'), 'auto-update.json')
    const sharedLock = tryAcquireUpdateLock(
      join(rootDir, '.git', 'bgos-auto-update.lock'),
      1_000,
    )
    expect(sharedLock.kind).toBe('acquired')
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const exits: number[] = []
    let waits = 0
    let revParseCalls = 0
    const baseRunner = gitRunner({ calls })
    const runner: CommandRunner = async (file, args, opts) => {
      if (args.join(' ') === 'rev-parse HEAD') {
        calls.push({ file, args: [...args] })
        revParseCalls += 1
        return {
          stdout: `${revParseCalls === 1 ? COMMIT_A : COMMIT_B}\n`,
          stderr: '',
        }
      }
      return baseRunner(file, args, opts)
    }
    const updater = await initializeSelfUpdater({
      rootDir,
      stateFilePath,
      env: { BGOS_AUTO_UPDATE: 'on' },
      runningVersion: '0.26.0',
      log: () => {},
      drainSnapshot: () => ({
        activeOperations: 0,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
      setDrainMode: () => {},
      exit: (code) => exits.push(code),
      runner,
      delay: async () => {
        waits += 1
        if (sharedLock.kind === 'acquired') sharedLock.release()
      },
      schedule: () => setTimeout(() => {}, 60_000),
      now: () => 1_001,
    })
    await updater!.checkNow()
    expect(waits).toBe(1)
    expect(exits).toEqual([0])
    expect(calls.some((call) => call.args[0] === 'merge')).toBe(false)
    expect(calls.some((call) => call.file === 'bun')).toBe(false)
  })

  test('lock loser continues when the holder did not install the target', async () => {
    const rootDir = tempDir('self-update-lock-failed-root-')
    mkdirSync(join(rootDir, '.git'))
    const stateFilePath = join(tempDir('self-update-lock-failed-state-'), 'auto-update.json')
    const sharedLock = tryAcquireUpdateLock(
      join(rootDir, '.git', 'bgos-auto-update.lock'),
      1_000,
    )
    expect(sharedLock.kind).toBe('acquired')
    const exits: number[] = []
    const drainModes: boolean[] = []
    const updater = await initializeSelfUpdater({
      rootDir,
      stateFilePath,
      env: { BGOS_AUTO_UPDATE: 'on' },
      runningVersion: '0.26.0',
      log: () => {},
      drainSnapshot: () => ({
        activeOperations: 0,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
      setDrainMode: (enabled) => drainModes.push(enabled),
      exit: (code) => exits.push(code),
      runner: gitRunner(),
      delay: async () => {
        if (sharedLock.kind === 'acquired') sharedLock.release()
      },
      schedule: () => setTimeout(() => {}, 60_000),
      now: () => 1_001,
    })
    await updater!.checkNow()
    expect(exits).toEqual([])
    expect(drainModes).toEqual([true, false])
    expect(loadAutoUpdateState(stateFilePath).validationPending).toBe(false)
  })

  test('rollback lock loser waits, acquires the lock, and finishes safely', async () => {
    const rootDir = tempDir('self-update-rollback-lock-root-')
    const gitDir = join(rootDir, '.git')
    mkdirSync(gitDir)
    const stateFilePath = join(tempDir('self-update-rollback-lock-state-'), 'auto-update.json')
    saveAutoUpdateState(stateFilePath, {
      ...installedState(),
      crashCount: 2,
      rollbackPending: true,
    })
    const sharedLock = tryAcquireUpdateLock(join(gitDir, 'bgos-auto-update.lock'), 1_000)
    expect(sharedLock.kind).toBe('acquired')
    let waits = 0
    const exits: number[] = []
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const runner: CommandRunner = async (file, args) => {
      calls.push({ file, args: [...args] })
      const key = args.join(' ')
      if (key === 'rev-parse HEAD') return { stdout: `${COMMIT_B}\n`, stderr: '' }
      if (key === 'status --porcelain --untracked-files=normal') {
        return { stdout: '', stderr: '' }
      }
      if (key === `cat-file -e ${COMMIT_A}^{commit}`) return { stdout: '', stderr: '' }
      if (key === `diff --name-only ${COMMIT_A} ${COMMIT_B} -- bun.lock package.json`) {
        return { stdout: '', stderr: '' }
      }
      if (key === `checkout --detach ${COMMIT_A}`) return { stdout: '', stderr: '' }
      throw new Error(`unexpected command: ${file} ${key}`)
    }
    await initializeSelfUpdater({
      rootDir,
      stateFilePath,
      env: { BGOS_AUTO_UPDATE: 'on' },
      runningVersion: '0.27.0',
      log: () => {},
      drainSnapshot: () => ({
        activeOperations: 0,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
      setDrainMode: () => {},
      exit: (code) => {
        expect(existsSync(join(gitDir, 'bgos-auto-update.lock'))).toBe(false)
        exits.push(code)
      },
      runner,
      delay: async () => {
        waits += 1
        if (sharedLock.kind === 'acquired') sharedLock.release()
      },
      now: () => 1_001,
    })
    expect(waits).toBe(1)
    expect(exits).toEqual([0])
    expect(calls).toContainEqual({
      file: 'git',
      args: ['checkout', '--detach', COMMIT_A],
    })
    expect(loadAutoUpdateState(stateFilePath).disabled).toBe(true)
  })

  test('rollback does not mutate the checkout when the shared safety latch cannot persist', async () => {
    const rootDir = tempDir('self-update-rollback-latch-root-')
    const gitDir = join(rootDir, '.git')
    mkdirSync(gitDir)
    const safetyPath = join(gitDir, 'bgos-auto-update-disabled.json')
    const stateFilePath = join(tempDir('self-update-rollback-latch-state-'), 'auto-update.json')
    saveAutoUpdateState(stateFilePath, {
      ...installedState(),
      crashCount: 2,
      rollbackPending: true,
    })
    const exits: number[] = []
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const runner: CommandRunner = async (file, args) => {
      calls.push({ file, args: [...args] })
      const key = args.join(' ')
      if (key === 'rev-parse HEAD') return { stdout: `${COMMIT_B}\n`, stderr: '' }
      if (key === 'status --porcelain --untracked-files=normal') {
        return { stdout: '', stderr: '' }
      }
      if (key === `cat-file -e ${COMMIT_A}^{commit}`) return { stdout: '', stderr: '' }
      if (key === `diff --name-only ${COMMIT_A} ${COMMIT_B} -- bun.lock package.json`) {
        mkdirSync(safetyPath)
        return { stdout: 'package.json\n', stderr: '' }
      }
      throw new Error(`checkout mutation must not run: ${file} ${key}`)
    }
    await initializeSelfUpdater({
      rootDir,
      stateFilePath,
      env: { BGOS_AUTO_UPDATE: 'on' },
      runningVersion: '0.27.0',
      log: () => {},
      drainSnapshot: () => ({
        activeOperations: 0,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
      setDrainMode: () => {},
      exit: (code) => exits.push(code),
      runner,
    })
    expect(exits).toEqual([])
    expect(calls.some((call) => call.args[0] === 'checkout')).toBe(false)
    expect(loadAutoUpdateState(stateFilePath).rollbackPending).toBe(true)
    expect(existsSync(join(gitDir, 'bgos-auto-update.lock'))).toBe(false)
  })

  test('rollback uses detached checkout, latches shared safety, and exits zero', async () => {
    const rootDir = tempDir('self-update-rollback-root-')
    const gitDir = join(rootDir, '.git')
    mkdirSync(gitDir)
    const stateFilePath = join(tempDir('self-update-rollback-state-'), 'auto-update.json')
    saveAutoUpdateState(stateFilePath, {
      ...installedState(),
      crashCount: 2,
      rollbackPending: true,
    })
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const exits: number[] = []
    const runner: CommandRunner = async (file, args) => {
      calls.push({ file, args: [...args] })
      const key = args.join(' ')
      if (key === 'rev-parse HEAD') return { stdout: `${COMMIT_B}\n`, stderr: '' }
      if (key === 'status --porcelain --untracked-files=normal') {
        return { stdout: '', stderr: '' }
      }
      if (key === `cat-file -e ${COMMIT_A}^{commit}`) return { stdout: '', stderr: '' }
      if (key === `diff --name-only ${COMMIT_A} ${COMMIT_B} -- bun.lock package.json`) {
        return { stdout: 'bun.lock\n', stderr: '' }
      }
      if (key === `checkout --detach ${COMMIT_A}`) return { stdout: '', stderr: '' }
      if (file === 'bun' && key === 'install --frozen-lockfile') {
        return { stdout: '', stderr: '' }
      }
      throw new Error(`unexpected command: ${file} ${key}`)
    }
    await initializeSelfUpdater({
      rootDir,
      stateFilePath,
      env: { BGOS_AUTO_UPDATE: 'on' },
      runningVersion: '0.27.0',
      log: () => {},
      drainSnapshot: () => ({
        activeOperations: 0,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
      setDrainMode: () => {},
      exit: (code) => {
        expect(existsSync(join(gitDir, 'bgos-auto-update.lock'))).toBe(false)
        exits.push(code)
      },
      runner,
    })
    expect(calls).toContainEqual({
      file: 'git',
      args: ['checkout', '--detach', COMMIT_A],
    })
    expect(calls).toContainEqual({
      file: 'bun',
      args: ['install', '--frozen-lockfile'],
    })
    expect(calls.some((call) => call.args.includes('reset'))).toBe(false)
    expect(exits).toEqual([0])
    expect(loadAutoUpdateState(stateFilePath).disabled).toBe(true)
    expect(
      loadSharedUpdateSafety(join(gitDir, 'bgos-auto-update-disabled.json')).disabled,
    ).toBe(true)
  })

  test('rollback dependency failure restores the target and stays pending', async () => {
    const rootDir = tempDir('self-update-rollback-deps-root-')
    const gitDir = join(rootDir, '.git')
    mkdirSync(gitDir)
    const stateFilePath = join(tempDir('self-update-rollback-deps-state-'), 'auto-update.json')
    saveAutoUpdateState(stateFilePath, {
      ...installedState(),
      crashCount: 2,
      rollbackPending: true,
    })
    const exits: number[] = []
    const logs: string[] = []
    const calls: Array<{ file: string; args: readonly string[] }> = []
    let bunCalls = 0
    const runner: CommandRunner = async (file, args) => {
      calls.push({ file, args: [...args] })
      const key = args.join(' ')
      if (key === 'rev-parse HEAD') return { stdout: `${COMMIT_B}\n`, stderr: '' }
      if (key === 'status --porcelain --untracked-files=normal') {
        return { stdout: '', stderr: '' }
      }
      if (key === `cat-file -e ${COMMIT_A}^{commit}`) return { stdout: '', stderr: '' }
      if (key === `diff --name-only ${COMMIT_A} ${COMMIT_B} -- bun.lock package.json`) {
        return { stdout: 'package.json\n', stderr: '' }
      }
      if (key === `checkout --detach ${COMMIT_A}`) return { stdout: '', stderr: '' }
      if (key === `checkout --detach ${COMMIT_B}`) return { stdout: '', stderr: '' }
      if (file === 'bun') {
        bunCalls += 1
        if (bunCalls === 1) throw new Error('dependency restore failed')
        return { stdout: '', stderr: '' }
      }
      throw new Error(`unexpected command: ${file} ${key}`)
    }
    await initializeSelfUpdater({
      rootDir,
      stateFilePath,
      env: { BGOS_AUTO_UPDATE: 'on' },
      runningVersion: '0.27.0',
      log: (message) => logs.push(message),
      drainSnapshot: () => ({
        activeOperations: 0,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
      setDrainMode: () => {},
      exit: (code) => exits.push(code),
      runner,
    })
    expect(exits).toEqual([])
    expect(loadAutoUpdateState(stateFilePath).rollbackPending).toBe(true)
    expect(loadSharedUpdateSafety(join(gitDir, 'bgos-auto-update-disabled.json')).disabled).toBe(
      false,
    )
    expect(calls.filter((call) => call.file === 'bun')).toHaveLength(2)
    expect(calls).toContainEqual({ file: 'git', args: ['checkout', '--detach', COMMIT_B] })
    expect(logs.some((line) => line.includes('target checkout was restored'))).toBe(true)
    expect(existsSync(join(gitDir, 'bgos-auto-update.lock'))).toBe(false)
  })

  test('rollback recovery failure latches shared auto-update safety', async () => {
    const rootDir = tempDir('self-update-rollback-recovery-root-')
    const gitDir = join(rootDir, '.git')
    mkdirSync(gitDir)
    const stateFilePath = join(tempDir('self-update-rollback-recovery-state-'), 'auto-update.json')
    saveAutoUpdateState(stateFilePath, {
      ...installedState(),
      crashCount: 2,
      rollbackPending: true,
    })
    const exits: number[] = []
    const runner: CommandRunner = async (file, args) => {
      const key = args.join(' ')
      if (key === 'rev-parse HEAD') return { stdout: `${COMMIT_B}\n`, stderr: '' }
      if (key === 'status --porcelain --untracked-files=normal') {
        return { stdout: '', stderr: '' }
      }
      if (key === `cat-file -e ${COMMIT_A}^{commit}`) return { stdout: '', stderr: '' }
      if (key === `diff --name-only ${COMMIT_A} ${COMMIT_B} -- bun.lock package.json`) {
        return { stdout: 'package.json\n', stderr: '' }
      }
      if (key === `checkout --detach ${COMMIT_A}`) return { stdout: '', stderr: '' }
      if (key === `checkout --detach ${COMMIT_B}`) {
        throw new Error('target checkout restore failed')
      }
      if (file === 'bun') throw new Error('dependency restore failed')
      throw new Error(`unexpected command: ${file} ${key}`)
    }
    await initializeSelfUpdater({
      rootDir,
      stateFilePath,
      env: { BGOS_AUTO_UPDATE: 'on' },
      runningVersion: '0.27.0',
      log: () => {},
      drainSnapshot: () => ({
        activeOperations: 0,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
      setDrainMode: () => {},
      exit: (code) => exits.push(code),
      runner,
    })
    expect(exits).toEqual([])
    expect(loadAutoUpdateState(stateFilePath).rollbackPending).toBe(true)
    expect(loadSharedUpdateSafety(join(gitDir, 'bgos-auto-update-disabled.json')).disabled).toBe(
      true,
    )
    expect(existsSync(join(gitDir, 'bgos-auto-update.lock'))).toBe(false)
  })

  test('a failed remote check is contained and the daemon continues', async () => {
    const rootDir = tempDir('self-update-error-root-')
    mkdirSync(join(rootDir, '.git'))
    const logs: string[] = []
    const exits: number[] = []
    const runner: CommandRunner = async (_file, args) => {
      const key = args.join(' ')
      if (key === 'rev-parse HEAD') return { stdout: `${COMMIT_A}\n`, stderr: '' }
      if (key === 'status --porcelain --untracked-files=normal') {
        return { stdout: '', stderr: '' }
      }
      if (key === 'fetch --quiet origin main') throw new Error('network unavailable')
      throw new Error(`unexpected command: ${key}`)
    }
    const updater = await initializeSelfUpdater({
      rootDir,
      stateFilePath: join(tempDir('self-update-error-state-'), 'auto-update.json'),
      env: { BGOS_AUTO_UPDATE: 'on' },
      runningVersion: '0.26.0',
      log: (message) => logs.push(message),
      drainSnapshot: () => ({
        activeOperations: 0,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
      setDrainMode: () => {},
      exit: (code) => exits.push(code),
      runner,
      schedule: () => setTimeout(() => {}, 60_000),
    })
    await expect(updater!.checkNow()).resolves.toBeUndefined()
    expect(exits).toEqual([])
    expect(logs.some((line) => line.includes('daemon will continue'))).toBe(true)
  })

  test('post-merge dependency failure restores previous checkout and dependencies', async () => {
    const rootDir = tempDir('self-update-restore-ok-root-')
    mkdirSync(join(rootDir, '.git'))
    const stateFilePath = join(tempDir('self-update-restore-ok-state-'), 'auto-update.json')
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const drainModes: boolean[] = []
    let bunCalls = 0
    const baseRunner = gitRunner({ calls, dependencyChanges: 'bun.lock\n' })
    const runner: CommandRunner = async (file, args, opts) => {
      if (file === 'bun') {
        calls.push({ file, args: [...args] })
        bunCalls += 1
        if (bunCalls === 1) throw new Error('target dependency install failed')
        return { stdout: '', stderr: '' }
      }
      return baseRunner(file, args, opts)
    }
    const updater = await initializeSelfUpdater({
      rootDir,
      stateFilePath,
      env: { BGOS_AUTO_UPDATE: 'on' },
      runningVersion: '0.26.0',
      log: () => {},
      drainSnapshot: () => ({
        activeOperations: 0,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
      setDrainMode: (enabled) => drainModes.push(enabled),
      exit: () => {
        throw new Error('failed update must not exit')
      },
      runner,
      schedule: () => setTimeout(() => {}, 60_000),
    })
    await expect(updater!.checkNow()).resolves.toBeUndefined()
    expect(calls).toContainEqual({
      file: 'git',
      args: ['checkout', '--detach', COMMIT_A],
    })
    expect(calls.filter((call) => call.file === 'bun')).toHaveLength(2)
    expect(drainModes).toEqual([true, false])
    const state = loadAutoUpdateState(stateFilePath)
    expect(state.validationPending).toBe(false)
    expect(state.previousCommit).toBeNull()
    expect(state.targetCommit).toBeNull()
    expect(existsSync(join(rootDir, '.git', 'bgos-auto-update.lock'))).toBe(false)
  })

  test('dependency inspection failure does not arm validation before checkout mutation', async () => {
    const rootDir = tempDir('self-update-diff-failure-root-')
    mkdirSync(join(rootDir, '.git'))
    const stateFilePath = join(tempDir('self-update-diff-failure-state-'), 'auto-update.json')
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const drainModes: boolean[] = []
    const baseRunner = gitRunner({ calls })
    const runner: CommandRunner = async (file, args, opts) => {
      if (file === 'git' && args[0] === 'diff') {
        throw new Error('dependency inspection failed')
      }
      return baseRunner(file, args, opts)
    }
    const updater = await initializeSelfUpdater({
      rootDir,
      stateFilePath,
      env: { BGOS_AUTO_UPDATE: 'on' },
      runningVersion: '0.26.0',
      log: () => {},
      drainSnapshot: () => ({
        activeOperations: 0,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
      setDrainMode: (enabled) => drainModes.push(enabled),
      exit: () => {
        throw new Error('failed inspection must not exit')
      },
      runner,
      schedule: () => setTimeout(() => {}, 60_000),
    })
    await expect(updater!.checkNow()).resolves.toBeUndefined()
    expect(drainModes).toEqual([true, false])
    expect(calls.some((call) => call.args[0] === 'merge')).toBe(false)
    expect(loadAutoUpdateState(stateFilePath)).toEqual(EMPTY_AUTO_UPDATE_STATE)
    expect(existsSync(join(rootDir, '.git', 'bgos-auto-update.lock'))).toBe(false)
  })

  test('failed previous recovery restores exact target and exits for validation', async () => {
    const rootDir = tempDir('self-update-target-recovery-root-')
    mkdirSync(join(rootDir, '.git'))
    const stateFilePath = join(tempDir('self-update-target-recovery-state-'), 'auto-update.json')
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const logs: string[] = []
    const exits: number[] = []
    const drainModes: boolean[] = []
    let bunCalls = 0
    const baseRunner = gitRunner({ calls, dependencyChanges: 'bun.lock\n' })
    const runner: CommandRunner = async (file, args, opts) => {
      if (file === 'bun') {
        calls.push({ file, args: [...args] })
        bunCalls += 1
        if (bunCalls <= 2) throw new Error('dependency install failed')
        return { stdout: '', stderr: '' }
      }
      return baseRunner(file, args, opts)
    }
    const updater = await initializeSelfUpdater({
      rootDir,
      stateFilePath,
      env: { BGOS_AUTO_UPDATE: 'on' },
      runningVersion: '0.26.0',
      log: (message) => logs.push(message),
      drainSnapshot: () => ({
        activeOperations: 0,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
      setDrainMode: (enabled) => drainModes.push(enabled),
      exit: (code) => exits.push(code),
      runner,
      schedule: () => setTimeout(() => {}, 60_000),
    })
    await expect(updater!.checkNow()).resolves.toBeUndefined()
    expect(calls).toContainEqual({
      file: 'git',
      args: ['checkout', '--detach', COMMIT_A],
    })
    expect(calls).toContainEqual({
      file: 'git',
      args: ['checkout', '--detach', COMMIT_B],
    })
    expect(calls.filter((call) => call.file === 'bun')).toHaveLength(3)
    expect(exits).toEqual([0])
    expect(drainModes).toEqual([true])
    const state = loadAutoUpdateState(stateFilePath)
    expect(state.validationPending).toBe(true)
    expect(state.previousCommit).toBe(COMMIT_A)
    expect(state.targetCommit).toBe(COMMIT_B)
    expect(logs.some((line) => line.includes('target checkout and dependencies'))).toBe(true)
    expect(existsSync(join(rootDir, '.git', 'bgos-auto-update.lock'))).toBe(false)
  })

  test('double dependency recovery failure disables checks and keeps intake drained', async () => {
    const rootDir = tempDir('self-update-double-recovery-root-')
    const gitDir = join(rootDir, '.git')
    mkdirSync(gitDir)
    const stateFilePath = join(tempDir('self-update-double-recovery-state-'), 'auto-update.json')
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const logs: string[] = []
    const exits: number[] = []
    const drainModes: boolean[] = []
    const baseRunner = gitRunner({ calls, dependencyChanges: 'bun.lock\n' })
    const runner: CommandRunner = async (file, args, opts) => {
      if (file === 'bun') {
        calls.push({ file, args: [...args] })
        throw new Error('dependency recovery failed')
      }
      return baseRunner(file, args, opts)
    }
    const updater = await initializeSelfUpdater({
      rootDir,
      stateFilePath,
      env: { BGOS_AUTO_UPDATE: 'on' },
      runningVersion: '0.26.0',
      log: (message) => logs.push(message),
      drainSnapshot: () => ({
        activeOperations: 0,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
      setDrainMode: (enabled) => drainModes.push(enabled),
      exit: (code) => exits.push(code),
      runner,
      schedule: () => setTimeout(() => {}, 60_000),
    })
    await expect(updater!.checkNow()).resolves.toBeUndefined()
    const callCount = calls.length
    await expect(updater!.checkNow()).resolves.toBeUndefined()
    expect(calls).toHaveLength(callCount)
    expect(exits).toEqual([])
    expect(drainModes).toEqual([true])
    expect(calls).toContainEqual({
      file: 'git',
      args: ['checkout', '--detach', COMMIT_A],
    })
    expect(calls).toContainEqual({
      file: 'git',
      args: ['checkout', '--detach', COMMIT_B],
    })
    expect(loadAutoUpdateState(stateFilePath).validationPending).toBe(true)
    expect(loadSharedUpdateSafety(join(gitDir, 'bgos-auto-update-disabled.json')).disabled).toBe(
      true,
    )
    expect(logs.some((line) => line.includes('Message intake remains drained'))).toBe(true)
    expect(existsSync(join(gitDir, 'bgos-auto-update.lock'))).toBe(false)
  })
})

/**
 * KC-SERVER OUTAGE, 2026-08-06. Five of seven agents on one host went silent
 * overnight and nobody noticed until the owner asked why nothing answered.
 * Their claude processes were all alive; their channel daemons were gone. The
 * last three lines of each dead daemon's log were the auto-update installing
 * and then "Exiting so the supervisor can restart the daemon."
 *
 * There was no supervisor on that host. The daemon exited into nothing, once
 * per agent, staggered by whenever each reached its update.
 *
 * The invariant these tests pin: A DAEMON NEVER EXITS UNLESS SOMETHING WILL
 * RESTART IT. Exiting stays available for hosts that really are supervised,
 * but it is opt-in and explicit, never the default assumption.
 *
 * Second invariant, from Ava (871) reviewing the fix: not exiting trades death
 * for staleness, so the pending restart must be announced on EVERY boot, not
 * only in the moment it installs. Sessions here run for days; a line that
 * scrolls past once is not a signal. An installed version is not a running
 * version.
 */
describe('a daemon never exits into nothing', () => {
  test('unsupervised host: the default is to keep serving, not to exit', () => {
    expect(shouldExitAfterUpdate({})).toBe(false)
    expect(shouldExitAfterUpdate({ BGOS_EXIT_AFTER_UPDATE: '' })).toBe(false)
    expect(shouldExitAfterUpdate({ BGOS_EXIT_AFTER_UPDATE: '0' })).toBe(false)
    expect(shouldExitAfterUpdate({ BGOS_EXIT_AFTER_UPDATE: 'off' })).toBe(false)
    expect(shouldExitAfterUpdate({ BGOS_EXIT_AFTER_UPDATE: 'false' })).toBe(false)
  })

  test('supervised host opts in explicitly and keeps the old restart behavior', () => {
    expect(shouldExitAfterUpdate({ BGOS_EXIT_AFTER_UPDATE: '1' })).toBe(true)
    expect(shouldExitAfterUpdate({ BGOS_EXIT_AFTER_UPDATE: 'true' })).toBe(true)
    expect(shouldExitAfterUpdate({ BGOS_EXIT_AFTER_UPDATE: 'on' })).toBe(true)
    expect(shouldExitAfterUpdate({ BGOS_EXIT_AFTER_UPDATE: 'yes' })).toBe(true)
  })

  test('a pending restart is describable on every boot, not just at install', () => {
    expect(
      describePendingRestart({ runningVersion: '0.33.1', installedVersion: '0.34.0' }),
    ).toBe(
      'Pending update: running 0.33.1, installed 0.34.0, takes effect when this session restarts.',
    )
  })

  test('no pending line when the running version IS the installed one', () => {
    expect(
      describePendingRestart({ runningVersion: '0.34.0', installedVersion: '0.34.0' }),
    ).toBeNull()
    expect(
      describePendingRestart({ runningVersion: '0.34.0', installedVersion: null }),
    ).toBeNull()
    expect(
      describePendingRestart({ runningVersion: null, installedVersion: '0.34.0' }),
    ).toBeNull()
  })
})

describe('the kc-server outage, end to end', () => {
  test('unsupervised: update installs, daemon KEEPS SERVING and never exits', async () => {
    const rootDir = tempDir('self-update-no-exit-root-')
    mkdirSync(join(rootDir, '.git'))
    const stateFilePath = join(tempDir('self-update-no-exit-state-'), 'auto-update.json')
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const exits: number[] = []
    const drainModes: boolean[] = []
    const logs: string[] = []
    const updater = await initializeSelfUpdater({
      rootDir,
      stateFilePath,
      env: { BGOS_AUTO_UPDATE: 'on' },
      runningVersion: '0.26.0',
      log: (message) => logs.push(message),
      drainSnapshot: () => ({
        activeOperations: 0,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
      setDrainMode: (enabled) => drainModes.push(enabled),
      exit: (code) => exits.push(code),
      runner: gitRunner({ calls, dependencyChanges: 'bun.lock\n' }),
      schedule: () => setTimeout(() => {}, 60_000),
    })
    expect(updater).not.toBeNull()
    await updater!.checkNow()

    // The update really was applied.
    expect(calls).toContainEqual({
      file: 'git',
      args: ['merge', '--ff-only', '--no-edit', COMMIT_B],
    })
    // THE FIX: no exit on a host that never promised a supervisor.
    expect(exits).toEqual([])
    // And it is SERVING, not merely alive: drain was lifted again. A daemon
    // that stays up drained is just as mute as one that died.
    expect(drainModes[drainModes.length - 1]).toBe(false)
    expect(
      logs.some((line) => line.includes('takes effect when this session restarts')),
    ).toBe(true)
    expect(logs.some((line) => line.includes('Exiting so the supervisor'))).toBe(false)
  })

  test('supervised: opting in restores the exit, so real supervisors still cycle', async () => {
    const rootDir = tempDir('self-update-opt-in-exit-root-')
    mkdirSync(join(rootDir, '.git'))
    const stateFilePath = join(tempDir('self-update-opt-in-exit-state-'), 'auto-update.json')
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const exits: number[] = []
    const updater = await initializeSelfUpdater({
      rootDir,
      stateFilePath,
      env: { BGOS_AUTO_UPDATE: 'on', BGOS_EXIT_AFTER_UPDATE: '1' },
      runningVersion: '0.26.0',
      log: () => {},
      drainSnapshot: () => ({
        activeOperations: 0,
        pendingMessages: 0,
        pendingPermissions: 0,
      }),
      setDrainMode: () => {},
      exit: (code) => exits.push(code),
      runner: gitRunner({ calls, dependencyChanges: 'bun.lock\n' }),
      schedule: () => setTimeout(() => {}, 60_000),
    })
    expect(updater).not.toBeNull()
    await updater!.checkNow()
    expect(exits).toEqual([0])
  })
})
