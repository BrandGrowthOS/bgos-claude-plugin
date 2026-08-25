#!/usr/bin/env node
/**
 * bgos-install-method: detect HOW this plugin is installed and therefore WHICH
 * channel spec launches it.
 *
 * The HOAI Claude Code plugin runs from one of two installs, and the Claude
 * Code channel flag differs per install:
 *
 *   marketplace install (plugin "hoai" from marketplace "hoai"): the plugin
 *   files live under the Claude config dir, either
 *     <config>/plugins/cache/<marketplace>/<plugin>/<version>/...
 *     <config>/plugins/marketplaces/<marketplace>/plugins/<plugin>/...
 *   and the correct channel spec is plugin:hoai@hoai
 *
 *   local clone (for example ~/bgos-claude-plugin): the correct channel spec
 *   is server:bgos
 *
 * Getting this wrong is SILENT: on 2026-08-21 a marketplace install was
 * launched with server:bgos and every inbound message was dropped with no
 * error anywhere. So the method is detected from POSITIVE evidence of what
 * this machine HAS INSTALLED, never inferred from where the code happens to
 * be executing, and never guessed:
 *   1. CLAUDE_PLUGIN_ROOT, when set, is the authority on where the plugin
 *      lives (Claude Code sets it when it loads a marketplace plugin);
 *      whether that root sits under <configDir>/plugins decides the method.
 *   2. Otherwise the REAL path of this script, when it lies under
 *      <configDir>/plugins: the plugin files ARE the install, marketplace.
 *   3. Otherwise, if that real path is an EPHEMERAL EXECUTION ROOT (an npx /
 *      bunx / dlx package-runner cache, or a node_modules tree under a temp
 *      dir), the script's location says nothing about what is installed and
 *      is not used as evidence in EITHER direction. What the machine has is
 *      read from <configDir>/plugins/installed_plugins.json instead.
 *   4. Otherwise the real path is a persistent checkout: a clone. Unchanged.
 *   5. When none of the above can answer, the method is 'unknown', the
 *      channel spec is EMPTY, and every caller must refuse to launch and say
 *      so out loud.
 *
 * Why step 3 exists (the 2026-08-24 report). The app's connect screen hands
 * out `npx -y --package github:BrandGrowthOS/bgos-claude-plugin hoai setup
 * <CODE>`, and `hoai doctor` is reached the same way. npm unpacks that under
 *   ~/.npm/_npx/<hash>/node_modules/claude-channel-bgos
 * which is not under the plugins dir, so step 2 used to fall straight through
 * to "clone" and hand a marketplace user `server:bgos`. The session starts,
 * `claude mcp list` says Connected, and not one inbound message is ever
 * delivered. A temp directory is where code RUNS, it is not an install.
 *
 * Fail-closed direction. Guessing "clone" is the dangerous guess, because it
 * produces an agent that looks healthy and hears nothing. So an undetermined
 * machine reports 'unknown' with a reason a human can act on rather than a
 * plausible answer.
 *
 * Which marketplace, not just "a marketplace". The spec is
 * plugin:<plugin>@<MARKETPLACE NAME>, and the marketplace name is read off the
 * machine too (the path segment under plugins/cache or plugins/marketplaces,
 * or the installed_plugins.json key), because a machine whose marketplace is
 * registered under another name needs that name in the spec. A hardcoded
 * plugin:hoai@hoai is just as silently deaf there as the clone spec was.
 *
 * Path comparison is segment based (never raw string prefixes, so a sibling
 * like .claude/pluginsX is not mistaken for .claude/plugins), tolerates / and
 * \ mixed in the same path, and is case insensitive for win32 style paths.
 *
 * Self-contained plain JavaScript: node >= 18 builtins only, no imports from
 * the TS plugin sources and none from lib/ (lib/plugin-cli.mjs imports FROM
 * this file, so an import back would be a cycle; test/bgos-install-method.test
 * pins the two files' shared constants against each other instead). Every
 * filesystem read is injectable and never throws. Import-safe: every helper is
 * exported and the CLI block only runs when the file is executed directly, so
 * tests can import the pure pieces.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The plugin's name inside its marketplace. Spelled once here; lib/plugin-cli
 *  restates it as HOAI_PLUGIN_NAME and a drift test pins the two together. */
export const HOAI_PLUGIN_NAME = 'hoai'
/** The marketplace name the HOAI marketplace registers itself under today.
 *  Only a FALLBACK: a real install's name is read off the machine. */
export const DEFAULT_HOAI_MARKETPLACE = 'hoai'
/** The channel spec that loads a marketplace install of the plugin from the
 *  DEFAULT marketplace name. Prefer marketplaceChannelSpec(name). */
export const MARKETPLACE_CHANNEL_SPEC = `plugin:${HOAI_PLUGIN_NAME}@${DEFAULT_HOAI_MARKETPLACE}`
/** The channel spec that loads a local checkout running server.ts directly. */
export const CLONE_CHANNEL_SPEC = 'server:bgos'
/** The channel spec for an UNDETERMINED install: none. Empty on purpose, so a
 *  caller that forgets to check cannot spell a plausible flag by accident. */
export const UNKNOWN_CHANNEL_SPEC = ''

/** The channel spec for a marketplace install registered under `marketplace`. */
export function marketplaceChannelSpec(marketplace) {
  const name = String(marketplace ?? '').trim() || DEFAULT_HOAI_MARKETPLACE
  return `plugin:${HOAI_PLUGIN_NAME}@${name}`
}

// -- Small pure helpers ------------------------------------------------------

/** True when the path is win32 shaped (drive letter prefix or a backslash). */
function looksWin32(path) {
  const value = String(path ?? '')
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')
}

/**
 * Break a path into { prefix, sep, segments }:
 *   prefix   'C:\\' style for a drive path, '/' (or '\\') for a rootless
 *            absolute path, '' for a relative one
 *   sep      the separator the original path uses ('\\' wins when mixed)
 *   segments normalized name segments with '', '.' dropped and '..' resolved
 * Handles / and \ in the same path so a caller never has to care which style
 * the host, the env var, or Claude Code produced.
 * @param {string} raw
 */
export function parsePath(raw) {
  const value = String(raw ?? '')
  const sep = value.includes('\\') ? '\\' : '/'
  const drive = /^([A-Za-z]:)(?=[\\/])/.exec(value)
  const prefix = drive ? `${drive[1]}${sep}` : /^[\\/]/.test(value) ? sep : ''
  const rest = drive ? value.slice(drive[1].length) : value
  /** @type {string[]} */
  const segments = []
  for (const segment of rest.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return { prefix, sep, segments }
}

/**
 * A path's comparable identity: a root marker plus its segments. Drive
 * letters compare case insensitively ('c:'), any driveless absolute root
 * compares as '/', a relative path as ''. Two paths on different roots can
 * then never segment-match each other.
 * @param {string} path
 */
function comparableParts(path) {
  const { prefix, segments } = parsePath(path)
  const marker = /^[A-Za-z]:/.test(prefix) ? prefix.slice(0, 2).toLowerCase() : prefix ? '/' : ''
  return { marker, segments }
}

/**
 * The Claude config dir: env.CLAUDE_CONFIG_DIR (trimmed) when set, else
 * <home>/.claude. The default join preserves the home path's separator style
 * so a posix home stays posix even on a win32 host.
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [opts]
 */
export function claudeConfigDir({ env = process.env, home = homedir() } = {}) {
  const override = String(env?.CLAUDE_CONFIG_DIR ?? '').trim()
  if (override) return override
  const base = String(home ?? '').replace(/[\\/]+$/, '')
  const sep = looksWin32(base) ? '\\' : '/'
  return `${base}${sep}.claude`
}

/**
 * True when the normalized candidate lies strictly under
 * <claudeConfigDir>/plugins/ (the plugins dir itself does not count).
 * Segment-by-segment comparison, so the prefix collision .claude/pluginsX
 * can never match, and case insensitive when either side is win32 shaped.
 * @param {string} candidatePath
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [opts]
 */
export function isUnderPluginsDir(candidatePath, { env = process.env, home = homedir() } = {}) {
  const candidate = String(candidatePath ?? '').trim()
  if (!candidate) return false
  const configDir = claudeConfigDir({ env, home })
  const config = comparableParts(configDir)
  const child = comparableParts(candidate)
  if (child.marker !== config.marker) return false
  const parent = [...config.segments, 'plugins']
  if (child.segments.length <= parent.length) return false
  const caseInsensitive = looksWin32(candidate) || looksWin32(configDir)
  const fold = (segment) => (caseInsensitive ? segment.toLowerCase() : segment)
  return parent.every((segment, i) => fold(segment) === fold(child.segments[i]))
}

/**
 * True when `candidatePath` lies strictly under `parentPath`, compared the
 * same segment-by-segment way as isUnderPluginsDir (mixed separators fine,
 * case insensitive when either side is win32 shaped, different roots never
 * match). An empty parent matches nothing.
 * @param {string} candidatePath
 * @param {string} parentPath
 */
export function isUnderDir(candidatePath, parentPath) {
  const candidate = String(candidatePath ?? '').trim()
  const parentRaw = String(parentPath ?? '').trim()
  if (!candidate || !parentRaw) return false
  const parent = comparableParts(parentRaw)
  const child = comparableParts(candidate)
  if (child.marker !== parent.marker) return false
  if (parent.segments.length === 0) return false
  if (child.segments.length <= parent.segments.length) return false
  const caseInsensitive = looksWin32(candidate) || looksWin32(parentRaw)
  const fold = (segment) => (caseInsensitive ? segment.toLowerCase() : segment)
  return parent.segments.every((segment, i) => fold(segment) === fold(child.segments[i]))
}

/**
 * The temp roots a package runner might unpack into. os.tmpdir() plus the
 * env overrides plus the two macOS spellings of /tmp (realpath turns /tmp/x
 * into /private/tmp/x, so both have to be here or the resolved path escapes
 * the check).
 * @param {{ env?: Record<string, string | undefined>, tmp?: string }} [opts]
 */
export function defaultTempRoots({ env = process.env, tmp = safeTmpdir() } = {}) {
  const roots = [tmp, env?.TMPDIR, env?.TEMP, env?.TMP, '/tmp', '/private/tmp', '/var/folders']
  return roots.map((value) => String(value ?? '').trim()).filter(Boolean)
}

function safeTmpdir() {
  try {
    return tmpdir()
  } catch {
    return ''
  }
}

/**
 * True when this path is a PACKAGE RUNNER's throwaway unpack directory rather
 * than an install: `npx`, `bunx`, `yarn dlx`, `pnpm dlx`, or any node_modules
 * tree sitting under a temp root.
 *
 * This is the whole point of the 2026-08-24 fix. The connect screen hands out
 *   npx -y --package github:BrandGrowthOS/bgos-claude-plugin hoai setup <CODE>
 * and npm unpacks that at
 *   /Users/<user>/.npm/_npx/<hash>/node_modules/claude-channel-bgos
 * (the exact shape off a real user's doctor output). It is not under the
 * plugins dir, so the old code read it as a local clone and handed a
 * marketplace user `server:bgos`: Connected, and deaf. A directory that will
 * be deleted the moment the command returns is evidence of NOTHING about what
 * this machine has installed, in either direction.
 *
 * Deliberately NOT matched: a plain global npm install
 * (<prefix>/lib/node_modules/claude-channel-bgos) and a checkout that merely
 * happens to sit in /tmp. Both are persistent directories a user chose, and
 * both keep detecting exactly as they do today. The temp rule only fires for a
 * node_modules tree under a temp root, which is what the runners produce.
 *
 * @param {string} candidatePath
 * @param {{ env?: Record<string, string | undefined>, tempRoots?: readonly string[] }} [opts]
 */
export function isEphemeralExecutionRoot(candidatePath, { env = process.env, tempRoots } = {}) {
  const value = String(candidatePath ?? '').trim()
  if (!value) return false
  const { segments } = parsePath(value)
  const fold = (segment) => (looksWin32(value) ? segment.toLowerCase() : segment)
  const names = segments.map(fold)
  // npm: ~/.npm/_npx/<hash>/node_modules/<pkg>, and on Windows
  // %LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\<pkg>.
  if (names.includes('_npx')) return true
  // bun: <tmp>/bunx-<uid>-<pkg>@<version>/node_modules/<pkg>.
  if (names.some((name) => name.startsWith('bunx-'))) return true
  // yarn: <tmp>/xfs-<hash>/dlx-<n>/node_modules/<pkg>.
  if (names.some((name) => /^dlx-/.test(name))) return true
  // pnpm: <cache>/pnpm/dlx/<hash>/node_modules/<pkg>.
  for (let i = 0; i < names.length - 1; i++) {
    if (names[i] === 'pnpm' && names[i + 1] === 'dlx') return true
  }
  // Any node_modules tree under a temp root, which covers the runners whose
  // directory naming this file does not know by name.
  if (!names.includes('node_modules')) return false
  const roots = tempRoots ?? defaultTempRoots({ env })
  return roots.some((root) => isUnderDir(value, root))
}

/**
 * The marketplace NAME a path under <configDir>/plugins belongs to, read off
 * the path itself:
 *   <config>/plugins/cache/<marketplace>/<plugin>/<version>/...
 *   <config>/plugins/marketplaces/<marketplace>/plugins/<plugin>/...
 * '' when the path is not under the plugins dir or does not use either layout.
 *
 * Read, not assumed: a machine whose marketplace is registered under some
 * other name needs THAT name in `plugin:<plugin>@<marketplace>`, and the
 * hardcoded default would be as silently deaf there as the clone spec was.
 * @param {string} candidatePath
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [opts]
 */
export function marketplaceNameFromPluginPath(
  candidatePath,
  { env = process.env, home = homedir() } = {},
) {
  const candidate = String(candidatePath ?? '').trim()
  if (!candidate) return ''
  if (!isUnderPluginsDir(candidate, { env, home })) return ''
  const configDir = claudeConfigDir({ env, home })
  const configSegments = comparableParts(configDir).segments
  const segments = comparableParts(candidate).segments.slice(configSegments.length + 1)
  const kind = String(segments[0] ?? '')
  const name = String(segments[1] ?? '')
  const kindFolded = looksWin32(candidate) ? kind.toLowerCase() : kind
  if (kindFolded !== 'cache' && kindFolded !== 'marketplaces') return ''
  return name
}

/** Join `parts` under `base` in base's own separator style. */
function joinUnder(base, ...parts) {
  const { prefix, sep, segments } = parsePath(base)
  return `${prefix}${[...segments, ...parts].join(sep)}`
}

/** The installed_plugins.json Claude Code keeps for a config dir. */
export function installedPluginsPath(configDir) {
  return joinUnder(String(configDir ?? ''), 'plugins', 'installed_plugins.json')
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/** Default text read: '' when the file is missing or unreadable. Never throws. */
function defaultReadText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Default existence probe. Never throws. */
function defaultExists(path) {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/**
 * Every HOAI plugin this machine has INSTALLED, read from
 * <configDir>/plugins/installed_plugins.json. That file is the machine's own
 * record of what `claude plugin install` put there, which is exactly the
 * positive evidence an npx execution root cannot supply.
 *
 * Shape (Claude Code 2.x, version 2, verified against a real file):
 *   { "version": 2, "plugins": { "<plugin>@<marketplace>": [
 *       { "scope": "user", "installPath": "<config>/plugins/cache/<mkt>/<plugin>/<ver>",
 *         "version": "0.34.3", ... } ] } }
 * An older single-object-per-id shape is tolerated. Entries whose plugin name
 * is not ours are ignored; the marketplace half of the key is kept, because
 * that is the name the channel spec needs.
 *
 * Never throws: a missing, unreadable or malformed file reads as "nothing
 * installed", which routes to a loud 'unknown', not to a guess.
 *
 * @param {{ configDir?: string, readFile?: (path: string) => string,
 *   exists?: (path: string) => boolean }} [opts]
 * @returns {{ id: string, marketplace: string, version: string, installPath: string }[]}
 */
export function readInstalledHoaiPlugins({
  configDir = '',
  readFile = defaultReadText,
  exists = defaultExists,
} = {}) {
  const path = installedPluginsPath(configDir)
  let text = ''
  try {
    if (!exists(path)) return []
    text = String(readFile(path) ?? '')
  } catch {
    return []
  }
  let doc = null
  try {
    doc = JSON.parse(text)
  } catch {
    return []
  }
  if (!isRecord(doc) || !isRecord(doc.plugins)) return []
  const found = []
  for (const [id, raw] of Object.entries(doc.plugins)) {
    const at = String(id).lastIndexOf('@')
    if (at <= 0) continue
    if (String(id).slice(0, at) !== HOAI_PLUGIN_NAME) continue
    const marketplace = String(id).slice(at + 1).trim()
    if (!marketplace) continue
    const records = Array.isArray(raw) ? raw.filter(isRecord) : isRecord(raw) ? [raw] : []
    const entry = records.find((item) => item.scope === 'user') ?? records[0] ?? null
    if (!entry) continue
    found.push({
      id: String(id),
      marketplace,
      version: nonEmptyString(entry.version),
      installPath: nonEmptyString(entry.installPath),
    })
  }
  return found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * The plugin root for a script living in <root>/bin/: walk up from the file
 * to the directory that CONTAINS bin/ (the last bin segment before the file
 * name wins, so a bin/ higher in the tree cannot hijack the walk). A script
 * with no bin/ ancestor falls back to its containing directory. Rejoined in
 * the original path's separator style.
 * @param {string} scriptPath
 */
export function pluginRootFromScriptPath(scriptPath) {
  const { prefix, sep, segments } = parsePath(scriptPath)
  let binIndex = -1
  for (let i = segments.length - 2; i >= 0; i--) {
    if (segments[i] === 'bin') {
      binIndex = i
      break
    }
  }
  const rootSegments =
    binIndex >= 0 ? segments.slice(0, binIndex) : segments.slice(0, Math.max(segments.length - 1, 0))
  return `${prefix}${rootSegments.join(sep)}`
}

/** Default realpath: fs.realpathSync, falling back to the raw path when the
 *  target does not exist or cannot be resolved. */
function defaultRealpath(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * @typedef {object} InstallDetection
 * @property {'marketplace'|'clone'|'unknown'} method
 * @property {string} channelSpec    the flag value to launch with; '' when unknown
 * @property {string} pluginRoot     the root of the INSTALL we concluded; '' when unknown
 * @property {string} executionRoot  where the running script lives, always, evidence or not
 * @property {boolean} ephemeralExecution  true when executionRoot is an npx/dlx/temp unpack
 * @property {string} marketplace    the marketplace name for a marketplace install, else ''
 * @property {'claude-plugin-root'|'script-path'|'installed-plugins'|'none'} evidence
 * @property {string} reason         '' unless method is 'unknown', then why, for a human
 */

/**
 * Decide the install method from POSITIVE evidence, strongest first:
 *   1. CLAUDE_PLUGIN_ROOT set (and not itself an ephemeral unpack dir):
 *      Claude Code is telling us where the plugin it loaded lives. Under
 *      <configDir>/plugins means marketplace with that root, elsewhere means
 *      clone with that root.
 *   2. The realpath of this script (symlink shims resolved) under
 *      <configDir>/plugins: the plugin files ARE the install, so marketplace,
 *      with the marketplace name read off the path.
 *   3. That real path is an EPHEMERAL EXECUTION ROOT (npx / bunx / dlx cache,
 *      or a node_modules tree under a temp dir), or there is no script path at
 *      all: the location is not evidence in EITHER direction, so ask the
 *      machine what it has installed (installed_plugins.json). Exactly one
 *      HOAI plugin installed means marketplace, with that entry's marketplace
 *      name and installPath. None, or more than one, means 'unknown'.
 *   4. Otherwise the real path is a persistent directory outside the plugins
 *      dir: a clone checkout. Unchanged from before, which is how the whole
 *      Mac fleet runs.
 *
 * 'unknown' carries an EMPTY channelSpec and a reason. Callers must refuse to
 * launch on it and print the reason. Guessing 'clone' here is the one outcome
 * that must never happen: it produces an agent that starts, reports Connected,
 * and drops every inbound message in silence.
 *
 * @param {{
 *   scriptPath?: string,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   realpath?: (path: string) => string,
 *   readFile?: (path: string) => string,
 *   exists?: (path: string) => boolean,
 *   tempRoots?: readonly string[],
 * }} [opts]
 * @returns {InstallDetection}
 */
export function detectInstallMethod({
  scriptPath,
  env = process.env,
  home = homedir(),
  realpath = defaultRealpath,
  readFile = defaultReadText,
  exists = defaultExists,
  tempRoots,
} = {}) {
  const raw = String(scriptPath ?? '').trim()
  let resolved = raw
  if (raw) {
    try {
      resolved = realpath(raw)
    } catch {
      resolved = raw
    }
  }
  const executionRoot = resolved ? pluginRootFromScriptPath(resolved) : ''
  const ephemeralExecution = isEphemeralExecutionRoot(resolved, { env, tempRoots })
  const base = { executionRoot, ephemeralExecution }

  const marketplaceAt = (root, evidence) => {
    const name = marketplaceNameFromPluginPath(root, { env, home })
    return {
      ...base,
      method: 'marketplace',
      channelSpec: marketplaceChannelSpec(name),
      pluginRoot: root,
      marketplace: name || DEFAULT_HOAI_MARKETPLACE,
      evidence,
      reason: '',
    }
  }
  const cloneAt = (root, evidence) => ({
    ...base,
    method: 'clone',
    channelSpec: CLONE_CHANNEL_SPEC,
    pluginRoot: root,
    marketplace: '',
    evidence,
    reason: '',
  })
  const undetermined = (reason) => ({
    ...base,
    method: 'unknown',
    channelSpec: UNKNOWN_CHANNEL_SPEC,
    pluginRoot: '',
    marketplace: '',
    evidence: 'none',
    reason,
  })

  // 1. Claude Code's own statement about the plugin it loaded.
  const envRoot = String(env?.CLAUDE_PLUGIN_ROOT ?? '').trim()
  if (envRoot && !isEphemeralExecutionRoot(envRoot, { env, tempRoots })) {
    return isUnderPluginsDir(envRoot, { env, home })
      ? marketplaceAt(envRoot, 'claude-plugin-root')
      : cloneAt(envRoot, 'claude-plugin-root')
  }

  // 2. The running files are themselves inside the plugins dir.
  if (resolved && isUnderPluginsDir(resolved, { env, home })) {
    return marketplaceAt(executionRoot, 'script-path')
  }

  // 3. Running from a throwaway unpack dir (or from nowhere we can name): the
  //    location proves nothing, so read what this machine actually installed.
  //    A RELATIVE script path counts as nowhere: it names no directory on this
  //    machine, and reading it as "not the plugins dir, therefore a clone" is
  //    the same inference-from-absence that produced the npx bug.
  const rootless = Boolean(resolved) && comparableParts(resolved).marker === ''
  if (!resolved || rootless || ephemeralExecution) {
    const where = ephemeralExecution
      ? `this command is running from a temporary package-runner directory (${executionRoot}), which is not an install`
      : 'this command could not work out where its own files are'
    const configDir = claudeConfigDir({ env, home })
    const installs = readInstalledHoaiPlugins({ configDir, readFile, exists })
    if (installs.length === 1) {
      const entry = installs[0]
      return {
        ...base,
        method: 'marketplace',
        channelSpec: marketplaceChannelSpec(entry.marketplace),
        pluginRoot: entry.installPath,
        marketplace: entry.marketplace,
        evidence: 'installed-plugins',
        reason: '',
      }
    }
    if (installs.length > 1) {
      const ids = installs.map((entry) => entry.id).join(', ')
      return undetermined(
        `${where}, and ${installedPluginsPath(configDir)} records MORE than one HOAI plugin ` +
          `(${ids}), so there is no single channel to launch. Run hoai from the agent's own ` +
          'folder (or uninstall the one you do not use) instead of through npx.',
      )
    }
    return undetermined(
      `${where}, and ${installedPluginsPath(configDir)} records no HOAI plugin install, so the ` +
        'channel this machine listens on cannot be determined. Run hoai from the folder the ' +
        'agent was set up in (a clone checkout), or install the plugin with hoai setup, rather ' +
        'than guessing a channel flag.',
    )
  }

  // 4. A persistent directory outside the plugins dir: a clone checkout.
  return cloneAt(executionRoot, 'script-path')
}

/**
 * The channel flag arguments for a method, as an argv slice.
 *
 * BOTH methods use `--dangerously-load-development-channels`; only the spec
 * differs. Do NOT be tempted by the approved-sounding `--channels` flag:
 * verified live on 2.1.239 (2026-08-22, Vulcan E2E) it loads a marketplace
 * plugin's tools promptlessly, `claude mcp list` even says Connected, and
 * yet it wires NO inbound channel delivery for a plugin that is not on
 * Anthropic's channel allowlist (HOAI is not, yet): the daemon delivered a
 * message, the session never started a turn, reply-overdue fired. That is a
 * third silent-drop vector alongside the two from 2026-08-21 (`--channels`
 * on a clone loads nothing; the dangerous flag with the clone spec on a
 * marketplace install matches nothing). The dev flag's warning prompt shows
 * every launch with Accept as the DEFAULT answer, so launchers auto-accept
 * it with one Enter. Revisit when HOAI lands on the allowlist.
 * There is no launch flag for an UNDETERMINED install, and this is where that
 * has to be refused rather than smoothed over: a caller holding
 * method === 'unknown' has no spec, and any string it emitted here would be a
 * guess that connects nothing. So 'unknown' throws, loudly, in the one place
 * that knows the flag's name. Callers that can present a message instead
 * should check detection.method first (bin/hoai-core buildRunPlan does).
 * @param {'marketplace' | 'clone'} method
 * @returns {string[]}
 */
export function launchFlagArgs(method) {
  if (method === 'unknown') {
    throw new Error(
      'launchFlagArgs: the install method is undetermined, so there is no channel spec to ' +
        'launch with. Refuse the launch and show the detection reason instead of guessing.',
    )
  }
  return channelFlagArgsForSpec(channelSpecFor(method))
}

/** The channel spec for a method. Anything not recognized as marketplace is
 *  treated as clone, the spec a raw checkout needs. Only ever reached with a
 *  KNOWN method: launchFlagArgs rejects 'unknown' before it gets here. */
function channelSpecFor(method) {
  return method === 'marketplace' ? MARKETPLACE_CHANNEL_SPEC : CLONE_CHANNEL_SPEC
}

/**
 * The channel flag pair for an ALREADY RESOLVED spec.
 *
 * The flag name lives here and only here, so a caller that resolved its spec
 * some other way cannot end up spelling the flag differently. The one such
 * caller today is bin/hoai-core.mjs, which prefers the spec a workspace
 * .mcp.json actually publishes (`server:<entry name>`) over install-method
 * detection: detection answers where the plugin FILES live, which is the wrong
 * question for a folder that declares its own MCP server. See the invariant
 * pinned in test/bgos-agent.static.test.ts.
 * @param {string} spec
 * @returns {string[]}
 */
export function channelFlagArgsForSpec(spec) {
  return ['--dangerously-load-development-channels', String(spec ?? '')]
}

/**
 * The exact launch command for a method. This is the line the 2026-08-21
 * incident was about: a marketplace install launched with the clone spec
 * connects nothing and drops every inbound message silently.
 * @param {'marketplace' | 'clone'} method
 */
export function launchCommand(method) {
  return `claude --dangerously-skip-permissions ${launchFlagArgs(method).join(' ')}`
}

/**
 * The exact launch command for an ALREADY RESOLVED detection, using the spec
 * detection produced (which carries the machine's real marketplace NAME, not
 * the default one). Returns '' when the install is undetermined: there is no
 * command to give, and a caller must print detection.reason instead.
 * @param {{ method?: string, channelSpec?: string }} detection
 */
export function launchCommandFor(detection) {
  const spec = String(detection?.channelSpec ?? '').trim()
  if (detection?.method === 'unknown' || !spec) return ''
  return `claude --dangerously-skip-permissions ${channelFlagArgsForSpec(spec).join(' ')}`
}

/**
 * One human line describing a detection result, including the launch command
 * so an operator (or the onboarding flow) can paste it as is. An undetermined
 * install says so and carries the reason: there is no command to paste, and
 * naming one would be the silent-deafness bug all over again.
 * @param {{ method?: string, pluginRoot?: string, channelSpec?: string, reason?: string }} result
 */
export function describeDetection(result) {
  if (result?.method === 'unknown') {
    const reason = String(result?.reason ?? '').trim() || 'no evidence of an install was found'
    return `install method: UNDETERMINED, no channel spec. ${reason}`
  }
  const method = result?.method === 'marketplace' ? 'marketplace' : 'clone'
  const root = String(result?.pluginRoot ?? '').trim() || '<unknown>'
  const command = launchCommandFor(result) || launchCommand(method)
  return `install method: ${method} (plugin root ${root}), launch with: ${command}`
}

// -- CLI ---------------------------------------------------------------------

/**
 * True when this file is the process entry point. Compares REAL paths on both
 * sides so a symlinked bin (npm/npx puts a shim in node_modules/.bin, and paths
 * under /tmp resolve through /private/tmp on macOS) still runs the CLI block; a
 * plain href compare would fail those and silently do nothing.
 */
export function isRunAsMain(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (typeof argv1 !== 'string') return false
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1)
  } catch {
    return moduleUrl === pathToFileURL(argv1).href
  }
}

if (isRunAsMain()) {
  const result = detectInstallMethod({ scriptPath: fileURLToPath(import.meta.url) })
  console.log(describeDetection(result))
  // Undetermined is a real answer and must be actionable from a shell too, so
  // it exits non-zero rather than printing a sentence a script would ignore.
  if (result.method === 'unknown') process.exitCode = 1
}
