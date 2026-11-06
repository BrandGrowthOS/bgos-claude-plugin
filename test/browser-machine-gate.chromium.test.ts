/**
 * A gate on the machine reads the page, not the agent's words, on the real engine and a real
 * Chromium: a name with a colon, a selector, a snapshot to a depth, a page a click moved to, and a
 * target with no readable name on a browser that may be signed in. Made up pages only.
 * No em or en dashes in this file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BrowserHostCore, ChromiumEngine, listTools, DEFAULT_CAPS, servedBrowserTools, resolveChromeExecutable } from '../bin/hoai-browser-host.mjs'
import { GateKeeper } from '../lib/browser-gate.mjs'

const chrome = resolveChromeExecutable()
const skip = !chrome.path ? 'no Chrome or Chromium is installed on this machine' : false
const OWNER = { assistantId: 42, assistantName: 'Atlas', principal: 'user-owner_1' }
const PAGES: Record<string, string> = {
  '/': `<title>One</title><button id="quoted" onclick="fetch('/clicked/quoted')">Confirm: delete account</button><button id="pub" onclick="fetch('/clicked/pub')">Make /finance public</button><button id="harmless" onclick="fetch('/clicked/harmless')">Show the report</button><button id="bare" aria-label="" onclick="fetch('/clicked/bare')"><svg width="9" height="9"></svg></button><input id="nameless" type="password"><a id="next" href="/next">Next</a>`,
  '/next': `<title>Two</title><button id="after" onclick="fetch('/clicked/after')">Delete account</button>`,
}

async function rig(t: any, { cookie = true } = {}) {
  const clicks: string[] = []
  const server = createServer((req, res) => {
    const url = String(req.url)
    if (url.startsWith('/clicked/')) { clicks.push(url.slice(9)); res.end('ok'); return }
    res.setHeader('content-type', 'text/html')
    if (cookie) res.setHeader('set-cookie', 'sid=MADE_UP_SESSION; Path=/; HttpOnly')
    res.end(PAGES[url] ?? PAGES['/'])
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bh-gate-')))
  const engine: any = new ChromiumEngine({ executable: chrome.path!, profileDir: join(home, 'browser', 'k'), outputDir: join(home, 'output', 'k'), scope: 'fixture' })
  await engine.start()
  t.after(async () => { await engine.stop().catch(() => {}); await new Promise(resolve => server.close(resolve)); rmSync(home, { recursive: true, force: true }) })
  const cards: any[] = []
  const slot: any = { engine, paths: { key: 'k' } }
  const pool: any = { acquire: async () => slot, peek: () => slot, slotKey: () => 'k', pathsFor: () => slot.paths, release: async () => true }
  const gates = new GateKeeper({ postCard: async (card: any) => { cards.push(card); return true }, readGate: async (gateId: string) => ({ gateId, state: 'answered', choice: 'deny' }), randomBytes: (n: number) => Buffer.alloc(n, cards.length + 1), sleep: async () => {}, log: () => {} } as any)
  const core: any = new BrowserHostCore({ pool, browserTools: servedBrowserTools(await listTools({ caps: DEFAULT_CAPS, outputDir: join(home, 'tools') })), deviceLabel: 'Build box', gates, isOwnerPrincipal: () => true } as any)
  core._settingsFor = () => ({})
  core._grantsFor = () => ({ [origin]: { navigate: 'allow', write: 'allow' } })
  const call = (name: string, args: any = {}) => core.callTool(OWNER, name, args)
  await engine.callTool('browser_navigate', { url: `${origin}/` }) // the owner's yes on this site is not what these tests are about
  const refFor = async (selector: string) => { const tree = await engine.selectedPage().locator(selector).ariaSnapshot({ mode: 'ai' }); const ref = /\[ref=((?:f\d+)?e\d+)\]/.exec(tree)![1]; await engine.selectedPage().ariaSnapshot({ mode: 'ai' }); return ref };
  return { core, call, cards, clicks, origin, engine, slot, refFor }
}
const refOf = (reply: unknown, name: string) => {
  const text = JSON.stringify(reply)
  const m = new RegExp(`${name.replace(/[/]/g, '\\/')}[^\\[]*\\[ref=([a-z0-9]+)\\]`).exec(text)
  assert.ok(m, `${name} in ${text.slice(0, 500)}`)
  return m![1]
}
const settle = () => new Promise(resolve => setTimeout(resolve, 150))

test('a ref to a name with a colon asks, and the card names it, though the agent called it a note', { timeout: 120_000, skip }, async (t) => {
  const r = await rig(t), snap = await r.call('browser_snapshot')
  await r.call('browser_click', { target: refOf(snap, 'Confirm: delete account'), element: 'Open the note', wait_seconds: 1 }); await settle()
  assert.equal(r.cards[0]?.kind, 'sensitive'); assert.match(r.cards[0].summary, /Confirm: delete account/); assert.deepEqual(r.clicks, [])
})

test('a selector is refused before a page action', { timeout: 120_000, skip }, async (t) => {
  const r = await rig(t)
  const refused = await r.call('browser_click', { target: '#pub', element: 'Open the note', wait_seconds: 1 }); await settle()
  assert.equal(refused.isError, true); assert.equal(r.cards.length, 0); assert.deepEqual(r.clicks, [])
})

test('a ref from a snapshot to a depth asks: no whole tree is needed', { timeout: 120_000, skip }, async (t) => {
  const r = await rig(t), snap = await r.call('browser_snapshot', { depth: 50 })
  assert.ok(!r.slot.lastSnapshotText, 'no whole tree is kept')
  await r.call('browser_click', { target: refOf(snap, 'Make /finance public'), element: 'Open the note', wait_seconds: 1 }); await settle()
  assert.equal(r.cards[0]?.kind, 'sensitive'); assert.deepEqual(r.clicks, [])
})

test('after a click moved the page, a new ref asks by the new page\'s name', { timeout: 120_000, skip }, async (t) => {
  const r = await rig(t), snap = await r.call('browser_snapshot')
  await r.call('browser_click', { target: refOf(snap, 'Next'), element: 'Next' }); await settle()
  const next = await r.call('browser_snapshot', { depth: 50 })
  await r.call('browser_click', { target: refOf(next, 'Delete account'), element: 'Open the note', wait_seconds: 1 }); await settle()
  assert.equal(r.cards.at(-1)?.kind, 'sensitive'); assert.match(r.cards.at(-1).summary, /Delete account/); assert.deepEqual(r.clicks, [])
})

test('a target with no name the host can read asks on a browser that holds a cookie for the site, including when it holds no cookie', { timeout: 120_000, skip }, async (t) => {
  const signedIn = await rig(t)
  await signedIn.call('browser_click', { target: await signedIn.refFor('#bare'), element: 'Open the note', wait_seconds: 1 }); await settle()
  assert.equal(signedIn.cards[0]?.kind, 'sensitive', JSON.stringify(signedIn.cards)); assert.deepEqual(signedIn.clicks, [])
  const anonymous = await rig(t, { cookie: false })
  await anonymous.call('browser_click', { target: await anonymous.refFor('#bare'), element: 'Open the note', wait_seconds: 1 }); await settle()
  assert.equal(anonymous.cards[0]?.kind, 'sensitive'); assert.deepEqual(anonymous.clicks, [], 'cookie absence proves nothing')
})

test('a field with no name of its own: what it holds is not on the card, whatever way it is named', { timeout: 120_000, skip }, async (t) => {
  const r = await rig(t)
  await r.call('browser_click', { target: await r.refFor('#nameless'), element: 'Open the note', wait_seconds: 1 }); await settle()
  assert.equal(r.cards[0]?.kind, 'credential', JSON.stringify(r.cards))
  const ref = await r.refFor('#nameless')
  await r.engine.selectedPage().locator('#nameless').evaluate((el: any) => { el.value = 'MADE_UP_NAMELESS_VALUE' })
  assert.equal(await r.engine.selectedPage().locator('#nameless').inputValue(), 'MADE_UP_NAMELESS_VALUE', 'the protected fixture is populated')
  const before = r.cards.length
  const answer = await r.call('browser_click', { target: ref, element: 'Open the note', wait_seconds: 1 })
  assert.match(JSON.stringify(answer), /This browser is private/)
  assert.equal(r.cards.length, before, 'a populated protected page supplies no further gate facts')
  assert.equal(JSON.stringify({ cards: r.cards, answer }).includes('MADE_UP_NAMELESS_VALUE'), false)
})

test('reading a live ref for a gate leaves the agent\'s refs working for a call with no gate', { timeout: 120_000, skip }, async (t) => {
  const r = await rig(t), snap = await r.call('browser_snapshot'), ref = refOf(snap, 'Show the report')
  await r.call('browser_click', { target: await r.refFor('#harmless'), element: 'Show the report' }); await settle()
  const part = JSON.stringify(await r.call('browser_snapshot', { target: ref }))
  assert.match(part, /Show the report/, part.slice(0, 400))
  assert.equal(r.cards.length, 0, JSON.stringify(r.cards))
})

test('CONTROL: a harmless name on a site the owner allowed clicks with no card, through repeated live refs', { timeout: 120_000, skip }, async (t) => {
  const r = await rig(t), snap = await r.call('browser_snapshot')
  await r.call('browser_click', { target: refOf(snap, 'Show the report'), element: 'Show the report' }); await settle()
  await r.call('browser_click', { target: await r.refFor('#harmless'), element: 'Show the report' }); await settle()
  await r.call('browser_click', { target: refOf(snap, 'Show the report'), element: 'Show the report' }); await settle() // reading a selector left the agent's refs working
  assert.equal(r.cards.length, 0, JSON.stringify(r.cards)); assert.deepEqual(r.clicks, ['harmless', 'harmless', 'harmless'])
})
