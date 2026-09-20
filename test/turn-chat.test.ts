/**
 * Which chat does a hook event belong to?
 *
 * A hook payload carries a session id, a transcript path and a cwd, and no
 * chat id at all. The daemon has never needed a "current chat" because the
 * reply tool takes chat_id from the model, so stage 4 adds this one small
 * memory: the chat of the last thing DELIVERED to this session.
 *
 * Why not lib/acting-user.ts, which looks like it already does this: its
 * noteInbound records HUMAN turns only (isUserTurn wants senderType 'user' and
 * no agentOrigin) and it is never cleared. Reusing it would file a scheduled
 * wake's tool rows under whichever human spoke last, which is the wrong chat
 * and, on a shared agent, the wrong person's chat.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  DELIVERED_MATCH_CHARS,
  DELIVERED_MIN_CHARS,
  DELIVERED_RING_LIMIT,
  TURN_CHAT_STALE_MS,
  createTurnChatTracker,
  deliveredNeedle,
  normalizeDeliveredText,
  promptCarriesDelivered,
} from '../lib/turn-chat.ts'

test('nothing delivered means no chat, never a guess', () => {
  const tracker = createTurnChatTracker()
  assert.equal(tracker.current(1_000), null)
})

test('the last delivery wins, whatever kind it was', () => {
  const tracker = createTurnChatTracker()
  tracker.note({ chatId: '11', messageId: 900, kind: 'user', now: 1_000 })
  assert.deepEqual(tracker.current(1_500), { chatId: '11', messageId: 900, at: 1_000, kind: 'user' })

  tracker.note({ chatId: 12, messageId: null, kind: 'system', now: 2_000 })
  assert.equal(tracker.current(2_100)!.chatId, '12', 'a numeric chat id is kept as a string')
  assert.equal(tracker.current(2_100)!.kind, 'system')

  tracker.note({ chatId: '13', kind: 'meeting', now: 3_000 })
  assert.equal(tracker.current(3_100)!.chatId, '13')
  assert.equal(tracker.current(3_100)!.messageId, null, 'an absent message id is null, not undefined')
})

test('a peer turn and a scheduled wake are tracked, unlike the acting user tracker', () => {
  const tracker = createTurnChatTracker()
  tracker.note({ chatId: '20', messageId: 1, kind: 'user', now: 1_000 })
  tracker.note({ chatId: '21', messageId: 2, kind: 'peer', now: 2_000 })
  assert.equal(tracker.current(2_001)!.chatId, '21', 'the peer chat is where this turn work belongs')
  tracker.note({ chatId: '22', kind: 'system', now: 3_000 })
  assert.equal(tracker.current(3_001)!.chatId, '22')
})

test('a stale record is not a chat: a hook an hour later attaches to nothing', () => {
  const tracker = createTurnChatTracker()
  tracker.note({ chatId: '30', messageId: 5, kind: 'user', now: 1_000 })
  assert.ok(tracker.current(1_000 + TURN_CHAT_STALE_MS) !== null, 'the window is inclusive')
  assert.equal(tracker.current(1_000 + TURN_CHAT_STALE_MS + 1), null)
})

test('end() keeps the last turn\u2019s chat, so an out of turn marker lands in it', () => {
  // A compaction between two turns has no turn to belong to. It used to fall
  // through to monitoredChatIds[0], which on a multi chat agent is simply a
  // different conversation. The turn is over (live is false) and its chat is
  // still the right answer.
  const tracker = createTurnChatTracker()
  tracker.note({ chatId: '40', messageId: 7, kind: 'user', text: 'please audit the deploy script', now: 1_000 })
  tracker.beginTurn({ chatId: '40', now: 1_100 })
  assert.equal(tracker.live(), true)
  // Something else was delivered while the turn ran, so "the last delivery" and
  // "the last turn" are now DIFFERENT chats and the answer has to choose.
  tracker.note({ chatId: '41', messageId: 8, kind: 'peer', text: 'a peer asking about the roadmap', now: 1_200 })
  tracker.end(1_500)
  assert.equal(tracker.live(), false, 'no turn is running any more')
  assert.equal(tracker.current(1_501)!.chatId, '40', 'but the conversation is still where it was')
  assert.equal(
    tracker.current(1_500 + TURN_CHAT_STALE_MS + 1),
    null,
    'and it still goes stale eventually, rather than posting into last week',
  )
})

test('a delivery during a live turn does NOT move that turn\u2019s chat', () => {
  // The real case: a peer message, a system wake or a meeting invitation lands
  // while the agent is working. Every remaining row of the turn used to jump
  // into that chat mid sentence.
  const tracker = createTurnChatTracker()
  tracker.note({ chatId: '60', messageId: 1, kind: 'user', text: 'rewrite the onboarding copy please', now: 1_000 })
  tracker.beginTurn({ chatId: '60', now: 1_100 })
  tracker.note({ chatId: '61', messageId: 2, kind: 'peer', text: 'a peer is asking about the roadmap', now: 1_200 })
  assert.equal(tracker.current(1_300)!.chatId, '60', 'the turn keeps the chat it started in')
  tracker.end(1_400)
  // The next turn is free to be about the newer delivery.
  tracker.beginTurn({ chatId: '61', now: 1_500 })
  assert.equal(tracker.current(1_600)!.chatId, '61')
})

test('a live turn never goes stale under the tracker\u2019s own window', () => {
  // A Claude Code turn can easily run longer than TURN_CHAT_STALE_MS. Losing
  // the chat mid turn would send the rest of the rows to the fallback chat.
  const tracker = createTurnChatTracker()
  tracker.note({ chatId: '70', messageId: 1, kind: 'user', text: 'run the whole regression suite', now: 1_000 })
  tracker.beginTurn({ chatId: '70', now: 1_000 })
  assert.equal(tracker.current(1_000 + TURN_CHAT_STALE_MS * 3)!.chatId, '70')
})

test('beginTurn with no named chat inherits the last delivery', () => {
  const tracker = createTurnChatTracker()
  tracker.note({ chatId: '80', messageId: 3, kind: 'system', text: 'scheduled wake: check the queue', now: 1_000 })
  tracker.beginTurn({ now: 1_050 })
  assert.equal(tracker.current(1_060)!.chatId, '80')
  assert.equal(tracker.current(1_060)!.kind, 'system', 'the delivery kind is carried')
})

// ── the delivered ring (the intake's binding proof) ──────────────────────

test('a prompt carrying a delivered message names its chat', () => {
  const tracker = createTurnChatTracker()
  tracker.note({
    chatId: '90',
    messageId: 4,
    kind: 'user',
    text: 'Please review the pricing page copy and tell me what to cut.',
    now: 1_000,
  })
  const matched = tracker.matchDelivered(
    '[hoai] message from Kc:\n\nplease review the pricing   page copy and tell me what to cut.',
  )
  assert.ok(matched, 'whitespace and case are not evidence, the words are')
  assert.equal(matched!.chatId, '90')
  assert.equal(
    tracker.matchDelivered('what is the weather in Beirut today, roughly'),
    null,
    'an unrelated prompt proves nothing',
  )
})

test('a delivered text too short to be evidence is not remembered at all', () => {
  const tracker = createTurnChatTracker()
  tracker.note({ chatId: '91', messageId: 1, kind: 'user', text: 'ok', now: 1_000 })
  assert.equal(
    tracker.matchDelivered('ok, I will start with the ok path'),
    null,
    '"ok" appears in any prompt; binding a stranger\u2019s session on it is the whole defect',
  )
  assert.equal(deliveredNeedle('ok'), null)
  assert.equal(deliveredNeedle('a'.repeat(DELIVERED_MIN_CHARS)), 'a'.repeat(DELIVERED_MIN_CHARS))
})

test('a long delivered message is matched on its normalised prefix', () => {
  const long = 'Rewrite the release notes so a non specialist can follow them, then post the diff'
  const needle = deliveredNeedle(long)
  assert.ok(needle)
  assert.equal(needle!.length, DELIVERED_MATCH_CHARS, 'a prefix, so a clipped delivery still matches')
  assert.ok(promptCarriesDelivered(`${long.slice(0, 60)} ... (truncated)`, needle!))
  assert.equal(normalizeDeliveredText('  A   B \n C '), 'a b c')
})

test('the delivered ring is bounded', () => {
  const tracker = createTurnChatTracker()
  for (let i = 0; i < DELIVERED_RING_LIMIT + 5; i++) {
    tracker.note({ chatId: String(i), messageId: i, kind: 'user', text: `delivered message number ${i}`, now: 1_000 + i })
  }
  assert.equal(tracker.matchDelivered('delivered message number 0'), null, 'the oldest fell out')
  assert.equal(
    tracker.matchDelivered(`delivered message number ${DELIVERED_RING_LIMIT + 4}`)!.chatId,
    String(DELIVERED_RING_LIMIT + 4),
  )
})

test('an empty chat id is refused rather than remembered as blank', () => {
  const tracker = createTurnChatTracker()
  tracker.note({ chatId: '50', messageId: 1, kind: 'user', now: 1_000 })
  tracker.note({ chatId: '   ', messageId: 2, kind: 'user', now: 2_000 })
  assert.equal(tracker.current(2_001)!.chatId, '50')
})

test('TURN_CHAT_STALE_MS is longer than a long tool turn, shorter than a working day', () => {
  assert.equal(TURN_CHAT_STALE_MS, 15 * 60_000)
})
