/**
 * The round 4 review's switcher attacks (R4X), kept as tests. Each test states the promise. Fakes only:
 * production createHelperAccounts and createStatusReader on a fake clock and a fake CLI, in the real look
 * order (heartbeat snapshot not waited for, then the tick). The rig is the account-read-recheck rig plus a
 * count of the CLI reads per folder, wired as lib/helper-account-watcher.mjs wires it: the switcher and the
 * limit watch keep ONE read log, the reader's. Two of the review's probes are not here: the temp folder
 * probe (T0) and a read count with no assertion (C1).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHelperAccounts, profileDirectory, readAccountRegistry } from '../lib/helper-accounts.mjs'
import { createStatusReader } from '../lib/claude-account-id.mjs'
import { seatToken } from './helpers/claude-auth-status.ts'

const TMP = join(tmpdir(), 'account-read-r4x')
const T0 = Date.UTC(2026, 10, 22, 12)
const A = seatToken('seat-a')
const B = seatToken('seat-b')
const on = (account: string) => ({ signedIn: true, account })
const OUT = { signedIn: false, account: null }
const limitAt = (atMs: number) => ({ atMs, resetsAtMs: atMs + 4 * 3600_000, model: 'opus', agentModel: 'opus' })
const settle = () => new Promise((r) => setTimeout(r, 60))

function rig(t: any, agents = [41], { sharedLog = true } = {}) {
  mkdirSync(TMP, { recursive: true })
  const home = mkdtempSync(join(TMP, 'rig-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const clock = { at: T0 }
  const folders = new Map<string, any>()
  const holds = new Map<string, { wait: Promise<any>; release: (v: any) => void }>()
  const reads: string[] = []
  const answer = (a: any) => (a === 'fail' ? { read: false } : { read: true, signedIn: a?.signedIn === true, account: a?.account ?? null })
  const makeReader = (): any => createStatusReader({
    now: () => clock.at,
    read: async (input: any) => {
      reads.push(input.key)
      const h = holds.get(input.key)
      if (h) {
        holds.delete(input.key)
        return answer(await h.wait)
      }
      return answer(folders.get(input.key))
    },
  })
  const hold = (key: string) => {
    let release!: (v: any) => void
    const wait = new Promise((r) => (release = r))
    holds.set(key, { wait, release })
    return release
  }
  const credentials = { pairingId: 23, machineId: 'machine-12345', backendUrl: 'https://api.fixture.test' }
  const rows = agents.map((assistantId) => ({
    assistantId, pairingId: 13, userId: 'user_fixture', accountId: null as string | null, sessionId: randomUUID(),
    ready: true, stopped: false, limit: null as any, model: 'opus',
  }))
  const restarts: any[] = []
  let reader = makeReader()
  const makeWatcher = () => createHelperAccounts({
    home, credentials, now: () => clock.at,
    inventory: async () => rows,
    // One read log for the process, the reader's: its keys are the reader's (a saved login's id, 'own').
    ...(sharedLog ? {
      readLog: reader.log,
      logKeys: { login: (id: string) => id, own: () => 'own' },
      // As lib/helper-account-watcher.mjs wires it: a kept read of the own login, and one since a limit.
      keepOwnRead: (_row: unknown, limitAtMs?: number) =>
        limitAtMs === undefined ? reader.keepFresh({ key: 'own', env: {}, cwd: home }) : reader.peek({ key: 'own', env: {}, cwd: home }),
    } : {}),
    measure: async (account: any, _model?: unknown, opts?: { after?: number }) => {
      const s = await reader.read({ key: account.id, env: {}, cwd: home }, opts)
      return { signedIn: s.read && s.signedIn, usage: null, account: s.read ? s.account : null, readFailed: !s.read, readAt: s.readAt }
    },
    ownAccount: async (_row: unknown, opts?: { after?: number }) => {
      const s = await reader.read({ key: 'own', env: {}, cwd: home }, opts)
      return s.read && s.signedIn ? { read: true, account: s.account, readAt: s.readAt } : { read: false }
    },
    restart: async (r: any, choice: string | null) => {
      restarts.push({ id: r.assistantId, choice })
      r.accountId = choice
      return true
    },
  } as any)
  let watcher = makeWatcher()
  /** A new watcher process on this computer: a new reader, so no read log from before it. */
  const restartWatcher = () => {
    reader = makeReader()
    watcher = makeWatcher()
  }
  const job = (command: any) => watcher.run(randomUUID(), {
    op: 'helper_accounts', machineId: credentials.machineId, watcherPairingId: 23, ownerUserId: 'user_fixture', requestedBy: 'owner',
    targets: command.assistantId ? [{ assistantId: command.assistantId, pairingId: 13 }] : [], accountCommand: command,
  })
  const add = async (label: string) => {
    await job({ action: 'add', label })
    return (await watcher.snapshot()).accounts.find((a: any) => a.label === label).id as string
  }
  /** One real look: the heartbeat starts the snapshot's reads, then the tick runs without waiting for them. */
  const look = async () => {
    const beat = watcher.snapshot()
    await watcher.tick()
    await beat
  }
  /** The limit watch's keepFresh on the agent's own folder (lib/watcher-limit.mjs:450, keepAccountRead). */
  const keepOwn = () => reader.keepFresh({ key: 'own', env: {}, cwd: home })
  const room = (id: string, used: number) => {
    const dir = join(profileDirectory(home, id), 'state', 'usage')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'last-status.json')
    writeFileSync(file, JSON.stringify({ rate_limits: { seven_day: { used_percentage: used, resets_at: Math.floor((clock.at + 3 * 24 * 3600_000) / 1000) } } }))
    const at = new Date(clock.at - 1000)
    utimesSync(file, at, at)
  }
  return {
    clock, folders, rows, restarts, job, add, hold, look, room, home, reads, keepOwn, restartWatcher,
    get reader() { return reader },
    get watcher() { return watcher },
  }
}

// -- an agent on its own login (the computer's login, no saved one), pressed AFTER its limit --------------

for (const mode of ['limit', 'auto'] as const) {
  test(`R4X-H1 own login, already at its limit: a ${mode === 'limit' ? 'Switch at limit' : 'Auto'} press 60 s after the limit moves it to another seat`, async (t) => {
    const f = rig(t)
    const s2 = await f.add('S2')
    f.folders.set('own', on(A))
    f.folders.set(s2, on(B))
    f.room(s2, 10)
    // Ten minutes of ordinary looks before the limit, with the limit watch keeping its read of the own folder.
    for (let i = 0; i < 10; i++) {
      f.clock.at += 61_000
      f.keepOwn()
      await f.look()
      await settle()
    }
    const L = f.clock.at + 1000
    f.rows[0].limit = limitAt(L) // the agent hits its limit on seat A; nobody changes login
    f.clock.at = L + 60_000
    await f.job({ action: 'assign', mode, ...(mode === 'limit' ? { accountId: s2 } : {}), assistantId: 41 })
    await settle()
    for (let i = 0; i < 4 && f.restarts.length === 0; i++) {
      f.clock.at += 61_000
      await f.look()
      await settle()
    }
    const own = f.reads.filter((k) => k === 'own').length
    console.log(`PROBE ${mode}: own-folder CLI reads ${own}, restarts ${JSON.stringify(f.restarts.map((r) => r.choice === s2 ? 'S2' : r.choice))}, status ${(await f.watcher.snapshot()).agents[0]?.status}`)
    assert.deepEqual(f.restarts.map((r) => r.choice), [s2], 'seat A hit the limit, S2 is signed in to seat B, nobody changed login')
  })
}

test('R4X-H1c control: the same press on an agent on a SAVED login moves it', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.rows[0].accountId = s1
  for (let i = 0; i < 3; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  const L = f.clock.at + 1000
  f.rows[0].limit = limitAt(L)
  f.clock.at = L + 60_000
  await f.job({ action: 'assign', mode: 'limit', accountId: s2, assistantId: 41 })
  await settle()
  for (let i = 0; i < 4 && f.restarts.length === 0; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  assert.deepEqual(f.restarts.map((r) => r.choice), [s2])
})

// -- a saved login, pressed more than five minutes after its limit ------------------------------------------

test('R4X-H2 saved login: a Switch at limit press 6 min after the limit moves it, the heartbeat read the account at the limit 1 min after it', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.rows[0].accountId = s1
  for (let i = 0; i < 3; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  const L = f.clock.at + 1000
  f.rows[0].limit = limitAt(L)
  // Six ordinary heartbeats after the limit: S1 is read on seat A every minute, from 1 min after the limit on.
  f.clock.at = L
  for (let i = 0; i < 6; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  await f.job({ action: 'assign', mode: 'limit', accountId: s2, assistantId: 41 })
  await settle()
  for (let i = 0; i < 3 && f.restarts.length === 0; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  console.log(`PROBE press at L+${Math.round((f.clock.at - L) / 1000)}s: restarts ${f.restarts.length}, status ${(await f.watcher.snapshot()).agents[0]?.status}`)
  assert.deepEqual(f.restarts.map((r) => r.choice), [s2], 'the first read after the limit (L+61 s) and the last before it both name seat A')
})

test('R4X-H2c control: the same rig with the press 3 min after the limit moves it', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.rows[0].accountId = s1
  for (let i = 0; i < 3; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  const L = f.clock.at + 1000
  f.rows[0].limit = limitAt(L)
  f.clock.at = L
  for (let i = 0; i < 3; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  await f.job({ action: 'assign', mode: 'limit', accountId: s2, assistantId: 41 })
  await settle()
  for (let i = 0; i < 3 && f.restarts.length === 0; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  console.log(`PROBE H2c press at L+183s: restarts ${f.restarts.length}`)
  assert.deepEqual(f.restarts.map((r) => r.choice), [s2])
})

// -- a read that began before the limit and answered after the owner changed login -------------------------

for (const sharedLog of [true, false]) test(`R4X-W1 a "before" read that answers after the limit must not stand for the account at it${sharedLog ? '' : ' (the switcher keeping its own read log)'}`, async (t) => {
  const f = rig(t, [41], { sharedLog })
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(A)) // two saved logins on seat A
  f.rows[0].accountId = s1
  f.clock.at = T0 + 61_000
  await f.look() // an ordinary heartbeat on seat A
  await settle()
  await f.job({ action: 'assign', mode: 'limit', accountId: s2, assistantId: 41 })
  await settle()
  const L = T0 + 180_000
  // The heartbeat's read of S1 starts 1 s before the limit; the CLI answers 3 s later.
  f.clock.at = L - 1000
  const release = f.hold(s1)
  const n0 = f.reads.filter((k) => k === s1).length
  const beat = f.watcher.snapshot()
  for (let i = 0; i < 50 && f.reads.filter((k) => k === s1).length === n0; i++) await new Promise((d) => setImmediate(d))
  assert.equal(f.reads.filter((k) => k === s1).length, n0 + 1, 'setup: the read of S1 started at L - 1 s')
  f.rows[0].limit = limitAt(L) // the agent hits its limit on seat A
  f.clock.at = L + 1000
  f.folders.set(s1, on(B)) // the owner signs S1 in to seat B 1 s after the limit
  f.clock.at = L + 2000
  release(on(B)) // the read in flight sees the new seat
  await beat
  await settle()
  for (let i = 0; i < 3 && f.restarts.length === 0; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  const t41 = readAccountRegistry(f.home)?.targets?.['41']
  const la = t41?.limitAccount
  console.log(`PROBE W1: restarts ${f.restarts.length}, status ${t41?.status}, limitAccount ${la ? (la.token === A ? 'A' : la.token === B ? 'B' : String(la.token)) : 'unset'}, S1 reads ${f.reads.filter((k) => k === s1).length}`)
  assert.deepEqual(f.restarts, [], 'S2 is seat A, the seat the agent is limited on')
})

test('R4X-W1c control: the same rig with S2 on seat B and no login change moves the agent to S2', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.rows[0].accountId = s1
  f.clock.at = T0 + 61_000
  await f.look()
  await settle()
  await f.job({ action: 'assign', mode: 'limit', accountId: s2, assistantId: 41 })
  await settle()
  const L = T0 + 180_000
  f.clock.at = L - 1000
  const release = f.hold(s1)
  const n0 = f.reads.filter((k) => k === s1).length
  const beat = f.watcher.snapshot()
  for (let i = 0; i < 50 && f.reads.filter((k) => k === s1).length === n0; i++) await new Promise((d) => setImmediate(d))
  assert.equal(f.reads.filter((k) => k === s1).length, n0 + 1, 'setup: the read of S1 started at L - 1 s')
  f.rows[0].limit = limitAt(L)
  f.clock.at = L + 2000
  release(on(A))
  await beat
  await settle()
  for (let i = 0; i < 3 && f.restarts.length === 0; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  const t41 = readAccountRegistry(f.home)?.targets?.['41']
  console.log(`PROBE W1c: restarts ${f.restarts.length}, status ${t41?.status}, limitAccount ${t41?.limitAccount ? (t41.limitAccount.token === A ? 'A' : String(t41.limitAccount.token)) : 'unset'}`)
  assert.deepEqual(f.restarts.map((r) => r.choice), [s2])
})

for (const mode of ['limit', 'auto'] as const) {
  test(`R4X-H1o control: own login with ${mode === 'limit' ? 'Switch at limit' : 'Auto'} armed BEFORE the limit moves it to another seat`, async (t) => {
    const f = rig(t)
    const s2 = await f.add('S2')
    f.folders.set('own', on(A))
    f.folders.set(s2, on(B))
    f.room(s2, 10)
    f.clock.at += 61_000
    await f.job({ action: 'assign', mode, ...(mode === 'limit' ? { accountId: s2 } : {}), assistantId: 41 })
    await settle()
    for (let i = 0; i < 3; i++) {
      f.clock.at += 61_000
      await f.look()
      await settle()
    }
    const L = f.clock.at + 1000
    f.rows[0].limit = limitAt(L)
    f.clock.at = L
    for (let i = 0; i < 4 && f.restarts.length === 0; i++) {
      f.clock.at += 61_000
      await f.look()
      await settle()
    }
    console.log(`PROBE H1o ${mode}: restarts ${f.restarts.length}, status ${readAccountRegistry(f.home)?.targets?.['41']?.status}`)
    assert.deepEqual(f.restarts.map((r) => r.choice), [s2])
  })
}

// -- round 5: the account at a limit is kept for a late press, and every way a last read refuses ------------

test('R5-K1 the account at a limit is worked out for an agent with no rule and kept: a press after a watcher restart moves it', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.rows[0].accountId = s1
  for (let i = 0; i < 2; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  const L = f.clock.at + 1000
  f.rows[0].limit = limitAt(L) // no rule armed: only the heartbeat reads S1, before and after the limit
  for (let i = 0; i < 2; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  const kept = readAccountRegistry(f.home)?.targets?.['41']
  assert.deepEqual([kept?.limitAccount, kept?.rule], [{ atMs: L, token: A }, undefined], 'kept on this computer with no rule armed')
  // The watcher restarts 20 minutes on: its read log starts empty, the kept account still counts.
  f.restartWatcher()
  f.clock.at = L + 20 * 60_000
  await f.job({ action: 'assign', mode: 'limit', accountId: s2, assistantId: 41 })
  await settle()
  for (let i = 0; i < 3 && f.restarts.length === 0; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  assert.deepEqual(f.restarts.map((r) => r.choice), [s2])
})

test('R5-N1 a Switch now press answered by a read from before it fails, even when the read after it would move', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.rows[0].accountId = s1
  f.clock.at += 61_000
  await f.look()
  await settle()
  // The CLI answers the press with a read it took before the press (a reader that ignores `after`).
  const real = f.reader.read
  let first = true
  f.reader.read = async (input: any, opts?: { after?: number }) => {
    if (first && input.key === s2 && opts?.after !== undefined) {
      first = false
      return { read: true, signedIn: true, account: B, readAt: opts.after - 1000 }
    }
    return real(input, opts)
  }
  f.clock.at += 5000
  await f.job({ action: 'assign', mode: 'now', accountId: s2, assistantId: 41 })
  await settle()
  assert.deepEqual(f.restarts, [])
  assert.equal(readAccountRegistry(f.home)?.targets?.['41']?.status, 'failed')
})

test('R5-U1 nothing read since the limit and its window passed: the account at it is kept as unknown, only the reset counts', async (t) => {
  const f = rig(t)
  const s2 = await f.add('S2')
  f.folders.set('own', on(A))
  f.folders.set(s2, on(B))
  f.room(s2, 10)
  for (let i = 0; i < 3; i++) {
    f.clock.at += 61_000
    f.keepOwn()
    await f.look()
    await settle()
  }
  const L = f.clock.at + 1000
  f.rows[0].limit = limitAt(L) // an agent on its own login, no rule: nobody reads its folder after the limit
  f.clock.at = L + 8 * 60_000
  await f.job({ action: 'assign', mode: 'limit', accountId: s2, assistantId: 41 })
  await settle()
  for (let i = 0; i < 2; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  assert.deepEqual(f.restarts, [])
  const t41 = readAccountRegistry(f.home)?.targets?.['41']
  assert.deepEqual([t41?.limitAccount, t41?.status], [{ atMs: L, token: null }, 'waiting_for_room'])
})

test('R5-H3 own login, no keep-alive limit watch and no rule: a Switch at limit press 6 min after the limit moves it', async (t) => {
  const f = rig(t)
  const s2 = await f.add('S2')
  f.folders.set('own', on(A))
  f.folders.set(s2, on(B))
  // Ordinary looks only: nothing outside the switcher reads the agent's own folder (no f.keepOwn).
  for (let i = 0; i < 6; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  const L = f.clock.at + 1000
  f.rows[0].limit = limitAt(L)
  f.clock.at = L
  for (let i = 0; i < 6; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  await f.job({ action: 'assign', mode: 'limit', accountId: s2, assistantId: 41 })
  await settle()
  for (let i = 0; i < 3 && f.restarts.length === 0; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  assert.deepEqual(f.restarts.map((r) => r.choice), [s2])
})

test('R5-K2 a limit carried over from before the agent was started on its login is not named from that login', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.rows[0].accountId = s2
  for (let i = 0; i < 2; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  // The agent hit its limit on seat A, then was started on S2 (seat B) in the same conversation, whose
  // transcript still ends on that refusal. S2's reads say seat B before and after it.
  const L = f.clock.at + 1000
  f.rows[0].limit = limitAt(L)
  ;(f.rows[0] as any).startedAtMs = L + 30_000
  for (let i = 0; i < 2; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  await f.job({ action: 'assign', mode: 'limit', accountId: s1, assistantId: 41 })
  await settle()
  for (let i = 0; i < 3 && f.restarts.length === 0; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  assert.deepEqual(f.restarts, [], 'S1 is seat A, the seat that ran out')
  assert.deepEqual(readAccountRegistry(f.home)?.targets?.['41']?.limitAccount, { atMs: L, token: null })
})
