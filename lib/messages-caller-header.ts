/**
 * The X-Caller-Assistant-Id header for a generic `POST /messages`.
 *
 * The backend reads the writing agent on that route ONLY from this header
 * (BGOS message.controller.ts toPrincipal), and its `raw_chatid_shadow` line,
 * which counts every write still addressed by a raw chat id, records it as
 * `callerAssistantId`. This daemon never sent it there, so every hook rail
 * card, plan, question carousel, component card and permission card it posted
 * logged a null caller: 3,445 of the 3,907 shadow lines on 2026-10-10 (board
 * row 019ff949). A null line names no agent, and naming the agents that still
 * use raw chat ids is the whole point of the line.
 *
 * Only the exact `messages` route. `send-message` already names the agent in
 * its body; `messages/bulk`, `meetings/:id/messages` and the rest are left as
 * they are.
 *
 * Not into a chat the caller withholds for, which server.ts makes the meetings
 * and the peer side-threads this daemon knows. Both are places where a caller
 * id changes what the backend DOES, not only what it logs:
 *   - a meeting: the backend lets a seated caller's generic write through, so
 *     the header would put hook rail cards into a shared meeting transcript
 *     that today refuses them (a meeting reply uses `meetings/:id/messages`);
 *   - a side-thread: the write is refused 400 `a2a_wrong_route` either way,
 *     but with a participant's id the backend first REVIVES a closed
 *     conversation (ChatParticipationService.reviveClosedPeerConversation:
 *     reopens the row, hands the turn to the peer) and the reopen survives the
 *     400. Without an id the revive is skipped and nothing is written.
 *
 * The header changes nothing else for an owner's own chat: the backend checks
 * that the named agent belongs to the authenticated owner, which this
 * daemon's own agent always does.
 */
export function messagesCallerHeaders(input: {
  path: string
  body: Record<string, unknown>
  assistantId: string | null | undefined
  /** True for a chat that must get no caller id. Read only for a messages
   *  post with a chat id, so a caller may close over sets declared later in
   *  its module. */
  withholdForChat: (chatId: string) => boolean
}): Record<string, string> {
  if (input.path.replace(/^\//, '') !== 'messages') return {}
  const id = (input.assistantId ?? '').trim()
  if (!/^[1-9]\d*$/.test(id)) return {}
  const chatId = input.body?.chatId
  if (chatId != null && input.withholdForChat(String(chatId))) return {}
  return { 'X-Caller-Assistant-Id': id }
}
