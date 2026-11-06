import test from 'node:test'
import assert from 'node:assert/strict'
import * as host from '../bin/hoai-browser-host.mjs'
import privacy from '../lib/browser-host-core/answer-privacy.js'

function dispatcher() {
  const engine: any = new host.PlaywrightEngine({ caps: [], outputDir: '.', clientName: 'fixture', clientVersion: '0' })
  const calls: string[] = []
  const page = { url: () => 'https://fixture.example', isClosed: () => false, close: async () => { calls.push('browser_close') } }
  engine._backend = { _context: { currentTab: () => ({ page }) }, callTool: async (name: string) => { calls.push(name); return { content: [] } } }
  engine._privacy = {
    response: (_: any, work: any) => work(), validate: () => {}, personMode: () => false,
    preflight: async () => null, reloadRequired: () => false, agentAction: (_: any, work: any) => work(),
    forPage: (_: any, work: any) => work(), after: async () => {}, keep: (v: any) => v,
    value: (v: any) => v, image: async (v: any) => v, endWriting: async () => {}, isUnreadable: () => false, error: (v: any) => v, copy: { closed: 'Closed' },
  }
  engine.dialogWaiting = () => false
  engine.tabsOverview = () => ({ content: [] })
  return { engine, page, calls }
}
const argsFor = (name: string): any => name === 'browser_type' ? { target: 'e1', text: 'hello' } :
  name === 'browser_fill_form' ? { fields: [{ target: 'e2', type: 'textbox', name: 'Reference', value: 'hello' }] } :
  name === 'browser_press_key' ? { key: 'ArrowLeft' } : name === 'browser_navigate' ? { url: 'https://fixture.example' } : {}

test('every registered tool has an explicit fill and submit classification', async () => {
  const classes = (host as any).FORM_TOOL_CLASSES
  assert.ok(classes, 'the dispatcher must own an explicit classification registry')
  assert.deepEqual(Object.keys(classes).sort(), [...privacy.SAFE_TOOLS].sort())
  for (const tool of await host.listTools({ caps: host.DEFAULT_CAPS, outputDir: '.' })) assert.ok(classes[tool.name], tool.name)
})

test('every registered tool passes through the filled-tab dispatcher rule', async t => {
  const safe = new Set(['browser_snapshot', 'browser_find', 'browser_take_screenshot', 'browser_wait_for', 'browser_type', 'browser_fill_form'])
  for (const name of [...privacy.SAFE_TOOLS, 'browser_future_tool', 'browser_evaluate', 'browser_run_code_unsafe']) await t.test(name, async () => {
    const { engine, calls } = dispatcher()
    await engine.callTool('browser_type', argsFor('browser_type'))
    calls.length = 0
    if (safe.has(name)) {
      await engine.callTool(name, argsFor(name))
      assert.deepEqual(calls, [name])
    } else {
      await assert.rejects(engine.callTool(name, argsFor(name)), { code: 'form_submit_approval_required' })
      assert.deepEqual(calls, [])
      await assert.rejects(engine.callTool(name, { ...argsFor(name), approved: true }, undefined, { approved: true }, { approved: true }), { code: 'form_submit_approval_required' })
    }
  })
})

test('filled fields remain per tab, survive errors and document navigation', async () => {
  const { engine, page } = dispatcher()
  await engine.callTool('browser_type', argsFor('browser_type'))
  const first = engine.formSubmitRequirement('browser_click', {})
  assert.ok(first)
  engine._backend.callTool = async () => { throw new Error('partial fill failure') }
  await assert.rejects(engine.callTool('browser_fill_form', argsFor('browser_fill_form')))
  assert.ok(engine.formSubmitRequirement('browser_click', {}))
  const other = {}
  engine._backend._context.currentTab = () => ({ page: other })
  assert.equal(engine.formSubmitRequirement('browser_click', {}), null)
  engine._backend._context.currentTab = () => ({ page })
  await assert.rejects(engine.callTool('browser_navigate', argsFor('browser_navigate')), { code: 'form_submit_approval_required' })
  assert.ok(engine.formSubmitRequirement('browser_click', {}))
})

test('concurrent fill and activation serialize at the dispatch boundary', async () => {
  const { engine, calls } = dispatcher()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  engine._backend.callTool = async (name: string) => { calls.push(name); if (name === 'browser_type') await held; return { content: [] } }
  const fill = engine.callTool('browser_type', argsFor('browser_type'))
  const click = engine.callTool('browser_click', {})
  release()
  await fill
  await assert.rejects(click, { code: 'form_submit_approval_required' })
  assert.deepEqual(calls, ['browser_type'])
})

function gatedDispatcher() {
  const r = dispatcher(), cards: any[] = []
  const { engine, page } = r
  engine.pages = () => [page, {}]
  engine.shownAddress = (value: any) => value
  engine.ownsToolTarget = () => true
  engine.inspectPrivacy = async () => ({})
  engine.previousUrl = async () => 'https://fixture.example/prior'
  engine.describeAction = async () => ({ targets: [], actuated: { readable: true, name: 'Save draft', role: 'button' }, dialog: null })
  engine.actionTarget = async () => ({ page, read: await engine.describeAction() })
  engine.assertActionTarget = async (target: any) => { assert.equal(target.page, engine.selectedPage()) }
  engine.closeTarget = () => ({ page, document: page })
  const slot: any = { engine, paths: { key: 'fixture' }, purpose: 'Fixture', cardId: 'fixture' }
  const pool: any = { acquire: async () => slot, peek: () => slot, slotKey: () => 'fixture' }
  const gates: any = { pending: () => null, raise: async (card: any) => { cards.push(card); return { allowed: true, choice: 'allow_once', ran: Promise.resolve().then(card.action) } } }
  const core: any = new host.BrowserHostCore({ pool, browserTools: [...privacy.SAFE_TOOLS].map(name => ({ name })), deviceLabel: 'Fixture', gates, isOwnerPrincipal: () => true })
  core._settingsFor = () => ({ vision: true })
  core._grantsFor = () => ({ 'https://fixture.example': { write: 'allow' } })
  core._currentOrigin = async () => 'https://fixture.example'
  return { ...r, core, cards }
}

test('every classified action needs its own fresh approval even with a write grant', async t => {
  for (const [name, kind] of Object.entries((host as any).FORM_TOOL_CLASSES)) {
    if (kind !== 'action') continue
    await t.test(name, async () => {
      const { engine, core, cards, calls } = gatedDispatcher()
      await engine.callTool('browser_type', argsFor('browser_type'))
      calls.length = 0
      const result = await core.callTool({ assistantId: 42, principal: 'owner' }, name, argsFor(name))
      assert.notEqual(result.isError, true, JSON.stringify(result))
      assert.equal(cards.length, 1, name)
      assert.deepEqual(cards[0].choices, ['allow_once', 'deny'])
      assert.deepEqual(calls, [name])
      assert.equal(!!engine.formSubmitRequirement('browser_click', {}), ['browser_press_key', 'browser_select_option'].includes(name))
    })
  }
})

test('host refuses scripts, future tools and composite keys with the same filled-tab code', async () => {
  const { engine, core, cards } = gatedDispatcher()
  await engine.callTool('browser_type', argsFor('browser_type'))
  for (const [name, args] of [['browser_evaluate', { function: '() => document.forms[0].requestSubmit()' }], ['browser_future_tool', {}], ['browser_press_key', { key: 'Enter' }], ['browser_type', { target: 'e1', text: 'hello', submit: true }], ['browser_fill_form', { fields: [{ target: 'e2', type: 'checkbox', name: 'Include summary', value: 'true' }] }]] as const) {
    const result = await core.callTool({ assistantId: 42, principal: 'owner' }, name, args)
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), /form_submit_approval_required/)
  }
  assert.equal(cards.length, 0)
})

test('a fresh approval cannot authorize a different tool or changed arguments', async () => {
  const { engine, core, calls } = gatedDispatcher()
  await engine.callTool('browser_type', argsFor('browser_type'))
  calls.length = 0
  const dispatch = engine.callTool.bind(engine)
  engine.callTool = async (name: string, args: any, signal: any, target: any, approval: any) => {
    assert.ok(approval)
    await assert.rejects(dispatch('browser_press_key', { key: 'a' }, signal, undefined, approval), { code: 'form_submit_approval_required' })
    await assert.rejects(dispatch(name, { ...args, target: 'e4' }, signal, undefined, approval), { code: 'form_submit_approval_required' })
    return dispatch(name, args, signal, target, approval)
  }
  const result = await core.callTool({ assistantId: 42, principal: 'owner' }, 'browser_click', { target: 'e3' })
  assert.notEqual(result.isError, true, JSON.stringify(result))
  assert.deepEqual(calls, ['browser_click'])
})

test('the first direct fill cannot escape tracking through lazy tab initialization', async () => {
  const { engine, page, calls } = dispatcher()
  let initialized = false
  engine.pages = () => [page]
  engine._backend._context.currentTab = () => initialized ? { page } : null
  engine._backend._context.ensureBrowserContext = async () => { initialized = true }
  engine._backend.callTool = async (name: string) => { initialized = true; calls.push(name); return { content: [] } }
  await engine.callTool('browser_type', argsFor('browser_type'))
  await assert.rejects(engine.callTool('browser_click', {}), { code: 'form_submit_approval_required' })
  assert.deepEqual(calls, ['browser_type'])
})
