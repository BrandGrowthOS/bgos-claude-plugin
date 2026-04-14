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

import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'

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

// ── File Type Helpers ────────────────────────────────────────────────────────

/** Extension → MIME type map (mirrors backend ALLOWED_MIMES) */
const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.tiff': 'image/tiff',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
  '.ogg': 'video/ogg', '.mpeg': 'video/mpeg', '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.m4a': 'audio/m4a', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.json': 'application/json', '.zip': 'application/zip',
}

/** Per-category file size limits in bytes (mirrors backend FILE_SIZE_LIMITS) */
const SIZE_LIMITS: Record<string, number> = {
  image: 10 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  audio: 20 * 1024 * 1024,
  document: 25 * 1024 * 1024,
}

/** Files above this threshold are uploaded via S3 instead of inline base64. */
const S3_THRESHOLD = 5 * 1024 * 1024

const DOC_MIMES = new Set([
  'application/pdf', 'text/plain', 'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/json', 'application/zip',
])

function guessMimeType(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase()
  return MIME_MAP[ext] ?? null
}

function getFileCategory(mime: string): string | null {
  const m = mime.trim().toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (DOC_MIMES.has(m)) return 'document'
  return null
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

// ── File Upload & Resolution ─────────────────────────────────────────────────

interface ResolvedFile {
  fileName: string
  fileData: string       // URL or base64 data-URI
  fileMimeType: string
  s3Key?: string | null
  isImage: boolean
  isVideo: boolean
  isDocument: boolean
  isAudio: boolean
}

/**
 * Upload a large file via the S3 presigned URL flow.
 * 1. POST /api/v1/files/upload-url → presigned PUT URL + key
 * 2. PUT buffer to S3
 * 3. POST /api/v1/files → save metadata, get download URL
 */
async function uploadViaS3(
  fileName: string,
  contentType: string,
  fileBuffer: Buffer,
): Promise<{ s3Key: string; downloadUrl: string }> {
  const uploadInfo = (await bgosPost(
    `files/upload-url?userId=${encodeURIComponent(USER_ID)}`,
    { fileName, contentType, size: fileBuffer.length },
  )) as { uploadUrl: string; key: string }

  const putResp = await fetch(uploadInfo.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: new Uint8Array(fileBuffer),
  })
  if (!putResp.ok) {
    throw new Error(`S3 upload failed (HTTP ${putResp.status})`)
  }

  const fileMeta = (await bgosPost(
    `files?userId=${encodeURIComponent(USER_ID)}`,
    { key: uploadInfo.key, type: contentType, size: fileBuffer.length },
  )) as { id: string; url: string; key: string }

  return { s3Key: uploadInfo.key, downloadUrl: fileMeta.url }
}

/**
 * Resolve a file spec (URL or local path) into the backend's expected format.
 */
async function resolveFile(fileSpec: {
  url?: string
  path?: string
  file_name?: string
  mime_type?: string
}): Promise<ResolvedFile> {
  // Case 1: URL — use directly
  if (fileSpec.url) {
    const urlPath = fileSpec.url.split('/').pop()?.split('?')[0] ?? 'file'
    const fileName = fileSpec.file_name ?? urlPath
    const mime = fileSpec.mime_type ?? guessMimeType(fileName) ?? 'application/octet-stream'
    const category = getFileCategory(mime)
    return {
      fileName,
      fileData: fileSpec.url,
      fileMimeType: mime,
      isImage: category === 'image',
      isVideo: category === 'video',
      isDocument: category === 'document',
      isAudio: category === 'audio',
    }
  }

  // Case 2: Local file path — read and encode/upload
  if (fileSpec.path) {
    const filePath = fileSpec.path
    const fileName = fileSpec.file_name ?? basename(filePath)
    const mime = fileSpec.mime_type ?? guessMimeType(filePath)
    if (!mime) throw new Error(`Cannot determine MIME type for "${filePath}". Specify mime_type explicitly.`)

    const category = getFileCategory(mime)
    if (!category) throw new Error(`Unsupported file type: ${mime}`)

    const fileStat = await stat(filePath)
    const limit = SIZE_LIMITS[category]
    if (fileStat.size > limit) {
      const limitMB = Math.round(limit / (1024 * 1024))
      throw new Error(`File exceeds ${limitMB}MB limit for ${category}: ${fileName}`)
    }

    const buffer = Buffer.from(await readFile(filePath))

    let fileData: string
    let s3Key: string | null = null

    if (buffer.length > S3_THRESHOLD) {
      log(`Uploading ${fileName} (${(buffer.length / 1024 / 1024).toFixed(1)}MB) via S3...`)
      const result = await uploadViaS3(fileName, mime, buffer)
      fileData = result.downloadUrl
      s3Key = result.s3Key
    } else {
      fileData = `data:${mime};base64,${buffer.toString('base64')}`
    }

    return {
      fileName,
      fileData,
      fileMimeType: mime,
      s3Key,
      isImage: category === 'image',
      isVideo: category === 'video',
      isDocument: category === 'document',
      isAudio: category === 'audio',
    }
  }

  throw new Error('File must specify either "url" or "path"')
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
      '',
      '## Sending Files & Media',
      '',
      'The `reply` tool supports file attachments alongside text:',
      '- Pass a `files` array with objects containing either `url` (remote file) or `path` (local file).',
      '- Optional fields: `file_name` (display name), `mime_type` (override auto-detection).',
      '- Supported images: JPEG, PNG, GIF, WebP, SVG, BMP, TIFF (max 10 MB).',
      '- Supported videos: MP4, WebM, MOV, AVI, MKV (max 100 MB).',
      '- Supported documents: PDF, TXT, CSV, DOC/DOCX, XLS/XLSX, PPT/PPTX, JSON, ZIP (max 25 MB).',
      '- Images display as thumbnails the user can tap to view full-size.',
      '- Videos play inline in the chat.',
      '- Documents show as download cards.',
      '- You can send text + files + buttons in a single reply.',
      '',
      '## Sending Interactive Buttons',
      '',
      'Pass an `options` array to show tappable buttons below your message:',
      '- Each button needs `text` (label) and `callback_data` (identifier).',
      '- Note: button clicks are not yet delivered back to Claude Code agents.',
      '  Users should type their choice as a text message instead.',
      '',
      '## Receiving Attachments',
      '',
      'When a user sends files, the channel event includes:',
      '- Text like "[Attached image: photo.jpg]" in the content.',
      '- A `files` array in the `meta` object with: `file_name`, `mime_type`,',
      '  `url` (presigned S3 URL valid ~1 hour), and `type` (image/video/document/audio).',
      '- You can view images via the URL or fetch documents via WebFetch.',
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
        'Supports text (markdown), file attachments (images, videos, documents), ' +
        'and interactive buttons. At least one of text, files, or options is required.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: {
            type: 'string',
            description: 'The chat to reply in (from the channel event attributes)',
          },
          text: {
            type: 'string',
            description: 'The message text to send. Supports markdown. Optional if sending files or buttons.',
          },
          files: {
            type: 'array',
            description: 'File attachments (images, videos, documents). Each file specified by URL or local path.',
            items: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  description: 'URL of the file (image URL, video URL, etc.). Use for remote/web files.',
                },
                path: {
                  type: 'string',
                  description: 'Absolute local file path. Plugin reads and uploads the file. Use for local files.',
                },
                file_name: {
                  type: 'string',
                  description: 'Display name (optional — inferred from URL/path if omitted).',
                },
                mime_type: {
                  type: 'string',
                  description: 'MIME type override (optional — inferred from extension). E.g. "image/png", "application/pdf".',
                },
              },
            },
          },
          options: {
            type: 'array',
            description: 'Interactive buttons shown below the message.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Button label shown to the user.' },
                callback_data: { type: 'string', description: 'Identifier sent when button is clicked.' },
              },
              required: ['text', 'callback_data'],
            },
          },
        },
        required: ['chat_id'],
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
  const rawArgs = req.params.arguments as Record<string, unknown>

  switch (req.params.name) {
    case 'reply': {
      const chat_id = rawArgs.chat_id as string | undefined
      const text = (rawArgs.text as string | undefined) ?? ''
      const filesInput = rawArgs.files as Array<{
        url?: string; path?: string; file_name?: string; mime_type?: string
      }> | undefined
      const optionsInput = rawArgs.options as Array<{
        text: string; callback_data: string
      }> | undefined

      if (!chat_id) {
        return { content: [{ type: 'text', text: 'Error: chat_id is required' }] }
      }
      if (!text && !filesInput?.length && !optionsInput?.length) {
        return { content: [{ type: 'text', text: 'Error: at least one of text, files, or options is required' }] }
      }

      try {
        // Resolve file attachments
        const resolvedFiles: ResolvedFile[] = []
        if (filesInput?.length) {
          for (const fileSpec of filesInput) {
            resolvedFiles.push(await resolveFile(fileSpec))
          }
        }

        // Map options to backend format
        const resolvedOptions = (optionsInput ?? []).map(opt => ({
          text: opt.text,
          callbackData: opt.callback_data,
        }))

        const hasAttachment = resolvedFiles.length > 0
        const categories = new Set(resolvedFiles.map(f => getFileCategory(f.fileMimeType)))
        const isMixedAttachments = resolvedFiles.length > 1 && categories.size > 1

        const result = await bgosPost('send-message', {
          chatId: Number(chat_id),
          assistantId: Number(ASSISTANT_ID),
          text,
          sender: 'assistant',
          sentDate: new Date().toISOString(),
          hasAttachment,
          isMixedAttachments: isMixedAttachments || null,
          files: resolvedFiles,
          options: resolvedOptions,
        })

        const msgId = (result as any)?.message?.id
        const parts: string[] = []
        if (msgId) parts.push(`message_id: ${msgId}`)
        if (resolvedFiles.length) parts.push(`${resolvedFiles.length} file(s)`)
        if (resolvedOptions.length) parts.push(`${resolvedOptions.length} button(s)`)
        log(`reply sent to chat ${chat_id} (${parts.join(', ')})`)
        return { content: [{ type: 'text', text: `Sent (${parts.join(', ')})` }] }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Failed to send: ${errMsg}` }], isError: true }
      }
    }

    case 'edit_message': {
      const message_id = rawArgs.message_id as string | undefined
      const text = rawArgs.text as string | undefined
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
      const chat_id = rawArgs.chat_id as string | undefined
      const title = rawArgs.title as string | undefined
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

interface MessageFileInfo {
  id: number
  messageId: number
  fileName: string
  fileData: string
  fileMimeType: string
  s3Key?: string | null
  isVideo: boolean | null
  isImage: boolean | null
  isDocument: boolean | null
  isAudio: boolean | null
}

interface MessageOptionInfo {
  id: number
  messageId: number
  text: string
  callbackData: string
  createdAt: string
}

interface ChatMessage {
  message: {
    id: number
    chatId: number
    sender: string | null
    text: string | null
    sentDate: string | null
    hasAttachment?: boolean
    isAudioMessage?: boolean | null
    audioDuration?: number | null
  }
  messageFiles: MessageFileInfo[]
  messageOptions: MessageOptionInfo[]
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

      // Skip verdict messages — don't forward "yes abcde" / "no abcde" to Claude
      if (VERDICT_RE.test(text)) continue

      // Build content string including attachment descriptions
      const contentParts: string[] = []
      if (text.trim()) contentParts.push(text)

      const files = msg.messageFiles ?? []
      for (const f of files) {
        const type = f.isImage ? 'image' : f.isVideo ? 'video' : f.isAudio ? 'audio' : 'document'
        contentParts.push(`[Attached ${type}: ${f.fileName}]`)
      }

      // Skip if nothing to forward
      if (contentParts.length === 0) continue

      const content = contentParts.join('\n')
      log(`New message in chat ${chatId}: "${content.slice(0, 100)}${content.length > 100 ? '...' : ''}"`)

      // Build file metadata for the meta object
      const fileMeta = files.map(f => ({
        file_name: f.fileName,
        mime_type: f.fileMimeType,
        url: f.fileData,
        type: f.isImage ? 'image' : f.isVideo ? 'video' : f.isAudio ? 'audio' : 'document',
      }))

      // Push channel notification to Claude Code (fire-and-forget)
      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content,
          meta: {
            chat_id: chatId,
            message_id: String(msg.message.id),
            user: 'User',
            user_id: USER_ID,
            assistant_id: ASSISTANT_ID,
            ts: msg.message.sentDate ?? new Date().toISOString(),
            has_attachment: files.length > 0 || (msg.message.hasAttachment ?? false),
            files: fileMeta.length > 0 ? fileMeta : undefined,
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
