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
  LANE_NOTICES,
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

// The pure session checks live in lib/lane-session.mjs, shared with the
// supervisor, which mints the session first since P7 (it reads the policy
// before the lane's Claude starts).
export { LANE_SESSION_RE, laneMeMatches, readMintAnswer, readTicketFile, storedSessionUsable } from './lane-session.mjs'

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
 * The channel event for a lane command the model answers (a lane catalog
 * directive, or the question form of `/model` and `/effort`): the delivery's
 * own lane event with the command's content and its slash fields. EVERY meta
 * value is a string (the wake card contract), the sender fields stay the
 * server's, and the lane stamp is kept.
 */
export function buildLaneCommandEvent(
  delivery: LaneDelivery,
  lane: { userId: string; assistantId: string },
  transport: 'lane-socket' | 'lane-poll',
  command: { content: string; meta: Record<string, string> },
  opts: { backlog?: boolean } = {},
): { content: string; meta: Record<string, string> } {
  const base = buildLaneChannelEvent(delivery, lane, transport, opts)
  const meta: Record<string, string> = { ...base.meta }
  for (const [key, value] of Object.entries(command.meta)) {
    if (value === undefined || value === null) continue
    if (key in base.meta && key !== 'event_type') continue
    meta[key] = String(value)
  }
  meta.lane = personLaneStamp(lane.userId)
  return { content: command.content, meta }
}

/**
 * What a lane boot re-offers. With a cursor (a relaunch after a crash or an
 * idle stop), every row after it from the last 24 hours, at most ten. With
 * none (the lane's very first start), only the last 15 minutes, at most five:
 * the turn that woke it, never a person's older history that the agent's
 * single mind may already have answered before lanes. Oldest first. A lane
 * whose folders were deleted has no cursor either, so a boot with no inbox
 * note then drops every row the server shows already answered (acknowledged,
 * LANE_SERVER_ACKNOWLEDGED, and answered after it or a performed command;
 * lane-server.ts answeredAtServer, 0.71.2).
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
  /**
   * Set while a launch with no note has not yet asked the server what was
   * already handed over (0.71.2): a note saved in that window is not trusted
   * by the next launch.
   */
  unverified?: true
  /**
   * The message id of the last `/new` this lane performed: a turn older than
   * it belongs to the conversation the person left and is never handed over
   * after it. In the note, so a restart (which the `/new` itself asks for)
   * keeps it too (0.71.2).
   */
  newFrom?: number
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
  const newFrom = Number(r.newFrom)
  return {
    cursor: Number.isSafeInteger(cursor) && cursor > 0 ? cursor : 0,
    delivered,
    pending,
    ...(r.unverified === true ? { unverified: true as const } : {}),
    ...(Number.isSafeInteger(newFrom) && newFrom > 0 ? { newFrom } : {}),
  }
}

/** The note once the boot poll has asked the server: trusted again, nothing else changed. */
export function inboxVerified(state: LaneInboxState): LaneInboxState {
  const next = { ...state }
  delete next.unverified
  return next
}

/**
 * Does a launch trust this inbox note? Only a note that is an object and was
 * not saved by a first boot that never finished asking the server. Without
 * one, the boot poll asks the server what was already handed over (0.71.2).
 */
export function inboxTrusted(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  return (raw as Record<string, unknown>).unverified !== true
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

/**
 * A command the lane daemon performed itself (`/new`, `/model x`, `/effort
 * x`): never handed to Claude again, and never waiting for a reply, so it is
 * remembered as delivered and NOT as pending.
 */
export function inboxNoteHandled(state: LaneInboxState, d: { messageId: number }): LaneInboxState {
  const delivered = state.delivered.includes(d.messageId)
    ? state.delivered
    : [...state.delivered, d.messageId].slice(-LANE_INBOX_DELIVERED_MAX)
  return { ...state, delivered, pending: state.pending.filter((p) => p.id !== d.messageId) }
}

/**
 * `/new`: the turns still waiting belong to the conversation the person just
 * left, so the new one must not be handed them on its first poll (found in
 * the live run: they were re-offered into the fresh session). They stay
 * delivered, so nothing is handed over twice; nothing waits any more.
 */
export function inboxForNewConversation(state: LaneInboxState): LaneInboxState {
  return { ...state, pending: [] }
}

/** A reply in a chat answers every turn waiting there. */
export function inboxNoteReplied(state: LaneInboxState, chatId: string): LaneInboxState {
  return { ...state, pending: state.pending.filter((p) => p.chatId !== chatId) }
}

export function inboxAdvanceCursor(state: LaneInboxState, id: number): LaneInboxState {
  return id > state.cursor ? { ...state, cursor: id } : state
}

/**
 * ONE DECISION PER MESSAGE ID (0.71.2). The socket and the poll both hand
 * turns over, and each used to decide from the inbox alone; the boot poll
 * read its re-offer set AFTER its fetch, so a message the socket path had
 * noted during that fetch looked like a turn the last life left unanswered
 * and was handed to Claude a second time, and acked twice (measured: the
 * 0.71.1 hold is not needed for it). Now each id is decided once per
 * process, synchronously, before the caller's first await, and only the
 * turns the inbox held at launch can be re-offered.
 */
export class LaneDeliveryClaims {
  private readonly taken = new Set<number>()
  private readonly reofferable: Set<number>

  /** `launch` is the inbox this process read at launch: its waiting turns are this life's only re-offers. */
  constructor(launch: LaneInboxState) {
    this.reofferable = new Set(launch.pending.map((p) => p.id))
  }

  /** A turn the last life handed over and left unanswered (`take` still decides). */
  mayReoffer(id: number): boolean {
    return this.reofferable.has(id)
  }

  /**
   * Hand message `id` to Claude? True once per process at most; the caller
   * acts on it before any await. A re-offer must also still be waiting in
   * `state`, so after a `/new` (which empties the waiting list) none is.
   */
  take(state: LaneInboxState, id: number, opts: { reoffer: boolean }): boolean {
    if (this.taken.has(id)) return false
    if (!inboxShouldDeliver(state, id, { reoffer: opts.reoffer && this.reofferable.has(id) })) return false
    this.taken.add(id)
    return true
  }
}

// ── What the server says was picked up and answered (0.71.2) ────────────────

/**
 * The delivery state a lane's ack leaves on a message: the lane acks a turn
 * the moment it hands it to Claude, and the person's chat history
 * (`GET chats/:chatId/messages`, a route a lane session may read for its own
 * chats) carries it as the message's `deliveryState`. It is not the lane's
 * alone: the owner's daemon acked the same way before lanes, and the backend
 * marks the chat's latest user message acknowledged whenever an agent row is
 * saved there (a lane notice included). So acknowledged alone is not
 * answered, and only a lane with no inbox note asks at all.
 */
export const LANE_SERVER_ACKNOWLEDGED = 'acknowledged'

/**
 * How often the boot poll tries one history read before it gives up, how
 * long one try may take, and the pause before each retry (times the attempt):
 * one read takes at most 3 x 4 s + 1 s + 2 s = 15 s. A row needs at most two
 * reads (the second only when it is acknowledged) and rows are asked in
 * parallel, so the person's waiting turn is held at most 30 s, and only when
 * the route fails or hangs; a healthy read takes milliseconds.
 */
export const LANE_HISTORY_READ_ATTEMPTS = 3
export const LANE_HISTORY_READ_TIMEOUT_MS = 4_000
export const LANE_HISTORY_RETRY_MS = 1_000

/**
 * How many rows after a message the boot poll reads to see whether an agent
 * answered it (the backend serves the newest of them).
 */
export const LANE_HISTORY_AFTER_LIMIT = 50

/**
 * The fixed sentences the owner's daemon posts as the agent for a lane
 * (lib/lane-core.mjs LANE_NOTICES). The backend's reply hook marks her latest
 * message acknowledged for them too, though they answer nothing.
 */
export const LANE_NOTICE_SENTENCES: readonly string[] = Object.freeze(Object.values(LANE_NOTICES as Record<string, string>))

/** The history page for exactly one message of a chat. */
export function laneHistoryPathFor(d: { chatId: string; messageId: number }): string {
  return `chats/${encodeURIComponent(d.chatId)}/messages?afterId=${d.messageId - 1}&beforeId=${d.messageId + 1}&limit=1`
}

/** The history page after one message of a chat: the rows that follow it. */
export function laneHistoryAfterPathFor(d: { chatId: string; messageId: number }): string {
  return `chats/${encodeURIComponent(d.chatId)}/messages?afterId=${d.messageId}&limit=${LANE_HISTORY_AFTER_LIMIT}`
}

/**
 * Did an agent ANSWER `messageId`? True when the page carries an agent row
 * after it that is not one of the lane's fixed notices; false when it carries
 * none; null when the page is unreadable. The page is the backend's
 * MessagesDto, as for laneHistoryDeliveryState.
 */
export function laneHistoryAnsweredAfter(answer: unknown, messageId: number, notices: readonly string[]): boolean | null {
  const rows = historyMessages(answer)
  if (!rows) return null
  for (const m of rows) {
    if (!(Number(m.id) > messageId) || m.sender !== 'assistant') continue
    if (!notices.includes(String(m.text ?? '').trim())) return true
  }
  return false
}

/**
 * The delivery state a history page shows for `messageId`, or null when the
 * page does not carry that row. The page is the backend's MessagesDto: each
 * entry is `{ message, messageFiles, messageOptions }` and the state is on
 * `message` (a bare message is read the same way).
 */
export function laneHistoryDeliveryState(answer: unknown, messageId: number): string | null {
  for (const m of historyMessages(answer) ?? []) {
    if (Number(m.id) !== messageId) continue
    return typeof m.deliveryState === 'string' ? m.deliveryState : null
  }
  return null
}

/**
 * The messages of a history page, or null when it is not one. The backend
 * answers MessagesDto, `{ messages: [{ message, messageFiles, messageOptions }] }`;
 * a bare message is read the same way.
 */
function historyMessages(answer: unknown): Array<Record<string, unknown>> | null {
  const page = (answer as { messages?: unknown } | null)?.messages
  const rows: unknown[] | null = Array.isArray(answer) ? answer : Array.isArray(page) ? page : null
  if (!rows) return null
  return rows.map((row) => {
    const entry = (row ?? {}) as Record<string, unknown>
    return (entry.message && typeof entry.message === 'object' ? entry.message : entry) as Record<string, unknown>
  })
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

// ── Claude has the tools before the first turn (0.71.1) ─────────────────────

/**
 * How long a turn waits after Claude Code read this server's tool list.
 * Claude Code 2.1.302 registers a server's channel handler the moment the
 * server connects but puts the server's tools into its tool pool on a 16 ms
 * batch, so a turn that reaches it in between is built without `reply`, and
 * with ToolSearch outside the lane's --tools the tool then stays out for the
 * whole session (measured on the lane's locked launch: a turn 2 ms after the
 * list had no `reply`, one 100 ms after had it). A lane's first turn is
 * waiting when its daemon connects, so it always landed in that gap.
 */
export const LANE_CLAUDE_SETTLE_MS = 2_000

/** How long the ping that proves Claude read the tool list may take. */
export const LANE_CLAUDE_PING_TIMEOUT_MS = 5_000

/**
 * A Claude that never asks for the tool list still gets its turns after this
 * long (the CLI's own MCP connect timeout), so a turn is never held forever.
 */
export const LANE_CLAUDE_READY_MAX_MS = 30_000

export interface LaneClaudeReadyDeps {
  /** A ping to Claude Code; it answers once it has read what came before. */
  ping: () => Promise<unknown>
  setTimer: (fn: () => void, ms: number) => unknown
  log: (line: string) => void
}

/**
 * When the lane daemon may hand Claude a turn: after Claude asked for the
 * tool list, a ping sent after that answer came back (or failed, or took
 * LANE_CLAUDE_PING_TIMEOUT_MS), and LANE_CLAUDE_SETTLE_MS passed. Once ready
 * it stays ready.
 */
export class LaneClaudeReady {
  private ready = false
  private listed = false
  private waiters: Array<() => void> = []

  constructor(private readonly deps: LaneClaudeReadyDeps) {}

  /** From the daemon's start: the limit for a Claude that never lists the tools. */
  start(): void {
    this.deps.setTimer(() => this.open('Claude did not ask for the tool list in time; handing turns over anyway'), LANE_CLAUDE_READY_MAX_MS)
  }

  /** Claude asked for the tool list. Called inside the handler, before its answer is written. */
  noteToolsListed(): void {
    if (this.listed || this.ready) return
    this.listed = true
    // A timer, so the ping goes out after the answer: Claude reads the two in that order.
    this.deps.setTimer(() => void this.probe(), 0)
  }

  get isReady(): boolean {
    return this.ready
  }

  whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve()
    return new Promise((resolve) => { this.waiters.push(resolve) })
  }

  private async probe(): Promise<void> {
    try {
      await new Promise((resolve, reject) => {
        this.deps.setTimer(() => reject(new Error('no answer')), LANE_CLAUDE_PING_TIMEOUT_MS)
        this.deps.ping().then(resolve, reject)
      })
    } catch (err) {
      this.deps.log(`the ping after the tool list failed (${err instanceof Error ? err.message : String(err)}); settling anyway`)
    }
    this.deps.setTimer(() => this.open(null), LANE_CLAUDE_SETTLE_MS)
  }

  private open(why: string | null): void {
    if (this.ready) return
    this.ready = true
    if (why) this.deps.log(why)
    for (const resolve of this.waiters.splice(0)) resolve()
  }
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
    'You run on the agent owner\'s computer in a locked lane: your working folder is the only folder you can write, what else this lane allows is in your instructions for this lane, and you cannot reach the owner\'s accounts or other people\'s conversations.',
    'If you are asked for something you cannot do here, say so in one plain sentence.',
  ].join('\n')
}
