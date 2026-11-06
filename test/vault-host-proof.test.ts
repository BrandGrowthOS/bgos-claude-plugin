import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { confirmHostPin, hostPinStatus, loadOrCreateHostKey, provisionSigningIdentity, readHostRecord, registerHostKey } from './helpers/vault-host.mjs'
import { checkHostKeyProof, checkSignedRequest } from './fixtures/vault-server-contract.ts'

test('host proof: valid pairing and A2A signature reach and fail the independent proof for a different owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vault-proof-'))
  const dir = join(root, 'vault')
  const pair = generateKeyPairSync('ed25519')
  const secret = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
  const identityPublic = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
  let checkedProof = false
  try {
    await loadOrCreateHostKey(dir, 42)
    await provisionSigningIdentity(dir, 42, secret)
    const fetch = (async (url: string | URL, init: RequestInit = {}) => {
      const body = String(init.body)
      const headers = init.headers as Record<string, string>
      assert.equal(checkSignedRequest({ method: 'POST', path: new URL(url).pathname, assistantId: 42, identityPublic, pairingToken: 'fixture-pairing', headers, body }), null)
      const proof = JSON.parse(body)
      assert.equal(checkHostKeyProof({ ownerId: 'fixture-wrong-owner', assistantId: 42, identityPublic, ...proof }), true)
      assert.equal(checkHostKeyProof({ ownerId: 'fixture-real-owner', assistantId: 42, identityPublic, ...proof }), false)
      checkedProof = true
      return new Response('{}', { status: 403 })
    }) as typeof globalThis.fetch
    await assert.rejects(registerHostKey({ stateDir: dir, assistantId: 42, ownerId: 'fixture-wrong-owner', apiBase: 'https://api.example.test/api/v1', pairingToken: 'fixture-pairing', fetch }), /VAULT_UNAVAILABLE/)
    assert.equal(checkedProof, true)
    assert.equal(hostPinStatus(await readHostRecord(dir)), 'unregistered')
    await assert.rejects(() => confirmHostPin(dir), /VAULT_HOST_NOT_REGISTERED/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
