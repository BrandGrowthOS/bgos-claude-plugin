/**
 * The meeting wake card, built in one place for every transport.
 *
 * The backend delivers each meeting turn twice: a `meeting_message` broadcast
 * and an `inbound_message` twin addressed to each participant, which carries
 * a `meetingContext` holding the server's own verdict on whose turn it is.
 * Both share one message id, so whichever frame arrives first claims it and
 * the other is dropped by the forwarded-id dedupe.
 *
 * Until 0.39.8 the twin path ignored `meetingContext` and emitted a plain
 * chat card: no `[Meeting #N, your_turn=...]` header, no meeting meta, and an
 * agent's message labelled as if the user had sent it. Because the twin wins
 * the race about half the time, about half of all meeting turns reached the
 * agent with no turn marker at all (found in the 2026-09-19 meeting QA). The
 * same race also left the local meeting context stale, since the broadcast
 * handler returned on the dedupe before recording the new current speaker, so
 * the poll fallback then computed your_turn from an old speaker.
 *
 * Every meta value is a string and every optional is omitted when absent: the
 * Claude Code harness silently drops a channel card whose meta carries any
 * non-string value (the wake-card contract; see test/ws-inbound-meta.test.ts).
 */

export interface MeetingParticipantLike {
  assistantId: number
  name: string
}

export interface ParsedMeetingContext {
  meetingId: number
  title: string | null
  speakerPolicy: string | null
  currentSpeakerId: number | null
  yourTurn: boolean
  participants: MeetingParticipantLike[]
  senderName: string
  senderType: 'agent' | 'user'
}

function finiteOrNull(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * Normalise the `meetingContext` an `inbound_message` twin carries. Returns
 * null when the payload is not a meeting twin (no context, or no usable
 * meeting id), so the caller falls through to ordinary chat delivery.
 */
export function readMeetingContext(payload: unknown): ParsedMeetingContext | null {
  const p = payload as { meetingContext?: unknown; meeting_context?: unknown } | null
  const raw = (p?.meetingContext ?? p?.meeting_context) as Record<string, unknown> | null | undefined
  if (!raw || typeof raw !== 'object') return null
  const meetingId = finiteOrNull(raw.meetingId ?? raw.meeting_id)
  if (meetingId == null) return null
  const participantsRaw = Array.isArray(raw.participants) ? raw.participants : []
  const participants: MeetingParticipantLike[] = []
  for (const entry of participantsRaw) {
    const e = entry as { assistantId?: unknown; assistant_id?: unknown; name?: unknown } | null
    const id = finiteOrNull(e?.assistantId ?? e?.assistant_id)
    if (id == null) continue
    participants.push({ assistantId: id, name: typeof e?.name === 'string' ? e.name : '' })
  }
  const senderTypeRaw = String(raw.senderType ?? raw.sender_type ?? 'user')
  const senderType: 'agent' | 'user' = senderTypeRaw === 'agent' ? 'agent' : 'user'
  const nameRaw = typeof raw.senderName === 'string' ? raw.senderName.trim() : ''
  return {
    meetingId,
    title: typeof raw.title === 'string' ? raw.title : null,
    speakerPolicy:
      typeof raw.speakerPolicy === 'string' && raw.speakerPolicy ? raw.speakerPolicy : null,
    currentSpeakerId: finiteOrNull(raw.currentSpeakerId ?? raw.current_speaker_id),
    yourTurn: raw.yourTurn === true || raw.yourTurn === 'true',
    participants,
    senderName: meetingSenderLabel(senderType, nameRaw),
    senderType,
  }
}

/**
 * The name printed before the message. The twin labels a human sender "You"
 * (it is the sender's own word for themselves), which read from the agent's
 * side would claim the agent wrote it, so a human with no real name reads as
 * "User", matching the poll card.
 */
export function meetingSenderLabel(senderType: 'agent' | 'user', name: string): string {
  const trimmed = name.trim()
  if (senderType === 'agent') return trimmed || 'Another agent'
  if (!trimmed || trimmed.toLowerCase() === 'you') return 'User'
  return trimmed
}

export interface MeetingCardInput {
  meetingId: number
  chatId: string
  messageId: string
  userId: string
  assistantId: string
  timestamp: string
  transport: string
  yourTurn: boolean
  participants: MeetingParticipantLike[]
  senderName: string
  senderType: 'agent' | 'user'
  text: string
  senderAssistantId?: number | null
  currentSpeakerId?: number | null
  backlog?: boolean
}

// A type alias, not an interface: the MCP notification params type carries a
// string index signature, which an alias satisfies and an interface does not.
export type MeetingCard = {
  content: string
  meta: Record<string, string>
}

function isFiniteId(id: number | null | undefined): id is number {
  return typeof id === 'number' && Number.isFinite(id)
}

export function buildMeetingCard(input: MeetingCardInput): MeetingCard {
  const me = Number(input.assistantId)
  const participantList = input.participants
    .filter((p) => Number(p.assistantId) !== me)
    .map((p) => p.name)
    .filter((name) => name.length > 0)
    .join(', ')
  const turn = input.yourTurn ? 'YES' : 'NO'
  const content =
    (input.backlog ? '[backlog, meeting message arrived while you were offline]\n' : '') +
    `[Meeting #${input.meetingId}, your_turn=${turn}, ` +
    `participants: ${participantList || 'unknown'}]\n` +
    `${input.senderName}: ${input.text}`
  return {
    content,
    meta: {
      // Canonical envelope fields first: without them the harness renderer
      // drops the card (see the meeting_message handler's comment).
      chat_id: String(input.chatId),
      message_id: String(input.messageId),
      user: input.senderType === 'agent' ? String(input.senderName) : 'User',
      user_id: String(input.userId),
      assistant_id: String(input.assistantId),
      ts: String(input.timestamp),
      event_type: 'meeting_message',
      meeting_id: String(input.meetingId),
      sender_type: input.senderType,
      sender_name: String(input.senderName),
      your_turn: turn,
      ...(isFiniteId(input.senderAssistantId)
        ? { sender_assistant_id: String(input.senderAssistantId) }
        : {}),
      ...(isFiniteId(input.currentSpeakerId)
        ? { current_speaker_id: String(input.currentSpeakerId) }
        : {}),
      transport: String(input.transport),
      ...(input.backlog ? { backlog: 'true' } : {}),
    },
  }
}
