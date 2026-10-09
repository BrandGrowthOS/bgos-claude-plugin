/**
 * The mark on a text this daemon posts AS the agent, UNPROMPTED, rather than
 * relaying the session's reply (HOAI board row 9c3d6b2c, session liveness):
 * its not answering warning, its goal and plan notices.
 *
 * Those go to /send-message with sender 'assistant', the same as the
 * session's own replies, so the server read them as the agent answering: the
 * warning that a session is not answering reset the hourly stall sweep behind
 * it. `postedBy: 'connection'` (the shared contract's field and word) tells
 * the server it is the connection speaking, and the sweep skips it. The
 * backend that reads it ships first; an older one ignores the key while its
 * validation stays lenient.
 *
 * Never on the session's own output (the `reply` tool, its questions, its
 * cards): that is exactly what the sweep must keep seeing. And never on this
 * daemon's ANSWER to the owner's own command (/status, /login, /compact, a
 * typed /stop): that answers a row the owner wrote, and marked, the row would
 * wait for ever and the sweep would flag a healthy agent.
 */
import { POSTED_BY_CONNECTION, POSTED_BY_FIELD } from './session-status-contract.ts'

export function markConnectionText<T extends Record<string, unknown>>(
  body: T,
): T & { postedBy: typeof POSTED_BY_CONNECTION } {
  return { ...body, [POSTED_BY_FIELD]: POSTED_BY_CONNECTION } as T & { postedBy: typeof POSTED_BY_CONNECTION }
}
