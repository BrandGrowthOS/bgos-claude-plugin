import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID, randomBytes } from 'node:crypto'
const require = createRequire(import.meta.url), crypto = require('node:crypto'), checkpoint = require('../lib/browser-profile-core/crypto.js'), files = require('../lib/browser-profile-core/profile-file-crypto.js')
const sorted = (value: any): any => value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value
function observedInfo(context: any, domain: string, expectedCalls: number, run: () => void) {
  const original = crypto.hkdfSync, observed: Buffer[] = [], complete = Buffer.concat([Buffer.from(domain), Buffer.from(JSON.stringify(sorted(context)))]), digest = crypto.createHash('sha256').update(complete).digest()
  assert.ok(complete.length > 1024)
  crypto.hkdfSync = function (...args: any[]) { observed.push(Buffer.from(args[3])); return original.apply(this, args) }
  try { assert.doesNotThrow(run); assert.equal(observed.length, expectedCalls); for (const info of observed) { assert.equal(info.length, 32); assert.deepEqual(info, digest) } }
  finally { crypto.hkdfSync = original }
}
test('shipped checkpoint codec derives from the complete maximum context within the native limit', () => {
  const source = checkpoint.createEndpointIdentity(randomUUID()), destination = checkpoint.createEndpointIdentity(randomUUID()), contentKeyEpoch = checkpoint.createContentKeyEpoch(1), plaintext = Buffer.from('synthetic profile state')
  const context = { version: 1, schemaVersion: 1, profileId: randomUUID(), actingUserId: 'a'.repeat(256), assistantId: 42, transitionId: randomUUID(), revision: 1, previousManifestHash: 'a'.repeat(64), keyEpoch: 1,
    source: { endpointId: source.identity.endpointId, bootId: 'b'.repeat(256), runtimeId: 'r'.repeat(256), sessionId: 's'.repeat(256), writerEpoch: 3 },
    destination: { endpointId: destination.identity.endpointId, bootId: 'd'.repeat(256), runtimeId: 'e'.repeat(256), sessionId: 'f'.repeat(256), grantVersion: 7, keyFingerprint: checkpoint.identityFingerprint(destination.identity) } }
  try { observedInfo(context, 'HOAI-PROFILE-SYNC-v1:key-derivation\0', 2, () => {
    const sealed = checkpoint.sealCheckpoint({ plaintext, context, source, destinationIdentity: destination.identity, contentKeyEpoch }), opened = checkpoint.openCheckpoint({ checkpoint: sealed, expectedContext: context, sourceIdentity: source.identity, destination })
    try { assert.deepEqual(opened.plaintext, plaintext); assert.deepEqual(opened.contentKeyEpoch, contentKeyEpoch) } finally { opened.plaintext.fill(0); opened.contentKeyEpoch.key.fill(0) }
    assert.throws(() => checkpoint.openCheckpoint({ checkpoint: sealed, expectedContext: { ...context, actingUserId: 'other-person' }, sourceIdentity: source.identity, destination }), { code: 'profile_sync_crypto_refused' })
  }) } finally { plaintext.fill(0); contentKeyEpoch.key.fill(0) }
})
test('shipped file codec derives from the complete maximum authority within the native limit', () => {
  const source = checkpoint.createEndpointIdentity(randomUUID()), destination = checkpoint.createEndpointIdentity(randomUUID()), plaintext = Buffer.from('synthetic file'), own = { endpointId: source.identity.endpointId, keyFingerprint: checkpoint.identityFingerprint(source.identity), grantVersion: 3 }, peer = { endpointId: destination.identity.endpointId, keyFingerprint: checkpoint.identityFingerprint(destination.identity), grantVersion: 7 }
  const context = { version: 1, kind: 'agent-browser-file-offer', fileId: randomUUID(), nonce: randomBytes(32).toString('base64url'), direction: 'to-desktop', expiresAt: Date.now() + 60000, plaintextBytes: plaintext.length,
    authority: { profileId: randomUUID(), actingUserId: 'a'.repeat(128), assistantId: 42, ...own, bootId: 'b'.repeat(128), runtimeId: 'r'.repeat(128), sessionId: 's'.repeat(128), writerEpoch: 3, revision: 1, contentKeyEpoch: 1 }, source: own, destination: peer }
  try { observedInfo(context, 'HOAI-BROWSER-FILE-v1\0key-derivation\0', 3, () => {
    const sealed = files.sealFile({ plaintext, fileName: 'synthetic.txt', contentType: 'text/plain', context, source, destinationIdentity: destination.identity }), opened = files.openFile({ ...sealed, expectedContext: context, sourceIdentity: source.identity, destination })
    try {
      assert.deepEqual(opened.plaintext, plaintext); assert.equal(opened.fileName, 'synthetic.txt')
      assert.throws(() => files.openFile({ ...sealed, expectedContext: { ...context, authority: { ...context.authority, actingUserId: 'other-person' } }, sourceIdentity: source.identity, destination }), { code: 'profile_file_refused' })
    } finally { opened.plaintext.fill(0); sealed.payload.fill(0) }
  }) } finally { plaintext.fill(0) }
})
