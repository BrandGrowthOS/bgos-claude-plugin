/**
 * A yes or no question to the owner is always two buttons to tap, never a
 * question typed in plain text.
 *
 * What this pins:
 *  - the sentence that says so (YES_NO_RULE) is in every place the agent
 *    reads about asking: the reply and ask_user_input tool descriptions, the
 *    MCP instructions that are always in context, and the offline guide;
 *  - the instructions no longer steer a confirmation away from the card
 *    ("pure confirmations (use the permission-request flow)");
 *  - `reply` takes `yes_no: true`, and that call IS an ask_user_input card of
 *    one question with the options Yes and No (values yes and no), posted
 *    pending: the same card and the same answer event, no new answer path;
 *  - the shorthand never guesses: without `yes_no: true` a reply is a reply,
 *    whatever its text says.
 *
 * server.ts is a monolith no test can import, so its parts are read from the
 * source, CRLF normalised, as test/bundled-instructions.test.ts does.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

import { askQuestionsError } from '../lib/ask-tracker.ts'
import { BGOS_CAPABILITIES_FALLBACK } from '../lib/capabilities.ts'
import { REPLY_YES_NO_SHORTHAND, YES_NO_RULE, replyYesNoAsk } from '../lib/yes-no-ask.ts'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

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
    .map((line) => (line.match(/^\s*'((?:[^'\\]|\\.)*)',$/)?.[1] ?? '').replace(/\\(.)/g, '$1'))
    .join('\n')
}

/** One tool's declaration in the ListTools answer, from its name to the next tool. */
function toolDeclaration(name: string): string {
  const at = server.indexOf(`      name: '${name}',\n      description:`)
  assert.ok(at > 0, `the ${name} tool declaration moved`)
  const next = server.indexOf('\n    {\n      name: ', at + 10)
  return server.slice(at, next > 0 ? next : undefined)
}

test('the yes or no sentence names ask_user_input, two options, Yes and No, and plain text', () => {
  assert.match(YES_NO_RULE, /yes or no/)
  assert.match(YES_NO_RULE, /ask_user_input/)
  assert.match(YES_NO_RULE, /Yes and No/)
  assert.match(YES_NO_RULE, /values yes and no/)
  assert.match(YES_NO_RULE, /never .*plain text/)
  // Injected into prompts: no em or en dashes.
  assert.doesNotMatch(YES_NO_RULE + REPLY_YES_NO_SHORTHAND, /[–—]/)
})

test('the reply and ask_user_input tool descriptions carry it, and reply names its shorthand', () => {
  const reply = toolDeclaration('reply')
  const ask = toolDeclaration('ask_user_input')
  assert.match(reply.slice(0, reply.indexOf('inputSchema')), /YES_NO_RULE/)
  assert.match(reply.slice(0, reply.indexOf('inputSchema')), /REPLY_YES_NO_SHORTHAND/)
  assert.match(ask.slice(0, ask.indexOf('inputSchema')), /YES_NO_RULE/)
  // The reply schema takes yes_no as a boolean.
  assert.match(reply, /\n {10}yes_no: \{\n {12}type: 'boolean',/)
})

test('the instructions always in context carry it, and no longer send a confirmation elsewhere', () => {
  const text = bundledInstructions()
  const section = text.slice(text.indexOf('## Asking Your Owner Questions'), text.indexOf('## Inline Buttons'))
  assert.ok(section.length > 0, 'the asking section moved')
  assert.ok(section.includes(YES_NO_RULE), 'the asking section must carry YES_NO_RULE word for word')
  assert.ok(section.includes(REPLY_YES_NO_SHORTHAND), 'the asking section must name the reply shorthand')
  assert.doesNotMatch(text, /pure confirmations/)
})

test('the offline guide carries it', () => {
  assert.ok(BGOS_CAPABILITIES_FALLBACK.includes(YES_NO_RULE))
})

test('reply with yes_no: true is one ask_user_input question with Yes and No, posted pending', () => {
  const made = replyYesNoAsk({ chat_id: '42', text: '  Should I deploy the hotfix now?  ', yes_no: true })
  assert.ok(made && 'args' in made)
  assert.deepEqual(made.args, {
    chat_id: '42',
    questions: [
      {
        text: 'Should I deploy the hotfix now?',
        options: [
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ],
      },
    ],
    wait_seconds: 0,
  })
  // The card's own checks take it as it is.
  assert.equal(askQuestionsError(made.args.questions), null)
})

test('without yes_no: true a reply stays a reply, whatever its words', () => {
  assert.equal(replyYesNoAsk({ chat_id: '42', text: 'Should I go ahead?' }), null)
  assert.equal(replyYesNoAsk({ chat_id: '42', text: 'Should I go ahead?', yes_no: false }), null)
  assert.equal(replyYesNoAsk(undefined), null)
})

test('yes_no is refused, with nothing posted, when it cannot be one plain card', () => {
  for (const args of [
    { chat_id: '42', yes_no: true },
    { chat_id: '42', text: '   ', yes_no: true },
    { chat_id: '42', text: 'Ship it?', yes_no: 'true' },
    { chat_id: '42', text: 'Ship it?', yes_no: true, buttons: [{ label: 'A', value: 'a' }] },
    { chat_id: '42', text: 'Ship it?', yes_no: true, files: [{ path: '/tmp/a.png' }] },
    { chat_id: '42', text: 'Ship it?', yes_no: true, reply_to_id: 7 },
  ]) {
    const made = replyYesNoAsk(args)
    assert.ok(made && 'error' in made, `refused: ${JSON.stringify(args)}`)
    assert.match(made.error, /^Error: /)
    assert.match(made.error, /Nothing was posted/)
  }
})

test('the dispatcher turns reply with yes_no into the ask_user_input call before it switches', () => {
  const call = server.indexOf("req.params.name === 'reply' ? replyYesNoAsk(")
  const swap = server.indexOf("name: 'ask_user_input', arguments: yesNoAsk.args", call)
  const sw = server.indexOf('switch (req.params.name) {')
  assert.ok(call > 0, 'the dispatcher must ask replyYesNoAsk about a reply')
  assert.ok(swap > call, 'and send what it makes on as ask_user_input')
  assert.ok(sw > swap, 'before the tool switch')
})
