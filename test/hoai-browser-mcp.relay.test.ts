/**
 * The vendored hoai-browser shim's relay door.
 *
 * This is the BGOS suite's shim.relay.test.js
 * (frontend/electron-app/agent-browser/__tests__/) ported to this repo's
 * conventions: TypeScript, node:test, the shim resolved from
 * process.cwd()/bin. The file it drives is a byte-identical copy of the BGOS
 * source of truth, so this test is what tells us the copy still behaves; the
 * local and offline doors stay in test/hoai-browser-mcp.test.ts.
 *
 * Everything runs against fake HTTP servers on loopback: no Electron, no
 * network, no HOAI account. Paths are built with node:path and the shim is run
 * with process.execPath, so the Windows runner is as happy as CI.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHIM = join(process.cwd(), 'bin', 'hoai-browser-mcp.mjs')
const PAIRING = 'pair-token-abcdefghijklmnopqrstuvwxyz'

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)))
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : null)
      } catch {
        resolve(null)
      }
    })
  })
}

interface RelayState {
  online: boolean
  hostLabel: string
  pendingOnce: boolean
  hostOfflineNext: boolean
  seen: any[]
  polled: number
  held: Map<string, any>
  /** The HTTP code the relay POST answers with; see the default below. */
  postStatus: number
  /** The HTTP code a held (pending) relay POST answers with. */
  pendingStatus: number
}

/** A fake BGOS backend that speaks the relay contract of the plan (section 3.2). */
async function fakeRelay(overrides: Partial<RelayState> = {}) {
  const state: RelayState = {
    online: true,
    hostLabel: "Kc's MacBook Pro",
    pendingOnce: false,
    hostOfflineNext: false,
    seen: [],
    polled: 0,
    held: new Map(),
    // postStatus mirrors the REAL backend: the relay route is @Post('mcp')
    // with no @HttpCode, so NestJS answers 201, not the 200 / 202 the plan
    // writes for the SHAPES. A test can ask for the documented codes instead,
    // and the shim must read both.
    postStatus: 201,
    pendingStatus: 201,
    ...overrides,
  }
  let rpcSeq = 0
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (status: number, obj: any) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(obj))
    }
    const auth = { pairing: req.headers['x-bgos-pairing'] ?? null, apiKey: req.headers['x-api-key'] ?? null }
    if (req.method === 'GET' && url.pathname === '/api/v1/integrations/browser/host') {
      state.seen.push({ route: 'host', auth })
      return json(200, {
        online: state.online,
        hostLabel: state.online ? state.hostLabel : null,
        since: state.online ? '2026-09-12T05:00:00Z' : null,
      })
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/v1/integrations/browser/mcp/')) {
      const rpcId = url.pathname.split('/').pop() as string
      state.polled += 1
      const held = state.held.get(rpcId)
      if (!held) return json(404, { code: 'call_lost', message: 'no such call' })
      state.held.delete(rpcId)
      return json(200, { status: 'done', rpcId, message: held })
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/integrations/browser/mcp') {
      const body = await readJson(req)
      const msg = body?.message ?? {}
      state.seen.push({
        route: 'mcp',
        auth,
        clientId: body?.clientId,
        assistantId: body?.assistantId ?? null,
        waitMs: body?.waitMs,
        method: msg.method,
        id: msg.id,
      })
      if (state.hostOfflineNext || !state.online) {
        state.hostOfflineNext = false
        return json(409, { code: 'host_offline', message: 'no desktop app online for this account' })
      }
      const rpcId = `r${++rpcSeq}`
      if (msg.id === undefined) return json(state.postStatus, { status: 'done', rpcId, message: {} })
      let result: any
      if (msg.method === 'initialize') {
        result = {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'hoai-agent-browser', version: '5.1.1' },
          instructions: 'Relay: this is your DEFAULT browser.',
        }
      } else if (msg.method === 'tools/list') {
        result = {
          tools: [
            { name: 'hoai_browser_open_session', inputSchema: { type: 'object' } },
            { name: 'browser_navigate', inputSchema: { type: 'object' } },
          ],
        }
      } else if (msg.method === 'tools/call') {
        result = { content: [{ type: 'text', text: `called ${msg.params?.name}` }], isError: false }
      } else {
        return json(state.postStatus, { status: 'done', rpcId, message: { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } } })
      }
      const message = { jsonrpc: '2.0', id: msg.id, result }
      if (msg.method === 'tools/call' && state.pendingOnce) {
        state.pendingOnce = false
        state.held.set(rpcId, message)
        return json(state.pendingStatus, { status: 'pending', rpcId, pollAfterMs: 20 })
      }
      return json(state.postStatus, { status: 'done', rpcId, message })
    }
    json(404, { message: 'unknown route' })
  })
  const port = await listen(server)
  return { url: `http://127.0.0.1:${port}`, state, close: () => new Promise<void>((r) => server.close(() => r())) }
}

/** A fake local endpoint (the app's loopback MCP door), enough for the handshake. */
async function fakeLocal() {
  const seen: any[] = []
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const msg = await readJson(req)
    seen.push({ auth: req.headers.authorization, method: msg?.method })
    res.setHeader('content-type', 'application/json')
    res.setHeader('mcp-session-id', 'local-sess-1')
    if (msg?.method === 'initialize') {
      return res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'hoai-agent-browser', version: '5.1.1' },
            instructions: 'Local: this is your DEFAULT browser.',
          },
        }),
      )
    }
    if (msg?.id === undefined) {
      res.statusCode = 202
      return res.end()
    }
    if (msg.method === 'tools/list') {
      return res.end(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'hoai_browser_open_session', inputSchema: { type: 'object' } }] } }),
      )
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `local called ${msg.params?.name}` }] } }))
  })
  const port = await listen(server)
  return { url: `http://127.0.0.1:${port}/mcp`, seen, close: () => new Promise<void>((r) => server.close(() => r())) }
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'hoai-shim-relay-'))
}

function client(env: Record<string, string>) {
  const child = spawn(process.execPath, [SHIM], {
    // Blank every relay variable first: a developer whose own shell carries
    // real HOAI_RELAY_* values must not silently change what these tests mean.
    env: {
      ...process.env,
      HOAI_RELAY_BACKEND_URL: '',
      HOAI_RELAY_PAIRING_TOKEN: '',
      HOAI_RELAY_API_KEY: '',
      HOAI_RELAY_ASSISTANT_ID: '',
      HOAI_RELAY_PROBE_MS: '60',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buf = ''
  let stderr = ''
  const pending = new Map<string | number, (msg: any) => void>()
  const notifications: any[] = []
  child.stderr.on('data', (d) => (stderr += d.toString()))
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg)
        pending.delete(msg.id)
      } else notifications.push(msg)
    }
  })
  let id = 0
  const request = (method: string, params: any = {}) =>
    new Promise<any>((resolve, reject) => {
      const msgId = ++id
      pending.set(msgId, resolve)
      const t = setTimeout(() => reject(new Error(`no reply to ${method} within 10 s; stderr: ${stderr}`)), 10_000)
      t.unref()
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msgId, method, params }) + '\n')
    })
  const notify = (method: string, params: any = {}) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  const waitFor = (method: string, timeoutMs = 3000) =>
    new Promise<any>((resolve, reject) => {
      const startedAt = Date.now()
      const tick = () => {
        const n = notifications.find((m) => m.method === method)
        if (n) return resolve(n)
        if (Date.now() - startedAt > timeoutMs) return reject(new Error(`no ${method} within ${timeoutMs} ms; stderr: ${stderr}`))
        setTimeout(tick, 15)
      }
      tick()
    })
  const init = async (name = 'claude-code') => {
    const r = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: 'test' } })
    notify('notifications/initialized')
    return r
  }
  return { request, notify, notifications, waitFor, init, close: () => child.kill(), stderr: () => stderr }
}

test('relay: initialize, list and call travel through the backend with the pairing header and one client id; a pending answer is polled', async () => {
  const relay = await fakeRelay({ pendingOnce: true })
  const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: relay.url + '/', HOAI_RELAY_PAIRING_TOKEN: PAIRING })
  try {
    const init = await c.init('codex')
    assert.match(init.result.instructions, /Relay: this is your DEFAULT browser/)
    const list = await c.request('tools/list')
    assert.deepEqual(
      list.result.tools.map((t: any) => t.name),
      ['hoai_browser_open_session', 'browser_navigate'],
    )
    const call = await c.request('tools/call', { name: 'browser_navigate', arguments: { url: 'http://127.0.0.1/' } })
    assert.equal(call.result.content[0].text, 'called browser_navigate')
    assert.equal(relay.state.polled, 1, 'the 202 pending answer was collected once')
    const mcp = relay.state.seen.filter((s) => s.route === 'mcp')
    assert.ok(
      mcp.every((s) => s.auth.pairing === PAIRING && s.auth.apiKey === null),
      'every relayed request carries X-BGOS-Pairing',
    )
    assert.equal(new Set(mcp.map((s) => s.clientId)).size, 1, 'one client id for the whole process')
    assert.ok(
      mcp.every((s) => s.waitMs === 45000),
      'the long-poll cap rides every request',
    )
    assert.deepEqual(
      mcp.map((s) => s.method),
      ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'],
    )
    assert.ok(
      mcp.every((s) => s.assistantId === null),
      'no HOAI_RELAY_ASSISTANT_ID in this env, so none is sent',
    )
    const status = await c.request('tools/call', { name: 'hoai_browser_status', arguments: {} })
    assert.match(
      status.result.content.map((x: any) => x.text).join(' '),
      /Kc's MacBook Pro/,
    )
  } finally {
    c.close()
    await relay.close()
  }
})

// Regression, found by the end-to-end run on 2026-09-12, when the whole relay
// lane was dead: the real backend is NestJS, whose POST answers 201, and the
// shim used to accept only a literal 200 / 202, so every successful relayed
// message was thrown away as relay_error and the agent was told the owner's
// desktop app was offline. Every other test in this file now runs against 201;
// this one pins the documented 200 / 202 codes so a backend that later adds
// @HttpCode(200) does not break the shim either.
test('relay: done and pending are read from the body status, under the documented 200 / 202 codes too', async () => {
  const relay = await fakeRelay({ pendingOnce: true, postStatus: 200, pendingStatus: 202 })
  const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: relay.url, HOAI_RELAY_PAIRING_TOKEN: PAIRING })
  try {
    const init = await c.init('codex')
    assert.match(init.result.instructions, /Relay: this is your DEFAULT browser/)
    const call = await c.request('tools/call', { name: 'browser_navigate', arguments: { url: 'http://127.0.0.1/' } })
    assert.equal(call.result.content[0].text, 'called browser_navigate')
    assert.equal(relay.state.polled, 1, 'the pending answer was collected once')
  } finally {
    c.close()
    await relay.close()
  }
})

// The backend's RelayMcpDto requires assistantId whichever header is used (a
// pairing can back several assistants, and the owner's rail shows the agent's
// name), so a pairing daemon that leaves it out is answered 400 and never
// reaches the desktop app. This is why bin/hoai-browser-launch.mjs sets
// HOAI_RELAY_ASSISTANT_ID on the pairing lane too.
test('relay: the pairing lane names the assistant too when the env does', async () => {
  const relay = await fakeRelay()
  const c = client({
    HOAI_HOME: tempHome(),
    HOAI_RELAY_BACKEND_URL: relay.url,
    HOAI_RELAY_PAIRING_TOKEN: PAIRING,
    HOAI_RELAY_ASSISTANT_ID: '7',
  })
  try {
    await c.init()
    const list = await c.request('tools/list')
    assert.equal(list.result.tools.length, 2)
    const mcp = relay.state.seen.filter((s) => s.route === 'mcp')
    assert.ok(mcp.length >= 2)
    assert.ok(
      mcp.every((s) => s.auth.pairing === PAIRING && s.auth.apiKey === null && s.assistantId === '7'),
      'every relayed request carries the pairing header AND the assistant id',
    )
  } finally {
    c.close()
    await relay.close()
  }
})

test('relay: the API-key lane sends X-API-Key and the assistant id in the body', async () => {
  const relay = await fakeRelay()
  const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: relay.url, HOAI_RELAY_API_KEY: 'key-123', HOAI_RELAY_ASSISTANT_ID: '42' })
  try {
    await c.init()
    const list = await c.request('tools/list')
    assert.equal(list.result.tools.length, 2)
    const mcp = relay.state.seen.filter((s) => s.route === 'mcp')
    assert.ok(mcp.length >= 2)
    assert.ok(mcp.every((s) => s.auth.apiKey === 'key-123' && s.auth.pairing === null && s.assistantId === '42'))
  } finally {
    c.close()
    await relay.close()
  }
})

test('relay: host offline answers the single status tool with the owner wording; a browser call is an error', async () => {
  const relay = await fakeRelay({ online: false })
  const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: relay.url, HOAI_RELAY_PAIRING_TOKEN: PAIRING })
  try {
    const init = await c.init()
    assert.match(init.result.instructions, /owner's Home of Agents desktop app is not running/)
    const list = await c.request('tools/list')
    assert.deepEqual(
      list.result.tools.map((t: any) => t.name),
      ['hoai_browser_status'],
    )
    const status = await c.request('tools/call', { name: 'hoai_browser_status', arguments: {} })
    assert.equal(status.result.isError, false)
    assert.match(status.result.content[0].text, /owner's Home of Agents desktop app/)
    const nav = await c.request('tools/call', { name: 'browser_navigate', arguments: { url: 'https://x' } })
    assert.equal(nav.result.isError, true)
    assert.ok(
      relay.state.seen.every((s) => s.route === 'host'),
      'nothing but presence probes reached the backend while offline',
    )
  } finally {
    c.close()
    await relay.close()
  }
})

test('relay: the tools appear on their own when the owner app comes online', async () => {
  const relay = await fakeRelay({ online: false })
  const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: relay.url, HOAI_RELAY_PAIRING_TOKEN: PAIRING })
  try {
    await c.init()
    const list = await c.request('tools/list')
    assert.equal(list.result.tools.length, 1)
    relay.state.online = true
    await c.waitFor('notifications/tools/list_changed', 5000)
    const again = await c.request('tools/list')
    assert.deepEqual(
      again.result.tools.map((t: any) => t.name),
      ['hoai_browser_open_session', 'browser_navigate'],
    )
  } finally {
    c.close()
    await relay.close()
  }
})

test('relay: a host_offline mid-session drops to offline, announces list_changed, and re-elects on the next call', async () => {
  const relay = await fakeRelay()
  const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: relay.url, HOAI_RELAY_PAIRING_TOKEN: PAIRING })
  try {
    await c.init()
    const ok = await c.request('tools/call', { name: 'browser_navigate', arguments: { url: 'http://127.0.0.1/' } })
    assert.equal(ok.result.isError, false)
    const before = c.notifications.filter((n) => n.method === 'notifications/tools/list_changed').length
    relay.state.hostOfflineNext = true
    const lost = await c.request('tools/call', { name: 'browser_snapshot', arguments: {} })
    assert.equal(lost.result.isError, true)
    assert.match(lost.result.content[0].text, /owner's Home of Agents desktop app/)
    await c.waitFor('notifications/tools/list_changed', 2000)
    assert.ok(
      c.notifications.filter((n) => n.method === 'notifications/tools/list_changed').length > before,
      'the drop to offline was announced',
    )
    // The host is back (the fake refused once): the next call re-initialises.
    const inits = () => relay.state.seen.filter((s) => s.route === 'mcp' && s.method === 'initialize').length
    const initsBefore = inits()
    const back = await c.request('tools/call', { name: 'browser_snapshot', arguments: {} })
    assert.equal(back.result.isError, false)
    assert.equal(inits(), initsBefore + 1, 'a fresh initialize re-elected the host')
  } finally {
    c.close()
    await relay.close()
  }
})

test('relay: a backend without the relay says so instead of pretending the call was lost', async () => {
  const bare = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = 404
    res.end(JSON.stringify({ message: 'Cannot POST /api/v1/integrations/browser/mcp' }))
  })
  const port = await listen(bare)
  const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: `http://127.0.0.1:${port}`, HOAI_RELAY_PAIRING_TOKEN: PAIRING })
  try {
    await c.init()
    const list = await c.request('tools/list')
    assert.deepEqual(
      list.result.tools.map((t: any) => t.name),
      ['hoai_browser_status'],
    )
  } finally {
    c.close()
    await new Promise<void>((r) => bare.close(() => r()))
  }
})

test('local wins over relay when the discovery file answers', async () => {
  const relay = await fakeRelay()
  const local = await fakeLocal()
  const home = tempHome()
  mkdirSync(join(home, '.hoai'), { recursive: true })
  writeFileSync(join(home, '.hoai', 'agent-browser.json'), JSON.stringify({ version: 1, url: local.url, token: 'tok-local', pid: 1 }))
  const c = client({ HOAI_HOME: home, HOAI_RELAY_BACKEND_URL: relay.url, HOAI_RELAY_PAIRING_TOKEN: PAIRING })
  try {
    const init = await c.init()
    assert.match(init.result.instructions, /Local: this is your DEFAULT browser/)
    const call = await c.request('tools/call', { name: 'browser_navigate', arguments: { url: 'http://127.0.0.1/' } })
    assert.equal(call.result.content[0].text, 'local called browser_navigate')
    assert.ok(local.seen.every((s) => s.auth === 'Bearer tok-local'))
    assert.equal(relay.state.seen.filter((s) => s.route === 'mcp').length, 0, 'nothing was relayed while the local door answers')
    // The app quits: the discovery file goes, and the shim falls to the relay.
    unlinkSync(join(home, '.hoai', 'agent-browser.json'))
    const relayed = await c.request('tools/call', { name: 'browser_navigate', arguments: { url: 'http://127.0.0.1/' } })
    assert.equal(relayed.result.content[0].text, 'called browser_navigate')
    await c.waitFor('notifications/tools/list_changed', 2000)
  } finally {
    c.close()
    await local.close()
    await relay.close()
  }
})
