/** Real Chromium is serialized; the runner's own worker tests run separately. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { partitionTests, testGroups } from '../scripts/run-test-files.mjs'

const ROOT = join(import.meta.dirname, '..')

test('real Chromium files leave the parallel pool and run with a concurrency of one', () => {
  const groups = testGroups([
    { file: 'test/unit.test.ts', source: "import { test } from 'node:test'" },
    { file: 'test/browser.chromium.test.ts', source: "import { test } from 'node:test'" },
    { file: 'test/bun.test.ts', source: "import { test } from " + "'bun:test'" },
    { file: 'test\\run-tests-timeout.test.ts', source: "import { test } from 'node:test'" },
  ])
  assert.deepEqual(groups.map(({ files }) => files), [
    ['test/unit.test.ts'], ['test\\run-tests-timeout.test.ts'], ['test/browser.chromium.test.ts'], [], ['test/bun.test.ts'],
  ])
  assert.deepEqual(groups.map(({ concurrency }) => concurrency), [4, 1, 1, 1, 4])
  assert.ok(groups[2]!.args.includes('--test-timeout=120000'))
})

test('there are real Chromium files for that rule to hold', () => {
  const files = readdirSync(join(ROOT, 'test')).filter((name) => name.endsWith('.chromium.test.ts'))
  assert.ok(files.includes('remote-browser-controls.chromium.test.ts'))
  assert.ok(files.length >= 5)
})

test('files that boot real daemons leave the pool and run one at a time, after it: side by side they push fixed limits elsewhere past their time', () => {
  const entries = [
    { file: 'test/unit.test.ts', source: "import { test } from 'node:test'" },
    { file: 'test/one.daemon.test.ts', source: "import { test } from 'node:test'" },
    { file: 'test\\two.daemon.test.ts', source: "import { test } from 'node:test'" },
  ]
  assert.deepEqual(partitionTests(entries).parallelFiles, ['test/unit.test.ts'])
  assert.deepEqual(partitionTests(entries).daemonFiles, ['test/one.daemon.test.ts', 'test\\two.daemon.test.ts'])
  const groups = testGroups(entries)
  const pool = groups.findIndex(({ files }) => files.includes('test/unit.test.ts'))
  const daemons = groups.findIndex(({ files }) => files.includes('test/one.daemon.test.ts'))
  assert.ok(daemons > pool, 'after the pool')
  assert.deepEqual(groups[daemons]!.files, ['test/one.daemon.test.ts', 'test\\two.daemon.test.ts'])
  assert.equal(groups[daemons]!.concurrency, 1)
  assert.equal(groups[daemons]!.family, 'node')
  assert.ok(groups[daemons]!.args.includes('--test-timeout=120000'), 'under the same limits as every node file')
})

test('there is a real daemon file for that rule to hold', () => {
  const files = readdirSync(join(ROOT, 'test')).filter((name) => name.endsWith('.daemon.test.ts'))
  assert.ok(files.includes('canary-delivery.daemon.test.ts'))
})
