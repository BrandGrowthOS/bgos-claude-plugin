import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { BrowserPool, ChromiumEngine } from '../bin/hoai-browser-host.mjs'
import { RemoteBrowserViews } from '../lib/remote-view.mjs'
import { runAgentBrowserWork } from '../lib/remote-input.mjs'

test('B real Chromium receives owner input, refuses credential changes and iframe focus, and revokes on navigation',
  { skip: !process.env.HOAI_BROWSER_EXECUTABLE, timeout: 45000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'hoai-remote-input-test-'))
    const pool = new BrowserPool({ agentRoot: root, createEngine: (args: any) => new ChromiumEngine({ ...args,
      executable: process.env.HOAI_BROWSER_EXECUTABLE, headless: true }) })
    const views = new RemoteBrowserViews({ pool })
    const frames: any[] = []
    try {
      const context = { assistantId: 901, principal: 'user-fixture' }
      const slot = await pool.acquire(context)
      const page = slot.engine.pages()[0]
      await page.setContent('<html><body><input id="ordinary"><input id="secret" type="password"><input id="otp" autocomplete="one-time-code"><iframe srcdoc="<input id=inside>"></iframe></body></html>')
      assert.equal(await views.open({ viewId: 'input-view', ...context }, {
        connectionId: 'input-socket', sendFrame: (message: any) => { frames.push(message); return true }, sendClose: () => {},
      }), true)
      const ready = frames[0].frame.params
      assert.equal(ready.remoteInput, true)
      let id = 0
      const command = async (method: string, params: any) => {
        const request = ++id
        await views.command({ viewId: 'input-view', frame: { id: request, method, params,
          sessionId: ready.sessionId, tabId: ready.tabId } }, 'input-socket')
        return frames.find(message => message.frame.id === request).frame
      }
      const acquire = await command('hoai.input.acquire', {})
      const leaseId = acquire.result.leaseId
      assert.throws(() => runAgentBrowserWork(slot, () => {}), /owner currently controls/)
      const box = await page.locator('#ordinary').boundingBox()
      assert.ok(box)
      assert.deepEqual((await command('hoai.input.pointer', { leaseId, type: 'down', x: box.x + 5, y: box.y + 5, button: 'left' })).result, {})
      await command('hoai.input.pointer', { leaseId, type: 'up', x: box.x + 5, y: box.y + 5, button: 'left' })
      const focus = await command('hoai.input.focus', { leaseId })
      assert.equal(focus.result.allowed, true)
      assert.deepEqual((await command('hoai.input.key', { leaseId, focusToken: focus.result.focusToken, key: 'K' })).result, {})
      assert.equal(await page.locator('#ordinary').inputValue(), 'K')
      const prior = await command('hoai.input.focus', { leaseId })
      await page.locator('#ordinary').evaluate((node: any) => { node.type = 'password' })
      assert.equal((await command('hoai.input.key', { leaseId, focusToken: prior.result.focusToken, key: 'P' })).error.code, 'credential_field')
      assert.equal(await page.locator('#ordinary').inputValue(), 'K')
      await page.locator('#otp').focus()
      assert.deepEqual((await command('hoai.input.focus', { leaseId })).result,
        { allowed: false, focusToken: null, credential: true, editable: true })
      await page.frameLocator('iframe').locator('#inside').focus()
      assert.equal((await command('hoai.input.focus', { leaseId })).result.allowed, false)
      await page.goto('about:blank')
      assert.ok(frames.some(message => message.frame.method === 'hoai.input.revoked'))
      assert.equal(slot.ownerInputLease, null)
    } finally {
      await views.stop()
      await pool.stopAll()
      const absoluteRoot = resolve(root)
      assert.ok(absoluteRoot.startsWith(resolve(tmpdir()) + sep + 'hoai-remote-input-test-'))
      rmSync(absoluteRoot, { recursive: true, force: true })
    }
  })
