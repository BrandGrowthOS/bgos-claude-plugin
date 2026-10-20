/**
 * Wake card contract for the /login grant (the wake-card-contract skill).
 *
 * The backend now stamps `senderMayLogin` (camel case: the socket's
 * inbound_message, the chat page poll row, the update stream's hydrated
 * message) or `sender_may_login` (snake case: the direct webhook and the
 * integrations poll row) on a share recipient's message when the owner let
 * them sign the agent back in. Only the DAEMON reads it
 * (lib/daemon-command-sender.ts readSlashSender, for /login). It is not a
 * channel attribute: buildInboundChannel does not read it, and it must never
 * become one carrying a non string value, because Claude Code silently drops
 * every notifications/claude/channel card whose meta has one (the 2026-07-05
 * fleet wide outage). These tests feed the REAL exported buildInboundChannel
 * exactly what each lane's server.ts call site feeds it, with the field on the
 * server's record, and hold:
 *   - every meta value is typeof string, the sparse payload included;
 *   - no sender_may_login (or senderMayLogin) meta key appears with a value
 *     that is not a string, even when a lane's extras carry the raw value;
 *   - the field changes nothing about the card: the same message without it
 *     gives the same content and the same meta.
 *
 * Run with: npx tsx --test test/sender-may-login-wake-card.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildInboundChannel } from '../lib/inbound-channel.ts'
import { viewStreamMessage } from '../lib/stream-apply.ts'
import type { StreamUpdate } from '../lib/update-stream.ts'
// Off the module object, so a missing export fails its own assertion.
import * as senderModule from '../lib/daemon-command-sender.ts'

const ASSISTANT_ID = '900'
const OWNER = 'user_owner'
const MEMBER = 'user_mem2'
const CHAT = '7001'
const TS = '2026-10-20T09:00:00.000Z'
const TEXT = 'my agent says it is logged out, can I fix it?'
// The contract's constant, byte for byte.
const MAY_LOGIN =
  "This agent's owner allows the person writing to send /login, to sign this agent back in when its Claude sign in expires."

function wsLane(payload: Record<string, any>) {
  return buildInboundChannel({
    chatId: CHAT, messageId: payload.messageId, userId: payload.sender?.userId ?? OWNER, assistantId: ASSISTANT_ID,
    timestamp: TS, transport: 'ws', text: payload.text,
    senderType: payload.senderType ?? (payload.agentOrigin ? 'agent' : 'user'), agentOrigin: payload.agentOrigin ?? null,
    serverSender: payload,
  })
}

function pollLane(row: Record<string, any>, extraMeta?: Record<string, unknown>) {
  return buildInboundChannel({
    chatId: CHAT, messageId: row.id, userId: row.senderUserId ?? row.sender_user_id ?? OWNER, assistantId: ASSISTANT_ID,
    timestamp: row.sentDate ?? TS, transport: 'poll', text: row.text,
    senderType: row.senderType ?? (row.sender === 'system' ? 'system' : 'user'), agentOrigin: row.agentOrigin ?? null,
    ...(extraMeta ? { extraMeta } : {}),
    serverSender: row,
  })
}

function streamLane(payload: Record<string, unknown>) {
  const update: StreamUpdate = { seq: 7, kind: 'message_new', chatId: Number(CHAT), messageId: 501, payload }
  const view = viewStreamMessage(update, ASSISTANT_ID)
  assert.ok(view)
  const isSystem = view.senderKind === 'system'
  return buildInboundChannel({
    chatId: view.chatId, messageId: view.messageId, userId: view.senderUserId ?? OWNER, assistantId: ASSISTANT_ID,
    timestamp: view.sentDate, transport: 'stream', text: view.text,
    senderType: view.agentOrigin ? 'agent' : isSystem ? 'system' : view.senderKind, agentOrigin: view.agentOrigin,
    serverSender: view.raw,
  })
}

function assertWakeCardMeta(meta: Record<string, unknown>, lane: string): void {
  for (const [key, value] of Object.entries(meta)) {
    assert.equal(
      typeof value,
      'string',
      `${lane}: meta.${key} must be a string (got ${value === null ? 'null' : typeof value}); the harness drops the card otherwise`,
    )
  }
  for (const key of ['sender_may_login', 'senderMayLogin']) {
    if (key in meta) assert.equal(typeof meta[key], 'string', `${lane}: meta.${key} is never a non string`)
  }
}

const WS_GRANTED = {
  messageId: 502, text: TEXT, messageType: 'text',
  sender: { userId: MEMBER, displayName: 'Ben Ruiz', relationship: 'shared_recipient' },
  isSharedRecipient: true, shareOwnerUserId: OWNER,
  senderMayLogin: MAY_LOGIN,
}
const POLL_PAGE_GRANTED = {
  id: 502, text: TEXT, sender: 'user', messageType: 'text', senderUserId: MEMBER,
  senderDisplayName: 'Ben Ruiz', senderRelationship: 'shared_recipient', sentDate: TS,
  senderMayLogin: MAY_LOGIN,
}
const POLL_ROW_GRANTED = {
  id: 502, text: TEXT, sender: 'user', message_type: 'text', sender_user_id: MEMBER,
  sender_relationship: 'shared_recipient', chat_kind: 'main', sentDate: TS,
  sender_may_login: MAY_LOGIN,
}
const STREAM_GRANTED = {
  text: TEXT, chatKind: 'main', sender: 'user', messageType: 'text', files: [],
  senderUserId: MEMBER, senderDisplayName: 'Ben Ruiz', senderRelationship: 'shared_recipient',
  senderMayLogin: MAY_LOGIN,
}

test('the fixture value is the exported constant', () => {
  assert.equal(senderModule.SENDER_MAY_LOGIN_VALUE, MAY_LOGIN)
})

test('wake card meta is all string on every lane when the message carries the may login field', () => {
  assertWakeCardMeta(wsLane(WS_GRANTED).meta, 'ws')
  assertWakeCardMeta(pollLane(POLL_PAGE_GRANTED).meta, 'poll (chat page row)')
  assertWakeCardMeta(pollLane(POLL_ROW_GRANTED).meta, 'poll (integrations row)')
  assertWakeCardMeta(streamLane(STREAM_GRANTED).meta, 'stream (flat)')
  assertWakeCardMeta(streamLane({ message: { id: 501, ...STREAM_GRANTED }, messageFiles: [] }).meta, 'stream (row)')
})

test('wake card meta is all string for the sparse payload carrying only the field (the regression case)', () => {
  assertWakeCardMeta(wsLane({ messageId: 9, senderMayLogin: MAY_LOGIN }).meta, 'ws sparse')
  assertWakeCardMeta(pollLane({ id: 9, sender_may_login: MAY_LOGIN }).meta, 'poll sparse')
  assertWakeCardMeta(streamLane({ senderMayLogin: MAY_LOGIN }).meta, 'stream sparse')
  // A wrong typed value on the record changes nothing either.
  for (const value of [true, null, 1, { x: 1 }]) {
    assertWakeCardMeta(wsLane({ ...WS_GRANTED, senderMayLogin: value }).meta, `ws ${JSON.stringify(value)}`)
    assertWakeCardMeta(pollLane({ ...POLL_ROW_GRANTED, sender_may_login: value }).meta, `poll ${JSON.stringify(value)}`)
    assertWakeCardMeta(streamLane({ ...STREAM_GRANTED, senderMayLogin: value }).meta, `stream ${JSON.stringify(value)}`)
  }
})

test("a lane's extras carrying the raw value are coerced to a string, never passed through as one that is not", () => {
  const delivery = pollLane(POLL_ROW_GRANTED, { sender_may_login: true, senderMayLogin: null })
  assertWakeCardMeta(delivery.meta, 'poll with raw extras')
  assert.equal('senderMayLogin' in delivery.meta, false, 'a null extra is omitted, not emitted as null')
})

test('the field is daemon only: the card is the same with it and without it', () => {
  const pairs: Array<[string, () => ReturnType<typeof wsLane>, () => ReturnType<typeof wsLane>]> = [
    ['ws', () => wsLane(WS_GRANTED), () => wsLane({ ...WS_GRANTED, senderMayLogin: undefined })],
    ['poll', () => pollLane(POLL_ROW_GRANTED), () => pollLane({ ...POLL_ROW_GRANTED, sender_may_login: undefined })],
    ['stream', () => streamLane(STREAM_GRANTED), () => streamLane({ ...STREAM_GRANTED, senderMayLogin: undefined })],
  ]
  for (const [lane, withField, withoutField] of pairs) {
    const a = withField()
    const b = withoutField()
    assert.equal(a.content, b.content, `${lane}: the content does not change`)
    assert.ok(!a.content.includes(MAY_LOGIN), `${lane}: the label is not rendered into the turn`)
    const { ts: _a, ...metaA } = a.meta
    const { ts: _b, ...metaB } = b.meta
    assert.deepEqual(metaA, metaB, `${lane}: the meta does not change`)
  }
})
