import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHelperAccounts } from '../lib/helper-accounts.mjs'

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
  const atLimit: boolean[] = []
  const holds = { count: 0 }
  const deps = {
    home,
    credentials,
    now: () => now,
    inventory: async () => [row],
    measure: async (account: any) => readings.get(account.id) ?? { signedIn: false, usage: null },
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
  const sign = (id: string, short: number, week: number, model: number) =>
    readings.set(id, { signedIn: true, usage: usage(short, week, model) })
  return {
    watcher,
    deps,
    job,
    add,
    assign,
    row,
    sign,
    readings,
    restarts,
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
  f.row.limit = limitAt(now - 60000)
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
  // C hits its Opus limit: C has no Opus room until the reset, B has the most week room left.
  f.row.limit = limitAt(now + 1, 'opus')
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [c, b])
  // B hits its session limit: only A is left with room for Opus.
  f.row.limit = limitAt(now + 2)
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [c, b, a])
  const limits = Object.fromEntries((await f.watcher.snapshot()).accounts.map((x: any) => [x.label, x.limits]))
  assert.deepEqual(limits.C, [{ model: 'opus', until: new Date(now + 4 * HOUR).toISOString() }])
  assert.deepEqual(limits.B, [{ model: null, until: new Date(now + 4 * HOUR).toISOString() }])
  // A hits its limit too: nothing has room, so Auto waits instead of switching back.
  f.row.limit = limitAt(now + 3)
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
  f.row.limit = limitAt(now - 1000)
  f.holds.count = 1
  await f.watcher.tick()
  assert.equal(f.restarts.length, 0)
  assert.equal((await agentOf(f)).status, 'waiting_for_turn')
  await f.watcher.tick()
  assert.deepEqual(f.restarts.map((r: any) => r.choice), [b])
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
  f.row.limit = limitAt(now + 5)
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
