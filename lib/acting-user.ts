/**
 * WHICH HUMAN this daemon is acting for, on the agent surfaces (boards today).
 *
 * KC, 2026-09-16: "If someone uses a shared agent to create boards or
 * whatever it is, a browser, they should all be on the account of the person
 * with the agent that was shared with it, not the owner."
 *
 * The backend reads one request header, X-BGOS-Acting-User, as a CLAIM about
 * the human behind a call and admits it only through an ACTIVE share of this
 * assistant to that person (BGOS backend/src/common/shared-agent-acting-user.ts,
 * PR #1472). No header, or a header naming the owner, is the owner's own path
 * with no database read at all. The daemon's whole job here is to NAME the
 * person whose turn it is serving, and to say nothing when that is the owner,
 * so the owner's wire stays byte-identical to before.
 *
 * WHO THAT IS. The sender of the most recent inbound USER message, whichever
 * transport delivered it (poll, stream, WS). A tool call carries no chat
 * context (the CallTool handler sees only the request), so a single pointer
 * beside server.ts's per-chat lastInboundUserByChat answers "whose turn is
 * this". The pointer keeps the sender id it was written with rather than
 * re-reading the per-chat map at header time: the WS path writes that map for
 * peer (agent) inbounds as well, so a later peer message in the same chat
 * could overwrite the recipient's entry and mis-name the human. The id itself
 * is the same senderUserIdOf value server.ts writes to the map on the same
 * line, so the identity source is unchanged.
 *
 * WHAT NEVER MOVES IT. A peer (agent) inbound: its owner did not send a turn,
 * and naming them would either be refused by the backend or, worse, admitted
 * through a share they happen to hold. A system inbound: not a human turn. An
 * inbound without a chat id or a sender id. A proactive call with no user turn
 * seen resolves to the owner, exactly today's behaviour.
 */

/** The request header the backend reads. Node lowercases it on arrival. */
export const ACTING_USER_HEADER = 'X-BGOS-Acting-User'

export interface ActingUserInbound {
  chatId: string
  /** The resolved sender id (server.ts's senderUserIdOf), owner fallback included. */
  userId: string
  /** 'user' | 'system' | 'agent' | 'assistant' | 'unknown', as the transport labelled it. */
  senderType: string | null | undefined
  /** Non-null on a peer message, whatever senderType says. */
  agentOrigin?: unknown
}

export interface ActingUserTracker {
  /** Record an inbound. Only a real user turn moves the pointer. */
  noteInbound(inbound: ActingUserInbound): void
  /** The user id the daemon acts for right now; the owner before any user turn. */
  current(): string
  /** The chat the current answer came from; null before any user turn. */
  currentChatId(): string | null
  /** Headers to add to an agent-surface call. Empty on the owner's own path. */
  headers(): Record<string, string>
}

/**
 * The header for a resolved acting user. Empty when the id is blank or is the
 * owner: the backend treats a header naming the owner as the zero-read owner
 * path, but not sending it at all keeps the owner's requests identical to
 * every request the plugin has sent so far.
 */
export function actingUserHeaders(
  actingUserId: string,
  ownerUserId: string,
): Record<string, string> {
  const id = String(actingUserId ?? '').trim()
  if (!id || id === ownerUserId) return {}
  return { [ACTING_USER_HEADER]: id }
}

/** True only for a human turn: labelled user, and not carried by a peer. */
export function isUserTurn(inbound: Pick<ActingUserInbound, 'senderType' | 'agentOrigin'>): boolean {
  return inbound.senderType === 'user' && inbound.agentOrigin == null
}

export function createActingUserTracker(opts: {
  ownerUserId: string
  /** Called only when the acting user actually changes, so a log can show the switch. */
  onChange?: (next: { userId: string; chatId: string }, previousUserId: string) => void
}): ActingUserTracker {
  let last: { chatId: string; userId: string } | null = null
  const current = (): string => last?.userId ?? opts.ownerUserId
  return {
    noteInbound(inbound) {
      if (!isUserTurn(inbound)) return
      const chatId = String(inbound.chatId ?? '').trim()
      const userId = String(inbound.userId ?? '').trim()
      if (!chatId || !userId) return
      const previous = current()
      last = { chatId, userId }
      if (userId !== previous) opts.onChange?.({ userId, chatId }, previous)
    },
    current,
    currentChatId: () => last?.chatId ?? null,
    headers: () => actingUserHeaders(current(), opts.ownerUserId),
  }
}
