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
// Pure: no network, no env, no clock but the injected one.
// No em or en dashes anywhere in this file (project copy rule).

import {
  HARD_FLOOR_RULES_VERSION,
  PREVIEW_ELISION_RE,
  hardFloorWords,
  isOwnSendingTool,
  type HardFloorMatch,
} from './hard-floor.js'

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

export interface EmailSendApprovals {
  /** The relay heard the owner allow a card: remember it when the card was this channel's email_send. */
  allow(toolName: string, inputPreview: unknown): boolean
  /** The tool is about to send: is an unused Allow waiting for exactly this call? Takes it. */
  take(args: unknown): boolean
}

/**
 * The owner's Allows of email_send cards, each good for the one call it
 * allowed, once, within EMAIL_SEND_APPROVAL_TTL_MS. In memory only: an Allow
 * never outlives this daemon, and a send after a restart asks again.
 */
export function createEmailSendApprovals(
  { now = Date.now, ttlMs = EMAIL_SEND_APPROVAL_TTL_MS }: { now?: () => number; ttlMs?: number } = {},
): EmailSendApprovals {
  let waiting: Array<{ at: number; email: EmailSendPreview }> = []
  const dropStale = () => {
    const at = now()
    waiting = waiting.filter((entry) => at - entry.at <= ttlMs)
  }
  return {
    allow(toolName, inputPreview) {
      if (!isOwnSendingTool(toolName)) return false
      const email = readEmailSendPreview(inputPreview)
      if (!email) return false
      dropStale()
      waiting.push({ at: now(), email })
      while (waiting.length > MAX_WAITING) waiting.shift()
      return true
    },
    take(args) {
      dropStale()
      const index = waiting.findIndex((entry) => emailMatchesPreview(entry.email, args))
      if (index < 0) return false
      waiting.splice(index, 1)
      return true
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
  if (answer?.kind === 'proceed' && typeof answer.rulesVersion === 'number' && answer.rulesVersion >= EMAIL_SEND_FLOOR_MIN_RULES_VERSION) {
    return null
  }
  return EMAIL_SEND_UNCHECKED_REFUSAL
}
