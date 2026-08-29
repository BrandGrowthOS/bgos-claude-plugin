import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decideVersionBump, isAdvance, isShippingPath } from '../scripts/check-version-bump.mjs'

test('passes when the version advances and both manifests agree', () => {
  const r = decideVersionBump({
    headPkg: '0.38.6',
    headManifest: '0.38.6',
    basePkg: '0.38.5',
    changedPaths: ['server.ts'],
  })
  assert.equal(r.verdict, 'ok')
})

test('fails when shipping code changed but the version did not advance', () => {
  const r = decideVersionBump({
    headPkg: '0.38.5',
    headManifest: '0.38.5',
    basePkg: '0.38.5',
    changedPaths: ['server.ts'],
  })
  assert.equal(r.verdict, 'not-advanced')
})

test('fails when package.json and plugin.json disagree', () => {
  const r = decideVersionBump({
    headPkg: '0.38.6',
    headManifest: '0.38.5',
    basePkg: '0.38.5',
    changedPaths: ['server.ts'],
  })
  assert.equal(r.verdict, 'mismatch')
})

test('a docs-only PR does not need a bump', () => {
  const r = decideVersionBump({
    headPkg: '0.38.5',
    headManifest: '0.38.5',
    basePkg: '0.38.5',
    changedPaths: ['README.md', 'docs/learnings/x.md'],
  })
  assert.equal(r.verdict, 'no-shipping-change')
})

test('a lower version is not an advance', () => {
  const r = decideVersionBump({
    headPkg: '0.38.4',
    headManifest: '0.38.4',
    basePkg: '0.38.5',
    changedPaths: ['lib/slash-catalog.ts'],
  })
  assert.equal(r.verdict, 'not-advanced')
})

test('shipping paths are distinguished from repo furniture', () => {
  assert.equal(isShippingPath('server.ts'), true)
  assert.equal(isShippingPath('lib/slash-catalog.ts'), true)
  assert.equal(isShippingPath('bin/hoai-core.mjs'), true)
  assert.equal(isShippingPath('docs/learnings/x.md'), false)
  assert.equal(isShippingPath('test/foo.test.ts'), false)
  assert.equal(isShippingPath('.github/workflows/tests.yml'), false)
})

test('isAdvance refuses unparseable input rather than guessing', () => {
  assert.equal(isAdvance('not-a-version', '0.38.5'), false)
  assert.equal(isAdvance('0.38.6', ''), false)
})
