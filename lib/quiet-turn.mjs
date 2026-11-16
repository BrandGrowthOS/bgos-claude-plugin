// A trusted turn is quiet (2026-11-11; option A of the voice call design, KC 2026-11-11, HOAI board row 01a1339a).
//
// The private turn gate ends an agent's private actions the moment anyone else's words reach its turn, because a
// model cannot tell two instructions apart once both are in its context. That is right, and it meant one peer
// message, meeting line or email arriving while the owner's own turn ran took the owner's trust away for the rest of
// that turn: a call's ask lost its schedule and boards, and so did a typed turn (Data, 2026-11-11).
//
// The scheduled run hold (lib/schedule-grant-run.mjs, 0.86.20) already keeps other cards out of a granted wake's turn.
// This is that hold made general. While the OWNER'S OWN turn is live (a voice ask the backend stamped, the owner's
// typed message, the owner's scheduled wake), every other channel card waits at the one choke point all cards pass.
// A held card is not built until it is released, so it never reaches the private turn tracker, never enters the
// model's context and never ends the turn. When the turn ends the waiting cards go out, the owner's own first (each
// opens its own turn, and what is behind it waits again), then the rest in arrival order, each with its own sender: a
// peer's message is answered with no private tools, a wake stamped for the owner opens its own trusted turn.
//
// What passes at once: the turn's own card, a Stop (the tracker ends the trust, as before), a permission verdict
// (another method), and on a typed or scheduled turn the cards the tracker already keeps: the same owner's message
// or stamped voice ask in the same chat, and the three cards that hold nobody's words (a peer conversation close, a
// reply reminder for the owner's own message, the owner's own tap). A voice ask's turn is that ask's alone.
//
// A card waits FIVE MINUTES at most (QUIET_CARD_MAX_WAIT_MS), counted from when it first arrived. Past that it is let
// in and the turn loses its trust exactly as it did before this hold existed, so the worst case equals the old
// behaviour. The hold grants nothing: every card that goes out still meets the tracker's own rules.
//
// Review round 2 (2026-11-11, the security gate):
//   - The hold is OFF unless the SERVER says on (serverQuietTurnOf: `quietTurn: true` in its capabilities reply, sent
//     only while its VOICE_ASK_STAMP switch is on). With the server's switch off this file holds nothing, on any machine.
//   - A card with a deadline of its own never waits past it (`within`): a meeting card 150 s, an unstamped voice
//     consult not at all.
//   - A turn that ends while its CLI turn still runs (an ask at its final answer or at complete_voice_task) keeps the
//     hold until that CLI turn stops, so what waited is never handed to the running turn together.

export const QUIET_CARD_MAX_WAIT_MS = 5 * 60 * 1000
/** The owner's card handed to an idle CLI whose prompt has not begun by then never will: what waited goes out. */
export const QUIET_BEGIN_WITHIN_MS = 60 * 1000
/**
 * A meeting card's own limit (review F3): the room closes a turn that sat idle for three minutes (BGOS
 * A2A_MEETING_TURN_IDLE_MS), so a meeting card waits at most this long and is then let in, in time to be answered.
 */
export const QUIET_MEETING_CARD_MAX_WAIT_MS = 150 * 1000
/**
 * The server's switch (review F3): the hold is on only while the backend runs with VOICE_ASK_STAMP on, which it says
 * as `quietTurn: true` in the body of its Claude Code capabilities reply. Anything else (a reply without the field,
 * a fetch that failed, the bundled copy) is off.
 * @param {unknown} body the capabilities reply as fetched, or null
 */
export function serverQuietTurnOf(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body) && /** @type {any} */ (body).quietTurn === true
}
/**
 * The switch as the daemon keeps it: off until a capabilities reply says on, and off again whenever a read says
 * anything else or fails (the caller passes null). Says each change once.
 * @param {{ log?: (line: string) => void }} [options]
 */
export function createServerQuietSwitch({ log = () => {} } = {}) {
  let on = false
  return {
    on: () => on,
    /** @param {unknown} body the capabilities reply as fetched, or null when the fetch failed */
    note(body) {
      const next = serverQuietTurnOf(body)
      if (next !== on) {
        on = next
        log(`quiet turn: the server says ${next ? 'on' : 'off'}; other cards ${next ? 'wait outside the owner\'s turn' : 'are not held'}`)
      }
      return on
    },
  }
}
/** The channel card method (lib/model-effort-control.ts CHANNEL_CARD_METHOD). */
const CHANNEL_CARD_METHOD = 'notifications/claude/channel'
/** A delivery's token as lib/private-turn.mjs writes it into a card and reads it back from the prompt. */
const PRIVATE_TOKEN_RE = /<hoai-private-turn id="([a-f0-9-]{36})"\/>/g
/** @param {unknown} text @returns {string[]} */
const tokensIn = (text) => [...String(text ?? '').matchAll(PRIVATE_TOKEN_RE)].map((match) => match[1])

/**
 * What a card is to the hold, named by its sender BEFORE the card is built (a held card must not be built):
 *   - `{ opens: 'ask' | 'message' | 'wake', chatId }`: a card the server stamped for this agent's owner, which can
 *     open the owner's trusted turn (a stamped voice ask, the owner's own message, the owner's scheduled wake);
 *   - `{ carried: true }`: a card that holds nobody's words (lib/private-turn.mjs PRIVATE_CARRIED_CARDS, the owner's tap);
 *   - `{ stop: true }`: a Stop;
 *   - `{ within: ms }`: a card with a deadline of its own (review F3). It waits at most that long, never past the
 *     five minutes: a meeting card 150 s (the room closes an idle turn at three minutes), an unstamped voice consult
 *     not at all (it has about 38 s to be answered, and the composer's draft rides that lane).
 * Any other card has none, and waits.
 * @typedef {{ opens: 'ask' | 'message' | 'wake', chatId: string, within?: number } | { carried: true } | { stop: true } | { within: number }} QuietCard
 */

/**
 * The descriptor of a card the server stamped for this agent's owner, or null: from the same authenticated fields the
 * tracker takes its actor from (privateActor, voiceConsultActor, voiceDispatchActor), never a user_id field.
 * @param {{ ownerUserId?: unknown, actingUserId?: unknown, senderType?: unknown, chatId?: unknown, ask?: boolean }} [card]
 * @returns {{ opens: 'ask' | 'message' | 'wake', chatId: string } | null}
 */
export function quietCardOf({ ownerUserId, actingUserId, senderType, chatId, ask = false } = {}) {
  if (typeof ownerUserId !== 'string' || !ownerUserId || actingUserId !== ownerUserId) return null
  const opens = ask === true ? 'ask' : String(senderType ?? '').toLowerCase() === 'user' ? 'message' : 'wake'
  return { opens, chatId: String(chatId ?? '') }
}

/**
 * What a voice card is to the hold (server.ts notify): a consult or a paired dispatch the backend stamped for this
 * agent's owner can open the owner's turn; a Stop passes at once; a CONSULT is never held, stamped or not (`within: 0`,
 * review F3 and round 2 N4: it has seconds to be answered); an unstamped dispatch names nothing, and waits like every
 * other card.
 * @param {{ ownerUserId?: unknown,
 *   consult?: { consultId?: string, chatId: string, actor: { actingUserId: string, deadline?: number } | null } | null,
 *   dispatch?: { taskId?: string, chatId: string, actor: { actingUserId: string, deadline?: number } | null } | null,
 *   meta?: any }} [card]
 * @returns {QuietCard | null}
 */
export function voiceQuietCard({ ownerUserId, consult = null, dispatch = null, meta = null } = {}) {
  if (meta !== null && typeof meta === 'object' && meta.event_type === 'stop_turn') return { stop: true }
  const ask = consult ?? dispatch
  if (!ask) return null
  const card = quietCardOf({ ownerUserId, actingUserId: ask.actor?.actingUserId ?? null, senderType: 'user', chatId: ask.chatId, ask: true })
  // A consult is answered within about 38 s or not at all, so it is never held, stamped or not (review round 2,
  // N4): held, the owner's own question timed out behind their own running task, and the server vouching for a
  // question made it slower than not vouching. Let in, it meets the tracker's own rules, as before the hold.
  if (consult) return card ? { ...card, within: 0 } : { within: 0 }
  return card
}

/**
 * BGOS_QUIET_TURN: the hold is ON unless this says off, 0, false or no (trimmed, any case). A switch for the operator
 * of one machine; off, every card goes out at once exactly as before the quiet turn (2026-11-11) (the scheduled run hold is not affected).
 * @param {string | undefined} value
 */
export function quietTurnEnabled(value) {
  return !['off', '0', 'false', 'no'].includes(String(value ?? '').trim().toLowerCase())
}

/**
 * The owner's trusted turn the daemon keeps quiet, if one is live. `trusted` is the private turn tracker's own bound
 * owner turn (lib/private-turn.mjs quiet()): the hold never keeps a second record of a turn that began. It adds only
 * the gap before that: the owner's card handed to an idle CLI is PENDING until its prompt begins, so a card that
 * arrives right behind it waits too.
 * @param {{ trusted: () => { chatId: string, askId: string | null, deadline: number | null } | null,
 *   deliveryOf: (card: unknown) => { token: string, actingUserId: string | null, replayed: boolean } | null,
 *   ownerUserId: string | null, idle?: () => boolean, enabled?: () => boolean, now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (handle: any) => void,
 *   maxWaitMs?: number, beginWithinMs?: number }} options
 * `idle`: the CLI is between turns (a card sent now starts a prompt of its own). `enabled`: false switches the hold
 * off (no private turn hook registered, the lock not held, or BGOS_QUIET_TURN=off): nothing waits.
 */
export function createQuietTurns({ trusted, deliveryOf, ownerUserId, idle = () => true, enabled = () => true, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, maxWaitMs = QUIET_CARD_MAX_WAIT_MS, beginWithinMs = QUIET_BEGIN_WITHIN_MS }) {
  const owner = typeof ownerUserId === 'string' && ownerUserId ? ownerUserId : null
  /** @type {{ token: string, chatId: string, ask: boolean, timer: any } | null} */
  let pending = null
  /** @type {Array<{ resolve: () => void, opener: boolean, timer: any }>} */
  let waiters = []
  /**
   * The CLI turn a trusted turn began in (review F4). A voice ask ends at its final answer or at complete_voice_task,
   * and any turn can lose its trust, while the CLI turn is still running. What waited must not be handed to that
   * running turn together: the hold stays, as an ask's would, until the CLI is idle (its Stop). Then the owner's own
   * card goes first, alone, and opens its own turn.
   * @type {{ chatId: string } | null}
   */
  let tail = null
  /** @param {() => void} fn @param {number} ms */
  const arm = (fn, ms) => {
    const handle = setTimer(fn, Math.max(0, ms))
    if (handle && typeof handle.unref === 'function') handle.unref()
    return handle
  }
  const clearPending = () => {
    if (!pending) return
    clearTimer(pending.timer)
    pending = null
  }
  /** @returns {{ chatId: string, ask: boolean, deadline: number | null } | null} */
  const live = () => {
    if (owner === null || !enabled()) { tail = null; return null }
    const bound = trusted()
    if (bound) {
      tail = { chatId: String(bound.chatId) }
      return { chatId: String(bound.chatId), ask: bound.askId != null, deadline: bound.deadline ?? null }
    }
    if (pending) return { chatId: pending.chatId, ask: pending.ask, deadline: null }
    if (tail !== null) {
      // The turn is over and its CLI turn is not: nothing but a Stop passes, as during an ask.
      if (!idle()) return { chatId: tail.chatId, ask: true, deadline: null }
      tail = null
    }
    return null
  }
  /** @param {any} card @param {{ chatId: string, ask: boolean }} turn */
  const passes = (card, turn) => {
    if (card?.stop === true) return true
    // A voice ask's turn is that ask's alone: its own card already went.
    if (turn.ask) return false
    if (card?.carried === true) return true
    return (card?.opens === 'message' || card?.opens === 'ask') && String(card.chatId) === turn.chatId
  }
  const release = () => {
    // The owner's own cards first: each goes alone to an idle CLI, opens its turn, and the rest wait again.
    const out = [...waiters.filter((w) => w.opener), ...waiters.filter((w) => !w.opener)]
    waiters = []
    for (const waiter of out) {
      clearTimer(waiter.timer)
      waiter.resolve()
    }
  }
  const recheck = () => { if (live() === null) release() }

  return {
    live,
    /** Does this card wait now? @param {QuietCard | null | undefined} card */
    holds(card) {
      const turn = live()
      return turn !== null && !passes(card, turn)
    },
    /**
     * Resolves when the card may try again: the turn ended, or `ms` passed (the card's own five minutes, or the
     * turn's deadline). @param {boolean} opener @param {number} ms @returns {Promise<void>}
     */
    wait(opener, ms) {
      return new Promise((resolve) => {
        const waiter = { resolve: () => resolve(), opener: opener === true, timer: /** @type {any} */ (null) }
        waiter.timer = arm(() => {
          waiters = waiters.filter((w) => w !== waiter)
          waiter.resolve()
        }, ms)
        waiters.push(waiter)
      })
    },
    /**
     * A card that can open the owner's turn was BUILT and is going out as this content. It is pending only when the
     * tracker really took it as the owner's own new delivery, nothing is bound or pending yet, and the CLI is idle.
     * Returns its token when it opened a pending turn. @param {QuietCard | null | undefined} card @param {unknown} content
     */
    noteSent(card, content) {
      if (owner === null || !enabled() || !card || !('opens' in card)) return null
      const delivery = deliveryOf(content)
      if (!delivery || delivery.actingUserId !== owner || delivery.replayed === true) return null
      if (trusted() !== null || pending !== null || !idle()) return null
      const token = delivery.token
      pending = {
        token,
        chatId: String(card.chatId),
        ask: card.opens === 'ask',
        timer: arm(() => { if (pending?.token === token) { pending = null; recheck() } }, beginWithinMs),
      }
      return token
    },
    /** That card never reached the CLI: there is nothing to wait for. @param {string | null} token */
    noteNotSent(token) {
      if (token === null || pending?.token !== token) return
      clearPending()
      recheck()
    },
    /** A CLI prompt began (after the tracker's begin): the pending card's own prompt hands over to the tracker. */
    noteBegin(prompt) {
      if (pending && tokensIn(prompt).includes(pending.token)) clearPending()
      recheck()
    },
    /** Something may have ended the turn (a Stop, a revoke, an ask answered): release what waited if so. */
    recheck,
    waiting: () => waiters.length,
    /** The hold's own clock and cap, read by the choke point so the two can never disagree. */
    now,
    maxWaitMs,
  }
}

/**
 * THE ONE CHOKE POINT, made general. Wraps the notification sender OUTSIDE the scheduled run hold (which builds a
 * card when it really goes out) and inside the model and effort lock: while the owner's trusted turn is live every
 * channel card waits, unbuilt, except the ones createQuietTurns lets pass. A card names what it is as `quiet` on the
 * notification (channelNotify); it is taken off before the card goes on. A released card goes out through `resend`,
 * the whole notification chain.
 * @param {ReturnType<typeof createQuietTurns>} quiet
 * @param {(notification: any) => any} send
 * @param {{ log?: (line: string) => void, resend?: (notification: any) => any }} [options]
 * @returns {(notification: any) => any}
 */
export function holdChannelCardsDuringQuietTurn(quiet, send, { log = () => {}, resend } = {}) {
  const { now, maxWaitMs } = quiet
  // What a card is and when it first waited, by the notification object: the copy handed on (without `quiet`) keeps
  // both, so a card the scheduled run hold resends is still known.
  /** @type {WeakMap<object, any>} */
  const cardOf = new WeakMap()
  /** @type {WeakMap<object, number>} */
  const heldSince = new WeakMap()
  /** @param {any} notification @returns {any} */
  const hold = (notification) => {
    if (notification?.method !== CHANNEL_CARD_METHOD) return send(notification)
    const known = cardOf.get(notification)
    const card = known !== undefined ? known.card : (notification.quiet ?? null)
    // A card's own limit (review F3) only ever shortens the five minutes; none, or one that is not a number, is none.
    const within = card && typeof card.within === 'number' && Number.isFinite(card.within) ? Math.max(0, card.within) : Infinity
    const limit = Math.min(maxWaitMs, within)
    if (limit > 0 && quiet.holds(card)) {
      const first = !heldSince.has(notification)
      const since = heldSince.get(notification) ?? now()
      heldSince.set(notification, since)
      const left = since + limit - now()
      if (left > 0) {
        if (first) log('quiet turn: a channel card waits until the owner\'s turn ends (five minutes at most)')
        const deadline = quiet.live()?.deadline
        const until = typeof deadline === 'number' && Number.isFinite(deadline) ? Math.min(left, Math.max(0, deadline - now()) + 1) : left
        return quiet.wait(Boolean(card && 'opens' in card), until).then(() => (resend ?? hold)(notification))
      }
      log(limit < maxWaitMs
        ? 'quiet turn: a channel card reached its own time limit and is let in; the owner\'s turn loses its trust as before'
        : 'quiet turn: a channel card waited five minutes and is let in; the owner\'s turn loses its trust as before')
    }
    if (known !== undefined) return send(notification)
    // The card as it goes on: no `quiet` key (it must never reach the CLI), and a builder that tells the hold what
    // the tracker made of a card that can open the owner's turn, at the moment it is built.
    const { quiet: _named, ...next } = notification
    /** @type {{ token: string | null }} */
    const opened = { token: null }
    if (card && 'opens' in card) {
      const params = next.params
      next.params = typeof params === 'function'
        ? () => {
          const built = params()
          if (built != null) opened.token = quiet.noteSent(card, built.content)
          return built
        }
        : params
      if (typeof params !== 'function') opened.token = quiet.noteSent(card, params?.content)
    }
    cardOf.set(next, { card })
    const since = heldSince.get(notification)
    if (since !== undefined) heldSince.set(next, since)
    try {
      const sent = send(next)
      if (sent && typeof sent.then === 'function') {
        return sent.then(undefined, (/** @type {unknown} */ err) => { quiet.noteNotSent(opened.token); throw err })
      }
      return sent
    } catch (err) {
      quiet.noteNotSent(opened.token)
      throw err
    }
  }
  return hold
}
