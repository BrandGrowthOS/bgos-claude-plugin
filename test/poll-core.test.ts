/**
 * SERVERPERF P1 + P6: delta polling, conditional GETs, and cadence hygiene.
 *
 * Background (SERVERPERF-REPORT.md 2026-07-17): GET /chats/:id/messages was
 * 302,410 full 200s/day, 83 percent of ALL backend traffic, because every
 * plugin poll refetched the full newest-50 window and never sent
 * If-None-Match. The backend already supports `afterId` delta cursors and
 * Express weak ETags; the Hermes python client proves the conditional-GET
 * pattern works (73 percent 304 rate on integrations/inbound).
 *
 * This suite drives lib/poll-core.ts, the pure decision layer server.ts now
 * uses for:
 *   P1a  afterId delta polling (first poll stays a FULL fetch),
 *   P1b  cursor-aware empty-system-card deferral (the scheduler wake-card
 *        body-fill MUST still reach the plugin via poll),
 *   P1c  per-URL ETag cache + NOT_MODIFIED sentinel for bgosGet,
 *   P6d  fast (2s) polling scoped to affected chats only,
 *   P6e  reconcileAlwaysOn cadence 2 min -> 15 min.
 *
 * The impure wiring lives in server.ts (not importable in tests: it exits
 * without credentials at module load), so a small harness here mirrors the
 * pollChat fetch-decide-advance loop against a fake backend that honors
 * afterId and ETags, per this repo's mirror-test convention (see
 * pending-empty-system.test.ts, ws-inbound-meta.test.ts). A wiring block at
 * the bottom pins the server.ts source to the lib symbols so the mirror
 * cannot silently drift.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  NOT_MODIFIED,
  isNotModified,
  EtagCache,
  buildChatPollRequest,
  advanceCursor,
  fastScopeChatIds,
  planPollCycle,
  globalIntervalMs,
  HEALTHY_MULTIPLIER,
  WS_DOWN_MULTIPLIER,
  RECONCILE_ALWAYS_ON_INTERVAL_MS,
} from '../lib/poll-core.ts'

// ── P1c: NOT_MODIFIED sentinel ───────────────────────────────────────────────

test('NOT_MODIFIED is a distinct sentinel no real payload can equal', () => {
  assert.equal(isNotModified(NOT_MODIFIED), true)
  assert.equal(isNotModified({}), false)
  assert.equal(isNotModified(null), false)
  assert.equal(isNotModified(undefined), false)
  assert.equal(isNotModified({ messages: [] }), false)
  assert.equal(isNotModified('not-modified'), false)
})

// ── P1c: EtagCache (modeled on Hermes bgos_api.py _conditional_get) ──────────

test('EtagCache: no validator before the first 200', () => {
  const cache = new EtagCache()
  assert.equal(cache.ifNoneMatch('poll:1'), undefined)
})

test('EtagCache: records a validator and returns it for the next request', () => {
  const cache = new EtagCache()
  cache.record('poll:1', 'W/"abc"')
  assert.equal(cache.ifNoneMatch('poll:1'), 'W/"abc"')
  assert.equal(cache.ifNoneMatch('poll:2'), undefined, 'per-key isolation')
})

test('EtagCache: a 200 without an ETag header clears the stored validator', () => {
  // Hermes: "drop it if the server stopped sending one".
  const cache = new EtagCache()
  cache.record('poll:1', 'W/"abc"')
  cache.record('poll:1', null)
  assert.equal(cache.ifNoneMatch('poll:1'), undefined)
})

test('EtagCache: invalidate drops the validator so the next poll refetches', () => {
  // server.ts calls this from pollChat's catch: an error after the ETag was
  // recorded must not let a later 304 skip rows the cursor never advanced over.
  const cache = new EtagCache()
  cache.record('poll:1', 'W/"abc"')
  cache.invalidate('poll:1')
  assert.equal(cache.ifNoneMatch('poll:1'), undefined)
})

test('EtagCache: bounded, evicts the oldest key beyond maxEntries', () => {
  const cache = new EtagCache(3)
  cache.record('a', '"1"')
  cache.record('b', '"2"')
  cache.record('c', '"3"')
  cache.record('d', '"4"')
  assert.equal(cache.size, 3)
  assert.equal(cache.ifNoneMatch('a'), undefined, 'oldest evicted')
  assert.equal(cache.ifNoneMatch('d'), '"4"')
})

test('EtagCache: re-recording a key refreshes its recency', () => {
  const cache = new EtagCache(2)
  cache.record('a', '"1"')
  cache.record('b', '"2"')
  cache.record('a', '"1b"')
  cache.record('c', '"3"')
  assert.equal(cache.ifNoneMatch('b'), undefined, 'b was the oldest, evicted')
  assert.equal(cache.ifNoneMatch('a'), '"1b"')
  assert.equal(cache.ifNoneMatch('c'), '"3"')
})

// ── P1a: buildChatPollRequest (afterId cursor) ───────────────────────────────

test('first poll (no cursor) is a FULL fetch without afterId', () => {
  const req = buildChatPollRequest({
    chatId: '946',
    userId: 'user_1',
    lastSeen: 0,
    unansweredButtonCount: 0,
  })
  assert.equal(req.mode, 'full')
  assert.equal(req.path, 'chats/946/messages?userId=user_1')
  assert.ok(!req.path.includes('afterId'), 'first poll must not pass afterId')
})

test('subsequent polls pass afterId=<last seen id>', () => {
  const req = buildChatPollRequest({
    chatId: '946',
    userId: 'user_1',
    lastSeen: 4711,
    unansweredButtonCount: 0,
  })
  assert.equal(req.mode, 'delta')
  assert.equal(req.path, 'chats/946/messages?userId=user_1&afterId=4711')
})

test('a chat with tracked unanswered inline buttons keeps FULL fetching', () => {
  // A button click UPDATES an existing row (answeredAt flips) without
  // inserting a new one, so a delta response would never show the flip;
  // the permission inline-button resolution path depends on seeing it.
  const req = buildChatPollRequest({
    chatId: '946',
    userId: 'user_1',
    lastSeen: 4711,
    unansweredButtonCount: 2,
  })
  assert.equal(req.mode, 'full')
  assert.ok(!req.path.includes('afterId'))
})

test('the ETag cache key is per chat and stable across full and delta modes', () => {
  // The delta URL changes every time the cursor moves; keying the validator
  // by URL would never hit. One key per chat is safe: a 304 means the body
  // is byte-identical to a response this plugin already fully processed.
  const full = buildChatPollRequest({
    chatId: '946', userId: 'u', lastSeen: 0, unansweredButtonCount: 0,
  })
  const delta = buildChatPollRequest({
    chatId: '946', userId: 'u', lastSeen: 10, unansweredButtonCount: 0,
  })
  assert.equal(full.cacheKey, delta.cacheKey)
  const other = buildChatPollRequest({
    chatId: '947', userId: 'u', lastSeen: 10, unansweredButtonCount: 0,
  })
  assert.notEqual(full.cacheKey, other.cacheKey)
})

// ── P1b: cursor advance (extracted from pollChat, same invariants) ───────────

test('cursor advances to maxId when nothing is deferred', () => {
  assert.equal(advanceCursor({ lastSeen: 10, maxId: 42, pendingEmptyIds: [] }), 42)
})

test('cursor parks just below the lowest pending empty-system id', () => {
  assert.equal(
    advanceCursor({ lastSeen: 99, maxId: 102, pendingEmptyIds: [100] }),
    99,
  )
  assert.equal(
    advanceCursor({ lastSeen: 99, maxId: 105, pendingEmptyIds: [103, 101] }),
    100,
  )
})

test('cursor never moves backward', () => {
  assert.equal(
    advanceCursor({ lastSeen: 150, maxId: 160, pendingEmptyIds: [101] }),
    150,
  )
  assert.equal(advanceCursor({ lastSeen: 150, maxId: 120, pendingEmptyIds: [] }), 150)
})

// ── P1a+P1b harness: pollChat loop against an afterId+ETag fake backend ──────
//
// Mirrors the pollChat decision pipeline: build request -> fetch (fake
// backend honoring afterId and If-None-Match) -> filter forwardable rows ->
// advanceCursor. Keep in lockstep with server.ts pollChat.

interface Row {
  id: number
  sender: 'user' | 'assistant' | 'system'
  text: string | null
}

function isPendingEmptySystem(r: Row): boolean {
  return r.sender === 'system' && (r.text ?? '').trim().length === 0
}

interface FakeBackend {
  rows: Row[]
  requests: string[]
  status200: number
  status304: number
}

function serve(
  backend: FakeBackend,
  path: string,
  cache: EtagCache,
  cacheKey: string,
): Row[] | typeof NOT_MODIFIED {
  backend.requests.push(path)
  const afterMatch = /afterId=(\d+)/.exec(path)
  const afterId = afterMatch ? Number(afterMatch[1]) : 0
  const body = backend.rows.filter((r) => r.id > afterId)
  // Express-style weak validator: derived from the exact body bytes.
  const etag = `W/"${JSON.stringify(body).length}-${body.map((r) => `${r.id}:${(r.text ?? '').length}`).join(',')}"`
  if (cache.ifNoneMatch(cacheKey) === etag) {
    backend.status304++
    return NOT_MODIFIED
  }
  backend.status200++
  cache.record(cacheKey, etag)
  return body
}

interface HarnessState {
  cursor: number
  unansweredButtonCount: number
}

function pollOnce(
  backend: FakeBackend,
  state: HarnessState,
  cache: EtagCache,
): { forwarded: number[]; notModified: boolean } {
  const req = buildChatPollRequest({
    chatId: '1',
    userId: 'u',
    lastSeen: state.cursor,
    unansweredButtonCount: state.unansweredButtonCount,
  })
  const result = serve(backend, req.path, cache, req.cacheKey)
  if (isNotModified(result)) return { forwarded: [], notModified: true }
  if (result.length === 0) return { forwarded: [], notModified: false }
  const ordered = [...result].sort((a, b) => a.id - b.id)
  const maxId = Math.max(...ordered.map((r) => r.id))
  const forwarded = ordered
    .filter(
      (r) =>
        r.id > state.cursor &&
        (r.sender === 'user' || r.sender === 'system') &&
        !isPendingEmptySystem(r),
    )
    .map((r) => r.id)
  const pendingEmptyIds = ordered
    .filter(isPendingEmptySystem)
    .map((r) => r.id)
  state.cursor = advanceCursor({ lastSeen: state.cursor, maxId, pendingEmptyIds })
  return { forwarded, notModified: false }
}

test('poll sequence: first full fetch, then deltas that only carry new rows', () => {
  const backend: FakeBackend = {
    rows: [
      { id: 1, sender: 'user', text: 'hi' },
      { id: 2, sender: 'assistant', text: 'hello' },
    ],
    requests: [],
    status200: 0,
    status304: 0,
  }
  const cache = new EtagCache()
  const state: HarnessState = { cursor: 0, unansweredButtonCount: 0 }

  const p1 = pollOnce(backend, state, cache)
  assert.equal(backend.requests[0], 'chats/1/messages?userId=u', 'first poll is full')
  assert.equal(state.cursor, 2)
  assert.equal(p1.notModified, false)

  // Nothing new: the first delta returns an empty window (a tiny 200, its
  // body differs from the full window so the validator rolls over) and every
  // repeat delta after that 304s.
  const p2 = pollOnce(backend, state, cache)
  assert.equal(backend.requests[1], 'chats/1/messages?userId=u&afterId=2')
  assert.equal(p2.notModified, false)
  assert.deepEqual(p2.forwarded, [], 'empty delta window forwards nothing')
  assert.equal(state.cursor, 2, 'an empty window never moves the cursor')

  const p3 = pollOnce(backend, state, cache)
  assert.equal(p3.notModified, true, 'idle chat settles into 304s')
  assert.equal(state.cursor, 2, 'a 304 never moves the cursor')

  // A new user message lands: the delta returns ONLY it.
  backend.rows.push({ id: 3, sender: 'user', text: 'are you there?' })
  const p4 = pollOnce(backend, state, cache)
  assert.deepEqual(p4.forwarded, [3])
  assert.equal(state.cursor, 3)

  // Empty window again (new afterId, same empty body as before does not
  // match the p4 validator), then back to 304s.
  const p5 = pollOnce(backend, state, cache)
  assert.equal(p5.notModified, false)
  assert.deepEqual(p5.forwarded, [])
  const p6 = pollOnce(backend, state, cache)
  assert.equal(p6.notModified, true)
  assert.equal(backend.status200, 4)
  assert.equal(backend.status304, 2)
})

test('scheduler wake-card body-fill still reaches the plugin under delta polling', () => {
  // The two-step wake-card write: an EMPTY system row lands first, the body
  // is filled by a later UPDATE against the SAME id, and that second write
  // only ever reaches the plugin via poll. The deferral must be cursor-aware:
  // parking the cursor below the pending id keeps the row inside every
  // subsequent afterId window until the body lands.
  const backend: FakeBackend = {
    rows: [{ id: 50, sender: 'user', text: 'seen already' }],
    requests: [],
    status200: 0,
    status304: 0,
  }
  const cache = new EtagCache()
  const state: HarnessState = { cursor: 0, unansweredButtonCount: 0 }
  pollOnce(backend, state, cache)
  assert.equal(state.cursor, 50)

  // Write 1: the empty wake card appears.
  backend.rows.push({ id: 51, sender: 'system', text: '' })
  const p2 = pollOnce(backend, state, cache)
  assert.deepEqual(p2.forwarded, [], 'empty wake card is deferred, not forwarded')
  assert.equal(state.cursor, 50, 'cursor parks below the pending id')

  // Idle poll while the body has not landed: 304, still deferred.
  const p3 = pollOnce(backend, state, cache)
  assert.equal(p3.notModified, true)
  assert.equal(state.cursor, 50)

  // Write 2: the body fills on the SAME id. The delta window (afterId=50)
  // still contains id 51, and the body change breaks the 304.
  backend.rows[1] = { id: 51, sender: 'system', text: 'Scheduled check-in: review the board' }
  const p4 = pollOnce(backend, state, cache)
  assert.deepEqual(p4.forwarded, [51], 'the filled wake card is delivered via poll')
  assert.equal(state.cursor, 51)
  assert.ok(
    backend.requests.every(
      (r, i) => i === 0 || r.includes('afterId='),
      'every post-first poll stayed a delta request',
    ),
  )
})

test('a fetch or processing error never advances the cursor (redelivery beats loss)', () => {
  const backend: FakeBackend = {
    rows: [{ id: 10, sender: 'user', text: 'a' }],
    requests: [],
    status200: 0,
    status304: 0,
  }
  const cache = new EtagCache()
  const state: HarnessState = { cursor: 0, unansweredButtonCount: 0 }
  pollOnce(backend, state, cache)
  assert.equal(state.cursor, 10)

  // New row lands, but this poll dies mid-processing (server.ts catch path):
  // the cursor is untouched and the validator is invalidated, so the NEXT
  // poll refetches the same window instead of 304-skipping the row.
  backend.rows.push({ id: 11, sender: 'user', text: 'b' })
  const req = buildChatPollRequest({
    chatId: '1', userId: 'u', lastSeen: state.cursor, unansweredButtonCount: 0,
  })
  const body = serve(backend, req.path, cache, req.cacheKey)
  assert.ok(!isNotModified(body), 'the new row produced a 200')
  cache.invalidate(req.cacheKey) // what server.ts does in pollChat's catch

  const retry = pollOnce(backend, state, cache)
  assert.deepEqual(retry.forwarded, [11], 'row redelivered after the failed poll')
  assert.equal(state.cursor, 11)
})

// ── P1c: sentinel handling mirror for the value-returning bgosGet callers ────

test('cached-body callers reuse the last 200 body on a 304 (bgosGetCachedOn304 mirror)', () => {
  // Mirror of server.ts bgosGetCachedOn304: mission/meetings/identity/
  // reconcile need a VALUE every call, so a 304 answers from the body cache
  // recorded alongside the validator.
  const bodyCache = new Map<string, unknown>()
  const resolve = (path: string, raw: unknown): unknown => {
    if (!isNotModified(raw)) {
      bodyCache.set(path, raw)
      return raw
    }
    assert.ok(bodyCache.has(path), '304 implies a previously stored body')
    return bodyCache.get(path)
  }
  const first = resolve('assistants/900', { alwaysOn: true })
  assert.deepEqual(first, { alwaysOn: true })
  const second = resolve('assistants/900', NOT_MODIFIED)
  assert.deepEqual(second, { alwaysOn: true }, '304 resolves to the cached body')
})

// ── P6d: fast (2s) mode scoped to the affected chats only ────────────────────

test('fast scope is the union of open-meeting chats and pending-permission chats', () => {
  const scope = fastScopeChatIds({
    meetingChatIds: new Set(['1050', '1051']),
    pendingPermissionChatIds: ['946', '1050'],
  })
  assert.deepEqual([...scope].sort(), ['1050', '1051', '946'].sort())
})

test('fast scope is empty when nothing needs 2s reactivity', () => {
  assert.deepEqual(
    fastScopeChatIds({ meetingChatIds: new Set(), pendingPermissionChatIds: [] }),
    [],
  )
})

test('WS healthy + nothing fast: the cycle idles between 60s full sweeps', () => {
  const base = 2000
  const plan = planPollCycle({
    now: 10_000,
    lastFullCycleAt: 8_000,
    wsHealthy: true,
    baseIntervalMs: base,
    fastChatIds: [],
  })
  assert.deepEqual(plan, { kind: 'idle' })
})

test('a full sweep runs when the global interval elapses (60s WS-healthy)', () => {
  const base = 2000
  assert.equal(globalIntervalMs(base, true), base * HEALTHY_MULTIPLIER)
  assert.equal(base * HEALTHY_MULTIPLIER, 60_000, 'WS-healthy cadence stays 60s')
  const plan = planPollCycle({
    now: 61_000,
    lastFullCycleAt: 0o0 + 1_000,
    wsHealthy: true,
    baseIntervalMs: base,
    fastChatIds: [],
  })
  assert.deepEqual(plan, { kind: 'full' })
})

test('an open meeting fast-polls THAT chat, not the whole list', () => {
  const plan = planPollCycle({
    now: 10_000,
    lastFullCycleAt: 8_000,
    wsHealthy: true,
    baseIntervalMs: 2000,
    fastChatIds: ['1050'],
  })
  assert.deepEqual(plan, { kind: 'fast', chatIds: ['1050'] })
})

test('a pending permission fast-polls its chat between full sweeps', () => {
  const plan = planPollCycle({
    now: 12_000,
    lastFullCycleAt: 10_000,
    wsHealthy: true,
    baseIntervalMs: 2000,
    fastChatIds: ['946'],
  })
  assert.deepEqual(plan, { kind: 'fast', chatIds: ['946'] })
})

test('WS down: full sweeps at 10s (base x5), NEVER the whole list at 2s', () => {
  // Rationale (P6d): with the WS down the poll IS the delivery path, so the
  // global cadence tightens, but 2s sweeps of 600+ chats were the P6 storm.
  // base x5 = 10s bounds worst-case delivery latency during a WS outage at
  // one fifth of the old request volume; scoped fast chats below still get 2s.
  const base = 2000
  assert.equal(WS_DOWN_MULTIPLIER, 5)
  assert.equal(globalIntervalMs(base, false), 10_000)

  // 4s after the last sweep: NOT due yet (would have been due under the old
  // global 2s fast mode).
  const notDue = planPollCycle({
    now: 14_000,
    lastFullCycleAt: 10_000,
    wsHealthy: false,
    baseIntervalMs: base,
    fastChatIds: [],
  })
  assert.deepEqual(notDue, { kind: 'idle' })

  const due = planPollCycle({
    now: 20_000,
    lastFullCycleAt: 10_000,
    wsHealthy: false,
    baseIntervalMs: base,
    fastChatIds: [],
  })
  assert.deepEqual(due, { kind: 'full' })
})

test('WS down + open meeting: the meeting chat still gets 2s ticks between sweeps', () => {
  const plan = planPollCycle({
    now: 14_000,
    lastFullCycleAt: 10_000,
    wsHealthy: false,
    baseIntervalMs: 2000,
    fastChatIds: ['1050'],
  })
  assert.deepEqual(plan, { kind: 'fast', chatIds: ['1050'] })
})

test('boot state (lastFullCycleAt=0) always runs a full sweep first', () => {
  const plan = planPollCycle({
    now: 5,
    lastFullCycleAt: 0,
    wsHealthy: true,
    baseIntervalMs: 2000,
    fastChatIds: ['1050'],
  })
  assert.deepEqual(plan, { kind: 'full' })
})

// ── P6e: reconcileAlwaysOn cadence ───────────────────────────────────────────

test('reconcileAlwaysOn cadence is 15 minutes (was 2)', () => {
  assert.equal(RECONCILE_ALWAYS_ON_INTERVAL_MS, 15 * 60_000)
})

// ── Wiring pins: server.ts must actually use this module ─────────────────────
// server.ts cannot be imported in tests (it exits without credentials at
// module load), so pin the load-bearing call sites textually. If any of these
// fail, the mirror harness above no longer reflects production code.

const serverSource = readFileSync(
  new URL('../server.ts', import.meta.url),
  'utf8',
)

test('server.ts polls chats through buildChatPollRequest (afterId delta path)', () => {
  assert.ok(serverSource.includes('buildChatPollRequest('))
  assert.ok(
    serverSource.includes('bgosGet(req.path, { cacheKey: req.cacheKey })'),
    'pollChat must fetch through the built request (afterId + per-chat ETag key)',
  )
})

test('server.ts advances the poll cursor through advanceCursor', () => {
  assert.ok(serverSource.includes('advanceCursor('))
})

test('server.ts handles the NOT_MODIFIED sentinel at bgosGet call sites', () => {
  assert.ok(serverSource.includes('isNotModified('))
  assert.ok(
    serverSource.includes('bgosGetCachedOn304('),
    'value-returning callers go through the cached-body wrapper',
  )
})

test('server.ts schedules polls through planPollCycle and fastScopeChatIds', () => {
  assert.ok(serverSource.includes('planPollCycle('))
  assert.ok(serverSource.includes('fastScopeChatIds('))
})

test('server.ts reconciles always-on every RECONCILE_ALWAYS_ON_INTERVAL_MS', () => {
  assert.ok(
    serverSource.includes(
      'setInterval(() => void reconcileAlwaysOn(), RECONCILE_ALWAYS_ON_INTERVAL_MS)',
    ),
  )
  assert.ok(
    !serverSource.includes('setInterval(() => void reconcileAlwaysOn(), 2 * 60_000)'),
    'the old 2 minute reconcile cadence must be gone',
  )
})
