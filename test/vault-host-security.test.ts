import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeyPairSync } from 'node:crypto'
import { loadOrCreateHostKey, provisionSigningIdentity, readHostRecord, VAULT_HOST_FILE_NAME } from './helpers/vault-host.mjs'

const OWNER = 'S-1-5-21-1000'
const OTHER = 'S-1-5-21-2000'
const safeAcl = () => ({ ownerSid: OWNER, userSid: OWNER, protected: true, entries: [{ sid: OWNER, type: 'Allow', rights: 2032127 }] })
function storage() {
  const root = fs.mkdtempSync(join(tmpdir(), 'vault-acl-'))
  const dir = join(root, 'vault')
  const acls = new Map<string, ReturnType<typeof safeAcl>>()
  const checked: string[] = []
  const restricted: string[] = []
  const security = {
    platform: 'win32' as const,
    async readWindowsAcl(path: string) { checked.push(path); return acls.get(path) ?? safeAcl() },
    async restrictWindowsAcl(path: string) { restricted.push(path); acls.set(path, safeAcl()) },
  }
  return { root, dir, acls, checked, restricted, security }
}
function exposed() { const acl = safeAcl(); acl.entries.push({ sid: OTHER, type: 'Allow', rights: 1 }); return acl }
const refusal = (error: unknown) => error instanceof Error && /VAULT_HOST_KEY_EXPOSED/.test(error.message) && /Security.*Advanced/.test(error.message)

for (const target of ['file', 'directory']) {
  test(`Windows ACL: refuses an existing exposed ${target} before reading either key`, async () => {
    const s = storage()
    try {
      await loadOrCreateHostKey(s.dir, 42, fs, s.security)
      const secret = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
      await provisionSigningIdentity(s.dir, 42, secret, fs, s.security)
      s.acls.set(target === 'file' ? join(s.dir, VAULT_HOST_FILE_NAME) : s.dir, exposed())
      let reads = 0
      const guarded = { ...fs, readFileSync() { reads++; throw new Error('must not read') } } as unknown as typeof fs
      await assert.rejects(() => readHostRecord(s.dir, guarded, s.security), refusal)
      await assert.rejects(() => loadOrCreateHostKey(s.dir, 42, fs, s.security), refusal)
      await assert.rejects(() => provisionSigningIdentity(s.dir, 42, secret, fs, s.security), refusal)
      assert.equal(reads, 0)
    } finally { fs.rmSync(s.root, { recursive: true, force: true }) }
  })
}

for (const bad of ['owner', 'unknown', 'unprotected', 'empty', 'reader-error']) {
  test(`Windows ACL: fails closed for ${bad}`, async () => {
    const s = storage()
    try {
      await loadOrCreateHostKey(s.dir, 42, fs, s.security)
      const acl = safeAcl()
      if (bad === 'owner') acl.ownerSid = OTHER
      if (bad === 'unprotected') acl.protected = false
      if (bad === 'empty') acl.entries = []
      s.acls.set(join(s.dir, VAULT_HOST_FILE_NAME), acl)
      const readWindowsAcl = bad === 'reader-error' ? async () => { throw new Error('fixture failure') } : bad === 'unknown' ? async () => null : s.security.readWindowsAcl
      await assert.rejects(() => readHostRecord(s.dir, fs, { ...s.security, readWindowsAcl }), refusal)
    } finally { fs.rmSync(s.root, { recursive: true, force: true }) }
  })
}

test('Windows ACL: new directory and empty temporary files are restricted and verified before secret bytes are written', async () => {
  const s = storage()
  try {
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
        assert.ok(s.restricted.includes(name), 'temporary file restricted first')
        assert.ok(s.checked.includes(name), 'temporary file ACL checked first')
      }
      return fs.writeFileSync(path, data, options)
    } } as typeof fs
    await loadOrCreateHostKey(s.dir, 42, guarded, s.security)
    const secret = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
    await provisionSigningIdentity(s.dir, 42, secret, guarded, s.security)
    assert.equal(keyWrites, 2)
    assert.equal(s.restricted.filter(p => p.endsWith('.tmp')).length, 2)
    assert.ok(s.restricted.includes(s.dir))
    assert.ok(s.restricted.some(p => p.endsWith('.tmp')))
    assert.ok(s.checked.includes(join(s.dir, VAULT_HOST_FILE_NAME)))
    assert.ok(await readHostRecord(s.dir, fs, s.security))
    assert.deepEqual(fs.readdirSync(s.dir), [VAULT_HOST_FILE_NAME])
  } finally { fs.rmSync(s.root, { recursive: true, force: true }) }
})

test('Windows ACL: an exposed existing directory blocks creation before any secret file is made', async () => {
  const s = storage()
  try {
    fs.mkdirSync(s.dir)
    s.acls.set(s.dir, exposed())
    await assert.rejects(() => loadOrCreateHostKey(s.dir, 42, fs, s.security), refusal)
    assert.deepEqual(fs.readdirSync(s.dir), [])
  } finally { fs.rmSync(s.root, { recursive: true, force: true }) }
})

test('Windows ACL: failed temporary protection removes the empty file and never writes keys', async () => {
  const s = storage()
  try {
    const security = { ...s.security, async restrictWindowsAcl(path: string) {
      if (path.endsWith('.tmp')) throw new Error('fixture failure')
      await s.security.restrictWindowsAcl(path)
    } }
    await assert.rejects(() => loadOrCreateHostKey(s.dir, 42, fs, security), refusal)
    assert.deepEqual(fs.readdirSync(s.dir), [])
  } finally { fs.rmSync(s.root, { recursive: true, force: true }) }
})

test('POSIX modes: fresh directory and both key writes stay private with umask zero', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'vault-mode-'))
  const dir = join(root, 'new-vault')
  const previous = process.umask(0)
  try {
    assert.equal(fs.existsSync(dir), false)
    await loadOrCreateHostKey(dir, 42)
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
    assert.equal(fs.statSync(join(dir, VAULT_HOST_FILE_NAME)).mode & 0o777, 0o600)
    const secret = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
    await provisionSigningIdentity(dir, 42, secret)
    assert.equal(fs.statSync(join(dir, VAULT_HOST_FILE_NAME)).mode & 0o777, 0o600)
  } finally { process.umask(previous); fs.rmSync(root, { recursive: true, force: true }) }
})

test('Windows ACL: successful restriction with an exposed result still refuses before writing keys', async () => {
  const s = storage()
  try {
    const security = { ...s.security, async readWindowsAcl(path: string) { return path.endsWith('.tmp') ? exposed() : safeAcl() } }
    await assert.rejects(() => loadOrCreateHostKey(s.dir, 42, fs, security), refusal)
    assert.deepEqual(fs.readdirSync(s.dir), [])
  } finally { fs.rmSync(s.root, { recursive: true, force: true }) }
})

test('Windows ACL: symlinks are refused even when the injected ACL is private', async () => {
  const s = storage()
  try {
    await loadOrCreateHostKey(s.dir, 42, fs, s.security)
    const linked = { ...fs, lstatSync: (path: fs.PathLike) => ({ ...fs.lstatSync(path), isSymbolicLink: () => true }) } as unknown as typeof fs
    await assert.rejects(() => readHostRecord(s.dir, linked, s.security), refusal)
  } finally { fs.rmSync(s.root, { recursive: true, force: true }) }
})

for (const target of ['directory', 'owner']) {
  test(`POSIX protection: exposed ${target} refuses the stored key`, { skip: process.platform === 'win32' }, async () => {
    const s = storage()
    try {
      await loadOrCreateHostKey(s.dir, 42)
      if (target === 'directory') fs.chmodSync(s.dir, 0o755)
      const foreign = target === 'owner' ? { ...fs, lstatSync: (path: fs.PathLike) => {
        const st = fs.lstatSync(path)
        return { ...st, uid: process.getuid!() + 1, isSymbolicLink: () => false }
      } } as unknown as typeof fs : fs
      await assert.rejects(() => readHostRecord(s.dir, foreign), /VAULT_HOST_KEY_EXPOSED/)
    } finally { fs.rmSync(s.root, { recursive: true, force: true }) }
  })
}
