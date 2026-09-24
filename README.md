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

## One-command setup: `hoai-agent` (recommended)

[`bin/bgos-agent`](bin/bgos-agent) does the whole setup — and can keep the agent
**always-on** (auto-restart + survive reboot) — in a single command. It's plain
bash you can read before it touches your machine; **macOS** (launchd) and
**Linux** (systemd --user) are supported.

```bash
# one-time: put it on your PATH (from your plugin clone)
~/bgos-claude-plugin/bin/bgos-agent link

# set up an agent AND keep it running forever:
hoai-agent install --assistant <id> --key <api-key> --user <user-id> --always-on
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
hoai-agent status    --assistant <id>     # running? + recent log  (no id = list all)
hoai-agent logs      --assistant <id>
hoai-agent restart   --assistant <id>
hoai-agent uninstall --assistant <id>     # removes the service; keeps your workspace
```

Each agent is keyed by its assistant id, so one host can run several. Full
options: `hoai-agent help`.

`bgos-agent` and `bgos-pair` still work as aliases for `hoai-agent` and `hoai-pair`.

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
hoai
```

That is the whole command, on macOS, Linux and Windows alike. **This is also
how you restart the agent by hand at any time: type `/exit`, then run `hoai`
from the same folder.** There is no long command line to remember and no
channel flag to get wrong.

`hoai` is installed on your PATH by `hoai setup` and by the one-click
installer. If your shell cannot find it, run `hoai install-cli` once (or
`npx --yes --package github:BrandGrowthOS/bgos-claude-plugin hoai install-cli`
if you have no `hoai` at all), then open a new terminal.

<details>
<summary>What <code>hoai</code> runs for you, and why you should not hardcode it</summary>

`hoai` launches `claude` with two flags:

- `--dangerously-skip-permissions`: allows the plugin to auto-approve tool usage
- `--dangerously-load-development-channels <spec>`: enables receiving messages
  from the BGOS chat

**The `<spec>` differs per folder and is only knowable at run time**, which is
exactly why `hoai` works it out on every launch instead of you writing it down.
It asks two questions in order:

1. Does this folder's `.mcp.json` declare a HOAI MCP server? Then the channel is
   `server:<that entry's name>`, because that entry is what the session loads.
   This is the case for every agent made by `hoai-agent` or `bgos-claim`.
2. Otherwise, what does this machine have INSTALLED? A local clone (Step 1
   above) needs `server:bgos`; a marketplace install needs
   `plugin:hoai@<marketplace name>`, and the name is read off the machine
   (`<config>/plugins/installed_plugins.json`, or the plugin's own path), so a
   marketplace registered under another name gets that name in the spec.
3. If neither question can be answered, `hoai` **refuses to launch** and prints
   why. That happens when it is reached through `npx`, whose temporary unpack
   directory is not an install, on a machine with no install recorded. A loud
   refusal you can act on beats an agent that looks connected and hears nothing.

Getting it wrong is **silent in every direction**: on 2026-08-21 a marketplace
install launched with the clone spec, connected nothing, and dropped every
inbound message with no error anywhere. The mirror image is just as quiet, and
was live until 2026-08-25: an agent whose channel lives in its folder's
`.mcp.json`, on a machine that also has the marketplace plugin, was launched
with `plugin:hoai@hoai` and heard nothing. And until 2026-08-25 `hoai` reached
through `npx` concluded `clone` from npm's temp directory, which handed every
marketplace user the spec that makes them deaf.

For the same reason, **do not put a `hoai` shell alias in your `.zshrc`** (or
any other profile). An alias freezes one spec into a string, so it keeps
launching the wrong one after you switch install methods or move machines. The
`hoai` on your PATH is a shim that re-detects instead.

The shorter `--channels <spec>` form is a third silent-drop trap: it loads the
plugin's tools, `claude mcp list` even reports Connected, and it wires **no**
inbound delivery for a channel that is not on Anthropic's allowlist (HOAI is
not, yet). Never use it.

</details>

### Step 4: Verify

1. Type `/mcp` in the Claude Code CLI — you should see `bgos` listed as connected
2. You should see: `Listening for channel messages from: <spec>`, where `<spec>`
   is `server:bgos` for the clone install above, or `plugin:hoai@<marketplace>`
   on a marketplace install. `hoai` prints the one it resolved before it
   launches, so compare against that rather than against a spec written down
   here: the marketplace name comes from your machine, not from this page.
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

1. Add `"BGOS_OPENAI_API_KEY": "<an OpenAI API key with Realtime access>"` to the `env` block of the agent's `.mcp.json` and restart the agent session (`/exit`,
   then run `hoai` from the same folder).
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

## Missions the owner can change while you work (v0.41.0+)

A mission is the durable goal card the agent creates with `create_mission` and
ticks as it works. From this release the traffic goes BOTH ways: when the owner
presses Set aside, Mark done, Pause or Resume in the app, or starts a mission
themselves, the live session is told in one plain line on its own channel, and
a mission the owner closed stops being chased.

**What is said, and what is not.** Exactly five things are narrated: paused,
resumed, set aside, marked done, and a mission the OWNER started. A tick is
never narrated, because the owner cannot tick, so every tick is the agent's own
write and the model already has the tool result. A mission the owner REPLACED
by starting a new one in the same chat says nothing on its own either: the
start notice riding the same write already tells the whole story, and a second
line telling the agent to stand down from what it was just told to pursue would
contradict it. The agent's own writes are stamped and skipped, and every frame
is deduped, so the same decision is never told twice.

**A mission belongs to ONE CHAT.** `create_mission`, `tick_mini_goal` and
`complete_mission` take an optional `chat_id`: pass the chat you are answering
in, and omit it only when you truly mean the agent's main chat. Each chat holds
at most one open mission, so starting one in a side chat never sets aside the
main chat's mission. An agent with one chat behaves exactly as it did before.
With no `chat_id` named the daemon uses the chat of the turn, then the first
chat it watches, skipping any chat the server would refuse a mission in (a
meeting room, or a chat whose last message came from somebody other than the
owner, such as a share recipient's own chat with the agent); when none is left
the mission lands in the agent's main chat.

**Which controls the owner is offered is reported, never assumed.** The daemon
says what it can do on every heartbeat (`lib/declared-capabilities.ts`), and the
app shows only what was declared. Until 0.42.0 that was `mission_events` alone
and there was no Pause button here, because nothing in this runtime could
suspend an in flight turn. The goal lane below changes that on the hosts where
this daemon can type: clearing the native goal stops the loop after the current
turn, which is a pause it can honestly enforce, so `mission_pause` and
`mission_goal_loop` are declared there and absent everywhere else. Mark done and
Set aside have always reached the agent, and they end the mission.

## Keep working until it is done: the goal lane (v0.42.0+)

Claude Code has a goal loop of its own. A person types `/goal <condition>` in
the terminal, and from then on a separate checker reads the agent's work after
every turn and answers **met**, **not yet** with a reason, or **cannot be done**
with a reason. From this release the owner sees all of it on the mission card
as **Last check**, with the turns the runtime counted and, once the goal closes,
the time it took.

**The reading half works on every host, Windows included.** The verdict is in no
hook payload at all, and the checker runs as a second hook inside the same Stop
batch as this plugin's own, so the hook is a wake and the session transcript is
the source. The daemon tails the transcript it has POSITIVELY bound to itself
and nothing else, so a goal set in a neighbour's session on the same machine is
never adopted. A goal a person typed with no mission behind it gets a derived
mission card of its own, titled by the condition and done when it holds.

**The setting half needs a host that can type.** Arming a native goal means
putting `/goal <condition>` into the composer, and there is no other way in: a
channel push cannot do it (the CLI disables slash expansion on every channel
message and wraps the text before any flag could be read, see
`docs/learnings/a-channel-push-cannot-arm-a-native-goal.md`) and the model has
no tool for it. So the owner's **Keep working** switch is offered only where
this daemon can reach the CLI's own tmux pane, which is Mac and Linux with
`BGOS_TMUX_SESSION` set or the CLI running inside a pane this process inherited.
On every other host the switch is absent rather than greyed, and the reading
half is unaffected.

**Two stops, and they are the daemon's.** The owner chooses a turn cap with the
switch; the daemon holds it, and holds one more rule of its own: three checks in
a row that found the same thing. Either one clears the native goal and tells the
server the loop stopped itself, and the mission turns to Needs you carrying the
reason with a button that gives it ten more turns and starts the same goal
again. The turns already spent are carried across that, so the card counts on
rather than starting over. The CLI has its own competing pause and retry loop
with its own words; the daemon's stop wins and is the only one the owner sees.

**Pause now means something here.** Pause clears the native goal and remembers
it, Resume arms the same one again, and Set aside clears and forgets. That is
the pause this daemon can honestly enforce, and its limit is stated rather than
hidden: the loop stops after the current turn, and a turn already running is not
killed. The declaration is computed on every heartbeat
(`lib/declared-capabilities.ts`), so a host that gains a tmux target half an
hour after boot starts offering both controls on its next beat.

**What the model is told.** It does not set goals and must not try to type a
slash command. It works the condition, ends its turn normally when it believes
it holds, treats a not yet reason as the next instruction, does not argue with
the checker, and never ticks a mini goal because a check passed. The channel
posts every check onto the card for it, so it does not narrate them either.

## Agent activity from hooks (v0.40.0+)

The owner can watch the agent work: the tools it runs with the file or command
they touched and how long they took, the subagents it hands work to, a quiet
line when its context was compacted, and its live task list as Steps. None of
this is self reported, so the agent cannot forget to do it and cannot get it
wrong. It comes from Claude Code's own hooks.

**What the owner sees is their setting, not yours.** The app has a per agent
"Show technical details" switch, OFF by default, and it decides what is DRAWN.
The daemon always SENDS: the backend derives the agent's live working status
from these rows arriving, and a shared agent has several viewers. Nothing in
this plugin reads that setting.

**What a finished turn says (v0.43.0+).** The folded card carries the turn's
own clock, so it can say how long the turn took, how many tools ran, how many
failed and how many files changed. A shell row carries what the command
printed and the code it exited with; an edit row carries the lines it added and
removed. Every part of that is drawn only where its datum exists: a card with
no clock shows no minutes, a row with no output has no chevron, and a command
whose non zero exit was not a failure (a grep that matched nothing) carries the
runtime's own one line reading instead of a code nobody measured.

**The output is masked, then capped, and never leaves the machine in full.**
The secret scan runs over what a command printed BEFORE the tail is taken,
because cutting first can slice a token in half and hand the scanner a value
its pattern no longer matches. What ships is the LAST 2048 characters and the
last 200 lines of a row, and at most 8192 characters of output across a whole
card, spent from the newest row backwards. Those caps are applied before every
card write and not only the last one, because the whole tool list rides every
update while a turn is live. A private key is the one secret whose value is not
on the line that gives it away, so a `-----BEGIN ... PRIVATE KEY-----` line
takes its whole body with it, up to and including the `-----END` line. The two
moments the card reports are the receipts the hook process stamped, not the
moment this daemon read the spool file.

**What a turn's helpers say (v0.44.0+).** A child agent the turn hands work to
gets a row of its own: the kind of helper it is, the one line description it
was given, a state, an elapsed time that ticks while it works, what it is doing
right now, and its last message once it finishes. The row opens when the launch
is asked for and stays open until the child's own stop, because the launch
itself returns in a few milliseconds and that number is not how long the child
worked. The elapsed time is the difference between two of this host's own
receipts, and a child that never reports back carries no time and no result at
all. The child's own commands still draw their ordinary rows, so nothing was
taken away to make room for this, and helpers never count as tools in the
folded head's count.

**A card stays open while a helper is still working, even after the turn has
ended.** A finished card folds, and a helper ticking behind a fold helps
nobody. So a turn that stops with a child still running leaves its card behind
and the child's stop, minutes later, updates that same card rather than posting
a second one. That card is kept under a name of its own, so a later turn cannot
write over it, and a second turn that ends the same way keeps the first card
too. The commands the child runs after the turn has ended land on that same
card, beside the helper row they belong to: one delegating turn is one card,
however long the child goes on working. There is no token count for a child and
no way to stop one: this runtime hands the host neither, and both are recorded
as blocked rather than postponed. `SubagentStop` is the one new hook event;
`SubagentStart` is deliberately not registered, because it carries no
description and no tool id, so it can name nothing and be joined to nothing.

**The shape.** Claude Code runs `bin/hoai-hook.mjs` once per hook event, with
the payload as JSON on stdin. The forwarder appends one line to
`<state>/hooks/<session_id>/events.jsonl` and exits 0, always. The daemon
watches that directory, maps the events (`lib/hook-events.ts`, pure) and posts
the tool progress card, the Steps snapshot and the two markers. The forwarder
opens no socket and reads no credentials, and every string built from tool input
passes the plugin's secret scan before it leaves the machine.

**A marketplace install gets this for free.** `hooks/hooks.json` ships in the
plugin, and Claude Code loads an installed plugin's hooks file automatically.
Nothing to do.

**A clone install needs one entry, and the launchers write it.** Claude Code
reads a plugin's `hooks/hooks.json` only for an INSTALLED plugin under
`~/.claude/plugins`. A clone reaches the session as an MCP server entry in the
workspace `.mcp.json`, which is not an installed plugin, so that file is never
read. `bin/bgos-agent`, `bin/bgos-claim.mjs`, both bootstraps and `hoai` itself
therefore write the same entries into the workspace's
`.claude/settings.local.json`, pointing at the checkout's `bin/hoai-hook.mjs` by
absolute path (`${CLAUDE_PLUGIN_ROOT}` does not resolve outside a plugin's own
hooks file). Each of them skips a marketplace install, which already has the
rail, so no event fires twice. It is idempotent and `hoai` does it on EVERY
launch, so an existing agent folder gains the rail the next time it starts. A
release that registers a NEW event therefore reaches a clone install on its
next launch and not at the moment it updates: the whole block is rewritten from
one list, so the folder heals itself, but it heals when it next starts.
To do it by hand:

```jsonc
// <agent folder>/.claude/settings.local.json
{
  "enableAllProjectMcpServers": true,
  "hooks": {
    "PreToolUse": [
      { "hooks": [ { "type": "command", "command": "node",
                     "args": ["/absolute/path/to/bgos-claude-plugin/bin/hoai-hook.mjs"],
                     "timeout": 5, "async": true } ] }
    ]
    // ... the same entry for SessionStart, UserPromptSubmit, PostToolUse,
    // PostToolUseFailure, Stop, PreCompact, PostCompact, SessionEnd,
    // SubagentStop
  }
}
```

**Launch with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`.** Without it the CLI has no
task tools, so there are no `TaskCreate` / `TaskUpdate` calls and the live Steps
strip stays empty. Everything else on the rail works either way. The launchers
already set it (the launchd plist and the systemd unit carry it in the service
environment); a hand started session needs it on the command line:

```bash
cd <agent folder>
CLAUDE_CODE_ENABLE_TODO_TOOLS=1 claude --dangerously-skip-permissions \
  --dangerously-load-development-channels server:bgos
```

**Two things that turn the rail off silently**, both worth checking before
debugging anything else: `--safe-mode` disables hooks outright, and a daemon
that does not hold the pairing lock never consumes the spool (that is
deliberate, it is what stops several daemons on one host posting every row
twice). `hoai doctor` and the daemon log both name the lock holder.

## Agent Update Stream (v0.34.0+, experimental, default OFF)

Set `BGOS_UPDATE_STREAM=true` (pairing mode only) to opt this daemon into the
Agent Update Stream, the trusted delivery design from the BGOS architecture
doc `docs/architecture/agent-message-routing.md`. With the flag unset (the
default) nothing changes: the daemon runs exactly the legacy poll + WS paths.

What the flag turns on, when the backend serves the feature:

- **Session tokens.** At boot the daemon POSTs `/api/v1/integrations/session`
  with its pairing token (bcrypt verified once) and receives a short-lived
  session token that authenticates catch-up reads by hash lookup. The session
  token lives in memory only; it is never written to disk or logs. A 401 with
  code `session_expired` re-mints once and resumes; `pairing_revoked` stops
  the stream.
- **Sequenced pushes.** `inbound_message` events carrying `seq` +
  `streamEpoch` are applied by arithmetic: the successor applies, a duplicate
  drops, a jump buffers 500ms and then heals through one
  `GET /api/v1/integrations/updates?assistant_id=&since=&limit=` call that
  returns the missed updates plus the server's authoritative state
  (`{updates, state, streamEpoch, final}`, or `{tooOld}` / `{invalidCursor}`
  verdicts that route to one full boot-style resync).
- **The 60s beacon.** `update_state {assistantId, seq, streamEpoch}` detects
  a lost push or a silent room drop within one interval; `stream_authority`
  on each socket auth says whether the stream is on. Sweeps demote only
  while authority is present AND a beacon arrived on the current connection.
- **Cheaper recovery.** A reconnect runs one jittered catch-up chain instead
  of a full chat sweep; a WS outage polls the updates endpoint every 10s
  instead of sweeping every chat; the healthy 5 minute sweep stretches to a
  daily reconciliation while the stream is active.
- **Graceful fallback.** A 404 from either endpoint means an old backend (or
  the feature flagged off server-side): the daemon stays on, or reverts to,
  today's legacy cadence. The stream cursor is persisted per pairing-token
  fingerprint at `<state dir>/stream-cursor.json`, so a re-pair starts fresh
  instead of resurrecting another pairing's position.

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
| `BGOS_UPDATE_STREAM` | No | `"true"` opts into the Agent Update Stream (sequenced pushes + session-token catch-up; see the section above). Anything else, including unset, keeps the daemon byte-for-byte on the legacy paths. Default: off |

### Permission Modes

**Auto-approve** (`BGOS_AUTO_APPROVE=true`): All tool permissions are automatically approved. Best for trusted environments.

**Interactive** (default): a tool permission is posted to the BGOS chat as a real approval card, carrying the tool, the command it wants to run, and two buttons: **Allow once** and **Deny**. Tapping one answers the request.

**How long it waits is the owner's choice, not this daemon's.** Every card carries this daemon's offer, `1800` seconds, which is the longest it can hold its side of a request open. The server stores the smaller of that and the per agent wait set for this agent, and the stored number is what the card in your hand counts down. Behind it this daemon keeps a local backstop of that stored wait plus `90` seconds, for the one case the card cannot cover: a server that never answers at all. The old two minute auto deny is gone, because it declared a refusal while the card in the owner's hand was still perfectly tappable.

**The answer is read off the card row itself**, so a tap lands even when the card has scrolled off the chat's newest page and while the daemon is draining for a self update. Typing `yes <code>` or `no <code>` still works as a fallback for clients that do not render buttons, and every dead end (no monitored chat, a card that could not be posted, the backstop) fails closed as a deny.

Permission requests need the matching BGOS backend (the per agent wait clamp and the approval push). The daemon names that dependency in one line at boot; on an older backend a request waits the full offer and sends no device notification.

### Always ask before risky actions (v0.49.0+)

A per agent switch in the app, **OFF by default**, stored on the server and nowhere else. With it on, a short fixed list of actions stops and asks the owner on the request card even though the agent runs with full access: deleting a folder and everything in it (`rm -r`, `rm --rec`, `Remove-Item -Recurse`, `rd /s`, `find ... -delete`, `git clean -fd` or `-fx`, `rsync --delete`), force pushing (`--force`, `-f`, `--force-with-lease`, a `+` refspec, `--mirror`, `--delete`, `git push origin :branch`), changing a file inside `.git`, changing an `.env` file, changing a settings file in the home folder (a dot file directly in it, or a file directly in one of its dot folders: `~/.bashrc`, `~/.ssh/config`), whether an edit tool writes that file or the shell does (a redirect `>` or `>>`, `tee`, `sed -i`, `cp` or `mv` onto it; reading it is not a change), and an MCP tool whose name sends, posts, pays or deletes (this channel's own server, by its exact names, excepted). A command that only MENTIONS a listed action (a commit message, a PR body, a grep, `echo "rm -rf x" >> Makefile`), a `# comment`, and a heredoc body written to a file are not that action; the text is read as a command only when it is handed to a shell (`bash -c`, `eval`, a heredoc or pipe into a shell). The list is `lib/hard-floor-core.mjs`, a port of the server's reader, held to it by a shared fixture copied byte for byte from the server's (each repo pins the sha256 of the file's bytes and of its data, and the reconciliation step compares the two files); its header says what it deliberately does not catch.

**How it stops a call.** `bin/hoai-floor-hook.mjs` is the one BLOCKING hook this plugin registers (`hooks/hooks.json`, a second `PreToolUse` entry, `async: false`, 3 s timeout; a clone install gets the same entry in `.claude/settings.local.json`). It asks only in a session a HOAI daemon is attached to: the daemon, while it holds its pairing lock, marks its project folder under the plugin state folder, and the hook looks for that mark with a live pid; anywhere else it prints nothing, as before. For a listed action it writes a floor record (the rule, the matched command, the session's permission mode) and answers `ask`, which Claude Code honours even under `--dangerously-skip-permissions`, and the request reaches the relay. The relay takes that record, synchronously, before its auto approve branch (the request's own preview is a copy the CLI cuts in the middle when a value is long, so a listed action in a long command is not in it), and asks the server whether this agent's owner holds it (`POST /api/v1/integrations/assistants/:id/floor-check`, sent the matched command): **hold** posts the Allow once / Deny card, leading with the matched command when the preview lost it, and waits for the owner; **proceed** auto approves as before; a check that fails or times out **refuses** the action. With auto approve off, a proceed in a full access session allows the call (it exists only because the hook asked), and anything else is the card that install always posts. The hook only ever asks (never deny), prints nothing for anything else, and fails open inside 1.5 s, so a broken hook can never stop an unlisted call. With the switch off a listed action costs one round trip and runs as before.

**Where it does not reach, said plainly.** A legacy API key connection has no pairing scoped route to ask, and a backend without the route cannot have the switch on, so both auto approve a listed action as before (logged); for an API key agent the owner's switch therefore does nothing yet, which is an open product call on the app side. A person's own `claude` opened in the agent's folder while the agent runs sees Claude Code's own Yes / No for a listed action, because the mark is per folder. And the list reads text: a delete done by a script, an alias, a variable or `python -c` is not on it, nor are writers it does not name (`dd`, `touch`, `install`, PowerShell's `Set-Content`).

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
restart the agent (`/exit`, then run `hoai` from the same folder). The plugin
checks at boot, then after each 24 hour interval
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

**Order matters, and getting it wrong loses the fleet.** Upgrading a
multi-agent host is: **brake FIRST, then pull, then restart every daemon back
to back.** Not the other way round. Between a pull and the brake there is a
window where each daemon's next check finds a newer version and, if it is
still running a version older than 0.33.2, takes the old exit path and dies
into nothing. The window is as long as the gap between your two commands and
the failure is silent: the daemons simply stop being there.

The operator who found this got away with pulling first ONLY because his
brake was already in place from hours earlier (Mark, 888, 2026-08-06,
twelve agents). Someone following the steps in written order, installing the
brake after the pull, would not.

Manual updates remain supported:

```bash
cd ~/bgos-claude-plugin
git pull origin main
bun install
bun bin/bgos-daemon-wrapper.mjs --install "$HOME/.bgos-agent/runtime/bgos-daemon-wrapper.mjs"
```

Then restart the agent: type `/exit` in its session and run `hoai` from the
same folder. The wrapper path in `.mcp.json` stays unchanged.

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

### OpenAI native call context

With the updated HOAI app/backend and GPT-Live selected, `call_owner` accepts optional `context` (4000 characters) and `opening_message` (400 characters). The server always includes the last 12 usable authorized chat messages, or all available if fewer. The opening is a suggested first sentence spoken after the owner answers. Keep `reason` short and public; never put private context in it. Long context is bounded to the voice model budget, with longer background available to its tool coordinator. These fields do not change ElevenLabs settings or call behavior. Omitting them preserves simple calls.
