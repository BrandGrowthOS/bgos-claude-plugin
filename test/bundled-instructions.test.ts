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

// ── The question card guidance (scope section 6, Data's option A) ────────────
//
// Agents used to be told to use ask_user_input ONLY while the owner was
// actively in the conversation, so with an owner away they sent several button
// messages instead, each answerable alone and none of them grouped. The rule
// is now one card for 2 or more decisions, online or not, and it is said in
// the same words everywhere a Claude Code agent reads it: the bundled
// instructions, the tool descriptions and the capabilities fallback. The BGOS
// canon serves the same sentences to a daemon that declares ask_answered.

const SECTION_6 =
  'Any message asking your owner 2 or more decisions is ONE ask_user_input card (up to 4 questions), online or not. ' +
  'A reply with buttons asks exactly one thing. ' +
  'The card returns at once as pending: end your turn and do nothing that depends on the answers; ' +
  'they arrive together as one ask_answered event, however late. ' +
  'Use wait_seconds only if your owner wrote in the last few minutes and you cannot continue without the answer.'

/** Every plain string literal of one tool's description, unescaped and joined, as the tool list sends it. */
function toolDescription(name: string): string {
  const at = server.indexOf(`      name: '${name}',\n      description:`)
  assert.ok(at >= 0, `the ${name} tool moved`)
  const end = server.indexOf('inputSchema:', at)
  const literals = server.slice(at, end).match(/'(?:[^'\\]|\\.)*'/g) ?? []
  return literals.slice(1).map((l) => l.slice(1, -1).replace(/\\(.)/g, '$1')).join('')
}

/** One schema property's description, the same way. */
function propertyDescription(tool: string, property: string): string {
  const at = server.indexOf(`      name: '${tool}',\n      description:`)
  const prop = server.indexOf(`          ${property}: {`, at)
  assert.ok(at >= 0 && prop > at, `${tool}.${property} moved`)
  const start = server.indexOf('description:', prop)
  const end = server.indexOf('\n          },', start)
  const literals = server.slice(start, end).match(/'(?:[^'\\]|\\.)*'/g) ?? []
  return literals.map((l) => l.slice(1, -1).replace(/\\(.)/g, '$1')).join('')
}

const ONLY_WHILE_PRESENT = /actively|not waiting on you|blocking modal|blocking multi|demand(?:s|ing)? (?:immediate )?attention|inappropriate for async/i

test('the bundled instructions carry section 6 word for word, on its own line', () => {
  assert.ok(
    bundledInstructions().split('\n').includes(SECTION_6),
    'the question card rule is not one line of the bundled instructions, word for word',
  )
})

test('the ask_user_input description carries section 6, and withdraw_ask', () => {
  const d = toolDescription('ask_user_input')
  assert.ok(d.includes(SECTION_6), d)
  assert.match(d, /withdraw_ask/)
})

test('the bundled capabilities fallback carries section 6', async () => {
  const { BGOS_CAPABILITIES_FALLBACK } = await import('../lib/capabilities.ts')
  assert.ok(BGOS_CAPABILITIES_FALLBACK.replace(/\s+/g, ' ').includes(SECTION_6))
  assert.doesNotMatch(BGOS_CAPABILITIES_FALLBACK, ONLY_WHILE_PRESENT)
})

test('nothing tells the agent to ask only an owner who is actively in the conversation', () => {
  assert.doesNotMatch(bundledInstructions(), ONLY_WHILE_PRESENT)
  for (const text of [
    toolDescription('ask_user_input'),
    toolDescription('reply'),
    propertyDescription('reply', 'render_mode'),
  ]) {
    assert.doesNotMatch(text, ONLY_WHILE_PRESENT, text)
  }
})

test('the reply description says buttons ask exactly one thing and names the card for more', () => {
  const d = toolDescription('reply')
  assert.match(d, /asks? exactly one thing/)
  assert.match(d, /2 or more decisions is ONE ask_user_input card/)
})
