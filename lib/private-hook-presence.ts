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

import { isOwnHookScript, ownedHookOf } from './claude-preseed.mjs'
import { hooksOffIn, sessionSettingsFiles } from './floor-hook-presence.js'

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
  /** The real path of a file, or null; given, a hook that names this install's script in another spelling counts. */
  realpath?: (path: string) => string | null
  join: (...parts: string[]) => string
}

export interface PrivateHookPresence {
  registered: boolean
  /** Where it was found, or why it was not, for the daemon's one boot line. */
  where: string
  /** The settings file that switches every hook off ("disableAllHooks"), when one does. */
  hooksOff?: string
  /**
   * A session folder's `.claude/settings.local.json` that is there and is not a JSON object, while the hook is not
   * registered. The hook writer leaves such a file exactly as it is (it holds the owner's own hooks and
   * permissions, lib/claude-preseed.mjs loadSettingsOrRefuse), so no hook is written until the owner mends or
   * removes it, and a restart cannot help.
   */
  unreadableSettings?: string
}

export function privateHookPresence(input: PrivateHookPresenceInput): PrivateHookPresence {
  // Every hook switched off at any level: none runs, the plugin's own hooks file included.
  const hooksOff = hooksOffIn(sessionSettingsFiles(input), input.readFile)
  if (hooksOff) return { registered: false, where: `every hook is switched off by "disableAllHooks" in ${hooksOff}`, hooksOff }
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
  // The files the hook writer writes: the only ones whose state decides whether a hook CAN be written.
  const writerFiles = new Set<string>()
  for (const folder of input.folders) {
    if (!folder) continue
    const local = input.join(folder, '.claude', 'settings.local.json')
    writerFiles.add(local)
    settingsFiles.push(local)
    settingsFiles.push(input.join(folder, '.claude', 'settings.json'))
  }
  if (input.configDir) settingsFiles.push(input.join(input.configDir, 'settings.json'))
  let unreadableSettings: string | undefined
  for (const file of settingsFiles) {
    const read = readJsonObject(file, input)
    if (read.state === 'ok' && registersPrivateHook(read.parsed, readerOpts(input, false))) {
      return { registered: true, where: file }
    }
    if (read.state === 'unreadable' && unreadableSettings === undefined && writerFiles.has(file)) unreadableSettings = file
  }
  return {
    registered: false,
    where: `no ${PRIVATE_HOOK_SCRIPT} UserPromptSubmit entry in ${[...hooksFiles, ...settingsFiles].join(', ') || 'any file'}`,
    ...(unreadableSettings === undefined ? {} : { unreadableSettings }),
  }
}

/**
 * One settings or hooks file as the hook writer would read it: not there, a JSON object, or there and not one. A
 * byte order mark is read past (Windows PowerShell writes one, and JSON.parse refuses it), and an empty file is an
 * empty object, exactly as lib/claude-preseed.mjs loadSettingsOrRefuse has it.
 */
function readJsonObject(
  file: string,
  input: PrivateHookPresenceInput,
): { state: 'missing' } | { state: 'unreadable' } | { state: 'ok'; parsed: Record<string, unknown> } {
  let text: unknown
  try {
    text = input.readFile(file)
  } catch {
    return { state: 'missing' }
  }
  if (typeof text !== 'string') return { state: 'missing' }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (body.trim() === '') return { state: 'ok', parsed: {} }
  try {
    const parsed: unknown = JSON.parse(body)
    return isRecord(parsed) ? { state: 'ok', parsed } : { state: 'unreadable' }
  } catch {
    return { state: 'unreadable' }
  }
}

function fileRegisters(file: string, input: PrivateHookPresenceInput, pluginHooksFile: boolean): boolean {
  const read = readJsonObject(file, input)
  return read.state === 'ok' && registersPrivateHook(read.parsed, readerOpts(input, pluginHooksFile))
}

/** What registersPrivateHook is told about this install: its root, and how to ask a file's real path. */
function readerOpts(input: PrivateHookPresenceInput, pluginRootVariable: boolean) {
  return { exists: input.exists, pluginRootVariable, pluginRoot: input.pluginRoot, ...(input.realpath ? { realpath: input.realpath } : {}) }
}

/**
 * Does one parsed settings or hooks file register the private turn hook as a
 * synchronous UserPromptSubmit command? An async hook cannot write the marker
 * before the first tool call, so it does not count. Exported for the tests.
 */
export function registersPrivateHook(
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
  const matchers = hooks && Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : []
  for (const matcher of matchers) {
    if (!isRecord(matcher) || !Array.isArray(matcher.hooks)) continue
    for (const hook of matcher.hooks) {
      // Only the plugin's own entry counts, by the one definition the writer uses (lib/claude-preseed.mjs
      // ownedHookOf): node running the script by an absolute path, on this event, under its matcher, blocking.
      // A hook that only mentions the script's name is the owner's, and it is not this hook.
      const owned = ownedHookOf('UserPromptSubmit', matcher, hook, { pluginRootVariable: opts.pluginRootVariable })
      if (!owned || owned.script !== PRIVATE_HOOK_SCRIPT || !isRecord(hook) || !Array.isArray(hook.args)) continue
      const path = String(hook.args[0])
      if (path.startsWith('${CLAUDE_PLUGIN_ROOT}/')) return true
      // This install's own script, on disk: a file of the same name anywhere else writes no turn marker of ours.
      if (opts.exists(path) && isOwnHookScript(path, PRIVATE_HOOK_SCRIPT, opts)) return true
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
  if (presence.hooksOff) {
    return (
      `private turn: the private turn hook is NOT registered for this session (${presence.where}). ` +
      'Boards, schedule and browser tools will refuse every call while it is: take that line out of the file, then ' +
      'start this agent again'
    )
  }
  if (presence.unreadableSettings) {
    return (
      `private turn: the private turn hook is NOT registered for this session (${presence.where}). ` +
      'Boards, schedule and browser tools will refuse every call until it is, and this daemon cannot write it: the ' +
      `settings file ${presence.unreadableSettings} is not valid JSON, so it was left untouched. ` +
      'Fix or remove that file, then start this agent again'
    )
  }
  return (
    `private turn: the private turn hook is NOT registered for this session (${presence.where}). ` +
    // Not "run bgos-agent update": that resets a clone to the head of origin/main, released or not (board row
    // 84c23fab), and a clone's daemon now writes the hook itself at every boot (board row f83db4b7).
    'Boards, schedule and browser tools will refuse every call until it is: a clone\'s daemon writes it into its ' +
    'workspace at boot (the "hooks:" line), and it loads when this agent restarts'
  )
}

/** What a refused private call says when the cause is the missing hook, not the sender. */
export const PRIVATE_HOOK_MISSING_REFUSAL =
  'This private action did not start because the HOAI private turn hook is not registered for this session, so no sender can be verified. ' +
  'Ask the owner to restart this agent, so it loads the hook its daemon writes at boot.'

/** The hook writer's file, named by its place in an agent folder: the only name for it a chat may carry. */
const SETTINGS_FILE_IN_AGENT_FOLDER = '.claude/settings.local.json'

/**
 * What a refused private call says when the cause is the missing hook. Which advice is right depends on why it is
 * missing: a daemon writes the hook at boot and a restart loads it, unless the folder's settings file is not JSON.
 * Then nothing can be written until the owner mends or removes that file, so the refusal names it.
 *
 * BY ITS PLACE IN THE AGENT FOLDER, NEVER BY ITS FULL PATH. This text is read in a chat, and an agent answers in
 * groups too: a folder name on the owner's computer is not for them. The full path is in the log, in the boot
 * line (privateHookBootLine).
 */
export function privateHookMissingRefusal(presence: Pick<PrivateHookPresence, 'unreadableSettings'> | null | undefined): string {
  if (!presence?.unreadableSettings) return PRIVATE_HOOK_MISSING_REFUSAL
  return (
    'This private action did not start because the HOAI private turn hook is not registered for this session, so no sender can be verified. ' +
    `The hook cannot be written because the settings file ${SETTINGS_FILE_IN_AGENT_FOLDER} in this agent's folder is not valid JSON. ` +
    'Ask the owner to fix or remove it, and then start this agent again: a restart alone will not help.'
  )
}

/**
 * Is the private turn hook live in the session this daemon serves, NOW (QUIETTURN4, the two account test,
 * 2026-11-13)? The boot read above looks at the settings files once. A clone's boot that found no entry writes it
 * (registerCloneHooksAtBoot) and asks for one restart, and the CLI can run the hook from its next prompt on, long
 * before that restart. The boot read stayed false for the whole daemon life, so the quiet turn hold (which needs the
 * hook) was off: on the rig a share recipient's card reached the owner's voice ask and ended its trust, and the
 * refusal blamed a hook that was in fact running.
 *
 * The proof is the hook's own work, never a file on disk: the tracker hands back a turn with a `markerPath` only
 * when the marker the hook wrote at UserPromptSubmit matched an admitted prompt. A forwarder line alone (the async
 * telemetry hook) proves nothing. Once proven it stays proven for this daemon life: the hold grants nothing and only
 * keeps other cards out of the owner's turn, so a late wrong "live" costs a wait, never a permission.
 */
export interface PrivateHookLiveness {
  /** The boot read found the hook, or its marker has been read for a turn since. */
  live(): boolean
  /** A turn the tracker resolved (privateTurns.current). Returns live() after it. */
  noteTurn(turn: { markerPath?: unknown } | null | undefined): boolean
  /**
   * The same answer in the boot read's shape, read at each use: `registered` is live(), `where` the boot read's
   * until the marker proves it. server.ts keeps its name, PRIVATE_HOOK, so every reader (and every test harness
   * that runs a slice of server.ts with its own PRIVATE_HOOK) reads it unchanged.
   */
  readonly presence: PrivateHookPresence
}

export function createPrivateHookLiveness({ atBoot, log = () => {} }: {
  atBoot: PrivateHookPresence
  log?: (line: string) => void
}): PrivateHookLiveness {
  let proven = false
  const live = () => atBoot.registered || proven
  const presence: PrivateHookPresence = {
    get registered() { return live() },
    get where() { return atBoot.registered || !proven ? atBoot.where : 'its marker was read for a turn in this daemon life' },
    get unreadableSettings() { return live() ? undefined : atBoot.unreadableSettings },
  }
  return {
    live,
    presence,
    noteTurn(turn) {
      if (!live() && turn && typeof turn.markerPath === 'string' && turn.markerPath !== '') {
        proven = true
        try { log(privateHookLiveLine()) } catch { /* A log line is best effort. */ }
      }
      return live()
    },
  }
}

/** Said once, when a daemon that booted without the hook first reads its marker. */
export function privateHookLiveLine(): string {
  return 'private turn: the private turn hook is live in this session (its marker was read for a turn); ' +
    'the quiet turn hold and the refusal wording follow it from now on'
}
