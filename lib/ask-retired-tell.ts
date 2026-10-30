/**
 * How a session hears of its own cards that the daemon holding the
 * connection retired while it ran on without it (AskTracker.retire,
 * takeRetiredOwn): Data's gaps after #284, gap 1.
 *
 * Told only once it landed. takeRetiredOwn hands each card out once while its
 * tell is out; a send that landed marks it told (retiredTold), and one that
 * failed hands it back for the next tick (retiredTellFailed), until the
 * record ages out with the orphan grace. Before, the card was marked told
 * before the send, so a failed send lost it.
 *
 * A session whose channel is provably not loaded (lib/channel-presence.ts) is
 * exactly the holder a channel takeover moves aside (lib/pairing-lock.ts), and
 * Claude Code drops a channel event to it unseen. Its tell rides its next tool
 * result instead, the one thing that session reads; the tick sends it nothing.
 * Unknown (null) keeps the channel, as every presence check here does.
 */

import type { PendingAsk } from './ask-tracker.js'

/** What the tell needs of AskTracker. */
export interface RetiredOwnSource {
  takeRetiredOwn(): Array<{ ask: PendingAsk; withdrawn: number }>
  retiredTold(askId: string): void
  retiredTellFailed(askId: string): void
}

/**
 * On the ask tick: each retired card of this session, by its ask_withdrawn
 * channel event. `send` resolves once the event is out (or when it may never
 * be told, a share recipient's chat) and rejects when it failed. Never throws.
 */
export function tellRetiredOwnOnTick(opts: {
  tracker: RetiredOwnSource
  channelLoaded: boolean | null
  send: (ask: PendingAsk, withdrawn: number) => Promise<void>
  log: (line: string) => void
}): void {
  if (opts.channelLoaded === false) return
  for (const { ask, withdrawn } of opts.tracker.takeRetiredOwn()) {
    let sending: Promise<void>
    try {
      sending = opts.send(ask, withdrawn)
    } catch (err) {
      sending = Promise.reject(err)
    }
    sending.then(
      () => opts.tracker.retiredTold(ask.askId),
      (err) => {
        opts.tracker.retiredTellFailed(ask.askId)
        opts.log(`ask_withdrawn: telling this session of its retired card ${ask.askId} failed, trying again on the next tick: ${err}`)
      },
    )
  }
}

/**
 * On a tool result of a session whose channel is not loaded: the text of
 * each retired card of this session, told from here. `text` is null for a
 * card that may never be told (a share recipient's chat): dropped, never
 * carried later. Empty for any other session, which hears it on the tick.
 */
export function retiredOwnNotes(opts: {
  tracker: RetiredOwnSource
  channelLoaded: boolean | null
  text: (ask: PendingAsk, withdrawn: number) => string | null
}): string[] {
  if (opts.channelLoaded !== false) return []
  const out: string[] = []
  for (const { ask, withdrawn } of opts.tracker.takeRetiredOwn()) {
    let text: string | null
    try {
      text = opts.text(ask, withdrawn)
    } catch {
      opts.tracker.retiredTellFailed(ask.askId)
      continue
    }
    if (text !== null) out.push(text)
    opts.tracker.retiredTold(ask.askId)
  }
  return out
}
