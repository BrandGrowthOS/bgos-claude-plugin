#!/usr/bin/env bun
/**
 * THE LANE DAEMON: the BGOS server of ONE person's lane on a shared agent
 * (shared agents Phase 3, P3). Claude Code starts it from the lane's own
 * mcp.json under the name `bgos`; bin/hoai-lane.mjs wrote that file. See
 * lib/lane-daemon.ts for what it deliberately is not (no credentials file, no
 * pairing token, no agent lock, one tool, no permission relay).
 *
 * What it does:
 *   1. checks its environment names exactly this lane's folders, and drops
 *      any Claude or BGOS secret from its own environment;
 *   2. mints its lane session with the single use ticket the owner's daemon
 *      left in the lane's state folder (or reuses the stored one while it is
 *      valid), and checks `GET lanes/me` names exactly this lane;
 *   3. connects its lane socket presenting the lane session ALONE, catches up
 *      from its own cursor through `GET lanes/inbound`, and delivers each turn
 *      to Claude as a channel event, only when it is stamped for this lane,
 *      and never before Claude has this server's tools (0.71.1); each
 *      message at most once per process, and, when it starts with no inbox
 *      note, never a backlog turn the server shows acknowledged (0.71.2);
 *   4. acknowledges each delivered turn, beats its own heartbeat, records its
 *      activity in lane.json for the supervisor's idle stop, and stops the
 *      lane on `lane_revoked` or when its session ends;
 *   5. under the person's own sign in (K2 option b), watches its transcript
 *      for a refused login and then tells the person and stops;
 *   6. (P5) answers the person's Memory screen from the lane's own memory
 *      folder (`memory_rpc` stamped for this lane, `lane_memory_rpc` declared
 *      in its handshake, the echo on every answer, a write at most once per
 *      rpcId across processes); performs `/new`, `/model x` and `/effort x`
 *      itself (a restart request for the supervisor) and hands every other
 *      command to the model from the LANE catalog only, never the owner's
 *      command folders; reports its model and effort with its lane session;
 *   7. (P7) watches the share's policy (`lane_policy_changed`, every heartbeat
 *      answer, and `lanes/me` at boot) against the policy its Claude was
 *      launched with: tighter restarts the lane at once (a turn in flight is
 *      told in one sentence), looser restarts it at its next idle moment.
 *
 * NOTICE MODE (`HOAI_LANE_NOTICE` set, no Claude, not an MCP server): the
 * supervisor runs it when the lane cannot start at all (option b with no
 * token). It mints the session, reads which of the person's own chats hold
 * the waiting turn, writes one notice event for the owner's daemon to post
 * the plain sentence there, and exits. It acknowledges nothing.
 *
 * No em or en dashes in this file.
 */
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { io as socketIoClient, type Socket } from 'socket.io-client'

import {
  laneEventLine,
  lanePaths,
  laneStateBody,
  LANE_LOGIN_OWN_TOKEN,
  LANE_MEMORY_RPC_TOKEN,
  LANE_TURN_STUCK_MS,
} from './lib/lane-core.mjs'
import { heartbeatToolPolicy, laneMePolicy, readLaneChoices, readToolPolicy } from './lib/lane-policy.mjs'
import {
  laneChoiceQuestionFor,
  launchedFacts,
  LanePolicyWatch,
  performLaneCommand,
  requestLaneRestart,
  type RestartAsk,
} from './lib/lane-controls.ts'
import { classifyMemoryFrame, LaneMemoryRpcHandler } from './lib/lane-memory-rpc.ts'
import { routeLaneSlash } from './lib/lane-slash.ts'
import { acquireLaneLock, defaultPidAlive, releaseLaneLock } from './lib/lane-registry.mjs'
import {
  buildLaneChannelEvent,
  buildLaneCommandEvent,
  checkLaneReply,
  debugLogSaysTokenRefused,
  inboxAdvanceCursor,
  inboxForNewConversation,
  inboxNoteDelivered,
  inboxNoteHandled,
  inboxNoteReplied,
  inboxPollFrom,
  inboxTrusted,
  inboxVerified,
  LaneClaudeReady,
  laneDeliveryGate,
  LaneDeliveryClaims,
  laneHistoryAfterPathFor,
  laneHistoryAnsweredAfter,
  laneHistoryDeliveryState,
  laneHistoryPathFor,
  LANE_NOTICE_SENTENCES,
  LANE_HISTORY_READ_ATTEMPTS,
  LANE_HISTORY_READ_TIMEOUT_MS,
  LANE_HISTORY_RETRY_MS,
  laneInstructions,
  laneMeMatches,
  LANE_INLINE_FILE_MAX_BYTES,
  LANE_SERVER_ACKNOWLEDGED,
  LANE_TOOLS,
  normaliseLaneDelivery,
  readLaneDaemonConfig,
  readLaneInbox,
  readMintAnswer,
  readTicketFile,
  scrubLaneDaemonEnv,
  selectLaneBacklog,
  storedSessionUsable,
  type LaneDelivery,
  type LaneInboxState,
  type StoredLaneSession,
} from './lib/lane-daemon.ts'
import { ClaudeLoginWatcher } from './lib/claude-login.ts'
import { getFileCategory, guessOutboundMime, unsupportedFileMessage } from './lib/message-text.ts'
import { mcpServerInfo } from './lib/mcp-server-info.ts'
import { readOwnVersion } from './lib/version-heartbeat.ts'

const HOME = process.env.HOME || homedir()
const read = readLaneDaemonConfig(process.env, HOME)
if (!read.ok) {
  process.stderr.write(`[hoai lane] refusing to start: ${read.reason}\n`)
  process.exit(1)
}
const CFG = read.config
const LANE = { userId: CFG.userId, assistantId: CFG.assistantId }
// The person's own sign in (option b) reaches this process through Claude
// Code's environment; the daemon needs none, so nothing it starts inherits it.
scrubLaneDaemonEnv(process.env)

const LOG_PATH = join(CFG.laneDir, 'lane-daemon.log')
function log(line: string): void {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
  } catch { /* logging is best effort */ }
}

const SESSION_PATH = join(CFG.stateDir, 'session.json')
const TICKET_PATH = join(CFG.stateDir, 'ticket.json')
const CURSOR_PATH = join(CFG.stateDir, 'cursor.json')
const DAEMON_LOCK_PATH = join(CFG.stateDir, 'daemon.lock')
const LANE_JSON_PATH = join(CFG.laneDir, 'lane.json')
const STOP_REQUEST_PATH = join(CFG.laneDir, 'stop-request.json')
const EVENTS_PATH = join(CFG.laneDir, 'events.jsonl')
// P5 and P7: the same folders readLaneDaemonConfig checked, under their names.
const PATHS = lanePaths({ home: HOME, assistantId: CFG.assistantId, userId: CFG.userId, stateRoot: process.env.BGOS_PLUGIN_STATE_DIR })
// What this launch was given (policy, model, effort), read ONCE from this
// process's own environment, which the supervisor wrote into mcp.json.
const LAUNCHED_ENV: Record<string, string | undefined> = {
  HOAI_LANE_LAUNCH_POLICY: process.env.HOAI_LANE_LAUNCH_POLICY,
  HOAI_LANE_LAUNCH_MODEL: process.env.HOAI_LANE_LAUNCH_MODEL,
  HOAI_LANE_LAUNCH_EFFORT: process.env.HOAI_LANE_LAUNCH_EFFORT,
}
mkdirSync(CFG.stateDir, { recursive: true, mode: 0o700 })

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
  try { chmodSync(path, 0o600) } catch { /* best effort */ }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// ── HTTP, with the lane session and nothing else ────────────────────────────

let session: StoredLaneSession | null = null

class LaneHttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`HTTP ${status}`)
  }
}

async function laneFetch(method: string, path: string, body?: unknown, opts: { auth?: boolean; timeoutMs?: number } = {}): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.auth !== false) {
    if (!session) throw new LaneHttpError(401, 'no lane session')
    headers['X-BGOS-Session'] = session.sessionToken
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000)
  try {
    const res = await fetch(`${CFG.apiBase}/${path.replace(/^\//, '')}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new LaneHttpError(res.status, text.slice(0, 500))
    return text ? JSON.parse(text) : null
  } finally {
    clearTimeout(timer)
  }
}

// ── The lane session ────────────────────────────────────────────────────────

function takeTicket(): string | null {
  let text: string
  try {
    text = readFileSync(TICKET_PATH, 'utf8')
  } catch {
    return null
  }
  // Single use: removed before it is spent, so a crash cannot spend it twice.
  try { unlinkSync(TICKET_PATH) } catch { /* raced */ }
  return readTicketFile(text, Date.now())
}

async function mintWithTicket(ticket: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const answer = readMintAnswer(await laneFetch('POST', 'integrations/lanes/session', { laneTicket: ticket }, { auth: false }), LANE)
      if (!answer) {
        log('lane session mint answered something that is not this lane; refused')
        return false
      }
      session = answer
      writePrivateJson(SESSION_PATH, answer)
      log(`lane session minted (expires ${answer.expiresAt})`)
      return true
    } catch (err) {
      if (err instanceof LaneHttpError && err.status === 429) {
        await new Promise((r) => setTimeout(r, 5_000))
        continue
      }
      log(`lane session mint failed: ${err instanceof LaneHttpError ? err.status : String(err)}`)
      return false
    }
  }
  return false
}

async function ensureSession(): Promise<boolean> {
  if (session && storedSessionUsable(session, LANE, Date.now())) return true
  session = null
  const stored = readJson(SESSION_PATH)
  if (storedSessionUsable(stored, LANE, Date.now())) {
    session = stored
    return true
  }
  const ticket = takeTicket()
  return ticket ? mintWithTicket(ticket) : false
}

/** A lane route answered 401 or 403: the session is gone or no longer admitted. */
async function sessionRefused(where: string): Promise<void> {
  log(`lane session refused at ${where}`)
  session = null
  try { unlinkSync(SESSION_PATH) } catch { /* gone */ }
  if (await ensureSession()) return
  endLane('session_ended')
}

// ── Stopping the lane ───────────────────────────────────────────────────────

let ending = false
function endLane(reason: string): void {
  if (ending) return
  ending = true
  log(`ending the lane: ${reason}`)
  try {
    writePrivateJson(STOP_REQUEST_PATH, { reason, at: new Date().toISOString(), by: 'lane-daemon' })
  } catch { /* the supervisor still sees Claude exit */ }
  try { socket?.disconnect() } catch { /* closed */ }
  for (const t of timers) clearInterval(t)
  setTimeout(() => shutdown(0), 500)
}

function appendEvent(event: Record<string, unknown>): void {
  try {
    appendFileSync(EVENTS_PATH, laneEventLine(event), { mode: 0o600 })
  } catch (err) {
    log(`could not record event ${String(event.event)}: ${String(err)}`)
  }
}

/**
 * Every inbound row of this lane after `from`. The route answers the OLDEST
 * 200 rows first, so a lane with a long history pages until a short page.
 */
async function fetchLaneInbound(from: number): Promise<unknown[]> {
  const out: unknown[] = []
  let since = from
  for (let page = 0; page < 50; page += 1) {
    const answer = (await laneFetch('GET', `integrations/lanes/inbound?since_message_id=${since}`)) as { messages?: unknown[] } | null
    const rows = answer?.messages ?? []
    out.push(...rows)
    if (rows.length < 200) break
    const last = Math.max(...rows.map((r) => Number((r as Record<string, unknown>)?.id ?? (r as Record<string, unknown>)?.message_id ?? 0)))
    if (!Number.isSafeInteger(last) || last <= since) break
    since = last
  }
  return out
}

// ── NOTICE MODE ─────────────────────────────────────────────────────────────

async function runNoticeMode(notice: string): Promise<number> {
  if (!(await ensureSession())) {
    log('notice mode: no lane session; the owner\'s daemon will report lane_failed alone')
    return 2
  }
  try {
    if (!laneMeMatches(await laneFetch('GET', 'integrations/lanes/me'), LANE)) {
      log('notice mode: lanes/me does not name this lane')
      return 3
    }
    const nowMs = Date.now()
    const chatIds = new Set<number>()
    for (const raw of await fetchLaneInbound(0)) {
      const gate = laneDeliveryGate(raw, LANE)
      if (!gate.deliver) continue
      const d = gate.delivery
      const at = d.createdAt ? Date.parse(d.createdAt) : NaN
      if (d.chatKind !== 'main' || !Number.isFinite(at) || nowMs - at > 24 * 60 * 60_000) continue
      chatIds.add(Number(d.chatId))
    }
    appendEvent({ event: 'notice', notice, chatIds: [...chatIds].slice(0, 5) })
    log(`notice mode: ${notice} for ${chatIds.size} chat(s)`)
    return 0
  } catch (err) {
    log(`notice mode failed: ${err instanceof LaneHttpError ? err.status : String(err)}`)
    return 4
  }
}

if (CFG.notice) {
  const code = await runNoticeMode(CFG.notice)
  process.exit(code)
}

// ── THE LANE DAEMON ─────────────────────────────────────────────────────────

const lock = acquireLaneLock(DAEMON_LOCK_PATH, { isAlive: defaultPidAlive })
if (!lock.acquired) {
  process.stderr.write('[hoai lane] another daemon already serves this lane\n')
  process.exit(1)
}

const timers: Array<ReturnType<typeof setInterval>> = []
let socket: Socket | null = null
let shuttingDown = false
function shutdown(code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  for (const t of timers) clearInterval(t)
  try { socket?.disconnect() } catch { /* closed */ }
  releaseLaneLock(DAEMON_LOCK_PATH)
  process.exit(code)
}
process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))

// Activity, for the supervisor's idle stop.
let lastActivityAtMs = Date.now()
let inFlight = false
let inFlightSinceMs: number | null = null
let errorCode: string | null = null
const inFlightChats = new Set<string>()
function writeLaneState(): void {
  try {
    writePrivateJson(LANE_JSON_PATH, laneStateBody({
      userId: LANE.userId,
      assistantId: LANE.assistantId,
      lastActivityAtMs,
      inFlight,
      inFlightSinceMs,
      loginMode: CFG.loginMode,
      pid: process.pid,
    }))
  } catch (err) {
    log(`could not write lane.json: ${String(err)}`)
  }
}

const launchNote = readJson(CURSOR_PATH)
let inbox: LaneInboxState = readLaneInbox(launchNote)
// No note (a first start, or a lane whose folders were deleted): only then
// does the boot poll ask the server what was already handed over (0.71.2).
// With a note, the note is the authority. A note saved before that boot
// poll has asked is marked, so a restart in between does not trust it.
const launchHadNote = inboxTrusted(launchNote)
if (!launchHadNote) inbox = { ...inbox, unverified: true }
function saveInbox(): void {
  try { writePrivateJson(CURSOR_PATH, inbox) } catch (err) { log(`could not save the inbox: ${String(err)}`) }
}
// Chats this lane was handed a turn in: the only chats `reply` may write to.
const deliveredChats = new Set<string>(inbox.pending.map((p) => p.chatId))
// Which turns this process hands over, decided once per message id (0.71.2).
const claims = new LaneDeliveryClaims(inbox)

const ROOT = dirname(fileURLToPath(import.meta.url))
const mcp = new Server(mcpServerInfo(readOwnVersion(ROOT)), {
  capabilities: {
    tools: {},
    // The channel only. NO 'claude/channel/permission': a lane never relays a
    // permission request, and never approves one.
    experimental: { 'claude/channel': {} },
  },
  instructions: laneInstructions(''),
})

// No turn reaches Claude before Claude has `reply` in its tool pool (0.71.1,
// lib/lane-daemon.ts LaneClaudeReady): a lane's first turn is waiting when
// this daemon connects, and one handed over at once was answered in text
// nobody sees.
const claudeReady = new LaneClaudeReady({ ping: () => mcp.ping(), setTimer: (fn, ms) => setTimeout(fn, ms), log })

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  claudeReady.noteToolsListed()
  return { tools: LANE_TOOLS.map((t) => ({ ...t })) }
})

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'reply') {
    return { content: [{ type: 'text' as const, text: `Unknown tool: ${req.params.name}` }], isError: true }
  }
  const checked = checkLaneReply(req.params.arguments, { workDir: CFG.workDir, realpath: realpathSync, deliveredChats })
  if (!checked.ok) return { content: [{ type: 'text' as const, text: checked.message }], isError: true }
  try {
    const files = []
    for (const path of checked.paths) {
      const name = basename(path)
      const mime = guessOutboundMime(path, name, undefined)
      if (!mime) throw new Error(unsupportedFileMessage(name))
      const category = getFileCategory(mime)
      if (!category) throw new Error(unsupportedFileMessage(name, mime))
      if (statSync(path).size > LANE_INLINE_FILE_MAX_BYTES) throw new Error(`${name} is over 5 MB; a lane attaches files up to 5 MB.`)
      const data = Buffer.from(await readFile(path)).toString('base64')
      files.push({
        fileName: name,
        fileData: `data:${mime};base64,${data}`,
        fileMimeType: mime,
        isImage: category === 'image',
        isVideo: category === 'video',
        isDocument: category === 'document',
        isAudio: category === 'audio',
      })
    }
    if (!(await ensureSession())) throw new Error('This lane has no session with HOAI right now.')
    // The same route the owner's daemon replies through, with the LANE
    // session: the backend acts as this agent in this person's lane once the
    // route admits lanes (design 5.2), and refuses it until then.
    await laneFetch('POST', 'send-message', {
      chatId: Number(checked.chatId),
      assistantId: Number(LANE.assistantId),
      text: checked.text,
      sender: 'assistant',
      sentDate: new Date().toISOString(),
      hasAttachment: files.length > 0,
      files,
      options: [],
    })
    inFlightChats.delete(checked.chatId)
    inbox = inboxNoteReplied(inbox, checked.chatId)
    saveInbox()
    inFlight = inFlightChats.size > 0
    inFlightSinceMs = inFlight ? inFlightSinceMs : null
    lastActivityAtMs = Date.now()
    writeLaneState()
    return { content: [{ type: 'text' as const, text: 'Sent.' }] }
  } catch (err) {
    lastActivityAtMs = Date.now()
    writeLaneState()
    if (err instanceof LaneHttpError) {
      log(`reply refused by the backend: ${err.status} ${err.body.slice(0, 200)}`)
      const refusedForLanes = err.status === 403
      return {
        content: [{
          type: 'text' as const,
          text: refusedForLanes
            ? 'HOAI did not accept this reply from a person\'s lane (it does not take lane replies yet). The person has not received it.'
            : `HOAI did not accept this reply (HTTP ${err.status}). The person has not received it.`,
        }],
        isError: true,
      }
    }
    return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true }
  }
})

async function deliverRaw(raw: unknown, transport: 'lane-socket' | 'lane-poll', opts: { backlog?: boolean; reoffer?: boolean } = {}): Promise<void> {
  const gate = laneDeliveryGate(raw, LANE)
  if (!gate.deliver) {
    // The second lock: never delivered, never acknowledged, so the row stays
    // for the lane it belongs to.
    log(`${gate.reason} (${transport})`)
    return
  }
  const d = gate.delivery
  if (d.messageId < (inbox.newFrom ?? 0)) {
    // From the conversation the person left with a `/new` (in this life or,
    // through the note, the last): never handed over, never waiting, even one
    // the boot poll was still deciding (0.71.2).
    if (!inbox.delivered.includes(d.messageId)) {
      inbox = inboxNoteHandled(inbox, d)
      saveInbox()
    }
    return
  }
  // The one decision for this id, before any await: the socket and the poll
  // can never both hand it over (0.71.2).
  if (!claims.take(inbox, d.messageId, { reoffer: opts.reoffer === true })) return
  // P5: the lane's own commands. Only the LANE catalog is consulted, never a
  // command folder on this computer.
  const route = routeLaneSlash(d.raw as Record<string, unknown>)
  if ((route.kind === 'new') || ((route.kind === 'model' || route.kind === 'effort') && route.commandArgs !== '')) {
    inbox = inboxNoteHandled(inbox, d)
    if (route.kind === 'new') {
      // The new conversation starts empty: no turn of the old one is re-offered.
      inbox = inboxForNewConversation(inbox)
      // Saved with the note below, before the restart this /new asks for.
      inbox = { ...inbox, newFrom: Math.max(inbox.newFrom ?? 0, d.messageId) }
      inFlightChats.clear()
      inFlight = false
      inFlightSinceMs = null
      writeLaneState()
    }
    saveInbox()
    deliveredChats.add(d.chatId)
    await ackDelivery(d.messageId)
    performLaneCommand({ kind: route.kind, commandArgs: route.commandArgs }, d.chatId, CONTROL_DEPS)
    return
  }
  inbox = inboxNoteDelivered(inbox, d)
  saveInbox()
  const plain = buildLaneChannelEvent(d, LANE, transport, { backlog: opts.backlog === true })
  const event = route.kind === 'directive'
    ? buildLaneCommandEvent(d, LANE, transport, { content: route.delivery.content, meta: route.delivery.meta }, { backlog: opts.backlog === true })
    : route.kind === 'model' || route.kind === 'effort'
      ? buildLaneCommandEvent(d, LANE, transport, laneChoiceQuestionFor(route.kind, PATHS, LAUNCHED_ENV), { backlog: opts.backlog === true })
      : plain
  await claudeReady.whenReady()
  // Only now is the chat one `reply` may write to: the turn is Claude's.
  deliveredChats.add(d.chatId)
  await mcp.notification({ method: 'notifications/claude/channel', params: { content: event.content, meta: event.meta } })
  inFlightChats.add(d.chatId)
  if (!inFlight) inFlightSinceMs = Date.now()
  inFlight = true
  lastActivityAtMs = Date.now()
  writeLaneState()
  await ackDelivery(d.messageId)
}

async function ackDelivery(messageId: number): Promise<void> {
  try {
    await laneFetch('POST', `integrations/messages/${messageId}/ack`, {})
  } catch (err) {
    if (err instanceof LaneHttpError && err.status === 401) await sessionRefused('ack')
    else log(`ack ${messageId} failed: ${err instanceof LaneHttpError ? err.status : String(err)}`)
  }
}

// ── P5: the person's own commands, memory and model ─────────────────────────

function notice(name: string, chatIds: Array<string | number>): void {
  appendEvent({ event: 'notice', notice: name, chatIds: chatIds.map(Number) })
}

function requestRestart(next: RestartAsk): void {
  try {
    const merged = requestLaneRestart(PATHS.restartRequestPath, next)
    log(`restart asked (${merged.reasons.join(', ')}, ${merged.when}${merged.fresh ? ', new session' : ''})`)
  } catch (err) {
    log(`could not ask for a restart: ${String(err)}`)
  }
}

const CONTROL_DEPS = { paths: PATHS, notice, requestRestart, log }

/**
 * The lane's model and effort, reported with its lane session on the chat
 * where the person last chose one (the server writes it on her chat and
 * tells her). What is reported is what this Claude was launched with.
 */
const SESSION_SETTINGS_MODEL_RE = /^[\w./:-]{1,160}$/
async function reportModelAndEffort(): Promise<void> {
  const choices = readLaneChoices(readText(PATHS.choicesPath))
  if (!choices.chatId) return
  const launched = launchedFacts(LAUNCHED_ENV)
  const model = launched.model && SESSION_SETTINGS_MODEL_RE.test(launched.model) ? launched.model : null
  const effort = launched.effort
  try {
    await laneFetch('PATCH', `integrations/assistants/${encodeURIComponent(LANE.assistantId)}/chats/${encodeURIComponent(choices.chatId)}/session-settings`, {
      model,
      effort,
      reportedAt: new Date().toISOString(),
    })
    log(`model and effort reported (${model ?? 'default'}, ${effort ?? 'default'})`)
  } catch (err) {
    log(`model report refused: ${err instanceof LaneHttpError ? err.status : String(err)}`)
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

const laneMemory = new LaneMemoryRpcHandler({
  assistantId: LANE.assistantId,
  home: HOME,
  stateRoot: process.env.BGOS_PLUGIN_STATE_DIR,
  // A running lane answers only for its own person (design section 6).
  accepts: (userId) => userId === LANE.userId,
  postAck: (rpcId) => laneFetch('POST', `integrations/memory-rpc/${encodeURIComponent(rpcId)}/ack`, {}),
  postResult: (rpcId, body) => laneFetch('POST', `integrations/memory-rpc/${encodeURIComponent(rpcId)}/result`, body),
  log: (line) => log(line),
})

// ── P7: the share's policy against the one this Claude was launched with ────

const policyWatch = new LanePolicyWatch({
  launchedPolicy: () => launchedFacts(LAUNCHED_ENV).policy,
  inFlightChats: () => (inFlight ? [...inFlightChats] : []),
  notice,
  requestRestart,
  log,
})

function onPolicy(current: ReturnType<typeof readToolPolicy>, where: string): void {
  policyWatch.onPolicy(current, where)
}

async function readPolicyNow(where: string): Promise<void> {
  try {
    const policy = laneMePolicy(await laneFetch('GET', 'integrations/lanes/me'), LANE)
    if (policy) onPolicy(policy, where)
  } catch (err) {
    if (err instanceof LaneHttpError && (err.status === 401 || err.status === 403)) await sessionRefused('lanes/me')
    else log(`lanes/me failed: ${err instanceof LaneHttpError ? err.status : String(err)}`)
  }
}

let polling = false
let firstPoll = true
async function poll(): Promise<void> {
  if (polling || ending) return
  polling = true
  try {
    if (!(await ensureSession())) {
      endLane('no_session')
      return
    }
    const from = inboxPollFrom(inbox)
    const rows = (await fetchLaneInbound(from))
      .map((raw) => ({ raw, d: normaliseLaneDelivery(raw) }))
      .filter((r): r is { raw: unknown; d: LaneDelivery } => r.d !== null)
      .sort((a, b) => a.d.messageId - b.d.messageId)
    const boot = firstPoll
    // New rows: on the very first start only the turn that woke the lane
    // (selectLaneBacklog); after that, every row past the cursor.
    let backlog = selectLaneBacklog(rows.filter((r) => !inbox.delivered.includes(r.d.messageId)).map((r) => r.d), {
      cursor: inbox.cursor,
      nowMs: Date.now(),
    })
    if (boot && !launchHadNote && backlog.length > 0) {
      // A lane whose folders were deleted boots with no inbox note and would
      // re-answer the person's last 15 minutes: the server's record of what
      // was already handed over decides instead (0.71.2). Only rows stamped
      // for this lane are asked about: the rest never go over (the second
      // lock refuses them below), and the server would refuse the read.
      const { answered, newFrom } = await answeredAtServer(backlog.filter((d) => laneDeliveryGate(d.raw, LANE).deliver))
      // A `/new` she sent, performed before the folders went: the turns older
      // than it belong to the conversation she left (deliverRaw keeps them out).
      if (newFrom > (inbox.newFrom ?? 0)) inbox = { ...inbox, newFrom }
      for (const d of backlog) {
        // Handed over in this life while the server was asked (the socket
        // path noted it, and its ack is what the server saw): its own note
        // stands, waiting for its answer.
        if (!answered.has(d.messageId) || inbox.delivered.includes(d.messageId)) continue
        log(`backlog turn ${d.messageId} was already answered (acknowledged at the server, and answered or performed); not offered again`)
        inbox = inboxNoteHandled(inbox, d)
      }
      backlog = backlog.filter((d) => !answered.has(d.messageId))
    }
    // The server was asked (or nothing needed asking): the note is trusted from here.
    if (boot && inbox.unverified) inbox = inboxVerified(inbox)
    firstPoll = false
    const fresh = new Set(backlog.map((d) => d.messageId))
    for (const r of rows) {
      // Only a turn the inbox held at launch, and not yet handed over in
      // this life, is re-offered (LaneDeliveryClaims).
      const reoffer = boot && claims.mayReoffer(r.d.messageId)
      if (fresh.has(r.d.messageId) || reoffer) {
        await deliverRaw(r.raw, 'lane-poll', { backlog: boot, reoffer })
      }
      inbox = inboxAdvanceCursor(inbox, r.d.messageId)
    }
    saveInbox()
  } catch (err) {
    if (err instanceof LaneHttpError && (err.status === 401 || err.status === 403)) await sessionRefused('lanes/inbound')
    else log(`poll failed: ${err instanceof LaneHttpError ? err.status : String(err)}`)
  } finally {
    polling = false
  }
}

/** One history read, retried a few times (LANE_HISTORY_READ_ATTEMPTS); undefined when the server could not answer. */
async function readHistory(path: string, messageId: number): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await laneFetch('GET', path, undefined, { timeoutMs: LANE_HISTORY_READ_TIMEOUT_MS })
    } catch (err) {
      const why = err instanceof LaneHttpError ? err.status : String(err)
      if (attempt >= LANE_HISTORY_READ_ATTEMPTS) {
        log(`the server could not say whether backlog turn ${messageId} was answered (${why})`)
        return undefined
      }
      await new Promise((r) => setTimeout(r, LANE_HISTORY_RETRY_MS * attempt))
    }
  }
}

/**
 * Which of these backlog rows were already ANSWERED, by the server's record
 * (0.71.2), and the latest `/new` she sent that was performed. A row is
 * answered when the server shows it acknowledged (an agent picked it up) AND
 * either an agent answered it after (an agent row that is not one of the
 * lane's fixed notices: the backend's reply hook acks for those too) or it is
 * a command the lane performs itself (`/new`, `/model x`, `/effort x`), so an
 * acknowledged one is not performed twice. A row whose state the server
 * cannot give is offered as before; an acknowledged row whose answer it
 * cannot give is kept out, never re-answered. Two reads per row at most,
 * rows in parallel: at most 30 s in all, only when the route fails or hangs,
 * and a refusal here never ends the lane.
 */
async function answeredAtServer(backlog: LaneDelivery[]): Promise<{ answered: Set<number>; newFrom: number }> {
  const answered = new Set<number>()
  let newFrom = 0
  await Promise.all(backlog.map(async (d) => {
    const page = await readHistory(laneHistoryPathFor(d), d.messageId)
    if (page === undefined) return
    if (laneHistoryDeliveryState(page, d.messageId) !== LANE_SERVER_ACKNOWLEDGED) return
    const route = routeLaneSlash(d.raw as Record<string, unknown>)
    if (route.kind === 'new' || ((route.kind === 'model' || route.kind === 'effort') && route.commandArgs !== '')) {
      answered.add(d.messageId)
      if (route.kind === 'new') newFrom = Math.max(newFrom, d.messageId)
      return
    }
    const after = await readHistory(laneHistoryAfterPathFor(d), d.messageId)
    if (after === undefined || laneHistoryAnsweredAfter(after, d.messageId, LANE_NOTICE_SENTENCES) !== false) answered.add(d.messageId)
  }))
  return { answered, newFrom }
}

function frameIsMine(frame: unknown): boolean {
  const f = (frame ?? {}) as Record<string, unknown>
  return f.actorUserId === LANE.userId && String(f.assistantId) === String(LANE.assistantId)
}

function connectSocket(): void {
  socket = socketIoClient(CFG.backendUrl, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2_000,
    reconnectionDelayMax: 30_000,
    // The lane session ALONE: a socket that also presents a pairing token,
    // an API key or a user id is refused by the server (a lane never holds
    // the credential that acts as the owner).
    // P5: and `lane_memory_rpc`, declared in THIS socket's own handshake,
    // which is what the server routes the person's memory frames by.
    auth: (cb: (auth: Record<string, unknown>) => void) => cb({ laneSession: session?.sessionToken ?? '', capabilities: [LANE_MEMORY_RPC_TOKEN] }),
  })
  socket.on('connect', () => {
    log('lane socket connected')
    void poll()
  })
  socket.on('disconnect', (reason) => {
    log(`lane socket disconnected (${reason})`)
    // The server cut us (revoke, a refused session): check the session now.
    if (reason === 'io server disconnect' && !ending) {
      void laneFetch('GET', 'integrations/lanes/me').then(
        (me) => {
          if (!laneMeMatches(me, LANE)) endLane('identity')
          else socket?.connect()
        },
        async (err) => {
          if (err instanceof LaneHttpError && (err.status === 401 || err.status === 403)) await sessionRefused('lanes/me')
          if (!ending) socket?.connect()
        },
      )
    }
  })
  socket.on('connect_error', (err) => log(`lane socket connect error: ${err?.message ?? String(err)}`))
  socket.on('inbound_message', (payload: unknown) => {
    void deliverRaw(payload, 'lane-socket').catch((err) => log(`socket delivery failed: ${String(err)}`))
  })
  socket.on('lane_revoked', (frame: unknown) => {
    if (frameIsMine(frame)) endLane('revoked')
  })
  socket.on('lane_refresh_ticket', (frame: unknown) => {
    if (!frameIsMine(frame)) return
    const ticket = (frame as { laneTicket?: unknown }).laneTicket
    if (typeof ticket === 'string' && ticket.length > 0 && ticket.length <= 200) {
      void mintWithTicket(ticket).then((ok) => log(ok ? 'lane session refreshed' : 'lane session refresh failed'))
    }
  })
  socket.on('lane_policy_changed', (frame: unknown) => {
    // The frame is a nudge and carries no policy (its `v` is the shape's
    // version): read the policy the session's share has now.
    if (!frameIsMine(frame)) return
    log('lane policy changed; reading the share\'s policy')
    void readPolicyNow('lane_policy_changed')
  })
  socket.on('memory_rpc', (payload: unknown) => {
    const sorted = classifyMemoryFrame(payload)
    if (sorted.kind !== 'person') {
      log(`memory_rpc dropped: ${sorted.kind === 'owner' ? 'not stamped for a person' : sorted.why}`)
      return
    }
    void laneMemory.handle(sorted.frame).catch((err) => log(`memory_rpc failed: ${String(err)}`))
  })
}

async function heartbeat(): Promise<void> {
  if (ending || !session) return
  try {
    const answer = await laneFetch('POST', 'integrations/lanes/heartbeat', errorCode ? { errorCode } : {})
    // The catch up a lost `lane_policy_changed` needs. No policy in the
    // answer (a database error on the server) means keep the launch flags.
    const policy = heartbeatToolPolicy(answer)
    if (policy) onPolicy(policy, 'heartbeat')
  } catch (err) {
    if (err instanceof LaneHttpError && (err.status === 401 || err.status === 403)) await sessionRefused('lanes/heartbeat')
  }
}

// The login watch (K2). Under the person's own token a refused token is a
// notice and a stop, never a retry on anyone else's login. Two signals: the
// CLI's debug log names a token refused at startup (with one, the session
// comes up with its channels off and never takes a turn, so no transcript is
// written; measured on 2.1.302), and the transcript names a sign in refused
// mid session (lib/claude-login.ts).
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR !== ''
  ? process.env.CLAUDE_CONFIG_DIR
  : join(HOME, '.claude')
const loginWatcher = new ClaudeLoginWatcher(CFG.workDir, CLAUDE_HOME)
const CLAUDE_DEBUG_PATH = join(CFG.laneDir, 'claude-debug.log')

// A refused token shows at startup; the debug log is read only in this
// window, and only its tail (security review finding 6).
const TOKEN_CHECK_WINDOW_MS = 5 * 60_000
const DEBUG_TAIL_BYTES = 262_144
const DAEMON_STARTED_AT_MS = Date.now()
function debugLogTail(): string {
  let fd: number | null = null
  try {
    const size = statSync(CLAUDE_DEBUG_PATH).size
    const length = Math.min(size, DEBUG_TAIL_BYTES)
    const buf = Buffer.alloc(length)
    fd = openSync(CLAUDE_DEBUG_PATH, 'r')
    readSync(fd, buf, 0, length, size - length)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* closed */ }
  }
}

/** The person's chats a notice belongs in: the turns this lane holds, else its own inbox. */
async function noticeChatIds(): Promise<number[]> {
  const ids = new Set<number>([...inFlightChats, ...inbox.pending.map((p) => p.chatId)].map(Number))
  if (ids.size === 0) {
    try {
      const nowMs = Date.now()
      for (const raw of await fetchLaneInbound(inboxPollFrom(inbox))) {
        const gate = laneDeliveryGate(raw, LANE)
        if (!gate.deliver) continue
        const at = gate.delivery.createdAt ? Date.parse(gate.delivery.createdAt) : NaN
        if (gate.delivery.chatKind === 'main' && Number.isFinite(at) && nowMs - at <= 24 * 60 * 60_000) ids.add(Number(gate.delivery.chatId))
      }
    } catch (err) {
      log(`notice chats unreadable: ${err instanceof LaneHttpError ? err.status : String(err)}`)
    }
  }
  return [...ids].filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 5)
}

let loginFailed = false
async function loginRefused(where: string): Promise<void> {
  if (loginFailed) return
  loginFailed = true
  errorCode = 'claude_login_expired'
  log(`Claude refused this lane's sign in (${where})`)
  void heartbeat()
  if (CFG.loginMode === LANE_LOGIN_OWN_TOKEN) {
    appendEvent({ event: 'notice', notice: 'login_token_failed', chatIds: await noticeChatIds() })
    endLane('login_failed')
  }
}

function checkLogin(): void {
  if (CFG.loginMode === LANE_LOGIN_OWN_TOKEN && Date.now() - DAEMON_STARTED_AT_MS < TOKEN_CHECK_WINDOW_MS && debugLogSaysTokenRefused(debugLogTail())) {
    void loginRefused('debug log')
    return
  }
  const signal = loginWatcher.scan(Date.now())
  if (!signal) return
  if (signal.type === 'activity') {
    if (!loginFailed) errorCode = null
    return
  }
  void loginRefused('transcript')
}

function tick(): void {
  if (inFlight && inFlightSinceMs !== null && Date.now() - inFlightSinceMs > Math.min(LANE_TURN_STUCK_MS, 15 * 60_000)) {
    // A turn that never replied stops counting as in flight, so the lane can
    // still go idle.
    inFlightChats.clear()
    inFlight = false
    inFlightSinceMs = null
    writeLaneState()
  }
  if (existsSync(STOP_REQUEST_PATH) && !ending) {
    // The supervisor or the owner's daemon asked; stop serving at once.
    ending = true
    shutdown(0)
  }
}

const transport = new StdioServerTransport()
transport.onclose = () => shutdown(0)
await mcp.connect(transport)
claudeReady.start()
process.stdin.on('end', () => shutdown(0))
log(`lane daemon up for person ${LANE.userId} on agent ${LANE.assistantId} (login ${CFG.loginMode || 'unknown'})`)
writeLaneState()

function startLoops(): void {
  connectSocket()
  timers.push(setInterval(() => void poll(), 30_000))
  timers.push(setInterval(() => void heartbeat(), 60_000))
  timers.push(setInterval(checkLogin, 5_000))
  timers.push(setInterval(tick, 5_000))
  void heartbeat()
}

if (!(await ensureSession())) {
  log('no lane session and no ticket; the lane cannot reach HOAI')
  endLane('no_session')
} else {
  try {
    const me = await laneFetch('GET', 'integrations/lanes/me')
    if (!laneMeMatches(me, LANE)) endLane('identity')
    else {
      startLoops()
      const policy = laneMePolicy(me, LANE)
      if (policy) onPolicy(policy, 'boot')
      void reportModelAndEffort()
    }
  } catch (err) {
    if (err instanceof LaneHttpError && (err.status === 401 || err.status === 403)) await sessionRefused('lanes/me')
    else log(`lanes/me failed: ${err instanceof LaneHttpError ? err.status : String(err)}`)
    if (!ending) startLoops()
  }
}
