// Real stdio child and disposable HTTP wire. No native browser or account.
// Port of the canonical HOAI shim.profile-runtime.test.js five-case contract.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingHttpHeaders } from 'node:http'

const SHIM = join(process.cwd(), 'bin', 'hoai-browser-mcp.mjs')
const secret = 'synthetic-profile-pairing'
type RpcId = string | number
interface Authority {
  profileId: string
  actingUserId: string
  assistantId: number
  endpointId: string
  bootId: string
  runtimeId: string
  sessionId: string
  writerEpoch: number
  revision: number
  contentKeyEpoch: number
  grantVersion: number
  keyFingerprint: string
}
interface Message {
  id?: RpcId
  method?: string
  params?: { name?: string; arguments?: Record<string, unknown>; requestId?: RpcId }
}
interface RequestBody {
  id?: RpcId
  message?: Message
  authority?: Authority
  assistantId?: number
  clientId?: string
}
interface Response {
  id?: RpcId
  result: { content: { type: string; text: string }[]; isError?: boolean }
}
interface Frame {
  path: string
  method: string | undefined
  actor: string
  body: RequestBody | null
  headers: IncomingHttpHeaders
}
interface Resolution {
  managed: boolean
  actingUserId: string
  assistantId: number
  profileId?: string
  state?: string
  authority?: Authority
}
interface FixtureState {
  managed: boolean
  writer: string
  invalid: ((value: Resolution) => Resolution) | null
  redirect: boolean
  oversized: boolean
  failed: boolean
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean) {
  for (let n = 0; n < 400; n++) { if (check()) return; await wait(10) }
  assert.fail('Profile shim fixture did not settle')
}

async function rig(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'hoai-profile-shim-'))
  const contextFile = join(home, 'context.json'), markerPath = join(home, 'marker.json')
  const frames: Frame[] = [], profiles = new Map<string, Authority>(), pending = new Map<RpcId | undefined, string>()
  const state: FixtureState = { managed: true, writer: 'active', invalid: null, redirect: false, oversized: false, failed: false }
  const endpointId = randomUUID()
  function authority(actor: string): Authority {
    let value = profiles.get(actor)
    if (!value) {
      value = { profileId: randomUUID(), actingUserId: actor, assistantId: 42, endpointId, bootId: 'fixture-boot', runtimeId: 'fixture-runtime', sessionId: 'fixture-session', writerEpoch: 1, revision: 0, contentKeyEpoch: 1, grantVersion: 1, keyFingerprint: 'a'.repeat(64) }
      profiles.set(actor, value)
    }
    return value
  }
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const part of req) chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(part))
    const body: RequestBody | null = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as RequestBody : null
    const actorHeader = req.headers['x-bgos-acting-user']
    const actor = typeof actorHeader === 'string' ? actorHeader : 'user_owner', pathname = req.url || ''
    frames.push({ path: pathname, method: req.method, actor, body, headers: req.headers })
    const answer = (value: unknown, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (pathname === '/api/v1/browser/profile-sync/rpc/resolve') {
      if (state.redirect) { res.writeHead(307, { Location: '/unexpected' }); res.end(); return }
      if (state.failed) return answer({ message: 'private server text' }, 403)
      let value: Resolution = state.managed
        ? { managed: true, actingUserId: actor, assistantId: 42, profileId: authority(actor).profileId, state: state.writer, ...(state.writer === 'active' ? { authority: authority(actor) } : {}) }
        : { managed: false, actingUserId: actor, assistantId: 42 }
      if (state.invalid) value = state.invalid(value)
      if (state.oversized) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value) + ' '.repeat(65 * 1024)); return }
      return answer(value)
    }
    if (pathname.startsWith('/api/v1/integrations/browser/host')) return answer({ online: true, hostLabel: 'Unmanaged fixture' })
    if (pathname.endsWith('/cancel')) return answer({ requested: true, rpcId: pathname.split('/').at(-2) })
    if (pathname.endsWith('/poll')) return answer({ status: 'pending', rpcId: pathname.split('/').at(-2), pollAfterMs: 25 })
    if (pathname === '/local') return answer({ jsonrpc: '2.0', id: body?.id, result: { tools: [{ name: 'local_trap' }] } })
    const message = body?.message
    if (message?.params?.name === 'held') { const rpcId = randomUUID(); pending.set(message.id, rpcId); return answer({ status: 'pending', rpcId, pollAfterMs: 25 }) }
    return answer({ status: 'done', message: { jsonrpc: '2.0', id: message?.id, result: message?.method === 'initialize' ? { instructions: 'Managed profile fixture' } : message?.method === 'tools/list' ? { tools: [{ name: 'browser_snapshot' }] } : { content: [{ type: 'text', text: 'exact profile result' }] } } })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  mkdirSync(join(home, '.hoai'))
  writeFileSync(join(home, '.hoai', 'agent-browser.json'), JSON.stringify({ url: origin + '/local', token: 'synthetic-local-trap' }))
  function publish(actor = 'user_recipient_a') {
    const context = { schemaVersion: 1, assistantId: '42', ownerUserId: 'user_owner', actingUserId: actor, chatId: '11', turnId: randomUUID(), sessionId: 'claude-fixture', claudePid: process.pid, pid: process.pid, updatedAt: Date.now(), live: true, markerPath, promptHash: 'b'.repeat(64) }
    writeFileSync(markerPath, JSON.stringify({ schemaVersion: 1, turnId: context.turnId, sessionId: context.sessionId, promptHash: context.promptHash, live: true }))
    writeFileSync(contextFile, JSON.stringify({ context, signature: createHmac('sha256', secret).update(JSON.stringify(context)).digest('hex') }))
  }
  publish()
  const child = spawn(process.execPath, [SHIM], { env: { ...process.env, HOAI_HOME: home, HOAI_RELAY_BACKEND_URL: origin, HOAI_RELAY_ASSISTANT_ID: '42', HOAI_RELAY_PAIRING_TOKEN: secret, HOAI_RELAY_API_KEY: '', HOAI_RELAY_PROFILE_SYNC: '1', HOAI_RELAY_CONTEXT_FILE: contextFile, HOAI_RELAY_OWNER_USER_ID: 'user_owner', HOAI_RELAY_CLIENT_PID: String(process.pid), HOAI_RELAY_PROBE_MS: '600000' }, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = '', next = 1, stderr = ''
  const responses: Response[] = []
  child.stdout.on('data', (data: Buffer) => { buffer += data.toString(); const lines = buffer.split('\n'); buffer = lines.pop() || ''; for (const line of lines.filter(Boolean)) responses.push(JSON.parse(line) as Response) })
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
  const send = (value: Message) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
  const request = async (method = 'tools/call', params: Message['params'] = { name: 'browser_snapshot', arguments: {} }) => {
    const id = next++; send({ id, method, params }); await until(() => responses.some(value => value.id === id))
    const response = responses.find(value => value.id === id); assert.ok(response); return response
  }
  t.after(async () => {
    if (child.exitCode === null) { const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill(); await exited }
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    rmSync(home, { recursive: true, force: true })
  })
  const lastFrame = () => { const value = frames.at(-1); assert.ok(value); return value }
  return { frames, state, request, send, publish, responses, authority, pending, lastFrame, stderr: () => stderr }
}

test('managed profile resolves fresh actor authority and uses typed HTTP without local or legacy election', async t => {
  const f = await rig(t); assert.equal((await f.request()).result.content[0].text, 'exact profile result')
  assert.equal(f.frames.filter(frame => frame.body?.message?.method === 'tools/call').length, 1)
  assert.ok(f.frames.every(frame => frame.path.startsWith('/api/v1/browser/profile-sync/rpc/') && frame.actor === 'user_recipient_a'))
  for (const frame of f.frames) { assert.equal(frame.headers.authorization, undefined); assert.equal(frame.headers['x-api-key'], undefined); if (frame.body?.message) { assert.deepEqual(frame.body.authority, f.authority('user_recipient_a')); assert.equal(frame.body.assistantId, 42) } }
  const count = f.frames.filter(frame => frame.path.endsWith('/resolve')).length; await f.request(); assert.equal(f.frames.filter(frame => frame.path.endsWith('/resolve')).length, count + 1)
  f.publish('user_recipient_b'); await f.request(); assert.deepEqual(f.lastFrame().body?.authority, f.authority('user_recipient_b')); assert.equal(f.lastFrame().actor, 'user_recipient_b'); assert.equal(f.stderr(), '')
})

test('idle and every stopped or fenced managed state refuses without command, local fallback or legacy host selection', async t => {
  const f = await rig(t)
  // Each state is said as its browser_profile_* code and one sentence (0.72.0, mission 173); the words are pinned in
  // test/hoai-browser-mcp.refusals.test.ts.
  const codes: Record<string, string> = { idle: 'setup_required', stopped: 'restart_review_required', staged: 'restart_review_required', quiescing: 'closing', fenced: 'recovery_required' }
  for (const writer of ['idle', 'stopped', 'staged', 'quiescing', 'fenced']) { f.state.writer = writer; const result = await f.request(); assert.equal(result.result.isError, true); assert.match(result.result.content[0].text, new RegExp(`^browser_profile_${codes[writer]}: `)) }
  assert.ok(f.frames.every(frame => frame.path.endsWith('/resolve')))
})

test('only explicit fresh unmanaged resolution allows legacy and a known namespace never downgrades', async t => {
  const f = await rig(t); f.state.managed = false; await f.request(); assert.ok(f.frames.some(frame => frame.path === '/api/v1/integrations/browser/mcp'))
  f.state.managed = true; await f.request(); const count = f.frames.filter(frame => frame.path.startsWith('/api/v1/integrations/')).length
  f.state.managed = false; assert.equal((await f.request()).result.isError, true); assert.equal(f.frames.filter(frame => frame.path.startsWith('/api/v1/integrations/')).length, count); assert.ok(!f.frames.some(frame => frame.path === '/local'))
})

test('wrong actor, malformed authority, rejected discovery, redirects and oversized metadata never select another browser', async t => {
  const f = await rig(t)
  const invalids: ((value: Resolution) => Resolution)[] = [
    value => ({ ...value, actingUserId: 'user_sharer' }),
    value => ({ ...value, authority: { ...f.authority('user_recipient_a'), ...value.authority, actingUserId: 'user_sharer' } }),
    value => ({ ...value, authority: { ...f.authority('user_recipient_a'), ...value.authority, grantVersion: 0 } }),
    value => ({ ...value, authority: { ...f.authority('user_recipient_a'), ...value.authority, profileId: randomUUID() } }),
    value => ({ ...value, injected: true }),
  ]
  for (const invalid of invalids) { f.state.invalid = invalid; assert.equal((await f.request()).result.isError, true) }
  f.state.invalid = null
  for (const key of ['failed', 'redirect', 'oversized'] as const) { f.state[key] = true; const result = await f.request(); assert.equal(result.result.isError, true); assert.ok(!JSON.stringify(result).includes('private server text')); f.state[key] = false }
  assert.ok(f.frames.every(frame => frame.path.endsWith('/resolve')))
})

test('pending poll and cancellation retain the original exact actor, client and authority after another person\'s turn', async t => {
  const f = await rig(t); f.send({ id: 'held-a', method: 'tools/call', params: { name: 'held', arguments: {} } })
  await until(() => f.frames.some(frame => frame.path.endsWith('/poll')))
  const original = f.frames.find(frame => frame.body?.message?.id === 'held-a'); assert.ok(original?.body)
  f.publish('user_recipient_b'); f.send({ method: 'notifications/cancelled', params: { requestId: 'held-a' } }); await until(() => f.frames.some(frame => frame.path.endsWith('/cancel')))
  const cancellation = f.frames.find(frame => frame.path.endsWith('/cancel')); assert.ok(cancellation?.body)
  assert.equal(cancellation.actor, 'user_recipient_a'); assert.equal(cancellation.body.clientId, original.body.clientId); assert.deepEqual(cancellation.body.authority, original.body.authority)
  await f.request(); assert.equal(f.lastFrame().actor, 'user_recipient_b'); assert.equal(f.frames.filter(frame => frame.body?.message?.id === 'held-a').length, 1); assert.equal(f.responses.some(value => value.id === 'held-a'), false); assert.equal(f.stderr(), '')
})
