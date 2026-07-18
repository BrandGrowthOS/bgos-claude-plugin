#!/usr/bin/env node
/**
 * Stable MCP daemon wrapper for claude-channel-bgos.
 *
 * Installers copy this file outside the mutable plugin checkout. The wrapper
 * keeps the MCP stdio file descriptors unchanged, starts server.ts with a
 * fixed argv, and records a boot marker before any server import can run.
 */

import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const WRAPPER_FILE_NAME = 'bgos-daemon-wrapper.mjs'
export const WRAPPER_STATE_FILE = 'auto-update-wrapper.json'
export const CORE_STATE_FILE = 'auto-update.json'
export const UPDATE_LOCK_FILE = 'bgos-auto-update.lock'
export const SHARED_SAFETY_FILE = 'bgos-auto-update-disabled.json'
export const HEALTHY_AFTER_MS = 60_000
export const LOCK_STALE_MS = 10 * 60_000
export const LOCK_RETRY_MS = 500

const SHA_RE = /^[0-9a-f]{40}$/i
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export const EMPTY_WRAPPER_STATE = Object.freeze({
  schemaVersion: 1,
  targetCommit: null,
  crashCount: 0,
  bootStartedAt: null,
})

function freshWrapperState() {
  return { ...EMPTY_WRAPPER_STATE }
}

export function parseWrapperState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const targetCommit =
    typeof value.targetCommit === 'string' && SHA_RE.test(value.targetCommit)
      ? value.targetCommit
      : null
  const crashCount =
    Number.isInteger(value.crashCount) && value.crashCount >= 0
      ? Math.min(2, value.crashCount)
      : 0
  const bootStartedAt =
    typeof value.bootStartedAt === 'number' &&
    Number.isFinite(value.bootStartedAt) &&
    value.bootStartedAt >= 0
      ? value.bootStartedAt
      : null
  const validEmpty =
    targetCommit === null && crashCount === 0 && bootStartedAt === null
  const validPending =
    targetCommit !== null &&
    ((bootStartedAt !== null && crashCount <= 1) ||
      (bootStartedAt === null && crashCount === 2))
  if (
    value.schemaVersion !== 1 ||
    !Number.isInteger(value.crashCount) ||
    value.crashCount < 0 ||
    value.crashCount > 2 ||
    (!validEmpty && !validPending)
  ) {
    return null
  }
  return { schemaVersion: 1, targetCommit, crashCount, bootStartedAt }
}

export function normalizeWrapperState(value) {
  return parseWrapperState(value)
}

export function loadWrapperStateStrict(path) {
  if (!existsSync(path)) return { kind: 'missing', state: freshWrapperState() }
  try {
    const state = parseWrapperState(JSON.parse(readFileSync(path, 'utf8')))
    return state ? { kind: 'valid', state } : { kind: 'invalid' }
  } catch {
    return { kind: 'invalid' }
  }
}

export function transitionWrapperBoot(current, targetCommit, now) {
  if (!SHA_RE.test(targetCommit)) {
    return { state: null, action: 'invalid' }
  }
  const state = normalizeWrapperState(current)
  if (!state) return { state: null, action: 'invalid' }
  let crashCount = state.targetCommit === targetCommit ? state.crashCount : 0
  if (state.targetCommit === targetCommit && state.bootStartedAt !== null) {
    const elapsed = Math.max(0, now - state.bootStartedAt)
    crashCount = elapsed < HEALTHY_AFTER_MS ? crashCount + 1 : 0
  }
  if (crashCount >= 2) {
    return {
      state: {
        schemaVersion: 1,
        targetCommit,
        crashCount: 2,
        bootStartedAt: null,
      },
      action: 'rollback',
    }
  }
  return {
    state: {
      schemaVersion: 1,
      targetCommit,
      crashCount,
      bootStartedAt: now,
    },
    action: 'none',
  }
}

export function resolveDaemonStateDir(opts) {
  const root =
    opts.env?.BGOS_PLUGIN_STATE_DIR ||
    join(opts.home || homedir(), '.bgos-plugin-state')
  const rawId = String(opts.env?.BGOS_ASSISTANT_ID || opts.assistantId || '').trim()
  const key = SAFE_ID_RE.test(rawId)
    ? rawId
    : `cwd-${createHash('sha256').update(opts.cwd).digest('hex').slice(0, 16)}`
  return join(root, key)
}

export function readPairingAssistantId(home = homedir()) {
  try {
    const value = JSON.parse(
      readFileSync(join(home, '.bgos-agent', 'credentials.json'), 'utf8'),
    )
    const candidate = String(value?.assistantId ?? '').trim()
    return SAFE_ID_RE.test(candidate) ? candidate : ''
  } catch {
    return ''
  }
}

export function saveJsonAtomic(path, value, mode = 0o600) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporary, JSON.stringify(value), { mode })
    renameSync(temporary, path)
    return true
  } catch {
    try {
      unlinkSync(temporary)
    } catch {}
    return false
  }
}

export function clearWrapperState(path) {
  try {
    unlinkSync(path)
    return true
  } catch (error) {
    return error?.code === 'ENOENT'
  }
}

function parseSemver(value) {
  if (typeof value !== 'string') return null
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
  if (!match) return null
  const parsed = match.slice(1).map(Number)
  return parsed.every(Number.isSafeInteger) ? parsed : null
}

function isSameMajorNewer(previousVersion, targetVersion) {
  const previous = parseSemver(previousVersion)
  const target = parseSemver(targetVersion)
  if (!previous || !target || previous[0] !== target[0]) return false
  for (let index = 0; index < 3; index++) {
    if (target[index] !== previous[index]) return target[index] > previous[index]
  }
  return false
}

export function normalizeCoreState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const required =
    value.schemaVersion === 1 &&
    typeof value.disabled === 'boolean' &&
    typeof value.resetArmed === 'boolean' &&
    typeof value.validationPending === 'boolean' &&
    typeof value.rollbackPending === 'boolean' &&
    Number.isInteger(value.crashCount) &&
    value.crashCount >= 0 &&
    value.crashCount <= 2
  const commitsValid = [
    value.previousCommit,
    value.targetCommit,
    value.lastRollbackFromCommit,
  ].every(
    (entry) => entry === null || (typeof entry === 'string' && SHA_RE.test(entry)),
  )
  const versionsValid = [
    value.previousVersion,
    value.targetVersion,
    value.lastRollbackFromVersion,
  ].every(
    (entry) => entry === null || parseSemver(entry) !== null,
  )
  const validBootTime =
    value.validationBootStartedAt === null ||
    (typeof value.validationBootStartedAt === 'number' &&
      Number.isFinite(value.validationBootStartedAt) &&
      value.validationBootStartedAt >= 0)
  const validRollbackPair =
    (value.lastRollbackFromCommit === null &&
      value.lastRollbackFromVersion === null) ||
    (value.lastRollbackFromCommit !== null &&
      value.lastRollbackFromVersion !== null)
  if (
    !required ||
    !commitsValid ||
    !versionsValid ||
    !validBootTime ||
    !validRollbackPair
  ) {
    return null
  }
  const completeTransition =
    value.previousCommit !== null &&
    value.previousVersion !== null &&
    value.targetCommit !== null &&
    value.targetVersion !== null
  const hasAnyTransition =
    value.previousCommit !== null ||
    value.previousVersion !== null ||
    value.targetCommit !== null ||
    value.targetVersion !== null
  const transitionTracked =
    value.validationPending ||
    value.rollbackPending ||
    value.crashCount > 0 ||
    value.validationBootStartedAt !== null
  const validActive =
    value.validationPending === true &&
    value.disabled === false &&
    completeTransition &&
    value.previousCommit !== value.targetCommit &&
    isSameMajorNewer(value.previousVersion, value.targetVersion) &&
    (value.rollbackPending
      ? value.crashCount === 2 && value.validationBootStartedAt === null
      : value.crashCount <= 1 &&
        (value.crashCount === 0 || value.validationBootStartedAt !== null))
  const validInactive =
    value.validationPending === false &&
    value.rollbackPending === false &&
    hasAnyTransition === false &&
    value.crashCount === 0 &&
    value.validationBootStartedAt === null
  if (
    (transitionTracked && !validActive) ||
    (!transitionTracked && !validInactive) ||
    (value.resetArmed && !value.disabled) ||
    (value.disabled && value.validationPending)
  ) {
    return null
  }
  return { ...value }
}

export function pendingTargetForCommit(coreState, currentCommit) {
  const state = normalizeCoreState(coreState)
  if (
    !state ||
    state.disabled ||
    !state.validationPending ||
    state.rollbackPending ||
    state.targetCommit !== currentCommit ||
    !SHA_RE.test(state.previousCommit || '')
  ) {
    return null
  }
  return state.targetCommit
}

export function rolledBackCoreState(coreState) {
  return {
    ...coreState,
    disabled: true,
    resetArmed: false,
    previousCommit: null,
    previousVersion: null,
    targetCommit: null,
    targetVersion: null,
    crashCount: 0,
    validationPending: false,
    validationBootStartedAt: null,
    rollbackPending: false,
    lastRollbackFromCommit: coreState.targetCommit,
    lastRollbackFromVersion: coreState.targetVersion,
  }
}

export function installStableWrapper(sourcePath, targetPath) {
  const source = resolve(sourcePath)
  const target = resolve(targetPath)
  if (source === target) return target
  if (!existsSync(source)) {
    throw new Error(`daemon wrapper source is missing: ${source}`)
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  mkdirSync(dirname(target), { recursive: true })
  try {
    copyFileSync(source, temporary)
    chmodSync(temporary, 0o755)
    renameSync(temporary, target)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {}
    throw error
  }
  return target
}

export function stableWrapperPath(home = homedir()) {
  return join(home, '.bgos-agent', 'runtime', WRAPPER_FILE_NAME)
}

export function parseWrapperArgs(argv) {
  if (argv.length === 1 && argv[0] === '--validate') {
    return { kind: 'validate' }
  }
  if (argv.length === 2 && argv[0] === '--install') {
    return { kind: 'install', targetPath: argv[1] }
  }
  if (argv.length === 2 && argv[0] === '--plugin-dir') {
    return { kind: 'run', pluginDir: argv[1] }
  }
  return { kind: 'invalid' }
}

export function wrapperFlagMode(value) {
  if (value === 'on') return 'monitor'
  if (value === 'off') return 'reset'
  return 'transparent'
}

export function runFile(file, args, opts) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      [...args],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        resolvePromise({ stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}

export async function validateAndInstallStableWrapper(opts) {
  const source = resolve(opts.sourcePath)
  const exec = opts.exec || runFile
  try {
    await exec('bun', [source, '--validate'], {
      cwd: dirname(source),
      timeoutMs: 30_000,
    })
    return installStableWrapper(source, opts.targetPath)
  } catch (error) {
    opts.log?.(`Stable daemon wrapper validation failed; keeping the current copy: ${errorText(error)}`)
    return null
  }
}

async function git(exec, rootDir, args, timeoutMs = 60_000) {
  const result = await exec('git', args, { cwd: rootDir, timeoutMs })
  return result.stdout.trim()
}

export function tryAcquireLock(lockPath, now = Date.now()) {
  const attempt = () => {
    const token = randomUUID()
    const body = JSON.stringify({ pid: process.pid, startedAt: now, token })
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      writeFileSync(fd, body)
      closeSync(fd)
      let released = false
      return {
        kind: 'acquired',
        release() {
          if (released) return
          released = true
          try {
            if (readFileSync(lockPath, 'utf8') === body) unlinkSync(lockPath)
          } catch {}
        },
      }
    } catch {
      return null
    }
  }
  const first = attempt()
  if (first) return first
  try {
    if (now - statSync(lockPath).mtimeMs <= LOCK_STALE_MS) {
      return { kind: 'held' }
    }
    unlinkSync(lockPath)
  } catch {
    return { kind: 'held' }
  }
  return attempt() || { kind: 'held' }
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function writeSharedDisabled(path) {
  return saveJsonAtomic(path, {
    schemaVersion: 1,
    disabled: true,
    resetArmed: false,
  })
}

export async function rollbackInstalledUpdate(opts) {
  const exec = opts.exec || runFile
  const acquireLock = opts.acquireLock || tryAcquireLock
  const wait = opts.delay || delay
  const log = opts.log || (() => {})
  const lockPath = join(opts.rootDir, '.git', UPDATE_LOCK_FILE)
  const safetyPath = join(opts.rootDir, '.git', SHARED_SAFETY_FILE)
  let lockResult = acquireLock(lockPath, opts.now?.() ?? Date.now())
  let waitingLogged = false
  while (lockResult.kind === 'held') {
    if (!waitingLogged) {
      log('Auto-update rollback is being handled by another daemon. Waiting safely.')
      waitingLogged = true
    }
    await wait(LOCK_RETRY_MS)
    lockResult = acquireLock(lockPath, opts.now?.() ?? Date.now())
  }
  const lock = lockResult
  try {
    const coreState = normalizeCoreState(
      JSON.parse(readFileSync(opts.coreStatePath, 'utf8')),
    )
    if (
      !coreState ||
      !coreState.validationPending ||
      !SHA_RE.test(coreState.previousCommit || '') ||
      !SHA_RE.test(coreState.targetCommit || '')
    ) {
      log('Auto-update rollback skipped because its recorded state is invalid.')
      return false
    }
    const currentCommit = await git(exec, opts.rootDir, ['rev-parse', 'HEAD'])
    const alreadyCheckedOut = currentCommit === coreState.previousCommit
    if (!alreadyCheckedOut && currentCommit !== coreState.targetCommit) {
      log('Auto-update rollback skipped because the checkout moved to an unknown commit.')
      return false
    }
    const status = await git(exec, opts.rootDir, [
      'status',
      '--porcelain',
      '--untracked-files=normal',
    ])
    if (status.length > 0) {
      writeSharedDisabled(safetyPath)
      log('Auto-update rollback skipped because the checkout has local changes.')
      return false
    }
    await git(exec, opts.rootDir, [
      'cat-file',
      '-e',
      `${coreState.previousCommit}^{commit}`,
    ])
    const dependencyChanges = await git(exec, opts.rootDir, [
      'diff',
      '--name-only',
      coreState.previousCommit,
      coreState.targetCommit,
      '--',
      'bun.lock',
      'package.json',
    ])
    if (!writeSharedDisabled(safetyPath)) {
      log('Auto-update rollback could not arm the shared safety latch.')
      return false
    }
    if (alreadyCheckedOut) {
      try {
        if (dependencyChanges.length > 0) {
          await exec('bun', ['install', '--frozen-lockfile'], {
            cwd: opts.rootDir,
            timeoutMs: 120_000,
          })
        }
      } catch (error) {
        log(`Auto-update rollback dependency restore did not complete: ${errorText(error)}`)
        return false
      }
      if (!saveJsonAtomic(opts.coreStatePath, rolledBackCoreState(coreState))) {
        log('Auto-update rollback completed, but its per-daemon state could not be recorded.')
      }
      log('Auto-update rollback was completed by another daemon and dependencies are ready.')
      return true
    }
    try {
      await git(
        exec,
        opts.rootDir,
        ['checkout', '--detach', coreState.previousCommit],
        120_000,
      )
      if (dependencyChanges.length > 0) {
        await exec('bun', ['install', '--frozen-lockfile'], {
          cwd: opts.rootDir,
          timeoutMs: 120_000,
        })
      }
    } catch (rollbackError) {
      try {
        await git(
          exec,
          opts.rootDir,
          ['checkout', '--detach', coreState.targetCommit],
          120_000,
        )
        if (dependencyChanges.length > 0) {
          await exec('bun', ['install', '--frozen-lockfile'], {
            cwd: opts.rootDir,
            timeoutMs: 120_000,
          })
        }
        log('Auto-update rollback failed. The target checkout was restored safely.')
      } catch (restoreError) {
        log(`Auto-update rollback failed and target recovery also failed: ${errorText(restoreError)}`)
      }
      log(`Auto-update rollback did not complete: ${errorText(rollbackError)}`)
      return false
    }
    if (!saveJsonAtomic(opts.coreStatePath, rolledBackCoreState(coreState))) {
      log('Auto-update rolled back, but its per-daemon state could not be recorded.')
    }
    log('Auto-update rolled back after two fast child crashes.')
    log('Auto-update is disabled. Boot once with BGOS_AUTO_UPDATE=off, then set it to on again.')
    return true
  } catch (error) {
    log(`Auto-update rollback failed safely: ${errorText(error)}`)
    return false
  } finally {
    lock.release()
  }
}

export function daemonSpawnSpec(pluginDir) {
  return { file: 'bun', args: [join(pluginDir, 'server.ts')] }
}

export function spawnDaemon(pluginDir, env = process.env) {
  const spec = daemonSpawnSpec(pluginDir)
  return spawn(spec.file, spec.args, {
    cwd: process.cwd(),
    env,
    stdio: ['inherit', 'inherit', 'inherit'],
    shell: false,
  })
}

export function isIntentionalUpdateExit(input) {
  return (
    input.code === 0 &&
    SHA_RE.test(input.startedCommit || '') &&
    SHA_RE.test(input.installedCommit || '') &&
    input.startedCommit !== input.installedCommit &&
    pendingTargetForCommit(input.coreState, input.installedCommit) ===
      input.installedCommit
  )
}

export function isIntentionalRollbackExit(input) {
  const state = normalizeCoreState(input.coreState)
  return (
    input.code === 0 &&
    SHA_RE.test(input.startedCommit || '') &&
    SHA_RE.test(input.installedCommit || '') &&
    input.startedCommit !== input.installedCommit &&
    state?.disabled === true &&
    state.validationPending === false &&
    state.targetCommit === null &&
    state.lastRollbackFromCommit === input.startedCommit
  )
}

export function childExitCode(code, signal) {
  if (typeof code === 'number') return code
  const numbers = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }
  return signal && numbers[signal] ? 128 + numbers[signal] : 1
}

function waitForChild(child) {
  return new Promise((resolvePromise) => {
    child.once('error', () => resolvePromise({ code: 1, signal: null }))
    child.once('exit', (code, signal) => resolvePromise({ code, signal }))
  })
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

export async function superviseDaemon(opts) {
  const env = opts.env || process.env
  const log = opts.log || ((message) => process.stderr.write(`[bgos-wrapper] ${message}\n`))
  const exec = opts.exec || runFile
  const now = opts.now || Date.now
  const spawnChild = opts.spawnChild || spawnDaemon
  const home = opts.home || homedir()
  const flagMode = wrapperFlagMode(env.BGOS_AUTO_UPDATE)
  let coreStatePath = ''
  let wrapperStatePath = ''
  if (flagMode !== 'transparent') {
    const pairingId = readPairingAssistantId(home)
    const daemonStateDir = resolveDaemonStateDir({
      env,
      assistantId: pairingId,
      cwd: opts.cwd || process.cwd(),
      home,
    })
    coreStatePath = join(daemonStateDir, CORE_STATE_FILE)
    wrapperStatePath = join(daemonStateDir, WRAPPER_STATE_FILE)
  }
  const saveState = opts.saveState || saveJsonAtomic
  let coreBefore = null
  if (flagMode === 'monitor' && existsSync(coreStatePath)) {
    try {
      coreBefore = normalizeCoreState(
        JSON.parse(readFileSync(coreStatePath, 'utf8')),
      )
    } catch {}
    if (!coreBefore) {
      log('Boot safety state is unreadable or invalid. The daemon will not start with auto-update on.')
      return 1
    }
  }
  const pendingRecorded = coreBefore?.validationPending === true
  let currentCommit = null
  if (flagMode === 'monitor') {
    try {
      currentCommit = await git(exec, opts.pluginDir, ['rev-parse', 'HEAD'])
      if (!SHA_RE.test(currentCommit)) {
        throw new Error('git returned an invalid commit id')
      }
    } catch (error) {
      if (pendingRecorded) {
        log(`Boot safety could not verify a pending update checkout. The daemon will not start: ${errorText(error)}`)
        return 1
      }
      log(`Boot safety could not read the checkout commit. The daemon will still start: ${errorText(error)}`)
    }
  }

  let monitoringTarget = null
  if (flagMode === 'reset') {
    clearWrapperState(wrapperStatePath)
  } else if (flagMode === 'monitor' && SHA_RE.test(currentCommit || '')) {
    if (
      coreBefore?.rollbackPending === true &&
      coreBefore.targetCommit === currentCommit
    ) {
      const rolledBack = await rollbackInstalledUpdate({
        rootDir: opts.pluginDir,
        coreStatePath,
        log,
        exec,
        delay: opts.delay,
        acquireLock: opts.acquireLock,
        now,
      })
      if (!rolledBack) return 1
      clearWrapperState(wrapperStatePath)
      await validateAndInstallStableWrapper({
        sourcePath: join(opts.pluginDir, 'bin', WRAPPER_FILE_NAME),
        targetPath: opts.installedWrapperPath,
        exec,
        log,
      })
      try {
        currentCommit = await git(exec, opts.pluginDir, ['rev-parse', 'HEAD'])
      } catch {}
      coreBefore = null
    }
    monitoringTarget = pendingTargetForCommit(coreBefore, currentCommit)
    if (monitoringTarget) {
      const loaded = loadWrapperStateStrict(wrapperStatePath)
      if (loaded.kind === 'invalid') {
        log('Boot safety marker is malformed while an update is pending. The daemon will not start.')
        return 1
      }
      const transition = transitionWrapperBoot(
        loaded.state,
        monitoringTarget,
        now(),
      )
      if (transition.action === 'invalid') {
        log('Boot safety marker transition is invalid. The daemon will not start.')
        return 1
      }
      if (!saveState(wrapperStatePath, transition.state)) {
        log('Boot safety marker could not be recorded. The daemon will not start.')
        return 1
      } else if (transition.action === 'rollback') {
        const rolledBack = await rollbackInstalledUpdate({
          rootDir: opts.pluginDir,
          coreStatePath,
          log,
          exec,
          delay: opts.delay,
          acquireLock: opts.acquireLock,
          now,
        })
        if (!rolledBack) return 1
        clearWrapperState(wrapperStatePath)
        try {
          currentCommit = await git(exec, opts.pluginDir, ['rev-parse', 'HEAD'])
        } catch {}
        await validateAndInstallStableWrapper({
          sourcePath: join(opts.pluginDir, 'bin', WRAPPER_FILE_NAME),
          targetPath: opts.installedWrapperPath,
          exec,
          log,
        })
        monitoringTarget = null
      }
    }
  }

  const child = spawnChild(opts.pluginDir, env)
  let stopping = false
  const signalHandlers = new Map()
  if (opts.handleSignals !== false) {
    for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
      const handler = () => {
        stopping = true
        if (flagMode !== 'transparent') clearWrapperState(wrapperStatePath)
        try {
          child.kill(signal)
        } catch {}
      }
      signalHandlers.set(signal, handler)
      process.once(signal, handler)
    }
  }
  let healthyTimer = null
  let healthyRefresh = null
  if (monitoringTarget) {
    healthyTimer = setTimeout(() => {
      if (clearWrapperState(wrapperStatePath)) {
        log('Auto-update child validation passed after 60 seconds.')
        healthyRefresh = validateAndInstallStableWrapper({
          sourcePath: join(opts.pluginDir, 'bin', WRAPPER_FILE_NAME),
          targetPath: opts.installedWrapperPath,
          exec,
          log,
        })
      } else {
        log('Auto-update child validation marker could not be cleared.')
      }
    }, HEALTHY_AFTER_MS)
  }
  const result = await (opts.waitForChild || waitForChild)(child)
  if (healthyTimer) clearTimeout(healthyTimer)
  if (healthyRefresh) await healthyRefresh
  for (const [signal, handler] of signalHandlers) {
    process.removeListener(signal, handler)
  }
  if (stopping) {
    if (flagMode !== 'transparent') clearWrapperState(wrapperStatePath)
    return childExitCode(result.code, result.signal)
  }

  let installedCommit = currentCommit
  if (flagMode === 'monitor') {
    try {
      installedCommit = await git(exec, opts.pluginDir, ['rev-parse', 'HEAD'])
    } catch {}
  }
  let coreAfter = null
  if (flagMode === 'monitor') {
    try {
      coreAfter = JSON.parse(readFileSync(coreStatePath, 'utf8'))
    } catch {}
  }
  const updateExit = isIntentionalUpdateExit({
    code: result.code,
    startedCommit: currentCommit,
    installedCommit,
    coreState: coreAfter,
  })
  const rollbackExit = isIntentionalRollbackExit({
    code: result.code,
    startedCommit: currentCommit,
    installedCommit,
    coreState: coreAfter,
  })
  if (updateExit || rollbackExit) {
    clearWrapperState(wrapperStatePath)
    if (rollbackExit) {
      await validateAndInstallStableWrapper({
        sourcePath: join(opts.pluginDir, 'bin', WRAPPER_FILE_NAME),
        targetPath: opts.installedWrapperPath,
        exec,
        log,
      })
    }
    log(
      rollbackExit
        ? 'Rollback child exited cleanly. Exiting so the process supervisor can relaunch it.'
        : 'Auto-update child exited cleanly. Exiting so the process supervisor can relaunch it.',
    )
    return 0
  }
  if (result.code === 0 && flagMode !== 'transparent') {
    clearWrapperState(wrapperStatePath)
  }
  return childExitCode(result.code, result.signal)
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseWrapperArgs(argv)
  const thisFile = fileURLToPath(import.meta.url)
  if (parsed.kind === 'validate') return 0
  if (parsed.kind === 'install') {
    if (!isAbsolute(parsed.targetPath)) {
      process.stderr.write('[bgos-wrapper] install target must be an absolute path\n')
      return 2
    }
    installStableWrapper(thisFile, parsed.targetPath)
    process.stdout.write(`${resolve(parsed.targetPath)}\n`)
    return 0
  }
  if (parsed.kind !== 'run' || !isAbsolute(parsed.pluginDir)) {
    process.stderr.write(
      'usage: bgos-daemon-wrapper.mjs --plugin-dir /absolute/plugin/path\n',
    )
    return 2
  }
  const serverPath = join(parsed.pluginDir, 'server.ts')
  if (!existsSync(serverPath)) {
    process.stderr.write(`[bgos-wrapper] plugin server is missing: ${serverPath}\n`)
    return 1
  }
  return superviseDaemon({
    pluginDir: resolve(parsed.pluginDir),
    installedWrapperPath: thisFile,
  })
}

function isRunAsMain() {
  if (!process.argv[1]) return false
  try {
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  } catch {
    return false
  }
}

if (isRunAsMain()) {
  const code = await main()
  process.exitCode = code
}
