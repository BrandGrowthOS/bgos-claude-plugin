/** Real Chromium is serialized; the runner's own worker tests run separately. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { testGroups } from '../scripts/run-test-files.mjs'

const ROOT = join(import.meta.dirname, '..')

test('real Chromium files leave the parallel pool and run with a concurrency of one', () => {
  const groups = testGroups([
    { file: 'test/unit.test.ts', source: "import { test } from 'node:test'" },
    { file: 'test/browser.chromium.test.ts', source: "import { test } from 'node:test'" },
    { file: 'test/bun.test.ts', source: "import { test } from " + "'bun:test'" },
    { file: 'test\\run-tests-timeout.test.ts', source: "import { test } from 'node:test'" },
  ])
  assert.deepEqual(groups.map(({ files }) => files), [
    ['test/unit.test.ts'], ['test\\run-tests-timeout.test.ts'], ['test/browser.chromium.test.ts'], ['test/bun.test.ts'],
  ])
  assert.deepEqual(groups.map(({ concurrency }) => concurrency), [4, 1, 1, 4])
  assert.ok(groups[2]!.args.includes('--test-timeout=120000'))
})

test('there are real Chromium files for that rule to hold', () => {
  const files = readdirSync(join(ROOT, 'test')).filter((name) => name.endsWith('.chromium.test.ts'))
  assert.ok(files.includes('remote-browser-controls.chromium.test.ts'))
  assert.ok(files.length >= 5)
})
