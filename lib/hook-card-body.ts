/**
 * The wire body of one tool card (stage 7 of the BGOS Mission program).
 *
 * Pure: no I/O, no clock of its own, never throws. The daemon writes the card
 * from two places, the 600 ms coalescer and the turn end, and both go through
 * this one builder. That is the whole reason it is a module and not a closure:
 * the per card output budget and the clock conversion have to happen on EVERY
 * write, and a rule that lives at one of two call sites is a rule that runs on
 * the writes there are fewest of.
 *
 * The clock is the TURN's own, in epoch milliseconds, taken from the receipt
 * the hook process stamped (lib/hook-intake.ts SpoolLine.receivedAt) and never
 * from the moment the daemon happened to drain the spool. It reaches the wire
 * as ISO 8601 because that is what ToolProgressMetaDto takes, and each half is
 * sent only where it exists: the platform drops the pair when either is
 * missing, and nothing anywhere works these numbers out from when a message
 * was created.
 */

import { CARD_OUTPUT_BUDGET, type ToolRow } from './hook-events.ts'
import { clipCardOutput } from './tool-outcome.ts'

/** What the daemon holds between one card state and the write that sends it. */
export interface HookCardPending {
  state: 'running' | 'done'
  tools: ToolRow[]
  text: string
  /** Which card this state belongs to (stage 8). A turn whose child agent
   *  outlived it leaves its card behind, so the daemon can be holding more
   *  than one, and the write has to reach the right message rather than post
   *  a second card. Absent only for a caller that predates the field. */
  cardKey?: string
  /** Epoch milliseconds. Absent until the turn has opened. */
  startedAt?: number
  /** Epoch milliseconds. Absent until a Stop or a SessionEnd ends the turn. */
  finishedAt?: number
}

/** A type alias and not an interface on purpose: the daemon spreads this into
 *  a Record<string, unknown> request body, and only an alias of an object type
 *  carries the implicit index signature that allows. */
export type HookCardWireBody = {
  text: string
  toolProgress: {
    state: 'running' | 'done'
    tools: WireToolRow[]
    startedAt?: string
    finishedAt?: string
  }
}

/**
 * One row as the wire takes it.
 *
 * The only difference from the row the mapper holds is the row's own start: it
 * is epoch milliseconds in the turn state, because a receipt difference is
 * measured on numbers, and ISO 8601 on the wire, because that is what the
 * platform's field takes. Everything else, the id and the result included,
 * goes out exactly as it was built.
 */
export type WireToolRow = Omit<ToolRow, 'startedAt'> & { startedAt?: string }

/**
 * The last millisecond of the year 9999. Past it `toISOString` answers in the
 * expanded form with a leading plus, which is not the shape the card's ISO
 * 8601 check takes, so a clock that far out is no clock at all. Below it every
 * answer is exactly 24 characters, well inside the field's 40.
 */
const MAX_RECEIPT_MS = 253_402_300_799_999

/**
 * One hook receipt as ISO 8601, or null when the number cannot be a moment
 * this turn happened. Zero is the mapper's "no clock yet" and is not a date;
 * a NaN, an infinity or a string is a bug upstream, and the honest answer to
 * all of them is no field rather than a card the platform refuses.
 */
export function isoFromReceipt(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value <= 0 || value > MAX_RECEIPT_MS) return null
  return new Date(value).toISOString()
}

/**
 * One row on its way out: its own clock as ISO 8601, dropped when the number
 * cannot be a moment this row began.
 *
 * A COPY every time. The turn state holds these rows and goes on measuring a
 * receipt difference against them, so a conversion in place would hand the
 * next card a string where the mapper expects milliseconds and the elapsed
 * time a helper ticks would stop moving.
 */
const wireRow = (row: ToolRow): WireToolRow => {
  const { startedAt, ...rest } = row
  const iso = isoFromReceipt(startedAt)
  return iso === null ? rest : { ...rest, startedAt: iso }
}

/**
 * One card state as the body of a POST or a PATCH.
 *
 * The budget runs here, on the way out, rather than only where the card state
 * is built: this is the last thing that happens before the bytes leave, so a
 * later caller cannot forget it.
 */
export function hookCardWireBody(
  pending: HookCardPending,
  budget: number = CARD_OUTPUT_BUDGET,
): HookCardWireBody {
  const startedAt = isoFromReceipt(pending.startedAt)
  const finishedAt = isoFromReceipt(pending.finishedAt)
  return {
    text: pending.text,
    toolProgress: {
      state: pending.state,
      tools: clipCardOutput(pending.tools, budget).map(wireRow),
      ...(startedAt !== null ? { startedAt } : {}),
      ...(finishedAt !== null ? { finishedAt } : {}),
    },
  }
}
