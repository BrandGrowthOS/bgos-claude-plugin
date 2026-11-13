import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'
import { publicProfileSource } from '../scripts/vendor-browser-profile-core.mjs'
import { scratchDir } from './helpers/scratch-dirs'

const root = join(import.meta.dirname, '..'), core = join(root, 'lib/browser-profile-core')
const manifest = JSON.parse(readFileSync(join(core, 'vendor.json'), 'utf8'))
test('public vendor sanitization changes attribution comments and preserves every executable token', () => {
  const samples = {
    'crypto.js': '// Format 2 (S3, Author D2): one content box.\nconst value = "unchanged";\n',
    'sign-in-copy.js': '// browser design, section 6; Author: "sign-ins"\n// ... in a vault"). Same primitives as checkpoints.\n//   - No site in a blocked category (finance, adult, piracy: policy.js), which is\n//     Author\'s call 3. A seal refuses one.\n/**\n * May this machine hold a person\'s sign-ins? Author\'s limit: no secret in model input.\n */\nconst value = "unchanged";\n',
  }
  const tokens = (source: string) => {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source)
    const result: Array<[ts.SyntaxKind, string]> = []
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) result.push([kind, scanner.getTokenText()])
    return result
  }
  for (const [name, source] of Object.entries(samples)) {
    const bytes = publicProfileSource(name, Buffer.from(source))
    assert.doesNotMatch(bytes.toString(), /Author/)
    assert.deepEqual(tokens(bytes.toString()), tokens(source))
    assert.ok(publicProfileSource(name, bytes).equals(bytes), 'the public copy is stable on another pass')
    assert.ok(publicProfileSource('unrelated.js', Buffer.from(source)).equals(Buffer.from(source)), 'other copies stay byte-identical')
  }
  const opaque = Buffer.from([0xff, 0x00])
  assert.equal(publicProfileSource('unrelated.js', opaque), opaque, 'unrelated bytes are never decoded or rewritten')
})

test('only the two sanitized vendor copies carry separate upstream and public hashes', () => {
  const sanitized = Object.entries(manifest.files).filter(([, pin]: [string, any]) => pin.upstreamSha256)
  assert.deepEqual(sanitized.map(([name]) => name).sort(), ['crypto.js', 'sign-in-copy.js'])
  for (const [name, pin] of sanitized as Array<[string, any]>) {
    assert.match(pin.upstreamSha256, /^[a-f0-9]{64}$/)
    assert.notEqual(pin.sha256, pin.upstreamSha256)
    const bytes = readFileSync(join(core, name))
    assert.ok(publicProfileSource(name, bytes).equals(bytes))
  }
})

test('the vendor CLI copies and verifies sanitized committed source, and rejects a changed public copy', () => {
  const temp = scratchDir('public-vendor-'), source = join(temp, 'source'), plugin = join(temp, 'plugin')
  const sourcePath = join('frontend', 'electron-app', 'agent-browser', 'profile-sync')
  mkdirSync(join(source, sourcePath), { recursive: true })
  mkdirSync(join(plugin, 'scripts'), { recursive: true })
  const script = join(plugin, 'scripts', 'vendor-browser-profile-core.mjs')
  copyFileSync(join(root, 'scripts', 'vendor-browser-profile-core.mjs'), script)
  for (const name of Object.keys(manifest.files)) {
    let bytes = readFileSync(join(core, name), 'utf8')
    if (name === 'crypto.js') bytes = bytes.replace('// Format 2 (S3, D2):', '// Format 2 (S3, Author D2):')
    writeFileSync(join(source, sourcePath, name), bytes)
  }
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: source, encoding: 'utf8', env: {
      ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    } })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git(['init', '--quiet'])
  git(['add', '.'])
  git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture source'])
  const commit = git(['rev-parse', 'HEAD'])
  const alias = join(temp, 'linked-plugin')
  symlinkSync(plugin, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const run = (write = false) => spawnSync(process.execPath, [join(alias, 'scripts', 'vendor-browser-profile-core.mjs'), '--source', source, '--ref', commit, ...(write ? ['--write'] : [])], { encoding: 'utf8' })
  const copied = run(true)
  assert.equal(copied.status, 0, copied.stderr)
  assert.equal(JSON.parse(copied.stdout).mode, 'copied-committed-source')
  const destination = join(plugin, 'lib', 'browser-profile-core', 'crypto.js')
  assert.equal(readFileSync(destination, 'utf8'), readFileSync(join(core, 'crypto.js'), 'utf8'))
  const pin = JSON.parse(readFileSync(join(plugin, 'lib', 'browser-profile-core', 'vendor.json'), 'utf8')).files['crypto.js']
  assert.notEqual(pin.upstreamSha256, pin.sha256)
  // Verification reads the declared commit, even when its source working copy changes.
  writeFileSync(join(source, sourcePath, 'crypto.js'), 'not the committed source')
  const verified = run()
  assert.equal(verified.status, 0, verified.stderr)
  assert.equal(JSON.parse(verified.stdout).mode, 'verified')
  writeFileSync(destination, readFileSync(destination, 'utf8') + '\n')
  const changed = run()
  assert.notEqual(changed.status, 0)
  assert.match(changed.stderr, /differs from committed source/)
})

test('profile codecs ship exactly the pinned committed bytes and CommonJS boundary', () => {
  assert.deepEqual(readdirSync(core).filter(name => name.endsWith('.js')).sort(), Object.keys(manifest.files).sort())
  assert.deepEqual(Object.keys(manifest.files).sort(), ['sign-in-copy.js', 'sign-in-copy-client.js', 'active-backup-client.js', 'active-backup-scheduler.js', 'active-backup-wire.js', 'active-backup-crypto.js', 'live-backup-input.js', 'live-backup-capture.js', 'live-storage-reader.js', 'backup-seal-client.js', 'backup-seal-worker.js', 'backup-journal.js', 'backup-journal-worker.js', 'checkpoint-store.js', 'coordinator-client.js', 'crypto.js', 'native-runtime.js', 'portable-state.js', 'profile-file-client.js', 'profile-file-crypto.js', 'profile-file-staging.js', 'profile-file-wire.js', 'resume-tabs.js', 'return-intent.js', 'runtime-endpoint.js', 'runtime-readiness.js', 'runtime-status-client.js', 'stopped-head-stage.js', 'storage.js'].sort())
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
  assert.equal(require('../lib/browser-profile-core/portable-state.js').SCHEMA_V2, 'hoai-portable-profile-state-v2')
  assert.equal(typeof require('../lib/browser-profile-core/resume-tabs.js').validateResumeTabs, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/runtime-readiness.js').validateRuntimeRequestStatus, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/native-runtime.js').cookies, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/coordinator-client.js').documentSignature, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/runtime-endpoint.js').ProfileRuntimeEndpoint, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/stopped-head-stage.js').createStoppedHeadStageAuthorization, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/stopped-head-stage.js').createAgentStoppedHeadStageAuthorization, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/checkpoint-store.js').EncryptedCheckpointStore, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/runtime-status-client.js').ProfileRuntimeStatusClient, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/return-intent.js').verifyReturnSourceStopped, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/profile-file-crypto.js').sealFile, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/profile-file-wire.js').statusOf, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/profile-file-client.js').ProfileFileClient.prototype.pendingReviewed, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/profile-file-staging.js').ProfileFileStaging, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/active-backup-client.js').PairedActiveBackupClient.prototype.endpointContext, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/active-backup-scheduler.js').ActiveBackupScheduler, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/live-backup-capture.js').NativeLiveBackupCapture, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/backup-seal-client.js').BackupSealWorker, 'function')
  assert.equal(typeof require('../lib/browser-profile-core/backup-journal.js').EncryptedBackupJournal, 'function')
  assert.match(readFileSync(join(root, '.gitattributes'), 'utf8'), /^lib\/browser-profile-core\/\*\.js text eol=lf$/m)
})
test('cross-tree verification reads the declared commit, not a mutable working copy', { skip: !process.env.HOAI_BROWSER_PROFILE_CORE_SOURCE && 'BGOS source checkout not present; local committed pin is always checked' }, () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts/vendor-browser-profile-core.mjs'), '--source', process.env.HOAI_BROWSER_PROFILE_CORE_SOURCE!, '--ref', manifest.sourceCommit], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
