/**
 * One agent (one daemon and its CLI session) on a home of its own, wired as server.ts wires its private turns: the
 * real forwarder (bin/hoai-hook.mjs), the real private turn hook (bin/hoai-private-turn-hook.mjs), a real intake
 * (lib/hook-intake.ts), buildInboundChannel, privateActor, emailSendBasis, privateFireKey, the fire ledger on disk,
 * the tracker as server.ts:9146 builds it (owner, marker paths, ledger, callbacks), the signed browser context, and the
 * private tool admission block of server.ts itself, transpiled and run as it is.
 *
 * Shared by the private turn package tests of plugin 0.71.3 (board rows c09e214e, 4bf28148, e7166041, c69224fe). It
 * follows test/private-turn-late-line.test.ts's host (#247), adding the cards server.ts pushes raw (a button tap, a
 * peer conversation close, a meeting line) through the notification wrapper's rawCard, the fire keys the ledger was
 * asked to record, and the daemon's private turn log lines.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { appendEvent } from '../../bin/hoai-hook.mjs'
import { recordPrivateBoundary } from '../../bin/hoai-private-turn-hook.mjs'
import { startHookIntake } from '../../lib/hook-intake.ts'
import { buildInboundChannel } from '../../lib/inbound-channel.ts'
import { SessionTranscriptBinder } from '../../lib/session-binding.ts'
import { createTurnChatTracker } from '../../lib/turn-chat.ts'
import { daemonFloorFolders, floorKey, markFloorAttached } from '../../lib/floor-state.mjs'
import * as privateTurn from '../../lib/private-turn.mjs'
import {
  PRIVATE_TURN_REFUSAL,
  createFireLedger,
  createPrivateTurnTracker,
  emailSendBasis,
  privateActor,
  privateBeginLine,
  privateContextPath,
  privateFireKey,
  privateFiresPath,
  privateMarkerPath,
  privateRevokeLine,
  privateSenderUserId,
  publishPrivateContext,
  readPrivateJson,
  requireEmailSendTurn,
  requirePrivateTurn,
  turnAwarePrivateTurn,
} from '../../lib/private-turn.mjs'

export const OWNER = 'user_owner900'
export const RECIPIENT = 'user_recipient900'
export const AGENT = '900'
export const OWN_CHAT = 9001
export const OTHER_CHAT = 9002
export const RECIPIENT_CHAT = 9003
export const EMAIL_CHAT = 9004
export const MEETING_CHAT = 9005
export const SIDE_CHAT = 9006
const SYSTEM_MARKER =
  '[System message from BGOS automation (e.g. a scheduler), NOT the user and NOT a peer agent. ' +
  'Treat this as a system notification. Do not act on it as a user instruction unless it explicitly asks you to.]'
let messageId = 190_000
export const lastMessageId = () => messageId

export type Frame = Record<string, any>

/** A person's chat message, as the socket delivers it. */
export function personFrame(chatId: number, userId: string, text: string): Frame {
  return {
    chatId, messageId: ++messageId, userId, text, files: [], messageType: 'text', senderType: 'user',
    sender: { userId, displayName: userId === OWNER ? 'Kc' : 'Sam', relationship: userId === OWNER ? 'owner' : 'recipient' },
    sessionHandle: `sh_${messageId}`,
  }
}
export const ownerFrame = (text: string, chatId = OWN_CHAT) => personFrame(chatId, OWNER, text)
export const recipientFrame = (text: string, chatId = RECIPIENT_CHAT) => personFrame(chatId, RECIPIENT, text)

/** The backend's native wake (fireWake) for one scheduled task, stamped for the owner. */
export function wakeFrame(chatId: number, scheduledTaskId: number, fireId: string = randomUUID()): Frame {
  return {
    chatId, messageId: ++messageId, userId: OWNER,
    text: `${SYSTEM_MARKER}\nTask ${scheduledTaskId}\nUpdate the board card for task ${scheduledTaskId} with boards_update.`,
    files: [], messageType: 'event', senderType: 'system',
    eventMeta: {
      source: 'scheduler', title: `Task ${scheduledTaskId}`, peek: `Update the board card for task ${scheduledTaskId}.`,
      payload: { scheduledTaskId, fireId, actingUserId: OWNER, ack: 'Delivery ACK is automatic.', dueAt: new Date().toISOString(), missedCount: 1 },
    },
    sender: { userId: OWNER, displayName: 'Kc', relationship: 'owner' },
    sessionHandle: `sh_${messageId}`,
  }
}
/** A peer agent's message (its agentOrigin), in the side thread chat the backend opens for the two agents. */
export function peerFrame(text: string, chatId = SIDE_CHAT): Frame {
  return { chatId, messageId: ++messageId, userId: OWNER, text, files: [], messageType: 'text', senderType: 'agent', agentOrigin: { sourceAssistantId: 901, sourceName: 'Ares' }, sessionHandle: `sh_${messageId}` }
}
/** An email from outside (senderType external_email): no person, no reason to send. */
export function emailFrame(text: string): Frame {
  return { chatId: EMAIL_CHAT, messageId: ++messageId, userId: 'external_email', text, files: [], messageType: 'text', senderType: 'external_email', sessionHandle: `sh_${messageId}` }
}

/** Another agent's follow up in a room (#250, senderType room_agent): no person, no reason to send. */
export function roomAgentFrame(text: string, chatId = OWN_CHAT): Frame {
  return { chatId, messageId: ++messageId, userId: OWNER, text, files: [], messageType: 'text', senderType: 'room_agent', sessionHandle: `sh_${messageId}` }
}

/** claude 2.1.296 and later: <channel source="bgos" k="v"...>\ncontent\n</channel>. */
export function renderChannel(content: string, meta: Record<string, string> = {}): string {
  const esc = (v: unknown) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  const attrs = Object.entries(meta).filter(([k]) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)).map(([k, v]) => ` ${k}="${esc(v)}"`).join('')
  return `<channel source="bgos"${attrs}>\n${content.replace(/<\/channel/gi, '<\\channel')}\n</channel>`
}

// ── server.ts private tool admission, run as it is ──────────────────────────
const source = readFileSync('server.ts', 'utf8')
const admissionStart = source.indexOf('  // Freeze private authority at request admission')
const admissionSource = source.slice(admissionStart, source.indexOf('  return trackMessageOperation(async () => {', admissionStart))
assert.ok(admissionStart > 0 && admissionSource.includes('requireEmailSendTurn'), 'the admission block of server.ts was found')
const admissionJs = ts.transpileModule(`${admissionSource}\nreturn { privateCall, emailSendReason };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

/** One UserPromptSubmit (or Stop) as two steps the test orders: mark() the synchronous hook, spool() the forwarder line. */
export interface Submission { mark: () => void; spool: () => void }

export function agentHost(t: any) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-privturn-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'home', '.bgos-plugin-state')
  const claudeHome = join(base, 'home', '.claude')
  const folder = join(base, 'agents', 'data')
  mkdirSync(folder, { recursive: true })
  const projectDir = new SessionTranscriptBinder(folder, { claudeHome }).projectDirectory
  mkdirSync(projectDir, { recursive: true })
  const session = randomUUID()
  const transcript = join(projectDir, `${session}.jsonl`)
  writeFileSync(transcript, '')
  const hookEnv = { BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: folder }
  const folders = daemonFloorFolders({ launchCwd: folder, cwd: folder, env: { CLAUDE_PROJECT_DIR: folder } })
  const markerPaths = [...new Set(folders.map((f: string) => floorKey(f)))].map((key) => privateMarkerPath(root, key))
  const contextPath = privateContextPath(root, AGENT)
  const firesPath = privateFiresPath(root, AGENT)
  /** The daemon's private turn log lines, as server.ts writes them (begin, revoke, replay, ended). */
  const lines: string[] = []
  /** Every fire key the tracker asked the ledger to record, in order, across daemon lives. */
  const recorded: string[] = []

  let lives = 0
  function daemon() {
    // Each daemon life attaches anew, as server.ts does at its start: a new `at`.
    markFloorAttached({ root, folders, projectDir, now: Date.now() + ++lives })
    const ledger = createFireLedger({ path: firesPath })
    let publish = () => {}
    // Built as server.ts:9146 builds it; the callbacks log as server.ts logs, and a revoke republishes the context.
    const options: Record<string, unknown> = {
      ownerUserId: OWNER, markerPaths,
      fires: { handledAt: (key: string) => ledger.handledAt(key), record: (key: string) => { recorded.push(key); return ledger.record(key) } },
      onRevoke: (info: any) => { lines.push(privateRevokeLine(info)); publish() },
      onReplay: (replay: any) => lines.push((privateTurn as any).privateReplayLine(replay)),
    }
    if (typeof (privateTurn as any).privateEndedLine === 'function') options.onEnded = (info: any) => lines.push((privateTurn as any).privateEndedLine(info))
    const tracker = createPrivateTurnTracker(options as any)
    const turnChat = createTurnChatTracker()
    publish = () => {
      publishPrivateContext({
        path: contextPath, secret: `pair_${AGENT}`, assistantId: AGENT, ownerUserId: OWNER,
        claudePid: process.pid, turn: tracker.current({ markerPaths }),
      })
    }
    const intake = startHookIntake({
      stateRoot: root, projectDir, baseDir: folder, isArmed: () => true,
      // server.ts onHookPayload's private turn statements, then the publish it ends with.
      onEvent: (payload) => {
        const hookSessionId = String(payload.session_id ?? '').trim()
        if (payload.hook_event_name === 'SessionEnd') tracker.end()
        if (payload.hook_event_name === 'UserPromptSubmit') {
          const began = tracker.begin({ prompt: payload.prompt, promptHash: payload.hoai_clipped === true ? payload.prompt_sha256 : undefined, sessionId: hookSessionId, promptId: payload.prompt_id })
          const matched = turnChat.matchDelivered(String(payload.prompt ?? ''))
          if (began !== 'repeat' && began !== 'replayed' && (began !== 'no-token' || matched !== null)) lines.push(privateBeginLine(began, hookSessionId))
        }
        if (payload.hook_event_name === 'Stop') tracker.end()
        publish()
      },
      provesDelivery: (prompt) => turnChat.matchDelivered(prompt) !== null,
      provenTranscript: () => transcript,
      watch: () => null, setIntervalFn: () => ({}), clearIntervalFn: () => {},
    })
    t.after(() => intake.stop())
    return { tracker, turnChat, intake, publish }
  }

  let life = daemon()
  const payloadOf = (event: string, extra: Record<string, unknown> = {}) =>
    ({ session_id: session, transcript_path: transcript, cwd: folder, hook_event_name: event, permission_mode: 'bypassPermissions', ...extra })

  const host = {
    session, markerPaths, lines, recorded, firesPath, root,
    get tracker(): any { return life.tracker },
    /** A lane delivers a frame (server.ts deliverWsInbound): actor, reason to send, fire key. The card the CLI gets. */
    card(frame: Frame, opts: { backlog?: boolean } = {}): string {
      const senderType = String(frame.senderType ?? 'user')
      const agentOrigin = frame.agentOrigin ?? null
      const channel = buildInboundChannel({
        chatId: frame.chatId, messageId: frame.messageId, userId: privateSenderUserId(frame) ?? OWNER, assistantId: AGENT,
        transport: 'ws', text: frame.text, files: frame.files, senderType, agentOrigin, serverSender: frame,
      })
      life.turnChat.note({ chatId: frame.chatId, messageId: frame.messageId, kind: senderType === 'system' ? 'system' : 'user', text: frame.text, now: Date.now() })
      const content = life.tracker.deliver({
        content: channel.content, chatId: frame.chatId,
        peerSourceAssistantId: agentOrigin?.sourceAssistantId ?? null,
        emailBasis: emailSendBasis({ senderType, agentOrigin, eventMeta: frame.eventMeta, messageId: frame.messageId, backlog: opts.backlog === true }),
        fireKey: privateFireKey({ senderType, eventMeta: frame.eventMeta, messageId: frame.messageId }),
        actingUserId: privateActor({ senderType, senderUserId: privateSenderUserId(frame), agentOrigin, eventMeta: frame.eventMeta }),
      })
      return renderChannel(content, channel.meta)
    },
    /**
     * A channel card server.ts pushes without deliver(): the notification wrapper (server.ts:9150) hands it to rawCard
     * with its meta. The card the CLI gets.
     */
    raw(content: string, meta: Record<string, string> = {}): string {
      life.tracker.rawCard(content, meta)
      return renderChannel(content, meta)
    },
    /** A button tap card, as server.ts's poll and boot sweep announce one with no delivery: noteTap's tag on its end. */
    tap(tapperUserId: string | null, text = 'Yes, go ahead', chatId = OWN_CHAT): string {
      const tag = life.tracker.noteTap({ chatId: String(chatId), tapperUserId }) ?? ''
      const meta: Record<string, string> = {
        chat_id: String(chatId), message_id: String(messageId), event_type: 'button_clicked', callback_data: 'yes',
        button_text: text, user: 'User', ...(tapperUserId ? { user_id: tapperUserId } : {}), assistant_id: AGENT, ts: new Date().toISOString(),
      }
      return host.raw(`[button_clicked] Clicked: ${text}\n(in reply to message_id=${messageId})${tag}`, meta)
    },
    /**
     * A button tap as one of server.ts's three tap sites announces it (the boot sweep, the poll, the stream): the card's
     * content through the lane's private tap rule (privateTapCard, 4bf28148; on a build without it, noteTap's tag as
     * every site did), then the notification wrapper's rawCard with its meta. The card the CLI gets.
     */
    laneTap(opts: { lane: 'boot' | 'poll' | 'stream', tapperUserId: string | null, answeredAt?: unknown, receivedAt?: number, messageId?: number, chatId?: number, text?: string }): string {
      const chatId = opts.chatId ?? OWN_CHAT
      const tapped = opts.messageId ?? ++messageId
      const content = `[button_clicked] Clicked: ${opts.text ?? 'Yes, go ahead'}\n(in reply to message_id=${tapped})\nOriginal question: Shall I archive the launch card?`
      const tapCard = (privateTurn as any).privateTapCard ?? ((input: any) => input.content + input.tracker.noteTap({ chatId: input.chatId, tapperUserId: input.tapperUserId }))
      const card = tapCard({
        tracker: life.tracker, lane: opts.lane, ownerUserId: OWNER, chatId: String(chatId), messageId: tapped,
        tapperUserId: opts.tapperUserId, answeredAt: 'answeredAt' in opts ? opts.answeredAt : new Date().toISOString(), receivedAt: opts.receivedAt ?? Date.now(), content,
      })
      const meta: Record<string, string> = {
        chat_id: String(chatId), message_id: String(tapped), event_type: 'button_clicked', callback_data: 'yes', button_text: opts.text ?? 'Yes, go ahead',
        user: 'User', ...(opts.tapperUserId ? { user_id: opts.tapperUserId } : {}), assistant_id: AGENT, ts: new Date().toISOString(),
      }
      life.tracker.rawCard(card, meta)
      return renderChannel(card, meta)
    },
    /** server.ts's peer_conversation_closed card (server.ts:14596): the backend's fixed reason, no peer's words. */
    peerClose(reason = 'completed', conversationId = 4411): string {
      return host.raw(
        `[peer_conversation_closed] reason=${reason}\n(conversation_id=${conversationId}, closed_by=901)\nSend to this peer again to start a new conversation.`,
        { event_type: 'peer_conversation_closed', conversation_id: String(conversationId), reason, user_id: OWNER, assistant_id: AGENT, transport: 'ws' },
      )
    },
    /** server.ts's reply-overdue card (server.ts:8567): the daemon's own words. */
    replyOverdue(chatId = OWN_CHAT, repliedTo = messageId): string {
      return host.raw(
        `[reply-overdue] Message in chat_id=${chatId} (message_id=${repliedTo}) arrived 241s ago and no reply has been sent yet. ` +
          'If you intended to respond, call the `reply` tool now. If you intended to stay silent, ignore this notification.',
        { event_type: 'reply_overdue', chat_id: String(chatId), message_id: String(repliedTo), age_seconds: '241', ts: new Date().toISOString() },
      )
    },
    /** A meeting line, noted with the tracker first, as server.ts serves one. */
    meeting(text: string): string {
      const tag = life.tracker.noteUntracked({ chatId: String(MEETING_CHAT) }) ?? ''
      return host.raw(`[Meeting #77] Sam: ${text}${tag}`, { event_type: 'meeting_message', meeting_id: '77', chat_id: String(MEETING_CHAT) })
    },
    /** The CLI's UserPromptSubmit for one prompt (its own prompt_id); nothing runs until mark() or spool(). */
    prompt(prompt: string): Submission {
      const payload = payloadOf('UserPromptSubmit', { prompt_id: randomUUID(), prompt })
      return { mark: () => { recordPrivateBoundary(payload, hookEnv) }, spool: () => { appendEvent(payload, { env: hookEnv }) } }
    },
    /** A prompt whose hook and line both ran in time: marked, spooled, drained. */
    submit(prompt: string) { const sub = host.prompt(prompt); sub.mark(); sub.spool(); host.pump() },
    /** The CLI ends the turn: the hook closes the marker, the forwarder spools Stop, the daemon drains. */
    stop() { const stop = host.stopping(); stop.mark(); stop.spool(); host.pump() },
    stopping(): Submission {
      const payload = payloadOf('Stop', { stop_hook_active: false })
      return { mark: () => { recordPrivateBoundary(payload, hookEnv) }, spool: () => { appendEvent(payload, { env: hookEnv }) } }
    },
    pump() { life.intake.pump() },
    /** The 1 s tick and every hook line republish the signed context (server.ts:15816, :9822). */
    tick() { life.publish() },
    /** A new daemon process; the CLI resumes the same session. */
    restart() {
      life.intake.stop()
      life = daemon()
      appendEvent(payloadOf('SessionStart', { source: 'resume' }), { env: hookEnv })
      host.pump()
    },
    /** The signed context the Agent Browser verifies: who it acts for, if live. */
    browser(): string {
      life.publish()
      const signed = readPrivateJson(contextPath, 8192)
      const context = signed?.context
      if (!context?.live) return 'nobody'
      return context.actingUserId === OWNER ? 'owner' : String(context.actingUserId)
    },
    /** The signed context as the daemon last wrote it, read WITHOUT publishing: who the Agent Browser acts for now. */
    published(): string {
      const context = readPrivateJson(contextPath, 8192)?.context
      if (!context?.live) return 'nobody'
      return context.actingUserId === OWNER ? 'owner' : String(context.actingUserId)
    },
    explain(): string { return life.tracker.explain({ markerPaths }) },
  }
  return host
}
export type Host = ReturnType<typeof agentHost>

/**
 * The model calls a private tool: server.ts's admission block, run as it is, with this daemon's tracker. A refusal
 * comes back as Promise.resolve({ isError }), an admitted call as the frozen privateCall and email_send reason.
 */
export async function admit(host: Host, name: string): Promise<{ refused: string } | { actsFor: string; reason: unknown }> {
  const result = new Function(
    'req', 'lockHeld', 'privateTurns', 'PRIVATE_MARKER_PATHS', 'PRIVATE_HOOK', 'PRIVATE_HOOK_MISSING_REFUSAL', 'USER_ID', 'log',
    'requirePrivateTurn', 'turnAwarePrivateTurn', 'requireEmailSendTurn', 'PRIVATE_TURN_REFUSAL', 'recordPeerRefusal', 'pathDirname',
    'CURSOR_FILE_PATH', 'ASSISTANT_ID', admissionJs,
  )(
    { params: { name } }, true, host.tracker, host.markerPaths, { registered: true }, 'hook missing', OWNER, () => {},
    requirePrivateTurn, turnAwarePrivateTurn, requireEmailSendTurn, PRIVATE_TURN_REFUSAL, () => ({ line: '' }), () => '/s',
    '/s/c', AGENT,
  )
  if (typeof result?.then === 'function') {
    const settled = await result
    assert.equal(settled?.isError, true, `${name}: a refusal`)
    return { refused: String(settled.content[0].text) }
  }
  if (result.privateCall) return { actsFor: result.privateCall.headers?.['X-BGOS-Acting-User'] ?? 'owner', reason: result.emailSendReason }
  assert.ok(result.emailSendReason, `${name}: admitted with a reason`)
  return { actsFor: 'owner', reason: result.emailSendReason }
}

/** Who a private tool acts for: 'owner' (no acting user header), the header's person, or 'refused: <text>'. */
export async function actsFor(host: Host, name: string): Promise<string> {
  const answer = await admit(host, name)
  return 'refused' in answer ? `refused: ${answer.refused}` : answer.actsFor
}

export const GATED = ['boards_update', 'schedule', 'list_schedules']
export const TURN_AWARE = ['call_owner', 'list_chats', 'create_mission']

/** What email_send is admitted with: the owner's reason (askOwner when it must ask), or 'refused: <text>'. */
export async function sendAdmitted(host: Host): Promise<unknown> {
  const answer = await admit(host, 'email_send')
  return 'refused' in answer ? `refused: ${answer.refused}` : answer.reason
}

/** The owner's own turn works: every tool acts as the owner, and email_send names this turn's reason. */
export async function assertOwnerTurn(host: Host, label: string, reason?: Record<string, unknown>) {
  for (const name of [...GATED, ...TURN_AWARE]) assert.equal(await actsFor(host, name), 'owner', `${label}: ${name}; explain: ${host.explain()}`)
  assert.equal(host.browser(), 'owner', `${label}: the Agent Browser acts as the owner; explain: ${host.explain()}`)
  if (reason) assert.deepEqual(await sendAdmitted(host), reason, `${label}: email_send names this turn's reason`)
}

/** Boards, schedule and the browser refuse ("sender could not be verified"); the turn aware tools act as the owner. */
export async function assertGatedClosed(host: Host, label: string) {
  for (const name of GATED) assert.equal(await actsFor(host, name), `refused: ${PRIVATE_TURN_REFUSAL}`, `${label}: ${name}`)
  assert.equal(host.browser(), 'nobody', `${label}: the Agent Browser has no live context`)
  for (const name of TURN_AWARE) assert.equal(await actsFor(host, name), 'owner', `${label}: ${name} keeps #233's rule (no person reached the turn)`)
}

/** Each key was asked of the ledger exactly once, and it is on disk. */
export function assertRecordedOnce(host: Host, keys: string[], label: string) {
  for (const key of keys) {
    assert.equal(host.recorded.filter((k) => k === key).length, 1, `${label}: ${key} recorded exactly once (recorded: ${JSON.stringify(host.recorded)})`)
    assert.equal(typeof readPrivateJson(host.firesPath, 262144)?.fires?.[key], 'number', `${label}: ${key} is in the ledger`)
  }
}

/** The fire ledger on disk: `{ <key>: <handled at ms> }`. */
export function readFiresOf(host: Host): Record<string, number> {
  return readPrivateJson(host.firesPath, 262144)?.fires ?? {}
}
