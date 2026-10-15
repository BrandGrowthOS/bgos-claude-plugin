import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { AgentBrowserProfileCompanion } from '../lib/browser-profile-companion.mjs'
import { AgentRuntimePermissionClient } from '../lib/browser-profile-permission-client.mjs'
import { AgentRuntimePermissionRunner } from '../lib/browser-profile-permission-runner.mjs'
import { RelaySessions } from '../bin/hoai-browser-host.mjs'
const require = createRequire(import.meta.url), codec = require('../lib/browser-profile-core/crypto.js')
type Row = Record<string, any>
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
class Page extends EventEmitter { address = 'https://site.test/path'; closed = false; url() { return this.address } isClosed() { return this.closed } }
async function fixture(t: { after: (callback: () => unknown) => void }, options: Row = {}) {
  const calls: Row[] = [], page = new Page(), endpoint = codec.createEndpointIdentity(randomUUID()), scope = { profileId: randomUUID(), actingUserId: 'recipient', assistantId: 42, endpointId: endpoint.identity.endpointId, keyFingerprint: codec.identityFingerprint(endpoint.identity), pairingId: 7, ownerUserId: 'sharer' }
  const connection: Row = { bootId: randomUUID(), _stopped: false, pairing: { token: 'synthetic-pairing', backendUrl: 'https://hoai.test', pairingId: 7, ownerUserId: 'sharer', assistantIds: [42] }, socketId: 'socket-a', socket: { connected: true } }
  const authority = { ...Object.fromEntries(['profileId', 'actingUserId', 'assistantId', 'endpointId', 'keyFingerprint'].map(key => [key, scope[key as keyof typeof scope]])), bootId: connection.bootId, runtimeId: randomUUID(), sessionId: randomUUID(), writerEpoch: 1, revision: 0, contentKeyEpoch: 1, grantVersion: 1 }
  const state: Row = { now: Date.now(), status: { state: 'pending', choice: null }, selected: page, read: { state: 'answered', choice: 'allow_once' }, frame: null }
  const hooks: Row = {}, handle = Object.freeze(Object.create(null)), permissionClient = options.permissionClient || {
    async request(input: Row) { calls.push({ kind: 'request', input }); input.assertCurrent(); if (hooks.request) return hooks.request(input); return { handle, status: state.status } },
    async read(value: object) { assert.strictEqual(value, handle); calls.push({ kind: 'read' }); if (hooks.read) return hooks.read(); return state.read },
    async consume(value: object) { assert.strictEqual(value, handle); calls.push({ kind: 'consume' }); if (hooks.consume) return hooks.consume(); return { state: 'consumed', choice: 'allow_once' } },
    async whenDrained() { calls.push({ kind: 'drain' }); if (hooks.drain) await hooks.drain() }
  }
  const runner = new AgentRuntimePermissionRunner({ client: permissionClient, now: () => state.now, delay: async (ms: number, signal: AbortSignal) => { calls.push({ kind: 'wait', ms }); if (hooks.wait) await hooks.wait(signal); state.now += ms } })
  const engine: Row = { selectedPage: () => state.selected, roster: () => [{ name: 'browser_click', description: 'Fixture action', inputSchema: { type: 'object', additionalProperties: true } }, { name: 'browser_navigate', description: 'Fixture navigation', inputSchema: { type: 'object', additionalProperties: true } }],
    async callTool(name: string, args: Row, signal: AbortSignal) { signal.throwIfAborted(); calls.push({ kind: 'engine', name, args }); if (hooks.engine) return hooks.engine(name, args); return { content: [{ type: 'text', text: 'fixture action ran' }] } },
    async stop() { calls.push({ kind: 'engine-stop' }) }
  }
  const runtime: Row = { authority, state: 'active', network: 'active', assertCurrent() { if (this.state !== 'active') throw Error('fixture runtime inactive'); return authority }, async activate() {}, async newPage() {}, async dispose() { calls.push({ kind: 'native-dispose' }); this.state = 'disposed'; this.network = 'blocked' } }
  const entry = { profile: { ...authority, id: scope.profileId, writerState: 'active', headManifestHash: null }, grant: { generation: 1, backgroundUse: true } }
  const companion: any = new AgentBrowserProfileCompanion({ connection, agentRoot: path.join(os.tmpdir(), 'hoai-permission-fixture'), deviceLabel: 'Fixture', client: { discover: async () => ({ profiles: [entry] }) }, keyStore: {}, stateStore: {}, permissionClient, statusClient: undefined,
    permissionRunner: runner, loadBrowser: async () => ({}), createEngine: async () => engine, createRelay: (core: Row) => options.createRelay ? options.createRelay(core) : new RelaySessions({ core, serverInfo: { name: 'fixture', version: '1' }, instructions: 'Fixture', callCapMs: options.callCapMs || 2000 }) })
  const record: Row = { scope, identity: endpoint.identity, endpoint, runtime, admission: 'blocked', revoked: false, uncertain: false, engineTasks: new Set(), state: 'saved' }
  companion.records.set(scope.endpointId, record)
  companion._prove = async () => { record.rpc.binding = Object.freeze({ bindingId: randomUUID(), socketId: connection.socketId, authority }) }
  await companion._activate(record, authority)
  companion.rpcClient.dispatch = async () => ({ frame: structuredClone(state.frame) })
  companion.rpcClient.result = async (_authority: Row, _endpoint: Row, input: Row) => { calls.push({ kind: 'completion', payload: input.payload }); return { accepted: true } }
  companion.rpcClient.cancellation = async () => ({ requested: true })
  const frame = (name = 'browser_click', args: Row = { target: 'e12', element: 'Open item' }) => ({ event_type: 'browser_profile_rpc', version: 1, rpcId: randomUUID(), rpcNonce: 'a'.repeat(43), bindingId: record.rpc.binding.bindingId, authority, clientId: 'fixture-agent', assistantId: 42,
    message: { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }, deadlineAt: new Date(state.now + 120000).toISOString() })
  const run = (name?: string, args?: Row) => { state.frame = frame(name, args); return companion.receive(state.frame, connection.socketId) }
  t.after(async () => { record.relay?.close(); record.rpc?.disconnect(); await Promise.allSettled([...record.engineTasks]); runtime.state = 'disposed' })
  return { companion, record, runtime, engine, page, endpoint, authority, scope, connection, state, calls, hooks, frame, run, runner, permissionClient, entry, handle }
}

test('actual endpoint and unchanged MCP relay hold one original action through native answer and consume', async t => {
  const f = await fixture(t); assert.equal((await f.run()).completionAccepted, true)
  assert.deepEqual(f.calls.filter(row => ['request', 'read', 'consume', 'engine'].includes(row.kind)).map(row => row.kind), ['request', 'read', 'consume', 'engine'])
  const input = f.calls.find(row => row.kind === 'request')!.input
  assert.equal(input.frame.rpcId, f.state.frame.rpcId); assert.deepEqual(input.frame.message, f.state.frame.message); assert.strictEqual(input.endpoint, f.endpoint); assert.equal(input.origin, 'https://site.test')
  assert.equal(f.record.engineTasks.size, 0); assert.equal(f.page.listenerCount('framenavigated'), 0)
  assert.equal(f.calls.find(row => row.kind === 'completion')!.payload.ok, true)
  await f.companion.receive(f.state.frame, f.connection.socketId); assert.equal(f.calls.filter(row => row.kind === 'engine').length, 1)
})

test('deny, expired, consumed readback and unknown consume never execute or resend creation', async t => {
  for (const failure of ['deny', 'expired', 'consumed', 'unknown-consume']) {
    const f = await fixture(t)
    if (failure === 'deny') f.state.read = { state: 'answered', choice: 'deny' }
    else if (failure === 'expired') f.state.read = { state: 'expired', choice: null }
    else if (failure === 'consumed') f.state.read = { state: 'consumed', choice: 'allow_once' }
    else f.hooks.consume = () => { throw Error('synthetic lost consume reply') }
    await f.run(); assert.equal(f.calls.some(row => row.kind === 'engine'), false); assert.equal(f.calls.filter(row => row.kind === 'request').length, 1)
    assert.equal(f.calls.filter(row => row.kind === 'consume').length, failure === 'unknown-consume' ? 1 : 0)
  }
})

test('credential, type, press, evaluation, vision, unknown and policy hard deny have no permission authority', async t => {
  for (const [name, args] of [['browser_click', { target: 'password', element: 'Password field' }], ['browser_type', { text: 'synthetic' }], ['browser_press_key', { key: 'Enter' }], ['browser_evaluate', { function: '() => true' }], ['browser_mouse_click_xy', { x: 1, y: 1 }], ['unknown_tool', {}], ['browser_navigate', { url: 'https://paypal.com' }], ['browser_navigate', { url: 'http://10.0.0.1' }]] as [string, Row][]) {
    const f = await fixture(t); f.page.address = 'about:blank'; await f.companion._tool(f.record, name, args, new AbortController().signal)
    assert.equal(f.calls.some(row => ['request', 'engine'].includes(row.kind)), false, name)
  }
})

test('read and PDF retain existing policy behavior while a direct unsupported call cannot invent an RPC', async t => {
  const f = await fixture(t)
  for (const name of ['browser_snapshot', 'browser_pdf_save']) await f.companion._tool(f.record, name, {}, new AbortController().signal)
  await f.companion._tool(f.record, 'browser_click', { target: 'e12' }, new AbortController().signal)
  assert.equal(f.calls.filter(row => row.kind === 'engine').length, 2); assert.equal(f.calls.some(row => row.kind === 'request'), false)
})

test('original page selection URL navigation history and closure fence a pending native answer', async t => {
  for (const fault of ['selection', 'url', 'navigate-back', 'closed', 'crash']) {
    const f = await fixture(t); f.hooks.wait = () => { if (fault === 'selection') f.state.selected = new Page(); else if (fault === 'url') f.page.address += '/changed'; else if (fault === 'navigate-back') f.page.emit('framenavigated', {}); else if (fault === 'closed') f.page.closed = true; else f.page.emit('crash') }
    await f.run(); assert.equal(f.calls.some(row => ['consume', 'engine'].includes(row.kind)), false, fault)
  }
})

test('a changed original frame or SDK action cannot borrow the waiting permission', async t => {
  const f = await fixture(t); f.hooks.request = (input: Row) => { input.frame.message.params.arguments.target = 'e99'; return { handle: f.handle, status: { state: 'answered', choice: 'allow_once' } } }
  await f.run(); assert.equal(f.calls.some(row => ['consume', 'engine'].includes(row.kind)), false)
  const g = await fixture(t); g.record.relay.close(); g.record.relay = { async relay() { return { ok: true, message: { jsonrpc: '2.0', id: g.state.frame.message.id, result: await g.companion._tool(g.record, 'browser_click', { target: 'e99' }, new AbortController().signal) } } }, close() {} }
  await g.run(); assert.equal(g.calls.some(row => ['request', 'consume', 'engine'].includes(row.kind)), false)
})

test('runtime engine endpoint binding socket and recipient substitutions invalidate an original permission', async t => {
  for (const fault of ['runtime', 'engine', 'endpoint', 'binding', 'socket', 'recipient']) {
    const f = await fixture(t); f.hooks.wait = () => {
      if (fault === 'runtime') f.record.runtime = { ...f.runtime }
      else if (fault === 'engine') f.record.engine = { ...f.engine }
      else if (fault === 'endpoint') f.record.endpoint = { ...f.endpoint }
      else if (fault === 'binding') f.record.rpc.binding = { ...f.record.rpc.binding }
      else if (fault === 'socket') f.connection.socketId = 'replacement-socket'
      else f.record.scope = { ...f.record.scope, actingUserId: 'sharer' }
    }
    await f.run(); assert.equal(f.calls.some(row => ['consume', 'engine'].includes(row.kind)), false, fault)
  }
})

test('a page change during consumption refuses the action after the one spent permission', async t => {
  const f = await fixture(t); f.hooks.consume = () => { f.page.address = 'https://other.test'; return { state: 'consumed', choice: 'allow_once' } }
  await f.run(); assert.equal(f.calls.filter(row => row.kind === 'consume').length, 1); assert.equal(f.calls.some(row => row.kind === 'engine'), false)
})

test('disconnect and original endpoint cancellation abort waiting approval without a late action', async t => {
  for (const mode of ['disconnect', 'cancel']) {
    const f = await fixture(t), entered = deferred<void>(), release = deferred<void>(); f.hooks.wait = async () => { entered.resolve(); await release.promise }
    const work = f.run(); await entered.promise
    if (mode === 'disconnect') f.companion.disconnected()
    else await f.companion.receive({ ...f.state.frame, event_type: 'browser_profile_rpc_cancel' }, f.connection.socketId)
    release.resolve(); await work
    assert.equal(f.calls.some(row => ['consume', 'engine'].includes(row.kind)), false); assert.equal(f.record.engineTasks.size, 0)
  }
})

test('the permission read loop is bounded to the original gate lifetime and never creates another gate', async t => {
  const f = await fixture(t); f.state.read = { state: 'pending', choice: null }; await f.run()
  assert.equal(f.calls.filter(row => row.kind === 'request').length, 1); assert.ok(f.calls.filter(row => row.kind === 'read').length <= 60); assert.equal(f.calls.some(row => ['consume', 'engine'].includes(row.kind)), false)
})

test('relay timeout retains physical command work until the engine actually settles', async t => {
  const f = await fixture(t, { callCapMs: 20 }), entered = deferred<void>(), release = deferred<Row>(); f.hooks.engine = () => { entered.resolve(); return release.promise }
  let completed = false; const work = f.run().then((value: Row) => { completed = true; return value }); await entered.promise
  try { await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(completed, false); assert.equal(f.record.engineTasks.size, 1); assert.ok(f.record.rpc.physical) }
  finally { release.resolve({ content: [] }) }
  await work; assert.equal(f.calls.filter(row => row.kind === 'engine').length, 1)
})

test('native revocation starts before a real late permission HTTP body drains and cannot execute afterward', async t => {
  const fetchReply = deferred<Response>(), cancelReply = deferred<void>(); let cancellationStarted = false
  const actual = new AgentRuntimePermissionClient({ origin: 'https://hoai.test', timeoutMs: 20, authorizePairing: async () => ({ pairingId: 7, ownerUserId: 'sharer', assistantId: 42, token: 'synthetic', assertCurrent() {} }), fetchImpl: async () => fetchReply.promise })
  const f = await fixture(t, { permissionClient: actual }), entered = deferred<void>(); f.hooks.wait = () => { entered.resolve() }
  const work = f.run(); await entered.promise; let revoked = false; const revoking = f.companion.revoke().then(() => { revoked = true })
  const response = new Response(new ReadableStream({ cancel() { cancellationStarted = true; return cancelReply.promise } }))
  try {
    await tick(); assert.equal(f.calls.filter(row => row.kind === 'native-dispose').length, 1); assert.equal(revoked, false); assert.equal(f.record.engineTasks.size, 1)
    fetchReply.resolve(response); await tick(); assert.equal(cancellationStarted, true); assert.equal(revoked, false)
  } finally { fetchReply.resolve(response); cancelReply.resolve(); await work; await revoking }
  assert.equal(revoked, true); assert.equal(f.calls.some(row => row.kind === 'engine'), false)
})

test('failed permission cleanup retains a private command reservation even if public state is forged', async t => {
  const f = await fixture(t); f.hooks.drain = () => { throw Object.assign(Error('synthetic cleanup refused'), { code: 'profile_permission_cleanup_unconfirmed' }) }
  await f.run(); assert.equal(f.record.engineTasks.size, 1)
  f.record.permissionCleanupUnknown = false; f.record.engineTasks.clear()
  assert.throws(() => f.companion._admit(f.record), /authority_unknown/)
  await assert.rejects(f.companion._dispose(f.record), /stop_unconfirmed/); assert.equal(f.calls.filter(row => row.kind === 'native-dispose').length, 1)
})

test('partial listener registration is rolled back before any request or native action', async t => {
  const f = await fixture(t), original = f.page.on, removals: string[] = [], remove = f.page.removeListener
  f.page.on = function (event: string, listener: (...args: any[]) => void) { original.call(this, event, listener); if (event === 'close') throw Error('synthetic registration refused'); return this }
  f.page.removeListener = function (event: string, listener: (...args: any[]) => void) { removals.push(event); return remove.call(this, event, listener) }
  await f.run(); assert.deepEqual(removals, ['framenavigated', 'close']); assert.equal(f.page.eventNames().length, 0)
  assert.equal(f.calls.some(row => ['request', 'engine'].includes(row.kind)), false); assert.equal(f.record.engineTasks.size, 0); assert.equal(f.companion._admit(f.record), true)
})

test('failed listener cleanup attempts every removal and retains the private physical reservation', async t => {
  const f = await fixture(t), removals: string[] = [], remove = f.page.removeListener
  f.page.removeListener = function (event: string, listener: (...args: any[]) => void) { removals.push(event); if (event === 'framenavigated') throw Error('synthetic cleanup refused'); return remove.call(this, event, listener) }
  await f.run(); assert.deepEqual(removals, ['framenavigated', 'close', 'crash']); assert.equal(f.page.listenerCount('close'), 0); assert.equal(f.page.listenerCount('crash'), 0)
  assert.equal(f.calls.filter(row => row.kind === 'engine').length, 1); assert.equal(f.record.engineTasks.size, 1); assert.throws(() => f.runner.assertCleanupConfirmed(), /cleanup_unconfirmed/)
  const before = f.calls.length, other = new Page()
  await assert.rejects(f.runner.run({ frame: f.state.frame, binding: f.record.rpc.binding, endpoint: f.endpoint, engine: { ...f.engine, selectedPage: () => other }, assertCurrent() {}, signal: new AbortController().signal, execute: async () => { f.calls.push({ kind: 'unexpected-run' }); return {} } }), /cleanup_unconfirmed/)
  assert.equal(f.calls.length, before)
  f.record.engineTasks.clear(); assert.throws(() => f.companion._admit(f.record), /authority_unknown/)
})

test('a duplicate SDK callback cannot claim the same original tool a second time', async t => {
  const f = await fixture(t, { createRelay: (core: Row) => new RelaySessions({ core: { ...core, async callTool(...args: any[]) { const result = await core.callTool(...args); await assert.rejects(core.callTool(...args), /command_changed/); return result } }, serverInfo: { name: 'fixture', version: '1' }, instructions: 'Fixture' }) })
  await f.run(); assert.equal(f.calls.filter(row => row.kind === 'request').length, 1); assert.equal(f.calls.filter(row => row.kind === 'consume').length, 1); assert.equal(f.calls.filter(row => row.kind === 'engine').length, 1)
})

test('original endpoint cancellation reaches an already running native engine action', async t => {
  const f = await fixture(t), entered = deferred<AbortSignal>(), release = deferred<Row>()
  f.engine.callTool = async (_name: string, _args: Row, signal: AbortSignal) => { entered.resolve(signal); return release.promise }
  const work = f.run(); const signal = await entered.promise
  try { await f.companion.receive({ ...f.state.frame, event_type: 'browser_profile_rpc_cancel' }, f.connection.socketId); assert.equal(signal.aborted, true) }
  finally { release.resolve({ content: [] }); await work }
})

test('late SDK read write and session callbacks cannot borrow a newer matching original request', async t => {
  for (const name of ['browser_snapshot', 'browser_click', 'browser_close']) {
    const first = deferred<void>(), second = deferred<void>(), secondEntered = deferred<void>(); let callbacks = 0
    const f = await fixture(t, { createRelay: (core: Row) => new RelaySessions({ core: { ...core, async callTool(...args: any[]) { if (++callbacks === 1) await first.promise; else { secondEntered.resolve(); await second.promise } return core.callTool(...args) } }, serverInfo: { name: 'fixture', version: '1' }, instructions: 'Fixture', callCapMs: 50 }) })
    f.companion.retire = async () => { f.calls.push({ kind: 'retire' }) }
    await Promise.all([f.run(name, {}), new Promise(resolve => setTimeout(resolve, 75))]); const current = f.run(name, {}); await secondEntered.promise
    try { first.resolve(); await tick(); await tick(); assert.equal(f.calls.some(row => ['request', 'engine', 'retire'].includes(row.kind)), false, name) }
    finally { first.resolve(); second.resolve(); await current }
    assert.equal(f.calls.filter(row => row.kind === (name === 'browser_close' ? 'retire' : 'engine')).length, 1, name)
  }
})

test('a committed normal close disposes its exact runtime while its retired active RPC stays uncertain', { timeout: 3000 }, async t => {
  for (const name of ['browser_close', 'hoai_browser_close_session']) {
    const f = await fixture(t), epoch = codec.createContentKeyEpoch(1), portable = require('../lib/browser-profile-core/portable-state.js'); f.record.contentKeyEpoch = epoch
    f.runtime.finalize = async (input: Row) => {
      f.record.admission = 'stopping'; await f.companion._drainCommands(f.record)
      const plaintext = portable.encodePortableState({ schema: portable.SCHEMA, cookies: [], origins: [], passwordVault: { v: 1, entries: [], neverOrigins: [] }, preferences: { v: 1, searchEngine: 'google' } })
      let checkpoint; try { checkpoint = codec.sealCheckpoint({ plaintext, context: input.context, source: input.source, destinationIdentity: input.destinationIdentity, contentKeyEpoch: input.contentKeyEpoch }) } finally { plaintext.fill(0) }
      f.runtime.state = 'stopped'; f.runtime.network = 'blocked'; return { checkpoint, receipt: { transitionId: input.context.transitionId } }
    }
    f.companion.client.retire = async (_authority: Row, _endpoint: Row, stopped: Row) => {
      f.calls.push({ kind: 'retire-http' }); Object.assign(f.entry.profile, { writerState: 'stopped', headManifestHash: codec.manifestHash(stopped.checkpoint.manifest), revision: 1 })
      return { profile: f.entry.profile, transition: { id: stopped.receipt.transitionId, phase: 'checkpoint_committed' } }
    }
    try {
      await f.run(name, {}); assert.equal(f.entry.profile.writerState, 'stopped'); assert.equal(f.record.state, 'closed'); assert.equal(f.record.runtime, null); assert.equal(f.record.engine, null)
      assert.equal(f.calls.filter(row => row.kind === 'retire-http').length, 1); assert.equal(f.calls.filter(row => row.kind === 'native-dispose').length, 1)
      const payload = f.calls.find(row => row.kind === 'completion')!.payload; assert.equal(payload.ok, false); assert.equal(payload.error.code, 'browser_runtime_command_uncertain')
      await assert.rejects(f.companion.receive(f.state.frame, f.connection.socketId), /runtime_unavailable/)
    } finally { epoch.key.fill(0) }
  }
})
