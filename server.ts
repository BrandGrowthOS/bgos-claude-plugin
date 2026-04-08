/**
 * BGOS Channel Plugin for Claude Code
 *
 * Bridges messages between the BGOS chat UI and a running Claude Code session.
 * Follows the same architecture as the official Telegram plugin:
 *
 *   1. Connect MCP over stdio (Claude Code spawns this process)
 *   2. Poll BGOS backend for new user messages
 *   3. Push channel notifications to Claude Code
 *   4. Claude uses reply/edit tools to send messages back via BGOS REST API
 *   5. Permission requests are relayed to BGOS chat (or auto-approved)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

// ── Configuration ────────────────────────────────────────────────────────────

const BACKEND_URL = process.env.BGOS_BACKEND_URL || ''
const API_KEY = process.env.BGOS_API_KEY || ''
const USER_ID = process.env.BGOS_USER_ID || ''
const ASSISTANT_ID = process.env.BGOS_ASSISTANT_ID || ''
const POLL_INTERVAL_MS = Number(process.env.BGOS_POLL_INTERVAL_MS) || 2000
const AUTO_APPROVE = process.env.BGOS_AUTO_APPROVE === 'true'

if (!BACKEND_URL || !API_KEY || !USER_ID || !ASSISTANT_ID) {
  process.stderr.write(
    '[bgos] Missing required config. Set BGOS_BACKEND_URL, BGOS_API_KEY, BGOS_USER_ID, BGOS_ASSISTANT_ID.\n',
  )
  process.exit(1)
}

function getApiBaseUrl(): string {
  const url = BACKEND_URL.replace(/\/$/, '')
  return url.endsWith('/api/v1') ? url : `${url}/api/v1`
}

const API_BASE = getApiBaseUrl()

function log(msg: string): void {
  process.stderr.write(`[bgos] ${msg}\n`)
}

// ── BGOS REST Client ─────────────────────────────────────────────────────────

async function bgosGet(path: string): Promise<unknown> {
  const url = `${API_BASE}/${path.replace(/^\//, '')}`
  const response = await fetch(url, {
    headers: { 'X-API-Key': API_KEY },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`GET ${response.status}: ${text.slice(0, 200)}`)
  }
  return response.json()
}

async function bgosPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  const url = `${API_BASE}/${path.replace(/^\//, '')}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`POST ${response.status}: ${text.slice(0, 200)}`)
  }
  return response.json()
}

async function bgosPatch(path: string, body: Record<string, unknown>): Promise<unknown> {
  const url = `${API_BASE}/${path.replace(/^\//, '')}`
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`PATCH ${response.status}: ${text.slice(0, 200)}`)
  }
  return response.json()
}

// ── Permission Relay State ───────────────────────────────────────────────────

/** Pending permission requests waiting for user verdict from BGOS chat. */
const pendingPermissions = new Map<
  string,
  { chatId: string; resolve: (behavior: 'allow' | 'deny') => void }
>()

/** Regex matching user verdict: "yes abcde" or "no abcde" */
const VERDICT_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// ── MCP Server ───────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'bgos', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions: [
      'Messages from the BGOS chat app arrive as <channel source="bgos"> events.',
      'Each message includes chat_id and message_id attributes.',
      '',
      'When you receive a message, process it using your full capabilities —',
      'you can use Bash, Read, Write, Edit, Grep, Glob, WebSearch, and all',
      'other Claude Code tools to help the user.',
      '',
      'Once you have a response, use the `reply` tool to send it back.',
      'The reply will appear as a chat bubble in the BGOS desktop/mobile app.',
      'You can use markdown in your replies.',
    ].join('\n'),
  },
)

// ── Permission Request Handler ───────────────────────────────────────────────

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string().optional(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const { request_id, tool_name, description, input_preview } = params

  log(`Permission request: ${tool_name} [${request_id}] — ${description}`)

  if (AUTO_APPROVE) {
    // Auto-approve mode: immediately allow all tool usage
    log(`Auto-approving: ${tool_name} [${request_id}]`)
    mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id, behavior: 'allow' },
    }).catch((err) => {
      log(`Failed to send auto-approve verdict: ${err}`)
    })
    return
  }

  // Interactive mode: send permission prompt to BGOS chat for user to approve/deny
  // Find the most recent active chat for this assistant
  const chatId = monitoredChatIds[0]
  if (!chatId) {
    log(`No monitored chat found — auto-denying ${tool_name} [${request_id}]`)
    mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id, behavior: 'deny' },
    }).catch(() => {})
    return
  }

  // Send the permission prompt as a message in the BGOS chat
  const promptText = [
    `🔐 **Permission Request**`,
    ``,
    `Claude wants to use **${tool_name}**`,
    `${description}`,
    input_preview ? `\n\`\`\`\n${input_preview}\n\`\`\`` : '',
    ``,
    `Reply **yes ${request_id}** to approve or **no ${request_id}** to deny.`,
  ]
    .filter(Boolean)
    .join('\n')

  try {
    await bgosPost('send-message', {
      chatId: Number(chatId),
      assistantId: Number(ASSISTANT_ID),
      text: promptText,
      sender: 'assistant',
      sentDate: new Date().toISOString(),
      hasAttachment: false,
      files: [],
      options: [],
    })

    log(`Permission prompt sent to chat ${chatId} for ${tool_name} [${request_id}]`)

    // Wait for the user's verdict via polling (timeout: 120s)
    const verdict = await waitForVerdict(request_id, chatId, 120_000)

    log(`Verdict for ${tool_name} [${request_id}]: ${verdict}`)
    mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id, behavior: verdict },
    }).catch((err) => {
      log(`Failed to send verdict: ${err}`)
    })
  } catch (err) {
    log(`Permission relay failed for ${tool_name} [${request_id}]: ${err}`)
    // On failure, deny to be safe
    mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id, behavior: 'deny' },
    }).catch(() => {})
  }
})

/**
 * Wait for the user to reply with "yes <id>" or "no <id>" in the BGOS chat.
 * Polls the chat history for matching user messages.
 */
async function waitForVerdict(
  requestId: string,
  chatId: string,
  timeoutMs: number,
): Promise<'allow' | 'deny'> {
  const startTime = Date.now()
  const baselineId = chatLastSeen.get(chatId) ?? 0

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1500))

    try {
      const data = (await bgosGet(
        `chats/${chatId}/messages?userId=${USER_ID}`,
      )) as ChatHistoryResponse

      if (!data.messages?.length) continue

      // Look for new user messages that match the verdict format
      for (const msg of data.messages) {
        if (msg.message.id <= baselineId) continue
        if (msg.message.sender !== 'user') continue

        const text = msg.message.text ?? ''
        const match = VERDICT_RE.exec(text)
        if (!match) continue

        const [, yesNo, id] = match
        if (id.toLowerCase() !== requestId.toLowerCase()) continue

        // Update last seen so we don't re-process this message
        chatLastSeen.set(chatId, Math.max(chatLastSeen.get(chatId) ?? 0, msg.message.id))

        return yesNo.toLowerCase().startsWith('y') ? 'allow' : 'deny'
      }
    } catch {
      // Poll error, retry
    }
  }

  log(`Permission timeout for [${requestId}] — denying`)
  return 'deny'
}

// ── Tools ────────────────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Send a reply message to the user through the BGOS chat app. ' +
        'The message appears as an assistant bubble in the chat UI.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: {
            type: 'string',
            description: 'The chat to reply in (from the channel event attributes)',
          },
          text: {
            type: 'string',
            description: 'The message text to send. Supports markdown.',
          },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a previously sent message in the BGOS chat.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          message_id: { type: 'string', description: 'The message ID to edit' },
          text: { type: 'string', description: 'The new message text' },
        },
        required: ['message_id', 'text'],
      },
    },
    {
      name: 'rename_chat',
      description: 'Rename a BGOS chat to give it a descriptive title.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string', description: 'The chat to rename' },
          title: { type: 'string', description: 'The new chat title' },
        },
        required: ['chat_id', 'title'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments as Record<string, string>

  switch (req.params.name) {
    case 'reply': {
      const { chat_id, text } = args
      if (!chat_id || !text) {
        return { content: [{ type: 'text', text: 'Error: chat_id and text are required' }] }
      }
      try {
        const result = await bgosPost('send-message', {
          chatId: Number(chat_id),
          assistantId: Number(ASSISTANT_ID),
          text,
          sender: 'assistant',
          sentDate: new Date().toISOString(),
          hasAttachment: false,
          files: [],
          options: [],
        })
        const msgId = (result as any)?.message?.id
        log(`reply sent to chat ${chat_id} (msg ${msgId})`)
        return { content: [{ type: 'text', text: msgId ? `Sent (message_id: ${msgId})` : 'Sent' }] }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Failed to send: ${errMsg}` }], isError: true }
      }
    }

    case 'edit_message': {
      const { message_id, text } = args
      if (!message_id || !text) {
        return { content: [{ type: 'text', text: 'Error: message_id and text required' }] }
      }
      try {
        const baseUrl = BACKEND_URL.replace(/\/api\/v1$/i, '').replace(/\/$/, '')
        await fetch(`${baseUrl}/webhook/edited_message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event_type: 'edited_message',
            message_id,
            chat_id: '0',
            user_id: USER_ID,
            timestamp: new Date().toISOString(),
            text,
            message: { text },
          }),
        })
        return { content: [{ type: 'text', text: 'Edited' }] }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Failed: ${errMsg}` }], isError: true }
      }
    }

    case 'rename_chat': {
      const { chat_id, title } = args
      if (!chat_id || !title) {
        return { content: [{ type: 'text', text: 'Error: chat_id and title required' }] }
      }
      try {
        await bgosPatch(`chats/${chat_id}/title`, { title })
        return { content: [{ type: 'text', text: `Renamed to "${title}"` }] }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Failed: ${errMsg}` }], isError: true }
      }
    }

    default:
      throw new Error(`Unknown tool: ${req.params.name}`)
  }
})

// ── Chat Polling ─────────────────────────────────────────────────────────────

interface ChatMessage {
  message: {
    id: number
    chatId: number
    sender: string | null
    text: string | null
    sentDate: string | null
  }
}

interface ChatHistoryResponse {
  messages: ChatMessage[]
}

const chatLastSeen = new Map<string, number>()
let monitoredChatIds: string[] = []

async function discoverChats(): Promise<void> {
  try {
    const data = (await bgosGet('webhooks/assistants')) as {
      chats: { id: number; assistantId: number }[]
    }
    monitoredChatIds = data.chats
      .filter((c) => c.assistantId === Number(ASSISTANT_ID))
      .map((c) => String(c.id))
  } catch (err) {
    log(`Failed to discover chats: ${err}`)
  }
}

async function pollChat(chatId: string): Promise<void> {
  try {
    const data = (await bgosGet(`chats/${chatId}/messages?userId=${USER_ID}`)) as ChatHistoryResponse
    if (!data.messages?.length) return

    const lastSeen = chatLastSeen.get(chatId) ?? 0
    const maxId = Math.max(...data.messages.map((m) => m.message.id))
    chatLastSeen.set(chatId, maxId)

    // First poll — just set baseline, don't forward old messages
    if (lastSeen === 0) return

    const newUserMessages = data.messages.filter(
      (m) => m.message.id > lastSeen && m.message.sender === 'user',
    )

    for (const msg of newUserMessages) {
      const text = msg.message.text ?? ''
      if (!text.trim()) continue

      // Skip verdict messages — don't forward "yes abcde" / "no abcde" to Claude
      if (VERDICT_RE.test(text)) continue

      log(`New message in chat ${chatId}: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`)

      // Push channel notification to Claude Code (fire-and-forget)
      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: text,
          meta: {
            chat_id: chatId,
            message_id: String(msg.message.id),
            user: 'User',
            user_id: USER_ID,
            assistant_id: ASSISTANT_ID,
            ts: msg.message.sentDate ?? new Date().toISOString(),
          },
        },
      }).catch((err) => {
        log(`Failed to deliver inbound to Claude: ${err}`)
      })
    }
  } catch {
    // Silent — network blips
  }
}

async function pollAllChats(): Promise<void> {
  for (const chatId of monitoredChatIds) {
    await pollChat(chatId)
  }
}

// ── Startup ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log('Starting BGOS channel plugin...')
  log(`Backend: ${API_BASE}`)
  log(`User: ${USER_ID}, Assistant: ${ASSISTANT_ID}`)
  log(`Auto-approve: ${AUTO_APPROVE}`)

  // Step 1: Connect MCP transport FIRST
  const transport = new StdioServerTransport()
  await mcp.connect(transport)
  log('MCP server connected over stdio')

  // Step 2: Discover and baseline chats
  await discoverChats()
  log(`Monitoring ${monitoredChatIds.length} chat(s)`)
  await pollAllChats()

  // Step 3: Start polling loop
  log(`Polling every ${POLL_INTERVAL_MS}ms — waiting for messages...`)
  setInterval(async () => {
    await discoverChats()
    await pollAllChats()
  }, POLL_INTERVAL_MS)
}

main().catch((err) => {
  log(`Fatal error: ${err}`)
  process.exit(1)
})
