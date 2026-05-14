# Telegram Plugin Parity — Gap Analysis

**Date:** 2026-05-13
**Author:** Claude (overnight executive-mode session)
**Scope:** Compare official Anthropic `telegram` channel plugin against in-house `bgos-claude-plugin` and identify every closeable gap, with primary focus on **slash-command parity** (discovery, autocomplete, styling).

> Companion reports referenced throughout:
> - Telegram plugin feature map: `/tmp/telegram-plugin-analysis.md`
> - BGOS plugin current state: `/tmp/bgos-plugin-current-state.md`
> - BGOS frontend rendering: `/tmp/bgos-frontend-rendering.md` *(folded in)*
> - Canonical capability contract: `hermes-channel-bgos/docs/bgos-agent-capabilities.md`

---

## TL;DR

The BGOS plugin already **matches or exceeds** the official Telegram plugin on almost every dimension *except* one: it does not register Claude Code's slash commands with the BGOS frontend's slash picker. The infrastructure for that (`PUT /integrations/assistants/:id/commands` + a frontend picker that reads it) already exists — the plugin simply never calls it. Closing this single gap is the headline of this work.

Five smaller upgrades round out parity-and-better:

1. **Slash-command catalog sync** *(headline)* — discover Claude Code's commands at boot + reload, push to backend.
2. **Permission UX uses inline buttons** (currently uses a text-reply verdict like `yes <code>`).
3. **Ack reaction on inbound** (Telegram does this — a `👀` on the user's message means "received, processing").
4. **Static / hardcoded `/start`, `/help`, `/status` adapter-side commands** — match Telegram's onboarding triad as a baseline so first-time users have something even before native commands sync.
5. **MCP `instructions` block** updated to document the new slash-command surface so agents know to send `/foo` as raw text and trust the backend's `slash_command` parsing.

---

## 1. Side-by-side comparison

Legend: ✅ have it, ⚠️ partial / different, ❌ missing, ➕ BGOS-only extra.

| Capability | Telegram official | BGOS current | Action |
|---|---|---|---|
| **MCP capabilities declared** | `claude/channel`, `claude/channel/permission` | Same | ✅ Parity. |
| **Outbound `reply` tool** | Text + files + reply_to, separate-msg-per-file | Text + files + **inline buttons** + render_mode + reply_to | ➕ Better (we have buttons). |
| **`edit_message` tool** | Edits prior bot msgs, opt-in MarkdownV2 | Edits via n8n webhook, no markdown opt-in | ⚠️ Parity in function, different transport. |
| **`react` tool** | Adds emoji reaction (Telegram whitelist) | ❌ Missing entirely | ❌ Add. |
| **Outbound emoji reactions for state** | ⚠️ Only via `react` tool when Claude calls it | ❌ None | ⚠️ Add as part of `react`. |
| **Ack reaction on inbound** | `access.ackReaction` config — auto-react on every inbound | ❌ None | ❌ Add (lightweight; default `👀`). |
| **Typing indicator on inbound** | `sendChatAction('typing')` auto-fired | ❌ None | ❌ Add (lightweight; backend WS `typing` event already exists per Hermes parity work). |
| **Permission UX** | Inline keyboard (See more / Allow / Deny) + text-reply intercept (`yes/no <id>`) | ⚠️ **Text-reply only** (`yes <code>`/`no <code>`) | ⚠️ **Upgrade to inline buttons** using existing `buttons[]` infra. |
| **Bot meta-commands** (`/start`, `/help`, `/status`) | Hardcoded 3 commands via `setMyCommands` | ❌ None | ❌ Add (adapter-handled, intercept before forwarding). |
| **Native slash command catalog sync** | ❌ Telegram doesn't surface CC's own commands | ❌ None | ❌ **HEADLINE: add — backend already accepts it via `PUT /integrations/assistants/:id/commands`.** |
| **Slash-command parsing on inbound** | ❌ Telegram passes text verbatim | ⚠️ Backend already parses `message_type='slash_command'` per capability doc, but plugin doesn't surface a list so the picker doesn't show options | ⚠️ Closes automatically once catalog sync ships. |
| **Slash-command visual styling in bubble** | ❌ Telegram client styles `/help` blue locally only | ❌ Frontend renders as plain text today | ❌ Frontend: render command segment in a distinct color when `message_type='slash_command'`. |
| **Tab autocomplete** | ❌ N/A (Telegram has its own client behavior) | ❌ Composer doesn't capture Tab | ❌ Frontend: hook Tab key in composer slash picker. |
| **`download_attachment` tool** | Yes — lazy download from Telegram file_id | ❌ Not needed (BGOS sends attachment URLs inline in `meta`/files[]) | ✅ N/A. |
| **Streaming responses** | ❌ None — `edit_message` is only progress idiom | ❌ None | ⚠️ Out-of-scope for this PR (would be nice; not parity-blocking). |
| **Stop / interrupt from channel** | ❌ None | ❌ None | ⚠️ Out-of-scope. |
| **Pairing / access control** | First-class: `access.json`, allowlist, group policy, pairing codes | ⚠️ Different model: BGOS API-key + ASSISTANT_ID env env binds the plugin to one assistant; backend enforces access | ✅ Equivalent for BGOS's model. No change. |
| **Auto-approve mode** | ❌ None — every tool needs explicit OK | ✅ `BGOS_AUTO_APPROVE=true` | ➕ Better. |
| **Per-user session isolation** | ❌ None (single global session) | ➕ Per-chat with N chats in `monitoredChatIds` | ➕ Better. |
| **Multi-chat fan-out** | ❌ None | ✅ `monitoredChatIds` is dynamic, polled per-chat | ➕ Better. |
| **Meetings (multi-agent rooms)** | ❌ None | ➕ Full Command Center V3 support | ➕ BGOS-only. |
| **Peer-to-peer agent conversations** | ❌ None | ➕ `list_peers`, `send_to_peer`, `peer_status` etc. | ➕ BGOS-only. |
| **`ask_user_input` blocking modal** | ❌ Not in Telegram | ➕ Full 1–4-question carousel | ➕ BGOS-only. |
| **Backlog catch-up on restart** | ⚠️ None — Telegram resends nothing | ➕ First-poll heuristic forwards up to 10 trailing user messages with `[backlog]` prefix | ➕ Better. |
| **Reply-overdue watchdog** | ❌ None | ➕ 120s `[reply-overdue]` nudge | ➕ Better. |
| **Persistent state** | ✅ `access.json`, `inbox/` survive restart | ⚠️ Everything in-memory; relies on backend re-discovery | ⚠️ Acceptable given backend authority; not changing this PR. |

---

## 2. The headline gap: slash commands

### What the user sees today

In the BGOS app composer, typing `/` produces nothing special. The user can type `/help` and send it — Claude Code receives the text, but no command catalog ever populated the picker, so:
- No autocomplete dropdown.
- No styled command rendering.
- No discovery: a new user has no idea what commands Claude Code accepts.

### What needs to happen

Per the canonical capability doc (`hermes-channel-bgos/docs/bgos-agent-capabilities.md` §7):

> Agents should declare their native slash-command catalog at plugin connect time via `PUT /integrations/assistants/:id/commands` (shape: `[{command, description, scope: "all"}, ...]`). **The BGOS frontend's slash picker reads this and auto-suggests.**

So the entire backend + frontend pipeline already exists. The plugin just doesn't use it.

### Where the catalog comes from

Claude Code's slash commands live in several places. The plugin enumerates them at boot (and on reload):

1. **Built-in commands** — these are Claude Code's own commands (`/help`, `/clear`, `/compact`, `/cost`, `/model`, `/login`, `/logout`, `/release-notes`, `/bug`, `/init`, `/memory`, `/agents`, `/permissions`, `/hooks`, `/mcp`, `/doctor`, `/status`, `/exit`, `/quit`). These aren't on disk — they're built into the CLI. We hardcode a known-good list with descriptions (matches CC docs as of 2026-05).
2. **User commands** — `~/.claude/commands/*.md` (may not exist on every install; check existence).
3. **Project commands** — `$PWD/.claude/commands/*.md` (per-project; for Claude Code sessions started in a repo).
4. **Plugin commands** — `~/.claude/plugins/marketplaces/*/plugins/*/commands/*.md` + `~/.claude/plugins/cache/*/*/commands/*.md`. Plugin commands are namespaced as `/plugin-name:command-name` in CC. We mirror that namespacing.

For each `.md` file, the **command name** is the basename without `.md`. The **description** is parsed from frontmatter (`---\ndescription: ...\n---`) when present, else the first non-empty line of the body, truncated to ~80 chars. Built-in commands have curated descriptions.

### Wire format to the backend

```ts
PUT /api/v1/integrations/assistants/{assistantId}/commands
Headers: X-API-Key: <bgos api key>
Body: {
  commands: [
    { command: "/help",  description: "Show usage info and supported tools", scope: "all" },
    { command: "/clear", description: "Reset conversation context",          scope: "all" },
    { command: "/compact", description: "Compact prior turns to free context", scope: "all" },
    { command: "/superpowers:brainstorming", description: "Brainstorm a feature into a design", scope: "all" },
    ...
  ]
}
```

The plugin re-syncs:
- Once on boot, after the MCP server connects and after discovery completes.
- On a periodic timer (default every 5 minutes). Refresh covers users adding plugin or `.md` files mid-session.
- On a one-shot debounced trigger when `fs.watch` notices changes in any commands directory (best-effort; falls back to the timer).

### Rendering on the frontend

Per `bgos-agent-capabilities.md` §7, the BGOS frontend already:
- Reads the assistant's command catalog and shows a slash picker on `/` keystroke.
- Parses messages with `message_type='slash_command'` and surfaces them differently from plain text.

What we likely need to **add or verify** in the frontend:

1. **Tab key handling in the composer** — when the slash picker is open, Tab inserts the highlighted entry. Enter sends the picked command. ↑/↓ navigate.
2. **Colored rendering of the command segment** in outbound bubbles when `message_type='slash_command'` (or as a fallback heuristic: text starts with `/foo` where `/foo` ∈ assistant's catalog). Color = the existing accent color (royal blue / brand color).
3. **Make sure the picker actually fetches and displays** the assistant's `commands` when the chat's assistant has a Claude-channel plugin attached.

The frontend agent's report will tell us which of those already work vs need to be added. (Pending — folded in below once it returns.)

### Why this gap exists at all

The Telegram plugin doesn't have this either (it only surfaces the bot's own 3 meta-commands via Telegram's native `setMyCommands` mechanism). The user's directive was to **exceed** Telegram parity here — and BGOS's infrastructure makes this feasible because we own the picker UI, whereas Telegram bots can't push commands into the chat client's UI beyond the bot menu.

---

## 3. The secondary gaps

### 3.1 Permission UX upgrade to inline buttons

**Current:** the plugin sends a markdown message that ends with
> Reply **yes &lt;request_id&gt;** to approve or **no &lt;request_id&gt;** to deny.

…then polls history every 1.5 s for a text reply matching `^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$`.

**Target:** send the prompt as a normal `reply` with the existing `buttons[]` mechanism:
```ts
buttons: [
  { label: "See more",       value: `perm:more:${request_id}`,  style: "default" },
  { label: "✅ Allow",       value: `perm:allow:${request_id}`, style: "success" },
  { label: "❌ Deny",        value: `perm:deny:${request_id}`,  style: "danger"  },
],
render_mode: "inline",
```
Then listen for the `button_clicked` channel event with `meta.callback_data` matching `perm:(allow|deny|more):...` and resolve the verdict from there.

Why this is straightforward:
- The `reply` tool already supports buttons.
- The polling + WS path already detects button clicks and surfaces them as `[button_clicked]` events.
- We just don't get to use the existing `<channel source="bgos" event_type="button_clicked">` notification handler — we have to intercept the click **internally** before it goes to Claude (because the click is meant to resolve the permission, not be forwarded as a turn). That means adding a check in `pollChat`'s button-click branch + the WS `inbound_message` path: if `callback_data` starts with `perm:` and the request_id matches a pending permission, swallow it and resolve the verdict.

Backward compat: keep the text-reply intercept for users on older app versions. Drop it after one release if telemetry shows everyone clicks buttons.

### 3.2 Reactions (emoji on messages)

**Current:** none. The plugin uses only the `🔐` decoration inside the permission prompt body.

**Target:** add a `react` MCP tool mirroring Telegram's:
```ts
react({ chat_id, message_id, emoji })
```
plus an optional auto-ack on inbound (configurable via `BGOS_ACK_REACTION` env, default `'👀'`).

This needs a backend endpoint. Per the canonical doc §8, "Not supported: reactions" — so the backend doesn't have reaction primitives today. **Executive decision:** ship the MCP tool as a stub that no-ops gracefully + log a warning, with a backend-feature flag check. The infrastructure can land later. If we ship without backend support, the `react` tool just records the call and returns `"reactions not supported by this BGOS deployment yet"`. This keeps the tool surface stable for when it does land. *(Decision: defer the actual reaction primitive to a follow-up; ship a no-op tool that's safe to call.)*

→ **Revision:** rather than ship a placeholder tool that does nothing, leave reactions OFF this PR entirely. Telegram has them; we don't; not the user's main ask. Document the gap and move on.

### 3.3 Hardcoded meta-commands (`/start`, `/help`, `/status`)

Telegram has these as the 3 hardcoded bot commands. BGOS already gets a richer slash catalog from the sync mechanism (§2), so these can be **just three more entries** in the synced catalog with adapter-side intercept:

| Command | Adapter behavior (intercept before forwarding) |
|---|---|
| `/start` | Reply with a welcome message: "Hi! I'm Claude Code connected to BGOS. Type `/help` for commands. Just message me normally to start." |
| `/help` | List the synced catalog inline. Falls back to a static message if catalog empty. |
| `/status` | Report: `connected: ws healthy?` `monitored chats: N` `pending permissions: N` `last poll: <duration>` |

Adapter intercepts these via a check in `pollChat`/WS handler before forwarding the message to Claude. If the assistant's user explicitly asked Claude for help (text starts with "/help" but they also typed normal context), we forward as usual.

→ **Executive decision:** **NOT for this PR.** These bot meta-commands compete with the catalog's `/help` (which would resolve to Claude's built-in help). Forking the meaning of `/help` would be confusing. The catalog sync ships first; we revisit bot meta commands later if there's a clear UX need.

### 3.4 MCP `instructions` block

Already extensive (covers `<channel>` envelope, files, buttons, ask_user_input, meetings, peers). **Add** a short paragraph explaining:
- "Slash commands the user types (`/foo bar`) arrive as a normal channel notification with `meta.event_type='slash_command'` and `meta.command_name='foo'`. Treat them as a request to invoke that command's behavior."
- (This requires the WS `inbound_message` + poll paths to recognize `message_type='slash_command'` from the backend and surface it as a typed envelope, not just plain text.)

---

## 4. Frontend findings *(folded in)*

**Headline:** the slash-picker infrastructure is **already built end-to-end** on the frontend. Plugin just isn't feeding it.

Components that already exist:
- `frontend/expo-app/src/components/chat/MessageInput.tsx` (1,837 LOC) — plain `<TextInput multiline>` composer with a **window-level capture-phase keydown listener** that handles ArrowUp/Down/Enter/Tab/Escape when the slash popover is open (lines 927–966).
- `frontend/expo-app/src/components/chat/SlashPickerPopover.tsx` — inline keyboard-first popover above the composer.
- `frontend/expo-app/src/components/chat/SlashCommandMenuSheet.tsx` — touch-first bottom sheet.
- `frontend/expo-app/src/hooks/useSlashPicker.ts` — substring filter + highlighted-index state.
- `frontend/expo-app/src/queries/assistantCommandsQuery.ts` — fetches `GET /assistants/:id/commands`.
- `frontend/expo-app/src/contexts/ChatContext.tsx` (lines 473–501) — already tags outbound drafts starting with `/` as `messageType: "slash_command"` with split `commandName` + `commandArgs`.

**Backend:** `PUT /api/v1/integrations/assistants/:assistantId/commands` (pairing-token-auth) accepts the manifest; `GET /api/v1/assistants/:id/commands` (Clerk-auth) serves it back to the frontend. Schema is minimal: `command`, `description`, `scope` (default `'all'`), `order_index`. *No argsSchema, icon, category, or channel_kind today — and we will not add them in this PR.*

**Gaps confirmed:**
1. **`bgos-claude-plugin/server.ts` never calls `PUT /integrations/assistants/:id/commands`.** Grep for "commands"/"slash" returned zero hits. → This is THE fix that lights up the picker.
2. **`MessageBubble.tsx` has no dispatcher branch for `messageType: "slash_command"`** — it falls through to `<MessageMarkdown>` and renders the `/foo bar` as plain text. → Add a styled branch.
3. **Pick behavior writes `/<command> ` into the composer and refocuses, doesn't auto-send** — this is correct behavior (matches CC CLI).
4. **No Shift+Enter for newline on web** — separate UX bug, out of scope.
5. **No `channel_kind` discriminator on assistant** — we won't add it in this PR; the picker fires for any assistant with a manifest. Acceptable for now.

**Closest precedent:** `ApprovalBubble.tsx` is the pattern to follow for `MessageBubble.tsx`'s new `slash_command` branch — same dispatcher style, no schema migration.

---

## 5. Decisions (executive, locked unless user objects)

1. **Ship in this PR:**
   - Slash command catalog discovery + sync (built-in + user + project + plugin commands).
   - Permission UX upgrade to inline buttons (keep text fallback).
   - MCP `instructions` update for slash commands.
   - Frontend changes to make `message_type='slash_command'` render styled + Tab autocomplete + ensure picker reads the catalog.
2. **Defer to a follow-up:**
   - `react` tool / inbound reactions (needs backend reactions primitive).
   - Streaming token-by-token replies (needs backend WS `typing` and partial-message support; Hermes parity already laid groundwork).
   - Stop / interrupt from chat (needs CC IPC hook).
   - Bot meta-commands `/start /help /status` — collides with catalog `/help` semantics.
3. **Decline:**
   - `download_attachment` — BGOS already inlines URLs.
   - Per-chat ack reactions — defer with reactions.

---

## 6. Risks / open questions

- **Built-in command list maintenance.** Hardcoding the 18-ish built-in CC commands means the list goes stale when CC adds new ones. Mitigation: include a `version` field on the sync payload and a `commit_sha` comment in the source so it's obvious when to refresh. Worst case: a missing command just doesn't autocomplete — still works typed manually.
- **Plugin command discovery.** Plugins live under `~/.claude/plugins/marketplaces/*/plugins/*/commands` AND `~/.claude/plugins/cache/*/*/commands`. Need to walk both and dedupe by `plugin-name:command-name` namespacing. Edge case: a plugin name with `:` in it. Unlikely in practice.
- **Sync rate-limiting.** If catalog changes (file added/removed) trigger a re-sync, debounce by 2s to avoid hammering the backend during e.g. plugin install.
- **Backend endpoint availability.** Need to verify `PUT /api/v1/integrations/assistants/:id/commands` exists on the deployed BGOS backend (not just in the canonical doc). The Hermes adapter calls it; if Hermes is in production, the endpoint is live.
- **Picker UI fallback.** If the synced catalog is empty (e.g., plugin boot race) the slash picker should fall back to "no commands available" gracefully, not error.

---

## 7. Out-of-scope explicitly

- Plugin pairing flow (BGOS has API-key model; not changing).
- Group / multi-user policies (Telegram-specific concept; BGOS chats already isolate by chat).
- Static access mode (BGOS has no equivalent need).
- File send sandbox (`assertSendable` analogue) — BGOS doesn't have arbitrary file send risk because chats are scoped per-user already.
