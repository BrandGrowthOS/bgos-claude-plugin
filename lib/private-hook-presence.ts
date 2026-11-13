/**
 * Is the private turn hook really registered for the session this daemon
 * serves? (board bbbf3438 follow-up: boards, schedule and browser tools refused
 * on every turn after 0.67.0 on every agent whose folder carried no entry.)
 *
 * WHY THE DAEMON LOOKS. Since 0.67.0 a private tool call runs only inside a
 * turn whose marker bin/hoai-private-turn-hook.mjs wrote at UserPromptSubmit.
 * A marketplace install gets the hook from the plugin's own hooks/hooks.json. A
 * CLONE does not: the CLI never reads a clone's hooks file, so the entry has to
 * be in a settings file the CLI reads (lib/claude-preseed.mjs ensureHookEntries,
 * written by `bgos-agent install` and update). A folder that never carried one
 * has no marker, ever, and every private call refuses with "its current sender
 * could not be verified", which reads as a sender problem and is not.
 *
 * The gate stays closed without the hook: failing open would switch it off on
 * exactly the installs that lack it. This module only says WHY, once, at boot,
 * and in the refusal text.
 *
 * Pure: every file read is injected, like lib/floor-hook-presence.ts.
 */

/** The private turn hook's script name, the one thing every registration shares. */
export const PRIVATE_HOOK_SCRIPT = 'hoai-private-turn-hook.mjs'

export interface PrivateHookPresenceInput {
  installMethod: 'marketplace' | 'clone'
  /** The root this daemon was loaded from (server.ts PLUGIN_ROOT). */
  pluginRoot: string
  /** The session's folders, most specific first. */
  folders: readonly string[]
  /** The CLI's config folder (CLAUDE_CONFIG_DIR or ~/.claude). */
  configDir: string
  env: Record<string, string | undefined>
  readFile: (path: string) => string
  exists: (path: string) => boolean
  join: (...parts: string[]) => string
}

export interface PrivateHookPresence {
  registered: boolean
  /** Where it was found, or why it was not, for the daemon's one boot line. */
  where: string
}

export function privateHookPresence(input: PrivateHookPresenceInput): PrivateHookPresence {
  const hooksFiles: string[] = []
  if (input.installMethod === 'marketplace' && input.pluginRoot) {
    hooksFiles.push(input.join(input.pluginRoot, 'hooks', 'hooks.json'))
  }
  const namedRoot = (input.env.CLAUDE_PLUGIN_ROOT ?? '').trim()
  if (namedRoot) hooksFiles.push(input.join(namedRoot, 'hooks', 'hooks.json'))
  for (const file of hooksFiles) {
    if (fileRegisters(file, input, true)) return { registered: true, where: file }
  }
  const settingsFiles: string[] = []
  for (const folder of input.folders) {
    if (!folder) continue
    settingsFiles.push(input.join(folder, '.claude', 'settings.local.json'))
    settingsFiles.push(input.join(folder, '.claude', 'settings.json'))
  }
  if (input.configDir) settingsFiles.push(input.join(input.configDir, 'settings.json'))
  for (const file of settingsFiles) {
    if (fileRegisters(file, input, false)) return { registered: true, where: file }
  }
  return {
    registered: false,
    where: `no ${PRIVATE_HOOK_SCRIPT} UserPromptSubmit entry in ${[...hooksFiles, ...settingsFiles].join(', ') || 'any file'}`,
  }
}

function fileRegisters(file: string, input: PrivateHookPresenceInput, pluginHooksFile: boolean): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(input.readFile(file))
  } catch {
    return false
  }
  return registersPrivateHook(parsed, { exists: input.exists, pluginRootVariable: pluginHooksFile })
}

/**
 * Does one parsed settings or hooks file register the private turn hook as a
 * synchronous UserPromptSubmit command? An async hook cannot write the marker
 * before the first tool call, so it does not count. Exported for the tests.
 */
export function registersPrivateHook(
  parsed: unknown,
  opts: { exists: (path: string) => boolean; pluginRootVariable: boolean },
): boolean {
  const hooks = isRecord(parsed) && isRecord(parsed.hooks) ? parsed.hooks : null
  const matchers = hooks && Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : []
  for (const matcher of matchers) {
    if (!isRecord(matcher) || !Array.isArray(matcher.hooks)) continue
    for (const hook of matcher.hooks) {
      if (!isRecord(hook) || hook.type !== 'command' || hook.async === true) continue
      const args = Array.isArray(hook.args) ? hook.args : []
      const values = [hook.command, ...args].filter((v): v is string => typeof v === 'string')
      const script = values.find((v) => v.includes(PRIVATE_HOOK_SCRIPT))
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

/** The daemon's one boot line. Loud on purpose: the cost is every private tool call. */
export function privateHookBootLine(presence: PrivateHookPresence): string {
  if (presence.registered) {
    return `private turn: the private turn hook is registered (${presence.where})`
  }
  return (
    `private turn: the private turn hook is NOT registered for this session (${presence.where}). ` +
    // Not "run bgos-agent update": that used to reset a clone to the head of origin/main, released or not (board
    // rows 84c23fab and 01a0db74; it now follows the published release), and a clone's daemon writes the hook itself
    // at every boot anyway (board row f83db4b7).
    'Boards, schedule and browser tools will refuse every call until it is: a clone\'s daemon writes it into its ' +
    'workspace at boot (the "hooks:" line), and it loads when this agent restarts'
  )
}

/** What a refused private call says when the cause is the missing hook, not the sender. */
export const PRIVATE_HOOK_MISSING_REFUSAL =
  'This private action did not start because the HOAI private turn hook is not registered for this session, so no sender can be verified. ' +
  'Ask the owner to restart this agent, so it loads the hook its daemon writes at boot.'
