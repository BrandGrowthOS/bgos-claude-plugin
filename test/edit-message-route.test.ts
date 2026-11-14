/**
 * edit_message edits the message, or says it could not.
 *
 * From 2026-08-04 the tool posted to the unsigned `/webhook/edited_message` bridge with `chat_id: '0'`, and the
 * backend refused every one of those posts (production, 2026-11-07 to 11-13: 18 calls, 18 refusals, 11
 * `message_not_in_named_chat` and 7 `message_chat_kind_not_on_this_transport`). The tool never read the answer, so
 * the agent heard "Edited" for an edit that never happened.
 *
 * The tool now edits through `PATCH /api/v1/messages/:id` with the plugin's own credential: the backend binds the
 * owner to the credential and asks the chat kind's own edit rule (message.controller.ts updateMessage). These tests
 * run the real `case 'edit_message'` and the real `bgosPatch` from server.ts against a stubbed network, so a refusal
 * reaches the agent as the backend's own line with `isError`, never as "Edited".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { errorBodyText } from '../lib/error-body'
import { protectBackslashesForMarkdown } from '../lib/message-text'
import * as privateTurn from '../lib/private-turn.mjs'

const SERVER = readFileSync('server.ts', 'utf8').replace(/\r\n/g, '\n')
const API_BASE = 'https://backend.invalid/api/v1'

/** The source of `case 'edit_message'`, up to the next case. */
function editCase(): string {
  const start = SERVER.indexOf("    case 'edit_message': {")
  const stop = SERVER.indexOf("    case 'rename_chat': {", start)
  assert.ok(start > 0 && stop > start, 'the edit_message case in server.ts')
  return SERVER.slice(start, stop)
}

/** A top level declaration of server.ts, from its first line to the line before `next`. */
function lift(first: string, next: string): string {
  const start = SERVER.indexOf(first)
  const stop = SERVER.indexOf(next, start)
  assert.ok(start >= 0 && stop > start, `${first.trim()} in server.ts`)
  return SERVER.slice(start, stop)
}

type Call = { url: string; method: string | undefined; headers: Record<string, string>; body: unknown }
type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean }

/**
 * The real edit case and the real bgosPatch and HttpError, wired to a network that answers every call with
 * `answer` and records what was sent. `postedButtons` is the real record (lib/private-turn.mjs).
 */
async function editTool(answer: () => Response) {
  const ts = (await import('typescript')).default
  const source = [
    lift('class HttpError extends Error {', '\n/** The status of a thrown HTTP failure'),
    lift('async function bgosPatch(', '\nasync function bgosDelete('),
    `async function editMessage(rawArgs) {\n  switch ('edit_message') {\n${editCase()}  }\n}`,
  ].join('\n')
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const calls: Call[] = []
  const postedButtons = (privateTurn as any).createPostedButtons()
  const scope: Record<string, unknown> = {
    API_BASE,
    BACKEND_URL: API_BASE,
    AUTH: { kind: 'test' },
    HTTP_TIMEOUT_MS: 1000,
    USER_ID: 'user_owner',
    postedButtons,
    protectBackslashesForMarkdown,
    errorBodyText,
    authHeaders: () => ({ Authorization: 'Bearer pairing-token' }),
    bgosCall: async (call: { url: string; init?: RequestInit }, consume: (response: Response) => Promise<unknown>) => {
      calls.push({
        url: call.url,
        method: call.init?.method,
        headers: { ...(call.init?.headers as Record<string, string>) },
        body: call.init?.body == null ? undefined : JSON.parse(String(call.init.body)),
      })
      return consume(answer())
    },
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('scope', `with (scope) {\n${js}\nreturn editMessage\n}`)(scope) as (
    args: Record<string, unknown>,
  ) => Promise<ToolResult>
  return { run, calls, postedButtons }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** What the backend answers a refused edit (ServiceException, http-exception.advicer.ts). */
const REFUSED = { statusCode: 400, message: 'Message not found or access denied.', error: 'Bad Request' }

test('edit_message no longer names the webhook bridge, and edits through PATCH messages/:id with { text }', () => {
  const body = editCase()
  assert.doesNotMatch(body, /\/webhook\//, 'the unsigned webhook bridge is not the edit route')
  assert.doesNotMatch(body, /edited_message/, 'no edited_message event is posted')
  assert.doesNotMatch(body, /chat_id: '0'/, 'no made up chat id')
  assert.doesNotMatch(body, /baseUrl/, 'the rewrite that left /api/v1 is gone')
  assert.doesNotMatch(body, /\bbgosCall\(/, 'no bare call that does not read the answer')
  assert.match(body, /await bgosPatch\(`messages\/\$\{id\}`, \{ text: safeText \}\)/, 'the PATCH path and its body')
  assert.match(body, /const safeText = protectBackslashesForMarkdown\(text\)/, 'the backslash protection stays')
  assert.match(body, /\/\^\[1-9\]\\d\{0,17\}\$\/\.test\(id\)/, 'the id is checked before any call')
})

test('an edit through the new route sends the new text to PATCH /api/v1/messages/:id and answers Edited', async () => {
  const tool = await editTool(() => json(200, { id: 901, text: 'Shall I book Berlin and Paris?' }))
  const result = await tool.run({ message_id: '901', text: 'Shall I book Berlin and Paris?' })
  assert.deepEqual(result, { content: [{ type: 'text', text: 'Edited' }] })
  assert.equal(tool.calls.length, 1, 'one call')
  const [call] = tool.calls
  assert.equal(call.method, 'PATCH')
  assert.equal(call.url, `${API_BASE}/messages/901`)
  assert.equal(call.headers.Authorization, 'Bearer pairing-token', 'the plugin\'s own credential')
  assert.equal(call.headers['Content-Type'], 'application/json')
  assert.deepEqual(call.body, { text: 'Shall I book Berlin and Paris?' }, 'the text and nothing else: no chat id, no user id')
})

test('the edited text keeps the reply path\'s backslash protection', async () => {
  const tool = await editTool(() => json(200, { id: 7 }))
  const text = 'C:\\Users\\kc\\notes.md and a \\* star'
  await tool.run({ message_id: '7', text })
  assert.deepEqual(tool.calls[0].body, { text: protectBackslashesForMarkdown(text) })
  assert.notEqual(protectBackslashesForMarkdown(text), text, 'the protection did something to this text')
})

test('an id with spaces around it is trimmed, and the path carries the bare id', async () => {
  const tool = await editTool(() => json(200, { id: 4211 }))
  const result = await tool.run({ message_id: ' 4211 ', text: 'hi' })
  assert.equal(result.isError, undefined)
  assert.equal(tool.calls[0].url, `${API_BASE}/messages/4211`)
})

for (const [status, body, line] of [
  [400, REFUSED, 'Failed: PATCH 400: Message not found or access denied.'],
  [401, { statusCode: 401, message: 'Unauthorized' }, 'Failed: PATCH 401: Unauthorized'],
  [403, { statusCode: 403, message: 'An agent email row is never edited.' }, 'Failed: PATCH 403: An agent email row is never edited.'],
  [404, { statusCode: 404, message: 'Cannot PATCH /api/v1/messages/901' }, 'Failed: PATCH 404: Cannot PATCH /api/v1/messages/901'],
  [500, { statusCode: 500, message: 'Internal server error' }, 'Failed: PATCH 500: Internal server error'],
] as const) {
  test(`a refused edit (${status}) answers isError with the server's one line, never Edited`, async () => {
    const tool = await editTool(() => json(status, body))
    const result = await tool.run({ message_id: '901', text: 'new words' })
    assert.equal(result.isError, true)
    assert.deepEqual(result.content, [{ type: 'text', text: line }])
    assert.doesNotMatch(result.content[0].text, /^Edited/)
    assert.equal(tool.calls.length, 1)
  })
}

for (const bad of ['abc', '0', '00', '0123', '-5', '12.5', '1e3', '901; drop', '901/pin', '../chats/3', '1234567890123456789', 'msg_901', ' ']) {
  test(`a message id that is not one (${JSON.stringify(bad)}) is refused before any call`, async () => {
    const tool = await editTool(() => json(200, {}))
    const result = await tool.run({ message_id: bad, text: 'new words' })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /^Error: message_id must be a message id from a reply$/)
    assert.equal(tool.calls.length, 0, 'nothing was sent')
  })
}

test('a missing message id or text is an error, before any call', async () => {
  for (const args of [{ text: 'x' }, { message_id: '901' }, { message_id: '', text: 'x' }, { message_id: '901', text: '' }]) {
    const tool = await editTool(() => json(200, {}))
    const result = await tool.run(args)
    assert.equal(result.isError, true, JSON.stringify(args))
    assert.equal(result.content[0].text, 'Error: message_id and text required')
    assert.equal(tool.calls.length, 0)
  }
})

test('a numeric message_id (the model sends a number) is edited like its string', async () => {
  const tool = await editTool(() => json(200, { id: 901 }))
  const result = await tool.run({ message_id: 901, text: 'hi' })
  assert.deepEqual(result, { content: [{ type: 'text', text: 'Edited' }] })
  assert.equal(tool.calls[0].url, `${API_BASE}/messages/901`)
})

test('the posted buttons record follows an edit the backend took, and only that', async () => {
  for (const [status, recorded] of [[200, true], [400, false], [401, false], [500, false]] as const) {
    const tool = await editTool(() => (status === 200 ? json(200, { id: 901 }) : json(status, REFUSED)))
    tool.postedButtons.note(901, [{ text: 'Yes, book it', callbackData: 'u:yes' }], 'Shall I book Berlin?')
    await tool.run({ message_id: '901', text: 'Shall I book Berlin and Paris?' })
    assert.equal(tool.postedButtons.posted(901, 'u:yes', 'Yes, book it', 'Shall I book Berlin and Paris?'), recorded, `${status}: the edited text`)
    assert.equal(tool.postedButtons.posted(901, 'u:yes', 'Yes, book it', 'Shall I book Berlin?'), !recorded, `${status}: the text as it stands`)
  }
})
