// A scheduled run keeps the permission of the person who scheduled it (0.86.20, 2026-11-07).
//
// The private turn gate ends an agent's private actions the moment anyone else's message reaches its turn. That is
// right for a turn a person opened, and it meant a long scheduled job in a busy group (a nightly board backup) could
// never finish: each message from someone else ended its board reads and writes, and opened a new turn that refused the
// helpers it had started.
//
// A wake of a schedule that named its boards now carries a grant (eventMeta.payload.boardGrant, the server's
// services/schedule-board-grant.ts). While that run is live:
//   - other people's messages (and agents', and emails') wait: they are delivered when the run ends, so the agent never
//     acts on them mid run and they cannot open a new turn under it;
//   - its board calls carry X-BGOS-Schedule-Grant (the wake's fire id). The server runs them as the person who created
//     the schedule, on the boards the schedule named and nothing else, audits each one, and refuses the agent's posts
//     into the group until the run ends, so what the run read reaches only that person's private chat.
// The run ends at the end of the CLI turn it opened, or when its window runs out (at most two hours after its fire).
// Raw delivery fields grant nothing: the grant is checked by the server against this agent's own credential.

export const SCHEDULE_GRANT_HEADER = 'X-BGOS-Schedule-Grant'
/** The server's window (SCHEDULE_GRANT_TTL_MS); a payload never makes it longer. */
export const SCHEDULE_GRANT_MAX_MS = 2 * 60 * 60 * 1000

const USER_ID_RE = /^user_[A-Za-z0-9_-]+$/
/**
 * @typedef {{ taskId: number, fireId: string, actingUserId: string, chatId: string, expiresAtMs: number }} ScheduleGrant
 * @typedef {ScheduleGrant & { begun: boolean, ended: boolean }} ScheduleGrantRun
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * The grant a delivery carries, or null: a scheduler wake (no status, no payload kind) for a verified person, whose
 * payload names its task, its exact fire id and a boardGrant with at least one board and a window that has not ended.
 * The window is the earlier of the payload's end and two hours after the fire the fire id names.
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
 * The granted runs this daemon delivered. One run at a time: a newer grant replaces an open one (the server only
 * honours a task's latest fire anyway). `onEnded(run, reason)` is told once per run, for the server's run end call.
 * @param {{ now?: () => number, setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (handle: any) => void,
 *   onEnded?: (run: ScheduleGrantRun, reason: string) => void }} [options]
 */
export function createScheduleGrantRuns({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onEnded = () => {} } = {}) {
  /** @type {ScheduleGrantRun | null} */
  let run = null
  /** @type {any} */
  let timer = null
  /** @type {Array<() => void>} */
  let waiters = []
  // Fire ids already opened (bounded): a wake delivered again never reopens a run that ended.
  /** @type {string[]} */
  const seen = []

  /** @param {string} reason */
  const end = (reason) => {
    if (!run || run.ended) return false
    run.ended = true
    if (timer !== null) { clearTimer(timer); timer = null }
    const ended = run
    const release = waiters
    waiters = []
    for (const resolve of release) resolve()
    try { onEnded(ended, reason) } catch { /* the run is over either way */ }
    return true
  }

  const live = () => {
    if (!run || run.ended) return null
    if (now() >= run.expiresAtMs) { end('expired'); return null }
    return run
  }

  return {
    /** Opens the run a granted wake starts. False for a fire already opened, or a window already over.
     * @param {Readonly<ScheduleGrant> | null | undefined} grant */
    open(grant) {
      if (!grant || seen.includes(grant.fireId) || now() >= grant.expiresAtMs) return false
      if (run && !run.ended) end('superseded')
      seen.push(grant.fireId)
      while (seen.length > 64) seen.shift()
      run = { ...grant, begun: false, ended: false }
      timer = setTimer(() => end('expired'), Math.max(0, grant.expiresAtMs - now()))
      if (timer && typeof timer.unref === 'function') timer.unref()
      return true
    },
    live,
    /** Does a delivery wait for the run to end? Everyone's but the scheduler's own does.
     * @param {{ actingUserId?: string | null }} [who] */
    holds({ actingUserId } = {}) {
      const open = live()
      return open !== null && actingUserId !== open.actingUserId
    },
    /** Resolves when the open run ends (at once when none is open). */
    /** @returns {Promise<void>} */
    whenReleased() {
      if (live() === null) return Promise.resolve()
      return new Promise((resolve) => { waiters.push(() => resolve()) })
    },
    /** A CLI prompt began: the turn the run's wake opens (or a later one) is running. */
    noteBegin() { const open = live(); if (open) open.begun = true },
    /** A CLI turn stopped: a run whose turn began is over. */
    noteStop() { const open = live(); if (open && open.begun) end('turn ended') },
    end,
  }
}

/**
 * The private authority of a boards call. A verified turn of the run's person carries the grant header too, so the
 * server narrows it to the boards the schedule named. With no verified turn, a run whose turn began still admits the
 * call on the grant alone, as that person and nothing wider. Anything else is the private turn refusal, unchanged.
 * @template {{ actingUserId: string, headers: Record<string, string> }} T
 * @param {{ requirePrivateTurn: (tracker: any, markerPaths: string[], ownerUserId: string) => T, tracker: any,
 *   markerPaths: string[], ownerUserId: string, runs: { live: () => ScheduleGrantRun | null } }} input
 * @returns {T}
 */
export function requireBoardsTurn({ requirePrivateTurn, tracker, markerPaths, ownerUserId, runs }) {
  let turn = null
  let refusal = null
  try { turn = requirePrivateTurn(tracker, markerPaths, ownerUserId) } catch (err) { refusal = err }
  const open = runs?.live?.() ?? null
  if (turn) {
    if (open && turn.actingUserId === open.actingUserId) {
      return { ...turn, headers: { ...turn.headers, [SCHEDULE_GRANT_HEADER]: open.fireId }, scheduleGrant: open.fireId }
    }
    return turn
  }
  if (open && open.begun) {
    return /** @type {T} */ (/** @type {unknown} */ ({
      actingUserId: open.actingUserId,
      chatId: open.chatId,
      headers: {
        ...(open.actingUserId === ownerUserId ? {} : { 'X-BGOS-Acting-User': open.actingUserId }),
        [SCHEDULE_GRANT_HEADER]: open.fireId,
      },
      scheduleGrant: open.fireId,
    }))
  }
  throw refusal
}
