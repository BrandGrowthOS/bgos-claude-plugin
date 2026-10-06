/**
 * The daemon's pendingRestartVersion: the plugin version installed on disk
 * that this process is not running yet, or null. One composition shared by
 * the heartbeat's updateReadiness (wire contract v1) and the published
 * agent-state.json (lib/agent-state.ts, design section 7), so the app and the
 * per-machine watcher read the exact same fact.
 *
 * WHY (design fact 6, 2026-10-06). On a MARKETPLACE install selfUpdater is
 * null (server.ts main: the git updater is for clones only) and
 * auto-update.json is written only by that clone updater, so the old
 * `selfUpdater?.pendingRestartVersion() ?? <auto-update.json target>` was
 * null on every marketplace agent, always. Claude Code updates a marketplace
 * plugin in place (installed_plugins.json moves to the new version and the
 * new cache dir), the running daemon keeps the old code until its session
 * restarts, and nothing said so: the app could not show the agent as staged
 * and the watcher could not tell it needed a restart. The marketplace answer
 * is therefore the hoai@hoai entry of <config>/plugins/installed_plugins.json
 * (lib/plugin-cli.mjs installedEntryFrom, the reader the marketplace updater
 * already uses) against the version captured at boot, compared by
 * lib/marketplace-update.mjs pendingMarketplaceRestartVersion. A clone keeps
 * its existing answer unchanged.
 *
 * Never throws: telemetry must never break a heartbeat.
 */

import { pendingMarketplaceRestartVersion } from './marketplace-update.mjs'
import { installedEntryFrom, marketplaceConfigPaths } from './plugin-cli.mjs'
import { pendingRestartVersionFrom } from './self-update.js'

/** <config>/plugins/installed_plugins.json, in the config dir's own
 *  separator style (CLAUDE_CONFIG_DIR moves the whole tree). */
export function installedPluginsPath(configDir: string): string {
  return marketplaceConfigPaths(configDir).installedPlugins
}

function parseJsonOrNull(raw: string | null | undefined): unknown {
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** The installed hoai@hoai version, or null when the file, the entry or its
 *  version is missing or unreadable. */
export function readInstalledPluginVersion(
  configDir: string,
  readFile: (path: string) => string | null,
): string | null {
  try {
    return installedEntryFrom(parseJsonOrNull(readFile(installedPluginsPath(configDir)))).version
  } catch {
    return null
  }
}

/**
 * The pending restart version for this daemon.
 *   marketplace  installed_plugins.json version vs the running version
 *   clone        the git updater's live answer, else the staged target in
 *                auto-update.json (the pre-existing rule, unchanged)
 * Every reader is a thunk so a clone never reads the marketplace file and a
 * marketplace install never consults the clone updater's state.
 */
export function resolvePendingRestartVersion(input: {
  installMethod: 'marketplace' | 'clone'
  runningVersion: string | null | undefined
  updaterPending: () => string | null | undefined
  stagedTargetVersion: () => string | null | undefined
  readInstalledPlugins: () => string | null
}): string | null {
  try {
    if (input.installMethod === 'marketplace') {
      const installed = installedEntryFrom(parseJsonOrNull(input.readInstalledPlugins()))
      return pendingMarketplaceRestartVersion({ installed, runningVersion: input.runningVersion ?? null })
    }
    return (
      input.updaterPending() ??
      pendingRestartVersionFrom(input.runningVersion, input.stagedTargetVersion() ?? null)
    )
  } catch {
    return null
  }
}
