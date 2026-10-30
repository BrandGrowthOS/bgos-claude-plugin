/**
 * HOAI's word on a reply into a peer side thread: did the other agent get it
 * (board row 28fed1cd)?
 *
 * On 2026-10-27 the conversation between Data and Ares closed on timeout, and
 * five of Data's later replies into that side thread were answered "Sent" and
 * never reached Ares, who asked the same questions four times.
 *
 * WHY "Sent" WAS NOT TRUE. HOAI holds the conversation's state. A participant's
 * /send-message into a closed side thread is accepted: the backend reopens the
 * conversation (ChatParticipationService.reviveClosedPeerConversation, BGOS
 * #1265, Kc's rule) and saves the reply, then forwards it to the other agent
 * best effort (SendMessageService.bridgePeerReplyIfApplicable). The answer was
 * 201 with the saved message either way, so the daemon could only ever say the
 * reply was saved, never that the peer got it.
 *
 * WHAT THE DAEMON DOES. A reply into a closed conversation still goes to HOAI,
 * which reopens it (Data, 2026-10-28: the reopen rule holds). HOAI now says
 * whether it forwarded the reply (`peerDelivery` on the /send-message answer,
 * BGOS #3420). `not_forwarded` is an error that says why and offers only a
 * remedy that works; `forwarded`, or no field at all (a backend without
 * #3420), is the Sent it always was.
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

/** The reason HOAI gave for not forwarding, for the log line and the words below. */
export function peerDeliveryReason(answer: unknown): string {
  const reason = (answer as { peerDelivery?: { reason?: unknown } } | null)?.peerDelivery?.reason
  return typeof reason === 'string' && /^[a-z_]{1,64}$/.test(reason) ? reason : 'no reason given'
}

/**
 * The reasons that mean the conversation in that chat is over, so the error
 * says it ended. Any other reason (a
 * failure inside the forward, the other agent offline, a refused writer, a
 * paused contact link) says only that this reply was not passed on.
 */
const CONVERSATION_ENDED_REASONS = new Set(['conversation_not_open', 'no_conversation'])

/** Whether HOAI's not_forwarded answer says the conversation itself is over. */
export function peerConversationEnded(answer: unknown): boolean {
  return CONVERSATION_ENDED_REASONS.has(peerDeliveryReason(answer))
}

/**
 * What the agent can do instead. send_to_peer reaches the other agent in a new
 * conversation or the pair's open one, and carries words only, so a reply with
 * files is told to share them as a link.
 */
function sendToPeerInstead(withFiles: boolean): string {
  return withFiles
    ? 'If they still need it, send the words with send_to_peer and share the files as a link: ' +
        'send_to_peer carries no files.'
    : 'If they still need it, send it with send_to_peer.'
}

/**
 * HOAI saved the reply but said it did not pass it on, because the
 * conversation in that chat is over. The message is in the side thread for the
 * owner to see; the peer never got it.
 */
export function peerReplyNotForwardedResult(
  chatId: string,
  messageId: unknown,
  withFiles: boolean,
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
          `but that conversation has ended, so it was not passed on to the other agent. ${sendToPeerInstead(withFiles)}`,
      },
    ],
    isError: true,
  }
}

/** Why HOAI did not pass a reply on, for the reasons that say more than that it did not. */
const NOT_PASSED_ON_BECAUSE = new Map<string, string>([
  ['peer_offline', 'but the other agent is not connected right now, so it was not passed on.'],
  [
    'contact_link_inactive',
    "but the connection with that agent's owner is paused or was removed, so it was not passed on.",
  ],
  ['external_files_unsupported', 'but files cannot go to an agent of another account, so it was not passed on.'],
  ['undeliverable_content', 'but nothing in it could be passed on to the other agent.'],
])

/**
 * HOAI saved the reply but did not pass it on, for a reason that does not end
 * the conversation (a failure inside the forward, the other agent offline, a
 * paused contact link). Only this reply failed; the next one goes to HOAI as
 * always. A paused or removed contact link is offered no send_to_peer: HOAI
 * refuses that too until the link is active again.
 */
export function peerReplyNotPassedOnResult(
  chatId: string,
  messageId: unknown,
  reason: string,
  withFiles: boolean,
): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  const saved = messageId != null ? ` (message ${String(messageId)})` : ''
  const instead =
    reason === 'contact_link_inactive'
      ? 'Nothing reaches that agent until the connection is active again.'
      : sendToPeerInstead(withFiles || reason === 'external_files_unsupported')
  return {
    content: [
      {
        type: 'text',
        text:
          `Not delivered: HOAI saved this reply in the side conversation in chat ${chatId}${saved}, ` +
          `${NOT_PASSED_ON_BECAUSE.get(reason) ?? 'but did not pass it on to the other agent.'} ${instead}`,
      },
    ],
    isError: true,
  }
}
