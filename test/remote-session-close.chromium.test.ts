import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { BrowserPool, ChromiumEngine } from '../bin/hoai-browser-host.mjs'
import { RemoteBrowserViews } from '../lib/remote-view.mjs'

test('owner close stops real Chromium and preserves encrypted cookies and saved login for explicit unlock',
  { skip: !process.env.HOAI_BROWSER_EXECUTABLE, timeout: 60000 }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-close-proof-')))
    const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Disposable close proof</title>') })
    const context = { assistantId: 901, principal: 'user-fixture' }
    const pool = new BrowserPool({ agentRoot: root, createEngine: (args: any) => new ChromiumEngine({ ...args,
      executable: process.env.HOAI_BROWSER_EXECUTABLE, headless: true }) })
    const views = new RemoteBrowserViews({ pool })
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const origin = `http://127.0.0.1:${(server.address() as any).port}`
      const slot = await pool.acquire(context), engine = slot.engine, page = engine.pages()[0]
      await page.goto(origin)
      await engine.vault.unlock('synthetic close proof passphrase')
      await engine.vault.restore()
      await page.context().addCookies([{ name: 'session', value: 'synthetic-cookie-close', url: origin }])
      await page.evaluate(() => localStorage.setItem('session', 'synthetic-local-close'))
      await engine.vault.saveLogin({ origin, username: 'synthetic-user', password: 'synthetic-password-close' })
      const frames: any[] = [], sequence: string[] = []
      await views.open({ viewId: 'close-proof', ...context, remoteBrowser: true, remoteSessionClose: true }, {
        connectionId: 'fixture-host', sendFrame: (message: any) => {
          frames.push(message.frame)
          if (message.frame.result?.closed) { assert.equal(engine.alive, false); sequence.push('confirmed-close') }
          return true
        }, sendClose: () => sequence.push('viewer-detached'),
      })
      const target = frames[0].params
      const command = (id: number, method: string, params: any) => views.command({ viewId: 'close-proof', frame: {
        id, method, params, sessionId: target.sessionId, tabId: target.tabId,
      } }, 'fixture-host')
      await command(1, 'hoai.input.acquire', {})
      assert.equal(await command(2, 'hoai.browser.close', { leaseId: frames.at(-1).result.leaseId }), true)
      assert.deepEqual(sequence, ['confirmed-close', 'viewer-detached'])
      assert.equal(pool.peek(context), null)
      assert.equal(engine.vault.status().unlocked, false)
      const ciphertext = readFileSync(engine.vault.file, 'utf8')
      for (const marker of ['synthetic-cookie-close', 'synthetic-local-close', 'synthetic-password-close', 'synthetic-user']) assert.equal(ciphertext.includes(marker), false)
      const reopened = (await pool.acquire(context)).engine
      assert.notEqual(reopened, engine)
      const next = reopened.pages()[0]
      await next.goto(origin)
      assert.equal((await next.context().cookies()).some((cookie: any) => cookie.name === 'session'), false)
      assert.equal(reopened.vault.status().unlocked, false)
      await reopened.vault.unlock('synthetic close proof passphrase')
      await reopened.vault.restore()
      await next.reload()
      assert.equal((await next.context().cookies()).find((cookie: any) => cookie.name === 'session')?.value, 'synthetic-cookie-close')
      assert.equal(await next.evaluate(() => localStorage.getItem('session')), 'synthetic-local-close')
      const login = reopened.vault.list(origin)[0]
      assert.equal(reopened.vault.readLogin(login.id, origin).password, 'synthetic-password-close')
    } finally {
      await views.stop(); await pool.stopAll()
      await new Promise<void>(resolve => server.close(() => resolve()))
      assert.ok(resolve(root).startsWith(resolve(realpathSync(tmpdir())) + sep + 'hoai-close-proof-'))
      rmSync(root, { recursive: true, force: true })
    }
  })
