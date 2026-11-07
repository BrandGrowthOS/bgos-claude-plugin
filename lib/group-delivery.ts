/**
 * Reading a group delivery off any transport (group threads).
 *
 * With the server's group threads on, every delivery of a group's message to
 * an agent whose daemon declared `group_threads` carries the lane stamp
 * `group:<chatId>` and a `groupThread` block (title, level, note, summary,
 * sessionId, state, frame). The socket's inbound_message and inbound_click,
 * the pairing poll and the update stream all carry it, on the record that
 * carries `lane`.
 *
 * groupRouteOf decides, before ownerLaneVerdict, whether a delivery goes to
 * the group lane: only a `group:<chatId>` stamp, only on a daemon that runs
 * group lanes, and only when a `groupThread` block naming the same chat (or
 * none) rides with it. Anything else is left to ownerLaneVerdict, which
 * refuses every stamp but the owner's, exactly as before, so nothing changes
 * for a daemon without the manager.
 *
 * Erasable TypeScript only.
 */

import { statedGroupLevel, groupStampChatId, type GroupBacklogLine, type GroupRosterEntry } from './group-lane-args.ts'
import { readLaneStamp } from './lane-core.mjs'
import { isSessionId } from './thread-lane-args.ts'
import type { GroupDelivery } from './group-lanes.ts'

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/** The first record that carries a lane stamp, and that stamp. */
function stampedRecord(records: readonly unknown[]): { record: Record<string, unknown>; stamp: string } | null {
  for (const r of records) {
    const record = rec(r)
    const stamp = readLaneStamp(record)
    if (record && stamp !== null) return { record, stamp }
  }
  return null
}

/**
 * The group chat a delivery goes to, or null when it is not the group lane's:
 * no `group:` stamp, a daemon without group lanes, or a groupThread block
 * that names another chat (then ownerLaneVerdict refuses it as today).
 */
export function groupRouteOf(records: readonly unknown[], groupLanesOn: boolean): string | null {
  if (!groupLanesOn) return null
  const found = stampedRecord(records)
  if (!found) return null
  const chatId = groupStampChatId(found.stamp)
  if (chatId === null) return null
  const block = rec(found.record.groupThread ?? found.record.group_thread)
  if (block && block.chatId !== undefined && block.chatId !== null && str(block.chatId) !== chatId) return null
  return chatId
}

/** The roster, the seated agents and the backlog of the delivery's group context block. */
function readGroupContext(records: readonly unknown[]): {
  roster: GroupRosterEntry[]
  agents: string[]
  backlog: GroupBacklogLine[]
  mentionedBy: string | null
  title: string
} {
  for (const r of records) {
    const record = rec(r)
    const ctx = rec(record?.groupContext ?? record?.group_context)
    if (!ctx) continue
    const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
    const roster: GroupRosterEntry[] = []
    for (const p of list(ctx.participants)) {
      const x = rec(p)
      const name = str(x?.displayName ?? x?.display_name)
      if (name) roster.push({ name, role: str(x?.relationship) })
    }
    const agents: string[] = []
    for (const a of list(ctx.agents)) {
      const x = rec(a)
      const name = str(x?.name)
      if (name && x?.isYou !== true && x?.is_you !== true) agents.push(name)
    }
    const backlog: GroupBacklogLine[] = []
    for (const m of list(ctx.messages)) {
      const x = rec(m)
      const text = str(x?.text)
      if (text) backlog.push({ sender: str(x?.senderDisplayName ?? x?.sender_display_name), text })
    }
    return {
      roster,
      agents,
      backlog,
      mentionedBy: strOrNull(ctx.mentionedBy ?? ctx.mentioned_by),
      title: str(ctx.chatTitle ?? ctx.chat_title),
    }
  }
  return { roster: [], agents: [], backlog: [], mentionedBy: null, title: '' }
}

/**
 * The group lane's delivery, read off the transport's records (the stamped
 * one first). `key` is the dedupe key across transports: the message id for a
 * message, the message id and the answer for a tap.
 */
export function readGroupDelivery(
  records: readonly unknown[],
  input: { chatId: string; key: string; messageId: unknown; text: string; sender?: string | null; sessionHandle?: unknown },
): GroupDelivery {
  const found = stampedRecord(records)
  const block = rec(found?.record.groupThread ?? found?.record.group_thread) ?? {}
  const ctx = readGroupContext(records)
  const state = str(block.state)
  const id = Number(input.messageId)
  return {
    chatId: input.chatId,
    key: input.key,
    messageId: Number.isSafeInteger(id) && id > 0 ? id : null,
    text: input.text,
    sender: input.sender ?? ctx.mentionedBy,
    sessionHandle: strOrNull(input.sessionHandle),
    title: str(block.title) || ctx.title,
    level: statedGroupLevel(block.level),
    note: strOrNull(block.note),
    summary: strOrNull(block.summary),
    sessionId: isSessionId(block.sessionId) ? block.sessionId : null,
    state: state === 'live' || state === 'paused' ? state : 'new',
    frame: strOrNull(block.frame),
    idlePauseMinutes: typeof block.idlePauseMinutes === 'number' ? block.idlePauseMinutes : null,
    roster: ctx.roster,
    agents: ctx.agents,
    backlog: ctx.backlog,
  }
}

/** A tap in a group, as the short turn line its lane reads. */
export function groupTapLine(input: { tapper: string | null; buttonText: string; customText?: string | null }): string {
  const who = input.tapper && input.tapper.trim() ? input.tapper.trim() : 'Someone'
  const what = input.customText && input.customText.trim() ? `answered "${input.customText.trim()}"` : `pressed "${input.buttonText.trim() || 'a button'}"`
  return `[Button tap in this group] ${who} ${what} on your message.`
}
