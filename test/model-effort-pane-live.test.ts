/**
 * Owner model and effort control: the composer reader against the REAL
 * Claude Code CLI's screen (round 2 on PR #275, the "faint" Medium).
 *
 * test/fixtures/claude-2.1.310-composer/ holds `tmux capture-pane -p -e`
 * captures of the installed Claude Code 2.1.310, run in a private tmux server
 * in a scratch folder with its own config folder, in its light and dark
 * themes, each with the CLI's default colours inside tmux (256, the CLI clamps
 * to 256 when TMUX is set) and with CLAUDE_CODE_TMUX_TRUECOLOR=1 (true
 * colour). No Enter was ever pressed in that session (RESULT.md, "Round 2").
 *
 * What those captures show, and what the reader now relies on:
 *   - the placeholder is drawn with SGR 2 (chalk dim), its first letter in
 *     inverse video where the cursor sits: `\e[7mT\e[0;2mry "..."`;
 *   - typed text, a draft starting with `>`, and the `[Pasted text #1 +40
 *     lines]` tag are drawn in the default colour, the cursor an inverse cell;
 *   - the prompt glyph is followed by a no-break space (U+00A0).
 *
 * The recoloured cases replay each real draft with its text in the colours a
 * theme can use for text (the light theme's `text` is rgb(0,0,0), its
 * `inactive` rgb(102,102,102), bright black, a 256 grey) and in SGR 2: none
 * of them may ever read as an empty composer.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { composerText, readComposer } from '../lib/model-effort-pane.ts'

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-2.1.310-composer')
const MODES = ['light-256', 'light-tc', 'dark-256', 'dark-tc'] as const
/** The real prompt: the glyph, then a NO-BREAK space (U+00A0), not a plain one. */
const PROMPT = '❯\u00a0'

function live(mode: string, name: string): string {
  return readFileSync(join(DIR, `${mode}-${name}.ansi`), 'utf8')
}

test('round 2 live: the real CLI\'s empty composer with its placeholder is empty, in both themes', () => {
  for (const mode of MODES) {
    assert.equal(readComposer(live(mode, '1-empty-placeholder')), 'empty', mode)
    assert.equal(readComposer(live(mode, '2b-cleared')), 'empty', `${mode} cleared`)
  }
})

test('round 2 live: the real CLI\'s drafts are drafts, in both themes', () => {
  for (const mode of MODES) {
    for (const name of ['2-typed-draft', '3-draft-starting-gt', '4-pasted-multiline', '4b-pasted-cursor-at-start']) {
      assert.equal(readComposer(live(mode, name)), 'draft', `${mode} ${name}`)
    }
  }
})

test('round 2 live: the typed command reads back exactly, so the one Enter can follow it', () => {
  for (const mode of MODES) {
    assert.equal(composerText(live(mode, '5-literal-model')), '/model sonnet', mode)
    assert.equal(composerText(live(mode, '6-literal-effort')), '/effort high', mode)
  }
})

/** The real capture with the draft's text drawn in `sgr` (the prompt glyph kept). */
function recolour(capture: string, draft: string, sgr: string): string {
  const lines = capture.split('\n')
  const at = lines.findLastIndex((l) => l.includes(`${PROMPT}${draft}`))
  assert.ok(at >= 0, `the draft ${JSON.stringify(draft)} is on the real screen`)
  lines[at] = lines[at]!.replace(`${PROMPT}${draft}`, `${PROMPT}\u001b[${sgr}m${draft}\u001b[0m`)
  return lines.join('\n')
}

const COLOURS: Record<string, string> = {
  'light theme text, rgb(0,0,0)': '38;2;0;0;0',
  'light theme inactive, rgb(102,102,102)': '38;2;102;102;102',
  'dark theme subtle, rgb(80,80,80)': '38;2;80;80;80',
  'bright black': '90',
  '256 grey 241': '38;5;241',
  '256 black 16': '38;5;16',
  'SGR 2 (dim)': '2',
}

test('round 2: a real draft drawn in black, grey or dim is still a draft (never an empty composer)', () => {
  const drafts: Array<[string, string]> = [
    ['2-typed-draft', 'hello draft'],
    ['3-draft-starting-gt', '> quoted line'],
    ['4-pasted-multiline', '[Pasted text #1 +40 lines]'],
  ]
  for (const mode of MODES) {
    for (const [name, draft] of drafts) {
      for (const [label, sgr] of Object.entries(COLOURS)) {
        const screen = recolour(live(mode, name), draft, sgr)
        assert.equal(readComposer(screen), 'draft', `${mode} ${name} in ${label}`)
      }
    }
  }
})

test('round 2: the re-read before the Enter keeps dim text, so a dim tag before the command is never dropped', () => {
  for (const mode of MODES) {
    // The real screen after the command was typed, with a dim tag drawn in
    // front of it on the prompt line (the reviewer's probe on the fake).
    const lines = live(mode, '5-literal-model').split('\n')
    const at = lines.findLastIndex((l) => l.includes(PROMPT))
    lines[at] = lines[at]!.replace(PROMPT, `${PROMPT}\u001b[2m[Pasted text #1 +40 lines]\u001b[22m`)
    const screen = lines.join('\n')
    assert.notEqual(composerText(screen), '/model sonnet', mode)
    assert.equal(composerText(screen), '[Pasted text #1 +40 lines]/model sonnet', mode)
  }
})
