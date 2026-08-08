/**
 * StreamClient: the Agent Update Stream session client and fetch adapter
 * (agent-message-routing.md 5.4, 5.6; the doc lives in the BGOS repo).
 *
 * Injected-fetch tests for every HTTP-to-FetchResult mapping, the memory-only
 * session token rule, the single-flight re-mint on session_expired, the
 * terminal pairing_revoked state, and the invariant that no credential ever
 * appears in a thrown error message.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PairingRevokedError,
  StreamClient,
  UPDATES_DEFAULT_LIMIT,
} from '../lib/stream-client.ts'

const API_BASE = 'https://backend.test/api/v1'
const PAIRING_TOKEN = 'pair_secret_token_value_abc123'
const PAIRING_HEADERS = { 'X-BGOS-Pairing': PAIRING_TOKEN }

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
}

type Responder = (call: RecordedCall) => Response

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** A scripted fetch fake: responders consumed in call order. */
function scriptedFetch(responders: Responder[]) {
  const calls: RecordedCall[] = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: String(init?.method ?? 'GET'),
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    }
    calls.push(call)
    const responder = responders.shift()
    if (!responder) throw new Error(`fake fetch exhausted at ${call.url}`)
    return responder(call)
  }) as typeof fetch
  return { impl, calls }
}

/** A routed fetch fake for concurrency tests: one handler sees every call. */
function routedFetch(handler: (call: RecordedCall) => Response) {
  const calls: RecordedCall[] = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: String(init?.method ?? 'GET'),
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  return { impl, calls }
}

function client(fetchImpl: typeof fetch): StreamClient {
  return new StreamClient({
    apiBase: API_BASE,
    pairingHeaders: () => ({ ...PAIRING_HEADERS }),
    fetchImpl,
  })
}

const MINT_OK_BODY = {
  sessionToken: 'sess_opaque_token_1',
  expiresAt: '2026-08-09T00:00:00.000Z',
  stream: {
    enabled: true,
    streamEpoch: 3,
    assistants: [{ assistantId: 900, seq: 41 }],
  },
}

// ── mintSession ──────────────────────────────────────────────────────────────

test('mintSession posts to the session endpoint with the pairing header and parses the grant', async () => {
  const { impl, calls } = scriptedFetch([() => jsonResponse(200, MINT_OK_BODY)])
  const c = client(impl)
  const outcome = await c.mintSession()
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, `${API_BASE}/integrations/session`)
  assert.equal(calls[0]!.method, 'POST')
  assert.equal(calls[0]!.headers['X-BGOS-Pairing'], PAIRING_TOKEN)
  assert.equal(outcome.kind, 'ok')
  if (outcome.kind !== 'ok') return
  assert.equal(outcome.grant.expiresAt, '2026-08-09T00:00:00.000Z')
  assert.equal(outcome.grant.stream?.enabled, true)
  assert.equal(outcome.grant.stream?.streamEpoch, 3)
  assert.deepEqual(outcome.grant.stream?.assistants, [
    { assistantId: 900, seq: 41 },
  ])
  assert.equal(c.hasSession, true)
})

test('the minted session token is memory only: never on the grant object', async () => {
  const { impl } = scriptedFetch([() => jsonResponse(200, MINT_OK_BODY)])
  const c = client(impl)
  const outcome = await c.mintSession()
  assert.equal(outcome.kind, 'ok')
  assert.equal(
    JSON.stringify(outcome).includes('sess_opaque_token_1'),
    false,
    'the session token must never leave the client (spec 5.6: memory only)',
  )
})

test('mint maps 404 to not_found (feature absent on this backend)', async () => {
  const { impl } = scriptedFetch([() => jsonResponse(404, { message: 'no' })])
  const outcome = await client(impl).mintSession()
  assert.deepEqual(outcome, { kind: 'not_found' })
})

test('mint maps 429 to rate_limited, body retryAfterSeconds first', async () => {
  const { impl } = scriptedFetch([
    () => jsonResponse(429, { retryAfterSeconds: 12 }, { 'retry-after': '99' }),
  ])
  const outcome = await client(impl).mintSession()
  assert.deepEqual(outcome, { kind: 'rate_limited', retryAfterSeconds: 12 })
})

test('mint 429 falls back to the Retry-After header, then a sane default', async () => {
  const { impl } = scriptedFetch([
    () => new Response('slow down', { status: 429, headers: { 'retry-after': '9' } }),
    () => new Response('slow down', { status: 429 }),
  ])
  const c = client(impl)
  const fromHeader = await c.mintSession()
  assert.deepEqual(fromHeader, { kind: 'rate_limited', retryAfterSeconds: 9 })
  const fallback = await c.mintSession()
  assert.equal(fallback.kind, 'rate_limited')
  if (fallback.kind !== 'rate_limited') return
  assert.ok(fallback.retryAfterSeconds > 0, 'default retry must be positive')
})

test('mint 401 pairing_revoked is terminal', async () => {
  const { impl } = scriptedFetch([
    () => jsonResponse(401, { code: 'pairing_revoked' }),
  ])
  const c = client(impl)
  const outcome = await c.mintSession()
  assert.deepEqual(outcome, { kind: 'revoked' })
  assert.equal(c.revoked, true)
})

test('mint on any other failure reports failed with the status', async () => {
  const { impl } = scriptedFetch([() => jsonResponse(500, {})])
  const outcome = await client(impl).mintSession()
  assert.deepEqual(outcome, { kind: 'failed', status: 500 })
})

// ── fetchUpdates: auth header selection ──────────────────────────────────────

test('fetchUpdates before any session authenticates with the pairing header', async () => {
  const { impl, calls } = scriptedFetch([
    () => jsonResponse(200, { updates: [], state: 10, streamEpoch: 3, final: true }),
  ])
  await client(impl).fetchUpdates(900, 10)
  assert.equal(calls[0]!.headers['X-BGOS-Pairing'], PAIRING_TOKEN)
  assert.equal('X-BGOS-Session' in calls[0]!.headers, false)
  assert.equal(
    calls[0]!.url,
    `${API_BASE}/integrations/updates?assistant_id=900&since=10&limit=${UPDATES_DEFAULT_LIMIT}`,
  )
})

test('fetchUpdates with a session sends X-BGOS-Session, not the pairing token', async () => {
  const { impl, calls } = scriptedFetch([
    () => jsonResponse(200, MINT_OK_BODY),
    () => jsonResponse(200, { updates: [], state: 41, streamEpoch: 3, final: true }),
  ])
  const c = client(impl)
  await c.mintSession()
  await c.fetchUpdates(900, 41, 50)
  const updatesCall = calls[1]!
  assert.equal(updatesCall.headers['X-BGOS-Session'], 'sess_opaque_token_1')
  assert.equal('X-BGOS-Pairing' in updatesCall.headers, false)
  assert.ok(updatesCall.url.endsWith('&limit=50'))
})

// ── fetchUpdates: response mapping ───────────────────────────────────────────

test('a normal 200 maps to ok with normalized updates', async () => {
  const { impl } = scriptedFetch([
    () =>
      jsonResponse(200, {
        assistantId: 900,
        updates: [
          { seq: 11, kind: 'message_new', chatId: 7, messageId: 100, payload: { text: 'hi' } },
          { seq: 12, kind: 'chat_created', chatId: 8, messageId: null },
          { seq: 'garbage', kind: 'message_new' },
        ],
        state: 12,
        streamEpoch: 3,
        final: false,
      }),
  ])
  const result = await client(impl).fetchUpdates(900, 10)
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.equal(result.updates.length, 2, 'a seq-less row is dropped, never applied')
  assert.deepEqual(result.updates[0], {
    seq: 11,
    kind: 'message_new',
    chatId: 7,
    messageId: 100,
    payload: { text: 'hi' },
  })
  assert.deepEqual(result.updates[1], {
    seq: 12,
    kind: 'chat_created',
    chatId: 8,
    messageId: null,
    payload: {},
  })
  assert.equal(result.state, 12)
  assert.equal(result.final, false)
  assert.equal(result.streamEpoch, 3)
})

test('tooOld maps to too_old with state and epoch', async () => {
  const { impl } = scriptedFetch([
    () => jsonResponse(200, { tooOld: true, state: 900, streamEpoch: 4 }),
  ])
  assert.deepEqual(await client(impl).fetchUpdates(900, 1), {
    kind: 'too_old',
    state: 900,
    streamEpoch: 4,
  })
})

test('invalidCursor maps to invalid_cursor with state and epoch', async () => {
  const { impl } = scriptedFetch([
    () => jsonResponse(200, { invalidCursor: true, state: 55, streamEpoch: 4 }),
  ])
  assert.deepEqual(await client(impl).fetchUpdates(900, 999_999), {
    kind: 'invalid_cursor',
    state: 55,
    streamEpoch: 4,
  })
})

test('404 on updates maps to not_found (old backend)', async () => {
  const { impl } = scriptedFetch([() => new Response('nope', { status: 404 })])
  assert.deepEqual(await client(impl).fetchUpdates(900, 10), { kind: 'not_found' })
})

test('429 on updates maps to rate_limited with Retry-After', async () => {
  const { impl } = scriptedFetch([
    () => new Response('', { status: 429, headers: { 'retry-after': '7' } }),
  ])
  assert.deepEqual(await client(impl).fetchUpdates(900, 10), {
    kind: 'rate_limited',
    retryAfterSeconds: 7,
  })
})

// ── fetchUpdates: 401 handling ───────────────────────────────────────────────

test('a 401 session_expired re-mints once and retries with the NEW token', async () => {
  const { impl, calls } = scriptedFetch([
    () => jsonResponse(200, MINT_OK_BODY),
    () => jsonResponse(401, { code: 'session_expired' }),
    () => jsonResponse(200, { ...MINT_OK_BODY, sessionToken: 'sess_opaque_token_2' }),
    () => jsonResponse(200, { updates: [], state: 41, streamEpoch: 3, final: true }),
  ])
  const c = client(impl)
  await c.mintSession()
  const result = await c.fetchUpdates(900, 41)
  assert.equal(result.kind, 'ok')
  const retry = calls[3]!
  assert.ok(retry.url.includes('/integrations/updates'))
  assert.equal(retry.headers['X-BGOS-Session'], 'sess_opaque_token_2')
})

test('concurrent session_expired 401s share a single re-mint (single flight)', async () => {
  let mintCount = 0
  const { impl } = routedFetch((call) => {
    if (call.url.includes('/integrations/session')) {
      mintCount += 1
      return jsonResponse(200, {
        ...MINT_OK_BODY,
        sessionToken: 'sess_fresh_token',
      })
    }
    if (call.headers['X-BGOS-Session'] === 'sess_fresh_token') {
      return jsonResponse(200, { updates: [], state: 41, streamEpoch: 3, final: true })
    }
    return jsonResponse(401, { code: 'session_expired' })
  })
  const c = client(impl)
  const [a, b] = await Promise.all([c.fetchUpdates(900, 41), c.fetchUpdates(900, 41)])
  assert.equal(a.kind, 'ok')
  assert.equal(b.kind, 'ok')
  assert.equal(mintCount, 1, 'two racing 401s must share one mint')
})

test('a 401 pairing_revoked throws the terminal error and marks the client', async () => {
  const { impl } = scriptedFetch([
    () => jsonResponse(401, { code: 'pairing_revoked' }),
  ])
  const c = client(impl)
  await assert.rejects(c.fetchUpdates(900, 10), PairingRevokedError)
  assert.equal(c.revoked, true)
})

test('a failed re-mint surfaces an error instead of a silent retry loop', async () => {
  const { impl } = scriptedFetch([
    () => jsonResponse(200, MINT_OK_BODY),
    () => jsonResponse(401, { code: 'session_expired' }),
    () => jsonResponse(404, {}),
  ])
  const c = client(impl)
  await c.mintSession()
  await assert.rejects(c.fetchUpdates(900, 41))
})

test('no credential ever appears in a thrown error message', async () => {
  const scripts: Responder[][] = [
    [() => jsonResponse(500, { detail: 'boom' })],
    [() => jsonResponse(401, { code: 'pairing_revoked' })],
    [
      () => jsonResponse(200, MINT_OK_BODY),
      () => jsonResponse(401, { code: 'session_expired' }),
      () => jsonResponse(500, {}),
    ],
  ]
  for (const script of scripts) {
    const { impl } = scriptedFetch(script)
    const c = client(impl)
    try {
      if (script.length > 1) await c.mintSession()
      await c.fetchUpdates(900, 10)
      assert.fail('expected a rejection')
    } catch (err) {
      const message = String((err as Error).message ?? err)
      assert.equal(message.includes(PAIRING_TOKEN), false, 'pairing token leaked')
      assert.equal(message.includes('sess_opaque_token_1'), false, 'session token leaked')
    }
  }
})
