/**
 * Regression guard for live WS inbound delivery.
 *
 * Bug (fixed): the Claude Code harness silently DROPS any
 * `notifications/claude/channel` card whose `meta` carries a non-string value
 * (a `null`, an `undefined`, and in practice any value that is not a string).
 * PR #17 added Block-A identity fields to the WS `inbound_message` meta as raw
 * values, including `share_owner_user_id: null` and optional
 * `sender_display_name`/`sender_relationship` that were `undefined` when absent.
 * Result: EVERY live WS inbound card vanished (only the poll backlog on restart
 * and the all-string reply-overdue card ever surfaced), while the poll and
 * overdue paths, which are all-string, kept working. (An earlier version of
 * this comment claimed boolean `system: true` was tolerated; live A/B probing
 * on 2026-07-07 showed system event cards with boolean meta also vanish, so
 * server.ts now emits `system: 'true'` / `backlog: 'true'` strings and
 * event_payload as a JSON string. ALL meta values must be strings, period.)
 *
 * The meta is built module-scoped inside connectWebsocket() in server.ts and is
 * not exported, so, per this repo's convention (see reply-overdue.test.ts and
 * message-text.test.ts), this suite mirrors the EXACT meta-building logic and
 * asserts the load-bearing invariant: every emitted meta value is a string, and
 * optional identity fields are omitted (never null/undefined) when absent.
 *
 * If server.ts's WS inbound meta construction changes, update this mirror in
 * lockstep. The invariant it guards must hold: Object.values(meta) are all
 * strings.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BUILTIN_COMMANDS,
  prepareSlashCommands,
  routeSlashCommand,
} from '../lib/slash-catalog.ts'

const USER_ID = 'user_owner'
const ASSISTANT_ID = 'agent_1'
const slashCommands = prepareSlashCommands(BUILTIN_COMMANDS)

// ── Mirror of server.ts WS inbound_message meta construction (the FIXED form) ──
function buildWsInboundMeta(payload: any): Record<string, unknown> {
  const chatId = String(payload?.chatId ?? payload?.chat_id ?? '')
  const messageId = Number(payload?.messageId ?? payload?.message_id)
  const isWsSystem =
    String(payload?.senderType ?? payload?.sender_type ?? '') === 'system'
  const wsSessionHandle = payload?.sessionHandle ?? payload?.session_handle
  const slashRoute = routeSlashCommand({
    payload: payload ?? {},
    sourceContent: String(payload?.text ?? ''),
    registry: slashCommands.registry,
    legacyAliases: slashCommands.legacyAliases,
  })
  const slashDelivery = slashRoute.kind === 'directive'
    ? slashRoute.delivery
    : null

  return {
    chat_id: chatId,
    message_id: String(messageId),
    user: isWsSystem ? 'System' : 'User',
    user_id: String(payload?.sender?.userId ?? payload?.userId ?? USER_ID),
    ...(payload?.sender?.displayName
      ? { sender_display_name: String(payload.sender.displayName) }
      : {}),
    ...(payload?.sender?.relationship
      ? { sender_relationship: String(payload.sender.relationship) }
      : {}),
    is_shared_recipient: String(payload?.isSharedRecipient ?? false),
    ...(payload?.shareOwnerUserId
      ? { share_owner_user_id: String(payload.shareOwnerUserId) }
      : {}),
    assistant_id: ASSISTANT_ID,
    ts: '2026-01-01T00:00:00.000Z',
    transport: 'ws',
    ...(typeof wsSessionHandle === 'string' && wsSessionHandle
      ? { session_handle: String(wsSessionHandle) }
      : {}),
    ...(slashDelivery ? slashDelivery.meta : {}),
    ...(payload?.peer_conversation_id != null
      ? { peer_conversation_id: String(payload.peer_conversation_id) }
      : {}),
    ...(payload?.peerConversationId != null
      ? { peer_conversation_id: String(payload.peerConversationId) }
      : {}),
    ...(payload?.turn_state != null
      ? { turn_state: String(payload.turn_state) }
      : {}),
    ...(payload?.turnState != null
      ? { turn_state: String(payload.turnState) }
      : {}),
  }
}

function assertAllStrings(meta: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(meta)) {
    assert.equal(
      typeof v,
      'string',
      `meta.${k} must be a string (got ${v === null ? 'null' : typeof v}: ${JSON.stringify(v)}); the harness drops the whole card otherwise`,
    )
  }
}

test('WS inbound meta is all-string for the exact #17 regression payload (unshared, no sender fields)', () => {
  // The payload that triggered the bug: no sender identity, not a share.
  const meta = buildWsInboundMeta({
    chatId: 1048,
    messageId: 42,
    text: 'hi',
    // isSharedRecipient absent -> was `?? false` (boolean); shareOwnerUserId
    // absent -> was `?? null`. Both used to poison the meta.
  })
  assertAllStrings(meta)
  assert.equal(meta.is_shared_recipient, 'false')
  assert.equal('share_owner_user_id' in meta, false, 'absent owner must be omitted, not null')
  assert.equal('sender_display_name' in meta, false, 'absent display name must be omitted, not undefined')
})

test('WS inbound meta is all-string when Block-A identity IS present', () => {
  const meta = buildWsInboundMeta({
    chat_id: '1048',
    message_id: 43,
    sender: { userId: 'user_human', displayName: 'Karim', relationship: 'owner' },
    isSharedRecipient: true,
    shareOwnerUserId: 'user_owner',
    session_handle: 'sh_abc',
  })
  assertAllStrings(meta)
  assert.equal(meta.sender_display_name, 'Karim')
  assert.equal(meta.is_shared_recipient, 'true')
  assert.equal(meta.share_owner_user_id, 'user_owner')
  assert.equal(meta.session_handle, 'sh_abc')
})

test('WS inbound meta never carries null or undefined values', () => {
  for (const payload of [
    { chatId: 1, messageId: 1 },
    { chatId: 2, messageId: 2, sender: {} },
    { chatId: 3, messageId: 3, isSharedRecipient: false, shareOwnerUserId: null },
    { chatId: 4, messageId: 4, senderType: 'system' },
  ]) {
    const meta = buildWsInboundMeta(payload)
    for (const v of Object.values(meta)) {
      assert.notEqual(v, null)
      assert.notEqual(v, undefined)
      assert.equal(typeof v, 'string')
    }
  }
})

test('WS native slash card keeps every meta value string and omits absent optionals', () => {
  const meta = buildWsInboundMeta({
    chatId: 1048,
    messageId: 44,
    text: '/cost project alpha',
    messageType: 'slash_command',
    commandName: 'cost',
    commandArgs: 'project alpha',
    peerConversationId: null,
    turnState: 7,
  })

  assertAllStrings(meta)
  assert.equal(meta.event_type, 'slash_command')
  assert.equal(meta.command_name, 'cost')
  assert.equal(meta.command_args, 'project alpha')
  assert.equal(meta.slash_dispatch, 'actionable_directive')
  assert.equal(meta.turn_state, '7')
  assert.equal('peer_conversation_id' in meta, false)
})
