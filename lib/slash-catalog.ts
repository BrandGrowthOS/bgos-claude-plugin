// ── Built-in slash-command catalog (pure, unit-tested) ───────────────────────
//
// The entries synced to the BGOS backend so the app's composer can
// autocomplete when the user types `/`. Curated against the Claude Code CLI
// as of 2026-05. Missing entries are not catastrophic, users can still type
// commands manually.
//
// IMPORTANT INVARIANT: only advertise commands the AGENT can meaningfully
// act on when they arrive as a channel event. A BGOS slash command is NOT
// typed into the CLI; it reaches the model as an MCP channel notification,
// so host-level commands the model cannot invoke must not be advertised as
// working. `/compact` was removed for exactly this reason: the BGOS context
// pill gated its Compact button on this catalog entry, the tap was forwarded
// to the agent as a channel event, and no code path anywhere triggered real
// host compaction, so the button provably did nothing (see prod messages
// 25455/25428/24004/23196: user /compact slash_commands with no effect and
// no reply). Real host compaction needs supervisor-level control of the CLI
// process; do not re-add `/compact` until such a path exists.

export interface SlashCommandEntry {
  command: string
  description: string
  scope: 'all'
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
