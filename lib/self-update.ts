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
  // Default ON (KC 2026-07-18): an unset or empty flag enables auto-update.
  // Any other explicit value that is not exactly 'on' disables it, so 'off'
  // stays the hard kill switch and typos fail closed to disabled.
  if (value === undefined || value === '') return true
  return value === 'on'
}

/**
 * Does this host actually have something that will restart the daemon?
 *
 * KC-SERVER OUTAGE, 2026-08-06. After installing an update the daemon used
 * to log "Exiting so the supervisor can restart the daemon" and exit, with
 * no check that a supervisor existed. On a host where nothing restarts it,
 * that is not a restart, it is a death: five of seven agents on one machine
 * went silent overnight, one at a time as each reached its update. Their
 * claude processes stayed alive and their sessions looked online, so the
 * only symptom was that nobody answered.
 *
 * So exiting is now OPT IN. A host that really is supervised sets
 * BGOS_EXIT_AFTER_UPDATE and keeps the old cycle-on-update behavior.
 * Everywhere else the daemon keeps serving on the code it already has,
 * which is worse than a restart and enormously better than being gone.
 *
 * Fails closed on typos: anything not explicitly truthy means do not exit.
 */
export function shouldExitAfterUpdate(env: Record<string, string | undefined>): boolean {
  const value = (env.BGOS_EXIT_AFTER_UPDATE ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'on' || value === 'yes'
}

/**
 * The line that keeps a not-exiting daemon honest.
 *
 * Not exiting trades death for staleness: the update is on disk while the
 * process keeps running the old code, potentially for days (sessions here
 * run that long). Ava (871) made the point when reviewing this fix, and it
 * is the same distinction that cost us most of the previous week: AN
 * INSTALLED VERSION IS NOT A RUNNING VERSION. So the pending restart is
 * announced on every boot beside the auto-update banner, not once at
 * install time where it scrolls past whoever was not watching.
 *
 * Returns null when there is nothing pending, so the caller logs nothing.
 */
export function describePendingRestart(params: {
  runningVersion: string | null | undefined
  installedVersion: string | null | undefined
}): string | null {
  const running = params.runningVersion?.trim()
  const installed = pendingRestartVersionFrom(
    params.runningVersion,
    params.installedVersion,
  )
  if (!running || !installed) return null
  return (
    `Pending update: running ${running}, installed ${installed}, ` +
    'takes effect when this session restarts.'
  )
}

/** The installed-but-not-running version, or null when nothing is pending.
 *  The comparison describePendingRestart narrates, extracted so the
 *  heartbeat's updateReadiness.pendingRestartVersion (wire contract v1) and
 *  the update_rpc ladder read the exact same fact. */
export function pendingRestartVersionFrom(
  runningVersion: string | null | undefined,
  installedVersion: string | null | undefined,
): string | null {
  const running = runningVersion?.trim()
  const installed = installedVersion?.trim()
  if (!running || !installed || running === installed) return null
  return installed
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

function failClosedState(): AutoUpdateState {
  return { ...EMPTY_AUTO_UPDATE_STATE, disabled: true }
}

function validOptionalSha(value: unknown): string | null {
  return typeof value === 'string' && SHA_RE.test(value) ? value : null
}

function validOptionalVersion(value: unknown): string | null {
  return typeof value === 'string' && parseSemver(value) ? value : null
}

export function normalizeAutoUpdateState(value: unknown): AutoUpdateState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return failClosedState()
  }
  const raw = value as Record<string, unknown>
  const validRequired =
    raw.schemaVersion === 1 &&
    typeof raw.disabled === 'boolean' &&
    typeof raw.resetArmed === 'boolean' &&
    typeof raw.crashCount === 'number' &&
    Number.isInteger(raw.crashCount) &&
    raw.crashCount >= 0 &&
    typeof raw.validationPending === 'boolean' &&
    typeof raw.rollbackPending === 'boolean'
  const validOptionalShaFields = [
    raw.previousCommit,
    raw.targetCommit,
    raw.lastRollbackFromCommit,
  ].every((entry) => entry === null || validOptionalSha(entry) !== null)
  const validOptionalVersionFields = [
    raw.previousVersion,
    raw.targetVersion,
    raw.lastRollbackFromVersion,
  ].every((entry) => entry === null || validOptionalVersion(entry) !== null)
  const validBootTime =
    raw.validationBootStartedAt === null ||
    (typeof raw.validationBootStartedAt === 'number' &&
      Number.isFinite(raw.validationBootStartedAt) &&
      raw.validationBootStartedAt >= 0)
  if (
    !validRequired ||
    !validOptionalShaFields ||
    !validOptionalVersionFields ||
    !validBootTime
  ) {
    return failClosedState()
  }
  const previousCommit = validOptionalSha(raw.previousCommit)
  const targetCommit = validOptionalSha(raw.targetCommit)
  const previousVersion = validOptionalVersion(raw.previousVersion)
  const targetVersion = validOptionalVersion(raw.targetVersion)
  const crashCount =
    typeof raw.crashCount === 'number' &&
    Number.isInteger(raw.crashCount) &&
    raw.crashCount >= 0
      ? Math.min(2, raw.crashCount)
      : 0
  const transitionTracked =
    raw.validationPending === true ||
    raw.rollbackPending === true ||
    crashCount > 0 ||
    raw.validationBootStartedAt !== null
  const completeTransition =
    previousCommit !== null &&
    targetCommit !== null &&
    previousVersion !== null &&
    targetVersion !== null
  const hasAnyTransitionVersion =
    previousCommit !== null ||
    targetCommit !== null ||
    previousVersion !== null ||
    targetVersion !== null
  const validationPending = raw.validationPending === true
  const rollbackPending = raw.rollbackPending === true
  const validationBootStartedAt =
    typeof raw.validationBootStartedAt === 'number' &&
    Number.isFinite(raw.validationBootStartedAt) &&
    raw.validationBootStartedAt >= 0
      ? raw.validationBootStartedAt
      : null
  const validActiveTransition =
    validationPending &&
    raw.disabled === false &&
    completeTransition &&
    previousCommit !== targetCommit &&
    decideVersionUpdate(previousVersion, targetVersion).kind === 'update' &&
    (rollbackPending
      ? crashCount === 2 && validationBootStartedAt === null
      : crashCount <= 1 && (crashCount === 0 || validationBootStartedAt !== null))
  const validInactiveTransition =
    !validationPending &&
    !rollbackPending &&
    !hasAnyTransitionVersion &&
    crashCount === 0 &&
    validationBootStartedAt === null
  if (
    (transitionTracked && !validActiveTransition) ||
    (!transitionTracked && !validInactiveTransition) ||
    (raw.resetArmed === true && raw.disabled !== true) ||
    (raw.disabled === true && validationPending)
  ) {
    return failClosedState()
  }
  return {
    schemaVersion: 1,
    disabled: raw.disabled === true,
    resetArmed: raw.resetArmed === true,
    previousCommit,
    previousVersion,
    targetCommit,
    targetVersion,
    crashCount,
    validationPending,
    validationBootStartedAt,
    rollbackPending,
    lastRollbackFromCommit: validOptionalSha(raw.lastRollbackFromCommit),
    lastRollbackFromVersion: validOptionalVersion(raw.lastRollbackFromVersion),
  }
}

export function resolveAutoUpdateStatePath(daemonStateFile: string): string {
  return join(dirname(daemonStateFile), AUTO_UPDATE_STATE_FILE)
}

export function loadAutoUpdateState(filePath: string): AutoUpdateState {
  if (!existsSync(filePath)) return freshState()
  try {
    return normalizeAutoUpdateState(JSON.parse(readFileSync(filePath, 'utf8')))
  } catch {
    return failClosedState()
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
    if (typeof raw.disabled !== 'boolean' || typeof raw.resetArmed !== 'boolean') {
      throw new Error('malformed safety state')
    }
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
      state.crashCount = 0
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
  if (state.validationBootStartedAt !== null) {
    const elapsed = event.now - state.validationBootStartedAt
    if (elapsed >= UPDATE_HEALTHY_AFTER_MS) {
      return transitionRollbackState(state, {
        kind: 'healthy',
        currentCommit: event.currentCommit,
      })
    }
    state.crashCount += 1
  }
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

/**
 * Does a `git status --porcelain` body describe a tree too dirty to update?
 *
 * UNTRACKED files (porcelain `??`) and IGNORED files (`!!`) do NOT count: a
 * fetch + fast-forward merge never touches them, and git itself refuses a
 * checkout only when an untracked file would actually be overwritten (which
 * the ff-only merge surfaces on its own). Refusing on any stray file -- a
 * report .md someone dropped into the clone -- made one-click updates fail
 * with 'dirty_tree' for no real reason (KC incident 2026-08-24). Only TRACKED
 * modifications, staged changes, deletions, renames, or merge conflicts make
 * the tree dirty. We deliberately never `git clean`: a user's untracked files
 * are theirs to keep.
 */
export function porcelainIndicatesDirtyTree(status: string): boolean {
  return status.split('\n').some((rawLine) => {
    const line = rawLine.replace(/\r$/, '')
    if (line.length === 0) return false
    // Porcelain v1 status codes live in the first two columns; '??' is
    // untracked and '!!' is ignored. Everything else is a real change.
    if (line.startsWith('??') || line.startsWith('!!')) return false
    return true
  })
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
  targetCommit: string,
): Promise<boolean> {
  try {
    const head = await git(runner, rootDir, ['rev-parse', 'HEAD'])
    const base = await git(runner, rootDir, ['merge-base', 'HEAD', targetCommit])
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
  if (porcelainIndicatesDirtyTree(status)) return { kind: 'dirty-tree' }
  await git(runner, opts.rootDir, ['fetch', '--quiet', 'origin', 'main'])
  const [currentCommit, targetCommit] = await Promise.all([
    git(runner, opts.rootDir, ['rev-parse', 'HEAD']),
    git(runner, opts.rootDir, ['rev-parse', REMOTE_REF]),
  ])
  if (!SHA_RE.test(currentCommit) || !SHA_RE.test(targetCommit)) {
    throw new Error('git returned an invalid commit id')
  }
  const rawPackage = await git(runner, opts.rootDir, ['show', `${targetCommit}:package.json`])
  const latestVersion = packageVersion(rawPackage)
  return {
    kind: 'checked',
    currentCommit,
    targetCommit,
    latestVersion,
    versionDecision: decideVersionUpdate(opts.runningVersion, latestVersion),
    canFastForward: await canFastForward(runner, opts.rootDir, targetCommit),
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

/** What a triggered (update_rpc 'update_now') run produced. 'failed' with
 *  latched:true means the checkout latched itself drained (the existing
 *  worst-case posture); every other outcome leaves intake serving. */
export type UpdateNowOutcome =
  | { kind: 'busy' }
  | { kind: 'latched' }
  | {
      kind: 'no-update'
      latestVersion: string | null
      reason: 'invalid-version' | 'not-newer' | 'major-change'
    }
  | { kind: 'dirty-tree' }
  | { kind: 'not-fast-forward' }
  | { kind: 'installed'; targetVersion: string }
  | { kind: 'failed'; message: string; latched: boolean }

/** applyUpdate's per-mode result. 'exited' only ever surfaces in tests
 *  (the injected exit spy returns); in production opts.exit never does. */
type ApplyUpdateOutcome =
  | 'installed'
  | 'exited'
  | 'skipped-dirty'
  | 'skipped-not-ff'
  | 'skipped-target-mismatch'
  | 'failed-latched'

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
  private lastInspectedVersion: string | null = null

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

  /** The newest version the last origin/main inspection found (heartbeat
   *  telemetry, wire contract v1 latestKnownVersion). Null before the first
   *  successful check; non-git installs never construct an updater at all. */
  get latestKnownVersion(): string | null {
    return this.lastInspectedVersion
  }

  /** True when either rollback latch (this daemon's state or the shared
   *  checkout safety file) is holding updates off. */
  isRollbackLatched(): boolean {
    return this.state.disabled || loadSharedUpdateSafety(this.safetyPath).disabled
  }

  /** The installed-but-not-running version, if any: live-state source of the
   *  fact describePendingRestart reads at boot. */
  pendingRestartVersion(): string | null {
    return pendingRestartVersionFrom(
      this.opts.runningVersion,
      this.state.validationPending ? this.state.targetVersion : null,
    )
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
      if (!saveAutoUpdateState(this.opts.stateFilePath, transition.state)) {
        this.opts.log('Auto-update could not record healthy validation; rollback state stays armed.')
        return
      }
      this.state = transition.state
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
      const sharedSafety = loadSharedUpdateSafety(this.safetyPath)
      if (sharedSafety.disabled) {
        this.opts.log('Auto-update check skipped because this shared checkout is rollback-disabled.')
        return
      }
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
      this.lastInspectedVersion = inspection.latestVersion
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

  /**
   * One-click update (update_rpc 'update_now'): the same inspection, drain,
   * and ff-only apply as a scheduled check, run on demand and WITHOUT any
   * exit: the caller owns the restart ladder (service restart, launcher
   * marker, or staged), because a triggered update that self-exits on an
   * unsupervised host is the kc-server outage again. Reports 'draining' and
   * 'installing' through `report` (which must not throw); every other stage
   * belongs to the caller. After 'installed' the drain deliberately stays ON
   * until the caller restarts or stages; every other outcome (except a
   * latched failure, which stays drained by design) leaves intake serving.
   */
  async updateNow(
    report: (stage: 'draining' | 'installing', targetVersion: string | null) => Promise<void>,
  ): Promise<UpdateNowOutcome> {
    if (this.checkRunning || this.exiting) return { kind: 'busy' }
    this.checkRunning = true
    try {
      if (this.isRollbackLatched()) return { kind: 'latched' }
      if (this.state.validationPending) {
        // An update is already on disk awaiting a restart (or the freshly
        // restarted code is inside its 60s validation window): nothing to
        // pull. With a pending version the caller goes straight to the
        // restart ladder; mid-validation there is no coherent answer yet.
        const pending = this.pendingRestartVersion()
        return pending ? { kind: 'installed', targetVersion: pending } : { kind: 'busy' }
      }
      const inspection = await inspectGitUpdate({
        rootDir: this.opts.rootDir,
        runningVersion: this.opts.runningVersion,
        runner: this.runner,
      })
      if (inspection.kind === 'dirty-tree') return { kind: 'dirty-tree' }
      this.lastInspectedVersion = inspection.latestVersion
      if (inspection.versionDecision.kind !== 'update') {
        return {
          kind: 'no-update',
          latestVersion: inspection.latestVersion,
          reason: inspection.versionDecision.reason,
        }
      }
      if (!inspection.canFastForward && inspection.currentCommit !== inspection.targetCommit) {
        return { kind: 'not-fast-forward' }
      }
      await report('draining', inspection.latestVersion)
      await this.waitForDrain()
      await report('installing', inspection.latestVersion)
      const applied = await this.applyUpdate(inspection, 'triggered')
      if (applied === 'installed' || applied === 'exited') {
        return { kind: 'installed', targetVersion: inspection.latestVersion! }
      }
      if (applied === 'skipped-dirty') return { kind: 'dirty-tree' }
      if (applied === 'skipped-not-ff') return { kind: 'not-fast-forward' }
      if (applied === 'skipped-target-mismatch') {
        return {
          kind: 'failed',
          message: 'another daemon installed a different target',
          latched: false,
        }
      }
      return {
        kind: 'failed',
        message: 'update failed and this checkout latched itself drained; see the daemon log',
        latched: true,
      }
    } catch (error) {
      this.opts.setDrainMode(false)
      return { kind: 'failed', message: errorText(error), latched: false }
    } finally {
      this.checkRunning = false
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
    if (!saveAutoUpdateState(this.opts.stateFilePath, transition.state)) {
      throw new Error('could not record rollback state')
    }
    this.state = transition.state
  }

  private async applyUpdate(
    inspection: Extract<GitUpdateInspection, { kind: 'checked' }>,
    mode: 'scheduled' | 'triggered' = 'scheduled',
  ): Promise<ApplyUpdateOutcome> {
    await this.waitForDrain()
    const lock = tryAcquireUpdateLock(this.lockPath, this.now())
    if (lock.kind === 'held') {
      this.opts.log('Auto-update is being applied by another daemon. Waiting to restart safely.')
      let completedLock: Extract<UpdateLockResult, { kind: 'acquired' }> | null = null
      while (true) {
        await this.delay(UPDATE_DRAIN_POLL_MS)
        const completed = tryAcquireUpdateLock(this.lockPath, this.now())
        if (completed.kind === 'held') continue
        completedLock = completed
        break
      }
      try {
        const installedCommit = await git(this.runner, this.opts.rootDir, ['rev-parse', 'HEAD'])
        if (installedCommit !== inspection.targetCommit) {
          this.opts.log(
            'The shared checkout update did not install the inspected target. This daemon will continue.',
          )
          this.opts.setDrainMode(false)
          return 'skipped-target-mismatch'
        }
        this.recordInstalled(inspection.targetCommit, inspection.latestVersion!)
        if (mode === 'triggered') {
          // The rpc caller owns the restart ladder; report installed, never
          // exit (kc-server invariant).
          this.opts.log('The shared checkout update was completed by another daemon.')
          completedLock.release()
          completedLock = null
          return 'installed'
        }
        this.opts.log('The shared checkout update is complete. Restarting this daemon.')
        this.exiting = true
        completedLock.release()
        completedLock = null
        this.opts.exit(0)
        return 'exited'
      } finally {
        completedLock?.release()
      }
    }
    try {
      const status = await git(this.runner, this.opts.rootDir, [
        'status',
        '--porcelain',
        '--untracked-files=normal',
      ])
      const currentCommit = await git(this.runner, this.opts.rootDir, ['rev-parse', 'HEAD'])
      const action = decideCheckoutAction({
        dirty: porcelainIndicatesDirtyTree(status),
        lockHeld: false,
        currentCommit,
        targetCommit: inspection.targetCommit,
        canFastForward: await canFastForward(
          this.runner,
          this.opts.rootDir,
          inspection.targetCommit,
        ),
      })
      if (action.kind === 'skip') {
        this.opts.log(
          action.reason === 'dirty-tree'
            ? 'Auto-update skipped because the checkout became dirty before the pull.'
            : 'Auto-update skipped because the checkout cannot fast-forward to origin/main.',
        )
        this.opts.setDrainMode(false)
        return action.reason === 'dirty-tree' ? 'skipped-dirty' : 'skipped-not-ff'
      }
      const stateBeforeUpdate = this.state
      const dependencyChanges =
        action.kind === 'pull'
          ? await git(this.runner, this.opts.rootDir, [
              'diff',
              '--name-only',
              currentCommit,
              inspection.targetCommit,
              '--',
              'bun.lock',
              'package.json',
            ])
          : ''
      this.recordInstalled(inspection.targetCommit, inspection.latestVersion!)
      const pendingInstalledState = this.state
      if (action.kind === 'pull') {
        let mergeCompleted = false
        try {
          await git(
            this.runner,
            this.opts.rootDir,
            ['merge', '--ff-only', '--no-edit', inspection.targetCommit],
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
            let previousRecoveryError: unknown = null
            try {
              await git(
                this.runner,
                this.opts.rootDir,
                ['checkout', '--detach', currentCommit],
                120_000,
              )
              if (dependencyChanges.length > 0) {
                await this.runner('bun', ['install', '--frozen-lockfile'], {
                  cwd: this.opts.rootDir,
                  timeoutMs: 120_000,
                })
              }
              if (!saveAutoUpdateState(this.opts.stateFilePath, stateBeforeUpdate)) {
                throw new Error('could not record restored previous update state')
              }
              this.state = stateBeforeUpdate
              this.opts.log(
                'Auto-update failed after the pull. The previous checkout and dependencies were restored.',
              )
            } catch (restoreError) {
              previousRecoveryError = restoreError
            }
            if (previousRecoveryError === null) throw error

            try {
              await git(
                this.runner,
                this.opts.rootDir,
                ['checkout', '--detach', inspection.targetCommit],
                120_000,
              )
              if (dependencyChanges.length > 0) {
                await this.runner('bun', ['install', '--frozen-lockfile'], {
                  cwd: this.opts.rootDir,
                  timeoutMs: 120_000,
                })
              }
              if (!saveAutoUpdateState(this.opts.stateFilePath, pendingInstalledState)) {
                throw new Error('could not preserve target validation state')
              }
              this.state = pendingInstalledState
              if (mode === 'triggered') {
                // The target checkout is on disk; the rpc caller's restart
                // ladder (or the next restart) validates it. Never exit.
                this.opts.log(
                  'Auto-update could not restore the previous revision. The target checkout and dependencies were restored; a restart validates it.',
                )
                lock.release()
                return 'installed'
              }
              this.opts.log(
                'Auto-update could not restore the previous revision. The target checkout and dependencies were restored for supervised validation.',
              )
              this.exiting = true
              lock.release()
              this.opts.exit(0)
              return 'exited'
            } catch (targetRecoveryError) {
              this.state = pendingInstalledState
              const safetySaved = saveSharedUpdateSafety(this.safetyPath, {
                schemaVersion: 1,
                disabled: true,
                resetArmed: false,
              })
              this.exiting = true
              this.opts.log(
                `Auto-update could not restore a coherent previous or target installation. ` +
                  `Message intake remains drained and future checks are stopped. ` +
                  `Previous recovery: ${errorText(previousRecoveryError)}. ` +
                  `Target recovery: ${errorText(targetRecoveryError)}.`,
              )
              this.opts.log(
                safetySaved
                  ? 'Auto-update is disabled for this shared checkout until the flag is reset.'
                  : 'Auto-update could not persist the shared safety latch. This daemon remains drained.',
              )
              return 'failed-latched'
            }
          } else {
            if (!saveAutoUpdateState(this.opts.stateFilePath, stateBeforeUpdate)) {
              this.exiting = true
              const safetySaved = saveSharedUpdateSafety(this.safetyPath, {
                schemaVersion: 1,
                disabled: true,
                resetArmed: false,
              })
              this.opts.log(
                safetySaved
                  ? 'Auto-update failed before the pull and could not restore its state. Future checks are disabled and message intake remains drained.'
                  : 'Auto-update failed before the pull and could not restore its state or shared safety latch. This daemon remains drained.',
              )
              return 'failed-latched'
            }
            this.state = stateBeforeUpdate
          }
          throw error
        }
        this.opts.log(
          `Auto-update installed ${this.opts.runningVersion} to ${inspection.latestVersion}.`,
        )
      } else {
        this.opts.log('Auto-update was already installed by another daemon.')
      }
      if (mode === 'triggered') {
        // The rpc caller decides between a real restart (drain stays on
        // until the process dies) and 'staged' (the caller un-drains). Never
        // exit here, whatever BGOS_EXIT_AFTER_UPDATE says: the ladder is the
        // restart authority for a triggered update.
        lock.release()
        return 'installed'
      }
      // A DAEMON NEVER EXITS UNLESS SOMETHING WILL RESTART IT (kc-server,
      // 2026-08-06). Exiting is opt in; see shouldExitAfterUpdate.
      if (shouldExitAfterUpdate(this.opts.env)) {
        this.opts.log('Auto-update complete. Exiting so the supervisor can restart the daemon.')
        this.exiting = true
        lock.release()
        this.opts.exit(0)
        return 'exited'
      }
      this.opts.log(
        `Auto-update complete. This daemon keeps serving ${this.opts.runningVersion ?? 'its current version'}; ` +
          'the update takes effect when this session restarts.',
      )
      // Un-drain, or the daemon stays up and mute, which is the same outage
      // wearing a healthier-looking process list.
      this.opts.setDrainMode(false)
      lock.release()
      return 'installed'
    } finally {
      lock.release()
    }
  }

  async attemptRollback(): Promise<void> {
    if (!this.state.rollbackPending || !this.state.previousCommit) return
    let lockResult = tryAcquireUpdateLock(this.lockPath, this.now())
    if (lockResult.kind === 'held') {
      this.opts.log('Auto-update rollback is being handled by another daemon. Waiting safely.')
      while (lockResult.kind === 'held') {
        await this.delay(UPDATE_DRAIN_POLL_MS)
        lockResult = tryAcquireUpdateLock(this.lockPath, this.now())
      }
    }
    const lock = lockResult
    try {
      const status = await git(this.runner, this.opts.rootDir, [
        'status',
        '--porcelain',
        '--untracked-files=normal',
      ])
      if (porcelainIndicatesDirtyTree(status)) {
        this.opts.log('Auto-update rollback skipped because the checkout has local changes.')
        return
      }
      await git(this.runner, this.opts.rootDir, [
        'cat-file',
        '-e',
        `${this.state.previousCommit}^{commit}`,
      ])
      const dependencyChanges = this.state.targetCommit
        ? await git(this.runner, this.opts.rootDir, [
            'diff',
            '--name-only',
            this.state.previousCommit,
            this.state.targetCommit,
            '--',
            'bun.lock',
            'package.json',
          ])
        : ''
      if (
        !saveSharedUpdateSafety(this.safetyPath, {
          schemaVersion: 1,
          disabled: true,
          resetArmed: false,
        })
      ) {
        throw new Error('could not arm the shared rollback safety latch before checkout')
      }
      try {
        await git(
          this.runner,
          this.opts.rootDir,
          ['checkout', '--detach', this.state.previousCommit],
          120_000,
        )
        if (dependencyChanges.length > 0) {
          await this.runner('bun', ['install', '--frozen-lockfile'], {
            cwd: this.opts.rootDir,
            timeoutMs: 120_000,
          })
        }
      } catch (rollbackError) {
        try {
          await git(
            this.runner,
            this.opts.rootDir,
            ['checkout', '--detach', this.state.targetCommit!],
            120_000,
          )
          if (dependencyChanges.length > 0) {
            await this.runner('bun', ['install', '--frozen-lockfile'], {
              cwd: this.opts.rootDir,
              timeoutMs: 120_000,
            })
          }
          this.opts.log(
            'Auto-update rollback dependency restore failed. The target checkout was restored.',
          )
        } catch (restoreError) {
          throw new Error(
            `rollback failed and the target checkout could not be restored: ${errorText(restoreError)}`,
          )
        }
        if (!saveSharedUpdateSafety(this.safetyPath, EMPTY_SHARED_UPDATE_SAFETY)) {
          throw new Error(
            `rollback failed after the target checkout was restored, ` +
              `but the shared safety latch could not be cleared: ${errorText(rollbackError)}`,
          )
        }
        throw rollbackError
      }
      const transition = transitionRollbackState(this.state, {
        kind: 'rollback-succeeded',
      })
      this.state = transition.state
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
    if (!saveAutoUpdateState(opts.stateFilePath, state)) {
      opts.log('Auto-update could not record boot safety state; updates stay inactive.')
      return null
    }
    // Announce a pending restart on EVERY boot, not only at install time.
    // A daemon that keeps serving after an update is stale until someone
    // restarts it, and a line logged once at 3 AM is not a signal anyone
    // sees. An installed version is not a running version.
    const pending = describePendingRestart({
      runningVersion: opts.runningVersion,
      installedVersion: state.targetVersion,
    })
    if (pending) opts.log(pending)
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
