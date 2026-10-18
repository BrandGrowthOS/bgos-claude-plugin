/**
 * PERSON LANES, whose Claude sign in a lane uses (decision K2, design 4.3).
 *
 * Both options are offered PER SHARE, that is per (agent, person):
 *
 *   (a) `inherit` (the default): the lane signs in exactly as the agent
 *       does. The login variables are passed through only if the owner's
 *       process had them, byte for byte (lib/lane-core.mjs laneChildEnv);
 *       `CLAUDE_CONFIG_DIR` is never set when the owner had none, because
 *       setting it to the default path still moves the keychain namespace and
 *       signs the process out.
 *   (b) `own_token`: the person's own long lived token (`claude setup-token`),
 *       kept in the operating system's credential store under this agent and
 *       person, and read into THAT lane's environment only, with a config
 *       folder of the lane's own (`<lane>/claude-config`). Every owner login
 *       variable is dropped, so a missing or refused token can never fall
 *       back to the owner's login: a missing token stops the lane before
 *       Claude starts, and the person is told in their own chat.
 *
 * The mode is a local choice of the owner's, on the owner's computer:
 * `<agent>/people/login-modes.json`, written by `hoai-lane login`. The token
 * goes in with `hoai-lane token set`, from standard input, never argv.
 *
 * Stores: the macOS login keychain (`security`, the secret passed on stdin
 * through `security -i`, never on a command line); on Linux a 0600 file under
 * the plugin state folder (rules version 4 holds every read there in a lane);
 * Windows is not offered (lanes are not declared on Windows in P3).
 *
 * No em or en dashes in this file.
 */
import * as nodeFs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'

import {
  isSafeAssistantId,
  isSafeLaneUserId,
  LANE_LOGIN_INHERIT,
  LANE_LOGIN_MODES,
  LANE_LOGIN_OWN_TOKEN,
} from './lane-core.mjs'

/** The keychain service every lane token is stored under. */
export const LANE_TOKEN_SERVICE = 'HOAI lane Claude sign in'

/** The account a token is keyed by: one per agent and person. */
export function laneTokenAccount(assistantId, userId) {
  if (!isSafeAssistantId(assistantId) || !isSafeLaneUserId(userId)) throw new Error('lane token: unsafe key')
  return `${assistantId}:${userId}`
}

/**
 * A token as `claude setup-token` prints it: no spaces, no quotes, nothing a
 * command parser could split. Anything else is refused before it is stored.
 */
export const LANE_TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,4096}$/

export function isPlausibleLaneToken(value) {
  return typeof value === 'string' && LANE_TOKEN_RE.test(value)
}

// ── The per share mode ──────────────────────────────────────────────────────

/** Read the login modes file leniently: unreadable means every share inherits. */
export function readLoginModes(path, { fs = nodeFs } = {}) {
  try {
    const raw = JSON.parse(String(fs.readFileSync(path, 'utf8')))
    const modes = raw?.modes && typeof raw.modes === 'object' ? raw.modes : {}
    const out = {}
    for (const [userId, mode] of Object.entries(modes)) {
      if (isSafeLaneUserId(userId) && LANE_LOGIN_MODES.includes(mode)) out[userId] = mode
    }
    return out
  } catch {
    return {}
  }
}

/** The mode of one share: `inherit` unless the owner chose `own_token`. */
export function loginModeFor(path, userId, deps = {}) {
  return readLoginModes(path, deps)[userId] === LANE_LOGIN_OWN_TOKEN ? LANE_LOGIN_OWN_TOKEN : LANE_LOGIN_INHERIT
}

/** Set one share's mode (atomic write, 0600). */
export function writeLoginMode(path, userId, mode, { fs = nodeFs } = {}) {
  if (!isSafeLaneUserId(userId)) throw new Error('lane login: unsafe person id')
  if (!LANE_LOGIN_MODES.includes(mode)) throw new Error(`lane login: mode must be one of ${LANE_LOGIN_MODES.join(', ')}`)
  const modes = readLoginModes(path, { fs })
  if (mode === LANE_LOGIN_INHERIT) delete modes[userId]
  else modes[userId] = mode
  fs.mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, modes }, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, path)
  return modes
}

// ── The credential store ────────────────────────────────────────────────────

/**
 * The operating system's credential store for lane tokens.
 *
 * @param {{ platform?: string, run?: typeof spawnSync, fs?: typeof nodeFs, fileStoreDir?: (assistantId: string, userId: string) => string }} [deps]
 */
export function laneTokenStore({ platform = process.platform, run = spawnSync, fs = nodeFs, fileStoreDir } = {}) {
  if (platform === 'darwin') {
    return {
      kind: 'macos-keychain',
      read(assistantId, userId) {
        const account = laneTokenAccount(assistantId, userId)
        const out = run('security', ['find-generic-password', '-s', LANE_TOKEN_SERVICE, '-a', account, '-w'], { encoding: 'utf8', timeout: 10_000 })
        if (out?.status === 44) return { ok: false, reason: 'missing' }
        if (out?.status !== 0) return { ok: false, reason: 'unreadable' }
        const token = String(out.stdout ?? '').replace(/\r?\n$/, '')
        return isPlausibleLaneToken(token) ? { ok: true, token } : { ok: false, reason: 'unreadable' }
      },
      write(assistantId, userId, token) {
        if (!isPlausibleLaneToken(token)) throw new Error('lane token: that does not look like a Claude token')
        const account = laneTokenAccount(assistantId, userId)
        // The secret travels on stdin to `security -i`, never in argv.
        const line = `add-generic-password -U -s "${LANE_TOKEN_SERVICE}" -a "${account}" -w "${token}"\n`
        const out = run('security', ['-i'], { input: line, encoding: 'utf8', timeout: 10_000 })
        if (out?.status !== 0) throw new Error('lane token: the keychain refused the write')
      },
      remove(assistantId, userId) {
        const account = laneTokenAccount(assistantId, userId)
        const out = run('security', ['delete-generic-password', '-s', LANE_TOKEN_SERVICE, '-a', account], { encoding: 'utf8', timeout: 10_000 })
        return out?.status === 0
      },
    }
  }
  if (platform === 'linux' && fileStoreDir) {
    const pathOf = (assistantId, userId) => {
      laneTokenAccount(assistantId, userId)
      return join(fileStoreDir(String(assistantId), userId), 'lane-token')
    }
    return {
      kind: 'file-0600',
      read(assistantId, userId) {
        try {
          const token = String(fs.readFileSync(pathOf(assistantId, userId), 'utf8')).trim()
          return isPlausibleLaneToken(token) ? { ok: true, token } : { ok: false, reason: 'unreadable' }
        } catch (err) {
          return { ok: false, reason: err?.code === 'ENOENT' ? 'missing' : 'unreadable' }
        }
      },
      write(assistantId, userId, token) {
        if (!isPlausibleLaneToken(token)) throw new Error('lane token: that does not look like a Claude token')
        const path = pathOf(assistantId, userId)
        fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        const tmp = `${path}.${process.pid}.tmp`
        fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 })
        fs.renameSync(tmp, path)
      },
      remove(assistantId, userId) {
        try {
          fs.unlinkSync(pathOf(assistantId, userId))
          return true
        } catch {
          return false
        }
      },
    }
  }
  return {
    kind: 'unsupported',
    read: () => ({ ok: false, reason: 'store_unsupported' }),
    write: () => { throw new Error('lane token: no credential store is supported on this platform') },
    remove: () => false,
  }
}

/**
 * The login a lane starts with, or why it cannot start. Under `own_token`
 * there is NO fallback: a token that is missing or unreadable is a notice for
 * the person, and the lane does not start.
 *
 * @param {{ mode: string, assistantId: string, userId: string, configDir: string,
 *   store: { read: (a: string, u: string) => { ok: true, token: string } | { ok: false, reason: string } } }} params
 * @returns {{ ok: true, login: { mode: 'inherit' } | { mode: 'own_token', token: string, configDir: string } }
 *   | { ok: false, notice: 'login_token_missing', reason: string }}
 */
export function resolveLaneLogin({ mode, assistantId, userId, configDir, store }) {
  if (mode !== LANE_LOGIN_OWN_TOKEN) return { ok: true, login: { mode: LANE_LOGIN_INHERIT } }
  let read
  try {
    read = store.read(String(assistantId), userId)
  } catch {
    read = { ok: false, reason: 'unreadable' }
  }
  if (!read?.ok) return { ok: false, notice: 'login_token_missing', reason: read?.reason ?? 'unreadable' }
  return { ok: true, login: { mode: LANE_LOGIN_OWN_TOKEN, token: read.token, configDir } }
}

/**
 * The lane's own Claude config folder under option (b): onboarding answered
 * and the working folder trusted, so an interactive start shows no first run
 * screens. Never a credential: the token stays in the environment.
 * @param {{ workDir: string, existing?: Record<string, any> | null }} params
 */
export function laneConfigSeed({ workDir, existing = null }) {
  const base = existing && typeof existing === 'object' ? existing : {}
  const projects = base.projects && typeof base.projects === 'object' ? base.projects : {}
  return {
    ...base,
    hasCompletedOnboarding: true,
    theme: typeof base.theme === 'string' ? base.theme : 'dark',
    projects: {
      ...projects,
      [workDir]: { ...(projects[workDir] ?? {}), hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    },
  }
}
