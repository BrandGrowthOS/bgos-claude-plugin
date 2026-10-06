import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChromiumEngine, browserPathsFor, resolveChromeExecutable } from '../bin/hoai-browser-host.mjs'
import { RemoteBrowserViews } from '../lib/remote-view.mjs'
import { RemoteCredentials } from '../lib/remote-credentials.mjs'
import { RemoteOwnerInput } from '../lib/remote-input.mjs'
import crypto from '../lib/remote-credentials-crypto.cjs'

async function fixture(t: any) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-normal-browser-')))
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html')
    const inputs = '<input id="user" name="username" autocomplete="username"><input id="password" name="password" type="password" autocomplete="current-password">'
    const button = '<button id="submit">Sign in</button>'
    const body = req.url === '/js' ? `<div id="js-login">${inputs}${button}</div>` :
      req.url === '/password-only' ? `<form><input id="password" type="password" autocomplete="current-password">${button}</form>` :
      req.url === '/plain' ? '<input id="ordinary"><a id="popup" href="/second" target="_blank">Open another tab</a>' :
      `<form id="signin">${inputs}${button}<a href="/otp">Email OTP</a><footer>Create your account</footer></form><iframe srcdoc="<p>unrelated captcha</p>"></iframe>`
    res.end(`<!doctype html><title>${req.url}</title>${body}<script>window.submitted=0;document.querySelector('form')?.addEventListener('submit',e=>{e.preventDefault();window.submitted++});document.querySelector('#js-login button')?.addEventListener('click',()=>window.submitted++)</script>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  const context = { assistantId: 901, principal: 'user-fixture' }
  const paths = browserPathsFor({ agentRoot: root, ...context })
  const engine: any = new ChromiumEngine({ ...paths, executable: process.env.HOAI_BROWSER_EXECUTABLE || resolveChromeExecutable({ env: process.env }).path })
  await engine.start()
  const slot: any = { engine, runningTools: new Set() }
  t.after(async () => { await engine.stop(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) })
  return { root, origin, context, engine, slot, paths, page: engine.pages()[0] }
}

test('owner normal browser creates, switches and closes real agent tabs and navigates history under its lease', { timeout: 45000 }, async t => {
  const f = await fixture(t)
  const frames: any[] = [], closes: any[] = []
  const pool: any = { peek: () => f.slot, slotKey: () => 'fixture' }
  const views = new RemoteBrowserViews({ pool })
  t.after(() => views.stop())
  await f.page.goto(f.origin + '/plain')
  await views.open({ viewId: 'normal-view', ...f.context }, { connectionId: 'fixture-host',
    sendFrame: (packet: any) => { frames.push(packet.frame); return true }, sendClose: (packet: any) => closes.push(packet) })
  const ready = frames.find(frame => frame.method === 'hoai.ready').params
  assert.equal(ready.remoteBrowser, true)
  let id = 0
  const state = () => {
    const frame = frames.filter(frame => frame.method === 'hoai.browser.state').at(-1)
    assert.equal(frame.sessionId, frame.params.sessionId)
    assert.equal(frame.tabId, frame.params.tabId)
    return frame.params
  }
  const command = async (method: string, params: any = {}, target = state()) => {
    const requestId = ++id
    await views.command({ viewId: 'normal-view', frame: { id: requestId, method, params, sessionId: target.sessionId, tabId: target.tabId } }, 'fixture-host')
    return frames.find(frame => frame.id === requestId)
  }
  const owner = async () => (await command('hoai.input.acquire')).result.leaseId
  const action = async (method: string, params: any) => {
    const reply = await command(method, params)
    assert.deepEqual(reply.result, {}, `${method} ${params.action || ''} ${JSON.stringify(reply.error)}`)
  }
  assert.equal((await command('hoai.browser.tab', { action: 'new', leaseId: 'missing' })).error.code, 'owner_lease_expired')
  const initial = state()
  await command('Page.startScreencast')
  assert.deepEqual((await command('hoai.browser.tab', { action: 'new', leaseId: await owner() })).result, {})
  assert.equal(state().tabs.length, 2)
  assert.equal(state().activeIndex, 1)
  assert.equal(state().sessionId, initial.sessionId)
  assert.notEqual(state().tabId, initial.tabId)
  assert.equal(f.engine.selectedPage(), f.engine.pages()[1])
  const ignored = frames.length
  assert.equal(await views.command({ viewId: 'normal-view', frame: { id: ++id, method: 'hoai.browser.navigate', params: { leaseId: 'old', url: f.origin }, sessionId: initial.sessionId, tabId: initial.tabId } }, 'fixture-host'), false)
  assert.equal(frames.length, ignored)
  await action('hoai.browser.navigate', { leaseId: await owner(), url: f.origin + '/second' })
  await action('hoai.browser.navigate', { leaseId: await owner(), url: f.origin + '/third' })
  assert.equal(state().tabs[state().activeIndex].canGoBack, true)
  await action('hoai.browser.navigation', { leaseId: await owner(), action: 'back' })
  assert.equal(f.engine.selectedPage().url(), f.origin + '/second')
  assert.equal(state().tabs[state().activeIndex].canGoForward, true)
  await action('hoai.browser.navigation', { leaseId: await owner(), action: 'forward' })
  assert.equal(f.engine.selectedPage().url(), f.origin + '/third')
  await action('hoai.browser.navigation', { leaseId: await owner(), action: 'reload' })
  await action('hoai.browser.navigation', { leaseId: await owner(), action: 'stop' })
  await action('hoai.browser.tab', { leaseId: await owner(), action: 'select', index: 0 })
  assert.equal(f.engine.selectedPage(), f.page)
  assert.equal(state().tabId, initial.tabId)
  const popupLease = await owner()
  const popupPromise = f.page.context().waitForEvent('page')
  await f.page.locator('#popup').click()
  const popup = await popupPromise
  await popup.waitForLoadState('domcontentloaded')
  const popupDeadline = Date.now() + 3000
  while (state().tabs.length !== 3 || state().activeIndex !== 2) {
    if (Date.now() > popupDeadline) throw new Error('The owner popup did not become the selected remote tab')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(popupLease)
  assert.equal(f.engine.selectedPage(), popup)
  await action('hoai.browser.tab', { leaseId: await owner(), action: 'close', index: 2 })
  await action('hoai.browser.tab', { leaseId: await owner(), action: 'select', index: 0 })
  await action('hoai.browser.tab', { leaseId: await owner(), action: 'close', index: 1 })
  assert.equal(state().tabs.length, 1)
  await action('hoai.browser.tab', { leaseId: await owner(), action: 'close', index: 0 })
  assert.equal(state().tabs.length, 1)
  assert.equal(state().tabs[0].url, 'about:blank')
  assert.equal(closes.length, 0)
  assert.equal((await command('hoai.browser.navigate', { leaseId: await owner(), url: 'javascript:alert(1)' })).error.code, 'invalid_browser_url')
  await command('hoai.input.release')
  const watched = state().tabId
  const background = await f.engine.selectedPage().context().newPage()
  await views._state(views.views.get('normal-view'))
  assert.equal(state().tabId, watched, 'A background page event must not steal the watched tab')
  await f.engine.callTool('browser_tabs', { action: 'select', index: 1 })
  await views.views.get('normal-view').tail
  assert.equal(f.engine.selectedPage(), background)
  assert.equal(state().activeIndex, 1, 'After agent selection the watched tab follows the selected MCP page')
  await background.goto(f.origin + '/plain')
  f.engine.registerSecret('t')
  f.engine.registerSecret('1')
  await views._state(views.views.get('normal-view'))
  assert.match(state().tabId, /^tab_/)
  assert.match(state().sessionId, /^remote_/)
  for (const tab of state().tabs) assert.ok(['http:', 'https:', 'about:'].includes(new URL(tab.url).protocol))
  assert.equal(new URL(state().tabs[state().activeIndex].url).origin, f.origin)
  // Metadata and owner tab creation share one bounded roster.
  for (let index = f.engine.pages().length; index < 16; index++) await background.context().newPage()
  await views._state(views.views.get('normal-view'))
  assert.equal(state().tabs.length, 16)
  assert.equal((await command('hoai.browser.tab', { leaseId: await owner(), action: 'new' })).error.code, 'browser_tabs_full')
  assert.equal(f.engine.pages().length, 16)
})

test('first native storage setup keeps the current completed sign-in and restores it encrypted after restart', { timeout: 45000 }, async t => {
  const f = await fixture(t)
  await f.page.goto(f.origin + '/plain')
  await f.page.context().addCookies([{ name: 'session', value: 'CANARY-fresh-signin-cookie', url: f.origin }])
  await f.page.evaluate(() => localStorage.setItem('signed-in', 'CANARY-fresh-signin-local'))
  await f.page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('fresh-login', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('tokens')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const transaction = request.result.transaction('tokens', 'readwrite')
      transaction.objectStore('tokens').put('CANARY-fresh-signin-idb', 'token')
      transaction.oncomplete = () => { request.result.close(); resolve() }
      transaction.onerror = () => reject(transaction.error)
    }
  }))
  const idbValue = () => new Promise<string>((resolve, reject) => {
    const request = indexedDB.open('fresh-login', 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const read = request.result.transaction('tokens').objectStore('tokens').get('token')
      read.onsuccess = () => { request.result.close(); resolve(read.result) }
      read.onerror = () => reject(read.error)
    }
  })
  const view: any = { viewId: 'fresh-vault-view', sessionId: 'fixture-session', tabId: 'fixture-tab', engine: f.engine, page: f.page, context: f.context }
  const credentials = new RemoteCredentials({ current: () => f.slot, storageFor: () => f.engine.vault })
  t.after(() => credentials.close(view))
  const prepared = await credentials.prepare(view, { operation: 'unlock' })
  assert.equal(prepared.storage.configured, false)
  await credentials.commit(view, crypto.sealOffer(prepared.offer, { passphrase: 'disposable vault passphrase 123' }))
  assert.equal((await f.page.context().cookies())[0].value, 'CANARY-fresh-signin-cookie')
  assert.equal(await f.page.evaluate(() => localStorage.getItem('signed-in')), 'CANARY-fresh-signin-local')
  assert.equal(await f.page.evaluate(idbValue), 'CANARY-fresh-signin-idb')
  const ciphertext = readFileSync(f.engine.vault.file, 'utf8')
  assert.equal(ciphertext.includes('CANARY-fresh-signin-cookie'), false)
  assert.equal(ciphertext.includes('CANARY-fresh-signin-local'), false)
  assert.equal(ciphertext.includes('CANARY-fresh-signin-idb'), false)
  await f.engine.stop()
  await f.engine.start()
  const reopened = f.engine.pages()[0]
  await f.engine.vault.unlock('disposable vault passphrase 123')
  await f.engine.vault.restore(reopened.context())
  await reopened.goto(f.origin + '/plain')
  assert.equal((await reopened.context().cookies())[0].value, 'CANARY-fresh-signin-cookie')
  assert.equal(await reopened.evaluate(() => localStorage.getItem('signed-in')), 'CANARY-fresh-signin-local')
  assert.equal(await reopened.evaluate(idbValue), 'CANARY-fresh-signin-idb')
})

test('real sign-in with unrelated iframe, signup footer and alternative Email OTP fills and saves encrypted login', { timeout: 45000 }, async t => {
  const f = await fixture(t)
  await f.page.goto(f.origin + '/login')
  await f.engine.vault.unlock('disposable vault passphrase 123')
  await f.engine.vault.restore(f.page.context())
  const view: any = { viewId: 'login-view', sessionId: 'fixture-session', tabId: 'fixture-tab', engine: f.engine, page: f.page, context: f.context }
  const credentials = new RemoteCredentials({ current: () => f.slot, storageFor: () => f.engine.vault })
  t.after(() => credentials.close(view))
  const prepared = await credentials.prepare(view, { operation: 'login' })
  const applied = await credentials.commit(view, crypto.sealOffer(prepared.offer, { username: 'fixture-user', password: 'CANARY-normal-login-password' }))
  assert.equal(await f.page.locator('#password').inputValue(), 'CANARY-normal-login-password')
  assert.equal(await f.page.evaluate(() => (window as any).submitted), 0)
  assert.deepEqual(f.engine.vault.list(f.origin), [])
  await credentials.save(view, { pendingId: applied.pending.pendingId, save: true })
  assert.equal(f.engine.vault.list(f.origin).length, 1)
  const saved = readFileSync(f.engine.vault.file, 'utf8')
  assert.equal(saved.includes('CANARY-normal-login-password'), false)
  assert.equal(saved.includes('fixture-user'), false)
})

test('JavaScript and password-only login pages keep exact capture checks and permit explicit login save', { timeout: 45000 }, async t => {
  const f = await fixture(t)
  await f.engine.vault.unlock('disposable vault passphrase 123')
  await f.engine.vault.restore(f.page.context())
  const view: any = { viewId: 'js-view', sessionId: 'fixture-session', tabId: 'fixture-tab', engine: f.engine, page: f.page, context: f.context }
  const credentials = new RemoteCredentials({ current: () => f.slot, storageFor: () => f.engine.vault })
  t.after(() => credentials.close(view))
  for (const path of ['/js', '/password-only']) {
    await f.page.goto(f.origin + path)
    const prepared = await credentials.prepare(view, { operation: 'login' })
    const applied = await credentials.commit(view, crypto.sealOffer(prepared.offer, { username: 'fixture-user', password: 'CANARY-js-login-password' }))
    assert.equal(await f.page.locator('#password').inputValue(), 'CANARY-js-login-password')
    assert.equal(await f.page.evaluate(() => (window as any).submitted), 0)
    await credentials.save(view, { pendingId: applied.pending.pendingId, save: true })
    const again = await credentials.prepare(view, { operation: 'login' })
    await f.page.locator('#password').evaluate((element: any) => element.replaceWith(element.cloneNode()))
    await assert.rejects(credentials.commit(view, crypto.sealOffer(again.offer, { username: 'fixture', password: 'replacement-secret' })), { code: 'credential_changed' })
    assert.notEqual(await f.page.locator('#password').inputValue(), 'replacement-secret')
  }
})

test('native sealed field entry works while locked and manual Save login works without a form', { timeout: 45000 }, async t => {
  const f = await fixture(t)
  await f.page.goto(f.origin + '/login')
  const view: any = { viewId: 'field-view', sessionId: 'fixture-session', tabId: 'fixture-tab', engine: f.engine, page: f.page, context: f.context }
  const credentials = new RemoteCredentials({ current: () => f.slot, storageFor: () => f.engine.vault })
  t.after(() => credentials.close(view))
  const box = await f.page.locator('#password').boundingBox()
  const prepared = await credentials.prepare(view, { operation: 'field', point: { x: box!.x + 5, y: box!.y + 5 } })
  assert.deepEqual(prepared.field, { kind: 'password' })
  assert.equal(prepared.storage.unlocked, false)
  const applied = await credentials.commit(view, crypto.sealOffer(prepared.offer, { value: 'CANARY-field-password' }))
  assert.deepEqual(applied, { applied: true, pending: null })
  assert.equal(await f.page.locator('#password').inputValue(), 'CANARY-field-password')
  assert.equal(await f.page.evaluate(() => (window as any).submitted), 0)
  assert.equal(f.engine.vault.status().unlocked, false)
  const snapshot = await f.engine.callTool('browser_snapshot', {})
  assert.equal(JSON.stringify(snapshot).includes('CANARY-field-password'), false)
  view.cdp = await f.page.context().newCDPSession(f.page)
  const input = new RemoteOwnerInput({ current: () => f.slot, credentialPointer: (target, pointer) => credentials.pointer(target, pointer) })
  const owner = await input.acquire(view)
  const submitBox = await f.page.locator('#submit').boundingBox()
  const point = { leaseId: owner.leaseId, x: submitBox!.x + 5, y: submitBox!.y + 5, button: 'left' }
  await input.pointer(view, { ...point, type: 'down' })
  await input.pointer(view, { ...point, type: 'up' })
  assert.equal(await f.page.evaluate(() => (window as any).submitted), 1)
  input.release(view)
  await f.engine.vault.unlock('disposable vault passphrase 123')
  await f.engine.vault.restore(f.page.context())
  await f.page.goto(f.origin + '/plain')
  const manual = await credentials.prepare(view, { operation: 'store' })
  await credentials.commit(view, crypto.sealOffer(manual.offer, { username: 'fixture-user', password: 'CANARY-manual-password' }))
  assert.equal(f.engine.vault.list(f.origin).length, 1)
  const store = await credentials.prepare(view, { operation: 'store' })
  await f.page.goto(f.origin + '/plain')
  await assert.rejects(credentials.commit(view, crypto.sealOffer(store.offer, { username: 'fixture-user', password: 'never-persist' })), { code: 'credential_changed' })
  assert.equal(JSON.stringify(f.engine.vault.list(f.origin)).includes('never-persist'), false)
})
