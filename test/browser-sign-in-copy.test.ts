// The agent machine's side of sealed sign-ins (portable browser design, section 6):
// it opens its copy with its own key, keeps it sealed at rest, puts it in the
// browser with nobody there, and never lets a value reach a file, a log or a tool
// result. Made up accounts only. No em or en dashes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { AgentSignInCopy, portableStateOf, storageStateOf } from '../lib/browser-sign-in-copy.mjs'

const require = createRequire(import.meta.url)
const copyCore = require('../lib/browser-profile-core/sign-in-copy.js')
const { identityFingerprint } = require('../lib/browser-profile-core/crypto.js')

function endpoint() {
  const signing = generateKeyPairSync('ed25519'), encryption = generateKeyPairSync('x25519')
  const identity = { version: 1, endpointId: randomUUID(), signingPublicKey: signing.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), encryptionPublicKey: encryption.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') }
  return { identity, signingPrivateKey: signing.privateKey, encryptionPrivateKey: encryption.privateKey }
}
const COOKIE = 'SYNTHETIC_MACHINE_COOKIE_91', STORAGE = 'SYNTHETIC_MACHINE_STORAGE_92'
const SCOPE = { profileId: randomUUID(), actingUserId: 'user_fixture_maya', assistantId: 42 }
const STATE = copyCore.signInStateOf({
  cookies: [{ name: 'sid', value: COOKIE, domain: 'crm.example', path: '/', expires: -1, size: 3, httpOnly: true, secure: true, session: true, priority: 'Medium', sourceScheme: 'Secure', sourcePort: 443, sameSite: 'Lax' }],
  origins: [{ schema: 'hoai-origin-storage-v1', origin: 'https://crm.example', localStorage: [{ name: 't', value: STORAGE }], indexedDB: [] }],
  preferences: { v: 1, searchEngine: 'google' },
})
function rig(t: any) {
  const directory = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'hoai-sign-in-copy-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const computer = endpoint(), machine = endpoint()
  const held: any = { copies: [], uploads: [], reads: [] }
  const client = {
    read: async (input: any) => { held.reads.push(input); return { copies: held.copies, peers: [{ endpointId: computer.identity.endpointId, keyFingerprint: identityFingerprint(computer.identity), grantVersion: 1 }] } },
    upload: async (profileId: string, copy: any, sites: string[]) => { held.uploads.push({ profileId, copy, sites }) },
  }
  const seal = (sequence = 5, source = computer, state = STATE) => copyCore.sealSignInCopy({ state, scope: SCOPE, source, sequence, createdAt: sequence,
    recipient: { identity: machine.identity, keyFingerprint: identityFingerprint(machine.identity), grantVersion: 3 } })
  const logs: string[] = []
  const make = () => new AgentSignInCopy({ directory, scope: SCOPE, endpoint: machine, grantVersion: 3, peers: [computer.identity], client, log: ((line: string) => logs.push(line)) as any })
  return { directory, computer, machine, held, seal, make, logs, client }
}
const fakeContext = () => {
  const applied: any[] = []
  return { applied, setStorageState: async (state: any) => { applied.push(state) }, storageState: async () => ({ cookies: [{ name: 'back', value: COOKIE, domain: 'crm.example', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [{ origin: 'https://crm.example', localStorage: [{ name: 't', value: STORAGE }] }] }) }
}
const everyFile = (directory: string) => readdirSync(directory, { recursive: true } as any).map((name: any) => join(directory, String(name))).filter((file: string) => statSync(file).isFile())

test('it takes the newest copy from a pinned computer and puts it in the browser, with nobody there', async (t) => {
  const r = rig(t), holder = r.make(), context = fakeContext()
  r.held.copies = [r.seal(5)]
  assert.equal(await holder.applyTo(context), true)
  assert.equal(context.applied.length, 1)
  assert.equal(context.applied[0].cookies[0].value, COOKIE)
  assert.equal(context.applied[0].origins[0].localStorage[0].value, STORAGE)
})

test('on disk it is sealed: no value and no site name in any file, and the file is private', async (t) => {
  const r = rig(t), holder = r.make()
  r.held.copies = [r.seal(5)]
  await holder.applyTo(fakeContext())
  const files = everyFile(r.directory)
  assert.ok(files.length >= 1)
  for (const file of files) {
    const text = readFileSync(file).toString('latin1')
    for (const secret of [COOKIE, STORAGE, 'crm.example', 'SYNTHETIC']) assert.equal(text.includes(secret), false, secret)
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o077, 0, file)
  }
})

test('after a restart with the server gone it still opens, from its own sealed file and its own key', async (t) => {
  const r = rig(t)
  r.held.copies = [r.seal(5)]
  await r.make().applyTo(fakeContext())
  r.client.read = async () => { throw new Error('offline') }
  const context = fakeContext()
  assert.equal(await r.make().applyTo(context), true)
  assert.equal(context.applied[0].cookies[0].value, COOKIE)
})

test('a sealed file is useless without this machine key: another machine, or a changed file, opens nothing', async (t) => {
  const r = rig(t)
  r.held.copies = [r.seal(5)]
  await r.make().applyTo(fakeContext())
  r.client.read = (async () => ({ copies: [] })) as any
  const other = new AgentSignInCopy({ directory: r.directory, scope: SCOPE, endpoint: endpoint(), grantVersion: 3, peers: [], client: r.client, log: () => {} })
  const context = fakeContext()
  assert.equal(await other.applyTo(context), false)
  assert.equal(context.applied.length, 0)
  const file = everyFile(r.directory)[0]
  const bytes = readFileSync(file); bytes[bytes.length - 3] ^= 1; writeFileSync(file, bytes)
  const tampered = fakeContext()
  assert.equal(await r.make().applyTo(tampered), false)
  assert.equal(tampered.applied.length, 0)
})

test('an unpinned source is refused: the server cannot plant a sign-in', async (t) => {
  const r = rig(t), context = fakeContext(), forger = endpoint()
  r.held.copies = [r.seal(5, forger)]
  assert.equal(await r.make().applyTo(context), false)
  assert.equal(context.applied.length, 0)
})

test('an older copy never replaces a newer one, across a restart', async (t) => {
  const r = rig(t), first = r.make()
  r.held.copies = [r.seal(9)]
  await first.applyTo(fakeContext())
  const older = copyCore.signInStateOf({ cookies: [{ ...STATE.cookies[0], value: 'SYNTHETIC_OLDER' }], origins: [], preferences: STATE.preferences })
  r.held.copies = [r.seal(3, r.computer, older)]
  const context = fakeContext()
  await r.make().applyTo(context)
  assert.equal(context.applied[0].cookies[0].value, COOKIE)
})

test('a copy holding a password is refused and nothing is kept', async (t) => {
  const r = rig(t), context = fakeContext()
  const bad = copyCore.__sealUncheckedForTests({ state: { ...STATE, passwordVault: { v: 1, entries: [{ id: randomUUID(), origin: 'https://crm.example', username: 'maya@example.invalid', password: 'SYNTHETIC_PASSWORD_93', name: 'Fixture', createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z' }], neverOrigins: [] } },
    scope: SCOPE, source: r.computer, sequence: 5, createdAt: 5, recipient: { identity: r.machine.identity, keyFingerprint: identityFingerprint(r.machine.identity), grantVersion: 3 } })
  r.held.copies = [bad]
  assert.equal(await r.make().applyTo(context), false)
  assert.equal(everyFile(r.directory).length, 0)
})

test('nothing it logs or reports carries a value', async (t) => {
  const r = rig(t), holder = r.make(), context = fakeContext()
  r.held.copies = [r.seal(5), r.seal(6, endpoint())]
  const answer = await holder.status()
  await holder.applyTo(context)
  await holder.sendBack(context)
  const said = JSON.stringify([r.logs, answer, await holder.status()])
  assert.equal(said.includes('SYNTHETIC'), false)
  assert.equal(said.includes('crm.example'), false)
})

/** A browser that holds nothing as a copy opens, and then has a sign-in made in it. */
function signedInAfterOpen() {
  const context: any = fakeContext(), later = context.storageState
  context.storageState = async () => ({ cookies: [], origins: [] })
  return { context, signIn() { context.storageState = later } }
}

test('a sign-in made here goes back sealed to the pinned computer only', async (t) => {
  const r = rig(t), holder = r.make(), { context, signIn } = signedInAfterOpen()
  r.held.copies = [r.seal(5)]
  assert.equal(await holder.applyTo(context), true)
  signIn()
  await holder.sendBack(context)
  assert.equal(r.held.uploads.length, 1)
  const { copy, sites } = r.held.uploads[0]
  assert.deepEqual(sites, ['crm.example'])
  assert.equal(JSON.stringify(copy).includes('SYNTHETIC'), false)
  const opened = copyCore.openSignInCopy({ copy, sourceIdentity: r.machine.identity, recipient: r.computer, expected: { ...SCOPE, afterSequence: 0, recipient: { endpointId: r.computer.identity.endpointId, keyFingerprint: identityFingerprint(r.computer.identity), grantVersion: 1 } } })
  assert.equal(opened.state.cookies[0].value, COOKIE)
  assert.equal(opened.state.origins[0].localStorage[0].value, STORAGE)
})

test('with nobody pinned nothing goes back: the server cannot name a receiver', async (t) => {
  const r = rig(t)
  const holder = new AgentSignInCopy({ directory: r.directory, scope: SCOPE, endpoint: r.machine, grantVersion: 3, peers: [], client: r.client, log: () => {} })
  await holder.sendBack(fakeContext())
  assert.deepEqual(r.held.uploads, [])
})

test('the two state shapes convert without losing a cookie field the computer requires', () => {
  const portable = portableStateOf({ cookies: [{ name: 'a', value: 'b', domain: 'x.example', path: '/', expires: 1893456000, httpOnly: false, secure: false, sameSite: 'Strict' }], origins: [{ origin: 'https://x.example', localStorage: [{ name: 'k', value: 'v' }] }] })
  const row = portable.cookies[0]
  assert.deepEqual({ session: row.session, priority: row.priority, sourceScheme: row.sourceScheme, sourcePort: row.sourcePort, size: row.size }, { session: false, priority: 'Medium', sourceScheme: 'NonSecure', sourcePort: 80, size: 2 })
  assert.equal(portable.origins[0].schema, 'hoai-origin-storage-v1')
  const storage = storageStateOf(portable)
  assert.deepEqual(storage.cookies[0], { name: 'a', value: 'b', domain: 'x.example', path: '/', expires: 1893456000, httpOnly: false, secure: false, sameSite: 'Strict' })
  assert.deepEqual(storage.origins[0], { origin: 'https://x.example', localStorage: [{ name: 'k', value: 'v' }] })
})

test('a computer whose key the server changed gets nothing back, whatever grant it names', async (t) => {
  const r = rig(t), holder = r.make()
  const { context, signIn } = signedInAfterOpen()
  r.held.copies = [r.seal(5)]
  assert.equal(await holder.applyTo(context), true)
  signIn()
  r.client.read = async () => ({ copies: [], peers: [{ endpointId: r.computer.identity.endpointId, keyFingerprint: 'a'.repeat(64), grantVersion: 1 }] })
  await holder.sendBack(context)
  assert.deepEqual(r.held.uploads, [])
})

// The pool's two moments, on the real pool with a stand in engine.
test('the pool puts sign-ins in as a browser opens and sends them back as it closes; neither can stop it', async (t) => {
  const { BrowserPool } = await import('../bin/hoai-browser-host.mjs')
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'hoai-sign-in-pool-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const calls: string[] = []
  const context = fakeContext()
  const makeEngine = () => ({ alive: true, vault: { context }, start: async () => {}, stop: async () => {}, pages: () => [] })
  const holder = { applyTo: async (c: any) => { calls.push(c === context ? 'apply' : 'wrong'); return true }, sendBack: async (c: any) => { calls.push(c === context ? 'send' : 'wrong') }, dispose: () => calls.push('dispose') }
  const pool = new BrowserPool({ agentRoot: root, createEngine: makeEngine, loadSignIns: async () => holder } as any)
  const ctx = { assistantId: 7, principal: 'user-fixture' }
  const slot = await pool.acquire(ctx)
  assert.equal(slot.signInsApplied, true)
  await pool.release(ctx)
  assert.deepEqual(calls, ['apply', 'send', 'dispose'])
  const failing = new BrowserPool({ agentRoot: root, createEngine: makeEngine, loadSignIns: async () => { throw new Error('locked') } } as any)
  const opened = await failing.acquire(ctx)
  assert.ok(opened.engine, 'a locked key store never stops a browser')
  assert.equal(opened.signInsApplied, false)
  await failing.release(ctx)
  const broken = new BrowserPool({ agentRoot: root, createEngine: makeEngine, loadSignIns: async () => ({ applyTo: async () => true, sendBack: async () => { throw new Error('x') }, dispose: () => {} }) } as any)
  await broken.acquire(ctx)
  await broken.release(ctx)
})


// Without a card a person on a phone has no way into a browser on the machine.
test('a browser opening on the machine posts its live card, naming the machine, and ending it posts the end', async (t) => {
  const { sessionCardPayload } = await import('../bin/hoai-browser-host.mjs')
  const open = sessionCardPayload({ sessionId: 'bs_x', seq: 1, state: 'browsing', agentName: 'Atlas', purpose: 'Check the CRM', startedAt: '2026-11-04T00:00:00.000Z' })
  assert.equal(open.placement, 'daemon')
  assert.equal(open.kind, 'browser_session')
  assert.equal(open.state, 'browsing')
  assert.equal(open.purpose, 'Check the CRM')
  const ended = sessionCardPayload({ sessionId: 'bs_x', seq: 2, state: 'ended', agentName: 'Atlas', purpose: 'Check the CRM', startedAt: '2026-11-04T00:00:00.000Z' })
  assert.equal(ended.state, 'ended')
  assert.equal(ended.seq, 2)
})

// The brief's limit: no value reaches the agent. These tools read page code, headers
// and page logs, and a machine's browser now holds a person's sign-ins.
test('no tool that can read a cookie, a header or stored value is served, or answers if called', async () => {
  const { servedBrowserTools, PRIVATE_PAGE_TOOLS, BrowserHostCore } = await import('../bin/hoai-browser-host.mjs')
  const names = ['browser_evaluate', 'browser_console_messages', 'browser_network_requests', 'browser_network_request']
  assert.deepEqual([...PRIVATE_PAGE_TOOLS].sort(), [...names].sort())
  const served = servedBrowserTools([...names, 'browser_snapshot', 'browser_click'].map(name => ({ name, inputSchema: { type: 'object', properties: {} } }))).map((row: any) => row.name)
  assert.deepEqual(served.sort(), ['browser_click', 'browser_snapshot'])
  const pool = { acquire: async () => { throw new Error('must not reach the browser') }, peek: () => null, slotKey: () => 'x' }
  const core = new BrowserHostCore({ pool, browserTools: async () => [], deviceLabel: 'x' } as any)
  for (const name of names) {
    const answer = await core._call({ assistantId: 1, principal: 'user-x' }, name, { function: '() => document.cookie' }, undefined)
    assert.equal(answer.isError, true, name)
    assert.match(answer.content[0].text, /not available/, name)
  }
})

