/**
 * Which Claude account is signed in (lib/claude-account-id.mjs): the proof a switch at the limit
 * stands on. Usage counts as back on a login only when the ACCOUNT changed, never when a file moved.
 *
 * No run of the real CLI here: a fake read, or (Windows, M3) a stand in shim. Nothing signs in or
 * out, and no credential is read.
 *
 * Run: node --import tsx --test test/claude-account-id.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FIXTURE_ORG, seatStatus, seatToken } from './helpers/claude-auth-status.ts'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import * as accountIds from '../lib/claude-account-id.mjs'
import {
  ACCOUNT_READ_EVERY_MS, accountChanged, accountTokenFrom, agentAccountDir, boundedExec, createStatusReader, peekAccount, statusInput,
} from '../lib/claude-account-id.mjs'

const A_UUID = '0b6c1f8e-1111-4aaa-8bbb-000000000001'
const B_UUID = '0b6c1f8e-2222-4aaa-8bbb-000000000002'
const ORG = 'f00dfeed-3333-4ccc-8ddd-000000000003'
const status = (o: Record<string, unknown>) => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', ...o })

// -- the token: one way, kind tagged -------------------------------------------------------------------

test('the account id from claude auth status --json becomes a one way token; the raw id is never kept', () => {
  const a = accountTokenFrom(status({ accountUuid: A_UUID, orgId: ORG }))
  assert.match(a!, /^account:[0-9a-f]{32}$/)
  assert.ok(!a!.includes(A_UUID) && !a!.includes(ORG))
  assert.equal(accountTokenFrom(status({ accountUuid: A_UUID })), a, 'the same account is the same token')
  assert.notEqual(accountTokenFrom(status({ accountUuid: B_UUID })), a)
  // A preamble before the JSON (a wrapped CLI) is read the way the doctor reads it.
  assert.equal(accountTokenFrom(`note: update available\n${status({ accountUuid: A_UUID })}\n`), a)
})

test('two seats of one Team organization (the CLI 2.1.330 key set: orgId and email) are two accounts; the same seat is one', () => {
  const ana = accountTokenFrom(seatStatus('ana@seats.example.test'))
  const ben = accountTokenFrom(seatStatus('ben@seats.example.test'))
  assert.match(ana!, /^seat:[0-9a-f]{32}$/)
  assert.notEqual(ana, ben)
  assert.equal(accountChanged(ana, ben), true, 'another seat in the same organization is another account')
  assert.equal(accountTokenFrom(seatStatus('ana@seats.example.test')), ana, 'the same seat again is the same token')
  assert.equal(accountChanged(ana, accountTokenFrom(seatStatus('ana@seats.example.test'))), false)
  assert.equal(accountTokenFrom(seatStatus(' Ana@Seats.Example.Test ')), ana, 'an email in another case is the same seat')
  assert.notEqual(accountTokenFrom(seatStatus('ana@seats.example.test', ORG)), ana, 'the same email in another organization is another seat')
  for (const raw of ['ana@seats.example.test', 'ana', FIXTURE_ORG, 'Fixture Team']) assert.ok(!ana!.includes(raw), raw)
})

test('a missing or empty email, or a missing or empty organization, names no account: unknown, like a failed read', () => {
  for (const [name, out] of [
    ['no email key', seatStatus(null)],
    ['empty email', seatStatus('')],
    ['blank email', seatStatus('   ')],
    ['email not a string', seatStatus(null, FIXTURE_ORG, { email: 7 })],
    ['no orgId key', seatStatus('ana@seats.example.test', null)],
    ['empty orgId', seatStatus('ana@seats.example.test', '')],
  ])
    assert.equal(accountTokenFrom(out), null, name)
})

test('an accountUuid, if a CLI prints one, is its own kind and is never compared with a seat', () => {
  const both = accountTokenFrom(seatStatus('ana@seats.example.test', FIXTURE_ORG, { accountUuid: A_UUID }))
  assert.equal(both, accountTokenFrom(status({ accountUuid: A_UUID })), 'the account id wins when it is printed')
  assert.match(both!, /^account:/)
  assert.equal(accountChanged(both, accountTokenFrom(seatStatus('ana@seats.example.test'))), false, 'never mix the two kinds')
  assert.equal(accountChanged(accountTokenFrom(seatStatus('ben@seats.example.test')), both), false)
})

// -- the rule: changed only on proof -------------------------------------------------------------------

test('the account changed only when both reads name an account of the same kind and they differ', () => {
  const a = accountTokenFrom(status({ accountUuid: A_UUID }))
  const b = accountTokenFrom(status({ accountUuid: B_UUID }))
  const org = accountTokenFrom(seatStatus('ana@seats.example.test'))
  assert.equal(accountChanged(a, b), true)
  assert.equal(accountChanged(a, a), false, 'the same account again (or a token refresh) is no change')
  assert.equal(accountChanged(a, null), false, 'a failed read now is no proof')
  assert.equal(accountChanged(null, b), false, 'no account seen at the limit is no proof')
  assert.equal(accountChanged(a, org), false, 'an account id against a seat proves nothing')
  assert.equal(accountChanged('account:x', 'account:y'), false, 'only tokens this module made count')
})

// -- one status read: its folder, environment and working folder -----------------------------------------

const env = { PATH: '/usr/bin', HOME: '/home/user', CLAUDE_CONFIG_DIR: '/elsewhere', ANTHROPIC_API_KEY: 'sk-never', CLAUDE_CODE_OAUTH_TOKEN: 'never' }

test('a status read names the folder the agent launched with, from home, with no key or token of this process', () => {
  const input = statusInput({ env, home: '/home/user', configDir: '/home/user/.bgos-agent/helper-accounts/x', platform: 'linux' })
  assert.equal(input.cwd, '/home/user')
  assert.equal(input.env.CLAUDE_CONFIG_DIR, '/home/user/.bgos-agent/helper-accounts/x')
  assert.equal(input.env.ANTHROPIC_API_KEY, undefined, 'a key in the environment never answers for the login')
  assert.equal(input.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
  assert.ok(input.env.PATH.endsWith('/usr/bin') && input.env.PATH.includes('.local'), input.env.PATH)
  assert.equal(input.key, resolve('/home/user/.bgos-agent/helper-accounts/x'))
  assert.equal(env.CLAUDE_CONFIG_DIR, '/elsewhere', "the caller's environment is not changed")
})

test('an agent launched without a config folder is read without one (on macOS the folder picks the Keychain item)', () => {
  const input = statusInput({ env, home: '/home/user', configDir: null, platform: 'darwin' })
  assert.ok(!('CLAUDE_CONFIG_DIR' in input.env))
  assert.equal(input.key, '', 'the default folder is its own key')
  assert.equal(statusInput({ env, home: 'C:\\Users\\user', configDir: 'C:\\Users\\USER\\Work', platform: 'win32' }).key, resolve('C:\\Users\\USER\\Work').toLowerCase())
})

// -- one read per folder a minute, whatever asks (M2), never blocking the sweep (m3) ---------------------

function fakeReads(answers: Array<any | (() => any)>) {
  let at = 1_000_000
  const calls: string[] = []
  const read = async (input: any) => {
    calls.push(input.key)
    const a = answers.shift()
    return typeof a === 'function' ? a() : a
  }
  return { read, calls, now: () => at, tick: (ms: number) => (at += ms) }
}
const OK = { read: true, signedIn: true, account: 'seat:' + '1'.repeat(32) }
const one = { key: '/a', env: {}, cwd: '/home/user' }

test('M2: a folder is read once a minute however many paths ask, and a failure waits its minute too', async () => {
  const f = fakeReads([{ read: false }, OK, OK])
  const reader = createStatusReader({ read: f.read, now: f.now })
  const first = await reader.read(one)
  assert.deepEqual(first, { read: false, signedIn: false, account: null, readAt: 1_000_000 })
  assert.deepEqual(await reader.read(one), first, 'the snapshot, the limit look and the target all get the same answer')
  assert.equal(reader.peek(one), first, 'and so does the limit watch')
  assert.deepEqual(f.calls, ['/a'], 'one read, not three')
  await reader.read({ ...one, key: '/b' })
  assert.deepEqual(f.calls, ['/a', '/b'], 'another folder is its own read')
  f.tick(ACCOUNT_READ_EVERY_MS)
  assert.deepEqual(await reader.read(one), { ...OK, readAt: 1_060_000 })
  assert.deepEqual(f.calls, ['/a', '/b', '/a'])
})

test('m4 (cap-clock-back): a read from a clock that moved back is not trusted: one new read, then its minute', async () => {
  const f = fakeReads([OK, OK, OK])
  const reader = createStatusReader({ read: f.read, now: f.now })
  await reader.read(one)
  f.tick(-3_600_000)
  const back = await reader.read(one)
  assert.equal(back.readAt, f.now())
  assert.equal(f.calls.length, 2)
  await reader.read(one)
  assert.equal(f.calls.length, 2)
})

test('M2: never two reads of one folder at once, even one that outlives its minute; a read that throws is a failed read', async () => {
  let release!: (v: any) => void
  const f = fakeReads([() => new Promise((r) => (release = r)), () => { throw new Error('boom') }])
  const reader = createStatusReader({ read: f.read, now: f.now })
  const a = reader.read(one)
  f.tick(5 * ACCOUNT_READ_EVERY_MS)
  const b = reader.read(one)
  assert.equal(reader.peek(one), null)
  release(OK)
  assert.deepEqual(await a, { ...OK, readAt: 1_000_000 })
  assert.equal(await b, await a)
  assert.equal(f.calls.length, 1)
  f.tick(ACCOUNT_READ_EVERY_MS)
  assert.deepEqual(await reader.read(one), { read: false, signedIn: false, account: null, readAt: 1_000_000 + 6 * ACCOUNT_READ_EVERY_MS })
})

test('m3: the limit watch never waits for the CLI: peek answers at once and a hung read only runs in the background', async () => {
  let release!: (v: any) => void
  const f = fakeReads([() => new Promise((r) => (release = r))])
  const reader = createStatusReader({ read: f.read, now: f.now })
  const peek = peekAccount(reader)
  const started = Date.now()
  assert.deepEqual(peek({ env: {}, home: '/home/user', configDir: '/a', platform: 'linux' }), { ok: false, why: 'pending' })
  assert.deepEqual(peek({ env: {}, home: '/home/user', configDir: '/a', platform: 'linux' }), { ok: false, why: 'pending' })
  assert.ok(Date.now() - started < 1000)
  assert.equal(f.calls.length, 1, 'one read started, not one per look')
  release({ read: true, signedIn: true, account: seatToken('ana') })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(peek({ env: {}, home: '/home/user', configDir: '/a', platform: 'linux' }), { ok: true, token: seatToken('ana'), readAt: 1_000_000 })
})

test('the limit watch reads a failed, signed out or seatless answer as no account: nothing is pressed on it', async () => {
  for (const [answer, why] of [
    [{ read: false }, 'failed'],
    [{ read: true, signedIn: false, account: null }, 'signed_out'],
    [{ read: true, signedIn: true, account: null }, 'no_account'],
  ] as const) {
    const reader = createStatusReader({ read: async () => answer })
    const peek = peekAccount(reader)
    peek({ env: {}, home: '/h', configDir: null })
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(peek({ env: {}, home: '/h', configDir: null }), { ok: false, why }, why)
  }
})

// -- M3: a timeout on Windows ends the whole tree it started ---------------------------------------------

test('M3: a timed out run through `cmd /c` (the claude.cmd shim) ends its child too, not only cmd.exe', { skip: process.platform !== 'win32' && 'Windows only: the shim is cmd.exe' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-exec-'))
  const pidFile = join(dir, 'child.pid')
  // A stand in for the npm `claude.cmd` shim: cmd.exe starts node, which records its pid and hangs.
  const shim = join(dir, 'fake-claude.cmd')
  writeFileSync(shim, `@"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)" "${pidFile}"\r\n`)
  let child = 0
  t.after(() => {
    if (child && alive(child)) process.kill(child)
    rmSync(dir, { recursive: true, force: true })
  })
  // The listing is given (this test starts no PowerShell): the real shim, its real child, their real pids.
  const killTree = (pid: number, o: any) =>
    (accountIds as any).endStartedTree(pid, {
      ...o,
      list: async () => [
        { pid, ppid: 1, startedAtMs: 100, name: 'cmd.exe' },
        { pid: Number(readFileSync(pidFile, 'utf8')), ppid: pid, startedAtMs: 200, name: 'node.exe' },
      ],
    })
  await assert.rejects(boundedExec(process.env.ComSpec || 'cmd.exe', ['/d', '/c', shim], { cwd: dir, timeout: 3000, killTree } as any), (e: any) => e.code === 'ETIMEDOUT')
  child = Number(readFileSync(pidFile, 'utf8'))
  assert.ok(child > 0, 'the shim started its child')
  for (let i = 0; i < 40 && alive(child); i++) await new Promise((r) => setTimeout(r, 250))
  assert.equal(alive(child), false, 'the child the shim started is gone')
})

const rows = (...r: Array<[number, number, number | null, string]>) => r.map(([pid, ppid, startedAtMs, name]) => ({ pid, ppid, startedAtMs, name }))

test('B2: the tree walk ends only what the shim started: never a process naming a reused parent id, or one of unknown start', async () => {
  const killed: number[] = []
  const list = async () => rows([2000, 1000, 200, 'cmd.exe'], [3000, 2000, 300, 'node.exe'], [2500, 2000, 150, 'stranger.exe'], [2600, 2000, null, 'unknown.exe'], [4000, 3000, 400, 'grandchild.exe'])
  assert.equal(await (accountIds as any).endStartedTree(2000, { list, kill: (pid: number) => killed.push(pid) }), true)
  assert.deepEqual(killed, [3000], 'the root itself is ended by its own handle, by the caller')
})

test('B2: nothing is ended when the listing fails, the root is gone from it, the root is no shim, or the root exited meanwhile', async () => {
  const killed: number[] = []
  const kill = (pid: number) => killed.push(pid)
  const good = rows([2000, 1000, 200, 'cmd.exe'], [3000, 2000, 300, 'node.exe'])
  assert.equal(await (accountIds as any).endStartedTree(2000, { list: async () => null, kill }), false)
  assert.equal(await (accountIds as any).endStartedTree(2000, { list: async () => { throw new Error('x') }, kill }), false)
  assert.equal(await (accountIds as any).endStartedTree(9999, { list: async () => good, kill }), false)
  assert.equal(await (accountIds as any).endStartedTree(2000, { list: async () => rows([2000, 1000, 200, 'claude.exe'], [3000, 2000, 300, 'node.exe']), kill }), true)
  assert.equal(await (accountIds as any).endStartedTree(2000, { list: async () => good, kill, alive: () => false }), false)
  assert.deepEqual(killed, [])
})

test('B2: the process list comes from the System32 powershell by its full path, and with no SystemRoot it is not run', async () => {
  const runs: any[] = []
  const run = async (file: string, args: string[]) => {
    runs.push({ file, args })
    return { code: 0, stdout: '2000 1000 200 cmd.exe\r\n3000 2000 300 node.exe\r\n', stderr: '', timedOut: false, spawnError: null }
  }
  const killed: number[] = []
  assert.equal(await (accountIds as any).endStartedTree(2000, { env: { SystemRoot: 'C:\\Windows' }, run, kill: (p: number) => killed.push(p) }), true)
  assert.equal(runs[0].file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.deepEqual(killed, [3000])
  runs.length = 0
  assert.equal(await (accountIds as any).endStartedTree(2000, { env: {}, run, kill: (p: number) => killed.push(p) }), false)
  assert.deepEqual(runs, [])
})

test('M-1: on Windows the machine PATH is found whatever its spelling, one key reaches the child; other platforms are untouched', () => {
  const win = statusInput({ env: { Path: 'C:\\npm;C:\\sys' }, home: 'C:\\Users\\user', configDir: null, platform: 'win32' })
  assert.deepEqual(Object.keys(win.env).filter((k) => k.toUpperCase() === 'PATH'), ['PATH'])
  assert.ok(win.env.PATH.includes('C:\\npm;C:\\sys'))
  const both = statusInput({ env: { Path: 'C:\\lower', PATH: 'C:\\upper' }, home: 'C:\\Users\\user', configDir: null, platform: 'win32' })
  assert.deepEqual(Object.keys(both.env).filter((k) => k.toUpperCase() === 'PATH'), ['PATH'])
  assert.ok(both.env.PATH.includes('C:\\upper') && !both.env.PATH.includes('C:\\lower'), 'the key Node would have kept')
  const linux = statusInput({ env: { Path: '/not-the-path', PATH: '/usr/bin' }, home: '/home/user', configDir: null, platform: 'linux' })
  assert.equal(linux.env.Path, '/not-the-path')
  assert.ok(linux.env.PATH.endsWith('/usr/bin'))
})

test('n4: the three newer login keys never reach a status read', () => {
  const out = statusInput({ env: { CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'x', CLAUDE_CODE_GATEWAY_TOKEN: 'x', ANTHROPIC_IDENTITY_TOKEN: 'x', KEEP: 'y' }, home: '/home/user', configDir: null, platform: 'linux' })
  assert.deepEqual(['CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_GATEWAY_TOKEN', 'ANTHROPIC_IDENTITY_TOKEN'].filter((k) => k in out.env), [])
  assert.equal(out.env.KEEP, 'y')
})

test('M-2: a read "after" a time joins one started since, waits out an older one, and never runs two at once', async () => {
  let release: Array<(v: any) => void> = []
  let at = 1_000_000
  const calls: number[] = []
  const reader: any = createStatusReader({ now: () => at, read: () => (calls.push(at), new Promise((r) => release.push(r))) })
  const old = reader.read(one) // started before the press
  at += 10_000
  const press = at
  const a = reader.read(one, { after: press })
  const b = reader.read(one, { after: press })
  assert.equal(calls.length, 1, 'never two at once for one folder')
  release[0](OK)
  await old
  await new Promise((r) => setImmediate(r))
  assert.equal(calls.length, 2, 'one new read, for both')
  assert.equal(calls[1], press)
  release[1]({ ...OK, account: 'seat:' + '2'.repeat(32) })
  const [x, y] = await Promise.all([a, b])
  assert.equal(x.readAt, press)
  assert.equal(y, x)
  // Inside its minute that read answers again; a read from before the time never does.
  at += 5000
  assert.equal(await reader.read(one, { after: press }), x)
  assert.equal(calls.length, 2)
  const later = at
  const c = reader.read(one, { after: later })
  assert.equal(calls.length, 3)
  release[2](OK)
  assert.equal((await c).readAt, later)
})

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('the login folder of an agent is the one its transcript is read from: the recipe folder, else the inherited one', () => {
  assert.equal(agentAccountDir('/saved/x', { CLAUDE_CONFIG_DIR: '/env' }), '/saved/x')
  assert.equal(agentAccountDir('  ', { CLAUDE_CONFIG_DIR: '/env' }), '/env', 'an empty recipe folder falls back like the transcript does')
  assert.equal(agentAccountDir(null, { CLAUDE_CONFIG_DIR: ' /env ' }), '/env')
  assert.equal(agentAccountDir(undefined, {}), null, 'none: the default folder, not named')
})
