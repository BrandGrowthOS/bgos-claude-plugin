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
 * typed /stop): that answers a row the owner wrote, and marked as the
 * connection, the row would wait for ever and the sweep would flag a healthy
 * agent. Those answers carry their own mark instead, below.
 */
import { POSTED_BY_CONNECTION, POSTED_BY_FIELD } from './session-status-contract.ts'

export function markConnectionText<T extends Record<string, unknown>>(
  body: T,
): T & { postedBy: typeof POSTED_BY_CONNECTION } {
  return { ...body, [POSTED_BY_FIELD]: POSTED_BY_CONNECTION } as T & { postedBy: typeof POSTED_BY_CONNECTION }
}

/**
 * The mark on this daemon's ANSWER to the owner's own command: /status and
 * /compact (sendDaemonText), /login (sendLoginText) and the owner's Stop
 * confirmation. The server still reads the answer as answering the owner's
 * row, so the stall sweep is unchanged. What it changes is the usage limit
 * hold: unmarked, the answer to a /login typed after a limit report read as
 * the agent answering, and the agent's row read Running while it was still on
 * its limit. Marked, the hold waits for the session's own reply.
 *
 * Not in lib/session-status-contract.ts on purpose: that file is copied byte
 * for byte between repositories and pinned by digest. The server keeps this
 * word only from the agent's own pairing; an older server ignores it.
 */
export const POSTED_BY_COMMAND_ANSWER = 'command_answer'

export function markCommandAnswer<T extends Record<string, unknown>>(
  body: T,
): T & { postedBy: typeof POSTED_BY_COMMAND_ANSWER } {
  return { ...body, [POSTED_BY_FIELD]: POSTED_BY_COMMAND_ANSWER } as T & { postedBy: typeof POSTED_BY_COMMAND_ANSWER }
}
