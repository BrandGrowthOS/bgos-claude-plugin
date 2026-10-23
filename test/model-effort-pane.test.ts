/**
 * Owner model and effort control (Route A): reading the agent's pane before
 * anything is typed into it (lib/model-effort-pane.ts).
 *
 * Three questions, each answered fail closed:
 *   - is the pane there, alive, and not in a tmux mode that would eat keys;
 *   - is the agent's own Claude Code the foreground process of that pane
 *     (a shell, a suspended CLI or another program in front refuses);
 *   - is the composer empty (a draft is the owner's and is never discarded,
 *     and a screen this reader does not recognise is "unknown", refused).
 *
 * The composer fixtures are the CLI's two known layouts (the rule framed
 * prompt and the older box) as tmux capture-pane -e prints them. A live
 * check on the supported CLI version must still confirm them (RESULT.md).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  agentOwnsPane,
  composerHolds,
  parsePaneState,
  readComposer,
} from '../lib/model-effort-pane.ts'

const RULE = '─'.repeat(60)
const DIM = '\u001b[2m'
const UNDIM = '\u001b[22m'
const INV = '\u001b[7m'
const UNINV = '\u001b[27m'

function screen(...lines: string[]): string {
  return ['● Done. The tests pass.', '', ...lines, '  ⏵⏵ accept edits on (shift+tab to cycle)', ''].join('\n')
}

test('pane state: alive, dead, in a mode, and garbage', () => {
  assert.deepEqual(parsePaneState('%7\t/dev/ttys012\t0\t0\t4242\n'), {
    paneId: '%7', tty: '/dev/ttys012', dead: false, inMode: false, pid: 4242,
  })
  assert.equal(parsePaneState('%7\t/dev/ttys012\t1\t0\t4242')!.dead, true)
  assert.equal(parsePaneState('%7\t/dev/ttys012\t0\t1\t4242')!.inMode, true)
  for (const bad of ['', 'ok', '%7\t/dev/ttys012\t0\t0', '7\t/dev/ttys012\t0\t0\t42', '%7\tttys\t0\t0\tx']) {
    assert.equal(parsePaneState(bad), null, JSON.stringify(bad))
  }
})

test('the agent owns the pane only when the pane\'s root is its ancestor and its own job is in front', () => {
  const pane = '/dev/ttys012'
  // The pane runs the CLI directly: the daemon (900) is the CLI's (800) child,
  // same group, in front.
  assert.equal(agentOwnsPane(pane, 800, [
    { pid: 900, tty: 'ttys012', pgid: 800, tpgid: 800 },
    { pid: 800, tty: 'ttys012', pgid: 800, tpgid: 800 },
  ]), true)
  // The pane runs a shell (700) that started the CLI: the CLI's job in front.
  const viaShell = (tpgid: number) => [
    { pid: 900, tty: 'ttys012', pgid: 800, tpgid },
    { pid: 800, tty: 'ttys012', pgid: 800, tpgid },
    { pid: 700, tty: 'ttys012', pgid: 700, tpgid },
  ]
  assert.equal(agentOwnsPane(pane, 700, viaShell(800)), true)
  // The CLI was suspended and the shell is in front: the shell is our
  // ancestor, but it is the pane's root, not our job.
  assert.equal(agentOwnsPane(pane, 700, viaShell(700)), false)
  // Another program the CLI started is in front (its own group).
  assert.equal(agentOwnsPane(pane, 700, viaShell(950)), false)
  // The pane the target names is not one of our ancestors at all.
  assert.equal(agentOwnsPane(pane, 4242, viaShell(800)), false)
  // The CLI runs in ANOTHER terminal than the pane the target names.
  assert.equal(agentOwnsPane(pane, 800, [
    { pid: 900, tty: 'ttys004', pgid: 800, tpgid: 800 },
    { pid: 800, tty: 'ttys004', pgid: 800, tpgid: 800 },
  ]), false)
  // No terminal at all, and nothing known.
  assert.equal(agentOwnsPane(pane, 800, [
    { pid: 900, tty: '??', pgid: 800, tpgid: -1 },
    { pid: 800, tty: '??', pgid: 800, tpgid: -1 },
  ]), false)
  assert.equal(agentOwnsPane(pane, 800, []), false)
  assert.equal(agentOwnsPane('', 800, [{ pid: 900, tty: '', pgid: 800, tpgid: 800 }, { pid: 800, tty: '', pgid: 800, tpgid: 800 }]), false)
})

test('an empty rule framed composer is empty', () => {
  assert.equal(readComposer(screen(RULE, '❯ ', RULE)), 'empty')
  assert.equal(readComposer(screen(RULE, '❯', RULE)), 'empty')
  // The cursor drawn as an inverse space.
  assert.equal(readComposer(screen(RULE, `❯ ${INV} ${UNINV}`, RULE)), 'empty')
})

test('a dimmed placeholder is not a draft, with or without the cursor on its first letter', () => {
  assert.equal(readComposer(screen(RULE, `❯ ${DIM}Try "how does compact work"${UNDIM}`, RULE)), 'empty')
  assert.equal(readComposer(screen(RULE, `❯ ${INV}T${UNINV}${DIM}ry "fix lint errors"${UNDIM}`, RULE)), 'empty')
})

test('a typed draft is a draft, on the prompt line or a continuation line', () => {
  assert.equal(readComposer(screen(RULE, '❯ please also check the logs', RULE)), 'draft')
  assert.equal(readComposer(screen(RULE, `❯ fix th${INV}e${UNINV}`, RULE)), 'draft')
  assert.equal(readComposer(screen(RULE, '❯ first line', '  second line', RULE)), 'draft')
  assert.equal(readComposer(screen(RULE, '❯ ', '  a second line typed after a newline', RULE)), 'draft')
  // Not dimmed text after a dimmed run is still the owner's.
  assert.equal(readComposer(screen(RULE, `❯ ${DIM}Try${UNDIM} hello`, RULE)), 'draft')
})

test('the older box composer reads the same way', () => {
  const top = '╭' + '─'.repeat(58) + '╮'
  const bottom = '╰' + '─'.repeat(58) + '╯'
  assert.equal(readComposer(screen(top, '│ >' + ' '.repeat(55) + '│', bottom)), 'empty')
  assert.equal(readComposer(screen(top, '│ > hello' + ' '.repeat(49) + '│', bottom)), 'draft')
})

test('a screen with no recognisable composer is unknown, never empty', () => {
  assert.equal(readComposer(''), 'unknown')
  assert.equal(readComposer('kc@mac ~ % '), 'unknown')
  assert.equal(readComposer('❯ '), 'unknown', 'a bare prompt glyph with no frame may be a shell theme')
  assert.equal(readComposer(screen(RULE, '❯ ')), 'unknown', 'a frame that never closes')
  assert.equal(readComposer(screen('Do you want to proceed?', '❯ 1. Yes', '  2. No')), 'unknown')
})

test('the composer reader looks at the LAST composer on screen, not an old one in scrollback', () => {
  const old = [RULE, '❯ an old prompt that scrolled up', RULE, '● answer']
  assert.equal(readComposer(screen(...old, RULE, '❯ ', RULE)), 'empty')
  assert.equal(readComposer(screen(RULE, '❯ ', RULE, '● answer', RULE, '❯ new draft', RULE)), 'draft')
})

test('composerHolds sees the literal still sitting in the composer', () => {
  assert.equal(composerHolds(screen(RULE, '❯ /model opus', RULE), '/model opus'), true)
  assert.equal(composerHolds(screen(RULE, '❯ ', RULE), '/model opus'), false)
  assert.equal(composerHolds('', '/model opus'), false)
})
