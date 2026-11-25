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
 *      it always did. The same goes for runDisplay, the routine's own "when it
 *      runs" choice: sent once more without it, and the agent is told
 *      the routine follows its owner's Settings. One 400 may name both; one
 *      resend then leaves out both. Each field is left out at most once. An
 *      older server that quietly drops the field needs no
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
import {
  RUN_DISPLAY_WORDS,
  SCHEDULE_REQUEST_ID_PATTERN,
  type RunDisplay,
  type RunEndBody,
  type ScheduleCreateBody,
} from './schedule.js'

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

export type ScheduleSendResult =
  | {
      ok: true
      result: unknown
      /** The optional fields an older server refused, left out of the send that made the routine. */
      dropped?: readonly OptionalCreateField[]
      /** One sentence on the routine's when_it_runs choice (whenItRunsNote); absent when none was chosen. */
      note?: string
    }
  | { ok: false; error: string }

/**
 * The newer, optional create fields an older strict server refuses with 400 "property <field> should not exist".
 * That refusal made nothing, so the create goes once more without the refused ones.
 */
export const OPTIONAL_CREATE_FIELDS = Object.freeze(['clientRequestId', 'runDisplay'] as const)
export type OptionalCreateField = (typeof OPTIONAL_CREATE_FIELDS)[number]

/** "This routine follows your owner's Settings", said once, the same everywhere. */
const FOLLOWS_SETTINGS = "so this routine follows your owner's When a routine runs setting."

/**
 * WHEN A ROUTINE RUNS (2026-11-22): what the agent reads about the routine's when_it_runs choice after a create, from
 * the server's own answer, so it never tells its owner a choice was kept when it was not. Nothing chosen says nothing
 * (the routine follows the owner's Settings, as every routine did before). An older server that refused the field, or
 * an answer that names another value, means the routine follows Settings. An answer that does not name the field at
 * all says only that much.
 */
export function whenItRunsNote(input: { sent: RunDisplay | undefined; dropped: boolean; result: unknown }): string {
  if (input.sent === undefined) return ''
  if (input.dropped) return `This server cannot keep a when_it_runs choice yet, ${FOLLOWS_SETTINGS}`
  const result = input.result
  if (result === null || typeof result !== 'object' || !Object.hasOwn(result, 'runDisplay')) {
    return 'The server did not say whether it kept the when_it_runs choice.'
  }
  if ((result as { runDisplay?: unknown }).runDisplay === input.sent) {
    return `When it runs: ${RUN_DISPLAY_WORDS[input.sent]}, kept for this routine.`
  }
  return `The server did not keep the when_it_runs choice, ${FOLLOWS_SETTINGS}`
}

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

function without(body: ScheduleCreateBody, fields: readonly OptionalCreateField[]): ScheduleCreateBody {
  const rest = { ...body }
  for (const field of fields) delete rest[field]
  return rest
}

/** The optional fields this body carries that a 400 says should not exist. */
function refusedFields(body: ScheduleCreateBody, text: string): OptionalCreateField[] {
  return OPTIONAL_CREATE_FIELDS.filter((field) => body[field] !== undefined && text.includes(`${field} should not exist`))
}

export async function sendScheduleCreate(opts: ScheduleSendOptions): Promise<ScheduleSendResult> {
  const sleep = opts.sleep ?? defaultSleep
  const log = opts.log ?? (() => {})
  let body = opts.body
  let askedAgain = false
  const dropped: OptionalCreateField[] = []
  for (;;) {
    try {
      const result = await opts.post(body)
      const note = whenItRunsNote({ sent: opts.body.runDisplay, dropped: dropped.includes('runDisplay'), result })
      return { ok: true, result, ...(dropped.length > 0 ? { dropped } : {}), ...(note ? { note } : {}) }
    } catch (err) {
      const status = statusOf(err)
      const lost = isLostAnswer(status, textOf(err))
      if (lost && body.clientRequestId !== undefined && !askedAgain) {
        askedAgain = true
        log('schedule: no usable answer, asking once more with the same request id')
        await sleep(SCHEDULE_REASK_DELAY_MS)
        continue
      }
      // A field once left out is gone from the body, so it is never refused, or left out, twice.
      const refused = status === 400 ? refusedFields(body, textOf(err)) : []
      if (refused.length > 0) {
        dropped.push(...refused)
        if (refused.includes('clientRequestId')) log('schedule: this server does not know request ids, sending again without one')
        if (refused.includes('runDisplay')) log('schedule: this server cannot keep a when_it_runs choice, sending again without it')
        body = without(body, refused)
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

// ── end_run: the end of one run of a routine (When a routine runs, 2026-11-22) ──
//
// The agent ends one run with no change (post nothing) or could not check (its owner gets a Could not check card with
// the words for its reason code). Only a private turn may call it, as only one may call schedule (server.ts admission), and the daemon
// posts it as it posts schedule: its own credential and X-Caller-Assistant-Id, plus the acting user header on a share
// recipient's turn. Every answer reads as one plain sentence. When the end was not taken, the sentence says to reply
// normally instead: a reply is never wrong for a run, and a run left silent turns into a red card on the server's sweep.

/** What the agent reads when its no change end was taken. */
export const RUN_END_NO_CHANGE_TEXT = 'Run ended: no change. Post nothing more for this run.'

/**
 * What the agent reads when its could not check end was taken. The card is a system row in the agent's own chat, and
 * the server pushes every such row back to the agent (review rv418 F1), so this says that card needs no reply: the
 * failure is announced once, by the card, with the details at most once in the agent's own reply.
 */
export const RUN_END_COULD_NOT_CHECK_TEXT =
  'Run ended: could not check. Your owner gets a Could not check card with the reason you picked. ' +
  'That card also comes back to you in this chat as a system message: it needs no reply. ' +
  'If your owner needs the details and you have not given them yet, say them once in a normal reply.'

/** A 404: the server offers no run ends yet, or this run is not one this agent may end. */
export const RUN_END_NOT_TAKEN_TEXT =
  'The server did not take a run end for this routine: it does not offer run ends yet, or this run is not yours to end. Reply normally instead.'

/** No usable answer came back. The end may or may not have been taken; a reply is right either way. */
export const RUN_END_UNREAD_TEXT = 'The run end did not reach the server, or its answer was lost. Reply normally instead.'

/** How a run ended, in words: the two the agent sends, and the server's own (no answer). */
const RUN_END_OUTCOME_WORDS: Readonly<Record<string, string>> = Object.freeze({
  no_change: 'no change',
  could_not_check: 'could not check',
  no_answer: 'no answer',
})

/** The server's sentence, ending in a full stop. */
function asSentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

export interface RunEndSendOptions {
  path: string
  body: RunEndBody
  /** One attempt at the POST: bgosPeerPost in server.ts. Throws httpFailure for an answered refusal. */
  post: (path: string, body: Record<string, unknown>) => Promise<unknown>
}

/**
 * One post, and once more without the code if a strict older server refuses that field: the refusal ended nothing, and
 * the body still carries the code's fixed words as `reason`, which every server takes.
 */
async function postRunEnd(opts: RunEndSendOptions): Promise<unknown> {
  try {
    return await opts.post(opts.path, { ...opts.body })
  } catch (err) {
    if (opts.body.reasonCode === undefined || statusOf(err) !== 400 || !textOf(err).includes('reasonCode should not exist')) throw err
    const { reasonCode: _refused, ...older } = opts.body
    return await opts.post(opts.path, { ...older })
  }
}

export async function sendRunEnd(opts: RunEndSendOptions): Promise<{ ok: boolean; text: string }> {
  let answer: unknown
  try {
    answer = await postRunEnd(opts)
  } catch (err) {
    const status = statusOf(err)
    const detail = textOf(err)
    // The server's own sentence: this run must answer, or the fire is no longer the latest run.
    if (status === 409 && detail.trim()) return { ok: false, text: asSentence(detail) }
    if (status === 404) return { ok: false, text: RUN_END_NOT_TAKEN_TEXT }
    if (status === 400) {
      return {
        ok: false,
        text: `The server refused this run end: ${asSentence(detail)} Copy task_id and fire_id from the same wake's event payload, or reply normally instead.`,
      }
    }
    if (status === null || isLostAnswer(status, detail)) return { ok: false, text: RUN_END_UNREAD_TEXT }
    return { ok: false, text: `The run end did not go through (${status}${detail.trim() ? `: ${detail.trim()}` : ''}). Reply normally instead.` }
  }
  const ended = answer !== null && typeof answer === 'object' ? (answer as { ended?: unknown; outcome?: unknown }) : null
  if (ended?.ended === true) {
    return { ok: true, text: opts.body.outcome === 'could_not_check' ? RUN_END_COULD_NOT_CHECK_TEXT : RUN_END_NO_CHANGE_TEXT }
  }
  if (ended?.ended === false) {
    const how = typeof ended.outcome === 'string' && Object.hasOwn(RUN_END_OUTCOME_WORDS, ended.outcome) ? RUN_END_OUTCOME_WORDS[ended.outcome] : undefined
    return { ok: true, text: `This run was already ended${how ? ` (${how})` : ''}. Nothing more to do for it.` }
  }
  return { ok: false, text: 'The server answered, but did not say the run ended. Reply normally instead.' }
}
