/** Shared runtime for the daemon and plain Node terminal commands. No credentials are logged. */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** @param {unknown} value */
function str(value) { return value == null ? '' : String(value) }
/** @param {Record<string, string | undefined>} env */
function configuredAssistantId(env) {
  const value = str(env.BGOS_ASSISTANT_ID).trim()
  return value && value !== '${user_config.assistant_id}' ? value : ''
}
/** @param {string} path */
function defaultReadText(path) {
  try { return readFileSync(path, 'utf8') } catch { return null }
}
/** @param {string} path */
function defaultListDir(path) {
  try { return readdirSync(path) } catch { return [] }
}
/** @param {string} cwd @param {(path: string) => string | null} readText */
function readFolderPinIdWith(cwd, readText) {
  if (!cwd) return ''
  const id = str(readText(join(cwd, '.bgos-agent-id'))).trim()
  return /^\d+$/.test(id) ? id : ''
}
/**
 * Is the shared legacy file THIS agent's own pairing (the layout from before per-agent files)?
 * Read only to compare the id; nothing from it is kept or logged.
 * @param {string} path @param {string} assistantId @param {(path: string) => string | null} readText
 */
function legacyIsAgents(path, assistantId, readText) {
  try {
    const parsed = JSON.parse(str(readText(path)))
    return parsed !== null && typeof parsed === 'object' && str(parsed.assistantId).trim() === assistantId
  } catch {
    return false
  }
}
/** @param {string} agentDir @param {(path: string) => string[]} listDir */
function listPerAssistantIds(agentDir, listDir) {
  return listDir(agentDir).map(name => /^credentials-(\d+)\.json$/.exec(name)?.[1])
    .filter(found => Boolean(found)).sort((a, b) => Number(a) - Number(b))
}

/**
 * @param {Parameters<typeof import('./agent-credentials.ts').resolveCredentialsSelection>[0]} opts
 * @returns {import('./agent-credentials.ts').CredentialsSelection}
 */
export function resolveCredentialsSelection(opts) {
  const env = opts.env ?? {}
  const exists = opts.exists ?? existsSync
  const readText = opts.readText ?? defaultReadText
  const listDir = opts.listDir ?? defaultListDir
  const cwd = str(opts.cwd).trim()
  const agentDir = dirname(opts.defaultPath)

  // Trimmed, matching the bgos-pair write side: a padded path must not make
  // the daemon read a different file than pairing wrote.
  const override = str(env.BGOS_CREDENTIALS_PATH).trim()
  if (override) return { kind: 'ok', path: override, via: 'env-path' }

  // A NAMED agent whose own file is missing (helperwedge finding 4, the production test's section 5
  // plant): the shared legacy file only when it is that same agent's pairing, else the agent's own
  // missing file under the route that named it, so the daemon has no pairing rather than another
  // agent's. Never another agent's sole per-agent file, never a legacy file paired to someone else.
  const ownOrNothing = (/** @type {string} */ id, /** @type {'env-assistant' | 'folder-pin'} */ via) =>
    exists(opts.defaultPath) && legacyIsAgents(opts.defaultPath, id, readText)
      ? /** @type {const} */ ({ kind: 'ok', path: opts.defaultPath, via: 'legacy' })
      : { kind: /** @type {const} */ ('ok'), path: join(agentDir, `credentials-${id}.json`), via }

  const assistantId = configuredAssistantId(env)
  if (assistantId) {
    const perAssistant = join(agentDir, `credentials-${assistantId}.json`)
    if (exists(perAssistant)) return { kind: 'ok', path: perAssistant, via: 'env-assistant' }
    // An explicit env pin, even a stale one, never triggers the refusal.
    return ownOrNothing(assistantId, 'env-assistant')
  }

  // No env pin from here: the folder is the only per-process anchor.
  const folderId = readFolderPinIdWith(cwd, readText)
  const ids = listPerAssistantIds(agentDir, listDir)
  if (folderId) {
    const pinned = join(agentDir, `credentials-${folderId}.json`)
    if (exists(pinned)) return { kind: 'ok', path: pinned, via: 'folder-pin' }
    // A pin pointing at a missing file is never obeyed as a pairing: the many-agent refusal still
    // stands, and otherwise only this agent's own pairing (never the sole one of another agent).
    if (ids.length > 1) return { kind: 'refuse', candidateIds: ids, agentDir }
    return ownOrNothing(folderId, 'folder-pin')
  }

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
 * @param {Parameters<typeof import('./agent-credentials.ts').resolveAuth>[0]} opts
 * @returns {import('./agent-credentials.ts').ResolvedAuth}
 */
export function resolveAuth(opts) {
  const env = opts.env ?? {}
  const creds = opts.creds ?? null
  const envAssistantId = configuredAssistantId(env)
  const hasConfiguredAssistantId = Boolean(envAssistantId)
  const pairingFileMatchesAssistant =
    !hasConfiguredAssistantId || str(creds?.assistantId) === envAssistantId
  // A usable pairing file that was read and REJECTED on assistant mismatch:
  // recorded so the call site can warn instead of silently degrading.
  const pairingFileRejection =
    !env.BGOS_PAIRING_TOKEN &&
    creds &&
    creds.pairingToken &&
    !pairingFileMatchesAssistant
      ? { fileAssistantId: str(creds.assistantId), configuredAssistantId: envAssistantId }
      : null

  let base

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

  const missing = []
  if (!base.backendUrl) missing.push('backendUrl')
  if (!base.userId) missing.push('userId')
  if (!base.assistantId) missing.push('assistantId')
  if (base.mode === 'pairing' && !base.pairingToken) missing.push('pairingToken')
  if (base.mode === 'apikey' && !base.apiKey) missing.push('apiKey')

  return { ...base, complete: missing.length === 0, missing, pairingFileRejection }
}
