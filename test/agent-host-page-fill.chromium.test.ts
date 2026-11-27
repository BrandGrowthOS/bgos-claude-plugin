/**
 * The host types a saved login into a real page in a real Chromium, presses
 * Sign in and waits until the login document is gone (lib/agent-host-page-fill.mjs;
 * BGOS plan 2026-11-13 section 4.3 step 5). Loopback, made up values.
 *
 *   - a working sign in navigates away: filled, and the site got both values;
 *   - a sign in the site refuses stays on the page: both fields are emptied;
 *   - a page with no login form, or a sign up form: nothing is typed.
 *
 * No em or en dashes in this file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChromiumEngine, resolveChromeExecutable } from '../bin/hoai-browser-host.mjs'
import { fillLoginInPage } from '../lib/agent-host-page-fill.mjs'

const chrome = resolveChromeExecutable()
const skip = chrome.path ? false : 'no Chrome or Chromium is installed on this machine'
const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`
const PAGES: Record<string, string> = {
  '/login': page('<form method="post" action="/session"><label>Email <input name="email" type="email" autocomplete="username"></label><label>Password <input name="pw" type="password" autocomplete="current-password"></label><button>Sign in</button></form>'),
  '/refuse': page('<form method="post" action="/session" onsubmit="event.preventDefault(); document.getElementById(\'m\').textContent=\'Wrong password\'"><input name="email" type="email"><input name="pw" type="password"><button>Sign in</button></form><p id="m"></p>'),
  '/nothing': page('<h1>No form here</h1>'),
  '/signup': page('<form id="register" method="post" action="/session"><input name="email" type="email"><input name="pw" type="password" autocomplete="new-password"><button>Create account</button></form>'),
}

async function rig(t: any) {
  const posted: string[] = []
  const server = createServer((req, res) => {
    if (req.url === '/session' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => { posted.push(body); res.setHeader('content-type', 'text/html'); res.end(page('<h1>Welcome</h1>')) })
      return
    }
    const html = PAGES[String(req.url)]
    res.statusCode = html ? 200 : 404
    res.setHeader('content-type', 'text/html')
    res.end(html ?? 'no')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hpf-')))
  const engine: any = new ChromiumEngine({ executable: chrome.path!, profileDir: join(home, 'browser', 'k'), outputDir: join(home, 'output', 'k'), scope: 'fixture' })
  await engine.start()
  t.after(async () => { await engine.stop().catch(() => {}); server.close(); rmSync(home, { recursive: true, force: true }) })
  const open = async (path: string) => {
    await engine.callTool('browser_navigate', { url: `${origin}${path}` })
    return engine.selectedPage()
  }
  return { origin, open, posted }
}

const VALUES = { username: 'leo@example.com', password: 'made-up-Secret-42' }

test('a working sign in: filled, pressed, the login document is gone, the site got both values', { skip, timeout: 120_000 }, async (t) => {
  const r = await rig(t)
  const p = await r.open('/login')
  assert.deepEqual(await fillLoginInPage(p, VALUES, { origin: r.origin, waitMs: 10_000 }), { filled: true })
  assert.equal(r.posted.length, 1)
  assert.match(r.posted[0]!, /email=leo%40example\.com/)
  assert.match(r.posted[0]!, /pw=made-up-Secret-42/)
  assert.match(await p.content(), /Welcome/)
})

test('a refused sign in: the fields are emptied and the answer says so', { skip, timeout: 120_000 }, async (t) => {
  const r = await rig(t)
  const p = await r.open('/refuse')
  assert.deepEqual(await fillLoginInPage(p, VALUES, { origin: r.origin, waitMs: 1_500 }), { filled: false, reason: 'sign_in_failed' })
  assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('input')].map((i) => (i as HTMLInputElement).value)), ['', ''])
  assert.match(await p.content(), /Wrong password/, 'Sign in was pressed')
})

test('no login form, or a sign up form: nothing is typed', { skip, timeout: 120_000 }, async (t) => {
  const r = await rig(t)
  for (const path of ['/nothing', '/signup']) {
    const p = await r.open(path)
    assert.deepEqual(await fillLoginInPage(p, VALUES, { origin: r.origin, waitMs: 500 }), { filled: false, reason: 'no_login_form' }, path)
    assert.ok((await p.evaluate(() => [...document.querySelectorAll('input')].every((i) => (i as HTMLInputElement).value === ''))), path)
  }
  assert.equal(r.posted.length, 0)
})

test('a page on another origin than the login: nothing is typed', { skip, timeout: 120_000 }, async (t) => {
  const r = await rig(t)
  const p = await r.open('/login')
  assert.deepEqual(await fillLoginInPage(p, VALUES, { origin: 'https://bank.example.com', waitMs: 500 }), { filled: false, reason: 'no_login_form' })
  assert.equal(r.posted.length, 0)
})
