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
 * NOW. ask_user_input with wait_seconds 0 posts, registers the group here and
 * returns pending (a call with no wait field keeps the old blocking contract,
 * askWaitSeconds). Both transports feed answers in through
 * record(): the stream's buttons_answered entry for a message this tracker
 * owns, the poll's row of one, the blocking wait's own reads, and a reconcile
 * of every pending group on connect. When the last question is answered the
 * group is complete and server.ts announces ONE ask_answered channel event
 * with every answer, unless a blocking wait holds it (hold), in which case the
 * wait returns the answers as the tool result instead. Either way delivered()
 * forgets the group for good.
 *
 * WHOSE. A group belongs to the session that asked it. A pending card is
 * posted only by the daemon holding this agent's connection: a passive
 * session's daemon refuses wait_seconds 0, and its blocking wait retires what
 * is not answered in time, since it could never hand later answers back. Each
 * group carries the process that posted it, and an announce offers a group
 * only to that process, or, once that process has ended, to one that started
 * after the post and did not run beside it (the asker restarted). Whether the
 * asker runs is its LEASE, never its pid alone (Windows hands a dead process's
 * pid to the next one at once): every daemon writes on its own groups that it
 * runs, on the ask tick (heartbeat), and an asker silent for ASK_LEASE_MS has
 * ended. How long it ran beside a daemon is then read off the file, the same
 * for every daemon whenever it looks: from that daemon's start (or the post)
 * to the end of the asker's last lease (ASK_LEASE_SPAN_MS after it, the
 * longest a running asker goes without writing again). Longer than
 * ASK_OWNER_OVERLAP_MS, and the group
 * is marked askerEndedBeside in the file, so no daemon ever announces it. A
 * daemon that was not looking (a sleep, a stalled process) reads no lease as
 * lapsed until the asker has had time to write it again (ASK_TICK_GAP_MS). The
 * asker itself always delivers its own card; another live session's card is
 * never announced as answers here. Review of #282, item 1, its second to
 * fourth reviews, and Data's recheck.
 *
 * RETIRED, NEVER LEFT LIVE. Only the daemon holding the connection can hand
 * answers to a session. A group it may not announce is retired by it, as
 * withdraw_ask retires a card (server.ts retireOrphanedAsks, from
 * retirable()), and its session is told in one ask_withdrawn event:
 *   - a group marked askerEndedBeside;
 *   - an unheld group of a live asker other than this daemon, once seen so for
 *     ASK_LEASE_MS: that asker lost the connection (a channel or route
 *     takeover, or a stale lock after a sleep), runs on passive, and can never
 *     hand an answer to its session;
 *   - a group whose asker ended ASK_ORPHAN_GRACE_MS ago with no restart taking
 *     the connection and the card.
 * Otherwise the card stays live and the owner answers into nothing (Data's
 * recheck of #282, item 1, and its fresh review).
 *
 * EXACTLY ONCE. Within a daemon life the shared announced-click set guards
 * the transports (server.ts rememberAnnouncedClick on every question id of a
 * delivered group); across lives the file does: a delivered group is gone
 * from `pending` and its id is in `delivered`, so a replay of any of its
 * answers is untracked. The file is written after every change by a temp file
 * and a rename, so a crash never leaves half a file.
 *
 * THE FILE IS SHARED, so a read that fails for a moment (another daemon's
 * rename, a virus scanner, a lock on Windows) is tried again and then
 * skipped, and the save that would have followed is skipped too: nothing is
 * written over a file this daemon could not read. Only a file that read in
 * full and does not parse, or has no version or one that is not a number, is
 * kept aside; if it cannot be kept aside it is left as it is. A file of a
 * newer numbered version is left alone (an old and a new plugin side by side
 * in a staged update); this daemon then keeps its groups in memory. While a
 * read keeps failing, each pass tries once. A rename onto a file another
 * process holds open (EPERM on Windows) is tried again before a save is
 * dropped. Review of #282, item 4.
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
/** A read or a rename that fails with one of these is tried again: it passes. */
const TRANSIENT_FS_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'EAGAIN', 'ENOENT'])
/** Pauses between tries, ms: about a third of a second in all, before a read is skipped or a save dropped. */
const FS_RETRY_PAUSES_MS = [20, 40, 80, 160]

/** Wait without giving up the thread (the tracker is synchronous, and a pause is a few ms). */
function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function fsCode(err: unknown): string {
  return String((err as NodeJS.ErrnoException)?.code ?? '')
}

type FileRead =
  | { kind: 'none' }
  | { kind: 'read'; pending: PendingAsk[]; done: string[]; retired: RetiredAsk[] }
  /** Not read this time (a read that kept failing, or another version's file): leave it, write nothing over it. */
  | { kind: 'skip' }

/** The longest wait_seconds may hold a turn, and the wait of a call with no wait field: the tool's old default. */
export const MAX_ASK_WAIT_SECONDS = 600

/**
 * How long one ask_user_input call holds the turn (review of #282, item 3).
 * A call with neither field keeps the contract it always had: it waits up to
 * 600 s and returns the answers. wait_seconds 0 posts and returns pending at
 * once, the answers arriving later as one ask_answered event; above 0 it
 * waits up to that long, capped at 600. timeout_seconds is the older name and
 * keeps its meaning, the upper bound of the wait, uncapped as it always was.
 * When both are given, wait_seconds wins. A number written as a string is
 * read; anything else that is not a number of seconds is refused, never read
 * as 0. Only the tail of a wait changed: one that runs out returns pending,
 * never invented skips.
 */
export function askWaitSeconds(args: Record<string, unknown>): { seconds: number } | { error: string } {
  const wait = readSeconds(args.wait_seconds)
  if (wait === 'refused') {
    return {
      error:
        `Error: wait_seconds must be a number of seconds from 0 to ${MAX_ASK_WAIT_SECONDS} (a larger number ` +
        `waits ${MAX_ASK_WAIT_SECONDS}); got ${shown(args.wait_seconds)}. Nothing was posted.`,
    }
  }
  if (wait !== null) return { seconds: Math.min(wait, MAX_ASK_WAIT_SECONDS) }
  const legacy = readSeconds(args.timeout_seconds)
  if (legacy === 'refused') {
    return { error: `Error: timeout_seconds must be a number of seconds (got ${shown(args.timeout_seconds)}). Nothing was posted.` }
  }
  return { seconds: legacy ?? MAX_ASK_WAIT_SECONDS }
}

/**
 * A wait field as seconds: null when not given, 'refused' when it is not a
 * number of seconds. A string is read only when it is plain digits ("60",
 * "1.5"), so "0x10" or "1e2" is refused rather than read as something the
 * agent did not write.
 */
function readSeconds(value: unknown): number | null | 'refused' {
  if (value === undefined || value === null) return null
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value)
        ? Number(value.trim())
        : Number.NaN
  return Number.isFinite(n) && n >= 0 ? n : 'refused'
}

function shown(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
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

/** The daemon process that posted a group: its pid and when it started, ms since the epoch. */
export interface AskOwner {
  pid: number
  startedAt: number
  /**
   * When that process last wrote here that it runs (its lease, heartbeat), ms
   * since the epoch. Written with the group and then every ASK_LEASE_REFRESH_MS.
   */
  aliveAt?: number
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
  /** Who posted it (askIsOurs). Absent only on a group an earlier build of this branch wrote. */
  owner?: AskOwner
  /**
   * When a daemon found that the asker ran beside its session for longer than
   * ASK_OWNER_OVERLAP_MS and has ended, ms since the epoch. No daemon ever
   * announces the group, that session's own restart included (it cannot be
   * told apart from the asker's); the connected daemon retires it. On disk, so
   * the decision outlives the daemon that made it (third review of #282,
   * Important 2).
   */
  askerEndedBeside?: number
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
      `When every question is answered or skipped, the answers arrive later, together, as ONE ` +
      `ask_answered channel event (meta.ask_id = ${opts.askId}), however late, and that event ` +
      `starts a new turn. That turn is not your owner's own message, so the tools that act for ` +
      `your owner refuse in it: schedule, boards, the browser, email_send and call_owner. ` +
      `If you will need one of them after these answers, call withdraw_ask with this ask_id, then ask ` +
      `again with wait_seconds while your owner is in the chat; or wait for your owner's next message ` +
      `and use the tool in that turn. ` +
      `If you no longer need the answers, call withdraw_ask with this ask_id.`,
  ].join('\n')
}

/**
 * What ask_user_input returns in a passive session's daemon when its wait ran
 * out or was cancelled: no daemon would ever hand the later answers back
 * there, so the questions not answered were retired, and the answers given
 * are the whole result (second review of #282, Important 3). Never pending,
 * never a skip the owner did not give.
 */
export function askWithdrawnText(opts: { ask: PendingAsk; waitedSeconds: number | null; withdrawn: number }): string {
  const { ask } = opts
  const rows = askResultRows(ask).filter((_, i) => ask.answers[String(ask.questions[i].messageId)] !== undefined)
  const open = ask.questions.length - rows.length
  const status = { status: 'withdrawn', ask_id: ask.askId, questions: ask.questions.length, answered: rows.length, answers: rows }
  const lead =
    opts.waitedSeconds !== null
      ? `Not every question was answered within the ${opts.waitedSeconds} s wait.`
      : 'The wait was cancelled before every question was answered.'
  const withdrawn =
    opts.withdrawn >= open
      ? `the ${open} question(s) not answered were withdrawn from the chat.`
      : `${opts.withdrawn} of the ${open} question(s) not answered were withdrawn from the chat; the other ` +
        `${open - opts.withdrawn} may still show there, and an answer to them will not reach you.`
  return [
    JSON.stringify(status, null, 2),
    `${lead} This session is not the one connected to BGOS for this agent, so later answers could never ` +
      `come back here: ${withdrawn} The answers above are all your owner gave; nothing was skipped for your ` +
      `owner. If you still need the rest, ask again from the connected session.`,
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

/**
 * The ONE ask_withdrawn channel event of a card the connected daemon retired
 * because no daemon may hand its answers to the session that asked
 * (retirable): what the owner answered before it was retired, and which
 * questions were withdrawn from the chat. It starts a turn in this session,
 * which may or may not be the one that asked (the asker restarted, or a
 * session beside it), so it says neither and asks for nothing. Every meta
 * value is a string (Data's recheck of #282, item 1; its fresh review, Minor 3).
 * `toAsker`: the same event for the session that asked, still running without
 * the connection when its card was retired (Data's gate notes on #282, item 2).
 */
export function buildAskWithdrawnEvent(
  ask: PendingAsk,
  opts: { assistantId: string; withdrawn: number; ts?: string; toAsker?: boolean },
): { content: string; meta: Record<string, string> } {
  const rows = askResultRows(ask)
  const answered = rows.filter((_, i) => ask.answers[String(ask.questions[i].messageId)] !== undefined)
  const open = ask.questions.filter((q) => ask.answers[String(q.messageId)] === undefined).map((q) => q.text)
  const first = ask.questions[0]?.messageId
  const closed =
    open.length === 0
      ? 'Your owner had answered every question on it.'
      : opts.withdrawn >= open.length
        ? `Its ${open.length} open question(s) were withdrawn from the chat, so your owner can no longer answer them.`
        : `${opts.withdrawn} of its ${open.length} open question(s) were withdrawn from the chat.`
  const lead = opts.toAsker
    ? `[ask_withdrawn] A question card this session posted was retired (ask_id=${ask.askId}): this session no longer ` +
      `holds this agent's connection, so its answers could not come back here, and the session that holds it retired it. ${closed}`
    : `[ask_withdrawn] A question card this agent posted was retired (ask_id=${ask.askId}): the session that asked ` +
      `it can no longer receive the answers (it ended, or it no longer holds this agent's connection). ${closed}`
  const content = [
    lead,
    `(in chat_id=${ask.chatId}, first question message_id=${first})`,
    `Answered before it was retired: ${JSON.stringify(answered, null, 2)}`,
    `Withdrawn: ${JSON.stringify(open)}`,
    opts.toAsker
      ? 'Nothing here needs a reply. If you still need an answer that was withdrawn, ask again with ask_user_input ' +
        'and leave wait_seconds out, so this call waits for the answers: a card that returns pending cannot come back to this session.'
      : 'Nothing here needs a reply. If you still need an answer that was withdrawn, ask again with ask_user_input.',
  ].join('\n')
  return {
    content,
    meta: {
      chat_id: String(ask.chatId),
      message_id: String(first),
      event_type: 'ask_withdrawn',
      ask_id: String(ask.askId),
      answers: JSON.stringify(answered),
      withdrawn: String(opts.withdrawn),
      assistant_id: String(opts.assistantId),
      ts: String(opts.ts ?? new Date().toISOString()),
    },
  }
}

/**
 * How long a group's asker may have run beside a daemon and that daemon still
 * take the group as that session restarted. A restart's new daemon can start
 * a moment before the old one has exited (the CLI respawning its MCP server);
 * a session that ran beside the asker for longer than this is another session
 * (second review of #282, Important 2). The overlap is measured to the end of
 * the asker's last lease (ASK_LEASE_SPAN_MS), which errs long: a session that
 * really ran beside the asker for about 40 s or more may already count as
 * another session.
 */
export const ASK_OWNER_OVERLAP_MS = 60_000

/** How often a daemon writes on its own groups that it runs (the lease; Data's recheck of #282). */
export const ASK_LEASE_REFRESH_MS = 15_000
/** An asker that has not said it runs for this long has ended, whatever process has its pid now: two refreshes and a slow tick. */
export const ASK_LEASE_MS = 2 * ASK_LEASE_REFRESH_MS + 5_000
/**
 * How long a running asker goes without writing its lease again: a refresh
 * and one 5 s ask tick (a tick whose read is skipped can stretch it). A lease says the asker ran until at least this long
 * after it, so how long it ran beside a session is measured to there, never
 * to the lease itself, which can be that much older than the asker's end
 * (Data's gate notes on #282, item 1).
 */
export const ASK_LEASE_SPAN_MS = ASK_LEASE_REFRESH_MS + 5_000
/**
 * A group whose asker ended, ran beside no daemon and was taken by no restart
 * for this long is retired by the connected daemon: a restart that takes the
 * connection in that time takes the card too (Data's recheck of #282, item 1).
 */
export const ASK_ORPHAN_GRACE_MS = 10 * 60_000
/**
 * A daemon looks at the file at least every 5 s (the ask tick). A longer gap
 * between two looks means this process was not running (a sleep, a stalled
 * process), and so were others, maybe: until it has looked without such a gap
 * for ASK_LEASE_MS, it reads no live pid's lease as lapsed (fresh review of
 * Data's recheck of #282, Important 2).
 */
export const ASK_TICK_GAP_MS = 20_000

/** Whether a process with this pid runs now (EPERM: it runs, as another user). */
export function pidIsAlive(pid: number): boolean {
  // 0 and below name a process group, not a process (and read as alive on Windows).
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** When a group's asker last said it runs: its lease, never before the post. */
export function askerLastSaid(ask: PendingAsk): number {
  return Math.max(ask.owner?.aliveAt ?? ask.postedAt, ask.postedAt)
}

function sameProcess(owner: AskOwner | undefined, self: AskOwner): boolean {
  return !!owner && owner.pid === self.pid && owner.startedAt === self.startedAt
}

/**
 * Whether a group's asker, another process, runs now: its pid is alive and it
 * said so within ASK_LEASE_MS. The pid alone is not enough: a dead asker's pid
 * may already be an unrelated process's (Data's recheck of #282). An observer
 * that cannot judge a lease (leaseJudged false: it was not running for a
 * while) takes a live pid's lease as fresh.
 */
export function askerRuns(
  ask: PendingAsk,
  self: AskOwner,
  now: number,
  isAlive: (pid: number) => boolean,
  leaseJudged = true,
): boolean {
  const owner = ask.owner
  if (!owner || sameProcess(owner, self)) return false
  // This process's own pid on a group is an earlier process's, ended.
  if (owner.pid === self.pid) return false
  if (!isAlive(owner.pid)) return false
  return !leaseJudged || now - askerLastSaid(ask) <= ASK_LEASE_MS
}

/**
 * Whether this daemon may hand a group's answers to its session: it posted
 * the group, or the process that did has ended and this one started after
 * the post, so it is that session restarted. A live asker's group is the
 * asker's; one that ran beside this daemon is told by AskTracker.isOurs.
 */
export function askIsOurs(
  ask: PendingAsk,
  self: AskOwner,
  now: number,
  isAlive: (pid: number) => boolean,
  leaseJudged = true,
): boolean {
  if (sameProcess(ask.owner, self)) return true
  if (askerRuns(ask, self, now, isAlive, leaseJudged)) return false
  return self.startedAt > ask.postedAt
}

function isComplete(ask: PendingAsk): boolean {
  return ask.questions.every((q) => ask.answers[String(q.messageId)] !== undefined)
}

function answeredCount(ask: PendingAsk): number {
  return ask.questions.filter((q) => ask.answers[String(q.messageId)] !== undefined).length
}

/**
 * A card the connected daemon retired while its asker still ran (on passive,
 * without the connection), kept on file for that asker to tell its own
 * session (takeRetiredOwn): the group as retired, with what was answered, and
 * how many open questions were withdrawn. Dropped ASK_ORPHAN_GRACE_MS after
 * (Data's gate notes on #282, item 2).
 */
export interface RetiredAsk {
  ask: PendingAsk
  withdrawn: number
  at: number
}

function validRetired(raw: unknown): raw is RetiredAsk {
  const r = raw as Partial<RetiredAsk> | null
  return !!r && typeof r === 'object' && validAsk(r.ask) && typeof r.withdrawn === 'number' && typeof r.at === 'number'
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
    typeof a.answers === 'object' &&
    (a.owner === undefined ||
      (!!a.owner &&
        Number.isSafeInteger(a.owner.pid) &&
        typeof a.owner.startedAt === 'number' &&
        (a.owner.aliveAt === undefined || typeof a.owner.aliveAt === 'number'))) &&
    (a.askerEndedBeside === undefined || typeof a.askerEndedBeside === 'number')
  )
}

export class AskTracker {
  private readonly filePath: string | null
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly self: AskOwner
  private readonly isAlive: (pid: number) => boolean
  private readonly asks = new Map<string, PendingAsk>()
  private readonly byMessage = new Map<number, string>()
  private readonly held = new Set<string>()
  /** Groups withdraw_ask (or the retire of an orphan) is retiring right now: no announce offers them (review of #282, item 2). */
  private readonly withdrawing = new Set<string>()
  /** When this process last looked at the file, and since when without a gap (ASK_TICK_GAP_MS). */
  private lastLookAt: number | null = null
  private lookingSince = Number.NEGATIVE_INFINITY
  /**
   * In the connected daemon: since when each unheld group of a live asker
   * other than this process has been seen so on every retire pass, counted
   * from no earlier than this process's last look gap or its last taking of
   * the connection (retirable).
   */
  private readonly askerAsideSince = new Map<string, number>()
  /** Cards retired while their asker ran, on file (RetiredAsk); and those of this process already handed to its session. */
  private retired_: RetiredAsk[] = []
  private readonly toldRetired = new Set<string>()
  /** Groups dropped for age, said once; and why saves fail, said once while it lasts (fifth review of #282, Minor 3). */
  private readonly droppedForAge = new Set<string>()
  private saveFailing: string | null = null
  private delivered_: string[] = []
  /** The last reason a read was skipped, so a problem that lasts is said once, not every pass. */
  private skipReason: string | null = null

  constructor(opts: {
    filePath: string | null
    now?: () => number
    log?: (line: string) => void
    /** This daemon process (default: this pid, started now). */
    self?: AskOwner
    isAlive?: (pid: number) => boolean
  }) {
    this.filePath = opts.filePath
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (() => {})
    this.self = opts.self ?? { pid: process.pid, startedAt: this.now() }
    this.isAlive = opts.isAlive ?? pidIsAlive
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
      owner: { pid: this.self.pid, startedAt: this.self.startedAt, aliveAt: this.now() },
    }
    this.forget(ask.askId)
    this.asks.set(ask.askId, ask)
    for (const q of ask.questions) this.byMessage.set(q.messageId, ask.askId)
    this.enforceCap()
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

  /**
   * Whether this daemon may hand this group's answers to its session
   * (askIsOurs), with what the file says: a group whose asker ended beside
   * another session (askerEndedBeside) is never anyone's, and while the asker
   * runs, the group is the asker's.
   */
  isOurs(ask: PendingAsk): boolean {
    // The asker itself, alive, delivers its own card whatever another daemon marked.
    if (sameProcess(ask.owner, this.self)) return true
    if (ask.askerEndedBeside !== undefined) return false
    if (this.markIfBeside(ask)) {
      this.save()
      return false
    }
    return askIsOurs(ask, this.self, this.now(), this.isAlive, this.leaseJudged())
  }

  /** askerRuns as this process can judge it now. */
  private askerRunsNow(ask: PendingAsk): boolean {
    return askerRuns(ask, this.self, this.now(), this.isAlive, this.leaseJudged())
  }

  /** Note a look at the file: a gap longer than ASK_TICK_GAP_MS since the last one starts the wait again. */
  private look(): void {
    const now = this.now()
    if (this.lastLookAt !== null && now - this.lastLookAt > ASK_TICK_GAP_MS) {
      this.lookingSince = now
      this.log(`ask tracker: no look at the file for ${Math.round((now - this.lastLookAt) / 1000)} s (a sleep?); no lease is read as lapsed for ${ASK_LEASE_MS / 1000} s`)
    }
    this.lastLookAt = now
  }

  /**
   * Whether this process may read a lapsed lease as an ended asker: it has
   * looked without a gap for ASK_LEASE_MS, so a live asker has had time to
   * write its lease since. After a sleep every process wakes with a stale
   * lease, and the first to look would otherwise take the others for ended
   * (fresh review of Data's recheck of #282, Important 2).
   */
  private leaseJudged(): boolean {
    return this.now() - this.lookingSince >= ASK_LEASE_MS
  }

  /**
   * A group whose asker, another process, has ended and ran beside this
   * process for longer than ASK_OWNER_OVERLAP_MS: from this process's start
   * (or the post, if later) to the end of the asker's last lease
   * (ASK_LEASE_SPAN_MS after it; Data's gate notes on #282, item 1). Read off the file, so
   * every daemon decides it the same whenever it looks, and a restart keeps
   * its card however late the answers come (third review of #282, Critical 1).
   * Marked for every daemon (askerEndedBeside); true when it marked the group.
   */
  private markIfBeside(ask: PendingAsk): boolean {
    if (!ask.owner || ask.askerEndedBeside !== undefined || sameProcess(ask.owner, this.self)) return false
    if (this.askerRunsNow(ask)) return false
    if (askerLastSaid(ask) + ASK_LEASE_SPAN_MS - Math.max(this.self.startedAt, ask.postedAt) <= ASK_OWNER_OVERLAP_MS) return false
    ask.askerEndedBeside = this.now()
    this.log(
      `ask tracker: group ${ask.askId} was posted by another session of this agent that ran beside this one ` +
        'and has ended; its answers are announced by no daemon, and the connected daemon retires the card',
    )
    return true
  }

  /** On every read of the file: mark the groups whose asker has ended beside this process. True when one was marked. */
  private noteOwners(): boolean {
    let marked = false
    for (const ask of this.asks.values()) if (this.markIfBeside(ask)) marked = true
    return marked
  }

  /**
   * Say on this process's own groups that it runs (the lease), at most every
   * ASK_LEASE_REFRESH_MS, after reading the file. Every daemon calls it on the
   * ask tick, armed, passive or draining (server.ts heartbeatAskTracker), so a
   * live asker is never taken for ended, and a dead one is, whoever has its
   * pid (Data's recheck of #282). Nothing else is written: a group another
   * process posted is never written on here.
   */
  heartbeat(): void {
    if (!this.refresh()) return
    const now = this.now()
    let said = false
    for (const ask of this.asks.values()) {
      if (!ask.owner || !sameProcess(ask.owner, this.self)) continue
      // A clock stepped back reads the lease as written in the future: it is
      // written again now, never left until the clock catches up (Data's gate
      // notes on #282, item 3). Measured from the lease itself, not the post:
      // a post the step left in the future would rewrite it every tick
      // (fresh review of the follow-up, Important 1).
      const age = now - (ask.owner.aliveAt ?? ask.postedAt)
      if (age >= 0 && age < ASK_LEASE_REFRESH_MS) continue
      ask.owner = { ...ask.owner, aliveAt: now }
      said = true
    }
    if (said) this.save({ merge: false })
  }

  /**
   * The groups no daemon may announce, for the daemon holding the connection
   * to retire as withdraw_ask does (server.ts retireOrphanedAsks, its only
   * caller, which runs only there):
   *   - marked askerEndedBeside;
   *   - of a live asker other than this process, unheld, seen so on every
   *     pass for ASK_LEASE_MS since the later of this process's last look gap
   *     and `connectedSince` (when it last took the connection): that asker
   *     lost the connection, whatever took it (a channel or route takeover, a
   *     stale lock after a sleep), and runs on passive; the wait lets a lock
   *     that changes hands for a moment, or a passive wait retiring its own
   *     card, settle. Slow passes do not restart it (second fresh review of
   *     the recheck, Minor 2);
   *   - of an ended asker, ASK_ORPHAN_GRACE_MS after its last lease.
   * Never this process's own, a held one, one being withdrawn, or one this
   * daemon may announce (Data's recheck of #282, and its fresh review).
   */
  retirable(connectedSince = Number.NEGATIVE_INFINITY): PendingAsk[] {
    this.look()
    const now = this.now()
    const out: PendingAsk[] = []
    for (const a of this.pending()) {
      const aside = this.askerAsideSince.get(a.askId)
      this.askerAsideSince.delete(a.askId)
      if (sameProcess(a.owner, this.self) || this.isHeld(a.askId) || this.withdrawing.has(a.askId)) continue
      if (this.isOurs(a)) continue
      if (a.askerEndedBeside !== undefined) {
        out.push(a)
      } else if (this.askerRunsNow(a)) {
        const since = Math.max(aside ?? now, this.lookingSince, connectedSince)
        this.askerAsideSince.set(a.askId, since)
        if (now - since >= ASK_LEASE_MS) out.push(a)
      } else if (now - askerLastSaid(a) > ASK_ORPHAN_GRACE_MS) {
        out.push(a)
      }
    }
    return out
  }

  /** Complete groups of this session nobody holds and nobody delivered yet: what an announce pass offers. */
  completeUndelivered(): PendingAsk[] {
    return this.pending().filter(
      (a) => isComplete(a) && !this.isHeld(a.askId) && !this.withdrawing.has(a.askId) && this.isOurs(a),
    )
  }

  /**
   * withdraw_ask has begun retiring this group: from now no announce offers it,
   * so an answer that lands while the rows are being retired is never
   * delivered after the tool said none would be. endWithdraw lets it go again
   * when a row could not be retired (the card stays live and tracked).
   */
  beginWithdraw(askId: string): void {
    this.withdrawing.add(askId)
  }

  endWithdraw(askId: string): void {
    this.withdrawing.delete(askId)
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
   * The connected daemon retired a card no daemon may announce (server.ts
   * retireOrphanedAsks): withdrawn as withdraw does, and, when its asker is
   * another process still running, kept on file for that asker to tell its
   * own session once (takeRetiredOwn). A dead asker leaves nothing (Data's
   * gate notes on #282, item 2). `tellAsker` is the connected daemon's own
   * lane verdict: a card it may not tell its session (a share recipient's
   * chat) is kept for no session, since a passive asker's lane state is as
   * it was when it lost the connection (fresh review of the follow-up,
   * Important 2).
   */
  retire(askId: string, opts: { withdrawn: number; tellAsker: boolean }): PendingAsk | null {
    const ask = this.asks.get(askId)
    if (!ask) return null
    if (opts.tellAsker && ask.owner && !sameProcess(ask.owner, this.self) && this.isAlive(ask.owner.pid)) {
      this.retired_ = this.retired_.filter((r) => r.ask.askId !== askId)
      this.retired_.push({ ask: { ...ask, answers: { ...ask.answers } }, withdrawn: opts.withdrawn, at: this.now() })
    }
    return this.withdraw(askId)
  }

  /**
   * The cards this process posted that the connected daemon retired while it
   * ran on without the connection, each handed out once: for this session's
   * own ask_withdrawn event (server.ts tellRetiredOwnAsks, on the ask tick).
   * Read from the file as last merged; never another process's.
   */
  takeRetiredOwn(): Array<{ ask: PendingAsk; withdrawn: number }> {
    const out: Array<{ ask: PendingAsk; withdrawn: number }> = []
    for (const r of this.retired_) {
      if (!sameProcess(r.ask.owner, this.self) || this.toldRetired.has(r.ask.askId)) continue
      this.toldRetired.add(r.ask.askId)
      this.forget(r.ask.askId)
      out.push({ ask: r.ask, withdrawn: r.withdrawn })
    }
    return out
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
  refresh(): boolean {
    this.look()
    const disk = this.readFile()
    if (disk.kind === 'skip') return false
    if (disk.kind === 'none') return true
    let rewrite = false
    for (const r of disk.retired) if (!this.retired_.some((m) => m.ask.askId === r.ask.askId)) this.retired_.push(r)
    this.retired_ = this.retired_.filter((r) => this.now() - r.at <= ASK_ORPHAN_GRACE_MS).slice(-MAX_PENDING_ASKS)
    for (const id of disk.done) this.tombstone(id)
    for (const id of this.delivered_) if (this.asks.has(id)) this.forget(id)
    const cutoff = this.now() - MAX_PENDING_AGE_MS
    for (const raw of disk.pending) {
      if (this.delivered_.includes(raw.askId)) continue
      const mine = this.asks.get(raw.askId)
      if (!mine) {
        if (raw.postedAt < cutoff) {
          if (!this.droppedForAge.has(raw.askId)) {
            this.droppedForAge.add(raw.askId)
            this.log(`ask tracker: dropping pending group ${raw.askId}, posted more than 30 days ago`)
          }
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
      // The asker's latest lease, never an older one read back over it; but
      // one held here that the clock has not reached yet (a clock stepped
      // back) gives way to the file, so the asker's corrected lease spreads
      // and is never written back over (fresh review of the follow-up,
      // Important 1).
      if (raw.owner && mine.owner && raw.owner.pid === mine.owner.pid && raw.owner.startedAt === mine.owner.startedAt) {
        const theirs = raw.owner.aliveAt
        const held = mine.owner.aliveAt ?? 0
        if (theirs !== undefined && (theirs > held || held > this.now())) mine.owner = { ...mine.owner, aliveAt: theirs }
      }
      if (raw.askerEndedBeside !== undefined && mine.askerEndedBeside === undefined) mine.askerEndedBeside = raw.askerEndedBeside
      // Another daemon's save wrote over the mark: it cannot be read back from
      // the backend, so it is written again (fourth review of #282, Minor 3).
      if (mine.askerEndedBeside !== undefined && raw.askerEndedBeside === undefined) rewrite = true
      // Another process's hold is as it wrote it; this process's own stands.
      if (!this.held.has(raw.askId)) {
        if (raw.heldUntil === undefined) delete mine.heldUntil
        else mine.heldUntil = raw.heldUntil
      }
    }
    const marked = this.noteOwners()
    this.enforceCap()
    // The decision outlives this daemon: written now, not at some later save.
    if (marked || rewrite) this.save({ merge: false })
    return true
  }

  /**
   * At most MAX_PENDING_ASKS groups, the oldest posted going first. A dropped
   * group is a tombstone, so the next merge of the file never brings it back
   * (review of #282, item 6); a later answer to it is not delivered.
   */
  private enforceCap(): void {
    while (this.asks.size > MAX_PENDING_ASKS) {
      let oldest: PendingAsk | null = null
      for (const a of this.asks.values()) if (!oldest || a.postedAt < oldest.postedAt) oldest = a
      if (!oldest) return
      this.log(`ask tracker: dropping the oldest pending group ${oldest.askId} (more than ${MAX_PENDING_ASKS} pending)`)
      this.forget(oldest.askId)
      this.tombstone(oldest.askId)
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
    this.withdrawing.delete(askId)
    this.askerAsideSince.delete(askId)
    for (const q of ask.questions) {
      if (this.byMessage.get(q.messageId) === askId) this.byMessage.delete(q.messageId)
    }
  }

  /**
   * The file as it stands. A read that fails is tried again and then skipped
   * (never kept aside: the next pass reads it); a file of a newer numbered
   * version is left alone. Only a file that read in full and does not parse,
   * or has no usable version, is said and kept aside (`.corrupt-<time>`); one
   * that cannot be kept aside is skipped, never silently overwritten.
   */
  private readFile(): FileRead {
    if (!this.filePath || !existsSync(this.filePath)) return this.readOk({ kind: 'none' })
    let text: string | null = null
    // While a read keeps failing, each pass tries once: the pauses are for a
    // moment's contention, not for a problem that lasts (every save, announce
    // and reconcile pass reads the file).
    const retries = this.skipReason === null ? FS_RETRY_PAUSES_MS.length : 0
    for (let attempt = 0; text === null; attempt++) {
      try {
        text = readFileSync(this.filePath, 'utf8')
      } catch (err) {
        const code = fsCode(err)
        if (TRANSIENT_FS_CODES.has(code) && attempt < retries) {
          pauseSync(FS_RETRY_PAUSES_MS[attempt])
          continue
        }
        // Gone for good between the check and the read: there is no file.
        if (code === 'ENOENT') return this.readOk({ kind: 'none' })
        return this.skip(`could not read ${this.filePath} (${code || err}); left as it is, read again on the next pass`)
      }
    }
    let body: { v?: unknown; pending?: unknown; delivered?: unknown; retired?: unknown } | null = null
    let why = 'it is not a JSON object'
    try {
      body = JSON.parse(text)
    } catch (err) {
      body = null
      why = String(err)
    }
    // Another plugin build's file says a newer version, as a number: left
    // alone below. Anything else that is not this version is not a file this
    // plugin or a newer one wrote, so it is kept aside like a parse failure.
    if (body && typeof body === 'object' && !Array.isArray(body) && body.v !== FILE_VERSION) {
      if (!(typeof body.v === 'number' && body.v > FILE_VERSION)) {
        why = `its version is ${JSON.stringify(body.v)}`
        body = null
      }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      const aside = `${this.filePath}.corrupt-${this.now()}`
      try {
        renameSync(this.filePath, aside)
        this.log(`ask tracker: could not read ${this.filePath} (${why}); kept aside as ${aside}, starting empty`)
      } catch (err) {
        // Not kept aside: left as it is, and never written over (read again on the next pass).
        return this.skip(`could not read ${this.filePath} (${why}) and could not keep it aside as corrupt (${fsCode(err) || err}); left as it is`)
      }
      return this.readOk({ kind: 'none' })
    }
    if (body.v !== FILE_VERSION) {
      return this.skip(
        `${this.filePath} is a version ${JSON.stringify(body.v)} file (this plugin writes version ${FILE_VERSION}), ` +
          'from another plugin build; left alone, and this daemon keeps its cards in memory',
      )
    }
    return this.readOk({
      kind: 'read',
      pending: (Array.isArray(body.pending) ? body.pending : []).filter(validAsk),
      done: (Array.isArray(body.delivered) ? body.delivered : []).filter((d): d is string => typeof d === 'string'),
      retired: (Array.isArray(body.retired) ? body.retired : []).filter(validRetired),
    })
  }

  private readOk(result: FileRead): FileRead {
    if (this.skipReason !== null) this.log('ask tracker: the file reads again')
    this.skipReason = null
    return result
  }

  private skip(reason: string): FileRead {
    if (reason !== this.skipReason) this.log(`ask tracker: ${reason}`)
    this.skipReason = reason
    return { kind: 'skip' }
  }

  private save(opts: { merge?: boolean } = {}): void {
    if (!this.filePath) return
    // Merge first: another daemon of this assistant may have written since.
    // A file that could not be read this time is not written over.
    if (opts.merge !== false ? !this.refresh() : this.skipReason !== null) return
    const tmp = `${this.filePath}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(
        tmp,
        JSON.stringify({
          v: FILE_VERSION,
          pending: this.pending(),
          delivered: this.delivered_,
          ...(this.retired_.length > 0 ? { retired: this.retired_ } : {}),
        }),
        { mode: 0o600 },
      )
      // While saves keep failing, each pass tries once, as reads do.
      const retries = this.saveFailing === null ? FS_RETRY_PAUSES_MS.length : 0
      for (let attempt = 0; ; attempt++) {
        try {
          renameSync(tmp, this.filePath)
          break
        } catch (err) {
          // Windows: the target held open by another process (a reader, a scanner) passes.
          if (!TRANSIENT_FS_CODES.has(fsCode(err)) || attempt >= retries) throw err
          pauseSync(FS_RETRY_PAUSES_MS[attempt])
        }
      }
      if (this.saveFailing !== null) this.log('ask tracker: the file saves again')
      this.saveFailing = null
    } catch (err) {
      try {
        unlinkSync(tmp)
      } catch {
        /* never existed */
      }
      const why = fsCode(err) || String(err)
      if (why !== this.saveFailing) this.log(`ask tracker: could not save ${this.filePath}: ${err}`)
      this.saveFailing = why
    }
  }
}
