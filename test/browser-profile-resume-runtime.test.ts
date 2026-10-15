import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { BrowserProfileRuntime, profileCrypto } from '../lib/browser-profile-runtime.mjs'
const require = createRequire(import.meta.url), portable = require('../lib/browser-profile-core/portable-state.js')
const extras = () => ({ passwordVault: { v: 1, entries: [], neverOrigins: [] }, preferences: { v: 1, searchEngine: 'google' } })

function fixture(options: any = {}) {
  const source = profileCrypto.createEndpointIdentity('source'), destination = profileCrypto.createEndpointIdentity('destination'), key = profileCrypto.createContentKeyEpoch(1)
  const authority = { profileId: 'profile', actingUserId: 'recipient', assistantId: 7, endpointId: 'source', bootId: 'boot', runtimeId: 'runtime', sessionId: 'session', writerEpoch: 1, revision: 0, contentKeyEpoch: 1, grantVersion: 1, keyFingerprint: profileCrypto.identityFingerprint(source.identity) }
  const targetAuthority = { ...authority, endpointId: 'destination', bootId: 'target-boot', runtimeId: 'target-runtime', sessionId: 'target-session', writerEpoch: 2, revision: 1, grantVersion: 2, keyFingerprint: profileCrypto.identityFingerprint(destination.identity) }
  const context = { version: 1, schemaVersion: 2, profileId: authority.profileId, actingUserId: authority.actingUserId, assistantId: 7, transitionId: 'transition', revision: 1, previousManifestHash: null, keyEpoch: 1,
    source: { endpointId: 'source', bootId: 'boot', runtimeId: 'runtime', sessionId: 'session', writerEpoch: 1 }, destination: { endpointId: 'destination', bootId: 'target-boot', runtimeId: 'target-runtime', sessionId: 'target-session', grantVersion: 2, keyFingerprint: targetAuthority.keyFingerprint } }
  const calls: string[] = [], pages: any[] = []; let selected: any = null, connected = true, serial = 0
  const nativeContext: any = new EventEmitter()
  nativeContext.pages = () => [...pages]
  nativeContext.setOffline = async (value: boolean) => { calls.push('offline:' + value) }
  nativeContext.newCDPSession = async (page: any) => ({ send: async (method: string) => {
    calls.push(method)
    if (method === 'Target.getTargetInfo') return { targetInfo: { type: 'page', canAccessOpener: false, browserContextId: 'context', targetId: page.id, url: page.url(), title: page.nativeTitle } }
    if (method === 'Page.getFrameTree') { const url = new URL(page.url()), fragment = url.hash; url.hash = ''; return { frameTree: { frame: { id: page.id + '-frame', loaderId: page.id + '-loader', url: url.href, ...(fragment ? { urlFragment: fragment } : {}) } } } }
    return { cookies: [] }
  }, detach: async () => {} })
  const ledger: any = { generation: 1, frozen: false, inventory: async () => [], assertIdle() {}, readyTarget: async () => {},
    resumeDocument(id: string) { calls.push('prove:' + id); assert.equal(pages.find(page => page.id === id)?.proved, true, 'actual GET receipt required') },
    freeze: async () => { calls.push('freeze'); ledger.frozen = true; options.afterFreeze?.(); return ledger.generation }, resume: async () => { ledger.frozen = false }, dispose() {} }
  const runtime: any = new BrowserProfileRuntime({ context: nativeContext, root: { send: async () => ({ targetInfos: [] }) }, ledger, authority, timeoutMs: 30,
    browser: { close: async () => { calls.push('process-close'); connected = false; pages.length = 0 }, isConnected: () => connected }, assertProcessExited: async () => true,
    browserVersion: '153.0.8010.12', transferQualification: { kind: 'qualified-chromium-native-observer-v1', browserVersion: '153.0.8010.12', assertQualified: () => true, confirmStopped: async () => true },
    selectedPage: () => selected, closeAndDrain: async () => { calls.push('drain'); return { admissionClosed: true, drained: true } }, checkpoint: async (value: any) => ({ durable: true, manifestHash: profileCrypto.manifestHash(value.checkpoint.manifest) }),
    authorizeActivation: async ({ authority }: any) => ({ authority, assertCurrent() { calls.push('authority') } }),
    preflightExtras: extras, captureExtras: () => ({ bundle: extras(), assertCurrent() {}, release() {} }), commitExtras: () => ({ committed: true }), ...options.runtime })
  runtime.contextId = 'context'; runtime._assertDocumentSafety = async () => {}; runtime._exporter = async () => ({ evaluate: async () => true })
  function add(url = 'about:blank', title = 'Native title', proved = true) {
    const page: any = new EventEmitter(); page.id = 'page-' + ++serial; page.nativeTitle = title; page.proved = proved; page.currentURL = url; page.url = () => page.currentURL; page.isClosed = () => !pages.includes(page)
    page.close = async () => { calls.push('close:' + page.id); pages.splice(pages.indexOf(page), 1) }
    page.goto = async (value: string, config: any) => { calls.push('goto:' + value); assert.equal(runtime.state, 'staged'); assert.equal(runtime.network, 'active'); assert.deepEqual(config, { waitUntil: 'load', timeout: 30000 }); page.currentURL = value; await options.goto?.(page, value) }
    pages.push(page); nativeContext.emit('page', page); if (!selected) selected = page; return page
  }
  nativeContext.newPage = async () => add()
  return { runtime, calls, pages, ledger, add, select: (page: any) => { selected = page }, source, destination, key, context, authority, targetAuthority,
    finalize: () => runtime.finalize({ context, source, destinationIdentity: destination.identity, contentKeyEpoch: key }) }
}
async function checkpoint(tabs: any) {
  const f = fixture(), plaintext = portable.encodePortableState({ schema: portable.SCHEMA_V2, cookies: [], origins: [], ...extras(), resumeTabs: tabs }, 2)
  const sealed = profileCrypto.sealCheckpoint({ plaintext, context: f.context, source: f.source, destinationIdentity: f.destination.identity, contentKeyEpoch: f.key }); plaintext.fill(0)
  return { ...f, sealed }
}
async function stage(f: any, options: any = {}) {
  const target = fixture(options); target.runtime.authority = Object.freeze(f.targetAuthority)
  await target.runtime.stage({ checkpoint: f.sealed, expectedContext: f.context, sourceIdentity: f.source.identity, destination: f.destination })
  return target
}
test('schema2 captures native ordered tabs and actual selected page after freeze before destroy', async () => {
  const f = fixture(); await f.runtime.activate({}); const one = f.add('https://site.test/first', 'One'), two = f.add('https://site.test/second?view=recent#part', 'Two'); f.select(one)
  assert.notEqual(two, one); const stopped = await f.finalize(), opened = profileCrypto.openCheckpoint({ checkpoint: stopped.checkpoint, expectedContext: f.context, sourceIdentity: f.source.identity, destination: f.destination })
  try { assert.deepEqual(portable.decodePortableState(opened.plaintext, 2).resumeTabs, { version: 1, selectedIndex: 0, tabs: [{ url: one.url(), title: 'One' }, { url: two.url(), title: 'Two' }] }) } finally { opened.plaintext.fill(0); opened.contentKeyEpoch.key.fill(0) }
  assert.ok(f.calls.lastIndexOf('prove:' + two.id) > f.calls.indexOf('freeze')); assert.ok(f.calls.lastIndexOf('prove:' + two.id) < f.calls.indexOf('close:' + one.id))
})
test('unproved GET, invalid auth URL and unknown selection refuse before source admission closes', async () => {
  for (const fault of ['get', 'auth', 'selection']) { const f = fixture(); await f.runtime.activate({}); const page = f.add(fault === 'auth' ? 'https://site.test/oauth/callback' : 'https://site.test/page', 'Page', fault !== 'get'); if (fault === 'selection') f.select({})
    await assert.rejects(f.finalize()); assert.equal(f.calls.includes('drain'), false); assert.equal(f.runtime.state, 'active'); assert.equal(page.isClosed(), false) }
})
test('URL, title and selection races after freeze keep the same source alive', async () => {
  for (const fault of ['url', 'title', 'selected']) { let f: any; f = fixture({ afterFreeze() { if (fault === 'url') f.pages[0].currentURL += '/changed'; if (fault === 'title') f.pages[0].nativeTitle = 'Changed'; if (fault === 'selected') f.select(f.pages[1]) } }); await f.runtime.activate({}); f.add('https://site.test/a'); f.add('https://site.test/b')
    await assert.rejects(f.finalize(), /snapshot_changed/); assert.equal(f.calls.includes('process-close'), false); assert.equal(f.pages.length, 2); assert.equal(f.runtime.state, 'active') }
})
test('empty tab capture stays explicit and selected callback cannot become asynchronous or foreign', async () => {
  const f = fixture(); await f.runtime.activate({}); assert.deepEqual(await f.runtime.preflightResumeTabs(), { version: 1, selectedIndex: -1, tabs: [] })
  for (const selectedPage of [undefined, () => Promise.resolve(null), () => ({})]) { const bad = fixture({ runtime: { selectedPage } }); await bad.runtime.activate({}); bad.add(); await assert.rejects(bad.runtime.preflightResumeTabs()) }
})
test('native main-frame fragment event races retain exact root storage proof while query or path changes refuse', async () => {
  for (const suffix of ['#part', '?changed=1', '/changed']) {
    const f = fixture(), page = f.add('https://site.test/document'), original = page.url(), frame: any = { url: () => page.currentURL, isDetached: () => false }; page.mainFrame = () => frame
    f.runtime.context.newCDPSession = async () => ({ send: async (method: string) => method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'actual-main', url: page.currentURL }, childFrames: [{ frame: { id: 'same-url-iframe', url: page.currentURL } }] } } : { storageKey: 'https://site.test/' }, detach: async () => {} })
    f.runtime._frame(page, frame); page.currentURL = original + suffix; await Promise.all([...f.runtime.frameJobs])
    assert.equal(f.runtime.markers[0].qualified, suffix === '#part')
  }
})
test('schema2 stage is inert and exact authority opens each URL once then exposes only the selected page', async () => {
  const f = await checkpoint({ version: 1, selectedIndex: 0, tabs: [{ url: 'https://site.test/one', title: 'One' }, { url: 'https://site.test/two', title: 'Two' }] }), target = await stage(f)
  assert.equal(target.runtime.state, 'staged'); assert.equal(target.pages.length, 0); assert.equal(target.runtime.restoredSelectedPage(), null); assert.equal(target.calls.some((value: string) => value.startsWith('goto:')), false)
  await target.runtime.activate({}); assert.equal(target.pages.length, 2); assert.equal(target.runtime.restoredSelectedPage(), target.pages[0]); assert.deepEqual(target.calls.filter((value: string) => value.startsWith('goto:')), ['goto:https://site.test/one', 'goto:https://site.test/two'])
  await assert.rejects(target.runtime.activate({})); assert.equal(target.pages.length, 2)
})
test('a staged schema2 hint never opens a page when fresh coordinator activation is refused', async () => {
  const f = await checkpoint({ version: 1, selectedIndex: 0, tabs: [{ url: 'https://site.test/one', title: 'One' }] }), target = await stage(f)
  target.runtime.authorizeActivation = async () => { throw Error('fresh_CAS_refused') }; await assert.rejects(target.runtime.activate({}), /fresh_CAS_refused/)
  assert.equal(target.pages.length, 0); assert.equal(target.runtime.state, 'staged'); assert.equal(target.runtime.network, 'blocked')
})
test('serialized review flags and generic staging cannot grant query or fragment navigation', async () => {
  const f = await checkpoint({ version: 1, selectedIndex: 0, tabs: [{ url: 'https://site.test/list?view=recent#part', title: 'List' }] }), target = fixture(); target.runtime.authority = Object.freeze(f.targetAuthority)
  await assert.rejects(target.runtime.stage({ checkpoint: f.sealed, expectedContext: f.context, sourceIdentity: f.source.identity, destination: f.destination, reviewed: true, authorizeReviewedResume: true }), /review_required/)
  assert.equal(target.runtime.state, 'disposed'); assert.equal(target.calls.some(value => value.startsWith('goto:')), false)
})
test('constructor proof is checked through inactive import and around every approved one-use GET', async () => {
  const tabs = { version: 1, selectedIndex: 1, tabs: [{ url: 'https://site.test/list?view=recent', title: 'List' }, { url: 'https://site.test/detail#part', title: 'Detail' }] }, f = await checkpoint(tabs); let checks = 0, grants = 0, valid = true
  const target = await stage(f, { runtime: { authorizeReviewedResume(input: any) { grants++; assert.equal(profileCrypto.manifestHash(input.checkpoint.manifest), profileCrypto.manifestHash(f.sealed.manifest)); assert.deepEqual(input.expectedContext, f.context); assert.deepEqual(input.sourceIdentity, f.source.identity); assert.deepEqual(input.resumeTabs, tabs); return { assertCurrent() { checks++; if (!valid) throw Error('revoked review') } } } } })
  const before = checks; await target.runtime.activate({}); assert.equal(grants, 1); assert.ok(checks > before + 5); assert.equal(target.runtime.restoredSelectedPage(), target.pages[1]); valid = false
})
test('revoked private proof or failed navigation stops partial restoration and never retries it', async () => {
  for (const mode of ['revoke', 'network']) { let valid = true; const f = await checkpoint({ version: 1, selectedIndex: 0, tabs: [{ url: 'https://site.test/one?view=1', title: 'One' }, { url: 'https://site.test/two', title: 'Two' }] })
    const target = await stage(f, { runtime: { authorizeReviewedResume: () => ({ assertCurrent() { if (!valid) throw Error('revoked review') } }) }, goto() { if (mode === 'network') throw Error('navigation outcome unknown'); valid = false } })
    await assert.rejects(target.runtime.activate({})); assert.equal(target.runtime.state, 'disposed'); assert.equal(target.runtime.network, 'blocked'); assert.equal(target.runtime.restoredSelectedPage(), null); assert.equal(target.calls.filter((value: string) => value.startsWith('goto:')).length, 1)
    await assert.rejects(target.runtime.activate({})); assert.equal(target.calls.filter((value: string) => value.startsWith('goto:')).length, 1)
  }
})
test('format downgrade cannot decode a schema2 body and invalid constructor review proof never stages', async () => {
  const f = await checkpoint({ version: 1, selectedIndex: 0, tabs: [{ url: 'https://site.test/one?view=1', title: 'One' }] })
  for (const authorizeReviewedResume of [() => true, async () => ({ assertCurrent() {} }), () => ({ assertCurrent: async () => true }), () => ({ assertCurrent: () => false })]) await assert.rejects(stage(f, { runtime: { authorizeReviewedResume } }))
  const opened = profileCrypto.openCheckpoint({ checkpoint: f.sealed, expectedContext: f.context, sourceIdentity: f.source.identity, destination: f.destination }); try { assert.throws(() => portable.decodePortableState(opened.plaintext, 1)) } finally { opened.plaintext.fill(0); opened.contentKeyEpoch.key.fill(0) }
})
