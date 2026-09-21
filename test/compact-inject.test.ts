/**
 * Remote /compact injection: structural safety of the send-keys builders.
 *
 * THE invariant under guard: nothing derived from user/chat content can ever
 * be typed into the CLI's composer. The only injectable strings are the
 * fixed literals in the frozen INJECTABLE_LITERALS allow-list plus the
 * 'Enter' key name; targets/sockets come only from supervisor-set env vars
 * and are validated against strict character sets.
 *
 * Run with:  npm test      (node --test, no extra deps)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  GOAL_CONDITION_MAX,
  INJECTABLE_LITERALS,
  resolveTmuxTarget,
  buildProbeArgs,
  buildGoalSetInjectionSteps,
  buildInjectionSteps,
  type TmuxTarget,
} from '../lib/compact-inject.ts'

// ── Allow-list structure ─────────────────────────────────────────────────────

test('allow-list is frozen and contains exactly the known fixed literals', () => {
  assert.ok(Object.isFrozen(INJECTABLE_LITERALS))
  assert.deepEqual(INJECTABLE_LITERALS, {
    compact: '/compact',
    goalClear: '/goal clear',
  })
})

test('buildInjectionSteps throws on a key outside the allow-list', () => {
  const t: TmuxTarget = { target: 's', socketArgs: [], source: 'env-session' }
  assert.throws(() =>
    // Simulates a caller smuggling a free string past the type system.
    buildInjectionSteps(t, 'rm -rf /' as unknown as 'compact'),
  )
})

test('every injected key is either an allow-listed literal or Enter', () => {
  const t: TmuxTarget = {
    target: 'data-900',
    socketArgs: ['-L', 'default'],
    source: 'env-session',
  }
  const allowed = new Set<string>(Object.values(INJECTABLE_LITERALS))
  for (const key of Object.keys(INJECTABLE_LITERALS) as Array<
    keyof typeof INJECTABLE_LITERALS
  >) {
    const steps = buildInjectionSteps(t, key)
    assert.equal(steps.length, 3, 'literal, Enter, paste-safety Enter')
    for (const step of steps) {
      // Shape: tmux [socketArgs] send-keys -t <target> then the payload.
      assert.equal(step.argv[0], 'tmux')
      const sendKeysIdx = step.argv.indexOf('send-keys')
      assert.ok(sendKeysIdx > 0)
      assert.deepEqual(step.argv.slice(1, sendKeysIdx), t.socketArgs)
      assert.equal(step.argv[sendKeysIdx + 1], '-t')
      assert.equal(step.argv[sendKeysIdx + 2], t.target)
      const payload = step.argv.slice(sendKeysIdx + 3)
      const isLiteralStep =
        payload.length === 3 &&
        payload[0] === '-l' &&
        payload[1] === '--' &&
        allowed.has(payload[2]!)
      const isEnterStep = payload.length === 1 && payload[0] === 'Enter'
      assert.ok(
        isLiteralStep || isEnterStep,
        `unexpected injected payload: ${JSON.stringify(payload)}`,
      )
    }
    // First step types the literal (with -l so tmux never key-name-expands
    // it), later steps only press Enter.
    assert.equal(steps[0]!.argv.at(-3), '-l')
    assert.equal(steps[0]!.argv.at(-2), '--', 'the separator guards a literal that starts with a dash')
    assert.ok(allowed.has(steps[0]!.argv.at(-1)!))
    assert.equal(steps[1]!.argv.at(-1), 'Enter')
    assert.equal(steps[2]!.argv.at(-1), 'Enter')
    assert.ok(steps[1]!.delayMsBefore > 0 && steps[2]!.delayMsBefore > 0)
  }
})

// ── Capability detection ─────────────────────────────────────────────────────

test('capability OFF when no env contract and not inside tmux', () => {
  assert.equal(resolveTmuxTarget({}), null)
})

test('BGOS_TMUX_SESSION turns the capability ON (default socket)', () => {
  const t = resolveTmuxTarget({ BGOS_TMUX_SESSION: 'data-900' })
  assert.ok(t)
  assert.equal(t.target, 'data-900')
  assert.deepEqual([...t.socketArgs], [])
  assert.equal(t.source, 'env-session')
})

test('BGOS_TMUX_SOCKET selects a named socket via -L', () => {
  const t = resolveTmuxTarget({
    BGOS_TMUX_SESSION: 'data-900',
    BGOS_TMUX_SOCKET: 'fleet',
  })
  assert.ok(t)
  assert.deepEqual([...t.socketArgs], ['-L', 'fleet'])
})

test('auto-detect: inherited TMUX + TMUX_PANE targets the exact pane via -S', () => {
  const t = resolveTmuxTarget({
    TMUX: '/private/tmp/tmux-501/default,59935,1',
    TMUX_PANE: '%12',
  })
  assert.ok(t)
  assert.equal(t.target, '%12')
  assert.deepEqual([...t.socketArgs], ['-S', '/private/tmp/tmux-501/default'])
  assert.equal(t.source, 'tmux-pane')
})

test('explicit BGOS_TMUX_SESSION wins over auto-detect', () => {
  const t = resolveTmuxTarget({
    BGOS_TMUX_SESSION: 'data-900',
    TMUX: '/tmp/tmux-1/default,1,0',
    TMUX_PANE: '%3',
  })
  assert.ok(t)
  assert.equal(t.target, 'data-900')
  assert.equal(t.source, 'env-session')
})

test('BGOS_REMOTE_COMPACT=off hard-disables everything', () => {
  assert.equal(
    resolveTmuxTarget({
      BGOS_REMOTE_COMPACT: 'off',
      BGOS_TMUX_SESSION: 'data-900',
      TMUX: '/tmp/tmux-1/default,1,0',
      TMUX_PANE: '%3',
    }),
    null,
  )
})

test('malformed targets and sockets are rejected (defense in depth)', () => {
  assert.equal(resolveTmuxTarget({ BGOS_TMUX_SESSION: 'a session' }), null)
  assert.equal(resolveTmuxTarget({ BGOS_TMUX_SESSION: 'x;rm -rf /' }), null)
  assert.equal(resolveTmuxTarget({ BGOS_TMUX_SESSION: '$(boom)' }), null)
  assert.equal(
    resolveTmuxTarget({ BGOS_TMUX_SESSION: 'ok', BGOS_TMUX_SOCKET: 'a b' }),
    null,
  )
  assert.equal(
    resolveTmuxTarget({ TMUX: 'not-absolute,1,0', TMUX_PANE: '%3' }),
    null,
  )
  assert.equal(
    resolveTmuxTarget({ TMUX: '/tmp/sock,1,0', TMUX_PANE: 'nope' }),
    null,
  )
})

test('probe argv resolves any target spec via display-message', () => {
  const t: TmuxTarget = {
    target: '%12',
    socketArgs: ['-S', '/tmp/sock'],
    source: 'tmux-pane',
  }
  assert.deepEqual(buildProbeArgs(t), [
    'tmux', '-S', '/tmp/sock', 'display-message', '-p', '-t', '%12', 'ok',
  ])
})

// The one parameterised literal
//
// The owner's goal condition is the only chat derived text that may ever reach
// a key sequence. It reaches one through buildGoalSetInjectionSteps and through
// nothing else, so every rule that keeps it from becoming a SECOND command is
// tested here rather than at the call site.

const GOAL_TARGET: TmuxTarget = {
  target: '%12',
  socketArgs: ['-S', '/tmp/sock'],
  source: 'tmux-pane',
}

test('a goal set types "/goal <condition>" as ONE literal, then Enter twice', () => {
  const steps = buildGoalSetInjectionSteps(GOAL_TARGET, 'every sign up test passes')
  assert.ok(steps, 'a plain one line condition must be accepted')
  assert.equal(steps.length, 3, 'literal, Enter, paste-safety Enter')
  assert.deepEqual(steps[0]!.argv, [
    'tmux', '-S', '/tmp/sock', 'send-keys', '-t', '%12',
    '-l', '--', '/goal every sign up test passes',
  ])
  assert.equal(steps[0]!.delayMsBefore, 0)
  assert.deepEqual(steps[1]!.argv.slice(-1), ['Enter'])
  assert.deepEqual(steps[2]!.argv.slice(-1), ['Enter'])
  assert.ok(steps[1]!.delayMsBefore > 0 && steps[2]!.delayMsBefore > 0)
})

test('the separator comes before the literal, so a condition starting with a dash is TEXT', () => {
  // Without the separator tmux reads a leading -r as a flag of send-keys and
  // the owner's goal is silently truncated or refused. /compact never hit this;
  // a typed condition can begin with anything.
  const steps = buildGoalSetInjectionSteps(GOAL_TARGET, '-r is handled everywhere')
  assert.ok(steps)
  const sep = steps[0]!.argv.indexOf('--')
  const literal = steps[0]!.argv.indexOf('/goal -r is handled everywhere')
  assert.ok(sep > 0, 'the argv must carry a -- separator')
  assert.equal(literal, sep + 1, 'the separator must come immediately before the literal')
})

test('the condition validator refuses everything that could smuggle a second command', () => {
  // Returns null, never throws: this is reached from a socket handler's path,
  // and a throw there takes the channel down.
  for (const bad of [
    '',
    '   ',
    '\t\t',
    'two\nlines',
    'two\rlines',
    'a bell \u0007 inside',
    'a null \u0000 inside',
    'an escape \u001b[2J inside',
    '/clear',
    '  /goal something',
    'x'.repeat(GOAL_CONDITION_MAX + 1),
  ]) {
    assert.equal(
      buildGoalSetInjectionSteps(GOAL_TARGET, bad),
      null,
      `a condition ${JSON.stringify(bad.slice(0, 20))} must be refused`,
    )
  }
  // The runtime's own cap is 4000 characters, and exactly 4000 is legal.
  const atCap = 'y'.repeat(GOAL_CONDITION_MAX)
  const steps = buildGoalSetInjectionSteps(GOAL_TARGET, atCap)
  assert.ok(steps, 'a condition at the runtime cap must still be injectable')
  assert.equal(steps[0]!.argv.at(-1), `/goal ${atCap}`)
})

test('the validator answers null rather than throwing on a non string', () => {
  assert.equal(
    buildGoalSetInjectionSteps(GOAL_TARGET, undefined as unknown as string),
    null,
  )
  assert.equal(buildGoalSetInjectionSteps(GOAL_TARGET, 42 as unknown as string), null)
})

test('a refused condition builds NO argv at all, so nothing half typed can be sent', () => {
  // The refusal is the whole answer: a caller that ignores null and spreads it
  // would spread nothing, never a partial key sequence.
  assert.equal(buildGoalSetInjectionSteps(GOAL_TARGET, 'line one\nline two'), null)
})
