import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = join(import.meta.dirname, '..'), core = join(root, 'lib/browser-profile-core')
const manifest = JSON.parse(readFileSync(join(core, 'vendor.json'), 'utf8'))
test('profile codecs ship exactly the pinned committed bytes and CommonJS boundary', () => {
  assert.deepEqual(readdirSync(core).filter(name => name.endsWith('.js')).sort(), Object.keys(manifest.files).sort())
  assert.deepEqual(Object.keys(manifest.files).sort(), ['coordinator-client.js', 'crypto.js', 'native-runtime.js', 'portable-state.js', 'runtime-endpoint.js', 'stopped-head-stage.js', 'storage.js'])
  assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/)
  for (const [name, pin] of Object.entries(manifest.files) as Array<[string, any]>) {
    const bytes = readFileSync(join(core, name)); assert.equal(bytes.includes(13), false)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256)
    assert.equal(pin.source, `BGOS: frontend/electron-app/agent-browser/profile-sync/${name}`)
  }
  assert.equal(JSON.parse(readFileSync(join(core, 'package.json'), 'utf8')).type, 'commonjs')
  const require = createRequire(import.meta.url)
  assert.equal(typeof require('../lib/browser-profile-core/crypto.js').sealCheckpoint, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/storage.js').createStorageAdapter, 'function')
  assert.equal(require('../lib/browser-profile-core/portable-state.js').SCHEMA, 'hoai-portable-profile-state-v1')
  assert.equal(typeof require('../lib/browser-profile-core/native-runtime.js').cookies, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/coordinator-client.js').documentSignature, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/runtime-endpoint.js').ProfileRuntimeEndpoint, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/stopped-head-stage.js').createStoppedHeadStageAuthorization, 'function')
  assert.match(readFileSync(join(root, '.gitattributes'), 'utf8'), /^lib\/browser-profile-core\/\*\.js text eol=lf$/m)
})
test('cross-tree verification reads the declared commit, not a mutable working copy', { skip: !process.env.HOAI_BROWSER_PROFILE_CORE_SOURCE && 'BGOS source checkout not present; local committed pin is always checked' }, () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts/vendor-browser-profile-core.mjs'), '--source', process.env.HOAI_BROWSER_PROFILE_CORE_SOURCE!, '--ref', manifest.sourceCommit], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
