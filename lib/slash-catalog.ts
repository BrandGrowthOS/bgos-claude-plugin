// ── Built-in slash-command catalog (pure, unit-tested) ───────────────────────
//
// The entries synced to the BGOS backend so the app's composer can
// autocomplete when the user types `/`. Curated against the Claude Code CLI
// as of 2026-05. Missing entries are not catastrophic, users can still type
// commands manually.
//
// IMPORTANT INVARIANT: only advertise commands that ACTUALLY WORK when they
// arrive as a channel event. A BGOS slash command is NOT typed into the CLI;
// it reaches the daemon (and then the model) as an MCP channel notification,
// so host-level commands nothing can invoke must not be advertised as
// working. `/compact` was removed in 0.22.1 for exactly this reason: the
// BGOS context pill gated its Compact button on this catalog entry, the tap
// was forwarded to the agent as a channel event, and no code path anywhere
// triggered real host compaction, so the button provably did nothing (see
// prod messages 25455/25428/24004/23196: user /compact slash_commands with
// no effect and no reply).
//
// Since 0.24.0 a supervisor-level path EXISTS: when the daemon detects tmux
// control of the CLI's pane (lib/compact-inject.ts, BGOS_TMUX_SESSION or
// inherited TMUX/TMUX_PANE), it intercepts the /compact channel event and
// injects the literal `/compact` keystrokes into the composer, then confirms
// via the transcript's compact_boundary entry. `/compact` is therefore
// advertised CONDITIONALLY, per daemon, via catalogForCapabilities: ON only
// when the injection capability was detected at boot. BUILTIN_COMMANDS
// itself still never contains /compact, and the invariant stands for every
// other host-only command (/new stays unadvertised: no injection path for it
// yet, documented future work).

export interface SlashCommandEntry {
  command: string
  description: string
  scope: 'all'
  /** Local command body. This is never sent in the backend catalog. */
  prompt?: string
  /** Source context used only while expanding a local command body. */
  sourcePath?: string
  pluginRoot?: string
}

export interface SlashCommandWireEntry {
  command: string
  description: string
  scope: 'all'
}

export interface PreparedSlashCommands {
  wireCommands: SlashCommandWireEntry[]
  registry: ReadonlyMap<string, SlashCommandEntry>
  legacyAliases: ReadonlyMap<string, SlashCommandEntry>
  dropped: number
}

export interface SlashCommandDelivery {
  content: string
  meta: Record<string, string>
  registeredCommand: SlashCommandEntry | null
}

export interface SlashCommandPayload {
  messageType?: unknown
  message_type?: unknown
  commandName?: unknown
  command_name?: unknown
  commandArgs?: unknown
  command_args?: unknown
  text?: unknown
}

export type SlashCommandRoute =
  | { kind: 'not_slash' }
  | { kind: 'compact'; commandName: string; commandArgs: string }
  | { kind: 'directive'; delivery: SlashCommandDelivery }

export function slashCommandSyncPath(
  authMode: 'pairing' | 'apikey',
  assistantId: string,
): string {
  const encodedId = encodeURIComponent(assistantId)
  return authMode === 'pairing'
    ? `integrations/assistants/${encodedId}/commands`
    : `assistants/${encodedId}/commands`
}

export const MAX_SLASH_COMMANDS = 200
export const MAX_SLASH_COMMAND_NAME_LENGTH = 64
export const MAX_SLASH_COMMAND_PROMPT_CHARS = 64_000
const VALID_SLASH_COMMAND_NAME = /^[a-z0-9_]+(?:[-:][a-z0-9_]+)*$/

/** Convert a discovered command into the current backend wire contract. */
export function normalizeCommandName(raw: string): string | null {
  let name = raw.trim()
  if (name.startsWith('/')) name = name.slice(1)
  name = name.toLowerCase()
  if (
    !name ||
    name.length > MAX_SLASH_COMMAND_NAME_LENGTH ||
    !VALID_SLASH_COMMAND_NAME.test(name)
  ) {
    return null
  }
  return name
}

/**
 * Prepare the exact catalog sent to BGOS and retain its wire name to source
 * command mapping. Dedupe and truncation happen once here, so inbound lookup
 * cannot resolve a normalized collision to a command the picker did not get.
 */
export function prepareSlashCommands(
  commands: readonly SlashCommandEntry[],
  maxCommands = MAX_SLASH_COMMANDS,
): PreparedSlashCommands {
  const wireCommands: SlashCommandWireEntry[] = []
  const registry = new Map<string, SlashCommandEntry>()
  const legacyCandidates = new Map<string, SlashCommandEntry[]>()
  let dropped = 0

  for (const entry of commands) {
    const wireName = normalizeCommandName(entry.command)
    if (!wireName || registry.has(wireName)) {
      dropped++
      continue
    }
    const description = (entry.description || wireName).slice(0, 100)
    wireCommands.push({ command: wireName, description, scope: 'all' })
    registry.set(wireName, entry)
    const legacyName = legacyCommandName(wireName)
    if (legacyName && legacyName !== wireName) {
      const candidates = legacyCandidates.get(legacyName) ?? []
      candidates.push(entry)
      legacyCandidates.set(legacyName, candidates)
    }
    if (wireCommands.length >= maxCommands) break
  }

  // Older plugin versions rewrote native separators to underscores and cut
  // names to 32 characters before syncing. Backlog rows and picker taps made
  // before this version may still carry that spelling. Resolve it only when it
  // maps to one registered command and cannot shadow a current exact name.
  const legacyAliases = new Map<string, SlashCommandEntry>()
  for (const [legacyName, candidates] of legacyCandidates) {
    if (candidates.length === 1 && !registry.has(legacyName)) {
      legacyAliases.set(legacyName, candidates[0]!)
    }
  }

  return { wireCommands, registry, legacyAliases, dropped }
}

function legacyCommandName(wireName: string): string | null {
  const legacy = wireName
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
  return legacy || null
}

function commandToken(raw: unknown): string {
  return String(raw ?? '').trim().replace(/^\/+/, '')
}

export function isReservedHostSlashCommand(raw: unknown): boolean {
  return commandToken(raw).toLowerCase() === 'compact'
}

function slashTextParts(raw: string | undefined): {
  commandName: string
  commandArgs: string
} | null {
  const match = raw?.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  return {
    commandName: commandToken(match[1]),
    commandArgs: match[2] ?? '',
  }
}

export function resolveRegisteredSlashCommand(
  commandName: string,
  registry: ReadonlyMap<string, SlashCommandEntry>,
  legacyAliases: ReadonlyMap<string, SlashCommandEntry> = new Map(),
): SlashCommandEntry | null {
  const requested = commandToken(commandName).toLowerCase()
  if (!requested) return null
  return registry.get(requested) ?? legacyAliases.get(requested) ?? null
}

/** Split indexed arguments with the shell style quoting Claude Code documents. */
export function splitSlashCommandArguments(raw: string): string[] {
  const values: string[] = []
  let value = ''
  let quote: 'single' | 'double' | null = null
  let escaped = false
  let active = false

  for (const char of raw) {
    if (escaped) {
      value += char
      escaped = false
      active = true
      continue
    }
    if (char === '\\' && quote !== 'single') {
      escaped = true
      active = true
      continue
    }
    if (quote === 'single') {
      if (char === "'") quote = null
      else value += char
      continue
    }
    if (quote === 'double') {
      if (char === '"') quote = null
      else value += char
      continue
    }
    if (char === "'") {
      quote = 'single'
      active = true
      continue
    }
    if (char === '"') {
      quote = 'double'
      active = true
      continue
    }
    if (/\s/.test(char)) {
      if (active) values.push(value)
      value = ''
      active = false
      continue
    }
    value += char
    active = true
  }

  if (escaped) value += '\\'
  if (active) values.push(value)
  return values
}

/**
 * Expand the argument and plugin path placeholders needed by legacy command
 * Markdown. Expansion is one pass over the source. Inbound arguments cannot
 * introduce a second placeholder for the daemon to evaluate.
 */
export function expandSlashCommandPrompt(input: {
  prompt: string
  commandArgs: string
  pluginRoot?: string
}): string {
  const positional = splitSlashCommandArguments(input.commandArgs)
  return input.prompt.replace(
    /(\\*)\$(ARGUMENTS(?:\[(\d+)\])?|\d+|\{CLAUDE_PLUGIN_ROOT\})/g,
    (match, backslashes: string, token: string, indexed: string | undefined) => {
      if (backslashes.length % 2 === 1) {
        return `${backslashes.slice(1)}$${token}`
      }

      let replacement: string | undefined
      if (token === 'ARGUMENTS') {
        replacement = input.commandArgs
      } else if (indexed !== undefined) {
        replacement = positional[Number(indexed)]
      } else if (/^\d+$/.test(token)) {
        replacement = positional[Number(token)]
      } else if (token === '{CLAUDE_PLUGIN_ROOT}') {
        replacement = input.pluginRoot
      }

      return replacement === undefined
        ? match
        : `${backslashes}${replacement}`
    },
  )
}

/**
 * Translate structured BGOS slash input into a model action request.
 *
 * Claude Code slash commands are client actions. A slash shaped MCP channel
 * message does not enter that client dispatcher, so forwarding `/help` as bare
 * text is only an echo. This directive is the channel equivalent of command
 * dispatch. It identifies the exact registered command, binds its arguments,
 * includes local command instructions when available, and explicitly asks the
 * agent to perform the behavior and reply with the result.
 */
export function buildSlashCommandDelivery(input: {
  commandName: unknown
  commandArgs: unknown
  sourceContent?: string
  registry: ReadonlyMap<string, SlashCommandEntry>
  legacyAliases?: ReadonlyMap<string, SlashCommandEntry>
}): SlashCommandDelivery {
  const fallback = slashTextParts(input.sourceContent)
  const commandName = commandToken(input.commandName) || fallback?.commandName || ''
  const commandArgs = input.commandArgs == null
    ? fallback?.commandArgs ?? ''
    : String(input.commandArgs)
  const registeredCommand = resolveRegisteredSlashCommand(
    commandName,
    input.registry,
    input.legacyAliases,
  )
  const requestedCommand = `/${commandName || 'unknown'}`

  const meta: Record<string, string> = {
    event_type: 'slash_command',
    command_name: commandName,
    command_args: commandArgs,
    slash_dispatch: 'actionable_directive',
  }

  if (!registeredCommand) {
    return {
      content: [
        '[BGOS slash command dispatch]',
        `The user deliberately selected Claude Code slash command ${JSON.stringify(requestedCommand)} in BGOS.`,
        'No matching command is registered in this agent\'s current command catalog.',
        'Reply through BGOS that the command is unavailable. Do not invent behavior and do not merely echo the slash text.',
        `Command arguments, exactly as supplied: ${JSON.stringify(commandArgs)}`,
      ].join('\n'),
      meta,
      registeredCommand: null,
    }
  }

  const canonicalCommand = registeredCommand.command.startsWith('/')
    ? registeredCommand.command
    : `/${registeredCommand.command}`
  const description = registeredCommand.description.trim() || canonicalCommand
  const prompt = registeredCommand.prompt?.trim()
  const expandedPrompt = prompt
    ? expandSlashCommandPrompt({
        prompt,
        commandArgs,
        pluginRoot: registeredCommand.pluginRoot,
      })
    : ''
  meta.registered_command = canonicalCommand
  meta.command_description = description

  const expectedInvocation = `${requestedCommand}${commandArgs ? ` ${commandArgs}` : ''}`
  const sourceContent = input.sourceContent?.trim() ?? ''
  const includeSourceContent = sourceContent !== '' && sourceContent !== expectedInvocation

  const lines = [
    '[BGOS slash command dispatch]',
    `The user deliberately selected the registered Claude Code command ${JSON.stringify(canonicalCommand)} in BGOS.`,
    'Execute its registered behavior now. This is an action request, not slash text to echo.',
    `Registered behavior: ${JSON.stringify(description)}`,
    `Command arguments, exactly as supplied: ${JSON.stringify(commandArgs)}`,
  ]

  if (includeSourceContent) {
    lines.push(`Original inbound content, including any attachment or backlog context: ${JSON.stringify(sourceContent)}`)
  }
  if (expandedPrompt) {
    lines.push(
      'The registered instructions below have already received the command argument and plugin path substitutions available to this channel.',
      ...(registeredCommand.sourcePath
        ? [`Registered command source file: ${JSON.stringify(registeredCommand.sourcePath)}`]
        : []),
      'Follow these registered local command instructions:',
      '<registered_command_instructions>',
      expandedPrompt,
      '</registered_command_instructions>',
      'Claude Code client preprocessing did not run for this channel event. If the instructions contain a dynamic shell or file reference, gather that context with the tools available in this session and obey normal permission checks.',
    )
  }
  lines.push(
    'Carry out the behavior with the capabilities available in this session, then reply through BGOS with the result. Do not tell the user to type the command in the terminal and do not stop at describing the command.',
  )

  return {
    content: lines.join('\n'),
    meta,
    registeredCommand,
  }
}

export function isSlashCommandPayload(payload: SlashCommandPayload): boolean {
  return String(payload.messageType ?? payload.message_type ?? '') === 'slash_command'
}

/**
 * Has this exact message id already been handed to Claude by THIS process?
 *
 * Both transports share `forwardedMessageIds`, but only the WebSocket side
 * consulted it for ordinary messages; the poll checked it for slash commands
 * alone, on the reasoning that a text replay is harmless. It is not. The
 * replayed copy arrives without the peer-origin framing the WS delivery
 * carries, so an already-answered peer message reads as a fresh user message,
 * and reply-overdue fires on it (Ava, 871, nine occurrences since
 * 2026-05-10).
 *
 * The property this must NOT break is loss avoidance. Messages that arrived
 * while the daemon was down were never forwarded, so they are absent from the
 * set and still get delivered by the boot poll. A non-finite id also falls
 * through to delivery: the failure mode of this guard has to be a duplicate,
 * never a swallow.
 */
export function shouldSkipAlreadyForwarded(
  messageId: number,
  forwardedMessageIds: ReadonlySet<number>,
): boolean {
  if (!Number.isFinite(messageId)) return false
  return forwardedMessageIds.has(messageId)
}

export function shouldSkipForwardedSlashCommand(
  payload: SlashCommandPayload,
  messageId: number,
  forwardedMessageIds: ReadonlySet<number>,
): boolean {
  return isSlashCommandPayload(payload) && forwardedMessageIds.has(messageId)
}

/** Shared transport classifier used by both poll and WebSocket delivery. */
export function routeSlashCommand(input: {
  payload: SlashCommandPayload
  sourceContent?: string
  registry: ReadonlyMap<string, SlashCommandEntry>
  legacyAliases?: ReadonlyMap<string, SlashCommandEntry>
}): SlashCommandRoute {
  if (!isSlashCommandPayload(input.payload)) return { kind: 'not_slash' }

  const fallback = slashTextParts(
    typeof input.payload.text === 'string' ? input.payload.text : undefined,
  )
  const commandName = commandToken(
    input.payload.commandName ?? input.payload.command_name,
  ) || fallback?.commandName || ''
  const commandArgs = input.payload.commandArgs ?? input.payload.command_args
  const resolvedArgs = commandArgs == null
    ? fallback?.commandArgs ?? ''
    : String(commandArgs)

  if (isReservedHostSlashCommand(commandName)) {
    return { kind: 'compact', commandName, commandArgs: resolvedArgs }
  }

  return {
    kind: 'directive',
    delivery: buildSlashCommandDelivery({
      commandName,
      commandArgs: resolvedArgs,
      sourceContent: input.sourceContent,
      registry: input.registry,
      legacyAliases: input.legacyAliases,
    }),
  }
}

/**
 * Merge discovery tiers while preserving builtin display order. Later tiers
 * win, including a project or user command that intentionally shadows a
 * builtin. Compact always remains reserved for the daemon path.
 */
export function mergeSlashCommandCatalog(
  builtins: readonly SlashCommandEntry[],
  tiers: readonly (readonly SlashCommandEntry[])[],
): SlashCommandEntry[] {
  const byName = new Map<string, SlashCommandEntry>()
  const builtinNames: string[] = []

  for (const entry of builtins) {
    const name = normalizeCommandName(entry.command)
    if (!name) continue
    byName.set(name, entry)
    builtinNames.push(name)
  }
  for (const tier of tiers) {
    for (const entry of tier) {
      const name = normalizeCommandName(entry.command)
      if (!name || isReservedHostSlashCommand(name)) continue
      byName.set(name, entry)
    }
  }

  const builtinSet = new Set(builtinNames)
  const orderedBuiltins = builtinNames
    .map((name) => byName.get(name))
    .filter((entry): entry is SlashCommandEntry => entry !== undefined)
  const rest = [...byName.entries()]
    .filter(([name]) => !builtinSet.has(name))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => entry)
  return [...orderedBuiltins, ...rest]
}

/** Parse a command Markdown file without performing shell or file expansion. */
export function parseSlashCommandMarkdown(input: {
  raw: string
  command: string
  sourcePath?: string
  pluginRoot?: string
}): SlashCommandEntry {
  const raw = input.raw.replace(/\r\n?/g, '\n')
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  const body = (frontmatter ? raw.slice(frontmatter[0].length) : raw).trim()
  if (body.length > MAX_SLASH_COMMAND_PROMPT_CHARS) {
    throw new Error(
      `command body exceeds ${MAX_SLASH_COMMAND_PROMPT_CHARS} characters`,
    )
  }

  const descriptionMatch = frontmatter?.[1].match(/^description:\s*(.+)$/m)
  const firstBodyLine = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  const description = (descriptionMatch?.[1]?.trim() || firstBodyLine || input.command)
    .slice(0, 200)

  return {
    command: input.command,
    description,
    scope: 'all',
    ...(body ? { prompt: body } : {}),
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    ...(input.pluginRoot ? { pluginRoot: input.pluginRoot } : {}),
  }
}

/** Coalesce concurrent requests while guaranteeing the latest one runs. */
export class LatestSerialRunner<T> {
  private active: Promise<void> | null = null
  private pending: { value: T } | null = null

  constructor(private readonly worker: (value: T) => Promise<void>) {}

  run(value: T): Promise<void> {
    this.pending = { value }
    if (this.active) return this.active

    let resolveActive: () => void = () => {}
    let rejectActive: (error: unknown) => void = () => {}
    const active = new Promise<void>((resolve, reject) => {
      resolveActive = resolve
      rejectActive = reject
    })
    this.active = active
    void this.drain(resolveActive, rejectActive)
    return active
  }

  private async drain(
    resolveActive: () => void,
    rejectActive: (error: unknown) => void,
  ): Promise<void> {
    let firstError: unknown
    let failed = false
    while (this.pending) {
      const next = this.pending
      this.pending = null
      try {
        await this.worker(next.value)
      } catch (error) {
        if (!failed) firstError = error
        failed = true
      }
    }

    // No await separates the final pending check from clearing active. A call
    // arriving in the next microtask therefore starts a new drain instead of
    // attaching its work to a promise whose loop has already ended.
    this.active = null
    if (failed) rejectActive(firstError)
    else resolveActive()
  }
}

/** The conditional /compact entry (see invariant above). The BGOS context
 *  pill shows its Compact button ONLY when this entry is synced. */
export const REMOTE_COMPACT_COMMAND: SlashCommandEntry = {
  command: '/compact',
  description: 'Compact prior turns to free context',
  scope: 'all',
}

/**
 * The built-in catalog this daemon should advertise. `remoteCompact` MUST be
 * the boot-time capability detection result (resolveTmuxTarget(...) != null):
 * advertising /compact without the injection capability recreates the dead
 * Compact button.
 */
export function catalogForCapabilities(opts: {
  remoteCompact: boolean
}): SlashCommandEntry[] {
  return opts.remoteCompact
    ? [...BUILTIN_COMMANDS, REMOTE_COMPACT_COMMAND]
    : [...BUILTIN_COMMANDS]
}

/**
 * The built-in commands this daemon advertises.
 *
 * WHAT CHANGED AND WHY (2026-08-30). This list used to be the sixteen names from Claude Code's own
 * terminal menu, forwarded unfiltered, none of them implemented. Each was handed to the model as a
 * one-line label plus an instruction to "execute its registered behavior now" and not to tell the
 * user to use the terminal. For a command that names a terminal screen the model cannot open, the
 * only compliant move left is improvisation.
 *
 * Measured against what a session can actually do: 3 worked, 7 produced a confident answer that was
 * not the command, 4 could not work at all, and 2 were hazards. They also held picker positions 0 to
 * 15, so they were the first sixteen things a user saw after typing a slash.
 *
 * The failure was never that a command errored. It was that a good answer and a wrong one looked
 * identical, so the feature could not be learned and the rational response was to stop trusting it.
 * A user asked whether /clear would lose anything, was told it "fully wipes my context window",
 * tapped it, received no reply at all, and was told thirteen minutes later that context "has now been
 * cleared". It had not.
 *
 * Anthropic's own Telegram channel advertises three chat commands and implements all three. The rule
 * taken from it, and pinned by test/slash-catalog.test.ts:
 *   1. advertise only what we can perform, and
 *   2. give whatever stays a real PROCEDURE rather than a noun.
 *
 * REMOVED, cannot work: /clear (no mechanism exists for a model to reset its own context), /cost
 * (client-side accounting the model cannot read), /release-notes (not reachable), /login (a session
 * is already authenticated).
 * REMOVED, hazards: /logout (a model with shell access, told to execute and not to defer, ends the
 * session and daemon serving this chat; recovery needs a person at that machine) and /bug (could file
 * a real public issue on a stray tap).
 */
export const BUILTIN_COMMANDS: SlashCommandEntry[] = [
  {
    command: '/help',
    description: 'What this agent can do here',
    scope: 'all',
    prompt: [
      'List, briefly, what you can do for the user through this chat: answer questions, read and',
      'edit files in your working directory, run commands, and send files back.',
      'Then list the other slash commands available and one line on each.',
      'Keep it under ten lines. Do not describe Claude Code terminal features the user cannot reach',
      'from a chat message.',
    ].join('\n'),
  },
  {
    command: '/status',
    description: 'Version, pairing and update state of this agent',
    scope: 'all',
    // Answered by the model from a real procedure, not a label. Anthropic's Telegram channel goes one
    // step further and answers its /status in the bridge itself, from its own state file, which is
    // strictly better because the numbers are then current and cannot be paraphrased. Doing that here
    // means a new route kind handled at three call sites in server.ts, and those same lines are being
    // edited by the auto-update and watcher work in this batch. Deferred deliberately to avoid a
    // three-way collision, and tracked; lib/slash-status.ts already exists and is tested, so the
    // remaining work is only the routing.
    prompt: [
      'Report your own operating state, and only facts you can verify right now:',
      '1. your agent name and id,',
      '2. your plugin version if you can read it,',
      '3. your working directory.',
      'If you cannot determine one of these, say that you cannot, rather than estimating it.',
    ].join('\n'),
  },
  {
    command: '/memory',
    description: 'Show or edit this project memory',
    scope: 'all',
    prompt: [
      'Read CLAUDE.md in the working directory, and any .claude/rules/*.md it points at.',
      'Summarise what they instruct you to do, in plain terms.',
      'If the user asked for a change, make the edit and say exactly which file and which lines',
      'you changed.',
    ].join('\n'),
  },
  {
    command: '/init',
    description: 'Create a CLAUDE.md for this project',
    scope: 'all',
    prompt: [
      'Look at the working directory: the languages present, the package or build files, the test',
      'command, and the directory layout.',
      'Write a concise CLAUDE.md capturing how to build, test and run this project, plus any',
      'convention a newcomer would otherwise get wrong.',
      'If a CLAUDE.md already exists, do not overwrite it. Show what you would add and ask first.',
    ].join('\n'),
  },
  {
    command: '/model',
    description: 'Which model this agent runs, and how to change it',
    scope: 'all',
    prompt: [
      'Report which model you are currently running, if you can determine it.',
      'If the user asked to change it, explain that you CANNOT change the model of the session that',
      'is already running: a model switch takes effect when the session next starts.',
      'If this agent has a launcher or configuration file that pins its model, you may edit that file',
      'so the NEXT start uses the new model, and if you do, say plainly that the current session is',
      'unchanged and which file you edited.',
    ].join('\n'),
  },
  {
    command: '/mcp',
    description: 'Check the MCP servers this agent can reach',
    scope: 'all',
    prompt: [
      'Report the MCP servers available to you and whether each one is responding, testing where you',
      'can rather than listing configuration.',
      'You CANNOT add, remove or reconnect an MCP server from here: that is a client-side action.',
      'Say so plainly, and say which file the user would edit to change it.',
    ].join('\n'),
  },
  {
    command: '/agents',
    description: 'List the subagents defined for this project',
    scope: 'all',
    prompt: [
      'Read .claude/agents/*.md in the working directory and list the subagents defined there, with',
      'one line each on what they are for.',
      'You CANNOT configure or launch a subagent interactively from here. If the user wants a change,',
      'edit the relevant file and say which one you changed.',
    ].join('\n'),
  },
  {
    command: '/permissions',
    description: 'Show what this agent is allowed to do',
    scope: 'all',
    prompt: [
      'Read .claude/settings.json and .claude/settings.local.json in the working directory and',
      'summarise the permission rules in plain language: what is allowed, what is denied, what asks.',
      'You CANNOT change the permissions of the session that is already running. If the user wants a',
      'change, edit the settings file and say plainly that it takes effect on the next start.',
    ].join('\n'),
  },
  {
    command: '/hooks',
    description: 'Show the hooks configured for this project',
    scope: 'all',
    prompt: [
      'Read the hooks configured in .claude/settings.json and settings.local.json and describe when',
      'each one fires and what it runs.',
      'You CANNOT register or re-register a hook on the running session. An edit applies at the next',
      'start, and you should say so.',
    ].join('\n'),
  },
  {
    command: '/doctor',
    description: 'Check this agent for configuration problems',
    scope: 'all',
    prompt: [
      'Check the things you can actually verify from here: that your working directory is what the',
      'user expects, that CLAUDE.md and the settings files parse, that the MCP servers you depend on',
      'respond, and that you can write to your own state directory.',
      'Report each as a pass or a fail with the reason.',
      'You CANNOT run the Claude Code terminal diagnostic from here, so do not claim to have run it;',
      'say which check a person would need a terminal for.',
    ].join('\n'),
  },
]
