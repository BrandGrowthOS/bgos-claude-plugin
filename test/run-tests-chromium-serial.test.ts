/**
 * The test runner runs the real Chromium files ONE AT A TIME, after the rest
 * (scripts/run-tests.mjs). Side by side, two of
 * remote-browser-controls.chromium's tests fail on main as after it; one at a
 * time every real Chromium file passes. A runner that put them back in the
 * parallel pool would turn `npm test` red whenever the pool overlaps them.
 *
 * Run with: npx tsx --test test/run-tests-chromium-serial.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const RUNNER = readFileSync(join(ROOT, 'scripts', 'run-tests.mjs'), 'utf8')

test('real Chromium files leave the parallel pool and run with a concurrency of one', () => {
  assert.match(RUNNER, /const chromiumFiles = nodeFiles\.filter\(\(file\) => file\.endsWith\('\.chromium\.test\.ts'\)\)/)
  assert.match(RUNNER, /const parallelFiles = nodeFiles\.filter\(\(file\) => !file\.endsWith\('\.chromium\.test\.ts'\)\)/)
  assert.match(RUNNER, /batches\(parallelFiles, /)
  assert.match(RUNNER, /run\(label, 'npx', \['tsx', '--test', '--test-concurrency=1', \.\.\.batch\]\)/)
  assert.ok(!/batches\(nodeFiles, /.test(RUNNER), 'the whole node family is never one parallel pool again')
})

test('there are real Chromium files for that rule to hold', () => {
  const files = readdirSync(join(ROOT, 'test')).filter((name) => name.endsWith('.chromium.test.ts'))
  assert.ok(files.includes('remote-browser-controls.chromium.test.ts'))
  assert.ok(files.length >= 5)
})
