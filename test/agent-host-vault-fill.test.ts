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
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HOST_FILL_SENTENCES, canonical, fillNeedsAsk, openPersonFill } from '../lib/agent-host-vault-fill.mjs'
import { account, approve, signedState } from './helpers/vault-state-fixture.mjs'
import { anchorOwnerAccount, commitFillTrust, loadOrCreateHostKey, ownerAccountCode, ownerAccountFromDoorAnswer, readFillTrust, readOwnerAnchor, testSecurity } from './helpers/vault-host.mjs'

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
  // The owner's account key, anchored on this host by a channel the server cannot forge (H2).
  const trust = memoryTrust({ ownerId: OWNER, accountPublic: acct.accountPublic })
  const ctx = { assistantId: AGENT, ownerUserId: OWNER, actingUserId: LEO, origin: ORIGIN, hostSeed, trust, now: () => Date.parse('2026-11-13T10:00:00.000Z') }
  const redeemed = { state, itemId: ITEM, devices: acct.devices, accountPublic: acct.accountPublic }
  return { acct, phone, hostSeed, state, ctx, redeemed, trust, pins: trust.pins }
}

/** This machine's fill trust, in memory: the account key pins, the revision floors, the approvals used. */
function memoryTrust(anchor: { ownerId: string; accountPublic: string } | null = null) {
  const pins = new Map<string, string>()
  const floors = new Map<string, number>()
  const used = new Set<string>()
  return {
    pins, floors, used,
    ownerAnchor: async () => anchor,
    read: async (userId: string) => ({ accountPublic: pins.get(userId) ?? null, revisionFloor: floors.get(userId) ?? 0, approvalUsed: (id: string) => used.has(id) }),
    commit: async (c: { userId: string; accountPublic: string; revision: number; requestId?: string; approvalUntil?: number }) => {
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
  const none = rig(undefined)
  assert.equal(await code(openPersonFill(none.redeemed, none.ctx)), 'vault_not_shared_with_person')
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
  assert.equal(await code(openPersonFill({ state: forged, itemId: ITEM, devices: forger.devices, accountPublic: forger.accountPublic }, r.ctx)), 'vault_owner_account_mismatch', 'not the anchored key')
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
  const old = approve(r.acct, r.phone.id, { ...fields, requestId: 'req-10', expiresAt: '2026-11-13T09:58:50.000Z' })
  assert.equal(await code(openPersonFill({ ...r.redeemed, approval: old }, r.ctx)), 'vault_approval_expired', 'past its expiry and the ticket life after it')
  // Answered in the request's last seconds: the ticket it made lives 60 s more, and is still good.
  const late = approve(r.acct, r.phone.id, { ...fields, requestId: 'req-13', expiresAt: '2026-11-13T09:59:30.000Z' })
  assert.equal(await code(openPersonFill({ ...r.redeemed, approval: late }, r.ctx)), 'ok')
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

/**
 * Section 6, after the review: a person's own logins are NOT trusted on first
 * use. The redeem of an own login also carries the owner's signed vault
 * (`ownerVault: {state, devices, accountPublic}`), verified against the
 * owner's anchored key; its `people` entry for the person carries the
 * person's account key as the owner's device pinned it (`accountPublic`).
 * The person's own state must verify under exactly that key. Missing or
 * different: refused, and never pinned from the server.
 */
function ownRig(personKeyInOwnerState: 'match' | 'missing' | 'other') {
  const hostSeed = seed()
  const owner = account(); owner.addDevice()
  const leo = account(); leo.addDevice()
  const stranger = account(); stranger.addDevice()
  const personKey = personKeyInOwnerState === 'match' ? leo.accountPublic : personKeyInOwnerState === 'other' ? stranger.accountPublic : undefined
  const ownerState = signedState({ ownerId: OWNER, assistantId: AGENT, hostSeed, acct: owner,
    people: [{ userId: LEO, askMode: 'never', items: [{ itemId: null, ask: false }], ...(personKey ? { accountPublic: personKey } : {}) }],
    items: [{ id: '9f1c3a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b', website: 'https://other.example.com', username: 'o', password: 'owner-secret' }] })
  const state = signedState({ ownerId: LEO, assistantId: AGENT, hostSeed, acct: leo, items: [{ id: ITEM, website: ORIGIN, username: 'leo@example.com', password: 'leos-own' }] })
  const trust = memoryTrust({ ownerId: OWNER, accountPublic: owner.accountPublic })
  const ctx = { assistantId: AGENT, ownerUserId: OWNER, actingUserId: LEO, origin: ORIGIN, hostSeed, trust, now: () => Date.now() }
  const redeemed = { state, itemId: ITEM, devices: leo.devices, accountPublic: leo.accountPublic, ownerVault: { state: ownerState, devices: owner.devices, accountPublic: owner.accountPublic } }
  return { ctx, trust, redeemed, owner, leo, stranger, ownerState, hostSeed }
}

test('section 6: a person\'s own login opens only under the key the owner\'s signed, anchored state names for them', async () => {
  const r = ownRig('match')
  const got = await openPersonFill(r.redeemed, r.ctx)
  assert.deepEqual({ ...got }, { username: 'leo@example.com', password: 'leos-own', own: true, asked: false })
  assert.equal(await code(openPersonFill(r.redeemed, { ...r.ctx, actingUserId: 'user_other' })), 'vault_state_not_the_owners')
  // The server's own key for the person, without the owner's word: refused, never pinned.
  const { ownerVault: _gone, ...bare } = r.redeemed
  const fresh = ownRig('match')
  assert.equal(await code(openPersonFill({ ...bare }, fresh.ctx)), 'vault_own_logins_unconfirmed')
  assert.equal(fresh.trust.pins.size, 0)
})

test('section 6: the owner\'s state names no key for the person, or another one: refused with the agreed sentence', async () => {
  for (const which of ['missing', 'other'] as const) {
    const r = ownRig(which)
    assert.equal(await code(openPersonFill(r.redeemed, r.ctx)), 'vault_own_logins_unconfirmed', which)
    assert.equal(r.trust.pins.size, 0, which)
  }
  assert.equal(HOST_FILL_SENTENCES.vault_own_logins_unconfirmed, 'Your own logins for this agent can be used once the owner opens the vault for you again.')
})

test('section 6: the owner\'s vault that names the person must itself verify under the anchored owner key', async () => {
  const r = ownRig('match')
  // A server signs an owner state of its own that names the server's key for Leo.
  const evil = account(); evil.addDevice()
  const forgedOwner = signedState({ ownerId: OWNER, assistantId: AGENT, hostSeed: r.hostSeed, acct: evil,
    people: [{ userId: LEO, askMode: 'never', items: [{ itemId: null, ask: false }], accountPublic: r.stranger.accountPublic }], items: [] })
  const forgedOwn = signedState({ ownerId: LEO, assistantId: AGENT, hostSeed: r.hostSeed, acct: r.stranger, items: [{ id: ITEM, website: ORIGIN, username: 'x', password: 'server-chosen' }] })
  const answer = { state: forgedOwn, itemId: ITEM, devices: r.stranger.devices, accountPublic: r.stranger.accountPublic, ownerVault: { state: forgedOwner, devices: evil.devices, accountPublic: evil.accountPublic } }
  assert.equal(await code(openPersonFill(answer, r.ctx)), 'vault_owner_account_mismatch')
  // No anchored owner key at all: nothing of the person's own either.
  const unanchored = { ...r.ctx, trust: memoryTrust(null) }
  assert.equal(await code(openPersonFill(r.redeemed, unanchored)), 'vault_owner_account_unconfirmed')
})

test('the fill trust file: first use pins, the same key passes, another key is refused; floors only rise; an approval id is used once', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'acct-pin-')), 'vault')
  try {
    await loadOrCreateHostKey(dir, AGENT)
    const A = 'A'.repeat(43)
    assert.deepEqual(await readFillTrustPlain(dir, OWNER), { accountPublic: null, revisionFloor: 0, used: false })
    await commitFillTrust(dir, { userId: OWNER, accountPublic: A, revision: 7, requestId: 'req-1', approvalUntil: Date.now() + 60_000 }, undefined, testSecurity)
    assert.deepEqual(await readFillTrustPlain(dir, OWNER), { accountPublic: A, revisionFloor: 7, used: true })
    await commitFillTrust(dir, { userId: OWNER, accountPublic: A, revision: 5 }, undefined, testSecurity)
    assert.equal((await readFillTrustPlain(dir, OWNER)).revisionFloor, 7, 'never lowered')
    await assert.rejects(commitFillTrust(dir, { userId: OWNER, accountPublic: 'B'.repeat(43), revision: 8 }, undefined, testSecurity), (e: any) => e.code === 'vault_account_key_changed')
    await assert.rejects(commitFillTrust(dir, { userId: OWNER, accountPublic: A, revision: 8, requestId: 'req-1', approvalUntil: Date.now() + 60_000 }, undefined, testSecurity), (e: any) => e.code === 'vault_approval_used')
    // A used approval is kept until it could no longer be accepted anyway, then let go.
    await commitFillTrust(dir, { userId: OWNER, accountPublic: A, revision: 8, requestId: 'req-old', approvalUntil: Date.now() - 1 }, undefined, testSecurity)
    const kept = JSON.parse(readFileSync(join(dir, 'vault-host.json'), 'utf8')).fillTrust[OWNER].usedApprovals.map((u: any) => u.requestId)
    assert.deepEqual(kept, ['req-1'], 'the expired one is not kept')
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

// ── H2: the owner's account key must be anchored on this host ──────────────

/**
 * The cold review's proof (zz-review-tofu): on a first fill a server signs the
 * owner's REAL sealed items under its own account key, with its own website
 * and its own person. Trust on first use opened the real password for it and
 * pinned its key. Now the owner's key must be anchored on this host by a
 * channel the server cannot forge (the desktop's loopback door, or the
 * terminal pin with the account code); a server key is refused.
 */
test('H2: a server that re-signs the real ciphertext under its own key gets nothing, anchored or not', async () => {
  const hostSeed = seed()
  const owner = account(); owner.addDevice()
  const real = signedState({ ownerId: OWNER, assistantId: AGENT, hostSeed, acct: owner,
    people: [{ userId: LEO, askMode: 'always', items: [{ itemId: ITEM, ask: true }] }],
    items: [{ id: ITEM, website: ORIGIN, username: 'owner@example.com', password: 'REAL-OWNER-SECRET' }] })
  const evil = account(); const dev = evil.addDevice()
  const { signature: _sig, ...body } = real as any
  const forged: any = { ...body, signerDeviceId: dev.id, devices: [{ deviceId: dev.id, key: {} }],
    items: body.items.map((i: any) => ({ ...i, website: 'https://attacker.example' })),
    people: [{ userId: 'user_mallory', askMode: 'never', items: [{ itemId: null, ask: false }] }] }
  forged.signature = Buffer.from(sign(null, Buffer.from('hoai-vault-state-v2\n' + canonical(forged)), evil.keys.get(dev.id))).toString('base64url')
  const answer = { state: forged, itemId: ITEM, devices: evil.devices, accountPublic: evil.accountPublic }
  const ctx = { assistantId: AGENT, ownerUserId: OWNER, actingUserId: 'user_mallory', origin: 'https://attacker.example', hostSeed, now: () => Date.now() }
  // No anchor on this host: refused, and nothing pinned.
  const bare = memoryTrust(null)
  assert.equal(await code(openPersonFill(answer, { ...ctx, trust: bare })), 'vault_owner_account_unconfirmed')
  assert.equal(bare.pins.size, 0)
  // The real owner's key anchored: the server's key is refused, never re-pinned.
  const anchored = memoryTrust({ ownerId: OWNER, accountPublic: owner.accountPublic })
  assert.equal(await code(openPersonFill(answer, { ...ctx, trust: anchored })), 'vault_owner_account_mismatch')
  assert.equal(anchored.pins.size, 0)
  // An anchor for another owner is no anchor for this one.
  const other = memoryTrust({ ownerId: 'user_someone', accountPublic: owner.accountPublic })
  assert.equal(await code(openPersonFill({ state: real, itemId: ITEM, devices: owner.devices, accountPublic: owner.accountPublic }, { ...ctx, actingUserId: LEO, origin: ORIGIN, trust: other })), 'vault_owner_account_unconfirmed')
})

test('H2: the refusal sentence for an unanchored owner key is the agreed one', () => {
  assert.equal(HOST_FILL_SENTENCES.vault_owner_account_unconfirmed, 'This computer has not confirmed your HOAI account yet. Open this agent\'s browser in HOAI on this computer, or pin this computer again.')
})

test('M1: a state signed by a retired or revoked device is refused', async () => {
  const people = [{ userId: LEO, askMode: 'never', items: [{ itemId: ITEM, ask: false }] }]
  const r = rig(people)
  const signer = r.acct.devices[0]!
  const retired = signedState({ ownerId: OWNER, assistantId: AGENT, hostSeed: r.hostSeed, acct: r.acct, people, retiredDeviceIds: [signer.id], items: [{ id: ITEM, website: ORIGIN, username: 'u', password: 'p' }] })
  assert.equal(await code(openPersonFill({ ...r.redeemed, state: retired }, r.ctx)), 'vault_state_unverified')
  const revokedDevices = r.acct.devices.map((d: any) => (d.id === signer.id ? { ...d, revokedAt: '2026-11-12T00:00:00.000Z' } : d))
  assert.equal(await code(openPersonFill({ ...r.redeemed, devices: revokedDevices }, r.ctx)), 'vault_state_unverified')
})

test('M4: the redeemed login must be the one the lane asked for', async () => {
  const r = rig([{ userId: LEO, askMode: 'never', items: [{ itemId: null, ask: false }] }])
  assert.equal(await code(openPersonFill(r.redeemed, { ...r.ctx, itemId: '3f1c3a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b' })), 'vault_item_mismatch')
  assert.equal(await code(openPersonFill(r.redeemed, { ...r.ctx, itemId: ITEM })), 'ok')
})

test('H2: the owner account anchor in the host file: set once, the same again passes, another key is refused and never re-pinned; the account code', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'anchor-')), 'vault')
  try {
    await loadOrCreateHostKey(dir, AGENT)
    const A = 'A'.repeat(43)
    assert.equal(await readOwnerAnchor(dir, undefined, testSecurity), null)
    await anchorOwnerAccount(dir, { ownerId: OWNER, accountPublic: A, via: 'terminal' }, undefined, testSecurity)
    assert.deepEqual(await readOwnerAnchor(dir, undefined, testSecurity), { ownerId: OWNER, accountPublic: A, via: 'terminal' })
    await anchorOwnerAccount(dir, { ownerId: OWNER, accountPublic: A, via: 'desktop_door' }, undefined, testSecurity)
    await assert.rejects(anchorOwnerAccount(dir, { ownerId: OWNER, accountPublic: 'B'.repeat(43), via: 'terminal' }, undefined, testSecurity), (e: any) => e.code === 'vault_owner_account_changed')
    await assert.rejects(anchorOwnerAccount(dir, { ownerId: 'user_other', accountPublic: A, via: 'terminal' }, undefined, testSecurity), (e: any) => e.code === 'vault_owner_account_changed')
    assert.equal((await readOwnerAnchor(dir, undefined, testSecurity))!.accountPublic, A, 'unchanged')
    await assert.rejects(anchorOwnerAccount(dir, { ownerId: OWNER, accountPublic: 'short', via: 'terminal' }, undefined, testSecurity))
    // The code HOAI's pin screen shows from the owner's own key.
    const hex = createHash('sha256').update(JSON.stringify(['hoai-owner-account-v1', OWNER, A])).digest('hex').slice(0, 20)
    assert.equal(ownerAccountCode(OWNER, A), hex.match(/.{4}/g)!.join(' '))
    assert.match(ownerAccountCode(OWNER, A), /^[0-9a-f]{4}( [0-9a-f]{4}){4}$/)
  } finally { rmSync(join(dir, '..'), { recursive: true, force: true }) }
})

test('H2: the desktop door answer carries ownerAccount; only a well formed one for this owner is read', () => {
  const A = 'A'.repeat(43)
  assert.deepEqual(ownerAccountFromDoorAnswer({ accepted: true, ownerAccount: { ownerId: OWNER, accountPublic: A } }, OWNER), { ownerId: OWNER, accountPublic: A })
  assert.equal(ownerAccountFromDoorAnswer({ accepted: true }, OWNER), null)
  assert.equal(ownerAccountFromDoorAnswer({ accepted: true, ownerAccount: { ownerId: 'user_x', accountPublic: A } }, OWNER), null)
  assert.equal(ownerAccountFromDoorAnswer({ accepted: true, ownerAccount: { ownerId: OWNER, accountPublic: 'nope' } }, OWNER), null)
  assert.equal(ownerAccountFromDoorAnswer({ accepted: false, ownerAccount: { ownerId: OWNER, accountPublic: A } }, OWNER), null)
})

test('M5: commits to the fill trust at the same moment are not lost', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'trust-lock-')), 'vault')
  try {
    await loadOrCreateHostKey(dir, AGENT)
    const A = 'A'.repeat(43)
    const until = Date.now() + 60_000
    await Promise.all(Array.from({ length: 6 }, (_, i) => commitFillTrust(dir, { userId: OWNER, accountPublic: A, revision: 1, requestId: `req-${i}`, approvalUntil: until }, undefined, testSecurity)))
    const t = await readFillTrust(dir, OWNER, undefined, testSecurity)
    for (let i = 0; i < 6; i++) assert.equal(t.approvalUsed(`req-${i}`), true, `req-${i}`)
    // The same approval twice at once: exactly one wins.
    const both = await Promise.allSettled([0, 1].map(() => commitFillTrust(dir, { userId: OWNER, accountPublic: A, revision: 1, requestId: 'req-twice', approvalUntil: until }, undefined, testSecurity)))
    assert.deepEqual(both.map((x) => x.status).sort(), ['fulfilled', 'rejected'])
  } finally { rmSync(join(dir, '..'), { recursive: true, force: true }) }
})

/**
 * The shared test vector for the account code (the app builder uses the same
 * formula and the same vector): the first 20 hex characters, in groups of 4,
 * of sha256(JSON.stringify(["hoai-owner-account-v1", ownerId, accountPublic])).
 */
test('H2: the account code test vector', () => {
  assert.equal(ownerAccountCode('user_2abcDEFghiJKLmno', '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo'), '7509 7181 0915 0eda 35af')
})
