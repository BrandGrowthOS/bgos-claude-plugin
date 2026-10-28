/**
 * A reply into a peer side thread whose conversation has CLOSED (board row
 * 28fed1cd), RUN against a stub HOAI and a stub peer.
 *
 * THE BUG. Two agents talk in a side thread; the conversation closes on
 * timeout and the daemon gets `peer_conversation_closed`. A later `reply` into
 * that chat answered "Sent (message_id: N)", and the peer never received it,
 * nor a second reply sent before the peer answered. On 2026-10-27 five of
 * Data's replies never reached Ares, and Ares asked the same questions four
 * times.
 *
 * WHERE THE TRUTH LIVES. HOAI keeps the conversation's state. A participant's
 * /send-message into a closed side thread is accepted (BGOS
 * ChatParticipationService revives the conversation, #1265) and saved, and the
 * forward to the other agent (SendMessageService.bridgePeerReplyIfApplicable)
 * is best effort: each of its refusals logs and returns, and the answer is 201
 * with the saved message either way. So "Sent" here only ever meant "saved".
 * The daemon does know the close (four signals, all through
 * markConversationClosed), and the reply tool never asked.
 *
 * THE STUB answers the way the agents saw it on 10-27: a reply into a closed
 * conversation is saved and answered 201, and the stub peer receives nothing.
 * In `reports` mode it also sends the field the backend half adds
 * (`peerDelivery`), so the plugin is proven with and without that fix.
 *
 * The assertions do not care which fix is chosen: a reply into a closed
 * conversation either reaches the stub peer or comes back as an error, and it
 * never says Sent while the peer got nothing.
 *
 * Run with: node.exe --import tsx --test test/peer-closed-reply.test.ts
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import ts from 'typescript'

import { boundedFetch } from '../lib/bounded-fetch.ts'
import { authHeaders } from '../lib/agent-credentials.ts'
import { inboundOwesReply } from '../lib/channel-liveness.ts'
import { messagesCallerHeaders } from '../lib/messages-caller-header.ts'
import { errorBodyText } from '../lib/error-body.ts'
import * as peerRefusal from '../lib/peer-refusal.ts'

// Absent on code without the fix, which is exactly what the red run needs: the
// lifted functions then never reference it.
const peerClosedReply: Record<string, unknown> = await import('../lib/peer-closed-reply.ts').catch(() => ({}))

const SERVER = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const SIDE = '33017'
const SIDE_B = '33018'
const MAIN = '33001'
const MEETING_CHAT = '33050'
const MEETING_ID = 12
const PEER = 950
const CONV = 77

// ── the stub HOAI and the stub peer ──────────────────────────────────────────

type Mode = 'saves-silently' | 'reports'

interface Thread {
  conv: number
  open: boolean
}

interface Backend {
  url: string
  mode: Mode
  /** Side thread chat id to its conversation, as HOAI holds it. */
  threads: Map<string, Thread>
  /** What the peer agent actually received. */
  peerGot: Array<{ chatId: string; text: string; replyToId?: number }>
  /** Every request, in order, with its parsed body. */
  posts: Array<{ route: string; body: Record<string, unknown> }>
  /** Where the next send_to_peer opens its conversation. */
  nextSideThread: string
  /** Runs while a reply is on the wire, before HOAI answers it. */
  onSendMessage?: () => void
  /** HOAI's word on the next reply only (`reports` mode): it saves it and passes nothing on. */
  nextDelivery?: { state: 'not_forwarded'; reason: string }
  /** HOAI revives a closed conversation on a participant's write, and forwards (Kc's rule, BGOS #1265). */
  revivesOnWrite?: boolean
  /** HOAI reads the next send_to_peer as the closing turn (a closing phrase), whatever turn_state said. */
  peerSendCloses?: boolean
  /** Runs while a send_to_peer is on the wire, after HOAI acted on it and before it answers. */
  onPeerSend?: () => void
  count(route: string): number
}

const servers: Server[] = []
after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
})

async function startBackend(mode: Mode = 'saves-silently'): Promise<Backend> {
  let nextMessageId = 9000
  let nextConv = CONV + 1
  const backend: Backend = {
    url: '',
    mode,
    threads: new Map(),
    peerGot: [],
    posts: [],
    nextSideThread: SIDE_B,
    count: (route) => backend.posts.filter((p) => p.route === route).length,
  }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const route = `${req.method} ${(req.url ?? '/').split('?')[0]}`
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>
      backend.posts.push({ route, body })
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      const id = ++nextMessageId
      if (route === 'POST /api/v1/send-message') {
        backend.onSendMessage?.()
        const chatId = String(body.chatId)
        const thread = backend.threads.get(chatId)
        if (!thread) return send(201, { message: { id, chatId: Number(chatId) } })
        const delivery = backend.nextDelivery
        backend.nextDelivery = undefined
        if (delivery && backend.mode === 'reports') {
          return send(201, { message: { id, chatId: Number(chatId) }, peerDelivery: delivery })
        }
        if (!thread.open && backend.revivesOnWrite) thread.open = true
        if (thread.open) {
          backend.peerGot.push({
            chatId,
            text: String(body.text),
            ...(typeof body.replyToId === 'number' ? { replyToId: body.replyToId } : {}),
          })
          return send(201, {
            message: { id, chatId: Number(chatId) },
            ...(backend.mode === 'reports' ? { peerDelivery: { state: 'forwarded' } } : {}),
          })
        }
        // A closed conversation: saved, answered 201, and nothing forwarded.
        return send(201, {
          message: { id, chatId: Number(chatId) },
          ...(backend.mode === 'reports'
            ? { peerDelivery: { state: 'not_forwarded', reason: 'conversation_not_open' } }
            : {}),
        })
      }
      if (route === `POST /api/v1/meetings/${MEETING_ID}/messages`) {
        return send(201, { id, meetingId: MEETING_ID })
      }
      if (route === `POST /api/v1/peers/${PEER}/send`) {
        const chatId = backend.nextSideThread
        // An open conversation of the pair takes the send; otherwise a new one opens.
        const current = backend.threads.get(chatId)
        const conv = current?.open ? current.conv : nextConv++
        const final = body.turnState === 'final' || backend.peerSendCloses === true
        backend.threads.set(chatId, { conv, open: !final })
        backend.peerGot.push({ chatId, text: String(body.text) })
        backend.onPeerSend?.()
        return send(201, {
          status: 'sent',
          sideThreadChatId: Number(chatId),
          conversationId: conv,
          messageId: id,
          turnState: final ? 'final' : String(body.turnState ?? 'expecting_reply'),
          closed: final ? { reason: 'completed' } : null,
        })
      }
      return send(404, { statusCode: 404, message: 'no such route in the stub' })
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  backend.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  return backend
}

// ── the harness: the daemon's own functions, lifted out of server.ts ─────────

/** A top level declaration through its closing brace on a line of its own. */
function lift(header: string): string {
  const start = SERVER.indexOf(`\n${header}`)
  assert.ok(start >= 0, `${header} exists in server.ts`)
  const end = SERVER.indexOf('\n}\n', start)
  assert.ok(end > start, `${header} ends on a bare closing brace`)
  return SERVER.slice(start + 1, end + 3)
}

/** A case of the tool switch, wrapped in a function of its own. */
function liftCase(name: string, next: string, fn: string): string {
  const start = SERVER.indexOf(`\n    case '${name}': {`)
  const end = SERVER.indexOf(`\n    case '${next}': {`, start)
  assert.ok(start > 0 && end > start, `the ${name} case exists`)
  return `async function ${fn}(rawArgs) {\n  switch ('${name}') {\n${SERVER.slice(start + 1, end)}\n  }\n}\n`
}

/** The socket's peer_conversation_closed handler, as a function of its own. */
function liftCloseHandler(): string {
  const on = SERVER.indexOf("realtimeSocket.on('peer_conversation_closed'")
  assert.ok(on > 0, 'the socket handles peer_conversation_closed')
  const arrow = '(payload: any) => {'
  const start = SERVER.indexOf(arrow, on)
  const end = SERVER.indexOf('\n  }))\n', start)
  assert.ok(start > on && end > start, 'the handler body is found')
  return `function onPeerConversationClosed(payload) {\n${SERVER.slice(start + arrow.length, end)}\n}\n`
}

/** The per chat memories built on createRefusedChats, whatever the fix names them. */
function refusalLedgers(): string[] {
  return [...SERVER.matchAll(/^const \w+ = createRefusedChats\([^\n]*\)$/gm)].map((m) => m[0])
}

type ToolResult = { content: Array<{ text: string }>; isError?: boolean }

interface Harness {
  /** The peer wrote in a side thread (an inbound, as the socket delivers it). */
  peerSays(chatId: string, conv: number, messageId: number, turnState?: string): void
  /** HOAI's idle sweep closed the conversation and the socket told the daemon. */
  timeoutClose(chatId: string): void
  /** The update stream's peer_closed for that conversation. */
  streamClose(chatId: string): void
  reply(chatId: string, text: string, extra?: Record<string, unknown>): Promise<ToolResult>
  sendToPeer(text: string, turnState?: string): Promise<ToolResult>
  logs: string[]
  closeNotices: number
}

function harness(backend: Backend): Harness {
  const source = [
    lift('class HttpError extends Error {'),
    lift('function httpStatusOf('),
    lift('function bgosCall<T>('),
    lift('async function bgosPost('),
    lift('function markConversationClosed('),
    lift('function rememberPeerConvChat('),
    lift('function notePeerConversationOpened('),
    lift('function recordInbound('),
    lift('function clearInbound('),
    ...refusalLedgers(),
    lift('function markPeerReplyClosed('),
    lift('function liftPeerReplyClosed('),
    liftCloseHandler(),
    liftCase('reply', 'propose_plan', 'replyTool'),
    liftCase('send_to_peer', 'complete_peer_thread', 'sendToPeerTool'),
  ].join('\n')
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText

  const logs: string[] = []
  let closeNotices = 0
  const pendingInbounds = new Map<string, unknown>()
  const closedPeerChats = new Set<string>()
  const peerConvByChat = new Map<string, string>()

  const recorder: unknown = new Proxy(function () {}, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : recorder),
    apply: () => undefined,
  })
  const known: Record<string, unknown> = {
    ...peerRefusal,
    ...peerClosedReply,
    // The close counter beside the closed-thread ledger (send_to_peer reads it).
    peerReplyCloseSeq: 0,
    peerReplyClosedAt: new Map<string, number>(),
    log: (line: string) => logs.push(line),
    // HTTP: the daemon's own client against the stub.
    boundedFetch,
    authHeaders,
    messagesCallerHeaders,
    errorBodyText,
    noteAuthOutcome: () => undefined,
    API_BASE: backend.url,
    AUTH: { mode: 'pairing', pairingToken: 'pair_test0000' },
    HTTP_TIMEOUT_MS: 5_000,
    ASSISTANT_ID: '947',
    USER_ID: 'user_kc',
    // Peer conversation bookkeeping.
    pendingInbounds,
    meetingChatIds: new Set<string>([MEETING_CHAT]),
    closedPeerChats,
    peerConvChats: new Map<string, string>(),
    peerConvByChat,
    CLOSED_PEER_CHATS_MAX: 500,
    a2aRouteRefusedChats: { has: () => false },
    updateDrainMode: false,
    noteMonitoredChat: () => undefined,
    inboundOwesReply,
    trackMessageOperation: (op: () => Promise<unknown>) => op(),
    mcp: {
      notification: async (n: { params: { meta?: { event_type?: string } } }) => {
        if (n.params.meta?.event_type === 'peer_conversation_closed') closeNotices++
      },
    },
    // The reply tool.
    resolveAuthorizedChat: (id: string) => ({ ok: true, chatId: id, sessionHandle: undefined }),
    meetingIdByChatId: new Map<string, number>([[MEETING_CHAT, MEETING_ID]]),
    protectBackslashesForMarkdown: (text: string) => text,
    recentButtonPrompts: new Map<string, unknown>(),
    // send_to_peer: the daemon's peer client, against the same stub.
    bgosPeerPost: async (path: string, body: Record<string, unknown>) => {
      const response = await fetch(`${backend.url}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`POST ${response.status}`)
      return response.json()
    },
  }
  const scope = new Proxy(known, {
    has: (target, key) => key in target || !(key in globalThis),
    get: (target, key) => (typeof key === 'symbol' ? undefined : key in target ? target[key] : recorder),
    set: (target, key, value) => {
      target[key as string] = value
      return true
    },
  })
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'scope',
    `with (scope) {\n${js}\nreturn { recordInbound, rememberPeerConvChat, markConversationClosed, onPeerConversationClosed, replyTool, sendToPeerTool }\n}`,
  )
  const lifted = factory(scope) as {
    recordInbound(chatId: string, messageId: number, turnState?: string, senderKind?: string | null): void
    rememberPeerConvChat(convId: string, chatId: string): void
    markConversationClosed(opts: { convId?: string; chatId?: string }): void
    onPeerConversationClosed(payload: Record<string, unknown>): void
    replyTool(args: Record<string, unknown>): Promise<ToolResult>
    sendToPeerTool(args: Record<string, unknown>): Promise<ToolResult>
  }

  return {
    peerSays: (chatId, conv, messageId, turnState = 'expecting_reply') => {
      // HOAI first: the peer's write opens, or revives, its conversation.
      backend.threads.set(chatId, { conv, open: turnState !== 'final' })
      // Then the daemon, exactly as each of its three inbound sites does it:
      // the reopen rule on a new conversation id, the association, the record.
      const convId = String(conv)
      if (closedPeerChats.has(chatId) && peerConvByChat.get(chatId) !== convId) closedPeerChats.delete(chatId)
      lifted.rememberPeerConvChat(convId, chatId)
      lifted.recordInbound(chatId, messageId, turnState, 'agent')
    },
    timeoutClose: (chatId) => {
      const thread = backend.threads.get(chatId)
      assert.ok(thread, `chat ${chatId} holds a conversation`)
      thread.open = false
      lifted.onPeerConversationClosed({
        event_type: 'peer_conversation_closed',
        conversation_id: String(thread.conv),
        closed_by_id: String(PEER),
        reason: 'timeout',
      })
    },
    streamClose: (chatId) => {
      const thread = backend.threads.get(chatId)
      assert.ok(thread, `chat ${chatId} holds a conversation`)
      thread.open = false
      lifted.markConversationClosed({ convId: String(thread.conv), chatId })
    },
    reply: (chatId, text, extra = {}) => lifted.replyTool({ chat_id: chatId, text, ...extra }),
    sendToPeer: (text, turnState) =>
      lifted.sendToPeerTool({
        target_assistant_id: PEER,
        parent_message_id: 501,
        text,
        ...(turnState ? { turn_state: turnState } : {}),
      }),
    logs,
    get closeNotices() {
      return closeNotices
    },
  }
}

// ── what every closed-thread reply must satisfy ───────────────────────────────

/**
 * Either the peer got it, or the result is an error that sends the agent to
 * send_to_peer and nothing was posted into the closed chat. Never a "Sent"
 * the peer cannot see.
 */
function assertErrorsOrReaches(backend: Backend, result: ToolResult, text: string, label: string): void {
  const said = result.content[0]?.text ?? ''
  if (backend.peerGot.some((m) => m.text === text)) return
  assert.equal(result.isError, true, `${label}: the peer never got "${text}", and the tool answered: ${said}`)
  assert.doesNotMatch(said, /^Sent\b/, `${label}: an error never reads as Sent`)
  assert.match(said, /\bsend_to_peer\b/, `${label}: the error names the tool that reaches the peer`)
}

function sendMessagePosts(backend: Backend, chatId: string): number {
  return backend.posts.filter((p) => p.route === 'POST /api/v1/send-message' && String(p.body.chatId) === chatId).length
}

/** A side thread the peer opened, its first message in, and the agent's answer delivered. */
async function talking(mode: Mode = 'saves-silently'): Promise<{ backend: Backend; h: Harness }> {
  const backend = await startBackend(mode)
  const h = harness(backend)
  h.peerSays(SIDE, CONV, 501)
  const first = await h.reply(SIDE, 'Here is the first answer.')
  assert.match(first.content[0]!.text, /^Sent \(message_id: \d+\)/, 'an open thread replies as always')
  assert.deepEqual(backend.peerGot.map((m) => m.text), ['Here is the first answer.'])
  return { backend, h }
}

// ── the bug: red on main ──────────────────────────────────────────────────────

test('case 1: after the conversation closes on timeout, a reply into its chat errors or reaches the peer, never a silent Sent', async () => {
  const { backend, h } = await talking()
  h.timeoutClose(SIDE)
  assert.equal(h.closeNotices, 1, 'the daemon was told, as on 10-27')
  const text = 'The migration ran clean, all 14 tables moved.'
  const result = await h.reply(SIDE, text)
  assertErrorsOrReaches(backend, result, text, 'after the timeout close')
  if (result.isError) {
    assert.equal(sendMessagePosts(backend, SIDE), 1, 'nothing was posted into the closed chat: only the first answer')
  }
})

test('case 2: two replies before the peer answered, both error or reach the peer', async () => {
  const { backend, h } = await talking()
  h.timeoutClose(SIDE)
  const texts = ['First follow up: the index is rebuilt.', 'Second follow up: the backfill is done too.']
  for (const text of texts) {
    assertErrorsOrReaches(backend, await h.reply(SIDE, text), text, text)
  }
  assert.equal(sendMessagePosts(backend, SIDE), 1, 'neither follow up was posted into the closed chat')
})

test('every close signal counts: a final message from the peer, the update stream, and the agent\'s own final send', async () => {
  for (const signal of ['final inbound', 'stream peer_closed', 'own final send_to_peer'] as const) {
    const backend = await startBackend()
    const h = harness(backend)
    if (signal === 'own final send_to_peer') {
      backend.nextSideThread = SIDE
      await h.sendToPeer('Done on my side, closing this.', 'final')
    } else {
      h.peerSays(SIDE, CONV, 501)
      if (signal === 'final inbound') h.peerSays(SIDE, CONV, 502, 'final')
      else h.streamClose(SIDE)
    }
    const text = `One more thing (${signal}).`
    const result = await h.reply(SIDE, text)
    assertErrorsOrReaches(backend, result, text, signal)
    assert.equal(sendMessagePosts(backend, SIDE), 0, `${signal}: nothing posted into the closed chat`)
  }
})

// ── no false refusals: a thread that is live again takes replies ─────────────

test('the peer writing again in the same conversation (HOAI revived it) lifts the refusal', async () => {
  const { backend, h } = await talking()
  h.timeoutClose(SIDE)
  assert.equal((await h.reply(SIDE, 'refused while closed')).isError, true)
  h.peerSays(SIDE, CONV, 503)
  const result = await h.reply(SIDE, 'Answering your new question.')
  assert.match(result.content[0]!.text, /^Sent \(message_id: \d+\)/)
  assert.ok(backend.peerGot.some((m) => m.text === 'Answering your new question.'), 'the peer got it')
})

test('a new conversation opening in that chat lifts the refusal', async () => {
  const { backend, h } = await talking()
  h.timeoutClose(SIDE)
  h.peerSays(SIDE, CONV + 5, 504)
  const result = await h.reply(SIDE, 'Picking up the new thread.')
  assert.match(result.content[0]!.text, /^Sent \(message_id: \d+\)/)
  assert.ok(backend.peerGot.some((m) => m.text === 'Picking up the new thread.'))
})

test('the agent\'s own send_to_peer that lands in that chat lifts the refusal', async () => {
  const { backend, h } = await talking()
  h.timeoutClose(SIDE)
  backend.nextSideThread = SIDE
  await h.sendToPeer('Reopening: one more question.')
  const result = await h.reply(SIDE, 'And the detail you asked for.')
  assert.match(result.content[0]!.text, /^Sent \(message_id: \d+\)/)
  assert.ok(backend.peerGot.some((m) => m.text === 'And the detail you asked for.'))
})

test('a final message after a revive closes the chat again', async () => {
  const { backend, h } = await talking()
  h.timeoutClose(SIDE)
  h.peerSays(SIDE, CONV, 503)
  h.peerSays(SIDE, CONV, 504, 'final')
  const text = 'Thanks, that covers it.'
  assertErrorsOrReaches(backend, await h.reply(SIDE, text), text, 'final after a revive')
})

// ── the close that lands while the reply is on the wire ──────────────────────

test('a close that lands while the reply is on the wire is never a silent Sent', async () => {
  const { backend, h } = await talking()
  const text = 'Sent just as the thread timed out.'
  backend.onSendMessage = () => {
    backend.onSendMessage = undefined
    h.timeoutClose(SIDE)
  }
  const result = await h.reply(SIDE, text)
  const said = result.content[0]!.text
  if (backend.peerGot.some((m) => m.text === text)) return
  assert.ok(
    result.isError === true || /\bsend_to_peer\b/.test(said),
    `the peer never got it, and the tool answered: ${said}`,
  )
})

test('a send_to_peer HOAI read as the closing turn keeps the thread closed, though turn_state was not final (review 1)', async () => {
  const { backend, h } = await talking()
  // A closing phrase: HOAI closes the conversation and tells the socket
  // before it answers the send, and the answer says final.
  backend.nextSideThread = SIDE
  backend.peerSendCloses = true
  backend.onPeerSend = () => h.timeoutClose(SIDE)
  await h.sendToPeer('Thanks, wrapping up here.')
  const text = 'One last detail.'
  assertErrorsOrReaches(backend, await h.reply(SIDE, text), text, 'after a closing send_to_peer')
  assert.equal(sendMessagePosts(backend, SIDE), 1, 'only the first answer was posted')
})

test('a send_to_peer HOAI read as the closing turn keeps the thread closed when its close event never arrives (review 1)', async () => {
  const { backend, h } = await talking()
  // The socket was down for the close event: the send's own answer is the
  // only word that the conversation is over.
  backend.nextSideThread = SIDE
  backend.peerSendCloses = true
  await h.sendToPeer('Thanks, wrapping up here.')
  const text = 'One last detail.'
  assertErrorsOrReaches(backend, await h.reply(SIDE, text), text, 'after a closing send_to_peer with no close event')
  assert.equal(sendMessagePosts(backend, SIDE), 1, 'only the first answer was posted')
})

test('a close that lands while a send_to_peer is on the wire is not undone by its answer (review 1)', async () => {
  const { backend, h } = await talking()
  backend.nextSideThread = SIDE
  // wait_for_reply: the peer answers with its final turn before the send returns.
  backend.onPeerSend = () => h.peerSays(SIDE, CONV, 777, 'final')
  await h.sendToPeer('One more question, then I am done.')
  const text = 'Following up on your final answer.'
  assertErrorsOrReaches(backend, await h.reply(SIDE, text), text, 'after a close during send_to_peer')
  assert.equal(sendMessagePosts(backend, SIDE), 1, 'only the first answer was posted')
})

test('a reply with a file into a closed thread is refused before any upload (review 10)', async () => {
  const { backend, h } = await talking()
  h.timeoutClose(SIDE)
  const result = await h.reply(SIDE, 'The report is attached.', { files: ['E:\\no\\such\\report.pdf'] })
  assert.equal(result.isError, true)
  assert.match(result.content[0]!.text, /has ended/, 'the closed-thread refusal, not a file error')
  assert.equal(backend.posts.length, 1, 'nothing after the first answer reached HOAI')
})

test('the refusal says only what the daemon knows, in plain words (review 4)', async () => {
  const { h } = await talking()
  h.timeoutClose(SIDE)
  const said = (await h.reply(SIDE, 'Still there?')).content[0]!.text
  assert.doesNotMatch(said, /would not get/, 'HOAI may revive a timed out conversation, so this is not certain')
  assert.match(said, /may never reach the other agent/)
  assert.match(said, /Nothing was posted/)
  assert.match(said, /send_to_peer, which starts a new conversation/)
})

// ── with the backend half deployed (peerDelivery) ─────────────────────────────

test('backend half: a reply HOAI says it did not forward is an error naming send_to_peer, and the next is answered here', async () => {
  const { backend, h } = await talking('reports')
  // A close this daemon never heard of (its socket was down, no stream).
  backend.threads.get(SIDE)!.open = false
  const text = 'Did this one land?'
  const result = await h.reply(SIDE, text)
  assertErrorsOrReaches(backend, result, text, 'not forwarded')
  const again = await h.reply(SIDE, 'And this one?')
  assertErrorsOrReaches(backend, again, 'And this one?', 'after a not forwarded answer')
  assert.equal(sendMessagePosts(backend, SIDE), 2, 'the second is answered locally, not posted')
})

test('backend half: a reply HOAI says it forwarded is a plain Sent', async () => {
  const { backend, h } = await talking('reports')
  const result = await h.reply(SIDE, 'Forwarded as usual.')
  assert.equal(result.isError, undefined)
  assert.match(result.content[0]!.text, /^Sent \(message_id: \d+\)$/)
  assert.ok(backend.peerGot.some((m) => m.text === 'Forwarded as usual.'))
})

for (const reason of ['bridge_failed', 'not_participant', 'cross_account_refused']) {
  test(`backend half: ${reason} fails that one reply, says it was not passed on, and the next reply posts (review 2)`, async () => {
    const { backend, h } = await talking('reports')
    backend.nextDelivery = { state: 'not_forwarded', reason }
    const result = await h.reply(SIDE, 'Did this one land?')
    const said = result.content[0]!.text
    assert.equal(result.isError, true)
    assert.doesNotMatch(said, /^Sent\b/)
    assert.doesNotMatch(said, /has ended/, 'the conversation is still open, so the error does not say it ended')
    assert.match(said, /did not pass it on to the other agent/)
    assert.match(said, /\bsend_to_peer\b/)
    const next = await h.reply(SIDE, 'And this one?')
    assert.match(next.content[0]!.text, /^Sent \(message_id: \d+\)$/, 'the open thread is not refused here')
    assert.ok(backend.peerGot.some((m) => m.text === 'And this one?'))
  })
}

// Each reason that has a remedy of its own says it (second review): an agent
// that is not connected, a paused or removed contact link (send_to_peer is
// refused there too), and files to an agent of another account (send_to_peer
// carries no files).
for (const [reason, says, remedy] of [
  ['peer_offline', /the other agent is not connected right now/, /\bsend_to_peer\b/],
  ['contact_link_inactive', /connection with that agent's owner is paused or was removed/, null],
  ['external_files_unsupported', /files cannot go to an agent of another account/, /send the words with send_to_peer.*as a link/],
] as const) {
  test(`backend half: ${reason} says why in plain words, offers only a remedy that works, and the next reply posts (review 2 of the fixes)`, async () => {
    const { backend, h } = await talking('reports')
    backend.nextDelivery = { state: 'not_forwarded', reason }
    const result = await h.reply(SIDE, 'Did this one land?')
    const said = result.content[0]!.text
    assert.equal(result.isError, true)
    assert.match(said, /^Not delivered: /)
    assert.match(said, says)
    assert.doesNotMatch(said, /has ended|starts a new conversation/)
    if (remedy) assert.match(said, remedy)
    else assert.doesNotMatch(said, /\bsend_to_peer\b/, 'send_to_peer is refused while the link is not active')
    const next = await h.reply(SIDE, 'And this one?')
    assert.match(next.content[0]!.text, /^Sent \(message_id: \d+\)$/, 'HOAI answers each reply; nothing is refused here')
  })
}

for (const reason of ['conversation_not_open', 'no_conversation']) {
  test(`backend half: ${reason} means the conversation is over, and the next reply is refused here (review 2)`, async () => {
    const { backend, h } = await talking('reports')
    backend.nextDelivery = { state: 'not_forwarded', reason }
    const result = await h.reply(SIDE, 'Did this one land?')
    assert.equal(result.isError, true)
    assert.match(result.content[0]!.text, /has ended/)
    assert.match(result.content[0]!.text, /send_to_peer, which starts a new conversation/)
    const next = await h.reply(SIDE, 'And this one?')
    assert.equal(next.isError, true)
    assert.equal(sendMessagePosts(backend, SIDE), 2, 'the second is answered locally, not posted')
  })
}

test('backend half: HOAI revived the thread on the write and forwarded it, though a close landed mid send: plain Sent, and the next reply posts (review 6)', async () => {
  const { backend, h } = await talking('reports')
  backend.revivesOnWrite = true
  backend.onSendMessage = () => {
    backend.onSendMessage = undefined
    h.timeoutClose(SIDE)
  }
  const result = await h.reply(SIDE, 'Sent as the thread timed out.')
  assert.match(result.content[0]!.text, /^Sent \(message_id: \d+\)$/, 'HOAI said forwarded, so no note')
  const next = await h.reply(SIDE, 'And a follow up.')
  assert.match(next.content[0]!.text, /^Sent \(message_id: \d+\)$/, 'HOAI holds the thread open again')
  assert.ok(backend.peerGot.some((m) => m.text === 'And a follow up.'))
})

test('backend half: a conversation a forwarded reply revived, closed again by its id alone, is refused here (review 2 of the fixes)', async () => {
  const { backend, h } = await talking('reports')
  backend.revivesOnWrite = true
  backend.onSendMessage = () => {
    backend.onSendMessage = undefined
    h.timeoutClose(SIDE)
  }
  const first = await h.reply(SIDE, 'Sent as the thread timed out.')
  assert.match(first.content[0]!.text, /^Sent \(message_id: \d+\)$/)
  // The revived conversation times out again; the socket event names only
  // the conversation id.
  backend.revivesOnWrite = false
  h.timeoutClose(SIDE)
  const posted = sendMessagePosts(backend, SIDE)
  const next = await h.reply(SIDE, 'After the second timeout.')
  assert.equal(next.isError, true)
  assert.match(next.content[0]!.text, /has ended/)
  assert.equal(sendMessagePosts(backend, SIDE), posted, 'refused here, not posted')
})

test('peerDelivery is read narrowly: only the two exact states count, anything else is no word at all', async () => {
  const { peerDeliveryOf, peerDeliveryReason } = (await import('../lib/peer-closed-reply.ts')) as {
    peerDeliveryOf(answer: unknown): string | null
    peerDeliveryReason(answer: unknown): string
  }
  const cases: Array<[unknown, string | null]> = [
    [{ message: { id: 1 }, peerDelivery: { state: 'not_forwarded', reason: 'conversation_not_open' } }, 'not_forwarded'],
    [{ message: { id: 1 }, peerDelivery: { state: 'forwarded' } }, 'forwarded'],
    [{ message: { id: 1 } }, null],
    [{ message: { id: 1 }, peerDelivery: { state: 'NOT_FORWARDED' } }, null],
    [{ message: { id: 1 }, peerDelivery: { state: 'queued' } }, null],
    [{ message: { id: 1 }, peerDelivery: { state: true } }, null],
    [{ message: { id: 1 }, peerDelivery: 'not_forwarded' }, null],
    [{ message: { id: 1 }, peerDelivery: null }, null],
    [null, null],
    ['not_forwarded', null],
  ]
  for (const [answer, want] of cases) assert.equal(peerDeliveryOf(answer), want, JSON.stringify(answer))
  assert.equal(peerDeliveryReason({ peerDelivery: { reason: 'conversation_not_open' } }), 'conversation_not_open')
  assert.equal(peerDeliveryReason({ peerDelivery: { reason: 'Refusing A2A row 9 <b>' } }), 'no reason given')
  assert.equal(peerDeliveryReason({ peerDelivery: {} }), 'no reason given')
})

test('no tool text tells the agent that a reply reopens a closed side conversation', () => {
  const at = SERVER.indexOf("name: 'list_chats',")
  assert.ok(at > 0, 'list_chats is declared')
  const listChats = SERVER.slice(at, SERVER.indexOf('inputSchema', at))
  assert.doesNotMatch(listChats, /re-opened automatically when you\s*'\s*\+\s*'reply into it|reply into it \(send_to_peer \/ reply\)/)
  assert.match(listChats, /send_to_peer/)
  assert.match(listChats, /not with reply/)
})

// ── every other reply path, on the wire ──────────────────────────────────────

test('unchanged: the owner chat', async () => {
  const backend = await startBackend()
  const h = harness(backend)
  const result = await h.reply(MAIN, 'Morning, the report is ready.')
  assert.equal(result.isError, undefined)
  assert.match(result.content[0]!.text, /^Sent \(message_id: \d+\)/)
  assert.equal(backend.posts.length, 1)
  assert.equal(backend.posts[0]!.route, 'POST /api/v1/send-message')
  assert.equal(backend.posts[0]!.body.chatId, Number(MAIN))
  assert.equal(backend.posts[0]!.body.text, 'Morning, the report is ready.')
})

test('unchanged: a meeting reply goes to the meeting route', async () => {
  const backend = await startBackend()
  const h = harness(backend)
  const result = await h.reply(MEETING_CHAT, 'My turn: the numbers are in.')
  assert.equal(result.isError, undefined)
  assert.equal(backend.posts.length, 1)
  assert.equal(backend.posts[0]!.route, `POST /api/v1/meetings/${MEETING_ID}/messages`)
  assert.equal(backend.posts[0]!.body.text, 'My turn: the numbers are in.')
  assert.equal(backend.posts[0]!.body.asAssistantId, 947)
})

test('unchanged: an open side thread', async () => {
  const backend = await startBackend()
  const h = harness(backend)
  h.peerSays(SIDE, CONV, 501)
  const result = await h.reply(SIDE, 'Answer in an open thread.')
  assert.equal(result.isError, undefined)
  assert.match(result.content[0]!.text, /^Sent \(message_id: \d+\)$/)
  assert.equal(sendMessagePosts(backend, SIDE), 1)
  assert.deepEqual(backend.peerGot, [{ chatId: SIDE, text: 'Answer in an open thread.' }])
})

test('unchanged: a side thread answer with reply_to_id', async () => {
  const backend = await startBackend()
  const h = harness(backend)
  h.peerSays(SIDE, CONV, 501)
  const result = await h.reply(SIDE, 'Answering exactly that question.', { reply_to_id: 501 })
  assert.equal(result.isError, undefined)
  assert.match(result.content[0]!.text, /^Sent \(message_id: \d+\)$/)
  assert.equal(backend.posts[0]!.body.replyToId, 501)
  assert.deepEqual(backend.peerGot, [{ chatId: SIDE, text: 'Answering exactly that question.', replyToId: 501 }])
})

test('a close in one side thread leaves another open side thread alone', async () => {
  const { backend, h } = await talking()
  h.peerSays(SIDE_B, CONV + 9, 601)
  h.timeoutClose(SIDE)
  const result = await h.reply(SIDE_B, 'The other thread is still live.')
  assert.match(result.content[0]!.text, /^Sent \(message_id: \d+\)$/)
  assert.ok(backend.peerGot.some((m) => m.text === 'The other thread is still live.'))
})
