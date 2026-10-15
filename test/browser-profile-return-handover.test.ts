import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomBytes, randomUUID } from 'node:crypto'
import { AgentReturnHandover } from '../lib/browser-profile-return-handover.mjs'
const require = createRequire(import.meta.url), codec = require('../lib/browser-profile-core/crypto.js'), shared = require('../lib/browser-profile-core/coordinator-client.js'), wire = require('../lib/browser-profile-core/return-intent.js')
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  const endpoint = codec.createEndpointIdentity(randomUUID()), desktop = codec.createEndpointIdentity(randomUUID()), epoch = codec.createContentKeyEpoch(1), state: any = { now: Date.now(), current: true, stopped: null, saved: null }, calls: string[] = []
  const scope = { profileId: randomUUID(), actingUserId: 'recipient', assistantId: 42, endpointId: endpoint.identity.endpointId, keyFingerprint: codec.identityFingerprint(endpoint.identity), pairingId: 7, ownerUserId: 'sharer' }
  const authority: any = { ...Object.fromEntries(['profileId', 'actingUserId', 'assistantId', 'endpointId', 'keyFingerprint'].map(key => [key, (scope as any)[key]])), bootId: 'agent-boot', runtimeId: 'agent-runtime', sessionId: 'agent-session', writerEpoch: 3, revision: 0, contentKeyEpoch: 1, grantVersion: 1 }
  const request = { version: 1, kind: 'agent-browser-return-intent', requestId: randomUUID(), nonce: randomBytes(32).toString('base64url'), sourceAuthority: authority, destination: { endpointId: desktop.identity.endpointId, keyFingerprint: codec.identityFingerprint(desktop.identity), bootId: 'desktop-boot', runtimeId: 'desktop-runtime', sessionId: 'desktop-session', grantVersion: 1 }, expectedHeadManifestHash: null, expiresAt: state.now + 300000 }
  const signature = shared.documentSignature(desktop, request), status = { request, signature, intentHash: wire.returnIntentHash({ request, signature }), state: 'pending', manifestHash: null, writeConsumed: false, transitionPhase: null, sourceStopped: null }
  const runtime: any = { authority, state: 'active', network: 'active', async finalize({ context, source, destinationIdentity }: any) {
    calls.push('native-finalize'); const plaintext = Buffer.from('SYNTHETIC_ENCRYPTED_RETURN_ONLY'), checkpoint = codec.sealCheckpoint({ plaintext, context, source, destinationIdentity, contentKeyEpoch: epoch }); plaintext.fill(0)
    const manifestHash = codec.manifestHash(checkpoint.manifest), receipt = { version: 1, kind: 'source-stopped', profileId: context.profileId, transitionId: context.transitionId, manifestHash, revision: context.revision, source: context.source, stopped: true }
    state.stopped = { checkpoint, receipt, signature: shared.documentSignature(endpoint, receipt) }; state.saved = { manifestHash, checkpoint, receipt, receiptSignature: state.stopped.signature }; this.state = 'stopped'; this.network = 'blocked'; return state.stopped
  } }
  const committed = () => ({ ...status, state: 'checkpoint-committed', manifestHash: codec.manifestHash(state.stopped.checkpoint.manifest), writeConsumed: true, transitionPhase: 'checkpoint_committed', sourceStopped: { receipt: state.stopped.receipt, signature: state.stopped.signature } })
  const client: any = { async checkpoint(input: any) { calls.push('http-checkpoint'); assert.equal(runtime.state, 'stopped'); assert.equal(runtime.network, 'blocked'); assert.deepEqual(input.stopped, state.stopped); return committed() }, async read() { calls.push('signed-read'); return committed() } }
  const helper = new AgentReturnHandover({ client, now: () => state.now }), input: any = { scope, endpoint, authority, runtime, status, expectedHeadManifestHash: null, peerPins: [codec.createEndpointIdentity(randomUUID()).identity,desktop.identity], contentKeyEpoch: epoch,
    assertCurrent() { if (!state.current) throw Error('PRIVATE_SOURCE_CONTEXT') }, closeAdmission() { calls.push('close-admission'); return { admissionClosed: true } }, async drain() { calls.push('physical-drain'); return { drained: true } }, async verifyCurrentAuthority() { calls.push('fresh-authority'); return true }, async readJournal() { calls.push('journal-readback'); return state.saved }, resumeAdmission() { calls.push('resume-admission'); return true } }
  const candidate = () => ({ kind: 'verified-local-candidate', scope, manifestHash: state.saved.manifestHash, revision: 1, keyEpoch: 1, cryptoTransitionId: request.requestId, coordinatorTransitionId: request.requestId, receiptKind: 'source-stopped', source: state.stopped.checkpoint.manifest.source, destination: request.destination })
  const recover = (other = helper, response: any = committed()) => other.recover({ scope, endpoint, status: response, peerPins: [desktop.identity], candidate: candidate(), readJournal: input.readJournal, assertCurrent: input.assertCurrent })
  return { helper, input, calls, client, state, endpoint, desktop, scope, authority, runtime, status, request, epoch, committed, candidate, recover }
}

test('reviewed exact recipient desktop is pinned before admission then stop and journal precede the only checkpoint write', async () => {
  const f = fixture(); try {
    const result = await f.helper.start(f.input); assert.equal(result?.state, 'checkpoint-committed'); assert.equal(result?.requestId, f.request.requestId)
    assert.deepEqual(f.calls, ['fresh-authority', 'close-admission', 'physical-drain', 'fresh-authority', 'native-finalize', 'journal-readback', 'http-checkpoint'])
    assert.equal(JSON.stringify(f.state.saved).includes('SYNTHETIC_ENCRYPTED_RETURN_ONLY'), false)
    await assert.rejects(f.helper.start(f.input)); assert.equal(f.calls.filter(value => value === 'http-checkpoint').length, 1)
  } finally { f.epoch.key.fill(0) }
})

test('version2 proves current normal GET pages before closing source admission and seals the exact requested format', async () => {
  const f = fixture(); try {
    Object.assign(f.request, { version: 2, schemaVersion: 2 }); f.status.signature = shared.documentSignature(f.desktop, f.request); f.status.intentHash = wire.returnIntentHash({ request: f.request, signature: f.status.signature })
    f.runtime.preflightResumeTabs = async () => { f.calls.push('resume-preflight'); assert.equal(f.calls.includes('close-admission'), false) }
    await f.helper.start(f.input); assert.equal(f.state.stopped.checkpoint.manifest.schemaVersion, 2); assert.ok(f.calls.indexOf('resume-preflight') < f.calls.indexOf('close-admission'))
  } finally { f.epoch.key.fill(0) }
})
test('version2 unknown POST or revoked resume evidence retains the source and never closes admission', async () => {
  for (const fault of ['missing', 'unproved', 'revoked']) { const f = fixture(); try {
    Object.assign(f.request, { version: 2, schemaVersion: 2 }); f.status.signature = shared.documentSignature(f.desktop, f.request); f.status.intentHash = wire.returnIntentHash({ request: f.request, signature: f.status.signature })
    if (fault !== 'missing') f.runtime.preflightResumeTabs = async () => { if (fault === 'revoked') f.state.current = false; else throw Error('profile_resume_document_unproved') }
    await assert.rejects(f.helper.start(f.input)); assert.equal(f.calls.includes('close-admission'), false); assert.equal(f.calls.includes('native-finalize'), false); assert.equal(f.runtime.state, 'active')
  } finally { f.epoch.key.fill(0) } }
})
test('version2 native replayability preflight must physically settle before admission can close', async () => {
  const f=fixture(),gate=deferred<void>();try{
    Object.assign(f.request,{version:2,schemaVersion:2});f.status.signature=shared.documentSignature(f.desktop,f.request);f.status.intentHash=wire.returnIntentHash({request:f.request,signature:f.status.signature})
    f.runtime.preflightResumeTabs=()=>gate.promise;const pending=f.helper.start(f.input);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.includes('close-admission'),false);gate.resolve();await pending
    assert.equal(f.calls.includes('http-checkpoint'),true)
  }finally{gate.resolve();f.epoch.key.fill(0)}
})

test('missing or crossed desktop pin signature source authority and predecessor refuse before admission', async () => {
  for (const fault of ['missing-pin', 'foreign-key', 'signature', 'authority', 'signed-foreign-source', 'head', 'source-key', 'expired']) {
    const f = fixture(); try {
      if (fault === 'missing-pin') f.input.peerPins = []
      else if (fault === 'foreign-key') f.input.peerPins = [{ ...codec.createEndpointIdentity(f.desktop.identity.endpointId).identity }]
      else if (fault === 'signature') f.status.signature = shared.documentSignature(f.endpoint, f.request)
      else if (fault === 'authority') f.input.authority = { ...f.authority, sessionId: 'replacement-session' }
      else if (fault === 'signed-foreign-source') { f.request.sourceAuthority={...f.authority,sessionId:'foreign-session'};f.status.signature=shared.documentSignature(f.desktop,f.request);f.status.intentHash=wire.returnIntentHash({request:f.request,signature:f.status.signature}) }
      else if (fault === 'head') f.input.expectedHeadManifestHash = '0'.repeat(64)
      else if (fault === 'source-key') f.input.endpoint = codec.createEndpointIdentity(f.endpoint.identity.endpointId)
      else f.state.now += 300000
      await assert.rejects(f.helper.start(f.input)); assert.deepEqual(f.calls, []); assert.equal(f.runtime.state, 'active')
    } finally { f.epoch.key.fill(0) }
  }
})

test('physical drain must settle and positively confirm before native finalize can start', async () => {
  const f = fixture(), gate = deferred<any>(); try {
    f.input.drain = async () => { f.calls.push('physical-drain'); return gate.promise }
    const pending = f.helper.start(f.input); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.includes('native-finalize'), false)
    await assert.rejects(f.helper.start(f.input), /already_attempted/)
    const request = { ...f.request, requestId: randomUUID(), nonce: randomBytes(32).toString('base64url') }, signature = shared.documentSignature(f.desktop, request)
    await assert.rejects(f.helper.start({ ...f.input, status: { ...f.status, request, signature, intentHash: wire.returnIntentHash({ request, signature }) } }), /source_busy/)
    gate.resolve({ drained: true }); await pending
    assert.equal(f.calls.filter(value => value === 'native-finalize').length, 1)
  } finally { f.epoch.key.fill(0) }
})

test('unproved admission drain and fresh authority refuse before native stop or checkpoint', async () => {
  for (const fault of ['admission', 'drain', 'fresh-authority']) {
    const f = fixture(); try {
      if (fault === 'admission') f.input.closeAdmission = () => ({ admissionClosed: false })
      else if (fault === 'drain') f.input.drain = async () => ({ drained: false })
      else { let count = 0; f.input.verifyCurrentAuthority = async () => ++count === 1 }
      await assert.rejects(f.helper.start(f.input)); assert.equal(f.calls.includes('native-finalize'), false); assert.equal(f.calls.includes('http-checkpoint'), false)
    } finally { f.epoch.key.fill(0) }
  }
})

test('source replacement during drain cannot stop or upload another runtime', async () => {
  const f = fixture(); try {
    f.input.drain = async () => { f.runtime.authority = { ...f.authority, runtimeId: 'replacement-runtime' }; return { drained: true } }
    await assert.rejects(f.helper.start(f.input)); assert.equal(f.calls.includes('native-finalize'), false); assert.equal(f.calls.includes('http-checkpoint'), false); assert.equal(f.calls.includes('resume-admission'), false)
  } finally { f.epoch.key.fill(0) }
})

test('a native finalize refusal can retain the live page only after positive fresh original authority', async () => {
  const f = fixture(); try {
    f.runtime.finalize = async () => { f.calls.push('native-refusal'); throw Error('unfinished-credentials') }
    await assert.rejects(f.helper.start(f.input), /unfinished-credentials/); assert.equal(f.runtime.state, 'active'); assert.equal(f.calls.at(-1), 'resume-admission'); assert.equal(f.helper.state(f.request.requestId)?.state, 'blocked')
  } finally { f.epoch.key.fill(0) }
})

test('missing native physical stop or forged stopped receipt never uploads', async () => {
  for (const fault of ['state', 'network', 'receipt', 'signature', 'manifest']) {
    const f = fixture(), finalize = f.runtime.finalize; try {
      f.runtime.finalize = async (input: any) => { const stopped = await finalize.call(f.runtime, input)
        if (fault === 'state') f.runtime.state = 'active'
        else if (fault === 'network') f.runtime.network = 'active'
        else if (fault === 'receipt') stopped.receipt.stopped = false
        else if (fault === 'signature') stopped.signature = shared.documentSignature(f.desktop, stopped.receipt)
        else stopped.checkpoint.manifest.destination.sessionId = 'foreign-session'
        return stopped
      }
      await assert.rejects(f.helper.start(f.input), /outcome_unknown/); assert.equal(f.calls.includes('http-checkpoint'), false); assert.equal(f.calls.includes('resume-admission'), false)
    } finally { f.epoch.key.fill(0) }
  }
})

test('absent crossed or invalid encrypted journal readback leaves the source stopped without a POST', async () => {
  for (const fault of ['absent', 'hash', 'receipt', 'ciphertext']) {
    const f = fixture(); try {
      f.input.readJournal = async () => { const saved = structuredClone(f.state.saved)
        if (fault === 'absent') return null
        if (fault === 'hash') saved.manifestHash = '0'.repeat(64)
        else if (fault === 'receipt') saved.receiptSignature = shared.documentSignature(f.desktop, saved.receipt)
        else saved.checkpoint.ciphertext = Buffer.from('synthetic-corruption').toString('base64')
        return saved
      }
      await assert.rejects(f.helper.start(f.input), /outcome_unknown/); assert.equal(f.runtime.state, 'stopped'); assert.equal(f.calls.includes('http-checkpoint'), false)
    } finally { f.epoch.key.fill(0) }
  }
})

test('unknown upload is never repeated and only signed read reconciliation may confirm it', async () => {
  const f = fixture(); try {
    f.client.checkpoint = async () => { f.calls.push('http-checkpoint'); throw Error('PRIVATE_UNKNOWN_WRITE') }
    await assert.rejects(f.helper.start(f.input), { code: 'profile_return_outcome_unknown' }); assert.equal(f.helper.state(f.request.requestId)?.state, 'outcome-unknown')
    await assert.rejects(f.helper.start(f.input)); assert.equal((await f.helper.read(f.request.requestId))?.state, 'checkpoint-committed')
    assert.equal(f.calls.filter(value => value === 'native-finalize').length, 1); assert.equal(f.calls.filter(value => value === 'http-checkpoint').length, 1); assert.equal(f.calls.at(-1), 'signed-read')
  } finally { f.epoch.key.fill(0) }
})

test('a committed response without positive original source stopped proof stays unknown', async () => {
  const f = fixture(); try {
    f.client.checkpoint = async () => ({ ...f.committed(), sourceStopped: null })
    await assert.rejects(f.helper.start(f.input), /outcome_unknown/); assert.equal(f.helper.state(f.request.requestId)?.state, 'outcome-unknown')
  } finally { f.epoch.key.fill(0) }
})

test('restart recovery verifies local peer-addressed encrypted candidate and never stops or posts again', async () => {
  const f = fixture(); try {
    await f.helper.start(f.input); const restarted = new AgentReturnHandover({ client: f.client, now: () => f.state.now }); f.state.now += 600000
    const before = f.calls.slice(); assert.equal((await f.recover(restarted))?.state, 'checkpoint-committed'); assert.deepEqual(f.calls, [...before, 'journal-readback'])
    assert.equal((await restarted.read(f.request.requestId))?.state, 'checkpoint-committed'); assert.equal(f.calls.filter(value => value === 'http-checkpoint').length, 1)
  } finally { f.epoch.key.fill(0) }
})

test('restart pending or uncertain server state stays read-only with the native source stopped', async () => {
  const f = fixture(); try {
    await f.helper.start(f.input); const restarted = new AgentReturnHandover({ client: f.client, now: () => f.state.now })
    assert.equal((await f.recover(restarted, f.status))?.state, 'outcome-unknown'); assert.equal(f.runtime.state, 'stopped'); assert.equal(f.calls.filter(value => value === 'http-checkpoint').length, 1)
  } finally { f.epoch.key.fill(0) }
})

test('restart rejects crossed candidate lineage and unreviewed desktop before exposing progress', async () => {
  for (const fault of ['pin', 'candidate', 'journal']) {
    const f = fixture(); try {
      await f.helper.start(f.input); const restarted = new AgentReturnHandover({ client: f.client, now: () => f.state.now }), input: any = { scope: f.scope, endpoint: f.endpoint, status: f.committed(), peerPins: [f.desktop.identity], candidate: f.candidate(), readJournal: f.input.readJournal, assertCurrent: f.input.assertCurrent }
      if (fault === 'pin') input.peerPins = []
      else if (fault === 'candidate') input.candidate.coordinatorTransitionId = randomUUID()
      else input.readJournal = async () => null
      await assert.rejects(restarted.recover(input)); assert.equal(f.calls.filter(value => value === 'http-checkpoint').length, 1)
    } finally { f.epoch.key.fill(0) }
  }
})
