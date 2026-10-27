/**
 * ask_user_input's multi_select (askcard PR 3). The ask_user_input case is
 * lifted out of server.ts and run (the technique test/peer-403-loop.test.ts
 * uses) against a fake bgosPost that keeps every body, the real question
 * checks, the real wait parser and a real AskTracker: a question posts
 * `multiSelect: true` only when the agent set it (only a flagged row carries
 * the field, so an older backend sees nothing new on any other row), the
 * tracker remembers it so the answer comes back as arrays, and
 * askQuestionsError refuses bad questions before anything is posted. The
 * schema and the instructions are text, so they are read as text.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

import {
  AskTracker,
  askPendingText,
  askQuestionsError,
  askWaitSeconds,
  askWithdrawnText,
  buildAskWithdrawnEvent,
} from '../lib/ask-tracker.ts'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** The ask_user_input case of the tool switch, run as a function of its own. */
function liftedAsk() {
  const start = server.indexOf("\n    case 'ask_user_input': {")
  const end = server.indexOf("\n    case 'complete_voice_task': {", start)
  assert.ok(start > 0 && end > start, 'the ask_user_input case exists')
  const source = `async function askTool(rawArgs, extra = { signal: new AbortController().signal }) {\n  switch ('ask_user_input') {\n${server.slice(start + 1, end)}\n  }\n}\n`
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText

  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const askTracker = new AskTracker({ filePath: null })
  let nextId = 300
  const known: Record<string, unknown> = {
    lockHeld: true,
    log: () => undefined,
    resolveAuthorizedChat: (id: string) => ({ ok: true, chatId: id }),
    askWaitSeconds,
    askQuestionsError,
    askPendingText,
    askTracker,
    a2aRouteRefusedChats: new Set<string>(),
    escapeAgentButtonValue: (value: string) => `u:${value}`,
    bgosPost: async (path: string, body: Record<string, unknown>) => {
      posts.push({ path, body })
      return { id: ++nextId, askId: 'ask-ms' }
    },
  }
  const scope = new Proxy(known, {
    has: (target, key) => key in target || !(key in globalThis),
    get: (target, key) => (typeof key === 'symbol' ? undefined : target[key as string]),
  })
  // eslint-disable-next-line no-new-func
  const askTool = new Function('scope', `with (scope) {\n${js}\nreturn askTool\n}`)(scope) as (
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
  return { askTool, posts, askTracker }
}

const two = [
  { label: 'Postgres', value: 'pg' },
  { label: 'Redis', value: 'redis' },
]

test('a question posts multiSelect only when the agent set multi_select, and the tracker is told which', async () => {
  const { askTool, posts, askTracker } = liftedAsk()
  const result = await askTool({
    chat_id: '77',
    wait_seconds: 0,
    questions: [
      { text: 'Which stores?', options: two, multi_select: true },
      { text: 'Ship it?', options: two },
      { text: 'Either?', options: two, multi_select: false },
    ],
  })
  assert.notEqual(result.isError, true, result.content[0]?.text)
  assert.equal(posts.length, 3)
  assert.equal(posts[0].body.multiSelect, true)
  for (const p of posts.slice(1)) assert.equal('multiSelect' in p.body, false)
  const ask = askTracker.get('ask-ms')
  assert.deepEqual(
    ask?.questions.map((q) => q.multiSelect),
    [true, undefined, undefined],
  )
})

test('bad questions are refused before anything is posted', async () => {
  const { askTool, posts } = liftedAsk()
  for (const q of [
    { text: 'Which?', options: [two[0]], multi_select: true },
    { text: 'Which?', options: two, multi_select: 'true' },
  ]) {
    const result = await askTool({ chat_id: '77', wait_seconds: 0, questions: [q] })
    assert.equal(result.isError, true)
    assert.match(result.content[0]!.text, /multi_select/)
  }
  assert.equal(posts.length, 0)
})

test('the schema offers multi_select on a question and names the arrays it answers with', () => {
  const schemaAt = server.indexOf("name: 'ask_user_input'")
  const schema = server.slice(schemaAt, server.indexOf("required: ['chat_id', 'questions']", schemaAt))
  assert.match(schema, /multi_select: \{\n\s*type: 'boolean',/)
  assert.match(schema, /picked_option_values/)
})

test('the instructions say a multi_select question answers ask_answered with arrays', () => {
  const at = server.indexOf('with `meta.ask_id` and `meta.answers`')
  assert.ok(at > 0)
  const para = server.slice(at, server.indexOf('the answers still arrive as ask_answered.', at))
  assert.match(para, /`multi_select` question/)
  assert.match(para, /`picked_option_values`/)
  assert.match(para, /`picked_option_labels`/)
})

test('the instructions draw a multi_select question as checkboxes and list it in the question shape', () => {
  const sheet = server.indexOf('The BGOS app shows the card as a sheet over the chat')
  assert.ok(sheet > 0)
  assert.match(server.slice(sheet, server.indexOf('optional free-text fallback', sheet)), /checkboxes/)
  const shapeAt = server.indexOf("'Each question: `{ text, options?")
  assert.ok(shapeAt > 0)
  assert.match(server.slice(shapeAt, server.indexOf('}`.', shapeAt)), /multi_select\?/)
})

// A card withdrawn part answered (its session ended, or a blocking wait ran out in a passive daemon) hands back
// what was answered: a multi-select question still as arrays, the open ones only named.
test('a withdrawn card hands back a multi-select answer as arrays', () => {
  const tracker = new AskTracker({ filePath: null })
  tracker.register({
    askId: 'ask-w',
    chatId: '77',
    questions: [
      { messageId: 401, text: 'Which stores?', options: [], multiSelect: true },
      { messageId: 402, text: 'Ship it?', options: [] },
    ],
  })
  tracker.record(401, { optionValues: ['pg', 'redis'], optionLabels: ['Postgres', 'Redis'], optionValue: 'pg', optionLabel: 'Postgres' })
  const ask = tracker.get('ask-w')!
  const event = buildAskWithdrawnEvent(ask, { assistantId: '9', withdrawn: 1 })
  assert.deepEqual(JSON.parse(event.meta.answers), [
    { question: 'Which stores?', picked_option_values: ['pg', 'redis'], picked_option_labels: ['Postgres', 'Redis'] },
  ])
  const text = askWithdrawnText({ ask, waitedSeconds: 30, withdrawn: 1 })
  const status = JSON.parse(text.slice(0, text.lastIndexOf('}') + 1)) as { answers: unknown[] }
  assert.deepEqual(status.answers, [
    { question: 'Which stores?', picked_option_values: ['pg', 'redis'], picked_option_labels: ['Postgres', 'Redis'] },
  ])
})
