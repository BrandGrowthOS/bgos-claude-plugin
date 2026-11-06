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
import type { RoomAgentSettler } from '../lib/room-agent-settle.ts'
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
    pendingInbounds: new Map(),
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
    monitoredChatIds: [],
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
    roomAgentSettler: {
      beginRead: () => ({ liveGeneration: 0, sequence: 0 }),
      has: () => false, note: () => undefined, dropChat: () => undefined, size: () => 0,
    } satisfies RoomAgentSettler<streamApply.StreamMessageView>,
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
    'advanceStreamChatCursor', 'forwardHumanEdit', 'applyHumanEdit', 'readHumanEdit', 'waitForHumanEditCatchup', 'applyMessageDeleted']
  const code = [constSource('EMAIL_NEVER_SLASH'), constSource('humanMessageEdits'), constSource('chatPollsInFlight'),
    ...functions.map(functionSource), socketRegistration('message_edited'), socketRegistration('message_deleted'), socketRegistration('chat_deleted'), socketRegistration('meeting_message'),
    'const api = { pollChat, deliverWsInbound, applyStreamUpdate }'].join('\n')
  const h = compile(code, 'api', {
    realtimeSocket: { on: (event: string, fn: (p: unknown) => unknown) => listeners.set(event, fn) },
    whenArmed: (_event: string, fn: (p: unknown) => unknown) => (p: unknown) => h.scope.channelArmed && fn(p),
    routeStampedInbound: () => false,
    bgosGet: async (path: string) => {
      reads.push(path)
      const query = new URL(path, 'http://fixture').searchParams
      const after = Number(query.get('afterId') ?? -Infinity)
      const before = Number(query.get('beforeId') ?? Infinity)
      return { messages: structuredClone(rows.filter(r => r.message.id > after && r.message.id < before)), hasMore: false }
    },
  })
  const persist = (text: string, extra: any = {}) => {
    const id = Number(extra.messageId ?? 9001)
    const previous = rows.find(r => r.message.id === id)
    const next = row(text, { ...previous?.message, ...extra, id, text })
    rows = [...rows.filter(r => r.message.id !== id), next]
  }
  return { ...h, reads, listeners, persist, setRows: (next: any[]) => { rows = next },
    socket: async (text: string, extra: any = {}) => { if (!rows.some(r => r.message.id === Number(extra.messageId ?? 9001))) persist(text, extra); h.api.deliverWsInbound(frame(text, extra)); await h.drain() },
    edit: async (text: string, extra = {}) => { persist(text, extra); listeners.get('message_edited')?.(frame(text, extra)); await h.drain() },
    poll: async () => { await h.api.pollChat(CHAT); await h.drain() },
    stream: async (kind: string, text: string, extra: any = {}) => {
      if ((kind === 'message_new' && !rows.some(r => r.message.id === Number(extra.messageId ?? 9001))) || kind === 'message_finalized' || kind === 'message_edited') persist(text, extra)
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
  assert.ok(Object.values(edit.meta).every(value => typeof value === 'string'), 'every wake-card metadata value is a string')
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
    if (lane === 'poll') { h.setRows([row('latest words')]); await h.poll() }
    else await h.stream('message_new', 'old words')
    assert.equal(h.run.notifications.length, 1, lane)
    assert.ok(h.run.notifications[0]!.content.includes('latest words'), lane)
  }
})

test('a sparse edit event uses the delivered human author', async () => {
  const h = harness()
  await h.socket('old words', { senderUserId: 'shared-person', userId: 'shared-person' })
  h.persist('new words')
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
  let handoffEntered = false
  const entering = new Promise<void>(r => { entered = () => { handoffEntered = true; r() } })
  const blocked = new Promise<void>(r => { release = r })
  const originalMcp = h.scope.mcp as any
  h.scope.mcp = { notification: async (n: any) => { entered(); await blocked; return originalMcp.notification(n) } }
  h.persist('new words')
  h.listeners.get('message_edited')?.(frame('new words'))
  await new Promise<void>(r => setImmediate(r))
  assert.equal(handoffEntered, true, 'the correction reached the handoff without waiting indefinitely')
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
  h.scope.bgosGet = async (path: string) => { if (path.includes('limit=1&')) return { messages: [row('latest')] }; entered(); return new Promise(r => { release = r }) }
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

// Inject the event/snapshot separately from the backend's current row so that
// replayed frames and stale poll pages cannot silently change the authority.
async function deliverTimestampedEdit(h: ReturnType<typeof harness>, lane: 'socket' | 'poll' | 'stream', text: string, updatedAt: string) {
  if (lane === 'socket') h.listeners.get('message_edited')?.(frame(text, { updatedAt }))
  else if (lane === 'stream') await h.api.applyStreamUpdate({
    seq: 20, kind: 'message_edited', chatId: Number(CHAT), messageId: 9001,
    payload: frame(text, { updatedAt }),
  })
  else {
    const read = h.scope.bgosGet as (path: string) => Promise<unknown>
    h.scope.bgosGet = async (path: string) => path.includes('limit=1&')
      ? read(path)
      : { messages: [row(text, { updatedAt })], hasMore: false }
    try { await h.poll() } finally { h.scope.bgosGet = read }
  }
  await h.drain()
}

for (const lane of ['socket', 'poll', 'stream'] as const) {
  for (const [precision, bTime, cTime] of [
    ['identical timestamps', '2026-11-03T10:02:00.000Z', '2026-11-03T10:02:00.000Z'],
    ['microsecond timestamps', '2026-11-03T10:02:00.000100Z', '2026-11-03T10:02:00.000900Z'],
  ] as const) {
    test(`review R4: ${lane} rejects replayed B after C with ${precision}`, async () => {
      const h = harness()
      await h.socket('A', { updatedAt: '2026-11-03T10:00:00Z' })
      h.persist('B', { updatedAt: bTime })
      await deliverTimestampedEdit(h, lane, 'B', bTime)
      h.persist('C', { updatedAt: cTime })
      await deliverTimestampedEdit(h, lane, 'C', cTime)
      assert.equal(h.run.notifications.length, 3, 'the legitimate equal-time edit arrives')
      assert.ok(h.run.notifications[1]!.content.includes('> B'))
      assert.ok(h.run.notifications[2]!.content.includes('> C'))

      await deliverTimestampedEdit(h, lane, 'B', bTime)
      assert.equal(h.run.notifications.length, 3, 'the current row is still C; replayed B must not become a fourth card')
      await h.poll()
      assert.equal(h.run.notifications.length, 3, 'the next poll must not send a restoring C card')
      assert.ok(h.run.notifications.every(n => Object.values(n.meta).every(v => typeof v === 'string')))
    })

    test(`review R4: ${lane} delivers a later edit and genuine revert with ${precision}`, async () => {
      const h = harness()
      await h.socket('A', { updatedAt: '2026-11-03T10:00:00Z' })
      h.persist('B', { updatedAt: bTime })
      await deliverTimestampedEdit(h, lane, 'B', bTime)
      h.persist('C', { updatedAt: cTime })
      await deliverTimestampedEdit(h, lane, 'C', cTime)
      assert.equal(h.run.notifications.length, 3, 'timestamp equality must not discard the current C')
      assert.ok(h.run.notifications[2]!.content.includes('> C'))

      h.persist('B', { updatedAt: cTime })
      await deliverTimestampedEdit(h, lane, 'B', cTime)
      assert.equal(h.run.notifications.length, 4, 'the authoritative revert is a new correction even at the same time')
      assert.ok(h.run.notifications[3]!.content.includes('> B'))
      await h.poll()
      assert.equal(h.run.notifications.length, 4, 'the genuine revert is delivered once')
    })
  }
}

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
  assert.equal(h.reads.length, 3)
  assert.ok(h.reads[2]!.includes('limit=1&'), 'the unversioned change is checked against the current row')
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
    if (path.includes('limit=1&')) return { messages: [row('second changed', { id: 9051 })], hasMore: false }
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
  assert.ok(h.run.notifications[2]!.content.includes('new row'))
  assert.ok(h.run.notifications[3]!.content.includes('> second changed'))
  assert.equal(cursors.get(CHAT), 9100, h.run.logs.join(' | '))
})

test('a read started on an older socket epoch cannot mark the new connection caught up', async () => {
  const h = harness()
  await h.socket('old words')
  h.scope.socketEpoch = 2
  let release!: (v: unknown) => void
  let entered!: () => void
  const entering = new Promise<void>(r => { entered = r })
  h.scope.bgosGet = async (path: string) => { if (path.includes('limit=1&')) return { messages: [row('changed words')] }; entered(); return new Promise(r => { release = r }) }
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
    h.persist('latest words')
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
  let handoffEntered = false
  const entering = new Promise<void>(r => { entered = () => { handoffEntered = true; r() } })
  const wait = new Promise<void>(r => { release = r })
  const originalMcp = h.scope.mcp as any
  h.scope.mcp = { notification: async (n: any) => { entered(); await wait; return originalMcp.notification(n) } }
  h.persist('first edit')
  h.listeners.get('message_edited')?.(frame('first edit'))
  await new Promise<void>(r => setImmediate(r))
  assert.equal(handoffEntered, true, 'the correction reached the handoff without waiting indefinitely')
  h.persist('queued edit')
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

test('review R1: a replayed unversioned B cannot roll C back or cause a restoring poll card', async () => {
  const h = harness()
  await h.socket('A')
  await h.edit('B')
  await h.edit('C')
  h.listeners.get('message_edited')?.(frame('B'))
  await h.drain()
  assert.equal(h.run.notifications.length, 3, 'the replay must not become a fourth correction')
  await h.poll()
  assert.equal(h.run.notifications.length, 3, 'the poll must not need a fifth restoring card')
})

test('review R1: two trackers distinguish the same old text replay from an authoritative revert', async () => {
  const makeView = (text: string) => streamApply.viewStreamMessage({ seq: 1, kind: 'message_edited', chatId: Number(CHAT), messageId: 9001, payload: frame(text) }, ASSISTANT_ID)!
  const run = async (current: string) => {
    const tracker: any = new streamApply.HumanMessageEdits()
    const delivered = ['A']
    tracker.rememberOriginal(makeView('A'), Promise.resolve())
    const deliver = async (v: any) => { delivered.push(v.text) }
    await tracker.deliverEdit(makeView('B'), deliver, Infinity, async () => makeView('B'))
    await tracker.deliverEdit(makeView('C'), deliver, Infinity, async () => makeView('C'))
    await tracker.deliverEdit(makeView('B'), deliver, Infinity, async () => makeView(current))
    return delivered
  }
  assert.deepEqual(await run('C'), ['A', 'B', 'C'], 'tracker one receives an old frame while the row still says C')
  assert.deepEqual(await run('B'), ['A', 'B', 'C', 'B'], 'tracker two receives a genuine revert to B')
})

test('review R1: a stale unversioned poll snapshot fetched after C is authoritatively reconciled', async () => {
  const h = harness()
  await h.socket('A')
  await h.edit('B')
  await h.edit('C')
  h.scope.bgosGet = async (path: string) => ({ messages: [row(path.includes('limit=1&') ? 'C' : 'B')], hasMore: false })
  await h.poll()
  assert.equal(h.run.notifications.length, 3)
})

test('review R1: stable message revisions reject replay even when edit timestamps are absent', async () => {
  const h = harness()
  await h.socket('A', { revision: 1 })
  await h.edit('B', { revision: 2 })
  await h.edit('C', { revision: 3 })
  await h.edit('B', { revision: 2 })
  assert.equal(h.run.notifications.length, 3)
})

test('review R2: a socket correction waits for this chat on the new epoch, independently of another tracker', async () => {
  const held = harness()
  const ready = harness()
  for (const h of [held, ready]) await h.socket('A', { sentDate: '2026-11-03T10:00:00Z' })
  held.scope.monitoredChatIds = [CHAT]
  held.scope.socketEpoch = 2
  ;(held.scope.chatReadAtEpoch as Map<string, number>).set(CHAT, 1)
  held.scope.chatBehindSocket = (chat: string) => (held.scope.chatReadAtEpoch as Map<string, number>).get(chat) !== held.scope.socketEpoch
  let release!: (v: unknown) => void
  let fetching = false
  held.scope.bgosGet = async () => { fetching = true; return new Promise(r => { release = r }) }
  const reading = held.api.pollChat(CHAT)
  await new Promise<void>(r => setImmediate(r))
  assert.equal(fetching, true, 'the catch-up read started')
  held.listeners.get('message_edited')?.(frame('A corrected', { editedAt: '2026-11-03T10:02:00Z' }))
  await ready.edit('ready correction', { editedAt: '2026-11-03T10:02:00Z' })
  await new Promise<void>(r => setImmediate(r))
  const countWhileHeld = held.run.notifications.length
  release({ messages: [row('A corrected', { editedAt: '2026-11-03T10:02:00Z', sentDate: '2026-11-03T10:00:00Z' }), row('B', { id: 9002, sentDate: '2026-11-03T10:01:00Z' })], hasMore: false })
  await reading
  await held.drain()
  assert.equal(countWhileHeld, 1, 'the correction cannot overtake the held catch-up read')
  assert.equal(ready.run.notifications.length, 2, 'another tracker is not held by this chat barrier')
  assert.ok(held.run.notifications[1]!.content.includes('B'))
  assert.ok(held.run.notifications[2]!.content.includes('> A corrected'))
})

test('review R2: poll catch-up delivers B before the later correction to A', async () => {
  const h = harness()
  await h.socket('A', { sentDate: '2026-11-03T10:00:00Z' })
  h.setRows([
    row('A corrected', { sentDate: '2026-11-03T10:00:00Z', editedAt: '2026-11-03T10:02:00Z' }),
    row('B', { id: 9002, sentDate: '2026-11-03T10:01:00Z' }),
  ])
  await h.poll()
  assert.equal(h.run.notifications.length, 3)
  assert.equal(h.run.notifications[1]!.content, 'B')
  assert.ok(h.run.notifications[2]!.content.includes('> A corrected'))
})

test('review R3: a confirmed message deletion rejects a delayed edit without affecting another tracker', async () => {
  const deleted = harness()
  const live = harness()
  for (const h of [deleted, live]) await h.socket('A')
  await deleted.stream('message_deleted', '')
  await deleted.edit('delayed B')
  await live.edit('legitimate B')
  assert.equal(deleted.run.notifications.length, 1, 'the deleted message must not return')
  assert.equal(live.run.notifications.length, 2, 'tombstones belong to one tracker')
})

test('review R3: a deleted chat rejects late socket and stream edits', async () => {
  const h = harness()
  await h.socket('A')
  await h.stream('chat_deleted', '')
  await h.edit('late B')
  await h.stream('message_finalized', 'late C')
  assert.equal(h.run.notifications.length, 1)
})

test('review R3: deletion clears a pending edit before original delivery by socket or poll', async () => {
  for (const lane of ['socket', 'poll']) {
    const h = harness()
    await h.edit('pending B')
    await h.stream('message_deleted', '')
    if (lane === 'socket') await h.socket('A')
    else { h.setRows([row('A')]); await h.poll() }
    assert.equal(h.run.notifications.length, 0, lane)
  }
})

test('review R3: deletion during an authoritative read cancels the queued correction', async () => {
  const h = harness()
  await h.socket('A')
  let release!: (v: unknown) => void
  let reading = false
  h.scope.bgosGet = async () => { reading = true; return new Promise(r => { release = r }) }
  h.listeners.get('message_edited')?.(frame('B'))
  await new Promise<void>(r => setImmediate(r))
  assert.equal(reading, true)
  await h.api.applyStreamUpdate({ seq: 11, kind: 'message_deleted', chatId: Number(CHAT), messageId: 9001, payload: {} })
  release({ messages: [row('B')], hasMore: false })
  await h.drain()
  assert.equal(h.run.notifications.length, 1)
})

test('review R3: deletion during a transport handoff cannot rearm tracking or later edits', async () => {
  const h = harness()
  await h.socket('A')
  const before = h.run.recorded.length
  let release!: () => void
  let entered = false
  const original = h.scope.mcp as any
  h.scope.mcp = { notification: async (n: any) => { entered = true; await new Promise<void>(r => { release = r }); return original.notification(n) } }
  h.listeners.get('message_edited')?.(frame('B', { editedAt: '2026-11-03T10:02:00Z' }))
  await new Promise<void>(r => setImmediate(r))
  assert.equal(entered, true)
  await h.api.applyStreamUpdate({ seq: 11, kind: 'message_deleted', chatId: Number(CHAT), messageId: 9001, payload: {} })
  release()
  await h.drain()
  assert.equal(h.run.recorded.length, before, 'the completed transport must not rearm a deleted inbound')
  h.scope.mcp = original
  await h.edit('C')
  assert.equal(h.run.notifications.length, 2, 'only the already-started handoff can finish')
})

test('review R3: a legacy socket deletion creates the same tombstone', async () => {
  const h = harness()
  await h.socket('A')
  h.listeners.get('message_deleted')?.({ chatId: Number(CHAT), messageId: 9001 })
  await h.drain()
  await h.edit('late B')
  assert.equal(h.run.notifications.length, 1)
})

for (const lane of ['poll', 'stream']) test(`review R3: deleting during the original ${lane} handoff leaves no inbound tracking`, async () => {
  const h = harness()
  let release!: () => void
  let started = false
  h.scope.mcp = { notification: async () => { started = true; await new Promise<void>(r => { release = r }) } }
  h.setRows([row('A')])
  const original = lane === 'poll' ? h.api.pollChat(CHAT) : h.api.applyStreamUpdate({ seq: 1, kind: 'message_new', chatId: Number(CHAT), messageId: 9001, payload: frame('A') })
  await new Promise<void>(r => setImmediate(r))
  assert.equal(started, true)
  await h.api.applyStreamUpdate({ seq: 2, kind: 'message_deleted', chatId: Number(CHAT), messageId: 9001, payload: {} })
  release()
  await original
  await h.drain()
  assert.equal(h.run.recorded.length, 0)
})

test('review R2: an already-running periodic read in the current epoch also holds a correction', async () => {
  const h = harness()
  await h.socket('A', { sentDate: '2026-11-03T10:00:00Z' })
  h.scope.monitoredChatIds = [CHAT]
  ;(h.scope.chatReadFloor as Map<string, number>).clear()
  let release!: (v: unknown) => void
  h.scope.bgosGet = async () => new Promise(r => { release = r })
  const reading = h.api.pollChat(CHAT)
  await new Promise<void>(r => setImmediate(r))
  h.listeners.get('message_edited')?.(frame('A corrected', { editedAt: '2026-11-03T10:02:00Z' }))
  await new Promise<void>(r => setImmediate(r))
  const before = h.run.notifications.length
  release({ messages: [row('A'), row('B', { id: 9002, sentDate: '2026-11-03T10:01:00Z' })], hasMore: false })
  await reading
  await h.drain()
  assert.equal(before, 1)
  assert.equal(h.run.notifications[1]!.content, 'B')
  assert.ok(h.run.notifications[2]!.content.includes('A corrected'))
})

test('review R1: pending revisions cannot overwrite a newer original and survive original delivery', async () => {
  const newerOriginal = harness()
  await newerOriginal.edit('B', { revision: 2 })
  await newerOriginal.socket('C', { revision: 3 })
  assert.equal(newerOriginal.run.notifications[0]!.content, 'C')
  const newerPending = harness()
  await newerPending.edit('C', { revision: 3 })
  await newerPending.socket('A', { revision: 1 })
  assert.equal(newerPending.run.notifications[0]!.content, 'C')
  await newerPending.edit('B', { revision: 2 })
  assert.equal(newerPending.run.notifications.length, 1, 'the pending revision must become the delivered baseline')
})

test('review R1: a pending unversioned replay cannot overwrite a later authoritative poll row', async () => {
  const h = harness()
  await h.edit('B')
  h.setRows([row('C')])
  await h.poll()
  assert.equal(h.run.notifications.length, 1)
  assert.equal(h.run.notifications[0]!.content, 'C')
})

test('review privacy: an edited sign-in code is withheld from the model', async () => {
  const h = harness()
  const consumed: string[] = []
  h.scope.consumedAsLoginCode = (input: any) => { if (input.text === 'private sign-in code') { consumed.push(input.via); return true }; return false }
  await h.socket('normal words')
  await h.edit('private sign-in code', { editedAt: '2026-11-03T10:02:00Z' })
  assert.equal(h.run.notifications.length, 1)
  assert.deepEqual(consumed, ['ws'])
})

for (const lane of ['poll', 'stream', 'socket']) test(`review R3: a deferred ${lane} callback checks deletion before creating a notification`, async () => {
  const h = harness()
  let callback!: (interrupted: boolean) => Promise<void>
  let release!: () => void
  h.scope.deliverInbound = (_plan: unknown, deliver: (interrupted: boolean) => Promise<void>) => {
    callback = deliver
    return new Promise<void>(r => { release = r })
  }
  h.setRows([row('A')])
  const original = lane === 'poll' ? h.api.pollChat(CHAT) : lane === 'stream'
    ? h.api.applyStreamUpdate({ seq: 1, kind: 'message_new', chatId: Number(CHAT), messageId: 9001, payload: frame('A') })
    : h.api.deliverWsInbound(frame('A'))
  await new Promise<void>(r => setImmediate(r))
  assert.equal(typeof callback, 'function')
  await h.api.applyStreamUpdate({ seq: 2, kind: lane === 'stream' ? 'chat_deleted' : 'message_deleted', chatId: Number(CHAT), messageId: 9001, payload: {} })
  await callback(false)
  release()
  await original
  await h.drain()
  assert.equal(h.run.notifications.length, 0)
})

test('review R1: an unversioned replay received during original preparation is reconciled', async () => {
  const h = harness()
  h.setRows([row('C')])
  let release!: () => void
  let preparing = false
  h.scope.emailFileSavesFor = async () => { preparing = true; await new Promise<void>(r => { release = r }); return undefined }
  const original = h.api.pollChat(CHAT)
  await new Promise<void>(r => setImmediate(r))
  assert.equal(preparing, true)
  h.listeners.get('message_edited')?.(frame('B'))
  await new Promise<void>(r => setImmediate(r))
  release()
  await original
  await h.drain()
  assert.equal(h.run.notifications.length, 1)
  assert.equal(h.run.notifications[0]!.content, 'C')
})

for (const lane of ['poll', 'stream']) test(`review privacy: a pending sign-in code during ${lane} preparation stays private`, async () => {
  const h = harness()
  h.setRows([row('normal words')])
  h.scope.consumedAsLoginCode = (input: any) => input.text === 'private sign-in code'
  let release!: () => void
  let preparing = false
  h.scope.emailFileSavesFor = async () => { preparing = true; await new Promise<void>(r => { release = r }); return undefined }
  const original = lane === 'poll' ? h.api.pollChat(CHAT) : h.api.applyStreamUpdate({ seq: 1, kind: 'message_new', chatId: Number(CHAT), messageId: 9001, payload: frame('normal words') })
  await new Promise<void>(r => setImmediate(r))
  assert.equal(preparing, true)
  h.persist('private sign-in code')
  h.listeners.get('message_edited')?.(frame('private sign-in code'))
  await new Promise<void>(r => setImmediate(r))
  release()
  await original
  await h.drain()
  assert.equal(h.run.notifications.length, 0)
  assert.ok(h.run.logs.every(line => !line.includes('private sign-in code')))
})

test('review R1: pending unversioned replay is reconciled before a delayed socket original', async () => {
  const h = harness()
  await h.edit('B')
  h.setRows([row('C')])
  h.api.deliverWsInbound(frame('A'))
  await h.drain()
  assert.equal(h.run.notifications.length, 1)
  assert.equal(h.run.notifications[0]!.content, 'C')
})

test('review privacy: a pending meeting sign-in code stays private', async () => {
  const h = harness()
  await h.edit('private sign-in code')
  h.scope.consumedAsLoginCode = (input: any) => input.text === 'private sign-in code'
  h.listeners.get('meeting_message')?.({ ...frame('normal words'), meetingId: 5, yourTurnFor: [Number(ASSISTANT_ID)] })
  await h.drain()
  assert.equal(h.run.notifications.length, 0)
})

test('review R1: stream originals preserve the raw row until pending replay reconciliation', async () => {
  const h = harness()
  await h.edit('B')
  h.setRows([row('C')])
  await h.api.applyStreamUpdate({ seq: 1, kind: 'message_new', chatId: Number(CHAT), messageId: 9001, payload: frame('C') })
  await h.drain()
  assert.equal(h.run.notifications.length, 1)
  assert.equal(h.run.notifications[0]!.content, 'C')
})

test('review R1: a replay arriving during the poll fetch cannot mask the authoritative row', async () => {
  const h = harness()
  h.scope.bgosGet = async (path: string) => {
    if (!path.includes('limit=1&')) {
      h.listeners.get('message_edited')?.(frame('B'))
      await new Promise<void>(r => setImmediate(r))
    }
    return { messages: [row('C')], hasMore: false }
  }
  await h.poll()
  assert.equal(h.run.notifications.length, 1)
  assert.equal(h.run.notifications[0]!.content, 'C')
})

test('review R1: an empty stale stream original cannot hide a pending edited body', async () => {
  const h = harness()
  await h.edit('B')
  await h.stream('message_new', '')
  await h.stream('message_finalized', 'B')
  assert.equal(h.run.notifications.length, 1)
  assert.equal(h.run.notifications[0]!.content, 'B')
  assert.notEqual(h.run.notifications[0]!.meta.event_type, 'message_edited')
})
