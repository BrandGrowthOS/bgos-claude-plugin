/**
 * The server's rule for an assistant write that carries a client key, as it
 * applies to POST integrations/threads/reply. A write with no key passes here
 * and is judged by the pairing gate alone. A write with a key needs the
 * assistant's own caller secret: this route never attaches a signed assistant
 * principal, so a signature does not count on it, and neither does the pairing
 * token. Read from the server's keyed assistant author check on 2026-11-09.
 * Headers are as node delivers them, lower case.
 */
import { createHmac } from 'node:crypto'

export const KEYED_ASSISTANT_REFUSAL = 'Invalid assistant credential.'

export function threadReplyRefused(
  headers: Record<string, unknown>,
  body: Record<string, unknown> | null,
  callerSecretHash: string | null = null,
): boolean {
  if (body?.clientId == null) return false
  const secret = headers['x-caller-assistant-secret']
  if (!callerSecretHash || typeof secret !== 'string' || secret === '') return true
  return createHmac('sha256', 'bgos-assistant-credential').update(secret).digest('hex') !== callerSecretHash
}

/** The same header map a request carries, lower cased, for a fake that never crossed http. */
export function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
}
