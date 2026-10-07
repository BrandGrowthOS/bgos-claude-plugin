#!/usr/bin/env node
/**
 * hoai-watcher: the per-machine watcher for HOAI agents (zero-terminal
 * lifecycle, design 1.5). One process per machine, installed OUT of the
 * plugin folder at ~/.bgos-agent/watcher/ and kept alive by an OS service,
 * it long-polls the HOAI backend for machine jobs (update / reconcile /
 * restart / create agent), plans them with the pure planner, runs them
 * with the executor, restarts and VERIFIES every agent (the channel-live
 * marker, never "Connected"), and reports every step back to the app.
 *
 *   hoai-watcher run                       service entry: the daemon loop (never
 *                                          exits on network failure; exit 75 after
 *                                          a self-refresh so the service restarts)
 *   hoai-watcher install [--plugin-root D] [--node P]
 *                                          copy the bundle from a plugin root and
 *                                          install + start the OS service
 *   hoai-watcher uninstall [--purge]       stop + unregister the service (--purge
 *                                          also deletes ~/.bgos-agent/watcher)
 *   hoai-watcher status [--json]           manifest, service state, credentials
 *                                          present (never the token), last heartbeat
 *   hoai-watcher enroll --file <json>      write credentials from a JSON produced
 *                                          by the daemon's enroll step
 *   hoai-watcher reconcile [--dry-run] [--intent update|reconcile|restart_only|repair]
 *                                          plan (and without --dry-run, run) a
 *                                          reconcile for THIS machine locally,
 *                                          printing steps instead of posting them
 *   hoai-watcher help
 *
 * Exit codes: 0 ok; 1 failed (a named reason on stderr); 2 usage / bad
 * input; 75 restart requested after a bundle self-refresh (posix service
 * managers restart on it); 78 no credentials / no bundle (EX_CONFIG).
 *
 * CRASH-SAFE ENTRY (design 8, fact 5). This file's static imports are node
 * builtins ONLY, so it loads in any bundle that holds it, including one an
 * older installer copied with an older list (e2e E4: a 0.61.4 daemon's list
 * has no lib/watcher-health.mjs, and a static import of it killed the
 * process before any guard existed, a silent crash loop). Everything else is
 * a DYNAMIC import: the guard module (lib/watcher-health.mjs) inside this
 * file's own try, with runFallbackGuard below as the builtins-only stand in
 * when even it is missing; the watcher itself inside the guard (a missing
 * module is then crash.json, a minimal heartbeat and a slowed crash loop,
 * never a silent death every 5 s); and every module behind a named failure
 * for the other commands. `help` loads the WHOLE closure, lifecycle modules
 * included, because it is the staged-bundle probe (lib/watcher-core.mjs
 * refreshWatcherIfStale): a probe that loaded less than `run` would pass the
 * very bundle that then crash loops.
 *
 * SELF REPAIR (e2e E4). When a module INSIDE the bundle is not found before
 * the loop starts, the entry repairs the bundle from the plugin root its
 * manifest names (lib/watcher-bundle.mjs repairWatcherBundle: the root's
 * import closure, missing or changed files copied, manifest rewritten, at
 * most one attempt per 10 minutes, logged in watcher.log). `run` then exits
 * so the service manager starts the repaired bundle (75 on posix; a win32
 * successor through run-hidden.vbs); every other command runs itself again
 * once in a fresh node, so the old watcher's staged-bundle probe passes on a
 * repaired bundle instead of rejecting it for ever. No repair without a
 * manifest, with the plugin root gone, or when the root's closure does not
 * resolve: that stays a plain crash loop, reported as one.
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe (main() only
 * runs when executed directly, mirror of bin/hoai-core.mjs).
 */

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Mirrors of lib/watcher-core.mjs EXIT_SELF_REFRESH / EXIT_NO_CREDENTIALS / INTENTS,
 *  restated so parsing argv never needs a module that might not load (pinned by
 *  test/watcher-health.test.ts). */
export const EXIT = Object.freeze({
  OK: 0,
  FAILED: 1,
  USAGE: 2,
  SELF_REFRESH: 75,
  NO_CONFIG: 78,
})
export const WATCHER_INTENTS = Object.freeze(['update', 'reconcile', 'restart_only', 'repair'])

/**
 * Every module the CLI uses, loaded dynamically (see the header). The import
 * specifiers stay literal so test/watcher-bundle.test.ts's import-closure walk
 * still reaches every file the bundle must carry.
 */
export async function loadWatcherModules() {
  const [installMethod, inventory, bundle, core, service, health] = await Promise.all([
    import('./bgos-install-method.mjs'),
    import('../lib/agent-inventory.mjs'),
    import('../lib/watcher-bundle.mjs'),
    import('../lib/watcher-core.mjs'),
    import('../lib/watcher-service.mjs'),
    import('../lib/watcher-health.mjs'),
  ])
  const lifecycle = await core.loadLifecycleModules()
  return { installMethod, inventory, bundle, core, service, health, lifecycle }
}

/** The crash guard module, loaded inside the entry's own try (never statically). */
export function loadWatcherHealth() {
  return import('../lib/watcher-health.mjs')
}

export const USAGE = `hoai-watcher: the per-machine watcher for HOAI agents

Usage:
  hoai-watcher run                          run the daemon loop (the service entry)
  hoai-watcher install [--plugin-root <dir>] [--node <path>]
                                            copy the bundle out of a plugin root and
                                            install + start the OS service
  hoai-watcher uninstall [--purge]          stop + unregister the service
                                            (--purge also deletes ~/.bgos-agent/watcher)
  hoai-watcher status [--json]              manifest, service, credentials, last heartbeat
  hoai-watcher enroll --file <json>         write credentials from the daemon's enroll JSON
                                            ({pairingId, token, backendUrl, machineId})
  hoai-watcher reconcile [--dry-run] [--intent <update|reconcile|restart_only|repair>]
                                            plan (dry run: print the plan as JSON) or run a
                                            reconcile for this machine, locally
  hoai-watcher help

Exit codes:
  0   ok
  1   failed (the reason is on stderr)
  2   usage error or bad input
  75  restart requested after a bundle self-refresh (the service restarts it)
  78  no credentials or no installed bundle (run enroll / install first)
`

// -- Args ---------------------------------------------------------------------------

/**
 * @param {readonly string[]} argv
 * @returns {{ command: string, flags: { file: string, pluginRoot: string, node: string, intent: string,
 *   dryRun: boolean, json: boolean, purge: boolean, verbose: boolean, help: boolean }, errors: string[] }}
 */
export function parseWatcherArgs(argv) {
  const args = Array.isArray(argv) ? argv.map((v) => String(v ?? '')) : []
  const flags = { file: '', pluginRoot: '', node: '', intent: '', dryRun: false, json: false, purge: false, verbose: false, help: false }
  const errors = []
  let command = ''
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') flags.help = true
    else if (arg === '--dry-run') flags.dryRun = true
    else if (arg === '--json') flags.json = true
    else if (arg === '--purge') flags.purge = true
    else if (arg === '--verbose' || arg === '-v') flags.verbose = true
    else if (arg === '--file' || arg === '--plugin-root' || arg === '--node' || arg === '--intent') {
      const value = args[++i]
      if (value === undefined || value === '') errors.push(`${arg} needs a value`)
      else if (arg === '--file') flags.file = value
      else if (arg === '--plugin-root') flags.pluginRoot = value
      else if (arg === '--node') flags.node = value
      else flags.intent = value
    } else if (arg.startsWith('-')) errors.push(`unknown flag: ${arg}`)
    else if (!command) command = arg.toLowerCase()
    else errors.push(`unexpected extra argument: ${arg}`)
  }
  if (!command) command = flags.help ? 'help' : 'help'
  if (flags.intent && !WATCHER_INTENTS.includes(flags.intent)) errors.push(`--intent must be one of ${WATCHER_INTENTS.join(', ')}`)
  return { command, flags, errors }
}

/**
 * The plugin root an install copies from: the flag, else the checkout this
 * script lives in (when it has a package.json, i.e. we are running from the
 * plugin and not from the installed bundle), else the manifest's root.
 */
export function resolvePluginRoot({ flag = '', scriptPath = '', manifest = null, exists = existsSync, pluginRootFromScriptPath, joinDir } = {}) {
  const explicit = String(flag ?? '').trim()
  if (explicit) return explicit
  if (scriptPath && typeof pluginRootFromScriptPath === 'function') {
    const root = pluginRootFromScriptPath(scriptPath)
    if (root && exists(joinDir(root, 'package.json'))) return root
  }
  return manifest?.pluginRoot ?? ''
}

function defaultScriptPath() {
  const self = fileURLToPath(import.meta.url)
  try {
    return realpathSync(self)
  } catch {
    return self
  }
}

function defaultUsername(env) {
  try {
    return String(env.USER ?? env.USERNAME ?? userInfo().username ?? '').trim()
  } catch {
    return String(env.USER ?? env.USERNAME ?? '').trim()
  }
}

// -- Commands --------------------------------------------------------------------------

async function commandInstall({ m, flags, home, env, platform, fs, exec, scriptPath, out, err }) {
  const { installWatcherBundle, readBundleManifest, joinDir } = m.bundle
  const { installWatcherService, readWatcherCredentials, watcherServiceSpec } = m.service
  const manifest = readBundleManifest(home, fs)
  const pluginRoot = resolvePluginRoot({
    flag: flags.pluginRoot,
    scriptPath,
    manifest,
    exists: fs.exists,
    pluginRootFromScriptPath: m.installMethod.pluginRootFromScriptPath,
    joinDir,
  })
  if (!pluginRoot) {
    err('[hoai-watcher] no plugin root: pass --plugin-root <dir> (the checkout or the marketplace cache dir).')
    return EXIT.USAGE
  }
  let bundle
  try {
    bundle = await installWatcherBundle({ pluginRoot, home, fs, claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? null })
  } catch (error) {
    err(`[hoai-watcher] bundle install failed: ${error?.message ?? error}`)
    return EXIT.FAILED
  }
  out(`[hoai-watcher] bundle ${bundle.version} (${bundle.fingerprint.slice(0, 12)}) installed at ${bundle.bundleDir}`)
  let spec
  try {
    spec = watcherServiceSpec({
      platform,
      home,
      nodePath: flags.node || process.execPath,
      bundleDir: bundle.bundleDir,
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      localAppData: String(env.LOCALAPPDATA ?? '').trim() || undefined,
      username: defaultUsername(env),
    })
  } catch (error) {
    err(`[hoai-watcher] service spec failed: ${error?.message ?? error}`)
    return EXIT.FAILED
  }
  const result = await installWatcherService(spec, { exec, fs })
  for (const ran of result.ran) out(`[hoai-watcher]   ${ran.file} ${ran.args.join(' ')} -> rc ${ran.code}${ran.ignored && ran.code !== 0 ? ' (ignored)' : ''}`)
  if (!result.ok) {
    err(`[hoai-watcher] service install failed: ${result.message}`)
    return EXIT.FAILED
  }
  out(`[hoai-watcher] service ${spec.kind} "${spec.label}" installed and started`)
  if (!readWatcherCredentials(home, fs)) {
    out('[hoai-watcher] no credentials yet: the daemon enrolls this machine (or run: hoai-watcher enroll --file <json>)')
  }
  return EXIT.OK
}

async function commandUninstall({ m, flags, home, env, platform, fs, exec, out, err }) {
  const { watcherHome } = m.bundle
  const { uninstallWatcherService, watcherServiceSpec } = m.service
  let spec
  try {
    spec = watcherServiceSpec({
      platform,
      home,
      nodePath: process.execPath,
      bundleDir: watcherHome(home),
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      username: defaultUsername(env),
    })
  } catch (error) {
    err(`[hoai-watcher] service spec failed: ${error?.message ?? error}`)
    return EXIT.FAILED
  }
  const result = await uninstallWatcherService(spec, { exec, fs })
  for (const ran of result.ran) out(`[hoai-watcher]   ${ran.file} ${ran.args.join(' ')} -> rc ${ran.code}`)
  out(`[hoai-watcher] service ${spec.kind} "${spec.label}" removed (${result.removed.length} file(s))`)
  if (flags.purge) {
    try {
      fs.rm(watcherHome(home))
      out(`[hoai-watcher] purged ${watcherHome(home)}`)
    } catch (error) {
      err(`[hoai-watcher] purge failed: ${error?.message ?? error}`)
      return EXIT.FAILED
    }
  }
  return EXIT.OK
}

async function commandStatus({ m, flags, home, env, platform, fs, exec, out }) {
  const { readBundleManifest, watcherHome, watcherLogPath, watcherStatePath } = m.bundle
  const { readWatcherCredentials, watcherCredentialsPath, watcherServiceSpec, watcherServiceStatus } = m.service
  const { defaultPidAlive, listAgents } = m.inventory
  const { buildWatcherHealth, readBoots, readCrash } = m.health
  const manifest = readBundleManifest(home, fs)
  const credentials = readWatcherCredentials(home, fs)
  let stateJson = null
  try {
    stateJson = JSON.parse(fs.readFile(watcherStatePath(home)) ?? 'null')
  } catch {
    stateJson = null
  }
  let service = { active: false, output: '', ran: [] }
  try {
    const spec = watcherServiceSpec({
      platform,
      home,
      nodePath: process.execPath,
      bundleDir: watcherHome(home),
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      username: defaultUsername(env),
    })
    service = await watcherServiceStatus(spec, { exec })
    service.kind = spec.kind
    service.label = spec.label
  } catch (error) {
    service = { active: false, output: String(error?.message ?? error), ran: [] }
  }
  const agents = listAgents({ home, env, platform, fs, pidAlive: defaultPidAlive })
  const status = {
    bundleDir: watcherHome(home),
    manifest: manifest ? { version: manifest.version, fingerprint: manifest.fingerprint, installedAt: manifest.installedAt, pluginRoot: manifest.pluginRoot } : null,
    service: { kind: service.kind ?? null, label: service.label ?? null, active: service.active, output: service.output },
    credentials: credentials
      ? { present: true, pairingId: credentials.pairingId, backendUrl: credentials.backendUrl, machineId: credentials.machineId }
      : { present: false, path: watcherCredentialsPath(home) },
    lastHeartbeatAt: stateJson?.lastHeartbeatAt ?? null,
    lastHeartbeatOk: stateJson?.lastHeartbeatOk ?? null,
    lastJob: stateJson?.lastJob ?? null,
    health: buildWatcherHealth({ boots: readBoots(home, fs), crash: readCrash(home, fs), now: Date.now() }),
    agents: agents.map((a) => ({ assistantId: a.assistantId, supervisor: a.supervisor, recipe: Boolean(a.recipe), cwd: a.cwd })),
    logPath: watcherLogPath(home),
  }
  if (flags.json) {
    out(JSON.stringify(status, null, 2))
    return manifest && credentials ? EXIT.OK : EXIT.NO_CONFIG
  }
  out(`[hoai-watcher] bundle     : ${manifest ? `${manifest.version} (${manifest.fingerprint.slice(0, 12)}) installed ${manifest.installedAt ?? '?'} from ${manifest.pluginRoot ?? '?'}` : 'not installed'}`)
  out(`[hoai-watcher] service    : ${status.service.kind ?? '-'} ${status.service.label ?? ''} ${status.service.active ? 'active' : 'inactive'}${status.service.output ? ` (${status.service.output.split(/\r?\n/)[0]})` : ''}`)
  out(`[hoai-watcher] credentials: ${credentials ? `present (pairing ${credentials.pairingId}, machine ${credentials.machineId}, ${credentials.backendUrl})` : `absent (${watcherCredentialsPath(home)})`}`)
  out(`[hoai-watcher] heartbeat  : ${status.lastHeartbeatAt ?? 'never'}${status.lastHeartbeatOk === false ? ' (last one FAILED)' : ''}`)
  out(`[hoai-watcher] last job   : ${status.lastJob ? `${status.lastJob.op} ${status.lastJob.state} at ${status.lastJob.at}` : 'none'}`)
  out(`[hoai-watcher] health     : ${status.health.status}, ${status.health.bootsLastHour} start(s) in the last hour${status.health.lastFatal ? `, last fatal ${status.health.lastFatal.at}: ${status.health.lastFatal.message}` : ''}`)
  out(`[hoai-watcher] agents     : ${agents.length ? agents.map((a) => `${a.assistantId}:${a.supervisor}${a.recipe ? '+recipe' : ''}`).join(', ') : 'none'}`)
  out(`[hoai-watcher] log        : ${status.logPath}`)
  return manifest && credentials ? EXIT.OK : EXIT.NO_CONFIG
}

async function commandEnroll({ m, flags, home, env, platform, fs, exec, out, err }) {
  const { applyWin32CredentialsAcl, writeWatcherCredentials } = m.service
  if (!flags.file) {
    err('[hoai-watcher] enroll needs --file <json> ({pairingId, token, backendUrl, machineId}).')
    return EXIT.USAGE
  }
  const raw = fs.readFile(flags.file)
  if (raw == null) {
    err(`[hoai-watcher] cannot read ${flags.file}`)
    return EXIT.USAGE
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    err(`[hoai-watcher] ${flags.file} is not JSON: ${error?.message ?? error}`)
    return EXIT.USAGE
  }
  let path
  try {
    path = writeWatcherCredentials(home, parsed ?? {}, fs)
  } catch (error) {
    err(`[hoai-watcher] ${error?.message ?? error}`)
    return EXIT.USAGE
  }
  let protection = 'chmod 600'
  if (platform === 'win32') {
    const acl = await applyWin32CredentialsAcl(path, { username: defaultUsername(env), exec })
    protection = acl.message
  }
  out(`[hoai-watcher] credentials written to ${path} (${protection})`)
  return EXIT.OK
}

async function commandReconcile({ m, flags, home, env, platform, fs, exec, spawnDetached, out, err }) {
  const { readBundleManifest, watcherLogPath } = m.bundle
  const { JOB_DEADLINE_MS, STAGGER_MS, StepLedger, VERIFY_TIMEOUT_MS, createLogger, observeMachine, runReconcileJob, scrubLine } = m.core
  const { readWatcherCredentials } = m.service
  const { defaultPidAlive } = m.inventory
  const manifest = readBundleManifest(home, fs)
  const pluginRootOverride = String(flags.pluginRoot ?? '').trim() || null
  if (!manifest && !pluginRootOverride) {
    err('[hoai-watcher] no installed bundle and no --plugin-root; run install first.')
    return EXIT.NO_CONFIG
  }
  const modules = m.lifecycle
  const intent = flags.intent || 'reconcile'
  const username = defaultUsername(env)
  // The real pairing token is in the scrubber's denylist BEFORE the first
  // line is written, exactly as the service loop does it.
  const credentials = readWatcherCredentials(home, fs)
  const secrets = credentials?.token ? [credentials.token] : []
  const log = createLogger({
    path: watcherLogPath(home),
    fs,
    scrub: (line) => scrubLine(line, { home, username, secrets }),
    echo: flags.verbose ? (line) => err(line) : undefined,
  })
  if (flags.dryRun) {
    const observed = await observeMachine({ home, env, platform, fs, exec, modules, manifest, intent, pluginRootOverride, log })
    const plan = modules.planMachine(observed.state)
    out(JSON.stringify({ state: observed.state, pluginRoot: observed.pluginRoot, configDir: observed.configDir, plan }, null, 2))
    return EXIT.OK
  }
  const client = {
    progress: async (_rpcId, body) => {
      const steps = new StepLedger(body.steps ?? [])
      out(`[hoai-watcher] ${body.state}${body.message ? `: ${body.message}` : ''}`)
      for (const step of steps.view()) out(`[hoai-watcher]   ${step.state.padEnd(11)} ${step.id}${step.message ? `  ${step.message}` : ''}`)
      return { ok: true, status: 200, json: null, text: '', error: null }
    },
    post: async () => ({ ok: true, status: 200, json: null, text: '', error: null }),
  }
  const ctx = {
    client,
    log,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    fs,
    exec,
    spawnDetached,
    env,
    home,
    platform,
    modules,
    manifest,
    credentials: credentials ?? { backendUrl: '', token: '', pairingId: 0, machineId: '' },
    secrets,
    // A manual reconcile must never swap the service bundle or spawn a
    // successor: two watchers would long-poll side by side.
    noSelfRefresh: true,
    username,
    nodePath: process.execPath,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    pidAlive: defaultPidAlive,
    pluginRootOverride,
    jobDeadlineMs: JOB_DEADLINE_MS,
    staggerMs: STAGGER_MS,
    verifyTimeoutMs: VERIFY_TIMEOUT_MS,
    heartbeatIfDue: async () => {},
    writeState: () => {},
    busy: false,
  }
  const outcome = await runReconcileJob(ctx, 'local', { op: 'reconcile', intent, targets: [] })
  if (outcome.exitCode != null) return outcome.exitCode
  return outcome.state === 'done' ? EXIT.OK : EXIT.FAILED
}

// -- Self repair (e2e E4) and the builtins-only fallback guard ----------------------------

/** Set in the one re-run after a repair (an operator may set it too), so a repair never recurses. */
export const NO_REPAIR_ENV = 'HOAI_WATCHER_NO_REPAIR'
/** Mirror of lib/watcher-service.mjs WATCHER_HIDDEN_LAUNCHER_FILE (pinned by test). */
export const HIDDEN_LAUNCHER_FILE = 'run-hidden.vbs'
/** `help` is the staged-bundle probe; its re-run after a repair is bounded like the probe. */
const RERUN_HELP_TIMEOUT_MS = 30_000

function firstLineOf(text) {
  return (
    String(text ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  )
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Mirror of lib/watcher-health.mjs scrubFatal (pinned by test), restated
 * because it must work when that module does not load: explicit secrets,
 * header and bearer values, key=value secrets, the home path (-> ~) and the
 * username (-> <user>).
 * @param {unknown} message
 * @param {{ home?: string, username?: string, secrets?: string[] }} [opts]
 * @returns {string}
 */
export function scrubText(message, { home = '', username = '', secrets = [] } = {}) {
  let out = String(message ?? '')
  for (const secret of secrets) {
    const value = String(secret ?? '')
    if (value.length >= 6) out = out.split(value).join('<redacted>')
  }
  out = out.replace(/(X-BGOS-Pairing\s*[:=]\s*)\S+/gi, '$1<redacted>')
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, 'Bearer <redacted>')
  out = out.replace(/\bsk-[A-Za-z0-9_-]{20,}/g, '<redacted>')
  out = out.replace(/((?:api[_-]?key|secret|token|password|pairingToken)["']?\s*[:=]\s*["']?)([^\s"',}]{8,})/gi, '$1<redacted>')
  const homeValue = String(home ?? '').replace(/[\\/]+$/, '')
  if (homeValue) {
    const alt = homeValue.includes('\\') ? homeValue.split('\\').join('/') : homeValue.split('/').join('\\')
    for (const spelling of [homeValue, alt]) out = out.replace(new RegExp(escapeRegExp(spelling), /^[A-Za-z]:/.test(spelling) ? 'gi' : 'g'), '~')
  }
  const user = String(username ?? '').trim()
  if (user.length >= 2) out = out.replace(new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(user)}(?![A-Za-z0-9])`, 'gi'), '$1<user>')
  return out
}

/** Append a scrubbed, timestamped line to <bundleDir>/logs/watcher.log; never throws. */
function bundleLogger({ bundleDir, home, username, now }) {
  const path = join(bundleDir, 'logs', 'watcher.log')
  return (line) => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${new Date(now()).toISOString()} ${scrubText(line, { home, username })}\n`)
    } catch {
      // stderr still carries what matters
    }
  }
}

function realpathOr(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * The module a failed load could not find, as a bundle relative path, when it
 * lies INSIDE the bundle dir (only those are a bundle to repair); else null.
 * @param {unknown} error
 * @param {string} bundleDir
 * @returns {string | null}
 */
export function missingBundleModule(error, bundleDir) {
  const e = /** @type {{ code?: unknown, url?: unknown, message?: unknown } | null | undefined} */ (error)
  const message = String(e?.message ?? error ?? '')
  if (e?.code !== 'ERR_MODULE_NOT_FOUND' && !/Cannot find module/.test(message)) return null
  let path = ''
  try {
    if (typeof e?.url === 'string' && e.url.startsWith('file:')) path = fileURLToPath(e.url)
    if (!path) {
      const quoted = /Cannot find module '([^']+)'/.exec(message)?.[1] ?? ''
      path = quoted.startsWith('file:') ? fileURLToPath(quoted) : quoted
    }
  } catch {
    path = ''
  }
  if (!path || !isAbsolute(path) || !bundleDir) return null
  for (const dir of new Set([bundleDir, realpathOr(bundleDir)])) {
    const rel = relative(dir, path)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split('\\').join('/')
  }
  return null
}

/**
 * The shared closure walk and repair live in lib/watcher-bundle.mjs, builtins
 * only and in every bundle list since 0.38: the bundle's own copy first, the
 * plugin root's copy when the bundle's does not load or predates the repair.
 * @param {string | null} pluginRoot
 */
async function loadRepairModule(pluginRoot) {
  /** @type {Array<() => Promise<any>>} */
  const candidates = [() => import('../lib/watcher-bundle.mjs')]
  if (pluginRoot) candidates.push(() => import(pathToFileURL(join(pluginRoot, 'lib', 'watcher-bundle.mjs')).href))
  for (const load of candidates) {
    try {
      const mod = await load()
      if (typeof mod?.repairWatcherBundle === 'function') return mod
    } catch {
      // the next candidate
    }
  }
  return null
}

function describeRepair(result, missing) {
  const root = result.pluginRoot ?? 'the plugin root'
  if (result.repaired) {
    return `bundle repaired: ${missing} was missing; copied ${result.copied.length} file(s) from ${root} (${result.copied.join(', ')})`
  }
  const reason = String(result.reason ?? '')
  switch (reason) {
    case 'plugin_root_missing':
      return `bundle repair skipped: the plugin root ${root} is missing`
    case 'rate_limited':
      return `bundle repair skipped: one attempt per 10 min (the last at ${result.lastAttemptAt ?? '?'})`
    case 'no_manifest':
      return 'bundle repair skipped: the bundle has no manifest.json'
    case 'no_plugin_root':
      return 'bundle repair skipped: the manifest names no plugin root'
    case 'plugin_root_is_the_bundle':
      return 'bundle repair skipped: this is the plugin root itself, not an installed bundle'
    case 'nothing_to_repair':
      return `bundle repair found nothing to copy: ${missing} is not in the import closure of ${root}`
    default:
      if (reason.startsWith('closure_walk_failed: ')) {
        return `bundle repair skipped: the plugin root's own imports do not resolve (${reason.slice('closure_walk_failed: '.length)})`
      }
      return `bundle repair failed: ${reason}`
  }
}

/**
 * Repair the bundle when `error` is a module missing INSIDE it (e2e E4). A
 * repair logs itself in <bundleDir>/logs/watcher.log; an outcome that is not
 * a repair only comes back as a message for the caller to report (the guard
 * puts it on the fatal line), so nothing is ever written into a directory
 * without a manifest, such as a plugin checkout running its own entry.
 * @param {unknown} error
 * @param {{ bundleDir: string, home: string, env?: Record<string, string | undefined>, username?: string,
 *   now?: () => number, loadRepair?: (pluginRoot: string | null) => Promise<any>, log?: (line: string) => void }} ctx
 * @returns {Promise<{ repaired: boolean, message: string } | null>} null when the failure is not a bundle to repair
 */
export async function attemptBundleRepair(error, { bundleDir, home, env = {}, username = '', now = Date.now, loadRepair = loadRepairModule, log }) {
  if (String(env?.[NO_REPAIR_ENV] ?? '').trim() === '1') return null
  const missing = missingBundleModule(error, bundleDir)
  if (!missing) return null
  const writeLog = log ?? bundleLogger({ bundleDir, home, username, now })
  const scrub = (text) => scrubText(text, { home, username })
  const manifest = readJsonFile(join(bundleDir, 'manifest.json'))
  if (!manifest || typeof manifest !== 'object') {
    return { repaired: false, message: describeRepair({ repaired: false, reason: 'no_manifest', pluginRoot: null, copied: [] }, missing) }
  }
  const pluginRoot = String(manifest.pluginRoot ?? '').trim() || null
  const mod = await loadRepair(pluginRoot)
  /** @type {{ repaired: boolean, reason: string, pluginRoot: string | null, copied: string[], lastAttemptAt?: string }} */
  let result
  if (!mod) {
    result = { repaired: false, reason: `the repair module did not load (from the bundle or from ${pluginRoot ?? 'an unknown plugin root'})`, pluginRoot, copied: [] }
  } else {
    try {
      result = await mod.repairWatcherBundle({ bundleDir, now, log: writeLog })
    } catch (err) {
      result = { repaired: false, reason: `repair threw: ${firstLineOf(/** @type {any} */ (err)?.message ?? err)}`, pluginRoot, copied: [] }
    }
    if (!result || typeof result !== 'object') result = { repaired: false, reason: 'repair answered nothing', pluginRoot, copied: [] }
    if (!Array.isArray(result.copied)) result = { ...result, copied: [] }
  }
  return { repaired: Boolean(result.repaired), message: scrub(describeRepair(result, missing)) }
}

/** A fire-and-forget child (mirror of lib/watcher-bundle.mjs nodeSpawnDetached). */
function builtinSpawnDetached(file, args, opts = {}) {
  const child = spawn(file, [...args], { cwd: opts.cwd, env: process.env, detached: true, stdio: 'ignore', windowsHide: opts.windowsHide ?? false })
  child.on('error', () => {})
  child.unref()
  return { pid: child.pid ?? null }
}

/**
 * How `run` leaves after a repair so the repaired bundle starts: posix exits
 * 75 (launchd KeepAlive / systemd Restart=always restart it); a win32
 * Scheduled Task does not restart on exit, so a successor starts through the
 * hidden launcher and this one exits 0 (mirror of watcher-core
 * selfRestartExitCode).
 * @param {{ platform: string, bundleDir: string, spawnDetached?: Function, exists?: (path: string) => boolean }} input
 * @returns {number}
 */
export function restartAfterRepair({ platform, bundleDir, spawnDetached = builtinSpawnDetached, exists = existsSync }) {
  if (platform !== 'win32') return EXIT.SELF_REFRESH
  const vbs = join(bundleDir, HIDDEN_LAUNCHER_FILE)
  if (!exists(vbs)) return EXIT.SELF_REFRESH
  try {
    spawnDetached('wscript.exe', ['//B', vbs], { cwd: bundleDir, windowsHide: true })
    return EXIT.OK
  } catch {
    return EXIT.SELF_REFRESH
  }
}

/** Every command but `run`, once more in a fresh node after a repair (a module that failed
 *  to load stays failed in this process). */
function rerunCommand({ argv, scriptPath, env, command }) {
  const result = spawnSync(process.execPath, [scriptPath, ...argv], {
    stdio: 'inherit',
    env: { ...env, [NO_REPAIR_ENV]: '1' },
    windowsHide: true,
    ...(command === 'help' ? { timeout: RERUN_HELP_TIMEOUT_MS } : {}),
  })
  return typeof result.status === 'number' ? result.status : EXIT.FAILED
}

/** Mirrors of lib/watcher-health.mjs (pinned by test), so the fallback guard needs builtins only. */
export const FALLBACK_GUARD = Object.freeze({
  BOOTS_RING_SIZE: 20,
  CRASH_LOOP_WINDOW_MS: 10 * 60_000,
  CRASH_LOOP_MIN_BOOTS: 3,
  CRASH_BACKOFF_MIN_MS: 30_000,
  CRASH_BACKOFF_MAX_MS: 10 * 60_000,
  HEALTH_STRING_MAX: 120,
  CRASH_MESSAGE_MAX: 500,
  FATAL_HEARTBEAT_TIMEOUT_MS: 10_000,
  EXIT_FATAL: 1,
})

const GUARD_VERSION_RE = /^\d+\.\d+\.\d+[-\w.]*$/

/** Separator preserving join (mirror of lib/watcher-bundle.mjs joinDir). */
function joinKeep(dir, name) {
  const base = String(dir ?? '').replace(/[\\/]+$/, '')
  if (!base) return String(name ?? '')
  const sep = base.includes('\\') || /^[A-Za-z]:$/.test(base) ? '\\' : '/'
  return `${base}${sep}${name}`
}

function clipTo(value, max) {
  const text = String(value ?? '')
  return text.length > max ? text.slice(0, max) : text
}

function msOf(value) {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function writeTextFile(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/**
 * The crash guard when lib/watcher-health.mjs ITSELF does not load (a bundle an
 * older installer copied without it, e2e E4): the same boots.json ring,
 * crash.json, minimal heartbeat on the wire (credentials.json, pairing auth,
 * env.watcherHealth) and crash loop wait as runGuarded, from node builtins
 * only, so the failure is visible either way (fact 5). A repair, when one is
 * possible, comes first.
 * @param {{ error: unknown, home: string, env?: Record<string, string | undefined>, platform: string, username?: string,
 *   err?: (line: string) => void, fetch?: typeof fetch, now?: () => number, sleep?: (ms: number) => Promise<unknown>,
 *   pid?: number, repair?: ((error: unknown) => Promise<{ repaired: boolean, message: string, exitCode?: number } | null>) | null }} params
 * @returns {Promise<number>}
 */
export async function runFallbackGuard({
  error,
  home,
  env = {},
  platform,
  username = '',
  err = () => {},
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pid = process.pid,
  repair = null,
}) {
  const G = FALLBACK_GUARD
  const dir = joinKeep(joinKeep(home, '.bgos-agent'), 'watcher')
  const bootsFile = joinKeep(dir, 'boots.json')
  const logFile = joinKeep(joinKeep(dir, 'logs'), 'watcher.log')
  const appendLog = (at, line) => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `${at} ${line}\n`)
    } catch {
      // stderr still carries it (the service log)
    }
  }
  const readRing = () => {
    const raw = readJsonFile(bootsFile)
    return (Array.isArray(raw) ? raw : [])
      .filter((b) => msOf(b?.startedAt) !== null)
      .map((b) => ({
        startedAt: b.startedAt,
        pid: Number.isInteger(b.pid) ? b.pid : null,
        version: typeof b.version === 'string' ? b.version : null,
        ...(Number.isFinite(b.backoffMs) && b.backoffMs > 0 ? { backoffMs: b.backoffMs } : {}),
      }))
  }
  const writeRing = (ring) => writeTextFile(bootsFile, `${JSON.stringify(ring.slice(-G.BOOTS_RING_SIZE), null, 2)}\n`)

  const startedAt = new Date(now()).toISOString()
  const rawVersion = String(readJsonFile(joinKeep(dir, 'manifest.json'))?.version ?? '').trim()
  const version = GUARD_VERSION_RE.test(rawVersion) ? rawVersion : null
  /** @type {Array<{ startedAt: string, pid: number | null, version: string | null, backoffMs?: number }>} */
  const boots = [...readRing(), { startedAt, pid, version }].slice(-G.BOOTS_RING_SIZE)
  try {
    writeRing(boots)
  } catch {
    // a read-only watcher home must not stop the report below
  }

  const rawCreds = readJsonFile(joinKeep(dir, 'credentials.json'))
  const token = typeof rawCreds?.token === 'string' ? rawCreds.token.trim() : ''
  const backendUrl = typeof rawCreds?.backendUrl === 'string' ? rawCreds.backendUrl.trim() : ''
  const machineId = typeof rawCreds?.machineId === 'string' ? rawCreds.machineId.trim() : ''
  const creds = token && backendUrl && machineId ? { token, backendUrl, machineId } : null

  const at = new Date(now()).toISOString()
  const e = /** @type {any} */ (error)
  const message = clipTo(
    scrubText(firstLineOf(e?.message ?? e) || 'unknown error', {
      home,
      username: username || String(env?.USER ?? env?.USERNAME ?? '').trim(),
      secrets: creds ? [creds.token] : [],
    }),
    G.CRASH_MESSAGE_MAX,
  )
  try {
    writeTextFile(joinKeep(dir, 'crash.json'), `${JSON.stringify({ at, message }, null, 2)}\n`)
  } catch {
    // still reported below
  }
  let repaired = null
  if (typeof repair === 'function') {
    try {
      repaired = await repair(error)
    } catch {
      repaired = null
    }
  }
  const prefix = `fatal before the loop (the crash guard module did not load either): ${message}`
  if (repaired?.repaired) {
    const line = `${prefix}; ${repaired.message}`
    appendLog(at, line)
    err(`[hoai-watcher] ${line}`)
    return typeof repaired.exitCode === 'number' ? repaired.exitCode : G.EXIT_FATAL
  }

  // The crash loop rule of watcher-health crashLoopVerdict.
  const nowMs = now()
  const lastPollOkAtMs = msOf(readJsonFile(joinKeep(dir, 'state.json'))?.lastPollOkAt)
  const floor = typeof lastPollOkAtMs === 'number' ? lastPollOkAtMs : -Infinity
  const failing = boots.filter((b) => (msOf(b.startedAt) ?? 0) > floor)
  const inWindow = failing.filter((b) => nowMs - (msOf(b.startedAt) ?? 0) <= G.CRASH_LOOP_WINDOW_MS)
  const waited = failing.filter((b) => (b.backoffMs ?? 0) > 0).length
  const crashLoop = inWindow.length >= G.CRASH_LOOP_MIN_BOOTS || waited > 0
  const backoffMs = crashLoop ? Math.min(G.CRASH_BACKOFF_MIN_MS * 2 ** waited, G.CRASH_BACKOFF_MAX_MS) : 0
  const line = `${prefix}${repaired?.message ? `; ${repaired.message}` : ''}${crashLoop ? `; crash loop (${failing.length} starts with no successful poll), waiting ${backoffMs / 1000}s before exiting` : ''}`
  appendLog(at, line)
  err(`[hoai-watcher] ${line}`)

  // The minimal heartbeat, the wire shape of watcher-health postFatalHeartbeat.
  const bootsLastHour = boots.filter((b) => {
    const age = nowMs - (msOf(b.startedAt) ?? 0)
    return age >= 0 && age < 60 * 60_000
  }).length
  const health = {
    status: crashLoop ? 'crash_loop' : 'degraded',
    bootsLastHour,
    lastFatal: { at: clipTo(at, G.HEALTH_STRING_MAX), message: clipTo(message, G.HEALTH_STRING_MAX) },
  }
  if (!creds) {
    appendLog(at, 'crash heartbeat: not sent (no credentials.json)')
  } else if (typeof fetchImpl !== 'function') {
    appendLog(at, 'crash heartbeat: not sent (this node has no fetch)')
  } else {
    let agents = []
    try {
      agents = readdirSync(joinKeep(home, '.bgos-agent'))
        .map((name) => /^credentials-(\d+)\.json$/.exec(String(name))?.[1])
        .filter((id) => Boolean(id))
        .sort((a, b) => Number(a) - Number(b))
    } catch {
      agents = []
    }
    let base = creds.backendUrl.replace(/\/+$/, '')
    if (!/\/api\/v1$/.test(base)) base = `${base}/api/v1`
    const url = `${base}/integrations/heartbeat`
    const body = { daemonVersion: version ?? '0.0.0', env: { platform, machineId: creds.machineId, role: 'watcher', agents, watcherHealth: health } }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), G.FATAL_HEARTBEAT_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'X-BGOS-Pairing': creds.token, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      appendLog(at, `crash heartbeat to ${url}: ${res?.ok ? 'delivered' : 'not delivered'} (HTTP ${Number(res?.status ?? 0)})`)
    } catch (sendError) {
      const cause = /** @type {any} */ (sendError)
      const code = cause?.cause?.code ? ` (${cause.cause.code})` : ''
      appendLog(at, `crash heartbeat to ${url}: not delivered: ${firstLineOf(cause?.message ?? cause)}${code}`)
    } finally {
      clearTimeout(timer)
    }
  }

  if (crashLoop) {
    try {
      const ring = readRing()
      const mine = [...ring].reverse().find((b) => b.pid === pid && b.startedAt === startedAt)
      if (mine) {
        mine.backoffMs = backoffMs
        writeRing(ring)
      }
    } catch {
      // the wait still happens
    }
    await sleep(backoffMs)
  }
  return G.EXIT_FATAL
}

// -- main ---------------------------------------------------------------------------------

/**
 * @param {string[]} [argv]
 * @param {{ home?: string, env?: Record<string, string | undefined>, platform?: string,
 *   fs?: object, exec?: Function, spawnDetached?: Function, scriptPath?: string, bundleDir?: string,
 *   out?: (line: string) => void, err?: (line: string) => void, runWatcherImpl?: Function,
 *   loadModules?: () => Promise<any>, loadHealth?: () => Promise<any>,
 *   loadRepairModule?: (pluginRoot: string | null) => Promise<any>,
 *   rerun?: (input: { argv: string[], scriptPath: string, env: Record<string, string | undefined>, command: string }) => number,
 *   fetch?: typeof fetch, now?: () => number, sleep?: (ms: number) => Promise<unknown>, pid?: number }} [opts]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), opts = {}) {
  const home = opts.home ?? homedir()
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const scriptPath = opts.scriptPath ?? defaultScriptPath()
  // <bundleDir>/bin/hoai-watcher.mjs: the bundle this entry runs from (a checkout, when run from one).
  const bundleDir = opts.bundleDir ?? dirname(dirname(scriptPath))
  const out = opts.out ?? ((line) => process.stdout.write(`${line}\n`))
  const err = opts.err ?? ((line) => process.stderr.write(`${line}\n`))
  const now = opts.now ?? Date.now
  const username = defaultUsername(env)
  const loadModules = opts.loadModules ?? loadWatcherModules
  const { command, flags, errors } = parseWatcherArgs(argv)
  const usage = () => out(USAGE.replace(/\n$/, ''))
  const repairContext = { bundleDir, home, env, username, now, ...(opts.loadRepairModule ? { loadRepair: opts.loadRepairModule } : {}) }
  if (command === 'run' && !flags.help && errors.length === 0) {
    // The service entry: nothing outside node's builtins is loaded before a
    // guard holds the failure path, and the guard module itself is loaded
    // inside this try (its builtins-only stand in takes over when it is missing).
    const repair = async (error) => {
      const outcome = await attemptBundleRepair(error, repairContext)
      if (!outcome?.repaired) return outcome
      const exitCode = restartAfterRepair({ platform, bundleDir, ...(opts.spawnDetached ? { spawnDetached: opts.spawnDetached } : {}) })
      return { repaired: true, message: `${outcome.message}; exiting ${exitCode} so the service starts the repaired bundle`, exitCode }
    }
    const guard = {
      home,
      env,
      platform,
      username,
      err,
      repair,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      ...(opts.pid ? { pid: opts.pid } : {}),
    }
    let health
    try {
      health = await (opts.loadHealth ?? loadWatcherHealth)()
    } catch (error) {
      return runFallbackGuard({ ...guard, error })
    }
    return health.runGuarded({
      ...guard,
      load: loadModules,
      run: (m) => {
        const runImpl = opts.runWatcherImpl ?? m.core.runWatcher
        return runImpl({
          home,
          env,
          platform,
          fs: opts.fs ?? m.bundle.nodeFs(),
          exec: opts.exec ?? m.bundle.nodeExec(),
          spawnDetached: opts.spawnDetached ?? m.bundle.nodeSpawnDetached(),
          nodePath: process.execPath,
          echo: flags.verbose ? (line) => err(line) : undefined,
          modules: m.lifecycle,
        })
      },
    })
  }
  let m
  try {
    m = await loadModules()
  } catch (error) {
    const repair = await attemptBundleRepair(error, repairContext)
    if (repair?.repaired) {
      err(`[hoai-watcher] ${repair.message}; running the command again`)
      return (opts.rerun ?? rerunCommand)({ argv: [...argv], scriptPath, env, command })
    }
    err(`[hoai-watcher] the watcher bundle does not load: ${/** @type {any} */ (error)?.message ?? error}`)
    if (repair?.message) err(`[hoai-watcher] ${repair.message}`)
    return EXIT.FAILED
  }
  if (flags.help || command === 'help') {
    if (errors.length) for (const e of errors) err(`[hoai-watcher] ${e}`)
    usage()
    return errors.length ? EXIT.USAGE : EXIT.OK
  }
  if (errors.length) {
    for (const e of errors) err(`[hoai-watcher] ${e}`)
    usage()
    return EXIT.USAGE
  }
  const fs = opts.fs ?? m.bundle.nodeFs()
  const exec = opts.exec ?? m.bundle.nodeExec()
  const spawnDetached = opts.spawnDetached ?? m.bundle.nodeSpawnDetached()
  const common = { m, flags, home, env, platform, fs, exec, spawnDetached, scriptPath, out, err }
  switch (command) {
    case 'install':
      return commandInstall(common)
    case 'uninstall':
      return commandUninstall(common)
    case 'status':
      return commandStatus(common)
    case 'enroll':
      return commandEnroll(common)
    case 'reconcile':
      return commandReconcile(common)
    default:
      err(`[hoai-watcher] unknown command: ${command}`)
      usage()
      return EXIT.USAGE
  }
}

/** True when this file is the process entry point (real paths on both sides). */
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
    .catch((error) => {
      process.stderr.write(`[hoai-watcher] fatal: ${error?.message ?? error}\n`)
      process.exitCode = EXIT.FAILED
    })
}
