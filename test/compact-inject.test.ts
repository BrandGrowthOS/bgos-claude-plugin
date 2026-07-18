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
  INJECTABLE_LITERALS,
  resolveTmuxTarget,
  buildProbeArgs,
  buildInjectionSteps,
  type TmuxTarget,
} from '../lib/compact-inject.ts'

// ── Allow-list structure ─────────────────────────────────────────────────────

test('allow-list is frozen and contains exactly the known fixed literals', () => {
  assert.ok(Object.isFrozen(INJECTABLE_LITERALS))
  assert.deepEqual(INJECTABLE_LITERALS, { compact: '/compact' })
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
        payload.length === 2 && payload[0] === '-l' && allowed.has(payload[1]!)
      const isEnterStep = payload.length === 1 && payload[0] === 'Enter'
      assert.ok(
        isLiteralStep || isEnterStep,
        `unexpected injected payload: ${JSON.stringify(payload)}`,
      )
    }
    // First step types the literal (with -l so tmux never key-name-expands
    // it), later steps only press Enter.
    assert.equal(steps[0]!.argv.at(-2), '-l')
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
