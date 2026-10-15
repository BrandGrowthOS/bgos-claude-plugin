import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { AgentBrowserVault, browserVaultScope } from '../lib/agent-browser-vault.mjs'
import * as vaultExports from '../lib/agent-browser-vault.mjs'
import { BrowserPool, ChromiumEngine, BrowserHostCore, HostError } from '../bin/hoai-browser-host.mjs'

const PASSPHRASE = 'fixture owner passphrase 123'
const STATE = { cookies: [{ name: 'session', value: 'COOKIE_CANARY_817', domain: 'example.test', path: '/', expires: -1,
  httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [{ origin: 'https://example.test',
  localStorage: [{ name: 'auth', value: 'LOCAL_CANARY_836' }], indexedDB: [{ name: 'auth', version: 1, stores: [] }] }] }
function fixture(t: any, suffix = 'a') {
  // macOS: os.tmpdir() is /var/folders/..., and /var is a symlink to /private/var,
  // so a path built from it is an ALIAS. agent-browser-vault's secureProfileDir
  // deliberately refuses an alias (`realpathSync(absolute) !== absolute` throws
  // unsafe_profile), which is the anti-aliasing property the vault exists to
  // have. So every temp root under tmpdir() must be canonicalised here, or the
  // vault specs can never pass on a Mac. CI runs ubuntu-latest and
  // windows-latest only, where /tmp is real, so this was green in CI and red on
  // every developer and agent machine in the fleet. Canonicalising the TEST root
  // keeps the production check exactly as strict: ~/.bgos-agent, the real
  // profile root, has no symlink in its chain.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vault-test-')))
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

test('first setup may retain current sign-in but an existing vault cannot adopt replacement browsing state', async t => {
  const { vault, file } = fixture(t)
  let replaced = false
  const context = { storageState: async () => STATE, setStorageState: async () => { replaced = true } }
  await vault.unlock(PASSPHRASE)
  await vault.retainCurrent(context)
  assert.equal(replaced, false)
  const ciphertext = readFileSync(file)
  assert.equal(ciphertext.includes(Buffer.from('COOKIE_CANARY_817')), false)
  await vault.lock(); await vault.unlock(PASSPHRASE)
  await assert.rejects(vault.retainCurrent(context), { code: 'vault_locked' })
  assert.deepEqual(readFileSync(file), ciphertext)
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
  assert.throws(() => new AgentBrowserVault({ profileDir: linked, scope: 'fixture' }),
    { code: 'unsafe_profile', reason: 'alias', message: /^unsafe_profile: the browser profile folder is a link or not a plain folder\. / })
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

// ── The Windows owner step (HOAI board row 221ec9db) ─────────────────────────
// Making the user the owner needs WRITE_OWNER, which Modify alone (a shared
// data drive such as E: on a PC where users get Modify) does not give, so every
// profile there was refused as unsafe_profile with no reason. A folder that is
// already the user's own and that no other account can write is now locked the
// same way without SetOwner; everything else is still refused, and says why.
// The vault's own allow-list is the user alone (the access list it writes has
// one entry, for the user), so SYSTEM and Administrators count as other accounts.

const vaultModule: any = vaultExports
const ME = 'S-1-5-21-1000-2000-3000-1001', OTHER = 'S-1-5-21-1000-2000-3000-1002'
const MODIFY = 0x1301BF, FULL = 0x1F01FF, READ_EXECUTE = 0x1200A9
const NAMES: Record<string, string> = { [ME]: 'HOST\\owner', [OTHER]: 'HOST\\someone', 'S-1-5-11': 'NT AUTHORITY\\Authenticated Users',
  'S-1-5-18': 'NT AUTHORITY\\SYSTEM', 'S-1-5-32-544': 'BUILTIN\\Administrators', 'S-1-5-32-545': 'BUILTIN\\Users', 'S-1-3-0': 'CREATOR OWNER' }
const entry = (sid: string, mask: number, extra: any = {}) => ({ type: 0, flags: 3, mask, sid, name: NAMES[sid] || sid, ...extra })
/** What the first PowerShell step answers when Windows refuses the owner: the folder as it is. */
const ownerRefused = (extra: any) => ({ me: ME, meName: NAMES[ME], set: false, error: 'Attempted to perform an unauthorized operation.',
  owner: ME, ownerName: NAMES[ME], protected: false, ...extra })
/** What the second step answers after writing the vault's access list without SetOwner. */
const lockedForMe = { me: ME, meName: NAMES[ME], set: true, owner: ME, ownerName: NAMES[ME], protected: true, dacl: [entry(ME, FULL)] }
function fakePowerShell(...answers: any[]) {
  const scripts: string[] = []
  return { scripts, run: (script: string) => { scripts.push(script); return answers[scripts.length - 1] ?? { failed: 'no answer left in the fixture' } } }
}
let fakeFolders = 0
const fakeFolder = () => `C:\\fixture\\profiles\\${++fakeFolders}\\José\u2019s it's here`
/** The folder a script works on, decoded from the script, and the script is plain ASCII (stdin is read in the console code page). */
function targetOf(script: string) {
  assert.match(script, /^[\x00-\x7f]*$/, 'the script PowerShell reads from stdin is plain ASCII')
  const b64 = /^\$target = \[System\.Text\.Encoding\]::Unicode\.GetString\(\[System\.Convert\]::FromBase64String\('([A-Za-z0-9+\/=]+)'\)\)$/m.exec(script)?.[1]
  assert.ok(b64, script)
  return Buffer.from(b64, 'base64').toString('utf16le')
}
// The statements of the 0.69.0 script, in order: a folder that can take an owner gets exactly this.
const MAIN_STATEMENTS = ["$ErrorActionPreference = 'Stop'", '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()',
  '$acl = New-Object System.Security.AccessControl.DirectorySecurity', '$acl.SetOwner($identity.User)', '$acl.SetAccessRuleProtection($true, $false)',
  "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity.User, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')",
  '$acl.AddAccessRule($rule)']
function statementsInOrder(script: string, statements: string[]) {
  const lines = script.split('\n')
  let at = -1
  for (const statement of statements) { at = lines.indexOf(statement, at + 1); if (at < 0) return false }
  return true
}

test('Windows owner step, Full control (unchanged): one step, the 0.69.0 statements, owner set and access list written', () => {
  const folder = fakeFolder(), ps = fakePowerShell({ ...lockedForMe })
  vaultModule.protectWindowsDirectory(folder, { ino: 1 }, ps.run)
  assert.equal(ps.scripts.length, 1)
  assert.ok(statementsInOrder(ps.scripts[0]!, MAIN_STATEMENTS), ps.scripts[0])
  assert.equal(targetOf(ps.scripts[0]!), folder)
  assert.ok(ps.scripts[0]!.includes('[System.IO.Directory]::SetAccessControl($target, $acl)'), ps.scripts[0])
  vaultModule.protectWindowsDirectory(folder, { ino: 1 }, ps.run)
  assert.equal(ps.scripts.length, 1, 'the same folder is not stepped again in this process')
})

test('Windows owner step, Modify only but the user\'s own and private: locked with the same access list, without SetOwner', () => {
  const folder = fakeFolder(), ps = fakePowerShell(ownerRefused({ dacl: [entry(ME, MODIFY)] }), { ...lockedForMe })
  vaultModule.protectWindowsDirectory(folder, { ino: 2 }, ps.run)
  assert.equal(ps.scripts.length, 2)
  assert.ok(!ps.scripts[1]!.includes('SetOwner'), ps.scripts[1])
  assert.ok(statementsInOrder(ps.scripts[1]!, MAIN_STATEMENTS.filter(s => !s.includes('SetOwner'))), ps.scripts[1])
  assert.ok(ps.scripts[1]!.includes('[System.IO.Directory]::SetAccessControl($target, $acl)'), ps.scripts[1])
  assert.equal(targetOf(ps.scripts[0]!), folder)
  assert.equal(targetOf(ps.scripts[1]!), folder)
  vaultModule.protectWindowsDirectory(folder, { ino: 2 }, ps.run)
  assert.equal(ps.scripts.length, 2, 'accepted once, like a folder whose owner was set')
})

test('Windows owner step, read-only entries for others and deny entries do not refuse a private folder', () => {
  const lists = [
    [entry(ME, MODIFY), entry('S-1-5-32-545', READ_EXECUTE), entry(OTHER, FULL, { type: 1 }), entry('S-1-5-11', FULL, { type: 10 })],
    // Inherit-only GENERIC_READ | GENERIC_EXECUTE, as PowerShell's [int] gives it: negative.
    [entry(ME, MODIFY), entry('S-1-5-11', 0xA0000000 | 0, { flags: 11 })],
    // An empty access list: no one but the owner.
    [],
  ]
  for (const dacl of lists) {
    const ps = fakePowerShell(ownerRefused({ dacl }), { ...lockedForMe })
    vaultModule.protectWindowsDirectory(fakeFolder(), { ino: 3 }, ps.run)
    assert.equal(ps.scripts.length, 2, JSON.stringify(dacl))
  }
})

test('Windows owner step, a folder another account owns is refused, says so, and is not touched', () => {
  const ps = fakePowerShell(ownerRefused({ owner: OTHER, ownerName: NAMES[OTHER], dacl: [entry(ME, MODIFY)] }))
  assert.throws(() => vaultModule.protectWindowsDirectory(fakeFolder(), { ino: 4 }, ps.run), (error: any) => {
    assert.equal(error.code, 'unsafe_profile')
    assert.equal(error.reason, 'owner_foreign')
    assert.match(error.message, /^unsafe_profile: the browser profile folder belongs to another account\. /)
    assert.doesNotMatch(error.message, /HOST|S-1-5|fixture/, 'the agent never gets an account name, a SID or a path')
    assert.match(error.detail, /HOST\\someone/)
    assert.match(error.detail, /Attempted to perform an unauthorized operation/)
    return true
  })
  assert.equal(ps.scripts.length, 1, 'nothing is written to a folder that is refused')
})

const OTHER_WRITERS: Array<[string, any, RegExp]> = [
  ['Authenticated Users with Modify', entry('S-1-5-11', MODIFY), /Authenticated Users/],
  ['Authenticated Users inherit-only generic write, as E: hands down', entry('S-1-5-11', 0xE0010000 | 0, { flags: 11 }), /Authenticated Users/],
  ['another user with only WRITE_DAC', entry(OTHER, 0x40000), /HOST\\someone/],
  ['another user with only WRITE_OWNER', entry(OTHER, 0x80000), /HOST\\someone/],
  ['another user with only DELETE', entry(OTHER, 0x10000), /HOST\\someone/],
  ['another user with only add-subfolder', entry(OTHER, 0x4), /HOST\\someone/],
  ['another user with GENERIC_ALL', entry(OTHER, 0x10000000), /HOST\\someone/],
  ['another user with an access bit the vault does not know', entry(OTHER, 0x1000000), /HOST\\someone/],
  ['SYSTEM with Full control (the vault\'s list is the user alone)', entry('S-1-5-18', FULL), /SYSTEM/],
  ['Administrators with Full control (the vault\'s list is the user alone)', entry('S-1-5-32-544', FULL), /Administrators/],
  ['CREATOR OWNER with inherit-only Full control', entry('S-1-3-0', 0x10000000, { flags: 11 }), /CREATOR OWNER/],
  ['an object entry for another user', entry(OTHER, 0x2, { type: 5 }), /HOST\\someone/],
  ['an entry with no account and no mask', { type: 3, flags: 0, mask: null, sid: null, name: null }, /an entry with no account/],
]
for (const [label, other, named] of OTHER_WRITERS) {
  test(`Windows owner step, another account can write (${label}): refused, says so, not touched`, () => {
    const ps = fakePowerShell(ownerRefused({ dacl: [entry(ME, MODIFY), other] }))
    assert.throws(() => vaultModule.protectWindowsDirectory(fakeFolder(), { ino: 5 }, ps.run), (error: any) => {
      assert.equal(error.code, 'unsafe_profile')
      assert.equal(error.reason, 'other_writer')
      assert.match(error.message, /^unsafe_profile: another account can write to the browser profile folder\. /)
      assert.match(error.detail, named)
      return true
    })
    assert.equal(ps.scripts.length, 1)
  })
}

test('Windows owner step, a folder with no access list at all lets everyone write: refused', () => {
  const ps = fakePowerShell(ownerRefused({ dacl: null }))
  assert.throws(() => vaultModule.protectWindowsDirectory(fakeFolder(), { ino: 6 }, ps.run), { code: 'unsafe_profile', reason: 'other_writer' })
  assert.equal(ps.scripts.length, 1)
})

test('Windows owner step fails closed: no PowerShell, an unreadable owner, a lock that fails or does not read back as the user\'s alone', () => {
  const cases: Array<[string, any[], string]> = [
    ['PowerShell did not finish', [{ failed: 'PowerShell did not finish within 10 s' }], 'acl_step_failed'],
    ['the owner could not be read', [ownerRefused({ owner: undefined, ownerName: undefined, readError: 'denied' })], 'owner_not_set'],
    ['no access list in the answer', [ownerRefused({ dacl: undefined })], 'owner_not_set'],
    ['the lock is refused', [ownerRefused({ dacl: [entry(ME, MODIFY)] }), { ...lockedForMe, set: false, error: 'denied' }], 'not_private'],
    ['the lock step does not finish', [ownerRefused({ dacl: [entry(ME, MODIFY)] }), { failed: 'PowerShell did not finish within 10 s' }], 'acl_step_failed'],
    ['read back with a second entry', [ownerRefused({ dacl: [entry(ME, MODIFY)] }), { ...lockedForMe, dacl: [entry(ME, FULL), entry('S-1-5-11', READ_EXECUTE)] }], 'not_private'],
    ['read back unprotected', [ownerRefused({ dacl: [entry(ME, MODIFY)] }), { ...lockedForMe, protected: false }], 'not_private'],
    ['read back owned by another account', [ownerRefused({ dacl: [entry(ME, MODIFY)] }), { ...lockedForMe, owner: OTHER }], 'not_private'],
    ['read back with less than Full control', [ownerRefused({ dacl: [entry(ME, MODIFY)] }), { ...lockedForMe, dacl: [entry(ME, MODIFY)] }], 'not_private'],
    ['read back with its one entry for another account', [ownerRefused({ dacl: [entry(ME, MODIFY)] }), { ...lockedForMe, dacl: [entry(OTHER, FULL)] }], 'not_private'],
    ['read back with its one entry a deny', [ownerRefused({ dacl: [entry(ME, MODIFY)] }), { ...lockedForMe, dacl: [entry(ME, FULL, { type: 1 })] }], 'not_private'],
    ['read back with its entry not handed to what is made in it', [ownerRefused({ dacl: [entry(ME, MODIFY)] }), { ...lockedForMe, dacl: [entry(ME, FULL, { flags: 0 })] }], 'not_private'],
    ['read back with its entry inherited', [ownerRefused({ dacl: [entry(ME, MODIFY)] }), { ...lockedForMe, dacl: [entry(ME, FULL, { flags: 0x13 })] }], 'not_private'],
    ['read back with no access list', [ownerRefused({ dacl: [entry(ME, MODIFY)] }), { ...lockedForMe, dacl: null }], 'not_private'],
  ]
  for (const [label, answers, reason] of cases) {
    const ps = fakePowerShell(...answers)
    assert.throws(() => vaultModule.protectWindowsDirectory(fakeFolder(), { ino: 7 }, ps.run), (error: any) => {
      assert.equal(error.code, 'unsafe_profile', label)
      assert.equal(error.reason, reason, label)
      assert.match(error.message, /^unsafe_profile: \S/, label)
      assert.equal(typeof error.detail, 'string', label)
      return true
    }, label)
  }
})

// ── The same cases on the REAL file system (Windows, icacls) ─────────────────

function system32(exe: string): string {
  return join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', exe)
}
function currentSid(): string {
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(spawnSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).stdout.trim())?.[1]
  assert.ok(sid, 'the current user SID')
  return sid
}
function icacls(dir: string, ...args: string[]) {
  const r = spawnSync(system32('icacls.exe'), [dir, ...args], { encoding: 'utf8' })
  assert.equal(r.status, 0, `icacls ${args.join(' ')}: ${r.stdout}${r.stderr}`)
}
/** The folder's owner and access list, read with Get-Acl, independently of the vault. */
function securityOf(dir: string): string {
  const r = spawnSync(system32('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-Acl -LiteralPath $env:VAULT_TEST_FOLDER).GetSecurityDescriptorSddlForm('Owner,Access')"], { encoding: 'utf8', windowsHide: true, env: { ...process.env, VAULT_TEST_FOLDER: dir } })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
const asTrustee = (sid: string) => /^S-1-5-21-[0-9-]+-500$/.test(sid) ? `(${sid}|LA)` : sid
/** A temp folder the test user owns, with exactly these access entries ("ME" is the user). */
function aclFolder(t: any, grants: string[], name = 'profile') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vault-acl-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, name), me = currentSid()
  mkdirSync(dir)
  // An elevated runner makes Administrators the owner of what it creates; an
  // unelevated user already owns it (and may lack the right to set it again).
  spawnSync(system32('icacls.exe'), [dir, '/setowner', `*${me}`], { encoding: 'utf8' })
  icacls(dir, '/inheritance:r', '/grant:r', ...grants.map(grant => grant.replace(/^ME:/, `*${me}:`)))
  const before = securityOf(dir)
  assert.match(before, new RegExp(`^O:${asTrustee(me)}D:`), 'the fixture folder is the user\'s own')
  return { dir, me, before }
}
const lockedSddl = (me: string) => new RegExp(`^O:${asTrustee(me)}D:P(AI)?\\(A;OICI;FA;;;${asTrustee(me)}\\)$`)
const windowsOnly = { skip: process.platform !== 'win32' ? 'Windows only (the mocked cases above run everywhere)' : false }

test('REAL ACL: Modify only, the user\'s own and private: accepted, and locked to the user exactly as with Full control', windowsOnly, t => {
  const { dir, me } = aclFolder(t, ['ME:(OI)(CI)M'])
  assert.doesNotThrow(() => new AgentBrowserVault({ profileDir: dir, scope: 'fixture' }))
  assert.match(securityOf(dir), lockedSddl(me))
})

test('REAL ACL: Modify only, read-only for Users: accepted, and the read entry is gone afterwards', windowsOnly, t => {
  const { dir, me } = aclFolder(t, ['ME:(OI)(CI)M', '*S-1-5-32-545:(OI)(CI)RX'])
  assert.doesNotThrow(() => new AgentBrowserVault({ profileDir: dir, scope: 'fixture' }))
  assert.match(securityOf(dir), lockedSddl(me))
})

test('REAL ACL: Full control (unchanged): accepted and taken over, even with another account that can write', windowsOnly, t => {
  const { dir, me } = aclFolder(t, ['ME:(OI)(CI)F', '*S-1-5-11:(OI)(CI)M'])
  assert.doesNotThrow(() => new AgentBrowserVault({ profileDir: dir, scope: 'fixture' }))
  assert.match(securityOf(dir), lockedSddl(me))
})

test('REAL ACL: a folder name with a non-ASCII letter and a curly quote reaches Windows intact (Modify only and Full control)', windowsOnly, t => {
  for (const grant of ['ME:(OI)(CI)M', 'ME:(OI)(CI)F']) {
    const { dir, me } = aclFolder(t, [grant], 'José\u2019s profile')
    assert.doesNotThrow(() => new AgentBrowserVault({ profileDir: dir, scope: 'fixture' }), grant)
    assert.match(securityOf(dir), lockedSddl(me), grant)
  }
  const { dir, before } = aclFolder(t, ['ME:(OI)(CI)M', '*S-1-5-11:(OI)(CI)M'], 'José\u2019s profile')
  assert.throws(() => new AgentBrowserVault({ profileDir: dir, scope: 'fixture' }), (error: any) => {
    assert.equal(error.reason, 'other_writer', error.detail)
    assert.ok(error.detail.includes(dir), error.detail)
    return true
  })
  assert.equal(securityOf(dir), before)
})

const REAL_WRITERS: Array<[string, string, RegExp]> = [
  ['Authenticated Users with Modify, as on E:', '*S-1-5-11:(OI)(CI)M', /Authenticated Users|S-1-5-11/],
  ['Authenticated Users inherit-only Modify', '*S-1-5-11:(OI)(CI)(IO)M', /Authenticated Users|S-1-5-11/],
  ['SYSTEM with Full control', '*S-1-5-18:(OI)(CI)F', /SYSTEM|S-1-5-18/],
]
for (const [label, grant, named] of REAL_WRITERS) {
  test(`REAL ACL: Modify only and another account can write (${label}): refused with the reason, folder untouched`, windowsOnly, t => {
    const { dir, before } = aclFolder(t, ['ME:(OI)(CI)M', grant])
    assert.throws(() => new AgentBrowserVault({ profileDir: dir, scope: 'fixture' }), (error: any) => {
      assert.equal(error.code, 'unsafe_profile')
      assert.equal(error.reason, 'other_writer')
      assert.match(error.message, /^unsafe_profile: another account can write to the browser profile folder/)
      assert.match(error.detail, named)
      return true
    })
    assert.equal(securityOf(dir), before)
  })
}

test('REAL ACL: Modify only and another account owns the folder: refused with the reason, folder untouched', windowsOnly, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vault-acl-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'profile'), me = currentSid()
  mkdirSync(dir)
  const owned = spawnSync(system32('icacls.exe'), [dir, '/setowner', '*S-1-5-32-544'], { encoding: 'utf8' })
  if (owned.status !== 0) {
    t.skip('giving a folder to another owner needs an elevated token (CI has one); the mocked case covers it here')
    return
  }
  icacls(dir, '/inheritance:r', '/grant:r', `*${me}:(OI)(CI)M`)
  const before = securityOf(dir)
  assert.throws(() => new AgentBrowserVault({ profileDir: dir, scope: 'fixture' }), (error: any) => {
    assert.equal(error.code, 'unsafe_profile')
    assert.equal(error.reason, 'owner_foreign')
    assert.match(error.detail, /Administrators|S-1-5-32-544/)
    return true
  })
  assert.equal(securityOf(dir), before)
})

// ── Where the refusal is reported: the agent's answer and the host log ───────

test('a refused profile folder tells the agent why (no path), and the host log names the folder', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vault-host-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'real'))
  const agentRoot = join(root, 'agents')
  symlinkSync(join(root, 'real'), agentRoot, process.platform === 'win32' ? 'junction' : 'dir')
  const logs: string[] = []
  const pool = new BrowserPool({ agentRoot, log: ((line: string) => { logs.push(line) }) as any,
    createEngine: (paths: any) => new ChromiumEngine({ ...paths, executable: 'unused' }) as any })
  const core = new BrowserHostCore({ pool, browserTools: [], deviceLabel: 'fixture' } as any)
  const context = { assistantId: 901, principal: 'user-fixture' }
  const result: any = await core.callTool(context, 'hoai_browser_open_session', {})
  assert.equal(result.isError, true)
  const text = result.content[0].text
  assert.match(text, /unsafe_profile: a folder above the browser profile folder is a link or not a plain folder\./)
  assert.ok(!text.includes(root), text)
  const profileDir = pool.pathsFor(context).profileDir
  assert.ok(logs.some(line => line.includes(profileDir) && line.includes('alias') && line.includes(agentRoot)), logs.join('\n'))
  await pool.stopAll()
})

test('REAL ACL: on a Modify-only drive the agent hears that another account can write, and the log names it', windowsOnly, async t => {
  const agentRoot = realpathSync(mkdtempSync(join(tmpdir(), 'vault-host-')))
  t.after(() => rmSync(agentRoot, { recursive: true, force: true }))
  const logs: string[] = []
  const pool = new BrowserPool({ agentRoot, log: ((line: string) => { logs.push(line) }) as any,
    createEngine: (paths: any) => new ChromiumEngine({ ...paths, executable: 'unused' }) as any })
  const core = new BrowserHostCore({ pool, browserTools: [], deviceLabel: 'fixture' } as any)
  const context = { assistantId: 901, principal: 'user-fixture' }
  // The profile folder as E: hands it down: the user's own, Modify for the user and for Authenticated Users.
  const profileDir = pool.pathsFor(context).profileDir, me = currentSid()
  mkdirSync(profileDir, { recursive: true })
  spawnSync(system32('icacls.exe'), [profileDir, '/setowner', `*${me}`], { encoding: 'utf8' })
  icacls(profileDir, '/inheritance:r', '/grant:r', `*${me}:(OI)(CI)M`, '*S-1-5-11:(OI)(CI)M')
  assert.match(securityOf(profileDir), new RegExp(`^O:${asTrustee(me)}D:`))
  const result: any = await core.callTool(context, 'hoai_browser_open_session', {})
  assert.equal(result.isError, true)
  const text = result.content[0].text
  assert.match(text, /unsafe_profile: another account can write to the browser profile folder\. /)
  assert.ok(!text.includes(agentRoot), text)
  assert.doesNotMatch(text, /S-1-|Authenticated Users|SYSTEM|Administrators|ALIENARES|\\/, 'no SID, account or path reaches the agent')
  assert.ok(logs.some(line => line.includes(pool.pathsFor(context).profileDir) && /other_writer/.test(line) && /Authenticated Users|S-1-5-11/.test(line)), logs.join('\n'))
  await pool.stopAll()
})

test('POSIX: a folder above the profile that its group or everyone can write is refused with that reason', { skip: process.platform === 'win32' ? 'POSIX only' : false }, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vault-posix-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  chmodSync(root, 0o777)
  assert.throws(() => new AgentBrowserVault({ profileDir: join(root, 'profile'), scope: 'fixture' }), (error: any) => {
    assert.equal(error.code, 'unsafe_profile')
    assert.equal(error.reason, 'other_writer')
    assert.match(error.message, /^unsafe_profile: another account can write to a folder above the browser profile folder\. /)
    assert.ok(error.detail.includes(root), error.detail)
    return true
  })
})
