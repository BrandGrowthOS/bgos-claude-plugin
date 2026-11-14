/**
 * PROOF: THE BACKEND'S REAL STAMPED CONSULT FRAME, THROUGH THE PLUGIN'S REAL
 * INTAKE, HOOK AND TOOL GATE.
 *
 * test/fixtures/voice-consult-stamped-frame.json is the frame the BGOS backend
 * emitted to the agent in its Postgres integration spec
 * (backend/test/integration/voice/voice-consult-acting-user.spec.ts, written
 * with VOICE_CONSULT_FRAME_OUT): the owner, on their own Clerk session, on a
 * call they minted as a person. VOICE_CONSULT_FRAME_FILE points this test at a
 * freshly captured one instead. The clock is set to the moment the backend
 * sent it (45 s before its expiresAt); nothing else is simulated:
 *
 *   socket payload -> normalizeVoiceRpc -> VoiceRpcHandler.consult ->
 *   server.ts notify (privateTurns.deliver) -> the synchronous private turn
 *   hook on UserPromptSubmit -> privateTurns.begin -> server.ts tool admission
 *   (requirePrivateTurn) -> server.ts schedule tool -> voice_consult_reply ->
 *   server.ts onConsultEnded.
 *
 * Schedule is allowed inside that consult and refused before it, after it was
 * answered, and for a replay of the same frame.
 */
import { channelNotifyFor } from './helpers/channel-notify.ts'
import { createScheduleGrantRuns, requireBoardsTurn } from '../lib/schedule-grant-run.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { createPrivateTurnTracker, privateMarkerPath, requirePrivateTurn } from '../lib/private-turn.mjs'
import { floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import { voiceQuietCard } from '../lib/quiet-turn.mjs'
import { recordPrivateBoundary } from '../bin/hoai-private-turn-hook.mjs'
import { VoiceRpcHandler, normalizeVoiceRpc } from '../lib/voice-rpc.ts'
import { buildScheduleCancelPath, buildScheduleCreateBody, buildScheduleListPath } from '../lib/schedule.js'
import { newScheduleRequestId, sendScheduleCreate } from '../lib/schedule-send.js'

const framePath = process.env.VOICE_CONSULT_FRAME_FILE || join('test', 'fixtures', 'voice-consult-stamped-frame.json')
const raw = readFileSync(framePath, 'utf8')
const wire = JSON.parse(raw)

const source = readFileSync('server.ts', 'utf8')
const voiceDepsStart = source.indexOf('  notify: (content, meta, consult, dispatch) =>')
const voiceDepsSource = source.slice(voiceDepsStart, source.indexOf('  getIdentity: getVoiceIdentity,', voiceDepsStart))
const admissionStart = source.indexOf('  // Freeze private authority at request admission')
const admissionSource = source.slice(admissionStart, source.indexOf('  return trackMessageOperation(async () => {', admissionStart))
const scheduleSource = source.slice(source.indexOf("    case 'schedule': {"), source.indexOf("    case 'create_mission': {"))
function execute(body: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings))
}

test('the backend stamped consult frame allows schedule only inside that consult', async (t) => {
  const stamp = wire.payload.eventMeta.payload
  const owner: string = stamp.actingUserId
  console.log(`[proof] frame ${framePath} sha256=${createHash('sha256').update(raw).digest('hex')}`)
  console.log(`[proof] rpcId=${wire.rpcId} assistant=${wire.assistantId} owner=${owner} expiresAt=${stamp.expiresAt}`)
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(stamp.expiresAt) - 45_000 })

  const root = mkdtempSync(join(tmpdir(), 'hoai-consult-proof-'))
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()))); rmSync(root, { recursive: true, force: true }) })
  const cwd = join(root, 'agent')
  mkdirSync(cwd)
  const env = { ...process.env, BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: cwd }
  markFloorAttached({ root, folders: [cwd] })
  const markerPaths = [privateMarkerPath(root, floorKey(cwd))]
  const privateTurns = createPrivateTurnTracker()

  // server.ts, executed: the voice deps and the private tool admission.
  const cards: string[] = []
  const wiring = execute(`return ({ ${voiceDepsSource} })`, {
    // channelNotify sends through the same double (0.86.20, test/helpers/channel-notify.ts).
    get channelNotify(): ReturnType<typeof channelNotifyFor> { return channelNotifyFor(() => (this as unknown as { mcp: { notification: (n: unknown) => unknown } }).mcp) },
    mcp: { notification: async (n: { params: { content: string } }) => { cards.push(n.params.content) } },
    privateTurns,
    voiceQuietCard, USER_ID: owner,
  })
  const admit = (name: string) => execute(admissionSource + '\nreturn privateCall;', {
    req: { params: { name } }, lockHeld: true, privateTurns, PRIVATE_MARKER_PATHS: markerPaths, USER_ID: owner,
    PRIVATE_HOOK: { registered: true }, PRIVATE_HOOK_MISSING_REFUSAL: 'hook missing', requirePrivateTurn, requireBoardsTurn, scheduleGrantRuns: createScheduleGrantRuns(),
    log: () => {}, recordPeerRefusal: () => ({ line: '' }), pathDirname: () => root, CURSOR_FILE_PATH: join(root, 'cursor.json'), ASSISTANT_ID: wire.assistantId,
  })
  const scheduled: Array<{ path: string; headers: unknown }> = []
  const schedule = async () => {
    const privateCall = await admit('schedule')
    if (privateCall?.isError) return privateCall
    return execute(`return (async () => { switch(name) { ${scheduleSource} } })();`, {
      name: 'schedule', privateCall, buildScheduleCancelPath, buildScheduleCreateBody, buildScheduleListPath, newScheduleRequestId, sendScheduleCreate, log: () => {},
      resolveAuthorizedChat: (chatId: string) => ({ ok: true, chatId }),
      bgosPeerPost: async (path: string, _body: unknown, headers: unknown) => { scheduled.push({ path, headers }); return { ok: true } },
      bgosPeerGet: async () => [], bgosPeerDelete: async () => ({ ok: true }),
      rawArgs: { kind: 'wake', topic: 'Call Sam', when: { everyHours: 2 } },
    })
  }
  const submit = (prompt: string) => {
    recordPrivateBoundary({ hook_event_name: 'UserPromptSubmit', session_id: 'proof-session', cwd, prompt }, env)
    privateTurns.begin({ prompt, sessionId: 'proof-session' })
  }

  const handler = new VoiceRpcHandler({
    config: { openaiApiKey: '', model: '', voice: '', persona: '', assistantId: String(wire.assistantId), userId: owner },
    postAck: async () => {}, postResult: async () => {}, getIdentity: async () => null, log: () => {},
    notify: wiring.notify, onConsultEnded: wiring.onConsultEnded,
    timing: { consultTimeoutMs: 30_000 },
  })

  // Before the consult: refused.
  const before = await schedule()
  assert.equal(before.isError, true)
  assert.match(before.content[0].text, /did not start/)
  console.log(`[proof] before the consult: schedule refused: ${before.content[0].text}`)

  // The socket payload, as the daemon receives it.
  const frame = normalizeVoiceRpc(JSON.parse(raw))!
  const done = handler.handle(frame)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(cards.length, 1)
  assert.match(cards[0]!, /\[voice_consult\]/)
  submit(cards[0]!)

  // Inside the consult: allowed, as the owner, and the schedule request goes out.
  const inside = await schedule()
  assert.notEqual(inside?.isError, true, JSON.stringify(inside))
  assert.equal(scheduled.length, 1)
  assert.deepEqual(scheduled[0]!.headers, {}, 'the owner acts as the owner')
  assert.equal((await admit('boards_list')).actingUserId, owner)
  console.log(`[proof] inside consult ${wire.rpcId}: schedule allowed (POST ${scheduled[0]!.path}), boards_list allowed, actor ${owner}`)

  // The agent answers the call: the turn ends with the consult.
  assert.equal(handler.resolveConsult(String(wire.rpcId), 'Done, I will remind you at five.'), 'resolved')
  await done
  const after = await schedule()
  assert.equal(after.isError, true)
  assert.match(after.content[0].text, /did not start/)
  assert.equal(scheduled.length, 1)
  console.log(`[proof] after voice_consult_reply: schedule refused: ${after.content[0].text}`)

  // The same frame again (a replayed consult_id): a new card, and nobody behind it.
  const replay = handler.handle(normalizeVoiceRpc(JSON.parse(raw))!)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(cards.length, 2)
  submit(cards[1]!)
  const replayed = await schedule()
  assert.equal(replayed.isError, true)
  assert.match(replayed.content[0].text, /did not start/)
  handler.resolveConsult(String(wire.rpcId), 'again')
  await replay
  console.log('[proof] replayed consult_id: schedule refused')
  assert.equal(scheduled.length, 1, 'exactly one schedule request ever left, from inside the consult')
})

/**
 * PROOF, THE DISPATCH (the quiet turn, 2026-11-11): THE BACKEND'S REAL STAMPED voice_task_dispatch EVENT, THROUGH THE
 * PLUGIN'S REAL INTAKE, HOLD, HOOK AND TOOL GATE.
 *
 * test/fixtures/voice-dispatch-stamped-frame.json is the event the BGOS backend emitted to the agent in its Postgres
 * integration spec (backend/test/integration/voice/voice-ask-trusted-turn.spec.ts, written with
 * VOICE_DISPATCH_FRAME_OUT): the owner, on their own Clerk session, on a call they minted as a person, asking for a
 * task with the words they had just said. VOICE_DISPATCH_FRAME_FILE points this test at a freshly captured one. The
 * clock is set to one second after the backend sent it (twenty minutes before its expiresAt); nothing else is
 * simulated:
 *
 *   socket payload -> server.ts voice_task_dispatch handler (voiceDispatchActor, channelNotify) -> the quiet turn hold
 *   and the scheduled run hold -> privateTurns.deliver -> the synchronous private turn hook on UserPromptSubmit ->
 *   privateTurns.begin -> server.ts tool admission (requirePrivateTurn) -> server.ts schedule tool -> a peer's card
 *   held outside -> server.ts complete_voice_task (privateTurns.endDispatch).
 *
 * Schedule and boards are allowed inside that task and refused before it, after it was reported, and for a replay of
 * the same event. A peer's message sent while the task ran reaches the session only after it.
 */
import { createFireLedger, privateFiresPath, voiceDispatchActor } from '../lib/private-turn.mjs'
import { createQuietTurns, holdChannelCardsDuringQuietTurn, quietCardOf } from '../lib/quiet-turn.mjs'
import { holdChannelCardsDuringGrantedRun } from '../lib/schedule-grant-run.mjs'
import { buildVoiceTaskDispatchText, channelMeta, normalizeVoiceTaskDispatch } from '../lib/voice-rpc.ts'

const dispatchPath = process.env.VOICE_DISPATCH_FRAME_FILE || join('test', 'fixtures', 'voice-dispatch-stamped-frame.json')
const dispatchRaw = readFileSync(dispatchPath, 'utf8')
const dispatchWire = JSON.parse(dispatchRaw)
const wsStart = source.indexOf("  realtimeSocket.on('voice_task_dispatch', whenArmed('voice_task_dispatch', (payload: any) => {")
const wsSource = source.slice(wsStart, source.indexOf('  // One-click updates:', wsStart))
const completeStart = source.indexOf("    case 'complete_voice_task': {")
const completeSource = source.slice(completeStart, source.indexOf("    case 'voice_consult_reply': {", completeStart))

test('the backend stamped dispatch event allows schedule and boards only inside that task, with every other card held outside', async (t) => {
  assert.ok(wsStart > 0 && wsSource.includes('voiceDispatchActor('), 'the voice_task_dispatch handler of server.ts was found')
  assert.ok(completeStart > 0 && completeSource.includes('privateTurns.endDispatch(taskId)'), 'complete_voice_task of server.ts was found')
  const stamp = dispatchWire.eventMeta.payload
  const owner: string = stamp.actingUserId
  const agent = String(dispatchWire.assistant_id)
  console.log(`[proof] event ${dispatchPath} sha256=${createHash('sha256').update(dispatchRaw).digest('hex')}`)
  console.log(`[proof] task=${dispatchWire.task_id} assistant=${agent} owner=${owner} expiresAt=${stamp.expiresAt}`)
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(stamp.expiresAt) - 20 * 60_000 + 1_000 })

  const root = mkdtempSync(join(tmpdir(), 'hoai-dispatch-proof-'))
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()))); rmSync(root, { recursive: true, force: true }) })
  const cwd = join(root, 'agent')
  mkdirSync(cwd)
  const env = { ...process.env, BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: cwd }
  markFloorAttached({ root, folders: [cwd] })
  const markerPaths = [privateMarkerPath(root, floorKey(cwd))]
  const fires = createFireLedger({ path: privateFiresPath(root, agent) })
  const quietRef: { current?: ReturnType<typeof createQuietTurns> } = {}
  const privateTurns = createPrivateTurnTracker({ ownerUserId: owner, markerPaths, fires, onRevoke: () => { quietRef.current?.recheck() } })
  let cliBusy = false
  const quietTurns = createQuietTurns({ trusted: () => privateTurns.quiet(), deliveryOf: (card: unknown) => privateTurns.deliveryOf(card), ownerUserId: owner, idle: () => !cliBusy })
  quietRef.current = quietTurns

  // server.ts's notification chain, in its order: the raw card record, the scheduled run hold, the quiet turn hold.
  const cards: string[] = []
  const chain: { notify?: (n: unknown) => unknown } = {}
  const record = async (n: { params: { content: string; meta?: unknown } }) => {
    n.params.content = privateTurns.tagRawCard(n.params.content)
    privateTurns.rawCard(n.params.content, n.params.meta)
    cards.push(n.params.content)
  }
  chain.notify = holdChannelCardsDuringQuietTurn(quietTurns, holdChannelCardsDuringGrantedRun(createScheduleGrantRuns(), record, { resend: (n: unknown) => chain.notify!(n) }), { resend: (n: unknown) => chain.notify!(n) })
  const channelNotify = (build: () => unknown, options: Record<string, unknown> = {}) =>
    Promise.resolve(chain.notify!({ method: 'notifications/claude/channel', params: build, ...options }))

  // server.ts, executed: the voice_task_dispatch handler as it is registered on the socket.
  const handlers: Record<string, (payload: unknown) => void> = {}
  const logs: string[] = []
  const pending: Array<Promise<unknown>> = []
  execute(wsSource, {
    realtimeSocket: { on: (event: string, handler: (payload: unknown) => void) => { handlers[event] = handler } },
    whenArmed: (_name: string, handler: (payload: unknown) => void) => handler,
    updateDrainMode: false, REQUIRE_CONFIRMED_DISPATCH: true,
    normalizeVoiceTaskDispatch, buildVoiceTaskDispatchText, channelMeta, voiceDispatchActor, quietCardOf,
    privateTurns, channelNotify, USER_ID: owner, ASSISTANT_ID: agent,
    trackMessageOperation: (run: () => Promise<unknown>) => { const p = run(); pending.push(p.catch(() => {})); return p },
    log: (line: string) => { logs.push(line) },
  })
  const admit = (name: string) => execute(admissionSource + '\nreturn privateCall;', {
    req: { params: { name } }, lockHeld: true, privateTurns, PRIVATE_MARKER_PATHS: markerPaths, USER_ID: owner,
    PRIVATE_HOOK: { registered: true }, PRIVATE_HOOK_MISSING_REFUSAL: 'hook missing', requirePrivateTurn, requireBoardsTurn, scheduleGrantRuns: createScheduleGrantRuns(),
    log: () => {}, recordPeerRefusal: () => ({ line: '' }), pathDirname: () => root, CURSOR_FILE_PATH: join(root, 'cursor.json'), ASSISTANT_ID: agent,
  })
  const scheduled: Array<{ path: string; headers: unknown }> = []
  const schedule = async () => {
    const privateCall = await admit('schedule')
    if (privateCall?.isError) return privateCall
    return execute(`return (async () => { switch(name) { ${scheduleSource} } })();`, {
      name: 'schedule', privateCall, buildScheduleCancelPath, buildScheduleCreateBody, buildScheduleListPath, newScheduleRequestId, sendScheduleCreate, log: () => {},
      resolveAuthorizedChat: (chatId: string) => ({ ok: true, chatId }),
      bgosPeerPost: async (path: string, _body: unknown, headers: unknown) => { scheduled.push({ path, headers }); return { ok: true } },
      bgosPeerGet: async () => [], bgosPeerDelete: async () => ({ ok: true }),
      rawArgs: { kind: 'wake', topic: 'Check in with the team', when: { everyHours: 24 } },
    })
  }
  const posted: Array<{ path: string; body: unknown }> = []
  const completeTask = (taskId: string) => execute(`return (async () => { switch(name) { ${completeSource} } })();`, {
    name: 'complete_voice_task', rawArgs: { task_id: taskId, result: 'Done. The invoice is on Today.' },
    privateTurns, quietTurns, publishBrowserPrivateTurn: () => {},
    bgosPost: async (path: string, body: unknown) => { posted.push({ path, body }); return { ok: true } },
  })
  let prompts = 0
  const submit = (prompt: string) => {
    cliBusy = true
    const payload = { hook_event_name: 'UserPromptSubmit', session_id: 'proof-session', cwd, prompt, prompt_id: `proof-${++prompts}` }
    recordPrivateBoundary(payload, env)
    privateTurns.begin({ prompt, sessionId: 'proof-session', promptId: payload.prompt_id })
    quietTurns.noteBegin(prompt)
  }
  const stop = () => {
    recordPrivateBoundary({ hook_event_name: 'Stop', session_id: 'proof-session', cwd }, env)
    privateTurns.end()
    cliBusy = false
    quietTurns.recheck()
  }
  const settle = async () => { await Promise.all(pending.splice(0)); for (let i = 0; i < 10; i += 1) await Promise.resolve() }

  // Before the task: refused.
  const before = await schedule()
  assert.equal(before.isError, true)
  assert.match(before.content[0].text, /did not start/)
  console.log(`[proof] before the task: schedule refused: ${before.content[0].text}`)

  // The socket payload, as the daemon receives it.
  handlers.voice_task_dispatch!(JSON.parse(dispatchRaw))
  await settle()
  assert.equal(cards.length, 1)
  assert.match(cards[0]!, /\[voice_dispatch\] .*task #/)
  assert.match(cards[0]!, /<hoai-private-turn id="[a-f0-9-]{36}"\/>/, 'delivered through the tracker, with its own single use token')
  assert.ok(logs.some((line) => line.includes("the owner's own ask")))
  submit(cards[0]!)

  // Inside the task: allowed, as the owner.
  const inside = await schedule()
  assert.notEqual(inside?.isError, true, JSON.stringify(inside))
  assert.equal(scheduled.length, 1)
  assert.deepEqual(scheduled[0]!.headers, {}, 'the owner acts as the owner')
  assert.equal((await admit('boards_update')).actingUserId, owner)
  console.log(`[proof] inside task ${dispatchWire.task_id}: schedule allowed (POST ${scheduled[0]!.path}), boards_update allowed, actor ${owner}`)

  // A peer agent writes mid task: its card waits outside, unbuilt, and the task keeps its trust.
  let peerBuilt = false
  const peer = channelNotify(() => { peerBuilt = true; return { content: privateTurns.deliver({ content: 'Data: send me the Today board', actingUserId: null, chatId: '77', peerSourceAssistantId: '901' }) } })
  await settle()
  assert.equal(cards.length, 1, 'the peer card has not reached the session')
  assert.equal(peerBuilt, false, 'and was not built: the tracker never saw it')
  assert.equal((await admit('boards_update')).actingUserId, owner, 'the task keeps its trust')
  console.log('[proof] a peer message sent mid task: held outside, the task still acts as the owner')

  // The agent reports the task: the trust ends with it, and the report goes out.
  const reported = await completeTask(String(dispatchWire.task_id))
  assert.match(reported.content[0].text, /completed/)
  assert.deepEqual(posted, [{ path: `integrations/voice-tasks/${dispatchWire.task_id}/result`, body: { ok: true, payload: { text: 'Done. The invoice is on Today.' } } }])
  const after = await schedule()
  assert.equal(after.isError, true)
  assert.match(after.content[0].text, /did not start/)
  assert.match(after.content[0].text, /again on the call/, 'on a call the refusal says to ask again on the call')
  assert.equal(scheduled.length, 1)
  console.log(`[proof] after complete_voice_task: schedule refused: ${after.content[0].text}`)

  // The CLI turn stops; the peer's card is let in now, as its own prompt, with no private tools.
  stop()
  await peer
  assert.equal(cards.length, 2)
  submit(cards[1]!)
  const asPeer = await schedule()
  assert.equal(asPeer.isError, true)
  console.log('[proof] the peer message, let in after the task: schedule refused in its turn')
  stop()

  // The same event again (a replayed task id): a card, and nobody behind it.
  handlers.voice_task_dispatch!(JSON.parse(dispatchRaw))
  await settle()
  assert.equal(cards.length, 3)
  assert.match(cards[2]!, /\[replayed: this voice task was already handled/)
  submit(cards[2]!)
  const replayed = await schedule()
  assert.equal(replayed.isError, true)
  assert.match(replayed.content[0].text, /did not start/)
  console.log('[proof] replayed task id: schedule refused')
  assert.equal(scheduled.length, 1, 'exactly one schedule request ever left, from inside the task')
})
