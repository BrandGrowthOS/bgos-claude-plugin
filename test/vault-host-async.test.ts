import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { readdirSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as vault from '../lib/vault-host.mjs'

const exec = promisify(execFile)
const safeAcl = { ownerSid: 'S-1-5-21-1000', userSid: 'S-1-5-21-1000', protected: true,
  entries: [{ sid: 'S-1-5-21-1000', type: 'Allow', rights: 2032127 }] }

test('no vault module imports or calls spawnSync', () => {
  for (const file of readdirSync(new URL('../lib/', import.meta.url)).filter(file => /vault.*\.(mjs|ts)$/.test(file))) {
    assert.doesNotMatch(readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8'), /\bspawnSync\b/, file)
  }
  assert.doesNotMatch(readFileSync(new URL('../lib/vault-host.mjs', import.meta.url), 'utf8'), /\bexecFileSync\b/)
})

test('Windows ACL subprocess yields to timers and passes paths as data with bounded execFile and no shell', async () => {
  const create = (vault as any).createWindowsVaultSecurity
  assert.equal(typeof create, 'function')
  let ticked = false
  const tick = setTimeout(() => { ticked = true }, 0)
  const path = "fixture's \u00e9; $(ignored)"
  const security = create({ execFileImpl(command: string, args: string[], options: any, callback: any) {
    assert.equal(command, 'powershell.exe')
    assert.equal(options.shell, false)
    // Bounded, and long enough for a real PC: 30 s since 2026-11-12, when 10 s was measured too short on a new Windows 11 install.
    assert.equal(options.timeout, 30_000)
    assert.equal(options.maxBuffer, 1024 * 1024)
    assert.equal(options.windowsHide, true)
    assert.equal(options.env.HOAI_VAULT_ACL_PATH, path)
    assert.ok(!args.join(' ').includes(path))
    setTimeout(() => callback(null, JSON.stringify({ userSid: 'S-1-5-21-1000' })), 20)
  } })
  try {
    const pending = security.readWindowsAcl(path)
    assert.ok(pending instanceof Promise)
    assert.equal((await pending).userSid, 'S-1-5-21-1000')
    assert.equal(ticked, true, 'a pending ACL subprocess must leave the event loop available')
  } finally { clearTimeout(tick) }
})

test('vault imports are inert even on Windows with every subprocess entry point trapped', { timeout: 15_000 }, async () => {
  const modules = ['../lib/vault-host.mjs', '../lib/agent-browser-vault.mjs', '../lib/vault-tools.ts', '../bin/hoai-vault-host.mjs']
    .map(path => new URL(path, import.meta.url).href)
  const code = `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
      cp[name] = () => { throw new Error('subprocess at import: ' + name); };
    }
    syncBuiltinESMExports();
    for (const url of ${JSON.stringify(modules)}) await import(url);
    console.log('inert');
  `
  const { stdout, stderr } = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { timeout: 10_000 })
  assert.equal(stdout.trim(), 'inert')
  assert.equal(stderr, '')
})

test('ACL deadline terminates a real hung subprocess without blocking the event loop or exposing its output', { timeout: 10_000 }, async () => {
  let ticked = false
  const tick = setTimeout(() => { ticked = true }, 0)
  const security = vault.createWindowsVaultSecurity({ timeoutMs: 100,
    execFileImpl: ((_command: any, _args: any, options: any, callback: any) => execFile(process.execPath,
      ['-e', "process.stderr.write('PRIVATE_CANARY'); setInterval(() => {}, 1000)"], options, callback)) as typeof execFile,
  })
  try {
    await assert.rejects(security.readWindowsAcl('fixture'), error => {
      assert.equal((error as any).code, 'VAULT_HOST_KEY_EXPOSED')
      assert.doesNotMatch(String(error), /PRIVATE_CANARY/)
      return true
    })
    assert.equal(ticked, true)
  } finally { clearTimeout(tick) }
})

for (const failure of ['timeout', 'nonzero', 'missing', 'overflow', 'malformed']) {
  test(`async Windows ACL ${failure} fails closed before any key read or write`, async t => {
    const root = fs.mkdtempSync(join(tmpdir(), 'vault-async-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const dir = join(root, 'vault')
    fs.mkdirSync(dir)
    fs.writeFileSync(join(dir, vault.VAULT_HOST_FILE_NAME), 'must not read')
    let reads = 0, writes = 0
    const guarded = { ...fs,
      readFileSync() { reads++; throw new Error('must not read') },
      writeFileSync() { writes++; throw new Error('must not write') },
    } as unknown as typeof fs
    const security = vault.createWindowsVaultSecurity({ execFileImpl: ((_command: any, _args: any, _options: any, callback: any) => {
      const codes = { timeout: 'ETIMEDOUT', nonzero: 1, missing: 'ENOENT', overflow: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }
      setImmediate(() => callback(failure === 'malformed' ? null : Object.assign(new Error('private subprocess detail'), { code: codes[failure as keyof typeof codes] }), 'not JSON'))
    }) as typeof execFile })
    await assert.rejects(vault.readHostRecord(dir, guarded, security), { code: 'VAULT_HOST_KEY_EXPOSED' })
    await assert.rejects(vault.loadOrCreateHostKey(dir, 42, guarded, security), { code: 'VAULT_HOST_KEY_EXPOSED' })
    assert.equal(reads, 0)
    assert.equal(writes, 0)
  })
}

test('an unresolved ACL restriction leaves the temporary file empty until protection and verification finish', async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'vault-pending-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'vault')
  fs.mkdirSync(dir)
  let release!: () => void, empty!: () => void
  const reached = new Promise<void>(resolve => { empty = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  let writes = 0
  const security = {
    platform: 'win32',
    async readWindowsAcl() { return safeAcl },
    async restrictWindowsAcl(path: string) {
      assert.ok(path.endsWith('.tmp'))
      assert.equal(fs.statSync(path).size, 0)
      empty()
      await pending
    },
  }
  const guarded = { ...fs, writeFileSync(...args: any[]) { writes++; return (fs.writeFileSync as any)(...args) } } as typeof fs
  const operation = vault.loadOrCreateHostKey(dir, 42, guarded, security)
  try {
    await reached
    assert.equal(writes, 0)
    assert.equal(fs.existsSync(join(dir, vault.VAULT_HOST_FILE_NAME)), false)
  } finally { release(); await operation }
  assert.equal(writes, 1)
})

test('REAL Windows host ACL: create and reopen a protected key with bounded asynchronous PowerShell',
  { skip: process.platform !== 'win32', timeout: 120_000 }, async t => {
    const root = fs.mkdtempSync(join(tmpdir(), 'vault-real-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const dir = join(root, "vault's \u00e9")
    const first = await vault.loadOrCreateHostKey(dir, 42)
    const reopened = await vault.readHostRecord(dir)
    assert.equal(reopened.hostSeed, first.hostSeed)
    assert.equal(reopened.publicKey, first.publicKey)
    assert.deepEqual(fs.readdirSync(dir), [vault.VAULT_HOST_FILE_NAME])
  })
