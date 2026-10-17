/**
 * Cross-repo anti-drift test for the LANE floor, rules version 4 (person
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
import { decideLaneFloor, HOOK_LANE_USER_ID_RE, laneFromArgv } from '../bin/hoai-lane-floor-hook.mjs'
import { LANE_USER_ID_RE } from '../lib/lane-core.mjs'

const ROOT = join(import.meta.dirname, '..')

/** The same literal the backend's hard-floor-lane.spec.ts pins. */
const LANE_FIXTURE_FILE_SHA256 = 'ddfcd10304406ce3a4e8b9f359df6cc3d9cb3312ef86dbc83f5c83bfc867ed39'

test('version 4, one above the owner list it extends, which stays 3', () => {
  assert.equal(HARD_FLOOR_LANE_RULES_VERSION, 4)
  assert.equal(HARD_FLOOR_LANE_FIXTURE_RULES_VERSION, 4)
  assert.equal(HARD_FLOOR_OWNER_RULES_VERSION, 3)
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
    if (rule) assert.equal(rule.rulesVersion, 4)
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
