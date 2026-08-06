# BGOS Channel Plugin for Claude Code

Chat with **Claude Code** through the BGOS desktop/mobile app. This plugin bridges messages between the BGOS chat UI and a running Claude Code session, giving Claude Code full agent capabilities (file access, terminal commands, web search, etc.) with a rich chat interface.

## How It Works

```
BGOS App (Electron/Mobile)
  ↕ WebSocket + REST
BGOS Backend
  ↕ REST (polling + replies)
This Plugin (MCP channel server)
  ↕ stdio (MCP protocol)
Claude Code (full agent capabilities)
```

1. User sends a message in the BGOS chat UI
2. Plugin polls the BGOS backend and detects the new message
3. Plugin pushes it to Claude Code as a `<channel>` event
4. Claude Code processes it using its full toolkit (Bash, Read, Write, Edit, Grep, etc.)
5. Claude Code calls the `reply` tool to send the response back
6. Plugin posts the reply via the BGOS REST API
7. BGOS backend pushes it to the frontend via WebSocket — appears as a chat bubble

## Requirements

You **must** have all of the following installed before setting up the plugin:

| Requirement | Minimum Version | Check Command | Install |
|-------------|----------------|---------------|---------|
| **Bun** | 1.0+ | `bun --version` | [bun.sh](https://bun.sh) — `curl -fsSL https://bun.sh/install \| bash` |
| **Claude Code CLI** | Any | `claude --version` | [claude.ai/code](https://claude.ai/code) |
| **Git** | Any | `git --version` | Pre-installed on most systems |
| **A BGOS account** | — | — | Contact your BGOS admin |

> **Why Bun?** The plugin requires Bun as its runtime (not Node.js). Bun handles the stdio MCP transport reliably across all platforms. Node.js/tsx may cause connection drops on Windows.

> ## ⚠️ Claude Subscription Required (not API-key auth)
>
> The development-channels feature this plugin depends on **only works when
> Claude Code is authenticated through a Claude subscription** (Pro / Max / Team). It does
> **not** work when Claude Code is authenticated via a raw Anthropic API key
> (`ANTHROPIC_API_KEY`).
>
> Symptoms if you try to use this plugin on API-key auth:
> - The plugin appears connected in `/mcp` and the `reply` tool works
>   (you can send messages from the agent → BGOS chat)
> - But inbound messages from BGOS → agent are **silently dropped** —
>   the channel subscription is never wired up, so the agent never sees
>   what the user types in the BGOS app
>
> To use the plugin, sign in with your Claude subscription:
>
> ```bash
> # If you're currently on API-key auth:
> unset ANTHROPIC_API_KEY
> claude /login    # sign in with your Claude.ai subscription
> ```
>
> Verify with `claude /status` — the "Auth" line should say `Claude subscription`,
> not `API key`. Only then will the channel deliver inbound messages to your
> session.

## One-command setup: `bgos-agent` (recommended)

[`bin/bgos-agent`](bin/bgos-agent) does the whole setup — and can keep the agent
**always-on** (auto-restart + survive reboot) — in a single command. It's plain
bash you can read before it touches your machine; **macOS** (launchd) and
**Linux** (systemd --user) are supported.

```bash
# one-time: put it on your PATH (from your plugin clone)
~/bgos-claude-plugin/bin/bgos-agent link

# set up an agent AND keep it running forever:
bgos-agent install --assistant <id> --key <api-key> --user <user-id> --always-on
```

That single command:

1. checks prerequisites (bun, claude, git, expect),
2. ensures the plugin is cloned + `bun install`ed,
3. writes the agent's `.mcp.json` (+ a `CLAUDE.md` stub),
4. installs a **per-agent service** that launches Claude Code, **auto-accepts the
   two `--dangerously-*` prompts**, and restarts it on crash / quit / logout /
   reboot.

> **Even simpler — let the app do it:** flip the **Always-on** toggle on a Claude
> Code agent in the BGOS app and the plugin runs this `install --always-on` for
> you on the host automatically (and `uninstall` when you flip it off). It waits
> behind your current session and takes over only when that session ends, so it
> never double-connects.

Drop `--always-on` to just write the config and print the launch command (no
service). Manage a running agent with:

```bash
bgos-agent status    --assistant <id>     # running? + recent log  (no id = list all)
bgos-agent logs      --assistant <id>
bgos-agent restart   --assistant <id>
bgos-agent uninstall --assistant <id>     # removes the service; keeps your workspace
```

Each agent is keyed by its assistant id, so one host can run several. Full
options: `bgos-agent help`.

> **Subscription auth still required** (see the warning above) — the supervisor
> runs Claude Code with a clean environment so it won't inherit `ANTHROPIC_API_KEY`,
> but `claude /status` must show `Claude subscription`.

> Prefer to wire it up by hand? The manual **Quick Start** below does exactly the
> same thing, step by step.

## Quick Start

### Step 1: Install the plugin (one-time per machine)

```bash
cd ~
git clone https://github.com/BrandGrowthOS/bgos-claude-plugin.git
cd bgos-claude-plugin
bun install
bun bin/bgos-daemon-wrapper.mjs --install "$HOME/.bgos-agent/runtime/bgos-daemon-wrapper.mjs"
```

This creates `~/bgos-claude-plugin/` and atomically installs a stable daemon
wrapper outside that mutable checkout. Run the wrapper install command again
after a manual plugin update.

### Step 2: Create `.mcp.json` in your project

In your **project's root directory**, create a `.mcp.json` file with your BGOS credentials:

```json
{
  "mcpServers": {
    "bgos": {
      "command": "bun",
      "args": [
        "/absolute/home/path/.bgos-agent/runtime/bgos-daemon-wrapper.mjs",
        "--plugin-dir",
        "/absolute/path/to/bgos-claude-plugin"
      ],
      "env": {
        "BGOS_BACKEND_URL": "https://api.brandgrowthos.ai/api/v1",
        "BGOS_API_KEY": "your-api-key-here",
        "BGOS_USER_ID": "your-user-id-here",
        "BGOS_ASSISTANT_ID": "your-assistant-id-here",
        "BGOS_AUTO_APPROVE": "true"
      }
    }
  }
}
```

Replace both example paths with the absolute wrapper and checkout paths on
your machine. Linux and macOS wrappers normally live at
`~/.bgos-agent/runtime/bgos-daemon-wrapper.mjs`. On Windows, use these steps
inside WSL and use the corresponding Linux paths.

> **Important:** Add `.mcp.json` to your project's `.gitignore` — it contains your API key.

### Step 3: Launch Claude Code

```bash
cd /path/to/your/project
claude --dangerously-skip-permissions --dangerously-load-development-channels server:bgos
```

Both flags are required:
- `--dangerously-skip-permissions` — allows the plugin to auto-approve tool usage
- `--dangerously-load-development-channels server:bgos` — enables receiving messages from the BGOS chat

> **Note on the launch flag — local clone vs. plugin store:** Because you
> installed this plugin by **cloning it locally** (Step 1 above), it is a
> *development channel* and MUST be loaded with
> `--dangerously-load-development-channels server:bgos`. The shorter
> `--channels server:bgos` form **only loads channels installed from the Claude
> Code plugin store** — for a local clone it is silently accepted but never
> wires up inbound delivery, so messages you send from the BGOS app never reach
> the agent. If inbound messages aren't arriving, confirm you launched with
> `--dangerously-load-development-channels`, not `--channels`.

### Step 4: Verify

1. Type `/mcp` in the Claude Code CLI — you should see `bgos` listed as connected
2. You should see: `Listening for channel messages from: server:bgos`
3. Open the BGOS app, go to your assistant's chat, and send a message
4. The message should appear in the Claude Code terminal as a `<channel>` event

### Step 5: Add agent guidance to your project's `CLAUDE.md` (REQUIRED)

Claude Code reads `CLAUDE.md` at the start of every conversation. Without
the snippet below, the agent will treat peer messages like normal user
messages, default to the wrong tool when responding, and the user will
have to nudge it manually. Paste this verbatim into your project's
`CLAUDE.md` (or a directory-level `CLAUDE.md` if you prefer):

```markdown
## BGOS plugin

You are connected to the BGOS chat app via the `bgos` MCP plugin. The
user (and other agents) talk to you through that channel — read these
rules before replying so messages don't get lost.

### Tools

- `reply` — send a message back to the **user** in your own chat. This
  is your default response path. Supports text, file attachments, and
  inline option buttons.
- `edit_message` — patch one of your previous messages.
- `rename_chat` — set a descriptive title on the current chat.
- `ask_user_input` — open a polished modal/sheet with 1–4 multiple-
  choice questions. Blocks until the user answers (or 600s timeout).
  Use this when you need a structured choice, not free-form text.
- `list_peers` — list other assistants on this BGOS account that you
  may message. Returns each peer's `assistantId` (the integer to pass
  to `send_to_peer`) and an `introduced` flag — true ONLY if the user
  has enabled the direction in the Agent Permissions matrix.
- `send_to_peer` — send a message to **another assistant** (peer
  agent). REQUIRED when responding to a peer message — see below.
- `complete_peer_thread` — close the active peer conversation between
  you and a peer with a one-line summary. The summary collapses the
  SideConversationCard in the user's chat so they see the outcome
  without expanding. ALWAYS pass a real summary when you can — the
  default "Conversation completed." is a fallback.
- `peer_status` — check whether a peer assistant is online (their
  plugin is currently connected) and whether you have an open
  conversation with them. Useful before sending if you want to know
  the message will be seen immediately vs queued for reconnect.
- `complete_voice_task` — report the outcome of a voice-dispatched
  background task. When a `[voice_dispatch]` notification arrives
  (your user is on a live voice call and sent you work), do the work
  in this session, then call this tool EXACTLY ONCE with the
  `task_id` and a concise SPEAKABLE result (it is announced aloud in
  their call).
- `voice_consult_reply` — answer a LIVE voice-call consult. When a
  `[voice_consult]` notification arrives (your user asked you a
  question mid-call), call this tool FIRST — before any other tool —
  with the `consult_id` and a short, speakable answer (1–3
  sentences). You have ~30 seconds; if the tool says you were too
  late, send the answer as a normal chat `reply` instead so nothing
  is lost.

### How to recognize a peer message

Channel events carry meta. When you see `peer_conversation_id` AND/OR
`turn_state` in the meta, the message came from a **peer agent**, not
the user. The text will usually start with the peer's introduction
("Hey Ava, n8n Guru here…"). The `<from_agent>` block (when present)
also names the peer.

### Responding to peer messages

**Use `send_to_peer`, not `reply`.** `reply` writes to the user's
channel surface and shouldn't be used for peer-to-peer turns. The
backend now bridges `reply`-via-`/send-message` into the peer
conversation as a safety net, but you should still use `send_to_peer`
explicitly because:

- it lets you set `turn_state` (`expecting_reply` / `more_coming` /
  `final`) so the peer's `wait_for_reply` resolves cleanly,
- it can carry `wait_for_reply: true` to BLOCK until the peer responds,
- it surfaces a clear sender identity ("from peer agent X") on the
  receiving end.

When the back-and-forth is done, call `complete_peer_thread` with a
one-line summary so the side-conversation card in the user's chat
collapses into a clean "what happened" caption.

### Conversation lifecycle

- One open peer conversation per (you, peer) pair at a time. Sending
  to a peer auto-opens a new conversation if none is active.
- Conversations auto-close after 15 minutes of inactivity. If you want
  to re-engage after a close, just call `send_to_peer` again — the
  backend opens a fresh conversation transparently.
- `turn_state='final'` closes the conversation immediately (preferred
  over an explicit `complete_peer_thread` when your closing turn
  already says everything that needs saying).

### Other rules

- The user can attach images, videos, or documents. The text you
  receive includes inline `[Attached image: foo.jpg — <url>]` lines.
  Use `WebFetch` or `Read` on the URL when you need to look at the
  content.
- Never echo your own outbound messages back into the chat.
- When in doubt about whether a tool call should reach the user, the
  peer, or stay local, ask yourself who needs to see it — and pick the
  matching tool.
```

> **Why this matters:** without these rules in `CLAUDE.md`, agents
> default to `reply` for everything, including peer messages.
> The server-side bridge prevents lost messages even in that case, but
> agent-driven `send_to_peer` calls produce cleaner conversations
> (proper turn states, explicit closes with summaries, side-card
> collapse on the user's screen).

## Getting Your Credentials

All credentials are available from the BGOS app:

| Credential | Where to find it |
|------------|-----------------|
| **API Key** | BGOS app → Account Settings → API Key |
| **User ID** | BGOS app → Account Settings → User ID |
| **Assistant ID** | Create a new assistant (select "Claude Code" type) → ID shown after creation |

> **Tip:** When you create a Claude Code assistant in the BGOS app, a setup prompt with all your credentials pre-filled is shown. Just paste it into a Claude Code session.

## Multiple Agents on One Machine

Each project gets its own `.mcp.json` with a unique `BGOS_ASSISTANT_ID`:

```
~/project-a/.mcp.json  → BGOS_ASSISTANT_ID=101  ("Code Review Agent")
~/project-b/.mcp.json  → BGOS_ASSISTANT_ID=102  ("DevOps Agent")
~/project-c/.mcp.json  → BGOS_ASSISTANT_ID=103  ("Data Pipeline Agent")
```

All share the same plugin installation at `~/bgos-claude-plugin/`.

## Tools

| Tool | Description |
|------|-------------|
| `reply` | Send a message with optional file attachments and interactive buttons |
| `edit_message` | Edit a previously sent message |
| `rename_chat` | Set a descriptive title on a chat |
| `ask_user_input` | Blocking modal/sheet with 1–4 multiple-choice questions |
| `list_peers` | List the user's other assistants you can message as peers |
| `send_to_peer` | Send a message to another assistant (peer agent) — supports `turn_state` and `wait_for_reply` |
| `complete_peer_thread` | Close the active peer conversation with a one-line summary (collapses the SideConversationCard) |
| `peer_status` | Check whether a peer is online + whether you have an open conversation with them |
| `complete_voice_task` | Report the outcome of a voice-dispatched background task (v0.13.0+) |
| `voice_consult_reply` | Answer a live voice-call consult with a short speakable answer (v0.14.0+) |
| `call_owner` | Ring the owner with a live in-app voice call, immediately (v0.15.0+) |
| `schedule` | Create a native scheduled task: kind `wake` (deliver the topic back to the agent) or kind `call` (ring the owner), one-shot ISO datetime or recurring (v0.16.0+) |
| `list_schedules` | List the agent's own pending scheduled tasks (v0.16.0+) |
| `cancel_schedule` | Cancel one of the agent's scheduled tasks by id (v0.16.0+) |
| `complete_side_thread` | Legacy: mark a parent message's side-thread complete with a summary (use `complete_peer_thread` for new flows) |

Claude Code retains all its built-in tools: `Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, etc.

> **For agents using these peer tools:** the rules in [Step 5](#step-5-add-agent-guidance-to-your-projects-claudemd-required) above (the `CLAUDE.md` snippet) explain when to use `send_to_peer` vs `reply` and how the conversation lifecycle works. Read those before responding to a peer message.

## Media Support

The `reply` tool supports rich media — images, videos, documents, and interactive buttons.

### Sending Files

```json
{
  "chat_id": "123",
  "text": "Here's the chart:",
  "files": [
    { "url": "https://example.com/chart.png" }
  ]
}
```

For local files:

```json
{
  "chat_id": "123",
  "text": "Report attached.",
  "files": [
    { "path": "/tmp/report.pdf", "file_name": "Q1 Report.pdf" }
  ]
}
```

**Supported types:**

| Category | Formats | Max Size |
|----------|---------|----------|
| Image | JPEG, PNG, GIF, WebP, SVG, BMP, TIFF | 10 MB |
| Video | MP4, WebM, MOV, AVI, MKV | 100 MB |
| Audio | MP3, WAV, OGG, M4A, AAC, FLAC | 20 MB |
| Document | PDF, TXT, CSV, DOC/DOCX, XLS/XLSX, PPT/PPTX, JSON, ZIP | 25 MB |

Files under 5 MB are sent inline (base64). Larger files are uploaded via S3 presigned URL.

### Sending Interactive Buttons

```json
{
  "chat_id": "123",
  "text": "What next?",
  "options": [
    { "text": "Run tests", "callback_data": "run_tests" },
    { "text": "Deploy", "callback_data": "deploy" }
  ]
}
```

> Button clicks are not yet relayed back to Claude Code. Users should type their choice as text.

### Receiving Files from Users

When a user sends files, the channel event content includes the file URL inline:
```
[Attached image: photo.jpg — https://s3-presigned-url...]
```
You can download and view images with `curl` + `Read`, or fetch documents with `WebFetch`.

### Mixed Content

Text + files + buttons in a single reply:

```json
{
  "chat_id": "123",
  "text": "Analysis complete:",
  "files": [{ "path": "/tmp/chart.png" }],
  "options": [
    { "text": "Refine", "callback_data": "refine" },
    { "text": "Export", "callback_data": "export" }
  ]
}
```

## Voice Calls (v0.14.0+)

With backend support (2026-07-05+) and an OpenAI key on the agent host, the BGOS **Talk button works on Claude Code agents**: the user gets a live WebRTC voice call whose "mouth" is an OpenAI realtime model and whose brain is YOUR live Claude Code session.

**Setup:**

1. Add `"BGOS_OPENAI_API_KEY": "<an OpenAI API key with Realtime access>"` to the `env` block of the agent's `.mcp.json` and restart the agent session.
2. In the BGOS app, open the agent's settings → Voice → set the provider to **Native (realtime)** and save.
3. Tap **Talk**. Mint happens on this host (`POST /v1/realtime/client_secrets`), so the ephemeral session secret never leaves it.

**What the agent experiences during a call:**

- **`[voice_consult]` notifications** — the user asked a quick question mid-call. Call `voice_consult_reply` FIRST with the `consult_id` and a short, speakable answer (1–3 sentences). Budget is ~30 seconds; if the session is busy mid-turn the consult usually times out gracefully (the caller hears "still working on it") and a late `voice_consult_reply` is redirected to normal chat.
- **`[voice_dispatch]` notifications** (v0.13.0) — the user dispatched background work from the call. Do the work, then call `complete_voice_task` exactly once with a speakable result. This is the PREFERRED escalation path for real work — the voice model is instructed to bias toward it because Claude turns can be slow.
- The recent chat context + your agent's name/subtitle (+ optional `BGOS_VOICE_PERSONA`) are baked into the voice session's instructions at mint, and the full call transcript is posted back into the chat when the call ends.

**Per-assistant voice settings (v0.15.0+):** the BGOS app's agent voice menu can set a **voice** (OpenAI GA set: alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar), a **speaking speed** (0.25–1.5), and a **voice persona** per assistant. They arrive on the mint frame as `payload.voiceConfig` and OVERRIDE the host env (`BGOS_VOICE_VOICE` / `BGOS_VOICE_PERSONA` are the fallback only). The plugin sanitizes the wire values (junk voice → env fallback, out-of-range speed → clamped) and echoes the applied voice/speed back so the app's in-call gear shows the truth.

## Agent Packs: Full handoff (v0.18.0+)

When the owner starts a **Full handoff** from the Home of Agents app, the backend sends this plugin an `export_pack` RPC over the same WebSocket lane as voice. The plugin then, entirely on the agent's host:

1. **Collects the agent body** from the workspace: `CLAUDE.md`, `.claude/rules/*.md`, `.claude/skills/*/SKILL.md`, plus ONLY the memory files the owner opted in (they must live under `memory/` or `.claude/memory/`). It never packs `.mcp.json`, `.claude/settings*`, `*.log`, chat history, other dotfiles, or anything resolving outside the workspace (`..`, absolute paths, and symlink escapes are rejected via a realpath check).
2. **Runs the secret scan** (rules_version 1: AWS, Anthropic, OpenAI, GitHub, Slack, Stripe, Google keys, private key blocks, JWTs, connection-string passwords, bearer tokens, generic assignments). ANY finding blocks packaging entirely and reports the file + line with a masked excerpt; nothing is uploaded.
3. **Builds a deterministic zip** (STORED entries, `manifest.json` first) with a per-file sha256 inventory, enforces the size limit BEFORE uploading, PUTs the zip to the presigned URL, and always reports the outcome (manifest + pack sha256, or a descriptive error) back to the backend.

A second RPC, `export_pack_manifest`, is the dry run: it lists candidate files (kind `body` or `memory`, with byte sizes) so the app can offer per-file memory opt-in. Nothing is built or uploaded.

The recipient installs their own independent copy with one command (shown on the claim page after they claim the handoff in the app):

```bash
npx --yes --package github:BrandGrowthOS/bgos-claude-plugin bgos-claim <claimToken>
```

The installer downloads the pack, verifies EVERY file's sha256 against the manifest (any mismatch aborts before touching disk), scaffolds `~/bgos-agents/<slug>/`, asks for the recipient's OWN X-API-Key (hidden input; keys are never shipped in packs), writes `.mcp.json` with chmod 600, prints the env key NAMES the agent still needs, and prints the launch command.

## Session Controls (v0.19.0+)

Two additions that let the BGOS app supervise a running session:

- **Stop button (`stop_turn`, cooperative)**: when the user presses Stop for a chat, the backend sends a `stop_turn` RPC over the same WebSocket lane as voice. The plugin cannot kill an in-flight Claude Code turn (there is no process-level cancel hook), so the stop is **cooperative and honest about it**: the plugin pushes a channel notification telling the live agent to stand down on that ONE chat immediately (no new tool calls, one short acknowledgement reply, partial results kept), posts a plain "Run stopped at your request." confirmation into the chat, and reports `{stopped: true, mode: 'cooperative'}`. If the live session is unreachable (or the frame has no chat id) it reports `{stopped: false, supported: false}` instead of pretending. Nothing is killed and other chats are never touched.
- **Context gauge (`contextPct`)**: the plugin automatically PATCHes the assistant status with the context-window fill percent, computed from the LATEST assistant usage entry in the session transcript (input + cache-read + cache-creation tokens over the model's window; 1M for `[1m]` model ids, 200k otherwise). It refreshes after each reply and on the poll heartbeat. The value is **approximate**: it lags one turn (it reflects the last completed API call) and drops back down after the host compacts the conversation. Agents must never set `contextPct` themselves.

## Configuration Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `BGOS_BACKEND_URL` | Yes | BGOS API URL (provided during account setup) |
| `BGOS_API_KEY` | Yes | Your BGOS API key |
| `BGOS_USER_ID` | Yes | Your BGOS user ID |
| `BGOS_ASSISTANT_ID` | Yes | Numeric ID of the assistant to respond through |
| `BGOS_AUTO_APPROVE` | No | `"true"` to auto-approve all tool permissions (default: interactive) |
| `BGOS_AUTO_UPDATE` | No | Same-major self-updates are ON by default (unset or empty counts as on). Exact value `"off"` is the hard kill switch; any other value also disables. |
| `BGOS_POLL_INTERVAL_MS` | No | Polling interval in ms (default: `2000`) |
| `BGOS_OPENAI_API_KEY` | No | OpenAI API key with Realtime access — enables live voice calls (the Talk button). Falls back to `OPENAI_API_KEY`. Without it, chat works normally and voice calls fail with a descriptive "voice not configured" error |
| `BGOS_VOICE_MODEL` | No | OpenAI realtime model for voice calls (default: `gpt-realtime-2.1`) |
| `BGOS_VOICE_VOICE` | No | Realtime voice name (default: `marin`) |
| `BGOS_VOICE_PERSONA` | No | Extra persona text baked into the voice session instructions |
| `BGOS_USAGE_REPORT` | No | `"off"` disables the per-turn usage self-report (Fleet Pulse). Default: on |
| `BGOS_USAGE_BILLING_MODE` | No | `"api"` for API-key-billed sessions (reports as api billing). Default: `subscription` (Claude Max: token usage only, never dollars) |
| `BGOS_REQUIRE_CONFIRMED_DISPATCH` | No | `"true"` to reject voice dispatches lacking `confirmed:true` (the Iris G5 confirm-gate belt; the backend already withholds unconfirmed proposals, this adds daemon-side defense in depth). Default: off |

### Permission Modes

**Auto-approve** (`BGOS_AUTO_APPROVE=true`): All tool permissions are automatically approved. Best for trusted environments.

**Interactive** (default, v0.8.0+): Permission prompts appear in the BGOS chat as an inline-button card with **✅ Allow** and **❌ Deny** buttons. Tapping a button resolves the verdict immediately. The legacy text-reply path (`yes <code>` / `no <code>`) still works as a fallback for older clients. 120s timeout auto-denies.

## Slash Commands (v0.8.0+)

The plugin syncs Claude Code's full slash-command catalog to the BGOS backend on boot and every 5 minutes thereafter. When the user types `/` in the BGOS composer, the autocomplete picker shows:

- Built-in Claude Code commands (`/help`, `/clear`, `/compact`, `/cost`, `/model`, `/agents`, `/permissions`, `/hooks`, `/mcp`, `/memory`, `/init`, `/doctor`, `/status`, `/release-notes`, `/bug`, `/login`, `/logout`).
- User commands from `~/.claude/commands/*.md`.
- Project commands from `$PROJECT/.claude/commands/*.md`.
- Plugin commands from `~/.claude/plugins/marketplaces/*/plugins/*/commands/*.md` and `~/.claude/plugins/cache/*/*/commands/*.md`, namespaced as `/plugin-name:command-name`.

When the user picks a command and sends, the plugin delivers it to Claude Code as a normal channel event with `meta.event_type='slash_command'`, `meta.command_name=<name>`, and `meta.command_args=<rest>` — Claude interprets it exactly as it would in the CLI.

The catalog refresh is best-effort: if `PUT /integrations/assistants/:id/commands` is unreachable, the plugin keeps working and re-tries on the next 5-minute tick.

## Updating the Plugin

Automatic updates are off by default. To opt in, add
`"BGOS_AUTO_UPDATE": "on"` to the plugin `env` object in `.mcp.json` and
restart the agent. The plugin checks at boot, then after each 24 hour interval
plus a random zero to six hour jitter. It updates only to a newer version in
the same major release line.

The updater fetches `origin/main` and uses a fast-forward-only checkout update.
It skips any checkout with local changes. On a machine with several daemons
using the same clone, a shared lock lets one daemon update while the others
exit cleanly for their supervisors to restart them. An update waits for current
message work to drain, then exits with status 0 after it is installed.
The stable wrapper records boot safety before the mutable server is imported,
passes MCP stdin and stdout through unchanged, and refreshes its installed copy
atomically after a successful update.

Set `BGOS_AUTO_UPDATE=off` to stop all checks and pulls. If a new revision
crashes within 60 seconds of boot twice, the plugin checks out the recorded
previous commit without reset or force and disables automatic updates. To
clear that safety latch, boot once with the flag set to `off`, then set it back
to `on` and restart again.

### Stopping updates on a running fleet

Written down because on 2026-08-06 an operator with twelve live agents needed
to stop auto-update in a hurry, could not confirm the kill switch's file
format from source fast enough to trust it, and improvised a different brake.
A brake nobody can confirm the shape of is a brake nobody reaches for under
pressure. There are three levers; pick by what you actually need.

**1. `BGOS_AUTO_UPDATE=off` (per daemon, needs a restart to apply).** The
documented kill switch. It stops every check and pull for that daemon. It only
takes effect when the daemon next starts, so it cannot stop an update on a
process that is already running: use it when you are restarting anyway.

**2. The safety file (per checkout, takes effect on the next check, no
restart).** Path `<checkout>/.git/bgos-auto-update-disabled.json`, exact
contents:

```json
{ "schemaVersion": 1, "disabled": true, "resetArmed": false }
```

Every daemon sharing that checkout reads it at its next check and stays put.
This is the right instrument for "hold this whole machine where it is": it
stops updates WITHOUT disabling rollback. To re-enable, boot once with
`BGOS_AUTO_UPDATE=off`, then set it back to `on` and restart. The plugin
writes this same file itself when it disables updates after a failed
revision, so the format above is the one it already round-trips.

**3. The dirty-tree brake (per checkout, immediate, emergency use).** Any
non-empty `git status --porcelain --untracked-files=normal` in the checkout
aborts the update before it fetches, so a single untracked file stops every
daemon on that machine at its next check with nothing to install or restart.
It is the fastest brake and the bluntest.

**The cost you must know before using lever 3: the same dirty-tree check also
guards automatic ROLLBACK.** While the tree is dirty a bad revision cannot be
rolled back automatically, so if you pull with the marker still present and
the new version misbehaves, you are recovering twelve agents by hand. Delete
the marker AS PART OF the pull, never after it. If you are holding a machine
for more than a moment, prefer lever 2, which does not have this cost.

If you leave a marker file behind, make it say what it is: what it stops, that
deleting it re-arms every daemon on the machine, and the removal sequence.
Whoever finds it will not have your context.

Manual updates remain supported:

```bash
cd ~/bgos-claude-plugin
git pull origin main
bun install
bun bin/bgos-daemon-wrapper.mjs --install "$HOME/.bgos-agent/runtime/bgos-daemon-wrapper.mjs"
```

Then relaunch Claude Code. The wrapper path in `.mcp.json` stays unchanged.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Plugin doesn't appear in `/mcp` | Check `.mcp.json` has the correct absolute wrapper and plugin directory paths |
| "Not connected" when using reply tool | Make sure you're using `bun` (not `npx tsx`) as the command in `.mcp.json` |
| No messages from BGOS arriving | Check `BGOS_ASSISTANT_ID` matches the assistant you're chatting with |
| MCP connects then disconnects | Ensure you installed with `bun install` (not `npm install`). Verify bun version: `bun --version` |
| Duplicate responses | Assistant must be "Claude Code" type in the BGOS app |
| Permission prompts blocking | Add `BGOS_AUTO_APPROVE=true` to `.mcp.json` env |

## Known Limitations

- **WebSocket-first with polling fallback** (v0.5.0+): inbound messages arrive via real-time WS push when the connection is healthy; polling backs off to a 60s heartbeat. If the WS disconnects, polling immediately resumes the configured cadence so messages still get through.
- **Single assistant per session**: Use separate `.mcp.json` files per project for multiple agents
- **Button clicks**: delivered to the agent as `button_clicked` channel events (v0.2.0+). Agents see `callback_data` and any free-text from the "Custom reply" path.
- **No streaming**: Responses appear as complete messages

## License

Apache-2.0
