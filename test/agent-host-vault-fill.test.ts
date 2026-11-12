/**
 * The agent host's checks before it fills a login on a person's turn
 * (lib/agent-host-vault-fill.mjs; BGOS plan 2026-11-13 sections 3, 4.3, 5, 6),
 * on real signatures and real sealing (test/helpers/vault-state-fixture.mjs):
 *
 *   1. the state verifies against the account key pinned for its owner, and is
 *      this agent's; a key that differs from the pin, a forged signature or a
 *      state of another agent is refused;
 *   2. the person and the item must be in what the owner signed;
 *   3. a fill that had to ask needs the owner's signed yes over this exact
 *      fill, from a certified, unrevoked device;
 *   4. the value opens only with the key wrapped to THIS host.
 * Plus: the account key pin is trust on first use, kept in the vault host
 * file, and a later different key is refused.
 *
 * No em or en dashes in this file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fillNeedsAsk, openPersonFill } from '../lib/agent-host-vault-fill.mjs'
import { account, approve, signedState } from './helpers/vault-state-fixture.mjs'
import { commitFillTrust, loadOrCreateHostKey, readFillTrust, testSecurity } from './helpers/vault-host.mjs'

const AGENT = 901
const OWNER = 'user_owner1'
const LEO = 'user_leo1'
const ORIGIN = 'https://bank.example.com'
const ITEM = '2f1c3a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const seed = () => generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')

function rig(people: any[] | undefined, extra: Record<string, unknown> = {}) {
  const hostSeed = seed()
  const acct = account()
  acct.addDevice()
  const phone = acct.addDevice()
  const state = signedState({ ownerId: OWNER, assistantId: AGENT, hostSeed, acct, people, items: [{ id: ITEM, website: ORIGIN, username: 'owner@example.com', password: 'made-up-secret-1' }], ...extra })
  const trust = memoryTrust()
  const ctx = { assistantId: AGENT, ownerUserId: OWNER, actingUserId: LEO, origin: ORIGIN, hostSeed, trust, now: () => Date.parse('2026-11-13T10:00:00.000Z') }
  const redeemed = { state, itemId: ITEM, devices: acct.devices, accountPublic: acct.accountPublic }
  return { acct, phone, hostSeed, state, ctx, redeemed, trust, pins: trust.pins }
}

/** This machine's fill trust, in memory: the account key pins, the revision floors, the approvals used. */
function memoryTrust() {
  const pins = new Map<string, string>()
  const floors = new Map<string, number>()
  const used = new Set<string>()
  return {
    pins, floors, used,
    read: async (userId: string) => ({ accountPublic: pins.get(userId) ?? null, revisionFloor: floors.get(userId) ?? 0, approvalUsed: (id: string) => used.has(id) }),
    commit: async (c: { userId: string; accountPublic: string; revision: number; requestId?: string }) => {
      if (pins.has(c.userId) && pins.get(c.userId) !== c.accountPublic) throw Object.assign(new Error('x'), { code: 'vault_account_key_changed' })
      pins.set(c.userId, c.accountPublic)
      floors.set(c.userId, Math.max(floors.get(c.userId) ?? 0, c.revision))
      if (c.requestId) used.add(c.requestId)
    },
  }
}

const code = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e: any) { return e.code ?? e.message } }

test('a never-ask fill opens the login for a listed person, and only for them', async () => {
  const r = rig([{ userId: LEO, askMode: 'never', items: [{ itemId: ITEM, ask: false }] }])
  const got = await openPersonFill(r.redeemed, r.ctx)
  assert.deepEqual({ ...got }, { username: 'owner@example.com', password: 'made-up-secret-1', own: false, asked: false })
  assert.equal(await code(openPersonFill(r.redeemed, { ...r.ctx, actingUserId: 'user_other' })), 'vault_not_shared_with_person')
})

test('an all-logins entry (itemId null) lists the item', async () => {
  const r = rig([{ userId: LEO, askMode: 'never', items: [{ itemId: null, ask: false }] }])
  assert.equal(await code(openPersonFill(r.redeemed, r.ctx)), 'ok')
})

test('no people in the signed state, or the item not listed: refused', async () => {
  assert.equal(await code(openPersonFill(rig(undefined).redeemed, rig(undefined).ctx)), 'vault_not_shared_with_person')
  const r = rig([{ userId: LEO, askMode: 'never', items: [{ itemId: 'another-item', ask: false }] }])
  assert.equal(await code(openPersonFill(r.redeemed, r.ctx)), 'vault_not_shared_with_person')
})

test('step 1: a forged signature, another account key or another agent is refused', async () => {
  const people = [{ userId: LEO, askMode: 'never', items: [{ itemId: ITEM, ask: false }] }]
  const r = rig(people)
  // The server turns Always ask into Never ask, or adds a person: the signature breaks.
  const tampered = { ...r.redeemed, state: { ...r.state, people: [{ userId: LEO, askMode: 'never', items: [{ itemId: null, ask: false }] }] } }
  assert.equal(await code(openPersonFill(tampered, r.ctx)), 'vault_state_unverified')
  // A whole forged state under another account key, after this host pinned the real one.
  assert.equal(await code(openPersonFill(r.redeemed, r.ctx)), 'ok')
  const forger = account(); forger.addDevice()
  const forged = signedState({ ownerId: OWNER, assistantId: AGENT, hostSeed: r.hostSeed, acct: forger, people, items: [{ id: ITEM, website: ORIGIN, username: 'x', password: 'y' }] })
  assert.equal(await code(openPersonFill({ state: forged, itemId: ITEM, devices: forger.devices, accountPublic: forger.accountPublic }, r.ctx)), 'vault_state_unverified', 'not the pinned key')
  const other = rig(people, { assistantId: 902 })
  assert.equal(await code(openPersonFill(other.redeemed, { ...other.ctx })), 'vault_state_other_agent')
})

test('a state of anyone but the owner or the person is refused before any key is pinned', async () => {
  const r = rig([{ userId: LEO, askMode: 'never', items: [{ itemId: ITEM, ask: false }] }])
  assert.equal(await code(openPersonFill(r.redeemed, { ...r.ctx, ownerUserId: 'user_someone_else' })), 'vault_state_not_the_owners')
  assert.equal(r.pins.size, 0)
  // Nothing is pinned until every check passed (review finding 3).
  const asks = rig([{ userId: LEO, askMode: 'always', items: [{ itemId: ITEM, ask: true }] }])
  assert.equal(await code(openPersonFill(asks.redeemed, asks.ctx)), 'vault_approval_missing')
  assert.equal(asks.pins.size, 0, 'a refused fill pins nothing')
  // And the owner is never filled for as a person.
  assert.equal(await code(openPersonFill(r.redeemed, { ...r.ctx, actingUserId: OWNER })), 'vault_owner_turn')
})

test('the item must be a plain login for the exact origin, in an enabled vault', async () => {
  const people = [{ userId: LEO, askMode: 'never', items: [{ itemId: null, ask: false }] }]
  const r = rig(people)
  assert.equal(await code(openPersonFill(r.redeemed, { ...r.ctx, origin: 'https://evil.example.com' })), 'vault_origin_mismatch')
  const op = rig(people, { items: [{ id: ITEM, website: ORIGIN, username: 'u', password: 'op://x/y', source: '1password' }] })
  assert.equal(await code(openPersonFill(op.redeemed, op.ctx)), 'vault_item_unavailable')
  const key = rig(people, { items: [{ id: ITEM, website: ORIGIN, username: 'u', password: 'k', kind: 'api_key' }] })
  assert.equal(await code(openPersonFill(key.redeemed, key.ctx)), 'vault_item_unavailable')
  const off = rig(people, { enabled: false })
  assert.equal(await code(openPersonFill(off.redeemed, off.ctx)), 'vault_disabled')
})

test('section 3: whether a fill waits', () => {
  assert.equal(fillNeedsAsk({ askMode: 'never', items: [{ itemId: ITEM, ask: true }] }, ITEM), false)
  assert.equal(fillNeedsAsk({ askMode: 'always', items: [{ itemId: ITEM, ask: false }] }, ITEM), true)
  assert.equal(fillNeedsAsk({ askMode: 'per', items: [{ itemId: ITEM, ask: false }] }, ITEM), false)
  assert.equal(fillNeedsAsk({ askMode: 'per', items: [{ itemId: ITEM, ask: true }] }, ITEM), true)
  assert.equal(fillNeedsAsk({ askMode: 'per', items: [{ itemId: null, ask: false }] }, ITEM), false)
  assert.equal(fillNeedsAsk({ askMode: 'per', items: [{ itemId: ITEM, ask: true }, { itemId: null, ask: false }] }, ITEM), true, 'the entry for the item wins')
  assert.equal(fillNeedsAsk({ askMode: 'per', items: [] }, ITEM), true, 'else ask')
})

test('step 3: a fill that had to ask needs the owner signed yes over this exact fill', async () => {
  const r = rig([{ userId: LEO, askMode: 'always', items: [{ itemId: ITEM, ask: true }] }])
  assert.equal(await code(openPersonFill(r.redeemed, r.ctx)), 'vault_approval_missing')
  const fields = { requestId: 'req-1', assistantId: AGENT, actingUserId: LEO, itemId: ITEM, origin: ORIGIN, revision: r.state.revision, expiresAt: '2026-11-13T10:10:00.000Z' }
  const phone = r.phone
  const yes = approve(r.acct, phone.id, fields)
  const got = await openPersonFill({ ...r.redeemed, approval: yes }, r.ctx)
  assert.equal(got.asked, true)
  assert.equal(got.password, 'made-up-secret-1')
  // Over another person, item, origin or revision: refused.
  for (const changed of [{ actingUserId: 'user_x' }, { origin: 'https://other.example.com' }, { revision: 8 }, { itemId: 'other' }]) {
    const wrong = approve(r.acct, phone.id, { ...fields, ...changed })
    assert.equal(await code(openPersonFill({ ...r.redeemed, approval: wrong }, r.ctx)), 'vault_approval_unverified', JSON.stringify(changed))
  }
  // approve false, a revoked device, a device not certified by the pinned key.
  assert.equal(await code(openPersonFill({ ...r.redeemed, approval: { ...yes, approve: false } }, r.ctx)), 'vault_approval_missing')
  // A device the owner's signed list does not hold (added later, or the server's word only).
  const later = r.acct.addDevice()
  assert.equal(await code(openPersonFill({ ...r.redeemed, devices: r.acct.devices, approval: approve(r.acct, later.id, { ...fields, requestId: 'req-later' }) }, r.ctx)), 'vault_approval_unverified')
  const stranger = account(); const sd = stranger.addDevice()
  assert.equal(await code(openPersonFill({ ...r.redeemed, devices: [...r.acct.devices, sd], approval: approve(stranger, sd.id, { ...fields, requestId: 'req-stranger' }) }, r.ctx)), 'vault_approval_unverified')
})

test('review finding 1: an approval is used once and only before it expires', async () => {
  const r = rig([{ userId: LEO, askMode: 'always', items: [{ itemId: ITEM, ask: true }] }])
  const fields = { requestId: 'req-9', assistantId: AGENT, actingUserId: LEO, itemId: ITEM, origin: ORIGIN, revision: r.state.revision, expiresAt: '2026-11-13T10:10:00.000Z' }
  const yes = approve(r.acct, r.phone.id, fields)
  assert.equal(await code(openPersonFill({ ...r.redeemed, approval: yes }, r.ctx)), 'ok')
  assert.equal(await code(openPersonFill({ ...r.redeemed, approval: yes }, r.ctx)), 'vault_approval_used', 'a replayed approval')
  const old = approve(r.acct, r.phone.id, { ...fields, requestId: 'req-10', expiresAt: '2026-11-13T09:59:00.000Z' })
  assert.equal(await code(openPersonFill({ ...r.redeemed, approval: old }, r.ctx)), 'vault_approval_expired')
  const odd = approve(r.acct, r.phone.id, { ...fields, requestId: 'req-11', expiresAt: 'tomorrow' })
  assert.equal(await code(openPersonFill({ ...r.redeemed, approval: odd }, r.ctx)), 'vault_approval_expired')
  const ms = approve(r.acct, r.phone.id, { ...fields, requestId: 'req-12', expiresAt: Date.parse('2026-11-13T10:05:00.000Z') })
  assert.equal(await code(openPersonFill({ ...r.redeemed, approval: ms }, r.ctx)), 'ok', 'a number of milliseconds is read too')
})

test('review finding 2: an older signed state is refused (the revision floor), and a retired device cannot approve', async () => {
  const people = [{ userId: LEO, askMode: 'never', items: [{ itemId: ITEM, ask: false }] }]
  const r = rig(people, { revision: 9 })
  assert.equal(await code(openPersonFill(r.redeemed, r.ctx)), 'ok')
  assert.equal(r.trust.floors.get(OWNER), 9)
  // The same owner key signed an older state (before Always ask): the server replays it.
  const older = signedState({ ownerId: OWNER, assistantId: AGENT, hostSeed: r.hostSeed, acct: r.acct, people, revision: 8, items: [{ id: ITEM, website: ORIGIN, username: 'u', password: 'p' }] })
  assert.equal(await code(openPersonFill({ ...r.redeemed, state: older }, r.ctx)), 'vault_state_rolled_back')
  const retired = rig([{ userId: LEO, askMode: 'always', items: [{ itemId: ITEM, ask: true }] }])
  const again = signedState({ ownerId: OWNER, assistantId: AGENT, hostSeed: retired.hostSeed, acct: retired.acct, people: [{ userId: LEO, askMode: 'always', items: [{ itemId: ITEM, ask: true }] }], retiredDeviceIds: [retired.phone.id], items: [{ id: ITEM, website: ORIGIN, username: 'u', password: 'p' }] })
  const fields = { requestId: 'req-r', assistantId: AGENT, actingUserId: LEO, itemId: ITEM, origin: ORIGIN, revision: again.revision, expiresAt: '2026-11-13T10:10:00.000Z' }
  assert.equal(await code(openPersonFill({ ...retired.redeemed, state: again, approval: approve(retired.acct, retired.phone.id, fields) }, retired.ctx)), 'vault_approval_unverified')
})

test('step 4: only the key wrapped to this host opens the value', async () => {
  const r = rig([{ userId: LEO, askMode: 'never', items: [{ itemId: ITEM, ask: false }] }])
  assert.equal(await code(openPersonFill(r.redeemed, { ...r.ctx, hostSeed: seed() })), 'vault_item_not_for_this_host')
})

test('section 6: a person\'s own login, in their own signed vault, never asks', async () => {
  const hostSeed = seed()
  const acct = account()
  const state = signedState({ ownerId: LEO, assistantId: AGENT, hostSeed, acct, items: [{ id: ITEM, website: ORIGIN, username: 'leo@example.com', password: 'leos-own' }] })
  const trust = memoryTrust()
  const pins = trust.pins
  const ctx = { assistantId: AGENT, ownerUserId: OWNER, actingUserId: LEO, origin: ORIGIN, hostSeed, trust, now: () => Date.now() }
  const got = await openPersonFill({ state, itemId: ITEM, devices: acct.devices, accountPublic: acct.accountPublic }, ctx)
  assert.deepEqual({ ...got }, { username: 'leo@example.com', password: 'leos-own', own: true, asked: false })
  assert.deepEqual([...pins.keys()], [LEO], 'pinned under the person, never as the owner')
  assert.equal(await code(openPersonFill({ state, itemId: ITEM, devices: acct.devices, accountPublic: acct.accountPublic }, { ...ctx, actingUserId: 'user_other' })), 'vault_state_not_the_owners')
})

test('the fill trust file: first use pins, the same key passes, another key is refused; floors only rise; an approval id is used once', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'acct-pin-')), 'vault')
  try {
    await loadOrCreateHostKey(dir, AGENT)
    const A = 'A'.repeat(43)
    assert.deepEqual(await readFillTrustPlain(dir, OWNER), { accountPublic: null, revisionFloor: 0, used: false })
    await commitFillTrust(dir, { userId: OWNER, accountPublic: A, revision: 7, requestId: 'req-1' }, undefined, testSecurity)
    assert.deepEqual(await readFillTrustPlain(dir, OWNER), { accountPublic: A, revisionFloor: 7, used: true })
    await commitFillTrust(dir, { userId: OWNER, accountPublic: A, revision: 5 }, undefined, testSecurity)
    assert.equal((await readFillTrustPlain(dir, OWNER)).revisionFloor, 7, 'never lowered')
    await assert.rejects(commitFillTrust(dir, { userId: OWNER, accountPublic: 'B'.repeat(43), revision: 8 }, undefined, testSecurity), (e: any) => e.code === 'vault_account_key_changed')
    await assert.rejects(commitFillTrust(dir, { userId: OWNER, accountPublic: A, revision: 8, requestId: 'req-1' }, undefined, testSecurity), (e: any) => e.code === 'vault_approval_used')
    await commitFillTrust(dir, { userId: LEO, accountPublic: 'C'.repeat(43), revision: 1 }, undefined, testSecurity)
    await assert.rejects(commitFillTrust(dir, { userId: 'bad id', accountPublic: A, revision: 1 }, undefined, testSecurity))
    await assert.rejects(commitFillTrust(dir, { userId: OWNER, accountPublic: 'not a key!', revision: 1 }, undefined, testSecurity))
    const record = JSON.parse(readFileSync(join(dir, 'vault-host.json'), 'utf8'))
    assert.deepEqual(Object.keys(record.fillTrust).sort(), [LEO, OWNER])
  } finally { rmSync(join(dir, '..'), { recursive: true, force: true }) }
})

async function readFillTrustPlain(dir: string, userId: string) {
  const t = await readFillTrust(dir, userId, undefined, testSecurity)
  return { accountPublic: t.accountPublic, revisionFloor: t.revisionFloor, used: t.approvalUsed('req-1') }
}
