import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { AgentRuntimePermissionClient } from '../lib/browser-profile-permission-client.mjs'
const require = createRequire(import.meta.url), codec = require('../lib/browser-profile-core/crypto.js'), shared = require('../lib/browser-profile-core/coordinator-client.js')
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function fixture(timeoutMs = 2000) {
  const endpoint = codec.createEndpointIdentity(randomUUID()), authority = { profileId: randomUUID(), actingUserId: 'recipient', assistantId: 42, endpointId: endpoint.identity.endpointId, keyFingerprint: codec.identityFingerprint(endpoint.identity), bootId: 'boot', runtimeId: 'runtime', sessionId: 'session', writerEpoch: 1, revision: 0, contentKeyEpoch: 1, grantVersion: 1 }
  const binding = { bindingId: randomUUID(), socketId: 'agent-socket', authority }, signal = new AbortController(), calls: any[] = [], state: any = { now: Date.now(), current: true, status: 'pending', choice: null }
  const frame = { event_type: 'browser_profile_rpc', version: 1, rpcId: randomUUID(), rpcNonce: 'a'.repeat(43), bindingId: binding.bindingId, authority, clientId: 'fixture-agent', assistantId: 42,
    message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://site.test/private?token=SYNTHETIC_PERMISSION_SECRET' } } }, deadlineAt: new Date(state.now + 120000).toISOString() }
  const proof = { pairingId: 7, ownerUserId: 'sharer', assistantId: 42, token: 'synthetic-pairing-only', assertCurrent() { if (!state.current) throw Error('SYNTHETIC_PRIVATE_CONTEXT') } }
  const hooks: { fetch?: (url: string, options: RequestInit, body: any, normal: () => Response) => Promise<Response>; authorize?: () => Promise<any> } = {}
  let request: any
  const client = new AgentRuntimePermissionClient({ origin: 'https://hoai.test', timeoutMs, now: () => state.now, authorizePairing: async () => hooks.authorize ? hooks.authorize() : proof,
    fetchImpl: async (url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body)), route = new URL(url).pathname, query = !route.endsWith('/request'), consumed = route.endsWith('/consume')
      const document = query ? { version: 1, kind: consumed ? 'runtime-permission-consume' : 'runtime-permission-read', ...body } : { version: 1, kind: 'runtime-permission-request', request: Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'signature')) }
      if (query) delete document.signature
      assert.equal(verify(null, shared.canonical(document), createPublicKey(endpoint.signingPrivateKey), Buffer.from(body.signature, 'base64url')), true)
      calls.push({ url, options, body, document })
      if (!query) request = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'signature'))
      const normal = () => new Response(JSON.stringify({ ...request, originSource: request.kind === 'navigate' ? 'request-url' : 'agent-reported', label: ({ navigate: 'Open a website', write: 'Change a page selection', sensitive: 'Perform a page action', upload: 'Upload a file', download: 'Save a page as PDF' } as any)[request.kind],
        state: consumed ? 'consumed' : state.status, choice: consumed ? 'allow_once' : state.choice, ...(query ? { readNonce: body.readNonce, readExpiresAt: body.readExpiresAt } : {}), ...(consumed ? { consumed: true } : {}) }), { status: 200 })
      return hooks.fetch ? hooks.fetch(url, options, body, normal) : normal()
    } })
  const input = () => ({ frame, binding, endpoint, origin: 'https://site.test', assertCurrent() { if (!state.current) throw Error('SYNTHETIC_PRIVATE_CONTEXT') }, signal: signal.signal })
  return { client, authority, frame, binding, endpoint, state, proof, hooks, calls, input, signal, request: () => request }
}

test('paired request and one consume bind the original RPC, authority, origin and safe metadata', async () => {
  const f = fixture(), requested = await f.client.request(f.input()); assert.equal(requested.status.state, 'pending')
  // Backend RPC retains the original JSON serialization, including insertion
  // order. Its permission hash is distinct from the sorted signature encoding.
  const originalWire = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"https://site.test/private?token=SYNTHETIC_PERMISSION_SECRET"}}}'
  const request = f.request(); assert.equal(request.actionHash, createHash('sha256').update(originalWire).digest('hex'))
  assert.notEqual(request.actionHash, createHash('sha256').update(shared.canonical(f.frame.message)).digest('hex'))
  assert.deepEqual(request.authority, f.authority); assert.equal(request.expiresAt, f.state.now + 60000)
  const first = f.calls[0]; assert.equal(first.url, 'https://hoai.test/api/v1/browser/profile-sync/runtime/permissions/request')
  assert.deepEqual(Object.keys(first.options.headers).sort(), ['X-BGOS-Pairing', 'Content-Type', 'Accept', 'Accept-Encoding'].sort())
  assert.equal(first.options.credentials, 'omit'); assert.equal(first.options.redirect, 'error'); assert.equal(first.options.cache, 'no-store')
  assert.equal(String(first.options.body).includes('SYNTHETIC_PERMISSION_SECRET'), false); assert.equal(String(first.options.body).includes('PrivateKey'), false)
  await assert.rejects(f.client.consume(requested.handle), /answer_required/); assert.equal(f.calls.length, 1)
  f.state.status = 'answered'; f.state.choice = 'allow_once'; assert.deepEqual(await f.client.read(requested.handle), { state: 'answered', choice: 'allow_once' })
  assert.deepEqual(await f.client.consume(requested.handle), { state: 'consumed', choice: 'allow_once' })
  await assert.rejects(f.client.consume(requested.handle), /consumed/); assert.equal(f.calls.filter(call => call.url.endsWith('/consume')).length, 1)
})

test('an unchanged original RPC cannot create another permission id or replay its request', async () => {
  const f = fixture(); await f.client.request(f.input()); await assert.rejects(f.client.request(f.input()), /duplicate/); assert.equal(f.calls.length, 1)
})

test('text, credentials, evaluation and vision require handover before any permission HTTP', async () => {
  for (const name of ['browser_type', 'browser_press_key', 'browser_fill_form', 'browser_evaluate', 'browser_mouse_click_xy', 'unknown_tool']) {
    const f = fixture(); f.frame.message.params.name = name; await assert.rejects(f.client.request(f.input()), /handover_required/); assert.equal(f.calls.length, 0)
  }
})

test('an endpoint cannot borrow another identity or a crossed original binding', async () => {
  for (const fault of ['private-key', 'binding', 'socket', 'authority', 'rpc', 'nonce', 'kind', 'origin', 'credentials', 'deadline']) {
    const f = fixture(), input: any = f.input()
    if (fault === 'private-key') input.endpoint = { ...f.endpoint, signingPrivateKey: codec.createEndpointIdentity(randomUUID()).signingPrivateKey }
    else if (fault === 'binding') input.binding = { ...f.binding, bindingId: randomUUID() }
    else if (fault === 'socket') input.binding = { ...f.binding, socketId: '../private' }
    else if (fault === 'authority') input.binding = { ...f.binding, authority: { ...f.authority, actingUserId: 'sharer' } }
    else if (fault === 'rpc') (f.frame as any).rpcId = '../private'
    else if (fault === 'nonce') f.frame.rpcNonce = 'wrong'
    else if (fault === 'kind') f.frame.event_type = 'legacy_browser_rpc'
    else if (fault === 'origin') input.origin = 'https://foreign.test'
    else if (fault === 'credentials') f.frame.message.params.arguments.url = 'https://username:password@site.test/private'
    else f.frame.deadlineAt = new Date(f.state.now).toISOString()
    await assert.rejects(f.client.request(input)); assert.equal(f.calls.length, 0)
  }
})

test('crossed response scope, changed choice, query echo and unknown response fields cannot authorize', async () => {
  for (const fault of ['actor', 'profile', 'rpc', 'binding', 'hash', 'origin', 'label', 'origin-source', 'nonce', 'extra', 'choice']) {
    const f = fixture(), requested = await f.client.request(f.input()); f.state.status = 'answered'; f.state.choice = 'allow_once'
    if (fault === 'choice') { await f.client.read(requested.handle); f.state.choice = 'deny' }
    else f.hooks.fetch = async (_url, _options, _body, normal) => { const value = await normal().json() as any
      if (fault === 'actor') value.authority.actingUserId = 'sharer'
      else if (fault === 'profile') value.authority.profileId = randomUUID()
      else if (fault === 'rpc') value.rpcId = randomUUID()
      else if (fault === 'binding') value.bindingId = randomUUID()
      else if (fault === 'hash') value.actionHash = '0'.repeat(64)
      else if (fault === 'origin') value.origin = 'https://foreign.test'
      else if (fault === 'label') value.label = 'UNTRUSTED_SITE_TEXT'
      else if (fault === 'origin-source') value.originSource = 'agent-reported'
      else if (fault === 'nonce') value.readNonce = 'b'.repeat(43)
      else value.extra = true
      return new Response(JSON.stringify(value)) }
    await assert.rejects(f.client.read(requested.handle), /response_invalid/); assert.equal(f.calls.filter(call => call.url.endsWith('/consume')).length, 0)
  }
})

test('deeply nested response fields are refused with a fixed error and an unknown creation stays reconcilable', async () => {
  for (const field of ['authority', 'gateId']) {
    const f = fixture(), nested = '['.repeat(8000) + '0' + ']'.repeat(8000)
    f.hooks.fetch = async (_url, _options, _body, normal) => {
      const value = await normal().json() as any; value[field] = 'NESTED_RESPONSE_MARKER'
      return new Response(JSON.stringify(value).replace('"NESTED_RESPONSE_MARKER"', nested))
    }
    const requested = await f.client.request(f.input())
    assert.deepEqual(requested.status, { state: 'outcome-unknown', choice: null })
    await assert.rejects(f.client.read(requested.handle), (error: any) => error.code === 'profile_permission_response_invalid')
    delete f.hooks.fetch; assert.deepEqual(await f.client.read(requested.handle), { state: 'pending', choice: null })
    assert.equal(f.calls.filter(call => call.url.endsWith('/request')).length, 1)
    assert.equal(f.calls.filter(call => call.url.endsWith('/consume')).length, 0)
  }
})

test('expiry, backward clock, abort and original verifier replacement invalidate a pending proof', async () => {
  for (const fault of ['expiry', 'backward', 'abort', 'source', 'verifier', 'token']) {
    const f = fixture(), gate = deferred<Response>(); f.hooks.fetch = async () => gate.promise
    const pending = f.client.request(f.input()), rejected = assert.rejects(pending, /context_changed/); await new Promise(resolve => setImmediate(resolve))
    if (fault === 'expiry') f.state.now += 60000
    else if (fault === 'backward') f.state.now--
    else if (fault === 'abort') f.signal.abort()
    else if (fault === 'source') f.state.current = false
    else if (fault === 'verifier') f.proof.assertCurrent = () => {}
    else f.proof.token = 'changed-pairing'
    const request = f.request(); gate.resolve(new Response(JSON.stringify({ ...request, state: 'pending', choice: null, originSource: 'request-url', label: 'Open a website' }))); await rejected
  }
})

test('a query that expires during HTTP is refused even while the original gate remains live', async () => {
  const f = fixture(), requested = await f.client.request(f.input()); f.hooks.fetch = async (_url, _options, _body, normal) => { f.state.now += 10000; return normal() }
  await assert.rejects(f.client.read(requested.handle), /response_invalid/)
})

test('an unknown consume acknowledgement is never resent or accepted as execution permission', async () => {
  const f = fixture(), requested = await f.client.request(f.input()); f.state.status = 'answered'; f.state.choice = 'allow_once'; await f.client.read(requested.handle)
  f.hooks.fetch = async () => { throw Error('SYNTHETIC_PRIVATE_NETWORK_DETAIL') }
  await assert.rejects(f.client.consume(requested.handle), { code: 'profile_permission_outcome_unknown' })
  await assert.rejects(f.client.consume(requested.handle), /consumed/); assert.equal(f.calls.filter(call => call.url.endsWith('/consume')).length, 1)
})

test('timeout retains an unresolved physical HTTP slot until actual settlement', async () => {
  const f = fixture(20), gate = deferred<Response>(); f.hooks.fetch = async () => gate.promise
  const requested = await f.client.request(f.input()); assert.equal(requested.status.state, 'outcome-unknown')
  assert.deepEqual(f.client.activity(), { pendingPhysicalOperations: 1, cleanupUnknown: false })
  await assert.rejects(f.client.consume(requested.handle), /busy/)
  await assert.rejects(f.client.request({ ...f.input(), frame: { ...f.frame, rpcId: randomUUID() } }), /busy/)
  let drained = false; const drain = f.client.whenDrained().then(() => { drained = true }); await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false)
  gate.resolve(new Response('{}')); await drain; delete f.hooks.fetch
  assert.deepEqual(f.client.activity(), { pendingPhysicalOperations: 0, cleanupUnknown: false })
  assert.equal((await f.client.request({ ...f.input(), frame: { ...f.frame, rpcId: randomUUID() } })).status.state, 'pending')
})

test('oversized and malformed response bytes cannot become permission metadata', async () => {
  for (const bytes of ['x'.repeat(65537), new Uint8Array([255])]) {
    const f = fixture(); f.hooks.fetch = async () => new Response(bytes); const result = await f.client.request(f.input()); assert.equal(result.status.state, 'outcome-unknown')
    await assert.rejects(f.client.consume(result.handle), /answer_required/)
  }
})

test('reader cleanup failure releases the lock and refuses rather than returning an approval', async () => {
  const f = fixture(); let released = false
  f.hooks.fetch = async (_url, _options, _body, normal) => { const bytes = new TextEncoder().encode(await normal().text()); let read = false
    return { status: 200, body: { getReader: () => ({ read: async () => read ? { done: true } : (read = true, { done: false, value: bytes }), cancel: async () => { throw Error('SYNTHETIC_PRIVATE_CLEANUP') }, releaseLock: () => { released = true } }) } } as unknown as Response }
  assert.equal((await f.client.request(f.input())).status.state, 'outcome-unknown'); assert.equal(released, true)
  await assert.rejects(f.client.whenDrained(), /cleanup_unconfirmed/)
  assert.deepEqual(f.client.activity(), { pendingPhysicalOperations: 1, cleanupUnknown: true })
  await assert.rejects(f.client.request({ ...f.input(), frame: { ...f.frame, rpcId: randomUUID() } }), /busy/)
})

test('a response arriving after timeout retains body cancellation and the physical slot until it settles', async () => {
  const f = fixture(20), fetchReply = deferred<Response>(), cancelled = deferred<void>(); let cancellationStarted = false
  f.hooks.fetch = async () => fetchReply.promise
  assert.equal((await f.client.request(f.input())).status.state, 'outcome-unknown')
  let drained = false; const drain = f.client.whenDrained().then(() => { drained = true })
  const response = new Response(new ReadableStream({ cancel() { cancellationStarted = true; return cancelled.promise } }))
  fetchReply.resolve(response); await new Promise(resolve => setImmediate(resolve))
  try { assert.equal(cancellationStarted, true); assert.equal(drained, false)
    await assert.rejects(f.client.request({ ...f.input(), frame: { ...f.frame, rpcId: randomUUID() } }), /busy/)
  } finally { cancelled.resolve() }
  await drain; assert.equal(response.body?.locked, false)
})

test('a lost creation acknowledgement retains an opaque handle for signed read-only reconciliation', async () => {
  const f = fixture(); f.hooks.fetch = async () => { throw Error('SYNTHETIC_LOST_ACK') }
  const requested = await f.client.request(f.input()); assert.equal(requested.status.state, 'outcome-unknown'); assert.equal(Object.keys(requested.handle).length, 0)
  await assert.rejects(f.client.consume(requested.handle), /answer_required/); delete f.hooks.fetch
  assert.equal((await f.client.read(requested.handle)).state, 'pending'); f.state.status = 'answered'; f.state.choice = 'allow_once'
  assert.equal((await f.client.read(requested.handle)).choice, 'allow_once'); assert.equal((await f.client.consume(requested.handle)).state, 'consumed')
  assert.equal(f.calls.filter(call => call.url.endsWith('/request')).length, 1)
})
