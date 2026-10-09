/**
 * The mark on a text this daemon posts AS the agent rather than relaying the
 * session's reply (HOAI board row 9c3d6b2c, session liveness): its not
 * answering warning, its /status, /login and /compact answers, its goal and
 * plan notices, its "Asked to stop." line.
 *
 * Those go to /send-message with sender 'assistant', the same as the
 * session's own replies, so the server read them as the agent answering: the
 * warning that a session is not answering reset the hourly stall sweep behind
 * it. `postedBy: 'connection'` (the shared contract's field and word) tells
 * the server it is the connection speaking, and the sweep skips it. An older
 * server ignores the key, so this ships in either order.
 *
 * Never on the session's own output (the `reply` tool, its questions, its
 * cards): that is exactly what the sweep must keep seeing.
 */
import { POSTED_BY_CONNECTION, POSTED_BY_FIELD } from './session-status-contract.ts'

export function markConnectionText<T extends Record<string, unknown>>(
  body: T,
): T & { postedBy: typeof POSTED_BY_CONNECTION } {
  return { ...body, [POSTED_BY_FIELD]: POSTED_BY_CONNECTION } as T & { postedBy: typeof POSTED_BY_CONNECTION }
}
