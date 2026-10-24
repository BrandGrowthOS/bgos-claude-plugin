/**
 * After a session restart the agent's browser tools appear within seconds, not a minute (board row 94c6a3fb).
 *
 * THE DEFECT (measured 10-22, worker stopbrowse). A managed shim (HOAI_RELAY_CONTEXT_FILE set) refuses a turn context
 * whose live is not true, and a refused context is offline mode: tools/list serves hoai_browser_status alone. A
 * restarted session's shim starts between turns, so its initialize and first tools/list meet a context that is not
 * live. The tools came back only when the 20 s host probe (RELAY_PROBE_MS) happened to resolve a live context, and
 * notifications/tools/list_changed fired only on that mode change: app connected at 3.15 s, list_changed at 60.24 s.
 * For up to a minute the agent saw one status tool.
 *
 * THE FIX. While the last answer was a refused context, the shim reads its context file every second (a local read,
 * no request) and resolves the moment the context turns valid, so list_changed fires as the turn goes live. These
 * tests hold the gap under 10 s with the probe at its default, and hold that the watch costs the backend nothing while
 * the context stays refused and one attempt per turn when the host is offline.
 *
 * Real shim process, disposable HTTP backend, no browser, no account.
 * Run with: npx tsx --test test/hoai-browser-mcp.live-context.test.ts
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHIM = join(process.cwd(), 'bin', 'hoai-browser-mcp.mjs')
const SECRET = 'live-context-fixture-pairing'
const OWNER = 'user_owner'
const LIMIT_MS = 10_000

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Frame { method: string, url: string, at: number, rpc: string | null }
interface Message { id?: number | string, method?: string, result?: any, error?: any }

async function rig(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'hoai-live-context-'))
  mkdirSync(join(home, '.hoai'))
  const contextFile = join(home, 'context.json')
  const markerFile = join(home, 'marker.json')
  const state = { hostOnline: false }
  const seen: Frame[] = []
  const server = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    const body = text ? JSON.parse(text) : null
    const msg = body?.message
    seen.push({ method: req.method ?? '', url: req.url ?? '', at: Date.now(), rpc: msg?.method ?? null })
    const answer = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.url?.startsWith('/api/v1/integrations/browser/host')) return answer(200, { online: state.hostOnline, hostLabel: 'Synthetic desktop' })
    if (!state.hostOnline) return answer(409, { code: 'host_offline' })
    const result = msg?.method === 'initialize' ? { instructions: 'Relay fixture' } : msg?.method === 'tools/list' ? { tools: [{ name: 'browser_snapshot', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: 'Synthetic result' }] }
    return answer(201, { status: 'done', message: msg?.id === undefined ? {} : { jsonrpc: '2.0', id: msg.id, result } })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  let turn = 0
  // The daemon's signed turn context. live: false is what a restarted session meets before its first turn.
  function publish(live: boolean) {
    const turnId = `turn-${++turn}`
    const context = { schemaVersion: 1, assistantId: '42', ownerUserId: OWNER, actingUserId: OWNER, chatId: '11', turnId, sessionId: 'claude-session', claudePid: process.pid, pid: process.pid, updatedAt: Date.now(), live, markerPath: markerFile, promptHash: 'a'.repeat(64) }
    writeFileSync(markerFile, JSON.stringify({ schemaVersion: 1, turnId, sessionId: context.sessionId, promptHash: context.promptHash, live }))
    writeFileSync(contextFile, JSON.stringify({ context, signature: createHmac('sha256', SECRET).update(JSON.stringify(context)).digest('hex') }))
  }
  publish(false)

  const env: NodeJS.ProcessEnv = { ...process.env, HOAI_HOME: home, HOAI_RELAY_BACKEND_URL: `http://127.0.0.1:${port}`, HOAI_RELAY_ASSISTANT_ID: '42', HOAI_RELAY_PAIRING_TOKEN: SECRET, HOAI_RELAY_CONTEXT_FILE: contextFile, HOAI_RELAY_OWNER_USER_ID: OWNER, HOAI_RELAY_CLIENT_PID: String(process.pid) }
  // The probe and the watch at their defaults: the gap is measured as an agent meets it.
  for (const key of ['HOAI_RELAY_API_KEY', 'HOAI_RELAY_PROBE_MS', 'HOAI_RELAY_CONTEXT_WATCH_MS', 'HOAI_RELAY_PROFILE_SYNC']) delete env[key]
  const child = spawn(process.execPath, [SHIM], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const messages: Array<Message & { at: number }> = []
  let buffer = ''
  let stderr = ''
  child.stdout.on('data', (data) => {
    buffer += data
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines.filter(Boolean)) messages.push({ ...JSON.parse(line), at: Date.now() })
  })
  child.stderr.on('data', (data) => { stderr += data })
  t.after(async () => {
    if (child.exitCode === null) { const exit = new Promise((resolve) => child.once('exit', resolve)); child.kill(); await exit }
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    rmSync(home, { recursive: true, force: true })
  })

  let nextId = 1
  async function request(method: string, params: unknown = {}) {
    const id = nextId++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    for (let i = 0; i < 1500 && !messages.some((m) => m.id === id); i++) await wait(10)
    const found = messages.find((m) => m.id === id)
    assert.ok(found, `no answer to ${method}`)
    return found
  }
  const listChanged = (after: number) => messages.find((m) => m.method === 'notifications/tools/list_changed' && m.at >= after)
  const toolNames = async () => ((await request('tools/list')).result?.tools ?? []).map((tool: { name: string }) => tool.name)
  return { state, seen, publish, request, listChanged, toolNames, stderr: () => stderr }
}

test('after a restart, the tools are listed within 10 s of the turn going live (list_changed), not on the next 20 s probe', async (t) => {
  const r = await rig(t)
  const started = Date.now()
  await r.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'fixture' } })
  assert.deepEqual(await r.toolNames(), ['hoai_browser_status'], 'between turns a managed shim serves the status tool alone')
  // The desktop app connects (3.15 s in the field), then the restarted session's first turn goes live.
  await wait(1_000)
  r.state.hostOnline = true
  await wait(2_000)
  r.publish(true)
  const live = Date.now()
  let notice = r.listChanged(live)
  while (!notice && Date.now() - live < 25_000) { await wait(50); notice = r.listChanged(live) }
  const gap = notice ? notice.at - live : null
  t.diagnostic(`turn live to list_changed: ${gap === null ? 'none in 25000' : gap} ms`)
  assert.ok(gap !== null && gap < LIMIT_MS, `list_changed must follow the live turn within ${LIMIT_MS} ms; it took ${gap === null ? 'over 25000 ms' : `${gap} ms`} (${Date.now() - started} ms after start)`)
  assert.deepEqual(await r.toolNames(), ['browser_snapshot'], 'the refreshed list is the browser\'s own tools')
  assert.equal(r.stderr(), '')
})

test('the watch costs the backend nothing while the context stays refused, and one attempt per turn while the host is offline', async (t) => {
  const r = await rig(t)
  await r.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'fixture' } })
  assert.deepEqual(await r.toolNames(), ['hoai_browser_status'])
  await wait(3_000)
  assert.equal(r.seen.length, 0, 'a context that is not live never reaches the backend')
  // The turn goes live with no desktop app online: one host probe, then quiet until the 20 s probe.
  r.publish(true)
  await wait(3_500)
  assert.equal(r.seen.filter((frame) => frame.url.startsWith('/api/v1/integrations/browser/host')).length, 1, JSON.stringify(r.seen))
  assert.equal(r.seen.filter((frame) => frame.rpc !== null).length, 0, 'no initialize is sent to a host that is offline')
  assert.equal(r.listChanged(0), undefined, 'still offline, so the list did not change')
  assert.equal((await r.request('tools/call', { name: 'browser_snapshot', arguments: {} })).result?.isError, true, 'the offline refusal is unchanged')
  assert.equal(r.stderr(), '')
})

test('a context that turns live and then stops being live keeps the refusal for the next call', async (t) => {
  const r = await rig(t)
  r.state.hostOnline = true
  await r.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'fixture' } })
  r.publish(true)
  const live = Date.now()
  while (!r.listChanged(live) && Date.now() - live < LIMIT_MS) await wait(50)
  assert.ok(r.listChanged(live), 'list_changed followed the live turn')
  r.publish(false)
  const refused = await r.request('tools/call', { name: 'browser_snapshot', arguments: {} })
  assert.equal(refused.result?.isError, true)
  assert.match(refused.result.content[0].text, /current sender could not be verified/)
  assert.equal(r.stderr(), '')
})
