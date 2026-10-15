import { createRequire } from 'node:module'
import http from 'node:http'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, mkdtempSync, openSync, writeSync, fsyncSync, closeSync, renameSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserProfileRuntime, profileCrypto as sync } from '../lib/browser-profile-runtime.mjs'
import { ensureBrowser } from '../lib/browser-bootstrap.mjs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
const require = createRequire(import.meta.url), { chromium } = require(process.env.HOAI_PROBE_PLAYWRIGHT)
const nativeRtcFactory=process.env.HOAI_PROBE_NATIVE_RTC==='1'?(await import('../lib/browser-profile-rtc-activity.mjs')).createChromiumRtcActivity:null
// Use the managed companion's shipped resolver. Playwright's implicit headless
// shell has no private native WebUI and is not the companion's default browser.
const managedExecutable=process.env.HOAI_PROBE_EXECUTABLE||await ensureBrowser({findInstalled:()=>({path:null})})
const portableState = require('../lib/browser-profile-core/portable-state.js')
const source = sync.createEndpointIdentity('linux-source'), destination = sync.createEndpointIdentity('linux-destination'), key = sync.createContentKeyEpoch(1)
const authority = { profileId: 'linux-profile', actingUserId: 'synthetic-recipient', assistantId: 7, endpointId: 'linux-source', bootId: 'source-boot', runtimeId: 'source-runtime', sessionId: 'source-session', writerEpoch: 1, revision: 0, contentKeyEpoch: 1, grantVersion: 1, keyFingerprint: sync.identityFingerprint(source.identity) }
const destinationAuthority = { ...authority, endpointId: 'linux-destination', bootId: 'destination-boot', runtimeId: 'destination-runtime', sessionId: 'destination-session', writerEpoch: 2, revision: 1, grantVersion: 2, keyFingerprint: sync.identityFingerprint(destination.identity) }
const context = { version: 1, schemaVersion: 1, profileId: authority.profileId, actingUserId: authority.actingUserId, assistantId: 7, transitionId: 'linux-transition', revision: 1, previousManifestHash: null, keyEpoch: 1,
  source: { endpointId: authority.endpointId, bootId: authority.bootId, runtimeId: authority.runtimeId, sessionId: authority.sessionId, writerEpoch: 1 },
  destination: { endpointId: destinationAuthority.endpointId, bootId: destinationAuthority.bootId, runtimeId: destinationAuthority.runtimeId, sessionId: destinationAuthority.sessionId, grantVersion: 2, keyFingerprint: destinationAuthority.keyFingerprint } }
const report = { kind: 'Actual disposable Linux plugin runtime, injected coordinator and command lease, synthetic AES extras store only', transportQualification:nativeRtcFactory?'Actual exact-version native RTC observer plus raw Network/target ledger':'Restricted disposable literal-loopback only; no general native RTC qualification',checks: [] }, runtimes = [], ledger = [], pending = [], events = [], extraStores = new Map(), fixtureNativeKey = randomBytes(32)
const privateDirectory = mkdtempSync(join(tmpdir(), 'hoai-profile-capsules.'))
const portableExtras = { passwordVault: { v: 1, entries: [{ id: '0d694ca4-9b5d-4d95-a8bc-36eb1876bd80', origin: 'https://fixture.test', username: 'synthetic-user', password: 'HOAI_LINUX_SAVED_LOGIN_SECRET', name: 'Fixture', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z' }], neverOrigins: ['https://never.example.test'] }, preferences: { v: 1, searchEngine: 'duckduckgo' } }
const nativeBundle = file => { const envelope = JSON.parse(readFileSync(file, 'utf8')), bytes = Buffer.from(envelope.ciphertext, 'base64'), decipher = createDecipheriv('aes-256-gcm', fixtureNativeKey, Buffer.from(envelope.iv, 'base64')); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64')); const plaintext = Buffer.concat([decipher.update(bytes), decipher.final()]); try { return portableState.validatePortableBundle(JSON.parse(plaintext)) } finally { plaintext.fill(0) } }
let server,origin
const make = async authority => {
  const store = { bundle: authority.endpointId === 'linux-destination' ? { passwordVault: { v: 1, entries: [], neverOrigins: ['https://stale.example.test'] }, preferences: { v: 1, searchEngine: 'bing' } } : structuredClone(portableExtras), held: false, commits: 0, file: join(privateDirectory, authority.runtimeId + '.native-fixture-vault') }
  const runtime = await BrowserProfileRuntime.create({ chromium, executable: managedExecutable, authority, timeoutMs: 3000,
    ...(nativeRtcFactory?{transferQualificationFactory:nativeRtcFactory}:{transferQualification:{kind:'restricted-disposable-fixture',origins:[origin],assertQualified:()=>true}}),
    preflightExtras: () => structuredClone(store.bundle),
    captureExtras: () => { assert.equal(runtime.context.pages().length, 0); assert.equal(runtime.state, 'quiescing'); assert.equal(store.held, false); store.held = true; return { bundle: structuredClone(store.bundle), assertCurrent() { assert.equal(store.held, true) }, release() { store.held = false } } },
    commitExtras: ({ bundle, receipt, grant }) => {
      assert.equal(runtime.network, 'blocked'); assert.equal(runtime.state, 'staged'); assert.equal(grant, 'exact-fixture-grant'); assert.equal(receipt, runtime.stagedReceipt); assert.equal(store.held, false); assert.equal(store.commits, 0)
      const validated = portableState.validatePortableBundle(bundle), plaintext = Buffer.from(JSON.stringify(validated)), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', fixtureNativeKey, iv)
      let body; try { body = Buffer.from(JSON.stringify({ iv: iv.toString('base64'), ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64'), tag: cipher.getAuthTag().toString('base64') })) } finally { plaintext.fill(0) }
      const fd = openSync(store.file + '.tmp', 'wx', 0o600); try { writeSync(fd, body); fsyncSync(fd) } finally { closeSync(fd) }; renameSync(store.file + '.tmp', store.file); const dir = openSync(privateDirectory, 'r'); try { fsyncSync(dir) } finally { closeSync(dir) }
      assert.equal(body.includes(Buffer.from('HOAI_LINUX_SAVED_LOGIN_SECRET')), false); store.bundle = nativeBundle(store.file); assert.deepEqual(store.bundle, validated); store.commits++; return { committed: true }
    },
    closeAndDrain: async () => ({ admissionClosed: true, drained: true }),
    checkpoint: async value => {
      assert.equal(store.held, true)
      assert.equal(runtime.browser.isConnected(), false); assert.throws(() => readFileSync(`/proc/${runtime.processIdentity.pid}/stat`), { code: 'ENOENT' })
      const bytes = Buffer.from(JSON.stringify(value)), hash = sync.manifestHash(value.checkpoint.manifest), path = join(privateDirectory, hash + '.json')
      assert.equal(bytes.includes(Buffer.from('HOAI_LINUX_MEMORY_SECRET')), false)
      assert.equal(bytes.includes(Buffer.from('HOAI_LINUX_SAVED_LOGIN_SECRET')), false)
      const descriptor = openSync(path + '.tmp', 'wx', 0o600); try { writeSync(descriptor, bytes); fsyncSync(descriptor) } finally { closeSync(descriptor) }
      renameSync(path + '.tmp', path); const directory = openSync(privateDirectory, 'r'); try { fsyncSync(directory) } finally { closeSync(directory) }
      assert.deepEqual(readFileSync(path), bytes); assert.equal(statSync(path).mode & 0o777, 0o600)
      report.checks.push({ name: 'only-encrypted-capsule-atomically-fsynced-after-terminal-exit', ok: true, bytes: bytes.length, permissions: '0600' })
      return { durable: true, manifestHash: hash }
    },
    authorizeActivation: async ({ grant }) => { if (grant !== 'exact-fixture-grant') throw new Error('grant_refused'); return { authority, assertCurrent() {} } } })
  runtimes.push(runtime); extraStores.set(runtime, store); return runtime
}
try {
  server = http.createServer((request, response) => {
    ledger.push(request.url)
    if (request.url === '/events') { events.push(response); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: synthetic\n\n'); return }
    if (request.url.startsWith('/pending-')) { pending.push(response); return }
    if (request.url === '/worker.js' || request.url === '/shared.js') { response.writeHead(200, { 'content-type': 'application/javascript' }); response.end(request.url === '/shared.js' ? 'onconnect=e=>{fetch("/pending-shared",{method:"POST"}).catch(()=>{});e.ports[0].postMessage("ready");};' : 'fetch("/pending-dedicated",{method:"POST"}).catch(()=>{});postMessage("ready");'); return }
    response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'session=HOAI_LINUX_MEMORY_SECRET; HttpOnly; Path=/' }); response.end('<!doctype html><title>Disposable plugin runtime</title>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`
  portableExtras.passwordVault.entries[0].origin = origin
  const runtime = await make(authority); await runtime.activate('exact-fixture-grant'); const page = await runtime.newPage(origin + '/source')
  const fixtureQualification=runtime.transferQualification;runtime.transferQualification=undefined
  await assert.rejects(runtime.finalize({context,source,destinationIdentity:destination.identity,contentKeyEpoch:key}),{reason:'profile_transport_qualification_required'})
  assert.equal(runtime.state,'active');assert.equal(runtime.network,'active');assert.equal(runtime.browser.isConnected(),true);assert.equal(page.isClosed(),false);runtime.transferQualification=fixtureQualification
  report.checks.push({name:'missing-native-transport-proof-refuses-before-drain-and-preserves-original-live-page',ok:true})
  const argv = readFileSync(`/proc/${runtime.processIdentity.pid}/cmdline`, 'utf8').split('\0'), expectedFeatures = (await import('../lib/browser-profile-launch.mjs')).profileLaunchArguments().args[0]
  assert.equal(argv.includes('--no-sandbox'), false); assert.equal(argv.filter(value => value.startsWith('--disable-features=')).length, 1); assert.ok(argv.includes(expectedFeatures)); assert.ok(argv.includes('--remote-debugging-pipe')); assert.equal(argv.some(value => value.startsWith('--remote-debugging-port=')), false)
  report.browserVersion = runtime.browser.version(); report.launch = { sandboxEnabled: true, privatePipe: true, executable: managedExecutable, selection: process.env.HOAI_PROBE_EXECUTABLE ? 'explicit-override' : 'companion-bundled-default', featureSwitch: expectedFeatures, source: 'https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/chromium/chromiumSwitches.ts', omniboxSource: 'https://chromium.googlesource.com/chromium/src/+/bf3cc6d2d1098c5addd00a916373e6fa62d3dc6b' }
  await page.evaluate(`(async()=>{localStorage.setItem("token","HOAI_LINUX_MEMORY_SECRET");const request=indexedDB.open("fixture",1);request.onupgradeneeded=()=>request.result.createObjectStore("records");const db=await new Promise((ok,no)=>{request.onsuccess=()=>ok(request.result);request.onerror=()=>no(request.error)});await new Promise((ok,no)=>{const transaction=db.transaction("records","readwrite");transaction.objectStore("records").put({blob:new Blob(["HOAI_LINUX_MEMORY_SECRET"],{type:"text/plain"}),bytes:new Uint8Array([1,2,253]),map:new Map([["site","fixture"]])},"auth");transaction.oncomplete=ok;transaction.onerror=()=>no(transaction.error)});db.close();return true;})()`); await runtime.assertMovable()
  report.checks.push({ name: 'complete-target-ledger-qualified-before-navigation', ok: true, targets: runtime.ledger.history.size })
  const stopped = await runtime.finalize({ context, source, destinationIdentity: destination.identity, contentKeyEpoch: key })
  assert.equal(extraStores.get(runtime).held, false)
  const openedExtras = sync.openCheckpoint({ checkpoint: stopped.checkpoint, expectedContext: context, sourceIdentity: source.identity, destination }); assert.deepEqual(portableState.decodePortableState(openedExtras.plaintext).passwordVault, portableExtras.passwordVault); openedExtras.plaintext.fill(0); openedExtras.contentKeyEpoch.key.fill(0)
  assert.equal(runtime.state, 'stopped'); assert.equal(runtime.browser.isConnected(), false); report.checks.push({ name: 'owned-source-process-exited-before-signed-receipt', ok: true })
  const target = await make(destinationAuthority), before = ledger.length
  const staged = await target.stage({ checkpoint: stopped.checkpoint, expectedContext: context, sourceIdentity: source.identity, destination })
  assert.equal(target.state, 'staged'); assert.equal(staged.receipt.manifestHash, stopped.receipt.manifestHash); assert.equal(ledger.length, before)
  const targetExtras = extraStores.get(target); assert.equal(targetExtras.commits, 0); assert.equal(targetExtras.bundle.preferences.searchEngine, 'bing'); assert.deepEqual(targetExtras.bundle.passwordVault.neverOrigins, ['https://stale.example.test'])
  await assert.rejects(target.activate('wrong-grant')); assert.equal(ledger.length, before); report.checks.push({ name: 'destination-stage-is-inactive-and-makes-zero-site-requests', ok: true })
  assert.equal(targetExtras.commits, 0)
  const imported = await target.context.cookies(origin); assert.ok(imported.some(cookie => cookie.name === 'session' && cookie.value === 'HOAI_LINUX_MEMORY_SECRET' && cookie.httpOnly))
  await target.activate('exact-fixture-grant'); const reopened = await target.newPage(origin + '/destination')
  assert.equal(targetExtras.commits, 1); assert.deepEqual(nativeBundle(targetExtras.file), portableExtras); assert.equal(statSync(targetExtras.file).mode & 0o777, 0o600); report.checks.push({ name: 'full-saved-login-Never-and-search-bundle-publishes-once-only-after-exact-grant', ok: true, fixture: 'Synthetic AES encrypted native store, OS key-store bootstrap remains separate' })
  assert.equal(await reopened.evaluate(`(async()=>{if(localStorage.getItem("token")!=="HOAI_LINUX_MEMORY_SECRET")return false;const request=indexedDB.open("fixture",1);const db=await new Promise(ok=>request.onsuccess=()=>ok(request.result));const read=db.transaction("records").objectStore("records").get("auth");const value=await new Promise(ok=>read.onsuccess=()=>ok(read.result));db.close();return value.blob instanceof Blob&&await value.blob.text()==="HOAI_LINUX_MEMORY_SECRET"&&value.bytes instanceof Uint8Array&&value.bytes.join(",")==="1,2,253"&&value.map instanceof Map&&value.map.get("site")==="fixture";})()`), true); report.checks.push({ name: 'matching-grant-restores-HTTPOnly-cookie-localStorage-rich-IndexedDB', ok: true })
  const passwordAuthority = { ...authority, runtimeId: 'password-runtime', sessionId: 'password-session' }, passwordRuntime = await make(passwordAuthority); await passwordRuntime.activate('exact-fixture-grant'); const passwordPage = await passwordRuntime.newPage(origin + '/password')
  await passwordPage.evaluate('document.body.innerHTML="<input type=password id=secret>";document.getElementById("secret").value="synthetic-unsubmitted-password";true')
  await assert.rejects(passwordRuntime.finalize({ context: { ...context, transitionId: 'password-transition', source: { ...context.source, runtimeId: 'password-runtime', sessionId: 'password-session' } }, source, destinationIdentity: destination.identity, contentKeyEpoch: key }), { reason: 'profile_authentication_in_progress' }); assert.equal(passwordPage.isClosed(), false)
  report.checks.push({ name: 'unfinished-password-refuses-with-source-left-running', ok: true })
  const eventAuthority = { ...authority, runtimeId: 'event-runtime', sessionId: 'event-session' }, eventRuntime = await make(eventAuthority); await eventRuntime.activate('exact-fixture-grant'); const eventPage = await eventRuntime.newPage(origin + '/event-page')
  await eventPage.evaluate('new Promise(ok=>{window.events=new EventSource("/events");events.onopen=()=>ok(true)})')
  await assert.rejects(eventRuntime.finalize({ context: { ...context, transitionId: 'event-transition', source: { ...context.source, runtimeId: 'event-runtime', sessionId: 'event-session' } }, source, destinationIdentity: destination.identity, contentKeyEpoch: key }), { reason: 'profile_persistent_transport_unsupported' }); assert.equal(eventPage.isClosed(), false)
  report.checks.push({ name: 'persistent-EventSource-refuses-with-source-left-running', ok: true })
  if(nativeRtcFactory){
    const rtcAuthority={...authority,runtimeId:'rtc-runtime',sessionId:'rtc-session'},rtc=await make(rtcAuthority);await rtc.activate('exact-fixture-grant');const rtcPage=await rtc.newPage(origin+'/rtc')
    await rtcPage.evaluate('(()=>{const peer=new RTCPeerConnection({iceServers:[]});peer.close();return true})()');const end=Date.now()+5000;while(!rtc.transportObserver.used&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(rtc.transportObserver.used,true)
    let drained=false;rtc.closeAndDrain=async()=>{drained=true;return{admissionClosed:true,drained:true}}
    await assert.rejects(rtc.finalize({context:{...context,transitionId:'rtc-transition',source:{...context.source,runtimeId:'rtc-runtime',sessionId:'rtc-session'}},source,destinationIdentity:destination.identity,contentKeyEpoch:key}),{reason:'profile_transport_qualification_required'});assert.equal(drained,false);assert.equal(rtcPage.isClosed(),false);assert.equal(rtc.state,'active');assert.equal(rtc.browser.isConnected(),true)
    report.checks.push({name:'closed-owned-RTC-native-history-refuses-before-drain-with-original-page-alive',ok:true});await rtc.dispose()
  }
  const busyAuthority = { ...authority, runtimeId: 'busy-runtime', sessionId: 'busy-session' }, busy = await make(busyAuthority); await busy.activate('exact-fixture-grant'); const busyPage = await busy.newPage(origin + '/busy')
  await busyPage.evaluate('(async()=>{window.worker=new Worker("/worker.js");window.shared=new SharedWorker("/shared.js");await Promise.all([new Promise(ok=>worker.onmessage=ok),new Promise(ok=>shared.port.onmessage=ok)]);})()')
  const busyContext = { ...context, transitionId: 'busy-transition', source: { ...context.source, runtimeId: 'busy-runtime', sessionId: 'busy-session' } }
  let busyReason
  try { await busy.finalize({ context: busyContext, source, destinationIdentity: destination.identity, contentKeyEpoch: key }); throw new Error('unsafe busy transfer succeeded') } catch (error) { busyReason = error.reason; if (!['profile_requests_in_flight', 'profile_target_unqualified', 'profile_network_untracked'].includes(busyReason)) throw error }
  assert.equal(busy.browser.isConnected(), true); assert.equal(busyPage.isClosed(), false); assert.equal(busy.state, 'active')
  report.checks.push({ name: 'pending-worker-POST-refuses-with-source-left-running', ok: true, reason: busyReason, rawTargets: [...busy.ledger.targets.values()].map(value => ({ type: value.type, ready: value.ready })) })
  const revokedAuthority = { ...authority, runtimeId: 'revoked-runtime', sessionId: 'revoked-session' }, revokedRuntime = await make(revokedAuthority); await revokedRuntime.activate('exact-fixture-grant'); await revokedRuntime.newPage(origin + '/revoked')
  // This failure is injected after the physical drain, not while an ordinary
  // fixture request is still finishing. Wait for the native read-only preflight.
  {const end=Date.now()+5000;for(;;){try{await revokedRuntime.assertMovable();break}catch(error){if(Date.now()>=end)throw error;await new Promise(resolve=>setTimeout(resolve,20))}}}
  let revoked = false; revokedRuntime.activeProof = () => { if (revoked) throw new Error('fixture-authority-withdrawn') }; revokedRuntime.closeAndDrain = async () => { revoked = true; return { admissionClosed: true, drained: true } }
  await assert.rejects(revokedRuntime.finalize({ context: { ...context, transitionId: 'revoked-transition', source: { ...context.source, runtimeId: 'revoked-runtime', sessionId: 'revoked-session' } }, source, destinationIdentity: destination.identity, contentKeyEpoch: key }), /fixture-authority-withdrawn/)
  assert.equal(revokedRuntime.browser.isConnected(), false); assert.equal(revokedRuntime.network, 'blocked'); assert.equal(revokedRuntime.state, 'disposed'); assert.throws(() => readFileSync(`/proc/${revokedRuntime.processIdentity.pid}/stat`), { code: 'ENOENT' })
  report.checks.push({ name: 'authority-withdrawal-during-drain-physically-disposes-source', ok: true, authority: 'injected fixture proof' })
  const noClose = await make({ ...authority, runtimeId: 'no-close-runtime', sessionId: 'no-close-session' }), closeOwned = noClose.browser.close.bind(noClose.browser), ownedKey = Buffer.alloc(32, 7)
  noClose.contentKeyEpoch = { epoch: 1, key: ownedKey }; noClose.browser.close = async () => {}
  try { await assert.rejects(noClose.dispose(), { reason: 'profile_runtime_process_alive' }); assert.equal(noClose.browser.isConnected(), true); assert.ok(ownedKey.every(value => value === 0)); report.checks.push({ name: 'resolving-close-with-live-owned-PID-refuses-cleanup-and-zeroes-key', ok: true }) }
  finally { noClose.browser.close = closeOwned; await closeOwned() }
  for (const response of pending) if (!response.destroyed) { response.writeHead(200, { 'set-cookie': 'completed=synthetic-completed; Path=/' }); response.end('done') }
  report.ok = true
} catch (error) { report.ok = false; report.failure = error.stack; if (error.targetQualification) report.targetQualification = error.targetQualification; if (error.pauseQualification) report.pauseQualification = error.pauseQualification }
finally { for (const response of events) response.destroy(); for (const runtime of runtimes) await runtime.dispose().catch(() => {}); key.key.fill(0); fixtureNativeKey.fill(0); if (server) { server.closeAllConnections(); server.close() } report.encryptedCapsuleDirectory = privateDirectory; if (process.env.HOAI_PROBE_REPORT) writeFileSync(process.env.HOAI_PROBE_REPORT, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1 }
