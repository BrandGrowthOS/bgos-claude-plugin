/**
 * agent-host-vault-fill: the checks and the one decryption this agent's own
 * browser host makes before it fills a saved login on a PERSON's turn (shared
 * agent vault, plugin 0.90.0; BGOS plan 2026-11-13 sections 3, 4.3, 5 and 6).
 *
 * The host (bin/hoai-browser-host.mjs) redeems a one use ticket with the
 * agent's own pairing and gets `{ state, itemId, approval?, devices,
 * accountPublic }`. Before anything is typed, in this order, and refusing on
 * any failure with a code that names nothing secret:
 *
 *   1. the state is the owner's (or, for a person's own login, the person's)
 *      signed state: the signer device's certificate verifies against the
 *      account key PINNED on this machine for that user, and the state's
 *      signature against that device (a port of BGOS
 *      frontend/electron-app/agent-browser/vault-host-crypto.cjs `signed`),
 *      and `state.assistantId` is this agent;
 *   2. the acting person is in the signed `people` with the item listed (or,
 *      for an own login, the state is that person's own vault for this agent);
 *   3. whether the fill had to ask comes from the signed `askMode` and the
 *      item's entry; if it had to, `approval` is verified: approve true, the
 *      device certified by the same pinned account key and not revoked, and
 *      its Ed25519 signature over 'hoai-vault-fill-approval-v1\n' +
 *      canonical({requestId, assistantId, actingUserId, itemId, origin,
 *      revision, expiresAt, approve});
 *   4. the item is opened with the key wrapped to THIS host (`hosts[]` entry
 *      for this agent and this host's public key), with the X25519 key derived
 *      from hostSeed (a port of `openHostValue`).
 *
 * The account key pin is trust on first use, kept in the owner only vault host
 * file (lib/vault-host.mjs pinAccountKey): a later answer with another key for
 * the same user is refused.
 *
 * Plain JavaScript, node builtins only. No em or en dashes in this file.
 */
import { createDecipheriv, createPublicKey, diffieHellman, hkdfSync, verify } from 'node:crypto'

import { hostEncryptionPrivateKey } from './vault-host.mjs'

/** A refusal with a fixed code. Its message never carries a value, a key or a body. */
export class HostFillError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}
const fail = (code) => new HostFillError(code)

const b64 = (s) => Buffer.from(String(s ?? ''), 'base64url')

export const canonical = (v) =>
  v === null || typeof v !== 'object'
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? '[' + v.map(canonical).join(',') + ']'
      : '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'

/** BGOS vault-wire.ts context(): the AAD of every sealed value. */
export const vaultContext = (s, lane, id = '') => canonical(['hoai-vault-v2', s.ownerId, s.id, s.revision, lane, id])

const edPublic = (raw) => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' })
const xPublic = (raw) => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), raw]), format: 'der', type: 'spki' })

function frame(...fields) {
  return Buffer.concat(fields.flatMap((v) => {
    const b = Buffer.from(v)
    const n = Buffer.alloc(4)
    n.writeUInt32BE(b.length)
    return [n, b]
  }))
}

/** A device of the signed list whose certificate verifies against the account key, or null. */
export function certifiedDevice(devices, deviceId, accountPublic) {
  const d = Array.isArray(devices) ? devices.find((x) => x && x.id === deviceId) : null
  if (!d || typeof d.signingPublic !== 'string' || typeof d.certificate !== 'string') return null
  try {
    const cert = frame('bgos-device-cert-v1', d.id, b64(d.signingPublic), d.platform, d.role, d.createdAt)
    return verify(null, cert, edPublic(b64(accountPublic)), b64(d.certificate)) ? d : null
  } catch {
    return null
  }
}

/** Step 1: the state, verified against the pinned account key, or a refusal. */
export function verifySignedState(payload, pinnedAccountPublic) {
  const s = payload?.state
  if (!s || typeof s !== 'object' || typeof pinnedAccountPublic !== 'string' || payload.accountPublic !== pinnedAccountPublic) throw fail('vault_state_unverified')
  const d = certifiedDevice(payload.devices, s.signerDeviceId, pinnedAccountPublic)
  if (!d) throw fail('vault_state_unverified')
  const { signature, ...body } = s
  try {
    if (!verify(null, Buffer.from('hoai-vault-state-v2\n' + canonical(body)), edPublic(b64(d.signingPublic)), b64(signature))) throw new Error()
  } catch {
    throw fail('vault_state_unverified')
  }
  return s
}

/** Section 3: does a fill of this item for this person wait for the owner? */
export function fillNeedsAsk(person, itemId) {
  if (!person) return true
  if (person.askMode === 'never') return false
  if (person.askMode === 'always') return true
  const items = Array.isArray(person.items) ? person.items : []
  const own = items.find((e) => e && e.itemId === itemId)
  if (own) return own.ask !== false
  const all = items.find((e) => e && e.itemId === null)
  if (all) return all.ask !== false
  return true
}

export function approvalSigningText({ requestId, assistantId, actingUserId, itemId, origin, revision, expiresAt, approve }) {
  return 'hoai-vault-fill-approval-v1\n' + canonical({ requestId, assistantId, actingUserId, itemId, origin, revision, expiresAt, approve })
}

/** Step 3: the owner's signed yes over this exact fill. */
export function verifyApproval(approval, { devices, accountPublic, assistantId, actingUserId, itemId, origin, revision }) {
  const a = approval
  if (!a || typeof a !== 'object' || a.approve !== true || typeof a.requestId !== 'string' || typeof a.deviceId !== 'string' || typeof a.signature !== 'string') throw fail('vault_approval_missing')
  const d = certifiedDevice(devices, a.deviceId, accountPublic)
  if (!d || d.revokedAt) throw fail('vault_approval_unverified')
  const textToSign = approvalSigningText({ requestId: a.requestId, assistantId, actingUserId, itemId, origin, revision, expiresAt: a.expiresAt, approve: true })
  try {
    if (!verify(null, Buffer.from(textToSign), edPublic(b64(d.signingPublic)), b64(a.signature))) throw new Error()
  } catch {
    throw fail('vault_approval_unverified')
  }
}

function openSealed(key, sealed, aad) {
  const data = b64(sealed?.ciphertext)
  if (data.length < 17) throw fail('vault_item_unavailable')
  const d = createDecipheriv('aes-256-gcm', key, b64(sealed.nonce))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(data.subarray(-16))
  return Buffer.concat([d.update(data.subarray(0, -16)), d.final()])
}

function unwrapToHost(privateKey, recipientPublic, sealed, aad) {
  const sender = b64(sealed?.ephemeralPublic)
  const shared = diffieHellman({ privateKey, publicKey: xPublic(sender) })
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([sender, recipientPublic]), Buffer.from(aad), 32))
  try {
    return openSealed(key, sealed, aad)
  } finally {
    key.fill(0)
    shared.fill(0)
  }
}

/** Step 4: the login's username and value, opened with the key wrapped to this host. */
export function openHostLogin(state, itemId, { assistantId, hostSeed }) {
  const item = Array.isArray(state.items) ? state.items.find((i) => i && i.id === itemId) : null
  if (!item) throw fail('vault_item_unavailable')
  const privateKey = hostEncryptionPrivateKey(hostSeed)
  const recipientPublic = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)
  const pub = recipientPublic.toString('base64url')
  const recipient = Array.isArray(item.hosts) ? item.hosts.find((h) => h && h.assistantId === assistantId && h.publicKey === pub) : null
  if (!recipient) throw fail('vault_item_not_for_this_host')
  let key
  try {
    key = unwrapToHost(privateKey, recipientPublic, recipient.key, vaultContext(state, 'host', `${item.id}:${assistantId}`))
    return { username: typeof item.username === 'string' ? item.username : '', password: openSealed(key, item.sealed, vaultContext(state, 'value', item.id)).toString('utf8') }
  } catch (err) {
    throw err instanceof HostFillError ? err : fail('vault_item_unavailable')
  } finally {
    key?.fill(0)
  }
}

/**
 * Steps 1 to 4 for one redeemed fill. `pinFor(userId, accountPublic)` returns
 * the account key pinned for that user (pinning it on first use) or throws.
 * Returns `{ username, password, own }`; the caller types them and drops them.
 *
 * @param {any} redeemed the redeem answer
 * @param {{ assistantId: number, ownerUserId: string, actingUserId: string, origin: string,
 *   hostSeed: string, pinFor: (userId: string, accountPublic: string) => Promise<string> | string }} ctx
 */
export async function openPersonFill(redeemed, ctx) {
  const r = redeemed
  if (!r || typeof r !== 'object' || !r.state || typeof r.itemId !== 'string') throw fail('vault_redeem_unreadable')
  const s0 = r.state
  const own = s0.ownerId === ctx.actingUserId
  if (!own && s0.ownerId !== ctx.ownerUserId) throw fail('vault_state_not_the_owners')
  const pinned = await ctx.pinFor(String(s0.ownerId), r.accountPublic)
  // 1. The signature, against the pinned key, and this agent.
  const s = verifySignedState(r, pinned)
  if (s.assistantId !== ctx.assistantId) throw fail('vault_state_other_agent')
  if (s.enabled !== true) throw fail('vault_disabled')
  const item = Array.isArray(s.items) ? s.items.find((i) => i && i.id === r.itemId) : null
  if (!item || item.kind !== 'login' || item.source !== undefined) throw fail('vault_item_unavailable')
  if (item.website !== ctx.origin) throw fail('vault_origin_mismatch')
  // 2. The person and the item, in what the owner signed.
  let asks = false
  if (!own) {
    const person = Array.isArray(s.people) ? s.people.find((p) => p && p.userId === ctx.actingUserId) : null
    const listed = person && Array.isArray(person.items) && person.items.some((e) => e && (e.itemId === item.id || e.itemId === null))
    if (!listed) throw fail('vault_not_shared_with_person')
    // 3. Did this fill have to ask? Then the owner's signed yes, over this fill.
    asks = fillNeedsAsk(person, item.id)
    if (asks) verifyApproval(r.approval, { devices: r.devices, accountPublic: pinned, assistantId: ctx.assistantId, actingUserId: ctx.actingUserId, itemId: item.id, origin: ctx.origin, revision: s.revision })
  }
  // 4. Opened with the key wrapped to this host.
  const values = openHostLogin(s, item.id, { assistantId: ctx.assistantId, hostSeed: ctx.hostSeed })
  return { ...values, own, asked: asks }
}
