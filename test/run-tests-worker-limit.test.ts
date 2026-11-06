import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as runner from '../scripts/run-test-files.mjs'

test('the worker limit accepts a smaller local cap and never exceeds the repository maximum', () => {
  const limit = (runner as any).testWorkerLimit
  assert.equal(typeof limit, 'function')
  for (const [value, expected] of [['2', 2], ['1', 1], ['99', 4], ['', 4], ['0', 4], ['invalid', 4]]) {
    assert.equal(limit({ RUN_TESTS_WORKERS: value }), expected, String(value))
  }
})
