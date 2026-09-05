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

/** The author fields needed to reject a polled copy of our own peer send. */
export interface PollMessageAuthor {
  sender: string | null
  senderAssistantId?: unknown
  sender_assistant_id?: unknown
}

function finiteAssistantId(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Fail-open poll author filter. Only a user-slot row with explicit, finite
 * provenance matching this assistant is suppressed. Human, legacy, malformed,
 * system, and assistant rows remain eligible for the normal forwarding rules.
 */
export function shouldForwardPollMessage(
  message: PollMessageAuthor,
  assistantId: string | number,
): boolean {
  if (message.sender !== 'user') return true
  const ownId = finiteAssistantId(assistantId)
  if (ownId === null) return true
  const authorIds = [message.senderAssistantId, message.sender_assistant_id]
  return !authorIds.some((value) => finiteAssistantId(value) === ownId)
}

/**
 * Claim the top-level messageId returned by an outbound peer-style send.
 * Null, missing, and malformed ids are ignored.
 */
export function rememberReturnedMessageId(
  result: unknown,
  rememberForwarded: (messageId: number) => void,
): number | null {
  if (result === null || typeof result !== 'object') return null
  const raw = (result as { messageId?: unknown }).messageId
  if (raw === null || raw === undefined) return null
  const messageId = Number(raw)
  if (!Number.isFinite(messageId)) return null
  rememberForwarded(messageId)
  return messageId
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
 *  - forceFull (a chat's first poll after boot, now that cursors persist
 *    across restarts): FULL fetch. The unanswered-inline-button baseline is
 *    in-memory and lost on restart, and a delta window cannot contain the
 *    OLDER assistant rows that still have open buttons, so without one full
 *    boot fetch a click on a pre-restart button would never be detected.
 *    Costs exactly what the pre-persistence restart poll cost (that one was
 *    a full fetch too, via lastSeen 0).
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
  forceFull?: boolean
}): ChatPollRequest {
  const { chatId, userId, lastSeen, unansweredButtonCount, forceFull } = opts
  const base = `chats/${chatId}/messages?userId=${userId}`
  const cacheKey = `poll:${chatId}`
  if (lastSeen <= 0 || unansweredButtonCount > 0 || forceFull) {
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

// ── First-poll backlog selection + first-run gate (restart-replay fix) ───────

/**
 * On a genuine first install there is no cursor file at all, so EVERY chat
 * looks new. Dormant history must not be delivered then: only messages sent
 * within this window before daemon start qualify for the first-poll backlog.
 */
export const FIRST_RUN_RECENT_WINDOW_MS = 10 * 60_000

/** Parse a message sentDate into epoch ms; null when absent or unparseable. */
export function sentDateToMs(sentDate: string | null | undefined): number | null {
  if (!sentDate) return null
  const t = Date.parse(sentDate)
  return Number.isFinite(t) ? t : null
}

/** The projection of a chat message that first-poll selection needs. */
export interface FirstPollRow {
  id: number
  sender: string | null
  /** True for a system wake card still in its empty write-1 state. */
  pendingEmptySystem: boolean
  sentDateMs: number | null
}

/**
 * Decide which messages the FIRST poll for a chat (no cursor yet) forwards
 * as [backlog]. Extracted verbatim from pollChat so it is testable and so
 * the first-run gate has one home.
 *
 * The walk-back heuristic (unchanged from the inline original): scan from
 * the newest row backward, collecting user/system messages, and stop only
 * at a real user->assistant REPLY (an assistant row whose immediately
 * preceding row is a user row). Proactive assistant rows (preceded by
 * another assistant row, or by nothing) do not terminate the scan, and
 * pending-empty system rows are skipped (the cursor parks under them so a
 * later poll re-reads them once the body fills). Capped to the newest
 * `maxForward` rows so a busy chat cannot dump half its history.
 *
 * The gate: with `recentCutoffMs` set (genuine first run, no cursor file),
 * only collected rows sent at or after the cutoff qualify. Rows with an
 * unknown sent date do not qualify, unknown age must not read as recent.
 * With `recentCutoffMs` null (a cursor file existed, this chat is genuinely
 * new to us) the collection is returned ungated, the old behavior.
 *
 * Rows must be ordered oldest -> newest by id; returned ids keep that order.
 */
export function selectFirstPollBacklogIds(opts: {
  rows: FirstPollRow[]
  maxForward: number
  recentCutoffMs: number | null
}): number[] {
  const { rows, maxForward, recentCutoffMs } = opts
  const collected: FirstPollRow[] = []
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i]!
    if (m.pendingEmptySystem) continue
    if (m.sender === 'user' || m.sender === 'system') {
      collected.push(m)
      if (collected.length >= maxForward) break
      continue
    }
    if (m.sender === 'assistant') {
      const prev = i > 0 ? rows[i - 1]! : null
      if (prev && prev.sender === 'user') {
        // Real reply, everything older was handled. Stop here.
        break
      }
      // Proactive assistant message, keep scanning backward.
    }
  }
  collected.reverse()
  const qualified =
    recentCutoffMs === null
      ? collected
      : collected.filter((m) => m.sentDateMs !== null && m.sentDateMs >= recentCutoffMs)
  return qualified.map((m) => m.id)
}

// ── Button-click transition detection (single-announce contract) ─────────────

/** The projection of a polled message that click detection needs. */
export interface ClickRow {
  id: number
  sender: string | null
  messageType?: string | null
  /** True when the row still carries option buttons. */
  hasOptions: boolean
  /** True once `answered_at` is set on the row. */
  answered: boolean
}

/**
 * Decide which button clicks THIS poll should announce to the agent, and what
 * the chat's unanswered-button set becomes.
 *
 * THE SINGLE-ANNOUNCE CONTRACT. This poll is the ONLY path by which a Claude
 * Code agent learns about a button tap: the daemon registers no `inbound_click`
 * WS listener, and the backend correspondingly withholds that push from
 * unpaired assistants (backend `message.service.ts`, `if (pairingId !== null)`,
 * pinned by `message.service.click-delivery.spec.ts`). A tap must therefore be
 * announced exactly once here, no matter how many times the message is polled
 * afterwards, and anyone adding a WS listener must retire this detector in the
 * same change or the agent hears every tap twice.
 *
 * The rule (extracted verbatim from pollChat, behaviour unchanged): announce a
 * message only on a real live transition, i.e. we saw THIS id unanswered on a
 * previous poll and it is answered now. That is what makes it once-only:
 * announcing removes the id from the set (it is answered, so it does not go
 * into `nextUnanswered`), so a later poll of the same answered row finds no
 * prior unanswered entry and stays silent.
 *
 * On the FIRST poll for a chat we only baseline the unanswered set and never
 * announce. Historic clicks from before the daemon started are not replayed
 * (they once were, which flooded Claude Code's context on every restart).
 *
 * `ask_user_input` rows are excluded: that tool owns its own polling, so
 * announcing here would be a second delivery of the same answer.
 */
export function selectClickTransitions(opts: {
  rows: ClickRow[]
  prevUnanswered: ReadonlySet<number>
  isFirstPoll: boolean
}): { announce: number[]; nextUnanswered: Set<number> } {
  const announce: number[] = []
  const nextUnanswered = new Set<number>()
  for (const row of opts.rows) {
    if (row.sender !== 'assistant') continue
    if (row.messageType === 'ask_user_input') continue
    if (!row.hasOptions) continue
    if (!row.answered) {
      nextUnanswered.add(row.id)
      continue
    }
    if (opts.isFirstPoll) continue
    if (!opts.prevUnanswered.has(row.id)) continue
    announce.push(row.id)
  }
  return { announce, nextUnanswered }
}

// ── Cadence planning (P6d/P6e) ───────────────────────────────────────────────

/**
 * WS healthy: the full sweep is NOT the delivery path, it is the recovery
 * guarantee that makes the push model safe. Live traffic arrives on the
 * `inbound_message` WS event; this sweep exists to heal the cases push cannot
 * (an event emitted while we were mid-reconnect, a room we were silently
 * dropped from, a body that changed without an event).
 *
 * 5 minutes, raised from 60s (egress audit 2026-07-26). At 60s the sweep was
 * the single largest source of traffic on the whole platform: agent daemons
 * were ~98% of egress and ~975 chat-history requests/min came from this one
 * timer. Five minutes keeps the recovery guarantee while costing a fifth of
 * the requests.
 *
 * The cost is bounded and is NOT delivery latency in the normal case:
 *   - push delivery is unchanged;
 *   - a WS RECONNECT does not wait for this interval, `connect` fires an
 *     immediate `pollAllChats()` catch-up (server.ts), so an outage is healed
 *     on reconnect, not on the next sweep;
 *   - while the WS is down the cadence is WS_DOWN_FULL_SWEEP_INTERVAL_MS, not
 *     this;
 *   - chats that need real reactivity (open meetings, pending permissions)
 *     are fast-scoped at the base tick between sweeps.
 * What DOES get slower is the one case where the socket reports `connected`
 * but is not actually receiving (a silent room drop): worst-case detection
 * moves from 60s to 5 min. That is the deliberate trade.
 */
export const HEALTHY_FULL_SWEEP_INTERVAL_MS = 5 * 60_000

/**
 * WS down: the poll IS the delivery path, so the global cadence tightens,
 * but NOT to the 2s base: 2s sweeps of the whole 600+ chat list were the P6
 * storm (and a sequential sweep of that size cannot finish in 2s anyway, so
 * per-chat latency was sweep-duration-bound, not interval-bound). 10s bounds
 * worst-case delivery latency during a WS outage at a fraction of the old
 * request volume. Chats that genuinely need 2s reactivity (open meetings,
 * pending permissions) are fast-scoped individually below.
 */
export const WS_DOWN_FULL_SWEEP_INTERVAL_MS = 10_000

/** Reconcile the always-on toggle every 15 min (P6e; was 2 min). The flag
 *  almost never changes and the boot-time check covers restarts; with the
 *  ETag layer the recurring fetch is usually a 304 as well. */
export const RECONCILE_ALWAYS_ON_INTERVAL_MS = 15 * 60_000

/**
 * The full-sweep cadence, as an ABSOLUTE interval.
 *
 * This used to be a multiple of the scheduler's base tick
 * (`base * HEALTHY_MULTIPLIER`), which made the recovery cadence an accident
 * of BGOS_POLL_INTERVAL_MS: an operator who tuned the tick silently retuned
 * the safety net with it. The sweep is a wall-clock guarantee, so it is
 * expressed in wall-clock time. `Math.max` keeps it coherent for an operator
 * who sets a base tick coarser than the target: a sweep can never be due more
 * often than the scheduler ticks.
 */
export function globalIntervalMs(
  baseIntervalMs: number,
  wsHealthy: boolean,
): number {
  const target = wsHealthy
    ? HEALTHY_FULL_SWEEP_INTERVAL_MS
    : WS_DOWN_FULL_SWEEP_INTERVAL_MS
  return Math.max(baseIntervalMs, target)
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
  /** Chats with a fresh inline-button prompt (see activeButtonPromptChatIds). */
  buttonPromptChatIds?: Iterable<string>
}): string[] {
  const out = new Set<string>()
  for (const id of opts.meetingChatIds) out.add(String(id))
  for (const id of opts.pendingPermissionChatIds) out.add(String(id))
  for (const id of opts.buttonPromptChatIds ?? []) out.add(String(id))
  return [...out]
}

/**
 * The latest inline-button prompt this daemon sent in a chat. One record per
 * chat on purpose: a later prompt replaces it, and a later reply WITHOUT
 * buttons deletes it (the agent answered in words, the chips are moot).
 */
export type ButtonPromptRecord = { messageId: number; sentAtMs: number }

/** A prompt older than this no longer earns 2s polling: someone who has not
 *  tapped in ten minutes is not about to, and the healthy sweep still catches
 *  a late tap. Without a bound an abandoned prompt pins its chat at 2s forever
 *  (Ares, 2026-09-05: a busy chat accumulates them faster than they resolve). */
export const BUTTON_PROMPT_FAST_WINDOW_MS = 10 * 60_000
/** Upper bound on chats fast-polled for prompts at once, newest first. */
export const BUTTON_PROMPT_FAST_CAP = 8

/**
 * Which chats currently earn 2s polling because this daemon sent an inline
 * button prompt there and has not seen the tap yet. Why this exists: without
 * the Agent Update Stream (off unless BGOS_UPDATE_STREAM=true) a click can
 * only reach the daemon on the chat sweep, and the WS-healthy sweep is a five
 * minute cycle (globalIntervalMs). Text rides the WS at once; a tap waited
 * up to five minutes. Kc saw 4.5 and 5.5 minutes on 2026-09-05.
 */
export function activeButtonPromptChatIds(
  prompts: ReadonlyMap<string, ButtonPromptRecord>,
  nowMs: number,
  opts: { windowMs?: number; cap?: number } = {},
): string[] {
  const windowMs = opts.windowMs ?? BUTTON_PROMPT_FAST_WINDOW_MS
  const cap = opts.cap ?? BUTTON_PROMPT_FAST_CAP
  return [...prompts.entries()]
    .filter(([, p]) => nowMs - p.sentAtMs >= 0 && nowMs - p.sentAtMs < windowMs)
    .sort((a, b) => b[1].sentAtMs - a[1].sentAtMs)
    .slice(0, Math.max(0, cap))
    .map(([chatId]) => chatId)
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
