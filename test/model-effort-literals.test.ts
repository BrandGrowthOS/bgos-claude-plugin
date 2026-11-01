/**
 * Owner model and effort control (Route A): the frozen literal tables and the
 * two builders in lib/compact-inject.ts.
 *
 * THE invariant under guard: a set_model or set_effort request can only ever
 * type one of the fixed strings below. The value on the wire is a lookup key,
 * never text: anything that is not exactly an own key of the frozen table
 * builds NO argv at all (null), so nothing half typed can be sent. No slash
 * command and no free text reaches the composer through these builders.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EFFORT_LITERALS,
  INJECTABLE_LITERALS,
  MODEL_LITERALS,
  buildPaneCaptureArgs,
  buildPaneStateArgs,
  buildSetEffortInjectionSteps,
  buildSetModelInjectionSteps,
  isEffortLevel,
  isModelFamily,
  type TmuxTarget,
} from '../lib/compact-inject.ts'

const T: TmuxTarget = { target: '%7', socketArgs: ['-S', '/tmp/tmux-501/default'], source: 'tmux-pane' }

test('the model table is frozen and holds exactly the four approved families', () => {
  assert.ok(Object.isFrozen(MODEL_LITERALS))
  assert.deepEqual(MODEL_LITERALS, {
    opus: '/model opus',
    sonnet: '/model sonnet',
    haiku: '/model haiku',
    fable: '/model fable',
  })
})

test('the effort table is frozen, holds the five ordinary levels and NOT ultracode', () => {
  assert.ok(Object.isFrozen(EFFORT_LITERALS))
  assert.deepEqual(EFFORT_LITERALS, {
    low: '/effort low',
    medium: '/effort medium',
    high: '/effort high',
    xhigh: '/effort xhigh',
    max: '/effort max',
  })
  assert.equal(isEffortLevel('ultracode'), false, 'this host cannot confirm Ultra Code, so it has no literal')
})

test('the compact and goal table is untouched by the new tables', () => {
  assert.deepEqual(INJECTABLE_LITERALS, { compact: '/compact', goalClear: '/goal clear' })
})

test('set_model types its fixed literal then ONE Enter, nothing else', () => {
  for (const family of Object.keys(MODEL_LITERALS)) {
    const steps = buildSetModelInjectionSteps(T, family)
    assert.ok(steps, family)
    assert.equal(steps.length, 2, 'literal then one Enter: a second Enter could accept a menu item')
    assert.deepEqual(steps[0]!.argv, [
      'tmux', '-S', '/tmp/tmux-501/default', 'send-keys', '-t', '%7', '-l', '--',
      MODEL_LITERALS[family as keyof typeof MODEL_LITERALS],
    ])
    assert.deepEqual(steps[1]!.argv, ['tmux', '-S', '/tmp/tmux-501/default', 'send-keys', '-t', '%7', 'Enter'])
    assert.ok(steps[1]!.delayMsBefore > 0)
  }
})

test('set_effort types its fixed literal then ONE Enter, nothing else', () => {
  for (const level of Object.keys(EFFORT_LITERALS)) {
    const steps = buildSetEffortInjectionSteps(T, level)
    assert.ok(steps, level)
    assert.equal(steps.length, 2)
    assert.equal(steps[0]!.argv.at(-1), EFFORT_LITERALS[level as keyof typeof EFFORT_LITERALS])
    assert.equal(steps[1]!.argv.at(-1), 'Enter')
  }
})

test('every injection attempt builds NO argv at all', () => {
  const attempts: unknown[] = [
    '', ' ', 'Opus', 'OPUS', ' opus', 'opus ', 'opus\n', 'opus\r', 'opus;', 'opus && rm -rf ~',
    'opus\u001b[A', '/model opus', 'claude-opus-5-5', 'opus[1m]', 'default', 'gpt-5', 'opusplan',
    'toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf',
    null, undefined, 1, true, {}, [], ['opus'], { toString: () => 'opus' },
  ]
  for (const value of attempts) {
    assert.equal(buildSetModelInjectionSteps(T, value), null, `model ${JSON.stringify(String(value))}`)
    assert.equal(isModelFamily(value), false)
  }
  const effortAttempts: unknown[] = [
    ...attempts, 'ultracode', 'Ultracode', 'off', 'auto', 'HIGH', 'high ', 'high\n', 'max;', '/effort high',
    'xhigh\u0000', 'medium && /model opus',
  ]
  for (const value of effortAttempts) {
    assert.equal(buildSetEffortInjectionSteps(T, value), null, `effort ${JSON.stringify(String(value))}`)
    assert.equal(isEffortLevel(value), false)
  }
})

test('the pane probes are read only tmux queries on the same validated target', () => {
  const state = buildPaneStateArgs(T)
  assert.deepEqual(state.slice(0, 6), ['tmux', '-S', '/tmp/tmux-501/default', 'display-message', '-p', '-t'])
  assert.equal(state[6], '%7')
  assert.ok(!state.includes('send-keys'))
  const capture = buildPaneCaptureArgs(T)
  assert.deepEqual(capture, ['tmux', '-S', '/tmp/tmux-501/default', 'capture-pane', '-p', '-e', '-t', '%7'])
})
