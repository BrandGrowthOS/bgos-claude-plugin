import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { AgentProfileFiles } from '../lib/browser-profile-files.mjs'
const require = createRequire(import.meta.url), codec = require('../lib/browser-profile-core/crypto.js'), cryptoFiles = require('../lib/browser-profile-core/profile-file-crypto.js'), { ProfileFileClient } = require('../lib/browser-profile-core/profile-file-client.js'), { documentSignature } = require('../lib/browser-profile-core/coordinator-client.js')
type Row = Record<string, any>
class Page extends EventEmitter { address = 'https://site.test/upload'; url() { return this.address } isClosed() { return false } }
const decoded = (value: Row) => JSON.parse(value.content.filter((item: Row) => item.type === 'text').at(-1).text)
async function fixture(t: { after: (fn: () => unknown) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hoai-file-runner-')), agent = codec.createEndpointIdentity(randomUUID()), human = codec.createEndpointIdentity(randomUUID()), scope = { profileId: randomUUID(), actingUserId: 'recipient', assistantId: 42 }
  const own = { endpointId: agent.identity.endpointId, keyFingerprint: codec.identityFingerprint(agent.identity), grantVersion: 3 }, authority = { ...scope, ...own, bootId: 'boot', runtimeId: 'runtime', sessionId: 'session', writerEpoch: 3, revision: 1, contentKeyEpoch: 1 }, peer = { endpointId: human.identity.endpointId, keyFingerprint: codec.identityFingerprint(human.identity), grantVersion: 7 }
  const rows = new Map<string, Row>(), calls: Row[] = [], state: Row = { changed: false, after: null, engine: null }, page = new Page(), originalSignal = new AbortController().signal
  const check = () => { if (state.changed) throw Error('fixture runtime changed'); return true }, response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  const fetchImpl = async (url: string, input: Row) => {
    const pathname = new URL(url).pathname, proof = input.headers['X-HOAI-File-Proof'] ? JSON.parse(Buffer.from(input.headers['X-HOAI-File-Proof'], 'base64url').toString()) : JSON.parse(input.body), document = proof.document
    assert.equal(input.headers.Authorization, undefined); assert.equal(input.headers['X-BGOS-Pairing'], 'fixture-pairing'); calls.push({ pathname, input })
    let output: Response
    if (pathname.endsWith('/files/pending')) {
      assert.equal(document.version, 2); assert.equal(document.endpointId, own.endpointId); assert.deepEqual(document.reviewedPeers, [human.identity])
      output = response({ version: 2, authority: document.authority, endpointId: document.endpointId, queryNonce: document.queryNonce, expiresAt: document.expiresAt, peers: [{ kind: 'desktop', ownerUserId: 'recipient', pairingId: null, identity: human.identity, keyFingerprint: peer.keyFingerprint, grantVersion: 7, backgroundUse: false }], files: [...rows.values()].filter(row => ['offered', 'allowed', 'available'].includes(row.state)).map(({ payload, ...row }) => row) })
    } else if (pathname.endsWith('/files')) {
      const offer = proof.offer; cryptoFiles.verifyOffer({ ...proof, expectedContext: cryptoFiles.offerContext(offer), sourceIdentity: agent.identity }); assert.equal(rows.has(offer.fileId), false)
      const row = { ...proof, offerHash: cryptoFiles.offerHash(offer, proof.signature), consent: null, state: 'offered', uploadAttemptedAt: null, claimedAt: null, current: true, uploadOutcome: 'not-uploaded', payload: null }; rows.set(offer.fileId, row); const { payload, ...status } = row; output = response(status)
    } else {
      const fileId = pathname.split('/files/')[1].split('/')[0], row = rows.get(fileId)!; assert.ok(row)
      if (pathname.endsWith('/read')) { const { payload, ...status } = row; output = response(status) }
      else if (pathname.endsWith('/content')) { assert.equal(row.state, 'allowed'); assert.equal(row.payload, null); row.payload = Buffer.from(input.body); row.state = 'available'; row.uploadAttemptedAt = Date.now(); row.uploadOutcome = 'confirmed'; const { payload, ...status } = row; output = response(status) }
      else if (pathname.endsWith('/claim')) { assert.equal(row.state, 'available'); const payload = row.payload; row.payload = null; row.state = 'claimed'; row.claimedAt = Date.now(); output = new Response(payload, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(payload.length), 'x-hoai-file-hash': row.offer.ciphertextHash } }) }
      else throw Error('unexpected fixture route')
    }
    return state.after ? state.after(pathname, output) : output
  }
  const client = new ProfileFileClient({ origin: 'http://127.0.0.1:18751', principal: 'paired', authorize: async () => ({ token: 'fixture-pairing', pairingId: 7, ownerUserId: 'sharer', assistantId: 42, assertCurrent: check }), fetchImpl })
  const engine: Row = { selectedPage: () => page, async callTool(name: string, args: Row, signal: AbortSignal) { signal?.throwIfAborted(); calls.push({ engine: name, args }); if (state.engine) return state.engine(name, args); if (name === 'browser_file_upload') return { content: [{ type: 'text', text: (await fs.readFile(args.paths[0])).toString() }] }; await fs.writeFile(args.filename, Buffer.from('SYNTHETIC BROWSER ARTIFACT')); return { content: [{ type: 'text', text: 'Internal output ' + args.filename }] } } }
  // Real temporary I/O and shared staging. This injected proof is synthetic;
  // actual Linux ownership/mode qualification belongs to the native probe.
  const createArea = async ({ directory, assertCurrent }: Row) => { assertCurrent(); await fs.mkdir(directory, { recursive: true }); return { directory, assertPrivateDirectory: async (target: string) => { const stat = await fs.lstat(target); assert.equal(stat.isSymbolicLink(), false); assert.ok(target === directory || target.startsWith(directory + path.sep)); return true } } }
  const runner: any = new AgentProfileFiles({ client, authority, endpoint: agent, directory: path.join(root, 'files'), peerIdentities: async (callback: () => unknown) => { callback(); return [human.identity] }, assertCurrent: check, createArea })
  const allow = (row: Row) => { const document = { version: 1, kind: 'agent-browser-file-consent', fileId: row.offer.fileId, offerHash: row.offerHash, endpointId: human.identity.endpointId, keyFingerprint: peer.keyFingerprint, choice: 'allow_once', nonce: randomBytes(32).toString('base64url'), expiresAt: row.offer.expiresAt }; row.consent = { document, signature: documentSignature(human, document) }; row.state = 'allowed' }
  const incoming = (text = 'SYNTHETIC HUMAN FILE') => { const plaintext = Buffer.from(text), context = { version: 1, kind: 'agent-browser-file-offer', fileId: randomUUID(), nonce: randomBytes(32).toString('base64url'), direction: 'to-agent', authority, source: peer, destination: own, expiresAt: Date.now() + 120000, plaintextBytes: plaintext.length }, sealed = cryptoFiles.sealFile({ plaintext, fileName: 'chosen.txt', contentType: 'text/plain', context, source: human, destinationIdentity: agent.identity }), row: Row = { offer: sealed.offer, signature: sealed.signature, offerHash: cryptoFiles.offerHash(sealed.offer, sealed.signature), consent: null, state: 'offered', current: true, uploadOutcome: 'not-uploaded', uploadAttemptedAt: null, claimedAt: null, payload: sealed.payload }; allow(row); row.state = 'available'; row.uploadOutcome = 'confirmed'; row.uploadAttemptedAt = Date.now(); rows.set(row.offer.fileId, row); return row }
  const list = async () => decoded(await runner.list({ assertCurrent: check, signal: originalSignal }))
  const capture = async (args = {}) => decoded(await runner.capture({ name: 'browser_pdf_save', args, assertCurrent: check, signal: originalSignal, execute: (name: string, input: Row) => engine.callTool(name, input, originalSignal) }))
  t.after(async () => { await runner.dispose().catch(() => {}); for (const row of rows.values()) row.payload?.fill(0); await fs.rm(root, { recursive: true, force: true }) })
  return { runner, client, agent, human, authority, rows, state, calls, check, engine, page, originalSignal, allow, incoming, list, capture, root }
}

test('only a successful owned engine artifact becomes an opaque runtime file token', async t => {
  const f = await fixture(t), artifact = await f.capture({ filename: 'report.pdf' })
  assert.match(artifact.artifactToken, /^hoai-artifact:/); assert.equal(artifact.fileName, 'report.pdf'); assert.equal(artifact.bytes, 26)
  const capture = f.calls.find(row => row.engine)!; assert.ok(capture.args.filename.startsWith(path.join(f.root, 'files') + path.sep)); assert.notEqual(capture.args.filename, 'report.pdf')
  assert.equal(JSON.stringify(artifact).includes(f.root), false); await assert.rejects(f.capture({ filename: path.join(f.root, 'other.pdf') })); assert.equal(f.calls.filter(row => row.engine).length, 1)
})

test('one browser artifact waits for exact human file consent and uploads encrypted bytes only once', async t => {
  const f = await fixture(t), artifact = await f.capture(), recipient = (await f.list()).recipients[0]
  const offered = decoded(await f.runner.send({ args: { artifactToken: artifact.artifactToken, recipientToken: recipient.recipientToken }, assertCurrent: f.check, signal: f.originalSignal })); assert.equal(offered.state, 'offered'); assert.equal(f.calls.some(row => row.pathname?.endsWith('/content')), false)
  const row = [...f.rows.values()][0]; f.allow(row)
  const uploaded = decoded(await f.runner.send({ args: { artifactToken: artifact.artifactToken }, assertCurrent: f.check, signal: f.originalSignal })); assert.equal(uploaded.state, 'available')
  const opened = cryptoFiles.openFile({ offer: row.offer, signature: row.signature, payload: row.payload, expectedContext: cryptoFiles.offerContext(row.offer), sourceIdentity: f.agent.identity, destination: f.human }); assert.equal(opened.plaintext.toString(), 'SYNTHETIC BROWSER ARTIFACT'); opened.plaintext.fill(0)
  assert.equal(decoded(await f.runner.send({ args: { artifactToken: artifact.artifactToken }, assertCurrent: f.check, signal: f.originalSignal })).state, 'read-only'); assert.equal(f.calls.filter(row => row.pathname?.endsWith('/content')).length, 1)
})

test('an arbitrary or forged artifact path can never create a file offer', async t => {
  const f = await fixture(t)
  for (const artifactToken of [path.join(f.root, 'secret'), 'file:///etc/passwd', 'hoai-artifact:' + randomUUID()]) await assert.rejects(async () => f.runner.send({ args: { artifactToken }, assertCurrent: f.check, signal: f.originalSignal }))
  assert.equal(f.calls.some(row => row.pathname?.endsWith('/files')), false)
})

test('incoming upload preserves original opaque permission args then materializes the approved file once', async t => {
  const f = await fixture(t); f.incoming(); const item = (await f.list()).files[0], args = { paths: [item.fileToken] }; let approved = 0
  const value = await f.runner.upload({ args, engine: f.engine, assertCurrent: f.check, signal: f.originalSignal, authorize: async (execute: (...args: any[]) => Promise<any>) => { approved++; assert.deepEqual(args, { paths: [item.fileToken] }); assert.equal(f.calls.some(row => row.pathname?.endsWith('/claim')), false); return execute('browser_file_upload', structuredClone(args), f.originalSignal) } })
  assert.equal(value.content[0].text, 'SYNTHETIC HUMAN FILE'); assert.equal(approved, 1); assert.equal(f.calls.filter(row => row.pathname?.endsWith('/claim')).length, 1)
  const used = f.calls.find(row => row.engine === 'browser_file_upload')!; assert.ok(used.args.paths[0].endsWith(path.sep + 'chosen.txt')); await assert.rejects(fs.lstat(used.args.paths[0]), { code: 'ENOENT' }); assert.equal(f.page.listenerCount('framenavigated'), 0)
  await assert.rejects(f.runner.upload({ args, engine: f.engine, assertCurrent: f.check, signal: f.originalSignal, authorize: async () => { approved++; throw Error('must not ask twice') } })); assert.equal(approved, 1); assert.equal(f.calls.filter(row => row.pathname?.endsWith('/claim')).length, 1)
})

test('website denial and arbitrary paths never claim or execute a file input', async t => {
  const f = await fixture(t); f.incoming(); const item = (await f.list()).files[0]
  assert.equal((await f.runner.upload({ args: { paths: [item.fileToken] }, engine: f.engine, assertCurrent: f.check, signal: f.originalSignal, authorize: async () => ({ isError: true }) })).isError, true)
  for (const paths of [[path.join(f.root, 'secret')], ['hoai-file:' + randomUUID()], [item.fileToken, item.fileToken], []]) await assert.rejects(async () => f.runner.upload({ args: { paths }, engine: f.engine, assertCurrent: f.check, signal: f.originalSignal, authorize: async () => { throw Error('no authority') } }))
  assert.equal(f.calls.some(row => row.pathname?.endsWith('/claim') || row.engine), false)
})

test('navigation away and back while permission waits cannot borrow the original upload', async t => {
  const f = await fixture(t); f.incoming(); const item = (await f.list()).files[0], args = { paths: [item.fileToken] }
  await assert.rejects(f.runner.upload({ args, engine: f.engine, assertCurrent: f.check, signal: f.originalSignal, authorize: async (execute: (...args: any[]) => Promise<any>) => { f.page.emit('framenavigated'); return execute('browser_file_upload', args, f.originalSignal) } }), /original_page_changed/)
  assert.equal(f.calls.some(row => row.pathname?.endsWith('/claim') || row.engine), false); assert.equal(f.page.listenerCount('framenavigated'), 0)
})

test('lost initial creation acknowledgement remains read-only and never creates another offer', async t => {
  const f = await fixture(t), artifact = await f.capture(); f.state.after = async (pathname: string, response: Response) => { if (pathname.endsWith('/files')) throw Error('synthetic lost creation ack'); return response }
  assert.equal(decoded(await f.runner.send({ args: { artifactToken: artifact.artifactToken }, assertCurrent: f.check, signal: f.originalSignal })).state, 'outcome-unknown'); f.state.after = null
  assert.equal(decoded(await f.runner.send({ args: { artifactToken: artifact.artifactToken }, assertCurrent: f.check, signal: f.originalSignal })).state, 'read-only'); assert.equal(f.calls.filter(row => row.pathname?.endsWith('/files')).length, 1); assert.equal(f.calls.some(row => row.pathname?.endsWith('/content')), false)
})

test('a lost website delivery acknowledgement never claims or executes a second time', async t => {
  const f = await fixture(t); f.incoming(); const item = (await f.list()).files[0], args = { paths: [item.fileToken] }
  f.state.after = async (pathname: string, response: Response) => { if (pathname.endsWith('/claim')) throw Error('synthetic lost claim ack'); return response }
  const invoke = () => f.runner.upload({ args, engine: f.engine, assertCurrent: f.check, signal: f.originalSignal, authorize: async (execute: (...args: any[]) => Promise<any>) => execute('browser_file_upload', args, f.originalSignal) })
  await assert.rejects(invoke()); f.state.after = null; await assert.rejects(invoke()); assert.equal(f.calls.filter(row => row.pathname?.endsWith('/claim')).length, 1); assert.equal(f.calls.some(row => row.engine === 'browser_file_upload'), false)
})


test('a changed original request or runtime cannot authorize another file or claim', async t => {
  const f = await fixture(t); f.incoming(); const item = (await f.list()).files[0], args = { paths: [item.fileToken] }
  await assert.rejects(f.runner.upload({ args, engine: f.engine, assertCurrent: f.check, signal: f.originalSignal, authorize: async (execute: (...args: any[]) => Promise<any>) => execute('browser_file_upload', { paths: ['hoai-file:' + randomUUID()] }, f.originalSignal) }), /original_page_changed/)
  await assert.rejects(f.runner.upload({ args, engine: f.engine, assertCurrent: f.check, signal: f.originalSignal, authorize: async (execute: (...args: any[]) => Promise<any>) => { f.state.changed = true; return execute('browser_file_upload', args, f.originalSignal) } }))
  f.state.changed = false; assert.equal(f.calls.some(row => row.pathname?.endsWith('/claim') || row.engine), false)
})

test('page invalidation during a held consumed claim cannot execute or replay the upload', async t => {
  const f = await fixture(t); f.incoming(); const item = (await f.list()).files[0], args = { paths: [item.fileToken] }
  let release!: () => void, entered!: () => void; const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  f.state.after = async (pathname: string, response: Response) => { if (pathname.endsWith('/claim')) { entered(); await gate }; return response }
  const work = f.runner.upload({ args, engine: f.engine, assertCurrent: f.check, signal: f.originalSignal, authorize: async (execute: (...args: any[]) => Promise<any>) => execute('browser_file_upload', args, f.originalSignal) }); const refused = assert.rejects(work)
  try { await started; f.page.emit('framenavigated'); assert.equal(f.calls.some(row => row.engine), false) } finally { release(); await refused }
  f.state.after = null; await assert.rejects(f.runner.upload({ args, engine: f.engine, assertCurrent: f.check, signal: f.originalSignal, authorize: async () => { throw Error('spent original') } })); assert.equal(f.calls.filter(row => row.pathname?.endsWith('/claim')).length, 1)
})

test('epoch loss after initial offer dispatch retains only the original read-only outcome', async t => {
  const f = await fixture(t), artifact = await f.capture(); f.state.after = async (pathname: string, response: Response) => { if (pathname.endsWith('/files')) f.state.changed = true; return response }
  await assert.rejects(f.runner.send({ args: { artifactToken: artifact.artifactToken }, assertCurrent: f.check, signal: f.originalSignal })); f.state.changed = false; f.state.after = null
  assert.equal(decoded(await f.runner.send({ args: { artifactToken: artifact.artifactToken }, assertCurrent: f.check, signal: f.originalSignal })).state, 'read-only'); assert.equal(f.calls.filter(row => row.pathname?.endsWith('/files')).length, 1); assert.equal(f.calls.some(row => row.pathname?.endsWith('/content')), false)
})

test('an uncertain outgoing upload is spent despite a later confirmed server read', async t => {
  const f = await fixture(t), artifact = await f.capture(); await f.runner.send({ args: { artifactToken: artifact.artifactToken }, assertCurrent: f.check, signal: f.originalSignal }); f.allow([...f.rows.values()][0])
  f.state.after = async (pathname: string, response: Response) => { if (pathname.endsWith('/content')) throw Error('synthetic lost upload acknowledgment'); return response }
  await assert.rejects(f.runner.send({ args: { artifactToken: artifact.artifactToken }, assertCurrent: f.check, signal: f.originalSignal })); f.state.after = null
  assert.equal(decoded(await f.runner.send({ args: { artifactToken: artifact.artifactToken }, assertCurrent: f.check, signal: f.originalSignal })).state, 'read-only'); assert.equal(f.calls.filter(row => row.pathname?.endsWith('/content')).length, 1)
})

test('a failed engine artifact result cleans its actual file and never becomes transferable', async t => {
  const f = await fixture(t); f.state.engine = async (_name: string, args: Row) => { await fs.writeFile(args.filename, 'partial synthetic artifact'); return { isError: true, content: [] } }
  await assert.rejects(f.capture(), /artifact_unconfirmed/); assert.deepEqual(await fs.readdir(path.join(f.root, 'files')), []); assert.equal(f.runner.activity().cleanupUnknown, false)
})

test('owned artifact inventory is bounded before another engine write', async t => {
  const f = await fixture(t); for (let index = 0; index < 4; index++) await f.capture()
  await assert.rejects(f.capture(), /artifact_capacity/); assert.equal(f.calls.filter(row => row.engine).length, 4)
})

test('disposal aborts admission but retains physical relay work until a held response actually drains', async t => {
  const f = await fixture(t); let release!: () => void, entered!: () => void, disposed = false; const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  f.state.after = async (pathname: string, response: Response) => { if (pathname.endsWith('/pending')) { entered(); await gate }; return response }
  const work = f.list(), rejected = assert.rejects(work); await started
  const disposal = f.runner.dispose().then(() => { disposed = true })
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(disposed, false); assert.ok(f.runner.activity().pendingPhysicalOperations > 0) } finally { release(); await rejected; await disposal }
  assert.equal(disposed, true); assert.deepEqual(f.runner.activity(), { pendingPhysicalOperations: 0, cleanupUnknown: false }); await assert.rejects(async () => f.list())
})

test('disposal also retains an original held peer lookup that has not reached HTTP', async t => {
  const f = await fixture(t); let release!: () => void, entered!: () => void, done = false; const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  f.runner.peerIdentities = async (callback: () => unknown) => { entered(); await gate; callback(); return [f.human.identity] }
  const work = f.list(), rejected = assert.rejects(work); await started; const disposal = f.runner.dispose().then(() => { done = true })
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false); assert.equal(f.calls.length, 0) } finally { release(); await rejected; await disposal }
  assert.equal(done, true); assert.equal(f.runner.activity().cleanupUnknown, false)
})

test('a changed full URL without a page event cannot authorize the original upload', async t => {
  const f = await fixture(t); f.incoming(); const item = (await f.list()).files[0], args = { paths: [item.fileToken] }
  await assert.rejects(f.runner.upload({ args, engine: f.engine, assertCurrent: f.check, signal: f.originalSignal, authorize: async (execute: (...args: any[]) => Promise<any>) => { f.page.address = 'https://site.test/another-path'; return execute('browser_file_upload', args, f.originalSignal) } }), /original_page_changed/)
  assert.equal(f.calls.some(row => row.pathname?.endsWith('/claim') || row.engine), false)
})

test('four held original peer lookups retain process-wide file admission before any HTTP', async t => {
  const peers = await Promise.all(Array.from({ length: 5 }, () => fixture(t))); let release!: () => void, entered!: () => void, count = 0
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  for (const f of peers) f.runner.peerIdentities = async (callback: () => unknown) => { callback(); if (++count === 4) entered(); await gate; callback(); return [f.human.identity] }
  const work = peers.slice(0, 4).map(f => f.list()); let fifth: Promise<any> | undefined
  try { await started; fifth = Promise.resolve().then(() => peers[4].list()); const observed = await Promise.race([fifth.then(() => ({ state: 'resolved' }), (error: Row) => ({ state: 'rejected', code: error.code })), new Promise(resolve => setTimeout(() => resolve({ state: 'physically-held' }), 15))]); assert.deepEqual(observed, { state: 'rejected', code: 'profile_file_busy' }); assert.equal(count, 4); assert.equal(peers.some(f => f.calls.length), false) }
  finally { release(); await Promise.allSettled([...work, fifth]) }
})

test('transactional page listener removal attempts all cleanup and retains uncertainty', async t => {
  const f = await fixture(t); f.incoming(); const item = (await f.list()).files[0], original = f.page.removeListener.bind(f.page), removed: string[] = []
  f.page.removeListener = ((event: string, callback: (...args: any[]) => void) => { removed.push(event); if (event === 'framenavigated') throw Error('synthetic listener cleanup failure'); return original(event, callback) }) as any
  await assert.rejects(f.runner.upload({ args: { paths: [item.fileToken] }, engine: f.engine, assertCurrent: f.check, signal: f.originalSignal, authorize: async () => ({ isError: true }) }), /cleanup_unconfirmed/)
  assert.deepEqual(removed, ['framenavigated', 'close', 'crash']); assert.equal(f.runner.activity().cleanupUnknown, true); assert.ok(f.runner.activity().pendingPhysicalOperations > 0); await assert.rejects(async () => f.list()); await assert.rejects(f.runner.dispose(), /cleanup_unconfirmed/)
  f.page.removeListener = original
})


test('a failed first drain still independently invokes private staging and artifact drains', async t => {
  const f = await fixture(t); await f.capture(); const called: string[] = [], originalStage = f.runner.staging.whenDrained.bind(f.runner.staging), originalArtifacts = f.runner.artifacts.whenDrained.bind(f.runner.artifacts)
  f.client.whenDrained = () => { called.push('client'); throw Error('synthetic first drain failure') }
  f.runner.staging.whenDrained = async () => { called.push('staging'); await originalStage() }; f.runner.artifacts.whenDrained = async () => { called.push('artifacts'); await originalArtifacts() }
  await assert.rejects(f.list(), /cleanup_unconfirmed/); assert.deepEqual(called, ['client', 'staging', 'artifacts']); assert.equal(f.runner.activity().cleanupUnknown, true); assert.ok(f.runner.activity().pendingPhysicalOperations > 0)
})

test('a synchronous first disposer failure cannot skip independent staging or artifact disposal', async t => {
  const f = await fixture(t); await f.capture(); const called: string[] = [], originalStage = f.runner.staging.dispose.bind(f.runner.staging), originalArtifacts = f.runner.artifacts.dispose.bind(f.runner.artifacts)
  f.client.dispose = () => { called.push('client'); throw Error('synthetic synchronous dispose failure') }
  f.runner.staging.dispose = async () => { called.push('staging'); await originalStage() }; f.runner.artifacts.dispose = async () => { called.push('artifacts'); await originalArtifacts() }
  await assert.rejects(f.runner.dispose(), /cleanup_unconfirmed/); assert.deepEqual(called, ['client', 'staging', 'artifacts']); assert.equal(f.runner.activity().cleanupUnknown, true); assert.deepEqual(await fs.readdir(path.join(f.root, 'files')), [])
})
