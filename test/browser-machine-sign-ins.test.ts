/**
 * Whose sign-ins a browser on the agent's machine gets, and when it gets none. This runs
 * the real loadMachineSignIns over a real state folder: real catalog and peer pin files,
 * real signed requests to a local stand in for the server. Only the OS key store is a
 * stand in here; the real Keychain run is in the BGOS evidence.
 * Made up accounts only. No em or en dashes in this file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { AgentProfileCompanionState } from '../lib/browser-profile-companion-state.mjs'
import { AgentProfilePeerPins } from '../lib/browser-profile-peer-pins.mjs'
import { AgentSignInCopy, agentSharesHostUser, loadMachineSignIns } from '../lib/browser-sign-in-copy.mjs'

const require = createRequire(import.meta.url)
const codec = require('../lib/browser-profile-core/crypto.js')
const copyCore = require('../lib/browser-profile-core/sign-in-copy.js')

const OWNER = 'user_fixture_maya', ASSISTANT = 42, PAIRING = 7, VALUE = 'SYNTHETIC_MACHINE_COOKIE_71'
const STATE = copyCore.signInStateOf({
  cookies: [{ name: 'sid', value: VALUE, domain: 'crm.example', path: '/', expires: -1, size: 3, httpOnly: true, secure: true, session: true, priority: 'Medium', sourceScheme: 'Secure', sourcePort: 443 }],
  origins: [], preferences: { v: 1, searchEngine: 'google' },
})

/** A machine as it stands on disk after a person approved it, and a local stand in for the server's routes. */
async function machine(t: any, { backgroundUse = true, grant = 3 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-machine-')))
  const endpoint = codec.createEndpointIdentity(randomUUID()), computer = codec.createEndpointIdentity(randomUUID()), profileId = randomUUID()
  const fingerprint = codec.identityFingerprint(endpoint.identity)
  const seen = { keyReads: 0, routes: [] as string[] }
  const copies: any[] = [], listed = { none: false }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const route = String(req.url).replace('/api/v1/browser/profile-sync/', '')
      seen.routes.push(route)
      const input = body ? JSON.parse(body) : {}
      const json = (value: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
      if (route.endsWith('/enrollment')) return json({ purpose: 'enrollment-identity', profileId, actingUserId: OWNER, assistantId: ASSISTANT, endpointId: endpoint.identity.endpointId, keyFingerprint: fingerprint, pairingId: PAIRING, ownerUserId: OWNER, pinnedIdentity: endpoint.identity })
      if (route.endsWith('/discovery')) return json({ requestId: input.requestId, endpointId: endpoint.identity.endpointId, expiresAt: input.expiresAt, nextCursor: null, profiles: listed.none ? [] : [{ profile: { id: profileId, actingUserId: OWNER, assistantId: ASSISTANT, revision: 0, headManifestHash: null, contentKeyEpoch: 1, writerEpoch: 0, writerState: 'idle', endpointId: null, bootId: null, runtimeId: null, sessionId: null }, grant: { generation: grant, backgroundUse }, pendingDestinations: [] }] })
      if (route.endsWith('/sign-in-copies/read')) return json({ copies, peers: [{ endpointId: computer.identity.endpointId, keyFingerprint: codec.identityFingerprint(computer.identity), grantVersion: 1 }] })
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const backendUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }) })
  const folder = join(root, '.browser-profile-sync', createHash('sha256').update(new URL(backendUrl).origin).digest('hex'))
  const scope = { profileId, actingUserId: OWNER, assistantId: ASSISTANT, endpointId: endpoint.identity.endpointId, keyFingerprint: fingerprint, pairingId: PAIRING, ownerUserId: OWNER }
  const binding = { profileId, actingUserId: OWNER, assistantId: ASSISTANT, endpointId: endpoint.identity.endpointId, keyFingerprint: fingerprint, grantVersion: grant, keyEpoch: 1, backgroundUse: true }
  const record = { version: 1, provider: 'macos-keychain-v1', recordId: randomUUID(), binding, keys: { version: 1, identityFingerprint: fingerprint, ciphertext: 'c2VhbGVk' } }
  await new AgentProfileCompanionState({ directory: join(folder, 'endpoints') }).saveNew({ version: 1, scope, identity: endpoint.identity, keyRecord: record }, () => true)
  const pinScope = { profileId, actingUserId: OWNER, assistantId: ASSISTANT, endpointId: endpoint.identity.endpointId, keyFingerprint: fingerprint }
  const document = { version: 1, kind: 'agent-peer-pin-review', profileId, actingUserId: OWNER, assistantId: ASSISTANT, agentEndpointId: endpoint.identity.endpointId, agentKeyFingerprint: fingerprint, peerIdentity: computer.identity, peerKeyFingerprint: codec.identityFingerprint(computer.identity) }
  await new AgentProfilePeerPins({ directory: join(folder, 'peer-pins', endpoint.identity.endpointId) }).review({ scope: pinScope, endpoint, document, confirmation: document.peerKeyFingerprint, assertCurrent: () => true })
  const keyStore = { restore: async () => { seen.keyReads++; return endpoint } }
  const pairing = { token: 'made-up-pairing-token', backendUrl, pairingId: PAIRING, ownerUserId: OWNER, assistantIds: [ASSISTANT] }
  const seal = (sequence: number) => copyCore.sealSignInCopy({ state: STATE, scope: { profileId, actingUserId: OWNER, assistantId: ASSISTANT }, source: computer, sequence, createdAt: sequence, recipient: { identity: endpoint.identity, keyFingerprint: fingerprint, grantVersion: grant } })
  const separate = () => false
  const load = (extra: any = {}) => loadMachineSignIns({ agentRoot: root, pairing, assistantId: ASSISTANT, principal: `user-${OWNER}`, keyStore, sharesUser: separate, ...extra } as any)
  return { root, folder, seen, copies, seal, load, endpoint, computer, profileId, noProfiles() { listed.none = true } }
}

const context = (storage: any = { cookies: [], origins: [] }) => { const row = { state: storage, set: 0, async setStorageState(value: any) { row.state = value; row.set++ }, async storageState() { return row.state } }; return row }

test('the real load opens a copy on a machine whose agent runs as another OS user, with the real pin and grant read', async (t) => {
  const f = await machine(t)
  f.copies.push(f.seal(5))
  const holder: any = await f.load()
  assert.ok(holder instanceof AgentSignInCopy, 'an approved machine gets its holder')
  const browser = context()
  assert.equal(await holder.applyTo(browser), true)
  assert.equal(browser.state.cookies[0].value, VALUE)
  assert.equal(f.seen.keyReads, 1, 'through the key store')
  assert.ok(f.seen.routes.some(route => route.endsWith('/discovery')) && f.seen.routes.some(route => route.endsWith('/sign-in-copies/read')))
  assert.equal((holder as any).peers[0].endpointId, f.computer.identity.endpointId, 'the reviewed computer, from its signed pin file')
  assert.equal((holder as any).grantVersion, 3, 'the grant the server states now')
})

test('a share recipient\'s browser gets nothing of the owner\'s, and neither does a room or another agent', async (t) => {
  const f = await machine(t)
  assert.equal(await f.load({ principal: 'user-someone_else' }), null, 'another person')
  assert.equal(await f.load({ principal: 'room-1' }), null, 'a room')
  assert.equal(await f.load({ assistantId: 43 }), null, 'another agent')
  assert.equal(f.seen.keyReads, 0, 'and no key was read for any of them')
})

test('a grant without background use opens nothing', async (t) => {
  const f = await machine(t, { backgroundUse: false })
  await assert.rejects(f.load())
  assert.equal(f.seen.keyReads, 1)
})

test('where the agent shares the host\'s OS user the copy is refused before any key is read, and what was kept goes', async (t) => {
  const f = await machine(t)
  mkdirSync(join(f.folder, 'sign-ins'), { recursive: true, mode: 0o700 })
  writeFileSync(join(f.folder, 'sign-ins', `${f.endpoint.identity.endpointId}.sealed`), 'kept from an earlier version')
  writeFileSync(join(f.folder, 'sign-ins', `${randomUUID()}.tmp`), 'left by a crash')
  f.copies.push(f.seal(5))
  const lines: string[] = []
  const holder: any = await f.load({ sharesUser: () => true, log: (line: string) => lines.push(line) })
  assert.equal(holder.refused, true)
  const browser = context()
  assert.equal(await holder.applyTo(browser), false)
  assert.equal(await holder.sendBack(browser), 0)
  assert.equal(browser.set, 0)
  assert.equal(f.seen.keyReads, 0, 'the key store is never asked')
  assert.deepEqual(f.seen.routes, [], 'and no copy is fetched')
  assert.deepEqual(readdirSync(join(f.folder, 'sign-ins')), [], 'and no sealed copy stays beside the agent')
  assert.ok(lines.some(line => /same OS user/.test(line)))
  assert.equal(JSON.stringify(lines).includes(VALUE), false)
})

test('a server that lists no profile for this endpoint opens nothing, after its key was only checked', async (t) => {
  const f = await machine(t)
  f.noProfiles()
  assert.equal(await f.load(), null)
})

test('a machine with no endpoint for this person hears nothing about sign-ins, on either kind of machine', async (t) => {
  const f = await machine(t)
  assert.equal(await f.load({ sharesUser: () => true, principal: 'user-someone_else' }), null)
})

test('the check that decides this fails closed: only a folder another ordinary user owns reads as separate', { skip: process.platform === 'win32' && 'no OS user ids here' }, () => {
  const stat = (uid: number): any => () => ({ uid })
  assert.equal(agentSharesHostUser({ agentRoot: '/a', getuid: () => 501, stat: stat(501) }), true, 'the agent\'s folder is the host\'s own')
  assert.equal(agentSharesHostUser({ agentRoot: '/a', getuid: () => 501, stat: stat(502) }), false, 'another user owns it')
  assert.equal(agentSharesHostUser({ agentRoot: '/a', getuid: () => 501, stat: stat(0) }), true, 'root owning it proves no separation')
  assert.equal(agentSharesHostUser({ agentRoot: '/a', getuid: () => 0, stat: stat(502) }), false, 'a host run as root by an administrator, the agent as a user')
  assert.equal(agentSharesHostUser({ agentRoot: '/a', getuid: null as any, stat: stat(502) }), true, 'no user ids on this system')
  assert.equal(agentSharesHostUser({ agentRoot: '/a', getuid: () => 501, stat: (() => { throw new Error('gone') }) as any }), true, 'cannot read it')
})

test('CONTROL: on this machine, under this test, the real check reads the real folder as shared', { skip: process.platform === 'win32' && 'no OS user ids here' }, async (t) => {
  const f = await machine(t)
  assert.equal(agentSharesHostUser({ agentRoot: f.root }), true)
  assert.equal(statSync(f.root).uid, process.getuid!())
  const holder: any = await loadMachineSignIns({ agentRoot: f.root, pairing: { token: 'made-up', backendUrl: 'http://127.0.0.1:1', pairingId: PAIRING, ownerUserId: OWNER, assistantIds: [ASSISTANT] }, assistantId: ASSISTANT, principal: `user-${OWNER}` } as any)
  assert.equal(holder, null, 'another origin holds no endpoint for it, and the default never reaches a key store')
})

// P2-1 on the machine: what goes back.
function holderOf(t: any, sent: any[] = []) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-sign-in-back-')))
  chmodSync(directory, 0o700)
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const computer = codec.createEndpointIdentity(randomUUID()), me = codec.createEndpointIdentity(randomUUID())
  const scope = { profileId: randomUUID(), actingUserId: OWNER, assistantId: ASSISTANT }
  const held: any = { copies: [] }
  const client = {
    read: async () => ({ copies: held.copies, peers: [{ endpointId: computer.identity.endpointId, keyFingerprint: codec.identityFingerprint(computer.identity), grantVersion: 1 }] }),
    upload: async (_id: string, copy: any, sites: string[]) => { sent.push({ copy, sites }) },
  }
  const holder = new AgentSignInCopy({ directory, scope, endpoint: me, grantVersion: 3, peers: [computer.identity], client })
  held.copies.push(copyCore.sealSignInCopy({ state: STATE, scope, source: computer, sequence: 9, createdAt: 9, recipient: { identity: me.identity, keyFingerprint: codec.identityFingerprint(me.identity), grantVersion: 3 } }))
  const opened = (copy: any) => copyCore.openSignInCopy({ copy, sourceIdentity: me.identity, recipient: computer, expected: { ...scope, afterSequence: 0, recipient: { endpointId: computer.identity.endpointId, keyFingerprint: codec.identityFingerprint(computer.identity), grantVersion: 1 } } }).state
  return { holder, opened, held }
}
const cookieRow = (name: string, domain: string, value: string) => ({ name, value, domain, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' })

test('no copy applied, nothing goes back: an anonymous visit never overwrites a person\'s login', async (t) => {
  const sent: any[] = [], { holder, held } = holderOf(t, sent)
  held.copies.length = 0
  const browser = context({ cookies: [cookieRow('_gh_sess', 'github.com', 'ANON')], origins: [] })
  assert.equal(await holder.applyTo(browser), false)
  assert.equal(await holder.sendBack(browser), 0)
  assert.deepEqual(sent, [])
})

test('a copy applied and nothing changed: nothing goes back', async (t) => {
  const sent: any[] = [], { holder } = holderOf(t, sent)
  const browser = context()
  assert.equal(await holder.applyTo(browser), true)
  assert.equal(await holder.sendBack(browser), 0)
  assert.deepEqual(sent, [])
})

test('only the sites that changed since the copy opened go back, and the rest stays out', async (t) => {
  const sent: any[] = [], { holder, opened } = holderOf(t, sent)
  const browser = context()
  assert.equal(await holder.applyTo(browser), true)
  browser.state = { cookies: [...browser.state.cookies, cookieRow('sid', 'signed-in-here.example', 'NEW')], origins: [] }
  assert.equal(await holder.sendBack(browser), 1)
  assert.deepEqual(sent[0].sites, ['signed-in-here.example'])
  const state = opened(sent[0].copy)
  assert.deepEqual(state.cookies.map((row: any) => row.domain), ['signed-in-here.example'], 'the site this machine only read stays with the person')
})

// Found by the real run on 2026-11-04. An approved machine has an enrolled record and no managed browser, and
// the host refused every browser call for that person, so a sealed copy could never open and the refusal
// sentence could never be said. Only a managed browser that exists, or is starting, owns the namespace.
test('a person approved on this machine with no managed browser running reaches the ordinary browser; one running does not', async () => {
  const { AgentBrowserProfileCompanion } = await import('../lib/browser-profile-companion.mjs')
  const call = { assistantId: ASSISTANT, principal: `user-${OWNER}` }, row = (extra: any = {}) => ({ scope: { assistantId: ASSISTANT, actingUserId: OWNER }, runtime: null, ...extra })
  const has = (records: any[], candidates: any[] = []) => AgentBrowserProfileCompanion.prototype.hasNamespace.call({ records: new Map(records.map((value, index) => [index, value])), candidates: new Map(candidates.map((value, index) => [index, value])) }, call)
  assert.equal(has([row()]), false, 'enrolled, nothing running')
  assert.equal(has([], [row()]), false, 'a pending enrollment owns no browser')
  assert.equal(has([row({ runtime: {} })]), true, 'a managed browser is running')
  assert.equal(has([row({ runtimeCreating: Promise.resolve() })]), true, 'or starting')
  assert.equal(has([row({ returnTask: Promise.resolve() })]), true, 'or coming back')
  assert.equal(AgentBrowserProfileCompanion.prototype.hasNamespace.call({ records: new Map([[0, row({ runtime: {} })]]), candidates: new Map() }, { ...call, principal: 'user-someone_else' }), false, 'and it owns only its own person')
})

// The computer seals a copy only to a machine proved to run its host as another OS user, and the machine has no
// way to claim that: the agent next to it holds the same key. Vendored core, the machine's own copy of the rule.
test('the shared rule: an approved machine with no proof is not one a copy is sealed to', async () => {
  const machine = codec.createEndpointIdentity(randomUUID()), computer = codec.createEndpointIdentity(randomUUID()), uploads: any[] = []
  assert.equal(copyCore.machineProvedSeparateUser({ kind: 'agent' }), false)
  assert.equal(copyCore.machineProvedSeparateUser({ kind: 'agent', separateOsUser: true }), true, 'CONTROL')
  const row = (extra: any) => ({ identity: machine.identity, keyFingerprint: codec.identityFingerprint(machine.identity), grantVersion: 3, signInsOnly: true, ...extra })
  const send = (recipient: any) => copyCore.sendSignInCopies({ client: { upload: async (_id: string, copy: any) => { uploads.push(copy) } }, state: { cookies: STATE.cookies, origins: [], preferences: STATE.preferences }, scope: { profileId: randomUUID(), actingUserId: OWNER, assistantId: ASSISTANT }, source: computer, recipients: [recipient] })
  assert.deepEqual(await send(row({})), [])
  assert.equal(uploads.length, 0)
  assert.equal((await send(row({ signInsProved: true }))).length, 1, 'CONTROL: the same machine, proved')
})

test('nothing on this machine can claim the proof, and the agent is told the sign-ins never came here', async () => {
  const { readFileSync, readdirSync } = await import('node:fs')
  const { SIGN_IN_STAYS_SENTENCE } = await import('../bin/hoai-browser-host.mjs')
  const { fileURLToPath } = await import('node:url')
  // fileURLToPath, never URL.pathname: on Windows the pathname is /D:/... and join() makes D:\D:\...
  const root = fileURLToPath(new URL('..', import.meta.url))
  const claims = (dir: string) => readdirSync(join(root, dir)).filter(name => /\.(mjs|ts)$/.test(name) && /separateOsUser|signInsProved/.test(readFileSync(join(root, dir, name), 'utf8')))
  assert.deepEqual(claims('lib'), [])
  assert.deepEqual(claims('bin'), [])
  assert.match(SIGN_IN_STAYS_SENTENCE, /stay on their computer/)
  assert.match(SIGN_IN_STAYS_SENTENCE, /no copy comes to this machine/)
  assert.match(SIGN_IN_STAYS_SENTENCE, /same OS user/)
})
