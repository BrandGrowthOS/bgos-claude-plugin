/**
 * Update failure diagnostics: the P3 "failure signature" client (zero-terminal
 * lifecycle design 1.6 / 7.5).
 *
 * When a one-click update or a watcher job fails, the daemon (update_rpc)
 * or the watcher builds ONE compact bundle, scrubs it, and fire-and-forgets
 * it to `POST integrations/update-failures`. The backend hashes the
 * signature (cause | installMethod | platform | pluginVersion |
 * targetVersion) into one row per distinct failure, so the bundle must be
 * STABLE (the cause is `<failedStep.kind>:<machine token>`, never free
 * text) and CLEAN (nothing secret or identifying may leave the machine).
 *
 * Scrubbing is a REDACTOR, not a detector: lib/secret-scan.ts only reports
 * findings for the Agent Pack gate, so its rules_version 1 patterns are
 * ported here verbatim (keep them in step when that file changes) and
 * extended with the shapes this lifecycle actually handles: BGOS pairing
 * tokens (`pair_` + base64url), the X-BGOS-Pairing header, long hex and
 * base64 runs, home directories and user folders (to `~`), and the OS
 * username (to `<user>`). Every string is capped, every array is capped,
 * and the whole bundle is capped at 32 KiB with an explicit marker.
 *
 * Plain JavaScript on node >= 18 builtins only (ships in the watcher
 * bundle, runs under bun in server.ts and under tsx in tests). Pure apart
 * from postFailureDiagnostics, whose only effect is the injected POST.
 */

import { homedir, userInfo } from 'node:os'

export const DIAGNOSTICS_MAX_STRING_CHARS = 2000
export const DIAGNOSTICS_MAX_ARRAY_ITEMS = 200
export const DIAGNOSTICS_MAX_BYTES = 32 * 1024
export const DIAGNOSTICS_MAX_DEPTH = 20
export const UPDATE_FAILURES_PATH = 'integrations/update-failures'

const REDACTED = '<redacted>'
const USER = '<user>'
const TRUNCATED = '[truncated]'

// -- Secret rules ------------------------------------------------------------

/**
 * Ported from lib/secret-scan.ts (rules_version 1), same order, plus the
 * lifecycle additions at the end. `group` is the capture holding the secret
 * (0 = whole match). Global flag on every pattern: a line can hold several.
 * @type {Array<{ name: string, pattern: RegExp, group: number }>}
 */
const SECRET_RULES = [
  { name: 'aws_access_key_id', pattern: /\bAKIA[0-9A-Z]{16}\b/g, group: 0 },
  {
    name: 'aws_secret_access_key',
    pattern: /\baws.{0,30}?['"=:\s]([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    group: 1,
  },
  { name: 'anthropic_api_key', pattern: /\bsk-ant-[A-Za-z0-9-]{20,}/g, group: 0 },
  { name: 'openai_api_key', pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{20,}/g, group: 0 },
  {
    name: 'github_token',
    pattern: /\b(?:gh[posu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    group: 0,
  },
  { name: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, group: 0 },
  { name: 'stripe_live_key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{10,}/g, group: 0 },
  { name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/g, group: 0 },
  {
    // The whole PEM block (BEGIN through END, or to the end of the text).
    name: 'private_key_block',
    pattern:
      /-----BEGIN\s+(?:[A-Z0-9]+\s+)*PRIVATE\s+KEY(?:\s+BLOCK)?-----[\s\S]*?(?:-----END[^-]*-----|$)/g,
    group: 0,
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{8,}/g,
    group: 0,
  },
  {
    name: 'connection_string_password',
    pattern: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:([^\s@/]+)@/gi,
    group: 1,
  },
  { name: 'bearer_token', pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/g, group: 1 },
  {
    name: 'generic_secret_assignment',
    pattern:
      /(?:api[_-]?key|secret|token|passwd|password|authorization)['"]?\s*[:=]\s*['"]?([^\s'"]{16,})/gi,
    group: 1,
  },
  // Lifecycle additions (not part of the secret-scan ruleset).
  { name: 'bgos_pairing_header', pattern: /\bX-BGOS-Pairing\s*[:=]\s*['"]?([^\s'"]{16,})/gi, group: 1 },
  { name: 'bgos_pairing_token', pattern: /\bpair_[A-Za-z0-9_-]{20,}/g, group: 0 },
  { name: 'hex_run', pattern: /(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])/g, group: 0 },
]

/** base64url-ish runs (no `/`, no `+`): redacted when they look like a
 *  token (upper + lower + digit all present), which no version, path
 *  segment, or step token satisfies. */
const BASE64URL_RUN = /(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_+/=-])/g
/** Standard base64 runs: same class test, and either a `+`, a `=` pad, or no
 *  `/` at all, so a plain path never qualifies. A base64 token that happens
 *  to contain `/` and neither `+` nor `=` is the one shape that can slip. */
const BASE64_RUN = /(?<![A-Za-z0-9_+/=-])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9_+/=-])/g

function looksLikeToken(run) {
  return /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run)
}

/** Keys whose VALUE is always replaced, whatever it looks like. */
const SECRET_KEY_RE = /token|secret|password|passwd|cookie|authorization|api[_-]?key|x-bgos-pairing/i

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A regex matching `home` with either separator style, case-insensitive
 *  when the home looks like a win32 path. Null for an empty/short home. */
function homePattern(home) {
  const trimmed = String(home ?? '').replace(/[\\/]+$/, '')
  if (trimmed.length < 3) return null
  const win32 = /^[A-Za-z]:/.test(trimmed) || trimmed.includes('\\')
  const source = trimmed
    .split(/[\\/]+/)
    .map(escapeRegex)
    .join('[\\\\/]+')
  return new RegExp(source + '(?![A-Za-z0-9_.-])', win32 ? 'gi' : 'g')
}

/** /Users/<x>, /home/<x>, C:\Users\<x>, C:/Users/<x>: any user folder. */
const USER_FOLDER_RE = /(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/\s'"`<>|]+/g

/**
 * Scrub one string. Order matters: secrets first (a token inside a path
 * must still die), then user folders, then the username, then the cap.
 * @param {string} value
 * @param {{ home?: string, username?: string }} [opts]
 * @returns {string}
 */
export function scrubString(value, opts = {}) {
  let text = String(value ?? '')
  if (text.length === 0) return text
  for (const rule of SECRET_RULES) {
    text = text.replace(rule.pattern, (...args) => {
      const match = args[0]
      if (rule.group === 0) return REDACTED
      const secret = args[rule.group]
      return typeof secret === 'string' && secret.length > 0
        ? match.replace(secret, REDACTED)
        : match
    })
  }
  text = text.replace(BASE64URL_RUN, (run) => (looksLikeToken(run) ? REDACTED : run))
  text = text.replace(BASE64_RUN, (run) =>
    looksLikeToken(run) && (run.includes('+') || run.endsWith('=') || !run.includes('/'))
      ? REDACTED
      : run,
  )
  const home = homePattern(opts.home)
  if (home) text = text.replace(home, '~')
  text = text.replace(USER_FOLDER_RE, '~')
  const username = String(opts.username ?? '').trim()
  if (username.length >= 2) {
    text = text.replace(
      new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(username)}(?![A-Za-z0-9_])`, 'gi'),
      USER,
    )
  }
  if (text.length > DIAGNOSTICS_MAX_STRING_CHARS) {
    text = text.slice(0, DIAGNOSTICS_MAX_STRING_CHARS) + TRUNCATED
  }
  return text
}

function defaultUsername() {
  try {
    return userInfo().username
  } catch {
    return ''
  }
}

function scrubValue(value, opts, seen, depth) {
  if (value === null || value === undefined) return value
  const type = typeof value
  if (type === 'string') return scrubString(value, opts)
  if (type === 'number' || type === 'boolean') return value
  if (type === 'bigint') return String(value)
  if (type === 'function' || type === 'symbol') return undefined
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (value instanceof Error) {
    return scrubString(`${value.name}: ${value.message}`, opts)
  }
  if (depth >= DIAGNOSTICS_MAX_DEPTH) return '<depth>'
  if (seen.has(value)) return '<cycle>'
  seen.add(value)
  if (Array.isArray(value)) {
    const out = []
    for (const item of value.slice(0, DIAGNOSTICS_MAX_ARRAY_ITEMS)) {
      const scrubbed = scrubValue(item, opts, seen, depth + 1)
      out.push(scrubbed === undefined ? null : scrubbed)
    }
    seen.delete(value)
    return out
  }
  if (type === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key)) {
        out[key] = REDACTED
        continue
      }
      const scrubbed = scrubValue(entry, opts, seen, depth + 1)
      if (scrubbed !== undefined) out[key] = scrubbed
    }
    seen.delete(value)
    return out
  }
  return String(value)
}

function byteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Shrink a scrubbed top-level object until it serializes under the byte
 * cap: halve the largest array field first (the step list is the usual
 * culprit), then blank the largest non-signature field, and as a last
 * resort keep only the signature. Always marks `truncated: true`.
 */
function capBytes(value) {
  if (byteLength(value) <= DIAGNOSTICS_MAX_BYTES) return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { truncated: true, marker: 'diagnostics_truncated' }
  }
  let current = { ...value, truncated: true }
  for (let round = 0; round < 64 && byteLength(current) > DIAGNOSTICS_MAX_BYTES; round++) {
    let largestKey = null
    let largestSize = 0
    for (const [key, entry] of Object.entries(current)) {
      if (!Array.isArray(entry) || entry.length <= 1) continue
      const size = byteLength(entry)
      if (size > largestSize) {
        largestSize = size
        largestKey = key
      }
    }
    if (largestKey === null) break
    const arr = current[largestKey]
    current = { ...current, [largestKey]: arr.slice(0, Math.max(1, Math.floor(arr.length / 2))) }
  }
  for (let round = 0; round < 64 && byteLength(current) > DIAGNOSTICS_MAX_BYTES; round++) {
    let largestKey = null
    let largestSize = 0
    for (const [key, entry] of Object.entries(current)) {
      if (key === 'signature' || key === 'truncated') continue
      const size = byteLength(entry)
      if (size > largestSize) {
        largestSize = size
        largestKey = key
      }
    }
    if (largestKey === null) break
    current = { ...current, [largestKey]: TRUNCATED }
  }
  if (byteLength(current) > DIAGNOSTICS_MAX_BYTES) {
    return { truncated: true, marker: 'diagnostics_truncated', signature: current.signature ?? null }
  }
  return current
}

/**
 * Deep-scrub any value for transmission. Never throws; cycles become
 * '<cycle>', functions vanish, the result is JSON-serialisable and under
 * the byte cap.
 * @param {unknown} value
 * @param {{ home?: string, username?: string }} [opts]
 * @returns {unknown}
 */
export function scrubDiagnostics(value, opts = {}) {
  const resolved = {
    home: opts.home === undefined ? homedir() : opts.home,
    username: opts.username === undefined ? defaultUsername() : opts.username,
  }
  let scrubbed
  try {
    scrubbed = scrubValue(value, resolved, new Set(), 0)
  } catch {
    return { truncated: true, marker: 'diagnostics_unscrubbable' }
  }
  return capBytes(scrubbed)
}

// -- Failure classification --------------------------------------------------

/** Ordered classification table: first hit wins. */
const TOKEN_RULES = [
  [/timed?[ _-]?out|ETIMEDOUT/i, 'timeout'],
  [/version[ _-]?mismatch/i, 'version_mismatch'],
  [/rollback[ _-]?impossible/i, 'rollback_impossible'],
  [/agent[ _-]?deaf/i, 'agent_deaf'],
  [/ENOSPC|no space left/i, 'disk_full'],
  [/ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|getaddrinfo|fetch failed|network/i, 'network'],
  [/EACCES|EPERM|permission denied|access is denied/i, 'permission_denied'],
  [/garbage|unparseable|invalid json|unexpected token/i, 'garbage_output'],
  [/(?:exit(?:ed)?(?: with)?(?: code)?|\brc|\bcode)[ =:]+(\d{1,3})\b/i, 'exit_'],
  [/ENOENT|not found|no such file/i, 'not_found'],
  [/not[ _-]?fast[ _-]?forward/i, 'not_fast_forward'],
  [/dirty/i, 'dirty_tree'],
  [/already/i, 'already'],
]

const LEADING_TOKEN_RE = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?![a-z0-9])/i

/**
 * A short machine token for a failure message: an explicit leading
 * snake_case token from the executor wins, then the classification table,
 * else 'failed'. Always matches /^[a-z][a-z0-9_]{0,48}$/.
 * @param {unknown} message
 * @returns {string}
 */
export function failureToken(message) {
  const text = typeof message === 'string' ? message.trim() : ''
  if (!text) return 'failed'
  const lead = LEADING_TOKEN_RE.exec(text)
  if (lead) return bound(lead[1].toLowerCase())
  for (const [pattern, token] of TOKEN_RULES) {
    const match = pattern.exec(text)
    if (!match) continue
    if (token === 'exit_') return bound(`exit_${match[1]}`)
    return token
  }
  return 'failed'
}

function bound(token) {
  const cleaned = token.replace(/[^a-z0-9_]/g, '').replace(/^[^a-z]+/, '')
  return (cleaned || 'failed').slice(0, 49)
}

// -- Bundle --------------------------------------------------------------------

function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function stepView(step) {
  if (!step || typeof step !== 'object') return null
  const out = {
    id: String(step.id ?? ''),
    kind: String(step.kind ?? 'unknown'),
    state: typeof step.state === 'string' ? step.state : 'unknown',
  }
  if (typeof step.message === 'string' && step.message.length > 0) out.message = step.message
  if (typeof step.target === 'string' && step.target.length > 0) out.target = step.target
  return out
}

/**
 * Build the scrubbed failure bundle.
 * @param {{
 *   plan?: { steps?: unknown[], targetVersion?: string | null } | null,
 *   result?: { ok?: boolean, failedStep?: { id?: string, kind?: string, message?: string } | null,
 *              rolledBack?: boolean, steps?: unknown[], installedVersion?: string | null,
 *              targetVersion?: string | null } | null,
 *   state?: Record<string, unknown> | null,
 *   platform?: string,
 *   installMethod?: string,
 *   pluginVersion?: string | null,
 *   targetVersion?: string | null,
 *   cliVersion?: string | null,
 *   nodeVersion?: string | null,
 *   watcherVersion?: string | null,
 *   home?: string,
 *   username?: string,
 * }} input
 * @returns {{ signature: { cause: string, installMethod: string, platform: string, pluginVersion: string | null, targetVersion: string | null },
 *             steps: Array<{ id: string, kind: string, state: string, message?: string }>,
 *             context: Record<string, unknown> }}
 */
export function buildFailureDiagnostics(input) {
  const safe = input && typeof input === 'object' ? input : {}
  const plan = safe.plan && typeof safe.plan === 'object' ? safe.plan : null
  const result = safe.result && typeof safe.result === 'object' ? safe.result : null
  const state = safe.state && typeof safe.state === 'object' ? safe.state : null
  const failedStep =
    result && result.failedStep && typeof result.failedStep === 'object' ? result.failedStep : null
  const cause = `${str(failedStep?.kind) ?? 'unknown'}:${failureToken(failedStep?.message)}`
  const rawSteps = Array.isArray(result?.steps)
    ? result.steps
    : Array.isArray(plan?.steps)
      ? plan.steps
      : []
  const steps = rawSteps.map(stepView).filter((s) => s !== null)
  const context = {
    cliVersion: str(safe.cliVersion),
    nodeVersion: str(safe.nodeVersion),
  }
  if (str(safe.watcherVersion)) context.watcherVersion = safe.watcherVersion
  if (result) {
    context.rolledBack = result.rolledBack === true
    if (failedStep) {
      context.failedStep = {
        id: String(failedStep.id ?? ''),
        kind: String(failedStep.kind ?? 'unknown'),
        message: String(failedStep.message ?? ''),
      }
    }
    if (str(result.installedVersion)) context.installedVersion = result.installedVersion
  }
  if (state) {
    context.state = {
      runningVersion: str(state.runningVersion),
      installMethod: str(state.installMethod),
      marketplace: state.marketplace ?? null,
      installed: state.installed ?? null,
      clone: state.clone ?? null,
      autoUpdateEnabled: state.autoUpdateEnabled,
      rollbackLatched: state.rollbackLatched,
      intent: str(state.intent),
      agents: Array.isArray(state.agents)
        ? state.agents.map((a) => ({
            assistantId: String(a?.assistantId ?? ''),
            supervisor: str(a?.supervisor),
            recipe: a?.recipe === true,
            running: a?.running === true,
          }))
        : [],
    }
  }
  const bundle = {
    signature: {
      cause,
      installMethod: str(safe.installMethod) ?? 'unknown',
      platform: str(safe.platform) ?? 'unknown',
      pluginVersion: str(safe.pluginVersion) ?? str(state?.runningVersion) ?? null,
      targetVersion:
        str(safe.targetVersion) ?? str(result?.targetVersion) ?? str(plan?.targetVersion) ?? null,
    },
    steps,
    context,
  }
  const scrubbed = scrubDiagnostics(bundle, { home: safe.home, username: safe.username })
  if (scrubbed && typeof scrubbed === 'object' && !Array.isArray(scrubbed) && scrubbed.signature) {
    return /** @type {any} */ (scrubbed)
  }
  return { signature: bundle.signature, steps: [], context: { truncated: true } }
}

/**
 * POST the bundle. Fire-and-forget by contract: resolves true on success
 * and false on any failure, never throws, never rejects.
 * @param {(path: string, body: Record<string, unknown>) => Promise<unknown>} post
 * @param {Record<string, unknown>} diagnostics
 * @returns {Promise<boolean>}
 */
export async function postFailureDiagnostics(post, diagnostics) {
  if (typeof post !== 'function') return false
  try {
    await post(UPDATE_FAILURES_PATH, diagnostics)
    return true
  } catch {
    return false
  }
}
