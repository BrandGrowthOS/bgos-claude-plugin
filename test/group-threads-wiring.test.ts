/**
 * Group threads, the daemon's side (the server's group threads contract):
 *
 *  - routing: a delivery stamped `group:<chatId>` goes to the group lane on
 *    every transport, BEFORE ownerLaneVerdict, only where group lanes run; a
 *    group stamp never reaches the main session, and without the capability
 *    it is refused exactly as today;
 *  - group_threads is declared only where thread lanes can run, on a pairing;
 *  - group_thread_end arrives on the thread ops rail;
 *  - pause summaries ride in front of the main session's next card, framed,
 *    persisted, at most 10, cleared once handed over.
 *
 * server.ts boots a whole daemon, so its wiring is read from source, like the
 * other wiring tests.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { groupRouteOf, groupTapLine, readGroupDelivery } from '../lib/group-delivery.ts'
import { ownerLaneVerdict } from '../lib/lane-core.mjs'
import { declaredCapabilities, GROUP_THREADS_TOKEN } from '../lib/declared-capabilities.ts'
import { GROUP_THREAD_END, isThreadOp, type ThreadRpcDeps } from '../lib/thread-rpc.ts'
import { VoiceRpcHandler, normalizeVoiceRpc, type VoiceRpcDeps, type VoiceRpcResultBody } from '../lib/voice-rpc.ts'
import {
  GROUP_SUMMARY_QUEUE_MAX,
  createGroupSummaryQueue,
  isOwnerCard,
  groupSummaryHeader,
  withGroupSummaries,
} from '../lib/group-summary-queue.ts'

const server = readFileSync(join(import.meta.dirname, '..', 'server.ts'), 'utf8').replace(/\r\n/g, '\n')

const stamped = {
  messageId: 501,
  chatId: 123,
  text: '@Atlas hello',
  lane: 'group:123',
  groupThread: { chatId: 123, title: 'Launch team', level: 'talk', note: null, summary: 'before', sessionId: null, state: 'new', frame: null, idlePauseMinutes: 15 },
  groupContext: {
    chatKind: 'room', chatTitle: 'Launch team', mentionedBy: 'Ana',
    participants: [{ userId: 'u1', displayName: 'Ana', relationship: 'owner' }],
    agents: [{ assistantId: 7, name: 'Atlas', isYou: true }, { assistantId: 8, name: 'Scout', isYou: false }],
    messages: [{ senderDisplayName: 'Ben', text: 'earlier', sentAt: '2026-01-01T00:00:00Z' }],
  },
}

// -- routing ------------------------------------------------------------------

test('a group stamp goes to the group lane only where group lanes run; anything else is left to ownerLaneVerdict', () => {
  assert.equal(groupRouteOf([stamped], true), '123')
  assert.equal(groupRouteOf([stamped], false), null, 'without the capability: today\'s refusal')
  assert.equal(groupRouteOf([{ ...stamped, lane: 'owner' }], true), null)
  assert.equal(groupRouteOf([{ ...stamped, lane: 'person:u1' }], true), null)
  assert.equal(groupRouteOf([{ text: 'no stamp' }], true), null)
  assert.equal(groupRouteOf([{ ...stamped, groupThread: { ...stamped.groupThread, chatId: 999 } }], true), null, 'a block naming another chat is not routed')
  // The poll: the stamp on the inner message, the outer row beside it.
  assert.equal(groupRouteOf([stamped, { message: stamped }], true), '123')
})

test('the main session never takes a group stamp: ownerLaneVerdict refuses it, so a daemon without the manager answers nothing twice', () => {
  assert.deepEqual(ownerLaneVerdict(stamped), { deliver: false, stamp: 'group:123' })
})

test('a group delivery reads its title, level, summary, roster, backlog and frame off the stamped record', () => {
  const d = readGroupDelivery([stamped], { chatId: '123', key: '501', messageId: 501, text: stamped.text, sessionHandle: 'h' })
  assert.equal(d.title, 'Launch team')
  assert.equal(d.level, 'talk')
  assert.equal(d.summary, 'before')
  assert.equal(d.state, 'new')
  assert.equal(d.sessionId, null)
  assert.equal(d.sender, 'Ana')
  assert.deepEqual(d.roster, [{ name: 'Ana', role: 'owner' }])
  assert.deepEqual(d.agents, ['Scout'], 'the agent itself is not listed as someone else')
  assert.deepEqual(d.backlog, [{ sender: 'Ben', text: 'earlier' }])
  assert.equal(d.messageId, 501)
  assert.equal(d.idlePauseMinutes, 15)
  assert.equal(readGroupDelivery([{ ...stamped, groupThread: { ...stamped.groupThread, idlePauseMinutes: undefined } }], { chatId: '123', key: '1', messageId: 1, text: '' }).idlePauseMinutes, null)
  const unknown = readGroupDelivery([{ ...stamped, groupThread: { ...stamped.groupThread, level: 'root' } }], { chatId: '123', key: '1', messageId: 1, text: '' })
  assert.equal(unknown.level, 'approvals')
  assert.match(groupTapLine({ tapper: null, buttonText: 'Yes' }), /Someone pressed "Yes"/)
})

test('server.ts routes a group stamp to the lane BEFORE ownerLaneVerdict on the socket, the poll, the stream and taps', () => {
  const sites: Array<[string, string]> = [
    ['socket', "realtimeSocket.on('inbound_message'"],
    ['poll', '// The second lock (person lanes), on the poll as on the socket.'],
    ['stream', 'async function forwardStreamInbound('],
    ['taps', 'function applyStreamButtonsAnswered('],
  ]
  for (const [name, marker] of sites) {
    const at = server.indexOf(marker)
    assert.ok(at >= 0, `missing ${name} site`)
    // The poll's marker sits just after the route: look back a little for it.
    const from = name === 'poll' ? server.lastIndexOf('if (routeGroupPollRow(', at) : at
    const route = server.indexOf('if (routeGroup', from)
    const verdict = server.indexOf('ownerLaneVerdict(', from)
    assert.ok(route > 0 && route < verdict, `${name}: the group route comes before ownerLaneVerdict`)
    assert.ok(verdict - route < 1500, `${name}: in the same handler`)
  }
  for (const helper of ['routeGroupSocketInbound(payload)', 'routeGroupPollRow(msg)', 'routeGroupStreamView(view, transport)', 'routeGroupStreamTap(view)']) {
    assert.ok(server.includes(`if (${helper}) `), helper)
  }
  // Only where group lanes run: the same condition that declares group_threads.
  assert.match(server, /function groupLanesOn\(\): boolean \{\n\s*return AUTH\.mode === 'pairing' && threadsDeclared\(\)\n\}/)
  assert.match(server, /const chatId = groupRouteOf\(records, groupLanesOn\(\)\)\n\s*if \(chatId === null\) return false/)
})

test('server.ts answers group_thread_end through the group lanes, and stops them on shutdown', () => {
  assert.match(server, /groupEnd: \(input\) => groupLanes\.end\(input\),/)
  // TEST ONLY: the idle override comes from the environment and nowhere else.
  assert.match(server, /idleOverrideMs: groupIdleOverrideMs\(process\.env\.HOAI_GROUP_LANE_IDLE_MS\),/)
  // A group lane left from before a daemon crash is found the way a thread lane is (lib/lane-process.ts).
  const manager = server.slice(server.indexOf('const groupLanes = new GroupLaneManager({'), server.indexOf('\n})\n', server.indexOf('const groupLanes = new GroupLaneManager({')))
  assert.match(manager, /stamp: \(pid\) => processStamp\(pid\),\n\s*runsIn: \(pid, dir\) => processRunsIn\(pid, dir\),\n\s*kill: \(pid, signal\) => killProcessGroup\(pid, signal\),/)
  assert.match(server, /Promise\.allSettled\(\[threadLanes\.stopAll\(\), groupLanes\.stopAll\(\), asideForks\.stopAll\(\)\]\)/)
  assert.match(server, /onPaused: \(\{ chatId, title, summary \}\) => groupSummaries\.add\(\{ chatId, title, summary \}\)/)
  // A group lane's prompt meets the owner's gate: approvals always the card, full the owner's whole handler.
  assert.match(server, /const ownHandler = input\.level === 'full' \? permissionRequestHandler\(\) : null/)
  assert.match(server, /\? ownHandler\(\{ method: 'notifications\/claude\/channel\/permission_request', params \}\)\n\s*: relayPermissionToOwner\(params\)/)
})

// -- the capability -----------------------------------------------------------

test('group_threads is declared only where thread lanes can run, and only on a pairing', () => {
  const on = declaredCapabilities({ canInjectGoal: false, floorHook: true, threads: true, authMode: 'pairing', platform: 'darwin' })
  assert.equal(on.at(-1), GROUP_THREADS_TOKEN)
  for (const shape of [
    { threads: true, authMode: 'apikey' as const, platform: 'darwin' as const },
    { threads: true, authMode: 'pairing' as const, platform: 'win32' as const },
    { threads: false, authMode: 'pairing' as const, platform: 'linux' as const },
    { authMode: 'pairing' as const, platform: 'linux' as const },
  ]) {
    assert.equal(declaredCapabilities({ canInjectGoal: true, floorHook: true, ...shape }).includes(GROUP_THREADS_TOKEN), false, JSON.stringify(shape))
  }
})

// -- group_thread_end on the rail ---------------------------------------------

function rpcRig(groupEnd?: ThreadRpcDeps['groupEnd']) {
  const results: VoiceRpcResultBody[] = []
  const ends: unknown[] = []
  const deps: VoiceRpcDeps = {
    config: { openaiApiKey: '', model: 'm', voice: 'v', persona: '', assistantId: '42' },
    postAck: async () => {},
    postResult: async (_rpcId, body) => { results.push(body) },
    notify: async () => {},
    getIdentity: async () => null,
    threads: {
      turn: () => ({ accepted: true, state: 'working' }),
      close: async () => ({ stopped: true }),
      aside: async () => ({ text: '' }),
      ...(groupEnd ? { groupEnd: async (input) => { ends.push(input); return groupEnd(input) } } : {}),
    },
    log: () => {},
  }
  return { handler: new VoiceRpcHandler(deps), results, ends }
}

test('group_thread_end passes the normalizer, reaches the group lanes and answers ok', async () => {
  assert.equal(isThreadOp(GROUP_THREAD_END), true)
  const r = rpcRig(async () => ({ ok: true }))
  const frame = normalizeVoiceRpc({ rpcId: 'rpc-9', op: GROUP_THREAD_END, assistantId: '42', agentRoute: '', chatId: '123', payload: { chatId: 123, reason: 'owner_ended' } })!
  assert.ok(frame)
  await r.handler.handle(frame)
  assert.deepEqual(r.ends, [{ chatId: '123', reason: 'owner_ended' }])
  assert.deepEqual(r.results, [{ ok: true, payload: { ok: true } }])
})

test('group_thread_end without group lanes answers unsupported', async () => {
  const r = rpcRig()
  await r.handler.handle(normalizeVoiceRpc({ rpcId: 'rpc-10', op: GROUP_THREAD_END, assistantId: '42', agentRoute: '', chatId: '123', payload: { chatId: 123 } })!)
  assert.equal(r.results[0]!.ok, false)
  assert.equal(r.results[0]!.error?.code, 'unsupported')
})

// -- the summaries for the main session ---------------------------------------

function queueRig(files = new Map<string, string>()) {
  const fs = {
    readFile: (p: string) => { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v },
    writeFile: (p: string, d: string) => { files.set(p, d) },
    mkdir: () => {},
    unlink: (p: string) => { files.delete(p) },
  }
  return { files, queue: createGroupSummaryQueue({ path: '/s/groups/main-summaries.json', dir: '/s/groups', fs }) }
}

test('a pause summary rides in front of the main session\'s next card, framed exactly, and is cleared once handed over', () => {
  const { queue, files } = queueRig()
  queue.add({ chatId: '123', title: 'Launch team', summary: '- Ana asked the launch time\n- Needs you: confirm the caterer' })
  assert.equal(queue.size(), 1)
  const taken = queue.take()!
  const content = withGroupSummaries('<the next card>', taken.items)
  assert.equal(
    content,
    'From the group "Launch team" (this is from the group "Launch team"; do not repeat it outside "Launch team" unless your owner asks):\n' +
      '- Ana asked the launch time\n- Needs you: confirm the caterer\n\n<the next card>',
  )
  assert.equal(queue.size(), 0)
  assert.equal(queue.take(), null, 'handed over once')
  assert.equal(files.size, 0, 'nothing left on disk')
  assert.equal(groupSummaryHeader('A "quoted"\nname'), 'From the group "A quoted name" (this is from the group "A quoted name"; do not repeat it outside "A quoted name" unless your owner asks):')
})

test('the summaries survive a restart, keep only the last 10, and come back when the card did not go out', () => {
  const files = new Map<string, string>()
  const first = queueRig(files).queue
  for (let i = 0; i < 12; i++) first.add({ chatId: String(i), title: `G${i}`, summary: `s${i}` })
  const second = queueRig(files).queue
  assert.equal(second.size(), GROUP_SUMMARY_QUEUE_MAX)
  const taken = second.take()!
  assert.deepEqual(taken.items.map((x) => x.title), ['G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11'])
  taken.restore()
  assert.equal(queueRig(files).queue.size(), 10)
  first.add({ chatId: '1', title: 'x', summary: '   ' })
})

test('server.ts puts the summaries in front of the owner\'s next card, keeps its private turn, and puts them back on a failed send', () => {
  const step = server.slice(server.indexOf('function groupNotificationStep('), server.indexOf('const sendMcpNotification = mcp.notification.bind(mcp)'))
  assert.match(step, /const taken = groupSummaries\.take\(\)/)
  assert.match(step, /params\.content = withGroupSummaries\(before, taken\.items\)/)
  assert.match(step, /privateTurns\.rekeyCard\(before, params\.content as string\)/)
  assert.match(step, /return \{ restore: \(\) => taken\.restore\(\) \}/)
  // A group lane's verdict goes back to the lane, never to the CLI of the main session.
  assert.match(step, /verdict\(String\(params\.behavior \?\? 'deny'\)\)\n\s*return \{ swallow: true \}/)
  const at = server.indexOf('const sendMcpNotification = mcp.notification.bind(mcp)')
  const boundary = server.slice(at, server.indexOf('}) as typeof mcp.notification', at))
  // Before the private turn tags the card, so the tracker sees the text that goes out.
  assert.ok(boundary.indexOf('groupNotificationStep(notification)') < boundary.indexOf('privateTurns.tagRawCard'))
  assert.match(boundary, /if \(group\?\.swallow\) return Promise\.resolve\(\)/)
  assert.match(boundary, /if \(group\?\.restore\) sent\.catch\(group\.restore\)/)
})

test('a delivered card with the summaries in front of it is still the same delivery for its private turn', async () => {
  const { createPrivateTurnTracker } = await import('../lib/private-turn.mjs')
  const tracker = createPrivateTurnTracker({ ownerUserId: 'user_owner' })
  const card = tracker.deliver({ content: 'hello', actingUserId: 'user_owner', chatId: '10' })
  const grown = withGroupSummaries(card, [{ chatId: '123', title: 'Launch team', summary: '- s' }])
  assert.equal(tracker.rekeyCard(card, grown), true)
  assert.equal(tracker.tagRawCard(grown), grown, 'known: not tagged as a raw card')
  assert.notEqual(tracker.tagRawCard(card), card, 'the old text is no delivery any more')
  assert.equal(tracker.rekeyCard('never delivered', 'x'), false)
})

test('review 2: only a card from the OWNER in their own chat with the agent takes the summaries', () => {
  const ctx = { ownerUserId: 'user_owner', mainChatIds: ['10'], isOthers: (chatId: string) => chatId === '20' }
  const owner = { chat_id: '10', message_id: '1', user: 'User', user_id: 'user_owner' }
  assert.equal(isOwnerCard(owner, ctx), true)
  assert.equal(isOwnerCard({ ...owner, sender_relationship: 'owner' }, ctx), true)
  for (const [why, meta] of [
    ['a share recipient', { ...owner, user_id: 'user_recipient', sender_relationship: 'shared_recipient' }],
    ['the owner\'s id with another relationship', { ...owner, sender_relationship: 'room_member' }],
    ['a room member', { ...owner, chat_id: '77', user_id: 'user_member' }],
    ['the owner in a group', { ...owner, chat_id: '77' }],
    ['a chat known to be someone else\'s', { ...owner, chat_id: '20' }],
    ['a peer agent', { ...owner, sender_type: 'agent' }],
    ['a peer conversation', { ...owner, peer_conversation_id: '5' }],
    ['a system card', { ...owner, system: 'true', sender_type: 'system' }],
    ['another agent in a room', { ...owner, sender_type: 'room_agent' }],
    ['no meta', null],
    ['no user', { chat_id: '10' }],
  ] as const) {
    assert.equal(isOwnerCard(meta, ctx), false, why)
  }
})

test('review 2: server.ts takes the queue only for an owner card; any other card leaves it queued', () => {
  const step = server.slice(server.indexOf('function groupNotificationStep('), server.indexOf('const sendMcpNotification = mcp.notification.bind(mcp)'))
  const gate = step.indexOf('isOwnerCard(')
  assert.ok(gate > 0 && gate < step.indexOf('groupSummaries.take()'), 'the owner check comes before the take')
  assert.match(step, /if \(!isOwnerCard\(params\.meta, \{ ownerUserId: USER_ID, mainChatIds, isOthers: \(chatId\) => chatOwnership\.isOthers\(chatId\) \}\)\) return null/)
})
