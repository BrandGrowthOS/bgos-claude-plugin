import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { ChromiumEngine, browserPathsFor, resolveChromeExecutable } from '../bin/hoai-browser-host.mjs'

const holdDatabase = (page: any, name: string, value: string) => page.evaluate(async ({ name, value }: { name: string; value: string }) => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('tokens')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result; (globalThis as any).auditDb = db
      const tx = db.transaction('tokens', 'readwrite'); tx.objectStore('tokens').put(value, 'token')
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    }
  })
}, { name, value })

test('actual Chromium keeps locked browsing ephemeral and restores encrypted session cookie, localStorage and IndexedDB after unlock', { timeout: 90000 }, async t => {
  const executable = process.env.HOAI_BROWSER_EXECUTABLE || resolveChromeExecutable({ env: process.env }).path
  assert.ok(executable, 'An installed browser is required for this focused proof')
  const root = mkdtempSync(join(tmpdir(), 'vault-chromium-'))
  const network: string[] = []
  const server = createServer((req, res) => {
    if (req.url !== '/favicon.ico') network.push(req.url || '/')
    res.setHeader('Content-Type', 'text/html')
    if (req.url === '/set') res.setHeader('Set-Cookie', 'session=COOKIE_REAL_CANARY_91; HttpOnly; SameSite=Lax; Path=/')
    res.end('<!doctype html><title>Disposable login storage</title><body>fixture</body>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  const paths = browserPathsFor({ agentRoot: root, assistantId: 901, principal: 'user-fixture' })
  let engine: any
  const start = async () => { engine = new ChromiumEngine({ ...paths, executable, headless: true }); await engine.start(); return engine.pages()[0] }
  t.after(async () => {
    await engine?.pages()[0]?.evaluate(() => (globalThis as any).auditDb?.close()).catch(() => {})
    await engine?.stop(); await new Promise<void>(resolve => server.close(() => resolve()))
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'vault-chromium-'))
    rmSync(root, { recursive: true, force: true })
  })
  let page = await start(), context = page.context()
  const runtime = engine._runtimeDir
  assert.notEqual(runtime, paths.profileDir)
  await page.goto(origin + '/set')
  assert.equal((await context.cookies()).find((c: any) => c.name === 'session').expires, -1)
  const nativeContext = engine._engine._browser.contexts()[0]
  assert.notEqual(context, nativeContext, 'Authenticated browsing must not use the native disk context')
  assert.deepEqual(await nativeContext.cookies(), [], 'The disk context never receives the login cookie')
  await engine.stop()
  assert.equal(existsSync(runtime), false)
  assert.equal(existsSync(join(paths.profileDir, 'agent-browser.vault.json')), false)
  page = await start(); context = page.context()
  assert.deepEqual(await context.cookies(), [])
  // Native Logins unlocks while the existing page is already open. An SPA
  // can establish auth entirely through DOM/fetch without another navigation.
  await page.goto(origin + '/read')
  await page.evaluate(() => localStorage.setItem('locked', 'LOCKED_LOCAL_PROBE'))
  await holdDatabase(page, 'audit-locked', 'LOCKED_IDB_PROBE')
  const isolated = await engine._engine._browser.newContext()
  const isolatedPage = await isolated.newPage(); await isolatedPage.goto(origin + '/read')
  await holdDatabase(isolatedPage, 'audit-locked', 'OTHER_CONTEXT_IDB_PROBE')
  const documentBeforeUnlock = await page.evaluateHandle(() => document)
  const requestsBeforeUnlock = network.length
  await engine.vault.unlock('fixture owner passphrase 123')
  await engine.vault.restore(context)
  assert.equal(await page.evaluate(() => localStorage.getItem('locked')), null)
  assert.equal(await page.evaluate(() => {
    try { (globalThis as any).auditDb.transaction('tokens'); return 'open' } catch { return 'closed' }
  }), 'closed', 'Unlock must invalidate live handles to discarded locked IndexedDB state')
  assert.deepEqual(await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name)), [])
  assert.equal(await isolatedPage.evaluate(async () => await new Promise(resolve => {
    const req = (globalThis as any).auditDb.transaction('tokens').objectStore('tokens').get('token')
    req.onsuccess = () => resolve(req.result)
  })), 'OTHER_CONTEXT_IDB_PROBE', 'The reset must stay inside this browser context')
  await isolated.close()
  assert.equal(await documentBeforeUnlock.evaluate((saved: Document) => saved === document), true)
  assert.equal(network.length, requestsBeforeUnlock, 'Restoration must not contact the website or reload the open page')
  await documentBeforeUnlock.dispose()
  await context.addCookies([{ name: 'session', value: 'COOKIE_REAL_CANARY_91', url: origin, httpOnly: true, sameSite: 'Lax' }])
  await page.evaluate(async () => {
    localStorage.setItem('token', 'LOCAL_REAL_CANARY_92')
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('auth', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('tokens')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('tokens', 'readwrite')
        tx.objectStore('tokens').put('IDB_REAL_CANARY_93', 'token')
        tx.oncomplete = () => { db.close(); resolve() }; tx.onerror = () => reject(tx.error)
      }
    })
  })
  await engine.vault.snapshot()
  assert.equal(engine.vault.data.state.origins[0]?.origin, origin, 'An already open SPA origin must remain eligible for snapshots after first unlock')
  const disk = readdirSync(paths.profileDir).map((name: string) => readFileSync(join(paths.profileDir, name), 'utf8')).join('\n')
  for (const marker of ['COOKIE_REAL_CANARY_91', 'LOCAL_REAL_CANARY_92', 'IDB_REAL_CANARY_93']) assert.equal(disk.includes(marker), false, marker)
  await engine.stop()
  page = await start(); context = page.context()
  assert.deepEqual(await context.cookies(), [])
  await page.goto(origin + '/read')
  await holdDatabase(page, 'auth', 'LOCKED_REPLACEMENT_PROBE')
  const savedRestoreDocument = await page.evaluateHandle(() => document)
  await engine.vault.unlock('fixture owner passphrase 123'); await engine.vault.restore(context)
  assert.equal(await savedRestoreDocument.evaluate((saved: Document) => saved === document), true)
  await savedRestoreDocument.dispose()
  assert.equal(await page.evaluate(() => {
    try { (globalThis as any).auditDb.transaction('tokens'); return 'open' } catch { return 'closed' }
  }), 'closed', 'A saved-state restore must close old connections before rebuilding the same database')
  const cookie = (await context.cookies()).find((c: any) => c.name === 'session')
  assert.equal(cookie.value, 'COOKIE_REAL_CANARY_91'); assert.equal(cookie.expires, -1)
  assert.equal(await page.evaluate(() => localStorage.getItem('token')), 'LOCAL_REAL_CANARY_92')
  assert.equal(await page.evaluate(async () => await new Promise((resolve, reject) => {
    const request = indexedDB.open('auth', 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => { const db = request.result, tx = db.transaction('tokens'); const item = tx.objectStore('tokens').get('token'); item.onsuccess = () => { resolve(item.result); db.close() }; item.onerror = () => reject(item.error) }
  })), 'IDB_REAL_CANARY_93')
  await context.clearCookies(); await page.evaluate(() => localStorage.clear())
  await engine.stop()
  page = await start(); context = page.context()
  await engine.vault.unlock('fixture owner passphrase 123'); await engine.vault.restore(context)
  assert.deepEqual(await context.cookies(), [])
  await page.goto(origin + '/read'); assert.equal(await page.evaluate(() => localStorage.getItem('token')), null)
})

test('unlock clears a historical origin whose service worker still holds a locked IndexedDB connection', { timeout: 45000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'vault-history-'))
  const historical = createServer((req, res) => {
    if (req.url === '/worker.js') {
      res.setHeader('Content-Type', 'application/javascript')
      res.end(`self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('message',e=>{if(e.data==='hold')e.waitUntil(new Promise(resolve=>{self.releaseHold=resolve;e.ports[0].postMessage('holding')}))})`)
    } else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Historical site</title>') }
  })
  const current = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Current site</title>') })
  await Promise.all([new Promise<void>(resolve => historical.listen(0, '127.0.0.1', resolve)), new Promise<void>(resolve => current.listen(0, '127.0.0.1', resolve))])
  const oldOrigin = `http://127.0.0.1:${(historical.address() as any).port}`
  const newOrigin = `http://127.0.0.1:${(current.address() as any).port}`
  const engine: any = new ChromiumEngine({ ...browserPathsFor({ agentRoot: root, assistantId: 901, principal: 'user-fixture' }),
    executable: process.env.HOAI_BROWSER_EXECUTABLE || resolveChromeExecutable({ env: process.env }).path })
  let worker: any
  t.after(async () => {
    await worker?.evaluate(() => { (globalThis as any).auditDb?.close(); (globalThis as any).releaseHold?.() }).catch(() => {})
    await engine.stop()
    await Promise.all([new Promise<void>(resolve => historical.close(() => resolve())), new Promise<void>(resolve => current.close(() => resolve()))])
    rmSync(root, { recursive: true, force: true })
  })
  await engine.start()
  const page = engine.pages()[0], context = page.context()
  await page.goto(oldOrigin)
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/worker.js')
    const registration = await navigator.serviceWorker.ready
    await new Promise<void>(resolve => {
      const channel = new MessageChannel(); channel.port1.onmessage = () => resolve()
      registration.active!.postMessage('hold', [channel.port2])
    })
  })
  worker = context.serviceWorkers().find((worker: any) => worker.url().startsWith(oldOrigin))
  assert.ok(worker)
  await holdDatabase(worker, 'audit-history', 'HISTORICAL_LOCKED_IDB_PROBE')
  await page.goto(newOrigin)
  const document = await page.evaluateHandle(() => globalThis.document)
  assert.equal(page.frames().some((frame: any) => frame.url().startsWith(oldOrigin)), false)
  const readHeld = () => worker.evaluate(async () => {
    try {
      return await new Promise(resolve => {
        const req = (globalThis as any).auditDb.transaction('tokens').objectStore('tokens').get('token')
        req.onsuccess = () => resolve(req.result)
      })
    } catch { return 'closed' }
  })
  assert.equal(await readHeld(), 'HISTORICAL_LOCKED_IDB_PROBE')
  await engine.vault.unlock('fixture owner passphrase 123'); await engine.vault.restore(context)
  assert.equal(await document.evaluate((saved: Document) => saved === globalThis.document), true)
  await document.dispose()
  assert.equal(await readHeld().catch(() => 'closed'), 'closed')
  await page.goto(oldOrigin)
  assert.deepEqual(await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name)), [])
})
