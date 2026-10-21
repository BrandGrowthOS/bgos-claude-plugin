import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentProfileDownloads } from '../lib/browser-profile-downloads.mjs'
import { createRuntimeDownloadBinding, assertRuntimeDownloadBinding } from '../lib/browser-profile-downloads-runtime.mjs'
import { BrowserProfileRuntime } from '../lib/browser-profile-runtime.mjs'
import { createManagedProfileEngine } from '../bin/hoai-browser-host.mjs'
import { downloadFixture } from './helpers/browser-profile-downloads-fixture.mjs'

test('only an original private manager with the exact runtime authority can create the download binding', async t => {
  const f = await downloadFixture(); t.after(f.cleanup)
  for (const manager of [{ ...f.manager }, Object.create(AgentProfileDownloads.prototype), { authority: f.authority, assertIdle: () => true }]) assert.throws(() => createRuntimeDownloadBinding(manager, f.authority), /binding_required/)
  assert.throws(() => createRuntimeDownloadBinding(f.manager, { ...f.authority, writerEpoch: 2 }), /binding_required/)
  assert.throws(() => assertRuntimeDownloadBinding({}), /binding_required/)
  const binding = createRuntimeDownloadBinding(f.manager, f.authority); assert.equal(assertRuntimeDownloadBinding(binding), binding); assert.equal(Object.isFrozen(binding), true)
})

test('an original launch directory and empty-context binding precede any browser page', async t => {
  const f = await downloadFixture({ unbound: true }); t.after(f.cleanup); f.pages.length = 0
  const binding = createRuntimeDownloadBinding(f.manager, f.authority), launch = await binding.launchOptions(); assert.equal(launch.downloadsPath, f.launch.downloadsPath)
  await binding.bind(f.context, { stop: async () => ({ stopped: true }) }); assert.equal(f.context.listenerCount('download'), 1); assert.equal(f.pages.length, 0)
  await assert.rejects(binding.launchOptions(), /launch_required/); await assert.rejects(binding.bind(f.context, { stop: async () => ({ stopped: true }) }), /binding_required/)
})

test('a forged optional download manager is refused before Chromium can launch', async () => {
  let launches = 0
  const authority = { profileId: randomUUID(), actingUserId: 'recipient', assistantId: 1, endpointId: randomUUID(), keyFingerprint: 'a'.repeat(64), bootId: 'boot', runtimeId: 'runtime', sessionId: 'session', writerEpoch: 1, revision: 0, grantVersion: 1, contentKeyEpoch: 1 }
  await assert.rejects(BrowserProfileRuntime.create({ authority, chromium: { launch: async () => { launches++; throw Error('must not launch') } }, downloads: { authority, launchOptions: async () => ({ downloadsPath: '/arbitrary' }) }, closeAndDrain: async () => ({}), checkpoint: async () => ({}), authorizeActivation: async () => ({}), preflightExtras() {}, captureExtras() {}, commitExtras() {} } as any), /binding_required/)
  assert.equal(launches, 0)
})

test('private binding calls original manager checks even when public activity is forged', async t => {
  const f = await downloadFixture(); t.after(f.cleanup); const binding = createRuntimeDownloadBinding(f.manager, f.authority)
  f.manager.activity = () => ({ pendingPhysicalOperations: 0, cleanupUnknown: false, retainedDownloads: 0 }); f.manager.assertHealthy = () => {}; f.manager.assertCurrent = () => {}; f.state.current = false
  assert.throws(() => binding.assertAvailable(), /context changed/)
  f.state.current = true; const stopping = binding.dispose(); assert.throws(() => binding.assertAvailable(), /unavailable/); assert.throws(() => binding.assertIdle(), /in_flight/); await stopping
})
test('Runtime health permits original startup and graceful closing without authorizing a new native download', async t => {
  const f = await downloadFixture(); t.after(f.cleanup); const binding = createRuntimeDownloadBinding(f.manager, f.authority), context = new EventEmitter()
  const runtime = new BrowserProfileRuntime({ authority: f.authority, context, downloadBinding: binding, preflightExtras() {}, captureExtras() {}, commitExtras() {} }); runtime.state = 'active'; runtime.network = 'active'; runtime.activeProof = () => {}
  f.state.active = false; assert.throws(() => binding.assertAvailable(), /context_changed/); assert.doesNotThrow(() => assert.equal(runtime.assertCurrent(), runtime.authority)); assert.doesNotThrow(() => binding.assertIdle())
  f.state.current = false; assert.throws(() => runtime.assertCurrent(), /context changed/)
})

test('the Runtime refuses transfer before inspecting a page while an actual download is pending', async t => {
  const f = await downloadFixture(); t.after(f.cleanup); const binding = createRuntimeDownloadBinding(f.manager, f.authority), context = new EventEmitter() as any; context.pages = () => { throw Error('must not inspect or activate a URL') }
  const runtime = new BrowserProfileRuntime({ authority: f.authority, context, downloadBinding: binding, preflightExtras() {}, captureExtras() {}, commitExtras() {} }); runtime.state = 'active'; runtime.network = 'active'; runtime.activeProof = () => {}
  assert.equal(runtime.assertCurrent(), runtime.authority); const item = await f.download(); f.context.emit('download', item.value)
  try { for (const work of [() => runtime.assertMovable(), () => runtime.preflightResumeTabs(), () => runtime._assertDocumentSafety(), () => runtime.finalize({ context: undefined, source: undefined, destinationIdentity: undefined, contentKeyEpoch: undefined })]) await assert.rejects(work(), /in_flight/) }
  finally { await item.value.cancel(); await binding.whenDrained() }
  assert.throws(() => { (runtime as any).downloadBinding = null }, TypeError)
})

test('the actual shipped managed Engine factory installs the quarantine callback before starting', async t => {
  const f = await downloadFixture(); t.after(f.cleanup); const context = new EventEmitter() as any, browser = new EventEmitter(), calls: any[] = []; context.pages = () => []; context.browser = () => browser
  const engine = await createManagedProfileEngine({ runtime: { browser, context, assertCurrent() {} }, directory: path.join(f.root, 'engine'), onDownload: (download: unknown) => calls.push(download) }); t.after(() => engine.stop())
  let cancelled = 0; const download = { cancel: async () => { cancelled++ }, delete: async () => {} }; context.emit('download', download); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [download]); assert.equal(cancelled, 0); assert.equal(context.pages().length, 0); assert.equal((await fs.stat(path.join(f.root, 'engine'))).isDirectory(), true)
})
