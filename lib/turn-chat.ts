/**
 * Which BGOS chat does a hook event belong to?
 *
 * The daemon has no "current chat": the reply tool takes chat_id from the
 * model, so nothing ever had to know. Hook events carry no chat id at all, so
 * stage 4 needs one small memory of what was DELIVERED to this session.
 *
 * Deliberately NOT lib/acting-user.ts: that tracker records human turns only
 * (isUserTurn requires senderType 'user' and no agentOrigin) and is never
 * cleared, so a scheduled wake, a peer turn or a meeting would file its tool
 * rows under the last human chat. This one takes every delivery kind.
 *
 * TWO THINGS IT REFUSED TO DO BEFORE, AND NOW DOES.
 *
 * 1. A TURN'S CHAT IS FIXED AT ITS PROMPT. It used to be "whatever was
 *    delivered last", so a peer message, a system wake or a meeting invitation
 *    landing mid turn moved the rest of that turn's rows into a chat the turn
 *    was never about. The chat is now bound when the turn starts (at
 *    UserPromptSubmit, from the delivered message the prompt carries) and held
 *    until Stop; deliveries during a live turn are remembered for the NEXT
 *    turn and move nothing.
 *
 * 2. THE LAST TURN'S CHAT SURVIVES THE TURN. An out of turn marker (a
 *    compaction between turns is the real case) used to fall through to the
 *    first monitored chat, which on a multi chat agent is simply the wrong
 *    one. The record stays after Stop with `live` false, so a marker posted
 *    between turns lands where the conversation actually is.
 *
 * It also owns the bounded ring of DELIVERED TEXTS, because a prompt carrying
 * one of them is the only positive proof that a Claude Code session is the one
 * this daemon feeds (lib/hook-intake.ts admission, proof a).
 *
 * Pure: no clock of its own, no I/O. The caller passes `now`.
 */

export type TurnChatKind = 'user' | 'peer' | 'system' | 'meeting'

export interface TurnChatRecord {
  chatId: string
  messageId: number | null
  at: number
  kind: TurnChatKind
}

/** Longer than a long tool turn, shorter than a working day. */
export const TURN_CHAT_STALE_MS = 15 * 60_000
/** How many delivered texts are remembered. Bounded: this is a daemon. */
export const DELIVERED_RING_LIMIT = 64
/** The prefix length a delivered text is matched on. */
export const DELIVERED_MATCH_CHARS = 40
/**
 * Below this a delivered text is not evidence of anything: "ok" or "yes"
 * appears in any prompt, and binding the rail to a stranger's session is
 * exactly the failure the proof exists to prevent.
 */
export const DELIVERED_MIN_CHARS = 8

/** Whitespace and case are not evidence; the words are. */
export function normalizeDeliveredText(text: unknown): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * The comparable form of one delivered message: its normalised prefix of
 * DELIVERED_MATCH_CHARS characters, or the whole text when it is shorter.
 * Null when there is not enough of it to be proof.
 */
export function deliveredNeedle(text: unknown): string | null {
  const normalized = normalizeDeliveredText(text)
  if (normalized.length < DELIVERED_MIN_CHARS) return null
  return normalized.length > DELIVERED_MATCH_CHARS
    ? normalized.slice(0, DELIVERED_MATCH_CHARS)
    : normalized
}

/** Does this prompt carry that delivered message? */
export function promptCarriesDelivered(prompt: unknown, needle: string): boolean {
  if (typeof needle !== 'string' || needle === '') return false
  return normalizeDeliveredText(prompt).includes(needle)
}

export interface TurnChatNote {
  chatId: string | number
  messageId?: number | null
  kind: TurnChatKind
  /** The text delivered to the session, when the site has it. */
  text?: string | null
  now: number
}

export interface TurnChatTracker {
  /** Something was delivered. Never moves a live turn's chat. */
  note(input: TurnChatNote): void
  /**
   * A turn started. `chatId` is the delivery its prompt matched, when the
   * intake could name one; without it the last delivery is used.
   */
  beginTurn(input: { chatId?: string | number | null; now: number }): void
  /** The chat a hook row belongs to, or null when nothing is recent enough. */
  current(now: number): TurnChatRecord | null
  /** Is a turn running right now? */
  live(): boolean
  /** The delivery whose text this prompt carries, or null. */
  matchDelivered(promptText: unknown): TurnChatRecord | null
  /** Called on Stop: the turn is over, its chat is kept as the last one. */
  end(now: number): void
}

export function createTurnChatTracker(): TurnChatTracker {
  /** The last thing delivered, whatever it was. */
  let pending: TurnChatRecord | null = null
  /** The chat of the turn: live while `live`, the last turn's after Stop. */
  let turn: TurnChatRecord | null = null
  let live = false
  /** Delivered texts, oldest first. */
  const ring: Array<{ needle: string; record: TurnChatRecord }> = []

  const fresh = (record: TurnChatRecord | null, now: number): TurnChatRecord | null => {
    if (record === null) return null
    return now - record.at > TURN_CHAT_STALE_MS ? null : record
  }

  const recordFor = (chatId: string, now: number): TurnChatRecord => {
    for (let i = ring.length - 1; i >= 0; i--) {
      const entry = ring[i]!
      if (entry.record.chatId === chatId) return { ...entry.record, at: now }
    }
    if (pending && pending.chatId === chatId) return { ...pending, at: now }
    return { chatId, messageId: null, at: now, kind: 'user' }
  }

  return {
    note({ chatId, messageId, kind, text, now }) {
      const id = String(chatId ?? '').trim()
      if (!id) return
      const at = typeof now === 'number' && Number.isFinite(now) ? now : 0
      const record: TurnChatRecord = {
        chatId: id,
        messageId: typeof messageId === 'number' && Number.isFinite(messageId) ? messageId : null,
        at,
        kind,
      }
      pending = record
      const needle = deliveredNeedle(text)
      if (needle !== null) {
        ring.push({ needle, record })
        while (ring.length > DELIVERED_RING_LIMIT) ring.shift()
      }
      // A live turn keeps the chat it started in. This delivery is the next
      // turn's subject, not this one's.
    },
    beginTurn({ chatId, now }) {
      const at = typeof now === 'number' && Number.isFinite(now) ? now : 0
      live = true
      const named = String(chatId ?? '').trim()
      if (named) {
        turn = recordFor(named, at)
        return
      }
      const inherited = pending ?? turn
      if (inherited) turn = { ...inherited, at }
    },
    current(now) {
      if (live && turn !== null) return turn
      const lastTurn = fresh(turn, now)
      const lastDelivery = fresh(pending, now)
      if (lastTurn === null) return lastDelivery
      if (lastDelivery === null) return lastTurn
      return lastDelivery.at > lastTurn.at ? lastDelivery : lastTurn
    },
    live: () => live,
    matchDelivered(promptText) {
      for (let i = ring.length - 1; i >= 0; i--) {
        const entry = ring[i]!
        if (promptCarriesDelivered(promptText, entry.needle)) return entry.record
      }
      return null
    },
    end(now) {
      live = false
      const at = typeof now === 'number' && Number.isFinite(now) ? now : 0
      // Keep the chat, refresh its clock: an out of turn marker that fires a
      // minute after Stop belongs to the conversation that just happened.
      if (turn !== null) turn = { ...turn, at }
    },
  }
}
