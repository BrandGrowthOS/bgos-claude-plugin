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

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type AuthMode = 'pairing' | 'apikey'

export interface CredentialsFile {
  backendUrl?: string
  pairingToken?: string
  pairingId?: number
  userId?: string
  assistantId?: number | string | null
  pairedAt?: string
  /**
   * The folder this agent actually lives in, recorded once (see
   * decideHomeBinding). Its presence is what lets a daemon tell the real agent
   * apart from a stray session that resolved to the same file by elimination.
   */
  homeDir?: string
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
/** How a credentials file was chosen. The first three carry a per-process
 *  identity signal; the last two resolve by elimination from host state. */
export type CredentialsVia =
  | 'env-path'
  | 'env-assistant'
  | 'folder-pin'
  | 'sole-per-assistant'
  | 'legacy'

export type CredentialsSelection =
  | {
      kind: 'ok'
      path: string
      via: CredentialsVia
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
/**
 * Would this daemon still boot if the env pin were removed?
 *
 * 2026-08-29, found by Mark (888) on a 12-agent Windows host. Every agent there
 * carries BGOS_ASSISTANT_ID in its own .mcp.json, `~/.bgos-agent/` holds twelve
 * `credentials-<id>.json`, and there is not a single folder pin anywhere. That
 * resolves via 'env-assistant' and works perfectly. But the env pin is the ONLY
 * thing holding it up: strip it and the resolver reaches the several-candidates
 * branch, returns `refuse`, and the caller calls process.exit(1). Twelve agents
 * do not degrade, they stop booting.
 *
 * Nothing announced that. "Tidy up the .mcp.json env blocks" is an ordinary
 * piece of housekeeping that would have taken the whole host down, and the
 * healthy boot log looked identical to a robust one.
 *
 * So we ask the question directly instead of re-deriving the conditions: run
 * the REAL resolver again with the pin removed and see what it says. A warning
 * that re-implements the rule it is warning about drifts away from it; this one
 * cannot, because it IS the rule.
 *
 * Returns null when there is nothing to say, which is the common case.
 */
export function describeEnvOnlyIdentityRisk(opts: {
  env?: Env
  defaultPath: string
  cwd?: string
} & FileProbes): string | null {
  const env: Env = opts.env ?? {}

  // Only env-pinned hosts can lose an env pin.
  const pinned =
    str(env.BGOS_CREDENTIALS_PATH).trim() !== '' || configuredAssistantId(env) !== ''
  if (!pinned) return null

  const withoutPin: Env = { ...env }
  delete withoutPin.BGOS_CREDENTIALS_PATH
  delete withoutPin.BGOS_ASSISTANT_ID

  const counterfactual = resolveCredentialsSelection({ ...opts, env: withoutPin })
  if (counterfactual.kind !== 'refuse') return null

  const n = counterfactual.candidateIds.length
  return (
    `identity here rests ENTIRELY on the environment: ${n} credential files in ` +
    `${counterfactual.agentDir} and no ${FOLDER_PIN_FILE} folder pin. ` +
    `Removing the env pin would not degrade this agent, it would refuse to boot. ` +
    `Write a ${FOLDER_PIN_FILE} containing the assistant id to make it survive that.`
  )
}

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
  opts: { via?: string; cwd?: string } = {},
): string {
  const source =
    auth.source === 'pairing-file'
      ? `pairing-file at ${credentialsPath}`
      : auth.source === 'pairing-env'
        ? 'env-pairing'
        : auth.source === 'apikey-env'
          ? 'env-apikey'
          : 'none'
  // WHICH RULE picked this, and FROM WHERE. Both are free (the resolver already
  // computes `via`, and cwd is a syscall) and on a multi-agent host they are the
  // only two facts that matter.
  //
  // 2026-08-27: a partner's agent would not start under Claude Code while `hoai
  // doctor` succeeded, on a Mac with seven paired agents. Doctor spawns through
  // the same shim, so the difference had to be the environment or the working
  // directory Claude Code hands the server, and NEITHER was recoverable from any
  // log we write. The boot line named the credentials FILE and the assistant id,
  // which are the outputs, and said nothing about the inputs that chose them.
  // Hours of inference followed, most of it wrong. One line would have ended it.
  const route = opts.via ? `; via: ${opts.via}` : ''
  const where = opts.cwd ? `; cwd: ${opts.cwd}` : ''
  return (
    `Credential source: ${source}; assistantId: ${auth.assistantId || '<missing>'}` +
    `${route}${where}`
  )
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

// ── Home-folder identity binding (the impostor guard) ────────────────────────
//
// THE DEFECT THIS CLOSES (board 01a068f7, recurred 2026-09-04). The resolver
// above answers "which credentials file is on this HOST", and on a host with
// exactly one paired agent that question has a single answer for EVERY process
// under that OS user. So `claude` started in any folder at all resolves via
// 'sole-per-assistant' (or 'legacy'), boots a daemon on that agent's pairing,
// and SPEAKS AS THAT AGENT. Nothing is misconfigured and nothing looks wrong:
// the stray session is indistinguishable from the real one at the credential
// layer, because identity was never a property of the session.
//
// The 0.38.6 pairing lock does NOT close this. The lock guarantees exactly one
// daemon per pairing; it says nothing about WHICH one. When the real agent is
// between restarts, a stray acquires the lock legitimately and becomes the
// agent. Mutual exclusion without identity just picks a winner.
//
// THE BINDING. An agent's real home folder is recorded once, in its own
// credentials file, and afterwards a session resolving by ELIMINATION from a
// different folder refuses to start rather than answering as someone else.
//
// Three properties make it safe to roll to a live fleet:
//   1. It only constrains the ELIMINATION routes ('sole-per-assistant' and
//      'legacy'). An explicit per-process pin (BGOS_CREDENTIALS_PATH,
//      BGOS_ASSISTANT_ID, a folder pin) is already a positive identity signal
//      and is never second-guessed, so the 12-agent env-pinned Windows hosts
//      keep booting from wherever they like.
//   2. It SELF-MIGRATES. An agent with nothing recorded yet records its folder
//      and proceeds, so no operator has to do anything and no existing agent
//      stops working on upgrade.
//   3. There is an env kill-switch (BGOS_ALLOW_ANY_FOLDER=1) so a wedge is one
//      variable away from cleared, without editing a credentials file.
//
// THE ONE RESIDUAL RACE, stated plainly rather than buried: if a stray session
// is the FIRST to boot after the upgrade on a host whose agent is down, the
// stray records ITS folder and the real agent then refuses. That is a worse
// day than today only if it goes unnoticed, and it cannot: the refusal names
// the recorded folder and the fix is one line. Today's failure mode is silent
// and produces confident wrong answers in the user's chat, which is worse.
// Recording is therefore also deliberately driven from a SUCCESSFUL connect
// (see server.ts), not merely from resolution, to shrink that window.

/** Kill-switch: set to '1'/'true' to skip the binding entirely for one boot. */
export const ALLOW_ANY_FOLDER_ENV = 'BGOS_ALLOW_ANY_FOLDER'

/** Routes that carry a per-process identity signal and are never constrained. */
const EXPLICIT_PIN_ROUTES = new Set(['env-path', 'env-assistant', 'folder-pin'])

/**
 * Normalize a folder for comparison: resolve it, drop any trailing separator,
 * and case-fold on the platforms whose filesystems are case-insensitive
 * (Windows and macOS). Comparing raw strings would refuse a real agent over a
 * trailing slash or a drive-letter case, which is exactly the kind of false
 * refusal that makes a safety feature get disabled.
 */
export function normalizeHomeDir(
  dir: string,
  opts: { platform?: string } = {},
): string {
  const raw = str(dir).trim()
  if (!raw) return ''
  const platform = opts.platform ?? process.platform
  const caseInsensitive = platform === 'win32' || platform === 'darwin'
  let out = raw.replace(/[\\/]+$/, '')
  if (!out) out = raw.slice(0, 1)
  return caseInsensitive ? out.toLowerCase() : out
}

export type HomeBindingDecision =
  /** Start normally; nothing to write. */
  | { action: 'allow'; reason: 'explicit-pin' | 'match' | 'override' | 'no-cwd' }
  /** Start normally, and record this folder as the agent's home. */
  | { action: 'record'; homeDir: string }
  /** Do not start: this folder is not this agent's home. */
  | { action: 'refuse'; recordedHomeDir: string; cwd: string; assistantId: string }

/**
 * THE PURE DECISION. Given how the credentials file was chosen, where this
 * process was launched, and what home folder (if any) the file records,
 * decide whether this daemon is the agent it resolved to.
 */
export function decideHomeBinding(input: {
  via: CredentialsVia
  cwd: string
  recordedHomeDir?: string | null
  assistantId?: string
  env?: Env
  platform?: string
}): HomeBindingDecision {
  const env: Env = input.env ?? {}
  const override = str(env[ALLOW_ANY_FOLDER_ENV]).trim().toLowerCase()
  if (override === '1' || override === 'true') {
    return { action: 'allow', reason: 'override' }
  }
  if (EXPLICIT_PIN_ROUTES.has(input.via)) {
    return { action: 'allow', reason: 'explicit-pin' }
  }
  const cwd = normalizeHomeDir(input.cwd, { platform: input.platform })
  // No usable launch folder means nothing to compare and nothing to record.
  // Allowing is the only honest answer; refusing here would fail closed on a
  // condition that says nothing about identity.
  if (!cwd) return { action: 'allow', reason: 'no-cwd' }
  const recorded = normalizeHomeDir(str(input.recordedHomeDir), {
    platform: input.platform,
  })
  if (!recorded) return { action: 'record', homeDir: str(input.cwd).trim() }
  if (recorded === cwd) return { action: 'allow', reason: 'match' }
  return {
    action: 'refuse',
    recordedHomeDir: str(input.recordedHomeDir).trim(),
    cwd: str(input.cwd).trim(),
    assistantId: str(input.assistantId),
  }
}

/**
 * The refusal banner. Names the agent, both folders, and BOTH escapes (move to
 * the home folder, or pin this one explicitly) so an operator can clear it
 * without reading this source. Secret-free: folders and an assistant id only.
 */
export function formatHomeBindingRefusal(decision: HomeBindingDecision): string {
  if (decision.action !== 'refuse') return ''
  const who = decision.assistantId ? `agent ${decision.assistantId}` : 'this agent'
  return (
    `REFUSING to start: this folder is not ${who}'s home. That agent is bound to ` +
    `${decision.recordedHomeDir}, and this session was launched from ${decision.cwd}. ` +
    `A session started outside an agent's own folder used to resolve to it anyway and ` +
    `answer in its name, which is the impostor bug this check exists to stop. ` +
    `If this folder IS meant to be that agent, clear the binding by editing homeDir in ` +
    `its credentials file. If this session is meant to be a DIFFERENT agent, pin it with ` +
    `\`echo <id> > ${FOLDER_PIN_FILE}\` here or set BGOS_ASSISTANT_ID. To bypass this ` +
    `check for one boot, set ${ALLOW_ANY_FOLDER_ENV}=1.`
  )
}

/**
 * Record this folder as the agent's home, in place, preserving every other
 * field. Read-modify-write on the file we already resolved, so the token is
 * carried through untouched and never passes through a log line.
 *
 * Deliberately a NO-OP when the file already records a home: recording is a
 * one-time migration, not something a later boot can quietly move. Returns
 * true only when a home was actually written.
 *
 * Never throws. A read-only credentials file (or any other IO failure) leaves
 * the agent exactly as it is today, unbound and working, which is the correct
 * degradation for a guard: failing to write must not fail the boot.
 */
export function recordHomeDir(input: {
  path: string
  homeDir: string
  io?: { readText(path: string): string | null; writeFile(path: string, data: string): void }
}): boolean {
  const readText =
    input.io?.readText ?? ((p: string) => defaultReadText(p))
  const writeFile =
    input.io?.writeFile ?? ((p: string, data: string) => writeFileSync(p, data, { mode: 0o600 }))
  const home = str(input.homeDir).trim()
  if (!home) return false
  try {
    const raw = readText(input.path)
    if (raw == null) return false
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return false
    const creds = parsed as CredentialsFile
    if (str(creds.homeDir).trim()) return false
    creds.homeDir = home
    writeFile(input.path, `${JSON.stringify(creds, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}
