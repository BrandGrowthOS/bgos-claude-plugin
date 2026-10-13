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
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { createPrivateTurnTracker, privateMarkerPath, requirePrivateTurn } from '../lib/private-turn.mjs'
import { floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import { recordPrivateBoundary } from '../bin/hoai-private-turn-hook.mjs'
import { VoiceRpcHandler, normalizeVoiceRpc } from '../lib/voice-rpc.ts'
import { buildScheduleCancelPath, buildScheduleCreateBody, buildScheduleListPath } from '../lib/schedule.js'

const framePath = process.env.VOICE_CONSULT_FRAME_FILE || join('test', 'fixtures', 'voice-consult-stamped-frame.json')
const raw = readFileSync(framePath, 'utf8')
const wire = JSON.parse(raw)

const source = readFileSync('server.ts', 'utf8')
const voiceDepsStart = source.indexOf('  notify: (content, meta, consult) =>')
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
    mcp: { notification: async (n: { params: { content: string } }) => { cards.push(n.params.content) } },
    privateTurns,
  })
  const admit = (name: string) => execute(admissionSource + '\nreturn privateCall;', {
    req: { params: { name } }, lockHeld: true, privateTurns, PRIVATE_MARKER_PATHS: markerPaths, USER_ID: owner,
    PRIVATE_HOOK: { registered: true }, PRIVATE_HOOK_MISSING_REFUSAL: 'hook missing', requirePrivateTurn,
    log: () => {}, recordPeerRefusal: () => ({ line: '' }), pathDirname: () => root, CURSOR_FILE_PATH: join(root, 'cursor.json'), ASSISTANT_ID: wire.assistantId,
  })
  const scheduled: Array<{ path: string; headers: unknown }> = []
  const schedule = async () => {
    const privateCall = await admit('schedule')
    if (privateCall?.isError) return privateCall
    return execute(`return (async () => { switch(name) { ${scheduleSource} } })();`, {
      name: 'schedule', privateCall, buildScheduleCancelPath, buildScheduleCreateBody, buildScheduleListPath, log: () => {},
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
