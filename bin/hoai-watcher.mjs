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
 * Plain JavaScript, node >= 18 builtins only, import-safe (main() only
 * runs when executed directly, mirror of bin/hoai-core.mjs).
 */

import { existsSync, realpathSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { pluginRootFromScriptPath } from './bgos-install-method.mjs'
import { defaultPidAlive, listAgents } from '../lib/agent-inventory.mjs'
import {
  installWatcherBundle,
  joinDir,
  nodeExec,
  nodeFs,
  nodeSpawnDetached,
  readBundleManifest,
  watcherHome,
  watcherLogPath,
  watcherStatePath,
} from '../lib/watcher-bundle.mjs'
import {
  EXIT_NO_CREDENTIALS,
  EXIT_SELF_REFRESH,
  INTENTS,
  JOB_DEADLINE_MS,
  STAGGER_MS,
  StepLedger,
  VERIFY_TIMEOUT_MS,
  createLogger,
  loadLifecycleModules,
  observeMachine,
  runReconcileJob,
  runWatcher,
  scrubLine,
} from '../lib/watcher-core.mjs'
import {
  applyWin32CredentialsAcl,
  installWatcherService,
  readWatcherCredentials,
  uninstallWatcherService,
  watcherCredentialsPath,
  watcherServiceSpec,
  watcherServiceStatus,
  writeWatcherCredentials,
} from '../lib/watcher-service.mjs'

export const EXIT = Object.freeze({
  OK: 0,
  FAILED: 1,
  USAGE: 2,
  SELF_REFRESH: EXIT_SELF_REFRESH,
  NO_CONFIG: EXIT_NO_CREDENTIALS,
})

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
  if (flags.intent && !INTENTS.includes(flags.intent)) errors.push(`--intent must be one of ${INTENTS.join(', ')}`)
  return { command, flags, errors }
}

/**
 * The plugin root an install copies from: the flag, else the checkout this
 * script lives in (when it has a package.json, i.e. we are running from the
 * plugin and not from the installed bundle), else the manifest's root.
 */
export function resolvePluginRoot({ flag = '', scriptPath = '', manifest = null, exists = existsSync } = {}) {
  const explicit = String(flag ?? '').trim()
  if (explicit) return explicit
  if (scriptPath) {
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

async function commandInstall({ flags, home, env, platform, fs, exec, scriptPath, out, err }) {
  const manifest = readBundleManifest(home, fs)
  const pluginRoot = resolvePluginRoot({ flag: flags.pluginRoot, scriptPath, manifest, exists: fs.exists })
  if (!pluginRoot) {
    err('[hoai-watcher] no plugin root: pass --plugin-root <dir> (the checkout or the marketplace cache dir).')
    return EXIT.USAGE
  }
  let bundle
  try {
    bundle = await installWatcherBundle({ pluginRoot, home, fs })
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

async function commandUninstall({ flags, home, env, platform, fs, exec, out, err }) {
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

async function commandStatus({ flags, home, env, platform, fs, exec, out }) {
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
  out(`[hoai-watcher] agents     : ${agents.length ? agents.map((a) => `${a.assistantId}:${a.supervisor}${a.recipe ? '+recipe' : ''}`).join(', ') : 'none'}`)
  out(`[hoai-watcher] log        : ${status.logPath}`)
  return manifest && credentials ? EXIT.OK : EXIT.NO_CONFIG
}

async function commandEnroll({ flags, home, env, platform, fs, exec, out, err }) {
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

async function commandReconcile({ flags, home, env, platform, fs, exec, spawnDetached, out, err }) {
  const manifest = readBundleManifest(home, fs)
  const pluginRootOverride = String(flags.pluginRoot ?? '').trim() || null
  if (!manifest && !pluginRootOverride) {
    err('[hoai-watcher] no installed bundle and no --plugin-root; run install first.')
    return EXIT.NO_CONFIG
  }
  const modules = await loadLifecycleModules()
  const intent = flags.intent || 'reconcile'
  const username = defaultUsername(env)
  const log = createLogger({
    path: watcherLogPath(home),
    fs,
    scrub: (line) => scrubLine(line, { home, username, secrets: [] }),
    echo: flags.verbose ? (line) => err(line) : undefined,
  })
  if (flags.dryRun) {
    const observed = await observeMachine({ home, env, platform, fs, exec, modules, manifest, intent, pluginRootOverride, log })
    const plan = modules.planMachine(observed.state)
    out(JSON.stringify({ state: observed.state, pluginRoot: observed.pluginRoot, configDir: observed.configDir, plan }, null, 2))
    return EXIT.OK
  }
  const credentials = readWatcherCredentials(home, fs)
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
    secrets: [],
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

// -- main ---------------------------------------------------------------------------------

/**
 * @param {string[]} [argv]
 * @param {{ home?: string, env?: Record<string, string | undefined>, platform?: string,
 *   fs?: object, exec?: Function, spawnDetached?: Function, scriptPath?: string,
 *   out?: (line: string) => void, err?: (line: string) => void, runWatcherImpl?: typeof runWatcher }} [opts]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), opts = {}) {
  const home = opts.home ?? homedir()
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const fs = opts.fs ?? nodeFs()
  const exec = opts.exec ?? nodeExec()
  const spawnDetached = opts.spawnDetached ?? nodeSpawnDetached()
  const scriptPath = opts.scriptPath ?? defaultScriptPath()
  const out = opts.out ?? ((line) => process.stdout.write(`${line}\n`))
  const err = opts.err ?? ((line) => process.stderr.write(`${line}\n`))
  const { command, flags, errors } = parseWatcherArgs(argv)
  if (flags.help || command === 'help') {
    if (errors.length) for (const e of errors) err(`[hoai-watcher] ${e}`)
    process.stdout.write(USAGE)
    return errors.length ? EXIT.USAGE : EXIT.OK
  }
  if (errors.length) {
    for (const e of errors) err(`[hoai-watcher] ${e}`)
    process.stdout.write(USAGE)
    return EXIT.USAGE
  }
  const common = { flags, home, env, platform, fs, exec, spawnDetached, scriptPath, out, err }
  switch (command) {
    case 'run': {
      const run = opts.runWatcherImpl ?? runWatcher
      return run({ home, env, platform, fs, exec, spawnDetached, nodePath: process.execPath, echo: flags.verbose ? (line) => err(line) : undefined })
    }
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
      process.stdout.write(USAGE)
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
