/**
 * The POST /api/v1/messages 403 loop (board row a80d3683), RUN against a
 * mocked backend.
 *
 * THE MEASUREMENT. On 2026-10-07 pairing 97 (Milba, assistant 947, plugin
 * 0.61.4) was refused 378 times in one hour with "Caller assistant is not a
 * participant of this peer conversation.", and pairings 99, 106 and 137 the
 * same way at lower rates. The backend's denial line names the route: POST
 * /api/v1/messages.
 *
 * WHO SENDS IT. The `reply` tool posts to /send-message, so it is not what was
 * counted. POST /messages is the hook rail's tool card and its markers, and
 * the backend reads the caller assistant on that route ONLY from an
 * X-Caller-Assistant-Id header the daemon never sends, so every card into a
 * peer side-thread with an open conversation is refused with exactly this
 * reason. A refused POST mints no card id, so the next coalesced flush (one
 * per 600 ms while the turn emits hook events) POSTs the same card again: the
 * loop. The reply tool is the second path the row names: its 403 came back as
 * a plain "Failed to send" the model can retry, and the reply-overdue sweep
 * then told the model to call reply again.
 *
 * WHY THIS RUNS THE REAL CODE OUT OF server.ts. server.ts cannot be imported
 * without booting a daemon, and a source grep is green on exactly the loop it
 * cannot see. So the harness lifts the declared functions (and the reply case
 * of the tool switch), transpiles them, and runs them against stubs, with the
 * daemon's own HTTP client talking to a real local HTTP server that answers
 * with the backend's exact 403 body (BGOS backend/src/advicer/
 * http-exception.advicer.ts builds it: statusCode, message, path, timestamp;
 * no code field for a 403). On code without the fix the same harness lifts
 * the same functions and counts the loop.
 *
 * Run with: npx tsx --test test/peer-403-loop.test.ts
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import ts from 'typescript'

import { boundedFetch } from '../lib/bounded-fetch.ts'
import { authHeaders } from '../lib/agent-credentials.ts'
import { PendingCards } from '../lib/hook-card-pending.ts'
import { hookCardWireBody } from '../lib/hook-card-body.ts'
import { inboundOwesReply } from '../lib/channel-liveness.ts'

// Absent on code without the fix, which is exactly what the red run needs: the
// lifted functions then never reference it.
const peerRefusal: Record<string, unknown> = await import('../lib/peer-refusal.ts').catch(() => ({}))

const SERVER = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const A2A = '33017'
const MAIN = '33001'
const REASON = 'Caller assistant is not a participant of this peer conversation.'
const COALESCE_MS = 600
const SWEEP_MS = 30_000
const HOUR_MS = 3_600_000
const START = Date.UTC(2026, 9, 7, 9, 0, 0)

// ── the mocked backend ──────────────────────────────────────────────────────

type Mode = 'peer403' | 'peer403-long' | 'other403' | 'server500' | 'ok' | 'a2a400' | 'other400'

interface Backend {
  url: string
  mode: Mode
  count(route: string): number
  /** Runs while a request is on the wire, before it is answered. */
  onRequest?: () => void
}

const servers: Server[] = []
after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
})

/** The body HttpExceptionAdvicer writes, key for key. */
function deniedBody(status: number, message: string, path: string): string {
  return JSON.stringify({ statusCode: status, message, path, timestamp: '2026-10-07T09:00:00.000Z' })
}

/**
 * The 400 a ServiceException becomes: HttpExceptionAdvicer maps it to 400 and
 * adds the `operation` key, still with no `code`. MessageService's
 * prepareMessageForWrite throws this one for every POST /messages into an a2a
 * chat, once the participant check has passed (a CLOSED side-thread), and the
 * advicer logs only 401, 403 and 429, so the backend kept no trace of the loop.
 */
const A2A_REASON = 'A2A messages must use /send-message'
function serviceBody(message: string, path: string): string {
  return JSON.stringify({
    statusCode: 400,
    message,
    path,
    timestamp: '2026-10-07T09:00:00.000Z',
    operation: 'MESSAGE',
  })
}

async function startBackend(mode: Mode): Promise<Backend> {
  const counts = new Map<string, number>()
  const backend: Backend = {
    url: '',
    mode,
    count: (route) => counts.get(route) ?? 0,
  }
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const path = req.url ?? '/'
      const route = `${req.method} ${path.split('?')[0]}`
      counts.set(route, (counts.get(route) ?? 0) + 1)
      backend.onRequest?.()
      const send = (status: number, body: string) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(body)
      }
      switch (backend.mode) {
        case 'peer403':
          return send(403, deniedBody(403, REASON, path))
        case 'peer403-long':
          // Longer than the 200 characters the error message keeps, so the
          // refusal has to be read from the whole body, not from the message.
          return send(403, deniedBody(403, REASON, `${path}?trace=${'x'.repeat(240)}`))
        case 'other403':
          return send(403, deniedBody(403, 'Caller does not own this conversation.', path))
        case 'a2a400':
          return send(400, serviceBody(A2A_REASON, path))
        case 'other400':
          return send(
            400,
            serviceBody(
              'Missing or invalid required fields for message creation: chatId (> 0), sender, and content (text, files, or options) are required.',
              path,
            ),
          )
        case 'server500':
          return send(500, deniedBody(500, 'Internal server error', path))
        case 'ok':
          return route === 'POST /api/v1/send-message'
            ? send(201, JSON.stringify({ message: { id: 9002 } }))
            : send(201, JSON.stringify({ id: 9001 }))
      }
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

/** The same, or nothing when server.ts declares no such function: a helper the
 *  fix adds is lifted where it exists, and the red run has none to lift. */
function liftIfPresent(header: string): string {
  return SERVER.includes(`\n${header}`) ? lift(header) : ''
}

/** The reply case of the tool switch, wrapped in a function of its own. */
function liftReplyCase(): string {
  const start = SERVER.indexOf("\n    case 'reply': {")
  const end = SERVER.indexOf("\n    case 'propose_plan': {", start)
  assert.ok(start > 0 && end > start, 'the reply case exists')
  return `async function replyTool(rawArgs) {\n  switch ('reply') {\n${SERVER.slice(start + 1, end)}\n  }\n}\n`
}

/** The send_to_peer case, wrapped the same way. */
function liftSendToPeerCase(): string {
  const start = SERVER.indexOf("\n    case 'send_to_peer': {")
  const end = SERVER.indexOf("\n    case 'complete_peer_thread': {", start)
  assert.ok(start > 0 && end > start, 'the send_to_peer case exists')
  return `async function sendToPeerTool(rawArgs) {\n  switch ('send_to_peer') {\n${SERVER.slice(start + 1, end)}\n  }\n}\n`
}

/** The ask_user_input case, wrapped the same way. */
function liftAskCase(): string {
  const start = SERVER.indexOf("\n    case 'ask_user_input': {")
  const end = SERVER.indexOf("\n    case 'complete_voice_task': {", start)
  assert.ok(start > 0 && end > start, 'the ask_user_input case exists')
  return `async function askTool(rawArgs) {\n  switch ('ask_user_input') {\n${SERVER.slice(start + 1, end)}\n  }\n}\n`
}

/** The per chat refusal memories the fix declares, when it declares them. */
function refusalLedgers(): string[] {
  return [...SERVER.matchAll(/^const \w+ = createRefusedChats\([^\n]*\)$/gm)].map((m) => m[0])
}

interface Harness {
  advance(ms: number): void
  setTurnChat(chatId: string): void
  queueCard(i: number): void
  flush(): Promise<void>
  marker(): Promise<void>
  recordInbound(chatId: string, messageId: number): void
  reply(chatId: string, text: string): Promise<{ content: Array<{ text: string }>; isError?: boolean }>
  sendToPeer(sideThreadChatId: string): Promise<unknown>
  component(chatId: string): Promise<{ content: Array<{ text: string }>; isError?: boolean }>
  ask(chatId: string): Promise<{ content: Array<{ text: string }>; isError?: boolean }>
  closeConversation(chatId: string): void
  sweep(): void
  nudgesFor(chatId: string): number
  pendingFor(chatId: string): { messageId: number } | undefined
  cardIdFor(cardKey: string): string | undefined
  logs: string[]
}

function harness(apiBase: string, turnChat: string): Harness {
  const source = [
    lift('class HttpError extends Error {'),
    lift('function httpStatusOf('),
    lift('function bgosCall<T>('),
    lift('async function bgosPost('),
    lift('function createdMessageId('),
    lift('function hookCardBody('),
    lift('function rememberHookCardId('),
    liftIfPresent('function refuseHookRailChat('),
    liftIfPresent('function refuseA2aToolPost('),
    lift('async function writeHookCard('),
    lift('async function flushHookCard('),
    lift('async function postHookMarker('),
    lift('function markConversationClosed('),
    lift('function recordInbound('),
    lift('function clearInbound('),
    lift('function checkReplyOverdue('),
    lift('async function handleShowComponent('),
    ...refusalLedgers(),
    liftReplyCase(),
    liftSendToPeerCase(),
    liftAskCase(),
  ]
    .join('\n')
    // The sweep's deaf branch names the script it runs from; it never runs
    // here, and import.meta is not legal outside a module.
    .replace(/import\.meta\.url/g, 'IMPORT_META_URL')
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText

  let clock = START
  let currentChat = turnChat
  class FakeDate extends Date {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clock)
      else super(args[0] as string)
    }
    static now(): number {
      return clock
    }
  }

  const logs: string[] = []
  const nudges: Array<{ chatId: string }> = []
  const pendingInbounds = new Map<string, { messageId: number }>()
  let peerSendResult: Record<string, unknown> = {}
  const hookCardIds = new Map<string, string>()
  const hookCardPending = new PendingCards(8)

  const recorder: unknown = new Proxy(function () {}, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : recorder),
    apply: () => undefined,
  })
  const known: Record<string, unknown> = {
    ...peerRefusal,
    Date: FakeDate,
    log: (line: string) => logs.push(line),
    // HTTP, the daemon's own client against the mocked backend.
    boundedFetch,
    authHeaders,
    noteAuthOutcome: () => undefined,
    API_BASE: apiBase,
    AUTH: { mode: 'pairing', pairingToken: 'pair_test0000' },
    HTTP_TIMEOUT_MS: 5_000,
    ASSISTANT_ID: '947',
    // The hook rail.
    hookCardWireBody,
    hookCardPending,
    hookCardIds,
    hookCardFlight: null,
    hookCardFlightKey: null,
    HOOK_CARD_ID_LIMIT: 8,
    hookChatId: () => currentChat,
    scheduleHookCard: () => undefined,
    buildComponentEventMessage: (opts: { chatId: number; assistantId: string; description: string }) => ({
      ok: true,
      body: { chatId: opts.chatId, assistantId: Number(opts.assistantId), messageType: 'event', text: opts.description },
    }),
    // Inbound tracking and the reply-overdue sweep.
    pendingInbounds,
    meetingChatIds: new Set<string>(),
    closedPeerChats: new Set<string>(),
    peerConvChats: new Map<string, string>(),
    peerConvByChat: new Map<string, string>(),
    CLOSED_PEER_CHATS_MAX: 500,
    REPLY_OVERDUE_MS: 240_000,
    updateDrainMode: false,
    deafEscalationDone: false,
    deafProbeSentAt: null,
    noteMonitoredChat: () => undefined,
    inboundOwesReply,
    trackMessageOperation: (op: () => Promise<unknown>) => op(),
    mcp: {
      notification: async (n: { params: { meta?: { event_type?: string; chat_id?: string } } }) => {
        if (n.params.meta?.event_type === 'reply_overdue') nudges.push({ chatId: String(n.params.meta.chat_id) })
      },
    },
    // The reply tool.
    resolveAuthorizedChat: (id: string) => ({ ok: true, chatId: id, sessionHandle: undefined }),
    meetingIdByChatId: new Map<string, number>(),
    protectBackslashesForMarkdown: (text: string) => text,
    recentButtonPrompts: new Map<string, unknown>(),
    // send_to_peer.
    bgosPeerPost: async () => peerSendResult,
    // show_component: a summonable kind whose payload validates.
    bgosGetCachedOn304: async () => ({}),
    BUNDLED_RENDERABLES_FALLBACK: {},
    findRenderable: () => ({ kind: 'status_card', description: 'A status card.', payloadSchema: {} }),
    listRenderableKinds: () => ['status_card'],
    isHostPostedKind: () => false,
    validateComponentPayload: () => ({ ok: true }),
    deriveComponentTitle: () => 'Status card',
    // ask_user_input.
    escapeAgentButtonValue: (value: string) => `u:${value}`,
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
    `with (scope) {\n${js}\nreturn { flushHookCard, postHookMarker, recordInbound, markConversationClosed, checkReplyOverdue, replyTool, sendToPeerTool, handleShowComponent, askTool }\n}`,
  )
  const lifted = factory(scope) as {
    flushHookCard(): Promise<void>
    postHookMarker(effect: Record<string, unknown>): Promise<void>
    recordInbound(chatId: string, messageId: number, turnState?: string, senderKind?: string | null): void
    checkReplyOverdue(): void
    markConversationClosed(opts: { chatId?: string | null }): void
    replyTool(args: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; isError?: boolean }>
    sendToPeerTool(args: Record<string, unknown>): Promise<unknown>
    handleShowComponent(opts: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; isError?: boolean }>
    askTool(args: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; isError?: boolean }>
  }

  return {
    advance: (ms) => {
      clock += ms
    },
    setTurnChat: (chatId) => {
      currentChat = chatId
    },
    queueCard: (i) =>
      hookCardPending.put({ state: 'running', tools: [], text: `step ${i}`, cardKey: 'turn-1', startedAt: START }),
    flush: () => lifted.flushHookCard(),
    marker: () =>
      lifted.postHookMarker({
        kind: 'marker',
        markerKind: 'context_compacted',
        payload: {},
        title: 'Context compacted',
        text: 'Context compacted',
      }),
    recordInbound: (chatId, messageId) => lifted.recordInbound(chatId, messageId, 'expecting_reply', 'assistant'),
    reply: (chatId, text) => lifted.replyTool({ chat_id: chatId, text }),
    sendToPeer: (sideThreadChatId) => {
      peerSendResult = { sideThreadChatId: Number(sideThreadChatId), conversationId: 77, message: { id: 9100 } }
      return lifted.sendToPeerTool({ target_assistant_id: 950, parent_message_id: 501, text: 'Picking this back up.' })
    },
    component: (chatId) =>
      lifted.handleShowComponent({
        kind: 'status_card',
        payload: { title: 'Bucket', status: 'done' },
        chatIdArg: chatId,
        toolName: 'show_component',
      }),
    ask: (chatId) =>
      lifted.askTool({
        chat_id: chatId,
        questions: [{ text: 'Ship it?', options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }] }],
        // No answer wait: the deadline is the start, so a posted question
        // returns at once (the clock here does not move on its own).
        timeout_seconds: 0,
      }),
    closeConversation: (chatId) => lifted.markConversationClosed({ chatId }),
    sweep: () => lifted.checkReplyOverdue(),
    nudgesFor: (chatId) => nudges.filter((n) => n.chatId === chatId).length,
    pendingFor: (chatId) => pendingInbounds.get(chatId),
    cardIdFor: (cardKey) => hookCardIds.get(cardKey),
    logs,
  }
}

/** One hour of the rail at the rate its coalescer allows, six markers in it. */
async function railHour(h: Harness): Promise<void> {
  for (let i = 0; i < HOUR_MS / COALESCE_MS; i++) {
    h.queueCard(i)
    await h.flush()
    if (i % 1000 === 0) await h.marker()
    h.advance(COALESCE_MS)
  }
}

/**
 * One hour of a peer reply: the model replies, then obeys every
 * reply-overdue nudge, and on top of that retries on its own every five
 * minutes, the way a model handed a plain "Failed to send" can.
 */
async function replyHour(h: Harness) {
  const results = [await h.reply(A2A, 'Done: the bucket exists and public access is blocked.')]
  for (let t = SWEEP_MS; t <= HOUR_MS; t += SWEEP_MS) {
    h.advance(SWEEP_MS)
    const before = h.nudgesFor(A2A)
    h.sweep()
    // Let the nudge's notification settle before it is counted.
    await Promise.resolve()
    if (h.nudgesFor(A2A) > before) results.push(await h.reply(A2A, 'Replying as nudged.'))
    if (t % 300_000 === 0) results.push(await h.reply(A2A, 'Trying that reply again.'))
  }
  return results
}

function assertTyped(result: { content: Array<{ text: string }>; isError?: boolean }) {
  const text = result.content[0]?.text ?? ''
  assert.equal(result.isError, true, 'the send did not happen, and the result says so')
  assert.match(text, /^peer_not_participant\b/, `typed: ${text.slice(0, 120)}`)
  assert.match(text, /not one you are in: yours there has closed, or you were never in it/)
  assert.match(text, /Do not retry/)
  assert.match(text, /owner only if it matters/)
}

// ── the loop, and its fix ─────────────────────────────────────────────────────

test('hook rail: an hour of tool cards into a peer side-thread refused with the participant 403 is ONE post', async () => {
  const backend = await startBackend('peer403')
  const h = harness(backend.url, A2A)
  await railHour(h)
  assert.equal(
    backend.count('POST /api/v1/messages'),
    1,
    'one attempt, then nothing more for that chat: no card re-post on the next flush, no marker',
  )
  assert.equal(h.cardIdFor('turn-1'), undefined, 'a refused card has no id to patch')
  const why = h.logs.filter((l) => l.includes('peer_not_participant'))
  assert.equal(why.length, 1, 'the reason is recorded once, not once per flush')
  assert.match(why[0]!, new RegExp(`chat ${A2A}`))
})

test('hook rail: the refusal is per chat, the owner chat keeps its cards', async () => {
  const backend = await startBackend('peer403')
  const h = harness(backend.url, A2A)
  h.queueCard(0)
  await h.flush()
  backend.mode = 'ok'
  h.setTurnChat(MAIN)
  h.queueCard(1)
  await h.flush()
  assert.equal(h.cardIdFor('turn-1'), '9001', 'the next turn, in the owner chat, gets its card')
  assert.equal(backend.count('POST /api/v1/messages'), 2)
})

test('hook rail: a refusal body longer than the logged excerpt is still read as the participant 403', async () => {
  const backend = await startBackend('peer403-long')
  const h = harness(backend.url, A2A)
  for (let i = 0; i < 20; i++) {
    h.queueCard(i)
    await h.flush()
  }
  assert.equal(backend.count('POST /api/v1/messages'), 1)
})

test('reply: a peer reply refused with the participant 403 is sent ONCE in an hour, typed, and never nudged again', async () => {
  const backend = await startBackend('peer403')
  const h = harness(backend.url, A2A)
  h.recordInbound(A2A, 501)
  const results = await replyHour(h)
  assert.equal(backend.count('POST /api/v1/send-message'), 1, 'one attempt, no further calls over the hour')
  assert.equal(h.nudgesFor(A2A), 0, 'the overdue sweep must not ask for a reply that can never land')
  assert.equal(h.pendingFor(A2A), undefined)
  assert.ok(results.length >= 13, 'the model really did try again, and every try was answered locally')
  for (const result of results) assertTyped(result)
})

test('reply: a new message in that chat lifts the block, so a conversation the agent is in again is answered', async () => {
  const backend = await startBackend('peer403')
  const h = harness(backend.url, A2A)
  h.recordInbound(A2A, 501)
  assertTyped(await h.reply(A2A, 'first'))
  assertTyped(await h.reply(A2A, 'again'))
  assert.equal(backend.count('POST /api/v1/send-message'), 1)
  backend.mode = 'ok'
  h.recordInbound(A2A, 502)
  const sent = await h.reply(A2A, 'answering the new message')
  assert.match(sent.content[0]!.text, /^Sent \(message_id: 9002\)/)
  assert.equal(backend.count('POST /api/v1/send-message'), 2)
})

test('reply: a close for that chat, or a send_to_peer that lands in it, lifts the block too', async () => {
  for (const lift of ['close', 'send_to_peer'] as const) {
    const backend = await startBackend('peer403')
    const h = harness(backend.url, A2A)
    h.recordInbound(A2A, 501)
    assertTyped(await h.reply(A2A, 'first'))
    assertTyped(await h.reply(A2A, 'again'))
    assert.equal(backend.count('POST /api/v1/send-message'), 1, lift)
    backend.mode = 'ok'
    if (lift === 'close') h.closeConversation(A2A)
    else await h.sendToPeer(A2A)
    const sent = await h.reply(A2A, 'now it can land')
    assert.match(sent.content[0]!.text, /^Sent \(message_id: 9002\)/, lift)
    assert.equal(backend.count('POST /api/v1/send-message'), 2, lift)
  }
})

test('reply: a message that arrives while the refused reply is in flight keeps its tracker and is not blocked', async () => {
  const backend = await startBackend('peer403')
  const h = harness(backend.url, A2A)
  h.recordInbound(A2A, 501)
  backend.onRequest = () => {
    backend.onRequest = undefined
    h.recordInbound(A2A, 502)
  }
  assertTyped(await h.reply(A2A, 'answering 501'))
  assert.equal(h.pendingFor(A2A)?.messageId, 502, 'the newer message is still owed its reply')
  backend.mode = 'ok'
  const sent = await h.reply(A2A, 'answering 502')
  assert.match(sent.content[0]!.text, /^Sent \(message_id: 9002\)/)
  assert.equal(backend.count('POST /api/v1/send-message'), 2)
})

test('hook rail: a refused marker silences the chat for cards too', async () => {
  const backend = await startBackend('peer403')
  const h = harness(backend.url, A2A)
  await h.marker()
  for (let i = 0; i < 50; i++) {
    h.queueCard(i)
    await h.flush()
  }
  await h.marker()
  assert.equal(backend.count('POST /api/v1/messages'), 1)
  assert.equal(h.logs.filter((l) => l.includes('peer_not_participant')).length, 1)
})

// ── everything else keeps today's behaviour ───────────────────────────────────

for (const mode of ['other403', 'server500'] as const) {
  const status = mode === 'other403' ? 403 : 500

  test(`hook rail: a ${mode === 'other403' ? 'different 403' : '5xx'} keeps today's behaviour, the card is posted again on every flush`, async () => {
    const backend = await startBackend(mode)
    const h = harness(backend.url, A2A)
    for (let i = 0; i < 25; i++) {
      h.queueCard(i)
      await h.flush()
    }
    assert.equal(backend.count('POST /api/v1/messages'), 25)
    assert.equal(h.logs.filter((l) => l.startsWith('hook rail: tool card post failed:')).length, 25)
    assert.equal(h.logs.some((l) => l.includes('peer_not_participant')), false)
  })

  test(`reply: a ${mode === 'other403' ? 'different 403' : '5xx'} keeps today's behaviour, a plain failure on every call`, async () => {
    const backend = await startBackend(mode)
    const h = harness(backend.url, A2A)
    h.recordInbound(A2A, 501)
    for (let i = 0; i < 3; i++) {
      const result = await h.reply(A2A, `try ${i}`)
      assert.equal(result.isError, true)
      assert.match(result.content[0]!.text, new RegExp(`^Failed to send: POST ${status}: `))
    }
    assert.equal(backend.count('POST /api/v1/send-message'), 3)
    assert.notEqual(h.pendingFor(A2A), undefined, 'the inbound is still owed a reply, as today')
  })
}

// ── the closed side-thread 400 (the #186 review) ──────────────────────────────
//
// In a CLOSED side-thread the participant check passes and the generic route
// refuses instead: 400 "A2A messages must use /send-message" (a2a chats take
// writes only through /send-message). Nothing classified it, so the rail posted
// the same card again on every flush, and the backend logs no 400.

function assertA2aTyped(result: { content: Array<{ text: string }>; isError?: boolean }) {
  const text = result.content[0]?.text ?? ''
  assert.equal(result.isError, true, 'nothing was posted, and the result says so')
  assert.match(text, /^a2a_route_required\b/, `typed: ${text.slice(0, 120)}`)
  assert.match(text, /peer side-thread/)
  assert.match(text, /Do not retry/)
}

test('hook rail: an hour of tool cards into a closed side-thread refused with the a2a 400 is ONE post', async () => {
  const backend = await startBackend('a2a400')
  const h = harness(backend.url, A2A)
  await railHour(h)
  assert.equal(
    backend.count('POST /api/v1/messages'),
    1,
    'one attempt, then nothing more for that chat: no card re-post on the next flush, no marker',
  )
  assert.equal(h.cardIdFor('turn-1'), undefined, 'a refused card has no id to patch')
  const why = h.logs.filter((l) => l.includes('a2a_route_required'))
  assert.equal(why.length, 1, 'the reason is recorded once, not once per flush')
  assert.match(why[0]!, new RegExp(`chat ${A2A} refused the card with 400 a2a_route_required`))
})

test('hook rail: the a2a 400 is per chat, the owner chat keeps its cards', async () => {
  const backend = await startBackend('a2a400')
  const h = harness(backend.url, A2A)
  h.queueCard(0)
  await h.flush()
  backend.mode = 'ok'
  h.setTurnChat(MAIN)
  h.queueCard(1)
  await h.flush()
  assert.equal(h.cardIdFor('turn-1'), '9001', 'the next turn, in the owner chat, gets its card')
  assert.equal(backend.count('POST /api/v1/messages'), 2)
})

test('hook rail: a marker refused with the a2a 400 silences the chat for cards too', async () => {
  const backend = await startBackend('a2a400')
  const h = harness(backend.url, A2A)
  await h.marker()
  for (let i = 0; i < 50; i++) {
    h.queueCard(i)
    await h.flush()
  }
  await h.marker()
  assert.equal(backend.count('POST /api/v1/messages'), 1)
  assert.equal(h.logs.filter((l) => l.includes('a2a_route_required')).length, 1)
})

test('show_component and ask_user_input: the a2a 400 is posted once, typed, and answered locally after', async () => {
  for (const tool of ['component', 'ask'] as const) {
    const backend = await startBackend('a2a400')
    const h = harness(backend.url, A2A)
    const results = []
    for (let i = 0; i < 12; i++) results.push(await h[tool](A2A))
    assert.equal(backend.count('POST /api/v1/messages'), 1, `${tool}: one attempt in that chat`)
    for (const result of results) assertA2aTyped(result)
    // And the other chat is untouched.
    backend.mode = 'ok'
    const elsewhere = await h[tool](MAIN)
    assert.notEqual(elsewhere.content[0]?.text.startsWith('a2a_route_required'), true, tool)
    assert.equal(backend.count('POST /api/v1/messages'), 2, tool)
  }
})

test('the tools learn it from the rail: after the rail is refused, no tool posts into that chat', async () => {
  const backend = await startBackend('a2a400')
  const h = harness(backend.url, A2A)
  h.queueCard(0)
  await h.flush()
  assert.equal(backend.count('POST /api/v1/messages'), 1)
  assertA2aTyped(await h.component(A2A))
  assertA2aTyped(await h.ask(A2A))
  assert.equal(backend.count('POST /api/v1/messages'), 1, 'answered locally, nothing posted')
})

test('hook rail: a different 400 keeps today\'s behaviour, the card is posted again on every flush', async () => {
  const backend = await startBackend('other400')
  const h = harness(backend.url, A2A)
  for (let i = 0; i < 25; i++) {
    h.queueCard(i)
    await h.flush()
  }
  assert.equal(backend.count('POST /api/v1/messages'), 25)
  assert.equal(h.logs.filter((l) => l.startsWith('hook rail: tool card post failed:')).length, 25)
  assert.equal(h.logs.some((l) => l.includes('a2a_route_required')), false)
})

test('show_component and ask_user_input: a different 400 or a 5xx keeps today\'s plain failure on every call', async () => {
  for (const mode of ['other400', 'server500', 'peer403'] as const) {
    for (const tool of ['component', 'ask'] as const) {
      const backend = await startBackend(mode)
      const h = harness(backend.url, A2A)
      for (let i = 0; i < 3; i++) {
        const result = await h[tool](A2A)
        assert.equal(result.isError, true)
        assert.match(
          result.content[0]!.text,
          tool === 'component' ? /^Failed to send the component card: / : /^ask_user_input failed: /,
          `${mode} ${tool}`,
        )
      }
      assert.equal(backend.count('POST /api/v1/messages'), 3, `${mode} ${tool}`)
    }
  }
})

test('reply: the a2a 400 is not the participant refusal, so a reply keeps today\'s plain failure', async () => {
  // /send-message never answers this today; if it ever did, the reply must not
  // be told the conversation is not one it is in.
  const backend = await startBackend('a2a400')
  const h = harness(backend.url, A2A)
  h.recordInbound(A2A, 501)
  for (let i = 0; i < 3; i++) {
    const result = await h.reply(A2A, `try ${i}`)
    assert.equal(result.isError, true)
    assert.match(result.content[0]!.text, /^Failed to send: POST 400: /)
  }
  assert.equal(backend.count('POST /api/v1/send-message'), 3)
  assert.notEqual(h.pendingFor(A2A), undefined, 'the inbound is still owed a reply, as today')
})
