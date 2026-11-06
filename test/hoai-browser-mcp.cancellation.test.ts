/** Real stdio shim, synthetic HTTP peers. Ported transport cases from BGOS
 * agent-browser/__tests__/shim.cancellation.test.js. Native host command
 * ownership remains covered upstream; these cases exercise the shipped shim.
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from './helpers/scratch-dirs'

type Id = string | number
const SHIM = process.env.HOAI_SHIM_TEST_PATH || join(process.cwd(), 'bin', 'hoai-browser-mcp.mjs')
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate: () => boolean, message: string) {
  const end = Date.now() + 3000
  while (Date.now() < end) { if (predicate()) return; await wait(10) }
  assert.fail(message)
}

async function rig(t: TestContext, relay = false, refuseCancellation = false, holdCancellation = false) {
  const frames: { message: any; clientId?: string; auth?: string; session?: string }[] = []
  const held: { message: any; response: ServerResponse; disconnected: boolean }[] = []
  let releaseCancellation = () => {}
  const gate = holdCancellation ? new Promise<void>(resolve => { releaseCancellation = resolve }) : Promise.resolve()
  const server = createServer(async (req, res) => {
    const answer = (code: number, body: any) => {
      res.writeHead(code, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET') {
      if (req.url!.includes('/host')) return answer(200, { online: true, hostLabel: 'Fixture' })
      return answer(200, { status: 'pending', rpcId: 'fixture-rpc', pollAfterMs: 25 })
    }
    let text = ''
    for await (const part of req) text += part
    const body = JSON.parse(text), message = relay ? body.message : body
    frames.push({ message, clientId: body.clientId, auth: relay ? req.headers['x-bgos-pairing'] as string : req.headers.authorization, session: req.headers['mcp-session-id'] as string })
    if (message.method === 'notifications/cancelled') {
      if (refuseCancellation) return answer(429, { code: 'rate_limited' })
      await gate
    }
    if (message.method === 'tools/call' && message.params.name === 'browser_click') {
      const call = { message, response: res, disconnected: false }
      held.push(call)
      if (!relay) {
        res.on('close', () => { call.disconnected = true })
        return
      }
      return answer(201, { status: 'pending', rpcId: 'fixture-rpc', pollAfterMs: 25 })
    }
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : { content: [{ type: 'text', text: 'fresh observation' }] }
    const reply = { jsonrpc: '2.0', id: message.id, result }
    if (relay) answer(201, { status: 'done', rpcId: 'fixture-rpc', message: reply })
    else if (message.id === undefined) { res.writeHead(202); res.end() }
    else answer(200, reply)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const home = scratchDir('hoai-shim-cancellation-')
  const discovery = join(home, '.hoai', 'agent-browser.json')
  if (!relay) {
    mkdirSync(join(home, '.hoai'))
    writeFileSync(discovery, JSON.stringify({ url: origin + '/mcp', token: 'fixture-local-token' }))
  }
  // Clear inherited route/actor settings so only synthetic peers can be used.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HOAI_RELAY_')))
  Object.assign(env, { HOAI_HOME: home, HOAI_RELAY_PROBE_MS: '600000' }, relay ? {
    HOAI_RELAY_BACKEND_URL: origin, HOAI_RELAY_PAIRING_TOKEN: 'fixture-pairing', HOAI_RELAY_ASSISTANT_ID: '7',
  } : {})
  const child = spawn(process.execPath, [SHIM], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const responses: any[] = []
  let buffer = '', stderr = '', nextId = 1000
  child.stdout.on('data', data => {
    buffer += data
    const lines = buffer.split('\n'); buffer = lines.pop()!
    for (const line of lines.filter(Boolean)) { const msg = JSON.parse(line); if (msg.id !== undefined) responses.push(msg) }
  })
  child.stderr.on('data', data => { stderr += data })
  t.after(async () => {
    releaseCancellation()
    if (child.exitCode === null && child.signalCode === null) {
      const exit = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exit
    }
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const send = (message: any) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  const request = async (method: string, params = {}, id: Id = nextId++) => {
    send({ id, method, params })
    await until(() => responses.some(msg => msg.id === id), `No reply to ${method}: ${stderr}`)
    return responses.find(msg => msg.id === id)
  }
  const cancel = (requestId: Id) => send({ method: 'notifications/cancelled', params: { requestId, reason: 'private fixture reason' } })
  const click = (id: Id) => send({ id, method: 'tools/call', params: { name: 'browser_click', arguments: { element: 'Save', target: 'e1' } } })
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })
  send({ method: 'notifications/initialized' })
  return { frames, held, responses, request, cancel, click, releaseCancellation, discovery, stderr: () => stderr }
}

for (const relay of [false, true]) for (const id of [20, 0, '']) {
  test(`${relay ? 'relay' : 'local'}: cancel ${JSON.stringify(id)} bypasses the queue, suppresses late replies and never replays`, { timeout: 10000 }, async t => {
    const r = await rig(t, relay)
    r.click(id); await until(() => r.held.length === 1, 'Click was not dispatched')
    r.cancel(id); r.cancel(id)
    await until(() => r.frames.some(frame => frame.message.method === 'notifications/cancelled'), 'Cancellation was not delivered')
    await r.request('ping')
    if (!relay) {
      await until(() => r.held[0].disconnected, 'Original HTTP collection was not aborted')
      r.held[0].response.end(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'late success' }] } }))
    }
    await r.request('tools/call', { name: 'browser_snapshot', arguments: {} })
    const cancellations = r.frames.filter(frame => frame.message.method === 'notifications/cancelled')
    assert.equal(cancellations.length, 1)
    assert.equal(cancellations[0].message.params.requestId, id)
    assert.equal(cancellations[0].message.params.reason, 'Caller cancelled the request')
    assert.equal(r.held.length, 1)
    assert.equal(r.responses.some(msg => msg.id === id), false)
    assert.equal(r.stderr(), '')
    if (relay) {
      assert.equal(new Set(r.frames.map(frame => frame.clientId)).size, 1)
      assert.ok(r.frames.every(frame => frame.auth === 'fixture-pairing'))
    } else {
      assert.equal(cancellations[0].auth, 'Bearer fixture-local-token')
      assert.equal(cancellations[0].session, 'fixture-session')
    }
  })
}

test('queued cancellation prevents dispatch and keeps numeric and string IDs distinct', { timeout: 10000 }, async t => {
  const r = await rig(t)
  r.click(30); await until(() => r.held.length === 1, 'First click was not dispatched')
  r.click('31'); r.cancel(31); r.cancel('31'); r.cancel(30)
  await r.request('ping')
  assert.equal(r.held.length, 1)
  assert.equal(r.responses.some(msg => msg.id === '31'), false)
  assert.deepEqual(r.frames.filter(frame => frame.message.method === 'notifications/cancelled').map(frame => frame.message.params.requestId), [30])
})

test('wrong-type, unknown, completed and duplicate cancellations send nothing', { timeout: 10000 }, async t => {
  const r = await rig(t, true)
  r.click('50'); await until(() => r.held.length === 1, 'Click was not dispatched')
  r.cancel(50); r.cancel('unknown'); r.cancel(1000)
  await wait(70)
  assert.equal(r.frames.some(frame => frame.message.method === 'notifications/cancelled'), false)
  r.cancel('50'); await r.request('ping')
  await until(() => r.frames.some(frame => frame.message.method === 'notifications/cancelled'), 'String ID was not cancelled')
  r.cancel('50'); await r.request('ping')
  assert.equal(r.frames.filter(frame => frame.message.method === 'notifications/cancelled').length, 1)
})

test('local cancellation retains its original destination after discovery changes', { timeout: 10000 }, async t => {
  const r = await rig(t)
  r.click('held'); await until(() => r.held.length === 1, 'Click was not dispatched')
  writeFileSync(r.discovery, JSON.stringify({ url: 'http://127.0.0.1:1/mcp', token: 'different-fixture-token' }))
  r.cancel('held'); await r.request('ping')
  await until(() => r.frames.some(frame => frame.message.method === 'notifications/cancelled'), 'Original destination did not receive cancellation')
  assert.equal(r.stderr(), '')
})

test('refused cancellation warns without leaking secrets or replaying the mutation', { timeout: 10000 }, async t => {
  const r = await rig(t, true, true)
  r.click(40); await until(() => r.held.length === 1, 'Click was not dispatched')
  r.cancel(40)
  await until(() => r.stderr().includes('not confirmed'), 'Missing cancellation warning')
  await r.request('ping')
  assert.equal(r.held.length, 1)
  assert.equal(r.frames.filter(frame => frame.message.method === 'notifications/cancelled').length, 1)
  assert.doesNotMatch(r.stderr(), /fixture-local-token|fixture-pairing|private fixture reason/)
  assert.equal(r.responses.some(msg => msg.id === 40), false)
})

test('ID reuse is refused while cancellation delivery is still in flight', { timeout: 10000 }, async t => {
  const r = await rig(t, true, false, true)
  r.click(90); await until(() => r.held.length === 1, 'Click was not dispatched')
  r.cancel(90)
  await until(() => r.frames.some(frame => frame.message.method === 'notifications/cancelled'), 'Cancellation did not leave shim')
  r.click(90)
  await until(() => r.responses.some(msg => msg.id === 90), 'ID reuse was not refused')
  assert.equal(r.responses.find(msg => msg.id === 90).error.code, -32600)
  assert.equal(r.held.length, 1)
  r.releaseCancellation()
})
