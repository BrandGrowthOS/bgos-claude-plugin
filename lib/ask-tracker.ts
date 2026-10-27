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

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
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
  /** When an answer to it was last recorded, ms since the epoch (askReadIntervalMs). */
  lastAnsweredAt?: number
  /**
   * A blocking wait owns the group until then, ms since the epoch: on disk, so
   * another daemon of the same assistant never announces it while the waiter
   * may still return it, and a waiter that died lets go at its deadline.
   */
  heldUntil?: number
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

/**
 * The PATCH body that retires one question row when the agent withdraws its
 * card (the withdraw_ask tool), exactly as codex-channel-bgos retires one
 * (interactions.ts): no options, and inline, which also retires a question
 * that takes only free text (removing options alone would leave its answer
 * input live). The row and any answer already given stay in the chat.
 */
export function askRetireBody(): { options: []; renderMode: 'inline' } {
  return { options: [], renderMode: 'inline' }
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
      `channel event (meta.ask_id = ${opts.askId}), however late, and that starts a new turn. ` +
      `That turn is not your owner's own message, so tools that act for your owner (schedule, ` +
      `boards, the browser, email_send, call_owner) refuse in it: to run one after the answers, ` +
      `reply asking your owner to confirm, and act in the turn their message starts (with your ` +
      `owner in the chat, wait_seconds keeps the answers inside their own turn). ` +
      `If you no longer need the answers, call withdraw_ask with this ask_id.`,
  ].join('\n')
}

/**
 * How long a pending group may go unread when nothing pushed that it moved.
 * With the stream off (the default) a delta poll never shows an answer, which
 * UPDATES an old row, so these reads are how an answer arrives: every 5 s
 * while the owner is likely at the card (posted, or a question of it answered,
 * in the last 2 minutes), every 20 s up to 15 minutes, then every 2 minutes.
 * A read is one history page, a 304 when nothing on it moved.
 */
export function askReadIntervalMs(ask: PendingAsk, now: number): number {
  const since = now - Math.max(ask.postedAt, ask.lastAnsweredAt ?? 0)
  if (since < 2 * 60_000) return 5_000
  if (since < 15 * 60_000) return 20_000
  return 2 * 60_000
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
    this.refresh()
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
    ask.lastAnsweredAt = this.now()
    this.save()
    if (isComplete(ask)) return { kind: 'complete', ask }
    return { kind: 'partial', askId, answered: answeredCount(ask), total: ask.questions.length }
  }

  /**
   * A blocking wait owns this group until `untilMs`: a complete group is its
   * result, never an event. Saved, so another daemon of this assistant holds
   * off too; the deadline frees it if this process dies waiting.
   */
  hold(askId: string, untilMs: number): void {
    const ask = this.asks.get(askId)
    if (!ask) return
    this.held.add(askId)
    ask.heldUntil = untilMs
    this.save()
  }

  release(askId: string): void {
    // Merge BEFORE letting go: a merge after would read this hold back off the disk.
    this.refresh()
    this.held.delete(askId)
    const ask = this.asks.get(askId)
    if (ask && ask.heldUntil !== undefined) {
      delete ask.heldUntil
      this.save({ merge: false })
    }
  }

  /** Held by a wait in this process, or by another process's wait that has not reached its deadline. */
  isHeld(askId: string): boolean {
    if (this.held.has(askId)) return true
    const until = this.asks.get(askId)?.heldUntil
    return until !== undefined && until > this.now()
  }

  /** Complete groups nobody holds and nobody delivered yet: what an announce pass offers. */
  completeUndelivered(): PendingAsk[] {
    return this.pending().filter((a) => isComplete(a) && !this.isHeld(a.askId))
  }

  /** Handed to the agent (event or tool result): forget the group for good, across restarts and daemons too. */
  delivered(askId: string): void {
    this.forget(askId)
    this.tombstone(askId)
    this.save()
  }

  wasDelivered(askId: string): boolean {
    return this.delivered_.includes(askId)
  }

  /**
   * The agent retired the card (or it may not be announced here): forget it,
   * a tombstone like a delivery, and hand back its rows so they can be retired too.
   */
  withdraw(askId: string): PendingAsk | null {
    const ask = this.asks.get(askId)
    if (!ask) return null
    this.forget(askId)
    this.tombstone(askId)
    this.save()
    return ask
  }

  /**
   * Read the file again and merge what another daemon of this assistant wrote
   * (a passive session serves ask_user_input too): its groups are adopted, its
   * answers merged (the first kept), its tombstones honoured, and its holds
   * taken as written. Called before every save and every announce pass.
   */
  refresh(): void {
    const disk = this.readFile()
    if (!disk) return
    for (const id of disk.done) this.tombstone(id)
    for (const id of this.delivered_) if (this.asks.has(id)) this.forget(id)
    const cutoff = this.now() - MAX_PENDING_AGE_MS
    for (const raw of disk.pending) {
      if (this.delivered_.includes(raw.askId)) continue
      const mine = this.asks.get(raw.askId)
      if (!mine) {
        if (raw.postedAt < cutoff) {
          this.log(`ask tracker: dropping pending group ${raw.askId}, posted more than 30 days ago`)
          continue
        }
        this.asks.set(raw.askId, raw)
        for (const q of raw.questions) this.byMessage.set(q.messageId, raw.askId)
        continue
      }
      for (const [key, answer] of Object.entries(raw.answers)) {
        if (mine.answers[key] === undefined) mine.answers[key] = answer
      }
      if ((raw.lastAnsweredAt ?? 0) > (mine.lastAnsweredAt ?? 0)) mine.lastAnsweredAt = raw.lastAnsweredAt
      // Another process's hold is as it wrote it; this process's own stands.
      if (!this.held.has(raw.askId)) {
        if (raw.heldUntil === undefined) delete mine.heldUntil
        else mine.heldUntil = raw.heldUntil
      }
    }
  }

  private tombstone(askId: string): void {
    if (!this.delivered_.includes(askId)) this.delivered_.push(askId)
    if (this.delivered_.length > MAX_DELIVERED_REMEMBERED) {
      this.delivered_ = this.delivered_.slice(-MAX_DELIVERED_REMEMBERED)
    }
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

  /**
   * The file as it stands, or null when there is none. One that cannot be read
   * is said and kept aside (`.corrupt-<time>`), never silently overwritten.
   */
  private readFile(): { pending: PendingAsk[]; done: string[] } | null {
    if (!this.filePath || !existsSync(this.filePath)) return null
    let body: { v?: unknown; pending?: unknown; delivered?: unknown } | null = null
    let why = `it is not a version ${FILE_VERSION} file`
    try {
      body = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch (err) {
      body = null
      why = String(err)
    }
    if (!body || typeof body !== 'object' || body.v !== FILE_VERSION) {
      const aside = `${this.filePath}.corrupt-${this.now()}`
      try {
        renameSync(this.filePath, aside)
        this.log(`ask tracker: could not read ${this.filePath} (${why}); kept aside as ${aside}, starting empty`)
      } catch (err) {
        this.log(`ask tracker: could not read ${this.filePath} (${why}) and could not keep it aside as corrupt: ${err}`)
      }
      return null
    }
    return {
      pending: (Array.isArray(body.pending) ? body.pending : []).filter(validAsk),
      done: (Array.isArray(body.delivered) ? body.delivered : []).filter((d): d is string => typeof d === 'string'),
    }
  }

  private save(opts: { merge?: boolean } = {}): void {
    if (!this.filePath) return
    // Merge first: another daemon of this assistant may have written since.
    if (opts.merge !== false) this.refresh()
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
