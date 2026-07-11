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
 *      then read its assistant_id
 *   5. write ~/.bgos-agent/credentials.json (dir 0700, file 0600) with
 *      { backendUrl, pairingToken, pairingId, userId, assistantId, pairedAt }
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
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

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
  const args = { code: '', apiBase: DEFAULT_API_BASE, help: false }
  const errors = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      args.help = true
    } else if (arg === '--backend' || arg === '--api-base') {
      const value = argv[++i]
      if (!value) errors.push(`${arg} needs a value`)
      else args.apiBase = normalizeApiBase(value)
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

/** POST /integrations/pair-exchange body. */
export function buildExchangeBody({ code, deviceLabel, version }) {
  return {
    code,
    deviceLabel,
    integration: CLAUDE_INTEGRATION,
    agentCatalog: [claudeCatalogEntry()],
    daemonVersion: version ?? PLUGIN_VERSION,
  }
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

/** Pick the bound assistant id: prefer the claude route, else the first. */
export function pickAssistantId(meResponse) {
  const list = Array.isArray(meResponse?.assistants) ? meResponse.assistants : []
  if (list.length === 0) return null
  const claude = list.find((a) => a && a.agent_route === CLAUDE_AGENT_ROUTE)
  const chosen = claude ?? list[0]
  return chosen?.assistant_id ?? null
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

export function credentialsPath(home = homedir()) {
  return join(home, '.bgos-agent', 'credentials.json')
}

export const USAGE = `bgos-pair: pair this Claude Code session to HOAI with a one time code

Usage:
  npx --yes --package github:BrandGrowthOS/bgos-claude-plugin bgos-pair BGOS-XXXX-XX

Options:
  --backend <url>   backend base (default ${DEFAULT_API_BASE})
  -h, --help        show this help

Get a code in the HOAI app: Add agent, then Claude Code. The code links this
computer to your account, works once, and expires in 10 minutes.
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

  console.log('[bgos-pair] pairing this computer with your HOAI account...')
  let exchange
  try {
    exchange = await postJson(`${apiBase}/integrations/pair-exchange`, buildExchangeBody({
      code: args.code,
      deviceLabel,
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
  let assistantId = null
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    let me
    try {
      me = await getJson(`${apiBase}/integrations/me`, { 'X-BGOS-Pairing': pairingToken })
    } catch {
      me = { ok: false }
    }
    if (me.ok) {
      assistantId = pickAssistantId(me.body)
      if (assistantId != null) break
    }
    await sleep(1500)
  }

  const creds = buildCredentials({
    backendUrl: apiBase,
    pairingToken,
    pairingId,
    userId,
    assistantId,
    nowIso: new Date().toISOString(),
  })
  const path = credentialsPath()
  await writeCredentialsFile(path, creds)

  console.log(`[bgos-pair] wrote ${path} (chmod 600)`)
  if (assistantId == null) {
    console.log('[bgos-pair] paired, but no agent is bound yet. Finish "Add agent" in the HOAI app,')
    console.log('[bgos-pair] then start Claude Code with the HOAI channel and it will pick up the binding.')
  } else {
    console.log('[bgos-pair] done. Start Claude Code with the HOAI channel:')
    console.log('[bgos-pair]   claude --dangerously-load-development-channels plugin:hoai@hoai')
    console.log('[bgos-pair] (the flag is temporary until HOAI is on the Claude channel allowlist)')
  }
  return 0
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      console.error(`[bgos-pair] fatal: ${err?.message ?? err}`)
      process.exitCode = 1
    })
}
