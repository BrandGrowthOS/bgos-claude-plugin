/**
 * agent-credentials tests: resolve the plugin's auth mode (pairing token vs the
 * legacy raw account API key) and produce the right HTTP header + WebSocket
 * handshake for each. Precedence: BGOS_PAIRING_TOKEN env, then an
 * identity-compatible pairing credentials file, then the legacy BGOS_API_KEY
 * env. The legacy path must stay byte identical so existing agents keep
 * working.
 *
 * Run: npm test (node --test) or bun test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  resolveAuth,
  resolveCredentialsPath,
  formatAuthResolution,
  authHeaders,
  wsAuthOptions,
  missingCredsMessage,
} from '../lib/agent-credentials.ts'

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

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

test('mismatched pairing file cannot override an explicitly configured assistant', () => {
  const auth = resolveAuth({
    env: {
      BGOS_BACKEND_URL: 'https://env.example/api/v1',
      BGOS_API_KEY: 'env_key',
      BGOS_USER_ID: 'user_env',
      BGOS_ASSISTANT_ID: '888',
    },
    creds: {
      backendUrl: 'https://file.example/api/v1',
      pairingToken: 'pair_secret',
      userId: 'user_file',
      assistantId: 972,
    },
  })

  assert.equal(auth.mode, 'apikey')
  assert.equal(auth.source, 'apikey-env')
  assert.equal(auth.backendUrl, 'https://env.example/api/v1')
  assert.equal(auth.userId, 'user_env')
  assert.equal(auth.assistantId, '888')
  assert.equal(auth.apiKey, 'env_key')
  assert.equal(auth.pairingToken, '')
  assert.equal(auth.complete, true)
  assert.deepEqual(authHeaders(auth), { 'X-API-Key': 'env_key' })
  assert.deepEqual(wsAuthOptions(auth), {
    auth: { apiKey: 'env_key', assistantId: '888' },
  })
})

test('mismatched pairing file fails closed when no env api key is available', () => {
  const auth = resolveAuth({
    env: {
      BGOS_BACKEND_URL: 'https://env.example/api/v1',
      BGOS_USER_ID: 'user_env',
      BGOS_ASSISTANT_ID: '888',
    },
    creds: {
      backendUrl: 'https://file.example/api/v1',
      pairingToken: 'pair_secret',
      userId: 'user_file',
      assistantId: 972,
    },
  })

  assert.equal(auth.mode, 'apikey')
  assert.equal(auth.source, 'none')
  assert.equal(auth.assistantId, '888')
  assert.equal(auth.pairingToken, '')
  assert.equal(auth.apiKey, '')
  assert.equal(auth.complete, false)
  assert.deepEqual(auth.missing, ['apiKey'])
})

test('matching configured and file assistant ids keep pairing file auth', () => {
  const auth = resolveAuth({
    env: {
      BGOS_BACKEND_URL: 'https://env.example/api/v1',
      BGOS_API_KEY: 'env_key',
      BGOS_USER_ID: 'user_env',
      BGOS_ASSISTANT_ID: '888',
    },
    creds: {
      backendUrl: 'https://file.example/api/v1',
      pairingToken: 'pair_secret',
      userId: 'user_file',
      assistantId: 888,
    },
  })

  assert.equal(auth.mode, 'pairing')
  assert.equal(auth.source, 'pairing-file')
  assert.equal(auth.backendUrl, 'https://file.example/api/v1')
  assert.equal(auth.userId, 'user_file')
  assert.equal(auth.assistantId, '888')
  assert.equal(auth.pairingToken, 'pair_secret')
  assert.equal(auth.apiKey, '')
  assert.equal(auth.complete, true)
  assert.deepEqual(authHeaders(auth), { 'X-BGOS-Pairing': 'pair_secret' })
  assert.deepEqual(wsAuthOptions(auth), { query: { pairingToken: 'pair_secret' } })
})

test('unsubstituted assistant config placeholder keeps pairing file auth', () => {
  const auth = resolveAuth({
    env: {
      BGOS_BACKEND_URL: '${user_config.backend_url}',
      BGOS_API_KEY: '${user_config.api_key}',
      BGOS_USER_ID: '${user_config.user_id}',
      BGOS_ASSISTANT_ID: '${user_config.assistant_id}',
    },
    creds: {
      backendUrl: 'https://file.example/api/v1',
      pairingToken: 'pair_secret',
      userId: 'user_file',
      assistantId: 972,
    },
  })

  assert.equal(auth.mode, 'pairing')
  assert.equal(auth.source, 'pairing-file')
  assert.equal(auth.assistantId, '972')
  assert.equal(auth.pairingToken, 'pair_secret')
})

test('pairing file keeps precedence when no assistant id is configured', () => {
  const auth = resolveAuth({
    env: {
      BGOS_API_KEY: 'env_key',
      BGOS_BACKEND_URL: 'https://env.example/api/v1',
      BGOS_USER_ID: 'user_env',
    },
    creds: {
      backendUrl: 'https://file.example/api/v1',
      pairingToken: 'pair_secret',
      userId: 'user_file',
      assistantId: 972,
    },
  })

  assert.equal(auth.mode, 'pairing')
  assert.equal(auth.source, 'pairing-file')
  assert.equal(auth.backendUrl, 'https://file.example/api/v1')
  assert.equal(auth.userId, 'user_file')
  assert.equal(auth.assistantId, '972')
  assert.equal(auth.pairingToken, 'pair_secret')
  assert.equal(auth.apiKey, '')
  assert.equal(auth.complete, true)
  assert.deepEqual(authHeaders(auth), { 'X-BGOS-Pairing': 'pair_secret' })
  assert.deepEqual(wsAuthOptions(auth), { query: { pairingToken: 'pair_secret' } })
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

test('BGOS_CREDENTIALS_PATH overrides the default pairing credentials path', () => {
  assert.equal(
    resolveCredentialsPath({
      env: { BGOS_CREDENTIALS_PATH: '/agents/888/credentials.json' },
      defaultPath: '/home/kc/.bgos-agent/credentials.json',
    }),
    '/agents/888/credentials.json',
  )
})

test('credentials path keeps the existing default when no override is set', () => {
  assert.equal(
    resolveCredentialsPath({
      env: {},
      defaultPath: '/home/kc/.bgos-agent/credentials.json',
    }),
    '/home/kc/.bgos-agent/credentials.json',
  )
})

test('server loads credentials from the resolved per-agent path', () => {
  assert.equal(
    /const CREDENTIALS_PATH = resolveCredentialsPath\(\{\s*env: process\.env,\s*defaultPath: joinPath\(homedir\(\), '\.bgos-agent', 'credentials\.json'\),\s*\}\)/.test(
      serverSource,
    ),
    true,
  )
  assert.equal(/creds: loadCredentialsFile\(CREDENTIALS_PATH\)/.test(serverSource), true)
})

test('auth resolution log identifies the credential source and assistant id', () => {
  const envAuth = resolveAuth({
    env: {
      BGOS_BACKEND_URL: 'https://env.example/api/v1',
      BGOS_API_KEY: 'env_key',
      BGOS_USER_ID: 'user_env',
      BGOS_ASSISTANT_ID: '888',
    },
    creds: {
      backendUrl: 'https://file.example/api/v1',
      pairingToken: 'pair_secret',
      userId: 'user_file',
      assistantId: 972,
    },
  })
  const pairingAuth = resolveAuth({
    env: { BGOS_ASSISTANT_ID: '888' },
    creds: {
      backendUrl: 'https://file.example/api/v1',
      pairingToken: 'pair_secret',
      userId: 'user_file',
      assistantId: 888,
    },
  })

  assert.equal(
    formatAuthResolution(envAuth, '/agents/888/credentials.json'),
    'Credential source: env-apikey; assistantId: 888',
  )
  assert.equal(
    formatAuthResolution(pairingAuth, '/agents/888/credentials.json'),
    'Credential source: pairing-file at /agents/888/credentials.json; assistantId: 888',
  )
})

test('server logs the auth resolution for failed and complete startup', () => {
  assert.equal(
    /if \(!AUTH\.complete\) \{\s*process\.stderr\.write\(`\[bgos\] \$\{formatAuthResolution\(AUTH, CREDENTIALS_PATH\)\}\\n`\)/.test(
      serverSource,
    ),
    true,
  )
  assert.equal(
    serverSource.includes('log(formatAuthResolution(AUTH, CREDENTIALS_PATH))'),
    true,
  )
})
