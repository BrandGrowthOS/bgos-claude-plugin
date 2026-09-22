/**
 * lib/pair-required-server.mjs: what an UNPAIRED HOAI install answers with.
 *
 * THE DEFECT THESE PIN (2026-09-21). server.ts used to write its refusal to
 * stderr and call process.exit(1) BEFORE the initialize handshake, so the only
 * thing Claude Code could report was the transport dying:
 *
 *     bgos  failed  CONNECTION_CLOSED
 *
 * while the one line naming the fix, "Not paired yet. Pair this session with a
 * one time code from the HOAI app", went to a stream the session never shows.
 * From inside that session "not paired yet" and "the daemon crashed" are the
 * same symptom, and the agent cannot tell its owner which one it is looking at.
 *
 * A degraded connection is diagnosable; a dead one is not. So the server now
 * completes the handshake and publishes exactly ONE tool, whose description and
 * result both carry the pairing steps.
 *
 * Driven over a REAL in-memory transport pair with the SDK's own client, the
 * idiom test/channel-transport.test.ts established: a handshake asserted as a
 * string proves the string, not the handshake.
 *
 * Run: npx tsx --test test/pair-required-server.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import {
  PAIR_REQUIRED_TOOL_NAME,
  STDIN_END_EVENTS,
  createPairRequiredServer,
  pairRequiredInstructions,
  pairRequiredTool,
  pairRequiredToolResult,
  servePairRequired,
  unknownToolResult,
} from '../lib/pair-required-server.mjs'
import { shouldShutdownOnStdin } from '../lib/process-lifecycle.ts'

const REASON =
  'Not paired yet. Pair this session with a one time code from the HOAI app: ' +
  'run bgos-pair BGOS-XXXX-XX (or the /hoai:pair slash command). Missing: pairingToken.'

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n',
)

/**
 * Await with a deadline.
 *
 * The guard two of the tests below hold is literally "this promise settles",
 * and the way that guard breaks is a HANG, not a wrong value. Measured here
 * 2026-09-21: removing the stdin watch wedged the whole runner instead of
 * failing one test, and a mutation that hangs proves nothing because nobody
 * ever sees it go red. So the deadline is part of the assertion.
 */
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

/** Connect a real client to a freshly wired unpaired server. */
async function connectedClient(reason = REASON) {
  const server = createPairRequiredServer({ reason })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'probe-client', version: '1.0.0' }, { capabilities: {} })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return { client, server }
}

test('an unpaired server ANSWERS initialize instead of dying on it', async () => {
  const { client, server } = await connectedClient()
  try {
    // client.connect performs initialize; reaching here at all is the fix. The
    // negotiated result is what the host had nothing of before.
    const version = client.getServerVersion()
    assert.equal(version?.name, 'bgos')
    const capabilities = client.getServerCapabilities()
    assert.ok(capabilities?.tools, 'an unpaired server still publishes a tool list')
    // It must NOT claim the channel capabilities the live daemon declares:
    // those tell Claude Code inbound delivery works, and here it cannot.
    assert.equal((capabilities as Record<string, unknown>).experimental, undefined)
    // The instructions carry the steps, so a model sees them without calling
    // anything at all.
    assert.match(String(client.getInstructions() ?? ''), /hoai pair <CODE>/)
  } finally {
    await client.close()
    await server.close()
  }
})

test('an unpaired server lists EXACTLY hoai_pair_required, and its description carries the steps', async () => {
  const { client, server } = await connectedClient()
  try {
    const listed = await client.listTools()
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      [PAIR_REQUIRED_TOOL_NAME],
    )
    assert.equal(PAIR_REQUIRED_TOOL_NAME, 'hoai_pair_required')
    const description = String(listed.tools[0]!.description ?? '')
    assert.match(description, /NOT PAIRED/)
    assert.match(description, /hoai pair <CODE>/)
    assert.match(description, /one time/)
    // The reason the daemon gave is carried through verbatim, so the session
    // can see WHICH half of the pairing is missing.
    assert.match(description, /Missing: pairingToken/)
  } finally {
    await client.close()
    await server.close()
  }
})

test('calling the tool returns the pairing steps as readable content', async () => {
  const { client, server } = await connectedClient()
  try {
    const result = await client.callTool({ name: PAIR_REQUIRED_TOOL_NAME, arguments: {} })
    const content = result.content as Array<{ type: string; text?: string }>
    assert.equal(content[0]!.type, 'text')
    const text = String(content[0]!.text ?? '')
    assert.match(text, /hoai pair <CODE>/)
    assert.match(text, /Restart Claude Code/)
    // It must not pretend it can pair by itself; a retry loop helps nobody.
    assert.match(text, /cannot pair for you/)
  } finally {
    await client.close()
    await server.close()
  }
})

test('any OTHER tool name is refused with the same explanation, not a bare unknown-tool error', async () => {
  const { client, server } = await connectedClient()
  try {
    const result = await client.callTool({ name: 'bgos_capabilities', arguments: {} })
    assert.equal(result.isError, true)
    const text = String((result.content as Array<{ text?: string }>)[0]!.text ?? '')
    assert.match(text, /bgos_capabilities is not available/)
    assert.match(text, /hoai pair <CODE>/)
  } finally {
    await client.close()
    await server.close()
  }
})

test('servePairRequired connects, reports the degraded state, and resolves when the host goes away', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const logs: string[] = []
  await clientTransport.start()
  const serving = servePairRequired({
    reason: REASON,
    transport: serverTransport,
    // An inert stdin, deliberately: this test is about the TRANSPORT closing,
    // and borrowing the runner's real stdin would make the result depend on
    // whether the harness had already ended it.
    stdin: { once: () => {} },
    log: (line: string) => logs.push(line),
  } as never)
  // It must not resolve while the host is still attached: resolving early is
  // how the caller's process.exit lands before the session ever reads a tool.
  const early = await Promise.race([serving, Promise.resolve('still-serving')])
  assert.equal(early, 'still-serving')
  assert.match(logs.join('\n'), /DEGRADED/)
  assert.match(logs.join('\n'), new RegExp(PAIR_REQUIRED_TOOL_NAME))
  await clientTransport.close()
  assert.equal(
    await within(serving, 2000, 'serve after the transport closed'),
    true,
    'a server that served is not a failed process',
  )
})

test('servePairRequired reports false when the transport cannot be connected at all', async () => {
  const logs: string[] = []
  const broken = {
    start: async () => {
      throw new Error('stdio is gone')
    },
    send: async () => {},
    close: async () => {},
  }
  assert.equal(
    await servePairRequired({ reason: REASON, transport: broken, log: (l: string) => logs.push(l) }),
    false,
  )
  assert.match(logs.join('\n'), /could not serve/)
})

// --- not an orphan --------------------------------------------------------
// MEASURED, not assumed (2026-09-21, against a real `bun server.ts`): the SDK's
// StdioServerTransport subscribes to 'data' and 'error' on stdin and to nothing
// else, so an EOF closes neither the transport nor the server and onclose never
// fires. The first version of this serve loop waited on onclose alone and the
// unpaired daemon stayed resident forever after its host had gone: a worse
// failure than the process.exit(1) it replaced, because at least that died.

test('servePairRequired ends when stdin does, because the SDK transport will not tell it', async () => {
  const [, serverTransport] = InMemoryTransport.createLinkedPair()
  const listeners = new Map<string, Array<() => void>>()
  const stdin = {
    once: (event: string, fn: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn])
    },
  }
  const serving = servePairRequired({ reason: REASON, transport: serverTransport, stdin } as never)
  assert.equal(await Promise.race([serving, Promise.resolve('still-serving')]), 'still-serving')
  // Every event in the list has to work on its own: the host that delivers
  // 'close' without 'end' is not hypothetical, it is a killed parent.
  assert.deepEqual([...listeners.keys()].sort(), [...STDIN_END_EVENTS].sort())
  for (const fn of listeners.get('end') ?? []) fn()
  assert.equal(await within(serving, 2000, 'serve after stdin ended'), true)
})

test('servePairRequired ends immediately when stdin ALREADY ended before it started', async () => {
  // A pipe can be closed before this process reaches its first line, so there
  // may be no event left to catch at all.
  const [, serverTransport] = InMemoryTransport.createLinkedPair()
  const stdin = { once: () => {}, destroyed: false, closed: true, readableEnded: false }
  assert.equal(
    await within(
      servePairRequired({ reason: REASON, transport: serverTransport, stdin } as never),
      2000,
      'serve with an already-ended stdin',
    ),
    true,
  )
})

test('STDIN_END_EVENTS is exactly what lib/process-lifecycle.ts shuts down on', () => {
  // Two copies of one rule, pinned equal rather than trusted: it is the same
  // parent dying, and a daemon that disagrees with itself about that is the
  // orphan process-lifecycle exists to prevent. The candidates are checked in
  // both directions so widening one side alone fails here.
  for (const event of STDIN_END_EVENTS) {
    assert.equal(shouldShutdownOnStdin(event as never), true, event)
  }
  for (const event of ['end', 'close', 'data', 'error']) {
    assert.equal(
      STDIN_END_EVENTS.includes(event),
      shouldShutdownOnStdin(event as never),
      event,
    )
  }
})

test('the pure pieces agree: one set of instructions reaches the description, the result and a refusal', () => {
  const steps = pairRequiredInstructions(REASON)
  assert.ok(String(pairRequiredTool(REASON).description).includes(steps))
  assert.ok(
    String((pairRequiredToolResult(REASON).content[0] as { text: string }).text).includes(steps),
  )
  assert.ok(
    String((unknownToolResult('x', REASON).content[0] as { text: string }).text).includes(steps),
  )
  // An empty reason still produces usable steps (the daemon may have nothing
  // specific to say), and never a dangling "Why this server is degraded:".
  assert.doesNotMatch(pairRequiredInstructions(''), /Why this server is degraded/)
  assert.match(pairRequiredInstructions(''), /hoai pair <CODE>/)
  assert.equal(pairRequiredTool('').inputSchema.additionalProperties, false)
})

test('server.ts serves the unpaired channel instead of exiting before the handshake', () => {
  // The wiring, pinned at the source: the pure module above is only worth
  // anything if the daemon's incomplete-credentials branch actually reaches it.
  const branch = /if \(!AUTH\.complete\) \{[\s\S]*?\n\}/.exec(serverSource)
  assert.ok(branch, 'the incomplete-credentials branch was not found')
  const body = branch![0]
  assert.match(body, /await servePairRequired\(\{/)
  assert.match(body, /reason: missingCredsMessage\(AUTH\)/)
  // The exit that used to kill the transport before initialize is gone; what
  // remains is the exit AFTER serving, which cannot precede the handshake.
  assert.doesNotMatch(body, /\n\s*process\.exit\(1\)\s*\n/)
  assert.match(body, /process\.exit\(served \? 0 : 1\)/)
  assert.ok(
    serverSource.includes("import { servePairRequired } from './lib/pair-required-server.mjs'"),
  )
})
