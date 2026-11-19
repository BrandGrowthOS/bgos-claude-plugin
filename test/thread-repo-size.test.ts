/**
 * THREADCRASH (0.87.1): a repository too large to check out again runs its
 * threads read only in place (lib/thread-repo-size.ts). Real git, small
 * limits.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkoutLimits, checkoutTooLarge, THREAD_COPY_LIMIT_BYTES, THREAD_COPY_LIMIT_FILES } from '../lib/thread-repo-size.ts'

const HAS_GIT = spawnSync('git', ['--version']).status === 0
const SKIP = HAS_GIT ? false : 'needs git'

function repo(files: Record<string, number>): string {
  const dir = mkdtempSync(join(tmpdir(), 'thread-repo-size-'))
  const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  git(['init', '-q'])
  git(['config', 'user.email', 'test@example.invalid'])
  git(['config', 'user.name', 'Test'])
  for (const [rel, size] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), Buffer.alloc(size, 65))
  }
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'first'])
  return dir
}

test('a repository under the limits gets its worktree', { skip: SKIP }, async () => {
  const dir = repo({ 'a.txt': 1000, 'b/c.txt': 2000 })
  try {
    assert.equal(await checkoutTooLarge(dir, { bytes: 10_000, files: 10 }), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a repository over the byte limit is too large, and says why plainly', { skip: SKIP }, async () => {
  const dir = repo({ 'big.bin': 300_000, 'small.txt': 10 })
  try {
    assert.equal(await checkoutTooLarge(dir, { bytes: 100_000, files: 10 }), 'it holds more than 98 KB of files')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a repository over the file limit is too large', { skip: SKIP }, async () => {
  const files: Record<string, number> = {}
  for (let i = 0; i < 30; i++) files[`f${i}.txt`] = 1
  const dir = repo(files)
  try {
    assert.equal(await checkoutTooLarge(dir, { bytes: 1e9, files: 20 }), 'it holds more than 20 files')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a folder git cannot measure counts as too large: when in doubt, copy nothing', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'thread-repo-size-'))
  try {
    assert.match(String(await checkoutTooLarge(dir, { bytes: 1e9, files: 10 })), /could not be measured/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the limits default to 1 GB and 100,000 files, and HOAI_THREAD_COPY_LIMIT_BYTES sets the byte one', () => {
  assert.deepEqual(checkoutLimits({}), { bytes: THREAD_COPY_LIMIT_BYTES, files: THREAD_COPY_LIMIT_FILES })
  assert.equal(THREAD_COPY_LIMIT_BYTES, 1024 ** 3)
  assert.equal(checkoutLimits({ HOAI_THREAD_COPY_LIMIT_BYTES: '5000' }).bytes, 5000)
  for (const bad of ['', '0', '-3', 'lots', '1e9']) {
    assert.equal(checkoutLimits({ HOAI_THREAD_COPY_LIMIT_BYTES: bad }).bytes, THREAD_COPY_LIMIT_BYTES, bad)
  }
})
