/**
 * Pure, side-effect-free body-builder for the `call_owner` MCP tool.
 *
 * Like ./lib/message-text.ts, everything here is deterministic and import-safe
 * (no env reads, no network, no process exit), so it can be unit/eval tested
 * directly. server.ts imports `buildCallOwnerBody` for the CallTool handler; the
 * eval suite (test/call-owner.test.ts) imports it too.
 *
 * The backend contract for POST /api/v1/voice/outbound-call is:
 *   { assistantId: number, chatId?: number, reason?: string }
 * This helper shapes exactly that body: it always carries assistantId, includes
 * chatId only when it is a finite number, and normalizes the ring reason to the
 * ring-screen rule (Kc, 2026-09-03): one or two plain sentences, at most 140
 * characters, no markdown or line breaks, cut at a word boundary, never an
 * added ellipsis. A reason that is empty after normalization is dropped rather
 * than sent as "". The backend applies the same rule on its side
 * (BGOS backend/src/voice/call-reason.ts) and still accepts up to 200
 * characters, so this pre-cap can never cause a 400; it exists so the wire
 * body already matches what the phone shows.
 */

/** Character cap for the human-readable ring reason, cut at a word boundary. */
export const CALL_OWNER_REASON_MAX = 140

/** Sentences kept, split on . ! ? followed by whitespace. */
export const CALL_OWNER_REASON_MAX_SENTENCES = 2

/**
 * Leading markers a markdown line can carry: list bullets (-, *, +), ordered
 * markers (1. / 1)), heading hashes, blockquote chevrons. Stripped per line.
 */
const LEADING_MARKERS = /^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>\s*)+/

/** A sentence end: . ! ? immediately followed by whitespace. */
const SENTENCE_END = /[.!?](?=\s)/g

/**
 * Collapse a free-form reason into at most two plain sentences of at most
 * 140 characters. Returns null when nothing readable is left (empty input,
 * whitespace only, markup only) or when the input is not a string at all.
 * Pure: no I/O, no clock.
 */
export function normalizeCallOwnerReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null

  const lines = raw.split(/\r?\n/).map((line) => line.replace(LEADING_MARKERS, ''))

  let text = lines
    .join(' ')
    // Code ticks and emphasis runs: `code`, **bold**, *em*, ~~strike~~.
    .replace(/`+/g, '')
    .replace(/\*+/g, '')
    .replace(/~~/g, '')
    // Underscore emphasis only at word edges, so snake_case survives.
    .replace(/(^|[\s(])_+/g, '$1')
    .replace(/_+(?=[\s).,!?:;]|$)/g, '')
    // Whitespace and newlines collapse to single spaces.
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) return null

  // Keep the first CALL_OWNER_REASON_MAX_SENTENCES sentences.
  SENTENCE_END.lastIndex = 0
  let boundaries = 0
  let match: RegExpExecArray | null
  while ((match = SENTENCE_END.exec(text)) !== null) {
    boundaries += 1
    if (boundaries === CALL_OWNER_REASON_MAX_SENTENCES) {
      text = text.slice(0, match.index + 1)
      break
    }
  }

  // Cap at CALL_OWNER_REASON_MAX, cutting at a word boundary: no trailing
  // partial word and no added ellipsis. A single unbroken token longer than
  // the cap is hard-cut, the only case with no boundary to fall back to.
  if (text.length > CALL_OWNER_REASON_MAX) {
    const head = text.slice(0, CALL_OWNER_REASON_MAX + 1)
    const cut = head.lastIndexOf(' ')
    text = (cut > 0 ? head.slice(0, cut) : text.slice(0, CALL_OWNER_REASON_MAX)).trimEnd()
  }

  return text || null
}

export interface CallOwnerBodyInput {
  /** This assistant's numeric id (always sent). */
  assistantId: number
  /** Chat to bind the call to. Omitted from the body when undefined/null/NaN. */
  chatId?: number | null
  /** Short reason shown on the ring; normalized by normalizeCallOwnerReason. */
  reason?: string | null
}

export interface CallOwnerBody {
  assistantId: number
  chatId?: number
  reason?: string
}

/**
 * Build the POST body for the outbound-call endpoint. Pure: no I/O, no clock.
 *
 * - `assistantId` is always included (required by the backend).
 * - `chatId` is included only when it is a finite number.
 * - `reason` is normalized (two sentences, 140 chars at a word boundary, no
 *   markdown or line breaks); a reason that is empty afterwards is omitted
 *   rather than sent as "".
 */
export function buildCallOwnerBody({
  assistantId,
  chatId,
  reason,
}: CallOwnerBodyInput): CallOwnerBody {
  const body: CallOwnerBody = { assistantId }

  if (typeof chatId === 'number' && Number.isFinite(chatId)) {
    body.chatId = chatId
  }

  const normalized = normalizeCallOwnerReason(reason)
  if (normalized) body.reason = normalized

  return body
}
