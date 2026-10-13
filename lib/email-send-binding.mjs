/**
 * The email an owner's tap approves (outgoing email modes, HOAI 2dd04488;
 * wire-shapes.md "Server approval for a send (Data 2026-10-13)", section 1).
 *
 * While the owner's "Always ask before risky actions" is on, the SERVER is the
 * gate: the send route sends only with a single use approval that the owner's
 * own tap on that exact email's card issued. The card therefore carries
 * `approvalMeta.email_send`, the binding the tap issues the approval for:
 *
 *   { to, subject, text, body_sha256, text_preview }   a new email
 *   { email_id, text, body_sha256, text_preview }      a reply
 *
 * `text` is the exact body (wire-shapes.md v6, Data 2026-10-13 17:41Z): the
 * server builds the preview the owner reads and the hash the approval binds
 * from it, and never stores it; without it the card offers deny only.
 * `body_sha256` and `text_preview` are kept, well formed, though v6 ignores
 * them (an earlier backend required them); nothing the owner sees relies on
 * them, and the plugin uses them only to pair a record with its request.
 *
 * built here from the tool's own input exactly as the tool will send it:
 * `to`, `subject` and `email_id` trimmed (lib/agent-email-tools.ts parseArgs
 * trims them), `text` as it is, never trimmed. `body_sha256` is the lowercase
 * hex SHA-256 of that text's UTF-8 bytes (before the server appends the
 * signature); `text_preview` its raw start, at most 1000 UTF-16 units, never
 * half of a character, so the text always begins with it. Not the card's
 * shown form: a character the card writes as [U+XXXX] stays itself here,
 * because the server checks `text.startsWith(text_preview)` on the text it
 * receives.
 *
 * WHERE IT IS BUILT. The floor hook (bin/hoai-floor-hook.mjs, through
 * lib/floor-state.mjs buildFloorRecord) sees the WHOLE tool input, so it
 * writes the binding into its floor record, and that is the only source of
 * the card's body: the relay's own copy of the input is the CLI's preview,
 * which folds runs of whitespace and cuts a value over 3500 code points in
 * the middle, so it is never taken for the body (v6: a card with no exact
 * body offers deny only, never a guessed one). One implementation serves the
 * hook and the tool's own check against the binding, so they cannot drift.
 *
 * WHAT IT REFUSES. Anything the server would refuse on the card write (a 400
 * that would cost the whole card) or on the send: both or neither of
 * `email_id` and `to`, a `to` that is not a strict mailbox (the backend's
 * address.ts strictMailbox, mirrored), a subject that is empty, longer than
 * 200 or on two lines, an `email_id` that is not a uuid, a blank text or one
 * over 32,000, a text holding U+0000 or a lone surrogate (neither survives the
 * server's JSON storage), and any key the tool does not take. With no binding
 * the card is posted without one: the server makes it deny only, and the
 * email stays a draft (fail closed).
 *
 * Plain JavaScript that node 18 loads, like lib/hard-floor-core.mjs: the hook
 * imports it on bare node. Pure: no env, no clock, no network.
 * No em or en dashes anywhere in this file (project copy rule).
 */

import { createHash } from 'node:crypto'
import { isOwnSendingTool } from './hard-floor-core.mjs'

/** The most of the text a card's `text_preview` carries (section 1). */
export const EMAIL_SEND_PREVIEW_MAX = 1000

const TEXT_MAX = 32_000
const SUBJECT_MAX = 200
/** A uuid as the server's IsUUID() reads one (version 1 to 8, variant 8 to b, or the nil and max ids). */
const UUID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|0{8}-0{4}-0{4}-0{4}-0{12}|f{8}-f{4}-f{4}-f{4}-f{12})$/i
const FIELDS = ['to', 'subject', 'email_id', 'text']

/** The backend's strict mailbox (address.ts strictMailbox), so a card never fails its write on `to`. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/
const DOT_ATOM = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * One dot atom mailbox on an ASCII domain of two or more labels whose last is
 * not all digits, at most 254 characters with a local part of at most 64.
 * Nothing is trimmed: whitespace anywhere refuses.
 * @param {unknown} address @returns {boolean}
 */
export function isStrictMailbox(address) {
  if (typeof address !== 'string' || address.length > 254 || !PRINTABLE_ASCII.test(address)) return false
  const lower = address.toLowerCase()
  const at = lower.indexOf('@')
  if (at <= 0 || at !== lower.lastIndexOf('@')) return false
  const local = lower.slice(0, at)
  const domain = lower.slice(at + 1)
  if (local.length > 64 || !DOT_ATOM.test(local)) return false
  if (domain.length === 0 || domain.length > 253) return false
  const labels = domain.split('.')
  if (labels.length < 2 || !labels.every((label) => DNS_LABEL.test(label))) return false
  return !/^[0-9]+$/.test(labels[labels.length - 1])
}

/** A text the server can store and hash as it is: no U+0000, no lone surrogate. @param {string} text */
function storable(text) {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit === 0) return false
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      i++
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}

/**
 * The text's raw start, at most EMAIL_SEND_PREVIEW_MAX UTF-16 units, cut on a
 * character boundary so the text begins with it.
 * @param {string} text @returns {string}
 */
export function emailSendTextPreview(text) {
  const raw = String(text ?? '')
  if (raw.length <= EMAIL_SEND_PREVIEW_MAX) return raw
  const cut = raw.slice(0, EMAIL_SEND_PREVIEW_MAX)
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut
}

/** Lowercase hex SHA-256 of the text's UTF-8 bytes. @param {string} text @returns {string} */
export function emailSendBodySha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/**
 * The binding of one email_send call of this channel, in the card's wire
 * shape, or null when the call is not one the server could bind (see the
 * header). `toolName` is the CLI's name for the tool (any of the channel's
 * server names); `toolInput` its arguments as the tool receives them.
 * @param {unknown} toolName @param {unknown} toolInput
 * @returns {{ to: string, subject: string, body_sha256: string, text_preview: string }
 *   | { email_id: string, body_sha256: string, text_preview: string } | null}
 */
export function emailSendBinding(toolName, toolInput) {
  if (!isOwnSendingTool(toolName) || !isRecord(toolInput)) return null
  const input = {}
  for (const [key, value] of Object.entries(toolInput)) {
    if (value === null || value === undefined) continue
    if (!FIELDS.includes(key) || typeof value !== 'string') return null
    input[key] = value
  }
  const text = input.text
  if (typeof text !== 'string' || text.trim() === '' || text.length > TEXT_MAX || !storable(text)) return null
  const proof = { text, body_sha256: emailSendBodySha256(text), text_preview: emailSendTextPreview(text) }
  if (input.email_id !== undefined) {
    if (input.to !== undefined || input.subject !== undefined) return null
    const emailId = input.email_id.trim()
    return UUID.test(emailId) ? { email_id: emailId, ...proof } : null
  }
  if (input.to === undefined || input.subject === undefined) return null
  const to = input.to.trim()
  const subject = input.subject.trim()
  if (!isStrictMailbox(to)) return null
  if (subject === '' || subject.length > SUBJECT_MAX || /[\r\n]/.test(subject)) return null
  return { to, subject, ...proof }
}

/**
 * Is this a binding the server takes as it is (section 1, v6)? Exactly the
 * keys of one of the two shapes, a body the server can take, and a hash and a
 * preview that are that body's own (so a record never names one email and
 * carries another).
 * @param {unknown} block @returns {boolean}
 */
export function isEmailSendBlock(block) {
  if (!isRecord(block)) return false
  const keys = Object.keys(block).sort().join(',')
  if (keys !== 'body_sha256,email_id,text,text_preview' && keys !== 'body_sha256,subject,text,text_preview,to') return false
  const text = block.text
  if (typeof text !== 'string' || text.trim() === '' || text.length > TEXT_MAX || !storable(text)) return false
  if (block.body_sha256 !== emailSendBodySha256(text) || block.text_preview !== emailSendTextPreview(text)) return false
  if ('email_id' in block) return typeof block.email_id === 'string' && UUID.test(block.email_id)
  return (
    isStrictMailbox(block.to) &&
    typeof block.subject === 'string' &&
    block.subject !== '' &&
    block.subject.length <= SUBJECT_MAX &&
    !/[\r\n]/.test(block.subject)
  )
}

/**
 * Does this call send exactly the email the binding names? The call's own
 * binding, field for field: the same address, subject or email, and the same
 * text to the byte (its hash).
 * @param {unknown} block @param {unknown} args @returns {boolean}
 */
export function bindingMatchesCall(block, args) {
  if (!isEmailSendBlock(block)) return false
  const own = emailSendBinding('mcp__bgos__email_send', args)
  if (!own) return false
  const keys = Object.keys(block)
  return keys.length === Object.keys(own).length && keys.every((key) => own[key] === block[key])
}
