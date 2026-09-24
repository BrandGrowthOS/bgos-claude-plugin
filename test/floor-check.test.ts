/**
 * The permission relay's half of the hard floor (lib/floor-check.ts and its
 * wiring in server.ts).
 *
 * Map part 24, run D3, is the reason this file exists: on a default install
 * (auto approve on, hardcoded) the floor hook's ask reached the relay and was
 * allowed in 8 ms without being looked at, and the delete ran. So a request
 * the list matches must ask the server BEFORE the auto approve branch, and the
 * three answers must do three different things:
 *   hold      the interactive path (card, wait, owner), even with auto approve on
 *   proceed   today's auto approve
 *   error     refused, never allowed silently
 * plus the two readings that are not errors (an API key connection, a backend
 * without the route), which proceed as before and say so.
 *
 * Run with: npx tsx --test test/floor-check.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

import {
  FLOOR_CHECK_INPUT_PREVIEW_MAX,
  FLOOR_CHECK_TIMEOUT_MS,
  FLOOR_CHECK_TOOL_NAME_MAX,
  buildFloorCheckBody,
  consultFloor,
  floorCheckPath,
  floorRouteFor,
  readFloorCheckResponse,
  type FloorCheckBody,
} from '../lib/floor-check.ts'
import {
  classifyPermissionRequest,
  classifyToolCall,
  type HardFloorMatch,
} from '../lib/hard-floor.ts'
import { HARD_FLOOR_FIXTURE } from '../lib/hard-floor-fixture.ts'
import { FetchTimeoutError } from '../lib/bounded-fetch.ts'

const SRC = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** The D1 frame's preview, verbatim (map part 24). */
const D1_PREVIEW = '{ "command": "rm -rf doomed", "description": "Remove doomed directory" }'
const D1_MATCH = classifyPermissionRequest('Bash', D1_PREVIEW) as HardFloorMatch

const answer = (status: number, body: unknown) => ({
  status,
  text: typeof body === 'string' ? body : JSON.stringify(body),
})

test('the D1 request matches the list locally, so the relay asks', () => {
  assert.equal(D1_MATCH?.ruleId, 'recursive_delete')
})

test('the route is pairing scoped, and an API key connection has none', () => {
  assert.equal(floorCheckPath('pairing', 2082), 'integrations/assistants/2082/floor-check')
  assert.equal(floorCheckPath('pairing', '12 3'), 'integrations/assistants/12%203/floor-check')
  assert.equal(floorCheckPath('apikey', 2082), null)
  assert.equal(floorCheckPath('pairing', ''), null)
})

test('the body carries what the list reads, as JSON, inside the route limits', () => {
  assert.deepEqual(buildFloorCheckBody('Bash', D1_PREVIEW, D1_MATCH), {
    toolName: 'Bash',
    inputPreview: '{"command":"rm -rf doomed"}',
  })
  const edit = '{ "file_path": "/w/.env", "old_string": "A=1\\n", "new_string": "A=2\\n" }'
  assert.deepEqual(
    buildFloorCheckBody('Edit', edit, classifyPermissionRequest('Edit', edit) as HardFloorMatch),
    { toolName: 'Edit', inputPreview: '{"file_path":"/w/.env"}' },
  )
  const mcp = buildFloorCheckBody('mcp__gmail__send_email', '{ "to": "a@b.c", "body": "secret" }', {
    evidence: 'mcp__gmail__send_email',
  })
  assert.deepEqual(mcp, { toolName: 'mcp__gmail__send_email', inputPreview: '{}' }, 'an MCP tool is judged by its name, so its arguments stay home')
  const long = buildFloorCheckBody('x'.repeat(500), D1_PREVIEW, D1_MATCH)
  assert.equal(long.toolName.length, FLOOR_CHECK_TOOL_NAME_MAX)
})

test('a command too long to send whole is sent as the segment that matched', () => {
  const command = `echo ${'y'.repeat(9000)} && git push --force origin main`
  const preview = JSON.stringify({ command, description: 'long' })
  const match = classifyPermissionRequest('Bash', preview) as HardFloorMatch
  const body = buildFloorCheckBody('Bash', preview, match)
  assert.ok(body.inputPreview.length <= FLOOR_CHECK_INPUT_PREVIEW_MAX)
  assert.deepEqual(JSON.parse(body.inputPreview), { command: 'git push --force origin main' })
  // And the server, reading that body with the same list, sees the same rule.
  assert.equal(classifyPermissionRequest(body.toolName, body.inputPreview)?.ruleId, 'force_push')
})

test('whatever goes in, the body is valid JSON within 4000 characters', () => {
  const huge = 'q'.repeat(20_000)
  for (const [tool, preview] of [
    ['Write', JSON.stringify({ file_path: `/w/.git/${huge}`, content: huge })],
    ['Bash', JSON.stringify({ command: `rm -rf ${huge}` })],
    ['Bash', `rm -rf ${'"\\'.repeat(5000)}`],
    ['NotebookEdit', JSON.stringify({ notebook_path: `/w/.git/${'☃'.repeat(6000)}` })],
    ['Bash', ''],
  ] as const) {
    const match = classifyPermissionRequest(tool, preview) ?? { evidence: '' }
    const body: FloorCheckBody = buildFloorCheckBody(tool, preview, match)
    assert.ok(body.inputPreview.length <= FLOOR_CHECK_INPUT_PREVIEW_MAX, `${tool}: ${body.inputPreview.length}`)
    assert.doesNotThrow(() => JSON.parse(body.inputPreview), tool)
  }
})

test('every call the hook asks about, the relay recognises from its preview, and the body keeps it', () => {
  // The property the whole design leans on. If the hook asks and the relay
  // does NOT match the same call, the relay auto approves the hook's ask
  // without asking the server, which is run D3 all over again.
  const calls: Array<[string, Record<string, unknown>]> = []
  for (const c of HARD_FLOOR_FIXTURE) {
    if (c.input.kind === 'command') calls.push(['Bash', { command: c.input.command, description: 'd' }])
    if (c.input.kind === 'command') calls.push(['PowerShell', { command: c.input.command }])
    if (c.input.kind === 'path') calls.push(['Edit', { file_path: c.input.path, old_string: 'a', new_string: 'b', replace_all: false }])
    if (c.input.kind === 'path') calls.push(['Write', { file_path: c.input.path, content: 'x\n' }])
    if (c.input.kind === 'tool') calls.push([c.input.toolName, { arg: 1 }])
  }
  let asked = 0
  for (const [tool, input] of calls) {
    const hook = classifyToolCall(tool, input)
    // The CLI's rendering has a space inside the braces and after each colon.
    const preview = JSON.stringify(input).replace(/^\{/, '{ ').replace(/\}$/, ' }').replace(/":/g, '": ')
    for (const rendered of [preview, JSON.stringify(input)]) {
      const relay = classifyPermissionRequest(tool, rendered)
      assert.equal(relay?.ruleId ?? null, hook?.ruleId ?? null, `${tool} ${rendered}`)
      if (!relay) continue
      const body = buildFloorCheckBody(tool, rendered, relay)
      assert.equal(
        classifyPermissionRequest(body.toolName, body.inputPreview)?.ruleId,
        relay.ruleId,
        `the body must still match: ${tool} ${body.inputPreview}`,
      )
    }
    if (hook) asked += 1
  }
  assert.ok(asked > 80, `the property was exercised (${asked} asked calls)`)
})

test('the answer: hold, proceed, and everything that is neither', () => {
  assert.deepEqual(
    readFloorCheckResponse(answer(200, { hold: true, ruleId: 'recursive_delete', rulesVersion: 1 })),
    { kind: 'hold', ruleId: 'recursive_delete', rulesVersion: 1 },
  )
  assert.deepEqual(readFloorCheckResponse(answer(201, { hold: false, rulesVersion: 1 })), {
    kind: 'proceed',
    rulesVersion: 1,
  })
  assert.deepEqual(readFloorCheckResponse(answer(200, { hold: true })), {
    kind: 'hold',
    ruleId: null,
    rulesVersion: null,
  })
  assert.equal(readFloorCheckResponse(answer(404, { message: 'Cannot POST' })).kind, 'unsupported')
  for (const [status, body] of [
    [403, { message: 'Assistant is not owned by the caller.' }],
    [401, {}],
    [400, { message: ['inputPreview must be shorter than or equal to 4000 characters'] }],
    [500, {}],
    [502, '<html>bad gateway</html>'],
    [200, 'not json'],
    [200, {}],
    [200, { hold: 'true' }],
    [200, { hold: 1 }],
    [200, [true]],
    [200, 'null'],
  ] as const) {
    assert.equal(readFloorCheckResponse(answer(status, body)).kind, 'error', `${status} ${JSON.stringify(body)}`)
  }
})

test('the routes: hold holds, proceed and unsupported auto approve, error refuses', () => {
  assert.equal(floorRouteFor({ kind: 'hold', ruleId: 'x', rulesVersion: 1 }), 'hold')
  assert.equal(floorRouteFor({ kind: 'proceed', rulesVersion: 1 }), 'auto_approve')
  assert.equal(floorRouteFor({ kind: 'unsupported', reason: 'r' }), 'auto_approve')
  assert.equal(floorRouteFor({ kind: 'error', reason: 'r' }), 'refuse')
})

const PATH = 'integrations/assistants/2082/floor-check'

const consult = (send: Parameters<typeof consultFloor>[0]['send'], extra: Partial<Parameters<typeof consultFloor>[0]> = {}) =>
  consultFloor({
    toolName: 'Bash',
    inputPreview: D1_PREVIEW,
    requestId: 'rsjmy',
    match: D1_MATCH,
    path: PATH,
    send,
    ...extra,
  })

test('the relay three answers, end to end through consultFloor', async () => {
  const sent: Array<[string, FloorCheckBody]> = []
  const hold = await consult(async (path, body) => {
    sent.push([path, body])
    return answer(200, { hold: true, ruleId: 'recursive_delete', rulesVersion: 1 })
  })
  assert.equal(hold.route, 'hold')
  assert.match(hold.line, /Floor HOLDS Bash \[rsjmy\] \(rule recursive_delete\)/)
  assert.deepEqual(sent, [[PATH, { toolName: 'Bash', inputPreview: '{"command":"rm -rf doomed"}' }]])

  const proceed = await consult(async () => answer(200, { hold: false, rulesVersion: 1 }))
  assert.equal(proceed.route, 'auto_approve')
  assert.match(proceed.line, /has not asked to hold it; auto approving/)

  const refused = await consult(async () => answer(500, { message: 'boom' }))
  assert.equal(refused.route, 'refuse')
  assert.match(refused.line, /REFUSING it: the floor check answered 500/)
})

test('an error or a timeout REFUSES: a network failure, a deadline, a transport that hangs', async () => {
  const network = await consult(async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:8795')
  })
  assert.equal(network.route, 'refuse')
  assert.match(network.line, /ECONNREFUSED/)

  const deadline = await consult(async () => {
    throw new FetchTimeoutError(`POST ${PATH}`, FLOOR_CHECK_TIMEOUT_MS)
  })
  assert.equal(deadline.route, 'refuse')
  assert.match(deadline.line, /timed out/)

  // A transport that ignores its own deadline is cut off by the race.
  const started = performance.now()
  const hung = await consult(() => new Promise(() => {}), { timeoutMs: 40 })
  assert.equal(hung.route, 'refuse')
  assert.match(hung.line, /timed out after 40ms/)
  assert.ok(performance.now() - started < 2000)

  const lateReject = await consult(
    () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 80)),
    { timeoutMs: 20 },
  )
  assert.equal(lateReject.route, 'refuse', 'a rejection after the deadline changes nothing and throws nowhere')
  await new Promise((r) => setTimeout(r, 120))

  const refusal = await consult(async () => answer(403, { message: 'Assistant is not owned by the caller.' }))
  assert.equal(refusal.route, 'refuse')
})

test('the two readings that are not errors proceed as before, and say so', async () => {
  let called = 0
  const apikey = await consult(
    async () => {
      called += 1
      return answer(200, { hold: true })
    },
    { path: null },
  )
  assert.equal(apikey.route, 'auto_approve')
  assert.equal(called, 0, 'nothing is sent where there is nowhere to send it')
  assert.match(apikey.line, /API key connection/)

  const oldBackend = await consult(async () => answer(404, { message: `Cannot POST /api/v1/${PATH}` }))
  assert.equal(oldBackend.route, 'auto_approve')
  assert.match(oldBackend.line, /no floor check route \(404\)/)
})

test('the floor check has its own short deadline', () => {
  assert.equal(FLOOR_CHECK_TIMEOUT_MS, 10_000)
})

// ── The wiring in server.ts ───────────────────────────────────────────────────

const handler = SRC.slice(
  SRC.indexOf('mcp.setNotificationHandler(PermissionRequestSchema'),
  SRC.indexOf('async function waitForVerdict('),
)
const bodyOf = (signature: string, next: string) =>
  SRC.slice(SRC.indexOf(signature), SRC.indexOf(next, SRC.indexOf(signature) + signature.length))

test('the floor is asked BEFORE the auto approve branch', () => {
  // The permission-relay.test.ts slice pattern. Run D3 is exactly what
  // happens if these two ever swap: auto approve answers first and the floor
  // is never consulted.
  assert.ok(handler.length > 0)
  const classify = handler.indexOf('classifyPermissionRequest(tool_name, input_preview)')
  const settle = handler.indexOf('if (floorMatch) return settleFloorRequest(params, floorMatch)')
  const auto = handler.indexOf('if (AUTO_APPROVE) {')
  assert.ok(classify > 0 && settle > 0 && auto > 0, 'all three must be in the handler')
  assert.ok(classify < auto, 'the list is read before auto approve')
  assert.ok(settle < auto, 'and a match leaves before auto approve can answer it')
  // Asked only where the answer can change anything: with auto approve off
  // every request is interactive already.
  assert.match(handler, /const floorMatch = AUTO_APPROVE\s*\?\s*classifyPermissionRequest\(tool_name, input_preview\)\s*:\s*null/)
})

test('hold takes the whole interactive path; proceed allows; refuse denies', () => {
  const settle = bodyOf('function settleFloorRequest(', '\n/**')
  assert.ok(settle.length > 0)
  assert.ok(settle.includes('return trackMessageOperation(async () => {'), 'tracked, so a drain waits for it')
  assert.ok(settle.includes('path: floorCheckPath(AUTH.mode, ASSISTANT_ID)'))
  assert.ok(settle.includes('send: postFloorCheck'))
  const hold = settle.slice(settle.indexOf("case 'hold':"), settle.indexOf("case 'auto_approve':"))
  assert.ok(hold.includes('return relayPermissionToOwner(params)'), 'a hold is the interactive path itself')
  assert.equal(hold.includes("behavior: 'allow'"), false, 'a hold never allows on its own')
  const proceed = settle.slice(settle.indexOf("case 'auto_approve':"), settle.indexOf("case 'refuse':"))
  assert.ok(proceed.includes("behavior: 'allow'"))
  assert.ok(proceed.includes('Auto-approving: ${tool_name} [${request_id}]'), 'the same log line as today')
  const refuse = settle.slice(settle.indexOf("case 'refuse':"))
  assert.ok(refuse.includes("behavior: 'deny'"))
  assert.equal(refuse.includes("behavior: 'allow'"), false)
})

test('the interactive path a hold takes still refuses in a drain and with no chat', () => {
  const relay = bodyOf('function relayPermissionToOwner(', '\nfunction settleFloorRequest(')
  assert.ok(relay.length > 0)
  const drain = relay.slice(relay.indexOf('if (updateDrainMode) {'), relay.indexOf('return trackMessageOperation('))
  assert.ok(drain.includes("behavior: 'deny'"), 'the drain exit refuses a held request')
  const noChat = relay.slice(relay.indexOf('if (!chatId) {'), relay.indexOf('let resolveButtonChoice'))
  assert.ok(noChat.includes("behavior: 'deny'"), 'the no chat exit refuses a held request')
  assert.ok(relay.includes('buildPermissionRequestBody({'), 'and otherwise the real card is posted')
  // The handler's own tail is this same function: one interactive path, not two.
  assert.ok(handler.includes('return relayPermissionToOwner(params)\n})'))
})

test('the floor call is bounded, authenticated, and keeps the status', () => {
  const post = bodyOf('function postFloorCheck(', '\n/**')
  assert.ok(post.includes('return bgosCall('), 'through the one bounded chokepoint')
  assert.ok(post.includes('timeoutMs: FLOOR_CHECK_TIMEOUT_MS'))
  assert.ok(post.includes('...authHeaders(AUTH)'))
  assert.ok(post.includes("method: 'POST'"))
  assert.ok(post.includes('status: response.status'), 'a 404 must be told from a refusal')
})

test('no daemon file reads, stores or caches the owner switch', () => {
  // The switch lives on the server and nowhere else (spec 3). The relay asks a
  // question per event; if any file here ever names the column or the DTO
  // field, the daemon has started keeping a copy of the setting.
  const files: Array<[string, string]> = [['server.ts', SRC]]
  for (const dir of ['lib', 'bin']) {
    for (const name of readdirSync(new URL(`../${dir}/`, import.meta.url))) {
      if (!/\.(ts|mjs)$/.test(name)) continue
      files.push([`${dir}/${name}`, readFileSync(new URL(`../${dir}/${name}`, import.meta.url), 'utf8')])
    }
  }
  assert.ok(files.length > 60, `the whole tree was scanned (${files.length})`)
  const offenders = files.filter(([, src]) => /\bhardFloor\b|\bhard_floor\b/.test(src)).map(([n]) => n)
  assert.deepEqual(offenders, [])
})
