# Implementation Plan — Claude Code Slash Commands in BGOS

**Date:** 2026-05-13 (overnight session)
**Author:** Claude (executive mode)
**Spec:** `bgos-claude-plugin/docs/superpowers/specs/2026-05-13-telegram-parity-gap-analysis.md`
**Goal:** Make Claude Code's slash commands work end-to-end in BGOS — discovery, autocomplete on `/`, Tab completion, styled rendering, and a permission-UX upgrade — matching and exceeding the official Telegram plugin.

## Scope summary

Two repos touched. Each gets a separate branch + PR.

| Repo | Branch | Headline change |
|---|---|---|
| `bgos-claude-plugin` | `feat/slash-command-sync` | Discover CC slash commands on boot/reload; push catalog to `PUT /integrations/assistants/:id/commands`; upgrade permission UX to inline buttons. |
| `BGOS` (app) | `feat/claude-slash-command-styling` | Render `messageType="slash_command"` bubbles with styled command pill. |

Both PR'd to `main`. Plugin merge first, then app.

## Repo 1: `bgos-claude-plugin`

### Files touched

| File | Action |
|---|---|
| `server.ts` | Edit: add command-discovery, sync to backend, permission inline buttons, MCP instructions update, version bump |
| `package.json` | Bump version `0.7.3` → `0.8.0` |
| `.claude-plugin/plugin.json` | Bump version `0.2.3` → `0.3.0` |
| `README.md` | Add a "Slash commands" section + update tool table |
| *(new)* `commands.ts` | Optional split-out for command discovery + sync — only if `server.ts` grows past readability |

### Step 1 — Pre-flight: branch + read-back

1. `cd /Users/kc/Projects/BGOS/bgos-claude-plugin`
2. Confirm clean: `git status` (already clean per pre-check).
3. `git checkout -b feat/slash-command-sync`.

### Step 2 — Implement command discovery (`server.ts`)

Add (above `main()`) a self-contained module:

```ts
// ── Slash-command discovery + sync ───────────────────────────
interface SlashCommand {
  command: string;        // e.g. "/help" or "/superpowers:brainstorming"
  description: string;    // ≤ 200 chars
  scope: 'all';           // backend requires this enum value
}

// Built-in Claude Code commands. Curated list as of CC docs 2026-05.
// New CC commands need a manual bump here; missing ones still work if typed.
const BUILTIN_COMMANDS: SlashCommand[] = [
  { command: '/help',          description: 'Show usage and supported tools',          scope: 'all' },
  { command: '/clear',         description: 'Reset the conversation context',          scope: 'all' },
  { command: '/compact',       description: 'Compact prior turns to free context',     scope: 'all' },
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
];

// File-based command directories (in priority order — first hit wins per name).
function commandDirs(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const cwd = process.cwd();
  return [
    pathJoin(cwd, '.claude', 'commands'),                              // project
    pathJoin(home, '.claude', 'commands'),                             // user
    // Plugin commands — both marketplace and cache flavors. Globbed below.
    pathJoin(home, '.claude', 'plugins', 'marketplaces'),
    pathJoin(home, '.claude', 'plugins', 'cache'),
  ];
}

async function readMdCommand(filePath: string, namePrefix = ''): Promise<SlashCommand | null> {
  // Returns null on any I/O / parse error — fails open.
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const base = pathBasename(filePath, '.md');
    if (!base || base.startsWith('.')) return null;
    const command = `/${namePrefix}${base}`;
    // Parse frontmatter for description.
    let description = '';
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
    if (fmMatch) {
      const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
      if (descMatch) description = descMatch[1].trim();
    }
    if (!description) {
      // Fallback: first non-empty, non-frontmatter line, truncated to 200.
      const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
      const first = body.split('\n').map(l => l.trim()).find(l => l.length > 0);
      description = (first ?? '').slice(0, 200);
    }
    return { command, description, scope: 'all' };
  } catch {
    return null;
  }
}

async function walkCommandsDir(dir: string, namePrefix = ''): Promise<SlashCommand[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const out: SlashCommand[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const cmd = await readMdCommand(pathJoin(dir, e.name), namePrefix);
      if (cmd) out.push(cmd);
    }
    return out;
  } catch {
    return [];
  }
}

async function walkPluginCommands(rootDir: string): Promise<SlashCommand[]> {
  // rootDir is one of marketplaces/<mp>/plugins/<plugin>/commands
  // or cache/<plugin>/<version>/commands. We walk two levels then look for `commands/`.
  const out: SlashCommand[] = [];
  try {
    const level1 = await fs.promises.readdir(rootDir, { withFileTypes: true });
    for (const a of level1) {
      if (!a.isDirectory()) continue;
      // marketplaces layout: <rootDir>/<marketplace>/plugins/<plugin>/commands
      // cache layout:        <rootDir>/<plugin>/<version>/commands
      // Try both shapes.
      const tryDirs = [
        pathJoin(rootDir, a.name, 'plugins'),    // marketplaces
        pathJoin(rootDir, a.name),               // cache (plugin name)
      ];
      for (const td of tryDirs) {
        try {
          const level2 = await fs.promises.readdir(td, { withFileTypes: true });
          for (const b of level2) {
            if (!b.isDirectory()) continue;
            const cmdDir = pathJoin(td, b.name, 'commands');
            const pluginName = td.endsWith('/plugins') ? b.name : a.name;
            const cmds = await walkCommandsDir(cmdDir, `${pluginName}:`);
            out.push(...cmds);
          }
        } catch {}
      }
    }
  } catch {}
  return out;
}

async function discoverSlashCommands(): Promise<SlashCommand[]> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const cwd = process.cwd();

  const [project, user, marketplace, cache] = await Promise.all([
    walkCommandsDir(pathJoin(cwd, '.claude', 'commands')),
    walkCommandsDir(pathJoin(home, '.claude', 'commands')),
    walkPluginCommands(pathJoin(home, '.claude', 'plugins', 'marketplaces')),
    walkPluginCommands(pathJoin(home, '.claude', 'plugins', 'cache')),
  ]);

  // Dedupe by command name. Priority: built-in < marketplace < cache < user < project.
  // (Project overrides everything; cache overrides marketplace since cache is what actually runs.)
  const byName = new Map<string, SlashCommand>();
  for (const c of BUILTIN_COMMANDS) byName.set(c.command, c);
  for (const c of marketplace) byName.set(c.command, c);
  for (const c of cache) byName.set(c.command, c);
  for (const c of user) byName.set(c.command, c);
  for (const c of project) byName.set(c.command, c);

  // Sort: built-ins first (in BUILTIN_COMMANDS order), then plugin commands alphabetical.
  const builtinSet = new Set(BUILTIN_COMMANDS.map(c => c.command));
  const builtins = BUILTIN_COMMANDS.filter(c => byName.has(c.command));
  const rest = [...byName.values()]
    .filter(c => !builtinSet.has(c.command))
    .sort((a, b) => a.command.localeCompare(b.command));
  return [...builtins, ...rest];
}

let lastSyncedCommandsHash = '';
async function syncSlashCommands(): Promise<void> {
  try {
    const commands = await discoverSlashCommands();
    // Backend cap defensive: if list explodes, truncate to 200.
    const trimmed = commands.slice(0, 200);
    const hash = trimmed.map(c => c.command + '|' + c.description).join('\n');
    if (hash === lastSyncedCommandsHash) {
      log(`slash-command sync: unchanged (${trimmed.length} entries)`);
      return;
    }
    log(`slash-command sync: pushing ${trimmed.length} commands`);
    await bgosPut(
      `integrations/assistants/${ASSISTANT_ID}/commands`,
      { commands: trimmed },
    );
    lastSyncedCommandsHash = hash;
  } catch (err) {
    log(`slash-command sync failed: ${err}`);
  }
}
```

Also add a `bgosPut` helper alongside `bgosPost`/`bgosPatch`/`bgosGet` (4-line addition mirroring those).

Wire-in points:
- In `main()`, after `await mcp.connect(...)` and after `discoverChats()`, call `await syncSlashCommands()`.
- Add `setInterval(() => { void syncSlashCommands() }, 5 * 60_000).unref()` for periodic refresh (every 5 min). No filesystem watching — keep it simple.

### Step 3 — Upgrade permission UX (`server.ts`)

In the `mcp.setNotificationHandler(PermissionRequestSchema, ...)` handler (line ~428):

1. Replace the text-only prompt with a `reply` call that includes inline buttons:
   ```ts
   await bgosPost('send-message', {
     chatId: Number(chatId),
     assistantId: Number(ASSISTANT_ID),
     text: `🔐 **Permission Request**\n\nClaude wants to use **${tool_name}**\n${description}${input_preview ? `\n\n\`\`\`\n${input_preview}\n\`\`\`` : ''}`,
     sender: 'assistant',
     sentDate: new Date().toISOString(),
     hasAttachment: false,
     files: [],
     options: [
       { text: '✅ Allow',  callbackData: `perm:allow:${request_id}`, style: 'success' },
       { text: '❌ Deny',   callbackData: `perm:deny:${request_id}`,  style: 'danger'  },
     ],
     renderMode: 'inline',
   });
   ```
2. Stash the request in a `pendingPermissions` map keyed by `request_id` (was unused before — now it holds `{ chatId, resolve }`).
3. Wait via a promise resolved by the click-event interceptor (below) OR by the existing text-reply path (keep as backup). Timeout 120s → deny.

In `pollChat` button-click branch (line ~1784) and the WS `inbound_message` button-click code path, **before** emitting the channel notification:
- Check if `callbackData` starts with `perm:`. If yes, extract `request_id`, look up `pendingPermissions`, resolve with `'allow'`/`'deny'`, and **swallow the event** (don't emit `<channel>` notification — the permission flow handles it internally).

Keep `VERDICT_RE` text-reply path as-is for backward compat.

### Step 4 — Update MCP `instructions` block

Add a paragraph documenting the slash-command surface so the agent understands incoming `/foo` user turns:

> Users can run slash commands by typing `/<name>` in the BGOS app. The app's slash-command picker reads from the catalog this plugin syncs on boot (`/help`, `/clear`, project- and plugin-defined ones). When a user picks a slash command, you receive a normal channel notification with `meta.event_type='slash_command'`, `meta.command_name='<name>'`, and `meta.command_args='<rest of message>'`. Interpret the command as you would in the CLI.

### Step 5 — Inbound: surface `slash_command` envelope

In `pollChat`'s message-handling branch and the WS `inbound_message` handler, when a user message has `messageType === 'slash_command'`:
- Add `meta.event_type = 'slash_command'`, `meta.command_name = msg.message.commandName`, `meta.command_args = msg.message.commandArgs ?? ''`.
- Keep the `content` as the full text (the agent sees the literal `/foo args`).

### Step 6 — Version bump + README

- `package.json`: `0.7.3` → `0.8.0`.
- `.claude-plugin/plugin.json`: `0.2.3` → `0.3.0`.
- `README.md`: new "Slash commands" section explaining sync behavior. Update permission-flow section to note inline-button UX.

### Step 7 — Smoke run

Run `bun install --no-summary` to ensure deps still resolve. Run `bun -e 'import "./server"; console.log("loaded")'` — quick smoke; the server expects MCP stdio so it won't run end-to-end, but we want to catch syntax errors.

Actually — the server initializes async on import and would try to start MCP. Better: use `bun build --target=node server.ts --outfile=/tmp/_smoke.js && echo "ok"` to catch syntax/type issues without executing.

### Step 8 — Commit + PR

```bash
git add -A
git commit -m "feat: sync Claude Code slash commands; inline-button permission UX (v0.8.0)"
git push -u origin feat/slash-command-sync
gh pr create --base main --title "feat: slash command sync + inline permission UX (v0.8.0)" --body-file <pr-body>
```

Merge to main when CI passes (no CI exists — merge after smoke). Bump and merge in one motion since this is overnight work and the user explicitly asked to ship to main.

---

## Repo 2: `BGOS` (frontend app)

### Files touched

| File | Action |
|---|---|
| `frontend/expo-app/src/components/chat/MessageBubble.tsx` | Edit: add `messageType === 'slash_command'` dispatcher branch + new `SlashCommandBubble` sub-component |
| *(new)* `frontend/expo-app/src/components/chat/SlashCommandBubble.tsx` | Styled bubble: command pill + args in monospace |
| (none) | No backend changes. No schema changes. No composer changes. |

### Step 1 — Pre-flight: branch off main

The current working branch is `feature/enterprise-admin-mvp` with substantial unrelated work. Do NOT touch that. New branch off main:

```bash
cd /Users/kc/Projects/BGOS/BGOS
git fetch origin main --quiet
git worktree add /tmp/bgos-slash-styling origin/main
cd /tmp/bgos-slash-styling
git checkout -b feat/claude-slash-command-styling
```

Use a worktree so we don't disturb the user's in-progress enterprise-admin work.

### Step 2 — Build `SlashCommandBubble.tsx`

A small focused component:

```tsx
// frontend/expo-app/src/components/chat/SlashCommandBubble.tsx
import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { colors } from '@/theme/colors';
import { useThemedStyles } from '@/hooks/useThemedStyles';

interface Props {
  commandName: string | null;
  commandArgs: string | null;
  fallbackText: string;
  isUser: boolean;
}

export function SlashCommandBubble({ commandName, commandArgs, fallbackText, isUser }: Props) {
  const styles = useThemedStyles(makeStyles);
  // Defensive: if commandName missing (older message before tagging), fall back to plain text.
  if (!commandName) {
    return <Text style={[styles.fallback, !isUser && styles.fallbackAgent]}>{fallbackText}</Text>;
  }
  return (
    <View style={styles.container}>
      <View style={styles.pill}>
        <Text style={styles.pillText}>{`/${commandName}`}</Text>
      </View>
      {commandArgs ? (
        <Text style={styles.args}>{' ' + commandArgs}</Text>
      ) : null}
    </View>
  );
}

const makeStyles = (theme: typeof colors) => StyleSheet.create({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  pill: {
    backgroundColor: theme.BRAND_BLUE_TINT ?? 'rgba(74, 144, 226, 0.2)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    marginRight: 2,
  },
  pillText: {
    color: theme.BRAND_BLUE ?? '#4A90E2',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 14,
    fontWeight: '600',
  },
  args: {
    color: theme.WHITE_1 ?? '#FFF',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 14,
  },
  fallback: { color: '#FFF', fontSize: 14 },
  fallbackAgent: { color: '#222' },
});
```

(Code uses defensive fallbacks for theme colors so it doesn't break if colors aren't named exactly as guessed — first PR can adjust.)

### Step 3 — Wire dispatcher in `MessageBubble.tsx`

Near where `approval_request` is dispatched (~line 1725), add an analogous branch for `slash_command`:

```tsx
function isSlashCommand(m: MessageWithFiles): boolean {
  return m.message.messageType === 'slash_command';
}
```

In the top-level switch (~line 1730):

```tsx
if (isSlashCommand(message)) {
  return <SlashCommandBubble
    commandName={message.message.commandName}
    commandArgs={message.message.commandArgs}
    fallbackText={message.message.text}
    isUser={message.message.sender === 'user'}
  />;
}
```

Add the import. Run TypeScript check.

### Step 4 — Verify locally

The user said they can't run the dev server. But we can at least typecheck:

```bash
cd /tmp/bgos-slash-styling/frontend/expo-app
bun run typecheck  # or: npx tsc --noEmit
```

### Step 5 — Commit, push, PR

```bash
git add -A
git commit -m "feat(chat): styled slash-command bubble"
git push -u origin feat/claude-slash-command-styling
gh pr create --base main --title "feat(chat): styled slash-command bubble" --body-file <pr-body>
```

Merge to main after smoke.

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Backend endpoint missing / different shape | `syncSlashCommands` is wrapped in try/catch + `log()`. Plugin keeps working without sync. |
| Hardcoded built-in list drifts | Comment + `BUILTIN_COMMANDS` is grep-able. Missing commands still work if typed manually. |
| Plugin commands directory layout varies (marketplaces vs cache) | `walkPluginCommands` tries both layouts and falls back silently. |
| Permission inline-button intercept fires for a non-permission click | Strict prefix check `callbackData.startsWith('perm:')` + `pendingPermissions.has(request_id)` gate. |
| Permission lost across plugin restart | Same as today (in-memory). Document. Telegram has same issue. |
| Frontend SlashCommandBubble looks bad on dark/light theme | Use theme colors with fallbacks. Cross-platform smoke (iOS/Android/Web) is in the morning smoke-tests. |
| `messageType === 'slash_command'` for historical messages with no `commandName` | Bubble has `null` fallback → plain text. |

## Rollout

1. Plugin PR merges first (catalog flows even before frontend changes — the picker already reads from `GET /assistants/:id/commands`).
2. Frontend PR merges second (styled bubble; harmless if catalog isn't there yet).
3. User restarts their Claude Code session. Plugin re-installs from npm (auto via `bun install --no-summary` in `start` script) and pushes catalog.
4. User opens BGOS app, types `/` → picker shows.

## Out of scope (per spec)

- React tool / reactions — backend has no primitive.
- Streaming token-by-token — separate phase.
- Stop / interrupt — separate phase.
- Shift+Enter on web composer — pre-existing UX bug.
- Backend schema extensions (argsSchema/icon/category/channel_kind) — not needed for v1.
- Adapter `/start /help /status` intercept — collides with catalog `/help`.

## Smoke tests (for the morning — see `MORNING-SMOKE-TESTS.md`)

Brief list (full doc separately):
1. Type `/` in a BGOS chat with the Claude assistant — picker should show built-in commands + plugin commands.
2. Arrow up/down to navigate; Tab to insert; Enter sends.
3. Send `/help` → bubble renders with blue `/help` pill instead of plain text.
4. Trigger a tool that needs permission → inline Allow/Deny buttons appear; clicking resolves verdict.
5. Restart Claude Code session → catalog re-syncs within 5 minutes (or immediately on boot).

