import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ProfileTargetLedger, restoreProfileEndpoint, restoreProfileEnrollment, BrowserProfileRuntime, profileCrypto } from '../lib/browser-profile-runtime.mjs'
import { profileLaunchArguments } from '../lib/browser-profile-launch.mjs'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomUUID, sign } from 'node:crypto'

const tick = () => new Promise(resolve => setImmediate(resolve))
const emptyExtras = () => ({ passwordVault: { v: 1, entries: [], neverOrigins: [] }, preferences: { v: 1, searchEngine: 'google' } })
class Protocol extends EventEmitter {
  calls: any[] = []; targets = new Map<string, any>(); noPause = false; refuseNetwork = false
  async send(method: string, params: any = {}): Promise<any> {
    this.calls.push({ method, params })
    if (method === 'Target.getTargets') return { targetInfos: [...this.targets.values()] }
    if (method === 'Target.attachToTarget') return { sessionId: 'legacy-' + params.targetId }
    if (method === 'Target.detachFromTarget') { this.emit('Target.detachedFromTarget', { sessionId: params.sessionId }); return {} }
    if (method === 'Target.sendMessageToTarget') {
      const command = JSON.parse(params.message)
      if (command.method === 'Target.sendMessageToTarget') {
        const child = JSON.parse(command.params.message)
        const emit = (message: any) => this.event(params.sessionId, 'Target.receivedMessageFromTarget', { sessionId: command.params.sessionId, message: JSON.stringify(message) })
        if (child.method === 'Debugger.pause' && !this.noPause) emit({ method: 'Debugger.paused', params: {} })
        if (child.method === 'Debugger.resume') emit({ method: 'Debugger.resumed', params: {} })
        setImmediate(() => emit({ id: child.id, result: {} }))
      }
      if (command.method === 'Debugger.pause' && !this.noPause) this.event(params.sessionId, 'Debugger.paused', {})
      if (command.method === 'Debugger.resume') this.event(params.sessionId, 'Debugger.resumed', {})
      setImmediate(() => this.emit('Target.receivedMessageFromTarget', { sessionId: params.sessionId, message: JSON.stringify({ id: command.id, ...(this.refuseNetwork && command.method === 'Network.enable' ? { error: { message: 'Unsupported' } } : { result: {} }) }) }))
    }
    return {}
  }
  add(id: string, type = 'page', context = 'context-a', url = 'https://fixture.test/') {
    const targetInfo = { targetId: id, type, browserContextId: context, url }; this.targets.set(id, targetInfo)
    this.emit('Target.targetCreated', { targetInfo }); this.emit('Target.attachedToTarget', { sessionId: 'flat-' + id, targetInfo, waitingForDebugger: true }); return targetInfo
  }
  event(sessionId: string, method: string, params: any) { this.emit('Target.receivedMessageFromTarget', { sessionId, message: JSON.stringify({ method, params }) }) }
  child(id: string, method: string, params: any = {}) { this.event('legacy-' + id, method, params) }
  childCommands(method: string) { return this.calls.filter(value => value.method === 'Target.sendMessageToTarget').map(value => JSON.parse(value.params.message)).filter(value => value.method === method) }
}
async function fixture(t: any, options: any = {}) {
  const root = new Protocol(), ledger = new ProfileTargetLedger(root, { timeoutMs: 30, ...options }); t.after(() => ledger.dispose()); await ledger.start()
  return { root, ledger, ready: async (id: string, type = 'page', context = 'context-a', url?: string) => { root.add(id, type, context, url); await ledger.readyTarget(id) } }
}
test('target discovery pauses births and installs raw Network tracking before any first resume', async t => {
  const f = await fixture(t); await f.ready('page')
  assert.deepEqual(f.root.calls.find(value => value.method === 'Target.setAutoAttach')?.params, { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
  const methods = f.root.calls.filter(value => value.method === 'Target.sendMessageToTarget').map(value => JSON.parse(value.params.message).method)
  assert.ok(methods.indexOf('Network.enable') < methods.indexOf('Runtime.runIfWaitingForDebugger'))
  assert.equal((await f.ledger.inventory('context-a')).length, 1)
})
test('nested dedicated workers inherit the exact parent context and route raw request ownership through the parent', async t => {
  const f = await fixture(t); await f.ready('page')
  f.root.event('legacy-page', 'Target.attachedToTarget', { sessionId: 'nested-worker', targetInfo: { targetId: 'worker', type: 'worker', url: 'https://fixture.test/worker.js' }, waitingForDebugger: true })
  await f.ledger.readyTarget('worker'); const worker = f.ledger.targets.get('nested-worker'); assert.equal(worker?.browserContextId, 'context-a'); assert.equal(worker?.ready, true)
  f.root.event('legacy-page', 'Target.receivedMessageFromTarget', { sessionId: 'nested-worker', message: JSON.stringify({ method: 'Network.requestWillBeSent', params: { requestId: 'worker-token', request: { method: 'POST', url: 'https://fixture.test/token' } } }) })
  assert.throws(() => f.ledger.assertIdle('context-a'), { reason: 'profile_requests_in_flight' }); assert.doesNotThrow(() => f.ledger.assertIdle('context-b'))
  f.root.event('legacy-page', 'Target.detachedFromTarget', { sessionId: 'nested-worker' }); await assert.rejects(f.ledger.inventory('context-a'), { reason: 'profile_network_outcome_unknown' })
})
test('shared-worker HTTP stays in the raw ledger until its final response completes', async t => {
  const f = await fixture(t); await f.ready('shared', 'shared_worker')
  f.root.child('shared', 'Network.requestWillBeSent', { requestId: 'refresh', request: { method: 'POST', url: 'https://fixture.test/token' } })
  assert.throws(() => f.ledger.assertIdle('context-a'), { reason: 'profile_requests_in_flight' })
  await assert.rejects(f.ledger.freeze('context-a'), { reason: 'profile_requests_in_flight' }); assert.equal(f.root.childCommands('Debugger.pause').length, 0)
  f.root.child('shared', 'Network.loadingFinished', { requestId: 'refresh' }); assert.doesNotThrow(() => f.ledger.assertIdle('context-a'))
  await f.ledger.freeze('context-a'); assert.equal(f.ledger.frozen, true); await f.ledger.resume(); assert.equal(f.ledger.frozen, false)
})
test('redirect chains retain one active identity and context scopes do not lend each other idle state', async t => {
  const f = await fixture(t); await f.ready('page'); await f.ready('other', 'page', 'context-b')
  f.root.child('page', 'Network.requestWillBeSent', { requestId: 'chain', request: { method: 'GET', url: 'https://fixture.test/first' } })
  f.root.child('page', 'Network.requestWillBeSent', { requestId: 'chain', redirectResponse: {}, request: { method: 'GET', url: 'https://fixture.test/second' } })
  assert.equal(f.ledger.active.size, 1); assert.doesNotThrow(() => f.ledger.assertIdle('context-b')); assert.throws(() => f.ledger.assertIdle('context-a'))
  f.root.child('page', 'Network.loadingFinished', { requestId: 'chain' }); await f.ledger.inventory('context-a')
})
test('detached in-flight owners remain outcome unknown rather than becoming a synthetic zero', async t => {
  const f = await fixture(t); await f.ready('page')
  f.root.child('page', 'Network.requestWillBeSent', { requestId: 'refresh', request: { method: 'POST', url: 'https://fixture.test/token' } })
  f.root.targets.delete('page'); f.root.emit('Target.detachedFromTarget', { sessionId: 'legacy-page' })
  await assert.rejects(f.ledger.inventory('context-a'), { reason: 'profile_network_outcome_unknown' }); assert.equal(f.ledger.active.size, 1)
})
test('an unmatched finished or response event proves a missed request and refuses relocation', async t => {
  for (const method of ['Network.loadingFinished', 'Network.responseReceived']) {
    const f = await fixture(t); await f.ready('page'); f.root.child('page', method, { requestId: 'never-observed', type: 'Document' })
    await assert.rejects(f.ledger.inventory('context-a'), { reason: 'profile_network_untracked' })
  }
})
test('untracked historical or unsupported targets cannot disappear just because they close', async t => {
  const f = await fixture(t); f.root.emit('Target.targetCreated', { targetInfo: { targetId: 'closed', type: 'worker', browserContextId: 'context-a', url: 'https://fixture.test/worker' } })
  await assert.rejects(f.ledger.inventory('context-a'), { reason: 'profile_target_unqualified' })
  const unknown = await fixture(t); await unknown.ready('unknown', 'unknown-native-type'); await assert.rejects(unknown.ledger.inventory('context-a'), { reason: 'profile_target_unqualified' })
})
test('unexpected native UI targets remain refused even at a known Chrome internal URL', async t => {
  for (const url of ['chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html', 'chrome://omnibox-popup.top-chrome/?secret=yes', 'chrome://omnibox-popup.top-chrome/unknown.html', 'chrome://unqualified/']) {
    const f = await fixture(t); await f.ready('ui', 'browser_ui', 'context-a', url); await assert.rejects(f.ledger.inventory('context-a'), { reason: 'profile_target_unqualified' })
  }
})
test('one feature switch preserves every pinned PW default and adds only unused headless omnibox UI exclusions', () => {
  const value = profileLaunchArguments(), original = value.ignoreDefaultArgs[0].split('=')[1].split(','), combined = value.args[0].split('=')[1].split(',')
  assert.deepEqual(combined.slice(0, original.length), original); assert.deepEqual(combined.slice(original.length), ['WebUIOmniboxPopup', 'WebUIOmniboxAimPopup']); assert.equal(value.args.length, 1)
  const require = createRequire(import.meta.url), bytes = readFileSync(require.resolve('playwright-core/lib/coreBundle'))
  assert.throws(() => profileLaunchArguments({ version: 'unqualified', bundle: bytes }), { reason: 'profile_browser_version_unqualified' })
  assert.throws(() => profileLaunchArguments({ version: '1.63.0', bundle: Buffer.concat([bytes, Buffer.from('drift')]) }), { reason: 'profile_browser_version_unqualified' })
})
test('persistent or direct transports leave an explicit historical relocation refusal', async t => {
  for (const method of ['Network.webSocketCreated', 'Network.webTransportCreated', 'Network.directTCPSocketCreated', 'Network.directUDPSocketCreated', 'Network.responseReceived']) {
    const f = await fixture(t); await f.ready('page')
    if (method === 'Network.responseReceived') f.root.child('page', 'Network.requestWillBeSent', { requestId: 'events', request: { method: 'GET', url: 'https://fixture.test/events' } })
    f.root.child('page', method, { requestId: 'events', type: 'EventSource' }); await assert.rejects(f.ledger.inventory('context-a'), { reason: 'profile_persistent_transport_unsupported' })
  }
})
test('requests during freeze invalidate the cutoff and explicit resume restores the existing target', async t => {
  const f = await fixture(t); await f.ready('page'); const original = f.root.send.bind(f.root)
  f.root.send = async (method, params = {}) => { const result = await original(method, params); if (method === 'Target.sendMessageToTarget' && JSON.parse(params.message).method === 'Debugger.pause') f.root.child('page', 'Network.requestWillBeSent', { requestId: 'raced', request: { method: 'GET', url: 'https://fixture.test/raced' } }); return result }
  await assert.rejects(f.ledger.freeze('context-a'), { reason: 'profile_activity_during_freeze' }); await f.ledger.resume(); assert.equal(f.ledger.frozen, false)
})
test('new targets while frozen remain stopped until explicit resume', async t => {
  const f = await fixture(t); await f.ready('page'); await f.ledger.freeze('context-a')
  const before = f.root.childCommands('Runtime.runIfWaitingForDebugger').length; await f.ready('late', 'shared_worker')
  assert.equal(f.root.childCommands('Runtime.runIfWaitingForDebugger').length, before); await f.ledger.resume(); assert.ok(f.root.childCommands('Runtime.runIfWaitingForDebugger').length > before)
})
test('failed Network installation and unproved pauses fail closed within the native deadline', async t => {
  const unavailable = await fixture(t); unavailable.root.refuseNetwork = true; unavailable.root.add('page'); await assert.rejects(unavailable.ledger.readyTarget('page'), { reason: 'profile_target_tracking_unavailable' })
  const pending = await fixture(t); await pending.ready('page'); pending.root.noPause = true; await assert.rejects(pending.ledger.freeze('context-a'), { reason: 'profile_target_pause_unproved' })
})
test('endpoint restore requires explicit background use and forwards exact immutable actor/profile binding', async () => {
  const endpoint = profileCrypto.createEndpointIdentity('endpoint-a'), authority = { profileId: 'profile-a', actingUserId: 'recipient', assistantId: 7, endpointId: 'endpoint-a', bootId: 'boot-a', runtimeId: 'runtime-a', sessionId: 'session-a', writerEpoch: 1, revision: 0, contentKeyEpoch: 2, grantVersion: 3, keyFingerprint: profileCrypto.identityFingerprint(endpoint.identity) }
  const calls: any[] = [], keyStore = { restore: async (value: any) => { calls.push(value); return endpoint } }, current = () => {}
  await assert.rejects(restoreProfileEndpoint({ keyStore, record: {}, authority, pinnedIdentity: endpoint.identity, assertCurrent: current } as any), { reason: 'profile_key_background_grant_required' })
  assert.equal(await restoreProfileEndpoint({ keyStore, record: {}, authority, pinnedIdentity: endpoint.identity, assertCurrent: current, backgroundUse: true } as any), endpoint)
  assert.deepEqual(calls[0].binding, { profileId: 'profile-a', actingUserId: 'recipient', assistantId: 7, endpointId: 'endpoint-a', keyFingerprint: authority.keyFingerprint, grantVersion: 3, keyEpoch: 2, backgroundUse: true }); assert.equal(calls[0].assertCurrent, current)
})
function enrollmentFixture() {
  const endpoint = profileCrypto.createEndpointIdentity(randomUUID()), pairing = { pairingId: 12, ownerUserId: 'owner' }, binding = { profileId: randomUUID(), actingUserId: 'recipient', assistantId: 7, endpointId: endpoint.identity.endpointId, keyFingerprint: profileCrypto.identityFingerprint(endpoint.identity), grantVersion: 2, keyEpoch: 1, backgroundUse: true }
  const record: any = { version: 1, provider: 'libsecret-v1', recordId: randomUUID(), binding, keys: { version: 1, identityFingerprint: binding.keyFingerprint, ciphertext: 'synthetic-encrypted-record' } }, calls: any[] = []
  const keyStore: any = { restore: async (options: any) => { calls.push(options); options.assertCurrent(); assert.deepEqual(options.binding, options.record.binding); return { ...endpoint, contentKeyEpoch: { epoch: 99, key: Buffer.alloc(32, 7) }, authority: { stale: true } } } }
  const options: any = { keyStore, record, pairing, pinnedIdentity: endpoint.identity, authorizeEnrollment: async (request: any) => ({ ...request, assertCurrent() {} }) }
  return { options, endpoint, pairing, record, calls, binding }
}
test('explicit enrollment-only recovery uses saved AEAD binding and returns exactly keys with no DEK or runtime authority', async () => {
  const f = enrollmentFixture(), recovered = await restoreProfileEnrollment(f.options)
  assert.deepEqual(Object.keys(recovered).sort(), ['encryptionPrivateKey', 'identity', 'signingPrivateKey']); assert.ok(Object.isFrozen(recovered)); assert.ok(Object.isFrozen(recovered.identity)); assert.equal(recovered.signingPrivateKey, f.endpoint.signingPrivateKey)
  assert.deepEqual(f.calls[0].binding, f.binding); assert.equal(f.calls[0].binding.grantVersion, 2); assert.equal(f.calls[0].binding.keyEpoch, 1)
  const require = createRequire(import.meta.url), { exactAuthority } = require('../lib/browser-profile-core/coordinator-client.js'); assert.throws(() => exactAuthority(recovered), { code: 'profile_runtime_authority_invalid' })
})
test('enrollment proof cannot substitute profile, actor, assistant, endpoint, public pin, owner or pairing before private-key restore', async () => {
  const changes = [{ purpose: 'runtime' }, { profileId: randomUUID() }, { actingUserId: 'foreign-recipient' }, { assistantId: 8 }, { endpointId: randomUUID() }, { keyFingerprint: '0'.repeat(64) }, { pairingId: 13 }, { ownerUserId: 'foreign-owner' }, { pinnedIdentity: profileCrypto.createEndpointIdentity(randomUUID()).identity }, { grantVersion: 999 }]
  for (const change of changes) { const f = enrollmentFixture(); f.options.authorizeEnrollment = async (request: any) => ({ ...request, ...change, assertCurrent() {} }); await assert.rejects(restoreProfileEnrollment(f.options), { reason: 'profile_enrollment_identity_refused' }); assert.equal(f.calls.length, 0) }
  for (const current of [() => false, async () => true, async () => { throw new Error('private-async-proof') }, () => { throw new Error('private-proof-text') }]) { const f = enrollmentFixture(); f.options.authorizeEnrollment = async (request: any) => ({ ...request, assertCurrent: current }); await assert.rejects(restoreProfileEnrollment(f.options), { reason: 'profile_enrollment_identity_refused' }); assert.equal(f.calls.length, 0) }
})
test('enrollment recovery snapshots the entire saved record and pairing before authorization awaits', async () => {
  const f = enrollmentFixture(), original = structuredClone(f.record); let release: any, proof: any
  f.options.authorizeEnrollment = (request: any) => { proof = { ...request, assertCurrent() {} }; return new Promise(resolve => { release = resolve }) }
  const task = restoreProfileEnrollment(f.options); await tick(); f.record.binding.actingUserId = 'foreign'; f.record.keys.ciphertext = 'substitute-record'; f.pairing.pairingId = 99; f.pairing.ownerUserId = 'foreign-owner'; release(proof)
  assert.equal((await task).signingPrivateKey, f.endpoint.signingPrivateKey); assert.deepEqual(f.calls[0].record, original); assert.ok(Object.isFrozen(f.calls[0].record.binding)); assert.equal(proof.pairingId, 12)
})
test('changed enrollment proof after provider await and mismatched private keys never escape', async () => {
  const f = enrollmentFixture(); let proof: any; f.options.authorizeEnrollment = async (request: any) => { proof = { ...request, assertCurrent() {} }; return proof }; f.options.keyStore.restore = async () => { proof.ownerUserId = 'changed-owner'; return f.endpoint }
  await assert.rejects(restoreProfileEnrollment(f.options), { reason: 'profile_enrollment_identity_refused' })
  const g = enrollmentFixture(); g.options.keyStore.restore = async () => ({ ...g.endpoint, encryptionPrivateKey: profileCrypto.createEndpointIdentity(randomUUID()).encryptionPrivateKey }); await assert.rejects(restoreProfileEnrollment(g.options), { reason: 'profile_enrollment_identity_refused' })
})
test('strict runtime restore never falls back to an old saved grant or key epoch', async () => {
  const f = enrollmentFixture(), authority = { profileId: f.binding.profileId, actingUserId: f.binding.actingUserId, assistantId: 7, endpointId: f.binding.endpointId, bootId: 'boot', runtimeId: 'runtime', sessionId: 'session', writerEpoch: 9, revision: 5, contentKeyEpoch: 4, grantVersion: 6, keyFingerprint: f.binding.keyFingerprint }
  f.options.keyStore.restore = async (value: any) => { assert.equal(value.binding.keyEpoch, 4); assert.equal(value.binding.grantVersion, 6); throw Object.assign(new Error('mismatched old record'), { code: 'profile_key_refused' }) }
  await assert.rejects(restoreProfileEndpoint({ ...f.options, authority, backgroundUse: true, assertCurrent() {} }), { code: 'profile_key_refused' })
})

function runtimeFixture(overrides: any = {}) {
  const source = profileCrypto.createEndpointIdentity('source'), destination = profileCrypto.createEndpointIdentity('destination'), key = profileCrypto.createContentKeyEpoch(1)
  const authority = { profileId: 'profile', actingUserId: 'recipient', assistantId: 7, endpointId: 'source', bootId: 'boot', runtimeId: 'runtime', sessionId: 'session', writerEpoch: 1, revision: 0, contentKeyEpoch: 1, grantVersion: 1, keyFingerprint: profileCrypto.identityFingerprint(source.identity) }
  const targetAuthority = { ...authority, endpointId: 'destination', bootId: 'target-boot', runtimeId: 'target-runtime', sessionId: 'target-session', writerEpoch: 2, revision: 1, grantVersion: 2, keyFingerprint: profileCrypto.identityFingerprint(destination.identity) }
  const context = { version: 1, schemaVersion: 1, profileId: authority.profileId, actingUserId: authority.actingUserId, assistantId: 7, transitionId: 'transition', revision: 1, previousManifestHash: null, keyEpoch: 1,
    source: { endpointId: 'source', bootId: 'boot', runtimeId: 'runtime', sessionId: 'session', writerEpoch: 1 }, destination: { endpointId: 'destination', bootId: 'target-boot', runtimeId: 'target-runtime', sessionId: 'target-session', grantVersion: 2, keyFingerprint: targetAuthority.keyFingerprint } }
  const calls: string[] = [], nativeContext: any = new EventEmitter(); nativeContext.pages = () => []; nativeContext.setOffline = async (value: boolean) => { calls.push('offline:' + value) }; nativeContext.newCDPSession = async () => ({ send: async () => ({ cookies: [] }) })
  let connected = true
  const browser = { close: async () => { calls.push('process-close'); connected = false }, isConnected: () => connected }
  const ledger: any = { generation: 1, frozen: false, inventory: async () => [], assertIdle() {}, freeze: async () => { calls.push('freeze'); ledger.frozen = true; return ledger.generation }, resume: async () => { calls.push('resume'); ledger.frozen = false }, dispose: () => calls.push('dispose') }
  const runtime: any = new BrowserProfileRuntime({ browser, browserVersion:'155.0.8059.39',transferQualification:{kind:'qualified-chromium-native-observer-v1',browserVersion:'155.0.8059.39',confirmStopped:async()=>true,assertQualified:()=>true},context: nativeContext, root: { send: async () => ({ targetInfos: [] }) }, ledger, authority, timeoutMs: 30, assertProcessExited: async () => { calls.push('exit-proof'); return true },
    closeAndDrain: async () => { calls.push('drain'); return { admissionClosed: true, drained: true } }, checkpoint: async (value: any) => { calls.push('checkpoint'); return { durable: true, manifestHash: profileCrypto.manifestHash(value.checkpoint.manifest) } },
    authorizeActivation: async ({ authority }: any) => ({ authority, assertCurrent() { calls.push('current') } }),
    preflightExtras: () => emptyExtras(), captureExtras: () => ({ bundle: emptyExtras(), assertCurrent() {}, release() {} }), commitExtras: () => ({ committed: true }), ...overrides })
  runtime.contextId = 'context-a'; runtime._exporter = async () => ({ evaluate: async () => true }); runtime.processIdentity = { pid: 7, started: 'fixture' }
  return { runtime, source, destination, key, context, authority, targetAuthority, calls, nativeContext, ledger, finalize: () => runtime.finalize({ context, source, destinationIdentity: destination.identity, contentKeyEpoch: key }) }
}

test('missing native transport qualification refuses before drain and cannot borrow a desktop browser proof',async()=>{
  for(const transferQualification of [undefined,{kind:'qualified-chromium-native-observer-v1',browserVersion:'155.0.8059.39',confirmStopped:async()=>true,assertQualified:()=>false},{kind:'qualified-chromium-native-observer-v1',browserVersion:'155.0.8059.39',confirmStopped:async()=>true,assertQualified:async()=>true}]){
    const f=runtimeFixture({transferQualification});await f.runtime.activate({});f.calls.length=0
    await assert.rejects(f.finalize());assert.equal(f.calls.includes('drain'),false);assert.equal(f.runtime.state,'active');assert.equal(f.runtime.network,'active');assert.equal(f.runtime.browser.isConnected(),true)
  }
  assert.throws(()=>runtimeFixture({transferQualification:{kind:'qualified-native-observer-v1',browserVersion:'144.0.7559.173',assertQualified:()=>true}}),{reason:'profile_transport_qualification_required'})
  for(const browserVersion of ['153.0.8010.13','155.0.8059.40','155.0.0.1'])assert.throws(()=>runtimeFixture({transferQualification:{kind:'qualified-chromium-native-observer-v1',browserVersion,confirmStopped:async()=>true,assertQualified:()=>true}}),{reason:'profile_transport_qualification_required'})
  const bundled=runtimeFixture({browserVersion:'153.0.8010.12',transferQualification:{kind:'qualified-chromium-native-observer-v1',browserVersion:'153.0.8010.12',confirmStopped:async()=>true,assertQualified:()=>true}});await bundled.runtime.activate({});await bundled.finalize();assert.equal(bundled.runtime.state,'stopped')
})

test('fixture-only movement is restricted to exact literal-loopback origins and immutable scope',async()=>{
  const qualification={kind:'restricted-disposable-fixture',origins:['http://127.0.0.1:12345'],assertQualified:()=>true}
  const f=runtimeFixture({transferQualification:qualification});await f.runtime.activate({});f.runtime.knownOrigins.add('https://foreign.example.test');qualification.origins.push('https://foreign.example.test')
  await assert.rejects(f.finalize(),{reason:'profile_transport_qualification_required'});assert.equal(f.calls.includes('drain'),false)
  for(const origins of [['https://localhost'],['https://example.test'],['http://127.0.0.1:12345/path'],[]])assert.throws(()=>runtimeFixture({transferQualification:{kind:'restricted-disposable-fixture',origins,assertQualified:()=>true}}),{reason:'profile_transport_qualification_required'})
  const good=runtimeFixture({transferQualification:{kind:'restricted-disposable-fixture',origins:['http://127.0.0.1:12345'],assertQualified:()=>true}});await good.runtime.activate({});good.runtime.knownOrigins.add('http://127.0.0.1:12345');good.runtime._exporter=async(origin:string)=>({evaluate:async()=>({schema:'hoai-origin-storage-v1',origin,localStorage:[],databases:[]})});await good.finalize();assert.equal(good.runtime.state,'stopped')
})

test('transport qualification is checked again after JS freeze before any destructive stop',async()=>{
  let checks=0
  const f=runtimeFixture({transferQualification:{kind:'qualified-chromium-native-observer-v1',browserVersion:'155.0.8059.39',confirmStopped:async()=>true,assertQualified:()=>++checks<3}});await f.runtime.activate({});f.calls.length=0
  await assert.rejects(f.finalize(),{reason:'profile_transport_qualification_required'});assert.equal(checks,3);assert.equal(f.calls.includes('freeze'),true);assert.equal(f.calls.includes('process-close'),false);assert.equal(f.calls.includes('checkpoint'),false);assert.equal(f.runtime.state,'active');assert.equal(f.runtime.network,'active')
})
test('qualified product movement requires asynchronous stopped-history confirmation before extras capture',async()=>{
  assert.throws(()=>runtimeFixture({transferQualification:{kind:'qualified-chromium-native-observer-v1',browserVersion:'155.0.8059.39',assertQualified:()=>true}}),{reason:'profile_transport_qualification_required'})
  let observed=false,f:any
  f=runtimeFixture({transferQualification:{kind:'qualified-chromium-native-observer-v1',browserVersion:'155.0.8059.39',assertQualified:()=>true,async confirmStopped({authority,context,browserVersion,assertPhysicalZero}:any){assert.equal(context,f.nativeContext);assert.deepEqual(authority,f.authority);assert.equal(browserVersion,'155.0.8059.39');assert.equal(f.runtime.state,'quiescing');assert.equal(await assertPhysicalZero(),true);await tick();observed=true;return true}},captureExtras:()=>{assert.equal(observed,true);return{bundle:emptyExtras(),assertCurrent(){},release(){}}}})
  await f.runtime.activate({});await f.finalize();assert.equal(observed,true);assert.equal(f.runtime.state,'stopped')
})
test('failed stopped-history proof or revived exact-context worker never captures or seals a checkpoint',async()=>{
  for(const confirmStopped of [async()=>false,async()=>{throw Error('fixture native history unavailable')}]){
    let captured=false
    const f=runtimeFixture({transferQualification:{kind:'qualified-chromium-native-observer-v1',browserVersion:'155.0.8059.39',assertQualified:()=>true,confirmStopped},captureExtras:()=>{captured=true;throw Error('must not capture')}});await f.runtime.activate({})
    await assert.rejects(f.finalize(),{reason:'profile_transport_qualification_required'});assert.equal(captured,false);assert.equal(f.calls.includes('checkpoint'),false);assert.equal(f.runtime.network,'blocked')
  }
  let revived=false,captured=false
  const f=runtimeFixture({transferQualification:{kind:'qualified-chromium-native-observer-v1',browserVersion:'155.0.8059.39',assertQualified:()=>true,confirmStopped:async()=>{revived=true;return true}},captureExtras:()=>{captured=true;throw Error('must not capture')}});f.runtime.root.send=async()=>({targetInfos:revived?[{browserContextId:'context-a',type:'worker'}]:[]});await f.runtime.activate({})
  await assert.rejects(f.finalize(),{reason:'profile_runtime_workers_running'});assert.equal(captured,false);assert.equal(f.calls.includes('checkpoint'),false)
})
test('revocation during stopped-history confirmation cannot reach capture or resume the page',async()=>{
  let release:any,captured=false,current=true
  const f=runtimeFixture({authorizeActivation:async({authority}:any)=>({authority,assertCurrent(){if(!current)throw Error('fixture revoked')}}),transferQualification:{kind:'qualified-chromium-native-observer-v1',browserVersion:'155.0.8059.39',assertQualified:()=>true,confirmStopped:()=>new Promise(resolve=>release=resolve)},captureExtras:()=>{captured=true;throw Error('must not capture')}})
  await f.runtime.activate({});const task=f.finalize();void task.catch(()=>{});for(let count=0;count<100&&!release;count++)await tick();assert.equal(typeof release,'function');current=false;release(true);await assert.rejects(task,/fixture revoked/);assert.equal(captured,false);assert.equal(f.calls.includes('checkpoint'),false);assert.equal(f.runtime.network,'blocked');assert.equal(f.runtime.browser.isConnected(),false)
})
test('activation binds every runtime field and a nonfresh revision requires a staged checkpoint', async () => {
  for (const field of ['profileId', 'actingUserId', 'endpointId', 'bootId', 'runtimeId', 'sessionId', 'writerEpoch', 'revision', 'contentKeyEpoch', 'grantVersion', 'keyFingerprint']) {
    const f = runtimeFixture(); f.runtime.authorizeActivation = async () => ({ authority: { ...f.authority, [field]: typeof (f.authority as any)[field] === 'number' ? (f.authority as any)[field] + 1 : field === 'keyFingerprint' ? '0'.repeat(64) : 'other' }, assertCurrent() {} })
    await assert.rejects(f.runtime.activate({}), { reason: 'profile_runtime_activation_refused' }); assert.equal(f.runtime.network, 'blocked')
  }
  const f = runtimeFixture(); f.runtime.authority = Object.freeze(f.targetAuthority); await assert.rejects(f.runtime.activate({}), { reason: 'profile_runtime_checkpoint_required' })
})
test('revocation during an asynchronous activation cannot enable the destination', async () => {
  const f = runtimeFixture(); let revoked = false
  f.runtime.authorizeActivation = async () => ({ authority: f.authority, assertCurrent() { if (revoked) throw new Error('revoked') } })
  f.nativeContext.setOffline = async () => { revoked = true }; await assert.rejects(f.runtime.activate({}), /revoked/); assert.equal(f.runtime.state, 'new'); assert.equal(f.runtime.network, 'blocked')
})
test('finalize proves drain, terminal exit and encrypted durability in order before yielding a receipt', async () => {
  const f = runtimeFixture(); await f.runtime.activate({}); const stopped = await f.finalize()
  assert.equal(f.runtime.state, 'stopped'); assert.equal(stopped.receipt.stopped, true); assert.equal(stopped.receipt.manifestHash, profileCrypto.manifestHash(stopped.checkpoint.manifest))
  for (const [before, after] of [['drain', 'freeze'], ['freeze', 'process-close'], ['process-close', 'exit-proof'], ['exit-proof', 'checkpoint']]) assert.ok(f.calls.indexOf(before) < f.calls.indexOf(after))
  assert.equal(JSON.stringify(stopped).includes('hoai-native-profile-state-v1'), false); assert.ok(f.key.key.some((value: number) => value !== 0), 'caller key is not destroyed')
})
test('preflight HTTP refusal leaves the same source running without writing a checkpoint', async () => {
  const f = runtimeFixture(); await f.runtime.activate({}); f.ledger.assertIdle = () => { throw Object.assign(new Error('busy'), { reason: 'profile_requests_in_flight' }) }
  await assert.rejects(f.finalize(), { reason: 'profile_requests_in_flight' }); assert.equal(f.runtime.state, 'active'); assert.equal(f.runtime.browser.isConnected(), true); assert.equal(f.runtime.network, 'active'); assert.ok(f.calls.includes('resume')); assert.equal(f.calls.includes('checkpoint'), false)
})
test('revocation while the physical drain is pending never resumes JS or network on refusal', async () => {
  const f = runtimeFixture(); let revoked = false, release: any
  await f.runtime.activate({}); f.calls.length = 0; f.runtime.activeProof = () => { if (revoked) throw new Error('revoked') }
  f.runtime.closeAndDrain = () => new Promise(resolve => { release = resolve }); const pending = f.finalize(); await tick(); revoked = true; release({ admissionClosed: true, drained: true })
  await assert.rejects(pending, /revoked/); assert.equal(f.calls.includes('resume'), false); assert.equal(f.calls.includes('offline:false'), false); assert.equal(f.calls.includes('checkpoint'), false); assert.equal(f.runtime.browser.isConnected(), false); assert.equal(f.runtime.network, 'blocked'); assert.equal(f.runtime.state, 'disposed')
})
test('unproved admission, live process and failed durability each prevent a usable stopped receipt', async () => {
  for (const [method, value, reason] of [['closeAndDrain', async () => ({ admissionClosed: true, drained: false }), 'profile_runtime_drain_unproved'], ['assertProcessExited', async () => false, 'profile_runtime_process_alive'], ['checkpoint', async () => ({ durable: false }), 'profile_checkpoint_not_durable']] as const) {
    const f = runtimeFixture({ [method]: value }); await f.runtime.activate({}); await assert.rejects(f.finalize(), { reason }); if (method !== 'checkpoint') assert.equal(f.calls.includes('checkpoint'), false)
  }
})
test('fresh source proof revocation after physical stop prevents signing or durable publication', async () => {
  const f = runtimeFixture(); let revoked = false; await f.runtime.activate({}); f.runtime.activeProof = () => { if (revoked) throw new Error('revoked') }; f.runtime.assertProcessExited = async () => { revoked = true; return true }
  await assert.rejects(f.finalize(), /revoked/); assert.equal(f.calls.includes('checkpoint'), false); assert.equal(f.runtime.browser.isConnected(), false)
})
test('mutable caller endpoint and key objects cannot retarget an in-progress finalized checkpoint', async () => {
  const f = runtimeFixture(); const original = f.source.signingPrivateKey, keyBytes = Buffer.from(f.key.key); await f.runtime.activate({}); f.runtime.closeAndDrain = async () => { f.source.signingPrivateKey = profileCrypto.createEndpointIdentity('attacker').signingPrivateKey; f.key.key.fill(0); return { admissionClosed: true, drained: true } }
  const stopped = await f.finalize(); assert.equal(profileCrypto.verifyManifest({ manifest: stopped.checkpoint.manifest, manifestSignature: stopped.checkpoint.manifestSignature, sourceIdentity: f.source.identity, expectedContext: f.context }), true)
  const opened = profileCrypto.openCheckpoint({ checkpoint: stopped.checkpoint, expectedContext: f.context, sourceIdentity: f.source.identity, destination: f.destination }); assert.deepEqual(opened.contentKeyEpoch.key, keyBytes); opened.plaintext.fill(0); opened.contentKeyEpoch.key.fill(0); f.source.signingPrivateKey = original
})
test('source identity mismatch and cross-profile context are rejected before closing admission', async () => {
  const f = runtimeFixture(); await f.runtime.activate({}); await assert.rejects(f.runtime.finalize({ context: { ...f.context, actingUserId: 'sharer' }, source: f.source, destinationIdentity: f.destination.identity, contentKeyEpoch: f.key }), { reason: 'profile_runtime_context_mismatch' })
  await assert.rejects(f.runtime.finalize({ context: f.context, source: profileCrypto.createEndpointIdentity('source'), destinationIdentity: f.destination.identity, contentKeyEpoch: f.key }), { reason: 'profile_runtime_identity_mismatch' }); assert.equal(f.calls.includes('drain'), false)
})
test('stage stays inactive, requires exact cookie readback and no surviving target before its receipt', async () => {
  const source = runtimeFixture(); await source.runtime.activate({}); const stopped = await source.finalize()
  for (const survivingTarget of [false, true]) {
    const target = runtimeFixture(); target.runtime.authority = Object.freeze(source.targetAuthority); target.runtime.root.send = async () => ({ targetInfos: survivingTarget ? [{ browserContextId: 'context-a' }] : [] })
    const stage = () => target.runtime.stage({ checkpoint: stopped.checkpoint, expectedContext: source.context, sourceIdentity: source.source.identity, destination: source.destination })
    if (survivingTarget) { await assert.rejects(stage(), { reason: 'profile_runtime_workers_running' }); assert.equal(target.runtime.state, 'disposed') }
    else { const staged = await stage(); assert.equal(target.runtime.state, 'staged'); assert.equal(target.runtime.network, 'blocked'); assert.equal(staged.receipt.stagedInactive, true); assert.equal(staged.receipt.manifestHash, stopped.receipt.manifestHash); assert.equal(Object.isFrozen(staged.receipt.destination), true) }
  }
})
test('destination cookie import mismatch purges instead of issuing an inactive-stage receipt', async () => {
  const source = runtimeFixture(), cookie = { name: 'session', value: 'synthetic', domain: 'fixture.test', path: '/', expires: -1, httpOnly: true, secure: true, session: true, priority: 'Medium', sourceScheme: 'Secure', sourcePort: 443 }
  source.nativeContext.newCDPSession = async () => ({ send: async () => ({ cookies: [cookie] }) }); await source.runtime.activate({}); const stopped = await source.finalize()
  const target = runtimeFixture(); target.runtime.authority = Object.freeze(source.targetAuthority); target.nativeContext.newCDPSession = async () => ({ send: async () => ({ cookies: [] }) })
  await assert.rejects(target.runtime.stage({ checkpoint: stopped.checkpoint, expectedContext: source.context, sourceIdentity: source.source.identity, destination: source.destination }), { reason: 'profile_runtime_cookie_import_mismatch' }); assert.equal(target.runtime.state, 'disposed'); assert.equal(target.runtime.stagedReceipt, undefined)
})
test('isolated document safety returns booleans only and refuses pending loads and unfinished credentials', async () => {
  for (const [value, reason] of [[{ ready: false, credentials: false, unsaved: false }, 'profile_document_loading'], [{ ready: true, credentials: true, unsaved: false }, 'profile_authentication_in_progress'], [{ ready: true, credentials: false, unsaved: true }, 'profile_unsaved_form_state'], [{ ready: true, credentials: false, unsaved: false }, null]] as const) {
    const f = runtimeFixture(), calls: any[] = [], page = {}; f.nativeContext.pages = () => [page]; f.nativeContext.newCDPSession = async () => ({ detach: async () => calls.push('detach'), send: async (method: string, params: any) => { calls.push({ method, params }); return method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main' } } } : method === 'Page.createIsolatedWorld' ? { executionContextId: 77 } : { result: { value } } } })
    if (reason) await assert.rejects(f.runtime._assertDocumentSafety(), { reason }); else await f.runtime._assertDocumentSafety()
    assert.equal(calls.find(value => value.method === 'Runtime.evaluate').params.contextId, 77); assert.equal(calls.at(-1), 'detach'); assert.equal(calls.find(value => value.method === 'Page.createIsolatedWorld').params.grantUniveralAccess, false)
  }
})

test('a dirty-form race after first inspection resumes the original paused source without destruction or receipt',async()=>{
  const f=runtimeFixture();await f.runtime.activate({});f.calls.length=0;let inspections=0
  f.runtime._assertDocumentSafety=async()=>{if(++inspections===2){assert.equal(f.ledger.frozen,true);throw Object.assign(Error('dirty form'),{reason:'profile_unsaved_form_state'})}}
  await assert.rejects(f.finalize(),{reason:'profile_unsaved_form_state'});assert.equal(inspections,2);assert.equal(f.runtime.state,'active');assert.equal(f.runtime.network,'active');assert.equal(f.ledger.frozen,false);assert.equal(f.runtime.browser.isConnected(),true);assert.equal(f.calls.includes('resume'),true);assert.equal(f.calls.includes('process-close'),false);assert.equal(f.calls.includes('checkpoint'),false)
})

test('mutable or injected process metadata can never create an emergency kill capability',async()=>{
  const f=runtimeFixture();f.runtime.processIdentity={pid:process.pid,started:'untrusted-constructor'}
  await assert.rejects(f.runtime.emergencyStopOwnedProcess(),{reason:'profile_owned_process_proof_required'});assert.equal(f.runtime.state,'new');assert.equal(f.runtime.browser.isConnected(),true)
})
test('dispose zeroes the owned key even when browser shutdown fails', async () => {
  const f = runtimeFixture(), owned = Buffer.alloc(32, 7); f.runtime.contentKeyEpoch = { epoch: 1, key: owned }; f.runtime.browser.close = async () => { throw new Error('shutdown failed') }
  await assert.rejects(f.runtime.dispose(), /shutdown failed/); assert.ok(owned.every(value => value === 0)); assert.equal(f.runtime.state, 'disposed'); assert.equal(f.runtime.contentKeyEpoch, null)
})
test('dispose never reports successful revoked cleanup while the owned browser process remains alive', async () => {
  for (const connected of [true, false]) {
    const f = runtimeFixture(), owned = Buffer.alloc(32, 9); f.runtime.contentKeyEpoch = { epoch: 1, key: owned }; f.runtime.browser.close = async () => {}; f.runtime.browser.isConnected = () => connected; f.runtime.assertProcessExited = async () => false
    await assert.rejects(f.runtime.dispose(), { reason: 'profile_runtime_process_alive' }); assert.equal(f.runtime.state, 'disposed'); assert.equal(f.runtime.network, 'blocked'); assert.equal(f.runtime.contentKeyEpoch, null); assert.ok(owned.every(value => value === 0))
  }
})
test('oversized native packets and exhausted request inventories fail closed with bounded memory', async t => {
  const f = await fixture(t); await f.ready('page'); f.root.emit('Target.receivedMessageFromTarget', { sessionId: 'legacy-page', message: 'x'.repeat(1024 * 1024 + 1) }); await assert.rejects(f.ledger.inventory('context-a'), { reason: 'profile_target_message_invalid' })
  const requests = await fixture(t); await requests.ready('page'); for (let index = 0; index <= 16384; index++) requests.root.child('page', 'Network.requestWillBeSent', { requestId: String(index), request: { method: 'GET', url: 'https://fixture.test/' } })
  assert.equal(requests.ledger.active.size, 16384); await assert.rejects(requests.ledger.inventory('context-a'), { reason: 'profile_inventory_limit' })
})
const portableState = createRequire(import.meta.url)('../lib/browser-profile-core/portable-state.js')
const loginExtras = () => ({ passwordVault: { v: 1, entries: [{ id: '0d694ca4-9b5d-4d95-a8bc-36eb1876bd80', origin: 'https://fixture.test', username: 'synthetic-user', password: 'synthetic-portable-login-secret', name: 'Synthetic', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z' }], neverOrigins: ['https://never.example.test'] }, preferences: { v: 1, searchEngine: 'duckduckgo' } })
test('portable extras are mandatory and invalid or asynchronous preflight never closes source admission', async () => {
  for (const field of ['preflightExtras', 'captureExtras', 'commitExtras']) assert.throws(() => runtimeFixture({ [field]: undefined }), { reason: 'profile_runtime_extras_dependencies_required' })
  for (const preflightExtras of [() => ({ ...emptyExtras(), preferences: { v: 1, searchEngine: 'custom' } }), () => Promise.reject(new Error('synthetic-secret')), () => false]) {
    const f = runtimeFixture({ preflightExtras }); await f.runtime.activate({}); await assert.rejects(f.finalize()); assert.equal(f.calls.includes('drain'), false); assert.equal(f.runtime.state, 'active'); assert.equal(f.runtime.browser.isConnected(), true); assert.equal(f.runtime.network, 'active')
  }
})
test('oversized saved-login preflight refuses before destructive shutdown', async () => {
  const extras = loginExtras(), row = extras.passwordVault.entries[0]; extras.passwordVault.entries = Array.from({ length: 1100 }, (_, i) => ({ ...row, id: i.toString(16).padStart(8, '0') + '-9b5d-4d95-a8bc-36eb1876bd80', username: String(i), password: 'x'.repeat(16384) }))
  const f = runtimeFixture({ preflightExtras: () => extras }); await f.runtime.activate({}); await assert.rejects(f.finalize(), { code: 'profile_portable_state_invalid' }); assert.equal(f.calls.includes('drain'), false); assert.equal(f.runtime.browser.isConnected(), true)
})
test('all source targets stop before extras capture and its mutation barrier lasts through durable encrypted seal', async () => {
  const extras = loginExtras(); let held = false, released = 0, f: any
  f = runtimeFixture({ preflightExtras: () => extras, captureExtras: () => { assert.equal(f.runtime.state, 'quiescing'); assert.equal(f.nativeContext.pages().length, 0); assert.equal(f.ledger.frozen, true); held = true; return { bundle: extras, assertCurrent() { assert.equal(held, true) }, release() { held = false; released++ } } },
    checkpoint: async (value: any) => { assert.equal(f.runtime.browser.isConnected(), false); assert.equal(held, true); await tick(); assert.equal(held, true); return { durable: true, manifestHash: profileCrypto.manifestHash(value.checkpoint.manifest) } } })
  let oldClosed = false; const oldPage = { close: async () => { oldClosed = true } }; f.nativeContext.pages = () => oldClosed ? [] : [oldPage]; f.runtime.pages.add(oldPage); f.runtime._assertDocumentSafety = async () => {}
  await f.runtime.activate({}); const stopped = await f.finalize(), opened = profileCrypto.openCheckpoint({ checkpoint: stopped.checkpoint, expectedContext: f.context, sourceIdentity: f.source.identity, destination: f.destination })
  const payload = portableState.decodePortableState(opened.plaintext); assert.deepEqual(payload.passwordVault, extras.passwordVault); assert.deepEqual(payload.preferences, extras.preferences); assert.equal(held, false); assert.equal(released, 1); assert.equal(JSON.stringify(stopped).includes(extras.passwordVault.entries[0].password), false); opened.plaintext.fill(0); opened.contentKeyEpoch.key.fill(0)
})
test('stale capture and failed checkpoint always release the barrier without a checkpoint or source resume', async () => {
  for (const phase of ['seal', 'checkpoint']) {
    let current = true, released = 0, f: any, checkpoints = 0
    f = runtimeFixture({ captureExtras: () => ({ bundle: emptyExtras(), assertCurrent() { if (!current) throw new Error('fixture stale extras') }, release() { released++ } }),
      assertProcessExited: async () => { if (phase === 'seal') current = false; return true }, checkpoint: async () => { checkpoints++; throw new Error('fixture checkpoint failed') } })
    await f.runtime.activate({}); await assert.rejects(f.finalize()); assert.equal(released, 1); assert.equal(checkpoints, phase === 'seal' ? 0 : 1); assert.equal(f.runtime.network, 'blocked'); assert.equal(f.runtime.browser.isConnected(), false); assert.equal(f.calls.includes('resume'), false)
  }
})
test('stage holds full extras privately and exact activation commits them once before opening network', async () => {
  const extras = loginExtras(), source = runtimeFixture({ preflightExtras: () => extras, captureExtras: () => ({ bundle: extras, assertCurrent() {}, release() {} }) }); await source.runtime.activate({}); const stopped = await source.finalize()
  let commits = 0, native = emptyExtras(), target: any
  target = runtimeFixture({ commitExtras: (value: any) => { commits++; assert.equal(target.runtime.network, 'blocked'); assert.equal(target.runtime.state, 'staged'); assert.equal(value.authority, target.runtime.authority); assert.equal(value.receipt, target.runtime.stagedReceipt); assert.equal(Object.isFrozen(value.bundle.passwordVault.entries[0]), true); native = structuredClone(value.bundle); return { committed: true } } }); target.runtime.authority = Object.freeze(source.targetAuthority)
  await target.runtime.stage({ checkpoint: stopped.checkpoint, expectedContext: source.context, sourceIdentity: source.source.identity, destination: source.destination }); assert.equal(commits, 0); assert.deepEqual(native, emptyExtras()); assert.deepEqual(target.runtime.stagedExtras, extras)
  target.runtime.authorizeActivation = async () => ({ authority: { ...target.runtime.authority, actingUserId: 'sharer' }, assertCurrent() {} }); await assert.rejects(target.runtime.activate({}), { reason: 'profile_runtime_activation_refused' }); assert.equal(commits, 0)
  target.runtime.authorizeActivation = async () => ({ authority: target.runtime.authority, assertCurrent() {} }); await target.runtime.activate({}); assert.equal(commits, 1); assert.deepEqual(native, extras); assert.equal(target.runtime.stagedExtras, null); assert.equal(target.runtime.network, 'active')
})
test('uncertain native extras commit cannot be retried or open the staged browser', async () => {
  for (const answer of [() => false, () => Promise.reject(new Error('synthetic-secret')), () => ({ committed: false }), () => { throw new Error('fixture native write') }]) {
    const source = runtimeFixture(); await source.runtime.activate({}); const stopped = await source.finalize(); let commits = 0
    const target = runtimeFixture({ commitExtras: () => { commits++; return answer() } }); target.runtime.authority = Object.freeze(source.targetAuthority)
    await target.runtime.stage({ checkpoint: stopped.checkpoint, expectedContext: source.context, sourceIdentity: source.source.identity, destination: source.destination }); await assert.rejects(target.runtime.activate({})); assert.equal(target.runtime.network, 'blocked'); await assert.rejects(target.runtime.activate({}), { reason: 'profile_runtime_extras_commit_uncertain' }); assert.equal(commits, 1)
  }
})
test('revoked proof after committing extras still blocks network and never repeats that committed write', async () => {
  const source = runtimeFixture(); await source.runtime.activate({}); const stopped = await source.finalize(); let current = true, commits = 0
  const target = runtimeFixture({ authorizeActivation: async ({ authority }: any) => ({ authority, assertCurrent() { if (!current) throw new Error('fixture revoked') } }), commitExtras: () => { commits++; current = false; return { committed: true } } }); target.runtime.authority = Object.freeze(source.targetAuthority)
  await target.runtime.stage({ checkpoint: stopped.checkpoint, expectedContext: source.context, sourceIdentity: source.source.identity, destination: source.destination }); await assert.rejects(target.runtime.activate({}), /fixture revoked/); assert.equal(target.runtime.network, 'blocked'); current = true; await target.runtime.activate({}); assert.equal(commits, 1); assert.equal(target.runtime.network, 'active')
})
test('old incomplete capsule bodies refuse and disposal clears privately staged password data', async () => {
  const source = runtimeFixture(), old = profileCrypto.sealCheckpoint({ plaintext: Buffer.from(JSON.stringify({ schema: 'hoai-native-profile-state-v1', cookies: [], origins: [] })), context: source.context, source: source.source, destinationIdentity: source.destination.identity, contentKeyEpoch: source.key })
  const legacyTarget = runtimeFixture(); legacyTarget.runtime.authority = Object.freeze(source.targetAuthority); await assert.rejects(legacyTarget.runtime.stage({ checkpoint: old, expectedContext: source.context, sourceIdentity: source.source.identity, destination: source.destination }), { code: 'profile_portable_state_invalid' }); assert.equal(legacyTarget.runtime.stagedExtras, null)
  await source.runtime.activate({}); const stopped = await source.finalize(), target = runtimeFixture(); target.runtime.authority = Object.freeze(source.targetAuthority)
  await target.runtime.stage({ checkpoint: stopped.checkpoint, expectedContext: source.context, sourceIdentity: source.source.identity, destination: source.destination }); assert.ok(target.runtime.stagedExtras); await target.runtime.dispose(); assert.equal(target.runtime.stagedExtras, null)
})
test('false and asynchronous activation assertions never enable native networking', async () => {
  for (const assertCurrent of [() => false, () => Promise.resolve(true), () => Promise.reject(new Error('synthetic-secret'))]) {
    const f = runtimeFixture({ authorizeActivation: async ({ authority }: any) => ({ authority, assertCurrent }) }); await assert.rejects(f.runtime.activate({})); assert.equal(f.runtime.network, 'blocked'); assert.equal(f.calls.includes('offline:false'), false)
  }
})

function agentStageFixture() {
  const require = createRequire(import.meta.url), { canonical } = require('../lib/browser-profile-core/coordinator-client.js')
  const portable = require('../lib/browser-profile-core/portable-state.js'), { createAgentStoppedHeadStageAuthorization } = require('../lib/browser-profile-core/stopped-head-stage.js')
  const endpoint = profileCrypto.createEndpointIdentity(randomUUID()), pin = profileCrypto.identityFingerprint(endpoint.identity), profileId = randomUUID()
  const originalSource = { endpointId: endpoint.identity.endpointId, bootId: 'old-boot', runtimeId: 'old-runtime', sessionId: 'old-session', writerEpoch: 3 }
  const destination = { endpointId: endpoint.identity.endpointId, bootId: 'prepared-boot', runtimeId: 'prepared-runtime', sessionId: 'prepared-session', grantVersion: 2, keyFingerprint: pin }
  const context = { version: 1, schemaVersion: 1, profileId, actingUserId: 'recipient', assistantId: 7, transitionId: randomUUID(), revision: 1, previousManifestHash: null, keyEpoch: 1, source: originalSource, destination }
  const key = profileCrypto.createContentKeyEpoch(1), plaintext = portable.encodePortableState({ schema: portable.SCHEMA, cookies: [], origins: [], ...emptyExtras() })
  let checkpoint
  try { checkpoint = profileCrypto.sealCheckpoint({ plaintext, context, source: endpoint, destinationIdentity: endpoint.identity, contentKeyEpoch: key }) }
  finally { plaintext.fill(0); key.key.fill(0) }
  const manifestHash = profileCrypto.manifestHash(checkpoint.manifest), target = { ...destination, bootId: 'fresh-boot', runtimeId: 'fresh-runtime', sessionId: 'fresh-session' }
  const authority = { profileId, actingUserId: 'recipient', assistantId: 7, ...target, writerEpoch: 4, revision: 1, contentKeyEpoch: 1 }
  const document = { version: 1, kind: 'agent-stopped-head-readdress', profileId, actingUserId: 'recipient', assistantId: 7, transitionId: randomUUID(), expectedTransitionId: context.transitionId, manifestHash, expectedRevision: 1, expectedWriterEpoch: 3, expectedKeyEpoch: 1, destination: target }
  const retirement = { version: 1, kind: 'agent-runtime-retire', profileId, authority: { profileId, actingUserId: 'recipient', assistantId: 7, ...originalSource, revision: 0, contentKeyEpoch: 1, grantVersion: 2, keyFingerprint: pin }, transitionId: context.transitionId, manifestHash, revision: 1, destination }
  const response = { profile: { id: profileId, actingUserId: 'recipient', assistantId: 7, writerState: 'stopped', ...originalSource, revision: 1, contentKeyEpoch: 1, headManifestHash: manifestHash }, transition: { id: document.transitionId, profileId, kind: 'stopped_head_readdress', phase: 'checkpoint_committed', capsuleTransitionId: context.transitionId, supersedesTransitionId: context.transitionId, supersededByTransitionId: null, source: originalSource, destination: target, sourceRevision: 0, sourceManifestHash: null, contentKeyEpoch: 1, manifestHash }, originalContext: context, agentRetirement: { document: retirement, signature: sign(null, canonical(retirement), endpoint.signingPrivateKey).toString('base64url') } }
  let current = true
  const options = { authority, document, signature: sign(null, canonical(document), endpoint.signingPrivateKey).toString('base64url'), response, checkpoint, sourceIdentity: endpoint.identity, destination: endpoint, assertCurrent: () => current }
  const f = runtimeFixture(); f.runtime.authority = Object.freeze(authority)
  return { ...f, authority, checkpoint, context, endpoint, response, document, options, revoke: () => { current = false }, authorization: () => createAgentStoppedHeadStageAuthorization(options),
    input: { checkpoint, originalContext: context, sourceIdentity: endpoint.identity, destination: endpoint } }
}
test('separate stopped-head import requires a real one-use agent capability and leaves generic stage exact', async () => {
  const f = agentStageFixture()
  await assert.rejects(f.runtime.stage({ checkpoint: f.checkpoint, expectedContext: f.context, sourceIdentity: f.endpoint.identity, destination: f.endpoint }), { reason: 'profile_runtime_context_mismatch' })
  await assert.rejects(f.runtime.stageStoppedHead({ ...f.input, authorization: { kind: 'stopped-head-readdress-stage' } }), { code: 'profile_stopped_head_stage_refused' })
  const authorization = f.authorization(), staged = await f.runtime.stageStoppedHead({ ...f.input, authorization })
  assert.equal(f.runtime.state, 'staged'); assert.equal(f.runtime.network, 'blocked'); assert.equal(f.calls.includes('offline:false'), false)
  assert.equal(staged.receipt.transitionId, f.document.transitionId); assert.notEqual(staged.receipt.transitionId, f.checkpoint.manifest.transitionId)
  assert.deepEqual(staged.readdress.agentRetirement, f.response.agentRetirement); assert.deepEqual(f.checkpoint.manifest.destination, f.context.destination)
  await assert.rejects(f.runtime.stageStoppedHead({ ...f.input, authorization }), { code: 'profile_stopped_head_stage_refused' }); await f.runtime.dispose()
})
test('stopped-head cached revocation during inactive import disposes plaintext state before any staged receipt', async () => {
  const f = agentStageFixture(), authorization = f.authorization()
  f.nativeContext.newCDPSession = async () => { f.revoke(); return { send: async () => ({ cookies: [] }) } }
  await assert.rejects(f.runtime.stageStoppedHead({ ...f.input, authorization }), { code: 'profile_stopped_head_stage_refused' })
  assert.equal(f.runtime.state, 'disposed'); assert.equal(f.runtime.network, 'blocked'); assert.equal(f.runtime.stagedExtras, null); assert.equal(f.calls.includes('offline:false'), false)
})
test('stopped-head import cannot replace the admitted exact new process authority', async () => {
  const f = agentStageFixture(), authorization = f.authorization(); f.runtime.authority = Object.freeze({ ...f.authority, sessionId: 'wrong-session' })
  await assert.rejects(f.runtime.stageStoppedHead({ ...f.input, authorization }), { code: 'profile_stopped_head_stage_refused' })
  assert.equal(f.calls.includes('offline:true'), false); await f.runtime.dispose()
})


test('cookie import URL preserves Secure independently from source metadata', () => {
  const require = createRequire(import.meta.url), { cookies, cookieParams } = require('../lib/browser-profile-core/native-runtime.js')
  for (const secure of [false, true]) for (const sourceScheme of ['NonSecure', 'Secure']) {
    const host = { name: 'synthetic', value: 'DUMMY_ONLY', domain: 'fixture.invalid', path: '/', expires: -1, httpOnly: true, secure, session: true, priority: 'Medium', sourceScheme, sourcePort: 62443 }
    const params = cookieParams(cookies([host])[0])
    assert.equal(params.url, `${secure ? 'https' : 'http'}://fixture.invalid:62443/`)
    assert.equal(params.secure, secure); assert.equal(params.sourceScheme, sourceScheme)
    assert.equal(params.sourcePort, 62443); assert.equal(params.domain, undefined)
    const domain = cookieParams(cookies([{ ...host, domain: '.fixture.invalid' }])[0])
    assert.equal(domain.url, undefined); assert.equal(domain.domain, '.fixture.invalid')
    assert.equal(domain.secure, secure); assert.equal(domain.sourceScheme, sourceScheme)
  }
})
