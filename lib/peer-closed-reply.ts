/**
 * A reply into a peer side thread whose conversation has CLOSED (board row
 * 28fed1cd).
 *
 * On 2026-10-27 the conversation between Data and Ares closed on timeout, and
 * five of Data's later replies into that side thread were answered "Sent" and
 * never reached Ares, who asked the same questions four times.
 *
 * WHY "Sent" WAS NOT TRUE. HOAI holds the conversation's state. A participant's
 * /send-message into a closed side thread is accepted: the backend revives the
 * conversation (ChatParticipationService.reviveClosedPeerConversation, BGOS
 * #1265) and saves the reply, then forwards it to the other agent best effort
 * (SendMessageService.bridgePeerReplyIfApplicable), whose every refusal logs
 * and returns. The answer is 201 with the saved message either way, so the
 * daemon could only ever say the reply was saved, never that the peer got it.
 *
 * WHAT THE DAEMON DOES INSTEAD. It already learns every close (the socket's
 * peer_conversation_closed, the update stream's peer_closed, a final turn
 * either way), so a reply into a chat it saw close is refused here, before any
 * upload or POST, in words that send the agent to send_to_peer, which opens a
 * new conversation. A backend that reports the forward (`peerDelivery` on the
 * /send-message answer, the BGOS half of this row) covers the closes the
 * daemon did not see; with no such field nothing here changes.
 *
 * The words are plain on purpose: an agent may pass them to its owner.
 */

/** What HOAI said about forwarding a side thread reply to the other agent. */
export type PeerDeliveryState = 'forwarded' | 'not_forwarded'

/**
 * HOAI's own word on the forward, read off the /send-message answer, or null
 * when it gave none (a backend without the field, or a chat that is not a side
 * thread). Only the two exact states count; anything else is no word at all,
 * so an unknown value never turns a reply into an error.
 */
export function peerDeliveryOf(answer: unknown): PeerDeliveryState | null {
  if (answer === null || typeof answer !== 'object') return null
  const delivery = (answer as { peerDelivery?: unknown }).peerDelivery
  if (delivery === null || typeof delivery !== 'object') return null
  const state = (delivery as { state?: unknown }).state
  return state === 'forwarded' || state === 'not_forwarded' ? state : null
}

/** The reason HOAI gave for not forwarding, for the log line only. */
export function peerDeliveryReason(answer: unknown): string {
  const reason = (answer as { peerDelivery?: { reason?: unknown } } | null)?.peerDelivery?.reason
  return typeof reason === 'string' && /^[a-z_]{1,64}$/.test(reason) ? reason : 'no reason given'
}

/**
 * The reply was refused here: the conversation in that side thread closed, and
 * this daemon was told. Nothing was uploaded or posted.
 */
export function peerConversationClosedResult(chatId: string): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  return {
    content: [
      {
        type: 'text',
        text:
          `Not sent: the side conversation in chat ${chatId} has ended, so the other ` +
          'agent would not get a reply there. Nothing was posted. If they still need ' +
          'it, send it with send_to_peer, which starts a new conversation.',
      },
    ],
    isError: true,
  }
}

/**
 * HOAI saved the reply but said it did not pass it on to the other agent. The
 * message is in the side thread for the owner to see; the peer never got it.
 */
export function peerReplyNotForwardedResult(
  chatId: string,
  messageId: unknown,
): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  const saved = messageId != null ? ` (message ${String(messageId)})` : ''
  return {
    content: [
      {
        type: 'text',
        text:
          `Not delivered: HOAI saved this reply in the side conversation in chat ${chatId}${saved}, ` +
          'but did not pass it on to the other agent, so they will not see it. If they ' +
          'still need it, send it with send_to_peer, which starts a new conversation.',
      },
    ],
    isError: true,
  }
}

/**
 * The line a Sent gets when the conversation closed while the reply was on the
 * wire and HOAI said nothing either way: the reply went out, and whether it
 * landed before or after the close is not something this daemon can know.
 */
export const CLOSED_DURING_SEND_NOTE =
  'The side conversation ended while this reply was being sent, so the other agent ' +
  'may not get it. If they need it, send it again with send_to_peer.'
