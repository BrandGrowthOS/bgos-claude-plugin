import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentBrowserProfileCompanion } from '../lib/browser-profile-companion.mjs'
import { downloadFixture, deferred } from './helpers/browser-profile-downloads-fixture.mjs'
const require = createRequire(import.meta.url), codec = require('../lib/browser-profile-core/crypto.js')
type Row = Record<string, any>
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

async function fixture(t: { after: (callback: () => unknown) => void }, { available = true, holdCreation = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hoai-download-hooks-')), endpoint = codec.createEndpointIdentity(randomUUID()), calls: Row[] = [], hooks: Row = {}, logs: string[] = []
  const scope = { profileId: randomUUID(), actingUserId: 'recipient', assistantId: 42, endpointId: endpoint.identity.endpointId, keyFingerprint: codec.identityFingerprint(endpoint.identity), pairingId: 7, ownerUserId: 'sharer' }
  const connection: Row = { bootId: randomUUID(), _stopped: false, pairing: { token: 'synthetic', backendUrl: 'https://hoai.test', pairingId: 7, ownerUserId: 'sharer', assistantIds: [42] }, socketId: 'socket-a', socket: { connected: true } }
  const authority = { ...Object.fromEntries(['profileId', 'actingUserId', 'assistantId', 'endpointId', 'keyFingerprint'].map(key => [key, scope[key as keyof typeof scope]])), bootId: connection.bootId, runtimeId: randomUUID(), sessionId: randomUUID(), writerEpoch: 1, revision: 0, contentKeyEpoch: 1, grantVersion: 1 }
  const entered = deferred(), creation = deferred(), entry = { profile: { id: scope.profileId, ...authority, writerState: 'active', headManifestHash: null }, grant: { generation: 1, backgroundUse: true } }; let d: Awaited<ReturnType<typeof downloadFixture>> | null = null
  let options: Row = {}, engineOptions: Row = {}, runtime: Row = {}, fileOptions: Row = {}
  const idle = () => ({ pendingPhysicalOperations: 0, cleanupUnknown: false }), client: Row = { activity: idle, discover: async () => ({ profiles: [entry] }) }
  const companion: any = new AgentBrowserProfileCompanion({ connection, agentRoot: directory, deviceLabel: 'Synthetic hooks', client, keyStore: {}, stateStore: {}, log: (line: string) => logs.push(line),
    createDownloads: async (input: Row) => { calls.push({ kind: 'downloads-create', input }); d = await downloadFixture({ authority, assertCurrent: input.assertCurrent, isActive: input.isActive }); entered.resolve(); if (holdCreation) await creation.promise; return available ? d.manager : null },
    preloadExtras: async () => ({ preflightExtras() {}, captureExtras() {}, commitExtras() {}, dispose() {} }) as any,
    loadBrowser: async () => { calls.push({ kind: 'load-browser' }); return {} },
    createRuntime: async (input: Row) => { options = input; calls.push({ kind: 'runtime-create', input }); runtime = { authority, state: 'new', network: 'blocked', assertCurrent() { if (this.state !== 'active') throw Error('inactive') }, async activate() { await input.authorizeActivation(); this.state = 'active'; this.network = 'active' }, async newPage() {}, async dispose() { calls.push({ kind: 'native-dispose' }); this.state = 'disposed'; if (hooks.native) await hooks.native() } }; return runtime },
    createEngine: async (input: Row) => { engineOptions = input; calls.push({ kind: 'engine-create', input }); return { roster: () => [], selectedPage: () => d?.page, stop: async () => {} } },
    createFiles: (input: Row) => { fileOptions = input; return { activity: idle, whenDrained: async () => {}, dispose: async () => {} } },
    createRelay: () => ({ relay: async () => ({}), close() {} }) } as any)
  const record: Row = { scope, identity: endpoint.identity, endpoint, runtime: null, admission: 'blocked', revoked: false, uncertain: false, engineTasks: new Set(), attempted: new Set() }; companion.records.set(scope.endpointId, record); companion._prove = async () => {}
  t.after(async () => { creation.resolve(); await companion._dispose(record).catch(() => {}); await d?.cleanup(); await fs.rm(directory, { recursive: true, force: true }) })
  return { companion, record, authority, scope, connection, calls, get d() { assert.ok(d); return d }, logs, hooks, entered, creation, get options() { return options }, get engineOptions() { return engineOptions }, get runtime() { return runtime }, get fileOptions() { return fileOptions } }
}

test('the exact prepared private manager reaches Runtime, original Engine callback and lazy file conversion', async t => {
  const f = await fixture(t); await f.companion._prepare(f.record, f.authority)
  assert.deepEqual(f.calls.map(row => row.kind), ['downloads-create', 'load-browser', 'runtime-create']); const prepared = f.calls[0].input; assert.deepEqual(prepared.authority, f.authority); assert.equal(prepared.authority.actingUserId, 'recipient'); assert.equal(prepared.directory.includes('sharer'), false); assert.equal(prepared.isActive(), false); assert.equal(f.options.downloads, f.d.manager)
  await f.companion._activate(f.record, f.authority); assert.equal(prepared.isActive(), true); assert.equal(typeof f.engineOptions.onDownload, 'function'); f.companion._fileRunner(f.record); assert.equal(f.fileOptions.downloads, f.d.manager)
  const item = await f.d.download({ autoFinish: true }); f.engineOptions.onDownload(item.value); await f.d.manager.whenDrained(); assert.equal(f.d.manager.completed().length, 1)
  const original = f.record.runtime; f.record.runtime = { ...original }; assert.throws(() => f.engineOptions.onDownload(item.value), /context_changed/); assert.throws(prepared.assertCurrent, /context_changed/); f.record.runtime = original
})

test('an unqualified agent platform keeps managed downloads absent and visibly unavailable', async t => {
  const f = await fixture(t, { available: false }); await f.companion._prepare(f.record, f.authority); assert.equal(Object.hasOwn(f.options, 'downloads'), false); assert.ok(f.logs.some(line => line.includes('managed_downloads_unavailable')))
  await f.companion._activate(f.record, f.authority); assert.equal(Object.hasOwn(f.engineOptions, 'onDownload'), false); f.companion._fileRunner(f.record); assert.equal(f.fileOptions.downloads, undefined)
})
test('suspension, unknown authority, disconnect and closing cannot borrow a live native browser to accept downloads', async t => {
  for (const mode of ['blocked', 'uncertain', 'disconnect', 'socket-only', 'closing', 'before-admission']) {
    const f = await fixture(t); await f.companion._prepare(f.record, f.authority)
    if (mode === 'before-admission') { f.runtime.state = 'active'; f.runtime.network = 'active' } else await f.companion._activate(f.record, f.authority)
    if (mode === 'blocked') f.record.admission = 'blocked'
    if (mode === 'uncertain') f.record.uncertain = true
    if (mode === 'disconnect') { f.connection.socket.connected = false; f.companion.disconnected() }
    if (mode === 'socket-only') f.connection.socket.connected = false
    if (mode === 'closing') f.companion.closing = true
    const item = await f.d.download({ autoFinish: true }); f.d.context.emit('download', item.value); await assert.rejects(f.d.manager.whenDrained(), /cleanup_unconfirmed/)
    assert.equal(f.d.state.stopCalls, 1, mode); assert.equal(f.d.manager.activity().retainedDownloads, 0, mode); assert.throws(() => f.d.manager.completed(), /unavailable/)
  }
})

test('account loss during manager creation retains creation and disposes the exact late private manager', async t => {
  const f = await fixture(t, { holdCreation: true }), preparing = f.companion._prepare(f.record, f.authority), refused = assert.rejects(preparing, /context_changed/); await f.entered.promise; f.connection.pairing.token = 'replaced'; let stopped = false
  const stopping = f.companion._dispose(f.record).then(() => { stopped = true })
  try { await tick(); assert.equal(stopped, false); assert.ok(f.companion.activity().pendingPhysicalOperations > 0); assert.equal(f.calls.some(row => row.kind === 'runtime-create'), false) }
  finally { f.creation.resolve(); await refused; await stopping }
  assert.throws(() => f.d.manager.completed(), /unavailable/); assert.equal(f.calls.some(row => row.kind === 'load-browser'), false)
})

test('a held native download is included in positive activity and blocks a move before closing command admission', async t => {
  const f = await fixture(t); await f.companion._prepare(f.record, f.authority); await f.companion._activate(f.record, f.authority); const item = await f.d.download(); f.engineOptions.onDownload(item.value)
  try { assert.ok(f.companion.activity().pendingPhysicalOperations > 0); await assert.rejects(f.options.closeAndDrain(), /in_flight/); assert.equal(f.record.admission, 'active') }
  finally { item.failure.resolve('fixture cancellation'); await f.d.manager.whenDrained() }
})

test('ordinary disposal starts the native stop independently while original raw deletion is held', async t => {
  const f = await fixture(t); await f.companion._prepare(f.record, f.authority); await f.companion._activate(f.record, f.authority); const item = await f.d.download({ autoFinish: true }); f.engineOptions.onDownload(item.value); await f.d.manager.whenDrained(); const entered = deferred(), held = deferred(); f.d.state.beforeDelete = async () => { entered.resolve(); await held.promise }; let stopped = false
  const stopping = f.companion._dispose(f.record).then(() => { stopped = true })
  try { await Promise.race([entered.promise, new Promise(resolve => setTimeout(resolve, 100))]); assert.equal(f.d.state.deleteCalls, 1); assert.equal(f.calls.some(row => row.kind === 'native-dispose'), true); assert.equal(stopped, false); assert.ok(f.companion.activity().pendingPhysicalOperations > 0) }
  finally { held.resolve(); await stopping }
})

test('unknown native download cleanup fences commands even when public activity is forged', async t => {
  const f = await fixture(t); await f.companion._prepare(f.record, f.authority); await f.companion._activate(f.record, f.authority); f.d.context.emit('download', {}); await assert.rejects(f.d.manager.whenDrained(), /cleanup_unconfirmed/)
  f.d.manager.activity = () => ({ pendingPhysicalOperations: 0, cleanupUnknown: false, retainedDownloads: 0 }); f.record.admission = 'active'
  assert.equal(f.companion.activity().cleanupUnknown, true); assert.throws(() => f.companion._admit(f.record), /unavailable/); await assert.rejects(f.companion._drainCommands(f.record), /drain_unconfirmed/); await assert.rejects(f.companion._dispose(f.record), /stop_unconfirmed/); assert.equal(f.calls.some(row => row.kind === 'native-dispose'), true)
})

test('explicit emergency termination starts owned native stop before a held quarantine cleanup', async t => {
  const f = await fixture(t); await f.companion._prepare(f.record, f.authority); await f.companion._activate(f.record, f.authority); const item = await f.d.download({ autoFinish: true }); f.engineOptions.onDownload(item.value); await f.d.manager.whenDrained(); const entered = deferred(), held = deferred(); f.d.state.beforeDelete = async () => { entered.resolve(); await held.promise }; let owned = 0, stopped = false
  f.record.processOwned = Promise.resolve(); f.record.processStop = { stop: async () => { owned++; return { stopped: true } } }; f.runtime.emergencyStopOwnedProcess = async () => { f.runtime.state = 'disposed'; return { stopped: true } }
  const stopping = f.companion.emergencyTerminate().then(() => { stopped = true })
  try { await Promise.race([entered.promise, new Promise(resolve => setTimeout(resolve, 100))]); assert.equal(f.d.state.deleteCalls, 1); assert.equal(owned, 1); assert.equal(stopped, false); assert.ok(f.companion.activity().pendingPhysicalOperations > 0) }
  finally { held.resolve(); await stopping }
})
