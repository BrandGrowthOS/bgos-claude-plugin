/**
 * A permission card for the owner's machine goes to the owner's own chat, and
 * only the owner can answer it (shared agents Phase 0, item 0.8; BGOS
 * docs/reports/2026-10-14-shared-agents-review PLAN.md and MATRIX M13.2,
 * M13.3).
 *
 * THE DEFECT. Every Claude Code permission card went to the first monitored
 * chat (pickPermissionChat), not to the owner: on a shared agent that could be
 * a recipient's chat, which then saw the owner's command text. And the answer
 * was bound to whoever last wrote in the card's chat
 * (`lastInboundUserByChat.get(chatId) ?? USER_ID`), so a recipient could
 * allow a tool on the OWNER's machine.
 *
 * WHAT THESE TESTS HOLD.
 *   - the daemon marks which monitored chats are the owner's own (the backend
 *     row's user id when it sends one, else a person's message with the
 *     server's author stamp) and which are somebody else's;
 *   - pickPermissionChat prefers the owner's own chat, most recently confirmed
 *     first, and never picks a chat known to be another person's; with no
 *     evidence it is exactly what it was;
 *   - the card's answer is bound to USER_ID, whoever last wrote in the chat;
 *   - a chat that answers the card with a 403 (the backend half refuses a
 *     card in a recipient's chat) is skipped from then on and THIS request
 *     moves on to the next chat; any other failure is a deny, as before.
 *
 * Run with: npx tsx --test test/permission-card-owner-chat.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as peerRefusal from '../lib/peer-refusal.ts'
import { createRefusedChats, pickPermissionChat } from '../lib/peer-refusal.ts'
import * as permissionRelay from '../lib/permission-relay.ts'
import { readTapperUserId } from '../lib/inbound-channel.ts'
import {
  buildPermissionRequestBody,
  cardMessageIdFrom,
  choiceToBehavior,
  permissionBackstopMs,
  storedWaitSeconds,
} from '../lib/permission-relay.ts'

const ownershipModule = (await import('../lib/chat-ownership.ts').catch(() => null)) as any
const createChatOwnership = (owner: string) => {
  assert.ok(ownershipModule?.createChatOwnership, 'lib/chat-ownership.ts exports createChatOwnership')
  return ownershipModule.createChatOwnership(owner)
}

const OWNER = 'user_owner'
const RECIPIENT = 'user_recipient'
const source = readFileSync('server.ts', 'utf8')
const relaySource = source.slice(source.indexOf('function relayPermissionToOwner('), source.indexOf('\n/**\n * A request the hard floor matched'))
const discoverSource = source.slice(source.indexOf('async function discoverChats('), source.indexOf('\n}\n', source.indexOf('async function discoverChats(')) + 3)

function execute(body: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings))
}

// ── which chat is whose ──────────────────────────────────────────────────────

test('a backend row that names its user marks the owner own chat, and somebody else chat', () => {
  const o = createChatOwnership(OWNER)
  o.noteRow({ chatId: '10', kind: 'main', userId: OWNER })
  o.noteRow({ chatId: '20', kind: 'main', userId: RECIPIENT })
  o.noteRow({ chatId: '30', kind: 'a2a', userId: OWNER })
  o.noteRow({ chatId: '40', kind: 'main' })
  assert.equal(o.isOwners('10'), true)
  assert.equal(o.isOthers('20'), true)
  assert.equal(o.isOwners('30'), false, 'a peer side thread is not the owner own chat, whoever owns the row')
  assert.equal(o.isOwners('40') || o.isOthers('40'), false, 'a row with no user says nothing')
})

test('a person message with the server author stamp marks the chat; somebody else once is somebody else for good', () => {
  const o = createChatOwnership(OWNER)
  o.noteAuthor('10', OWNER)
  o.noteAuthor('20', RECIPIENT)
  o.noteAuthor('50', null)
  assert.equal(o.isOwners('10'), true)
  assert.equal(o.isOthers('20'), true)
  assert.equal(o.isOwners('50') || o.isOthers('50'), false, 'no stamp, no evidence')
  // The owner in a recipient chat (or a recipient in the owner chat) leaves it somebody else's.
  o.noteAuthor('20', OWNER)
  assert.equal(o.isOwners('20'), false)
  o.noteAuthor('10', RECIPIENT)
  assert.equal(o.isOwners('10'), false)
  assert.equal(o.isOthers('10'), true)
  // A chat the inbox says is not a main chat is never the owner own chat.
  o.noteRow({ chatId: '60', kind: 'meeting' })
  o.noteAuthor('60', OWNER)
  assert.equal(o.isOwners('60'), false)
})

test('pickPermissionChat prefers the owner own chat, most recent first, and never another person chat', () => {
  const o = createChatOwnership(OWNER)
  const none = createRefusedChats()
  o.noteAuthor('20', RECIPIENT)
  o.noteAuthor('10', OWNER)
  o.noteAuthor('11', OWNER)
  // The recipient chat is first in the list: never chosen.
  assert.equal(pickPermissionChat(['20', '10', '11'], [none], o), '11', 'the owner chat confirmed last wins')
  o.noteAuthor('10', OWNER)
  assert.equal(pickPermissionChat(['20', '10', '11'], [none], o), '10')
  // An owner chat that refused is skipped for the next owner chat, then the unknown ones in today's order.
  const refused = createRefusedChats()
  refused.add('10')
  assert.equal(pickPermissionChat(['20', '10', '11'], [refused], o), '11')
  refused.add('11')
  assert.equal(pickPermissionChat(['20', '30', '10', '11'], [refused], o), '30', 'an unknown chat, never the recipient one')
  assert.equal(pickPermissionChat(['20', '10', '11'], [refused], o), undefined, 'only somebody else chat is left: nothing')
  // An owner chat no longer monitored is not posted to.
  assert.equal(pickPermissionChat(['20', '30'], [none], o), '30')
})

test('with no ownership evidence pickPermissionChat is exactly what it was', () => {
  const o = createChatOwnership(OWNER)
  const refused = createRefusedChats()
  refused.add('side-1')
  for (const monitored of [['side-1', 'main-9'], ['main-9', 'other'], ['side-1'], []]) {
    assert.equal(pickPermissionChat(monitored, [refused], o), pickPermissionChat(monitored, [refused]), JSON.stringify(monitored))
  }
})

// ── the relay itself, executed from server.ts ────────────────────────────────

// The backend half's exact refusal (BGOS permission-card-placement.ts PERMISSION_CARD_OWNER_CHAT_ONLY).
const OWNER_CHAT_ONLY = "A permission card for the owner's machine goes only into the owner's own chat with this agent, never into the chat of a person it is shared with."

class FakeHttpError extends Error {
  readonly body: string
  constructor(public status: number, message = 'refused') {
    const body = JSON.stringify({ statusCode: status, message, path: '/api/v1/messages', timestamp: '2026-10-14T10:00:00Z' })
    super(`POST ${status}: ${body.slice(0, 200)}`)
    this.body = body
  }
}

function relayRig(opts: { monitored: string[]; refuse?: Record<string, number | [number, string]>; verdictThrows?: [number, string]; lastInbound?: Record<string, string> }) {
  const posts: string[] = []
  const waits: Array<{ chatId: string; requesterUserId: string }> = []
  const verdicts: string[] = []
  const logs: string[] = []
  const pending = new Map<string, any>()
  const chatOwnership = ownershipModule?.createChatOwnership ? ownershipModule.createChatOwnership(OWNER) : null
  const bindings: Record<string, unknown> = {
    updateDrainMode: false, log: (line: string) => logs.push(line),
    mcp: { notification: async (n: any) => { verdicts.push(n.params.behavior) } },
    trackMessageOperation: (fn: () => Promise<unknown>) => fn(),
    pickPermissionChat, monitoredChatIds: opts.monitored,
    hookRailRefusedChats: createRefusedChats(), a2aRouteRefusedChats: createRefusedChats(),
    permissionCardRefusedChats: createRefusedChats(),
    chatOwnership,
    lastInboundUserByChat: new Map(Object.entries(opts.lastInbound ?? {})),
    USER_ID: OWNER, pendingPermissions: pending,
    buildPermissionRequestBody, cardMessageIdFrom, storedWaitSeconds, permissionBackstopMs, choiceToBehavior,
    httpStatusOf: (err: unknown) => (err instanceof FakeHttpError ? err.status : null),
    isPermissionCardOwnerChatOnly: (peerRefusal as any).isPermissionCardOwnerChatOnly,
    refuseHookRailChat: () => false,
    bgosPost: async (_path: string, body: { chatId: number | string }) => {
      const chatId = String(body.chatId)
      posts.push(chatId)
      const refusal = opts.refuse?.[chatId]
      if (refusal) throw Array.isArray(refusal) ? new FakeHttpError(refusal[0], refusal[1]) : new FakeHttpError(refusal, refusal === 403 ? OWNER_CHAT_ONLY : 'refused')
      return { id: 9000 + posts.length }
    },
    waitForVerdict: async (_requestId: string, chatId: string, _card: number | null, _ms: number, requesterUserId: string) => {
      waits.push({ chatId, requesterUserId })
      if (opts.verdictThrows) throw new FakeHttpError(opts.verdictThrows[0], opts.verdictThrows[1])
      return 'once'
    },
  }
  const relay = (requestId: string) => execute(`${relaySource}\nreturn relayPermissionToOwner(params, undefined, false);`, {
    ...bindings,
    params: { request_id: requestId, tool_name: 'Bash', description: 'Run a command', input_preview: '{"command":"ls ~"}' },
  })
  return { relay, posts, waits, verdicts, logs, chatOwnership, refusedCards: bindings.permissionCardRefusedChats as ReturnType<typeof createRefusedChats> }
}

test('the card goes to the owner own chat, not the recipient chat listed first', async () => {
  const r = relayRig({ monitored: ['20', '10'] })
  assert.ok(r.chatOwnership, 'lib/chat-ownership.ts exports createChatOwnership')
  r.chatOwnership.noteAuthor('20', RECIPIENT)
  r.chatOwnership.noteAuthor('10', OWNER)
  await r.relay('req-1')
  assert.deepEqual(r.posts, ['10'])
  assert.deepEqual(r.verdicts, ['allow'])
})

test('the answer is bound to USER_ID, whoever last wrote in the card chat', async () => {
  const r = relayRig({ monitored: ['30'], lastInbound: { 30: RECIPIENT } })
  await r.relay('req-2')
  assert.deepEqual(r.posts, ['30'])
  assert.deepEqual(r.waits, [{ chatId: '30', requesterUserId: OWNER }], 'a recipient can never allow a tool on the owner machine')
})

test('a 403 on the card moves THIS request on to the next chat, and the refusing chat is skipped from then on', async () => {
  const r = relayRig({ monitored: ['20', '10'], refuse: { 20: 403 } })
  await r.relay('req-3')
  assert.deepEqual(r.posts, ['20', '10'], 'refused in the recipient chat, then posted in the next one')
  assert.deepEqual(r.verdicts, ['allow'], 'the request was answered, not denied')
  assert.deepEqual(r.waits.map((w) => w.chatId), ['10'])
  assert.equal(r.refusedCards.has('20'), true)
  await r.relay('req-4')
  assert.deepEqual(r.posts, ['20', '10', '10'], 'the next request goes straight to the chat that takes it')
})

test('when every chat refuses the card with a 403, each is tried once and the request is denied', async () => {
  const r = relayRig({ monitored: ['20', '21'], refuse: { 20: 403, 21: 403 } })
  await r.relay('req-5')
  assert.deepEqual(r.posts, ['20', '21'])
  assert.deepEqual(r.verdicts, ['deny'])
})

test('only the backend refusal moves on: another 403 is a deny as before, and the chat is tried again next time', async () => {
  assert.equal((peerRefusal as any).PERMISSION_CARD_OWNER_CHAT_ONLY_MESSAGE, OWNER_CHAT_ONLY, 'the backend sentence, byte for byte')
  const r = relayRig({ monitored: ['10', '20'], refuse: { 10: [403, 'Forbidden resource'] } })
  await r.relay('req-8')
  assert.deepEqual(r.posts, ['10'], 'an unrelated 403 does not move the card to another chat')
  assert.deepEqual(r.verdicts, ['deny'])
  assert.equal(r.refusedCards.has('10'), false, 'nor drop the chat from permission cards for good')
  await r.relay('req-9')
  assert.deepEqual(r.posts, ['10', '10'])
})

test('any other failure is a deny as before, and a 403 after the card was posted never posts it twice', async () => {
  const failing = relayRig({ monitored: ['20', '10'], refuse: { 20: 500 } })
  await failing.relay('req-6')
  assert.deepEqual(failing.posts, ['20'])
  assert.deepEqual(failing.verdicts, ['deny'])
  // Even the backend's own refusal sentence, once the card is up, is not a chat refusing the card.
  const late = relayRig({ monitored: ['20', '10'], verdictThrows: [403, OWNER_CHAT_ONLY] })
  await late.relay('req-7')
  assert.deepEqual(late.posts, ['20'], 'the card is up; a failure while waiting does not post a second one')
  assert.deepEqual(late.verdicts, ['deny'])
})

// ── where the evidence comes from ────────────────────────────────────────────

test('discoverChats marks each inbox row the backend names a user for', async () => {
  const noted: Array<Record<string, unknown>> = []
  const owned = { noteRow: (row: Record<string, unknown>) => noted.push(row), noteAuthor: () => {} }
  await execute(`${discoverSource}\nreturn discoverChats();`, {
    ASSISTANT_ID: '900', log: () => {}, monitoredChatIds: [], noteMonitoredChat: () => {},
    reconcileMeetingContexts: () => {}, rememberMeetingContext: () => {}, bgosGetCachedOn304: async () => [],
    chatOwnership: owned,
    bgosPeerGet: async () => ({ chats: [
      { id: 10, assistantId: 900, kind: 'main', userId: OWNER },
      { id: 20, assistantId: 900, kind: 'main', user_id: RECIPIENT },
      { id: 30, assistantId: 900, kind: 'a2a' },
    ] }),
  })
  assert.deepEqual(noted, [
    { chatId: '10', kind: 'main', userId: OWNER },
    { chatId: '20', kind: 'main', userId: RECIPIENT },
    { chatId: '30', kind: 'a2a', userId: undefined },
  ])
})

test('every inbound lane notes a person message author from the server stamp, never the owner fallback', () => {
  const sites = [...source.matchAll(/noteChatAuthor\(([^\n]*)\)\n/g)].map((m) => m[1]!)
  assert.equal(sites.length, 3, `poll, stream and socket each note the author: ${JSON.stringify(sites)}`)
  assert.ok(sites.some((s) => s.includes('msg.message') && s.includes("pollSenderType === 'user'") && s.includes('!pollAgentOrigin') && s.includes('!pollIsEmail')), 'poll')
  assert.ok(sites.some((s) => s.includes('view.raw') && s.includes('!isSystem') && s.includes("view.senderKind === 'user'") && s.includes('!view.agentOrigin') && s.includes('!streamIsEmail')), 'stream')
  assert.ok(sites.some((s) => s.includes('payload') && s.includes("wsSenderType === 'user'") && s.includes('!wsAgentOrigin') && s.includes('!wsIsEmail')), 'socket')
  const helper = source.slice(source.indexOf('function noteChatAuthor('), source.indexOf('\n}\n', source.indexOf('function noteChatAuthor(')))
  assert.match(helper, /chatOwnership\.noteAuthor\(chatId, privateSenderUserId\(record\)\)/, 'the author stamp only: privateSenderUserId never falls back to the owner')
  assert.match(helper, /meetingChatIds\.has\(chatId\)/, 'a meeting chat is never the owner own chat')
  assert.match(relaySource, /pickPermissionChat\(monitoredChatIds, \[hookRailRefusedChats, a2aRouteRefusedChats, permissionCardRefusedChats\], chatOwnership\)/)
})

// ── a tap is the owner's only when the server says so (review of the branch) ─

const waitSource = source.slice(source.indexOf('async function waitForVerdict('), source.indexOf('\n}\n', source.indexOf('async function waitForVerdict(')) + 3)

/** The real answeredOn of waitForVerdict, captured from the watch it hands its callbacks to. */
function answeredOnOf(requesterUserId: string) {
  let captured: any = null
  execute(`${waitSource}\nvoid waitForVerdict('abcde', '10', 777, 1000, ${JSON.stringify(requesterUserId)}, false); return null;`, {
    chatLastSeen: new Map(), oncePerRow: () => () => true, log: () => {}, pendingPermissions: new Map(), USER_ID: OWNER,
    watchPermissionVerdict: (opts: any) => { captured = opts; return new Promise(() => {}) },
    permissionRowsReader: () => ({}), bgosGet: async () => null, isNotModified: () => false, isApprovalExpired: () => false,
    answeredPermissionChoice: permissionRelay.answeredPermissionChoice, senderUserIdCandidate: permissionRelay.senderUserIdCandidate,
    readTapperUserId,
  })
  assert.ok(captured?.answeredOn, 'waitForVerdict hands answeredOn to the watch')
  return (answerPayload: Record<string, unknown>) =>
    captured.answeredOn({ message: { id: 777, answeredAt: '2026-10-14T10:00:00Z', answerPayload: { callbackData: 'ea:once:abcde', ...answerPayload } } })
}

test('a tap on the card the server says a recipient made never allows the owner machine tool', () => {
  const answeredOn = answeredOnOf(OWNER)
  assert.equal(answeredOn({ answeredByUserId: RECIPIENT }), null, 'the server named the recipient as the tapper')
  assert.equal(answeredOn({ answered_by_user_id: RECIPIENT }), null)
  assert.equal(answeredOn({ answeredByUserId: OWNER }), 'once', 'the owner tap is the answer')
  assert.equal(answeredOn({}), 'once', 'an unstamped tap keeps the old rule (the backend lets only the owner press there)')
})

/** A click intake's tapper expression, as written in server.ts, evaluated. */
function intakeTapper(lane: 'poll' | 'stream') {
  const start = lane === 'poll'
    ? source.indexOf('const permOutcome = resolvePermissionClick({')
    : source.indexOf('resolvePermissionClick({', source.indexOf("  if (decision === 'permission') {"))
  assert.ok(start > 0, `${lane} intake found`)
  const call = source.slice(start, source.indexOf('})', start))
  const expr = call.match(/clickerUserId: (.+),\n/)?.[1]
  assert.ok(expr, `${lane}: the clickerUserId expression`)
  return (payload: Record<string, unknown>) => execute(`return ${expr}`, {
    readTapperUserId, senderUserIdOf: (m: unknown) => permissionRelay.senderUserIdCandidate(m) ?? OWNER,
    payload, answer: { callbackData: 'ea:once:abcde', tapperUserId: readTapperUserId(payload), ...payload },
  })
}

test('both click intakes read the server tapper first, so a recipient click is foreign to the owner request', () => {
  for (const lane of ['poll', 'stream'] as const) {
    const tapper = intakeTapper(lane)
    assert.equal(tapper({ answeredByUserId: RECIPIENT }), RECIPIENT, lane)
    assert.equal(tapper({ answeredByUserId: OWNER }), OWNER, lane)
    assert.equal(tapper({}), OWNER, `${lane}: unstamped keeps the old owner fallback`)
    const pending = new Map([['abcde', { requesterUserId: OWNER, resolve: () => {} } as any]])
    assert.equal(permissionRelay.resolvePermissionClick({ callbackData: 'ea:once:abcde', clickerUserId: tapper({ answeredByUserId: RECIPIENT }), pending }).kind, 'foreign', lane)
  }
})

// ── the ownership evidence, tightened by the review ──────────────────────────

test('a backend row naming the chat user outranks a message stamp, both ways', () => {
  const o = createChatOwnership(OWNER)
  o.noteRow({ chatId: '10', kind: 'main', userId: OWNER })
  o.noteAuthor('10', RECIPIENT)
  assert.deepEqual([o.isOwners('10'), o.isOthers('10')], [true, false], 'the row says it is the owner chat')
  o.noteRow({ chatId: '20', kind: 'main', userId: RECIPIENT })
  o.noteAuthor('20', OWNER)
  assert.deepEqual([o.isOwners('20'), o.isOthers('20')], [false, true], 'the row says it is the recipient chat')
})

test('discovering the chats again keeps the most recently confirmed owner chat first', () => {
  const o = createChatOwnership(OWNER)
  o.noteAuthor('10', OWNER)
  o.noteAuthor('11', OWNER)
  assert.equal(o.ownerChats()[0], '11')
  // The inbox lists newest first; noting its rows must not reorder what the owner did.
  o.noteRow({ chatId: '11', kind: 'main', userId: OWNER })
  o.noteRow({ chatId: '10', kind: 'main', userId: OWNER })
  assert.equal(o.ownerChats()[0], '11')
  // A row for a chat not yet known adds it, behind the confirmed ones.
  o.noteRow({ chatId: '12', kind: 'main', userId: OWNER })
  assert.deepEqual(o.ownerChats(), ['11', '10', '12'])
})

const authorSource = source.slice(source.indexOf('function noteChatAuthor('), source.indexOf('\n}\n', source.indexOf('function noteChatAuthor(')) + 3)

test('a machine event row is never a person speaking, whoever it is stamped with', async () => {
  const { privateSenderUserId } = await import('../lib/private-turn.mjs')
  const o = createChatOwnership(OWNER)
  const note = (chatId: string, record: unknown) => execute(`${authorSource}\nreturn noteChatAuthor(${JSON.stringify(chatId)}, true, record);`, {
    chatOwnership: o, meetingChatIds: new Set(['90']), privateSenderUserId, record,
  })
  note('10', { senderUserId: OWNER, messageType: 'event', eventMeta: { source: 'scheduler' } })
  note('11', { senderUserId: OWNER, message_type: 'event' })
  note('12', { senderUserId: OWNER, event_meta: { source: 'agent_email' } })
  note('90', { senderUserId: OWNER, messageType: 'text' })
  for (const chatId of ['10', '11', '12', '90']) assert.equal(o.isOwners(chatId), false, chatId)
  note('13', { senderUserId: OWNER, messageType: 'text' })
  assert.equal(o.isOwners('13'), true, 'a person message still counts')
})

const httpErrorSource = source.slice(source.indexOf('class HttpError extends Error {'), source.indexOf('\n}\n', source.indexOf('class HttpError extends Error {')) + 3)
const bgosPostSource = source.slice(source.indexOf('async function bgosPost('), source.indexOf('\n}\n', source.indexOf('async function bgosPost(')) + 3)

test('bgosPost carries the whole refusal body, so the backend sentence is read past the 200 character excerpt', async () => {
  const body = JSON.stringify({ statusCode: 403, message: OWNER_CHAT_ONLY, path: '/api/v1/messages', timestamp: '2026-10-14T10:00:00.000Z' })
  assert.ok(body.length > 200 + 'POST 403: '.length - 10, 'the excerpt alone would cut it')
  const err = await execute(`${httpErrorSource}\n${bgosPostSource}\nreturn bgosPost('messages', { chatId: 20 }).then(() => null, (e) => e);`, {
    API_BASE: 'https://hoai.invalid/api/v1', HTTP_TIMEOUT_MS: 1000, AUTH: {}, ASSISTANT_ID: '900', authHeaders: () => ({}),
    messagesCallerHeaders: () => ({}), meetingChatIds: new Set(), peerConvByChat: new Map(), closedPeerChats: new Set(), a2aRouteRefusedChats: new Set(),
    classifyPeerRefusal: peerRefusal.classifyPeerRefusal,
    bgosCall: async (_call: unknown, consume: (res: any) => Promise<unknown>) => consume({ ok: false, status: 403, text: async () => body }),
  })
  assert.ok(err instanceof Error)
  assert.equal((peerRefusal as any).isPermissionCardOwnerChatOnly(err), true)
  assert.equal((peerRefusal as any).isPermissionCardOwnerChatOnly({ status: 403, body: JSON.stringify({ statusCode: 403, message: 'Forbidden resource' }) }), false)
  assert.equal((peerRefusal as any).isPermissionCardOwnerChatOnly({ status: 400, body }), false, 'the status counts too')
  assert.equal((peerRefusal as any).isPermissionCardOwnerChatOnly(new Error(`POST 403: ${body}`)), false, 'never read off the message')
})
