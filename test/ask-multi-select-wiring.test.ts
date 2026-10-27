/**
 * ask_user_input's multi_select (askcard PR 3), read off server.ts: the schema
 * offers it per question, a question posts `multiSelect: true` only when the
 * agent set it (an older backend never sees the field otherwise), the tracker
 * remembers it so the answer comes back as arrays, and the questions are
 * checked by askQuestionsError (lib/ask-tracker.ts) before anything is posted.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const at = server.indexOf("\n    case 'ask_user_input': {")
const body = server.slice(at, server.indexOf("\n    case '", at + 10))

test('the schema offers multi_select on a question and names the arrays it answers with', () => {
  const schemaAt = server.indexOf("name: 'ask_user_input'")
  const schema = server.slice(schemaAt, server.indexOf("required: ['chat_id', 'questions']", schemaAt))
  assert.match(schema, /multi_select: \{\n\s*type: 'boolean',/)
  assert.match(schema, /picked_option_values/)
})

test('a question posts multiSelect only when the agent set multi_select', () => {
  assert.match(body, /\.\.\.\(q\.multi_select === true && \{ multiSelect: true \}\)/)
})

test('the tracker is told which questions are multi-select', () => {
  assert.match(body, /\.\.\.\(q\.multi_select === true && \{ multiSelect: true as const \}\)/)
})

test('the questions are checked before any post', () => {
  const check = body.indexOf('askQuestionsError(questions)')
  assert.ok(check > 0)
  assert.ok(check < body.indexOf("bgosPost('messages'"))
})
