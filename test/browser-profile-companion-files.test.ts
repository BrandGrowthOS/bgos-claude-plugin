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
import { AgentProfileFiles } from '../lib/browser-profile-files.mjs'
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
  const engine: Row = { selectedPage: () => state.selected, roster: () => [{ name: 'browser_click', description: 'Fixture action', inputSchema: { type: 'object', additionalProperties: true } }, { name: 'browser_navigate', description: 'Fixture navigation', inputSchema: { type: 'object', additionalProperties: true } }, ...['browser_file_upload','browser_pdf_save','browser_take_screenshot','browser_snapshot'].map(name => ({ name, description: 'Fixture browser tool', inputSchema: { type: 'object', additionalProperties: true } }))],
    async callTool(name: string, args: Row, signal: AbortSignal) { signal.throwIfAborted(); calls.push({ kind: 'engine', name, args }); if (hooks.engine) return hooks.engine(name, args); return { content: [{ type: 'text', text: 'fixture action ran' }] } },
    async stop() { calls.push({ kind: 'engine-stop' }) }
  }
  const runtime: Row = { authority, state: 'active', network: 'active', assertCurrent() { if (this.state !== 'active') throw Error('fixture runtime inactive'); return authority }, async activate() {}, async newPage() {}, async dispose() { calls.push({ kind: 'native-dispose' }); this.state = 'disposed'; this.network = 'blocked' } }
  const entry = { profile: { ...authority, id: scope.profileId, writerState: 'active', headManifestHash: null }, grant: { generation: 1, backgroundUse: true } }
  const companion: any = new AgentBrowserProfileCompanion({ connection, agentRoot: path.join(os.tmpdir(), 'hoai-permission-fixture'), deviceLabel: 'Fixture', client: { discover: async () => ({ profiles: [entry] }) }, keyStore: {}, stateStore: {}, permissionClient, statusClient: undefined,
    permissionRunner: runner, loadBrowser: async () => ({}), createEngine: async () => engine, createRelay: (core: Row) => options.createRelay ? options.createRelay(core) : new RelaySessions({ core, serverInfo: { name: 'fixture', version: '1' }, instructions: 'Fixture', callCapMs: options.callCapMs || 2000 }) })
  const fileState: Row = { pending: 0, unknown: false }, fileHooks: Row = {}, fileRunner: Row = {
    activity: () => ({ pendingPhysicalOperations: fileState.pending, cleanupUnknown: fileState.unknown }),
    async whenDrained() { calls.push({ kind: 'file-drain' }); if (fileHooks.drain) await fileHooks.drain() },
    async dispose() { calls.push({ kind: 'file-dispose' }); if (fileHooks.dispose) await fileHooks.dispose() },
    async list(input: Row) { calls.push({ kind: 'file-list', input }); input.assertCurrent(); if (fileHooks.list) return fileHooks.list(input); return { content: [{ type: 'text', text: 'opaque file list' }] } },
    async send(input: Row) { calls.push({ kind: 'file-send', input }); input.assertCurrent(); return { content: [{ type: 'text', text: 'one consented offer' }] } },
    async capture(input: Row) { calls.push({ kind: 'file-capture', input }); input.assertCurrent(); return input.execute(input.name, { ...input.args, filename: 'GENERATED_PRIVATE_ARTIFACT_FIXTURE' }) },
    async upload(input: Row) { calls.push({ kind: 'file-upload', input }); if (fileHooks.upload) await fileHooks.upload(input); input.assertCurrent(); return input.authorize((tool: string, original: Row, signal: AbortSignal) => { calls.push({ kind: 'file-consume', original }); input.assertCurrent(); return engine.callTool(tool, { paths: ['GENERATED_PRIVATE_MATERIALIZATION_FIXTURE'] }, signal) }) }
  }; companion.createFiles = (input: Row) => { calls.push({ kind: 'file-create', input }); return fileRunner };
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
  return { companion, record, runtime, engine, page, endpoint, authority, scope, connection, state, calls, hooks, frame, run, runner, permissionClient, entry, handle, fileRunner, fileState, fileHooks }
}

test('the actual signed MCP roster advertises opaque file actions only in the managed runtime', async t => {
  const f = await fixture(t); f.state.frame = f.frame(); f.state.frame.message = { jsonrpc: '2.0', id: randomUUID(), method: 'tools/list' }
  await f.companion.receive(f.state.frame, f.connection.socketId)
  const payload = f.calls.find(row => row.kind === 'completion')!.payload; assert.equal(payload.ok, true)
  const names = payload.message.result.tools.map((tool: Row) => tool.name); assert.ok(names.includes('hoai_browser_files')); assert.ok(names.includes('hoai_browser_send_file')); assert.ok(names.includes('browser_file_upload')); const upload = payload.message.result.tools.find((tool: Row) => tool.name === 'browser_file_upload'); assert.equal(upload.inputSchema.properties.paths.maxItems, 1); assert.match(upload.description, /Host filesystem paths are refused/); assert.equal(f.calls.some(row => row.kind === 'file-create'), false)
})

test('only an original signed request can list or offer files and the lazy runner binds the exact runtime', async t => {
  const f = await fixture(t)
  assert.equal((await f.companion._tool(f.record, 'hoai_browser_files', {}, new AbortController().signal)).isError, true); assert.equal(f.calls.some(row => row.kind === 'file-create'), false)
  await f.run('hoai_browser_files', {}); await f.run('hoai_browser_send_file', { artifactToken: 'hoai-artifact:' + randomUUID() })
  const creation = f.calls.find(row => row.kind === 'file-create')!.input; assert.deepEqual(creation.authority, f.authority); assert.strictEqual(creation.endpoint, f.endpoint); assert.equal(creation.client.principal, 'paired'); assert.ok(creation.directory.includes(path.join('artifacts', f.authority.runtimeId, 'file-exchanges')))
  assert.equal(f.calls.filter(row => row.kind === 'file-create').length, 1); assert.equal(f.calls.filter(row => row.kind === 'file-list').length, 1); assert.equal(f.calls.filter(row => row.kind === 'file-send').length, 1); assert.equal(f.calls.some(row => row.kind === 'request' || row.kind === 'engine'), false)
  const originalScope = f.record.scope; for (const key of ['profileId','actingUserId','assistantId','endpointId','keyFingerprint']) { f.record.scope = { ...originalScope, [key]: key === 'assistantId' ? 43 : 'changed-scope' }; assert.throws(() => creation.assertCurrent()); f.record.scope = originalScope }
  for (const key of ['runtime', 'engine', 'endpoint']) { const original = f.record[key]; f.record[key] = { ...original }; assert.throws(() => creation.assertCurrent()); f.record[key] = original }
  f.runtime.authority = { ...f.authority, writerEpoch: f.authority.writerEpoch + 1 }; assert.throws(() => creation.assertCurrent())
})

test('signed PDF and screenshot reads create owned artifacts without broadening their website permission policy', async t => {
  const f = await fixture(t); await f.run('browser_pdf_save', { filename: 'chosen.pdf' }); await f.run('browser_take_screenshot', {})
  assert.equal(f.calls.filter(row => row.kind === 'file-capture').length, 2); assert.equal(f.calls.filter(row => row.kind === 'engine').length, 2); assert.equal(f.calls.some(row => row.kind === 'request'), false)
  for (const call of f.calls.filter(row => row.kind === 'engine')) assert.equal(call.args.filename, 'GENERATED_PRIVATE_ARTIFACT_FIXTURE')
})

test('the original opaque upload arguments reach native permission and only then the file materialization callback', async t => {
  const f = await fixture(t), args = { paths: ['hoai-file:' + randomUUID()] }; await f.run('browser_file_upload', args)
  const requested = f.calls.find(row => row.kind === 'request'), materialized = f.calls.find(row => row.kind === 'file-consume'); assert.ok(requested, 'the original website permission must be requested'); assert.ok(materialized, 'only the consumed permission may materialize the file')
  assert.deepEqual(requested.input.frame.message.params.arguments, args); assert.deepEqual(materialized.original, args)
  const order = f.calls.filter(row => ['file-upload', 'request', 'consume', 'file-consume', 'engine'].includes(row.kind)).map(row => row.kind); assert.deepEqual(order, ['file-upload', 'request', 'consume', 'file-consume', 'engine'])
  assert.deepEqual(f.calls.find(row => row.kind === 'engine')!.args, { paths: ['GENERATED_PRIVATE_MATERIALIZATION_FIXTURE'] }); assert.equal(f.record.engineTasks.size, 0)
})

test('the managed original request refuses an arbitrary path before native website permission or engine access', async t => {
  const f = await fixture(t); f.companion.createFiles = (input: Row) => new AgentProfileFiles(input as any)
  await f.run('browser_file_upload', { paths: ['/private/agent/path'] }); assert.equal(f.calls.some(row => row.kind === 'request' || row.kind === 'engine'), false); const message = f.calls.find(row => row.kind === 'completion')!.payload.message; assert.ok(message.error || message.result?.isError)
})

test('file work participates in positive activity and native disposal starts before its held operation drains', async t => {
  const f = await fixture(t), gate = deferred<void>(), entered = deferred<void>(); f.fileHooks.list = async (input: Row) => { f.fileState.pending = 1; entered.resolve(); try { await gate.promise; input.assertCurrent() } finally { f.fileState.pending = 0 } }
  const work = f.run('hoai_browser_files', {}); await entered.promise; let disposal: Promise<unknown> | undefined, disposed = false
  try { assert.ok(f.companion.activity().pendingPhysicalOperations >= 2); const withFile = f.companion.activity().pendingPhysicalOperations; f.fileState.pending = 0; assert.equal(f.companion.activity().pendingPhysicalOperations, withFile - 1); f.fileState.pending = 1
    const stopping: Promise<unknown> = f.companion._dispose(f.record); disposal = stopping; void stopping.then(() => { disposed = true }); await tick(); assert.equal(f.calls.some(row => row.kind === 'native-dispose'), true); assert.equal(f.calls.some(row => row.kind === 'file-dispose'), true); assert.equal(disposed, false)
  } finally { gate.resolve(); await work; await disposal }
  assert.equal(f.runtime.state, 'disposed'); assert.equal(f.record.engineTasks.size, 0)
})

test('file cleanup uncertainty retains the private original command even if public activity is forged', async t => {
  const f = await fixture(t); f.fileHooks.drain = async () => { throw Error('synthetic file cleanup unknown') }; await f.run('hoai_browser_files', {})
  assert.equal(f.record.engineTasks.size, 1); assert.equal(f.companion.activity().cleanupUnknown, true); f.record.admission = 'active'; f.fileState.pending = 0; f.fileState.unknown = false
  await assert.rejects(f.companion._tool(f.record, 'browser_snapshot', {}, new AbortController().signal), /authority_unknown/)
  await assert.rejects(f.companion._dispose(f.record), /stop_unconfirmed/); assert.equal(f.calls.some(row => row.kind === 'native-dispose'), true)
})

test('emergency termination starts owned native stop independently of held or synchronously failed file disposal', async t => {
  for (const rejectFileDispose of [false, true]) {
    const f = await fixture(t), gate = deferred<void>(); await f.run('hoai_browser_files', {})
    f.record.processOwned = Promise.resolve(); f.record.processStop = { async stop() { f.calls.push({ kind: 'owned-process-stop' }); return { stopped: true } } }
    f.runtime.emergencyStopOwnedProcess = async () => { f.calls.push({ kind: 'native-emergency-stop' }); f.runtime.state = 'disposed' }
    f.fileRunner.dispose = () => { f.calls.push({ kind: 'file-dispose' }); if (rejectFileDispose) throw Error('synthetic synchronous file disposal failure'); return gate.promise }
    const stopping = f.companion.emergencyTerminate(); void stopping.catch(() => {}); let finished = false; void stopping.then(() => { finished = true }, () => { finished = true })
    try { await tick(); assert.equal(f.calls.some(row => row.kind === 'owned-process-stop'), true); assert.equal(f.calls.some(row => row.kind === 'native-emergency-stop'), true); assert.equal(f.calls.some(row => row.kind === 'file-dispose'), true); assert.equal(f.calls.some(row => row.kind === 'file-drain'), true); if (!rejectFileDispose) assert.equal(finished, false) }
    finally { gate.resolve(); if (rejectFileDispose) await assert.rejects(stopping, /stop_unconfirmed/); else assert.equal((await stopping).stopped, true) }
  }
})
