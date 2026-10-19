import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomBytes, randomUUID, verify, createPublicKey } from 'node:crypto'
import { AgentReturnIntentClient } from '../lib/browser-profile-return-client.mjs'
const require = createRequire(import.meta.url), codec = require('../lib/browser-profile-core/crypto.js'), shared = require('../lib/browser-profile-core/coordinator-client.js'), wire = require('../lib/browser-profile-core/return-intent.js')
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function fixture(timeoutMs = 2000) {
  const endpoint = codec.createEndpointIdentity(randomUUID()), desktop = codec.createEndpointIdentity(randomUUID()), now = Date.now()
  const scope = { profileId: randomUUID(), actingUserId: 'recipient', assistantId: 42, endpointId: endpoint.identity.endpointId, keyFingerprint: codec.identityFingerprint(endpoint.identity), pairingId: 7, ownerUserId: 'sharer' }
  const authority: any = { ...Object.fromEntries(['profileId', 'actingUserId', 'assistantId', 'endpointId', 'keyFingerprint'].map(key => [key, (scope as any)[key]])), bootId: 'agent-boot', runtimeId: 'agent-runtime', sessionId: 'agent-session', writerEpoch: 3, revision: 0, contentKeyEpoch: 1, grantVersion: 1 }
  const request = { version: 1, kind: 'agent-browser-return-intent', requestId: randomUUID(), nonce: randomBytes(32).toString('base64url'), sourceAuthority: authority, destination: { endpointId: desktop.identity.endpointId, keyFingerprint: codec.identityFingerprint(desktop.identity), bootId: 'desktop-boot', runtimeId: 'desktop-runtime', sessionId: 'desktop-session', grantVersion: 1 }, expectedHeadManifestHash: null, expiresAt: now + 300000 }
  const signature = shared.documentSignature(desktop, request), pending = { request, signature, intentHash: wire.returnIntentHash({ request, signature }), state: 'pending', manifestHash: null, writeConsumed: false, transitionPhase: null, sourceStopped: null }
  const context = { version: 1, schemaVersion: 1, profileId: scope.profileId, actingUserId: scope.actingUserId, assistantId: scope.assistantId, transitionId: request.requestId, revision: 1, previousManifestHash: null, keyEpoch: 1, source: Object.fromEntries(['endpointId', 'bootId', 'runtimeId', 'sessionId', 'writerEpoch'].map(key => [key, authority[key]])), destination: request.destination }
  const epoch = codec.createContentKeyEpoch(1), plaintext = Buffer.from('SYNTHETIC_RETURN_STATE_ONLY'), checkpoint = codec.sealCheckpoint({ plaintext, context, source: endpoint, destinationIdentity: desktop.identity, contentKeyEpoch: epoch }); plaintext.fill(0); epoch.key.fill(0)
  const manifestHash = codec.manifestHash(checkpoint.manifest), receipt = { version: 1, kind: 'source-stopped', profileId: scope.profileId, transitionId: request.requestId, manifestHash, revision: 1, source: context.source, stopped: true }, stopped = { checkpoint, receipt, signature: shared.documentSignature(endpoint, receipt) }
  const committed = { ...pending, state: 'checkpoint-committed', manifestHash, writeConsumed: true, transitionPhase: 'checkpoint_committed', sourceStopped: { receipt, signature: stopped.signature } }
  const state: any = { now, current: true, response: pending }, calls: any[] = [], proof: any = { pairingId: 7, ownerUserId: 'sharer', assistantId: 42, token: 'synthetic-private-pairing', assertCurrent() { if (!state.current) throw Error('PRIVATE_CONTEXT') } }, hooks: any = {}
  const check = () => { if (!state.current) throw Error('PRIVATE_CONTEXT') }
  const client = new AgentReturnIntentClient({ origin: 'https://hoai.test/api/v1', timeoutMs, now: () => state.now, authorizePairing: async () => hooks.authorize ? hooks.authorize() : proof,
    fetchImpl: async (url: string, options: any) => {
      const body = JSON.parse(options.body), route = new URL(url).pathname, write = route.endsWith('/checkpoint'), read = route.endsWith('/read')
      const document = write ? wire.returnCheckpointDocument({ requestId: request.requestId, intentHash: body.intentHash, authority: body.authority, manifestHash: codec.manifestHash(body.manifest) }) : wire.returnQueryDocument(Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'signature')), read)
      calls.push({ url, options, body, document })
      assert.equal(verify(null, shared.canonical(document), createPublicKey(endpoint.signingPrivateKey), Buffer.from(body.signature, 'base64url')), true)
      const normal = () => new Response(JSON.stringify(write ? committed : { ...Object.fromEntries(['queryNonce', 'endpointId', 'keyFingerprint', 'expiresAt'].map(key => [key, body[key]])), ...(read ? { status: state.response } : { requests: [state.response] }) }), { status: 201 })
      return hooks.fetch ? hooks.fetch(url, options, body, normal) : normal()
    } })
  const upload = () => client.checkpoint({ scope, endpoint, status: pending, stopped, assertCurrent: check })
  return { client, endpoint, desktop, scope, authority, request, pending, committed, stopped, manifestHash, state, calls, proof, hooks, check, upload }
}

test('paired pending and exact reads sign one-use bounded queries without human overrides or private state', async () => {
  const f = fixture(), pending = await f.client.pending(f.scope, f.endpoint, f.check); assert.equal(pending.length, 1); assert.deepEqual(pending[0], f.pending)
  assert.deepEqual(await f.client.read(f.scope, f.endpoint, f.request.requestId, f.check), f.pending)
  assert.notEqual(f.calls[0].body.queryNonce, f.calls[1].body.queryNonce); assert.equal(f.calls[0].body.expiresAt, f.state.now + 9000)
  assert.equal(f.calls[0].url, 'https://hoai.test/api/v1/browser/profile-sync/return-intents/pending')
  assert.deepEqual(Object.keys(f.calls[0].options.headers).sort(), ['Accept', 'Accept-Encoding', 'Content-Type', 'X-BGOS-Pairing'])
  for (const call of f.calls) { assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.redirect, 'error'); assert.equal(call.options.cache, 'no-store'); assert.equal(call.options.body.includes('SYNTHETIC_RETURN_STATE_ONLY'), false) }
})

test('only a fixed secure HOAI origin or exact loopback fixture can be configured',()=>{
  for(const origin of ['http://agent.test','https://user:secret@hoai.test','https://hoai.test/?token=x','https://hoai.test/#private'])assert.throws(()=>new AgentReturnIntentClient({origin,authorizePairing:async()=>({})}),/configuration_invalid/)
})

test('one checkpoint sends original encrypted bytes and positive signed receipt then refuses every resend', async () => {
  const f = fixture(); assert.deepEqual(await f.upload(), f.committed); assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].body.encryptedPayload, f.stopped.checkpoint.ciphertext); assert.deepEqual(f.calls[0].body.stoppedReceipt, f.stopped.receipt)
  await assert.rejects(f.upload(), /checkpoint_attempted/); assert.equal(f.calls.length, 1)
})

test('a possible checkpoint write failure is unknown and can only be followed by signed reads', async () => {
  for (const fault of ['network', 'http', 'manifest', 'intent', 'malformed']) {
    const f = fixture(); f.hooks.fetch = async (_url: string, _options: any, _body: any, normal: () => Response) => {
      if (fault === 'network') throw Error('PRIVATE_NETWORK_DETAIL')
      if (fault === 'http') return new Response('{}', { status: 403 })
      if (fault === 'malformed') return new Response('not json')
      const response = await normal().json() as any; if (fault === 'manifest') { response.manifestHash = '0'.repeat(64); response.sourceStopped.receipt.manifestHash = response.manifestHash; response.sourceStopped.signature = shared.documentSignature(f.endpoint, response.sourceStopped.receipt) } else response.intentHash = '0'.repeat(64)
      return new Response(JSON.stringify(response))
    }
    await assert.rejects(f.upload(), { code: 'profile_return_outcome_unknown' }); await assert.rejects(f.upload(), /checkpoint_attempted/)
    delete f.hooks.fetch; assert.deepEqual(await f.client.read(f.scope, f.endpoint, f.request.requestId, f.check), f.pending)
    assert.equal(f.calls.filter(call => call.url.endsWith('/checkpoint')).length, 1)
  }
})

test('crossed query echoes, scope, status fields and expired acknowledgments are refused', async () => {
  for (const fault of ['nonce', 'endpoint', 'expiry', 'actor', 'extra', 'duplicate', 'capacity']) {
    const f = fixture(); f.hooks.fetch = async (_url: string, _options: any, _body: any, normal: () => Response) => {
      const response = await normal().json() as any
      if (fault === 'nonce') response.queryNonce = 'a'.repeat(43)
      else if (fault === 'endpoint') response.endpointId = randomUUID()
      else if (fault === 'expiry') f.state.now += 9000
      else if (fault === 'actor') { const row=response.requests[0];row.request.sourceAuthority.actingUserId='sharer';row.signature=shared.documentSignature(f.desktop,row.request);row.intentHash=wire.returnIntentHash({request:row.request,signature:row.signature}) }
      else if (fault === 'extra') response.requests[0].unexpected = true
      else if(fault==='duplicate')response.requests=Array(2).fill(response.requests[0])
      else response.requests=Array.from({length:17},()=>{const request={...response.requests[0].request,requestId:randomUUID()},signature=shared.documentSignature(f.desktop,request);return{...response.requests[0],request,signature,intentHash:wire.returnIntentHash({request,signature})}})
      return new Response(JSON.stringify(response))
    }
    await assert.rejects(f.client.pending(f.scope, f.endpoint, f.check), /response_invalid/)
  }
})

test('wrong private key, scope, authorizer and synchronous current proof fail closed before dispatch', async () => {
  for (const fault of ['key', 'scope', 'pairing', 'owner', 'assistant', 'async-current']) {
    const f = fixture(), scope: any = { ...f.scope }, endpoint = { ...f.endpoint }; let check: any = f.check
    if (fault === 'key') endpoint.signingPrivateKey = codec.createEndpointIdentity(randomUUID()).signingPrivateKey
    else if (fault === 'scope') scope.extra = true
    else if (fault === 'pairing') f.proof.pairingId++
    else if (fault === 'owner') f.proof.ownerUserId = 'foreign'
    else if (fault === 'assistant') f.proof.assistantId++
    else check = async () => true
    await assert.rejects(f.client.pending(scope, endpoint, check)); assert.equal(f.calls.length, 0)
  }
})

test('late pairing or context changes cannot authorize an acknowledgment', async () => {
  for (const fault of ['token', 'verifier', 'source', 'clock']) {
    const f = fixture(), gate = deferred<Response>(); f.hooks.fetch = async () => gate.promise
    const pending = f.client.pending(f.scope, f.endpoint, f.check), rejected = assert.rejects(pending, /context_changed/); await new Promise(resolve => setImmediate(resolve))
    if (fault === 'token') f.proof.token = 'different'
    else if (fault === 'verifier') f.proof.assertCurrent = () => {}
    else if (fault === 'source') f.state.current = false
    else f.state.now--
    gate.resolve(new Response('{}')); await rejected
  }
})

test('timeout retains the physical request until settlement and never permits a checkpoint resend', async () => {
  const f = fixture(20), gate = deferred<Response>(); f.hooks.fetch = async () => gate.promise
  await assert.rejects(f.upload(), /outcome_unknown/); await assert.rejects(f.client.pending(f.scope, f.endpoint, f.check), /busy/)
  assert.deepEqual(f.client.activity(), { pendingPhysicalOperations: 1, cleanupUnknown: false })
  let drained = false; const drain = f.client.whenDrained().then(() => { drained = true }); await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false)
  gate.resolve(new Response('{}')); await drain; delete f.hooks.fetch; await assert.rejects(f.upload(), /checkpoint_attempted/)
  assert.deepEqual(f.client.activity(), { pendingPhysicalOperations: 0, cleanupUnknown: false })
  assert.deepEqual(await f.client.read(f.scope, f.endpoint, f.request.requestId, f.check), f.pending)
})

test('unconfirmed response cleanup retains the physical slot permanently', async () => {
  const f = fixture(); f.hooks.fetch = async () => ({ status: 200, redirected: false, body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => { throw Error('PRIVATE_CLEANUP') }, releaseLock() {} }) } })
  await assert.rejects(f.client.pending(f.scope, f.endpoint, f.check), /cleanup_unconfirmed/); await assert.rejects(f.client.whenDrained(), /cleanup_unconfirmed/)
  assert.deepEqual(f.client.activity(), { pendingPhysicalOperations: 1, cleanupUnknown: true })
  await assert.rejects(f.client.pending(f.scope, f.endpoint, f.check), /busy/); assert.equal(f.calls.length, 1)
})

test('malformed and oversized bounded responses expose fixed errors without private bytes', async () => {
  for (const body of ['PRIVATE_REMOTE_BODY', 'x'.repeat(65537), new Uint8Array([255])]) {
    const f = fixture(); f.hooks.fetch = async () => new Response(body)
    await assert.rejects(f.client.pending(f.scope, f.endpoint, f.check), { code: 'profile_return_response_invalid' })
  }
})
