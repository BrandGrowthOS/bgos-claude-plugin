/**
 * Deliberate hangs under the runner's REAL args and deadlines, then removed.
 * An async hang must fail by test name at the per-test deadline. A blocked event
 * loop must fail by file name at the file deadline. Both must stay under 5 minutes.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTestFile, testGroups, FILE_IDLE_TIMEOUT_MS, TEST_TIMEOUT_MS } from '../../../scripts/run-test-files.mjs'

const dir = mkdtempSync(join(tmpdir(), 'wintest-hang-'))
const FIVE_MINUTES = 300
try {
  writeFileSync(join(dir, 'async-hang.test.cjs'), "require('node:test')('deliberate async hang', () => new Promise(() => {}))")
  writeFileSync(join(dir, 'blocked-loop.test.cjs'), "require('node:test')('deliberate blocked loop', () => { while (true) {} })")
  const [group] = testGroups([{ file: 'x', source: '' }])
  console.log(JSON.stringify({ TEST_TIMEOUT_MS, FILE_IDLE_TIMEOUT_MS, node: process.version }))
  const run = async (file) => {
    const start = performance.now()
    let output = ''
    const result = await runTestFile(file, {
      command: group.command, args: group.args, cwd: dir, onOutput: (chunk) => { output += chunk },
    })
    const seconds = Math.round((performance.now() - start) / 1000)
    console.log(JSON.stringify({ file, code: result.code, timedOut: result.timedOut, failures: result.failures, seconds }))
    for (const line of output.split('\n')) if (/TIMEOUT|^\s*error: 'test timed out/.test(line)) console.log(line.trim())
    return { result, seconds }
  }
  const [hang, blocked] = await Promise.all([run('async-hang.test.cjs'), run('blocked-loop.test.cjs')])
  assert.equal(hang.result.code, 1)
  assert.deepEqual(hang.result.failures, ['deliberate async hang'], 'fails by test name')
  assert.ok(hang.seconds < FIVE_MINUTES)
  assert.equal(blocked.result.code, 1)
  assert.equal(blocked.result.timedOut, true, 'fails by file name')
  assert.ok(blocked.seconds < FIVE_MINUTES)
  console.log('PROVED')
} finally {
  rmSync(dir, { recursive: true, force: true })
  console.log('Removed the deliberate hang fixtures.')
}
