import { createServer } from 'node:http'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { BrowserPool, ChromiumEngine, PairingConnection } from '../../bin/hoai-browser-host.mjs'
import { RemoteBrowserViews } from '../../lib/remote-view.mjs'

// Disposable integration fixture. It cannot point at a production backend.
const backendUrl = process.env.HOAI_FIXTURE_BACKEND_URL || 'http://127.0.0.1:48901'
const backend = new URL(backendUrl)
const explicitTailnet = process.env.HOAI_FIXTURE_ALLOWED_TAILNET_HOST
const octets = backend.hostname.split('.').map(Number)
const allowedTailnet = backend.hostname === explicitTailnet && octets.length === 4 && octets[0] === 100 &&
  octets[1] >= 64 && octets[1] <= 127 && octets.slice(2).every(n => Number.isInteger(n) && n >= 0 && n <= 255)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(backend.hostname) && !allowedTailnet) {
  throw new Error('The fixture requires loopback or an explicitly named test Tailscale host')
}
const assistantId = Number(process.env.HOAI_FIXTURE_ASSISTANT_ID || 901)
const principal = process.env.HOAI_FIXTURE_PRINCIPAL || 'user-fixture'
const token = process.env.HOAI_FIXTURE_TOKEN || 'fixture-remote-browser-token'
if (!token.startsWith('fixture-')) throw new Error('Only a synthetic fixture pairing token is allowed')
const executable = process.env.HOAI_BROWSER_EXECUTABLE
if (!executable) throw new Error('Set HOAI_BROWSER_EXECUTABLE to the installed test Chromium')
const fixtureRoot = process.env.HOAI_FIXTURE_ROOT || join(process.cwd(), 'fixture-profile')
mkdirSync(fixtureRoot, { recursive: true })
const pageMarkup = `<!doctype html><html><head><title>Remote Linux browser proof</title><style>
body{margin:0;background:#07192c;color:#fff;font:24px system-ui;padding:60px} h1{font-size:42px;margin:0 0 12px}
#counter{font-size:96px;color:#60e8b5;font-weight:750;margin:30px 0}label{display:block;margin-top:30px}input{font:28px system-ui;padding:14px;width:75%;border-radius:10px;border:0}
.badge{display:inline-block;background:#163c50;padding:10px 18px;border-radius:40px;margin-top:10px}#pulse{height:20px;border-radius:10px;transition:width .2s;background:#60e8b5}
</style></head><body><h1>Browser running on Linux</h1><div>${hostname()}</div><div class="badge">Synthetic agent ${assistantId} | process ${process.pid}</div>
<div id="counter">0</div><div id="pulse"></div><label>Remote keyboard proof<input id="owner-text" autocomplete="off" placeholder="Type from the HOAI pane"></label>
<label>Password guard fixture<input id="secret-text" type="password" autocomplete="current-password" placeholder="Credential input must be refused"></label>
<script>let count=0;setInterval(()=>{document.querySelector('#counter').textContent=++count;document.querySelector('#pulse').style.width=(15+(count%7)*10)+'%'},500)</script></body></html>`
let page
const server = createServer(async (req, res) => {
  if (req.url === '/state') {
    res.setHeader('Content-Type', 'application/json')
    const state = await page?.evaluate(() => ({ counter: document.querySelector('#counter')?.textContent,
      text: document.querySelector('#owner-text')?.value, passwordLength: document.querySelector('#secret-text')?.value.length }))
    res.end(JSON.stringify({ hostname: hostname(), fixturePid: process.pid, state }))
  } else { res.setHeader('Content-Type', 'text/html'); res.end(pageMarkup) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const pageUrl = `http://127.0.0.1:${server.address().port}`
const pool = new BrowserPool({ agentRoot: fixtureRoot, idleMs: 60 * 60_000,
  createEngine: args => new ChromiumEngine({ ...args, executable, headless: true }) })
const slot = await pool.acquire({ assistantId, principal })
page = slot.engine.pages()[0]
if (!page) throw new Error('The installed Chromium did not open a page')
await page.goto(pageUrl)
const views = new RemoteBrowserViews({ pool })
const conn = new PairingConnection({ pairing: { backendUrl, token, pairingId: 777, assistantIds: [assistantId] },
  deviceLabel: `Fixture Linux ${hostname()}`, remoteViews: views,
  relay: { relay: async () => ({ ok: false, error: { code: 'fixture_read_only', message: 'Use the fixture page.' } }) },
  log: line => console.log(line) })
conn.start()
console.log(JSON.stringify({ ready: true, hostname: hostname(), fixturePid: process.pid, browserPid: slot.engine._child?.pid,
  assistantId, principal, pageUrl, backendUrl, fixtureRoot }))
let stopped = false
async function stop() {
  if (stopped) return
  stopped = true
  clearTimeout(ttl)
  await views.stop()
  conn.stop()
  await pool.stopAll()
  server.close()
}
const ttl = setTimeout(stop, 60 * 60_000)
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
