/**
 * ONE IDENTITY RULE for thread work, live and replayed (fix round 377,
 * finding 6).
 *
 * The rule: a live frame and a replayed row are read by one function, so they
 * always agree on whose work it is; two spellings that disagree are refused,
 * and a person's work names its agent.
 *
 * WHAT THESE TESTS HOLD. For every case below, the four readers give the
 * answer the case names, and live and replay always agree:
 *   - owner live   (lib/thread-rpc.ts isPersonThreadFrame, negated),
 *   - owner replay (lib/thread-lanes.ts pendingRowIsThisLane, owner lane),
 *   - person live  (lib/lane-thread-rpc.ts classifyLaneThreadFrame),
 *   - person replay (pendingRowIsThisLane, the person's lane).
 * And a reaction in a known recipient chat is refused in the owner's daemon,
 * as a tap there is.
 *
 * Run with: npx tsx --test test/thread-identity.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isPersonThreadFrame } from '../lib/thread-rpc.ts'
import { pendingRowIsThisLane } from '../lib/thread-lanes.ts'
import { classifyLaneThreadFrame } from '../lib/lane-thread-rpc.ts'

const AGENT = '901'
const ANA = 'user_ana'
const BOB = 'user_bob'
const LANE = `person:${ANA}`

type Want = { owner: boolean; person: boolean }
const CASES: Array<[string, Record<string, unknown>, Want]> = [
  ['the owner, unstamped, the agent named', { assistantId: AGENT }, { owner: true, person: false }],
  ['the owner, stamped owner', { assistantId: AGENT, lane: 'owner' }, { owner: true, person: false }],
  ['a legacy owner row with no agent named', {}, { owner: true, person: false }],
  ['the owner stamp naming a person only as actor_user_id', { assistantId: AGENT, lane: 'owner', actor_user_id: ANA }, { owner: false, person: false }],
  ['no stamp naming a person only as actor_user_id', { assistantId: AGENT, actor_user_id: ANA }, { owner: false, person: false }],
  ['Ana, exactly', { assistantId: AGENT, lane: LANE, actorUserId: ANA }, { owner: false, person: true }],
  ['Ana under the other spelling only', { assistantId: AGENT, lane: LANE, actor_user_id: ANA }, { owner: false, person: false }],
  ['Ana under both spellings, agreeing', { assistantId: AGENT, lane: LANE, actorUserId: ANA, actor_user_id: ANA }, { owner: false, person: true }],
  ['Ana and Bob under the two spellings', { assistantId: AGENT, lane: LANE, actorUserId: ANA, actor_user_id: BOB }, { owner: false, person: false }],
  ['Ana with no agent named', { lane: LANE, actorUserId: ANA }, { owner: false, person: false }],
  ['Ana for another agent', { assistantId: '902', lane: LANE, actorUserId: ANA }, { owner: false, person: false }],
  ['Ana with the agent under two spellings that disagree', { assistantId: AGENT, assistant_id: '902', lane: LANE, actorUserId: ANA }, { owner: false, person: false }],
  ['Ana with the agent under the other spelling only', { assistant_id: AGENT, lane: LANE, actorUserId: ANA }, { owner: false, person: false }],
  ['Bob\'s stamp naming Ana', { assistantId: AGENT, lane: `person:${BOB}`, actorUserId: ANA }, { owner: false, person: false }],
  ['Ana named with no stamp', { assistantId: AGENT, actorUserId: ANA }, { owner: false, person: false }],
  ['the owner for another agent', { assistantId: '902' }, { owner: false, person: false }],
]

const live = (fields: Record<string, unknown>) => ({ rpcId: 'rpc-1', op: 'thread_turn', chatId: '55', payload: {}, ...fields })

for (const [name, fields, want] of CASES) {
  test(`live and replay agree: ${name}`, () => {
    const ownerLive = !isPersonThreadFrame(live(fields))
    const ownerReplay = pendingRowIsThisLane(fields, 'owner', [AGENT])
    const personLive = classifyLaneThreadFrame(live(fields), { userId: ANA, assistantId: AGENT }).kind === 'thread'
    const personReplay = pendingRowIsThisLane(fields, LANE, [AGENT])
    assert.equal(ownerReplay, want.owner, 'owner replay')
    assert.equal(personLive, want.person, 'person live')
    assert.equal(personReplay, want.person, 'person replay')
    // The owner's live reader never sees the agent list (normalizeVoiceRpc checks the agent): it agrees on whose it is.
    if (fields.assistantId !== '902') assert.equal(ownerLive, want.owner, 'owner live')
  })
}

test('the owner replay keeps the legacy row with no agent, the person replay never does', () => {
  assert.equal(pendingRowIsThisLane({ chatId: '55' }, 'owner', [AGENT]), true)
  assert.equal(pendingRowIsThisLane({ chatId: '55', lane: LANE, actorUserId: ANA }, LANE, [AGENT]), false)
  // A person's lane with no served list cannot check the agent: refused, not taken.
  assert.equal(pendingRowIsThisLane({ assistantId: AGENT, lane: LANE, actorUserId: ANA }, LANE), false)
})

test('the replay passes the served agents to the one rule', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'lib', 'thread-lanes.ts'), 'utf8')
  assert.match(src, /pendingRowIsThisLane\(r, opts\.lane \?\? OWNER_LANE_STAMP, opts\.assistantIds\?\.map\(String\)\)/)
})

test('a reaction in a known recipient chat is refused in the owner daemon, as a tap there is', () => {
  const server = readFileSync(join(import.meta.dirname, '..', 'server.ts'), 'utf8')
  const handler = server.slice(server.indexOf("realtimeSocket.on('inbound_reaction'"), server.indexOf("realtimeSocket.on('inbound_message'"))
  const lane = handler.indexOf('if (!ownerLaneVerdict(frame).deliver) return')
  const known = handler.indexOf('if (announceRefusedIn(String(frame.chatId))) {')
  const notify = handler.indexOf('channelNotify(')
  assert.ok(lane > 0 && known > lane && notify > known, 'the recipient chat check sits between the stamp and the delivery')
})
