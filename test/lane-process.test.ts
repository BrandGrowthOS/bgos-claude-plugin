/**
 * The lane process helpers (gate review finding 3) against REAL processes: a
 * lane's start stamp identifies its process across a daemon crash (a pid alone
 * can be reused), and a stop signals its whole process group.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { spawn } from 'node:child_process'

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { killProcessGroup, processRunsIn, processStamp } from '../lib/lane-process.ts'

const gone = async (pid: number, ms = 5_000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if ((await processStamp(pid)) === null) return true
    await new Promise((done) => setTimeout(done, 50))
  }
  return false
}

test('a live process has a stable start stamp; once it has exited it has none', { skip: process.platform === 'win32' }, async () => {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  const pid = child.pid!
  try {
    const stamp = await processStamp(pid)
    assert.equal(typeof stamp, 'string')
    assert.ok(stamp!.length > 0)
    assert.equal(await processStamp(pid), stamp, 'the same process, the same stamp')
    const exited = new Promise((done) => child.on('exit', done))
    killProcessGroup(pid, 'SIGTERM')
    await exited
    assert.equal(await gone(pid), true)
  } finally {
    try { process.kill(-pid, 'SIGKILL') } catch {}
  }
})

test('the stop reaches the whole process group, the tools a lane started included', { skip: process.platform === 'win32' }, async () => {
  // A shell (the group leader) with a grandchild of its own, like a lane's Bash running a test.
  const leader = spawn('sh', ['-c', 'sleep 30 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const grandchild = Number(await new Promise<string>((done) => leader.stdout!.once('data', (d) => done(String(d).trim()))))
  try {
    assert.notEqual(await processStamp(grandchild), null)
    killProcessGroup(leader.pid!, 'SIGTERM')
    assert.equal(await gone(grandchild), true, 'the grandchild stopped with its group')
  } finally {
    try { process.kill(-leader.pid!, 'SIGKILL') } catch {}
  }
})

test('a pid nobody holds has no stamp, and a stop of it is harmless', async () => {
  assert.equal(await processStamp(2 ** 22 - 3), null)
  assert.equal(await processStamp(0), null)
  assert.equal(await processStamp(-5), null)
  assert.doesNotThrow(() => killProcessGroup(2 ** 22 - 3, 'SIGTERM'))
})

test('the real stream json child exposes its pid, so the lane state can name it', { skip: process.platform === 'win32' }, async () => {
  const { spawnStreamJson } = await import('../lib/stream-json-child.ts')
  const child = spawnStreamJson('sleep', ['30'], { cwd: process.cwd() })
  const exited = new Promise<void>((done) => child.onExit(() => done()))
  assert.equal(typeof child.pid, 'number')
  assert.notEqual(await processStamp(child.pid!), null)
  child.kill('SIGTERM')
  await exited
  assert.equal(await gone(child.pid!), true)
})

test('on Linux the stamp is the start time from /proc/<pid>/stat, and a zombie counts as gone', async () => {
  // Field 2 is the command in parentheses (it may hold spaces and parentheses), field 3 the state, field 22 the start time.
  const stat = (state: string) => `4242 (claude (x) y) ${state} 1 4242 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 3 0 987654 123 456\n`
  const linux = (text: string | null) => ({ platform: 'linux' as const, readFile: async () => { if (text === null) throw new Error('ENOENT'); return text } })
  assert.equal(await processStamp(4242, linux(stat('S'))), 'linux:987654')
  assert.equal(await processStamp(4242, linux(stat('R'))), 'linux:987654')
  assert.equal(await processStamp(4242, linux(stat('Z'))), null)
  assert.equal(await processStamp(4242, linux(stat('X'))), null)
  assert.equal(await processStamp(4242, linux(null)), null)
})

test('elsewhere the stamp is what ps prints as the start, and a zombie or a missing pid counts as gone', async () => {
  const ps = (status: number, stdout: string) => ({ platform: 'darwin' as const, run: async () => ({ status, stdout }) })
  assert.equal(await processStamp(4242, ps(0, 'Ss   Mon Nov  3 17:00:01 2026\n')), 'Mon Nov 3 17:00:01 2026')
  assert.equal(await processStamp(4242, ps(0, 'Z+   Mon Nov  3 17:00:01 2026\n')), null)
  assert.equal(await processStamp(4242, ps(1, '')), null)
})

test('reading a stamp never blocks the event loop: timers keep firing while ps runs', { skip: process.platform === 'win32' }, async () => {
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 5)
  try {
    // A ps that takes 200 ms (as a loaded machine can): the loop must keep turning meanwhile.
    const slow = { platform: 'darwin' as const, run: (_c: string, _a: string[]) => new Promise<{ status: number; stdout: string }>((done) => setTimeout(() => done({ status: 0, stdout: 'S Mon Nov  3 17:00:01 2026\n' }), 200)) }
    const pending = processStamp(4242, slow)
    assert.equal(typeof (pending as Promise<unknown>).then, 'function', 'a promise, never a synchronous answer')
    assert.equal(await pending, 'Mon Nov 3 17:00:01 2026')
    assert.ok(ticks >= 10, `the loop turned ${ticks} times during the read`)
    // The real one too: a promise.
    const real = processStamp(process.pid)
    assert.equal(typeof (real as Promise<unknown>).then, 'function')
    assert.notEqual(await real, null)
  } finally {
    clearInterval(timer)
  }
})

test('a process is known by the folder it runs in when no stamp was saved', { skip: process.platform === 'win32' }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lane-cwd-')))
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'lane-cwd-other-')))
  const child = spawn('sleep', ['30'], { cwd: dir, detached: true, stdio: 'ignore' })
  try {
    await new Promise((done) => setTimeout(done, 100))
    assert.equal(await processRunsIn(child.pid!, dir), true)
    assert.equal(await processRunsIn(child.pid!, other), false)
    assert.equal(await processRunsIn(2 ** 22 - 3, dir), false)
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL') } catch {}
    rmSync(dir, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})

test('the real ps read runs off the event loop: a 300 ms ps leaves timers firing', { skip: process.platform === 'win32' }, async () => {
  const { writeFileSync, chmodSync } = await import('node:fs')
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'slow-ps-')))
  writeFileSync(join(bin, 'ps'), '#!/bin/sh\nsleep 0.3\necho "S Mon Nov  3 17:00:01 2026"\n')
  chmodSync(join(bin, 'ps'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 10)
  try {
    assert.equal(await processStamp(process.pid, { platform: 'darwin' }), 'Mon Nov 3 17:00:01 2026')
    assert.ok(ticks >= 10, `the loop turned ${ticks} times while ps ran`)
  } finally {
    clearInterval(timer)
    process.env.PATH = path
    rmSync(bin, { recursive: true, force: true })
  }
})
