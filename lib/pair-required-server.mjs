/**
 * pair-required-server: the MCP server an UNPAIRED HOAI install answers with.
 *
 * WHY A DEAD SERVER IS THE WRONG ANSWER, which is the whole reason this file
 * exists. server.ts used to write its refusal to stderr and call process.exit(1)
 * BEFORE the initialize handshake. Claude Code has nothing to show for that
 * except the transport dying, so the session reports
 *
 *     bgos  failed  CONNECTION_CLOSED
 *
 * and the one line that says what to do about it, "Not paired yet. Pair this
 * session with a one time code from the HOAI app", goes to a stderr stream
 * nobody reads. From inside the session the two most different causes on this
 * channel, "you have not paired yet" and "the daemon crashed", look identical,
 * and the agent sitting in that session cannot tell its owner which one it is.
 *
 * A DEGRADED CONNECTION IS DIAGNOSABLE FROM THE INSIDE. This server completes
 * the handshake and then publishes exactly one tool, hoai_pair_required, whose
 * description and return value both carry the pairing instructions. So the
 * model can see, in its own tool list, that the channel exists, that it is not
 * paired, and what the owner has to type. Nothing else is exposed: there is no
 * channel capability, no chat delivery and no other tool, because a server that
 * cannot authenticate must not look like one that can.
 *
 * Plain JavaScript, import-safe, no top-level side effects: the transport is
 * injectable so test/pair-required-server.test.ts drives a real client over an
 * in-memory pair rather than asserting on a string.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

/** The ONE tool an unpaired install publishes. Named for what it tells you,
 *  not for what it does, because what it does is explain itself. */
export const PAIR_REQUIRED_TOOL_NAME = 'hoai_pair_required'

/** The steps that actually fix it, in the order a user performs them. Kept as
 *  one string so the tool description, the tool result and the server
 *  instructions can never drift into telling three different stories. */
export function pairRequiredInstructions(reason = '') {
  const detail = String(reason ?? '').trim()
  return [
    'The HOAI (BGOS) channel is CONNECTED BUT NOT PAIRED. No chat message can',
    'reach this session, and none of the normal HOAI tools exist in it, until',
    'this machine is paired.',
    detail ? `\nWhy this server is degraded: ${detail}` : '',
    '\nTo fix it:',
    '  1. In the Home of Agents app, open this agent and take a one time',
    '     pairing code (Add agent, or the agent\'s Pair button).',
    '  2. In THIS agent\'s folder, run:  hoai pair <CODE>',
    '     (bgos-pair <CODE> and the /hoai:pair slash command do the same thing.)',
    '  3. Restart Claude Code. The full HOAI toolset replaces this one tool.',
    '\nThis tool cannot pair for you: the code comes from the app, and only the',
    'owner can read it. Tell the owner the steps above rather than retrying.',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/** The ListTools entry. The description carries the instructions because a
 *  model that never calls the tool still reads every description it is given. */
export function pairRequiredTool(reason = '') {
  return {
    name: PAIR_REQUIRED_TOOL_NAME,
    description:
      'HOAI is not paired on this machine, so this channel can neither receive ' +
      'nor send chat messages. Call this tool to get the exact steps that fix ' +
      'it, or just read them here.\n\n' +
      pairRequiredInstructions(reason),
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  }
}

/** The CallTool result: the same instructions, as content the model can quote
 *  back to its owner verbatim. */
export function pairRequiredToolResult(reason = '') {
  return {
    content: [{ type: 'text', text: pairRequiredInstructions(reason) }],
  }
}

/** What a call to any OTHER name gets. An unpaired server publishes one tool,
 *  so a call to a second one is a stale tool list, and saying which state we
 *  are in beats a bare "unknown tool". */
export function unknownToolResult(name, reason = '') {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text:
          `${String(name)} is not available: HOAI is not paired on this machine, so this ` +
          `server publishes only ${PAIR_REQUIRED_TOOL_NAME}.\n\n${pairRequiredInstructions(reason)}`,
      },
    ],
  }
}

/**
 * The degraded server, wired but not connected.
 *
 * It declares `tools` and NOTHING else. In particular it does not declare the
 * experimental claude/channel capabilities the real daemon declares: that is
 * what tells Claude Code a channel is live and can be pushed to, and claiming
 * it here would advertise inbound delivery that cannot happen. Nor does it pin
 * the protocol revision (lib/channel-transport.ts), because that pin exists so
 * UNSOLICITED notifications are accepted, and this server never sends one.
 *
 * @param {{ reason?: string, version?: string }} [params]
 * @returns {Server}
 */
export function createPairRequiredServer({ reason = '', version = '0.19.0' } = {}) {
  const server = new Server(
    { name: 'bgos', version },
    {
      capabilities: { tools: {} },
      instructions: pairRequiredInstructions(reason),
    },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [pairRequiredTool(reason)],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req?.params?.name
    if (name === PAIR_REQUIRED_TOOL_NAME) return pairRequiredToolResult(reason)
    return unknownToolResult(name, reason)
  })
  return server
}

/**
 * The stdin events that mean the host has gone.
 *
 * Mirror of lib/process-lifecycle.ts shouldShutdownOnStdin, and pinned equal to
 * it by test/pair-required-server.test.ts, because the two must not drift: it
 * is the same parent dying, and a daemon that disagrees with itself about that
 * is exactly the orphan that module exists to prevent. Duplicated rather than
 * imported only because this file is plain .mjs and that one is TypeScript; no
 * .mjs in this repo imports a .ts, and one leaking import would make the whole
 * lib unusable under bare node.
 */
export const STDIN_END_EVENTS = Object.freeze(['end', 'close'])

/** Has stdin already finished, whether or not an event is still coming?
 *  Mirror of lib/process-lifecycle.ts stdinHasEnded, flags ORed for the same
 *  reason: bun reports readableEnded false where node reports it true, so
 *  requiring agreement would answer false on the runtime this actually ships
 *  on. */
function streamHasEnded(stream) {
  return Boolean(stream?.destroyed || stream?.closed || stream?.readableEnded)
}

/**
 * Serve the degraded server until the host disconnects.
 *
 * Resolves true when it connected and was later closed (the host went away,
 * which is an ordinary end), false when the transport could not be connected at
 * all. The caller decides the exit code from that: a server that served is not
 * a failed process, even though the install it describes is unfinished.
 *
 * WHY STDIN IS WATCHED AND NOT JUST server.onclose, measured here 2026-09-21
 * against a real `bun server.ts`: the SDK's StdioServerTransport subscribes to
 * 'data' and 'error' on stdin and to nothing else, so an EOF closes neither the
 * transport nor the server and onclose never fires. Waiting on that alone left
 * the unpaired daemon resident forever after its host had gone, which is a
 * worse failure than the exit(1) this replaced: at least that process died.
 *
 * @param {{ reason?: string, version?: string, transport?: unknown,
 *   stdin?: NodeJS.ReadStream, log?: (line: string) => void }} [params]
 * @returns {Promise<boolean>}
 */
export async function servePairRequired({
  reason = '',
  version,
  transport,
  stdin = process.stdin,
  log,
} = {}) {
  const server = createPairRequiredServer({ reason, version })
  const wire = transport ?? new StdioServerTransport()
  try {
    await server.connect(wire)
  } catch (err) {
    log?.(`could not serve the unpaired channel: ${err?.message ?? err}`)
    return false
  }
  log?.(
    `serving a DEGRADED channel: paired = no, tools = ${PAIR_REQUIRED_TOOL_NAME} only. ` +
      'The session can now read why it is not paired instead of seeing CONNECTION_CLOSED.',
  )
  await new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    server.onclose = finish
    for (const event of STDIN_END_EVENTS) stdin?.once?.(event, finish)
    // A pipe can be closed before this process reaches its first line, so there
    // may be no event left to catch at all.
    if (streamHasEnded(stdin)) finish()
  })
  try {
    await server.close()
  } catch {
    // Already closed, or a transport that cannot be closed twice. Either way
    // there is nothing left to do about it and the caller is about to exit.
  }
  return true
}
