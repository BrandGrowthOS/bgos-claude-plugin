#!/usr/bin/env node
/**
 * fake-claude: a stand-in for `claude plugin ...` that the sandbox tests
 * spawn as a REAL child process (so runClaudeCli, its timeout, its output
 * collection and the executor's file observations are exercised for real,
 * with no network and no real Claude Code install touched).
 *
 * Behaviour is driven by a scenario JSON named by FAKE_CLAUDE_SCENARIO:
 *
 *   {
 *     "commands": {
 *       "<argv joined by single spaces>": {
 *         "outcome": "success" | "failure" | "garbage" | "hang" | "success_wrong_version",
 *         "code": 1,            // failure only (default 1)
 *         "stdout": "...",      // overrides the realistic text (success / failure)
 *         "stderr": "...",      // same
 *         "delayMs": 0,         // sleep before doing anything (hang: how long to hang, default 600000)
 *         "version": "0.0.1"    // success_wrong_version only: the version actually written
 *       }
 *     },
 *     "default": { ... same shape, used when argv is not listed ... },
 *     "state": {
 *       "version": "0.38.3",         // what the marketplace declares at `marketplace add`
 *       "nextVersion": "0.38.4",     // what `marketplace update` bumps the declaration to (optional)
 *       "wrongVersion": "0.0.1",     // default for success_wrong_version
 *       "marketplaceJson": { ... }   // verbatim marketplace.json to write instead of the default
 *     }
 *   }
 *
 * On the happy paths it mutates CLAUDE_CONFIG_DIR exactly the way Claude
 * Code 2.1.241 does (shapes copied from the design's isolated probe):
 *   marketplace add     plugins/known_marketplaces.json, plugins/marketplaces/hoai/.claude-plugin/marketplace.json,
 *                       settings.json extraKnownMarketplaces.hoai
 *   marketplace update  known_marketplaces lastUpdated; marketplace.json ref bumped to state.nextVersion when set
 *   install             plugins/cache/hoai/hoai/<version>/.claude-plugin/plugin.json, installed_plugins.json
 *                       (version 2, plugins['hoai@hoai'][0]), settings.json enabledPlugins['hoai@hoai']=true
 *   update              same files rewritten for the new version; the OLD cache dir stays
 *   uninstall           entry + enabledPlugins key removed; the cache dir SURVIVES (as in the real CLI)
 *   list --json         printed from installed_plugins.json
 *
 * Every invocation appends one JSON line to <CLAUDE_CONFIG_DIR>/fake-claude.log
 * BEFORE acting, so a killed (hang) call is still on record.
 *
 * Exit 2 (with a named reason on stderr) when FAKE_CLAUDE_SCENARIO or
 * CLAUDE_CONFIG_DIR is missing: a test harness mistake, never a "CLI
 * result". Import-safe: the writers are exported for the sandbox helper's
 * seed functions; the CLI block only runs when executed directly.
 */

import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const MARKETPLACE_NAME = 'hoai'
export const MARKETPLACE_REPO = 'BrandGrowthOS/hoai-marketplace'
export const PLUGIN_NAME = 'hoai'
export const PLUGIN_ID = 'hoai@hoai'
export const PLUGIN_GIT_URL = 'https://github.com/BrandGrowthOS/bgos-claude-plugin.git'
export const CALL_LOG_FILE = 'fake-claude.log'
export const DEFAULT_VERSION = '0.38.3'
export const DEFAULT_WRONG_VERSION = '0.0.1'
export const DEFAULT_HANG_MS = 600_000
export const OUTCOMES = ['success', 'failure', 'garbage', 'hang', 'success_wrong_version']

const TICK = '✔'
const CROSS = '✘'

/**
 * @typedef {object} FakeCommand
 * @property {'success'|'failure'|'garbage'|'hang'|'success_wrong_version'} [outcome]
 * @property {number} [code]
 * @property {string} [stdout]
 * @property {string} [stderr]
 * @property {number} [delayMs]
 * @property {string} [version]
 */

/**
 * @typedef {object} FakeState
 * @property {string} [version]
 * @property {string|null} [nextVersion]
 * @property {string} [wrongVersion]
 * @property {object} [marketplaceJson]
 */

/**
 * @typedef {object} FakeScenario
 * @property {Record<string, FakeCommand>} [commands]
 * @property {FakeCommand} [default]
 * @property {FakeState} [state]
 */

/** @typedef {{ code: number, stdout: string|Buffer, stderr: string }} FakeOutput */

// -- Config dir layout (node:path, independent of lib/plugin-cli.mjs) --------

/** @param {string} configDir */
export function configPaths(configDir) {
  const marketplaceDir = join(configDir, 'plugins', 'marketplaces', MARKETPLACE_NAME)
  return {
    knownMarketplaces: join(configDir, 'plugins', 'known_marketplaces.json'),
    marketplaceDir,
    marketplaceJson: join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
    installedPlugins: join(configDir, 'plugins', 'installed_plugins.json'),
    settings: join(configDir, 'settings.json'),
    cacheRoot: join(configDir, 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME),
    callLog: join(configDir, CALL_LOG_FILE),
  }
}

/** @param {string} path @param {unknown} fallback */
export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** @param {string} path @param {unknown} value */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** The marketplace.json the real hoai marketplace ships, for a version.
 *  `url` overrides the plugin source url (the E2E marketplace uses file:///). */
export function defaultMarketplaceJson(version, { url = PLUGIN_GIT_URL } = {}) {
  return {
    $schema: 'https://json.schemastore.org/claude-code-marketplace.json',
    name: MARKETPLACE_NAME,
    description: 'Home of Agents. Chat with your Claude Code sessions through the HOAI desktop and mobile app.',
    owner: { name: 'BrandGrowthOS', email: 'hello@brandgrowthos.ai' },
    plugins: [
      {
        name: PLUGIN_NAME,
        displayName: 'HOAI (Home of Agents)',
        description: 'HOAI channel for Claude Code.',
        author: { name: 'BrandGrowthOS' },
        homepage: 'https://brandgrowthos.ai',
        license: 'Apache-2.0',
        category: 'productivity',
        keywords: ['channel', 'chat', 'messaging', 'hoai', 'bgos', 'mcp'],
        source: { source: 'url', url, ref: `v${version}` },
      },
    ],
  }
}

/** The hoai entry of known_marketplaces.json, or null. */
export function knownMarketplaceEntry(configDir) {
  const known = readJson(configPaths(configDir).knownMarketplaces, {})
  const entry = known && typeof known === 'object' ? known[MARKETPLACE_NAME] : null
  return entry && typeof entry === 'object' ? entry : null
}

/** True when known_marketplaces.json lists the hoai marketplace. */
export function marketplaceRegistered(configDir) {
  return knownMarketplaceEntry(configDir) !== null
}

/** True when the registered marketplace is a directory source (nothing under the config dir). */
export function marketplaceIsDirectory(configDir) {
  return knownMarketplaceEntry(configDir)?.source?.source === 'directory'
}

/** Where the marketplace files live: the registry's installLocation (a directory
 *  source points outside the config dir), else the default clone dir. */
export function marketplaceInstallLocation(configDir) {
  const entry = knownMarketplaceEntry(configDir)
  return typeof entry?.installLocation === 'string' && entry.installLocation ? entry.installLocation : configPaths(configDir).marketplaceDir
}

/** `<installLocation>/.claude-plugin/marketplace.json` */
export function marketplaceJsonPath(configDir) {
  return join(marketplaceInstallLocation(configDir), '.claude-plugin', 'marketplace.json')
}

/** The declared plugin version in marketplace.json (top-level version, else the
 *  source ref without `v`), or null. */
export function marketplaceVersion(configDir) {
  const doc = readJson(marketplaceJsonPath(configDir), null)
  const plugin = Array.isArray(doc?.plugins) ? doc.plugins.find((p) => p?.name === PLUGIN_NAME) : null
  const declared = typeof plugin?.version === 'string' ? plugin.version.replace(/^v/, '') : ''
  if (declared) return declared
  const ref = typeof plugin?.source?.ref === 'string' ? plugin.source.ref : ''
  return ref ? ref.replace(/^v/, '') : null
}

/**
 * What `marketplace add <dir>` writes: a registry entry pointing AT the
 * directory (installLocation = the directory, nothing copied under the
 * config dir) plus settings.json extraKnownMarketplaces.
 * @param {string} configDir
 * @param {string} dirPath
 */
export function writeDirectoryMarketplaceFiles(configDir, dirPath) {
  const paths = configPaths(configDir)
  const known = readJson(paths.knownMarketplaces, {})
  known[MARKETPLACE_NAME] = {
    source: { source: 'directory', path: dirPath },
    installLocation: dirPath,
    lastUpdated: new Date().toISOString(),
  }
  writeJson(paths.knownMarketplaces, known)
  const settings = readJson(paths.settings, {})
  settings.extraKnownMarketplaces = {
    ...(settings.extraKnownMarketplaces ?? {}),
    [MARKETPLACE_NAME]: { source: { source: 'directory', path: dirPath } },
  }
  writeJson(paths.settings, settings)
}

/**
 * What `marketplace add` writes: known_marketplaces.json, the marketplace's
 * marketplace.json (from `marketplaceJson` or the default for `version`),
 * and settings.json extraKnownMarketplaces.
 * @param {string} configDir
 * @param {{ marketplaceJson?: object, version?: string }} [opts]
 */
export function writeMarketplaceFiles(configDir, { marketplaceJson, version = DEFAULT_VERSION } = {}) {
  const paths = configPaths(configDir)
  const known = readJson(paths.knownMarketplaces, {})
  known[MARKETPLACE_NAME] = {
    source: { source: 'github', repo: MARKETPLACE_REPO },
    installLocation: paths.marketplaceDir,
    lastUpdated: new Date().toISOString(),
  }
  writeJson(paths.knownMarketplaces, known)
  writeJson(paths.marketplaceJson, marketplaceJson ?? defaultMarketplaceJson(version))
  const settings = readJson(paths.settings, {})
  settings.extraKnownMarketplaces = {
    ...(settings.extraKnownMarketplaces ?? {}),
    [MARKETPLACE_NAME]: { source: { source: 'github', repo: MARKETPLACE_REPO } },
  }
  writeJson(paths.settings, settings)
}

/** Rewrite marketplace.json's declared ref to `version` (marketplace update). */
export function bumpMarketplaceVersion(configDir, version) {
  const paths = configPaths(configDir)
  const manifest = marketplaceJsonPath(configDir)
  const doc = readJson(manifest, null) ?? defaultMarketplaceJson(version)
  for (const plugin of Array.isArray(doc.plugins) ? doc.plugins : []) {
    if (plugin?.name === PLUGIN_NAME && plugin.source) plugin.source.ref = `v${version}`
  }
  writeJson(manifest, doc)
  const known = readJson(paths.knownMarketplaces, {})
  if (known[MARKETPLACE_NAME]) {
    known[MARKETPLACE_NAME].lastUpdated = new Date().toISOString()
    writeJson(paths.knownMarketplaces, known)
  }
}

/** The user-scope hoai@hoai entry of installed_plugins.json, or null. */
export function installedEntry(configDir) {
  const doc = readJson(configPaths(configDir).installedPlugins, null)
  const list = doc?.plugins?.[PLUGIN_ID]
  if (!Array.isArray(list)) return null
  return list.find((entry) => entry?.scope === 'user') ?? list[0] ?? null
}

/**
 * What `install` / `update` write: the versioned cache dir with its
 * plugin.json, the installed_plugins.json entry (version 2 shape) and
 * settings.json enabledPlugins. An existing entry is replaced; other
 * versions' cache dirs are left alone (the real CLI never deletes them).
 * @param {string} configDir
 * @param {string} version
 * @param {{ enabled?: boolean }} [opts]
 */
export function writeInstalledFiles(configDir, version, { enabled = true } = {}) {
  const paths = configPaths(configDir)
  const installPath = join(paths.cacheRoot, version)
  writeJson(join(installPath, '.claude-plugin', 'plugin.json'), {
    name: PLUGIN_NAME,
    displayName: 'HOAI (Home of Agents)',
    version,
    author: { name: 'BrandGrowthOS' },
  })
  const doc = readJson(paths.installedPlugins, null) ?? { version: 2, plugins: {} }
  if (!doc.plugins || typeof doc.plugins !== 'object') doc.plugins = {}
  const previous = installedEntry(configDir)
  const now = new Date().toISOString()
  doc.version = 2
  doc.plugins[PLUGIN_ID] = [
    {
      scope: 'user',
      installPath,
      version,
      installedAt: previous?.installedAt ?? now,
      lastUpdated: now,
      // The real CLI leaves gitCommitSha stale across an update; mirror that.
      gitCommitSha: previous?.gitCommitSha ?? randomBytes(20).toString('hex'),
    },
  ]
  writeJson(paths.installedPlugins, doc)
  const settings = readJson(paths.settings, {})
  settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), [PLUGIN_ID]: enabled }
  writeJson(paths.settings, settings)
  return installPath
}

/** What `uninstall` writes: entry and enabledPlugins key removed, cache kept. */
export function removeInstalledFiles(configDir) {
  const paths = configPaths(configDir)
  const doc = readJson(paths.installedPlugins, null)
  if (doc?.plugins && typeof doc.plugins === 'object') {
    delete doc.plugins[PLUGIN_ID]
    writeJson(paths.installedPlugins, doc)
  }
  const settings = readJson(paths.settings, {})
  if (settings.enabledPlugins && typeof settings.enabledPlugins === 'object') {
    delete settings.enabledPlugins[PLUGIN_ID]
    writeJson(paths.settings, settings)
  }
}

/** The rows `plugin list --json` prints. */
export function listRows(configDir) {
  const entry = installedEntry(configDir)
  if (!entry) return []
  const settings = readJson(configPaths(configDir).settings, {})
  return [
    {
      id: PLUGIN_ID,
      version: entry.version,
      scope: entry.scope,
      enabled: settings?.enabledPlugins?.[PLUGIN_ID] === true,
      installPath: entry.installPath,
      installedAt: entry.installedAt,
      lastUpdated: entry.lastUpdated,
    },
  ]
}

// -- Scenario ----------------------------------------------------------------

/**
 * @param {Record<string, string|undefined>} env
 * @returns {{ scenario: FakeScenario, configDir: string } | { error: string }}
 */
export function loadScenario(env) {
  const configDir = String(env.CLAUDE_CONFIG_DIR ?? '').trim()
  if (!configDir) return { error: 'fake-claude: CLAUDE_CONFIG_DIR is not set' }
  const scenarioPath = String(env.FAKE_CLAUDE_SCENARIO ?? '').trim()
  if (!scenarioPath) return { error: 'fake-claude: FAKE_CLAUDE_SCENARIO is not set' }
  if (!existsSync(scenarioPath)) return { error: `fake-claude: FAKE_CLAUDE_SCENARIO not found: ${scenarioPath}` }
  const scenario = readJson(scenarioPath, undefined)
  if (!scenario || typeof scenario !== 'object') return { error: `fake-claude: FAKE_CLAUDE_SCENARIO is not valid JSON: ${scenarioPath}` }
  return { scenario, configDir }
}

/**
 * The command entry for an argv: exact match on the joined argv, else the
 * scenario default, else plain success.
 * @param {FakeScenario} scenario
 * @param {string[]} argv
 * @returns {FakeCommand}
 */
export function resolveCommand(scenario, argv) {
  const entry = scenario.commands?.[argv.join(' ')] ?? scenario.default ?? {}
  return { ...entry, outcome: OUTCOMES.includes(entry.outcome) ? entry.outcome : 'success' }
}

// -- Realistic behaviour -----------------------------------------------------

/**
 * The command's subject (plugin id / marketplace name / source), ignoring
 * flags and their values: index 2 for `plugin <verb> <subject>`, index 3 for
 * `plugin marketplace <verb> <subject>`.
 */
function subjectOf(argv) {
  const words = argv.filter((word, i) => {
    if (word.startsWith('-')) return false
    const prev = argv[i - 1]
    return !(prev === '--scope' || prev === '-s')
  })
  return words[argv[1] === 'marketplace' ? 3 : 2] ?? ''
}

/**
 * Perform the realistic effect of a successful `claude plugin ...` on the
 * config dir and return what the real CLI prints.
 * @param {string[]} argv
 * @param {string} configDir
 * @param {FakeState} state
 * @param {string|null} forceVersion   success_wrong_version: install this instead
 * @returns {FakeOutput}
 */
export function performRealistic(argv, configDir, state, forceVersion) {
  const [head, verb, subject] = argv
  const ok = (stdout) => ({ code: 0, stdout, stderr: '' })
  const fail = (stderr, code = 1) => ({ code, stdout: '', stderr })
  if (head !== 'plugin') return fail(`error: unknown command '${argv.join(' ')}'\n`)

  if (verb === 'marketplace' && subject === 'add') {
    if (marketplaceRegistered(configDir)) {
      // Real 2.1.241 line; U+2014 built via escape so the source holds no dash.
      return ok(`${TICK} Marketplace '${MARKETPLACE_NAME}' already on disk \u2014 declared in user settings\n`)
    }
    const source = subjectOf(argv)
    if (source !== MARKETPLACE_REPO) {
      // Directory source (`marketplace add E:\some\dir`): the registry points AT
      // the directory and nothing is copied under the config dir.
      if (!existsSync(join(source, '.claude-plugin', 'marketplace.json'))) {
        return fail(`${CROSS} Failed to add marketplace: ${source} is not a marketplace (no .claude-plugin/marketplace.json)\n`)
      }
      writeDirectoryMarketplaceFiles(configDir, source)
      return ok(`${TICK} Successfully added marketplace: ${MARKETPLACE_NAME} (declared in user settings)\n`)
    }
    writeMarketplaceFiles(configDir, { marketplaceJson: state.marketplaceJson, version: state.version ?? DEFAULT_VERSION })
    return ok(`${TICK} Successfully added marketplace: ${MARKETPLACE_NAME} (declared in user settings)\n`)
  }

  if (verb === 'marketplace' && subject === 'update') {
    const name = subjectOf(argv)
    if (name !== MARKETPLACE_NAME || !marketplaceRegistered(configDir)) {
      return fail(`${CROSS} Failed to update marketplace "${name}": Marketplace "${name}" not found\n`)
    }
    if (marketplaceIsDirectory(configDir)) {
      // Real 2.1.241 stdout for a directory marketplace: it is re-validated in
      // place; the directory's own marketplace.json is never rewritten.
      return ok(`Updating marketplace: ${MARKETPLACE_NAME}...Validating local marketplace\n${TICK} Successfully updated marketplace: ${MARKETPLACE_NAME}\n`)
    }
    bumpMarketplaceVersion(configDir, state.nextVersion ?? marketplaceVersion(configDir) ?? state.version ?? DEFAULT_VERSION)
    return ok(`Updating marketplace: ${MARKETPLACE_NAME}...\n${TICK} Successfully updated marketplace: ${MARKETPLACE_NAME}\n`)
  }

  if (verb === 'install') {
    const id = subjectOf(argv)
    if (id !== PLUGIN_ID) return fail(`${CROSS} Failed to install plugin "${id}": Plugin "${id}" not found\n`)
    if (!marketplaceRegistered(configDir)) {
      return fail(`${CROSS} Failed to install plugin "${id}": Marketplace "${MARKETPLACE_NAME}" not found\n`)
    }
    if (installedEntry(configDir)) return ok(`Plugin "${PLUGIN_ID}" is already installed (scope: user)\n`)
    const version = forceVersion ?? marketplaceVersion(configDir) ?? state.version ?? DEFAULT_VERSION
    writeInstalledFiles(configDir, version)
    return ok(`${TICK} Successfully installed plugin: ${PLUGIN_ID} (scope: user)\n`)
  }

  if (verb === 'update') {
    const id = subjectOf(argv)
    const entry = id === PLUGIN_ID ? installedEntry(configDir) : null
    if (!entry) {
      const name = id.split('@')[0] || id
      return fail(`${CROSS} Failed to update plugin "${id}": Plugin "${name}" not found\n`)
    }
    const target = state.nextVersion ?? marketplaceVersion(configDir) ?? entry.version
    // Real 2.1.241 stdout (captured 2026-08-25): a progress line, then the verdict line.
    const checking = `Checking for updates for plugin "${PLUGIN_ID}" at user scope…\n`
    if (target === entry.version) return ok(`${checking}${PLUGIN_ID} is already at the latest version (${entry.version}).\n`)
    writeInstalledFiles(configDir, forceVersion ?? target)
    return ok(
      `${checking}${TICK} Plugin "${PLUGIN_NAME}" updated from ${entry.version} to ${target} for scope user. Restart to apply changes.\n`,
    )
  }

  if (verb === 'uninstall') {
    const id = subjectOf(argv)
    if (id !== PLUGIN_ID || !installedEntry(configDir)) {
      return fail(`${CROSS} Failed to uninstall plugin "${id}": Plugin "${id}" not found in installed plugins\n`)
    }
    removeInstalledFiles(configDir)
    return ok(`${TICK} Successfully uninstalled plugin: ${PLUGIN_ID} (scope: user)\n`)
  }

  if (verb === 'list') {
    const rows = listRows(configDir)
    if (argv.includes('--json')) return ok(`${JSON.stringify(rows, null, 2)}\n`)
    return ok(rows.length ? rows.map((row) => `${row.id} ${row.version} (${row.scope})\n`).join('') : 'No plugins installed\n')
  }

  return fail(`error: unknown command '${argv.join(' ')}'\n`)
}

/** The realistic failure line when a scenario failure gives no text. */
function defaultFailureText(argv) {
  const verb = argv[1] === 'marketplace' ? `${argv[2]} marketplace` : `${argv[1]} plugin`
  return `${CROSS} Failed to ${verb} "${subjectOf(argv)}": simulated failure\n`
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The whole fake: resolve the scenario, log, delay, act, print. Resolves
 * with the exit code. `io.stdout` / `io.stderr` receive the output.
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 * @param {{ stdout: (chunk: string|Buffer) => void, stderr: (chunk: string) => void }} io
 * @returns {Promise<number>}
 */
export async function runFakeClaude(argv, env, io) {
  const loaded = loadScenario(env)
  if ('error' in loaded) {
    io.stderr(`${loaded.error}\n`)
    return 2
  }
  const { scenario, configDir } = loaded
  const state = scenario.state ?? {}
  const command = resolveCommand(scenario, argv)
  const outcome = command.outcome ?? 'success'
  const delayMs = typeof command.delayMs === 'number' && command.delayMs > 0 ? command.delayMs : 0

  mkdirSync(configDir, { recursive: true })
  appendFileSync(
    configPaths(configDir).callLog,
    `${JSON.stringify({ at: new Date().toISOString(), argv, outcome, delayMs })}\n`,
  )

  if (outcome === 'hang') {
    await sleep(delayMs || DEFAULT_HANG_MS)
    return 0
  }
  if (delayMs) await sleep(delayMs)

  if (outcome === 'garbage') {
    io.stdout(Buffer.concat([randomBytes(48), Buffer.from(' garbage', 'utf8'), randomBytes(16)]))
    return 0
  }
  if (outcome === 'failure') {
    const code = typeof command.code === 'number' && command.code !== 0 ? command.code : 1
    if (command.stdout) io.stdout(command.stdout)
    io.stderr(command.stderr ?? defaultFailureText(argv))
    return code
  }

  const forceVersion = outcome === 'success_wrong_version' ? command.version ?? state.wrongVersion ?? DEFAULT_WRONG_VERSION : null
  const result = performRealistic(argv, configDir, state, forceVersion)
  const stdout = command.stdout ?? result.stdout
  const stderr = command.stderr ?? result.stderr
  if (stdout) io.stdout(stdout)
  if (stderr) io.stderr(stderr)
  return typeof command.code === 'number' ? command.code : result.code
}

// -- CLI ---------------------------------------------------------------------

/** True when this file is the process entry point (real paths compared). */
export function isRunAsMain(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (typeof argv1 !== 'string') return false
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1)
  } catch {
    return moduleUrl === pathToFileURL(argv1).href
  }
}

if (isRunAsMain()) {
  runFakeClaude(process.argv.slice(2), process.env, {
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
  }).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      process.stderr.write(`fake-claude: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exitCode = 2
    },
  )
}
