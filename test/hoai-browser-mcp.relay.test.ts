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
 * The port tracks the BGOS suite as of BGOS 8daa845bc (the shim whose sha256
 * is 24470ac3, pinned in bin/hoai-browser-mcp.vendor.json): the presence probe
 * that names the agent, the refusals met while connecting, the rate limits,
 * the dropped host and the collect of a sent call are all here, so a copy
 * that loses any of them fails in this repo and not only in BGOS.
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
  /** The relay refuses every POST with a 429 while set (its own per agent limit, or the global throttler's shape). */
  rateLimited: boolean
  rateLimitMessage: string
  /** The 429's relay code; null is the global request throttler's shape (no code). */
  rateLimitCode: string | null
  retryAfter: number | null
  /** The held call's collect meets the backend's hostGone (409 host_disconnected), once. */
  dropHeldOnce: boolean
  dropMessage: string
  /** The held call's collect is throttled by the global guard (a 429 with no relay code), once. */
  pollRateLimitedOnce: boolean
  pollRetryAfter: number | null
  /** The HTTP code the host probe answers with; anything but 200 says nothing about the host. */
  hostStatus: number
  hostRetryAfter: number | null
  /** The relay answers the shim's connecting initialize itself, for as long as the test leaves it set. */
  initAnswer: { status: number; body: any } | null
  /** The connecting initialize goes pending, and its collect meets this refusal (persistent). */
  initCollect: 'drop' | 'throttle' | null
  initHeld: Set<string>
  /** The collect of a SENT call fails once: the socket dies, the call is lost, or a status and body. */
  collectFailOnce: 'destroy' | 'lose' | { status: number; body: any } | null
  /** An agent's own browser host (daemon placement), elected for this assistant id. */
  agentHost: { assistantId: number | string; hostLabel: string } | null
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
    rateLimited: false,
    rateLimitMessage: 'More than 60 browser calls in the last minute for this agent.',
    rateLimitCode: 'rate_limited',
    retryAfter: null,
    dropHeldOnce: false,
    dropMessage: 'The Home of Agents desktop app disconnected while running this call.',
    pollRateLimitedOnce: false,
    pollRetryAfter: null,
    hostStatus: 200,
    hostRetryAfter: null,
    initAnswer: null,
    initCollect: null,
    initHeld: new Set(),
    collectFailOnce: null,
    agentHost: null,
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
      const probedAssistantId = url.searchParams.get('assistantId')
      state.seen.push({ route: 'host', auth, assistantId: probedAssistantId })
      if (state.hostStatus !== 200) {
        // The probe refused (the global request throttler's 429 with its
        // Retry-After, or a 5xx): the shim learns NOTHING about the desktop
        // app from this answer.
        if (state.hostRetryAfter != null) res.setHeader('retry-after', String(state.hostRetryAfter))
        return json(state.hostStatus, {
          statusCode: state.hostStatus,
          message: state.hostStatus === 429 ? 'ThrottlerException: Too Many Requests' : 'Internal server error',
        })
      }
      // The real route: with an assistantId, the ANSWER is the agent's own
      // host when one is elected for it (hostKind "agent"), and only otherwise
      // the owner's desktop; without one, always the desktop.
      if (probedAssistantId && state.agentHost && String(state.agentHost.assistantId) === probedAssistantId) {
        return json(200, { online: true, hostLabel: state.agentHost.hostLabel, since: '2026-09-24T20:12:37Z', hostKind: 'agent' })
      }
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
      if (state.initHeld.has(rpcId) && state.initCollect) {
        // The shim's OWN connecting initialize went pending, and its collect
        // meets a refusal: the agent's call has not left the shim yet.
        // Persistent (not once) so the background probe cannot use it up first.
        if (state.initCollect === 'drop') return json(409, { statusCode: 409, message: state.dropMessage, code: 'host_disconnected' })
        if (state.initCollect === 'throttle') {
          if (state.pollRetryAfter != null) res.setHeader('retry-after', String(state.pollRetryAfter))
          return json(429, { statusCode: 429, message: 'ThrottlerException: Too Many Requests' })
        }
      }
      if (state.collectFailOnce) {
        // The collect of a call that WAS SENT fails: the socket dies (fetch
        // throws), the relay lost the call (404), or the backend answers a
        // 5xx. The call may already have run on the host.
        const how = state.collectFailOnce
        state.collectFailOnce = null
        if (how === 'destroy') return req.socket.destroy()
        if (how === 'lose') {
          state.held.delete(rpcId)
          return json(404, { statusCode: 404, code: 'call_lost', message: 'no such call' })
        }
        return json(how.status, how.body)
      }
      if (state.pollRateLimitedOnce) {
        // The collect GET is throttled by the global guard (a 429 with no
        // relay code): the call itself WAS sent and stays held, so a later
        // collect still finds it.
        state.pollRateLimitedOnce = false
        if (state.pollRetryAfter != null) res.setHeader('retry-after', String(state.pollRetryAfter))
        return json(429, { statusCode: 429, message: 'ThrottlerException: Too Many Requests' })
      }
      if (state.dropHeldOnce) {
        // The owner's window reloaded while the call was in flight: the
        // backend's hostGone settles it, and the collect answers what the BGOS
        // agent-browser-relay.service.host-disconnected.spec.ts pins on the wire.
        state.dropHeldOnce = false
        state.held.delete(rpcId)
        return json(409, { statusCode: 409, message: state.dropMessage, code: 'host_disconnected' })
      }
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
      const servedByAgentHost = !!state.agentHost && String(state.agentHost.assistantId) === String(body?.assistantId ?? '')
      if (state.rateLimited) {
        // The real backend's 429, through HttpExceptionAdvicer (which forwards
        // a 429's code), with the relay's own sentence. The relay sends no
        // Retry-After today; a test can add one, as the global throttler does.
        // rateLimitCode null is the global request throttler's shape: a 429
        // with no code, and a Retry-After.
        if (state.retryAfter != null) res.setHeader('retry-after', String(state.retryAfter))
        return json(429, { statusCode: 429, message: state.rateLimitMessage, ...(state.rateLimitCode ? { code: state.rateLimitCode } : {}) })
      }
      if (state.hostOfflineNext || (!state.online && !servedByAgentHost)) {
        state.hostOfflineNext = false
        return json(409, { code: 'host_offline', message: 'no desktop app online for this account' })
      }
      const rpcId = `r${++rpcSeq}`
      if (msg.id === undefined) return json(state.postStatus, { status: 'done', rpcId, message: {} })
      if (msg.method === 'initialize' && state.initAnswer) {
        // The relay answers the shim's connecting initialize itself (a 504, a
        // 502, the host's own JSON-RPC error), for as long as the test leaves
        // it set.
        const a = state.initAnswer
        return json(a.status, typeof a.body === 'function' ? a.body(msg, rpcId) : a.body)
      }
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
      if (msg.method === 'initialize' && state.initCollect) {
        state.held.set(rpcId, message)
        state.initHeld.add(rpcId)
        return json(state.pendingStatus, { status: 'pending', rpcId, pollAfterMs: 20 })
      }
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
    // This env (url + token, no assistant id) is an OPERATOR or another host
    // configuring the shim by hand, not anything this plugin produces: the
    // shim is framework neutral and sends exactly what it is given, which is
    // the contract pinned here. The REAL backend answers such a frame 400,
    // because RelayMcpDto requires assistantId on both lanes, and this fake
    // relay does not model that. The plugin's own lane can never be in this
    // shape: bin/hoai-browser-launch.mjs leaves the relay off rather than
    // configure a pairing env with no assistant id, pinned by "THE INVARIANT"
    // in test/hoai-browser-launch.test.ts. The env that DOES name one is the
    // "the pairing lane names the assistant too" case below.
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

// The launcher hands the shim the daemon's own backend URL, and that URL
// carries the /api/v1 suffix on every install whose config names it (the
// checked-in .mcp.json does, and server.ts accepts both forms). Until
// 2026-09-13 the shim appended /api/v1 again, so every probe went to
// /api/v1/api/v1/integrations/browser/host, was answered 404, and every
// Claude Code agent believed the owner's desktop was offline.
test('relay: a backend URL that already ends in /api/v1 is not doubled', async () => {
  const relay = await fakeRelay()
  const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: relay.url + '/api/v1/', HOAI_RELAY_PAIRING_TOKEN: PAIRING })
  try {
    const init = await c.init()
    assert.match(init.result.instructions, /Relay: this is your DEFAULT browser/)
    const list = await c.request('tools/list')
    assert.equal(list.result.tools.length, 2)
    assert.ok(relay.state.seen.some((s) => s.route === 'host'), 'the host probe reached the single-prefix route')
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

test("relay: with an assistant id configured, the presence probe names that agent, so an agent placed on its own machine opens a session while the owner's desktop is closed (Mission 25 goal 6)", async () => {
  // The desktop is CLOSED (online false) and agent 42's own host is up and elected for it.
  const relay = await fakeRelay({ online: false, agentHost: { assistantId: 42, hostLabel: 'AlienAres' } })
  const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: relay.url, HOAI_RELAY_API_KEY: 'key-123', HOAI_RELAY_ASSISTANT_ID: '42' })
  try {
    const init = await c.init()
    assert.doesNotMatch(
      init.result.instructions || '',
      /desktop app is not running/,
      "the agent's own host is online, so the shim must not read the desktop's absence as offline",
    )
    const list = await c.request('tools/list')
    assert.deepEqual(
      list.result.tools.map((t: any) => t.name),
      ['hoai_browser_open_session', 'browser_navigate'],
      'the browser tools, not the lone status tool',
    )
    const opened = await c.request('tools/call', { name: 'hoai_browser_open_session', arguments: { purpose: 'goal 6' } })
    assert.equal(opened.result.isError, false)
    const probes = relay.state.seen.filter((s) => s.route === 'host')
    assert.ok(
      probes.length >= 1 && probes.every((s) => s.assistantId === '42'),
      "every presence probe names the configured agent, so the backend answers with the agent's own host",
    )
    assert.ok(relay.state.seen.some((s) => s.route === 'mcp' && s.assistantId === '42'), 'the call reached the relay for that agent')
  } finally {
    c.close()
    await relay.close()
  }
})

test("relay: with no assistant id configured, the presence probe stays the owner's plain one (control)", async () => {
  const relay = await fakeRelay({ online: false, agentHost: { assistantId: 42, hostLabel: 'AlienAres' } })
  const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: relay.url, HOAI_RELAY_PAIRING_TOKEN: PAIRING })
  try {
    await c.init()
    const list = await c.request('tools/list')
    assert.deepEqual(
      list.result.tools.map((t: any) => t.name),
      ['hoai_browser_status'],
      "no agent named, no agent host to ask for: the desktop's absence is the answer",
    )
    assert.ok(relay.state.seen.filter((s) => s.route === 'host').every((s) => s.assistantId === null))
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
    // CONTROL for the dropped-connection case: a host that is really ABSENT keeps its words exactly.
    assert.match(lost.result.content[0].text, /not running or not signed in/)
    assert.doesNotMatch(lost.result.content[0].text, /may or may not have run/)
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

// THE FALSE SENTENCE ON A RATE LIMIT (P3 stage 4 rig, logs/R3-close-stray-preview.attempt2-rate-limited.log).
// A fresh shim whose initialize was refused 429 by the relay's 60 a minute cap swallowed the refusal, fell to
// offline, and told the agent the owner's desktop app "is not running or not signed in", while the app was up
// and driving. A refusal is not an absence: the agent must hear the limit, and that nothing ran.
const FALSE_OFFLINE = /not running or not signed in/
// The relay's limits run BEFORE any host is elected (agent-browser-relay.service.ts: assertInFlightRoom and
// stampMinute come before electHost; the global throttler earlier still), so a 429 proves nothing ran and NOTHING
// about the browser's host. "your owner's desktop app is fine" was a claim the shim cannot know. Pinned word for word.
const RATE_LIMITED_WORDS = "The HOAI relay refused this browser call because this agent made too many browser calls at once or in the last minute. Nothing ran. This refusal says nothing about whether the browser is online. Wait for your other browser calls to finish, or a minute after a burst, then retry."
const THROTTLED_WORDS = "The HOAI backend refused this browser call because too many requests came from this agent's connection in a short time (a general request limit, not the browser's own). Nothing ran. This refusal says nothing about whether the browser is online. Wait a little, then retry."
const APP_IS_FINE = /desktop app is fine/
// A refusal met while the shim CONNECTS (its own initialize) happens before the agent's call leaves the shim.
const CONNECT_LEAD = "The HOAI Agent Browser could not set up its connection to the browser, so your call was not sent. Nothing ran."
// Words that belong to a call that WAS sent; none of them is true of a call that never left the shim.
// REVIEW ROUND 3: "running this call" is the backend's own phrasing (hostGone: "... disconnected while running this
// call."), which the round 2 guard did not catch, so a connecting refusal carried it through and the guard stayed
// green. "call was sent" replaces "was sent to the browser", which named the connection request too ("The connection
// request was sent to the browser's host" is true while connecting; the agent's call being sent is not).
const SENT_CALL_WORDS = /while this call was running|running this call|may or may not have run|call was sent|The call may have run|this browser call/i
// The connecting reasons, pinned word for word (review round 3, items 2 and 3).
const CONNECT_DROPPED = "The browser's host dropped its connection while the connection was being set up. HOAI cannot tell a reload or a restart from a shutdown: retry in a moment; if it keeps failing, the host was probably shut down, and the browser tools come back when it runs again."
const CONNECT_COLLECT_THROTTLED = "The connection request was sent to the browser's host, but the HOAI backend refused the request that collects its answer because too many requests came from this agent's connection in a short time (a general request limit, not the browser's own). This says nothing about whether the browser is online. Wait a little, then retry."

test("relay: a rate limit while CONNECTING says it is a rate limit, never that the desktop app is not running", async () => {
  const relay = await fakeRelay({ rateLimited: true })
  const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: relay.url, HOAI_RELAY_PAIRING_TOKEN: PAIRING })
  try {
    const init = await c.init()
    assert.doesNotMatch(init.result.instructions, FALSE_OFFLINE)
    // The instructions answer the agent's initialize: no call of the agent's exists yet, so they name none.
    assert.match(init.result.instructions, /could not set up its connection to the browser\. The HOAI relay refused the connection because/)
    assert.doesNotMatch(init.result.instructions, /your call|this browser call/i)
    const status = await c.request("tools/call", { name: "hoai_browser_status", arguments: {} })
    const text = status.result.content[0].text
    assert.doesNotMatch(text, FALSE_OFFLINE, "the app is running; a 429 must not say it is not")
    assert.match(text, /too many browser calls/i)
    assert.match(text, /Nothing ran/)
    assert.match(text, /More than 60 browser calls in the last minute for this agent\./, "the relay's own words, so the numbers are the backend's, not guessed")
    assert.equal(status.result.isError, false, "the status tool answers the status; it did not fail")
    const nav = await c.request("tools/call", { name: "browser_navigate", arguments: { url: "https://x" } })
    assert.equal(nav.result.isError, true)
    assert.doesNotMatch(nav.result.content[0].text, FALSE_OFFLINE)
    assert.match(nav.result.content[0].text, /too many browser calls/i)
    // The refusal met the shim's connection, not the agent's call: it says so, and claims nothing about the host.
    for (const t of [text, nav.result.content[0].text]) {
      assert.ok(t.startsWith(CONNECT_LEAD), `a refusal met while connecting says the call was not sent: ${t}`)
      assert.match(t, /says nothing about whether the browser is online/)
      assert.doesNotMatch(t, APP_IS_FINE)
    }
    // The limit lifts: the next call connects and runs, with no restart.
    relay.state.rateLimited = false
    const after = await c.request("tools/call", { name: "browser_navigate", arguments: { url: "http://127.0.0.1/" } })
    assert.equal(after.result.content[0].text, "called browser_navigate")
  } finally {
    c.close()
    await relay.close()
  }
})

test("relay: a rate limit on a LIVE session names the relay's reason and a Retry-After when one is sent, and keeps the session", async () => {
  const relay = await fakeRelay()
  const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: relay.url, HOAI_RELAY_PAIRING_TOKEN: PAIRING })
  try {
    await c.init()
    const ok = await c.request("tools/call", { name: "browser_navigate", arguments: { url: "http://127.0.0.1/" } })
    assert.equal(ok.result.isError, false)
    const inits = () => relay.state.seen.filter((s) => s.route === "mcp" && s.method === "initialize").length
    const initsBefore = inits()
    relay.state.rateLimited = true
    relay.state.rateLimitMessage = "2 browser calls are already in flight for this agent; wait for them to finish."
    relay.state.retryAfter = 7
    const limited = await c.request("tools/call", { name: "browser_snapshot", arguments: {} })
    const text = limited.result.content[0].text
    assert.equal(limited.result.isError, true)
    assert.doesNotMatch(text, FALSE_OFFLINE)
    assert.match(text, /Nothing ran/)
    assert.match(text, /2 browser calls are already in flight for this agent/)
    assert.match(text, /wait 7 seconds/i, "a Retry-After the backend sends is passed on as a number")
    assert.ok(text.startsWith(RATE_LIMITED_WORDS), `the rate limit words, pinned: ${text}`)
    assert.doesNotMatch(text, APP_IS_FINE, "the relay refuses before any host is elected; the shim cannot know the app is fine")
    relay.state.rateLimited = false
    const back = await c.request("tools/call", { name: "browser_snapshot", arguments: {} })
    assert.equal(back.result.isError, false)
    assert.equal(inits(), initsBefore, "a rate limit is not a lost session: no re-initialize")
  } finally {
    c.close()
    await relay.close()
  }
})

test("relay: a 429 from the backend's general request limit (no relay code) says so, passes on its Retry-After, and never claims the agent's browser calls were counted", async () => {
  const relay = await fakeRelay()
  const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: relay.url, HOAI_RELAY_PAIRING_TOKEN: PAIRING })
  try {
    await c.init()
    assert.equal((await c.request("tools/call", { name: "browser_navigate", arguments: { url: "http://127.0.0.1/" } })).result.isError, false)
    relay.state.rateLimited = true
    relay.state.rateLimitCode = null // BgosThrottlerGuard's ThrottlerException: no code, a Retry-After in seconds
    relay.state.rateLimitMessage = "ThrottlerException: Too Many Requests"
    relay.state.retryAfter = 12
    const limited = await c.request("tools/call", { name: "browser_snapshot", arguments: {} })
    const text = limited.result.content[0].text
    assert.equal(limited.result.isError, true)
    assert.doesNotMatch(text, FALSE_OFFLINE)
    assert.doesNotMatch(text, /browser calls at once or in the last minute/, "that is the relay's own per agent limit, which did not refuse this call")
    assert.match(text, /general request limit/)
    assert.match(text, /Nothing ran/)
    assert.match(text, /wait 12 seconds/i)
    assert.ok(text.startsWith(THROTTLED_WORDS), `the general limit words, pinned: ${text}`)
    assert.doesNotMatch(text, APP_IS_FINE, "a limit in front of the relay says nothing about the app")
    relay.state.rateLimited = false
    assert.equal((await c.request("tools/call", { name: "browser_snapshot", arguments: {} })).result.isError, false)
  } finally {
    c.close()
    await relay.close()
  }
})

// THE FALSE SENTENCE ON A RELOAD. The relay rides the owner's renderer socket, so a window reload drops the host
// while a call is in flight. The backend's hostGone settles it (host_disconnected, 409, pinned on the wire by
// backend/src/agent-browser/agent-browser-relay.service.host-disconnected.spec.ts), and the agent was told the
// app "is not running or not signed in", with no word that the click it asked for may already have happened.
// The shim's OWN words for a drop must be true whichever host dropped: the owner's desktop app OR the browser host
// on the agent's own machine (daemon placement). Only the relay's appended sentence says which one it was.
function assertHostNeutral(text: string) {
  const own = text.split(" The relay said: ")[0]
  assert.notEqual(own, text, "the relay's own sentence is appended")
  assert.doesNotMatch(own, /desktop|window|Home of Agents|your owner opens/i, `the shim's own words name no host: ${own}`)
}

test("relay: a desktop connection that DROPS mid call says the call may or may not have run, and re-elects on the next call", async () => {
  const relay = await fakeRelay({ pendingOnce: true, dropHeldOnce: true })
  const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: relay.url, HOAI_RELAY_PAIRING_TOKEN: PAIRING })
  try {
    await c.init()
    const before = c.notifications.filter((n) => n.method === "notifications/tools/list_changed").length
    const lost = await c.request("tools/call", { name: "browser_click", arguments: { target: "e12" } })
    const text = lost.result.content[0].text
    assert.equal(lost.result.isError, true)
    assert.equal(relay.state.polled, 1, "the call went pending and its collect met the drop")
    assert.doesNotMatch(text, FALSE_OFFLINE, "the app was running; a dropped connection must not say it is not")
    assert.match(text, /dropped its connection while this call was running/)
    assert.match(text, /may or may not have run/)
    assert.match(text, /[Cc]heck the page/)
    // A drop is a reload OR a quit, and the backend sees the same socket close for both: never claim which.
    assert.doesNotMatch(text, /not the app being closed/)
    assert.match(text, /cannot tell a reload or a restart from a shutdown/)
    assert.match(text, /The Home of Agents desktop app disconnected while running this call\./, "the relay's own sentence, which names desktop or agent host")
    assertHostNeutral(text)
    await c.waitFor("notifications/tools/list_changed", 2000)
    assert.ok(c.notifications.filter((n) => n.method === "notifications/tools/list_changed").length > before)
    // The window is back: the next call builds a fresh session on the new socket.
    const inits = () => relay.state.seen.filter((s) => s.route === "mcp" && s.method === "initialize").length
    const initsBefore = inits()
    const back = await c.request("tools/call", { name: "browser_snapshot", arguments: {} })
    assert.equal(back.result.isError, false)
    assert.equal(inits(), initsBefore + 1, "a fresh initialize re-elected the host")
  } finally {
    c.close()
    await relay.close()
  }
})

test("relay: an AGENT host (daemon placement) that drops mid call is told in words true for that host, never the desktop's", async () => {
  const relay = await fakeRelay({ pendingOnce: true, dropHeldOnce: true, dropMessage: "The browser host for this agent disconnected while running this call." })
  const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: relay.url, HOAI_RELAY_PAIRING_TOKEN: PAIRING })
  try {
    await c.init()
    const lost = await c.request("tools/call", { name: "browser_click", arguments: { target: "e12" } })
    const text = lost.result.content[0].text
    assert.equal(lost.result.isError, true)
    assert.match(text, /may or may not have run/)
    assert.match(text, /The browser host for this agent disconnected while running this call\./)
    assert.doesNotMatch(text, /window reloaded|when your owner opens it/, "an agent host has no owner's window to reload or reopen")
    assertHostNeutral(text)
  } finally {
    c.close()
    await relay.close()
  }
})

// A 429 on the COLLECT (GET .../mcp/:rpcId, throttled by the global guard) comes AFTER the call was sent: it may
// already have run. The throttled words ("Nothing ran, and your owner's desktop app is fine") were false here.
test("relay: a 429 while COLLECTING a pending call says the call was sent and may have run, never that nothing ran", async () => {
  const relay = await fakeRelay({ pendingOnce: true, pollRateLimitedOnce: true, pollRetryAfter: 5 })
  const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: relay.url, HOAI_RELAY_PAIRING_TOKEN: PAIRING })
  try {
    await c.init()
    const res = await c.request("tools/call", { name: "browser_click", arguments: { target: "e12" } })
    const text = res.result.content[0].text
    assert.equal(res.result.isError, true)
    assert.equal(relay.state.polled, 1, "the call went pending and its collect met the 429")
    assert.doesNotMatch(text, /Nothing ran/, "the call was already sent; it may have run")
    assert.doesNotMatch(text, FALSE_OFFLINE)
    assert.match(text, /was sent/)
    assert.match(text, /may have run/)
    assert.match(text, /[Cc]heck the page with browser_snapshot before you retry/)
    assert.match(text, /wait 5 seconds/i, "the Retry-After is passed on")
    // The host is fine and the session with it: the next call runs with no re-initialize.
    const inits = () => relay.state.seen.filter((s) => s.route === "mcp" && s.method === "initialize").length
    const initsBefore = inits()
    const next = await c.request("tools/call", { name: "browser_snapshot", arguments: {} })
    assert.equal(next.result.isError, false)
    assert.equal(inits(), initsBefore, "a throttled collect is not a lost session")
  } finally {
    c.close()
    await relay.close()
  }
})

// REVIEW ROUND 2, ITEM 1. A refusal the shim's OWN connecting initialize meets used to reach the agent as the answer
// to its tools/call, in words written for a call that ran or was sent ("while this call was running", "This browser
// call was sent to the browser", "did not answer the browser call"). The agent's call never left the shim. Each
// refusal met while connecting gets its own true sentence; host_offline keeps its words (the control).
const CONNECT_CASES: { name: string; state: Partial<RelayState>; reason: RegExp[]; exact?: string }[] = [
  // REVIEW ROUND 3, ITEM 2. While connecting, the backend's hostGone sentence ("... disconnected while running this
  // call.") is not appended: only WHO dropped, as the relay reported it, and nothing when its sentence names neither.
  {
    name: "host_disconnected (the desktop app dropped between the probe and the initialize)",
    state: { initCollect: "drop" },
    reason: [/dropped its connection while the connection was being set up/, /cannot tell a reload or a restart from a shutdown/],
    exact: `${CONNECT_LEAD} ${CONNECT_DROPPED} The relay reported that the host that dropped was the Home of Agents desktop app.`,
  },
  {
    name: "host_disconnected (the agent's own browser host dropped, daemon placement)",
    state: { initCollect: "drop", dropMessage: "The browser host for this agent disconnected while running this call." },
    reason: [/dropped its connection while the connection was being set up/],
    exact: `${CONNECT_LEAD} ${CONNECT_DROPPED} The relay reported that the host that dropped was the browser host on this agent's own machine.`,
  },
  {
    name: "host_disconnected (a relay sentence that names neither host is not passed on)",
    state: { initCollect: "drop", dropMessage: "Something went away while running this call." },
    reason: [/dropped its connection while the connection was being set up/],
    exact: `${CONNECT_LEAD} ${CONNECT_DROPPED}`,
  },
  // REVIEW ROUND 3, ITEM 3. A pending answer proves only that the backend emitted the frame, not that it arrived.
  {
    name: "collect_throttled (the initialize went pending and its collect got a 429)",
    state: { initCollect: "throttle", pollRetryAfter: 4 },
    reason: [/general request limit/, /says nothing about whether the browser is online/, /wait 4 seconds/],
    exact: `${CONNECT_LEAD} ${CONNECT_COLLECT_THROTTLED} The relay asks you to wait 4 seconds before you retry.`,
  },
  {
    name: "host_timeout (the host did not answer the initialize)",
    state: { initAnswer: { status: 504, body: { statusCode: 504, code: "host_timeout", message: "The desktop app did not answer within 120 seconds." } } },
    reason: [/did not answer the connection request in time/, /[Rr]etry once/],
  },
  {
    name: "relay_error (the relay answered the initialize 502)",
    state: { initAnswer: { status: 502, body: { statusCode: 502, message: "Bad Gateway" } } },
    reason: [/answered 502: Bad Gateway/, /[Rr]etry in a moment/],
  },
  {
    name: "a JSON-RPC error from the host to the initialize",
    state: { initAnswer: { status: 201, body: (msg: any, rpcId: string) => ({ status: "done", rpcId, message: { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "session store full" } } }) } },
    reason: [/answered the connection request with an error: session store full/],
  },
]
for (const cc of CONNECT_CASES) {
  test(`relay: a refusal met while CONNECTING, ${cc.name}, says the connection could not be set up and the call was not sent`, async () => {
    const relay = await fakeRelay({ online: false })
    const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: relay.url, HOAI_RELAY_PAIRING_TOKEN: PAIRING })
    try {
      await c.init()
      // The host comes online and every connecting initialize now meets the refusal (persistent, so the background
      // probe cannot use it up before the agent's call).
      Object.assign(relay.state, cc.state, { online: true })
      const nav = await c.request("tools/call", { name: "browser_click", arguments: { target: "e12" } })
      const text = nav.result.content[0].text
      assert.equal(nav.result.isError, true)
      assert.ok(text.startsWith(CONNECT_LEAD), `the connection could not be set up and the call was not sent: ${text}`)
      assert.doesNotMatch(text, SENT_CALL_WORDS, "the agent's call never left the shim; no word may say it ran or was sent")
      assert.doesNotMatch(text, FALSE_OFFLINE, "the probe had just said the host is online")
      for (const r of cc.reason) assert.match(text, r)
      if (cc.exact) assert.equal(text, cc.exact, "the connecting words, word for word")
      assert.ok(!relay.state.seen.some((s) => s.route === "mcp" && s.method === "tools/call"), "the agent's call never reached the relay")
      const status = await c.request("tools/call", { name: "hoai_browser_status", arguments: {} })
      assert.equal(status.result.isError, false)
      assert.ok(status.result.content[0].text.startsWith(CONNECT_LEAD))
      // The refusal clears: the next call connects and runs, with no restart.
      Object.assign(relay.state, { initCollect: null, initAnswer: null })
      const after = await c.request("tools/call", { name: "browser_navigate", arguments: { url: "http://127.0.0.1/" } })
      assert.equal(after.result.content[0].text, "called browser_navigate")
    } finally {
      c.close()
      await relay.close()
    }
  })
}

test("relay: host_offline met while CONNECTING keeps its own words, word for word (control)", async () => {
  const relay = await fakeRelay({ online: false })
  const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: relay.url, HOAI_RELAY_PAIRING_TOKEN: PAIRING })
  try {
    await c.init()
    // The probe says online, then the host is gone by the time the initialize arrives.
    Object.assign(relay.state, { online: true, initAnswer: { status: 409, body: { statusCode: 409, code: "host_offline", message: "no desktop app online for this account" } } })
    const nav = await c.request("tools/call", { name: "browser_click", arguments: { target: "e12" } })
    const text = nav.result.content[0].text
    assert.equal(nav.result.isError, true)
    assert.equal(text, "The HOAI Agent Browser is not available: your owner's Home of Agents desktop app is not running or not signed in, and there is no desktop app on this machine. Ask them to open Home of Agents on their computer (Cmd or Ctrl+Shift+B opens the Agent Browser); the browser tools appear here as soon as it is online.")
  } finally {
    c.close()
    await relay.close()
  }
})

// REVIEW ROUND 2, ITEM 3. Once a call went pending it WAS SENT, so a collect that throws, answers 404 or answers a 5xx
// cannot say the call did not run. "Retry in a moment" / "Retry it once" invited a blind retry that can repeat a
// click or a purchase that already happened. Each gets words true for a sent call.
const RETRY_BLIND = /Retry in a moment|Retry it once|Retry once/
const COLLECT_CASES: { name: string; fail: RelayState['collectFailOnce']; reason: RegExp }[] = [
  { name: "throws (relay_unreachable)", fail: "destroy", reason: /could not be reached to collect its result/ },
  { name: "answers 404 (call_lost)", fail: "lose", reason: /lost track of it before its result was collected/ },
  { name: "answers 502 (relay_error)", fail: { status: 502, body: { statusCode: 502, message: "Bad Gateway" } }, reason: /answered 502: Bad Gateway when asked for its result/ },
]
for (const cc of COLLECT_CASES) {
  test(`relay: a collect of a SENT call that ${cc.name} says the call may or may not have run, check before retrying`, async () => {
    const relay = await fakeRelay({ pendingOnce: true, collectFailOnce: cc.fail })
    const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: relay.url, HOAI_RELAY_PAIRING_TOKEN: PAIRING })
    try {
      await c.init()
      const res = await c.request("tools/call", { name: "browser_click", arguments: { target: "e12" } })
      const text = res.result.content[0].text
      assert.equal(res.result.isError, true)
      assert.equal(relay.state.polled, 1, "the call went pending and its collect failed")
      assert.match(text, /^This browser call was sent to the browser/)
      assert.match(text, cc.reason)
      assert.match(text, /may or may not have run/)
      assert.match(text, /[Cc]heck the page with browser_snapshot before you retry/)
      assert.match(text, /ask your owner/)
      assert.doesNotMatch(text, RETRY_BLIND, "a blind retry can repeat an action that already ran")
      assert.doesNotMatch(text, FALSE_OFFLINE)
      const next = await c.request("tools/call", { name: "browser_snapshot", arguments: {} })
      assert.equal(next.result.isError, false, "the next call runs")
    } finally {
      c.close()
      await relay.close()
    }
  })
}

// The host probe (GET .../integrations/browser/host) answering anything but 200 used to read as "no host", so a 429
// or a 5xx on the probe told the agent the owner's desktop app "is not running or not signed in", which the shim
// could not know.
for (const [probeStatus, retryAfter] of [[429, 9], [503, null]] as [number, number | null][]) {
  test(`relay: a host probe answered ${probeStatus} says the shim could not check, with the code, never that the app is not running`, async () => {
    const relay = await fakeRelay({ hostStatus: probeStatus, hostRetryAfter: retryAfter })
    const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: relay.url, HOAI_RELAY_PAIRING_TOKEN: PAIRING })
    try {
      const init = await c.init()
      assert.doesNotMatch(init.result.instructions, FALSE_OFFLINE)
      const status = await c.request("tools/call", { name: "hoai_browser_status", arguments: {} })
      const text = status.result.content[0].text
      assert.doesNotMatch(text, FALSE_OFFLINE, "the probe failed; it said nothing about the app")
      assert.match(text, /could not check/)
      assert.match(text, new RegExp(`answered ${probeStatus}`))
      assert.match(text, /[Tt]ry again/)
      if (retryAfter != null) assert.match(text, new RegExp(`wait ${retryAfter} seconds`))
      const nav = await c.request("tools/call", { name: "browser_navigate", arguments: { url: "https://x" } })
      assert.equal(nav.result.isError, true)
      assert.doesNotMatch(nav.result.content[0].text, FALSE_OFFLINE)
      // The probe answers again: the next call connects and runs, with no restart.
      relay.state.hostStatus = 200
      const after = await c.request("tools/call", { name: "browser_navigate", arguments: { url: "http://127.0.0.1/" } })
      assert.equal(after.result.content[0].text, "called browser_navigate")
    } finally {
      c.close()
      await relay.close()
    }
  })
}

test("relay: a backend the host probe cannot reach at all says the relay is unreachable, never that the app is not running", async () => {
  const gone = createServer()
  const port = await listen(gone)
  await new Promise<void>((r) => gone.close(() => r())) // nothing listens on this port now
  const c = client({ HOAI_HOME: tempHome(), HOAI_RELAY_BACKEND_URL: `http://127.0.0.1:${port}`, HOAI_RELAY_PAIRING_TOKEN: PAIRING })
  try {
    await c.init()
    const status = await c.request("tools/call", { name: "hoai_browser_status", arguments: {} })
    assert.doesNotMatch(status.result.content[0].text, FALSE_OFFLINE)
    assert.match(status.result.content[0].text, /relay is unreachable/)
  } finally {
    c.close()
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
    const status = await c.request('tools/call', { name: 'hoai_browser_status', arguments: {} })
    assert.match(status.result.content[0].text, /does not have the browser relay yet/, "the host probe's 404 is a missing relay")
    assert.doesNotMatch(status.result.content[0].text, FALSE_OFFLINE)
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
