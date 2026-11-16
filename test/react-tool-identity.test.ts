import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { REACT_TOOL, handleReactTool } from '../lib/react-tool.ts'

const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
const start = source.indexOf("    case 'react':")
const end = source.indexOf('\n    case ', start + 1)
assert.ok(start >= 0 && end > start)
const dispatchJs = ts.transpileModule(`async function dispatch(rawArgs: Record<string, unknown>) { switch ('react') { ${source.slice(start, end)} } }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function fixture(assistantId: unknown) {
  const calls: Array<{ path: string; body: unknown }> = []
  const post = async (path: string, body: unknown) => { calls.push({ path, body }); return {} }
  const dispatch = new Function('handleReactTool', 'bgosPost', 'AUTH', 'ASSISTANT_ID', `${dispatchJs}; return dispatch`)(
    handleReactTool, post, { mode: 'pairing' }, assistantId,
  )
  return { calls, dispatch }
}

test('the reaction schema exposes no identity selector', () => {
  assert.deepEqual(Object.keys(REACT_TOOL.inputSchema.properties).sort(), ['emoji', 'message_id', 'remove'])
  assert.equal(REACT_TOOL.inputSchema.additionalProperties, false)
})

test('both reaction routes use only the configured agent id, never an injected identity', async () => {
  for (const id of ['42', '7']) {
    for (const remove of [false, true]) {
      const f = fixture(id)
      const result = await f.dispatch({
        message_id: '123', emoji: '👍', remove,
        assistantId: 999, assistant_id: 999, peerId: 998,
        fromAgent: { assistantId: 999, peerId: 998, externalId: 'someone-else' },
      })
      assert.notEqual(result.isError, true)
      assert.deepEqual(f.calls, [{
        path: `messages/123/reactions${remove ? '/remove' : ''}`,
        body: { emoji: '👍', fromAgent: { assistantId: Number(id) } },
      }])
    }
  }
})

test('a missing or invalid configured id refuses before HTTP and cannot be supplied by tool input', async () => {
  for (const id of [undefined, null, '', ' ', '0', '-1', '1.5', 'not-an-id', '9007199254740993']) {
    const f = fixture(id)
    assert.deepEqual(await f.dispatch({ message_id: '123', emoji: '👍', assistantId: 42, fromAgent: { assistantId: 42 } }), {
      content: [{ type: 'text', text: 'Reactions need this agent\'s configured id; pair this agent again before retrying.' }],
      isError: true,
    })
    assert.deepEqual(f.calls, [])
  }
})
