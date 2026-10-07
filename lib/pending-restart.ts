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
 * lib/marketplace-update.mjs pendingMarketplaceRestartVersion.
 *
 * WHY the clone checkout (E5, end to end run 2026-10-07). On a CLONE install
 * the answer came only from the daemon's own self updater: its live state,
 * else the auto-update.json target while validationPending. A clone moved by
 * any other path (git pull, bgos-agent update, a hand checkout) left both
 * null, and since the watcher believes a FRESH daemon's answer over its own
 * reading (lib/keepalive-plan.mjs decidePendingRestart, review daemon F7),
 * the agent was never restarted onto code already on disk: the sandbox clone
 * moved 0.61.5 to 0.62.0 and both agents stayed 'supervised'. The self
 * updater's value still wins when set (it names the target it is validating);
 * otherwise the version in the package.json of the root this daemon RUNS from
 * (the same root and reader the running version was captured with at boot)
 * against that running version is the answer.
 *
 * Never throws: telemetry must never break a heartbeat. Each source is read
 * on its own guard, so one unreadable file cannot hide what another says.
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

/** A reader's answer, or null when it throws: one broken source must not
 *  blind the next one. */
function attempt(read: () => string | null | undefined): string | null {
  try {
    return read() ?? null
  } catch {
    return null
  }
}

/**
 * The pending restart version for this daemon.
 *   marketplace  installed_plugins.json version vs the running version
 *   clone        the git updater's live answer, else the staged target in
 *                auto-update.json, else the checkout's package.json version
 *                vs the running version (E5)
 * Every reader is a thunk so a clone never reads the marketplace file, a
 * marketplace install never consults the clone updater's state or the
 * checkout, and the checkout is read only when the self updater has nothing.
 */
export function resolvePendingRestartVersion(input: {
  installMethod: 'marketplace' | 'clone'
  runningVersion: string | null | undefined
  updaterPending: () => string | null | undefined
  stagedTargetVersion: () => string | null | undefined
  readInstalledPlugins: () => string | null
  /** The version in the package.json of the root this daemon runs from, read
   *  now (not at boot), or null when it is missing or unreadable. */
  readCheckoutVersion: () => string | null | undefined
}): string | null {
  try {
    if (input.installMethod === 'marketplace') {
      const installed = installedEntryFrom(parseJsonOrNull(input.readInstalledPlugins()))
      return pendingMarketplaceRestartVersion({ installed, runningVersion: input.runningVersion ?? null })
    }
    const fromUpdater = attempt(input.updaterPending)
    if (fromUpdater) return fromUpdater
    const staged = pendingRestartVersionFrom(input.runningVersion, attempt(input.stagedTargetVersion))
    if (staged) return staged
    return pendingRestartVersionFrom(input.runningVersion, attempt(input.readCheckoutVersion))
  } catch {
    return null
  }
}
