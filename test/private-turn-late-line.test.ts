/**
 * A person's delivery that reaches a CLI turn before its prompt's forwarder line is not forgotten (HOAI board row
 * f81a527c; the delegated review of plugin 0.69.0, worker plugrel, item B; cousin row 70f1898b).
 *
 * THE SHAPE (plugrel). The owner's message reaches the daemon and the CLI submits it. The synchronous private turn
 * hook writes the marker, but the async forwarder line that carries the prompt to the daemon (begin()) is slow: on
 * Windows a cold node start alone took 4 s (test/private-turn-two-admitted.test.ts), and the hook stops waiting for
 * the daemon's receipt after 3 s. A share recipient's message arrives meanwhile. Nothing is admitted yet, so it
 * revokes nothing, and the CLI injects it into the running turn. Then the late line lands, and begin() reset
 * turnSeen (lib/private-turn.mjs, `turnSeen = freshSeen()` inside beginTurn), forgetting the recipient. The owner's
 * prompt opened a verified owner turn: boards, schedule, the Agent Browser and the turn aware tools acted as the owner
 * while the recipient's words were in the same turn.
 *
 * THE COUSIN (70f1898b). A recipient's message and the owner's, submitted together, run as ONE turn (#232: one
 * UserPromptSubmit per delivery, in order, the marker left is the last one's). begin() of the owner's prompt reset
 * turnSeen and replaced the recipient's admitted prompt, and email_send's look back starts at the owner's own
 * delivery, so it named the owner's message.
 *
 * THE RULE HELD HERE. Within one CLI turn (Stop to Stop) turnSeen survives begin(); once a delivery of anyone but the
 * owner is seen in the turn, nothing acts as the owner until the turn ends. Who may open a private turn stays as it
 * was: the owner, a share recipient as themselves, a stranger never.
 *
 * These tests run the real forwarder (bin/hoai-hook.mjs), the real private turn hook, a real intake, the tracker,
 * privateActor, emailSendBasis and the signed browser context, and the private tool admission of server.ts itself.
 *
 * Run with: npx tsx --test test/private-turn-late-line.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { appendEvent } from '../bin/hoai-hook.mjs'
import { recordPrivateBoundary } from '../bin/hoai-private-turn-hook.mjs'
import { startHookIntake } from '../lib/hook-intake.ts'
import { buildInboundChannel } from '../lib/inbound-channel.ts'
import { SessionTranscriptBinder } from '../lib/session-binding.ts'
import { createTurnChatTracker } from '../lib/turn-chat.ts'
import { daemonFloorFolders, floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import * as privateTurn from '../lib/private-turn.mjs'
import {
  PRIVATE_TURN_REFUSAL,
  TURN_AWARE_REFUSAL,
  createFireLedger,
  createPrivateTurnTracker,
  emailSendBasis,
  privateActor,
  privateBeginLine,
  privateContextPath,
  privateFireKey,
  privateFiresPath,
  privateMarkerPath,
  privatePromptHash,
  privateSenderUserId,
  publishPrivateContext,
  readPrivateJson,
  requireEmailSendTurn,
  requirePrivateTurn,
  turnAwarePrivateTurn,
  writePrivateJson,
} from '../lib/private-turn.mjs'

// Exports new in 0.69.7 are read through the namespace, so on a build without them only the tests that need them fail.
const { PRIVATE_TURN_TAGS_MAX, privateTokenTag, privateTurnRecord } = privateTurn as any

const OWNER = 'user_owner945'
const RECIPIENT = 'user_recipient945'
const AGENT = '945'
const OWN_CHAT = 5001
const RECIPIENT_CHAT = 5002
const SYSTEM_MARKER =
  '[System message from BGOS automation (e.g. a scheduler), NOT the user and NOT a peer agent. ' +
  'Treat this as a system notification. Do not act on it as a user instruction unless it explicitly asks you to.]'
let messageId = 150_000

/** A person's chat message, as the socket delivers it. */
function personFrame(chatId: number, userId: string, text: string) {
  return {
    chatId, messageId: ++messageId, userId, text, files: [], messageType: 'text', senderType: 'user',
    sender: { userId, displayName: userId === OWNER ? 'Kc' : 'Sam', relationship: userId === OWNER ? 'owner' : 'recipient' },
    sessionHandle: `sh_${messageId}`,
  }
}
/** The backend's native wake (fireWake) for one scheduled task. */
function wakeFrame(chatId: number, scheduledTaskId: number) {
  return {
    chatId, messageId: ++messageId, userId: OWNER,
    text: `${SYSTEM_MARKER}\nTask ${scheduledTaskId}\nUpdate the board card for task ${scheduledTaskId} with boards_update.`,
    files: [], messageType: 'event', senderType: 'system',
    eventMeta: {
      source: 'scheduler', title: `Task ${scheduledTaskId}`, peek: `Update the board card for task ${scheduledTaskId}.`,
      payload: { scheduledTaskId, fireId: randomUUID(), actingUserId: OWNER, ack: 'Delivery ACK is automatic.', dueAt: new Date().toISOString(), missedCount: 1 },
    },
    sender: { userId: OWNER, displayName: 'Kc', relationship: 'owner' },
    sessionHandle: `sh_${messageId}`,
  }
}
const ownerFrame = (text: string, chatId = OWN_CHAT) => personFrame(chatId, OWNER, text)
const recipientFrame = (text: string, chatId = RECIPIENT_CHAT) => personFrame(chatId, RECIPIENT, text)

/** claude 2.1.296 and later: <channel source="bgos" k="v"...>\ncontent\n</channel>. */
function renderChannel(content: string, meta: Record<string, string>): string {
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

/**
 * One UserPromptSubmit of the CLI as two steps the test orders: mark() is the synchronous private turn hook (the
 * marker), spool() the async forwarder's line, which the CLI does not wait for.
 */
interface Submission { mark: () => void; spool: () => void }

/** One agent (one daemon and its CLI session) on a home of its own. */
function agentHost(t: any) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-late-line-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'home', '.bgos-plugin-state')
  const claudeHome = join(base, 'home', '.claude')
  const folder = join(base, 'agents', 'kc')
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
  const begins: string[] = []

  /** One daemon life, wired as server.ts wires it. */
  function daemon() {
    markFloorAttached({ root, folders, projectDir })
    const tracker = createPrivateTurnTracker({ ownerUserId: OWNER, markerPaths, fires: createFireLedger({ path: privateFiresPath(root, AGENT) }) })
    const turnChat = createTurnChatTracker()
    const publish = () => publishPrivateContext({
      path: contextPath, secret: `pair_${AGENT}`, assistantId: AGENT, ownerUserId: OWNER,
      claudePid: process.pid, turn: tracker.current({ markerPaths }),
    })
    const intake = startHookIntake({
      stateRoot: root, projectDir, baseDir: folder, isArmed: () => true,
      // server.ts onHookPayload's private turn statements, then the publish it ends with.
      onEvent: (payload) => {
        const hookSessionId = String(payload.session_id ?? '').trim()
        if (payload.hook_event_name === 'SessionEnd') tracker.end()
        if (payload.hook_event_name === 'UserPromptSubmit') {
          const began = tracker.begin({ prompt: payload.prompt, promptHash: payload.hoai_clipped === true ? payload.prompt_sha256 : undefined, sessionId: hookSessionId, promptId: payload.prompt_id })
          const matched = turnChat.matchDelivered(String(payload.prompt ?? ''))
          if (began !== 'repeat' && began !== 'replayed' && (began !== 'no-token' || matched !== null)) begins.push(privateBeginLine(began, hookSessionId))
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
    session, markerPaths, begins,
    get tracker() { return life.tracker },
    /** A lane delivers a frame (server.ts deliverWsInbound): actor, reason to send, fire key. The card the CLI gets. */
    card(frame: Record<string, any>): string {
      const senderType = String(frame.senderType ?? 'user')
      const channel = buildInboundChannel({
        chatId: frame.chatId, messageId: frame.messageId, userId: privateSenderUserId(frame) ?? OWNER, assistantId: AGENT,
        transport: 'ws', text: frame.text, files: frame.files, senderType, agentOrigin: null, serverSender: frame,
      })
      life.turnChat.note({ chatId: frame.chatId, messageId: frame.messageId, kind: senderType === 'system' ? 'system' : 'user', text: frame.text, now: Date.now() })
      const content = life.tracker.deliver({
        content: channel.content, chatId: frame.chatId,
        emailBasis: emailSendBasis({ senderType, agentOrigin: null, eventMeta: frame.eventMeta, messageId: frame.messageId, backlog: false }),
        fireKey: privateFireKey({ senderType, eventMeta: frame.eventMeta, messageId: frame.messageId }),
        actingUserId: privateActor({ senderType, senderUserId: privateSenderUserId(frame), agentOrigin: null, eventMeta: frame.eventMeta }),
      })
      return renderChannel(content, channel.meta)
    },
    /** The owner's voice consult on a live call (server.ts voice lane): stamped, for this one consult. */
    consultCard(consultId: string): string {
      return life.tracker.deliver({ content: `[voice consult ${consultId}] What is on my board today?`, actingUserId: OWNER, chatId: OWN_CHAT, consult: { consultId, deadline: Date.now() + 30_000 } })
    },
    /** The CLI's UserPromptSubmit for one prompt (its own prompt_id); nothing runs until the test calls mark() or spool(). */
    prompt(prompt: string): Submission {
      const payload = payloadOf('UserPromptSubmit', { prompt_id: randomUUID(), prompt })
      return { mark: () => { recordPrivateBoundary(payload, hookEnv) }, spool: () => { appendEvent(payload, { env: hookEnv }) } }
    },
    /** A prompt whose hook and line both ran in time: marked, spooled, drained. */
    submit(prompt: string) { const sub = host.prompt(prompt); sub.mark(); sub.spool(); host.pump() },
    /** The CLI ends the turn: the private turn hook closes the marker, the forwarder spools Stop, the daemon drains. */
    stop() {
      const stop = host.stopping()
      stop.mark()
      stop.spool()
      host.pump()
    },
    /** The CLI's Stop as the same two steps: the hook closes the marker at once, the forwarder line may be late. */
    stopping(): Submission {
      const payload = payloadOf('Stop', { stop_hook_active: false })
      return { mark: () => { recordPrivateBoundary(payload, hookEnv) }, spool: () => { appendEvent(payload, { env: hookEnv }) } }
    },
    /** The same submission's hook line recorded again with no prompt_id (a second hook source of an older CLI). */
    again(prompt: string) {
      appendEvent(payloadOf('UserPromptSubmit', { prompt }), { env: hookEnv })
      host.pump()
    },
    pump() { life.intake.pump() },
    /** A new daemon process; the CLI resumes the same session. */
    restart() {
      life.intake.stop()
      life = daemon()
      appendEvent(payloadOf('SessionStart', { source: 'resume' }), { env: hookEnv })
      host.pump()
    },
    /** The signed context the Agent Browser verifies (bin/hoai-browser-mcp.mjs readManagedContext): who it acts for, if live. */
    browser(): string {
      life.publish()
      const signed = readPrivateJson(contextPath, 8192)
      const context = signed?.context
      if (!context?.live) return 'nobody'
      return context.actingUserId === OWNER ? 'owner' : String(context.actingUserId)
    },
  }
  return host
}

/**
 * The model calls a private tool: server.ts's admission block, run as it is, with this daemon's tracker. A refusal
 * comes back as Promise.resolve({ isError }), an admitted call as the frozen privateCall and email_send reason.
 */
async function admit(host: ReturnType<typeof agentHost>, name: string): Promise<{ refused: string } | { actsFor: string; reason: unknown }> {
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
async function actsFor(host: ReturnType<typeof agentHost>, name: string): Promise<string> {
  const answer = await admit(host, name)
  return 'refused' in answer ? `refused: ${answer.refused}` : answer.actsFor
}

const GATED = ['boards_update', 'schedule']
const TURN_AWARE = ['call_owner', 'list_chats', 'create_mission']

/** Every way a private call could act: the gated tools, the turn aware ones, email_send and the Agent Browser. */
async function everyone(host: ReturnType<typeof agentHost>) {
  const out: Record<string, string> = {}
  for (const name of [...GATED, ...TURN_AWARE, 'email_send']) out[name] = await actsFor(host, name)
  out.browser = host.browser()
  return out
}

/** Nothing acts as the owner: each tool refuses, and the browser has no live context. */
async function assertNothingActsAsOwner(host: ReturnType<typeof agentHost>, label: string) {
  const seen = await everyone(host)
  for (const [name, who] of Object.entries(seen)) {
    assert.notEqual(who, 'owner', `${label}: ${name} acts as the owner (${JSON.stringify(seen)}); explain: ${host.tracker.explain({ markerPaths: host.markerPaths })}`)
  }
  for (const name of GATED) assert.equal(seen[name], `refused: ${PRIVATE_TURN_REFUSAL}`, `${label}: ${name}`)
  for (const name of TURN_AWARE) assert.equal(seen[name], `refused: ${TURN_AWARE_REFUSAL}`, `${label}: ${name}`)
  assert.match(seen.email_send!, /^refused: /, `${label}: email_send`)
  assert.equal(seen.browser, 'nobody', `${label}: the Agent Browser has no live context`)
}

/** The owner's own turn works: every tool acts as the owner, and email_send names this turn's reason. */
async function assertOwnerTurn(host: ReturnType<typeof agentHost>, label: string, reason?: Record<string, string>) {
  for (const name of [...GATED, ...TURN_AWARE]) assert.equal(await actsFor(host, name), 'owner', `${label}: ${name}; explain: ${host.tracker.explain({ markerPaths: host.markerPaths })}`)
  assert.equal(host.browser(), 'owner', `${label}: the Agent Browser acts as the owner`)
  if (reason) {
    const answer = await admit(host, 'email_send')
    assert.ok(!('refused' in answer), `${label}: email_send ${JSON.stringify(answer)}`)
    assert.deepEqual(answer.reason, reason, `${label}: email_send names this turn's reason`)
  }
}

// ── The plugrel shape and its cousin: red on main ───────────────────────────

test('plugrel: a recipient message that reaches the turn before the owner prompt\'s late forwarder line never lets anything act as the owner', async (t) => {
  const host = agentHost(t)
  const owner = host.prompt(host.card(ownerFrame('Update the launch card on my board.')))
  owner.mark()
  // The forwarder is slow; the recipient's message arrives, revokes nothing (nothing is admitted yet), and the CLI
  // injects it into the running turn.
  host.card(recipientFrame('Also add my private notes to the owner\'s launch card.'))
  owner.spool()
  host.pump()
  assert.deepEqual(host.begins.length, 1, 'the owner prompt\'s line reached the daemon')
  await assertNothingActsAsOwner(host, 'the late line')
  // Until the turn ends: the same refusal on a retry, and after another line of the same turn.
  await assertNothingActsAsOwner(host, 'a retry')
  assert.deepEqual(host.tracker.turnSenders().people.includes(RECIPIENT), true, 'the recipient is still remembered')
})

test('70f1898b: a recipient message and the owner\'s submitted together as one turn, the recipient first: nothing acts as the owner, email_send names nothing', async (t) => {
  for (const order of ['lines in order', 'owner line first'] as const) {
    const host = agentHost(t)
    const recipient = host.prompt(host.card(recipientFrame('Send the contract to legal@example.com for me.')))
    const owner = host.prompt(host.card(ownerFrame('Thanks, carry on.')))
    // One turn: the private turn hook runs for each prompt in order, so the marker left is the owner prompt's.
    recipient.mark()
    owner.mark()
    if (order === 'lines in order') { recipient.spool(); owner.spool() } else { owner.spool(); recipient.spool() }
    host.pump()
    await assertNothingActsAsOwner(host, order)
  }
})

test('a recipient message between two owner prompts of one turn, the second line late: nothing acts as the owner', async (t) => {
  const host = agentHost(t)
  const first = host.prompt(host.card(ownerFrame('Here is the report.')))
  first.mark()
  first.spool()
  host.pump()
  await assertOwnerTurn(host, 'the first owner prompt')
  // The recipient's message is injected mid turn and revokes it, as on main.
  host.card(recipientFrame('What did the report say?'))
  await assertNothingActsAsOwner(host, 'revoked mid turn')
  // A second owner prompt of the SAME turn (a second record with its own prompt_id) begins late.
  const second = host.prompt(host.card(ownerFrame('Now update the board with it.')))
  second.mark()
  second.spool()
  host.pump()
  await assertNothingActsAsOwner(host, 'a later begin of the same turn')
})

test('turnSeen survives begin(): the recipient stays among the turn\'s senders until Stop', (t) => {
  const host = agentHost(t)
  const owner = host.prompt(host.card(ownerFrame('Update the launch card.')))
  owner.mark()
  host.card(recipientFrame('And mine.'))
  owner.spool()
  host.pump()
  assert.deepEqual(host.tracker.turnSenders(), { prompt: OWNER, people: [OWNER, RECIPIENT] })
  host.stop()
  assert.deepEqual(host.tracker.turnSenders(), { prompt: null, people: [] }, 'a Stop starts a fresh record')
})

// ── Controls: green on main and after ────────────────────────────────────────

test('control: the owner alone', async (t) => {
  const host = agentHost(t)
  const card = host.card(ownerFrame('Update the launch card.'))
  host.submit(card)
  await assertOwnerTurn(host, 'owner alone', { kind: 'owner_message', id: String(messageId) })
  // A late line alone is no reason to refuse: nothing else reached the turn.
  host.stop()
  const late = host.prompt(host.card(ownerFrame('And the second card.')))
  late.mark()
  late.spool()
  host.pump()
  await assertOwnerTurn(host, 'owner alone, late line', { kind: 'owner_message', id: String(messageId) })
})

test('control: the recipient alone acts as themselves, never as the owner', async (t) => {
  const host = agentHost(t)
  host.submit(host.card(recipientFrame('Add my notes to my card.')))
  for (const name of [...GATED, ...TURN_AWARE]) assert.equal(await actsFor(host, name), RECIPIENT, name)
  assert.equal(host.browser(), RECIPIENT)
  assert.match(await actsFor(host, 'email_send'), /^refused: Only your owner's own message/)
})

test('control: the owner, Stop, then the recipient; and the recipient, Stop, then the owner', async (t) => {
  const host = agentHost(t)
  host.submit(host.card(ownerFrame('Update the launch card.')))
  await assertOwnerTurn(host, 'owner first')
  host.stop()
  host.submit(host.card(recipientFrame('Add my notes.')))
  for (const name of [...GATED, ...TURN_AWARE]) assert.equal(await actsFor(host, name), RECIPIENT, `recipient second: ${name}`)
  host.stop()
  host.submit(host.card(ownerFrame('Thanks, now my own card.')))
  await assertOwnerTurn(host, 'owner after the recipient', { kind: 'owner_message', id: String(messageId) })
})

test('control: a recipient message that reaches a running owner turn ends it, and the owner\'s next turn after Stop is the owner\'s', async (t) => {
  const host = agentHost(t)
  host.submit(host.card(ownerFrame('Update the launch card.')))
  await assertOwnerTurn(host, 'before')
  host.card(recipientFrame('Mine too.'))
  await assertNothingActsAsOwner(host, 'mid turn')
  host.stop()
  host.submit(host.card(ownerFrame('Carry on with my card.')))
  await assertOwnerTurn(host, 'the next turn', { kind: 'owner_message', id: String(messageId) })
})

test('control: two owner messages submitted together (#232), the second line first: the turn is the owner\'s', async (t) => {
  const host = agentHost(t)
  const a = host.prompt(host.card(ownerFrame('Here is the report file for later.')))
  const b = host.prompt(host.card(ownerFrame('Now update the board card with what the report says.')))
  a.mark()
  b.mark()
  b.spool()
  host.pump()
  a.spool()
  host.pump()
  await assertOwnerTurn(host, '#232', { kind: 'owner_message', id: String(messageId) })
})

test('control: a scheduled wake (#221) opens the owner\'s turn and email_send names its task', async (t) => {
  const host = agentHost(t)
  host.submit(host.card(wakeFrame(OWN_CHAT, 1460)))
  await assertOwnerTurn(host, 'wake', { kind: 'owner_task', id: '1460' })
})

test('control: the owner\'s voice consult on a live call (#227) opens its own turn as the owner', async (t) => {
  const host = agentHost(t)
  host.submit(host.consultCard(`rpc-${randomUUID()}`))
  for (const name of GATED) assert.equal(await actsFor(host, name), 'owner', name)
  assert.equal(host.browser(), 'owner')
})

test('control: a replayed wake after a restart (#229) opens no turn, and the owner\'s next message does', async (t) => {
  const host = agentHost(t)
  const frame = wakeFrame(OWN_CHAT, 1658)
  host.submit(host.card(frame))
  await assertOwnerTurn(host, 'the wake')
  host.stop()
  host.restart()
  host.submit(host.card(frame))
  for (const name of GATED) assert.equal(await actsFor(host, name), `refused: ${PRIVATE_TURN_REFUSAL}`, `the replay: ${name}`)
  host.stop()
  host.submit(host.card(ownerFrame('Update the launch card.')))
  await assertOwnerTurn(host, 'after the replay', { kind: 'owner_message', id: String(messageId) })
})

test('control: another person\'s wake admitted in the same turn after the owner\'s acts only as that person (#232), never as the owner', async (t) => {
  const host = agentHost(t)
  const owner = host.prompt(host.card(ownerFrame('Update the launch card.')))
  const recipient = host.prompt(host.card(recipientFrame('Update mine.')))
  owner.mark()
  recipient.mark()
  owner.spool()
  recipient.spool()
  host.pump()
  for (const name of GATED) assert.equal(await actsFor(host, name), RECIPIENT, name)
  assert.equal(host.browser(), RECIPIENT)
})

// ── The same race across a Stop: the previous turn's Stop line is late too ──

test('the owner\'s message queued behind a turn: its Stop line and the owner prompt\'s line both late, a recipient message injected meanwhile; nothing acts as the owner', async (t) => {
  const host = agentHost(t)
  host.submit(host.card(ownerFrame('Draft the launch plan.')))
  // The owner's next message arrives while that turn runs, and the CLI queues it.
  const queued = host.card(ownerFrame('Now update the launch card with it.'))
  await assertOwnerTurn(host, 'the first turn')
  // The CLI ends the turn and at once runs the queued prompt: both synchronous hooks run, both forwarder lines are slow.
  const stop = host.stopping()
  stop.mark()
  const owner = host.prompt(queued)
  owner.mark()
  host.card(recipientFrame('Put my private notes on the launch card too.'))
  stop.spool()
  host.pump()
  owner.spool()
  host.pump()
  await assertNothingActsAsOwner(host, 'after the late Stop and prompt lines')
  // The next turn after a Stop that is on time is the owner's again.
  host.stop()
  host.submit(host.card(ownerFrame('Carry on.')))
  await assertOwnerTurn(host, 'the turn after', { kind: 'owner_message', id: String(messageId) })
})

test('a recipient\'s prompt whose line lands before the previous turn\'s late Stop line: no tool acts as the owner in it', async (t) => {
  const host = agentHost(t)
  host.submit(host.card(ownerFrame('Draft the launch plan.')))
  const queued = host.card(recipientFrame('Add my notes to my card.'))
  const stop = host.stopping()
  stop.mark()
  const recipient = host.prompt(queued)
  recipient.mark()
  recipient.spool()
  host.pump()
  for (const name of GATED) assert.equal(await actsFor(host, name), RECIPIENT, `before the late Stop line: ${name}`)
  stop.spool()
  host.pump()
  // The late Stop line ends the private turn (fail closed, as before), and the turn aware tools never fall back to the owner.
  const seen = await everyone(host)
  for (const [name, who] of Object.entries(seen)) assert.notEqual(who, 'owner', `${name}: ${JSON.stringify(seen)}`)
})

test('control: a recipient message injected into a turn does not reach the next turn when that turn\'s Stop line is late', async (t) => {
  const host = agentHost(t)
  host.submit(host.card(ownerFrame('Draft the launch plan.')))
  const queued = host.card(ownerFrame('Now update the launch card with it.'))
  // Injected into the running turn: it ends that turn, as on main.
  host.card(recipientFrame('What is on the plan?'))
  await assertNothingActsAsOwner(host, 'mid turn')
  const stop = host.stopping()
  stop.mark()
  const owner = host.prompt(queued)
  owner.mark()
  stop.spool()
  host.pump()
  owner.spool()
  host.pump()
  // email_send still refuses here, as on main: the recipient's message came after the owner's own delivery.
  await assertOwnerTurn(host, 'the queued owner prompt, a turn of its own')
})

test('a second record of a recipient\'s prompt with no prompt_id does not hand the turn aware tools to the owner', async (t) => {
  const host = agentHost(t)
  const card = host.card(recipientFrame('Add my notes to my card.'))
  host.submit(card)
  assert.equal(await actsFor(host, 'call_owner'), RECIPIENT)
  host.again(card)
  for (const name of TURN_AWARE) assert.equal(await actsFor(host, name), `refused: ${TURN_AWARE_REFUSAL}`, name)
})

test('a recipient message queued behind a turn and run with the owner\'s as the next turn, the lines in order: nothing acts as the owner', async (t) => {
  const host = agentHost(t)
  host.submit(host.card(ownerFrame('Draft the launch plan.')))
  // Both arrive while that turn runs and the CLI queues them; the Stop forgets what reached the turn that ended.
  const recipientCard = host.card(recipientFrame('Put my notes on the launch card.'))
  const ownerCard = host.card(ownerFrame('Now update the launch card.'))
  host.stop()
  const recipient = host.prompt(recipientCard)
  const owner = host.prompt(ownerCard)
  recipient.mark()
  owner.mark()
  recipient.spool()
  owner.spool()
  host.pump()
  await assertNothingActsAsOwner(host, 'the recipient\'s prompt began in this turn')
})

test('a goal continuation after a Stop whose line is late: a recipient message injected into it is not forgotten by that Stop', async (t) => {
  const host = agentHost(t)
  host.submit('/goal ship the landing page')
  assert.equal(await actsFor(host, 'tick_mini_goal'), 'owner', 'the goal turn')
  // The CLI's Stop (the marker closes) and the continuation it runs with no prompt; the Stop's line is slow.
  const stop = host.stopping()
  stop.mark()
  host.card(recipientFrame('Make the page about my product instead.'))
  stop.spool()
  host.pump()
  for (const name of TURN_AWARE) assert.equal(await actsFor(host, name), `refused: ${TURN_AWARE_REFUSAL}`, name)
  host.stop()
  assert.equal(await actsFor(host, 'tick_mini_goal'), 'owner', 'the next continuation, after a Stop on time')
})

/** A tracker reading two marker files, as a daemon of two folder keys does, with markers the test writes. */
function twoKeys(t: any, ownerUserId: string | null = OWNER) {
  const root = mkdtempSync(join(tmpdir(), 'hoai-late-line-keys-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const own = privateMarkerPath(root, 'own')
  const other = privateMarkerPath(root, 'other')
  const tracker = createPrivateTurnTracker({ ownerUserId, markerPaths: [own, other] })
  const write = (path: string, marker: Record<string, unknown>) => writePrivateJson(path, { schemaVersion: 1, turnId: randomUUID(), promptHash: '', ...marker })
  /** One prompt of session s: its card delivered, the hook's live marker, then its line. */
  const turn = (actingUserId: string, chatId = '1') => {
    const card = tracker.deliver({ content: `card ${randomUUID()}`, actingUserId, chatId })
    write(own, { sessionId: 's', promptHash: privatePromptHash(card), live: true, promptId: randomUUID() })
    tracker.begin({ prompt: card, sessionId: 's', promptId: randomUUID() })
  }
  const stop = () => { write(own, { sessionId: 's', live: false }); tracker.end() }
  const current = () => tracker.current({ markerPaths: [own, other] })
  return { tracker, own, other, write, turn, stop, current }
}

test('control: a live marker of this session left at another folder key never keeps a recipient past the Stop', (t) => {
  const k = twoKeys(t)
  // Written long ago, under a key this session no longer uses.
  k.write(k.other, { sessionId: 's', live: true })
  utimesSync(k.other, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
  k.turn(OWNER)
  assert.equal(k.current()?.actingUserId, OWNER)
  k.tracker.deliver({ content: 'mine too', actingUserId: RECIPIENT, chatId: '2' })
  assert.equal(k.current(), null, 'revoked mid turn')
  k.stop()
  k.turn(OWNER)
  assert.equal(k.current()?.actingUserId, OWNER, 'the next turn is the owner\'s')
})

test('control: a live marker of another session never keeps a recipient past the Stop', (t) => {
  const k = twoKeys(t)
  k.turn(OWNER)
  // Another session's prompt, the marker written last of all.
  k.write(k.other, { sessionId: 'another', live: true })
  utimesSync(k.other, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
  k.tracker.deliver({ content: 'mine too', actingUserId: RECIPIENT, chatId: '2' })
  k.stop()
  k.turn(OWNER)
  assert.equal(k.current()?.actingUserId, OWNER, 'the next turn is the owner\'s')
})

test('without the owner named, a turn someone else reached is never usable, whoever it names', (t) => {
  const k = twoKeys(t, null)
  k.tracker.deliver({ content: 'first', actingUserId: 'user_alice', chatId: '1' })
  k.turn('user_bob', '2')
  assert.equal(k.current(), null)
  k.stop()
  k.turn('user_bob', '2')
  assert.equal(k.current()?.actingUserId, 'user_bob', 'alone, after a Stop')
})

test('a recipient message queued behind a turn, run with the owner\'s as the next turn, the owner prompt\'s line first: nothing acts as the owner, before or after the recipient\'s line', async (t) => {
  const host = agentHost(t)
  host.submit(host.card(ownerFrame('Draft the launch plan.')))
  const recipientCard = host.card(recipientFrame('Put my notes on the launch card.'))
  const ownerCard = host.card(ownerFrame('Now update the launch card.'))
  host.stop()
  const recipient = host.prompt(recipientCard)
  const owner = host.prompt(ownerCard)
  recipient.mark()
  owner.mark()
  owner.spool()
  host.pump()
  // The marker the hook left records both prompts of the turn, so the recipient's is known before its line lands.
  await assertNothingActsAsOwner(host, 'before the recipient prompt\'s line')
  recipient.spool()
  host.pump()
  await assertNothingActsAsOwner(host, 'after it')
})

test('a recipient message that reaches the daemon between the Stop hook and the queued owner prompt\'s hook, both lines late: nothing acts as the owner (review probe A)', async (t) => {
  const host = agentHost(t)
  host.submit(host.card(ownerFrame('Draft the launch plan.')))
  const queued = host.card(ownerFrame('Now update the launch card with it.'))
  const stop = host.stopping()
  stop.mark()
  // The CLI is starting the queued prompt (its hook is still starting up) when the recipient's card arrives.
  host.card(recipientFrame('Put my private notes on the launch card too.'))
  const owner = host.prompt(queued)
  owner.mark()
  stop.spool()
  host.pump()
  owner.spool()
  host.pump()
  await assertNothingActsAsOwner(host, 'probe A')
})

test('70f1898b behind a late Stop line: a recipient message and the owner\'s submitted together after the Stop hook, the owner prompt\'s line first (review probe B)', async (t) => {
  const host = agentHost(t)
  host.submit(host.card(ownerFrame('Draft the launch plan.')))
  const stop = host.stopping()
  stop.mark()
  const recipient = host.prompt(host.card(recipientFrame('Send the plan to legal@example.com for me.')))
  const owner = host.prompt(host.card(ownerFrame('Thanks, carry on.')))
  recipient.mark()
  owner.mark()
  stop.spool()
  host.pump()
  owner.spool()
  host.pump()
  await assertNothingActsAsOwner(host, 'probe B')
})

/**
 * The tracker as server.ts wires it and the real private turn hook, with no intake: the test calls begin() and end()
 * for the forwarder lines, in the order it wants them to land.
 */
function cli(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'hoai-late-line-cli-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'agent')
  mkdirSync(cwd)
  const env = { ...process.env, BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: cwd }
  markFloorAttached({ root, folders: [cwd] })
  const markerPaths = [privateMarkerPath(root, floorKey(cwd))]
  let tracker = createPrivateTurnTracker({ ownerUserId: OWNER, markerPaths })
  const c = {
    markerPaths,
    get tracker() { return tracker },
    /** A new daemon process: nothing but the disk survives. */
    restart() { tracker = createPrivateTurnTracker({ ownerUserId: OWNER, markerPaths }) },
    card: (actingUserId: string, chatId: string) => tracker.deliver({ content: `card ${randomUUID()}`, actingUserId, chatId }),
    /** The CLI submits a prompt: the hook writes its marker now; the returned function is its line reaching begin(). */
    prompt(prompt: string, session = 's') {
      const payload = { hook_event_name: 'UserPromptSubmit', session_id: session, cwd, prompt, prompt_id: randomUUID() }
      recordPrivateBoundary(payload, env)
      return () => tracker.begin({ prompt, sessionId: session, promptId: payload.prompt_id })
    },
    /** The CLI's Stop (or SessionEnd) hook: the marker closes. Its line is end(), when the test says. */
    stopHook(session = 's', event = 'Stop') { recordPrivateBoundary({ hook_event_name: event, session_id: session, cwd }, env) },
    end() { tracker.end() },
    gated() { try { return requirePrivateTurn(tracker, markerPaths, OWNER).actingUserId } catch { return 'refused' } },
    turnAware() { try { return turnAwarePrivateTurn({ tracker, markerPaths, ownerUserId: OWNER }).actingUserId } catch { return 'refused' } },
  }
  return c
}

test('a new CLI session: the old session\'s SessionEnd line lands after a recipient message reached the new session\'s first turn (review probe C)', (t) => {
  const c = cli(t)
  c.prompt(c.card(OWNER, '1'), 's1')()
  assert.equal(c.gated(), OWNER)
  c.stopHook('s1', 'SessionEnd')
  const begin = c.prompt(c.card(OWNER, '1'), 's2')
  c.card(RECIPIENT, '2')
  c.end()
  begin()
  assert.equal(c.gated(), 'refused')
  assert.equal(c.turnAware(), 'refused')
})

test('a daemon restart: a Stop line from before it lands after a recipient message reached the next turn (review probe D)', (t) => {
  const c = cli(t)
  c.prompt(c.card(OWNER, '1'))()
  c.stopHook()
  c.restart()
  const begin = c.prompt(c.card(OWNER, '1'))
  c.card(RECIPIENT, '2')
  c.end()
  begin()
  assert.equal(c.gated(), 'refused')
  assert.equal(c.turnAware(), 'refused')
})

test('control: a daemon restart with nobody else in the next turn: the owner\'s', (t) => {
  const c = cli(t)
  c.prompt(c.card(OWNER, '1'))()
  c.stopHook()
  c.restart()
  const begin = c.prompt(c.card(OWNER, '1'))
  c.end()
  begin()
  assert.equal(c.gated(), OWNER)
})

test('control: recipient then owner, the recipient turn\'s Stop line drained before its Stop hook closed the marker (review probe E)', (t) => {
  const c = cli(t)
  c.prompt(c.card(RECIPIENT, '2'))()
  assert.equal(c.gated(), RECIPIENT)
  c.end()
  c.stopHook()
  c.prompt(c.card(OWNER, '1'))()
  assert.equal(c.gated(), OWNER, 'the owner\'s own turn')
  assert.equal(c.turnAware(), OWNER)
})

test('a prompt of the turn whose delivery this daemon cannot place (another daemon life) bars the owner', (t) => {
  const c = cli(t)
  const old = c.card(RECIPIENT, '2')
  c.restart()
  const card = c.card(OWNER, '1')
  // Submitted together: the recipient's card, delivered by the previous daemon life, then the owner's.
  c.prompt(old)
  c.prompt(card)()
  assert.equal(c.gated(), 'refused')
  assert.match(c.tracker.explain({ markerPaths: c.markerPaths }), /a delivery this daemon cannot name/)
})

test('a recipient message that reaches the daemon while the marker cannot be read bars the owner (fails closed)', (t) => {
  for (const withRecipient of [true, false]) {
    const c = cli(t)
    c.prompt(c.card(OWNER, '1'))()
    c.stopHook()
    const card = c.card(OWNER, '1')
    if (withRecipient) {
      // The marker cannot be read at this moment (here: something else stands at its path).
      rmSync(c.markerPaths[0]!)
      mkdirSync(c.markerPaths[0]!)
      c.card(RECIPIENT, '2')
      rmSync(c.markerPaths[0]!, { recursive: true })
    }
    c.end()
    c.prompt(card)()
    assert.equal(c.gated(), withRecipient ? 'refused' : OWNER, withRecipient ? 'a recipient message whose place is unknown' : 'control: nobody else')
  }
})

test('the marker records the CLI turn: one turn until a Stop, the gap it followed, each prompt\'s token by tag, never the token', () => {
  const token = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const card = (n: number) => `card ${n}\n<hoai-private-turn id="${token(n)}"/>`
  const first = { schemaVersion: 1, turnId: 't1', sessionId: 's', promptHash: 'h', live: true, ...privateTurnRecord({ previous: { schemaVersion: 1, turnId: 'c0', sessionId: 's', live: false }, sessionId: 's', prompt: card(1), turnId: 't1' }) }
  assert.deepEqual([first.cliTurn, first.after, first.tags], ['t1', 'c0', [privateTokenTag(token(1))]])
  assert.ok(!JSON.stringify(first).includes(token(1)), 'the token itself is never written')
  const second = privateTurnRecord({ previous: first, sessionId: 's', prompt: card(2), turnId: 't2' })
  assert.deepEqual([second.cliTurn, second.after, second.tags], ['t1', 'c0', [privateTokenTag(token(1)), privateTokenTag(token(2))]], 'the same turn')
  assert.deepEqual(privateTurnRecord({ previous: { ...first, live: false }, sessionId: 's', prompt: card(3), turnId: 't3' }), { cliTurn: 't3', after: 't1', tags: [privateTokenTag(token(3))] }, 'after a Stop, a new turn')
  assert.deepEqual(privateTurnRecord({ previous: first, sessionId: 'other', prompt: card(3), turnId: 't3' }), { cliTurn: 't3', tags: [privateTokenTag(token(3))] }, 'another session')
  assert.equal(privateTurnRecord({ previous: null, previousUnreadable: true, sessionId: 's', prompt: card(3), turnId: 't3' }).unsure, true, 'a marker there but unreadable')
  assert.equal(privateTurnRecord({ previous: { schemaVersion: 1, turnId: 'old', sessionId: 's', live: true }, sessionId: 's', prompt: card(3), turnId: 't3' }).unsure, true, 'a live marker of a hook that kept no tags')
  let previous: any = null
  for (let n = 0; n <= PRIVATE_TURN_TAGS_MAX; n++) previous = { schemaVersion: 1, turnId: `t${n}`, sessionId: 's', live: true, promptId: 'p'.repeat(128), promptHash: 'f'.repeat(64), ...privateTurnRecord({ previous, sessionId: 's', prompt: card(n), turnId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` }) }
  assert.equal(previous.tagsLost, true, `past ${PRIVATE_TURN_TAGS_MAX} tags`)
  assert.ok(Buffer.byteLength(JSON.stringify(previous)) < 2048, 'a full marker stays under the 2048 bytes every reader (the Agent Browser too) accepts')
})

test('the refusal says why, in the daemon\'s log line', (t) => {
  const host = agentHost(t)
  const owner = host.prompt(host.card(ownerFrame('Update the launch card.')))
  owner.mark()
  host.card(recipientFrame('And mine.'))
  owner.spool()
  host.pump()
  assert.match(host.tracker.explain({ markerPaths: host.markerPaths }), /someone other than the owner/)
})

test('the tracker is told who the owner is and which markers to read (server.ts)', () => {
  assert.match(source, /createPrivateTurnTracker\(\{ ownerUserId: USER_ID, markerPaths: PRIVATE_MARKER_PATHS, /)
  assert.equal(typeof (privateTurn as any).createPrivateTurnTracker, 'function')
})
