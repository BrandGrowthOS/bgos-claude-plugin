/**
 * A person's lane and the Agent Browser, the lane daemon's half
 * (lib/lane-browser.ts; BGOS plan 2026-11-13 sections 4.1, 4.2 and 9).
 *
 *   - the relay is called with the LANE's own http (its session), on
 *     POST integrations/browser/mcp with the agent named, pending answers
 *     collected on GET integrations/browser/mcp/<rpcId>;
 *   - the lane serves only the fixed browser tool names, never
 *     hoai_vault_fill, a file upload or a tool the host adds later;
 *   - with the host offline the lane serves one status tool that says so;
 *   - vault_items lists metadata only; vault_fill asks the server, waits for
 *     the owner when asked (and tells the person once), then has the host fill
 *     through the relay; neither returns a ticket or a value.
 *
 * No em or en dashes in this file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LANE_VAULT_TOOLS,
  LaneBrowserRelay,
  LaneBrowserTools,
  LANE_VAULT_WAITING_SENTENCE,
} from '../lib/lane-browser.ts'
import { LANE_BROWSER_TOOL_NAMES } from '../lib/lane-policy.mjs'

class HttpError extends Error {
  constructor(readonly status: number, readonly body: string) { super(`HTTP ${status}`) }
}

const ITEM = '2f1c3a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const TICKET = 'T'.repeat(43)
const ORIGIN = 'https://login.example.com'
const HOST_TOOLS = [
  ...LANE_BROWSER_TOOL_NAMES.map((name) => ({ name, description: `${name} desc`, inputSchema: { type: 'object', properties: {} } })),
  { name: 'browser_file_upload', description: '', inputSchema: { type: 'object' } },
  { name: 'browser_drop', description: '', inputSchema: { type: 'object' } },
  { name: 'hoai_vault_fill', description: '', inputSchema: { type: 'object' } },
  { name: 'browser_future_tool', description: '', inputSchema: { type: 'object' } },
]

type Call = { method: 'GET' | 'POST'; path: string; body?: any }

/** A fake backend: the relay (with a host that answers MCP) and the lane vault routes. */
function backend(opts: { hostOnline?: boolean; vault?: 'ok' | 403; fill?: any; polls?: any[]; hostReceipt?: any; pendingOnce?: boolean } = {}) {
  const calls: Call[] = []
  const polls = [...(opts.polls ?? [])]
  let pendingLeft = opts.pendingOnce ? 1 : 0
  const answerMcp = (message: any) => {
    if (message.method === 'initialize') return { jsonrpc: '2.0', id: message.id, result: { instructions: 'host' } }
    if (message.method === 'tools/list') return { jsonrpc: '2.0', id: message.id, result: { tools: HOST_TOOLS } }
    if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params
      if (name === 'hoai_vault_fill') return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(opts.hostReceipt ?? { filled: true }) }] } }
      return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `${name} ran ${JSON.stringify(args)}` }] } }
    }
    return { jsonrpc: '2.0', id: message.id, result: {} }
  }
  const http = {
    async post(path: string, body: any) {
      calls.push({ method: 'POST', path, body })
      if (path === 'integrations/browser/mcp') {
        if (opts.hostOnline === false) throw new HttpError(409, JSON.stringify({ code: 'host_offline', message: 'No browser host is online for this person.' }))
        if (pendingLeft > 0 && body.message.method === 'tools/call') { pendingLeft -= 1; return { status: 'pending', rpcId: 'rpc-1', pollAfterMs: 5 } }
        return { status: 'done', message: answerMcp(body.message) }
      }
      if (path === `vault/lane/items/${ITEM}/fill`) {
        if (opts.fill instanceof HttpError) throw opts.fill
        return opts.fill ?? { status: 'ready', ticket: TICKET, expiresAt: new Date(Date.now() + 60_000).toISOString() }
      }
      throw new HttpError(404, '')
    },
    async get(path: string) {
      calls.push({ method: 'GET', path })
      if (path === 'integrations/browser/mcp/rpc-1') return { status: 'done', message: { jsonrpc: '2.0', id: 'x', result: { content: [{ type: 'text', text: 'collected' }] } } }
      if (path === 'vault/lane/items') {
        if (opts.vault === 403) throw new HttpError(403, JSON.stringify({ message: 'The owner of this agent has not shared their logins with you.' }))
        return { items: [{ id: ITEM, name: 'Bank', website: ORIGIN, username: 'leo@example.com', ask: false, own: false, sealed: { ciphertext: 'SECRET' } }] }
      }
      if (path === 'vault/lane/fills/req-1') return polls.shift() ?? { status: 'waiting' }
      throw new HttpError(404, '')
    },
  }
  return { http, calls }
}

function tools(b: ReturnType<typeof backend>, extra: Partial<ConstructorParameters<typeof LaneBrowserTools>[0]> = {}) {
  const told: string[] = []
  const changed: number[] = []
  let clock = Date.parse('2026-11-13T10:00:00Z')
  const relay = new LaneBrowserRelay({ http: b.http, assistantId: '901', relaySessionKey: 'lane-abc', sleep: async (ms) => { clock += ms }, now: () => clock })
  const t = new LaneBrowserTools({ enabled: true, relay, http: b.http, sleep: async (ms) => { clock += ms }, now: () => clock, log: () => {}, tellPerson: async (s) => { told.push(s) }, onListChanged: () => { changed.push(1) }, ...extra })
  return { t, told, changed, setClock: (ms: number) => { clock = ms }, now: () => clock }
}

const textOf = (r: any) => r.content.map((c: any) => c.text).join('')

test('the relay is called with the lane http, the agent named, a lane client id; tools are the fixed list only', async () => {
  const b = backend()
  const { t } = tools(b)
  const list = await t.list()
  const names = list.map((tool: any) => tool.name)
  assert.deepEqual(names, [...LANE_BROWSER_TOOL_NAMES, 'vault_items', 'vault_fill'])
  const first = b.calls.find((c) => c.path === 'integrations/browser/mcp')!
  assert.equal(first.body.assistantId, 901)
  assert.equal(first.body.clientId, 'lane-abc')
  assert.equal(first.body.message.method, 'initialize')
  const r = await t.call('browser_navigate', { url: 'https://example.com' })
  assert.match(textOf(r), /browser_navigate ran/)
  for (const refused of ['hoai_vault_fill', 'browser_file_upload', 'browser_future_tool']) {
    const no = await t.call(refused, {})
    assert.equal(no.isError, true, refused)
    assert.equal(b.calls.some((c) => c.body?.message?.params?.name === refused), false, `${refused} never reaches the relay`)
  }
})

test('a pending call is collected on GET integrations/browser/mcp/<rpcId>', async () => {
  const b = backend({ pendingOnce: true })
  const { t } = tools(b)
  await t.list()
  assert.equal(textOf(await t.call('browser_snapshot', {})), 'collected')
  assert.ok(b.calls.some((c) => c.method === 'GET' && c.path === 'integrations/browser/mcp/rpc-1'))
})

test('a lane with the browser off serves nothing and calls nothing', async () => {
  const b = backend()
  const { t } = tools(b, { enabled: false })
  assert.deepEqual(await t.list(), [])
  assert.equal(b.calls.length, 0)
  assert.equal((await t.call('browser_navigate', {})).isError, true)
})

test('with no host online the lane serves one status tool that says why; vault tools still list', async () => {
  const b = backend({ hostOnline: false })
  const { t } = tools(b)
  const names = (await t.list()).map((tool: any) => tool.name)
  assert.deepEqual(names, ['hoai_browser_status', 'vault_items', 'vault_fill'])
  const r = await t.call('hoai_browser_status', {})
  assert.match(textOf(r), /No browser host is online for this person/)
})

test('vault tools are served only while the server lets this person use the vault', async () => {
  const b = backend({ vault: 403 })
  const { t } = tools(b)
  const names = (await t.list()).map((tool: any) => tool.name)
  assert.equal(names.includes('vault_items'), false)
  assert.equal(names.includes('vault_fill'), false)
})

test('the vault tool descriptions say no secret is taken or returned', () => {
  assert.deepEqual(LANE_VAULT_TOOLS.map((tool) => tool.name), ['vault_items', 'vault_fill'])
  for (const tool of LANE_VAULT_TOOLS) assert.match(tool.description ?? "", /never (takes|returns)[^.]*password/i)
  const fill = LANE_VAULT_TOOLS[1]!
  assert.deepEqual(Object.keys((fill.inputSchema as any).properties).sort(), ['itemId', 'origin', 'sessionId', 'tabId'])
})

test('vault_items answers metadata only, copied field by field', async () => {
  const b = backend()
  const { t } = tools(b)
  const r = await t.call('vault_items', {})
  const items = JSON.parse(textOf(r)).items
  assert.deepEqual(items, [{ id: ITEM, name: 'Bank', website: ORIGIN, username: 'leo@example.com', ask: false, own: false }])
  assert.doesNotMatch(textOf(r), /SECRET/)
})

test('vault_items passes the server refusal sentence on', async () => {
  const b = backend({ vault: 403 })
  const { t } = tools(b)
  const r = await t.call('vault_items', {})
  assert.equal(r.isError, true)
  assert.match(textOf(r), /has not shared their logins with you/)
})

test('vault_fill ready: asks the server, then the host fills through the relay with the ticket; the answer has no ticket', async () => {
  const b = backend()
  const { t, told } = tools(b)
  const r = await t.call('vault_fill', { itemId: ITEM, sessionId: 'vs_1', tabId: 'tab_1', origin: ORIGIN })
  assert.deepEqual(JSON.parse(textOf(r)), { filled: true })
  assert.doesNotMatch(textOf(r), new RegExp(TICKET))
  const ask = b.calls.find((c) => c.path === `vault/lane/items/${ITEM}/fill`)!
  assert.deepEqual(ask.body, { sessionId: 'vs_1', tabId: 'tab_1', origin: ORIGIN })
  const relayed = b.calls.find((c) => c.body?.message?.params?.name === 'hoai_vault_fill')!
  assert.equal(relayed.path, 'integrations/browser/mcp')
  assert.deepEqual(relayed.body.message.params.arguments, { ticket: TICKET, sessionId: 'vs_1', tabId: 'tab_1', origin: ORIGIN })
  assert.deepEqual(told, [], 'nobody was asked')
})

test('vault_fill waiting: the person is told once, the lane polls until ready, then fills', async () => {
  const b = backend({ fill: { status: 'waiting', requestId: 'req-1', expiresAt: '2026-11-13T10:10:00Z' }, polls: [{ status: 'waiting' }, { status: 'ready', ticket: TICKET }] })
  const { t, told } = tools(b)
  const r = await t.call('vault_fill', { itemId: ITEM, sessionId: 'vs_1', tabId: 'tab_1', origin: ORIGIN })
  assert.deepEqual(JSON.parse(textOf(r)), { filled: true })
  assert.deepEqual(told, [LANE_VAULT_WAITING_SENTENCE])
  assert.doesNotMatch(LANE_VAULT_WAITING_SENTENCE, /[.!?].+[.!?]/, 'one sentence')
  assert.equal(b.calls.filter((c) => c.path === 'vault/lane/fills/req-1').length, 2)
})

test('vault_fill waiting: denied and expired end without a fill', async () => {
  for (const [answer, reason] of [[{ status: 'denied' }, 'owner_denied'], [{ status: 'expired' }, 'owner_did_not_answer']] as const) {
    const b = backend({ fill: { status: 'waiting', requestId: 'req-1', expiresAt: '2026-11-13T10:10:00Z' }, polls: [answer] })
    const { t } = tools(b)
    const r = JSON.parse(textOf(await t.call('vault_fill', { itemId: ITEM, sessionId: 'vs_1', tabId: 'tab_1', origin: ORIGIN })))
    assert.equal(r.filled, false)
    assert.equal(r.reason, reason)
    assert.equal(b.calls.some((c) => c.body?.message?.params?.name === 'hoai_vault_fill'), false)
  }
})

test('vault_fill waiting: the lane stops polling at the request expiry', async () => {
  const b = backend({ fill: { status: 'waiting', requestId: 'req-1', expiresAt: '2026-11-13T10:00:30Z' } })
  const { t } = tools(b)
  const r = JSON.parse(textOf(await t.call('vault_fill', { itemId: ITEM, sessionId: 'vs_1', tabId: 'tab_1', origin: ORIGIN })))
  assert.equal(r.reason, 'owner_did_not_answer')
  const polls = b.calls.filter((c) => c.path === 'vault/lane/fills/req-1').length
  assert.ok(polls >= 5 && polls <= 12, `polled every few seconds (${polls})`)
})

test('vault_fill refuses a bad input before anything is asked, and never takes a password', async () => {
  const b = backend()
  const { t } = tools(b)
  for (const args of [
    { itemId: ITEM, sessionId: 'vs_1', tabId: 'tab_1', origin: 'http://login.example.com' },
    { itemId: ITEM, sessionId: 'vs_1', tabId: 'tab_1', origin: 'https://login.example.com/path' },
    { itemId: ITEM, sessionId: 'vs_1', tabId: 'tab_1', origin: ORIGIN, password: 'hunter2' },
    { itemId: '../x', sessionId: 'vs_1', tabId: 'tab_1', origin: ORIGIN },
    { itemId: ITEM, tabId: 'tab_1', origin: ORIGIN },
  ]) {
    assert.equal((await t.call('vault_fill', args)).isError, true, JSON.stringify(args))
  }
  assert.equal(b.calls.length, 0)
})

test('vault_fill passes the server refusal and the host receipt reason on, never a value', async () => {
  const refused = backend({ fill: new HttpError(403, JSON.stringify({ message: 'The owner of this agent has not shared their logins with you.' })) })
  const r1 = await tools(refused).t.call('vault_fill', { itemId: ITEM, sessionId: 'vs_1', tabId: 'tab_1', origin: ORIGIN })
  assert.equal(r1.isError, true)
  assert.match(textOf(r1), /has not shared their logins/)
  const failed = backend({ hostReceipt: { filled: false, reason: 'sign_in_failed' } })
  const r2 = JSON.parse(textOf(await tools(failed).t.call('vault_fill', { itemId: ITEM, sessionId: 'vs_1', tabId: 'tab_1', origin: ORIGIN })))
  assert.deepEqual(r2, { filled: false, reason: 'sign_in_failed' })
})

test('refresh tells Claude Code when the served list changed', async () => {
  let online = false
  const b = backend()
  const post = b.http.post
  b.http.post = async (path: string, body: any) => {
    if (path === 'integrations/browser/mcp' && !online) throw new HttpError(409, JSON.stringify({ code: 'host_offline' }))
    return post(path, body)
  }
  const { t, changed } = tools(b)
  await t.list()
  await t.refresh()
  assert.equal(changed.length, 0, 'nothing changed')
  online = true
  await t.refresh()
  assert.equal(changed.length, 1)
  assert.ok((await t.list()).some((tool: any) => tool.name === 'browser_navigate'))
})
