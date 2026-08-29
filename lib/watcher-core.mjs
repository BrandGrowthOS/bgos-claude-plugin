/**
 * watcher-core: the per-machine watcher daemon loop (design 1.5, 2.2, 7.x).
 *
 * One process per machine, installed OUT of the plugin folder
 * (~/.bgos-agent/watcher/, lib/watcher-bundle.mjs) and kept alive by an OS
 * service (lib/watcher-service.mjs). It is the machine-level restart and
 * update authority the app talks to when a machine has no terminal open:
 *
 *   transport   REST long-poll only, node fetch, zero deps, pairing auth
 *               (X-BGOS-Pairing: <watcher token>):
 *               GET  /integrations/machine-rpc/pending?wait=25   -> {frames:[{rpcId, op}]}
 *               POST /integrations/machine-rpc/:rpcId/ack
 *               GET  /integrations/machine-rpc/:rpcId             -> the job body
 *               POST /integrations/machine-rpc/:rpcId/progress    {state, steps, failedStep?, targetVersion?, message?}
 *               POST /integrations/heartbeat                      {daemonVersion, env:{platform, machineId, role:'watcher', agents}}
 *               POST /integrations/update-failures                (lib/update-diagnostics.mjs, on failure)
 *   jobs        reconcile (intent update|reconcile|restart_only|repair):
 *               observe this machine (marketplace files via plugin-cli,
 *               clone git state via exec, the agent inventory), plan it
 *               with the PURE planner, run the plan with the executor,
 *               restart + verify each agent through lib/agent-restart /
 *               lib/agent-verify, post progress after every step, then a
 *               terminal done | failed | rolled_back with the failing step
 *               named, and refresh this watcher's own bundle when the
 *               installed plugin's copy differs (staged swap + self-restart).
 *               create_agent: folder, preseed, pair (bin/bgos-pair.mjs),
 *               launch from the recipe, verify live.
 *   safety      single-flight per machine, a hard per-job deadline, never
 *               exits on network failure (backoff 5s -> 60s), never edits an
 *               agent's credentials, never uses --continue or a session id,
 *               logs scrubbed of tokens / pair codes / home / username.
 *
 * Every effect is injected (fetch, fs, exec, spawnDetached, now, sleep,
 * platform, home, env, the lifecycle modules) so the whole loop runs in a
 * fake HOME against an in-process fake backend in the tests. Plain
 * JavaScript, node >= 18 builtins only, import-safe.
 */

import { homedir } from 'node:os'

import { claudeConfigDir, isUnderPluginsDir } from '../bin/bgos-install-method.mjs'
import {
  buildLaunchRecipe,
  defaultPidAlive,
  joinDir,
  listAgents,
  readFolderPin,
  validAssistantId,
  writeLaunchRecipe,
} from './agent-inventory.mjs'
import { restartAgent } from './agent-restart.mjs'
import { verifyAgent } from './agent-verify.mjs'
import { preseedClaudeTrust } from './claude-preseed.mjs'
import {
  STAGING_DIR_NAME,
  VERSION_RE,
  bundleFingerprint,
  installWatcherBundle,
  joinRel,
  nodeExec,
  nodeFs,
  nodeSpawnDetached,
  readBundleManifest,
  readPluginVersion,
  swapStagedBundle,
  watcherHome,
  watcherLogPath,
  watcherStatePath,
} from './watcher-bundle.mjs'
import { WATCHER_HIDDEN_LAUNCHER_FILE, readWatcherCredentials } from './watcher-service.mjs'

// -- Constants ------------------------------------------------------------------

export const HEARTBEAT_INTERVAL_MS = 60_000
export const LONG_POLL_WAIT_S = 25
export const LONG_POLL_TIMEOUT_MS = 40_000
export const REQUEST_TIMEOUT_MS = 30_000
export const BACKOFF_MIN_MS = 5_000
export const BACKOFF_MAX_MS = 60_000
export const CREDENTIALS_RETRY_MS = 30_000
export const JOB_DEADLINE_MS = 20 * 60_000
export const STAGGER_MS = 10_000
export const VERIFY_TIMEOUT_MS = 120_000
export const PAIR_TIMEOUT_MS = 180_000
export const GIT_TIMEOUT_MS = 120_000
/** `node <staged>/bin/hoai-watcher.mjs help` must answer inside this before a swap. */
const STAGED_BUNDLE_PROBE_TIMEOUT_MS = 30_000
export const PROGRESS_MAX_STEPS = 200
export const PROGRESS_MAX_MESSAGE = 300
export const AGENT_FOLDERS_DIR = 'hoai-agents'
/** Exit code the posix service managers restart us on after a self-refresh (EX_TEMPFAIL). */
export const EXIT_SELF_REFRESH = 75
/** No credentials file (EX_CONFIG); only surfaced in `once` mode, the loop otherwise waits. */
export const EXIT_NO_CREDENTIALS = 78
export const RECONCILE_OPS = Object.freeze(['reconcile', 'update', 'restart_only', 'repair'])
export const INTENTS = Object.freeze(['update', 'reconcile', 'restart_only', 'repair'])
export const CREATE_AGENT_STEP_IDS = Object.freeze(['folder', 'preseed', 'pair', 'launch', 'verify'])
export const MUTATING_STEP_KINDS = Object.freeze(['install_plugin', 'update_plugin', 'reinstall_plugin', 'git_fast_forward'])

// -- Small pure helpers --------------------------------------------------------

/** Mirror of bin/bgos-pair.mjs normalizeApiBase: exactly one trailing /api/v1. */
export function normalizeApiBase(url) {
  let base = String(url ?? '').trim().replace(/\/+$/, '')
  if (!base) return ''
  if (!/\/api\/v1$/.test(base)) base = `${base}/api/v1`
  return base
}

/** Backoff after a failed poll: 5s, 10s, 20s, 40s, 60s, 60s ... */
export function nextBackoff(current) {
  if (!current || current < BACKOFF_MIN_MS) return BACKOFF_MIN_MS
  return Math.min(current * 2, BACKOFF_MAX_MS)
}

function firstLine(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? ''
}

function shortError(err) {
  return firstLine(err?.message ?? err) || 'unknown error'
}

function clip(text, max = PROGRESS_MAX_MESSAGE) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A folder name for ~/hoai-agents/<name>: one path segment, safe charset. */
export function jobFolderName(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return null
  return /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(value) && !/\.\./.test(value) && !/[. ]$/.test(value) ? value : null
}

// -- Log scrubbing (design 1.6 rules, local port) ------------------------------------

const SECRET_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9-]{20,}/g,
  /\bsk-proj-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{20,}/g,
  /\b(?:gh[posu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{8,}/g,
  /\b(?:BGOS|OC)-[A-Z0-9]{2,}(?:-[A-Z0-9]{2,})+\b/g,
]

/**
 * Redact one log line: explicit secrets (the pairing token, a pair code),
 * header values, known key shapes, JWTs, keyword=value assignments, then
 * the home dir (-> ~) and the username (-> <user>). Pure.
 * @param {string} line
 * @param {{ home?: string, username?: string, secrets?: readonly string[] }} [opts]
 */
export function scrubLine(line, { home = '', username = '', secrets = [] } = {}) {
  let out = String(line ?? '')
  for (const secret of secrets) {
    const value = String(secret ?? '')
    if (value.length < 6) continue
    out = out.split(value).join('<redacted>')
  }
  out = out.replace(/(X-BGOS-Pairing\s*[:=]\s*)\S+/gi, '$1<redacted>')
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, 'Bearer <redacted>')
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '<redacted>')
  out = out.replace(
    /((?:api[_-]?key|secret|token|passwd|password|authorization|pairingToken|pairCode)["']?\s*[:=]\s*["']?)([^\s"',}]{8,})/gi,
    '$1<redacted>',
  )
  const homeValue = String(home ?? '').replace(/[\\/]+$/, '')
  if (homeValue) {
    const alt = homeValue.includes('\\') ? homeValue.split('\\').join('/') : homeValue.split('/').join('\\')
    for (const spelling of [homeValue, alt]) {
      if (!spelling) continue
      out = out.replace(new RegExp(escapeRegExp(spelling), /^[A-Za-z]:/.test(spelling) ? 'gi' : 'g'), '~')
    }
  }
  const user = String(username ?? '').trim()
  if (user.length >= 2) out = out.replace(new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(user)}(?![A-Za-z0-9])`, 'gi'), '$1<user>')
  return out
}

/**
 * An append-only line logger writing <watcherHome>/logs/watcher.log through
 * the injected fs, every line scrubbed. Never throws.
 * @param {{ path: string, fs: import('./watcher-bundle.mjs').WatcherFs, now?: () => number,
 *   scrub?: (line: string) => string, echo?: (line: string) => void }} params
 */
export function createLogger({ path, fs, now = Date.now, scrub = (l) => l, echo }) {
  return (message) => {
    let line
    try {
      line = `${new Date(now()).toISOString()} ${scrub(String(message ?? ''))}`
    } catch {
      line = `${new Date().toISOString()} <unloggable>`
    }
    try {
      const existing = fs.readFile(path)
      fs.writeFile(path, `${existing ?? ''}${line}\n`)
    } catch {
      // A log write failure must never stop the watcher.
    }
    if (echo) {
      try {
        echo(line)
      } catch {
        // ignore
      }
    }
  }
}

// -- REST client ----------------------------------------------------------------------

/**
 * @typedef {{ ok: boolean, status: number, json: any, text: string, error: string | null }} RpcResponse
 */

/**
 * The watcher's REST client. Pairing auth on every call, a per-request
 * timeout (AbortController), never throws: a failed request resolves with
 * ok:false + error. Paths may or may not carry a leading slash.
 * @param {{ backendUrl: string, token: string, fetch: typeof fetch, now?: () => number,
 *   log?: (line: string) => void, timeoutMs?: number }} params
 */
export function buildRpcClient({ backendUrl, token, fetch: fetchImpl, log = () => {}, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const apiBase = normalizeApiBase(backendUrl)
  if (!apiBase) throw new Error('buildRpcClient: backendUrl is required')
  if (typeof fetchImpl !== 'function') throw new Error('buildRpcClient: fetch is required (node >= 18)')
  const url = (path) => `${apiBase}/${String(path).replace(/^\/+/, '')}`

  /** @returns {Promise<RpcResponse>} */
  const request = async (method, path, body, opts = {}) => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const budget = opts.timeoutMs ?? timeoutMs
    const timer = controller ? setTimeout(() => controller.abort(), budget) : null
    if (timer && typeof timer.unref === 'function') timer.unref()
    try {
      const res = await fetchImpl(url(path), {
        method,
        headers: {
          'X-BGOS-Pairing': token,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      })
      const text = typeof res.text === 'function' ? await res.text() : ''
      let json = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        json = null
      }
      return { ok: Boolean(res.ok), status: Number(res.status ?? 0), json, text, error: null }
    } catch (err) {
      const message = err?.name === 'AbortError' ? `timeout after ${budget}ms` : shortError(err)
      log(`${method} ${path} failed: ${message}`)
      return { ok: false, status: 0, json: null, text: '', error: message }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    apiBase,
    pending: (waitS = LONG_POLL_WAIT_S) =>
      request('GET', `integrations/machine-rpc/pending?wait=${Math.min(25, Math.max(0, Number(waitS) || 0))}`, undefined, {
        timeoutMs: LONG_POLL_TIMEOUT_MS,
      }),
    ack: (rpcId) => request('POST', `integrations/machine-rpc/${encodeURIComponent(rpcId)}/ack`, {}),
    job: (rpcId) => request('GET', `integrations/machine-rpc/${encodeURIComponent(rpcId)}`),
    progress: (rpcId, body) => request('POST', `integrations/machine-rpc/${encodeURIComponent(rpcId)}/progress`, body),
    heartbeat: (body) => request('POST', 'integrations/heartbeat', body),
    post: (path, body) => request('POST', path, body),
  }
}

// -- Step ledger ------------------------------------------------------------------------

/** The ordered step list a progress report carries: {id, kind, target?, state, message?}. */
export class StepLedger {
  constructor(steps = []) {
    this.steps = []
    this.byId = new Map()
    for (const raw of steps) this.add(raw)
  }
  add(raw) {
    const entry = {
      id: String(raw?.id ?? ''),
      kind: String(raw?.kind ?? raw?.id ?? 'unknown'),
      ...(raw?.target != null ? { target: String(raw.target) } : {}),
      state: raw?.state ?? 'pending',
      ...(raw?.message ? { message: clip(raw.message) } : {}),
    }
    if (!entry.id) return
    if (this.byId.has(entry.id)) return
    this.steps.push(entry)
    this.byId.set(entry.id, entry)
  }
  update(id, payload) {
    let entry = this.byId.get(String(id))
    if (!entry) {
      this.add({ id, kind: payload?.kind ?? id })
      entry = this.byId.get(String(id))
      if (!entry) return
    }
    if (payload?.state) entry.state = payload.state
    const message = payload?.message ?? (payload?.detail ? String(payload.detail) : undefined)
    if (message) entry.message = clip(message)
    else if (payload?.message === '') delete entry.message
  }
  begin(id) {
    this.update(id, { state: 'running' })
  }
  ok(id, message) {
    this.update(id, { state: 'ok', message })
  }
  fail(id, message) {
    this.update(id, { state: 'failed', message })
  }
  skip(id, message) {
    this.update(id, { state: 'skipped', message })
  }
  /** Absorb the executor's final records (authoritative states + messages). */
  absorb(records) {
    for (const rec of Array.isArray(records) ? records : []) {
      if (!rec?.id) continue
      this.update(rec.id, { state: rec.state, message: rec.message ?? rec.detail, kind: rec.kind })
      const entry = this.byId.get(String(rec.id))
      if (entry && rec.kind) entry.kind = String(rec.kind)
      if (entry && rec.target != null) entry.target = String(rec.target)
    }
  }
  view() {
    return this.steps.slice(0, PROGRESS_MAX_STEPS).map((s) => ({ ...s }))
  }
  find(id) {
    return this.byId.get(String(id)) ?? null
  }
}

// -- Observation ------------------------------------------------------------------------

/** A latch or a disabled flag in an agent's auto-update.json reads as latched. */
export function readRollbackLatch(pluginStateDir, fs) {
  const raw = fs.readFile(joinDir(pluginStateDir, 'auto-update.json'))
  if (raw == null) return false
  try {
    const parsed = JSON.parse(raw)
    return Boolean(parsed && typeof parsed === 'object' && (parsed.disabled === true || parsed.latched === true))
  } catch {
    return false
  }
}

/** Mirror of lib/self-update.ts: BGOS_AUTO_UPDATE=off disables; anything else enables. */
export function autoUpdateEnabledFrom(env) {
  return String(env?.BGOS_AUTO_UPDATE ?? 'on').trim().toLowerCase() !== 'off'
}

function toCliResult(res) {
  return {
    code: res?.code ?? null,
    stdout: String(res?.stdout ?? ''),
    stderr: String(res?.stderr ?? (res?.error ? `${res.error}\n` : '')),
    timedOut: Boolean(res?.timedOut),
  }
}

/**
 * The clone checkout's git state, read via exec (design 1.2 clone shape).
 * Never throws; anything unreadable is null / false.
 * @param {{ pluginRoot: string, exec: import('./watcher-bundle.mjs').Exec, fs: import('./watcher-bundle.mjs').WatcherFs,
 *   fetchRemote?: boolean, log?: (line: string) => void }} params
 */
export async function observeCloneInstall({ pluginRoot, exec, fs, fetchRemote = true, log = () => {} }) {
  const git = async (args) => toCliResult(await exec('git', args, { cwd: pluginRoot, timeoutMs: GIT_TIMEOUT_MS }))
  const ok = (r) => !r.timedOut && r.code === 0
  const head = await git(['rev-parse', 'HEAD'])
  const currentCommit = ok(head) ? head.stdout.trim() : null
  const status = await git(['status', '--porcelain', '--untracked-files=no'])
  const dirty = ok(status) ? status.stdout.trim().length > 0 : false
  if (fetchRemote && currentCommit) {
    const fetched = await git(['fetch', '--quiet'])
    if (!ok(fetched)) log(`git fetch failed (rc ${fetched.code}): ${firstLine(fetched.stderr)}`)
  }
  const upstream = currentCommit ? await git(['rev-parse', '@{u}']) : null
  const targetCommit = upstream && ok(upstream) ? upstream.stdout.trim() : null
  let canFastForward = false
  if (currentCommit && targetCommit) {
    const ancestor = await git(['merge-base', '--is-ancestor', 'HEAD', '@{u}'])
    canFastForward = ok(ancestor)
  }
  let latestVersion = null
  if (targetCommit) {
    const pkg = await git(['show', '@{u}:package.json'])
    if (ok(pkg)) {
      try {
        const version = String(JSON.parse(pkg.stdout)?.version ?? '').trim()
        latestVersion = VERSION_RE.test(version) ? version : null
      } catch {
        latestVersion = null
      }
    }
  }
  return { latestVersion, dirty, canFastForward, currentCommit, targetCommit, currentVersion: readPluginVersion(pluginRoot, fs) }
}

/**
 * Observe this machine and shape it as the planner's ObservedMachineState
 * (design 1.2). Agents come from the inventory, filtered to `targets` when
 * given. Never guesses a version: unknown stays null.
 * @returns {Promise<{ state: object, configDir: string, pluginRoot: string | null, installMethod: 'marketplace'|'clone',
 *   agents: import('./agent-inventory.mjs').AgentRow[], missingTargets: string[], marketplace: any, clone: any }>}
 */
/** ~/.claude, the config dir when CLAUDE_CONFIG_DIR is unset. */
function defaultClaudeDir(home) {
  return joinDir(home, '.claude')
}

/** Same directory, tolerant of slash style, a trailing separator, and case on win32. */
export function sameDir(a, b, platform) {
  const norm = (p) => {
    let s = String(p ?? '').trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '')
    if (platform === 'win32') s = s.toLowerCase()
    return s
  }
  return norm(a) === norm(b)
}

export async function observeMachine({
  home,
  env,
  platform,
  fs,
  exec,
  pidAlive = defaultPidAlive,
  modules,
  manifest = null,
  targets = [],
  intent = 'reconcile',
  refreshWatcher = false,
  pluginRootOverride = null,
  log = () => {},
}) {
  const configDir = claudeConfigDir({ env, home })
  const allAgents = listAgents({ home, env, platform, fs, pidAlive })
  const targetIds = new Set(
    (Array.isArray(targets) ? targets : [])
      .map((t) => validAssistantId(t?.assistantId ?? t))
      .filter((id) => Boolean(id)),
  )
  const agents = targetIds.size ? allAgents.filter((a) => targetIds.has(a.assistantId)) : allAgents
  const missingTargets = [...targetIds].filter((id) => !allAgents.some((a) => a.assistantId === id))
  if (missingTargets.length) log(`targets not on this machine: ${missingTargets.join(', ')}`)
  // An agent whose recipe names a DIFFERENT Claude config dir runs a
  // different plugin install; planning against this watcher's install would
  // update one and restart the other. Named, never guessed.
  const configDirMismatch = agents
    .filter((a) => a.recipe && !sameDir(a.recipe.claudeConfigDir || defaultClaudeDir(home), configDir, platform))
    .map((a) => a.assistantId)

  let pluginRoot =
    String(pluginRootOverride ?? '').trim() ||
    manifest?.pluginRoot ||
    agents.map((a) => a.recipe?.pluginRoot).find((r) => Boolean(r)) ||
    null
  const recipeMethod = agents.map((a) => a.recipe?.installMethod).find((m) => m === 'clone' || m === 'marketplace') ?? null
  let installMethod = pluginRoot ? (isUnderPluginsDir(pluginRoot, { env, home }) ? 'marketplace' : 'clone') : recipeMethod ?? 'marketplace'
  if (!pluginRoot && recipeMethod) installMethod = recipeMethod

  const readFileOrThrow = (path) => {
    const text = fs.readFile(path)
    if (text == null) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return text
  }
  const marketplace = await modules.observeMarketplaceInstall({ configDir, readFile: readFileOrThrow, exists: fs.exists })
  let clone = null
  let runningVersion = null
  if (installMethod === 'marketplace') {
    if (marketplace.installed?.installPath) pluginRoot = marketplace.installed.installPath
    runningVersion = marketplace.installed?.version ?? null
  } else {
    clone = pluginRoot ? await observeCloneInstall({ pluginRoot, exec, fs, log }) : null
    runningVersion = clone?.currentVersion ?? null
  }
  const state = {
    platform,
    installMethod,
    runningVersion,
    marketplace: { registered: Boolean(marketplace.marketplaceRegistered), latestVersion: marketplace.marketplaceLatest?.version ?? null },
    installed: {
      present: Boolean(marketplace.installed?.present),
      version: marketplace.installed?.version ?? null,
      installPath: marketplace.installed?.installPath ?? null,
    },
    ...(clone
      ? {
          clone: {
            latestVersion: clone.latestVersion,
            dirty: clone.dirty,
            canFastForward: clone.canFastForward,
            currentCommit: clone.currentCommit,
            targetCommit: clone.targetCommit,
          },
        }
      : {}),
    autoUpdateEnabled: autoUpdateEnabledFrom(env),
    rollbackLatched: agents.some((a) => readRollbackLatch(a.pluginStateDir, fs)),
    agents: agents.map((a) => ({
      assistantId: a.assistantId,
      cwd: a.cwd,
      supervisor: a.supervisor,
      recipe: Boolean(a.recipe),
      running: a.running,
      // How this agent was found at all, so the plan can state the basis of
      // its own checklist instead of implying it covers the machine.
      discoveredVia: a.discoveredVia ?? 'credentials',
    })),
    intent: INTENTS.includes(intent) ? intent : 'reconcile',
    refreshWatcher: Boolean(refreshWatcher),
  }
  return { state, configDir, pluginRoot, installMethod, agents, missingTargets, configDirMismatch, marketplace, clone }
}

// -- Watcher self refresh -------------------------------------------------------------------

/**
 * Refresh the installed watcher bundle from `pluginRoot` when its files
 * differ from what the manifest recorded: stage into next/, atomic swap.
 * @returns {Promise<{ needed: boolean, ok: boolean, message: string, fingerprint: string | null }>}
 */
export async function refreshWatcherIfStale({ home, fs, now, manifest, pluginRoot, exec = null, nodePath = null, log = () => {} }) {
  // Not knowing whether a refresh is needed is NOT the same as being current, and this used to
  // claim it was: { needed: false, ok: true }. Because runReconcileJob only records a ledger step
  // when `needed` is true, that did not merely look green, it made the state invisible. A watcher
  // permanently stuck on an old bundle, unable to see the plugin it should refresh from, reported
  // nothing at all, forever. Surface it as a failed step instead: the caller still refuses to
  // self-restart (it requires needed && ok), so this changes what is REPORTED, not what is done.
  if (!pluginRoot) return { needed: true, ok: false, message: 'watcher_bundle_source_unknown', fingerprint: null }
  const fingerprint = bundleFingerprint(pluginRoot, fs)
  if (manifest && manifest.fingerprint === fingerprint) {
    return { needed: false, ok: true, message: 'watcher_bundle_current', fingerprint }
  }
  try {
    const stagingDir = joinDir(watcherHome(home), STAGING_DIR_NAME)
    const staged = await installWatcherBundle({ pluginRoot, home, fs, now, targetDir: stagingDir })
    // The staged bundle must at least load under the node that will run it;
    // a swap to an unloadable bundle is a crash loop on posix and a dead
    // watcher until next logon on win32, and nothing on the machine repairs it.
    if (typeof exec === 'function' && nodePath) {
      const probe = await exec(nodePath, [joinDir(joinDir(stagingDir, 'bin'), 'hoai-watcher.mjs'), 'help'], { timeoutMs: STAGED_BUNDLE_PROBE_TIMEOUT_MS })
      if (probe?.code !== 0) {
        try {
          fs.rm(stagingDir)
        } catch {
          // leftover staging is cleared by the next attempt
        }
        log(`watcher refresh: staged bundle ${staged.version} does not load under ${nodePath} (rc ${probe?.code ?? 'null'}); keeping the current bundle`)
        return { needed: true, ok: false, message: 'watcher_refresh_failed:staged_bundle_unloadable', fingerprint }
      }
    }
    const swap = swapStagedBundle({ home, fs })
    if (!swap.ok) {
      log(`watcher refresh: swap failed: ${swap.message}`)
      return { needed: true, ok: false, message: `watcher_refresh_failed:${swap.message}`, fingerprint }
    }
    log(`watcher refresh: bundle ${staged.version} (${fingerprint.slice(0, 12)}) swapped in from ${pluginRoot}`)
    return { needed: true, ok: true, message: `watcher_bundle_refreshed:${staged.version}`, fingerprint }
  } catch (err) {
    log(`watcher refresh failed: ${shortError(err)}`)
    return { needed: true, ok: false, message: `watcher_refresh_failed:${shortError(err)}`, fingerprint }
  }
}

/**
 * How this process restarts itself after a bundle refresh: posix exits 75
 * and the service manager (KeepAlive / Restart=always) starts the new
 * bundle; win32 spawns a detached successor through the hidden vbs
 * launcher and exits 0 (a Scheduled Task does not restart on exit).
 * @returns {number} the exit code to leave with
 */
export function selfRestartExitCode({ platform, home, spawnDetached, log = () => {} }) {
  if (platform !== 'win32') return EXIT_SELF_REFRESH
  const vbs = joinDir(watcherHome(home), WATCHER_HIDDEN_LAUNCHER_FILE)
  try {
    spawnDetached('wscript.exe', ['//B', vbs], { cwd: watcherHome(home), windowsHide: true })
    log('watcher refresh: successor spawned via run-hidden.vbs; exiting')
    return 0
  } catch (err) {
    log(`watcher refresh: could not spawn the successor (${shortError(err)}); exiting for the task to relaunch at next logon`)
    return EXIT_SELF_REFRESH
  }
}

/**
 * Refresh the watcher bundle when stale and decide how this process leaves.
 * A manual `hoai-watcher reconcile` (ctx.noSelfRefresh) never swaps or
 * restarts: the SERVICE watcher owns the bundle, and a CLI spawning a
 * successor would leave two watchers long-polling side by side.
 * @returns {Promise<{ needed: boolean, ok: boolean, message: string, exitCode: number | null }>}
 */
async function maybeRefreshWatcher({ ctx, home, fs, now, manifest, pluginRoot, platform, log }) {
  if (ctx.noSelfRefresh) {
    const fingerprint = pluginRoot ? bundleFingerprint(pluginRoot, fs) : null
    if (manifest && fingerprint && manifest.fingerprint !== fingerprint) {
      log('watcher bundle is stale; run `hoai-watcher install` to refresh it (the manual reconcile never swaps the service bundle)')
      return { needed: true, ok: true, message: 'watcher_bundle_stale_manual', exitCode: null }
    }
    return { needed: false, ok: true, message: 'watcher_bundle_current', exitCode: null }
  }
  const refresh = await refreshWatcherIfStale({ home, fs, now, manifest, pluginRoot, exec: ctx.exec, nodePath: ctx.nodePath, log })
  if (!refresh.needed || !refresh.ok) return { ...refresh, exitCode: null }
  return { ...refresh, exitCode: selfRestartExitCode({ platform, home, spawnDetached: ctx.spawnDetached, log }) }
}

// -- Jobs ----------------------------------------------------------------------------------

function evidenceString(evidence) {
  if (!evidence || typeof evidence !== 'object') return ''
  const parts = []
  if (evidence.via) parts.push(`via:${evidence.via}`)
  if (evidence.lastLiveAt) parts.push(`lastLiveAt:${evidence.lastLiveAt}`)
  return parts.join(' ')
}

/** The executor's fs surface from the watcher's (readdir alias, throwing readFile). */
export function executorFsFrom(fs) {
  return {
    readFile: (path) => {
      const text = fs.readFile(path)
      if (text == null) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return text
    },
    writeFile: (path, text) => fs.writeFile(path, text),
    exists: (path) => fs.exists(path),
    mkdir: (path) => fs.mkdir(path),
    rm: (path) => fs.rm(path),
    readdir: (path) => fs.listDir(path),
    copyFile: (src, dst) => fs.copyFile(src, dst),
  }
}

function pluginChanged(result) {
  return (Array.isArray(result?.steps) ? result.steps : []).some((s) => MUTATING_STEP_KINDS.includes(s?.kind) && s?.state === 'ok')
}

/**
 * The reconcile job: observe, plan, execute, report, refresh self.
 * @returns {Promise<{ state: string, exitCode: number | null }>}
 */
export async function runReconcileJob(ctx, rpcId, job) {
  const { client, log, now, sleep, fs, exec, env, home, platform, modules, manifest } = ctx
  const op = String(job?.op ?? '')
  const intent = INTENTS.includes(job?.intent) ? job.intent : op === 'update' || op === 'restart_only' || op === 'repair' ? op : 'reconcile'
  const post = (state, steps, extra = {}) =>
    client.progress(rpcId, { state, steps: steps.view(), ...extra, ...(extra.message ? { message: clip(extra.message) } : {}) })

  await post('planning', new StepLedger())
  let observed
  try {
    observed = await observeMachine({
      home,
      env,
      platform,
      fs,
      exec,
      pidAlive: ctx.pidAlive,
      modules,
      manifest,
      targets: job?.targets,
      intent,
      pluginRootOverride: ctx.pluginRootOverride,
      log,
    })
  } catch (err) {
    log(`observe failed: ${shortError(err)}`)
    await post('failed', new StepLedger(), { message: `observe_failed:${shortError(err)}` })
    return { state: 'failed', exitCode: null }
  }
  log(
    `observed: method=${observed.installMethod} running=${observed.state.runningVersion ?? 'unknown'} ` +
      `latest=${observed.state.marketplace?.latestVersion ?? observed.state.clone?.latestVersion ?? 'unknown'} ` +
      `agents=${observed.agents.map((a) => `${a.assistantId}:${a.supervisor}${a.recipe ? '+recipe' : ''}`).join(',') || 'none'} intent=${intent}`,
  )
  if (Array.isArray(observed.configDirMismatch) && observed.configDirMismatch.length) {
    const ids = observed.configDirMismatch.join(',')
    log(`config dir mismatch: agent(s) ${ids} run under a different CLAUDE_CONFIG_DIR than this watcher (${observed.configDir}); refusing to plan against the wrong install`)
    await post('failed', new StepLedger(), { message: `config_dir_mismatch:${ids}` })
    return { state: 'failed', exitCode: null }
  }
  const plan = modules.planMachine(observed.state)
  const steps = new StepLedger(plan.steps)
  log(`plan: ${plan.verdict}${plan.reason ? ` (${plan.reason})` : ''} target=${plan.targetVersion ?? 'unknown'} steps=${steps.steps.map((s) => s.id).join(',') || 'none'}`)
  if (plan.verdict === 'blocked') {
    await post('failed', steps, { message: String(plan.reason ?? 'blocked'), targetVersion: plan.targetVersion ?? undefined })
    return { state: 'failed', exitCode: null }
  }
  if (plan.verdict === 'nothing_to_do' || steps.steps.length === 0) {
    // Nothing for the agents, but the WATCHER may be behind: a daemon-side
    // update (update_rpc) moves the plugin without running this loop, and
    // an old planner/executor would otherwise stay in memory until the
    // watcher performs a later update itself.
    let exitCode = null
    const refresh = await maybeRefreshWatcher({ ctx, home, fs, now, manifest, pluginRoot: observed.pluginRoot, platform, log })
    if (refresh.needed) steps.add({ id: 'refresh_watcher', kind: 'refresh_watcher', state: refresh.ok ? 'ok' : 'failed', message: refresh.message })
    if (refresh.needed && refresh.ok) exitCode = refresh.exitCode
    await post('done', steps, { message: 'nothing_to_do', targetVersion: plan.targetVersion ?? undefined })
    return { state: 'done', exitCode }
  }
  await post('running', steps, { targetVersion: plan.targetVersion ?? undefined })

  const deadlineAt = now() + ctx.jobDeadlineMs
  const pastDeadline = () => now() > deadlineAt
  const agentsById = new Map(observed.agents.map((a) => [a.assistantId, a]))
  const rowFor = (agent) => agentsById.get(String(agent?.assistantId ?? '')) ?? null
  const deps = {
    cli: (args, opts = {}) =>
      pastDeadline()
        ? Promise.resolve({ code: null, stdout: '', stderr: 'job_deadline_exceeded', timedOut: true })
        : modules.runClaudeCli(args, { timeoutMs: opts.timeoutMs, env, platform }),
    fs: typeof modules.executorFs === 'function' ? modules.executorFs() : executorFsFrom(fs),
    home,
    configDir: observed.configDir,
    platform,
    localAppData: String(env.LOCALAPPDATA ?? '').trim() || null,
    installMethod: observed.installMethod,
    pluginRoot: observed.pluginRoot,
    clone: { targetCommit: observed.state.clone?.targetCommit ?? null },
    git: async (args, cwd) =>
      pastDeadline()
        ? { code: null, stdout: '', stderr: 'job_deadline_exceeded', timedOut: true }
        : toCliResult(await exec('git', args, { cwd: cwd || observed.pluginRoot, timeoutMs: GIT_TIMEOUT_MS })),
    agents: observed.agents,
    restartAgent: async (agent, { via } = {}) => {
      if (pastDeadline()) return { ok: false, how: 'none', message: 'job_deadline_exceeded' }
      const row = rowFor(agent)
      if (!row) return { ok: false, how: 'none', message: `agent_not_in_inventory:${agent?.assistantId ?? '?'}` }
      const out = await restartAgent(row, {
        platform,
        pluginRoot: observed.pluginRoot,
        nodePath: ctx.nodePath,
        fs,
        exec,
        spawnDetached: ctx.spawnDetached,
        now,
        env,
        uid: ctx.uid,
        hasTmux: ctx.hasTmux,
        hasScript: ctx.hasScript,
        hasCommand: ctx.hasCommand,
      })
      log(`restart ${row.assistantId} via ${out.how} (planned ${via ?? 'auto'}): ${out.ok ? 'ok' : 'FAILED'} ${out.message}`)
      return out
    },
    verifyAgent: async (agent, { restartedAtMs, timeoutMs } = {}) => {
      if (pastDeadline()) return { ok: false, evidence: '', message: 'job_deadline_exceeded' }
      const row = rowFor(agent)
      if (!row) return { ok: false, evidence: '', message: `agent_not_in_inventory:${agent?.assistantId ?? '?'}` }
      const out = await verifyAgent(row, { restartedAtMs, fs, now, sleep, timeoutMs: timeoutMs ?? ctx.verifyTimeoutMs, requestProbe: true, log })
      log(`verify ${row.assistantId}: ${out.ok ? 'live' : 'FAILED'} ${out.message} ${evidenceString(out.evidence)}`)
      return { ok: out.ok, evidence: evidenceString(out.evidence), message: out.message }
    },
    now,
    sleep,
    staggerMs: ctx.staggerMs,
    verifyTimeoutMs: ctx.verifyTimeoutMs,
    log,
  }
  const report = async (stepId, payload) => {
    steps.update(stepId, payload)
    await ctx.heartbeatIfDue()
    await post('running', steps, { targetVersion: plan.targetVersion ?? undefined })
  }
  const result = await modules.executePlan(plan, deps, report)
  steps.absorb(result.steps)
  let terminal = result.ok ? 'done' : result.rolledBack ? 'rolled_back' : 'failed'
  let exitCode = null
  let message = result.failedStep ? `${result.failedStep.kind}:${result.failedStep.message}` : terminal === 'done' ? (pluginChanged(result) ? 'updated' : 'reconciled') : undefined

  if (result.ok) {
    // Re-observe the plugin root (a marketplace update moved the cache dir).
    let currentRoot = observed.pluginRoot
    try {
      const again = await modules.observeMarketplaceInstall({ configDir: observed.configDir, readFile: deps.fs.readFile, exists: fs.exists })
      if (observed.installMethod === 'marketplace' && again.installed?.installPath) currentRoot = again.installed.installPath
    } catch {
      // keep the pre-run root
    }
    const refresh = await maybeRefreshWatcher({ ctx, home, fs, now, manifest, pluginRoot: currentRoot, platform, log })
    if (refresh.needed) {
      steps.add({ id: 'refresh_watcher', kind: 'refresh_watcher', state: refresh.ok ? 'ok' : 'failed', message: refresh.message })
      if (!refresh.ok) message = refresh.message
      else exitCode = refresh.exitCode
    }
  }
  await post(terminal, steps, {
    ...(result.failedStep ? { failedStep: { id: result.failedStep.id, kind: result.failedStep.kind, ...(result.failedStep.target ? { target: result.failedStep.target } : {}), message: clip(result.failedStep.message) } } : {}),
    targetVersion: result.targetVersion ?? plan.targetVersion ?? undefined,
    ...(message ? { message } : {}),
  })
  log(`job ${rpcId}: ${terminal}${result.failedStep ? ` at ${result.failedStep.id} (${result.failedStep.message})` : ''}`)
  if (!result.ok && typeof modules.buildFailureDiagnostics === 'function' && typeof modules.postFailureDiagnostics === 'function') {
    try {
      const diagnostics = modules.buildFailureDiagnostics({
        plan,
        result,
        state: observed.state,
        platform,
        installMethod: observed.installMethod,
        pluginVersion: observed.state.runningVersion,
        targetVersion: result.targetVersion ?? plan.targetVersion ?? null,
        cliVersion: null,
        nodeVersion: process.version,
        watcherVersion: manifest?.version ?? null,
        home,
        username: ctx.username,
      })
      await modules.postFailureDiagnostics((path, body) => client.post(path, body), diagnostics)
    } catch (err) {
      log(`diagnostics post failed: ${shortError(err)}`)
    }
  }
  return { state: terminal, exitCode }
}

/**
 * The create_agent job: folder, preseed, pair, launch, verify.
 * @returns {Promise<{ state: string, exitCode: number | null }>}
 */
export async function runCreateAgentJob(ctx, rpcId, job) {
  const { client, log, now, sleep, fs, exec, env, home, platform, manifest, credentials } = ctx
  const steps = new StepLedger(CREATE_AGENT_STEP_IDS.map((id) => ({ id, kind: id })))
  const post = (state, extra = {}) => client.progress(rpcId, { state, steps: steps.view(), ...extra })
  const fail = async (id, message) => {
    steps.fail(id, message)
    log(`create_agent ${rpcId}: failed at ${id}: ${message}`)
    await post('failed', { failedStep: { id, kind: id, message: clip(message) }, message: clip(message) })
    return { state: 'failed', exitCode: null }
  }

  const assistantId = validAssistantId(job?.assistantId)
  if (!assistantId) return fail('folder', 'invalid_assistant_id')
  const pairCode = String(job?.pairCode ?? '').trim()
  if (!pairCode) return fail('pair', 'missing_pair_code')
  ctx.secrets.push(pairCode)
  const folderName = job?.folderName == null || String(job.folderName).trim() === '' ? `agent-${assistantId}` : jobFolderName(job.folderName)
  if (!folderName) return fail('folder', 'invalid_folder_name')
  const folder = joinDir(joinDir(home, AGENT_FOLDERS_DIR), folderName)
  const configDir = claudeConfigDir({ env, home })
  let pluginRoot = String(ctx.pluginRootOverride ?? '').trim() || manifest?.pluginRoot || null
  try {
    const marketplace = await ctx.modules.observeMarketplaceInstall({ configDir, readFile: executorFsFrom(fs).readFile, exists: fs.exists })
    if (marketplace.installed?.installPath && (!pluginRoot || isUnderPluginsDir(pluginRoot, { env, home }))) pluginRoot = marketplace.installed.installPath
  } catch {
    // keep the manifest root
  }
  if (!pluginRoot) return fail('pair', 'plugin_root_unknown')
  const installMethod = isUnderPluginsDir(pluginRoot, { env, home }) ? 'marketplace' : 'clone'
  await post('running')

  // folder
  steps.begin('folder')
  const pin = readFolderPin(folder, fs.readFile)
  if (pin && pin !== assistantId) return fail('folder', `folder_pinned_to_other_agent:${pin}`)
  try {
    fs.mkdir(folder)
  } catch (err) {
    return fail('folder', `mkdir_failed:${shortError(err)}`)
  }
  steps.ok('folder', `~/${AGENT_FOLDERS_DIR}/${folderName}`)
  await post('running')

  // preseed
  steps.begin('preseed')
  try {
    preseedClaudeTrust({ configDir, cwd: folder, fs: { readFile: fs.readFile, writeFile: (p, t) => fs.writeFile(p, t) } })
    steps.ok('preseed', 'trust + prompt acceptance seeded')
  } catch (err) {
    steps.skip('preseed', `preseed_failed:${shortError(err)}`)
    log(`create_agent: preseed failed (continuing): ${shortError(err)}`)
  }
  await post('running')

  // pair
  steps.begin('pair')
  await post('running')
  const pairScript = joinRel(pluginRoot, 'bin/bgos-pair.mjs')
  const pairArgs = [pairScript, pairCode, '--assistant-id', assistantId, '--backend', credentials.backendUrl]
  const paired = await exec(ctx.nodePath, pairArgs, { cwd: folder, env, timeoutMs: PAIR_TIMEOUT_MS })
  if (paired.code !== 0 && paired.code !== 3) {
    const reason = firstLine(paired.stderr) || firstLine(paired.stdout) || String(paired.error ?? '')
    return fail('pair', `pair_exit_${paired.code ?? 'spawn'}${reason ? `:${reason}` : ''}`)
  }
  const pinAfter = readFolderPin(folder, fs.readFile)
  const credsPath = joinDir(joinDir(home, '.bgos-agent'), `credentials-${assistantId}.json`)
  if (pinAfter !== assistantId || !fs.exists(credsPath)) {
    return fail('pair', `pair_exit_${paired.code}_unverified: folder pin or credentials missing after pairing`)
  }
  steps.ok('pair', paired.code === 3 ? 'paired (folder pin resolves the identity)' : 'paired')
  await post('running')

  // launch
  steps.begin('launch')
  await post('running')
  const recipe = buildLaunchRecipe({
    assistantId,
    cwd: folder,
    argv: [],
    installMethod,
    pluginRoot,
    node: ctx.nodePath,
    startedAt: new Date(now()).toISOString(),
    pid: null,
  })
  if (!writeLaunchRecipe({ home, assistantId, recipe, writeFile: (p, t) => (fs.writeFile(p, t), true) })) {
    log('create_agent: recipe write failed (continuing, hoai-core rewrites it at launch)')
  }
  const agent = listAgents({ home, env, platform, fs, pidAlive: ctx.pidAlive }).find((a) => a.assistantId === assistantId)
  if (!agent) return fail('launch', 'agent_not_on_disk_after_pair')
  if (!agent.recipe) return fail('launch', `recipe_rejected:${agent.notes.join(',') || 'unknown'}`)
  const restartedAtMs = now()
  const launched = await restartAgent(agent, {
    platform,
    pluginRoot,
    nodePath: ctx.nodePath,
    fs,
    exec,
    spawnDetached: ctx.spawnDetached,
    now,
    env,
    uid: ctx.uid,
    hasTmux: ctx.hasTmux,
    hasScript: ctx.hasScript,
    hasCommand: ctx.hasCommand,
  })
  if (!launched.ok) return fail('launch', `launch_failed:${launched.how}:${launched.message}`)
  steps.ok('launch', `launched via ${launched.how}`)
  await post('running')

  // verify (a NEW pairing proves itself with the boot hello; the probe is harmless)
  steps.begin('verify')
  await post('running')
  const verified = await verifyAgent(agent, { restartedAtMs, fs, now, sleep, timeoutMs: ctx.verifyTimeoutMs, requestProbe: true, log })
  if (!verified.ok) return fail('verify', verified.message)
  steps.ok('verify', `live ${evidenceString(verified.evidence)}`.trim())
  await post('done', { message: `agent ${assistantId} live in ~/${AGENT_FOLDERS_DIR}/${folderName}` })
  log(`create_agent ${rpcId}: done (assistant ${assistantId})`)
  return { state: 'done', exitCode: null }
}

/** Dispatch one pending frame: ack, fetch the job body, run it single-flight. */
export async function handleFrame(ctx, frame) {
  const { client, log } = ctx
  const rpcId = String(frame?.rpcId ?? '').trim()
  if (!rpcId) return null
  const op = String(frame?.op ?? '')
  log(`frame ${rpcId} op=${op || 'unknown'}`)
  const ack = await client.ack(rpcId)
  if (!ack.ok) log(`ack ${rpcId} failed (status ${ack.status}${ack.error ? `, ${ack.error}` : ''})`)
  const jobRes = await client.job(rpcId)
  if (!jobRes.ok || !jobRes.json || typeof jobRes.json !== 'object') {
    log(`job ${rpcId} fetch failed (status ${jobRes.status})`)
    await client.progress(rpcId, { state: 'failed', steps: [], message: `job_fetch_failed:${jobRes.status}` })
    return null
  }
  const job = jobRes.json
  if (ctx.busy) {
    await client.progress(rpcId, { state: 'failed', steps: [], message: 'job_in_flight' })
    return null
  }
  ctx.busy = true
  const kind = String(job.op ?? op)
  let outcome = { state: 'failed', exitCode: null }
  try {
    if (kind === 'create_agent') outcome = await runCreateAgentJob(ctx, rpcId, job)
    else if (RECONCILE_OPS.includes(kind)) outcome = await runReconcileJob(ctx, rpcId, { ...job, op: kind })
    else {
      await client.progress(rpcId, { state: 'failed', steps: [], message: `unknown_op:${clip(kind, 40)}` })
      outcome = { state: 'failed', exitCode: null }
    }
  } catch (err) {
    log(`job ${rpcId} threw: ${shortError(err)}`)
    await client.progress(rpcId, { state: 'failed', steps: [], message: `internal_error:${shortError(err)}` })
  } finally {
    ctx.busy = false
    ctx.writeState({ lastJob: { rpcId, op: kind, state: outcome.state, at: new Date(ctx.now()).toISOString() } })
  }
  return outcome.exitCode
}

// -- Module loading ----------------------------------------------------------------------------

/** The lifecycle modules the loop needs (siblings in the bundle), loaded lazily
 *  so tests can inject fakes and a partial bundle fails by name at run time. */
export async function loadLifecycleModules() {
  const [planner, executor, cli, diagnostics] = await Promise.all([
    import('./update-planner.mjs'),
    import('./update-executor.mjs'),
    import('./plugin-cli.mjs'),
    import('./update-diagnostics.mjs'),
  ])
  return {
    planMachine: planner.planMachine,
    executePlan: executor.executePlan,
    executorFs: executor.nodeFs,
    runClaudeCli: cli.runClaudeCli,
    observeMarketplaceInstall: cli.observeMarketplaceInstall,
    buildFailureDiagnostics: diagnostics.buildFailureDiagnostics,
    postFailureDiagnostics: diagnostics.postFailureDiagnostics,
  }
}

// -- The loop -----------------------------------------------------------------------------------

/**
 * Run the watcher. Resolves only when `once` is set (after one poll cycle)
 * or when a self-refresh asks the process to exit (the returned code).
 * @param {{
 *   home?: string, env?: Record<string, string | undefined>, platform?: string,
 *   fetch?: typeof fetch, fs?: import('./watcher-bundle.mjs').WatcherFs,
 *   exec?: import('./watcher-bundle.mjs').Exec, spawnDetached?: import('./watcher-bundle.mjs').SpawnDetached,
 *   now?: () => number, sleep?: (ms: number) => Promise<unknown>, log?: (line: string) => void,
 *   echo?: (line: string) => void, once?: boolean, modules?: object, nodePath?: string,
 *   uid?: number | null, username?: string, pidAlive?: (pid: number) => boolean,
 *   hasTmux?: boolean, hasScript?: boolean, hasCommand?: (name: string) => boolean,
 *   pluginRootOverride?: string | null, jobDeadlineMs?: number, staggerMs?: number,
 *   verifyTimeoutMs?: number, heartbeatIntervalMs?: number, credentialsRetryMs?: number,
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function runWatcher(deps = {}) {
  const home = deps.home ?? homedir()
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const fs = deps.fs ?? nodeFs()
  const exec = deps.exec ?? nodeExec()
  const spawnDetached = deps.spawnDetached ?? nodeSpawnDetached()
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const once = Boolean(deps.once)
  const username = String(deps.username ?? env.USER ?? env.USERNAME ?? '').trim()
  const secrets = []
  const log =
    deps.log ??
    createLogger({
      path: watcherLogPath(home),
      fs,
      now,
      scrub: (line) => scrubLine(line, { home, username, secrets }),
      echo: deps.echo,
    })
  const manifest = readBundleManifest(home, fs)
  // The agents' Claude config dir (recorded at install) is the watcher's too:
  // every `claude plugin` call, the marketplace index read and every recipe
  // relaunch must see the same install the agents use, not ~/.claude.
  if (manifest?.claudeConfigDir) {
    const fromEnv = String(env.CLAUDE_CONFIG_DIR ?? '').trim()
    if (fromEnv && !sameDir(fromEnv, manifest.claudeConfigDir, platform)) {
      log(`CLAUDE_CONFIG_DIR in the service env (${fromEnv}) disagrees with the manifest (${manifest.claudeConfigDir}); the manifest wins, it is what the agents were installed with`)
    }
    env.CLAUDE_CONFIG_DIR = manifest.claudeConfigDir
  }
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
  const statePath = watcherStatePath(home)
  let state = {}
  const writeState = (patch) => {
    state = { ...state, ...patch }
    try {
      fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
    } catch {
      // state is advisory
    }
  }

  log(`watcher starting: bundle ${manifest?.version ?? 'unknown'} (${manifest?.fingerprint?.slice(0, 12) ?? 'no manifest'}) platform ${platform} pid ${process.pid}`)
  writeState({ startedAt: new Date(now()).toISOString(), pid: process.pid, bundleVersion: manifest?.version ?? null })
  if (typeof fetchImpl !== 'function') {
    log('fatal: no fetch available (node >= 18 required)')
    return 1
  }

  let credentials = readWatcherCredentials(home, fs)
  while (!credentials) {
    log('no watcher credentials yet (enroll writes ~/.bgos-agent/watcher/credentials.json); waiting')
    if (once) return EXIT_NO_CREDENTIALS
    await sleep(deps.credentialsRetryMs ?? CREDENTIALS_RETRY_MS)
    credentials = readWatcherCredentials(home, fs)
  }
  secrets.push(credentials.token)
  const modules = deps.modules ?? (await loadLifecycleModules())
  const client = buildRpcClient({ backendUrl: credentials.backendUrl, token: credentials.token, fetch: fetchImpl, log })

  let lastHeartbeatAt = 0
  const heartbeat = async () => {
    const agents = listAgents({ home, env, platform, fs, pidAlive: deps.pidAlive ?? defaultPidAlive }).map((a) => a.assistantId)
    const version = manifest?.version && VERSION_RE.test(manifest.version) ? manifest.version : '0.0.0'
    const res = await client.heartbeat({
      daemonVersion: version,
      env: { platform, machineId: credentials.machineId, role: 'watcher', agents },
    })
    lastHeartbeatAt = now()
    writeState({ lastHeartbeatAt: new Date(lastHeartbeatAt).toISOString(), lastHeartbeatOk: res.ok, lastHeartbeatStatus: res.status })
    if (!res.ok) log(`heartbeat failed (status ${res.status}${res.error ? `, ${res.error}` : ''})`)
    return res
  }
  const heartbeatIfDue = async () => {
    if (now() - lastHeartbeatAt >= heartbeatIntervalMs) await heartbeat()
  }

  const ctx = {
    client,
    log,
    now,
    sleep,
    fs,
    exec,
    spawnDetached,
    env,
    home,
    platform,
    modules,
    manifest,
    credentials,
    secrets,
    username,
    nodePath: deps.nodePath ?? process.execPath,
    uid: deps.uid === undefined ? (typeof process.getuid === 'function' ? process.getuid() : null) : deps.uid,
    pidAlive: deps.pidAlive ?? defaultPidAlive,
    hasTmux: deps.hasTmux,
    hasScript: deps.hasScript,
    hasCommand: deps.hasCommand,
    pluginRootOverride: deps.pluginRootOverride ?? null,
    jobDeadlineMs: deps.jobDeadlineMs ?? JOB_DEADLINE_MS,
    staggerMs: deps.staggerMs ?? STAGGER_MS,
    verifyTimeoutMs: deps.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS,
    heartbeatIfDue,
    writeState,
    busy: false,
  }

  let backoff = 0
  for (;;) {
    await heartbeatIfDue()
    const res = await client.pending(LONG_POLL_WAIT_S)
    writeState({ lastPollAt: new Date(now()).toISOString(), lastPollStatus: res.status })
    if (!res.ok) {
      backoff = nextBackoff(backoff)
      log(`poll failed (status ${res.status}${res.error ? `, ${res.error}` : ''}); retrying in ${backoff / 1000}s`)
      if (once) return 1
      await sleep(backoff)
      continue
    }
    backoff = 0
    const frames = Array.isArray(res.json?.frames) ? res.json.frames : []
    for (const frame of frames) {
      const exitCode = await handleFrame(ctx, frame)
      if (exitCode != null) {
        log(`exiting with ${exitCode} for the service manager to restart the refreshed bundle`)
        return exitCode
      }
    }
    if (once) return 0
  }
}
