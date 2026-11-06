/**
 * Run the real reply dispatch, HTTP client, conversation bookkeeping and close
 * handler against a local backend and an independently recorded peer inbox.
 * A saved reply must never become Sent without a confirmed peer handoff.
 * Covers timeout, completed, final inbound, stream close, repeated replies,
 * missing delivery reports, and the backend's reopen-on-write contract.
 *
 * Run: node --import tsx --test --test-concurrency=4 test/peer-closed-reply.test.ts
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

import * as peerClosedReply from '../lib/peer-closed-reply.ts'

const SERVER = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const SIDE = '33017'
const SIDE_B = '33018'
const MAIN = '33001'
const MEETING_CHAT = '33050'
const MEETING_ID = 12
// Synthetic assistant identities used only by this local fixture.
const SELF = 700_001
const PEER = 700_002
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
  nextDelivery?: unknown
  reportConversationId?: boolean
  sendStatus?: number
  sendErrorCode?: string
  /** HOAI revives a closed conversation on a participant's write, and forwards (Kc's rule, BGOS #1265). */
  revivesOnWrite?: boolean
  count(route: string): number
}

const servers: Server[] = []
after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
})

async function startBackend(mode: Mode = 'reports'): Promise<Backend> {
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
        if (backend.sendStatus) return send(backend.sendStatus, { message: backend.sendErrorCode ?? 'fixture send failed', code: backend.sendErrorCode })
        const chatId = String(body.chatId)
        const thread = backend.threads.get(chatId)
        if (!thread) return send(201, { message: { id, chatId: Number(chatId) } })
        const message = { id, chatId: Number(chatId), ...(backend.reportConversationId ? { peerConversationId: thread.conv } : {}) }
        const overridesDelivery = 'nextDelivery' in backend
        const delivery = backend.nextDelivery
        delete backend.nextDelivery
        if (overridesDelivery && backend.mode === 'reports') {
          if ((delivery as { state?: unknown } | null)?.state === 'forwarded') {
            backend.peerGot.push({ chatId, text: String(body.text) })
          }
          return send(201, { message, peerDelivery: delivery })
        }
        if (!thread.open && backend.revivesOnWrite) thread.open = true
        if (thread.open) {
          backend.peerGot.push({
            chatId,
            text: String(body.text),
            ...(typeof body.replyToId === 'number' ? { replyToId: body.replyToId } : {}),
          })
          return send(201, {
            message,
            ...(backend.mode === 'reports' ? { peerDelivery: { state: 'forwarded' } } : {}),
          })
        }
        // A closed conversation: saved, answered 201, and nothing forwarded.
        return send(201, {
          message,
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
        const final = body.turnState === 'final'
        backend.threads.set(chatId, { conv, open: !final })
        backend.peerGot.push({ chatId, text: String(body.text) })
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
  timeoutClose(chatId: string, reason?: 'timeout' | 'completed'): void
  /** The update stream's peer_closed for that conversation. */
  streamClose(chatId: string): void
  reply(chatId: string, text: string, extra?: Record<string, unknown>): Promise<ToolResult>
  /** The inbound the overdue sweep holds this agent to answer in that chat, if any. */
  owed(chatId: string): number | undefined
  sendToPeer(text: string, turnState?: string): Promise<ToolResult>
  logs: string[]
  closeNotices: number
  discoverSideThread(chatId: string, kind?: 'a2a' | 'main' | 'group' | null): Promise<void>
}

interface HarnessOptions {
  mainChats?: string[]
  groupChats?: string[]
  peerChats?: string[]
  sideChats?: string[]
  closedChats?: string[]
  sessionHandle?: string
  fileError?: boolean
}

function harness(backend: Backend, opts: HarnessOptions = {}): Harness {
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
    lift('async function discoverChats('),
    lift('function resolveAuthorizedChat('),
    lift('function noteMonitoredChat('),
    ...refusalLedgers(),
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
  const closedPeerChats = new Set<string>(opts.closedChats)
  const peerConvByChat = new Map((opts.peerChats ?? []).map((id) => [id, String(CONV)]))
  const monitoredChatSet = new Set([MAIN, MEETING_CHAT, SIDE_B])
  let inboxKind: 'a2a' | 'main' | 'group' | null = 'a2a'

  const recorder: unknown = new Proxy(function () {}, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : recorder),
    apply: () => undefined,
  })
  const known: Record<string, unknown> = {
    ...peerRefusal,
    ...peerClosedReply,
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
    ASSISTANT_ID: String(SELF),
    USER_ID: 'fixture_owner',
    // Peer conversation bookkeeping.
    pendingInbounds,
    meetingChatIds: new Set<string>([MEETING_CHAT]),
    closedPeerChats,
    peerConvChats: new Map<string, string>(),
    peerConvByChat,
    peerSideThreadChats: new Set<string>(opts.sideChats),
    mainChatIds: opts.mainChats ?? [MAIN],
    groupChatIds: new Set<string>(opts.groupChats),
    chatFirstListedAtMs: new Map<string, number>(),
    monitoredChatSet,
    knownSessionHandles: new Set<string>(opts.sessionHandle ? [opts.sessionHandle] : []),
    sessionHandleByChat: new Map<string, string>(opts.sessionHandle ? [[SIDE_B, opts.sessionHandle]] : []),
    chatOwnership: { noteRow: () => undefined },
    bgosPeerGet: async () => ({ chats: [...backend.threads.keys()].map((id) => ({ id: Number(id), assistantId: SELF, ...(inboxKind === null ? {} : { kind: inboxKind }) })) }),
    CLOSED_PEER_CHATS_MAX: 500,
    a2aRouteRefusedChats: { has: () => false },
    updateDrainMode: false,
    inboundOwesReply,
    trackMessageOperation: (op: () => Promise<unknown>) => op(),
    mcp: {
      notification: async (n: { params: { meta?: { event_type?: string } } }) => {
        if (n.params.meta?.event_type === 'peer_conversation_closed') closeNotices++
      },
    },
    // The reply tool.
    meetingIdByChatId: new Map<string, number>([[MEETING_CHAT, MEETING_ID]]),
    protectBackslashesForMarkdown: (text: string) => text,
    // A file the agent attaches, as the daemon resolves one.
    resolveFile: async (spec: string) => {
      if (opts.fileError) throw new Error('fixture upload failed')
      return {
        fileName: String(spec).split(/[\\/]/).pop(),
        fileMimeType: 'application/pdf',
        fileUrl: 'data:application/pdf;base64,JVBERi0=',
      }
    },
    getFileCategory: () => 'document',
    recentButtonPrompts: new Map<string, unknown>(),
    replyCardNudges: { forReply: () => null },
    decisionCount: () => 0,
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
    `with (scope) {\n${js}\nreturn { recordInbound, rememberPeerConvChat, markConversationClosed, onPeerConversationClosed, replyTool, sendToPeerTool, discoverChats }\n}`,
  )
  const lifted = factory(scope) as {
    recordInbound(chatId: string, messageId: number, turnState?: string, senderKind?: string | null): void
    rememberPeerConvChat(convId: string, chatId: string): void
    markConversationClosed(opts: { convId?: string; chatId?: string }): void
    onPeerConversationClosed(payload: Record<string, unknown>): void
    replyTool(args: Record<string, unknown>): Promise<ToolResult>
    sendToPeerTool(args: Record<string, unknown>): Promise<ToolResult>
    discoverChats(): Promise<void>
  }

  return {
    discoverSideThread: async (chatId, kind = 'a2a') => {
      inboxKind = kind
      backend.threads.set(chatId, { conv: CONV, open: false })
      await lifted.discoverChats()
    },
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
    timeoutClose: (chatId, reason = 'timeout') => {
      const thread = backend.threads.get(chatId)
      assert.ok(thread, `chat ${chatId} holds a conversation`)
      thread.open = false
      lifted.onPeerConversationClosed({
        event_type: 'peer_conversation_closed',
        conversation_id: String(thread.conv),
        closed_by_id: String(PEER),
        reason,
      })
    },
    streamClose: (chatId) => {
      const thread = backend.threads.get(chatId)
      assert.ok(thread, `chat ${chatId} holds a conversation`)
      thread.open = false
      lifted.markConversationClosed({ convId: String(thread.conv), chatId })
    },
    reply: (chatId, text, extra = {}) => lifted.replyTool({ chat_id: chatId, text, ...extra }),
    owed: (chatId) => (pendingInbounds.get(chatId) as { messageId?: number } | undefined)?.messageId,
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

// ── helpers ──────────────────────────────────────────────────────────────────

function sendMessagePosts(backend: Backend, chatId: string): number {
  return backend.posts.filter((p) => p.route === 'POST /api/v1/send-message' && String(p.body.chatId) === chatId).length
}

/** A side thread the peer opened, its first message in, and the agent's answer delivered. */
async function talking(mode: Mode = 'reports'): Promise<{ backend: Backend; h: Harness }> {
  const backend = await startBackend(mode)
  const h = harness(backend)
  h.peerSays(SIDE, CONV, 501)
  const first = await h.reply(SIDE, 'Here is the first answer.')
  if (mode === 'reports') assert.match(first.content[0]!.text, /^Sent \(message_id: \d+\)/)
  else assert.equal(first.isError, true, 'an unreported handoff cannot claim Sent even when the peer got it')
  assert.deepEqual(backend.peerGot.map((m) => m.text), ['Here is the first answer.'])
  return { backend, h }
}

type CloseSignal = 'socket timeout close' | 'stream peer_closed' | 'final inbound' | "agent's own final send_to_peer"
const CLOSE_SIGNALS: CloseSignal[] = [
  'socket timeout close',
  'stream peer_closed',
  'final inbound',
  "agent's own final send_to_peer",
]

/** Close the conversation in SIDE by one of the four signals the daemon hears. */
async function close(backend: Backend, h: Harness, signal: CloseSignal): Promise<void> {
  if (signal === 'socket timeout close') h.timeoutClose(SIDE)
  else if (signal === 'stream peer_closed') h.streamClose(SIDE)
  else if (signal === 'final inbound') h.peerSays(SIDE, CONV, 502, 'final')
  else {
    backend.nextSideThread = SIDE
    await h.sendToPeer('Done on my side, closing this.', 'final')
  }
  assert.equal(backend.threads.get(SIDE)?.open, false, `${signal}: HOAI holds the conversation closed`)
}

/** HOAI's word, when it gives one, is never a Sent the peer did not get. */
function assertNotForwardedIsAnError(result: ToolResult, label: string): string {
  const said = result.content[0]?.text ?? ''
  assert.equal(result.isError, true, `${label}: the tool answered: ${said}`)
  assert.doesNotMatch(said, /^Sent\b/, `${label}: an error never reads as Sent`)
  assert.match(said, /^Not delivered: HOAI saved this reply/, `${label}: plain words, what happened first`)
  return said
}

// Missing delivery reports must never hide a reply the peer did not receive.
for (const reason of ['timeout', 'completed'] as const) {
  test(`missing delivery report after ${reason}: error names send_to_peer, never Sent`, async () => {
    const { backend, h } = await talking('reports')
    backend.mode = 'saves-silently'
    h.timeoutClose(SIDE, reason)
    const text = `Follow up after ${reason}.`
    const result = await h.reply(SIDE, text)
    assert.equal(result.isError, true, result.content[0]?.text)
    assert.doesNotMatch(result.content[0]!.text, /^Sent\b/)
    assert.match(result.content[0]!.text, /not confirm.*other agent/)
    assert.match(result.content[0]!.text, /send_to_peer/)
    assert.equal(sendMessagePosts(backend, SIDE), 2, 'the backend can still revive a closed thread')
    assert.ok(!backend.peerGot.some((m) => m.text === text), 'the peer received nothing')
  })
}

test('missing delivery report: a second reply before the peer answers also fails loudly', async () => {
  const { backend, h } = await talking('reports')
  backend.mode = 'saves-silently'
  h.timeoutClose(SIDE)
  const texts = ['First follow up.', 'Second follow up before an answer.']
  const results = []
  for (const text of texts) results.push(await h.reply(SIDE, text))
  for (const result of results) {
    assert.equal(result.isError, true, result.content[0]?.text)
    assert.doesNotMatch(result.content[0]!.text, /^Sent\b/)
    assert.match(result.content[0]!.text, /send_to_peer/)
  }
  assert.equal(sendMessagePosts(backend, SIDE), 3)
  assert.deepEqual(backend.peerGot.map((m) => m.text), ['Here is the first answer.'])
})

test('a side thread opened by send_to_peer needs confirmation before any peer answered', async () => {
  const backend = await startBackend('saves-silently')
  const h = harness(backend)
  backend.nextSideThread = SIDE_B
  await h.sendToPeer('Initial question.')
  h.timeoutClose(SIDE_B)
  const result = await h.reply(SIDE_B, 'Follow up before an answer.')
  assert.equal(result.isError, true, result.content[0]?.text)
  assert.match(result.content[0]!.text, /Delivery unconfirmed:.*send_to_peer/)
  assert.deepEqual(backend.peerGot.map((m) => m.text), ['Initial question.'])
})

test('a discovered side thread needs confirmation after restart without a conversation mapping', async () => {
  const backend = await startBackend('saves-silently')
  const h = harness(backend)
  await h.discoverSideThread(SIDE)
  const result = await h.reply(SIDE, 'Follow up after restart.')
  assert.equal(result.isError, true, result.content[0]?.text)
  assert.match(result.content[0]!.text, /Delivery unconfirmed:.*send_to_peer/)
  assert.deepEqual(backend.peerGot, [])
})

for (const kind of [null, 'a2a'] as const) {
  test(`restart discovery with ${kind ?? 'omitted'} kind: both consecutive replies need confirmation`, async () => {
    const backend = await startBackend('saves-silently')
    const h = harness(backend)
    const unauthorized = await h.reply(SIDE, 'Not discovered yet.')
    assert.equal(unauthorized.isError, true)
    assert.match(unauthorized.content[0]!.text, /not one this assistant is a participant of/)
    assert.equal(backend.posts.length, 0)
    await h.discoverSideThread(SIDE, kind)
    const results = []
    for (const text of ['First reply after restart.', 'Second reply before an answer.']) {
      results.push(await h.reply(SIDE, text))
    }
    assert.equal(sendMessagePosts(backend, SIDE), 2, 'discovery authorized both writes')
    assert.deepEqual(backend.peerGot, [], 'neither saved reply reached the peer')
    assert.deepEqual(results.map((r) => r.isError), [true, true], JSON.stringify(results))
    for (const result of results) {
      assert.equal(result.isError, true, result.content[0]?.text)
      assert.doesNotMatch(result.content[0]!.text, /^Sent\b/)
      assert.match(result.content[0]!.text, /^Delivery unconfirmed:.*send_to_peer/)
    }
  })
}

test('a returned peer conversation id needs confirmation even without local thread knowledge', async () => {
  const backend = await startBackend('saves-silently')
  backend.threads.set(SIDE_B, { conv: CONV, open: false })
  backend.reportConversationId = true
  const result = await harness(backend).reply(SIDE_B, 'Follow up with only a persisted conversation id.')
  assert.equal(result.isError, true, result.content[0]?.text)
  assert.match(result.content[0]!.text, /Delivery unconfirmed:.*send_to_peer/)
  assert.deepEqual(backend.peerGot, [])
})

for (const report of [undefined, null, {}, { state: 'queued' }, { state: 'FORWARDED' }, { state: true }, 'forwarded']) {
  test(`an unusable delivery report ${JSON.stringify(report)} cannot claim Sent`, async () => {
    const { backend, h } = await talking()
    backend.nextDelivery = report
    const result = await h.reply(SIDE, 'Do not assume this was forwarded.')
    assert.equal(result.isError, true, result.content[0]?.text)
    assert.match(result.content[0]!.text, /Delivery unconfirmed:.*send_to_peer/)
    assert.deepEqual(backend.peerGot.map((m) => m.text), ['Here is the first answer.'])
  })
}

test('an unconfirmed handoff with files offers a remedy that preserves the files', async () => {
  const { backend, h } = await talking()
  backend.mode = 'saves-silently'
  h.timeoutClose(SIDE)
  const result = await h.reply(SIDE, 'Attached report.', { files: [{ url: 'data:application/pdf;base64,JVBERi0=' }] })
  assert.equal(result.isError, true, result.content[0]?.text)
  assert.match(result.content[0]!.text, /send the words with send_to_peer and share the files as a link/)
  assert.match(result.content[0]!.text, /send_to_peer carries no files/)
  assert.equal(sendMessagePosts(backend, SIDE), 2)
})

test('an unconfirmed handoff clears only the inbound it answered', async () => {
  for (const newerInbound of [false, true]) {
    const { backend, h } = await talking()
    h.peerSays(SIDE, CONV, 502)
    backend.nextDelivery = null
    if (newerInbound) backend.onSendMessage = () => h.peerSays(SIDE, CONV, 503)
    const result = await h.reply(SIDE, 'Answer to the tracked question.')
    assert.equal(result.isError, true, result.content[0]?.text)
    assert.equal(h.owed(SIDE), newerInbound ? 503 : undefined)
  }
})

// Each way the reply handler can recognize (or fail to recognize) a side thread
// runs through every delivery verdict. The peer recorder is separate from the tool.
const SIDE_IDENTITIES: Array<{ name: string; options?: HarnessOptions; discovered?: 'a2a' | null; returnedId?: boolean; handle?: string }> = [
  { name: 'authorized without kind or peer memory' },
  { name: 'restart inbox omits kind', discovered: null },
  { name: 'restart inbox identifies a2a', discovered: 'a2a' },
  { name: 'conversation mapping only', options: { peerChats: [SIDE_B] } },
  { name: 'closed marker only', options: { closedChats: [SIDE_B] } },
  { name: 'side classification only', options: { sideChats: [SIDE_B] } },
  { name: 'returned conversation id only', returnedId: true },
  { name: 'opaque authorized handle without kind', handle: 'fixture_session' },
  { name: 'peer mapping overrides main classification', options: { peerChats: [SIDE_B], mainChats: [SIDE_B] } },
  { name: 'side classification overrides group classification', options: { sideChats: [SIDE_B], groupChats: [SIDE_B] } },
]
const DELIVERY_VERDICTS = [
  { name: 'missing', report: undefined, prefix: /^Delivery unconfirmed:/ },
  { name: 'null', report: null, prefix: /^Delivery unconfirmed:/ },
  { name: 'empty', report: {}, prefix: /^Delivery unconfirmed:/ },
  { name: 'unknown', report: { state: 'queued' }, prefix: /^Delivery unconfirmed:/ },
  { name: 'malformed', report: 'forwarded', prefix: /^Delivery unconfirmed:/ },
  { name: 'ended', report: { state: 'not_forwarded', reason: 'conversation_not_open' }, prefix: /^Not delivered:.*has ended/ },
  { name: 'not passed on', report: { state: 'not_forwarded', reason: 'peer_offline' }, prefix: /^Not delivered:.*not connected/ },
  { name: 'forwarded', report: { state: 'forwarded' }, prefix: /^Sent \(message_id: \d+\)$/ },
]
for (const identity of SIDE_IDENTITIES) {
  for (const verdict of DELIVERY_VERDICTS) {
    test(`side reply path table: ${identity.name} / ${verdict.name}`, async () => {
      const backend = await startBackend('reports')
      const h = harness(backend, { ...identity.options, sessionHandle: identity.handle })
      const discovered = 'discovered' in identity
      const chatId = discovered ? SIDE : SIDE_B
      if (discovered) await h.discoverSideThread(chatId, identity.discovered)
      else backend.threads.set(chatId, { conv: CONV, open: false })
      backend.reportConversationId = identity.returnedId
      const texts = ['First table reply.', 'Consecutive table reply before an answer.']
      for (const text of texts) {
        backend.nextDelivery = verdict.report
        const result = await h.reply(identity.handle ?? chatId, text)
        assert.match(result.content[0]!.text, verdict.prefix)
        assert.equal(result.isError, verdict.name === 'forwarded' ? undefined : true)
      }
      assert.equal(sendMessagePosts(backend, chatId), 2)
      assert.deepEqual(backend.peerGot.map((m) => m.text), verdict.name === 'forwarded' ? texts : [])
      if (identity.handle) {
        assert.ok(backend.posts.every((p) => p.body.sessionHandle === identity.handle))
      }
    })
  }
}

// Non-peer classification is a positive exception, and peer evidence still wins.
for (const kind of ['main', 'group'] as const) {
  for (const report of [undefined, null, {}, { state: 'queued' }, { state: 'not_forwarded', reason: 'no_conversation' }]) {
    test(`non-peer reply path table: known ${kind} / ${JSON.stringify(report)}`, async () => {
      const backend = await startBackend()
      const h = harness(backend)
      await h.discoverSideThread(SIDE, kind)
      if (report !== undefined) backend.nextDelivery = report
      else backend.mode = 'saves-silently'
      const result = await h.reply(SIDE, 'Reply in a positively classified non-peer chat.')
      const peerEvidence = report != null
      assert.equal(result.isError, peerEvidence ? true : undefined)
      assert.match(result.content[0]!.text, peerEvidence ? /^(Delivery unconfirmed|Not delivered):/ : /^Sent \(message_id:/)
      assert.equal(sendMessagePosts(backend, SIDE), 1)
    })
  }
}

const EARLY_REPLY_PATHS = [
  { name: 'missing chat id', chatId: '', text: 'Hello.', extra: {}, error: /chat_id is required/ },
  { name: 'empty content', chatId: SIDE_B, text: '', extra: {}, error: /at least one of text, files, or buttons/ },
  { name: 'unauthorized chat', chatId: '33999', text: 'Hello.', extra: {}, error: /not one this assistant is a participant of/ },
  { name: 'too many buttons', chatId: SIDE_B, text: 'Choose.', extra: { buttons: Array.from({ length: 7 }, () => ({ label: 'Yes', value: 'yes' })) }, error: /6 or fewer/ },
  { name: 'invalid button', chatId: SIDE_B, text: 'Choose.', extra: { buttons: [{ label: 'Yes' }] }, error: /both `label` and `value`/ },
  { name: 'attachment resolution error', chatId: SIDE_B, text: 'Attached.', extra: { files: ['fixture.pdf'] }, fileError: true, error: /^Failed to send: fixture upload failed/ },
]
for (const row of EARLY_REPLY_PATHS) {
  test(`side reply path table: ${row.name} exits before POST`, async () => {
    const backend = await startBackend()
    const h = harness(backend, { peerChats: [SIDE_B], fileError: row.fileError })
    const result = await h.reply(row.chatId, row.text, row.extra)
    assert.match(result.content[0]!.text, row.error)
    assert.doesNotMatch(result.content[0]!.text, /^Sent\b/)
    assert.equal(backend.posts.length, 0)
  })
}
for (const status of [403, 500]) {
  test(`side reply path table: HTTP ${status}${status === 403 ? ' participant refusal, then cached refusal' : ' transport error'}`, async () => {
    const backend = await startBackend()
    const h = harness(backend, { peerChats: [SIDE_B] })
    backend.sendStatus = status
    if (status === 403) backend.sendErrorCode = peerRefusal.PEER_NOT_PARTICIPANT
    const results = [await h.reply(SIDE_B, 'First attempt.'), await h.reply(SIDE_B, 'Second attempt.')]
    for (const result of results) {
      assert.equal(result.isError, true)
      assert.doesNotMatch(result.content[0]!.text, /^Sent\b/)
      assert.match(result.content[0]!.text, status === 403 ? /not a participant/ : /^Failed to send:/)
    }
    assert.equal(sendMessagePosts(backend, SIDE_B), status === 403 ? 1 : 2)
    assert.deepEqual(backend.peerGot, [])
  })
}

// Reopen remains a backend decision. Only a confirmed forward claims Sent.

for (const mode of ['saves-silently', 'reports'] as const) {
  for (const signal of CLOSE_SIGNALS) {
    test(`reopen rule (${mode}): after the ${signal}, a reply reaches the peer and claims Sent only when confirmed`, async () => {
      const { backend, h } = await talking(mode)
      backend.revivesOnWrite = true
      await close(backend, h, signal)
      const text = `One more thing after the ${signal}.`
      const result = await h.reply(SIDE, text)
      if (mode === 'reports') {
        assert.equal(result.isError, undefined, result.content[0]?.text)
        assert.match(result.content[0]!.text, /^Sent \(message_id: \d+\)$/)
      } else {
        assert.equal(result.isError, true, result.content[0]?.text)
        assert.match(result.content[0]!.text, /^Delivery unconfirmed:/)
        assert.doesNotMatch(result.content[0]!.text, /^Sent\b/)
      }
      assert.equal(sendMessagePosts(backend, SIDE), 2, 'the reply went to HOAI')
      assert.ok(backend.peerGot.some((m) => m.text === text), 'the peer got it')
    })
  }
}

test('reopen rule, case 2: two replies after the timeout close, before the peer answered, both go to HOAI and both reach the peer', async () => {
  const { backend, h } = await talking()
  backend.revivesOnWrite = true
  h.timeoutClose(SIDE)
  const texts = ['First follow up: the index is rebuilt.', 'Second follow up: the backfill is done too.']
  for (const text of texts) {
    const result = await h.reply(SIDE, text)
    assert.match(result.content[0]!.text, /^Sent \(message_id: \d+\)$/, text)
  }
  assert.equal(sendMessagePosts(backend, SIDE), 3)
  assert.deepEqual(
    backend.peerGot.filter((m) => texts.includes(m.text)).map((m) => m.text),
    texts,
  )
})

test('reopen rule: a close that lands while the reply is on the wire leaves the Sent exactly as main gives it', async () => {
  const { backend, h } = await talking()
  backend.revivesOnWrite = true
  const text = 'Sent just as the thread timed out.'
  backend.onSendMessage = () => {
    backend.onSendMessage = undefined
    h.timeoutClose(SIDE)
  }
  const result = await h.reply(SIDE, text)
  assert.equal(result.isError, undefined)
  assert.match(result.content[0]!.text, /^Sent \(message_id: \d+\)$/, 'no line added after the Sent')
  assert.ok(backend.peerGot.some((m) => m.text === text))
  const next = await h.reply(SIDE, 'And a follow up.')
  assert.match(next.content[0]!.text, /^Sent \(message_id: \d+\)$/, 'the next reply goes to HOAI as always')
  assert.equal(sendMessagePosts(backend, SIDE), 3)
})

// ── with #3420 deployed: not_forwarded is an error, never Sent ───────────────

test('case 1 with #3420: HOAI kept the conversation closed and did not forward the reply: an error naming send_to_peer, never Sent', async () => {
  const { backend, h } = await talking('reports')
  h.timeoutClose(SIDE)
  assert.equal(h.closeNotices, 1, 'the daemon was told, as on 10-27')
  const text = 'The migration ran clean, all 14 tables moved.'
  const said = assertNotForwardedIsAnError(await h.reply(SIDE, text), 'after the timeout close')
  assert.match(said, /has ended/)
  assert.match(said, /If they still need it, send it with send_to_peer\.$/)
  assert.equal(sendMessagePosts(backend, SIDE), 2, 'the reply went to HOAI: the daemon refuses nothing itself')
  assert.ok(!backend.peerGot.some((m) => m.text === text))
})

test('case 2 with #3420: two replies before the peer answered, both go to HOAI and both come back as errors', async () => {
  const { backend, h } = await talking('reports')
  h.timeoutClose(SIDE)
  const texts = ['First follow up: the index is rebuilt.', 'Second follow up: the backfill is done too.']
  for (const text of texts) assertNotForwardedIsAnError(await h.reply(SIDE, text), text)
  assert.equal(sendMessagePosts(backend, SIDE), 3, 'each reply went to HOAI')
})

test('with #3420: a close this daemon never heard of is caught the same way', async () => {
  const { backend, h } = await talking('reports')
  // The socket was down for the close, and no stream entry came.
  backend.threads.get(SIDE)!.open = false
  assertNotForwardedIsAnError(await h.reply(SIDE, 'Did this one land?'), 'an unheard close')
})

test('with #3420: a reply HOAI says it forwarded is the plain Sent', async () => {
  const { backend, h } = await talking('reports')
  const result = await h.reply(SIDE, 'Forwarded as usual.')
  assert.equal(result.isError, undefined)
  assert.match(result.content[0]!.text, /^Sent \(message_id: \d+\)$/)
  assert.ok(backend.peerGot.some((m) => m.text === 'Forwarded as usual.'))
})

for (const reason of ['conversation_not_open', 'no_conversation']) {
  test(`with #3420: ${reason} says the conversation has ended and points at send_to_peer; the next reply still goes to HOAI`, async () => {
    const { backend, h } = await talking('reports')
    backend.nextDelivery = { state: 'not_forwarded', reason }
    const said = assertNotForwardedIsAnError(await h.reply(SIDE, 'Did this one land?'), reason)
    assert.match(said, /has ended/)
    assert.match(said, /If they still need it, send it with send_to_peer\.$/)
    const next = await h.reply(SIDE, 'And this one?')
    assert.match(next.content[0]!.text, /^Sent \(message_id: \d+\)$/, 'HOAI answers each reply; nothing is refused here')
    assert.equal(sendMessagePosts(backend, SIDE), 3)
  })
}

for (const reason of ['bridge_failed', 'not_participant', 'cross_account_refused', 'a_reason_this_daemon_does_not_know']) {
  test(`with #3420: ${reason} fails that one reply, says it was not passed on, and the next reply goes to HOAI`, async () => {
    const { backend, h } = await talking('reports')
    backend.nextDelivery = { state: 'not_forwarded', reason }
    const said = assertNotForwardedIsAnError(await h.reply(SIDE, 'Did this one land?'), reason)
    assert.doesNotMatch(said, /has ended/, 'the conversation is still open, so the error does not say it ended')
    assert.match(said, /did not pass it on to the other agent/)
    assert.match(said, /\bsend_to_peer\b/)
    const next = await h.reply(SIDE, 'And this one?')
    assert.match(next.content[0]!.text, /^Sent \(message_id: \d+\)$/)
    assert.ok(backend.peerGot.some((m) => m.text === 'And this one?'))
  })
}

// Each reason with a remedy of its own says it: an agent that is not
// connected, a paused or removed contact link (HOAI refuses send_to_peer there
// too), and files to an agent of another account (send_to_peer carries none).
for (const [reason, says, remedy] of [
  ['peer_offline', /the other agent is not connected right now/, /\bsend_to_peer\b/],
  ['contact_link_inactive', /connection with that agent's owner is paused or was removed/, null],
  ['external_files_unsupported', /files cannot go to an agent of another account/, /send the words with send_to_peer.*as a link/],
] as const) {
  test(`with #3420: ${reason} says why in plain words and offers only a remedy that works`, async () => {
    const { backend, h } = await talking('reports')
    backend.nextDelivery = { state: 'not_forwarded', reason }
    const said = assertNotForwardedIsAnError(await h.reply(SIDE, 'Did this one land?'), reason)
    assert.match(said, says)
    assert.doesNotMatch(said, /has ended|starts a new conversation/)
    if (remedy) assert.match(said, remedy)
    else assert.doesNotMatch(said, /\bsend_to_peer\b/, 'send_to_peer is refused while the link is not active')
    const next = await h.reply(SIDE, 'And this one?')
    assert.match(next.content[0]!.text, /^Sent \(message_id: \d+\)$/)
  })
}

// ── what the agent can do instead (third review) ────────────────────────────

test('with #3420: no error says send_to_peer starts a new conversation (it may join the pair\'s open one)', async () => {
  for (const reason of ['conversation_not_open', 'no_conversation', 'peer_offline', 'bridge_failed', 'external_files_unsupported']) {
    const { backend, h } = await talking('reports')
    backend.nextDelivery = { state: 'not_forwarded', reason }
    const said = assertNotForwardedIsAnError(await h.reply(SIDE, 'Did this one land?'), reason)
    assert.doesNotMatch(said, /starts a new conversation/, reason)
  }
})

for (const reason of ['conversation_not_open', 'peer_offline', 'bridge_failed', 'undeliverable_content']) {
  test(`with #3420: ${reason} on a reply with a file says to send the words and share the file as a link, since send_to_peer carries no files`, async () => {
    const { backend, h } = await talking('reports')
    backend.nextDelivery = { state: 'not_forwarded', reason }
    const result = await h.reply(SIDE, 'The report is attached.', { files: ['E:\\reports\\q3.pdf'] })
    const said = assertNotForwardedIsAnError(result, reason)
    const posted = backend.posts.filter((p) => p.route === 'POST /api/v1/send-message').at(-1)!
    assert.equal((posted.body.files as unknown[]).length, 1, 'the file went to HOAI with the reply')
    assert.match(said, /send the words with send_to_peer and share the files as a link/)
    assert.match(said, /send_to_peer carries no files/)
    assert.doesNotMatch(said, /send it with send_to_peer/, 'never a remedy that drops the file silently')
  })
}

test('with #3420: undeliverable_content says nothing in the reply could be passed on', async () => {
  const { backend, h } = await talking('reports')
  backend.nextDelivery = { state: 'not_forwarded', reason: 'undeliverable_content' }
  const said = assertNotForwardedIsAnError(await h.reply(SIDE, 'Did this one land?'), 'undeliverable_content')
  assert.match(said, /nothing in it could be passed on to the other agent/)
})

// ── the overdue sweep after a reply HOAI did not pass on (third review) ─────

test('with #3420: not_forwarded drops the inbound it answered from the overdue sweep: the agent has been told', async () => {
  const { backend, h } = await talking('reports')
  h.peerSays(SIDE, CONV, 502)
  assert.equal(h.owed(SIDE), 502, 'the peer\'s question is owed an answer')
  backend.nextDelivery = { state: 'not_forwarded', reason: 'peer_offline' }
  assertNotForwardedIsAnError(await h.reply(SIDE, 'Here is the answer.'), 'peer_offline')
  assert.equal(h.owed(SIDE), undefined, 'the sweep does not ask for that answer again')
})

test('with #3420: a message that lands while the failed reply is on the wire keeps its own tracker', async () => {
  const { backend, h } = await talking('reports')
  h.peerSays(SIDE, CONV, 502)
  backend.nextDelivery = { state: 'not_forwarded', reason: 'peer_offline' }
  backend.onSendMessage = () => {
    backend.onSendMessage = undefined
    h.peerSays(SIDE, CONV, 503)
  }
  assertNotForwardedIsAnError(await h.reply(SIDE, 'Here is the answer to 502.'), 'peer_offline')
  assert.equal(h.owed(SIDE), 503, 'the newer message is still owed an answer')
})

test('peerDelivery is read narrowly: only the two exact states count as a delivery report', async () => {
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
  assert.equal(backend.posts[0]!.body.asAssistantId, SELF)
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
