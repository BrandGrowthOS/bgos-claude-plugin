// Opt-in, disposable Linux qualification. Coordinator grants, URL review and
// portable extras are synthetic; Chromium/CDP, GET/POST traffic, sandbox,
// encrypted native checkpoint and positive process cleanup are real.
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRequire } from 'node:module'
import { randomUUID, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync, openSync, writeSync, fsyncSync, closeSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserProfileRuntime, profileCrypto as codec } from '../lib/browser-profile-runtime.mjs'
import { createChromiumRtcActivity } from '../lib/browser-profile-rtc-activity.mjs'
import { ensureBrowser } from '../lib/browser-bootstrap.mjs'
import { PlaywrightEngine, DEFAULT_CAPS } from '../bin/hoai-browser-host.mjs'
const require = createRequire(import.meta.url), { chromium } = require(process.env.HOAI_PROBE_PLAYWRIGHT)
const portable = require('../lib/browser-profile-core/portable-state.js'), directory = mkdtempSync(join(tmpdir(), 'hoai-resume-probe-'))
const source = codec.createEndpointIdentity(randomUUID()), destination = codec.createEndpointIdentity(randomUUID()), key = codec.createContentKeyEpoch(1), cookie = randomBytes(24).toString('base64url')
const authority = { profileId: randomUUID(), actingUserId: 'synthetic-recipient', assistantId: 7, endpointId: source.identity.endpointId, bootId: 'source-boot', runtimeId: 'source-runtime', sessionId: 'source-session', writerEpoch: 1, revision: 0, contentKeyEpoch: 1, grantVersion: 1, keyFingerprint: codec.identityFingerprint(source.identity) }
const targetAuthority = { ...authority, endpointId: destination.identity.endpointId, bootId: 'target-boot', runtimeId: 'target-runtime', sessionId: 'target-session', writerEpoch: 2, revision: 1, grantVersion: 2, keyFingerprint: codec.identityFingerprint(destination.identity) }
const context = { version: 1, schemaVersion: 2, profileId: authority.profileId, actingUserId: authority.actingUserId, assistantId: 7, transitionId: randomUUID(), revision: 1, previousManifestHash: null, keyEpoch: 1,
  source: Object.fromEntries(['endpointId','bootId','runtimeId','sessionId','writerEpoch'].map(name => [name, authority[name]])), destination: Object.fromEntries(['endpointId','bootId','runtimeId','sessionId','grantVersion','keyFingerprint'].map(name => [name, targetAuthority[name]])) }
const extras = () => ({ passwordVault: { v: 1, entries: [], neverOrigins: [] }, preferences: { v: 1, searchEngine: 'google' } }), runtimes = [], requests = [], checks = [], commandFailures = []
let server, origin, failure, report, current = true, cas = true, drains = 0
const executable = process.env.HOAI_PROBE_EXECUTABLE || await ensureBrowser({ findInstalled: () => ({ path: null }) })
function currentProof() { if (!current) throw Error('synthetic_authority_revoked') }
async function make(binding, review) {
  let selected = null
  const runtime = await BrowserProfileRuntime.create({ chromium, executable, authority: binding, timeoutMs: 5000, transferQualificationFactory: createChromiumRtcActivity,
    selectedPage: () => selected, ...(review ? { authorizeReviewedResume: review } : {}), preflightExtras: extras,
    captureExtras: () => ({ bundle: extras(), assertCurrent: currentProof, release() {} }), commitExtras: () => ({ committed: true }),
    closeAndDrain: async () => { drains++; return { admissionClosed: true, drained: true } },
    checkpoint: async stopped => {
      const bytes = Buffer.from(JSON.stringify(stopped)), path = join(directory, codec.manifestHash(stopped.checkpoint.manifest) + '.json')
      assert.equal(runtime.browser.isConnected(), false); assert.throws(() => readFileSync(`/proc/${runtime.processIdentity.pid}/stat`), { code: 'ENOENT' }); assert.equal(bytes.includes(Buffer.from(cookie)), false)
      const fd = openSync(path + '.tmp', 'wx', 0o600); try { writeSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }; renameSync(path + '.tmp', path)
      const parent = openSync(directory, 'r'); try { fsyncSync(parent) } finally { closeSync(parent) }; assert.deepEqual(readFileSync(path), bytes)
      return { durable: true, manifestHash: codec.manifestHash(stopped.checkpoint.manifest) }
    }, authorizeActivation: async ({ authority }) => { if (!cas) throw Error('synthetic_CAS_not_accepted'); return { authority, assertCurrent: currentProof } } })
  for (const object of [runtime.ledger, runtime.root]) { const original = object.send.bind(object); object.send = (...args) => original(...args).catch(error => { commandFailures.push({ method: args[object === runtime.ledger ? 1 : 0], reason: error.protocolMessage || error.reason || error.code || error.message }); throw error }) }
  runtimes.push(runtime); return { runtime, select: page => { selected = page } }
}
async function settled(runtime) { const deadline = Date.now() + 5000; while (true) { try { return await runtime.assertMovable() } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 10)) } } }
try {
  server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, importedCookie: request.headers.cookie?.includes('session=' + cookie) === true })
    if (request.url === '/submitted') { request.resume(); response.writeHead(303, { location: '/normal-result' }); response.end(); return }
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store', ...(request.url === '/seed' && !request.headers.cookie?.includes('session=' + cookie) ? { 'set-cookie': `session=${cookie}; HttpOnly; Path=/` } : {}) })
    response.end(request.url === '/form' ? '<!doctype html><title>Post form</title><form method=post action=/submitted target=_blank><button>Submit fixture</button></form>' : '<!doctype html><title>Native GET fixture</title><p>Fixture only</p>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`
  const first = await make(authority), runtime = first.runtime; await runtime.activate({}); const one = await runtime.newPage(origin + '/seed'), two = await runtime.newPage(origin + '/second?view=recent#part'), blank = await runtime.newPage(); first.select(one); await settled(runtime)
  const argv = readFileSync(`/proc/${runtime.processIdentity.pid}/cmdline`, 'utf8').split('\0'); assert.equal(argv.includes('--no-sandbox'), false); assert.ok(argv.includes('--remote-debugging-pipe')); assert.equal(argv.some(value => value.startsWith('--remote-debugging-port=')), false)
  const captured = await runtime.preflightResumeTabs(); assert.deepEqual(captured.tabs.map(row => row.url), [one.url(), two.url(), blank.url()]); assert.equal(captured.selectedIndex, 0)
  const stopped = await runtime.finalize({ context, source, destinationIdentity: destination.identity, contentKeyEpoch: key }), opened = codec.openCheckpoint({ checkpoint: stopped.checkpoint, expectedContext: context, sourceIdentity: source.identity, destination })
  try { assert.deepEqual(portable.decodePortableState(opened.plaintext, 2).resumeTabs, captured) } finally { opened.plaintext.fill(0); opened.contentKeyEpoch.key.fill(0) }
  checks.push({ name: 'actual-completed-native-GET-order-selected-and-encrypted-schema2-capture', ok: true, tabCount: captured.tabs.length, selectedIndex: captured.selectedIndex })
  let reviews = 0
  const target = (await make(targetAuthority, input => { reviews++; assert.equal(codec.manifestHash(input.checkpoint.manifest), stopped.receipt.manifestHash); assert.deepEqual(input.expectedContext, context); assert.deepEqual(input.sourceIdentity, source.identity); assert.deepEqual(input.resumeTabs, captured); return { assertCurrent: currentProof } })).runtime
  const before = requests.length; await target.stage({ checkpoint: stopped.checkpoint, expectedContext: context, sourceIdentity: source.identity, destination }); assert.equal(requests.length, before); assert.equal(target.context.pages().length, 0); assert.equal(target.restoredSelectedPage(), null)
  cas = false; await assert.rejects(target.activate({}), /CAS_not_accepted/); assert.equal(requests.length, before); assert.equal(target.state, 'staged'); cas = true
  await target.activate({}); await settled(target); assert.equal(reviews, 1); assert.equal(target.restoredSelectedPage(), target.context.pages()[0]); assert.deepEqual(target.context.pages().map(page => page.url()), captured.tabs.map(row => row.url))
  assert.ok(requests.slice(before).some(row => row.method === 'GET' && row.url === '/seed' && row.importedCookie)); assert.equal(requests.slice(before).filter(row => row.url === '/second?view=recent').length, 1)
  checks.push({ name: 'zero-site-traffic-before-fresh-CAS-then-one-exact-reviewed-GET-and-imported-HTTPOnly-cookie-delivery', ok: true, review: 'Synthetic constructor fixture proof, not real human approval or Companion role qualification' })
  const existingPages = target.context.pages(), selected = target.restoredSelectedPage(), beforeSelection = requests.length
  const engine = await new PlaywrightEngine({ endpoint: null, managedRuntime: target, caps: DEFAULT_CAPS, outputDir: directory, clientName: 'native-selection-fixture' }).start()
  try {
    assert.equal(engine._backend._context.tabs().length, 0)
    await engine.selectPage(selected)
    assert.equal(engine.selectedPage(), selected)
    assert.deepEqual(target.context.pages(), existingPages)
    assert.equal(requests.length, beforeSelection)
    checks.push({ name: 'actual-lazy-MCP-backend-selects-exact-restored-page-without-new-page-or-navigation', ok: true, tabCount: existingPages.length, selectedIndex: existingPages.indexOf(selected) })
  } finally { await engine._backend.dispose() }
  if (process.env.HOAI_PROBE_POPUP === '1') {
  const third = await make({ ...authority, runtimeId: 'popup-runtime', sessionId: 'popup-session' }), formRuntime = third.runtime; await formRuntime.activate({}); const form = await formRuntime.newPage(origin + '/form'); third.select(form)
  const popupTask = formRuntime.context.waitForEvent('page', { timeout: 10000 }); await form.click('button'); const popup = await popupTask; await popup.waitForLoadState('load'); await settled(formRuntime); assert.equal(popup.url(), origin + '/normal-result')
  const beforeDrain = drains; await assert.rejects(formRuntime.finalize({ context, source, destinationIdentity: destination.identity, contentKeyEpoch: key })); assert.equal(drains, beforeDrain); assert.equal(formRuntime.state, 'active'); assert.equal(form.isClosed(), false); assert.equal(popup.isClosed(), false)
  // Use an exact runtime-bound context for the decisive POST redirect refusal.
  const popupContext = { ...context, source: { ...context.source, runtimeId: 'popup-runtime', sessionId: 'popup-session' }, transitionId: randomUUID() }
  await assert.rejects(formRuntime.finalize({ context: popupContext, source, destinationIdentity: destination.identity, contentKeyEpoch: key }), /profile_resume_document_unproved/); assert.equal(drains, beforeDrain); assert.equal(formRuntime.context.pages().length, 2)
  checks.push({ name: 'actual-popup-POST-303-GET-refuses-before-admission-and-retains-both-original-pages', ok: true })
  }
  report = { ok: true, browserVersion: await target.browser.version(), uid: process.getuid(), sandboxEnabled: true, privatePipe: true, checks, evidenceBoundary: 'Actual disposable single-Linux runtime and site traffic; synthetic coordinator/CAS/review/extras. Full HOAI and two-machine role proof is separate.' }
} catch (error) { failure = error; const nativeDocuments = [], nativeInventories = []; for (const runtime of runtimes) if (runtime.browser.isConnected()) { nativeInventories.push({ state: runtime.state, targets: [...runtime.ledger.targets.values()].map(target => ({ type: target.type, url: target.url, ready: target.ready, paused: target.paused, unqualified: target.unqualified, pauseError: target.pauseError })) }); for (const page of runtime.context.pages()) { try { const cdp = await runtime.context.newCDPSession(page); try { nativeDocuments.push({ pageURL: page.url(), targetInfo: (await cdp.send('Target.getTargetInfo')).targetInfo, frame: (await cdp.send('Page.getFrameTree')).frameTree.frame }) } finally { await cdp.detach() } } catch {} } }; report = { ok: false, reason: error.code || error.reason || error.message, stack: String(error.stack).slice(0, 2000), checks, nativeDocuments, nativeInventories, requests, commandFailures } }
finally {
  current = true; cas = true
  const cleanup = []
  for (const runtime of runtimes) { let error = null; try { await runtime.dispose() } catch (value) { error = value.code || value.reason || value.message }; let gone = false; try { readFileSync(`/proc/${runtime.processIdentity.pid}/stat`) } catch (value) { gone = value.code === 'ENOENT' }; cleanup.push({ disconnected: !runtime.browser.isConnected(), ownedProcessGone: gone, error }) }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  key.key.fill(0); report.cleanup = { runtimes: cleanup, serverClosed: !server?.listening }; if (cleanup.some(row => !row.disconnected || !row.ownedProcessGone || row.error)) report.ok = false
  if (process.env.HOAI_PROBE_REPORT) writeFileSync(process.env.HOAI_PROBE_REPORT, JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(report)); if (!report.ok || failure) process.exitCode = 1
}
