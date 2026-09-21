/**
 * Source guard: the mission listener is wired the way the two neighbouring
 * guards can still see.
 *
 * Three separate traps live here, and every one of them ships GREEN if it is
 * not pinned:
 *
 * 1. `test/pairing-lock-standdown.test.ts` counts handlers by matching a
 *    LITERAL single-quoted frame name inside `realtimeSocket.on(`. A loop such
 *    as `for (const f of MISSION_FRAMES) realtimeSocket.on(f, whenArmed(f, h))`
 *    matches neither of its two patterns, never enters `registered`, and ships
 *    an UNGATED handler with that whole suite green. So: eight literal
 *    registrations, and no `realtimeSocket.on(` anywhere may take a variable.
 * 2. Every handler body must open with the drain guard, like its neighbours.
 *    A daemon draining for an update must not act on a frame it is about to
 *    hand to its successor.
 * 3. The agent's own mission writes must be stamped, or the daemon narrates
 *    the model's own write back to it on every tick, forever. A FOURTH mission
 *    tool added later must not be able to forget the stamp quietly, so the
 *    stamp is asserted per tool case rather than once.
 *
 * The repo idiom for a source scan: read through an import.meta.url URL (it
 * resolves identically under bun and under the tsx runner) and normalise CRLF
 * to LF first, so the assertions describe the code and not the checkout.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const MISSION_FRAMES = [
  'mission_created',
  'mission_ticked',
  'mission_paused',
  'mission_resumed',
  'mission_completed',
  'mission_abandoned',
  'mission_failed',
  'mission_updated',
]

test('all eight mission frames are registered as literals, through the stand-down gate', () => {
  for (const frame of MISSION_FRAMES) {
    assert.match(
      server,
      new RegExp(`realtimeSocket\\.on\\('${frame}', whenArmed\\('${frame}',`),
      `${frame} must be registered literally and through whenArmed`,
    )
  }
})

test('no socket registration anywhere takes a variable frame name', () => {
  // The counting guard in pairing-lock-standdown.test.ts can only see literals,
  // so a single variable registration would make that guard blind.
  const all = [...server.matchAll(/realtimeSocket\.on\(/g)].length
  const literal = [...server.matchAll(/realtimeSocket\.on\('[A-Za-z0-9_]+'/g)].length
  assert.equal(
    all,
    literal,
    'a realtimeSocket.on(...) call uses a variable frame name; the stand-down counting guard cannot see it',
  )
})

test('every mission handler opens with the update drain guard', () => {
  for (const frame of MISSION_FRAMES) {
    const at = server.indexOf(`realtimeSocket.on('${frame}', whenArmed('${frame}',`)
    assert.ok(at > 0, `${frame} is not registered`)
    const head = server.slice(at, at + 220)
    assert.ok(
      head.includes('if (updateDrainMode) return'),
      `${frame}'s handler must open with the drain guard, like its neighbours`,
    )
  }
})

test('every mission handler hands the frame to the one function that cannot throw', () => {
  for (const frame of MISSION_FRAMES) {
    const at = server.indexOf(`realtimeSocket.on('${frame}', whenArmed('${frame}',`)
    const head = server.slice(at, at + 300)
    assert.ok(
      head.includes(`handleMissionEvent('${frame}'`),
      `${frame} must go through handleMissionEvent`,
    )
  }
  assert.match(server, /function handleMissionEvent\(/)
})

test('each mission tool case stamps its own write, so the echo can never start', () => {
  const cases = ['create_mission', 'tick_mini_goal', 'complete_mission']
  for (let i = 0; i < cases.length; i++) {
    const start = server.indexOf(`case '${cases[i]}': {`)
    assert.ok(start > 0, `${cases[i]} case not found`)
    const nextCase = server.indexOf("\n    case '", start + 10)
    const body = server.slice(start, nextCase > 0 ? nextCase : start + 6000)
    assert.ok(
      body.includes('rememberMissionSelfWrite('),
      `${cases[i]} must stamp its own write, or the daemon narrates the model's own write back to it`,
    )
  }
})

test('the writing tools stamp the mission BEFORE the request, not after the answer', () => {
  // The backend emits the WS frame from inside the transaction it answers the
  // HTTP call from, so the frame regularly arrives while the daemon is still
  // awaiting its response. Stamping only the response loses that race, and the
  // model is told its owner marked done the mission it had just ticked shut.
  // An explicit mission_id is not required for the stamp: both tools resolve a
  // mission id before they write, which is exactly what the stamp is keyed on.
  for (const tool of ['tick_mini_goal', 'complete_mission']) {
    const start = server.indexOf(`case '${tool}': {`)
    assert.ok(start > 0, `${tool} case not found`)
    const nextCase = server.indexOf("\n    case '", start + 10)
    const bodyText = server.slice(start, nextCase > 0 ? nextCase : start + 6000)

    const stamp = bodyText.indexOf('noteMissionPendingSelfWrite(')
    const request = bodyText.indexOf('await bgosPatch(')
    assert.ok(stamp > 0, `${tool} must stamp the mission before it writes it`)
    assert.ok(request > 0, `${tool} request call not found`)
    assert.ok(
      stamp < request,
      `${tool} stamps its write AFTER the request; the frame can arrive first`,
    )
    assert.ok(
      bodyText.includes('rememberMissionSelfWrite('),
      `${tool} must still stamp the landed write, which is what covers a late frame`,
    )
  }
})

test('the mission listener asks the ledger, so both stamps are consulted on one line', () => {
  const start = server.indexOf('function handleMissionEvent(')
  assert.ok(start > 0)
  const end = server.indexOf('\n}', start)
  const bodyText = server.slice(start, end)
  assert.ok(
    bodyText.includes('missionSelfWrites.isSelfAuthored(event)'),
    'handleMissionEvent must consult the ledger, which reads the pending stamp and the landed one',
  )
})

test('missionChatId reads the mission first and falls back to the first monitored chat LAST', () => {
  const start = server.indexOf('function missionChatId(')
  assert.ok(start > 0, 'missionChatId must exist: a mission event is about a mission, not about a turn')
  const end = server.indexOf('\n}', start)
  const body = server.slice(start, end)

  const fromMission = body.indexOf('chatId')
  const fromTurn = body.indexOf('turnChat.current(')
  const fromFirst = body.indexOf('monitoredChatIds[0]')
  assert.ok(fromMission > 0, 'the mission own chat must be the first source')
  assert.ok(fromTurn > fromMission, 'the turn chat must come after the mission own chat')
  assert.ok(
    fromFirst > fromTurn,
    'monitoredChatIds[0] is a GUESS on a multi-chat agent and must be the last resort only',
  )
  // This once read `server.includes('missionChatId(')`, which matched the
  // definition line the test had just located, so it stayed green with every
  // call site deleted. Count the occurrences that are NOT the definition.
  const definedAt = server.indexOf('function missionChatId(') + 'function '.length
  const callSites = [...server.matchAll(/\bmissionChatId\(/g)].filter(
    (m) => m.index !== definedAt,
  ).length
  assert.ok(
    callSites > 0,
    'missionChatId must actually be called, not merely defined',
  )
})

test('the implicit mission chat goes through the pure rule, never straight to the first chat', () => {
  // A mission create the backend refuses is a 400 the agent cannot act on, so
  // the two implicit sources must skip a room and a chat whose last inbound
  // came from somebody other than the owner. The rule lives in
  // lib/missions.ts, where it is unit tested; this keeps the wiring honest.
  const start = server.indexOf('function resolveMissionToolChat(')
  assert.ok(start > 0, 'resolveMissionToolChat must exist')
  const end = server.indexOf('\n}', start)
  const bodyText = server.slice(start, end)
  assert.ok(
    bodyText.includes('pickImplicitMissionChat('),
    'the implicit chat must come from the pure rule, not from an inline guess',
  )
  assert.ok(bodyText.includes('isRoom:'), 'the rule must be told which chats are rooms')
  assert.ok(
    bodyText.includes('lastInboundUserId:'),
    'the rule must be told who last wrote in each chat, or a recipient DM is chosen',
  )

  // And the three tool cases have to ASK it. Everything above this line is
  // still green while resolveMissionToolChat sits in the file uncalled and the
  // cases pick monitoredChatIds[0] inline, which is the one shape this test
  // exists to forbid, so the call sites are pinned here rather than assumed.
  for (const tool of ['create_mission', 'tick_mini_goal', 'complete_mission']) {
    const at = server.indexOf(`case '${tool}': {`)
    assert.ok(at > 0, `${tool} case not found`)
    const nextCase = server.indexOf("\n    case '", at + 10)
    const caseBody = server.slice(at, nextCase > 0 ? nextCase : at + 6000)
    assert.ok(
      caseBody.includes('resolveMissionToolChat('),
      `${tool} must take its chat from resolveMissionToolChat, not from an inline guess`,
    )
  }
})

test('the mission tools accept an optional chat, and it stays optional', () => {
  // Making chat_id required would break every 0.40.0-era prompt habit and
  // every single-chat agent, and an omitted chat is DEFINED to mean the main
  // chat.
  for (const tool of ['create_mission', 'tick_mini_goal', 'complete_mission']) {
    const at = server.indexOf(`name: '${tool}',`)
    assert.ok(at > 0, `${tool} declaration not found`)
    const end = server.indexOf("    {\n      name: '", at)
    const decl = server.slice(at, end > 0 ? end : at + 5000)
    assert.ok(decl.includes('chat_id: {'), `${tool} must accept an optional chat_id`)
    assert.ok(
      !/required: \[[^\]]*chat_id/.test(decl),
      `${tool} must NOT make chat_id required`,
    )
  }
  assert.match(server, /required: \['title', 'mini_goals'\]/)
})

test('the create_mission description says one open mission per CHAT, because that is now true', () => {
  // The rule the model reads has to match the rule the server enforces. While
  // this said "one active mission per agent" an agent with two chats would
  // believe that starting a mission in chat B killed chat A's, which is the
  // opposite of what per-chat scope does, and it would refuse to start the
  // second one at all.
  const at = server.indexOf("name: 'create_mission',")
  assert.ok(at > 0)
  const decl = server.slice(at, server.indexOf("    {\n      name: '", at))
  assert.ok(
    !/active mission per agent/.test(decl),
    'create_mission must not tell the model a mission is one per agent',
  )
  assert.match(decl, /open mission per CHAT/)
})

test('the active-mission read is scoped to a chat, or a tick lands on another chat card', () => {
  const start = server.indexOf('async function resolveMissionId(')
  assert.ok(start > 0)
  const end = server.indexOf('\n}', start)
  const body = server.slice(start, end)
  assert.ok(
    /buildMissionActivePath\([^)]*,/.test(body),
    'resolveMissionId must pass the chat into buildMissionActivePath',
  )
})
