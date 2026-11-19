/**
 * installed-plugin-refresh: bring an older marketplace install of hoai up to
 * the version the app expects (HOAI board row 05893eed, finding A).
 *
 * The one click Connect script runs `claude plugin marketplace add` and then
 * `claude plugin install hoai@hoai`. On a computer that already has hoai, the
 * install answers "already installed" whatever the version, so a MacBook with
 * 0.31.0 kept 0.31.0 (2026-11-12). The doctor then started that copy, which
 * is too old to have the launch shim, and the run failed at Verifying. The
 * tester fixed it by hand with `claude plugin marketplace update hoai` and
 * `claude plugin update hoai@hoai`.
 *
 * The rest of the Connect script (pairing, the doctor, the supervisor) runs
 * through `npx --package github:BrandGrowthOS/bgos-claude-plugin`, which is
 * the version the app expects. Pairing calls this with its own version: an
 * install older than it is updated with exactly those two commands, an
 * install at or past it is left alone, and nothing runs at all when there is
 * no marketplace install (a clone install is updated by its own path).
 *
 * `claude plugin update` stages the new version for the next start of Claude
 * Code. A session already running on the old copy keeps it until it
 * restarts; the doctor and the supervisor that run after pairing read the
 * installed path from installed_plugins.json, so they start the new one.
 *
 * Plain JavaScript, node builtins only (through plugin-cli.mjs), because
 * bin/bgos-pair.mjs imports it and runs under bare node via npx.
 */

import {
  classifyMarketplaceUpdate,
  classifyUpdate,
  marketplaceUpdateArgs,
  observeMarketplaceInstall,
  runClaudeCli,
  SEMVER_RE,
  updateArgs,
} from './plugin-cli.mjs'

/** The two commands, as a person types them, for the line that says what to run. */
export const MANUAL_REFRESH_COMMANDS = Object.freeze([
  ['claude', ...marketplaceUpdateArgs()].join(' '),
  'claude plugin update hoai@hoai',
])

/**
 * -1, 0 or 1 for two strict x.y.z versions (a leading `v` allowed), null when
 * either is not one. Never throws.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {-1 | 0 | 1 | null}
 */
export function compareVersions(a, b) {
  const parse = (value) => {
    if (typeof value !== 'string') return null
    const match = SEMVER_RE.exec(value.trim().replace(/^v/, ''))
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
  }
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return null
  for (let i = 0; i < 3; i++) {
    if (left[i] < right[i]) return -1
    if (left[i] > right[i]) return 1
  }
  return 0
}

/**
 * @typedef {(
 *   | { kind: 'not_installed' }
 *   | { kind: 'skipped', reason: string }
 *   | { kind: 'current', version: string }
 *   | { kind: 'updated', fromVersion: string | null, toVersion: string | null }
 *   | { kind: 'latest_published', fromVersion: string | null, toVersion: string | null }
 *   | { kind: 'failed', fromVersion: string | null, message: string }
 * )} RefreshResult
 */

/**
 * Update the marketplace install of hoai when it is older than
 * `expectedVersion`. Never throws: every outcome is a result, and a failure
 * carries the CLI's own line.
 *
 * - no marketplace install                 -> not_installed (no command runs)
 * - expectedVersion is not x.y.z           -> skipped (no command runs)
 * - installed >= expectedVersion           -> current (no command runs)
 * - installed older, or its version unread -> `claude plugin marketplace update hoai`
 *   then `claude plugin update hoai@hoai --scope user -y`, then the files are
 *   read again: updated (the version moved), latest_published (the
 *   marketplace has nothing newer), or failed.
 *
 * The marketplace refresh failing does not stop the plugin update: the
 * marketplace clone may already be current, and the update's own answer is
 * the verdict.
 *
 * @param {{
 *   expectedVersion: string,
 *   configDir?: string,
 *   env?: Record<string, string | undefined>,
 *   observe?: () => Promise<{ installed: { present: boolean, version: string | null } }>,
 *   runClaude?: (args: string[]) => Promise<unknown>,
 * }} input
 * @returns {Promise<RefreshResult>}
 */
export async function refreshInstalledPlugin({ expectedVersion, configDir, env, observe, runClaude }) {
  const look = observe ?? (() => observeMarketplaceInstall(configDir ? { configDir } : {}))
  const run = runClaude ?? ((args) => runClaudeCli(args, { env }))
  if (compareVersions(expectedVersion, expectedVersion) === null) {
    return { kind: 'skipped', reason: `the expected version ${String(expectedVersion)} is not a release version` }
  }
  let before
  try {
    before = await look()
  } catch {
    return { kind: 'not_installed' }
  }
  if (!before?.installed?.present) return { kind: 'not_installed' }
  const fromVersion = before.installed.version ?? null
  const order = compareVersions(fromVersion, expectedVersion)
  if (order !== null && order >= 0) return { kind: 'current', version: /** @type {string} */ (fromVersion) }

  const marketplace = classifyMarketplaceUpdate(await run(marketplaceUpdateArgs()))
  const update = classifyUpdate(await run(updateArgs()))
  if (update.kind === 'failed' || update.kind === 'garbage') {
    const refreshNote = marketplace.kind === 'updated' ? '' : ` (the marketplace refresh also failed: ${marketplace.message})`
    return { kind: 'failed', fromVersion, message: `${update.message}${refreshNote}` }
  }
  let after = null
  try {
    after = await look()
  } catch {
    after = null
  }
  const toVersion = after?.installed?.version ?? update.toVersion ?? update.version ?? null
  const moved = compareVersions(toVersion, fromVersion)
  if (moved === 1 || (fromVersion === null && toVersion !== null)) {
    return { kind: 'updated', fromVersion, toVersion }
  }
  if (update.kind === 'already_latest') return { kind: 'latest_published', fromVersion, toVersion }
  return {
    kind: 'failed',
    fromVersion,
    message: `claude plugin update answered "${update.message}" but the installed version is still ${toVersion ?? 'unknown'}`,
  }
}

/**
 * What pairing prints for a result. Nothing for a current install or no
 * marketplace install: there is nothing to say.
 * @param {RefreshResult} result
 * @param {string} expectedVersion
 * @returns {string[]}
 */
export function refreshReportLines(result, expectedVersion) {
  switch (result.kind) {
    case 'updated':
      return [
        `updated the installed hoai plugin from ${result.fromVersion ?? 'an unknown version'} to ${result.toVersion ?? 'the newest published version'} ` +
          `(this setup runs ${expectedVersion}). A Claude Code session that is already open keeps the old copy until it restarts.`,
      ]
    case 'latest_published':
      return [
        `the installed hoai plugin is ${result.fromVersion ?? 'an unknown version'}, the newest published version; ` +
          `this setup runs ${expectedVersion}, which is not published yet. Nothing to update.`,
      ]
    case 'failed':
      return [
        `the installed hoai plugin is ${result.fromVersion ?? 'an unknown version'}, older than ${expectedVersion}, and updating it failed: ${result.message}`,
        `run these two commands, then retry: ${MANUAL_REFRESH_COMMANDS.join(' && ')}`,
      ]
    case 'skipped':
      return [`left the installed hoai plugin as it is: ${result.reason}.`]
    default:
      return []
  }
}
