/**
 * claude-account-id: WHICH Claude account is signed in, the only proof that usage came back on a
 * login change. A credential file that moved (a token refresh, a touched file) or a second saved
 * login on the same account is not a new account, so it is never proof.
 *
 *   accountTokenFrom(stdout)   the account a `claude auth status --json` answer names, as a one way
 *                              token ("account:<hash>", or "org:<hash>" when the CLI gives only an
 *                              organization). The raw id never leaves this function.
 *   accountChanged(a, b)       true only when both tokens are known, of the same kind, and differ.
 *   agentAccountDir(dir, env)  the config folder an agent's login lives in: its recipe's folder, else
 *                              the CLAUDE_CONFIG_DIR it launched under, else none (the default).
 *   accountEnv(input)          the environment the agent launched with, for a status read.
 *   readClaudeAccount(input)   one status read: { ok: true, token } or { ok: false, why }. A failed
 *                              or timed out read names no account, so nothing is pressed on it.
 *   createCachedAccountReader  the same read, answered from the last one for a minute per folder
 *                              (failures too), so a slow CLI cannot stall a watcher sweep.
 *
 * It only ever runs `claude --version` and `claude auth status --json`. Never a sign in or a sign
 * out, never a credential file or Keychain item opened here. Only stable CLI releases >= 2.1.317 run
 * auth status (lib/claude-subscription-status.mjs says why). Plain JavaScript, node >= 18.
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { supportsSafeAuthStatus } from './claude-subscription-status.mjs'
import { accountChanged } from './limit-screen.mjs'
import { claudeCliCandidates } from './plugin-cli.mjs'

export const ACCOUNT_READ_TIMEOUT_MS = 5_000

/** Login and provider settings that would make a status read answer for something else. */
const LOGIN_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
])

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const token = (kind, id) => `${kind}:${createHash('sha256').update(`${kind}:${id}`).digest('hex').slice(0, 32)}`

/**
 * @param {unknown} stdout
 * @returns {string | null}
 */
export function accountTokenFrom(stdout) {
  const raw = String(stdout ?? '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let status
  try {
    status = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (!status || typeof status !== 'object' || Array.isArray(status) || status.loggedIn !== true) return null
  const account = text(status.accountUuid) ?? text(status.account?.uuid) ?? text(status.oauthAccount?.accountUuid)
  if (account) return token('account', account)
  const org = text(status.orgId) ?? text(status.organizationUuid) ?? text(status.organization?.uuid) ?? text(status.oauthAccount?.organizationUuid)
  return org ? token('org', org) : null
}

/** Did the signed in account change? The rule lives with the other limit rules. */
export { accountChanged }

/** The folder an agent's login lives in, the one its transcript is read from too: the recipe's
 *  CLAUDE_CONFIG_DIR, else the one the watcher (and so the agent) runs under, else null (default). */
export function agentAccountDir(recipeDir, env = {}) {
  return text(recipeDir == null ? null : String(recipeDir)) ?? text(env?.CLAUDE_CONFIG_DIR == null ? null : String(env.CLAUDE_CONFIG_DIR))
}

/** The agent's login as it launched: CLAUDE_CONFIG_DIR exactly as its recipe recorded it (none when
 *  it had none: on macOS the folder picks the Keychain item), and no key or token from this process. */
export function accountEnv({ env = {}, configDir = null }) {
  const out = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!LOGIN_ENV_KEYS.has(key.toUpperCase()) && typeof value === 'string') out[key] = value
  }
  const dir = text(configDir)
  if (dir) out.CLAUDE_CONFIG_DIR = dir
  return out
}

function runClaude(args, { env, home, platform, run }) {
  const options = {
    env, cwd: home, encoding: 'utf8', timeout: ACCOUNT_READ_TIMEOUT_MS, maxBuffer: 16 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'], shell: false, windowsHide: true,
  }
  for (const candidate of claudeCliCandidates(args, platform, env)) {
    const result = run(candidate.file, candidate.args, options)
    const code = result?.error?.code
    if (code === 'ENOENT' || code === 'EINVAL' || candidate.notFoundExitCodes.includes(result?.status)) continue
    return result
  }
  return null
}

const timedOut = (result) => result?.error?.code === 'ETIMEDOUT' || (result?.status === null && Boolean(result?.signal))

/**
 * One status read of the agent's login, from home (never inside a saved login folder: Windows looks
 * for `claude` in the working folder first). Synchronous, bounded by two 5 s timeouts.
 * @param {{ env?: Record<string, string | undefined>, home: string, configDir?: string | null,
 *   platform?: string, run?: typeof spawnSync }} input
 * @returns {{ ok: true, token: string } | { ok: false, why: 'unsupported_version' | 'timed_out' | 'failed' | 'no_account' }}
 */
export function readClaudeAccount({ env = process.env, home, configDir = null, platform = process.platform, run = spawnSync }) {
  const opts = { env: accountEnv({ env, configDir }), home, platform, run }
  try {
    const version = runClaude(['--version'], opts)
    if (timedOut(version)) return { ok: false, why: 'timed_out' }
    if (!version || version.error || version.status !== 0 || !supportsSafeAuthStatus(version.stdout)) return { ok: false, why: 'unsupported_version' }
    const status = runClaude(['auth', 'status', '--json'], opts)
    if (timedOut(status)) return { ok: false, why: 'timed_out' }
    if (!status || status.error || status.status !== 0) return { ok: false, why: 'failed' }
    const found = accountTokenFrom(status.stdout)
    return found ? { ok: true, token: found } : { ok: false, why: 'no_account' }
  } catch {
    return { ok: false, why: 'failed' }
  }
}

export const ACCOUNT_READ_CACHE_MS = 60_000

/**
 * readClaudeAccount behind a short memory per config folder: one CLI run a minute at most, failures
 * remembered too (a failed read presses nothing either way). Each run can block for the timeout, so
 * a hung CLI costs one wait a minute, not one per agent per look.
 */
export function createCachedAccountReader({ read = readClaudeAccount, now = Date.now, ttlMs = ACCOUNT_READ_CACHE_MS } = {}) {
  const kept = new Map()
  return (input) => {
    const key = `${input?.platform ?? ''}|${input?.configDir ?? ''}`
    const at = now()
    const hit = kept.get(key)
    if (hit && at - hit.at >= 0 && at - hit.at < ttlMs) return hit.value
    let value
    try {
      value = read(input)
    } catch {
      value = { ok: false, why: 'failed' }
    }
    kept.set(key, { at, value })
    return value
  }
}
