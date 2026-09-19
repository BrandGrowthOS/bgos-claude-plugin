/**
 * Regression guard for meeting wake cards (lib/meeting-card.ts).
 *
 * Bug (fixed in 0.39.8): the backend delivers every meeting turn twice, as a
 * meeting_message broadcast and as an inbound_message twin carrying
 * meetingContext. The twin path ignored meetingContext and emitted a plain
 * chat card, and because it wins the dedupe race about half the time, about
 * half of all meeting turns reached the agent with no your_turn marker, and
 * an agent's handoff read as if the human had written it. Found in the
 * 2026-09-19 meeting QA.
 *
 * These tests exercise the REAL builder (exported, not mirrored) plus the
 * server.ts wiring that routes the twin through it. Every meta value must be
 * a string with absent optionals omitted: the harness silently drops a card
 * otherwise (the wake-card contract, test/ws-inbound-meta.test.ts).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildMeetingCard,
  meetingSenderLabel,
  readMeetingContext,
} from '../lib/meeting-card.ts'

const ME = '900'

function assertAllStrings(meta: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(meta)) {
    assert.equal(
      typeof v,
      'string',
      `meta.${k} must be a string (got ${v === null ? 'null' : typeof v}); the harness drops the card otherwise`,
    )
  }
}

function twinCard(meetingContext: unknown, text = 'hello') {
  const m = readMeetingContext({ messageId: 42, chatId: 6053, text, meetingContext })
  assert.ok(m, 'a twin with a meeting id parses')
  return buildMeetingCard({
    meetingId: m.meetingId,
    chatId: '6053',
    messageId: '42',
    userId: 'user_owner',
    assistantId: ME,
    timestamp: '2026-09-19T18:00:00.000Z',
    transport: 'ws',
    yourTurn: m.yourTurn,
    participants: m.participants,
    senderName: m.senderName,
    senderType: m.senderType,
    text,
    currentSpeakerId: m.currentSpeakerId,
  })
}

test('the sparse twin (only a meeting id) still yields a framed, all-string card', () => {
  const card = twinCard({ meetingId: 17 })
  assertAllStrings(card.meta)
  assert.equal(card.meta.event_type, 'meeting_message')
  assert.equal(card.meta.your_turn, 'NO')
  assert.equal('current_speaker_id' in card.meta, false, 'absent speaker omitted, not null')
  assert.equal('sender_assistant_id' in card.meta, false, 'absent sender id omitted, not null')
  assert.equal('backlog' in card.meta, false)
  assert.match(card.content, /^\[Meeting #17, your_turn=NO, participants: unknown\]\nUser: hello$/)
})

test('the server verdict decides your_turn, and the header names the other participants', () => {
  const card = twinCard({
    meetingId: 17,
    title: 'Sunday QA',
    speakerPolicy: 'user_mediated',
    currentSpeakerId: 900,
    yourTurn: true,
    participants: [
      { assistantId: 900, name: 'Data' },
      { assistantId: 910, name: 'Vexa' },
      { assistantId: 1040, name: 'Ares' },
    ],
    senderName: 'Vexa',
    senderType: 'agent',
  }, 'Over to you, @Data')
  assertAllStrings(card.meta)
  assert.equal(card.meta.your_turn, 'YES')
  assert.equal(card.meta.current_speaker_id, '900')
  assert.equal(card.meta.sender_type, 'agent')
  assert.equal(card.meta.user, 'Vexa', 'an agent speaker is named, never "User"')
  assert.equal(
    card.content,
    '[Meeting #17, your_turn=YES, participants: Vexa, Ares]\nVexa: Over to you, @Data',
  )
})

test('a twin that says it is not my turn reads NO even when my name is in the text', () => {
  const card = twinCard({
    meetingId: 17,
    yourTurn: false,
    currentSpeakerId: 910,
    senderName: 'Ares',
    senderType: 'agent',
  }, 'Data said "@Vexa go ahead" earlier')
  assert.equal(card.meta.your_turn, 'NO')
  assert.match(card.content, /your_turn=NO/)
})

test('a human the twin calls "You" is shown to the agent as User', () => {
  assert.equal(twinCard({ meetingId: 3, senderName: 'You', senderType: 'user' }).meta.sender_name, 'User')
  assert.equal(meetingSenderLabel('user', 'you'), 'User')
  assert.equal(meetingSenderLabel('user', ''), 'User')
  assert.equal(meetingSenderLabel('user', 'Maya'), 'Maya')
  assert.equal(meetingSenderLabel('agent', ''), 'Another agent')
})

test('an inbound with no usable meeting context falls through to the plain card', () => {
  assert.equal(readMeetingContext({ messageId: 1, text: 'hi' }), null)
  assert.equal(readMeetingContext({ meetingContext: null }), null)
  assert.equal(readMeetingContext({ meetingContext: { meetingId: 'abc' } }), null)
  assert.equal(readMeetingContext(null), null)
})

test('non-finite ids are omitted rather than sent as "NaN"', () => {
  const card = buildMeetingCard({
    meetingId: 5,
    chatId: '1',
    messageId: '2',
    userId: 'u',
    assistantId: ME,
    timestamp: 't',
    transport: 'ws',
    yourTurn: false,
    participants: [],
    senderName: 'X',
    senderType: 'agent',
    text: 'x',
    senderAssistantId: Number.NaN,
    currentSpeakerId: Number.NaN,
  })
  assertAllStrings(card.meta)
  assert.equal('sender_assistant_id' in card.meta, false)
  assert.equal('current_speaker_id' in card.meta, false)
})

test('a backlog poll card carries the prefix and a string flag', () => {
  const card = buildMeetingCard({
    meetingId: 5,
    chatId: '1',
    messageId: '2',
    userId: 'u',
    assistantId: ME,
    timestamp: 't',
    transport: 'poll',
    yourTurn: true,
    participants: [{ assistantId: 910, name: 'Vexa' }],
    senderName: 'User',
    senderType: 'user',
    text: 'still there?',
    currentSpeakerId: 900,
    backlog: true,
  })
  assertAllStrings(card.meta)
  assert.equal(card.meta.backlog, 'true')
  assert.ok(card.content.startsWith('[backlog, meeting message arrived while you were offline]\n'))
})

// Wiring. The builder being right is worth nothing if the twin never reaches
// it, which is the exact shape of the original defect.
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'server.ts'),
  'utf8',
)

function body(fnStart: string, until: string): string {
  const start = src.indexOf(fnStart)
  assert.ok(start >= 0, `${fnStart} exists in server.ts`)
  const end = src.indexOf(until, start)
  assert.ok(end > start, `${until} follows ${fnStart}`)
  return src.slice(start, end)
}

test('deliverWsInbound routes a meeting twin to the meeting card before the plain card', () => {
  const fn = body('function deliverWsInbound(', 'const wsChannel = buildInboundChannel(')
  assert.ok(fn.includes('readMeetingContext(payload)'), 'the twin context is read')
  assert.ok(fn.includes('buildMeetingCard({'), 'the meeting card is built')
  assert.ok(fn.includes('noteMeetingTwin('), 'the local meeting context is refreshed')
  assert.ok(/buildMeetingCard\(\{[\s\S]*?\n\s+return\n/.test(fn), 'the meeting branch returns before the plain card')
})

test('the broadcast handler records the speaker before its dedupe can return', () => {
  const handler = body("realtimeSocket.on('meeting_message'", "realtimeSocket.on('meeting_turn_changed'")
  const speaker = handler.indexOf('ctx.currentSpeakerId =')
  const dedupe = handler.indexOf('if (forwardedMessageIds.has(messageId)) return')
  assert.ok(speaker >= 0 && dedupe >= 0)
  assert.ok(speaker < dedupe, 'the speaker update must precede the dedupe return')
})

test('a late twin for an older message cannot overwrite newer meeting state', () => {
  const fn = body('function noteMeetingTwin(', '\n}\n')
  const guard = fn.indexOf('if (messageId < ctx.lastSeenMessageId) return ctx')
  assert.ok(guard >= 0, 'the stale-frame guard exists')
  for (const write of ['ctx.title =', 'ctx.speakerPolicy =', 'ctx.participants =', 'ctx.currentSpeakerId =']) {
    const at = fn.indexOf(write)
    assert.ok(at >= 0, `${write} exists`)
    assert.ok(guard < at, `${write} must sit behind the stale-frame guard`)
  }
})
