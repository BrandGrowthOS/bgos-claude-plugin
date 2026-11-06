// An independent restatement of the server half of the agent vault contract,
// written from the published wire contract (capability canon, "Agent vault"):
// the host-key proof, the BGOS-A2A-V1 request signature and the signed fill
// intent. The plugin's own code is never imported here, so a test that uses
// these checks is a second opinion, not the code grading itself.
import { createHash, createPublicKey, verify } from 'node:crypto'

export function a2aCanonical(input: {
  method: string; path: string; source: number; target: number | null
  body: Buffer | string; timestamp: string; nonce: string
}): string {
  return [
    'BGOS-A2A-V1',
    input.method.toUpperCase(),
    input.path,
    String(input.source),
    input.target == null ? '' : String(input.target),
    '',
    createHash('sha256').update(input.body).digest('hex'),
    '',
    input.timestamp,
    input.nonce,
  ].join('\n')
}

export function a2aKeyId(assistantId: number, identityPublic: string): string {
  const der = createPublicKey({ key: Buffer.from(identityPublic, 'base64url'), format: 'der', type: 'spki' })
    .export({ format: 'der', type: 'spki' })
  return `a${assistantId}.${createHash('sha256').update(der).digest('base64url')}`
}

function edKey(identityPublic: string) {
  const key = createPublicKey({ key: Buffer.from(identityPublic, 'base64url'), format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519')
  return key
}

/** Server check of the four A2A headers plus the pairing header. Returns a reason or null. */
export function checkSignedRequest(input: {
  method: string; path: string; assistantId: number; identityPublic: string
  pairingToken: string; headers: Record<string, string>; body: string
}): string | null {
  const h = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v]))
  if (h['x-bgos-pairing'] !== input.pairingToken) return 'pairing'
  if (h['x-bgos-acting-user']) return 'acting-user'
  if (h['x-bgos-a2a-key-id'] !== a2aKeyId(input.assistantId, input.identityPublic)) return 'key-id'
  if (!/^\d{1,12}$/.test(h['x-bgos-a2a-timestamp'] ?? '')) return 'timestamp'
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(h['x-bgos-a2a-timestamp'])) > 300) return 'skew'
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(h['x-bgos-a2a-nonce'] ?? '')) return 'nonce'
  const sig = h['x-bgos-a2a-signature'] ?? ''
  if (!/^v1=[A-Za-z0-9_-]{86}$/.test(sig)) return 'signature-shape'
  const canonical = a2aCanonical({
    method: input.method, path: input.path, source: input.assistantId, target: input.assistantId,
    body: input.body, timestamp: h['x-bgos-a2a-timestamp'], nonce: h['x-bgos-a2a-nonce'],
  })
  const ok = verify(null, Buffer.from(canonical), edKey(input.identityPublic), Buffer.from(sig.slice(3), 'base64url'))
  return ok ? null : 'signature'
}

/** Server check of POST .../host-key {publicKey,signature}. */
export function checkHostKeyProof(input: {
  ownerId: string; assistantId: number; identityPublic: string; publicKey: string; signature: string
}): boolean {
  try {
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.publicKey) || Buffer.from(input.publicKey, 'base64url').length !== 32) return false
    if (!/^[A-Za-z0-9_-]{86}$/.test(input.signature)) return false
    return verify(
      null,
      Buffer.from(JSON.stringify(['hoai-vault-host-key-v1', input.ownerId, input.assistantId, input.publicKey])),
      edKey(input.identityPublic),
      Buffer.from(input.signature, 'base64url'),
    )
  } catch {
    return false
  }
}

const INTENT_FIELDS = ['version', 'ownerId', 'assistantId', 'vaultAssistantId', 'vaultId', 'itemId', 'revision', 'sessionId', 'tabId', 'origin', 'nonce', 'expiresAt']

/** Server check of a signed fill intent. Throws on any defect, like the route's 400. */
export function checkFillIntent(i: Record<string, unknown>, signature: string, identityPublic: string): void {
  const now = Date.now()
  if (
    !i || Object.keys(i).length !== INTENT_FIELDS.length || INTENT_FIELDS.some(k => !(k in i)) || i.version !== 1 ||
    ![i.assistantId, i.vaultAssistantId, i.revision].every(n => Number.isSafeInteger(n) && (n as number) > 0) ||
    !Number.isSafeInteger(i.expiresAt) || (i.expiresAt as number) <= now || (i.expiresAt as number) > now + 65_000 ||
    ![i.vaultId, i.itemId, i.nonce].every(s => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s)) ||
    ![i.ownerId, i.sessionId, i.tabId].every(s => typeof s === 'string' && s.length > 0 && s.length <= 128)
  ) throw new Error('Invalid signed vault fill request.')
  const origin = new URL(String(i.origin))
  if (origin.protocol !== 'https:' || origin.origin !== i.origin) throw new Error('Invalid signed vault fill request.')
  const text = JSON.stringify(['hoai-vault-fill-v1', i.ownerId, i.assistantId, i.vaultAssistantId, i.vaultId, i.itemId, i.revision, i.sessionId, i.tabId, i.origin, i.nonce, i.expiresAt])
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature) || !verify(null, Buffer.from(text), edKey(identityPublic), Buffer.from(signature, 'base64url'))) {
    throw new Error('Invalid signed vault fill request.')
  }
}

/** Fingerprint as the owner's app shows it: SHA-256 of JSON [identityPublic, publicKey], ten bytes, five groups. */
export function referenceFingerprint(identityPublic: string, publicKey: string): string {
  return createHash('sha256').update(JSON.stringify([identityPublic, publicKey])).digest('hex').slice(0, 20).match(/.{4}/g)!.join(' ')
}
