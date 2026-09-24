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
  consultElidedFloor,
  consultFloor,
  floorCheckPath,
  floorRouteFor,
  planFloorRequest,
  readFloorCheckResponse,
  type FloorCheckBody,
  type FloorRecord,
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

/**
 * The CLI's own preview, as Claude Code 2.1.281 renders it (truncateForPreview,
 * functions Rjr, T and I in the shipped binary; constants G=3500, E=2000,
 * w=1500): each key and each JSON rendered value has runs of whitespace
 * folded, and a rendered value over 3500 code points keeps its first 2000 and
 * its last 1500 with a line saying how many were cut, INSIDE the JSON string.
 * (Its character replacement and secret redaction are left out: neither
 * touches the letters these cases turn on.)
 */
const G = 3500
const E = 2000
const W = 1500
function cliElide(text: string): string {
  const points = Array.from(text)
  if (points.length <= G) return text
  const cut = points.length - E - W
  return `${points.slice(0, E).join('')}\n\u22EF ${cut} ${cut === 1 ? 'code point' : 'code points'} elided \u22EF\n${points.slice(points.length - W).join('')}`
}
const cliT = (text: string) => cliElide(text.replace(/\s{2,}/g, ' '))
function cliPreview(input: Record<string, unknown>): string {
  return `{ ${Object.entries(input)
    .map(([k, v]) => `${cliT(JSON.stringify(k))}: ${cliT(JSON.stringify(v))}`)
    .join(', ')} }`
}

/** The review's three long commands: the listed action sits in the part the CLI cuts out. */
const LONG_COMMANDS: Array<[string, string, string]> = [
  ['middle', `echo ${'a'.repeat(2500)} ; rm -rf ~/work ; echo ${'b'.repeat(2000)}`, 'recursive_delete'],
  [
    'heredoc script',
    `bash <<'EOF'\n${'echo step\n'.repeat(300)}rm -rf build\n${'echo more\n'.repeat(200)}EOF`,
    'recursive_delete',
  ],
  [
    'force push after a long commit',
    `git add -A && git commit -m "${'x'.repeat(2600)}" && git push --force origin main && echo ${'y'.repeat(1600)}`,
    'force_push',
  ],
]

const recordFrom = (toolName: string, input: Record<string, unknown>, permissionMode = 'bypassPermissions'): FloorRecord => {
  const match = classifyToolCall(toolName, input) as HardFloorMatch
  return {
    v: 1,
    at: 1,
    toolName,
    ruleId: match.ruleId,
    rulesVersion: match.rulesVersion,
    evidence: match.evidence,
    permissionMode,
    sessionId: 's',
    toolUseId: 't',
  }
}

test('THE REVIEW: a listed action cut out of the preview by the CLI is invisible to the preview alone', () => {
  for (const [label, command, rule] of LONG_COMMANDS) {
    const input = { command, description: 'Clean up' }
    const preview = cliPreview(input)
    assert.ok(preview.includes('code points elided'), `${label}: the CLI really cut it`)
    assert.equal(classifyToolCall('Bash', input)?.ruleId, rule, `${label}: the hook sees it whole`)
    assert.equal(classifyPermissionRequest('Bash', preview), null, `${label}: the preview has lost it`)
  }
})

test('so the relay decides from the hook record, and the server is sent the matched command', () => {
  for (const [label, command, rule] of LONG_COMMANDS) {
    const input = { command, description: 'Clean up' }
    const preview = cliPreview(input)
    const record = recordFrom('Bash', input)
    const plan = planFloorRequest({
      autoApprove: true,
      toolName: 'Bash',
      inputPreview: preview,
      record,
      previewMatch: classifyPermissionRequest('Bash', preview),
    })
    assert.equal(plan.action, 'consult', label)
    if (plan.action !== 'consult') continue
    assert.equal(plan.source, 'record')
    assert.equal(plan.match.ruleId, rule)
    const body = buildFloorCheckBody('Bash', preview, plan.match)
    assert.ok(body.inputPreview.length <= FLOOR_CHECK_INPUT_PREVIEW_MAX)
    // The server reads the body with the same list: it must see the rule,
    // not the head and tail the CLI kept.
    assert.equal(classifyPermissionRequest('Bash', body.inputPreview)?.ruleId, rule, `${label}: ${body.inputPreview.slice(0, 120)}`)
  }
})

test('with no record, a cut shell preview asks the server about what was cut rather than auto approve', () => {
  const [, command] = LONG_COMMANDS[0]
  const preview = cliPreview({ command, description: 'Clean up' })
  assert.deepEqual(
    planFloorRequest({ autoApprove: true, toolName: 'Bash', inputPreview: preview, record: null, previewMatch: null }).action,
    'ask_elided',
  )
  // A cut preview of anything else is not the floor's business (an MCP tool is judged by name).
  assert.equal(
    planFloorRequest({ autoApprove: true, toolName: 'Write', inputPreview: preview, record: null, previewMatch: null }).action,
    'none',
  )
  // A short, unlisted command carries on exactly as before.
  assert.equal(
    planFloorRequest({ autoApprove: true, toolName: 'Bash', inputPreview: '{ "command": "ls" }', record: null, previewMatch: null }).action,
    'none',
  )
})

test('with auto approve off, only a request the hook record vouches for is asked about', () => {
  const record = recordFrom('Bash', { command: 'rm -rf doomed' })
  assert.equal(
    planFloorRequest({ autoApprove: false, toolName: 'Bash', inputPreview: D1_PREVIEW, record, previewMatch: null }).action,
    'consult',
  )
  // No record: the CLI raised this one on its own, so the card it always got.
  assert.equal(
    planFloorRequest({ autoApprove: false, toolName: 'Bash', inputPreview: D1_PREVIEW, record: null, previewMatch: D1_MATCH }).action,
    'none',
  )
})

test('with auto approve off: a proceed in a full access session allows, anything else asks the owner', () => {
  const off = { autoApprove: false }
  assert.equal(floorRouteFor({ kind: 'hold', ruleId: 'x', rulesVersion: 1 }, { ...off, permissionMode: 'bypassPermissions' }), 'hold')
  // Bypass: the request exists only because the floor hook asked; the switch is
  // off, so the call runs as it did before 0.49.0, with no card.
  assert.equal(floorRouteFor({ kind: 'proceed', rulesVersion: 1 }, { ...off, permissionMode: 'bypassPermissions' }), 'auto_approve')
  assert.equal(floorRouteFor({ kind: 'unsupported', reason: 'r' }, { ...off, permissionMode: 'bypassPermissions' }), 'auto_approve')
  // Any other mode: the CLI would have asked anyway, so the owner is asked as always.
  assert.equal(floorRouteFor({ kind: 'proceed', rulesVersion: 1 }, { ...off, permissionMode: 'default' }), 'owner')
  assert.equal(floorRouteFor({ kind: 'proceed', rulesVersion: 1 }, { ...off, permissionMode: null }), 'owner')
  // An error is never a silent allow; with auto approve off it is the owner's card.
  assert.equal(floorRouteFor({ kind: 'error', reason: 'r' }, { ...off, permissionMode: 'bypassPermissions' }), 'owner')
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

/**
 * THE ROUTE'S LIMITS, PINNED AS LITERALS (cross repo, Ares's note of 15:10 on
 * 2026-09-24). BGOS backend/src/dto/floor-check.dto.ts declares
 * FLOOR_CHECK_TOOL_NAME_MAX = 200 and FLOOR_CHECK_INPUT_PREVIEW_MAX = 4000 and
 * its hard-floor.controller.spec.ts pins both as literals. A body over either
 * is a 400, which the relay reads as an error and REFUSES, so a limit raised
 * here alone would turn a long command into a refused one. Each repo pins the
 * same two numbers; a change in one tree only is red in that tree.
 *
 * MUTATION PROOF (applied to lib/floor-check.ts, confirmed red, restored):
 * FLOOR_CHECK_TOOL_NAME_MAX set to 256
 * -> this case red, 1 of 52; FLOOR_CHECK_INPUT_PREVIEW_MAX set to 4096 -> this
 * case red, 1 of 52. And the owner switch guard below, narrowed to exempt the
 * token statement: a code line reading `row.hardFloor` appended to
 * lib/floor-check.ts -> that guard red, 1 of 52.
 */
test('the route limits are the two numbers the BGOS DTO pins, 200 and 4000', () => {
  assert.equal(FLOOR_CHECK_TOOL_NAME_MAX, 200)
  assert.equal(FLOOR_CHECK_INPUT_PREVIEW_MAX, 4000)
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

test('the floor is asked BEFORE the auto approve branch, from the hook record first', () => {
  // The permission-relay.test.ts slice pattern. Run D3 is exactly what
  // happens if these two ever swap: auto approve answers first and the floor
  // is never consulted.
  assert.ok(handler.length > 0)
  const record = handler.indexOf('const floorRecord = takeOwnFloorRecord(tool_name, input_preview)')
  const plan = handler.indexOf('const floorPlan = planFloorRequest({')
  const classify = handler.indexOf('classifyPermissionRequest(tool_name, input_preview)')
  const settle = handler.indexOf("if (floorPlan.action === 'consult') return settleFloorRequest(params, floorPlan)")
  const owner = handler.indexOf("if (floorPlan.action === 'ask_elided') {")
  const auto = handler.indexOf('if (AUTO_APPROVE) {')
  assert.ok(record > 0 && plan > 0 && classify > 0 && settle > 0 && owner > 0 && auto > 0, 'all must be in the handler')
  assert.ok(record < plan && plan < auto, 'the record and the plan are read before auto approve')
  assert.ok(settle < auto && owner < auto, 'and a match leaves before auto approve can answer it')
  // The preview is read only when there is no record (it is the lossy copy).
  assert.match(handler, /floorRecord === null && AUTO_APPROVE\s*\?\s*classifyPermissionRequest\(tool_name, input_preview\)\s*:\s*null/)
  assert.match(handler, /autoApprove: AUTO_APPROVE,/)
  const ownerExit = handler.slice(owner, auto)
  assert.ok(ownerExit.includes('return settleElidedFloorRequest(params)'), 'a cut preview with no record asks the server')
  assert.equal(ownerExit.includes("behavior: 'allow'"), false)
  // The stage 6 backend review: the cut command waits for the owner only when
  // the server says the switch holds it, and then only a tap allows it.
  const elided = bodyOf('function settleElidedFloorRequest(', '\n/**')
  assert.ok(elided.includes('return trackMessageOperation(async () => {'))
  assert.ok(elided.includes('path: floorCheckPath(AUTH.mode, ASSISTANT_ID)'))
  assert.match(elided, /case 'hold':\s*return relayPermissionToOwner\(params, undefined, true\)/)
  assert.match(elided, /case 'auto_approve':[\s\S]*behavior: 'allow'/)
})

test('the record is read synchronously, from this daemon folder keys, before any await', () => {
  const take = bodyOf('function takeOwnFloorRecord(', '\n/**')
  assert.ok(take.includes('takeFloorRecord({'))
  assert.ok(take.includes('keys: FLOOR_KEYS'))
  assert.equal(/\bawait\b|\basync\b/.test(take), false, 'no await: it runs inside the handler, before auto approve')
  // The marker rides the lock: written by the holder, taken down on stand down and exit.
  const start = bodyOf('function startHookIntakeIfHolder(', '\n/**')
  assert.ok(start.indexOf('if (!lockHeld) return') < start.indexOf('markFloorAttachedIfHolder()'))
  const stop = bodyOf('function stopHookIntake(', '\n/**')
  assert.ok(stop.includes('clearFloorAttachedMarker()'))
})

test('hold takes the whole interactive path; proceed allows; refuse denies', () => {
  const settle = bodyOf('function settleFloorRequest(', '\n/**')
  assert.ok(settle.length > 0)
  assert.ok(settle.includes('return trackMessageOperation(async () => {'), 'tracked, so a drain waits for it')
  assert.ok(settle.includes('path: floorCheckPath(AUTH.mode, ASSISTANT_ID)'))
  assert.ok(settle.includes('send: postFloorCheck'))
  assert.ok(settle.includes('autoApprove: AUTO_APPROVE'))
  assert.ok(settle.includes('permissionMode: plan.record?.permissionMode ?? null'))
  const hold = settle.slice(settle.indexOf("case 'hold':"), settle.indexOf("case 'auto_approve':"))
  assert.ok(
    hold.includes('return relayPermissionToOwner(params, match.evidence)'),
    'a hold is the interactive path itself, carrying the matched command to the card',
  )
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
  assert.ok(relay.includes('floorEvidence,\n      }),'), 'the matched command reaches the card body')
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
  // ONE spelling of `hard_floor` is not the switch: the capability TOKEN this
  // daemon declares (P2 stage 6), defined once in the shared token file BGOS
  // pins by sha256 and imported everywhere else as HARD_FLOOR_TOKEN. So that
  // exact statement is exempt, and so is documentation (a JSDoc block or a
  // whole line comment), which names the token without reading anything.
  // Everything else still counts: a `hardFloor` field or a `hard_floor`
  // literal in code anywhere is an offender.
  const TOKEN_STATEMENT = "export const HARD_FLOOR_TOKEN = 'hard_floor';"
  const code = (name: string, src: string): string => {
    let out = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    if (name === 'lib/claude-capability-tokens.ts') out = out.split(TOKEN_STATEMENT).join('')
    return out
  }
  const offenders = files
    .filter(([name, src]) => /\bhardFloor\b|\bhard_floor\b/.test(code(name, src)))
    .map(([n]) => n)
  assert.deepEqual(offenders, [])
  // The exemption is the token and nothing more: the token file defines it
  // exactly once, and the declared list takes it from there.
  const tokenFile = files.find(([n]) => n === 'lib/claude-capability-tokens.ts')
  assert.ok(tokenFile, 'the shared token file was scanned')
  assert.equal(tokenFile[1].split(TOKEN_STATEMENT).length, 2)
  assert.equal(code('x.ts', "const on = row.hardFloor === true"), "const on = row.hardFloor === true")
})

// THE STAGE 6 BACKEND REVIEW: a cut shell command no floor record names went
// straight to the owner whatever the switch said, so an auto approve install
// whose owner never touched the switch posted a card for every long unlisted
// command. It now asks the server with elided:true, and waits only on hold.
test('a cut command no record names: the switch decides, the body says elided, and only an error falls back to the owner', async () => {
  const [, command] = LONG_COMMANDS[0]
  const preview = cliPreview({ command, description: 'Clean up' })
  const sent: FloorCheckBody[] = []
  const ask = (reply: () => Promise<{ status: number; text: string }>, path: string | null = 'integrations/assistants/9/floor-check') =>
    consultElidedFloor({
      toolName: 'Bash',
      inputPreview: preview,
      requestId: 'r1',
      path,
      send: async (_path, body) => {
        sent.push(body)
        return reply()
      },
      timeoutMs: 200,
    })
  const hold = await ask(async () => answer(200, { hold: true, rulesVersion: 1 }))
  assert.equal(hold.route, 'hold')
  assert.equal(sent[0].elided, true)
  assert.equal(sent[0].toolName, 'Bash')
  assert.ok(sent[0].inputPreview.length <= FLOOR_CHECK_INPUT_PREVIEW_MAX)
  assert.equal(typeof JSON.parse(sent[0].inputPreview).command, 'string', 'the body is JSON the server reads')
  // The switch is off: auto approve, exactly as before this release.
  assert.equal((await ask(async () => answer(200, { hold: false, rulesVersion: 1 }))).route, 'auto_approve')
  // A backend without the route cannot have the switch on.
  assert.equal((await ask(async () => answer(404, 'Not Found'))).route, 'auto_approve')
  // An API key connection has nowhere to ask, and asks nothing.
  const before = sent.length
  assert.equal((await ask(async () => answer(200, { hold: true }), null)).route, 'auto_approve')
  assert.equal(sent.length, before)
  // An answer that cannot be read is the owner's, never a silent allow.
  assert.equal((await ask(async () => answer(500, 'boom'))).route, 'owner')
  assert.equal((await ask(() => new Promise(() => {}))).route, 'owner')
})
