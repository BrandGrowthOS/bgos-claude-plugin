import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { REACT_TOOL, handleReactTool } from '../lib/react-tool.ts'
import { OWN_MCP_TOOLS } from '../lib/hook-events.ts'
import { messagesCallerHeaders } from '../lib/messages-caller-header.ts'
import { authHeaders, resolveAuth, type ResolvedAuth } from '../lib/agent-credentials.ts'

const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true)
const authEnv = { BGOS_BACKEND_URL: 'https://api.example.test/api/v1', BGOS_USER_ID: 'fixture-owner', BGOS_ASSISTANT_ID: '42' }
const paired = resolveAuth({ env: { ...authEnv, BGOS_PAIRING_TOKEN: 'fixture' }, creds: null })
assert.equal(paired.complete, true)
const PAIRING_REQUIRED = 'Reactions need this agent to be paired; it cannot react with an account key.'
const NOT_FOUND = 'That message was not found or is not in this agent\'s chat; retrying will not help.'
const EMOJI_REFUSED = 'That emoji is not allowed; choose another emoji instead of retrying.'
const AMBIGUOUS_PAIRING = 'More than one agent shares this pairing in that chat; retrying cannot help until this agent can be identified.'
const NOT_ALLOWED = 'This agent is not allowed to react to that message; retrying will not help.'
const AMBIGUOUS_SERVER_MESSAGE = 'This computer runs more than one agent in this chat. Say which one reacts with fromAgent.assistantId.'

// Execute the real transport and dispatch with an in-memory HTTP boundary.
// Importing server.ts would boot a daemon and read the installed pairing.
function fixture(status = 200, responseBody = '', auth: ResolvedAuth = paired) {
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = []
  const postNode = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'bgosPost')!
  const errorNode = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'HttpError')!
  const postJs = ts.transpileModule(`${errorNode.getText(ast)}\n${postNode.getText(ast)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const bgosPost = new Function('API_BASE', 'ASSISTANT_ID', 'AUTH', 'authHeaders', 'HTTP_TIMEOUT_MS', 'bgosCall', 'errorBodyText', 'messagesCallerHeaders', 'classifyPeerRefusal',
    `${postJs}; return bgosPost`)(
    'https://api.example.test/api/v1', auth.assistantId, auth, authHeaders, 100,
    async (request: any, consume: any) => {
      calls.push(request)
      return consume({ ok: status === 200, status, text: async () => responseBody, json: async () => ({ reactions: [{ actors: [{ name: 'private fixture' }] }] }) })
    },
    (text: string) => text,
    messagesCallerHeaders, () => null,
  )
  const start = source.indexOf("    case 'react':")
  assert.ok(start >= 0, 'react must be dispatched by the real tool handler')
  const end = source.indexOf('\n    case ', start + 1)
  assert.ok(end > start, 'react dispatch has a following case')
  const dispatchJs = ts.transpileModule(`async function dispatch(rawArgs: Record<string, unknown>) { switch ('react') { ${source.slice(start, end)} } }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const dispatch = new Function('handleReactTool', 'bgosPost', 'AUTH', 'ASSISTANT_ID', `${dispatchJs}; return dispatch`)(handleReactTool, bgosPost, auth, auth.assistantId)
  return { calls, dispatch }
}

test('react is advertised with only message_id, emoji and optional remove', () => {
  assert.equal(REACT_TOOL.name, 'react')
  assert.deepEqual(Object.keys(REACT_TOOL.inputSchema.properties).sort(), ['emoji', 'message_id', 'remove'])
  assert.deepEqual(REACT_TOOL.inputSchema.required, ['message_id', 'emoji'])
  assert.equal(REACT_TOOL.inputSchema.additionalProperties, false)
  assert.equal(REACT_TOOL.inputSchema.properties.remove.default, false)
  assert.match(REACT_TOOL.description, /one emoji per message/i)
  assert.match(REACT_TOOL.description, /replaces/i)
  assert.match(REACT_TOOL.description, /acknowledge or agree/i)
  assert.match(REACT_TOOL.description, /not instead of a reply/i)
  assert.match(source, /import\s*\{[^}]*REACT_TOOL[^}]*handleReactTool[^}]*\}\s*from '\.\/lib\/react-tool\.ts'/)
  const list = source.slice(source.indexOf('mcp.setRequestHandler(ListToolsRequestSchema'), source.indexOf('mcp.setRequestHandler(CallToolRequestSchema'))
  assert.match(list, /\bREACT_TOOL\b/)
  assert.ok(OWN_MCP_TOOLS.includes('react'), 'a reaction must not draw a separate tool progress row')
})

for (const remove of [undefined, false, true]) {
  test(`react posts emoji and its configured identity to the ${remove ? 'remove' : 'add'} route (remove=${remove})`, async () => {
    const f = fixture()
    const result = await f.dispatch({ message_id: '123', emoji: '👍', ...(remove === undefined ? {} : { remove }) })
    assert.deepEqual(f.calls.map(call => ({ url: call.url, method: call.init.method, headers: call.init.headers, body: JSON.parse(call.init.body) })), [{
      url: `https://api.example.test/api/v1/messages/123/reactions${remove ? '/remove' : ''}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BGOS-Pairing': 'fixture' },
      body: { emoji: '👍', fromAgent: { assistantId: 42 } },
    }])
    assert.deepEqual(result, { content: [{ type: 'text', text: remove ? 'You have no reaction with that emoji on that message.' : 'Reaction added.' }] })
  })
}

test('whatever identity the caller passes, the request carries the configured identity', async () => {
  for (const remove of [false, true]) {
    for (const forged of [{ fromAgent: { assistantId: 999 } }, { assistantId: 999 }, { peerId: 999 }, { externalId: 'someone-else' }, { agent_id: '999', user_id: 'someone-else' }]) {
      const f = fixture()
      assert.notEqual((await f.dispatch({ message_id: '123', emoji: '👍', remove, ...forged })).isError, true)
      assert.equal(f.calls.length, 1)
      assert.deepEqual(JSON.parse(f.calls[0]!.init.body), { emoji: '👍', fromAgent: { assistantId: 42 } })
      assert.deepEqual(f.calls[0]!.init.headers, { 'Content-Type': 'application/json', 'X-BGOS-Pairing': 'fixture' })
    }
  }
})

test('an account key cannot send a reaction, even if the caller claims pairing mode', async () => {
  const auth = resolveAuth({ env: { ...authEnv, BGOS_API_KEY: 'fixture-key' }, creds: null })
  assert.equal(auth.mode, 'apikey')
  assert.equal(auth.complete, true, 'this account-key configuration can otherwise run the daemon')
  for (const remove of [false, true]) {
    const f = fixture(200, '', auth)
    assert.deepEqual(await f.dispatch({ message_id: '123', emoji: '👍', remove, authMode: 'pairing' }), {
      content: [{ type: 'text', text: PAIRING_REQUIRED }], isError: true,
    })
    assert.deepEqual(f.calls, [])
  }
})

test('a rejected pairing that falls back to an account key cannot send a reaction', async () => {
  const auth = resolveAuth({
    env: { ...authEnv, BGOS_API_KEY: 'fixture-key' },
    creds: { pairingToken: 'fixture-rejected', assistantId: 7 },
  })
  assert.equal(auth.mode, 'apikey')
  assert.equal(auth.complete, true, 'the rejected pairing leaves a usable account-key fallback')
  assert.ok(auth.pairingFileRejection, 'exercise the real rejected-pairing fallback')
  const f = fixture(200, '', auth)
  assert.deepEqual(await f.dispatch({ message_id: '123', emoji: '👍' }), {
    content: [{ type: 'text', text: PAIRING_REQUIRED }], isError: true,
  })
  assert.deepEqual(f.calls, [])
})

test('missing, invalid and path-changing message ids never reach HTTP', async () => {
  for (const message_id of [undefined, null, 123, '', '0', '-1', '1.5', '9007199254740993', '../123', '123/remove', '123?x=1']) {
    const f = fixture()
    assert.equal((await f.dispatch({ message_id, emoji: '👍' })).isError, true)
    assert.deepEqual(f.calls, [])
  }
})

test('emoji values refused by the DTO or the empty-emoji service check never reach HTTP', async () => {
  for (const emoji of [undefined, null, 1, true, {}, [], '', ' \n\t', 'a'.repeat(33), '👍'.repeat(33), '❤️'.repeat(33)]) {
    const f = fixture()
    assert.equal((await f.dispatch({ message_id: '123', emoji })).isError, true)
    assert.deepEqual(f.calls, [])
  }
})

test('emoji length follows DTO character counting, preserving joined and modified emoji', async () => {
  for (const emoji of ['👍'.repeat(32), '❤️'.repeat(32), '👍🏽', '👩‍💻', '❤️', 'ok']) {
    const f = fixture()
    assert.notEqual((await f.dispatch({ message_id: '123', emoji })).isError, true)
    assert.equal(JSON.parse(f.calls[0]!.init.body).emoji, emoji)
  }
})

test('remove must be a boolean when supplied', async () => {
  for (const remove of [null, 'true', 1, {}]) {
    const f = fixture()
    assert.equal((await f.dispatch({ message_id: '123', emoji: '👍', remove })).isError, true)
    assert.deepEqual(f.calls, [])
  }
})

for (const [status, expected] of [
  [400, 'The server refused this reaction; retrying unchanged will not help.'],
  [401, 'This agent\'s pairing was not accepted; pair it again before retrying.'],
  [403, NOT_ALLOWED],
  [404, NOT_FOUND],
  [409, 'The reaction could not be changed; resolve the conflict before retrying.'],
  [503, 'The reaction could not be saved; try again later.'],
] as const) {
  test(`server refusal ${status} becomes one plain sentence without server data`, async () => {
    for (const remove of [false, true]) {
      const f = fixture(status, '{"message":"Not allowed for private fixture 987654.\nInternal details."}')
      const result = await f.dispatch({ message_id: '123', emoji: '👍', remove })
      assert.deepEqual(result, { content: [{ type: 'text', text: expected }], isError: true })
      assert.equal(f.calls.length, 1)
    }
  })
}

test('known emoji refusals and an ambiguous pairing have distinct safe advice', async () => {
  for (const message of ['emoji is required', 'emoji is not allowed', ['emoji must be a string'], ['emoji must be shorter than or equal to 32 characters']]) {
    const f = fixture(400, JSON.stringify({ message }))
    assert.deepEqual(await f.dispatch({ message_id: '123', emoji: '👍' }), {
      content: [{ type: 'text', text: EMOJI_REFUSED }], isError: true,
    })
  }
  const f = fixture(400, JSON.stringify({ message: AMBIGUOUS_SERVER_MESSAGE }))
  assert.deepEqual(await f.dispatch({ message_id: '123', emoji: '👍' }), {
    content: [{ type: 'text', text: AMBIGUOUS_PAIRING }], isError: true,
  })
  const forbidden = fixture(400, JSON.stringify({ message: 'Only the chat owner can react as a human user.' }))
  assert.deepEqual(await forbidden.dispatch({ message_id: '123', emoji: '👍' }), {
    content: [{ type: 'text', text: NOT_ALLOWED }], isError: true,
  })
})

test('an unknown, malformed or misleading refusal is never quoted or mistaken for a known refusal', async () => {
  for (const body of ['not JSON\nprivate fixture', '{', JSON.stringify({ message: `${AMBIGUOUS_SERVER_MESSAGE} private fixture` }), JSON.stringify({ message: { text: 'emoji is not allowed' } })]) {
    const f = fixture(400, body)
    assert.deepEqual(await f.dispatch({ message_id: '123', emoji: '👍' }), {
      content: [{ type: 'text', text: 'The server refused this reaction; retrying unchanged will not help.' }], isError: true,
    })
  }
})

test('a transport exception also stays private', async () => {
  const result = await handleReactTool({ message_id: '123', emoji: '👍' }, {
    authMode: 'pairing',
    assistantId: '42',
    post: async () => { throw new Error('private fixture\n at hiddenFunction') },
  })
  assert.deepEqual(result, { content: [{ type: 'text', text: 'The reaction could not be saved; try again later.' }], isError: true })
})

test('missing arguments return a plain error before HTTP', async () => {
  let calls = 0
  const result = await handleReactTool(undefined, { authMode: 'pairing', assistantId: '42', post: async () => { calls += 1 } })
  assert.equal(result.isError, true)
  assert.equal(calls, 0)
})
