/**
 * What the browser shim tells the agent about WHOSE browser it reaches on a
 * share recipient's turn (shared agents Phase 0, item 0.2; BGOS
 * docs/reports/2026-10-14-shared-agents-review PLAN.md and MATRIX M8.15; KC's
 * decision D3, msg 123216: a recipient may browse on the agent's own host,
 * never on the owner's HOAI desktop app).
 *
 * THE DEFECT. On a recipient's turn the shim told the agent the owner's
 * story: offline, "your owner's Home of Agents desktop app is not running ...
 * Ask them to open Home of Agents"; online, nothing about whose browser it
 * was, while its own comment claimed a shared agent's page never runs on the
 * owner's machine (a daemon placed agent's own host does exactly that, and is
 * allowed to).
 *
 * WHAT THESE TESTS HOLD, against the real shim process with a signed managed
 * context (the same rig as the managed context suite):
 *   - on a recipient's turn the status line says the browser is the agent's
 *     own host or the recipient's own desktop app, never the owner's desktop
 *     app, and the offline text (absent host, or a relay host_offline) says
 *     the same and asks THEM to open their app;
 *   - on the owner's own turn every one of those texts is what it was.
 *
 * Run with: npx tsx --test test/hoai-browser-mcp.recipient-host.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHIM = join(process.cwd(), 'bin', 'hoai-browser-mcp.mjs')
const SECRET = 'recipient-host-fixture-pairing'
const OWNER = 'user_owner'
const RECIPIENT = 'user_recipient_a'
const OWNER_OFFLINE_TEXT =
  "The HOAI Agent Browser is not available: your owner's Home of Agents desktop app is not running or not signed in, and there is no desktop app on this machine. Ask them to open Home of Agents on their computer (Cmd or Ctrl+Shift+B opens the Agent Browser); the browser tools appear here as soon as it is online."

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function rig(t: any, { actor, online = true, callStatus = 200, callCode = 'host_offline' }: { actor: string; online?: boolean; callStatus?: number; callCode?: string }) {
  const home = mkdtempSync(join(tmpdir(), 'hoai-recipient-host-'))
  const contextFile = join(home, 'context.json')
  const markerFile = join(home, 'marker.json')
  const server = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    const body = text ? JSON.parse(text) : null
    const answer = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (String(req.url).startsWith('/api/v1/integrations/browser/host')) return answer(200, { online, hostLabel: 'Synthetic host' })
    const msg = body?.message
    if (msg?.method === 'tools/call' && callStatus !== 200) {
      return answer(callStatus, { code: callCode, message: 'No browser host answered for this person.' })
    }
    const result = msg?.method === 'initialize' ? { instructions: 'Relay fixture' }
      : msg?.method === 'tools/list' ? { tools: [{ name: 'hoai_browser_status' }] }
        : { content: [{ type: 'text', text: 'Browser ready.' }] }
    return answer(201, { status: 'done', message: { jsonrpc: '2.0', id: msg?.id, result } })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(server.address() as any).port}`
  const context = { schemaVersion: 1, assistantId: '42', ownerUserId: OWNER, actingUserId: actor, chatId: '11', turnId: 'turn-a', sessionId: 'claude-session', claudePid: process.pid, pid: process.pid, updatedAt: Date.now(), live: true, markerPath: markerFile, promptHash: 'a'.repeat(64) }
  writeFileSync(markerFile, JSON.stringify({ schemaVersion: 1, turnId: context.turnId, sessionId: context.sessionId, promptHash: context.promptHash, live: true }))
  writeFileSync(contextFile, JSON.stringify({ context, signature: createHmac('sha256', SECRET).update(JSON.stringify(context)).digest('hex') }))
  // Nothing HOAI shaped is inherited from the shell: only what this rig sets.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HOAI_')))
  const env: Record<string, string | undefined> = {
    ...inherited, HOAI_HOME: home, HOAI_RELAY_BACKEND_URL: url, HOAI_RELAY_ASSISTANT_ID: '42', HOAI_RELAY_PAIRING_TOKEN: SECRET,
    HOAI_RELAY_API_KEY: '', HOAI_RELAY_PROBE_MS: '600000', HOAI_RELAY_CONTEXT_FILE: contextFile, HOAI_RELAY_OWNER_USER_ID: OWNER,
    HOAI_RELAY_CLIENT_PID: String(process.pid),
  }
  const child = spawn(process.execPath, [SHIM], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const responses: any[] = []
  let buffer = ''
  child.stdout.on('data', (data) => {
    buffer += data
    const lines = buffer.split('\n')
    buffer = lines.pop()!
    for (const line of lines.filter(Boolean)) responses.push(JSON.parse(line))
  })
  let nextId = 1
  const request = async (method: string, params: unknown) => {
    const id = nextId++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    for (let i = 0; i < 500 && !responses.some((r) => r.id === id); i++) await wait(10)
    const found = responses.find((r) => r.id === id)
    assert.ok(found, `no answer to ${method}`)
    return found
  }
  t.after(async () => {
    if (child.exitCode === null) { const exit = new Promise((r) => child.once('exit', r)); child.kill(); await exit }
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
    assert.ok(resolve(home).startsWith(resolve(tmpdir())))
    rmSync(home, { recursive: true, force: true })
  })
  const status = async () => (await request('tools/call', { name: 'hoai_browser_status', arguments: {} })).result
  return { request, status }
}

const texts = (result: any): string[] => (result?.content ?? []).map((c: any) => c.text)
const NEVER_OWNER_DESKTOP = /never on the owner's desktop app/
const AGENT_HOST_OR_THEIRS = /this agent's own host or on their own Home of Agents desktop app/

test("on a recipient turn the status line says whose browser it is: the agent host or their desktop, never the owner's", async (t) => {
  const r = await rig(t, { actor: RECIPIENT })
  const result = await r.status()
  assert.equal(result.isError, undefined)
  const said = texts(result).join('\n')
  assert.match(said, /Reached on Synthetic host\./)
  assert.match(said, AGENT_HOST_OR_THEIRS)
  assert.match(said, NEVER_OWNER_DESKTOP)
})

test('on the owner turn the status line is what it was', async (t) => {
  const r = await rig(t, { actor: OWNER })
  const result = await r.status()
  assert.deepEqual(texts(result), ['Browser ready.', 'Reached on Synthetic host.'])
})

test("with no host online, a recipient is told their browser is offline and to open THEIR app, never the owner's", async (t) => {
  const r = await rig(t, { actor: RECIPIENT, online: false })
  const result = await r.status()
  const said = texts(result).join('\n')
  assert.match(said, AGENT_HOST_OR_THEIRS)
  assert.match(said, NEVER_OWNER_DESKTOP)
  assert.doesNotMatch(said, /your owner's Home of Agents desktop app is not running/)
  assert.match(said, /Ask them to open Home of Agents on their computer/)
  // A real browser call says the same.
  const call = (await r.request('tools/call', { name: 'browser_snapshot', arguments: {} })).result
  assert.equal(call.isError, true)
  assert.match(texts(call).join('\n'), NEVER_OWNER_DESKTOP)
})

test('a relay host_offline answer on a recipient turn gets the same words', async (t) => {
  const r = await rig(t, { actor: RECIPIENT, callStatus: 409 })
  const call = (await r.request('tools/call', { name: 'browser_snapshot', arguments: {} })).result
  assert.equal(call.isError, true)
  const said = texts(call).join('\n')
  assert.match(said, NEVER_OWNER_DESKTOP)
  assert.doesNotMatch(said, /your owner's Home of Agents desktop app is not running/)
})

test('with no host online, the owner turn keeps the owner text word for word', async (t) => {
  const offline = await rig(t, { actor: OWNER, online: false })
  assert.deepEqual(texts(await offline.status()), [OWNER_OFFLINE_TEXT])
  const relay409 = await rig(t, { actor: OWNER, callStatus: 409 })
  assert.deepEqual(texts((await relay409.request('tools/call', { name: 'browser_snapshot', arguments: {} })).result), [OWNER_OFFLINE_TEXT])
})

test('the shim no longer claims a shared agent page never runs on the owner machine', () => {
  const shim = readFileSync(SHIM, 'utf8')
  assert.doesNotMatch(shim, /for a shared agent the page does not run\s*\/\/\s*on the owner's machine at all/)
})

test("a host timeout on a recipient turn never blames the owner's desktop app; the owner turn keeps its words", async (t) => {
  const recipient = await rig(t, { actor: RECIPIENT, callStatus: 504, callCode: 'host_timeout' })
  const said = texts((await recipient.request('tools/call', { name: 'browser_snapshot', arguments: {} })).result).join('\n')
  assert.doesNotMatch(said, /The owner's desktop app did not answer/)
  assert.match(said, NEVER_OWNER_DESKTOP)
  assert.match(said, /did not answer the browser call within 50 seconds/)
  const owner = await rig(t, { actor: OWNER, callStatus: 504, callCode: 'host_timeout' })
  assert.match(texts((await owner.request('tools/call', { name: 'browser_snapshot', arguments: {} })).result).join('\n'), /^The owner's desktop app did not answer the browser call within 50 seconds\./)
})
