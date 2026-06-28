/**
 * Regression guard for the empty-system-wake-card poll drop.
 *
 * Bug (fixed): a scheduler / system wake card (sender='system',
 * message_type='event') is written to the DB in TWO steps against the SAME row
 * id, first an EMPTY row, then an external UPDATE that fills the body. That
 * second write does not emit an inbound frame, so the body only ever reaches
 * the plugin via the poll. The old pollChat (1) advanced the cursor to maxId on
 * every tick, so a poll catching the row in its empty write-1 state burned the
 * cursor past the id and the later body-fill (same id) was excluded by the
 * `id > lastSeen` filter forever, and (2) still forwarded the empty card (the
 * system prefix made the content truthy), arming a premature reply-overdue. The
 * session saw an empty [reply-overdue] and never the text.
 *
 * The fix lives in server.ts pollChat and is not exported, so this suite
 * replicates the EXACT decision (the same pattern the reply-overdue suite uses):
 * a sender='system' row with empty text and no files is treated as "body not
 * landed yet", it is NOT forwarded and the cursor is parked just below the
 * lowest such pending id so a later poll re-reads it once the body fills.
 *
 * Invariants:
 *   1. An empty system row is deferred, not consumed (not forwarded, cursor
 *      held just below its id).
 *   2. Once the body lands (same id, now non-empty) it is forwarded and the
 *      cursor advances normally.
 *   3. A normal user message and an already-filled system card are forwarded
 *      and never deferred.
 *   4. The cursor never moves backward.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

interface Row {
  message: { id: number; sender: string | null; text: string | null }
  messageFiles?: unknown[]
}

// ── Mirror of server.ts isPendingEmptySystem ─────────────────────────────────
function isPendingEmptySystem(m: Row): boolean {
  return (
    m.message.sender === 'system' &&
    (m.message.text ?? '').trim().length === 0 &&
    !(m.messageFiles?.length)
  )
}

// ── Mirror of the pollChat forward-filter + cursor-advance decision ───────────
// (lastSeen !== 0 branch, the live steady-state path the wake cards hit.)
function decide(rows: Row[], lastSeen: number): { forwarded: number[]; newLastSeen: number } {
  const ordered = [...rows].sort((a, b) => a.message.id - b.message.id)
  const maxId = Math.max(...ordered.map((m) => m.message.id))

  const forwarded = ordered
    .filter(
      (m) =>
        m.message.id > lastSeen &&
        (m.message.sender === 'user' || m.message.sender === 'system') &&
        !isPendingEmptySystem(m),
    )
    .map((m) => m.message.id)

  const pendingIds = ordered.filter(isPendingEmptySystem).map((m) => m.message.id)
  const cap = pendingIds.length ? Math.min(...pendingIds) - 1 : maxId
  const newLastSeen = Math.max(lastSeen, Math.min(maxId, cap))
  return { forwarded, newLastSeen }
}

const sys = (id: number, text: string | null, files?: unknown[]): Row => ({
  message: { id, sender: 'system', text },
  ...(files ? { messageFiles: files } : {}),
})
const user = (id: number, text: string): Row => ({ message: { id, sender: 'user', text } })

// ── 1. Empty system row is deferred, not consumed ────────────────────────────

test('empty system row: not forwarded and cursor parked just below its id', () => {
  // Row 100 is the empty write-1 wake card; lastSeen is 99.
  const { forwarded, newLastSeen } = decide([sys(100, '')], 99)
  assert.deepEqual(forwarded, [], 'an empty wake card must not be forwarded')
  assert.equal(newLastSeen, 99, 'cursor must NOT step over the pending card (100-1=99)')
})

test('empty system row among older history: cursor parks below the card, history still advances nothing it owes', () => {
  // A filled user msg (98) already seen, then the empty wake card (100).
  const { forwarded, newLastSeen } = decide([user(98, 'hi'), sys(100, '   ')], 99)
  assert.deepEqual(forwarded, [], 'whitespace-only system body is still empty')
  assert.equal(newLastSeen, 99, 'cursor held at 99 so 100 is re-read next poll')
})

// ── 2. Body lands on the same id → forwarded, cursor advances ─────────────────

test('after the body lands the same id is forwarded and cursor advances', () => {
  // write-2 filled row 100, cursor is still 99 because we deferred earlier.
  const { forwarded, newLastSeen } = decide([sys(100, 'Scheduled check-in: review the board')], 99)
  assert.deepEqual(forwarded, [100], 'the filled wake card is now delivered')
  assert.equal(newLastSeen, 100, 'cursor advances normally once the body is present')
})

// ── 3. Normal traffic is unaffected ──────────────────────────────────────────

test('a normal user message is forwarded and never deferred', () => {
  const { forwarded, newLastSeen } = decide([user(101, 'hello there')], 100)
  assert.deepEqual(forwarded, [101])
  assert.equal(newLastSeen, 101)
})

test('an already-filled system card is forwarded like before', () => {
  const { forwarded, newLastSeen } = decide([sys(102, 'A2A: peer says hi')], 101)
  assert.deepEqual(forwarded, [102])
  assert.equal(newLastSeen, 102)
})

test('an empty system row WITH a file attachment is not pending (body == the file)', () => {
  const { forwarded, newLastSeen } = decide([sys(103, '', [{ url: 'x' }])], 102)
  assert.deepEqual(forwarded, [103], 'a file-only system card has landed, forward it')
  assert.equal(newLastSeen, 103)
})

// ── 4. Mixed batch: forward live rows, but cap the cursor below the empty one ─

test('mixed batch: real rows forward but cursor caps below the lowest empty system id', () => {
  // User msg 100 is live; system 101 is still empty; user 102 also live.
  const { forwarded, newLastSeen } = decide([user(100, 'a'), sys(101, ''), user(102, 'b')], 99)
  assert.deepEqual(forwarded, [100, 102], 'live rows are delivered; the empty card is skipped')
  assert.equal(newLastSeen, 100, 'cursor parks at 100 (101-1) so 101 is re-read once filled')
})

// ── 5. Cursor never moves backward ───────────────────────────────────────────

test('cursor never regresses even if a pending id is below lastSeen', () => {
  // Defensive: lastSeen already 150, an empty system row 101 appears (stale).
  const { forwarded, newLastSeen } = decide([sys(101, ''), user(160, 'new')], 150)
  assert.deepEqual(forwarded, [160], 'only the newer user row forwards')
  assert.ok(newLastSeen >= 150, 'cursor must not move backward')
  assert.equal(newLastSeen, 150, 'held at 150 (cap 100 floored by lastSeen)')
})
