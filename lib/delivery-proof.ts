/**
 * Did the messages the server holds reach the session?
 *
 * The idle update's canary (lib/idle-update.mjs isLiveBuild) proves a build to
 * the other agents on its computer, and everything it read before this was
 * about the LOOP: the beacon is touched by the poll tick, a version heartbeat
 * lands, and a deaf verdict needs a delivery that went unanswered. A build whose
 * loop runs and hands no message over passed all of them. This is the one
 * reading tied to a delivery, both ends of it kept apart on purpose:
 *
 *   - what WAITS comes from a read of its own (noteRead), not from the poll. A
 *     poll that drops a row, or moves its cursor past one, would hide exactly
 *     the fault this looks for.
 *   - what was HANDED comes off the write to Claude Code itself (noteHanded),
 *     after every gate and hold in front of it, and only once the write resolved.
 *
 * True on a quiet agent: no traffic means nothing waits, and an agent is never
 * asked to prove anything it was not given. It asks the session nothing and
 * costs no turn. What it cannot see is a session that discards a card it was
 * handed: that write resolves. The deaf verdict reads that once a message owes
 * a reply (docs/idle-update/DESIGN.md Residuals).
 *
 * A false alarm here costs a healthy build a 24 h hold, or a rollback while it
 * validates, so a row counts only when it is plainly a message for the session
 * (isOwedRow), a row left out only means less to go on, and one message gets a
 * grace, with the poll told to read its chat at once.
 */
import { isSelfAuthoredAgentOrigin, type AgentOriginLike } from './inbound-channel.ts'
import { ownerLaneVerdict } from './lane-core.mjs'
import { VERDICT_RE } from './permission-relay.ts'
import { shouldForwardPollMessage } from './poll-core.ts'
import { isSlashCommandPayload } from './slash-catalog.ts'

/** Plenty for an hour of what a daemon settles without handing over; the oldest fall off. */
const SETTLED_MAX = 4096

/** A chat history row, as far as these rules read it. */
export interface DeliveryRowMessage {
  sender?: unknown
  text?: unknown
  messageType?: unknown
  message_type?: unknown
  senderAssistantId?: unknown
  sender_assistant_id?: unknown
  lane?: unknown
}

/**
 * Is this row plainly a message the session is owed? The rows a healthy daemon
 * rightly keeps to itself are left out: its own, the slash commands it answers,
 * a verdict on a permission card, a wake whose body has not landed, a row with
 * no text, a person's lane. While the owner's word is awaited (a permission
 * request) any plain row may be that word, so none counts.
 */
export function isOwedRow(
  message: DeliveryRowMessage,
  agentOrigin: AgentOriginLike | null,
  ctx: { assistantId: string | number; ownerWordAwaited: boolean },
): boolean {
  if (ctx.ownerWordAwaited) return false
  if (message.sender !== 'user' && message.sender !== 'system') return false
  if (typeof message.text !== 'string' || message.text.trim() === '') return false
  if (/^\s*\//.test(message.text) || VERDICT_RE.test(message.text)) return false
  if (isSlashCommandPayload(message as Parameters<typeof isSlashCommandPayload>[0])) return false
  if (!shouldForwardPollMessage(message as Parameters<typeof shouldForwardPollMessage>[0], ctx.assistantId)) return false
  if (isSelfAuthoredAgentOrigin(agentOrigin, ctx.assistantId)) return false
  return ownerLaneVerdict(message).deliver
}

interface ChatProof {
  /** The newest row the read has seen, or null before its first read of this chat. */
  tip: number | null
  /** The newest row handed to the session. */
  handed: number
  /** Message id to when the read first saw it. */
  waiting: Map<number, number>
}

export interface StuckMessage {
  chatId: string
  messageId: number
  waitedMs: number
}

export function createDeliveryProof(opts: { now: () => number; graceMs: number }) {
  const chats = new Map<string, ChatProof>()
  const settled = new Set<number>()

  const chat = (chatId: string): ChatProof => {
    let c = chats.get(chatId)
    if (!c) {
      c = { tip: null, handed: 0, waiting: new Map() }
      chats.set(chatId, c)
    }
    return c
  }

  return {
    /**
     * The read that says what the server holds. The first takes the chat's tip: what was there on arrival is history
     * this boot's poll has its own rules for. After it, what is above the tip, and from just below a message still
     * waiting, so it is read until it is settled. The route refuses an afterId of 0.
     */
    readPath(chatId: string, userId: string): string {
      const base = `chats/${chatId}/messages?userId=${userId}`
      const c = chats.get(chatId)
      if (!c || c.tip === null) return `${base}&limit=1`
      const floor = c.waiting.size > 0 ? Math.min(...c.waiting.keys()) - 1 : c.tip
      return floor > 0 ? `${base}&afterId=${floor}` : base
    },

    /** What that read returned. */
    noteRead(chatId: string, rows: ReadonlyArray<{ id: number; owed: boolean; answer?: boolean }>): void {
      const c = chat(chatId)
      const newest = rows.reduce((max, r) => Math.max(max, r.id), 0)
      if (c.tip === null) {
        c.tip = Math.max(newest, c.handed)
        return
      }
      for (const row of rows) {
        // At or below the tip it has been looked at already, and a route that ignores the cursor adds nothing.
        if (row.id <= c.tip || !row.owed || row.id <= c.handed || settled.has(row.id)) continue
        c.waiting.set(row.id, opts.now())
      }
      c.tip = Math.max(c.tip, newest)
      // The agent's own answer above a message: something handled it, by a path that is not this write.
      const answered = rows.reduce((max, r) => (r.answer === true ? Math.max(max, r.id) : max), 0)
      for (const id of c.waiting.keys()) if (id < answered) c.waiting.delete(id)
    },

    /** The write to the session resolved. A later message through clears an older one: this build delivers. */
    noteHanded(chatId: string, messageId: number): void {
      const c = chat(chatId)
      c.handed = Math.max(c.handed, messageId)
      if (c.tip !== null) c.tip = Math.max(c.tip, messageId)
      for (const id of c.waiting.keys()) if (id <= messageId) c.waiting.delete(id)
    },

    /** The daemon finished with this row itself: its own send, a sign-in code it consumed. */
    noteSettled(messageId: number): void {
      settled.add(messageId)
      if (settled.size > SETTLED_MAX) settled.delete(settled.values().next().value as number)
      for (const c of chats.values()) c.waiting.delete(messageId)
    },

    /** The message that has waited longest, once it has waited past the grace. */
    stuck(): StuckMessage | null {
      const at = opts.now()
      let oldest: StuckMessage | null = null
      for (const [chatId, c] of chats) {
        for (const [messageId, firstSeen] of c.waiting) {
          const waitedMs = at - firstSeen
          if (waitedMs >= opts.graceMs && (!oldest || waitedMs > oldest.waitedMs)) oldest = { chatId, messageId, waitedMs }
        }
      }
      return oldest
    },

    /** The chats with a message waiting, grace or not: the poll reads them now. */
    waitingChats(): string[] {
      return [...chats].filter(([, c]) => c.waiting.size > 0).map(([chatId]) => chatId)
    },

    /** Armed again after standing down: what another holder delivered meanwhile is not this daemon's to answer for. */
    reset(): void {
      chats.clear()
      settled.clear()
    },
  }
}

/** The chat and message a channel card carries, or null for one that names no message. */
export function cardMessage(notification: { method?: string; params?: unknown }): { chatId: string; messageId: number } | null {
  if (notification.method !== 'notifications/claude/channel') return null
  const meta = (notification.params as { meta?: Record<string, unknown> } | undefined)?.meta
  const messageId = Number(meta?.message_id)
  const chatId = meta?.chat_id
  if (!Number.isFinite(messageId) || messageId <= 0 || (typeof chatId !== 'string' && typeof chatId !== 'number') || chatId === '') return null
  return { chatId: String(chatId), messageId }
}
