/** Held approvals bind to the page, document and live controls the owner approved. Synthetic pages only. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserHostCore, ChromiumEngine, DEFAULT_CAPS, listTools, resolveChromeExecutable, servedBrowserTools } from '../bin/hoai-browser-host.mjs'
import { GateKeeper } from '../lib/browser-gate.mjs'

const chrome = resolveChromeExecutable()
const skip = chrome.path ? false : 'no Chrome or Chromium is installed on this machine'
const OWNER = { assistantId: 42, principal: 'owner', assistantName: 'Atlas' }
const html = (name: string) => `<h1>Fixture</h1><button id=action onclick="window.fixtureClicks=(window.fixtureClicks||0)+1">${name}</button><button id=other onclick="window.fixtureClicks=(window.fixtureClicks||0)+1">Delete account B</button>`
const refFor = async (page: any, selector = '#action') => {
  const tree = await page.locator(selector).ariaSnapshot({ mode: 'ai' })
  const ref = /\[ref=((?:f\d+)?e\d+)\]/.exec(tree)?.[1]
  assert.ok(ref, tree)
  await page.ariaSnapshot({ mode: 'ai' })
  return ref
}
async function rig(t: any) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bh-bind-')))
  const engine: any = new ChromiumEngine({ executable: chrome.path!, profileDir: join(home, 'browser', 'k'), outputDir: join(home, 'output', 'k'), scope: 'fixture' })
  await engine.start()
  t.after(async () => { await engine.stop(); rmSync(home, { recursive: true, force: true }) })
  const page = engine.selectedPage()
  await page.setContent(html('Send report A'))
  await engine.selectPage(page)
  const cards: any[] = []
  let post!: () => void, allow!: () => void
  const posted = new Promise<void>(resolve => { post = resolve })
  const answer = new Promise<void>(resolve => { allow = resolve })
  const gates = new GateKeeper({ postCard: async (card: any) => { cards.push(card); post(); return true }, readGate: async () => { await answer; return { state: 'answered', choice: 'allow_once' } }, randomBytes: (n: number) => Buffer.alloc(n, 7), sleep: async () => {}, log: () => {} })
  const slot: any = { engine, paths: { key: 'k' } }
  const pool: any = { acquire: async () => slot, peek: () => slot, slotKey: () => 'k' }
  const core: any = new BrowserHostCore({ pool, browserTools: servedBrowserTools(await listTools({ caps: DEFAULT_CAPS, outputDir: join(home, 'tools') })), deviceLabel: 'Fixture', gates, isOwnerPrincipal: () => true })
  core._settingsFor = () => ({})
  core._grantsFor = () => ({})
  core._currentOrigin = async () => 'https://fixture.example'
  const call = (name: string, args: any = {}) => core.callTool(OWNER, name, args)
  return { engine, page, cards, posted, allow, call }
}

for (const change of ['tab', 'document', 'name', 'replacement', 'focus', 'preflight', 'unchanged']) {
  test(`an approved action refuses a changed ${change}, with an unchanged control`, { skip, timeout: 90_000 }, async t => {
    const r = await rig(t)
    const target = await refFor(r.page)
    let other: any
    if (change === 'tab') {
      other = await r.engine.newPage()
      await other.setContent(html('Delete account B'))
      assert.equal(await refFor(other), target, 'the other page reuses the same ref')
      await r.engine.selectPage(r.page)
    }
    if (change === 'focus') await r.page.locator('#action').focus()
    const pending = r.call(change === 'focus' ? 'browser_press_key' : 'browser_click', change === 'focus' ? { key: 'Backspace', wait_seconds: 30 } : { target, element: 'Send report A', wait_seconds: 30 })
    await Promise.race([r.posted, pending.then((result: any) => { throw new Error(`No gate: ${JSON.stringify(result)}`) })])
    if (change !== 'focus') assert.match(r.cards[0].summary, /Send report A/)
    if (change === 'tab') await r.engine.selectPage(other)
    if (change === 'document') { await r.page.reload(); await r.page.setContent(html('Send report A')); await refFor(r.page) }
    if (change === 'name') await r.page.locator('#action').evaluate((el: any) => { el.textContent = 'Delete account B' })
    if (change === 'replacement') {
      await r.page.locator('#action').evaluate((el: any) => { el.replaceWith(el.cloneNode(true)) })
      await refFor(r.page)
    }
    if (change === 'focus') await r.page.locator('#other').focus()
    if (change === 'preflight') {
      const privacy = r.engine._engine._privacy, original = privacy.preflight.bind(privacy)
      privacy.preflight = async (...args: any[]) => {
        const out = await original(...args)
        await r.page.locator('#action').evaluate((el: any) => { el.textContent = 'Delete account B' })
        return out
      }
    }
    r.allow()
    const result = await pending
    if (change === 'unchanged') {
      assert.notEqual(result.isError, true, JSON.stringify(result))
      assert.equal(await r.page.evaluate(() => (window as any).fixtureClicks || 0), 1)
    } else {
      assert.equal(result.isError, true, JSON.stringify(result))
      assert.match(JSON.stringify(result), /target_changed/)
      assert.equal(await r.page.evaluate(() => (window as any).fixtureClicks || 0), 0)
      if (other) assert.equal(await other.evaluate(() => (window as any).fixtureClicks || 0), 0)
    }
  })
}

const form = `<form onsubmit="window.submits=(window.submits||0)+1;return false">
<label>Reference<input id=reference oninput="document.querySelector('#send')?.remove();document.querySelector('#delete').type='submit'"></label>
<button id=send type=submit>Send report A</button><button id=delete type=button onclick="window.deleted=true">Delete account B</button></form>`

for (const action of ['submit', 'slowly', 'Enter', 'Control+Enter', 'NumpadEnter', 'Return', 'Space', ' ']) {
  test(`form submission requires a separate click, refuses ${JSON.stringify(action)}`, { skip, timeout: 90_000 }, async t => {
    const r = await rig(t)
    await r.page.setContent(form)
    const target = await refFor(r.page, '#reference')
    await r.page.locator(action === 'Space' || action === ' ' ? '#send' : '#reference').focus()
    r.allow()
    const result = await r.call(['submit', 'slowly'].includes(action) ? 'browser_type' : 'browser_press_key',
      action === 'submit' ? { target, text: 'hello', submit: true, element: 'Send report A' } :
      action === 'slowly' ? { target, text: 'hello\n', slowly: true, element: 'Send report A' } : { key: action })
    assert.equal(result.isError, true, JSON.stringify(result))
    await assert.rejects(r.engine.callTool(['submit', 'slowly'].includes(action) ? 'browser_type' : 'browser_press_key',
      action === 'submit' ? { target, text: 'hello', submit: true } : action === 'slowly' ? { target, text: 'hello\n', slowly: true } : { key: action }),
      { code: 'not_available' }, 'the engine also refuses calls that bypass the core')
    assert.match(JSON.stringify(result), /separate.*browser_click/i)
    assert.equal(r.cards.length, 0, 'unsupported submission must be refused before approval')
    assert.equal(await r.page.locator('#reference').inputValue(), '')
    assert.equal(await r.page.evaluate(() => (window as any).submits || 0), 0)
    assert.equal(await r.page.evaluate(() => !!(window as any).deleted), false)
  })
}

test('fill mutates the form without submitting, then an explicit click approves the new exact button', { skip, timeout: 90_000 }, async t => {
  const r = await rig(t)
  await r.page.setContent(form)
  const target = await refFor(r.page, '#reference')
  r.allow()
  const filled = await r.call('browser_type', { target, text: 'hello', element: 'Reference' })
  assert.notEqual(filled.isError, true, JSON.stringify(filled))
  assert.equal(await r.page.locator('#reference').inputValue(), 'hello')
  assert.equal(await r.page.evaluate(() => (window as any).submits || 0), 0)
  assert.equal(await r.page.evaluate(() => !!(window as any).deleted), false)
  const clicked = await r.call('browser_click', { target: await refFor(r.page, '#delete'), element: 'Delete account B' })
  assert.notEqual(clicked.isError, true, JSON.stringify(clicked))
  assert.match(r.cards.at(-1).summary, /Delete account B/)
  assert.equal(await r.page.evaluate(() => (window as any).submits || 0), 1)
  assert.equal(await r.page.evaluate(() => !!(window as any).deleted), true)
})

test('served fill schema has no composite action or sequential typing', async () => {
  const tools = servedBrowserTools(await listTools({ caps: DEFAULT_CAPS, outputDir: '.' }))
  const type = tools.find((tool: any) => tool.name === 'browser_type')!
  assert.ok(type)
  assert.equal(type.inputSchema.properties.submit, undefined)
  assert.equal(type.inputSchema.properties.slowly, undefined)
  assert.doesNotMatch(type.description, /submit.*true|press.*Enter/i)
})
