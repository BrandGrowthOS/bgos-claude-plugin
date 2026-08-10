/**
 * Pure decisions for replayed catch-up updates (agent-message-routing.md 5.5
 * and 5.7): which message_new rows forward, hold, or only advance cursors;
 * when a message_finalized delivers AS the wake; which buttons_answered rows
 * the stream may announce under the single-announce contract; and the
 * all-string stream inbound meta (the wake-card contract: the Claude Code
 * harness silently DROPS any channel card whose meta carries a non-string
 * value, so every value must be a string and absent optionals OMITTED).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildStreamClickMeta,
  buildStreamInboundMeta,
  classifyStreamKind,
  decideButtonsAnswered,
  decideMessageFinalized,
  decideMessageNew,
  viewStreamMessage,
} from '../lib/stream-apply.ts'
import { selectClickTransitions } from '../lib/poll-core.ts'
import type { StreamUpdate } from '../lib/update-stream.ts'

function upd(
  payload: Record<string, unknown>,
  over: Partial<StreamUpdate> = {},
): StreamUpdate {
  return {
    seq: 5,
    kind: 'message_new',
    chatId: 1048,
    messageId: 900,
    payload,
    ...over,
  }
}

// ── viewStreamMessage: payload normalization ────────────────────────────────

test('a WS-shaped payload normalizes: text, files, senderType, session handle', () => {
  const view = viewStreamMessage(
    upd({
      chatId: 1048,
      messageId: 900,
      text: 'hello',
      files: [{ filename: 'a.png', mime: 'image/png', url: 'https://x/a.png' }],
      senderType: 'system',
      sessionHandle: 'sh_1',
      messageType: 'event',
      eventMeta: { source: 'scheduler' },
      sender: { userId: 'user_h' },
    }),
  )
  assert.ok(view)
  assert.equal(view!.chatId, '1048')
  assert.equal(view!.messageId, 900)
  assert.equal(view!.text, 'hello')
  assert.equal(view!.files.length, 1)
  assert.equal(view!.senderKind, 'system')
  assert.equal(view!.sessionHandle, 'sh_1')
  assert.equal(view!.messageType, 'event')
  assert.equal(view!.senderUserId, 'user_h')
})

test('a poll-row-shaped payload (message envelope) normalizes identically', () => {
  const view = viewStreamMessage(
    upd({
      message: {
        id: 901,
        chatId: 1048,
        text: 'row text',
        sender: 'assistant',
        messageType: 'standard',
        sentDate: '2026-08-08T10:00:00.000Z',
        senderUserId: 'user_h',
      },
      messageFiles: [],
    }),
  )
  assert.ok(view)
  assert.equal(view!.messageId, 901)
  assert.equal(view!.text, 'row text')
  assert.equal(view!.senderKind, 'assistant')
  assert.equal(view!.sentDate, '2026-08-08T10:00:00.000Z')
})

test('a hydrated peer target keeps origin while the source stays assistant-authored', () => {
  const agentOrigin = {
    sourceAssistantId: 900,
    sourceName: 'Data',
    targetAssistantId: 901,
    peerConversationId: 4595,
    messageId: 47820,
  }
  const update = upd({
    message: {
      id: 47820,
      chatId: 3582,
      text: 'The analysis is complete.',
      sender: 'user',
      senderType: 'agent',
      agentOrigin,
      peerConversationId: 4595,
      turnState: 'final',
    },
    messageFiles: [],
  })
  const view = viewStreamMessage(update, 901)

  assert.ok(view)
  assert.equal(view!.senderKind, 'agent')
  assert.deepEqual(view!.agentOrigin, agentOrigin)
  assert.equal(view!.peerConversationId, '4595')
  assert.equal(view!.turnState, 'final')

  const sourceView = viewStreamMessage(update, 900)
  assert.ok(sourceView)
  assert.equal(sourceView!.senderKind, 'assistant')
  assert.deepEqual(
    decideMessageNew(sourceView!, {
      lastSeenInChat: 0,
      alreadyForwarded: false,
    }),
    { action: 'advance_only', reason: 'assistant_authored' },
  )
})

test('an explicit assistant sender wins over agent origin on a caller-side row', () => {
  const view = viewStreamMessage(
    upd({
      message: {
        id: 47820,
        chatId: 3582,
        text: 'The analysis is complete.',
        sender: 'assistant',
        senderType: 'agent',
        agentOrigin: {
          sourceAssistantId: 900,
          sourceName: 'Data',
          targetAssistantId: 901,
          peerConversationId: 4595,
          messageId: 47820,
        },
        peerConversationId: 4595,
        turnState: 'final',
      },
      messageFiles: [],
    }),
  )

  assert.ok(view)
  assert.equal(view!.senderKind, 'assistant')
})

test('chat and message ids fall back to the update row fields', () => {
  const view = viewStreamMessage(upd({ text: 'x' }))
  assert.ok(view)
  assert.equal(view!.chatId, '1048')
  assert.equal(view!.messageId, 900)
})

test('a payload with no resolvable message id returns null', () => {
  assert.equal(
    viewStreamMessage(upd({ text: 'x' }, { messageId: null, chatId: null })),
    null,
  )
})

test('answerPayload is surfaced for buttons_answered rows, both casings', () => {
  const camel = viewStreamMessage(
    upd({ answerPayload: { callbackData: 'go', buttonText: 'Go' } }),
  )
  assert.deepEqual(camel!.answerPayload, {
    callbackData: 'go',
    buttonText: 'Go',
    customText: undefined,
  })
  const snake = viewStreamMessage(
    upd({ answer_payload: { callback_data: 'go2', button_text: 'Go2', custom_text: 'why' } }),
  )
  assert.deepEqual(snake!.answerPayload, {
    callbackData: 'go2',
    buttonText: 'Go2',
    customText: 'why',
  })
})

// ── decideMessageNew (5.7) ──────────────────────────────────────────────────

const baseView = (over: Record<string, unknown> = {}) =>
  viewStreamMessage(
    upd({ chatId: 10, messageId: 200, text: 'fresh', senderType: 'user', ...over }),
  )!

test('a fresh user message forwards', () => {
  assert.deepEqual(
    decideMessageNew(baseView(), { lastSeenInChat: 150, alreadyForwarded: false }),
    { action: 'forward', isSystem: false },
  )
})

test('an assistant-authored row only advances cursors (reply boundary, 5.7)', () => {
  assert.deepEqual(
    decideMessageNew(baseView({ senderType: 'assistant' }), {
      lastSeenInChat: 150,
      alreadyForwarded: false,
    }),
    { action: 'advance_only', reason: 'assistant_authored' },
  )
})

test('a row at or under the per-chat cursor was handled in a previous run', () => {
  assert.deepEqual(
    decideMessageNew(baseView(), { lastSeenInChat: 200, alreadyForwarded: false }),
    { action: 'advance_only', reason: 'already_covered' },
  )
})

test('an empty system row is HELD, the wake-card two-phase park', () => {
  assert.deepEqual(
    decideMessageNew(baseView({ text: '   ', senderType: 'system' }), {
      lastSeenInChat: 150,
      alreadyForwarded: false,
    }),
    { action: 'hold_empty' },
  )
})

test('an empty system row with files is a real message, not a hold', () => {
  const view = baseView({
    text: '',
    senderType: 'system',
    files: [{ filename: 'a.pdf', mime: 'application/pdf', url: 'https://x/a.pdf' }],
  })
  assert.deepEqual(
    decideMessageNew(view, { lastSeenInChat: 150, alreadyForwarded: false }),
    { action: 'forward', isSystem: true },
  )
})

test('an id both transports already delivered only advances (dedup substrate)', () => {
  assert.deepEqual(
    decideMessageNew(baseView(), { lastSeenInChat: 150, alreadyForwarded: true }),
    { action: 'advance_only', reason: 'already_forwarded' },
  )
})

test('an empty non-system row has nothing to forward', () => {
  assert.deepEqual(
    decideMessageNew(baseView({ text: '' }), {
      lastSeenInChat: 150,
      alreadyForwarded: false,
    }),
    { action: 'advance_only', reason: 'empty_non_system' },
  )
})

// ── decideMessageFinalized (5.7 wake delivery) ──────────────────────────────

test('a finalized held row delivers AS the wake', () => {
  assert.deepEqual(
    decideMessageFinalized(baseView({ senderType: 'system' }), {
      held: true,
      lastSeenInChat: 150,
      alreadyForwarded: false,
    }),
    { action: 'forward', isSystem: true },
  )
})

test('a finalized held row that is STILL empty stays held', () => {
  assert.deepEqual(
    decideMessageFinalized(baseView({ text: '', senderType: 'system' }), {
      held: true,
      lastSeenInChat: 150,
      alreadyForwarded: false,
    }),
    { action: 'hold_empty' },
  )
})

test('a finalize for an undelivered row above the cursor delivers (parked wake)', () => {
  assert.deepEqual(
    decideMessageFinalized(baseView({ senderType: 'system' }), {
      held: false,
      lastSeenInChat: 150,
      alreadyForwarded: false,
    }),
    { action: 'forward', isSystem: true },
  )
})

test('a finalized peer turn forwards without system framing', () => {
  assert.deepEqual(
    decideMessageFinalized(baseView({ senderType: 'agent' }), {
      held: false,
      lastSeenInChat: 150,
      alreadyForwarded: false,
    }),
    { action: 'forward', isSystem: false },
  )
})

test('a finalized unknown sender keeps the prior system fallback', () => {
  assert.deepEqual(
    decideMessageFinalized(baseView({ senderType: 'unknown' }), {
      held: false,
      lastSeenInChat: 150,
      alreadyForwarded: false,
    }),
    { action: 'forward', isSystem: true },
  )
})

test('a finalize for an already-delivered row is an edit: advance only', () => {
  assert.equal(
    decideMessageFinalized(baseView(), {
      held: false,
      lastSeenInChat: 150,
      alreadyForwarded: true,
    }).action,
    'advance_only',
  )
  assert.equal(
    decideMessageFinalized(baseView(), {
      held: false,
      lastSeenInChat: 200,
      alreadyForwarded: false,
    }).action,
    'advance_only',
  )
})

test('an assistant stream-end finalize only advances', () => {
  assert.deepEqual(
    decideMessageFinalized(baseView({ senderType: 'assistant' }), {
      held: false,
      lastSeenInChat: 150,
      alreadyForwarded: false,
    }),
    { action: 'advance_only', reason: 'assistant_authored' },
  )
})

// ── decideButtonsAnswered (single-announce via the announced-ids set) ───────
// A tracked-only gate black-holes clicks under stream mode: the healthy
// sweep stretches to daily, so an id never baselined by pollChat would be
// skipped here AND could never be announced by selectClickTransitions
// either (it only announces ids seen unanswered on a PREVIOUS poll). The
// gate is therefore an announced-ids dedup set shared with the poll path.

const PERM_RE = /^perm:(once|session|permanent|deny):([a-km-z]{5})$/i

test('an unannounced answer forwards, tracked or not (the black hole is closed)', () => {
  assert.equal(
    decideButtonsAnswered({
      messageType: 'standard',
      callbackData: 'pick_a',
      alreadyAnnounced: false,
      permissionRe: PERM_RE,
    }),
    'forward',
  )
})

test('an already-announced answer is skipped (single announce, both orders)', () => {
  assert.equal(
    decideButtonsAnswered({
      messageType: 'standard',
      callbackData: 'pick_a',
      alreadyAnnounced: true,
      permissionRe: PERM_RE,
    }),
    'skip',
  )
})

test('ask_user_input rows never announce (that tool owns its own polling)', () => {
  assert.equal(
    decideButtonsAnswered({
      messageType: 'ask_user_input',
      callbackData: 'pick_a',
      alreadyAnnounced: false,
      permissionRe: PERM_RE,
    }),
    'skip',
  )
})

test('a permission callback resolves the pending verdict instead of forwarding', () => {
  assert.equal(
    decideButtonsAnswered({
      messageType: 'standard',
      callbackData: 'perm:once:abcde',
      alreadyAnnounced: false,
      permissionRe: PERM_RE,
    }),
    'permission',
  )
})

test('an already-resolved permission callback is skipped', () => {
  assert.equal(
    decideButtonsAnswered({
      messageType: 'standard',
      callbackData: 'perm:deny:abcde',
      alreadyAnnounced: true,
      permissionRe: PERM_RE,
    }),
    'skip',
  )
})

// ── The three race orders, driven through the REAL poll detector ────────────
// Mirror of the two call sites (keep in lockstep with server.ts): the poll's
// announce path ADDS every announced id to the shared set; the stream's
// buttons_answered forwards iff the id is not in the set, adds it, and
// consumes any live-tracked baseline entry.

interface ClickHarness {
  announced: Set<number>
  unanswered: ReadonlySet<number>
}

function pollTick(
  h: ClickHarness,
  rows: Array<{ id: number; answered: boolean }>,
  isFirstPoll: boolean,
): number[] {
  const { announce, nextUnanswered } = selectClickTransitions({
    rows: rows.map((r) => ({
      id: r.id,
      sender: 'assistant',
      messageType: 'standard',
      hasOptions: true,
      answered: r.answered,
    })),
    prevUnanswered: h.unanswered,
    isFirstPoll,
  })
  for (const id of announce) h.announced.add(id)
  h.unanswered = nextUnanswered
  return announce
}

function streamReplay(h: ClickHarness, id: number): boolean {
  const decision = decideButtonsAnswered({
    messageType: 'standard',
    callbackData: 'pick_a',
    alreadyAnnounced: h.announced.has(id),
    permissionRe: PERM_RE,
  })
  if (decision === 'skip') return false
  h.announced.add(id)
  ;(h.unanswered as Set<number>).delete(id)
  return true
}

test('stream-first: the consumed baseline blocks the later poll announce', () => {
  const h: ClickHarness = { announced: new Set(), unanswered: new Set() }
  assert.deepEqual(pollTick(h, [{ id: 5, answered: false }], true), [], 'baseline only')
  assert.equal(streamReplay(h, 5), true, 'the stream announces the tap')
  assert.deepEqual(
    pollTick(h, [{ id: 5, answered: true }], false),
    [],
    'the poll must not announce the same tap a second time',
  )
})

test('poll-first: the announced set blocks the later stream replay', () => {
  const h: ClickHarness = { announced: new Set(), unanswered: new Set() }
  pollTick(h, [{ id: 5, answered: false }], true)
  assert.deepEqual(pollTick(h, [{ id: 5, answered: true }], false), [5])
  assert.equal(streamReplay(h, 5), false, 'the stream replay stays silent')
})

test('a never-baselined id announces exactly once through the stream', () => {
  // Under stream mode the poll may not run for a day, so no baseline ever
  // exists for this id; the tracked-only gate would have black-holed it.
  const h: ClickHarness = { announced: new Set(), unanswered: new Set() }
  assert.equal(streamReplay(h, 9), true, 'first stream announce delivers')
  assert.equal(streamReplay(h, 9), false, 'a replayed slice stays silent')
  assert.deepEqual(
    pollTick(h, [{ id: 9, answered: true }], true),
    [],
    'the poll never announces it either (answered rows never baseline)',
  )
})

// ── classifyStreamKind (5.8 lanes, consumer side) ───────────────────────────

test('every announced update kind maps to a handling class', () => {
  const expectations: Record<string, string> = {
    message_new: 'message_new',
    message_finalized: 'message_finalized',
    message_deleted: 'noop',
    buttons_answered: 'buttons_answered',
    chat_created: 'chat_created',
    chat_renamed: 'noop',
    chat_deleted: 'chat_deleted',
    seat_granted: 'reconcile',
    seat_revoked: 'reconcile',
    meeting_opened: 'reconcile',
    meeting_turn: 'noop',
    meeting_closed: 'reconcile',
    meeting_participants: 'reconcile',
    meeting_policy: 'noop',
    config_changed: 'config',
    peer_opened: 'noop',
    peer_closed: 'peer_closed',
    peer_turn: 'noop',
  }
  for (const [kind, cls] of Object.entries(expectations)) {
    assert.equal(classifyStreamKind(kind), cls, `kind ${kind}`)
  }
})

test('an unknown future kind is a logged no-op, never a throw', () => {
  assert.equal(classifyStreamKind('brand_new_kind'), 'noop')
})

// ── The all-string meta contract (wake-card contract) ───────────────────────

function assertAllStrings(meta: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(meta)) {
    assert.equal(
      typeof v,
      'string',
      `meta.${k} must be a string (got ${v === null ? 'null' : typeof v}); the harness drops the whole card otherwise`,
    )
  }
}

test('stream inbound meta is all-string with absent optionals OMITTED', () => {
  const meta = buildStreamInboundMeta({
    chatId: '1048',
    messageId: 900,
    isSystem: false,
    senderUserId: 'user_h',
    assistantId: '900',
    backlog: false,
  })
  assertAllStrings(meta)
  assert.equal(meta.transport, 'stream')
  assert.equal(meta.user, 'User')
  assert.equal('session_handle' in meta, false)
  assert.equal('backlog' in meta, false)
  assert.equal('system' in meta, false)
  assert.ok(meta.ts, 'ts must always be present')
})

test('stream inbound meta carries the system and backlog markers as strings', () => {
  const meta = buildStreamInboundMeta({
    chatId: '1048',
    messageId: 901,
    isSystem: true,
    senderUserId: 'user_h',
    assistantId: '900',
    ts: '2026-08-08T10:00:00.000Z',
    sessionHandle: 'sh_2',
    backlog: true,
    slashMeta: { event_type: 'slash_command', command_name: 'cost' },
    eventMeta: { event_source: 'scheduler' },
  })
  assertAllStrings(meta)
  assert.equal(meta.system, 'true')
  assert.equal(meta.sender_type, 'system')
  assert.equal(meta.user, 'System')
  assert.equal(meta.backlog, 'true')
  assert.equal(meta.session_handle, 'sh_2')
  assert.equal(meta.command_name, 'cost')
  assert.equal(meta.event_source, 'scheduler')
  assert.equal(meta.ts, '2026-08-08T10:00:00.000Z')
})

test('stream inbound meta carries peer origin fields as strings', () => {
  const meta = buildStreamInboundMeta({
    chatId: '3582',
    messageId: 47820,
    isSystem: false,
    senderType: 'agent',
    senderUserId: 'user_owner',
    assistantId: '901',
    backlog: false,
    agentOrigin: {
      sourceAssistantId: 900,
      sourceName: 'Data',
      targetAssistantId: 901,
      peerConversationId: 4595,
      messageId: 47820,
    },
    peerConversationId: '4595',
    turnState: 'final',
  })

  assertAllStrings(meta)
  assert.equal(meta.sender_type, 'agent')
  assert.equal(meta.peer_conversation_id, '4595')
  assert.equal(meta.turn_state, 'final')
  assert.equal('system' in meta, false)
})

test('stream click meta is all-string and omits an absent custom_text', () => {
  const bare = buildStreamClickMeta({
    chatId: '1048',
    messageId: 902,
    callbackData: 'pick_a',
    buttonText: 'Pick A',
    senderUserId: 'user_h',
    assistantId: '900',
  })
  assertAllStrings(bare)
  assert.equal(bare.event_type, 'button_clicked')
  assert.equal(bare.transport, 'stream')
  assert.equal('custom_text' in bare, false)
  assert.ok(bare.ts)

  const custom = buildStreamClickMeta({
    chatId: '1048',
    messageId: 903,
    callbackData: '__custom__',
    buttonText: '',
    customText: 'my own words',
    senderUserId: 'user_h',
    assistantId: '900',
    ts: '2026-08-08T11:00:00.000Z',
  })
  assertAllStrings(custom)
  assert.equal(custom.custom_text, 'my own words')
})
