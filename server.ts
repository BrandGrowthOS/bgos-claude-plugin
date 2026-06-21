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
import { basename } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import {
  MIME_MAP,
  DOC_MIMES,
  guessMimeType,
  getFileCategory,
  AGENT_VALUE_PREFIX,
  RESERVED_VALUE_SENTINELS,
  RESERVED_VALUE_PREFIXES,
  escapeAgentButtonValue,
  unescapeAgentButtonValue,
  collidesWithReserved,
  protectBackslashesForMarkdown,
  buildInboundContent,
  buildEventMeta,
} from './lib/message-text.js'

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

import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'

// Default to a stable, predictable log path so remote agents (where
// stderr isn't easily reachable from inside the agent loop) can read
// it via their Read tool. Override with BGOS_LOG_FILE if you want
// per-deployment routing.
const DEFAULT_LOG_PATH = pathJoin(
  tmpdir(),
  `bgos-plugin-${ASSISTANT_ID || 'unknown'}.log`,
)
const LOG_FILE = process.env.BGOS_LOG_FILE || DEFAULT_LOG_PATH

function log(msg: string): void {
  const line = `[bgos] ${msg}\n`
  process.stderr.write(line)
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}`)
  } catch {}
}

// ── File Type Helpers ────────────────────────────────────────────────────────
// MIME_MAP, DOC_MIMES, guessMimeType and getFileCategory now live in
// ./lib/message-text.ts (pure + eval-tested) and are imported above. Size limits
// and the S3 threshold remain here since they govern upload behavior, not text.

const SIZE_LIMITS: Record<string, number> = {
  image: 10 * 1024 * 1024, video: 100 * 1024 * 1024,
  audio: 20 * 1024 * 1024, document: 25 * 1024 * 1024,
}

const S3_THRESHOLD = 5 * 1024 * 1024

// Keep imported symbols referenced so a future tree-shake / unused-import lint
// never drops the MIME tables that resolveFile relies on transitively.
void MIME_MAP
void DOC_MIMES

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

async function bgosPut(path: string, body: Record<string, unknown>): Promise<unknown> {
  const url = `${API_BASE}/${path.replace(/^\//, '')}`
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`PUT ${response.status}: ${text.slice(0, 200)}`)
  }
  return response.json()
}

// ── BGOS REST Client (peer endpoints, adds X-Caller-Assistant-Id) ───────────
//
// Cross-channel agent-to-agent feature requires every peer call to carry
// X-Caller-Assistant-Id (this assistant's id) in addition to X-API-Key.
// The plugin already reads ASSISTANT_ID from env (BGOS_ASSISTANT_ID), that
// is exactly what this header needs.

async function bgosPeerGet(path: string): Promise<unknown> {
  const url = `${API_BASE}/${path.replace(/^\//, '')}`
  const response = await fetch(url, {
    headers: {
      'X-API-Key': API_KEY,
      'X-Caller-Assistant-Id': ASSISTANT_ID,
    },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`GET ${response.status}: ${text.slice(0, 200)}`)
  }
  return response.json()
}

async function bgosPeerPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  const url = `${API_BASE}/${path.replace(/^\//, '')}`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      'X-Caller-Assistant-Id': ASSISTANT_ID,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`POST ${response.status}: ${text.slice(0, 200)}`)
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

type PermissionBehavior = 'allow' | 'deny'
type PermissionChoice = 'once' | 'session' | 'permanent' | 'deny'

interface PendingPermission {
  chatId: string
  toolName: string
  description: string
  inputPreview?: string
  createdAt: number
  // User who is driving the session that triggered this permission request.
  // The verdict is bound to this user so that, in a shared-assistant chat,
  // an unrelated user cannot approve/deny a permission prompt that wasn't
  // theirs. Best-available value: the user_id of the most recent inbound user
  // message (falls back to the configured account owner USER_ID).
  requesterUserId: string
  resolve: (choice: PermissionChoice) => void
}

// Tracks the user_id of the most recent inbound USER message per chat. Used to
// bind a permission verdict to the user who actually drove the session, rather
// than accepting a verdict from any user in a shared-assistant chat. The plugin
// currently only ever sees the configured account owner (USER_ID) because the
// chat-message payload carries no per-sender user id, but this indirection
// means that once the backend starts shipping a distinct sender user_id, the
// binding tightens automatically with no further wiring.
const lastInboundUserByChat = new Map<string, string>()

/** Pending permission requests waiting for user verdict from BGOS chat. */
const pendingPermissions = new Map<string, PendingPermission>()

/** Regex matching typed fallback verdict: "yes abcde" or "no abcde" */
const VERDICT_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

/** Regex matching BGOS permission button callback identifiers. */
const PERMISSION_CALLBACK_RE = /^perm:(once|session|permanent|deny):([a-km-z]{5})$/i

// ── Button-value namespace isolation ─────────────────────────────────────────
// escapeAgentButtonValue / unescapeAgentButtonValue / collidesWithReserved and
// the AGENT_VALUE_PREFIX + reserved-sentinel/prefix constants now live in
// ./lib/message-text.ts (pure + eval-tested) and are imported above. Keep the
// constants referenced so an unused-import lint never drops them.
void AGENT_VALUE_PREFIX
void RESERVED_VALUE_SENTINELS
void RESERVED_VALUE_PREFIXES

/**
 * Best-effort extraction of the sender's user id from an inbound message-ish
 * object. The current backend does not stamp a per-sender user id on chat
 * messages, so this almost always resolves to the configured account owner
 * (USER_ID). Written to read a distinct field if/when the backend adds one, so
 * the permission-verdict binding tightens with zero further plumbing.
 *
 * TODO(backend): once chat messages carry a real per-sender user id
 * (e.g. message.senderUserId), this returns it and the verdict binding becomes
 * a true per-user check instead of the current account-owner fallback.
 */
function senderUserIdOf(message: unknown): string {
  const m = message as Record<string, unknown> | null | undefined
  const candidate =
    (m?.senderUserId as string | undefined) ??
    (m?.sender_user_id as string | undefined) ??
    (m?.userId as string | undefined) ??
    (m?.user_id as string | undefined)
  return typeof candidate === 'string' && candidate ? candidate : USER_ID
}

function permissionOptions(requestId: string): Array<{ text: string; callbackData: string }> {
  return [
    { text: 'Allow once', callbackData: `perm:once:${requestId}` },
    { text: 'Allow for session', callbackData: `perm:session:${requestId}` },
    { text: 'Allow permanently', callbackData: `perm:permanent:${requestId}` },
    { text: 'Do not allow', callbackData: `perm:deny:${requestId}` },
  ]
}

function choiceToBehavior(choice: PermissionChoice): PermissionBehavior {
  // Claude Code's current channel permission protocol, as used by the
  // official Telegram plugin, accepts only behavior='allow' or 'deny'. Keep
  // the richer BGOS UX now and collapse all allow scopes to 'allow' until the
  // upstream channel protocol exposes scoped behaviors.
  return choice === 'deny' ? 'deny' : 'allow'
}

function parsePermissionChoice(text: string, requestId: string): PermissionChoice | null {
  const trimmed = text.trim()
  const callback = PERMISSION_CALLBACK_RE.exec(trimmed)
  if (callback && callback[2]?.toLowerCase() === requestId.toLowerCase()) {
    return callback[1]!.toLowerCase() as PermissionChoice
  }

  const typed = VERDICT_RE.exec(trimmed)
  if (typed && typed[2]?.toLowerCase() === requestId.toLowerCase()) {
    return typed[1]!.toLowerCase().startsWith('y') ? 'once' : 'deny'
  }

  // Some BGOS clients materialize option clicks as a user message containing
  // the visible label rather than callbackData. This is still safe here because
  // waitForVerdict only inspects messages newer than the permission prompt.
  const normalized = trimmed.toLowerCase().replace(/[✅🔒❌]/g, '').trim()
  if (normalized === 'allow once') return 'once'
  if (normalized === 'allow for session') return 'session'
  if (normalized === 'allow permanently' || normalized === 'always allow') return 'permanent'
  if (normalized === 'do not allow' || normalized === 'deny' || normalized === 'not allowed') return 'deny'

  return null
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'bgos', version: '0.4.0' },
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
      'When you receive a message, process it using your full capabilities, ',
      'you can use Bash, Read, Write, Edit, Grep, Glob, WebSearch, and all',
      'other Claude Code tools to help the user.',
      '',
      'IMPORTANT: The user reads BGOS, not this session transcript. Plain text in',
      'your turn output never reaches their chat, it stays in your local terminal',
      'only. Every response to a BGOS message MUST go through the `reply` tool.',
      'If you forget to call `reply`, the user sees nothing. The plugin enforces',
      'this by sending a [reply-overdue] notification 2 minutes after any inbound',
      'message that has not been answered via the `reply` (or `meeting_reply`) tool.',
      '',
      'Once you have a response, use the `reply` tool to send it back.',
      'The reply will appear as a chat bubble in the BGOS desktop/mobile app.',
      'You can use markdown in your replies: **bold**, *italic*, `inline code`,',
      'fenced code blocks, [links](url), #/##/### headers, lists, > blockquotes.',
      'Tables do not render on mobile - use lists instead.',
      '',
      'Backslashes: the chat renders CommonMark, which (outside code) eats a',
      'backslash before punctuation - `a\\*b` would show as `a*b`. The plugin',
      'auto-protects backslashes in prose so file paths and regexes survive, but',
      'for anything the user must COPY EXACTLY (a Windows path, a regex, a shell',
      'snippet) prefer a code span or fenced block - inside code, every character',
      'is preserved verbatim and never linkified.',
      '',
      'Links are Telegram-style: bare URLs auto-link (https://…, www.…, bare',
      'domains like foo.com incl. modern TLDs .dev/.app, and emails), no',
      '[text](url) needed. A masked link ([text](url) where the text differs',
      'from the target) shows the user an "Open this link?" confirmation with',
      'the full URL before opening, so prefer bare URLs when transparency',
      'matters. URLs inside code spans/fences never linkify, use code when',
      'the user should copy a URL rather than open it.',
      '',
      '## Sending Files & Media',
      '',
      'The `reply` tool supports file attachments alongside text:',
      '- Pass a `files` array with objects containing either `url` (remote file) or `path` (local file).',
      '- Optional fields: `file_name` (display name), `mime_type` (override auto-detection).',
      '- Supported images: JPEG, PNG, GIF, WebP, SVG, BMP, TIFF (max 10 MB).',
      '- Supported videos: MP4, WebM, MOV, AVI, MKV (max 100 MB).',
      '- Supported documents: PDF, TXT, CSV, DOC/DOCX, XLS/XLSX, PPT/PPTX, JSON, YAML/YML, ZIP (max 25 MB).',
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
      'free text typed, or skipped), when it returns you have structured',
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
      'demand immediate attention, they are inappropriate for async work.',
      '',
      'Each question: `{ text, options?: [{ label, value }], allow_free_text?,',
      'allow_skip? }`. If `options` is omitted or empty, send it as a regular',
      '`reply` message instead, the modal exists to make CHOOSING easier, not',
      'to wrap every question.',
      '',
      'Keep questions short and option labels under ~30 chars. Limit a single',
      'ask group to 1, 4 questions; longer flows feel like an interrogation.',
      '',
      '## Inline Buttons (Telegram-style, Async)',
      '',
      'The BGOS app renders a second button style: "inline buttons", a small',
      'card with tappable chips that sits in the chat thread, never blocks the',
      'session, and stays clickable indefinitely. This is the correct affordance',
      'for scheduled check-ins, proactive nudges, and any situation where the',
      'user is NOT actively waiting on you.',
      '',
      'Send inline buttons by passing a `buttons: [{ label, value }]` array to',
      '`reply`. Default render mode is "inline", use `render_mode: "modal"`',
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
      'you would any user message, send a follow-up `reply`, kick off work,',
      'etc. NEVER call `ask_user_input` as a substitute just because you want',
      'buttons, a blocking modal is wrong for anything async.',
      '',
      'Sentinels on `callback_data`:',
      '  - "__skip__", user tapped Skip. Acknowledge briefly or move on.',
      '  - "__custom__", user tapped Custom reply AND submitted free text.',
      '    `meta.custom_text` carries what they typed. You will ALSO receive',
      '    the free text as a normal user message right before/after, treat',
      '    them as correlated by message_id.',
      '',
      '## Slash Commands From the User',
      '',
      'Users can pick slash commands from the BGOS app\'s composer. When they',
      'type `/`, the app shows an autocomplete picker populated from the catalog',
      'this plugin syncs on boot (built-in commands like `/help`, `/clear`,',
      '`/compact`, `/cost`, plus your user/project/plugin commands).',
      '',
      'A slash-command turn arrives as a normal `<channel source="bgos">` event',
      'with `meta.event_type = "slash_command"`, `meta.command_name = "<name>"`,',
      'and `meta.command_args = "<rest of message>"`. The `content` field is the',
      'literal text the user sent (e.g. `/help`). Treat the command exactly as you',
      'would in the CLI, invoke its behavior, then `reply` with the result.',
      '',
      '## Receiving Attachments',
      '',
      'When a user sends files, the channel event includes:',
      '- Text like "[Attached image: photo.jpg]" in the content.',
      '- A `files` array in the `meta` object with: `file_name`, `mime_type`,',
      '  `url` (presigned S3 URL valid ~1 hour), and `type` (image/video/document/audio).',
      '- You can view images via the URL or fetch documents via WebFetch.',
      '',
      '## SHARED-ASSISTANT CONTEXT',
      '',
      'This assistant may be shared with other users. Every inbound message includes:',
      '  - user_id            : the user who sent THIS message (always trust this for isolation)',
      '  - is_shared_recipient: true if the message is from a share recipient (not the owner)',
      '  - share_owner_user_id: the original assistant creator\'s id, present on shared messages',
      '',
      'If you store data per-user (memory, files, preferences), key it by `user_id` so',
      'recipients are isolated from the owner and from each other.',
      '',
      '## Setting Your Status (set_status)',
      '',
      'Use `set_status` to publish a short "what I am doing right now" line for',
      'the BGOS Command Center agent-roster view. This is OPTIONAL enrichment.',
      'BGOS already derives a live status (idle / thinking / working / blocked /',
      'done) from your messages and tool activity, so a self-report just makes the',
      'one-liner crisper ("Drafting headlines" instead of the derived "Working").',
      '',
      'Fields: `status_text` (≤120 chars; "" CLEARS it), `status_emoji` (≤8 chars,',
      'optional emoji on the avatar; "" clears), `detail` (≤280 chars, a richer',
      'one-sentence "what I am doing right now" for the context card; ephemeral;',
      '"" clears). Omit a field to leave it unchanged.',
      '',
      'Call it when you START a task or CHANGE phase ("Researching competitors",',
      '"Compiling the report", "Waiting on the API"); clear it ("") when you go',
      'idle. Do NOT PATCH it on every step (it is a coarse focus line, not a',
      'transcript), and never use it for your actual reply (use `reply`) or for',
      'anything the user must act on (use `ask_user_input`). Never required.',
      '',
      '## Machine-Delivered Events (inbound)',
      '',
      'Some inbound messages are machine-generated, not the human typing:',
      'dashboard-button dispatches, reply-watcher pushes, scheduled sweeps,',
      'voice-call transcripts, and n8n notifications. These arrive in the same',
      'user-message slot (so they wake you exactly like a human message) but the',
      'channel event carries `meta.event_type = "event"` plus `meta.event_source`',
      '(dashboard | voice-call | sweep | reply-watcher | n8n | unknown),',
      'and optionally `meta.event_title`, `meta.event_peek`, and `meta.event_payload`',
      '(arbitrary JSON). The `content` body is always the canonical, full message:',
      'act on it normally; your reply renders as a standard assistant message.',
      'Treat the event meta as a signal that this is data delivered TO you, not',
      'your user speaking.',
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

  log(`Permission request: ${tool_name} [${request_id}], ${description}`)

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

  // Interactive mode: send a Telegram-style BGOS approval prompt with
  // clickable options. We still keep the typed yes/no fallback below for old
  // clients or if a button-click event is not materialized in chat history.
  const chatId = monitoredChatIds[0]
  if (!chatId) {
    log(`No monitored chat found, auto-denying ${tool_name} [${request_id}]`)
    mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id, behavior: 'deny' },
    }).catch(() => {})
    return
  }

  let resolveButtonChoice!: (choice: PermissionChoice) => void
  const buttonChoice = new Promise<PermissionChoice>((resolve) => {
    resolveButtonChoice = resolve
  })

  // Bind the verdict to the user who is driving the session in this chat.
  // Falls back to the configured account owner when no inbound user has been
  // seen for this chat yet (e.g. a proactive/cron-triggered tool use).
  const requesterUserId = lastInboundUserByChat.get(chatId) ?? USER_ID

  pendingPermissions.set(request_id, {
    chatId,
    toolName: tool_name,
    description,
    inputPreview: input_preview,
    createdAt: Date.now(),
    requesterUserId,
    resolve: resolveButtonChoice,
  })

  // Send the permission prompt as an inline-button message. Click handling
  // lives in pollChat, perm:* callback_data is swallowed there and resolves
  // the verdict via the pendingPermissions map. Text-reply ("yes abcde" /
  // "no abcde") is kept as a fallback path for older clients without button
  // rendering.
  const promptText = [
    `🔐 **Permission Request**`,
    ``,
    `Claude wants to use **${tool_name}**`,
    `${description}`,
    input_preview ? `\n\`\`\`\n${input_preview}\n\`\`\`` : '',
    ``,
    `Choose an option below. Fallback: type **yes ${request_id}** or **no ${request_id}**.`,
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
      options: permissionOptions(request_id),
      renderMode: 'inline',
    })

    log(`Permission prompt sent to chat ${chatId} for ${tool_name} [${request_id}]`)

    // Race: inline-button click vs. text-reply verdict vs. 120s timeout.
    const choice = await Promise.race<PermissionChoice>([
      buttonChoice,
      waitForVerdict(request_id, chatId, 120_000, requesterUserId),
    ])
    const behavior = choiceToBehavior(choice)

    log(`Verdict for ${tool_name} [${request_id}]: ${choice} -> ${behavior}`)
    pendingPermissions.delete(request_id)
    mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id, behavior },
    }).catch((err) => {
      log(`Failed to send verdict: ${err}`)
    })
  } catch (err) {
    pendingPermissions.delete(request_id)
    log(`Permission relay failed for ${tool_name} [${request_id}]: ${err}`)
    // On failure, deny to be safe
    mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id, behavior: 'deny' },
    }).catch(() => {})
  }
})

/**
 * Wait for the user to choose a permission verdict in the BGOS chat.
 * Accepts either a button materialized as callbackData/text, or the typed
 * fallback "yes <id>" / "no <id>".
 *
 * The verdict is bound to `requesterUserId`, the user who drove the session
 * that triggered this permission request. In a shared-assistant chat this
 * prevents an unrelated user from approving/denying a prompt that wasn't
 * theirs. The binding is only enforced when the resolving message carries a
 * comparable per-sender user id; if it doesn't (current backend), we fall back
 * to the existing `sender === 'user'` behavior (see TODO below).
 */
async function waitForVerdict(
  requestId: string,
  chatId: string,
  timeoutMs: number,
  requesterUserId: string,
): Promise<PermissionChoice> {
  const startTime = Date.now()
  const baselineId = chatLastSeen.get(chatId) ?? 0

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1500))

    try {
      const data = (await bgosGet(
        `chats/${chatId}/messages?userId=${USER_ID}`,
      )) as ChatHistoryResponse
      if (!data.messages?.length) continue

      // Look for new user messages that match one of the verdict formats.
      for (const msg of data.messages) {
        if (msg.message.id <= baselineId) continue
        if (msg.message.sender !== 'user') continue

        // User binding: only accept the verdict from the user who triggered
        // the request. We extract a per-sender user id from the message when
        // present and require it to equal requesterUserId.
        //
        // TODO(backend): the chat-message payload does not yet carry a distinct
        // per-sender user id (senderUserIdOf falls back to USER_ID), so in a
        // multi-user shared-assistant chat this comparison is currently a
        // no-op (USER_ID === USER_ID) and we still accept any user-sent verdict
        //, the same as the pre-hardening behavior. Once the backend stamps a
        // real sender user id, this binding tightens automatically with no
        // further code change. The button-click path (PERMISSION_CALLBACK_RE in
        // pollChat) carries the same limitation and the same future fix.
        const resolverUserId = senderUserIdOf(msg.message)
        if (resolverUserId !== requesterUserId) {
          log(
            `Ignoring permission verdict for [${requestId}] from user ` +
              `${resolverUserId} (request belongs to ${requesterUserId})`,
          )
          continue
        }

        const text = msg.message.text ?? ''
        const choice = parsePermissionChoice(text, requestId)
        if (!choice) continue

        // Update last seen so we don't re-process this message
        chatLastSeen.set(chatId, Math.max(chatLastSeen.get(chatId) ?? 0, msg.message.id))

        return choice
      }
    } catch {
      // Poll error, retry
    }
  }

  log(`Permission timeout for [${requestId}], denying`)
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
            description:
              'The chat to reply in. Pass back the chat_id (or, if present, the ' +
              'session_handle) from the channel event you are answering. The ' +
              'plugin rejects chat ids it has not received an inbound event for.',
          },
          text: {
            type: 'string',
            description:
              'The message text to send. Supports markdown. Bare URLs/emails ' +
              'auto-link (Telegram-style); masked [text](url) links show the ' +
              'user an "Open this link?" confirmation, so prefer bare URLs. ' +
              'URLs in code spans stay plain. Optional if sending files or buttons.',
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
              'Optional tappable choices (2, 6). Clicks come back as a channel event with `callback_data = button.value`. ' +
              'Labels should be under ~24 chars. Use this for async prompts where you do NOT want to block the session, ' +
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
              'Only meaningful when `buttons` is non-empty. "inline" (DEFAULT), Telegram-style chips in the chat thread; ' +
              'never interrupts; stays clickable indefinitely. Use for async/scheduled/proactive sends. ' +
              '"modal", pops over the chat demanding attention; use only when the user is actively in conversation ' +
              'and you want their immediate choice. When in doubt, omit (defaults to inline).',
          },
          reply_to_id: {
            type: 'number',
            description:
              'Set this to the source message id when you want to anchor this ' +
              'reply to a specific earlier message, BGOS renders a Telegram-' +
              'style quoted-reply header (tap → jump to source) and persists a ' +
              'frozen text/sender snapshot. Two use-cases: ' +
              '(1) USER REPLY-QUOTE, answering a question from N messages ago ' +
              "where the user would otherwise have to scroll up, following up on " +
              "your own past commitment, correcting a specific earlier statement, " +
              "or surfacing a cron-triggered nudge tied to an older message. " +
              "Don't quote the immediately preceding user turn (alignment already " +
              'implies the subject) or for pure acknowledgements ("Got it"). ' +
              '(2) AGENT-TO-AGENT SIDE-THREAD, when replying to an inbound peer ' +
              "agent message so the initiating agent's wait_for_reply resolves. " +
              'Same-chat constraint enforced server-side (400 otherwise).',
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
      name: 'set_status',
      description:
        'Publish this agent\'s "what I am doing right now" line for the BGOS ' +
        'Command Center agent-roster view (capability #11). OPTIONAL enrichment: ' +
        'BGOS already derives a live status (idle / thinking / working / blocked / ' +
        'done) from your messages and tool activity, so a self-report only makes ' +
        'the one-liner crisper and more human ("Drafting headlines" instead of the ' +
        'derived "Working"). Call it when you START a task or CHANGE phase; pass an ' +
        'empty string ("") for status_text to CLEAR it when you go idle. Do NOT ' +
        'call it on every step (it is a coarse "current focus", not a transcript) ' +
        'and never use it for your actual reply to the user (use `reply`) or for ' +
        'anything the user must act on (use `ask_user_input`). Maps to ' +
        'PATCH /api/v1/assistants/:id/status (user-scoped, X-API-Key).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status_text: {
            type: 'string',
            description:
              'Short "current focus" line, max 120 chars (e.g. "Researching ' +
              'competitors"). Pass "" to CLEAR the status. Omit to leave it ' +
              'unchanged while only updating the emoji or detail.',
          },
          status_emoji: {
            type: 'string',
            description:
              'Optional single emoji that rides the agent avatar, max 8 chars ' +
              '(ZWJ sequences ok). Pass "" to clear. Omit to leave unchanged.',
          },
          detail: {
            type: 'string',
            description:
              'Optional richer one-sentence "what I am doing right now" for the ' +
              'Command Center context card, max 280 chars (e.g. "Cross-checking ' +
              'the Q3 invoices against the bank export"). Ephemeral (not persisted ' +
              'on the assistant row); dropped if the agent has no live activity ' +
              'entry yet. Pass "" to clear. Omit to leave unchanged.',
          },
        },
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
        '(scheduled check-ins, proactive nudges) DO NOT use this, a blocking ' +
        'modal is inappropriate when the user is not waiting on you. See the ' +
        'top-level instructions for full guidance on when this fits.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: {
            type: 'string',
            description:
              'The chat to ask in. Pass back the chat_id (or session_handle) ' +
              'from the channel event. Rejected if not a chat you received an ' +
              'inbound event for.',
          },
          questions: {
            type: 'array',
            description:
              '1, 4 questions to ask, in order. Each must have at least one option ' +
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
                    'Selectable choices. 2, 6 items. Each label under ~30 chars.',
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
    {
      name: 'list_peers',
      description:
        "List the user's other assistants (peer agents) on this BGOS account. " +
        'Each entry includes `assistantId` (the integer to pass to send_to_peer), ' +
        '`name`, `avatarUrl`, and crucially `introduced`, true ONLY if the user ' +
        'has enabled this direction in the Agent Permissions matrix. If introduced ' +
        'is false, you can suggest the peer in your reply ("Want me to ask Hades?") ' +
        'but send_to_peer will return requires_introduction until the user enables it. ' +
        'system_hint is intentionally omitted to prevent capability leakage between agents.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'send_to_peer',
      description:
        "Send a message into another BGOS assistant's side-thread. The peer receives " +
        'it as a normal inbound message tagged with `fromAgent` so they know it came ' +
        'from a peer, not the user. The user sees the exchange unfold inline as a ' +
        'minimalist SideConversationCard rendered against the parent message in this ' +
        "chat. Set parent_message_id to the id of one of YOUR previous reply messages " +
        "(the one the card visually anchors to in this chat). Set wait_for_reply=true " +
        'to BLOCK until the peer replies (their reply must include reply_to_id pointing ' +
        'to the message_id you sent). Returns { status, sideThreadChatId, messageId, reply? }. ' +
        "Status='requires_introduction' means the user has not enabled this direction. " +
        "Do NOT retry on timeout, the message is already saved server-side. " +
        "Either drop wait_for_reply (cap is 85s anyway) and poll the side-thread " +
        "later, or accept the timeout and check " +
        "GET /api/v1/peers/threads/{parent_message_id} for any reply with " +
        "replyToId matching your sent messageId.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          target_assistant_id: {
            type: 'number',
            description: 'The peer assistant id (from list_peers).',
          },
          text: { type: 'string', description: 'The message body for the peer agent.' },
          parent_message_id: {
            type: 'number',
            description:
              'A message id in YOUR chat that anchors the SideConversationCard. ' +
              'Typically the id of a reply you just sent saying "Looping in <peer>...".',
          },
          wait_for_reply: { type: 'boolean', description: 'Block until peer replies. Default false.' },
          timeout_seconds: {
            type: 'number',
            description: 'How long to wait when wait_for_reply=true. 1, 600s. Default 60s.',
          },
          turn_state: {
            type: 'string',
            enum: ['expecting_reply', 'more_coming', 'final'],
            description:
              "Lifecycle hint for the peer conversation. 'expecting_reply' (default) yields the turn to the peer. 'more_coming' keeps the turn so multiple updates land back-to-back without releasing it. 'final' closes the conversation; further sends from either side require a fresh send_to_peer (which will auto-open a new conversation).",
          },
        },
        required: ['target_assistant_id', 'text', 'parent_message_id'],
      },
    },
    {
      name: 'complete_peer_thread',
      description:
        "Close the active peer conversation between you and a peer assistant. " +
        "Pass a one-line `summary` describing what was accomplished. CLOSE " +
        "POLICY: either participant (initiator OR peer) may close at any time " +
        "once they consider the exchange finished; you do NOT have to be the " +
        "initiator, and whoever is satisfied first should close rather than " +
        "waiting. This performs a real both-sides close: the conversation is " +
        "truly ended and BOTH sides are notified with your one-line summary, " +
        "which shows as the collapsed-state caption on the SideConversationCard " +
        "so the user doesn't have to expand the card to know what happened. " +
        "Use this when the back-and-forth is complete and you don't expect more " +
        "messages on this thread. After closing, any send_to_peer to the same " +
        "peer will auto-open a NEW conversation. FAILSAFE: if nobody closes, an " +
        "idle sweeper hard-closes the stale conversation after the configured " +
        "idle window (default 15 minutes, env PEER_CONV_IDLE_CLOSE_MS) with a " +
        "generated summary and a both-sides notification, so nothing is left " +
        "stuck on 'Live'. Calling this explicitly is still ALWAYS preferred " +
        "when you can write a real summary.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          peer_assistant_id: {
            type: 'number',
            description: "The peer assistant id whose active conversation with you should be closed.",
          },
          summary: {
            type: 'string',
            description:
              'One-line synthesis of what the peer accomplished (e.g. "Hades created bgos-dev-uploads in us-east-1, public access blocked"). Max 1024 chars. Strongly recommended, without it the UI shows a generic "Conversation completed" line.',
          },
        },
        required: ['peer_assistant_id'],
      },
    },
    {
      name: 'peer_status',
      description:
        "Check whether a peer assistant is currently online (an MCP plugin or " +
        "channel adapter is connected for them right now) and whether you have " +
        "an open conversation with them. Use this BEFORE send_to_peer when you " +
        "want to know if the peer will see your message immediately or only on " +
        "their next reconnect. Returns { online, lastSeenAt, hasOpenConversation, " +
        "conversationId, turnHolderId }.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          peer_assistant_id: {
            type: 'number',
            description: 'The peer assistant id to check status for.',
          },
        },
        required: ['peer_assistant_id'],
      },
    },
    {
      name: 'complete_side_thread',
      description:
        'Mark a side conversation complete with a one-line synthesis. The user ' +
        'sees this in the SideConversationCard once the live exchange ends, it ' +
        'flips the card from live (pulsing dot + last 2 turns) to ' +
        'completed-collapsed (static dot + this summary). CLOSE POLICY: either ' +
        'participant (initiator OR peer) may call this at any time once they ' +
        'consider the exchange finished. You do not have to be the initiator. ' +
        'When an open conversation exists this performs a real both-sides close ' +
        '(neither agent, nor a cross-user counterpart, is left stuck on Live) ' +
        'and notifies both sides with your one-line summary. FAILSAFE: if ' +
        'nobody closes, an idle sweeper hard-closes the stale conversation ' +
        'after the configured idle window (default 15 minutes, env ' +
        'PEER_CONV_IDLE_CLOSE_MS) with a generated summary and a both-sides ' +
        'notification, so nothing is left stuck on Live.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          parent_message_id: {
            type: 'number',
            description: 'Same parent_message_id you used in send_to_peer.',
          },
          summary: {
            type: 'string',
            description:
              'One-line synthesis of what the peer accomplished (e.g., "Hades created bgos-dev-uploads in us-east-1, public access blocked").',
          },
        },
        required: ['parent_message_id', 'summary'],
      },
    },
    {
      name: 'meeting_reply',
      description:
        'Send a message into an active Command Center meeting room. Use ONLY ' +
        'when you are the current speaker, the channel notification you ' +
        'received will say "your_turn=YES" in its meta header. If your_turn=NO ' +
        'you must observe silently; the backend will reject calls (HTTP 409) ' +
        'while it is not your turn. End your reply text with "@<name>" to ' +
        'suggest the next speaker (the user can override). Send the literal ' +
        'token "PASS" to decline this turn without contributing, turn returns ' +
        'to the user.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          meeting_id: {
            type: 'number',
            description:
              'Meeting room id from the channel notification meta. Required.',
          },
          text: {
            type: 'string',
            description:
              'Your reply. Plain text or markdown. Trailing "@<name>" suggests next speaker.',
          },
          next_speaker_id: {
            type: 'number',
            description:
              'Optional explicit next-speaker assistantId. If omitted, the backend infers from any @-mention in `text`.',
          },
          yield_only: {
            type: 'boolean',
            description:
              'When true, send "PASS" and yield without contributing. Equivalent to setting text="PASS".',
          },
        },
        required: ['meeting_id'],
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
      const reply_to_id = rawArgs.reply_to_id as number | undefined

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

      // Membership check: refuse to forward a chat_id we were never authorized
      // to see. Resolves an opaque sessionHandle back to its raw chat id and
      // returns the handle to prefer on the way back.
      const replyAuth = resolveAuthorizedChat(chat_id)
      if (!replyAuth.ok) return replyAuth.error
      const resolvedChatId = replyAuth.chatId
      const replySessionHandle = replyAuth.sessionHandle

      const meetingIdForChat = meetingIdByChatId.get(String(resolvedChatId))
      if (meetingIdForChat != null) {
        if (filesInput?.length || buttonsInput?.length) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: meeting replies currently support text only. Use meeting_reply with meeting_id.',
              },
            ],
            isError: true,
          }
        }
        try {
          const result = await bgosPost(`meetings/${meetingIdForChat}/messages`, {
            text,
            asAssistantId: Number(ASSISTANT_ID),
          })
          log(`meeting reply sent via reply tool to meeting ${meetingIdForChat} (chat ${resolvedChatId})`)
          clearInbound(resolvedChatId)
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          return { content: [{ type: 'text', text: `meeting reply failed: ${errMsg}` }], isError: true }
        }
      }

      // Button validation, inline mode caps at 6 choices (backend rejects >6).
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
          // Namespace-escape the agent value so it can never collide with the
          // plugin's reserved control prefixes/sentinels. Stripped on the way
          // back in pollChat's click-transition handler.
          if (collidesWithReserved(b.value)) {
            log(
              `reply: agent button value "${b.value}" collides with a reserved ` +
                `namespace, escaping with "${AGENT_VALUE_PREFIX}" sentinel`,
            )
          }
          options.push({ text: b.label, callbackData: escapeAgentButtonValue(b.value) })
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

        // Backslash fix: the BGOS frontend renders replies as CommonMark
        // (react-native-markdown-display / markdown-it). CommonMark consumes a
        // backslash that precedes ASCII punctuation (e.g. `\*`, `\_`, `\[`, `\\`),
        // so an agent that writes a Windows path or a regex in PROSE would lose
        // the backslash on screen. protectBackslashesForMarkdown doubles exactly
        // those backslashes, OUTSIDE code spans/fences, so one literal backslash
        // survives rendering. Backslashes inside code and before non-escapable
        // chars (\d, \w, \U) are left untouched.
        const safeText = protectBackslashesForMarkdown(text)

        const body: Record<string, unknown> = {
          chatId: Number(resolvedChatId),
          assistantId: Number(ASSISTANT_ID),
          text: safeText,
          sender: 'assistant',
          sentDate: new Date().toISOString(),
          hasAttachment,
          isMixedAttachments: isMixedAttachments || null,
          files: resolvedFiles,
          options,
          // Prefer the opaque, server-minted handle when we have one, the
          // hardened backend treats it as authoritative for chat resolution.
          ...(replySessionHandle ? { sessionHandle: replySessionHandle } : {}),
          ...(reply_to_id !== undefined && { replyToId: reply_to_id }),
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
        log(`reply sent to chat ${resolvedChatId} (${parts.join(', ')})`)
        clearInbound(resolvedChatId)
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
        // Same CommonMark backslash protection as the reply path, an edited
        // message is rendered the same way, so it needs the same fix.
        const safeText = protectBackslashesForMarkdown(text)
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
            text: safeText,
            message: { text: safeText },
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
      // Membership check before forwarding the agent-supplied chat_id.
      const renameAuth = resolveAuthorizedChat(chat_id)
      if (!renameAuth.ok) return renameAuth.error
      try {
        await bgosPatch(`chats/${renameAuth.chatId}/title`, { title })
        return { content: [{ type: 'text', text: `Renamed to "${title}"` }] }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Failed: ${errMsg}` }], isError: true }
      }
    }

    case 'set_status': {
      // Optional enrichment over the derived activity status (capability #11).
      // Only forward fields the caller actually supplied: omitting a field
      // leaves the corresponding column unchanged; passing "" clears it.
      // Empty string is a meaningful CLEAR, so we test `!== undefined`, never
      // truthiness.
      const status_text = rawArgs.status_text as string | undefined
      const status_emoji = rawArgs.status_emoji as string | undefined
      const detail = rawArgs.detail as string | undefined

      if (
        status_text === undefined &&
        status_emoji === undefined &&
        detail === undefined
      ) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: provide at least one of status_text, status_emoji, or detail (pass "" to clear a field).',
            },
          ],
          isError: true,
        }
      }

      const body: Record<string, unknown> = {}
      if (status_text !== undefined) body.statusText = status_text
      if (status_emoji !== undefined) body.statusEmoji = status_emoji
      if (detail !== undefined) body.detail = detail

      try {
        await bgosPatch(`assistants/${ASSISTANT_ID}/status`, body)
        const cleared =
          (status_text !== undefined && status_text === '') &&
          status_emoji === undefined &&
          detail === undefined
        const summary = cleared
          ? 'Status cleared.'
          : `Status set${status_text ? `: "${status_text}"` : ''}${status_emoji ? ` ${status_emoji}` : ''}.`
        return { content: [{ type: 'text', text: summary }] }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Failed to set status: ${errMsg}` }], isError: true }
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
      // Membership check before forwarding the agent-supplied chat_id.
      const askAuth = resolveAuthorizedChat(chat_id)
      if (!askAuth.ok) return askAuth.error
      const askChatId = askAuth.chatId
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
            chatId: Number(askChatId),
            sender: 'assistant',
            text: q.text,
            messageType: 'ask_user_input',
            ...(askId ? { askId } : {}),
            askOrder: i + 1,
            allowFreeText: q.allow_free_text ?? true,
            allowSkip: q.allow_skip ?? true,
            // Namespace-escape agent option values (same isolation as `reply`).
            options: q.options.map((o) => ({
              text: o.label,
              callbackData: escapeAgentButtonValue(o.value),
            })),
          })) as { id: number; askId: string | null }
          postedIds.push(result.id)
          if (!askId && result.askId) askId = result.askId
        }
        log(
          `ask_user_input: posted ${questions.length} question(s) to chat ${askChatId} (askId=${askId})`,
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
              `chats/${askChatId}/messages?userId=${USER_ID}`,
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
                  // Strip the `u:` sentinel so the agent gets its original value.
                  optionValue: unescapeAgentButtonValue(matched.callbackData),
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
                  ? `Some questions timed out (${timeoutSeconds}s), those are reported as skipped.\n\n`
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

    case 'list_peers': {
      try {
        const result = await bgosPeerGet('peers')
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `list_peers failed: ${errMsg}` }], isError: true }
      }
    }

    case 'send_to_peer': {
      const target_assistant_id = rawArgs.target_assistant_id as number | undefined
      const text = (rawArgs.text as string | undefined) ?? ''
      const parent_message_id = rawArgs.parent_message_id as number | undefined
      const wait_for_reply = rawArgs.wait_for_reply === true
      const timeout_seconds = rawArgs.timeout_seconds as number | undefined
      const turn_state = rawArgs.turn_state as
        | 'expecting_reply'
        | 'more_coming'
        | 'final'
        | undefined

      if (!target_assistant_id || !parent_message_id || !text) {
        return {
          content: [{ type: 'text', text: 'Error: target_assistant_id, parent_message_id and text are required.' }],
          isError: true,
        }
      }
      try {
        const result = await bgosPeerPost(
          `peers/${target_assistant_id}/send`,
          {
            text,
            parentMessageId: parent_message_id,
            waitForReply: wait_for_reply,
            ...(timeout_seconds !== undefined && { timeoutSeconds: timeout_seconds }),
            ...(turn_state !== undefined && { turnState: turn_state }),
          },
        )
        // Clear any pending reply-overdue tracker for the side-thread chat
        //, the peer's inbound was just responded to, so the 2-min timer
        // should not fire for it.
        const sideThreadChatId = (result as any)?.sideThreadChatId
        if (sideThreadChatId != null) clearInbound(String(sideThreadChatId))
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `send_to_peer failed: ${errMsg}` }], isError: true }
      }
    }

    case 'complete_peer_thread': {
      const peer_assistant_id = rawArgs.peer_assistant_id as number | undefined
      const summary = rawArgs.summary as string | undefined
      if (!peer_assistant_id) {
        return {
          content: [{ type: 'text', text: 'Error: peer_assistant_id is required.' }],
          isError: true,
        }
      }
      try {
        const result = await bgosPeerPost(
          `peers/conversations/close`,
          {
            peerAssistantId: peer_assistant_id,
            ...(summary && summary.trim().length > 0 && { summary: summary.trim() }),
          },
        )
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `complete_peer_thread failed: ${errMsg}` }], isError: true }
      }
    }

    case 'peer_status': {
      const peer_assistant_id = rawArgs.peer_assistant_id as number | undefined
      if (!peer_assistant_id) {
        return {
          content: [{ type: 'text', text: 'Error: peer_assistant_id is required.' }],
          isError: true,
        }
      }
      try {
        const result = await bgosPeerGet(`peers/${peer_assistant_id}/status`)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `peer_status failed: ${errMsg}` }], isError: true }
      }
    }

    case 'complete_side_thread': {
      const parent_message_id = rawArgs.parent_message_id as number | undefined
      const summary = rawArgs.summary as string | undefined
      if (!parent_message_id || !summary) {
        return {
          content: [{ type: 'text', text: 'Error: parent_message_id and summary are required.' }],
          isError: true,
        }
      }
      try {
        const result = await bgosPeerPost(
          `peers/threads/${parent_message_id}/complete`,
          { summary },
        )
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `complete_side_thread failed: ${errMsg}` }], isError: true }
      }
    }

    case 'meeting_reply': {
      const meeting_id = rawArgs.meeting_id as number | undefined
      const yield_only = rawArgs.yield_only === true
      const text = yield_only
        ? 'PASS'
        : ((rawArgs.text as string | undefined) ?? '').trim()
      const next_speaker_id = rawArgs.next_speaker_id as number | undefined
      if (!meeting_id) {
        return {
          content: [{ type: 'text', text: 'Error: meeting_id is required.' }],
          isError: true,
        }
      }
      if (!text) {
        return {
          content: [{ type: 'text', text: 'Error: text is required (or set yield_only=true).' }],
          isError: true,
        }
      }
      // Resolve our own assistantId from env so the backend recognises this
      // call as agent-side (turn-protocol enforced).
      const body: Record<string, unknown> = {
        text,
        asAssistantId: Number(ASSISTANT_ID),
        ...(next_speaker_id != null && { nextSpeakerAssistantId: next_speaker_id }),
        ...(yield_only && { yieldTurn: true }),
      }
      try {
        const result = await bgosPost(`meetings/${meeting_id}/messages`, body)
        const ctx = meetingContexts.get(Number(meeting_id))
        if (ctx?.chatId != null) clearInbound(String(ctx.chatId))
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `meeting_reply failed: ${errMsg}` }], isError: true }
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
  // Canonical (current backend), camelCase. Backend writes this shape into
  // messages.answer_payload as of the 2026-04-22 inline-buttons release.
  optionId?: number | null
  callbackData?: string
  buttonText?: string
  customText?: string
  freeText?: string
  skipped?: boolean
  // Legacy rows written before the camelCase migration. Read as a fallback
  // so old answered messages continue to surface correctly.
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
    commandName?: string | null
    commandArgs?: string | null
    // Machine-delivered event envelope (capability #12). Present when the
    // inbound user-slot message is machine-generated (dashboard dispatch,
    // reply-watcher, sweep, voice-call transcript, n8n notification) rather
    // than the human typing. The `text` body is canonical regardless; this is
    // surfaced to the agent as meta so it can tell data-delivered-to-me apart
    // from my-user-speaking.
    eventMeta?: {
      source?: string | null
      title?: string | null
      peek?: string | null
      payload?: unknown
    } | null
    // Opaque, server-minted handle the agent should round-trip instead of a
    // raw chat_id. Present on inbound events from a hardened backend; absent
    // on older backends (in which case we fall back to the raw chat_id).
    sessionHandle?: string | null
    session_handle?: string | null
  }
  messageFiles?: MessageFileInfo[]
  messageOptions?: MessageOptionInfo[]
}

interface ChatHistoryResponse {
  messages: ChatMessage[]
}

const chatLastSeen = new Map<string, number>()

// ── Reply-overdue tracking ──────────────────────────────────────────────────
// Per-chat: most recent unanswered inbound user/peer message. If the agent
// doesn't call `reply` within REPLY_OVERDUE_MS, fire ONE channel notification
// reminding the agent to reply (or to explicitly stay silent). Deterministic
// backstop for a known failure mode where the agent outputs plain text in
// its turn instead of calling `reply`, leaving the user with no response.
//
// Meeting chat ids are excluded, meetings use the meeting_reply tool path
// gated by user_mediated turn assignment, so absence of reply is expected
// while waiting for a turn.
interface PendingInbound {
  messageId: number
  ts: number
  reminded: boolean
}
const pendingInbounds = new Map<string, PendingInbound>()
const meetingChatIds = new Set<string>()
interface MeetingParticipantSummary {
  assistantId: number
  name: string
  avatarUrl: string | null
}
interface MeetingContext {
  chatId: number
  title: string | null
  participants: MeetingParticipantSummary[]
  speakerPolicy: string
  currentSpeakerId: number | null
}
const meetingContexts = new Map<number, MeetingContext>()
const meetingIdByChatId = new Map<string, number>()
// Maps a peer_conversation_id → side-thread chatId, populated when a peer
// inbound carries peer_conversation_id. Used by peer_conversation_closed
// handler to clear the overdue tracker for that side-thread when the peer
// (not us) closes it, otherwise the inbound stays pending and fires a
// false-positive overdue 2 min after the close.
const peerConvChats = new Map<string, string>()
const REPLY_OVERDUE_MS = 120_000

function recordInbound(chatId: string, messageId: number): void {
  if (!chatId) return
  // Authorize the chat for outbound dispatch even before the overdue-tracker
  // guards below short-circuit (meeting chats, malformed ids). Receiving an
  // inbound is proof the backend routed this chat to us.
  noteMonitoredChat(chatId)
  if (meetingChatIds.has(chatId)) return
  if (!Number.isFinite(messageId)) return
  const existing = pendingInbounds.get(chatId)
  if (existing && existing.messageId >= messageId) return
  pendingInbounds.set(chatId, { messageId, ts: Date.now(), reminded: false })
}

function clearInbound(chatId: string | undefined): void {
  if (!chatId) return
  pendingInbounds.delete(chatId)
}

function normalizeMeetingParticipant(raw: any): MeetingParticipantSummary | null {
  const assistantId = Number(raw?.assistantId ?? raw?.id)
  if (!Number.isFinite(assistantId)) return null
  return {
    assistantId,
    name: String(raw?.name ?? `Assistant ${assistantId}`),
    avatarUrl: raw?.avatarUrl ?? raw?.avatar_url ?? null,
  }
}

function rememberMeetingContext(meeting: any): void {
  const meetingId = Number(meeting?.id ?? meeting?.meetingId)
  const chatId = Number(meeting?.chatId ?? meeting?.chat_id)
  if (!Number.isFinite(meetingId) || !Number.isFinite(chatId)) return
  const participants = Array.isArray(meeting?.participants)
    ? meeting.participants
        .map((p: any) => normalizeMeetingParticipant(p?.assistant ? p.assistant : p))
        .filter((p: MeetingParticipantSummary | null): p is MeetingParticipantSummary => p != null)
    : []
  const currentRaw = meeting?.currentSpeakerId ?? meeting?.current_speaker_id
  const currentSpeakerId =
    currentRaw == null || currentRaw === ''
      ? null
      : Number.isFinite(Number(currentRaw))
        ? Number(currentRaw)
        : null
  meetingContexts.set(meetingId, {
    chatId,
    title: meeting?.title ?? null,
    participants,
    speakerPolicy: String(meeting?.speakerPolicy ?? meeting?.speaker_policy ?? 'parallel'),
    currentSpeakerId,
  })
  meetingChatIds.add(String(chatId))
  meetingIdByChatId.set(String(chatId), meetingId)
  noteMonitoredChat(String(chatId))
}

function forgetMeetingContext(meetingId: number): void {
  const ctx = meetingContexts.get(meetingId)
  if (ctx?.chatId != null) {
    const chatId = String(ctx.chatId)
    meetingChatIds.delete(chatId)
    meetingIdByChatId.delete(chatId)
  }
  meetingContexts.delete(meetingId)
}

function reconcileMeetingContexts(activeMeetingChatIds: Set<string>): void {
  for (const chatId of Array.from(meetingChatIds)) {
    if (activeMeetingChatIds.has(chatId)) continue
    const meetingId = meetingIdByChatId.get(chatId)
    meetingChatIds.delete(chatId)
    meetingIdByChatId.delete(chatId)
    if (meetingId != null) meetingContexts.delete(meetingId)
    clearInbound(chatId)
  }

  for (const [meetingId, ctx] of Array.from(meetingContexts.entries())) {
    const chatId = String(ctx.chatId)
    if (activeMeetingChatIds.has(chatId)) continue
    meetingContexts.delete(meetingId)
    meetingIdByChatId.delete(chatId)
    meetingChatIds.delete(chatId)
    clearInbound(chatId)
  }
}

function parseMeetingMentions(text: string, ctx: MeetingContext): number[] {
  if (!text || ctx.participants.length === 0) return []
  const byKey = new Map<string, number>()
  for (const p of ctx.participants) {
    const lower = p.name.toLowerCase()
    const first = lower.split(/\s+/)[0]!
    if (!byKey.has(first)) byKey.set(first, p.assistantId)
    if (!byKey.has(lower)) byKey.set(lower, p.assistantId)
  }
  const out: number[] = []
  const seen = new Set<number>()
  const re = /\B@([a-zA-Z][\w-]{0,49})\b/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) != null) {
    const id = byKey.get(match[1]!.toLowerCase())
    if (id != null && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

function isMyMeetingTurn(text: string, ctx: MeetingContext): boolean {
  const me = Number(ASSISTANT_ID)
  const mentioned = parseMeetingMentions(text, ctx)
  if (mentioned.length > 0) {
    if (ctx.speakerPolicy === 'sequential') return mentioned[0] === me
    if (ctx.speakerPolicy === 'parallel' || ctx.speakerPolicy === 'user_mediated') {
      return mentioned.includes(me)
    }
  }
  return ctx.currentSpeakerId === me
}

function checkReplyOverdue(): void {
  const now = Date.now()
  for (const [chatId, p] of pendingInbounds.entries()) {
    if (p.reminded) continue
    if (now - p.ts < REPLY_OVERDUE_MS) continue
    p.reminded = true
    const ageSec = Math.round((now - p.ts) / 1000)
    log(`reply-overdue fired for chat ${chatId} message ${p.messageId} (${ageSec}s)`)
    mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content:
          `[reply-overdue] Message in chat_id=${chatId} (message_id=${p.messageId}) ` +
          `arrived ${ageSec}s ago and no reply has been sent yet. ` +
          `If you intended to respond, call the \`reply\` tool now. ` +
          `If you intended to stay silent, ignore this notification.`,
        meta: {
          event_type: 'reply_overdue',
          chat_id: chatId,
          message_id: String(p.messageId),
          age_seconds: String(ageSec),
          ts: new Date(now).toISOString(),
        },
      },
    }).catch((err) => log(`Failed to deliver reply-overdue: ${err}`))
  }
}
/**
 * Per-chat set of assistant message IDs that carried buttons and were
 * unanswered last time we polled. Used to detect click transitions
 * (unanswered → answered) so we can surface them as channel events.
 * ask_user_input messages are NOT tracked here, the ask_user_input tool
 * handles its own polling/blocking.
 */
const chatUnansweredButtons = new Map<string, Set<number>>()
let monitoredChatIds: string[] = []

// ── Chat membership authority ────────────────────────────────────────────────
// Defense-in-depth: the backend is the sole authority for chat resolution +
// participation, but we additionally refuse to forward an agent-supplied
// chat_id we have never been authorized to see. The set is seeded by
// discoverChats() (filtered to assistantId === ASSISTANT_ID + active meetings)
// and grows as inbound channel events (poll + WS) arrive for a chat. A chat we
// have never discovered NOR received an inbound from is rejected before any
// reply/rename/ask dispatch instead of being forwarded verbatim.
const monitoredChatSet = new Set<string>()

// Opaque, server-minted session handles. The backend now mints a fresh
// sessionHandle on every inbound event that agents should round-trip instead
// of naming a raw chat_id. We capture the latest handle per chat and, when we
// have one, prefer sending it back (as `sessionHandle` in the POST body) over
// the raw chat_id. Agents may also pass a handle directly as `chat_id`, any
// value present here (as key OR value) is treated as authorized.
const sessionHandleByChat = new Map<string, string>()
const knownSessionHandles = new Set<string>()

/** Mark a chat id as authorized (seen via discovery or an inbound event). */
function noteMonitoredChat(chatId: string | undefined | null): void {
  if (!chatId) return
  monitoredChatSet.add(String(chatId))
}

/**
 * Capture an opaque sessionHandle the adapter received on an inbound event,
 * binding it to its chat so we can (a) prefer it on the way back and (b) treat
 * it as an authorized identifier if an agent echoes it as `chat_id`.
 */
function rememberSessionHandle(
  chatId: string | undefined | null,
  handle: unknown,
): void {
  if (typeof handle !== 'string' || !handle) return
  knownSessionHandles.add(handle)
  if (chatId) sessionHandleByChat.set(String(chatId), handle)
}

/**
 * Validate an agent-supplied `chat_id` before dispatching reply/rename/ask.
 * Accepts either (a) a chat id in the monitored set, or (b) an opaque
 * sessionHandle the adapter previously received. Returns the resolved raw
 * chat id on success, or an MCP error content payload on rejection.
 *
 * Returns `{ ok: true, chatId }` where chatId is always the RAW chat id usable
 * for REST paths, plus `sessionHandle` (preferred for POST bodies) when known.
 */
function resolveAuthorizedChat(rawChatId: string):
  | { ok: true; chatId: string; sessionHandle?: string }
  | { ok: false; error: { content: Array<{ type: 'text'; text: string }>; isError: true } } {
  const id = String(rawChatId)

  // Case (b): the agent round-tripped an opaque sessionHandle. Resolve it back
  // to the raw chat id it was minted for (if we still have that mapping).
  if (knownSessionHandles.has(id)) {
    let mappedChat: string | undefined
    for (const [chat, handle] of sessionHandleByChat.entries()) {
      if (handle === id) {
        mappedChat = chat
        break
      }
    }
    return {
      ok: true,
      chatId: mappedChat ?? id,
      sessionHandle: id,
    }
  }

  // Case (a): a raw chat id we have been authorized to see.
  if (monitoredChatSet.has(id)) {
    return { ok: true, chatId: id, sessionHandle: sessionHandleByChat.get(id) }
  }

  log(
    `Rejected dispatch to unauthorized chat_id=${id} ` +
      `(not in monitored set [${[...monitoredChatSet].join(',') || 'empty'}] ` +
      `and not a known sessionHandle)`,
  )
  return {
    ok: false,
    error: {
      content: [
        {
          type: 'text' as const,
          text:
            `Error: chat_id "${id}" is not one this assistant is a participant of. ` +
            `Only reply/rename/ask in chats you received an inbound event from. ` +
            `Pass back the chat_id (or sessionHandle) from the channel event you are answering.`,
        },
      ],
      isError: true as const,
    },
  }
}

async function discoverChats(): Promise<void> {
  try {
    const data = (await bgosPeerGet('peers/inbox')) as {
      chats: {
        id: number
        assistantId: number
        kind?: 'main' | 'a2a' | 'meeting'
      }[]
    }
    // Two acceptance rules:
    //  - Owned chats (main + a2a): plugin owns the chat directly →
    //    assistantId === ASSISTANT_ID.
    //  - Meeting chats: the chat is owned by the FIRST-listed participant
    //    (see backend meetings.service.ts), so other participants' plugins
    //    never match the strict assistantId equality. The backend's
    //    peers/inbox now UNIONs in meeting chats where this assistant is
    //    an active meeting_participants row, so trust kind='meeting' as
    //    sufficient, the server already gated that row on this assistant
    //    being an active participant. We still reconcile the raw inbox
    //    meeting ids against /meetings below so closed owner meetings do
    //    not keep the daemon in fast-poll mode forever.
    const ownedChatIds = data.chats
      .filter(
        (c) =>
          c.assistantId === Number(ASSISTANT_ID) && c.kind !== 'meeting',
      )
      .map((c) => String(c.id))
    const meetingChatSet = new Set(
      data.chats
        .filter((c) => c.kind === 'meeting')
        .map((c) => String(c.id)),
    )
    const openMeetingChatSet = new Set<string>()
    if (meetingChatSet.size > 0) {
      const meetings = (await bgosGet('meetings')) as any[]
      for (const meeting of meetings ?? []) {
        if (meeting?.status !== 'open') continue
        const chatId = String(meeting?.chatId ?? meeting?.chat_id ?? '')
        if (!meetingChatSet.has(chatId)) continue
        openMeetingChatSet.add(chatId)
        rememberMeetingContext(meeting)
      }
    }
    reconcileMeetingContexts(openMeetingChatSet)
    monitoredChatIds = [...new Set([...ownedChatIds, ...openMeetingChatSet])]
    // Seed the membership authority. We only ADD here (never prune): a chat we
    // have received a live inbound from but that has momentarily dropped out of
    // the inbox snapshot must stay answerable. Stale ids cost nothing, the
    // backend remains the final gate on every POST.
    for (const id of monitoredChatIds) noteMonitoredChat(id)
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

    // Messages are returned oldest → newest by message id. Make sure we
    // operate on a stable ordered copy (defensive; the backend already
    // orders them, but a bad sort would silently corrupt the heuristic).
    const ordered = [...data.messages].sort(
      (a, b) => a.message.id - b.message.id,
    )

    let newUserMessages: ChatMessage[]
    let isBacklog = false
    if (lastSeen === 0) {
      // First poll, we have no persisted cursor, so we need to forward
      // user messages that haven't been answered yet WITHOUT over-forwarding
      // historic ones.
      //
      // The old heuristic (forward user messages newer than the LATEST
      // assistant message) silently dropped messages when the latest
      // assistant message was a PROACTIVE send (cron check-in, external
      // trigger) rather than a reply, prior user messages looked "already
      // answered" when they weren't.
      //
      // New rule: walk backward and collect trailing user messages, only
      // stopping at a real user→assistant REPLY (an assistant message
      // whose immediately preceding message is a user message). Proactive
      // assistant messages (preceded by another assistant or by nothing)
      // do NOT terminate the scan. Capped to the last 10 to avoid dumping
      // half the chat on first boot.
      const collected: ChatMessage[] = []
      const MAX_FIRST_POLL_FORWARD = 10
      for (let i = ordered.length - 1; i >= 0; i--) {
        const m = ordered[i]!
        if (m.message.sender === 'user') {
          collected.push(m)
          if (collected.length >= MAX_FIRST_POLL_FORWARD) break
          continue
        }
        if (m.message.sender === 'assistant') {
          const prev = i > 0 ? ordered[i - 1]! : null
          if (prev && prev.message.sender === 'user') {
            // Real reply, everything older was handled. Stop here.
            break
          }
          // Proactive assistant message, skip, keep scanning backward.
          continue
        }
      }
      newUserMessages = collected.reverse()
      // Mark these as a backlog so the notification framing makes it
      // explicit to Claude that these came in WHILE OFFLINE. Without
      // this, Claude can't tell a fresh user message apart from a
      // crash-recovered one and may treat it as already-handled.
      isBacklog = newUserMessages.length > 0
    } else {
      newUserMessages = ordered.filter(
        (m) => m.message.id > lastSeen && m.message.sender === 'user',
      )
    }

    chatLastSeen.set(chatId, maxId)

    // If an assistant message has already been written that supersedes our
    // pending unanswered inbound (covers replies sent via non-Claude paths
    // like n8n agents or scheduled callbacks), clear the overdue tracker.
    const pendingForChat = pendingInbounds.get(chatId)
    if (pendingForChat) {
      const supersedingAssistant = ordered.find(
        (m) =>
          m.message.id > pendingForChat.messageId &&
          m.message.sender === 'assistant',
      )
      if (supersedingAssistant) clearInbound(chatId)
    }

    // ── Detect inline/modal button-click transitions ──────────────────────
    // For every assistant message that still has options attached and is
    // NOT an ask_user_input (that tool owns its own polling), we watch the
    // answered_at field. When it flips from null → set between polls, emit
    // a channel event carrying callback_data / button_text / custom_text?.
    //
    // On the FIRST poll for a chat (lastSeen === 0) we ONLY baseline the
    // unanswered set, never emit. Historic clicks that happened before
    // the plugin started are not replayed (previously they were, which
    // flooded Claude Code's context on every restart and could cause the
    // agent to silently stop responding).
    const prevUnanswered = chatUnansweredButtons.get(chatId) ?? new Set<number>()
    const nextUnanswered = new Set<number>()
    const isFirstPoll = lastSeen === 0 && !chatUnansweredButtons.has(chatId)
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
      // Answered. Only emit when we previously saw this exact message id
      // in the unanswered set, i.e. a real live transition.
      if (isFirstPoll) continue
      if (!prevUnanswered.has(mm.id)) continue

      const payload = mm.answerPayload ?? {}
      const callbackData = payload.callbackData ?? payload.callback_data ?? ''
      const buttonText = payload.buttonText ?? payload.button_text ?? ''
      const customText = payload.customText ?? payload.custom_text ?? undefined

      // Internal permission-flow intercept: perm:(once|session|permanent|deny):<request_id>.
      // Swallow these, do NOT forward to Claude as a channel event; resolve
      // the pending verdict instead. The three allow scopes currently collapse
      // to Claude's binary allow behavior in choiceToBehavior().
      const permMatch = PERMISSION_CALLBACK_RE.exec(callbackData)
      if (permMatch) {
        const [, choice, requestId] = permMatch
        const pending = pendingPermissions.get(requestId)
        if (pending) {
          // User binding (mirrors waitForVerdict): only the user who triggered
          // the request may resolve it via a button click.
          //
          // TODO(backend): the answer payload carries no clicker user id, so
          // senderUserIdOf falls back to USER_ID and this comparison is a
          // no-op today (same limitation as the text-verdict path). It tightens
          // automatically once the backend stamps a clicker user id.
          const clickerUserId = senderUserIdOf(payload)
          if (clickerUserId !== pending.requesterUserId) {
            log(
              `Ignoring permission button click ${choice} [${requestId}] from ` +
                `user ${clickerUserId} (request belongs to ${pending.requesterUserId})`,
            )
            continue
          }
          log(`Permission inline-button click: ${choice} [${requestId}]`)
          pending.resolve(choice!.toLowerCase() as PermissionChoice)
          pendingPermissions.delete(requestId)
        } else {
          log(`Stale permission click ${choice} [${requestId}], no pending entry`)
        }
        continue
      }

      // Strip the `u:` namespace sentinel so the agent receives the exact value
      // it authored. Reserved sentinels (__skip__/__custom__) are never escaped
      // and pass through untouched.
      const agentCallbackData = unescapeAgentButtonValue(callbackData)

      const kind =
        agentCallbackData === '__skip__'
          ? 'Skipped'
          : agentCallbackData === '__custom__'
            ? 'Custom reply'
            : 'Clicked'
      const summary =
        customText
          ? `${kind}: "${customText}"`
          : buttonText
            ? `${kind}: ${buttonText}`
            : `${kind}: ${agentCallbackData}`
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
            callback_data: agentCallbackData,
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
    chatUnansweredButtons.set(chatId, nextUnanswered)

    for (const msg of newUserMessages) {
      const text = msg.message.text ?? ''

      // Skip permission verdict messages/clicks, don't forward them to Claude
      let isPermissionVerdict = VERDICT_RE.test(text)
      if (!isPermissionVerdict) {
        for (const requestId of pendingPermissions.keys()) {
          if (parsePermissionChoice(text, requestId)) {
            isPermissionVerdict = true
            break
          }
        }
      }
      if (isPermissionVerdict) continue

      const meetingId = meetingIdByChatId.get(chatId)
      const meetingCtx = meetingId != null ? meetingContexts.get(meetingId) : undefined
      if (meetingId != null && meetingCtx) {
        const yourTurn = isMyMeetingTurn(text, meetingCtx)
        const participantList = meetingCtx.participants
          .filter((p) => Number(p.assistantId) !== Number(ASSISTANT_ID))
          .map((p) => p.name)
          .join(', ')
        log(
          `${isBacklog ? 'Backlog' : 'New'} meeting message in chat ${chatId}: ` +
            `meeting=${meetingId} your_turn=${yourTurn ? 'YES' : 'NO'}`,
        )
        mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content:
              `${isBacklog ? '[backlog, meeting message arrived while you were offline]\n' : ''}` +
              `[Meeting #${meetingId}, your_turn=${yourTurn ? 'YES' : 'NO'}, ` +
              `participants: ${participantList || 'unknown'}]\n` +
              `User: ${text}`,
            meta: {
              chat_id: chatId,
              message_id: String(msg.message.id),
              user: 'User',
              user_id: USER_ID,
              assistant_id: ASSISTANT_ID,
              ts: msg.message.sentDate ?? new Date().toISOString(),
              event_type: 'meeting_message',
              meeting_id: String(meetingId),
              sender_type: 'user',
              sender_name: 'User',
              your_turn: yourTurn ? 'YES' : 'NO',
              ...(meetingCtx.currentSpeakerId == null
                ? {}
                : { current_speaker_id: String(meetingCtx.currentSpeakerId) }),
              transport: 'poll',
              ...(isBacklog ? { backlog: true } : {}),
            },
          },
        }).catch((err) => {
          log(`Failed to deliver meeting poll inbound to Claude: ${err}`)
        })
        continue
      }

      // Build content with attachment descriptions. User text is forwarded
      // VERBATIM (buildInboundContent does not transform it) so the agent sees
      // backslashes, code fences, quotes and newlines exactly as typed.
      // The backlog prefix tells Claude this message arrived while the daemon
      // was offline so it knows to respond now rather than treat it as
      // already-handled chat history.
      const content = buildInboundContent(text, msg.messageFiles ?? [], {
        backlogPrefix: isBacklog
          ? '[backlog - message arrived while you were offline; please respond]'
          : undefined,
      })

      if (!content) continue

      log(`${isBacklog ? 'Backlog' : 'New'} message in chat ${chatId}: "${content.slice(0, 100)}${content.length > 100 ? '...' : ''}"`)

      // Push channel notification to Claude Code (fire-and-forget)
      // Keep meta simple, file URLs are embedded in the content text
      const isSlashCommand = msg.message.messageType === 'slash_command'
      // Machine-delivered event enrichment (capability #12): tag inbound
      // dashboard dispatches / watcher pushes / sweeps / transcripts / n8n
      // notifications so the agent can tell them apart from the human typing.
      // The `content` body is already canonical (forwarded verbatim above).
      const pollEventMeta = buildEventMeta(
        msg.message.messageType,
        msg.message.eventMeta,
      )
      // Capture + surface any server-minted session handle so the agent can
      // round-trip it on the reply (preferred over the raw chat_id).
      const pollSessionHandle =
        msg.message.sessionHandle ?? msg.message.session_handle ?? undefined
      rememberSessionHandle(chatId, pollSessionHandle)
      // Remember who drove this chat so a permission verdict can be bound to
      // them (see lastInboundUserByChat / PendingPermission.requesterUserId).
      lastInboundUserByChat.set(chatId, senderUserIdOf(msg.message))
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
            ...(typeof pollSessionHandle === 'string' && pollSessionHandle
              ? { session_handle: pollSessionHandle }
              : {}),
            ...(isBacklog ? { backlog: true } : {}),
            ...(isSlashCommand
              ? {
                  event_type: 'slash_command',
                  command_name: msg.message.commandName ?? '',
                  command_args: msg.message.commandArgs ?? '',
                }
              : {}),
            ...(!isSlashCommand && pollEventMeta ? pollEventMeta : {}),
          },
        },
      }).catch((err) => {
        log(`Failed to deliver inbound to Claude: ${err}`)
      })
      // Skip overdue tracking for backlog messages: they were forwarded
      // because the daemon was offline, not because they're new live
      // traffic. The previous session may have already handled them via
      // a different process, or they might be stale. The backlog framing
      // itself prompts the agent to respond if relevant; double-tracking
      // creates false positives on plugin restart.
      if (!isBacklog) recordInbound(chatId, msg.message.id)
    }
  } catch {
    // Silent, network blips
  }
}

async function pollAllChats(): Promise<void> {
  for (const chatId of monitoredChatIds) {
    await pollChat(chatId)
  }
}

// ── Realtime WS subscription ─────────────────────────────────────────────────
//
// Connects to BGOS via socket.io-client, authenticates with X-API-Key (via
// `apiKey` query param) and joins both `user:<id>` and `assistant:<id>` rooms.
// When the WS is healthy, polling backs off to every 60s as a heartbeat
// safety net. When the WS disconnects, polling resumes its normal cadence.
//
// We listen to:
//   - `inbound_message`, peer / integration messages routed to assistant:<id>
//   - `peer_conversation_closed`, surfaces lifecycle to the agent
//   - `peer_turn_yielded`, informational; not yet bubbled to MCP
//
// Existing `pollChat` flow stays in place; it's the cold-start backfill +
// reliability fallback. Normal WS-pushed messages update `chatLastSeen` so
// a subsequent poll won't re-emit them. Meeting WS events intentionally do
// not update `chatLastSeen`; pollChat gets one chance to replay the turn in
// case the channel renderer drops the specialized meeting notification.
// For the WS path itself we maintain a small Set of processed message ids
// to suppress repeated socket events.

import { io as socketIoClient, type Socket as IOClientSocket } from 'socket.io-client'

const WS_URL = (() => {
  const base = BACKEND_URL.replace(/\/$/, '').replace(/\/api\/v1$/, '')
  return base
})()

const wsForwardedMessageIds = new Set<number>()
const WS_FORWARD_CACHE_MAX = 500
let realtimeSocket: IOClientSocket | null = null

function rememberForwarded(id: number): void {
  if (wsForwardedMessageIds.has(id)) return
  wsForwardedMessageIds.add(id)
  // Bound the set so a long-running plugin doesn't grow forever.
  if (wsForwardedMessageIds.size > WS_FORWARD_CACHE_MAX) {
    const first = wsForwardedMessageIds.values().next().value
    if (first !== undefined) wsForwardedMessageIds.delete(first)
  }
}

function isWsHealthy(): boolean {
  return !!realtimeSocket?.connected
}

function connectWebsocket(): void {
  realtimeSocket = socketIoClient(WS_URL, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    // Use Socket.IO `auth` so the API key never enters the URL or any
    // intermediate proxy access log. Backend reads from
    // client.handshake.auth and falls back to query for compatibility.
    auth: {
      apiKey: API_KEY,
      assistantId: ASSISTANT_ID,
    },
  })

  realtimeSocket.on('connect', () => {
    log(`WS connected (id=${realtimeSocket?.id}), polling will throttle`)
    // Catch-up after a WS reconnect: server-side WS pushes that fired
    // while we were disconnected don't replay, so trigger an immediate
    // poll cycle to pull in anything we missed. Without this we'd have
    // to wait up to 60s (the WS-healthy poll interval) before noticing.
    pollAllChats().catch((err) => {
      log(`Post-reconnect catch-up poll failed: ${err}`)
    })
  })

  realtimeSocket.on('disconnect', (reason: string) => {
    log(`WS disconnected: ${reason}, polling resumes normal cadence`)
  })

  realtimeSocket.on('connect_error', (err: Error) => {
    log(`WS connect error: ${err.message}`)
  })

  realtimeSocket.on('inbound_message', (payload: any) => {
    try {
      const messageId = Number(payload?.messageId ?? payload?.message_id)
      if (!Number.isFinite(messageId)) return
      if (wsForwardedMessageIds.has(messageId)) return
      rememberForwarded(messageId)

      // Also bump chatLastSeen so the subsequent poll cycle won't re-emit
      // this same message. Number(chatId) → string, matching the keying
      // pollChat uses.
      const chatId = String(payload?.chatId ?? payload?.chat_id ?? '')
      if (chatId) {
        const seen = chatLastSeen.get(chatId) ?? 0
        if (messageId > seen) chatLastSeen.set(chatId, messageId)
        noteMonitoredChat(chatId)
      }
      // Capture any opaque session handle the backend minted for this inbound
      // so we can prefer round-tripping it (over the raw chat_id) on the reply.
      const wsSessionHandle = payload?.sessionHandle ?? payload?.session_handle
      rememberSessionHandle(chatId, wsSessionHandle)
      // Remember who drove this chat (for permission-verdict user binding).
      if (chatId) lastInboundUserByChat.set(chatId, senderUserIdOf(payload))

      // Mirror pollChat's content-building: text PLUS attachment lines, with
      // the user's text forwarded VERBATIM. Backend ships files as
      // { id, filename, mime, url?, dataUri? } in the inbound_message payload.
      // buildInboundContent handles both that WS shape and the poll shape, so
      // the two transports stay byte-for-byte consistent. Without attachment
      // handling the WS path silently drops files while bumping lastSeen, so the
      // poll fallback never re-emits and agents get text-only copies of media.
      const text = (payload?.text as string | undefined) ?? ''
      const wsFiles = Array.isArray(payload?.files) ? payload.files : []
      const content = buildInboundContent(text, wsFiles)
      if (!content) return

      const wsMessageType = String(payload?.messageType ?? payload?.message_type ?? '')
      const isWsSlashCommand = wsMessageType === 'slash_command'
      // Machine-delivered event enrichment (capability #12), same as the poll
      // path. Backend ships the envelope as `eventMeta` (camelCase) on the
      // inbound_message payload; accept event_meta defensively too.
      const wsEventMeta = buildEventMeta(
        wsMessageType,
        (payload?.eventMeta ?? payload?.event_meta) as
          | { source?: string | null; title?: string | null; peek?: string | null; payload?: unknown }
          | null
          | undefined,
      )
      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content,
          meta: {
            chat_id: chatId,
            message_id: String(messageId),
            user: 'User',
            user_id: USER_ID,
            assistant_id: ASSISTANT_ID,
            ts: new Date().toISOString(),
            transport: 'ws',
            ...(typeof wsSessionHandle === 'string' && wsSessionHandle
              ? { session_handle: wsSessionHandle }
              : {}),
            ...(isWsSlashCommand
              ? {
                  event_type: 'slash_command',
                  command_name: String(payload?.commandName ?? payload?.command_name ?? ''),
                  command_args: String(payload?.commandArgs ?? payload?.command_args ?? ''),
                }
              : {}),
            ...(!isWsSlashCommand && wsEventMeta ? wsEventMeta : {}),
            ...(payload?.peer_conversation_id !== undefined && {
              peer_conversation_id: String(payload.peer_conversation_id),
            }),
            ...(payload?.peerConversationId !== undefined && {
              peer_conversation_id: String(payload.peerConversationId),
            }),
            ...(payload?.turn_state && { turn_state: payload.turn_state }),
            ...(payload?.turnState && { turn_state: payload.turnState }),
          },
        },
      }).catch((err) => log(`WS forward error: ${err}`))
      recordInbound(chatId, messageId)
      // If this inbound carries a peer_conversation_id, remember which
      // side-thread chat hosts it so peer_conversation_closed can clear
      // the overdue tracker without needing chatId in its own payload.
      const convId =
        payload?.peer_conversation_id ?? payload?.peerConversationId
      if (convId != null && chatId) {
        peerConvChats.set(String(convId), chatId)
      }
    } catch (err) {
      log(`WS inbound_message handler error: ${err}`)
    }
  })

  realtimeSocket.on('peer_conversation_closed', (payload: any) => {
    log(
      `peer_conversation_closed conv=${payload?.conversation_id} reason=${payload?.reason}`,
    )
    // Clear any reply-overdue tracker pinned to this side-thread chat, 
    // the conversation is closed, no reply path remains, and continuing
    // to track it would fire false-positive overdues 2 min later.
    const convId = payload?.conversation_id
    if (convId != null) {
      const chatId = peerConvChats.get(String(convId))
      if (chatId) {
        clearInbound(chatId)
        peerConvChats.delete(String(convId))
      }
    }
    mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content:
          `[peer_conversation_closed] reason=${payload?.reason ?? 'unknown'}\n` +
          `(conversation_id=${payload?.conversation_id ?? '?'}, ` +
          `closed_by=${payload?.closed_by_id ?? '?'})\n` +
          `Send to this peer again to start a new conversation.`,
        meta: {
          event_type: 'peer_conversation_closed',
          conversation_id: String(payload?.conversation_id ?? ''),
          reason: payload?.reason ?? 'unknown',
          user_id: USER_ID,
          assistant_id: ASSISTANT_ID,
          transport: 'ws',
        },
      },
    }).catch(() => {})
  })

  realtimeSocket.on('peer_turn_yielded', (payload: any) => {
    log(
      `peer_turn_yielded conv=${payload?.conversation_id} → ${payload?.turn_holder_id}`,
    )
  })

  // ── Command Center meetings (V3) ──────────────────────────────────────
  // The user dragged this assistant into an N-party meeting. We forward
  // every meeting_message to Claude as a channel notification, with a
  // meta header telling the model whether this is its turn. Claude calls
  // the `meeting_reply` MCP tool only when your_turn=YES; the backend
  // enforces the turn protocol with HTTP 409 if it tries otherwise.

  realtimeSocket.on('meeting_invitation', (payload: any) => {
    try {
      const meetingId = Number(payload?.meetingId)
      const invitedFor = Number(payload?.invitedAssistantId)
      if (!Number.isFinite(meetingId)) return
      if (invitedFor !== Number(ASSISTANT_ID)) return
      meetingContexts.set(meetingId, {
        chatId: Number(payload?.chatId),
        title: payload?.title ?? null,
        participants: Array.isArray(payload?.participants)
          ? payload.participants
              .map((p: any) => normalizeMeetingParticipant(p))
              .filter((p: MeetingParticipantSummary | null): p is MeetingParticipantSummary => p != null)
          : [],
        speakerPolicy: String(payload?.speakerPolicy ?? 'user_mediated'),
        currentSpeakerId: null,
      })
      if (payload?.chatId != null) {
        // Mark this chat id as meeting-routed so the reply-overdue tracker
        // skips it, meetings use meeting_reply gated by user_mediated turn
        // assignment, so absence of `reply` is expected.
        const chatId = String(payload.chatId)
        meetingChatIds.add(chatId)
        meetingIdByChatId.set(chatId, meetingId)
        noteMonitoredChat(chatId)
      }
      const peerNames = (payload?.participants ?? [])
        .filter((p: any) => Number(p?.assistantId) !== Number(ASSISTANT_ID))
        .map((p: any) => p?.name)
        .filter(Boolean)
        .join(', ')
      log(`meeting_invitation accepted (id=${meetingId}, peers=${peerNames})`)
      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content:
            `[meeting_invitation] You have been added to meeting #${meetingId}` +
            `${payload?.title ? ` "${payload.title}"` : ''}.\n` +
            `Other participants: ${peerNames || '(none yet)'}\n` +
            `Speaker policy: ${payload?.speakerPolicy ?? 'user_mediated'}.\n` +
            `Wait for messages with your_turn=YES before calling the meeting_reply tool.`,
          meta: {
            event_type: 'meeting_invitation',
            meeting_id: String(meetingId),
            chat_id: String(payload?.chatId ?? ''),
            user_id: USER_ID,
            assistant_id: ASSISTANT_ID,
            transport: 'ws',
          },
        },
      }).catch(() => {})
    } catch (err) {
      log(`meeting_invitation handler error: ${err}`)
    }
  })

  realtimeSocket.on('meeting_message', (payload: any) => {
    try {
      const meetingId = Number(payload?.meetingId)
      if (!Number.isFinite(meetingId)) return
      let ctx = meetingContexts.get(meetingId)
      const yourTurnFor: number[] = Array.isArray(payload?.yourTurnFor)
        ? payload.yourTurnFor.map((x: any) => Number(x))
        : []
      const yourTurn = yourTurnFor.includes(Number(ASSISTANT_ID))
      const senderId = payload?.senderAssistantId != null
        ? Number(payload.senderAssistantId)
        : null
      const chatId = String(payload?.chatId ?? ctx?.chatId ?? '')
      if (chatId) {
        meetingChatIds.add(chatId)
        meetingIdByChatId.set(chatId, meetingId)
        noteMonitoredChat(chatId)
        if (!ctx) {
          ctx = {
            chatId: Number(chatId),
            title: null,
            participants: [],
            speakerPolicy: 'parallel',
            currentSpeakerId: null,
          }
          meetingContexts.set(meetingId, ctx)
        }
      }
      const messageId = Number(payload?.messageId)
      if (Number.isFinite(messageId)) {
        if (wsForwardedMessageIds.has(messageId)) return
        rememberForwarded(messageId)
        // Do NOT advance chatLastSeen for meeting WS events. Claude Code's
        // channel renderer can drop meeting notifications even after this
        // handler receives the socket event; if we bump the cursor here, the
        // 2s poll fallback never replays the user turn and the meeting goes
        // silent. Let pollChat confirm delivery for meeting messages.
      }
      if (ctx) {
        const currentRaw = payload?.currentSpeakerId
        ctx.currentSpeakerId =
          currentRaw == null || currentRaw === ''
            ? null
            : Number.isFinite(Number(currentRaw))
              ? Number(currentRaw)
              : null
      }
      // Diagnostic, log every meeting_message receipt so we can confirm
      // (or rule out) WS delivery from the plugin side. Without this, a
      // "stuck meeting" symptom is ambiguous between (a) backend never
      // sent, (b) backend sent but socket didn't deliver, (c) plugin
      // received but Claude didn't act on the notification.
      log(
        `meeting_message rx (meeting=${meetingId} msg=${payload?.messageId ?? '?'} ` +
          `senderId=${senderId} yourTurnFor=[${yourTurnFor.join(',')}] ` +
          `your_turn=${yourTurn ? 'YES' : 'NO'})`,
      )
      // Skip our own outbound replies, we'd already see them via the
      // POST response. Self-loops would confuse the model.
      if (senderId != null && senderId === Number(ASSISTANT_ID)) return
      const senderName = String(payload?.senderName ?? 'Unknown')
      const text = String(payload?.text ?? '')
      const participantList = (ctx?.participants ?? [])
        .filter((p) => Number(p.assistantId) !== Number(ASSISTANT_ID))
        .map((p) => p.name)
        .join(', ')
      // Meta schema MUST mirror the polling-path notification (chat_id,
      // message_id, user, user_id, assistant_id, ts). Without those four
      // canonical fields, Claude Code's notifications/claude/channel
      // renderer silently drops the notification on the agent side, 
      // which is why meeting_message notifications were never reaching
      // the agent's conversation context even though the WS handler was
      // firing and your_turn was being computed correctly. Confirmed via
      // /tmp/bgos-plugin-<id>.log: receipts logged, but agents only saw
      // pollChat-emitted notifications (which have the canonical schema).
      // Meeting-specific fields (event_type, meeting_id, your_turn, etc.)
      // are kept as additions on top.
      const messageIdStr =
        payload?.messageId != null ? String(payload.messageId) : ''
      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content:
            `[Meeting #${meetingId}, your_turn=${yourTurn ? 'YES' : 'NO'}, ` +
            `participants: ${participantList || 'unknown'}]\n` +
            `${senderName}: ${text}`,
          meta: {
            // Canonical channel-envelope fields (rendered as XML attrs).
            chat_id: chatId,
            message_id: messageIdStr,
            user: payload?.senderType === 'agent' ? senderName : 'User',
            user_id: USER_ID,
            assistant_id: ASSISTANT_ID,
            ts: new Date().toISOString(),
            // Meeting-specific extras (additive, Claude Code reads what
            // it knows, ignores the rest).
            event_type: 'meeting_message',
            meeting_id: String(meetingId),
            sender_type: payload?.senderType ?? 'user',
            sender_name: senderName,
            your_turn: yourTurn ? 'YES' : 'NO',
            ...(senderId == null
              ? {}
              : { sender_assistant_id: String(senderId) }),
            ...(payload?.currentSpeakerId == null
              ? {}
              : { current_speaker_id: String(payload.currentSpeakerId) }),
            transport: 'ws',
          },
        },
      }).catch((err) => log(`meeting_message mcp.notification error: ${err}`))
    } catch (err) {
      log(`meeting_message handler error: ${err}`)
    }
  })

  realtimeSocket.on('meeting_turn_changed', (payload: any) => {
    const meetingId = Number(payload?.meetingId)
    if (!Number.isFinite(meetingId)) return
    const me = Number(ASSISTANT_ID)
    const becameMyTurn =
      Number(payload?.currentSpeakerId) === me &&
      Number(payload?.previousSpeakerId) !== me
    const ctx = meetingContexts.get(meetingId)
    if (ctx) {
      const currentRaw = payload?.currentSpeakerId
      ctx.currentSpeakerId =
        currentRaw == null || currentRaw === ''
          ? null
          : Number.isFinite(Number(currentRaw))
            ? Number(currentRaw)
            : null
    }
    if (becameMyTurn) {
      log(`meeting_turn_changed → my turn in meeting #${meetingId}`)
      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content:
            `[Meeting #${meetingId}] It is now your turn. Reply via the ` +
            `meeting_reply tool with meeting_id=${meetingId}, or send "PASS" ` +
            `to yield without contributing.`,
          meta: {
            event_type: 'meeting_turn_changed',
            meeting_id: String(meetingId),
            your_turn: 'YES',
            user_id: USER_ID,
            assistant_id: ASSISTANT_ID,
          },
        },
      }).catch(() => {})
    }
  })

  realtimeSocket.on('meeting_closed', (payload: any) => {
    const meetingId = Number(payload?.meetingId)
    if (!Number.isFinite(meetingId)) return
    forgetMeetingContext(meetingId)
    log(`meeting_closed id=${meetingId} reason=${payload?.reason}`)
    mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content:
          `[Meeting #${meetingId}] Meeting closed (reason: ${payload?.reason ?? 'unknown'}).` +
          ` Stop sending meeting_reply for this meeting.`,
        meta: {
          event_type: 'meeting_closed',
          meeting_id: String(meetingId),
          reason: payload?.reason ?? 'unknown',
          user_id: USER_ID,
          assistant_id: ASSISTANT_ID,
        },
      },
    }).catch(() => {})
  })

  realtimeSocket.on('meeting_participant_left', (payload: any) => {
    const meetingId = Number(payload?.meetingId)
    if (!Number.isFinite(meetingId)) return
    const leaverId = Number(payload?.assistantId)
    // If WE were the one removed, drop our local context entry. Otherwise,
    // refresh the participant list cached against this meeting so future
    // notifications carry the correct names.
    if (leaverId === Number(ASSISTANT_ID)) {
      forgetMeetingContext(meetingId)
      return
    }
    const ctx = meetingContexts.get(meetingId)
    if (ctx) {
      ctx.participants = ctx.participants.filter(
        (p) => Number(p.assistantId) !== leaverId,
      )
    }
  })

  realtimeSocket.on('meeting_participant_added', (payload: any) => {
    const meetingId = Number(payload?.meetingId)
    if (!Number.isFinite(meetingId)) return
    const ctx = meetingContexts.get(meetingId)
    if (!ctx) return
    const added = normalizeMeetingParticipant({
      assistantId: payload?.assistantId,
      name: payload?.name,
      avatarUrl: payload?.avatarUrl,
    })
    if (!added) return
    if (!ctx.participants.some((p) => p.assistantId === added.assistantId)) {
      ctx.participants.push(added)
    }
  })

  realtimeSocket.on('meeting_policy_changed', (payload: any) => {
    const meetingId = Number(payload?.meetingId)
    if (!Number.isFinite(meetingId)) return
    const ctx = meetingContexts.get(meetingId)
    if (!ctx) return
    ctx.speakerPolicy = String(payload?.speakerPolicy ?? ctx.speakerPolicy)
    const currentRaw = payload?.currentSpeakerId
    ctx.currentSpeakerId =
      currentRaw == null || currentRaw === ''
        ? null
        : Number.isFinite(Number(currentRaw))
          ? Number(currentRaw)
          : null
  })
}

// ── Slash-command discovery + sync ───────────────────────────────────────────
//
// Claude Code's slash command catalog (built-in + user + project + plugin) is
// pushed to the BGOS backend so the frontend's slash picker can autocomplete
// when the user types `/`. The backend endpoint is documented in
// hermes-channel-bgos/docs/bgos-agent-capabilities.md §7.

interface SlashCommandEntry {
  command: string
  description: string
  scope: 'all'
}

// Built-in Claude Code commands. Curated against the CLI as of 2026-05.
// Missing entries are not catastrophic, users can still type them
// manually. Add new ones here when CC ships them.
const BUILTIN_COMMANDS: SlashCommandEntry[] = [
  { command: '/help',          description: 'Show usage and supported tools',          scope: 'all' },
  { command: '/clear',         description: 'Reset the conversation context',          scope: 'all' },
  { command: '/compact',       description: 'Compact prior turns to free context',     scope: 'all' },
  { command: '/cost',          description: 'Show token usage and cost for this session', scope: 'all' },
  { command: '/model',         description: 'Switch the active Claude model',          scope: 'all' },
  { command: '/agents',        description: 'List and configure subagents',            scope: 'all' },
  { command: '/permissions',   description: 'Review and manage tool permissions',      scope: 'all' },
  { command: '/hooks',         description: 'Manage shell hooks for events',           scope: 'all' },
  { command: '/mcp',           description: 'Manage MCP server connections',           scope: 'all' },
  { command: '/memory',        description: 'View or edit project memory',             scope: 'all' },
  { command: '/init',          description: 'Initialize CLAUDE.md for this project',   scope: 'all' },
  { command: '/doctor',        description: 'Diagnose configuration issues',           scope: 'all' },
  { command: '/status',        description: 'Show session status',                     scope: 'all' },
  { command: '/release-notes', description: 'Show release notes for Claude Code',      scope: 'all' },
  { command: '/bug',           description: 'Open a bug report',                       scope: 'all' },
  { command: '/login',         description: 'Sign in to Claude',                       scope: 'all' },
  { command: '/logout',        description: 'Sign out',                                scope: 'all' },
]

async function readMdCommand(
  filePath: string,
  namePrefix = '',
): Promise<SlashCommandEntry | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const base = basename(filePath, '.md')
    // Filter dotfiles AND leading-underscore files. The `_conventions.md` /
    // `_internal.md` convention is used by Claude Code itself (e.g. the
    // vercel plugin) for shared docs that should not appear in the picker.
    if (!base || base.startsWith('.') || base.startsWith('_')) return null
    const command = `/${namePrefix}${base}`
    let description = ''
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/)
    if (fmMatch) {
      const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m)
      if (descMatch) description = descMatch[1].trim()
    }
    if (!description) {
      const body = fmMatch ? raw.slice(fmMatch[0].length) : raw
      const first = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
      description = (first ?? '').slice(0, 200)
    }
    return { command, description: description || command, scope: 'all' }
  } catch {
    return null
  }
}

async function walkCommandsDir(
  dir: string,
  namePrefix = '',
): Promise<SlashCommandEntry[]> {
  try {
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(dir, { withFileTypes: true })
    const out: SlashCommandEntry[] = []
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue
      const cmd = await readMdCommand(pathJoin(dir, e.name), namePrefix)
      if (cmd) out.push(cmd)
    }
    return out
  } catch {
    return []
  }
}

// Plugin commands live in two parallel layouts:
//   marketplaces/<marketplace>/plugins/<plugin>/commands/*.md  (3 levels under rootDir)
//   cache/<marketplace>/<plugin>/<version>/commands/*.md       (4 levels under rootDir)
// Names get namespaced as `/<plugin>:<command>`. When multiple versions of
// a cached plugin exist (e.g. `vercel/0.42.1/` and `vercel/61f1903bed7b/`),
// the LAST `readdir` entry wins via the dedupe map, readdir order is OS-
// dependent but for our purposes "last write wins" is acceptable since all
// versions describe the same command set.
async function walkPluginCommands(
  rootDir: string,
  layout: 'marketplaces' | 'cache',
): Promise<SlashCommandEntry[]> {
  const out: SlashCommandEntry[] = []
  try {
    const { readdir } = await import('node:fs/promises')
    const level1 = await readdir(rootDir, { withFileTypes: true })
    for (const a of level1) {
      if (!a.isDirectory()) continue
      if (layout === 'marketplaces') {
        // <root>/<marketplace>/plugins/<plugin>/commands
        const pluginsDir = pathJoin(rootDir, a.name, 'plugins')
        try {
          const level2 = await readdir(pluginsDir, { withFileTypes: true })
          for (const b of level2) {
            if (!b.isDirectory()) continue
            const cmdDir = pathJoin(pluginsDir, b.name, 'commands')
            const cmds = await walkCommandsDir(cmdDir, `${b.name}:`)
            out.push(...cmds)
          }
        } catch {}
      } else {
        // <root>/<marketplace>/<plugin>/<version>/commands
        const marketplaceDir = pathJoin(rootDir, a.name)
        try {
          const level2 = await readdir(marketplaceDir, { withFileTypes: true })
          for (const b of level2) {
            if (!b.isDirectory()) continue
            const pluginDir = pathJoin(marketplaceDir, b.name)
            try {
              const level3 = await readdir(pluginDir, { withFileTypes: true })
              for (const c of level3) {
                if (!c.isDirectory()) continue
                const cmdDir = pathJoin(pluginDir, c.name, 'commands')
                const cmds = await walkCommandsDir(cmdDir, `${b.name}:`)
                out.push(...cmds)
              }
            } catch {}
          }
        } catch {}
      }
    }
  } catch {}
  return out
}

async function discoverSlashCommands(): Promise<SlashCommandEntry[]> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const cwd = process.cwd()

  const [project, user, marketplace, cache] = await Promise.all([
    walkCommandsDir(pathJoin(cwd, '.claude', 'commands')),
    walkCommandsDir(pathJoin(home, '.claude', 'commands')),
    walkPluginCommands(pathJoin(home, '.claude', 'plugins', 'marketplaces'), 'marketplaces'),
    walkPluginCommands(pathJoin(home, '.claude', 'plugins', 'cache'), 'cache'),
  ])

  // Priority (lower → higher): built-in < marketplace < cache < user < project.
  const byName = new Map<string, SlashCommandEntry>()
  for (const c of BUILTIN_COMMANDS) byName.set(c.command, c)
  for (const c of marketplace) byName.set(c.command, c)
  for (const c of cache) byName.set(c.command, c)
  for (const c of user) byName.set(c.command, c)
  for (const c of project) byName.set(c.command, c)

  // Built-ins first (in their curated order), then plugin/user/project alphabetical.
  const builtinSet = new Set(BUILTIN_COMMANDS.map((c) => c.command))
  const builtins = BUILTIN_COMMANDS.filter((c) => byName.has(c.command))
  const rest = [...byName.values()]
    .filter((c) => !builtinSet.has(c.command))
    .sort((a, b) => a.command.localeCompare(b.command))
  return [...builtins, ...rest]
}

// Normalize a discovered command name to the backend's wire format. The
// CommandDto regex is /^[a-z0-9_]{1,32}$/, no leading slash, no `:`,
// no `-`, no uppercase. The frontend re-derives the user-facing label
// from this stored name (prepending `/`), so the round-trip is
// `/help` → store `help` → display `/help`. Plugin-namespaced commands
// like `/feature-dev:feature-dev` get sanitized to `feature_dev_feature_dev`
// for storage; until the backend regex permits `:` and `-` the
// frontend will show that sanitized form. Tracked separately.
function normalizeCommandName(raw: string): string | null {
  // Strip leading slash if present.
  let s = raw.startsWith('/') ? raw.slice(1) : raw
  s = s.toLowerCase()
  // Replace any non-conforming character with `_`. Coalesce runs to a
  // single `_` so `feature-dev:feature-dev` → `feature_dev_feature_dev`,
  // not `feature_dev__feature_dev`.
  s = s.replace(/[^a-z0-9_]+/g, '_')
  // Trim leading/trailing underscores.
  s = s.replace(/^_+|_+$/g, '')
  if (!s) return null
  return s.slice(0, 32)
}

let lastSyncedCommandsHash = ''
async function syncSlashCommands(): Promise<void> {
  try {
    const commands = await discoverSlashCommands()
    // Sanitize for the backend DTO: command name regex + description
    // length cap + array size cap. Drop entries that can't be coerced.
    const seen = new Set<string>()
    const sanitized: SlashCommandEntry[] = []
    let dropped = 0
    for (const c of commands) {
      const name = normalizeCommandName(c.command)
      if (!name) {
        dropped++
        continue
      }
      if (seen.has(name)) {
        dropped++
        continue
      }
      seen.add(name)
      const description = (c.description || name).slice(0, 100)
      sanitized.push({ command: name, description, scope: 'all' })
      if (sanitized.length >= 50) break // backend ArrayMaxSize(50)
    }

    const hash = sanitized.map((c) => `${c.command}|${c.description}`).join('\n')
    if (hash === lastSyncedCommandsHash) {
      log(`slash-command sync: unchanged (${sanitized.length} entries)`)
      return
    }
    // NOTE: use the user-scoped PUT (Clerk-or-API-key auth with userId
    // ownership check), NOT `integrations/assistants/.../commands` which
    // requires a pairing token. The Claude Code plugin authenticates with
    // X-API-Key, not a pairing token, and a user-created assistant has
    // pairingId=null, so the pairing-scoped path would 401 regardless.
    // Both endpoints write the same assistant_commands table via the
    // same SyncCommandsDto.
    await bgosPut(`assistants/${ASSISTANT_ID}/commands`, {
      commands: sanitized,
    })
    lastSyncedCommandsHash = hash
    log(
      `slash-command sync: pushed ${sanitized.length} commands` +
        (dropped > 0 ? ` (${dropped} dropped, invalid name or dupe)` : ''),
    )
  } catch (err) {
    log(`slash-command sync failed: ${err}`)
  }
}

// ── Always-on reconcile ───────────────────────────────────────────────────────
// If the user flips the "Always-on" toggle in the BGOS app, install the
// bgos-agent supervisor on THIS host so the session survives restart/reboot; if
// they flip it off, remove it. Deterministic + self-healing (re-checked on a
// timer), no LLM involvement. Only for claude-code agents (Hermes/OpenClaw/
// Gobot run under their own supervision). The CLI's singleton guard ensures
// installing while this very session is live doesn't double-connect, the
// supervisor waits behind this session and takes over only when it ends.
const execFileAsync = promisify(execFile)
const BGOS_AGENT_BIN = fileURLToPath(new URL('bin/bgos-agent', import.meta.url))
let reconcileBusy = false

async function isAlwaysOnInstalled(): Promise<boolean> {
  try {
    await execFileAsync(BGOS_AGENT_BIN, ['is-installed', '--assistant', ASSISTANT_ID])
    return true
  } catch {
    return false
  }
}

async function reconcileAlwaysOn(): Promise<void> {
  if (reconcileBusy) return
  reconcileBusy = true
  try {
    const a = (await bgosGet(`assistants/${ASSISTANT_ID}`)) as {
      code?: string | null
      alwaysOn?: boolean
    }
    // Only manage claude-code agents; others self-manage their own process.
    if (a?.code !== 'claude-code') return
    // Act only when the backend explicitly reports the flag. If alwaysOn is
    // absent (older/transitional backend, pre-deploy), do nothing, never tear
    // down a wanted supervisor just because the field is missing.
    if (typeof a?.alwaysOn !== 'boolean') return
    const desired = a.alwaysOn === true
    const installed = await isAlwaysOnInstalled()
    if (desired && !installed) {
      log('always-on: enabled in BGOS, installing supervisor on this host')
      await execFileAsync(
        BGOS_AGENT_BIN,
        ['install', '--assistant', ASSISTANT_ID, '--dir', process.cwd(), '--always-on', '--no-clone'],
        { timeout: 120_000 },
      )
      log('always-on: supervisor installed (takes over when this session ends)')
    } else if (!desired && installed) {
      log('always-on: disabled in BGOS, removing supervisor')
      await execFileAsync(BGOS_AGENT_BIN, ['uninstall', '--assistant', ASSISTANT_ID], {
        timeout: 60_000,
      })
      log('always-on: supervisor removed')
    }
  } catch (err) {
    log(`always-on reconcile error: ${err}`)
  } finally {
    reconcileBusy = false
  }
}

// ── Startup ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log('Starting BGOS channel plugin...')
  log(`Backend: ${API_BASE}`)
  log(`User: ${USER_ID}, Assistant: ${ASSISTANT_ID}`)
  log(`Auto-approve: ${AUTO_APPROVE}`)
  log(`Log file: ${LOG_FILE}`)

  // Step 1: Connect MCP transport FIRST
  const transport = new StdioServerTransport()
  await mcp.connect(transport)
  log('MCP server connected over stdio')

  // Step 2: Discover and baseline chats
  await discoverChats()
  log(`Monitoring ${monitoredChatIds.length} chat(s)`)
  await pollAllChats()

  // Step 3: Open the WS subscription. Failure here is non-fatal, polling
  // keeps the plugin functional even if the WS path is unavailable.
  try {
    connectWebsocket()
  } catch (err) {
    log(`WS connect failed: ${err}; falling back to polling only`)
  }

  // Step 4: Start adaptive polling loop. When WS is healthy we throttle to
  // 30× the configured interval (default 2s → 60s heartbeat). When the WS
  // is down we revert to the configured cadence so the plugin still
  // delivers messages without a working WS.
  const HEALTHY_MULTIPLIER = 30
  log(
    `Adaptive polling, base=${POLL_INTERVAL_MS}ms, ` +
      `WS-healthy=${POLL_INTERVAL_MS * HEALTHY_MULTIPLIER}ms`,
  )
  const tick = async (): Promise<void> => {
    try {
      await discoverChats()
      await pollAllChats()
    } catch (err) {
      log(`Poll cycle error: ${err}`)
    }
    // Force fast cadence whenever:
    //  - WS is unhealthy (poll IS the delivery path)
    //  - There are active meetings (turn changes feel snappy)
    //  - There's a pending permission awaiting a user click (so the inline
    //    Allow/Deny button click gets picked up within ~2s instead of ~60s)
    const interval =
      isWsHealthy() && meetingChatIds.size === 0 && pendingPermissions.size === 0
        ? POLL_INTERVAL_MS * HEALTHY_MULTIPLIER
        : POLL_INTERVAL_MS
    setTimeout(tick, interval)
  }
  setTimeout(tick, POLL_INTERVAL_MS)

  // Step 5: Reply-overdue enforcement loop. Scans pendingInbounds every 30s
  // and fires a one-shot reminder for any inbound older than REPLY_OVERDUE_MS
  // (default 2 minutes). Deterministic backstop for the reply-tool-not-called
  // failure mode.
  setInterval(checkReplyOverdue, 30_000)
  log(`Reply-overdue enforcement enabled (threshold ${REPLY_OVERDUE_MS / 1000}s)`)

  // Step 6: Push the Claude Code slash-command catalog to BGOS so the
  // frontend slash picker can autocomplete. Sync once on boot, then refresh
  // every 5 minutes to catch newly-installed plugins / added .md files.
  void syncSlashCommands()
  setInterval(() => void syncSlashCommands(), 5 * 60_000).unref()

  // Step 7: Reconcile the "always-on" toggle (BGOS app → this host). Installs or
  // removes the bgos-agent supervisor to match the assistant's alwaysOn flag.
  // Checked on boot + every 2 min, snappy enough that flipping the toggle feels
  // near-immediate, cheap enough to ignore.
  void reconcileAlwaysOn()
  setInterval(() => void reconcileAlwaysOn(), 2 * 60_000).unref()
}

main().catch((err) => {
  log(`Fatal error: ${err}`)
  process.exit(1)
})
