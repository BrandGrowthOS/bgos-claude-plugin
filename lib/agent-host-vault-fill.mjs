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
 * What this machine trusts is kept in the owner only vault host file
 * (lib/vault-host.mjs readFillTrust, commitFillTrust): the account key, pinned
 * on FIRST USE and written only after a fill passed every check (no other
 * anchor for the owner's key exists on this machine yet); the highest state
 * revision verified, so an older state the owner once signed (before Always
 * ask, before a person was removed) is refused; and the approvals already
 * used, so one signed yes fills once. An approval counts only from a device in
 * the owner's SIGNED device list, not retired there, and before it expires.
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

/** An approval's expiry as milliseconds (an ISO time or a number), or NaN. */
function expiryMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return Date.parse(value)
  return NaN
}

/** Step 3: the owner's signed yes over this exact fill, from a device of the signed list, before it expires. */
export function verifyApproval(approval, { devices, accountPublic, state, assistantId, actingUserId, itemId, origin, revision, now }) {
  const a = approval
  if (!a || typeof a !== 'object' || a.approve !== true || typeof a.requestId !== 'string' || typeof a.deviceId !== 'string' || typeof a.signature !== 'string') throw fail('vault_approval_missing')
  if (!(expiryMs(a.expiresAt) > now)) throw fail('vault_approval_expired')
  // The device must be in what the owner SIGNED, not only in the server's list, and not retired there.
  const signed = Array.isArray(state?.devices) && state.devices.some((d) => d && d.deviceId === a.deviceId)
  const retired = Array.isArray(state?.retiredDeviceIds) && state.retiredDeviceIds.includes(a.deviceId)
  const d = certifiedDevice(devices, a.deviceId, accountPublic)
  if (!signed || retired || !d || d.revokedAt) throw fail('vault_approval_unverified')
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
 * Steps 1 to 4 for one redeemed fill. `trust` is this machine's fill trust
 * (lib/vault-host.mjs readFillTrust and commitFillTrust, bound to the host
 * folder); nothing is written to it unless every check passed. Returns
 * `{ username, password, own, asked }`; the caller types them and drops them.
 *
 * @param {any} redeemed the redeem answer
 * @param {{ assistantId: number, ownerUserId: string | null, actingUserId: string, origin: string, hostSeed: string,
 *   now?: () => number,
 *   trust: { read: (userId: string) => Promise<{ accountPublic: string | null, revisionFloor: number, approvalUsed: (id: string) => boolean }>,
 *     commit: (c: { userId: string, accountPublic: string, revision: number, requestId?: string }) => Promise<void> } }} ctx
 */
export async function openPersonFill(redeemed, ctx) {
  const r = redeemed
  const now = (ctx.now ?? Date.now)()
  if (!r || typeof r !== 'object' || !r.state || typeof r.state !== 'object' || typeof r.itemId !== 'string') throw fail('vault_redeem_unreadable')
  // The owner's own logins are filled by their desktop, never as a person here.
  if (typeof ctx.ownerUserId === 'string' && ctx.actingUserId === ctx.ownerUserId) throw fail('vault_owner_turn')
  const s0 = r.state
  const own = s0.ownerId === ctx.actingUserId
  if (!own && (typeof ctx.ownerUserId !== 'string' || s0.ownerId !== ctx.ownerUserId)) throw fail('vault_state_not_the_owners')
  const trusted = await ctx.trust.read(String(s0.ownerId))
  // The pinned key, else (first use) the one presented, which is pinned only if everything below passes.
  const key = trusted.accountPublic ?? r.accountPublic
  // 1. The signature, against that key, this agent, and no older than what was verified before.
  const s = verifySignedState(r, key)
  if (s.assistantId !== ctx.assistantId) throw fail('vault_state_other_agent')
  if (!Number.isSafeInteger(s.revision) || s.revision < trusted.revisionFloor) throw fail('vault_state_rolled_back')
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
    // 3. Did this fill have to ask? Then the owner's signed yes, over this fill, once.
    asks = fillNeedsAsk(person, item.id)
    if (asks) {
      verifyApproval(r.approval, { devices: r.devices, accountPublic: key, state: s, assistantId: ctx.assistantId, actingUserId: ctx.actingUserId, itemId: item.id, origin: ctx.origin, revision: s.revision, now })
      if (trusted.approvalUsed(r.approval.requestId)) throw fail('vault_approval_used')
    }
  }
  // 4. Opened with the key wrapped to this host.
  const values = openHostLogin(s, item.id, { assistantId: ctx.assistantId, hostSeed: ctx.hostSeed })
  try {
    await ctx.trust.commit({ userId: String(s.ownerId), accountPublic: key, revision: s.revision, ...(asks ? { requestId: r.approval.requestId } : {}) })
  } catch (err) {
    throw err instanceof HostFillError || typeof err?.code === 'string' ? fail(String(err.code)) : fail('vault_trust_unwritable')
  }
  return { ...values, own, asked: asks }
}
