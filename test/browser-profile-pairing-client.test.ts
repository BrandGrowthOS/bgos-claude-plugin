import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID, verify } from 'node:crypto'
import { createRequire } from 'node:module'
import http from 'node:http'
import { PairedProfileCoordinatorClient, createPairedProfileRuntimeEndpoint } from '../lib/browser-profile-pairing-client.mjs'

const require = createRequire(import.meta.url), crypto = require('../lib/browser-profile-core/crypto.js'), { canonical, documentSignature, META_BYTES } = require('../lib/browser-profile-core/coordinator-client.js')
const tick = () => new Promise(resolve => setImmediate(resolve))
const response = (value: any, status = 200) => new Response(JSON.stringify(value), { status })
function fixture(options: any = {}) {
  const endpoint = crypto.createEndpointIdentity(randomUUID()), authority = { profileId: randomUUID(), actingUserId: 'recipient', assistantId: 7, endpointId: endpoint.identity.endpointId, bootId: 'boot', runtimeId: 'runtime', sessionId: 'session', writerEpoch: 1, revision: 0, contentKeyEpoch: 1, grantVersion: 2, keyFingerprint: crypto.identityFingerprint(endpoint.identity) }
  const calls: any[] = [], scopes: any[] = []; let current = true
  const proof: any = { pairingId: 12, ownerUserId: 'sharer', assistantId: 7, token: 'synthetic-pairing-token', assertCurrent() { if (!current) throw new Error('private-authority-text') } }
  const client = new PairedProfileCoordinatorClient({ endpoint: options.origin || 'https://hoai.test/path-is-not-a-route', authorizePairing: async (scope: any) => { scopes.push(scope); return proof }, fetchImpl: async (url: string, init: any) => { calls.push({ url, init }); return options.fetch ? options.fetch(url, init) : response({ accepted: true }) }, ...options.client })
  const rpc = { rpcId: randomUUID(), rpcNonce: 'a'.repeat(43), socketId: 'socket-1' }, request = { clientId: 'client-1', message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_snapshot' } } }
  return { client, calls, scopes, proof, endpoint, authority, rpc, request, revoke() { current = false } }
}
test('paired callers and endpoint signers use distinct fixed routes and never mix principals', async () => {
  const f = fixture(); await f.client.call(f.authority, f.request); await f.client.poll(f.authority, { rpcId: f.rpc.rpcId, clientId: 'client-1' }); await f.client.cancel(f.authority, { rpcId: f.rpc.rpcId, clientId: 'client-1' }); await f.client.dispatch(f.authority, f.endpoint, f.rpc); await f.client.cancellation(f.authority, f.endpoint, f.rpc); await f.client.result(f.authority, f.endpoint, { ...f.rpc, payload: { ok: false, error: { code: 'cancelled', message: 'fixture' } } })
  assert.deepEqual(f.calls.map(value => new URL(value.url).pathname), ['rpc/call', `rpc/${f.rpc.rpcId}/poll`, `rpc/${f.rpc.rpcId}/cancel`, `rpc/${f.rpc.rpcId}/dispatch`, `rpc/${f.rpc.rpcId}/cancellation`, `rpc/${f.rpc.rpcId}/result`].map(path => '/api/v1/browser/profile-sync/' + path))
  for (const [index, { init }] of f.calls.entries()) {
    assert.equal(init.headers['X-BGOS-Pairing'], 'synthetic-pairing-token'); assert.equal(init.headers['X-BGOS-Acting-User'], index < 3 ? 'recipient' : undefined)
    assert.equal(init.headers.Authorization, undefined); assert.equal(init.headers['X-API-Key'], undefined); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store'); assert.equal(init.signal.aborted, true)
  }
  assert.deepEqual(f.scopes.map(value => value.purpose), ['caller', 'caller', 'caller', 'endpoint', 'endpoint', 'endpoint']); assert.ok(f.scopes.every(Object.isFrozen)); assert.equal(f.proof.ownerUserId, 'sharer')
  for (const name of ['context', 'create', 'enrollDesktop', 'grant', 'start', 'begin', 'activate', '_request']) assert.equal((f.client as any)[name], undefined)
})

test('paired discovery uses the verified actor only and returns exact advisory managed authority',async()=>{
  let result:any;const f=fixture({fetch:async()=>response(result)}),scope={actingUserId:f.authority.actingUserId,assistantId:f.authority.assistantId}
  result={managed:false,...scope};assert.deepEqual(await f.client.resolve(scope),result)
  result={managed:true,...scope,profileId:f.authority.profileId,state:'active',authority:f.authority};assert.deepEqual(await f.client.resolve(scope),result)
  for(const state of ['idle','stopped','staged','quiescing','fenced']){result={managed:true,...scope,profileId:f.authority.profileId,state};assert.deepEqual(await f.client.resolve(scope),result)}
  for(const call of f.calls){assert.equal(new URL(call.url).pathname,'/api/v1/browser/profile-sync/rpc/resolve');assert.deepEqual(JSON.parse(call.init.body),{assistantId:7});assert.equal(call.init.headers['X-BGOS-Acting-User'],'recipient');assert.equal(call.init.headers.Authorization,undefined)}
  for(const malformed of [{managed:false,...scope,authority:f.authority},{managed:false,...scope,actingUserId:'sharer'},{managed:true,...scope,profileId:f.authority.profileId,state:'stopped',authority:f.authority},{managed:true,...scope,profileId:f.authority.profileId,state:'active',authority:{...f.authority,grantVersion:0}},{managed:true,...scope,profileId:randomUUID(),state:'active',authority:f.authority}]){
    result=malformed;await assert.rejects(f.client.resolve(scope))
  }
  assert.equal(f.scopes.every(value=>value.purpose==='caller'),true)
})
test('exact shared dispatch, cancellation and Unicode result signatures bind original authority', async () => {
  const f = fixture(), payload = { ok: true, message: { jsonrpc: '2.0', id: 1, result: { text: 'مرحبا 🌍' } } }
  await f.client.dispatch(f.authority, f.endpoint, f.rpc); await f.client.cancellation(f.authority, f.endpoint, f.rpc); await f.client.result(f.authority, f.endpoint, { ...f.rpc, payload })
  for (const [index, kind] of ['runtime-rpc-dispatch', 'runtime-rpc-cancellation', 'runtime-rpc-result'].entries()) {
    const body = JSON.parse(f.calls[index].init.body), document = { version: 1, kind, ...f.rpc, authority: f.authority, ...(index === 2 ? { payloadHash: createHash('sha256').update(Buffer.from(body.payload, 'base64')).digest('hex') } : {}) }
    assert.equal(verify(null, canonical(document), f.endpoint.signingPrivateKey, Buffer.from(body.signature, 'base64url')), true)
    if (index === 2) assert.deepEqual(JSON.parse(Buffer.from(body.payload, 'base64').toString()), payload)
  }
  assert.throws(() => f.client.dispatch({ ...f.authority, endpointId: randomUUID() }, f.endpoint, f.rpc), { code: 'profile_runtime_endpoint_invalid' })
})
test('invalid caller authority, group scope, notifications and oversized messages never dispatch', () => {
  const f = fixture()
  for (const options of [{ ...f.request, roomChatId: 1 }, { ...f.request, clientId: '../foreign' }, { ...f.request, message: { jsonrpc: '2.0', method: 'tools/call', params: {} } }, { ...f.request, message: { jsonrpc: '2.0', method: 'notifications/cancelled' } }, { ...f.request, message: { ...f.request.message, params: { text: 'a'.repeat(256 * 1024) } } }, { ...f.request, waitMs: 45001 }]) assert.throws(() => f.client.call(f.authority, options), { code: 'profile_sync_request_invalid' })
  assert.throws(() => f.client.call({ ...f.authority, foreign: true }, f.request), { code: 'profile_runtime_authority_invalid' }); assert.equal(f.calls.length, 0)
})
test('foreign or mixed pairing capabilities are refused before HTTP and mutated cached proof is discarded', async () => {
  for (const change of [{ assistantId: 8 }, { pairingId: 0 }, { ownerUserId: '' }, { token: 'bad\nheader' }, { assertCurrent: async () => true }, { assertCurrent: async () => { throw new Error('private-async-proof') } }]) {
    const f = fixture(); Object.assign(f.proof, change); await assert.rejects(f.client.call(f.authority, f.request), (error: any) => ['profile_sync_pairing_required', 'profile_sync_context_changed'].includes(error.code)); assert.equal(f.calls.length, 0)
  }
  let release: any; const f = fixture({ fetch: () => new Promise(resolve => { release = resolve }) }); const task = f.client.call(f.authority, f.request); while (!release) await tick(); f.proof.ownerUserId = 'different-owner'; f.proof.token = 'different-token'; release(response({ accepted: true })); await assert.rejects(task, { code: 'profile_sync_context_changed' }); assert.equal(f.calls.length, 1)
})
test('pairing revocation during HTTP or response streaming discards data without private error text', async () => {
  let release: any; const f = fixture({ fetch: () => new Promise(resolve => { release = resolve }) }); const task = f.client.dispatch(f.authority, f.endpoint, f.rpc); while (!release) await tick(); f.revoke(); release(response({ private: 'secret-data' })); await assert.rejects(task, (error: any) => error.code === 'profile_sync_context_changed' && !error.message.includes('private'))
  let stream: any; const g = fixture({ fetch: async () => new Response(new ReadableStream({ start(value) { stream = value } })) }); const reading = g.client.cancellation(g.authority, g.endpoint, g.rpc); while (!stream) await tick(); g.revoke(); stream.enqueue(Buffer.from('{"private":"secret-data"}')); stream.close(); await assert.rejects(reading, { code: 'profile_sync_context_changed' })
})
test('streamed bounds, invalid UTF8 and invalid JSON refuse without reflecting response content', async () => {
  for (const [body, code] of [[Buffer.alloc(META_BYTES + 1, 97), 'profile_sync_response_too_large'], [Buffer.from([0x22, 0xc0, 0xaf, 0x22]), 'profile_sync_response_invalid'], [Buffer.from('secret-cookie-no-json'), 'profile_sync_response_invalid']] as const) {
    const f = fixture({ fetch: async () => new Response(body) }); await assert.rejects(f.client.cancellation(f.authority, f.endpoint, f.rpc), (error: any) => error.code === code && !error.message.includes('cookie')); assert.equal(f.calls.length, 1)
  }
})
test('failed writes and stalled readers settle once with unknown outcome and no retries', async () => {
  const f = fixture({ fetch: async () => { throw new Error('private-network-text') } }); await assert.rejects(f.client.call(f.authority, f.request), { code: 'profile_sync_outcome_unknown' }); assert.equal(f.calls.length, 1)
  const g = fixture({ fetch: async () => new Response(new ReadableStream({ start() {} })), client: { timeoutMs: 5 } }); await assert.rejects(g.client.cancellation(g.authority, g.endpoint, g.rpc), { code: 'profile_sync_outcome_unknown' }); assert.equal(g.calls.length, 1)
  const refused = fixture({ fetch: async () => response({ code: 'browser_profile_storage_full', message: 'private-server-text' }, 507) }); await assert.rejects(refused.client.call(refused.authority, refused.request), (error: any) => error.code === 'browser_profile_storage_full' && error.statusCode === 507 && error.message === error.code); assert.equal(refused.calls.length, 1)
})
test('activity retains late fetch and body cancellation until positive physical settlement after timeout',async()=>{
  let reply!:(value:Response)=>void,finish!:()=>void,cancelling=false
  const f=fixture({client:{timeoutMs:20},fetch:()=>new Promise<Response>(resolve=>{reply=resolve})})
  await assert.rejects(f.client.cancellation(f.authority,f.endpoint,f.rpc),/outcome_unknown/);assert.deepEqual(f.client.activity(),{pendingPhysicalOperations:1,cleanupUnknown:false})
  let drained=false;const drain=f.client.whenDrained().then(()=>{drained=true})
  const body=new Response(new ReadableStream({cancel(){cancelling=true;return new Promise<void>(resolve=>{finish=resolve})}}));reply(body);while(!cancelling)await tick()
  assert.equal(drained,false);assert.equal(f.client.activity().pendingPhysicalOperations,1);finish();await drain
  assert.deepEqual(f.client.activity(),{pendingPhysicalOperations:0,cleanupUnknown:false});assert.equal(body.body?.locked,false);assert.equal(f.calls.length,1)
})
test('activity tracks a stalled body and failed cancellation remains unknown without automatic retries',async()=>{
  let read!:(value:any)=>void,finish!:()=>void,started=false,cancelled=false
  const f=fixture({client:{timeoutMs:20},fetch:async()=>({status:200,redirected:false,body:{getReader:()=>({read:()=>{started=true;return new Promise(resolve=>{read=resolve})},cancel:()=>{cancelled=true;return new Promise<void>(resolve=>{finish=resolve})},releaseLock(){}})}})})
  const pending=f.client.cancellation(f.authority,f.endpoint,f.rpc);while(!started)await tick();await assert.rejects(pending,/outcome_unknown/);assert.equal(f.client.activity().pendingPhysicalOperations,1)
  read({done:true});while(!cancelled)await tick();assert.equal(f.client.activity().pendingPhysicalOperations,1);finish();await f.client.whenDrained();assert.equal(f.client.activity().pendingPhysicalOperations,0)
  const failed=fixture({fetch:async()=>({status:200,redirected:false,body:{getReader:()=>({read:async()=>({done:true}),cancel:async()=>{throw Error('PRIVATE_CLEANUP_FAILURE')},releaseLock(){}})}})})
  await assert.rejects(failed.client.cancellation(failed.authority,failed.endpoint,failed.rpc),/cleanup_unconfirmed/);assert.deepEqual(failed.client.activity(),{pendingPhysicalOperations:1,cleanupUnknown:true});await assert.rejects(failed.client.whenDrained(),/cleanup_unconfirmed/)
  await assert.rejects(failed.client.cancellation(failed.authority,failed.endpoint,failed.rpc),/cleanup_unconfirmed/);assert.equal(failed.calls.length,1)
})
test('retained requests synchronously bound each exact profile to two slots before authorization or fetch',async()=>{
  const replies:Array<(value:Response)=>void>=[],f=fixture({client:{timeoutMs:20},fetch:()=>new Promise<Response>(resolve=>replies.push(resolve))})
  await assert.rejects(f.client.dispatch(f.authority,f.endpoint,f.rpc),/outcome_unknown/)
  await assert.rejects(f.client.cancellation(f.authority,f.endpoint,f.rpc),/outcome_unknown/)
  assert.equal(f.client.activity().pendingPhysicalOperations,2);const authorized=f.scopes.length,dispatched=f.calls.length
  await assert.rejects(f.client.result(f.authority,f.endpoint,{...f.rpc,payload:{ok:false,error:{code:'cancelled',message:'synthetic'}}}),/request_busy/)
  assert.equal(f.scopes.length,authorized);assert.equal(f.calls.length,dispatched)
  for(const reply of replies)reply(response({accepted:true}));await f.client.whenDrained();assert.equal(f.client.activity().pendingPhysicalOperations,0)
  const next=f.client.cancellation(f.authority,f.endpoint,f.rpc),rejected=assert.rejects(next,/outcome_unknown/);await rejected;assert.equal(f.calls.length,3);replies[2](response({accepted:true}));await f.client.whenDrained()
})
test('the ninth retained physical request is refused globally before authorization and independent profiles release only after drain',async()=>{
  const replies:Array<(value:Response)=>void>=[],f=fixture({client:{timeoutMs:20},fetch:()=>new Promise<Response>(resolve=>replies.push(resolve))})
  for(let index=0;index<8;index++)await assert.rejects(f.client.call({...f.authority,profileId:randomUUID()},f.request),/outcome_unknown/)
  assert.equal(f.client.activity().pendingPhysicalOperations,8);assert.equal(f.scopes.length,8)
  await assert.rejects(f.client.call({...f.authority,profileId:randomUUID()},f.request),/request_busy/);assert.equal(f.scopes.length,8);assert.equal(f.calls.length,8)
  replies[0](response({accepted:true}));await tick();assert.equal(f.client.activity().pendingPhysicalOperations,7)
  await assert.rejects(f.client.call({...f.authority,profileId:randomUUID()},f.request),/outcome_unknown/);assert.equal(f.calls.length,9)
  for(const reply of replies.slice(1))reply(response({accepted:true}));await f.client.whenDrained();assert.deepEqual(f.client.activity(),{pendingPhysicalOperations:0,cleanupUnknown:false})
})
test('insecure, credential-bearing or query-bearing endpoints cannot be configured', () => {
  for (const endpoint of ['http://hoai.test', 'https://user:password@hoai.test', 'https://hoai.test/?token=x', 'https://hoai.test/#x', 'file:///private']) assert.throws(() => new PairedProfileCoordinatorClient({ endpoint, authorizePairing() {} }), { code: 'profile_sync_configuration_invalid' })
  const f = fixture(); assert.throws(() => Object.assign(f.client, { origin: 'https://foreign.test' }), TypeError)
})
function transferFixture() {
  const f = fixture(), target = fixture(), key = crypto.createContentKeyEpoch(1), transitionId = randomUUID()
  const targetAuthority = { ...f.authority, endpointId: target.endpoint.identity.endpointId, bootId: 'target-boot', runtimeId: 'target-runtime', sessionId: 'target-session', writerEpoch: 2, revision: 1, grantVersion: 3, keyFingerprint: crypto.identityFingerprint(target.endpoint.identity) }
  const source = { endpointId: f.authority.endpointId, bootId: 'boot', runtimeId: 'runtime', sessionId: 'session', writerEpoch: 1 }, destination = { endpointId: targetAuthority.endpointId, bootId: 'target-boot', runtimeId: 'target-runtime', sessionId: 'target-session', grantVersion: 3, keyFingerprint: targetAuthority.keyFingerprint }
  const context = { version: 1, schemaVersion: 1, profileId: f.authority.profileId, actingUserId: 'recipient', assistantId: 7, transitionId, revision: 1, previousManifestHash: null, keyEpoch: 1, source, destination }
  const checkpoint = crypto.sealCheckpoint({ plaintext: Buffer.from('synthetic encrypted profile'), context, source: f.endpoint, destinationIdentity: target.endpoint.identity, contentKeyEpoch: key }), hash = crypto.manifestHash(checkpoint.manifest)
  const receipt = { version: 1, kind: 'source-stopped', profileId: context.profileId, transitionId, manifestHash: hash, revision: 1, source, stopped: true }, stopped = { checkpoint, receipt, signature: documentSignature(f.endpoint, receipt) }
  const stagedReceipt = { version: 1, kind: 'destination-staged', profileId: context.profileId, transitionId, manifestHash: hash, revision: 1, destination, stagedInactive: true }, staged = { receipt: stagedReceipt, signature: documentSignature(target.endpoint, stagedReceipt) }
  return { f, target, targetAuthority, context, stopped, staged, key, hash }
}
test('checkpoint, capsule and stage use exact signed endpoint documents without actor headers', async () => {
  const x = transferFixture(); await x.f.client.commitStopped(x.f.authority, x.f.endpoint, x.stopped); await x.target.client.readCapsule(x.targetAuthority, x.target.endpoint, { transitionId: x.context.transitionId, manifestHash: x.hash }); await x.target.client.staged(x.targetAuthority, x.target.endpoint, x.staged)
  const commit = JSON.parse(x.f.calls[0].init.body); assert.deepEqual(commit.stoppedReceipt, x.stopped.receipt); assert.equal(commit.encryptedPayload, x.stopped.checkpoint.ciphertext); assert.equal(commit.stoppedSignature, x.stopped.signature)
  const read = JSON.parse(x.target.calls[0].init.body), document = { version: 1, kind: 'checkpoint-read', profileId: x.context.profileId, transitionId: x.context.transitionId, manifestHash: x.hash, destination: x.context.destination }
  assert.equal(verify(null, canonical(document), x.target.endpoint.signingPrivateKey, Buffer.from(read.signature, 'base64url')), true)
  assert.ok([...x.f.calls, ...x.target.calls].every(value => value.init.headers['X-BGOS-Acting-User'] === undefined)); assert.deepEqual(JSON.parse(x.target.calls[1].init.body), x.staged); x.key.key.fill(0)
})
test('cross-profile, corrupted ciphertext and changed stopped or stage receipts fail before HTTP', () => {
  const x = transferFixture()
  assert.throws(() => x.f.client.commitStopped({ ...x.f.authority, actingUserId: 'sharer' }, x.f.endpoint, x.stopped), { code: 'profile_sync_checkpoint_invalid' })
  assert.throws(() => x.f.client.commitStopped(x.f.authority, x.f.endpoint, { ...x.stopped, checkpoint: { ...x.stopped.checkpoint, ciphertext: Buffer.from('corrupt').toString('base64') } }), { code: 'profile_sync_checkpoint_invalid' })
  assert.throws(() => x.f.client.commitStopped(x.f.authority, x.f.endpoint, { ...x.stopped, signature: 'a'.repeat(86) }), { code: 'profile_sync_signature_invalid' })
  assert.throws(() => x.target.client.staged(x.targetAuthority, x.target.endpoint, { ...x.staged, receipt: { ...x.staged.receipt, stagedInactive: false } }), { code: 'profile_sync_stage_invalid' })
  assert.throws(() => x.target.client.staged(x.targetAuthority, x.target.endpoint, { ...x.staged, signature: 'a'.repeat(86) }), { code: 'profile_sync_signature_invalid' }); assert.equal(x.f.calls.length + x.target.calls.length, 0); x.key.key.fill(0)
})
test('vendored endpoint fetches the stored command, proves socket identity and retains physical drain through cancellation', async () => {
  let finish: any, started: any, allowCancel = false; const f = fixture({ fetch: async (url: string, init: any) => {
    const body = JSON.parse(init.body)
    if (url.endsWith('/dispatch')) return response({ frame })
    if (url.endsWith('/cancellation')) return response({ requested: allowCancel })
    assert.equal(verify(null, canonical({ version: 1, kind: 'runtime-rpc-result', ...f.rpc, authority: f.authority, payloadHash: createHash('sha256').update(Buffer.from(body.payload, 'base64')).digest('hex') }), f.endpoint.signingPrivateKey, Buffer.from(body.signature, 'base64url')), true)
    assert.equal(JSON.parse(Buffer.from(body.payload, 'base64').toString()).ok, false); return response({ accepted: true })
  } })
  const bindingId = randomUUID(), hint = { ...f.rpc, bindingId, authority: f.authority }, frame = { event_type: 'browser_profile_rpc', version: 1, rpcId: f.rpc.rpcId, rpcNonce: f.rpc.rpcNonce, bindingId, authority: f.authority, clientId: 'client-1', assistantId: 7, message: f.request.message, deadlineAt: new Date(Date.now() + 60000).toISOString() }
  const runtime = createPairedProfileRuntimeEndpoint({ authority: f.authority, endpoint: f.endpoint, client: f.client, assertCurrent() {}, execute: async (value: any) => { started = value; await new Promise(resolve => { finish = resolve }); return { ok: true, message: { jsonrpc: '2.0', id: 1, result: { secret: 'must-not-publish-after-cancel' } } } } })
  let challenge: any
  assert.throws(() => createPairedProfileRuntimeEndpoint({ authority: f.authority, endpoint: f.endpoint, client: { dispatch() {}, cancellation() {}, result() {} }, assertCurrent() {}, execute() {} }), { code: 'profile_runtime_endpoint_invalid' })
  await runtime.prove({ socketId: f.rpc.socketId, exchange: async (event: string, body: any) => {
    if (event === 'browser_profile_challenge') { challenge = { version: 1, kind: 'runtime-socket-binding', challengeId: randomUUID(), nonce: 'b'.repeat(43), socketId: f.rpc.socketId, expiresAt: Date.now() + 30000, authority: f.authority }; return { ok: true, challenge } }
    assert.equal(verify(null, canonical(challenge), f.endpoint.signingPrivateKey, Buffer.from(body.signature, 'base64url')), true); return { ok: true, binding: { bindingId, socketId: f.rpc.socketId, authority: f.authority } }
  } })
  const pending = runtime.receive({ ...hint, message: { method: 'forged-renderer-command' } }); while (!finish) await tick(); assert.equal(started.frame.message.method, 'tools/call')
  assert.equal((await runtime.cancel(hint)).requested, false); assert.equal(started.signal.aborted, false); allowCancel = true; assert.equal((await runtime.cancel(hint)).requested, true); assert.equal(started.signal.aborted, true)
  let drained = false; const drain = runtime.whenDrained().then(() => { drained = true }); await tick(); assert.equal(drained, false); finish(); await pending; await drain; assert.equal(drained, true); assert.equal((await runtime.receive(hint)).duplicate, true)
})
test('real loopback HTTP uses one pairing principal while actor headers remain caller-only', async t => {
  const seen: any[] = [], server = http.createServer((request, reply) => { const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => { seen.push({ path: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }); reply.writeHead(200, { 'content-type': 'application/json' }); reply.end('{"accepted":true}') }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close() }); const address = server.address() as any
  const f = fixture({ origin: `http://127.0.0.1:${address.port}`, client: { fetchImpl: globalThis.fetch } }); await f.client.call(f.authority, f.request); await f.client.dispatch(f.authority, f.endpoint, f.rpc)
  assert.equal(seen.length, 2); assert.equal(seen[0].headers['x-bgos-acting-user'], 'recipient'); assert.equal(seen[1].headers['x-bgos-acting-user'], undefined); assert.equal(seen[1].headers['x-bgos-pairing'], 'synthetic-pairing-token'); assert.ok(seen.every(value => !value.headers.authorization && !value.headers['x-api-key']))
})
test('real HTTP redirects never forward a pairing token or replay the request', async t => {
  const seen: string[] = [], server = http.createServer((request, reply) => { seen.push(request.url || ''); if (request.url !== '/unexpected') { reply.writeHead(307, { location: '/unexpected' }); reply.end(); return } reply.end('{"accepted":true}') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close() }); const address = server.address() as any
  const f = fixture({ origin: `http://127.0.0.1:${address.port}`, client: { fetchImpl: globalThis.fetch } }); await assert.rejects(f.client.call(f.authority, f.request), { code: 'profile_sync_outcome_unknown' }); assert.deepEqual(seen, ['/api/v1/browser/profile-sync/rpc/call'])
})
