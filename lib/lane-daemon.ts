/**
 * PERSON LANES, the lane daemon's core (shared agents Phase 3, P3; design
 * 4.2 steps 4 and 5, 5.2 "The second lock", 7.2 item 7).
 *
 * The lane daemon is the BGOS server of ONE person's lane: Claude Code starts
 * it from the lane's mcp.json, under the name `bgos`, as lane-server.ts. It is
 * deliberately NOT a mode of server.ts:
 *
 *   - it never reads the agent's credentials file and never holds the pairing
 *     token: its only credential is the lane session it mints with the single
 *     use ticket the owner's daemon left in the lane's state folder;
 *   - it never takes the agent's pairing lock, so a recipient's process can
 *     never become the agent's active daemon (design 4.2 step 4);
 *   - it serves one tool, `reply`, and confines every local path that tool is
 *     handed to the lane's working folder (realpath, so no symlink escapes);
 *   - it delivers a turn ONLY when the backend stamped it for this lane
 *     (`lane: person:<id>`), and acknowledges nothing it refused, so the row
 *     stays for the lane it belongs to (the second lock);
 *   - it declares no permission relay: under `--permission-mode dontAsk`
 *     nothing reaches one, and a lane never approves anything by itself.
 *
 * This file holds the parts that are pure or take their effects as
 * parameters, so they are tested without a backend; lane-server.ts wires them
 * to MCP, socket.io and fetch.
 *
 * No em or en dashes in this file.
 */
import {
  confineLanePath,
  isSafeAssistantId,
  isSafeLaneUserId,
  lanePaths,
  personLaneStamp,
  personLaneVerdict,
} from './lane-core.mjs'
import { buildInboundChannel } from './inbound-channel.js'

/** What a lane daemon knows about itself, from its environment. */
export interface LaneDaemonConfig {
  userId: string
  assistantId: string
  workDir: string
  laneDir: string
  stateDir: string
  backendUrl: string
  apiBase: string
  loginMode: string
  notice: string | null
}

/**
 * Read and CHECK the lane's configuration. Every folder must be the one
 * lanePaths derives for this (agent, person) under this home, so a forged or
 * mistaken environment cannot point the daemon at another lane's folder.
 */
export function readLaneDaemonConfig(
  env: Record<string, string | undefined>,
  home: string,
  platform: string = process.platform,
): { ok: true; config: LaneDaemonConfig } | { ok: false; reason: string } {
  const userId = env.BGOS_LANE_USER_ID ?? ''
  const assistantId = env.BGOS_ASSISTANT_ID ?? ''
  if (!isSafeLaneUserId(userId)) return { ok: false, reason: 'BGOS_LANE_USER_ID is missing or unsafe' }
  if (!isSafeAssistantId(assistantId)) return { ok: false, reason: 'BGOS_ASSISTANT_ID is missing or unsafe' }
  const expected = lanePaths({ home, assistantId, userId, stateRoot: env.BGOS_PLUGIN_STATE_DIR, platform })
  if (env.BGOS_LAUNCH_CWD !== expected.workDir) return { ok: false, reason: 'BGOS_LAUNCH_CWD is not this lane\'s working folder' }
  if (env.BGOS_LANE_DIR !== expected.laneDir) return { ok: false, reason: 'BGOS_LANE_DIR is not this lane\'s folder' }
  if (env.BGOS_LANE_STATE_DIR !== expected.stateDir) return { ok: false, reason: 'BGOS_LANE_STATE_DIR is not this lane\'s state folder' }
  const backendUrl = String(env.BGOS_BACKEND_URL ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s/]+/.test(backendUrl)) return { ok: false, reason: 'BGOS_BACKEND_URL is missing' }
  const apiBase = /\/api\/v1$/.test(backendUrl) ? backendUrl : `${backendUrl}/api/v1`
  return {
    ok: true,
    config: {
      userId,
      assistantId,
      workDir: expected.workDir,
      laneDir: expected.laneDir,
      stateDir: expected.stateDir,
      backendUrl: apiBase.replace(/\/api\/v1$/, ''),
      apiBase,
      loginMode: String(env.HOAI_LANE_LOGIN_MODE ?? ''),
      notice: env.HOAI_LANE_NOTICE && env.HOAI_LANE_NOTICE.trim() !== '' ? env.HOAI_LANE_NOTICE.trim() : null,
    },
  }
}

/**
 * Names a lane daemon drops from its OWN environment at boot. Under option
 * (b) Claude Code hands its children the lane's token; the daemon needs no
 * Claude login at all, so nothing it starts can inherit one.
 */
export const LANE_DAEMON_SCRUB = Object.freeze([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'BGOS_PAIRING_TOKEN',
  'BGOS_API_KEY',
  'BGOS_CREDENTIALS_PATH',
])

export function scrubLaneDaemonEnv(env: Record<string, string | undefined>): void {
  for (const name of LANE_DAEMON_SCRUB) delete env[name]
}

// ── The lane session ────────────────────────────────────────────────────────

export interface StoredLaneSession {
  sessionToken: string
  expiresAt: string
  actorUserId: string
  assistantId: string
  pairingId: string
}

/** A lane session token as the backend mints it. */
export const LANE_SESSION_RE = /^lsess_[A-Za-z0-9_-]{8,512}$/

/** Is a stored session still usable for this lane (a minute of margin)? */
export function storedSessionUsable(
  stored: unknown,
  lane: { userId: string; assistantId: string },
  nowMs: number,
): stored is StoredLaneSession {
  if (!stored || typeof stored !== 'object') return false
  const s = stored as Record<string, unknown>
  if (typeof s.sessionToken !== 'string' || !LANE_SESSION_RE.test(s.sessionToken)) return false
  if (s.actorUserId !== lane.userId || String(s.assistantId) !== String(lane.assistantId)) return false
  const exp = typeof s.expiresAt === 'string' ? Date.parse(s.expiresAt) : NaN
  return Number.isFinite(exp) && exp - nowMs > 60_000
}

/**
 * Read the backend's mint answer. It must name THIS lane: a session for any
 * other person or agent is refused, never used.
 */
export function readMintAnswer(
  body: unknown,
  lane: { userId: string; assistantId: string },
): StoredLaneSession | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, any>
  if (typeof b.sessionToken !== 'string' || !LANE_SESSION_RE.test(b.sessionToken)) return null
  if (typeof b.expiresAt !== 'string' || !Number.isFinite(Date.parse(b.expiresAt))) return null
  const l = b.lane ?? {}
  if (l.actorUserId !== lane.userId || String(l.assistantId) !== String(lane.assistantId)) return null
  if (l.stamp !== undefined && l.stamp !== personLaneStamp(lane.userId)) return null
  return {
    sessionToken: b.sessionToken,
    expiresAt: b.expiresAt,
    actorUserId: lane.userId,
    assistantId: String(lane.assistantId),
    pairingId: String(l.pairingId ?? ''),
  }
}

/** Does `GET lanes/me` say this is exactly our lane? */
export function laneMeMatches(body: unknown, lane: { userId: string; assistantId: string }): boolean {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  return (
    b.actorUserId === lane.userId &&
    String(b.assistantId) === String(lane.assistantId) &&
    b.lane === personLaneStamp(lane.userId)
  )
}

/** A ticket as the owner's daemon leaves it: single use, two minutes. */
export function readTicketFile(text: string, nowMs: number): string | null {
  try {
    const raw = JSON.parse(text)
    const ticket = raw?.laneTicket
    if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 200) return null
    const exp = typeof raw.ticketExpiresAt === 'string' ? Date.parse(raw.ticketExpiresAt) : NaN
    if (Number.isFinite(exp) && exp <= nowMs) return null
    return ticket
  } catch {
    return null
  }
}

// ── A delivery ──────────────────────────────────────────────────────────────

/** One delivery as the socket frame or the poll row carries it, normalised. */
export interface LaneDelivery {
  messageId: number
  chatId: string
  text: string
  files: unknown[]
  chatKind: string | null
  createdAt: string | null
  raw: Record<string, unknown>
}

export function normaliseLaneDelivery(raw: unknown): LaneDelivery | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, any>
  const messageId = Number(r.messageId ?? r.message_id ?? r.id)
  const chatId = String(r.chatId ?? r.chat_id ?? '')
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return null
  if (!/^[1-9][0-9]*$/.test(chatId)) return null
  return {
    messageId,
    chatId,
    text: typeof r.text === 'string' ? r.text : '',
    files: Array.isArray(r.files) ? r.files : [],
    chatKind: typeof r.chat_kind === 'string' ? r.chat_kind : typeof r.chatKind === 'string' ? r.chatKind : null,
    createdAt: typeof r.created_at === 'string' ? r.created_at : typeof r.createdAt === 'string' ? r.createdAt : null,
    raw: r,
  }
}

/**
 * THE SECOND LOCK, applied to one delivery. Refused deliveries are logged as
 * `lane_misroute` by the caller and never acknowledged.
 */
export function laneDeliveryGate(
  raw: unknown,
  lane: { userId: string; assistantId: string },
): { deliver: true; delivery: LaneDelivery } | { deliver: false; reason: string } {
  const verdict = personLaneVerdict(raw, lane)
  if (!verdict.deliver) return { deliver: false, reason: `lane_misroute ${verdict.reason} stamp=${verdict.stamp ?? 'none'}` }
  const delivery = normaliseLaneDelivery(raw)
  if (!delivery) return { deliver: false, reason: 'unreadable' }
  return { deliver: true, delivery }
}

/**
 * The channel event for one delivery: the same builder every owner lane uses
 * (lib/inbound-channel.ts), plus the lane's own stamp. EVERY meta value is a
 * string (the wake card contract: Claude Code silently drops a card with any
 * other value), and optional keys are omitted, never null.
 */
export function buildLaneChannelEvent(
  delivery: LaneDelivery,
  lane: { userId: string; assistantId: string },
  transport: 'lane-socket' | 'lane-poll',
  opts: { backlog?: boolean } = {},
): { content: string; meta: Record<string, string> } {
  const r = delivery.raw
  const built = buildInboundChannel({
    chatId: delivery.chatId,
    messageId: delivery.messageId,
    userId: String(r.sender_user_id ?? r.userId ?? r.user_id ?? lane.userId),
    assistantId: lane.assistantId,
    timestamp: delivery.createdAt,
    transport,
    text: delivery.text,
    files: delivery.files as never,
    senderType: typeof r.senderType === 'string' ? r.senderType : null,
    backlog: opts.backlog === true,
    serverSender: r,
  })
  const meta: Record<string, string> = {}
  for (const [key, value] of Object.entries(built.meta)) {
    if (value === undefined || value === null) continue
    meta[key] = String(value)
  }
  meta.lane = personLaneStamp(lane.userId)
  return { content: built.content, meta }
}

/**
 * What a lane boot re-offers. With a cursor (a relaunch after a crash or an
 * idle stop), every row after it from the last 24 hours, at most ten. With
 * none (the lane's very first start), only the last 15 minutes, at most five:
 * the turn that woke it, never a person's older history that the agent's
 * single mind may already have answered before lanes. Oldest first.
 */
export function selectLaneBacklog(
  deliveries: LaneDelivery[],
  { cursor, nowMs, windowMs = 24 * 60 * 60_000, firstWindowMs = 15 * 60_000, max = 10, firstMax = 5 }:
    { cursor: number; nowMs: number; windowMs?: number; firstWindowMs?: number; max?: number; firstMax?: number },
): LaneDelivery[] {
  const first = cursor <= 0
  const window = first ? firstWindowMs : windowMs
  const fresh = deliveries
    .filter((d) => d.messageId > cursor)
    .filter((d) => {
      const at = d.createdAt ? Date.parse(d.createdAt) : NaN
      // A row with no readable time is kept only after a known cursor.
      return Number.isFinite(at) ? nowMs - at <= window : !first
    })
    .sort((a, b) => a.messageId - b.messageId)
  const limit = first ? firstMax : max
  return fresh.slice(Math.max(0, fresh.length - limit))
}

// ── The inbox: what was delivered, what still waits for an answer ───────────

/**
 * The lane's inbox state, persisted in its own state folder
 * (`~/.bgos-plugin-state/<id>/lanes/<userId>/cursor.json`, design 4.2 "Crash
 * mid turn"). `cursor` only moves on the poll (rows come back in order there;
 * a socket frame can arrive ahead of an earlier row), `delivered` remembers
 * what Claude was handed so a relaunch never hands it twice, and `pending` is
 * what was handed and not yet answered, which a relaunch re-offers.
 */
export interface LaneInboxState {
  cursor: number
  delivered: number[]
  pending: Array<{ id: number; chatId: string }>
}

export const LANE_INBOX_DELIVERED_MAX = 500

export function readLaneInbox(raw: unknown): LaneInboxState {
  const r = (raw ?? {}) as Record<string, unknown>
  const cursor = Number(r.cursor)
  const delivered = Array.isArray(r.delivered)
    ? r.delivered.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0).slice(-LANE_INBOX_DELIVERED_MAX)
    : []
  const pending = Array.isArray(r.pending)
    ? r.pending
      .map((p) => ({ id: Number((p as Record<string, unknown>)?.id), chatId: String((p as Record<string, unknown>)?.chatId ?? '') }))
      .filter((p) => Number.isSafeInteger(p.id) && p.id > 0 && /^[1-9][0-9]*$/.test(p.chatId))
      .slice(-20)
    : []
  return { cursor: Number.isSafeInteger(cursor) && cursor > 0 ? cursor : 0, delivered, pending }
}

/** The id the poll should ask from: never past a turn still waiting for its answer. */
export function inboxPollFrom(state: LaneInboxState): number {
  const lowestPending = state.pending.reduce((min, p) => Math.min(min, p.id), Number.POSITIVE_INFINITY)
  return Number.isFinite(lowestPending) ? Math.min(state.cursor, lowestPending - 1) : state.cursor
}

/**
 * Hand this row to Claude? A row never delivered, yes. A row delivered and
 * still unanswered, only as a RE-OFFER on the first poll after a (re)launch.
 */
export function inboxShouldDeliver(state: LaneInboxState, id: number, opts: { reoffer: boolean }): boolean {
  if (!state.delivered.includes(id)) return true
  return opts.reoffer && state.pending.some((p) => p.id === id)
}

export function inboxNoteDelivered(state: LaneInboxState, d: { messageId: number; chatId: string }): LaneInboxState {
  const delivered = state.delivered.includes(d.messageId)
    ? state.delivered
    : [...state.delivered, d.messageId].slice(-LANE_INBOX_DELIVERED_MAX)
  const pending = state.pending.some((p) => p.id === d.messageId)
    ? state.pending
    : [...state.pending, { id: d.messageId, chatId: d.chatId }].slice(-20)
  return { ...state, delivered, pending }
}

/** A reply in a chat answers every turn waiting there. */
export function inboxNoteReplied(state: LaneInboxState, chatId: string): LaneInboxState {
  return { ...state, pending: state.pending.filter((p) => p.chatId !== chatId) }
}

export function inboxAdvanceCursor(state: LaneInboxState, id: number): LaneInboxState {
  return id > state.cursor ? { ...state, cursor: id } : state
}

// ── A refused sign in (K2 option b) ─────────────────────────────────────────

/**
 * The CLI's own words, in its debug log, for a token it was handed in
 * CLAUDE_CODE_OAUTH_TOKEN and the server refused (measured on 2.1.302 with a
 * stand-in token). They also say the CLI keeps that token rather than
 * adopting a stored credential: it never falls back on its own either.
 */
export const LANE_TOKEN_REFUSED_RE = /OAuth 401: keeping the user-supplied CLAUDE_CODE_OAUTH_TOKEN/

export function debugLogSaysTokenRefused(text: string): boolean {
  return LANE_TOKEN_REFUSED_RE.test(String(text ?? ''))
}

// ── The reply tool ──────────────────────────────────────────────────────────

/** The largest file a lane reply inlines (the owner's inline threshold). */
export const LANE_INLINE_FILE_MAX_BYTES = 5 * 1024 * 1024

export const LANE_REPLY_TOOL = Object.freeze({
  name: 'reply',
  description:
    'Reply in the chat of the person you are talking to. chat_id is the chat_id of the message you are answering. ' +
    'Files must be inside your working folder; nothing outside it can be attached.',
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: { type: 'string', description: 'The chat_id of the message you are answering.' },
      text: { type: 'string', description: 'Your reply.' },
      files: {
        type: 'array',
        description: 'Files to attach, each a path inside your working folder.',
        items: {
          type: 'object',
          properties: { path: { type: 'string', description: 'A path inside your working folder.' } },
          required: ['path'],
        },
      },
    },
    required: ['chat_id', 'text'],
  },
})

/** Every tool the lane serves (the allow list names each). */
export const LANE_TOOLS = Object.freeze([LANE_REPLY_TOOL])

/**
 * Check a reply before anything is read or sent: the chat must be one this
 * lane was handed a turn in, and every file must land inside the working
 * folder after realpath. Returns the confined paths.
 */
export function checkLaneReply(
  args: unknown,
  deps: { workDir: string; realpath: (p: string) => string; deliveredChats: ReadonlySet<string>; platform?: string },
): { ok: true; chatId: string; text: string; paths: string[] } | { ok: false, message: string } {
  const a = (args ?? {}) as Record<string, unknown>
  const chatId = String(a.chat_id ?? '')
  if (!/^[1-9][0-9]*$/.test(chatId)) return { ok: false, message: 'chat_id must be the chat_id of the message you are answering.' }
  if (!deps.deliveredChats.has(chatId)) {
    return { ok: false, message: 'You can only reply in the chat of the person you are talking to.' }
  }
  const text = typeof a.text === 'string' ? a.text : ''
  const files = Array.isArray(a.files) ? a.files : []
  if (text.trim() === '' && files.length === 0) return { ok: false, message: 'A reply needs text or a file.' }
  const paths: string[] = []
  for (const f of files) {
    const path = (f as Record<string, unknown>)?.path
    if ((f as Record<string, unknown>)?.url !== undefined) return { ok: false, message: 'Only files inside your working folder can be attached.' }
    const confined = confineLanePath(String(path ?? ''), { workDir: deps.workDir, realpath: deps.realpath, platform: deps.platform })
    if (!confined.ok) return { ok: false, message: 'Only files inside your working folder can be attached.' }
    paths.push(confined.path)
  }
  return { ok: true, chatId, text, paths }
}

/** The short instructions a lane's model reads (well under the CLI's 4,096 character cut). */
export function laneInstructions(agentName: string): string {
  const name = agentName.trim() || 'this agent'
  return [
    `You are ${name}, talking with ONE person in their own private chat. Their messages arrive as <channel source="bgos"> events with chat_id and message_id.`,
    'Answer with the `reply` tool, using the chat_id of the message you are answering. Text you write outside the tool is not seen by anyone.',
    'You run on the agent owner\'s computer in a locked lane: you can read and write files only in your working folder, you cannot run commands or fetch web pages, and you cannot reach the owner\'s files, accounts or other people\'s conversations.',
    'If you are asked for something you cannot do here, say so in one plain sentence.',
  ].join('\n')
}
