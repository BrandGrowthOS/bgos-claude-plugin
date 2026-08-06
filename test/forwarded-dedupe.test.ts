import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  shouldSkipAlreadyForwarded,
  shouldSkipForwardedSlashCommand,
} from '../lib/slash-catalog'

/**
 * THE ECHO, reported by Ava (871) with nine occurrences since 2026-05-10 and
 * observed first-hand on 2026-08-06: a message delivered over the WebSocket
 * re-surfaces 25 to 60 seconds later through the poll path, same message_id,
 * body byte-identical, but stripped of the peer-origin marker so it reads as
 * a fresh user message rather than something already answered.
 *
 * The cause is an asymmetric dedupe, not a mystery. WS refuses any id already
 * in `forwardedMessageIds`. The poll consulted that same set ONLY for slash
 * commands, on the reasoning that "text can tolerate that safety replay, but
 * an action cannot". Text turned out not to tolerate it: the replay carries
 * no peer framing, and reply-overdue fires on it, which manufactures pressure
 * to re-answer work that was already delivered. An agent that complies
 * re-sends a whole report.
 *
 * The safety property that made the poll re-deliver at all is preserved,
 * because it is about LOSS: messages that arrived while the daemon was down
 * were never forwarded, so they are not in the set and are still delivered.
 * Skipping applies only to ids this process has already handed to Claude.
 */
test('shouldSkipAlreadyForwarded: an id already delivered by WS is not delivered again', () => {
  const forwarded = new Set([43961])
  assert.equal(shouldSkipAlreadyForwarded(43961, forwarded), true)
})

test('shouldSkipAlreadyForwarded: a message never forwarded is still delivered', () => {
  // This is the loss-avoidance property. Anything that arrived while the
  // daemon was down was never forwarded, so the boot poll must still deliver
  // it. Weakening this would trade a duplicate for a silent loss.
  const forwarded = new Set([43961])
  assert.equal(shouldSkipAlreadyForwarded(43962, forwarded), false)
  assert.equal(shouldSkipAlreadyForwarded(1, new Set<number>()), false)
})

test('shouldSkipAlreadyForwarded: a non-finite id is never skipped', () => {
  // A malformed id must fall through to delivery rather than be swallowed:
  // the failure mode of this guard has to be a duplicate, never a loss.
  assert.equal(shouldSkipAlreadyForwarded(Number.NaN, new Set([1])), false)
})

test('slash dedupe keeps working, and is now a special case of the general rule', () => {
  const forwarded = new Set([77])
  const slash = { messageType: 'slash_command' } as const
  assert.equal(shouldSkipForwardedSlashCommand(slash, 77, forwarded), true)
  assert.equal(shouldSkipForwardedSlashCommand(slash, 78, forwarded), false)
  // A plain text message at an already-forwarded id was NOT skipped by the
  // slash-only helper. That gap is exactly the echo.
  const text = { messageType: 'text' } as const
  assert.equal(shouldSkipForwardedSlashCommand(text, 77, forwarded), false)
  assert.equal(shouldSkipAlreadyForwarded(77, forwarded), true)
})
