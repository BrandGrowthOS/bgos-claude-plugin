import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { privateActor, privateSenderUserId } from '../lib/private-turn.mjs'
import * as privateTurnModule from '../lib/private-turn.mjs'
import { buildScheduleCancelPath, buildScheduleCreateBody, buildScheduleListPath } from '../lib/schedule.js'

const source = readFileSync('server.ts', 'utf8')
const scheduleSource = source.slice(source.indexOf("    case 'schedule': {"), source.indexOf("    case 'create_mission': {"))
const admissionStart = source.indexOf('  // Freeze private authority at request admission')
const admissionSource = source.slice(admissionStart, source.indexOf('  return trackMessageOperation(async () => {', admissionStart))
function execute(body: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings))
}

test('actual tool admission refuses unresolved sender and passive daemon before private work', async () => {
  for (const name of ['schedule', 'list_schedules', 'cancel_schedule', 'boards_list']) {
    let called = 0
    const bindings = { req: { params: { name } }, lockHeld: true, privateTurns: {}, PRIVATE_MARKER_PATHS: [], PRIVATE_HOOK: { registered: true }, PRIVATE_HOOK_MISSING_REFUSAL: 'hook missing', USER_ID: 'user_owner',
      requirePrivateTurn: () => { called++; throw new Error('private action did not start') } }
    const result = await execute(admissionSource + '\nreturn privateCall;', bindings)
    assert.equal(called, 1)
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /did not start/)
    const passive = await execute(admissionSource + '\nreturn privateCall;', { ...bindings, lockHeld: false })
    assert.equal(called, 1)
    assert.equal(passive.isError, true)
  }
})

test('actual schedule create/list/cancel carry frozen recipient header; omitted chat is recipient chat', async () => {
  const calls: any[] = []
  let current = { actingUserId: 'user_recipient', chatId: '200', headers: { 'X-BGOS-Acting-User': 'user_recipient' } }
  const privateCall = execute(admissionSource + '\nreturn privateCall;', { req: { params: { name: 'schedule' } }, lockHeld: true, privateTurns: {}, PRIVATE_MARKER_PATHS: [], PRIVATE_HOOK: { registered: true }, PRIVATE_HOOK_MISSING_REFUSAL: 'hook missing', USER_ID: 'user_owner', requirePrivateTurn: () => structuredClone(current) })
  current = { actingUserId: 'user_other', chatId: '300', headers: { 'X-BGOS-Acting-User': 'user_other' } }
  const bindings = {
    privateCall, buildScheduleCancelPath, buildScheduleCreateBody, buildScheduleListPath, log: () => {},
    resolveAuthorizedChat: (chatId: string) => ({ ok: true, chatId }),
    bgosPeerPost: async (path: string, body: any, headers: any) => { calls.push({ path, body, headers }); return { ok: true } },
    bgosPeerGet: async (path: string, headers: any) => { calls.push({ path, headers }); return [] },
    bgosPeerDelete: async (path: string, headers: any) => { calls.push({ path, headers }); return { ok: true } },
  }
  for (const name of ['schedule', 'list_schedules', 'cancel_schedule']) {
    const result = await execute(`return (async () => { switch(name) { ${scheduleSource} } })();`, { ...bindings, name,
      rawArgs: { kind: 'wake', topic: 'Synthetic private check', when: { everyHours: 2 }, status: 'active', schedule_id: 3 } })
    assert.notEqual(result?.isError, true, JSON.stringify(result))
  }
  assert.equal(calls.length, 3)
  assert.equal(calls[0].body.chatId, 200)
  for (const call of calls) assert.deepEqual(call.headers, { 'X-BGOS-Acting-User': 'user_recipient' })
})

test('all three admitted message lanes use opaque private delivery identity and authoritative actor fields', () => {
  assert.equal((source.match(/content: privateTurns\.deliver\(/g) || []).length, 3)
  assert.match(source, /senderUserId: privateSenderUserId\(msg\.message\)/)
  assert.match(source, /senderUserId: privateSenderUserId\(view\.raw\)/)
  assert.match(source, /senderUserId: privateSenderUserId\(payload\)/)
  assert.match(source, /privateTurns\.begin\(\{ prompt: payload\.prompt, promptHash: payload\.hoai_clipped === true \? payload\.prompt_sha256 : undefined, sessionId: hookSessionId, promptId: payload\.prompt_id \}\)/)
  // What begin() decided is logged for every prompt that carried a token, and a refused call names the failed check.
  // A replayed fire is said once, by its own line (onReplay), not also by the begin line.
  assert.match(source, /if \(began !== 'repeat' && began !== 'replayed' && \(began !== 'no-token' \|\| matched !== null\)\) log\(privateBeginLine\(began, hookSessionId\)\)/)
  assert.match(source, /onRevoke: \(info\) => \{ log\(privateRevokeLine\(info\)\); publishBrowserPrivateTurn\(\) \}/)
  assert.match(source, /if \(lockHeld\) log\(`private turn: refused \$\{req\.params\.name\}: \$\{privateTurns\.explain\(\{ markerPaths: PRIVATE_MARKER_PATHS \}\)\}`\)/)
  // The turn ends where the rail's turn ends: a Stop's turn_end reaches endHookTurn, which closes the private turn.
  assert.match(source, /function endHookTurn\(keepCard: boolean\): void \{[\s\S]*?privateTurns\.end\(\)[\s\S]*?\n\}/)
  assert.match(source, /case 'turn_end': \{\n\s*void finishHookTurn\(effect\.keepCard\)/)
  // A mid-turn delivery that revokes the turn republishes the signed browser context right away.
  // A second record of the same prompt keeps the turn and is logged (test/private-turn-duplicate-boundary.test.ts).
  // The fires this agent opened a turn for persist in its own state folder (0.68.4): a replay after a restart opens none.
  assert.match(source, /const privateFires = createFireLedger\(\{ path: privateFiresPath\(FLOOR_STATE_ROOT, ASSISTANT_ID\) \}\)/)
  assert.match(source, /const privateTurns = createPrivateTurnTracker\(\{ fires: privateFires, onRevoke: \(info\) => \{ log\(privateRevokeLine\(info\)\); publishBrowserPrivateTurn\(\) \}, onRepeat: \(repeat\) => log\(privateRepeatLine\(repeat\)\), onReplay: \(replay\) => log\(privateReplayLine\(replay\)\) \}\)/)
  assert.match(source, /boardsTransports\(privateCall!\.headers\)/)
})


test('actual delivery actor expressions refuse legacy owner userId and user_id in every lane', () => {
  const lines = source.split('\n').filter(line => line.includes('content: privateTurns.deliver('))
  assert.equal(lines.length, 3)
  for (const line of lines) {
    const match = line.trim().match(/actingUserId: (privateActor\(.*\)) \}\),$/)!
    assert.ok(match)
    for (const payload of [{ user_id: 'user_owner' }, { userId: 'user_owner' }]) {
      const bindings = { privateActor, privateSenderUserId, msg: { message: payload }, view: { raw: payload, senderKind: 'user' }, payload,
        pollSenderType: 'user', pollAgentOrigin: null, isSystem: false, wsSenderType: 'user', wsAgentOrigin: null }
      assert.equal(execute('return ' + match[1], bindings), null)
      assert.equal(execute('return ' + match[1], { ...bindings, msg: { message: { ...payload, senderUserId: 'user_recipient' } }, view: { raw: { ...payload, senderUserId: 'user_recipient' }, senderKind: 'user' }, payload: { ...payload, senderUserId: 'user_recipient' } }), 'user_recipient')
    }
  }
})

test('every lane names the scheduled fire it delivers, with the same fields its actor comes from (0.68.4)', () => {
  // Vera, 2026-10-13: a wake re-offered as backlog after a restart opened a second private turn. Each lane must hand
  // deliver() the fire key, or a replay through it is never caught.
  const privateFireKey = (privateTurnModule as any).privateFireKey
  assert.equal(typeof privateFireKey, 'function', 'lib/private-turn.mjs exports privateFireKey')
  const lines = source.split('\n').filter(line => line.includes('content: privateTurns.deliver('))
  assert.equal(lines.length, 3)
  const wake = { source: 'scheduler', payload: { scheduledTaskId: 77, fireId: '3f2a9c1e-0000-4000-8000-000000000001', actingUserId: 'user_owner' } }
  const reminder = { source: 'scheduler', payload: { scheduled_action_id: 'a0da1344-0000-4000-8000-000000000000', actingUserId: 'user_owner' } }
  for (const line of lines) {
    const match = line.trim().match(/fireKey: (privateFireKey\(\{.*?\}\)), actingUserId: privateActor\(/)
    assert.ok(match, `no fireKey before actingUserId in: ${line.trim().slice(0, 160)}`)
    for (const [eventMeta, expected] of [[wake, 'native:3f2a9c1e-0000-4000-8000-000000000001'], [reminder, 'n8n:a0da1344-0000-4000-8000-000000000000:118303']] as const) {
      const bindings = { privateFireKey, msg: { message: { id: 118303, eventMeta } }, view: { messageId: 118303, eventMetaRaw: eventMeta, senderKind: 'user' },
        payload: { eventMeta }, messageId: 118303, pollSenderType: 'system', isSystem: true, wsSenderType: 'system' }
      assert.equal(execute('return ' + match![1], bindings), expected, line.trim().slice(0, 120))
      // An owner's message on the same lane names no fire.
      assert.equal(execute('return ' + match![1], { ...bindings, pollSenderType: 'user', isSystem: false, wsSenderType: 'user' }), null)
    }
  }
})

test('with no private turn hook registered the call is still refused, and says why', async () => {
  let called = 0
  const result = await execute(admissionSource + '\nreturn privateCall;', {
    req: { params: { name: 'boards_query' } }, lockHeld: true, privateTurns: {}, PRIVATE_MARKER_PATHS: [], USER_ID: 'user_owner',
    PRIVATE_HOOK: { registered: false }, PRIVATE_HOOK_MISSING_REFUSAL: 'hook missing',
    requirePrivateTurn: () => { called++; throw new Error('private action did not start') },
  })
  assert.equal(called, 1, 'the gate still runs: a missing hook is not a fallback')
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /hook missing/)
})

test('a refused private call on a peer turn is counted with the tool name and the peer id, and is still refused', async () => {
  const recorded: Array<Record<string, unknown>> = []
  const logs: string[] = []
  const run = (peer: { sourceAssistantId: string } | null) =>
    execute(admissionSource + '\nreturn privateCall;', {
      req: { params: { name: 'boards_query' } }, lockHeld: true, USER_ID: 'user_owner', PRIVATE_MARKER_PATHS: [], PRIVATE_HOOK: { registered: true }, PRIVATE_HOOK_MISSING_REFUSAL: 'hook missing',
      privateTurns: { peerTurn: () => peer, explain: () => 'no private turn is open (stub)' },
      requirePrivateTurn: () => { throw new Error('private action did not start') },
      recordPeerRefusal: (input: Record<string, unknown>) => { recorded.push(input); return { line: 'peer private call refused' } },
      log: (line: string) => logs.push(line),
      pathDirname: () => '/state/1050', CURSOR_FILE_PATH: '/state/1050/cursor.json', ASSISTANT_ID: 1050,
    })
  const refused = await run({ sourceAssistantId: '888' })
  assert.equal(refused.isError, true)
  assert.match(refused.content[0].text, /did not start/)
  assert.deepEqual(recorded, [{ dir: '/state/1050', tool: 'boards_query', delegate: '888', target: 1050 }])
  assert.deepEqual(logs, ['peer private call refused', 'private turn: refused boards_query: no private turn is open (stub)'])

  // A human turn that is refused is not a peer refusal: nothing is counted.
  recorded.length = 0
  const human = await run(null)
  assert.equal(human.isError, true)
  assert.deepEqual(recorded, [])
})
