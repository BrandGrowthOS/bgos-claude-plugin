import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RemoteOwnerInput, runAgentBrowserWork } from '../lib/remote-input.mjs'
import { BrowserHostCore, BrowserPool } from '../bin/hoai-browser-host.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  let policy = { allowed: true, credential: false, editable: true }
  let now = 1000
  const sent: any[] = [], revoked: any[] = []
  const slot: any = { engine: {} }
  const view: any = { engine: slot.engine, page: {
    evaluateHandle: async () => ({ evaluate: async () => ({ ...policy }), dispose: async () => {} }),
    evaluate: async () => ({ ...policy }),
  }, cdp: { send: async (method: string, params: any) => { sent.push({ method, params }); return {} } } }
  const input = new RemoteOwnerInput({ current: () => slot, revoked: (v: any) => revoked.push(v), now: () => now })
  return { input, slot, view, sent, revoked, policy: (value: any) => { policy = value }, advance: (ms: number) => { now += ms } }
}

test('B reserves owner control before awaiting physical agent work and gates late held actions', async () => {
  const f = fixture()
  let finish!: () => void
  const physical = runAgentBrowserWork(f.slot, () => new Promise<void>(resolve => { finish = resolve }))
  await tick()
  const acquiring = f.input.acquire(f.view)
  assert.throws(() => runAgentBrowserWork(f.slot, () => {}), /owner currently controls/)
  let granted = false
  void acquiring.then(() => { granted = true })
  await tick()
  assert.equal(granted, false)
  finish(); await physical
  const lease = await acquiring
  assert.ok(lease.leaseId)
  assert.throws(() => runAgentBrowserWork(f.slot, () => {}), /owner currently controls/)
  f.input.release(f.view, lease.leaseId)
  assert.equal(await runAgentBrowserWork(f.slot, () => 'agent resumes'), 'agent resumes')
})

test('B dispatches a safe key once and refuses token replay, stale focus, and credential changes', async () => {
  const f = fixture()
  const { leaseId } = await f.input.acquire(f.view)
  const focus = await f.input.focus(f.view, { leaseId })
  assert.equal(focus.allowed, true)
  await f.input.key(f.view, { leaseId, focusToken: focus.focusToken, key: 'K' })
  assert.deepEqual(f.sent, [{ method: 'Input.insertText', params: { text: 'K' } }])
  await assert.rejects(f.input.key(f.view, { leaseId, focusToken: focus.focusToken, key: 'K' }), /focused field again/)
  const beforeChange = await f.input.focus(f.view, { leaseId })
  f.policy({ allowed: false, credential: true, editable: true })
  await assert.rejects(f.input.key(f.view, { leaseId, focusToken: beforeChange.focusToken, key: 'secret' }), /Unsupported remote key/)
  const blocked = await f.input.focus(f.view, { leaseId })
  assert.deepEqual(blocked, { allowed: false, focusToken: null, credential: true, editable: true })
  f.policy({ allowed: true, credential: false, editable: true })
  const accepted = await f.input.focus(f.view, { leaseId })
  f.policy({ allowed: false, credential: true, editable: true })
  await assert.rejects(f.input.key(f.view, { leaseId, focusToken: accepted.focusToken, key: 'P' }), /cannot receive remote text/)
  assert.equal(f.sent.length, 1)
  f.input.release(f.view)
})

test('B pointer input uses remote coordinates and invalidates the preceding focus token', async () => {
  const f = fixture()
  const { leaseId } = await f.input.acquire(f.view)
  const focus = await f.input.focus(f.view, { leaseId })
  await f.input.pointer(f.view, { leaseId, type: 'down', x: 12, y: 24, button: 'left' })
  assert.deepEqual(f.sent[0], { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 12, y: 24, button: 'left', clickCount: 1, buttons: 1 } })
  await assert.rejects(f.input.key(f.view, { leaseId, focusToken: focus.focusToken, key: 'K' }), /focused field again/)
  f.policy({ allowed: false, credential: true, editable: true })
  await assert.rejects(f.input.pointer(f.view, { leaseId, type: 'down', x: 12, y: 24 }), /credential fields is disabled/)
  assert.equal(f.sent.length, 1)
  f.input.release(f.view)
})

test('B expired focus and lease fail closed and emit revocation', async () => {
  const f = fixture()
  const { leaseId } = await f.input.acquire(f.view)
  const focus = await f.input.focus(f.view, { leaseId })
  f.advance(2100)
  await assert.rejects(f.input.key(f.view, { leaseId, focusToken: focus.focusToken, key: 'K' }), /focused field again/)
  f.advance(30000)
  await assert.rejects(f.input.focus(f.view, { leaseId }), /Take control again/)
  assert.equal(f.sent.length, 0)
  assert.equal(f.revoked.length, 1)
  assert.equal(f.slot.ownerInputLease, null)
})

test('B released owner input retains the agent block until its physical command and keyup settle', async () => {
  const f = fixture()
  const { leaseId } = await f.input.acquire(f.view)
  const focus = await f.input.focus(f.view, { leaseId })
  let finish!: () => void
  f.view.cdp.send = async (method: string, params: any) => {
    f.sent.push({ method, params })
    if (params.type === 'keyDown') await new Promise<void>(resolve => { finish = resolve })
    return {}
  }
  const key = f.input.key(f.view, { leaseId, focusToken: focus.focusToken, key: 'Backspace' })
  await tick()
  f.input.release(f.view)
  assert.throws(() => runAgentBrowserWork(f.slot, () => {}), /owner currently controls/)
  finish()
  await assert.rejects(key, /Take control again/)
  assert.equal(f.sent.at(-1).params.type, 'keyUp')
  assert.equal(await runAgentBrowserWork(f.slot, () => 'safe'), 'safe')
})

test('B hide during a pending pointer down releases the remote button before the agent resumes', async () => {
  const f = fixture()
  const { leaseId } = await f.input.acquire(f.view)
  let finishDown!: () => void, finishUp!: () => void
  f.view.cdp.send = async (method: string, params: any) => {
    f.sent.push({ method, params })
    await new Promise<void>(resolve => {
      if (params.type === 'mousePressed') finishDown = resolve
      else if (params.type === 'mouseReleased') finishUp = resolve
    })
    return {}
  }
  const down = f.input.pointer(f.view, { leaseId, type: 'down', x: 18, y: 32, button: 'left' })
  await tick()
  f.input.release(f.view)
  assert.deepEqual(f.sent.at(-1).params, { type: 'mouseReleased', button: 'left', clickCount: 1, x: 18, y: 32 })
  assert.throws(() => runAgentBrowserWork(f.slot, () => {}), /owner currently controls/)
  finishDown()
  await assert.rejects(down, /Take control again/)
  assert.throws(() => runAgentBrowserWork(f.slot, () => {}), /owner currently controls/)
  finishUp(); await tick()
  assert.equal(await runAgentBrowserWork(f.slot, () => 'agent resumes'), 'agent resumes')
})

test('B host status exposes owner control and refuses agent tools or close before permission work', async () => {
  const f = fixture()
  f.slot.engine.pages = () => []
  const pool: any = { peek: () => f.slot, acquire: async () => f.slot,
    slotKey: () => 'fixture', release: () => { throw new Error('Must not close an owner-controlled browser') } }
  const core = new BrowserHostCore({ pool, browserTools: [{ name: 'browser_navigate' }], deviceLabel: 'fixture' })
  await f.input.acquire(f.view)
  const text = (result: any) => result.content.map((item: any) => item.text || '').join('')
  assert.match(text(await core.callTool({}, 'hoai_browser_status', {})), /human_control/)
  assert.match(text(await core.callTool({}, 'browser_navigate', { url: 'https://example.com' })), /owner_control/)
  assert.match(text(await core.callTool({}, 'hoai_browser_close_session', {})), /owner_control/)
  f.input.release(f.view)
  assert.match(text(await core.callTool({}, 'hoai_browser_status', {})), /agent_driving/)
})

test('B retains the physical CDP session for keyup after close begins and fails closed on cleanup failure', async () => {
  const f = fixture()
  const { leaseId } = await f.input.acquire(f.view)
  const focus = await f.input.focus(f.view, { leaseId })
  let finish!: () => void
  f.view.cdp.send = async (method: string, params: any) => {
    f.sent.push({ method, params })
    if (params.type === 'keyDown') await new Promise<void>(resolve => { finish = resolve })
    if (params.type === 'keyUp') throw new Error('physical keyup failed')
  }
  const pending = f.input.key(f.view, { leaseId, focusToken: focus.focusToken, key: 'Backspace' })
  await tick()
  f.input.release(f.view)
  f.view.cdp = null
  finish()
  await assert.rejects(pending, /physical keyup failed/)
  await f.input.drain(f.view)
  assert.equal(f.sent.at(-1).params.type, 'keyUp')
  assert.throws(() => runAgentBrowserWork(f.slot, () => {}), /owner currently controls/)
})

test('B pointer move preserves pressed-button masks for drag handlers', async () => {
  const f = fixture()
  const { leaseId } = await f.input.acquire(f.view)
  await f.input.pointer(f.view, { leaseId, type: 'down', x: 12, y: 24, button: 'left' })
  await f.input.pointer(f.view, { leaseId, type: 'move', x: 22, y: 34 })
  assert.equal(f.sent.at(-1).params.buttons, 1)
  await f.input.pointer(f.view, { leaseId, type: 'up', x: 22, y: 34, button: 'left' })
  assert.equal(f.sent.at(-1).params.buttons, 0)
  f.input.release(f.view)
})

test('B cleanup failure blocks its affected engine but not a browser started after successful shutdown', async () => {
  const pool = new BrowserPool({ agentRoot: process.cwd(), createEngine: () => ({
    alive: true, start: async () => {}, stop: async () => {}, pages: () => [],
  }) })
  const context = { assistantId: 901, principal: 'user-fixture' }
  const slot: any = await pool.acquire(context)
  const oldEngine = slot.engine
  slot.ownerInputLease = { view: { engine: oldEngine }, released: true, cleanupFailed: true }
  assert.throws(() => runAgentBrowserWork(slot, () => {}), /owner currently controls/)
  await pool.release(context)
  const next = await pool.acquire(context)
  assert.notEqual(next.engine, oldEngine)
  assert.equal(await runAgentBrowserWork(next, () => 'recovered'), 'recovered')
  await pool.stopAll()
})
