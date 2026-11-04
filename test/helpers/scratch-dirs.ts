/**
 * Scratch folders for tests, kept under the OS temp folder and removed when the test process ends
 * (board row c1ddf80c).
 *
 * `mkdtempSync(join(tmpdir(), 'x-'))` with no matching remove left a folder in the machine's temp folder on
 * every run, pass or fail: about 540 names per full run, most of them from nine test files. A test file
 * that makes its folders here instead gets them all removed on the way out, whether its tests passed,
 * threw, timed out into a failure or called process.exit. The sweep is synchronous. It hangs off the
 * process's `exit` event under node:test (one process per file) and off bun's afterAll hooks under bun:test
 * (one process for the whole run, which never emits `exit`), so one helper serves both families.
 *
 * A test that wants a folder gone sooner (a long file, a big tree) calls removeScratchDir itself.
 *
 * Two limits. A process killed by a signal (a CI timeout, ctrl-c) never reaches its `exit` event, so what it
 * made stays. And under bun:test call scratchDir inside a test, a hook or a helper they call, not at
 * collection time in a describe body: a describe-level folder is swept by the first describe's afterAll,
 * before a later describe's tests use it.
 *
 * The sweep never throws and never follows a link: fs.rm unlinks a symlink or a junction and leaves what
 * it points at alone. A folder another process still holds open (Windows) is retried briefly and then left.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

const made = new Set<string>()
let sweepArmed = false

function sweepAll(): void {
  stepOutOfScratchDirs()
  for (const dir of made) removeQuietly(dir)
  made.clear()
}

// bun:test runs every file of a run in one process and never emits `exit` or `beforeExit`, but it does run
// afterAll hooks, each after the file that registered it. So under bun the first folder made after a sweep
// registers the next sweep (see scratchDir), which gives every file its own. Under node:test (one process
// per file) and plain scripts the `exit` sweep is the one that fires.
let registerBunSweep: ((sweep: () => void) => void) | null = null
if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
  try {
    registerBunSweep = (await import('bun:test')).afterAll
  } catch {
    // Not inside `bun test` (a plain `bun script.ts`): that process does emit `exit`.
  }
}

function removeQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Left behind on purpose: an exit handler must not turn a finished run into a crash.
  }
}

/** A test that chdir'd into its scratch folder would keep Windows from removing it; leave the folder first. */
function stepOutOfScratchDirs(): void {
  try {
    const cwd = process.cwd() // the physical path, so compare with the folder's physical path as well as the one it was made under
    for (const dir of made) {
      const names = [dir]
      try {
        names.push(realpathSync(dir))
      } catch {
        // Already removed: it can only match by the name it was made under.
      }
      if (names.some((name) => cwd === name || cwd.startsWith(name + sep))) {
        process.chdir(tmpdir())
        return
      }
    }
  } catch {
    // No readable cwd (already removed): nothing to step out of.
  }
}

/** A fresh folder under the OS temp folder, removed when this process ends. Wrap it in realpathSync where a test needs the physical path. */
export function scratchDir(prefix: string): string {
  if (!sweepArmed) {
    sweepArmed = true
    process.on('exit', sweepAll)
  }
  if (made.size === 0 && registerBunSweep) {
    try {
      registerBunSweep(sweepAll)
    } catch {
      // bun refused the hook (no test file is running): the `exit` sweep still covers a plain script.
    }
  }
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.add(dir)
  return dir
}

/** Removes one scratch folder now. Safe to call twice, or for a folder the test already removed. */
export function removeScratchDir(dir: string): void {
  removeQuietly(dir)
  made.delete(dir)
}
