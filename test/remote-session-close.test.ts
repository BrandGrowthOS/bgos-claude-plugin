import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { BrowserPool, HostError } from '../bin/hoai-browser-host.mjs'
import { RemoteBrowserViews } from '../lib/remote-view.mjs'
import { runAgentBrowserWork } from '../lib/remote-input.mjs'
const tick = () => new Promise(resolve => setImmediate(resolve))

async function fixture({ supported = true, stopError = null as any } = {}) {
  const events: string[] = [], frames: any[] = []
  const cdp: any = Object.assign(new EventEmitter(), { send: async () => ({}), detach: async () => {} })
  let closed = false
  const page: any = Object.assign(new EventEmitter(), { isClosed: () => closed, viewportSize: () => ({ width: 800, height: 600 }), title: async () => 'Fixture', url: () => 'https://example.test/',
    context: () => ({ newCDPSession: async () => cdp }) })
  const engine: any = { alive: true, start: async () => {}, pages: () => [page], stop: async () => {
    events.push('stop'); closed = true; page.emit('close'); engine.alive = false
    if (stopError) throw stopError
    events.push('saved-and-stopped')
  } }
  const context = { assistantId: 901, principal: 'user-fixture' }
  const pool = new BrowserPool({ agentRoot: process.cwd(), createEngine: () => engine })
  const slot = await pool.acquire(context)
  const views = new RemoteBrowserViews({ pool })
  await views.open({ viewId: 'view', ...context, remoteBrowser: true, ...(supported ? { remoteSessionClose: true } : {}) }, {
    connectionId: 'socket', sendFrame: (message: any) => { frames.push(message.frame); if (message.frame.result?.closed) events.push('ack'); return true },
    sendClose: () => events.push('detach'),
  })
  const ready = frames[0].params
  let id = 0
  const command = (method: string, params: any = {}, patch: any = {}, connection = 'socket') => views.command({ viewId: 'view', frame: {
    id: ++id, method, params, sessionId: ready.sessionId, tabId: ready.tabId, ...patch,
  } }, connection)
  await command('hoai.input.acquire')
  const leaseId = frames.at(-1).result.leaseId
  return { events, frames, page, engine, views, pool, slot, context, command, leaseId, ready }
}

test('owner session close reserves exact slot, drains input, saves, then sends receipt before detach', async () => {
  const f = await fixture()
  assert.equal(f.ready.remoteSessionClose, true)
  const view = f.views.views.get('view')
  let releaseInput!: () => void
  const physical = f.views.input.physical(view, f.leaseId, () => new Promise<void>(resolve => { releaseInput = resolve }))
  const ending = f.command('hoai.browser.close', { leaseId: f.leaseId })
  await tick()
  assert.ok(f.slot.stopping)
  assert.equal(f.events.includes('stop'), false)
  assert.throws(() => runAgentBrowserWork(f.slot, () => assert.fail('must not start')), { code: 'browser_stopping' })
  releaseInput(); await physical
  assert.equal(await ending, true)
  assert.deepEqual(f.events, ['stop', 'saved-and-stopped', 'ack', 'detach'])
  assert.equal(f.pool.peek(f.context), null)
  assert.equal(f.views.views.has('view'), false)
})

test('owner close waits for held button and protected credential cleanup before taking the snapshot', async () => {
  const f = await fixture(), view = f.views.views.get('view')
  let releaseButton!: () => void, releaseCredential!: () => void
  view.ownerLease.heldButtons.set('left', { x: 10, y: 10 })
  view.cdp.send = async (method: string, params: any) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') await new Promise<void>(resolve => { releaseButton = resolve })
    return {}
  }
  const originalClose = f.views.credentials.close.bind(f.views.credentials)
  f.views.credentials.close = async (target: any) => {
    await new Promise<void>(resolve => { releaseCredential = resolve })
    return originalClose(target)
  }
  const ending = f.command('hoai.browser.close', { leaseId: f.leaseId })
  await tick(); assert.equal(f.events.includes('stop'), false)
  releaseButton(); await tick(); assert.equal(f.events.includes('stop'), false)
  f.views.credentials.close = originalClose
  releaseCredential(); assert.equal(await ending, true)
  assert.deepEqual(f.events, ['stop', 'saved-and-stopped', 'ack', 'detach'])
})

test('close requires capability, exact binding and valid lease; ordinary viewer close keeps engine', async () => {
  for (const supported of [true, false]) {
    const f = await fixture({ supported })
    if (!supported) assert.equal(f.ready.remoteSessionClose, undefined)
    assert.equal(await f.command('hoai.browser.close', { leaseId: f.leaseId }, { sessionId: 'other' }), false)
    assert.equal(await f.command('hoai.browser.close', { leaseId: f.leaseId }, {}, 'other'), false)
    if (!supported) assert.equal(await f.command('hoai.browser.close', { leaseId: f.leaseId }), false)
    assert.equal(await f.command('hoai.browser.close', { leaseId: 'wrong' }), false)
    assert.equal(f.events.includes('stop'), false)
    await f.views.close('view', 'socket')
    assert.equal(f.pool.peek(f.context)?.engine, f.engine)
    await f.pool.stopAll()
  }
})

test('storage failure is visible, never emits a successful close receipt or viewer detach', async () => {
  const f = await fixture({ stopError: Object.assign(new HostError('credential_storage', 'fixture failure'), { browserClosed: true }) })
  assert.equal(await f.command('hoai.browser.close', { leaseId: f.leaseId }), false)
  assert.equal(f.frames.at(-1).error.code, 'credential_storage')
  assert.equal(f.events.includes('ack'), false)
  assert.equal(f.events.includes('detach'), false)
  await f.views.stop()
})

test('reserved shutdown cannot stop a replacement engine or admit an already queued agent call', async () => {
  const f = await fixture()
  assert.equal(await f.pool.release(f.context, { expectedEngine: {} }), false)
  assert.equal(f.events.includes('stop'), false)
  f.views.input.release(f.views.views.get('view'))
  const queued = runAgentBrowserWork(f.slot, () => assert.fail('must not start'))
  const refused = assert.rejects(queued, { code: 'browser_stopping' })
  const stopping = f.pool.release(f.context, { expectedEngine: f.engine })
  await refused; await stopping
  await f.views.stop()
})

test('disconnect during admitted drain may end the pinned session but cannot emit a late success', async () => {
  const f = await fixture()
  let resume!: () => void
  const view = f.views.views.get('view')
  const physical = f.views.input.physical(view, f.leaseId, () => new Promise<void>(resolve => { resume = resolve }))
  const ending = f.command('hoai.browser.close', { leaseId: f.leaseId })
  await tick()
  const detached = f.views.close('view', 'socket')
  resume(); await physical; await detached
  assert.equal(await ending, false)
  assert.equal(f.events.includes('ack'), false)
  assert.equal(f.pool.peek(f.context), null)
})
