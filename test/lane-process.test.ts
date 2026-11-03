/**
 * The lane process helpers (gate review finding 3) against REAL processes: a
 * lane's start stamp identifies its process across a daemon crash (a pid alone
 * can be reused), and a stop signals its whole process group.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { spawn } from 'node:child_process'

import { killProcessGroup, processStamp } from '../lib/lane-process.ts'

const gone = async (pid: number, ms = 5_000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (processStamp(pid) === null) return true
    await new Promise((done) => setTimeout(done, 50))
  }
  return false
}

test('a live process has a stable start stamp; once it has exited it has none', { skip: process.platform === 'win32' }, async () => {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  const pid = child.pid!
  try {
    const stamp = processStamp(pid)
    assert.equal(typeof stamp, 'string')
    assert.ok(stamp!.length > 0)
    assert.equal(processStamp(pid), stamp, 'the same process, the same stamp')
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
    assert.notEqual(processStamp(grandchild), null)
    killProcessGroup(leader.pid!, 'SIGTERM')
    assert.equal(await gone(grandchild), true, 'the grandchild stopped with its group')
  } finally {
    try { process.kill(-leader.pid!, 'SIGKILL') } catch {}
  }
})

test('a pid nobody holds has no stamp, and a stop of it is harmless', () => {
  assert.equal(processStamp(2 ** 22 - 3), null)
  assert.equal(processStamp(0), null)
  assert.equal(processStamp(-5), null)
  assert.doesNotThrow(() => killProcessGroup(2 ** 22 - 3, 'SIGTERM'))
})

test('the real stream json child exposes its pid, so the lane state can name it', { skip: process.platform === 'win32' }, async () => {
  const { spawnStreamJson } = await import('../lib/stream-json-child.ts')
  const child = spawnStreamJson('sleep', ['30'], { cwd: process.cwd() })
  const exited = new Promise<void>((done) => child.onExit(() => done()))
  assert.equal(typeof child.pid, 'number')
  assert.notEqual(processStamp(child.pid!), null)
  child.kill('SIGTERM')
  await exited
  assert.equal(await gone(child.pid!), true)
})

test('on Linux the stamp is the start time from /proc/<pid>/stat, and a zombie counts as gone', () => {
  // Field 2 is the command in parentheses (it may hold spaces and parentheses), field 3 the state, field 22 the start time.
  const stat = (state: string) => `4242 (claude (x) y) ${state} 1 4242 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 3 0 987654 123 456\n`
  const linux = (text: string | null) => ({ platform: 'linux' as const, readFile: () => { if (text === null) throw new Error('ENOENT'); return text } })
  assert.equal(processStamp(4242, linux(stat('S'))), 'linux:987654')
  assert.equal(processStamp(4242, linux(stat('R'))), 'linux:987654')
  assert.equal(processStamp(4242, linux(stat('Z'))), null)
  assert.equal(processStamp(4242, linux(stat('X'))), null)
  assert.equal(processStamp(4242, linux(null)), null)
})

test('elsewhere the stamp is what ps prints as the start, and a zombie or a missing pid counts as gone', () => {
  const ps = (status: number, stdout: string) => ({ platform: 'darwin' as const, run: () => ({ status, stdout }) })
  assert.equal(processStamp(4242, ps(0, 'Ss   Mon Nov  3 17:00:01 2026\n')), 'Mon Nov 3 17:00:01 2026')
  assert.equal(processStamp(4242, ps(0, 'Z+   Mon Nov  3 17:00:01 2026\n')), null)
  assert.equal(processStamp(4242, ps(1, '')), null)
})
