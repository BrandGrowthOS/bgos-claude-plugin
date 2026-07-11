/**
 * agent-credentials tests: resolve the plugin's auth mode (pairing token vs the
 * legacy raw account API key) and produce the right HTTP header + WebSocket
 * handshake for each. Precedence: BGOS_PAIRING_TOKEN env, then the pairing
 * credentials file (~/.bgos-agent/credentials.json), then the legacy
 * BGOS_API_KEY env. The legacy path must stay byte identical so existing paired
 * agents (Echo) keep working.
 *
 * Run: npm test (node --test) or bun test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveAuth,
  authHeaders,
  wsAuthOptions,
  missingCredsMessage,
} from '../lib/agent-credentials.ts'

test('legacy api-key env resolves to apikey mode (Echo path, unchanged)', () => {
  const auth = resolveAuth({
    env: {
      BGOS_BACKEND_URL: 'https://api.brandgrowthos.ai/api/v1',
      BGOS_API_KEY: 'raw_key',
      BGOS_USER_ID: 'user_abc',
      BGOS_ASSISTANT_ID: '1234',
    },
    creds: null,
  })
  assert.equal(auth.mode, 'apikey')
  assert.equal(auth.apiKey, 'raw_key')
  assert.equal(auth.pairingToken, '')
  assert.equal(auth.backendUrl, 'https://api.brandgrowthos.ai/api/v1')
  assert.equal(auth.userId, 'user_abc')
  assert.equal(auth.assistantId, '1234')
  assert.equal(auth.complete, true)
  assert.deepEqual(authHeaders(auth), { 'X-API-Key': 'raw_key' })
  assert.deepEqual(wsAuthOptions(auth), { auth: { apiKey: 'raw_key', assistantId: '1234' } })
})

test('credentials file resolves to pairing mode with X-BGOS-Pairing + query token', () => {
  const auth = resolveAuth({
    env: {},
    creds: {
      backendUrl: 'https://api.brandgrowthos.ai/api/v1',
      pairingToken: 'pair_secret',
      pairingId: 42,
      userId: 'user_abc',
      assistantId: 1234,
      pairedAt: '2026-07-11T00:00:00.000Z',
    },
  })
  assert.equal(auth.mode, 'pairing')
  assert.equal(auth.pairingToken, 'pair_secret')
  assert.equal(auth.apiKey, '')
  assert.equal(auth.assistantId, '1234', 'numeric assistant id becomes a string')
  assert.equal(auth.complete, true)
  assert.deepEqual(authHeaders(auth), { 'X-BGOS-Pairing': 'pair_secret' })
  assert.deepEqual(wsAuthOptions(auth), { query: { pairingToken: 'pair_secret' } })
})

test('BGOS_PAIRING_TOKEN env takes precedence over the credentials file', () => {
  const auth = resolveAuth({
    env: {
      BGOS_PAIRING_TOKEN: 'env_token',
      BGOS_BACKEND_URL: 'https://api.brandgrowthos.ai/api/v1',
      BGOS_USER_ID: 'user_env',
      BGOS_ASSISTANT_ID: '99',
    },
    creds: { pairingToken: 'file_token', userId: 'user_file', assistantId: 1, backendUrl: 'x' },
  })
  assert.equal(auth.mode, 'pairing')
  assert.equal(auth.pairingToken, 'env_token')
  assert.equal(auth.userId, 'user_env')
  assert.equal(auth.assistantId, '99')
})

test('pairing file wins over a legacy api-key env (deprecation window)', () => {
  const auth = resolveAuth({
    env: { BGOS_API_KEY: 'raw_key', BGOS_BACKEND_URL: 'https://api.brandgrowthos.ai/api/v1' },
    creds: { pairingToken: 'pair_secret', userId: 'user_abc', assistantId: 1234, backendUrl: 'https://api.brandgrowthos.ai/api/v1' },
  })
  assert.equal(auth.mode, 'pairing')
  assert.equal(auth.pairingToken, 'pair_secret')
})

test('missing everything is incomplete and names the missing fields', () => {
  const auth = resolveAuth({ env: {}, creds: null })
  assert.equal(auth.complete, false)
  assert.ok(auth.missing.length > 0)
  assert.match(missingCredsMessage(auth), /pair/i)
})

test('pairing file lacking an assistant id is incomplete (binding not finished)', () => {
  const auth = resolveAuth({
    env: {},
    creds: { pairingToken: 'pair_secret', userId: 'user_abc', assistantId: null, backendUrl: 'https://api.brandgrowthos.ai/api/v1' },
  })
  assert.equal(auth.mode, 'pairing')
  assert.equal(auth.complete, false)
  assert.ok(auth.missing.includes('assistantId'))
})
