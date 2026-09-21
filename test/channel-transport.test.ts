/**
 * The channel's own transport gates: two facts that are silent when broken.
 *
 * Claude Code drops an inbound channel push ENTIRELY, with nothing on screen
 * and nothing in the log, unless the MCP server it came from clears both of
 * the CLI's own checks:
 *
 *   1. the server declares capabilities.experimental['claude/channel']. The
 *      CLI's check is literally `!!capabilities?.experimental?.['claude/channel']`,
 *      and a miss is skipped with kind 'capability', whose toast is
 *      SUPPRESSED.
 *   2. the connection negotiated a LEGACY protocol revision. A modern one is
 *      skipped with kind 'era' and the reason 'connection negotiated a modern
 *      protocol revision with no unsolicited notification path'. A channel
 *      push IS an unsolicited notification, so that era is the one where the
 *      whole channel works.
 *
 * Both were found the hard way by the stage 6 gate probe: its first stub
 * cleared neither and its pushes vanished without a trace. Every inbound BGOS
 * message rides this path, so breaking either one is an outage with no error
 * message anywhere, which is exactly the kind of fact that gets refactored
 * away by accident. Nothing pinned either before this file.
 *
 * The source guards below say server.ts still does both. The behavioural
 * tests say the pin itself works, against a REAL SDK server, because a source
 * guard on a mechanism nobody executed is a string comparison and not a
 * proof.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import {
  CHANNEL_PROTOCOL_REVISION,
  pinChannelProtocolRevision,
} from '../lib/channel-transport.ts'

// The repo idiom for a source scan: read through an import.meta.url URL (it
// resolves identically under bun and under the tsx runner) and normalise CRLF
// to LF, so the assertions describe the code and not the checkout.
const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const CHANNEL_CAPABILITIES = {
  tools: {},
  experimental: {
    'claude/channel': {},
    'claude/channel/permission': {},
  },
}

function newChannelServer(): Server {
  return new Server(
    { name: 'probe', version: '0.0.0' },
    { capabilities: CHANNEL_CAPABILITIES, instructions: 'probe instructions' },
  )
}

/** Drive one raw initialize over an in memory pair and return its result. */
async function initializeAnswer(
  mcp: Server,
  requested: string,
): Promise<Record<string, unknown>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const answers: Array<Record<string, unknown>> = []
  clientTransport.onmessage = (message: unknown) => {
    answers.push(message as Record<string, unknown>)
  }
  await clientTransport.start()
  await mcp.connect(serverTransport)
  await clientTransport.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: requested,
      capabilities: {},
      clientInfo: { name: 'probe-client', version: '1.0.0' },
    },
  } as never)
  for (let i = 0; i < 50 && answers.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  await mcp.close()
  const answer = answers.find((m) => m.id === 1)
  assert.ok(answer, 'the server never answered initialize')
  const result = answer.result as Record<string, unknown> | undefined
  assert.ok(result, `initialize failed: ${JSON.stringify(answer)}`)
  return result
}

test('CONTROL: an unpinned SDK server echoes the revision the client asked for', async () => {
  // This is the failure mode, not a wish: the SDK answers with the client's
  // own requested revision whenever it supports it, so the era the channel
  // ends up in is decided by whatever the CLI asks for that day.
  const result = await initializeAnswer(newChannelServer(), '2025-11-25')
  assert.equal(result.protocolVersion, '2025-11-25')
})

test('the pinned server answers the legacy revision whatever the client asked for', async () => {
  const mcp = newChannelServer()
  assert.equal(pinChannelProtocolRevision(mcp), true, 'the pin must find the SDK handler')
  const result = await initializeAnswer(mcp, '2025-11-25')
  assert.equal(result.protocolVersion, CHANNEL_PROTOCOL_REVISION)
  assert.equal(CHANNEL_PROTOCOL_REVISION, '2025-06-18')
})

test('the pin changes the revision and NOTHING else about the handshake', async () => {
  // Replacing the answer wholesale would be the dangerous version of this
  // change: the capabilities and the instructions are what the CLI reads to
  // decide the channel exists at all and what to tell the model.
  const plain = await initializeAnswer(newChannelServer(), '2025-06-18')
  const pinned = newChannelServer()
  pinChannelProtocolRevision(pinned)
  const answer = await initializeAnswer(pinned, '2025-11-25')
  assert.deepEqual(answer.capabilities, plain.capabilities)
  assert.deepEqual(answer.serverInfo, plain.serverInfo)
  assert.equal(answer.instructions, plain.instructions)
  assert.deepEqual(
    (answer.capabilities as { experimental?: Record<string, unknown> }).experimental,
    { 'claude/channel': {}, 'claude/channel/permission': {} },
  )
})

test('the pin FAILS OPEN when the SDK has no initialize handler to wrap', () => {
  // A future SDK could stop registering one. Then the daemon must keep the
  // handshake it has rather than answer a handshake this file invented: a
  // channel in the wrong era still delivers outbound replies, and a broken
  // initialize delivers nothing at all.
  const notAServer = { _requestHandlers: new Map() } as unknown as Server
  assert.equal(pinChannelProtocolRevision(notAServer), false)
  assert.equal(pinChannelProtocolRevision({} as unknown as Server), false)
})

test('server.ts declares the claude/channel capability, or every inbound message vanishes', () => {
  const at = server.indexOf('const mcp = new Server(')
  assert.ok(at > 0, 'the channel MCP server must be constructed in server.ts')
  const head = server.slice(at, at + 400)
  assert.ok(
    head.includes("'claude/channel': {}"),
    'the server must declare experimental[claude/channel]: the CLI skips a push from a server that does not, and suppresses the toast',
  )
  assert.ok(head.includes('experimental: {'), 'the declaration must sit under experimental')
})

test('server.ts pins the legacy protocol revision instead of echoing the client', () => {
  assert.match(
    server,
    /pinChannelProtocolRevision\(mcp\)/,
    'server.ts must pin the negotiated revision on its own MCP server',
  )
  assert.match(
    server,
    /from '\.\/lib\/channel-transport\.js'/,
    'the pin must come from the module the behavioural tests above exercise',
  )
})
