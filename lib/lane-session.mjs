/**
 * PERSON LANES, the lane session (shared agents Phase 3, P3 and P7; design
 * 5.2 "The lane's credential", 7.2 "How a running lane learns").
 *
 * A lane's only credential is its lane session (`lsess_...`), minted from the
 * single use ticket the owner's daemon left in the lane's state folder and
 * stored there (0600). P3 had only the lane daemon mint it. P7 needs the
 * policy BEFORE the lane's Claude starts (launch flags are fixed for a
 * process's life), so the supervisor mints it first and reads `lanes/me`; the
 * lane daemon then finds the stored session and uses it. Neither ever holds
 * the pairing token.
 *
 * Plain JavaScript: the supervisor runs on a bare `node`. lib/lane-daemon.ts
 * re-exports the pure parts for the lane daemon.
 *
 * No em or en dashes in this file.
 */
import * as nodeFs from 'node:fs'
import { dirname } from 'node:path'

import { personLaneStamp } from './lane-core.mjs'

/** A lane session token as the backend mints it. */
export const LANE_SESSION_RE = /^lsess_[A-Za-z0-9_-]{8,512}$/

/**
 * @typedef {{ sessionToken: string, expiresAt: string, actorUserId: string, assistantId: string, pairingId: string }} StoredLaneSession
 */

/**
 * Is a stored session still usable for this lane (a minute of margin)?
 * @param {unknown} stored
 * @param {{ userId: string, assistantId: string }} lane
 * @param {number} nowMs
 * @returns {stored is StoredLaneSession}
 */
export function storedSessionUsable(stored, lane, nowMs) {
  if (!stored || typeof stored !== 'object') return false
  const s = /** @type {Record<string, unknown>} */ (stored)
  if (typeof s.sessionToken !== 'string' || !LANE_SESSION_RE.test(s.sessionToken)) return false
  if (s.actorUserId !== lane.userId || String(s.assistantId) !== String(lane.assistantId)) return false
  const exp = typeof s.expiresAt === 'string' ? Date.parse(s.expiresAt) : NaN
  return Number.isFinite(exp) && exp - nowMs > 60_000
}

/**
 * Read the backend's mint answer. It must name THIS lane: a session for any
 * other person or agent is refused, never used.
 * @param {any} body
 * @param {{ userId: string, assistantId: string }} lane
 * @returns {StoredLaneSession | null}
 */
export function readMintAnswer(body, lane) {
  if (!body || typeof body !== 'object') return null
  if (typeof body.sessionToken !== 'string' || !LANE_SESSION_RE.test(body.sessionToken)) return null
  if (typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt))) return null
  const l = body.lane ?? {}
  if (l.actorUserId !== lane.userId || String(l.assistantId) !== String(lane.assistantId)) return null
  if (l.stamp !== undefined && l.stamp !== personLaneStamp(lane.userId)) return null
  return {
    sessionToken: body.sessionToken,
    expiresAt: body.expiresAt,
    actorUserId: lane.userId,
    assistantId: String(lane.assistantId),
    pairingId: String(l.pairingId ?? ''),
  }
}

/**
 * Does `GET lanes/me` say this is exactly our lane?
 * @param {any} body
 * @param {{ userId: string, assistantId: string }} lane
 * @returns {boolean}
 */
export function laneMeMatches(body, lane) {
  if (!body || typeof body !== 'object') return false
  return (
    body.actorUserId === lane.userId &&
    String(body.assistantId) === String(lane.assistantId) &&
    body.lane === personLaneStamp(lane.userId)
  )
}

/**
 * A ticket as the owner's daemon leaves it: single use, two minutes.
 * @param {string} text
 * @param {number} nowMs
 * @returns {string | null}
 */
export function readTicketFile(text, nowMs) {
  try {
    const raw = JSON.parse(text)
    const ticket = raw?.laneTicket
    if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 200) return null
    const exp = typeof raw.ticketExpiresAt === 'string' ? Date.parse(raw.ticketExpiresAt) : NaN
    if (Number.isFinite(exp) && exp <= nowMs) return null
    return ticket
  } catch {
    return null
  }
}

/** The API base the lane routes live under, from BGOS_BACKEND_URL. */
export function laneApiBase(backendUrl) {
  const trimmed = String(backendUrl ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s/]+/.test(trimmed)) return null
  return /\/api\/v1$/.test(trimmed) ? trimmed : `${trimmed}/api/v1`
}

function writePrivateJson(fs, path, value) {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, path)
}

/**
 * The stored session if it is still usable, else a fresh one minted with the
 * ticket (removed BEFORE it is spent, so a crash cannot spend it twice).
 * Null when neither works.
 *
 * @param {{ lane: { userId: string, assistantId: string }, sessionPath: string, ticketPath: string,
 *   apiBase: string, fetch?: typeof fetch, fs?: typeof nodeFs, now?: () => number, log?: (l: string) => void }} o
 */
export async function ensureLaneSession(o) {
  const fs = o.fs ?? nodeFs
  const now = o.now ?? Date.now
  const log = o.log ?? (() => {})
  const doFetch = o.fetch ?? fetch
  try {
    const stored = JSON.parse(String(fs.readFileSync(o.sessionPath, 'utf8')))
    if (storedSessionUsable(stored, o.lane, now())) return stored
  } catch { /* none stored */ }
  let text
  try {
    text = String(fs.readFileSync(o.ticketPath, 'utf8'))
  } catch {
    return null
  }
  try { fs.unlinkSync(o.ticketPath) } catch { /* raced */ }
  const ticket = readTicketFile(text, now())
  if (!ticket) return null
  try {
    const res = await doFetch(`${o.apiBase}/integrations/lanes/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ laneTicket: ticket }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      log(`lane session mint answered ${res.status}`)
      return null
    }
    const answer = readMintAnswer(await res.json(), o.lane)
    if (!answer) {
      log('lane session mint answered something that is not this lane; refused')
      return null
    }
    writePrivateJson(fs, o.sessionPath, answer)
    return answer
  } catch (err) {
    log(`lane session mint failed: ${String(err?.message ?? err)}`)
    return null
  }
}

/**
 * `GET lanes/me` with the lane session. The body when it names exactly this
 * lane, else null (any failure reads as "unknown", and the caller launches
 * the locked base).
 */
export async function fetchLaneMe({ session, lane, apiBase, fetch: doFetch = fetch, log = () => {} }) {
  try {
    const res = await doFetch(`${apiBase}/integrations/lanes/me`, {
      method: 'GET',
      headers: { 'X-BGOS-Session': session.sessionToken },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      log(`lanes/me answered ${res.status}`)
      return null
    }
    const body = await res.json()
    return laneMeMatches(body, lane) ? body : null
  } catch (err) {
    log(`lanes/me failed: ${String(err?.message ?? err)}`)
    return null
  }
}
