# BGOS Channel Plugin for Claude Code

Chat with **Claude Code** through the BGOS desktop/mobile app. This plugin bridges messages between the BGOS chat UI and a running Claude Code session, giving Claude Code full agent capabilities (file access, terminal commands, web search, etc.) with a rich chat interface.

## How It Works

```
BGOS App (Electron/Mobile)
  ↕ WebSocket + REST
BGOS Backend (api.brandgrowthos.ai)
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
  .mcp.json          → BGOS_ASSISTANT_ID=841  (e.g., "Code Review Agent")
  
~/project-b/
  .mcp.json          → BGOS_ASSISTANT_ID=842  (e.g., "DevOps Agent")
  
~/project-c/
  .mcp.json          → BGOS_ASSISTANT_ID=843  (e.g., "Data Pipeline Agent")
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

### API Key

Your BGOS API key is in the `users` table (`api_key` column). You can find it via:
- The AdminJS panel at `https://api.brandgrowthos.ai/admin`
- Or via the API: `POST /api/v1/users` returns the key

### User ID

Your Clerk user ID (format: `user_xxxxx`). Found in:
- The AdminJS panel
- Your Clerk dashboard
- The response from `POST /api/v1/users`

### Assistant ID

The numeric ID of the BGOS assistant you want Claude Code to respond through. You can:
- Check the AdminJS panel
- Create one in the BGOS app (New Assistant → Claude Code type → the ID is shown after creation)
- Or call: `curl -H "X-API-Key: YOUR_KEY" https://api.brandgrowthos.ai/api/v1/webhooks/assistants`

### Assistant Setup

Claude Code assistants should have:
- **Type**: "Claude Code" (set `code: "claude-code"`) — this tells the backend to skip the n8n forwarder
- **No webhook URL** — the plugin polls for messages, no webhook needed
- A descriptive name (e.g., "My Project Agent")

When you create a Claude Code assistant in the BGOS app, the type is set automatically.

## Configuration Reference

### Environment Variables (in `.mcp.json`)

| Variable | Required | Description |
|----------|----------|-------------|
| `BGOS_BACKEND_URL` | Yes | BGOS backend URL (e.g., `https://api.brandgrowthos.ai/api/v1`) |
| `BGOS_API_KEY` | Yes | Your BGOS API key (`X-API-Key` header) |
| `BGOS_USER_ID` | Yes | Your BGOS user ID (Clerk format: `user_xxxxx`) |
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
| `reply` | Send a message to the BGOS chat (appears as assistant bubble) |
| `edit_message` | Edit a previously sent message |
| `rename_chat` | Set a descriptive title on a chat |

Claude Code also retains all its built-in tools: `Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, etc.

## Architecture

### Plugin Structure

```
bgos-claude-plugin/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest
├── .mcp.json.example        # Template for .mcp.json
├── server.ts                # MCP channel server (~350 lines)
├── package.json
├── tsconfig.json
├── CLAUDE.md                # Project context for Claude Code
└── README.md
```

### Message Flow

```
User types in BGOS chat
  → POST /api/v1/send-message (saved to DB)
  → Plugin polls GET /api/v1/chats/:id/messages
  → Detects new user message (id > lastSeen)
  → Pushes notifications/claude/channel to Claude Code
  → Claude Code processes with full agent loop
  → Claude calls reply tool
  → Plugin calls POST /api/v1/send-message (sender=assistant)
  → Backend saves + pushes via WebSocket
  → BGOS frontend displays the reply
```

### Permission Flow (Interactive Mode)

```
Claude Code needs tool permission
  → Claude Code sends notifications/claude/channel/permission_request
  → Plugin receives it (permission handler)
  → Plugin posts permission prompt to BGOS chat
  → User types "yes abcde" in BGOS chat
  → Plugin polls and detects verdict message
  → Plugin sends notifications/claude/channel/permission (behavior: allow)
  → Claude Code proceeds with tool execution
```

## Troubleshooting

### Plugin doesn't appear in `/mcp`

Make sure your project's `.mcp.json` has the correct absolute path to `server.ts`. The path must point to the actual file on disk.

### No messages appearing in Claude Code

1. Check that `BGOS_ASSISTANT_ID` matches the assistant you're chatting with in the BGOS app
2. Verify the API key works: `curl -H "X-API-Key: YOUR_KEY" https://api.brandgrowthos.ai/api/v1/service-options/health`
3. Check stderr logs in the terminal for `[bgos]` messages

### Duplicate responses

If you're getting multiple responses per message:
1. Make sure the assistant has `code: "claude-code"` set (the backend skips the forwarder for Claude Code agents)
2. If the assistant was created manually (not via the BGOS app), set `code` to `"claude-code"` via the API

### Permission prompts blocking in CLI

Add `BGOS_AUTO_APPROVE=true` to your `.mcp.json` env section. This auto-approves all tool permissions via the channel permission relay.

## Development

```bash
# Type-check
npx tsc --noEmit

# Run standalone (for debugging, without Claude Code)
BGOS_BACKEND_URL=https://api.brandgrowthos.ai/api/v1 \
BGOS_API_KEY=your-key \
BGOS_USER_ID=your-id \
BGOS_ASSISTANT_ID=42 \
npx tsx server.ts
```

## Known Limitations

- **Polling-based**: Messages are detected via polling (default 2s interval), not real-time WebSocket. This adds a small delay.
- **Single assistant per session**: Each Claude Code session monitors one assistant. Use per-project `.mcp.json` files with different `BGOS_ASSISTANT_ID` values for multiple agents.
- **No file attachments**: Text messages only (file support planned).
- **No streaming**: Responses appear as complete messages, not streamed token-by-token.
