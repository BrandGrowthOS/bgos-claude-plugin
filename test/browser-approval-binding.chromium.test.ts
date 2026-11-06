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
  return { engine, page, cards, posted, allow, call, core }
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

for (const direct of [false, true]) {
  for (const granted of [false, true]) {
    test(`key grammar refuses composite chords via ${direct ? 'engine' : 'host'}, write grant=${granted}`, { skip, timeout: 90_000 }, async t => {
      const r = await rig(t)
      if (granted) r.core._grantsFor = () => ({ 'https://fixture.example': { write: 'allow' } })
      r.allow()
      for (const key of ['Enter+Shift', 'Space+Shift', 'NumpadEnter+Control', 'Return+Alt', 'Spacebar+Meta', ' +Shift', 'h+Enter+Shift', 'Shift+Enter+ArrowLeft', 'h+ArrowLeft', 'Backspace+Shift', 'shift+ArrowLeft', 'Shift++ArrowLeft', '', 'Shift+\n+ArrowLeft']) {
        await t.test(JSON.stringify(key), async () => {
          r.cards.length = 0
          await r.page.setContent(form)
          await refFor(r.page, '#reference')
          await r.page.locator(key.startsWith('Space') || key.startsWith(' ') ? '#send' : '#reference').focus()
          if (direct) {
            await assert.rejects(r.engine.callTool('browser_press_key', { key }), { code: 'not_available' })
          } else {
            const result = await r.call('browser_press_key', { key })
            assert.equal(result.isError, true, JSON.stringify(result))
            assert.match(JSON.stringify(result), /separate.*browser_click/i)
          }
          assert.equal(r.cards.length, 0, 'refused before any approval, even with an existing write grant')
          assert.equal(await r.page.locator('#reference').inputValue(), '')
          assert.equal(await r.page.evaluate(() => (window as any).submits || 0), 0)
          assert.equal(await r.page.evaluate(() => !!(window as any).deleted), false)
        })
      }
    })
  }
}

test('genuine modifier chords and literal plus keys still execute', { skip, timeout: 90_000 }, async t => {
  const r = await rig(t)
  r.core._grantsFor = () => ({ 'https://fixture.example': { write: 'allow' } })
  await r.page.setContent('<label>Reference<input id=reference value=hello></label>')
  await refFor(r.page, '#reference')
  await r.page.locator('#reference').focus()
  r.allow()
  for (const key of ['Shift+ArrowLeft', 'Control+ArrowLeft', 'Alt+ArrowLeft', 'Meta+ArrowLeft', 'ControlOrMeta+ArrowLeft', 'Control+Shift+ArrowLeft', '+', 'Shift++']) {
    const page = await r.engine.newPage()
    await page.setContent('<label>Reference<input id=reference value=hello></label>')
    await r.engine.selectPage(page)
    await refFor(page, '#reference')
    await page.locator('#reference').focus()
    const result = await r.call('browser_press_key', { key })
    assert.notEqual(result.isError, true, `${key}: ${JSON.stringify(result)}`)
    await r.engine.selectPage(r.page)
    await page.close()
  }
  assert.equal(r.cards.length, 0)
})

test('real engine roster serializes complete JSON Schemas without composite fields', { skip, timeout: 90_000 }, async t => {
  const r = await rig(t)
  const roster = JSON.parse(JSON.stringify(r.engine._engine.roster()))
  for (const [name, required] of [['browser_type', ['target', 'text']], ['browser_click', ['target']], ['browser_press_key', ['key']]] as const) {
    const tool = roster.find((item: any) => item.name === name)
    assert.equal(tool.inputSchema.type, 'object')
    for (const key of required) {
      assert.ok(tool.inputSchema.properties[key], `${name} advertises ${key}`)
      assert.ok(tool.inputSchema.required.includes(key), `${name} requires ${key}`)
    }
    assert.ok(tool.inputSchema.properties.wait_seconds)
  }
  assert.ok(roster.find((item: any) => item.name === 'browser_type').inputSchema.properties.element)
  assert.deepEqual(roster.find((item: any) => item.name === 'browser_fill_form').inputSchema.properties.fields.items.properties.type.enum, ['textbox'])
  assert.equal(roster.some((item: any) => item.name === 'browser_press_sequentially'), false)
  assert.doesNotMatch(JSON.stringify(roster), /"(?:submit|slowly|def|_def)"\s*:/)
})

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

const changedCheckboxForm = `<form onsubmit="window.batchSubmits=(window.batchSubmits||0)+1;return false">
<label>Reference<input id=reference oninput="document.querySelector('#include').textContent='Delete account B';document.querySelector('#include').type='submit'"></label>
<button id=include type=button role=checkbox aria-checked=false onclick="this.setAttribute('aria-checked','true');window.batchDeleted=true">Include summary</button></form>`

for (const direct of [false, true]) for (const granted of [false, true]) {
  test(`batch fill cannot activate a changed checkbox via ${direct ? 'engine' : 'host'}, grant=${granted}`, { skip, timeout: 90_000 }, async t => {
    const r = await rig(t)
    await r.page.setContent(changedCheckboxForm)
    const fields = [
      { name: 'Reference', type: 'textbox', target: await refFor(r.page, '#reference'), value: 'hello' },
      { name: 'Include summary', type: 'checkbox', target: await refFor(r.page, '#include'), value: 'true' },
    ]
    if (granted) r.core._grantsFor = () => ({ 'https://fixture.example': { write: 'allow' } })
    r.allow()
    if (direct) await assert.rejects(r.engine.callTool('browser_fill_form', { fields }), { code: 'not_available' })
    else assert.equal((await r.call('browser_fill_form', { fields })).isError, true)
    assert.equal(r.cards.length, 0)
    assert.equal(await r.page.locator('#reference').inputValue(), '')
    assert.equal(await r.page.evaluate(() => (window as any).batchSubmits || 0), 0)
    assert.equal(await r.page.evaluate(() => !!(window as any).batchDeleted), false)
  })
}

test('a write grant cannot approve the submit step after a fill', { skip, timeout: 90_000 }, async t => {
  const r = await rig(t)
  r.core._grantsFor = () => ({ 'https://fixture.example': { write: 'allow' } })
  await r.page.setContent('<form onsubmit="window.submits=(window.submits||0)+1;return false"><label>Reference<input id=reference></label><button id=delete type=submit>Save draft</button></form>')
  assert.notEqual((await r.call('browser_type', { target: await refFor(r.page, '#reference'), text: 'hello' })).isError, true)
  const pending = r.call('browser_click', { target: await refFor(r.page, '#delete') })
  await Promise.race([r.posted, pending.then((result: any) => { throw new Error(`Submit ran without a fresh gate: ${JSON.stringify(result)}`) })])
  assert.match(r.cards[0].summary, /Save draft/)
  assert.deepEqual(r.cards[0].choices, ['allow_once', 'deny'])
  assert.equal(await r.page.evaluate(() => (window as any).submits || 0), 0)
  r.allow()
  assert.notEqual((await pending).isError, true)
  assert.equal(await r.page.evaluate(() => (window as any).submits || 0), 1)
  assert.equal(r.engine.formSubmitRequirement('browser_click', {}), null, 'approval clears the filled set')
})

test('another fill invalidates a held submit approval even when the target is unchanged', { skip, timeout: 90_000 }, async t => {
  const r = await rig(t)
  r.core._grantsFor = () => ({ 'https://fixture.example': { write: 'allow' } })
  await r.page.setContent('<form onsubmit="window.submits=(window.submits||0)+1;return false"><label>Reference<input id=reference></label><button id=save>Save draft</button></form>')
  const target = await refFor(r.page, '#reference')
  await r.call('browser_type', { target, text: 'first' })
  const pending = r.call('browser_click', { target: await refFor(r.page, '#save') })
  await Promise.race([r.posted, pending.then((result: any) => { throw new Error(`No gate: ${JSON.stringify(result)}`) })])
  await r.engine.callTool('browser_type', { target, text: 'second' })
  r.allow()
  const result = await pending
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result), /form_submit_approval_required/)
  assert.equal(await r.page.evaluate(() => (window as any).submits || 0), 0)
  assert.equal(await r.page.locator('#reference').inputValue(), 'second')
})

test('textbox-only batch fills two fields without activation and retains the submit barrier', { skip, timeout: 90_000 }, async t => {
  const r = await rig(t)
  r.core._grantsFor = () => ({ 'https://fixture.example': { write: 'allow' } })
  await r.page.setContent('<form onsubmit="window.submits=(window.submits||0)+1;return false"><label>Reference<input id=reference></label><label>Summary<input id=summary></label><button id=save>Save draft</button></form>')
  const fields = [
    { target: await refFor(r.page, '#reference'), name: 'Reference', type: 'textbox', value: 'hello' },
    { target: await refFor(r.page, '#summary'), name: 'Summary', type: 'textbox', value: 'world' },
  ]
  const result = await r.call('browser_fill_form', { fields })
  assert.notEqual(result.isError, true, JSON.stringify(result))
  assert.equal(r.cards.length, 0)
  assert.equal(await r.page.locator('#reference').inputValue(), 'hello')
  assert.equal(await r.page.locator('#summary').inputValue(), 'world')
  assert.equal(await r.page.evaluate(() => (window as any).submits || 0), 0)
  await assert.rejects(r.engine.callTool('browser_click', { target: await refFor(r.page, '#save') }), { code: 'form_submit_approval_required' })
})

test('a first direct-engine fill tracks its lazily selected tab', { skip, timeout: 90_000 }, async t => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bh-first-fill-')))
  const engine: any = new ChromiumEngine({ executable: chrome.path!, profileDir: join(home, 'browser', 'k'), outputDir: join(home, 'output', 'k'), scope: 'fixture' })
  await engine.start()
  t.after(async () => { await engine.stop(); rmSync(home, { recursive: true, force: true }) })
  const page = engine.selectedPage()
  await page.setContent('<form onsubmit="window.submits=(window.submits||0)+1;return false"><label>Reference<input id=reference></label><button id=save>Save draft</button></form>')
  await engine._engine._privacy.watchPersonInput(page)
  await engine.handBackPrivacy(page)
  const target = await refFor(page, '#reference')
  assert.equal(!!engine._engine._currentTab(), false, 'no prior tool or explicit tab selection initializes the backend')
  const filled = await engine.callTool('browser_type', { target, text: 'hello' })
  assert.notEqual(filled.isError, true, JSON.stringify(filled))
  assert.equal(await page.locator('#reference').inputValue(), 'hello')
  let refusal: any
  try { await engine.callTool('browser_click', { target: await refFor(page, '#save') }) } catch (error) { refusal = error }
  assert.equal(await page.evaluate(() => (window as any).submits || 0), 0, 'the first fill must not leave a native submission path')
  assert.equal(refusal?.code, 'form_submit_approval_required')
})
