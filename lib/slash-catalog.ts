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

export const BUILTIN_COMMANDS: SlashCommandEntry[] = [
  { command: '/help',          description: 'Show usage and supported tools',          scope: 'all' },
  { command: '/clear',         description: 'Reset the conversation context',          scope: 'all' },
  { command: '/cost',          description: 'Show token usage and cost for this session', scope: 'all' },
  { command: '/model',         description: 'Switch the active Claude model',          scope: 'all' },
  { command: '/agents',        description: 'List and configure subagents',            scope: 'all' },
  { command: '/permissions',   description: 'Review and manage tool permissions',      scope: 'all' },
  { command: '/hooks',         description: 'Manage shell hooks for events',           scope: 'all' },
  { command: '/mcp',           description: 'Manage MCP server connections',           scope: 'all' },
  { command: '/memory',        description: 'View or edit project memory',             scope: 'all' },
  { command: '/init',          description: 'Initialize CLAUDE.md for this project',   scope: 'all' },
  { command: '/doctor',        description: 'Diagnose configuration issues',           scope: 'all' },
  { command: '/status',        description: 'Show session status',                     scope: 'all' },
  { command: '/release-notes', description: 'Show release notes for Claude Code',      scope: 'all' },
  { command: '/bug',           description: 'Open a bug report',                       scope: 'all' },
  { command: '/login',         description: 'Sign in to Claude',                       scope: 'all' },
  { command: '/logout',        description: 'Sign out',                                scope: 'all' },
]
