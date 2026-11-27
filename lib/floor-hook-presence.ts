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

import { exactOwnedHookOf, hooksOffVerdict, isOwnHookScript } from './claude-preseed.mjs'
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
  /** The CLI's config folder (CLAUDE_CONFIG_DIR or ~/.claude), its settings counted; '' for none. */
  configDir: string
  /**
   * Config folders the CLI may be using that the caller cannot vouch for (the daemon's own environment names them,
   * and the folder's .mcp.json can set that environment): read for the hook switch only, never counted.
   */
  otherConfigDirs?: readonly string[]
  /** The machine's managed settings files (lib/clone-hooks.mjs managedSettingsFiles), read for the hook switches. */
  managedFiles?: readonly string[]
  env: Record<string, string | undefined>
  /** Answers the file's text, or throws. */
  readFile: (path: string) => string
  exists: (path: string) => boolean
  /** The real path of a file, or null; given, a hook that names this install's script in another spelling counts. */
  realpath?: (path: string) => string | null
  join: (...parts: string[]) => string
}

export interface FloorHookPresence {
  registered: boolean
  /** Where it was found, or why it was not, for the daemon's one boot line. */
  where: string
  /** The settings file that switches every hook off ("disableAllHooks"), or may (one that cannot be read). */
  hooksOff?: string
  /** True when that file is there and cannot be read, so it may switch them off. */
  hooksOffUnknown?: boolean
  /** True when that file is the machine's managed settings, which only its administrator changes. */
  hooksOffManaged?: boolean
}

/** What one hook switch verdict says (lib/claude-preseed.mjs hooksOffVerdict). */
export interface HookSwitchVerdict {
  file: string
  key: string
  cause: 'on' | 'not-json' | 'unreadable'
  why: string
  managed: boolean
}

/**
 * The settings files the CLI reads for a session in these folders: each folder's local and project settings, then
 * the user's. Shared by both hook readers.
 */
export function sessionSettingsFiles(input: Pick<FloorHookPresenceInput, 'folders' | 'configDir' | 'join'>): string[] {
  const files: string[] = []
  for (const folder of input.folders) {
    if (!folder) continue
    files.push(input.join(folder, '.claude', 'settings.local.json'))
    files.push(input.join(folder, '.claude', 'settings.json'))
  }
  if (input.configDir) files.push(input.join(input.configDir, 'settings.json'))
  return files
}

/** Is this error the reader's word that a file is not there? */
function isMissingFile(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return true
  return /^ENOENT\b/.test(String((err as { message?: unknown } | null)?.message ?? ''))
}

/**
 * Does a settings file this session's CLI reads switch every hook off, or may it? The first one that does, or null.
 * On at any level, no hook runs (measured on 2.1.332), so neither hook is registered, whatever the files hold. FAIL
 * CLOSED: only a file that is not there (readFile throws ENOENT) is no file; one that is there and cannot be read
 * may hold the switch.
 */
export function hookSwitchVerdict(
  input: Pick<FloorHookPresenceInput, 'folders' | 'configDir' | 'otherConfigDirs' | 'managedFiles' | 'join' | 'readFile'>,
  { settingsHooks = true }: { settingsHooks?: boolean } = {},
): HookSwitchVerdict | null {
  const files = sessionSettingsFiles(input)
  for (const dir of input.otherConfigDirs ?? []) {
    const file = dir ? input.join(dir, 'settings.json') : ''
    if (file && !files.includes(file)) files.push(file)
  }
  const readOf = (file: string) => {
    try {
      const text = input.readFile(file)
      return typeof text === 'string' ? { state: 'ok' as const, text } : { state: 'missing' as const }
    } catch (err) {
      if (isMissingFile(err)) return { state: 'missing' as const }
      return { state: 'unreadable' as const, why: `it could not be read (${String((err as Error)?.message ?? err)})` }
    }
  }
  const sources = [
    ...(input.managedFiles ?? []).filter(Boolean).map((file) => ({ file, read: readOf(file), managed: true })),
    ...files.map((file) => ({ file, read: readOf(file) })),
  ]
  return hooksOffVerdict(sources, { settingsHooks }) as HookSwitchVerdict | null
}

/** A presence that a verdict switched off. */
export function switchedOffPresence(off: HookSwitchVerdict): FloorHookPresence {
  return {
    registered: false,
    where: hookSwitchWhere(off),
    hooksOff: off.file,
    ...(off.cause === 'on' ? {} : { hooksOffUnknown: true }),
    ...(off.managed ? { hooksOffManaged: true } : {}),
  }
}

/** The boot line's account of a verdict. */
export function hookSwitchWhere(off: HookSwitchVerdict): string {
  if (off.cause !== 'on') return `hoai cannot tell whether every hook is switched off: ${off.file} is there and ${off.why}`
  if (off.key === 'allowManagedHooksOnly') return `only managed hooks run ("${off.key}" in ${off.file})`
  if (off.key === 'strictPluginOnlyCustomization') return `only an installed plugin's hooks run ("${off.key}" in ${off.file})`
  return `every hook is switched off by "${off.key}" in ${off.file}`
}

export function floorHookPresence(input: FloorHookPresenceInput): FloorHookPresence {
  const settingsFiles = sessionSettingsFiles(input)
  // Every hook off, or only managed ones on, or a file that cannot be read: nothing of the plugin's runs.
  const off = hookSwitchVerdict(input, { settingsHooks: false })
  if (off) return switchedOffPresence(off)
  const hooksFiles: string[] = []
  if (input.installMethod === 'marketplace' && input.pluginRoot) {
    hooksFiles.push(input.join(input.pluginRoot, 'hooks', 'hooks.json'))
  }
  const namedRoot = (input.env.CLAUDE_PLUGIN_ROOT ?? '').trim()
  if (namedRoot) hooksFiles.push(input.join(namedRoot, 'hooks', 'hooks.json'))
  for (const file of hooksFiles) {
    if (fileRegistersFloorHook(file, input, true)) return { registered: true, where: file }
  }
  // Only an installed plugin's hooks on (managed): an entry in a settings file does not run.
  const settingsOff = hookSwitchVerdict(input, { settingsHooks: true })
  if (settingsOff) return switchedOffPresence(settingsOff)
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
    // Windows PowerShell writes a byte order mark, which JSON.parse refuses: read past it, or hooks that are in
    // the file count as missing.
    const text = input.readFile(file)
    parsed = JSON.parse(typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return false
  }
  return registersFloorHook(parsed, {
    exists: input.exists,
    // ${CLAUDE_PLUGIN_ROOT} is expanded by the CLI only in a plugin's own
    // hooks file, so a path spelled with it counts there and nowhere else.
    pluginRootVariable: pluginHooksFile,
    pluginRoot: input.pluginRoot,
    ...(input.realpath ? { realpath: input.realpath } : {}),
  })
}

/**
 * Does one parsed settings or hooks file register the floor hook as a
 * blocking PreToolUse command? Exported for the tests.
 */
export function registersFloorHook(
  parsed: unknown,
  opts: {
    exists: (path: string) => boolean
    pluginRootVariable: boolean
    /** This install's root: an absolute path counts only when it is this install's own bin script. */
    pluginRoot?: string
    realpath?: (path: string) => string | null
  },
): boolean {
  const hooks = isRecord(parsed) && isRecord(parsed.hooks) ? parsed.hooks : null
  const matchers = hooks && Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []
  for (const matcher of matchers) {
    if (!isRecord(matcher) || !Array.isArray(matcher.hooks)) continue
    for (const hook of matcher.hooks) {
      // Only the plugin's own entry counts, exactly as the writer writes it (lib/claude-preseed.mjs
      // exactOwnedHookOf): `node` running the script by an absolute path, on this event, under its matcher, with
      // its own timeout, blocking, and no other key. Anything else may not run, or not every time.
      const owned = exactOwnedHookOf('PreToolUse', matcher, hook, { pluginRootVariable: opts.pluginRootVariable })
      if (!owned || owned.script !== FLOOR_HOOK_SCRIPT || !isRecord(hook) || !Array.isArray(hook.args)) continue
      const path = String(hook.args[0])
      if (path.startsWith('${CLAUDE_PLUGIN_ROOT}/')) return true
      // This install's own script, on disk: a file of the same name anywhere else, even an empty one, stops nothing.
      if (opts.exists(path) && isOwnHookScript(path, FLOOR_HOOK_SCRIPT, opts)) return true
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
  if (presence.hooksOff) {
    return (
      `floor: the blocking floor hook is NOT registered for this session (${presence.where}); ` +
      `the floor capability (${HARD_FLOOR_TOKEN}) is NOT declared, and no hook may run. ` +
      (presence.hooksOffManaged
        ? 'That file is this computer\'s managed settings: ask whoever manages it'
        : `${presence.hooksOffUnknown ? 'Mend or remove that file' : 'Take that line out of the file'}, then start this agent again`)
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
        : 'The floor needs a pairing and the hook: pair the agent, then relaunch through a launcher')
    )
  }
  return (
    `${hook}; the floor capability (${HARD_FLOOR_TOKEN}) is NOT declared, so the agent is not told ` +
    'a hook stops a listed action. Relaunch through a launcher to write it'
  )
}
