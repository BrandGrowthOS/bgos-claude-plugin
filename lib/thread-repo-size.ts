/**
 * Is the agent's repository too large to give a thread its own worktree?
 * (THREADCRASH, 0.87.1)
 *
 * A thread lane gets `git worktree add`, a full checkout of every tracked file.
 * On an agent folder that is a 6.5 GB repository that copied 6.5 GB for one
 * thread, and a checkout that large can outrun the daemon's git timeout. Above
 * THREAD_COPY_LIMIT_BYTES of tracked content, or THREAD_COPY_LIMIT_FILES
 * files, the lane runs READ ONLY instead: no checkout at all, it reads the
 * agent folder where it is (lib/thread-lane-args.ts, readDirs) and says it
 * cannot edit there.
 *
 * The measure is `git ls-files --format=%(objectsize)` streamed and summed
 * off the event loop (git 2.38 and later); it stops as soon as a limit is
 * passed. An older git falls back to `git count-objects -v` (the packed and
 * loose object store, a lower bound of the checkout). A git that answers
 * neither, or a measure that times out, counts as large: when in doubt, copy
 * nothing.
 *
 * Erasable TypeScript only. No em or en dashes in this file.
 */

import { execFile, spawn } from 'node:child_process'

export const THREAD_COPY_LIMIT_BYTES = 1024 * 1024 * 1024
export const THREAD_COPY_LIMIT_FILES = 100_000
export const THREAD_COPY_MEASURE_TIMEOUT_MS = 30_000
/** How long a measure waits for a killed git to close before it answers anyway. */
export const THREAD_COPY_KILL_WAIT_MS = 5_000

export interface CheckoutLimits {
  bytes: number
  files: number
  timeoutMs?: number
}

/** The limits, with a positive integer in HOAI_THREAD_COPY_LIMIT_BYTES (tests, an operator) taking the byte one. */
export function checkoutLimits(env: Record<string, string | undefined>): CheckoutLimits {
  const raw = env.HOAI_THREAD_COPY_LIMIT_BYTES?.trim() ?? ''
  const bytes = /^\d{1,15}$/.test(raw) && Number(raw) > 0 ? Number(raw) : THREAD_COPY_LIMIT_BYTES
  return { bytes, files: THREAD_COPY_LIMIT_FILES }
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

/**
 * Why a worktree of `folder` would copy too much, as a short plain phrase, or
 * null when a worktree is fine.
 */
export async function checkoutTooLarge(folder: string, limits: CheckoutLimits): Promise<string | null> {
  const timeoutMs = limits.timeoutMs ?? THREAD_COPY_MEASURE_TIMEOUT_MS
  const listed = await sumTrackedSizes(folder, limits, timeoutMs)
  if (listed === 'timeout') return 'its size could not be measured in time'
  if (listed) {
    if (listed.bytes > limits.bytes) return `it holds more than ${formatBytes(limits.bytes)} of files`
    if (listed.files > limits.files) return `it holds more than ${limits.files} files`
    return null
  }
  const stored = await objectStoreBytes(folder, timeoutMs)
  if (stored === null) return 'its size could not be measured'
  if (stored > limits.bytes) return `its history alone is ${formatBytes(stored)}`
  return null
}

/** Sum of tracked file sizes, stopping once a limit is passed; null when this git cannot say. */
function sumTrackedSizes(
  folder: string,
  limits: CheckoutLimits,
  timeoutMs: number,
): Promise<{ bytes: number; files: number } | null | 'timeout'> {
  return new Promise((resolve) => {
    let bytes = 0
    let files = 0
    let partial = ''
    let settled = false
    let closed = false
    const finish = (v: { bytes: number; files: number } | null | 'timeout') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill('SIGKILL')
      } catch {}
      // Answer once git has gone: on Windows a folder cannot be removed while a git still runs in it (EPERM).
      // A git that never started has nothing to wait for; one that will not close is waited for a bounded time.
      if (closed || child.pid === undefined) return resolve(v)
      const bound = setTimeout(() => resolve(v), THREAD_COPY_KILL_WAIT_MS)
      child.once('close', () => {
        clearTimeout(bound)
        resolve(v)
      })
    }
    const child = spawn('git', ['-C', folder, 'ls-files', '--format=%(objectsize)'], { cwd: folder, stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    child.on('error', () => finish(null))
    child.stdout.setEncoding('utf8')
    child.stdout.on('error', () => finish(null))
    child.stdout.on('data', (chunk: string) => {
      const lines = (partial + chunk).split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) {
        const n = Number(line.trim())
        if (!Number.isFinite(n)) continue
        bytes += n
        files++
      }
      // Past a limit already: the rest does not change the answer.
      if (bytes > limits.bytes || files > limits.files) finish({ bytes, files })
    })
    child.on('close', (code) => {
      closed = true
      const n = Number(partial.trim())
      if (partial.trim() !== '' && Number.isFinite(n)) {
        bytes += n
        files++
      }
      finish(code === 0 ? { bytes, files } : null)
    })
  })
}

/** Packed plus loose object bytes (`git count-objects -v`, in KiB), or null. */
function objectStoreBytes(folder: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', folder, 'count-objects', '-v'], { cwd: folder, timeout: timeoutMs, maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (err) return resolve(null)
      const kib = (key: string) => Number(new RegExp(`^${key}: (\\d+)$`, 'm').exec(String(stdout))?.[1] ?? NaN)
      const total = kib('size') + kib('size-pack')
      resolve(Number.isFinite(total) ? total * 1024 : null)
    })
  })
}
