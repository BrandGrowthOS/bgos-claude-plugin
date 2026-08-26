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

import { existsSync, readFileSync, readdirSync } from 'node:fs'
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

/** The launch-folder pin file bgos-pair drops so a daemon started from that
 *  folder self-resolves its identity with no env var. */
export const FOLDER_PIN_FILE = '.bgos-agent-id'

/**
 * The extended, folder-scoped resolver server.ts consumes at boot. It answers
 * "which credentials file is THIS daemon, and may it start at all".
 *
 *   ok    -> a single credentials file was chosen deterministically.
 *   refuse -> this host has several paired agents and this daemon has no pin,
 *             so it CANNOT tell which one it is; refusing beats answering as
 *             the wrong agent (the multi-agent-per-host collision).
 */
export type CredentialsSelection =
  | {
      kind: 'ok'
      path: string
      via: 'env-path' | 'env-assistant' | 'folder-pin' | 'sole-per-assistant' | 'legacy'
    }
  | { kind: 'refuse'; candidateIds: string[]; agentDir: string }

type FileProbes = {
  exists?: (path: string) => boolean
  readText?: (path: string) => string | null
  listDir?: (path: string) => string[]
}

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function defaultListDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/** The numeric id in a <cwd>/.bgos-agent-id pin, or '' when absent or junk. */
function readFolderPinId(cwd: string, readText: (path: string) => string | null): string {
  if (!cwd) return ''
  const raw = readText(join(cwd, FOLDER_PIN_FILE))
  if (raw == null) return ''
  const id = String(raw).trim()
  return /^\d+$/.test(id) ? id : ''
}

/** The assistant ids that have a credentials-<id>.json next to the default
 *  file, ascending. [] when the directory is missing or unreadable. */
function listPerAssistantIds(agentDir: string, listDir: (path: string) => string[]): string[] {
  return listDir(agentDir)
    .map((name) => /^credentials-(\d+)\.json$/.exec(name)?.[1])
    .filter((found): found is string => Boolean(found))
    .sort((a, b) => Number(a) - Number(b))
}

/**
 * Select the credentials file to read. Strict, total precedence so a host
 * running many agents under one OS user never has two files racing:
 *   1. BGOS_CREDENTIALS_PATH wins outright when set;
 *   2. else credentials-<BGOS_ASSISTANT_ID>.json when it exists for the
 *      configured id (an explicit env pin, which also SUPPRESSES the refusal);
 *   3. with NO env pin, a <cwd>/.bgos-agent-id folder pin resolves that agents
 *      own file (pairing drops it, so a bare launch from the agent folder needs
 *      no env);
 *   4. else a sole per-assistant file when there is no legacy file (a clean
 *      single-agent host);
 *   5. else, when several per-assistant files exist with no pin, REFUSE;
 *   6. else the legacy single credentials.json (the pre-per-assistant fleet
 *      keeps working unchanged).
 * All filesystem probes are injectable for tests.
 */
export function resolveCredentialsSelection(opts: {
  env?: Env
  defaultPath: string
  cwd?: string
} & FileProbes): CredentialsSelection {
  const env: Env = opts.env ?? {}
  const exists = opts.exists ?? existsSync
  const readText = opts.readText ?? defaultReadText
  const listDir = opts.listDir ?? defaultListDir
  const cwd = str(opts.cwd).trim()
  const agentDir = dirname(opts.defaultPath)

  // Trimmed, matching the bgos-pair write side: a padded path must not make
  // the daemon read a different file than pairing wrote.
  const override = str(env.BGOS_CREDENTIALS_PATH).trim()
  if (override) return { kind: 'ok', path: override, via: 'env-path' }

  const assistantId = configuredAssistantId(env)
  if (assistantId) {
    const perAssistant = join(agentDir, `credentials-${assistantId}.json`)
    if (exists(perAssistant)) return { kind: 'ok', path: perAssistant, via: 'env-assistant' }
    // Configured id but no matching file: keep the legacy fallback unchanged.
    // An explicit env pin, even a stale one, never triggers the refusal.
    return { kind: 'ok', path: opts.defaultPath, via: 'legacy' }
  }

  // No env pin from here: the folder is the only per-process anchor.
  const folderId = readFolderPinId(cwd, readText)
  if (folderId) {
    const pinned = join(agentDir, `credentials-${folderId}.json`)
    if (exists(pinned)) return { kind: 'ok', path: pinned, via: 'folder-pin' }
    // A pin pointing at a missing file is stale: fall through, never obey it.
  }

  const ids = listPerAssistantIds(agentDir, listDir)
  const hasLegacy = exists(opts.defaultPath)
  if (ids.length === 1 && !hasLegacy) {
    return { kind: 'ok', path: join(agentDir, `credentials-${ids[0]}.json`), via: 'sole-per-assistant' }
  }
  if (ids.length > 1) {
    return { kind: 'refuse', candidateIds: ids, agentDir }
  }
  return { kind: 'ok', path: opts.defaultPath, via: 'legacy' }
}

/**
 * The string-returning resolver kept for existing callers (the auth-recheck
 * visibility path and the write-side mirror test). It delegates to
 * resolveCredentialsSelection and maps the refuse case to the legacy default,
 * so a string caller behaves exactly as before while the boot path
 * (resolveCredentialsSelection) is the one that can actually refuse.
 */
export function resolveCredentialsPath(opts: {
  env?: Env
  defaultPath: string
  cwd?: string
} & FileProbes): string {
  const selection = resolveCredentialsSelection(opts)
  return selection.kind === 'ok' ? selection.path : opts.defaultPath
}

/**
 * The loud, secret-free boot-refusal line for the ambiguous multi-agent case,
 * or '' when nothing was refused. Names the count, the ids, and BOTH pin routes
 * (a folder pin via hoai-pair, or an explicit BGOS_ASSISTANT_ID) so the operator
 * can fix it without guessing. Pure: server.ts does the logging and the exit.
 */
export function formatCredentialsRefusal(selection: CredentialsSelection): string {
  if (selection.kind !== 'refuse') return ''
  const ids = selection.candidateIds.join(', ')
  return (
    `REFUSING to start: this host has ${selection.candidateIds.length} paired agents ` +
    `(ids: ${ids}) in ${selection.agentDir}, but this daemon has no identity pin, so it ` +
    `cannot tell which one it is. Pin it with whichever of those ids THIS folder is meant ` +
    `to be, one of two ways: write it into the folder, ` +
    `\`echo <id> > ${FOLDER_PIN_FILE}\` here (this is what hoai pair bakes, and it needs no ` +
    `pairing code), or set BGOS_ASSISTANT_ID=<id> in this agent's environment. ` +
    `Refusing rather than answering as the wrong agent.`
  )
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
