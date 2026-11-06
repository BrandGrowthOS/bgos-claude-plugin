/**
 * THE GROUPS AND CHANNELS THIS AGENT SITS IN.
 *
 * The daemon refuses a reply, rename or ask to a chat id it was never told
 * about (monitoredChatSet in server.ts). `GET /peers/inbox` never lists a group
 * (kind 'room') or a channel, by design: there `chats.assistant_id` is the
 * creator's carrier agent and says nothing about this agent. So a group was
 * admitted only once an inbound message arrived from it, and a restart, which
 * empties the in-memory set, left the agent unable to post in its own group
 * until somebody else wrote there.
 *
 * `GET /peers/seats` answers the backend's own write rule for those chats: a
 * LIVE seat for the calling agent AND its owner an ACTIVE member. This module
 * reads that answer and nothing more. It never widens it: a row that is not a
 * positive whole chat id, or not a group or channel, is dropped, so a stand in
 * or a future backend that answers more cannot admit a main, side thread,
 * meeting or email chat through this door.
 */

/** The chat kinds a seat can be held in. Anything else on the answer is ignored. */
export const SEAT_CHAT_KINDS: ReadonlySet<string> = new Set(['room', 'channel'])

export interface SeatChat {
  chatId: string
  kind: 'room' | 'channel'
}

/** The admitted chats on a `GET /peers/seats` answer, in order, without repeats. */
export function seatChatsFrom(answer: unknown): SeatChat[] {
  const rows = (answer as { chats?: unknown } | null | undefined)?.chats
  if (!Array.isArray(rows)) return []
  const out: SeatChat[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const { id, kind } = row as { id?: unknown; kind?: unknown }
    if (typeof kind !== 'string' || !SEAT_CHAT_KINDS.has(kind)) continue
    const text = typeof id === 'number' ? String(id) : typeof id === 'string' ? id.trim() : ''
    if (!/^[1-9][0-9]{0,18}$/.test(text)) continue
    if (seen.has(text)) continue
    seen.add(text)
    out.push({ chatId: text, kind: kind as SeatChat['kind'] })
  }
  return out
}

/**
 * Whether a failed seats read is a backend that has no such route yet. It is
 * said once, not on every discovery, and changes nothing: the daemon then
 * behaves exactly as it did before the route existed.
 */
export function seatsRouteMissing(err: unknown): boolean {
  return /\bGET 404\b/.test(String(err))
}
