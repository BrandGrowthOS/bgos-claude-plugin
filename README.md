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

## Prerequisites

- **Claude Code CLI** installed and authenticated (`claude` command available)
- **Node.js 18+** (for `npx tsx`)
- **A BGOS account** with API key access
- **Git** (to clone this repo)

## Quick Start (Per-Project Setup)

This is the recommended approach. You install the plugin **once** on your machine, then each project gets its own `.mcp.json` pointing to the shared installation with its own assistant ID. This lets you run **multiple AI agents simultaneously** on the same machine — one per project.

### 1. Install the plugin (one-time)

Clone the plugin to your home directory and install dependencies:

```bash
cd ~
git clone https://github.com/BrandGrowthOS/bgos-claude-plugin.git
cd bgos-claude-plugin
npm install
```

This creates `~/bgos-claude-plugin/` — you only do this once per machine.

### 2. Create a `.mcp.json` in your project

In **your project's root directory** (not the plugin directory), create a `.mcp.json` file:

```json
{
  "mcpServers": {
    "bgos": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/bgos-claude-plugin/server.ts"],
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

**Replace the path** with the actual absolute path to `server.ts`:
- **Linux/Mac**: `"/home/username/bgos-claude-plugin/server.ts"`
- **Windows**: `"C:/Users/username/bgos-claude-plugin/server.ts"`

### 3. Launch Claude Code from your project

```bash
cd /path/to/your/project
claude --dangerously-skip-permissions --dangerously-load-development-channels server:bgos
```

Claude Code reads the `.mcp.json` from your current directory and starts the plugin with your project's assistant ID.

### 4. Verify the plugin loaded

In the Claude Code CLI, type `/mcp` — you should see `bgos` listed as a connected server.

### 5. Test

Open the BGOS app, navigate to the chat for your configured assistant, and send a message like:

> "What directory are you in and what OS is this machine running?"

## Multiple Agents on One Machine

Each project gets its own `.mcp.json` with a unique `BGOS_ASSISTANT_ID`. You can run multiple Claude Code sessions simultaneously, each responding through a different BGOS assistant.

```
~/project-a/
  .mcp.json          → BGOS_ASSISTANT_ID=101  (e.g., "Code Review Agent")
  
~/project-b/
  .mcp.json          → BGOS_ASSISTANT_ID=102  (e.g., "DevOps Agent")
  
~/project-c/
  .mcp.json          → BGOS_ASSISTANT_ID=103  (e.g., "Data Pipeline Agent")
```

All three share the same plugin installation at `~/bgos-claude-plugin/`.

**To set up a new agent:**
1. Create a new Claude Code assistant in the BGOS app (select "Claude Code" type)
2. Copy the setup prompt from the creation dialog — it pre-fills your credentials
3. Paste the prompt into a Claude Code session in your target project
4. Claude Code creates the `.mcp.json` automatically and tells you to relaunch

## Alternative: Clone-and-Run (Single Project)

If you only need one agent, or prefer a self-contained setup:

```bash
git clone https://github.com/BrandGrowthOS/bgos-claude-plugin.git
cd bgos-claude-plugin
npm install
cp .mcp.json.example .mcp.json
# Edit .mcp.json with your credentials
claude --dangerously-skip-permissions --dangerously-load-development-channels server:bgos
```

> **Note**: With this approach you must run Claude Code from the plugin directory. For multi-agent setups, use the per-project method above.

## Getting Your Credentials

All credentials are available from the BGOS app:

### API Key

Found in your **BGOS account settings**. Each user has a unique API key for machine-to-machine access.

### User ID

Your unique user identifier, shown in your **BGOS account settings**.

### Assistant ID

The numeric ID of the assistant you want Claude Code to respond through:
1. Open the BGOS app
2. Create a new assistant and select **"Claude Code"** as the type
3. The assistant ID is shown after creation

> **Tip:** When you create a Claude Code assistant in the BGOS app, a setup prompt with all your credentials pre-filled is shown. Just paste it into a Claude Code session.

## Configuration Reference

### Environment Variables (in `.mcp.json`)

| Variable | Required | Description |
|----------|----------|-------------|
| `BGOS_BACKEND_URL` | Yes | BGOS backend URL (provided during account setup) |
| `BGOS_API_KEY` | Yes | Your BGOS API key |
| `BGOS_USER_ID` | Yes | Your BGOS user ID |
| `BGOS_ASSISTANT_ID` | Yes | Numeric ID of the assistant to monitor |
| `BGOS_AUTO_APPROVE` | No | `"true"` to auto-approve all tool permissions (recommended for testing) |
| `BGOS_POLL_INTERVAL_MS` | No | Polling interval in ms (default: `2000`) |

### Permission Modes

**Auto-approve** (`BGOS_AUTO_APPROVE=true`):
- All tool permissions are automatically approved
- No user interaction needed for Claude Code to use Bash, Write, Edit, etc.
- Best for trusted environments / testing

**Interactive** (`BGOS_AUTO_APPROVE=false` or omitted):
- When Claude Code needs permission, a prompt appears in the BGOS chat:
  ```
  Permission Request
  Claude wants to use Bash
  Run test suite
  
  Reply "yes abcde" to approve or "no abcde" to deny.
  ```
- Type your verdict directly in the BGOS chat
- 120s timeout (auto-denies if no response)

## Tools Provided to Claude Code

| Tool | Description |
|------|-------------|
| `reply` | Send a message with optional file attachments and interactive buttons |
| `edit_message` | Edit a previously sent message |
| `rename_chat` | Set a descriptive title on a chat |

Claude Code also retains all its built-in tools: `Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, etc.

## Media Support

The `reply` tool supports rich media content beyond plain text.

### Sending Files

Pass a `files` array to attach images, videos, or documents:

```json
{
  "chat_id": "123",
  "text": "Here's the chart you asked for:",
  "files": [
    { "url": "https://example.com/chart.png" }
  ]
}
```

For local files on the machine running Claude Code:

```json
{
  "chat_id": "123",
  "text": "Generated report attached.",
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

- Files under 5 MB are sent inline (base64). Larger files are uploaded via presigned URL.
- Images display as thumbnails the user can tap to view full-size.
- Videos play inline in the chat UI.
- Documents appear as download cards.

### Sending Interactive Buttons

Pass an `options` array to show tappable buttons below your message:

```json
{
  "chat_id": "123",
  "text": "What would you like to do next?",
  "options": [
    { "text": "Run tests", "callback_data": "run_tests" },
    { "text": "Deploy", "callback_data": "deploy" },
    { "text": "Cancel", "callback_data": "cancel" }
  ]
}
```

> **Note:** Button click callbacks are not yet delivered back to Claude Code agents. Users should type their choice as a text reply for now.

### Receiving Files from Users

When a user sends files in the BGOS chat, the channel event includes:
- Text descriptions: `[Attached image: photo.jpg]`
- File metadata in `meta.files[]`: `file_name`, `mime_type`, `url` (presigned URL, valid ~1 hour), `type`

Claude Code can view images via URL or fetch documents using `WebFetch`.

### Mixed Content

You can combine text, files, and buttons in a single reply:

```json
{
  "chat_id": "123",
  "text": "Analysis complete. Here's the summary chart:",
  "files": [
    { "path": "/tmp/chart.png" },
    { "path": "/tmp/data.csv", "file_name": "Raw Data.csv" }
  ],
  "options": [
    { "text": "Refine analysis", "callback_data": "refine" },
    { "text": "Export full report", "callback_data": "export" }
  ]
}
```

## Architecture

### Plugin Structure

```
bgos-claude-plugin/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest
├── .mcp.json.example        # Template for .mcp.json
├── server.ts                # MCP channel server
├── package.json
├── tsconfig.json
└── README.md
```

### Message Flow

```
User types in BGOS chat
  → Message saved via BGOS API
  → Plugin polls for new messages
  → Detects new user message (id > lastSeen)
  → Pushes channel notification to Claude Code
  → Claude Code processes with full agent loop
  → Claude calls reply tool
  → Plugin sends reply via BGOS API
  → Backend pushes to frontend via WebSocket
  → BGOS app displays the reply
```

### Permission Flow (Interactive Mode)

```
Claude Code needs tool permission
  → Plugin receives permission request
  → Plugin posts permission prompt to BGOS chat
  → User types "yes abcde" in BGOS chat
  → Plugin polls and detects verdict message
  → Plugin sends permission verdict back to Claude Code
  → Claude Code proceeds with tool execution
```

## Troubleshooting

### Plugin doesn't appear in `/mcp`

Make sure your project's `.mcp.json` has the correct absolute path to `server.ts`. The path must point to the actual file on disk.

### No messages appearing in Claude Code

1. Check that `BGOS_ASSISTANT_ID` matches the assistant you're chatting with in the BGOS app
2. Verify your API key is valid (check BGOS app settings)
3. Check stderr logs in the terminal for `[bgos]` messages

### Duplicate responses

Make sure the assistant was created as "Claude Code" type in the BGOS app. If you created it manually, ensure the type is set correctly.

### Permission prompts blocking in CLI

Add `BGOS_AUTO_APPROVE=true` to your `.mcp.json` env section. This auto-approves all tool permissions via the channel permission relay.

## Development

```bash
# Type-check
npx tsc --noEmit

# Run standalone (for debugging, without Claude Code)
BGOS_BACKEND_URL=https://your-instance.example.com/api/v1 \
BGOS_API_KEY=your-key \
BGOS_USER_ID=your-id \
BGOS_ASSISTANT_ID=42 \
npx tsx server.ts
```

## Known Limitations

- **Polling-based**: Messages are detected via polling (default 2s interval), not real-time WebSocket. This adds a small delay.
- **Single assistant per session**: Each Claude Code session monitors one assistant. Use per-project `.mcp.json` files with different `BGOS_ASSISTANT_ID` values for multiple agents.
- **Button callbacks not delivered**: Users can see and click buttons, but clicks aren't relayed back to Claude Code yet. Users should type their choice as text.
- **No streaming**: Responses appear as complete messages, not streamed token-by-token.

## License

Apache-2.0
