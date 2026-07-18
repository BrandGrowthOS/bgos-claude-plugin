import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export const AUTO_UPDATE_STATE_FILE = 'auto-update.json'
export const AUTO_UPDATE_LOCK_FILE = 'bgos-auto-update.lock'
export const AUTO_UPDATE_SAFETY_FILE = 'bgos-auto-update-disabled.json'
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const UPDATE_JITTER_MAX_MS = 6 * 60 * 60 * 1000
export const UPDATE_HEALTHY_AFTER_MS = 60 * 1000
export const UPDATE_DRAIN_POLL_MS = 500
export const UPDATE_LOCK_STALE_MS = 10 * 60 * 1000

const REMOTE_REF = 'refs/remotes/origin/main'
const SHA_RE = /^[0-9a-f]{40}$/i

export interface Semver {
  major: number
  minor: number
  patch: number
}

export type VersionDecision =
  | { kind: 'update'; running: Semver; latest: Semver }
  | { kind: 'skip'; reason: 'invalid-version' | 'not-newer' | 'major-change' }

export function parseSemver(value: string | null | undefined): Semver | null {
  if (typeof value !== 'string') return null
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
  if (!match) return null
  const parsed = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
  return Object.values(parsed).every(Number.isSafeInteger) ? parsed : null
}

export function compareSemver(left: Semver, right: Semver): number {
  if (left.major !== right.major) return Math.sign(left.major - right.major)
  if (left.minor !== right.minor) return Math.sign(left.minor - right.minor)
  return Math.sign(left.patch - right.patch)
}

export function decideVersionUpdate(
  runningVersion: string | null,
  latestVersion: string | null,
): VersionDecision {
  const running = parseSemver(runningVersion)
  const latest = parseSemver(latestVersion)
  if (!running || !latest) return { kind: 'skip', reason: 'invalid-version' }
  if (latest.major !== running.major) return { kind: 'skip', reason: 'major-change' }
  if (compareSemver(latest, running) <= 0) {
    return { kind: 'skip', reason: 'not-newer' }
  }
  return { kind: 'update', running, latest }
}

export function isAutoUpdateEnabled(value: string | undefined): boolean {
  return value === 'on'
}

export function updateJitterMs(randomValue: number): number {
  const bounded = Number.isFinite(randomValue)
    ? Math.min(1, Math.max(0, randomValue))
    : 0
  return Math.floor(bounded * UPDATE_JITTER_MAX_MS)
}

export function nextUpdateCheckDelayMs(randomValue: number): number {
  return UPDATE_CHECK_INTERVAL_MS + updateJitterMs(randomValue)
}

export interface DrainSnapshot {
  activeOperations: number
  pendingMessages: number
  pendingPermissions: number
}

export function decideDrain(snapshot: DrainSnapshot): 'ready' | 'wait' {
  return snapshot.activeOperations === 0 &&
    snapshot.pendingMessages === 0 &&
    snapshot.pendingPermissions === 0
    ? 'ready'
    : 'wait'
}

export class MessageActivityTracker {
  private activeCount = 0

  get activeOperations(): number {
    return this.activeCount
  }

  async track<T>(operation: () => Promise<T>): Promise<T> {
    this.activeCount += 1
    try {
      return await operation()
    } finally {
      this.activeCount -= 1
    }
  }
}

export interface AutoUpdateState {
  schemaVersion: 1
  disabled: boolean
  resetArmed: boolean
  previousCommit: string | null
  previousVersion: string | null
  targetCommit: string | null
  targetVersion: string | null
  crashCount: number
  validationPending: boolean
  validationBootStartedAt: number | null
  rollbackPending: boolean
  lastRollbackFromCommit: string | null
  lastRollbackFromVersion: string | null
}

export const EMPTY_AUTO_UPDATE_STATE: AutoUpdateState = Object.freeze({
  schemaVersion: 1,
  disabled: false,
  resetArmed: false,
  previousCommit: null,
  previousVersion: null,
  targetCommit: null,
  targetVersion: null,
  crashCount: 0,
  validationPending: false,
  validationBootStartedAt: null,
  rollbackPending: false,
  lastRollbackFromCommit: null,
  lastRollbackFromVersion: null,
})

function freshState(): AutoUpdateState {
  return { ...EMPTY_AUTO_UPDATE_STATE }
}

function validOptionalSha(value: unknown): string | null {
  return typeof value === 'string' && SHA_RE.test(value) ? value : null
}

function validOptionalVersion(value: unknown): string | null {
  return typeof value === 'string' && parseSemver(value) ? value : null
}

export function normalizeAutoUpdateState(value: unknown): AutoUpdateState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return freshState()
  }
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== 1) return freshState()
  const previousCommit = validOptionalSha(raw.previousCommit)
  const targetCommit = validOptionalSha(raw.targetCommit)
  const crashCount =
    typeof raw.crashCount === 'number' &&
    Number.isInteger(raw.crashCount) &&
    raw.crashCount >= 0
      ? Math.min(2, raw.crashCount)
      : 0
  return {
    schemaVersion: 1,
    disabled: raw.disabled === true,
    resetArmed: raw.resetArmed === true,
    previousCommit,
    previousVersion: validOptionalVersion(raw.previousVersion),
    targetCommit,
    targetVersion: validOptionalVersion(raw.targetVersion),
    crashCount,
    validationPending:
      raw.validationPending === true && previousCommit !== null && targetCommit !== null,
    validationBootStartedAt:
      typeof raw.validationBootStartedAt === 'number' &&
      Number.isFinite(raw.validationBootStartedAt) &&
      raw.validationBootStartedAt >= 0
        ? raw.validationBootStartedAt
        : null,
    rollbackPending:
      raw.rollbackPending === true && previousCommit !== null && targetCommit !== null,
    lastRollbackFromCommit: validOptionalSha(raw.lastRollbackFromCommit),
    lastRollbackFromVersion: validOptionalVersion(raw.lastRollbackFromVersion),
  }
}

export function resolveAutoUpdateStatePath(daemonStateFile: string): string {
  return join(dirname(daemonStateFile), AUTO_UPDATE_STATE_FILE)
}

export function loadAutoUpdateState(filePath: string): AutoUpdateState {
  try {
    return normalizeAutoUpdateState(JSON.parse(readFileSync(filePath, 'utf8')))
  } catch {
    return freshState()
  }
}

export function saveAutoUpdateState(
  filePath: string,
  state: AutoUpdateState,
): boolean {
  const tmp = `${filePath}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
    renameSync(tmp, filePath)
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {}
    return false
  }
}

export interface SharedUpdateSafety {
  schemaVersion: 1
  disabled: boolean
  resetArmed: boolean
}

export const EMPTY_SHARED_UPDATE_SAFETY: SharedUpdateSafety = Object.freeze({
  schemaVersion: 1,
  disabled: false,
  resetArmed: false,
})

export function loadSharedUpdateSafety(filePath: string): SharedUpdateSafety {
  if (!existsSync(filePath)) return { ...EMPTY_SHARED_UPDATE_SAFETY }
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
    if (raw.schemaVersion !== 1) throw new Error('unsupported safety state')
    return {
      schemaVersion: 1,
      disabled: raw.disabled === true,
      resetArmed: raw.resetArmed === true,
    }
  } catch {
    return { schemaVersion: 1, disabled: true, resetArmed: false }
  }
}

export function saveSharedUpdateSafety(
  filePath: string,
  state: SharedUpdateSafety,
): boolean {
  const tmp = `${filePath}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
    renameSync(tmp, filePath)
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {}
    return false
  }
}

export function transitionSharedSafety(
  current: SharedUpdateSafety,
  flag: string | undefined,
): SharedUpdateSafety {
  if (flag === 'off' && current.disabled && !current.resetArmed) {
    return { ...current, resetArmed: true }
  }
  if (flag === 'on' && current.disabled && current.resetArmed) {
    return { ...current, disabled: false, resetArmed: false }
  }
  return current
}

export type RollbackEvent =
  | {
      kind: 'update-installed'
      previousCommit: string
      previousVersion: string
      targetCommit: string
      targetVersion: string
    }
  | { kind: 'boot'; currentCommit: string; now: number }
  | { kind: 'healthy'; currentCommit: string }
  | { kind: 'graceful-stop'; currentCommit: string }
  | { kind: 'rollback-succeeded' }

export interface RollbackTransition {
  state: AutoUpdateState
  action: 'none' | 'rollback'
}

export function transitionRollbackState(
  current: AutoUpdateState,
  event: RollbackEvent,
): RollbackTransition {
  const state = { ...current }
  if (event.kind === 'update-installed') {
    return {
      action: 'none',
      state: {
        ...state,
        disabled: false,
        resetArmed: false,
        previousCommit: event.previousCommit,
        previousVersion: event.previousVersion,
        targetCommit: event.targetCommit,
        targetVersion: event.targetVersion,
        crashCount: 0,
        validationPending: true,
        validationBootStartedAt: null,
        rollbackPending: false,
      },
    }
  }
  if (event.kind === 'rollback-succeeded') {
    return {
      action: 'none',
      state: {
        ...state,
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
        lastRollbackFromCommit: state.targetCommit,
        lastRollbackFromVersion: state.targetVersion,
      },
    }
  }
  if (state.disabled) return { state, action: 'none' }
  if (event.kind === 'healthy') {
    if (
      state.validationPending &&
      state.targetCommit === event.currentCommit &&
      state.validationBootStartedAt !== null
    ) {
      return {
        action: 'none',
        state: {
          ...state,
          previousCommit: null,
          previousVersion: null,
          targetCommit: null,
          targetVersion: null,
          crashCount: 0,
          validationPending: false,
          validationBootStartedAt: null,
          rollbackPending: false,
        },
      }
    }
    return { state, action: 'none' }
  }
  if (event.kind === 'graceful-stop') {
    if (state.targetCommit === event.currentCommit) {
      state.validationBootStartedAt = null
    }
    return { state, action: 'none' }
  }
  if (state.rollbackPending) return { state, action: 'rollback' }
  if (!state.validationPending || state.targetCommit !== event.currentCommit) {
    if (state.validationPending && state.targetCommit !== event.currentCommit) {
      state.previousCommit = null
      state.previousVersion = null
      state.targetCommit = null
      state.targetVersion = null
      state.crashCount = 0
      state.validationPending = false
      state.validationBootStartedAt = null
      state.rollbackPending = false
    }
    return { state, action: 'none' }
  }
  if (state.validationBootStartedAt !== null) state.crashCount += 1
  if (state.crashCount >= 2) {
    state.crashCount = 2
    state.validationBootStartedAt = null
    state.rollbackPending = true
    return { state, action: 'rollback' }
  }
  state.validationBootStartedAt = event.now
  return { state, action: 'none' }
}

export function transitionFlagLatch(
  current: AutoUpdateState,
  flag: string | undefined,
): AutoUpdateState {
  if (flag === 'off' && current.disabled && !current.resetArmed) {
    return { ...current, resetArmed: true }
  }
  if (flag === 'on' && current.disabled && current.resetArmed) {
    return { ...current, disabled: false, resetArmed: false }
  }
  return current
}

export type CheckoutDecision =
  | { kind: 'pull' }
  | { kind: 'restart'; reason: 'lock-held' | 'already-updated' }
  | { kind: 'skip'; reason: 'dirty-tree' | 'not-fast-forward' }

export function decideCheckoutAction(input: {
  dirty: boolean
  lockHeld: boolean
  currentCommit: string
  targetCommit: string
  canFastForward: boolean
}): CheckoutDecision {
  if (input.dirty) return { kind: 'skip', reason: 'dirty-tree' }
  if (input.lockHeld) return { kind: 'restart', reason: 'lock-held' }
  if (input.currentCommit === input.targetCommit) {
    return { kind: 'restart', reason: 'already-updated' }
  }
  if (!input.canFastForward) return { kind: 'skip', reason: 'not-fast-forward' }
  return { kind: 'pull' }
}

export interface CommandResult {
  stdout: string
  stderr: string
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<CommandResult>

export const runCommand: CommandRunner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })

async function git(
  runner: CommandRunner,
  rootDir: string,
  args: readonly string[],
  timeoutMs = 60_000,
): Promise<string> {
  const result = await runner('git', args, { cwd: rootDir, timeoutMs })
  return result.stdout.trim()
}

async function canFastForward(
  runner: CommandRunner,
  rootDir: string,
): Promise<boolean> {
  try {
    const head = await git(runner, rootDir, ['rev-parse', 'HEAD'])
    const base = await git(runner, rootDir, ['merge-base', 'HEAD', REMOTE_REF])
    return SHA_RE.test(head) && base === head
  } catch {
    return false
  }
}

function packageVersion(raw: string): string | null {
  try {
    const version = (JSON.parse(raw) as { version?: unknown }).version
    return typeof version === 'string' && parseSemver(version) ? version : null
  } catch {
    return null
  }
}

export type GitUpdateInspection =
  | { kind: 'dirty-tree' }
  | {
      kind: 'checked'
      currentCommit: string
      targetCommit: string
      latestVersion: string | null
      versionDecision: VersionDecision
      canFastForward: boolean
    }

export async function inspectGitUpdate(opts: {
  rootDir: string
  runningVersion: string | null
  runner?: CommandRunner
}): Promise<GitUpdateInspection> {
  const runner = opts.runner ?? runCommand
  const status = await git(runner, opts.rootDir, [
    'status',
    '--porcelain',
    '--untracked-files=normal',
  ])
  if (status.length > 0) return { kind: 'dirty-tree' }
  await git(runner, opts.rootDir, ['fetch', '--quiet', 'origin', 'main'])
  const [currentCommit, targetCommit, rawPackage] = await Promise.all([
    git(runner, opts.rootDir, ['rev-parse', 'HEAD']),
    git(runner, opts.rootDir, ['rev-parse', REMOTE_REF]),
    git(runner, opts.rootDir, ['show', `${REMOTE_REF}:package.json`]),
  ])
  if (!SHA_RE.test(currentCommit) || !SHA_RE.test(targetCommit)) {
    throw new Error('git returned an invalid commit id')
  }
  const latestVersion = packageVersion(rawPackage)
  return {
    kind: 'checked',
    currentCommit,
    targetCommit,
    latestVersion,
    versionDecision: decideVersionUpdate(opts.runningVersion, latestVersion),
    canFastForward: await canFastForward(runner, opts.rootDir),
  }
}

export async function runSelfUpdateDryRun(opts: {
  rootDir: string
  runningVersion: string | null
  log: (message: string) => void
  runner?: CommandRunner
}): Promise<GitUpdateInspection> {
  const result = await inspectGitUpdate(opts)
  if (result.kind === 'dirty-tree') {
    opts.log('Auto-update dry run: skipped because the checkout has local changes.')
    return result
  }
  if (result.versionDecision.kind === 'update') {
    const safety = result.canFastForward ? 'fast-forward available' : 'not fast-forward'
    opts.log(
      `Auto-update dry run: ${opts.runningVersion} to ${result.latestVersion}, ${safety}.`,
    )
  } else {
    opts.log(
      `Auto-update dry run: running ${opts.runningVersion ?? 'unknown'}, ` +
        `latest ${result.latestVersion ?? 'unknown'}, no update (${result.versionDecision.reason}).`,
    )
  }
  return result
}

export interface HeldUpdateLock {
  kind: 'acquired'
  release: () => void
}

export type UpdateLockResult = HeldUpdateLock | { kind: 'held' }

export function tryAcquireUpdateLock(
  lockPath: string,
  now = Date.now(),
): UpdateLockResult {
  const attempt = (): HeldUpdateLock | null => {
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      const token = randomUUID()
      const body = JSON.stringify({ pid: process.pid, startedAt: now, token })
      writeFileSync(fd, body)
      closeSync(fd)
      let released = false
      return {
        kind: 'acquired',
        release: () => {
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
    const age = now - statSync(lockPath).mtimeMs
    if (age <= UPDATE_LOCK_STALE_MS) return { kind: 'held' }
    unlinkSync(lockPath)
  } catch {
    return { kind: 'held' }
  }
  return attempt() ?? { kind: 'held' }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export interface SelfUpdaterOptions {
  rootDir: string
  stateFilePath: string
  env: Record<string, string | undefined>
  runningVersion: string | null
  log: (message: string) => void
  drainSnapshot: () => DrainSnapshot
  setDrainMode: (enabled: boolean) => void
  exit: (code: number) => void
  runner?: CommandRunner
  random?: () => number
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  delay?: (ms: number) => Promise<void>
}

export class SelfUpdater {
  private state: AutoUpdateState
  private readonly runner: CommandRunner
  private readonly random: () => number
  private readonly now: () => number
  private readonly schedule: NonNullable<SelfUpdaterOptions['schedule']>
  private readonly delay: (ms: number) => Promise<void>
  private readonly lockPath: string
  private readonly safetyPath: string
  private runningCommit: string
  private checkRunning = false
  private exiting = false
  private started = false
  private healthyTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly opts: SelfUpdaterOptions,
    state: AutoUpdateState,
    runningCommit: string,
  ) {
    this.state = state
    this.runningCommit = runningCommit
    this.runner = opts.runner ?? runCommand
    this.random = opts.random ?? Math.random
    this.now = opts.now ?? Date.now
    this.schedule = opts.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.delay = opts.delay ?? sleep
    this.lockPath = join(opts.rootDir, '.git', AUTO_UPDATE_LOCK_FILE)
    this.safetyPath = join(opts.rootDir, '.git', AUTO_UPDATE_SAFETY_FILE)
  }

  armValidationTimer(): void {
    if (
      !this.state.validationPending ||
      this.state.targetCommit !== this.runningCommit ||
      this.state.validationBootStartedAt === null
    ) {
      return
    }
    this.healthyTimer = this.schedule(() => {
      const transition = transitionRollbackState(this.state, {
        kind: 'healthy',
        currentCommit: this.runningCommit,
      })
      this.state = transition.state
      saveAutoUpdateState(this.opts.stateFilePath, this.state)
      this.opts.log('Auto-update validation passed after 60 seconds.')
      if (this.started) void this.checkNow()
    }, UPDATE_HEALTHY_AFTER_MS)
    this.healthyTimer.unref?.()
  }

  start(): void {
    if (this.started || this.exiting) return
    this.started = true
    void this.checkNow()
  }

  markGracefulStop(): void {
    if (this.exiting) return
    const transition = transitionRollbackState(this.state, {
      kind: 'graceful-stop',
      currentCommit: this.runningCommit,
    })
    this.state = transition.state
    saveAutoUpdateState(this.opts.stateFilePath, this.state)
  }

  private scheduleNext(): void {
    if (this.exiting) return
    const delayMs = nextUpdateCheckDelayMs(this.random())
    const timer = this.schedule(() => void this.checkNow(), delayMs)
    timer.unref?.()
  }

  async checkNow(): Promise<void> {
    if (this.checkRunning || this.exiting) return
    this.checkRunning = true
    try {
      if (this.state.validationPending) {
        this.opts.log('Auto-update check deferred while the new code is validating.')
        return
      }
      const inspection = await inspectGitUpdate({
        rootDir: this.opts.rootDir,
        runningVersion: this.opts.runningVersion,
        runner: this.runner,
      })
      if (inspection.kind === 'dirty-tree') {
        this.opts.log('Auto-update skipped because the checkout has local changes.')
        return
      }
      if (inspection.versionDecision.kind !== 'update') {
        this.opts.log(
          `Auto-update check: running ${this.opts.runningVersion ?? 'unknown'}, ` +
            `latest ${inspection.latestVersion ?? 'unknown'}, no update ` +
            `(${inspection.versionDecision.reason}).`,
        )
        return
      }
      if (!inspection.canFastForward && inspection.currentCommit !== inspection.targetCommit) {
        this.opts.log('Auto-update skipped because the checkout cannot fast-forward to origin/main.')
        return
      }
      await this.applyUpdate(inspection)
    } catch (error) {
      this.opts.log(`Auto-update check failed and the daemon will continue: ${errorText(error)}`)
      this.opts.setDrainMode(false)
    } finally {
      this.checkRunning = false
      this.scheduleNext()
    }
  }

  private async waitForDrain(): Promise<void> {
    this.opts.setDrainMode(true)
    let logged = false
    while (decideDrain(this.opts.drainSnapshot()) !== 'ready') {
      if (!logged) {
        this.opts.log('Auto-update is waiting for current message processing to finish.')
        logged = true
      }
      await this.delay(UPDATE_DRAIN_POLL_MS)
    }
  }

  private recordInstalled(targetCommit: string, targetVersion: string): void {
    const transition = transitionRollbackState(this.state, {
      kind: 'update-installed',
      previousCommit: this.runningCommit,
      previousVersion: this.opts.runningVersion!,
      targetCommit,
      targetVersion,
    })
    this.state = transition.state
    if (!saveAutoUpdateState(this.opts.stateFilePath, this.state)) {
      throw new Error('could not record rollback state')
    }
  }

  private async applyUpdate(
    inspection: Extract<GitUpdateInspection, { kind: 'checked' }>,
  ): Promise<void> {
    await this.waitForDrain()
    const lock = tryAcquireUpdateLock(this.lockPath, this.now())
    if (lock.kind === 'held') {
      this.recordInstalled(inspection.targetCommit, inspection.latestVersion!)
      this.opts.log('Auto-update is being applied by another daemon. Waiting to restart safely.')
      while (true) {
        await this.delay(UPDATE_DRAIN_POLL_MS)
        const completed = tryAcquireUpdateLock(this.lockPath, this.now())
        if (completed.kind === 'held') continue
        completed.release()
        break
      }
      this.opts.log('The shared checkout update lock is clear. Restarting this daemon.')
      this.exiting = true
      this.opts.exit(0)
      return
    }
    try {
      const status = await git(this.runner, this.opts.rootDir, [
        'status',
        '--porcelain',
        '--untracked-files=normal',
      ])
      const currentCommit = await git(this.runner, this.opts.rootDir, ['rev-parse', 'HEAD'])
      const action = decideCheckoutAction({
        dirty: status.length > 0,
        lockHeld: false,
        currentCommit,
        targetCommit: inspection.targetCommit,
        canFastForward: await canFastForward(this.runner, this.opts.rootDir),
      })
      if (action.kind === 'skip') {
        this.opts.log(
          action.reason === 'dirty-tree'
            ? 'Auto-update skipped because the checkout became dirty before the pull.'
            : 'Auto-update skipped because the checkout cannot fast-forward to origin/main.',
        )
        this.opts.setDrainMode(false)
        return
      }
      const stateBeforeUpdate = this.state
      this.recordInstalled(inspection.targetCommit, inspection.latestVersion!)
      const pendingInstalledState = this.state
      if (action.kind === 'pull') {
        const dependencyChanges = await git(this.runner, this.opts.rootDir, [
          'diff',
          '--name-only',
          currentCommit,
          inspection.targetCommit,
          '--',
          'bun.lock',
          'package.json',
        ])
        let mergeCompleted = false
        try {
          await git(
            this.runner,
            this.opts.rootDir,
            ['merge', '--ff-only', '--no-edit', REMOTE_REF],
            120_000,
          )
          mergeCompleted = true
          if (dependencyChanges.length > 0) {
            await this.runner('bun', ['install', '--frozen-lockfile'], {
              cwd: this.opts.rootDir,
              timeoutMs: 120_000,
            })
          }
        } catch (error) {
          if (mergeCompleted) {
            try {
              await git(
                this.runner,
                this.opts.rootDir,
                ['checkout', '--detach', currentCommit],
                120_000,
              )
              this.state = stateBeforeUpdate
              saveAutoUpdateState(this.opts.stateFilePath, this.state)
              this.opts.log('Auto-update failed after the pull. The previous checkout was restored.')
            } catch (restoreError) {
              this.state = pendingInstalledState
              saveAutoUpdateState(this.opts.stateFilePath, this.state)
              this.opts.log(
                `Auto-update could not restore the previous checkout. ` +
                  `Rollback validation remains armed: ${errorText(restoreError)}`,
              )
            }
          } else {
            this.state = stateBeforeUpdate
            saveAutoUpdateState(this.opts.stateFilePath, this.state)
          }
          throw error
        }
        this.opts.log(
          `Auto-update installed ${this.opts.runningVersion} to ${inspection.latestVersion}.`,
        )
      } else {
        this.opts.log('Auto-update was already installed by another daemon.')
      }
      this.opts.log('Auto-update complete. Exiting so the supervisor can restart the daemon.')
      this.exiting = true
      lock.release()
      this.opts.exit(0)
    } finally {
      lock.release()
    }
  }

  async attemptRollback(): Promise<void> {
    if (!this.state.rollbackPending || !this.state.previousCommit) return
    const lock = tryAcquireUpdateLock(this.lockPath, this.now())
    if (lock.kind === 'held') {
      this.opts.log('Auto-update rollback is being handled by another daemon. Restarting.')
      this.exiting = true
      this.opts.exit(0)
      return
    }
    try {
      const status = await git(this.runner, this.opts.rootDir, [
        'status',
        '--porcelain',
        '--untracked-files=normal',
      ])
      if (status.length > 0) {
        this.opts.log('Auto-update rollback skipped because the checkout has local changes.')
        return
      }
      await git(this.runner, this.opts.rootDir, [
        'cat-file',
        '-e',
        `${this.state.previousCommit}^{commit}`,
      ])
      await git(
        this.runner,
        this.opts.rootDir,
        ['checkout', '--detach', this.state.previousCommit],
        120_000,
      )
      const transition = transitionRollbackState(this.state, {
        kind: 'rollback-succeeded',
      })
      this.state = transition.state
      if (
        !saveSharedUpdateSafety(this.safetyPath, {
          schemaVersion: 1,
          disabled: true,
          resetArmed: false,
        })
      ) {
        throw new Error('could not record the shared rollback safety latch')
      }
      if (!saveAutoUpdateState(this.opts.stateFilePath, this.state)) {
        throw new Error('could not record completed rollback')
      }
      this.opts.log(
        'Auto-update rolled back to the recorded commit after two fast boot crashes.',
      )
      this.opts.log(
        'Auto-update is disabled. Boot once with BGOS_AUTO_UPDATE=off, then set it to on again.',
      )
      this.exiting = true
      lock.release()
      this.opts.exit(0)
    } catch (error) {
      this.opts.log(`Auto-update rollback failed and the daemon will continue: ${errorText(error)}`)
    } finally {
      lock.release()
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function initializeSelfUpdater(
  opts: SelfUpdaterOptions,
): Promise<SelfUpdater | null> {
  const flag = opts.env.BGOS_AUTO_UPDATE
  const safetyPath = join(opts.rootDir, '.git', AUTO_UPDATE_SAFETY_FILE)
  if (!isAutoUpdateEnabled(flag)) {
    if (flag === 'off' && existsSync(opts.stateFilePath)) {
      const current = loadAutoUpdateState(opts.stateFilePath)
      const next = transitionFlagLatch(current, flag)
      if (next !== current) saveAutoUpdateState(opts.stateFilePath, next)
    }
    if (flag === 'off' && existsSync(safetyPath)) {
      const current = loadSharedUpdateSafety(safetyPath)
      const next = transitionSharedSafety(current, flag)
      if (next !== current) saveSharedUpdateSafety(safetyPath, next)
    }
    return null
  }
  const sharedSafety = loadSharedUpdateSafety(safetyPath)
  const nextSharedSafety = transitionSharedSafety(sharedSafety, flag)
  if (nextSharedSafety !== sharedSafety) {
    if (!saveSharedUpdateSafety(safetyPath, nextSharedSafety)) {
      opts.log('Auto-update could not clear the shared rollback safety latch.')
      return null
    }
  }
  if (nextSharedSafety.disabled) {
    opts.log(
      'Auto-update remains disabled for this shared checkout. Boot once with BGOS_AUTO_UPDATE=off before enabling it again.',
    )
    return null
  }
  let state = loadAutoUpdateState(opts.stateFilePath)
  const latchState = transitionFlagLatch(state, flag)
  if (latchState !== state) {
    state = latchState
    if (!saveAutoUpdateState(opts.stateFilePath, state)) {
      opts.log('Auto-update could not clear the daemon rollback safety latch.')
      return null
    }
  }
  if (state.disabled) {
    opts.log(
      'Auto-update remains disabled after rollback. Boot once with BGOS_AUTO_UPDATE=off before enabling it again.',
    )
    return null
  }
  try {
    const runner = opts.runner ?? runCommand
    const runningCommit = await git(runner, opts.rootDir, ['rev-parse', 'HEAD'])
    if (!SHA_RE.test(runningCommit)) throw new Error('git returned an invalid commit id')
    const boot = transitionRollbackState(state, {
      kind: 'boot',
      currentCommit: runningCommit,
      now: (opts.now ?? Date.now)(),
    })
    state = boot.state
    saveAutoUpdateState(opts.stateFilePath, state)
    const updater = new SelfUpdater(opts, state, runningCommit)
    if (boot.action === 'rollback') {
      await updater.attemptRollback()
    } else {
      updater.armValidationTimer()
    }
    return updater
  } catch (error) {
    opts.log(`Auto-update initialization failed and the daemon will continue: ${errorText(error)}`)
    return null
  }
}
