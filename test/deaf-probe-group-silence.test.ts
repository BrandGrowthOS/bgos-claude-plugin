/**
 * The deaf-session probe on a group message the agent was right to ignore
 * (HOAI board row 59a6d097).
 *
 * THE CASE. Voxor (agent 901), chat 3821, a group of four people. On
 * 2026-10-17 a person's message (131582) reached the agent at 15:15Z as a
 * FOLLOW-UP: BGOS hands the agents a message woke the next two messages in the
 * chat, framed with the words "You were not named in this message ... stay
 * silent and send nothing". The agent stayed silent, correctly. The daemon
 * armed its reply tracker anyway, because inboundOwesReply decides by sender
 * kind alone, so it nudged at 15:19Z and then probed with channel_ack every
 * 12.5 minutes (the ack refreshes recency, the probe resets, recency lapses
 * again) for four and a half hours, 23 probes for one message, and at
 * 20:00:01Z it posted the launch guidance INTO the group, where four people
 * read it. On 2026-10-18 it did the same for message 134326 (11 probes).
 * Every line is in ~/.bgos-agent/logs/bgos-plugin-901.log.
 *
 * What these tests hold, the lanes RUN out of server.ts with the real tracker
 * (recordInbound) and the real ladder (checkReplyOverdue) on a fake clock:
 *   - a group message that does not address this agent (the follow-up framing
 *     on the socket and the stream; on the poll, a shared chat row that names
 *     nobody) arms no tracker: no nudge, no probe, nothing posted;
 *   - an addressed group message and an owner chat message keep today's
 *     tracker and nudge, and are probed at most ONCE per pending message;
 *   - the probe text claims no restart unless one happened;
 *   - the launch guidance goes to the owner's own chat only, never into a chat
 *     other people read, and nowhere when no owner chat is known.
 *
 * The framed texts are BGOS's frameAgentDispatchText output (group-context.ts
 * at BGOS 4d2cbc27d), rendered by running that function, byte for byte.
 *
 * New exports are read through namespace imports, so on a build without them
 * only the tests that need them fail and every control still runs.
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
import * as channelLivenessModule from '../lib/channel-liveness.ts'
import * as bootHello from '../lib/boot-hello.ts'
import { createChatOwnership } from '../lib/chat-ownership.ts'

const lv = channelLivenessModule as Record<string, any>
const bh = bootHello as Record<string, any>

const OWNER = 'user_owner'
const PERSON = 'user_maya'
const ASSISTANT_ID = '901'
const GROUP = '3821'
const OWNER_CHAT = '1048'
const TS = '2026-10-17T15:15:00.000Z'
/** REPLY_OVERDUE_MS in server.ts. */
const WINDOW_MS = 240_000
/** checkReplyOverdue's interval in server.ts. */
const TICK_MS = 30_000
const HOUR = 3_600_000

const SHARED_TAIL =
  'Only this group is shared context. Your private chats with your owner, your other chats and groups, ' +
  'and anything you know from work done outside this group stay private. Do not repeat them, refer to them, ' +
  'or act on them here unless someone in this group raises them first.'
const FOLLOW_UP_LINE =
  'You were not named in this message. You were woken in this group by a recent message, so you also see ' +
  'the next messages after it as a follow-up. Reply only if it is meant for you; if it is not, stay silent ' +
  'and send nothing.'
const ROOM_HEAD = [
  '[BGOS group: Launch]',
  'You are in a group, not a private chat. Everyone listed here reads what you say.',
  'People here: Kc, Maya.',
  'Agents here: Voxor (you).',
  'Said in this group since your last turn, oldest first:',
  '- Kc: Lunch at one?',
  'Maya wrote the message below.',
]
/** A person's message handed over as a follow-up: it did not name this agent. */
const FOLLOW_UP_FRAMED = [...ROOM_HEAD, FOLLOW_UP_LINE, SHARED_TAIL].join('\n') + '\n\nSounds good, see you there.'
/** The same room, a person naming this agent: an address. */
const ADDRESSED_FRAMED = [...ROOM_HEAD, SHARED_TAIL].join('\n') + '\n\n@Voxor can you book the table?'
/** A follow-up whose room could not be read (followUpWithoutRoster): still says so. */
const FOLLOW_UP_NO_ROSTER = [
  '[BGOS group]',
  'You are in a group, not a private chat. Everyone listed here reads what you say.',
  FOLLOW_UP_LINE,
  SHARED_TAIL,
].join('\n') + '\n\nok'

const GROUP_CONTEXT = {
  chatKind: 'room',
  chatTitle: 'Launch',
  mentionedBy: 'Maya',
  participants: [
    { userId: OWNER, displayName: 'Kc', relationship: 'owner' },
    { userId: PERSON, displayName: 'Maya', relationship: 'member' },
  ],
  agents: [{ assistantId: Number(ASSISTANT_ID), name: 'Voxor', isYou: true }],
  messages: [{ senderDisplayName: 'Kc', text: 'Lunch at one?', sentAt: TS }],
}

/** The socket's inbound_message for a person in the room (turn-wake-delivery.service.ts). */
function wsGroupMessage(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    assistantId: Number(ASSISTANT_ID),
    userId: PERSON,
    chatId: Number(GROUP),
    messageId: 131582,
    text: FOLLOW_UP_FRAMED,
    files: [],
    messageType: 'standard',
    sender: { userId: PERSON, displayName: 'Maya', relationship: 'room_member' },
    groupContext: GROUP_CONTEXT,
    sessionHandle: 'sh_room_3821',
    ...over,
  }
}

function wsAddressedGroupMessage(over: Record<string, unknown> = {}): Record<string, any> {
  return wsGroupMessage({
    messageId: 131590,
    text: ADDRESSED_FRAMED,
    mentions: [{ kind: 'agent', id: ASSISTANT_ID, name: 'Voxor' }],
    ...over,
  })
}

/** The owner in the agent's own main chat: no framing, nobody else reads it. */
function wsOwnerMessage(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    assistantId: Number(ASSISTANT_ID),
    userId: OWNER,
    chatId: Number(OWNER_CHAT),
    messageId: 131600,
    text: 'Can you check the build?',
    files: [],
    messageType: 'standard',
    sender: { userId: OWNER, displayName: 'Kc', relationship: 'owner' },
    sessionHandle: 'sh_main_1048',
    ...over,
  }
}

// ── server.ts, RUN: a lane, the real tracker and the real ladder ────────────

const SRC = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function serverFunction(header: string, end = '\n}\n'): string {
  const start = SRC.indexOf(`\n${header}`)
  assert.ok(start >= 0, `${header} exists in server.ts`)
  const stop = SRC.indexOf(end, start)
  assert.ok(stop > start)
  return SRC.slice(start + 1, stop + end.length)
}

function serverConst(name: string): string {
  const m = SRC.match(new RegExp(`\\nconst ${name}\\b[^\\n]*\\n`))
  return m ? m[0].slice(1) : ''
}

const SLASH = prepareSlashCommands(BUILTIN_COMMANDS)

interface Daemon {
  lane: (...args: unknown[]) => unknown
  checkReplyOverdue: () => void
  pendingInbounds: Map<string, { messageId: number }>
  cards: Array<{ content: string; meta: Record<string, string> }>
  notices: Array<{ chatId: string; text: string }>
  logs: string[]
  liveness: InstanceType<typeof channelLivenessModule.ChannelLiveness>
  now: () => number
  /** Ticks checkReplyOverdue every 30 s for `ms`; acks every probe at once when asked. */
  runFor(ms: number, opts?: { ackProbes?: boolean }): Promise<void>
  ofType(eventType: string): Array<{ content: string; meta: Record<string, string> }>
}

/**
 * One lane of server.ts compiled together with the real recordInbound and
 * checkReplyOverdue, so the lane hands the tracker exactly what it hands it in
 * the daemon. The clock is fake; `Date` inside the compiled code reads it.
 */
function daemon(laneSource: string, laneName: string, extra: Record<string, unknown> = {}): Daemon {
  let clock = Date.parse(TS)
  const RealDate = Date
  class FakeDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clock)
      else super(...(args as [string | number]))
    }
    static now(): number {
      return clock
    }
  }
  const source = [
    laneSource,
    serverFunction('function recordInbound('),
    serverFunction('function checkReplyOverdue('),
  ].join('\n').replace(/import\.meta\.url/g, 'IMPORT_META_URL')
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const cards: Daemon['cards'] = []
  const notices: Daemon['notices'] = []
  const logs: string[] = []
  const liveness = new channelLivenessModule.ChannelLiveness()
  const pendingInbounds = new Map()
  const ownership = createChatOwnership(OWNER)
  ownership.noteRow({ chatId: OWNER_CHAT, kind: 'main', userId: OWNER })
  ownership.noteRow({ chatId: GROUP, kind: 'room' })
  const recorder: unknown = new Proxy(function () {}, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : recorder),
    apply: () => undefined,
  })
  const forwarded = new Set<number>()
  const known: Record<string, unknown> = {
    ownerLaneVerdict,
    noteLaneMisroute: () => undefined,
    ...inboundChannel,
    ...slashCatalog,
    ...messageText,
    ...pollCore,
    ...meetingCard,
    ...streamApply,
    ...channelLivenessModule,
    ...bootHello,
    privateActor,
    emailSendBasis: (privateTurnModule as Record<string, unknown>).emailSendBasis,
    privateFireKey: (privateTurnModule as Record<string, unknown>).privateFireKey,
    privateSenderUserId,
    senderUserIdCandidate,
    parsePermissionChoice,
    senderUserIdOf: (m: unknown) => senderUserIdCandidate(m) ?? OWNER,
    privateTurns: { deliver: (d: Record<string, any>) => d.content, noteUntracked: () => undefined },
    USER_ID: OWNER,
    ASSISTANT_ID,
    channelArmed: true,
    updateDrainMode: false,
    VERDICT_RE: /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i,
    pendingPermissions: new Map(),
    forwardedMessageIds: forwarded,
    rememberForwarded: (id: number) => forwarded.add(id),
    chatsPolledSinceBoot: new Set([GROUP, OWNER_CHAT]),
    streamCoveredChats: new Set<string>(),
    chatLiveFloor: new Map<string, number>(),
    liveReadsInFlight: new Set<string>(),
    chatFirstListedAtMs: new Map<string, number>(),
    streamHeldEmptyChatByMessageId: new Map<number, string>(),
    chatLastSeen: new Map([[GROUP, 9000], [OWNER_CHAT, 9000]]),
    chatUnansweredButtons: new Map(),
    FIRST_POLL_RECENT_CUTOFF_MS: null,
    isNotModified: () => false,
    isPendingEmptySystem: () => false,
    meetingIdByChatId: new Map(),
    meetingContexts: new Map(),
    meetingChatIds: new Set<string>(),
    peerConvByChat: new Map(),
    closedPeerChats: new Set<string>(),
    lastInboundUserByChat: new Map(),
    registeredSlashCommands: SLASH.registry,
    registeredSlashCommandAliases: SLASH.legacyAliases,
    planPolicyMemo: inboundChannel.createPlanPolicyMemo(),
    STEER_INTERRUPTED_META: {},
    consumedAsLoginCode: () => false,
    alreadyHandledCompact: () => false,
    alreadyHandledStatus: () => false,
    alreadyHandledLogin: () => false,
    planSteerFor: () => null,
    deliverInbound: (_steer: unknown, deliver: (interrupted: boolean) => Promise<void>) => deliver(false),
    trackMessageOperation: (op: () => unknown) => op(),
    mcp: {
      notification: async (n: { params: { content: string; meta: Record<string, string> } }) => {
        cards.push({ content: n.params.content, meta: n.params.meta })
      },
    },
    log: (line: string) => logs.push(String(line)),
    // The tracker and the ladder, as server.ts keeps them.
    pendingInbounds,
    REPLY_OVERDUE_MS: WINDOW_MS,
    channelLiveness: liveness,
    deafProbeSentAt: null,
    deafEscalationDone: false,
    deafEscalatedAt: null,
    // Whose each chat is: the owner's main chat, and a group.
    mainChatIds: [OWNER_CHAT],
    groupChatIds: new Set<string>(),
    chatOwnership: ownership,
    sendConnectionNotice: async (chatId: string, text: string) => {
      notices.push({ chatId: String(chatId), text })
    },
    IMPORT_META_URL: 'file:///plugin/server.ts',
    Date: FakeDate,
    ...extra,
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
  const lifted = new Function('scope', `with (scope) {\n${js}\nreturn { lane: ${laneName}, checkReplyOverdue }\n}`)(scope) as {
    lane: (...args: unknown[]) => unknown
    checkReplyOverdue: () => void
  }
  const ofType = (eventType: string) => cards.filter((c) => c.meta.event_type === eventType)
  return {
    ...lifted,
    pendingInbounds,
    cards,
    notices,
    logs,
    liveness,
    now: () => clock,
    ofType,
    async runFor(ms, opts = {}) {
      const end = clock + ms
      while (clock < end) {
        clock += TICK_MS
        const probesBefore = ofType('liveness_probe').length
        lifted.checkReplyOverdue()
        await new Promise((r) => setImmediate(r))
        // The session hears the channel: it answers a probe with channel_ack
        // (a tool call), and sends nothing to the group.
        if (opts.ackProbes && ofType('liveness_probe').length > probesBefore) liveness.markToolCall(clock)
      }
    },
  }
}

function wsDaemon(extra: Record<string, unknown> = {}): Daemon {
  return daemon(
    [serverConst('EMAIL_NEVER_SLASH'), serverFunction('  function deliverWsInbound(payload: any, emailSaves?: Array<EmailFileSave | null>): void {', '\n  }\n')].join('\n'),
    'deliverWsInbound',
    extra,
  )
}

function streamDaemon(extra: Record<string, unknown> = {}): Daemon {
  return daemon(
    [serverConst('EMAIL_NEVER_SLASH'), serverFunction('async function forwardStreamInbound(')].join('\n'),
    'forwardStreamInbound',
    extra,
  )
}

function pollDaemon(rows: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Daemon {
  return daemon(
    [
      serverConst('EMAIL_NEVER_SLASH'),
      serverFunction('function pollAgentOriginOf('),
      serverFunction('function pollSenderTypeOf('),
      serverFunction('function pollPeerConversationIdOf('),
      serverFunction('function pollTurnStateOf('),
      serverFunction('async function pollChat('),
    ].join('\n'),
    'pollChat',
    { bgosGet: async () => ({ messages: rows }), ...extra },
  )
}

function assertAllStrings(meta: Record<string, unknown>, label: string): void {
  for (const [k, v] of Object.entries(meta)) {
    assert.equal(typeof v, 'string', `${label}: meta.${k} must be a string (got ${v === null ? 'null' : typeof v}); the host drops the card otherwise`)
  }
}

/** Nothing about the message reached the session or the chat after its delivery. */
function assertSilentForHours(d: Daemon, label: string): void {
  assert.equal(d.ofType('reply_overdue').length, 0, `${label}: no reply nudge (log: ${d.logs.join(' | ')})`)
  assert.equal(d.ofType('liveness_probe').length, 0, `${label}: no probe`)
  assert.deepEqual(d.notices, [], `${label}: nothing posted into any chat`)
  assert.equal(d.logs.filter((l) => /deaf session/.test(l)).length, 0, `${label}: no deaf verdict: ${d.logs.join(' | ')}`)
}

// ── 1. a human-to-human group message arms nothing ───────────────────────────

test('THE CASE (901, chat 3821): a person\'s follow-up in a group arms no reply tracker on the socket, so no nudge, no probe and nothing posted for hours', async () => {
  const d = wsDaemon()
  d.lane(wsGroupMessage())
  assert.equal(d.ofType('reply_overdue').length + d.ofType('liveness_probe').length, 0)
  assert.equal(d.cards.length, 1, 'the message itself is still delivered')
  assert.equal(d.cards[0]!.content, FOLLOW_UP_FRAMED, 'unchanged, framing and all')
  assert.equal(d.pendingInbounds.has(GROUP), false, 'no reply tracker for a message that did not address the agent')
  // The agent stays silent and makes no tool call, as it did on 2026-10-17.
  await d.runFor(5 * HOUR)
  assertSilentForHours(d, 'socket follow-up')
})

test('a follow-up whose room could not be read still arms nothing (the framing says so with no roster)', async () => {
  const d = wsDaemon()
  d.lane(wsGroupMessage({ text: FOLLOW_UP_NO_ROSTER, groupContext: undefined }))
  assert.equal(d.pendingInbounds.has(GROUP), false)
  await d.runFor(HOUR)
  assertSilentForHours(d, 'no roster')
})

test('stream: the same follow-up, hydrated, arms nothing either', async () => {
  const d = streamDaemon()
  const view = streamApply.viewStreamMessage(
    {
      seq: 7,
      kind: 'message_new',
      chatId: Number(GROUP),
      messageId: 131582,
      payload: {
        text: FOLLOW_UP_FRAMED,
        chatKind: 'room',
        sender: 'user',
        messageType: 'standard',
        senderUserId: PERSON,
        senderDisplayName: 'Maya',
        senderRelationship: 'room_member',
        groupContext: GROUP_CONTEXT,
        files: [],
      },
    } as never,
    ASSISTANT_ID,
  )
  assert.ok(view)
  await d.lane(view, false)
  assert.equal(d.cards.length, 1, 'delivered')
  assert.equal(d.pendingInbounds.has(GROUP), false)
  await d.runFor(2 * HOUR)
  assertSilentForHours(d, 'stream follow-up')
})

test('poll: a shared chat row that names nobody arms nothing; one that names this agent, and the owner\'s own chat, arm as before', async () => {
  // The history route serves a shared chat's rows as stored: no framing, but
  // with the server's parsed mentions (BGOS MessageDto.mentions). BGOS wakes
  // the chat's agent there only on a mention of it or a slash command.
  const row = (id: number, text: string, mentions: unknown, messageType = 'standard') => ({
    message: { id, chatId: Number(GROUP), text, sender: 'user', senderUserId: PERSON, messageType, sentDate: TS, mentions },
    messageFiles: [],
  })
  const unaddressed = pollDaemon([row(9101, 'Lunch at one?', null)], { groupChatIds: new Set([GROUP]) })
  await unaddressed.lane(GROUP)
  assert.equal(unaddressed.cards.length, 1, 'delivered')
  assert.equal(unaddressed.pendingInbounds.has(GROUP), false, 'a row that names nobody owes no reply')
  await unaddressed.runFor(2 * HOUR)
  assertSilentForHours(unaddressed, 'poll shared chat, nobody named')

  const toSomeoneElse = pollDaemon([row(9102, '@Maya see you there', [{ kind: 'user', id: PERSON, name: 'Maya' }])], { groupChatIds: new Set([GROUP]) })
  await toSomeoneElse.lane(GROUP)
  assert.equal(toSomeoneElse.pendingInbounds.has(GROUP), false, 'a row that names another person owes this agent no reply')

  const named = pollDaemon([row(9103, '@Voxor book it', [{ kind: 'agent', id: ASSISTANT_ID, name: 'Voxor' }])], { groupChatIds: new Set([GROUP]) })
  await named.lane(GROUP)
  assert.equal(named.pendingInbounds.get(GROUP)?.messageId, 9103, 'a row naming this agent arms the tracker')

  // A command the session runs (a directive). /status and the like are the
  // daemon's own answers and never reach the tracker, on any build.
  const slashRow = row(9104, '/review the launch plan', null, 'slash_command')
  Object.assign(slashRow.message, { commandName: 'review', commandArgs: 'the launch plan' })
  const slash = pollDaemon([slashRow], { groupChatIds: new Set([GROUP]) })
  await slash.lane(GROUP)
  assert.equal(slash.cards.length, 1, `delivered (log: ${slash.logs.join(' | ')})`)
  assert.equal(slash.pendingInbounds.get(GROUP)?.messageId, 9104, 'a slash command addresses the agent too')

  const ownerRow = { message: { id: 9105, chatId: Number(OWNER_CHAT), text: 'Can you check the build?', sender: 'user', senderUserId: OWNER, messageType: 'standard', sentDate: TS }, messageFiles: [] }
  const owner = pollDaemon([ownerRow], { groupChatIds: new Set([GROUP]) })
  await owner.lane(OWNER_CHAT)
  assert.equal(owner.pendingInbounds.get(OWNER_CHAT)?.messageId, 9105, 'the owner\'s own chat names nobody and still owes a reply')
})

// ── 2. an addressed group message: today's tracker, one probe ───────────────

test('an addressed group message keeps today\'s tracker and nudge, and is probed ONCE however long it waits', async () => {
  const d = wsDaemon()
  d.lane(wsAddressedGroupMessage())
  assert.equal(d.pendingInbounds.get(GROUP)?.messageId, 131590, 'a message naming the agent arms the tracker, as today')
  await d.runFor(WINDOW_MS)
  assert.equal(d.ofType('reply_overdue').length, 1, 'the nudge fires at four minutes, as today')
  assertAllStrings(d.ofType('reply_overdue')[0]!.meta, 'reply_overdue')
  // The session hears the channel and answers every probe, but never replies
  // to the message: the 2026-10-18 loop (11 probes for message 134326).
  await d.runFor(6 * HOUR, { ackProbes: true })
  const probes = d.ofType('liveness_probe')
  assert.equal(probes.length, 1, `one probe for one pending message, got ${probes.length}: ${d.logs.filter((l) => /probing/.test(l)).join(' | ')}`)
  assertAllStrings(probes[0]!.meta, 'liveness_probe')
  assert.deepEqual(d.notices, [], 'an answered probe never earns a warning')
})

test('a newer addressed message is a new pending message and may be probed once more', async () => {
  const d = wsDaemon()
  d.lane(wsAddressedGroupMessage())
  await d.runFor(2 * HOUR, { ackProbes: true })
  assert.equal(d.ofType('liveness_probe').length, 1)
  d.lane(wsAddressedGroupMessage({ messageId: 131700 }))
  await d.runFor(2 * HOUR, { ackProbes: true })
  assert.equal(d.ofType('liveness_probe').length, 2, 'the latch is per pending message, not per boot')
})

// ── 3. an owner chat message: today's tracker, an honest probe ───────────────

test('an owner chat message keeps today\'s tracker, and its probe does not claim a restart that did not happen', async () => {
  const d = wsDaemon()
  d.lane(wsOwnerMessage())
  assert.equal(d.pendingInbounds.get(OWNER_CHAT)?.messageId, 131600)
  await d.runFor(3 * HOUR, { ackProbes: true })
  assert.equal(d.ofType('reply_overdue').length, 1)
  assert.equal(d.ofType('reply_overdue')[0]!.meta.owner_inbound, 'true')
  const probes = d.ofType('liveness_probe')
  assert.equal(probes.length, 1, `got ${probes.length}`)
  assert.doesNotMatch(probes[0]!.content, /restart/i, 'no restart happened: the probe must not say one did')
  assert.match(probes[0]!.content, /channel_ack/)
  assert.match(probes[0]!.content, /Do NOT send any message to the user/)
})

// ── 4. the escalation target ─────────────────────────────────────────────────

test('THE CASE (2026-10-17T20:00Z): the launch guidance for a group message goes to the owner\'s own chat, never into the group', async () => {
  const d = wsDaemon()
  d.lane(wsAddressedGroupMessage())
  // The session never answers anything: a deaf session.
  await d.runFor(HOUR)
  assert.equal(d.ofType('liveness_probe').length, 1)
  assert.equal(d.notices.length, 1, `the warning is posted once (log: ${d.logs.join(' | ')})`)
  assert.equal(d.notices[0]!.chatId, OWNER_CHAT, 'to the owner\'s own chat')
  assert.ok(d.notices.every((n) => n.chatId !== GROUP), 'never into the group four people read')
  assert.match(d.notices[0]!.text, /hoai doctor/)
})

test('with no owner chat known, the launch guidance is posted nowhere (never into the group as a fallback)', async () => {
  const d = wsDaemon({ mainChatIds: [], chatOwnership: createChatOwnership(OWNER) })
  d.lane(wsAddressedGroupMessage())
  await d.runFor(HOUR)
  assert.equal(d.ofType('liveness_probe').length, 1, 'still asked')
  assert.deepEqual(d.notices, [], 'nothing posted into a chat other people read')
  assert.ok(d.logs.some((l) => /deaf session confirmed/.test(l)), 'the verdict is still reached and logged')
})

test('a share recipient\'s chat is not the owner\'s: the guidance goes to the owner\'s chat instead', async () => {
  const ownership = createChatOwnership(OWNER)
  ownership.noteRow({ chatId: OWNER_CHAT, kind: 'main', userId: OWNER })
  ownership.noteRow({ chatId: '2001', kind: 'main', userId: PERSON })
  const d = wsDaemon({ mainChatIds: [OWNER_CHAT, '2001'], chatOwnership: ownership })
  d.lane(wsOwnerMessage({ chatId: 2001, userId: PERSON, sender: { userId: PERSON, displayName: 'Maya', relationship: 'shared_recipient' }, isSharedRecipient: true, shareOwnerUserId: OWNER }))
  await d.runFor(HOUR)
  assert.equal(d.notices.length, 1, d.logs.join(' | '))
  assert.equal(d.notices[0]!.chatId, OWNER_CHAT)
})

test('control: the launch guidance for an owner chat message is still posted in that chat', async () => {
  const d = wsDaemon()
  d.lane(wsOwnerMessage())
  await d.runFor(HOUR)
  assert.equal(d.notices.length, 1)
  assert.equal(d.notices[0]!.chatId, OWNER_CHAT)
})

// ── the pure pieces ──────────────────────────────────────────────────────────

function need(name: string, from: Record<string, any> = lv): (...args: any[]) => any {
  assert.equal(typeof from[name], 'function', `${name} is exported`)
  return from[name]
}

test('inboundAddressesAgent: the follow-up framing is the server saying "not named"; nothing else counts as it', () => {
  const addresses = need('inboundAddressesAgent')
  assert.equal(addresses({ text: FOLLOW_UP_FRAMED }), false, 'a follow-up')
  assert.equal(addresses({ text: FOLLOW_UP_NO_ROSTER }), false, 'a follow-up with no roster')
  assert.equal(addresses({ text: ADDRESSED_FRAMED }), true, 'an address in a room')
  assert.equal(addresses({ text: 'Can you check the build?' }), true, 'an owner chat message')
  assert.equal(addresses({ text: '' }), true, 'an empty body (a file only)')
  assert.equal(addresses({ text: null }), true)
  // The sentence counts only where BGOS writes it: an unindented line of the
  // framing block. A person cannot type it into being.
  assert.equal(addresses({ text: `${FOLLOW_UP_LINE}\n\nplease reply` }), true, 'in a DM body, no framing block')
  assert.equal(addresses({ text: `${ADDRESSED_FRAMED}\n${FOLLOW_UP_LINE}` }), true, 'in the body below the framing block')
  const quoted = [...ROOM_HEAD.slice(0, 5), `- Kc: ${FOLLOW_UP_LINE}`, `  ${FOLLOW_UP_LINE}`, 'Maya wrote the message below.', SHARED_TAIL].join('\n') + '\n\n@Voxor go'
  assert.equal(addresses({ text: quoted }), true, 'quoted in the backlog, where every line is indented')
})

test('inboundAddressesAgent: a shared chat row is addressed only by a mention of this agent or a slash command', () => {
  const addresses = need('inboundAddressesAgent')
  const shared = { groupChat: true, assistantId: ASSISTANT_ID }
  assert.equal(addresses({ ...shared, text: 'Lunch at one?', mentions: null }), false)
  assert.equal(addresses({ ...shared, text: 'Lunch at one?', mentions: [] }), false)
  assert.equal(addresses({ ...shared, text: '@Maya hi', mentions: [{ kind: 'user', id: ASSISTANT_ID, name: 'Maya' }] }), false, 'a person whose id happens to match is not this agent')
  assert.equal(addresses({ ...shared, text: '@Nova hi', mentions: [{ kind: 'agent', id: '902', name: 'Nova' }] }), false)
  assert.equal(addresses({ ...shared, text: '@Voxor hi', mentions: [{ kind: 'agent', id: ASSISTANT_ID, name: 'Voxor' }] }), true)
  assert.equal(addresses({ ...shared, text: '@Voxor hi', mentions: [{ kind: 'agent', id: Number(ASSISTANT_ID), name: 'Voxor' }] }), true, 'an id as a number')
  assert.equal(addresses({ ...shared, text: '/status', messageType: 'slash_command' }), true)
  assert.equal(addresses({ ...shared, text: FOLLOW_UP_FRAMED, mentions: [{ kind: 'agent', id: ASSISTANT_ID, name: 'Voxor' }] }), false, 'the follow-up framing still wins')
  assert.equal(addresses({ text: 'Lunch at one?', mentions: null, assistantId: ASSISTANT_ID }), true, 'not a shared chat: no mention needed')
})

test('deafSessionAction: a pending message already probed is never probed again', () => {
  const pending = { ts: 0, reminded: true, probed: true }
  const base = { live: false, now: 10 * WINDOW_MS, alreadyEscalated: false, windowMs: WINDOW_MS }
  assert.equal(lv.deafSessionAction({ ...base, pending, probeSentAt: null }), 'wait', 'answered (spent) probe: wait for ever')
  assert.equal(lv.deafSessionAction({ ...base, pending: { ...pending, probed: false }, probeSentAt: null }), 'probe', 'control: a fresh pending message is probed')
  // An unanswered probe still earns the warning after the grace.
  const probeAt = 2 * WINDOW_MS
  assert.equal(lv.deafSessionAction({ ...base, pending, probeSentAt: probeAt, now: probeAt + lv.DEAF_PROBE_GRACE_WINDOWS * WINDOW_MS }), 'escalate')
})

test('deafNoticeChat: the owner\'s own main chat only, and nowhere when none is known', () => {
  const pick = need('deafNoticeChat')
  const ownership = createChatOwnership(OWNER)
  ownership.noteRow({ chatId: OWNER_CHAT, kind: 'main', userId: OWNER })
  ownership.noteRow({ chatId: '2001', kind: 'main', userId: PERSON })
  ownership.noteRow({ chatId: GROUP, kind: 'room' })
  const main = [OWNER_CHAT, '2001']
  assert.equal(pick({ pendingChatId: OWNER_CHAT, mainChatIds: main, ownership }), OWNER_CHAT, 'the owner chat the message came from')
  assert.equal(pick({ pendingChatId: GROUP, mainChatIds: main, ownership }), OWNER_CHAT, 'a group: the owner\'s chat instead')
  assert.equal(pick({ pendingChatId: '2001', mainChatIds: main, ownership }), OWNER_CHAT, 'a share recipient\'s chat: the owner\'s instead')
  assert.equal(pick({ pendingChatId: GROUP, mainChatIds: ['2001'], ownership }), null, 'only somebody else\'s main chat: nowhere')
  assert.equal(pick({ pendingChatId: GROUP, mainChatIds: [], ownership }), null, 'no main chat known: nowhere')
  // A group the owner spoke in is never the owner's chat, whatever the stamps say.
  const stamped = createChatOwnership(OWNER)
  stamped.noteAuthor(GROUP, OWNER)
  assert.equal(pick({ pendingChatId: GROUP, mainChatIds: [], ownership: stamped }), null)
  assert.equal(pick({ pendingChatId: GROUP, mainChatIds: [OWNER_CHAT], ownership: stamped }), OWNER_CHAT, 'a main chat not known to be anybody else\'s')
})

test('buildLivenessProbeNotification: the default claims no restart; only the watcher\'s restart probe says "after a restart"', () => {
  const plain = bh.buildLivenessProbeNotification({ chatId: GROUP })
  assert.doesNotMatch(plain.content, /restart/i)
  assert.match(plain.content, /^\[hoai\] Liveness check\./)
  assert.match(plain.content, /Call the channel_ack tool now/)
  assert.match(plain.content, /Do NOT send any message to the user for this\./)
  assert.deepEqual(plain.meta, { event_type: 'liveness_probe', chat_id: GROUP })
  assertAllStrings(plain.meta, 'probe')
  const restart = bh.buildLivenessProbeNotification({ chatId: GROUP, afterRestart: true })
  assert.equal(
    restart.content,
    '[hoai] Liveness check after a restart. Call the channel_ack tool now, ' +
      'then continue whatever you were doing. Do NOT send any message to the user for this.',
  )
  assert.deepEqual(restart.meta, plain.meta, 'the same card either way')
  for (const c of [plain.content, restart.content]) assert.ok(!/[\u2013\u2014]/.test(c), 'no em or en dash')
})

test('server.ts: only the watcher\'s probe, which follows a real restart, asks for the restart wording', () => {
  const start = SRC.indexOf('// Step 2.6: liveness probe')
  const end = SRC.indexOf('// Step 2.7:', start)
  assert.ok(start !== -1 && end !== -1)
  assert.match(SRC.slice(start, end), /buildLivenessProbeNotification\(\{ chatId: monitoredChatIds\[0\], afterRestart: true \}\)/)
  const ladder = serverFunction('function checkReplyOverdue(')
  assert.match(ladder, /buildLivenessProbeNotification\(\{ chatId \}\)/)
  assert.doesNotMatch(ladder, /afterRestart/)
})

// ── review follow-ups: rooms on the poll, forged lines, ownership order ─────

test('the socket and the stream remember a group, room or channel they deliver into; an owner chat is not remembered', async () => {
  const groups = new Set<string>()
  const ws = wsDaemon({ groupChatIds: groups })
  ws.lane(wsOwnerMessage())
  assert.equal(groups.size, 0, 'an owner chat is not a group')
  ws.lane(wsAddressedGroupMessage())
  assert.deepEqual([...groups], [GROUP], 'the socket names the room in groupContext.chatKind')
  const streamGroups = new Set<string>()
  const stream = streamDaemon({ groupChatIds: streamGroups })
  const view = streamApply.viewStreamMessage(
    {
      seq: 8,
      kind: 'message_new',
      chatId: Number(GROUP),
      messageId: 131591,
      payload: { text: ADDRESSED_FRAMED, chatKind: 'room', sender: 'user', messageType: 'standard', senderUserId: PERSON, files: [] },
    } as never,
    ASSISTANT_ID,
  )
  await stream.lane(view, false)
  assert.deepEqual([...streamGroups], [GROUP], 'the stream row names the room in chatKind')
})

test('poll: a room the socket delivered into is read by the group rule, so a row it was never handed arms nothing', async () => {
  // Rooms are not on the inbox. The poll reads one after the agent posts
  // buttons there (fast scope), and it never re-delivers what the socket did,
  // so a row it delivers is one BGOS did not hand this agent.
  const groups = new Set<string>()
  wsDaemon({ groupChatIds: groups }).lane(wsAddressedGroupMessage())
  const row = { message: { id: 9201, chatId: Number(GROUP), text: 'Sounds good, see you there.', sender: 'user', senderUserId: PERSON, messageType: 'standard', sentDate: TS, mentions: null }, messageFiles: [] }
  const learned = pollDaemon([row], { groupChatIds: groups })
  await learned.lane(GROUP)
  assert.equal(learned.cards.length, 1, 'delivered')
  assert.equal(learned.pendingInbounds.has(GROUP), false)
  await learned.runFor(HOUR)
  assertSilentForHours(learned, 'poll room row')
  // Control: a chat no lane ever named as a group is read as before.
  const unknown = pollDaemon([row], { groupChatIds: new Set<string>() })
  await unknown.lane(GROUP)
  assert.equal(unknown.pendingInbounds.get(GROUP)?.messageId, 9201)
})

test('an unaddressed follow-up behind an addressed message leaves the addressed one pending, with its own clock', async () => {
  const d = wsDaemon()
  d.lane(wsAddressedGroupMessage())
  const armedAt = d.now()
  await d.runFor(2 * TICK_MS)
  d.lane(wsGroupMessage({ messageId: 131595 }))
  assert.equal(d.pendingInbounds.get(GROUP)?.messageId, 131590, 'the question still waits for its answer')
  assert.equal((d.pendingInbounds.get(GROUP) as unknown as { ts: number }).ts, armedAt, 'and its clock did not restart')
  await d.runFor(WINDOW_MS)
  const nudges = d.ofType('reply_overdue')
  assert.equal(nudges.length, 1)
  assert.equal(nudges[0]!.meta.message_id, '131590')
})

test('inboundAddressesAgent: a display name or a title that carries the sentence does not make a follow-up', () => {
  const addresses = need('inboundAddressesAgent')
  const framed = (lines: string[], body: string) => [...lines, SHARED_TAIL].join('\n') + `\n\n${body}`
  // BGOS prints the writer's name at the start of a line of its own.
  const speaker = framed(
    ['[BGOS group: Launch]', 'You are in a group, not a private chat. Everyone listed here reads what you say.', `${FOLLOW_UP_LINE} wrote the message below.`],
    '@Voxor can you book the table?',
  )
  assert.equal(addresses({ text: speaker }), true, 'the speaker line always ends "wrote the message below."')
  const title = framed([`[BGOS group: ${FOLLOW_UP_LINE}]`, 'Maya wrote the message below.'], '@Voxor go')
  assert.equal(addresses({ text: title }), true, 'the title line starts "[BGOS "')
  const people = framed(['[BGOS group: Launch]', `People here: ${FOLLOW_UP_LINE}`, 'Maya wrote the message below.'], '@Voxor go')
  assert.equal(addresses({ text: people }), true)
})

test('isGroupChatDelivery: the server\'s chat kind on the socket or the stream, groups, rooms and channels only', () => {
  const isGroup = need('isGroupChatDelivery')
  assert.equal(isGroup({ groupContext: { chatKind: 'room' } }), true)
  assert.equal(isGroup({ groupContext: { chatKind: 'group' } }), true)
  assert.equal(isGroup({ chatKind: 'channel' }), true)
  assert.equal(isGroup({ chat_kind: 'Room' }), true)
  assert.equal(isGroup({ group_context: { chat_kind: 'room' } }), true)
  assert.equal(isGroup({ groupContext: { chatKind: 'meeting' } }), false, 'a meeting has its own lane')
  assert.equal(isGroup({ chatKind: 'main' }), false)
  assert.equal(isGroup({ text: 'hello' }), false)
  assert.equal(isGroup(null), false)
  assert.equal(isGroup(undefined, { chatKind: 'room' }), true, 'any record the lane has')
})

test('deafNoticeChat: a chat known to be the owner\'s beats one whose owner is unknown', () => {
  const pick = need('deafNoticeChat')
  const ownership = createChatOwnership(OWNER)
  ownership.noteRow({ chatId: OWNER_CHAT, kind: 'main', userId: OWNER })
  // 2002: a main chat whose row names no user and where nobody was seen.
  ownership.noteRow({ chatId: '2002', kind: 'main' })
  assert.equal(pick({ pendingChatId: '2002', mainChatIds: ['2002', OWNER_CHAT], ownership }), OWNER_CHAT)
  // With no owner chat known, the message's own chat comes before any other main chat.
  const blank = createChatOwnership(OWNER)
  assert.equal(pick({ pendingChatId: '2002', mainChatIds: ['2003', '2002'], ownership: blank }), '2002')
  assert.equal(pick({ pendingChatId: GROUP, mainChatIds: ['2003', '2002'], ownership: blank }), '2003')
})

test('discovery remembers this agent\'s shared chats (inbox kind group) and nothing else', async () => {
  const groups = new Set<string>()
  const d = daemon(serverFunction('async function discoverChats('), 'discoverChats', {
    groupChatIds: groups,
    bgosPeerGet: async () => ({
      chats: [
        { id: 3821, assistantId: Number(ASSISTANT_ID), kind: 'group' },
        { id: 1048, assistantId: Number(ASSISTANT_ID), kind: 'main', userId: OWNER },
        { id: 5000, assistantId: 902, kind: 'group' },
        { id: 6000, assistantId: Number(ASSISTANT_ID), kind: 'a2a' },
      ],
    }),
  })
  await d.lane()
  assert.deepEqual([...groups], [GROUP], `only this agent's shared chat (log: ${d.logs.join(' | ')})`)
})
