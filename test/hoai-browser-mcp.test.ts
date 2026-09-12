/**
 * The hoai-browser stdio shim: offline it serves exactly one honest status
 * tool; with a discovery file pointing at a fake endpoint it proxies the
 * roster. Pure node:test, no bun.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHIM = join(process.cwd(), 'bin', 'hoai-browser-mcp.mjs')

function client(home: string) {
  // Blank every relay variable: these two cases are about the LOCAL and
  // OFFLINE doors, and a developer whose own shell carries real HOAI_RELAY_*
  // values would otherwise put the shim in relay mode and change what they
  // assert (the relay door has its own file, hoai-browser-mcp.relay.test.ts).
  const env = {
    ...process.env,
    HOAI_HOME: home,
    HOAI_RELAY_BACKEND_URL: '',
    HOAI_RELAY_PAIRING_TOKEN: '',
    HOAI_RELAY_API_KEY: '',
    HOAI_RELAY_ASSISTANT_ID: '',
  }
  const child = spawn(process.execPath, [SHIM], { env, stdio: ['pipe', 'pipe', 'ignore'] })
  let buf = ''
  const pending = new Map<string | number, (msg: any) => void>()
  const notifications: any[] = []
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let i
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
    new Promise<any>((resolve) => {
      const msgId = ++id
      pending.set(msgId, resolve)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msgId, method, params }) + '\n')
    })
  const notify = (method: string, params: any = {}) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  return { request, notify, notifications, close: () => child.kill() }
}

test('offline: initialize works and the only tool says the app is not running', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hoai-shim-offline-'))
  const c = client(home)
  const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'test' } })
  assert.equal(init.result.serverInfo.name, 'hoai-agent-browser')
  assert.match(init.result.instructions, /default browser/i)
  c.notify('notifications/initialized')
  const list = await c.request('tools/list')
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ['hoai_browser_status'])
  const call = await c.request('tools/call', { name: 'hoai_browser_status', arguments: {} })
  assert.match(call.result.content[0].text, /not running/)
  assert.equal(call.result.isError, false)
  const other = await c.request('tools/call', { name: 'browser_navigate', arguments: { url: 'https://x' } })
  assert.equal(other.result.isError, true)
  c.close()
})

test('online: the shim proxies initialize, tools/list and tools/call to the endpoint with the bearer token', async () => {
  const seen: any[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const msg = JSON.parse(body)
      seen.push({ auth: req.headers.authorization, method: msg.method, session: req.headers['mcp-session-id'] })
      res.setHeader('content-type', 'application/json')
      res.setHeader('mcp-session-id', 'sess-1')
      if (msg.method === 'initialize') return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hoai-agent-browser', version: '5.0.0' }, instructions: 'This is your DEFAULT browser.' } }))
      if (!msg.id) { res.statusCode = 202; return res.end() }
      if (msg.method === 'tools/list') return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'hoai_browser_open_session', inputSchema: { type: 'object' } }, { name: 'browser_navigate', inputSchema: { type: 'object' } }] } }))
      if (msg.method === 'tools/call') return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `called ${msg.params.name}` }] } }))
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as any).port
  const home = mkdtempSync(join(tmpdir(), 'hoai-shim-online-'))
  mkdirSync(join(home, '.hoai'), { recursive: true })
  writeFileSync(join(home, '.hoai', 'agent-browser.json'), JSON.stringify({ version: 1, url: `http://127.0.0.1:${port}/mcp`, token: 'tok-123', pid: 1 }))
  const c = client(home)
  const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex', version: 'test' } })
  assert.match(init.result.instructions, /DEFAULT browser/)
  c.notify('notifications/initialized')
  const list = await c.request('tools/list')
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ['hoai_browser_open_session', 'browser_navigate'])
  const call = await c.request('tools/call', { name: 'browser_navigate', arguments: { url: 'http://127.0.0.1/' } })
  assert.equal(call.result.content[0].text, 'called browser_navigate')
  assert.ok(seen.every((s) => s.auth === 'Bearer tok-123'), 'every upstream request carries the token')
  assert.ok(seen.some((s) => s.method === 'tools/call' && s.session === 'sess-1'), 'the upstream session id is reused')
  c.close()
  server.close()
})
