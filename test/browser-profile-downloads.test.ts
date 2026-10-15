import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { downloadFixture, downloadArtifacts, deferred } from './helpers/browser-profile-downloads-fixture.mjs'
import { completedDownloadMetadata, retainCompletedDownloadInventory, writeCompletedDownload } from '../lib/browser-profile-downloads.mjs'
import { artifactInventoryScope, releaseArtifactInventory, reserveArtifactInventory } from '../lib/browser-profile-artifact-inventory.mjs'
test('launch and original context binding are each claimed before a held private-directory await', async t => {
  const f = await downloadFixture({ unbound: true }); t.after(f.cleanup); let entered = deferred(), held = deferred(); f.state.beforeLstat = async (file: string) => { if (file === f.launch.downloadsPath) { entered.resolve(); await held.promise } }
  const launch = f.manager.launchOptions(); await entered.promise
  let rejected = false; const duplicateLaunch = f.manager.launchOptions().catch((error: Error) => { assert.match(error.message, /launch_required/); rejected = true })
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(rejected, true) } finally { held.resolve(); await Promise.allSettled([launch, duplicateLaunch]) }
  entered = deferred(); held = deferred(); f.pages.length = 0
  const binding = f.manager.bind({ context: f.context, stopBrowser: async () => true }); await entered.promise
  rejected = false; const duplicateBinding = f.manager.bind({ context: f.context, stopBrowser: async () => true }).catch((error: Error) => { assert.match(error.message, /binding_required/); rejected = true })
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(rejected, true) } finally { held.resolve(); await Promise.allSettled([binding, duplicateBinding]) }
  assert.equal(f.context.listenerCount('download'), 1)
})
test('only a completed exact-context download becomes an opaque one-use source', async t => {
  const f = await downloadFixture(); t.after(f.cleanup); const item = await f.download(); f.context.emit('download', item.value); f.manager.onDownload(item.value)
  assert.throws(() => f.manager.assertIdle(), /in_flight/); item.failure.resolve(null); await f.manager.whenDrained()
  const [ready] = f.manager.completed(); assert.equal(ready.fileName, 'report.txt'); assert.equal(Object.hasOwn(ready, 'path'), false); assert.equal(Object.hasOwn(ready.receipt, 'file'), false); assert.throws(() => completedDownloadMetadata({}), /receipt_required/)
  const inventory = retainCompletedDownloadInventory(ready.receipt, artifactInventoryScope(f.authority)), output = path.join(f.root, 'generated-artifact.txt')
  try { await writeCompletedDownload(ready.receipt, { destination: output, assertCurrent: () => true }); assert.equal((await fs.readFile(output)).toString(), 'synthetic completed download'); await assert.rejects(fs.lstat(item.file), { code: 'ENOENT' }); assert.throws(() => completedDownloadMetadata(ready.receipt), /receipt_required/); assert.equal(f.state.deleteCalls, 1); assert.equal(f.manager.completed().length, 0) }
  finally { await fs.unlink(output).catch(() => {}); releaseArtifactInventory(inventory) }
  await f.manager.whenDrained(); assert.equal(f.manager.activity().pendingPhysicalOperations, 0); assert.equal(f.manager.activity().cleanupUnknown, false)
})
test('a private download reservation shares the exact runtime four-file bound with artifacts', async t => {
  const f = await downloadFixture(); t.after(f.cleanup); const item = await f.download({ autoFinish: true }); f.context.emit('download', item.value); await f.manager.whenDrained(); const scope = artifactInventoryScope(f.authority), reserved: object[] = []
  try { for (let index = 0; index < 3; index++) reserved.push(reserveArtifactInventory(scope)); assert.throws(() => reserveArtifactInventory(scope), /capacity/); assert.equal(f.manager.completed().length, 1) }
  finally { for (const receipt of reserved) releaseArtifactInventory(receipt) }
})
test('private conversion preserves one shared slot and creates only an owned one-use artifact', async t => {
  const f = await downloadFixture(), a = await downloadArtifacts(f); t.after(async () => { await a.cleanup(); await f.cleanup() }); const item = await f.download({ autoFinish: true }); f.context.emit('download', item.value); await f.manager.whenDrained(); const [ready] = f.manager.completed()
  await a.artifacts.captureDownload({ receipt: ready.receipt, assertCurrent: () => true }); const [saved] = a.artifacts.downloads({ assertCurrent: () => true }); assert.match(saved.artifactToken, /^hoai-artifact:/); assert.equal(saved.fileName, 'report.txt'); assert.equal(Object.hasOwn(saved, 'path'), false); assert.equal(f.manager.completed().length, 0)
  const reserved: object[] = []; try { for (let index = 0; index < 3; index++) reserved.push(reserveArtifactInventory(artifactInventoryScope(f.authority))); assert.throws(() => reserveArtifactInventory(artifactInventoryScope(f.authority)), /capacity/) } finally { for (const receipt of reserved) releaseArtifactInventory(receipt) }
  let borrowed: Buffer | undefined
  await a.artifacts.consume(saved.artifactToken, { assertCurrent: () => true, use: async (bytes: Buffer, name: string) => { borrowed = bytes; assert.equal(bytes.toString(), 'synthetic completed download'); assert.equal(name, 'report.txt') } }); assert.ok(borrowed); assert.ok(borrowed.every(byte => byte === 0)); assert.deepEqual(a.artifacts.downloads({ assertCurrent: () => true }), [])
})
test('a full four-download inventory converts by retaining its existing slots rather than allocating new ones', async t => {
  const f = await downloadFixture(), a = await downloadArtifacts(f); t.after(async () => { await a.cleanup(); await f.cleanup() })
  for (let index = 0; index < 4; index++) { const item = await f.download({ autoFinish: true, fileName: 'download-' + index + '.txt' }); f.context.emit('download', item.value); await f.manager.whenDrained() }
  assert.equal(f.manager.completed().length, 4)
  for (const row of f.manager.completed()) await assert.doesNotReject(a.artifacts.captureDownload({ receipt: row.receipt, assertCurrent: () => true }))
  assert.equal(f.manager.completed().length, 0); assert.equal(a.artifacts.downloads({ assertCurrent: () => true }).length, 4); assert.throws(() => reserveArtifactInventory(artifactInventoryScope(f.authority)), /capacity/)
})
test('a finite wall timer cancels an unknown-length download even when the observed clock is frozen', async t => {
  const f = await downloadFixture({ deadlineMs: 20, observationMs: 3, now: () => 0 }); t.after(f.cleanup); const item = await f.download(); f.context.emit('download', item.value)
  await f.manager.whenDrained(); assert.equal(f.state.cancelCalls, 1); assert.equal(f.state.deleteCalls, 1); assert.equal(f.manager.completed().length, 0); assert.equal(f.state.stopCalls, 0); await assert.rejects(fs.lstat(item.file), { code: 'ENOENT' })
})
test('the wall deadline remains effective while the first filesystem observation is held', async t => {
  const f = await downloadFixture({ deadlineMs: 20, observationMs: 3, now: () => 0 }); t.after(f.cleanup); const item = await f.download(), entered = deferred(), held = deferred(); f.state.beforeLstat = async (file: string) => { if (file === item.file) { entered.resolve(); await held.promise } }; f.context.emit('download', item.value); await entered.promise
  const finished = f.manager.whenDrained()
  try { await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(f.state.cancelCalls, 1) }
  finally { held.resolve(); await finished }
})
test('an overflow is never published and its owned oversized file is deleted', async t => {
  const f = await downloadFixture(); t.after(f.cleanup); const item = await f.download({ bytes: Buffer.alloc(25 * 1024 * 1024 + 1) }); f.context.emit('download', item.value); await f.manager.whenDrained()
  assert.equal(f.state.cancelCalls, 1); assert.equal(f.state.deleteCalls, 1); assert.equal(f.manager.completed().length, 0); assert.equal(f.manager.activity().cleanupUnknown, false); await assert.rejects(fs.lstat(item.file), { code: 'ENOENT' })
})
test('observed oversized bytes cancel before an unfinished browser reports completion', async t => {
  const f = await downloadFixture({ deadlineMs: 1000, observationMs: 2 }); t.after(f.cleanup); const item = await f.download({ bytes: Buffer.alloc(25 * 1024 * 1024 + 1) }); f.context.emit('download', item.value)
  try { const end = Date.now() + 200; while (!f.state.cancelCalls && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 2)); assert.equal(f.state.cancelCalls, 1) }
  finally { item.failure.resolve('fixture completion'); await f.manager.whenDrained() }
})
test('a held filesystem observation remains physically counted after native download completion', async t => {
  const f = await downloadFixture(); t.after(f.cleanup); const item = await f.download(), entered = deferred(), held = deferred(); let drained = false
  f.state.beforeLstat = async (file: string) => { if (file === item.file) { entered.resolve(); await held.promise } }; f.context.emit('download', item.value); await entered.promise; item.failure.resolve(null)
  const finished = f.manager.whenDrained().then(() => { drained = true }); await new Promise(resolve => setImmediate(resolve))
  try { assert.equal(drained, false); assert.ok(f.manager.activity().pendingPhysicalOperations > 0); assert.throws(() => f.manager.assertIdle(), /in_flight/) }
  finally { held.resolve(); await finished }
})
test('context loss during final private-file verification cannot publish a download', async t => {
  const f = await downloadFixture(); t.after(f.cleanup); const item = await f.download({ autoFinish: true }); f.state.beforeChmod = async () => { f.state.current = false }; f.context.emit('download', item.value); await f.manager.whenDrained()
  assert.equal(f.state.deleteCalls, 1); assert.equal(f.manager.activity().retainedDownloads, 0); assert.throws(() => f.manager.completed(), /context changed/)
})
test('native disposal starts owned browser stop independently of a held download cancellation', async t => {
  const f = await downloadFixture(); t.after(f.cleanup); const item = await f.download(), entered = deferred(), held = deferred(); f.state.beforeCancel = async () => { entered.resolve(); await held.promise }; f.context.emit('download', item.value)
  const stopping = f.manager.dispose(); await entered.promise
  try { assert.equal(f.state.stopCalls, 1); assert.ok(f.manager.activity().pendingPhysicalOperations > 0) }
  finally { held.resolve(); await stopping }
  assert.equal(f.context.listenerCount('download'), 0)
})
test('a native failure acknowledgement cannot release a still-pending cancellation', async t => {
  const f = await downloadFixture({ deadlineMs: 10 }), item = await f.download(), entered = deferred(), held = deferred(); t.after(f.cleanup); let drained = false
  f.state.beforeCancel = async () => { entered.resolve(); await held.promise }; f.context.emit('download', item.value); await entered.promise
  item.failure.resolve('native cancellation acknowledgement'); const drain = f.manager.whenDrained().then(() => { drained = true })
  try { await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(drained, false); assert.equal(f.state.deleteCalls, 0); assert.equal(f.manager.activity().retainedDownloads, 1); assert.ok(f.manager.activity().pendingPhysicalOperations > 0) }
  finally { held.resolve(); await drain }
})
test('disposal retains the exact open copy before raw deletion and accepts its physically clean revocation', async t => {
  const f = await downloadFixture(), a = await downloadArtifacts(f); t.after(async () => { await a.cleanup(); await f.cleanup() }); const item = await f.download({ autoFinish: true }); f.context.emit('download', item.value); await f.manager.whenDrained(); const [ready] = f.manager.completed(), entered = deferred(), held = deferred(); f.state.beforeRead = async () => { entered.resolve(); await held.promise }
  const copying = a.artifacts.captureDownload({ receipt: ready.receipt, assertCurrent: () => true }), refusal = assert.rejects(copying, /unavailable/); await entered.promise; let disposed = false, cleanupChecks = 0; const verify = f.manager.verifyDirectory.bind(f.manager); f.manager.verifyDirectory = async () => { cleanupChecks++; return verify() }; const stopping = f.manager.dispose().then(() => { disposed = true })
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(disposed, false); assert.equal(cleanupChecks, 0); assert.equal(f.state.deleteCalls, 0); assert.ok(f.manager.activity().pendingPhysicalOperations > 0) }
  finally { held.resolve(); await refusal; await stopping }
  await assert.rejects(fs.lstat(item.file), { code: 'ENOENT' }); assert.equal(f.manager.activity().cleanupUnknown, false)
})
test('loss of the original download context during a held copy cannot write or publish the artifact', async t => {
  const f = await downloadFixture(), a = await downloadArtifacts(f); t.after(async () => { await a.cleanup(); await f.cleanup() }); const item = await f.download({ autoFinish: true }); f.context.emit('download', item.value); await f.manager.whenDrained(); const [ready] = f.manager.completed(), entered = deferred(), held = deferred(); f.state.beforeRead = async () => { entered.resolve(); await held.promise }
  const copying = a.artifacts.captureDownload({ receipt: ready.receipt, assertCurrent: () => true }), refused = assert.rejects(copying, /context changed/); await entered.promise; f.state.current = false
  held.resolve(); await refused; assert.deepEqual(a.artifacts.downloads({ assertCurrent: () => true }), []); assert.equal(f.manager.activity().cleanupUnknown, false)
})
test('foreign, inactive, forged paths and failed cleanup never confer an artifact in isolated processes', () => {
  const helper = new URL('./helpers/browser-profile-downloads-fixture.mjs', import.meta.url).href
  for (const scenario of ['inactive', 'foreign', 'page', 'path', 'cleanup']) {
    const code = `import assert from 'node:assert/strict';import path from 'node:path';import {downloadFixture} from ${JSON.stringify(helper)};const f=await downloadFixture();try{const row=await f.download({autoFinish:true});${scenario === 'inactive' ? 'f.state.active=false;' : scenario === 'foreign' ? 'f.page.context=()=>({});' : scenario === 'page' ? 'const otherPage={context:()=>f.context};row.value.page=()=>otherPage;' : scenario === 'path' ? "row.value._artifact._initializer.absolutePath=path.join(f.root,path.basename(row.file));" : "f.state.beforeDelete=async()=>{throw Error('injected cleanup failure')};"}f.context.emit('download',row.value);${scenario === 'cleanup' ? 'await f.manager.whenDrained();await assert.rejects(f.manager.dispose(),/cleanup_unconfirmed/);' : ''}await assert.rejects(f.manager.whenDrained(),/cleanup_unconfirmed/);assert.equal(f.manager.activity().cleanupUnknown,true);assert.throws(()=>f.manager.completed());${scenario !== 'cleanup' ? 'assert.equal(f.state.stopCalls,1);' : 'assert.equal(f.manager.activity().retainedDownloads,1);'} }finally{await f.cleanup()}`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000, windowsHide: true }); assert.equal(result.status, 0, scenario + '\n' + result.stderr + result.stdout)
  }
})
test('a concurrent second download cannot borrow the one receiving slot of its runtime', () => {
  const helper = new URL('./helpers/browser-profile-downloads-fixture.mjs', import.meta.url).href
  const code = `import assert from 'node:assert/strict';import{downloadFixture}from ${JSON.stringify(helper)};const f=await downloadFixture();try{const first=await f.download({autoFinish:true}),second=await f.download({autoFinish:true});f.context.emit('download',first.value);f.context.emit('download',second.value);await assert.rejects(f.manager.whenDrained(),/cleanup_unconfirmed/);assert.equal(f.state.stopCalls,1);assert.equal(f.manager.activity().retainedDownloads,1);assert.throws(()=>f.manager.completed());}finally{await f.cleanup()}`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000, windowsHide: true }); assert.equal(result.status, 0, result.stderr + result.stdout)
})
test('a fifth runtime cannot borrow the four process-wide receiving slots', () => {
  const helper = new URL('./helpers/browser-profile-downloads-fixture.mjs', import.meta.url).href
  const code = `import assert from 'node:assert/strict';import{downloadFixture}from ${JSON.stringify(helper)};const fixtures=[];try{for(let index=0;index<5;index++){const f=await downloadFixture();fixtures.push(f);const row=await f.download({autoFinish:index===4});f.context.emit('download',row.value);}const last=fixtures[4];await assert.rejects(last.manager.whenDrained(),/cleanup_unconfirmed/);assert.equal(last.state.stopCalls,1);assert.equal(last.manager.activity().retainedDownloads,0);}finally{await Promise.all(fixtures.map(f=>f.cleanup()))}`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000, windowsHide: true }); assert.equal(result.status, 0, result.stderr + result.stdout)
})
test('source or destination cleanup uncertainty keeps the shared artifact reservation in isolated processes', () => {
  const helper = new URL('./helpers/browser-profile-downloads-fixture.mjs', import.meta.url).href, inventory = new URL('../lib/browser-profile-artifact-inventory.mjs', import.meta.url).href
  for (const side of ['source', 'destination']) {
    const code = `import assert from 'node:assert/strict';import *as fs from 'node:fs/promises';import{downloadFixture,downloadArtifacts}from ${JSON.stringify(helper)};import{artifactInventoryScope,reserveArtifactInventory,releaseArtifactInventory}from ${JSON.stringify(inventory)};const f=await downloadFixture(),a=await downloadArtifacts(f),reserved=[];try{const row=await f.download({autoFinish:true});f.context.emit('download',row.value);await f.manager.whenDrained();const[ready]=f.manager.completed();${side === 'source' ? "f.state.beforeDelete=async()=>{throw Error('source delete failed')};await assert.rejects(a.artifacts.captureDownload({receipt:ready.receipt,assertCurrent:()=>true}),/cleanup_unconfirmed/);await assert.rejects(f.manager.whenDrained(),/cleanup_unconfirmed/);" : "await a.artifacts.captureDownload({receipt:ready.receipt,assertCurrent:()=>true});const[saved]=a.artifacts.downloads({assertCurrent:()=>true});a.artifacts.fs={...fs,unlink:async()=>{throw Error('destination unlink failed')}};await assert.rejects(a.artifacts.consume(saved.artifactToken,{assertCurrent:()=>true,use:async()=>{}}),/cleanup_unconfirmed/);"}for(let index=0;index<3;index++)reserved.push(reserveArtifactInventory(artifactInventoryScope(f.authority)));assert.throws(()=>reserveArtifactInventory(artifactInventoryScope(f.authority)),/capacity/);}finally{for(const receipt of reserved)releaseArtifactInventory(receipt);await a.cleanup();await f.cleanup()}`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000, windowsHide: true }); assert.equal(result.status, 0, side + '\n' + result.stderr + result.stdout)
  }
})
test('a cleanup failure starts owned stop and a drain cannot outrun that newly spawned physical promise', () => {
  const helper = new URL('./helpers/browser-profile-downloads-fixture.mjs', import.meta.url).href
  const code = `import assert from 'node:assert/strict';import{downloadFixture,deferred}from ${JSON.stringify(helper)};const f=await downloadFixture(),deleting=deferred(),allowDelete=deferred(),entered=deferred(),held=deferred();let settled=false;try{const row=await f.download({autoFinish:true});f.context.emit('download',row.value);await f.manager.whenDrained();f.state.beforeDelete=async()=>{deleting.resolve();await allowDelete.promise;throw Error('delete failed')};f.state.stop=async()=>{entered.resolve();await held.promise;return true};const original=f.manager.dispose(),stopping=original.catch(()=>{});assert.equal(f.manager.dispose(),original);await deleting.promise;const drain=f.manager.whenDrained().then(()=>{settled=true},error=>{assert.match(error.message,/cleanup_unconfirmed/);settled=true});try{await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.ok(f.manager.activity().pendingPhysicalOperations>0);allowDelete.resolve();await Promise.race([entered.promise,new Promise(resolve=>setTimeout(resolve,100))]);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.state.stopCalls,1);assert.equal(settled,false);}finally{allowDelete.resolve();held.resolve();await Promise.all([stopping,drain]);}assert.equal(settled,true);}finally{allowDelete.resolve();held.resolve();await f.cleanup()}`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000, windowsHide: true }); assert.equal(result.status, 0, result.stderr + result.stdout)
})
test('an uncertain final quarantine removal retains disposal until the independently owned stop settles', () => {
  const helper = new URL('./helpers/browser-profile-downloads-fixture.mjs', import.meta.url).href
  const code = `import assert from 'node:assert/strict';import{downloadFixture,deferred}from ${JSON.stringify(helper)};const f=await downloadFixture(),entered=deferred(),held=deferred();let settled=false;try{f.manager.fs={...f.manager.fs,rmdir:async()=>{throw Error('directory removal failed')}};f.state.stop=async()=>{entered.resolve();await held.promise;return true};const stopping=f.manager.dispose().then(()=>{settled=true},error=>{assert.match(error.message,/cleanup_unconfirmed/);settled=true});try{await Promise.race([entered.promise,new Promise(resolve=>setTimeout(resolve,100))]);assert.equal(f.state.stopCalls,1);assert.equal(settled,false);assert.throws(()=>f.manager.assertIdle(),/in_flight/);assert.ok(f.manager.activity().pendingPhysicalOperations>0);}finally{held.resolve();await stopping;}await assert.rejects(f.manager.whenDrained(),/cleanup_unconfirmed/);}finally{held.resolve();await f.cleanup()}`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000, windowsHide: true }); assert.equal(result.status, 0, result.stderr + result.stdout)
})
test('an acknowledged stream still escalates an unsettled cancellation and drains both original promises', () => {
  const helper = new URL('./helpers/browser-profile-downloads-fixture.mjs', import.meta.url).href
  const code = `import assert from 'node:assert/strict';import{downloadFixture,deferred}from ${JSON.stringify(helper)};const f=await downloadFixture({deadlineMs:5,cancellationGraceMs:10}),cancelEntered=deferred(),cancelHeld=deferred(),stopEntered=deferred(),stopHeld=deferred();let settled=false;try{const row=await f.download();f.state.beforeCancel=async()=>{cancelEntered.resolve();await cancelHeld.promise};f.state.stop=async()=>{stopEntered.resolve();await stopHeld.promise;return true};f.context.emit('download',row.value);await Promise.race([cancelEntered.promise,new Promise(resolve=>setTimeout(resolve,100))]);assert.equal(f.state.cancelCalls,1);row.failure.resolve('native acknowledged stream end');const drain=f.manager.whenDrained().then(()=>{settled=true},error=>{assert.match(error.message,/cleanup_unconfirmed/);settled=true});try{await Promise.race([stopEntered.promise,new Promise(resolve=>setTimeout(resolve,100))]);assert.equal(f.state.stopCalls,1);assert.equal(settled,false);cancelHeld.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.ok(f.manager.activity().pendingPhysicalOperations>0);}finally{cancelHeld.resolve();stopHeld.resolve();await drain;}assert.equal(f.manager.activity().cleanupUnknown,true);}finally{cancelHeld.resolve();stopHeld.resolve();await f.cleanup()}`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000, windowsHide: true }); assert.equal(result.status, 0, result.stderr + result.stdout)
})
