// Disposable Linux proof only. Uses a private bus and extracted official
// libsecret executable. Principal/activation proofs are explicit fixtures.
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import { BrowserProfileSyncKeyStore, runKeyHelper } from '../lib/browser-profile-sync-key-store.mjs'
import { BrowserProfilePortableExtrasStore } from '../lib/browser-profile-portable-extras.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url))), state = process.env.HOAI_PROOF_STATE, phase = process.argv[2]
assert.ok(root.startsWith('/tmp/hoai-extras-native.')); assert.ok(state?.startsWith(root + '/case.'))
const crypto = createRequire(import.meta.url)('../lib/browser-profile-core/crypto.js'), calls = [], secretInputs = []
const run = async (executable, args, options) => {
  assert.ok(['/usr/bin/gdbus', '/usr/bin/secret-tool'].includes(executable))
  assert.deepEqual(Object.keys(options.environment).sort(), ['DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL', 'PATH'])
  if (options.input?.length) { secretInputs.push(Buffer.from(options.input)); assert.equal(JSON.stringify(args).includes(options.input.toString()), false) }
  calls.push(args[0])
  return runKeyHelper(executable === '/usr/bin/secret-tool' ? join(root, 'extracted/usr/bin/secret-tool') : executable, args,
    { ...options, environment: { ...options.environment, LD_LIBRARY_PATH: join(root, 'extracted/usr/lib/x86_64-linux-gnu') } })
}
const keyStore = new BrowserProfileSyncKeyStore({ endpointCrypto: crypto, platform: 'linux', run, hasHelper: () => true, environment: { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } })
const fixture = join(state, 'public-fixture.json'), directory = join(state, 'portable'), password = 'SYNTHETIC_NATIVE_PORTABLE_PASSWORD', username = 'SYNTHETIC_NATIVE_USER'
let data
if (phase === 'missing' || phase === 'create') {
  const endpoint = crypto.createEndpointIdentity(randomUUID())
  data = { binding: { profileId: randomUUID(), actingUserId: 'disposable-recipient', assistantId: 7, endpointId: endpoint.identity.endpointId,
    keyFingerprint: crypto.identityFingerprint(endpoint.identity), grantVersion: 2, keyEpoch: 3, backgroundUse: true }, pinnedIdentity: endpoint.identity }
} else data = JSON.parse(fs.readFileSync(fixture, 'utf8'))
const authority = { ...Object.fromEntries(['profileId', 'actingUserId', 'assistantId', 'endpointId', 'keyFingerprint', 'grantVersion'].map(key => [key, data.binding[key]])),
  bootId: 'synthetic-boot', runtimeId: 'synthetic-runtime', sessionId: 'synthetic-session', writerEpoch: 4, revision: 2, contentKeyEpoch: data.binding.keyEpoch }
const populated = { passwordVault: { v: 1, entries: [{ id: '33000000-0000-4000-8000-000000000003', origin: 'https://fixture.invalid', username, password, name: 'Fixture', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z' }], neverOrigins: ['https://never.invalid'] }, preferences: { v: 1, searchEngine: 'bing' } }
const options = { directory, ...data, keyStore, assertCurrent: () => true }
let store
try {
  if (phase === 'missing') await assert.rejects(() => BrowserProfilePortableExtrasStore.preload({ ...options, createNew: true }), { code: 'profile_key_setup_required' })
  else if (phase === 'locked') {
    await assert.rejects(() => BrowserProfilePortableExtrasStore.preload(options), { code: 'profile_key_unlock_required' }); assert.ok(!calls.includes('lookup'))
  } else {
    store = await BrowserProfilePortableExtrasStore.preload({ ...options, createNew: phase === 'create' })
    if (phase === 'create') {
      store.replaceBundle({ authority, bundle: populated }); fs.writeFileSync(fixture, JSON.stringify(data), { mode: 0o600 })
      const secrets = [...secretInputs, Buffer.from(username), Buffer.from(password)]
      const inspect = dir => { for (const row of fs.readdirSync(dir, { withFileTypes: true })) { const file = join(dir, row.name); if (row.isDirectory()) inspect(file); else if (row.isFile()) { const bytes = fs.readFileSync(file); assert.ok(bytes.length < 32 * 1024 * 1024); for (const secret of secrets) assert.ok(!bytes.includes(secret), 'plaintext secret on private proof disk') } } }
      inspect(directory); inspect(join(state, 'data')); assert.equal(fs.statSync(store.file).mode & 0o777, 0o600)
    } else if (phase === 'restore') {
      assert.deepEqual(store.preflightExtras({ authority }), populated)
      const count = calls.length, lease = store.captureExtras({ authority }); assert.deepEqual(lease.bundle, populated)
      assert.throws(() => store.replaceBundle({ authority, bundle: populated })); await Promise.resolve(); lease.assertCurrent(); assert.equal(calls.length, count); lease.release()
      for (const change of [{ grantVersion: 3 }, { contentKeyEpoch: 4 }, { actingUserId: 'other-user' }]) assert.throws(() => store.preflightExtras({ authority: { ...authority, ...change } }))
    } else if (phase === 'commit') {
      const receipt = { version: 1, kind: 'destination-staged', profileId: authority.profileId, revision: authority.revision, transitionId: randomUUID(), manifestHash: 'a'.repeat(64), stagedInactive: true,
        destination: Object.fromEntries(['endpointId', 'bootId', 'runtimeId', 'sessionId', 'grantVersion', 'keyFingerprint'].map(key => [key, authority[key]])) }
      assert.deepEqual(store.commitExtras({ authority, bundle: populated, receipt, grant: authority }), { committed: true }); assert.throws(() => store.commitExtras({ authority, bundle: populated, receipt, grant: authority }))
    } else if (phase === 'cleanup') {
      const count = calls.length, io = { ...fs, renameSync: () => { throw Error('synthetic fresh publication refusal') } }
      await assert.rejects(() => BrowserProfilePortableExtrasStore.preload({ ...options, directory: join(state, 'failed-fresh'), io, createNew: true }), { code: 'profile_extras_write_uncertain' })
      assert.ok(calls.slice(count).includes('store')); assert.ok(calls.slice(count).includes('clear')); assert.deepEqual(store.preflightExtras({ authority }), populated)
    } else if (phase === 'failure') {
      const before = fs.readFileSync(store.file), io = { ...fs, renameSync: () => { throw Error('synthetic atomic rename refusal') } }; store.io = io
      assert.throws(() => store.replaceBundle({ authority, bundle: populated }), { code: 'profile_extras_write_uncertain' }); assert.deepEqual(fs.readFileSync(store.file), before)
      store.dispose(); store = null; await assert.rejects(() => BrowserProfilePortableExtrasStore.preload(options), { code: 'profile_extras_recovery_required' })
    } else throw Error('unknown fixed probe phase')
  }
} finally { store?.dispose(); for (const value of secretInputs) value.fill(0) }
console.log(JSON.stringify({ phase, pid: process.pid, passed: true, helperCalls: calls.length, providerSource: createHash('sha256').update(fs.readFileSync(join(root, 'lib/browser-profile-portable-extras.mjs'))).digest('hex'), qualification: 'actual Linux fsync/SecretService/private-bus;extracted executable remap;synthetic authority;not unattended provisioning' }))
