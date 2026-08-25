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
 *      dedupe the legacy single-slot file (a junk or stale same-agent
 *      credentials.json is deleted, another agent's live pairing is left
 *      alone), then verify the written file actually resolves for that
 *      assistant
 *
 * server.ts reads that file, sends X-BGOS-Pairing, and the session is live.
 *
 * Self-contained plain JavaScript: node >= 18 builtins only, no imports from
 * the TS plugin sources (the sibling plain-JS bin/bgos-install-method.mjs is
 * the one local import). Import-safe: every helper is exported and main() only
 * runs when the file is executed directly, so tests can import the pure pieces.
 *
 * The pairing token is a device credential. It is never printed, logged, or
 * echoed; only the file path and non-secret status lines are shown.
 */

import { execFile } from 'node:child_process'
import { mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join, dirname, win32 as win32Path } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { detectInstallMethod } from './bgos-install-method.mjs'

export const DEFAULT_API_BASE = 'https://api.brandgrowthos.ai/api/v1'
export const CLAUDE_INTEGRATION = 'claude-code'
export const CLAUDE_AGENT_ROUTE = 'claude'
export const CLAUDE_AGENT_NAME = 'Claude Code'
/** credentials.json holds the pairing token; owner read/write only. */
export const CREDENTIALS_FILE_MODE = 0o600
export const CREDENTIALS_DIR_MODE = 0o700
export const PAIR_EXIT_CODES = Object.freeze({
  DONE: 0,
  UNEXPECTED_ERROR: 1,
  SERVER_REFUSED: 2,
  PIN_REQUIRED: 3,
})

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
  const args = {
    code: '',
    apiBase: DEFAULT_API_BASE,
    assistantId: '',
    help: false,
    allowUnpinned: false,
  }
  const errors = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      args.help = true
    } else if (arg === '--backend' || arg === '--api-base') {
      const value = argv[++i]
      if (!value) errors.push(`${arg} needs a value`)
      else args.apiBase = normalizeApiBase(value)
    } else if (arg === '--allow-unpinned') {
      // Escape hatch for a flow that sets BGOS_ASSISTANT_ID afterwards. It
      // suppresses the refusal, never the warning: the operator still gets
      // told exactly what the daemon would read.
      args.allowUnpinned = true
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
 *
 * @param {{
 *   code: string,
 *   deviceLabel: string,
 *   version?: string,
 *   intendedAssistantId?: string | number | null,
 * }} input
 */
export function buildExchangeBody({ code, deviceLabel, version, intendedAssistantId }) {
  /** @type {{
   *   code: string,
   *   deviceLabel: string,
   *   integration: string,
   *   agentCatalog: Array<{ agent_route: string, name: string }>,
   *   daemonVersion: string,
   *   intended_assistant_id?: number,
   * }} */
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
 * Which OTHER agents already have a per-assistant credentials file here.
 *
 * This is how the host answers "am I a multi-agent machine" without asking an
 * operator to remember a flag. Returns [] when the directory is missing or
 * unreadable, so an unknown host is treated as single-agent and behaviour is
 * unchanged.
 */
export function otherPerAssistantIds(home, assistantId) {
  const id = String(assistantId ?? '').trim()
  let entries = []
  try {
    entries = readdirSync(join(home, '.bgos-agent'))
  } catch {
    return []
  }
  return entries
    .map((name) => /^credentials-(\d+)\.json$/.exec(name)?.[1])
    .filter((found) => found && found !== id)
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

/**
 * Did this pairing actually leave the daemon able to find it?
 *
 * "REQUIRED: set BGOS_ASSISTANT_ID" used to be prose in a stream of output
 * while the command still exited 0, so a pairing that CANNOT work reported
 * success and the operator discovered it at the next restart, when the daemon
 * resolved a different agent's file (Ava, 871, 2026-08-05).
 *
 * On a host where other agents already have credentials files, an unpinned
 * pairing is not a warning, it is a wrong answer waiting for a restart: the
 * daemon will read one of THEIR files. Exit 3 so a human or a script
 * cannot mistake it for done.
 *
 * A single-agent host keeps exit 0: there is no other file to resolve to, so
 * refusing would be theatre. And the refusal is escapable with
 * --allow-unpinned, for a flow that sets the environment afterwards; knowing
 * beats blocked.
 */
export function pairExitCode({ needsEnvPin, otherAgentCount, allowUnpinned, folderPinLiveSafe } = {}) {
  if (!needsEnvPin) return PAIR_EXIT_CODES.DONE
  if (allowUnpinned) return PAIR_EXIT_CODES.DONE
  // A VERIFIED launch-folder pin IS a pin (2026-08-23, MacBook-Air-2): on a
  // ten-agent host, one-click paired successfully server-side, the CLI exited
  // 3 anyway because this verdict only honored the ENV pin, the app read the
  // nonzero as pair-failed, and the retry then bounced off the mint guard's
  // 409 because the first pairing WAS live. The daemon's own resolver
  // (lib/agent-credentials.ts rule 3) resolves the folder pin with no env
  // var, so a pairing whose baked pin provably resolves from its launch
  // folder is live-safe and must say DONE.
  if (folderPinLiveSafe) return PAIR_EXIT_CODES.DONE
  return Number(otherAgentCount ?? 0) > 0
    ? PAIR_EXIT_CODES.PIN_REQUIRED
    : PAIR_EXIT_CODES.DONE
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
 * After the per-assistant write, what happens to the legacy single-slot
 * credentials.json? -> 'delete' | 'keep'. The caller only consults this when a
 * legacy file actually exists, so a null legacyCreds here means unreadable or
 * unparsable, not absent.
 *
 * This REPLACES the legacy co-write (shouldCoWriteLegacy, removed 2026-08-22).
 * The co-write kept a daemon with an EMPTY env (packaged plugin, no
 * BGOS_ASSISTANT_ID configured) finding its pairing at the default path, as
 * 0.31.0 did, but it did so by maintaining a second live copy of the pairing
 * token, and that duplicate WAS the single-slot identity trap: on
 * KC-WINSAMSUNG (Mark, 888, 2026-08-06) the tool behaved four different ways
 * across four pairings, and deleting the file between pairings was exactly
 * the absence that made the next pairing rewrite it. The read side has since
 * grown the folder-aware boot resolver (lib/agent-credentials.ts
 * resolveCredentialsSelection, rule 4): a SOLE credentials-<id>.json with NO
 * legacy file next to it resolves for an empty env on its own. So the legacy
 * copy is no longer a safety net anywhere, and pairing now DEDUPES at write
 * time instead of co-writing:
 *
 *   - unbound write (no assistantId): 'keep'. The unbound flow writes the
 *     legacy slot itself and owns it; deleting here would eat its own write.
 *   - legacy unreadable / unparsable / tokenless junk: 'delete'. Junk at the
 *     default path shadows rule 4 (any legacy file, even garbage, disables
 *     the sole-per-assistant resolution), so it must go.
 *   - legacy holds THIS assistant: 'delete'. The per-assistant file just
 *     written is the single source of truth; a stale same-agent copy is the
 *     next wrong-token incident waiting for a restart.
 *   - legacy holds ANOTHER agent's live pairing: 'keep'. Not ours to remove;
 *     that agent's empty-env daemon may still be reading it.
 * @param {{ legacyCreds?: { pairingToken?: string, assistantId?: string | number | null } | null, assistantId?: string | number | null }} opts
 * @returns {'delete' | 'keep'}
 */
export function dedupeLegacyAfterWrite({ legacyCreds, assistantId } = {}) {
  const id = String(assistantId ?? '').trim()
  if (!id) return 'keep'
  if (!legacyCreds || !legacyCreds.pairingToken) return 'delete'
  return String(legacyCreds.assistantId ?? '') === id ? 'delete' : 'keep'
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
 * The whole write step: pick the path, guard the legacy slot, write, DEDUPE
 * the legacy single-slot file (delete it when it is junk or this same agent's
 * stale copy, never when it is another agent's live pairing), and verify the
 * result resolves for the intended assistant. Composed here (not inline in
 * main) so tests can drive the real flow against a temp HOME.
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
        legacyDeduped: null,
        legacyKeptForOtherAgent: null,
        reason:
          `refusing to overwrite ${path}: it holds a live pairing for ` +
          `assistant ${existing.assistantId}. Rerun with --assistant-id <id> ` +
          `or set BGOS_CREDENTIALS_PATH to a fresh file.`,
      }
    }
  }

  const protection = await writeCredentialsFile(path, creds)

  // Dedupe the legacy single-slot file AFTER the per-assistant write landed
  // (never before: an early delete followed by a failed write would leave the
  // host with no credentials at all). Only a file that actually exists is
  // judged; recording a "removed" for a file that was never there would be a
  // false print.
  let legacyDeduped = null
  let legacyDedupedHeldSameAgent = false
  let legacyKeptForOtherAgent = null
  const override = String(env?.BGOS_CREDENTIALS_PATH ?? '').trim()
  const legacy = credentialsPath(home)
  if (boundId && !override && !samePath(legacy, path) && existsSync(legacy)) {
    const legacyCreds = loadJsonSafe(legacy)
    if (dedupeLegacyAfterWrite({ legacyCreds, assistantId }) === 'delete') {
      await rm(legacy, { force: true })
      legacyDeduped = legacy
      legacyDedupedHeldSameAgent = Boolean(legacyCreds && legacyCreds.pairingToken)
    } else {
      legacyKeptForOtherAgent = String(legacyCreds?.assistantId ?? '')
    }
  }

  const verified = verifyWrittenCredentials({
    path,
    expectedAssistantId: boundId,
    home,
    env,
  })
  if (!verified.ok)
    return {
      ok: false,
      path,
      legacyDeduped,
      legacyDedupedHeldSameAgent,
      legacyKeptForOtherAgent,
      reason: verified.reason,
    }

  // The needsEnvPin probe inside verifyWrittenCredentials mirrors the STRING
  // resolver, which for an empty env always answers the legacy path. The
  // daemon's real boot path is the folder-aware resolveCredentialsSelection
  // (lib/agent-credentials.ts), whose rule 4 resolves a SOLE
  // credentials-<id>.json on its own when NO legacy file exists, no env pin is
  // set, and no sibling per-assistant file competes. So after the dedupe above
  // (or on a fresh host that never had a legacy file) the probe reports a pin
  // the real daemon does not need; correct that here, and ONLY here. Any other
  // per-assistant file next door, a BGOS_CREDENTIALS_PATH override, or a
  // conflicting BGOS_ASSISTANT_ID already in the env keeps the pin requirement
  // exactly as the probe computed it: the multi-agent refusal is untouched.
  let needsEnvPin = verified.needsEnvPin
  if (needsEnvPin && boundId && !override) {
    const envId = String(env?.BGOS_ASSISTANT_ID ?? '').trim()
    const effectiveEnvId = envId && envId !== ASSISTANT_ID_PLACEHOLDER ? envId : ''
    if (
      !effectiveEnvId &&
      !existsSync(legacy) &&
      otherPerAssistantIds(home, assistantId).length === 0
    ) {
      needsEnvPin = false
    }
  }

  return {
    ok: true,
    path,
    legacyDeduped,
    legacyDedupedHeldSameAgent,
    legacyKeptForOtherAgent,
    protection,
    needsEnvPin,
    realEnvPath: verified.realEnvPath,
  }
}

// ── Launch-folder auto-pin (phase two) ───────────────────────────────────────

/** The launch-folder pin file server.ts reads to self-resolve an identity with
 *  no env var. The number inside IS the assistant id. */
export const FOLDER_PIN_FILE_NAME = '.bgos-agent-id'

/**
 * Set the bgos MCP server's env.BGOS_ASSISTANT_ID inside a parsed .mcp.json
 * object, WITHOUT touching any other key or server, and WITHOUT fabricating a
 * bgos server when the folder config has none (a command-less server entry
 * would be invalid and break the launch, so the folder pin carries the identity
 * for that topology instead). Pure: returns { changed, next }.
 * @param {Record<string, any> | null | undefined} current
 * @param {string | number} assistantId
 * @returns {{ changed: boolean, next: Record<string, any> }}
 */
export function bakeMcpPin(current, assistantId) {
  const id = String(assistantId ?? '').trim()
  const base = current && typeof current === 'object' ? current : {}
  const servers =
    base.mcpServers && typeof base.mcpServers === 'object' ? base.mcpServers : null
  const bgos = servers && servers.bgos && typeof servers.bgos === 'object' ? servers.bgos : null
  if (!id || !bgos) return { changed: false, next: base }
  const existingEnv = bgos.env && typeof bgos.env === 'object' ? bgos.env : {}
  if (String(existingEnv.BGOS_ASSISTANT_ID ?? '') === id) return { changed: false, next: base }
  const next = {
    ...base,
    mcpServers: {
      ...servers,
      bgos: { ...bgos, env: { ...existingEnv, BGOS_ASSISTANT_ID: id } },
    },
  }
  return { changed: true, next }
}

/**
 * Bake the launch-folder auto-pin after a verified pairing write: always drop a
 * <cwd>/.bgos-agent-id folder pin (the load-bearing anchor server.ts
 * self-resolves from with no env var), and, when the folder already has a bgos
 * MCP server configured, set its env.BGOS_ASSISTANT_ID too. Idempotent, and it
 * never clobbers unrelated .mcp.json keys or servers. Best effort: the caller
 * treats a failure as non-fatal because the credentials file is already
 * written.
 * @param {{ cwd?: string, assistantId?: string | number | null }} opts
 */
export async function bakeLaunchPin({ cwd, assistantId } = {}) {
  const id = String(assistantId ?? '').trim()
  const dir = String(cwd ?? '').trim() || process.cwd()
  const pinPath = join(dir, FOLDER_PIN_FILE_NAME)
  let folderPinWritten = false
  if (id) {
    await mkdir(dir, { recursive: true })
    await writeFile(pinPath, `${id}\n`)
    folderPinWritten = true
  }
  const mcpPath = join(dir, '.mcp.json')
  let mcpUpdated = false
  const current = loadJsonSafe(mcpPath)
  if (current) {
    const { changed, next } = bakeMcpPin(current, id)
    if (changed) {
      await writeFile(mcpPath, `${JSON.stringify(next, null, 2)}\n`)
      mcpUpdated = true
    }
  }
  return { folderPinPath: pinPath, folderPinWritten, mcpPath, mcpUpdated }
}

/**
 * Would a daemon launched from `cwd` with this real environment resolve the
 * pairing just written, via the launch-folder pin? This VERIFIES the baked
 * state on disk rather than trusting the bake's return value, mirroring the
 * daemon's own resolution order (lib/agent-credentials.ts
 * resolveCredentialsSelection): a BGOS_CREDENTIALS_PATH override outranks
 * everything; an explicit BGOS_ASSISTANT_ID outranks the pin (so a
 * CONFLICTING env id defeats it while a matching one is equally safe); with
 * no env pin, rule 3 reads <cwd>/.bgos-agent-id and resolves that agent's
 * credentials-<id>.json. When all of that holds, the pairing is live-safe
 * for an agent launched from this folder, which is exactly how one-click
 * and the hoai alias launch it.
 * @param {{ cwd: string, assistantId: string | number, env?: Record<string, string | undefined>,
 *           home?: string, exists?: (path: string) => boolean,
 *           read?: (path: string, encoding: string) => string }} opts
 */
export function launchFolderLiveSafe({
  cwd,
  assistantId,
  env = {},
  home = homedir(),
  exists = existsSync,
  read = readFileSync,
}) {
  const id = String(assistantId ?? '').trim()
  if (!id) return false
  if (String(env?.BGOS_CREDENTIALS_PATH ?? '').trim()) return false
  const envId = String(env?.BGOS_ASSISTANT_ID ?? '').trim()
  if (envId && envId !== ASSISTANT_ID_PLACEHOLDER && envId !== id) return false
  let pinned = ''
  try {
    pinned = String(read(join(String(cwd ?? ''), FOLDER_PIN_FILE_NAME), 'utf8')).trim()
  } catch {
    return false
  }
  if (pinned !== id) return false
  return exists(perAssistantCredentialsPath(home, id))
}

/** The npm package spec that lets a machine with no `hoai` on PATH bootstrap
 *  one. `hoai install-cli` resolves the plugin root from the RECORDED
 *  marketplace install, not from wherever npx unpacked it, so the shim it
 *  writes points somewhere durable. Never suggest `npx ... hoai` to LAUNCH:
 *  run that way, install-method detection sees the npx temp dir, calls it a
 *  clone, and hands a marketplace install the wrong channel spec. */
export const PLUGIN_PACKAGE_REF = 'github:BrandGrowthOS/bgos-claude-plugin'

/**
 * Restart guidance: one short instruction, the same one on every platform and
 * for every install shape.
 *
 * This used to print a raw `claude ... --dangerously-load-development-channels
 * <spec>` line, chosen from a detection result when one was in hand and
 * offered as BOTH forms when it was not. The spec matters enormously: on
 * 2026-08-21 a marketplace install launched with the clone spec (server:bgos)
 * dropped every inbound message with no error anywhere, so the both-forms
 * branch was a coin flip handed to an operator.
 *
 * `hoai` removes the choice instead of making it better. It re-detects the
 * install method on EVERY launch (bin/hoai-core.mjs buildRunPlan), so the
 * user has nothing to remember and nothing to get wrong, and pairing has
 * bakeLaunchPin'd this folder already, which is exactly what a bare `hoai`
 * needs to come back as this agent.
 *
 * The detection line is kept when we have one, as a diagnostic for an operator
 * reading the pairing output, not as something to type.
 * @param {{ method?: 'marketplace' | 'clone' } | null} [detection]
 */
export function restartInstructions(detection = null) {
  const lines = [
    'restart your agent: type /exit in its Claude Code session, then run',
    '  hoai',
    'from this same folder. That is the whole instruction.',
  ]
  const method = detection?.method
  if (method === 'marketplace' || method === 'clone') {
    lines.push(
      method === 'marketplace'
        ? '  (detected: marketplace install, the plugin files live under the Claude config dir)'
        : '  (detected: local checkout, the plugin files live outside the Claude config dir)',
    )
  }
  lines.push(
    '  hoai works out the right channel flag for this install every time it starts,',
    '  so there is no command line to remember. Do NOT put a hoai alias in your',
    '  shell profile: an alias freezes ONE channel spec into a string, and the wrong',
    '  spec connects nothing and drops every inbound message in silence.',
    '  If your shell cannot find hoai, run this once and open a new terminal:',
    `    npx --yes --package ${PLUGIN_PACKAGE_REF} hoai install-cli`,
  )
  return lines
}

export const USAGE = `bgos-pair: pair this Claude Code session to HOAI with a one time code

Usage:
  # A machine running several agents (the usual case on a fleet host):
  node ~/bgos-claude-plugin/bin/bgos-pair.mjs BGOS-XXXX-XX --assistant-id <id>

  # A machine running exactly one agent, with no local checkout:
  npx --yes --package github:BrandGrowthOS/bgos-claude-plugin bgos-pair BGOS-XXXX-XX

Options:
  --backend <url>        backend base (default ${DEFAULT_API_BASE})
  --assistant-id <id>    the HOAI assistant this session pairs as; required on
                         accounts with several bound agents (BGOS_ASSISTANT_ID
                         env is honoured as the fallback). If the pairing would
                         resolve to a different assistant, nothing is written.
  --allow-unpinned       proceed even when the daemon would resolve a different
                         agent's credentials file. Without this, that case exits
                         3 on a host serving other agents, because the
                         pairing cannot work until the environment is pinned.
  -h, --help             show this help

Exit codes:
  0  done and live-safe
  1  unexpected error
  2  pairing refused by the server
  3  paired but NOT DONE; an environment pin is required

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
/**
 * What protection did this file ACTUALLY get?
 *
 * fs.chmod(0o600) is a no-op on win32 (the mode reads back 0o666), so the old
 * unconditional "(chmod 600)" line asserted a protection that had not
 * happened, on the one platform where it had not (Mark, 888, 2026-08-05).
 * A message that promises more than its write path delivers is the same
 * disease as last_seen and the .in_use markers.
 *
 * A FAILED lock says UNPROTECTED. The operator has to know to fix it by hand;
 * silence here would leave a pairing token readable and looking fine.
 */
export function describeFileProtection({ platform, aclApplied, aclError } = {}) {
  if (platform !== 'win32') return 'chmod 600'
  if (aclApplied) return 'locked to your Windows user'
  const message = 'UNPROTECTED, the Windows ACL could not be applied, restrict it by hand'
  const detail = String(aclError ?? '').trim()
  return detail ? `${message}: ${detail}` : message
}

/**
 * The icacls invocation that actually works on this platform.
 *
 * icacls is invoked DIRECTLY with an args array, never through a `cmd.exe /c
 * "<whole line>"` string. The string form broke in practice: node's execFile
 * quotes each array element for the Windows command line, cmd.exe then
 * re-parses the already-quoted line with its own rules, and the grant arrived
 * as `""karim:F""`, which icacls rejects with Invalid parameter, exit 87
 * (found live by the 2026-08-22 one-click E2E; the credentials file was left
 * world-readable and the output honestly said UNPROTECTED). The historic
 * cmd.exe indirection existed to dodge a PowerShell-invocation safety guard
 * (Mark's twelve-agent migration), which does not apply here: this runs via
 * node's execFile with no shell at all. The grant stays explicit to the
 * actual process principal: /inheritance:r removes inherited access, then
 * /grant:r gives that user full control. Returns null without a username
 * rather than granting to an empty principal.
 */
export function win32AclCommand(path, username, executable = 'icacls') {
  const user = String(username ?? '').trim()
  const file = String(executable ?? '').trim()
  if (!user || !file) return null
  return {
    file,
    args: [String(path), '/inheritance:r', '/grant:r', `${user}:F`],
  }
}

function commandFailure(command, error) {
  const message = String(error?.message ?? error ?? 'unknown error')
  const code = error?.code
  const codeDetail = code == null ? '' : ` (code ${code})`
  return `${command.file} failed: ${message}${codeDetail}`
}

function commandWasNotFound(error) {
  return error?.code === 'ENOENT' || error?.cause?.code === 'ENOENT'
}

export async function writeCredentialsFile(path, creds, opts = {}) {
  const platform = opts.platform ?? process.platform
  await mkdir(dirname(path), { recursive: true, mode: CREDENTIALS_DIR_MODE })
  await chmod(dirname(path), CREDENTIALS_DIR_MODE).catch(() => {})
  await writeFile(path, `${JSON.stringify(creds, null, 2)}\n`, {
    mode: CREDENTIALS_FILE_MODE,
  })
  await chmod(path, CREDENTIALS_FILE_MODE)
  if (platform !== 'win32') return { platform, aclApplied: null }
  // chmod did nothing here, so the file is world-readable until icacls runs.
  // Doing it in the tool rather than in an operator's runbook: the manual
  // step worked eleven times and would fail on the twelfth.
  const username = String(
    opts.username ?? process.env.USERNAME ?? process.env.USER ?? '',
  ).trim()
  const command = win32AclCommand(path, username)
  if (!command) {
    return {
      platform,
      aclApplied: false,
      aclError: 'Windows username is unavailable, so no explicit principal could be granted',
    }
  }
  const run = opts.run ?? defaultRunCommand
  try {
    await run(command.file, command.args)
    return { platform, aclApplied: true }
  } catch (error) {
    const firstFailure = commandFailure(command, error)
    if (!commandWasNotFound(error)) {
      // icacls resolved, so an absolute path cannot repair this icacls exit.
      // Never claim a protection that failed; the caller reports UNPROTECTED.
      return { platform, aclApplied: false, aclError: firstFailure }
    }

    const systemRoot = String(
      opts.systemRoot ?? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? '',
    ).trim()
    if (!systemRoot) {
      return {
        platform,
        aclApplied: false,
        aclError: `${firstFailure}; SystemRoot is unavailable, so the absolute icacls fallback could not be tried`,
      }
    }

    const fallback = win32AclCommand(
      path,
      username,
      win32Path.join(systemRoot, 'System32', 'icacls.exe'),
    )
    try {
      await run(fallback.file, fallback.args)
      return { platform, aclApplied: true }
    } catch (fallbackError) {
      return {
        platform,
        aclApplied: false,
        aclError: `${firstFailure}; ${commandFailure(fallback, fallbackError)}`,
      }
    }
  }
}

function defaultRunCommand(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error) => {
      if (error) reject(error)
      else resolve(undefined)
    })
  })
}

async function postJson(url, body, headers = {}, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return readBody(res)
}

async function getJson(url, headers = {}, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json', ...headers } })
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

/**
 * @param {string[]} [argv]
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   cwd?: string,
 *   fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
 * }} [opts]
 */
export async function main(argv = process.argv.slice(2), opts = {}) {
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const fetchImpl = opts.fetchImpl ?? fetch
  const { args, errors } = parsePairArgs(argv)
  if (args.help) {
    process.stdout.write(USAGE)
    return PAIR_EXIT_CODES.DONE
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`[bgos-pair] ${error}`)
    process.stdout.write(USAGE)
    return PAIR_EXIT_CODES.UNEXPECTED_ERROR
  }

  const apiBase = args.apiBase
  const allowUnpinned = args.allowUnpinned
  const deviceLabel = `${hostname()} (Claude Code)`

  // Resolved BEFORE the exchange: the pinned identity travels IN the exchange
  // body (intended_assistant_id) so the backend's overlap guard judges the
  // pairing against the agent this machine actually serves, not against every
  // Claude pairing on the account.
  const requestedId = resolveRequestedAssistantId({
    argAssistantId: args.assistantId,
    env,
  })
  if (requestedId) {
    console.log(`[bgos-pair] pairing as assistant ${requestedId} (explicitly requested)`)
  }

  console.log('[bgos-pair] pairing this computer with your HOAI account...')
  let exchange
  try {
    exchange = await postJson(
      `${apiBase}/integrations/pair-exchange`,
      buildExchangeBody({
        code: args.code,
        deviceLabel,
        intendedAssistantId: requestedId,
      }),
      {},
      fetchImpl,
    )
  } catch (err) {
    console.error(`[bgos-pair] could not reach the backend: ${err?.message ?? err}`)
    console.error('[bgos-pair] check this computer\'s internet connection and try again.')
    return PAIR_EXIT_CODES.UNEXPECTED_ERROR
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
    return PAIR_EXIT_CODES.SERVER_REFUSED
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
      fetchImpl,
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
      fetchImpl,
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
      me = await getJson(
        `${apiBase}/integrations/me`,
        { 'X-BGOS-Pairing': pairingToken },
        fetchImpl,
      )
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
    return PAIR_EXIT_CODES.UNEXPECTED_ERROR
  }
  if (binding.kind === 'ambiguous') {
    console.error('[bgos-pair] this account has several bound agents; refusing to guess which one this session is:')
    for (const c of binding.candidates) {
      console.error(`[bgos-pair]   --assistant-id ${c.assistant_id}  ${c.name || c.agent_route}`.trimEnd())
    }
    console.error('[bgos-pair] nothing was written. Rerun with --assistant-id <id> (or set BGOS_ASSISTANT_ID).')
    return PAIR_EXIT_CODES.UNEXPECTED_ERROR
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
    return PAIR_EXIT_CODES.UNEXPECTED_ERROR
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
  // Write per-assistant, dedupe the legacy single-slot file (delete junk or
  // this same agent's stale copy, never another agent's live pairing), then
  // verify the result actually resolves for the intended assistant. Never
  // report success on an unverified or refused write.
  const result = await writeAndVerifyCredentials({ creds, env, home })
  if (!result.ok) {
    console.error(`[bgos-pair] pairing NOT saved: ${result.reason}`)
    return PAIR_EXIT_CODES.UNEXPECTED_ERROR
  }

  // Report what the file ACTUALLY got, not what was intended. On win32 chmod
  // is a no-op, so the old unconditional "(chmod 600)" asserted a protection
  // that had not happened, and a failed ACL now says UNPROTECTED out loud.
  console.log(
    `[bgos-pair] wrote ${result.path} (${describeFileProtection(
      result.protection ?? {},
    )})`,
  )
  if (result.legacyDeduped) {
    // Deduped, and honest about WHAT was removed: "(same agent)" only when the
    // legacy really held this agent's pairing; unreadable junk is named junk.
    console.log(
      result.legacyDedupedHeldSameAgent
        ? `[bgos-pair] removed the stale shared credentials.json (same agent); credentials-${assistantId}.json is now the single source of truth`
        : `[bgos-pair] removed the unreadable shared credentials.json; credentials-${assistantId}.json is now the single source of truth`,
    )
  } else if (result.legacyKeptForOtherAgent) {
    // SAY IT. A tool that silently declines and a tool that never had the
    // condition look identical from the outside, which is how the co-write
    // defect stayed invisible on a twelve-agent host (Mark, 888, 2026-08-06).
    console.log(
      `[bgos-pair] left the shared credentials.json in place: it holds a live pairing for agent ${result.legacyKeptForOtherAgent},`,
    )
    console.log(
      '[bgos-pair] and one shared file cannot hold more than one identity. Each daemon pins BGOS_ASSISTANT_ID instead.',
    )
  }
  if (assistantId == null) {
    console.log('[bgos-pair] paired, but no agent is bound yet. Finish "Add agent" in the HOAI app,')
    console.log('[bgos-pair] then start Claude Code with the HOAI channel and it will pick up the binding.')
  } else {
    console.log(`[bgos-pair] verified: this file resolves to assistant ${assistantId}.`)
    // Bake the launch-folder auto-pin so a bare launch from THIS folder
    // self-resolves this identity with no env var (server.ts reads the folder
    // pin). Best effort: never fail a completed pairing on a bake hiccup.
    const pairCwd = opts.cwd ?? process.cwd()
    try {
      const baked = await bakeLaunchPin({ cwd: pairCwd, assistantId })
      if (baked.folderPinWritten) {
        console.log(
          `[bgos-pair] baked ${baked.folderPinPath} (launch this agent from this folder and it self-resolves as assistant ${assistantId}, no env var needed)`,
        )
      }
      if (baked.mcpUpdated) {
        console.log(
          `[bgos-pair] set BGOS_ASSISTANT_ID=${assistantId} in ${baked.mcpPath} (bgos server env)`,
        )
      }
    } catch (err) {
      console.error(
        `[bgos-pair] note: could not bake the launch-folder pin (${err?.message ?? err}); set BGOS_ASSISTANT_ID=${assistantId} in this agent's environment yourself.`,
      )
    }
    // Verify the baked state ON DISK: a pin that provably resolves from this
    // folder makes the pairing live-safe for an agent launched here (which is
    // how one-click and the hoai alias launch it), and the verdict below must
    // honor it (2026-08-23: on a ten-agent host the env-pin-only verdict
    // exited 3, the one-click script read pair-failed, and the retry bounced
    // off the live first pairing).
    const folderPinLiveSafe = launchFolderLiveSafe({
      cwd: pairCwd,
      assistantId,
      env,
      home,
    })
    if (result.needsEnvPin) {
      if (folderPinLiveSafe) {
        console.log(
          `[bgos-pair] live-safe via the launch-folder pin: an agent launched from ${pairCwd} ` +
            `resolves this pairing with no env var. Launching from any OTHER folder still needs ` +
            `BGOS_ASSISTANT_ID=${assistantId} (or BGOS_CREDENTIALS_PATH=${result.path}).`,
        )
      } else {
        console.log(
          `[bgos-pair] REQUIRED: set BGOS_ASSISTANT_ID=${assistantId} ` +
            `(or BGOS_CREDENTIALS_PATH=${result.path}) in this agent's environment. ` +
            `Without it the daemon reads ${result.realEnvPath}, which belongs to a different pairing.`,
        )
      }
    }
    // The pairing is only a success if the daemon can actually find it. On a
    // host serving other agents, an unpinned pairing resolves to one of THEIR
    // files at the next restart, so saying "done" and exiting 0 would be a
    // false claim rather than a warning. A VERIFIED launch-folder pin counts
    // as found (see pairExitCode).
    const otherAgentCount = otherPerAssistantIds(home, assistantId).length
    const code = pairExitCode({
      needsEnvPin: result.needsEnvPin,
      otherAgentCount,
      allowUnpinned,
      folderPinLiveSafe,
    })
    if (code !== PAIR_EXIT_CODES.DONE) {
      console.error(
        `[bgos-pair] NOT DONE: this host serves ${otherAgentCount} other agent(s) and this ` +
          `pairing is not pinned, so the daemon would read ${result.realEnvPath} instead of the ` +
          `file just written. Set the environment variable above and rerun, or pass ` +
          `--allow-unpinned if you are setting it yourself afterwards.`,
      )
      return code
    }
    console.log('[bgos-pair] done. To go live,')
    // Detect HOW this plugin is installed so the restart line names the ONE
    // launch command this install actually needs (the wrong spec drops every
    // inbound message silently, 2026-08-21). Evidence, not guesswork: the
    // REAL path of this script plus the live process env, never the injected
    // test env, because the install method is a property of this process, not
    // of the pairing. Detection must never crash a completed pairing; any
    // surprise falls back to the honest both-forms text.
    let detection = null
    try {
      detection = detectInstallMethod({
        scriptPath: fileURLToPath(import.meta.url),
        env: process.env,
      })
    } catch {
      detection = null
    }
    for (const line of restartInstructions(detection)) console.log(`[bgos-pair] ${line}`)
    return PAIR_EXIT_CODES.DONE
  }
  return PAIR_EXIT_CODES.DONE
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
      process.exitCode = PAIR_EXIT_CODES.UNEXPECTED_ERROR
    })
}
