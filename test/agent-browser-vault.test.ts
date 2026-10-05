import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { AgentBrowserVault, browserVaultScope } from '../lib/agent-browser-vault.mjs'
import { BrowserPool, ChromiumEngine, BrowserHostCore, HostError } from '../bin/hoai-browser-host.mjs'

const PASSPHRASE = 'fixture owner passphrase 123'
const STATE = { cookies: [{ name: 'session', value: 'COOKIE_CANARY_817', domain: 'example.test', path: '/', expires: -1,
  httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [{ origin: 'https://example.test',
  localStorage: [{ name: 'auth', value: 'LOCAL_CANARY_836' }], indexedDB: [{ name: 'auth', version: 1, stores: [] }] }] }
function fixture(t: any, suffix = 'a') {
  const root = mkdtempSync(join(tmpdir(), 'vault-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, suffix), scope = browserVaultScope({ assistantId: 901, principal: 'user-fixture' })
  const vault = new AgentBrowserVault({ profileDir: dir, scope, snapshotMs: 100000 })
  t.after(() => vault.lock())
  return { root, dir, scope, vault, file: join(dir, 'agent-browser.vault.json') }
}

test('locked browser never writes state; owner unlock encrypts state and passwords with no plaintext canaries', async t => {
  const { vault, file, dir } = fixture(t)
  vault.bind({ storageState: async () => STATE, setStorageState: async () => {} })
  await vault.snapshot(); assert.equal(existsSync(file), false)
  await vault.unlock(PASSPHRASE)
  await vault.restore()
  await vault.snapshot()
  await vault.saveLogin({ origin: 'https://example.test', username: 'USER_CANARY_511', password: 'PASSWORD_CANARY_512' })
  const disk = readdirSync(dir).map(name => readFileSync(join(dir, name), 'utf8')).join('\n')
  for (const marker of ['COOKIE_CANARY_817', 'LOCAL_CANARY_836', 'USER_CANARY_511', 'PASSWORD_CANARY_512', PASSPHRASE]) assert.ok(!disk.includes(marker), marker)
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  const first = JSON.parse(readFileSync(file, 'utf8'))
  await vault.snapshot()
  assert.notEqual(JSON.parse(readFileSync(file, 'utf8')).iv, first.iv)
})

test('restart restores session cookies and storage only after correct owner unlock; deletion is persisted', async t => {
  const { vault, file, dir, scope } = fixture(t)
  let state = structuredClone(STATE)
  vault.bind({ storageState: async () => state, setStorageState: async () => {} })
  await vault.unlock(PASSPHRASE); await vault.restore(); await vault.snapshot(); await vault.lock()
  assert.equal(vault.status().unlocked, false)
  const reopened = new AgentBrowserVault({ profileDir: dir, scope, snapshotMs: 100000 })
  t.after(() => reopened.lock())
  await assert.rejects(reopened.unlock('wrong secret passphrase'), { code: 'vault_unlock_failed' })
  await reopened.unlock(PASSPHRASE)
  let restored: any
  await reopened.restore({ setStorageState: async (next: any) => { restored = next }, storageState: async () => state })
  assert.deepEqual(restored, STATE)
  state = { cookies: [], origins: [] }; await reopened.snapshot(); await reopened.lock()
  await reopened.unlock(PASSPHRASE)
  await reopened.restore({ setStorageState: async (next: any) => { restored = next }, storageState: async () => state })
  assert.deepEqual(restored, state)
  assert.ok(existsSync(file))
})

test('ciphertext tampering and copying ciphertext across a profile fail authentication', async t => {
  const { vault, file, root, scope } = fixture(t)
  await vault.unlock(PASSPHRASE); await vault.lock()
  const original = readFileSync(file, 'utf8'), envelope = JSON.parse(original)
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64'); ciphertext[0] ^= 1
  writeFileSync(file, JSON.stringify({ ...envelope, ciphertext: ciphertext.toString('base64') }), { mode: 0o600 })
  await assert.rejects(vault.unlock(PASSPHRASE), { code: 'vault_unlock_failed' })
  writeFileSync(file, original, { mode: 0o600 })
  const other = new AgentBrowserVault({ profileDir: join(root, 'b'), scope: scope.replace('901', '902') })
  t.after(() => other.lock())
  writeFileSync(other.file, original, { mode: 0o600 })
  await assert.rejects(other.unlock(PASSPHRASE), { code: 'vault_unlock_failed' })
})

test('explicit legacy consent clears only fixed Chrome artifacts and preserves policy', async t => {
  const { vault, dir } = fixture(t)
  mkdirSync(join(dir, 'Default')); writeFileSync(join(dir, 'Default', 'Cookies'), 'legacy canary')
  writeFileSync(join(dir, 'agent-browser.settings.json'), '{"allowed":true}')
  assert.equal(vault.status().legacy, true)
  await assert.rejects(vault.unlock(PASSPHRASE), { code: 'legacy_consent_required' })
  assert.equal(existsSync(join(dir, 'Default', 'Cookies')), true)
  await vault.unlock(PASSPHRASE, { clearLegacy: true })
  assert.equal(existsSync(join(dir, 'Default')), false)
  assert.equal(readFileSync(join(dir, 'agent-browser.settings.json'), 'utf8'), '{"allowed":true}')
})

test('unknown legacy files, live legacy browser and symbolic profile refuse clearing', async t => {
  const { vault, dir, root } = fixture(t)
  writeFileSync(join(dir, 'owner-notes.txt'), 'keep')
  await assert.rejects(vault.unlock(PASSPHRASE, { clearLegacy: true }), { code: 'legacy_cleanup_required' })
  assert.equal(readFileSync(join(dir, 'owner-notes.txt'), 'utf8'), 'keep')
  rmSync(join(dir, 'owner-notes.txt'))
  writeFileSync(join(dir, 'DevToolsActivePort'), 'invalid')
  await assert.rejects(vault.unlock(PASSPHRASE, { clearLegacy: true }), { code: 'legacy_browser_active' })
  const linked = join(root, 'alias'); symlinkSync(dir, linked, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => new AgentBrowserVault({ profileDir: linked, scope: 'fixture' }), { code: 'unsafe_profile' })
})

test('saved login metadata is origin scoped and locked vault never returns entries', async t => {
  const { vault } = fixture(t)
  assert.throws(() => vault.list('https://example.test'), { code: 'vault_locked' })
  await vault.unlock(PASSPHRASE)
  await vault.saveLogin({ origin: 'https://example.test', username: 'a', password: 'secret' })
  const row = vault.list('https://example.test')[0]
  assert.equal('password' in row, false)
  assert.deepEqual(vault.list('https://other.test'), [])
  assert.throws(() => vault.readLogin(row.id, 'https://other.test'), { code: 'login_not_found' })
  await vault.removeLogin(row.id, row.origin)
  assert.deepEqual(vault.list(row.origin), [])
})

test('snapshot between unlock and restore cannot replace saved auth state with an empty browser', async t => {
  const { vault } = fixture(t)
  await vault.unlock(PASSPHRASE)
  await vault.restore({ setStorageState: async () => {}, storageState: async () => STATE })
  await vault.snapshot(); await vault.lock()
  vault.bind({ storageState: async () => ({ cookies: [], origins: [] }) })
  await vault.unlock(PASSPHRASE); await vault.snapshot(); await vault.lock()
  await vault.unlock(PASSPHRASE)
  let restored: any
  await vault.restore({ setStorageState: async (state: any) => { restored = state }, storageState: async () => STATE })
  assert.deepEqual(restored, STATE)
})

test('locking while scrypt is in flight forbids late key installation and disk writes', async t => {
  const { vault, file } = fixture(t)
  const pending = vault.unlock(PASSPHRASE)
  await new Promise(resolve => setImmediate(resolve))
  const locking = vault.lock()
  await assert.rejects(pending, { code: 'vault_locked' })
  await locking
  assert.equal(vault.status().unlocked, false)
  assert.equal(existsSync(file), false)
})

test('reacquire waits for the old encrypted snapshot and shutdown before launching a replacement', async () => {
  let releaseStop: () => void = () => {}, enteredStop: () => void = () => {}, launches = 0
  const entered = new Promise<void>(resolve => { enteredStop = resolve })
  const physicalStop = new Promise<void>(resolve => { releaseStop = resolve })
  const pool = new BrowserPool({ agentRoot: '/fixture', createEngine: () => {
    const first = ++launches === 1
    return { alive: true, async start() {}, async stop() { if (first) { enteredStop(); await physicalStop }; this.alive = false } }
  } })
  const context = { assistantId: 901, principal: 'user-fixture' }
  await pool.acquire(context)
  const stopped = pool.release(context); await entered
  const reacquired = pool.acquire(context)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(launches, 1, 'A replacement must not read or write the profile during old shutdown')
  releaseStop(); await stopped; await reacquired
  assert.equal(launches, 2)
  await pool.stopAll()
})

test('failed final snapshot preserves the prior ciphertext, cleans up, and reports storage failure instead of saved success', async t => {
  const { vault, file, dir } = fixture(t)
  let state: any = STATE
  await vault.unlock(PASSPHRASE)
  await vault.restore({ setStorageState: async () => {}, storageState: async () => state })
  await vault.snapshot()
  const prior = readFileSync(file)
  state = { cookies: [], origins: [{ origin: 'https://example.test', localStorage: [{ name: 'too-large', value: 'x'.repeat(17 * 1024 * 1024) }] }] }
  await assert.rejects(vault.snapshot(), { code: 'invalid_browser_state' })
  assert.equal(vault.lastError, 'vault_snapshot_failed')
  assert.deepEqual(readFileSync(file), prior)
  let closed = false, stopped = false
  const engine: any = new ChromiumEngine({ profileDir: dir, outputDir: dir, executable: 'unused' })
  engine.vault = vault; engine.alive = true
  engine._engine = { _secrets: { patterns: [] }, closeBrowserProcess: async () => { closed = true }, stop: async () => { stopped = true } }
  const slot: any = { engine, ownerInputLease: null }
  const core = new BrowserHostCore({ pool: { peek: () => slot, release: () => engine.stop() } as any, browserTools: [], deviceLabel: 'fixture' })
  const result = await core.callTool({ assistantId: 901, principal: 'user-fixture' }, 'hoai_browser_close_session', {})
  assert.equal('isError' in result && result.isError, true)
  assert.match(JSON.stringify(result), /credential_storage/)
  assert.doesNotMatch(JSON.stringify(result), /was saved encrypted/)
  assert.equal(closed && stopped, true)
  assert.equal(vault.status().unlocked, false)
  assert.deepEqual(readFileSync(file), prior)
})

test('confirmed closed storage failure is reported but permits a fresh locked browser on retry', async () => {
  let launches = 0
  const pool = new BrowserPool({ agentRoot: '/fixture', createEngine: () => {
    const first = ++launches === 1
    return { alive: true, async start() {}, async stop() {
      this.alive = false
      if (first) throw Object.assign(new HostError('credential_storage', 'Fixed storage failure'), { browserClosed: true })
    } }
  } })
  const context = { assistantId: 901, principal: 'user-fixture' }
  await pool.acquire(context)
  await assert.rejects(pool.release(context), { code: 'credential_storage' })
  await pool.acquire(context)
  assert.equal(launches, 2)
  await pool.stopAll()
})

test('a new host process can reopen the already protected profile without elevated ACL privileges', async t => {
  const { vault, dir, scope } = fixture(t)
  await vault.unlock(PASSPHRASE); await vault.lock()
  const module = new URL('../lib/agent-browser-vault.mjs', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { AgentBrowserVault } from ${JSON.stringify(module)}; const vault = new AgentBrowserVault(${JSON.stringify({ profileDir: dir, scope })}); console.log(JSON.stringify(vault.status()));`],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), { configured: true, unlocked: false, legacy: false })
})

test('restoring registers open SPA origins without replacing saved state or navigating pages', async t => {
  const { vault } = fixture(t)
  await vault.unlock(PASSPHRASE)
  await vault.restore({ setStorageState: async () => {}, storageState: async () => STATE })
  await vault.snapshot()
  let restored: any
  const resets: any[] = []
  await vault.restore({ pages: () => [{ frames: () => ['https://example.test/login', 'https://another.test/', 'about:blank', '', 'still-loading'].map(url => ({ url: () => url })) }],
    newCDPSession: async () => ({ send: async (method: string, params: any) => { resets.push({ method, params }) }, detach: async () => {} }),
    setStorageState: async (state: any) => { restored = state }, storageState: async () => STATE })
  assert.deepEqual(restored.origins[0], STATE.origins[0])
  assert.deepEqual(restored.origins[1], { origin: 'https://another.test', localStorage: [], indexedDB: [] })
  assert.equal(restored.origins.length, 2)
  assert.deepEqual(resets, ['https://example.test', 'https://another.test'].map(origin => ({ method: 'Storage.clearDataForOrigin', params: { origin, storageTypes: 'indexeddb' } })))
  assert.deepEqual((vault as any).data.state, STATE, 'The decrypted saved payload remains unchanged until a successful snapshot')
})

test('an IndexedDB reset failure refuses restore and still detaches its CDP session', async t => {
  const { vault } = fixture(t)
  await vault.unlock(PASSPHRASE)
  let detached = false, restored = false
  await assert.rejects(vault.restore({ pages: () => [{ frames: () => [{ url: () => 'https://example.test' }] }],
    newCDPSession: async () => ({ send: async () => { throw new Error('fixture reset refused') }, detach: async () => { detached = true } }),
    setStorageState: async () => { restored = true } }), /fixture reset refused/)
  assert.equal(detached, true)
  assert.equal(restored, false)
  assert.equal(vault.restored, false)
})

test('origin tracking retains closed-page and worker history until context close and refuses overflow', async t => {
  const { vault } = fixture(t)
  const page: any = new EventEmitter(), context: any = new EventEmitter()
  page.frames = () => [{ url: () => 'https://current.test' }]
  context.pages = () => [page]; context.serviceWorkers = () => []
  const cleared: string[] = []
  context.newCDPSession = async () => ({ send: async (_method: string, params: any) => { cleared.push(params.origin) }, detach: async () => {} })
  context.setStorageState = async () => {}
  vault.bind(context)
  page.emit('framenavigated', { url: () => 'https://past-page.test/path' })
  context.emit('serviceworker', { url: () => 'https://past-worker.test/worker.js' })
  page.emit('close')
  await vault.unlock(PASSPHRASE); await vault.restore(context)
  assert.deepEqual(new Set(cleared), new Set(['https://current.test', 'https://past-page.test', 'https://past-worker.test']))
  context.emit('close')
  assert.equal(vault.visitedOrigins.size, 0)
  await vault.lock()
  vault.bind(context)
  for (let i = 0; i < 1025; i++) context.emit('serviceworker', { url: () => `https://origin-${i}.test/worker.js` })
  assert.equal(vault.visitedOrigins.size, 1024)
  await vault.unlock(PASSPHRASE)
  await assert.rejects(vault.restore(context), { code: 'invalid_browser_state' })
  assert.equal(vault.restored, false)
})
