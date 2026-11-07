// A scheduled run keeps the permission of the person who scheduled it (0.86.20, 2026-11-07).
//
// The private turn gate ends an agent's private actions the moment anyone else's words reach its turn. That is right
// for a turn a person opened, and it meant a long scheduled job in a busy group (a nightly board backup) could never
// finish: each message from someone else ended its board reads and writes, and opened a new turn that refused the
// helpers it had started.
//
// A wake of a schedule that named its boards carries a grant (eventMeta.payload.boardGrant, the server's
// services/schedule-board-grant.ts). From the moment that wake goes to the CLI until the CLI turn it opened ends:
//   - EVERY other channel card waits (holdChannelCardsDuringGrantedRun, the one choke point every card passes): other
//     people's messages, their edits and button answers, meeting lines, agents, emails, notices, the owner's own
//     messages and a newer granted wake. A held card is not even built until it is released, so it never reaches the
//     private turn tracker, never revokes the run's turn and never opens a turn under it. That is why the run keeps
//     its private actions: the turn stays the scheduler's own, verified as any owner turn is.
//   - its boards calls carry X-BGOS-Schedule-Grant (the wake's fire id) on top of that verified turn. The server runs
//     them as the person who created the schedule, on the boards the schedule named only, audits each one, refuses
//     the agent's writes into every chat but that person's private chat while the run is open, and treats the grant
//     as used up once the run's end is reported. Nothing here is a fallback: a turn the gate refuses stays refused.
// The run ends at the Stop of the turn the wake opened, or when the wake could not be handed to the CLI, or when no
// turn began within BEGIN_WITHIN_MS of the handoff, or at the end of its window (twenty minutes after its fire at most,
// the server's own clock ending it too, round 4).

export const SCHEDULE_GRANT_HEADER = 'X-BGOS-Schedule-Grant'
/** The server's window (SCHEDULE_GRANT_TTL_MS); a payload never makes it longer. */
export const SCHEDULE_GRANT_MAX_MS = 20 * 60 * 1000
/** A wake handed to the CLI whose turn has not begun by then never will: the run ends and what waited goes out. */
export const BEGIN_WITHIN_MS = 10 * 60 * 1000
/** The channel card method (lib/model-effort-control.ts CHANNEL_CARD_METHOD). */
const CHANNEL_CARD_METHOD = 'notifications/claude/channel'
/** A delivery's token as lib/private-turn.mjs writes it into a card and reads it back from the prompt. */
const PRIVATE_TOKEN_RE = /<hoai-private-turn id="([a-f0-9-]{36})"\/>/g
/** @param {unknown} text @returns {string[]} */
const tokensIn = (text) => [...String(text ?? '').matchAll(PRIVATE_TOKEN_RE)].map((match) => match[1])

const USER_ID_RE = /^user_[A-Za-z0-9_-]+$/
/**
 * @typedef {{ taskId: number, fireId: string, actingUserId: string, chatId: string, expiresAtMs: number }} ScheduleGrant
 * @typedef {ScheduleGrant & { delivered: boolean, token: string | null, begun: boolean, ended: boolean }} ScheduleGrantRun
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * The grant a delivery carries, or null: a scheduler wake (no status, no payload kind) for a verified person, whose
 * payload names its task, its exact fire id and a boardGrant with at least one board and a window that has not ended.
 * The window is the earlier of the payload's end and twenty minutes after the fire the fire id names.
 * @param {{ senderType?: unknown, eventMeta?: any, actingUserId?: unknown, chatId?: unknown, now?: number }} [delivery]
 * @returns {Readonly<ScheduleGrant> | null}
 */
export function scheduleGrantOf({ senderType, eventMeta, actingUserId, chatId, now = Date.now() } = {}) {
  if (String(senderType ?? '').toLowerCase() !== 'system') return null
  if (!isRecord(eventMeta) || eventMeta.source !== 'scheduler' || eventMeta.status != null) return null
  const payload = eventMeta.payload
  if (!isRecord(payload) || payload.kind != null || !isRecord(payload.boardGrant)) return null
  if (typeof actingUserId !== 'string' || !USER_ID_RE.test(actingUserId)) return null
  const taskId = payload.scheduledTaskId
  if (typeof taskId !== 'number' || !Number.isSafeInteger(taskId) || taskId <= 0) return null
  const fireId = typeof payload.fireId === 'string' ? payload.fireId.trim() : ''
  const match = /^scheduled-wake:([1-9][0-9]*):(.+)$/.exec(fireId)
  if (!match || Number(match[1]) !== taskId) return null
  const firedAt = Date.parse(match[2])
  if (!Number.isFinite(firedAt) || new Date(firedAt).toISOString() !== match[2]) return null
  const boards = payload.boardGrant.boards
  if (typeof boards !== 'number' || !Number.isSafeInteger(boards) || boards <= 0) return null
  const stated = Date.parse(String(payload.boardGrant.expiresAt ?? ''))
  if (!Number.isFinite(stated)) return null
  const expiresAtMs = Math.min(stated, firedAt + SCHEDULE_GRANT_MAX_MS)
  if (now >= expiresAtMs) return null
  return Object.freeze({ taskId, fireId, actingUserId, chatId: String(chatId ?? ''), expiresAtMs })
}

/**
 * The granted run this daemon is in, if any. One at a time, and never superseded: a newer granted wake waits like any
 * other card until the live run ends. `onEnded(run, reason)` is told once per run, for the server's run end call.
 * @param {{ now?: () => number, setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (handle: any) => void,
 *   onEnded?: (run: ScheduleGrantRun, reason: string) => void, beginWithinMs?: number }} [options]
 */
export function createScheduleGrantRuns({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onEnded = () => {}, beginWithinMs = BEGIN_WITHIN_MS } = {}) {
  /** @type {ScheduleGrantRun | null} */
  let run = null
  /** @type {any[]} */
  let timers = []
  /** @type {Array<{ resolve: () => void, granted: boolean, key: object | null }>} */
  let waiters = []
  // Cards a granted wake already went ahead of once (round 5, N2): they go before the next one, so back to back
  // granted runs can never hold another person's message without end.
  /** @type {WeakSet<object>} */
  const passedOver = new WeakSet()
  // Fire ids already opened (bounded). A convenience only: the server refuses a fire whose run ended.
  /** @type {string[]} */
  const seen = []
  /** @param {() => void} fn @param {number} ms */
  const arm = (fn, ms) => {
    const handle = setTimer(fn, Math.max(0, ms))
    if (handle && typeof handle.unref === 'function') handle.unref()
    timers.push(handle)
  }

  /** @param {string} reason */
  const end = (reason) => {
    if (!run || run.ended) return false
    run.ended = true
    for (const handle of timers) clearTimer(handle)
    timers = []
    const ended = run
    // A held granted wake goes first (round 4, F5): released alone it reaches an idle CLI as its own prompt, opens
    // its run, and everything behind it waits again. But never twice ahead of the same card (round 5, N2): a card a
    // granted wake already went ahead of goes before the next granted wake. Otherwise in arrival order.
    const isOver = (/** @type {{ key: object | null }} */ w) => w.key !== null && passedOver.has(w.key)
    const over = waiters.filter((w) => !w.granted && isOver(w))
    const granted = waiters.filter((w) => w.granted)
    const rest = waiters.filter((w) => !w.granted && !isOver(w))
    if (granted.length > 0) for (const w of rest) if (w.key !== null) passedOver.add(w.key)
    const release = [...over, ...granted, ...rest]
    waiters = []
    for (const waiter of release) waiter.resolve()
    try { onEnded(ended, reason) } catch { /* the run is over either way */ }
    return true
  }

  const live = () => {
    if (!run || run.ended) return null
    if (now() >= run.expiresAtMs) { end('expired'); return null }
    return run
  }

  return {
    /**
     * Opens the run a granted wake starts. False while another run is live (the wake waits for it), for a fire
     * already opened, or for a window already over.
     * @param {Readonly<ScheduleGrant> | null | undefined} grant
     */
    open(grant) {
      if (!grant || live() !== null || seen.includes(grant.fireId) || now() >= grant.expiresAtMs) return false
      seen.push(grant.fireId)
      while (seen.length > 64) seen.shift()
      run = { ...grant, delivered: false, token: null, begun: false, ended: false }
      arm(() => end('expired'), grant.expiresAtMs - now())
      return true
    },
    live,
    /**
     * Does this card wait for the live run to end? Every card does but the run's own wake.
     * @param {Readonly<ScheduleGrant> | null | undefined} grant the grant the card carries, if it is a granted wake
     */
    holds(grant) {
      const open = live()
      return open !== null && !(grant && grant.fireId === open.fireId && !open.delivered)
    },
    /**
     * @param {boolean} [granted] the waiting card is a granted wake
     * @param {object | null} [key] the card itself, so a card passed over once is known again when it waits again
     * @returns {Promise<void>}
     */
    whenReleased(granted = false, key = null) {
      if (live() === null) return Promise.resolve()
      return new Promise((resolve) => { waiters.push({ resolve: () => resolve(), granted, key }) })
    },
    /**
     * The wake was handed to the CLI, as this content: its delivery token names the prompt that is its turn, which
     * must begin soon. A card with no token, or several, can never begin a run.
     * @param {string} fireId @param {unknown} content
     */
    noteDelivered(fireId, content) {
      const open = live()
      if (!open || open.fireId !== fireId) return
      open.delivered = true
      const tokens = tokensIn(content)
      open.token = tokens.length === 1 ? tokens[0] : null
      arm(() => { if (run === open && !open.begun) end('never began') }, beginWithinMs)
    },
    /** The wake never reached the CLI: there is no run. @param {string} fireId */
    noteNotDelivered(fireId) { const open = live(); if (open && open.fireId === fireId) end('not delivered') },
    /**
     * A CLI prompt began. Only the prompt that is the wake's own card alone (its one token and no other delivery's)
     * is the run's turn: one that carries an earlier queued message too, or none of the wake, begins nothing, and the
     * run then ends at BEGIN_WITHIN_MS, failing closed.
     * @param {unknown} prompt
     */
    noteBegin(prompt) {
      const open = live()
      if (!open || !open.delivered || open.begun || open.token === null) return
      const tokens = tokensIn(prompt)
      if (tokens.length === 1 && tokens[0] === open.token) open.begun = true
    },
    /** A CLI turn stopped: a run whose turn began is over. */
    noteStop() { const open = live(); if (open && open.begun) end('turn ended') },
    end,
  }
}

/**
 * THE ONE CHOKE POINT (round 3, Data's rule 1). Wraps the session's notification sender: while a granted run is live
 * every channel card waits until it ends, except the run's own wake. A card's params may be a function: it is called
 * only once the card is released, right before it is sent, so whatever it records (the private turn tracker's
 * deliver, noteUntracked, a tap) happens when the card really goes out, never while it waits. A builder that returns
 * null sends nothing. A granted wake names its grant as `scheduleGrant` on the notification; it opens its run when it
 * is released, and the run counts as handed over as soon as the card is built (the CLI's prompt can come before the
 * write resolves).
 * A released card goes out through `resend`, the WHOLE notification chain (round 4, F2): so it waits again for the
 * model and effort lock if that is busy at release, and that lock stamps the time the card really went out.
 * @param {ReturnType<typeof createScheduleGrantRuns>} runs
 * @param {(notification: any) => Promise<any>} send
 * @param {{ log?: (line: string) => void, resend?: (notification: any) => any }} [options]
 * @returns {(notification: any) => Promise<any>}
 */
export function holdChannelCardsDuringGrantedRun(runs, send, { log = () => {}, resend } = {}) {
  /** @param {any} notification @returns {any} */
  const hold = (notification) => {
    if (notification?.method !== CHANNEL_CARD_METHOD) return send(notification)
    const { scheduleGrant, onHeld, ...card } = notification
    const grant = scheduleGrant ?? null
    // Held: wait for the run to end and try again (a newer run may have opened meanwhile). Not held: exactly as
    // before this hold existed, synchronously. `onHeld` is told at once, so the lane that sent the card need not
    // wait on it (round 5, N1: a held card must never stall the poll tick, the lock heartbeat or the beacon).
    if (runs.holds(grant)) {
      log('scheduled run: a channel card waits until the run ends')
      if (typeof onHeld === 'function') {
        try { onHeld() } catch { /* the lane's own bookkeeping; the card waits either way */ }
      }
      return runs.whenReleased(grant !== null, notification).then(() => (resend ?? hold)(notification))
    }
    const opened = grant ? runs.open(grant) : false
    if (opened) log(`scheduled run ${grant.taskId}: board grant open; every other card waits until its turn ends`)
    const notDelivered = () => { if (opened) runs.noteNotDelivered(grant.fireId) }
    try {
      let built = card
      if (typeof card.params === 'function') {
        const params = card.params()
        if (params == null) {
          notDelivered()
          return Promise.resolve(undefined)
        }
        built = { ...card, params }
      }
      if (opened) runs.noteDelivered(grant.fireId, built.params?.content)
      const sent = send(built)
      if (opened && sent && typeof sent.then === 'function') {
        return sent.then(undefined, (/** @type {unknown} */ err) => { notDelivered(); throw err })
      }
      return sent
    } catch (err) {
      notDelivered()
      throw err
    }
  }
  return hold
}

/**
 * A lane's view of one handoff under the hold (round 5, N1): pass `onHeld` on the card, then `wait(handoff)`
 * answers 'done' when the card went out (or its handoff failed, which rejects as before), or 'held' as soon as the
 * hold kept it, so the lane goes on (its poll batch, its stream update, its tick) while the card waits. A lane that
 * goes on must keep its chat's cursor below the held message until `handoff` settles.
 * @returns {{ onHeld: () => void, wait: (handoff: Promise<unknown>) => Promise<'done' | 'held'> }}
 */
export function heldHandoff() {
  /** @type {(value: 'held') => void} */
  let tell = () => {}
  const held = new Promise((resolve) => { tell = resolve })
  let told = false
  return {
    onHeld: () => { if (!told) { told = true; tell('held') } },
    wait: (handoff) => Promise.race([handoff.then(() => /** @type {'done'} */ ('done')), held]),
  }
}

/**
 * The private authority of a boards call: exactly the private turn gate's. In the turn a granted wake opened, the
 * scheduler's verified turn also carries the grant, so the server narrows it to the boards the schedule named and
 * holds the run's output. No other turn carries it (the owner's own turns keep their full reach), and a turn the gate
 * refuses is refused: there is no admission on the grant alone.
 * @template {{ actingUserId: string, headers: Record<string, string> }} T
 * @param {{ requirePrivateTurn: (tracker: any, markerPaths: string[], ownerUserId: string) => T, tracker: any,
 *   markerPaths: string[], ownerUserId: string, runs: { live: () => ScheduleGrantRun | null } }} input
 * @returns {T}
 */
export function requireBoardsTurn({ requirePrivateTurn, tracker, markerPaths, ownerUserId, runs }) {
  const turn = requirePrivateTurn(tracker, markerPaths, ownerUserId)
  const open = runs?.live?.() ?? null
  if (open && open.begun && turn.actingUserId === open.actingUserId) {
    return { ...turn, headers: { ...turn.headers, [SCHEDULE_GRANT_HEADER]: open.fireId }, scheduleGrant: open.fireId }
  }
  return turn
}
