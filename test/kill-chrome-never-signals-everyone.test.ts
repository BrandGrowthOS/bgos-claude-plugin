import assert from 'node:assert/strict'
import { test } from 'node:test'

import { killChromeProcess } from '../bin/hoai-browser-host.mjs'
import { killProcessGroup } from '../lib/lane-process.ts'

// kill(-1, signal) signals every process this user owns. A fake browser with pid 1 reached it
// through killChromeProcess on 2026-11-04 and took down the whole Mac's sessions, twice.
// process.kill is replaced before each call, so nothing here can signal anything real.
function signalsFor(pid: unknown): Array<[number, unknown]> {
  const real = process.kill
  const seen: Array<[number, unknown]> = []
  process.kill = ((target: number, signal: unknown) => {
    seen.push([target, signal])
    return true
  }) as typeof process.kill
  try {
    killChromeProcess(pid as number, 'SIGKILL', 'darwin')
  } finally {
    process.kill = real
  }
  return seen
}

for (const pid of [1, 0, -1, -4321, undefined, Number.NaN, 1.5]) {
  test(`killChromeProcess sends nothing for pid ${pid}`, () => {
    assert.deepEqual(signalsFor(pid), [])
  })
}

test('killChromeProcess never signals its own process', () => {
  assert.deepEqual(signalsFor(process.pid), [])
})

test('killChromeProcess still signals a real group', () => {
  assert.deepEqual(signalsFor(4321), [[-4321, 'SIGKILL']])
})

test('a lane\'s group kill sends nothing for pid 1 either', () => {
  const real = process.kill
  const seen: unknown[] = []
  process.kill = ((target: number) => { seen.push(target); return true }) as typeof process.kill
  try {
    for (const pid of [1, 0, -1]) killProcessGroup(pid as number, 'SIGKILL')
    assert.deepEqual(seen, [])
    killProcessGroup(4321, 'SIGKILL')
    assert.deepEqual(seen, [-4321])
  } finally { process.kill = real }
})
