/**
 * Sending the `schedule` create: one request id per request, the same id when
 * the add-on itself asks again, and a plain sentence when the server says no.
 *
 * Why. A create whose answer is lost (the server made the routine, the reply
 * never arrived) used to leave two doors open to a second routine. The server
 * now answers a repeat of the same id and body with the first result and makes
 * nothing new (POST scheduled-tasks/agent). This module
 * is the plugin half: it is what makes "the same request" mean the same id.
 *
 * The retry paths a create has in this add-on, all of them:
 *
 *   1. A LOST ANSWER (no answer in time, a dropped connection, an answer cut
 *      off, a gateway 502/503/504, or the server's 429 "another request is
 *      still being decided"): asked once more, with the SAME id. The server
 *      then returns the first result, or (if the first ask is still running)
 *      makes the second wait and then returns the first result, or refuses
 *      the second with that same 429 and writes nothing. Only when the body carries an id:
 *      without one a second ask could make a second routine, so there is none.
 *   2. An OLDER SERVER that refuses the field (it answers 400
 *      "property clientRequestId should not exist"): that refusal made nothing,
 *      so the same body is sent once more WITHOUT the id and the call works as
 *      it always did. An older server that quietly drops the field needs no
 *      handling for the normal case: the call works as it always did. ONE
 *      COST: that server has no memory of the id, so if it made the routine
 *      and the answer was lost, path 1 asks again and the add-on itself makes
 *      a second routine there. The 201 answer does not echo the id, so the
 *      add-on cannot tell such a server from a current one; the cost ends
 *      when that server is updated.
 *   3. No other path. The transport (boundedFetch) makes one attempt (fetch
 *      itself re-sends a POST on a 307 or 308 redirect, with the same body and
 *      id, which is harmless), and the queue/poll loops never touch a create. An AGENT calling `schedule`
 *      again after a failure is a new tool call: it gets a new id and is not
 *      covered. The body is never hashed into an id, because two identical
 *      routines that were both asked for must both be made.
 *
 * When every ask got no usable answer the agent reads one sentence (the
 * routine may already exist, call list_schedules before asking again), never
 * the raw transport line and never the server's "try again in a moment": a
 * fresh call is a new request with a new id, and the first ask may still be
 * making its routine.
 *
 * Pure in the sense that matters for tests: the post and the sleep are passed
 * in, so a fake server and a no-wait clock drive it. server.ts is the thin
 * wiring (it mints one id per tool call and passes bgosPeerPost).
 */

import { randomUUID } from 'node:crypto'
import { SCHEDULE_REQUEST_ID_PATTERN, type ScheduleCreateBody } from './schedule.js'

export { SCHEDULE_REQUEST_ID_PATTERN }

/** How long to wait before the one second ask. Short: the answer was lost, not refused. */
export const SCHEDULE_REASK_DELAY_MS = 750

/** A new request name for a new request: 36 characters of hex and hyphens, in the server's shape. */
export function newScheduleRequestId(): string {
  return randomUUID()
}

/**
 * The failure an answered HTTP refusal raises. `detail` is the server's sentence,
 * already cut down by errorBodyText. The message is exactly what the
 * peer calls always raised (`POST 400: <the server's sentence>`), so nothing
 * that prints it changes; the status and the sentence ride along as fields so
 * a caller can tell "the server said no" from "no answer came back".
 */
export function httpFailure(method: string, status: number, detail: string): Error & { status: number; detail: string } {
  return Object.assign(new Error(`${method} ${status}: ${detail}`), { status, detail })
}

export type ScheduleSendResult = { ok: true; result: unknown } | { ok: false; error: string }

export interface ScheduleSendOptions {
  /** The body from buildScheduleCreateBody. Its id (if any) is the one name of this request. */
  body: ScheduleCreateBody
  /** One attempt at the POST. Throws httpFailure for an answered refusal; anything else is "no usable answer". */
  post: (body: ScheduleCreateBody) => Promise<unknown>
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

/** What the agent reads when the server says this request clashed with an earlier one. */
export const SCHEDULE_CLASH_TEXT =
  'This request clashed with an earlier one, so nothing was scheduled. Call schedule again to make the routine.'

/** What the agent reads when the owner deleted the routine this request made. */
export const SCHEDULE_DELETED_TEXT =
  'This routine was made and then deleted by the owner, so it was not made again. Call schedule again if it is still wanted.'

/** What the agent reads when no ask got a usable answer. The routine may exist. */
export const SCHEDULE_UNKNOWN_TEXT =
  'The server did not give an answer that could be read, so the routine may already exist. Call list_schedules to check before asking again.'

/** The server's 429 for an ask that met another ask still being decided. It wrote nothing. */
const BUSY_RE = /another scheduling request is still being decided/i

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function statusOf(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : null
}

function textOf(err: unknown): string {
  const detail = (err as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string') return detail
  return err instanceof Error ? err.message : String(err)
}

/**
 * No usable answer: nothing came back, or a gateway never got the backend's
 * answer, or the server said another ask is still being decided. In every case
 * the routine may exist (or be made a moment later by the ask still running).
 */
function isLostAnswer(status: number | null, text: string): boolean {
  if (status === null || status === 502 || status === 503 || status === 504) return true
  return status === 429 && BUSY_RE.test(text)
}

function withoutId(body: ScheduleCreateBody): ScheduleCreateBody {
  const { clientRequestId: _id, ...rest } = body
  return rest
}

export async function sendScheduleCreate(opts: ScheduleSendOptions): Promise<ScheduleSendResult> {
  const sleep = opts.sleep ?? defaultSleep
  const log = opts.log ?? (() => {})
  let body = opts.body
  let askedAgain = false
  let resentWithoutId = false
  for (;;) {
    try {
      return { ok: true, result: await opts.post(body) }
    } catch (err) {
      const status = statusOf(err)
      const lost = isLostAnswer(status, textOf(err))
      if (lost && body.clientRequestId !== undefined && !askedAgain) {
        askedAgain = true
        log('schedule: no usable answer, asking once more with the same request id')
        await sleep(SCHEDULE_REASK_DELAY_MS)
        continue
      }
      if (
        status === 400 &&
        body.clientRequestId !== undefined &&
        !resentWithoutId &&
        /clientRequestId should not exist/.test(textOf(err))
      ) {
        resentWithoutId = true
        log('schedule: this server does not know request ids, sending again without one')
        body = withoutId(body)
        continue
      }
      if (status === 409) {
        const text = textOf(err)
        if (/clientRequestId/.test(text)) {
          return { ok: false, error: /deleted/.test(text) ? SCHEDULE_DELETED_TEXT : SCHEDULE_CLASH_TEXT }
        }
        return { ok: false, error: text }
      }
      if (lost) {
        log(`schedule: no usable answer after ${askedAgain ? 2 : 1} ask(s): ${err instanceof Error ? err.message : String(err)}`)
        return { ok: false, error: SCHEDULE_UNKNOWN_TEXT }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
