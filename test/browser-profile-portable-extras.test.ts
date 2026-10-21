import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { BrowserProfileSyncKeyStore } from '../lib/browser-profile-sync-key-store.mjs'
import { BrowserProfilePortableExtrasStore } from '../lib/browser-profile-portable-extras.mjs'

const crypto = createRequire(import.meta.url)('../lib/browser-profile-core/crypto.js')
const endpoint = crypto.createEndpointIdentity('11000000-0000-4000-8000-000000000001')
const binding = { profileId: '22000000-0000-4000-8000-000000000002', actingUserId: 'private-recipient', assistantId: 42,
  endpointId: endpoint.identity.endpointId, keyFingerprint: crypto.identityFingerprint(endpoint.identity), grantVersion: 3, keyEpoch: 2, backgroundUse: true }
const authority = { profileId: binding.profileId, actingUserId: binding.actingUserId, assistantId: binding.assistantId, endpointId: binding.endpointId,
  bootId: 'boot-current', runtimeId: 'runtime-current', sessionId: 'session-current', writerEpoch: 7, revision: 4, contentKeyEpoch: binding.keyEpoch, grantVersion: binding.grantVersion, keyFingerprint: binding.keyFingerprint }
const empty = { passwordVault: { v: 1, entries: [], neverOrigins: [] }, preferences: { v: 1, searchEngine: 'google' } }
const populated = { passwordVault: { v: 1, entries: [{ id: '33000000-0000-4000-8000-000000000003', origin: 'https://login.fixture.invalid', username: 'synthetic-user', password: 'SYNTHETIC_PORTABLE_PASSWORD', name: 'Fixture', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z' }], neverOrigins: ['https://never.fixture.invalid'] }, preferences: { v: 1, searchEngine: 'duckduckgo' } }
const receipt = { version: 1, kind: 'destination-staged', profileId: binding.profileId, revision: authority.revision, transitionId: '44000000-0000-4000-8000-000000000004', manifestHash: 'a'.repeat(64), stagedInactive: true,
  destination: Object.fromEntries(['endpointId', 'bootId', 'runtimeId', 'sessionId', 'grantVersion', 'keyFingerprint'].map(key => [key, authority[key as keyof typeof authority]])) }

// Actual fs, AES and portable codec. Only OS command results and, on Windows,
// POSIX mode bits/directory fsync are doubles. Native Linux proof is separate.
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hoai-portable-extras-')), values = new Map<string, Buffer>(), calls:any[] = []
  let allowed = true, locked = false, failClear = false
  const io:any = { ...fs, lstatSync: (target:any) => { const info = fs.lstatSync(target); if (process.platform === 'win32') info.mode &= ~0o077; return info },
    openSync: (target:any, flags:any, mode:any) => process.platform === 'win32' && flags === fs.constants.O_RDONLY && fs.statSync(target).isDirectory() ? -2 : fs.openSync(target, flags, mode),
    fsyncSync: (fd:number) => { if (fd !== -2) fs.fsyncSync(fd) }, closeSync: (fd:number) => { if (fd !== -2) fs.closeSync(fd) } }
  const run = async (executable:string, args:string[], options:any) => {
    calls.push({ executable, args: [...args], environment: options.environment, input: Buffer.from(options.input || '') })
    if (executable === '/usr/bin/gdbus') return { code: 0, output: Buffer.from(args.includes('org.freedesktop.Secret.Service.ReadAlias') ? "(objectpath '/org/freedesktop/secrets/collection/login',)" : `(<${locked ? 'true' : 'false'}>,)`) }
    assert.equal(executable, '/usr/bin/secret-tool'); const key = args.slice(args.indexOf('application')).join('|')
    if (args[0] === 'store') { values.set(key, Buffer.from(options.input)); return { code: 0, output: Buffer.alloc(0) } }
    if (args[0] === 'clear') { if (failClear) return { code: 1, output: Buffer.alloc(0) }; values.delete(key); return { code: 0, output: Buffer.alloc(0) } }
    return { code: values.has(key) ? 0 : 1, output: Buffer.from(values.get(key) || '') }
  }
  const keyStore = new BrowserProfileSyncKeyStore({ endpointCrypto: crypto, platform: 'linux', environment: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/hoai-synthetic-private-bus' }, run, hasHelper: () => true })
  const assertCurrent = () => { if (!allowed) throw new Error('synthetic revoked authority') }
  const options = { directory, binding, pinnedIdentity: endpoint.identity, keyStore, assertCurrent, io }
  const cleanup = () => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true }) }
  return { directory, io, values, calls, keyStore, options, cleanup, revoke: () => { allowed = false }, lock: () => { locked = true }, failClear: () => { failClear = true } }
}

test('approved preload persists whole encrypted extras across fresh providers without helper calls during capture', async () => {
  const f = fixture(); let store:any
  try {
    store = await BrowserProfilePortableExtrasStore.preload({ ...f.options, createNew: true })
    assert.deepEqual(store.preflightExtras({ authority }), empty)
    assert.equal(store.replaceBundle({ authority, bundle: populated }).durability.directorySynced, true)
    const count = f.calls.length, lease = store.captureExtras({ authority })
    assert.deepEqual(lease.bundle, populated); assert.throws(() => store.replaceBundle({ authority, bundle: empty }))
    await Promise.resolve(); lease.assertCurrent(); assert.equal(f.calls.length, count); lease.release()
    const record = fs.readFileSync(store.file, 'utf8')
    assert.equal(record.includes(populated.passwordVault.entries[0].password), false); assert.equal(record.includes('synthetic-user'), false)
    assert.equal(record.includes('duckduckgo'), false); assert.equal(record.includes([...f.values.values()][0].toString()), false)
    if (process.platform !== 'win32') assert.equal(fs.statSync(store.file).mode & 0o777, 0o600)
    store.dispose(); store = await BrowserProfilePortableExtrasStore.preload(f.options)
    assert.deepEqual(store.preflightExtras({ authority }), populated)
    store.replaceBundle({ authority, bundle: empty }); store.dispose(); store = await BrowserProfilePortableExtrasStore.preload(f.options)
    assert.deepEqual(store.preflightExtras({ authority }), empty)
  } finally { store?.dispose(); f.cleanup() }
})

test('inactive destination publication requires the exact activation and staged receipt and is one use', async () => {
  const f = fixture(); let store:any
  try {
    store = await BrowserProfilePortableExtrasStore.preload({ ...f.options, createNew: true })
    for (const bad of [{ ...authority, sessionId: 'stale-session' }, { ...authority, grantVersion: 4 }, { ...authority, contentKeyEpoch: 3 }]) {
      assert.throws(() => store.commitExtras({ authority, bundle: populated, receipt, grant: bad }))
    }
    assert.deepEqual(store.preflightExtras({ authority }), empty)
    assert.throws(() => store.commitExtras({ authority, bundle: populated, grant: authority, receipt: { ...receipt, destination: { ...receipt.destination, runtimeId: 'stale' } } }))
    assert.deepEqual(store.commitExtras({ authority, bundle: populated, receipt, grant: authority }), { committed: true })
    assert.throws(() => store.commitExtras({ authority, bundle: empty, receipt, grant: authority }))
    assert.deepEqual(store.preflightExtras({ authority }), populated)
  } finally { store?.dispose(); f.cleanup() }
})

test('wrong actor, profile, pin, grant and epoch cannot load an older record or silently create empty data', async () => {
  const f = fixture(); let store:any
  try {
    await assert.rejects(() => BrowserProfilePortableExtrasStore.preload(f.options)); assert.equal(f.calls.length, 0)
    store = await BrowserProfilePortableExtrasStore.preload({ ...f.options, createNew: true }); store.replaceBundle({ authority, bundle: populated }); store.dispose(); store = null
    const count = f.calls.length
    for (const change of [{ actingUserId: 'other-person' }, { profileId: '55000000-0000-4000-8000-000000000005' }, { keyFingerprint: 'b'.repeat(64) }, { grantVersion: 4 }, { keyEpoch: 3 }]) {
      await assert.rejects(() => BrowserProfilePortableExtrasStore.preload({ ...f.options, binding: { ...binding, ...change } }))
    }
    assert.equal(f.calls.length, count)
    await assert.rejects(() => BrowserProfilePortableExtrasStore.preload({ ...f.options, createNew: true }))
    store = await BrowserProfilePortableExtrasStore.preload(f.options)
    assert.deepEqual(store.preflightExtras({ authority }), populated)
  } finally { store?.dispose(); f.cleanup() }
})

test('bad tags, truncated records and wrong purpose refuse before exposing entries', async () => {
  for (const mutation of ['tag', 'truncate', 'purpose']) {
    const f = fixture(); let store:any
    try {
      store = await BrowserProfilePortableExtrasStore.preload({ ...f.options, createNew: true }); const file = store.file; store.dispose(); store = null
      const raw = fs.readFileSync(file), value = JSON.parse(raw.toString())
      if (mutation === 'tag') { const bytes = Buffer.from(value.ciphertext, 'base64'); bytes[bytes.length - 1] ^= 1; value.ciphertext = bytes.toString('base64') }
      if (mutation === 'purpose') value.protector.purpose = 'endpoint-keys'
      fs.writeFileSync(file, mutation === 'truncate' ? raw.subarray(0, 10) : JSON.stringify(value))
      await assert.rejects(() => BrowserProfilePortableExtrasStore.preload(f.options), { code: 'profile_extras_refused' })
    } finally { store?.dispose(); f.cleanup() }
  }
})

test('failed atomic replacement preserves old ciphertext, latches uncertainty and blocks automatic recovery', async () => {
  const f = fixture(); let store:any
  try {
    store = await BrowserProfilePortableExtrasStore.preload({ ...f.options, createNew: true }); const old = fs.readFileSync(store.file)
    f.io.renameSync = () => { throw new Error('synthetic rename refusal') }
    assert.throws(() => store.replaceBundle({ authority, bundle: populated }), { code: 'profile_extras_write_uncertain' })
    assert.deepEqual(fs.readFileSync(store.file), old); assert.equal(fs.existsSync(store.pending), true)
    assert.throws(() => store.captureExtras({ authority })); store.dispose(); store = null
    await assert.rejects(() => BrowserProfilePortableExtrasStore.preload(f.options), { code: 'profile_extras_recovery_required' })
  } finally { store?.dispose(); f.cleanup() }
})

test('failed fresh publication deletes only its new OS item after disposal and retains existing secrets', async () => {
  const f = fixture(); let existing:any
  try {
    existing = await BrowserProfilePortableExtrasStore.preload({ ...f.options, createNew: true }); existing.replaceBundle({ authority, bundle: populated }); existing.dispose(); existing = null
    const saved = [...f.values.entries()].map(([key, value]) => [key, Buffer.from(value)] as const)
    const directory = path.join(f.directory, 'failed-new-runtime'), io = { ...f.io, renameSync: () => { throw new Error('new record rename failed') } }
    await assert.rejects(() => BrowserProfilePortableExtrasStore.preload({ ...f.options, directory, io, createNew: true }), { code: 'profile_extras_write_uncertain' })
    assert.equal(f.values.size, 1); assert.deepEqual([...f.values], saved)
    const clear = f.calls.slice().reverse().find((call:any) => call.args[0] === 'clear'); assert.ok(clear); assert.equal(clear.args.includes(saved[0][0].split('|').at(-1)), false)
    existing = await BrowserProfilePortableExtrasStore.preload(f.options); assert.deepEqual(existing.preflightExtras({ authority }), populated)
  } finally { existing?.dispose(); f.cleanup() }
})

test('uncertain already-published fresh data retains its OS key and explicit deletion failure is reported', async () => {
  for (const published of [false, true]) {
    const f = fixture()
    try {
      if (!published) f.failClear()
      f.io.renameSync = (from:string, to:string) => { if (published) fs.renameSync(from, to); throw new Error('synthetic publication failure') }
      await assert.rejects(() => BrowserProfilePortableExtrasStore.preload({ ...f.options, createNew: true }), { code: published ? 'profile_extras_write_uncertain' : 'profile_extras_cleanup_required' })
      assert.equal(f.values.size, 1)
      assert.equal(f.calls.some(call => call.args[0] === 'clear'), !published)
      if (published) { assert.ok(fs.readdirSync(f.directory).some(name => name.endsWith('.json'))); assert.ok(fs.readdirSync(f.directory).some(name => name.endsWith('.pending'))) }
    } finally { f.cleanup() }
  }
})

test('revoked authority, async proof, duplicate physical writer and stale document tuple all refuse', async () => {
  const f = fixture(); let store:any
  try {
    store = await BrowserProfilePortableExtrasStore.preload({ ...f.options, createNew: true }); store.preflightExtras({ authority })
    await assert.rejects(() => BrowserProfilePortableExtrasStore.preload(f.options), { code: 'profile_extras_recovery_required' })
    assert.throws(() => store.preflightExtras({ authority: { ...authority, runtimeId: 'new-runtime' } }))
    for (const change of [{ grantVersion: 4 }, { contentKeyEpoch: 3 }, { actingUserId: 'other-user' }, { profileId: '55000000-0000-4000-8000-000000000005' }]) assert.throws(() => store.preflightExtras({ authority: { ...authority, ...change } }))
    const lease = store.captureExtras({ authority }); f.revoke(); assert.throws(lease.assertCurrent); lease.release()
    assert.throws(() => store.replaceBundle({ authority, bundle: populated }))
  } finally { store?.dispose(); f.cleanup() }
  const g = fixture()
  try { await assert.rejects(() => BrowserProfilePortableExtrasStore.preload({ ...g.options, createNew: true, assertCurrent: async () => true })); assert.equal(g.calls.length, 0) } finally { g.cleanup() }
})

test('locked OS backend never returns a usable provider or stores plaintext fallback', async () => {
  const f = fixture(); f.lock()
  try {
    await assert.rejects(() => BrowserProfilePortableExtrasStore.preload({ ...f.options, createNew: true }), { code: 'profile_key_unlock_required' })
    assert.equal(f.calls.some(call => call.executable === '/usr/bin/secret-tool'), false)
    assert.equal(fs.readdirSync(f.directory).length, 0)
  } finally { f.cleanup() }
})

test('oversized credential trees refuse before encryption or native writes', async () => {
  const f = fixture(); let store:any
  try {
    store = await BrowserProfilePortableExtrasStore.preload({ ...f.options, createNew: true }); let encrypted = 0
    const old = store.protector; store.protector = { ...old, encryptString: (value:string) => { encrypted++; return old.encryptString(value) } }
    const entries = new Proxy(new Array(200001), { ownKeys() { throw new Error('oversized array must not enumerate') } })
    assert.throws(() => store.replaceBundle({ authority, bundle: { ...empty, passwordVault: { v: 1, entries, neverOrigins: [] } } })); assert.equal(encrypted, 0)
    assert.deepEqual(store.preflightExtras({ authority }), empty)
  } finally { store?.dispose(); f.cleanup() }
})
