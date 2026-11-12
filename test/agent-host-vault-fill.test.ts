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
import { loadOrCreateHostKey, pinAccountKey, testSecurity } from './helpers/vault-host.mjs'

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
  const state = signedState({ ownerId: OWNER, assistantId: AGENT, hostSeed, acct, people, items: [{ id: ITEM, website: ORIGIN, username: 'owner@example.com', password: 'made-up-secret-1' }], ...extra })
  const pins = new Map<string, string>()
  const ctx = {
    assistantId: AGENT, ownerUserId: OWNER, actingUserId: LEO, origin: ORIGIN, hostSeed,
    pinFor: (userId: string, key: string) => { if (!pins.has(userId)) pins.set(userId, key); if (pins.get(userId) !== key) throw Object.assign(new Error('x'), { code: 'vault_account_key_changed' }); return pins.get(userId)! },
  }
  const redeemed = { state, itemId: ITEM, devices: acct.devices, accountPublic: acct.accountPublic }
  return { acct, hostSeed, state, ctx, redeemed, pins }
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
  assert.equal(await code(openPersonFill({ state: forged, itemId: ITEM, devices: forger.devices, accountPublic: forger.accountPublic }, r.ctx)), 'vault_account_key_changed')
  const other = rig(people, { assistantId: 902 })
  assert.equal(await code(openPersonFill(other.redeemed, { ...other.ctx })), 'vault_state_other_agent')
})

test('a state of anyone but the owner or the person is refused before any key is pinned', async () => {
  const r = rig([{ userId: LEO, askMode: 'never', items: [{ itemId: ITEM, ask: false }] }])
  assert.equal(await code(openPersonFill(r.redeemed, { ...r.ctx, ownerUserId: 'user_someone_else' })), 'vault_state_not_the_owners')
  assert.equal(r.pins.size, 0)
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
  const phone = r.acct.addDevice()
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
  const revoked = r.acct.addDevice({ revokedAt: '2026-11-12T00:00:00.000Z' })
  assert.equal(await code(openPersonFill({ ...r.redeemed, devices: r.acct.devices, approval: approve(r.acct, revoked.id, fields) }, r.ctx)), 'vault_approval_unverified')
  const stranger = account(); const sd = stranger.addDevice()
  assert.equal(await code(openPersonFill({ ...r.redeemed, devices: [...r.acct.devices, sd], approval: approve(stranger, sd.id, fields) }, r.ctx)), 'vault_approval_unverified')
})

test('step 4: only the key wrapped to this host opens the value', async () => {
  const r = rig([{ userId: LEO, askMode: 'never', items: [{ itemId: ITEM, ask: false }] }])
  assert.equal(await code(openPersonFill(r.redeemed, { ...r.ctx, hostSeed: seed() })), 'vault_item_not_for_this_host')
})

test('section 6: a person\'s own login, in their own signed vault, never asks', async () => {
  const hostSeed = seed()
  const acct = account()
  const state = signedState({ ownerId: LEO, assistantId: AGENT, hostSeed, acct, items: [{ id: ITEM, website: ORIGIN, username: 'leo@example.com', password: 'leos-own' }] })
  const pins = new Map<string, string>()
  const ctx = { assistantId: AGENT, ownerUserId: OWNER, actingUserId: LEO, origin: ORIGIN, hostSeed, pinFor: (u: string, k: string) => { if (!pins.has(u)) pins.set(u, k); return pins.get(u)! } }
  const got = await openPersonFill({ state, itemId: ITEM, devices: acct.devices, accountPublic: acct.accountPublic }, ctx)
  assert.deepEqual({ ...got }, { username: 'leo@example.com', password: 'leos-own', own: true, asked: false })
  assert.deepEqual([...pins.keys()], [LEO], 'pinned under the person, never as the owner')
  assert.equal(await code(openPersonFill({ state, itemId: ITEM, devices: acct.devices, accountPublic: acct.accountPublic }, { ...ctx, actingUserId: 'user_other' })), 'vault_state_not_the_owners')
})

test('the account key pin: first use pins, the same key passes, another key is refused, in the owner only host file', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'acct-pin-')), 'vault')
  try {
    await loadOrCreateHostKey(dir, AGENT)
    assert.equal(await pinAccountKey(dir, OWNER, 'A'.repeat(43), undefined, testSecurity), 'A'.repeat(43))
    assert.equal(await pinAccountKey(dir, OWNER, 'A'.repeat(43), undefined, testSecurity), 'A'.repeat(43))
    await assert.rejects(pinAccountKey(dir, OWNER, 'B'.repeat(43), undefined, testSecurity), (e: any) => e.code === 'vault_account_key_changed')
    assert.equal(await pinAccountKey(dir, LEO, 'C'.repeat(43), undefined, testSecurity), 'C'.repeat(43))
    await assert.rejects(pinAccountKey(dir, 'bad id', 'C'.repeat(43), undefined, testSecurity))
    await assert.rejects(pinAccountKey(dir, OWNER, 'not a key!', undefined, testSecurity))
    const record = JSON.parse(readFileSync(join(dir, 'vault-host.json'), 'utf8'))
    assert.deepEqual(Object.keys(record.accountPins).sort(), [LEO, OWNER])
  } finally { rmSync(join(dir, '..'), { recursive: true, force: true }) }
})
