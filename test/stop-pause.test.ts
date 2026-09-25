/**
 * The armed goal case (P6 stage 3, C-32, spec 4.3 and D13 item 3).
 *
 * Claude Code's stop is a request to a live model, and a request is not
 * enough while Keep working is armed: the native /goal's own Stop hook
 * re prompts the model the moment it stands down, so the stop would not
 * stick. So where this daemon can type into its session (it declares
 * mission_pause) AND its goal lane holds an armed goal for the stopped chat's
 * mission, the Stop also PAUSES that mission with the contract reason. The
 * echo reaches the goal lane exactly as the owner's own Pause does: the native
 * goal is cleared and the condition is remembered. The owner's next message in
 * that chat resumes the mission, and the resume's echo arms the same goal
 * again. An owner's own Pause (no reason, or any other reason) is never
 * resumed by a message, and the first owner message in a chat after the daemon
 * starts asks the server, because a restart forgets what this process paused.
 *
 * The decision and the order of every write live in lib/stop-pause.ts, pure
 * over injected I/O, so the whole story runs here with fakes. The socket and
 * HTTP wiring in server.ts is pinned by test/stop-pause-wiring.test.ts.
 *
 * Run: npx tsx --test test/stop-pause.test.ts
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { STOP_PAUSE_REASON } from '../lib/session-controls-contract.ts'
import {
  StopPauseLane,
  armedGoalMissionFor,
  isOwnerAuthoredInbound,
  isStopPausedMission,
  type StopGoalView,
  type StopPauseLaneDeps,
} from '../lib/stop-pause.ts'
import type { MissionSnapshot } from '../lib/missions.ts'
import { goalCommandForMissionFrame, type GoalArmRecord } from '../lib/goal-writes.ts'
import {
  createMissionSelfWriteLedger,
  decideMissionNotice,
  type MissionEventWire,
} from '../lib/mission-events.ts'

const CHAT = '42'
const OTHER_CHAT = '43'
const OWNER = 'user_owner'
const CONDITION = 'the file gate.txt exists and contains the word done'

const mission = (over: Partial<MissionSnapshot> = {}): MissionSnapshot => ({
  id: 77,
  title: 'Get the gate file written',
  status: 'active',
  miniGoals: [],
  doneWhen: CONDITION,
  keepWorking: true,
  turnCap: 20,
  chatId: 42,
  pausedReason: null,
  ...over,
})

/** The goal lane as server.ts reads it at the moment a Stop is delivered. */
const view = (over: Partial<StopGoalView> = {}): StopGoalView => ({
  pauseDeclared: true,
  held: { missionId: 77, condition: CONDITION },
  attachedMissionId: 77,
  pending: null,
  loopStopped: false,
  ...over,
})

interface Recorder {
  calls: string[]
  deps: StopPauseLaneDeps
  /** The chat's open mission as the server has it, per chat. */
  open: Map<string, MissionSnapshot | null>
}

/**
 * Fakes that behave like the backend: a pause of an active mission answers it
 * paused with the reason, a pause of a paused one answers it unchanged, a
 * resume answers it active. Every call is recorded in order, which is what the
 * "stamp BEFORE the request" rule is asserted against.
 */
function recorder(
  over: {
    open?: Array<[string, MissionSnapshot | null]>
    pauseFails?: boolean
    resumeFails?: number
    readFails?: boolean
    pauseGate?: Promise<void>
  } = {},
): Recorder {
  const calls: string[] = []
  const open = new Map<string, MissionSnapshot | null>(over.open ?? [[CHAT, mission()]])
  let resumeFailures = over.resumeFails ?? 0
  const find = (missionId: number): [string, MissionSnapshot] | null => {
    for (const [chatId, m] of open) if (m && m.id === missionId) return [chatId, m]
    return null
  }
  const deps: StopPauseLaneDeps = {
    readOpenMission: async (chatId) => {
      calls.push(`read ${chatId}`)
      if (over.readFails) throw new Error('GET 503')
      return open.get(chatId) ?? null
    },
    pauseMission: async (missionId, reason) => {
      calls.push(`pause ${missionId} ${JSON.stringify(reason)}`)
      if (over.pauseGate) await over.pauseGate
      if (over.pauseFails) throw new Error('PATCH 500')
      const hit = find(missionId)
      if (!hit) return null
      const [chatId, m] = hit
      if (m.status === 'paused') return m
      const next = { ...m, status: 'paused' as const, pausedReason: reason, updatedAt: 'u-paused' }
      open.set(chatId, next)
      return next
    },
    resumeMission: async (missionId) => {
      calls.push(`resume ${missionId}`)
      if (resumeFailures > 0) {
        resumeFailures -= 1
        throw new Error('PATCH 502')
      }
      const hit = find(missionId)
      if (!hit) return null
      const [chatId, m] = hit
      const next = { ...m, status: 'active' as const, pausedReason: null, updatedAt: 'u-resumed' }
      open.set(chatId, next)
      return next
    },
    notePendingSelfWrite: (missionId) => {
      calls.push(`stamp ${missionId}`)
    },
    noteSelfWritten: (m) => {
      calls.push(`written ${m.id} ${m.status}`)
    },
    log: () => {},
    settleTimeoutMs: 2_000,
  }
  return { calls, deps, open }
}

// ── Which goal is armed ──────────────────────────────────────────────────────

test('an armed goal is one the lane holds AND is writing onto, only where the daemon can type', () => {
  assert.equal(armedGoalMissionFor(view()), 77)
  // Without the injector this daemon cannot clear the native goal, so it
  // cannot promise the pause holds, and it declares no mission_pause.
  assert.equal(armedGoalMissionFor(view({ pauseDeclared: false })), null)
  // No goal at all.
  assert.equal(armedGoalMissionFor(view({ held: null, attachedMissionId: null })), null)
  // A goal the owner already paused, or one this daemon cleared: the lane
  // still remembers the condition for a Resume, but nothing is looping.
  assert.equal(armedGoalMissionFor(view({ attachedMissionId: null })), null)
  // A loop this daemon already stopped itself (the cap, or a stall).
  assert.equal(armedGoalMissionFor(view({ loopStopped: true })), null)
})

test('an arm typed and not yet answered counts as armed, unless the owner already stopped it', () => {
  assert.equal(
    armedGoalMissionFor(
      view({ attachedMissionId: null, pending: { missionId: 77, condition: CONDITION } }),
    ),
    77,
  )
  assert.equal(
    armedGoalMissionFor(
      view({
        attachedMissionId: null,
        pending: { missionId: 77, condition: CONDITION, stopped: 'paused' },
      }),
    ),
    null,
  )
  // An arm in flight for ANOTHER mission is not this goal's.
  assert.equal(
    armedGoalMissionFor(
      view({ attachedMissionId: null, pending: { missionId: 88, condition: 'another' } }),
    ),
    null,
  )
})

// ── The Stop ─────────────────────────────────────────────────────────────────

test('a stop with an armed goal on that chat mission pauses it with the reason, stamped first', async () => {
  const r = recorder()
  const lane = new StopPauseLane(r.deps)
  const outcome = await lane.stopDelivered(CHAT, view())
  assert.deepEqual(outcome, { kind: 'paused', missionId: 77 })
  assert.deepEqual(r.calls, [
    `read ${CHAT}`,
    // BEFORE the request: the backend emits mission_paused from inside the
    // transaction it answers from, so the frame beats the answer home, and an
    // unstamped echo is narrated to the model as its owner's own Pause.
    'stamp 77',
    `pause 77 ${JSON.stringify(STOP_PAUSE_REASON)}`,
    'written 77 paused',
  ])
  assert.equal(STOP_PAUSE_REASON, 'Stopped by you')
})

test('without an armed goal, or without the injector, nothing is read and nothing is written', async () => {
  for (const v of [
    view({ held: null, attachedMissionId: null }),
    view({ pauseDeclared: false }),
    view({ attachedMissionId: null }),
  ]) {
    const r = recorder()
    const outcome = await new StopPauseLane(r.deps).stopDelivered(CHAT, v)
    assert.equal(outcome.kind, 'skipped')
    assert.deepEqual(r.calls, [])
  }
})

test('the armed goal belongs to another chat mission: the stopped chat is left alone', async () => {
  // The stopped chat's own open mission is 88; the goal is looping on 77.
  const r = recorder({ open: [[CHAT, mission({ id: 88 })], [OTHER_CHAT, mission({ chatId: 43 })]] })
  const outcome = await new StopPauseLane(r.deps).stopDelivered(CHAT, view())
  assert.equal(outcome.kind, 'skipped')
  assert.deepEqual(r.calls, [`read ${CHAT}`])
})

test('a mission the owner already paused keeps their reason: the stop writes nothing', async () => {
  const r = recorder({ open: [[CHAT, mission({ status: 'paused', pausedReason: null })]] })
  const outcome = await new StopPauseLane(r.deps).stopDelivered(CHAT, view())
  assert.equal(outcome.kind, 'skipped')
  assert.deepEqual(r.calls, [`read ${CHAT}`])
})

test('a failed pause is logged, never thrown, and the chat is not remembered as stop paused', async () => {
  const r = recorder({ pauseFails: true })
  const lane = new StopPauseLane(r.deps)
  const outcome = await lane.stopDelivered(CHAT, view())
  assert.equal(outcome.kind, 'failed')
  // The mission is active on the server, so the next owner message finds
  // nothing to resume (the restart read still runs once for the chat).
  r.calls.length = 0
  assert.equal((await lane.ownerMessage(CHAT)).kind, 'skipped')
  assert.deepEqual(r.calls, [`read ${CHAT}`])
})

// ── The owner comes back ─────────────────────────────────────────────────────

test('the next owner message in that chat resumes it, stamped first, and only once', async () => {
  const r = recorder()
  const lane = new StopPauseLane(r.deps)
  await lane.stopDelivered(CHAT, view())
  r.calls.length = 0

  assert.deepEqual(await lane.ownerMessage(CHAT), { kind: 'resumed', missionId: 77 })
  assert.deepEqual(r.calls, [`read ${CHAT}`, 'stamp 77', 'resume 77', 'written 77 active'])
  assert.equal(r.open.get(CHAT)?.status, 'active')

  // The one after it neither reads nor writes: this chat was checked and the
  // mission it paused is back.
  r.calls.length = 0
  assert.equal((await lane.ownerMessage(CHAT)).kind, 'skipped')
  assert.deepEqual(r.calls, [])
})

test("an owner's own Pause is never resumed by a message, whatever reason they gave", async () => {
  for (const pausedReason of [null, '', 'Taking a break', 'stopped by you', `${STOP_PAUSE_REASON}.`]) {
    const r = recorder({ open: [[CHAT, mission({ status: 'paused', pausedReason })]] })
    const lane = new StopPauseLane(r.deps)
    assert.equal((await lane.ownerMessage(CHAT)).kind, 'skipped', `reason ${JSON.stringify(pausedReason)}`)
    assert.deepEqual(r.calls, [`read ${CHAT}`])
  }
})

test('the first owner message after a restart asks the server, and resumes a stop pause it finds', async () => {
  // A fresh lane is a fresh process: nothing is remembered, and the server
  // still has the mission this daemon paused before it went down.
  const r = recorder({
    open: [
      [CHAT, mission({ status: 'paused', pausedReason: STOP_PAUSE_REASON })],
      [OTHER_CHAT, mission({ id: 91, chatId: 43 })],
    ],
  })
  const lane = new StopPauseLane(r.deps)
  assert.deepEqual(await lane.ownerMessage(CHAT), { kind: 'resumed', missionId: 77 })
  assert.deepEqual(r.calls, [`read ${CHAT}`, 'stamp 77', 'resume 77', 'written 77 active'])

  // Once per chat per process: the next message in the same chat costs no read,
  r.calls.length = 0
  assert.equal((await lane.ownerMessage(CHAT)).kind, 'skipped')
  assert.deepEqual(r.calls, [])
  // and another chat's first message asks for its own.
  assert.equal((await lane.ownerMessage(OTHER_CHAT)).kind, 'skipped')
  assert.deepEqual(r.calls, [`read ${OTHER_CHAT}`])
})

test('a Resume that races the pause waits for it, so the mission ends active', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const r = recorder({ pauseGate: gate })
  const lane = new StopPauseLane(r.deps)
  const stopping = lane.stopDelivered(CHAT, view())
  // The owner presses Resume while the pause is still on the wire.
  const resuming = lane.ownerMessage(CHAT)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(!r.calls.includes('resume 77'), 'the resume must not overtake the pause')
  release()
  assert.deepEqual(await stopping, { kind: 'paused', missionId: 77 })
  assert.deepEqual(await resuming, { kind: 'resumed', missionId: 77 })
  assert.ok(r.calls.indexOf(`pause 77 ${JSON.stringify(STOP_PAUSE_REASON)}`) < r.calls.indexOf('resume 77'))
  assert.equal(r.open.get(CHAT)?.status, 'active')
})

test('a failed resume is tried again on the next owner message', async () => {
  const r = recorder({ resumeFails: 1 })
  const lane = new StopPauseLane(r.deps)
  await lane.stopDelivered(CHAT, view())
  assert.equal((await lane.ownerMessage(CHAT)).kind, 'failed')
  assert.equal(r.open.get(CHAT)?.status, 'paused')
  assert.deepEqual(await lane.ownerMessage(CHAT), { kind: 'resumed', missionId: 77 })
  assert.equal(r.open.get(CHAT)?.status, 'active')
})

test('a failed read never throws into the inbound path', async () => {
  const r = recorder({ readFails: true })
  const lane = new StopPauseLane(r.deps)
  assert.equal((await lane.ownerMessage(CHAT)).kind, 'failed')
  assert.equal((await lane.stopDelivered(CHAT, view())).kind, 'failed')
})

test('the stop pause mark is exact: only STOP_PAUSE_REASON on a paused mission', () => {
  assert.equal(isStopPausedMission(mission({ status: 'paused', pausedReason: STOP_PAUSE_REASON })), true)
  assert.equal(isStopPausedMission(mission({ status: 'paused', pausedReason: null })), false)
  assert.equal(isStopPausedMission(mission({ status: 'active', pausedReason: STOP_PAUSE_REASON })), false)
  assert.equal(isStopPausedMission(null), false)
})

// ── Whose message resumes ────────────────────────────────────────────────────

test('only the owner typing resumes: never a peer agent, a wake, or another person', () => {
  const owner = { senderType: 'user', agentOrigin: null, userId: OWNER, ownerUserId: OWNER }
  assert.equal(isOwnerAuthoredInbound(owner), true)
  // A peer agent's message, however it is labelled.
  assert.equal(
    isOwnerAuthoredInbound({ ...owner, agentOrigin: { sourceAssistantId: 5, sourceName: 'Ava' } }),
    false,
  )
  assert.equal(isOwnerAuthoredInbound({ ...owner, senderType: 'agent' }), false)
  // A scheduled wake or any other automation.
  assert.equal(isOwnerAuthoredInbound({ ...owner, senderType: 'system' }), false)
  // A person the agent is shared with is not the owner who paused nothing.
  assert.equal(isOwnerAuthoredInbound({ ...owner, userId: 'user_recipient' }), false)
  // An unknown sender kind is not the owner.
  assert.equal(isOwnerAuthoredInbound({ ...owner, senderType: 'assistant' }), false)
  // An older backend stamps no sender kind on a user row.
  assert.equal(isOwnerAuthoredInbound({ ...owner, senderType: undefined }), true)
})

// ── The echoes the goal lane already answers (pinned, because this rests on them) ──

const armedRecord = (over: Partial<GoalArmRecord> = {}): GoalArmRecord => ({
  missionId: 77,
  condition: CONDITION,
  turnCap: 20,
  turns: 3,
  live: true,
  ...over,
})

test("the stop pause's own echo clears the native goal and REMEMBERS it, self authored or not", () => {
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_paused',
      mission: mission({ status: 'paused', pausedReason: STOP_PAUSE_REASON }),
      selfAuthored: true,
      armed: armedRecord(),
    }),
    { kind: 'clear', forget: false },
  )
})

test("the resume's own echo arms the same goal again, carrying the turns", () => {
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_resumed',
      mission: mission(),
      selfAuthored: true,
      armed: armedRecord({ live: false }),
    }),
    { kind: 'arm', missionId: 77, condition: CONDITION, turnCap: 20, turnsBefore: 3 },
  )
  // And for a goal a person typed (switch off), from the report record.
  assert.deepEqual(
    goalCommandForMissionFrame({
      frame: 'mission_resumed',
      mission: mission({ keepWorking: false, turnCap: null }),
      selfAuthored: true,
      armed: null,
      reporting: armedRecord({ turnCap: null, live: false }),
    }),
    { kind: 'arm', missionId: 77, condition: CONDITION, turnCap: null, turnsBefore: 3 },
  )
})

test('the stamp silences the pause echo for the model, and is spent, so the owner is still heard', () => {
  const ledger = createMissionSelfWriteLedger(10)
  const frame = (f: 'mission_paused' | 'mission_resumed', m: MissionSnapshot): MissionEventWire => ({
    frame: f,
    mission: m,
    assistantId: '901',
    userId: OWNER,
    chatId: CHAT,
    // Pause and resume carry no cleared_by, which is what lets the pending
    // stamp answer for them.
    clearedBy: null,
    clearReason: null,
    tickedGoalId: null,
  })
  ledger.notePending(77)
  const echo = frame('mission_paused', mission({ status: 'paused', pausedReason: STOP_PAUSE_REASON, updatedAt: 'u1' }))
  const selfAuthored = ledger.isSelfAuthored(echo)
  assert.equal(selfAuthored, true)
  // The model already has the [stop_turn] notice; it is not told its owner paused.
  assert.equal(decideMissionNotice({ event: echo, chatId: CHAT, selfAuthored, alreadySeen: false }), null)
  // The owner's own Resume later is heard: the stamp was spent on the echo.
  const owners = frame('mission_resumed', mission({ updatedAt: 'u2' }))
  assert.equal(ledger.isSelfAuthored(owners), false)
})
