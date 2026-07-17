/**
 * Poll-core: the pure decision layer for the plugin's REST polling
 * (SERVERPERF proposals P1 delta polling + P6 cadence hygiene, 2026-07-17).
 *
 * Context: the plugin fleet was 83 percent of ALL backend traffic
 * (302,410 full GET /chats/:id/messages 200s/day) because every poll
 * refetched the full newest-50 window with no If-None-Match, and any
 * meeting / pending permission / WS drop fast-polled the ENTIRE chat list
 * at 2s. The backend already supports `afterId` delta cursors
 * (chat.controller.ts declares it; message.repository.ts implements
 * `m.id > $N`) and Express weak ETags (the Hermes python client's
 * _conditional_get proves the 304 path works in production).
 *
 * Everything here is pure and unit-tested (test/poll-core.test.ts);
 * server.ts owns the impure wiring (fetch, state maps, timers).
 */

// ── NOT_MODIFIED sentinel (P1c) ──────────────────────────────────────────────
// Returned by bgosGet when the backend answers 304. A unique symbol so no
// real JSON payload can ever equal it. Every bgosGet caller must handle it:
// poll loops skip the iteration, value-returning callers go through the
// cached-body wrapper (bgosGetCachedOn304 in server.ts).

export const NOT_MODIFIED: unique symbol = Symbol('bgos.not-modified')

export function isNotModified(value: unknown): value is typeof NOT_MODIFIED {
  return value === NOT_MODIFIED
}

// ── Per-key ETag cache (P1c) ─────────────────────────────────────────────────
// Modeled on the Hermes client (hermes-channel-bgos bgos_api.py
// _conditional_get): store the validator from each 200, send If-None-Match on
// the next request for the same key, drop the validator when the server stops
// sending one (an old backend simply keeps answering 200 + full body, so this
// is safe to ship ahead of any backend change). Bounded so a long-lived
// daemon monitoring hundreds of chats cannot grow without limit; eviction is
// oldest-first (Map insertion order, refreshed on re-record).
//
// Known limit (by design, do NOT fight it here): chats containing S3 files
// never 304 because the per-poll presign refresh churns the body bytes.
// afterId is the win there: idle deltas return an empty window with no files.

export class EtagCache {
  private readonly maxEntries: number
  private readonly etags = new Map<string, string>()

  constructor(maxEntries = 2000) {
    this.maxEntries = Math.max(1, maxEntries)
  }

  /** The stored validator to send as If-None-Match, if any. */
  ifNoneMatch(key: string): string | undefined {
    return this.etags.get(key)
  }

  /** Record the validator from a 200 (null/undefined/empty clears it). */
  record(key: string, etag: string | null | undefined): void {
    if (!etag) {
      this.etags.delete(key)
      return
    }
    this.etags.delete(key)
    this.etags.set(key, etag)
    while (this.etags.size > this.maxEntries) {
      const oldest = this.etags.keys().next().value
      if (oldest === undefined) break
      this.etags.delete(oldest)
    }
  }

  /**
   * Drop the validator so the next request refetches unconditionally. Called
   * when processing failed AFTER the validator was recorded: without this, a
   * later 304 would skip rows the cursor never advanced over.
   */
  invalidate(key: string): void {
    this.etags.delete(key)
  }

  get size(): number {
    return this.etags.size
  }
}

// ── Chat poll request builder (P1a) ──────────────────────────────────────────

export interface ChatPollRequest {
  /** API path relative to /api/v1, ready for bgosGet. */
  path: string
  /** ETag cache key: per chat, stable across full and delta URLs. */
  cacheKey: string
  mode: 'full' | 'delta'
}

/**
 * Decide how to poll one chat.
 *
 *  - First poll (lastSeen 0): FULL fetch, exactly as before. The first-poll
 *    backlog heuristic in pollChat needs the whole recent window to find the
 *    last real user->assistant reply boundary.
 *  - Chat with tracked unanswered inline buttons: FULL fetch. A button click
 *    UPDATES an existing row (answeredAt flips from null) without inserting a
 *    new one, so an afterId window would never show the flip; both the
 *    button_clicked channel event and the inline permission Allow/Deny
 *    resolution depend on observing it. These chats are rare and transient
 *    (the set empties as soon as the buttons are answered or superseded).
 *  - Everything else: delta fetch with afterId=<last seen id>. Idle chats
 *    then cost an empty window that the ETag layer turns into a 304.
 *
 * The cache key is per chat rather than per URL: the delta URL changes every
 * time the cursor moves, so URL-keyed validators would never hit. Sharing one
 * key across modes is safe because a 304 means the body is byte-identical to
 * a response this plugin already fully processed.
 */
export function buildChatPollRequest(opts: {
  chatId: string
  userId: string
  lastSeen: number
  unansweredButtonCount: number
}): ChatPollRequest {
  const { chatId, userId, lastSeen, unansweredButtonCount } = opts
  const base = `chats/${chatId}/messages?userId=${userId}`
  const cacheKey = `poll:${chatId}`
  if (lastSeen <= 0 || unansweredButtonCount > 0) {
    return { path: base, cacheKey, mode: 'full' }
  }
  return { path: `${base}&afterId=${lastSeen}`, cacheKey, mode: 'delta' }
}

// ── Cursor advance (P1b) ─────────────────────────────────────────────────────

/**
 * Advance the per-chat last-seen cursor after a successfully processed poll.
 *
 * Never steps OVER a system wake card whose body has not landed yet (the
 * empty write-1 state): the cursor parks just below the lowest pending id so
 * the row stays inside every subsequent afterId window until the body-fill
 * UPDATE (same id) lands, and the body change also breaks the 304. This is
 * what keeps the scheduler wake-card body-fill path working under delta
 * polling. Never moves the cursor backward.
 */
export function advanceCursor(opts: {
  lastSeen: number
  maxId: number
  pendingEmptyIds: number[]
}): number {
  const { lastSeen, maxId, pendingEmptyIds } = opts
  const cap = pendingEmptyIds.length ? Math.min(...pendingEmptyIds) - 1 : maxId
  return Math.max(lastSeen, Math.min(maxId, cap))
}

// ── Cadence planning (P6d/P6e) ───────────────────────────────────────────────

/** WS healthy: full sweeps are a 60s heartbeat safety net (base 2s x30). */
export const HEALTHY_MULTIPLIER = 30

/**
 * WS down: the poll IS the delivery path, so the global cadence tightens,
 * but NOT to 2s: 2s sweeps of the whole 600+ chat list were the P6 storm
 * (and a sequential sweep of that size cannot finish in 2s anyway, so
 * per-chat latency was sweep-duration-bound, not interval-bound). base x5 =
 * 10s bounds worst-case delivery latency during a WS outage at one fifth of
 * the old request volume. Chats that genuinely need 2s reactivity (open
 * meetings, pending permissions) are fast-scoped individually below.
 */
export const WS_DOWN_MULTIPLIER = 5

/** Reconcile the always-on toggle every 15 min (P6e; was 2 min). The flag
 *  almost never changes and the boot-time check covers restarts; with the
 *  ETag layer the recurring fetch is usually a 304 as well. */
export const RECONCILE_ALWAYS_ON_INTERVAL_MS = 15 * 60_000

export function globalIntervalMs(
  baseIntervalMs: number,
  wsHealthy: boolean,
): number {
  return baseIntervalMs * (wsHealthy ? HEALTHY_MULTIPLIER : WS_DOWN_MULTIPLIER)
}

/**
 * The chats that need 2s reactivity RIGHT NOW: chats with an open meeting
 * (turn changes feel snappy) plus chats with a pending permission awaiting a
 * user click. Only these are polled between full sweeps; the rest of the
 * monitored set rides the global cadence.
 */
export function fastScopeChatIds(opts: {
  meetingChatIds: Iterable<string>
  pendingPermissionChatIds: Iterable<string>
}): string[] {
  const out = new Set<string>()
  for (const id of opts.meetingChatIds) out.add(String(id))
  for (const id of opts.pendingPermissionChatIds) out.add(String(id))
  return [...out]
}

export type PollCyclePlan =
  | { kind: 'full' }
  | { kind: 'fast'; chatIds: string[] }
  | { kind: 'idle' }

/**
 * Decide what one 2s scheduler tick should do:
 *  - 'full' when the global interval elapsed (or at boot): discovery + every
 *    monitored chat.
 *  - 'fast' when fast-scope chats exist between full sweeps: poll ONLY them.
 *  - 'idle' otherwise: the tick costs nothing.
 */
export function planPollCycle(opts: {
  now: number
  lastFullCycleAt: number
  wsHealthy: boolean
  baseIntervalMs: number
  fastChatIds: string[]
}): PollCyclePlan {
  const due =
    opts.lastFullCycleAt === 0 ||
    opts.now - opts.lastFullCycleAt >=
      globalIntervalMs(opts.baseIntervalMs, opts.wsHealthy)
  if (due) return { kind: 'full' }
  if (opts.fastChatIds.length > 0) {
    return { kind: 'fast', chatIds: opts.fastChatIds }
  }
  return { kind: 'idle' }
}
