/**
 * What the browser shim tells an agent when its browser refuses, and what it never asks it (BGOS mission 173,
 * plugin 0.72.0).
 *
 * THE DEFECT (phase 1 RC4). The managed profile fence answers 409 browser_profile_authority_required while the
 * owner's desktop app is connected, and the desktop's own admission answers browser_profile_setup_required. The
 * 0.71.x shim knew neither: it mapped every unknown 409 to host_offline, so the agent was told "your owner's Home of
 * Agents desktop app is not running or not signed in" by a desktop that was open, and the desktop's refusal reached
 * it as a bare tool_error. Separately, every host offered the agent a profile question ("profile: preview or
 * signed-in", preview by default) that KC ruled out on 2026-10-19: one browser per agent, and an agent opens its own.
 *
 * WHAT THESE TESTS HOLD, against the real shim process and a disposable HTTP backend (no browser, no account):
 *   - every browser_profile_* code the shim knows is answered with that code and ONE plain sentence, each code
 *     reached the way it arrives in the field (discovery, the legacy relay, the desktop's own tool refusal, the
 *     managed profile route), one test per code;
 *   - a 409 is host_offline only when the relay says host_offline; a connected desktop's 409 never says the app is
 *     not running;
 *   - profile requests carry the pairing header and nothing else that authenticates;
 *   - no tool text, schema or served instruction offers a preview default or a profile choice, and the open call
 *     opens the agent's own browser;
 *   - the signed turn context still gates the open call.
 *
 * Run with: npx tsx --test test/hoai-browser-mcp.refusals.test.ts
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SESSION_TOOLS } from '../bin/hoai-browser-host.mjs'

const SHIM = join(process.cwd(), 'bin', 'hoai-browser-mcp.mjs')
const SECRET = 'refusal-fixture-pairing'
const API_KEY = 'refusal-fixture-account-key'
const OWNER = 'user_owner'
const RECIPIENT = 'user_recipient_a'
const FALSE_OFFLINE = /not running|not signed in/

// The words, pinned. Changing one is a decision, not a refactor: the agent repeats them to a person.
const SENTENCES: Record<string, string> = {
  browser_profile_setup_required: 'Your owner has not set up your browser yet; a Set up card is in your chat.',
  browser_profile_restart_review_required: 'Your browser is closed and your owner needs to open it once in HOAI before you can use it again.',
  browser_profile_recovery_required: 'Your browser needs your owner to look at it in HOAI before it can open again, so nothing ran.',
  browser_profile_outcome_unknown: "HOAI could not confirm your browser's last change, so your owner needs to check your browser in HOAI before you use it again.",
  browser_profile_return_pending: 'Your browser is still moving back from another computer, so try again in a few minutes.',
  browser_profile_active_elsewhere: 'Your browser is open on another computer right now, so it can only be used there until it is closed.',
  browser_profile_stopped_local_only: 'Your browser closed but HOAI has not confirmed its last save yet, so your owner needs to open HOAI on that computer before you can use it.',
  browser_profile_closing: 'Your browser is closing and saving right now, so try again in a minute.',
  browser_profile_authority_required: 'Your browser is now a managed Agent Browser and this call came through an older route, so nothing ran; try once more, and if it repeats ask your owner to open your browser in HOAI.',
  browser_profile_managed: 'Your browser is now a managed Agent Browser and this call came through an older route, so nothing ran; try once more, and if it repeats ask your owner to open your browser in HOAI.',
  browser_profile_unavailable: 'Your browser could not be reached through HOAI just now, so nothing ran; try again in a moment, and if it repeats ask your owner to open your browser in HOAI.',
  browser_profile_unconfirmed: 'Your browser did not confirm this action, so it may have run; check the page with browser_snapshot before you repeat it.',
  browser_profile_storage_full: "Your browser's storage in HOAI is full, so nothing new was saved or opened; ask your owner to free space for it in HOAI.",
  browser_profile_close_blocked: 'Your browser could not close cleanly yet, so it is still open; try closing it again in a moment.',
  browser_profile_transition_absent: "HOAI could not find your browser's move between computers, so your owner needs to open your browser in HOAI to finish it.",
}
const UNKNOWN_SENTENCE = 'Your browser is not ready in HOAI, so nothing ran; ask your owner to open your browser in HOAI.'
const line = (code: string) => `${code}: ${SENTENCES[code] ?? UNKNOWN_SENTENCE}`

// The 5.21 desktop's session tools (frontend/electron-app/agent-browser/local-mcp.js SESSION_TOOLS and its managed
// variant, sessionToolsFor), copied as they ship: what an agent is served through the relay today.
const DESKTOP_OPEN = {
  name: 'hoai_browser_open_session',
  description: "Open your HOAI Agent Browser session for this task. Browser calls use this connection's assigned session; another agent's browser is separate. The owner can show your pane with the purpose you give. profile: preview (clean, wiped at close, localhost never asks) or signed-in (your own persistent profile: the logins the owner makes for you inside the pane and the sites they Always allow for you are remembered across your sessions and app restarts; asks per site). Returns the session state. Your owner asked you to check your UI changes: after you change a web page or app, open a session with verify: true and check it before you say done.",
  inputSchema: {
    type: 'object',
    properties: {
      purpose: { type: 'string', description: "One line the owner will read, e.g. 'Check the seat map on emirates.com'. Max 200 characters." },
      profile: { type: 'string', enum: ['preview', 'signed-in'], description: "Defaults to the owner's default profile (preview). signed-in needs a stable agent id; without one the session opens as a preview and says so." },
      caps: { type: 'array', items: { type: 'string', enum: ['vision', 'pdf'] }, description: 'Optional extra tool sets. vision only works when the owner enabled it.' },
      verify: { type: 'boolean', description: 'Check your UI change.' },
    },
    required: ['purpose'],
  },
}
const DESKTOP_CLOSE = { name: 'hoai_browser_close_session', description: 'Close the browser session (tabs close, a preview profile is wiped, a signed-in profile keeps its logins for next time). Call it when you are done.', inputSchema: { type: 'object', properties: {} } }
const DESKTOP_STATUS = { name: 'hoai_browser_status', description: 'Your assigned browser session state: who holds control (agent_driving, paused, human_control), the open tabs, the last steps and any pending permission gate.', inputSchema: { type: 'object', properties: {} } }
const MANAGED_OPEN = {
  ...DESKTOP_OPEN,
  description: "Use this connection's already authorized managed browser profile on the owner's desktop. Supply profile: signed-in and a short task purpose. This does not create a temporary profile, enable extra permissions or change profile authority. Preview and verify sessions are unavailable.",
  inputSchema: { ...DESKTOP_OPEN.inputSchema, properties: { ...DESKTOP_OPEN.inputSchema.properties, profile: { type: 'string', enum: ['signed-in'], description: 'Required: signed-in uses the existing managed profile. Preview and verify are unavailable on this connection.' } }, required: ['purpose', 'profile'] },
}
const CLICK = { name: 'browser_click', description: 'Perform click on a web page', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } }
// The 5.21 desktop's served instructions (agent-browser/instructions.js), the sentences that offer the choice and the
// ones beside them that must survive.
const DESKTOP_INSTRUCTIONS = `HOAI Agent Browser (Home of Agents desktop app). This is your DEFAULT browser.

Workflow:
1. hoai_browser_open_session with a one line purpose the owner will read, and profile "preview" (clean, wiped at close, localhost never asks) or "signed-in" (your own persistent profile, with the current session approval mode). Signed-in is per agent and remembered: the logins the owner makes for you inside the pane, and the sites they Always allow for you, are kept across your sessions and app restarts, so once the owner has signed you in to a site your next signed-in session finds you still signed in. If the reply says you got a preview instead, nothing will be remembered: tell the owner. If you skip this, a verified HOAI agent opens its own signed-in profile by default; an unverified local client opens a preview. An explicit preview or a verify session remains temporary.
2. browser_navigate to a URL, then browser_snapshot.

Permissions when Bypass approvals is off: a new site, any write on a signed-in site, downloads, uploads and every sensitive action show the owner a permission strip. Only an agent whose browser calls reach the owner's desktop app through BGOS can drive a shared tab: an agent connected straight to the desktop app's browser endpoint on the same computer cannot drive that shared tab and uses its own temporary preview browser.`
const MANAGED_INSTRUCTIONS = 'HOAI managed desktop browser. If needed, call hoai_browser_open_session with a short purpose and profile "signed-in" to use this already authorized managed profile.'

type Json = Record<string, any>
interface Frame { path: string; headers: IncomingHttpHeaders; body: Json | null }
interface Answer { status: number; body: Json }
interface Backend {
  /** /rpc/resolve: 'unmanaged', a writer state, or a whole answer. */
  resolve: 'unmanaged' | 'idle' | 'active' | 'stopped' | 'staged' | 'quiescing' | 'fenced' | Answer
  online: boolean
  instructions: string
  tools: Json[]
  /** The answer to a tools/call, on whichever route it arrives. */
  call: (message: Json) => Answer | null
  /** The answer to the shim's own initialize, when it is not the ordinary one. */
  init: ((message: Json) => Answer) | null
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, what: string) {
  for (let n = 0; n < 500; n++) { if (check()) return; await wait(10) }
  assert.fail(`the shim fixture did not settle: ${what}`)
}
const done = (message: Json, result: Json): Answer => ({ status: 201, body: { status: 'done', message: { jsonrpc: '2.0', id: message.id, result } } })
const toolError = (text: string) => (message: Json) => done(message, { content: [{ type: 'text', text }], isError: true })
const refuse = (status: number, body: Json) => () => ({ status, body })

async function rig(t: TestContext, options: { actor?: string; profileSync?: boolean; apiKey?: boolean; managedContext?: boolean; local?: boolean; setup?: (backend: Backend) => void } = {}) {
  const { actor = OWNER, profileSync = true, apiKey = false, managedContext = true, local = false, setup } = options
  const home = mkdtempSync(join(tmpdir(), 'hoai-refusals-'))
  const contextFile = join(home, 'context.json'), markerFile = join(home, 'marker.json')
  const frames: Frame[] = []
  const backend: Backend = { resolve: 'unmanaged', online: true, instructions: DESKTOP_INSTRUCTIONS, tools: [DESKTOP_OPEN, DESKTOP_CLOSE, DESKTOP_STATUS, CLICK], call: message => done(message, { content: [{ type: 'text', text: 'Browser ready.' }] }), init: null }
  setup?.(backend)
  const authority = (who: string) => ({ profileId: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', actingUserId: who, assistantId: 42, endpointId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', bootId: 'fixture-boot', runtimeId: 'fixture-runtime', sessionId: 'fixture-session', writerEpoch: 1, revision: 0, contentKeyEpoch: 1, grantVersion: 1, keyFingerprint: 'a'.repeat(64) })
  const answerTo = (message: Json): Answer => {
    if (message.method === 'initialize') return backend.init?.(message) ?? done(message, { instructions: backend.instructions })
    if (message.method === 'notifications/initialized') return { status: 201, body: { status: 'done', message: {} } }
    if (message.method === 'tools/list') return done(message, { tools: structuredClone(backend.tools) })
    return backend.call(message) ?? done(message, { content: [{ type: 'text', text: 'Browser ready.' }] })
  }
  const server = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    const body = text ? JSON.parse(text) as Json : null
    const path = String(req.url)
    frames.push({ path, headers: req.headers, body })
    const answer = ({ status, body: value }: Answer) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    const who = typeof req.headers['x-bgos-acting-user'] === 'string' ? req.headers['x-bgos-acting-user'] : OWNER
    if (path === '/api/v1/browser/profile-sync/rpc/resolve') {
      const r = backend.resolve
      if (typeof r === 'object') return answer(r)
      if (r === 'unmanaged') return answer({ status: 201, body: { managed: false, actingUserId: who, assistantId: 42 } })
      return answer({ status: 201, body: { managed: true, actingUserId: who, assistantId: 42, profileId: authority(who).profileId, state: r, ...(r === 'active' ? { authority: authority(who) } : {}) } })
    }
    if (path === '/api/v1/browser/profile-sync/rpc/call') return answer(answerTo(body?.message ?? {}))
    if (path.startsWith('/api/v1/integrations/browser/host')) return answer({ status: 200, body: { online: backend.online, hostLabel: 'Fixture desktop' } })
    if (path === '/api/v1/integrations/browser/mcp') return answer(answerTo(body?.message ?? {}))
    if (path === '/local') {
      const message = body ?? {}
      const result = answerTo(message).body.message?.result ?? {}
      res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'local-session' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      return
    }
    return answer({ status: 404, body: { message: 'no such fixture route' } })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  const publish = (who: string) => {
    const context = { schemaVersion: 1, assistantId: '42', ownerUserId: OWNER, actingUserId: who, chatId: '11', turnId: randomUUID(), sessionId: 'claude-fixture', claudePid: process.pid, pid: process.pid, updatedAt: Date.now(), live: true, markerPath: markerFile, promptHash: 'b'.repeat(64) }
    writeFileSync(markerFile, JSON.stringify({ schemaVersion: 1, turnId: context.turnId, sessionId: context.sessionId, promptHash: context.promptHash, live: true }))
    writeFileSync(contextFile, JSON.stringify({ context, signature: createHmac('sha256', SECRET).update(JSON.stringify(context)).digest('hex') }))
  }
  if (managedContext) publish(actor)
  if (local) {
    mkdirSync(join(home, '.hoai'))
    writeFileSync(join(home, '.hoai', 'agent-browser.json'), JSON.stringify({ url: origin + '/local', token: 'fixture-local-token' }))
  }
  // Nothing HOAI shaped is inherited from the shell: only what this rig sets.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HOAI_')))
  const env: Record<string, string> = {
    ...inherited as Record<string, string>, HOAI_HOME: home, HOAI_RELAY_PROBE_MS: '600000',
    ...(local ? {} : { HOAI_RELAY_BACKEND_URL: origin, HOAI_RELAY_ASSISTANT_ID: '42', HOAI_RELAY_PAIRING_TOKEN: SECRET, HOAI_RELAY_API_KEY: apiKey ? API_KEY : '' }),
    ...(apiKey ? { BGOS_API_KEY: API_KEY } : {}),
    ...(profileSync && !local ? { HOAI_RELAY_PROFILE_SYNC: '1' } : {}),
    ...(local ? {} : { HOAI_RELAY_CONTEXT_FILE: contextFile, HOAI_RELAY_OWNER_USER_ID: OWNER, HOAI_RELAY_CLIENT_PID: String(process.pid) }),
  }
  const child = spawn(process.execPath, [SHIM], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const responses: Json[] = []
  let buffer = '', next = 1
  child.stdout.on('data', (data: Buffer) => {
    buffer += data.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const raw of lines.filter(Boolean)) responses.push(JSON.parse(raw) as Json)
  })
  const request = async (method: string, params: Json = {}) => {
    const id = next++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    await until(() => responses.some(value => value.id === id), `${method} ${params.name ?? ''}`)
    return responses.find(value => value.id === id)!
  }
  const call = async (name = 'browser_snapshot', args: Json = {}) => (await request('tools/call', { name, arguments: args })).result
  t.after(async () => {
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited }
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    rmSync(home, { recursive: true, force: true })
  })
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'refusal-fixture', version: '1' } })
  return { backend, frames, request, call, publish }
}

const textOf = (result: Json) => (result?.content ?? []).filter((item: Json) => item.type === 'text').map((item: Json) => item.text).join('\n')

// ─── The words themselves ─────────────────────────────────────────────────────

test('the shim knows exactly the codes this suite pins, each with its sentence word for word', () => {
  const shim = readFileSync(SHIM, 'utf8')
  const block = /const PROFILE_REFUSAL_TEXT = \{([\s\S]*?)\n\};/.exec(shim)
  assert.ok(block, 'the shim keeps its refusal words in one table')
  const known = [...block[1].matchAll(/^\s*(browser_profile_[a-z0-9_]+):/gm)].map(match => match[1]).sort()
  assert.deepEqual(known, Object.keys(SENTENCES).sort(), 'a code in the shim with no test of its sentence here, or the reverse')
  for (const sentence of [...Object.values(SENTENCES), UNKNOWN_SENTENCE]) assert.ok(shim.includes(JSON.stringify(sentence)), `the shim says, word for word: ${sentence}`)
})

test('each sentence is one plain sentence: no dashes, no second sentence, no desktop blamed', () => {
  for (const [code, sentence] of Object.entries({ ...SENTENCES, unknown: UNKNOWN_SENTENCE })) {
    assert.match(sentence, /^[A-Z][^.!?]*\.$/, `${code}: one sentence, ending once`)
    assert.doesNotMatch(sentence, /[–—]/, `${code}: no em or en dash`)
    assert.doesNotMatch(sentence, FALSE_OFFLINE, `${code}: never that the desktop app is not running`)
    assert.doesNotMatch(sentence, /owner's/, `${code}: "your owner" is swapped on a recipient's turn, a possessive would not read`)
  }
})

// ─── One test per code, each reached the way it arrives ───────────────────────

test('browser_profile_setup_required: a managed profile that was never set up, and the desktop refusing an agent with no profile', async t => {
  const f = await rig(t, { setup: backend => { backend.resolve = 'idle' } })
  const result = await f.call()
  assert.equal(result.isError, true)
  assert.equal(textOf(result), line('browser_profile_setup_required'))
  assert.ok(!f.frames.some(frame => frame.path.includes('/integrations/') || frame.path.endsWith('/call')), 'nothing was sent to any browser')
  // The 5.21 desktop's admission, through the legacy relay, as the plain tool_error it sends today (RC4, "Moss").
  const g = await rig(t)
  g.backend.call = toolError('### Error\ntool_error: browser_profile_setup_required')
  assert.equal(textOf(await g.call()), line('browser_profile_setup_required'))
})

test('browser_profile_restart_review_required: a stopped or staged managed profile', async t => {
  const f = await rig(t)
  for (const state of ['stopped', 'staged'] as const) {
    f.backend.resolve = state
    assert.equal(textOf(await f.call()), line('browser_profile_restart_review_required'), state)
  }
  const g = await rig(t)
  g.backend.call = toolError('### Error\ntool_error: browser_profile_restart_review_required')
  assert.equal(textOf(await g.call()), line('browser_profile_restart_review_required'))
})

test('browser_profile_closing: a managed profile that is quiescing', async t => {
  const f = await rig(t)
  f.backend.resolve = 'quiescing'
  assert.equal(textOf(await f.call()), line('browser_profile_closing'))
})

test('browser_profile_recovery_required: a fenced managed profile, and the desktop asking for recovery', async t => {
  const f = await rig(t)
  f.backend.resolve = 'fenced'
  assert.equal(textOf(await f.call()), line('browser_profile_recovery_required'))
  const g = await rig(t)
  g.backend.call = toolError('### Error\ntool_error: browser_profile_recovery_required')
  assert.equal(textOf(await g.call()), line('browser_profile_recovery_required'))
})

test('browser_profile_outcome_unknown: the desktop could not confirm the last write', async t => {
  const f = await rig(t)
  f.backend.call = toolError('### Error\ntool_error: browser_profile_outcome_unknown')
  assert.equal(textOf(await f.call()), line('browser_profile_outcome_unknown'))
})

test('browser_profile_return_pending: the desktop is still taking the profile back', async t => {
  const f = await rig(t)
  f.backend.call = toolError('### Error\ntool_error: browser_profile_return_pending')
  assert.equal(textOf(await f.call()), line('browser_profile_return_pending'))
})

test('browser_profile_active_elsewhere: the profile is open on another machine', async t => {
  const f = await rig(t)
  f.backend.call = toolError('### Error\ntool_error: browser_profile_active_elsewhere')
  assert.equal(textOf(await f.call()), line('browser_profile_active_elsewhere'))
})

test('browser_profile_stopped_local_only: the desktop stopped it but the server has not confirmed the save', async t => {
  const f = await rig(t)
  f.backend.call = toolError('### Error\ntool_error: browser_profile_stopped_local_only')
  assert.equal(textOf(await f.call()), line('browser_profile_stopped_local_only'))
})

test('browser_profile_authority_required: the legacy fence (409) and the desktop, with the desktop connected', async t => {
  const f = await rig(t)
  f.backend.call = refuse(409, { statusCode: 409, code: 'browser_profile_authority_required', message: 'This browser profile requires current runtime authority. Use a current browser integration.' })
  const result = await f.call()
  assert.equal(result.isError, true)
  assert.equal(textOf(result), line('browser_profile_authority_required'))
  const g = await rig(t)
  g.backend.call = toolError("### Error\nbrowser_profile_authority_required: The browser profile's exact native runtime is unavailable.")
  assert.equal(textOf(await g.call()), line('browser_profile_authority_required'))
})

test("browser_profile_managed: this agent's own browser host refusing the legacy route (502 host_error carrying it)", async t => {
  const f = await rig(t)
  f.backend.call = refuse(502, { statusCode: 502, code: 'host_error', message: 'browser_profile_managed: This person has a managed browser profile. Use its exact typed HOAI route; a legacy browser was not opened.' })
  assert.equal(textOf(await f.call()), line('browser_profile_managed'))
})

test('browser_profile_unavailable: discovery refused without a code, and a desktop with no profile support', async t => {
  const f = await rig(t)
  f.backend.resolve = { status: 403, body: { statusCode: 403, message: 'private server text' } }
  const result = await f.call()
  assert.equal(textOf(result), line('browser_profile_unavailable'))
  assert.doesNotMatch(JSON.stringify(result), /private server text/)
  const g = await rig(t)
  g.backend.call = toolError('### Error\nbrowser_profile_unavailable: Browser profile setup is unavailable on this desktop.')
  assert.equal(textOf(await g.call()), line('browser_profile_unavailable'))
})

test('browser_profile_unconfirmed: the managed route did not confirm a sent call', async t => {
  const f = await rig(t)
  f.backend.resolve = 'active'
  f.backend.call = refuse(500, { statusCode: 500, message: 'Internal server error' })
  assert.equal(textOf(await f.call()), line('browser_profile_unconfirmed'))
})

test('browser_profile_storage_full: the managed route refusing with 507', async t => {
  const f = await rig(t)
  f.backend.resolve = 'active'
  f.backend.call = refuse(507, { statusCode: 507, code: 'browser_profile_storage_full', message: 'Browser profile checkpoint storage is full. No checkpoint was deleted and no new browser was activated.' })
  assert.equal(textOf(await f.call()), line('browser_profile_storage_full'))
})

test('browser_profile_close_blocked: a close the browser could not finish', async t => {
  const f = await rig(t)
  f.backend.call = refuse(409, { statusCode: 409, code: 'browser_profile_close_blocked', message: 'close blocked' })
  assert.equal(textOf(await f.call('hoai_browser_close_session')), line('browser_profile_close_blocked'))
})

test('browser_profile_transition_absent: a move between computers the backend no longer has', async t => {
  const f = await rig(t)
  f.backend.resolve = 'active'
  f.backend.call = refuse(404, { statusCode: 404, code: 'browser_profile_transition_absent', message: 'Unknown transition' })
  assert.equal(textOf(await f.call()), line('browser_profile_transition_absent'))
})

test('a browser_profile_* code this copy does not know keeps its code and gets the plain fallback sentence', async t => {
  const f = await rig(t)
  f.backend.call = toolError('### Error\nbrowser_profile_brand_new_state: Desktop words the agent should not have to parse.')
  assert.equal(textOf(await f.call()), `browser_profile_brand_new_state: ${UNKNOWN_SENTENCE}`)
})

test("on a share recipient's turn the sentence names the person the agent acts for, not the owner", async t => {
  const f = await rig(t, { actor: RECIPIENT })
  f.backend.resolve = 'idle'
  assert.equal(textOf(await f.call()), 'browser_profile_setup_required: The person you act for has not set up your browser yet; a Set up card is in your chat.')
})

// ─── A 409 is host_offline only when the relay says so ────────────────────────

test('a connected desktop answering 409 is never told to the agent as host_offline, in a call or while connecting', async t => {
  const fenced = { statusCode: 409, code: 'browser_profile_authority_required', message: 'This browser profile requires current runtime authority.' }
  const f = await rig(t)
  f.backend.call = refuse(409, fenced)
  assert.doesNotMatch(textOf(await f.call()), FALSE_OFFLINE)
  // A 409 with no code at all is a refusal with its status, not an absent desktop.
  f.backend.call = refuse(409, { statusCode: 409, message: 'Conflict' })
  const bare = textOf(await f.call())
  assert.match(bare, /409/)
  assert.doesNotMatch(bare, FALSE_OFFLINE)
  // While connecting (RC4, "Kite"): the fence refuses the shim's own initialize while the host probe says online.
  // The instructions, the one tool left and its answer all say the refusal; none says the app is not running.
  const g = await rig(t, { setup: backend => { backend.init = () => ({ status: 409, body: fenced }) } })
  const init = await g.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'refusal-fixture', version: '1' } })
  assert.doesNotMatch(init.result.instructions, FALSE_OFFLINE)
  assert.match(init.result.instructions, /browser_profile_authority_required: /)
  assert.deepEqual((await g.request('tools/list')).result.tools.map((tool: Json) => tool.name), ['hoai_browser_status'])
  assert.equal(textOf(await g.call('hoai_browser_status')), line('browser_profile_authority_required'))
  assert.equal(textOf(await g.call()), line('browser_profile_authority_required'))
})

test('the control: a relay that says host_offline is still told as the desktop being offline', async t => {
  const f = await rig(t)
  f.backend.call = refuse(409, { statusCode: 409, code: 'host_offline', message: 'no desktop app online for this account' })
  assert.match(textOf(await f.call()), FALSE_OFFLINE)
})

// ─── Profile requests carry the pairing header and nothing else that authenticates ───

test('every profile request carries X-BGOS-Pairing only, even when an account key is also configured', async t => {
  for (const actor of [OWNER, RECIPIENT]) {
    const f = await rig(t, { actor, apiKey: true, setup: backend => { backend.resolve = 'active' } })
    assert.equal(textOf(await f.call()), 'Browser ready.')
    const profile = f.frames.filter(frame => frame.path.startsWith('/api/v1/browser/profile-sync/'))
    assert.ok(profile.some(frame => frame.path.endsWith('/resolve')) && profile.some(frame => frame.path.endsWith('/call')), 'discovery and the call both went to the profile route')
    for (const frame of profile) {
      assert.equal(frame.headers['x-bgos-pairing'], SECRET, `${frame.path}: the pairing token`)
      for (const banned of ['x-api-key', 'authorization', 'x-bgos-session', 'cookie']) assert.equal(frame.headers[banned], undefined, `${frame.path}: no ${banned}`)
      const bgos = Object.keys(frame.headers).filter(name => name.startsWith('x-bgos-')).sort()
      assert.deepEqual(bgos, actor === OWNER ? ['x-bgos-pairing'] : ['x-bgos-acting-user', 'x-bgos-pairing'], `${frame.path}: only the pairing and the signed acting person`)
      if (actor === RECIPIENT) assert.equal(frame.headers['x-bgos-acting-user'], RECIPIENT)
    }
    assert.ok(!f.frames.some(frame => frame.path.includes('/integrations/')), 'a managed profile never reaches the legacy relay')
  }
})

// ─── No profile question ──────────────────────────────────────────────────────

function assertNoProfileChoice(tools: Json[], label: string) {
  const session = tools.filter(tool => String(tool.name).startsWith('hoai_browser_'))
  assert.ok(session.length > 0, `${label}: session tools are served`)
  for (const tool of session) {
    assert.doesNotMatch(JSON.stringify(tool), /preview/i, `${label}: ${tool.name} offers no preview`)
    assert.doesNotMatch(String(tool.description), /signed-in|profile:/i, `${label}: ${tool.name} offers no profile choice`)
  }
  const open = session.find(tool => tool.name === 'hoai_browser_open_session')
  assert.ok(open, `${label}: the open tool is served`)
  assert.equal(open.inputSchema.properties.profile, undefined, `${label}: no profile argument`)
  assert.ok(!(open.inputSchema.required ?? []).includes('profile'), `${label}: profile is not required`)
  assert.ok((open.inputSchema.required ?? []).includes('purpose'), `${label}: purpose stays required`)
}

test('the tool schema served through the relay offers no preview default and no profile choice', async t => {
  const f = await rig(t)
  const tools = (await f.request('tools/list')).result.tools
  assertNoProfileChoice(tools, '5.21 desktop')
  const open = tools.find((tool: Json) => tool.name === 'hoai_browser_open_session')
  assert.match(open.description, /there is no profile to choose\.$/)
  assert.match(open.description, /verify: true/, "the owner's verify ask is kept")
  assert.ok(open.inputSchema.properties.verify && open.inputSchema.properties.caps, 'every other argument is kept')
  assert.equal(tools.find((tool: Json) => tool.name === 'hoai_browser_close_session').description, 'Close the browser session. Call it when you are done.')
  assert.deepEqual(tools.find((tool: Json) => tool.name === 'browser_click'), CLICK, 'a page tool is served exactly as the host sent it')
  // The managed desktop's variant required profile: signed-in.
  const g = await rig(t)
  g.backend.resolve = 'active'
  g.backend.tools = [MANAGED_OPEN, DESKTOP_STATUS]
  assertNoProfileChoice((await g.request('tools/list')).result.tools, 'managed desktop')
})

test("this agent's own browser host lists no profile choice either", () => {
  assertNoProfileChoice(SESSION_TOOLS as Json[], 'plugin browser host')
})

test('the instructions the desktop serves are passed on without the choice, keeping everything else', async t => {
  const f = await rig(t)
  const init = await f.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'refusal-fixture', version: '1' } })
  const said = init.result.instructions as string
  assert.doesNotMatch(said, /preview/i)
  assert.doesNotMatch(said, /profile "/)
  assert.match(said, /^1\. hoai_browser_open_session with a one line purpose the owner will read\. Your browser is your own and remembered: /m)
  assert.match(said, /your next session finds you still signed in\./)
  assert.match(said, /If you skip this, your first browser tool opens your own browser\. A verify session remains temporary\./)
  assert.match(said, /any write on a signed-in site/, 'a sentence that is not a choice is kept')
  assert.match(said, /uses its own temporary browser\./)
  assert.match(said, /^2\. browser_navigate to a URL, then browser_snapshot\.$/m)
  const g = await rig(t)
  g.backend.resolve = 'active'
  g.backend.instructions = MANAGED_INSTRUCTIONS
  const managed = (await g.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'refusal-fixture', version: '1' } })).result.instructions
  assert.equal(managed, 'HOAI managed desktop browser. If needed, call hoai_browser_open_session with a short purpose to use this already authorized managed profile.')
})

test("the open call opens the agent's own browser on every HOAI route, whatever profile an older client still sends", async t => {
  const relay = await rig(t)
  await relay.call('hoai_browser_open_session', { purpose: 'Check the seat map', profile: 'preview' })
  const legacy = relay.frames.filter(frame => frame.path === '/api/v1/integrations/browser/mcp' && frame.body?.message?.method === 'tools/call').at(-1)
  assert.deepEqual(legacy?.body?.message?.params?.arguments, { purpose: 'Check the seat map', profile: 'signed-in' })
  const managed = await rig(t)
  managed.backend.resolve = 'active'
  await managed.call('hoai_browser_open_session', { purpose: 'Check the seat map', profile: 'preview' })
  const sent = managed.frames.filter(frame => frame.path.endsWith('/rpc/call') && frame.body?.message?.method === 'tools/call').at(-1)
  assert.deepEqual(sent?.body?.message?.params?.arguments, { purpose: 'Check the seat map', profile: 'signed-in' })
  // On this machine's loopback door the owner's own default applies: the agent's choice is dropped, none is added.
  const local = await rig(t, { local: true })
  await local.call('hoai_browser_open_session', { purpose: 'Check the seat map', profile: 'preview' })
  const door = local.frames.filter(frame => frame.path === '/local' && frame.body?.method === 'tools/call').at(-1)
  assert.deepEqual(door?.body?.params?.arguments, { purpose: 'Check the seat map' })
})

test('the signed turn context still gates the open call: no verified sender, nothing sent', async t => {
  const f = await rig(t, { managedContext: false })
  f.frames.length = 0
  const result = await f.call('hoai_browser_open_session', { purpose: 'Check the seat map' })
  assert.equal(result.isError, true)
  assert.match(textOf(result), /current sender could not be verified/)
  assert.deepEqual(f.frames, [], 'no request left the shim')
})
