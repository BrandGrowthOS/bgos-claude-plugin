import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { RemoteBrowserViews, REMOTE_VIEW_FRAME_MAX_BYTES } from '../lib/remote-view.mjs'
import { PairingConnection } from '../bin/hoai-browser-host.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture() {
  const calls: Array<{ method: string; params?: any }> = []
  const cdp: any = new EventEmitter()
  cdp.send = async (method: string, params?: any) => {
    calls.push({ method, params })
    return method === 'Page.getLayoutMetrics' ? { cssVisualViewport: { clientWidth: 1200, clientHeight: 800 } } : {}
  }
  cdp.detach = async () => { calls.push({ method: 'detach' }) }
  const page: any = new EventEmitter()
  page.isClosed = () => false
  page.context = () => ({ newCDPSession: async () => cdp })
  page.title = async () => 'Agent machine'
  page.url = () => 'http://127.0.0.1/remote-only'
  const engine = { pages: () => [page] }
  const context = { assistantId: 901, principal: 'user-fixture' }
  let current: any = { engine }
  const pool: any = {
    peek: (ctx: any) => ctx.assistantId === context.assistantId && ctx.principal === context.principal ? current : null,
    slotKey: (ctx: any) => JSON.stringify(ctx),
    acquire: () => { throw new Error('A view must never launch a browser') },
  }
  const frames: any[] = [], closes: any[] = []
  const views = new RemoteBrowserViews({ pool })
  const open = (viewId = 'view-one', connectionId = 'host-socket', remoteBrowser = false) => views.open({ viewId, ...context, ...(remoteBrowser ? { remoteBrowser } : {}) }, {
    connectionId, sendFrame: (message: any) => { frames.push(message); return true }, sendClose: (message: any) => closes.push(message),
  })
  const command = (method: string, params: any = {}, extra: any = {}, connectionId = 'host-socket') => {
    const ready = frames.find(message => message.frame.method === 'hoai.ready').frame.params
    return views.command({ viewId: 'view-one', frame: { id: 1, method, params,
      sessionId: ready.sessionId, tabId: ready.tabId, ...extra } }, connectionId)
  }
  return { views, open, command, frames, closes, calls, cdp, page, engine, context, replace: (value: any) => { current = value } }
}

test('remote view A attaches the existing principal browser and streams changing frames after paint acknowledgements', async () => {
  const f = fixture()
  assert.equal(await f.open(), true)
  const ready = f.frames[0].frame.params
  assert.equal(ready.title, 'Agent machine')
  assert.equal(ready.width, 1200)
  assert.equal(await f.command('Page.startScreencast', { format: 'png', maxWidth: 100000 }), true)
  assert.deepEqual(f.calls.find(call => call.method === 'Page.startScreencast')?.params,
    { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 })
  f.cdp.emit('Page.screencastFrame', { sessionId: 10, data: 'Zmlyc3Q=', metadata: { timestamp: 1 } })
  f.cdp.emit('Page.screencastFrame', { sessionId: 11, data: 'ZHJvcHBlZA==', metadata: { timestamp: 2 } })
  let streamed = f.frames.filter(message => message.frame.method === 'Page.screencastFrame')
  assert.equal(streamed.length, 1)
  assert.equal(await f.command('Page.screencastFrameAck', { sessionId: 999 }, { id: undefined }), false)
  assert.equal(await f.command('Page.screencastFrameAck', { sessionId: 10 }, { id: undefined }), true)
  assert.equal(f.frames.filter(message => message.frame.method === 'Page.screencastFrame').length, 2)
  assert.equal(await f.command('Page.screencastFrameAck', { sessionId: 11 }, { id: undefined }), true)
  f.cdp.emit('Page.screencastFrame', { sessionId: 12, data: 'c2Vjb25k', metadata: { timestamp: 3 } })
  streamed = f.frames.filter(message => message.frame.method === 'Page.screencastFrame')
  assert.equal(streamed.length, 3)
  assert.notEqual(streamed[0].frame.params.data, streamed[1].frame.params.data)
  assert.equal(streamed[1].frame.sessionId, ready.sessionId)
  await f.views.stop()
})

test('negotiated capture intent survives active target close while an old start promise is pending', async () => {
  const f = fixture()
  const nextCdp: any = new EventEmitter()
  const nextCalls: string[] = []
  nextCdp.send = async (method: string) => { nextCalls.push(method); return method === 'Page.getLayoutMetrics' ? { cssVisualViewport: { clientWidth: 1200, clientHeight: 800 } } : {} }
  nextCdp.detach = async () => {}
  const nextPage: any = new EventEmitter()
  nextPage.isClosed = () => false; nextPage.context = () => ({ newCDPSession: async () => nextCdp })
  nextPage.url = () => 'http://127.0.0.1/next'; nextPage.title = async () => 'Next page'
  f.engine.pages = () => [f.page, nextPage]
  ;(f.engine as any).selectedPage = () => f.page
  await f.open('view-one', 'host-socket', true)
  const oldTab = f.views.views.get('view-one').tabId
  const original = f.cdp.send
  let rejectStart!: (error: Error) => void
  f.cdp.send = (method: string, params: any) => method === 'Page.startScreencast'
    ? new Promise((_resolve, reject) => { rejectStart = reject }) : original(method, params)
  const starting = f.command('Page.startScreencast')
  await tick()
  f.views.views.get('view-one').loading = true
  f.page.isClosed = () => true
  f.page.emit('close')
  const deadline = Date.now() + 1000
  while (f.views.views.get('view-one').tabId === oldTab || !nextCalls.includes('Page.startScreencast')) {
    if (Date.now() > deadline) throw new Error('Capture did not restart on the replacement target')
    await tick()
  }
  rejectStart(new Error('Old target detached'))
  assert.equal(await starting, true)
  assert.equal(f.views.views.size, 1)
  assert.equal(f.views.views.get('view-one').capturing, true)
  assert.equal(f.views.views.get('view-one').loading, false)
  assert.ok(nextCalls.includes('Page.startScreencast'))
  await f.views.stop()
})

test('negotiated input revocation names expiry and navigation while legacy viewers receive empty params', async () => {
  for (const negotiated of [true, false]) {
    const f = fixture()
    const main = {}
    f.page.mainFrame = () => main
    await f.open('view-one', 'host-socket', negotiated)
    const view = f.views.views.get('view-one')
    f.views.input.leaseMs = 15
    await f.views.input.acquire(view)
    await new Promise(resolve => setTimeout(resolve, 25))
    const expiry = f.frames.filter(packet => packet.frame.method === 'hoai.input.revoked').at(-1).frame.params
    assert.deepEqual(expiry, negotiated ? { reason: 'expired' } : {})
    f.views.input.leaseMs = 30000
    await f.views.input.acquire(view)
    f.page.emit('framenavigated', main)
    const navigation = f.frames.filter(packet => packet.frame.method === 'hoai.input.revoked').at(-1).frame.params
    assert.deepEqual(navigation, negotiated ? { reason: 'navigation' } : {})
    await f.views.stop()
  }
})

test('remote view A preserves the last static page change while owner paint is pending', async () => {
  const f = fixture()
  await f.open()
  f.cdp.emit('Page.screencastFrame', { sessionId: 1, data: 'cmVk', metadata: {} })
  f.cdp.emit('Page.screencastFrame', { sessionId: 2, data: 'Z3JlZW4=', metadata: {} })
  f.cdp.emit('Page.screencastFrame', { sessionId: 3, data: 'Ymx1ZQ==', metadata: {} })
  assert.equal(f.frames.filter(message => message.frame.method === 'Page.screencastFrame').length, 1)
  assert.ok(f.calls.some(call => call.method === 'Page.screencastFrameAck' && call.params.sessionId === 2))
  await f.command('Page.screencastFrameAck', { sessionId: 1 }, { id: undefined })
  const streamed = f.frames.filter(message => message.frame.method === 'Page.screencastFrame')
  assert.equal(streamed.length, 2)
  assert.equal(streamed[1].frame.params.data, 'Ymx1ZQ==')
  await f.views.stop()
})

test('remote view A refuses other principals, raw input, stale identities, and oversized frames', async () => {
  const f = fixture()
  assert.equal(await f.views.open({ viewId: 'other', assistantId: 901, principal: 'user-other' }, {
    connectionId: 'host-socket', sendFrame: () => {}, sendClose: () => {},
  }), false)
  await f.open()
  assert.equal(await f.command('Input.insertText', { text: 'never delivered' }), false)
  assert.equal(f.frames.at(-1).frame.error.code, 'view_read_only')
  assert.equal(await f.command('Page.startScreencast', {}, { tabId: 'stale-tab' }), false)
  assert.equal(await f.command('Page.startScreencast', {}, {}, 'other-socket'), false)
  const before = f.frames.length
  f.cdp.emit('Page.screencastFrame', { sessionId: 1, data: 'x'.repeat(REMOTE_VIEW_FRAME_MAX_BYTES), metadata: {} })
  assert.equal(f.frames.length, before)
  assert.ok(f.calls.some(call => call.method === 'Page.screencastFrameAck' && call.params.sessionId === 1))
  f.replace({ engine: { pages: () => [f.page] } })
  assert.equal(await f.command('Page.startScreencast'), false)
  assert.equal(f.calls.some(call => call.method.startsWith('Input.')), false)
  await f.views.stop()
})

test('remote view A serializes commands while a paint acknowledgement bypasses a blocked command', async () => {
  const f = fixture()
  await f.open()
  const original = f.cdp.send
  let finish!: () => void
  f.cdp.send = (method: string, params: any) => {
    if (method === 'Page.startScreencast') {
      f.calls.push({ method, params })
      return new Promise(resolve => { finish = () => resolve({}) })
    }
    return original(method, params)
  }
  const first = f.command('Page.startScreencast')
  const second = f.command('Page.stopScreencast', {}, { id: 2 })
  await tick()
  assert.equal(f.calls.some(call => call.method === 'Page.stopScreencast'), false)
  f.cdp.emit('Page.screencastFrame', { sessionId: 7, data: 'cGl4ZWxz', metadata: {} })
  assert.equal(await f.command('Page.screencastFrameAck', { sessionId: 7 }, { id: undefined }), true)
  finish()
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  await f.views.stop()
})

test('remote view A retains target identity across viewers and revokes on page close or socket loss', async () => {
  const f = fixture()
  await f.open()
  const firstReady = f.frames[0].frame.params
  await f.open('view-two', 'next-socket')
  const nextReady = f.frames.at(-1).frame.params
  assert.equal(nextReady.sessionId, firstReady.sessionId)
  assert.equal(nextReady.tabId, firstReady.tabId)
  assert.equal(f.closes[0].reason, 'viewer_replaced')
  assert.equal(await f.command('Page.startScreencast'), false)
  await f.views.closeConnection('host-socket')
  assert.equal(f.views.views.size, 1)
  f.page.emit('close')
  await tick()
  assert.equal(f.views.views.size, 0)
  assert.ok(f.closes.some(close => close.reason === 'remote_target_gone'))
  assert.equal(f.engine.pages()[0], f.page)
})

test('remote view A revokes an attachment that finishes after socket disconnect', async () => {
  const f = fixture()
  let attach!: () => void
  f.page.context = () => ({ newCDPSession: () => new Promise(resolve => { attach = () => resolve(f.cdp) }) })
  const opening = f.open()
  await f.views.closeConnection('host-socket')
  attach()
  assert.equal(await opening, false)
  assert.equal(f.frames.length, 0)
  assert.ok(f.calls.some(call => call.method === 'detach'))
})

test('remote view A can restart after a stopped stream has an unacknowledged frame', async () => {
  const f = fixture()
  await f.open()
  await f.command('Page.startScreencast')
  f.cdp.emit('Page.screencastFrame', { sessionId: 1, data: 'Zmlyc3Q=', metadata: {} })
  await f.command('Page.stopScreencast')
  await f.command('Page.startScreencast')
  f.cdp.emit('Page.screencastFrame', { sessionId: 2, data: 'c2Vjb25k', metadata: {} })
  assert.equal(f.frames.filter(message => message.frame.method === 'Page.screencastFrame').length, 2)
  await f.views.stop()
})

test('PairingConnection binds remote views to the admitting socket and this pairing agents only', async () => {
  const socket: any = new EventEmitter()
  socket.id = 'socket-original'; socket.connected = true
  socket.disconnect = () => socket.emit('disconnect', 'io client disconnect')
  const calls: any[] = []
  const remoteViews: any = {
    open: async (input: any, hooks: any) => { calls.push({ kind: 'open', input, hooks }); return true },
    command: async (input: any, id: string) => { calls.push({ kind: 'command', input, id }) },
    close: async () => {}, closeConnection: async (id: string) => { calls.push({ kind: 'disconnect', id }) },
  }
  const conn = new PairingConnection({ pairing: { assistantIds: [901], backendUrl: 'http://127.0.0.1', token: 'synthetic' },
    deviceLabel: 'fixture', relay: {} as any, remoteViews, io: (() => socket) as any })
  conn.start(); socket.emit('connect')
  socket.emit('browser_view_open', { viewId: 'wrong', assistantId: 902, principal: 'user-fixture' })
  assert.equal(calls.length, 0)
  socket.emit('browser_view_open', { viewId: 'right', assistantId: 901, principal: 'user-fixture' })
  assert.equal(calls[0].hooks.connectionId, 'socket-original')
  socket.emit('disconnect', 'transport close')
  assert.equal(calls[0].hooks.sendFrame({ viewId: 'right', frame: {} }), false)
  assert.equal(calls.at(-1).id, 'socket-original')
  conn.stop()
})
