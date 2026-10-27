/**
 * Every question group ask_user_input posts, kept until the owner has answered
 * or skipped every question of it, however late, and then handed over ONCE.
 *
 * WHY (Kc's card, 2026-10-27; Data approved option A, msg 161859). The tool
 * used to block up to 600 s and then report every unanswered question as
 * skipped. The card itself stays answerable forever: the backend accepts a
 * late answer (no deadline), stamps it, and puts a buttons_answered entry on
 * the agent's update stream. The plugin then dropped it on both transports,
 * so an owner who answered fifteen minutes later was answering nobody.
 *
 * NOW. ask_user_input posts, registers the group here and returns pending
 * (wait_seconds 0, the default). Both transports feed answers in through
 * record(): the stream's buttons_answered entry for a message this tracker
 * owns, the poll's row of one, the blocking wait's own reads, and a reconcile
 * of every pending group on connect. When the last question is answered the
 * group is complete and server.ts announces ONE ask_answered channel event
 * with every answer, unless a blocking wait holds it (hold), in which case the
 * wait returns the answers as the tool result instead. Either way delivered()
 * forgets the group for good.
 *
 * EXACTLY ONCE. Within a daemon life the shared announced-click set guards
 * the transports (server.ts rememberAnnouncedClick on every question id of a
 * delivered group); across lives the file does: a delivered group is gone
 * from `pending` and its id is in `delivered`, so a replay of any of its
 * answers is untracked. The file is written after every change by a temp file
 * and a rename, so a crash never leaves half a file.
 *
 * BOUNDS. At most MAX_PENDING_ASKS groups are kept (the oldest goes first,
 * with a log line), since a reconcile on connect reads one page per pending
 * group; and a group older than MAX_PENDING_AGE_MS is dropped when the file is
 * read. Neither is reached by an agent that follows the guidance.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { unescapeAgentButtonValue } from './message-text.ts'

export const ASK_TRACKER_FILE_NAME = 'pending-asks.json'
export const MAX_PENDING_ASKS = 50
export const MAX_PENDING_AGE_MS = 30 * 24 * 60 * 60_000
const MAX_DELIVERED_REMEMBERED = 200
const FILE_VERSION = 1

/** The longest wait_seconds may hold a turn: the blocking default the tool had before. */
export const MAX_ASK_WAIT_SECONDS = 600

/**
 * How long one ask_user_input call holds the turn. wait_seconds, default 0:
 * post, return pending, and the answers arrive later as one ask_answered
 * event. timeout_seconds is the older name for a blocking wait and keeps its
 * meaning, the upper bound of the wait, uncapped as it always was; only its
 * tail changed (a wait that runs out returns pending, never invented skips).
 * When both are given, wait_seconds wins.
 */
export function askWaitSeconds(args: Record<string, unknown>): number {
  const wait = args.wait_seconds
  if (wait !== undefined) {
    return typeof wait === 'number' && Number.isFinite(wait) && wait > 0
      ? Math.min(wait, MAX_ASK_WAIT_SECONDS)
      : 0
  }
  const legacy = args.timeout_seconds
  return typeof legacy === 'number' && Number.isFinite(legacy) && legacy > 0 ? legacy : 0
}

export interface AskOption {
  label: string
  value: string
}

export interface AskQuestion {
  messageId: number
  text: string
  options: AskOption[]
}

/** One question's answer, as the agent reads it (values already unescaped). */
export interface AskAnswer {
  skipped?: true
  optionValue?: string
  optionLabel?: string
  freeText?: string
}

export interface PendingAsk {
  askId: string
  chatId: string
  /** When the group was posted, ms since the epoch. */
  postedAt: number
  questions: AskQuestion[]
  /** By message id (a string key, so the file round-trips). */
  answers: Record<string, AskAnswer>
}

export type AskRecordOutcome =
  | { kind: 'untracked' }
  | { kind: 'duplicate'; askId: string }
  | { kind: 'partial'; askId: string; answered: number; total: number }
  | { kind: 'complete'; ask: PendingAsk }

/** The projection of a chat history row (GET chats/:id/messages) an answer is read from. */
export interface AskRow {
  message: {
    id: number
    answeredAt: string | null
    answerPayload: {
      optionId?: number
      freeText?: string
      skipped?: boolean
    } | null
  }
  messageOptions?: Array<{ id: number; text: string; callbackData: string }> | null
}

/**
 * Read one question's answer off its history row, or null while it is
 * unanswered. The backend's ask answer is { optionId?, freeText?, skipped }
 * (message.service.ts handleAskResponse); the option is matched to the row's
 * own options so the agent gets back the value it posted, `u:` sentinel off.
 */
export function askAnswerFromRow(row: AskRow): AskAnswer | null {
  const m = row.message
  if (!m.answeredAt || !m.answerPayload) return null
  const payload = m.answerPayload
  const answer: AskAnswer = {}
  if (payload.optionId != null) {
    const matched = (row.messageOptions ?? []).find((o) => o.id === payload.optionId)
    if (matched) {
      answer.optionValue = unescapeAgentButtonValue(matched.callbackData)
      answer.optionLabel = matched.text
    }
  }
  if (typeof payload.freeText === 'string') answer.freeText = payload.freeText
  if (payload.skipped === true) answer.skipped = true
  // Answered, but with nothing this reader can name (an option id the row no
  // longer carries): still an answer, so the group can complete, read as a skip.
  if (Object.keys(answer).length === 0) answer.skipped = true
  return answer
}

/** The answers of a group in question order, in the shape the blocking tool has always returned. */
export function askResultRows(ask: PendingAsk): Array<Record<string, unknown>> {
  return ask.questions.map((q) => {
    const a = ask.answers[String(q.messageId)] ?? {}
    return {
      question: q.text,
      ...(a.optionValue !== undefined && {
        picked_option_value: a.optionValue,
        picked_option_label: a.optionLabel,
      }),
      ...(a.freeText !== undefined && { free_text: a.freeText }),
      ...(a.skipped === true && { skipped: true }),
    }
  })
}

/**
 * What ask_user_input returns while the group is still open: at once (no
 * wait), or when a blocking wait ran out. Never a skip the owner did not
 * give: the card stays open and the answers arrive as one ask_answered event.
 */
export function askPendingText(opts: {
  askId: string
  total: number
  answered: number
  waitedSeconds?: number
}): string {
  const status = {
    status: 'pending',
    ask_id: opts.askId,
    questions: opts.total,
    ...(opts.waitedSeconds !== undefined ? { answered_so_far: opts.answered } : {}),
  }
  const lead =
    opts.waitedSeconds !== undefined
      ? `Not every question was answered within the ${opts.waitedSeconds} s wait. Nothing was skipped for your owner: the card stays open.`
      : 'Your question card is posted and stays open until your owner answers it.'
  return [
    JSON.stringify(status, null, 2),
    `${lead} End your turn now and do nothing that depends on these answers. ` +
      `When every question is answered or skipped they arrive together as ONE ask_answered ` +
      `channel event (meta.ask_id = ${opts.askId}), however late, and that starts a new turn.`,
  ].join('\n')
}

/**
 * The ONE ask_answered channel event of a complete group. Every meta value is
 * a string (the Claude Code harness drops a channel card whose meta carries
 * anything else), the answers ride in meta as JSON and in the content.
 */
export function buildAskAnsweredEvent(
  ask: PendingAsk,
  opts: { assistantId: string; ts?: string },
): { content: string; meta: Record<string, string> } {
  const rows = askResultRows(ask)
  const first = ask.questions[0]?.messageId
  const total = ask.questions.length
  const skipped = rows.filter((r) => r.skipped === true).length
  const head =
    skipped === total
      ? `[ask_answered] Your owner skipped all ${total} question${total === 1 ? '' : 's'} (ask_id=${ask.askId}).`
      : `[ask_answered] Your owner answered your question card: ${total - skipped} of ${total} answered${skipped ? `, ${skipped} skipped` : ''} (ask_id=${ask.askId}).`
  const content = [
    head,
    `(in reply to message_id=${first})`,
    JSON.stringify(rows, null, 2),
  ].join('\n')
  return {
    content,
    meta: {
      chat_id: String(ask.chatId),
      message_id: String(first),
      event_type: 'ask_answered',
      ask_id: String(ask.askId),
      answers: JSON.stringify(rows),
      user: 'User',
      assistant_id: String(opts.assistantId),
      ts: String(opts.ts ?? new Date().toISOString()),
    },
  }
}

function isComplete(ask: PendingAsk): boolean {
  return ask.questions.every((q) => ask.answers[String(q.messageId)] !== undefined)
}

function answeredCount(ask: PendingAsk): number {
  return ask.questions.filter((q) => ask.answers[String(q.messageId)] !== undefined).length
}

function validAsk(raw: unknown): raw is PendingAsk {
  const a = raw as PendingAsk
  return (
    !!a &&
    typeof a === 'object' &&
    typeof a.askId === 'string' &&
    a.askId !== '' &&
    typeof a.chatId === 'string' &&
    typeof a.postedAt === 'number' &&
    Array.isArray(a.questions) &&
    a.questions.length > 0 &&
    a.questions.every((q) => q && Number.isSafeInteger(q.messageId) && typeof q.text === 'string') &&
    !!a.answers &&
    typeof a.answers === 'object'
  )
}

export class AskTracker {
  private readonly filePath: string | null
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly asks = new Map<string, PendingAsk>()
  private readonly byMessage = new Map<number, string>()
  private readonly held = new Set<string>()
  private delivered_: string[] = []

  constructor(opts: { filePath: string | null; now?: () => number; log?: (line: string) => void }) {
    this.filePath = opts.filePath
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (() => {})
    this.load()
  }

  /** Track a group ask_user_input just posted. */
  register(input: { askId: string; chatId: string; questions: AskQuestion[] }): PendingAsk {
    const ask: PendingAsk = {
      askId: input.askId,
      chatId: String(input.chatId),
      postedAt: this.now(),
      questions: input.questions.map((q) => ({
        messageId: q.messageId,
        text: q.text,
        options: q.options.map((o) => ({ label: o.label, value: o.value })),
      })),
      answers: {},
    }
    this.forget(ask.askId)
    this.asks.set(ask.askId, ask)
    for (const q of ask.questions) this.byMessage.set(q.messageId, ask.askId)
    while (this.asks.size > MAX_PENDING_ASKS) {
      const oldest = this.asks.keys().next().value as string
      this.log(`ask tracker: dropping the oldest pending group ${oldest} (more than ${MAX_PENDING_ASKS} pending)`)
      this.forget(oldest)
    }
    this.save()
    return ask
  }

  owns(messageId: number): boolean {
    return this.byMessage.has(messageId)
  }

  askIdOf(messageId: number): string | null {
    return this.byMessage.get(messageId) ?? null
  }

  get(askId: string): PendingAsk | null {
    return this.asks.get(askId) ?? null
  }

  /** Every group still waiting for its owner, oldest first. */
  pending(): PendingAsk[] {
    return [...this.asks.values()]
  }

  /** The message ids of every pending question (for the poll's transition pass). */
  trackedMessageIds(): Set<number> {
    return new Set(this.byMessage.keys())
  }

  isComplete(askId: string): boolean {
    const ask = this.asks.get(askId)
    return !!ask && isComplete(ask)
  }

  /**
   * One question's answer. The FIRST answer read for a question is the one
   * kept (the backend refuses a second answer to a row anyway); a repeat is a
   * duplicate and changes nothing.
   */
  record(messageId: number, answer: AskAnswer): AskRecordOutcome {
    const askId = this.byMessage.get(messageId)
    if (askId === undefined) return { kind: 'untracked' }
    const ask = this.asks.get(askId)
    if (!ask) return { kind: 'untracked' }
    const key = String(messageId)
    if (ask.answers[key] !== undefined) return { kind: 'duplicate', askId }
    ask.answers[key] = { ...answer }
    this.save()
    if (isComplete(ask)) return { kind: 'complete', ask }
    return { kind: 'partial', askId, answered: answeredCount(ask), total: ask.questions.length }
  }

  /** A blocking wait owns this group: a complete group is its result, never an event. */
  hold(askId: string): void {
    this.held.add(askId)
  }

  release(askId: string): void {
    this.held.delete(askId)
  }

  isHeld(askId: string): boolean {
    return this.held.has(askId)
  }

  /** Complete groups nobody holds and nobody delivered yet: what an announce pass offers. */
  completeUndelivered(): PendingAsk[] {
    return this.pending().filter((a) => isComplete(a) && !this.held.has(a.askId))
  }

  /** Handed to the agent (event or tool result): forget the group for good, across restarts too. */
  delivered(askId: string): void {
    this.forget(askId)
    if (!this.delivered_.includes(askId)) this.delivered_.push(askId)
    if (this.delivered_.length > MAX_DELIVERED_REMEMBERED) {
      this.delivered_ = this.delivered_.slice(-MAX_DELIVERED_REMEMBERED)
    }
    this.save()
  }

  wasDelivered(askId: string): boolean {
    return this.delivered_.includes(askId)
  }

  /** The agent retired the card: forget it, and hand back its rows so they can be retired too. */
  withdraw(askId: string): PendingAsk | null {
    const ask = this.asks.get(askId)
    if (!ask) return null
    this.forget(askId)
    this.save()
    return ask
  }

  private forget(askId: string): void {
    const ask = this.asks.get(askId)
    if (!ask) return
    this.asks.delete(askId)
    this.held.delete(askId)
    for (const q of ask.questions) {
      if (this.byMessage.get(q.messageId) === askId) this.byMessage.delete(q.messageId)
    }
  }

  private load(): void {
    if (!this.filePath) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch {
      return
    }
    const body = parsed as { v?: unknown; pending?: unknown; delivered?: unknown }
    if (!body || body.v !== FILE_VERSION) return
    const cutoff = this.now() - MAX_PENDING_AGE_MS
    for (const raw of Array.isArray(body.pending) ? body.pending : []) {
      if (!validAsk(raw)) continue
      if (raw.postedAt < cutoff) {
        this.log(`ask tracker: dropping pending group ${raw.askId}, posted more than 30 days ago`)
        continue
      }
      this.asks.set(raw.askId, raw)
      for (const q of raw.questions) this.byMessage.set(q.messageId, raw.askId)
    }
    if (Array.isArray(body.delivered)) {
      this.delivered_ = body.delivered.filter((d): d is string => typeof d === 'string').slice(-MAX_DELIVERED_REMEMBERED)
    }
  }

  private save(): void {
    if (!this.filePath) return
    const tmp = `${this.filePath}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(
        tmp,
        JSON.stringify({ v: FILE_VERSION, pending: this.pending(), delivered: this.delivered_ }),
        { mode: 0o600 },
      )
      renameSync(tmp, this.filePath)
    } catch (err) {
      try {
        unlinkSync(tmp)
      } catch {
        /* never existed */
      }
      this.log(`ask tracker: could not save ${this.filePath}: ${err}`)
    }
  }
}
