import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  const credentials = { pairingId: 23, machineId: 'machine-12345' }
  const readings = new Map<string, any>()
  const restarts: any[] = []
  const row = {
    assistantId: 41,
    pairingId: 13,
    userId: 'user_fixture',
    accountId: null as string | null,
    sessionId: randomUUID(),
    ready: true,
    limited: false,
    model: 'opus',
  }
  let returns = true
  const deps = {
    home,
    credentials,
    now: () => now,
    inventory: async () => [row],
    measure: async (account: any) => readings.get(account.id) ?? { signedIn: false, usage: null },
    restart: async (r: any, choice: string | null) => {
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
  await f.assign('now', id, 41)
  assert.notEqual((await f.watcher.snapshot()).statusRpcId, firstPress)
  assert.equal(f.restarts.length, 0)
  f.row.ready = true
  await f.watcher.tick()
  assert.deepEqual(f.restarts, [{ id: 41, choice: id, sessionId: f.row.sessionId }])
  assert.equal((await f.watcher.snapshot()).status, 'back_online')
})

test('a quota limit never authorizes a change of identity', async (t) => {
  const f = fixture(t)
  const a = await f.add('Primary'),
    b = await f.add('Reserve')
  f.sign(a, 10, 20, 30)
  f.sign(b, 5, 10, 20)
  f.row.accountId = a
  await assert.rejects(f.assign('limit', b, 41))
  f.sign(a, 10, 20, 100)
  const restored = createHelperAccounts(f.deps)
  await restored.tick()
  assert.equal(f.row.accountId, a)
  assert.equal(f.restarts.length, 0)
})

test('fresh capacity is reported, stale readings are withheld and Auto cannot start another login', async (t) => {
  const f = fixture(t)
  const a = await f.add('A'),
    b = await f.add('B')
  f.sign(a, 10, 14, 74)
  f.sign(b, 12, 36, 32)
  await assert.rejects(f.assign('auto', undefined, 41))
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
  const rebound = createHelperAccounts({ ...f.deps, credentials: { machineId: 'machine-12345', pairingId: 88 } })
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
