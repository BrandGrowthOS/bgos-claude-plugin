import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { RemoteCredentials, credentialDocument } from '../lib/remote-credentials.mjs'
import { runAgentBrowserWork } from '../lib/remote-input.mjs'
import credentialCrypto from '../lib/remote-credentials-crypto.cjs'

const deferred = () => {
  let resolve!: (value?: any) => void
  const promise = new Promise<any>(done => { resolve = done })
  return { promise, resolve }
}

function fixture(options: any = {}) {
  class Element {
    isConnected = true
    parentElement = null
    style = { visibility: 'visible', display: 'block', opacity: '1' }
  }
  class Input extends Element {
    type: string
    disabled = false
    readOnly = false
    form: any
    labels: any[] = []
    attrs: any
    hidden = false
    stored = ''
    events: string[] = []
    onEvent: ((event: any) => void) | null = null
    constructor(type: string, attrs: any) { super(); this.type = type; this.attrs = attrs }
    get value() { return this.stored }
    set value(value: string) { this.stored = value }
    getAttribute(name: string) { return this.attrs[name] || null }
    getClientRects() { return this.hidden ? [] : [{}] }
    getBoundingClientRect() { return { width: 200, height: 30, left: 20, top: 20, right: 220, bottom: 50 } }
    dispatchEvent(event: any) { this.events.push(event.type); this.onEvent?.(event); return true }
  }
  const location = new URL(options.url || 'https://example.test/login')
  const form: any = Object.assign(new Element(), { action: location.href, target: '', id: 'login', name: '', getAttribute: () => null })
  const username = new Input('text', { name: 'username', autocomplete: 'username' })
  const password = new Input('password', { name: 'password', autocomplete: 'current-password' })
  username.form = form; password.form = form
  const inputs: any[] = [username, password]
  const document: any = {
    inputs, iframe: false,
    querySelector(selector: string) { return selector === 'iframe, frame' && this.iframe ? {} : null },
    querySelectorAll() { return inputs },
    getElementById() { return null },
  }
  form.ownerDocument = document
  const window: any = {}; window.top = window
  const sandbox: any = { document, location, window, URL, Element, HTMLInputElement: Input, innerWidth: 1024, innerHeight: 768,
    getComputedStyle: (element: any) => element.style, Event: class { type: string; constructor(type: string) { this.type = type } } }
  const context = vm.createContext(sandbox)
  const evaluate = (fn: any, args: any[]) => {
    sandbox.args = args
    return new vm.Script(`(${fn.toString()})(...args)`).runInContext(context)
  }
  const handles: any[] = [], calls: any[] = []
  const browserContext = { testContext: true, closed: false, async close() { this.closed = true } }
  const page: any = {
    url: () => location.href, context: () => browserContext,
    async evaluateHandle(fn: any, arg: any) {
      const target = evaluate(fn, [arg])
      const handle: any = {
        disposed: false, gate: null,
        async evaluate(fn: any, arg: any) {
          calls.push(arg)
          if (handle.gate) await handle.gate.promise
          return evaluate(fn, [target, arg])
        },
        async dispose() { handle.disposed = true },
      }
      handles.push(handle)
      return handle
    },
  }
  const engine = { registerSecret: (_secret: string) => {} }, slot: any = { engine, runningTools: new Set() }
  const view: any = { viewId: 'view_one', sessionId: 'session_one', tabId: 'tab_one', engine, page,
    context: { assistantId: 91, principal: 'user-owner' } }
  let live = true, now = Date.now()
  const initialNow = now
  const saved: any[] = [], removed: any[] = [], restored: any[] = [], unlocks: any[] = []
  const entries: any[] = [{ id: 'login_one', origin: location.origin, username: 'saved-user', password: 'saved-secret' }]
  const storage: any = {
    unlocked: options.unlocked !== false,
    status() { return { configured: true, unlocked: this.unlocked, legacy: false } },
    list(origin: string) { return entries.filter(entry => entry.origin === origin) },
    readLogin(id: string, origin: string) { return entries.find(entry => entry.id === id && entry.origin === origin) },
    async saveLogin(login: any) { saved.push(login) },
    async removeLogin(id: string, origin: string) { removed.push({ id, origin }) },
    async unlock(passphrase: string, options: any) { unlocks.push({ passphrase, options }); this.unlocked = true },
    async restore(context: any) { restored.push(context) },
    async lock() { this.unlocked = false },
  }
  const revocations: any[] = []
  const credentials = new RemoteCredentials({ current: () => live ? slot : null, storageFor: () => storage,
    revoked: view => { revocations.push(view) },
    now: () => now, drainMs: options.drainMs || 50, offerMs: options.offerMs || 120_000 })
  const prepare = (operation = 'login') => credentials.prepare(view, { operation })
  const commit = (prepared: any, body: any) => credentials.commit(view, credentialCrypto.sealOffer(prepared.offer, body))
  return { credentials, view, slot, storage, saved, removed, restored, unlocks, entries, location, document, form, inputs,
    username, password, handles, calls, Input, sandbox, evaluate, prepare, commit, initialNow, revocations, browserContext,
    setLive: (value: boolean) => { live = value }, advance: (value: number) => { now += value } }
}

test('new login fills exact captured fields, never submits, and waits for separate save consent', async () => {
  const f = fixture()
  const prepared = await f.prepare()
  assert.equal(prepared.offer.operation, 'login')
  assert.equal(prepared.offer.assistantId, 91)
  assert.equal(prepared.offer.principal, 'user-owner')
  assert.equal(prepared.offer.origin, 'https://example.test')
  assert.equal(prepared.offer.expiresAt, f.initialNow + 120_000)
  assert.deepEqual(prepared.entries, [{ id: 'login_one', origin: 'https://example.test', username: 'saved-user' }])
  assert.equal(JSON.stringify(prepared).includes('saved-secret'), false)
  const applied = await f.commit(prepared, { username: 'alice', password: 'local-fixture-secret' })
  assert.equal(f.username.value, 'alice')
  assert.equal(f.password.value, 'local-fixture-secret')
  assert.deepEqual(f.username.events, ['input', 'change'])
  assert.deepEqual(f.password.events, ['input', 'change'])
  assert.equal(applied.applied, true)
  assert.equal('password' in applied.pending, false)
  assert.equal(f.saved.length, 0)
  assert.ok(f.slot.ownerInputLease)
  await assert.rejects(async () => runAgentBrowserWork(f.slot, async () => {}), { code: 'owner_control' })
  assert.deepEqual(await f.credentials.save(f.view, { pendingId: applied.pending.pendingId, save: true }), { saved: true })
  assert.deepEqual(f.saved, [{ origin: 'https://example.test', username: 'alice', password: 'local-fixture-secret' }])
  assert.equal(f.slot.ownerInputLease, null)
  assert.equal(f.handles[0].disposed, false)
  assert.ok(f.view.credentialSubmit)
  await f.credentials.close(f.view)
  assert.equal(f.handles[0].disposed, true)
})

test('declining save discards the pending secret and frees the agent lease', async () => {
  const f = fixture(), prepared = await f.prepare()
  const applied = await f.commit(prepared, { username: 'alice', password: 'secret' })
  assert.deepEqual(await f.credentials.save(f.view, { pendingId: applied.pending.pendingId, save: false }), { saved: false })
  assert.equal(f.saved.length, 0)
  assert.equal(f.view.credentialLease, null)
  assert.equal(f.view.credentialDrain.pending, null)
  assert.equal(f.slot.ownerInputLease, null)
})

test('saved fill and forget bind lookup to exact current origin', async () => {
  const f = fixture()
  assert.deepEqual(await f.commit(await f.prepare('fill'), { id: 'login_one' }), { applied: true, pending: null })
  assert.equal(f.username.value, 'saved-user')
  assert.equal(f.password.value, 'saved-secret')
  assert.equal(f.saved.length, 0)
  assert.equal(f.slot.ownerInputLease, null)
  assert.deepEqual(await f.commit(await f.prepare('forget'), { id: 'login_one' }), { removed: true })
  assert.deepEqual(f.removed, [{ id: 'login_one', origin: 'https://example.test' }])
})

test('unlock supports a fresh blank document and restores into its exact browser context', async () => {
  const f = fixture({ unlocked: false, url: 'about:blank' })
  const prepared = await f.prepare('unlock')
  assert.equal(prepared.offer.origin, '')
  assert.deepEqual(prepared.entries, [])
  assert.deepEqual(await f.commit(prepared, { passphrase: 'fixture passphrase', clearLegacy: true }), { unlocked: true })
  assert.deepEqual(f.unlocks, [{ passphrase: 'fixture passphrase', options: { clearLegacy: true } }])
  assert.equal(f.restored[0], f.view.page.context())
  assert.equal(f.slot.ownerInputLease, null)
})

test('unlock metadata contains only logins for the exact current safe origin', async () => {
  const f = fixture()
  f.entries.push({ id: 'foreign', origin: 'https://foreign.test', username: 'foreign', password: 'foreign-secret' })
  const prepared = await f.prepare('unlock')
  assert.equal(prepared.offer.origin, 'https://example.test')
  assert.deepEqual(prepared.entries, [{ id: 'login_one', origin: 'https://example.test', username: 'saved-user' }])
  await f.credentials.close(f.view)
})

test('cancelling physical unlock locks its late result before the agent lease is released', async () => {
  const f = fixture({ unlocked: false, drainMs: 5 }), prepared = await f.prepare('unlock')
  const entered = deferred(), gate = deferred(), lockGate = deferred()
  f.storage.unlock = async () => { entered.resolve(); await gate.promise; f.storage.unlocked = true }
  f.storage.lock = async () => { await lockGate.promise; f.storage.unlocked = false }
  const unlocking = f.commit(prepared, { passphrase: 'fixture passphrase' })
  const rejection = assert.rejects(unlocking, { code: 'credential_expired' })
  await entered.promise
  await f.credentials.close(f.view)
  assert.ok(f.slot.ownerInputLease)
  gate.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(f.slot.ownerInputLease)
  assert.equal(f.restored.length, 0)
  lockGate.resolve()
  await rejection
  assert.equal(f.storage.unlocked, false)
  assert.equal(f.slot.ownerInputLease, null)
  assert.equal(f.browserContext.closed, false)
})

test('cancelling physical restore locks the vault after restoration finishes', async () => {
  const f = fixture({ unlocked: false, drainMs: 5 }), prepared = await f.prepare('unlock')
  const entered = deferred(), gate = deferred()
  f.storage.restore = async () => { entered.resolve(); await gate.promise }
  const unlocking = f.commit(prepared, { passphrase: 'fixture passphrase' })
  const rejection = assert.rejects(unlocking, { code: 'credential_expired' })
  await entered.promise
  await f.credentials.close(f.view)
  assert.ok(f.slot.ownerInputLease)
  gate.resolve()
  await rejection
  assert.equal(f.storage.unlocked, false)
  assert.equal(f.slot.ownerInputLease, null)
  assert.equal(f.browserContext.closed, true)
})

test('a failed engine stop after restore keeps the slot blocked', async () => {
  const f = fixture({ unlocked: false }), prepared = await f.prepare('unlock')
  let stopCalled = false
  f.view.engine.stop = async () => { stopCalled = true; throw new Error('cannot terminate fixture engine') }
  f.storage.restore = async () => { f.credentials.cancel(f.view) }
  await assert.rejects(f.commit(prepared, { passphrase: 'fixture passphrase' }), { code: 'credential_expired' })
  assert.equal(stopCalled, true)
  assert.ok(f.slot.ownerInputLease)
  assert.equal(f.slot.ownerInputLease.cleanupFailed, true)
  await assert.rejects(async () => runAgentBrowserWork(f.slot, async () => {}), { code: 'owner_control' })
})

test('normal operation completion is quiet and involuntary revocation emits once', async () => {
  const f = fixture()
  await f.commit(await f.prepare('fill'), { id: 'login_one' })
  assert.equal(f.revocations.length, 0)
  await f.prepare()
  f.credentials.cancel(f.view)
  assert.equal(f.revocations.length, 0)
  await f.prepare()
  await f.credentials.close(f.view)
  await f.credentials.close(f.view)
  assert.deepEqual(f.revocations, [f.view])
})

test('browser and vault failures expose only fixed safe errors', async () => {
  const f = fixture()
  f.view.page.evaluateHandle = async () => { throw new Error('password=private fixture text') }
  await assert.rejects(f.prepare(), (error: any) => error.code === 'credential_unavailable' && !error.message.includes('fixture'))
  assert.equal(f.slot.ownerInputLease, null)
  f.storage.status = () => { throw Object.assign(new Error('sensitive native path'), { code: 'unsafe_profile' }) }
  await assert.rejects(f.prepare(), (error: any) => error.code === 'credential_storage' && !error.message.includes('path'))
})

test('a locked vault refuses login, fill and forget without reserving a lease', async () => {
  const f = fixture({ unlocked: false })
  for (const operation of ['login', 'fill', 'forget']) await assert.rejects(f.prepare(operation), { code: 'credential_locked' })
  assert.equal(f.slot.ownerInputLease, undefined)
})

test('reserves before draining physical agent work and refuses an existing B lease', async () => {
  const f = fixture(), work = deferred()
  f.slot.runningTools.add(work.promise)
  const preparing = f.prepare()
  const reserved = f.slot.ownerInputLease
  assert.ok(reserved)
  await assert.rejects(async () => runAgentBrowserWork(f.slot, async () => {}), { code: 'owner_control' })
  assert.equal(f.handles.length, 0)
  work.resolve()
  await preparing
  assert.equal(f.slot.ownerInputLease, reserved)
  f.credentials.cancel(f.view)
  const bLease = { id: 'b_lease' }
  f.slot.ownerInputLease = bLease
  await assert.rejects(f.prepare(), { code: 'credential_busy' })
  assert.equal(f.slot.ownerInputLease, bLease)
})

test('a rejected second prepare revokes the old credential offer without stealing any B lease', async () => {
  const f = fixture()
  await f.prepare()
  await assert.rejects(f.prepare(), { code: 'credential_busy' })
  assert.equal(f.slot.ownerInputLease, null)
  assert.equal(f.view.credentialLease, null)
})

test('agent work drain has a bounded deadline and does not capture a target on timeout', async () => {
  const f = fixture({ drainMs: 5 })
  f.slot.runningTools.add(new Promise(() => {}))
  await assert.rejects(f.prepare(), { code: 'credential_busy' })
  assert.equal(f.handles.length, 0)
  assert.equal(f.slot.ownerInputLease, null)
})

test('offers are one use and authenticated against tampering', async () => {
  const f = fixture(), prepared = await f.prepare()
  const envelope = credentialCrypto.sealOffer(prepared.offer, { username: 'alice', password: 'secret' })
  const bad = { ...envelope, tag: Buffer.alloc(16, 0).toString('base64') }
  await assert.rejects(f.credentials.commit(f.view, bad), { code: 'credential_envelope' })
  await assert.rejects(f.credentials.commit(f.view, envelope), { code: 'credential_expired' })
  assert.equal(f.password.value, '')
  assert.equal(f.slot.ownerInputLease, null)
})

test('a successful offer cannot be reused while save confirmation is pending', async () => {
  const f = fixture(), prepared = await f.prepare()
  const envelope = credentialCrypto.sealOffer(prepared.offer, { username: 'alice', password: 'secret' })
  await f.credentials.commit(f.view, envelope)
  await assert.rejects(f.credentials.commit(f.view, envelope), { code: 'credential_expired' })
  await f.credentials.close(f.view)
})

test('expiry and engine replacement revoke without applying or retaining pending secrets', async () => {
  for (const invalidate of [(f: any) => f.advance(120_001), (f: any) => f.setLive(false)]) {
    const f = fixture(), prepared = await f.prepare()
    invalidate(f)
    await assert.rejects(f.commit(prepared, { username: 'alice', password: 'secret' }), { code: 'credential_expired' })
    assert.equal(f.password.value, '')
    assert.equal(f.slot.ownerInputLease, null)
    assert.equal(f.view.credentialDrain.privateKey, null)
  }
})

test('same-origin document replacement and same-selector input replacement both fail closed', async () => {
  for (const replace of [
    (f: any) => { f.sandbox.document = { ...f.document } },
    (f: any) => { const input = new f.Input('password', { autocomplete: 'current-password' }); input.form = f.form; f.inputs[1] = input },
  ]) {
    const f = fixture(), prepared = await f.prepare()
    replace(f)
    await assert.rejects(f.commit(prepared, { username: 'alice', password: 'secret' }), { code: 'credential_changed' })
    assert.equal(f.password.value, '')
    assert.equal(f.slot.ownerInputLease, null)
  }
})

test('navigation while a physical fill is pending retains the lease until that work settles', async () => {
  const f = fixture({ drainMs: 5 }), prepared = await f.prepare(), gate = deferred()
  f.handles[0].gate = gate
  const committing = f.commit(prepared, { username: 'alice', password: 'secret' })
  const rejection = assert.rejects(committing, { code: 'credential_expired' })
  await f.credentials.close(f.view)
  assert.ok(f.slot.ownerInputLease)
  await assert.rejects(async () => runAgentBrowserWork(f.slot, async () => {}), { code: 'owner_control' })
  gate.resolve()
  await rejection
  assert.equal(f.password.value, '')
  assert.equal(f.slot.ownerInputLease, null)
})

test('cancellation during save retains the slot until physical storage work drains', async () => {
  const f = fixture({ drainMs: 5 }), prepared = await f.prepare()
  const applied = await f.commit(prepared, { username: 'alice', password: 'secret' })
  const entered = deferred(), gate = deferred()
  f.storage.saveLogin = async () => { entered.resolve(); await gate.promise }
  const saving = f.credentials.save(f.view, { pendingId: applied.pending.pendingId, save: true })
  const rejection = assert.rejects(saving, { code: 'credential_expired' })
  await entered.promise
  await f.credentials.close(f.view)
  assert.ok(f.slot.ownerInputLease)
  gate.resolve()
  await rejection
  assert.equal(f.slot.ownerInputLease, null)
})

test('page events that change the form invalidate the fill result and never create pending save', async () => {
  const f = fixture(), prepared = await f.prepare()
  f.username.onEvent = () => { f.form.action = 'https://foreign.test/steal' }
  await assert.rejects(f.commit(prepared, { username: 'alice', password: 'secret' }), { code: 'credential_changed' })
  assert.deepEqual(f.username.events, ['input'])
  assert.deepEqual(f.password.events, [])
  assert.equal(f.view.credentialLease, null)
  assert.equal(f.saved.length, 0)
})

test('strict policy accepts only ordinary exact-origin login forms', async t => {
  const cases: [string, (f: any) => void][] = [
    ['insecure origin', f => { f.location.href = 'http://example.test/login' }],
    ['foreign form action', f => { f.form.action = 'https://foreign.test/login' }],
    ['foreign form target', f => { f.form.target = '_blank' }],
    ['hidden password', f => { f.password.hidden = true }],
    ['transparent username', f => { f.username.style.opacity = '0' }],
    ['disabled password', f => { f.password.disabled = true }],
    ['readonly username', f => { f.username.readOnly = true }],
    ['signup form', f => { f.form.id = 'signup' }],
    ['signup form wording', f => { f.form.textContent = 'Create your account' }],
    ['new password', f => { f.password.attrs.autocomplete = 'new-password' }],
    ['OTP field', f => { f.username.attrs.autocomplete = 'one-time-code' }],
    ['payment field', f => { f.username.attrs.autocomplete = 'cc-number' }],
    ['credential file', f => { const input = new f.Input('file', {}); input.form = f.form; f.inputs.push(input) }],
    ['ambiguous username', f => { const input = new f.Input('text', {}); input.form = f.form; f.inputs.push(input) }],
    ['second hidden password', f => { const input = new f.Input('password', {}); input.hidden = true; input.form = f.form; f.inputs.push(input) }],
    ['iframe', f => { f.document.iframe = true }],
    ['embedded document', f => { f.sandbox.window.top = {} }],
    ['no form', f => { f.password.form = null }],
  ]
  for (const [name, change] of cases) await t.test(name, async () => {
    const f = fixture(); change(f)
    await assert.rejects(f.prepare(), (error: any) => ['unsafe_form', 'credential_changed'].includes(error.code))
    assert.equal(f.password.value, '')
    assert.equal(f.slot.ownerInputLease ?? null, null)
  })
})

test('loopback HTTP is accepted for disposable local login fixtures', async () => {
  const f = fixture({ url: 'http://127.0.0.1:32100/login' }), prepared = await f.prepare()
  const result = await f.commit(prepared, { username: 'fixture', password: 'fixture-secret' })
  assert.equal(result.applied, true)
  await f.credentials.close(f.view)
})

test('document recheck detects changed policy after prepare before any field is written', async () => {
  const f = fixture(), prepared = await f.prepare()
  f.password.attrs.autocomplete = 'new-password'
  await assert.rejects(f.commit(prepared, { username: 'alice', password: 'secret' }), { code: 'credential_changed' })
  assert.equal(f.username.value, '')
  assert.equal(f.password.value, '')
})

test('save consent is tied to pending ID and expires without persisting', async () => {
  const f = fixture(), prepared = await f.prepare()
  const result = await f.commit(prepared, { username: 'alice', password: 'secret' })
  await assert.rejects(f.credentials.save(f.view, { pendingId: 'different', save: true }), { code: 'credential_payload' })
  assert.equal(f.slot.ownerInputLease, null)
  const next = await f.commit(await f.prepare(), { username: 'alice', password: 'secret' })
  f.advance(120_001)
  await assert.rejects(f.credentials.save(f.view, { pendingId: next.pending.pendingId, save: true }), { code: 'credential_expired' })
  assert.equal(f.saved.length, 0)
  assert.equal(f.view.credentialDrain.pending, null)
})
