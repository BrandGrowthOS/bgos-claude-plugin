/**
 * Is the blocking floor hook really registered for the session this daemon
 * serves? The answer decides whether `hard_floor` is declared (0.53.0).
 *
 * WHY THE DECLARATION NEEDS IT. `hard_floor` tells the served canon to say to
 * the agent "a hook stops a listed action even with full access, and your
 * relay holds it", and it is what the owner turns the switch on against. The
 * hold happens only because bin/hoai-floor-hook.mjs makes the CLI raise a
 * permission request under --dangerously-skip-permissions; with no hook no
 * request is raised at all, the relay never sees the action, and `rm -rf` runs
 * unasked while the canon says it cannot. A marketplace install always has the
 * hook (the plugin's own hooks/hooks.json registers it). A CLONE does not: the
 * CLI never reads a clone's hooks file, so the entry has to be in a settings
 * file the CLI reads, and only the launchers and `bgos-agent install` write it
 * (lib/claude-preseed.mjs ensureHookEntries). The review's case: an always on
 * agent installed at 0.48.0 and moved to 0.53.0 by `bgos-agent update`, whose
 * service starts `claude` directly, so nothing wrote the floor entry and the
 * unattended, full access agent was exactly the one with no floor.
 *
 * So the daemon LOOKS, once at boot (the CLI reads its hooks at launch, so a
 * later write does not reach this session), and declares only what it found:
 *
 *   - the plugin's own hooks file, when this daemon was loaded as an installed
 *     plugin (a marketplace install), or when the CLI named a plugin root;
 *   - otherwise the settings files the CLI reads for this session: the
 *     project's `.claude/settings.local.json` and `.claude/settings.json` in
 *     each of the session's folders (lib/floor-state.mjs daemonFloorFolders),
 *     and the user's own `settings.json` in the CLI's config folder.
 *
 * An entry counts when it runs `hoai-floor-hook.mjs` as a PreToolUse command
 * that is NOT async (an async hook cannot stop anything) and, when it names
 * the script by an absolute path, that file exists. Anything unreadable reads
 * as not found: fail closed, the canon then says less than the daemon can do,
 * never more.
 *
 * Pure: every file read is injected, so the tests hold each case in place.
 */

import { declaredCapabilities } from './declared-capabilities.js'
import { HARD_FLOOR_TOKEN } from './claude-capability-tokens.js'

/** The floor hook's script name, the one thing every registration shares. */
export const FLOOR_HOOK_SCRIPT = 'hoai-floor-hook.mjs'

export interface FloorHookPresenceInput {
  installMethod: 'marketplace' | 'clone'
  /** The root this daemon was loaded from (server.ts PLUGIN_ROOT). */
  pluginRoot: string
  /** The session's folders, most specific first. */
  folders: readonly string[]
  /** The CLI's config folder (CLAUDE_CONFIG_DIR or ~/.claude). */
  configDir: string
  env: Record<string, string | undefined>
  /** Answers the file's text, or throws. */
  readFile: (path: string) => string
  exists: (path: string) => boolean
  join: (...parts: string[]) => string
}

export interface FloorHookPresence {
  registered: boolean
  /** Where it was found, or why it was not, for the daemon's one boot line. */
  where: string
}

export function floorHookPresence(input: FloorHookPresenceInput): FloorHookPresence {
  const hooksFiles: string[] = []
  if (input.installMethod === 'marketplace' && input.pluginRoot) {
    hooksFiles.push(input.join(input.pluginRoot, 'hooks', 'hooks.json'))
  }
  const namedRoot = (input.env.CLAUDE_PLUGIN_ROOT ?? '').trim()
  if (namedRoot) hooksFiles.push(input.join(namedRoot, 'hooks', 'hooks.json'))
  for (const file of hooksFiles) {
    if (fileRegistersFloorHook(file, input, true)) return { registered: true, where: file }
  }
  const settingsFiles: string[] = []
  for (const folder of input.folders) {
    if (!folder) continue
    settingsFiles.push(input.join(folder, '.claude', 'settings.local.json'))
    settingsFiles.push(input.join(folder, '.claude', 'settings.json'))
  }
  if (input.configDir) settingsFiles.push(input.join(input.configDir, 'settings.json'))
  for (const file of settingsFiles) {
    if (fileRegistersFloorHook(file, input, false)) return { registered: true, where: file }
  }
  return {
    registered: false,
    where: `no blocking ${FLOOR_HOOK_SCRIPT} entry in ${[...hooksFiles, ...settingsFiles].join(', ') || 'any file'}`,
  }
}

function fileRegistersFloorHook(
  file: string,
  input: FloorHookPresenceInput,
  pluginHooksFile: boolean,
): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(input.readFile(file))
  } catch {
    return false
  }
  return registersFloorHook(parsed, {
    exists: input.exists,
    // ${CLAUDE_PLUGIN_ROOT} is expanded by the CLI only in a plugin's own
    // hooks file, so a path spelled with it counts there and nowhere else.
    pluginRootVariable: pluginHooksFile,
  })
}

/**
 * Does one parsed settings or hooks file register the floor hook as a
 * blocking PreToolUse command? Exported for the tests.
 */
export function registersFloorHook(
  parsed: unknown,
  opts: { exists: (path: string) => boolean; pluginRootVariable: boolean },
): boolean {
  const hooks = isRecord(parsed) && isRecord(parsed.hooks) ? parsed.hooks : null
  const matchers = hooks && Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []
  for (const matcher of matchers) {
    if (!isRecord(matcher) || !Array.isArray(matcher.hooks)) continue
    for (const hook of matcher.hooks) {
      if (!isRecord(hook) || hook.type !== 'command' || hook.async === true) continue
      const args = Array.isArray(hook.args) ? hook.args : []
      const values = [hook.command, ...args].filter((v): v is string => typeof v === 'string')
      const script = values.find((v) => v.includes(FLOOR_HOOK_SCRIPT))
      if (!script) continue
      if (script.includes('${CLAUDE_PLUGIN_ROOT}')) {
        if (opts.pluginRootVariable) return true
        continue
      }
      const path = script.trim().replace(/^["']|["']$/g, '')
      const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
      if (!absolute || opts.exists(path)) return true
    }
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The daemon's one boot line about the floor, which says what the declaration
 * REALLY carries.
 *
 * WHY IT DEPENDS ON THE AUTH MODE. hard_floor is declared only on a pairing
 * AND only where the hook is found (lib/declared-capabilities.ts). The line
 * used to depend on the hook alone, so an API key daemon with the hook said
 * "declaring the floor capability on a pairing" while declaring nothing: the
 * final live proof read it on exactly such a daemon. Now "declared" in this
 * line is read off declaredCapabilities itself, so the two cannot disagree,
 * and an API key daemon is told plainly that the floor is not declared and
 * why (the floor check route is pairing scoped, so nothing is held).
 */
export function floorBootLine(presence: FloorHookPresence, authMode: 'pairing' | 'apikey'): string {
  const declared = declaredCapabilities({
    canInjectGoal: false,
    floorHook: presence.registered,
    authMode,
  }).includes(HARD_FLOOR_TOKEN)
  if (declared) {
    return (
      `floor: the blocking floor hook is registered (${presence.where}); ` +
      `the floor capability (${HARD_FLOOR_TOKEN}) is declared on this pairing`
    )
  }
  const hook = presence.registered
    ? `floor: the blocking floor hook is registered (${presence.where})`
    : `floor: the blocking floor hook is NOT registered for this session (${presence.where})`
  if (authMode === 'apikey') {
    return (
      `${hook}, but this daemon connects with an API key, so the floor capability ` +
      `(${HARD_FLOOR_TOKEN}) is NOT declared: the floor check is pairing only, a listed action ` +
      'is not held for the owner, and the agent is not told a hook stops one. ' +
      (presence.registered
        ? 'Pair the agent to get the floor'
        : 'The floor needs a pairing and the hook: pair the agent, then relaunch through a launcher or run bgos-agent update')
    )
  }
  return (
    `${hook}; the floor capability (${HARD_FLOOR_TOKEN}) is NOT declared, so the agent is not told ` +
    'a hook stops a listed action. Relaunch through a launcher or run bgos-agent update to write it'
  )
}
