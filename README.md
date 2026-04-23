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
> The `--channels` feature this plugin depends on **only works when Claude Code
> is authenticated through a Claude subscription** (Pro / Max / Team). It does
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
> not `API key`. Only then will `--channels` deliver inbound messages to your
> session.

## Quick Start

### Step 1: Install the plugin (one-time per machine)

```bash
cd ~
git clone https://github.com/BrandGrowthOS/bgos-claude-plugin.git
cd bgos-claude-plugin
bun install
```

This creates `~/bgos-claude-plugin/`. You only do this once.

### Step 2: Create `.mcp.json` in your project

In your **project's root directory**, create a `.mcp.json` file with your BGOS credentials:

```json
{
  "mcpServers": {
    "bgos": {
      "command": "bun",
      "args": ["/absolute/path/to/bgos-claude-plugin/server.ts"],
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

**Replace the path** with the absolute path to `server.ts` on your machine:
- **Linux**: `"/home/username/bgos-claude-plugin/server.ts"`
- **Mac**: `"/Users/username/bgos-claude-plugin/server.ts"`
- **Windows**: `"C:/Users/username/bgos-claude-plugin/server.ts"`

> **Important:** Add `.mcp.json` to your project's `.gitignore` — it contains your API key.

### Step 3: Launch Claude Code

```bash
cd /path/to/your/project
claude --dangerously-skip-permissions --channels server:bgos
```

Both flags are required:
- `--dangerously-skip-permissions` — allows the plugin to auto-approve tool usage
- `--channels server:bgos` — enables receiving messages from the BGOS chat

> **Note on the `--channels` flag:** In earlier Claude Code versions this flag was
> `--dangerously-load-development-channels`. The new short form is `--channels`.
> The old long form is silently accepted on newer versions but does NOT wire up
> channel delivery — if inbound messages suddenly stop reaching your agent after
> a Claude Code update, switch to `--channels server:bgos`.

### Step 4: Verify

1. Type `/mcp` in the Claude Code CLI — you should see `bgos` listed as connected
2. You should see: `Listening for channel messages from: server:bgos`
3. Open the BGOS app, go to your assistant's chat, and send a message
4. The message should appear in the Claude Code terminal as a `<channel>` event

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

Claude Code retains all its built-in tools: `Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, etc.

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

## Configuration Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `BGOS_BACKEND_URL` | Yes | BGOS API URL (provided during account setup) |
| `BGOS_API_KEY` | Yes | Your BGOS API key |
| `BGOS_USER_ID` | Yes | Your BGOS user ID |
| `BGOS_ASSISTANT_ID` | Yes | Numeric ID of the assistant to respond through |
| `BGOS_AUTO_APPROVE` | No | `"true"` to auto-approve all tool permissions (default: interactive) |
| `BGOS_POLL_INTERVAL_MS` | No | Polling interval in ms (default: `2000`) |

### Permission Modes

**Auto-approve** (`BGOS_AUTO_APPROVE=true`): All tool permissions are automatically approved. Best for trusted environments.

**Interactive** (default): Permission prompts appear in the BGOS chat. User types `yes <code>` or `no <code>` to approve/deny. 120s timeout auto-denies.

## Updating the Plugin

```bash
cd ~/bgos-claude-plugin
git pull origin main
bun install
```

Then relaunch Claude Code. No changes needed to your project's `.mcp.json`.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Plugin doesn't appear in `/mcp` | Check `.mcp.json` has the correct absolute path to `server.ts` |
| "Not connected" when using reply tool | Make sure you're using `bun` (not `npx tsx`) as the command in `.mcp.json` |
| No messages from BGOS arriving | Check `BGOS_ASSISTANT_ID` matches the assistant you're chatting with |
| MCP connects then disconnects | Ensure you installed with `bun install` (not `npm install`). Verify bun version: `bun --version` |
| Duplicate responses | Assistant must be "Claude Code" type in the BGOS app |
| Permission prompts blocking | Add `BGOS_AUTO_APPROVE=true` to `.mcp.json` env |

## Known Limitations

- **Polling-based**: ~2 second delay (not real-time WebSocket)
- **Single assistant per session**: Use separate `.mcp.json` files per project for multiple agents
- **Button callbacks not delivered**: Users should type their choice as text
- **No streaming**: Responses appear as complete messages

## License

Apache-2.0
