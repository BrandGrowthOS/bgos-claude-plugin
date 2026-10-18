/**
 * Two deliveries submitted together run as one turn, and that turn opens its private turn (ptpending).
 *
 * THE REPORT (Mark, agent 888, plugin 0.68.4, 2026-10-14 08:00:15Z, bgos-plugin-888.log lines 37243 to 37245).
 * Wakes 1460 and 1658 fired in the same second. Both prompts logged "admitted its sender; the turn is usable once
 * its marker matches", then boards_update refused: "admitted user_369z... (prompt 5ca60a030597), waiting for its
 * marker; none of the files this daemon reads matches". A retry a minute later still refused. A single wake earlier
 * the same day worked.
 *
 * WHAT THE CLI DOES (measured on claude 2.1.299, macOS, with a stand in channel server pushing two events in the
 * same millisecond). Both events run in ONE turn: one answer, one Stop. UserPromptSubmit runs once per event, in
 * order, each with its own prompt (one token) and its own prompt_id; there is no combined prompt. The second
 * event's synchronous hooks start only when the first event's have ended, so the private turn hook writes the
 * first marker, then the second, and the marker left is the LAST prompt's. The async forwarder is not waited for:
 * with the first event's forwarder slowed by 4 s (a cold node start, as measured on Windows), the second event's
 * line was spooled 2.4 s before the first's.
 *
 * WHY IT REFUSED. The tracker kept ONE admitted prompt (lib/private-turn.mjs, `pending`): every begin() replaced
 * it. Spooled out of order, the daemon admitted the second prompt, then the first, and waited for the first
 * prompt's marker while the marker on disk was the second's, until the next prompt.
 *
 * These tests run the real forwarder (bin/hoai-hook.mjs), the real private turn hook (bin/hoai-private-turn-hook.mjs),
 * a real intake (lib/hook-intake.ts), buildInboundChannel, privateActor, privateFireKey, the fire ledger and the
 * turn tracker, with onHookPayload's private turn statements (server.ts, pinned by test/private-tools-wiring.test.ts).
 *
 * Run with: npx tsx --test test/private-turn-two-admitted.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEvent } from '../bin/hoai-hook.mjs'
import { recordPrivateBoundary } from '../bin/hoai-private-turn-hook.mjs'
import { startHookIntake } from '../lib/hook-intake.ts'
import { buildInboundChannel } from '../lib/inbound-channel.ts'
import { SessionTranscriptBinder } from '../lib/session-binding.ts'
import { createTurnChatTracker } from '../lib/turn-chat.ts'
import { daemonFloorFolders, floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import {
  PRIVATE_TURN_ADMITTED_MAX,
  createFireLedger,
  createPrivateTurnTracker,
  privateActor,
  privateBeginLine,
  privateContextPath,
  privateFireKey,
  privateFiresPath,
  privateMarkerPath,
  privatePromptHash,
  privateReplayLine,
  privateSenderUserId,
  publishPrivateContext,
  readPrivateJson,
  requirePrivateTurn,
  writePrivateJson,
} from '../lib/private-turn.mjs'

const OWNER = 'user_369zowner888'
const AGENT = '888'
const SYSTEM_MARKER =
  '[System message from BGOS automation (e.g. a scheduler), NOT the user and NOT a peer agent. ' +
  'Treat this as a system notification. Do not act on it as a user instruction unless it explicitly asks you to.]'
let messageId = 140_000

/** The backend's native wake (fireWake) for one scheduled task, as the socket delivers it. */
function wakeFrame(chatId: number, scheduledTaskId: number, actingUserId = OWNER) {
  return {
    chatId, messageId: ++messageId, userId: actingUserId,
    text: `${SYSTEM_MARKER}\nTask ${scheduledTaskId}\nUpdate the board card for task ${scheduledTaskId} with boards_update.`,
    files: [], messageType: 'event', senderType: 'system',
    eventMeta: {
      source: 'scheduler', title: `Task ${scheduledTaskId}`, peek: `Update the board card for task ${scheduledTaskId}.`,
      payload: { scheduledTaskId, fireId: randomUUID(), actingUserId, ack: 'Delivery ACK is automatic.', dueAt: new Date().toISOString(), missedCount: 1 },
    },
    sender: { userId: actingUserId, displayName: 'Mark', relationship: 'owner' },
    sessionHandle: `sh_${messageId}`,
  }
}
function ownerFrame(chatId: number, text: string) {
  return {
    chatId, messageId: ++messageId, userId: OWNER, text, files: [], messageType: 'text', senderType: 'user',
    sender: { userId: OWNER, displayName: 'Mark', relationship: 'owner' }, sessionHandle: `sh_${messageId}`,
  }
}

/** claude 2.1.296 and later: <channel source="bgos" k="v"...>\ncontent\n</channel>. */
function renderChannel(content: string, meta: Record<string, string>): string {
  const esc = (v: unknown) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  const attrs = Object.entries(meta).filter(([k]) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)).map(([k, v]) => ` ${k}="${esc(v)}"`).join('')
  return `<channel source="bgos"${attrs}>\n${content.replace(/<\/channel/gi, '<\\channel')}\n</channel>`
}

/**
 * One UserPromptSubmit of the CLI, as two steps the test orders: mark() is the synchronous private turn hook (it
 * writes the marker), spool() is the async forwarder's line, which the CLI does not wait for.
 */
interface Submission { payload: Record<string, unknown>; mark: () => void; spool: () => void }

/** One agent (one daemon and its CLI session) on a home of its own. */
function agentHost(t: any) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-two-admitted-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'home', '.bgos-plugin-state')
  const claudeHome = join(base, 'home', '.claude')
  const folder = join(base, 'agents', 'mark')
  mkdirSync(folder, { recursive: true })
  const projectDir = new SessionTranscriptBinder(folder, { claudeHome }).projectDirectory
  mkdirSync(projectDir, { recursive: true })
  const session = randomUUID()
  const transcript = join(projectDir, `${session}.jsonl`)
  writeFileSync(transcript, '')
  const hookEnv = { BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: folder }
  const folders = daemonFloorFolders({ launchCwd: folder, cwd: folder, env: { CLAUDE_PROJECT_DIR: folder } })
  const markerPaths = [...new Set(folders.map((f: string) => floorKey(f)))].map((key) => privateMarkerPath(root, key))
  const firesPath = privateFiresPath(root, AGENT)
  /** Every fire key the tracker asked the ledger to record, in order, across daemon lives. */
  const recorded: string[] = []
  /** Fire keys whose record fails (a Windows rename that keeps failing). */
  const unwritable = new Set<string>()
  const begins: string[] = []
  const replays: string[] = []

  /** One daemon life (server.ts state is per process; the fire ledger is on disk). */
  function daemon() {
    markFloorAttached({ root, folders, projectDir })
    const ledger = createFireLedger({ path: firesPath })
    const tracker = createPrivateTurnTracker({
      ownerUserId: OWNER,
      fires: {
        handledAt: (key: string) => ledger.handledAt(key),
        record: (key: string) => { recorded.push(key); return unwritable.has(key) ? false : ledger.record(key) },
      },
      onReplay: (replay) => replays.push(privateReplayLine(replay)),
    })
    const turnChat = createTurnChatTracker()
    const publish = () => publishPrivateContext({
      path: privateContextPath(root, AGENT), secret: `pair_${AGENT}`, assistantId: AGENT, ownerUserId: OWNER,
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
  let marker: { path: string; marker: { turnId: string } } | null = null
  const payloadOf = (event: string, extra: Record<string, unknown> = {}) =>
    ({ session_id: session, transcript_path: transcript, cwd: folder, hook_event_name: event, permission_mode: 'bypassPermissions', ...extra })

  const a = {
    session, markerPaths, firesPath, recorded, unwritable, begins, replays,
    get tracker() { return life.tracker },
    /** The socket lane (server.ts deliverWsInbound): actor, fire key, turn chat, private delivery. The card the CLI gets. */
    card(frame: Record<string, any>): string {
      const senderType = String(frame.senderType ?? 'user')
      const channel = buildInboundChannel({
        chatId: frame.chatId, messageId: frame.messageId, userId: privateSenderUserId(frame) ?? OWNER, assistantId: AGENT,
        transport: 'ws', text: frame.text, files: frame.files, senderType, agentOrigin: null, serverSender: frame,
      })
      life.turnChat.note({ chatId: frame.chatId, messageId: frame.messageId, kind: senderType === 'system' ? 'system' : 'user', text: frame.text, now: Date.now() })
      const content = life.tracker.deliver({
        content: channel.content, chatId: frame.chatId,
        fireKey: privateFireKey({ senderType, eventMeta: frame.eventMeta, messageId: frame.messageId }),
        actingUserId: privateActor({ senderType, senderUserId: privateSenderUserId(frame), agentOrigin: null, eventMeta: frame.eventMeta }),
      })
      return renderChannel(content, channel.meta)
    },
    /** The CLI's UserPromptSubmit for one prompt (one prompt_id); nothing runs until the test calls mark() or spool(). */
    prompt(prompt: string, { sessionId = session }: { sessionId?: string } = {}): Submission {
      const payload = { ...payloadOf('UserPromptSubmit', { prompt_id: randomUUID(), prompt }), session_id: sessionId }
      return {
        payload,
        mark: () => { const written = recordPrivateBoundary(payload, hookEnv); if (written) marker = written },
        spool: () => appendEvent(payload, { env: hookEnv }),
      }
    },
    /** The CLI ends the turn: the private turn hook closes the marker, the forwarder spools Stop, the daemon drains. */
    stop() {
      const payload = payloadOf('Stop', { stop_hook_active: false })
      recordPrivateBoundary(payload, hookEnv)
      appendEvent(payload, { env: hookEnv })
      a.pump()
    },
    pump() { life.intake.pump() },
    /** A new daemon process; the CLI resumes the same session. */
    restart() {
      life.intake.stop()
      life = daemon()
      appendEvent(payloadOf('SessionStart', { source: 'resume' }), { env: hookEnv })
      a.pump()
    },
    /** What the daemon answers the model's private call (boards_update) with. */
    privateCall() {
      try { return requirePrivateTurn(life.tracker, markerPaths, OWNER) } catch { return null }
    },
    explain() { return life.tracker.explain({ markerPaths }) },
    publish() { life.publish() },
    liveMarker() { return marker ? readPrivateJson(marker.path, 2048) : null },
    ready() { return marker ? readPrivateJson(`${marker.path}.ready`, 2048) : null },
  }
  return a
}

/** Two wakes that fired in the same second reach the CLI, which runs UserPromptSubmit once for each, in order. */
function twoWakes(t: any, frames?: (chatId: number) => [Record<string, any>, Record<string, any>]) {
  const host = agentHost(t)
  const [frameA, frameB] = frames ? frames(5001) : [wakeFrame(5001, 1460), wakeFrame(5001, 1658)]
  const cardA = host.card(frameA)
  const cardB = host.card(frameB)
  const keys = [frameA, frameB].map((frame) => privateFireKey({ senderType: frame.senderType, eventMeta: frame.eventMeta, messageId: frame.messageId }) as string)
  return { host, frameA, frameB, cardA, cardB, keys }
}

const ADMITTED = (session: string) => privateBeginLine('opened', session)

/** The turn is usable as the owner, and the hook's receipt names the live marker. */
function assertOwnerTurn(host: ReturnType<typeof agentHost>, label: string) {
  const call = host.privateCall()
  assert.ok(call, `${label}: boards_update is not refused as "current sender could not be verified": ${host.explain()}`)
  assert.equal(call.actingUserId, OWNER, label)
  assert.deepEqual(call.headers, {}, `${label}: it acts as the owner, with no acting user header`)
  host.publish()
  assert.equal(host.liveMarker()?.live, true, `${label}: the marker is live`)
  assert.equal(host.ready()?.turnId, host.liveMarker()?.turnId, `${label}: .ready names the live marker's turn`)
}

/** Each fire key of the turn was recorded in the ledger exactly once. */
function assertRecordedOnce(host: ReturnType<typeof agentHost>, keys: string[], label: string) {
  for (const key of keys) {
    assert.equal(host.recorded.filter((k) => k === key).length, 1, `${label}: ${key} recorded exactly once (recorded: ${JSON.stringify(host.recorded)})`)
    assert.equal(typeof readPrivateJson(host.firesPath, 262144)?.fires?.[key], 'number', `${label}: ${key} is in the ledger`)
  }
}

// ── The reported shape, in every order the CLI allows ───────────────────────

/**
 * The private turn hook always runs for the first wake, then for the second (so the marker left is the second
 * prompt's); each forwarder line lands when its node process gets there, and the daemon drains when it drains.
 */
const ORDERS: Record<string, (a: Submission, b: Submission, pump: () => void) => void> = {
  'in order, drained one by one': (a, b, pump) => { a.mark(); a.spool(); pump(); b.mark(); b.spool(); pump() },
  'in order, drained together': (a, b, pump) => { a.mark(); a.spool(); b.mark(); b.spool(); pump() },
  // Mark's PC: wake 1460's forwarder started slowly, so 1658's line was drained first.
  'second line first, drained one by one (Mark)': (a, b, pump) => { a.mark(); b.mark(); b.spool(); pump(); a.spool(); pump() },
  'second line first, drained together': (a, b, pump) => { a.mark(); b.mark(); b.spool(); a.spool(); pump() },
  'second line drained before its own marker': (a, b, pump) => { a.mark(); b.spool(); pump(); b.mark(); a.spool(); pump() },
}

for (const [order, run] of Object.entries(ORDERS)) {
  test(`two wakes in one turn (${order}): the turn opens as the owner and each fire is recorded once`, (t) => {
    const { host, cardA, cardB, keys } = twoWakes(t)
    run(host.prompt(cardA), host.prompt(cardB), () => host.pump())
    assert.deepEqual(host.begins, [ADMITTED(host.session), ADMITTED(host.session)], 'both prompts admitted their sender, as on Mark\'s PC')
    assertOwnerTurn(host, order)
    assertRecordedOnce(host, keys, order)
    // Mark's retry a minute later passes too, and Stop still ends the turn.
    assert.equal(host.privateCall()?.actingUserId, OWNER, `${order}: the retry passes`)
    host.stop()
    assert.equal(host.privateCall(), null, `${order}: Stop ends the turn`)
  })
}

test('two admitted deliveries before any marker, then a marker for the FIRST prompt: the turn opens', (t) => {
  const { host, cardA, cardB, keys } = twoWakes(t)
  const a = host.prompt(cardA)
  const b = host.prompt(cardB)
  a.spool()
  b.spool()
  host.pump()
  assert.deepEqual(host.begins, [ADMITTED(host.session), ADMITTED(host.session)])
  assert.equal(host.privateCall(), null, 'no marker yet: nothing to adopt')
  a.mark()
  assertOwnerTurn(host, 'marker for the first prompt')
  assertRecordedOnce(host, keys, 'marker for the first prompt')
})

test('two admitted deliveries before any marker, then a marker for the second prompt: the turn opens', (t) => {
  const { host, cardA, cardB, keys } = twoWakes(t)
  const a = host.prompt(cardA)
  const b = host.prompt(cardB)
  a.spool()
  b.spool()
  host.pump()
  b.mark()
  assertOwnerTurn(host, 'marker for the second prompt')
  assertRecordedOnce(host, keys, 'marker for the second prompt')
})

test('after the turn, a restart re-offers both wakes: each is a replay and opens no private turn', (t) => {
  const { host, frameA, frameB, cardA, cardB, keys } = twoWakes(t)
  const a = host.prompt(cardA)
  const b = host.prompt(cardB)
  a.spool()
  b.spool()
  host.pump()
  a.mark()
  assertOwnerTurn(host, 'the batch turn')
  host.stop()
  host.restart()
  // The poll lane's restart recovery re-offers both wakes, and the CLI runs them as one turn again.
  const again = [host.prompt(host.card(frameA)), host.prompt(host.card(frameB))]
  for (const sub of again) sub.mark()
  for (const sub of again) sub.spool()
  host.pump()
  assert.equal(host.privateCall(), null, 'a replayed wake opens no private turn')
  for (const key of keys) assert.ok(host.replays.some((line) => line.includes(key)), `${key} is logged as a replay: ${JSON.stringify(host.replays)}`)
  assertRecordedOnce(host, keys, 'after the restart')
})

test('two owner messages sent together, the second one\'s line spooled first: the turn opens and each message is recorded once', (t) => {
  const { host, cardA, cardB, keys } = twoWakes(t, (chatId) => [
    ownerFrame(chatId, 'Here is the report file for later.'),
    ownerFrame(chatId, 'Now update the board card with what the report says.'),
  ])
  assert.deepEqual(keys.map((key) => key.split(':')[0]), ['owner', 'owner'])
  ORDERS['second line first, drained one by one (Mark)']!(host.prompt(cardA), host.prompt(cardB), () => host.pump())
  assertOwnerTurn(host, 'two owner messages')
  assertRecordedOnce(host, keys, 'two owner messages')
})

// ── Controls: still fail closed ──────────────────────────────────────────────

test('control: a marker for a prompt nobody admitted refuses (the two cards as one combined prompt)', (t) => {
  const { host, cardA, cardB } = twoWakes(t)
  const a = host.prompt(cardA)
  const b = host.prompt(cardB)
  a.spool()
  b.spool()
  host.pump()
  // claude never hands the hook a combined prompt (one hook run per event); a marker of one was admitted by nobody.
  const combined = host.prompt(`${cardA}\n${cardB}`)
  combined.mark()
  assert.equal(host.privateCall(), null, 'a marker of an unadmitted prompt never opens the turn')
  assert.match(host.explain(), /waiting for its marker/)
  // Its line too: two tokens in one prompt stay ambiguous and close the turn.
  combined.spool()
  host.pump()
  assert.equal(host.begins.at(-1), privateBeginLine('ambiguous', host.session))
  a.mark()
  assert.equal(host.privateCall(), null, 'after an unadmitted prompt began, an earlier admitted prompt\'s marker refuses')
})

test('while it waits, the refusal names every admitted prompt and says the marker matches none of them', (t) => {
  const { host, cardA, cardB } = twoWakes(t)
  host.prompt(cardA).spool()
  host.prompt(cardB).spool()
  host.pump()
  host.prompt('Also tidy the board while you are at it.').mark()
  const why = host.explain()
  const short = (prompt: string) => createHash('sha256').update(prompt).digest('hex').slice(0, 12)
  assert.ok(why.includes(`prompt ${short(cardA)} or ${short(cardB)}`), `both admitted prompts are named: ${why}`)
  assert.match(why, /waiting for its marker; none of the files this daemon reads matches: .* live=true session=same prompt=[a-f0-9]{12} /)
  host.prompt(cardA, { sessionId: randomUUID() }).mark()
  assert.match(host.explain(), /session=[0-9a-f]{8}-[0-9a-f]{3} prompt=same/, 'a marker of an admitted prompt in another session: the prompt is one of them, the session is not')
})

test('control: a prompt with no delivery token between two admitted ones clears the earlier one', (t) => {
  const { host, cardA, cardB } = twoWakes(t)
  const a = host.prompt(cardA)
  const typed = host.prompt('Also tidy the board while you are at it.')
  const b = host.prompt(cardB)
  a.spool(); host.pump()
  typed.spool(); host.pump()
  b.spool(); host.pump()
  a.mark()
  assert.equal(host.privateCall(), null, 'the first prompt\'s marker refuses: an unadmitted prompt began after it')
  typed.mark()
  assert.equal(host.privateCall(), null, 'the typed prompt\'s marker refuses: nobody admitted it')
  b.mark()
  assertOwnerTurn(host, 'the prompt admitted after the typed one')
})

test('control: another person\'s wake admitted in the same turn never lets the owner\'s prompt open it', (t) => {
  const { host, cardA, cardB } = twoWakes(t, (chatId) => [wakeFrame(chatId, 1460), wakeFrame(chatId, 1658, 'user_stranger42')])
  const a = host.prompt(cardA)
  const b = host.prompt(cardB)
  a.mark()
  a.spool()
  b.spool()
  host.pump()
  assert.deepEqual(host.begins, [ADMITTED(host.session), ADMITTED(host.session)])
  assert.equal(host.privateCall(), null, 'the owner\'s marker refuses once another person was admitted after it')
  b.mark()
  assert.deepEqual(host.privateCall()?.headers, { 'X-BGOS-Acting-User': 'user_stranger42' }, 'only the later sender, never the owner')
})

// Two wakes of the owner in two chats are one turn since 0.71.3 (c09e214e, test/private-turn-owner-authority.test.ts);
// a wake and the owner's message of another chat are still not.
test('control: the owner\'s message in another chat admitted in the same turn never lets the wake\'s prompt open it', (t) => {
  const { host, cardA, cardB } = twoWakes(t, () => [wakeFrame(5001, 1460), ownerFrame(5002, 'And in this chat, the budget.')])
  const a = host.prompt(cardA)
  const b = host.prompt(cardB)
  a.mark()
  a.spool()
  b.spool()
  host.pump()
  assert.equal(host.privateCall(), null, 'the first chat\'s marker refuses once a message of another chat was admitted after it')
})

test('control: a marker of an admitted prompt in another session refuses', (t) => {
  const { host, cardA, cardB } = twoWakes(t)
  host.prompt(cardA).spool()
  host.prompt(cardB).spool()
  host.pump()
  host.prompt(cardA, { sessionId: randomUUID() }).mark()
  assert.equal(host.privateCall(), null)
  assert.match(host.explain(), /waiting for its marker/)
})

test('control: after Stop the turn\'s admitted prompts are gone; the same words again open nothing', (t) => {
  const { host, cardA, cardB } = twoWakes(t)
  ORDERS['in order, drained together']!(host.prompt(cardA), host.prompt(cardB), () => host.pump())
  assertOwnerTurn(host, 'the batch turn')
  host.stop()
  const again = host.prompt(cardA)
  again.mark()
  assert.equal(host.privateCall(), null, 'the first prompt submitted again opens nothing before its line')
  again.spool()
  host.pump()
  assert.equal(host.begins.at(-1), privateBeginLine('unknown-token', host.session))
  assert.equal(host.privateCall(), null)
})

test('a fire of the batch that cannot be recorded gives no usable turn, and the refusal names it', (t) => {
  const { host, cardA, cardB, keys } = twoWakes(t)
  host.unwritable.add(keys[0]!)
  // The order in which 0.68.4 opened this turn on wake 1658 alone and never recorded wake 1460.
  ORDERS['in order, drained together']!(host.prompt(cardA), host.prompt(cardB), () => host.pump())
  assert.equal(host.privateCall(), null, 'wake 1460 ran in this turn but is not recorded, so a replay of it could not be told apart')
  assert.match(host.explain(), new RegExp(`its scheduled fire ${keys[0]} could not be recorded as handled`))
})

// ── The tracker alone: the rules of the admitted list ───────────────────────

/** A tracker, an in memory fire ledger and one marker file the private turn hook would write. */
function bareTracker(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'hoai-two-admitted-unit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const markerPaths = [privateMarkerPath(root, 'agent')]
  const ledger = new Map<string, number>()
  const revokes: string[] = []
  const tracker = createPrivateTurnTracker({
    fires: { handledAt: (key: string) => ledger.get(key) ?? null, record: (key: string) => { ledger.set(key, Date.now()); return true } },
    onRevoke: (info) => revokes.push(info.why),
  })
  const deliver = (fireKey: string | null, chatId = '5001') => tracker.deliver({ content: `card ${randomUUID()}`, actingUserId: OWNER, chatId, fireKey })
  const begin = (prompt: string, sessionId = 'session-a') => tracker.begin({ prompt, sessionId, promptId: randomUUID() })
  const mark = (prompt: string, sessionId = 'session-a') =>
    writePrivateJson(markerPaths[0]!, { schemaVersion: 1, turnId: randomUUID(), sessionId, promptHash: privatePromptHash(prompt), live: true })
  const current = () => tracker.current({ markerPaths })
  return { tracker, ledger, revokes, deliver, begin, mark, current }
}

test('control: a prompt admitted in another session never lets the first session\'s marker open the turn', (t) => {
  const u = bareTracker(t)
  const a = u.deliver('native:a')
  const b = u.deliver('native:b')
  assert.equal(u.begin(a, 'session-b'), 'opened')
  assert.equal(u.begin(b, 'session-a'), 'opened')
  u.mark(a, 'session-b')
  assert.equal(u.current(), null, 'a prompt of another session is another turn')
  u.mark(b, 'session-a')
  assert.equal(u.current()?.actingUserId, OWNER)
})

test('a replayed wake admitted after another prompt of the turn closes it for both', (t) => {
  const u = bareTracker(t)
  // A turn is open; a wake this agent already handled is delivered again and ends it (0.68.4).
  const open = u.deliver('owner:1')
  u.begin(open)
  u.mark(open)
  assert.equal(u.current()?.actingUserId, OWNER)
  u.ledger.set('native:old', Date.now() - 60_000)
  const replayed = u.deliver('native:old')
  assert.deepEqual(u.revokes, ['a replayed fire'])
  const fresh = u.deliver('native:new')
  // The CLI runs both as the next turn; the fresh wake's line is drained first.
  assert.equal(u.begin(fresh), 'opened')
  assert.equal(u.begin(replayed), 'replayed')
  u.mark(fresh)
  assert.equal(u.current(), null, 'the replay runs in this turn, so the prompt admitted before it opens nothing either')
  u.mark(replayed)
  assert.equal(u.current(), null)
})

test('the same wake delivered again while its turn waits for a marker is a replay and ends the wait', (t) => {
  const u = bareTracker(t)
  const a = u.deliver('native:a')
  const b = u.deliver('native:b')
  u.begin(a)
  u.begin(b)
  assert.equal(u.ledger.has('native:a'), false, 'wake a is not recorded yet: its turn was never usable')
  const again = u.deliver('native:a')
  assert.match(again, /^\[replayed: this scheduled fire was already handled at /, 'the backend firing wake a again is caught while it is still in flight')
  assert.deepEqual(u.revokes, ['a replayed fire'])
  u.mark(a)
  assert.equal(u.current(), null)
})

test(`at most ${PRIVATE_TURN_ADMITTED_MAX} prompts are admitted for one turn; the oldest goes first`, (t) => {
  const u = bareTracker(t)
  const prompts = Array.from({ length: PRIVATE_TURN_ADMITTED_MAX + 1 }, () => u.deliver(null))
  for (const prompt of prompts) assert.equal(u.begin(prompt), 'opened')
  u.mark(prompts[0]!)
  assert.equal(u.current(), null, 'the oldest prompt fell off the list')
  u.mark(prompts[1]!)
  assert.equal(u.current()?.actingUserId, OWNER, 'every later one is still admitted')
})

test('control: a voice consult admitted after a wake of the same owner and chat is a turn of its own', (t) => {
  const u = bareTracker(t)
  const wake = u.deliver('native:a')
  const consult = u.tracker.deliver({ content: 'consult card', actingUserId: OWNER, chatId: '5001', consult: { consultId: 'rpc-1', deadline: Date.now() + 30_000 } })
  assert.equal(u.begin(wake), 'opened')
  assert.equal(u.begin(consult), 'opened')
  u.mark(wake)
  assert.equal(u.current(), null, 'the wake\'s marker never opens the consult\'s turn')
  u.mark(consult)
  assert.equal(u.current()?.consultId, 'rpc-1', 'the consult opens its own turn')
})
