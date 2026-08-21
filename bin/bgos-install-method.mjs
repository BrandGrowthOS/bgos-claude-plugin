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
 * error anywhere. So the method is detected from evidence, never guessed:
 *   1. CLAUDE_PLUGIN_ROOT, when set, is the authority on where the plugin
 *      lives (Claude Code sets it when it loads a marketplace plugin);
 *      whether that root sits under <configDir>/plugins decides the method.
 *   2. Otherwise the REAL path of this script decides (realpath, so an npx
 *      shim or node_modules/.bin symlink cannot masquerade as a clone).
 *
 * Path comparison is segment based (never raw string prefixes, so a sibling
 * like .claude/pluginsX is not mistaken for .claude/plugins), tolerates / and
 * \ mixed in the same path, and is case insensitive for win32 style paths.
 *
 * Self-contained plain JavaScript: node >= 18 builtins only, no imports from
 * the TS plugin sources. Import-safe: every helper is exported and the CLI
 * block only runs when the file is executed directly, so tests can import the
 * pure pieces.
 */

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The channel spec that loads a marketplace install of the plugin. */
export const MARKETPLACE_CHANNEL_SPEC = 'plugin:hoai@hoai'
/** The channel spec that loads a local checkout running server.ts directly. */
export const CLONE_CHANNEL_SPEC = 'server:bgos'

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
 * Decide the install method from evidence, strongest first:
 *   1. CLAUDE_PLUGIN_ROOT set and under <configDir>/plugins: marketplace,
 *      with that root.
 *   2. CLAUDE_PLUGIN_ROOT set but elsewhere: clone, with that root.
 *   3. Otherwise the realpath of this script (symlink shims resolved): under
 *      the plugins dir means marketplace, anywhere else means clone; the
 *      plugin root is the directory containing bin/ either way.
 * @param {{
 *   scriptPath?: string,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   realpath?: (path: string) => string,
 * }} [opts]
 * @returns {{ method: 'marketplace' | 'clone', channelSpec: string, pluginRoot: string }}
 */
export function detectInstallMethod({
  scriptPath,
  env = process.env,
  home = homedir(),
  realpath = defaultRealpath,
} = {}) {
  const envRoot = String(env?.CLAUDE_PLUGIN_ROOT ?? '').trim()
  if (envRoot) {
    const method = isUnderPluginsDir(envRoot, { env, home }) ? 'marketplace' : 'clone'
    return { method, channelSpec: channelSpecFor(method), pluginRoot: envRoot }
  }
  const raw = String(scriptPath ?? '').trim()
  let resolved = raw
  if (raw) {
    try {
      resolved = realpath(raw)
    } catch {
      resolved = raw
    }
  }
  const method = isUnderPluginsDir(resolved, { env, home }) ? 'marketplace' : 'clone'
  return { method, channelSpec: channelSpecFor(method), pluginRoot: pluginRootFromScriptPath(resolved) }
}

/** The channel spec for a method. Anything not recognized as marketplace is
 *  treated as clone, the spec a raw checkout needs. */
function channelSpecFor(method) {
  return method === 'marketplace' ? MARKETPLACE_CHANNEL_SPEC : CLONE_CHANNEL_SPEC
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
 * @param {'marketplace' | 'clone'} method
 * @returns {string[]}
 */
export function launchFlagArgs(method) {
  return [
    '--dangerously-load-development-channels',
    method === 'marketplace' ? MARKETPLACE_CHANNEL_SPEC : CLONE_CHANNEL_SPEC,
  ]
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
 * One human line describing a detection result, including the launch command
 * so an operator (or the onboarding flow) can paste it as is.
 * @param {{ method?: string, pluginRoot?: string }} result
 */
export function describeDetection(result) {
  const method = result?.method === 'marketplace' ? 'marketplace' : 'clone'
  const root = String(result?.pluginRoot ?? '').trim() || '<unknown>'
  return `install method: ${method} (plugin root ${root}), launch with: ${launchCommand(method)}`
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
}
