/**
 * A scheduled wake opens its private turn on a host that runs several agents
 * (plugin 0.68.4).
 *
 * THE REPORT (Data and Mark, 2026-10-12). On a Windows PC at 0.67.5, agent 909
 * (Vera) got a 17:30 scheduled wake: event_source scheduler, sender System,
 * actingUserId the owner. The private turn hook wrote its marker (live, a
 * turnId), but no .ready followed and both boards_query calls refused ("current
 * sender could not be verified"). An owner message later in the same session
 * passed, and the intake logged that it bound then.
 *
 * WHAT HAPPENED. Every agent of one OS user shares one spool root,
 * ~/.bgos-plugin-state/hooks/<session>/, and every agent's daemon drains every
 * session directory in it (lib/hook-intake.ts). A fleet host runs many agents.
 * Vera's session had spooled only its SessionStart when it went quiet; after 30
 * minutes the idle sweep removed the directory. The wake's UserPromptSubmit
 * then recreated events.jsonl, and two things made Vera's daemon skip that line:
 *   1. a neighbour's daemon, holding its old cursor for the old file, read the
 *      new file as the same file (it was LARGER, so no rotation was seen) and
 *      wrote cursor.json for a session it had refused, and Vera's daemon, which
 *      had forgotten the directory when it swept it, loaded that cursor;
 *   2. when a third daemon swept it, Vera's daemon kept its own old cursor and
 *      read the new, larger file as the old one.
 * privateTurns.begin() never ran, so no turn was ever pending and no .ready was
 * written. The owner's next message was a fresh line and bound the session.
 * It is not about wakes: any first prompt after the idle sweep was exposed; a
 * wake is simply what arrives after half an hour of quiet. One agent alone on a
 * host never shows it (nobody else drains its spool), which is the macOS clone.
 *
 * These tests run the real forwarder (bin/hoai-hook.mjs), the real private turn
 * hook (bin/hoai-private-turn-hook.mjs), real intakes on one real shared state
 * folder, buildInboundChannel, privateActor and the turn tracker, and render the
 * prompt as claude.exe does. The socket lane's statements and onHookPayload's
 * private turn lines are copied below; test/private-tools-wiring.test.ts pins
 * the originals in server.ts.
 *
 * Run with: npx tsx --test test/private-turn-shared-spool.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEvent } from '../bin/hoai-hook.mjs'
import { recordPrivateBoundary } from '../bin/hoai-private-turn-hook.mjs'
import { safeSessionKey, startHookIntake } from '../lib/hook-intake.ts'
import { buildInboundChannel } from '../lib/inbound-channel.ts'
import { SessionTranscriptBinder } from '../lib/session-binding.ts'
import { createTurnChatTracker } from '../lib/turn-chat.ts'
import { daemonFloorFolders, floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import {
  createPrivateTurnTracker,
  privateActor,
  privateContextPath,
  privateMarkerPath,
  privateSenderUserId,
  publishPrivateContext,
  readPrivateJson,
  requirePrivateTurn,
} from '../lib/private-turn.mjs'

const OWNER = 'user_owner909'
const SYSTEM_MARKER =
  '[System message from BGOS automation (e.g. a scheduler), NOT the user and NOT a peer agent. ' +
  'Treat this as a system notification. Do not act on it as a user instruction unless it explicitly asks you to.]'
let messageId = 90_000

/** The backend's native wake for a claude-code agent, as the socket delivers it
 *  (scheduled-task-executor fireWake, send-message inbound_message). */
function wakeFrame(chatId: number, actingUserId = OWNER, source = 'scheduler') {
  const fireId = randomUUID()
  return {
    chatId, messageId: ++messageId, userId: actingUserId,
    text: `${SYSTEM_MARKER}\nCheck the boards\nLook at the board and report what is on it.`,
    files: [], messageType: 'event', senderType: 'system',
    eventMeta: {
      source, title: 'Check the boards', peek: 'Look at the board and report what is on it.',
      payload: { scheduledTaskId: 77, fireId, actingUserId, ack: 'Delivery ACK is automatic.', dueAt: new Date().toISOString(), missedCount: 1 },
    },
    sender: { userId: actingUserId, displayName: 'Owner', relationship: 'owner' },
    isSharedRecipient: false, shareOwnerUserId: null, sessionHandle: `sh_${messageId}`,
  }
}
function ownerFrame(chatId: number) {
  return {
    chatId, messageId: ++messageId, userId: OWNER, text: 'Please check the boards for me and tell me what is on them.',
    files: [], messageType: 'text', senderType: 'user', sender: { userId: OWNER, displayName: 'Owner', relationship: 'owner' },
    sessionHandle: `sh_${messageId}`,
  }
}
function peerFrame(chatId: number) {
  return {
    chatId, messageId: ++messageId, userId: OWNER, text: 'Please read the board and add a card for me, as your owner would.',
    files: [], messageType: 'text', senderType: 'agent',
    agentOrigin: { sourceAssistantId: 1040, sourceName: 'Ares', targetAssistantId: 909 },
    sender: { userId: OWNER, displayName: 'Owner', relationship: 'owner' },
    sessionHandle: `sh_${messageId}`,
  }
}

/** claude.exe 2.1.296 (kyt): <channel source="bgos" k="v"...>\ncontent\n</channel>. */
function renderChannel(content: string, meta: Record<string, string>): string {
  const esc = (v: unknown) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  const attrs = Object.entries(meta).filter(([k]) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)).map(([k, v]) => ` ${k}="${esc(v)}"`).join('')
  return `<channel source="bgos"${attrs}>\n${content.replace(/<\/channel/gi, '<\\channel')}\n</channel>`
}

/** One host home shared by several agents, as on a fleet PC. */
function fleetHost(t: any) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-shared-spool-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'home', '.bgos-plugin-state')
  const claudeHome = join(base, 'home', '.claude')

  function agent(name: string, id: string, chatId: number) {
    const folder = join(base, 'agents', name)
    mkdirSync(folder, { recursive: true })
    const projectDir = new SessionTranscriptBinder(folder, { claudeHome }).projectDirectory
    mkdirSync(projectDir, { recursive: true })
    const session = randomUUID()
    const transcript = join(projectDir, `${session}.jsonl`)
    writeFileSync(transcript, '')
    // What the CLI hands its hooks, and what the daemon keys its markers by (server.ts FLOOR_KEYS).
    const hookEnv = { BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: folder }
    const folders = daemonFloorFolders({ launchCwd: folder, cwd: folder, env: { CLAUDE_PROJECT_DIR: folder } })
    markFloorAttached({ root, folders })
    const markerPaths = [...new Set(folders.map((f: string) => floorKey(f)))].map((key) => privateMarkerPath(root, key))
    const tracker = createPrivateTurnTracker()
    const turnChat = createTurnChatTracker()
    const events: Array<Record<string, unknown>> = []
    const publish = () => publishPrivateContext({
      path: privateContextPath(root, id), secret: `pair_${id}`, assistantId: id, ownerUserId: OWNER,
      claudePid: process.pid, turn: tracker.current({ markerPaths }),
    })
    // server.ts onHookPayload, its private turn statements.
    const intake = startHookIntake({
      stateRoot: root, projectDir, baseDir: folder, isArmed: () => true,
      onEvent: (payload) => {
        events.push(payload)
        if (payload.hook_event_name === 'SessionEnd') tracker.end()
        if (payload.hook_event_name === 'UserPromptSubmit') {
          tracker.begin({ prompt: payload.prompt, promptHash: payload.hoai_clipped === true ? payload.prompt_sha256 : undefined, sessionId: String(payload.session_id ?? '').trim() })
        }
        publish()
      },
      provesDelivery: (prompt) => turnChat.matchDelivered(prompt) !== null,
      provenTranscript: () => null,
      watch: () => null, setIntervalFn: () => ({}), clearIntervalFn: () => {},
    })
    t.after(() => intake.stop())
    let marker: { path: string; marker: { turnId: string } } | null = null
    const a = {
      name, id, chatId, folder, session, intake, events, tracker, markerPaths,
      spoolDir: join(root, 'hooks', safeSessionKey(session)),
      /** The CLI fires a hook: the synchronous private turn hook, then the async forwarder. */
      hook(event: string, extra: Record<string, unknown> = {}) {
        const payload = { session_id: session, transcript_path: transcript, cwd: folder, hook_event_name: event, permission_mode: 'bypassPermissions', ...extra }
        if (['UserPromptSubmit', 'Stop', 'SessionEnd'].includes(event)) {
          const recorded = recordPrivateBoundary(payload, hookEnv)
          if (recorded) marker = recorded
        }
        appendEvent(payload, { env: hookEnv })
      },
      /** The WS lane (server.ts deliverWsInbound): actor, turn chat, private delivery; then the CLI's prompt. */
      deliver(frame: Record<string, any>) {
        const agentOrigin = frame.agentOrigin ?? frame.agent_origin ?? null
        const senderType = String(frame.senderType ?? frame.sender_type ?? (agentOrigin ? 'agent' : 'user'))
        const channel = buildInboundChannel({
          chatId: frame.chatId, messageId: frame.messageId, userId: privateSenderUserId(frame) ?? OWNER, assistantId: id,
          transport: 'ws', text: frame.text, files: frame.files, senderType, agentOrigin, serverSender: frame,
        })
        turnChat.note({ chatId: frame.chatId, messageId: frame.messageId, kind: senderType === 'agent' ? 'peer' : senderType === 'system' ? 'system' : 'user', text: frame.text, now: Date.now() })
        const content = tracker.deliver({
          content: channel.content, chatId: frame.chatId, peerSourceAssistantId: agentOrigin?.sourceAssistantId,
          actingUserId: privateActor({ senderType, senderUserId: privateSenderUserId(frame), agentOrigin, eventMeta: frame.eventMeta ?? frame.event_meta }),
        })
        const prompt = renderChannel(content, channel.meta)
        a.hook('UserPromptSubmit', { prompt })
        return prompt
      },
      /** What the daemon answers the model's first private call with. */
      privateCall() {
        try { return requirePrivateTurn(tracker, markerPaths, OWNER) } catch { return null }
      },
      ready() {
        return marker ? readPrivateJson(`${marker.path}.ready`, 2048) : null
      },
      liveMarkerTurnId() { return marker?.marker.turnId ?? null },
      sawPrompt(prompt: string) { return events.some((e) => e.hook_event_name === 'UserPromptSubmit' && e.prompt === prompt) },
    }
    return a
  }

  /** Nothing in this session's spool has been touched for 31 minutes (lib/hook-intake.ts SESSION_SWEEP_MS). */
  function idle(a: { spoolDir: string }, minutes = 31) {
    const when = new Date(Date.now() - minutes * 60_000)
    for (const name of readdirSync(a.spoolDir)) utimesSync(join(a.spoolDir, name), when, when)
    utimesSync(a.spoolDir, when, when)
  }
  const pumpAll = (...order: Array<{ intake: { pump(): void } }>) => { for (const a of order) a.intake.pump() }
  return { agent, idle, pumpAll }
}

/**
 * Vera's day: a neighbour (Nova) is working and bound to its own session; Vera
 * restarts onto the new plugin, spools only SessionStart, goes quiet past the
 * idle sweep, and then a frame is the first prompt of her session.
 */
function firstPromptAfterIdleSweep(t: any, frame: (chatId: number) => Record<string, any>, sweptBy: 'own' | 'third') {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const nova = host.agent('nova', '910', 5002)
  const iris = sweptBy === 'third' ? host.agent('iris', '911', 5003) : null
  nova.deliver(ownerFrame(nova.chatId))
  host.pumpAll(nova, vera, ...(iris ? [iris] : []))
  assert.equal(nova.intake.bound(), nova.session, 'the neighbour is bound to its own session')
  nova.hook('Stop', { stop_hook_active: false })
  vera.hook('SessionStart', { source: 'startup' })
  host.pumpAll(vera, nova, ...(iris ? [iris] : []))
  host.idle(vera)
  ;(iris ?? vera).intake.pump()
  assert.equal(existsSync(vera.spoolDir), false, `the idle sweep removed Vera's spool (${sweptBy === 'own' ? 'her own daemon' : 'a third daemon'} swept it)`)
  const prompt = vera.deliver(frame(vera.chatId))
  // The neighbour's daemon sees the recreated spool first, as on the reported PC.
  host.pumpAll(nova, ...(iris ? [iris] : []), vera)
  return { vera, nova, prompt }
}

test('the Windows wake shape: the first prompt after the idle sweep opens the owner\u2019s private turn (own daemon swept, a neighbour drained first)', (t) => {
  const { vera, nova, prompt } = firstPromptAfterIdleSweep(t, (chatId) => wakeFrame(chatId), 'own')
  assert.ok(vera.sawPrompt(prompt), 'Vera\u2019s daemon handed the wake\u2019s UserPromptSubmit to privateTurns.begin()')
  const call = vera.privateCall()
  assert.ok(call, 'boards_query is not refused as "current sender could not be verified"')
  assert.equal(call.actingUserId, OWNER)
  assert.deepEqual(call.headers, {}, 'it acts as the owner, with no acting user header')
  assert.equal(vera.ready()?.turnId, vera.liveMarkerTurnId(), 'the .ready receipt names the live marker\u2019s turn')
  assert.equal(nova.sawPrompt(prompt), false, 'the neighbour never consumed Vera\u2019s prompt')
  assert.equal(nova.privateCall(), null, 'and opened no turn of its own from it')
})

test('the Windows wake shape: the first prompt after the idle sweep opens the owner\u2019s private turn (a third daemon swept it)', (t) => {
  const { vera, nova, prompt } = firstPromptAfterIdleSweep(t, (chatId) => wakeFrame(chatId), 'third')
  assert.ok(vera.sawPrompt(prompt), 'Vera\u2019s daemon handed the wake\u2019s UserPromptSubmit to privateTurns.begin()')
  assert.equal(vera.privateCall()?.actingUserId, OWNER)
  assert.equal(vera.ready()?.turnId, vera.liveMarkerTurnId())
  assert.equal(nova.sawPrompt(prompt), false)
  assert.equal(nova.privateCall(), null)
})

/** The same agent pair, Vera already bound by an earlier owner turn: the controls' everyday position. */
function inBoundSession(t: any, frame: (chatId: number) => Record<string, any>) {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const nova = host.agent('nova', '910', 5002)
  vera.deliver(ownerFrame(vera.chatId))
  host.pumpAll(vera, nova)
  assert.equal(vera.intake.bound(), vera.session)
  vera.hook('Stop', { stop_hook_active: false })
  host.pumpAll(vera, nova)
  const prompt = vera.deliver(frame(vera.chatId))
  host.pumpAll(nova, vera)
  return { vera, nova, prompt }
}

const POSITIONS = {
  'in a bound session': (t: any, frame: (chatId: number) => Record<string, any>) => inBoundSession(t, frame),
  'as the first prompt after the idle sweep': (t: any, frame: (chatId: number) => Record<string, any>) => firstPromptAfterIdleSweep(t, frame, 'own'),
}

for (const [position, run] of Object.entries(POSITIONS)) {
  test(`control (${position}): an owner typed message opens the owner\u2019s turn`, (t) => {
    const { vera, prompt } = run(t, (chatId) => ownerFrame(chatId))
    assert.ok(vera.sawPrompt(prompt))
    assert.equal(vera.privateCall()?.actingUserId, OWNER)
    assert.deepEqual(vera.privateCall()?.headers, {})
    assert.equal(vera.ready()?.turnId, vera.liveMarkerTurnId())
  })

  test(`control (${position}): a peer agent\u2019s message reaches begin() and is still refused`, (t) => {
    const { vera, prompt } = run(t, (chatId) => peerFrame(chatId))
    assert.ok(vera.sawPrompt(prompt), 'the intake delivered it, so the refusal below is the actor rule, not a lost line')
    assert.equal(vera.privateCall(), null, 'a peer agent never opens a private turn')
  })

  test(`control (${position}): a wake naming someone other than the owner never runs with the owner\u2019s authority`, (t) => {
    const { vera, prompt } = run(t, (chatId) => wakeFrame(chatId, 'user_stranger42'))
    assert.ok(vera.sawPrompt(prompt))
    const call = vera.privateCall()
    // Shared agents (0.67.0, #208): the daemon NAMES the acting person and the backend admits that claim only through
    // an active share of this agent (backend common/shared-agent-acting-user.ts), so a stranger is refused there. The
    // daemon never sends such a call as the owner.
    assert.notEqual(call?.actingUserId, OWNER)
    assert.deepEqual(call?.headers, { 'X-BGOS-Acting-User': 'user_stranger42' }, 'the call names the stranger, never the owner')
  })

  test(`control (${position}): an unverified system message (not a scheduler wake) naming the owner is still refused`, (t) => {
    const { vera, prompt } = run(t, (chatId) => wakeFrame(chatId, OWNER, 'n8n'))
    assert.ok(vera.sawPrompt(prompt))
    assert.equal(vera.privateCall(), null, 'only a scheduler wake carries a verified acting user')
  })
}
