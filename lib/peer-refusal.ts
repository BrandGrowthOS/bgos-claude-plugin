/**
 * The one backend refusal this daemon treats as PERMANENT for a chat.
 *
 * HOAI answers a write into a peer side-thread (an a2a chat) from an assistant
 * that is not the open conversation's initiator or peer with
 *
 *   403 {"statusCode":403,"message":"Caller assistant is not a participant of
 *        this peer conversation.","path":...,"timestamp":...}
 *
 * (BGOS backend/src/services/chat-participation.service.ts, assertPeerWrite;
 * the body is HttpExceptionAdvicer's, which forwards no `code` for a 403). It
 * is not a hiccup: the same write into the same conversation is refused every
 * time. POST /messages is the sharp case. It reads the caller assistant only
 * from an X-Caller-Assistant-Id header this daemon never sends on that route,
 * so every hook rail card into a peer side-thread with an open conversation
 * is refused, and a refused card used to be posted again on every 600 ms
 * flush: 378 refusals in one hour from one agent on 2026-10-07 (board row
 * a80d3683).
 *
 * WHAT IS READ, AND WHAT IS NOT. The status and the parsed body, never the
 * error's sentence: that sentence carries the request path, and a chat id in a
 * URL once silenced a chat numbered 4403 (see HttpError in server.ts). The
 * `message` field has to be the backend's reason, whole, anchored at both
 * ends. A `code` of `peer_not_participant` is accepted too, so the day the
 * backend adds a stable code for this refusal nothing here has to change.
 * Every other 403, and every 5xx, stays exactly what it was.
 */

export const PEER_NOT_PARTICIPANT = 'peer_not_participant'
export type PeerRefusal = typeof PEER_NOT_PARTICIPANT

/** The backend's own words, byte for byte. */
export const PEER_NOT_PARTICIPANT_MESSAGE =
  'Caller assistant is not a participant of this peer conversation.'

/** How many refused chats one process remembers, the bound closedPeerChats uses. */
export const REFUSED_CHATS_MAX = 500

/**
 * The permanent refusal a failed response carries, or null.
 *
 * `bodyText` is the WHOLE response body: the excerpt an error message keeps
 * can cut the JSON short, and then nothing could be read from it.
 */
export function classifyPeerRefusal(status: number, bodyText: string): PeerRefusal | null {
  if (status !== 403) return null
  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    return null
  }
  if (body === null || typeof body !== 'object') return null
  const { code, message } = body as { code?: unknown; message?: unknown }
  if (code === PEER_NOT_PARTICIPANT) return PEER_NOT_PARTICIPANT
  if (message === PEER_NOT_PARTICIPANT_MESSAGE) return PEER_NOT_PARTICIPANT
  return null
}

/** The permanent refusal a thrown HTTP failure carries, or null for any other error. */
export function peerRefusalOf(err: unknown): PeerRefusal | null {
  const refusal = (err as { peerRefusal?: unknown } | null)?.peerRefusal
  return err instanceof Error && refusal === PEER_NOT_PARTICIPANT ? PEER_NOT_PARTICIPANT : null
}

/** The chats a write was refused in for good. */
export interface RefusedChats {
  has(chatId: string): boolean
  add(chatId: string): void
  delete(chatId: string): boolean
  readonly size: number
}

/**
 * Insertion ordered and bounded: the oldest chat falls out at the limit, and
 * forgetting one costs a single attempt there, never a loop.
 */
export function createRefusedChats(limit: number = REFUSED_CHATS_MAX): RefusedChats {
  const chats = new Set<string>()
  return {
    has: (chatId) => chats.has(chatId),
    add: (chatId) => {
      chats.add(chatId)
      while (chats.size > limit) {
        const oldest = chats.values().next().value
        if (oldest === undefined) break
        chats.delete(oldest)
      }
    },
    delete: (chatId) => chats.delete(chatId),
    get size() {
      return chats.size
    },
  }
}

/**
 * What the model is handed instead of "Failed to send: POST 403: {...}".
 *
 * A typed result it cannot read as a hiccup: the type first, then what it
 * means, then the instruction. The raw failure read like any transient error,
 * and a model that retries a transient error, or obeys a reply-overdue nudge
 * to send again, was the other half of the loop.
 */
export function peerNotParticipantResult(chatId: string): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  return {
    content: [
      {
        type: 'text',
        text:
          `${PEER_NOT_PARTICIPANT}: HOAI refused this reply into chat ${chatId} ` +
          `(403: "${PEER_NOT_PARTICIPANT_MESSAGE}"). The peer conversation there is ` +
          'closed or you are not in it, so the reply cannot be delivered and the same ' +
          'send is refused every time. Do not retry it. Tell your owner only if it ' +
          'matters to them.',
      },
    ],
    isError: true,
  }
}
