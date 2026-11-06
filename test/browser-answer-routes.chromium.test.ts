/**
 * Every way page content reaches the agent on this machine's host, on the real core, the real
 * engine and a real Chromium, and that a normal site still browses. Made up values on loopback.
 * No em or en dashes in this file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BrowserHostCore, ChromiumEngine, DEFAULT_CAPS, listTools, resolveChromeExecutable, servedBrowserTools } from '../bin/hoai-browser-host.mjs'
import { GateKeeper } from '../lib/browser-gate.mjs'
import { CSRF, serveSite } from './browser-site-fixture.ts'

const chrome = resolveChromeExecutable()
const skip = chrome.path ? false : 'no Chrome or Chromium is installed on this machine'
const OWNER = { assistantId: 42, assistantName: 'Atlas', principal: 'user-owner_1' }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const textOf = (reply: any) => (reply?.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
const hasImage = (reply: any) => (reply?.content || []).some((part: any) => part.type === 'image')
const refOf = (tree: string, name: string) => new RegExp(`${name}[^\\n]*?\\[ref=((?:f\\d+)?e\\d+)\\]`).exec(tree)?.[1]

async function rig(t: any, html?: any, { answer = 'deny', write = 'allow', navigate = 'allow', path = '/', gates: gated = true }: any = {}) {
  const site = await serveSite(typeof html === 'string' ? ((p: string) => (p === '/' ? html : undefined)) : html)
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b9r-')))
  const engine: any = new ChromiumEngine({ executable: chrome.path!, profileDir: join(home, 'browser', 'k'), outputDir: join(home, 'output', 'k'), scope: 'fixture' })
  await engine.start()
  const cards: any[] = []
  const slot: any = { engine, paths: { key: 'k' } }
  const pool: any = { acquire: async () => slot, peek: () => slot, slotKey: () => 'k', pathsFor: () => slot.paths, release: async () => true }
  const gates = gated ? new GateKeeper({ postCard: async (card: any) => { cards.push(card); return true }, readGate: async (gateId: string) => (answer === 'pending' ? { gateId, state: 'pending', status: 'pending' } : { gateId, state: 'answered', status: 'answered', answered: true, choice: answer, answer }), randomBytes: (n: number) => Buffer.alloc(n, 7), sleep: async () => {}, log: () => {} } as any) : undefined
  const core: any = new BrowserHostCore({ pool, browserTools: servedBrowserTools(await listTools({ caps: DEFAULT_CAPS, outputDir: join(home, 'tools') })), deviceLabel: 'Build box', gates, isOwnerPrincipal: () => true } as any)
  core._settingsFor = () => ({})
  core._grantsFor = () => ({ [site.origin]: { navigate, write, access: 'allow' } })
  t.after(async () => { await engine.stop().catch(() => {}); await site.close(); rmSync(home, { recursive: true, force: true }) })
  await engine.callTool('browser_navigate', { url: `${site.origin}${path}` })
  return { core, engine, site, cards, clicks: site.clicks, page: engine.selectedPage(), origin: site.origin, call: (name: string, args: any = {}) => core.callTool(OWNER, name, args) }
}

test('P1-4 a gate reads the page, never the net: a hidden field beside a button changes no card', { skip, timeout: 60_000 }, async (t) => {
  const r = await rig(t, `<form onsubmit="return false"><input type=hidden name=token value="Delete account"><button onclick="fetch('/clicked/d')">Delete account</button></form><div><div><button id="show-password">
  <svg></svg>
</button><button onclick="fetch('/clicked/e')">Delete account two</button></div></div>`)
  const tree = textOf(await r.call('browser_snapshot'))
  assert.doesNotMatch(tree, /\(masked\)- /, 'every line is whole')
  for (const name of ['Delete account two', 'button "Delete account"']) {
    const ref = refOf(tree, name)
    assert.ok(ref, tree)
    await r.call('browser_click', { target: ref, element: 'Show the report', wait_seconds: 1 })
    await pause(150)
  }
  assert.deepEqual(r.clicks, [], 'neither delete ran')
  assert.equal(r.cards.length, 2)
  for (const card of r.cards) assert.equal(card.kind, 'sensitive')
  assert.match(r.cards[0].summary, /Delete account two/)
  assert.doesNotMatch(r.cards[0].summary, /^click Show the report/, 'the agent\'s words never name the target')
})

test('P1-5 the host\'s own refusals reach the agent, with the gate id and the do not retry', { skip, timeout: 60_000 }, async (t) => {
  const r = await rig(t, '<button>Delete account</button>')
  const tree = textOf(await r.call('browser_snapshot'))
  const denied = await r.call('browser_click', { target: refOf(tree, 'Delete account'), element: 'x', wait_seconds: 1 })
  assert.equal(denied.isError, true)
  assert.match(textOf(denied), /policy_denied/, textOf(denied))
  assert.match(textOf(denied), /do not retry/)
  r.core._permit = async () => ({ parked: true, gateId: 'gate_123', summary: 'Delete account', expiresAt: 'later' })
  const parked = await r.call('browser_click', { target: refOf(tree, 'Delete account'), element: 'x' })
  assert.match(textOf(parked), /gate_parked/, textOf(parked))
  const gateId = /gateId "([^"]+)"/.exec(textOf(parked))?.[1]
  assert.ok(gateId, 'the agent has the id it needs to keep waiting')
  assert.match(textOf(await r.call('browser_snapshot', { target: 'input[type=password]' })), /host element refs/)
  assert.match(textOf(await r.call('browser_nonsense')), /Unknown tool/)
  assert.match(textOf(await r.call('hoai_browser_wait_gate', { gate_id: 'gate_nope' })), /No permission request/)
})

test('P1-6 one failed read fails one call, and slow frames, churn, busy pages and big fields lock nothing', { skip, timeout: 180_000 }, async (t) => {
  const r = await rig(t, undefined, { path: '/plain' })
  r.page.goto(`${r.origin}/slow`, { waitUntil: 'commit' }).catch(() => {})
  await pause(400)
  const slow = textOf(await r.call('browser_snapshot'))
  assert.match(slow, /Article with a slow embed/, slow)
  await r.page.setContent('<h1>Ads</h1><div id=s></div><script>setInterval(()=>{const f=document.createElement("iframe");f.srcdoc="<p>ad</p>";s.appendChild(f);setTimeout(()=>f.remove(),15);},10)</script>')
  for (let index = 0; index < 10; index += 1) assert.match(textOf(await r.call('browser_snapshot')), /heading "Ads"/)
  await r.page.setContent('<h1>Hydrating</h1>')
  await r.page.evaluate(() => { setTimeout(() => { const end = Date.now() + 2600; while (Date.now() < end); }, 50) })
  await pause(100)
  await r.call('browser_snapshot')
  await pause(2800)
  await r.page.setContent('<h1>Recovered page</h1>')
  assert.match(textOf(await r.call('browser_snapshot')), /Recovered page/)
  for (let index = 0; index < 4; index += 1) {
    await r.page.setContent(`<form><input type=hidden name=__VIEWSTATE value="${Buffer.from(String(index).repeat(200 * 1024)).toString('base64')}"><h1>Page ${index}</h1></form>`)
    assert.match(textOf(await r.call('browser_snapshot')), new RegExp(`Page ${index}`))
  }
  await r.page.setContent('<div><meter value=3 max=5></meter>x</div><h1>Meter</h1>')
  assert.match(textOf(await r.call('browser_snapshot')), /heading "Meter"/)
  const toImpl = r.page._connection.toImpl
  const frame = toImpl(r.page.mainFrame()), utilityContext = frame.utilityContext
  frame.utilityContext = () => Promise.reject(new Error('MADEUPPAGEDETAIL'))
  const failed = textOf(await r.call('browser_snapshot'))
  frame.utilityContext = utilityContext
  assert.match(failed, /could not be read/i)
  assert.doesNotMatch(failed, /MADEUPPAGEDETAIL|Meter/)
  assert.match(textOf(await r.call('browser_snapshot')), /heading "Meter"/)
})

test('P1-6 a dialog in a background tab stops nothing, and a click during a dialog says so and recovers', { skip, timeout: 90_000 }, async (t) => {
  const r = await rig(t, '<button id=a onclick="setTimeout(()=>alert(1),0)">Show the report</button><button id=b>Another report</button>')
  const tree = textOf(await r.call('browser_snapshot'))
  await r.call('browser_click', { target: refOf(tree, 'Show the report'), element: 'x' })
  await pause(300)
  const during = textOf(await r.call('browser_click', { target: refOf(tree, 'Another report'), element: 'y' }))
  assert.match(during, /dialog/i, during)
  assert.equal(r.cards.length, 0, 'a click that cannot run asks nobody')
  await r.call('browser_handle_dialog', { accept: false })
  assert.match(textOf(await r.call('browser_snapshot')), /Another report/)
  await r.call('browser_tabs', { action: 'new' })
  r.engine.pages()[0].evaluate(() => { setTimeout(() => alert('x'), 5) }).catch(() => {})
  await pause(200)
  for (let index = 0; index < 2; index += 1) assert.doesNotMatch(textOf(await r.call('browser_snapshot')), /could not be|failed/i)
})

test('P1-8 two refs from one snapshot both work, and a form fills', { skip, timeout: 60_000 }, async (t) => {
  const r = await rig(t, `<button onclick="fetch('/clicked/a')">Show the report</button><button onclick="fetch('/clicked/b')">Show the chart</button><input aria-label=One><input aria-label=Two>`)
  const tree = textOf(await r.call('browser_snapshot'))
  assert.equal((await r.call('browser_click', { target: refOf(tree, 'Show the report'), element: 'x' })).isError === true, false)
  const second = await r.call('browser_click', { target: refOf(tree, 'Show the chart'), element: 'y' })
  assert.equal(second.isError === true, false, textOf(second))
  const filled = await r.call('browser_fill_form', { fields: [{ target: refOf(tree, 'One'), name: 'One', type: 'textbox', value: 'hello' }, { target: refOf(tree, 'Two'), name: 'Two', type: 'textbox', value: 'world' }] })
  assert.equal(filled.isError === true, false, textOf(filled))
  await pause(150)
  assert.deepEqual(r.clicks, ['a', 'b'])
  assert.deepEqual(await r.page.evaluate(() => [...document.querySelectorAll('input')].map((input: any) => input.value)), ['hello', 'world'])
})

test('P2-1 wait_for waits, and says when the text did not appear', { skip, timeout: 60_000 }, async (t) => {
  const r = await rig(t, '<div id=x>loading</div><script>setTimeout(()=>{document.getElementById("x").textContent="READY NOW"},800)</script>')
  await r.page.reload()
  const started = Date.now()
  const came = await r.call('browser_wait_for', { text: 'READY NOW' })
  assert.ok(Date.now() - started >= 400, 'it waited')
  assert.equal(came.isError === true, false, textOf(came))
  const never = await r.call('browser_wait_for', { text: 'NEVER HERE', time: 1 })
  assert.equal(never.isError, true)
  assert.match(textOf(never), /did not (appear|match)/i)
})

test('P2-5 slow typing is refused, and a label is read as its control', { skip, timeout: 90_000 }, async (t) => {
  const r = await rig(t, `<form onsubmit="fetch('/clicked/submit');return false"><input aria-label=Note><button type=submit>Delete account</button></form>
    <label for=hid>Continue</label><button id=hid onclick="fetch('/clicked/label')">Delete account three</button>
    <button onclick="fetch('/clicked/span')"><span>Go</span> Delete account two</button>
    <button id=n onclick="if(confirm('Delete your account?'))fetch('/clicked/confirm')">Next step</button>`)
  const tree = textOf(await r.call('browser_snapshot'))
  const refused = await r.call('browser_type', { target: refOf(tree, 'Note'), text: 'x\n', slowly: true, element: 'Note', wait_seconds: 1 })
  assert.equal(refused.isError, true)
  assert.match(textOf(refused), /separate.*browser_click/)
  assert.equal(r.cards.length, 0)
  assert.equal(await r.page.locator('input').inputValue(), '')
  const label = /text: Continue|generic \[ref=(e\d+)\]: Continue/.exec(tree)
  const ref = label?.[1] || refOf(tree, 'Continue')
  assert.ok(ref, tree)
  await r.call('browser_click', { target: ref, element: 'Continue', wait_seconds: 1 })
  assert.match(r.cards.at(-1)?.summary, /Delete account three/, 'a label is read as the control it clicks')
  await pause(150)
  assert.deepEqual(r.clicks, [], 'neither ran')
})

test('P2-6 Backspace still runs, Enter cannot submit a search or activate Delete', { skip, timeout: 90_000 }, async (t) => {
  const r = await rig(t, `<form action="/search"><input aria-label=Search name=q><button>Search</button></form><button id=d onclick="fetch('/clicked/d')">Delete account</button>`)
  await r.call('browser_snapshot')
  await r.page.locator('[name=q]').fill('shoes')
  const back = await r.call('browser_press_key', { key: 'Backspace', wait_seconds: 1 })
  assert.equal(back.isError === true, false, textOf(back))
  assert.equal(r.cards.length, 0, 'Backspace asks nobody')
  const enter = await r.call('browser_press_key', { key: 'Enter', wait_seconds: 1 })
  assert.equal(enter.isError, true, textOf(enter))
  assert.match(textOf(enter), /form_submit_approval_required/)
  assert.equal(r.page.url(), `${r.origin}/`)
  assert.equal(r.cards.length, 0)
  await r.page.locator('#d').focus()
  const refused = await r.call('browser_press_key', { key: 'Enter', wait_seconds: 1 })
  assert.equal(refused.isError, true)
  assert.match(textOf(refused), /form_submit_approval_required/)
  assert.equal(r.cards.length, 0)
  await pause(100)
  assert.deepEqual(r.clicks, [])
})

test('RULING a card says what the host read, marks the agent\'s words apart, and says when it could not read', { skip, timeout: 60_000 }, async (t) => {
  const r = await rig(t, `<button onclick="fetch('/clicked/d')">Delete account</button><button id=x onclick="fetch('/clicked/x')" aria-label=""><svg width=20 height=20></svg></button>`, { write: 'ask' })
  r.core._grantsFor = () => ({ [r.origin]: { navigate: 'allow', access: 'allow' } })
  const tree = textOf(await r.call('browser_snapshot'))
  await r.call('browser_click', { target: refOf(tree, 'Delete account'), element: 'Tidy the list', wait_seconds: 1 })
  const named = r.cards.at(-1)
  assert.match(named.summary, /click "Delete account"/, named.summary)
  assert.match(named.summary, /the agent says: Tidy the list/)
  const blindRef = /- button \[ref=(e\d+)\]/.exec(tree)?.[1]
  assert.ok(blindRef, tree)
  await r.call('browser_click', { target: blindRef, element: 'Open the note', wait_seconds: 1 })
  const blind = r.cards.at(-1)
  assert.match(blind.summary, /could not read/i, blind.summary)
  assert.match(blind.summary, /the agent says: Open the note/)
  assert.equal(blind.kind, 'sensitive')
  assert.deepEqual(blind.choices, ['allow_once', 'deny'])
  await r.page.setContent('<div id=c contenteditable style="-webkit-text-security:disc">MADEUPCARD</div>')
  const held = textOf(await r.call('browser_snapshot'))
  const before = r.cards.length
  const answer = await r.call('browser_click', { target: 'e2', element: 'x', wait_seconds: 1 })
  assert.equal(r.cards.length, before)
  assert.equal(textOf(answer), 'This browser is private. Finish here, then press Hand back so I can carry on.')
  assert.doesNotMatch(JSON.stringify(r.cards), /MADEUPCARD/)
})

test('normal browsing on a real site: read, click, two fields from one snapshot, wait, screenshot, slow frame, alert', { skip, timeout: 180_000 }, async (t) => {
  const r = await rig(t, undefined, { answer: 'allow_once' })
  const tree = textOf(await r.call('browser_snapshot'))
  assert.equal(tree.includes('(masked)'), false, tree)
  assert.equal(tree.includes(CSRF), false)
  assert.match(tree, /heading "Corner Shop" \[level=1\]/)
  assert.match(tree, /heading "Orders 2021 for 100 items"/)
  assert.match(tree, /button "Pin message"/)
  assert.equal((await r.call('browser_click', { target: refOf(tree, 'Show the report'), element: 'r' })).isError === true, false)
  assert.equal(await r.page.locator('#out').textContent(), 'report shown')
  assert.equal((await r.call('browser_click', { target: refOf(tree, 'Show the chart'), element: 'c' })).isError === true, false)
  assert.equal(await r.page.locator('#out').textContent(), 'chart shown')
  const filled = await r.call('browser_fill_form', { fields: [
    { target: refOf(tree, 'First name'), name: 'First', type: 'textbox', value: 'Sam' },
    { target: refOf(tree, 'Last name'), name: 'Last', type: 'textbox', value: 'Reed' },
  ] })
  assert.equal(filled.isError === true, false, textOf(filled))
  assert.equal(await r.page.locator('[name=first]').inputValue(), 'Sam')
  assert.equal(await r.page.locator('[name=last]').inputValue(), 'Reed')
  const booked = await r.call('browser_click', { target: refOf(tree, 'Book delivery'), element: 'b' })
  assert.notEqual(booked.isError, true, textOf(booked))
  assert.equal(r.cards.length, 1, 'the submit step needs a fresh approval after filling')
  assert.match(r.cards[0].summary, /Book delivery/)
  assert.deepEqual(r.cards[0].choices, ['allow_once', 'deny'])
  const waited = await r.call('browser_wait_for', { text: 'Delivery booked' })
  assert.equal(waited.isError === true, false, textOf(waited))
  assert.ok(hasImage(await r.call('browser_take_screenshot')))
  await r.call('browser_click', { target: refOf(tree, 'Say hello'), element: 'h' })
  await pause(150)
  assert.match(textOf(await r.call('browser_snapshot')), /dialog/i)
  const answered = await r.call('browser_handle_dialog', { accept: true, wait_seconds: 1 })
  assert.equal(answered.isError === true, false, textOf(answered))
  assert.equal(r.cards.length, 1, 'the alert adds no approval after the separate submit approval')
  assert.match(textOf(await r.call('browser_snapshot')), /Corner Shop/)
  await r.call('browser_navigate', { url: `${r.origin}/slow` })
  const slow = textOf(await r.call('browser_snapshot'))
  assert.match(slow, /Article with a slow embed/)
  assert.equal((await r.call('browser_click', { target: refOf(slow, 'Mark read'), element: 'm' })).isError === true, false)
  assert.equal(await r.page.locator('#o').textContent(), 'read')
  assert.ok(hasImage(await r.call('browser_take_screenshot')))
  const products = await r.call('browser_navigate', { url: `${r.origin}/products?page=1` })
  assert.match(textOf(products), /products\?page=1/)
})
