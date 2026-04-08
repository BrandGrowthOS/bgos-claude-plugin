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

## Quick Start

### 1. Clone the repo

```bash
git clone https://github.com/BrandGrowthOS/bgos-claude-plugin.git
cd bgos-claude-plugin
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create your `.mcp.json` config

Copy the example and fill in your credentials:

```bash
cp .mcp.json.example .mcp.json
```

Edit `.mcp.json` with your values:

```json
{
  "mcpServers": {
    "bgos": {
      "command": "npx",
      "args": ["tsx", "./server.ts"],
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

### 4. Launch Claude Code with the plugin

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:bgos
```

> **Important**: You must run this command from the `bgos-claude-plugin/` directory so Claude Code finds the `.mcp.json` file.

### 5. Verify the plugin loaded

In the Claude Code CLI, type `/mcp` — you should see `bgos` listed as a connected server.

### 6. Test

Open the BGOS desktop/mobile app, navigate to the chat for your configured assistant, and send a message like:

> "What directory are you in and what OS is this machine running?"

You should see Claude Code processing the request in the CLI (using Bash tool to run commands), and the response will appear in the BGOS chat UI.

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
- Or call: `curl -H "X-API-Key: YOUR_KEY" https://api.brandgrowthos.ai/api/v1/webhooks/assistants`

> **Tip**: Create a dedicated assistant for Claude Code (e.g., "Claude Code Agent") so it doesn't interfere with your n8n-powered assistants.

### Assistant Setup

The assistant you use should ideally have:
- **No webhook URL** (or a dummy URL like `https://httpbin.org/post`) — this prevents n8n workflows from also responding to messages meant for Claude Code
- A descriptive name (e.g., "Claude Code Agent")

To set a dummy webhook URL (prevents the forwarder from sending to n8n):
```bash
curl -X PATCH \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId":"YOUR_USER_ID","assistantId":ASSISTANT_ID,"webhookUrl":"https://httpbin.org/post"}' \
  "https://api.brandgrowthos.ai/api/v1/assistants/ASSISTANT_ID"
```

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
  🔐 Permission Request
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
├── .mcp.json                # MCP server config (YOUR credentials — gitignored)
├── .mcp.json.example        # Template for .mcp.json
├── server.ts                # MCP channel server (~350 lines)
├── package.json
├── tsconfig.json
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

Make sure you're running `claude` from the `bgos-claude-plugin/` directory where `.mcp.json` is located.

### No messages appearing in Claude Code

1. Check that `BGOS_ASSISTANT_ID` matches the assistant you're chatting with
2. Verify the API key works: `curl -H "X-API-Key: YOUR_KEY" https://api.brandgrowthos.ai/api/v1/service-options/health`
3. Check stderr logs in the terminal for `[bgos]` messages

### Duplicate responses

If you're getting multiple responses per message, your assistant's `webhookUrl` might be empty, causing the BGOS forwarder to send to n8n webhook subscriptions. Set a dummy webhook URL on the assistant (see "Assistant Setup" above).

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
- **Single assistant**: Each plugin instance monitors one assistant. Run multiple instances for multiple assistants.
- **No file attachments**: Text messages only (file support planned).
- **No streaming**: Responses appear as complete messages, not streamed token-by-token.
