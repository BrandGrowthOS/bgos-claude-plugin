/**
 * update-executor: runs a MachinePlan (lib/update-planner.mjs) against one
 * machine, step by step, with EVERY effect injected: the claude CLI, the
 * filesystem, git, the clock, sleeping, restarting and verifying agents,
 * reporting and logging. The planner decides, this file acts, and nothing in
 * here reaches for process.env, the real fs or a real child process unless a
 * caller hands it in (nodeFs() below is the one convenience adapter).
 *
 * What it guarantees (each one is a test in test/update-executor.test.ts):
 *
 *   - Every step is reported through `report(stepId, {state, message?,
 *     detail?})` as it runs; a report callback that throws is logged and
 *     never derails the run. The returned `steps` array is exactly what was
 *     reported (last state per id, in first-report order).
 *   - Messages are short machine tokens (`cli_failed:1`, `garbage_output`,
 *     `timeout`, `version_mismatch`, `rollback_impossible`,
 *     `marketplace_latest_unknown`, `agent_deaf_after_update`, ...), never raw
 *     CLI output. At most 300 characters of scrubbed output go in `detail`
 *     (home dir replaced by `~`, any 32+ character token redacted).
 *   - The escalation ladder for a failed marketplace mutation runs ONCE per
 *     run: update fails -> inline `<id>.reinstall` (uninstall -y, install -y,
 *     files re-observed) -> if that fails too, inline `<id>.rollback`
 *     restores the snapshot (installed_plugins.json, settings.json,
 *     known_marketplaces.json), but only when the snapshot's install dir is
 *     still on disk with a matching plugin.json (else `rollback_impossible`).
 *     A verify_installed mismatch after a "successful" CLI run takes the same
 *     ladder, then an inline `<id>.verify` re-check.
 *   - verify_agent failure after an install rolls the plugin back, then
 *     restarts and verifies that agent ONCE more on the restored version
 *     (`<id>.retry`), names `agent_deaf_after_update` with the agent id, and
 *     continues with the remaining agents only if the rollback succeeded
 *     (they restart on the rolled-back version; the run ends `rolled_back`).
 *   - Every effect has a hard deadline: network CLI calls 180s, `list --json`
 *     30s, a restart 60s, a verify `verifyTimeoutMs` (120s). A deadline is a
 *     failure with the token `timeout`.
 *   - After a successful verify (and after a rollback) the `hoai` alias is
 *     re-pointed when it points into the marketplace cache (design 7.3):
 *     win32 `<localAppData>\hoai\bin\hoai-plugin-root.txt`, posix
 *     `<home>/.local/bin/hoai` symlink. A clone-pointing alias is never
 *     touched.
 *   - Clone plans: `git fetch --quiet origin main` + `git merge --ff-only
 *     <target>` in the plugin root; failure rolls back with `git checkout
 *     --detach <previous sha>`. Never `git clean`, never untracked files.
 *   - executeWithReobserve() is the observe / plan / execute loop: a partial
 *     plan (`reobserve: true`, marketplace latest unreadable) runs, the
 *     machine is observed again and planned again with `r2-` step ids; a
 *     second partial plan is `marketplace_latest_unknown`. Inside a partial
 *     plan verify_installed only records what is installed (`observed`).
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe (no side effects at
 * load) because the same file serves server.ts (bun), the watcher bundle
 * (bare node) and the node:test suite. No em or en dashes anywhere.
 */

import * as nodeFsModule from 'node:fs'
import { homedir } from 'node:os'

import { claudeConfigDir, parsePath } from '../bin/bgos-install-method.mjs'
import { describeRollbackRecovery, readKnownGood } from './known-good-store.mjs'
import {
  HOAI_PLUGIN_ID,
  LIST_TIMEOUT_MS,
  NETWORK_TIMEOUT_MS,
  classifyInstall,
  classifyMarketplaceAdd,
  classifyMarketplaceUpdate,
  classifyUninstall,
  classifyUpdate,
  installArgs,
  listJsonArgs,
  marketplaceAddArgs,
  marketplaceConfigPaths,
  marketplaceUpdateArgs,
  normalizeCliResult,
  observeMarketplaceInstall,
  parsePluginListJson,
  uninstallArgs,
  updateArgs,
} from './plugin-cli.mjs'
import { STEP_KINDS, compareSemver, parseSemver, planMachine } from './update-planner.mjs'

// -- Constants ---------------------------------------------------------------

/** Pause between two agent restarts (the fleet never bounces at once). */
export const DEFAULT_STAGGER_MS = 10_000
/** How long verifyAgent may take to prove the agent hears the channel. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000
/** How long a restartAgent call may take. */
export const DEFAULT_RESTART_TIMEOUT_MS = 60_000
/** Rollback snapshots kept under <home>/.bgos-agent/watcher/rollback/. */
export const SNAPSHOTS_TO_KEEP = 3
/** Cap on a step's `detail` field (the wire allows 300). */
export const DETAIL_MAX_CHARS = 300
/** The snapshot record written next to the copied files. */
export const SNAPSHOT_FILE = 'snapshot.json'
/** win32 alias breadcrumb name (bin/hoai-bootstrap.ps1, bin/hoai.ps1). */
export const ALIAS_BREADCRUMB_FILE = 'hoai-plugin-root.txt'
/** The three config files a marketplace mutation rewrites. */
export const SNAPSHOT_FILE_NAMES = Object.freeze(['installed_plugins.json', 'settings.json', 'known_marketplaces.json'])
/** Step kinds that may still run after a successful rollback (agents come
 *  back up on the restored version); everything else is skipped. */
export const POST_ROLLBACK_STEP_KINDS = Object.freeze(['restart_agent', 'verify_agent', 'manual_restart_required'])
/** failedStep.message prefix per mutating kind (`update_failed:cli_failed:1`). */
export const FAILED_STEP_PREFIX = Object.freeze({
  update_plugin: 'update_failed',
  install_plugin: 'install_failed',
  reinstall_plugin: 'reinstall_failed',
  git_fast_forward: 'fast_forward_failed',
})

/** Extra time the executor's own deadline allows past the CLI runner's
 *  budget, so a runner that honours `timeoutMs` reports the kill itself. */
const DEADLINE_GRACE_MS = 5_000
/** The executor's own deadline for a budgeted effect: the budget plus a
 *  grace that never exceeds the budget itself (a 20ms test budget gives a
 *  40ms deadline, a 180s network budget 185s). */
function deadlineFor(budgetMs) {
  return budgetMs + Math.min(DEADLINE_GRACE_MS, budgetMs)
}
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/

// -- Types -------------------------------------------------------------------

/**
 * @typedef {'running'|'ok'|'failed'|'skipped'|'rolled_back'} StepState
 * @typedef {'done'|'failed'|'rolled_back'|'blocked'|'nothing_to_do'} RunVerdict
 */

/**
 * @typedef {object} CliResult
 * @property {number|null} code
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 */

/**
 * The filesystem the executor uses. Every function may be sync or async
 * (results are awaited). `readFile` may throw or return null for a missing
 * file. `readlink` / `symlink` / `unlink` / `copyFile` are optional.
 * @typedef {object} ExecutorFs
 * @property {(path: string) => any} readFile
 * @property {(path: string, text: string) => any} writeFile
 * @property {(path: string) => any} exists
 * @property {(path: string, opts?: { recursive?: boolean }) => any} mkdir
 * @property {(path: string, opts?: { recursive?: boolean, force?: boolean }) => any} rm
 * @property {(path: string) => any} readdir
 * @property {(src: string, dst: string) => any} [copyFile]
 * @property {(path: string) => any} [readlink]
 * @property {(target: string, path: string) => any} [symlink]
 * @property {(path: string) => any} [unlink]
 */

/**
 * @typedef {object} ExecutorAgent
 * @property {string} assistantId
 * @property {string|null} [cwd]
 */

/**
 * @typedef {object} ExecutorDeps
 * @property {(args: string[], opts: { timeoutMs: number }) => Promise<Partial<CliResult>>} cli
 * @property {ExecutorFs} fs
 * @property {string} [home]
 * @property {string} [configDir]
 * @property {string} [platform]
 * @property {string|null} [localAppData]        win32: %LOCALAPPDATA%, for the alias breadcrumb
 * @property {'marketplace'|'clone'} [installMethod]  inferred from the plan when absent
 * @property {string|null} [pluginRoot]           clone installs: the checkout to fast-forward
 * @property {{ targetCommit?: string|null }} [clone]  clone installs: the commit the planner saw
 * @property {(args: string[], cwd: string) => Promise<Partial<CliResult>>} [git]
 * @property {(agent: ExecutorAgent, opts: { via: string|null, restartedAtMs: number }) => Promise<{ ok: boolean, how?: string, message?: string }>} [restartAgent]
 * @property {(agent: ExecutorAgent, opts: { restartedAtMs: number, timeoutMs: number }) => Promise<{ ok: boolean, evidence?: string, message?: string }>} [verifyAgent]
 * @property {ExecutorAgent[]} [agents]
 * @property {() => number} [now]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {{ setTimeout: Function, clearTimeout: Function }} [timers]  deadlines only (default: globals)
 * @property {number} [staggerMs]
 * @property {number} [verifyTimeoutMs]
 * @property {{ network?: number, list?: number, restart?: number }} [timeoutsMs]
 * @property {(msg: string) => void} [log]
 */

/**
 * @typedef {object} StepRecord
 * @property {string} id
 * @property {string} kind
 * @property {string} [target]
 * @property {StepState} state
 * @property {string} [message]
 * @property {string} [detail]
 * @property {number} startedAt
 * @property {number|null} endedAt
 */

/**
 * @typedef {object} FailedStep
 * @property {string} id
 * @property {string} kind
 * @property {string} [target]
 * @property {string} message
 */

/**
 * @typedef {object} ExecuteResult
 * @property {boolean} ok
 * @property {RunVerdict} verdict
 * @property {string} [reason]                blocked plans: the planner's reason
 * @property {FailedStep|null} failedStep
 * @property {boolean} rolledBack
 * @property {string|null} targetVersion
 * @property {string|null} installedVersion
 * @property {StepRecord[]} steps
 */

/** @typedef {(stepId: string, payload: { state: StepState, message?: string, detail?: string }) => any} ReportFn */

// -- Pure path helpers -------------------------------------------------------

/** True when the path is win32 shaped (drive letter or a backslash). */
function looksWin32(path) {
  const value = String(path ?? '')
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')
}

/** @param {string} path */
function isAbsolutePath(path) {
  return /^[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * Join path parts in the BASE path's own separator style, so a posix home
 * stays posix on a win32 host and an in-memory fs can key on exact strings.
 * @param {string} base
 * @param {...string} parts
 */
export function joinLike(base, ...parts) {
  const { prefix, sep, segments } = parsePath(base)
  const extra = parts.flatMap((part) => String(part ?? '').split(/[\\/]+/)).filter((segment) => segment && segment !== '.')
  return `${prefix}${[...segments, ...extra].join(sep)}`
}

/** The parent of a path, in its own separator style. */
export function dirnameLike(path) {
  const { prefix, sep, segments } = parsePath(path)
  const parent = segments.slice(0, -1).join(sep)
  return parent ? `${prefix}${parent}` : prefix || '.'
}

/** Comparable identity of a path: root marker + segments. */
function pathParts(path) {
  const { prefix, segments } = parsePath(path)
  const marker = /^[A-Za-z]:/.test(prefix) ? prefix.slice(0, 2).toLowerCase() : prefix ? '/' : ''
  return { marker, segments }
}

/**
 * True when `child` lies strictly under `parent` (segment based, mixed
 * separators tolerated, case insensitive when either side is win32 shaped).
 * @param {string} child
 * @param {string} parent
 */
export function pathWithin(child, parent) {
  const c = pathParts(String(child ?? ''))
  const p = pathParts(String(parent ?? ''))
  if (c.marker !== p.marker) return false
  if (c.segments.length <= p.segments.length) return false
  const fold = looksWin32(child) || looksWin32(parent) ? (s) => s.toLowerCase() : (s) => s
  return p.segments.every((segment, index) => fold(segment) === fold(c.segments[index]))
}

/** True when both paths name the same location (same rule as pathWithin). */
export function samePath(a, b) {
  const x = pathParts(String(a ?? ''))
  const y = pathParts(String(b ?? ''))
  if (x.marker !== y.marker || x.segments.length !== y.segments.length) return false
  const fold = looksWin32(a) || looksWin32(b) ? (s) => s.toLowerCase() : (s) => s
  return x.segments.every((segment, index) => fold(segment) === fold(y.segments[index]))
}

/** <home>/.bgos-agent/watcher/rollback */
export function rollbackRootFor(home) {
  return joinLike(home, '.bgos-agent', 'watcher', 'rollback')
}

/** win32: <localAppData>\hoai\bin\hoai-plugin-root.txt */
export function aliasBreadcrumbPath(localAppData) {
  return joinLike(localAppData, 'hoai', 'bin', ALIAS_BREADCRUMB_FILE)
}

/** posix: <home>/.local/bin/hoai */
export function aliasSymlinkPath(home) {
  return joinLike(home, '.local', 'bin', 'hoai')
}

/** A sortable, filename-safe timestamp: 2026-08-25T01-02-03-456Z */
export function snapshotStamp(ms) {
  return new Date(ms).toISOString().replace(/[:.]/g, '-')
}

// -- Pure text helpers -------------------------------------------------------

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Detail text fit for the wire: ANSI and control bytes removed, whitespace
 * collapsed, the home dir replaced by `~` (either separator style, case
 * insensitive for a win32 home), any 32+ character token (api keys, pairing
 * tokens, git shas, JWT segments) replaced by `<redacted>`, capped.
 * @param {unknown} text
 * @param {string} [home]
 * @param {number} [max]
 */
export function scrubDetail(text, home, max = DETAIL_MAX_CHARS) {
  let out = String(text ?? '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const base = String(home ?? '').replace(/[\\/]+$/, '')
  if (base) {
    const pattern = base
      .split(/[\\/]+/)
      .map(escapeRegExp)
      .join('[\\\\/]+')
    out = out.replace(new RegExp(pattern, looksWin32(base) ? 'gi' : 'g'), '~')
  }
  out = out.replace(/[A-Za-z0-9_-]{32,}/g, '<redacted>')
  return out.length > max ? out.slice(0, max) : out
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error')
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(String(text))
  } catch {
    return undefined
  }
}

function validSemver(value) {
  return parseSemver(value) ? String(value) : null
}

function shortSha(sha) {
  const value = String(sha ?? '').trim()
  return value ? value.slice(0, 12) : 'unknown'
}

// -- Deadline ----------------------------------------------------------------

/**
 * Run `start()` under a deadline. Resolves `{timedOut:true}` when the
 * deadline fires first, `{value}` on success, `{error}` on rejection or a
 * synchronous throw. The timer is cleared as soon as the effect settles, so a
 * fast call never keeps the process alive.
 * @template T
 * @param {() => Promise<T>|T} start
 * @param {number} ms
 * @param {{ setTimeout: Function, clearTimeout: Function }} timers
 * @returns {Promise<{ timedOut: true } | { timedOut: false, value: T } | { timedOut: false, error: unknown }>}
 */
export function withDeadline(start, ms, timers) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    if (Number.isFinite(ms) && ms > 0) {
      timer = timers.setTimeout(() => {
        if (settled) return
        settled = true
        resolve({ timedOut: true })
      }, ms)
      if (timer && typeof timer.unref === 'function') timer.unref()
    }
    const done = (result) => {
      if (settled) return
      settled = true
      if (timer !== null) timers.clearTimeout(timer)
      resolve(result)
    }
    let promise
    try {
      promise = Promise.resolve(start())
    } catch (error) {
      promise = Promise.reject(error)
    }
    promise.then(
      (value) => done({ timedOut: false, value }),
      (error) => done({ timedOut: false, error }),
    )
  })
}

// -- Default adapters --------------------------------------------------------

/**
 * A synchronous node:fs adapter satisfying ExecutorFs (the daemon and the
 * watcher pass this; tests pass an in-memory one).
 * @param {typeof nodeFsModule} [impl]
 * @returns {ExecutorFs}
 */
export function nodeFs(impl = nodeFsModule) {
  return {
    readFile: (path) => impl.readFileSync(path, 'utf8'),
    writeFile: (path, text) => impl.writeFileSync(path, text),
    exists: (path) => impl.existsSync(path),
    mkdir: (path, opts) => impl.mkdirSync(path, { recursive: true, ...(opts ?? {}) }),
    rm: (path, opts) => impl.rmSync(path, { recursive: true, force: true, ...(opts ?? {}) }),
    readdir: (path) => impl.readdirSync(path),
    copyFile: (src, dst) => impl.copyFileSync(src, dst),
    readlink: (path) => impl.readlinkSync(path),
    symlink: (target, path) => impl.symlinkSync(target, path),
    unlink: (path) => impl.unlinkSync(path),
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const realTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
}

// -- Context -----------------------------------------------------------------

function positiveOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * @param {object} plan
 * @param {ExecutorDeps} deps
 * @param {ReportFn|undefined} report
 */
function makeContext(plan, deps, report) {
  const home = String(deps.home ?? homedir())
  const platform = typeof deps.platform === 'string' ? deps.platform : process.platform
  const configDir = String(deps.configDir ?? claudeConfigDir({ home }))
  const steps = Array.isArray(plan?.steps) ? plan.steps : []
  const hasGitStep = steps.some((step) => step?.kind === 'git_fast_forward')
  const installMethod =
    deps.installMethod === 'clone' || deps.installMethod === 'marketplace'
      ? deps.installMethod
      : hasGitStep
        ? 'clone'
        : 'marketplace'
  const rawLog = typeof deps.log === 'function' ? deps.log : () => {}
  const log = (msg) => {
    try {
      rawLog(`update-executor: ${msg}`)
    } catch {
      /* logging never derails the run */
    }
  }
  const safeReport = async (stepId, payload) => {
    if (typeof report !== 'function') return
    try {
      await report(stepId, payload)
    } catch (error) {
      log(`report(${stepId}) threw: ${scrubDetail(errorMessage(error), home)}`)
    }
  }
  const now = typeof deps.now === 'function' ? deps.now : Date.now
  const timeouts = deps.timeoutsMs ?? {}
  return {
    plan,
    deps,
    fs: deps.fs,
    home,
    platform,
    configDir,
    localAppData: typeof deps.localAppData === 'string' && deps.localAppData ? deps.localAppData : null,
    pluginRoot: typeof deps.pluginRoot === 'string' && deps.pluginRoot ? deps.pluginRoot : null,
    installMethod,
    agents: Array.isArray(deps.agents) ? deps.agents : [],
    now,
    sleep: typeof deps.sleep === 'function' ? deps.sleep : realSleep,
    timers: deps.timers ?? realTimers,
    staggerMs: positiveOr(deps.staggerMs, DEFAULT_STAGGER_MS),
    verifyTimeoutMs: positiveOr(deps.verifyTimeoutMs, DEFAULT_VERIFY_TIMEOUT_MS),
    timeouts: {
      network: positiveOr(timeouts.network, NETWORK_TIMEOUT_MS),
      list: positiveOr(timeouts.list, LIST_TIMEOUT_MS),
      restart: positiveOr(timeouts.restart, DEFAULT_RESTART_TIMEOUT_MS),
    },
    log,
    report: safeReport,
    targetVersion: validSemver(plan?.targetVersion),
    installedVersion: null,
    /** @type {StepRecord[]} */
    steps: [],
    /** @type {Map<string, StepRecord>} */
    byId: new Map(),
    snapshot: null,
    cloneBaseSha: null,
    escalated: false,
    rolledBack: false,
    rollbackImpossible: false,
    /** @type {FailedStep|null} */
    failedStep: null,
    aborted: false,
    /** @type {Map<string, { restartedAtMs: number, ok: boolean }>} */
    restarts: new Map(),
    restartCount: 0,
    startedAt: now(),
  }
}

// -- Step bookkeeping --------------------------------------------------------

function stepRecordBase(ctx, step, state) {
  /** @type {StepRecord} */
  const record = { id: String(step.id), kind: String(step.kind), state, startedAt: ctx.now(), endedAt: null }
  if (step.target !== undefined && step.target !== null) record.target = String(step.target)
  return record
}

async function begin(ctx, step) {
  const record = stepRecordBase(ctx, step, 'running')
  ctx.steps.push(record)
  ctx.byId.set(record.id, record)
  await ctx.report(record.id, { state: 'running' })
  return record
}

async function finish(ctx, step, state, message, detail) {
  let record = ctx.byId.get(String(step.id))
  if (!record) {
    record = stepRecordBase(ctx, step, state)
    ctx.steps.push(record)
    ctx.byId.set(record.id, record)
  }
  record.state = state
  if (message) record.message = String(message)
  else delete record.message
  if (detail) record.detail = scrubDetail(detail, ctx.home)
  else delete record.detail
  record.endedAt = ctx.now()
  const payload = { state }
  if (record.message) payload.message = record.message
  if (record.detail) payload.detail = record.detail
  ctx.log(`${record.id} ${state}${record.message ? ` ${record.message}` : ''}`)
  await ctx.report(record.id, payload)
}

async function skip(ctx, step, message, detail) {
  await finish(ctx, step, 'skipped', message, detail)
}

/** An inline step synthesized by the executor (`<parentId>.<suffix>`). */
function inlineStep(parent, suffix, kind, onFailure = 'stop') {
  const step = { id: `${parent.id}.${suffix}`, kind, onFailure }
  if (parent.target !== undefined) step.target = parent.target
  return step
}

function failedStepOf(step, reason) {
  const prefix = FAILED_STEP_PREFIX[step.kind]
  /** @type {FailedStep} */
  const failed = { id: String(step.id), kind: String(step.kind), message: prefix ? `${prefix}:${reason}` : String(reason) }
  if (step.target !== undefined && step.target !== null) failed.target = String(step.target)
  return failed
}

/** Record a failure the run survives (policy `continue`); the first one wins. */
function noteFailure(ctx, step, reason) {
  if (!ctx.failedStep) ctx.failedStep = failedStepOf(step, reason)
}

/** The step that ends the run names itself, overriding any softer failure. */
function abort(ctx, step, reason) {
  ctx.failedStep = failedStepOf(step, reason)
  ctx.aborted = true
}

// -- Filesystem helpers (all through the injected fs) ------------------------

async function readText(ctx, path) {
  try {
    if (!(await ctx.fs.exists(path))) return null
    const value = await ctx.fs.readFile(path)
    if (value == null) return null
    return Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
  } catch {
    return null
  }
}

async function writeText(ctx, path, text) {
  await ctx.fs.mkdir(dirnameLike(path), { recursive: true })
  await ctx.fs.writeFile(path, text)
}

async function copyFile(ctx, src, dst) {
  await ctx.fs.mkdir(dirnameLike(dst), { recursive: true })
  if (typeof ctx.fs.copyFile === 'function') {
    await ctx.fs.copyFile(src, dst)
    return
  }
  const text = await ctx.fs.readFile(src)
  await ctx.fs.writeFile(dst, Buffer.isBuffer(text) ? text.toString('utf8') : String(text ?? ''))
}

async function removeFile(ctx, path) {
  if (typeof ctx.fs.unlink === 'function') {
    try {
      await ctx.fs.unlink(path)
      return
    } catch {
      /* fall through to rm */
    }
  }
  await ctx.fs.rm(path, { recursive: false, force: true })
}

/** What the config files say right now (never throws). */
async function observeFiles(ctx) {
  return observeMarketplaceInstall({
    configDir: ctx.configDir,
    readFile: (path) => ctx.fs.readFile(path),
    exists: (path) => ctx.fs.exists(path),
  })
}

// -- CLI and git -------------------------------------------------------------

const TIMEOUT_RESULT = Object.freeze({ code: null, stdout: '', stderr: '', timedOut: true })

/**
 * Run one `claude <args>` through the injected cli under a deadline and
 * classify the outcome. `kind` is the classifier's verdict, or `timeout`;
 * `reason` is the machine token for a non-success (`cli_failed:<rc>`,
 * `garbage_output`, `timeout`), null otherwise.
 * @param {ReturnType<typeof makeContext>} ctx
 * @param {string[]} args
 * @param {((res: CliResult) => { kind: string, message: string })|null} classifier
 * @param {'network'|'list'} budgetKey
 */
async function runCli(ctx, args, classifier, budgetKey) {
  const budget = budgetKey === 'list' ? ctx.timeouts.list : ctx.timeouts.network
  const raced = await withDeadline(() => ctx.deps.cli(args, { timeoutMs: budget }), deadlineFor(budget), ctx.timers)
  if (raced.timedOut) {
    return { kind: 'timeout', reason: 'timeout', detail: `timeout:${budget}ms`, res: TIMEOUT_RESULT }
  }
  if ('error' in raced) {
    return { kind: 'failed', reason: 'cli_failed:spawn', detail: scrubDetail(errorMessage(raced.error), ctx.home), res: { code: null, stdout: '', stderr: '', timedOut: false } }
  }
  const res = normalizeCliResult(raced.value)
  if (res.timedOut) {
    return { kind: 'timeout', reason: 'timeout', detail: `timeout:${budget}ms`, res }
  }
  if (!classifier) {
    return { kind: res.code === 0 ? 'ok' : 'failed', reason: res.code === 0 ? null : `cli_failed:${res.code ?? 'null'}`, detail: scrubDetail(res.stderr || res.stdout, ctx.home), res }
  }
  let verdict
  try {
    verdict = classifier(res)
  } catch (error) {
    verdict = { kind: 'garbage', message: errorMessage(error) }
  }
  const kind = typeof verdict?.kind === 'string' ? verdict.kind : 'garbage'
  let reason = null
  if (kind === 'failed') reason = `cli_failed:${res.code ?? 'null'}`
  else if (kind === 'garbage') reason = 'garbage_output'
  const detail = scrubDetail(res.stderr || verdict?.message || res.stdout, ctx.home)
  return { kind, reason, detail, res }
}

/** Run `git <args>` in the plugin root under the network deadline. */
async function runGit(ctx, args) {
  if (typeof ctx.deps.git !== 'function' || !ctx.pluginRoot) {
    return { code: null, stdout: '', stderr: 'git runner unavailable', timedOut: false, unavailable: true }
  }
  const budget = ctx.timeouts.network
  const raced = await withDeadline(() => ctx.deps.git(args, ctx.pluginRoot), deadlineFor(budget), ctx.timers)
  if (raced.timedOut) return { ...TIMEOUT_RESULT }
  if ('error' in raced) return { code: null, stdout: '', stderr: errorMessage(raced.error), timedOut: false }
  return normalizeCliResult(raced.value)
}

// -- Observation -------------------------------------------------------------

/**
 * The installed version right now: `claude plugin list --json` first, the
 * config files when the list is unusable (rc != 0, garbage, timeout, no hoai
 * row), package.json for a clone.
 */
async function observeInstalledVersion(ctx) {
  if (ctx.installMethod === 'clone') {
    const text = ctx.pluginRoot ? await readText(ctx, joinLike(ctx.pluginRoot, 'package.json')) : null
    const doc = text === null ? undefined : parseJsonSafe(text)
    const version = typeof doc?.version === 'string' ? doc.version : null
    return { version, installPath: ctx.pluginRoot, source: 'package_json' }
  }
  const listed = await runCli(ctx, listJsonArgs(), null, 'list')
  if (listed.kind === 'ok') {
    const rows = parsePluginListJson(listed.res.stdout)
    const row = Array.isArray(rows) ? rows.find((entry) => entry.id === HOAI_PLUGIN_ID) : null
    if (row && row.version) return { version: row.version, installPath: row.installPath, source: 'list' }
  }
  const observed = await observeFiles(ctx)
  return {
    version: observed.installed.version,
    installPath: observed.installed.installPath,
    source: observed.installed.present ? 'installed_plugins' : 'none',
  }
}

// -- The hoai alias (design 7.3) ---------------------------------------------

/**
 * Re-point the `hoai` alias at `installPath` when the alias points into the
 * marketplace cache. Returns a short token describing what happened; never
 * throws.
 */
async function refreshAlias(ctx, installPath) {
  try {
    if (!installPath) return 'alias:skipped(no_install_path)'
    const cacheDir = marketplaceConfigPaths(ctx.configDir).cacheDir
    if (!pathWithin(installPath, cacheDir)) return 'alias:untouched(install_outside_cache)'
    if (ctx.platform === 'win32') {
      if (!ctx.localAppData) return 'alias:skipped(no_local_app_data)'
      const breadcrumb = aliasBreadcrumbPath(ctx.localAppData)
      const current = await readText(ctx, breadcrumb)
      if (current === null) return 'alias:absent'
      const pointed = current.trim()
      if (!pointed || !pathWithin(pointed, cacheDir)) return 'alias:untouched(clone)'
      if (samePath(pointed, installPath)) return 'alias:current'
      await ctx.fs.writeFile(breadcrumb, `${installPath}\r\n`)
      return 'alias:breadcrumb_updated'
    }
    if (typeof ctx.fs.readlink !== 'function' || typeof ctx.fs.symlink !== 'function') {
      return 'alias:skipped(no_symlink_support)'
    }
    const link = aliasSymlinkPath(ctx.home)
    let target
    try {
      target = String(await ctx.fs.readlink(link))
    } catch {
      return 'alias:absent'
    }
    const resolved = isAbsolutePath(target) ? target : joinLike(dirnameLike(link), target)
    if (!pathWithin(resolved, cacheDir)) return 'alias:untouched(clone)'
    const wanted = joinLike(installPath, 'bin', 'hoai')
    if (samePath(resolved, wanted)) return 'alias:current'
    await removeFile(ctx, link)
    await ctx.fs.symlink(wanted, link)
    return 'alias:symlink_updated'
  } catch (error) {
    return `alias:failed(${scrubDetail(errorMessage(error), ctx.home, 80)})`
  }
}

// -- Snapshot and rollback ---------------------------------------------------

/**
 * Keep the newest SNAPSHOTS_TO_KEEP snapshot dirs. The one just written is
 * never a candidate (a clock that went backwards must not delete it);
 * foreign entries under the rollback root are never touched.
 */
async function pruneSnapshots(ctx, keepName) {
  const root = rollbackRootFor(ctx.home)
  let names
  try {
    names = await ctx.fs.readdir(root)
  } catch {
    return
  }
  const stamps = (Array.isArray(names) ? names : [])
    .map(String)
    .filter((name) => STAMP_RE.test(name) && name !== keepName)
    .sort()
  const stale = stamps.slice(0, Math.max(0, stamps.length - (SNAPSHOTS_TO_KEEP - 1)))
  for (const name of stale) {
    try {
      await ctx.fs.rm(joinLike(root, name), { recursive: true, force: true })
    } catch (error) {
      ctx.log(`could not prune snapshot ${name}: ${scrubDetail(errorMessage(error), ctx.home)}`)
    }
  }
}

async function snapshotStep(ctx, step) {
  await begin(ctx, step)
  try {
    if (ctx.installMethod === 'clone') {
      const head = await runGit(ctx, ['rev-parse', 'HEAD'])
      if (head.unavailable) {
        await finish(ctx, step, 'failed', 'git_unavailable', 'no git runner or plugin root')
        return handleFailure(ctx, step, 'git_unavailable')
      }
      if (head.timedOut || head.code !== 0) {
        const reason = head.timedOut ? 'timeout' : `git_failed:${head.code ?? 'null'}`
        await finish(ctx, step, 'failed', reason, head.stderr)
        return handleFailure(ctx, step, reason)
      }
      const sha = head.stdout.trim()
      const observed = await observeInstalledVersion(ctx)
      ctx.cloneBaseSha = sha
      ctx.installedVersion = observed.version
      ctx.snapshot = { dir: null, takenAt: new Date(ctx.now()).toISOString(), installMethod: 'clone', installPath: ctx.pluginRoot, version: observed.version, files: [] }
      await finish(ctx, step, 'ok', 'recorded', `head:${shortSha(sha)};version:${observed.version ?? 'unknown'}`)
      return
    }
    const paths = marketplaceConfigPaths(ctx.configDir)
    const observed = await observeFiles(ctx)
    const takenAtMs = ctx.now()
    const stamp = snapshotStamp(takenAtMs)
    const dir = joinLike(rollbackRootFor(ctx.home), stamp)
    await ctx.fs.mkdir(dir, { recursive: true })
    const sources = {
      'installed_plugins.json': paths.installedPlugins,
      'settings.json': paths.settings,
      'known_marketplaces.json': paths.knownMarketplaces,
    }
    const files = []
    for (const name of SNAPSHOT_FILE_NAMES) {
      const source = sources[name]
      if (await ctx.fs.exists(source)) {
        const copy = joinLike(dir, name)
        await copyFile(ctx, source, copy)
        files.push({ name, source, copy, absent: false })
      } else {
        files.push({ name, source, copy: null, absent: true })
      }
    }
    const record = {
      takenAt: new Date(takenAtMs).toISOString(),
      installMethod: 'marketplace',
      installPath: observed.installed.installPath,
      version: observed.installed.version,
      files,
    }
    await writeText(ctx, joinLike(dir, SNAPSHOT_FILE), `${JSON.stringify(record, null, 2)}\n`)
    await pruneSnapshots(ctx, stamp)
    ctx.snapshot = { dir, ...record }
    ctx.installedVersion = record.version
    const copied = files.filter((file) => !file.absent).map((file) => file.name)
    await finish(ctx, step, 'ok', 'recorded', `files:${copied.join(',') || 'none'};version:${record.version ?? 'none'};dir:${dir}`)
  } catch (error) {
    await finish(ctx, step, 'failed', 'snapshot_failed', errorMessage(error))
    await handleFailure(ctx, step, 'snapshot_failed')
  }
}

/**
 * Restore the pre-run install. Marketplace: copy the snapshot files back
 * (and delete files that did not exist before) when the snapshot's install
 * dir still holds a plugin.json of the snapshot version; clone: `git
 * checkout --detach <base sha>`. Reports the inline rollback step. Returns
 * true when the restore happened.
 */
async function rollbackCore(ctx, step) {
  await begin(ctx, step)
  const impossible = async (why) => {
    ctx.rollbackImpossible = true
    await finish(ctx, step, 'failed', 'rollback_impossible', why)
    return false
  }
  if (ctx.rolledBack) {
    await finish(ctx, step, 'skipped', 'already_rolled_back')
    return true
  }
  try {
    if (ctx.installMethod === 'clone') {
      if (!ctx.cloneBaseSha) return impossible('no_snapshot')
      const out = await runGit(ctx, ['checkout', '--detach', ctx.cloneBaseSha])
      if (out.unavailable) return impossible('git_unavailable')
      if (out.timedOut) return impossible('timeout')
      if (out.code !== 0) return impossible(`git_failed:${out.code ?? 'null'};${out.stderr}`)
      ctx.rolledBack = true
      ctx.installedVersion = ctx.snapshot?.version ?? null
      await finish(ctx, step, 'rolled_back', 'rolled_back', `head:${shortSha(ctx.cloneBaseSha)};version:${ctx.installedVersion ?? 'unknown'}`)
      return true
    }
    const snapshot = ctx.snapshot
    if (!snapshot) return impossible('no_snapshot')
    if (snapshot.installPath) {
      const pluginJson = await readText(ctx, joinLike(snapshot.installPath, '.claude-plugin', 'plugin.json'))
      if (pluginJson === null) {
        // The previous version's directory is gone, swept by Claude Code (superseded generations
        // carry .orphaned_at, and .last_inuse_sweep sits beside them). Local rollback cannot
        // proceed. Until now that was where this stopped: a dead end with nothing said about what
        // would actually recover the machine. Say it, and name the version, so the person or the
        // server reading this ledger knows the next move.
        ctx.log(
          describeRollbackRecovery({
            knownGood: readKnownGood({ home: ctx.home }),
            // The version RUNNING, not the one this run was trying to install. targetVersion is
            // the update that just failed, so naming it here told a reader to revert to the release
            // they were escaping from.
            current: snapshot.version ?? null,
          }),
        )
        return impossible('install_path_missing')
      }
      const version = parseJsonSafe(pluginJson)?.version
      if (snapshot.version && version !== snapshot.version) return impossible(`install_path_version_mismatch:${version ?? 'none'}`)
    }
    const restored = []
    for (const file of snapshot.files) {
      if (file.absent) {
        if (await ctx.fs.exists(file.source)) {
          await removeFile(ctx, file.source)
          restored.push(`${file.name}(removed)`)
        }
        continue
      }
      await copyFile(ctx, file.copy, file.source)
      restored.push(file.name)
    }
    ctx.rolledBack = true
    ctx.installedVersion = snapshot.version
    const alias = await refreshAlias(ctx, snapshot.installPath)
    await finish(ctx, step, 'rolled_back', 'rolled_back', `restored:${restored.join(',') || 'none'};version:${snapshot.version ?? 'none'};${alias}`)
    return true
  } catch (error) {
    return impossible(`error:${errorMessage(error)}`)
  }
}

// -- Install steps -----------------------------------------------------------

/**
 * uninstall -y (not_installed is fine) then install -y, then the files must
 * show the target version. Reports `step` itself (plan-level repair or an
 * inline `<id>.reinstall`).
 */
async function reinstallCore(ctx, step) {
  await begin(ctx, step)
  const removed = await runCli(ctx, uninstallArgs(), classifyUninstall, 'network')
  if (removed.kind !== 'uninstalled' && removed.kind !== 'not_installed') {
    await finish(ctx, step, 'failed', removed.reason ?? 'cli_failed:null', `uninstall;${removed.detail}`)
    return { ok: false, reason: removed.reason ?? 'cli_failed:null' }
  }
  const installed = await runCli(ctx, installArgs(), classifyInstall, 'network')
  if (installed.kind !== 'installed' && installed.kind !== 'already') {
    await finish(ctx, step, 'failed', installed.reason ?? 'cli_failed:null', `install;${installed.detail}`)
    return { ok: false, reason: installed.reason ?? 'cli_failed:null' }
  }
  const observed = await observeFiles(ctx)
  const version = observed.installed.version
  if (ctx.targetVersion && version !== ctx.targetVersion) {
    await finish(ctx, step, 'failed', 'version_mismatch', `installed:${version ?? 'none'};target:${ctx.targetVersion}`)
    return { ok: false, reason: 'version_mismatch' }
  }
  ctx.installedVersion = version
  await finish(ctx, step, 'ok', 'reinstalled', `uninstall:${removed.kind};install:${installed.kind};version:${version ?? 'unknown'}`)
  return { ok: true, reason: null }
}

/**
 * verify_installed: the installed version must equal the target; on
 * success the alias is refreshed. Reports `step`. Returns {ok, reason}.
 */
async function checkInstalled(ctx, step) {
  await begin(ctx, step)
  const observed = await observeInstalledVersion(ctx)
  if (ctx.targetVersion === null) {
    await finish(ctx, step, 'failed', 'marketplace_latest_unknown', `installed:${observed.version ?? 'none'};source:${observed.source}`)
    return { ok: false, reason: 'marketplace_latest_unknown' }
  }
  if (ctx.reobserve) {
    // A partial plan (the planner could not read the latest version): this
    // step only records what is installed; executeWithReobserve observes and
    // plans again. An older version here is the reason to re-plan, not a
    // failure, so nothing escalates and no alias moves.
    if (!observed.version) {
      await finish(ctx, step, 'failed', 'not_installed', `source:${observed.source}`)
      return { ok: false, reason: 'not_installed' }
    }
    ctx.installedVersion = observed.version
    const same = observed.version === ctx.targetVersion
    await finish(ctx, step, 'ok', same ? 'verified' : 'observed', `installed:${observed.version};latest:${ctx.targetVersion};source:${observed.source}`)
    return { ok: true, reason: null }
  }
  if (observed.version === ctx.targetVersion) {
    ctx.installedVersion = observed.version
    const alias = ctx.installMethod === 'marketplace' ? await refreshAlias(ctx, observed.installPath) : 'alias:untouched(clone)'
    await finish(ctx, step, 'ok', 'verified', `version:${observed.version};source:${observed.source};${alias}`)
    return { ok: true, reason: null }
  }
  await finish(ctx, step, 'failed', 'version_mismatch', `installed:${observed.version ?? 'none'};target:${ctx.targetVersion};source:${observed.source}`)
  return { ok: false, reason: 'version_mismatch' }
}

/**
 * Apply a step's onFailure policy after the step has been reported failed.
 *   continue  the run goes on (the failure is noted, first one wins)
 *   stop      the run aborts here
 *   escalate  marketplace: the inline reinstall ladder once, then rollback
 *   rollback  verify_installed on a marketplace install takes the ladder
 *             once too (a wrong version after a "successful" CLI run);
 *             everything else rolls back directly
 * `marketplace_latest_unknown` always stops: there is nothing to reinstall
 * towards and nothing to roll back from.
 */
async function handleFailure(ctx, step, reason) {
  let policy = typeof step.onFailure === 'string' ? step.onFailure : 'stop'
  if (reason === 'marketplace_latest_unknown') policy = 'stop'
  if (policy === 'continue') {
    noteFailure(ctx, step, reason)
    return
  }
  if (policy === 'stop') {
    abort(ctx, step, reason)
    return
  }
  const ladder =
    ctx.installMethod === 'marketplace' &&
    !ctx.escalated &&
    (policy === 'escalate' || step.kind === 'verify_installed')
  if (ladder) {
    ctx.escalated = true
    const reinstalled = await reinstallCore(ctx, inlineStep(step, 'reinstall', 'reinstall_plugin'))
    if (reinstalled.ok) {
      if (step.kind !== 'verify_installed') return
      const again = await checkInstalled(ctx, inlineStep(step, 'verify', 'verify_installed'))
      if (again.ok) return
    }
  }
  await rollbackCore(ctx, inlineStep(step, 'rollback', 'rollback'))
  abort(ctx, step, reason)
}

async function registerMarketplaceStep(ctx, step) {
  await begin(ctx, step)
  const out = await runCli(ctx, marketplaceAddArgs(), classifyMarketplaceAdd, 'network')
  if (out.kind === 'registered' || out.kind === 'already') {
    await finish(ctx, step, 'ok', out.kind, out.detail)
    return
  }
  await finish(ctx, step, 'failed', out.reason, out.detail)
  await handleFailure(ctx, step, out.reason)
}

async function refreshMarketplaceStep(ctx, step) {
  await begin(ctx, step)
  const out = await runCli(ctx, marketplaceUpdateArgs(), classifyMarketplaceUpdate, 'network')
  const refreshed = out.kind === 'updated'
  if (ctx.installMethod === 'marketplace') {
    const observed = await observeFiles(ctx)
    const latest = validSemver(observed.marketplaceLatest?.version)
    if (ctx.targetVersion === null) {
      // The planner could not read a latest version; re-observe now that the
      // marketplace has (maybe) been refreshed. Still unknown is a hard stop.
      if (!latest) {
        await finish(ctx, step, 'failed', 'marketplace_latest_unknown', refreshed ? 'marketplace.json unreadable after refresh' : out.detail)
        await handleFailure(ctx, step, 'marketplace_latest_unknown')
        return
      }
      ctx.targetVersion = latest
    } else if (latest && latest !== ctx.targetVersion) {
      // The plan pinned its target from the index as it was BEFORE this
      // refresh. When the refreshed index names a newer same-major version,
      // that is what `claude plugin update` will install; chasing the stale
      // pin would make verify_installed roll a good update back
      // (adversarial pass 1). Adopt the real latest and say so in the detail.
      const pinned = parseSemver(ctx.targetVersion)
      const found = parseSemver(latest)
      if (pinned && found && found.major === pinned.major && compareSemver(found, pinned) > 0) {
        ctx.targetAdvancedFrom = ctx.targetVersion
        ctx.targetVersion = latest
      }
    }
  }
  if (refreshed) {
    const advanced = ctx.targetAdvancedFrom ? `;target_advanced:${ctx.targetAdvancedFrom}->${ctx.targetVersion}` : ''
    await finish(ctx, step, 'ok', 'updated', `latest:${ctx.targetVersion ?? 'unknown'}${advanced}`)
    return
  }
  // ok with a warning: the local marketplace.json is usually still usable.
  await finish(ctx, step, 'ok', 'refresh_failed', `${out.reason};${out.detail}`)
}

async function installPluginStep(ctx, step) {
  await begin(ctx, step)
  const out = await runCli(ctx, installArgs(), classifyInstall, 'network')
  if (out.kind === 'installed' || out.kind === 'already') {
    await finish(ctx, step, 'ok', out.kind, out.detail)
    return
  }
  await finish(ctx, step, 'failed', out.reason, out.detail)
  await handleFailure(ctx, step, out.reason)
}

async function updatePluginStep(ctx, step) {
  await begin(ctx, step)
  const out = await runCli(ctx, updateArgs(), classifyUpdate, 'network')
  if (out.kind === 'updated') {
    await finish(ctx, step, 'ok', 'updated', out.detail)
    return
  }
  if (out.kind === 'already_latest') {
    const observed = await observeFiles(ctx)
    const version = observed.installed.version
    if (version && version === ctx.targetVersion) {
      ctx.installedVersion = version
      await finish(ctx, step, 'ok', 'already_latest', `version:${version}`)
      return
    }
    await finish(ctx, step, 'failed', 'version_mismatch', `installed:${version ?? 'none'};target:${ctx.targetVersion ?? 'unknown'}`)
    await handleFailure(ctx, step, 'version_mismatch')
    return
  }
  await finish(ctx, step, 'failed', out.reason, out.detail)
  await handleFailure(ctx, step, out.reason)
}

async function reinstallPluginStep(ctx, step) {
  // A plan-level reinstall IS the ladder's rung: a failure rolls back directly.
  ctx.escalated = true
  const out = await reinstallCore(ctx, step)
  if (!out.ok) await handleFailure(ctx, step, out.reason)
}

async function gitFastForwardStep(ctx, step) {
  await begin(ctx, step)
  const fail = async (reason, detail) => {
    await finish(ctx, step, 'failed', reason, detail)
    await handleFailure(ctx, step, reason)
  }
  if (typeof ctx.deps.git !== 'function' || !ctx.pluginRoot) return fail('git_unavailable', 'no git runner or plugin root')
  if (!ctx.cloneBaseSha) {
    const head = await runGit(ctx, ['rev-parse', 'HEAD'])
    ctx.cloneBaseSha = !head.timedOut && head.code === 0 ? head.stdout.trim() : null
  }
  const fetched = await runGit(ctx, ['fetch', '--quiet', 'origin', 'main'])
  if (fetched.timedOut) return fail('timeout', `fetch;timeout:${ctx.timeouts.network}ms`)
  if (fetched.code !== 0) return fail(`git_failed:${fetched.code ?? 'null'}`, `fetch;${fetched.stderr}`)
  const target = typeof ctx.deps.clone?.targetCommit === 'string' && ctx.deps.clone.targetCommit ? ctx.deps.clone.targetCommit : 'origin/main'
  const merged = await runGit(ctx, ['merge', '--ff-only', target])
  if (merged.timedOut) return fail('timeout', `merge;timeout:${ctx.timeouts.network}ms`)
  if (merged.code !== 0) return fail(`git_failed:${merged.code ?? 'null'}`, `merge;${merged.stderr}`)
  const head = await runGit(ctx, ['rev-parse', 'HEAD'])
  const sha = !head.timedOut && head.code === 0 ? head.stdout.trim() : ''
  await finish(ctx, step, 'ok', 'fast_forwarded', `from:${shortSha(ctx.cloneBaseSha)};to:${shortSha(sha)}`)
}

// -- Agent steps -------------------------------------------------------------

function agentFor(ctx, target) {
  const id = String(target ?? '')
  const known = ctx.agents.find((agent) => String(agent?.assistantId ?? '') === id)
  return known ?? { assistantId: id, cwd: null }
}

async function restartOnce(ctx, agent, via) {
  const restartedAtMs = ctx.now()
  if (typeof ctx.deps.restartAgent !== 'function') {
    return { ok: false, reason: 'restart_failed', detail: 'no restartAgent dependency', restartedAtMs }
  }
  const raced = await withDeadline(() => ctx.deps.restartAgent(agent, { via: via ?? null, restartedAtMs }), ctx.timeouts.restart, ctx.timers)
  if (raced.timedOut) return { ok: false, reason: 'timeout', detail: `timeout:${ctx.timeouts.restart}ms`, restartedAtMs }
  if ('error' in raced) return { ok: false, reason: 'restart_failed', detail: errorMessage(raced.error), restartedAtMs }
  const out = raced.value
  if (!out || out.ok !== true) {
    return { ok: false, reason: 'restart_failed', detail: `${out?.how ?? 'unknown'};${out?.message ?? 'no message'}`, restartedAtMs }
  }
  return { ok: true, reason: null, detail: `how:${out.how ?? via ?? 'unknown'}`, restartedAtMs }
}

async function verifyOnce(ctx, agent, restartedAtMs) {
  if (typeof ctx.deps.verifyAgent !== 'function') return { ok: false, detail: 'no verifyAgent dependency' }
  const raced = await withDeadline(
    () => ctx.deps.verifyAgent(agent, { restartedAtMs, timeoutMs: ctx.verifyTimeoutMs }),
    deadlineFor(ctx.verifyTimeoutMs),
    ctx.timers,
  )
  if (raced.timedOut) return { ok: false, detail: `timeout:${ctx.verifyTimeoutMs}ms` }
  if ('error' in raced) return { ok: false, detail: errorMessage(raced.error) }
  const out = raced.value
  const evidence = `${out?.evidence ?? ''} ${out?.message ?? ''}`.trim()
  if (out && out.ok === true) return { ok: true, detail: evidence || 'live' }
  return { ok: false, detail: evidence || 'no_evidence' }
}

async function restartAgentStep(ctx, step) {
  const agent = agentFor(ctx, step.target)
  await begin(ctx, step)
  if (ctx.restartCount > 0 && ctx.staggerMs > 0) await ctx.sleep(ctx.staggerMs)
  const out = await restartOnce(ctx, agent, step.via)
  ctx.restartCount += 1
  ctx.restarts.set(String(step.target), { restartedAtMs: out.restartedAtMs, ok: out.ok })
  if (out.ok) {
    await finish(ctx, step, 'ok', 'restarted', out.detail)
    return
  }
  await finish(ctx, step, 'failed', out.reason, out.detail)
  await handleFailure(ctx, step, out.reason)
}

async function verifyAgentStep(ctx, step) {
  const agent = agentFor(ctx, step.target)
  const prior = ctx.restarts.get(String(step.target))
  if (prior && !prior.ok) {
    // Nothing restarted, so there is nothing a liveness marker could prove.
    await skip(ctx, step, 'restart_failed')
    return
  }
  await begin(ctx, step)
  const since = prior?.restartedAtMs ?? ctx.startedAt
  const proof = await verifyOnce(ctx, agent, since)
  if (proof.ok) {
    await finish(ctx, step, 'ok', 'live', proof.detail)
    return
  }
  const policy = typeof step.onFailure === 'string' ? step.onFailure : 'stop'
  const token = policy === 'rollback' || policy === 'escalate' ? 'agent_deaf_after_update' : 'agent_deaf_after_restart'
  await finish(ctx, step, 'failed', token, proof.detail)
  if (policy === 'continue') {
    noteFailure(ctx, step, token)
    return
  }
  if (policy === 'stop') {
    abort(ctx, step, token)
    return
  }
  if (ctx.rolledBack) {
    // Already on the restored version; the first deaf agent named the cause.
    noteFailure(ctx, step, token)
    return
  }
  const restored = await rollbackCore(ctx, inlineStep(step, 'rollback', 'rollback'))
  ctx.failedStep = failedStepOf(step, token)
  if (!restored) {
    ctx.aborted = true
    return
  }
  // One more chance on the rolled-back version, then on to the other agents.
  const retry = inlineStep(step, 'retry', 'verify_agent')
  await begin(ctx, retry)
  const again = await restartOnce(ctx, agent, step.via)
  ctx.restarts.set(String(step.target), { restartedAtMs: again.restartedAtMs, ok: again.ok })
  if (!again.ok) {
    await finish(ctx, retry, 'failed', again.reason, `restart;${again.detail}`)
    return
  }
  const proofAgain = await verifyOnce(ctx, agent, again.restartedAtMs)
  if (proofAgain.ok) await finish(ctx, retry, 'ok', 'live', `${again.detail};${proofAgain.detail}`)
  else await finish(ctx, retry, 'failed', 'agent_deaf_after_rollback', proofAgain.detail)
}

// -- Dispatcher --------------------------------------------------------------

async function runStep(ctx, step) {
  switch (step.kind) {
    case 'snapshot':
      return snapshotStep(ctx, step)
    case 'register_marketplace':
      return registerMarketplaceStep(ctx, step)
    case 'refresh_marketplace':
      return refreshMarketplaceStep(ctx, step)
    case 'install_plugin':
      return installPluginStep(ctx, step)
    case 'update_plugin':
      return updatePluginStep(ctx, step)
    case 'reinstall_plugin':
      return reinstallPluginStep(ctx, step)
    case 'git_fast_forward':
      return gitFastForwardStep(ctx, step)
    case 'verify_installed': {
      const out = await checkInstalled(ctx, step)
      if (!out.ok) await handleFailure(ctx, step, out.reason)
      return
    }
    case 'restart_agent':
      return restartAgentStep(ctx, step)
    case 'verify_agent':
      return verifyAgentStep(ctx, step)
    case 'manual_restart_required':
      return skip(ctx, step, 'manual_restart_required', step.why)
    case 'stage_pending_restart':
      await begin(ctx, step)
      return finish(ctx, step, 'ok', 'staged', 'staged')
    case 'refresh_watcher':
      await begin(ctx, step)
      return finish(ctx, step, 'ok', 'deferred', 'deferred')
    case 'rollback': {
      // A plan never carries one today; if it ever does, it only runs when
      // a failure is pending, which the inline ladder already handled.
      await skip(ctx, step, 'not_needed')
      return
    }
    default: {
      await begin(ctx, step)
      await finish(ctx, step, 'failed', 'unknown_step_kind', String(step.kind))
      abort(ctx, step, 'unknown_step_kind')
    }
  }
}

function finalize(ctx, extra = {}) {
  const verdict = ctx.rolledBack ? 'rolled_back' : ctx.failedStep ? 'failed' : 'done'
  return {
    ok: verdict === 'done',
    verdict,
    ...extra,
    failedStep: ctx.failedStep,
    rolledBack: ctx.rolledBack,
    targetVersion: ctx.targetVersion,
    installedVersion: ctx.installedVersion,
    steps: ctx.steps.map((record) => ({ ...record })),
  }
}

/**
 * Run a plan. Never throws: an unexpected error inside a step becomes that
 * step's `internal_error` failure and the run stops there.
 * @param {{ verdict: string, reason?: string, targetVersion: string|null, steps: Array<{ id: string, kind: string, target?: string, via?: string, onFailure?: string, why?: string }> }} plan
 * @param {ExecutorDeps} deps
 * @param {ReportFn} [report]
 * @param {{ idPrefix?: string }} [opts]   idPrefix is prepended to every step id (executeWithReobserve uses `r2-`)
 * @returns {Promise<ExecuteResult>}
 */
export async function executePlan(plan, deps, report, opts = {}) {
  const idPrefix = typeof opts?.idPrefix === 'string' ? opts.idPrefix : ''
  const ctx = makeContext(plan ?? {}, deps ?? {}, report)
  ctx.reobserve = plan?.reobserve === true
  if (!plan || typeof plan !== 'object') {
    return { ok: false, verdict: 'blocked', reason: 'invalid_plan', failedStep: null, rolledBack: false, targetVersion: null, installedVersion: null, steps: [] }
  }
  if (plan.verdict === 'blocked') {
    return { ok: false, verdict: 'blocked', reason: String(plan.reason ?? 'blocked'), failedStep: null, rolledBack: false, targetVersion: ctx.targetVersion, installedVersion: null, steps: [] }
  }
  const steps = Array.isArray(plan.steps) ? plan.steps : []
  if (plan.verdict === 'nothing_to_do' || steps.length === 0) {
    return { ok: true, verdict: 'nothing_to_do', failedStep: null, rolledBack: false, targetVersion: ctx.targetVersion, installedVersion: null, steps: [] }
  }
  if (!ctx.fs || typeof ctx.deps.cli !== 'function') {
    return { ok: false, verdict: 'blocked', reason: 'missing_dependencies', failedStep: null, rolledBack: false, targetVersion: ctx.targetVersion, installedVersion: null, steps: [] }
  }
  ctx.log(`run start: ${steps.length} steps, target ${ctx.targetVersion ?? 'unknown'}, method ${ctx.installMethod}`)
  const runSteps = steps.map((raw, index) => {
    const step = raw && typeof raw === 'object' ? { ...raw } : { kind: 'invalid' }
    const bareId = typeof step.id === 'string' && step.id ? step.id : `s${String(index + 1).padStart(2, '0')}-${step.kind}`
    step.id = `${idPrefix}${bareId}`
    return step
  })
  for (const step of runSteps) {
    if (ctx.aborted) {
      await skip(ctx, step, 'not_reached')
      continue
    }
    if (ctx.rolledBack && !POST_ROLLBACK_STEP_KINDS.includes(step.kind)) {
      await skip(ctx, step, 'rolled_back')
      continue
    }
    if (!STEP_KINDS.includes(step.kind)) {
      await begin(ctx, step)
      await finish(ctx, step, 'failed', 'unknown_step_kind', String(step.kind))
      abort(ctx, step, 'unknown_step_kind')
      continue
    }
    try {
      await runStep(ctx, step)
    } catch (error) {
      ctx.log(`step ${step.id} threw: ${scrubDetail(errorMessage(error), ctx.home)}`)
      await finish(ctx, step, 'failed', 'internal_error', errorMessage(error))
      abort(ctx, step, 'internal_error')
    }
  }
  const result = finalize(ctx)
  ctx.log(`run end: ${result.verdict}${result.failedStep ? ` (${result.failedStep.id} ${result.failedStep.message})` : ''}`)
  return result
}

// -- Observe, plan, execute, re-observe --------------------------------------

/**
 * @typedef {ExecuteResult & { rounds: number, reobserved: boolean }} ReconcileResult
 */

/**
 * The full loop the watcher and the daemon run: observe the machine, plan,
 * execute, and when the planner returned a PARTIAL plan (`reobserve: true`:
 * the marketplace's latest version was unreadable, so the plan only
 * registers/refreshes and records what is installed), observe and plan again
 * now that the refresh has run. Round 2 step ids are prefixed `r2-` so the
 * checklist stays unique across rounds and `steps` carries both rounds.
 * At most `maxRounds` plans are executed; a partial plan coming back a
 * second time is the failure `marketplace_latest_unknown` (not executed:
 * refreshing again would change nothing).
 * @param {{ observe: () => any, deps: ExecutorDeps, report?: ReportFn, maxRounds?: number, planner?: (state: any) => any }} opts
 * @returns {Promise<ReconcileResult>}
 */
export async function executeWithReobserve({ observe, deps, report, maxRounds = 2, planner = planMachine }) {
  const now = typeof deps?.now === 'function' ? deps.now : Date.now
  const home = String(deps?.home ?? '')
  const safeReport = async (stepId, payload) => {
    if (typeof report !== 'function') return
    try {
      await report(stepId, payload)
    } catch {
      /* reporting never derails the run */
    }
  }
  /** @type {StepRecord[]} */
  const steps = []
  let executed = 0
  let last = null
  const limit = Number.isInteger(maxRounds) && maxRounds > 0 ? maxRounds : 2
  for (let round = 1; round <= limit; round++) {
    const state = await observe()
    const plan = planner(state)
    const partial = plan?.reobserve === true
    if (partial && round > 1) break
    const result = await executePlan(plan, deps, report, { idPrefix: round === 1 ? '' : `r${round}-` })
    executed += 1
    last = result
    steps.push(...result.steps)
    if (!partial) {
      // A full plan after a partial one: round 1 did real work (registered or
      // refreshed the marketplace), so nothing_to_do here still reads as done.
      const verdict = round > 1 && result.verdict === 'nothing_to_do' ? 'done' : result.verdict
      return { ...result, ok: verdict === 'done' || verdict === 'nothing_to_do', verdict, steps, rounds: executed, reobserved: round > 1 }
    }
    if (!result.ok) return { ...result, steps, rounds: executed, reobserved: false }
  }
  // The planner still could not read the latest version after a refresh.
  const at = now()
  const id = `r${executed + 1}-plan`
  const detail = scrubDetail('planner asked to re-observe again after a refresh', home)
  steps.push({ id, kind: 'verify_installed', state: 'failed', message: 'marketplace_latest_unknown', detail, startedAt: at, endedAt: at })
  await safeReport(id, { state: 'failed', message: 'marketplace_latest_unknown', detail })
  return {
    ok: false,
    verdict: 'failed',
    failedStep: { id, kind: 'verify_installed', message: 'marketplace_latest_unknown' },
    rolledBack: last?.rolledBack === true,
    targetVersion: null,
    installedVersion: last?.installedVersion ?? null,
    steps,
    rounds: executed,
    reobserved: true,
  }
}
