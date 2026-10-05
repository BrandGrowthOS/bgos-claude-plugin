// Disposable synthetic login site and real Linux browser. No production state.
import { createServer } from 'node:http'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { BrowserPool, ChromiumEngine, PairingConnection } from '../../bin/hoai-browser-host.mjs'
import { RemoteBrowserViews } from '../../lib/remote-view.mjs'
const backendUrl = process.env.HOAI_FIXTURE_BACKEND_URL || 'http://127.0.0.1:48901'
const backend = new URL(backendUrl), allowed = process.env.HOAI_FIXTURE_ALLOWED_TAILNET_HOST
const octets = backend.hostname.split('.').map(Number)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(backend.hostname) &&
  !(backend.hostname === allowed && octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127 &&
    octets.slice(2).every(n => Number.isInteger(n) && n >= 0 && n <= 255))) throw new Error('Only a named disposable backend is allowed')
const executable = process.env.HOAI_BROWSER_EXECUTABLE
const fixtureRoot = process.env.HOAI_FIXTURE_ROOT
if (!executable || !fixtureRoot?.startsWith('/tmp/hoai-remote-storage-')) throw new Error('A disposable /tmp profile and test Chromium are required')
const token = process.env.HOAI_FIXTURE_TOKEN || 'fixture-remote-browser-token'
if (!token.startsWith('fixture-')) throw new Error('Synthetic pairing required')
const assistantId = 901, principal = 'user-fixture'
mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 })
let page
const markup = `<!doctype html><html><head><title>Encrypted agent profile proof</title><style>
body{background:#07192c;color:#fff;font:22px system-ui;padding:36px}h1{font-size:36px}input,button{font:22px system-ui;padding:12px;margin:8px;border-radius:8px}label{display:block}#state{color:#60e8b5;font-size:26px}#counter{font-size:48px}
</style></head><body><h1>Encrypted agent profile proof</h1><div>${hostname()} | synthetic agent901 | process${process.pid}</div>
<div id="counter">0</div><div id="state">Locked session</div><form action="/" method="post" id="login"><label>Username<input id="username" name="username" autocomplete="username"></label><label>Password<input id="password" name="password" type="password" autocomplete="current-password"></label><button id="sign-in" type="submit">Sign in to synthetic site</button></form>
<script>
let count=0;window.idbPresent=false;
function tokenStore(write){return new Promise(resolve=>{const r=indexedDB.open('fixture-login',1);r.onupgradeneeded=()=>r.result.createObjectStore('tokens');r.onerror=()=>resolve(false);r.onsuccess=()=>{const db=r.result;const tx=db.transaction('tokens',write?'readwrite':'readonly');const s=tx.objectStore('tokens');const q=write?s.put('synthetic-idb-canary','session'):s.get('session');q.onsuccess=()=>{const found=write||q.result==='synthetic-idb-canary';tx.oncomplete=()=>{db.close();resolve(found)}};tx.onerror=()=>{db.close();resolve(false)}}})}
document.querySelector('#login').onsubmit=async e=>{e.preventDefault();if(!document.querySelector('#username').value||!document.querySelector('#password').value)return;document.cookie='fixture-session=synthetic-cookie-canary; Path=/; SameSite=Strict';document.cookie='fixture-persistent=synthetic-persistent-canary; Path=/; Max-Age=3600; SameSite=Strict';localStorage.setItem('fixture-login','synthetic-local-canary');window.idbPresent=await tokenStore(true)};
setInterval(async()=>{document.querySelector('#counter').textContent=++count;window.idbPresent=await tokenStore(false);const ok=document.cookie.includes('fixture-session=synthetic-cookie-canary')&&document.cookie.includes('fixture-persistent=synthetic-persistent-canary')&&localStorage.getItem('fixture-login')==='synthetic-local-canary'&&window.idbPresent;document.querySelector('#state').textContent=ok?'Signed-in state restored: cookies + localStorage + IndexedDB':'Locked session'},1000);
</script></body></html>`
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  if (req.url === '/state') {
    res.setHeader('Content-Type', 'application/json')
    const state = await page?.evaluate(() => ({ counter: document.querySelector('#counter')?.textContent,
      username: document.querySelector('#username')?.value, passwordLength: document.querySelector('#password')?.value.length,
      sessionCookie: document.cookie.includes('fixture-session=synthetic-cookie-canary'),
      persistentCookie: document.cookie.includes('fixture-persistent=synthetic-persistent-canary'),
      localStorage: localStorage.getItem('fixture-login') === 'synthetic-local-canary', indexedDB: window.idbPresent,
      status: document.querySelector('#state')?.textContent, rects: Object.fromEntries(['username', 'password', 'sign-in'].map(id => {
        const r = document.getElementById(id).getBoundingClientRect(); return [id, { x:r.x, y:r.y, width:r.width, height:r.height }]
      })) }))
    res.end(JSON.stringify({ hostname: hostname(), fixturePid: process.pid, state })); return
  }
  res.setHeader('Content-Type', 'text/html'); res.end(markup)
})
const port = Number(process.env.HOAI_FIXTURE_PAGE_PORT || 34348)
if (!Number.isSafeInteger(port) || port < 34000 || port > 35000) throw new Error('Test port required')
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
const pool = new BrowserPool({ agentRoot: fixtureRoot, idleMs: 3600000,
  createEngine: args => new ChromiumEngine({ ...args, executable, headless: true }) })
const slot = await pool.acquire({ assistantId, principal })
page = slot.engine.pages()[0]
await page.goto(`http://127.0.0.1:${port}`)
const views = new RemoteBrowserViews({ pool })
const connection = new PairingConnection({ pairing: { backendUrl, token, pairingId: 777, assistantIds: [assistantId] },
  deviceLabel: `Storage fixture Linux ${hostname()}`, remoteViews: views,
  relay: { relay: async () => ({ ok:false, error:{code:'fixture_read_only',message:'Use the synthetic site.'} }) }, log: line => console.log(line) })
connection.start()
console.log(JSON.stringify({ ready:true, hostname:hostname(), fixturePid:process.pid, browserPid:slot.engine._child?.pid, pagePort:port, fixtureRoot }))
let stopped=false
async function stop() { if(stopped)return; stopped=true;clearTimeout(ttl);await views.stop();connection.stop();await pool.stopAll();server.close() }
const ttl=setTimeout(stop,3600000)
process.on('SIGTERM',stop);process.on('SIGINT',stop)
