import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { VAULT_HOST_FILE_NAME, hostFingerprint, hostPinStatus, readHostRecord, testSecurity } from './helpers/vault-host.mjs'
import { ensureAutoHost, vaultAutoHostDisabled } from '../lib/vault-host-auto.mjs'
import { handleVaultTool } from '../lib/vault-tools.ts'
import { checkHostKeyProof, checkSignedRequest } from './fixtures/vault-server-contract.ts'
import { scratchDir } from './helpers/scratch-dirs.ts'

// The agent vault with no setup (HOAI design 2026-11-12, CORE-CONTRACTS 18.8).
// The machine makes its own keys with no terminal, offers only public halves
// under its pairing credential, and pins itself only when the server names its
// own keys as installed. Each test names the guard it keeps.
// No em dashes or en dashes in this file.

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const ASSISTANT = 42
const OWNER = 'user_fixture_owner'
const PAIRING = 'fixture-pairing-credential-0001'
const API = 'https://api.example.test/api/v1'
const posix = process.platform !== 'win32'
const PREFIX = `/api/v1/vault/agent/${ASSISTANT}`

function tempDir(): string {
  return join(scratchDir('vault-auto-'), 'vault')
}

interface Call { method: string; path: string; headers: Record<string, string>; body: string }

/**
 * A fake HOAI server for the offer routes, written from the wire contract. It
 * keeps one registered host and one standing offer, like the real one, and
 * `accept()` is the owner's app accepting the standing offer.
 */
function server(opts: { off?: boolean; down?: boolean; installedKeys?: { identityPublic: string; publicKey: string } | null; lieInstalled?: boolean } = {}) {
  const calls: Call[] = []
  const state = {
    host: (opts.installedKeys ?? null) as { identityPublic: string; publicKey: string } | null,
    offer: null as { identityPublic: string; publicKey: string; keySignature: string } | null,
    problems: [] as string[],
  }
  const same = (a: { identityPublic: string; publicKey: string } | null, b: { identityPublic: string; publicKey: string } | null) =>
    !!a && !!b && a.identityPublic === b.identityPublic && a.publicKey === b.publicKey
  const view = (mine: { identityPublic: string; publicKey: string } | null) => {
    const installed = opts.lieInstalled ? { identityPublic: 'not-this-machine', publicKey: 'not-this-machine' } : state.host
    const status = opts.lieInstalled ? 'installed' : state.host ? (mine && !same(state.host, mine) ? 'change_offered' : 'installed') : (mine ?? state.offer) ? 'offered' : 'none'
    return { status, installed }
  }
  const fetch = async (url: string | URL, init: RequestInit = {}) => {
    if (opts.down) throw new Error('network down')
    const u = new URL(String(url))
    const method = String(init.method ?? 'GET')
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const body = typeof init.body === 'string' ? init.body : ''
    calls.push({ method, path: u.pathname, headers, body })
    const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    if (opts.off) return reply(404, { message: 'Not found.' })
    if (headers['x-bgos-pairing'] !== PAIRING) return reply(401, {})
    if (u.pathname === `${PREFIX}/host-offer` && method === 'GET') return reply(200, view(null))
    if (u.pathname === `${PREFIX}/host-offer` && method === 'POST') {
      const parsed = JSON.parse(body)
      if (Object.keys(parsed).sort().join() !== 'identityPublic,keySignature,publicKey') return reply(400, {})
      if (!checkHostKeyProof({ ownerId: OWNER, assistantId: ASSISTANT, identityPublic: parsed.identityPublic, publicKey: parsed.publicKey, signature: parsed.keySignature }))
        return reply(403, { message: 'Invalid signed host key.' })
      if (!same(state.host, parsed)) state.offer = parsed
      return reply(201, view(parsed))
    }
    if (u.pathname === `${PREFIX}/host-offer/problem` && method === 'POST') {
      state.problems.push(JSON.parse(body).code)
      return reply(201, { recorded: true })
    }
    return reply(404, {})
  }
  return { calls, state, fetch: fetch as unknown as typeof globalThis.fetch, accept() { state.host = { identityPublic: state.offer!.identityPublic, publicKey: state.offer!.publicKey }; state.offer = null } }
}

function run(dir: string, fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) {
  const logs: string[] = []
  return ensureAutoHost({ stateDir: dir, assistantId: ASSISTANT, ownerId: OWNER, apiBase: API, pairingToken: PAIRING, fetch, security: testSecurity, log: (line: string) => logs.push(line), env: {}, ...extra })
    .then((result: { status: string; code?: string }) => ({ result, logs }))
}

test('zero setup: with no terminal and no pasted key the machine makes its own keys and offers only the public halves', async () => {
  const dir = tempDir()
  const s = server()
  const { result, logs } = await run(dir, s.fetch)
  assert.equal(result.status, 'offered')
  const record = (await readHostRecord(dir))!
  assert.ok(record.hostSeed && record.signingSecret && record.identityPublic, 'both keys were made here')
  assert.equal(hostPinStatus(record), 'unregistered', 'an offer alone is not a registration')
  const post = s.calls.find((c) => c.method === 'POST' && c.path === `${PREFIX}/host-offer`)!
  assert.deepEqual(JSON.parse(post.body), { identityPublic: record.identityPublic, publicKey: record.publicKey, keySignature: JSON.parse(post.body).keySignature })
  // The independent proof, checked by a second opinion of the server contract.
  assert.ok(checkHostKeyProof({ ownerId: OWNER, assistantId: ASSISTANT, identityPublic: record.identityPublic, publicKey: record.publicKey, signature: JSON.parse(post.body).keySignature }))
  // Nothing private, and no fingerprint, crosses the wire or reaches the log.
  const wire = s.calls.map((c) => `${c.path} ${JSON.stringify(c.headers)} ${c.body}`).join('\n') + logs.join('\n')
  for (const secret of [record.hostSeed, record.signingSecret, hostFingerprint(record.identityPublic, record.publicKey)])
    assert.ok(!wire.includes(secret), 'a private value or the fingerprint left this machine')
  assert.ok(!logs.join('\n').includes(PAIRING), 'the pairing credential reached the log')
  // The pairing credential authenticates; no A2A headers exist before the identity is installed.
  assert.ok(s.calls.every((c) => c.headers['x-bgos-pairing'] === PAIRING && !c.headers['x-bgos-a2a-signature']))
})

test('zero setup: the key file is owner only (0600 in a 0700 folder)', { skip: !posix }, async () => {
  const dir = tempDir()
  await run(dir, server().fetch)
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  assert.equal(fs.statSync(join(dir, VAULT_HOST_FILE_NAME)).mode & 0o777, 0o600)
})

test('zero setup: once the owner app accepted, the machine records its registration and pin, and signs vault calls from then', async () => {
  const dir = tempDir()
  const s = server()
  await run(dir, s.fetch)
  s.accept()
  const { result } = await run(dir, s.fetch)
  assert.equal(result.status, 'installed')
  const record = (await readHostRecord(dir))!
  assert.equal(hostPinStatus(record), 'pinned')
  assert.equal(record.registration.ownerId, OWNER)
  // A third run is quiet: same keys, still pinned, one identity for good.
  const again = await run(dir, s.fetch)
  assert.equal(again.result.status, 'installed')
  assert.equal((await readHostRecord(dir))!.identityPublic, record.identityPublic)
})

test('zero setup: the keys are made once; a second run offers the same keys', async () => {
  const dir = tempDir()
  const s = server()
  await run(dir, s.fetch)
  const first = (await readHostRecord(dir))!
  await run(dir, s.fetch)
  const second = (await readHostRecord(dir))!
  assert.equal(second.hostSeed, first.hostSeed)
  assert.equal(second.signingSecret, first.signingSecret)
  const offers = s.calls.filter((c) => c.method === 'POST' && c.path === `${PREFIX}/host-offer`).map((c) => JSON.parse(c.body).publicKey)
  assert.deepEqual([...new Set(offers)], [first.publicKey])
})

test('zero setup: a server that names other keys as installed never makes this machine pin itself', async () => {
  const dir = tempDir()
  const { result } = await run(dir, server({ lieInstalled: true }).fetch)
  assert.notEqual(result.status, 'installed')
  assert.notEqual(hostPinStatus((await readHostRecord(dir))!), 'pinned')
})

test('zero setup: a machine that was pinned and is no longer the installed host drops its own pin', async () => {
  const dir = tempDir()
  const s = server()
  await run(dir, s.fetch)
  s.accept()
  await run(dir, s.fetch)
  assert.equal(hostPinStatus((await readHostRecord(dir))!), 'pinned')
  // The owner approved another computer for this agent.
  s.state.host = { identityPublic: 'another-computer', publicKey: 'another-computer' }
  const { result } = await run(dir, s.fetch)
  assert.equal(result.status, 'change_offered')
  assert.notEqual(hostPinStatus((await readHostRecord(dir))!), 'pinned')
})

test('zero setup: a server without the feature (404) changes nothing: no key file, no offer', async () => {
  const dir = tempDir()
  const s = server({ off: true })
  const { result } = await run(dir, s.fetch)
  assert.equal(result.status, 'off')
  assert.equal(fs.existsSync(join(dir, VAULT_HOST_FILE_NAME)), false)
  assert.deepEqual(s.calls.map((c) => c.method), ['GET'])
})

test('zero setup: the kill switch and a daemon that is not paired do nothing at all', async () => {
  const dir = tempDir()
  const s = server()
  for (const value of ['0', 'false', 'OFF', ' no ']) {
    assert.equal(vaultAutoHostDisabled({ HOAI_VAULT_AUTO_HOST: value }), true)
    const { result } = await run(dir, s.fetch, { env: { HOAI_VAULT_AUTO_HOST: value } })
    assert.equal(result.status, 'disabled')
  }
  assert.equal(vaultAutoHostDisabled({}), false)
  assert.equal(vaultAutoHostDisabled({ HOAI_VAULT_AUTO_HOST: '1' }), false)
  const unpaired = await run(dir, s.fetch, { pairingToken: '' })
  assert.equal(unpaired.result.status, 'unavailable')
  assert.equal(s.calls.length, 0)
  assert.equal(fs.existsSync(join(dir, VAULT_HOST_FILE_NAME)), false)
})

test('zero setup: the server being unreachable is not an error and leaves the keys alone', async () => {
  const dir = tempDir()
  const { result } = await run(dir, server({ down: true }).fetch)
  assert.equal(result.status, 'unavailable')
})

test('zero setup: a damaged key file is replaced by a fresh one, with no terminal', async () => {
  const dir = tempDir()
  const s = server()
  await run(dir, s.fetch)
  const before = (await readHostRecord(dir))!
  fs.writeFileSync(join(dir, VAULT_HOST_FILE_NAME), '{ not json', { mode: 0o600 })
  const { result } = await run(dir, s.fetch)
  assert.equal(result.status, 'offered')
  const after = (await readHostRecord(dir))!
  assert.notEqual(after.publicKey, before.publicKey)
  assert.equal(hostPinStatus(after), 'unregistered')
})

test('zero setup: a key file other accounts could read is never used; a fresh key replaces it', { skip: !posix }, async () => {
  const dir = tempDir()
  const s = server()
  await run(dir, s.fetch)
  const before = (await readHostRecord(dir))!
  fs.chmodSync(join(dir, VAULT_HOST_FILE_NAME), 0o644)
  const { result } = await run(dir, s.fetch)
  assert.equal(result.status, 'offered')
  const after = (await readHostRecord(dir))!
  assert.notEqual(after.hostSeed, before.hostSeed, 'the exposed key was not kept')
  assert.equal(fs.statSync(join(dir, VAULT_HOST_FILE_NAME)).mode & 0o777, 0o600)
  const offered = s.calls.filter((c) => c.method === 'POST' && c.path === `${PREFIX}/host-offer`).map((c) => JSON.parse(c.body).publicKey)
  assert.ok(!offered.slice(1).includes(before.publicKey), 'the exposed key was never offered again')
})

// -- Windows: the same guard on every OS, through the injected ACL reader ----------

const SID = 'S-1-5-21-1000'
const OTHER = 'S-1-5-21-2000'
const safeAcl = () => ({ ownerSid: SID, userSid: SID, protected: true, entries: [{ sid: SID, type: 'Allow', rights: 2032127 }] })
function windows(opts: { restrictFails?: boolean } = {}) {
  const acls = new Map<string, ReturnType<typeof safeAcl>>()
  const restricted: string[] = []
  const checked: string[] = []
  const security = {
    platform: 'win32' as const,
    async readWindowsAcl(path: string) { checked.push(path); return acls.get(path) ?? (opts.restrictFails ? { ...safeAcl(), protected: false } : safeAcl()) },
    async restrictWindowsAcl(path: string) { if (opts.restrictFails) throw new Error('Set-Acl refused'); restricted.push(path); acls.set(path, safeAcl()) },
  }
  return { acls, restricted, checked, security }
}

test('Windows: with no terminal the folder and an empty file are protected and verified before any key is written', async () => {
  const dir = tempDir()
  const w = windows()
  const s = server()
  const descriptors = new Map<number, string>()
  let keyWrites = 0
  const guarded = { ...fs, openSync(path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) {
    const fd = fs.openSync(path, flags, mode)
    descriptors.set(fd, String(path))
    return fd
  }, writeFileSync(path: fs.PathOrFileDescriptor, data: string, options: any) {
    if (String(data).includes('hostSeed')) {
      keyWrites++
      const name = typeof path === 'number' ? descriptors.get(path)! : String(path)
      assert.ok(w.restricted.includes(name), 'the temporary file was protected first')
      assert.ok(w.checked.includes(name), 'its ACL was read back first')
    }
    return fs.writeFileSync(path, data, options)
  } } as typeof fs
  const { result } = await run(dir, s.fetch, { security: w.security, fs: guarded })
  assert.equal(result.status, 'offered')
  assert.ok(keyWrites >= 2, 'the host key and the identity were both written')
  assert.ok(w.restricted.includes(dir), 'the folder was protected')
})

test('Windows: a key file another account can read is replaced, and the exposed key is never offered', async () => {
  const dir = tempDir()
  const w = windows()
  const s = server()
  await run(dir, s.fetch, { security: w.security })
  const before = (await readHostRecord(dir, fs, w.security))!
  const exposed = safeAcl()
  exposed.entries.push({ sid: OTHER, type: 'Allow', rights: 1 })
  w.acls.set(join(dir, VAULT_HOST_FILE_NAME), exposed)
  // A deleted file takes its access list with it, as on a real disk.
  const disk = { ...fs, unlinkSync(path: fs.PathLike) { w.acls.delete(String(path)); return fs.unlinkSync(path) } } as typeof fs
  const { result } = await run(dir, s.fetch, { security: w.security, fs: disk })
  assert.equal(result.status, 'offered')
  const after = (await readHostRecord(dir, fs, w.security))!
  assert.notEqual(after.hostSeed, before.hostSeed)
  const offered = s.calls.filter((c) => c.method === 'POST' && c.path === `${PREFIX}/host-offer`).map((c) => JSON.parse(c.body).publicKey)
  assert.deepEqual(offered, [before.publicKey, after.publicKey])
})

test('Windows: when the folder cannot be protected no key is written, and the owner is told why with a fixed code', async () => {
  const dir = tempDir()
  const w = windows({ restrictFails: true })
  const s = server()
  const { result, logs } = await run(dir, s.fetch, { security: w.security })
  assert.deepEqual(result, { status: 'problem', code: 'key_exposed' })
  assert.deepEqual(s.state.problems, ['key_exposed'])
  assert.equal(fs.existsSync(join(dir, VAULT_HOST_FILE_NAME)), false)
  const problem = s.calls.find((c) => c.path === `${PREFIX}/host-offer/problem`)!
  assert.deepEqual(JSON.parse(problem.body), { code: 'key_exposed' })
  assert.ok(!logs.join('\n').includes(dir), 'no path in the log line')
})

// -- Review findings (2026-11-12, cold read of the first build) -------------------------------

// A disk whose protection check takes real time, as PowerShell does on Windows: every check yields to the
// event loop, so two runs in one process interleave the way two processes do.
function slowDisk(ms = 3) {
  const w = windows()
  return { ...w.security, async readWindowsAcl(path: string) { await new Promise((r) => setTimeout(r, ms)); return w.security.readWindowsAcl(path) } }
}

test('review 3: two runs at once end on ONE identity, and the server holds the same one as the disk', async () => {
  const dir = tempDir()
  const s = server()
  const security = slowDisk()
  // One run is slower than the other, as two processes are: without a lock each makes its own identity.
  const [a, b] = await Promise.all([run(dir, s.fetch, { security }), run(dir, s.fetch, { security: slowDisk(11) })])
  assert.equal(a.result.status, 'offered')
  assert.equal(b.result.status, 'offered')
  const record = (await readHostRecord(dir, fs, security))!
  const offered = s.calls.filter((c) => c.method === 'POST' && c.path === `${PREFIX}/host-offer`).map((c) => JSON.parse(c.body).identityPublic)
  assert.deepEqual([...new Set(offered)], [record.identityPublic], 'one identity was offered, the one on disk')
  assert.equal(s.state.offer!.identityPublic, record.identityPublic)
})

test('review 3: the same on a machine that had a host key and no identity yet (an earlier tool call made it)', async () => {
  const dir = tempDir()
  const { loadOrCreateHostKey } = await import('./helpers/vault-host.mjs')
  const security = slowDisk()
  await loadOrCreateHostKey(dir, ASSISTANT, fs, security)
  const s = server()
  await Promise.all([run(dir, s.fetch, { security }), run(dir, s.fetch, { security: slowDisk(7) }), run(dir, s.fetch, { security: slowDisk(13) })])
  const record = (await readHostRecord(dir, fs, security))!
  const offered = s.calls.filter((c) => c.method === 'POST' && c.path === `${PREFIX}/host-offer`).map((c) => JSON.parse(c.body).identityPublic)
  assert.deepEqual([...new Set(offered)], [record.identityPublic])
})

test('review 3: a lock left behind by a run that died does not block the machine for good', async () => {
  const dir = tempDir()
  fs.mkdirSync(join(dir, '..'), { recursive: true })
  const lock = `${dir}.setup.lock`
  fs.writeFileSync(lock, '')
  const old = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(lock, old, old)
  const { result } = await run(dir, server().fetch)
  assert.equal(result.status, 'offered')
  assert.equal(fs.existsSync(lock), false, 'the lock is released')
})

test('review 4: Windows, the access list cannot be READ (a slow or blocked PowerShell): a good key is left alone', async () => {
  const dir = tempDir()
  const w = windows()
  const s = server()
  await run(dir, s.fetch, { security: w.security })
  const before = fs.readFileSync(join(dir, VAULT_HOST_FILE_NAME), 'utf8')
  const flaky = { ...w.security, async readWindowsAcl() { throw new Error('powershell timed out') } }
  const { result } = await run(dir, s.fetch, { security: flaky })
  assert.equal(result.status, 'unavailable')
  assert.equal(fs.readFileSync(join(dir, VAULT_HOST_FILE_NAME), 'utf8'), before, 'the key file was not touched')
  assert.deepEqual(s.state.problems, [], 'and it is not reported as exposed')
  // An unreadable answer (not an access list at all) is the same: unknown, not exposed.
  const garbled = { ...w.security, async readWindowsAcl() { return null } }
  assert.equal((await run(dir, s.fetch, { security: garbled })).result.status, 'unavailable')
  assert.equal(fs.readFileSync(join(dir, VAULT_HOST_FILE_NAME), 'utf8'), before)
})

test('review 4: a key file owned by another account is not ours to delete', { skip: !posix }, async () => {
  const dir = tempDir()
  const s = server()
  await run(dir, s.fetch)
  const before = fs.readFileSync(join(dir, VAULT_HOST_FILE_NAME), 'utf8')
  const other = (process.getuid?.() ?? 0) + 1
  const foreign = { ...fs, lstatSync(path: fs.PathLike) { const st = fs.lstatSync(path); return String(path).endsWith(VAULT_HOST_FILE_NAME) ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: other }) : st } } as typeof fs
  const { result } = await run(dir, s.fetch, { fs: foreign })
  assert.equal(result.status, 'unavailable')
  assert.equal(fs.readFileSync(join(dir, VAULT_HOST_FILE_NAME), 'utf8'), before)
})

test('review 4: a key file that belongs to another agent is reported, never deleted', async () => {
  const dir = tempDir()
  const { loadOrCreateHostKey } = await import('./helpers/vault-host.mjs')
  await loadOrCreateHostKey(dir, 999)
  const before = fs.readFileSync(join(dir, VAULT_HOST_FILE_NAME), 'utf8')
  const s = server()
  const { result } = await run(dir, s.fetch)
  assert.deepEqual(result, { status: 'problem', code: 'key_invalid' })
  assert.equal(fs.readFileSync(join(dir, VAULT_HOST_FILE_NAME), 'utf8'), before)
})

test('review 2: the tools ask the server before any key exists; while HOAI cannot be reached no key is made and nobody is sent to a terminal', async () => {
  const dir = tempDir()
  const s = server({ down: true })
  const result = await handleVaultTool('vault_items', {}, toolDeps(dir, s.fetch, []))
  const answer = JSON.parse(text(result))
  assert.equal(answer.error, 'VAULT_HOST_SETUP_RETRY')
  assert.doesNotMatch(answer.message, /terminal|hoai vault-host|fingerprint|paste/i)
  assert.equal(fs.existsSync(join(dir, VAULT_HOST_FILE_NAME)), false)
})

test('review 5: a machine that is set up but could not check in is told to try later, with no terminal', async () => {
  const dir = tempDir()
  const s = server()
  await run(dir, s.fetch)
  // Keys exist, not pinned, and now the server cannot be reached.
  const result = await handleVaultTool('vault_fill_prepare', { itemId: '0b6f2a1e-3c4d-4e5f-8a9b-0c1d2e3f4a5b', sessionId: 's', tabId: 't', origin: 'https://example.test' }, toolDeps(dir, server({ down: true }).fetch, []))
  const answer = JSON.parse(text(result))
  assert.equal(answer.error, 'VAULT_HOST_SETUP_RETRY')
  assert.doesNotMatch(answer.message, /terminal|hoai vault-host|fingerprint/i)
})

test('review 2: with the feature off the probe still comes first, then the older first use stands as it was', async () => {
  const dir = tempDir()
  const s = server({ off: true })
  let keyFileAtProbe: boolean | null = null
  const watching = (async (url: string | URL, init?: RequestInit) => {
    keyFileAtProbe ??= fs.existsSync(join(dir, VAULT_HOST_FILE_NAME))
    return s.fetch(url as string, init)
  }) as unknown as typeof globalThis.fetch
  const result = await handleVaultTool('vault_items', {}, toolDeps(dir, watching, []))
  assert.equal(JSON.parse(text(result)).error, 'VAULT_HOST_SETUP_REQUIRED')
  assert.equal(keyFileAtProbe, false, 'no key existed when the server was asked')
})

// -- The vault tools: no terminal is ever asked for ---------------------------------------

function toolDeps(dir: string, fetch: typeof globalThis.fetch, logs: string[], autoFetch = fetch) {
  return {
    security: testSecurity, assistantId: ASSISTANT, ownerId: OWNER, actingUserId: OWNER, apiBase: API, pairingToken: PAIRING, stateDir: dir, fetch,
    log: (line: string) => logs.push(line),
    autoHost: () => ensureAutoHost({ stateDir: dir, assistantId: ASSISTANT, ownerId: OWNER, apiBase: API, pairingToken: PAIRING, fetch: autoFetch, security: testSecurity, env: {} }),
  }
}
const text = (result: { content: Array<{ text: string }> }) => result.content[0].text

test('tools: first use offers the key by itself and says setup is finishing, never to open a terminal', async () => {
  const dir = tempDir()
  const s = server()
  const logs: string[] = []
  const result = await handleVaultTool('vault_items', {}, toolDeps(dir, s.fetch, logs))
  assert.equal(result.isError, true)
  const answer = JSON.parse(text(result))
  assert.equal(answer.error, 'VAULT_HOST_SETUP_PENDING')
  assert.doesNotMatch(answer.message, /terminal|hoai vault-host|fingerprint|paste/i)
  assert.ok(s.state.offer, 'the machine offered its key on first use')
})

test('tools: after the owner app accepted, the same tool works with no further step', async () => {
  const dir = tempDir()
  const s = server()
  const logs: string[] = []
  await handleVaultTool('vault_items', {}, toolDeps(dir, s.fetch, logs))
  s.accept()
  const record = (await readHostRecord(dir))!
  // The vault API itself: the server contract's signed request check, with the installed identity.
  const api = async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url))
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>))
    const reason = checkSignedRequest({ method: String(init.method ?? 'GET'), path: u.pathname, assistantId: ASSISTANT, identityPublic: s.state.host!.identityPublic, pairingToken: PAIRING, headers, body: typeof init.body === 'string' ? init.body : '' })
    if (reason) return new Response('{}', { status: 403 })
    return new Response(JSON.stringify({ items: [] }), { status: 200 })
  }
  const result = await handleVaultTool('vault_items', {}, toolDeps(dir, api as unknown as typeof globalThis.fetch, logs, s.fetch))
  assert.equal(result.isError, undefined, text(result))
  assert.deepEqual(JSON.parse(text(result)), { items: [] })
  assert.equal(hostPinStatus((await readHostRecord(dir))!), 'pinned')
  assert.equal((await readHostRecord(dir))!.identityPublic, record.identityPublic)
})

test('tools: a new key on a machine the owner already set up says the owner sees a question, and nothing is requested', async () => {
  const dir = tempDir()
  const s = server({ installedKeys: { identityPublic: 'the-old-computer', publicKey: 'the-old-computer' } })
  const logs: string[] = []
  const result = await handleVaultTool('vault_fill_prepare', { itemId: '0b6f2a1e-3c4d-4e5f-8a9b-0c1d2e3f4a5b', sessionId: 's', tabId: 't', origin: 'https://example.test' }, toolDeps(dir, s.fetch, logs))
  const answer = JSON.parse(text(result))
  assert.equal(answer.error, 'VAULT_HOST_CHANGE_PENDING')
  assert.doesNotMatch(answer.message, /terminal|hoai vault-host|fingerprint/i)
  assert.ok(!s.calls.some((c) => /\/items/.test(c.path)), 'no vault item call before the owner decided')
})

test('tools: with the feature off on the server the older answer stands unchanged', async () => {
  const dir = tempDir()
  const s = server({ off: true })
  const result = await handleVaultTool('vault_items', {}, toolDeps(dir, s.fetch, []))
  assert.equal(JSON.parse(text(result)).error, 'VAULT_HOST_SETUP_REQUIRED')
})

test('tools: a turn admitted for anyone but the owner offers nothing', async () => {
  const dir = tempDir()
  const s = server()
  const deps = { ...toolDeps(dir, s.fetch, []), actingUserId: 'someone-else' }
  const result = await handleVaultTool('vault_items', {}, deps)
  assert.equal(JSON.parse(text(result)).error, 'VAULT_OWNER_ONLY')
  assert.equal(s.calls.length, 0)
  assert.equal(fs.existsSync(join(dir, VAULT_HOST_FILE_NAME)), false)
})

// -- Wiring -------------------------------------------------------------------------------------------

test('wiring: the armed daemon offers at start and on the server frame, and the tools get the auto host', () => {
  const source = fs.readFileSync(join(ROOT, 'server.ts'), 'utf8')
  assert.match(source, /realtimeSocket\.on\('vault_host_setup', whenArmed\('vault_host_setup',/)
  assert.match(source, /autoHost: \(\) => runVaultAutoHost\(/)
  assert.ok([...source.matchAll(/runVaultAutoHost\('armed'\)/g)].length >= 1, 'the daemon offers when it arms')
  // The frame carries ids and a status only; the handler passes nothing from it into a key.
  const handler = source.slice(source.indexOf("realtimeSocket.on('vault_host_setup'"))
  assert.match(handler.slice(0, 600), /Number\(frame\?\.assistantId\) !== Number\(ASSISTANT_ID\)/)
})

test('wiring: hoai vault-host auto needs no terminal', () => {
  const home = scratchDir('vault-auto-home-')
  const out = spawnSync(process.execPath, [join(ROOT, 'bin', 'hoai-vault-host.mjs'), 'auto'], {
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, BGOS_ASSISTANT_ID: '', BGOS_PAIRING_TOKEN: '', BGOS_CREDENTIALS_PATH: join(home, 'none.json') }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert.doesNotMatch(out.stderr, /must run in a terminal/)
  assert.match(out.stderr, /not paired|agent folder/i)
  assert.equal(out.status, 1)
})

// -- Found on a real Windows 11 PC (2026-11-12) ------------------------------------------------
// The first run on Windows ended in "key_exposed" with a perfectly private key file: each PowerShell access list
// call took 4 to 6 seconds there, one passed the time limit, and a call that could not run was read as "exposed".

/** A PC whose PowerShell stops answering once the host key file exists, for `misses` reads (Infinity: for good). */
function slowPowerShellAfterTheHostKey(dir: string, misses: number) {
  const w = windows()
  let slow = false
  let missed = 0
  const disk = { ...fs, existsSync(path: fs.PathLike) {
    const there = fs.existsSync(path)
    if (there && String(path) === join(dir, VAULT_HOST_FILE_NAME)) slow = true
    return there
  } } as typeof fs
  const security = { ...w.security, async readWindowsAcl(path: string) {
    if (slow && missed < misses) { missed++; throw new Error('powershell timed out') }
    return w.security.readWindowsAcl(path)
  } }
  return { disk, security, heal() { missed = misses = 0 } }
}

test('real Windows: a PowerShell too slow to answer while the identity is stored is not an exposed key', async () => {
  const dir = tempDir()
  const s = server()
  const pc = slowPowerShellAfterTheHostKey(dir, Infinity)
  const { result, logs } = await run(dir, s.fetch, { security: pc.security, fs: pc.disk, sleep: async () => {} })
  assert.deepEqual(result, { status: 'unavailable', retry: true }, 'not a problem: try again later')
  assert.deepEqual(s.state.problems, [], 'the owner is not told a key was exposed')
  assert.ok(!logs.join('\n').includes('key_exposed'))
  const kept = fs.readFileSync(join(dir, VAULT_HOST_FILE_NAME), 'utf8')
  // PowerShell answers again: the next run finishes with the SAME host key.
  pc.heal()
  const again = await run(dir, s.fetch, { security: pc.security, fs: pc.disk, sleep: async () => {} })
  assert.equal(again.result.status, 'offered')
  assert.equal(JSON.parse(fs.readFileSync(join(dir, VAULT_HOST_FILE_NAME), 'utf8')).hostSeed, JSON.parse(kept).hostSeed)
})

test('real Windows: one slow PowerShell answer does not fail the setup; the same run tries again and finishes', async () => {
  const dir = tempDir()
  const s = server()
  const pc = slowPowerShellAfterTheHostKey(dir, 1)
  const waits: number[] = []
  const { result } = await run(dir, s.fetch, { security: pc.security, fs: pc.disk, sleep: async (ms: number) => { waits.push(ms) } })
  assert.equal(result.status, 'offered')
  assert.deepEqual(s.state.problems, [])
  assert.equal(waits.length, 1, 'it paused once and tried again')
})

test('real Windows: a setup slower than the lock is old keeps its lock, so a second run cannot start beside it', async () => {
  const dir = tempDir()
  const s = server()
  // Every access list read takes 25 ms, so one setup takes far longer than the 60 ms after which a lock counts as abandoned.
  const lock = { staleMs: 60, beatMs: 10, waitMs: 5 }
  const first = run(dir, s.fetch, { security: slowDisk(25), lock })
  await new Promise((r) => setTimeout(r, 150))
  const second = await run(dir, s.fetch, { security: slowDisk(25), lock })
  assert.equal(second.result.status, 'unavailable', 'the second run stands back: the first one is alive')
  assert.equal((await first).result.status, 'offered')
  const record = (await readHostRecord(dir, fs, slowDisk(0)))!
  const offered = s.calls.filter((c) => c.method === 'POST' && c.path === `${PREFIX}/host-offer`).map((c) => JSON.parse(c.body).identityPublic)
  assert.deepEqual([...new Set(offered)], [record.identityPublic], 'one identity, the one on disk')
})

test('real Windows: the access list command waits 30 seconds, tries once more when PowerShell was cut off, and not when it answered no', async () => {
  const { createWindowsVaultSecurity } = await import('../lib/vault-host.mjs')
  const acl = JSON.stringify(safeAcl())
  const seen: number[] = []
  let calls = 0
  // First call: killed at the time limit, as execFile reports it. Second call: answers.
  const cutOffOnce = (_file: string, _args: string[], options: { timeout: number }, done: (error: unknown, stdout: string) => void) => {
    seen.push(options.timeout)
    calls++
    if (calls === 1) done(Object.assign(new Error('timed out'), { killed: true, code: null, signal: 'SIGTERM' }), '')
    else done(null, acl)
  }
  assert.deepEqual(await createWindowsVaultSecurity({ execFileImpl: cutOffOnce as any }).readWindowsAcl('C:\\x'), safeAcl())
  assert.equal(calls, 2)
  assert.deepEqual(seen, [30_000, 30_000])
  // PowerShell ran and refused (exit code 1): that is an answer, and asking again would only double the wait.
  let refused = 0
  const refuses = (_file: string, _args: string[], _options: unknown, done: (error: unknown, stdout: string) => void) => { refused++; done(Object.assign(new Error('exit 1'), { killed: false, code: 1 }), '') }
  await assert.rejects(createWindowsVaultSecurity({ execFileImpl: refuses as any }).readWindowsAcl('C:\\x'))
  assert.equal(refused, 1)
})

test('real Windows: protecting a path and reading it back is ONE PowerShell start, and a first host key costs four', async () => {
  const { createWindowsVaultSecurity, loadOrCreateHostKey } = await import('../lib/vault-host.mjs')
  const dir = tempDir()
  let starts = 0
  // A PowerShell that always answers with a private access list, as a healthy PC does.
  const healthy = (_file: string, _args: string[], _options: unknown, done: (error: unknown, stdout: string) => void) => { starts++; done(null, JSON.stringify(safeAcl())) }
  const security = createWindowsVaultSecurity({ execFileImpl: healthy as any })
  await loadOrCreateHostKey(dir, ASSISTANT, fs, security)
  // The folder (protect and read back: 1), the empty file (1), then the folder and the key file checked once more (2).
  assert.equal(starts, 4)
})

test('wiring: the daemon tries again by itself when this computer could not check its key file', () => {
  const source = fs.readFileSync(join(ROOT, 'server.ts'), 'utf8')
  assert.match(source, /result\.status === 'unavailable' && result\.retry === true && vaultAutoHostRetries < VAULT_AUTO_HOST_RETRIES/)
  assert.match(source, /setTimeout\(\(\) => \{ void runVaultAutoHost\('retry'\) \}/)
})

// -- Review of 2026-11-13, finding 4 -----------------------------------------------------------------------------
// Only an owner app that carries the zero setup half (HOAI 5.28.3 or later) ever accepts an offer. Where the server
// takes offers and the owner's app is older, the words "finishes by itself" were a promise nobody could keep, and
// `hoai vault-host` stopped there with no way on. The agent now names the app version it needs, and the terminal
// names the older way out.
test('review finding 4: a waiting offer says which HOAI app finishes it; the agent still sends nobody to a terminal', async () => {
  const dir = tempDir()
  const result = await handleVaultTool('vault_items', {}, toolDeps(dir, server().fetch, []))
  const answer = JSON.parse(text(result))
  assert.equal(answer.error, 'VAULT_HOST_SETUP_PENDING')
  assert.match(answer.message, /HOAI 5\.28\.3 or later/)
  assert.match(answer.message, /update HOAI/i)
  assert.doesNotMatch(answer.message, /terminal|hoai vault-host|fingerprint|paste/i)
})

test('review finding 4: in a terminal, a waiting offer names the older setup as the way out for an older app', async () => {
  const { AUTO_TEXT } = await import('../bin/hoai-vault-host.mjs')
  for (const state of ['offered', 'change_offered'] as const) {
    assert.match(AUTO_TEXT[state], /HOAI 5\.28\.3 or later/, state)
    assert.match(AUTO_TEXT[state], /hoai vault-host --new-signing-key/, state)
  }
  // The states that need nothing from anyone say nothing of it.
  assert.doesNotMatch(AUTO_TEXT.installed, /new-signing-key/)
})
