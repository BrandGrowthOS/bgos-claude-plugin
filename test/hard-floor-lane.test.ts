/**
 * Cross-repo anti-drift test for the LANE floor, rules version 5 (person
 * lanes, shared agents Phase 3, P3; design 7.2 item 8).
 *
 * lib/hard-floor-lane-fixture.ts is COPIED BYTE FOR BYTE from the backend's
 * backend/src/services/hard-floor-lane-fixture.ts, whose spec pins the same
 * sha256 and runs the same cases through the server's classifier. This file
 * runs every case through the plugin's port (lib/hard-floor-lane.mjs) and
 * through the lane's own hook (bin/hoai-lane-floor-hook.mjs), which must
 * DENY every hold and FAIL CLOSED on anything it cannot read.
 *
 * Run with: npx tsx --test test/hard-floor-lane.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { HARD_FLOOR_LANE_FIXTURE, HARD_FLOOR_LANE_FIXTURE_RULES_VERSION } from '../lib/hard-floor-lane-fixture.ts'
import { classifyLaneFloor, classifyLaneToolCall, HARD_FLOOR_LANE_RULES_VERSION, HARD_FLOOR_OWNER_RULES_VERSION } from '../lib/hard-floor-lane.mjs'
import * as laneCore from '../lib/hard-floor-lane.mjs'
import { decideLaneFloor, HOOK_LANE_USER_ID_RE, laneFromArgv } from '../bin/hoai-lane-floor-hook.mjs'
import { LANE_USER_ID_RE } from '../lib/lane-core.mjs'

const ROOT = join(import.meta.dirname, '..')

/**
 * The same literal the backend's hard-floor-lane.spec.ts pins. 0.87.5 (board row a633fb9c): this copy's
 * example paths name /Users/you instead of our own home folders, so the literal moved here first; the
 * BGOS copy and its spec must take the same bytes.
 */
const LANE_FIXTURE_FILE_SHA256 = '0e8475175c4ab0e91350a3bba9162e4cd931874a19814f72c142a277c192a3c2'

test('version 5, one above the owner list it extends, which is 4', () => {
  assert.equal(HARD_FLOOR_LANE_RULES_VERSION, 5)
  assert.equal(HARD_FLOOR_LANE_FIXTURE_RULES_VERSION, 5)
  assert.equal(HARD_FLOOR_OWNER_RULES_VERSION, 4)
})

test('the fixture file is the backend\'s bytes, at LF', () => {
  const bytes = readFileSync(join(ROOT, 'lib', 'hard-floor-lane-fixture.ts'))
  assert.ok(!bytes.includes(13), 'no CR')
  assert.equal(createHash('sha256').update(bytes).digest('hex'), LANE_FIXTURE_FILE_SHA256)
  assert.match(readFileSync(join(ROOT, '.gitattributes'), 'utf8'), /^lib\/hard-floor-lane-fixture\.ts text eol=lf$/m)
})

test('the list is load bearing on both sides', () => {
  assert.ok(HARD_FLOOR_LANE_FIXTURE.filter((c) => c.expected === 'reads_a_secret').length >= 10)
  assert.ok(HARD_FLOOR_LANE_FIXTURE.filter((c) => c.expected === null).length >= 5)
})

for (const c of HARD_FLOOR_LANE_FIXTURE) {
  test(`fixture: ${c.name}`, () => {
    const rule = classifyLaneFloor({ kind: 'request', toolName: c.toolName, inputPreview: c.inputPreview }, { actorUserId: c.actorUserId })
    assert.equal(rule?.ruleId ?? null, c.expected)
    if (rule) assert.equal(rule.rulesVersion, 5)
  })
}

function hook(toolName: string, toolInput: unknown, userId: string | null = 'user_ana') {
  return decideLaneFloor(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput }), userId, classifyLaneToolCall)
}

function denied(out: string): boolean {
  if (!out) return false
  const parsed = JSON.parse(out)
  return parsed.hookSpecificOutput?.hookEventName === 'PreToolUse' && parsed.hookSpecificOutput?.permissionDecision === 'deny'
}

test('the lane hook DENIES a call whose read stopped at the nesting limit (the fix round, I3)', () => {
  // `eval` five deep: the owner list's read stopped at its nesting limit and
  // said nothing, so a lane let the delete through.
  const read = (command: string) =>
    decideLaneFloor(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }), 'user_ana', laneCore.readLaneToolCall)
  assert.ok(denied(read('eval eval eval eval eval rm -rf ~')))
  assert.equal(read('eval eval eval eval echo hi'), '')
  assert.equal(read('ls'), '')
})

test('the lane hook DENIES a command longer than the list reads when nothing matched (round 29, review B item 1)', async () => {
  // The owner list reads the first HARD_FLOOR_MAX_TEXT of a command; a
  // delete past that cut was never read, so the lane let it through. The
  // backend's lane route holds a preview that long (unreadTail): parity.
  const { HARD_FLOOR_MAX_TEXT } = await import('../lib/hard-floor-core.mjs')
  const pad = 'a'.repeat(HARD_FLOOR_MAX_TEXT)
  const over = `echo ${pad}\nrm -rf ~`
  const call = (toolName: string, command: string, classify: typeof classifyLaneToolCall) =>
    decideLaneFloor(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: { command } }), 'user_ana', classify)
  assert.ok(over.length > HARD_FLOOR_MAX_TEXT)
  assert.equal(laneCore.readLaneToolCall('Bash', { command: over }, { actorUserId: 'user_ana' }).stoppedEarly, true)
  for (const classify of [laneCore.readLaneToolCall, classifyLaneToolCall] as (typeof classifyLaneToolCall)[]) {
    assert.ok(denied(call('Bash', over, classify)), 'Bash over the limit')
    assert.ok(denied(call('PowerShell', over, classify)), 'PowerShell over the limit')
    // At the limit the whole command is read: an ordinary one still runs.
    assert.equal(call('Bash', `echo ${pad}`.slice(0, HARD_FLOOR_MAX_TEXT), classify), '')
  }
  assert.equal(laneCore.readLaneToolCall('Bash', { command: 'ls' }, { actorUserId: 'user_ana' }).stoppedEarly, false)
  // The hook's own limit is the core's.
  const hookModule = await import('../bin/hoai-lane-floor-hook.mjs')
  assert.equal(hookModule.LANE_FLOOR_MAX_TEXT, HARD_FLOOR_MAX_TEXT)
})

test('the lane hook DENIES a secret read, another person\'s lane, a v3 action', () => {
  assert.ok(denied(hook('Read', { file_path: '/Users/kc/.ssh/id_ed25519' })))
  assert.ok(denied(hook('Read', { file_path: '/Users/kc/.bgos-agent/1076/people/user_ben/work/notes.md' })))
  assert.ok(denied(hook('Grep', { pattern: 'x', path: '/Users/kc/.bgos-plugin-state' })))
  assert.ok(denied(hook('Write', { file_path: '/Users/kc/.bgos-agent/1076/people/user_ana/work/.env', content: 'A=1' })))
  assert.ok(denied(hook('mcp__bgos__reply', { chat_id: '777', text: 'x', files: [{ path: '/Users/kc/.aws/credentials' }] })))
})

test('the lane hook lets the lane\'s own work through', () => {
  assert.equal(hook('Read', { file_path: '/Users/kc/.bgos-agent/1076/people/user_ana/work/notes.md' }), '')
  assert.equal(hook('Write', { file_path: '/Users/kc/.bgos-agent/1076/people/user_ana/work/out.txt', content: 'hi' }), '')
  assert.equal(hook('mcp__bgos__reply', { chat_id: '777', text: 'hello' }), '')
})

test('the lane hook FAILS CLOSED: no person, unreadable input, no tool name', () => {
  assert.ok(denied(hook('Read', { file_path: '/tmp/x' }, null)))
  assert.ok(denied(decideLaneFloor('not json', 'user_ana', classifyLaneToolCall)))
  assert.ok(denied(decideLaneFloor('{"tool_input":{}}', 'user_ana', classifyLaneToolCall)))
  assert.ok(denied(decideLaneFloor('null', 'user_ana', classifyLaneToolCall)))
  // Its rules could not be loaded (a moved or half updated plugin folder): deny.
  assert.ok(denied(decideLaneFloor(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/w/x' } }), 'user_ana', null)))
  assert.equal(HOOK_LANE_USER_ID_RE.source, LANE_USER_ID_RE.source, 'the hook\'s own id rule is lane-core\'s')
  assert.equal(laneFromArgv(['--lane', 'user_ana']), 'user_ana')
  assert.equal(laneFromArgv(['--lane', '../x']), null)
  assert.equal(laneFromArgv([]), null)
})
