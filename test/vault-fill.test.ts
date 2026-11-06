import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  VAULT_HOST_FILE_NAME,
  confirmHostPin,
  fillIntentText,
  hostFingerprint,
  hostPinStatus,
  loadOrCreateHostKey,
  provisionSigningIdentity,
  readHostRecord,
  registerHostKey,
  showFingerprintOnTerminal,
  signFillIntent,
  verifyFillIntent,
} from '../lib/vault-host.mjs'
import { VAULT_TOOL_DECLS, handleVaultTool } from '../lib/vault-tools.ts'
import { PRIVATE_TOOL_MATCHER } from '../lib/private-turn.mjs'
import { checkFillIntent, checkHostKeyProof, checkSignedRequest, referenceFingerprint } from './fixtures/vault-server-contract.ts'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const ASSISTANT = 42
const OWNER = 'user_fixture_owner'
const PAIRING = 'fixture-pairing-credential-0001'
const API = 'https://api.example.test/api/v1'
const SECRET = 'fixture-secret-value-Xy7!'
const posix = process.platform !== 'win32'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'vault-host-'))
}

function agentSigningKey() {
  const pair = generateKeyPairSync('ed25519')
  return {
    secret: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    identityPublic: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
  }
}

const VAULT_ID = randomUUID()
const LOGIN = randomUUID()
const API_KEY_ITEM = randomUUID()

function itemRows() {
  const base = { ownerId: OWNER, vaultId: VAULT_ID, vaultAssistantId: ASSISTANT, revision: 7, masked: '••••••••' }
  return [
    // Extra fields a buggy or hostile server might add: none may reach a tool result.
    { ...base, id: LOGIN, name: 'Example login', kind: 'login', labels: [], website: 'https://login.example.test', username: 'owner@example.test', envName: null, reference: `hoai-vault://${ASSISTANT}/${LOGIN}`, password: SECRET, value: SECRET, sealed: { nonce: 'n', ciphertext: SECRET } },
    { ...base, id: API_KEY_ITEM, name: 'Example API', kind: 'api_key', labels: ['ci'], website: null, username: null, envName: 'EXAMPLE_API_KEY', reference: `hoai-vault://${ASSISTANT}/${API_KEY_ITEM}`, secret: SECRET },
  ]
}

interface Call { method: string; url: string; headers: Record<string, string>; body: string }

/** A fake backend that applies the server contract's checks to every call. */
function fakeBackend(identityPublic: string, opts: { failWith?: number; failBody?: string } = {}) {
  const calls: Call[] = []
  const fetch = async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url))
    const method = String(init.method ?? 'GET')
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>))
    const body = typeof init.body === 'string' ? init.body : ''
    calls.push({ method, url: u.href, headers, body })
    const reply = (status: number, value: unknown) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    const reason = checkSignedRequest({ method, path: u.pathname, assistantId: ASSISTANT, identityPublic, pairingToken: PAIRING, headers, body })
    if (reason) return reply(403, { message: `refused ${reason} ${SECRET}` })
    if (opts.failWith) return reply(opts.failWith, opts.failBody ?? { message: SECRET })
    const prefix = `/api/v1/vault/agent/${ASSISTANT}`
    if (method === 'GET' && u.pathname === `${prefix}/items`) return reply(200, { items: itemRows() })
    if (method === 'POST' && u.pathname === `${prefix}/host-key`) {
      const parsed = JSON.parse(body)
      if (Object.keys(parsed).sort().join() !== 'publicKey,signature') return reply(400, {})
      return checkHostKeyProof({ ownerId: OWNER, assistantId: ASSISTANT, identityPublic, ...parsed })
        ? reply(201, { registered: true, publicKey: parsed.publicKey }) : reply(403, { message: 'Invalid signed host key.' })
    }
    if (method === 'POST' && u.pathname === `${prefix}/request`) return reply(201, { requested: true, messageId: 991 })
    const fill = new RegExp(`^${prefix}/items/([0-9a-f-]{36})/fill$`).exec(u.pathname)
    if (method === 'POST' && fill) {
      const parsed = JSON.parse(body)
      try {
        checkFillIntent(parsed.intent, parsed.signature, identityPublic)
      } catch {
        return reply(400, { message: 'Invalid signed vault fill request.' })
      }
      const i = parsed.intent
      if (i.itemId !== fill[1] || i.ownerId !== OWNER || i.assistantId !== ASSISTANT || i.revision !== 7 || i.vaultId !== VAULT_ID ||
        i.sessionId !== parsed.sessionId || i.tabId !== parsed.tabId || i.origin !== parsed.origin) return reply(400, {})
      return reply(201, { ticket: 'T'.repeat(43), expiresIn: 60 })
    }
    return reply(404, {})
  }
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch }
}

/** A provisioned, registered and owner-confirmed host in a fresh folder. */
async function pinnedHost() {
  const dir = tempDir()
  const key = agentSigningKey()
  loadOrCreateHostKey(dir, ASSISTANT)
  provisionSigningIdentity(dir, ASSISTANT, key.secret)
  const backend = fakeBackend(key.identityPublic)
  await registerHostKey({ stateDir: dir, assistantId: ASSISTANT, ownerId: OWNER, apiBase: API, pairingToken: PAIRING, fetch: backend.fetch })
  confirmHostPin(dir)
  return { dir, key, backend }
}

function deps(dir: string, fetch: typeof globalThis.fetch, logs: string[], acting = OWNER) {
  return { assistantId: ASSISTANT, ownerId: OWNER, actingUserId: acting, apiBase: API, pairingToken: PAIRING, stateDir: dir, fetch, log: (line: string) => logs.push(line) }
}

function forbidden(record: Record<string, any>, extra: string[] = []): string[] {
  return [SECRET, PAIRING, record.hostSeed, record.signingSecret, hostFingerprint(record.identityPublic, record.publicKey), ...extra].filter(Boolean)
}

function assertClean(text: string, needles: string[], where: string) {
  for (const needle of needles) assert.ok(!text.includes(needle), `${where} leaked ${needle.slice(0, 6)}...`)
}

// ── 1. Host key: generated on first use, owner-only, reused ────────────────

test('host key: first use creates an Ed25519 host key in an owner-only file and reuses it after', { skip: !posix }, () => {
  const dir = tempDir()
  try {
    const first = loadOrCreateHostKey(dir, ASSISTANT)
    const file = join(dir, VAULT_HOST_FILE_NAME)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(statSync(dir).mode & 0o077, 0)
    const seed = createPrivateKey({ key: Buffer.from(first.hostSeed, 'base64url'), format: 'der', type: 'pkcs8' })
    assert.equal(seed.asymmetricKeyType, 'ed25519')
    assert.match(first.publicKey, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(Buffer.from(first.publicKey, 'base64url').length, 32)
    const again = loadOrCreateHostKey(dir, ASSISTANT)
    assert.equal(again.publicKey, first.publicKey)
    assert.equal(again.hostSeed, first.hostSeed)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('host key: a key file readable by group or others is refused, never used', { skip: !posix }, () => {
  const dir = tempDir()
  try {
    loadOrCreateHostKey(dir, ASSISTANT)
    chmodSync(join(dir, VAULT_HOST_FILE_NAME), 0o644)
    assert.throws(() => readHostRecord(dir), /VAULT_HOST_KEY_EXPOSED/)
    assert.throws(() => loadOrCreateHostKey(dir, ASSISTANT), /VAULT_HOST_KEY_EXPOSED/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('host key: the registered X25519 key is the Montgomery form of the Ed25519 host key and does ECDH', () => {
  const dir = tempDir()
  try {
    const record = loadOrCreateHostKey(dir, ASSISTANT)
    const ed = createPublicKey(createPrivateKey({ key: Buffer.from(record.hostSeed, 'base64url'), format: 'der', type: 'pkcs8' }))
    const raw = ed.export({ format: 'der', type: 'spki' }).subarray(-32)
    const p = 2n ** 255n - 19n
    const yBytes = Buffer.from(raw); yBytes[31] &= 0x7f
    const y = BigInt('0x' + Buffer.from(yBytes).reverse().toString('hex'))
    const pow = (b: bigint, e: bigint) => { let r = 1n; b %= p; while (e > 0n) { if (e & 1n) r = r * b % p; b = b * b % p; e >>= 1n } return r }
    const u = (1n + y) * pow((1n - y + p) % p, p - 2n) % p
    const uBytes = Buffer.from(u.toString(16).padStart(64, '0'), 'hex').reverse()
    assert.equal(uBytes.toString('base64url'), record.publicKey)
    // A sender who only knows the registered key can reach the host.
    const sender = generateKeyPairSync('x25519')
    const hostPublic = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(record.publicKey, 'base64url')]), format: 'der', type: 'spki' })
    const seed = createPrivateKey({ key: Buffer.from(record.hostSeed, 'base64url'), format: 'der', type: 'pkcs8' }).export({ format: 'der', type: 'pkcs8' }).subarray(-32)
    const scalar = createHash('sha512').update(seed).digest().subarray(0, 32)
    const hostPrivate = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), scalar]), format: 'der', type: 'pkcs8' })
    assert.deepEqual(
      diffieHellman({ privateKey: sender.privateKey, publicKey: hostPublic }),
      diffieHellman({ privateKey: hostPrivate, publicKey: sender.publicKey }),
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('signing identity: only an Ed25519 PKCS8 key is accepted and the file stays owner-only', { skip: !posix }, () => {
  const dir = tempDir()
  try {
    loadOrCreateHostKey(dir, ASSISTANT)
    const x = generateKeyPairSync('x25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
    assert.throws(() => provisionSigningIdentity(dir, ASSISTANT, x), /VAULT_SIGNING_KEY_INVALID/)
    assert.throws(() => provisionSigningIdentity(dir, ASSISTANT, 'not a key'), /VAULT_SIGNING_KEY_INVALID/)
    const key = agentSigningKey()
    const out = provisionSigningIdentity(dir, ASSISTANT, key.secret)
    assert.equal(out.identityPublic, key.identityPublic)
    assert.ok(!JSON.stringify(out).includes(key.secret))
    assert.equal(statSync(join(dir, VAULT_HOST_FILE_NAME)).mode & 0o777, 0o600)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── 2. Registration: the independent proof, A2A headers, pairing ──────────

test('registration: POST host-key carries the independent proof, the A2A signature and the pairing credential', async () => {
  const { dir, key, backend } = await pinnedHost()
  try {
    const call = backend.calls.find(c => c.url.endsWith(`/vault/agent/${ASSISTANT}/host-key`))!
    assert.ok(call, 'host-key was posted')
    const record = readHostRecord(dir)!
    assert.deepEqual(JSON.parse(call.body).publicKey, record.publicKey)
    assert.equal(checkSignedRequest({ method: 'POST', path: new URL(call.url).pathname, assistantId: ASSISTANT, identityPublic: key.identityPublic, pairingToken: PAIRING, headers: call.headers, body: call.body }), null)
    assert.equal(hostPinStatus(record), 'pinned')
    assertClean(call.body, [record.hostSeed, record.signingSecret, hostFingerprint(record.identityPublic, record.publicKey)], 'registration body')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('registration: a server that refuses the proof leaves the host unregistered', async () => {
  const dir = tempDir()
  try {
    loadOrCreateHostKey(dir, ASSISTANT)
    provisionSigningIdentity(dir, ASSISTANT, agentSigningKey().secret)
    // The server knows a DIFFERENT identity, so the proof and the A2A signature fail.
    const backend = fakeBackend(agentSigningKey().identityPublic)
    await assert.rejects(registerHostKey({ stateDir: dir, assistantId: ASSISTANT, ownerId: OWNER, apiBase: API, pairingToken: PAIRING, fetch: backend.fetch }), /VAULT_UNAVAILABLE/)
    assert.equal(hostPinStatus(readHostRecord(dir)!), 'unregistered')
    assert.throws(() => confirmHostPin(dir), /VAULT_HOST_NOT_REGISTERED/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── 3. Fingerprint: local terminal only ────────────────────────────────────

test('fingerprint: matches the app format and is written only to a TTY display', async () => {
  const { dir } = await pinnedHost()
  try {
    const record = readHostRecord(dir)!
    const expected = referenceFingerprint(record.identityPublic, record.publicKey)
    assert.equal(hostFingerprint(record.identityPublic, record.publicKey), expected)
    assert.match(expected, /^[0-9a-f]{4}( [0-9a-f]{4}){4}$/)
    let piped = ''
    assert.equal(showFingerprintOnTerminal(record, { isTTY: false, write: (s: string) => { piped += s; return true } }), false)
    assert.equal(piped, '')
    let tty = ''
    assert.equal(showFingerprintOnTerminal(record, { isTTY: true, write: (s: string) => { tty += s; return true } }), true)
    assert.ok(tty.includes(expected))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fingerprint: the terminal command refuses without a terminal and prints no fingerprint to pipes', async () => {
  const { dir } = await pinnedHost()
  const home = tempDir()
  try {
    const record = readHostRecord(dir)!
    const fp = hostFingerprint(record.identityPublic, record.publicKey)
    const run = spawnSync(process.execPath, [join(ROOT, 'bin', 'hoai-vault-host.mjs'), '--state-dir', dir, 'status'], {
      encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home }, input: '',
    })
    assert.notEqual(run.status, 0)
    assert.ok(!run.stdout.includes(fp) && !run.stderr.includes(fp), 'no fingerprint in piped output')
    assert.match(run.stdout + run.stderr, /terminal/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 4. Fill intent: sign, verify, tamper ───────────────────────────────────

function intentFor(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, ownerId: OWNER, assistantId: ASSISTANT, vaultAssistantId: ASSISTANT, vaultId: VAULT_ID, itemId: LOGIN,
    revision: 7, sessionId: 'session-1', tabId: 'tab-1', origin: 'https://login.example.test', nonce: randomUUID(),
    expiresAt: Date.now() + 55_000, ...overrides,
  }
}

test('fill intent: the signature verifies under the server contract and the plugin verifier', () => {
  const key = agentSigningKey()
  const intent = intentFor()
  const signature = signFillIntent(intent, key.secret)
  assert.match(signature, /^[A-Za-z0-9_-]{86}$/)
  assert.doesNotThrow(() => checkFillIntent(intent, signature, key.identityPublic))
  assert.equal(verifyFillIntent(intent, signature, key.identityPublic), true)
  assert.equal(fillIntentText(intent), JSON.stringify(['hoai-vault-fill-v1', OWNER, ASSISTANT, ASSISTANT, VAULT_ID, LOGIN, 7, 'session-1', 'tab-1', 'https://login.example.test', intent.nonce, intent.expiresAt]))
})

test('fill intent: any changed field, another key, an extra field or a late expiry fails verification', () => {
  const key = agentSigningKey()
  const intent = intentFor()
  const signature = signFillIntent(intent, key.secret)
  const changes: Record<string, unknown> = {
    ownerId: 'user_someone_else', assistantId: 43, vaultAssistantId: 44, vaultId: randomUUID(), itemId: randomUUID(), revision: 8,
    sessionId: 'session-2', tabId: 'tab-2', origin: 'https://evil.example.test', nonce: randomUUID(), expiresAt: intent.expiresAt + 1,
  }
  for (const [field, value] of Object.entries(changes)) {
    const changed = { ...intent, [field]: value }
    assert.equal(verifyFillIntent(changed, signature, key.identityPublic), false, field)
    assert.throws(() => checkFillIntent(changed, signature, key.identityPublic), /Invalid signed vault fill request/, field)
  }
  assert.equal(verifyFillIntent(intent, signature, agentSigningKey().identityPublic), false)
  assert.equal(verifyFillIntent({ ...intent, extra: 1 }, signature, key.identityPublic), false)
  const late = intentFor({ expiresAt: Date.now() + 120_000 })
  assert.equal(verifyFillIntent(late, signFillIntent(late, key.secret), key.identityPublic), false)
  const http = intentFor({ origin: 'http://login.example.test' })
  assert.equal(verifyFillIntent(http, signFillIntent(http, key.secret), key.identityPublic), false)
})

// ── 5. Tools ───────────────────────────────────────────────────────────────

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

test('tools: three vault tools are declared with strict inputs and no value field', () => {
  const names = VAULT_TOOL_DECLS.map(d => d.name).sort()
  assert.deepEqual(names, ['vault_fill_prepare', 'vault_items', 'vault_request_login'])
  for (const decl of VAULT_TOOL_DECLS) {
    assert.equal(decl.inputSchema.additionalProperties, false)
    assert.ok(!/password|secret|value/i.test(Object.keys(decl.inputSchema.properties).join()), decl.name)
  }
  const fill = VAULT_TOOL_DECLS.find(d => d.name === 'vault_fill_prepare')!
  assert.deepEqual(Object.keys(fill.inputSchema.properties).sort(), ['itemId', 'origin', 'sessionId', 'tabId'])
  const request = VAULT_TOOL_DECLS.find(d => d.name === 'vault_request_login')!
  assert.deepEqual(Object.keys(request.inputSchema.properties).sort(), ['name', 'username', 'website'])
})

test('vault_fill_prepare: builds, signs and requests a ticket, returning the unchanged signed request for hoai_vault_fill', async () => {
  const { dir, key, backend } = await pinnedHost()
  const logs: string[] = []
  try {
    const result = await handleVaultTool('vault_fill_prepare', { itemId: LOGIN, sessionId: 'session-1', tabId: 'tab-1', origin: 'https://login.example.test' }, deps(dir, backend.fetch, logs))
    assert.ok(!('isError' in result), result.content[0].text)
    const out = parse(result)
    assert.equal(out.ticket, 'T'.repeat(43))
    assert.equal(out.sessionId, 'session-1')
    assert.equal(out.tabId, 'tab-1')
    assert.equal(out.origin, 'https://login.example.test')
    assert.deepEqual(Object.keys(out.request).sort(), ['intent', 'signature'])
    assert.doesNotThrow(() => checkFillIntent(out.request.intent, out.request.signature, key.identityPublic))
    // The desktop's own match checks (agent, session, tab, origin) on the forwarded fields.
    assert.equal(out.request.intent.assistantId, ASSISTANT)
    assert.equal(out.request.intent.sessionId, out.sessionId)
    assert.equal(out.request.intent.tabId, out.tabId)
    assert.equal(out.request.intent.origin, out.origin)
    const fill = backend.calls.find(c => c.url.endsWith(`/items/${LOGIN}/fill`))!
    const sent = JSON.parse(fill.body)
    assert.deepEqual(sent.intent, out.request.intent, 'forwarded intent is the one the server accepted')
    assert.equal(sent.signature, out.request.signature)
    const record = readHostRecord(dir)!
    assertClean(result.content[0].text, forbidden(record), 'fill result')
    assertClean(logs.join('\n'), forbidden(record, [out.ticket, out.request.signature]), 'logs')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('vault_fill_prepare: refuses before any fill call when the owner has not pinned this host', async () => {
  const dir = tempDir()
  const logs: string[] = []
  try {
    const key = agentSigningKey()
    const backend = fakeBackend(key.identityPublic)
    const args = { itemId: LOGIN, sessionId: 'session-1', tabId: 'tab-1', origin: 'https://login.example.test' }
    // 1. Nothing set up: the host key is generated on this first use, and the call is refused.
    let out = parse(await handleVaultTool('vault_fill_prepare', args, deps(dir, backend.fetch, logs)))
    assert.equal(out.error, 'VAULT_HOST_NOT_PINNED')
    assert.ok(existsSync(join(dir, VAULT_HOST_FILE_NAME)), 'host key generated on first use')
    // 2. Signing identity provisioned, not registered.
    provisionSigningIdentity(dir, ASSISTANT, key.secret)
    out = parse(await handleVaultTool('vault_fill_prepare', args, deps(dir, backend.fetch, logs)))
    assert.equal(out.error, 'VAULT_HOST_NOT_PINNED')
    // 3. Registered, but the owner has not compared and pinned it.
    await registerHostKey({ stateDir: dir, assistantId: ASSISTANT, ownerId: OWNER, apiBase: API, pairingToken: PAIRING, fetch: backend.fetch })
    out = parse(await handleVaultTool('vault_fill_prepare', args, deps(dir, backend.fetch, logs)))
    assert.equal(out.error, 'VAULT_HOST_NOT_PINNED')
    // 4. A pin recorded for an earlier key does not carry over to a replaced signing identity.
    confirmHostPin(dir)
    provisionSigningIdentity(dir, ASSISTANT, agentSigningKey().secret)
    out = parse(await handleVaultTool('vault_fill_prepare', args, deps(dir, backend.fetch, logs)))
    assert.equal(out.error, 'VAULT_HOST_NOT_PINNED')
    assert.equal(backend.calls.filter(c => c.url.includes('/fill')).length, 0, 'no fill request was made')
    assert.match(out.message, /hoai vault-host/)
    const record = readHostRecord(dir)!
    assertClean(JSON.stringify(out), forbidden(record), 'refusal')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('vault_fill_prepare: refuses a non-login item, a mismatched website and malformed input', async () => {
  const { dir, backend } = await pinnedHost()
  const logs: string[] = []
  try {
    const d = deps(dir, backend.fetch, logs)
    let out = parse(await handleVaultTool('vault_fill_prepare', { itemId: API_KEY_ITEM, sessionId: 's', tabId: 't', origin: 'https://login.example.test' }, d))
    assert.equal(out.error, 'VAULT_UNAVAILABLE')
    out = parse(await handleVaultTool('vault_fill_prepare', { itemId: LOGIN, sessionId: 's', tabId: 't', origin: 'https://other.example.test' }, d))
    assert.equal(out.error, 'VAULT_ORIGIN_MISMATCH')
    for (const bad of [
      { itemId: 'not-a-uuid', sessionId: 's', tabId: 't', origin: 'https://login.example.test' },
      { itemId: LOGIN, sessionId: 's', tabId: 't', origin: 'http://login.example.test' },
      { itemId: LOGIN, sessionId: 's', tabId: 't', origin: 'https://login.example.test/path' },
      { itemId: LOGIN, sessionId: '', tabId: 't', origin: 'https://login.example.test' },
      { itemId: LOGIN, sessionId: 's', tabId: 't', origin: 'https://login.example.test', password: SECRET },
    ]) {
      const r = await handleVaultTool('vault_fill_prepare', bad, d)
      assert.equal(parse(r).error, 'VAULT_INPUT_INVALID')
      assertClean(r.content[0].text, [SECRET], 'input refusal')
    }
    assert.equal(backend.calls.filter(c => c.url.includes('/fill')).length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('vault_items: returns metadata only, never a value, ciphertext or extra server field', async () => {
  const { dir, backend } = await pinnedHost()
  const logs: string[] = []
  try {
    const result = await handleVaultTool('vault_items', { q: 'example' }, deps(dir, backend.fetch, logs))
    const out = parse(result)
    assert.equal(out.items.length, 2)
    for (const item of out.items) {
      assert.deepEqual(Object.keys(item).sort(), ['envName', 'id', 'kind', 'labels', 'name', 'reference', 'revision', 'username', 'vaultAssistantId', 'website'])
    }
    const call = backend.calls.find(c => c.url.includes('/items'))!
    assert.equal(new URL(call.url).searchParams.get('q'), 'example')
    const record = readHostRecord(dir)!
    assertClean(result.content[0].text, forbidden(record), 'items result')
    assertClean(logs.join('\n'), forbidden(record), 'logs')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('vault_request_login: posts only name, website and username and returns the request receipt', async () => {
  const { dir, key, backend } = await pinnedHost()
  const logs: string[] = []
  try {
    const result = await handleVaultTool('vault_request_login', { name: 'Example', website: 'https://login.example.test', username: 'owner@example.test' }, deps(dir, backend.fetch, logs))
    assert.deepEqual(parse(result), { requested: true, messageId: 991 })
    const call = backend.calls.find(c => c.url.endsWith('/request'))!
    assert.deepEqual(JSON.parse(call.body), { name: 'Example', website: 'https://login.example.test', username: 'owner@example.test' })
    assert.equal(checkSignedRequest({ method: 'POST', path: new URL(call.url).pathname, assistantId: ASSISTANT, identityPublic: key.identityPublic, pairingToken: PAIRING, headers: call.headers, body: call.body }), null)
    const bad = parse(await handleVaultTool('vault_request_login', { name: 'Example', website: 'http://login.example.test' }, deps(dir, backend.fetch, logs)))
    assert.equal(bad.error, 'VAULT_INPUT_INVALID')
    const withSecret = parse(await handleVaultTool('vault_request_login', { name: 'Example', website: 'https://login.example.test', password: SECRET }, deps(dir, backend.fetch, logs)))
    assert.equal(withSecret.error, 'VAULT_INPUT_INVALID')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('no secret in any tool result or log line, including server errors that echo one', async () => {
  const { dir, key } = await pinnedHost()
  const logs: string[] = []
  try {
    const failing = fakeBackend(key.identityPublic, { failWith: 500, failBody: JSON.stringify({ message: SECRET, password: SECRET }) })
    const results = [
      await handleVaultTool('vault_items', {}, deps(dir, failing.fetch, logs)),
      await handleVaultTool('vault_request_login', { name: 'Example', website: 'https://login.example.test' }, deps(dir, failing.fetch, logs)),
      await handleVaultTool('vault_fill_prepare', { itemId: LOGIN, sessionId: 's', tabId: 't', origin: 'https://login.example.test' }, deps(dir, failing.fetch, logs)),
    ]
    const record = readHostRecord(dir)!
    for (const r of results) {
      assert.equal(r.isError, true)
      assertClean(r.content[0].text, forbidden(record), 'error result')
    }
    assert.ok(logs.length > 0, 'failures are logged')
    assertClean(logs.join('\n'), forbidden(record), 'logs')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('vault tools refuse a turn admitted for anyone but the owner, before any request', async () => {
  const { dir, backend } = await pinnedHost()
  const before = backend.calls.length
  try {
    for (const [name, args] of [
      ['vault_items', {}],
      ['vault_request_login', { name: 'Example', website: 'https://login.example.test' }],
      ['vault_fill_prepare', { itemId: LOGIN, sessionId: 's', tabId: 't', origin: 'https://login.example.test' }],
    ] as const) {
      assert.equal(parse(await handleVaultTool(name, args, deps(dir, backend.fetch, [], 'user_shared_person'))).error, 'VAULT_OWNER_ONLY')
    }
    assert.equal(backend.calls.length, before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── 6. Wiring ──────────────────────────────────────────────────────────────

test('wiring: the daemon lists the vault tools and admits them only through the private turn gate', () => {
  const server = readFileSync(join(ROOT, 'server.ts'), 'utf8')
  assert.ok(server.includes('...VAULT_TOOL_DECLS'), 'tool list spreads VAULT_TOOL_DECLS')
  assert.ok(server.includes("req.params.name.startsWith('vault_')"), 'vault_ calls pass the private turn gate')
  assert.ok(new RegExp(PRIVATE_TOOL_MATCHER).test('mcp__bgos__vault_fill_prepare'))
  const hooks = readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')
  assert.ok(hooks.includes('vault_.+'))
  // Only the terminal command may display the fingerprint.
  assert.ok(!/hostFingerprint|showFingerprintOnTerminal/.test(server))
  assert.ok(!/hostFingerprint|showFingerprintOnTerminal/.test(readFileSync(join(ROOT, 'lib', 'vault-tools.ts'), 'utf8')))
})

test('wiring: hoai vault-host reaches the terminal command', async () => {
  const { resolveHoaiAction, USAGE } = await import('../bin/hoai-core.mjs')
  assert.deepEqual(resolveHoaiAction(['vault-host', 'status']), { action: 'vault-host', rest: ['status'], fresh: false, force: false })
  assert.match(USAGE, /hoai vault-host/)
})

test('host key: a key another process created first is kept, not replaced', { skip: !posix }, async () => {
  const dir = tempDir()
  try {
    const first = loadOrCreateHostKey(dir, ASSISTANT)
    const fs = await import('node:fs')
    let hidden = true
    // This process looks before the other one's file lands, then loses the race to create it.
    const racing = { ...fs, existsSync: (p: Parameters<typeof fs.existsSync>[0]) => (String(p).endsWith(VAULT_HOST_FILE_NAME) && hidden ? (hidden = false) : fs.existsSync(p)) } as typeof fs
    const second = loadOrCreateHostKey(dir, ASSISTANT, racing)
    assert.equal(second.hostSeed, first.hostSeed)
    assert.equal(readHostRecord(dir)!.hostSeed, first.hostSeed)
    assert.deepEqual(fs.readdirSync(dir), [VAULT_HOST_FILE_NAME], 'no temporary file left behind')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
