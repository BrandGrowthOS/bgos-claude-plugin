/**
 * lib/launch-choice.mjs: the model and effort the Helper's launcher (hoai-core)
 * starts one agent on, and the one model switch in flight for it (the app's
 * picker on an agent with no tmux pane, Windows included).
 *
 * The files sit in the agent's own state folder and are read on every launch,
 * so they are read strictly: a family alias or a `claude-` id of the backend
 * catalog's own pattern, one of five efforts, nothing else. Every value
 * becomes one argv element, and these characters pass cmd.exe, VBS and every
 * shell untouched and can never read as a flag.
 *
 * Run: npx tsx --test test/launch-choice.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LAUNCH_CHOICE_CAPABILITY,
  LAUNCH_CHOICE_FILE_NAME,
  MODEL_SWITCH_FILE_NAME,
  isLaunchEffort,
  isLaunchModel,
  launchChoiceArgs,
  launchChoiceBody,
  modelSwitchBody,
  parseLaunchChoice,
  parseModelSwitch,
} from '../lib/launch-choice.mjs'

test('the file names and the supervisor capability are fixed', () => {
  assert.equal(LAUNCH_CHOICE_FILE_NAME, 'launch-choice.json')
  assert.equal(MODEL_SWITCH_FILE_NAME, 'model-switch.json')
  assert.equal(LAUNCH_CHOICE_CAPABILITY, 'launch-choice')
})

test('a model is a family alias or a claude- id of the catalog pattern, at most 48 characters', () => {
  for (const ok of ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5-5', 'claude-sonnet-4-5', 'claude-fable-5-2', 'claude-haiku-4-5-20251001']) {
    assert.equal(isLaunchModel(ok), true, ok)
  }
  const long = `claude-${'a'.repeat(16)}-${'b'.repeat(16)}-${'c'.repeat(8)}`
  assert.equal(long.length, 49)
  assert.equal(isLaunchModel(long.slice(0, 48)), true, 'exactly 48 characters is in')
  for (const bad of [
    '', 'default', 'opus[1m]', 'claude-opus-4-5[1m]', 'CLAUDE-OPUS', 'claude', 'claude-', 'claude--opus',
    'claude-x&calc', 'claude-opus 5', '--dangerously-skip-permissions', '-m', 'gpt-5', 'claude-opus-5-5\n',
    'claude-a-b-c-d-e', `claude-${'a'.repeat(17)}`, long, 'constructor', 'toString', '__proto__', 5, null, undefined, {},
  ]) {
    assert.equal(isLaunchModel(bad), false, String(bad))
  }
})

test('an effort is one of the five the CLI takes at launch, never ultracode', () => {
  for (const ok of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(isLaunchEffort(ok), true)
  for (const bad of ['ultracode', 'Max', 'none', '', 'hasOwnProperty', null, 3]) assert.equal(isLaunchEffort(bad), false, String(bad))
})

test('parseLaunchChoice reads only the strict shape', () => {
  assert.deepEqual(parseLaunchChoice('{"version":1,"model":"claude-sonnet-5-5","effort":"low"}'), { model: 'claude-sonnet-5-5', effort: 'low' })
  assert.deepEqual(parseLaunchChoice('{"version":1,"model":"opus","effort":null}'), { model: 'opus', effort: null })
  for (const bad of [
    null, '', 'not json', '[]', '"opus"', '{}',
    '{"version":2,"model":"opus","effort":"low"}',
    '{"version":1,"model":"opus"}',
    '{"version":1,"model":"opus","effort":"ultracode"}',
    '{"version":1,"model":"claude-x&calc","effort":"low"}',
    '{"version":1,"model":"opus","effort":"low --dangerously-skip-permissions"}',
    `{"version":1,"model":"opus","effort":"low","pad":"${'x'.repeat(5000)}"}`,
  ]) {
    assert.equal(parseLaunchChoice(bad as string | null), null, String(bad).slice(0, 60))
  }
})

test('launchChoiceArgs gives the two flags, the effort only when there is one, and nothing for junk', () => {
  assert.deepEqual(launchChoiceArgs({ model: 'claude-sonnet-5-5', effort: 'low' }), ['--model', 'claude-sonnet-5-5', '--effort', 'low'])
  assert.deepEqual(launchChoiceArgs({ model: 'haiku', effort: null }), ['--model', 'haiku'])
  assert.deepEqual(launchChoiceArgs(null), [])
  assert.deepEqual(launchChoiceArgs({ model: 'claude-x&calc', effort: 'low' } as never), [])
  assert.deepEqual(launchChoiceArgs({ model: 'opus', effort: 'ultracode' } as never), [])
})

test('launchChoiceBody round trips and refuses what the reader would refuse', () => {
  const body = launchChoiceBody({ model: 'claude-opus-5-5', effort: 'high' })
  assert.deepEqual(parseLaunchChoice(body), { model: 'claude-opus-5-5', effort: 'high' })
  assert.throws(() => launchChoiceBody({ model: 'claude-x&calc', effort: 'high' } as never))
})

const SWITCH = {
  state: 'pending',
  target: { model: 'claude-sonnet-5-5', effort: 'low' },
  previous: null,
  from: { model: 'claude-opus-5-5', effort: 'high' },
  sessionId: 'b1f3c0de-0000-4000-8000-0000c0ffee01',
  chatId: '4821',
  requestedAtMs: 1_700_000_000_000,
  launchedAtMs: null,
  reason: null,
  noted: false,
}

test('the model switch record round trips', () => {
  const read = parseModelSwitch(modelSwitchBody(SWITCH as never))
  assert.deepEqual(read, SWITCH)
  const done = parseModelSwitch(modelSwitchBody({ ...SWITCH, state: 'failed', previous: { model: 'opus', effort: 'high' }, launchedAtMs: 1_700_000_005_000, reason: 'start_failed', noted: true } as never))
  assert.equal(done?.state, 'failed')
  assert.deepEqual(done?.previous, { model: 'opus', effort: 'high' })
  assert.equal(done?.reason, 'start_failed')
})

test('a model switch record with any wrong field reads as none', () => {
  const body = JSON.parse(modelSwitchBody(SWITCH as never))
  const bad = [
    { ...body, version: 2 },
    { ...body, state: 'done' },
    { ...body, target: { model: 'claude-x&calc', effort: 'low' } },
    { ...body, previous: { model: '--x', effort: null } },
    { ...body, sessionId: '../etc' },
    { ...body, chatId: '4821 OR 1' },
    { ...body, requestedAtMs: 'soon' },
    { ...body, launchedAtMs: -1 },
    { ...body, reason: 'x'.repeat(65) },
    { ...body, noted: 'yes' },
    { ...body, from: { model: 'opus\nforged', effort: null } },
  ]
  for (const b of bad) assert.equal(parseModelSwitch(JSON.stringify(b)), null, JSON.stringify(b).slice(0, 80))
  assert.equal(parseModelSwitch(null), null)
  assert.equal(parseModelSwitch('{'), null)
})
