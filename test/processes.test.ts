/**
 * The process lookup the browser tests use to prove nothing was left running
 * (test/helpers/processes.ts). It replaced a bare pgrep, which Windows does not have: there the
 * old check threw a TypeError on undefined output instead of looking at anything.
 *
 * Run: npm test, or npx tsx --test test/processes.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { processesMatching } from './helpers/processes.ts'

async function until(what: string, check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

test('a live process is found by a string on its command line, and is gone once it ends', { timeout: 60_000 }, async () => {
  const marker = `hoai-proc-${randomUUID()}`
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], { stdio: 'ignore', windowsHide: true })
  try {
    await until('the marked process to be found', () => processesMatching(marker).includes(child.pid!))
    // This file's own name IS on the test process's command line, so this can only pass because
    // the lookup leaves its caller out.
    assert.ok(!processesMatching('processes.test').includes(process.pid), 'the test process itself is never reported')
  } finally {
    child.kill('SIGKILL')
  }
  await until('the marked process to be gone', () => processesMatching(marker).length === 0)
})

test('a string nothing carries matches nothing, and an empty needle is refused rather than matching everything', () => {
  assert.deepEqual(processesMatching(`hoai-nothing-${randomUUID()}`), [])
  assert.throws(() => processesMatching(''), /non-empty needle/)
})

test('a lookup that cannot run throws: it never reads "could not look" as "nothing is running"', () => {
  // A PATH with nothing on it: neither pgrep nor powershell.exe can be found.
  const env = { ...process.env, PATH: process.platform === 'win32' ? 'C:\\no-such-folder' : '/no-such-folder', Path: undefined }
  assert.throws(() => processesMatching('anything', { env }), /could not list processes/)
})
