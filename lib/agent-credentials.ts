/**
 * agent-credentials: resolve how the plugin authenticates to the HOAI backend.
 *
 * Two modes, resolved in a fixed precedence:
 *   1. pairing (env)   BGOS_PAIRING_TOKEN set  -> X-BGOS-Pairing header
 *   2. pairing (file)  ~/.bgos-agent/credentials.json (written by bgos-pair)
 *   3. apikey  (env)   BGOS_API_KEY set        -> X-API-Key header (LEGACY)
 *
 * The legacy api-key path is byte identical to the original behavior, so
 * existing paired agents (Echo) keep working through the deprecation window.
 * Pairing tokens ride in X-BGOS-Pairing on HTTP and in the socket.io handshake
 * query (the backend gateway reads pairing tokens only from query.pairingToken),
 * while the api-key path keeps its auth.apiKey handshake.
 *
 * Pure and side effect free (loadCredentialsFile is the one small IO helper);
 * never logs or echoes any credential.
 */

import { readFileSync } from 'node:fs'

export type AuthMode = 'pairing' | 'apikey'

export interface CredentialsFile {
  backendUrl?: string
  pairingToken?: string
  pairingId?: number
  userId?: string
  assistantId?: number | string | null
  pairedAt?: string
}

export interface ResolvedAuth {
  mode: AuthMode
  source: 'pairing-env' | 'pairing-file' | 'apikey-env' | 'none'
  backendUrl: string
  userId: string
  assistantId: string
  pairingToken: string
  apiKey: string
  complete: boolean
  missing: string[]
}

type Env = Record<string, string | undefined>

function str(value: unknown): string {
  return value == null ? '' : String(value)
}

/**
 * Resolve the effective auth from the process env and an optional parsed
 * credentials file. File IO is done by loadCredentialsFile so this stays pure.
 */
export function resolveAuth(opts: { env?: Env; creds?: CredentialsFile | null }): ResolvedAuth {
  const env: Env = opts.env ?? {}
  const creds = opts.creds ?? null

  let base: Omit<ResolvedAuth, 'complete' | 'missing'>

  if (env.BGOS_PAIRING_TOKEN) {
    base = {
      mode: 'pairing',
      source: 'pairing-env',
      backendUrl: str(env.BGOS_BACKEND_URL),
      userId: str(env.BGOS_USER_ID),
      assistantId: str(env.BGOS_ASSISTANT_ID),
      pairingToken: str(env.BGOS_PAIRING_TOKEN),
      apiKey: '',
    }
  } else if (creds && creds.pairingToken) {
    base = {
      mode: 'pairing',
      source: 'pairing-file',
      // env can override backendUrl for dev; else use the paired backend.
      backendUrl: str(env.BGOS_BACKEND_URL || creds.backendUrl),
      userId: str(env.BGOS_USER_ID || creds.userId),
      assistantId: str(env.BGOS_ASSISTANT_ID || (creds.assistantId ?? '')),
      pairingToken: str(creds.pairingToken),
      apiKey: '',
    }
  } else if (env.BGOS_API_KEY) {
    base = {
      mode: 'apikey',
      source: 'apikey-env',
      backendUrl: str(env.BGOS_BACKEND_URL),
      userId: str(env.BGOS_USER_ID),
      assistantId: str(env.BGOS_ASSISTANT_ID),
      pairingToken: '',
      apiKey: str(env.BGOS_API_KEY),
    }
  } else {
    base = {
      mode: 'apikey',
      source: 'none',
      backendUrl: str(env.BGOS_BACKEND_URL),
      userId: str(env.BGOS_USER_ID),
      assistantId: str(env.BGOS_ASSISTANT_ID),
      pairingToken: '',
      apiKey: '',
    }
  }

  const missing: string[] = []
  if (!base.backendUrl) missing.push('backendUrl')
  if (!base.userId) missing.push('userId')
  if (!base.assistantId) missing.push('assistantId')
  if (base.mode === 'pairing' && !base.pairingToken) missing.push('pairingToken')
  if (base.mode === 'apikey' && !base.apiKey) missing.push('apiKey')

  return { ...base, complete: missing.length === 0, missing }
}

/** The HTTP auth header for the resolved mode. */
export function authHeaders(auth: ResolvedAuth): Record<string, string> {
  return auth.mode === 'pairing'
    ? { 'X-BGOS-Pairing': auth.pairingToken }
    : { 'X-API-Key': auth.apiKey }
}

/**
 * The socket.io handshake options for the resolved mode. The backend gateway
 * reads a pairing token ONLY from the handshake query, and the legacy path from
 * auth.apiKey + auth.assistantId.
 */
export function wsAuthOptions(
  auth: ResolvedAuth,
): { query?: { pairingToken: string }; auth?: { apiKey: string; assistantId: string } } {
  return auth.mode === 'pairing'
    ? { query: { pairingToken: auth.pairingToken } }
    : { auth: { apiKey: auth.apiKey, assistantId: auth.assistantId } }
}

/** A friendly, secret free message when creds are incomplete. */
export function missingCredsMessage(auth: ResolvedAuth): string {
  if (auth.mode === 'pairing') {
    return (
      'Not paired yet. Pair this session with a one time code from the HOAI app: ' +
      'run bgos-pair BGOS-XXXX-XX (or the /hoai:pair slash command). ' +
      `Missing: ${auth.missing.join(', ')}.`
    )
  }
  return (
    'Missing HOAI config. Pair with a one time code (bgos-pair BGOS-XXXX-XX), ' +
    'or set BGOS_BACKEND_URL, BGOS_API_KEY, BGOS_USER_ID, BGOS_ASSISTANT_ID for the legacy path. ' +
    `Missing: ${auth.missing.join(', ')}.`
  )
}

/**
 * Read and parse the pairing credentials file. Returns null when the file is
 * absent or unreadable, so the caller falls through to the env-based modes.
 */
export function loadCredentialsFile(path: string): CredentialsFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as CredentialsFile) : null
  } catch {
    return null
  }
}
