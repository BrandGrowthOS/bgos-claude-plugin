// The scan by itself. The runner that uses it runs for real on real test files in test/run-tests-timeout.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotWorkingTree } from '../scripts/test-tree-snapshot.mjs'

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'suite-litter-guard-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))
  return root
}

test('snapshot sees ignored files and empty nested repos, without traversing git or dependencies', (t) => {
  const root = fixture(t)
  mkdirSync(join(root, 'nested', '.git'), { recursive: true })
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, '.git', 'internal'), '')
  writeFileSync(join(root, 'node_modules', 'dependency'), '')
  writeFileSync(join(root, '.gitignore'), '*.backup\n')
  writeFileSync(join(root, 'ignored.backup'), '')
  mkdirSync(join(root, 'empty'))
  const before = snapshotWorkingTree(root)
  assert.deepEqual([...before].sort(), ['.git', '.gitignore', 'empty', 'ignored.backup', 'nested', 'nested/.git', 'node_modules'])
  mkdirSync(join(root, 'nested', 'new', '.git'), { recursive: true })
  writeFileSync(join(root, 'new.backup'), '')
  assert.deepEqual([...snapshotWorkingTree(root)].filter((path) => !before.has(path)).sort(), ['nested/new', 'nested/new/.git', 'new.backup'])
})

test('snapshot does not follow directory links out of the tree or into a cycle', (t) => {
  const root = fixture(t)
  const outside = fixture(t)
  writeFileSync(join(outside, 'outside'), '')
  symlinkSync(outside, join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
  symlinkSync(root, join(root, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual([...snapshotWorkingTree(root)].sort(), ['cycle', 'external'])
})

test('a failed scan throws instead of silently treating an unreadable tree as clean', (t) => {
  const root = fixture(t)
  assert.throws(() => snapshotWorkingTree(join(root, 'missing')), /ENOENT/)
})

test('a caller that takes the error is told, and gets what could be read', (t) => {
  const root = fixture(t)
  const errors: NodeJS.ErrnoException[] = []
  assert.deepEqual([...snapshotWorkingTree(join(root, 'missing'), (error: NodeJS.ErrnoException) => errors.push(error))], [])
  assert.deepEqual(errors.map((error) => error.code), ['ENOENT'])
})
