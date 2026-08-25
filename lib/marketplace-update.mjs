/**
 * Marketplace update glue for the daemon (zero-terminal lifecycle, design
 * 1.4 / task P-D).
 *
 * A marketplace install (`claude plugin install hoai@hoai`) is not a git
 * checkout, so SelfUpdater cannot apply there. Until now the one-click
 * button answered `marketplace_install_manual_update` and stopped. This
 * module turns that dead end into the real thing by feeding the shared
 * planner and executor with THIS machine's observed state for ONE agent
 * (the daemon itself):
 *
 *   observeMarketplaceState  files under the Claude config dir -> ObservedMachineState
 *   runMarketplaceUpdate     planMachine + executePlan, intent 'update', agents = [self]
 *   refreshMarketplaceLatest `claude plugin marketplace update hoai` (network, best
 *                            effort) then the LOCAL marketplace.json, for the
 *                            heartbeat's latestKnownVersion
 *
 * The executor's restart/verify hooks are stubbed to `{ok:true, how:
 * 'daemon-ladder'}` on purpose: after 'installed' the daemon runs its OWN
 * restart ladder (service -> launcher marker -> staged, lib/update-rpc.ts),
 * which is the one authority that knows how this very process is
 * supervised. The executor never touches the daemon's drain either; the
 * rpc handler bounds it (UPDATE_DRAIN_TIMEOUT_MS).
 *
 * Every cross-module function (planner, executor, plugin-cli observation
 * and marketplace.json parser) is resolved lazily and can be injected via
 * `modules`, so this file imports cleanly on its own, tests run against
 * stubs, and a broken sibling module fails ONE update instead of the
 * daemon's boot. Plain JavaScript, node >= 18 builtins only.
 */

import * as nodeFs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { buildFailureDiagnostics } from './update-diagnostics.mjs'

/** The marketplace name every install uses (design 0). */
export const HOAI_MARKETPLACE_NAME = 'hoai'
/** `claude plugin marketplace update` is a network call; cap it. */
export const MARKETPLACE_REFRESH_TIMEOUT_MS = 120_000
/** The first network refresh after boot waits this long so boot is not slowed. */
export const MARKETPLACE_LATEST_INITIAL_DELAY_MS = 30_000
/** Default cadence of the network refresh (mirrors the version heartbeat). */
export const MARKETPLACE_LATEST_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * @typedef {{ id: string, kind: string, message: string }} FailedStep
 * @typedef {{ kind: 'installed', targetVersion: string | null }
 *   | { kind: 'no-update', latestVersion: string | null }
 *   | { kind: 'blocked', reason: string }
 *   | { kind: 'failed', failedStep: FailedStep, rolledBack: boolean, diagnostics: Record<string, unknown> }} MarketplaceUpdateOutcome
 * @typedef {{ id: string, kind: string, state: string, message?: string, targetVersion: string | null }} MarketplaceStepReport
 */

// -- Lazy module resolution --------------------------------------------------

const MODULE_SOURCES = {
  planMachine: './update-planner.mjs',
  executePlan: './update-executor.mjs',
  observeMarketplaceInstall: './plugin-cli.mjs',
  readMarketplaceLatest: './plugin-cli.mjs',
}

/**
 * Resolve one cross-module function: the injected one wins, else the
 * sibling module is imported on first use.
 * @param {Record<string, unknown> | undefined} modules
 * @param {keyof typeof MODULE_SOURCES} name
 */
async function need(modules, name) {
  const injected = modules?.[name]
  if (typeof injected === 'function') return injected
  const mod = await import(MODULE_SOURCES[name])
  const fn = mod[name]
  if (typeof fn !== 'function') throw new Error(`${MODULE_SOURCES[name]} does not export ${name}`)
  return fn
}

function errText(err) {
  return err instanceof Error ? err.message : String(err)
}

function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readTextOrNull(fs, path) {
  try {
    return fs.readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

// -- Paths and mapping --------------------------------------------------------

/** <configDir>/plugins/marketplaces/hoai/.claude-plugin/marketplace.json */
export function marketplaceJsonPath(configDir) {
  return join(configDir, 'plugins', 'marketplaces', HOAI_MARKETPLACE_NAME, '.claude-plugin', 'marketplace.json')
}

/**
 * update-readiness SupervisedKind -> planner agent supervisor.
 * @param {string | null | undefined} kind
 * @returns {'launcher-live' | 'service' | 'none'}
 */
export function mapSupervisedKind(kind) {
  if (kind === 'launcher') return 'launcher-live'
  if (kind === 'launchd' || kind === 'systemd') return 'service'
  return 'none'
}

function latestVersionOf(observation) {
  const latest = observation?.marketplaceLatest
  if (typeof latest === 'string') return latest || null
  if (latest && typeof latest === 'object') return str(latest.version)
  return null
}

/**
 * The executor's fs surface (design 1.3, mirror of update-executor.mjs
 * nodeFs so the alias refresh's readdir/readlink/symlink calls work) over
 * node's sync fs. Sync returns are fine under `await`.
 */
export function executorFs(fs = nodeFs) {
  return {
    readFile: (path) => fs.readFileSync(path, 'utf8'),
    writeFile: (path, text) => fs.writeFileSync(path, text),
    exists: (path) => fs.existsSync(path),
    mkdir: (path, opts) => fs.mkdirSync(path, { recursive: true, ...(opts ?? {}) }),
    rm: (path, opts) => fs.rmSync(path, { recursive: true, force: true, ...(opts ?? {}) }),
    readdir: (path) => fs.readdirSync(path),
    copyFile: (src, dst) => fs.copyFileSync(src, dst),
    copyDir: (src, dst) => fs.cpSync(src, dst, { recursive: true }),
    readlink: (path) => fs.readlinkSync(path),
    symlink: (target, path) => fs.symlinkSync(target, path),
    unlink: (path) => fs.unlinkSync(path),
  }
}

// -- Observation ----------------------------------------------------------------

/**
 * Pure: an ObservedMachineState (design 1.2) for a marketplace install with
 * exactly one agent, this daemon.
 * @param {{
 *   observation: { marketplaceRegistered?: boolean, marketplaceLatest?: unknown,
 *                  installed?: { present?: boolean, version?: unknown, installPath?: unknown } } | null,
 *   platform: string,
 *   runningVersion: string | null,
 *   assistantId: string | number,
 *   cwd?: string | null,
 *   supervised?: string | null,
 *   autoUpdateEnabled?: boolean,
 *   rollbackLatched?: boolean,
 *   intent?: 'update' | 'reconcile' | 'restart_only' | 'repair',
 * }} input
 */
export function buildObservedMarketplaceState(input) {
  const observation = input.observation ?? null
  const installed = observation?.installed ?? {}
  return {
    platform: String(input.platform ?? ''),
    installMethod: 'marketplace',
    runningVersion: str(input.runningVersion),
    marketplace: {
      registered: observation?.marketplaceRegistered === true,
      latestVersion: latestVersionOf(observation),
    },
    installed: {
      present: installed?.present === true,
      version: str(installed?.version),
      installPath: str(installed?.installPath),
    },
    autoUpdateEnabled: input.autoUpdateEnabled !== false,
    rollbackLatched: input.rollbackLatched === true,
    agents: [
      {
        assistantId: String(input.assistantId ?? ''),
        cwd: str(input.cwd),
        supervisor: mapSupervisedKind(input.supervised),
        recipe: false,
        running: true,
      },
    ],
    intent: input.intent ?? 'update',
  }
}

/**
 * Observe THIS machine for a marketplace update: reads the Claude config
 * dir through plugin-cli's observeMarketplaceInstall and wraps it for the
 * planner. `supervised` is the daemon's own detectSupervision() result
 * (lib/update-readiness.ts, passed in because this file cannot import TS).
 * @param {{
 *   configDir: string, home?: string, platform: string, runningVersion: string | null,
 *   assistantId: string | number, cwd?: string | null, supervised?: string | null,
 *   autoUpdateEnabled?: boolean, rollbackLatched?: boolean,
 *   intent?: 'update' | 'reconcile' | 'restart_only' | 'repair',
 *   fs?: typeof nodeFs, modules?: Record<string, unknown>,
 * }} input
 */
export async function observeMarketplaceState(input) {
  const fs = input.fs ?? nodeFs
  const observeMarketplaceInstall = await need(input.modules, 'observeMarketplaceInstall')
  const observation = await observeMarketplaceInstall({
    configDir: input.configDir,
    readFile: (path) => readTextOrNull(fs, path),
    exists: (path) => {
      try {
        return fs.existsSync(path)
      } catch {
        return false
      }
    },
  })
  return buildObservedMarketplaceState({
    observation,
    platform: input.platform,
    runningVersion: input.runningVersion,
    assistantId: input.assistantId,
    cwd: input.cwd ?? null,
    supervised: input.supervised ?? null,
    autoUpdateEnabled: input.autoUpdateEnabled,
    rollbackLatched: input.rollbackLatched,
    intent: input.intent,
  })
}

/** The installed-but-not-running version for a marketplace install, if any
 *  (the cache dir already holds a newer version; only a restart is missing). */
export function pendingMarketplaceRestartVersion(state) {
  const installed = state?.installed
  const running = str(state?.runningVersion)
  if (!installed?.present) return null
  const version = str(installed.version)
  if (!version || !running || version === running) return null
  return version
}

function normalizeFailedStep(raw) {
  if (raw && typeof raw === 'object') {
    return {
      id: String(raw.id ?? 'unknown'),
      kind: str(raw.kind) ?? 'unknown',
      message: typeof raw.message === 'string' ? raw.message : '',
    }
  }
  return { id: 'unknown', kind: 'unknown', message: 'executor reported failure without naming a step' }
}

// -- Run ------------------------------------------------------------------------

/**
 * Plan and execute a marketplace update for this daemon.
 * @param {{
 *   state: ReturnType<typeof buildObservedMarketplaceState>,
 *   cli: (args: string[], opts?: { timeoutMs?: number }) => Promise<unknown>,
 *   fs?: typeof nodeFs, home?: string, configDir: string, platform: string,
 *   log?: (msg: string) => void,
 *   report?: (step: MarketplaceStepReport) => Promise<void> | void,
 *   now?: () => number, sleep?: (ms: number) => Promise<void>,
 *   cliVersion?: string | null, nodeVersion?: string | null, username?: string,
 *   modules?: Record<string, unknown>,
 * }} input
 * @returns {Promise<MarketplaceUpdateOutcome>}
 */
export async function runMarketplaceUpdate(input) {
  const log = input.log ?? (() => {})
  const home = input.home ?? homedir()
  const state = input.state
  const diagnosticsFor = (plan, result) =>
    buildFailureDiagnostics({
      plan,
      result,
      state,
      platform: input.platform,
      installMethod: 'marketplace',
      pluginVersion: state?.runningVersion ?? null,
      targetVersion: plan?.targetVersion ?? null,
      cliVersion: input.cliVersion ?? null,
      nodeVersion: input.nodeVersion ?? null,
      home,
      username: input.username,
    })

  let planMachine
  let executePlan
  try {
    planMachine = await need(input.modules, 'planMachine')
    executePlan = await need(input.modules, 'executePlan')
  } catch (err) {
    const result = { ok: false, failedStep: { id: 'load', kind: 'load', message: errText(err) }, rolledBack: false, steps: [] }
    return { kind: 'failed', failedStep: result.failedStep, rolledBack: false, diagnostics: diagnosticsFor(null, result) }
  }

  let plan
  try {
    plan = planMachine(state)
  } catch (err) {
    const result = { ok: false, failedStep: { id: 'plan', kind: 'plan', message: errText(err) }, rolledBack: false, steps: [] }
    return { kind: 'failed', failedStep: result.failedStep, rolledBack: false, diagnostics: diagnosticsFor(null, result) }
  }
  if (!plan || typeof plan !== 'object') {
    const result = { ok: false, failedStep: { id: 'plan', kind: 'plan', message: 'planner returned nothing' }, rolledBack: false, steps: [] }
    return { kind: 'failed', failedStep: result.failedStep, rolledBack: false, diagnostics: diagnosticsFor(null, result) }
  }
  if (plan.verdict === 'blocked') {
    return { kind: 'blocked', reason: str(plan.reason) ?? 'blocked' }
  }
  if (plan.verdict === 'nothing_to_do') {
    const pending = pendingMarketplaceRestartVersion(state)
    if (pending) {
      log(`marketplace update: ${pending} is already installed and waiting for a restart`)
      return { kind: 'installed', targetVersion: pending }
    }
    return { kind: 'no-update', latestVersion: state?.marketplace?.latestVersion ?? null }
  }

  const steps = Array.isArray(plan.steps) ? plan.steps : []
  const kinds = new Map(steps.map((s) => [s?.id, s?.kind]))
  const targetVersion = str(plan.targetVersion)
  const report = input.report ?? (() => {})
  const deps = {
    cli: input.cli,
    fs: executorFs(input.fs ?? nodeFs),
    home,
    configDir: input.configDir,
    platform: input.platform,
    now: input.now ?? Date.now,
    sleep: input.sleep ?? defaultSleep,
    // Agents = [self]: the daemon's own ladder restarts this process AFTER
    // the outcome is known, so the executor's restart/verify are satisfied
    // here without touching anything.
    restartAgent: async () => ({
      ok: true,
      how: 'daemon-ladder',
      message: 'the daemon runs its own restart ladder after the install',
    }),
    verifyAgent: async () => ({ ok: true, evidence: 'daemon-ladder' }),
    staggerMs: 0,
    log,
  }
  let result
  try {
    result = await executePlan(plan, deps, async (stepId, info) => {
      try {
        await report({
          id: String(stepId),
          kind: str(kinds.get(stepId)) ?? String(stepId),
          state: str(info?.state) ?? 'running',
          ...(str(info?.message) ? { message: info.message } : {}),
          targetVersion,
        })
      } catch (err) {
        log(`marketplace update: progress report failed (non-fatal): ${errText(err)}`)
      }
    })
  } catch (err) {
    result = {
      ok: false,
      failedStep: { id: 'execute', kind: 'execute', message: errText(err) },
      rolledBack: false,
      steps: [],
    }
  }
  if (result && result.ok === true) {
    return {
      kind: 'installed',
      targetVersion: str(result.installedVersion) ?? str(result.targetVersion) ?? targetVersion,
    }
  }
  const failedStep = normalizeFailedStep(result?.failedStep)
  return {
    kind: 'failed',
    failedStep,
    rolledBack: result?.rolledBack === true,
    diagnostics: diagnosticsFor(plan, result ?? { ok: false, failedStep, rolledBack: false, steps: [] }),
  }
}

// -- Latest version (heartbeat telemetry) --------------------------------------

/**
 * Sync, no network: the newest version the LOCAL marketplace.json names,
 * or null. `parse` is plugin-cli's readMarketplaceLatest (injected so this
 * stays sync and import-safe).
 * @param {{ configDir: string, fs?: typeof nodeFs, parse: (text: string) => { version?: string } | null }} input
 */
export function readLocalMarketplaceLatestSync(input) {
  const fs = input.fs ?? nodeFs
  const text = readTextOrNull(fs, marketplaceJsonPath(input.configDir))
  if (text === null) return null
  try {
    const parsed = input.parse(text)
    return str(parsed?.version)
  } catch {
    return null
  }
}

/**
 * Async variant that resolves the parser itself.
 * @param {{ configDir: string, fs?: typeof nodeFs, modules?: Record<string, unknown> }} input
 */
export async function readLocalMarketplaceLatest(input) {
  const parse = await need(input.modules, 'readMarketplaceLatest')
  return readLocalMarketplaceLatestSync({ configDir: input.configDir, fs: input.fs, parse })
}

/**
 * The latest version by full LOCAL observation (plugin-cli's
 * observeMarketplaceInstall, which follows known_marketplaces.json to the
 * marketplace's real install location, so a directory-source marketplace
 * outside the config dir is read too). No network. Falls back to the
 * fixed-path read when the observation itself fails. Never throws.
 * @param {{ configDir: string, fs?: typeof nodeFs, log?: (msg: string) => void, modules?: Record<string, unknown> }} input
 * @returns {Promise<string | null>}
 */
export async function observeMarketplaceLatest(input) {
  const log = input.log ?? (() => {})
  const fs = input.fs ?? nodeFs
  try {
    const observeMarketplaceInstall = await need(input.modules, 'observeMarketplaceInstall')
    const observation = await observeMarketplaceInstall({
      configDir: input.configDir,
      readFile: (path) => readTextOrNull(fs, path),
      exists: (path) => {
        try {
          return fs.existsSync(path)
        } catch {
          return false
        }
      },
    })
    const latest = latestVersionOf(observation)
    if (latest) return latest
  } catch (err) {
    log(`marketplace latest: observation failed, falling back to the marketplace.json read: ${errText(err)}`)
  }
  try {
    return await readLocalMarketplaceLatest({ configDir: input.configDir, fs, modules: input.modules })
  } catch (err) {
    log(`marketplace latest: could not read the local marketplace.json: ${errText(err)}`)
    return null
  }
}

/**
 * Network refresh, best effort, never throws: run `claude plugin
 * marketplace update hoai`, then observe the LOCAL marketplace files.
 * Returns the version they name (or null), whatever the CLI did.
 * @param {{
 *   cli: (args: string[], opts?: { timeoutMs?: number }) => Promise<{ code?: number | null, timedOut?: boolean, stderr?: string } | unknown>,
 *   configDir: string, fs?: typeof nodeFs, log?: (msg: string) => void,
 *   timeoutMs?: number, modules?: Record<string, unknown>,
 * }} input
 * @returns {Promise<string | null>}
 */
export async function refreshMarketplaceLatest(input) {
  const log = input.log ?? (() => {})
  try {
    const res = await input.cli(['plugin', 'marketplace', 'update', HOAI_MARKETPLACE_NAME], {
      timeoutMs: input.timeoutMs ?? MARKETPLACE_REFRESH_TIMEOUT_MS,
    })
    const code = res && typeof res === 'object' ? res.code : undefined
    const timedOut = res && typeof res === 'object' ? res.timedOut === true : false
    if (timedOut) log('marketplace refresh: `claude plugin marketplace update hoai` timed out (kept the local copy)')
    else if (code !== 0 && code !== undefined) {
      const stderr = res && typeof res === 'object' && typeof res.stderr === 'string' ? res.stderr.trim().slice(0, 200) : ''
      log(`marketplace refresh: \`claude plugin marketplace update hoai\` exited ${code}${stderr ? `: ${stderr}` : ''} (kept the local copy)`)
    }
  } catch (err) {
    log(`marketplace refresh failed (non-fatal): ${errText(err)}`)
  }
  return observeMarketplaceLatest({ configDir: input.configDir, fs: input.fs, log, modules: input.modules })
}

/**
 * The heartbeat's latestKnownVersion provider for marketplace installs:
 * `current()` is the cheap sync LOCAL read (never network, the file is the
 * cache) over the last known value, `observeNow()` is the async local
 * observation (follows the marketplace's real install location, still no
 * network), `start()` arms the network refresh once after `initialDelayMs`
 * and then every `intervalMs` (both unref'd), `refreshNow()` is single
 * flight. Nothing here throws.
 * @param {{
 *   readLocal?: () => string | null,
 *   observeLocal?: () => Promise<string | null>,
 *   refresh: () => Promise<string | null>,
 *   intervalMs?: number, initialDelayMs?: number,
 *   log?: (msg: string) => void,
 *   setTimeoutFn?: typeof setTimeout, setIntervalFn?: typeof setInterval,
 *   clearTimeoutFn?: typeof clearTimeout, clearIntervalFn?: typeof clearInterval,
 * }} input
 */
export function createMarketplaceLatestTracker(input) {
  const log = input.log ?? (() => {})
  const setTimeoutFn = input.setTimeoutFn ?? setTimeout
  const setIntervalFn = input.setIntervalFn ?? setInterval
  const clearTimeoutFn = input.clearTimeoutFn ?? clearTimeout
  const clearIntervalFn = input.clearIntervalFn ?? clearInterval
  let lastKnown = null
  let inFlight = null
  let delayTimer = null
  let intervalTimer = null
  let refreshes = 0

  const current = () => {
    try {
      const local = input.readLocal ? input.readLocal() : null
      if (typeof local === 'string' && local.length > 0) lastKnown = local
    } catch {
      // Keep the last value the file gave us.
    }
    return lastKnown
  }

  const observeNow = async () => {
    if (!input.observeLocal) return lastKnown
    try {
      const observed = await input.observeLocal()
      if (typeof observed === 'string' && observed.length > 0) lastKnown = observed
    } catch (err) {
      log(`marketplace latest observation failed (non-fatal): ${errText(err)}`)
    }
    return lastKnown
  }

  const refreshNow = () => {
    if (inFlight) return inFlight
    inFlight = (async () => {
      refreshes += 1
      try {
        const fetched = await input.refresh()
        if (typeof fetched === 'string' && fetched.length > 0) lastKnown = fetched
      } catch (err) {
        log(`marketplace latest refresh failed (non-fatal): ${errText(err)}`)
      } finally {
        inFlight = null
      }
      return lastKnown
    })()
    return inFlight
  }

  return {
    current,
    observeNow,
    refreshNow,
    refreshCount: () => refreshes,
    start() {
      if (delayTimer || intervalTimer) return
      delayTimer = setTimeoutFn(() => {
        delayTimer = null
        void refreshNow()
        intervalTimer = setIntervalFn(() => void refreshNow(), input.intervalMs ?? MARKETPLACE_LATEST_INTERVAL_MS)
        intervalTimer?.unref?.()
      }, input.initialDelayMs ?? MARKETPLACE_LATEST_INITIAL_DELAY_MS)
      delayTimer?.unref?.()
    },
    stop() {
      if (delayTimer) clearTimeoutFn(delayTimer)
      if (intervalTimer) clearIntervalFn(intervalTimer)
      delayTimer = null
      intervalTimer = null
    },
  }
}
