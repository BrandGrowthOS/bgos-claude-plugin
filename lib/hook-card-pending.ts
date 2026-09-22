/**
 * The card states waiting to go out, one slot per CARD (stage 8).
 *
 * A single slot was the defect this replaces. The mapper emits the repaint of
 * a card a working child outlived AND the live turn's own card in the SAME
 * batch, so the second assignment threw the first away before the 600 ms
 * coalescer ever fired, and the qualifier saying what the helper is doing
 * right now never reached the wire at all. Keyed on the card's own key, a
 * state can only ever replace the state of the SAME card.
 *
 * Pure, and a module rather than four lines inside the daemon, because
 * server.ts IS the daemon: importing it starts one, so a rule that lives
 * inside it can only be read by a source scan. This one is driven, with the
 * real mapper's real effects, in test/hook-card-pending.test.ts.
 */

import type { HookCardPending } from './hook-card-body.ts'

/**
 * How many cards can be owed a write at once.
 *
 * One for the live turn and one for each card a working child outlived, with
 * the same slack the daemon's card id map keeps. Bounded for the reason every
 * map in this rail is: a process that runs for weeks may not grow one for
 * ever. Losing the oldest costs that card one repaint and nothing else; it is
 * still addressable, because its id lives in the daemon's own map.
 */
export const HOOK_CARD_PENDING_MAX = 8

/** A state with no card key at all is one card: a caller that predates the
 *  field, which is the only way the key is ever missing. */
const keyOf = (pending: HookCardPending): string => pending.cardKey ?? ''

export class PendingCards {
  private readonly cards = new Map<string, HookCardPending>()

  constructor(private readonly limit: number = HOOK_CARD_PENDING_MAX) {}

  get size(): number {
    return this.cards.size
  }

  /**
   * Hold this card's latest state.
   *
   * A key written again keeps the place it already had, the way the daemon's
   * card id map does: a card being repainted is the SAME card, and its place
   * in the queue is when it first had something to say. That is also what
   * stops a live card repainting every 600 ms from starving the card a working
   * child is on.
   */
  put(pending: HookCardPending): void {
    this.cards.set(keyOf(pending), pending)
    while (this.cards.size > this.limit) {
      const oldest = this.cards.keys().next().value
      if (oldest === undefined) break
      this.cards.delete(oldest)
    }
  }

  /** The state held for one card, left where it is: the turn end reads the
   *  state it is about to send, and the flusher is what takes it out. */
  get(cardKey: string | null | undefined): HookCardPending | null {
    if (cardKey === null || cardKey === undefined) return null
    return this.cards.get(cardKey) ?? null
  }

  /** The card that has waited longest, taken out of the queue. One write at a
   *  time, oldest first. */
  take(): HookCardPending | null {
    const first = this.cards.entries().next()
    if (first.done === true) return null
    const [key, pending] = first.value
    this.cards.delete(key)
    return pending
  }

  /** Forget every card but these. The turn end keeps the cards a child agent
   *  is still working on and forgets its own, which is the rule the card id
   *  map follows too. */
  keepOnly(cardKeys: Iterable<string>): void {
    const kept = new Set(cardKeys)
    for (const key of [...this.cards.keys()]) {
      if (!kept.has(key)) this.cards.delete(key)
    }
  }

  clear(): void {
    this.cards.clear()
  }
}
