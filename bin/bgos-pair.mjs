#!/usr/bin/env node
/**
 * bgos-pair: pair a Claude Code session to HOAI with a one time code.
 *
 * Runs on the host, shown by the HOAI app (Add agent, Claude Code):
 *
 *   npx --yes --package github:BrandGrowthOS/bgos-claude-plugin bgos-pair BGOS-XXXX-XX
 *
 * or, after the plugin is installed from the marketplace, as the slash command
 * /hoai:pair BGOS-XXXX-XX, or via the always-on installer: bgos-agent pair CODE.
 *
 * Flow (no raw account API key involved):
 *   1. POST <apiBase>/integrations/pair-exchange
 *      { code, deviceLabel, integration:"claude-code",
 *        agentCatalog:[{ agent_route:"claude", name:"Claude Code" }] }
 *      -> app-first (BGOS- code) returns { pairing_token, pairing_id, user_id }
 *   2. POST <apiBase>/integrations/pairings/<id>/agent-catalog  (X-BGOS-Pairing)
 *      { agents:[{ agent_route:"claude", name:"Claude Code" }] }  // fires pair_ready
 *   3. POST <apiBase>/integrations/pairings/<id>/assistants  (X-BGOS-Pairing)
 *      binds the single Claude agent (self bind; one agent, nothing to pick)
 *   4. poll GET <apiBase>/integrations/me until the bound assistant appears,
 *      then resolve WHICH assistant this session is (never guessed: an
 *      explicit --assistant-id / BGOS_ASSISTANT_ID must match what bound, and
 *      several bound agents with no explicit choice is an error, not a pick)
 *   5. write ~/.bgos-agent/credentials-<assistantId>.json (dir 0700, file
 *      0600; BGOS_CREDENTIALS_PATH overrides; legacy credentials.json only
 *      when no assistant is bound yet) with
 *      { backendUrl, pairingToken, pairingId, userId, assistantId, pairedAt },
 *      then verify the written file actually resolves for that assistant
 *
 * server.ts reads that file, sends X-BGOS-Pairing, and the session is live.
 *
 * Self-contained plain JavaScript: node >= 18 builtins only, no imports from
 * the TS plugin sources. Import-safe: every helper is exported and main() only
 * runs when the file is executed directly, so tests can import the pure pieces.
 *
 * The pairing token is a device credential. It is never printed, logged, or
 * echoed; only the file path and non-secret status lines are shown.
 */

import { mkdir, writeFile, chmod } from 'node:fs/promises'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

export const DEFAULT_API_BASE = 'https://api.brandgrowthos.ai/api/v1'
export const CLAUDE_INTEGRATION = 'claude-code'
export const CLAUDE_AGENT_ROUTE = 'claude'
export const CLAUDE_AGENT_NAME = 'Claude Code'
/** credentials.json holds the pairing token; owner read/write only. */
export const CREDENTIALS_FILE_MODE = 0o600
export const CREDENTIALS_DIR_MODE = 0o700

// The plugin version, used as daemonVersion so the backend can flag stale bridges.
// Read lazily from package.json so it stays in lockstep without a build step.
export const PLUGIN_VERSION = readPluginVersion()

// ── Small pure helpers ───────────────────────────────────────────────────────

/** Ensure the API base always ends in exactly one /api/v1 (never doubled). */
export function normalizeApiBase(url) {
  let base = String(url ?? '').trim().replace(/\/+$/, '')
  if (!base) return DEFAULT_API_BASE
  if (!/\/api\/v1$/.test(base)) base = `${base}/api/v1`
  return base
}

/**
 * Pull a pair code out of raw input: a bare code, a pasted command that ends in
 * the code, or surrounding whitespace. Codes are uppercase letters, digits, and
 * dashes, 4..64 chars. Returns '' when nothing looks like a code.
 */
export function extractPairCode(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  const tokens = value.split(/\s+/)
  // A bare, single token is trusted as the code when it is the right shape.
  if (tokens.length === 1) {
    const up = tokens[0].toUpperCase()
    return /^[A-Z0-9-]{4,64}$/.test(up) ? up : ''
  }
  // In a multi word paste (a full command line), only a token with a known
  // pair-code prefix is treated as the code, so trailing English words are
  // never mistaken for one. The code trails the command, and the command name
  // "bgos-pair" also carries the prefix, so take the LAST matching token.
  let found = ''
  for (const token of tokens) {
    const up = token.toUpperCase()
    if (/^(BGOS|OC)-[A-Z0-9]{2,}(-[A-Z0-9]+)+$/.test(up)) found = up
  }
  return found
}

export function parsePairArgs(argv) {
  const args = { code: '', apiBase: DEFAULT_API_BASE, assistantId: '', help: false }
  const errors = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      args.help = true
    } else if (arg === '--backend' || arg === '--api-base') {
      const value = argv[++i]
      if (!value) errors.push(`${arg} needs a value`)
      else args.apiBase = normalizeApiBase(value)
    } else if (arg === '--assistant-id') {
      const value = argv[++i]
      if (!value) errors.push(`${arg} needs a value`)
      else args.assistantId = String(value).trim()
    } else if (arg.startsWith('-')) {
      errors.push(`unknown flag: ${arg}`)
    } else if (!args.code) {
      args.code = extractPairCode(arg)
      if (!args.code) errors.push(`that does not look like a pair code: ${arg}`)
    } else {
      errors.push(`unexpected extra argument: ${arg}`)
    }
  }
  if (!args.help && !args.code && errors.length === 0) {
    errors.push('missing pair code')
  }
  return { args, errors }
}

/** The single catalog entry for a Claude Code session. */
export function claudeCatalogEntry() {
  return { agent_route: CLAUDE_AGENT_ROUTE, name: CLAUDE_AGENT_NAME }
}

/**
 * POST /integrations/pair-exchange body.
 *
 * `intendedAssistantId` is the identity the operator pinned (--assistant-id /
 * BGOS_ASSISTANT_ID, via resolveRequestedAssistantId). When it is a positive
 * integer id the body carries `intended_assistant_id` (number, snake_case:
 * part of the cross-repo exchange contract, pinned identically in the
 * backend's PairExchangeDto). The backend's mint-time overlap guard then
 * scopes its overlap unit to the pairing serving THAT assistant, instead of
 * the agent catalog, whose entry is identical across every Claude daemon and
 * therefore made every multi-agent account look like a conflict (the
 * 2026-08-04 fleet-wide pairing freeze). Omitted when nothing was pinned:
 * older backends whitelist-strip unknown fields, so sending nothing keeps the
 * legacy single-agent flow byte-identical.
 */
export function buildExchangeBody({ code, deviceLabel, version, intendedAssistantId }) {
  const body = {
    code,
    deviceLabel,
    integration: CLAUDE_INTEGRATION,
    agentCatalog: [claudeCatalogEntry()],
    daemonVersion: version ?? PLUGIN_VERSION,
  }
  const pinned = Number(String(intendedAssistantId ?? '').trim())
  if (Number.isInteger(pinned) && pinned > 0 && /^\d+$/.test(String(intendedAssistantId).trim())) {
    body.intended_assistant_id = pinned
  }
  return body
}

/** POST /integrations/pairings/:id/agent-catalog body (fires pair_ready). */
export function buildCatalogBody() {
  return { agents: [claudeCatalogEntry()] }
}

/**
 * Classify a pair-exchange response. App-first BGOS- codes return a 2xx body
 * carrying pairing_token. Daemon-first OC- codes (tolerated for robustness)
 * return a 200 body with an RFC 8628 status field. Anything else is an error.
 */
export function classifyExchangeResponse(status, body) {
  const b = body && typeof body === 'object' ? body : {}
  if (typeof b.pairing_token === 'string' && b.pairing_token) {
    return {
      kind: 'ok',
      pairingToken: b.pairing_token,
      pairingId: b.pairing_id,
      userId: b.user_id,
    }
  }
  const rfc = typeof b.status === 'string' ? b.status : ''
  if (rfc === 'authorization_pending') return { kind: 'pending' }
  if (rfc === 'slow_down') return { kind: 'slow_down' }
  if (rfc === 'access_denied') return { kind: 'denied' }
  if (rfc === 'expired_token') return { kind: 'expired' }
  const message =
    b.message || b.code || (status ? `HTTP ${status}` : 'pair exchange failed')
  return { kind: 'error', message: String(message) }
}

/** The unsubstituted plugin userConfig placeholder is not a real assistant id. */
const ASSISTANT_ID_PLACEHOLDER = '${user_config.assistant_id}'

/**
 * The assistant the operator asked for: the --assistant-id flag beats the
 * BGOS_ASSISTANT_ID env var; the unsubstituted placeholder is ignored.
 * Returns '' when nothing was requested.
 * @param {{ argAssistantId?: string, env?: Record<string, string | undefined> }} [opts]
 */
export function resolveRequestedAssistantId({ argAssistantId, env } = {}) {
  const fromArg = String(argAssistantId ?? '').trim()
  if (fromArg) return fromArg
  const fromEnv = String(env?.BGOS_ASSISTANT_ID ?? '').trim()
  if (fromEnv && fromEnv !== ASSISTANT_ID_PLACEHOLDER) return fromEnv
  return ''
}

/**
 * Resolve which bound assistant this pairing is for. NEVER guesses on a
 * many-agent account (guessing is how a pairing intended for one agent was
 * silently written for another):
 *   - requested id bound        -> { kind:'ok', assistantId }
 *   - requested id NOT bound    -> { kind:'mismatch', requestedId, boundIds }
 *   - no request, exactly one   -> { kind:'ok', assistantId }
 *   - no request, several bound -> { kind:'ambiguous', candidates } (listed,
 *                                  the operator must rerun with --assistant-id)
 *   - nothing bound             -> { kind:'none' }
 */
export function selectAssistantBinding(meResponse, requestedId = '') {
  const list = Array.isArray(meResponse?.assistants) ? meResponse.assistants : []
  const candidates = list.filter((a) => a && a.assistant_id != null)
  if (candidates.length === 0) return { kind: 'none' }
  const requested = String(requestedId ?? '').trim()
  if (requested) {
    const match = candidates.find((a) => String(a.assistant_id) === requested)
    if (match) return { kind: 'ok', assistantId: match.assistant_id }
    return {
      kind: 'mismatch',
      requestedId: requested,
      boundIds: candidates.map((a) => String(a.assistant_id)),
    }
  }
  if (candidates.length === 1) return { kind: 'ok', assistantId: candidates[0].assistant_id }
  return {
    kind: 'ambiguous',
    candidates: candidates.map((a) => ({
      assistant_id: a.assistant_id,
      agent_route: a.agent_route ?? '',
      name: a.name ?? '',
    })),
  }
}

/** The exact durable credentials shape server.ts reads. */
export function buildCredentials({
  backendUrl,
  pairingToken,
  pairingId,
  userId,
  assistantId,
  nowIso,
}) {
  return {
    backendUrl: String(backendUrl),
    pairingToken: String(pairingToken),
    pairingId,
    userId: String(userId),
    assistantId,
    pairedAt: nowIso,
  }
}

/** The legacy single-slot credentials file (pre-per-assistant fleet). */
export function credentialsPath(home = homedir()) {
  return join(home, '.bgos-agent', 'credentials.json')
}

/** The per-assistant credentials file next to the legacy one. */
export function perAssistantCredentialsPath(home, assistantId) {
  return join(home, '.bgos-agent', `credentials-${String(assistantId).trim()}.json`)
}

/**
 * Where a NEW pairing is written. Per-assistant by default so N agents under
 * one OS user never overwrite each other's slot; BGOS_CREDENTIALS_PATH wins
 * outright when set; the legacy single file only when no assistant is bound
 * yet (the app finishes binding later).
 * @param {{ home?: string, assistantId?: string | number | null, env?: Record<string, string | undefined> }} [opts]
 */
export function credentialsWritePath({ home = homedir(), assistantId = null, env = {} } = {}) {
  const override = String(env?.BGOS_CREDENTIALS_PATH ?? '').trim()
  if (override) return override
  const id = String(assistantId ?? '').trim()
  if (id) return perAssistantCredentialsPath(home, id)
  return credentialsPath(home)
}

/**
 * Read-order mirror of lib/agent-credentials.ts resolveCredentialsPath, kept
 * in plain JS because bgos-pair must not import TS sources (it runs under
 * bare node via npx). A test pins the two against each other so they cannot
 * drift: BGOS_CREDENTIALS_PATH, else an existing credentials-<id>.json for
 * the configured BGOS_ASSISTANT_ID, else the legacy credentials.json.
 * @param {{ env?: Record<string, string | undefined>, home?: string, exists?: (path: string) => boolean }} [opts]
 */
export function resolveReadCredentialsPath({ env = {}, home = homedir(), exists = existsSync } = {}) {
  const override = String(env?.BGOS_CREDENTIALS_PATH ?? '').trim()
  if (override) return override
  const id = String(env?.BGOS_ASSISTANT_ID ?? '').trim()
  if (id && id !== ASSISTANT_ID_PLACEHOLDER) {
    const perAssistant = perAssistantCredentialsPath(home, id)
    if (exists(perAssistant)) return perAssistant
  }
  return credentialsPath(home)
}

/**
 * Post-write verification: prove the file just written is the file the daemon
 * will actually read for the intended assistant, and that it carries that
 * assistant. Pairing may not exit 0 on an unverified write; a wrong-assistant
 * write once passed as success precisely because nothing validated it.
 * @param {{ path: string, expectedAssistantId?: string, home?: string,
 *           env?: Record<string, string | undefined>,
 *           read?: (path: string, encoding: string) => string,
 *           exists?: (path: string) => boolean }} opts
 */
export function verifyWrittenCredentials({
  path,
  expectedAssistantId = '',
  home = homedir(),
  env = {},
  read = readFileSync,
  exists = existsSync,
}) {
  const expected = String(expectedAssistantId ?? '').trim()
  const readEnv = { ...env }
  if (expected) readEnv.BGOS_ASSISTANT_ID = expected
  const resolved = resolveReadCredentialsPath({ env: readEnv, home, exists })
  if (resolved !== path) {
    return {
      ok: false,
      reason:
        `the daemon would read ${resolved}, not the file just written at ${path}` +
        (readEnv.BGOS_CREDENTIALS_PATH ? ' (BGOS_CREDENTIALS_PATH points elsewhere)' : ''),
    }
  }
  let creds
  try {
    creds = JSON.parse(read(path, 'utf8'))
  } catch (err) {
    return { ok: false, reason: `could not read back ${path}: ${err?.message ?? err}` }
  }
  if (!creds || typeof creds !== 'object' || !creds.pairingToken) {
    return { ok: false, reason: `${path} has no pairingToken` }
  }
  if (expected && String(creds.assistantId ?? '') !== expected) {
    return {
      ok: false,
      reason:
        `${path} resolves to assistantId ${creds.assistantId ?? '<none>'}, ` +
        `not the intended ${expected}`,
    }
  }
  // Second probe with the REAL, uninjected env: would a daemon started with
  // exactly this environment (no BGOS_ASSISTANT_ID pin) still find this
  // pairing? If not, the operator MUST pin the env, and main() says so
  // unconditionally instead of the pairing quietly relying on an env var
  // nobody set.
  const realEnvPath = resolveReadCredentialsPath({ env, home, exists })
  let needsEnvPin = !samePath(realEnvPath, path)
  if (needsEnvPin) {
    try {
      const other = JSON.parse(read(realEnvPath, 'utf8'))
      if (
        other &&
        other.pairingToken === creds.pairingToken &&
        String(other.assistantId ?? '') === String(creds.assistantId ?? '')
      ) {
        needsEnvPin = false
      }
    } catch {
      // unreadable or absent: the pin stays required.
    }
  }
  return { ok: true, needsEnvPin, realEnvPath }
}

/** Path equality tolerant of symlinks and spelling differences. */
function samePath(a, b) {
  if (a === b) return true
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/** Best-effort JSON read; null when absent or unparsable. */
function loadJsonSafe(path, read = readFileSync) {
  try {
    const parsed = JSON.parse(read(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * May the legacy single-slot file be co-written for this pairing? Yes when it
 * is absent, junk, or already this same assistant (a refresh); NEVER when it
 * holds another agent's pairing, which is the overwrite bug this exists to
 * prevent. The co-write is what keeps a daemon with an EMPTY env (packaged
 * plugin, no BGOS_ASSISTANT_ID configured) finding its pairing, as 0.31.0 did.
 * @param {{ legacyCreds?: { pairingToken?: string, assistantId?: string | number | null } | null, assistantId?: string | number | null }} opts
 */
export function shouldCoWriteLegacy({ legacyCreds, assistantId } = {}) {
  const id = String(assistantId ?? '').trim()
  if (!id) return false
  if (!legacyCreds || !legacyCreds.pairingToken) return true
  return String(legacyCreds.assistantId ?? '') === id
}

/**
 * True when an UNBOUND (assistantId null) pairing write would clobber a live
 * pairing that belongs to a bound assistant. Refusing is mandatory: this is
 * exactly how one agent's pairing silently transferred to another.
 * @param {{ pairingToken?: string, assistantId?: string | number | null } | null | undefined} existingCreds
 */
export function legacyWriteBlocked(existingCreds) {
  return Boolean(
    existingCreds &&
      existingCreds.pairingToken &&
      String(existingCreds.assistantId ?? '').trim() !== '',
  )
}

/**
 * The whole write step: pick the path, guard the legacy slot, write, co-write
 * the legacy file when safe, and verify the result resolves for the intended
 * assistant. Composed here (not inline in main) so tests can drive the real
 * flow against a temp HOME.
 * @param {{ creds: { pairingToken: string, assistantId?: string | number | null },
 *           env?: Record<string, string | undefined>, home?: string }} opts
 */
export async function writeAndVerifyCredentials({ creds, env = {}, home = homedir() }) {
  const assistantId = creds.assistantId
  const boundId = String(assistantId ?? '').trim()
  const path = credentialsWritePath({ home, assistantId, env })

  if (!boundId) {
    const existing = loadJsonSafe(path)
    if (legacyWriteBlocked(existing)) {
      return {
        ok: false,
        path,
        legacyCoWritePath: null,
        reason:
          `refusing to overwrite ${path}: it holds a live pairing for ` +
          `assistant ${existing.assistantId}. Rerun with --assistant-id <id> ` +
          `or set BGOS_CREDENTIALS_PATH to a fresh file.`,
      }
    }
  }

  await writeCredentialsFile(path, creds)

  let legacyCoWritePath = null
  const override = String(env?.BGOS_CREDENTIALS_PATH ?? '').trim()
  if (boundId && !override) {
    const legacy = credentialsPath(home)
    if (!samePath(legacy, path) && shouldCoWriteLegacy({ legacyCreds: loadJsonSafe(legacy), assistantId })) {
      await writeCredentialsFile(legacy, creds)
      legacyCoWritePath = legacy
    }
  }

  const verified = verifyWrittenCredentials({
    path,
    expectedAssistantId: boundId,
    home,
    env,
  })
  if (!verified.ok) return { ok: false, path, legacyCoWritePath, reason: verified.reason }
  return {
    ok: true,
    path,
    legacyCoWritePath,
    needsEnvPin: verified.needsEnvPin,
    realEnvPath: verified.realEnvPath,
  }
}

/**
 * Honest restart guidance for BOTH known topologies; pairing cannot know which
 * one this host uses, so it never prescribes a single channel form.
 */
export function restartInstructions() {
  return [
    'restart your agent process the way it normally starts. Known channel forms:',
    '  claude --dangerously-load-development-channels plugin:hoai@hoai',
    '    (packaged HOAI channel installed from the plugin marketplace)',
    '  claude --dangerously-load-development-channels server:bgos',
    '    (checkout-based host running server.ts directly, e.g. a multi-agent server)',
  ]
}

export const USAGE = `bgos-pair: pair this Claude Code session to HOAI with a one time code

Usage:
  npx --yes --package github:BrandGrowthOS/bgos-claude-plugin bgos-pair BGOS-XXXX-XX

Options:
  --backend <url>        backend base (default ${DEFAULT_API_BASE})
  --assistant-id <id>    the HOAI assistant this session pairs as; required on
                         accounts with several bound agents (BGOS_ASSISTANT_ID
                         env is honoured as the fallback). If the pairing would
                         resolve to a different assistant, nothing is written.
  -h, --help             show this help

Get a code in the HOAI app: Add agent, then Claude Code. The code links this
computer to your account, works once, and expires in 10 minutes.

Credentials are written per assistant (~/.bgos-agent/credentials-<id>.json, or
BGOS_CREDENTIALS_PATH when set), so several agents can pair under one OS user.
`

// ── Effectful pieces (kept small; main() composes them) ──────────────────────

function readPluginVersion() {
  try {
    // package.json sits one level up from bin/.
    const url = new URL('../package.json', import.meta.url)
    return JSON.parse(readFileSync(url, 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Write credentials.json with mode 600 (dir 700). writeFile mode is
 *  umask-affected, so an explicit chmod pins the exact bits. */
export async function writeCredentialsFile(path, creds) {
  await mkdir(dirname(path), { recursive: true, mode: CREDENTIALS_DIR_MODE })
  await chmod(dirname(path), CREDENTIALS_DIR_MODE).catch(() => {})
  await writeFile(path, `${JSON.stringify(creds, null, 2)}\n`, {
    mode: CREDENTIALS_FILE_MODE,
  })
  await chmod(path, CREDENTIALS_FILE_MODE)
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return readBody(res)
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers } })
  return readBody(res)
}

async function readBody(res) {
  const text = await res.text().catch(() => '')
  let body = null
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: res.status, ok: res.ok, body }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── main ─────────────────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2)) {
  const { args, errors } = parsePairArgs(argv)
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`[bgos-pair] ${error}`)
    process.stdout.write(USAGE)
    return 2
  }

  const apiBase = args.apiBase
  const deviceLabel = `${hostname()} (Claude Code)`

  // Resolved BEFORE the exchange: the pinned identity travels IN the exchange
  // body (intended_assistant_id) so the backend's overlap guard judges the
  // pairing against the agent this machine actually serves, not against every
  // Claude pairing on the account.
  const requestedId = resolveRequestedAssistantId({
    argAssistantId: args.assistantId,
    env: process.env,
  })
  if (requestedId) {
    console.log(`[bgos-pair] pairing as assistant ${requestedId} (explicitly requested)`)
  }

  console.log('[bgos-pair] pairing this computer with your HOAI account...')
  let exchange
  try {
    exchange = await postJson(`${apiBase}/integrations/pair-exchange`, buildExchangeBody({
      code: args.code,
      deviceLabel,
      intendedAssistantId: requestedId,
    }))
  } catch (err) {
    console.error(`[bgos-pair] could not reach the backend: ${err?.message ?? err}`)
    console.error('[bgos-pair] check this computer\'s internet connection and try again.')
    return 1
  }
  const classified = classifyExchangeResponse(exchange.status, exchange.body)
  if (classified.kind !== 'ok') {
    if (classified.kind === 'expired') {
      console.error('[bgos-pair] that code has expired. Codes last 10 minutes. Get a new one in the HOAI app.')
    } else if (classified.kind === 'denied') {
      console.error('[bgos-pair] the pairing request was denied.')
    } else {
      console.error(`[bgos-pair] pairing failed: ${classified.message ?? classified.kind}`)
    }
    return 1
  }
  const { pairingToken, pairingId, userId } = classified

  const pairId = encodeURIComponent(String(pairingId))

  // Push the catalog so the app's Add-agent screen advances (fires pair_ready).
  // Best effort: the exchange already carried the catalog.
  try {
    await postJson(
      `${apiBase}/integrations/pairings/${pairId}/agent-catalog`,
      buildCatalogBody(),
      { 'X-BGOS-Pairing': pairingToken },
    )
  } catch {
    // non-fatal: the exchange catalog is enough to bind below.
  }

  // Bind the single Claude agent ourselves. A Claude Code session is one agent,
  // so there is nothing for the user to pick: the pairing token is the account
  // owner, so it can create the bound assistant directly (the bind route is
  // owner scoped and accepts a pairing token). This makes pairing self
  // sufficient on every host, with or without the app watching, and there is
  // exactly one binder so no duplicate assistants.
  try {
    await postJson(
      `${apiBase}/integrations/pairings/${pairId}/assistants`,
      buildCatalogBody(),
      { 'X-BGOS-Pairing': pairingToken },
    )
  } catch (err) {
    // If binding fails (for example the app already bound), fall through to the
    // poll below, which finds whatever assistant ended up bound.
    console.error(`[bgos-pair] note: could not bind the agent automatically (${err?.message ?? err}); checking the app...`)
  }

  console.log('[bgos-pair] paired. Adding your agent...')
  let binding = { kind: 'none' }
  let okPolls = 0
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    let me
    try {
      me = await getJson(`${apiBase}/integrations/me`, { 'X-BGOS-Pairing': pairingToken })
    } catch {
      me = { ok: false }
    }
    if (me.ok) {
      okPolls++
      binding = selectAssistantBinding(me.body, requestedId)
      if (binding.kind === 'ok' || binding.kind === 'ambiguous') break
      // 'mismatch' keeps polling: the requested binding may still propagate.
    }
    await sleep(1500)
  }

  if (binding.kind === 'mismatch') {
    console.error(
      `[bgos-pair] REFUSING to write credentials: you asked to pair assistant ${binding.requestedId}, ` +
        `but this pairing resolved to assistant ${binding.boundIds.join(', ')}.`,
    )
    console.error('[bgos-pair] nothing was written. Check the id in the HOAI app and rerun with --assistant-id <id>.')
    return 1
  }
  if (binding.kind === 'ambiguous') {
    console.error('[bgos-pair] this account has several bound agents; refusing to guess which one this session is:')
    for (const c of binding.candidates) {
      console.error(`[bgos-pair]   --assistant-id ${c.assistant_id}  ${c.name || c.agent_route}`.trimEnd())
    }
    console.error('[bgos-pair] nothing was written. Rerun with --assistant-id <id> (or set BGOS_ASSISTANT_ID).')
    return 1
  }
  if (binding.kind === 'none' && requestedId) {
    if (okPolls === 0) {
      console.error(
        `[bgos-pair] could not confirm assistant ${requestedId}: every status poll failed (backend unreachable).`,
      )
      console.error('[bgos-pair] nothing was written. Check this computer\'s connection and rerun.')
    } else {
      console.error(
        `[bgos-pair] REFUSING to write credentials: assistant ${requestedId} was requested but did not appear bound within 60s.`,
      )
      console.error('[bgos-pair] nothing was written. Finish "Add agent" in the HOAI app, then rerun.')
    }
    return 1
  }

  const assistantId = binding.kind === 'ok' ? binding.assistantId : null
  const creds = buildCredentials({
    backendUrl: apiBase,
    pairingToken,
    pairingId,
    userId,
    assistantId,
    nowIso: new Date().toISOString(),
  })
  // Write per-assistant, co-write the legacy slot when that cannot clobber
  // another agent, then verify the result actually resolves for the intended
  // assistant. Never report success on an unverified or refused write.
  const result = await writeAndVerifyCredentials({ creds, env: process.env })
  if (!result.ok) {
    console.error(`[bgos-pair] pairing NOT saved: ${result.reason}`)
    return 1
  }

  console.log(`[bgos-pair] wrote ${result.path} (chmod 600)`)
  if (result.legacyCoWritePath) {
    console.log(`[bgos-pair] also refreshed ${result.legacyCoWritePath} (same agent, single-agent hosts read it)`)
  }
  if (assistantId == null) {
    console.log('[bgos-pair] paired, but no agent is bound yet. Finish "Add agent" in the HOAI app,')
    console.log('[bgos-pair] then start Claude Code with the HOAI channel and it will pick up the binding.')
  } else {
    console.log(`[bgos-pair] verified: this file resolves to assistant ${assistantId}.`)
    if (result.needsEnvPin) {
      console.log(
        `[bgos-pair] REQUIRED: set BGOS_ASSISTANT_ID=${assistantId} ` +
          `(or BGOS_CREDENTIALS_PATH=${result.path}) in this agent's environment. ` +
          `Without it the daemon reads ${result.realEnvPath}, which belongs to a different pairing.`,
      )
    }
    console.log('[bgos-pair] done. To go live,')
    for (const line of restartInstructions()) console.log(`[bgos-pair] ${line}`)
  }
  return 0
}

/**
 * True when this file is the process entry point. Compares REAL paths on both
 * sides so a symlinked bin (npm/npx puts a shim in node_modules/.bin, and paths
 * under /tmp resolve through /private/tmp on macOS) still runs main(); a plain
 * href compare would fail those and silently do nothing.
 */
export function isRunAsMain(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (typeof argv1 !== 'string') return false
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1)
  } catch {
    return moduleUrl === pathToFileURL(argv1).href
  }
}

if (isRunAsMain()) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      console.error(`[bgos-pair] fatal: ${err?.message ?? err}`)
      process.exitCode = 1
    })
}
