/**
 * plugin-cli: the adapter between BGOS lifecycle code and the `claude plugin`
 * command line (marketplace add / update, plugin install / update / uninstall
 * / list) for a MARKETPLACE install of the hoai plugin.
 *
 * Three layers, each testable on its own:
 *
 *   1. Command builders: the exact argv for every operation, in one place, so
 *      the executor, the watcher, and the sandbox scenarios agree on the
 *      spelling (`-y` on install / update / uninstall because the daemon runs
 *      with no TTY; user scope, always).
 *   2. runClaudeCli: spawn the CLI non-interactively (stdin ignored, CI=1,
 *      bounded by a timeout, win32 candidate chain mirrored from
 *      bin/hoai-core.mjs claudeSpawnCandidates) and NEVER throw: a missing
 *      binary is `{code: 127}`, a hang is `{timedOut: true, code: null}`.
 *      The runner is injectable so tests drive a scripted fake CLI.
 *   3. Pure classifiers and readers: stdout + stderr + rc in, a small verdict
 *      out. Every phrase below was read off Claude Code 2.1.241 (design
 *      section 0 probe + the binary's own message templates). Output the
 *      classifier does not recognise with rc 0 is `garbage`, never a
 *      success: the executor then decides from the files, not from prose.
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe (the CLI block at
 * the bottom only runs when executed directly) because the same file serves
 * server.ts (bun), the watcher bundle (bare node) and the node:test suite.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

import { claudeConfigDir, isRunAsMain, parsePath } from '../bin/bgos-install-method.mjs'

/** GitHub `owner/repo` the hoai marketplace is registered from. */
export const HOAI_MARKETPLACE_SOURCE = 'BrandGrowthOS/hoai-marketplace'
/** The marketplace name Claude Code registers it under. */
export const HOAI_MARKETPLACE = 'hoai'
/** The plugin's name inside that marketplace. */
export const HOAI_PLUGIN_NAME = 'hoai'
/** The fully qualified plugin id (`<plugin>@<marketplace>`). */
export const HOAI_PLUGIN_ID = 'hoai@hoai'
/** Budget for commands that touch the network (marketplace add / update,
 *  install, update, uninstall). */
export const NETWORK_TIMEOUT_MS = 180_000
/** Budget for the local-only `plugin list --json`. */
export const LIST_TIMEOUT_MS = 30_000
/** The exit code reported when the claude binary itself could not be run. */
export const CLI_NOT_FOUND_EXIT_CODE = 127
/** Strict semver (no prerelease, no build metadata), same shape as
 *  lib/self-update.ts parseSemver. */
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

const MESSAGE_MAX_CHARS = 200
const CLAUDE_NOT_FOUND_MESSAGE =
  'claude was not found on this machine. Install Claude Code (claude.ai/code) and make sure the claude command is on PATH.'

// -- Types -------------------------------------------------------------------

/**
 * What one CLI invocation produced.
 * @typedef {object} CliResult
 * @property {number|null} code   exit code; null when killed (timeout / signal) or never started
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut   true when the budget expired and the child was killed
 */

/**
 * @typedef {object} CliRunOptions
 * @property {number} timeoutMs                          the budget for this invocation
 * @property {Record<string, string|undefined>} env      the FULL child environment (process.env merged, CI=1)
 */

/**
 * An injectable runner: receives the claude argv (without the `claude`
 * word) and resolves with a (possibly partial) result. May throw; the
 * caller normalises.
 * @typedef {(args: string[], opts: CliRunOptions) => Promise<Partial<CliResult>>} CliRunner
 */

/**
 * A spawn-compatible function (node:child_process.spawn or a test double
 * returning an EventEmitter-like child with stdout / stderr / kill).
 * @typedef {(file: string, args: string[], opts: object) => any} SpawnLike
 */

/**
 * @typedef {object} SpawnCollectResult
 * @property {number|null} code
 * @property {string|null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 * @property {(Error & { code?: string })|null} spawnError   set when the child could not be started
 */

/**
 * @typedef {object} SpawnCandidate
 * @property {string} file
 * @property {string[]} args
 * @property {number[]} notFoundExitCodes   exit codes that mean "try the next candidate"
 */

/** @typedef {{ kind: 'registered'|'already'|'failed'|'garbage', message: string }} MarketplaceAddVerdict */
/** @typedef {{ kind: 'updated'|'failed'|'garbage', message: string }} MarketplaceUpdateVerdict */
/** @typedef {{ kind: 'installed'|'already'|'failed'|'garbage', message: string }} InstallVerdict */
/**
 * `updated` carries the versions the CLI printed ("updated from A to B"),
 * `already_latest` carries the version it named ("already at the latest
 * version (V)"); the other fields are null when the line did not say.
 * @typedef {object} UpdateVerdict
 * @property {'updated'|'already_latest'|'failed'|'garbage'} kind
 * @property {string} message
 * @property {string|null} fromVersion
 * @property {string|null} toVersion
 * @property {string|null} version
 */
/** @typedef {{ kind: 'uninstalled'|'not_installed'|'failed'|'garbage', message: string }} UninstallVerdict */

/**
 * One row of `claude plugin list --json`, normalised.
 * @typedef {object} PluginListEntry
 * @property {string} id
 * @property {string|null} version
 * @property {string|null} installPath
 * @property {string|null} scope
 * @property {boolean|null} enabled
 */

/**
 * The release the marketplace declares for the plugin: `version` is strict
 * semver (leading v stripped); `ref` is the git ref the entry's source names
 * (null for a plain path source).
 * @typedef {{ version: string, ref: string|null }} MarketplaceLatest
 */

/**
 * @typedef {object} MarketplaceObservation
 * @property {boolean} marketplaceRegistered                 hoai present in known_marketplaces.json
 * @property {string|null} marketplaceInstallLocation        known_marketplaces.json hoai.installLocation (a directory source lives outside the config dir)
 * @property {MarketplaceLatest|null} marketplaceLatest       the version the marketplace currently declares
 * @property {{ present: boolean, version: string|null, installPath: string|null }} installed
 * @property {boolean} enabled                               settings.json enabledPlugins['hoai@hoai'] === true
 */

/**
 * @typedef {object} MarketplaceConfigPaths
 * @property {string} configDir
 * @property {string} knownMarketplaces
 * @property {string} marketplaceJson
 * @property {string} installedPlugins
 * @property {string} settings
 * @property {string} cacheDir
 */

// -- Command builders --------------------------------------------------------

/** `claude plugin marketplace add BrandGrowthOS/hoai-marketplace` */
export function marketplaceAddArgs() {
  return ['plugin', 'marketplace', 'add', HOAI_MARKETPLACE_SOURCE]
}

/** `claude plugin marketplace update hoai` */
export function marketplaceUpdateArgs() {
  return ['plugin', 'marketplace', 'update', HOAI_MARKETPLACE]
}

/** `claude plugin install hoai@hoai --scope user -y` */
export function installArgs() {
  return ['plugin', 'install', HOAI_PLUGIN_ID, '--scope', 'user', '-y']
}

/** `claude plugin update hoai@hoai --scope user -y` */
export function updateArgs() {
  return ['plugin', 'update', HOAI_PLUGIN_ID, '--scope', 'user', '-y']
}

/** `claude plugin uninstall hoai@hoai --scope user -y` */
export function uninstallArgs() {
  return ['plugin', 'uninstall', HOAI_PLUGIN_ID, '--scope', 'user', '-y']
}

/** `claude plugin list --json` */
export function listJsonArgs() {
  return ['plugin', 'list', '--json']
}

/** True for `plugin list ...`, the only local-only command. */
export function isListCommand(args) {
  return Array.isArray(args) && args[0] === 'plugin' && args[1] === 'list'
}

/**
 * The default budget for an argv: LIST_TIMEOUT_MS for list, NETWORK_TIMEOUT_MS
 * for everything else.
 * @param {string[]} args
 */
export function defaultTimeoutMs(args) {
  return isListCommand(args) ? LIST_TIMEOUT_MS : NETWORK_TIMEOUT_MS
}

// -- Small helpers -----------------------------------------------------------

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Any value as text: strings as is, Buffers decoded, nullish as ''. */
function toText(value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return String(value)
}

/** @param {unknown} error */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error ?? 'unknown error')
}

/** @param {unknown} text */
function parseJsonSafe(text) {
  try {
    return JSON.parse(toText(text))
  } catch {
    return undefined
  }
}

/** ESC, built from its code so the source holds no control byte. */
const ESC = String.fromCharCode(0x1b)
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g')

/** Strip ANSI escape sequences. */
function stripAnsi(text) {
  return text.replace(ANSI_RE, '')
}

/** Drop control characters (C0 except tab / newline / return, DEL, C1). */
function dropControlChars(text) {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue
    if (code >= 0x7f && code <= 0x9f) continue
    out += ch
  }
  return out
}

/**
 * One short line from CLI output, fit for a progress message: ANSI and
 * control bytes removed, the leading status glyph dropped, the first
 * non-empty line kept, whitespace collapsed, capped at 200 characters.
 * @param {unknown} text
 * @param {number} [max]
 */
export function scrubOneLiner(text, max = MESSAGE_MAX_CHARS) {
  const clean = dropControlChars(stripAnsi(toText(text)))
  for (const line of clean.split(/\r?\n/)) {
    const one = line
      .replace(/^[\s✔✘✓✗•*-]+/, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (one) return one.length > max ? `${one.slice(0, Math.max(max - 3, 0))}...` : one
  }
  return ''
}

// -- Running the CLI ---------------------------------------------------------

/**
 * Spawn one process, collect its output, and enforce a budget. Resolves,
 * never rejects: a child that cannot start reports `spawnError`; a child
 * that outlives the budget is killed (SIGTERM, then SIGKILL after a grace
 * period) and reports `timedOut: true` with `code: null`.
 * @param {string} file
 * @param {string[]} args
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   timeoutMs?: number,
 *   spawnImpl?: SpawnLike,
 *   cwd?: string,
 *   closeGraceMs?: number,
 *   killGraceMs?: number,
 * }} [opts]
 * @returns {Promise<SpawnCollectResult>}
 */
export function spawnCollect(
  file,
  args,
  { env = process.env, timeoutMs = NETWORK_TIMEOUT_MS, spawnImpl = spawn, cwd, closeGraceMs = 1000, killGraceMs = 5000 } = {},
) {
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    /** @type {Buffer[]} */
    const out = []
    /** @type {Buffer[]} */
    const err = []
    /** @type {ReturnType<typeof setTimeout>[]} */
    const timers = []
    const text = (chunks) => Buffer.concat(chunks).toString('utf8')
    const finish = (result) => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      resolve(result)
    }
    const later = (fn, ms) => {
      const timer = setTimeout(fn, ms)
      if (typeof timer?.unref === 'function') timer.unref()
      timers.push(timer)
    }

    let child
    try {
      child = spawnImpl(file, [...args], {
        env,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      })
    } catch (error) {
      finish({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: /** @type {any} */ (error) })
      return
    }

    child.stdout?.on?.('data', (chunk) => out.push(Buffer.from(chunk)))
    child.stderr?.on?.('data', (chunk) => err.push(Buffer.from(chunk)))
    const done = (code, signal) =>
      finish({
        code: timedOut ? null : typeof code === 'number' ? code : null,
        signal: signal ?? null,
        stdout: text(out),
        stderr: text(err),
        timedOut,
        spawnError: null,
      })
    child.on('error', (error) =>
      finish({ code: null, signal: null, stdout: text(out), stderr: text(err), timedOut, spawnError: error }),
    )
    child.on('close', (code, signal) => done(code, signal))
    // Belt and braces: if a grandchild inherited the pipes, 'close' can lag
    // 'exit' indefinitely. Resolve from 'exit' after a short grace.
    child.on('exit', (code, signal) => later(() => done(code, signal), closeGraceMs))

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      later(() => {
        timedOut = true
        try {
          child.kill('SIGTERM')
        } catch {
          /* already gone */
        }
        later(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }, killGraceMs)
      }, timeoutMs)
    }
  })
}

/**
 * The spawn candidates for `claude <args>`, mirrored from
 * bin/hoai-core.mjs claudeSpawnCandidates (kept in sync by test): a single
 * `claude` on posix; on win32 `claude`, then `cmd /c claude.cmd` (9009 means
 * cmd could not find it), then `claude.exe`.
 * @param {string[]} args
 * @param {string} [platform]
 * @param {Record<string, string|undefined>} [env]
 * @returns {SpawnCandidate[]}
 */
export function claudeCliCandidates(args, platform = process.platform, env = process.env) {
  if (platform !== 'win32') return [{ file: 'claude', args: [...args], notFoundExitCodes: [] }]
  const comspec = String(env?.ComSpec ?? env?.COMSPEC ?? '').trim() || 'cmd.exe'
  return [
    { file: 'claude', args: [...args], notFoundExitCodes: [] },
    { file: comspec, args: ['/c', 'claude.cmd', ...args], notFoundExitCodes: [9009] },
    { file: 'claude.exe', args: [...args], notFoundExitCodes: [] },
  ]
}

/** ENOENT (nothing by that name) or EINVAL (node's .cmd-without-shell guard). */
function spawnErrorMeansNotFound(error) {
  return error?.code === 'ENOENT' || error?.code === 'EINVAL'
}

/**
 * The default runner: walk the candidates, return the first one that
 * actually ran. Any spawn error other than "not found" stops the chain
 * (mirrors hoai-core: a binary that exists but cannot start is a real
 * error, not a reason to try a different spelling).
 * @param {string[]} args
 * @param {{ timeoutMs?: number, env?: Record<string, string|undefined>, platform?: string, spawnImpl?: SpawnLike }} [opts]
 * @returns {Promise<CliResult>}
 */
export async function defaultClaudeRunner(args, { timeoutMs, env = process.env, platform = process.platform, spawnImpl = spawn } = {}) {
  for (const candidate of claudeCliCandidates(args, platform, env)) {
    const result = await spawnCollect(candidate.file, candidate.args, { env, timeoutMs, spawnImpl })
    if (result.spawnError) {
      if (spawnErrorMeansNotFound(result.spawnError)) continue
      return {
        code: CLI_NOT_FOUND_EXIT_CODE,
        stdout: result.stdout,
        stderr: `could not start ${candidate.file}: ${errorMessage(result.spawnError)}`,
        timedOut: false,
      }
    }
    if (!result.timedOut && !result.signal && candidate.notFoundExitCodes.includes(result.code ?? -1)) continue
    return { code: result.code, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut }
  }
  return { code: CLI_NOT_FOUND_EXIT_CODE, stdout: '', stderr: CLAUDE_NOT_FOUND_MESSAGE, timedOut: false }
}

/**
 * Coerce whatever a runner returned into a CliResult.
 * @param {Partial<CliResult>|null|undefined} raw
 * @returns {CliResult}
 */
export function normalizeCliResult(raw) {
  const code = typeof raw?.code === 'number' && Number.isFinite(raw.code) ? raw.code : null
  return { code, stdout: toText(raw?.stdout), stderr: toText(raw?.stderr), timedOut: raw?.timedOut === true }
}

/**
 * Run `claude <args>` non-interactively and resolve with its result. Never
 * rejects: a runner that throws (or a binary that cannot be started) is
 * `{code: 127, stderr: <why>}`, a hang is `{timedOut: true, code: null}`.
 *
 * The child environment is process.env with `env` layered on top and
 * `CI=1` set, so Claude Code never waits on a prompt; stdin is ignored.
 * @param {string[]} args
 * @param {{
 *   runner?: CliRunner,
 *   timeoutMs?: number,
 *   env?: Record<string, string|undefined>,
 *   platform?: string,
 *   spawnImpl?: SpawnLike,
 * }} [opts]
 * @returns {Promise<CliResult>}
 */
export async function runClaudeCli(args, { runner, timeoutMs, env, platform = process.platform, spawnImpl } = {}) {
  const argv = Array.isArray(args) ? args.map((value) => String(value)) : []
  const budget = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs(argv)
  const childEnv = { ...process.env, ...(env ?? {}), CI: '1' }
  try {
    const raw = runner
      ? await runner(argv, { timeoutMs: budget, env: childEnv })
      : await defaultClaudeRunner(argv, { timeoutMs: budget, env: childEnv, platform, spawnImpl })
    return normalizeCliResult(raw)
  } catch (error) {
    return { code: CLI_NOT_FOUND_EXIT_CODE, stdout: '', stderr: errorMessage(error), timedOut: false }
  }
}

// -- Classifiers -------------------------------------------------------------

/** stdout and stderr joined, ANSI stripped, for phrase matching. */
function combined(res) {
  return stripAnsi(`${toText(res?.stdout)}\n${toText(res?.stderr)}`)
}

/** rc 0, not timed out. */
function exitedClean(res) {
  return res?.code === 0 && res?.timedOut !== true
}

/** The first meaningful line, stderr first (that is where failures go),
 *  then stdout. */
function firstLine(res) {
  return scrubOneLiner(res?.stderr) || scrubOneLiner(res?.stdout)
}

/** The first meaningful line, stdout first (that is where successes go). */
function successLine(res) {
  return scrubOneLiner(res?.stdout) || scrubOneLiner(res?.stderr)
}

/** The scrubbed line that carries the verdict (first line matching `re`,
 *  stdout then stderr), else the first meaningful line. */
function lineMatching(res, re) {
  for (const line of combined(res).split(/\r?\n/)) {
    if (re.test(line)) {
      const scrubbed = scrubOneLiner(line)
      if (scrubbed) return scrubbed
    }
  }
  return successLine(res)
}

/** @returns {{ kind: 'failed', message: string }} */
function failed(res, what) {
  if (res?.timedOut === true) return { kind: 'failed', message: `${what} timed out waiting for claude` }
  const line = firstLine(res)
  const code = typeof res?.code === 'number' ? res.code : 'null'
  return { kind: 'failed', message: line || `${what} failed (rc ${code}, no output)` }
}

/** @returns {{ kind: 'garbage', message: string }} */
function garbage(what) {
  return { kind: 'garbage', message: `${what}: claude exited 0 with unrecognised output` }
}

/**
 * `claude plugin marketplace add <source>`: rc 0 "Successfully added
 * marketplace" is `registered`; rc 0 "already on disk" is `already`
 * (idempotent re-run); any other rc 0 is `garbage`; rc != 0 is `failed`.
 * @param {Partial<CliResult>|null|undefined} res
 * @returns {MarketplaceAddVerdict}
 */
export function classifyMarketplaceAdd(res) {
  if (!exitedClean(res)) return failed(res, 'marketplace add')
  const text = combined(res)
  if (/successfully added marketplace/i.test(text)) return { kind: 'registered', message: successLine(res) }
  if (/already on disk|already (?:registered|exists|added)/i.test(text)) return { kind: 'already', message: successLine(res) }
  return garbage('marketplace add')
}

/**
 * `claude plugin marketplace update <name>`: rc 0 "Successfully updated
 * marketplace" (or "No marketplaces needed updating") is `updated`.
 * @param {Partial<CliResult>|null|undefined} res
 * @returns {MarketplaceUpdateVerdict}
 */
export function classifyMarketplaceUpdate(res) {
  if (!exitedClean(res)) return failed(res, 'marketplace update')
  const text = combined(res)
  if (/successfully updated marketplace|no marketplaces needed updating/i.test(text)) {
    return { kind: 'updated', message: successLine(res) }
  }
  return garbage('marketplace update')
}

/**
 * `claude plugin install <id>`: rc 0 "Successfully installed plugin" is
 * `installed`; rc 0 "is already installed" is `already`.
 * @param {Partial<CliResult>|null|undefined} res
 * @returns {InstallVerdict}
 */
export function classifyInstall(res) {
  if (!exitedClean(res)) return failed(res, 'plugin install')
  const text = combined(res)
  if (/successfully installed plugin/i.test(text)) return { kind: 'installed', message: successLine(res) }
  if (/is already installed/i.test(text)) return { kind: 'already', message: successLine(res) }
  return garbage('plugin install')
}

/**
 * `claude plugin update <id>`: rc 0 "already at the latest version (x.y.z)"
 * is `already_latest`; rc 0 "Successfully updated" / "restart required to
 * apply" is `updated`; rc != 0 (for example `Failed to update plugin
 * "nope@hoai": Plugin "nope" not found`) is `failed` with the line kept.
 * @param {Partial<CliResult>|null|undefined} res
 * @returns {UpdateVerdict}
 */
export function classifyUpdate(res) {
  const versions = { fromVersion: null, toVersion: null, version: null }
  if (!exitedClean(res)) return { ...failed(res, 'plugin update'), ...versions }
  const text = combined(res)
  const latest = /already at the latest version(?:\s*\(([^)\s]+)\))?/i.exec(text)
  if (latest) {
    return { kind: 'already_latest', message: lineMatching(res, /already at the latest version/i), ...versions, version: latest[1] ?? null }
  }
  // Real 2.1.241 line: `Plugin "hoai" updated from 0.38.3 to 0.38.4 for scope user. Restart to apply changes.`
  const moved = /updated from (\S+) to (\S+)/i.exec(text)
  if (moved) {
    // Tokens are whitespace-delimited; a sentence-ending "." or ")" is not part of the version.
    const token = (raw) => raw.replace(/[.,;:)\]]+$/, '')
    return { kind: 'updated', message: lineMatching(res, /updated from/i), ...versions, fromVersion: token(moved[1]), toVersion: token(moved[2]) }
  }
  if (/successfully updated|restart required|restart to apply/i.test(text)) {
    return { kind: 'updated', message: lineMatching(res, /successfully updated|restart required|restart to apply/i), ...versions }
  }
  return { ...garbage('plugin update'), ...versions }
}

/**
 * `claude plugin uninstall <id>`: rc 0 "Successfully uninstalled plugin" is
 * `uninstalled`; "not found in installed plugins" / "is not installed"
 * (the CLI exits 1 for these) is the benign `not_installed`.
 * @param {Partial<CliResult>|null|undefined} res
 * @returns {UninstallVerdict}
 */
export function classifyUninstall(res) {
  const text = combined(res)
  if (res?.timedOut !== true && /not found in installed plugins|is not installed/i.test(text)) {
    return { kind: 'not_installed', message: firstLine(res) }
  }
  if (!exitedClean(res)) return failed(res, 'plugin uninstall')
  if (/successfully uninstalled/i.test(text)) return { kind: 'uninstalled', message: successLine(res) }
  return garbage('plugin uninstall')
}

// -- Readers -----------------------------------------------------------------

/** @returns {PluginListEntry} */
function normalizeListEntry(entry) {
  const str = (value) => (typeof value === 'string' && value.trim() ? value : null)
  return {
    id: String(entry.id),
    version: str(entry.version),
    installPath: str(entry.installPath),
    scope: str(entry.scope),
    enabled: typeof entry.enabled === 'boolean' ? entry.enabled : null,
  }
}

/**
 * Parse `claude plugin list --json`. Leading non-JSON lines (warnings) are
 * skipped; the first line starting with `[` that parses as a JSON array
 * wins. Entries without a string `id` are dropped. Anything else is null.
 * @param {unknown} stdout
 * @returns {PluginListEntry[]|null}
 */
export function parsePluginListJson(stdout) {
  const lines = stripAnsi(toText(stdout)).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trimStart().startsWith('[')) continue
    const parsed = parseJsonSafe(lines.slice(i).join('\n'))
    if (parsed === undefined) continue
    if (!Array.isArray(parsed)) return null
    return parsed.filter((entry) => isRecord(entry) && typeof entry.id === 'string').map(normalizeListEntry)
  }
  return null
}

/**
 * The version the hoai marketplace currently declares for the plugin, from
 * `<config>/plugins/marketplaces/hoai/.claude-plugin/marketplace.json`:
 * plugins[].name === 'hoai', source.ref, leading `v` stripped, strict semver.
 * @param {unknown} marketplaceJsonText   the file text (or an already parsed object)
 * @returns {MarketplaceLatest|null}
 */
export function readMarketplaceLatest(marketplaceJsonText) {
  const doc = isRecord(marketplaceJsonText) ? marketplaceJsonText : parseJsonSafe(marketplaceJsonText)
  if (!isRecord(doc) || !Array.isArray(doc.plugins)) return null
  const plugin = doc.plugins.find((entry) => isRecord(entry) && entry.name === HOAI_PLUGIN_NAME)
  if (!isRecord(plugin)) return null
  // The source is `{source:'url', url, ref}` for the real marketplace, the
  // same with a file:// url for the E2E one, or a plain relative path.
  const ref = isRecord(plugin.source) && typeof plugin.source.ref === 'string' && plugin.source.ref.trim() ? plugin.source.ref.trim() : null
  const declared = typeof plugin.version === 'string' ? plugin.version.trim().replace(/^v/, '') : ''
  if (SEMVER_RE.test(declared)) return { version: declared, ref }
  if (!ref) return null
  const fromRef = ref.replace(/^v/, '')
  return SEMVER_RE.test(fromRef) ? { version: fromRef, ref } : null
}

/**
 * The files a marketplace install lives in, joined in the config dir's own
 * separator style (so a posix config dir stays posix on a win32 host and
 * an injected in-memory fs can key on the exact strings).
 * @param {string} configDir
 * @returns {MarketplaceConfigPaths}
 */
export function marketplaceConfigPaths(configDir) {
  const under = (...parts) => joinUnder(configDir, ...parts)
  return {
    configDir: under(),
    knownMarketplaces: under('plugins', 'known_marketplaces.json'),
    marketplaceJson: under('plugins', 'marketplaces', HOAI_MARKETPLACE, '.claude-plugin', 'marketplace.json'),
    installedPlugins: under('plugins', 'installed_plugins.json'),
    settings: under('settings.json'),
    cacheDir: under('plugins', 'cache', HOAI_MARKETPLACE, HOAI_PLUGIN_NAME),
  }
}

/** Join `parts` under `base` in base's own separator style (parsePath). */
function joinUnder(base, ...parts) {
  const { prefix, sep, segments } = parsePath(base)
  return `${prefix}${[...segments, ...parts].join(sep)}`
}

/**
 * The marketplace.json inside a marketplace's install location
 * (`<installLocation>/.claude-plugin/marketplace.json`), joined in the
 * location's own separator style.
 * @param {string} installLocation
 */
export function marketplaceJsonPathFor(installLocation) {
  return joinUnder(installLocation, '.claude-plugin', 'marketplace.json')
}

/**
 * The hoai@hoai entry of installed_plugins.json: version 2 keeps an array of
 * installs per id (user scope preferred); an older single-object shape is
 * tolerated. Never throws.
 * @param {unknown} doc
 * @returns {{ present: boolean, version: string|null, installPath: string|null }}
 */
export function installedEntryFrom(doc) {
  const absent = { present: false, version: null, installPath: null }
  if (!isRecord(doc) || !isRecord(doc.plugins)) return absent
  const raw = doc.plugins[HOAI_PLUGIN_ID]
  let entry = null
  if (Array.isArray(raw)) {
    const records = raw.filter(isRecord)
    entry = records.find((item) => item.scope === 'user') ?? records[0] ?? null
  } else if (isRecord(raw)) {
    entry = raw
  }
  if (!entry) return absent
  const str = (value) => (typeof value === 'string' && value.trim() ? value : null)
  return { present: true, version: str(entry.version), installPath: str(entry.installPath) }
}

function defaultReadFile(path) {
  return readFileSync(path, 'utf8')
}

function defaultExists(path) {
  return existsSync(path)
}

/** Read a file through the injected fs; undefined when missing / unreadable.
 *  `readFile` and `exists` may be sync or async. */
async function readTextVia(path, readFile, exists) {
  try {
    if (exists && !(await exists(path))) return undefined
    return toText(await readFile(path))
  } catch {
    return undefined
  }
}

/**
 * Observe a marketplace install from its files alone (no CLI call):
 * known_marketplaces.json, the marketplace's marketplace.json,
 * installed_plugins.json and settings.json. Pure over the injected fs;
 * missing or malformed files read as "absent". Never throws.
 * @param {{
 *   configDir?: string,
 *   readFile?: (path: string) => string | Buffer | Promise<string | Buffer>,
 *   exists?: (path: string) => boolean | Promise<boolean>,
 * }} [opts]
 * @returns {Promise<MarketplaceObservation>}
 */
export async function observeMarketplaceInstall({ configDir = claudeConfigDir(), readFile = defaultReadFile, exists = defaultExists } = {}) {
  const paths = marketplaceConfigPaths(configDir)
  // known_marketplaces.json first: for a GitHub source the CLI clones under
  // <configDir>/plugins/marketplaces/hoai and records that; for a directory
  // source (`marketplace add E:\some\dir`, what the E2E uses) it records the
  // directory itself and copies NOTHING under the config dir. The
  // marketplace.json is therefore read from installLocation when present;
  // the default path is the fallback only when the entry does not say.
  const known = parseJsonSafe(await readTextVia(paths.knownMarketplaces, readFile, exists))
  const entry = isRecord(known) && isRecord(known[HOAI_MARKETPLACE]) ? known[HOAI_MARKETPLACE] : null
  const marketplaceRegistered = entry !== null
  const marketplaceInstallLocation =
    entry && typeof entry.installLocation === 'string' && entry.installLocation.trim() ? entry.installLocation.trim() : null
  const marketplaceJsonPath = marketplaceInstallLocation ? marketplaceJsonPathFor(marketplaceInstallLocation) : paths.marketplaceJson
  const marketplaceText = await readTextVia(marketplaceJsonPath, readFile, exists)
  const marketplaceLatest = marketplaceText === undefined ? null : readMarketplaceLatest(marketplaceText)
  const installed = installedEntryFrom(parseJsonSafe(await readTextVia(paths.installedPlugins, readFile, exists)))
  const settings = parseJsonSafe(await readTextVia(paths.settings, readFile, exists))
  const enabled = isRecord(settings) && isRecord(settings.enabledPlugins) && settings.enabledPlugins[HOAI_PLUGIN_ID] === true
  return { marketplaceRegistered, marketplaceInstallLocation, marketplaceLatest, installed, enabled }
}

// -- CLI ---------------------------------------------------------------------

// isRunAsMain is imported, so THIS module's URL must be passed explicitly:
// its default is bgos-install-method's own import.meta.url.
if (isRunAsMain(process.argv[1], import.meta.url)) {
  // Operator diagnostic: print what the files say about the marketplace
  // install in the real config dir. Reads only; never invokes claude.
  observeMarketplaceInstall().then(
    (observation) => {
      process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`)
    },
    (error) => {
      process.stderr.write(`plugin-cli: ${errorMessage(error)}\n`)
      process.exitCode = 1
    },
  )
}
