/**
 * First-poll backlog selection + the first-run gate (restart-replay fix).
 *
 * pollChat's lastSeen === 0 branch used to inline the "collect trailing
 * unanswered user/system messages" walk-back. That heuristic is correct for
 * a chat we have never seen, but combined with the in-memory cursor map it
 * ran for EVERY chat on EVERY restart and replayed weeks-old tails as
 * [backlog]. The selection now lives in lib/poll-core.ts
 * (selectFirstPollBacklogIds) so it can be driven directly, and it takes a
 * recency cutoff for the genuine first-install case:
 *
 *   - Cursor file existed at boot (normal restart): a chat with no cursor is
 *     genuinely new to us, the walk-back runs ungated (cutoff null), exactly
 *     the old behavior.
 *   - No cursor file at all (first install, or an unreadable store): dormant
 *     history must NOT be delivered. Only messages sent within the recent
 *     window (daemon start minus 10 minutes) qualify; each chat's cursor
 *     still initializes to its tip so the next poll is a delta poll.
 *
 * The backlog FRAMING is preserved for whatever the selection returns; the
 * gate only stops ancient tails from qualifying.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  selectFirstPollBacklogIds,
  sentDateToMs,
  advanceCursor,
  FIRST_RUN_RECENT_WINDOW_MS,
  type FirstPollRow,
} from '../lib/poll-core.js'

const DAEMON_START_MS = 1_800_000_000_000
const CUTOFF = DAEMON_START_MS - FIRST_RUN_RECENT_WINDOW_MS
const ANCIENT = DAEMON_START_MS - 30 * 24 * 3_600_000
const RECENT = DAEMON_START_MS - 60_000

function row(
  id: number,
  sender: string | null,
  opts: { pendingEmpty?: boolean; sentMs?: number | null } = {},
): FirstPollRow {
  return {
    id,
    sender,
    pendingEmptySystem: opts.pendingEmpty ?? false,
    sentDateMs: opts.sentMs === undefined ? RECENT : opts.sentMs,
  }
}

// ── The first-run gate ───────────────────────────────────────────────────────

test('first run: an ancient dormant tail is NOT delivered', () => {
  const rows = [
    row(10, 'user', { sentMs: ANCIENT }),
    row(11, 'user', { sentMs: ANCIENT }),
    row(12, 'system', { sentMs: ANCIENT }),
  ]
  const ids = selectFirstPollBacklogIds({ rows, maxForward: 10, recentCutoffMs: CUTOFF })
  assert.deepEqual(ids, [], 'June-era messages must not replay on first install')
})

test('first run: only messages inside the recent window qualify', () => {
  const rows = [
    row(10, 'user', { sentMs: ANCIENT }),
    row(11, 'user', { sentMs: ANCIENT }),
    row(12, 'user', { sentMs: RECENT }),
  ]
  const ids = selectFirstPollBacklogIds({ rows, maxForward: 10, recentCutoffMs: CUTOFF })
  assert.deepEqual(ids, [12], 'the fresh message keeps its backlog delivery')
})

test('first run: a message with an unparseable sent date is not delivered', () => {
  const rows = [row(10, 'user', { sentMs: null })]
  assert.deepEqual(
    selectFirstPollBacklogIds({ rows, maxForward: 10, recentCutoffMs: CUTOFF }),
    [],
    'unknown age must not qualify as recent',
  )
})

test('first run: the recent window is 10 minutes', () => {
  assert.equal(FIRST_RUN_RECENT_WINDOW_MS, 10 * 60_000)
  const justInside = row(10, 'user', { sentMs: CUTOFF })
  const justOutside = row(11, 'user', { sentMs: CUTOFF - 1 })
  assert.deepEqual(
    selectFirstPollBacklogIds({
      rows: [justOutside, justInside],
      maxForward: 10,
      recentCutoffMs: CUTOFF,
    }),
    [10],
  )
})

test('first run: the cursor still initializes to the chat tip', () => {
  // The gate filters delivery only; cursor advance is advanceCursor's job
  // and jumps to maxId exactly as on any other successful first poll.
  assert.equal(advanceCursor({ lastSeen: 0, maxId: 900, pendingEmptyIds: [] }), 900)
})

// ── Ungated behavior (cursor file existed, chat genuinely new) ───────────────

test('ungated: trailing unanswered messages collect until a real reply boundary', () => {
  const rows = [
    row(1, 'user', { sentMs: ANCIENT }),
    row(2, 'assistant', { sentMs: ANCIENT }),
    row(3, 'user', { sentMs: ANCIENT }),
    row(4, 'user', { sentMs: ANCIENT }),
  ]
  assert.deepEqual(
    selectFirstPollBacklogIds({ rows, maxForward: 10, recentCutoffMs: null }),
    [3, 4],
    'assistant(2) answers user(1); the unanswered tail is 3,4 however old',
  )
})

test('ungated: a proactive assistant message does not stop the scan', () => {
  const rows = [
    row(1, 'user'),
    row(2, 'assistant'),
    row(3, 'assistant'),
    row(4, 'user'),
  ]
  assert.deepEqual(
    selectFirstPollBacklogIds({ rows, maxForward: 10, recentCutoffMs: null }),
    [4],
    'assistant(3) is proactive (preceded by assistant), the scan continues to the reply at 2',
  )
})

test('ungated: collection caps at maxForward newest messages', () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(i + 1, 'user'))
  assert.deepEqual(
    selectFirstPollBacklogIds({ rows, maxForward: 10, recentCutoffMs: null }),
    [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  )
})

test('ungated: pending-empty system rows are skipped, filled ones forwarded', () => {
  const rows = [
    row(5, 'user'),
    row(6, 'system', { pendingEmpty: true }),
    row(7, 'system'),
  ]
  assert.deepEqual(
    selectFirstPollBacklogIds({ rows, maxForward: 10, recentCutoffMs: null }),
    [5, 7],
  )
})

test('ungated: unknown senders are ignored and the scan continues past them', () => {
  const rows = [row(1, 'user'), row(2, null), row(3, 'user')]
  assert.deepEqual(
    selectFirstPollBacklogIds({ rows, maxForward: 10, recentCutoffMs: null }),
    [1, 3],
  )
})

test('ids return oldest to newest regardless of gating', () => {
  const rows = [row(1, 'user'), row(2, 'user'), row(3, 'user')]
  assert.deepEqual(
    selectFirstPollBacklogIds({ rows, maxForward: 2, recentCutoffMs: null }),
    [2, 3],
  )
})

// ── sentDateToMs ─────────────────────────────────────────────────────────────

test('sentDateToMs parses ISO dates and rejects garbage', () => {
  assert.equal(sentDateToMs('2026-07-18T10:00:00.000Z'), Date.parse('2026-07-18T10:00:00.000Z'))
  assert.equal(sentDateToMs(null), null)
  assert.equal(sentDateToMs(undefined), null)
  assert.equal(sentDateToMs('not a date'), null)
})

// ── Boot-poll backlog framing (mirror of the server.ts delta-branch rule) ────
// With a persisted cursor, messages that arrived while the daemon was down
// surface through the DELTA branch of the first poll after boot. They must
// keep the [backlog] framing; live delta traffic later in the run must not.
// The rule in server.ts pollChat (keep in lockstep):
//   isBacklog = isBootPoll && newUserMessages.some(sentDateMs < DAEMON_START_MS)

function deltaIsBacklog(isBootPoll: boolean, sentMss: Array<number | null>): boolean {
  return isBootPoll && sentMss.some((t) => t !== null && t < DAEMON_START_MS)
}

test('boot-poll delta with an offline-arrived message keeps backlog framing', () => {
  assert.equal(deltaIsBacklog(true, [DAEMON_START_MS - 5_000]), true)
})

test('boot-poll delta with only post-boot messages is not backlog', () => {
  assert.equal(deltaIsBacklog(true, [DAEMON_START_MS + 5_000]), false)
})

test('steady-state delta traffic is never backlog, even if dates look old', () => {
  assert.equal(deltaIsBacklog(false, [DAEMON_START_MS - 5_000]), false)
})

// ── Wiring pins: server.ts must actually use the fix ─────────────────────────
// server.ts cannot be imported in tests (it exits without credentials at
// module load), so pin the load-bearing call sites textually, per this repo's
// convention (see poll-core.test.ts).

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

test('server.ts no longer holds the cursor map in memory only', () => {
  assert.ok(
    !serverSource.includes('const chatLastSeen = new Map'),
    'the in-memory-only cursor map (the restart-replay bug) must not return',
  )
  assert.ok(serverSource.includes('new CursorStore('))
  assert.ok(serverSource.includes('resolveCursorFilePath('))
})

test('server.ts advances cursors through the persisting helper', () => {
  assert.ok(serverSource.includes('function advanceChatCursor('))
  assert.ok(
    !/\bchatLastSeen\.set\(/.test(serverSource.replace(/function advanceChatCursor\([\s\S]*?\n\}/, '')),
    'every cursor write outside the helper must go through advanceChatCursor',
  )
})

test('server.ts selects first-poll backlog through selectFirstPollBacklogIds', () => {
  assert.ok(serverSource.includes('selectFirstPollBacklogIds('))
  assert.ok(serverSource.includes('FIRST_RUN_RECENT_WINDOW_MS'))
})

test('server.ts flushes the store on a coalescing timer and at exit', () => {
  assert.ok(
    serverSource.includes(
      'setInterval(() => cursorStore.flushIfDirty(), CURSOR_FLUSH_INTERVAL_MS)',
    ),
  )
  assert.ok(serverSource.includes("process.on('exit'"))
})
