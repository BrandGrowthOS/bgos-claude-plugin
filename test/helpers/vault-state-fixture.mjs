// A real signed vault state for the host fill tests: an account key, a
// certified device, a login sealed with its own item key, the item key wrapped
// to a host's X25519 key (BGOS vault-wire.ts and vaultCrypto.ts, the sealing
// half of what lib/agent-host-vault-fill.mjs opens). Made up values only.
// No em or en dashes in this file.
import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID, sign } from 'node:crypto'

import { approvalSigningText, canonical, vaultContext } from '../../lib/agent-host-vault-fill.mjs'
import { hostEncryptionPrivateKey } from '../../lib/vault-host.mjs'

const raw = (key) => key.export({ format: 'der', type: 'spki' }).subarray(-32)
const u = (buf) => Buffer.from(buf).toString('base64url')

function frame(...fields) {
  return Buffer.concat(fields.flatMap((v) => { const b = Buffer.from(v); const n = Buffer.alloc(4); n.writeUInt32BE(b.length); return [n, b] }))
}

function seal(key, plain, aad) {
  const nonce = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, nonce)
  c.setAAD(Buffer.from(aad))
  const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()])
  return { nonce: u(nonce), ciphertext: u(body) }
}

function wrapTo(recipientPublicRaw, plain, aad) {
  const eph = generateKeyPairSync('x25519')
  const recipient = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), recipientPublicRaw]), format: 'der', type: 'spki' })
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient })
  const sender = raw(eph.publicKey)
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([sender, recipientPublicRaw]), Buffer.from(aad), 32))
  return { ...seal(key, plain, aad), ephemeralPublic: u(sender) }
}

export function account() {
  const acc = generateKeyPairSync('ed25519')
  const devices = []
  const keys = new Map()
  const addDevice = (extra = {}) => {
    const dev = generateKeyPairSync('ed25519')
    const d = { id: randomUUID(), signingPublic: u(raw(dev.publicKey)), createdAt: '2026-11-01T00:00:00.000Z', platform: 'ios', role: 'phone', revokedAt: null, ...extra }
    d.certificate = u(sign(null, frame('bgos-device-cert-v1', d.id, raw(dev.publicKey), d.platform, d.role, d.createdAt), acc.privateKey))
    devices.push(d)
    keys.set(d.id, dev.privateKey)
    return d
  }
  return { accountPublic: u(raw(acc.publicKey)), devices, keys, addDevice }
}

/**
 * @param {{ ownerId: string, assistantId: number, hostSeed: string, acct: ReturnType<typeof account>,
 *   items?: Array<{ id?: string, website: string, username: string, password: string, kind?: string, source?: string, hostAssistantId?: number }>,
 *   people?: any[], enabled?: boolean, revision?: number }} o
 */
export function signedState(o) {
  const signer = o.acct.devices[0] ?? o.acct.addDevice()
  const base = { version: 2, id: randomUUID(), ownerId: o.ownerId, assistantId: o.assistantId, revision: o.revision ?? 7, epoch: 1 }
  const hostPub = raw(createPublicKey(hostEncryptionPrivateKey(o.hostSeed)))
  const items = (o.items ?? []).map((it) => {
    const id = it.id ?? randomUUID()
    const itemKey = randomBytes(32)
    const hostId = it.hostAssistantId ?? o.assistantId
    return {
      id, name: 'Login', kind: it.kind ?? 'login', ...(it.source ? { source: it.source } : {}), website: it.website, username: it.username, envName: '',
      sealed: seal(itemKey, Buffer.from(it.password), vaultContext(base, 'value', id)),
      ownerKey: { nonce: 'x', ciphertext: 'x' },
      hosts: [{ assistantId: hostId, publicKey: u(hostPub), key: wrapTo(hostPub, itemKey, vaultContext(base, 'host', `${id}:${hostId}`)) }],
    }
  })
  const body = { ...base, enabled: o.enabled ?? true, items, grants: [], retiredDeviceIds: [], devices: [], signerDeviceId: signer.id, action: 'people', ...(o.people ? { people: o.people } : {}) }
  const signature = u(sign(null, Buffer.from('hoai-vault-state-v2\n' + canonical(body)), o.acct.keys.get(signer.id)))
  return { ...body, signature }
}

export function approve(acct, deviceId, fields) {
  return { requestId: fields.requestId, deviceId, approve: true, expiresAt: fields.expiresAt, signature: u(sign(null, Buffer.from(approvalSigningText({ ...fields, approve: true })), acct.keys.get(deviceId))) }
}
