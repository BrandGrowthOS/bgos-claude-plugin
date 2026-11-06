import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('the public repository tracks no docs/evidence files', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url))
  const tracked = execFileSync('git', ['ls-files', '-z', '--', 'docs/evidence/'], { cwd, encoding: 'utf8' })
  assert.equal(tracked, '', 'remove raw evidence from the public repository index')
})
