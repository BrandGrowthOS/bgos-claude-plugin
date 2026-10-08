/**
 * The two backend refusals this daemon treats as PERMANENT for a chat.
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
 *
 * THE SECOND ONE, found by the review of #186. In a CLOSED side-thread the
 * participant check passes, and POST /messages refuses instead with
 *
 *   400 {"statusCode":400,"message":"A2A messages must use /send-message",
 *        "path":...,"timestamp":...,"operation":"MESSAGE"}
 *
 * (BGOS MessageService.prepareMessageForWrite: an a2a chat takes writes only
 * through /send-message; HttpExceptionAdvicer turns its ServiceException into
 * a 400 with `operation` and no `code`, and logs only 401, 403 and 429, so the
 * denial log that counted the 403s never counted these; the backend's trace is
 * the participation check's legacy a2a warning, one line per post). A chat's kind never changes, so this
 * one is permanent for the chat outright. It is read the same narrow way: the
 * 400 status, and the `message` whole and anchored, or a `code` of
 * `a2a_route_required` once the backend sends one. Every other 400 stays
 * exactly what it was, and neither reason counts on the other's status.
 */

export const PEER_NOT_PARTICIPANT = 'peer_not_participant'
export const A2A_ROUTE_REQUIRED = 'a2a_route_required'
/**
 * The code BGOS actually ships for the a2a route refusal (backend
 * a2a-write-refusals.ts, BGOS #2038, 2026-10-08). This file was written before
 * the backend chose a name and guessed `a2a_route_required`; both are accepted,
 * and the message text match below still answers for a backend that sends no
 * code at all.
 */
export const A2A_WRONG_ROUTE_CODE = 'a2a_wrong_route'
export type PeerRefusal = typeof PEER_NOT_PARTICIPANT | typeof A2A_ROUTE_REQUIRED

/** The backend's own words, byte for byte. */
export const PEER_NOT_PARTICIPANT_MESSAGE =
  'Caller assistant is not a participant of this peer conversation.'

/** The backend's own words for the a2a route refusal, byte for byte. */
export const A2A_ROUTE_REQUIRED_MESSAGE = 'A2A messages must use /send-message'

/** The status each refusal arrives with, for the log line that names it. */
export function peerRefusalStatus(refusal: PeerRefusal): 400 | 403 {
  return refusal === A2A_ROUTE_REQUIRED ? 400 : 403
}

/** How many refused chats one process remembers, the bound closedPeerChats uses. */
export const REFUSED_CHATS_MAX = 500

/**
 * The permanent refusal a failed response carries, or null.
 *
 * `bodyText` is the WHOLE response body: the excerpt an error message keeps
 * can cut the JSON short, and then nothing could be read from it.
 */
export function classifyPeerRefusal(status: number, bodyText: string): PeerRefusal | null {
  // Each refusal on its own status only: the status picks which one is asked.
  const refusal =
    status === 403 ? PEER_NOT_PARTICIPANT : status === 400 ? A2A_ROUTE_REQUIRED : null
  if (refusal === null) return null
  const reason =
    refusal === PEER_NOT_PARTICIPANT ? PEER_NOT_PARTICIPANT_MESSAGE : A2A_ROUTE_REQUIRED_MESSAGE
  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    return null
  }
  if (body === null || typeof body !== 'object') return null
  const { code, message } = body as { code?: unknown; message?: unknown }
  if (code === refusal) return refusal
  if (refusal === A2A_ROUTE_REQUIRED && code === A2A_WRONG_ROUTE_CODE) return refusal
  if (message === reason) return refusal
  return null
}

/** The permanent refusal a thrown HTTP failure carries, or null for any other error. */
export function peerRefusalOf(err: unknown): PeerRefusal | null {
  const refusal = (err as { peerRefusal?: unknown } | null)?.peerRefusal
  if (!(err instanceof Error)) return null
  return refusal === PEER_NOT_PARTICIPANT || refusal === A2A_ROUTE_REQUIRED ? refusal : null
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
          `(403: "${PEER_NOT_PARTICIPANT_MESSAGE}"). The conversation open in that ` +
          'side-thread is not one you are in: yours there has closed, or you were ' +
          'never in it. The reply cannot be delivered, and the same send is refused ' +
          'every time. Do not retry it. Tell your owner only if it matters to them.',
      },
    ],
    isError: true,
  }
}

/**
 * What the model is handed when a card or a question it asked for is refused
 * with the a2a 400, instead of "Failed to send ...: POST 400: {...}". Same
 * shape as the participant result: the type first, then what it means, then
 * the instruction, so it cannot be read as a hiccup worth another try.
 */
export function a2aRouteRequiredResult(
  chatId: string,
  what: string,
): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  return {
    content: [
      {
        type: 'text',
        text:
          `${A2A_ROUTE_REQUIRED}: HOAI refused ${what} in chat ${chatId} ` +
          `(400: "${A2A_ROUTE_REQUIRED_MESSAGE}"). That chat is a peer side-thread, ` +
          'which takes messages only through /send-message, so cards, questions and ' +
          'plans cannot be posted there, and the same post is refused every time. Do ' +
          'not retry it. Anything for your owner belongs in your owner\'s chat. A ' +
          'reply in this side-thread reaches the peer agent, not your owner, and ' +
          'reopens a closed conversation, so send one only if the peer needs to hear it.',
      },
    ],
    isError: true,
  }
}

/**
 * The chat a permission approval card goes to: the first monitored chat that
 * has not refused this agent's posts for good. The card used to go to
 * monitoredChatIds[0] unconditionally, so when that chat was a peer
 * side-thread every approval request posted again, was refused again, and
 * failed closed again (Ares's check of plugin 0.62.1, 2026-10-08). Undefined
 * when every monitored chat has refused, and the caller denies, as it does
 * when there is no chat at all.
 */
export function pickPermissionChat(
  monitored: readonly string[],
  refused: ReadonlyArray<Pick<RefusedChats, 'has'>>,
): string | undefined {
  return monitored.find((chatId) => !refused.some((set) => set.has(chatId)))
}
