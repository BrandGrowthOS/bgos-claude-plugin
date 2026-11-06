import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { killTestBrowserTree, stopWindowsTestBrowser } from './helpers/chromium-engine.ts'

function browser() {
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null, signalCode: null })
  return { child: child as unknown as ChildProcess, exit: () => { child.exitCode = 0; child.emit('exit', 0) } }
}

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
