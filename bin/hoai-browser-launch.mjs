#!/usr/bin/env node
/**
 * hoai-browser-launch: the node launcher that hands the browser shim this
 * agent's relay credentials.
 *
 * WHY IT EXISTS. bin/hoai-browser-mcp.mjs is framework neutral and never reads
 * a plugin's files (decision 11.2 of the relay plan): it takes its relay
 * credentials from the environment and nothing else. Claude Code, however,
 * launches an MCP server with a fixed command and no knowledge of which HOAI
 * agent owns this folder, so someone has to resolve the daemon's credentials
 * first. That is this file: the manifest launches it with node, it resolves the
 * credentials exactly the way server.ts does, and it spawns the shim with
 * HOAI_RELAY_* set. With those set the shim can reach the owner's desktop app
 * from a DIFFERENT machine, through the owner's HOAI account.
 *
 * The resolution lives in lib/agent-credentials.ts, which is TypeScript and
 * therefore unreachable from plain node. So the launcher runs a tiny sibling
 * script under bun (bin/hoai-browser-creds.ts, the same runtime the MCP server
 * uses) and reads one JSON line from its stdout.
 *
 * NOTHING HERE IS FATAL. A missing bun, a resolver that fails, an agent that is
 * not paired yet: each ends with the shim spawned WITHOUT relay env, which is
 * exactly today's behaviour (local mode still drives a desktop app running on
 * this machine), plus one plain stderr line saying the relay is off and why. A
 * pre-set HOAI_RELAY_* env is an operator override and is passed through
 * untouched. No credential is ever logged.
 *
 * Self-contained plain JavaScript: node >= 18 builtins only, plus the pure
 * helpers of bin/bgos-launch.mjs (bun probing, exit-code mapping). Import-safe:
 * every helper is exported and main() only runs when the file is executed
 * directly, so tests exercise the pure pieces.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { exitCodeForChild, resolveBunPath, SIGNAL_EXIT_CODES } from './bgos-launch.mjs'

export { SIGNAL_EXIT_CODES }

/** How long the credentials resolver may take before the relay is given up on. */
export const CREDS_TIMEOUT_MS = 10_000

/** Every stderr line this launcher writes starts here, so it is attributable. */
export const LOG_PREFIX = '[hoai-browser]'

function str(value) {
  return value == null ? '' : String(value)
}

/** This file's directory, i.e. the plugin's bin/ folder. */
export function binDir(moduleUrl = import.meta.url) {
  return dirname(fileURLToPath(moduleUrl))
}

/** The shim this launcher spawns, next to it in bin/. */
export function shimPath(dir) {
  return join(dir, 'hoai-browser-mcp.mjs')
}

/** The bun-run credentials resolver, next to it in bin/. */
export function credentialsScriptPath(dir) {
  return join(dir, 'hoai-browser-creds.ts')
}

/**
 * True when the environment already carries a relay backend URL: an operator
 * (or a channel host that owns the credentials itself) set it deliberately and
 * it wins over anything this launcher would resolve.
 * @param {Record<string, string | undefined>} env
 */
export function hasOperatorRelayEnv(env = {}) {
  return Boolean(str(env.HOAI_RELAY_BACKEND_URL).trim())
}

/**
 * Map one resolver result to the shim's relay env.
 *
 * Pure. Returns { env } with the variables to add, or { reason } with a
 * secret-free sentence for stderr. The pairing lane is the default and sends
 * X-BGOS-Pairing; the api-key lane is legacy and needs the assistant id too.
 * @param {{ backendUrl?: string, pairingToken?: string, apiKey?: string, assistantId?: string, mode?: string, complete?: boolean } | null} resolution
 * @returns {{ env: Record<string, string> | null, reason: string | null }}
 */
export function relayEnvFromResolution(resolution) {
  if (!resolution || typeof resolution !== 'object') {
    return { env: null, reason: 'the credentials resolver returned nothing usable' }
  }
  const backendUrl = str(resolution.backendUrl).trim().replace(/\/+$/, '')
  if (!resolution.complete || !backendUrl) {
    return {
      env: null,
      reason: 'this agent has no complete HOAI credentials on this machine yet (pair it with hoai-pair)',
    }
  }
  const mode = str(resolution.mode).trim()
  if (mode === 'pairing') {
    const pairingToken = str(resolution.pairingToken).trim()
    if (!pairingToken) return { env: null, reason: 'the resolved pairing credentials carry no pairing token' }
    return { env: { HOAI_RELAY_BACKEND_URL: backendUrl, HOAI_RELAY_PAIRING_TOKEN: pairingToken }, reason: null }
  }
  if (mode === 'apikey') {
    const apiKey = str(resolution.apiKey).trim()
    const assistantId = str(resolution.assistantId).trim()
    if (!apiKey || !assistantId) {
      return { env: null, reason: 'the resolved api-key credentials are missing the key or the assistant id' }
    }
    return {
      env: { HOAI_RELAY_BACKEND_URL: backendUrl, HOAI_RELAY_API_KEY: apiKey, HOAI_RELAY_ASSISTANT_ID: assistantId },
      reason: null,
    }
  }
  return { env: null, reason: `the credential mode "${mode || 'unknown'}" is not one the browser relay understands` }
}

/**
 * The last line of a resolver's stdout that parses as a JSON object.
 *
 * The script prints exactly one line, but bun can put install or warning noise
 * on the same stream, so we read from the end rather than trusting line one.
 * @param {string} stdout
 */
export function parseResolverOutput(stdout) {
  const lines = str(stdout).split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // not the JSON line; keep walking backwards.
    }
  }
  return null
}

/**
 * Resolve the relay env for the shim.
 *
 * Order: an operator override wins and nothing is resolved; otherwise bun is
 * probed the way bin/bgos-launch.mjs probes it, the sibling resolver runs under
 * it with a hard timeout, and its one JSON line is mapped to HOAI_RELAY_*.
 * Every failure is a reason string, never a throw.
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   platform?: string,
 *   exists?: (path: string) => boolean,
 *   dir?: string,
 *   spawnSyncImpl?: typeof spawnSync,
 *   timeoutMs?: number,
 * }} [opts]
 * @returns {{ env: Record<string, string> | null, reason: string | null, via: string }}
 */
export function resolveRelayEnv({
  env = {},
  home = '',
  platform = process.platform,
  exists = existsSync,
  dir = '',
  spawnSyncImpl = spawnSync,
  timeoutMs = CREDS_TIMEOUT_MS,
} = {}) {
  if (hasOperatorRelayEnv(env)) return { env: {}, reason: null, via: 'operator' }
  const bun = resolveBunPath({ env, home, platform, exists })
  if (!bun) {
    return {
      env: null,
      reason: 'bun was not found on this machine, so this agent\'s HOAI credentials could not be resolved',
      via: 'no-bun',
    }
  }
  const script = credentialsScriptPath(dir)
  let result
  try {
    result = spawnSyncImpl(bun.path, [script], {
      env,
      timeout: timeoutMs,
      encoding: 'utf8',
      // The resolver must never inherit stdin: this process's stdin is the MCP
      // client's pipe and the shim needs every byte of it.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    return { env: null, reason: `the credentials resolver could not be started (${str(err?.message || err)})`, via: 'spawn-failed' }
  }
  if (!result || result.error) {
    return {
      env: null,
      reason: `the credentials resolver could not be started (${str(result?.error?.message || result?.error || 'unknown error')})`,
      via: 'spawn-failed',
    }
  }
  if (result.signal) {
    return { env: null, reason: `the credentials resolver did not finish within ${Math.round(timeoutMs / 1000)} seconds`, via: 'timeout' }
  }
  if (result.status !== 0) {
    return { env: null, reason: `the credentials resolver exited ${str(result.status)}`, via: 'resolver-failed' }
  }
  const parsed = parseResolverOutput(result.stdout)
  if (!parsed) return { env: null, reason: 'the credentials resolver printed no JSON line', via: 'unparseable' }
  const mapped = relayEnvFromResolution(parsed)
  return { env: mapped.env, reason: mapped.reason, via: mapped.env ? 'resolved' : 'incomplete' }
}

/** The single stderr line that says the relay is off, and why. No secrets. */
export function relayOffMessage(reason) {
  return `${LOG_PREFIX} browser relay off (${reason}); the Agent Browser still works when the Home of Agents desktop app runs on this machine.`
}

// ── main ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the relay env, spawn the shim with it, and resolve with the exit code
 * this process should report.
 * @param {string[]} [argv]
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   platform?: string,
 *   exists?: (path: string) => boolean,
 *   dir?: string,
 *   spawnImpl?: typeof spawn,
 *   spawnSyncImpl?: typeof spawnSync,
 *   writeErr?: (text: string) => void,
 *   onSignal?: (signal: string, handler: () => void) => void,
 *   nodePath?: string,
 *   timeoutMs?: number,
 * }} [opts]
 * @returns {Promise<number>}
 */
export function main(argv = process.argv.slice(2), opts = {}) {
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const platform = opts.platform ?? process.platform
  const exists = opts.exists ?? existsSync
  const dir = opts.dir ?? binDir()
  const spawnImpl = opts.spawnImpl ?? spawn
  const writeErr = opts.writeErr ?? ((text) => process.stderr.write(text))
  const onSignal = opts.onSignal ?? ((signal, handler) => process.on(signal, handler))
  const nodePath = opts.nodePath ?? process.execPath

  return new Promise((resolve) => {
    const relay = resolveRelayEnv({
      env,
      home,
      platform,
      exists,
      dir,
      spawnSyncImpl: opts.spawnSyncImpl,
      timeoutMs: opts.timeoutMs,
    })
    if (relay.reason) writeErr(`${relayOffMessage(relay.reason)}\n`)
    const childEnv = { ...env, ...(relay.env ?? {}) }
    const child = spawnImpl(nodePath, [shimPath(dir), ...argv], { stdio: 'inherit', env: childEnv })
    const forward = (signal) => {
      try {
        child.kill(signal)
      } catch {
        // already gone; nothing to forward to.
      }
    }
    onSignal('SIGTERM', () => forward('SIGTERM'))
    onSignal('SIGINT', () => forward('SIGINT'))
    child.on('error', (err) => {
      writeErr(`${LOG_PREFIX} could not start the browser shim: ${str(err?.message || err)}\n`)
      resolve(1)
    })
    child.on('exit', (code, signal) => resolve(exitCodeForChild(code, signal)))
  })
}

/** True when this file is the process entry point (see bin/bgos-launch.mjs). */
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
      console.error(`${LOG_PREFIX} fatal: ${err?.message ?? err}`)
      process.exitCode = 1
    })
}
