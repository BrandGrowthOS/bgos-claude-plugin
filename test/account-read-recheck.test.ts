/**
 * The gap between a read and the act. Each test states the promise. Fakes only: production
 * createHelperAccounts and createStatusReader on a fake clock and a fake CLI. The order of a real look is
 * copied from watcher-core: heartbeat (snapshot, not waited for), then the tick.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHelperAccounts, profileDirectory } from '../lib/helper-accounts.mjs'
import { createStatusReader } from '../lib/claude-account-id.mjs'
import { seatToken } from './helpers/claude-auth-status.ts'

const TMP = join(tmpdir(), 'account-read-recheck')
const T0 = Date.UTC(2026, 10, 22, 12)
const A = seatToken('seat-a')
const B = seatToken('seat-b')
const C = seatToken('seat-c')
const on = (account: string) => ({ signedIn: true, account })
const OUT = { signedIn: false, account: null }
const limitAt = (atMs: number) => ({ atMs, resetsAtMs: atMs + 4 * 3600_000, model: 'opus', agentModel: 'opus' })
const settle = () => new Promise((r) => setTimeout(r, 120))

function rig(t: any, agents = [41]) {
  mkdirSync(TMP, { recursive: true })
  const home = mkdtempSync(join(TMP, 'rig-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const clock = { at: T0 }
  const folders = new Map<string, any>()
  const holds = new Map<string, { wait: Promise<any>; release: (v: any) => void }>()
  const slow = { ms: 0 }
  const answer = (a: any) => (a === 'fail' ? { read: false } : { read: true, signedIn: a?.signedIn === true, account: a?.account ?? null })
  const reader = createStatusReader({
    now: () => clock.at,
    read: async (input: any) => {
      const h = holds.get(input.key)
      if (h) {
        holds.delete(input.key)
        return answer(await h.wait)
      }
      if (slow.ms) await new Promise((r) => setTimeout(r, slow.ms))
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
  const watcher = createHelperAccounts({
    home, credentials, now: () => clock.at,
    inventory: async () => rows,
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
  const room = (id: string, used: number) => {
    const dir = join(profileDirectory(home, id), 'state', 'usage')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'last-status.json')
    writeFileSync(file, JSON.stringify({ rate_limits: { seven_day: { used_percentage: used, resets_at: Math.floor((clock.at + 3 * 24 * 3600_000) / 1000) } } }))
    const at = new Date(clock.at - 1000)
    utimesSync(file, at, at)
  }
  return { clock, folders, reader, rows, restarts, watcher, job, add, slow, hold, look, room, home }
}

async function atLimit(t: any) {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.rows[0].accountId = s1
  f.clock.at = T0 + 61_000
  await f.watcher.snapshot() // the heartbeat before the limit
  f.clock.at = T0 + 122_000
  await f.job({ action: 'assign', mode: 'limit', accountId: s2, assistantId: 41 })
  const L = f.clock.at + 1000
  f.rows[0].limit = limitAt(L)
  f.clock.at = L + 1000
  f.slow.ms = 20
  await f.look() // the reads land after this look: S1 seat A, S2 seat B, both since the limit
  await settle()
  return { f, s1, s2, L }
}

test('R3-C1 control: nothing changed, the switch lands on the next look', async (t) => {
  const { f, s2, L } = await atLimit(t)
  f.clock.at = L + 62_000
  await f.look()
  assert.deepEqual(f.restarts.map((r) => r.choice), [s2])
})

test('R3-S1 a read the watcher is already replacing must not move the agent onto the seat it is limited on', async (t) => {
  const { f, s2, L } = await atLimit(t)
  f.clock.at = L + 30_000
  f.folders.set(s2, on(A)) // the owner signs S2 in to seat A, the limited seat, 28 s after the read
  f.clock.at = L + 62_000
  await f.look()
  await settle()
  assert.deepEqual(f.restarts, [], 'S2 is on the limited seat now, and a read saying so is already running')
})

test('R3-S2 a read the watcher is already replacing must not restart the agent onto a signed out login', async (t) => {
  const { f, s2, L } = await atLimit(t)
  f.clock.at = L + 30_000
  f.folders.set(s2, OUT)
  f.clock.at = L + 62_000
  await f.look()
  await settle()
  assert.deepEqual(f.restarts, [], 'S2 was signed out 32 s ago')
})

test('R3-S3 the two minute cap holds for a read that lands during the look (a PC asleep for 3 h)', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.rows[0].accountId = s1
  f.clock.at = T0 + 61_000
  await f.watcher.snapshot()
  f.clock.at = T0 + 122_000
  await f.job({ action: 'assign', mode: 'limit', accountId: s2, assistantId: 41 })
  const L = f.clock.at + 1000
  f.rows[0].limit = limitAt(L)
  f.clock.at = L + 1000
  const release = f.hold(s2) // S2's read starts now and the PC sleeps before it answers
  await f.watcher.tick()
  assert.deepEqual(f.restarts, [])
  f.clock.at = L + 3 * 3600_000
  f.folders.set(s2, OUT) // signed out during those hours
  setImmediate(() => release(on(B))) // the old read answers as the first look after the wake waits on it
  await f.watcher.tick()
  assert.deepEqual(f.restarts, [], 'the read is 3 hours old')
})

test('R3-A1 an Auto press is judged on a read started since the press (a login signed out 10 s ago)', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.rows[0].accountId = s1
  f.clock.at = T0 + 61_000
  f.room(s1, 90)
  f.room(s2, 10)
  await f.watcher.snapshot()
  f.clock.at += 10_000
  f.folders.set(s2, OUT)
  f.clock.at += 10_000
  await f.job({ action: 'assign', mode: 'auto', assistantId: 41 })
  assert.deepEqual(f.restarts, [], 'S2 was signed out 10 s before the press')
})

test('R3-A2 a Switch at limit press on an agent already at its limit is judged on a read since the press', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.rows[0].accountId = s1
  f.clock.at = T0 + 61_000
  await f.watcher.snapshot()
  const L = T0 + 122_000
  f.rows[0].limit = limitAt(L)
  f.clock.at = L + 1000
  await f.watcher.snapshot()
  f.clock.at += 10_000
  f.folders.set(s2, OUT)
  f.clock.at += 10_000
  await f.job({ action: 'assign', mode: 'limit', accountId: s2, assistantId: 41 })
  assert.deepEqual(f.restarts, [], 'S2 was signed out 10 s before the press')
})

for (const [name, delay] of [['20 s', 20_000], ['14 min, watcher was down', 14 * 60_000]] as const) {
  test(`R3-F1 the first read after a limit (${name}) must not call the limited seat "another account"`, async (t) => {
    const f = rig(t)
    const s1 = await f.add('S1'), s2 = await f.add('S2')
    f.folders.set(s1, on(A))
    f.folders.set(s2, on(A)) // two saved logins on seat A
    f.rows[0].accountId = s1
    f.clock.at = T0 + 61_000
    await f.watcher.snapshot()
    f.clock.at = T0 + 122_000
    await f.job({ action: 'assign', mode: 'limit', accountId: s2, assistantId: 41 })
    const L = f.clock.at + 1000
    f.rows[0].limit = limitAt(L) // the agent hits its limit on seat A
    f.clock.at = L + 10_000
    f.folders.set(s1, on(B)) // the owner signs S1 in to seat B after the limit
    f.clock.at = L + delay
    await f.watcher.tick()
    assert.deepEqual(f.restarts, [], 'S2 is seat A, the seat at the limit')
  })
}

test('R3-P0 control: one waiting press lands once its agent is ready', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.rows[0].accountId = s1
  f.rows[0].ready = false
  f.clock.at = T0 + 61_000
  await f.job({ action: 'assign', mode: 'now', accountId: s2, assistantId: 41 })
  f.rows[0].ready = true
  f.slow.ms = 20
  for (let i = 0; i < 5 && f.restarts.length < 1; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  assert.deepEqual(f.restarts.map((r) => r.id), [41])
})

test('R3-P1 two agents waiting on a Switch press to ONE login both land', async (t) => {
  const f = rig(t, [41, 42])
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  for (const r of f.rows) {
    r.accountId = s1
    r.ready = false
  }
  f.clock.at = T0 + 61_000
  await f.job({ action: 'assign', mode: 'now', accountId: s2, assistantId: 41 })
  f.clock.at += 1000
  await f.job({ action: 'assign', mode: 'now', accountId: s2, assistantId: 42 })
  for (const r of f.rows) r.ready = true
  f.slow.ms = 20
  for (let i = 0; i < 8 && f.restarts.length < 2; i++) {
    f.clock.at += 61_000
    await f.look()
    await settle()
  }
  assert.deepEqual(f.restarts.map((r) => r.id).sort(), [41, 42], 'eight looks after both agents were ready')
})

test('R3-Q1 Auto at a limit never picks from a partial view (one login read just before the limit)', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2'), s3 = await f.add('S3')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.folders.set(s3, on(C))
  f.rows[0].accountId = s1
  f.clock.at = T0 + 61_000
  await f.job({ action: 'assign', mode: 'auto', assistantId: 41 }) // armed, no room known, it stays
  assert.deepEqual(f.restarts, [])
  f.clock.at += 61_000
  await f.reader.read({ key: s3, env: {}, cwd: f.home }) // S3's read is from just before the limit
  f.clock.at += 5_000
  const L = f.clock.at
  f.rows[0].limit = limitAt(L)
  f.clock.at = L + 1000
  f.room(s2, 50)
  f.room(s3, 10) // S3 has by far the most week room
  await f.watcher.tick()
  assert.ok(!f.restarts.some((r: any) => r.choice === s2), 'S2 was picked while S3, with more room, had no read since the limit')
})

// -- the last read before a restart -------------------------------------------------------------------------

test('R4 a Switch now that waited for its turn is read again before the restart: signed out since, it says so and nothing moves', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.rows[0].accountId = s1
  f.rows[0].ready = false
  f.clock.at = T0 + 61_000
  await f.job({ action: 'assign', mode: 'now', accountId: s2, assistantId: 41 })
  await f.look() // still in its turn: this look keeps the read that says S2 is signed in
  await settle()
  f.clock.at += 30_000
  f.folders.set(s2, OUT)
  f.clock.at += 31_000
  f.rows[0].ready = true
  f.slow.ms = 20
  await f.look()
  await settle()
  assert.deepEqual(f.restarts, [])
  assert.equal((await f.watcher.snapshot()).status, 'needs_sign_in')
})

test('R4 a last read that fails moves nothing: Switch at limit keeps its rule and waits', async (t) => {
  const { f, s2, L } = await atLimit(t)
  f.clock.at = L + 62_000
  f.folders.set(s2, 'fail')
  await f.look()
  await settle()
  assert.deepEqual(f.restarts, [])
  const agent = (await f.watcher.snapshot()).agents[0]
  assert.deepEqual([agent.status, agent.rule], ['waiting_for_room', { mode: 'limit', accountId: s2 }])
})

test('R4 at a limit the agent\'s own login is read again too: if it now names the target\'s seat, nothing moves', async (t) => {
  const f = rig(t)
  const s2 = await f.add('S2')
  f.folders.set('own', on(A))
  f.folders.set(s2, on(B))
  f.clock.at = T0 + 61_000
  await f.watcher.snapshot()
  await f.job({ action: 'assign', mode: 'limit', accountId: s2, assistantId: 41 })
  await settle()
  const L = f.clock.at + 1000
  f.rows[0].limit = limitAt(L)
  f.clock.at = L + 1000
  const release = f.hold(s2) // the target's read is still out at this look
  await f.watcher.tick()
  assert.deepEqual(f.restarts, [])
  release(on(B))
  await settle()
  f.folders.set('own', on(B))
  f.clock.at = L + 61_000
  await f.watcher.tick()
  await settle()
  assert.deepEqual(f.restarts, [], 'the folder is on seat B now: moving it to seat B is no other account')
})

// -- the account at the limit --------------------------------------------------------------------------------

test('R4 with no read from before the limit the account at it is unknown: nothing moves', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.rows[0].accountId = s1
  f.clock.at = T0 + 61_000
  await f.job({ action: 'assign', mode: 'limit', accountId: s2, assistantId: 41 })
  f.rows[0].limit = limitAt(f.clock.at + 1000)
  f.clock.at += 2000
  await f.look()
  await settle()
  f.clock.at += 61_000
  await f.look()
  await settle()
  assert.deepEqual(f.restarts, [], 'S1 was never read as seat A before the limit')
})

test('R4 a read from before the limit that is over ten minutes old is no proof of the account at it', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.rows[0].accountId = s1
  f.clock.at = T0 + 61_000
  await f.watcher.snapshot()
  await f.job({ action: 'assign', mode: 'limit', accountId: s2, assistantId: 41 })
  const L = f.clock.at + 11 * 60_000
  f.rows[0].limit = limitAt(L)
  f.clock.at = L + 1000
  await f.look()
  await settle()
  f.clock.at = L + 62_000
  await f.look()
  await settle()
  assert.deepEqual(f.restarts, [])
})

test('R4 once the reads before and after a limit differ, that limit stays unknown even when the login goes back', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(C))
  f.rows[0].accountId = s1
  f.clock.at = T0 + 61_000
  await f.watcher.snapshot()
  await f.job({ action: 'assign', mode: 'limit', accountId: s2, assistantId: 41 })
  const L = f.clock.at + 1000
  f.rows[0].limit = limitAt(L)
  f.folders.set(s1, on(B))
  f.clock.at = L + 1000
  await f.look()
  await settle()
  f.folders.set(s1, on(A))
  f.clock.at = L + 62_000
  await f.look()
  await settle()
  assert.deepEqual(f.restarts, [], 'A, then B: which of them hit the limit cannot be known')
})

test('R4 a first read more than five minutes after the limit cannot name the account at it', async (t) => {
  const f = rig(t)
  const s1 = await f.add('S1'), s2 = await f.add('S2')
  f.folders.set(s1, on(A))
  f.folders.set(s2, on(B))
  f.rows[0].accountId = s1
  f.clock.at = T0 + 61_000
  await f.watcher.snapshot()
  await f.job({ action: 'assign', mode: 'limit', accountId: s2, assistantId: 41 })
  const L = f.clock.at + 1000
  f.rows[0].limit = limitAt(L)
  f.clock.at = L + 5 * 60_000 + 1000
  await f.look()
  await settle()
  f.clock.at += 61_000
  await f.look()
  await settle()
  assert.deepEqual(f.restarts, [])
})
