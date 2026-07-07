/**
 * Pure, side-effect-free body-builder for the `call_owner` MCP tool.
 *
 * Like ./lib/message-text.ts, everything here is deterministic and import-safe
 * (no env reads, no network, no process exit), so it can be unit/eval tested
 * directly. server.ts imports `buildCallOwnerBody` for the CallTool handler; the
 * eval suite (test/call-owner.test.ts) imports it too.
 *
 * The backend contract for POST /api/v1/voice/outbound-call is:
 *   { assistantId: number, chatId?: number, reason?: string (<=200 chars) }
 * This helper shapes exactly that body: it always carries assistantId, includes
 * chatId only when it is a finite number, and trims + caps the ring reason to
 * 200 chars (dropping it entirely when empty/whitespace-only) so the wire body
 * is always within the backend's limits.
 */

/** Backend limit for the human-readable ring reason. */
export const CALL_OWNER_REASON_MAX = 200

export interface CallOwnerBodyInput {
  /** This assistant's numeric id (always sent). */
  assistantId: number
  /** Chat to bind the call to. Omitted from the body when undefined/null/NaN. */
  chatId?: number | null
  /** Short reason shown on the ring; trimmed + capped to 200 chars. */
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
 * - `reason` is trimmed and truncated to `CALL_OWNER_REASON_MAX` chars; an
 *   empty/whitespace-only reason is omitted rather than sent as "".
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

  if (typeof reason === 'string') {
    // Trim first so leading/trailing whitespace never eats into the 200-char
    // budget, then cap. A reason that is empty after trimming is dropped.
    const trimmed = reason.trim().slice(0, CALL_OWNER_REASON_MAX)
    if (trimmed) body.reason = trimmed
  }

  return body
}
