import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import ts from 'typescript'
import { authHeaders, resolveAuth } from '../lib/agent-credentials.ts'
import { boundedFetch } from '../lib/bounded-fetch.ts'
import { errorBodyText } from '../lib/error-body.ts'
import { BGOS_CAPABILITIES_FALLBACK } from '../lib/capabilities.ts'
import { OWN_MCP_TOOLS } from '../lib/hook-events.ts'
import { PRIVATE_TOOL_MATCHER } from '../lib/private-turn.mjs'
import { PRIVATE_TOOL_MATCHER as PRESEED_MATCHER } from '../lib/claude-preseed.mjs'

// Lazy import keeps the red run on the current implementation executable.
async function imageTools(): Promise<Record<string, any>> {
  const modulePath = '../lib/profile-image.ts'
  const tools = await import(modulePath).catch(() => ({}))
  assert.equal(typeof tools.handleProfileImage, 'function', 'the profile image tool exists')
  return tools
}

const source = readFileSync('server.ts', 'utf8').replace(/\r\n/g, '\n')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBf8AAAAASUVORK5CYII=', 'base64')
const owner = 'synthetic-owner'
const baseDeps = { assistantId: '42', ownerId: owner, actingUserId: owner }
type Result = { content: Array<{ text: string }>; isError?: boolean }
const textOf = (result: Result) => result.content[0]!.text

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'profile-image-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'drawing.png')
  await writeFile(path, png)
  return { root, path }
}

test('the tool validates arguments, identity, file kind, bytes and the 5 MB limit before uploading', async t => {
  const tools = await imageTools()
  const f = await fixture(t)
  const large = join(f.root, 'large.png')
  await writeFile(large, Buffer.alloc(5 * 1024 * 1024 + 1))
  const empty = join(f.root, 'empty.png')
  await writeFile(empty, '')
  const pretend = join(f.root, 'pretend.png')
  await writeFile(pretend, 'this is not an image')
  const directory = join(f.root, 'folder.png')
  await mkdir(directory)
  const calls: unknown[] = []
  const deps = { ...baseDeps, put: async (...args: unknown[]) => { calls.push(args) } }
  for (const args of [undefined, null, {}, { path: '' }, { path: '  ' }, { path: 4 },
    { path: 'relative.png' }, { path: 'https://example.test/image.png' }, { path: `${f.path}\0` },
    { path: f.path, assistantId: 7 }, { path: f.path, imageBase64: 'invented' },
    { path: join(f.root, 'missing.png') }, { path: large }, { path: empty }, { path: pretend }, { path: directory }]) {
    const result = await tools.handleProfileImage(args, deps)
    assert.equal(result.isError, true, JSON.stringify(args))
    assert.ok(textOf(result).length > 0)
  }
  for (const assistantId of ['', '42/../7', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await tools.handleProfileImage({ path: f.path }, { ...deps, assistantId })).isError, true)
  }
  assert.equal((await tools.handleProfileImage({ path: f.path }, { ...deps, actingUserId: 'synthetic-recipient' })).isError, true)
  assert.equal(calls.length, 0)
})

test('uploads bytes by PUT to the own-agent route, independent of the file extension', async t => {
  const tools = await imageTools()
  const f = await fixture(t)
  const path = join(f.root, 'drawing.data')
  await writeFile(path, png)
  const calls: unknown[] = []
  const result = await tools.handleProfileImage({ path }, {
    ...baseDeps, put: async (...args: unknown[]) => { calls.push(args); return { updated: true } },
  })
  assert.equal(result.isError, undefined, textOf(result))
  assert.deepEqual(calls, [['agent-profile-image/agents/42', { imageBase64: png.toString('base64') }, { 'X-Caller-Assistant-Id': '42' }]])
  assert.match(textOf(result), /picture.*updated/i)
  assert.doesNotMatch(textOf(result), /imageBase64|iVBOR/)
})

test('the advertised schema accepts only an absolute local file path', async () => {
  const tools = await imageTools()
  const declaration = tools.PROFILE_IMAGE_TOOL
  assert.equal(declaration.name, 'set_profile_image')
  assert.deepEqual(declaration.inputSchema.required, ['path'])
  assert.deepEqual(Object.keys(declaration.inputSchema.properties), ['path'])
  assert.equal(declaration.inputSchema.additionalProperties, false)
  assert.match(declaration.description, /owner.*ask/i)
  assert.match(declaration.description, /PNG.*JPEG.*WebP.*GIF.*5 MB/)
  assert.doesNotMatch(declaration.description, /[\u2013\u2014]/)
})

function slice(open: string, close = '\n}\n') {
  const start = source.indexOf(open)
  assert.ok(start >= 0, open)
  const end = source.indexOf(close, start)
  assert.ok(end > start, close)
  return source.slice(start, end + close.length)
}

function compile(body: string, result: string, scope: Record<string, unknown>): any {
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(scope), `${js}\nreturn ${result}`)(...Object.values(scope))
}

test('the real authenticated bgosPut uploads once in both auth modes and preserves a server refusal sentence', async t => {
  const tools = await imageTools()
  const f = await fixture(t)
  const requests: Array<{ method?: string; path?: string; headers: Record<string, any>; body: unknown }> = []
  let refused = false
  const sentence = 'Your owner must ask you to change your picture in their own chat.'
  const backend = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ method: req.method, path: req.url, headers: req.headers, body: JSON.parse(body) })
    res.writeHead(refused ? 403 : 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(refused ? { statusCode: 403, message: sentence, error: 'Forbidden' } : { updated: true }))
  })
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => backend.close(err => err ? reject(err) : resolve())))
  const address = backend.address() as { port: number }
  for (const mode of ['pairing', 'apikey']) {
    const auth = resolveAuth({ env: { BGOS_BACKEND_URL: 'https://example.test', BGOS_USER_ID: owner, BGOS_ASSISTANT_ID: '42',
      ...(mode === 'pairing' ? { BGOS_PAIRING_TOKEN: 'synthetic-pairing-token' } : { BGOS_API_KEY: 'synthetic-api-key' }) } })
    const put = compile(`${slice('class HttpError extends Error {')}\n${slice('async function bgosPut(')}`, 'bgosPut', {
      API_BASE: `http://127.0.0.1:${address.port}/api/v1`, AUTH: auth, authHeaders, errorBodyText,
      HTTP_TIMEOUT_MS: 1000, bgosCall: boundedFetch,
    })
    refused = false
    assert.equal((await tools.handleProfileImage({ path: f.path }, { ...baseDeps, put })).isError, undefined)
    const sent = requests.at(-1)!
    assert.equal(sent.method, 'PUT')
    assert.equal(sent.path, '/api/v1/agent-profile-image/agents/42')
    assert.deepEqual(sent.body, { imageBase64: png.toString('base64') })
    assert.equal(sent.headers['x-caller-assistant-id'], '42')
    assert.equal(sent.headers[mode === 'pairing' ? 'x-bgos-pairing' : 'x-api-key'], mode === 'pairing' ? 'synthetic-pairing-token' : 'synthetic-api-key')
    refused = true
    const result = await tools.handleProfileImage({ path: f.path }, { ...baseDeps, put })
    assert.equal(result.isError, true)
    assert.equal(textOf(result), `PUT 403: ${sentence}`)
  }
  assert.equal(requests.length, 4, 'no retry or alternate route after a refusal')
})

test('MCP discovery, dispatch, owner-turn admission, helper guards and capability text expose the tool', async () => {
  const tools = await imageTools()
  let listing: any
  compile(slice('mcp.setRequestHandler(ListToolsRequestSchema, async () => ({', '\n}))\n'), 'undefined', {
    mcp: { setRequestHandler: (_schema: unknown, handler: unknown) => { listing = handler } },
    ListToolsRequestSchema: {}, PROFILE_IMAGE_TOOL: tools.PROFILE_IMAGE_TOOL,
    BOARDS_TOOL_DECLS: [], ARTIFACT_TOOL_DECLS: [], VAULT_TOOL_DECLS: [], EMAIL_TOOL_DECLS: [],
  })
  const declarations = await listing()
  assert.ok(declarations.tools.some((tool: any) => tool.name === 'set_profile_image'))
  assert.match(source, /PROFILE_IMAGE_TOOL/)
  assert.match(source, /handleProfileImage\(rawArgs, \{\s*assistantId: ASSISTANT_ID,\s*ownerId: USER_ID,\s*actingUserId: privateCall!\.actingUserId,\s*put: bgosPut/)
  const admission = source.slice(source.indexOf('let privateCall:'), source.indexOf('// email_send names its reason'))
  assert.match(admission.split('} else if')[0]!, /set_profile_image/)
  assert.ok(OWN_MCP_TOOLS.includes('set_profile_image'))
  const manifest = JSON.parse(readFileSync('hooks/hooks.json', 'utf8'))
  const guard = manifest.hooks.PreToolUse.find((entry: any) => entry.matcher?.includes('bgos__'))
  for (const matcher of [PRIVATE_TOOL_MATCHER, PRESEED_MATCHER, guard.matcher]) {
    for (const prefix of ['mcp__bgos__', 'mcp__plugin_hoai_bgos__']) assert.ok(new RegExp(matcher).test(`${prefix}set_profile_image`))
  }
  assert.ok(BGOS_CAPABILITIES_FALLBACK.includes(tools.PROFILE_IMAGE_GUIDANCE))
  const instructions = source.slice(source.indexOf('instructions: ['), source.indexOf('// ── Tools'))
  assert.ok(instructions.includes(`'${tools.PROFILE_IMAGE_GUIDANCE}',`), 'the plain instructions literal matches the shared tool guidance')
  const capabilityCase = source.slice(source.indexOf("    case 'bgos_capabilities': {"), source.indexOf("    case 'reply': {"))
  const served = compile(`async function read() { switch ('bgos_capabilities') { ${capabilityCase} } }`, 'read', {
    loadServedCapabilities: async () => ({ text: '# BGOS Channel Agent Capabilities\nOlder served guide.' }),
    PROFILE_IMAGE_GUIDANCE: tools.PROFILE_IMAGE_GUIDANCE,
  })
  assert.ok(textOf(await served()).includes('set_profile_image'), 'older served guides still expose this local tool')
})

test('the real MCP call handler admits an owner, refuses an unverified turn and never uploads for a recipient', async t => {
  const tools = await imageTools()
  const f = await fixture(t)
  const sent: unknown[] = []
  let actor: string | null = owner
  const end = '\n  }).then((result) => withRetiredOwnAskNotes(result, extra.signal))\n})\n'
  const handler = slice('mcp.setRequestHandler(CallToolRequestSchema, (req, extra) => {', end)
    .replace('mcp.setRequestHandler(CallToolRequestSchema, (req, extra) => {', 'const callTool = (req, extra) => {')
    .replace(end, '\n  }).then((result) => withRetiredOwnAskNotes(result, extra.signal))\n}\n')
  const call = compile(handler, 'callTool', {
    channelLiveness: { live: true, markToolCall() {} },
    decideToolAdmission: () => 'admit', updateDrainMode: false, restartDrainSnapshot: () => ({}), lockHeld: true,
    requirePrivateTurn: () => { if (!actor) throw Error('No verified owner turn.'); return { actingUserId: actor } },
    privateTurns: { explain: () => 'no verified turn' }, PRIVATE_MARKER_PATHS: [], PRIVATE_HOOK: { registered: true },
    USER_ID: owner, ASSISTANT_ID: '42', log() {},
    trackMessageOperation: (op: () => unknown) => op(), withRetiredOwnAskNotes: (result: unknown) => result,
    handleProfileImage: tools.handleProfileImage,
    bgosPut: async (...args: unknown[]) => { sent.push(args); return { updated: true } },
  })
  const invoke = () => call({ params: { name: 'set_profile_image', arguments: { path: f.path } } }, { signal: new AbortController().signal })
  assert.equal((await invoke()).isError, undefined)
  assert.equal(sent.length, 1)
  actor = null
  const refused = await invoke()
  assert.equal(refused.isError, true)
  assert.equal(textOf(refused), 'No verified owner turn.')
  actor = 'synthetic-recipient'
  assert.equal((await invoke()).isError, true)
  assert.equal(sent.length, 1, 'the unverified turn and the recipient sent nothing')
})
