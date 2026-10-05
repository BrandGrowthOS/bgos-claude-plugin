import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { BrowserPool, ChromiumEngine } from '../bin/hoai-browser-host.mjs'
import { RemoteBrowserViews } from '../lib/remote-view.mjs'

test('remote view A streams changing pixels from a real agent Chromium through the pool seam',
  { skip: !process.env.HOAI_BROWSER_EXECUTABLE, timeout: 45000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'hoai-remote-view-test-'))
    const pool = new BrowserPool({ agentRoot: root, createEngine: (args: any) => new ChromiumEngine({ ...args,
      executable: process.env.HOAI_BROWSER_EXECUTABLE, headless: true }) })
    const views = new RemoteBrowserViews({ pool })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const slot = await pool.acquire({ assistantId: 901, principal: 'user-fixture' })
      const page = slot.engine.pages()[0]
      await page.setContent('<html><body style="background:navy;color:white;font:80px sans-serif"><div id="count">0</div><script>let n=0;setInterval(()=>document.querySelector("#count").textContent=++n,100)</script></body></html>')
      const hashes = new Set<string>()
      let ready: any
      let resolveChanged!: () => void
      const changed = new Promise<void>((resolve, reject) => {
        resolveChanged = resolve
        timer = setTimeout(() => reject(new Error('No changing remote frames arrived')), 10000)
      })
      assert.equal(await views.open({ viewId: 'real-view', assistantId: 901, principal: 'user-fixture' }, {
        connectionId: 'real-host-socket',
        sendFrame: (message: any) => {
          const frame = message.frame
          if (frame.method === 'hoai.ready') ready = frame.params
          if (frame.method === 'Page.screencastFrame') {
            hashes.add(createHash('sha256').update(frame.params.data).digest('hex'))
            setImmediate(() => { void views.command({ viewId: 'real-view', frame: {
              method: 'Page.screencastFrameAck', params: { sessionId: frame.params.sessionId },
              sessionId: frame.sessionId, tabId: frame.tabId,
            } }, 'real-host-socket') })
            if (hashes.size >= 2) resolveChanged()
          }
          return true
        },
        sendClose: () => {},
      }), true)
      assert.equal(await views.command({ viewId: 'real-view', frame: { id: 1, method: 'Page.startScreencast',
        params: {}, sessionId: ready.sessionId, tabId: ready.tabId } }, 'real-host-socket'), true)
      await changed
      assert.ok(hashes.size >= 2)
      assert.equal(pool.peek({ assistantId: 901, principal: 'user-fixture' })?.engine, slot.engine)
    } finally {
      clearTimeout(timer)
      await views.stop()
      await pool.stopAll()
      const absoluteRoot = resolve(root)
      assert.ok(absoluteRoot.startsWith(resolve(tmpdir()) + sep + 'hoai-remote-view-test-'))
      rmSync(absoluteRoot, { recursive: true, force: true })
    }
  })
