/**
 * Pure decisions for applying replayed Agent Update Stream updates
 * (docs/architecture/agent-message-routing.md 5.5 and 5.7; the doc lives in
 * the BGOS repo). server.ts owns the impure wiring (forwarding, cursor
 * advances, permission resolution); everything that can be decided from data
 * alone is decided here so it is testable without a daemon.
 *
 * The 5.7 contract encoded here:
 *  - message_new authored by the assistant itself only advances cursors
 *    (the reply boundary; forwarding it would make the agent talk to
 *    itself).
 *  - message_new with an EMPTY system body is HELD exactly like the poll's
 *    pending-empty park: the id is remembered, nothing is forwarded, the
 *    per-chat cursor must not step past it. The later message_finalized for
 *    that id delivers AS the wake, not as an edit.
 *  - The per-chat cursor remains the dedup substrate forever: a row at or
 *    under it was handled in a previous run and only advances the stream
 *    cursor.
 *  - buttons_answered forwards iff the id is not in the announced-clicks
 *    dedup set shared with the poll's transition detector; the caller then
 *    marks it announced and consumes any live-tracked baseline entry so the
 *    poll cannot announce a second time (single-announce contract, both
 *    race orders, including ids the poll never baselined).
 *
 * All meta builders return ALL-STRING records with absent optionals OMITTED
 * (the wake-card contract: the Claude Code harness silently drops any
 * channel card whose meta carries a non-string value).
 */

import type { StreamUpdate } from './update-stream.ts'
import {
  buildInboundChannel,
  type AgentOriginLike,
  isSelfAuthoredAgentOrigin,
} from './inbound-channel.ts'

// ── Payload normalization ────────────────────────────────────────────────────

export interface StreamAnswerPayload {
  callbackData: string
  buttonText: string
  customText: string | undefined
}

export interface StreamMessageView {
  chatId: string
  messageId: number
  text: string
  files: unknown[]
  senderKind: 'user' | 'assistant' | 'system' | 'agent' | 'unknown'
  agentOrigin?: AgentOriginLike
  peerConversationId?: string
  turnState?: string
  sessionHandle?: string
  messageType: string
  senderUserId?: string
  sentDate?: string
  eventMetaRaw:
    | { source?: string | null; title?: string | null; peek?: string | null; payload?: unknown }
    | null
  answerPayload: StreamAnswerPayload | null
  /** The raw payload, for slash routing (routeSlashCommand reads it). */
  raw: Record<string, unknown>
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function senderKindOf(value: unknown): StreamMessageView['senderKind'] {
  return value === 'user' || value === 'assistant' || value === 'system' || value === 'agent'
    ? value
    : 'unknown'
}

function answerPayloadOf(raw: unknown): StreamAnswerPayload | null {
  const r = raw as Record<string, unknown> | null | undefined
  if (!r || typeof r !== 'object') return null
  const callbackData = String(r.callbackData ?? r.callback_data ?? '')
  const buttonText = String(r.buttonText ?? r.button_text ?? '')
  const customText = str(r.customText ?? r.custom_text)
  if (!callbackData && !buttonText && !customText) return null
  return { callbackData, buttonText, customText }
}

/**
 * Normalize an update payload into one view, accepting BOTH wire shapes:
 * the live-push shape (flat: text, files, senderType, sessionHandle) and the
 * poll-row shape ({ message: {...}, messageFiles: [...] }), since hydration
 * rebuilds rows through the same serializers those lanes use. Returns null
 * when no message id is resolvable.
 */
export function viewStreamMessage(
  update: StreamUpdate,
  recipientAssistantId?: string | number,
): StreamMessageView | null {
  const payload = (update.payload ?? {}) as Record<string, unknown>
  const envelope = payload.message as Record<string, unknown> | undefined
  const isRow = envelope != null && typeof envelope === 'object'
  const source = isRow ? envelope! : payload

  const messageIdRaw =
    source.messageId ?? source.message_id ?? (isRow ? source.id : undefined) ??
    update.messageId
  const messageId = messageIdRaw == null ? Number.NaN : Number(messageIdRaw)
  if (!Number.isFinite(messageId)) return null
  const chatIdRaw =
    source.chatId ?? source.chat_id ?? payload.chatId ?? payload.chat_id ?? update.chatId
  const chatId = chatIdRaw == null ? '' : String(chatIdRaw)

  const agentOrigin = (
    source.agentOrigin ??
    source.agent_origin ??
    payload.agentOrigin ??
    payload.agent_origin
  ) as AgentOriginLike | undefined
  const declaredSenderType =
    source.senderType ??
    source.sender_type ??
    payload.senderType ??
    payload.sender_type
  const persistedSenderKind = isRow
    ? senderKindOf(source.sender)
    : typeof payload.sender === 'string'
      ? senderKindOf(payload.sender)
      : 'unknown'
  const isSelfAuthoredAgent =
    recipientAssistantId != null &&
    isSelfAuthoredAgentOrigin(agentOrigin, recipientAssistantId)
  const senderKind =
    persistedSenderKind === 'assistant' || isSelfAuthoredAgent
      ? 'assistant'
      : agentOrigin
        ? 'agent'
        : declaredSenderType != null
          ? senderKindOf(declaredSenderType)
          : persistedSenderKind !== 'unknown'
            ? persistedSenderKind
            : isRow
              ? 'unknown'
              : 'user'

  const files = isRow
    ? Array.isArray(payload.messageFiles)
      ? payload.messageFiles
      : []
    : Array.isArray(payload.files)
      ? payload.files
      : []

  const nestedSender = (isRow ? undefined : payload.sender) as
    | { userId?: unknown }
    | undefined
  const senderUserId =
    str(nestedSender && typeof nestedSender === 'object' ? nestedSender.userId : undefined) ??
    str(source.senderUserId ?? source.sender_user_id) ??
    str(isRow ? undefined : (payload.userId ?? payload.user_id))
  const peerConversationIdRaw =
    source.peerConversationId ??
    source.peer_conversation_id ??
    payload.peerConversationId ??
    payload.peer_conversation_id ??
    agentOrigin?.peerConversationId
  const turnStateRaw =
    source.turnState ??
    source.turn_state ??
    payload.turnState ??
    payload.turn_state

  return {
    chatId,
    messageId,
    text: String(source.text ?? ''),
    files,
    senderKind,
    agentOrigin,
    peerConversationId:
      peerConversationIdRaw == null
        ? undefined
        : String(peerConversationIdRaw),
    turnState: turnStateRaw == null ? undefined : String(turnStateRaw),
    sessionHandle: str(source.sessionHandle ?? source.session_handle),
    messageType: String(source.messageType ?? source.message_type ?? ''),
    senderUserId,
    sentDate: str(source.sentDate ?? source.sent_date),
    eventMetaRaw:
      ((source.eventMeta ?? source.event_meta) as StreamMessageView['eventMetaRaw']) ??
      null,
    answerPayload: answerPayloadOf(source.answerPayload ?? source.answer_payload),
    raw: source,
  }
}

// ── message_new / message_finalized decisions (5.7) ──────────────────────────

export type StreamMessageDecision =
  | { action: 'forward'; isSystem: boolean }
  | { action: 'hold_empty' }
  | {
      action: 'advance_only'
      reason:
        | 'assistant_authored'
        | 'already_covered'
        | 'already_forwarded'
        | 'empty_non_system'
    }

function isEmptyBody(view: StreamMessageView): boolean {
  return view.text.trim().length === 0 && view.files.length === 0
}

export function decideMessageNew(
  view: StreamMessageView,
  opts: { lastSeenInChat: number; alreadyForwarded: boolean },
): StreamMessageDecision {
  if (view.senderKind === 'assistant') {
    return { action: 'advance_only', reason: 'assistant_authored' }
  }
  if (view.messageId <= opts.lastSeenInChat) {
    return { action: 'advance_only', reason: 'already_covered' }
  }
  const empty = isEmptyBody(view)
  if (empty && view.senderKind === 'system') return { action: 'hold_empty' }
  if (opts.alreadyForwarded) {
    return { action: 'advance_only', reason: 'already_forwarded' }
  }
  if (empty) return { action: 'advance_only', reason: 'empty_non_system' }
  return { action: 'forward', isSystem: view.senderKind === 'system' }
}

export function decideMessageFinalized(
  view: StreamMessageView,
  opts: { held: boolean; lastSeenInChat: number; alreadyForwarded: boolean },
): StreamMessageDecision {
  if (view.senderKind === 'assistant') {
    return { action: 'advance_only', reason: 'assistant_authored' }
  }
  if (opts.held) {
    // The wake's body fill: deliver AS the wake, unless the fill is somehow
    // still empty, in which case it stays parked for the next fill.
    if (isEmptyBody(view)) return { action: 'hold_empty' }
    return {
      action: 'forward',
      isSystem: view.senderKind !== 'user' && view.senderKind !== 'agent',
    }
  }
  if (view.messageId <= opts.lastSeenInChat) {
    return { action: 'advance_only', reason: 'already_covered' }
  }
  if (opts.alreadyForwarded) {
    return { action: 'advance_only', reason: 'already_forwarded' }
  }
  if (isEmptyBody(view)) {
    return { action: 'advance_only', reason: 'empty_non_system' }
  }
  // Never delivered (e.g. the poll parked under the write-1 row and this
  // daemon only now catches up): the finalize IS the delivery.
  return {
    action: 'forward',
    isSystem: view.senderKind !== 'user' && view.senderKind !== 'agent',
  }
}

// ── buttons_answered (single-announce contract) ──────────────────────────────

export type ButtonsAnsweredDecision = 'forward' | 'permission' | 'skip'

/**
 * The gate is an announced-ids dedup set SHARED with the poll's announce
 * path, not the live-tracked baseline. A tracked-only gate black-holes
 * clicks under stream mode: the healthy sweep stretches to daily, so an id
 * pollChat never baselined would be skipped here AND could never be
 * announced by selectClickTransitions either (it only announces ids seen
 * unanswered on a PREVIOUS poll). Single-announce holds in both race
 * orders: poll-first, the shared set blocks the stream replay; stream
 * first, the caller consumes the tracked baseline entry so the poll's
 * prevUnanswered can never contain the id again.
 */
export function decideButtonsAnswered(opts: {
  messageType: string | null | undefined
  callbackData: string
  /** True when either transport already announced this id (the shared set). */
  alreadyAnnounced: boolean
  permissionRe: RegExp
}): ButtonsAnsweredDecision {
  if (opts.messageType === 'ask_user_input') return 'skip'
  if (opts.alreadyAnnounced) return 'skip'
  if (opts.permissionRe.test(opts.callbackData)) return 'permission'
  return 'forward'
}

// ── Kind classification (the consumer half of 5.8) ───────────────────────────

export type StreamKindClass =
  | 'message_new'
  | 'message_finalized'
  | 'buttons_answered'
  | 'chat_created'
  | 'chat_deleted'
  | 'reconcile'
  | 'peer_closed'
  | 'config'
  | 'noop'

/**
 * Membership-shaped kinds route to the existing discovery reconciliation
 * (discoverChats re-fetches meetings and reconciles contexts); deadline
 * bound kinds (turns, policies) and idempotent tombstones are logged no-ops,
 * because replaying a stale turn wakes an agent for a floor it no longer
 * holds (5.5). Unknown future kinds are no-ops, never a throw.
 */
export function classifyStreamKind(kind: string): StreamKindClass {
  switch (kind) {
    case 'message_new':
      return 'message_new'
    case 'message_finalized':
      return 'message_finalized'
    case 'buttons_answered':
      return 'buttons_answered'
    case 'chat_created':
      return 'chat_created'
    case 'chat_deleted':
      return 'chat_deleted'
    case 'seat_granted':
    case 'seat_revoked':
    case 'meeting_opened':
    case 'meeting_closed':
    case 'meeting_participants':
      return 'reconcile'
    case 'peer_closed':
      return 'peer_closed'
    case 'config_changed':
      return 'config'
    default:
      return 'noop'
  }
}

// ── All-string meta builders (wake-card contract) ────────────────────────────

/**
 * The stream twin of the poll path's inbound meta: every value a string,
 * absent optionals OMITTED (never null or undefined), transport 'stream'.
 */
export function buildStreamInboundMeta(opts: {
  chatId: string
  messageId: number
  isSystem: boolean
  senderUserId: string
  assistantId: string
  ts?: string
  sessionHandle?: string
  backlog: boolean
  slashMeta?: Record<string, string> | null
  eventMeta?: Record<string, string> | null
  senderType?: string
  agentOrigin?: AgentOriginLike
  peerConversationId?: string
  turnState?: string
}): Record<string, string> {
  return buildInboundChannel({
    chatId: opts.chatId,
    messageId: opts.messageId,
    userId: opts.senderUserId,
    assistantId: opts.assistantId,
    timestamp: opts.ts,
    transport: 'stream',
    text: '',
    senderType: opts.senderType ?? (opts.isSystem ? 'system' : 'user'),
    agentOrigin: opts.agentOrigin,
    peerConversationId: opts.peerConversationId,
    turnState: opts.turnState,
    sessionHandle: opts.sessionHandle,
    backlog: opts.backlog,
    extraMeta: {
      ...(opts.slashMeta ?? {}),
      ...(opts.eventMeta ?? {}),
    },
  }).meta
}

/** The stream twin of the poll path's button_clicked meta. */
export function buildStreamClickMeta(opts: {
  chatId: string
  messageId: number
  callbackData: string
  buttonText: string
  customText?: string
  senderUserId: string
  assistantId: string
  ts?: string
}): Record<string, string> {
  return {
    chat_id: String(opts.chatId),
    message_id: String(opts.messageId),
    event_type: 'button_clicked',
    callback_data: String(opts.callbackData),
    button_text: String(opts.buttonText),
    ...(opts.customText ? { custom_text: String(opts.customText) } : {}),
    user: 'User',
    user_id: String(opts.senderUserId),
    assistant_id: String(opts.assistantId),
    ts: String(opts.ts ?? new Date().toISOString()),
    transport: 'stream',
  }
}
