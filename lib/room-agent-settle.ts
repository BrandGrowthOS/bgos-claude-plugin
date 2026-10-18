/**
 * Another agent's follow-up on the update stream waits until its text has
 * settled (HOAI board row 2d6ac222, BGOS follow-up window step 2).
 *
 * An agent writes its message by creating the row and then editing it, and
 * the stream hands the row over as it stands: message_new with the first
 * chunk (or nothing yet) within seconds, then a message_finalized for every
 * edit that changes the text. BGOS's push waits until the text has gone
 * unedited for 20 seconds (turn-wake-delivery.service.ts, agent_row_settling)
 * and carries no stream stamp (an agent's row is never kicked), so only the
 * forwarded id set dedupes the two lanes.
 *
 * The stream cannot simply leave the message to the push: a stream read older
 * than BGOS's kick grace marks the push's row delivered (TURN_WAKE_NOTE_READ_SQL,
 * agent-updates.controller.ts noteLedgerRead), and the push never comes. Nor
 * can it deliver the first version it sees: that claims the id, and the
 * settled push is then dropped as a duplicate. So the stream keeps the latest
 * version of each such message and delivers it once no newer one has come for
 * the same settle time, unless a lane delivered it first. Every newer version
 * starts the wait again, exactly as an edit does on the push.
 *
 * Held in memory: a daemon that stops inside the wait loses the stream's copy
 * (the push still comes if the stream did not close its row). Unlike the
 * push, the wait does not ask BGOS again before it delivers: a message
 * deleted, or a flag turned off, inside the wait is still delivered. A seat
 * taken away or a chat deleted drops what that chat holds (dropChat).
 */

/** BGOS's answer settle time (TURN_WAKE_TIMINGS.answerSettleMs): no edit for this long. */
export const ROOM_AGENT_SETTLE_MS = 20_000

/** At most this many messages wait at once; the oldest is delivered early to make room. */
export const ROOM_AGENT_SETTLE_MAX = 200

export interface RoomAgentSettleView {
  chatId: string
  messageId: number
  text: string
  files: unknown[]
}

export interface RoomAgentSettleDeps<V extends RoomAgentSettleView, H> {
  settleMs?: number
  max?: number
  schedule(fire: () => void, ms: number): H
  cancel(handle: H): void
  /** A lane already delivered this message id. */
  isForwarded(messageId: number): boolean
  /** Deliver the settled version; a rejection is tried once more after another wait. */
  deliver(view: V): void | Promise<void>
  log(line: string): void
}

export interface RoomAgentSettler<V extends RoomAgentSettleView> {
  /** A version of another agent's message arrived on the stream. */
  note(view: V): void
  /** Is this message waiting? (a later version of it may still come) */
  has(messageId: number): boolean
  /** Forget what one chat holds (its seat was taken away, or it was deleted). */
  dropChat(chatId: string): void
  /** How many messages are waiting. */
  size(): number
}

export function createRoomAgentSettler<V extends RoomAgentSettleView, H>(
  deps: RoomAgentSettleDeps<V, H>,
): RoomAgentSettler<V> {
  const settleMs = deps.settleMs ?? ROOM_AGENT_SETTLE_MS
  const max = deps.max ?? ROOM_AGENT_SETTLE_MAX
  // `handle` is null while a version with no text is parked: it waits, with no
  // timer, for the version that brings the text, and only the cap evicts it.
  const waiting = new Map<number, { view: V; handle: H | null; retried: boolean }>()
  const stop = (handle: H | null): void => {
    if (handle !== null) deps.cancel(handle)
  }

  const hold = (view: V, retried: boolean): void => {
    const handle = deps.schedule(() => settle(view.messageId), settleMs)
    waiting.set(view.messageId, { view, handle, retried })
  }

  const settle = (messageId: number, evicting = false): void => {
    const entry = waiting.get(messageId)
    if (!entry) return
    waiting.delete(messageId)
    stop(entry.handle)
    if (deps.isForwarded(messageId)) {
      deps.log(`stream: room_agent message ${messageId} already delivered by another lane`)
      return
    }
    if (entry.view.text.trim().length === 0 && entry.view.files.length === 0) {
      // The agent may still be working before its first text: keep the
      // message waiting (with no timer) so the version with text still counts.
      if (!evicting) waiting.set(messageId, { ...entry, handle: null })
      deps.log(`stream: room_agent message ${messageId} has no text yet; ${evicting ? 'dropped to make room' : 'still waiting'}`)
      return
    }
    deps.log(`stream: room_agent message ${messageId} settled; delivering`)
    void Promise.resolve()
      .then(() => deps.deliver(entry.view))
      .catch((err) => {
        if (entry.retried || waiting.has(messageId) || deps.isForwarded(messageId)) {
          deps.log(`stream: room_agent message ${messageId} delivery failed: ${err}`)
          return
        }
        deps.log(`stream: room_agent message ${messageId} delivery failed (${err}); trying once more`)
        hold(entry.view, true)
      })
  }

  return {
    note(view) {
      if (deps.isForwarded(view.messageId)) return
      const previous = waiting.get(view.messageId)
      if (previous) {
        stop(previous.handle)
        waiting.delete(view.messageId)
      } else if (waiting.size >= max) {
        const oldest = waiting.keys().next().value
        if (oldest !== undefined) settle(oldest, true)
      }
      // A version without text never replaces one with text: an empty
      // finalize must not erase what the stream already holds.
      const keep =
        previous && view.text.trim().length === 0 && view.files.length === 0
          ? previous.view
          : view
      hold(keep, previous?.retried ?? false)
    },
    has: (messageId) => waiting.has(messageId),
    dropChat(chatId) {
      for (const [messageId, entry] of waiting) {
        if (entry.view.chatId !== chatId) continue
        stop(entry.handle)
        waiting.delete(messageId)
        deps.log(`stream: room_agent message ${messageId} dropped (chat ${chatId} no longer reachable)`)
      }
    },
    size: () => waiting.size,
  }
}
