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

const SIZE_LIMITS: Record<string, number> = {
  image: 10 * 1024 * 1024, video: 100 * 1024 * 1024,
  audio: 20 * 1024 * 1024, document: 25 * 1024 * 1024,
}

const S3_THRESHOLD = 5 * 1024 * 1024

const DOC_MIMES = new Set([
  'application/pdf', 'text/plain', 'text/csv', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/json', 'application/zip',
])

function guessMimeType(filePath: string): string | null {
  return MIME_MAP[extname(filePath).toLowerCase()] ?? null
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
  fileData: string
  fileMimeType: string
  s3Key?: string | null
  isImage: boolean
  isVideo: boolean
  isDocument: boolean
  isAudio: boolean
}

async function uploadViaS3(
  fileName: string, contentType: string, fileBuffer: Buffer,
): Promise<{ s3Key: string; downloadUrl: string }> {
  const uploadInfo = (await bgosPost(
    `files/upload-url?userId=${encodeURIComponent(USER_ID)}`,
    { fileName, contentType, size: fileBuffer.length },
  )) as { uploadUrl: string; key: string }
  const putResp = await fetch(uploadInfo.uploadUrl, {
    method: 'PUT', headers: { 'Content-Type': contentType },
    body: new Uint8Array(fileBuffer),
  })
  if (!putResp.ok) throw new Error(`S3 upload failed (HTTP ${putResp.status})`)
  const fileMeta = (await bgosPost(
    `files?userId=${encodeURIComponent(USER_ID)}`,
    { key: uploadInfo.key, type: contentType, size: fileBuffer.length },
  )) as { id: string; url: string; key: string }
  return { s3Key: uploadInfo.key, downloadUrl: fileMeta.url }
}

async function resolveFile(fileSpec: {
  url?: string; path?: string; file_name?: string; mime_type?: string
}): Promise<ResolvedFile> {
  if (fileSpec.url) {
    const urlPath = fileSpec.url.split('/').pop()?.split('?')[0] ?? 'file'
    const fileName = fileSpec.file_name ?? urlPath
    const mime = fileSpec.mime_type ?? guessMimeType(fileName) ?? 'application/octet-stream'
    const category = getFileCategory(mime)
    return {
      fileName, fileData: fileSpec.url, fileMimeType: mime,
      isImage: category === 'image', isVideo: category === 'video',
      isDocument: category === 'document', isAudio: category === 'audio',
    }
  }
  if (fileSpec.path) {
    const filePath = fileSpec.path
    const fileName = fileSpec.file_name ?? basename(filePath)
    const mime = fileSpec.mime_type ?? guessMimeType(filePath)
    if (!mime) throw new Error(`Cannot determine MIME type for "${filePath}"`)
    const category = getFileCategory(mime)
    if (!category) throw new Error(`Unsupported file type: ${mime}`)
    const fileStat = await stat(filePath)
    const limit = SIZE_LIMITS[category]
    if (fileStat.size > limit) throw new Error(`File exceeds ${Math.round(limit / 1024 / 1024)}MB limit`)
    const buffer = Buffer.from(await readFile(filePath))
    let fileData: string
    let s3Key: string | null = null
    if (buffer.length > S3_THRESHOLD) {
      log(`Uploading ${fileName} via S3...`)
      const result = await uploadViaS3(fileName, mime, buffer)
      fileData = result.downloadUrl
      s3Key = result.s3Key
    } else {
      fileData = `data:${mime};base64,${buffer.toString('base64')}`
    }
    return {
      fileName, fileData, fileMimeType: mime, s3Key,
      isImage: category === 'image', isVideo: category === 'video',
      isDocument: category === 'document', isAudio: category === 'audio',
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
      '## Asking the User to Choose (ask_user_input)',
      '',
      'Use `ask_user_input` ONLY when you need the user to pick from a clear set',
      'of mutually exclusive options AND the user is actively in this',
      'conversation (they just sent you a message and you need their answer to',
      'continue). The BGOS app shows a polished modal/sheet that pops over the',
      'chat with numbered choices, optional free-text fallback, and per-question',
      'Skip. The tool BLOCKS until every question is answered (option picked,',
      'free text typed, or skipped) — when it returns you have structured',
      'answers.',
      '',
      'Use it for: choosing an approach, picking a destination, ranking',
      'priorities, confirming intent before a destructive action, multi-step',
      'wizards (e.g. setting up a feature, onboarding, surveys).',
      '',
      'Do NOT use it for: open-ended questions ("what should I do?"), pure',
      'confirmations (use the permission-request flow), questions you can',
      'answer yourself, anything you would normally just send as a `reply`,',
      'OR situations where the user is not actively waiting on you (scheduled',
      'check-ins, background notifications, unsolicited suggestions). Modals',
      'demand immediate attention — they are inappropriate for async work.',
      '',
      'Each question: `{ text, options?: [{ label, value }], allow_free_text?,',
      'allow_skip? }`. If `options` is omitted or empty, send it as a regular',
      '`reply` message instead — the modal exists to make CHOOSING easier, not',
      'to wrap every question.',
      '',
      'Keep questions short and option labels under ~30 chars. Limit a single',
      'ask group to 1–4 questions; longer flows feel like an interrogation.',
      '',
      '## Inline Buttons (Telegram-style, Async)',
      '',
      'The BGOS app renders a second button style: "inline buttons" — a small',
      'card with tappable chips that sits in the chat thread, never blocks the',
      'session, and stays clickable indefinitely. This is the correct affordance',
      'for scheduled check-ins, proactive nudges, and any situation where the',
      'user is NOT actively waiting on you.',
      '',
      'Send inline buttons by passing a `buttons: [{ label, value }]` array to',
      '`reply`. Default render mode is "inline" — use `render_mode: "modal"`',
      'ONLY when the user is actively in conversation and you want their',
      'immediate choice. Max 6 buttons. Labels ≤ 24 chars render cleanly.',
      '',
      'When the user taps a button, you receive a channel event:',
      '  <channel source="bgos" event_type="button_clicked">',
      '    [button_clicked] Clicked: <label>',
      '    (in reply to message_id=N)',
      '  </channel>',
      'with `meta.callback_data` = the button\'s `value`, `meta.button_text` =',
      'the label, and `meta.message_id` = the original reply. React to it as',
      'you would any user message — send a follow-up `reply`, kick off work,',
      'etc. NEVER call `ask_user_input` as a substitute just because you want',
      'buttons — a blocking modal is wrong for anything async.',
      '',
      'Sentinels on `callback_data`:',
      '  - "__skip__" — user tapped Skip. Acknowledge briefly or move on.',
      '  - "__custom__" — user tapped Custom reply AND submitted free text.',
      '    `meta.custom_text` carries what they typed. You will ALSO receive',
      '    the free text as a normal user message right before/after — treat',
      '    them as correlated by message_id.',
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
        'and optional tappable buttons (inline Telegram-style chips or modal ' +
        'pop-under). At least one of text, files, or buttons is required. ' +
        'When buttons are sent, clicks arrive back as a channel event with ' +
        'callback_data (= the button\'s `value`) and message_id. Skip sentinel ' +
        'is "__skip__", Custom-reply sentinel is "__custom__" (with free text). ' +
        'Use `ask_user_input` instead only when you need blocking multi-question ' +
        'flow + free-text + skip semantics.',
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
                url: { type: 'string', description: 'URL of the file. Use for remote/web files.' },
                path: { type: 'string', description: 'Absolute local file path. Plugin reads and uploads the file.' },
                file_name: { type: 'string', description: 'Display name (optional).' },
                mime_type: { type: 'string', description: 'MIME type override (optional).' },
              },
            },
          },
          buttons: {
            type: 'array',
            description:
              'Optional tappable choices (2–6). Clicks come back as a channel event with `callback_data = button.value`. ' +
              'Labels should be under ~24 chars. Use this for async prompts where you do NOT want to block the session — ' +
              'e.g. "Review these 3 options when you get a chance." Chat shows a "Skip" and "Custom reply" affordance ' +
              'automatically; no need to include them yourself.',
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Visible button text (user-facing).' },
                value: { type: 'string', description: 'Stable identifier returned to you in the click callback_data.' },
              },
              required: ['label', 'value'],
            },
          },
          render_mode: {
            type: 'string',
            enum: ['inline', 'modal'],
            description:
              'Only meaningful when `buttons` is non-empty. "inline" (DEFAULT) — Telegram-style chips in the chat thread; ' +
              'never interrupts; stays clickable indefinitely. Use for async/scheduled/proactive sends. ' +
              '"modal" — pops over the chat demanding attention; use only when the user is actively in conversation ' +
              'and you want their immediate choice. When in doubt, omit (defaults to inline).',
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
    {
      name: 'ask_user_input',
      description:
        'Ask the user one or more multiple-choice questions through a polished ' +
        'modal/sheet in the BGOS app. BLOCKS until every question is answered ' +
        '(option picked, free text typed, or skipped) and returns structured ' +
        'answers. Use ONLY when (a) you need the user to pick from a clear ' +
        'set of options AND (b) the user is actively in this conversation. ' +
        'For open-ended questions use `reply`. For async/unprompted scenarios ' +
        '(scheduled check-ins, proactive nudges) DO NOT use this — a blocking ' +
        'modal is inappropriate when the user is not waiting on you. See the ' +
        'top-level instructions for full guidance on when this fits.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: {
            type: 'string',
            description: 'The chat to ask in (from the channel event attributes).',
          },
          questions: {
            type: 'array',
            description:
              '1–4 questions to ask, in order. Each must have at least one option ' +
              '(if you have no options, just send a regular reply instead).',
            items: {
              type: 'object',
              properties: {
                text: {
                  type: 'string',
                  description: 'The question to display. Keep under ~80 chars.',
                },
                options: {
                  type: 'array',
                  description:
                    'Selectable choices. 2–6 items. Each label under ~30 chars.',
                  items: {
                    type: 'object',
                    properties: {
                      label: {
                        type: 'string',
                        description: 'Visible button text.',
                      },
                      value: {
                        type: 'string',
                        description:
                          'Identifier returned in the answer when this option is picked.',
                      },
                    },
                    required: ['label', 'value'],
                  },
                  minItems: 2,
                },
                allow_free_text: {
                  type: 'boolean',
                  description:
                    'Show "Your answer…" input below the options. Default true.',
                },
                allow_skip: {
                  type: 'boolean',
                  description:
                    'Show a Skip button so the user can move past without answering. Default true.',
                },
              },
              required: ['text', 'options'],
            },
            minItems: 1,
            maxItems: 4,
          },
          timeout_seconds: {
            type: 'number',
            description:
              'Hard upper bound to wait for answers. Default 600 (10 minutes). ' +
              'On timeout, any unanswered questions return as { skipped: true }.',
          },
        },
        required: ['chat_id', 'questions'],
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
      const buttonsInput = rawArgs.buttons as Array<{
        label?: string; value?: string
      }> | undefined
      const renderModeRaw = rawArgs.render_mode as string | undefined
      const renderMode: 'inline' | 'modal' | undefined =
        renderModeRaw === 'inline' || renderModeRaw === 'modal'
          ? renderModeRaw
          : undefined

      if (!chat_id) {
        return { content: [{ type: 'text', text: 'Error: chat_id is required' }] }
      }
      if (!text && !filesInput?.length && !buttonsInput?.length) {
        return {
          content: [
            { type: 'text', text: 'Error: at least one of text, files, or buttons is required' },
          ],
        }
      }

      // Button validation — inline mode caps at 6 choices (backend rejects >6).
      let options: Array<{ text: string; callbackData: string }> = []
      if (buttonsInput?.length) {
        if (buttonsInput.length > 6) {
          return {
            content: [
              { type: 'text', text: 'Error: buttons must have 6 or fewer entries (inline rendering limit).' },
            ],
            isError: true,
          }
        }
        for (const b of buttonsInput) {
          if (!b.label || !b.value) {
            return {
              content: [
                { type: 'text', text: 'Error: each button needs both `label` and `value`.' },
              ],
              isError: true,
            }
          }
          options.push({ text: b.label, callbackData: b.value })
        }
      }

      try {
        const resolvedFiles: ResolvedFile[] = []
        if (filesInput?.length) {
          for (const fileSpec of filesInput) {
            resolvedFiles.push(await resolveFile(fileSpec))
          }
        }
        const hasAttachment = resolvedFiles.length > 0
        const categories = new Set(resolvedFiles.map(f => getFileCategory(f.fileMimeType)))
        const isMixedAttachments = resolvedFiles.length > 1 && categories.size > 1

        const body: Record<string, unknown> = {
          chatId: Number(chat_id),
          assistantId: Number(ASSISTANT_ID),
          text,
          sender: 'assistant',
          sentDate: new Date().toISOString(),
          hasAttachment,
          isMixedAttachments: isMixedAttachments || null,
          files: resolvedFiles,
          options,
        }
        // Default: inline when buttons present (matches backend + n8n defaults).
        // Agents can still force modal via render_mode = 'modal'.
        if (renderMode) body.renderMode = renderMode
        else if (options.length > 0) body.renderMode = 'inline'

        const result = await bgosPost('send-message', body)
        const msgId = (result as any)?.message?.id
        const parts: string[] = []
        if (msgId) parts.push(`message_id: ${msgId}`)
        if (resolvedFiles.length) parts.push(`${resolvedFiles.length} file(s)`)
        if (options.length) parts.push(`${options.length} button(s) (${body.renderMode})`)
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

    case 'ask_user_input': {
      const chat_id = rawArgs.chat_id as string | undefined
      const questions = rawArgs.questions as
        | Array<{
            text: string
            options: Array<{ label: string; value: string }>
            allow_free_text?: boolean
            allow_skip?: boolean
          }>
        | undefined
      const timeoutSeconds = (rawArgs.timeout_seconds as number | undefined) ?? 600

      if (!chat_id) {
        return { content: [{ type: 'text', text: 'Error: chat_id is required' }] }
      }
      if (!questions?.length) {
        return {
          content: [{ type: 'text', text: 'Error: at least one question is required' }],
        }
      }
      for (const q of questions) {
        if (!q.text || !q.options?.length) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: every question needs `text` and at least one option (use `reply` for open-ended questions).',
              },
            ],
            isError: true,
          }
        }
      }

      try {
        // Post each question. The first one returns an ask_id we reuse for
        // the rest so they group into one carousel.
        let askId: string | null = null
        const postedIds: number[] = []
        for (let i = 0; i < questions.length; i++) {
          const q = questions[i]
          const result = (await bgosPost('messages', {
            chatId: Number(chat_id),
            sender: 'assistant',
            text: q.text,
            messageType: 'ask_user_input',
            ...(askId ? { askId } : {}),
            askOrder: i + 1,
            allowFreeText: q.allow_free_text ?? true,
            allowSkip: q.allow_skip ?? true,
            options: q.options.map((o) => ({
              text: o.label,
              callbackData: o.value,
            })),
          })) as { id: number; askId: string | null }
          postedIds.push(result.id)
          if (!askId && result.askId) askId = result.askId
        }
        log(
          `ask_user_input: posted ${questions.length} question(s) to chat ${chat_id} (askId=${askId})`,
        )

        // Poll until every posted message has answeredAt set, or timeout.
        const targetIds = new Set(postedIds)
        const answers = new Map<
          number,
          {
            freeText?: string
            skipped?: boolean
            optionLabel?: string
            optionValue?: string
          }
        >()
        const startTime = Date.now()
        const deadline = startTime + timeoutSeconds * 1000

        while (Date.now() < deadline && answers.size < targetIds.size) {
          await new Promise((r) => setTimeout(r, 1500))
          try {
            const data = (await bgosGet(
              `chats/${chat_id}/messages?userId=${USER_ID}`,
            )) as {
              messages: Array<{
                message: {
                  id: number
                  text: string | null
                  answeredAt: string | null
                  answerPayload: {
                    optionId?: number
                    freeText?: string
                    skipped?: boolean
                  } | null
                }
                messageOptions: Array<{
                  id: number
                  text: string
                  callbackData: string
                }>
              }>
            }
            for (const entry of data.messages ?? []) {
              if (!targetIds.has(entry.message.id)) continue
              if (answers.has(entry.message.id)) continue
              if (!entry.message.answeredAt || !entry.message.answerPayload) continue
              const payload = entry.message.answerPayload
              const matched = payload.optionId
                ? entry.messageOptions.find((o) => o.id === payload.optionId)
                : undefined
              answers.set(entry.message.id, {
                ...(payload.freeText !== undefined && { freeText: payload.freeText }),
                ...(payload.skipped === true && { skipped: true }),
                ...(matched && {
                  optionLabel: matched.text,
                  optionValue: matched.callbackData,
                }),
              })
            }
          } catch (err) {
            log(`ask_user_input poll error: ${err}`)
          }
        }

        // Timeout fallback: any still-unanswered question is reported as skipped.
        const timedOut = answers.size < targetIds.size
        if (timedOut) {
          for (const id of targetIds) {
            if (!answers.has(id)) {
              answers.set(id, { skipped: true })
            }
          }
        }

        // Build the structured response in question order.
        const result = postedIds.map((id, i) => {
          const a = answers.get(id) ?? { skipped: true }
          return {
            question: questions[i].text,
            ...(a.optionValue !== undefined && {
              picked_option_value: a.optionValue,
              picked_option_label: a.optionLabel,
            }),
            ...(a.freeText !== undefined && { free_text: a.freeText }),
            ...(a.skipped === true && { skipped: true }),
          }
        })

        log(
          `ask_user_input: ${answers.size}/${targetIds.size} answered${timedOut ? ' (some timed out → skipped)' : ''}`,
        )

        return {
          content: [
            {
              type: 'text',
              text:
                (timedOut
                  ? `Some questions timed out (${timeoutSeconds}s) — those are reported as skipped.\n\n`
                  : '') +
                JSON.stringify(result, null, 2),
            },
          ],
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text', text: `ask_user_input failed: ${errMsg}` }],
          isError: true,
        }
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
}

interface AnswerPayload {
  option_id?: string | null
  callback_data?: string
  button_text?: string
  custom_text?: string
}

interface ChatMessage {
  message: {
    id: number
    chatId: number
    sender: string | null
    text: string | null
    sentDate: string | null
    hasAttachment?: boolean
    messageType?: string | null
    answeredAt?: string | null
    answerPayload?: AnswerPayload | null
    renderMode?: 'inline' | 'modal' | string | null
  }
  messageFiles?: MessageFileInfo[]
  messageOptions?: MessageOptionInfo[]
}

interface ChatHistoryResponse {
  messages: ChatMessage[]
}

const chatLastSeen = new Map<string, number>()
/**
 * Per-chat set of assistant message IDs that carried buttons and were
 * unanswered last time we polled. Used to detect click transitions
 * (unanswered → answered) so we can surface them as channel events.
 * ask_user_input messages are NOT tracked here — the ask_user_input tool
 * handles its own polling/blocking.
 */
const chatUnansweredButtons = new Map<string, Set<number>>()
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

    let newUserMessages: ChatMessage[]
    if (lastSeen === 0) {
      // First poll — forward any user messages that haven't been answered yet
      // (messages newer than the most recent assistant reply). This prevents
      // losing the user's first message when the plugin starts AFTER the
      // message was already sent (race condition).
      let lastAssistantId = 0
      for (const m of data.messages) {
        if (m.message.sender === 'assistant' && m.message.id > lastAssistantId) {
          lastAssistantId = m.message.id
        }
      }
      newUserMessages = data.messages.filter(
        (m) => m.message.sender === 'user' && m.message.id > lastAssistantId,
      )
    } else {
      newUserMessages = data.messages.filter(
        (m) => m.message.id > lastSeen && m.message.sender === 'user',
      )
    }

    chatLastSeen.set(chatId, maxId)

    // ── Detect inline/modal button-click transitions ──────────────────────
    // For every assistant message that still has options attached and is
    // NOT an ask_user_input (that tool owns its own polling), we watch the
    // answered_at field. When it flips from null → set, emit a channel
    // event carrying callback_data / button_text / (optional) custom_text.
    const prevUnanswered = chatUnansweredButtons.get(chatId) ?? new Set<number>()
    const nextUnanswered = new Set<number>()
    for (const m of data.messages) {
      const mm = m.message
      if (mm.sender !== 'assistant') continue
      if (mm.messageType === 'ask_user_input') continue
      const options = m.messageOptions ?? []
      if (options.length === 0) continue

      if (!mm.answeredAt) {
        nextUnanswered.add(mm.id)
        continue
      }
      // Answered. Only emit if we previously saw it unanswered OR this is
      // the first poll (lastSeen === 0) and the message is fresh. Avoids
      // re-emitting historical clicks every time the plugin restarts.
      if (!prevUnanswered.has(mm.id) && lastSeen !== 0) continue
      if (prevUnanswered.has(mm.id) || lastSeen === 0) {
        const payload = mm.answerPayload ?? {}
        const callbackData = payload.callback_data ?? ''
        const buttonText = payload.button_text ?? ''
        const customText = payload.custom_text ?? undefined
        const kind =
          callbackData === '__skip__'
            ? 'Skipped'
            : callbackData === '__custom__'
              ? 'Custom reply'
              : 'Clicked'
        const summary =
          customText
            ? `${kind}: "${customText}"`
            : buttonText
              ? `${kind}: ${buttonText}`
              : `${kind}: ${callbackData}`
        const contentLines = [
          `[button_clicked] ${summary}`,
          `(in reply to message_id=${mm.id})`,
        ]
        if (mm.text && mm.text.trim().length > 0) {
          const quoted = mm.text.length > 200 ? mm.text.slice(0, 197) + '…' : mm.text
          contentLines.push(`Original question: ${quoted}`)
        }
        mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: contentLines.join('\n'),
            meta: {
              chat_id: chatId,
              message_id: String(mm.id),
              event_type: 'button_clicked',
              callback_data: callbackData,
              button_text: buttonText,
              ...(customText ? { custom_text: customText } : {}),
              user: 'User',
              user_id: USER_ID,
              assistant_id: ASSISTANT_ID,
              ts: mm.answeredAt,
            },
          },
        }).catch((err) => {
          log(`Failed to deliver button_clicked to Claude: ${err}`)
        })
      }
    }
    chatUnansweredButtons.set(chatId, nextUnanswered)

    for (const msg of newUserMessages) {
      const text = msg.message.text ?? ''

      // Skip verdict messages — don't forward "yes abcde" / "no abcde" to Claude
      if (VERDICT_RE.test(text)) continue

      // Build content with attachment descriptions
      const contentParts: string[] = []
      if (text.trim()) contentParts.push(text)

      const files = msg.messageFiles ?? []
      for (const f of files) {
        const type = f.isImage ? 'image' : f.isVideo ? 'video' : f.isAudio ? 'audio' : 'document'
        contentParts.push(`[Attached ${type}: ${f.fileName} — ${f.fileData}]`)
      }

      if (contentParts.length === 0) continue

      const content = contentParts.join('\n')
      log(`New message in chat ${chatId}: "${content.slice(0, 100)}${content.length > 100 ? '...' : ''}"`)

      // Push channel notification to Claude Code (fire-and-forget)
      // Keep meta simple — file URLs are embedded in the content text
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
