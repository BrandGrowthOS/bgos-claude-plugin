import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { ChromiumEngine } from '../bin/hoai-browser-host.mjs'
import { killTestBrowserTree, stopWindowsTestBrowser, TestChromiumEngine } from './helpers/chromium-engine.ts'

function browser() {
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null, signalCode: null })
  return { child: child as unknown as ChildProcess, exit: () => { child.exitCode = 0; child.emit('exit', 0) } }
}

const FIXTURE_PID = 12345

/** Playwright's side of a launch: the browser it hands back, and the Chrome pid it names. */
function fakeBrowser() {
  return Object.assign(new EventEmitter(), {
    newBrowserCDPSession: async () => ({ send: async () => ({ processInfo: [{ type: 'browser', id: FIXTURE_PID }] }), detach: async () => {} }),
    close: async () => {},
  })
}

/** Lets each promise continuation run before mocked time moves on. */
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

/** A failed start polls its killed Chrome every 25 ms against the clock, so advance one poll at a time. */
async function advance(t: TestContext, ms: number) {
  for (let waited = 0; waited < ms; waited += 25) {
    t.mock.timers.tick(25)
    await flush()
  }
}

// Exercise the fixture's real constructor and shutdown override on every CI OS.
// Only OS boundaries are faked; no Chrome, Playwright, taskkill or filesystem work is done.
function engineFixture(t: TestContext, platform: NodeJS.Platform = 'win32') {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
  t.after(() => Object.defineProperty(process, 'platform', descriptor))
  // Date too: a failed start bounds its wait for the Chrome it killed by the clock.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const f = browser()
  const signals: string[] = []
  const child = Object.assign(f.child, {
    kill: (signal: string) => { signals.push(signal); return true },
  })
  t.after(() => f.exit())
  const engine = new TestChromiumEngine({ executable: 'fixture-chrome', profileDir: 'fixture-profile', outputDir: 'fixture-output' })
  // The fixture's shutdown override receives the host's process type.
  const engineChild = child as unknown as NonNullable<typeof engine._child>
  const kills: string[] = []
  const launchOptions: any[] = []
  const launched = fakeBrowser()
  let alive = true
  // Playwright enforces the start budget it is given. A launch that outlasts it names the pid it started.
  const launch = (readyAfterMs?: number) => engine._launch({
    executable: 'fixture-chrome', profileDir: 'fixture-profile', platform,
    launchImpl: ((options: any) => {
      launchOptions.push(options)
      return new Promise((resolve, reject) => {
        if (readyAfterMs !== undefined && readyAfterMs < options.timeout) setTimeout(() => resolve(launched), readyAfterMs)
        else setTimeout(() => reject(new Error(`browserType.launch: Timeout ${options.timeout}ms exceeded.\n<launched> pid=${FIXTURE_PID}`)), options.timeout)
      })
    }) as any,
    killImpl: ((pid: number, signal: string) => { kills.push(`${pid} ${signal}`) }) as any,
    aliveImpl: (() => alive) as any,
  })
  const exitLaunched = () => { alive = false }
  // Also drops launchChromium's live-child tracking when an assertion fails.
  t.after(() => { exitLaunched(); launched.emit('disconnected') })
  return { ...f, child, engineChild, engine, signals, kills, launchOptions, launched, launch, exitLaunched }
}

function fakeTaskkill(t: TestContext, run: (...args: any[]) => void) {
  const mocked = t.mock.method(childProcess, 'execFile', run as any)
  syncBuiltinESMExports()
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
}

test('TestChromiumEngine constructor lets a Windows launch finish after 40 seconds', async t => {
  const f = engineFixture(t)
  // Observe either outcome before time advances, including under mutation.
  let settled = false
  const launched = f.launch(40_000).then(result => ({ result, error: null }), error => ({ result: null, error }))
    .then(outcome => { settled = true; return outcome })
  t.mock.timers.tick(40_000)
  await flush()
  // Fail here, never hang on a launch still waiting for a timer nobody ticks.
  assert.equal(settled, true, 'the launch finished at 40 seconds')
  const { result, error } = await launched
  assert.equal(error, null)
  assert.deepEqual(f.kills, [])
  assert.equal(f.launchOptions[0].timeout, 60_000)
  assert.ok(result)
  assert.equal(result.browser, f.launched)
  assert.equal(result.child.pid, FIXTURE_PID)
})

test('TestChromiumEngine constructor bounds Windows launch at 60 seconds and confirms exit for 10 seconds', async t => {
  const f = engineFixture(t)
  let settled = false
  const launched = f.launch().then(() => null, error => error).then(error => { settled = true; return error })
  t.mock.timers.tick(59_999)
  await flush()
  const beforeDeadline = [...f.kills]
  t.mock.timers.tick(1)
  await flush()
  const atDeadline = [...f.kills]
  await advance(t, 9_975)
  const settledBeforeExit = settled
  f.exitLaunched()
  t.mock.timers.tick(25)
  await flush()
  assert.equal(settled, true, 'launch fails as soon as the killed Chrome has gone')
  const error = await launched
  assert.deepEqual(beforeDeadline, [])
  assert.deepEqual(atDeadline, [`${FIXTURE_PID} SIGKILL`])
  assert.equal(settledBeforeExit, false, 'launch must keep waiting for physical exit after the production 3 second kill budget')
  assert.equal(f.launchOptions[0].timeout, 60_000)
  assert.match(error?.message ?? '', /Timeout 60000ms exceeded/)
})

test('TestChromiumEngine dispatch keeps a slow Windows graceful exit away from production signals', async t => {
  const f = engineFixture(t)
  fakeTaskkill(t, () => assert.fail('graceful exit must not invoke taskkill'))
  f.engine._child = f.engineChild
  let stopped = false
  const stop = f.engine._killChild().then(() => { stopped = true })
  t.mock.timers.tick(12_000)
  await Promise.resolve()
  const observed = { stopped, signals: [...f.signals], owned: f.engine._child }
  f.exit()
  await stop
  assert.equal(observed.stopped, false)
  assert.deepEqual(observed.signals, [])
  assert.equal(observed.owned, f.child, 'retain ownership until physical exit')
  assert.equal(f.engine._child, null)
  assert.equal(f.child.listenerCount('exit'), 0)
})

test('TestChromiumEngine dispatch forces the owned Windows tree after 20 seconds and awaits physical exit', async t => {
  const f = engineFixture(t), calls: unknown[][] = []
  fakeTaskkill(t, (...args) => { calls.push(args.slice(0, 3)); args[3](null) })
  f.engine._child = f.engineChild
  let stopped = false
  const stop = f.engine._killChild().then(() => { stopped = true })
  t.mock.timers.tick(19_999)
  await Promise.resolve()
  assert.deepEqual(calls, [])
  t.mock.timers.tick(1)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [['taskkill.exe', ['/PID', '12345', '/T', '/F'], { windowsHide: true, timeout: 10_000 }]])
  assert.deepEqual(f.signals, [])
  assert.equal(stopped, false)
  assert.equal(f.engine._child, f.child)
  f.exit()
  await stop
  assert.equal(f.engine._child, null)
  assert.equal(f.child.listenerCount('exit'), 0)
})

test('TestChromiumEngine dispatch rejects a stuck Windows tree and retains ownership for retry', async t => {
  const f = engineFixture(t)
  fakeTaskkill(t, (...args) => args[3](null))
  f.engine._child = f.engineChild
  const stopped = f.engine._killChild().then(() => null, error => error)
  t.mock.timers.tick(20_000)
  await new Promise<void>(resolve => setImmediate(resolve))
  t.mock.timers.tick(10_000)
  await new Promise<void>(resolve => setImmediate(resolve))
  const owned = f.engine._child
  const listeners = f.child.listenerCount('exit')
  f.exit()
  const error = await stopped
  assert.match(error?.message ?? '', /process tree did not finish closing/)
  assert.equal(owned, f.child)
  assert.equal(listeners, 0)
  await f.engine._killChild()
  assert.equal(f.engine._child, null)
  await f.engine._killChild() // No child is an idempotent stop.
})

test('TestChromiumEngine retains production launch limits and shutdown dispatch off Windows', async t => {
  const f = engineFixture(t, 'linux')
  let settled = false
  const failed = f.launch().then(() => null, error => error).then(error => { settled = true; return error })
  t.mock.timers.tick(30_000)
  await flush()
  assert.deepEqual(f.kills, [`${FIXTURE_PID} SIGKILL`])
  await advance(t, 2_975)
  assert.equal(settled, false, 'the production kill wait is 3 seconds')
  t.mock.timers.tick(25)
  await flush()
  assert.equal(settled, true, 'and no longer')
  const error = await failed
  assert.equal(f.launchOptions[0].timeout, 30_000)
  assert.match(error?.message ?? '', /Timeout 30000ms exceeded/)
  f.exit()
  const dispatch = t.mock.method(ChromiumEngine.prototype, '_killChild', async function () {})
  await f.engine._killChild()
  assert.equal(dispatch.mock.callCount(), 1)
  assert.equal(dispatch.mock.calls[0].this, f.engine)
})

test('Windows fixture taskkill uses a bounded direct spawn and kills descendants of the owned pid', async () => {
  const calls: unknown[][] = []
  await killTestBrowserTree(12345, ((...args: any[]) => {
    calls.push(args.slice(0, 3))
    args[3](null)
  }) as any)
  assert.deepEqual(calls, [['taskkill.exe', ['/PID', '12345', '/T', '/F'], { windowsHide: true, timeout: 10_000 }]])
})

test('Windows fixture waits for a slow graceful exit without forcing Chrome or leaving exit listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = browser(), kills: number[] = []
  let stopped = false
  const stop = stopWindowsTestBrowser(f.child, async pid => { kills.push(pid) }).then(() => { stopped = true })
  t.mock.timers.tick(12_000) // Past the old combined 5 + 3 + 3 second wait.
  await Promise.resolve()
  assert.equal(stopped, false)
  f.exit()
  await stop
  assert.deepEqual(kills, [])
  assert.equal(f.child.listenerCount('exit'), 0)
})

test('Windows fixture forces only its owned tree after the grace period and confirms physical exit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = browser(), kills: number[] = []
  const stop = stopWindowsTestBrowser(f.child, async pid => { kills.push(pid); f.exit() })
  t.mock.timers.tick(20_000)
  await stop
  assert.deepEqual(kills, [f.child.pid])
  assert.equal(f.child.listenerCount('exit'), 0)
})

test('Windows fixture fails boundedly when taskkill does not confirm an exit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = browser(), kills: number[] = []
  const stop = stopWindowsTestBrowser(f.child, async pid => { kills.push(pid) })
  const failed = assert.rejects(stop, /process tree did not finish closing/)
  t.mock.timers.tick(20_000)
  // Let the grace wait and taskkill complete before advancing the exit wait.
  await Promise.resolve()
  await Promise.resolve()
  t.mock.timers.tick(10_000)
  await failed
  assert.deepEqual(kills, [f.child.pid])
  assert.equal(f.child.listenerCount('exit'), 0)
})
