/**
 * A browser that failed to start can always be stopped, and the stop always finishes (board row
 * 717860f8).
 *
 * On Windows a Chrome that is killed keeps its runtime folder (the hoai-browser-runtime-* user
 * data dir) for under a second: the folder stays locked until the browser process and its helpers
 * have exited. launchChromium's start timeout killed Chrome and rejected at once, and the
 * ChromiumEngine.stop() that followed threw EPERM from removing that folder. The caller's cleanup
 * after the stop never ran (found by #242's test hooks: servers, ports and folders left behind),
 * and in the pool a throwing stop marks the slot as never safely closed, so it refuses every later
 * browser start until the host restarts.
 *
 * The fake Chrome here behaves as the real one does on Windows: its folder is busy (EPERM) while
 * it runs, and for a moment after it exits. Nothing real is spawned and nothing is killed.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { BROWSER_KILL_WAIT_MS, ChromiumEngine, RUNTIME_DIR_RETRY_MS, launchChromium } from '../bin/hoai-browser-host.mjs'

/** A Chrome that never reports its endpoint, exits `exitAfterKillMs` after a kill, and holds its folder `holdAfterExitMs` after that (null: never). */
function fakeChrome({ exitAfterKillMs = 150 as number | null, holdAfterExitMs = 150 as number | null } = {}) {
  const events: string[] = []
  const child: any = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), pid: 4242, exitCode: null, signalCode: null, held: true, events })
  child.kill = (signal: string) => {
    events.push(`kill ${signal}`)
    if (exitAfterKillMs !== null && !child.exiting) {
      child.exiting = true
      setTimeout(() => {
        child.signalCode = signal
        events.push('exit')
        child.emit('exit', null, signal)
        if (holdAfterExitMs !== null) setTimeout(() => { child.held = false }, holdAfterExitMs)
      }, exitAfterKillMs)
    }
    return true
  }
  return child
}

/** rmSync, refused with EPERM while the fake Chrome still holds the folder, as Windows refuses it. */
function removeDirHeldBy(child: any, calls: string[] = []) {
  return (dir: string) => {
    calls.push(dir)
    if (child.held) throw Object.assign(new Error(`EPERM: operation not permitted, rmdir '${dir}'`), { code: 'EPERM', errno: -4048, syscall: 'rmdir', path: dir })
    rmSync(dir, { recursive: true, force: true })
  }
}

function engineFor(t: any, child: any, { platform = 'win32', removeDir, log }: { platform?: string; removeDir?: (dir: string) => void; log?: (line: string) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'chromestop-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new ChromiumEngine({
    executable: '/fake/chrome',
    profileDir: join(root, 'profile'),
    outputDir: join(root, 'output'),
    launch: (opts: any) => launchChromium({ ...opts, timeoutMs: 100, spawnImpl: (() => child) as any, env: {} }),
    platform,
    removeDir: removeDir ?? removeDirHeldBy(child),
    log: log ?? (() => {}),
  } as any) as any
}

test('win32: a start that timed out rejects only once the Chrome it killed has exited', async () => {
  const child = fakeChrome({ exitAfterKillMs: 200 })
  await launchChromium({ executable: '/fake/chrome', profileDir: '/fake/profile', timeoutMs: 50, spawnImpl: (() => child) as any, platform: 'win32', env: {} })
    .then(() => assert.fail('a Chrome that never reported its endpoint cannot start'), (err: any) => {
      child.events.push(`rejected ${err.code}`)
    })
  assert.deepEqual(child.events, ['kill SIGKILL', 'exit', 'rejected browser_start_failed'], 'the folder Chrome holds is only free once it has exited')
})

test('win32: a killed Chrome that never exits still lets the start fail, after a bounded wait', async () => {
  const child = fakeChrome({ exitAfterKillMs: null })
  const began = Date.now()
  await assert.rejects(
    launchChromium({ executable: '/fake/chrome', profileDir: '/fake/profile', timeoutMs: 50, spawnImpl: (() => child) as any, platform: 'win32', env: {} }),
    { code: 'browser_start_failed' },
  )
  const waited = Date.now() - began - 50
  assert.ok(waited >= BROWSER_KILL_WAIT_MS - 100, `waited for the exit (${waited} ms)`)
  assert.ok(waited < BROWSER_KILL_WAIT_MS + 1_500, `and no longer than its bound (${waited} ms)`)
})

test('linux and macOS are unchanged: a start that timed out rejects as it kills', async () => {
  for (const platform of ['linux', 'darwin'] as const) {
    const child = fakeChrome({ exitAfterKillMs: 200 })
    await launchChromium({ executable: '/fake/chrome', profileDir: '/fake/profile', timeoutMs: 50, spawnImpl: (() => child) as any, platform, env: {} })
      .catch((err: any) => { child.events.push(`rejected ${err.code}`) })
    assert.deepEqual(child.events, ['kill SIGKILL', 'rejected browser_start_failed'], platform)
  }
})

test('win32: stop() after a start timeout does not throw, removes the runtime folder, and the cleanup after it runs', async (t) => {
  const child = fakeChrome({ exitAfterKillMs: 150, holdAfterExitMs: 300 })
  const lines: string[] = []
  const engine = engineFor(t, child, { log: (l) => lines.push(l) })
  await assert.rejects(engine.start(), { code: 'browser_start_failed' })
  const runtimeDir = engine._runtimeDir
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }))
  assert.ok(runtimeDir && existsSync(runtimeDir), 'the failed start left its runtime folder for the stop')
  await engine.stop() // resolving is the point: the caller's cleanup after it runs
  assert.equal(existsSync(runtimeDir), false, 'the folder was removed once Chrome let go of it')
  assert.equal(engine._runtimeDir, null)
  assert.deepEqual(lines.filter((l) => /runtime folder/.test(l)), [], 'a folder that freed up in time is not reported')
})

test('win32: a runtime folder still busy after the retry is logged and left, never thrown, and the next start removes it', async (t) => {
  const child = fakeChrome({ exitAfterKillMs: 50, holdAfterExitMs: null })
  const lines: string[] = []
  const calls: string[] = []
  const engine = engineFor(t, child, { removeDir: removeDirHeldBy(child, calls), log: (l) => lines.push(l) })
  await assert.rejects(engine.start(), { code: 'browser_start_failed' })
  const runtimeDir = engine._runtimeDir
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }))
  const began = Date.now()
  await engine.stop()
  const retried = Date.now() - began
  assert.ok(retried >= RUNTIME_DIR_RETRY_MS - 300, `the removal was retried for its whole window (${retried} ms)`)
  assert.ok(retried < 5_000, `and the retry is short and bounded (${retried} ms)`)
  assert.equal(engine._runtimeDir, null)
  assert.ok(calls.length > 1, `the removal was retried (${calls.length} attempts)`)
  assert.equal(existsSync(runtimeDir), true, 'the busy folder is left in place')
  assert.ok(lines.some((l) => l.includes(runtimeDir) && /EPERM/.test(l) && /next/.test(l)), `logged: ${lines.join(' | ')}`)

  // Chrome has let go; the next browser start clears what the last stop left.
  child.held = false
  const next = fakeChrome({ exitAfterKillMs: 10, holdAfterExitMs: 0 })
  const nextEngine = engineFor(t, next, { removeDir: (dir) => rmSync(dir, { recursive: true, force: true }) })
  await assert.rejects(nextEngine.start(), { code: 'browser_start_failed' })
  assert.equal(existsSync(runtimeDir), false, 'the next start removed the folder the last stop left')
  await nextEngine.stop()
})

test('a stop on a clean exit is unchanged: one removal, at once, nothing logged', async (t) => {
  const child = fakeChrome()
  child.held = false
  child.exitCode = 0
  const lines: string[] = []
  const calls: string[] = []
  const engine = engineFor(t, child, { removeDir: removeDirHeldBy(child, calls), log: (l) => lines.push(l) })
  const runtimeDir = mkdtempSync(join(tmpdir(), 'hoai-browser-runtime-'))
  engine._runtimeDir = runtimeDir
  engine._child = child
  const began = Date.now()
  await engine.stop()
  assert.ok(Date.now() - began < 500, 'no wait')
  assert.deepEqual(calls, [runtimeDir])
  assert.deepEqual(child.events, [], 'a Chrome that already exited is not signalled')
  assert.equal(existsSync(runtimeDir), false)
  assert.deepEqual(lines, [])
})

test('linux and macOS are unchanged: a folder the stop cannot remove still fails the stop', async (t) => {
  for (const platform of ['linux', 'darwin']) {
    const child = fakeChrome()
    child.exitCode = 0
    const engine = engineFor(t, child, { platform })
    const runtimeDir = mkdtempSync(join(tmpdir(), 'hoai-browser-runtime-'))
    t.after(() => rmSync(runtimeDir, { recursive: true, force: true }))
    engine._runtimeDir = runtimeDir
    engine._child = child
    await assert.rejects(engine.stop(), { code: 'EPERM' }, platform)
    assert.equal(engine._runtimeDir, runtimeDir, 'and the folder is still recorded, as before')
  }
})
