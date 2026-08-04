/**
 * agent-credentials: resolve how the plugin authenticates to the HOAI backend.
 *
 * Two modes, resolved in a fixed precedence:
 *   1. pairing (env)   BGOS_PAIRING_TOKEN set  -> X-BGOS-Pairing header
 *   2. pairing (file)  the file picked by resolveCredentialsPath, in order:
 *                      BGOS_CREDENTIALS_PATH, else an existing per-assistant
 *                      ~/.bgos-agent/credentials-<BGOS_ASSISTANT_ID>.json, else
 *                      the legacy ~/.bgos-agent/credentials.json; used only if
 *                      no assistant is configured or its assistant matches the
 *                      explicit BGOS_ASSISTANT_ID (a mismatch is REJECTED and
 *                      recorded on pairingFileRejection for a loud WARN)
 *   3. apikey  (env)   BGOS_API_KEY set        -> X-API-Key header (LEGACY)
 *
 * The legacy api-key path is byte identical to the original behavior, so
 * existing paired agents (Echo) keep working through the deprecation window.
 * Pairing tokens ride in X-BGOS-Pairing on HTTP and in the socket.io handshake
 * query (the backend gateway reads pairing tokens only from query.pairingToken),
 * while the api-key path keeps its auth.apiKey handshake.
 *
 * Pure and side effect free (loadCredentialsFile and resolveCredentialsPath's
 * default exists() probe are the only small IO helpers, both injectable);
 * never logs or echoes any credential.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type AuthMode = 'pairing' | 'apikey'

export interface CredentialsFile {
  backendUrl?: string
  pairingToken?: string
  pairingId?: number
  userId?: string
  assistantId?: number | string | null
  pairedAt?: string
}

export interface PairingFileRejection {
  /** The assistantId found inside the (rejected) credentials file. */
  fileAssistantId: string
  /** The explicitly configured BGOS_ASSISTANT_ID that did not match. */
  configuredAssistantId: string
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
  /**
   * Non-null when a pairing credentials file WAS read but rejected because its
   * assistantId differs from the configured BGOS_ASSISTANT_ID. The caller must
   * surface this loudly (see formatPairingRejection); a silent fall-through to
   * api-key auth reads as "channel down" while chat keeps working (boards 401).
   */
  pairingFileRejection: PairingFileRejection | null
}

type Env = Record<string, string | undefined>

function str(value: unknown): string {
  return value == null ? '' : String(value)
}

/** The unsubstituted plugin userConfig placeholder is not a real assistant id. */
const ASSISTANT_ID_PLACEHOLDER = '${user_config.assistant_id}'

function configuredAssistantId(env: Env): string {
  const value = str(env.BGOS_ASSISTANT_ID).trim()
  return value && value !== ASSISTANT_ID_PLACEHOLDER ? value : ''
}

/**
 * Select the credentials file to read. Strict, total precedence so a host
 * running many agents under one OS user never has two files racing:
 *   1. BGOS_CREDENTIALS_PATH wins outright when set;
 *   2. else credentials-<BGOS_ASSISTANT_ID>.json (next to the default file)
 *      wins outright when it exists for the configured id: the legacy file is
 *      then IGNORED for that agent, even if it would also match;
 *   3. else the legacy single credentials.json (the whole pre-per-assistant
 *      fleet keeps working unchanged).
 * `exists` is injectable for tests; the default touches the real filesystem.
 */
export function resolveCredentialsPath(opts: {
  env?: Env
  defaultPath: string
  exists?: (path: string) => boolean
}): string {
  const env: Env = opts.env ?? {}
  // Trimmed, matching the bgos-pair write side: a padded path must not make
  // the daemon read a different file than pairing wrote.
  const override = str(env.BGOS_CREDENTIALS_PATH).trim()
  if (override) return override
  const assistantId = configuredAssistantId(env)
  if (assistantId) {
    const exists = opts.exists ?? existsSync
    const perAssistant = join(dirname(opts.defaultPath), `credentials-${assistantId}.json`)
    if (exists(perAssistant)) return perAssistant
  }
  return opts.defaultPath
}

/**
 * Resolve the effective auth from the process env and an optional parsed
 * credentials file. File IO is done by loadCredentialsFile so this stays pure.
 */
export function resolveAuth(opts: { env?: Env; creds?: CredentialsFile | null }): ResolvedAuth {
  const env: Env = opts.env ?? {}
  const creds = opts.creds ?? null
  const envAssistantId = configuredAssistantId(env)
  const hasConfiguredAssistantId = Boolean(envAssistantId)
  const pairingFileMatchesAssistant =
    !hasConfiguredAssistantId || str(creds?.assistantId) === envAssistantId
  // A usable pairing file that was read and REJECTED on assistant mismatch:
  // recorded so the call site can warn instead of silently degrading.
  const pairingFileRejection: PairingFileRejection | null =
    !env.BGOS_PAIRING_TOKEN &&
    creds &&
    creds.pairingToken &&
    !pairingFileMatchesAssistant
      ? { fileAssistantId: str(creds.assistantId), configuredAssistantId: envAssistantId }
      : null

  let base: Omit<ResolvedAuth, 'complete' | 'missing' | 'pairingFileRejection'>

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
  } else if (creds && creds.pairingToken && pairingFileMatchesAssistant) {
    base = {
      mode: 'pairing',
      source: 'pairing-file',
      // Once the identity boundary matches, paired values stay authoritative.
      // Env remains a fallback for empty or unsubstituted userConfig values.
      backendUrl: str(creds.backendUrl || env.BGOS_BACKEND_URL),
      userId: str(creds.userId || env.BGOS_USER_ID),
      assistantId: str((creds.assistantId ?? '') || env.BGOS_ASSISTANT_ID),
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

  return { ...base, complete: missing.length === 0, missing, pairingFileRejection }
}

/** A secret-free description of the selected credential source and identity. */
export function formatAuthResolution(
  auth: ResolvedAuth,
  credentialsPath: string,
): string {
  const source =
    auth.source === 'pairing-file'
      ? `pairing-file at ${credentialsPath}`
      : auth.source === 'pairing-env'
        ? 'env-pairing'
        : auth.source === 'apikey-env'
          ? 'env-apikey'
          : 'none'
  return `Credential source: ${source}; assistantId: ${auth.assistantId || '<missing>'}`
}

/**
 * The loud, secret-free WARN line for a mismatch-rejected pairing file, or null
 * when nothing was rejected. Pure: the caller (server.ts) does the logging.
 */
export function formatPairingRejection(
  auth: ResolvedAuth,
  credentialsPath: string,
): string | null {
  const rejection = auth.pairingFileRejection
  if (!rejection) return null
  const fallback =
    auth.source === 'apikey-env'
      ? 'falling back to api key'
      : 'no fallback api key is set'
  return (
    `pairing file at ${credentialsPath} IGNORED: its assistantId ` +
    `${rejection.fileAssistantId || '<missing>'} does not match configured ` +
    `BGOS_ASSISTANT_ID ${rejection.configuredAssistantId}; ${fallback}`
  )
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
