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
 * prompt and the older box) as tmux capture-pane -e prints them. The real
 * CLI's own screens (2.1.310, light and dark) are replayed in
 * test/model-effort-pane-live.test.ts; they draw the cursor as an inverse
 * cell and the placeholder in SGR 2, which is all these fixtures assume.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  agentOwnsPane,
  composerHolds,
  composerText,
  cursorFollows,
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

test('an empty rule framed composer is empty: the cursor drawn as an inverse cell right after the prompt', () => {
  assert.equal(readComposer(screen(RULE, `❯ ${INV} ${UNINV}`, RULE)), 'empty')
  // The real CLI separates the glyph with a no-break space.
  assert.equal(readComposer(screen(RULE, `❯\u00a0${INV} \u001b[0m`, RULE)), 'empty')
})

test('a dimmed placeholder with the cursor on its first letter is not a draft', () => {
  assert.equal(readComposer(screen(RULE, `❯ ${INV}T${UNINV}${DIM}ry "fix lint errors"${UNDIM}`, RULE)), 'empty')
  // As 2.1.310 writes it: the inverse letter, then a reset that sets dim.
  assert.equal(readComposer(screen(RULE, `❯\u00a0\u001b[7mT\u001b[0;2mry "how do I log an error?"\u001b[0m`, RULE)), 'empty')
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
  assert.equal(readComposer(screen(top, `│ > ${INV} ${UNINV}` + ' '.repeat(53) + '│', bottom)), 'empty')
  assert.equal(readComposer(screen(top, '│ > hello' + ' '.repeat(49) + '│', bottom)), 'draft')
  assert.equal(readComposer(screen(top, '│ >' + ' '.repeat(55) + '│', bottom)), 'unknown', 'no cursor drawn')
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
  assert.equal(readComposer(screen(...old, RULE, `❯ ${INV} ${UNINV}`, RULE)), 'empty')
  assert.equal(readComposer(screen(RULE, `❯ ${INV} ${UNINV}`, RULE, '● answer', RULE, '❯ new draft', RULE)), 'draft')
})

test('composerHolds sees the literal still sitting in the composer', () => {
  assert.equal(composerHolds(screen(RULE, '❯ /model opus', RULE), '/model opus'), true)
  assert.equal(composerHolds(screen(RULE, '❯ ', RULE), '/model opus'), false)
  assert.equal(composerHolds('', '/model opus'), false)
})

// Security review H1 (REVIEW-275.md): the prompt glyph is the one at the START
// of the prompt line, never a `>` found anywhere in it. Before the fix a draft
// whose first `>` ended the line read as empty, and the owner's draft was
// submitted with the command appended.
test('H1: a draft containing, starting or ending with > is a draft, in both layouts', () => {
  const drafts = ['const f = () =>', '<div>', 'compare a->', 'foo > ', 'x >', '>', '> quoted', '>>', 'a ❯', '❯', '❯ b']
  for (const d of drafts) {
    assert.equal(readComposer(screen(RULE, `❯ ${d}`, RULE)), 'draft', `ruled: ${JSON.stringify(d)}`)
    assert.equal(readComposer(screen(RULE, `> ${d}`, RULE)), 'draft', `ruled with >: ${JSON.stringify(d)}`)
    const top = '╭' + '─'.repeat(58) + '╮'
    const bottom = '╰' + '─'.repeat(58) + '╯'
    assert.equal(readComposer(screen(top, `│ > ${d}`.padEnd(59) + '│', bottom)), 'draft', `boxed: ${JSON.stringify(d)}`)
  }
  // Styled: the glyph and the draft each in their own colour.
  assert.equal(readComposer(screen(RULE, `\u001b[1m❯\u001b[0m \u001b[36mconst f = () =>\u001b[0m`, RULE)), 'draft')
})

test('H1: a multi line draft whose lines start or end with > is a draft', () => {
  assert.equal(readComposer(screen(RULE, '❯ if (a) =>', '  > b', RULE)), 'draft')
  assert.equal(readComposer(screen(RULE, '❯ >', '  >', RULE)), 'draft')
  // A blank line the owner typed (a newline) is content too.
  assert.equal(readComposer(screen(RULE, '❯ ', '  ', RULE)), 'draft')
})

test('H1: a draft that wraps is a draft, wherever the wrap falls', () => {
  const long = 'x'.repeat(56)
  // The draft fills the line exactly, ending with >: the cursor wraps onto an
  // otherwise empty next line.
  assert.equal(readComposer(screen(RULE, `❯ ${long}=>`, `  ${INV} ${UNINV}`, RULE)), 'draft')
  assert.equal(readComposer(screen(RULE, `❯ ${long}=>`, '  ', RULE)), 'draft')
  assert.equal(readComposer(screen(RULE, `❯ ${long} =>`, '  rest of the line', RULE)), 'draft')
  assert.equal(readComposer(screen(RULE, `❯ ${long}`, '  => () => {}', RULE)), 'draft')
  assert.equal(readComposer(screen(RULE, `❯ ${long} >`, '  >', RULE)), 'draft')
})

test('H1: spaces typed before the drawn cursor are a draft; a faint continuation is not certain', () => {
  assert.equal(readComposer(screen(RULE, `❯    ${INV} ${UNINV}`, RULE)), 'draft')
  assert.equal(readComposer(screen(RULE, `❯ ${DIM}Try "x"${UNDIM}`, `  ${DIM}more of a hint${UNDIM}`, RULE)), 'unknown')
})

test('H1: composerText reads the typed text exactly, prompt glyph and frame removed', () => {
  assert.equal(composerText(screen(RULE, '❯ /model sonnet', RULE)), '/model sonnet')
  assert.equal(composerText(screen(RULE, `❯ /model sonnet${INV} ${UNINV}`, RULE)), '/model sonnet')
  // Dim text is kept: only a placeholder is dim, and a placeholder is never
  // there once something is typed (round 2, a dim tag before the command).
  assert.equal(composerText(screen(RULE, `❯ /model sonnet${DIM} a faint hint${UNDIM}`, RULE)), '/model sonnet a faint hint')
  assert.equal(composerText(screen(RULE, `❯ ${DIM}[Pasted text #1 +40 lines]${UNDIM}/model sonnet${INV} ${UNINV}`, RULE)), '[Pasted text #1 +40 lines]/model sonnet')
  assert.equal(composerText(screen(RULE, '❯ x/model sonnet', RULE)), 'x/model sonnet')
  assert.equal(composerText(screen(RULE, '❯  /model sonnet', RULE)), ' /model sonnet')
  assert.equal(composerText(screen(RULE, '❯ /model sonnet', '  ', RULE)), '/model sonnet\n')
  assert.equal(composerText(screen(RULE, '❯ a >', RULE)), 'a >')
  const top = '╭' + '─'.repeat(58) + '╮'
  const bottom = '╰' + '─'.repeat(58) + '╯'
  assert.equal(composerText(screen(top, '│ > /model sonnet'.padEnd(59) + '│', bottom)), '/model sonnet')
  assert.equal(composerText('Do you want to proceed?\n❯ 1. Yes'), null)
})

// Round 2 on PR #275, the Medium: "faint" was any grey or black true colour,
// bright black and a 256 grey, and both the empty check and the re-read
// before the Enter skipped faint text. The light themes' text colour is
// rgb(0,0,0), so a draft drawn in it read as empty. Faint is now only what the
// CLI draws its placeholder with, SGR 2, and empty must be proven: the drawn
// cursor at the very start, then nothing or an SGR 2 placeholder.
test('round 2: faint is SGR 2 only; text in black, grey or bright black is typed', () => {
  for (const sgr of ['38;2;0;0;0', '38;2;102;102;102', '38;2;175;175;175', '38;2;80;80;80', '90', '38;5;241', '38;5;16', '38;5;8', '30']) {
    const colour = `\u001b[${sgr}m`
    assert.equal(readComposer(screen(RULE, `❯ ${colour}hello draft\u001b[39m${INV} ${UNINV}`, RULE)), 'draft', sgr)
    assert.equal(readComposer(screen(RULE, `❯ ${colour}hello draft\u001b[39m`, RULE)), 'draft', `${sgr} without a cursor`)
    assert.equal(readComposer(screen(RULE, `❯ ${INV}${colour}h${UNINV}ello draft\u001b[39m`, RULE)), 'draft', `${sgr} cursor at the start`)
    assert.equal(composerText(screen(RULE, `❯ ${colour}x\u001b[39m/model sonnet${INV} ${UNINV}`, RULE)), 'x/model sonnet', sgr)
  }
})

test('round 2: something drawn dim with no space after it, the cursor at its end, is a draft', () => {
  assert.equal(readComposer(screen(RULE, `❯ ${DIM}[Pasted text #1 +40 lines]${UNDIM}${INV} ${UNINV}`, RULE)), 'draft')
  assert.equal(readComposer(screen(RULE, `❯ ${DIM}x${UNDIM}${INV} ${UNINV}`, RULE)), 'draft')
  // Spaces, dim or not, before the cursor.
  assert.equal(readComposer(screen(RULE, `❯ ${DIM}   ${UNDIM}${INV} ${UNINV}`, RULE)), 'draft')
})

test('round 2: the cursor parked on a dim tag the CLI draws for pasted text or an image is a draft, not a placeholder', () => {
  for (const tag of ['[Pasted text #1 +40 lines]', '[Pasted text #2]', '[Image #1]', '[...Truncated text #3 +120 lines...]']) {
    assert.equal(readComposer(screen(RULE, `❯ ${INV}${tag[0]}${UNINV}${DIM}${tag.slice(1)}${UNDIM}`, RULE)), 'draft', tag)
    assert.equal(readComposer(screen(RULE, `❯ ${INV}${tag[0]}${UNINV}${DIM}${tag.slice(1)} more${UNDIM}`, RULE)), 'draft', `${tag} more`)
  }
})

test('round 2: with no cursor drawn the composer is not known to be empty', () => {
  assert.equal(readComposer(screen(RULE, '❯ ', RULE)), 'unknown')
  assert.equal(readComposer(screen(RULE, '❯', RULE)), 'unknown')
  assert.equal(readComposer(screen(RULE, `❯ ${DIM}Try "how does compact work"${UNDIM}`, RULE)), 'unknown')
  assert.equal(readComposer(screen(RULE, `❯ ${DIM}[Pasted text #1 +40 lines]${UNDIM}`, RULE)), 'unknown')
  // Text that is not dim is still a draft, cursor or not.
  assert.equal(readComposer(screen(RULE, '❯ hello', RULE)), 'draft')
})

test('round 2: only the CLI\'s own placeholder form is empty', () => {
  // The cursor's letter itself dim: not how the CLI draws its placeholder.
  assert.equal(readComposer(screen(RULE, `❯ ${DIM}${INV}T${UNINV}ry "x"${UNDIM}`, RULE)), 'unknown')
  // A second inverse cell: not the CLI's.
  assert.equal(readComposer(screen(RULE, `❯ ${INV}T${UNINV}${DIM}ry${UNDIM}${INV} ${UNINV}`, RULE)), 'unknown')
  // A blank cursor followed by dim text: not the CLI's either.
  assert.equal(readComposer(screen(RULE, `❯ ${INV} ${UNINV}${DIM}hint${UNDIM}`, RULE)), 'unknown')
  // One typed letter with the cursor on it.
  assert.equal(readComposer(screen(RULE, `❯ ${INV}x${UNINV}`, RULE)), 'draft')
})

// Round 2, Low 1: the typed command is cleared one BSpace per character only
// when the screen shows the cursor right after it, at the very end of the
// composer. An arrow key the owner pressed moves the cursor, and the BSpaces
// would then delete the owner's characters.
test('round 2 L1: cursorFollows is true only with the cursor right after the command at the end of the composer', () => {
  const cmd = '/model sonnet'
  assert.equal(cursorFollows(screen(RULE, `❯ ${cmd}${INV} ${UNINV}`, RULE), cmd), true)
  assert.equal(cursorFollows(screen(RULE, `❯ q${cmd}${INV} ${UNINV}`, RULE), cmd), true)
  assert.equal(cursorFollows(screen(RULE, `❯\u00a0q\u001b[38;5;105m/model\u001b[39m sonnet\u001b[7m \u001b[0m`, RULE), cmd), true)
  // The cursor moved onto the command, or before it.
  assert.equal(cursorFollows(screen(RULE, `❯ q/model sonne${INV}t${UNINV}`, RULE), cmd), false)
  assert.equal(cursorFollows(screen(RULE, `❯ q${INV}/${UNINV}model sonnet`, RULE), cmd), false)
  // No cursor, text after the cursor, a line after it, another composer state.
  assert.equal(cursorFollows(screen(RULE, `❯ q${cmd}`, RULE), cmd), false)
  assert.equal(cursorFollows(screen(RULE, `❯ q${cmd}${INV} ${UNINV}k`, RULE), cmd), false)
  assert.equal(cursorFollows(screen(RULE, `❯ q${cmd}${INV} ${UNINV}`, '  more', RULE), cmd), false)
  assert.equal(cursorFollows(screen(RULE, `❯ q`, `  ${cmd}${INV} ${UNINV}`, RULE), cmd), true)
  assert.equal(cursorFollows(screen(RULE, `❯ q${cmd.slice(0, 4)}`, `  ${cmd.slice(4)}${INV} ${UNINV}`, RULE), cmd), false, 'wrapped: not provable')
  assert.equal(cursorFollows('Do you want to proceed?\n❯ 1. Yes', cmd), false)
})
