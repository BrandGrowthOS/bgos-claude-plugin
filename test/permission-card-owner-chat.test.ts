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
import { createRefusedChats, pickPermissionChat } from '../lib/peer-refusal.ts'
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

class FakeHttpError extends Error {
  constructor(public status: number) { super(`POST ${status}: {"statusCode":${status},"message":"refused"}`) }
}

function relayRig(opts: { monitored: string[]; refuse?: Record<string, number>; verdictThrows?: number; lastInbound?: Record<string, string> }) {
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
    refuseHookRailChat: () => false,
    bgosPost: async (_path: string, body: { chatId: number | string }) => {
      const chatId = String(body.chatId)
      posts.push(chatId)
      const status = opts.refuse?.[chatId]
      if (status) throw new FakeHttpError(status)
      return { id: 9000 + posts.length }
    },
    waitForVerdict: async (_requestId: string, chatId: string, _card: number | null, _ms: number, requesterUserId: string) => {
      waits.push({ chatId, requesterUserId })
      if (opts.verdictThrows) throw new FakeHttpError(opts.verdictThrows)
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

test('any other failure is a deny as before, and a 403 after the card was posted never posts it twice', async () => {
  const failing = relayRig({ monitored: ['20', '10'], refuse: { 20: 500 } })
  await failing.relay('req-6')
  assert.deepEqual(failing.posts, ['20'])
  assert.deepEqual(failing.verdicts, ['deny'])
  const late = relayRig({ monitored: ['20', '10'], verdictThrows: 403 })
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
