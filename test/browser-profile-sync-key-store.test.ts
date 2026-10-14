import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { BrowserProfileSyncKeyStore, keyHelperEnvironment, runKeyHelper } from '../lib/browser-profile-sync-key-store.mjs'

const identity = { version: 1, endpointId: '11000000-0000-4000-8000-000000000001', signingPublicKey: 'synthetic-public-sign', encryptionPublicKey: 'synthetic-public-encryption' }
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// The codec double delegates encryption to the actual protected provider. The
// separate opt-in case below checks the real shared endpoint crypto module.
const codec = {
  identityFingerprint: fingerprint,
  protectEndpointKeys({ endpoint, safeStorage }: any) { return { version: 1, identityFingerprint: fingerprint(endpoint.identity), ciphertext: safeStorage.encryptString(JSON.stringify(endpoint)).toString('base64url') } },
  restoreEndpointKeys({ record, pinnedIdentity, safeStorage }: any) {
    const endpoint = JSON.parse(safeStorage.decryptString(Buffer.from(record.ciphertext, 'base64url')))
    assert.deepEqual(endpoint.identity, pinnedIdentity); return endpoint
  },
}
const endpoint = { identity, privateFixture: 'SYNTHETIC_ENDPOINT_PRIVATE_KEY' }
const binding = { profileId: '22000000-0000-4000-8000-000000000002', actingUserId: 'human-recipient', assistantId: 42,
  endpointId: identity.endpointId, keyFingerprint: fingerprint(identity), grantVersion: 1, keyEpoch: 1, backgroundUse: true }
const environment = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/hoai-private-test-bus,guid=1234567890abcdef1234567890abcdef',
  SSH_AUTH_SOCK: '/sensitive/ssh.sock', ANTHROPIC_API_KEY: 'synthetic-api-secret', DISPLAY: ':1', LD_PRELOAD: '/untrusted.so', NODE_OPTIONS: '--inspect' }
const current = () => {}

function fixture(options: Record<string, any> = {}) {
  const calls: any[] = [], values = new Map<string, Buffer>()
  let locked = false
  const run = async (executable: string, args: string[], settings: any) => {
    calls.push({ executable, args: [...args], environment: settings.environment, input: Buffer.from(settings.input || '') })
    if (options.onCall) await options.onCall(executable, args, settings)
    if (executable === '/usr/bin/gdbus') {
      if (args.includes('org.freedesktop.Secret.Service.ReadAlias')) return { code: 0, output: Buffer.from("(objectpath '/org/freedesktop/secrets/collection/login',)\n") }
      assert.ok(args.includes('org.freedesktop.Secret.Collection'))
      return { code: 0, output: Buffer.from(`(<${locked ? 'true' : 'false'}>,)\n`) }
    }
    assert.equal(executable, '/usr/bin/secret-tool')
    const key = args.slice(args.indexOf('application')).join('|')
    if (args[0] === 'store') { values.set(key, Buffer.from(settings.input)); return { code: 0, output: Buffer.alloc(0) } }
    if (args[0] === 'clear') { values.delete(key); return { code: 0, output: Buffer.alloc(0) } }
    assert.equal(args[0], 'lookup')
    return { code: values.has(key) ? 0 : 1, output: Buffer.from(values.get(key) || '') }
  }
  const store = new BrowserProfileSyncKeyStore({ endpointCrypto: options.codec || codec, environment, platform: 'linux', run, hasHelper: () => true, ...options })
  return { store, calls, values, lock: () => { locked = true } }
}

test('portable extras unlock preloads a purpose-separated synchronous protector and disposal invalidates it', async () => {
  const f = fixture(), endpointRecord = await f.store.protect({ binding, endpoint, assertCurrent: current })
  const protector = await f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, createNew: true, assertCurrent: current })
  const count = f.calls.length, text = 'SYNTHETIC_PORTABLE_EXTRAS', ciphertext = protector.encryptString(text)
  assert.equal(protector.decryptString(ciphertext), text); assert.equal(f.calls.length, count)
  const metadata = protector.record; protector.dispose()
  assert.throws(() => protector.encryptString(text)); assert.throws(() => protector.decryptString(ciphertext))
  const restored = await f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, record: metadata, assertCurrent: current })
  try { assert.equal(restored.decryptString(ciphertext), text) } finally { restored.dispose() }
  assert.ok([...f.values.keys()].some(value => value.includes('hoai-browser-portable-extras-v1')))
  assert.ok([...f.values.keys()].some(value => value.includes('hoai-browser-profile-sync-v1')))
  await assert.rejects(() => f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, record: endpointRecord, assertCurrent: current }))
})

test('portable protector refuses a false or asynchronous proof and exact binding changes before helper lookup', async () => {
  const f = fixture(), protector = await f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, createNew: true, assertCurrent: current }), count = f.calls.length
  try {
    for (const change of [{ keyEpoch: 2 }, { grantVersion: 2 }, { actingUserId: 'sharer' }]) await assert.rejects(() => f.store.preloadPortableExtrasProtector({ binding: { ...binding, ...change }, pinnedIdentity: identity, record: protector.record, assertCurrent: current }))
    for (const proof of [() => false, async () => true]) await assert.rejects(() => f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, createNew: true, assertCurrent: proof }))
    assert.equal(f.calls.length, count)
  } finally { protector.dispose() }
  let allowed = true
  const active = await f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, createNew: true, assertCurrent: () => allowed })
  try { const bytes = active.encryptString('SYNTHETIC_CURRENT_SCOPE'); allowed = false; assert.throws(() => active.encryptString('SYNTHETIC_CURRENT_SCOPE')); assert.throws(() => active.decryptString(bytes)) }
  finally { active.dispose() }
})

test('portable protection domain separation and authentication do not accept endpoint ciphertext even with a substituted OS key', async () => {
  const f = fixture(), endpointRecord = await f.store.protect({ binding, endpoint, assertCurrent: current })
  const protector = await f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, createNew: true, assertCurrent: current }), metadata = { ...protector.record, recordId: endpointRecord.recordId }
  protector.dispose()
  const entries = [...f.values.entries()]; f.values.set(entries[1][0].replace(protector.record.recordId, endpointRecord.recordId), Buffer.from(entries[0][1]))
  const restored = await f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, record: metadata, assertCurrent: current })
  try {
    assert.throws(() => restored.decryptString(Buffer.from(endpointRecord.keys.ciphertext, 'base64url')))
    const bytes = restored.encryptString('SYNTHETIC_SECRET'); bytes[bytes.length - 1] ^= 1; assert.throws(() => restored.decryptString(bytes))
    assert.throws(() => restored.encryptString('x'.repeat(16 * 1024 * 1024 + 1)))
  } finally { restored.dispose() }
})

test('portable protector disposal clears the actual retained native AES key buffer', async () => {
  const f = fixture(), protector = await f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, createNew: true, assertCurrent: current })
  const nativeCrypto = createRequire(import.meta.url)('node:crypto'), original = nativeCrypto.createCipheriv, retained:Buffer[] = []
  nativeCrypto.createCipheriv = (...args:any[]) => { if (Buffer.isBuffer(args[1])) retained.push(args[1]); return Reflect.apply(original, nativeCrypto, args) }
  syncBuiltinESMExports()
  try { protector.encryptString('SYNTHETIC_KEY_LIFETIME'); assert.ok(retained.some(value => value.some(byte => byte !== 0))); protector.dispose() }
  finally { nativeCrypto.createCipheriv = original; syncBuiltinESMExports(); protector.dispose() }
  assert.ok(retained.length > 0); assert.ok(retained.every(value => value.every(byte => byte === 0)))
})

test('only a newly-created disposed portable protector can delete its exact OS item', async () => {
  const f = fixture(), existing = await f.store.protect({ binding, endpoint, assertCurrent: current })
  const protector = await f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, createNew: true, assertCurrent: current }), metadata = protector.record
  await assert.rejects(() => protector.discardCreatedRecord()); assert.equal(f.values.size, 2)
  protector.dispose(); assert.deepEqual(await protector.discardCreatedRecord(), { removed: true }); assert.equal(f.values.size, 1)
  assert.deepEqual(await f.store.restore({ record: existing, binding, pinnedIdentity: identity, assertCurrent: current }), endpoint)
  const prior = await f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, createNew: true, assertCurrent: current }), saved = prior.record; prior.dispose()
  const loaded = await f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, record: saved, assertCurrent: current }); loaded.dispose()
  await assert.rejects(() => loaded.discardCreatedRecord()); assert.equal(f.values.size, 2)
})

test('authorized persistent record roundtrips after a fresh store without putting endpoint keys or wrapping keys in argv or files', async () => {
  const f = fixture(), record = await f.store.protect({ binding, endpoint, assertCurrent: current })
  const restored = await f.store.restore({ record, binding, pinnedIdentity: identity, assertCurrent: current })
  assert.deepEqual(restored, endpoint); assert.equal(f.values.size, 1)
  const command = f.calls.find(call => call.args[0] === 'store')
  assert.match(command.input.toString(), /^[A-Za-z0-9_-]{43}$/)
  assert.equal(command.args.includes('--collection=/org/freedesktop/secrets/collection/login'), true)
  for (const call of f.calls) {
    assert.equal(JSON.stringify(call.args).includes(command.input.toString()), false)
    assert.equal(JSON.stringify(call.args).includes(endpoint.privateFixture), false)
    assert.deepEqual(Object.keys(call.environment).sort(), ['DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL', 'PATH'])
  }
  assert.equal(JSON.stringify(record).includes(endpoint.privateFixture), false)
  assert.equal(JSON.stringify(record).includes(command.input.toString()), false)
})

test('background-use consent and a current trusted authority are required before any key helper starts', async () => {
  const f = fixture()
  await assert.rejects(() => f.store.protect({ binding: { ...binding, backgroundUse: false }, endpoint, assertCurrent: current }), { code: 'profile_key_background_grant_required' })
  await assert.rejects(() => f.store.protect({ binding, endpoint, assertCurrent: () => { throw new Error('revoked synthetic proof') } }), { code: 'profile_key_context_changed' })
  await assert.rejects(() => f.store.protect({ binding, endpoint, assertCurrent: () => false }), { code: 'profile_key_context_changed' })
  await assert.rejects(() => f.store.protect({ binding, endpoint } as any), { code: 'profile_key_context_changed' })
  assert.equal(f.calls.length, 0)
})

test('every persistent identity, grant and content-key epoch must exactly match before lookup', async () => {
  const f = fixture(), record = await f.store.protect({ binding, endpoint, assertCurrent: current }), count = f.calls.length
  for (const change of [{ actingUserId: 'human-sharer' }, { assistantId: 43 }, { profileId: '33000000-0000-4000-8000-000000000003' },
    { endpointId: '44000000-0000-4000-8000-000000000004' }, { keyFingerprint: 'a'.repeat(64) }, { grantVersion: 2 }, { keyEpoch: 2 }]) {
    await assert.rejects(() => f.store.restore({ record, binding: { ...binding, ...change }, pinnedIdentity: identity, assertCurrent: current }), { code: 'profile_key_refused' })
  }
  await assert.rejects(() => f.store.restore({ record, binding, pinnedIdentity: { ...identity, signingPublicKey: 'substitution' }, assertCurrent: current }), { code: 'profile_key_refused' })
  assert.equal(f.calls.length, count)
})

test('fresh protection uses a fresh OS wrapping key and new-epoch records cannot be opened with the old one', async () => {
  const f = fixture(), first = await f.store.protect({ binding, endpoint, assertCurrent: current })
  const next = { ...binding, keyEpoch: 2, grantVersion: 2 }, second = await f.store.protect({ binding: next, endpoint, assertCurrent: current })
  const stored = [...f.values.entries()]
  assert.notEqual(first.recordId, second.recordId); assert.notDeepEqual(stored[0][1], stored[1][1])
  const replacement = Buffer.from(stored[1][1]); f.values.set(stored[1][0], stored[0][1])
  await assert.rejects(() => f.store.restore({ record: second, binding: next, pinnedIdentity: identity, assertCurrent: current }), { code: 'profile_key_refused' })
  f.values.set(stored[1][0], replacement)
  assert.deepEqual(await f.store.restore({ record: second, binding: next, pinnedIdentity: identity, assertCurrent: current }), endpoint)
})

test('locked or missing backends require setup or unlock without automatic unlock commands or plaintext fallback', async () => {
  const f = fixture(); f.lock()
  assert.deepEqual(await f.store.status({ binding, assertCurrent: current }), { state: 'unlock_required', reason: 'profile_key_unlock_required' })
  await assert.rejects(() => f.store.protect({ binding, endpoint, assertCurrent: current }), { code: 'profile_key_unlock_required' })
  assert.equal(f.calls.some(call => call.executable === '/usr/bin/secret-tool'), false)
  assert.equal(f.calls.some(call => call.args.some((arg: string) => arg.includes('--unlock'))), false)
  const missing = fixture({ run: async () => { throw Object.assign(new Error('sensitive native diagnostic'), { code: 'ENOENT' }) } })
  assert.deepEqual(await missing.store.status({ binding, assertCurrent: current }), { state: 'setup_required', reason: 'profile_key_setup_required' })
  const missingHelper = fixture({ hasHelper: () => false })
  assert.equal((await missingHelper.store.status({ binding, assertCurrent: current })).state, 'setup_required'); assert.equal(missingHelper.calls.length, 0)
  for (const platform of ['win32', 'darwin']) {
    const other = fixture({ platform })
    assert.deepEqual(await other.store.status({ binding, assertCurrent: current }), { state: 'manual_unlock_required', reason: 'profile_key_manual_unlock_required' })
    assert.equal(other.calls.length, 0)
  }
})

test('grant loss after storing cleans only its new key and never returns a usable record', async () => {
  let valid = true
  const f = fixture({ onCall: (_executable: string, args: string[]) => { if (args[0] === 'store') valid = false } })
  await assert.rejects(() => f.store.protect({ binding, endpoint, assertCurrent: () => { if (!valid) throw new Error('revoked') } }), { code: 'profile_key_context_changed' })
  assert.equal(f.values.size, 0); assert.equal(f.calls.at(-1).args[0], 'clear')
})

test('revocation cleanup requires trusted authority and removes only the exact record', async () => {
  const f = fixture(), first = await f.store.protect({ binding, endpoint, assertCurrent: current }), second = await f.store.protect({ binding, endpoint, assertCurrent: current })
  await assert.rejects(() => f.store.remove({ record: first, binding } as any), { code: 'profile_key_context_changed' })
  assert.deepEqual(await f.store.remove({ record: first, binding, assertRevoked: current }), { removed: true }); assert.equal(f.values.size, 1)
  assert.deepEqual(await f.store.restore({ record: second, binding, pinnedIdentity: identity, assertCurrent: current }), endpoint)
  await assert.rejects(() => f.store.restore({ record: first, binding, pinnedIdentity: identity, assertCurrent: current }), { code: 'profile_key_setup_required' })
})

test('malformed records and altered ciphertext fail closed without native error or secret text', async () => {
  const f = fixture(), record = await f.store.protect({ binding, endpoint, assertCurrent: current })
  for (const changed of [{ ...record, version: 2 }, { ...record, extra: true }, { ...record, recordId: '../other' }, { ...record, keys: { version: 1, ciphertext: 'a'.repeat(20000) } }]) {
    await assert.rejects(() => f.store.restore({ record: changed, binding, pinnedIdentity: identity, assertCurrent: current }), { code: 'profile_key_refused' })
  }
  const changed = structuredClone(record); changed.keys.ciphertext = Buffer.from('tampered fixture').toString('base64url')
  await assert.rejects(() => f.store.restore({ record: changed, binding, pinnedIdentity: identity, assertCurrent: current }), { code: 'profile_key_refused' })
  const tagged = structuredClone(record), bytes = Buffer.from(tagged.keys.ciphertext, 'base64url'); bytes[bytes.length - 1] ^= 1
  tagged.keys.ciphertext = bytes.toString('base64url')
  await assert.rejects(() => f.store.restore({ record: tagged, binding, pinnedIdentity: identity, assertCurrent: current }), { code: 'profile_key_refused' })
})

for (const badTag of [false, true]) test(`provider clears decrypted chunks and joined bytes after ${badTag ? 'a bad GCM tag' : 'an approved restore'}`, async () => {
  const f = fixture(), record = await f.store.protect({ binding, endpoint, assertCurrent: current })
  if (badTag) { const bytes = Buffer.from(record.keys.ciphertext, 'base64url'); bytes[bytes.length - 1] ^= 1; record.keys.ciphertext = bytes.toString('base64url') }
  const nativeCrypto = createRequire(import.meta.url)('node:crypto'), original = nativeCrypto.createDecipheriv, concat = Buffer.concat, retained:Buffer[] = [], joined:Buffer[] = []
  let sawSecret = false
  nativeCrypto.createDecipheriv = (...args:any[]) => {
    const cipher:any = Reflect.apply(original, nativeCrypto, args)
    for (const method of ['update', 'final']) {
      const command = cipher[method].bind(cipher)
      cipher[method] = (...values:any[]) => { const bytes:Buffer = command(...values); retained.push(bytes); sawSecret ||= bytes.some(value => value !== 0); return bytes }
    }
    return cipher
  }
  Buffer.concat = ((list:readonly Uint8Array[], ...args:any[]) => { const bytes = Reflect.apply(concat, Buffer, [list, ...args]); if (retained.length && list.every(value => retained.includes(value as Buffer))) joined.push(bytes); return bytes }) as typeof Buffer.concat
  syncBuiltinESMExports()
  try {
    if (badTag) await assert.rejects(() => f.store.restore({ record, binding, pinnedIdentity: identity, assertCurrent: current }), { code: 'profile_key_refused' })
    else assert.deepEqual(await f.store.restore({ record, binding, pinnedIdentity: identity, assertCurrent: current }), endpoint)
  } finally { nativeCrypto.createDecipheriv = original; Buffer.concat = concat; syncBuiltinESMExports() }
  assert.ok(sawSecret); assert.ok(retained.length > 0)
  assert.ok(retained.every(bytes => bytes.every(value => value === 0)))
  assert.equal(joined.length, badTag ? 0 : 1)
  assert.ok(joined.every(bytes => bytes.every(value => value === 0)))
})

test('key helper environment refuses remote buses and strips secret or executable injection capabilities', () => {
  assert.deepEqual(keyHelperEnvironment(environment), { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', DBUS_SESSION_BUS_ADDRESS: environment.DBUS_SESSION_BUS_ADDRESS })
  for (const address of [undefined, 'tcp:host=remote,port=123', 'autolaunch:', 'unix:path=/tmp/bus\nLD_PRELOAD=x', 'unix:path=/tmp/bus;tcp:host=x']) {
    assert.throws(() => keyHelperEnvironment({ DBUS_SESSION_BUS_ADDRESS: address }), { code: 'profile_key_setup_required' })
  }
})

test('real helper subprocess reads secrets only from stdin and keeps environment and output bounded', async () => {
  const input = Buffer.from('SYNTHETIC_PIPE_SECRET'), args = ['-e', "let chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>process.stdout.write(JSON.stringify({input:Buffer.concat(chunks).toString(),args:process.argv.slice(1),env:Object.keys(process.env)})))"]
  const result = await runKeyHelper(process.execPath, args, { environment: keyHelperEnvironment(environment), input, timeoutMs: 3000 })
  assert.equal(result.code, 0)
  const value = JSON.parse(result.output.toString()); assert.equal(value.input, input.toString()); assert.deepEqual(value.args, [])
  assert.equal(value.env.includes('SSH_AUTH_SOCK'), false); assert.equal(args.join(' ').includes(input.toString()), false); result.output.fill(0)
  await assert.rejects(() => runKeyHelper(process.execPath, ['-e', "process.stdout.write('x'.repeat(9000))"], { environment: {}, timeoutMs: 3000, maxBytes: 128 }), { code: 'profile_key_refused' })
  await assert.rejects(() => runKeyHelper(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { environment: {}, timeoutMs: 30 }), { code: 'profile_key_unlock_required' })
})

test('actual shared endpoint crypto interoperates with the OS-provider adapter', { skip: !process.env.HOAI_PROFILE_SYNC_CRYPTO_SOURCE && 'Set HOAI_PROFILE_SYNC_CRYPTO_SOURCE to the shared committed or review source until vendoring lands.' }, async () => {
  const actual = createRequire(import.meta.url)(process.env.HOAI_PROFILE_SYNC_CRYPTO_SOURCE!)
  const endpoint = actual.createEndpointIdentity(identity.endpointId), exact = { ...binding, keyFingerprint: actual.identityFingerprint(endpoint.identity) }
  const f = fixture({ codec: actual }), record = await f.store.protect({ binding: exact, endpoint, assertCurrent: current })
  const restored = await f.store.restore({ record, binding: exact, pinnedIdentity: endpoint.identity, assertCurrent: current })
  assert.equal(restored.signingPrivateKey.export({ type: 'pkcs8', format: 'der' }).equals(endpoint.signingPrivateKey.export({ type: 'pkcs8', format: 'der' })), true)
})
