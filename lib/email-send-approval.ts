// ── Always ask stops a send: the owner's card for email_send ────────────────
//
// Data, 2026-10-13 (HOAI 2dd04488, outgoing email modes): when the owner chose
// "Always ask before risky actions", email_send asks through the normal
// approval path before anything is sent, every time, with the recipient, the
// subject and the first lines visible to the owner. email_draft is not a send
// and never asks.
//
// The normal path is the hard floor's. lib/hard-floor-core.mjs lists this
// channel's own email_send (HOAI_OWN_SENDING_TOOLS), so the floor hook asks,
// the CLI raises a permission request, the relay asks the server's floor check
// and, with the switch on, holds the card for the owner (server.ts
// settleFloorRequest). This file is the two things that path did not have:
//
//  - THE CARD. An MCP tool's card is `<tool_name> <input_preview>`, and the
//    CLI renders the arguments in the order the model wrote them, so a long
//    text written first pushed the recipient and the subject past the card's
//    2000 character cap. emailSendCardTool puts them first, in a fixed order,
//    and emailSendCardText makes the card's words the email itself.
//  - THE BACKSTOP. The floor hook fails open (a crash, its budget, a session
//    with no attached marker), and then no card is ever raised. So before the
//    daemon posts a send it needs the owner's Allow of THIS call on a card
//    (createEmailSendApprovals: the relay records it, the tool takes it, once,
//    within two minutes, matched against what the card showed), or the
//    server's word, from the same floor check route, that the owner does not
//    ask first, from a server whose list holds email_send (rules version 3).
//    Anything else sends nothing (emailSendFloorRefusal).
//
// THE SERVER IS THE GATE (Data, 2026-10-13, wire-shapes.md "Server approval
// for a send"). While Always ask is on, the send route sends only with a
// single use approval that the owner's own tap on that exact email's card
// issued. So the held card carries `approvalMeta.email_send`, the binding
// the tap approves (emailSendCardBinding, from the hook's record when it
// pairs, lib/email-send-binding.mjs); the tap's approval {id, expiresAt}
// rides on the answer the daemon already reads (readEmailSendApprovalClick,
// answeredEmailSendApproval), or comes from the pull route when the daemon
// missed it (readEmailSendApprovalPull); and the Allow keeps it for the one
// send it allowed (claim, spend). The daemon check above stays as the
// backstop for a send no card allowed.
//
// Pure: no network, no env, no clock but the injected one.
// No em or en dashes anywhere in this file (project copy rule).

import {
  HARD_FLOOR_RULES_VERSION,
  PREVIEW_ELISION_RE,
  hardFloorWords,
  isOwnSendingTool,
  type HardFloorMatch,
} from './hard-floor.js'
import { bindingMatchesCall, emailSendBinding, isEmailSendBlock } from './email-send-binding.mjs'
import { floorRecordProbeFits } from './floor-state.mjs'

/**
 * The first rules version whose list holds the channel's own email_send. A
 * floor check answer of "not held" from a server below it is about a list
 * that never asks before a send, so it lets nothing go.
 */
export const EMAIL_SEND_FLOOR_MIN_RULES_VERSION = 3

/**
 * The name the daemon asks the floor check about for a send no card allowed:
 * the channel's standalone server name (HOAI_OWN_SERVERS), which the server's
 * list reads exactly as it reads the plugin install's name.
 */
export const EMAIL_SEND_FLOOR_TOOL = 'mcp__bgos__email_send'

/** The match that floor check names: the rule the owner's card would carry. */
export const EMAIL_SEND_FLOOR_MATCH: HardFloorMatch = {
  ruleId: 'acts_on_owners_behalf',
  rulesVersion: HARD_FLOOR_RULES_VERSION,
  words: hardFloorWords('acts_on_owners_behalf') ?? '',
  evidence: EMAIL_SEND_FLOOR_TOOL,
}

/** How long the owner's Allow waits for the call it allowed: the CLI runs the tool as soon as it hears the verdict. */
export const EMAIL_SEND_APPROVAL_TTL_MS = 2 * 60_000

/** At most this many Allows wait at once. */
const MAX_WAITING = 16

/** How much of the email the card's words show (the card's command field shows up to its own cap). */
export const EMAIL_CARD_LINES = 8
export const EMAIL_CARD_CHARS = 800

export const EMAIL_SEND_HELD_REFUSAL =
  'email_send did not start: your owner asks before every email is sent (Always ask), and this send did not ' +
  'come through their approval, so nothing was sent. Save it with email_draft and tell your owner it is waiting.'

export const EMAIL_SEND_UNCHECKED_REFUSAL =
  'email_send did not start: HOAI could not check whether your owner asks before every send, so nothing was ' +
  'sent. Save it with email_draft and tell your owner.'

/** The email's fields as a permission request's preview shows them. */
export interface EmailSendPreview {
  to?: string
  subject?: string
  email_id?: string
  text?: string
}

/** The tool's four arguments, in the order the card shows them. */
const EMAIL_FIELDS = ['to', 'subject', 'email_id', 'text'] as const

/**
 * The CLI's cut of a long value (truncateForPreview, Claude Code 2.1.281): a
 * value over 3500 code points keeps its first 2000 and its last 1500, with a
 * line naming how many it left out. The same line as PREVIEW_ELISION_RE, with
 * the count.
 */
const CLI_CUT = /\n\u22EF (\d+) code points? elided \u22EF\n/
const CLI_CUT_HEAD = 2000
const CLI_CUT_TAIL = 1500

/**
 * What a card shows by name, never invisibly: control characters, and the
 * bidi and zero width marks that can make an address or a sentence read as
 * something else. Line breaks and tabs stay.
 */
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g

const shown = (value: string): string =>
  value.replace(HIDDEN, (ch) => `[U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`)

/** The value as the tool sends it (an address, a subject and an id are trimmed), as the card shows it. */
const shownField = (key: (typeof EMAIL_FIELDS)[number], value: string): string =>
  shown(key === 'text' ? value : value.trim())

const isEmailField = (key: string): key is (typeof EMAIL_FIELDS)[number] =>
  (EMAIL_FIELDS as readonly string[]).includes(key)

/**
 * The CLI's cut puts raw line breaks inside a JSON string, which no longer
 * parses: escape the control characters inside strings only, so a preview
 * printed over several lines still reads.
 */
function escapeControlsInStrings(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (!inString) {
      if (ch === '"') inString = true
      out += ch
    } else if (escaped) {
      escaped = false
      out += ch
    } else if (ch === '\\') {
      escaped = true
      out += ch
    } else if (ch === '"') {
      inString = false
      out += ch
    } else {
      out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : ch
    }
  }
  return out
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * The arguments a permission request's preview renders, as the JSON object
 * the CLI wrote, or null when it is not one. The CLI cuts a value over 3500
 * code points in the middle with a line of its own (PREVIEW_ELISION_RE),
 * whose raw line breaks are escaped here so the object still parses; the cut
 * stays in the value.
 */
export function parsePreviewObject(inputPreview: unknown): Record<string, unknown> | null {
  const text = typeof inputPreview === 'string' ? inputPreview.trim() : ''
  if (!text.startsWith('{')) return null
  return parseObject(text) ?? parseObject(escapeControlsInStrings(text))
}

/**
 * The email an email_send preview carries, or null when it is not one: a JSON
 * object whose every key is one of the tool's four, each a string (a null is
 * an argument left out), with a text and a recipient or an email to answer.
 * Anything else (another key, a preview that is not the object) is not read
 * as an email.
 */
export function readEmailSendPreview(inputPreview: unknown): EmailSendPreview | null {
  const record = parsePreviewObject(inputPreview)
  if (!record) return null
  const email: EmailSendPreview = {}
  for (const [key, value] of Object.entries(record)) {
    if (value === null) continue
    if (!isEmailField(key) || typeof value !== 'string') return null
    email[key] = value
  }
  return email.text !== undefined && (email.to !== undefined || email.email_id !== undefined) ? email : null
}

/**
 * The card's `approval_meta.tool` for this channel's email_send: the tool's
 * own name first (the server's card reader reads the first word, so it stamps
 * the floor), then the email's fields as JSON in a fixed order, the recipient
 * (or the email a reply answers) and the subject before the text, so the cap
 * never hides them. Null for any other tool, or a preview that is not an
 * email: the relay then shows it as it shows any MCP tool.
 */
export function emailSendCardTool(toolName: string, inputPreview: unknown): string | null {
  if (!isOwnSendingTool(toolName)) return null
  const email = readEmailSendPreview(inputPreview)
  if (!email) return null
  const ordered: EmailSendPreview = {}
  for (const key of EMAIL_FIELDS) if (email[key] !== undefined) ordered[key] = shownField(key, email[key]!)
  return `${toolName} ${JSON.stringify(ordered)}`
}

/** The email's first lines for the card's words, with `...` where they stop. */
function firstLines(text: string): string {
  const cut = PREVIEW_ELISION_RE.exec(text)
  const whole = (cut ? text.slice(0, cut.index) : text).replace(/\r\n?/g, '\n').trim()
  const lines = whole.split('\n').slice(0, EMAIL_CARD_LINES).join('\n')
  const shown = lines.length > EMAIL_CARD_CHARS ? lines.slice(0, EMAIL_CARD_CHARS).trimEnd() : lines
  return shown.length < whole.length || cut ? `${shown}\n...` : shown
}

/**
 * The card's words for this channel's email_send: the question, the recipient
 * and the subject, then the first lines of the email. A reply's recipient and
 * subject are those of the email it answers, which only the server reads (the
 * agent's view and the delivered turn carry no address and no subject), so the
 * card says it is a reply. Null for any other tool, or a preview that is not
 * an email.
 */
export function emailSendCardText(toolName: string, inputPreview: unknown): string | null {
  if (!isOwnSendingTool(toolName)) return null
  const email = readEmailSendPreview(inputPreview)
  if (!email) return null
  const lines = [email.to !== undefined ? `Send this email to ${shownField('to', email.to)}?` : 'Send this reply to an email I received?']
  if (email.subject !== undefined) lines.push(`Subject: ${shownField('subject', email.subject)}`)
  const body = firstLines(shown(email.text ?? ''))
  if (body) lines.push('', body)
  return lines.join('\n')
}

/**
 * Does this call carry exactly the email the owner's card showed? Every
 * field the same (a null is an argument left out), and a text the CLI cut in
 * the middle matched by the CLI's own cut: its first 2000 and last 1500 code
 * points, and as many left out as the cut line says. A cut line that does not
 * have that shape is part of the text, which must then be the same.
 */
export function emailMatchesPreview(email: EmailSendPreview, args: unknown): boolean {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false
  const call = args as Record<string, unknown>
  for (const key of Object.keys(call)) if (!isEmailField(key)) return false
  for (const key of ['to', 'subject', 'email_id'] as const) {
    const value = call[key] === null ? undefined : call[key]
    if (value !== email[key]) return false
  }
  const text = call.text
  if (typeof text !== 'string' || email.text === undefined) return false
  const cut = CLI_CUT.exec(email.text)
  if (cut) {
    const head = Array.from(email.text.slice(0, cut.index))
    const tail = Array.from(email.text.slice(cut.index + cut[0].length))
    const points = Array.from(text)
    if (head.length === CLI_CUT_HEAD && tail.length === CLI_CUT_TAIL && points.length === CLI_CUT_HEAD + Number(cut[1]) + CLI_CUT_TAIL) {
      return points.slice(0, CLI_CUT_HEAD).join('') === head.join('') && points.slice(-CLI_CUT_TAIL).join('') === tail.join('')
    }
  }
  return text === email.text
}

/**
 * The most of a body a card shows, in characters (Unicode code points, as the
 * server counts them). Wire shapes v7: a body longer than this is never
 * approvable on a card (no Allow, no approval), and its send keeps a draft.
 */
export const EMAIL_SEND_CARD_TEXT_MAX = 1000

/** Is this body too long for the owner to approve on a card (v7)? */
export function emailSendTooLongForCard(text: string): boolean {
  return Array.from(String(text ?? '')).length > EMAIL_SEND_CARD_TEXT_MAX
}

/**
 * Is this held email_send too long to approve on a card (v7)? By its exact
 * body when the card has one (the hook's record); else by the CLI's preview,
 * which, without the line the CLI writes where it cut, is never longer than
 * the body (the CLI only folds runs of whitespace, and cuts out of a value
 * over 3500), so a preview text over 1000 characters proves the body is. A
 * shorter preview proves nothing: no.
 */
export function emailSendCardTooLong(block: EmailSendBlock | null, inputPreview: unknown): boolean {
  if (block) return emailSendTooLongForCard(block.text)
  const text = readEmailSendPreview(inputPreview)?.text
  return typeof text === 'string' && emailSendTooLongForCard(text.replace(PREVIEW_ELISION_RE, ''))
}

/** The binding a held card names (section 1 of the server approval contract), in its wire shape. */
export type EmailSendBlock =
  | { to: string; subject: string; text: string; body_sha256: string; text_preview: string }
  | { email_id: string; text: string; body_sha256: string; text_preview: string }

/** The approval an owner's Allow once tap issued (section 3): its id and when it expires. */
export interface EmailSendApprovalClick {
  id: string
  expiresAt: string
}

/** A uuid as the server's IsUUID() reads one (version 1 to 8, variant 8 to b, or the nil and max ids). */
const APPROVAL_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|0{8}-0{4}-0{4}-0{4}-0{12}|f{8}-f{4}-f{4}-f{4}-f{12})$/i

/**
 * The approval an answer or a pull carries, or null: a plain object with a
 * uuid `id` and a date `expiresAt`, copied as exactly those two, so nothing
 * else ever rides along and nothing is ever made up. Its expiry is the
 * server's to judge (its own clock): the daemon only reads it.
 */
export function readEmailSendApprovalClick(raw: unknown): EmailSendApprovalClick | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { id, expiresAt } = raw as Record<string, unknown>
  if (typeof id !== 'string' || !APPROVAL_ID.test(id)) return null
  if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) return null
  return { id, expiresAt }
}

/**
 * The approval on an answered card row (the card read in waitForVerdict, and
 * the stored answer of section 3c), or null when the card is unanswered or
 * names none.
 */
export function answeredEmailSendApproval(row: unknown): EmailSendApprovalClick | null {
  if (row === null || typeof row !== 'object') return null
  const r = row as { answeredAt?: unknown; answerPayload?: unknown }
  if (typeof r.answeredAt !== 'string' || r.answeredAt === '') return null
  const payload = r.answerPayload
  if (payload === null || typeof payload !== 'object') return null
  return readEmailSendApprovalClick((payload as Record<string, unknown>).emailSendApproval)
}

/** The pull route's answer (section 3b): a 200 carrying the approval, else none. */
export function readEmailSendApprovalPull(response: { status: number; text: string }): EmailSendApprovalClick | null {
  if (Number(response?.status) !== 200) return null
  try {
    return readEmailSendApprovalClick(JSON.parse(String(response.text ?? '')))
  } catch {
    return null
  }
}

/** A field as two writers render it: whitespace folded (the CLI folds runs of it), ends trimmed. */
const folded = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')

/**
 * Does the record's raw start agree with the start of the text the request
 * shows (whitespace folded on both sides, the CLI's cut taken out)? With the
 * probe of the text's ends, this pairs a record with its own request, in any
 * script, and never with another email that only shares its first and last
 * words.
 */
function startAgrees(textPreview: string, previewText: string): boolean {
  const head = folded(previewText.split(PREVIEW_ELISION_RE)[0] ?? '')
  const start = folded(textPreview)
  if (head.length >= start.length) return head.startsWith(start)
  // A preview whose head is shorter than the record's start (escapes take room in the CLI's cut).
  return head.length >= 500 && start.startsWith(head)
}

/**
 * Does this call carry the email the card the owner allowed showed? Field by
 * field, whitespace folded the way the CLI folds the preview, and a text the
 * CLI cut by the head and the tail it kept. The check that the call is the
 * one whose card was tapped; the exact text is the binding's to check.
 */
function previewMatchesCall(email: EmailSendPreview, args: unknown): boolean {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false
  const call = args as Record<string, unknown>
  for (const key of Object.keys(call)) if (!isEmailField(key)) return false
  for (const key of ['to', 'subject', 'email_id'] as const) {
    const value = call[key] === null || call[key] === undefined ? undefined : call[key]
    if ((value === undefined) !== (email[key] === undefined)) return false
    if (value !== undefined && folded(value) !== folded(email[key])) return false
  }
  if (typeof call.text !== 'string' || email.text === undefined) return false
  const text = folded(call.text)
  const parts = email.text.split(PREVIEW_ELISION_RE)
  if (parts.length === 1) return text === folded(email.text)
  return text.startsWith(folded(parts[0])) && text.endsWith(folded(parts[parts.length - 1]))
}

/** What the card names besides the text: the address and subject, or the email, as both copies say it. */
function sameTarget(block: EmailSendBlock, email: EmailSendPreview): boolean {
  if ('email_id' in block) {
    return email.to === undefined && email.subject === undefined && folded(email.email_id).toLowerCase() === block.email_id.toLowerCase()
  }
  return email.email_id === undefined && folded(email.to) === folded(block.to) && folded(email.subject) === folded(block.subject)
}

/**
 * The binding a held email_send card names, and where it came from: the
 * hook's record, when it is a well formed binding whose hash names its own
 * body, the record's probe confirms it was written for THIS request (not an
 * older call that never asked), its start agrees with the request's text, and
 * its address, subject or email agree with the preview's. Else none: the card
 * goes without one, the server makes it deny only, and the email stays a
 * draft. Never the CLI's preview: v6 puts the exact body on the card
 * (`text`), and a preview the CLI folded or cut is not it, so a guessed body
 * is never sent.
 * `refusal` is the tool's own check (its arguments and secrets) over all the
 * card would carry, the whole body included, since the server receives it:
 * when it refuses, nothing may reach the card, and `refused` says why (the
 * CLI can redact a secret out of the preview that the record still holds).
 */
export function emailSendCardBinding(input: {
  toolName: string
  inputPreview: unknown
  record: unknown
  refusal: (fields: Record<string, string>) => string | null
}): { block: EmailSendBlock | null; source: 'record' | null; refused?: string } {
  const none = { block: null, source: null } as const
  if (!isOwnSendingTool(input.toolName)) return none
  const preview = readEmailSendPreview(input.inputPreview)
  if (!preview) return none
  const record = input.record as { emailSend?: unknown } | null
  const fromRecord =
    record && isEmailSendBlock(record.emailSend) && floorRecordProbeFits(record, input.toolName, input.inputPreview)
      ? (record.emailSend as EmailSendBlock)
      : null
  const chosen: { block: EmailSendBlock; source: 'record' } | null =
    fromRecord && sameTarget(fromRecord, preview) && preview.text !== undefined && startAgrees(fromRecord.text_preview, preview.text)
      ? { block: fromRecord, source: 'record' }
      : null
  if (!chosen) return none
  const shown: Record<string, string> =
    'email_id' in chosen.block
      ? { email_id: chosen.block.email_id, text: chosen.block.text }
      : { to: chosen.block.to, subject: chosen.block.subject, text: chosen.block.text }
  const refused = input.refusal(shown)
  if (refused) return { block: null, source: null, refused }
  return chosen
}

/**
 * The chat a held email_send card goes to. Only a card in the agent's own
 * main chat with its owner can carry an Allow (section 2), and a card
 * anywhere else would show the email's start to everyone in that chat for a
 * send that can never go. So: the chat of the turn the owner opened, when it
 * is one of the agent's main chats (`main`, from the inbox); else the first
 * main chat this daemon may post in; and when no chat kinds are known at all
 * (an older inbox), none. Undefined means no main chat of the owner can take
 * the card: the relay then posts it nowhere and refuses the call (Data,
 * 2026-10-15, fail closed). It never falls back to the default pick, nor to
 * the turn chat when no chat kinds are known, since either can be a group and
 * the card carries the whole email.
 *
 * `ownership` (shared agents Phase 0, item 0.8, lib/chat-ownership.ts), as
 * pickPermissionChat reads it: on a shared agent every recipient has a main
 * chat of their own, so a chat known to be somebody else's is never picked,
 * and of the main chats the owner's own come first, most recently confirmed
 * first. Without it, or with no evidence, the pick is exactly what it was.
 */
export function emailSendCardChat(input: {
  turn: { actingUserId?: unknown; chatId?: unknown } | null
  ownerUserId: string
  monitored: readonly string[]
  main: readonly string[]
  refused: ReadonlyArray<{ has(chatId: string): boolean }>
  ownership?: { ownerChats(): string[]; isOthers(chatId: string): boolean } | null
}): string | undefined {
  const ownership = input.ownership ?? null
  const usable = (chatId: string) =>
    chatId !== '' && input.monitored.includes(chatId) && !input.refused.some((set) => set.has(chatId)) &&
    !(ownership?.isOthers(chatId) ?? false)
  const turn = input.turn
  const turnChat =
    turn && typeof turn.actingUserId === 'string' && turn.actingUserId === input.ownerUserId ? String(turn.chatId ?? '') : ''
  if (input.main.includes(turnChat) && usable(turnChat)) return turnChat
  const owners = ownership ? ownership.ownerChats().filter((chatId) => input.main.includes(chatId)) : []
  return owners.find(usable) ?? input.main.find(usable)
}

/** What the relay keeps with an owner's Allow: the card, the tap's approval, the binding the card named. */
export interface EmailSendGrant {
  requestId: string | null
  approval: EmailSendApprovalClick | null
  binding: EmailSendBlock | null
  /**
   * v7: the body is too long to approve on a card, so the relay posted none
   * and let the send through to the server, which keeps it as a draft. Set
   * only when true, and only for a call over 1000 characters: one its
   * binding names, or, with no binding (no hook record), one its preview
   * showed. It never carries an approval.
   */
  tooLongForCard?: true
  /**
   * Data, 2026-10-14 06:43Z: no card was posted because no floor hook record
   * names the email (a card without its exact body could only be denied); the
   * send goes to the server, which keeps it as a draft. Never with a binding,
   * never with an approval.
   */
  withoutCard?: true
  /**
   * Data, 2026-10-15: no main chat of the owner could take the card, so none
   * was posted anywhere and the call is refused at the tool step, sending and
   * saving nothing (EMAIL_SEND_NO_OWNER_CHAT). Never with an approval.
   */
  noOwnerChat?: true
}

export interface EmailSendApprovals {
  /**
   * The relay heard the owner allow a card: remember it when the card was
   * this channel's email_send, with what the card and the tap carried.
   */
  allow(toolName: string, inputPreview: unknown, grant?: Partial<EmailSendGrant>): boolean
  /**
   * The tool is about to send: the unused Allow of the card that showed this
   * call, taken once, or null. Its approval and binding come back only when
   * the binding names this call to the byte (its hash), and the approval only
   * the first time that id is handed out; otherwise both are null and the
   * send goes without one.
   */
  claim(args: unknown): EmailSendGrant | null
  /** claim, as a yes or no. */
  take(args: unknown): boolean
  /** An approval about to go on a send: itself the first time, null ever after (one approval, one send). */
  spend(approval: EmailSendApprovalClick | null): EmailSendApprovalClick | null
  /**
   * v7: has the server already kept this very email (its recipient, subject
   * or email, and text) as a draft too long to approve on a card? Then an
   * agent that tries again saves no second one.
   */
  keptTooLong(args: unknown): boolean
  /** What the send route answered for this call: a `too_long_to_approve` draft is remembered (keptTooLong). */
  noteSendAnswer(args: unknown, answer: unknown): void
}

/** How many approval ids the store remembers handing out. */
const MAX_SPENT = 256

/**
 * The owner's Allows of email_send cards, each good for the one call it
 * allowed, once, within EMAIL_SEND_APPROVAL_TTL_MS. In memory only: an Allow
 * never outlives this daemon, and a send after a restart asks again.
 */
export function createEmailSendApprovals(
  { now = Date.now, ttlMs = EMAIL_SEND_APPROVAL_TTL_MS }: { now?: () => number; ttlMs?: number } = {},
): EmailSendApprovals {
  let waiting: Array<{ at: number; email: EmailSendPreview; grant: EmailSendGrant }> = []
  const spent = new Set<string>()
  const keptTooLong = new Set<string>()
  // One email: where it goes (the address as the server compares it, the subject, or the email) and its text.
  const emailKey = (args: unknown): string | null => {
    const b = emailSendBinding(EMAIL_SEND_FLOOR_TOOL, args) as Record<string, string> | null
    return b ? JSON.stringify([b.to?.toLowerCase() ?? null, b.subject ?? null, b.email_id?.toLowerCase() ?? null, b.body_sha256]) : null
  }
  const dropStale = () => {
    const at = now()
    waiting = waiting.filter((entry) => at - entry.at <= ttlMs)
  }
  const spend = (approval: EmailSendApprovalClick | null): EmailSendApprovalClick | null => {
    const fresh = readEmailSendApprovalClick(approval)
    if (!fresh || spent.has(fresh.id)) return null
    spent.add(fresh.id)
    while (spent.size > MAX_SPENT) spent.delete(spent.values().next().value as string)
    return fresh
  }
  // The call must be the one whose card was allowed: for a card that named a
  // binding, or a too long one that no card showed (it never carries an
  // approval), its preview read the way the CLI folds it; for one that named
  // none, the preview exactly (as before). Then the approval goes only with a
  // call its binding names to the byte; otherwise the send goes without it,
  // and while Always ask is on the server keeps it as a draft.
  const allowedCard = (entry: { email: EmailSendPreview; grant: EmailSendGrant }, args: unknown) =>
    entry.grant.binding || entry.grant.tooLongForCard || entry.grant.withoutCard || entry.grant.noOwnerChat
      ? previewMatchesCall(entry.email, args)
      : emailMatchesPreview(entry.email, args)
  const claim = (args: unknown): EmailSendGrant | null => {
    dropStale()
    let index = waiting.findIndex((entry) => allowedCard(entry, args) && entry.grant.binding !== null && bindingMatchesCall(entry.grant.binding, args))
    if (index < 0) index = waiting.findIndex((entry) => allowedCard(entry, args))
    if (index < 0) return null
    const [entry] = waiting.splice(index, 1)
    const bound = entry!.grant.binding !== null && bindingMatchesCall(entry!.grant.binding, args)
    // Too long by its binding, or, with none, by the call itself (whose preview showed over 1000).
    const tooLong =
      entry!.grant.tooLongForCard === true &&
      (bound || (entry!.grant.binding === null && emailSendTooLongForCard(String((args as { text?: unknown }).text ?? ''))))
    return {
      requestId: entry!.grant.requestId,
      approval: bound && !entry!.grant.tooLongForCard && !entry!.grant.noOwnerChat ? spend(entry!.grant.approval) : null,
      binding: bound ? entry!.grant.binding : null,
      ...(tooLong ? { tooLongForCard: true as const } : {}),
      ...(entry!.grant.withoutCard ? { withoutCard: true as const } : {}),
      ...(entry!.grant.noOwnerChat ? { noOwnerChat: true as const } : {}),
    }
  }
  return {
    allow(toolName, inputPreview, grant = {}) {
      if (!isOwnSendingTool(toolName)) return false
      const email = readEmailSendPreview(inputPreview)
      if (!email) return false
      dropStale()
      waiting.push({
        at: now(),
        email,
        grant: {
          requestId: typeof grant.requestId === 'string' && grant.requestId !== '' ? grant.requestId : null,
          approval: readEmailSendApprovalClick(grant.approval),
          binding: isEmailSendBlock(grant.binding) ? (grant.binding as EmailSendBlock) : null,
          ...(grant.tooLongForCard === true ? { tooLongForCard: true as const } : {}),
          ...(grant.withoutCard === true && !isEmailSendBlock(grant.binding) ? { withoutCard: true as const } : {}),
          ...(grant.noOwnerChat === true ? { noOwnerChat: true as const } : {}),
        },
      })
      while (waiting.length > MAX_WAITING) waiting.shift()
      return true
    },
    claim,
    take: (args) => claim(args) !== null,
    spend,
    keptTooLong(args) {
      const key = emailKey(args)
      return key !== null && keptTooLong.has(key)
    },
    noteSendAnswer(args, answer) {
      const a = answer as { outcome?: unknown; reason?: unknown } | null
      if (!a || a.outcome !== 'draft' || a.reason !== 'too_long_to_approve') return
      const key = emailKey(args)
      if (key === null) return
      keptTooLong.add(key)
      while (keptTooLong.size > MAX_SPENT) keptTooLong.delete(keptTooLong.values().next().value as string)
    },
  }
}

/**
 * What a send no card allowed does with the floor check's decision
 * (lib/floor-check.ts consultFloor): only the server's word that the owner
 * does not ask first, from a server whose list holds email_send, lets it go,
 * or a connection with no floor to ask (no route, an API key). A hold says
 * the owner asks first; anything else (an error, a "not held" from a list
 * that predates email_send, an answer that is not about this action) sends
 * nothing.
 */
export function emailSendFloorRefusal(decision: {
  route: string
  answer?: { kind?: string; rulesVersion?: number | null }
}): string | null {
  if (decision.route === 'hold') return EMAIL_SEND_HELD_REFUSAL
  if (decision.route !== 'auto_approve') return EMAIL_SEND_UNCHECKED_REFUSAL
  const answer = decision.answer
  if (answer?.kind === 'unsupported') return null
  if (emailSendAlwaysAskOff(decision)) return null
  return EMAIL_SEND_UNCHECKED_REFUSAL
}

/**
 * Is this floor check decision the server's own word that the owner does not
 * ask before every send: "not held" from a server whose list holds
 * email_send (rules version 3 or more)? Nothing else is (no floor route, an
 * API key, a hold, an error, an older list). Wire shapes v7 (F1): the server
 * then still asks an approval for a reason it holds no record of, which no
 * card written now can give, so the agent is told that plainly.
 */
export function emailSendAlwaysAskOff(decision: {
  route: string
  answer?: { kind?: string; rulesVersion?: number | null }
}): boolean {
  const answer = decision.route === 'auto_approve' ? decision.answer : undefined
  return answer?.kind === 'proceed' && typeof answer.rulesVersion === 'number' && answer.rulesVersion >= EMAIL_SEND_FLOOR_MIN_RULES_VERSION
}
