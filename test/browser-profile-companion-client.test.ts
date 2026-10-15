import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash, createPublicKey, randomUUID, sign, verify } from 'node:crypto'
import { AgentProfileCoordinatorClient } from '../lib/browser-profile-companion-client.mjs'
const require = createRequire(import.meta.url)
const codec = require('../lib/browser-profile-core/crypto.js')
const shared = require('../lib/browser-profile-core/coordinator-client.js')
type RecordValue = Record<string, unknown>
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 201, headers: { 'Content-Type': 'application/json' } })
function fixture(fetcher?: (url: string, options: RequestInit) => Promise<Response>, timeoutMs = 2000) {
  const endpoint = codec.createEndpointIdentity(randomUUID()), scope = { profileId: randomUUID(), actingUserId: 'recipient', assistantId: 42, endpointId: endpoint.identity.endpointId, keyFingerprint: codec.identityFingerprint(endpoint.identity), pairingId: 7, ownerUserId: 'machine-owner' }
  const intent = { intentId: randomUUID(), profileId: scope.profileId, actingUserId: scope.actingUserId, assistantId: scope.assistantId, ownerUserId: scope.ownerUserId, pairingId: scope.pairingId, requestNonce: 'a'.repeat(43), expiresAt: Date.now() + 290000, state: 'pending', offer: null, acceptedEndpoint: null }
  const profile = { id: scope.profileId, actingUserId: scope.actingUserId, assistantId: scope.assistantId, revision: 0, headManifestHash: null, contentKeyEpoch: 1, writerEpoch: 0, writerState: 'idle', endpointId: null, bootId: null, runtimeId: null, sessionId: null }
  const calls: Array<{ url: string; options: RequestInit }> = []; let active = true
  const client = new AgentProfileCoordinatorClient({ endpoint: 'https://hoai.test', timeoutMs, authorizePairing: async () => ({ token: 'synthetic-pairing-only', assertCurrent() { if (!active) throw Error('private stale proof') } }), fetchImpl: async (url: string, options: RequestInit) => { calls.push({ url, options }); return fetcher ? fetcher(url, options) : response({ intents: [intent], truncated: false }) } })
  return { client, endpoint, scope, intent, profile, calls, revoke: () => { active = false } }
}
test('setup reads only explicit scoped intents and sends no human or acting credential', async () => {
  const f = fixture(), result = await f.client.pending(42, 'agent-boot')
  assert.equal(result.intents[0].actingUserId, 'recipient'); assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, 'https://hoai.test/api/v1/browser/profile-sync/endpoint-offers/pending')
  const headers = f.calls[0].options.headers as Record<string, string>
  assert.deepEqual(Object.keys(headers).sort(), ['Accept', 'Accept-Encoding', 'Content-Type', 'X-BGOS-Pairing'].sort())
  assert.equal(f.calls[0].options.credentials, 'omit'); assert.equal(f.calls[0].options.redirect, 'error')
  const wrong = fixture(async () => response({ intents: [{ ...f.intent, assistantId: 43 }], truncated: false }))
  await assert.rejects(wrong.client.pending(42, 'boot'), { code: 'profile_companion_response_invalid' })
})
test('candidate possession proof binds the exact recipient intent, boot and public pin', async () => {
  let value: ReturnType<typeof fixture>
  value = fixture(async (_url, options) => {
    const body = JSON.parse(String(options.body)), document = { version: 1, kind: 'agent-endpoint-offer', ...Object.fromEntries(['intentId', 'profileId', 'actingUserId', 'assistantId', 'ownerUserId', 'pairingId', 'requestNonce', 'expiresAt'].map(key => [key, value.intent[key as keyof typeof value.intent]])), ...body, keyFingerprint: value.scope.keyFingerprint }
    delete document.signature
    assert.equal(verify(null, shared.canonical(document), createPublicKey(value.endpoint.signingPrivateKey), Buffer.from(body.signature, 'base64url')), true)
    const offerHash = require('node:crypto').createHash('sha256').update(shared.canonical(document)).digest('hex')
    return response({ ...value.intent, offer: { ...document, signature: body.signature, offerHash } })
  })
  const result = await value.client.publish(value.intent, value.endpoint, 'current-boot', 'Agent browser')
  assert.deepEqual(result.scope, value.scope); assert.ok(!String(value.calls[0].options.body).includes('PrivateKey'))
  await assert.rejects(value.client.publish(value.intent, value.endpoint, 'current-boot', 'bad\nlabel'), { code: 'profile_companion_offer_invalid' })
})
test('identity-only reload accepts exactly the locally pinned scope and never creates current grants', async () => {
  let f: ReturnType<typeof fixture>
  f = fixture(async () => response({ purpose: 'enrollment-identity', ...f.scope, pinnedIdentity: f.endpoint.identity }))
  assert.deepEqual(await f.client.enrollment(f.scope, f.endpoint.identity), { purpose: 'enrollment-identity', ...f.scope, pinnedIdentity: f.endpoint.identity })
  await assert.rejects(f.client.enrollment({ ...f.scope, keyFingerprint: '0'.repeat(64) }, f.endpoint.identity), { code: 'profile_companion_pin_changed' })
  const forged = fixture(async () => response({ purpose: 'enrollment-identity', ...f.scope, pinnedIdentity: f.endpoint.identity, grantVersion: 1 }))
  await assert.rejects(forged.client.enrollment(forged.scope, forged.endpoint.identity), { code: 'profile_companion_pin_changed' })
})
test('signed discovery checks every echoed nonce and original recipient before returning advisory state', async () => {
  let f: ReturnType<typeof fixture>
  f = fixture(async (_url, options) => {
    const body = JSON.parse(String(options.body)), document = { version: 1, kind: 'agent-endpoint-discovery', endpointId: f.scope.endpointId, ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'signature')), pairingId: f.scope.pairingId, ownerUserId: f.scope.ownerUserId }
    assert.equal(verify(null, shared.canonical(document), createPublicKey(f.endpoint.signingPrivateKey), Buffer.from(body.signature, 'base64url')), true)
    return response({ requestId: body.requestId, endpointId: f.scope.endpointId, expiresAt: body.expiresAt, profiles: [{ profile: f.profile, grant: { generation: 1, backgroundUse: true }, pendingDestinations: [] }], nextCursor: null })
  })
  assert.equal((await f.client.discover(f.scope, f.endpoint)).profiles[0].profile.writerState, 'idle')
  for (const change of [{ requestId: randomUUID() }, { endpointId: randomUUID() }, { expiresAt: Date.now() - 1 }]) {
    let g: ReturnType<typeof fixture>
    g = fixture(async (_url, options) => { const body = JSON.parse(String(options.body)); return response({ requestId: body.requestId, endpointId: g.scope.endpointId, expiresAt: body.expiresAt, profiles: [], nextCursor: null, ...change }) })
    await assert.rejects(g.client.discover(g.scope, g.endpoint), { code: 'profile_companion_response_invalid' })
  }
  let foreign: ReturnType<typeof fixture>
  foreign = fixture(async (_url, options) => { const body = JSON.parse(String(options.body)); return response({ requestId: body.requestId, endpointId: foreign.scope.endpointId, expiresAt: body.expiresAt, profiles: [{ profile: { ...foreign.profile, actingUserId: 'sharer' }, grant: { generation: 1, backgroundUse: true }, pendingDestinations: [] }], nextCursor: null }) })
  await assert.rejects(foreign.client.discover(foreign.scope, foreign.endpoint), { code: 'profile_companion_scope_invalid' })
})
test('a timed-out unresolved network operation retains the one physical request slot', async () => {
  let release!: (value: Response) => void, blocked = true
  const f = fixture(async () => blocked ? new Promise<Response>(resolve => { release = resolve }) : response({ intents: [], truncated: false }), 20)
  await assert.rejects(f.client.pending(42, 'boot'), { code: 'profile_companion_connection_unavailable' })
  await assert.rejects(f.client.pending(42, 'boot'), { code: 'profile_companion_request_busy' }); assert.equal(f.calls.length, 1)
  release(response({ intents: [], truncated: false })); blocked = false; await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await f.client.pending(42, 'boot'), { intents: [], truncated: false })
})
test('activity keeps a late response cancellation reserved and clears only after positive settlement',async()=>{
  let reply!:(value:Response)=>void,finish!:()=>void,cancelling=false
  const f=fixture(async()=>new Promise<Response>(resolve=>{reply=resolve}),20)
  await assert.rejects(f.client.pending(42,'boot'),/connection_unavailable/);assert.deepEqual(f.client.activity(),{pendingPhysicalOperations:1,cleanupUnknown:false})
  let drained=false;const drain=f.client.whenDrained().then(()=>{drained=true});const body=new Response(new ReadableStream({cancel(){cancelling=true;return new Promise<void>(resolve=>{finish=resolve})}}));reply(body)
  while(!cancelling)await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);assert.equal(f.client.activity().pendingPhysicalOperations,1);finish();await drain
  assert.deepEqual(f.client.activity(),{pendingPhysicalOperations:0,cleanupUnknown:false});assert.equal(body.body?.locked,false)
})
test('failed response cleanup remains visible and blocks every later operation',async()=>{
  const f=fixture(async()=>({status:200,redirected:false,body:{getReader:()=>({read:async()=>({done:true}),cancel:async()=>{throw Error('PRIVATE_CLEANUP_FAILURE')},releaseLock(){}})}} as unknown as Response))
  await assert.rejects(f.client.pending(42,'boot'),/cleanup_unconfirmed/);assert.deepEqual(f.client.activity(),{pendingPhysicalOperations:1,cleanupUnknown:true});await assert.rejects(f.client.whenDrained(),/cleanup_unconfirmed/)
  await assert.rejects(f.client.pending(42,'boot'),/request_busy/);assert.equal(f.calls.length,1)
})
test('a dispatched candidate write with missing acknowledgement is not replayed', async () => {
  const f = fixture(async () => { throw Error('private transport output') })
  await assert.rejects(f.client.publish(f.intent, f.endpoint, 'boot', 'Agent browser'), { code: 'profile_companion_outcome_unknown' }); assert.equal(f.calls.length, 1)
})
test('invalid and rejected asynchronous current capabilities stop before any dispatch', async () => {
  let calls = 0
  const client = new AgentProfileCoordinatorClient({ endpoint: 'https://hoai.test', authorizePairing: async () => ({ token: 'synthetic', assertCurrent: async () => { throw Error('private rejected capability') } }), fetchImpl: async () => { calls++; return response({}) } })
  await assert.rejects(client.pending(42, 'boot'), { code: 'profile_companion_context_changed' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 0)
  const wrong = new AgentProfileCoordinatorClient({ endpoint: 'https://hoai.test', authorizePairing: async () => { throw Error('private authorization detail') } })
  await assert.rejects(wrong.pending(42, 'boot'), { code: 'profile_companion_pairing_required' })
})
test('response and origin bounds refuse oversized payloads and alternate peer URLs', async () => {
  const f = fixture(async () => response({ intents: [], truncated: false, excessive: 'a'.repeat(65536) }))
  await assert.rejects(f.client.pending(42, 'boot'), { code: 'profile_companion_response_too_large' })
  for (const endpoint of ['http://remote.test', 'https://user:secret@hoai.test', 'https://hoai.test?route=peer']) assert.throws(() => new AgentProfileCoordinatorClient({ endpoint, authorizePairing: () => ({}) }), { code: 'profile_companion_configuration_invalid' })
})

function readiness(f: ReturnType<typeof fixture>, purpose = 'start') {
  return { version:1,kind:'agent-runtime-request',requestId:randomUUID(),endpointId:f.scope.endpointId,purpose,expectedWriterEpoch:0,expectedRevision:0,expectedHeadManifestHash:null,profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,endpointOwnerUserId:f.scope.ownerUserId,pairingId:7,nonce:'a'.repeat(64),expiresAt:Date.now()+290000,grantVersion:1,keyFingerprint:f.scope.keyFingerprint,contentKeyEpoch:1 }
}
const processTuple = {bootId:'current-boot',runtimeId:'current-runtime',sessionId:'current-session'}
function readyValue(f: ReturnType<typeof fixture>, request: ReturnType<typeof readiness>) {
  const document={...request,kind:'agent-runtime-ready',...processTuple},start={version:1,kind:'session-start',profileId:request.profileId,actingUserId:request.actingUserId,assistantId:request.assistantId,endpointId:request.endpointId,...processTuple,expectedWriterEpoch:request.expectedWriterEpoch,expectedRevision:request.expectedRevision,grantVersion:request.grantVersion,keyFingerprint:request.keyFingerprint}
  const signature=sign(null,shared.canonical(document),f.endpoint.signingPrivateKey).toString('base64url'),startSignature=request.purpose==='start'?sign(null,shared.canonical(start),f.endpoint.signingPrivateKey).toString('base64url'):null
  const body={document,signature,startSignature};return {...body,readyHash:createHash('sha256').update(shared.canonical(body)).digest('hex')}
}
test('readiness discovery signs exact short-lived query and refuses unscoped or duplicate requests',async()=>{
  let f:ReturnType<typeof fixture>,request:ReturnType<typeof readiness>,changed=false
  f=fixture(async(_url,options)=>{const body=JSON.parse(String(options.body)),{signature,...fields}=body;assert.equal(verify(null,shared.canonical({version:1,kind:'agent-runtime-request-discovery',...fields}),createPublicKey(f.endpoint.signingPrivateKey),Buffer.from(signature,'base64url')),true);return response({...fields,requests:[{request:changed?{...request,actingUserId:'sharer'}:request,state:'pending',ready:null,confirmation:null}]})});request=readiness(f)
  assert.equal((await f.client.pendingRuntimeRequests(f.scope,f.endpoint))[0].request.requestId,request.requestId)
  changed=true;await assert.rejects(f.client.pendingRuntimeRequests(f.scope,f.endpoint),{code:'profile_companion_readiness_invalid'})
})
test('initial ready signs both exact intents, while receive-transfer body never sends a start signature',async()=>{
  for(const purpose of ['start','receive-transfer']){
    let f:ReturnType<typeof fixture>,request:ReturnType<typeof readiness>
    f=fixture(async(_url,options)=>{const body=JSON.parse(String(options.body)),ready=readyValue(f,request);assert.deepEqual(Object.keys(body).sort(),[...Object.keys(processTuple),'signature',...(purpose==='start'?['startSignature']:[])].sort());assert.equal(body.signature,ready.signature);return response({request,state:'ready',ready,confirmation:null})});request=readiness(f,purpose)
    const result=await f.client.ready(f.scope,f.endpoint,request,processTuple);assert.equal(result.ready?.document.bootId,processTuple.bootId);assert.equal(result.confirmation,null)
  }
})
test('confirmed readiness remains advisory and exact signed destination plus echoed read nonce cannot be substituted',async()=>{
  let f:ReturnType<typeof fixture>,request:ReturnType<typeof readiness>,attack=''
  f=fixture(async(_url,options)=>{const body=JSON.parse(String(options.body)),ready=readyValue(f,request),target={endpointId:f.scope.endpointId,...processTuple,grantVersion:1,keyFingerprint:f.scope.keyFingerprint},authority={profileId:f.scope.profileId,actingUserId:f.scope.actingUserId,assistantId:42,...target,writerEpoch:1,revision:0,contentKeyEpoch:1};if(attack==='authority')authority.sessionId='wrong-session';if(attack==='signature')ready.signature=Buffer.alloc(64).toString('base64url');if(attack==='startSignature')ready.startSignature=Buffer.alloc(64).toString('base64url');if(['signature','startSignature'].includes(attack))ready.readyHash=createHash('sha256').update(shared.canonical({document:ready.document,signature:ready.signature,startSignature:ready.startSignature})).digest('hex');return response({queryNonce:attack==='nonce'?randomUUID():body.queryNonce,endpointId:body.endpointId,keyFingerprint:body.keyFingerprint,expiresAt:body.expiresAt,status:{request,state:'confirmed',ready,confirmation:{authority}}})});request=readiness(f)
  assert.equal((await f.client.runtimeRequest(f.scope,f.endpoint,request.requestId)).state,'confirmed')
  for(const value of ['authority','signature','startSignature','nonce']){attack=value;await assert.rejects(f.client.runtimeRequest(f.scope,f.endpoint,request.requestId),{code:'profile_companion_readiness_invalid'})}
})
test('transition, capsule and staged routes sign their own purposes and keep all state traffic on HOAI',async()=>{
  let f:ReturnType<typeof fixture>;const transitionId=randomUUID(),hash='b'.repeat(64)
  f=fixture(async(url,options)=>{const body=JSON.parse(String(options.body));assert.equal(new URL(url).origin,'https://hoai.test');assert.equal((options.headers as Record<string,string>)['X-BGOS-Pairing'],'synthetic-pairing-only');return response({metadata:true,body})})
  const destination={endpointId:f.scope.endpointId,...processTuple,grantVersion:1,keyFingerprint:f.scope.keyFingerprint},transition={id:transitionId,manifestHash:hash,destination}
  const status=await f.client.transition(f.scope,f.endpoint,transitionId),body=(status as {body:RecordValue}).body,{signature,...fields}=body
  assert.equal(verify(null,shared.canonical({version:1,kind:'transition-read',transitionId,...fields}),createPublicKey(f.endpoint.signingPrivateKey),Buffer.from(String(signature),'base64url')),true)
  const capsule=await f.client.capsule(f.scope,f.endpoint,transition),capsuleSignature=(capsule as {body:{signature:string}}).body.signature
  assert.equal(verify(null,shared.canonical({version:1,kind:'checkpoint-read',profileId:f.scope.profileId,transitionId,manifestHash:hash,destination}),createPublicKey(f.endpoint.signingPrivateKey),Buffer.from(capsuleSignature,'base64url')),true)
  const receipt={version:1,kind:'destination-staged',profileId:f.scope.profileId,transitionId,manifestHash:hash,revision:1,destination,stagedInactive:true},staged={receipt,signature:sign(null,shared.canonical(receipt),f.endpoint.signingPrivateKey).toString('base64url')}
  await f.client.staged(f.scope,f.endpoint,transitionId,staged);assert.equal(f.calls.length,3)
  assert.throws(()=>f.client.staged(f.scope,f.endpoint,transitionId,{...staged,signature:Buffer.alloc(64).toString('base64url')}),{code:'profile_companion_scope_invalid'});assert.equal(f.calls.length,3)
})
