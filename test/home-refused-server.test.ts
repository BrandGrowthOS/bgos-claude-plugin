/**
 * What a REFUSED stray answers with (0.65.0, board fc75c7c3).
 *
 * A Claude Code session started outside an agent's folder, on a computer whose
 * one agent has a home, is refused by the home check (lib/agent-credentials.ts
 * decideHomeBinding). Until 0.64.3 server.ts wrote the refusal to stderr and
 * exited before the MCP handshake, so the session showed only a failed server
 * (CONNECTION_CLOSED) and could not say why. It now serves a one tool notice,
 * as an unpaired install already does (lib/pair-required-server.mjs).
 *
 * A refused session is usually the owner's own coding session, so the notice
 * is quiet: no server instructions (nothing goes into that session's system
 * prompt), one short tool description, and the full reason only when called.
 *
 * Driven over a REAL in-memory transport pair with the SDK's own client.
 *
 * Run: npx tsx --test test/home-refused-server.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import {
  HOME_REFUSED_TOOL_NAME,
  PAIR_REQUIRED_TOOL_NAME,
  createHomeRefusedServer,
  homeRefusedInstructions,
  serveHomeRefused,
} from '../lib/pair-required-server.mjs'
import { decideHomeBinding, formatHomeBindingRefusal } from '../lib/agent-credentials.ts'

const HOME = '/Users/kc/agents/ares'
const STRAY = '/Users/kc/BGOS'
const REASON = formatHomeBindingRefusal(
  decideHomeBinding({
    via: 'sole-per-assistant',
    cwd: STRAY,
    recordedHomeDir: HOME,
    recordedHomeSource: 'pairing',
    assistantId: '1040',
    platform: 'linux',
  }),
)

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: still pending after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function connectedClient() {
  const server = createHomeRefusedServer({ reason: REASON })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'probe-client', version: '1.0.0' }, { capabilities: {} })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return { client, server }
}

test('a refused stray ANSWERS initialize, as a notice and not as a channel', async () => {
  const { client, server } = await connectedClient()
  try {
    assert.equal(client.getServerVersion()?.name, 'bgos')
    const capabilities = client.getServerCapabilities()
    assert.ok(capabilities?.tools, 'it publishes a tool list')
    // No claude/channel capability: claiming it would advertise inbound
    // delivery to a session that is not the agent.
    assert.equal((capabilities as Record<string, unknown>).experimental, undefined)
    // Nothing is injected into the session's system prompt.
    assert.equal(client.getInstructions() ?? '', '')
  } finally {
    await client.close()
    await server.close()
  }
})

test('it lists EXACTLY one tool with a short description, and the call carries the reason and the fixes', async () => {
  const { client, server } = await connectedClient()
  try {
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map((tool) => tool.name), [HOME_REFUSED_TOOL_NAME])
    assert.equal(HOME_REFUSED_TOOL_NAME, 'hoai_not_this_agent')
    assert.notEqual(HOME_REFUSED_TOOL_NAME, PAIR_REQUIRED_TOOL_NAME)
    const description = String(listed.tools[0]!.description ?? '')
    assert.ok(description.length < 400, `a quiet description, got ${description.length} characters`)
    assert.match(description, /refused/i)
    assert.match(description, /Nothing to do unless/)

    const result = await client.callTool({ name: HOME_REFUSED_TOOL_NAME, arguments: {} })
    const text = String((result.content as Array<{ text?: string }>)[0]!.text ?? '')
    assert.ok(text.includes(HOME), 'names the agent\'s home')
    assert.ok(text.includes(STRAY), 'names the folder this session started in')
    assert.match(text, /1040/)
    assert.match(text, /\.bgos-agent-id/)
    assert.match(text, /hoai pair/)
    assert.match(text, /nothing to retry/)
  } finally {
    await client.close()
    await server.close()
  }
})

test('any OTHER tool name is refused with the same explanation', async () => {
  const { client, server } = await connectedClient()
  try {
    const result = await client.callTool({ name: 'reply', arguments: {} })
    assert.equal(result.isError, true)
    const text = String((result.content as Array<{ text?: string }>)[0]!.text ?? '')
    assert.match(text, /reply is not available/)
    assert.ok(text.includes(homeRefusedInstructions(REASON)))
  } finally {
    await client.close()
    await server.close()
  }
})

test('serveHomeRefused says it is refusing, serves until the host goes, and ends with stdin', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const logs: string[] = []
  await clientTransport.start()
  const serving = serveHomeRefused({
    reason: REASON,
    transport: serverTransport,
    stdin: { once: () => {} },
    log: (line: string) => logs.push(line),
  } as never)
  assert.equal(await Promise.race([serving, Promise.resolve('still-serving')]), 'still-serving')
  assert.match(logs.join('\n'), /REFUSED/)
  assert.match(logs.join('\n'), new RegExp(HOME_REFUSED_TOOL_NAME))
  await clientTransport.close()
  assert.equal(await within(serving, 2000, 'serve after the transport closed'), true)

  const [, second] = InMemoryTransport.createLinkedPair()
  const stdin = { once: () => {}, destroyed: false, closed: true, readableEnded: false }
  assert.equal(await within(serveHomeRefused({ reason: REASON, transport: second, stdin } as never), 2000, 'ended stdin'), true)
})

test('server.ts serves the notice on a home refusal instead of exiting before the handshake', () => {
  const branch = /if \(HOME_BINDING\.action === 'refuse'\) \{[\s\S]*?\n\}/.exec(serverSource)
  assert.ok(branch, 'the refusal branch was not found')
  const body = branch![0]
  assert.match(body, /await serveHomeRefused\(\{/)
  assert.match(body, /reason: formatHomeBindingRefusal\(HOME_BINDING\)/)
  // The exit that killed the transport before initialize is gone; the one that
  // remains runs after serving. And nothing past this branch runs for a refused
  // stray: no credentials are used, no lock is taken.
  assert.doesNotMatch(body, /\n\s*process\.exit\(1\)\s*\n/)
  assert.match(body, /process\.exit\(served \? 0 : 1\)/)
  assert.ok(serverSource.indexOf(body) < serverSource.indexOf('const AUTH: ResolvedAuth = resolveAuth('))
})
