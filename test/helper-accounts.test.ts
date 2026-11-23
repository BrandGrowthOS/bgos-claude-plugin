import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHelperAccounts, readAccountRegistry } from '../lib/helper-accounts.mjs'
import { seatToken } from './helpers/claude-auth-status.ts'

/** The fake Claude account a status read names, as lib/claude-account-id.mjs tokens it. */
// Each seed is another seat (email) of one Team organization: the CLI's real key set.
const accountToken = (seed: string) => seatToken(`seat-${seed}`)

const now = Date.UTC(2026, 10, 19, 12)
const usage = (short: number, week: number, model: number) => ({
  short,
  week,
  model,
  readAt: new Date(now).toISOString(),
  resetAt: new Date(now + 86400000).toISOString(),
})
function fixture(t: any) {
  const home = mkdtempSync(join(tmpdir(), 'watcher-accounts-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const credentials = { pairingId: 23, machineId: 'machine-12345', backendUrl: 'https://api.fixture.test' }
  const readings = new Map<string, any>()
  const restarts: any[] = []
  const row = {
    assistantId: 41,
    pairingId: 13,
    userId: 'user_fixture',
    accountId: null as string | null,
    sessionId: randomUUID(),
    ready: true,
    stopped: false,
    limit: null as null | { atMs: number; resetsAtMs: number; model: string | null; agentModel: string | null },
    model: 'opus',
  }
  let returns = true
  const clockRef = { at: now }
  // The agent's own login (no saved one): the account a status read of its launch folder names.
  const own: { read: boolean; account: string | null; readAt?: number } = { read: true, account: accountToken('own') }
  const measured: Array<{ id: string; after?: number }> = []
  const atLimit: boolean[] = []
  const holds = { count: 0 }
  const port = {
    measure: async (account: any, _model?: unknown, opts?: { after?: number }): Promise<any> => {
      measured.push({ id: account.id, after: opts?.after })
      return { readAt: clockRef.at, ...(readings.get(account.id) ?? { signedIn: false, usage: null }) }
    },
  }
  const deps = {
    home,
    credentials,
    now: () => clockRef.at,
    inventory: async () => [row],
    // A reading is taken now unless a test says when (readAt).
    measure: (account: any, model?: unknown, opts?: { after?: number }) => port.measure(account, model, opts),
    ownAccount: async () => ({ readAt: clockRef.at, ...own }),
    restart: async (r: any, choice: string | null, opts: any = {}) => {
      if (holds.count > 0) {
        holds.count--
        return { started: false, wait: true }
      }
      atLimit.push(opts.atLimit === true)
      restarts.push({ id: r.assistantId, choice, sessionId: r.sessionId })
      if (returns || choice === null) row.accountId = choice
      return returns || choice === null
    },
  }
  const watcher = createHelperAccounts(deps)
  const job = (command: any, extra = {}) =>
    watcher.run(randomUUID(), {
      op: 'helper_accounts',
      machineId: credentials.machineId,
      watcherPairingId: 23,
      ownerUserId: row.userId,
      requestedBy: 'owner',
      targets: command.assistantId ? [{ assistantId: command.assistantId, pairingId: 13 }] : [],
      accountCommand: command,
      ...extra,
    })
  const add = async (label: string) => {
    await job({ action: 'add', label })
    return (await watcher.snapshot()).accounts.find((a: any) => a.label === label).id
  }
  const assign = (mode: string, id?: string, assistantId?: number) =>
    job({ action: 'assign', mode, ...(id ? { accountId: id } : {}), ...(assistantId ? { assistantId } : {}) })
  // Each saved login is signed in to its own Claude account unless a test says otherwise.
  const sign = (id: string, short: number, week: number, model: number, account = accountToken(id)) =>
    readings.set(id, { signedIn: true, usage: usage(short, week, model), account })
  /** The heartbeat 30 s before a limit reads every login (and an agent's own), then the agent hits it. */
  const hitLimit = async (atMs: number, ...rest: any[]) => {
    const back = clockRef.at
    clockRef.at = atMs - 30_000
    await watcher.snapshot()
    if (row.accountId === null) await watcher.tick()
    clockRef.at = back
    row.limit = (limitAt as any)(atMs, ...rest)
  }
  return {
    watcher,
    deps,
    port,
    hitLimit,
    job,
    add,
    assign,
    row,
    sign,
    readings,
    own,
    measured,
    restarts,
    setNow: (ms: number) => (clockRef.at = ms),
    atLimit,
    holds,
    // The capkeeper statusline sample of one saved login, as its tap writes it.
    week: (id: string, used: number) => {
      const dir = join(home, '.bgos-agent', 'helper-accounts', id, 'state', 'usage')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'last-status.json')
      writeFileSync(file, JSON.stringify({ rate_limits: { seven_day: { used_percentage: used, resets_at: Math.floor((now + 86400000) / 1000) } } }))
      utimesSync(file, new Date(now - 60000), new Date(now - 60000))
    },
    failStart: () => {
      returns = false
    },
  }
}

test('a machine assignment persists the default used by the next start without restarting running agents', async (t) => {
  const f = fixture(t)
  const id = await f.add('First local account')
  f.sign(id, 10, 20, 30)
  await f.assign('now', id)
  assert.equal((await createHelperAccounts(f.deps).snapshot()).defaultAccountId, id)
  assert.equal(f.restarts.length, 0)
})

test('one agent finishes its turn and returns through its watcher on the same pin', async (t) => {
  const f = fixture(t)
  const id = await f.add('Second')
  f.sign(id, 10, 20, 30)
  f.row.ready = false
  await f.assign('now', id, 41)
  assert.equal((await f.watcher.snapshot()).status, 'waiting_for_turn')
  const firstPress = (await f.watcher.snapshot()).statusRpcId
  // Review #7: an accepted change waiting for its turn is never silently replaced by a later press.
  await assert.rejects(f.assign('now', id, 41), /job_in_flight/)
  assert.equal((await f.watcher.snapshot()).statusRpcId, firstPress)
  assert.equal(f.restarts.length, 0)
  f.row.ready = true
  await f.watcher.tick()
  assert.deepEqual(f.restarts, [{ id: 41, choice: id, sessionId: f.row.sessionId }])
  assert.equal((await f.watcher.snapshot()).status, 'back_online')
})

const HOUR = 3600000
const limitAt = (atMs: number, model: string | null = null, resetsAtMs = now + 4 * HOUR) => ({ atMs, resetsAtMs, model, agentModel: 'opus' })
const agentOf = async (f: any) => (await f.watcher.snapshot()).agents.find((a: any) => a.assistantId === 41)

test('Switch at limit waits for the agent own limit line, then switches once and blocks the old account', async (t) => {
  const f = fixture(t)
  const a = await f.add('Primary'),
    b = await f.add('Reserve')
  f.sign(a, 10, 20, 30)
  f.sign(b, 5, 10, 20)
  f.row.accountId = a
  await f.assign('limit', b, 41)
  assert.deepEqual(await agentOf(f), { assistantId: 41, accountId: a, status: 'waiting_for_limit', rule: { mode: 'limit', accountId: b } })
  // A busy agent with no limit is never touched; neither is one whose usage only looks high.
  f.row.ready = false
  await f.watcher.tick()
  assert.equal(f.restarts.length, 0)
  // Its own "You've hit your session limit" line: switch now, even mid turn (it cannot answer anyway).
  await f.hitLimit(now - 60000)
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [b])
  assert.deepEqual(f.atLimit, [true])
  assert.deepEqual(await agentOf(f), { assistantId: 41, accountId: b, status: 'back_online' })
  const snap = await f.watcher.snapshot()
  assert.deepEqual(snap.accounts.find((x: any) => x.id === a).limits, [{ model: null, until: new Date(now + 4 * HOUR).toISOString() }])
  // The carried over conversation still ends in A's refusal: that is not B's limit, and the rule is spent.
  await f.watcher.tick()
  assert.equal(f.restarts.length, 1)
  assert.equal(snap.accounts.find((x: any) => x.id === b).limits, undefined)
})

test('Auto picks the most week room now and at each limit, never an account out of room for that model', async (t) => {
  const f = fixture(t)
  const a = await f.add('A'),
    b = await f.add('B'),
    c = await f.add('C')
  for (const id of [a, b, c]) f.sign(id, 10, 10, 10)
  f.week(a, 80)
  f.week(b, 36)
  f.week(c, 14)
  f.row.accountId = a
  await f.assign('auto', undefined, 41)
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [c])
  assert.deepEqual(await agentOf(f), { assistantId: 41, accountId: c, status: 'back_online', rule: { mode: 'auto' } })
  // C hits its Opus limit: C has no Opus room until the reset, B has the most week room left. Each limit
  // comes after the last switch, and the looks after it read each login since the limit began.
  await f.hitLimit(now + 10_000, 'opus')
  f.setNow(now + 11_000)
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [c, b])
  // B hits its session limit: only A is left with room for Opus.
  await f.hitLimit(now + 20_000)
  f.setNow(now + 21_000)
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [c, b, a])
  const limits = Object.fromEntries((await f.watcher.snapshot()).accounts.map((x: any) => [x.label, x.limits]))
  assert.deepEqual(limits.C, [{ model: 'opus', until: new Date(now + 4 * HOUR).toISOString() }])
  assert.deepEqual(limits.B, [{ model: null, until: new Date(now + 4 * HOUR).toISOString() }])
  // A hits its limit too: nothing has room, so Auto waits instead of switching back.
  await f.hitLimit(now + 30_000)
  f.setNow(now + 31_000)
  await f.watcher.tick()
  assert.equal(f.restarts.length, 3)
  assert.equal((await agentOf(f)).status, 'waiting_for_room')
  assert.deepEqual(f.atLimit, [false, true, true])
})

test('a switch at limit that is not safe yet waits and is tried again for the same limit', async (t) => {
  const f = fixture(t)
  const a = await f.add('A'),
    b = await f.add('B')
  f.sign(a, 1, 1, 1)
  f.sign(b, 1, 1, 1)
  f.row.accountId = a
  await f.assign('limit', b, 41)
  await f.hitLimit(now - 1000)
  f.holds.count = 1
  await f.watcher.tick()
  assert.equal(f.restarts.length, 0)
  assert.equal((await agentOf(f)).status, 'waiting_for_turn')
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [b])
})

// -- rule A: a switch at the limit moves only to ANOTHER Claude account; rule C: a status read that
// fails or times out switches nothing and the rule waits ------------------------------------------------

test('rule A: Switch at limit never moves to a saved login on the same Claude account; it waits, and moves once that login is another account', async (t) => {
  const f = fixture(t)
  const a = await f.add('Work'),
    b = await f.add('Work again')
  f.sign(a, 1, 1, 1, accountToken('same'))
  f.sign(b, 1, 1, 1, accountToken('same'))
  f.row.accountId = a
  await f.assign('limit', b, 41)
  await f.hitLimit(now - 1000)
  await f.watcher.tick()
  assert.equal(f.restarts.length, 0, 'the same account again is no way out of its limit')
  assert.deepEqual(await agentOf(f), { assistantId: 41, accountId: a, status: 'waiting_for_room', rule: { mode: 'limit', accountId: b } })
  f.sign(b, 1, 1, 1, accountToken('other'))
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [b])
})

test('rule A: Auto at the limit skips a saved login on the same account as the limited one, even with the most room', async (t) => {
  const f = fixture(t)
  const a = await f.add('A'),
    b = await f.add('B'),
    twin = await f.add('Twin')
  f.sign(a, 1, 1, 1, accountToken('a'))
  f.sign(b, 1, 1, 1, accountToken('b'))
  f.sign(twin, 1, 1, 1, accountToken('a'))
  f.week(a, 90)
  f.week(b, 60)
  f.week(twin, 5)
  f.row.accountId = a
  await f.hitLimit(now - 1000)
  await f.assign('auto', undefined, 41)
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [b])
})

test('rule A: an agent on its own login moves at its limit only to a saved login on another account', async (t) => {
  const f = fixture(t)
  const mine = await f.add('Mine'),
    other = await f.add('Other')
  f.sign(mine, 1, 1, 1, accountToken('own'))
  f.sign(other, 1, 1, 1)
  await f.assign('limit', mine, 41)
  await f.hitLimit(now - 1000)
  await f.watcher.tick()
  assert.equal(f.restarts.length, 0, 'its own account under another folder name')
  await f.job({ action: 'clear', assistantId: 41 })
  await f.assign('limit', other, 41)
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [other])
})

test('rule A: the account at the limit is the one read AT it; the own login signed in elsewhere later never makes the limited account look new', async (t) => {
  const f = fixture(t)
  const twin = await f.add('Twin')
  f.sign(twin, 1, 1, 1, accountToken('own'))
  await f.assign('limit', twin, 41)
  await f.hitLimit(now - 1000)
  await f.watcher.tick()
  assert.equal(f.restarts.length, 0, 'the twin is the limited account under another folder')
  // The owner signs the agent's own folder into another account; the running agent is still limited.
  f.own.account = accountToken('later')
  await f.watcher.tick()
  assert.equal(f.restarts.length, 0, 'still the account it hit the limit on: no switch onto it')
  // The account token stays on this computer: the heartbeat snapshot carries none.
  for (const account of (await f.watcher.snapshot()).accounts) {
    assert.equal('account' in account, false)
    assert.equal('readFailed' in account, false)
  }
})

test('m7 (r2): the account kept for one limit never stands in for the next: at a second limit, a login on that seat is not "another"', async (t) => {
  const f = fixture(t)
  const s1 = await f.add('S1'),
    s2 = await f.add('S2'),
    s3 = await f.add('S3')
  f.sign(s1, 1, 1, 1, accountToken('one'))
  f.sign(s2, 1, 1, 1, accountToken('two'))
  f.sign(s3, 1, 1, 1, accountToken('two'))
  f.row.accountId = s1
  await f.assign('limit', s2, 41)
  await f.hitLimit(now - 1000)
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [s2], 'limit 1 was on seat one: S2 is another seat')
  // On S2 the agent works again, then hits a second limit, on seat two. Switch at limit to S3 (seat two too).
  f.setNow(now + 60_000)
  await f.assign('limit', s3, 41)
  await f.hitLimit(now + 30_000)
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [s2], 'S3 is the seat of THIS limit: no move')
  const snapshot = JSON.stringify(await f.watcher.snapshot())
  for (const seat of ['one', 'two']) assert.ok(!snapshot.includes(accountToken(seat).split(':')[1]), 'no token reaches the heartbeat')
  assert.ok(!snapshot.includes('seats.example.test'), 'no email either')
})

test('m7 (r5): at a limit Auto counts a login only on a read taken since the limit began, never an older one', async (t) => {
  const f = fixture(t)
  const s1 = await f.add('S1'),
    s2 = await f.add('S2')
  f.sign(s1, 1, 1, 1, accountToken('one'))
  f.row.accountId = s1
  await f.hitLimit(now - 1000)
  // S2 read as seat two 30 s BEFORE the limit; it may have been signed in to seat one (the limited) since.
  f.readings.set(s2, { signedIn: true, usage: usage(1, 1, 1), account: accountToken('two'), readAt: now - 30_000 })
  await f.assign('auto', undefined, 41)
  await f.watcher.tick()
  assert.deepEqual(f.restarts, [], 'a read from before the limit is no proof of another seat')
  // The next read (since the limit) names seat one, the limited one: still no move.
  f.readings.set(s2, { signedIn: true, usage: usage(1, 1, 1), account: accountToken('one'), readAt: now })
  await f.watcher.tick()
  assert.deepEqual(f.restarts, [])
  // Read again as seat two: now it moves.
  f.setNow(now + 61_000)
  f.readings.set(s2, { signedIn: true, usage: usage(1, 1, 1), account: accountToken('two'), readAt: now + 61_000 })
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [s2])
})

test('B1: the account at the limit is only ever read since it began: a saved login, then the own login', async (t) => {
  const f = fixture(t)
  const s1 = await f.add('S1'),
    s2 = await f.add('S2')
  f.sign(s1, 1, 1, 1, accountToken('one'))
  f.sign(s2, 1, 1, 1, accountToken('two'))
  await f.assign('limit', s2, 41)
  f.row.accountId = s1
  await f.hitLimit(now - 1000)
  f.readings.set(s1, { ...f.readings.get(s1), readAt: now - 2000 })
  await f.watcher.tick()
  assert.deepEqual(f.restarts, [], 'a read of the limited login from before the limit names nothing')
  f.readings.set(s1, { ...f.readings.get(s1), readAt: now })
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [s2])

  const g = fixture(t)
  const other = await g.add('Other')
  g.sign(other, 1, 1, 1, accountToken('other'))
  await g.assign('limit', other, 41)
  g.row.accountId = null
  await g.hitLimit(now - 1000)
  g.own.readAt = now - 2000
  await g.watcher.tick()
  assert.deepEqual(g.restarts, [], 'nor does an older read of its own login')
  delete g.own.readAt
  await g.watcher.tick()
  assert.deepEqual(g.restarts.map((r: any) => r.choice), [other])
})

test('m4 (r5-target-old-read): Switch at limit waits when the target was last read before the limit', async (t) => {
  const f = fixture(t)
  const s1 = await f.add('S1'),
    s2 = await f.add('S2')
  f.sign(s1, 1, 1, 1, accountToken('one'))
  f.sign(s2, 1, 1, 1, accountToken('two'))
  await f.assign('limit', s2, 41)
  f.row.accountId = s1
  await f.hitLimit(now - 1000)
  f.readings.set(s2, { ...f.readings.get(s2), readAt: now - 2000 })
  await f.watcher.tick()
  assert.deepEqual(f.restarts, [])
  assert.deepEqual((await agentOf(f)).rule, { mode: 'limit', accountId: s2 })
  f.readings.set(s2, { ...f.readings.get(s2), readAt: now })
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [s2])
})

test('M-2: a Switch press asks for a read started since the press, and keeps asking from that press while it waits', async (t) => {
  const f = fixture(t)
  const a = await f.add('A'),
    b = await f.add('B')
  f.sign(a, 1, 1, 1)
  f.sign(b, 1, 1, 1)
  f.row.accountId = a
  f.row.ready = false
  f.setNow(now + 5000)
  f.measured.length = 0
  await f.assign('now', b, 41)
  assert.deepEqual(f.measured.filter((m) => m.id === b).map((m) => m.after), [now + 5000])
  f.setNow(now + 9000)
  f.measured.length = 0
  await f.watcher.tick()
  assert.deepEqual(f.measured.filter((m) => m.id === b).map((m) => m.after), [now + 5000], 'the press time, not a new read every look')
})

test('M-2: a failed read, or one from before the press, switches nothing and never says needs sign in', async (t) => {
  for (const reading of [{ readFailed: true, signedIn: false, usage: null }, { signedIn: true, usage: usage(1, 1, 1), account: accountToken('b'), readAt: now - 1 }]) {
    const f = fixture(t)
    const a = await f.add('A'),
      b = await f.add('B')
    f.sign(a, 1, 1, 1)
    f.row.accountId = a
    f.readings.set(b, reading)
    await f.assign('now', b, 41)
    assert.deepEqual(f.restarts, [])
    const agent = await agentOf(f)
    assert.deepEqual([agent.status, agent.accountId, agent.rule], ['failed', a, undefined])
    assert.equal((await f.watcher.snapshot()).status, 'failed')
  }
})

/** Status reads of the named logins that stay out until a test lets them land (each is taken when asked). */
function heldReads(f: any, ids: string[]) {
  const out: Array<() => void> = []
  const state = { holding: true }
  const inner = f.port.measure
  f.port.measure = (account: any, model: any, opts: any) => {
    const answer = inner(account, model, opts)
    return state.holding && ids.includes(account.id) ? new Promise((done) => out.push(() => done(answer))) : answer
  }
  return {
    // The tick's reads run one at a time, so the next held one starts as each lands.
    land: async () => {
      for (let turn = 0; turn < 8; turn++) {
        for (const go of out.splice(0)) go()
        await new Promise((r) => setImmediate(r))
      }
    },
    open: () => {
      state.holding = false
    },
  }
}
const returnsAtOnce = (work: Promise<unknown>) => Promise.race([work.then(() => true), new Promise((r) => setTimeout(() => r(false), 500))])

test('A: the tick never waits for a status read: it returns, keeps the rule, and the next look acts on the read that landed', { timeout: 15_000 }, async (t) => {
  const f = fixture(t)
  const a = await f.add('A'),
    b = await f.add('B')
  f.sign(a, 1, 1, 1)
  f.sign(b, 1, 1, 1)
  await f.assign('limit', b, 41)
  f.row.accountId = a
  await f.hitLimit(now - 1000)
  const held = heldReads(f, [a, b])
  const watcher = f.watcher
  assert.equal(await returnsAtOnce(watcher.tick()), true, 'the loop is not held up')
  assert.deepEqual(f.restarts, [])
  const kept = readAccountRegistry(f.deps.home)!.targets['41'].rule
  assert.deepEqual([kept.mode, kept.accountId], ['limit', b])
  await held.land()
  held.open()
  await watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [b])
})

test('A: reads as slow as the one minute heartbeat still land a switch: the last finished read counts while a new one runs', { timeout: 15_000 }, async (t) => {
  const f = fixture(t)
  const a = await f.add('A'),
    b = await f.add('B')
  f.sign(a, 1, 1, 1)
  f.sign(b, 1, 1, 1)
  await f.assign('limit', b, 41)
  f.row.accountId = a
  await f.hitLimit(now - 1000)
  const held = heldReads(f, [a, b])
  const watcher = f.watcher
  await watcher.tick() // starts both reads: the limited login's and the target's
  assert.deepEqual(f.restarts, [])
  await held.land()
  f.setNow(now + 60_000) // the next heartbeat: both reads are a minute old and new ones are out
  const look = watcher.tick() // about to move, it waits only for the one last read of each login
  await held.land()
  await look
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [b], 'one heartbeat later')
})

test('A: a finished read older than two minutes never stands in while a new one runs', { timeout: 15_000 }, async (t) => {
  const f = fixture(t)
  const a = await f.add('A'),
    b = await f.add('B')
  f.sign(a, 1, 1, 1)
  f.sign(b, 1, 1, 1)
  await f.assign('limit', b, 41)
  f.row.accountId = a
  await f.hitLimit(now - 1000)
  const held = heldReads(f, [a])
  const watcher = f.watcher
  await watcher.tick()
  await held.land()
  f.setNow(now + 121_000)
  await watcher.tick()
  assert.deepEqual(f.restarts, [], 'the only finished read of the limited login is too old')
})

test('A: Auto never picks from a partial view: while one candidate read is out it waits, then takes the most room', { timeout: 15_000 }, async (t) => {
  const f = fixture(t)
  const a = await f.add('A'),
    b = await f.add('B'),
    c = await f.add('C')
  for (const id of [a, b, c]) f.sign(id, 10, 10, 10)
  f.week(a, 5)
  f.week(b, 36)
  f.week(c, 14)
  f.row.accountId = a
  await f.assign('auto', undefined, 41)
  assert.deepEqual(f.restarts, [], 'already on the most room')
  await f.hitLimit(now + 5000) // after the press, so no candidate has a read since the limit yet
  f.setNow(now + 6000)
  const held = heldReads(f, [c])
  const watcher = f.watcher
  assert.equal(await returnsAtOnce(watcher.tick()), true)
  assert.deepEqual(f.restarts, [], 'B is ready, but C has more room and is not read yet')
  await held.land()
  held.open()
  await watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [c])
})

test('A: a Switch press waiting for its turn, whose read is still out, keeps waiting and is never reported failed', { timeout: 15_000 }, async (t) => {
  const f = fixture(t)
  const a = await f.add('A'),
    b = await f.add('B')
  f.sign(a, 1, 1, 1)
  f.sign(b, 1, 1, 1)
  f.row.accountId = a
  f.row.ready = false
  await f.assign('now', b, 41)
  assert.equal((await f.watcher.snapshot()).status, 'waiting_for_turn')
  f.row.ready = true
  f.setNow(now + 61_000)
  const held = heldReads(f, [b])
  const watcher = f.watcher
  assert.equal(await returnsAtOnce(watcher.tick()), true)
  assert.deepEqual(f.restarts, [])
  assert.equal(readAccountRegistry(f.deps.home)!.status, 'waiting_for_turn')
  await held.land()
  held.open()
  await watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [b])
})

test('A: the tick\'s status reads run beside the loop one at a time, however many logins it asks about', async (t) => {
  const f = fixture(t)
  const a = await f.add('A'),
    b = await f.add('B'),
    c = await f.add('C')
  for (const id of [a, b, c]) f.sign(id, 10, 10, 10)
  f.row.accountId = a
  await f.assign('auto', undefined, 41)
  await f.hitLimit(now - 1000)
  const inner = f.port.measure
  let running = 0,
    most = 0,
    reads = 0
  f.port.measure = async (account: any, model: any, opts: any) => {
    reads++
    most = Math.max(most, ++running)
    await new Promise((r) => setTimeout(r, 5))
    running--
    return inner(account, model, opts)
  }
  const watcher = f.watcher
  await watcher.tick()
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(reads >= 3, 'every login was read')
  assert.equal(most, 1)
})

test('m1 (r4): at a limit a login whose read is from before it counts as not read yet, so Auto does not pick around it', async (t) => {
  const f = fixture(t)
  const a = await f.add('A'),
    b = await f.add('B'),
    c = await f.add('C')
  for (const id of [a, b, c]) f.sign(id, 10, 10, 10)
  f.week(a, 5)
  f.week(b, 50)
  f.week(c, 10)
  f.row.accountId = a
  await f.assign('auto', undefined, 41)
  f.setNow(now + 30_000)
  await f.watcher.snapshot()
  f.setNow(now + 61_000)
  await f.hitLimit(now + 60_000)
  f.readings.set(c, { ...f.readings.get(c), readAt: now + 30_000 }) // C's newest read is from before the limit
  await f.watcher.tick()
  assert.deepEqual(f.restarts, [], 'B is read, but C has more room and has no read since the limit')
})

test('rule A: a first read later than 15 minutes after the limit cannot say which account hit it: nothing switches', async (t) => {
  const f = fixture(t)
  const other = await f.add('Other')
  f.sign(other, 1, 1, 1)
  await f.assign('limit', other, 41)
  await f.hitLimit(now - 20 * 60_000)
  await f.watcher.tick()
  assert.equal(f.restarts.length, 0)
  const agent = (await f.watcher.snapshot()).agents.find((x: any) => x.assistantId === 41)
  assert.deepEqual([agent.status, agent.rule], ['waiting_for_room', { mode: 'limit', accountId: other }])
})

test('rule C: a status read of the saved login that fails or times out at the limit switches nothing and keeps the rule', async (t) => {
  for (const failure of ['rejects', 'readFailed']) {
    const f = fixture(t)
    const a = await f.add('A'),
      b = await f.add('B')
    f.sign(a, 1, 1, 1)
    f.sign(b, 1, 1, 1)
    f.row.accountId = a
    await f.assign('limit', b, 41)
    const good = f.readings.get(b)
    const measure = f.port.measure
    f.port.measure = async (account: any) => {
      if (account.id !== b || f.readings.get(b) === good) return measure(account)
      if (failure === 'rejects') throw new Error('claude auth status timed out')
      return { readFailed: true, signedIn: false, usage: null, readAt: now } // stamped, as the real reader stamps a failure
    }
    const watcher = f.watcher
    await f.hitLimit(now - 1000)
    f.readings.set(b, { ...good })
    await watcher.tick()
    assert.equal(f.restarts.length, 0, failure)
    const agent = (await watcher.snapshot()).agents.find((x: any) => x.assistantId === 41)
    assert.deepEqual([agent.status, agent.rule], ['waiting_for_room', { mode: 'limit', accountId: b }], `${failure}: the rule waits, never needs_sign_in`)
    f.readings.set(b, good)
    await watcher.tick()
    assert.deepEqual(f.restarts.map((r: any) => r.choice), [b], `${failure}: the next read that lands switches`)
  }
})

test("rule C: the limited login's own account cannot be read: nothing switches, Switch at limit and Auto both wait", async (t) => {
  for (const mode of ['limit', 'auto']) {
    const f = fixture(t)
    const b = await f.add('B')
    f.sign(b, 1, 1, 1)
    await f.assign('limit', b, 41) // a rule, so the look before the limit reads the agent's own login
    await f.hitLimit(now - 1000)
    f.own.read = false
    f.own.account = null
    if (mode === 'auto') {
      await f.job({ action: 'clear', assistantId: 41 })
      await f.assign('auto', undefined, 41)
    }
    await f.watcher.tick()
    assert.equal(f.restarts.length, 0, mode)
    assert.equal((await agentOf(f)).status, 'waiting_for_room', mode)
    f.own.read = true
    f.own.account = accountToken('own')
    await f.watcher.tick()
    assert.deepEqual(f.restarts.map((r: any) => r.choice), [b], mode)
  }
})

test('Turn Auto off clears the rule; the timings are refused where they make no sense', async (t) => {
  const f = fixture(t)
  const a = await f.add('A')
  f.sign(a, 1, 1, 1)
  f.row.accountId = a
  await f.assign('auto', undefined, 41)
  assert.deepEqual((await agentOf(f)).rule, { mode: 'auto' })
  await f.job({ action: 'clear', assistantId: 41 })
  assert.deepEqual(await agentOf(f), { assistantId: 41, accountId: a, status: 'saved' })
  await f.hitLimit(now + 5)
  await f.watcher.tick()
  assert.equal(f.restarts.length, 0)
  // No rule left to clear, a computer wide rule, Auto with an account, Switch at limit without one.
  await assert.rejects(f.job({ action: 'clear', assistantId: 41 }))
  await assert.rejects(f.assign('limit', a))
  await assert.rejects(f.assign('auto'))
  await assert.rejects(f.job({ action: 'assign', mode: 'auto', accountId: a, assistantId: 41 }))
  await assert.rejects(f.job({ action: 'assign', mode: 'limit', assistantId: 41 }))
  assert.deepEqual((await f.watcher.snapshot()).modes, ['now', 'limit', 'auto'])
})

test('fresh capacity is reported and stale readings are withheld', async (t) => {
  const f = fixture(t)
  const a = await f.add('A'),
    b = await f.add('B')
  f.sign(a, 10, 14, 74)
  f.sign(b, 12, 36, 32)
  assert.deepEqual((await f.watcher.snapshot()).accounts[1].usage, usage(12, 36, 32))
  f.readings.get(a).usage.readAt = '2026-01-01T00:00:00Z'
  f.sign(b, 100, 36, 32)
  await f.watcher.tick()
  assert.equal((await f.watcher.snapshot()).accounts[0].usage, null)
  assert.equal(f.restarts.length, 0)
})

test('a failed switch restores the previous launch once', async (t) => {
  const f = fixture(t)
  const b = await f.add('B')
  f.sign(b, 12, 36, 32)
  f.failStart()
  await f.assign('now', b, 41)
  await f.watcher.tick()
  assert.deepEqual(
    f.restarts.map((x) => x.choice),
    [b, null],
  )
  assert.equal((await f.watcher.snapshot()).status, 'restored')
})

test('a frame cannot authorize a job, a different pairing or owner cannot change profiles', async (t) => {
  const f = fixture(t)
  const a = await f.add('A')
  f.sign(a, 10, 10, 10)
  for (const extra of [{ requestedBy: 'daemon' }, { watcherPairingId: 22 }, { ownerUserId: 'other' }, { targets: [] }]) {
    await assert.rejects(f.job({ action: 'assign', mode: 'now', accountId: a, assistantId: 41 }, extra))
  }
  assert.equal(f.restarts.length, 0)
})

test('a re-enrolled watcher exposes no prior labels until the same owner proves authority again', async (t) => {
  const f = fixture(t)
  const id = await f.add('Original')
  f.sign(id, 20, 10, 30)
  const rebound = createHelperAccounts({ ...f.deps, credentials: { machineId: 'machine-12345', pairingId: 88, backendUrl: 'https://api.fixture.test' } })
  assert.deepEqual((await rebound.snapshot()).accounts, [])
  const job = {
    op: 'helper_accounts',
    machineId: 'machine-12345',
    watcherPairingId: 88,
    ownerUserId: 'user_fixture',
    requestedBy: 'owner',
    targets: [],
    accountCommand: { action: 'add', label: 'After re-enroll' },
  }
  await rebound.run(randomUUID(), job)
  assert.deepEqual(
    (await rebound.snapshot()).accounts.map((a) => a.label),
    ['Original', 'After re-enroll'],
  )
})

test('a damaged registry cannot send free text in a status, profile id or request id', async (t) => {
  const f = fixture(t)
  await f.add('Owner account')
  const path = join(f.deps.home, '.bgos-agent', 'helper-accounts', 'registry.json')
  const state = JSON.parse(readFileSync(path, 'utf8'))
  const canary = 'private fixture content'
  Object.assign(state, { status: canary, statusRpcId: canary, statusAssistantId: canary })
  state.targets = { computer: { choice: canary }, '41': { status: canary } }
  writeFileSync(path, JSON.stringify(state))
  assert.equal(JSON.stringify(await f.watcher.snapshot()).includes(canary), false)
})

// ---- REVIEW-rvacctbuild.md, one test per watcher finding, each red on 46df4d1 ----

const registryOf = (f: any) => join(f.deps.home, '.bgos-agent', 'helper-accounts', 'registry.json')
const editRegistry = (f: any, change: (state: any) => void) => {
  const state = JSON.parse(readFileSync(registryOf(f), 'utf8'))
  change(state)
  writeFileSync(registryOf(f), JSON.stringify(state))
}

test('review #1: recovery never restarts a conversation the owner opened after the interrupted switch', async (t) => {
  const f = fixture(t)
  const b = await f.add('B')
  f.sign(b, 1, 1, 1)
  const oldPin = f.row.sessionId
  // The watcher stopped after journalling a switch to B; meanwhile the owner opened a new conversation.
  editRegistry(f, (s) => {
    s.targets['41'] = { rpcId: randomUUID(), assistantId: 41, pairingId: 13, choice: b, rule: { mode: 'now', accountId: b }, transition: { desired: b, previous: null, pin: oldPin } }
  })
  f.row.sessionId = randomUUID()
  const recovered = createHelperAccounts(f.deps)
  await recovered.tick()
  assert.deepEqual(f.restarts, [])
  const snap = await recovered.snapshot()
  assert.equal(snap.status, 'failed')
  // The previous login is still the one the next start of this agent uses.
  assert.equal(JSON.parse(readFileSync(registryOf(f), 'utf8')).targets['41'].choice, null)
})

test('review #3: a safety hold on the rollback waits and rolls back, never abandons it', async (t) => {
  const f = fixture(t)
  const b = await f.add('B')
  f.sign(b, 1, 1, 1)
  const calls: any[] = []
  let holdRollback = 1
  const watcher = createHelperAccounts({
    ...f.deps,
    restart: async (r: any, choice: string | null) => {
      calls.push(choice)
      if (choice === b) return false // B starts and its verification fails
      if (holdRollback-- > 0) return { started: false, wait: true } // A must wait for activity to finish
      f.row.accountId = choice
      return true
    },
  })
  await watcher.run(randomUUID(), {
    op: 'helper_accounts', machineId: 'machine-12345', watcherPairingId: 23, ownerUserId: 'user_fixture', requestedBy: 'owner',
    targets: [{ assistantId: 41, pairingId: 13 }], accountCommand: { action: 'assign', mode: 'now', accountId: b, assistantId: 41 },
  })
  assert.deepEqual(calls, [b, null])
  assert.equal((await watcher.snapshot()).status, 'waiting_for_turn')
  await watcher.tick()
  assert.deepEqual(calls, [b, null, null])
  assert.equal((await watcher.snapshot()).status, 'restored')
  assert.equal(f.row.accountId, null)
})

test('review #4: a registry from another backend is never published or used', async (t) => {
  const f = fixture(t)
  const a = await f.add('Earlier deployment')
  f.sign(a, 1, 1, 1)
  const other = createHelperAccounts({ ...f.deps, credentials: { pairingId: 23, machineId: 'machine-12345', backendUrl: 'https://another.backend.test' } })
  const snap = await other.snapshot()
  assert.deepEqual(snap.accounts, [])
  assert.equal(snap.defaultAccountId, null)
  await assert.rejects(
    other.run(randomUUID(), {
      op: 'helper_accounts', machineId: 'machine-12345', watcherPairingId: 23, ownerUserId: 'user_fixture', requestedBy: 'owner', targets: [],
      accountCommand: { action: 'add', label: 'New deployment' },
    }),
  )
  assert.equal(JSON.parse(readFileSync(registryOf(f), 'utf8')).backendUrl, 'https://api.fixture.test')
})

test('review #7: a change waiting for its turn can be cancelled by the owner, then replaced', async (t) => {
  const f = fixture(t)
  const a = await f.add('A'),
    b = await f.add('B')
  f.sign(a, 1, 1, 1)
  f.sign(b, 1, 1, 1)
  f.row.ready = false
  await f.assign('now', a, 41)
  await f.job({ action: 'clear', assistantId: 41 })
  assert.equal((await f.watcher.snapshot()).status, 'saved')
  await f.assign('now', b, 41)
  f.row.ready = true
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [b])
})

test('review #9: a stopped agent takes the new login at its next start instead of waiting for a turn', async (t) => {
  const f = fixture(t)
  const b = await f.add('B')
  f.sign(b, 1, 1, 1)
  f.row.ready = false
  f.row.stopped = true
  await f.assign('now', b, 41)
  assert.deepEqual(f.restarts, [])
  assert.equal((await f.watcher.snapshot()).status, 'saved')
  assert.equal(JSON.parse(readFileSync(registryOf(f), 'utf8')).targets['41'].choice, b)
})

test('review #10: a failed job and the account a status is about survive a reopened page', async (t) => {
  const f = fixture(t)
  const b = await f.add('B')
  f.readings.set(b, { signedIn: false, usage: null })
  const rpc = randomUUID()
  await f.watcher.run(rpc, {
    op: 'helper_accounts', machineId: 'machine-12345', watcherPairingId: 23, ownerUserId: 'user_fixture', requestedBy: 'owner',
    targets: [{ assistantId: 41, pairingId: 13 }], accountCommand: { action: 'assign', mode: 'now', accountId: b, assistantId: 41 },
  })
  const snap = await f.watcher.snapshot()
  assert.equal(snap.status, 'needs_sign_in')
  assert.equal(snap.statusAccountId, b)
  // A job that threw before it changed anything still reaches the owner as failed, under its own id.
  const thrown = randomUUID()
  f.watcher.recordFailure(thrown, { ownerUserId: 'user_fixture', accountCommand: { action: 'assign', mode: 'now', accountId: b, assistantId: 41 } })
  const after = await f.watcher.snapshot()
  assert.deepEqual([after.status, after.statusRpcId, after.statusAssistantId], ['failed', thrown, 41])
  // Another owner's failure is not written into this registry.
  f.watcher.recordFailure(randomUUID(), { ownerUserId: 'someone_else', accountCommand: { action: 'add', label: 'x' } })
  assert.equal((await f.watcher.snapshot()).statusRpcId, thrown)
})

test('verify A and B: a refused job reaches the page by its id, with or without a registry, never over a waiting change', async (t) => {
  const f = fixture(t)
  // No registry yet: a Restore on a fresh computer is refused, and still reported.
  const fresh = randomUUID()
  f.watcher.recordFailure(fresh, { ownerUserId: 'user_fixture', accountCommand: { action: 'rebind' } }, new Error('account_change_refused'))
  assert.deepEqual((await f.watcher.snapshot()).refusedRpcIds, [fresh])
  // A change waiting for its turn keeps its own status when a second press is refused.
  const a = await f.add('A')
  f.sign(a, 1, 1, 1)
  f.row.ready = false
  await f.assign('now', a, 41)
  const waiting = (await f.watcher.snapshot()).statusRpcId
  const second = randomUUID()
  f.watcher.recordFailure(second, { ownerUserId: 'user_fixture', accountCommand: { action: 'assign', mode: 'now', accountId: a, assistantId: 41 } }, new Error('job_in_flight'))
  const snap = await f.watcher.snapshot()
  assert.deepEqual([snap.status, snap.statusRpcId], ['waiting_for_turn', waiting])
  assert.deepEqual(snap.refusedRpcIds, [fresh, second])
})

test('verify D: a rollback held by a safety check gives up after its bounded wait', async (t) => {
  const f = fixture(t)
  const b = await f.add('B')
  f.sign(b, 1, 1, 1)
  let clock = now
  const calls: any[] = []
  const watcher = createHelperAccounts({
    ...f.deps,
    now: () => clock,
    restart: async (_r: any, choice: string | null) => {
      calls.push(choice)
      return choice === b ? false : { started: false, wait: true }
    },
  })
  await watcher.run(randomUUID(), {
    op: 'helper_accounts', machineId: 'machine-12345', watcherPairingId: 23, ownerUserId: 'user_fixture', requestedBy: 'owner',
    targets: [{ assistantId: 41, pairingId: 13 }], accountCommand: { action: 'assign', mode: 'now', accountId: b, assistantId: 41 },
  })
  assert.equal((await watcher.snapshot()).status, 'waiting_for_turn')
  clock += 31 * 60_000
  await watcher.tick()
  assert.equal((await watcher.snapshot()).status, 'failed')
  // The previous login stays the next start's, and other changes are accepted again.
  assert.equal(JSON.parse(readFileSync(registryOf(f), 'utf8')).targets['41'].transition, undefined)
})

test('review #11: the same owner rebinds a re-enrolled watcher without spending a slot', async (t) => {
  const f = fixture(t)
  for (let i = 0; i < 32; i++) await f.add(`Saved ${i}`)
  const rebound = createHelperAccounts({ ...f.deps, credentials: { machineId: 'machine-12345', pairingId: 88, backendUrl: 'https://api.fixture.test' } })
  assert.deepEqual((await rebound.snapshot()).accounts, [])
  const rebind = (ownerUserId: string) =>
    rebound.run(randomUUID(), { op: 'helper_accounts', machineId: 'machine-12345', watcherPairingId: 88, ownerUserId, requestedBy: 'owner', targets: [], accountCommand: { action: 'rebind' } })
  await assert.rejects(rebind('someone_else'))
  assert.deepEqual((await rebound.snapshot()).accounts, [])
  await rebind('user_fixture')
  const snap = await rebound.snapshot()
  assert.equal(snap.accounts.length, 32)
  assert.equal(snap.status, 'saved')
})

// -- round 4: the age checks hold whatever the reader answers, and a rule's press never waits ----------

/** The fake reader answers `id` with `patch` when asked for a read since `after`: a reader that hands back
 *  an answer it already held (from before that time, or with no time on it). */
function answersAs(f: any, id: string, after: number, patch: object) {
  const inner = f.port.measure
  f.port.measure = async (account: any, model: any, opts: any) => {
    const answer = await inner(account, model, opts)
    return account.id === id && opts?.after === after ? { ...answer, ...patch } : answer
  }
  return () => (f.port.measure = inner)
}
const OLD_ANSWERS: Array<[string, object]> = [
  ['from before the time asked for', { readAt: now - 2000 }],
  ['with no time on it', { readAt: undefined }],
]

for (const [what, patch] of OLD_ANSWERS) {
  test(`B1 (r4): a saved login's answer ${what} never names the account at a limit`, async (t) => {
    const f = fixture(t)
    const a = await f.add('A'),
      b = await f.add('B')
    f.sign(a, 1, 1, 1)
    f.sign(b, 1, 1, 1)
    f.row.accountId = a
    await f.assign('limit', b, 41)
    await f.hitLimit(now - 1000)
    const honest = answersAs(f, a, now - 1000, patch)
    await f.watcher.tick()
    assert.deepEqual(f.restarts, [], 'the limited login was not read since the limit')
    honest()
    await f.watcher.tick()
    assert.deepEqual(f.restarts.map((r: any) => r.choice), [b], 'control: a read since the limit lands the switch')
  })

  test(`B1 (r4): the agent's own login answering ${what} never names the account at a limit`, async (t) => {
    const f = fixture(t)
    const b = await f.add('B')
    f.sign(b, 1, 1, 1)
    await f.assign('limit', b, 41)
    await f.hitLimit(now - 1000)
    let stale = 1
    const old = (patch as any).readAt
    Object.defineProperty(f.own, 'readAt', { get: () => (stale-- > 0 ? old : now), enumerable: true, configurable: true })
    await f.watcher.tick()
    assert.deepEqual(f.restarts, [], 'the own login was not read since the limit')
    await f.watcher.tick()
    assert.deepEqual(f.restarts.map((r: any) => r.choice), [b], 'control: a read since the limit lands the switch')
  })

  test(`B1 (r4): at a limit, Switch at limit's target answering ${what} moves nothing`, async (t) => {
    const f = fixture(t)
    const a = await f.add('A'),
      b = await f.add('B')
    f.sign(a, 1, 1, 1)
    f.sign(b, 1, 1, 1)
    f.row.accountId = a
    f.setNow(now - 5000)
    await f.assign('limit', b, 41) // pressed before the limit: the look reads since the limit
    f.setNow(now)
    await f.hitLimit(now - 1000)
    const honest = answersAs(f, b, now - 1000, patch)
    await f.watcher.tick()
    assert.deepEqual(f.restarts, [])
    honest()
    await f.watcher.tick()
    assert.deepEqual(f.restarts.map((r: any) => r.choice), [b], 'control')
  })

  test(`B1 (r4): at a limit, an Auto candidate answering ${what} is not read yet: Auto waits`, async (t) => {
    const f = fixture(t)
    const a = await f.add('A'),
      b = await f.add('B')
    f.sign(a, 10, 10, 10)
    f.sign(b, 10, 10, 10)
    f.week(a, 5)
    f.week(b, 36)
    f.row.accountId = a
    f.setNow(now - 5000)
    await f.assign('auto', undefined, 41)
    assert.deepEqual(f.restarts, [], 'already on the most room')
    f.setNow(now)
    await f.hitLimit(now - 1000)
    const honest = answersAs(f, b, now - 1000, patch)
    await f.watcher.tick()
    assert.deepEqual(f.restarts, [])
    honest()
    await f.watcher.tick()
    assert.deepEqual(f.restarts.map((r: any) => r.choice), [b], 'control')
  })
}

test('M1 (r4): a Switch at limit press never acts on an answer from before it, even one since the limit', async (t) => {
  const f = fixture(t)
  const a = await f.add('A'),
    b = await f.add('B')
  f.sign(a, 1, 1, 1)
  f.row.accountId = a
  await f.hitLimit(now - 60_000)
  f.setNow(now)
  // Asked for a read since the press, B hands back one from 30 s after the limit, signed out.
  const honest = answersAs(f, b, now, { readAt: now - 30_000 })
  await f.assign('limit', b, 41)
  assert.notEqual((await f.watcher.snapshot()).status, 'needs_sign_in', 'that answer is from before the press')
  assert.equal(readAccountRegistry(f.deps.home)!.targets['41'].rule?.accountId, b)
  honest()
  f.sign(b, 1, 1, 1)
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [b])
})

test('B1 (r4): the last read before a restart counts only when it is from now, whatever the reader hands back', async (t) => {
  const f = fixture(t)
  const a = await f.add('A'),
    b = await f.add('B')
  f.sign(a, 1, 1, 1)
  f.sign(b, 1, 1, 1)
  f.row.accountId = a
  f.setNow(now - 5000)
  await f.assign('limit', b, 41) // pressed before the limit
  f.setNow(now)
  await f.hitLimit(now - 1000)
  const inner = f.port.measure
  // The look's read of B is since the limit; the last read, asked for now, comes back half a second old.
  f.port.measure = async (account: any, model: any, opts: any) => {
    const answer = await inner(account, model, opts)
    return account.id === b && opts?.after === now ? { ...answer, readAt: now - 500 } : answer
  }
  await f.watcher.tick()
  assert.deepEqual(f.restarts, [], 'no last read from now: nothing moves')
  assert.equal((await f.watcher.snapshot()).status, 'waiting_for_room')
  f.port.measure = inner
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [b], 'control: a last read from now lands the switch')
})

test('B1 (r4): a read that lands during the look counts only while it is young (it began before a sleep)', async (t) => {
  const f = fixture(t)
  const a = await f.add('A'),
    b = await f.add('B')
  f.sign(a, 1, 1, 1) // B is signed out when its read starts
  f.row.accountId = a
  await f.assign('limit', b, 41)
  await f.hitLimit(now - 1000)
  f.setNow(now + 1000)
  const inner = f.port.measure
  let slept = false
  f.port.measure = async (account: any, model: any, opts: any) => {
    const answer = await inner(account, model, opts)
    if (account.id === b && !slept) {
      slept = true
      f.setNow(now + 181_000) // the computer slept three minutes while the read was out
    }
    return answer
  }
  await f.watcher.tick()
  assert.notEqual((await f.watcher.snapshot()).status, 'needs_sign_in', 'a three minute old answer says nothing')
  assert.equal(readAccountRegistry(f.deps.home)!.targets['41'].rule?.accountId, b, 'the rule stays')
  f.sign(b, 1, 1, 1)
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [b], 'the next look reads afresh and moves')
})

test('M1 (r4): a second Switch at limit press never acts on the read the first one left, even one since the limit', { timeout: 15_000 }, async (t) => {
  const f = fixture(t)
  const a = await f.add('A'),
    b = await f.add('B')
  f.sign(a, 1, 1, 1) // B signed out
  f.row.accountId = a
  await f.assign('limit', b, 41)
  const L = now + 40_000 // its heartbeat 30 s before reads A signed in, after the setup's reads
  await f.hitLimit(L)
  f.setNow(L + 5000)
  await f.watcher.tick()
  assert.equal((await f.watcher.snapshot()).status, 'needs_sign_in', 'B was read signed out at the limit')
  // The owner signs B in and presses Switch at limit again; B's new read is slow.
  f.sign(b, 1, 1, 1)
  const held = heldReads(f, [b])
  f.setNow(L + 30_000)
  assert.equal(await returnsAtOnce(f.assign('limit', b, 41)), true)
  // The saved record, not snapshot(): a snapshot reads every login and would wait on B's held read.
  assert.notEqual(readAccountRegistry(f.deps.home)!.targets['41'].status, 'needs_sign_in', 'the signed out read is from before the press')
  assert.equal(readAccountRegistry(f.deps.home)!.targets['41'].rule?.accountId, b)
  assert.deepEqual(f.restarts, [])
  await held.land()
  held.open()
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [b])
})

test('M1 (r4): an Auto press never holds the job on a status read: what has not landed counts at the next look', { timeout: 15_000 }, async (t) => {
  const f = fixture(t)
  const a = await f.add('A'),
    b = await f.add('B')
  f.sign(a, 10, 10, 10)
  f.sign(b, 10, 10, 10)
  f.row.accountId = a
  const held = heldReads(f, [a, b])
  assert.equal(await returnsAtOnce(f.assign('auto', undefined, 41)), true, 'the press returns with its reads still out')
  assert.deepEqual(f.restarts, [])
  assert.equal(readAccountRegistry(f.deps.home)!.targets['41'].rule?.mode, 'auto')
  await held.land()
})

test('m7 (r4): at a second limit on another seat, a login on the FIRST limit\'s seat is another account: it moves', async (t) => {
  const f = fixture(t)
  const s1 = await f.add('S1'),
    s2 = await f.add('S2'),
    s3 = await f.add('S3')
  f.sign(s1, 1, 1, 1, accountToken('one'))
  f.sign(s2, 1, 1, 1, accountToken('two'))
  f.sign(s3, 1, 1, 1, accountToken('one'))
  f.row.accountId = s1
  await f.assign('limit', s2, 41)
  await f.hitLimit(now - 1000, null, now + 50_000) // limit 1 resets 50 s later
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [s2], 'limit 1 was on seat one')
  // Past that reset, on S2 (seat two), the agent hits a second limit. S3 is on seat one: another seat
  // than THIS limit's, with its room back.
  f.setNow(now + 120_000)
  await f.assign('limit', s3, 41)
  await f.hitLimit(now + 90_000)
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [s2, s3], 'the account kept for limit 1 does not stand in for limit 2')
})
