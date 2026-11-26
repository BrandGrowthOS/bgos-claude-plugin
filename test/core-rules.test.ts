/**
 * The guide's core rules reach every session without a tool call (kit check
 * 2026-11-25, finding 1; lib/core-rules.ts).
 *
 * A fresh Claude Code session reads this server's MCP instructions in its
 * system prompt, and nothing else of the guide unless it calls
 * bgos_capabilities, which the kit check's agent never did. Claude Code
 * 2.1.332 shows a stdio server's instructions only up to their first 4,096
 * characters (a longer string is reported as instructionsTruncated and cut),
 * and these instructions run to about 36,000. So the rules must be INSIDE the
 * first 4,096 characters, not merely somewhere in the string: a plain
 * includes() passes while the model never sees the rule.
 *
 * server.ts is a monolith no test can import, so the instructions are rebuilt
 * from the source exactly as the Server constructor joins them (the idiom of
 * test/bundled-instructions.test.ts). test/capsize.daemon.test.ts reads the
 * same string from a real initialize handshake.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const loaded = await import('../lib/core-rules.ts').catch(() => null)
function rules() {
  assert.ok(loaded, 'lib/core-rules.ts must exist')
  return loaded
}

/** Claude Code 2.1.332: the characters of a stdio MCP server's instructions a model is shown. */
const CLAUDE_CODE_INSTRUCTIONS_SHOWN = 4096

const OPEN = '    instructions: [\n'
const CLOSE = "\n    ].join('\\n'),"

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

// The served canon's words (backend/src/integrations/capability-canon.ts in
// the BGOS repo), held here a second time so a change to the plugin's copy is
// a red test, and pinned on the BGOS side by
// capability-canon.plugin-core-rules.spec.ts.
const SERVED_OWNER_CHAT_ACK_RULE =
  'ACKNOWLEDGE WITH A REACTION, NOT A REPLY. In your chat with your owner, when their message needs no words back (thanks, ok, a fact to keep, a done confirmation), react 👍, ❤️ or 🙏 and send nothing else. When you start work longer than a minute, react 👀 at once, then reply with the result. Never react instead of answering a question or reporting a result. If the reaction fails, send one short line instead.'
const SERVED_CLAUDE_YES_NO_RULE =
  'In your own chat with your owner, a question your owner answers yes or no, except a dangerous command, which stays on the approval, always goes through ask_user_input as one question with two options, Yes and No (or two short words of your own), with the values yes and no, never as a question in plain text: the app draws it as two buttons to tap. In a group or a channel, ask with reply buttons instead.'
const SERVED_SAVE_SKILLS_PARAGRAPH =
  "SAVE WHAT YOU REPEAT AS A SKILL, without drafting or asking first (a request to teach yourself a skill still drafts first). When you do a task for your owner the second time, or work out a many step procedure, save it as a short skill where your channel section says your skills go: when to use it, the steps, the pitfalls. Put origin: made in its front matter. Never put a secret or your owner's private data in one. When a skill you used was wrong or missing a step, fix it before you finish. Do not announce it. Without a place for skills, skip this."

test('the bundled rules are the served canon\'s words, byte for byte', () => {
  const r = rules()
  assert.equal(r.OWNER_CHAT_ACK_RULE, SERVED_OWNER_CHAT_ACK_RULE)
  assert.equal(r.CLAUDE_YES_NO_RULE, SERVED_CLAUDE_YES_NO_RULE)
  assert.equal(r.SAVE_SKILLS_PARAGRAPH, SERVED_SAVE_SKILLS_PARAGRAPH)
})

test('a fresh session is shown rule 1 without a tool call: the core rules sit inside the first 4,096 characters', () => {
  const r = rules()
  const instructions = bundledInstructions()
  const shown = instructions.slice(0, CLAUDE_CODE_INSTRUCTIONS_SHOWN)
  assert.ok(
    shown.includes(r.CORE_RULES_TEXT),
    'the core rules block is not wholly inside the part of the instructions Claude Code shows the model',
  )
  // Line for line, so a rewrap cannot change a word unnoticed.
  const lines = instructions.split('\n')
  const at = lines.indexOf(r.CORE_RULES_HEADING)
  assert.ok(at >= 0, 'the core rules heading is not its own line')
  assert.deepEqual(lines.slice(at, at + r.CORE_RULES_LINES.length), [...r.CORE_RULES_LINES])
  assert.ok(shown.includes(SERVED_OWNER_CHAT_ACK_RULE), 'rule 1 is not shown')
  assert.ok(shown.includes('react tool'), 'rule 1 does not say how to react on this channel')
})

test('moving the rules up keeps what was already shown: the reply mandate, the formatting lines, the guide pointer and the Artifacts lines', () => {
  const shown = bundledInstructions().slice(0, CLAUDE_CODE_INSTRUCTIONS_SHOWN)
  for (const words of [
    'Messages from the BGOS chat app arrive as <channel source="bgos"> events.',
    'Every response to a BGOS message MUST go through the `reply` tool.',
    'Tables do not render on mobile - use lists instead.',
    'Backslashes:',
    'call the `bgos_capabilities` tool',
    // The last line of the Artifacts block, so a line added above it that
    // pushes the block past the window is red, not only one that pushes the
    // rules out.
    'Read artifact_read without id for the live content schema.',
  ]) {
    assert.ok(shown.includes(words), `no longer shown to the model: ${words}`)
  }
})

test('the guide pointer says the tool answers in topics, so a session knows to ask for one', () => {
  const shown = bundledInstructions().slice(0, CLAUDE_CODE_INSTRUCTIONS_SHOWN)
  assert.match(shown, /bgos_capabilities[^\n]*\n?[^\n]*topic/)
})

test('the core rules are a prompt: no em or en dashes', () => {
  assert.equal(/[–—]/.test(rules().CORE_RULES_TEXT), false)
})
