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

/** The reason HOAI gave for not forwarding, for the log line and the check below. */
export function peerDeliveryReason(answer: unknown): string {
  const reason = (answer as { peerDelivery?: { reason?: unknown } } | null)?.peerDelivery?.reason
  return typeof reason === 'string' && /^[a-z_]{1,64}$/.test(reason) ? reason : 'no reason given'
}

/**
 * The reasons that mean the conversation in that chat is over, so the next
 * reply there would be refused too. Any other reason (a failure inside the
 * forward, the other agent offline, a refused writer, a paused contact link)
 * fails that one reply and leaves the next one to HOAI.
 */
const CONVERSATION_ENDED_REASONS = new Set(['conversation_not_open', 'no_conversation'])

/** Whether HOAI's not_forwarded answer says the conversation itself is over. */
export function peerConversationEnded(answer: unknown): boolean {
  return CONVERSATION_ENDED_REASONS.has(peerDeliveryReason(answer))
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
          `Not sent: the side conversation in chat ${chatId} has ended, and a reply ` +
          'there may never reach the other agent. Nothing was posted. If they still ' +
          'need it, send it with send_to_peer, which starts a new conversation.',
      },
    ],
    isError: true,
  }
}

/**
 * HOAI saved the reply but said it did not pass it on, because the
 * conversation in that chat is over. The message is in the side thread for the
 * owner to see; the peer never got it.
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
          'but that conversation has ended, so it was not passed on to the other agent. If ' +
          'they still need it, send it with send_to_peer, which starts a new conversation.',
      },
    ],
    isError: true,
  }
}

/**
 * Why HOAI did not pass a reply on, for the reasons with a remedy of their own:
 * send_to_peer is refused while a contact link is not active, and carries no
 * files.
 */
const NOT_PASSED_ON_BECAUSE = new Map<string, string>([
  [
    'peer_offline',
    'but the other agent is not connected right now, so it was not passed on. If they still ' +
      'need it, send it with send_to_peer.',
  ],
  [
    'contact_link_inactive',
    "but the connection with that agent's owner is paused or was removed, so it was not " +
      'passed on. Nothing reaches that agent until the connection is active again.',
  ],
  [
    'external_files_unsupported',
    'but files cannot go to an agent of another account, so it was not passed on. If they ' +
      'still need it, send the words with send_to_peer and share the file as a link.',
  ],
])

/**
 * HOAI saved the reply but did not pass it on, for a reason that does not end
 * the conversation (a failure inside the forward, the other agent offline, a
 * paused contact link). Only this reply failed; the next one is HOAI's to
 * answer.
 */
export function peerReplyNotPassedOnResult(
  chatId: string,
  messageId: unknown,
  reason: string,
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
          (NOT_PASSED_ON_BECAUSE.get(reason) ??
            'but did not pass it on to the other agent. If they still need it, send it with send_to_peer.'),
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
