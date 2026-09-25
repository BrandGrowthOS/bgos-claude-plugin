/**
 * Source guard: the MCP instructions server.ts bundles carry the served
 * canon's Claude Sessions sentence word for word, and keep the stop paragraph
 * as Wave C wrote it (P6 stage 3, C-32, Wave H item 40's plugin half).
 *
 * The instructions string is the offline fallback of the served canon: it is
 * in the model's context on every session, including the one where the
 * capabilities fetch failed and the served Claude delta never arrived. The
 * served delta (backend/src/integrations/capability-canon.ts,
 * CLAUDE_SESSIONS_SENTENCE) tells a daemon that declares sessions_library
 * that the Sessions sheet lists its folder's sessions and that resuming one
 * from the app is not available yet. This plugin declares sessions_library on
 * every host (lib/declared-capabilities.ts), so the bundled copy says the same
 * thing unconditionally. The two repositories cannot import from one another,
 * so a literal copied byte for byte is the only thing that keeps the offline
 * copy honest, as test/capabilities.test.ts does for the bgos_capabilities
 * tool's own fallback (lib/capabilities.ts, which carries neither the stop
 * nor the Sessions line and is not changed here).
 *
 * server.ts is a monolith no test can import, so the instructions are rebuilt
 * from the source: every element of the array literal, unescaped, joined with
 * a newline, exactly as the Server constructor joins them. The repo idiom for
 * a source scan: read through an import.meta.url URL and normalise CRLF to LF
 * first, so the assertions describe the code and not the checkout.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// Copied BYTE FOR BYTE out of the served canon
// (backend/src/integrations/capability-canon.ts, CLAUDE_SESSIONS_SENTENCE,
// served only to a daemon that declares sessions_library). The canon serves
// it as a list item; the instructions carry it as its own paragraph, so the
// words compared are the item's body after its "- " marker.
const SERVED_CLAUDE_SESSIONS_SENTENCE =
  '- Your owner can find the sessions in your agent folder by title in the Sessions sheet in the app; resuming one from the app is not available yet.'

// The stop paragraph as Wave C left it (b112df1: the last three lines were
// that commit's addition). It is this plugin's own wording, not the served
// CLAUDE_STOP_SENTENCE, and it must not move while the Sessions line lands
// beside it.
const WAVE_C_STOP_PARAGRAPH =
  'When your user presses Stop for a chat, a channel notification arrives ' +
  'whose content starts with `[stop_turn]` and whose meta carries ' +
  '`event_type = "stop_turn"` plus the `chat_id`. Honor it IMMEDIATELY: ' +
  'stop working on that chat, do not start any new tool calls for it, and ' +
  'send ONE short `reply` line to that chat acknowledging where you ' +
  'stopped. Keep any partial results you already sent; do not undo work. ' +
  'The stop applies ONLY to that chat_id; other chats are unaffected. ' +
  'A Stop is neither a finish nor a failure: if that chat has an open ' +
  'mission, leave it open and do not call `complete_mission` for it because ' +
  'of the stop. Your owner can resume.'

const OPEN = '    instructions: [\n'
const CLOSE = "\n    ].join('\\n'),"

/** The instructions string exactly as server.ts hands it to the MCP Server. */
function bundledInstructions(): string {
  const open = server.indexOf(OPEN)
  assert.ok(open >= 0, 'the instructions array moved')
  const close = server.indexOf(CLOSE, open)
  assert.ok(close > open, 'the end of the instructions array moved')
  return server
    .slice(open + OPEN.length, close)
    .split('\n')
    .map((line, i) => {
      const m = line.match(/^\s*'((?:[^'\\]|\\.)*)',$/)
      assert.ok(m, `instructions element ${i + 1} is not one plain single quoted string: ${line}`)
      return m[1].replace(/\\(.)/g, '$1')
    })
    .join('\n')
}

/** The Session Controls section, from its heading to the next one or the end. */
function sessionControlsSection(): string {
  const text = bundledInstructions()
  const at = text.indexOf('## Session Controls')
  assert.ok(at >= 0, 'the Session Controls section is gone from the instructions')
  const next = text.indexOf('\n## ', at + 1)
  return next < 0 ? text.slice(at) : text.slice(at, next)
}

test('the bundled instructions carry the served Claude Sessions sentence, word for word, on its own line', () => {
  assert.ok(SERVED_CLAUDE_SESSIONS_SENTENCE.startsWith('- '), 'the served literal lost its list marker')
  const words = SERVED_CLAUDE_SESSIONS_SENTENCE.slice(2)
  // One line, so a rewrap cannot hide a changed word from this check and the
  // model reads the sentence exactly as the served delta says it.
  assert.ok(
    bundledInstructions().split('\n').includes(words),
    'the offline copy has drifted from the served Claude delta; copy CLAUDE_SESSIONS_SENTENCE across verbatim',
  )
})

test('the Sessions sentence sits in the Session Controls section, after the stop paragraph', () => {
  const section = sessionControlsSection()
  const words = SERVED_CLAUDE_SESSIONS_SENTENCE.slice(2)
  const sessionsAt = section.indexOf(words)
  const stopEnd = section.indexOf('of the stop. Your owner can resume.')
  assert.ok(sessionsAt >= 0, 'the Sessions sentence is not in the Session Controls section')
  assert.ok(stopEnd >= 0, 'the stop paragraph is not in the Session Controls section')
  assert.ok(sessionsAt > stopEnd, 'the Sessions sentence must follow the stop paragraph, as the served delta orders them')
})

test('the stop paragraph stays as Wave C wrote it', () => {
  const flat = sessionControlsSection().replace(/\s+/g, ' ')
  assert.ok(flat.includes(WAVE_C_STOP_PARAGRAPH), 'the Wave C stop paragraph changed in the bundled instructions')
})

test('the bundled instructions stay free of dashes, because they are a prompt', () => {
  assert.equal(/[\u2013\u2014]/.test(bundledInstructions()), false)
})
