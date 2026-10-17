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
 *
 * Two leaks of those folders (board row 5e811669): the pool never stops an engine whose start
 * failed, so the start itself must remove its folder; and a folder still busy after a stop's retry
 * outlived the host's final stop, since only a next browser start in the same process removed it.
 * A host start now sweeps its own TEMP for folders no live host owns. The owner is in the folder's
 * name (its host's pid and that process's start time), so a removal that took everything else in
 * the folder never loses it. The sweep cases run on scratch TEMP folders of their own; the end to
 * end case starts the real host with TEMP pointed at one.
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as host from '../bin/hoai-browser-host.mjs'
import { BROWSER_KILL_WAIT_MS, ChromiumEngine, RUNTIME_DIR_RETRY_MS, STOP_ON_STDIN_EOF_ENV, launchChromium } from '../bin/hoai-browser-host.mjs'

// The sweep's exports are read through the namespace, so on a build without them only the tests that need them fail.
const H: any = host
const HOST_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'hoai-browser-host.mjs')
const HOUR_MS = 60 * 60_000

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

/**
 * The temp root the tests make their folders under, resolved. macOS TMPDIR sits under the /var -> /private/var
 * link, and the vault refuses a profile folder with a link above it (unsafe_profile); the profile folders here
 * stand in for the agent's, which lives under the home folder, never in TEMP.
 */
const realTmp = () => realpathSync(tmpdir())

function engineFor(t: any, child: any, { platform = 'win32', removeDir, log, launched = [] }: { platform?: string; removeDir?: (dir: string) => void; log?: (line: string) => void; launched?: string[] } = {}) {
  const root = mkdtempSync(join(realTmp(), 'chromestop-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new ChromiumEngine({
    executable: '/fake/chrome',
    profileDir: join(root, 'profile'),
    outputDir: join(root, 'output'),
    launch: (opts: any) => {
      launched.push(opts.profileDir)
      return launchChromium({ ...opts, timeoutMs: 100, spawnImpl: (() => child) as any, env: {} })
    },
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

test('linux and macOS too: a start that timed out rejects only once the Chrome it killed has exited', async () => {
  // Until then Chrome's SingletonLock names a live pid, and the start's own cleanup leaves a folder that is in use.
  for (const platform of ['linux', 'darwin'] as const) {
    const child = fakeChrome({ exitAfterKillMs: 200 })
    await launchChromium({ executable: '/fake/chrome', profileDir: '/fake/profile', timeoutMs: 50, spawnImpl: (() => child) as any, platform, env: {} })
      .catch((err: any) => { child.events.push(`rejected ${err.code}`) })
    assert.deepEqual(child.events, ['kill SIGKILL', 'exit', 'rejected browser_start_failed'], platform)
  }
})

test('win32: a start that timed out removes its own runtime folder once Chrome let go, and a stop after it still resolves', async (t) => {
  const child = fakeChrome({ exitAfterKillMs: 150, holdAfterExitMs: 300 })
  const lines: string[] = []
  const launched: string[] = []
  const engine = engineFor(t, child, { log: (l) => lines.push(l), launched })
  await assert.rejects(engine.start(), { code: 'browser_start_failed' })
  const [runtimeDir] = launched
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }))
  assert.ok(runtimeDir, 'the start made a runtime folder')
  // The pool never stops an engine whose start failed (BrowserPool.acquire): the start cleans up after itself.
  assert.equal(existsSync(runtimeDir), false, 'the failed start removed its own folder once Chrome let go of it')
  assert.equal(engine._runtimeDir, null)
  await engine.stop() // resolving is the point: a direct caller's cleanup after it runs
  assert.deepEqual(lines.filter((l) => /runtime folder/.test(l)), [], 'a folder that freed up in time is not reported')
})

test('a start that failed leaves no runtime folder, on every platform', async (t) => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const child = fakeChrome({ exitAfterKillMs: 20, holdAfterExitMs: 0 })
    const launched: string[] = []
    const engine = engineFor(t, child, { platform, launched, removeDir: platform === 'win32' ? undefined : (dir) => rmSync(dir, { recursive: true, force: true }) })
    await assert.rejects(engine.start(), { code: 'browser_start_failed' }, platform)
    assert.equal(launched.length, 1, platform)
    assert.equal(existsSync(launched[0]), false, `${platform}: the folder of the failed start is gone`)
    assert.equal(engine._runtimeDir, null, platform)
  }
})

test('linux and macOS: a start that timed out removes its folder once the Chrome it killed has exited and let go of its lock', async (t) => {
  for (const platform of ['linux', 'darwin']) {
    const child = fakeChrome({ exitAfterKillMs: 30, holdAfterExitMs: 0 })
    const launched: string[] = []
    const lines: string[] = []
    const engine = engineFor(t, child, { platform, launched, log: (l) => lines.push(l), removeDir: (dir) => rmSync(dir, { recursive: true, force: true }) })
    // As runtimeDirBusy reads a real Chrome's SingletonLock: in use while that Chrome's pid lives.
    engine._runtimeBusy = () => (child.signalCode === null && child.exitCode === null ? 'SingletonLock' : null)
    await assert.rejects(engine.start(), { code: 'browser_start_failed' }, platform)
    assert.equal(existsSync(launched[0]), false, `${platform}: the folder is gone (${lines.join(' | ')})`)
  }
})

test('a start whose browser connection failed after Chrome reported its endpoint removes its folder too', async (t) => {
  const child = fakeChrome()
  child.held = false
  const launched: string[] = []
  const engine = engineFor(t, child, { launched })
  engine._launch = async (opts: any) => {
    launched.push(opts.profileDir)
    child.exitCode = 0 // the Chrome is gone by the time the start cleans up
    return { child, endpoint: 'ws://127.0.0.1:1/devtools/browser/fake' }
  }
  let stopped = 0
  engine._newEngine = () => ({ start: async () => { throw Object.assign(new Error('connect failed'), { code: 'browser_start_failed' }) }, stop: async () => { stopped++ } })
  await assert.rejects(engine.start(), { code: 'browser_start_failed', message: 'connect failed' })
  assert.equal(stopped, 1)
  assert.equal(existsSync(launched[0]), false, 'the folder of the failed start is gone')
  assert.equal(engine._runtimeDir, null)
})

test('a start whose Chrome did not exit leaves its folder whole and forgets it, so no later stop removes it', async (t) => {
  const child = fakeChrome()
  child.held = false
  const launched: string[] = []
  const lines: string[] = []
  const calls: string[] = []
  const engine = engineFor(t, child, { launched, log: (l) => lines.push(l), removeDir: removeDirHeldBy(child, calls) })
  engine._launch = async (opts: any) => {
    launched.push(opts.profileDir)
    return { child, endpoint: 'ws://127.0.0.1:1/devtools/browser/fake' }
  }
  engine._newEngine = () => ({ start: async () => { throw Object.assign(new Error('connect failed'), { code: 'browser_start_failed' }) }, stop: async () => {} })
  // _killChild gives up on a Chrome that outlived SIGKILL; a second call finds no child, as the real one does.
  let kills = 0
  engine._killChild = async () => { if (kills++ === 0) throw Object.assign(new Error('The browser process did not finish closing safely.'), { code: 'browser_stop_failed' }) }
  await assert.rejects(engine.start(), { code: 'browser_stop_failed' })
  const [runtimeDir] = launched
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }))
  assert.equal(existsSync(join(runtimeDir)), true, 'the folder of a Chrome that may still run is left')
  assert.deepEqual(calls, [], 'not even partly removed')
  assert.equal(engine._runtimeDir, null)
  assert.ok(lines.some((l) => l.includes(runtimeDir) && /did not exit/.test(l)), `logged: ${lines.join(' | ')}`)
  await engine.stop()
  assert.deepEqual(calls, [], 'a stop after it does not remove it either')
})

test('a start that failed while a Chrome still runs in its folder leaves the folder whole, for the next host start', async (t) => {
  const child = fakeChrome()
  const launched: string[] = []
  const lines: string[] = []
  const calls: string[] = []
  const engine = engineFor(t, child, { launched, log: (l) => lines.push(l), removeDir: removeDirHeldBy(child, calls) })
  // launchChromium's wait for the Chrome it killed is bounded: a Chrome past it still holds its lockfile (EBUSY).
  engine._launch = async (opts: any) => {
    launched.push(opts.profileDir)
    throw Object.assign(new Error('Chrome did not report its DevTools endpoint'), { code: 'browser_start_failed' })
  }
  const asked: string[] = []
  engine._runtimeBusy = (dir: string) => { asked.push(dir); return 'EBUSY' }
  await assert.rejects(engine.start(), { code: 'browser_start_failed' })
  const [runtimeDir] = launched
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }))
  assert.deepEqual(asked, [runtimeDir])
  assert.deepEqual(calls, [], 'a folder a Chrome still runs in is not even partly removed')
  assert.equal(existsSync(runtimeDir), true)
  assert.equal(engine._runtimeDir, null)
  assert.ok(lines.some((l) => l.includes(runtimeDir) && /in use \(EBUSY\)/.test(l)), `logged: ${lines.join(' | ')}`)
})

test('win32: a runtime folder still busy after the retry is logged and left, never thrown, and the next start removes it', async (t) => {
  const child = fakeChrome({ exitAfterKillMs: 50, holdAfterExitMs: null })
  const lines: string[] = []
  const calls: string[] = []
  const launched: string[] = []
  const engine = engineFor(t, child, { removeDir: removeDirHeldBy(child, calls), log: (l) => lines.push(l), launched })
  const began = Date.now()
  // The start's own error reaches the caller, never the folder's EPERM.
  await assert.rejects(engine.start(), { code: 'browser_start_failed' })
  const retried = Date.now() - began
  const [runtimeDir] = launched
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }))
  assert.ok(retried >= RUNTIME_DIR_RETRY_MS - 300, `the removal was retried for its whole window (${retried} ms)`)
  assert.ok(retried < 6_000, `and the retry is short and bounded (${retried} ms)`)
  assert.equal(engine._runtimeDir, null)
  assert.ok(calls.length > 1, `the removal was retried (${calls.length} attempts)`)
  assert.equal(existsSync(runtimeDir), true, 'the busy folder is left in place')
  assert.ok(lines.some((l) => l.includes(runtimeDir) && /EPERM/.test(l) && /next/.test(l)), `logged: ${lines.join(' | ')}`)
  await engine.stop() // nothing is left for the stop to remove, and it resolves

  // Chrome has let go; the next browser start clears what the failed one left.
  child.held = false
  const next = fakeChrome({ exitAfterKillMs: 10, holdAfterExitMs: 0 })
  const nextEngine = engineFor(t, next, { removeDir: (dir) => rmSync(dir, { recursive: true, force: true }) })
  await assert.rejects(nextEngine.start(), { code: 'browser_start_failed' })
  assert.equal(existsSync(runtimeDir), false, 'the next start removed the folder the failed one left')
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

// ── The sweep at host start: folders no live host owns ───────────────────────

/** A scratch folder that stands in for the host's TEMP: the sweep never runs on the real one here. */
function scratchTemp(t: any, label = 'rtsweep-') {
  const dir = mkdtempSync(join(realTmp(), label))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A runtime folder as Chrome leaves one: files at the top and a profile folder below. */
function runtimeFolder(tmp: string, name: string) {
  const dir = join(tmp, name)
  mkdirSync(join(dir, 'Default'), { recursive: true })
  writeFileSync(join(dir, 'Local State'), '{}')
  writeFileSync(join(dir, 'Default', 'Cookies'), 'c')
  return dir
}

/** A folder last touched this long ago, as one is whose host and Chrome are long gone. */
function quiet<T extends string>(dir: T, agoMs = 2 * HOUR_MS): T {
  const at = (Date.now() - agoMs) / 1000
  utimesSync(dir, at, at)
  return dir
}

const ownedBy = (pid: number, startedAtMs: number, suffix = 'Ab12Cd') => `${H.runtimeDirPrefix({ pid, startedAtMs })}${suffix}`

/** The pid of a process that ran and has exited: an owner that is gone. */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
  assert.equal(r.status, 0)
  assert.ok(r.pid && !H.pidAlive(r.pid), 'the process has exited')
  return r.pid as number
}

/** A live process this test started (and stops), with its start time as its host would record it. */
async function liveProcess(t: any) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  await new Promise((r) => child.once('spawn', r))
  return { pid: child.pid as number, startedAtMs: H.startStampNow() as number }
}

function sweep(tmp: string, opts: Record<string, unknown> = {}): Promise<{ swept: string[]; left: string[]; lines: string[] }> {
  const lines: string[] = []
  return H.sweepRuntimeFolders({ tmp, log: (l: string) => lines.push(l), ...opts }).then((r: { swept: string[]; left: string[] }) => ({ ...r, lines }))
}

test('the runtime folder is named after its host: pid and start time, read back from the name alone', () => {
  const prefix = H.runtimeDirPrefix({ pid: 4242, startedAtMs: 1_760_000_000_123 })
  assert.match(prefix, /^hoai-browser-runtime-/)
  assert.deepEqual(H.runtimeDirOwner(`${prefix}Ab12Cd`), { pid: 4242, startedAtMs: 1_760_000_000_123 })
  assert.equal(H.runtimeDirOwner('hoai-browser-runtime-Ab12Cd'), null, 'a folder of a host before this one names no owner')
  assert.equal(H.runtimeDirOwner(`${prefix}Ab12Cd-x`), null)
  assert.deepEqual(H.runtimeDirOwner(`${H.runtimeDirPrefix()}Ab12Cd`), { pid: process.pid, startedAtMs: H.HOST_STARTED_AT_MS }, 'by default: this process')
})

test('a browser start makes its runtime folder under its host\'s name', async (t) => {
  const child = fakeChrome({ exitAfterKillMs: 10, holdAfterExitMs: 0 })
  const launched: string[] = []
  const engine = engineFor(t, child, { launched })
  await assert.rejects(engine.start(), { code: 'browser_start_failed' })
  assert.equal(dirname(launched[0]), tmpdir())
  assert.deepEqual(H.runtimeDirOwner(launched[0].slice(tmpdir().length + 1)), { pid: process.pid, startedAtMs: H.HOST_STARTED_AT_MS })
})

test('a TEMP reached through a link (macOS /var -> /private/var) still gets the runtime folder: only the profile under the home folder is link-checked', async (t) => {
  const real = scratchTemp(t)
  const holder = scratchTemp(t, 'rtlink-')
  const link = join(holder, 'tmp-link')
  symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
  // Unlink only: the link is removed, never its target (the scratch folder above goes with its own after-hook).
  t.after(() => unlinkSync(link))
  const keys = process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR']
  const saved = keys.map((k) => [k, process.env[k]] as const)
  t.after(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })
  for (const k of keys) process.env[k] = link
  assert.equal(tmpdir(), link, 'the host\'s temp root is the link itself, unresolved')
  const child = fakeChrome({ exitAfterKillMs: 10, holdAfterExitMs: 0 })
  const launched: string[] = []
  const lines: string[] = []
  const engine = engineFor(t, child, { launched, log: (l) => lines.push(l) })
  // A refused folder would reject with unsafe_profile before Chrome is ever launched.
  await assert.rejects(engine.start(), { code: 'browser_start_failed' })
  assert.equal(launched.length, 1, `Chrome was launched: ${lines.join(' | ')}`)
  assert.equal(dirname(launched[0]), link, 'the runtime folder is made under the temp root as given')
  assert.equal(existsSync(launched[0]), false, 'and the failed start removed it')
})

test('host start: a folder whose host is gone is removed, and the removal is logged', async (t) => {
  const tmp = scratchTemp(t)
  const name = ownedBy(deadPid(), Date.now() - HOUR_MS)
  const dir = quiet(runtimeFolder(tmp, name))
  const { swept, lines } = await sweep(tmp)
  assert.equal(existsSync(dir), false, 'the dead host\'s folder is gone')
  assert.deepEqual(swept, [dir])
  assert.ok(lines.some((l) => l.includes(dir) && /removed/.test(l)), `logged: ${lines.join(' | ')}`)
})

test('host start: a dead host\'s folder is kept while recent, on every platform: a Chrome it spawned may still be starting', async (t) => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const tmp = scratchTemp(t)
    // The host crashed after making its folder and before its Chrome took the lockfile (or SingletonLock): the
    // busy check finds nothing, and the Chrome the host spawned can outlive it.
    const dir = runtimeFolder(tmp, ownedBy(deadPid(), Date.now() - HOUR_MS))
    let removed = 0
    const { swept, left, lines } = await sweep(tmp, { platform, busy: () => null, removeDir: () => { removed++ } })
    assert.deepEqual(swept, [], platform)
    assert.deepEqual(left, [], `${platform}: kept, not even looked at as in use`)
    assert.equal(removed, 0, platform)
    assert.equal(existsSync(join(dir, 'Default', 'Cookies')), true, `${platform}: a dead host's fresh folder is whole`)
    assert.ok(lines.some((l) => /1 kept/.test(l)), `${platform}: counted as kept: ${lines.join(' | ')}`)
  }
})

test('host start: a dead host\'s folder is removed once quiet for RUNTIME_DIR_REUSE_QUIET_MS, and not a minute before', async (t) => {
  assert.equal(H.RUNTIME_DIR_REUSE_QUIET_MS, 10 * 60_000)
  for (const platform of ['win32', 'linux', 'darwin']) {
    const tmp = scratchTemp(t)
    const gone = deadPid()
    const nearly = quiet(runtimeFolder(tmp, ownedBy(gone, Date.now() - HOUR_MS, 'Near01')), H.RUNTIME_DIR_REUSE_QUIET_MS - 60_000)
    const past = quiet(runtimeFolder(tmp, ownedBy(gone, Date.now() - HOUR_MS, 'Past01')), H.RUNTIME_DIR_REUSE_QUIET_MS + 60_000)
    const { swept, lines } = await sweep(tmp, { platform, busy: () => null })
    assert.deepEqual(swept, [past], platform)
    assert.equal(existsSync(past), false, platform)
    assert.equal(existsSync(nearly), true, `${platform}: nine minutes is not quiet`)
    assert.ok(lines.some((l) => l.includes(past) && /host \(pid \d+\) is gone/.test(l)), `${platform}: logged: ${lines.join(' | ')}`)
  }
})

test('host start: a dead host\'s quiet folder with a Chrome in it is still left whole (the busy check is unchanged)', async (t) => {
  const tmp = scratchTemp(t)
  const dir = quiet(runtimeFolder(tmp, ownedBy(deadPid(), Date.now() - HOUR_MS)), 24 * HOUR_MS)
  let removed = 0
  const { swept, left } = await sweep(tmp, { platform: 'linux', busy: () => 'SingletonLock', removeDir: () => { removed++ } })
  assert.deepEqual(swept, [])
  assert.deepEqual(left, [dir])
  assert.equal(removed, 0)
})

test('host start: a folder whose host still runs is kept, read from the real process table', async (t) => {
  const tmp = scratchTemp(t)
  const owner = await liveProcess(t)
  const dir = runtimeFolder(tmp, ownedBy(owner.pid, owner.startedAtMs))
  const { swept } = await sweep(tmp)
  assert.deepEqual(swept, [])
  assert.equal(existsSync(join(dir, 'Default', 'Cookies')), true, 'a live host\'s folder is never touched')
})

test('host start: a pid now held by a process that started after the folder\'s host is not its owner', async (t) => {
  const tmp = scratchTemp(t)
  // The recorded host started hours before the process that holds its pid now: a reused pid.
  const holder = await liveProcess(t)
  if (typeof (await H.processStartsOf([holder.pid])).get(holder.pid)?.startedAtMs !== 'number') {
    t.skip('the process table cannot be read here (a stand-in for ps or powershell): the sweep then keeps the folder')
    return
  }
  const recorded = holder.startedAtMs - H.RUNTIME_DIR_OWNER_SLACK_MS - 60_000
  if (recorded < 0) {
    t.skip('this Linux machine booted too recently for a start that long before the holder')
    return
  }
  const dir = quiet(runtimeFolder(tmp, ownedBy(holder.pid, recorded)))
  const { swept } = await sweep(tmp)
  assert.deepEqual(swept, [dir], 'the real process table proves the recorded host gone')
  assert.equal(existsSync(dir), false)
})

test('host start: an owner whose pid lives but whose start cannot be read is kept', async (t) => {
  const tmp = scratchTemp(t)
  const dir = runtimeFolder(tmp, ownedBy(4242, Date.now() - HOUR_MS))
  let asked: number[] = []
  const { swept } = await sweep(tmp, { alive: () => true, processStarts: async (pids: number[]) => { asked = pids; return new Map() } })
  assert.deepEqual(asked, [4242])
  assert.deepEqual(swept, [])
  assert.equal(existsSync(dir), true)
})

test('host start: a holder that started within the slack after the recorded start is the owner; one past it is not', async (t) => {
  const tmp = scratchTemp(t)
  const recorded = Date.now() - HOUR_MS
  const owner = runtimeFolder(tmp, ownedBy(4242, recorded))
  const reused = quiet(runtimeFolder(tmp, ownedBy(4243, recorded)))
  const starts = new Map([[4242, { startedAtMs: recorded + 30_000 }], [4243, { startedAtMs: recorded + H.RUNTIME_DIR_OWNER_SLACK_MS + 1_000 }]])
  const { swept } = await sweep(tmp, { platform: 'win32', alive: () => true, processStarts: async () => starts, busy: () => null })
  assert.deepEqual(swept, [reused])
  assert.equal(existsSync(owner), true, 'a start read to the second, a little after the host recorded its own, is still its host')
})

test('linux: the owner is checked on the boot clock, so a step of the wall clock never makes a live host look gone', async (t) => {
  const tmp = scratchTemp(t)
  const recorded = 5 * HOUR_MS // ms since boot, as a Linux host records its start (startStampNow)
  const stepped = runtimeFolder(tmp, ownedBy(4244, recorded, 'Step01'))
  const reused = quiet(runtimeFolder(tmp, ownedBy(4245, recorded, 'Reus01')))
  const unknown = runtimeFolder(tmp, ownedBy(4246, recorded, 'Unkn01'))
  const starts = new Map<number, any>([
    // The wall clock was stepped forward after the host started: on it, the host seems to start much later.
    [4244, { startedAtMs: Date.now(), boot: { id: 'b', startedUptimeMs: recorded - 1_000 } }],
    [4245, { startedAtMs: 0, boot: { id: 'b', startedUptimeMs: recorded + H.RUNTIME_DIR_OWNER_SLACK_MS + 1_000 } }],
    [4246, { startedAtMs: recorded + 10 * HOUR_MS }],
  ])
  const { swept } = await sweep(tmp, { platform: 'linux', alive: () => true, processStarts: async () => starts, busy: () => null })
  assert.deepEqual(swept, [reused])
  assert.equal(existsSync(stepped), true, 'a live host after a wall clock step')
  assert.equal(existsSync(unknown), true, 'no boot clock reading proves nothing on Linux')
})

/**
 * Windows dates a process's start through CIM in local time, so a host started in the repeated hour
 * when daylight saving ends can read an hour later than it recorded: a live host that looks like a
 * reused pid. The time comparison alone never removes its folder.
 */
function dstShifted(recorded: number) {
  return async () => new Map([[4250, { startedAtMs: recorded + HOUR_MS + 2_000 }]])
}

test('win32 DST: a live host whose start reads an hour late keeps its folder while its Chrome holds the lockfile', async (t) => {
  const tmp = scratchTemp(t)
  const recorded = Date.now() - 3 * HOUR_MS
  // Chrome has run in it for hours: nothing new at its top, and its lockfile held.
  const dir = runtimeFolder(tmp, ownedBy(4250, recorded, 'Dst001'))
  writeFileSync(join(dir, 'lockfile'), '')
  quiet(dir)
  const busy = (d: string) => H.runtimeDirBusy(d, { platform: 'win32', unlink: (p: string) => { throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${p}'`), { code: 'EBUSY' }) } })
  let removed = 0
  const { swept, lines } = await sweep(tmp, { platform: 'win32', alive: () => true, processStarts: dstShifted(recorded), busy, removeDir: () => { removed++ } })
  assert.deepEqual(swept, [])
  assert.equal(removed, 0)
  assert.equal(existsSync(join(dir, 'Default', 'Cookies')), true)
  assert.ok(lines.some((l) => l.includes(dir) && /in use/.test(l) && /EBUSY/.test(l)), `logged: ${lines.join(' | ')}`)
})

test('win32 DST: a live host\'s folder no Chrome holds is kept while recent (a browser still starting), and removed once quiet', async (t) => {
  const tmp = scratchTemp(t)
  const recorded = Date.now() - 3 * HOUR_MS
  // Made a moment ago by the live host's browser start: its Chrome has not taken the lockfile yet.
  const starting = runtimeFolder(tmp, ownedBy(4250, recorded, 'Start1'))
  // Untouched for longer than any start takes, and no Chrome in it: a stop's leftover, nothing runs there.
  const idle = quiet(runtimeFolder(tmp, ownedBy(4250, recorded, 'Idle01')))
  const busy = (d: string) => H.runtimeDirBusy(d, { platform: 'win32' })
  const { swept } = await sweep(tmp, { platform: 'win32', alive: () => true, processStarts: dstShifted(recorded), busy })
  assert.deepEqual(swept, [idle])
  assert.equal(existsSync(join(starting, 'Default', 'Cookies')), true, 'a folder whose browser may still be starting is never removed on the time comparison')
  assert.equal(existsSync(idle), false)
  assert.ok(H.RUNTIME_DIR_REUSE_QUIET_MS >= 5 * 60_000 && H.RUNTIME_DIR_REUSE_QUIET_MS < 2 * HOUR_MS, 'quiet: well past a start, and within the two hours this test ages the folder')
})

test('win32: a true reused pid with a free, quiet folder is removed', async (t) => {
  const tmp = scratchTemp(t)
  const recorded = Date.now() - 5 * HOUR_MS
  const dir = quiet(runtimeFolder(tmp, ownedBy(4251, recorded, 'Reus02')))
  const starts = new Map([[4251, { startedAtMs: recorded + 4 * HOUR_MS }]])
  const busy = (d: string) => H.runtimeDirBusy(d, { platform: 'win32' })
  const { swept, lines } = await sweep(tmp, { platform: 'win32', alive: () => true, processStarts: async () => starts, busy })
  assert.deepEqual(swept, [dir])
  assert.equal(existsSync(dir), false)
  assert.ok(lines.some((l) => l.includes(dir) && /newer process/.test(l)), `logged: ${lines.join(' | ')}`)
})

test('macOS: a wall clock step that makes a live host read late leaves its recent folder too; the same rule as Windows', async (t) => {
  const tmp = scratchTemp(t)
  const recorded = Date.now() - 3 * HOUR_MS
  const starting = runtimeFolder(tmp, ownedBy(4252, recorded, 'Start2'))
  const idle = quiet(runtimeFolder(tmp, ownedBy(4252, recorded, 'Idle02')))
  const starts = new Map([[4252, { startedAtMs: recorded + 20 * 60_000 }]])
  const { swept } = await sweep(tmp, { platform: 'darwin', alive: () => true, processStarts: async () => starts, busy: () => null })
  assert.deepEqual(swept, [idle])
  assert.equal(existsSync(starting), true)
})

test('host start: this host\'s own folders are its own, with no process query', async (t) => {
  const tmp = scratchTemp(t)
  const dir = runtimeFolder(tmp, `${H.runtimeDirPrefix()}Ab12Cd`)
  let asked = 0
  const { swept } = await sweep(tmp, { processStarts: async () => { asked++; return new Map() } })
  assert.equal(asked, 0)
  assert.deepEqual(swept, [])
  assert.equal(existsSync(dir), true)
})

test('host start: a folder that names no owner is kept while young, and removed once older than a day', async (t) => {
  const tmp = scratchTemp(t)
  const young = runtimeFolder(tmp, 'hoai-browser-runtime-Young1')
  const old = runtimeFolder(tmp, 'hoai-browser-runtime-Old123')
  const aged = (Date.now() - 25 * HOUR_MS) / 1000
  utimesSync(old, aged, aged)
  const nearly = (Date.now() - 23 * HOUR_MS) / 1000
  utimesSync(young, nearly, nearly)
  const { swept } = await sweep(tmp)
  assert.deepEqual(swept, [old])
  assert.equal(existsSync(join(young, 'Default', 'Cookies')), true, 'a young folder of an older host is kept whole')
  assert.equal(existsSync(old), false)
})

test('win32: a folder Chrome still runs in is skipped, never thrown, and nothing in it is removed', async (t) => {
  const tmp = scratchTemp(t)
  const dir = runtimeFolder(tmp, ownedBy(deadPid(), Date.now() - HOUR_MS))
  writeFileSync(join(dir, 'lockfile'), '')
  quiet(dir)
  // A running Chrome holds its lockfile without delete sharing: Windows refuses to remove it (EBUSY).
  const unlinked: string[] = []
  const busy = (d: string) => H.runtimeDirBusy(d, { platform: 'win32', unlink: (p: string) => { unlinked.push(p); throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${p}'`), { code: 'EBUSY' }) } })
  let removed = 0
  const { swept, lines } = await sweep(tmp, { platform: 'win32', busy, removeDir: () => { removed++ } })
  assert.deepEqual(unlinked, [join(dir, 'lockfile')])
  assert.deepEqual(swept, [])
  assert.equal(removed, 0, 'a busy folder is not even partly removed')
  assert.equal(existsSync(join(dir, 'Default', 'Cookies')), true)
  assert.ok(lines.some((l) => l.includes(dir) && /in use/.test(l) && /EBUSY/.test(l)), `logged: ${lines.join(' | ')}`)
})

test('win32: a removal refused as busy is logged and left, never thrown, and the sweep goes on', async (t) => {
  const tmp = scratchTemp(t)
  const gone = deadPid()
  const held = quiet(runtimeFolder(tmp, ownedBy(gone, Date.now() - HOUR_MS, 'Held01')))
  const free = quiet(runtimeFolder(tmp, ownedBy(gone, Date.now() - HOUR_MS, 'Free01')))
  const removeDir = (d: string) => {
    if (d === held) throw Object.assign(new Error(`EPERM: operation not permitted, rmdir '${d}'`), { code: 'EPERM' })
    rmSync(d, { recursive: true, force: true })
  }
  const { swept, lines } = await sweep(tmp, { platform: 'win32', removeDir })
  assert.deepEqual(swept, [free])
  assert.equal(existsSync(held), true)
  assert.equal(existsSync(free), false)
  assert.ok(lines.some((l) => l.includes(held) && /in use/.test(l) && /EPERM/.test(l)), `logged: ${lines.join(' | ')}`)
})

test('posix: a folder whose Chrome lock names a live process on this machine is busy', () => {
  const readlinkFor = (target: string) => () => target
  const at = '/tmp/hoai-browser-runtime-x'
  for (const platform of ['linux', 'darwin']) {
    assert.equal(H.runtimeDirBusy(at, { platform, readlink: readlinkFor(`${hostname()}-${process.pid}`) }), 'SingletonLock', `${platform}: a live Chrome`)
    assert.equal(H.runtimeDirBusy(at, { platform, readlink: readlinkFor(`${hostname()}-${deadPid()}`) }), null, `${platform}: a Chrome that is gone`)
    assert.equal(H.runtimeDirBusy(at, { platform, readlink: readlinkFor('another-machine-12') }), 'SingletonLock', `${platform}: another machine's Chrome cannot be checked`)
    assert.equal(H.runtimeDirBusy(at, { platform, readlink: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } }), null, `${platform}: no lock`)
  }
})

test('a link inside a swept folder is unlinked, never followed: its target survives', async (t) => {
  const tmp = scratchTemp(t)
  const outside = scratchTemp(t, 'rtsweep-outside-')
  writeFileSync(join(outside, 'keep.txt'), 'owner data')
  const dir = runtimeFolder(tmp, ownedBy(deadPid(), Date.now() - HOUR_MS))
  // A junction on Windows needs no privilege; elsewhere a directory symlink (Chrome's SingletonLock is one).
  symlinkSync(outside, join(dir, 'Default', 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  quiet(dir)
  const { swept } = await sweep(tmp)
  assert.deepEqual(swept, [dir])
  assert.equal(existsSync(dir), false)
  assert.deepEqual(readdirSync(outside), ['keep.txt'], 'the link\'s target is untouched')
})

test('only real folders named hoai-browser-runtime-* directly in TEMP are swept; a link by that name is left whole', async (t) => {
  const tmp = scratchTemp(t)
  const outside = scratchTemp(t, 'rtsweep-outside-')
  writeFileSync(join(outside, 'keep.txt'), 'owner data')
  const gone = deadPid()
  const link = join(tmp, ownedBy(gone, Date.now() - HOUR_MS, 'Link01'))
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  const file = join(tmp, ownedBy(gone, Date.now() - HOUR_MS, 'File01'))
  writeFileSync(file, 'x')
  const other = runtimeFolder(tmp, 'chrome-runtime-Ab12Cd')
  const nested = runtimeFolder(other, ownedBy(gone, Date.now() - HOUR_MS, 'Nest01'))
  const aged = (Date.now() - 25 * HOUR_MS) / 1000
  utimesSync(other, aged, aged)
  const { swept } = await sweep(tmp)
  assert.deepEqual(swept, [])
  assert.equal(existsSync(link), true, 'the link is not removed')
  assert.deepEqual(readdirSync(outside), ['keep.txt'], 'and it is never followed')
  assert.equal(existsSync(file), true)
  assert.equal(existsSync(other), true, 'another program\'s folder is never touched, however old')
  assert.equal(existsSync(nested), true, 'nothing below TEMP\'s own entries is looked at')
})

test('a TEMP that cannot be read sweeps nothing and throws nothing', async (t) => {
  const tmp = join(scratchTemp(t), 'missing')
  const { swept } = await sweep(tmp)
  assert.deepEqual(swept, [])
})

test('END TO END: the host, started as a process, sweeps its own TEMP at start and keeps a live host\'s folder', { timeout: 60_000 }, async (t) => {
  const tmp = scratchTemp(t, 'rtsweep-e2e-')
  const home = scratchTemp(t, 'rtsweep-home-')
  const deadDir = quiet(runtimeFolder(tmp, ownedBy(deadPid(), Date.now() - HOUR_MS, 'Dead01')))
  const liveDir = runtimeFolder(tmp, ownedBy(process.pid, H.HOST_STARTED_AT_MS, 'Live01'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(BGOS_|HOAI_)/i.test(k)) env[k] = v
  Object.assign(env, { HOME: home, USERPROFILE: home, TEMP: tmp, TMP: tmp, TMPDIR: tmp, [STOP_ON_STDIN_EOF_ENV]: '1' })
  const child = spawn(process.execPath, [HOST_BIN], { stdio: ['pipe', 'ignore', 'pipe'], env })
  t.after(() => child.kill('SIGKILL'))
  let stderr = ''
  child.stderr.on('data', (c) => { stderr += c })
  const began = Date.now()
  while (!/runtime folder sweep/.test(stderr) && Date.now() - began < 30_000) await new Promise((r) => setTimeout(r, 100))
  const exited = new Promise((r) => child.once('exit', r))
  child.stdin.end()
  await exited
  assert.match(stderr, /runtime folder sweep/, stderr)
  assert.ok(stderr.includes(tmp), `the sweep names the TEMP it read: ${stderr}`)
  // Off the start path: the host's first line and the sweep's, by the host's own stamps.
  const at = (line: string | undefined) => Date.parse(String(line).split(' ')[0])
  const lines = stderr.split(/\r?\n/).filter(Boolean)
  const waited = at(lines.find((l) => /runtime folder sweep/.test(l))) - at(lines[0])
  assert.ok(waited >= H.RUNTIME_SWEEP_DELAY_MS - 50, `the sweep ran ${waited} ms after the host's first line`)
  assert.equal(existsSync(deadDir), false, 'the dead host\'s folder is gone')
  assert.equal(existsSync(join(liveDir, 'Default', 'Cookies')), true, 'the live host\'s folder is whole')
})
