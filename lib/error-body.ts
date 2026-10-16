/**
 * The text of a backend error body, for the message of the error a REST helper throws.
 *
 * Every helper in server.ts used to cut the body with text.slice(0, 200), so a share recipient's 403
 * mission refusal reached the model as "...works in that person's chat ins" (HOAI board row 81a68f4).
 * A NestJS error is {message, error, statusCode}; its message is the sentence the model needs, and
 * it is a string or an array of strings (a validation failure lists one per field).
 */

/** The bound on a surfaced backend message. */
export const ERROR_MESSAGE_MAX = 600

/** The bound on a body that carries no usable message (HTML, a proxy page, a JSON dump). */
const RAW_BODY_MAX = 200

export function errorBodyText(text: string): string {
  const raw = text.slice(0, RAW_BODY_MAX)
  let message: unknown
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return raw
    message = (parsed as { message?: unknown }).message
  } catch {
    return raw
  }
  const joined = Array.isArray(message)
    ? message.filter((m): m is string => typeof m === 'string' && m.trim() !== '').join('; ')
    : typeof message === 'string'
      ? message
      : ''
  if (joined.trim() === '') return raw
  const cut = joined.slice(0, ERROR_MESSAGE_MAX)
  // A cut through an emoji leaves a lone high surrogate, which a later JSON request can reject.
  return /[\uD800-\uDBFF]$/.test(cut) && joined.length > cut.length ? cut.slice(0, -1) : cut
}
