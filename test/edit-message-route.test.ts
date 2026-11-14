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
import { OwnMessages, ownMessageRefusal } from '../lib/own-messages'

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

/** What the server answered when this agent created a row: POST /send-message for a reply in its main chat. */
const ownReply = (id: number) => ({ message: { id, chatId: 1, sender: 'assistant', senderAssistantId: null } })

/**
 * The real edit case and the real bgosPatch and HttpError, wired to a network that answers every call with
 * `answer` and records what was sent. `postedButtons` is the real record (lib/private-turn.mjs), and `ownMessages`
 * the real record of this agent's own rows (lib/own-messages.ts), fed with the server's create answers in `created`.
 * `fail`, when given, makes the network call throw it instead of answering.
 */
async function editTool(
  answer: () => Response,
  { created = [901, 7, 4211].map(ownReply) as unknown[], fail }: { created?: unknown[]; fail?: () => Error } = {},
) {
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
  const ownMessages = new OwnMessages({ filePath: null, assistantId: '1' })
  for (const row of created) ownMessages.note(row)
  const scope: Record<string, unknown> = {
    API_BASE,
    ASSISTANT_ID: '1',
    ownMessages,
    ownMessageRefusal,
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
      if (fail) throw fail()
      return consume(answer())
    },
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('scope', `with (scope) {\n${js}\nreturn editMessage\n}`)(scope) as (
    args: Record<string, unknown>,
  ) => Promise<ToolResult>
  return { run, calls, postedButtons, ownMessages }
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
  const own = body.indexOf('ownMessages.has(id)')
  assert.ok(own > 0 && own < body.indexOf('await bgosPatch('), 'the row is checked to be this agent\'s own before the PATCH')
  // Review F2: the record follows the trimmed id the PATCH used. The record keys by Number(), which ignores the same
  // whitespace trim() removes, so no input tells the two apart; the source is pinned instead.
  assert.match(body, /\n {8}postedButtons\.edited\(id, safeText\)\n/, 'the record is keyed by the trimmed id')
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

test('the posted buttons record follows an edit the backend took, and only that, keyed by the trimmed id', async () => {
  // ' 901 ' (review F2): the record must be keyed by the id the PATCH used, not the raw argument.
  for (const messageId of ['901', ' 901 ']) {
    for (const [status, recorded] of [[200, true], [400, false], [401, false], [500, false]] as const) {
      const tool = await editTool(() => (status === 200 ? json(200, { id: 901 }) : json(status, REFUSED)))
      tool.postedButtons.note(901, [{ text: 'Yes, book it', callbackData: 'u:yes' }], 'Shall I book Berlin?')
      await tool.run({ message_id: messageId, text: 'Shall I book Berlin and Paris?' })
      const label = `${JSON.stringify(messageId)} ${status}`
      assert.equal(tool.postedButtons.posted(901, 'u:yes', 'Yes, book it', 'Shall I book Berlin and Paris?'), recorded, `${label}: the edited text`)
      assert.equal(tool.postedButtons.posted(901, 'u:yes', 'Yes, book it', 'Shall I book Berlin?'), !recorded, `${label}: the text as it stands`)
    }
  }
})

// ── Round 2 (review F1): the tool edits only a message this agent sent. The backend admits any row the owner may
// edit, so the owner's credential could rewrite the owner's own lines and the lines of the owner's other agents.

test('the owner\'s own line is refused before any call, with one plain line', async () => {
  // The owner's line as the server answers it (sender 'user'): never noted, so never editable.
  const tool = await editTool(() => json(200, { id: 900 }), {
    created: [ownReply(901), { message: { id: 900, chatId: 1, sender: 'user', senderUserId: 'user_owner' } }],
  })
  const result = await tool.run({ message_id: '900', text: 'I never said this' })
  assert.deepEqual(result, { content: [{ type: 'text', text: ownMessageRefusal('900') }], isError: true })
  assert.equal(tool.calls.length, 0, 'nothing was sent')
})

test('the owner\'s other agent\'s line is refused before any call', async () => {
  // Another agent of the same owner wrote 902 (the server names its assistant id).
  const tool = await editTool(() => json(200, { id: 902 }), {
    created: [ownReply(901), { message: { id: 902, chatId: 4, sender: 'assistant', senderAssistantId: 4 } }],
  })
  const result = await tool.run({ message_id: '902', text: 'Kite, rewritten by Atlas' })
  assert.deepEqual(result, { content: [{ type: 'text', text: ownMessageRefusal('902') }], isError: true })
  assert.equal(tool.calls.length, 0)
})

test('a message the daemon never created (another person\'s line, an id from an inbound message) is refused', async () => {
  const tool = await editTool(() => json(200, {}), { created: [ownReply(901)] })
  for (const id of ['6', '999999', 902]) {
    const result = await tool.run({ message_id: id, text: 'x' })
    assert.equal(result.isError, true, String(id))
    assert.equal(result.content[0].text, ownMessageRefusal(String(id)))
  }
  assert.equal(tool.calls.length, 0)
})

test('this agent\'s own reply and own card are edited (the reply shape and the card shape of the server\'s answer)', async () => {
  const tool = await editTool(() => json(200, { id: 1 }), {
    created: [ownReply(911), { id: 912, chatId: 1, sender: 'assistant', messageType: 'ask_user_input' }],
  })
  for (const id of ['911', '912']) {
    assert.deepEqual(await tool.run({ message_id: id, text: 'better words' }), { content: [{ type: 'text', text: 'Edited' }] })
  }
  assert.deepEqual(tool.calls.map((c) => c.url), [`${API_BASE}/messages/911`, `${API_BASE}/messages/912`])
})

test('an edit that got no answer says it may have landed (review F3); a refusal does not', async () => {
  const timedOut = await editTool(() => json(200, {}), { fail: () => new Error('PATCH messages/901 timed out after 1000ms') })
  const lost = await timedOut.run({ message_id: '901', text: 'new words' })
  assert.equal(lost.isError, true)
  assert.match(lost.content[0].text, /^Failed: PATCH messages\/901 timed out after 1000ms\./)
  assert.match(lost.content[0].text, /may have landed/)
  assert.doesNotMatch(lost.content[0].text, /\n/, 'one line')
  const refused = await editTool(() => json(400, REFUSED))
  const no = await refused.run({ message_id: '901', text: 'new words' })
  assert.equal(no.content[0].text, 'Failed: PATCH 400: Message not found or access denied.')
})

test('bgosPost notes the rows the server answers as this agent\'s own creates, and nothing else', async () => {
  const ts = (await import('typescript')).default
  const source = [
    lift('class HttpError extends Error {', '\n/** The status of a thrown HTTP failure'),
    lift('async function bgosPost(', '\n// `privateHeaders` (here, on bgosPut'),
  ].join('\n')
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  let reply: unknown = null
  const ownMessages = new OwnMessages({ filePath: null, assistantId: '1' })
  const scope: Record<string, unknown> = {
    API_BASE, AUTH: {}, ASSISTANT_ID: '1', HTTP_TIMEOUT_MS: 1000, ownMessages, errorBodyText,
    log: () => {},
    authHeaders: () => ({}),
    messagesCallerHeaders: () => ({}),
    classifyPeerRefusal: () => null,
    meetingChatIds: new Set(), peerConvByChat: new Map(), closedPeerChats: new Set(), a2aRouteRefusedChats: new Set(),
    bgosCall: async (_call: unknown, consume: (response: Response) => Promise<unknown>) => consume(json(200, reply)),
  }
  // eslint-disable-next-line no-new-func
  const bgosPost = new Function('scope', `with (scope) {\n${js}\nreturn bgosPost\n}`)(scope) as (path: string, body: object) => Promise<unknown>
  const post = async (path: string, answer: unknown) => { reply = answer; return bgosPost(path, {}) }
  assert.deepEqual(await post('send-message', ownReply(21)), ownReply(21), 'the answer passes through unchanged')
  await post('messages', { id: 22, chatId: 1, sender: 'assistant' })
  await post('messages', { id: 23, chatId: 1, sender: 'user' })
  await post('send-message', { message: { id: 24, sender: 'assistant', senderAssistantId: 4 } })
  await post('messages/25/callback', { id: 25, sender: 'assistant' })
  await post('integrations/heartbeat', { id: 26, sender: 'assistant' })
  assert.deepEqual([21, 22, 23, 24, 25, 26].map((id) => ownMessages.has(id)), [true, true, false, false, false, false])
})
