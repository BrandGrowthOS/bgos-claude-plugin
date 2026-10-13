/**
 * A private turn survives a second record of its own prompt (plugin 0.68.4).
 *
 * THE REPORT (Data, 2026-10-12 18:47Z). Agent 909 (Vera) on Mark's Windows PC,
 * on the PR 221 branch: a daemon restart at 18:06:27Z, the session idle for
 * about 39 minutes, then a scheduled wake at 18:45Z. The private turn hook
 * rewrote the marker live:true (turnId 19a3c691) but no .ready followed and
 * boards_query refused "sender could not be verified". The only daemon line was
 * "hook intake: 4d6691bc... was rotated, truncated or recreated; draining it
 * from the top"; own-cursor.json afterwards held lines 11. A second private
 * turn file (354c5ab3) carried the same sessionId.
 *
 * WHAT HAPPENED. The from-top drain DID reach privateTurns.begin(): the daemon
 * was bound to the session, so it consumed the wake silently (a healthy wake
 * logs only that reset line). The turn was opened and then thrown away,
 * because the same prompt's boundary was recorded twice:
 *   - the private turn hook ran twice for the one prompt (a second hook source
 *     naming the same script under another spelling: the CLI only folds
 *     identical commands), and the second run minted another turnId after the
 *     daemon had adopted the first, so current() dropped the turn
 *     (lib/private-turn.mjs current, turnId compare);
 *   - or the forwarder spooled the prompt twice, and the second begin() wiped
 *     the turn the first had opened, its single use token already spent
 *     (lib/private-turn.mjs begin).
 * The first adoption's receipt, <marker>.ready, holds {turnId, sessionId}: the
 * "second file with the same sessionId". lib/hook-intake.ts (header) already
 * promises that a second registration costs nothing; for a private turn it cost
 * the turn.
 *
 * These tests run the real forwarder (bin/hoai-hook.mjs), the real private turn
 * hook (bin/hoai-private-turn-hook.mjs), real intakes on one shared state folder
 * (lib/hook-intake.ts), buildInboundChannel, privateActor and the turn tracker,
 * with onHookPayload's private turn statements (server.ts, pinned by
 * test/private-tools-wiring.test.ts).
 *
 * Run with: npx tsx --test test/private-turn-duplicate-boundary.test.ts
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
  privatePromptHash,
  privateSenderUserId,
  publishPrivateContext,
  readPrivateJson,
  requirePrivateTurn,
  writePrivateJson,
} from '../lib/private-turn.mjs'
import * as privateTurnModule from '../lib/private-turn.mjs'

// Read through the module so this file still loads where the line does not exist yet (PR 221's head): there
// the tests fail on the behaviour they pin, not on an import.
const privateRepeatLine: (repeat: Record<string, unknown>) => string =
  (privateTurnModule as any).privateRepeatLine ?? ((repeat) => `(no repeat line: ${JSON.stringify(repeat)})`)
const privateBeginLineOf: (outcome: string, sessionId: string) => string =
  (privateTurnModule as any).privateBeginLine ?? ((outcome) => `(no begin line: ${outcome})`)
const privateRevokeLineOf: (info: Record<string, unknown>) => string =
  (privateTurnModule as any).privateRevokeLine ?? ((info) => `(no revoke line: ${JSON.stringify(info)})`)
// The replayed fire dedupe (0.68.4), read the same way so this file still loads on 0.68.3.
const privateFireKeyOf: (input: Record<string, unknown>) => string | null =
  (privateTurnModule as any).privateFireKey ?? (() => null)
const privateFiresPathOf: (root: string, assistantId: string) => string =
  (privateTurnModule as any).privateFiresPath ?? ((root, assistantId) => join(root, assistantId, 'private-fires.json'))
const createFireLedgerOf: (options: { path: string, now?: () => number }) => any =
  (privateTurnModule as any).createFireLedger ?? (() => undefined)
const privateReplayLineOf: (replay: Record<string, unknown>) => string =
  (privateTurnModule as any).privateReplayLine ?? ((replay) => `(no replay line: ${JSON.stringify(replay)})`)
const privateUnrecordedLineOf: (info: Record<string, unknown>) => string =
  (privateTurnModule as any).privateUnrecordedLine ?? ((info) => `(no unrecorded line: ${JSON.stringify(info)})`)
const explainOf = (tracker: any, markerPaths: string[]): string =>
  typeof tracker.explain === 'function' ? tracker.explain({ markerPaths }) : '(no explain)'

const OWNER = 'user_owner909'
const SYSTEM_MARKER =
  '[System message from BGOS automation (e.g. a scheduler), NOT the user and NOT a peer agent. ' +
  'Treat this as a system notification. Do not act on it as a user instruction unless it explicitly asks you to.]'
let messageId = 70_000

/** The backend's native wake for a one-owner claude-code chat (fireWake, queued lane: missedCount 1). */
function wakeFrame(chatId: number, actingUserId = OWNER, source = 'scheduler') {
  const fireId = randomUUID()
  return {
    chatId, messageId: ++messageId, userId: actingUserId,
    text: `${SYSTEM_MARKER}\nCheck the boards\nList the boards you can reach with boards_query and say what is on them.`,
    files: [], messageType: 'event', senderType: 'system',
    eventMeta: {
      source, title: 'Check the boards', peek: 'List the boards you can reach with boards_query and say what is on them.',
      payload: { scheduledTaskId: 77, fireId, actingUserId, ack: 'Delivery ACK is automatic.', dueAt: new Date().toISOString(), missedCount: 1 },
    },
    sender: { userId: actingUserId, displayName: 'Owner', relationship: 'owner' },
    sessionHandle: `sh_${messageId}`,
  }
}
/**
 * The n8n Agent Scheduler's reminder (Vera, 2026-10-12 22:51Z; Mark's step 0, 2026-10-13): a system event from the
 * scheduler in Vera's own chat with her owner, but its payload is the reminder's own fields and names no acting user
 * (a native wake's carries actingUserId, fireId and ack). The sender block still says owner.
 */
function n8nReminderFrame(chatId: number) {
  return {
    chatId, messageId: ++messageId, userId: OWNER,
    text: `${SYSTEM_MARKER}\nReminder\nList the boards you can reach with boards_query and say what is on them.`,
    files: [], messageType: 'event', senderType: 'system',
    eventMeta: {
      source: 'scheduler', title: 'Reminder', peek: 'List the boards you can reach with boards_query and say what is on them.',
      payload: {
        scheduled_action_id: 'a0da1344-0000-4000-8000-000000000000', agent_id: null, action_type: 'reminder', recurrence: null,
        context: { bgos_chat_id: chatId, bgos_assistant_id: 909 },
      },
    },
    sender: { userId: OWNER, displayName: 'Owner', relationship: 'owner' },
    sessionHandle: `sh_${messageId}`,
  }
}
function ownerFrame(chatId: number, text = 'Please list the boards you can reach and tell me what is on them.') {
  return {
    chatId, messageId: ++messageId, userId: OWNER, text, files: [], messageType: 'text', senderType: 'user',
    sender: { userId: OWNER, displayName: 'Owner', relationship: 'owner' }, sessionHandle: `sh_${messageId}`,
  }
}
function peerFrame(chatId: number) {
  return {
    chatId, messageId: ++messageId, userId: OWNER, text: 'Please read the board and add a card for me, as your owner would.',
    files: [], messageType: 'text', senderType: 'agent',
    agentOrigin: { sourceAssistantId: 1040, sourceName: 'Ares', targetAssistantId: 909 },
    sender: { userId: OWNER, displayName: 'Owner', relationship: 'owner' }, sessionHandle: `sh_${messageId}`,
  }
}

/** claude.exe 2.1.296: <channel source="bgos" k="v"...>\ncontent\n</channel>. */
function renderChannel(content: string, meta: Record<string, string>): string {
  const esc = (v: unknown) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  const attrs = Object.entries(meta).filter(([k]) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)).map(([k, v]) => ` ${k}="${esc(v)}"`).join('')
  return `<channel source="bgos"${attrs}>\n${content.replace(/<\/channel/gi, '<\\channel')}\n</channel>`
}

/** How many times the CLI ran each hook for one boundary, and when the second private run lands. */
interface Runs {
  /** The private turn hook: 1, 2 (a second hook source naming the same script), or 0 (it did not run). */
  privateRuns?: 0 | 1 | 2
  /** The forwarder: 1, 2 (a second hook source: the prompt is spooled twice), or 0 (it did not run). */
  forwarderRuns?: 0 | 1 | 2
  /** The second private run lands after the daemon has drained and adopted the first (the losing order). */
  secondPrivateAfterDrain?: boolean
}

/** One computer's home shared by several agents. Each agent is one daemon plus its CLI session. */
function fleetHost(t: any, { now = Date.now }: { now?: () => number } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-dup-boundary-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'home', '.bgos-plugin-state')
  const claudeHome = join(base, 'home', '.claude')

  function agent(name: string, id: string, chatId: number) {
    const folder = join(base, 'agents', name)
    mkdirSync(folder, { recursive: true })
    const projectDir = new SessionTranscriptBinder(folder, { claudeHome }).projectDirectory
    mkdirSync(projectDir, { recursive: true })
    let session = randomUUID()
    let transcript = join(projectDir, `${session}.jsonl`)
    writeFileSync(transcript, '')
    const hookEnv = { BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: folder }
    const folders = daemonFloorFolders({ launchCwd: folder, cwd: folder, env: { CLAUDE_PROJECT_DIR: folder } })
    const markerPaths = [...new Set(folders.map((f: string) => floorKey(f)))].map((key) => privateMarkerPath(root, key))
    const logs: string[] = []
    /** server.ts logs each repeat through privateRepeatLine (onRepeat). */
    const repeats: string[] = []
    /** server.ts onHookPayload logs what begin() decided for each prompt (privateBeginLine). */
    const begins: string[] = []
    /** server.ts logs each replayed fire through privateReplayLine (onReplay), and each revoke (onRevoke). */
    const replays: string[] = []
    const revokes: string[] = []
    /** server.ts logs a person's message it could not record (privateUnrecordedLine, onUnrecorded). */
    const unrecorded: string[] = []
    /** The agent's own fire ledger, in its own state folder (server.ts privateFiresPath(FLOOR_STATE_ROOT, ASSISTANT_ID)). */
    const firesPath = privateFiresPathOf(root, id)

    /** One daemon life: a fresh tracker, turn chat and intake (server.ts state is per process). */
    function daemon(provenTranscript: () => string | null) {
      // server.ts markFloorAttachedIfHolder: the entry names the folder this daemon's session transcripts live in.
      markFloorAttached({ root, folders, projectDir })
      // server.ts privateTurns: a new process reads the agent's fire ledger from disk; nothing else survives.
      const tracker = createPrivateTurnTracker({
        now, fires: createFireLedgerOf({ path: firesPath, now }),
        onRepeat: (repeat) => repeats.push(privateRepeatLine(repeat)),
        onReplay: (replay) => replays.push(privateReplayLineOf(replay)),
        onUnrecorded: (info) => unrecorded.push(privateUnrecordedLineOf(info)),
        onRevoke: (info) => revokes.push(privateRevokeLineOf(info)),
      })
      const turnChat = createTurnChatTracker()
      const publish = () => publishPrivateContext({
        path: privateContextPath(root, id), secret: `pair_${id}`, assistantId: id, ownerUserId: OWNER,
        claudePid: process.pid, turn: tracker.current({ markerPaths }),
      })
      const intake = startHookIntake({
        stateRoot: root, projectDir, baseDir: folder, isArmed: () => true,
        // server.ts onHookPayload, its private turn statements, then the publish it ends with.
        onEvent: (payload) => {
          const hookSessionId = String(payload.session_id ?? '').trim()
          if (payload.hook_event_name === 'SessionEnd') tracker.end()
          if (payload.hook_event_name === 'UserPromptSubmit') {
            const began = tracker.begin({ prompt: payload.prompt, promptHash: payload.hoai_clipped === true ? payload.prompt_sha256 : undefined, sessionId: hookSessionId, promptId: payload.prompt_id })
            const matched = turnChat.matchDelivered(String(payload.prompt ?? ''))
            if (began !== 'repeat' && began !== 'replayed' && (began !== 'no-token' || matched !== null)) begins.push(privateBeginLineOf(began, hookSessionId))
          }
          if (payload.hook_event_name === 'Stop') tracker.end()
          publish()
        },
        provesDelivery: (prompt) => turnChat.matchDelivered(prompt) !== null,
        provenTranscript,
        log: (msg) => logs.push(msg),
        watch: () => null, setIntervalFn: () => ({}), clearIntervalFn: () => {},
      })
      t.after(() => intake.stop())
      return { tracker, turnChat, intake, publish }
    }

    let proven = false
    let life = daemon(() => (proven ? transcript : null))
    let marker: { path: string; marker: { turnId: string } } | null = null

    const a = {
      name, id, chatId, folder, root, markerPaths, logs, repeats, begins, replays, revokes, unrecorded, firesPath,
      get session() { return session },
      get tracker() { return life.tracker },
      get intake() { return life.intake },
      spoolDir: () => join(root, 'hooks', safeSessionKey(session)),
      /**
       * The daemon restarts (a new process: nothing in memory survives) and the
       * CLI comes back with --resume (same session) or a fresh one. `envProof`:
       * the CLI handed the server the session id of an existing transcript.
       */
      restart({ envProof = true, fresh = false }: { envProof?: boolean; fresh?: boolean } = {}) {
        life.intake.stop()
        if (fresh) {
          session = randomUUID()
          transcript = join(projectDir, `${session}.jsonl`)
          writeFileSync(transcript, '')
        }
        proven = envProof
        life = daemon(() => (proven ? transcript : null))
        a.hook('SessionStart', { source: fresh ? 'startup' : 'resume' })
        a.pump()
      },
      pump() { life.intake.pump() },
      /** The CLI's prompt_id of the last submission (one per submission, shared by all its hooks). */
      lastPromptId: '',
      /** The CLI fires a hook: the synchronous private turn hook(s), then the async forwarder(s). */
      hook(event: string, extra: Record<string, unknown> = {}, runs: Runs = {}) {
        const submission = event === 'UserPromptSubmit' ? { prompt_id: randomUUID() } : {}
        const payload = { session_id: session, transcript_path: transcript, cwd: folder, hook_event_name: event, permission_mode: 'bypassPermissions', ...submission, ...extra }
        if (event === 'UserPromptSubmit') a.lastPromptId = String(payload.prompt_id)
        const privateEvent = ['UserPromptSubmit', 'Stop', 'SessionEnd'].includes(event)
        const privateRuns = privateEvent ? (runs.privateRuns ?? 1) : 0
        const forwarderRuns = runs.forwarderRuns ?? 1
        for (let i = 0; i < privateRuns; i++) {
          if (i === 1 && runs.secondPrivateAfterDrain) break
          const recorded = recordPrivateBoundary(payload, hookEnv)
          if (recorded) marker = recorded
        }
        for (let i = 0; i < forwarderRuns; i++) appendEvent(payload, { env: hookEnv })
        if (privateRuns === 2 && runs.secondPrivateAfterDrain) {
          // The second hook source's run lands after the daemon drained the line and adopted the first marker.
          a.pump()
          const recorded = recordPrivateBoundary(payload, hookEnv)
          if (recorded) marker = recorded
        }
      },
      /** The socket lane (server.ts deliverWsInbound): actor, turn chat, private delivery; then the CLI's prompt. */
      deliver(frame: Record<string, any>, runs: Runs = {}, extra: Record<string, unknown> = {}) {
        const prompt = a.card(frame)
        a.hook('UserPromptSubmit', { prompt, ...extra }, runs)
        return prompt
      },
      /** The same delivery with no prompt of its own: the CLI injects the card into the turn that is running. */
      card(frame: Record<string, any>): string {
        const agentOrigin = frame.agentOrigin ?? null
        const senderType = String(frame.senderType ?? (agentOrigin ? 'agent' : 'user'))
        const channel = buildInboundChannel({
          chatId: frame.chatId, messageId: frame.messageId, userId: privateSenderUserId(frame) ?? OWNER, assistantId: id,
          transport: 'ws', text: frame.text, files: frame.files, senderType, agentOrigin, serverSender: frame,
        })
        life.turnChat.note({ chatId: frame.chatId, messageId: frame.messageId, kind: senderType === 'agent' ? 'peer' : senderType === 'system' ? 'system' : 'user', text: frame.text, now: Date.now() })
        const content = life.tracker.deliver({
          content: channel.content, chatId: frame.chatId, peerSourceAssistantId: agentOrigin?.sourceAssistantId,
          fireKey: privateFireKeyOf({ senderType, eventMeta: frame.eventMeta, messageId: frame.messageId }),
          actingUserId: privateActor({ senderType, senderUserId: privateSenderUserId(frame), agentOrigin, eventMeta: frame.eventMeta }),
        })
        return renderChannel(content, channel.meta)
      },
      /** What the daemon answers the model's first private call with. */
      privateCall() {
        try { return requirePrivateTurn(life.tracker, markerPaths, OWNER) } catch { return null }
      },
      publish() { life.publish() },
      ready() { return marker ? readPrivateJson(`${marker.path}.ready`, 2048) : null },
      liveMarker() { return marker ? readPrivateJson(marker.path, 2048) : null },
    }
    return a
  }

  /** Nothing in this spool has been touched for 31 minutes (lib/hook-intake.ts SESSION_SWEEP_MS). */
  function idle(dir: string, minutes = 31) {
    const when = new Date(Date.now() - minutes * 60_000)
    for (const name of readdirSync(dir)) utimesSync(join(dir, name), when, when)
    utimesSync(dir, when, when)
  }
  /** A same-session private turn file left at another folder's key, as on the reported PC. */
  function plantStaleMarker(session: string, folder: string) {
    writePrivateJson(privateMarkerPath(root, floorKey(folder)), {
      schemaVersion: 1, turnId: '354c5ab3-0000-4000-8000-000000000000', sessionId: session, promptHash: 'f'.repeat(64), live: true,
    })
  }
  return { base, root, agent, idle, plantStaleMarker }
}

interface VeraShape {
  /** A neighbour agent on the same home (the reported PC runs several). */
  neighbour?: boolean
  /** The session sat idle past the sweep before the wake. */
  longIdle?: boolean
  /** A same-session private turn file sits at another key. */
  staleMarker?: boolean
  /** The restarted daemon had the CLI's env proof (bound at SessionStart); otherwise the wake proves itself. */
  envProof?: boolean
  /** hoai-core on a linked folder falls back to a fresh session at the restart. */
  freshSession?: boolean
}

/**
 * Vera's day: an owner turn, a daemon restart, an idle session that a
 * neighbour's daemon sweeps (Vera's daemon keeps its cursor), then the frame.
 */
function veraDay(t: any, frame: (chatId: number) => Record<string, any>, runs: Runs, shape: VeraShape = {}) {
  const { neighbour = true, longIdle = true, staleMarker = true, envProof = true, freshSession = false } = shape
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const nova = neighbour ? host.agent('nova', '910', 5002) : null
  // Before the restart: an owner turn binds and passes, and the turn ends.
  vera.deliver(ownerFrame(vera.chatId))
  vera.pump()
  nova?.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER, 'the owner turn before the restart passes')
  vera.hook('Stop', { stop_hook_active: false })
  vera.pump()
  // 18:06:27: the restart. A new daemon, the session resumed (or fresh), SessionStart spooled.
  vera.restart({ envProof, fresh: freshSession })
  nova?.pump()
  if (staleMarker) host.plantStaleMarker(vera.session, join(host.base, 'agents'))
  if (longIdle) {
    host.idle(vera.spoolDir())
    // The first daemon to pump after the 30 minutes sweeps it: the neighbour's when there is one, so Vera's
    // daemon keeps its cursor and the wake's recreated spool is drained from the top.
    ;(nova ?? vera).pump()
    assert.equal(existsSync(vera.spoolDir()), false, 'the idle sweep removed the spool')
  }
  // 18:45: the frame, its prompt, and every daemon draining.
  const atWake = vera.logs.length
  const prompt = vera.deliver(frame(vera.chatId), runs)
  nova?.pump()
  vera.pump()
  return { host, vera, nova, prompt, wakeLines: vera.logs.slice(atWake) }
}

/** The PC's log at the wake: the reset line and nothing else from the intake. */
const onlyResetLine = (lines: string[]) =>
  lines.length === 1 && /was rotated, truncated or recreated; draining it from the top/.test(lines[0]!)

/** The wake opened the owner's turn, and the receipt names the live marker. */
function assertOwnerTurn(vera: any, label: string) {
  const call = vera.privateCall()
  assert.ok(call, `${label}: boards_query is not refused as "current sender could not be verified"`)
  assert.equal(call.actingUserId, OWNER, label)
  assert.deepEqual(call.headers, {}, `${label}: it acts as the owner, with no acting user header`)
  vera.publish()
  assert.equal(vera.liveMarker()?.live, true, `${label}: the marker is live`)
  assert.equal(vera.ready()?.turnId, vera.liveMarker()?.turnId, `${label}: .ready names the live marker's turn`)
}

// ── The reported shape ───────────────────────────────────────────────────────

test('Vera: the reset drain reaches begin() and the wake opens the owner’s turn (no duplicate: PR 221 already holds)', (t) => {
  const { vera, wakeLines } = veraDay(t, (c) => wakeFrame(c), {})
  assert.ok(onlyResetLine(wakeLines), `the only intake line at the wake is the reset line, exactly as on the PC: ${JSON.stringify(wakeLines)}`)
  assertOwnerTurn(vera, 'single records')
  assert.deepEqual(vera.repeats, [], 'one record of each boundary: nothing to report')
})

test('Vera: the private hook runs twice for the wake and the second run lands after the daemon adopted the first', (t) => {
  const { vera, wakeLines } = veraDay(t, (c) => wakeFrame(c), { privateRuns: 2, secondPrivateAfterDrain: true })
  assert.ok(onlyResetLine(wakeLines), `the only intake line at the wake is the reset line: ${JSON.stringify(wakeLines)}`)
  assertOwnerTurn(vera, 'second private hook run after adoption')
  assert.ok(vera.repeats.some((l: string) => /the marker was stamped again for the same submission .*the turn stands/.test(l)), `the daemon says the marker was stamped again: ${JSON.stringify(vera.repeats)}`)
})

test('Vera: the forwarder spools the wake twice (a second hook source)', (t) => {
  const { vera, wakeLines } = veraDay(t, (c) => wakeFrame(c), { forwarderRuns: 2 })
  assert.ok(onlyResetLine(wakeLines), `the only intake line at the wake is the reset line: ${JSON.stringify(wakeLines)}`)
  assertOwnerTurn(vera, 'wake spooled twice')
  assert.deepEqual(vera.repeats, [privateRepeatLine({ kind: 'prompt', sessionId: vera.session })], 'the daemon says the prompt arrived twice, once')
})

test('Vera: both hooks doubled, the daemon unbound after the restart (the wake proves itself)', (t) => {
  const { vera } = veraDay(t, (c) => wakeFrame(c), { privateRuns: 2, forwarderRuns: 2, secondPrivateAfterDrain: true }, { envProof: false })
  assertOwnerTurn(vera, 'unbound, both doubled')
})

test('Vera: fresh session at the restart (linked folder fallback), the wake spooled twice', (t) => {
  const { vera } = veraDay(t, (c) => wakeFrame(c), { forwarderRuns: 2 }, { freshSession: true })
  assertOwnerTurn(vera, 'fresh session, spooled twice')
})

// ── Controls: positions ──────────────────────────────────────────────────────

for (const [label, shape] of Object.entries({
  'right after the restart (no idle), stale marker absent': { longIdle: false, staleMarker: false } as VeraShape,
  'after a long idle, stale marker absent': { longIdle: true, staleMarker: false } as VeraShape,
  'one agent on the home (its own daemon sweeps), stale marker present': { neighbour: false, longIdle: true, staleMarker: true } as VeraShape,
  'one agent on the home, right after the restart': { neighbour: false, longIdle: false, staleMarker: false } as VeraShape,
})) {
  test(`control (${label}): a doubled wake opens the owner’s turn`, (t) => {
    const { vera } = veraDay(t, (c) => wakeFrame(c), { privateRuns: 2, forwarderRuns: 2, secondPrivateAfterDrain: true }, shape)
    assertOwnerTurn(vera, label)
  })
  test(`control (${label}): a single wake opens the owner’s turn`, (t) => {
    const { vera } = veraDay(t, (c) => wakeFrame(c), {}, shape)
    assertOwnerTurn(vera, label)
  })
}

// ── Controls: who may open a private turn (unchanged) ────────────────────────

const DOUBLED: Runs = { privateRuns: 2, forwarderRuns: 2, secondPrivateAfterDrain: true }

test('control: an owner typed message, doubled, opens the owner’s turn', (t) => {
  const { vera } = veraDay(t, (c) => ownerFrame(c), DOUBLED)
  assertOwnerTurn(vera, 'owner message doubled')
})

test('control: a peer agent’s message, doubled, reaches begin() and is still refused, and stays counted', (t) => {
  const { vera } = veraDay(t, (c) => peerFrame(c), DOUBLED)
  assert.equal(vera.privateCall(), null, 'a peer agent never opens a private turn')
  assert.equal(vera.tracker.peerTurn()?.sourceAssistantId, '1040', 'the second record does not erase the peer behind the turn')
})

test('control: a wake naming a stranger, doubled, never runs with the owner’s authority', (t) => {
  const { vera } = veraDay(t, (c) => wakeFrame(c, 'user_stranger42'), DOUBLED)
  const call = vera.privateCall()
  assert.notEqual(call?.actingUserId, OWNER)
  assert.deepEqual(call?.headers, { 'X-BGOS-Acting-User': 'user_stranger42' }, 'the call names the stranger, never the owner')
})

test('control: an unverified system message (not a scheduler wake), doubled, is refused', (t) => {
  const { vera } = veraDay(t, (c) => wakeFrame(c, OWNER, 'n8n'), DOUBLED)
  assert.equal(vera.privateCall(), null)
})

// ── Controls: a second record never revives or extends a turn ────────────────

test('control: a second record after the turn ended never reopens it', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const prompt = vera.deliver(ownerFrame(vera.chatId))
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER)
  vera.hook('Stop', { stop_hook_active: false })
  vera.pump()
  assert.equal(vera.privateCall(), null)
  // The same prompt recorded again (both hooks) after Stop: nothing reopens.
  vera.hook('UserPromptSubmit', { prompt })
  vera.pump()
  assert.equal(vera.privateCall(), null, 'a late duplicate after Stop admits nobody')
})

test('control: a second record after another person’s card revoked the turn never revives it', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const prompt = vera.deliver(ownerFrame(vera.chatId))
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER)
  vera.tracker.deliver({ content: 'from a peer', actingUserId: null, chatId: '5001', peerSourceAssistantId: 1040 })
  assert.equal(vera.privateCall(), null, 'the peer card revoked the turn')
  vera.hook('UserPromptSubmit', { prompt }, { privateRuns: 1, forwarderRuns: 1 })
  vera.pump()
  assert.equal(vera.privateCall(), null, 'the duplicate does not revive the revoked turn')
})

test('control: the next prompt still clears the turn, also an untokened one typed twice', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  // Typed at the terminal before the owner's turn: the same words again later are a NEW prompt.
  vera.hook('UserPromptSubmit', { prompt: 'continue' })
  vera.pump()
  vera.hook('Stop', { stop_hook_active: false })
  vera.pump()
  vera.deliver(ownerFrame(vera.chatId))
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER)
  for (let i = 0; i < 2; i++) {
    vera.hook('UserPromptSubmit', { prompt: 'continue' }, { privateRuns: 2, forwarderRuns: 2 })
    vera.pump()
    assert.equal(vera.privateCall(), null, `a prompt with no delivery admits nobody, though its words were seen before (#${i + 1})`)
  }
})

test('control: a new prompt clears the turn even when only its forwarder ran (no marker of its own)', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  vera.hook('UserPromptSubmit', { prompt: 'continue' })
  vera.pump()
  vera.hook('Stop', { stop_hook_active: false })
  vera.pump()
  vera.deliver(ownerFrame(vera.chatId))
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER)
  // The marker still names the owner's prompt: only the begin() rule can stop the turn running on.
  vera.hook('UserPromptSubmit', { prompt: 'continue' }, { privateRuns: 0 })
  vera.pump()
  assert.equal(vera.privateCall(), null, 'words seen before are still a new prompt')
})

test('control: the same tokened prompt recorded in another session clears the turn', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const prompt = vera.deliver(ownerFrame(vera.chatId))
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER)
  // The very same submission (prompt and prompt_id) recorded under another session id.
  vera.tracker.begin({ prompt, sessionId: randomUUID(), promptId: vera.lastPromptId })
  assert.equal(vera.privateCall(), null, 'a turn never follows its prompt into another session')
})

test('control: the same words submitted again without a Stop (an interrupt) end the turn, whichever hook records them', (t) => {
  for (const runs of [{ privateRuns: 1, forwarderRuns: 1 }, { privateRuns: 2, forwarderRuns: 2 }, { privateRuns: 1, forwarderRuns: 0 }, { privateRuns: 0, forwarderRuns: 1 }] as Runs[]) {
    const host = fleetHost(t)
    const vera = host.agent('vera', '909', 5001)
    const prompt = vera.deliver(ownerFrame(vera.chatId))
    vera.pump()
    assert.equal(vera.privateCall()?.actingUserId, OWNER)
    // Claude Code fires no Stop on an interrupt: the next submission of the same text is a new prompt.
    vera.hook('UserPromptSubmit', { prompt }, runs)
    vera.pump()
    assert.equal(vera.privateCall(), null, `a resubmission never keeps the turn (${JSON.stringify(runs)})`)
  }
})

test('control: a late record of an older submission never displaces the newer turn', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const ownerPrompt = vera.deliver(ownerFrame(vera.chatId))
  const ownerPromptId = vera.lastPromptId
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER)
  vera.deliver(wakeFrame(vera.chatId, 'user_stranger42'))
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, 'user_stranger42')
  // The owner submission's second forwarder line lands late.
  vera.hook('UserPromptSubmit', { prompt: ownerPrompt, prompt_id: ownerPromptId }, { privateRuns: 0, forwarderRuns: 1 })
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, 'user_stranger42', 'the newer turn stands')
  // And a late private hook run of it: the marker now names the older submission, so nobody may act.
  vera.hook('UserPromptSubmit', { prompt: ownerPrompt, prompt_id: ownerPromptId }, { privateRuns: 1, forwarderRuns: 0 })
  assert.equal(vera.privateCall(), null, 'never the owner’s authority again')
})

test('control: past 64 remembered submissions a late record fails closed', () => {
  const tracker = createPrivateTurnTracker()
  const first = { prompt: tracker.deliver({ content: 'first', actingUserId: OWNER, chatId: '1' }), promptId: randomUUID() }
  tracker.begin({ ...first, sessionId: 's' })
  for (let i = 0; i < 64; i++) {
    tracker.begin({ prompt: tracker.deliver({ content: `next ${i}`, actingUserId: OWNER, chatId: '1' }), sessionId: 's', promptId: randomUUID() })
  }
  const root = mkdtempSync(join(tmpdir(), 'dup-cap-'))
  try {
    const last = tracker.deliver({ content: 'last', actingUserId: 'user_shared7', chatId: '2' })
    const lastId = randomUUID()
    tracker.begin({ prompt: last, sessionId: 's', promptId: lastId })
    const markerPath = privateMarkerPath(root, 'k')
    writePrivateJson(markerPath, { schemaVersion: 1, turnId: 't', sessionId: 's', promptHash: privatePromptHash(last), live: true, promptId: lastId })
    assert.equal(tracker.current({ markerPaths: [markerPath] })?.actingUserId, 'user_shared7')
    // The first submission fell out of the memory: its late record is a new prompt, its token is spent.
    tracker.begin({ ...first, sessionId: 's' })
    assert.equal(tracker.current({ markerPaths: [markerPath] }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('control: without the CLI’s prompt_id a second record is a new prompt (fails closed, as before)', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  // An older CLI: no prompt_id on any hook. The same tokened words recorded again are a new prompt.
  const prompt = vera.deliver(ownerFrame(vera.chatId), {}, { prompt_id: undefined })
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER)
  vera.hook('UserPromptSubmit', { prompt, prompt_id: undefined }, { privateRuns: 0, forwarderRuns: 1 })
  vera.pump()
  assert.equal(vera.privateCall(), null)
})

test('control: a marker rewritten for another prompt or another session never carries the turn', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const prompt = vera.deliver(ownerFrame(vera.chatId))
  vera.pump()
  const turn = vera.privateCall()
  assert.equal(turn?.actingUserId, OWNER)
  const path = turn!.markerPath
  // Each one even claims this very submission's prompt_id: the other checks must hold on their own.
  const promptId = vera.lastPromptId
  const stamp = (fields: Record<string, unknown>) =>
    writePrivateJson(path, { schemaVersion: 1, turnId: randomUUID(), sessionId: vera.session, promptHash: privatePromptHash(prompt), live: true, promptId, ...fields })
  stamp({})
  assert.equal(vera.privateCall()?.actingUserId, OWNER, 'the same live submission stamped again is followed')
  stamp({ promptHash: privatePromptHash(`${prompt} `) })
  assert.equal(vera.privateCall(), null, 'another prompt’s marker')
  stamp({ sessionId: 'another-session' })
  assert.equal(vera.privateCall(), null, 'another session’s marker')
  stamp({ live: false })
  assert.equal(vera.privateCall(), null, 'a closed marker')
})

test('control: two different deliveries in one prompt stay ambiguous, recorded once or twice', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const a = vera.tracker.deliver({ content: 'a', actingUserId: OWNER, chatId: '5001' })
  const b = vera.tracker.deliver({ content: 'b', actingUserId: OWNER, chatId: '5001' })
  vera.hook('UserPromptSubmit', { prompt: `${a}\n${b}` }, { privateRuns: 2, forwarderRuns: 2 })
  vera.pump()
  assert.equal(vera.privateCall(), null)
})

test('the repeat lines name what happened and stay one line each', () => {
  assert.equal(privateRepeatLine({ kind: 'prompt', sessionId: 's1' }), 'private turn: the same submission reached the daemon twice in session s1; what its first record decided stands. Is the hook forwarder registered twice?')
  assert.equal(privateRepeatLine({ kind: 'restamp', from: 'a', to: 'b' }), 'private turn: the marker was stamped again for the same submission (turn a became b); the turn stands. Is the private turn hook registered twice?')
  for (const line of [privateRepeatLine({ kind: 'prompt', sessionId: 's' }), privateRepeatLine({ kind: 'restamp', from: 'a', to: 'b' })]) {
    assert.ok(!line.includes('\n') && !/[\u2013\u2014]/.test(line))
  }
})

// ── Vera, 18:45 (Mark's facts via Data, 2026-10-12 22:15Z): the ids, the next turn, and what the daemon says ──

test('the delivered token and the marker turnId are minted apart and never compared: the wake opens its turn', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const prompt = vera.deliver(wakeFrame(vera.chatId))
  vera.pump()
  // The daemon minted the token at delivery (lib/private-turn.mjs deliver); the hook minted the turnId (recordPrivateBoundary).
  const token = /<hoai-private-turn id="([a-f0-9-]{36})"\/>/.exec(prompt)![1]
  const marker = vera.liveMarker()
  assert.notEqual(marker.turnId, token, 'two different ids, as on the PC (db0acead and 19a3c691)')
  assertOwnerTurn(vera, 'mismatched ids')
})

test('begin() says what it decided for every prompt', () => {
  let clock = 1_000
  const tracker = createPrivateTurnTracker({ now: () => clock })
  const begin = (prompt: string, promptId: string = randomUUID()) => tracker.begin({ prompt, sessionId: 's', promptId })
  const owner = tracker.deliver({ content: 'a', actingUserId: OWNER, chatId: '1' })
  assert.equal(begin(owner, 'p1'), 'opened')
  assert.equal(begin(owner, 'p1'), 'repeat')
  assert.equal(begin('typed at the terminal'), 'no-token')
  assert.equal(begin(owner, 'p2'), 'unknown-token', 'its token is spent')
  assert.equal(begin(`${tracker.deliver({ content: 'b', actingUserId: OWNER, chatId: '1' })}\n${tracker.deliver({ content: 'c', actingUserId: OWNER, chatId: '1' })}`), 'ambiguous')
  assert.equal(begin(tracker.deliver({ content: 'd', actingUserId: null, chatId: '1', peerSourceAssistantId: 1040 })), 'peer')
  assert.equal(begin(tracker.deliver({ content: 'e', actingUserId: null, chatId: '1' })), 'no-actor')
  const old = tracker.deliver({ content: 'f', actingUserId: OWNER, chatId: '1' })
  clock += 16 * 60_000
  assert.equal(begin(old), 'expired')
  for (const outcome of ['opened', 'ambiguous', 'unknown-token', 'expired', 'peer', 'no-actor']) {
    const line = privateBeginLineOf(outcome, 's')
    assert.match(line, /^private turn: /)
    assert.ok(!line.includes('\n') && !/[\u2013\u2014]/.test(line), line)
  }
})

test('a refused private call says which check failed, marker by marker', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const explain = () => explainOf(vera.tracker, vera.markerPaths)
  assert.match(explain(), /no private turn is open/)
  vera.deliver(ownerFrame(vera.chatId))
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER)
  // The hook wrote the next prompt's marker where this daemon does not read (Vera's shape if the key moved).
  const elsewhere = privateMarkerPath(vera.root, floorKey(join(host.base, 'agents')))
  const live = vera.liveMarker()
  writePrivateJson(elsewhere, { ...live, turnId: randomUUID() })
  for (const p of vera.markerPaths) writePrivateJson(p, { schemaVersion: 1, turnId: randomUUID(), sessionId: vera.session, promptHash: 'e'.repeat(64), live: false })
  assert.equal(vera.privateCall(), null)
  const text = explain()
  assert.match(text, /admitted user_owner909/)
  assert.match(text, /live=false session=same prompt=eeeeeeeeeeee/)
  assert.ok(!text.includes(elsewhere.split(/[\\/]/).pop()!), 'it reads only its own keys, and says which')
  // Another session's marker at the daemon's key is named as such.
  for (const p of vera.markerPaths) writePrivateJson(p, { schemaVersion: 1, turnId: randomUUID(), sessionId: 'another-session-0001', promptHash: live.promptHash, live: true })
  assert.match(explain(), /live=true session=another-sess prompt=same/)
})

test('the next turn: a hook killed before its write, an invalidated Stop record, a deleted marker beside a stale live one', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  vera.deliver(ownerFrame(vera.chatId))
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER)
  vera.hook('Stop', { stop_hook_active: false })
  vera.pump()
  // 11:06: the private turn hook times out before it writes: this turn has no marker of its own and is refused...
  vera.deliver(ownerFrame(vera.chatId, 'Please list the boards again (a slow hook).'), { privateRuns: 0, forwarderRuns: 1 })
  vera.pump()
  assert.equal(vera.privateCall(), null, 'the turn whose hook never wrote is refused')
  vera.hook('Stop', { stop_hook_active: false }, { privateRuns: 0 })
  vera.pump()
  // ...and leaves nothing behind: the next one opens.
  vera.deliver(ownerFrame(vera.chatId, 'Please list the boards (after the timeout).'))
  vera.pump()
  assertOwnerTurn(vera, 'after a timed out hook')
  vera.hook('Stop', { stop_hook_active: false })
  vera.pump()
  // 18:45:29: a Stop the hook could not record turns the marker empty (invalidatePrivateBoundary): the next turn opens.
  for (const p of vera.markerPaths) if (readPrivateJson(p, 2048)) writePrivateJson(p, { schemaVersion: 1, turnId: randomUUID(), sessionId: '', promptHash: '', live: false })
  vera.deliver(ownerFrame(vera.chatId, 'Please list the boards (after an empty Stop record).'))
  vera.pump()
  assertOwnerTurn(vera, 'after an invalidated Stop record')
  vera.hook('Stop', { stop_hook_active: false })
  vera.pump()
  // The marker deleted (the invalidation's own fallback) while a stale live one of this session sits at an ancestor key.
  for (const p of vera.markerPaths) rmSync(p, { force: true })
  host.plantStaleMarker(vera.session, join(host.base, 'agents'))
  vera.deliver(ownerFrame(vera.chatId, 'Please list the boards (marker deleted, stale one beside).'))
  vera.pump()
  assertOwnerTurn(vera, 'after a deleted marker beside a stale live one')
})

// ── Review of the diagnostics: an adopted turn, a revoked turn, and words that cannot mislead ──

test('a refused call after adoption names the adopted marker and what changed in it', () => {
  const root = mkdtempSync(join(tmpdir(), 'dup-explain-'))
  try {
    const tracker = createPrivateTurnTracker()
    const pA = privateMarkerPath(root, 'a'.repeat(32))
    const pB = privateMarkerPath(root, 'b'.repeat(32))
    const prompt = tracker.deliver({ content: 'list the boards', actingUserId: OWNER, chatId: '1' })
    const hash = privatePromptHash(prompt)
    const stamp = (p: string, fields: Record<string, unknown>) =>
      writePrivateJson(p, { schemaVersion: 1, turnId: randomUUID(), sessionId: 's', promptHash: hash, live: true, promptId: 'p1', ...fields })
    stamp(pA, {})
    tracker.begin({ prompt, sessionId: 's', promptId: 'p1' })
    const adopted = tracker.current({ markerPaths: [pA, pB] })!
    assert.equal(adopted.actingUserId, OWNER)
    // Stamped again by a private turn hook that names another submission (an older copy writes none).
    stamp(pA, { promptId: 'p2' })
    assert.equal(tracker.current({ markerPaths: [pA, pB] }), null)
    let text = explainOf(tracker, [pA, pB])
    assert.match(text, new RegExp(`adopted ${'a'.repeat(32)}\\.json as turn ${adopted.turnId.slice(0, 8)}`))
    assert.match(text, /turn=other promptId=p2/)
    assert.match(text, /other files are not read again once a turn is adopted/)
    // The adopted file closed while another file is live for the same prompt: still refused, and said so.
    stamp(pA, { live: false, promptId: 'p1' })
    stamp(pB, {})
    assert.equal(tracker.current({ markerPaths: [pA, pB] }), null)
    text = explainOf(tracker, [pA, pB])
    assert.match(text, /live=false/)
    assert.ok(!text.includes('b'.repeat(32)), 'only the adopted file is named once a turn is adopted')
    // Before adoption: a schemaVersion other than 1 is named, and a field cannot break the line.
    const t2 = createPrivateTurnTracker()
    const p2 = t2.deliver({ content: 'again', actingUserId: OWNER, chatId: '1' })
    writePrivateJson(pA, { schemaVersion: 2, turnId: 'x', sessionId: 's\nforged line', promptHash: privatePromptHash(p2), live: true })
    t2.begin({ prompt: p2, sessionId: 's', promptId: 'p3' })
    assert.equal(t2.current({ markerPaths: [pA] }), null)
    text = explainOf(t2, [pA])
    assert.match(text, /schema=2/)
    assert.ok(!/[\r\n]/.test(text), 'a marker field never splits the log line')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a revoked turn and an ended turn are told apart, and the revoke is reported', () => {
  const revokes: any[] = []
  const tracker = createPrivateTurnTracker({ onRevoke: (info: any) => revokes.push(info) })
  const open = (chatId = '1') => {
    tracker.begin({ prompt: tracker.deliver({ content: 'go', actingUserId: OWNER, chatId }), sessionId: 's', promptId: randomUUID() })
  }
  open()
  tracker.deliver({ content: 'from a peer', actingUserId: null, chatId: '1', peerSourceAssistantId: 1040 })
  assert.deepEqual(revokes.at(-1), { chatId: '1', why: 'a peer agent' })
  assert.match(explainOf(tracker, []), /revoked by a delivery from a peer agent \(chat 1\)/)
  open()
  tracker.deliver({ content: 'system', actingUserId: null, chatId: '1' })
  assert.deepEqual(revokes.at(-1), { chatId: '1', why: 'no verified sender' })
  open()
  tracker.deliver({ content: 'hi', actingUserId: 'user_other7', chatId: '1' })
  assert.deepEqual(revokes.at(-1), { chatId: '1', why: 'another person' })
  open()
  tracker.deliver({ content: 'hi', actingUserId: OWNER, chatId: '2' })
  assert.deepEqual(revokes.at(-1), { chatId: '2', why: 'another chat' })
  open()
  tracker.end()
  assert.match(explainOf(tracker, []), /ended \(Stop or SessionEnd\)/)
  open()
  assert.match(explainOf(tracker, []), /admitted/)
  tracker.end()
  tracker.begin({ prompt: 'a plain prompt', sessionId: 's', promptId: randomUUID() })
  assert.doesNotMatch(explainOf(tracker, []), /ended|revoked/, 'a new prompt forgets how the last turn closed')
  assert.deepEqual(revokes.map((info) => privateRevokeLineOf(info).replace(/ ended the private turn.*/, '')), [
    'private turn: a delivery from a peer agent (chat 1)',
    'private turn: a delivery with no verified sender (chat 1)',
    'private turn: a delivery from another person (chat 1)',
    'private turn: a delivery from the same person in another chat (chat 2)',
  ])
  for (const info of revokes) {
    const line = privateRevokeLineOf(info)
    assert.match(line, /^private turn: .* ended the private turn; nobody may act until the next prompt$/)
    assert.ok(!/[\r\n\u2013\u2014]/.test(line), line)
  }
})

test('the begin line says admitted, not usable, and a missing token has words', () => {
  assert.match(privateBeginLineOf('opened', 's'), /admitted its sender; the turn is usable once its marker matches/)
  assert.match(privateBeginLineOf('no-token', 's'), /opens no private turn: it carries no delivery token/)
})

test('a scheduler delivery without actingUserId (the n8n reminder) opens no private turn, and the log line says what it lacks', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const reminder = n8nReminderFrame(vera.chatId)
  // The actor comes from eventMeta.payload.actingUserId alone: the sender block naming the owner is not one.
  assert.equal(privateActor({ senderType: 'system', senderUserId: privateSenderUserId(reminder), eventMeta: reminder.eventMeta }), null)
  vera.deliver(reminder)
  vera.pump()
  assert.equal(vera.privateCall(), null, 'boards_query refuses: nobody verified sent the reminder')
  assert.deepEqual(vera.begins, [
    `private turn: the prompt in session ${vera.session} opens no private turn: its delivery names no verified sender: ` +
      'neither a person\'s own message with their user_ id nor a scheduler event carrying eventMeta.payload.actingUserId',
  ])
  assert.match(explainOf(vera.tracker, vera.markerPaths), new RegExp(`no private turn is open \\(the last prompt, in session ${vera.session}: no-actor\\)`))
  // Control: the same reminder with the owner stamped as its acting user opens the owner's turn, fireId or not.
  const stamped = n8nReminderFrame(vera.chatId)
  ;(stamped.eventMeta.payload as Record<string, unknown>).actingUserId = OWNER
  vera.deliver(stamped)
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER)
  assert.match(vera.begins.at(-1)!, /admitted its sender/)
  // Control: the native wake opens it too.
  vera.hook('Stop', { stop_hook_active: false })
  vera.pump()
  vera.deliver(wakeFrame(vera.chatId))
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER)
})

test('what a scheduler card needs for a private turn: actingUserId, and nothing else the native wake carries', (t) => {
  // Vera, 2026-10-13: the native wake passed (02:30Z) carrying actingUserId, scheduledTaskId and fireId; the n8n
  // reminder (02:40Z) carried none of them and was refused. Which ones does begin() need?
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const turn = (frame: Record<string, any>) => {
    vera.deliver(frame)
    vera.pump()
    const actor = vera.privateCall()?.actingUserId ?? null
    vera.hook('Stop', { stop_hook_active: false })
    vera.pump()
    return actor
  }
  const withPayload = (frame: Record<string, any>, payload: Record<string, unknown>) => ({ ...frame, eventMeta: { ...frame.eventMeta, payload } })
  const native = wakeFrame(vera.chatId)
  const { actingUserId, ...nativeWithoutActor } = native.eventMeta.payload
  assert.equal(actingUserId, OWNER)
  // The native wake as it arrives: the owner's turn.
  assert.equal(turn(native), OWNER)
  // The same wake without actingUserId, scheduledTaskId, fireId, ack and dueAt kept: no turn.
  assert.equal(turn(withPayload(wakeFrame(vera.chatId), nativeWithoutActor)), null)
  // The n8n reminder with ONLY actingUserId added: the owner's turn, no scheduledTaskId, fireId or ack needed.
  const reminder = n8nReminderFrame(vera.chatId)
  assert.equal(turn(withPayload(reminder, { ...reminder.eventMeta.payload, actingUserId: OWNER })), OWNER)
  // actingUserId alone, nothing else in the payload: still the owner's turn.
  assert.equal(turn(withPayload(n8nReminderFrame(vera.chatId), { actingUserId: OWNER })), OWNER)
  // Spelled or shaped otherwise it names nobody: snake case, a numeric id, another prefix, a non string.
  for (const payload of [{ acting_user_id: OWNER }, { actingUserId: '909' }, { actingUserId: 'usr_owner909' }, { actingUserId: [OWNER] }]) {
    assert.equal(turn(withPayload(n8nReminderFrame(vera.chatId), payload)), null, JSON.stringify(payload))
  }
  // Another person's id opens THEIR turn, never the owner's: each private call then names them to the backend.
  assert.equal(turn(withPayload(n8nReminderFrame(vera.chatId), { actingUserId: 'user_colleague7' })), 'user_colleague7')
  // And the card must say it comes from the scheduler, as a system message.
  assert.equal(turn({ ...withPayload(n8nReminderFrame(vera.chatId), { actingUserId: OWNER }), eventMeta: { source: 'n8n', payload: { actingUserId: OWNER } } }), null)
  assert.equal(turn({ ...withPayload(n8nReminderFrame(vera.chatId), { actingUserId: OWNER }), senderType: 'agent', agentOrigin: { sourceAssistantId: 888, sourceName: 'Mark', targetAssistantId: 909 } }), null)
})

// ── Vera, 2026-10-13: a wake already handled comes back after a restart (0.68.4) ──
//
// After restarts on 0.68.3, two old native wakes (messages 118303 and 118672) came back as backlog and were each
// admitted as a FRESH private turn, one with a new private-turn token. The poll lane's boot restart recovery re-offers
// a system card the agent answered (lib/poll-core.ts selectRestartRecoveryIds: only an assistant row after a USER row
// stops it), each re-offer is delivered with a new token and a new 15 minute window, and the tracker is per process.
// Delivery is at least once, so the plugin keeps the fires it opened a turn for, per agent, on disk, for 48 hours.

/** Deliver one frame, let the daemon take it, and say whose private turn it opened (null: none); then end the turn. */
function turnOf(a: any, frame: Record<string, any>): string | null {
  a.deliver(frame)
  a.pump()
  const actor = a.privateCall()?.actingUserId ?? null
  a.hook('Stop', { stop_hook_active: false })
  a.pump()
  return actor
}
/** The n8n reminder with the owner stamped as its acting user (the backend's stamp). */
function stampedReminder(chatId: number) {
  const card = n8nReminderFrame(chatId)
  ;(card.eventMeta.payload as Record<string, unknown>).actingUserId = OWNER
  return card
}
const HOUR = 3600_000

test('Vera replay: the same native wake delivered again after a restart, with a new token, opens no private turn', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const wake = wakeFrame(vera.chatId)
  const fireId = wake.eventMeta.payload.fireId
  assert.equal(turnOf(vera, wake), OWNER, 'the first delivery opens the owner turn')
  assert.equal(vera.replays.length, 0)
  // The daemon restarts; its boot poll re-offers the answered wake as backlog. Same message, same fire, new token.
  vera.restart()
  const before = vera.begins.length
  const prompt = vera.deliver(wake)
  vera.pump()
  assert.match(prompt, /Check the boards/, 'the replay still reaches the agent as text')
  assert.match(prompt, /<hoai-private-turn id="[a-f0-9-]{36}"\/>/)
  assert.equal(vera.privateCall(), null, 'boards_query refuses: the fire was already handled')
  assert.equal(vera.replays.length, 1, 'one line for the replayed prompt')
  assert.match(vera.replays[0]!, new RegExp(`^private turn: replayed fire native:${fireId}, already handled at \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$`))
  const handledAt = readPrivateJson(vera.firesPath, 262144)?.fires?.[`native:${fireId}`]
  assert.ok(vera.replays[0]!.endsWith(`already handled at ${new Date(handledAt).toISOString()}`), 'the time it was first handled, not now')
  assert.ok(!vera.begins.slice(before).some((line: string) => /admitted its sender/.test(line)), vera.begins.join('\n'))
  assert.match(explainOf(vera.tracker, vera.markerPaths), /no private turn is open \(the last prompt, in session [^:]+: replayed\)/)
  // Control: a different fire after the restart opens.
  vera.hook('Stop', { stop_hook_active: false })
  vera.pump()
  assert.equal(turnOf(vera, wakeFrame(vera.chatId)), OWNER, 'a new fire opens the owner turn')
})

test('Vera replay: the replay arriving twice through two hook sources is one repeat, still one line', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const wake = wakeFrame(vera.chatId)
  assert.equal(turnOf(vera, wake), OWNER)
  vera.restart()
  vera.deliver(wake, DOUBLED)
  vera.pump()
  assert.equal(vera.privateCall(), null)
  assert.equal(vera.replays.length, 1, 'a second record of the same submission is a repeat, not a second replay')
})

test('Vera replay: the same fire with a new message id (a re-fire) is also caught, keyed by its fireId', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const wake = wakeFrame(vera.chatId)
  assert.equal(turnOf(vera, wake), OWNER)
  vera.restart()
  assert.equal(turnOf(vera, { ...wakeFrame(vera.chatId), eventMeta: wake.eventMeta }), null)
  assert.equal(vera.replays.length, 1)
})

test('Vera replay: an n8n card replay (same scheduled_action_id and message id) is caught; its next recurrence opens', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const card = stampedReminder(vera.chatId)
  assert.equal(turnOf(vera, card), OWNER)
  vera.restart()
  assert.equal(turnOf(vera, card), null)
  assert.equal(vera.replays.length, 1)
  assert.match(vera.replays[0]!, new RegExp(`^private turn: replayed fire n8n:${card.eventMeta.payload.scheduled_action_id}:${card.messageId}, already handled at `))
  assert.equal(turnOf(vera, stampedReminder(vera.chatId)), OWNER, 'the same action\'s next card (a new message id) opens')
  // An unstamped reminder opens no turn at all, and leaves no key behind.
  const unstamped = n8nReminderFrame(vera.chatId)
  assert.equal(turnOf(vera, unstamped), null)
  assert.ok(!JSON.stringify(readPrivateJson(vera.firesPath, 262144) ?? {}).includes(`:${unstamped.messageId}"`))
})

test('Vera replay: the set survives daemon restarts, in the agent\'s own state folder', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const wake = wakeFrame(vera.chatId)
  assert.equal(turnOf(vera, wake), OWNER)
  vera.restart()
  vera.restart()
  assert.equal(turnOf(vera, wake), null, 'two restarts later the fire is still known')
  assert.equal(vera.firesPath, join(host.root, '909', 'private-fires.json'))
  const ledger = readPrivateJson(vera.firesPath, 262144)
  assert.equal(ledger?.v, 1)
  assert.equal(typeof ledger?.fires?.[`native:${wake.eventMeta.payload.fireId}`], 'number')
})

test('Vera replay: a fire handled more than 48 hours ago opens again; one handled 47 hours ago does not', (t) => {
  const clock = { now: Date.now() }
  const host = fleetHost(t, { now: () => clock.now })
  const vera = host.agent('vera', '909', 5001)
  const wake = wakeFrame(vera.chatId)
  const other = wakeFrame(vera.chatId)
  assert.equal(turnOf(vera, wake), OWNER)
  assert.equal(turnOf(vera, other), OWNER)
  vera.restart()
  clock.now += 47 * HOUR
  assert.equal(turnOf(vera, wake), null, '47 hours later it is still a replay')
  vera.restart()
  clock.now += 2 * HOUR
  assert.equal(turnOf(vera, wake), OWNER, '49 hours after it was handled the key has expired')
  // The other fire, handled 49 hours ago and never seen since, is pruned from the file when it is written again.
  const keys = Object.keys(readPrivateJson(vera.firesPath, 262144)?.fires ?? {})
  assert.deepEqual(keys, [`native:${wake.eventMeta.payload.fireId}`])
})

test('Vera replay: two agents on one home keep separate sets', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const nova = host.agent('nova', '910', 5002)
  const wake = wakeFrame(vera.chatId)
  assert.equal(turnOf(vera, wake), OWNER)
  // The same fire id reaching Nova (her own card for it) is not Vera's fire.
  assert.equal(turnOf(nova, { ...wakeFrame(nova.chatId), eventMeta: wake.eventMeta }), OWNER)
  assert.notEqual(vera.firesPath, nova.firesPath)
  vera.restart()
  assert.equal(turnOf(vera, wake), null, 'Vera still knows her own')
})

// Vera, 2026-10-13 15:05Z, 15:13Z and 15:15Z (Mark on 2bf7978): restart recovery re-offered KC's owner message 119731,
// answered as 119866, on every restart (lib/poll-core.ts counts an assistant row as an answer only right after a user
// row, and a system row sat between), and each time it was admitted as a fresh owner private turn. A person's message
// is now in the ledger too, as owner:<message id>, once it opened a usable turn (release 0.68.4).
const ledgerKeysOf = (a: any): string[] => Object.keys(readPrivateJson(a.firesPath, 262144)?.fires ?? {})

test('Vera owner replay: KC\'s answered message, re-offered after each restart, reaches the agent as text and opens no private turn', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const kc = ownerFrame(vera.chatId, 'Can you check the Tasks board and tell me what is overdue?')
  assert.equal(turnOf(vera, kc), OWNER, 'the first delivery opens the owner turn')
  for (const restart of [1, 2, 3]) {
    vera.restart()
    const before = vera.begins.length
    const prompt = vera.deliver(kc)
    vera.pump()
    assert.equal(vera.privateCall(), null, `restart ${restart}: the re-offer opens no turn (2bf7978 admitted it as a fresh owner turn)`)
    const handledAt = readPrivateJson(vera.firesPath, 262144)?.fires?.[`owner:${kc.messageId}`]
    assert.equal(typeof handledAt, 'number', 'recorded once its first turn was usable')
    assert.match(prompt, /Can you check the Tasks board/, 'the replay still reaches the agent as text')
    assert.match(prompt, /^<channel [^>]*>\n\[replayed: this message was already handled at [^;]+; it opens no private turn\]\n/)
    assert.ok(prompt.includes(`already handled at ${new Date(handledAt).toISOString()};`), 'the time it was first handled, not now')
    assert.equal(vera.replays.length, restart, 'one line per replayed prompt')
    assert.equal(vera.replays.at(-1), `private turn: replayed fire owner:${kc.messageId}, already handled at ${new Date(handledAt).toISOString()}`)
    assert.ok(!vera.begins.slice(before).some((line: string) => /admitted its sender/.test(line)), vera.begins.join('\n'))
    assert.match(explainOf(vera.tracker, vera.markerPaths), /no private turn is open \(the last prompt, in session [^:]+: replayed\)/)
    vera.hook('Stop', { stop_hook_active: false })
    vera.pump()
  }
  assert.deepEqual(ledgerKeysOf(vera), [`owner:${kc.messageId}`], 'a replay records nothing')
})

test('Vera owner replay, control: a new owner message after the restart opens its turn, before and after the replay', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const kc = ownerFrame(vera.chatId)
  assert.equal(turnOf(vera, kc), OWNER)
  vera.restart()
  assert.equal(turnOf(vera, ownerFrame(vera.chatId, 'A new question, sent after the restart.')), OWNER, 'a new owner message opens')
  assert.equal(turnOf(vera, kc), null, 'the re-offer does not')
  assert.equal(turnOf(vera, ownerFrame(vera.chatId, 'And one more.')), OWNER, 'the next new one opens again')
  assert.equal(vera.replays.length, 1)
})

test('Vera owner replay, control: the re-offer injected into a new owner turn ends it, and is marked as a replay', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const kc = ownerFrame(vera.chatId)
  assert.equal(turnOf(vera, kc), OWNER)
  vera.restart()
  vera.deliver(ownerFrame(vera.chatId, 'A new question, sent after the restart.'))
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER, 'the new message opens its turn')
  const injected = vera.card(kc)
  assert.match(injected, /^<channel [^>]*>\n\[replayed: this message was already handled at /)
  assert.equal(vera.privateCall(), null, 'the old request never runs with the owner\'s authority')
  assert.match(vera.revokes.at(-1)!, /^private turn: a delivery that replays a scheduled fire, voice consult or message already handled \(chat 5001\) ended the private turn/)
})

test('Vera owner replay, control: the boot order, the re-offer and a new owner message both delivered before the first prompt', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const kc = ownerFrame(vera.chatId)
  assert.equal(turnOf(vera, kc), OWNER)
  vera.restart()
  // The boot poll's sweep delivers the re-offer, and a new message arrives, before any prompt begins.
  const replay = vera.card(kc)
  const fresh = vera.card(ownerFrame(vera.chatId, 'A new question, sent during the boot.'))
  // Each runs as its own prompt, in order: the re-offer opens nothing, the new message opens its turn.
  vera.hook('UserPromptSubmit', { prompt: replay })
  vera.pump()
  assert.equal(vera.privateCall(), null)
  assert.equal(vera.replays.length, 1)
  vera.hook('Stop', { stop_hook_active: false })
  vera.pump()
  vera.hook('UserPromptSubmit', { prompt: fresh })
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER, 'the new message opens its turn')
})

test('Vera owner replay, control: a new owner message whose prompt begins while the re-offer still waits opens no turn; the next one does', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const kc = ownerFrame(vera.chatId)
  assert.equal(turnOf(vera, kc), OWNER)
  vera.restart()
  vera.card(kc)
  vera.deliver(ownerFrame(vera.chatId, 'A new question, its prompt first.'))
  vera.pump()
  assert.equal(vera.privateCall(), null, 'the old request may run inside this turn: nobody may act in it')
  assert.match(vera.begins.at(-1)!, /opens no private turn: a replayed scheduled fire, voice consult or message was delivered just before it, and the CLI may run it inside this turn$/)
  vera.deliver(ownerFrame(vera.chatId))
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER)
})

test('Vera owner replay, control: an owner message that never got a usable turn of its own still opens one when re-offered', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  // Begun, but no marker: never usable.
  const unmarked = ownerFrame(vera.chatId, 'The private hook never ran for this one.')
  vera.deliver(unmarked, { privateRuns: 0 })
  vera.pump()
  assert.equal(vera.privateCall(), null, 'no marker, no usable turn')
  vera.hook('Stop', { stop_hook_active: false })
  vera.pump()
  // Injected into another owner turn with no prompt of its own (the same owner, the same chat: that turn stands).
  vera.deliver(ownerFrame(vera.chatId, 'The turn it was injected into.'))
  vera.pump()
  const injected = ownerFrame(vera.chatId, 'Injected mid turn.')
  vera.card(injected)
  assert.equal(vera.privateCall()?.actingUserId, OWNER)
  vera.hook('Stop', { stop_hook_active: false })
  vera.pump()
  // Delivered, never begun before the restart.
  const lost = ownerFrame(vera.chatId, 'Delivered just before the restart.')
  vera.card(lost)
  const keys = ledgerKeysOf(vera)
  for (const frame of [unmarked, injected, lost]) assert.ok(!keys.includes(`owner:${frame.messageId}`), `${frame.text}: ${keys.join(', ')}`)
  vera.restart()
  for (const frame of [unmarked, injected, lost]) assert.equal(turnOf(vera, frame), OWNER, `${frame.text}: its re-offer opens`)
  assert.equal(vera.replays.length, 0)
})

test('Vera owner replay, control: two agents on one home keep separate entries', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const nova = host.agent('nova', '910', 5002)
  const kc = ownerFrame(vera.chatId)
  assert.equal(turnOf(vera, kc), OWNER)
  assert.notEqual(vera.firesPath, nova.firesPath)
  assert.ok(!ledgerKeysOf(nova).includes(`owner:${kc.messageId}`), 'nothing in Nova\'s ledger')
  // The same message id reaching Nova (one chat both agents sit in) is not hers to have handled.
  nova.restart()
  assert.equal(turnOf(nova, { ...kc, chatId: nova.chatId }), OWNER)
  vera.restart()
  assert.equal(turnOf(vera, kc), null, 'Vera still knows her own')
  const other = ownerFrame(nova.chatId)
  assert.equal(turnOf(nova, other), OWNER)
  vera.restart()
  assert.equal(turnOf(vera, { ...other, chatId: vera.chatId }), OWNER, 'and Nova\'s own is not Vera\'s')
})

test('Vera owner replay, control: an owner message handled more than 48 hours ago opens again; one handled 47 hours ago does not', (t) => {
  const clock = { now: Date.now() }
  const host = fleetHost(t, { now: () => clock.now })
  const vera = host.agent('vera', '909', 5001)
  const kc = ownerFrame(vera.chatId)
  assert.equal(turnOf(vera, kc), OWNER)
  vera.restart()
  clock.now += 47 * HOUR
  assert.equal(turnOf(vera, kc), null, '47 hours later it is still a replay')
  vera.restart()
  clock.now += 2 * HOUR
  assert.equal(turnOf(vera, kc), OWNER, '49 hours after it was handled the key has expired')
})

test('Vera replay: a fire whose key cannot be recorded gives no usable turn (fail closed), and the refusal says so', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  // The ledger path is a folder: nothing can be written there.
  mkdirSync(vera.firesPath, { recursive: true })
  const wake = wakeFrame(vera.chatId)
  vera.deliver(wake)
  vera.pump()
  assert.equal(vera.privateCall(), null)
  assert.match(explainOf(vera.tracker, vera.markerPaths), new RegExp(`but its scheduled fire native:${wake.eventMeta.payload.fireId} could not be recorded as handled`))
  vera.hook('Stop', { stop_hook_active: false })
  vera.pump()
  const owner = ownerFrame(vera.chatId)
  assert.equal(turnOf(vera, owner), OWNER, 'an owner message does not need the ledger')
  const line = `private turn: owner:${owner.messageId} could not be recorded in the fire ledger; its turn stands, but a re-offer of this message after a restart would open a private turn again`
  assert.deepEqual(vera.unrecorded, [line], 'and the daemon says its replay will not be caught')
  // Not recorded, so its re-offer after a restart opens as on 0.68.3 (fail open for a person's own message).
  vera.restart()
  assert.equal(turnOf(vera, owner), OWNER)
  assert.deepEqual(vera.unrecorded, [line, line])
})

test('Vera replay: a replayed fire injected into the owner\'s running turn ends it, says why, and is marked as a replay', (t) => {
  // The review's case: restart recovery re-offers an owner row and an answered wake together, and the CLI injects
  // the wake into the owner's turn with no prompt of its own. Its work was done when it was handled.
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const wake = wakeFrame(vera.chatId)
  assert.equal(turnOf(vera, wake), OWNER)
  vera.restart()
  vera.deliver(ownerFrame(vera.chatId))
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER, 'the owner\'s backlog turn is open')
  const injected = vera.card(wake)
  assert.match(injected, /^<channel [^>]*>\n\[replayed: this scheduled fire was already handled at \d{4}-\d\d-\d\dT[^;]+; it opens no private turn\]\n/)
  assert.equal(vera.privateCall(), null, 'nobody may act until the next prompt')
  assert.match(vera.revokes.at(-1)!, /^private turn: a delivery that replays a scheduled fire, voice consult or message already handled \(chat 5001\) ended the private turn/)
})

test('Vera replay: the boot order, a replay swept in before the owner\'s backlog prompt: that prompt opens no turn, the next one does', (t) => {
  // Restart recovery re-offers the owner's "hi" and an answered wake together, in the boot sweep, before the hook
  // intake starts: no turn is open when the replay is delivered, and the CLI may inject it into the owner's turn.
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const wake = wakeFrame(vera.chatId)
  assert.equal(turnOf(vera, wake), OWNER)
  vera.restart()
  vera.card(wake)
  vera.deliver(ownerFrame(vera.chatId, 'hi, are the boards up to date?'))
  vera.pump()
  assert.equal(vera.privateCall(), null, 'the replay may run inside this turn: nobody may act in it')
  assert.match(vera.begins.at(-1)!, /opens no private turn: a replayed scheduled fire, voice consult or message was delivered just before it, and the CLI may run it inside this turn$/)
  // The next prompt (no Stop in between: the replay was taken in the turn above, or is its own prompt by now) opens.
  vera.deliver(ownerFrame(vera.chatId))
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER)
})

test('Vera replay: the backend firing the same fire again in one daemon life, before the first is recorded, opens one turn', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const first = wakeFrame(vera.chatId)
  const again = { ...wakeFrame(vera.chatId), eventMeta: first.eventMeta }
  // Both delivered while a long turn runs; the CLI queues them.
  vera.deliver(ownerFrame(vera.chatId))
  vera.pump()
  const firstPrompt = vera.card(first)
  const againPrompt = vera.card(again)
  assert.match(againPrompt, /\[replayed: this scheduled fire was already handled at /, 'the second delivery is a replay from the start')
  vera.hook('Stop', { stop_hook_active: false })
  vera.pump()
  vera.hook('UserPromptSubmit', { prompt: firstPrompt })
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER, 'the first one opens')
  vera.hook('Stop', { stop_hook_active: false })
  vera.pump()
  vera.hook('UserPromptSubmit', { prompt: againPrompt })
  vera.pump()
  assert.equal(vera.privateCall(), null, 'the second one does not')
  assert.equal(vera.replays.length, 1)
})

test('Vera replay: a fire whose first delivery was begun but never usable is not used up by it: its re-fire in the same life opens', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const first = wakeFrame(vera.chatId)
  vera.deliver(first, { privateRuns: 0 })
  vera.pump()
  assert.equal(vera.privateCall(), null, 'no marker, no usable turn')
  vera.hook('Stop', { stop_hook_active: false })
  vera.pump()
  assert.equal(turnOf(vera, { ...wakeFrame(vera.chatId), eventMeta: first.eventMeta }), OWNER, 'the re-fire is its first usable turn')
  assert.equal(vera.replays.length, 0)
})

test('Vera replay: a new fire injected into the owner\'s turn is handled there; its replay after a restart opens nothing', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  vera.deliver(ownerFrame(vera.chatId))
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER)
  const wake = wakeFrame(vera.chatId)
  vera.card(wake)
  assert.equal(vera.privateCall()?.actingUserId, OWNER, 'the same owner in the same chat: the turn stands')
  vera.hook('Stop', { stop_hook_active: false })
  vera.pump()
  assert.equal(typeof readPrivateJson(vera.firesPath, 262144)?.fires?.[`native:${wake.eventMeta.payload.fireId}`], 'number', 'handled when the turn ended')
  vera.restart()
  assert.equal(turnOf(vera, wake), null)
  assert.equal(vera.replays.length, 1)
})

test('Vera replay: a fire delivered just before another prompt began is handled; its own prompt after that still opens', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const wake = wakeFrame(vera.chatId)
  const wakePrompt = vera.card(wake)
  // The owner's prompt begins first (back to back after a restart): the wake may be injected into it, so it is
  // handled as that prompt begins, before the turn ends (a restart mid turn would otherwise lose it).
  vera.deliver(ownerFrame(vera.chatId))
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER)
  assert.equal(typeof readPrivateJson(vera.firesPath, 262144)?.fires?.[`native:${wake.eventMeta.payload.fireId}`], 'number', 'recorded when the owner\'s prompt began')
  vera.hook('Stop', { stop_hook_active: false })
  vera.pump()
  // But the CLI queued it: its own prompt now begins, and it is the original delivery, not a replay.
  vera.hook('UserPromptSubmit', { prompt: wakePrompt })
  vera.pump()
  assert.equal(vera.privateCall()?.actingUserId, OWNER, 'the original opens its turn')
  assert.equal(vera.replays.length, 0)
})

test('Vera replay: a fire whose turn opened but never became usable (no marker) is not used up; its replay opens', (t) => {
  const host = fleetHost(t)
  const vera = host.agent('vera', '909', 5001)
  const wake = wakeFrame(vera.chatId)
  vera.deliver(wake, { privateRuns: 0 })
  vera.pump()
  assert.equal(vera.privateCall(), null, 'no marker, no usable turn')
  vera.hook('Stop', { stop_hook_active: false })
  vera.pump()
  assert.equal(existsSync(vera.firesPath), false, 'not handled')
  vera.restart()
  assert.equal(turnOf(vera, wake), OWNER, 'the replay is its one chance, and it opens')
})

test('privateFireKey: a native wake by its fireId, an n8n card by its action and message id, a person\'s message by its id, nothing else', () => {
  const key = (input: Record<string, unknown>) => privateFireKeyOf(input)
  const wake = { source: 'scheduler', payload: { scheduledTaskId: 77, fireId: '3f2a9c1e-0000-4000-8000-000000000001', actingUserId: OWNER } }
  assert.equal(key({ senderType: 'system', eventMeta: wake, messageId: 1 }), 'native:3f2a9c1e-0000-4000-8000-000000000001')
  assert.equal(key({ senderType: 'SYSTEM', eventMeta: { ...wake, payload: { ...wake.payload, fireId: '77-1791857622844' } }, messageId: 1 }), 'native:77-1791857622844')
  const reminder = { source: 'scheduler', payload: { scheduled_action_id: 'a0da1344-0000-4000-8000-000000000000', agent_id: null } }
  assert.equal(key({ senderType: 'system', eventMeta: reminder, messageId: 118672 }), 'n8n:a0da1344-0000-4000-8000-000000000000:118672')
  assert.equal(key({ senderType: 'system', eventMeta: reminder, messageId: '118672' }), 'n8n:a0da1344-0000-4000-8000-000000000000:118672')
  // A person's own message is its message id, whatever eventMeta it carries (release 0.68.4).
  assert.equal(key({ senderType: 'user', messageId: 119731 }), 'owner:119731')
  assert.equal(key({ senderType: 'USER', eventMeta: wake, messageId: '119731' }), 'owner:119731')
  for (const input of [
    { senderType: 'user', messageId: 0 },
    { senderType: 'user', messageId: -5 },
    { senderType: 'user', messageId: 1.5 },
    { senderType: 'user', messageId: 'abc' },
    { senderType: 'user', messageId: null },
    { senderType: 'user' },
    { senderType: 'agent', eventMeta: wake, messageId: 1 },
    { senderType: 'agent', messageId: 1 },
    { senderType: 'external_email', messageId: 1 },
    { senderType: 'email', eventMeta: wake, messageId: 1 },
    { senderType: 'system', eventMeta: { ...wake, source: 'n8n' }, messageId: 1 },
    { senderType: 'system', eventMeta: { source: 'scheduler', payload: JSON.stringify(wake.payload) }, messageId: 1 },
    { senderType: 'system', eventMeta: { source: 'scheduler', payload: [wake.payload] }, messageId: 1 },
    { senderType: 'system', eventMeta: { source: 'scheduler', payload: { fireId: '' } }, messageId: 0 },
    { senderType: 'system', eventMeta: { source: 'scheduler', payload: { fireId: 'x'.repeat(300) } }, messageId: null },
    { senderType: 'system', eventMeta: reminder, messageId: null },
    { senderType: 'system', eventMeta: reminder, messageId: 0 },
    { senderType: 'system', eventMeta: null, messageId: 1 },
    {},
  ]) assert.equal(key(input), null, JSON.stringify(input))
  // Any other scheduler card with a usable message id is that message: restart recovery re-offers it unchanged.
  assert.equal(key({ senderType: 'system', eventMeta: { source: 'scheduler', payload: { fireId: '' } }, messageId: 4242 }), 'scheduler:4242')
  assert.equal(key({ senderType: 'system', eventMeta: { source: 'scheduler', payload: { actingUserId: OWNER } }, messageId: 4242 }), 'scheduler:4242')
})

test('the fire ledger: read on every check, pruned on every write, a junk file is empty, another writer is merged', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-fires-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const path = join(base, '909', 'private-fires.json')
  const clock = { now: 1_800_000_000_000 }
  const ledger: any = createFireLedgerOf({ path, now: () => clock.now })
  assert.ok(ledger, 'createFireLedger exists')
  assert.equal(ledger.handledAt('native:a'), null)
  assert.equal(ledger.record('native:a'), true)
  assert.equal(ledger.handledAt('native:a'), clock.now)
  // Another daemon of the same agent (a handover) records into the same file: both survive.
  const rival: any = createFireLedgerOf({ path, now: () => clock.now })
  clock.now += 1000
  assert.equal(rival.record('native:b'), true)
  assert.equal(ledger.handledAt('native:b'), clock.now, 'a key written by another writer is seen')
  assert.equal(ledger.record('native:c'), true)
  assert.deepEqual(Object.keys(readPrivateJson(path, 262144).fires).sort(), ['native:a', 'native:b', 'native:c'])
  // 48 hours plus one millisecond after 'a': it is gone from reads and from the next write.
  clock.now += 48 * HOUR + 1 - 1000
  assert.equal(ledger.handledAt('native:a'), null)
  assert.equal(ledger.record('native:d'), true)
  assert.deepEqual(Object.keys(readPrivateJson(path, 262144).fires).sort(), ['native:b', 'native:c', 'native:d'])
  // A junk file reads as empty and is replaced on the next write; nothing throws.
  writeFileSync(path, '{not json')
  assert.equal(ledger.handledAt('native:d'), null)
  assert.equal(ledger.record('native:e'), true)
  assert.deepEqual(Object.keys(readPrivateJson(path, 262144).fires), ['native:e'])
  // Bounded: the oldest keys go first past the cap.
  for (let i = 0; i < 1100; i++) { clock.now += 1; ledger.record(`native:k${i}`) }
  const kept = Object.keys(readPrivateJson(path, 262144).fires)
  assert.equal(kept.length, 1000)
  assert.ok(kept.includes('native:k1099') && !kept.includes('native:k0') && !kept.includes('native:e'))
  // A path that cannot be written answers false and never throws.
  const blocked: any = createFireLedgerOf({ path: join(base, '909', 'private-fires.json', 'x', 'y.json'), now: () => clock.now })
  assert.equal(blocked.record('native:z'), false)
  assert.equal(blocked.handledAt('native:z'), null)
})
