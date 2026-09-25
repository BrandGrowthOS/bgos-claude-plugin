/**
 * Source guard: the armed goal case (P6 stage 3, C-32, spec 4.3) is wired into
 * server.ts the way lib/stop-pause.ts expects, and every rail an owner message
 * can arrive on reaches it.
 *
 * The decision half is unit tested in test/stop-pause.test.ts. What only a
 * source scan can hold is the wiring of a 10k line monolith that no test can
 * import, and each trap below ships GREEN if it is not pinned:
 *
 * 1. The Stop hook. lib/voice-rpc.ts calls onStopDelivered only when the
 *    [stop_turn] notice reached the live session; a server that never passes
 *    the dep pauses nothing and every lane test still passes.
 * 2. The gate. "Declares mission_pause on this beat" must be the SAME
 *    expression the heartbeat declares from, or the daemon could pause a
 *    mission on a host whose owner was never offered Pause.
 * 3. The goal lane state. The view is read from the four records the goal
 *    lane keeps (goalHeld, goalMissionId, goalPendingArm, goalStopped).
 * 4. The rails. An owner message arrives by WebSocket, by the chat poll, or by
 *    the update stream, and a rail that forgets the call leaves the mission
 *    paused for as long as that rail is the one delivering. Each call sits
 *    AFTER the rail's content guard, so a /status or /compact the daemon
 *    answers itself, and a meeting turn, never resume anything.
 * 5. The writes. The pause and the resume stamp the self write BEFORE the
 *    request (inside the lane) and ride the user scoped mission routes, the
 *    family every other goal lane write already uses.
 *
 * The repo idiom for a source scan: read through an import.meta.url URL and
 * normalise CRLF to LF first, so the assertions describe the code and not the
 * checkout.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** The body of a top level or nested function, from its declaration to the
 *  next line that closes a block at the same indent. */
function functionBody(name: string): string {
  const at = server.indexOf(`function ${name}(`)
  assert.ok(at >= 0, `function ${name} not found in server.ts`)
  const lineStart = server.lastIndexOf('\n', at) + 1
  const indent = server.slice(lineStart, at).match(/^\s*/)?.[0] ?? ''
  const end = server.indexOf(`\n${indent}}\n`, at)
  assert.ok(end > at, `the end of function ${name} not found`)
  return server.slice(at, end)
}

test('the voice rpc Stop hands a delivered stop to the armed goal case', () => {
  const at = server.indexOf('const voiceRpc = new VoiceRpcHandler({')
  assert.ok(at > 0, 'the VoiceRpcHandler construction moved')
  const end = server.indexOf('\n})\n', at)
  const deps = server.slice(at, end)
  assert.match(deps, /onStopDelivered: \(chatId\) => pauseArmedGoalOnStop\(chatId\)/)
})

test('the stop reads the goal lane as it is at that moment, gated on the heartbeat own declaration', () => {
  const body = functionBody('stopGoalView')
  // The SAME expression the version heartbeat declares from.
  assert.ok(
    server.includes('capabilities: () => [...declaredCapabilities({ canInjectGoal: compactTarget !== null })]'),
    'the heartbeat declaration moved; keep the stop gate on the same expression',
  )
  assert.ok(
    body.includes("declaredCapabilities({ canInjectGoal: compactTarget !== null }).includes('mission_pause')"),
    'the stop pauses only where mission_pause is declared on this beat',
  )
  for (const record of ['goalHeld', 'goalMissionId', 'goalPendingArm', 'goalStopped']) {
    assert.ok(body.includes(record), `the stop view must read ${record}`)
  }
})

test('the Stop and the owner message both run as tracked operations, never awaited inline', () => {
  const stop = functionBody('pauseArmedGoalOnStop')
  assert.match(stop, /trackMessageOperation\(\(\) =>\s*stopPauseLane\.stopDelivered\(chatId, view\)/)
  assert.ok(
    stop.indexOf('const view = stopGoalView()') >= 0 &&
      stop.indexOf('const view = stopGoalView()') < stop.indexOf('stopPauseLane.stopDelivered('),
    'the view is taken synchronously, before anything awaits',
  )
  const owner = functionBody('noteOwnerMessageForStopPause')
  assert.match(owner, /isOwnerAuthoredInbound\(\{[\s\S]*ownerUserId: USER_ID/)
  assert.match(owner, /trackMessageOperation\(\(\) =>\s*stopPauseLane\.ownerMessage\(chatId\)/)
})

test('the lane writes through the user scoped routes, and stamps with the ledger the echo is read against', () => {
  const at = server.indexOf('const stopPauseLane = new StopPauseLane({')
  assert.ok(at > 0, 'the StopPauseLane construction is missing')
  const end = server.indexOf('\n})\n', at)
  const deps = server.slice(at, end)
  assert.match(deps, /buildMissionActivePath\(ASSISTANT_ID, chatId\)/)
  assert.match(deps, /buildMissionPausePath\(ASSISTANT_ID, missionId\)/)
  assert.match(deps, /buildMissionResumePath\(ASSISTANT_ID, missionId\)/)
  assert.match(deps, /bgosPatch\(pause\.path, \{ reason \}\)/)
  assert.match(deps, /bgosPatch\(resume\.path, \{\}\)/)
  assert.match(deps, /notePendingSelfWrite: \(missionId\) => noteMissionPendingSelfWrite\(missionId\)/)
  assert.match(deps, /noteSelfWritten: \(mission\) => rememberMissionSelfWrite\(mission\)/)
})

test('every inbound rail reports an owner message, after its content guard and before the delivery', () => {
  const calls = [...server.matchAll(/noteOwnerMessageForStopPause\(chatId, \{/g)].map((m) => m.index!)
  assert.equal(calls.length, 3, 'one call on each of the poll, the update stream and the WebSocket')

  const rails: Array<{ name: string; guard: string; start: number }> = [
    { name: 'poll', guard: 'if (!content) continue', start: server.indexOf('const pollChannel = buildInboundChannel({') },
    { name: 'stream', guard: 'if (!content) return', start: server.indexOf('const streamChannel = buildInboundChannel({') },
    { name: 'ws', guard: 'if (!content) return', start: server.indexOf('const wsChannel = buildInboundChannel({') },
  ]
  for (const rail of rails) {
    assert.ok(rail.start > 0, `${rail.name}: the channel build moved`)
    const guard = server.indexOf(rail.guard, rail.start)
    assert.ok(guard > rail.start, `${rail.name}: the content guard moved`)
    const call = calls.find((c) => c > guard)
    assert.ok(call !== undefined, `${rail.name}: no owner message report after the content guard`)
    const delivery = server.indexOf("method: 'notifications/claude/channel'", guard)
    assert.ok(call! < delivery, `${rail.name}: the report must come before the delivery`)
    // Nothing between the guard and the report returns early.
    const between = server.slice(guard + rail.guard.length, call)
    assert.doesNotMatch(between, /\n\s*(return|continue)\b/, `${rail.name}: an early exit sits before the report`)
  }
})
