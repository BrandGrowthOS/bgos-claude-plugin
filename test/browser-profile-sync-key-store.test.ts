import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

test('failed portable preload zeroes its actual wrapping key before awaiting OS cleanup', async () => {
  const nativeCrypto = createRequire(import.meta.url)('node:crypto'), original = nativeCrypto.randomBytes, retained:Buffer[] = []
  let current = true, observed = false
  nativeCrypto.randomBytes = (...args:any[]) => { const bytes = Reflect.apply(original, nativeCrypto, args); if (args[0] === 32 && Buffer.isBuffer(bytes)) retained.push(bytes); return bytes }
  syncBuiltinESMExports()
  const f = fixture({ onCall: async (_executable:string, args:string[]) => {
    if (args[0] === 'store') current = false
    if (args[0] === 'clear') { assert.ok(retained.length > 0); assert.ok(retained.every(value => value.every(byte => byte === 0))); observed = true; await Promise.resolve() }
  } })
  try { await assert.rejects(() => f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, createNew: true, assertCurrent: () => current }), { code: 'profile_key_context_changed' }) }
  finally { nativeCrypto.randomBytes = original; syncBuiltinESMExports() }
  assert.equal(observed, true); assert.equal(f.values.size, 0)
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
  for (const platform of ['win32', 'freebsd']) {
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

const helperTurn = () => new Promise(resolve => setImmediate(resolve))
async function helperUntil(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) { assert.ok(Date.now() < deadline, 'synthetic helper phase did not settle'); await helperTurn() }
}
function helperChild(events: string[], role = 'helper') {
  const child: any = Object.assign(new EventEmitter(), { pid: 900001, closed: false, kills: 0, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: new EventEmitter() })
  child.stdin.end = () => {}
  child.kill = (signal: string) => { assert.equal(signal, 'SIGKILL'); child.kills++; events.push(role + ':kill'); return true }
  child.close = (code: number | null = 0) => {
    if (child.closed) return
    child.closed = true; child.stdout?.emit('end'); child.stderr?.emit('end'); events.push(role + ':close')
    child.emit('exit', code, null); child.emit('close', code, null)
  }
  return child
}
function helperSpawnSeam(spawn: (...args: any[]) => any) {
  const native = createRequire(import.meta.url)('node:child_process'), original = native.spawn
  native.spawn = spawn; syncBuiltinESMExports()
  return () => { native.spawn = original; syncBuiltinESMExports() }
}

for (const trigger of ['timeout', 'abort', 'overflow', 'error'] as const) test(`original key helper owns physical close after ${trigger}, preserving its first safe error and zeroing late output`, { timeout: 5000 }, async () => {
  const child = helperChild([]), controller = new AbortController(), restore = helperSpawnSeam(() => child)
  const retained = Buffer.from('ok'), late = Buffer.from('late'); let settled = false
  const expected = { timeout: 'profile_key_unlock_required', abort: 'profile_key_context_changed', overflow: 'profile_key_refused', error: 'profile_key_setup_required' }[trigger]
  const work = runKeyHelper('/usr/bin/secret-tool', ['SYNTHETIC_NEVER_EXECUTED'], { timeoutMs: trigger === 'timeout' ? 5 : 1000, maxBytes: 8, signal: controller.signal })
  const observed = work.then(() => { settled = true; return 'unexpected success' }, error => { settled = true; return error.code })
  try {
    child.stdout.emit('data', retained)
    if (trigger === 'abort') controller.abort()
    if (trigger === 'overflow') child.stdout.emit('data', Buffer.alloc(9, 120))
    if (trigger === 'error') child.emit('error', new Error('PRIVATE_NATIVE_FAILURE'))
    await helperUntil(() => child.kills > 0); await helperTurn()
    assert.equal(settled, false, 'logical failure must retain the original physical helper')
    assert.equal(child.kills, 1); assert.ok(retained.every(value => value === 0))
    child.stdout.emit('data', late); assert.ok(late.every(value => value === 0))
    controller.abort(); assert.equal(child.kills, 1)
    child.close(0) // A late successful exit cannot replace the first refusal.
    assert.equal(await observed, expected)
  } finally { child.close(); await observed; restore() }
})

test('normal key helper success waits original close, even after exit and both output streams end', async () => {
  const child = helperChild([]), restore = helperSpawnSeam(() => child), chunk = Buffer.from('ok'); let settled = false
  const work = runKeyHelper('/usr/bin/secret-tool', ['SYNTHETIC_NEVER_EXECUTED']).then(value => { settled = true; return value })
  try {
    child.stdout.emit('data', chunk); child.emit('exit', 0); child.stdout.emit('end'); child.stderr.emit('end'); await helperTurn()
    assert.equal(settled, false); child.close(); const value = await work
    assert.equal(value.code, 0); assert.equal(value.output.toString(), 'ok'); value.output.fill(0)
    assert.ok(chunk.every(byte => byte === 0)); assert.equal(child.kills, 0)
  } finally { child.close(); await work; restore() }
})

test('no-child pre-abort and synchronous launch failure refuse immediately without a stop request', async () => {
  let spawned = 0; const restore = helperSpawnSeam(() => { spawned++; throw new Error('PRIVATE_LAUNCH_ERROR') })
  try {
    const controller = new AbortController(); controller.abort()
    await assert.rejects(runKeyHelper('/usr/bin/secret-tool', [], { signal: controller.signal }), { code: 'profile_key_context_changed' }); assert.equal(spawned, 0)
    await assert.rejects(runKeyHelper('/usr/bin/secret-tool', []), { code: 'profile_key_setup_required' }); assert.equal(spawned, 1)
  } finally { restore() }
})

test('a no-PID error still retains the original ChildProcess close without signalling an unknown process', async () => {
  const child = helperChild([]); child.pid = undefined
  const restore = helperSpawnSeam(() => child); let settled = false
  const observed = runKeyHelper('/usr/bin/secret-tool', []).then(() => { settled = true; return '' }, error => { settled = true; return error.code })
  try { child.emit('error', new Error('ENOENT')); await helperTurn(); assert.equal(settled, false); assert.equal(child.kills, 0); child.close(-1); assert.equal(await observed, 'profile_key_setup_required') }
  finally { child.close(); await observed; restore() }
})

for (const trigger of ['missing-stream', 'stdin-throw', 'stop-throw'] as const) test(`key helper retains original close when ${trigger} leaves cleanup unknown`, async () => {
  const child = helperChild([])
  if (trigger === 'missing-stream') child.stdout = null
  if (trigger === 'stdin-throw') child.stdin.end = () => { throw new Error('PRIVATE_PIPE_ERROR') }
  if (trigger === 'stop-throw') child.kill = () => { child.kills++; throw new Error('PRIVATE_STOP_ERROR') }
  const restore = helperSpawnSeam(() => child); let settled = false
  const observed = runKeyHelper('/usr/bin/secret-tool', [], { timeoutMs: trigger === 'stop-throw' ? 5 : 1000 }).then(() => { settled = true; return '' }, error => { settled = true; return error.code })
  try {
    await helperUntil(() => child.kills > 0); await helperTurn(); assert.equal(settled, false)
    child.close(); assert.equal(await observed, trigger === 'stop-throw' ? 'profile_key_unlock_required' : 'profile_key_setup_required')
  } finally { child.close(); await observed; restore() }
})

for (const mode of ['endpoint-timeout', 'endpoint-abort', 'portable-timeout', 'host-stop'] as const) test(`failed OS store cleanup waits original close (${mode})`, { timeout: 5000 }, async () => {
  const children: any[] = [], events: string[] = [], controller = new AbortController()
  let original: any, inputCopy: Buffer | undefined, storeAttributes: string[] | undefined, clearAttributes: string[] | undefined
  let settled = false, hostStopped = false, saved = false, companion: any, host: any, stopping: Promise<void> | undefined
  const restore = helperSpawnSeam((executable: string, args: string[], settings: any) => {
    assert.ok(['/usr/bin/gdbus', '/usr/bin/secret-tool'].includes(executable), 'no real helper executable is allowed')
    assert.equal(settings.shell, false)
    const role = executable.endsWith('gdbus') ? 'ready' : args[0], child = helperChild(events, role); children.push(child)
    child.stdin.end = (input: Buffer) => {
      if (role === 'ready') return setImmediate(() => {
        child.stdout.emit('data', Buffer.from(args.includes('org.freedesktop.Secret.Service.ReadAlias') ? "(objectpath '/org/freedesktop/secrets/collection/login',)\n" : '(<false>,)\n')); child.close()
      })
      const attributes = args.slice(args.indexOf('application'))
      if (role === 'store') { original = child; inputCopy = Buffer.from(input); storeAttributes = attributes; return }
      assert.equal(role, 'clear'); clearAttributes = attributes; events.push('clear:start'); setImmediate(() => child.close())
    }
    return child
  })
  const keyStore = new BrowserProfileSyncKeyStore({ endpointCrypto: codec, environment, platform: 'linux', timeoutMs: mode === 'endpoint-abort' ? 1000 : 10, hasHelper: () => true })
  let work: Promise<unknown> | undefined, observed: Promise<unknown> | undefined
  try {
    if (mode === 'host-stop') {
      const { AgentBrowserProfileCompanion } = await import('../lib/browser-profile-companion.mjs'), { BrowserHost } = await import('../bin/hoai-browser-host.mjs')
      const client = { activity: () => ({ pendingPhysicalOperations: 0, cleanupUnknown: false }), whenDrained: async () => {}, discover: async () => ({ profiles: [{ grant: { generation: 1 }, profile: { contentKeyEpoch: 1 } }] }) }
      const connection: any = { bootId: 'synthetic-key-helper-boot', _stopped: false, pairing: { token: 'SYNTHETIC', pairingId: 7, ownerUserId: 'machine-owner', backendUrl: 'https://synthetic.invalid', assistantIds: [42] }, stop: async () => {} }
      companion = new AgentBrowserProfileCompanion({ connection, agentRoot: join(tmpdir(), 'synthetic-key-helper-no-files'), deviceLabel: 'Synthetic helper test', environment, keyStore, client, permissionClient: client, permissionRunner: {}, returnClient: client, returnHandover: {},
        stateStore: { loadAll: async () => [], saveNew: async () => { saved = true; throw new Error('must not persist failed enrollment') } }, loadBrowser: async () => { throw new Error('must not load browser') }, createEngine: async () => { throw new Error('must not start engine') }, createRelay: () => { throw new Error('must not create relay') } } as any)
      companion.loaded = true; companion.cursor = 1
      companion.candidates.set('synthetic-intent', { intent: { intentId: 'synthetic-intent', expiresAt: Date.now() + 60000 }, scope: { ...Object.fromEntries(['profileId', 'actingUserId', 'assistantId', 'endpointId', 'keyFingerprint'].map(name => [name, binding[name as keyof typeof binding]])), pairingId: 7, ownerUserId: 'machine-owner' }, endpoint, published: true, uncertain: false })
      host = new BrowserHost({ agentRoot: join(tmpdir(), 'synthetic-key-helper-no-files'), env: {}, browserTools: async () => [], createEngine: async () => { throw new Error('must not start legacy engine') }, browserInstallations: { cancel() {}, activity: () => ({ pendingPhysicalOperations: 0, cleanupUnknown: false }), whenDrained: async () => {} } } as any)
      connection.profileCompanion = companion; host.connections.set('synthetic', connection); work = companion.poll()
    } else work = mode === 'portable-timeout' ? keyStore.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, createNew: true, assertCurrent: current, signal: controller.signal }) : keyStore.protect({ binding, endpoint, assertCurrent: current, signal: controller.signal })
    observed = work!.then(() => { settled = true; return 'poll-completed' }, error => { settled = true; return error.code })
    await helperUntil(() => !!original); if (mode === 'endpoint-abort') controller.abort()
    await helperUntil(() => original.kills > 0); await helperTurn()
    assert.equal(settled, false); assert.equal(clearAttributes, undefined, 'failed store clear must not race the still-open original store helper')
    if (host) {
      stopping = host.stop().then(() => { hostStopped = true }); await helperTurn()
      assert.equal(hostStopped, false); assert.equal(companion.activity().pendingPhysicalOperations, 1)
    }
    original.close(0) // A late exit0 remains the original timeout/abort failure.
    assert.equal(await observed, host ? 'poll-completed' : mode === 'endpoint-abort' ? 'profile_key_context_changed' : 'profile_key_unlock_required')
    await stopping; assert.deepEqual(clearAttributes, storeAttributes); assert.match(storeAttributes!.at(-1)!, /^[a-f0-9-]{36}$/)
    assert.ok(events.indexOf('store:close') < events.indexOf('clear:start')); assert.equal(saved, false)
    if (host) { assert.equal(companion.records.size, 0); assert.equal(companion.stopped, true); assert.deepEqual(companion.activity(), { activeProfiles: 0, pendingPhysicalOperations: 0, cleanupUnknown: false }) }
    // Physical helper close does not prove an accepted D-Bus store was rolled
    // back. This fixture proves helper ordering, not Secret Service rollback.
  } finally {
    for (const child of children) child.close()
    await observed; await stopping; inputCopy?.fill(0); restore()
  }
})

// macOS Keychain (S13). The fake below answers as /usr/bin/security and the
// osascript status probe do on a real Mac: exit 44 for a missing item, exit 0
// with the password and a newline for find -w, and on a locked keychain an
// item command waits on an unlock dialog until the helper timeout.
const loginKeychain = '/Users/synthetic-agent/Library/Keychains/login.keychain-db'
const darwinEnvironment = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
const itemCommand = (call: any) => call.executable === '/usr/bin/security' && call.args[0] !== 'login-keychain'
const keychainOf = (call: any) => call.args[0] === '-i' ? /"([^"]+)"\n$/.exec(call.input.toString())?.[1] : call.args.at(-1)
function keychainFixture(options: Record<string, any> = {}) {
  const calls: any[] = [], values = new Map<string, Buffer>(), inputs: Buffer[] = [], keychain = options.keychain || loginKeychain
  let state = 'unlocked'
  const run = async (executable: string, args: string[], settings: any) => {
    calls.push({ executable, args: [...args], environment: settings.environment, input: Buffer.from(settings.input || '') })
    if (settings.input?.length) inputs.push(settings.input)
    if (options.onCall) await options.onCall(executable, args, settings)
    if (executable === '/usr/bin/osascript') return { code: 0, output: Buffer.from(options.statusOutput ?? `${state}\n`) }
    assert.equal(executable, '/usr/bin/security')
    if (args[0] === 'login-keychain') return { code: options.loginCode ?? 0, output: Buffer.from(options.loginOutput ?? `    "${loginKeychain}"\n`) }
    if (state === 'locked') {
      if (options.lockedExit !== undefined) return { code: options.lockedExit, output: Buffer.alloc(0) }
      throw Object.assign(new Error('synthetic helper timeout'), { code: 'profile_key_unlock_required' })
    }
    if (args[0] === '-i') {
      const match = /^add-generic-password -a ([a-f0-9]{64}\.[a-f0-9-]{36}) -s (hoai-[a-z-]+-v1) -l "([A-Za-z ]+)" -w ([A-Za-z0-9_-]{43}) "([^"]+)"\n$/.exec(settings.input.toString())
      assert.ok(match, 'one add-generic-password line naming its keychain'); assert.equal(match[5], keychain)
      const key = `${match[1]}|${match[2]}`
      if (values.has(key)) return { code: 45, output: Buffer.alloc(0) }
      values.set(key, Buffer.from(match[4])); return { code: 0, output: Buffer.alloc(0) }
    }
    assert.equal(args.at(-1), keychain)
    const key = `${args[args.indexOf('-a') + 1]}|${args[args.indexOf('-s') + 1]}`
    if (args[0] === 'find-generic-password') { assert.ok(args.includes('-w')); return values.has(key) ? { code: 0, output: Buffer.from(`${values.get(key)}\n`) } : { code: 44, output: Buffer.alloc(0) } }
    assert.equal(args[0], 'delete-generic-password')
    return values.delete(key) ? { code: 0, output: Buffer.from('keychain: synthetic attributes\n') } : { code: 44, output: Buffer.alloc(0) }
  }
  const store = new BrowserProfileSyncKeyStore({ endpointCrypto: options.codec || codec, environment, platform: 'darwin', run, hasHelper: () => true, ...options })
  return { store, calls, values, inputs, lock: () => { state = 'locked' }, unlock: () => { state = 'unlocked' }, remove: () => { state = 'absent' } }
}
function fileWrites() {
  const native = createRequire(import.meta.url)('node:fs'), seen: string[] = [], undo: (() => void)[] = []
  const targets: [any, string[]][] = [[native, ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'open', 'openSync', 'createWriteStream', 'copyFile', 'copyFileSync', 'rename', 'renameSync']], [native.promises, ['writeFile', 'appendFile', 'open', 'copyFile', 'rename']]]
  for (const [target, names] of targets) for (const name of names) {
    const original = target[name]; target[name] = (...args: any[]) => { seen.push(name); return Reflect.apply(original, target, args) }; undo.push(() => { target[name] = original })
  }
  syncBuiltinESMExports()
  return { seen, restore: () => { for (const step of undo) step(); syncBuiltinESMExports() } }
}

test('darwin keeps the wrapping key in the login Keychain through security, each item command after a status probe that cannot prompt', async () => {
  const f = keychainFixture()
  assert.deepEqual(await f.store.status({ binding, assertCurrent: current }), { state: 'ready', provider: 'macos-keychain-v1' })
  const record = await f.store.protect({ binding, endpoint, assertCurrent: current })
  assert.equal(record.provider, 'macos-keychain-v1'); assert.equal(f.values.size, 1)
  assert.deepEqual(await f.store.restore({ record, binding, pinnedIdentity: identity, assertCurrent: current }), endpoint)
  assert.deepEqual(await f.store.remove({ record, binding, assertRevoked: current }), { removed: true }); assert.equal(f.values.size, 0)
  assert.equal(f.calls.some(call => ['/usr/bin/gdbus', '/usr/bin/secret-tool'].includes(call.executable)), false)
  const probes = f.calls.filter(call => call.executable === '/usr/bin/osascript')
  assert.equal(probes.length, 4)
  for (const probe of probes) {
    assert.deepEqual(probe.args.slice(0, 3), ['-l', 'JavaScript', '-e']); assert.deepEqual(probe.args.slice(4), [loginKeychain])
    assert.match(probe.args[3], /SecKeychainSetUserInteractionAllowed\(false\)/)
    assert.ok(probe.args[3].indexOf('SecKeychainSetUserInteractionAllowed(false)') < probe.args[3].indexOf('SecKeychainGetStatus'))
  }
  f.calls.forEach((call, index) => {
    // No HOME, bus, loader or token: a caller cannot point security at another login keychain.
    assert.deepEqual(call.environment, darwinEnvironment)
    if (!itemCommand(call)) return
    // security silently uses the default keychain when none, or an absent one, is named.
    assert.equal(keychainOf(call), loginKeychain)
    assert.equal(f.calls[index - 1].executable, '/usr/bin/osascript', 'an unlocked status just before every item command')
  })
  assert.deepEqual(f.calls.filter(itemCommand).map(call => call.args[0]), ['-i', 'find-generic-password', 'delete-generic-password'])
})

test('a locked Mac keychain refuses with unlock_required before any item command and never falls back to a file key', async () => {
  const f = keychainFixture(), saved = await f.store.protect({ binding, endpoint, assertCurrent: current })
  const extras = await f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, createNew: true, assertCurrent: current }), metadata = extras.record
  extras.dispose(); f.lock()
  const count = f.calls.length, writes = fileWrites()
  try {
    assert.deepEqual(await f.store.status({ binding, assertCurrent: current }), { state: 'unlock_required', reason: 'profile_key_unlock_required' })
    await assert.rejects(() => f.store.protect({ binding, endpoint, assertCurrent: current }), { code: 'profile_key_unlock_required' })
    await assert.rejects(() => f.store.restore({ record: saved, binding, pinnedIdentity: identity, assertCurrent: current }), { code: 'profile_key_unlock_required' })
    await assert.rejects(() => f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, createNew: true, assertCurrent: current }), { code: 'profile_key_unlock_required' })
    await assert.rejects(() => f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, record: metadata, assertCurrent: current }), { code: 'profile_key_unlock_required' })
    await assert.rejects(() => f.store.remove({ record: saved, binding, assertRevoked: current }), { code: 'profile_key_unlock_required' })
  } finally { writes.restore() }
  assert.deepEqual(writes.seen, [], 'no file write while the keychain is locked')
  const after = f.calls.slice(count)
  assert.ok(after.length > 0); assert.equal(after.some(itemCommand), false, 'only the status probe runs on a locked keychain')
  const unlocking = /unlock-keychain|SecKeychainUnlock/
  assert.equal(f.calls.some(call => call.args.some((arg: string) => unlocking.test(arg)) || unlocking.test(call.input.toString())), false, 'no automatic unlock')
  assert.equal(f.values.size, 2)
  f.unlock(); assert.deepEqual(await f.store.restore({ record: saved, binding, pinnedIdentity: identity, assertCurrent: current }), endpoint)
})

for (const lockedExit of [undefined, 36]) test(`a Mac keychain that locks after its status probe still refuses with unlock_required (${lockedExit === undefined ? 'helper timeout' : 'exit 36, no user interaction'})`, async () => {
  let armed = false
  const f = keychainFixture({ lockedExit, onCall: (executable: string, args: string[]) => { if (armed && executable === '/usr/bin/security' && args[0] !== 'login-keychain') f.lock() } })
  const record = await f.store.protect({ binding, endpoint, assertCurrent: current }); armed = true
  await assert.rejects(() => f.store.restore({ record, binding, pinnedIdentity: identity, assertCurrent: current }), { code: 'profile_key_unlock_required' })
  f.unlock(); await assert.rejects(() => f.store.protect({ binding, endpoint, assertCurrent: current }), { code: 'profile_key_unlock_required' })
  assert.equal(f.values.size, 1)
})

test('a missing Mac keychain item, keychain, helper or login keychain path is setup_required', async () => {
  const f = keychainFixture(), record = await f.store.protect({ binding, endpoint, assertCurrent: current })
  const extras = await f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, createNew: true, assertCurrent: current }), metadata = extras.record
  extras.dispose(); f.values.clear()
  await assert.rejects(() => f.store.restore({ record, binding, pinnedIdentity: identity, assertCurrent: current }), { code: 'profile_key_setup_required' })
  await assert.rejects(() => f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, record: metadata, assertCurrent: current }), { code: 'profile_key_setup_required' })
  f.remove(); const count = f.calls.length
  assert.deepEqual(await f.store.status({ binding, assertCurrent: current }), { state: 'setup_required', reason: 'profile_key_setup_required' })
  await assert.rejects(() => f.store.protect({ binding, endpoint, assertCurrent: current }), { code: 'profile_key_setup_required' })
  assert.equal(f.calls.slice(count).some(itemCommand), false, 'no add to an absent keychain: security would put it in the default one')
  const asked: string[] = [], missing = keychainFixture({ hasHelper: (path: string) => { asked.push(path); return path !== '/usr/bin/osascript' } })
  assert.equal((await missing.store.status({ binding, assertCurrent: current })).state, 'setup_required'); assert.equal(missing.calls.length, 0)
  assert.deepEqual(asked, ['/usr/bin/security', '/usr/bin/osascript'])
  for (const options of [{ loginOutput: '    "relative/login.keychain-db"\n' }, { loginOutput: `    "${loginKeychain}"\n    "/Library/Keychains/System.keychain"\n` }, { loginOutput: '' },
    { loginOutput: '    "/Users/synthetic agent/login.keychain-db"\n' }, { loginOutput: '    "/Users/synthetic/login.txt"\n' }, { loginCode: 50 }, { statusOutput: 'error\n' }, { statusOutput: 'unlocked' }, { statusOutput: 'UNLOCKED\n' }]) {
    const other = keychainFixture(options)
    assert.deepEqual(await other.store.status({ binding, assertCurrent: current }), { state: 'setup_required', reason: 'profile_key_setup_required' }, JSON.stringify(options))
    await assert.rejects(() => other.store.protect({ binding, endpoint, assertCurrent: current }), { code: 'profile_key_setup_required' })
    assert.equal(other.calls.some(itemCommand), false)
  }
})

test('on darwin every binding field must match before any keychain call, and a record from the other provider is refused', async () => {
  const f = keychainFixture(), record = await f.store.protect({ binding, endpoint, assertCurrent: current })
  const extras = await f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, createNew: true, assertCurrent: current }), metadata = extras.record
  extras.dispose(); const count = f.calls.length
  for (const change of [{ actingUserId: 'human-sharer' }, { assistantId: 43 }, { profileId: '33000000-0000-4000-8000-000000000003' },
    { endpointId: '44000000-0000-4000-8000-000000000004' }, { keyFingerprint: 'a'.repeat(64) }, { grantVersion: 2 }, { keyEpoch: 2 }]) {
    await assert.rejects(() => f.store.restore({ record, binding: { ...binding, ...change }, pinnedIdentity: identity, assertCurrent: current }), { code: 'profile_key_refused' })
    await assert.rejects(() => f.store.preloadPortableExtrasProtector({ binding: { ...binding, ...change }, pinnedIdentity: identity, record: metadata, assertCurrent: current }))
  }
  await assert.rejects(() => f.store.restore({ record, binding, pinnedIdentity: { ...identity, signingPublicKey: 'substitution' }, assertCurrent: current }), { code: 'profile_key_refused' })
  await assert.rejects(() => f.store.restore({ record: { ...record, provider: 'libsecret-v1' }, binding, pinnedIdentity: identity, assertCurrent: current }), { code: 'profile_key_refused' })
  await assert.rejects(() => f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, record: { ...metadata, provider: 'libsecret-v1' }, assertCurrent: current }), { code: 'profile_key_refused' })
  await assert.rejects(() => f.store.protect({ binding: { ...binding, backgroundUse: false }, endpoint, assertCurrent: current }), { code: 'profile_key_background_grant_required' })
  assert.deepEqual(await f.store.status({ binding: { ...binding, backgroundUse: false }, assertCurrent: current }), { state: 'background_grant_required', reason: 'profile_key_background_grant_required' })
  assert.equal(f.calls.length, count)
  const linux = fixture(), linuxRecord = await linux.store.protect({ binding, endpoint, assertCurrent: current }), linuxCount = linux.calls.length
  await assert.rejects(() => linux.store.restore({ record, binding, pinnedIdentity: identity, assertCurrent: current }), { code: 'profile_key_refused' })
  await assert.rejects(() => f.store.restore({ record: linuxRecord, binding, pinnedIdentity: identity, assertCurrent: current }), { code: 'profile_key_refused' })
  assert.equal(linux.calls.length, linuxCount); assert.equal(f.calls.length, count)
})

test('on darwin the wrapping key reaches security only on stdin, that stdin buffer is zeroed, and argv never carries a key', async () => {
  const f = keychainFixture(), record = await f.store.protect({ binding, endpoint, assertCurrent: current })
  assert.deepEqual(await f.store.restore({ record, binding, pinnedIdentity: identity, assertCurrent: current }), endpoint)
  const extras = await f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, createNew: true, assertCurrent: current }), metadata = extras.record
  try { assert.equal(extras.decryptString(extras.encryptString('SYNTHETIC_EXTRAS')), 'SYNTHETIC_EXTRAS') } finally { extras.dispose() }
  const stores = f.calls.filter(call => call.args[0] === '-i'), scope = fingerprint(binding)
  assert.equal(stores.length, 2)
  assert.equal(stores[0].input.toString().startsWith(`add-generic-password -a ${scope}.${record.recordId} -s hoai-browser-profile-sync-v1 -l "HOAI browser endpoint key" -w `), true)
  assert.equal(stores[1].input.toString().startsWith(`add-generic-password -a ${scope}.${metadata.recordId} -s hoai-browser-portable-extras-v1 -l "HOAI browser portable extras" -w `), true)
  for (const store of stores) {
    assert.deepEqual(store.args, ['-i'])
    const secret = /-w ([A-Za-z0-9_-]{43}) /.exec(store.input.toString())![1]
    for (const call of f.calls) assert.equal(JSON.stringify(call.args).includes(secret), false)
    assert.equal(JSON.stringify(record).includes(secret), false); assert.equal(JSON.stringify(metadata).includes(secret), false)
  }
  for (const call of f.calls) assert.equal(JSON.stringify(call.args).includes(endpoint.privateFixture), false)
  assert.equal(JSON.stringify(record).includes(endpoint.privateFixture), false)
  assert.equal(f.inputs.length, 2); assert.ok(f.inputs.every(input => input.every(byte => byte === 0)), 'the caller zeroes its stdin copy of the key')
})

test('portable extras on darwin use their own Keychain service and only a new disposed protector deletes its exact item', async () => {
  const f = keychainFixture(), existing = await f.store.protect({ binding, endpoint, assertCurrent: current })
  const protector = await f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, createNew: true, assertCurrent: current }), metadata = protector.record
  assert.deepEqual(metadata, { version: 1, provider: 'macos-keychain-v1', purpose: 'portable-extras-v1', recordId: metadata.recordId, binding })
  const bytes = protector.encryptString('SYNTHETIC_PORTABLE')
  await assert.rejects(() => protector.discardCreatedRecord()); assert.equal(f.values.size, 2)
  protector.dispose(); assert.deepEqual(await protector.discardCreatedRecord(), { removed: true }); assert.equal(f.values.size, 1)
  const deletes = f.calls.filter(call => call.args[0] === 'delete-generic-password')
  assert.deepEqual(deletes.map(call => call.args), [['delete-generic-password', '-a', `${fingerprint(binding)}.${metadata.recordId}`, '-s', 'hoai-browser-portable-extras-v1', loginKeychain]])
  assert.deepEqual(await f.store.restore({ record: existing, binding, pinnedIdentity: identity, assertCurrent: current }), endpoint)
  const prior = await f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, createNew: true, assertCurrent: current }), saved = prior.record, sealed = prior.encryptString('SYNTHETIC_PORTABLE'); prior.dispose()
  const loaded = await f.store.preloadPortableExtrasProtector({ binding, pinnedIdentity: identity, record: saved, assertCurrent: current })
  try { assert.equal(loaded.decryptString(sealed), 'SYNTHETIC_PORTABLE'); assert.throws(() => loaded.decryptString(bytes)) } finally { loaded.dispose() }
  await assert.rejects(() => loaded.discardCreatedRecord()); assert.equal(f.values.size, 2)
})

test('an explicit keychain path is used as given and never resolved, and an unsafe one is refused at construction', async () => {
  const keychain = '/private/tmp/s13/s13-test.keychain-db', f = keychainFixture({ keychain })
  const record = await f.store.protect({ binding, endpoint, assertCurrent: current })
  assert.deepEqual(await f.store.restore({ record, binding, pinnedIdentity: identity, assertCurrent: current }), endpoint)
  assert.equal(f.calls.some(call => call.args[0] === 'login-keychain'), false)
  assert.ok(f.calls.filter(call => call.executable === '/usr/bin/osascript').every(call => call.args[4] === keychain))
  assert.ok(f.calls.filter(itemCommand).every(call => keychainOf(call) === keychain))
  for (const bad of ['relative/s13.keychain-db', '/tmp/s13"x.keychain-db', '/tmp/s13 x.keychain-db', '/tmp/s13.keychain-db\n', '/tmp/s13.txt', '/tmp/../etc/s13.keychain-db', '', 7, {}]) {
    assert.throws(() => new BrowserProfileSyncKeyStore({ endpointCrypto: codec, platform: 'darwin', keychain: bad } as any), { name: 'TypeError', message: 'profile_key_dependencies_required' }, JSON.stringify(bad))
  }
})

test('the vendored endpoint crypto accepts the Keychain adapter on darwin and restores the same private keys', async () => {
  const actual = createRequire(import.meta.url)('../lib/browser-profile-core/crypto.js'), real = actual.createEndpointIdentity(identity.endpointId)
  const exact = { ...binding, keyFingerprint: actual.identityFingerprint(real.identity) }, f = keychainFixture({ codec: actual })
  const record = await f.store.protect({ binding: exact, endpoint: real, assertCurrent: current })
  const restored = await f.store.restore({ record, binding: exact, pinnedIdentity: real.identity, assertCurrent: current })
  assert.equal(restored.signingPrivateKey.export({ type: 'pkcs8', format: 'der' }).equals(real.signingPrivateKey.export({ type: 'pkcs8', format: 'der' })), true)
})

// Opt-in, on a Mac only. It creates a throwaway keychain file under a fresh
// temporary directory, passes it by path, never adds it to the search list
// (create-keychain runs with a scratch HOME, so even a search-list write would
// land there), locks and unlocks it, and deletes it. Every search list and the
// default and login keychains must read the same before and after.
test('real macOS Keychain: a throwaway keychain by path stores, reads, refuses while locked and never joins the search list', {
  timeout: 60000, skip: (process.platform !== 'darwin' || process.env.HOAI_KEYCHAIN_REAL_TEST !== '1') && 'Set HOAI_KEYCHAIN_REAL_TEST=1 on a Mac to run against a throwaway keychain.',
}, async () => {
  const actual = createRequire(import.meta.url)('../lib/browser-profile-core/crypto.js'), real = actual.createEndpointIdentity(identity.endpointId)
  const exact = { ...binding, keyFingerprint: actual.identityFingerprint(real.identity) }
  const root = mkdtempSync(join(tmpdir(), 's13-')), home = join(root, 'home'), keychain = join(root, 's13-test.keychain-db'), password = randomBytes(24).toString('hex')
  const security = (args: string[], extra: Record<string, string> = {}) => execFileSync('/usr/bin/security', args, { env: { PATH: '/usr/bin:/bin', ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const exit = (args: string[]) => { try { security(args); return 0 } catch (error: any) { return error.status } }
  const lists = () => [...['user', 'system', 'common', 'dynamic'].map(domain => security(['list-keychains', '-d', domain])), security(['default-keychain']), security(['login-keychain'])].join('|')
  const before = lists()
  mkdirSync(home, { mode: 0o700 })
  try {
    security(['create-keychain', '-p', password, keychain], { HOME: home })
    assert.equal(lists(), before, 'creating the throwaway keychain left every search list unchanged')
    const store = new BrowserProfileSyncKeyStore({ endpointCrypto: actual, platform: 'darwin', keychain })
    assert.deepEqual(await store.status({ binding: exact, assertCurrent: current }), { state: 'ready', provider: 'macos-keychain-v1' })
    const record = await store.protect({ binding: exact, endpoint: real, assertCurrent: current }), account = `${fingerprint(exact)}.${record.recordId}`
    assert.equal(exit(['find-generic-password', '-a', account, '-s', 'hoai-browser-profile-sync-v1', keychain]), 0, 'the item is in the throwaway keychain')
    assert.equal(exit(['find-generic-password', '-a', account, '-s', 'hoai-browser-profile-sync-v1']), 44, 'and in no keychain on the search list')
    const same = (endpoint: any) => endpoint.signingPrivateKey.export({ type: 'pkcs8', format: 'der' }).equals(real.signingPrivateKey.export({ type: 'pkcs8', format: 'der' }))
    assert.ok(same(await store.restore({ record, binding: exact, pinnedIdentity: real.identity, assertCurrent: current })))
    const extras = await store.preloadPortableExtrasProtector({ binding: exact, pinnedIdentity: real.identity, createNew: true, assertCurrent: current }), sealed = extras.encryptString('SYNTHETIC_REAL_EXTRAS'), metadata = extras.record
    extras.dispose()
    security(['lock-keychain', keychain])
    assert.deepEqual(await store.status({ binding: exact, assertCurrent: current }), { state: 'unlock_required', reason: 'profile_key_unlock_required' })
    await assert.rejects(() => store.restore({ record, binding: exact, pinnedIdentity: real.identity, assertCurrent: current }), { code: 'profile_key_unlock_required' })
    await assert.rejects(() => store.protect({ binding: exact, endpoint: real, assertCurrent: current }), { code: 'profile_key_unlock_required' })
    await assert.rejects(() => store.preloadPortableExtrasProtector({ binding: exact, pinnedIdentity: real.identity, record: metadata, assertCurrent: current }), { code: 'profile_key_unlock_required' })
    security(['unlock-keychain', '-p', password, keychain])
    assert.ok(same(await store.restore({ record, binding: exact, pinnedIdentity: real.identity, assertCurrent: current })))
    const loaded = await store.preloadPortableExtrasProtector({ binding: exact, pinnedIdentity: real.identity, record: metadata, assertCurrent: current })
    try { assert.equal(loaded.decryptString(sealed), 'SYNTHETIC_REAL_EXTRAS') } finally { loaded.dispose() }
    assert.deepEqual(await store.remove({ record, binding: exact, assertRevoked: current }), { removed: true })
    await assert.rejects(() => store.restore({ record, binding: exact, pinnedIdentity: real.identity, assertCurrent: current }), { code: 'profile_key_setup_required' })
  } finally {
    if (existsSync(keychain)) security(['delete-keychain', keychain], { HOME: home })
    rmSync(root, { recursive: true, force: true })
  }
  assert.equal(existsSync(keychain), false)
  assert.equal(lists(), before, 'every search list, the default and the login keychain read the same after')
})
