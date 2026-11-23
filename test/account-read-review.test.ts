/**
 * The review's attacks on the saved account reads, kept by name. Each test states what the change
 * promises. Fakes only: no real CLI, no account, no real process but the test's own fake shim.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHelperAccounts } from '../lib/helper-accounts.mjs'
import { accountChanged, accountTokenFrom, createStatusReader, peekAccount, statusInput } from '../lib/claude-account-id.mjs'
import { spawnCollect } from '../lib/plugin-cli.mjs'
import { signedIn } from '../lib/helper-account-watcher.mjs'
import { FIXTURE_ORG, seatStatus, seatToken } from './helpers/claude-auth-status.ts'

const TMP = tmpdir()
const T0 = Date.UTC(2026, 10, 22, 12)
const A = seatToken('seat-a')
const B = seatToken('seat-b')

/** The production `measure` and reader, on a fake clock and a fake CLI (a map of folder to answer). */
function rig(t: any, agents = [41]) {
  mkdirSync(TMP, { recursive: true })
  const home = mkdtempSync(join(TMP, 'rig-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const clock = { at: T0 }
  const folders = new Map<string, any>()
  const reads: string[] = []
  const slow = { ms: 0 }
  const reader = createStatusReader({
    now: () => clock.at,
    read: async (input: any) => {
      reads.push(input.key)
      if (slow.ms) await new Promise((r) => setTimeout(r, slow.ms))
      const a = folders.get(input.key)
      if (a === 'fail') return { read: false }
      return { read: true, signedIn: a?.signedIn === true, account: a?.account ?? null }
    },
  })
  const credentials = { pairingId: 23, machineId: 'machine-12345', backendUrl: 'https://api.fixture.test' }
  const rows = agents.map((assistantId) => ({
    assistantId, pairingId: 13, userId: 'user_fixture', accountId: null as string | null, sessionId: randomUUID(),
    ready: true, stopped: false, limit: null as any, model: 'opus',
  }))
  const restarts: any[] = []
  const deps = {
    home, credentials, now: () => clock.at,
    inventory: async () => rows,
    measure: async (account: any, _model?: unknown, opts?: { after?: number }) => {
      const s = await reader.read({ key: account.id, env: {}, cwd: home }, opts)
      return { signedIn: s.read && s.signedIn, usage: null, account: s.read ? s.account : null, readFailed: !s.read, readAt: s.readAt }
    },
    ownAccount: async () => ({ read: false }),
    restart: async (r: any, choice: string | null) => {
      restarts.push({ id: r.assistantId, choice })
      r.accountId = choice
      return true
    },
  }
  const watcher = createHelperAccounts(deps)
  const job = (command: any) => watcher.run(randomUUID(), {
    op: 'helper_accounts', machineId: credentials.machineId, watcherPairingId: 23, ownerUserId: 'user_fixture', requestedBy: 'owner',
    targets: command.assistantId ? [{ assistantId: command.assistantId, pairingId: 13 }] : [], accountCommand: command,
  })
  const add = async (label: string) => {
    await job({ action: 'add', label })
    return (await watcher.snapshot()).accounts.find((a: any) => a.label === label).id as string
  }
  return { clock, folders, reads, reader, rows, restarts, watcher, job, add, slow }
}
const limitAt = (atMs: number) => ({ atMs, resetsAtMs: atMs + 4 * 3600_000, model: 'opus', agentModel: 'opus' })
const on = (account: string) => ({ signedIn: true, account })

// -- A: a stale read must not press --------------------------------------------------------------------

test('R2-A1 rule A: a read from BEFORE the limit never names the account at the limit (saved login)', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.rows[0].accountId = s1
  f.clock.at = T0 + 61_000 // the reads of the add steps are over
  const base = f.clock.at
  await f.watcher.snapshot() // the heartbeat reads S1 as seat A, S2 as seat B
  await f.job({ action: 'assign', mode: 'limit', accountId: s2, assistantId: 41 })
  f.clock.at = base + 10_000
  f.folders.set(s1, on(B)) // the owner signs S1 in to seat B; S1 and S2 are now the same seat
  f.clock.at = base + 20_000
  f.rows[0].limit = limitAt(base + 20_000) // the agent hits its limit, on seat B
  f.clock.at = base + 30_000
  await f.watcher.tick()
  f.clock.at = base + 61_000
  await f.watcher.tick()
  assert.deepEqual(f.restarts, [], 'S2 is the very seat the agent hit its limit on: no switch')
})

test('R2-A2 Switch now on a login signed out inside the minute does not restart the agent onto it', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.rows[0].accountId = s1
  f.clock.at = T0 + 61_000
  await f.watcher.snapshot()
  f.clock.at += 10_000
  f.folders.set(s2, { signedIn: false, account: null })
  f.clock.at += 10_000
  await f.job({ action: 'assign', mode: 'now', accountId: s2, assistantId: 41 })
  assert.deepEqual(f.restarts, [], 'S2 was signed out 10 s ago')
})

test('R2-A3 Switch now right after a sign in is not told "needs sign in" from the last minute', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, { signedIn: false, account: null })
  f.rows[0].accountId = s1
  f.clock.at = T0 + 61_000
  await f.watcher.snapshot()
  f.clock.at += 10_000
  f.folders.set(s2, on(B))
  f.clock.at += 10_000
  await f.job({ action: 'assign', mode: 'now', accountId: s2, assistantId: 41 })
  assert.deepEqual(f.restarts.map((r) => r.choice), [s2], 'S2 was signed in 10 s ago')
})

test('R2-A4 Switch now after one failed read is not told "needs sign in" (a failed read says nothing)', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, 'fail')
  f.rows[0].accountId = s1
  f.clock.at = T0 + 61_000
  await f.watcher.snapshot()
  f.folders.set(s2, on(B))
  f.clock.at += 10_000
  await f.job({ action: 'assign', mode: 'now', accountId: s2, assistantId: 41 })
  const snap = await f.watcher.snapshot()
  assert.notEqual(snap.status, 'needs_sign_in')
})

test('R2-A5 one agent switching never restarts or re-points another agent on the same login', async (t) => {
  const f = rig(t, [41, 42])
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.rows[0].accountId = s1
  f.rows[1].accountId = s1
  f.clock.at = T0 + 61_000
  await f.job({ action: 'assign', mode: 'limit', accountId: s2, assistantId: 41 })
  f.rows[0].limit = limitAt(f.clock.at + 1000)
  f.clock.at += 61_000
  await f.watcher.tick()
  assert.deepEqual(f.restarts, [{ id: 41, choice: s2 }])
  const agents = (await f.watcher.snapshot()).agents
  assert.equal(agents.find((a: any) => a.assistantId === 42).accountId, s1)
})

// -- M1 on the CLI 2.1.330 object ----------------------------------------------------------------------

const cli = (email: unknown, orgId: unknown) => JSON.stringify({
  loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', analyticsDisabled: false, projectsDirectory: 'x', configDirectory: 'y',
  loginExpiresAt: null, email, orgId, orgName: 'Fixture Team', subscriptionType: 'team', storedClaudeAiLogin: true, planTier: 'team',
})

test('R2-M1 the real key set: seats, two orgs on one email, null email, null org', () => {
  const OTHER = '9e8d7c6b-5a49-4382-a716-151413121110'
  const ana = accountTokenFrom(cli('ana@seats.example.test', FIXTURE_ORG))!
  assert.match(ana, /^seat:[0-9a-f]{32}$/)
  assert.equal(accountChanged(ana, accountTokenFrom(cli('ben@seats.example.test', FIXTURE_ORG))), true, 'two seats, one org')
  assert.equal(accountChanged(ana, accountTokenFrom(cli('ana@seats.example.test', OTHER))), true, 'one email, two orgs')
  assert.equal(accountChanged(ana, accountTokenFrom(cli('ANA@seats.example.test', FIXTURE_ORG))), false, 'same seat')
  for (const [e, o] of [[null, FIXTURE_ORG], ['', FIXTURE_ORG], ['  ', FIXTURE_ORG], ['ana@seats.example.test', null], ['ana@seats.example.test', ''], [null, null]]) {
    const token = accountTokenFrom(cli(e, o))
    assert.equal(token, null, JSON.stringify([e, o]))
    assert.equal(accountChanged(ana, token), false)
    assert.equal(accountChanged(token, ana), false)
  }
  assert.ok(!ana.includes('ana') && !ana.includes(FIXTURE_ORG))
})

// -- M2: the reader under attack -----------------------------------------------------------------------

const input = (key: string) => ({ key, env: {}, cwd: '/x' })
function counted(answer: () => any = async () => ({ read: true, signedIn: true, account: A })) {
  const clock = { at: T0 }
  let calls = 0
  const reader = createStatusReader({ now: () => clock.at, read: (i: any) => (calls++, answer()) })
  return { clock, reader, calls: () => calls }
}

test('R2-M2a 200 concurrent callers on one folder, reads and peeks mixed: one read', async () => {
  const c = counted()
  const all: any[] = []
  for (let i = 0; i < 200; i++) all.push(i % 3 ? c.reader.read(input('/a')) : Promise.resolve(c.reader.peek(input('/a'))))
  await Promise.all(all)
  assert.equal(c.calls(), 1)
})

test('R2-M2b a failed, rejected, throwing or junk read waits its minute and is never signed in', async () => {
  for (const bad of [async () => ({ read: false }), async () => { throw new Error('x') }, () => { throw new Error('sync') }, async () => null, async () => 'yes', async () => ({ read: 'true', signedIn: true, account: A })]) {
    const c = counted(bad)
    const first = await c.reader.read(input('/a'))
    assert.deepEqual([first.read, first.signedIn, first.account], [false, false, null])
    for (let i = 0; i < 20; i++) await c.reader.read(input('/a'))
    c.clock.at += 59_999
    await c.reader.read(input('/a'))
    assert.equal(c.calls(), 1)
    c.clock.at += 1
    await c.reader.read(input('/a'))
    assert.equal(c.calls(), 2)
  }
})

test('R2-M2c clock moved back or forward: a read from the "future" is not trusted, and only one new read happens', async () => {
  const c = counted()
  await c.reader.read(input('/a'))
  c.clock.at -= 3600_000
  const back = await c.reader.read(input('/a'))
  assert.equal(c.calls(), 2)
  assert.equal(back.readAt, c.clock.at, 'the answer carries the new clock')
  for (let i = 0; i < 10; i++) await c.reader.read(input('/a'))
  assert.equal(c.calls(), 2)
  c.clock.at += 2 * 3600_000
  await c.reader.read(input('/a'))
  assert.equal(c.calls(), 3)
})

test('R2-M2d a read in flight across a clock change is never doubled', async () => {
  let release!: (v: any) => void
  const c = counted(() => new Promise((r) => (release = r)))
  const first = c.reader.read(input('/a'))
  c.clock.at -= 3600_000
  const second = c.reader.read(input('/a'))
  c.clock.at += 5 * 3600_000
  const third = c.reader.read(input('/a'))
  assert.equal(c.reader.peek(input('/a')), null)
  assert.equal(c.calls(), 1)
  release({ read: true, signedIn: true, account: A })
  assert.equal(await second, await first)
  assert.equal(await third, await first)
})

test('R2-M2e peekAccount never throws and never answers an account from a failed read', async () => {
  const c = counted(async () => ({ read: false }))
  const peek = peekAccount(c.reader)
  assert.deepEqual(peek({ env: {}, home: '/h', configDir: '/a', platform: 'linux' }), { ok: false, why: 'pending' })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(peek({ env: {}, home: '/h', configDir: '/a', platform: 'linux' }), { ok: false, why: 'failed' })
})

// -- M3: the kill ------------------------------------------------------------------------------------------

function fakeChild(pid: number) {
  const c: any = new EventEmitter()
  c.pid = pid
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.kills = []
  c.kill = (s: string) => (c.kills.push(s), true)
  return c
}

test('R2-K1 a child that already exited never gets a tree kill (its pid may belong to someone else now)', async () => {
  const child = fakeChild(4242)
  const killed: number[] = []
  const run = spawnCollect('x', [], { timeoutMs: 80, closeGraceMs: 400, killGraceMs: 10, spawnImpl: () => child, killTree: async (pid: number) => { killed.push(pid) } } as any)
  setTimeout(() => child.emit('exit', 0, null), 20) // exited; a grandchild keeps the pipe open, so no 'close' yet
  await run
  assert.deepEqual(killed, [])
})

test('R2-K2 the tree kill names only the pid this call started, once', async () => {
  const child = fakeChild(4242)
  const killed: number[] = []
  const run = spawnCollect('x', [], { timeoutMs: 30, closeGraceMs: 10, killGraceMs: 10_000, spawnImpl: () => child, killTree: async (pid: number) => { killed.push(pid); child.emit('exit', null, 'SIGTERM') } } as any)
  const r: any = await run
  assert.deepEqual(killed, [4242])
  assert.equal(r.timedOut, true)
})

test('R2-K3 a child with no pid (spawn failed) gets no tree kill', async () => {
  const child = fakeChild(undefined as any)
  const killed: any[] = []
  const run = spawnCollect('x', [], { timeoutMs: 20, closeGraceMs: 5, killGraceMs: 5, spawnImpl: () => child, killTree: async (pid: number) => { killed.push(pid) } } as any)
  setTimeout(() => child.emit('error', Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' })), 40)
  await run
  assert.deepEqual(killed, [])
})

test('R2-K4 a child that never reports an exit after the kill still ends the read (no read may hang for ever)', async () => {
  const child = fakeChild(4242)
  const run = spawnCollect('x', [], { timeoutMs: 20, closeGraceMs: 10, killGraceMs: 20, spawnImpl: () => child, killTree: async () => {} } as any)
  const outcome = await Promise.race([run.then(() => 'settled'), new Promise((r) => setTimeout(() => r('still pending after 1500 ms'), 1500))])
  assert.equal(outcome, 'settled')
})

// -- m1: the tick and the watcher's loop ------------------------------------------------------------------

test('R2-m3 a tick at a limit does not wait for each saved login in turn', async (t) => {
  const f = rig(t)
  const ids: string[] = []
  for (const l of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']) ids.push(await f.add(l))
  ids.forEach((id, i) => f.folders.set(id, on(seatToken(`m-${i}`))))
  f.rows[0].accountId = ids[0]
  f.clock.at = T0 + 61_000
  await f.job({ action: 'assign', mode: 'auto', assistantId: 41 })
  f.rows[0].limit = limitAt(f.clock.at + 1000)
  f.clock.at += 61_000
  // Every read now takes 100 ms (a real hung one takes 5 s and more): the real tick, the real pick.
  f.slow.ms = 100
  const started = Date.now()
  await f.watcher.tick()
  const took = Date.now() - started
  assert.ok(took < 300, `the watcher loop awaits this tick, and it waited ${took} ms`)
})

// -- Windows: can the reader find an npm install at all? ---------------------------------------------------

test('R2-W1 Windows: a machine PATH spelled "Path" (the usual spelling) still reaches an npm claude.cmd', { skip: process.platform !== 'win32' }, async (t) => {
  mkdirSync(TMP, { recursive: true })
  const root = mkdtempSync(join(TMP, 'path-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const npm = join(root, 'npm'), home = join(root, 'home')
  mkdirSync(npm); mkdirSync(home)
  const json = seatStatus('ana@seats.example.test').replace(/"/g, '"')
  writeFileSync(join(npm, 'claude.cmd'), `@echo off\r\nif "%1"=="--version" (\r\n  echo 2.1.330 ^(Claude Code^)\r\n  exit /b 0\r\n)\r\necho ${json}\r\nexit /b 0\r\n`)
  const sys = `${process.env.SystemRoot}\\System32`
  const base = { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, TEMP: root, TMP: root }
  const upper = statusInput({ env: { ...base, PATH: `${npm};${sys}` }, home, configDir: join(root, 'cfg'), platform: 'win32' })
  const proper = await signedIn(upper.env, upper.cwd)
  assert.equal((proper as any).read, true, 'the fake shim answers when the key is PATH')
  const mixed = statusInput({ env: { ...base, Path: `${npm};${sys}` }, home, configDir: join(root, 'cfg'), platform: 'win32' })
  const got = await signedIn(mixed.env, mixed.cwd)
  assert.equal((got as any).read, true, 'the same machine with the key spelled Path')
})

// -- the version answer ------------------------------------------------------------------------------

const cliVersion = (version: string) => async (_file: string, args: string[]) =>
  args.includes('--version') ? { stdout: version } : { stdout: seatStatus('ana@seats.example.test') }

test('R2-C1 a version answer the reader cannot parse is no read, never "signed out" (it would end the Switch at limit rule)', async () => {
  for (const out of ['A notice on the first line\n2.1.330 (Claude Code)\n', 'garbage', '']) {
    const got: any = await signedIn({ PATH: '/usr/bin' }, '/x', cliVersion(out) as any)
    assert.equal(got.read, false, JSON.stringify(out))
  }
})

test('R2-C2 a real old version still reads as signed out, as the code says', async () => {
  const got: any = await signedIn({ PATH: '/usr/bin' }, '/x', cliVersion('2.1.316 (Claude Code)\n') as any)
  assert.deepEqual(got, { read: true, signedIn: false, account: null })
})

// -- what the fixes add ---------------------------------------------------------------------------------

test('R3 a tree kill that never answers still ends the read', async () => {
  const child = fakeChild(4242)
  const run = spawnCollect('x', [], { timeoutMs: 20, closeGraceMs: 10, killGraceMs: 10, killTreeMs: 30, spawnImpl: () => child, killTree: () => new Promise(() => {}) } as any)
  const outcome = await Promise.race([run.then((r: any) => r.timedOut), new Promise((r) => setTimeout(() => r('still pending'), 1500))])
  assert.equal(outcome, true)
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'])
})

test('R3 a child that exits while its tree is being ended gets no signal after its exit', async () => {
  const child = fakeChild(4242)
  let finish!: () => void
  const run = spawnCollect('x', [], { timeoutMs: 20, closeGraceMs: 10, killGraceMs: 10, spawnImpl: () => child, killTree: () => new Promise<void>((r) => (finish = r)) } as any)
  await new Promise((r) => setTimeout(r, 40))
  child.emit('exit', 1, null)
  finish()
  const got: any = await run
  assert.equal(got.timedOut, true)
  assert.deepEqual(child.kills, [], 'the exited pid may be another process now')
})
