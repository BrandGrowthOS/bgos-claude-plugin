import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { privateActor, privateSenderUserId } from '../lib/private-turn.mjs'
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
  assert.match(source, /privateTurns\.begin\(\{ prompt: payload\.prompt, promptHash: payload\.hoai_clipped === true \? payload\.prompt_sha256 : undefined, sessionId: hookSessionId \}\)/)
  // A mid-turn delivery that revokes the turn republishes the signed browser context right away.
  assert.match(source, /const privateTurns = createPrivateTurnTracker\(\{ onRevoke: \(\) => publishBrowserPrivateTurn\(\) \}\)/)
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
