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
  LANE_VAULT_CALL_WAIT_MS,
  LANE_VAULT_FILL_RELAY_MS,
  LANE_VAULT_TOOLS,
  LaneBrowserRelay,
  LaneBrowserTools,
  LANE_VAULT_WAITING_SENTENCE,
} from '../lib/lane-browser.ts'
import { LANE_BROWSER_TOOL_NAMES } from '../lib/lane-policy.mjs'
import { LANE_ANSWER_NOT_SENTENCES, LANE_NOTICE_SENTENCES, singleFlight } from '../lib/lane-daemon.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  const polls = opts.polls ?? []
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
  assert.deepEqual(Object.keys((fill.inputSchema as any).properties).sort(), ['itemId', 'origin', 'requestId', 'sessionId', 'tabId'])
  assert.deepEqual((fill.inputSchema as any).required, ['itemId', 'sessionId', 'tabId', 'origin'], 'requestId is optional')
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
  assert.deepEqual(relayed.body.message.params.arguments, { ticket: TICKET, itemId: ITEM, sessionId: 'vs_1', tabId: 'tab_1', origin: ORIGIN })
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

/**
 * The browser tool list asks for the lane session as the boot does, at the
 * same moment (Claude lists the tools right after the daemon connects). Two
 * callers must share one mint: the ticket is single use, and the second
 * caller used to find it gone and end the lane on its first launch.
 */
test('ensureSession is single flight: concurrent callers share one mint', async () => {
  let mints = 0
  let release!: (v: boolean) => void
  const once = singleFlight(() => { mints += 1; return new Promise<boolean>((r) => { release = r }) })
  const a = once()
  const b = once()
  release(true)
  assert.deepEqual(await Promise.all([a, b]), [true, true])
  assert.equal(mints, 1)
  const c = once()
  release(false)
  assert.equal(await c, false)
  assert.equal(mints, 2, 'a later call mints again')
  const src = readFileSync(join(import.meta.dirname, '..', 'lane-server.ts'), 'utf8')
  assert.match(src, /const ensureSessionOnce = singleFlight\(ensureSessionNow\)/)
  assert.match(src, /async function ensureSession\(\): Promise<boolean> \{\n\s+if \(session && storedSessionUsable\(session, LANE, Date\.now\(\)\)\) return true\n\s+return ensureSessionOnce\(\)\n\}/)
})

test('the sentence a waiting fill posts is never taken for an answer at the next boot', () => {
  assert.ok(LANE_ANSWER_NOT_SENTENCES.includes(LANE_VAULT_WAITING_SENTENCE))
  for (const s of LANE_NOTICE_SENTENCES) assert.ok(LANE_ANSWER_NOT_SENTENCES.includes(s))
  const src = readFileSync(join(import.meta.dirname, '..', 'lane-server.ts'), 'utf8')
  assert.match(src, /laneHistoryAnsweredAfter\(after, d\.messageId, LANE_ANSWER_NOT_SENTENCES\)/)
})

/**
 * One vault_fill call never holds the turn for the owner's whole 10 minutes
 * (Claude Code's MCP tool timeout may cut it, and the turn sits blocked): it
 * waits about 50 s, then answers that it is still waiting, with the
 * requestId to call again with. The person is told once per request.
 */
test('a call waits at most about 50 s, then says to call again with the requestId; that call resumes the same request', async () => {
  const polls: any[] = Array.from({ length: 40 }, () => ({ status: 'waiting' }))
  const b = backend({ fill: { status: 'waiting', requestId: 'req-1', expiresAt: '2026-11-13T10:10:00Z' }, polls })
  const { t, told, now } = tools(b)
  const start = now()
  const args = { itemId: ITEM, sessionId: 'vs_1', tabId: 'tab_1', origin: ORIGIN }
  const first = await t.call('vault_fill', args)
  assert.equal(first.isError, undefined, 'not an error: still waiting')
  const said = JSON.parse(textOf(first))
  assert.deepEqual(Object.keys(said).sort(), ['filled', 'message', 'requestId', 'waiting'])
  assert.equal(said.filled, false)
  assert.equal(said.waiting, true)
  assert.equal(said.requestId, 'req-1')
  assert.match(said.message, /^Waiting for the owner to approve; call vault_fill again with requestId req-1 to continue\.$/)
  assert.ok(now() - start <= LANE_VAULT_CALL_WAIT_MS + 3_000, `held ${now() - start} ms`)
  assert.ok(LANE_VAULT_CALL_WAIT_MS <= 50_000)
  assert.deepEqual(told, [LANE_VAULT_WAITING_SENTENCE])
  assert.doesNotMatch(textOf(first), new RegExp(TICKET))
  // The owner answers; the next call resumes the same request: no new ask, nobody told again.
  polls.splice(0, polls.length, { status: 'ready', ticket: TICKET })
  const second = await t.call('vault_fill', { ...args, requestId: 'req-1' })
  assert.deepEqual(JSON.parse(textOf(second)), { filled: true })
  assert.equal(b.calls.filter((c) => c.path === `vault/lane/items/${ITEM}/fill`).length, 1, 'one fill request only')
  assert.deepEqual(told, [LANE_VAULT_WAITING_SENTENCE], 'told once')
  const relayed = b.calls.find((c) => c.body?.message?.params?.name === 'hoai_vault_fill')!
  assert.deepEqual(relayed.body.message.params.arguments, { ticket: TICKET, itemId: ITEM, sessionId: 'vs_1', tabId: 'tab_1', origin: ORIGIN })
})

test('a resumed call must name the same login, session, tab and origin as the request it resumes, and a usable requestId', async () => {
  const b = backend({ fill: { status: 'waiting', requestId: 'req-1', expiresAt: '2026-11-13T10:10:00Z' }, polls: Array.from({ length: 40 }, () => ({ status: 'waiting' })) })
  const { t } = tools(b)
  const args = { itemId: ITEM, sessionId: 'vs_1', tabId: 'tab_1', origin: ORIGIN }
  await t.call('vault_fill', args)
  const before = b.calls.length
  for (const changed of [{ tabId: 'tab_2' }, { sessionId: 'vs_2' }, { origin: 'https://other.example.com' }, { itemId: '3f1c3a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b' }]) {
    const r = await t.call('vault_fill', { ...args, ...changed, requestId: 'req-1' })
    assert.equal(r.isError, true, JSON.stringify(changed))
  }
  assert.equal((await t.call('vault_fill', { ...args, requestId: '../x' })).isError, true)
  assert.equal(b.calls.length, before, 'nothing asked for any of them')
})

test('M4 and H2: the host is told which login; an unconfirmed owner account reaches the person as the agreed sentence', async () => {
  const b = backend({ hostReceipt: { filled: false, reason: 'vault_owner_account_unconfirmed' } })
  const r = JSON.parse(textOf(await tools(b).t.call('vault_fill', { itemId: ITEM, sessionId: 'vs_1', tabId: 'tab_1', origin: ORIGIN })))
  assert.deepEqual(r, { filled: false, reason: 'vault_owner_account_unconfirmed', message: 'This computer has not confirmed your HOAI account yet. Open this agent\'s browser in HOAI on this computer, or pin this computer again.' })
})

/**
 * M3: the 50 s cap holds for the WHOLE vault_fill call: the first ask and
 * every poll are bounded by what is left of it. The fill through the relay
 * after the ticket has its own limit, written in the tool's description.
 */
test('M3: every request of one call is bounded by what is left of its 50 s; the relay fill has its own stated limit', async () => {
  const seen: Array<{ path: string; timeoutMs: number | undefined; at: number }> = []
  const b = backend({ fill: { status: 'waiting', requestId: 'req-1', expiresAt: '2026-11-13T10:10:00Z' }, polls: Array.from({ length: 40 }, () => ({ status: 'waiting' })) })
  let clock = Date.parse('2026-11-13T10:00:00Z')
  const http = {
    get: async (path: string, timeoutMs?: number) => { seen.push({ path, timeoutMs, at: clock }); return b.http.get(path) },
    post: async (path: string, body: any, timeoutMs?: number) => {
      seen.push({ path, timeoutMs, at: clock })
      if (path === `vault/lane/items/${ITEM}/fill`) clock += 20_000 // a slow first answer spends a part of the budget
      return b.http.post(path, body)
    },
  }
  const relayCalls: any[] = []
  const relay: any = { callTool: async (name: string, args: any, opts: any) => { relayCalls.push({ name, opts }); return { content: [{ type: 'text', text: '{"filled":true}' }] } } }
  const t = new LaneBrowserTools({ enabled: true, relay, http, sleep: async (ms) => { clock += ms }, now: () => clock, log: () => {}, tellPerson: async () => {}, onListChanged: () => {} })
  const start = clock
  const first = JSON.parse(textOf(await t.call('vault_fill', { itemId: ITEM, sessionId: 'vs_1', tabId: 'tab_1', origin: ORIGIN })))
  assert.equal(first.waiting, true)
  assert.ok(clock - start <= LANE_VAULT_CALL_WAIT_MS + 1, `the whole call took ${clock - start} ms`)
  for (const call of seen) {
    assert.ok(typeof call.timeoutMs === 'number' && call.timeoutMs > 0, `${call.path} bounded`)
    assert.ok(call.at + call.timeoutMs! <= start + LANE_VAULT_CALL_WAIT_MS, `${call.path} at ${call.at - start} ms may run ${call.timeoutMs} ms`)
  }
  // The fill after a ticket: its own limit, and the description says it.
  const ready = backend()
  const t2 = new LaneBrowserTools({ enabled: true, relay, http: ready.http, sleep: async () => {}, now: () => Date.now(), log: () => {}, tellPerson: async () => {}, onListChanged: () => {} })
  await t2.call('vault_fill', { itemId: ITEM, sessionId: 'vs_1', tabId: 'tab_1', origin: ORIGIN })
  assert.equal(relayCalls.at(-1).name, 'hoai_vault_fill')
  assert.equal(relayCalls.at(-1).opts?.totalMs, LANE_VAULT_FILL_RELAY_MS)
  assert.ok(LANE_VAULT_FILL_RELAY_MS <= 90_000)
  assert.match(LANE_VAULT_TOOLS[1]!.description ?? '', /fill itself[^.]*at most about 90 seconds/)
})
