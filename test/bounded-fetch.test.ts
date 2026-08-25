/**
 * Bounded network calls + narrated startup phases (lib/bounded-fetch.ts).
 *
 * WHY (2026-08-25, external tester, pairing 1041): the daemon logged
 * `MCP server connected over stdio` and then nothing at all, twice, for
 * hours. Its pairing `last_seen_at` never moved and five messages sat
 * queued. `grep -c AbortSignal server.ts` returned 0: not one fetch in the
 * daemon was bounded, so a socket that connected and then stalled hung the
 * first startup call forever, before the poll loop existed.
 *
 * These are the guards for the two halves of the fix:
 *   - a call cannot outlive its deadline, the deadline covers the BODY read
 *     and not only the headers, and a fired deadline is both LOGGED and
 *     DISTINGUISHABLE from a connection failure;
 *   - a startup phase says when it starts, when it finishes, and when it
 *     throws, so a log that stops mid-phase names the phase.
 *
 * Run with: npm test  (node --test via tsx, no network)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  boundedFetch,
  createBoundedFetchImpl,
  DEADLINE_EXCEEDED,
  FetchTimeoutError,
  isDeadlineExceeded,
  isFetchTimeoutError,
  startupPhase,
  withDeadline,
} from '../lib/bounded-fetch.ts'

/** Minimal stand-in for the parts of Response these tests touch. */
function fakeResponse(body: unknown, init?: { status?: number }): Response {
  return {
    ok: (init?.status ?? 200) < 400,
    status: init?.status ?? 200,
    headers: { get: () => null },
    async text() {
      return JSON.stringify(body)
    },
    async json() {
      return body
    },
  } as unknown as Response
}

const NEVER = new Promise<never>(() => {})

function collectLog(): { lines: string[]; log: (msg: string) => void } {
  const lines: string[] = []
  return { lines, log: (msg) => lines.push(msg) }
}

// ── boundedFetch: the happy path is untouched ────────────────────────────────

test('boundedFetch returns the consumed value and logs nothing on a normal call', async () => {
  const { lines, log } = collectLog()
  const out = await boundedFetch(
    { url: 'https://example.test/x', timeoutMs: 5_000, label: 'GET x' },
    async (res) => res.json(),
    { fetchImpl: async () => fakeResponse({ ok: true }), log },
  )
  assert.deepEqual(out, { ok: true })
  assert.deepEqual(lines, [], 'a call that answered must not report a deadline')
})

test('boundedFetch hands the consume callback the real response, headers first', async () => {
  const seen: string[] = []
  const out = await boundedFetch(
    { url: 'https://example.test/x', timeoutMs: 5_000, label: 'GET x' },
    async (res) => {
      seen.push(`status:${res.status}`)
      return res.text()
    },
    { fetchImpl: async () => fakeResponse({ a: 1 }, { status: 200 }) },
  )
  assert.deepEqual(seen, ['status:200'])
  assert.equal(out, JSON.stringify({ a: 1 }))
})

test('boundedFetch passes an AbortSignal so a timed-out socket is actually released', async () => {
  let signal: AbortSignal | undefined
  await boundedFetch(
    { url: 'https://example.test/x', timeoutMs: 5_000, label: 'GET x' },
    async () => 'done',
    {
      fetchImpl: async (_url, init) => {
        signal = (init as { signal?: AbortSignal }).signal
        return fakeResponse({})
      },
    },
  )
  assert.ok(signal, 'no signal reached fetch: the socket could never be freed')
  assert.equal(signal!.aborted, false)
})

// ── boundedFetch: the deadline ───────────────────────────────────────────────

test('boundedFetch times out when the response never arrives, and reports it', { timeout: 3_000 }, async () => {
  const { lines, log } = collectLog()
  const started = Date.now()
  await assert.rejects(
    boundedFetch(
      { url: 'https://example.test/stall', timeoutMs: 25, label: 'GET stall' },
      async () => 'never',
      { fetchImpl: () => NEVER, log },
    ),
    (err: unknown) => {
      assert.ok(isFetchTimeoutError(err), `expected a timeout, got ${String(err)}`)
      assert.equal((err as FetchTimeoutError).timeoutMs, 25)
      assert.equal((err as FetchTimeoutError).label, 'GET stall')
      return true
    },
  )
  assert.ok(Date.now() - started < 2_000, 'the caller was not released promptly')
  assert.equal(lines.length, 1, 'a fired deadline must never be silent')
  assert.match(lines[0]!, /deadline exceeded after 25ms: GET stall/)
})

test('the deadline covers the BODY read, not only the headers', { timeout: 3_000 }, async () => {
  // The bug this pins: `fetch` resolves the moment headers land, so bounding
  // only the fetch call leaves `response.json()` free to hang forever on a
  // body that stops mid-stream. Headers arrive instantly here; the body never
  // does.
  const { lines, log } = collectLog()
  await assert.rejects(
    boundedFetch(
      { url: 'https://example.test/slowbody', timeoutMs: 25, label: 'GET slowbody' },
      async () => NEVER,
      { fetchImpl: async () => fakeResponse({}), log },
    ),
    (err: unknown) => isFetchTimeoutError(err),
  )
  assert.match(lines[0] ?? '', /GET slowbody/)
})

test('a fetch implementation that ignores the abort signal still releases the caller', { timeout: 3_000 }, async () => {
  // The deadline is a race, not only an abort, precisely so the guarantee
  // does not depend on the transport honouring the signal.
  let aborted = false
  await assert.rejects(
    boundedFetch(
      { url: 'https://example.test/rude', timeoutMs: 25, label: 'GET rude' },
      async () => 'never',
      {
        fetchImpl: async (_url, init) => {
          ;(init as { signal: AbortSignal }).signal.addEventListener(
            'abort',
            () => {
              aborted = true
            },
          )
          return NEVER
        },
      },
    ),
    (err: unknown) => isFetchTimeoutError(err),
  )
  assert.equal(aborted, true, 'the socket should still have been aborted')
})

// ── boundedFetch: a timeout is not a network error ───────────────────────────

test('a connection failure propagates unchanged and is NOT reported as a timeout', async () => {
  const { lines, log } = collectLog()
  const networkErr = new TypeError('fetch failed: ECONNREFUSED')
  await assert.rejects(
    boundedFetch(
      { url: 'https://example.test/down', timeoutMs: 5_000, label: 'GET down' },
      async () => 'never',
      {
        fetchImpl: async () => {
          throw networkErr
        },
        log,
      },
    ),
    (err: unknown) => {
      assert.equal(err, networkErr, 'the original error must survive')
      assert.equal(
        isFetchTimeoutError(err),
        false,
        'a refused connection is not a deadline: they need different responses',
      )
      return true
    },
  )
  assert.deepEqual(lines, [], 'a connection failure must not log a deadline')
})

test('an error thrown by consume propagates unchanged (a 500 is not a timeout)', async () => {
  const boom = new Error('GET 500: upstream exploded')
  await assert.rejects(
    boundedFetch(
      { url: 'https://example.test/500', timeoutMs: 5_000, label: 'GET 500' },
      async () => {
        throw boom
      },
      { fetchImpl: async () => fakeResponse({}, { status: 500 }) },
    ),
    (err: unknown) => err === boom && !isFetchTimeoutError(err),
  )
})

test('isFetchTimeoutError recognises a timeout thrown across a module boundary', () => {
  // bun and node load these files as separate module instances in CI, so the
  // predicate must not rely on `instanceof` alone.
  const lookalike = Object.assign(new Error('timed out after 1ms: GET x'), {
    name: 'FetchTimeoutError',
  })
  assert.equal(isFetchTimeoutError(lookalike), true)
  assert.equal(isFetchTimeoutError(new Error('nope')), false)
  assert.equal(isFetchTimeoutError(null), false)
  assert.equal(isFetchTimeoutError(new FetchTimeoutError('GET x', 5)), true)
})

// ── createBoundedFetchImpl: the plain typeof-fetch adapter ───────────────────

test('createBoundedFetchImpl bounds a stalled call and reports it as a timeout', { timeout: 3_000 }, async () => {
  // The fake never settles and never reacts to the abort, which is exactly
  // the case the first version of the adapter could not survive: it awaited
  // the transport and trusted it to reject on abort, so this test hung.
  const { lines, log } = collectLog()
  const bounded = createBoundedFetchImpl(25, 'update-stream', {
    fetchImpl: () => NEVER,
    log,
  })
  await assert.rejects(
    bounded('https://example.test/mint', { method: 'POST' }),
    (err: unknown) => isFetchTimeoutError(err),
  )
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /update-stream/)
})

test('createBoundedFetchImpl leaves a fast call alone and reports nothing', async () => {
  const { lines, log } = collectLog()
  const bounded = createBoundedFetchImpl(5_000, 'update-stream', {
    fetchImpl: async () => fakeResponse({ ok: true }),
    log,
  })
  const res = await bounded('https://example.test/mint', { method: 'POST' })
  assert.equal(res.status, 200)
  assert.deepEqual(lines, [])
})

// ── withDeadline: bounding work that is not a fetch ──────────────────────────

test('withDeadline returns the value when the work finishes in time', async () => {
  const out = await withDeadline(Promise.resolve('catalog'), {
    timeoutMs: 5_000,
    label: 'slash registry',
  })
  assert.equal(out, 'catalog')
  assert.equal(isDeadlineExceeded(out), false)
})

test('withDeadline gives up, says so, and never rejects', { timeout: 3_000 }, async () => {
  const { lines, log } = collectLog()
  const out = await withDeadline(NEVER, {
    timeoutMs: 25,
    label: 'slash registry walk',
    log,
  })
  assert.equal(out, DEADLINE_EXCEEDED)
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /deadline exceeded after 25ms: slash registry walk/)
})

test('withDeadline does not turn a late rejection into an unhandled rejection', async () => {
  const rejectsLater = new Promise<string>((_r, reject) =>
    setTimeout(() => reject(new Error('the walk failed after we gave up')), 5),
  )
  const out = await withDeadline(rejectsLater, { timeoutMs: 1, label: 'walk' })
  assert.equal(out, DEADLINE_EXCEEDED)
  // Give the late rejection a turn to land. If it were unhandled, node would
  // fail this test file.
  await new Promise((r) => setTimeout(r, 25))
})

test('withDeadline surfaces a failure that happens BEFORE the deadline', async () => {
  await assert.rejects(
    withDeadline(Promise.reject(new Error('readdir EACCES')), {
      timeoutMs: 5_000,
      label: 'walk',
    }),
    /readdir EACCES/,
  )
})

// ── startupPhase: the log names the phase ────────────────────────────────────

test('startupPhase brackets a phase with a start line and an ok line', async () => {
  const { lines, log } = collectLog()
  const out = await startupPhase('discover chats', async () => 7, { log })
  assert.equal(out, 7)
  assert.equal(lines.length, 2)
  assert.match(lines[0]!, /^startup phase start: discover chats$/)
  assert.match(lines[1]!, /^startup phase ok: discover chats \(\d+ms\)$/)
})

test('startupPhase names the phase AND the message when it throws, then rethrows', async () => {
  const { lines, log } = collectLog()
  await assert.rejects(
    startupPhase(
      'discover chats',
      async () => {
        throw new Error('GET 401: pairing revoked')
      },
      { log },
    ),
    /GET 401: pairing revoked/,
  )
  assert.match(lines[0]!, /^startup phase start: discover chats$/)
  assert.match(lines[1]!, /^startup phase FAILED: discover chats \(\d+ms\): GET 401: pairing revoked$/)
})

test('a phase that hangs leaves a start with no ok, which is what names the hang', async () => {
  const { lines, log } = collectLog()
  void startupPhase('capability-canon warm-up', () => NEVER, { log })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(lines, ['startup phase start: capability-canon warm-up'])
})
