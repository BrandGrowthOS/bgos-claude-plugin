import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { REACT_TOOL, handleReactTool } from '../lib/react-tool.ts'
import { OWN_MCP_TOOLS } from '../lib/hook-events.ts'
import { messagesCallerHeaders } from '../lib/messages-caller-header.ts'

const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true)

// Execute the real transport and dispatch with an in-memory HTTP boundary.
// Importing server.ts would boot a daemon and read the installed pairing.
function fixture(status = 200, responseBody = '') {
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = []
  const postNode = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'bgosPost')!
  const postJs = ts.transpileModule(postNode.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const bgosPost = new Function('API_BASE', 'ASSISTANT_ID', 'AUTH', 'authHeaders', 'HTTP_TIMEOUT_MS', 'bgosCall', 'HttpError', 'errorBodyText', 'messagesCallerHeaders', 'classifyPeerRefusal',
    `${postJs}; return bgosPost`)(
    'https://api.example.test/api/v1', '42', {}, () => ({ 'X-BGOS-Pairing': 'fixture' }), 100,
    async (request: any, consume: any) => {
      calls.push(request)
      return consume({ ok: status === 200, status, text: async () => responseBody, json: async () => ({ reactions: [{ actors: [{ name: 'private fixture' }] }] }) })
    },
    class extends Error { constructor(message: string, readonly status: number) { super(message) } },
    (text: string) => text,
    messagesCallerHeaders, () => null,
  )
  const start = source.indexOf("    case 'react':")
  assert.ok(start >= 0, 'react must be dispatched by the real tool handler')
  const end = source.indexOf('\n    case ', start + 1)
  assert.ok(end > start, 'react dispatch has a following case')
  const dispatchJs = ts.transpileModule(`async function dispatch(rawArgs: Record<string, unknown>) { switch ('react') { ${source.slice(start, end)} } }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const dispatch = new Function('handleReactTool', 'bgosPost', `${dispatchJs}; return dispatch`)(handleReactTool, bgosPost)
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
  test(`react posts only emoji to the ${remove ? 'remove' : 'add'} route (remove=${remove})`, async () => {
    const f = fixture()
    const result = await f.dispatch({ message_id: '123', emoji: '👍', ...(remove === undefined ? {} : { remove }) })
    assert.deepEqual(f.calls.map(call => ({ url: call.url, method: call.init.method, headers: call.init.headers, body: JSON.parse(call.init.body) })), [{
      url: `https://api.example.test/api/v1/messages/123/reactions${remove ? '/remove' : ''}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BGOS-Pairing': 'fixture' },
      body: { emoji: '👍' },
    }])
    assert.deepEqual(result, { content: [{ type: 'text', text: remove ? 'Reaction removed.' : 'Reaction added.' }] })
  })
}

test('whatever identity the caller passes, the request carries only emoji', async () => {
  for (const remove of [false, true]) {
    for (const forged of [{ fromAgent: { assistantId: 999 } }, { assistantId: 999 }, { peerId: 999 }, { externalId: 'someone-else' }, { agent_id: '999', user_id: 'someone-else' }]) {
      const f = fixture()
      assert.notEqual((await f.dispatch({ message_id: '123', emoji: '👍', remove, ...forged })).isError, true)
      assert.equal(f.calls.length, 1)
      assert.deepEqual(JSON.parse(f.calls[0]!.init.body), { emoji: '👍' })
      assert.deepEqual(f.calls[0]!.init.headers, { 'Content-Type': 'application/json', 'X-BGOS-Pairing': 'fixture' })
    }
  }
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

for (const status of [400, 401, 403, 404, 409, 503]) {
  test(`server refusal ${status} becomes one plain sentence without server data`, async () => {
    for (const remove of [false, true]) {
      const f = fixture(status, '{"message":"Not allowed for private fixture 987654.\nInternal details."}')
      const result = await f.dispatch({ message_id: '123', emoji: '👍', remove })
      assert.deepEqual(result, { content: [{ type: 'text', text: 'The reaction could not be saved.' }], isError: true })
      assert.equal(f.calls.length, 1)
    }
  })
}

test('a transport exception also stays private', async () => {
  const result = await handleReactTool({ message_id: '123', emoji: '👍' }, {
    post: async () => { throw new Error('private fixture\n at hiddenFunction') },
  })
  assert.deepEqual(result, { content: [{ type: 'text', text: 'The reaction could not be saved.' }], isError: true })
})

test('missing arguments return a plain error before HTTP', async () => {
  let calls = 0
  const result = await handleReactTool(undefined, { post: async () => { calls += 1 } })
  assert.equal(result.isError, true)
  assert.equal(calls, 0)
})
