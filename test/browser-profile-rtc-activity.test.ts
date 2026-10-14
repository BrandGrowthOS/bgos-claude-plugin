import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createChromiumRtcActivity, RTC_BROWSER_VERSION, RTC_MAX_HISTORY } from '../lib/browser-profile-rtc-activity.mjs'
function fixture(t: any, options: any = {}) {
  const authority = { profileId: randomUUID(), actingUserId: 'recipient', assistantId: 7, endpointId: randomUUID(), bootId: 'boot', runtimeId: 'runtime', sessionId: 'session', writerEpoch: 1, revision: 0, contentKeyEpoch: 1, grantVersion: 1, keyFingerprint: 'a'.repeat(64) }
  let contextSequence = 0, pageSequence = 0, markerSequence = 0
  const nativeContexts: any[] = [], targets = new Map<string, any>(), calls: any[] = [], browser: any = new EventEmitter(), root: any = new EventEmitter()
  Object.assign(root, { send: async (method: string, params: any = {}) => {
    calls.push([method, params]); if (method === 'Target.getTargets') return { targetInfos: [...targets.values()] }
    if (method === 'Target.getBrowserContexts') return { browserContextIds: nativeContexts.map(c => c.id) }
    if (method === 'SystemInfo.getProcessInfo') return { processInfo: [{ type: 'browser', id: options.wrongPid ? 124 : 123 }] }
    return {}
  } })
  class Page extends EventEmitter {
    target: any; cdp: any; world: any; closed = false; script: any
    constructor(readonly context: any) {
      super(); this.target = { targetId: 'target-' + ++pageSequence, browserContextId: context.id, type: 'page', url: 'about:blank' }; targets.set(this.target.targetId, this.target); root.emit('Target.targetCreated', { targetInfo: this.target })
      this.cdp = new EventEmitter(); this.cdp.send = async (method: string, params: any) => { calls.push([method, params]); if (method === 'Page.addScriptToEvaluateOnNewDocument') this.script = params.source; if (method === 'Target.getTargetInfo') return { targetInfo: this.target }; return {} }
      const deliver = (event: string, data: any) => this.deliver(event, data)
      this.world = vm.createContext({ __hoaiPrivateRtcSignal: (payload: string) => this.cdp.emit('Runtime.bindingCalled', { name: '__hoaiPrivateRtcSignal', executionContextId: 7, payload }), RTCPeerConnection: class { constructor(_options: any) { const sequence = ++markerSequence; queueMicrotask(() => { if (!options.loseStartup && (!options.loseFinal || sequence === 1)) deliver('add-peer-connection', { rid: 99, lid: sequence }) }) } close() {} } })
    }
    url() { return this.target.url }
    isClosed() { return this.closed }
    async goto(url: string) { this.target.url = url; if (url.startsWith('chrome:')) { this.cdp.emit('Runtime.executionContextCreated', { context: { id: 7, origin: 'chrome://webrtc-internals', auxData: { isDefault: true } } }); vm.runInContext(this.script, this.world); vm.runInContext('cr={webUIResponse(){},webUIListenerCallback(){globalThis.stockPayloads=(globalThis.stockPayloads||0)+1}}', this.world) } }
    async evaluate(fn: any, arg?: any) { calls.push(['evaluate', fn.toString()]); return vm.runInContext('(' + fn.toString() + ')(' + JSON.stringify(arg) + ')', this.world) }
    deliver(event: string, data: any) { this.world.event = event; this.world.data = data; vm.runInContext('cr.webUIListenerCallback(event,data)', this.world); delete this.world.event; delete this.world.data }
    async close() { this.closed = true; targets.delete(this.target.targetId); root.emit('Target.targetDestroyed', { targetId: this.target.targetId }); this.emit('close') }
  }
  Object.assign(browser, { isConnected: () => true, version: async () => RTC_BROWSER_VERSION, contexts: () => [...nativeContexts], newContext: async () => {
    const pages: any[] = [], context: any = { id: 'context-' + ++contextSequence, pages: () => pages.filter(p => !p.isClosed()), newPage: async () => { const page = new Page(context); pages.push(page); return page }, newCDPSession: async (page: any) => page.cdp,
      close: async () => { if (options.delayedClose) await new Promise(resolve => setImmediate(resolve)); for (const page of pages) await page.close(); nativeContexts.splice(nativeContexts.indexOf(context), 1) } }
    nativeContexts.push(context); return context
  } })
  const create = async (overrides: any = {}) => { const observer = await createChromiumRtcActivity({ browser, root, authority, browserVersion: RTC_BROWSER_VERSION, processIdentity: { pid: 123, started: '1234' }, timeoutMs: 30, ...overrides }); t.after(() => observer.dispose()); return observer }
  const bind = async (observer: any) => { const context = await browser.newContext(); await observer.bindContext({ context, contextId: context.id }); return { authority, context, browserVersion: RTC_BROWSER_VERSION } }
  return { authority, browser, root, calls, targets, nativeContexts, create, bind }
}

test('exact native version and empty exclusive Browser are required before observer startup', async t => {
  const f = fixture(t); await assert.rejects(f.create({ browserVersion: '155.0.8059.40' }), /version_unqualified/); assert.equal(f.nativeContexts.length, 0)
  await f.browser.newContext(); await assert.rejects(f.create(), /exclusive_browser_required/); assert.equal(f.nativeContexts.length, 1)
})
test('startup native marker derives only private rid and permits clean exact owned context qualification', async t => {
  const f = fixture(t), observer = await f.create(), scope = await f.bind(observer); assert.equal(observer.kind, 'qualified-chromium-native-observer-v1'); assert.equal(observer.assertQualified(scope), true)
  assert.equal(await observer.confirmStopped({ ...scope, assertPhysicalZero: async () => true }), true)
  assert.equal(vm.runInContext('globalThis.stockPayloads||0', observer.privatePage.world), 0); assert.equal(Object.hasOwn(observer, 'controlRid'), false)
})
test('pre-document filter never forwards peer metadata and closed later RTC refuses movement', async t => {
  const f = fixture(t), observer = await f.create(), scope = await f.bind(observer)
  const native: any = { rid: 8, lid: 1 }; Object.defineProperty(native, 'url', { get() { throw Error('must not read foreign URL') } }); observer.privatePage.deliver('add-peer-connection', native); observer.privatePage.deliver('remove-peer-connection', native)
  assert.throws(() => observer.assertQualified(scope), /history_unqualified/); assert.equal(vm.runInContext('globalThis.stockPayloads||0', observer.privatePage.world), 0)
})
test('unknown or ambiguous contexts and preexisting owned targets cannot be bound by URL or a copied context', async t => {
  for (const mode of ['other-context', 'preexisting-target']) {
    const f = fixture(t), observer = await f.create(), context = await f.browser.newContext()
    if (mode === 'other-context') await f.browser.newContext(); else await context.newPage()
    await assert.rejects(observer.bindContext({ context, contextId: context.id }), /inventory_unqualified/)
  }
  const f = fixture(t), observer = await f.create(), scope = await f.bind(observer); assert.throws(() => observer.assertQualified({ ...scope, context: {} }), /scope_unqualified/); assert.throws(() => observer.assertQualified({ ...scope, authority: { ...scope.authority, actingUserId: 'sharer' } }), /scope_unqualified/)
})
test('missing first native callback refuses setup and missing final callback latches refusal', async t => {
  const f = fixture(t, { loseStartup: true }); await assert.rejects(f.create(), /callback_timeout/); assert.equal(f.nativeContexts.length, 0)
  const other = fixture(t, { loseFinal: true }), observer = await other.create(), scope = await other.bind(observer); await assert.rejects(observer.confirmStopped({ ...scope, assertPhysicalZero: async () => true }), /callback_timeout/); assert.throws(() => observer.assertQualified(scope), /callback_timeout/)
})
test('physical zero is checked before marker and checked again after the native acknowledgement', async t => {
  const f = fixture(t), observer = await f.create(), scope = await f.bind(observer); let checks = 0
  await assert.rejects(observer.confirmStopped({ ...scope, assertPhysicalZero: async () => ++checks === 1 }), /stop_unconfirmed/); assert.equal(checks, 2)
  const before = f.calls.filter(v => v[0] === 'evaluate').length; await assert.rejects(observer.confirmStopped({ ...scope, assertPhysicalZero: async () => false }), /stop_unconfirmed/); assert.equal(f.calls.filter(v => v[0] === 'evaluate').length, before)
})
test('coherent reflected native signals from another context or wrong token cannot become authority', async t => {
  for (const mode of ['context', 'token']) { const f = fixture(t), observer = await f.create(), scope = await f.bind(observer); observer.cdp.emit('Runtime.bindingCalled', { name: '__hoaiPrivateRtcSignal', executionContextId: mode === 'context' ? 8 : 7, payload: JSON.stringify({ token: mode === 'token' ? 'wrong' : observer.token, used: false, failed: false }) }); assert.throws(() => observer.assertQualified(scope), /protocol_unqualified/) }
})
test('native rid and current snapshot budgets and target histories are bounded', async t => {
  const f = fixture(t), observer = await f.create(), scope = await f.bind(observer); let enumerated=0;const oversized=new Proxy(new Array(RTC_MAX_HISTORY+1),{get(target,key,receiver){if(typeof key==='string'&&/^\d+$/.test(key)){enumerated++;throw Error('must reject before traversal')}return Reflect.get(target,key,receiver)}});observer.privatePage.deliver('update-all-peer-connections',oversized);assert.equal(enumerated,0); assert.throws(() => observer.assertQualified(scope), /history_unqualified/)
  const other = fixture(t), second = await other.create(), bound = await other.bind(second); other.root.emit('Target.targetCreated', { targetInfo: { targetId: 'unknown', browserContextId: 'foreign-context', type: 'page', url: 'https://fixture.invalid' } }); assert.throws(() => second.assertQualified(bound), /inventory_unqualified/)
})
test('private context destruction is awaited and its listeners do not survive disposal', async t => {
  const f = fixture(t, { delayedClose: true }), observer = await f.create(); const close = observer.dispose(); assert.equal(observer.privatePage.isClosed(), false); assert.equal(observer.dispose(), close); await close; assert.equal(observer.privatePage.isClosed(), true); assert.equal(f.root.listenerCount('Target.targetCreated'), 0); assert.equal(observer.cdp.listenerCount('Runtime.bindingCalled'), 0)
})
test('native browser process identity and observer context loss always refuse', async t => {
  const f = fixture(t, { wrongPid: true }); await assert.rejects(f.create(), /inventory_unqualified/)
  const other = fixture(t), observer = await other.create(), scope = await other.bind(observer); observer.cdp.emit('Runtime.executionContextsCleared'); assert.throws(() => observer.assertQualified(scope), /observer_lost/)
})

test('authority admission rejects extra, missing and inherited scalar fields',async t=>{const f=fixture(t),observer=await f.create(),scope=await f.bind(observer);for(const authority of [{...scope.authority,extra:'untrusted'},Object.fromEntries(Object.entries(scope.authority).filter(([key])=>key!=='revision')),Object.create(scope.authority)])assert.throws(()=>observer.assertQualified({...scope,authority}),/authority_invalid/)})
