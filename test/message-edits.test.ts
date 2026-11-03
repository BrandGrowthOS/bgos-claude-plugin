/** Runs the production socket registration, stream apply and poll functions.
 * Restoring ID-only dedup on either lane must drop the second notification.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

import * as inboundChannel from '../lib/inbound-channel.ts'
import * as slashCatalog from '../lib/slash-catalog.ts'
import { BUILTIN_COMMANDS, prepareSlashCommands } from '../lib/slash-catalog.ts'
import * as messageText from '../lib/message-text.ts'
import * as pollCore from '../lib/poll-core.ts'
import * as meetingCard from '../lib/meeting-card.ts'
import * as streamApply from '../lib/stream-apply.ts'
import { senderUserIdCandidate, parsePermissionChoice } from '../lib/permission-relay.ts'
import * as privateTurnModule from '../lib/private-turn.mjs'
import { privateActor, privateSenderUserId } from '../lib/private-turn.mjs'
import { ownerLaneVerdict } from '../lib/lane-core.mjs'

const OWNER = 'user_owner'
const ASSISTANT_ID = '900'
const CHAT = '7001'
const SRC = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('server.ts', SRC, ts.ScriptTarget.Latest, true)
function functionSource(name: string): string {
  let found = ''
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return found
}
function constSource(name: string): string {
  for (const node of ast.statements) {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(ast) === name)) return node.getText(ast)
  }
  return ''
}
function socketRegistration(event: string): string {
  let found = ''
  const visit = (node: ts.Node) => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
        node.expression.expression.getText(ast) === 'realtimeSocket.on' &&
        node.expression.arguments[0]?.getText(ast) === `'${event}'`) found = node.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return found
}
interface LaneRun {
  notifications: Array<{ content: string; meta: Record<string, string> }>
  actions: string[]
  lastInboundUser: Map<string, string>
  turnKinds: string[]
  stopPause: Array<Record<string, unknown>>
  recorded: Array<string | null | undefined>
  actingNotes: Array<Record<string, unknown>>
  logs: string[]
}

const SLASH = prepareSlashCommands(BUILTIN_COMMANDS)

/** Compile `source` out of server.ts and return `name`, every free name resolved through `known` or a recorder. */
function compile(source: string, name: string, extra: Record<string, unknown> = {}) {
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const run: LaneRun = {
    notifications: [],
    actions: [],
    lastInboundUser: new Map(),
    turnKinds: [],
    stopPause: [],
    recorded: [],
    actingNotes: [],
    logs: [],
  }
  const recorder: unknown = new Proxy(function () {}, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : recorder),
    apply: () => undefined,
  })
  const action = (label: string) => (..._args: unknown[]) => {
    run.actions.push(label)
    return Promise.resolve()
  }
  const known: Record<string, unknown> = {
    // The second lock of person lanes (P3) runs first in every delivery lane.
    ownerLaneVerdict,
    noteLaneMisroute: () => undefined,
    ...streamApply,
    ...inboundChannel,
    ...slashCatalog,
    ...messageText,
    ...pollCore,
    ...meetingCard,
    privateActor,
    // Outgoing email modes: every lane hands the tracker the reason an email_send may name.
    emailSendBasis: (privateTurnModule as Record<string, unknown>).emailSendBasis,
    privateSenderUserId,
    senderUserIdCandidate,
    parsePermissionChoice,
    senderUserIdOf: (m: unknown) => senderUserIdCandidate(m) ?? OWNER,
    privateTurns: { deliver: (d: { content: string }) => d.content, noteUntracked: () => undefined },
    USER_ID: OWNER,
    ASSISTANT_ID,
    channelArmed: true,
    updateDrainMode: false,
    VERDICT_RE: /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i,
    pendingPermissions: new Map([['abcde', {}]]),
    forwardedMessageIds: new Set<number>(),
    rememberForwarded: (id: number) => (known.forwardedMessageIds as Set<number>).add(id),
    chatsPolledSinceBoot: new Set([CHAT]),
    streamCoveredChats: new Set<string>(),
    chatLiveFloor: new Map<string, number>(),
    liveReadsInFlight: new Set<string>(),
    chatFirstListedAtMs: new Map<string, number>(),
    chatLastSeen: new Map([[CHAT, 9000]]),
    chatUnansweredButtons: new Map(),
    meetingIdByChatId: new Map(),
    meetingContexts: new Map(),
    meetingChatIds: new Set(),
    peerConvByChat: new Map(),
    closedPeerChats: new Set<string>(),
    lastInboundUserByChat: run.lastInboundUser,
    registeredSlashCommands: SLASH.registry,
    registeredSlashCommandAliases: SLASH.legacyAliases,
    planPolicyMemo: inboundChannel.createPlanPolicyMemo(),
    FIRST_POLL_RECENT_CUTOFF_MS: null,
    STEER_INTERRUPTED_META: {},
    consumedAsLoginCode: () => false,
    alreadyHandledCompact: () => false,
    alreadyHandledStatus: () => false,
    alreadyHandledLogin: () => false,
    handleRemoteCompact: action('compact'),
    handleStatusCommand: action('status'),
    handleLoginCommand: action('login'),
    onPlanModeOff: action('plan_mode_off'),
    planSteerFor: () => {
      run.actions.push('steer')
      return null
    },
    noteSlashPlanDelivery: () => undefined,
    noteOwnerMessageForStopPause: (_chat: string, input: Record<string, unknown>) => run.stopPause.push(input),
    actingUser: { noteInbound: (n: Record<string, unknown>) => run.actingNotes.push(n) },
    turnChat: { note: (n: { kind: string }) => run.turnKinds.push(n.kind) },
    recordInbound: (_c: string, _m: number, _t: string, kind: string | null | undefined) => run.recorded.push(kind),
    isNotModified: () => false,
    isPendingEmptySystem: () => false,
    trackMessageOperation: (op: () => unknown) => op(),
    deliverInbound: (_steer: unknown, deliver: (interrupted: boolean) => Promise<void>) => deliver(false),
    mcp: {
      notification: async (n: { params: { content: string; meta: Record<string, string> } }) => {
        run.notifications.push({ content: n.params.content, meta: n.params.meta })
      },
    },
    log: (line: string) => run.logs.push(String(line)),
    chatReadFloor: new Map(),
    lockHeld: true,
    socketEpoch: 1,
    chatReadAtEpoch: new Map(),
    DAEMON_START_MS: 0,
    groupChatIds: new Set(),
    emailCursorHolds: { clamp: (_chat: string, id: number) => id, owes: () => false, settle: () => undefined },
    cursorStore: { markDirty: () => undefined },
    chatBehindSocket: () => false,
    bgosEtagCache: new pollCore.EtagCache(),
    emailFilesKeepalive: { during: (work: () => Promise<unknown>) => work() },
    emailFileSavesFor: async () => undefined,
    streamEmailBudget: null,
    streamHeldEmptyChatByMessageId: new Map(),
    roomAgentSettler: { has: () => false, note: () => undefined },
    ...extra,
  }
  const operations = new Set<Promise<unknown>>()
  known.trackMessageOperation = (work: () => unknown) => {
    const op = Promise.resolve().then(work)
    operations.add(op)
    void op.then(() => operations.delete(op), () => operations.delete(op))
    return op
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
  const factory = new Function('scope', `with (scope) {\n${js}\nreturn ${name}\n}`)
  return { api: factory(scope) as any, run, scope: known, drain: async () => {
    while (operations.size) await Promise.allSettled([...operations])
  } }
}


function harness() {
  const listeners = new Map<string, (p: unknown) => unknown>()
  let rows: any[] = []
  const reads: string[] = []
  const functions = ['pollAgentOriginOf', 'pollSenderTypeOf', 'pollPeerConversationIdOf', 'pollTurnStateOf',
    'pollChat', 'deliverWsInbound', 'forwardStreamInbound', 'applyStreamMessage', 'applyStreamUpdate',
    'advanceChatCursor', 'noteCursorPassedUnread', 'settleChatReadFloor', 'noteLiveFloor', 'noteChatReadAtEpoch',
    'advanceStreamChatCursor', 'forwardHumanEdit', 'applyHumanEdit']
  const code = [constSource('EMAIL_NEVER_SLASH'), constSource('humanMessageEdits'),
    ...functions.map(functionSource), socketRegistration('message_edited'), socketRegistration('meeting_message'),
    'const api = { pollChat, deliverWsInbound, applyStreamUpdate }'].join('\n')
  const h = compile(code, 'api', {
    realtimeSocket: { on: (event: string, fn: (p: unknown) => unknown) => listeners.set(event, fn) },
    whenArmed: (_event: string, fn: (p: unknown) => unknown) => (p: unknown) => h.scope.channelArmed && fn(p),
    routeStampedInbound: () => false,
    bgosGet: async (path: string) => { reads.push(path); return { messages: structuredClone(rows), hasMore: false } },
  })
  return { ...h, reads, listeners, setRows: (next: any[]) => { rows = next },
    socket: async (text: string, extra = {}) => { h.api.deliverWsInbound(frame(text, extra)); await h.drain() },
    edit: async (text: string, extra = {}) => { listeners.get('message_edited')?.(frame(text, extra)); await h.drain() },
    poll: async () => { await h.api.pollChat(CHAT); await h.drain() },
    stream: async (kind: string, text: string, extra = {}) => {
      await h.api.applyStreamUpdate({ seq: 10, kind, chatId: Number(CHAT), messageId: 9001, payload: frame(text, extra) })
      await h.drain()
    },
  }
}
function frame(text: string, extra = {}) {
  return { chatId: Number(CHAT), messageId: 9001, userId: OWNER, senderUserId: OWNER,
    senderType: 'user', sender: 'user', text, files: [], messageType: 'standard', ...extra }
}
function row(text: string, extra = {}) {
  return { message: { id: 9001, chatId: Number(CHAT), sender: 'user', senderUserId: OWNER,
    text, messageType: 'standard', sentDate: new Date().toISOString(), ...extra }, messageFiles: [] }
}
function assertEdit(h: ReturnType<typeof harness>, text: string) {
  assert.equal(h.run.notifications.length, 2, `original plus one edit; logs: ${h.run.logs.join(' | ')}`)
  const edit = h.run.notifications[1]!
  assert.match(edit.content, /edit/i)
  assert.match(edit.content, /replaces the earlier version/i)
  assert.ok(edit.content.includes(`> ${text}`), 'new words are quoted')
  assert.equal(edit.meta.event_type, 'message_edited')
  assert.equal(edit.meta.message_id, '9001')
  assert.equal(edit.meta.chat_id, CHAT)
  assert.equal(edit.meta.sender_type, 'user')
}

test('socket: a delivered human message gets one labelled replacement', async () => {
  const h = harness()
  await h.socket('Use the red folder')
  assert.equal(h.run.notifications.length, 1)
  await h.edit('Use the blue folder')
  assertEdit(h, 'Use the blue folder')
  await h.edit('Use the blue folder')
  await h.socket('Use the red folder')
  assert.equal(h.run.notifications.length, 2, 'replayed edit and original are both deduped')
})

test('poll: a changed delivered row below the cursor gets one replacement', async () => {
  const h = harness()
  h.setRows([row('Use the red folder')])
  await h.poll()
  assert.equal(h.run.notifications.length, 1)
  h.setRows([row('Use the blue folder')])
  await h.poll()
  assertEdit(h, 'Use the blue folder')
  await h.poll()
  assert.equal(h.run.notifications.length, 2)
  assert.ok(!h.reads[1]!.includes('afterId='), 'the next read can see an updated existing row')
})

test('stream: finalized and edited updates share replacement dedup with socket and poll', async () => {
  const h = harness()
  await h.stream('message_new', 'Use the red folder')
  await h.stream('message_finalized', 'Use the blue folder')
  assertEdit(h, 'Use the blue folder')
  await h.stream('message_edited', 'Use the blue folder')
  await h.edit('Use the blue folder')
  h.setRows([row('Use the blue folder')])
  await h.poll()
  assert.equal(h.run.notifications.length, 2)
})

test('a socket edit before delivery replaces the original words without an edit card', async () => {
  const h = harness()
  await h.edit('latest words')
  await h.socket('old words')
  assert.equal(h.run.notifications.length, 1)
  assert.ok(h.run.notifications[0]!.content.includes('latest words'))
  assert.ok(!h.run.notifications[0]!.content.includes('old words'))
  assert.notEqual(h.run.notifications[0]!.meta.event_type, 'message_edited')
})

test('a pending edit also replaces an original first delivered by poll or stream', async () => {
  for (const lane of ['poll', 'stream']) {
    const h = harness()
    await h.edit('latest words')
    if (lane === 'poll') { h.setRows([row('old words')]); await h.poll() }
    else await h.stream('message_new', 'old words')
    assert.equal(h.run.notifications.length, 1, lane)
    assert.ok(h.run.notifications[0]!.content.includes('latest words'), lane)
  }
})

test('a sparse edit event uses the delivered human author', async () => {
  const h = harness()
  await h.socket('old words', { senderUserId: 'shared-person', userId: 'shared-person' })
  h.listeners.get('message_edited')?.({ chatId: Number(CHAT), messageId: 9001, text: 'new words' })
  await h.drain()
  assertEdit(h, 'new words')
  assert.equal(h.run.notifications[1]!.meta.user_id, 'shared-person')
})

test('edits share one claim while a notification is in flight and failures remain retryable', async () => {
  const h = harness()
  await h.socket('old words')
  let release!: () => void
  let entered!: () => void
  const entering = new Promise<void>(r => { entered = r })
  const blocked = new Promise<void>(r => { release = r })
  const originalMcp = h.scope.mcp as any
  h.scope.mcp = { notification: async (n: any) => { entered(); await blocked; return originalMcp.notification(n) } }
  h.listeners.get('message_edited')?.(frame('new words'))
  await entering
  const stream = h.api.applyStreamUpdate({ seq: 20, kind: 'message_finalized', chatId: Number(CHAT), messageId: 9001, payload: frame('new words') })
  release()
  await stream
  await h.drain()
  assertEdit(h, 'new words')

  h.scope.mcp = { notification: async () => { throw new Error('transport unavailable') } }
  await h.edit('retry words')
  assert.equal(h.run.notifications.length, 2)
  h.scope.mcp = originalMcp
  await h.edit('retry words')
  assert.equal(h.run.notifications.length, 3)
  await h.edit('retry words')
  assert.equal(h.run.notifications.length, 3)
})

test('an older poll snapshot cannot undo a socket edit delivered during the read', async () => {
  const h = harness()
  await h.socket('original')
  let release!: (v: unknown) => void
  let entered!: () => void
  const entering = new Promise<void>(r => { entered = r })
  h.scope.bgosGet = async () => { entered(); return new Promise(r => { release = r }) }
  const poll = h.api.pollChat(CHAT)
  await entering
  h.listeners.get('message_edited')?.(frame('latest'))
  // Drain only the edit operation: the poll deliberately remains pending.
  await new Promise<void>(r => setImmediate(r))
  release({ messages: [row('intermediate')], hasMore: false })
  await poll
  await h.drain()
  assertEdit(h, 'latest')
})

test('timestamped edits can revert text and reject a stale replay', async () => {
  const h = harness()
  await h.socket('first', { updatedAt: '2026-11-03T10:00:00Z' })
  await h.edit('second', { updatedAt: '2026-11-03T10:01:00Z' })
  await h.edit('first', { updatedAt: '2026-11-03T10:02:00Z' })
  await h.edit('second', { updatedAt: '2026-11-03T10:01:00Z' })
  assert.equal(h.run.notifications.length, 3)
  assert.ok(h.run.notifications[2]!.content.includes('> first'))
})

test('edits of slash-looking text are quoted and never execute a daemon command', async () => {
  const h = harness()
  await h.socket('hello')
  await h.edit('/login')
  assertEdit(h, '/login')
  assert.deepEqual(h.run.actions, [])
})

test('edits respect lane, assistant, stand-down and drain gates', async () => {
  const h = harness()
  await h.socket('hello')
  h.scope.channelArmed = false
  await h.edit('passive')
  h.scope.channelArmed = true
  h.scope.updateDrainMode = true
  await h.edit('draining')
  h.scope.updateDrainMode = false
  await h.edit('wrong assistant', { assistantId: 123 })
  h.scope.ownerLaneVerdict = () => ({ deliver: false })
  await h.edit('wrong lane')
  assert.equal(h.run.notifications.length, 1)
})

test('an unknown old row stays behind the persisted cursor', async () => {
  const h = harness()
  ;(h.scope.chatLastSeen as Map<string, number>).set(CHAT, 9100)
  h.setRows([row('old words have changed')])
  await h.poll()
  await h.stream('message_finalized', 'old words have changed')
  assert.equal(h.run.notifications.length, 0)
})

test('peer, email, system and consumed command rows never become human edits', async () => {
  for (const extra of [
    { sender: 'system', senderType: 'system' },
    { senderType: 'agent', agentOrigin: { sourceAssistantId: 901, sourceName: 'Peer' } },
    { senderType: 'external_email', externalEmail: { emailId: 'mail1' } },
    { senderType: 'room_agent', senderAssistantId: 901 },
  ]) {
    const h = harness()
    await h.socket('original', extra)
    const count = h.run.notifications.length
    await h.edit('changed', extra)
    assert.equal(h.run.notifications.length, count, JSON.stringify(extra))
  }
  const h = harness()
  await h.socket('/status', { messageType: 'slash_command', commandName: 'status' })
  await h.edit('changed')
  assert.equal(h.run.notifications.length, 0)
})

test('poll walks below the newest page to inspect a delivered human row', async () => {
  const h = harness()
  await h.socket('old words')
  const history = [row('new words'), ...Array.from({ length: 51 }, (_, i) => row('agent answer', { id: 9002 + i, sender: 'assistant' }))]
  h.scope.bgosGet = async (path: string) => {
    h.reads.push(path)
    const q = new URL(path, 'http://local').searchParams
    const after = Number(q.get('afterId') ?? 0)
    const before = Number(q.get('beforeId') ?? Infinity)
    const limit = Number(q.get('limit') ?? 50)
    const rows = history.filter(r => r.message.id > after && r.message.id < before)
    return { messages: structuredClone(rows.slice(-limit)), hasMore: rows.length > limit }
  }
  await h.poll()
  assertEdit(h, 'new words')
  assert.equal(h.reads.length, 2)
  assert.ok(h.reads[1]!.includes('beforeId='))
  assert.ok(h.reads[1]!.includes('afterId=9000'), 'older pages retain the lower edit floor')
})

test('a failed older page delivers no edits or new rows and does not move the cursor', async () => {
  const h = harness()
  await h.socket('first')
  await h.socket('second', { messageId: 9051 })
  const cursors = h.scope.chatLastSeen as Map<string, number>
  const before = cursors.get(CHAT)
  let fail = true
  h.scope.bgosGet = async (path: string) => {
    if (path.includes('beforeId=')) {
      if (fail) throw new Error('older page unavailable')
      return { messages: [row('first')], hasMore: false }
    }
    return { messages: [row('second changed', { id: 9051 }), row('new row', { id: 9100 })], hasMore: true }
  }
  await h.poll()
  assert.equal(h.run.notifications.length, 2)
  assert.equal(cursors.get(CHAT), before)
  fail = false
  await h.poll()
  assert.equal(h.run.notifications.length, 4)
  assert.ok(h.run.notifications[2]!.content.includes('> second changed'))
  assert.ok(h.run.notifications[3]!.content.includes('new row'))
  assert.equal(cursors.get(CHAT), 9100, h.run.logs.join(' | '))
})

test('a read started on an older socket epoch cannot mark the new connection caught up', async () => {
  const h = harness()
  await h.socket('old words')
  h.scope.socketEpoch = 2
  let release!: (v: unknown) => void
  let entered!: () => void
  const entering = new Promise<void>(r => { entered = r })
  h.scope.bgosGet = async () => { entered(); return new Promise(r => { release = r }) }
  const poll = h.api.pollChat(CHAT)
  await entering
  h.scope.socketEpoch = 3
  release({ messages: [row('changed words')], hasMore: false })
  await poll
  await h.drain()
  assertEdit(h, 'changed words')
  assert.equal((h.scope.chatReadAtEpoch as Map<string, number>).get(CHAT), 2, h.run.logs.join(' | '))
})

test('a person can revert to earlier words even when the backend omits edit timestamps', async () => {
  const h = harness()
  await h.socket('first')
  await h.edit('second')
  await h.edit('first')
  assert.equal(h.run.notifications.length, 3)
  assert.ok(h.run.notifications[2]!.content.includes('> first'))
  await h.edit('first')
  assert.equal(h.run.notifications.length, 3)
})

test('an unchanged newer revision still prevents an older revision from undoing it', async () => {
  const h = harness()
  await h.socket('first', { editedAt: '2026-11-03T10:00:00Z' })
  await h.edit('second', { editedAt: '2026-11-03T10:02:00Z' })
  await h.edit('second', { updatedAt: '2026-11-03T10:04:00Z' })
  await h.edit('stale', { editedAt: '2026-11-03T10:03:00Z' })
  assert.equal(h.run.notifications.length, 2)
})

test('an edit during original poll or stream preparation is not lost', async () => {
  for (const lane of ['poll', 'stream']) {
    const h = harness()
    let release!: () => void
    let entered!: () => void
    const entering = new Promise<void>(r => { entered = r })
    const wait = new Promise<void>(r => { release = r })
    h.scope.emailFileSavesFor = async () => { entered(); await wait; return undefined }
    h.setRows([row('old words')])
    const original = lane === 'poll' ? h.api.pollChat(CHAT) : h.api.applyStreamUpdate({
      seq: 1, kind: 'message_new', chatId: Number(CHAT), messageId: 9001, payload: frame('old words'),
    })
    await entering
    h.listeners.get('message_edited')?.(frame('latest words'))
    await new Promise<void>(r => setImmediate(r))
    release()
    await original
    await h.drain()
    assert.equal(h.run.notifications.length, 1, lane)
    assert.ok(h.run.notifications[0]!.content.includes('latest words'), lane)
    assert.ok(!h.run.notifications[0]!.content.includes('old words'), lane)
  }
})

test('a queued edit is held after stand-down and can be retried after rearming', async () => {
  const h = harness()
  await h.socket('original')
  let release!: () => void
  let entered!: () => void
  const entering = new Promise<void>(r => { entered = r })
  const wait = new Promise<void>(r => { release = r })
  const originalMcp = h.scope.mcp as any
  h.scope.mcp = { notification: async (n: any) => { entered(); await wait; return originalMcp.notification(n) } }
  h.listeners.get('message_edited')?.(frame('first edit'))
  await entering
  h.listeners.get('message_edited')?.(frame('queued edit'))
  await new Promise<void>(r => setImmediate(r))
  h.scope.channelArmed = false
  release()
  await h.drain()
  assert.equal(h.run.notifications.length, 2)
  h.scope.channelArmed = true
  await h.edit('queued edit')
  assert.equal(h.run.notifications.length, 3)
})

test('human meeting messages retain their room and edits grant no new meeting turn', async () => {
  for (const lane of ['poll', 'twin', 'meeting']) {
    const h = harness()
    const context = { chatId: Number(CHAT), participants: [], currentSpeakerId: Number(ASSISTANT_ID), lastSeenMessageId: 0 }
    ;(h.scope.meetingIdByChatId as Map<string, number>).set(CHAT, 5)
    ;(h.scope.meetingContexts as Map<number, unknown>).set(5, context)
    h.scope.noteMeetingTwin = () => context
    if (lane === 'poll') { h.setRows([row('meeting words')]); await h.poll() }
    else if (lane === 'twin') await h.socket('meeting words', { meetingContext: { meetingId: 5, yourTurn: true } })
    else { h.listeners.get('meeting_message')?.({ ...frame('meeting words'), meetingId: 5, yourTurnFor: [Number(ASSISTANT_ID)] }); await h.drain() }
    assert.equal(h.run.notifications.length, 1, lane)
    await h.edit('corrected meeting words')
    assertEdit(h, 'corrected meeting words')
    assert.equal(h.run.notifications[1]!.meta.meeting_id, '5', lane)
    assert.equal(h.run.notifications[1]!.meta.your_turn, 'NO', lane)
  }
})

test('an edit can clear the text without being mistaken for an undelivered empty message', async () => {
  const h = harness()
  await h.socket('remove these words')
  await h.edit('')
  assertEdit(h, '')
  assert.ok(!h.run.notifications[1]!.content.includes('remove these words'))
})

test('a pending edit is used by the dedicated human meeting delivery', async () => {
  const h = harness()
  await h.edit('latest meeting words')
  h.listeners.get('meeting_message')?.({ ...frame('old meeting words'), meetingId: 5, yourTurnFor: [Number(ASSISTANT_ID)] })
  await h.drain()
  assert.equal(h.run.notifications.length, 1)
  assert.ok(h.run.notifications[0]!.content.includes('latest meeting words'))
  assert.ok(!h.run.notifications[0]!.content.includes('old meeting words'))
})

test('a pending poll edit retains its revision when it becomes the original delivery', async () => {
  for (const duringPreparation of [false, true]) {
    const h = harness()
    const old = { editedAt: '2026-11-03T10:00:00Z' }
    const newer = { editedAt: '2026-11-03T10:01:00Z' }
    h.setRows([row('old', old)])
    if (duringPreparation) {
      let entered!: () => void
      let release!: () => void
      const entering = new Promise<void>(r => { entered = r })
      const wait = new Promise<void>(r => { release = r })
      h.scope.emailFileSavesFor = async () => { entered(); await wait; return undefined }
      const poll = h.api.pollChat(CHAT)
      await entering
      h.listeners.get('message_edited')?.(frame('new', newer))
      await new Promise<void>(r => setImmediate(r))
      release()
      await poll
      await h.drain()
    } else {
      await h.edit('new', newer)
      await h.poll()
    }
    assert.equal(h.run.notifications.length, 1)
    assert.equal(h.run.notifications[0]!.content, 'new')
    await h.edit('old', old)
    assert.equal(h.run.notifications.length, 1, `stale edit after pending (during preparation: ${duringPreparation})`)
  }
})

test('an edit uses the authoritative original actor and does not reuse its consumed fire identity', async () => {
  for (const senderUserId of [OWNER, undefined]) {
    const h = harness()
    const deliveries: any[] = []
    h.scope.privateTurns = { deliver: (d: any) => { deliveries.push(d); return d.content }, noteUntracked: () => '' }
    await h.socket('original', { senderUserId })
    await h.edit('replacement')
    assert.equal(deliveries.length, 2)
    assert.equal(deliveries[1].actingUserId, senderUserId ?? null)
    assert.equal(deliveries[1].fireKey, null, 'the original owner fire may already have opened a turn')
  }
})

test('meeting edits retain the untracked private-tool boundary of their originals', async () => {
  const h = harness()
  const context = { chatId: Number(CHAT), participants: [], currentSpeakerId: Number(ASSISTANT_ID), lastSeenMessageId: 0 }
  ;(h.scope.meetingIdByChatId as Map<string, number>).set(CHAT, 5)
  ;(h.scope.meetingContexts as Map<number, unknown>).set(5, context)
  let privateDeliveries = 0
  let untracked = 0
  h.scope.privateTurns = {
    deliver: (d: any) => { privateDeliveries++; return d.content },
    noteUntracked: () => { untracked++; return '[untracked meeting]' },
  }
  h.setRows([row('meeting words')])
  await h.poll()
  await h.edit('corrected meeting words')
  assertEdit(h, 'corrected meeting words')
  assert.equal(privateDeliveries, 0, 'an edit must not upgrade a meeting into a private owner turn')
  assert.equal(untracked, 2)
})
