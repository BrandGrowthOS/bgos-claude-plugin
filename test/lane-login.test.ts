/**
 * PERSON LANES, whose Claude sign in a lane uses (decision K2, design 4.3).
 *
 *   - The mode is per share (agent, person): `inherit` unless the owner chose
 *     `own_token`; an unreadable or unknown mode is `inherit`.
 *   - `own_token` NEVER falls back: a missing or unreadable token is a notice,
 *     not the owner's login.
 *   - The macOS store hands the token to `security` on STDIN (through
 *     `security -i`), never on a command line where `ps` would show it, and
 *     reads it back with `find-generic-password -w`; exit 44 is "missing".
 *   - The Linux store is a 0600 file; Windows has none (lanes are not
 *     declared there).
 *   - A token is refused before it is stored unless it has the shape
 *     `claude setup-token` prints (nothing a command parser could split).
 *
 * Run with: npx tsx --test test/lane-login.test.ts
 */
import { test as nodeTest } from 'node:test'

// Lanes are not offered on Windows (lib/lane-cli-probe.mjs refuses win32), and these
// tests assume POSIX hosts (an expect binary, 0600 modes, symlink realpaths), so the
// file is skipped there. Each platform rule is still asserted through the injected
// platform on the macOS and Linux runners.
const SKIP_ON_WINDOWS = process.platform === 'win32' ? 'lanes are not offered on Windows' : false
const test = (name: string, fn: () => unknown) => nodeTest(name, { skip: SKIP_ON_WINDOWS }, fn as never)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  isPlausibleLaneToken,
  laneConfigSeed,
  laneTokenAccount,
  laneTokenStore,
  LANE_TOKEN_SERVICE,
  loginModeFor,
  readLoginModes,
  resolveLaneLogin,
  writeLoginMode,
} from '../lib/lane-login.mjs'

const TOKEN = 'sk-ant-oat01-STANDIN-abcdefghijklmnop'

test('the mode is per share, inherit by default, and unknown values read as inherit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lane-login-'))
  try {
    const path = join(dir, 'people', 'login-modes.json')
    assert.equal(loginModeFor(path, 'user_ana'), 'inherit')
    writeLoginMode(path, 'user_ana', 'own_token')
    assert.equal(loginModeFor(path, 'user_ana'), 'own_token')
    assert.equal(loginModeFor(path, 'user_ben'), 'inherit')
    assert.equal(statSync(path).mode & 0o077, 0)
    writeLoginMode(path, 'user_ana', 'inherit')
    assert.deepEqual(readLoginModes(path), {})
    writeFileSync(path, JSON.stringify({ v: 1, modes: { user_ana: 'owner_login', '../x': 'own_token', user_ben: 'own_token' } }))
    assert.deepEqual(readLoginModes(path), { user_ben: 'own_token' })
    writeFileSync(path, 'nonsense')
    assert.equal(loginModeFor(path, 'user_ben'), 'inherit')
    assert.throws(() => writeLoginMode(path, 'user_ana', 'owner'), /mode must be one of/)
    assert.throws(() => writeLoginMode(path, '../user', 'inherit'), /unsafe/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('own_token never falls back: missing or unreadable is a notice, inherit needs no token', () => {
  const store = (answer: unknown) => ({ read: () => answer }) as never
  assert.deepEqual(resolveLaneLogin({ mode: 'inherit', assistantId: '1', userId: 'u', configDir: '/c', store: store(null) }), { ok: true, login: { mode: 'inherit' } })
  assert.deepEqual(resolveLaneLogin({ mode: 'own_token', assistantId: '1', userId: 'u', configDir: '/c', store: store({ ok: true, token: TOKEN }) }), { ok: true, login: { mode: 'own_token', token: TOKEN, configDir: '/c' } })
  assert.deepEqual(resolveLaneLogin({ mode: 'own_token', assistantId: '1', userId: 'u', configDir: '/c', store: store({ ok: false, reason: 'missing' }) }), { ok: false, notice: 'login_token_missing', reason: 'missing' })
  const throwing = { read: () => { throw new Error('keychain locked') } } as never
  assert.deepEqual(resolveLaneLogin({ mode: 'own_token', assistantId: '1', userId: 'u', configDir: '/c', store: throwing }), { ok: false, notice: 'login_token_missing', reason: 'unreadable' })
})

test('macOS: the token goes to security on stdin only, and is read back with -w', () => {
  const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
  let stored: string | null = null
  const run = ((cmd: string, args: string[], opts: { input?: string }) => {
    calls.push({ cmd, args, input: opts?.input })
    if (args[0] === '-i') {
      stored = /-w "([^"]+)"/.exec(opts.input ?? '')?.[1] ?? null
      return { status: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'find-generic-password') return stored ? { status: 0, stdout: `${stored}\n`, stderr: '' } : { status: 44, stdout: '', stderr: 'not found' }
    if (args[0] === 'delete-generic-password') {
      stored = null
      return { status: 0, stdout: '', stderr: '' }
    }
    return { status: 1 }
  }) as never
  const store = laneTokenStore({ platform: 'darwin', run })
  assert.equal(store.kind, 'macos-keychain')
  assert.deepEqual(store.read('1076', 'user_ana'), { ok: false, reason: 'missing' })
  store.write('1076', 'user_ana', TOKEN)
  for (const c of calls) assert.ok(!c.args.some((a) => a.includes(TOKEN)), 'the token is never in argv')
  const write = calls.find((c) => c.args[0] === '-i')
  assert.ok(write?.input?.includes(`-s "${LANE_TOKEN_SERVICE}" -a "1076:user_ana"`))
  assert.deepEqual(store.read('1076', 'user_ana'), { ok: true, token: TOKEN })
  assert.equal(store.remove('1076', 'user_ana'), true)
  assert.throws(() => store.write('1076', 'user_ana', 'has a space " -w evil'), /does not look like/)
  assert.equal(laneTokenAccount('1076', 'user_ana'), '1076:user_ana')
  assert.throws(() => laneTokenAccount('1076', 'a"b'), /unsafe/)
})

test('Linux: a 0600 file; Windows: no store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lane-login-'))
  try {
    const store = laneTokenStore({ platform: 'linux', fileStoreDir: (a, u) => join(dir, a, 'lanes', u) })
    assert.deepEqual(store.read('1076', 'user_ana'), { ok: false, reason: 'missing' })
    store.write('1076', 'user_ana', TOKEN)
    const file = join(dir, '1076', 'lanes', 'user_ana', 'lane-token')
    assert.equal(statSync(file).mode & 0o077, 0)
    assert.equal(readFileSync(file, 'utf8').trim(), TOKEN)
    assert.deepEqual(store.read('1076', 'user_ana'), { ok: true, token: TOKEN })
    const win = laneTokenStore({ platform: 'win32' })
    assert.equal(win.kind, 'unsupported')
    assert.deepEqual(win.read('1076', 'user_ana'), { ok: false, reason: 'store_unsupported' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the token shape, and a lane config seed that holds no credential', () => {
  assert.ok(isPlausibleLaneToken(TOKEN))
  for (const bad of ['', 'short', 'has space here and more', 'quote"inside-token-xx', `x${'y'.repeat(5000)}`]) assert.ok(!isPlausibleLaneToken(bad))
  const seed = laneConfigSeed({ workDir: '/w', existing: { theme: 'light', projects: { '/other': { a: 1 } } } })
  assert.equal(seed.hasCompletedOnboarding, true)
  assert.equal(seed.theme, 'light')
  assert.deepEqual(seed.projects['/other'], { a: 1 })
  assert.equal(seed.projects['/w'].hasTrustDialogAccepted, true)
  assert.ok(!JSON.stringify(seed).toLowerCase().includes('token'))
})
