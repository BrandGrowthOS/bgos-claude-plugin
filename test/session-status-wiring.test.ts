/**
 * server.ts wiring for the session status and the not responding verdict
 * (HOAI board row 9c3d6b2c, session liveness). The builder and the cadence
 * are unit tested in test/session-status.test.ts and
 * test/version-heartbeat.test.ts; these pins hold the daemon to feeding them
 * the right facts, because a wrong source here is silent: a fact taken from
 * this daemon's own doings (a poll, a delivery, its boot) would make a frozen
 * session look alive, and that is the whole failure this exists to fix.
 *
 * Run: npx tsx --test test/session-status-wiring.test.ts
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const functionBody = (signature: string): string => {
  const start = server.indexOf(signature)
  assert.ok(start >= 0, `server.ts no longer has ${signature}`)
  const end = server.indexOf('\n}\n', start)
  assert.ok(end > start, `could not find the end of ${signature}`)
  return server.slice(start, end)
}

test('the facts come from the session, never from this daemon\'s own doings', () => {
  const facts = functionBody('function sessionStatusFacts(): SessionFacts {')
  assert.match(facts, /turnInFlight: hookTurnLive \|\| hookTurn\.carried\.size > 0/)
  assert.match(facts, /turnSignal: hookTurnSignal\(\{ lastEventAtMs: lastHookEventAtMs, endedSessionId: hookEndedSessionId \}\)/)
  assert.match(facts, /questionsWaiting: pendingPermissions\.size \+ asksWaiting \+ openPlansByChat\.size/)
  assert.match(facts, /messagesWaiting: pendingInbounds\.size/)
  assert.match(facts, /running: countRunningWork\(hookTurn\)/)
  assert.match(
    facts,
    /sessionActivityAtMs: \[lastHookEventAtMs, agentTranscript\(\)\.activityMs, channelLiveness\.lastToolCallAt\]/,
  )
  // The daemon's boot, its deliveries and its own operations (polls, tool
  // handlers) are agent-state.json's business, not the session's.
  for (const own of ['DAEMON_START_MS', 'lastInboundAtMs', 'activeOperations', 'messageActivity']) {
    assert.equal(facts.includes(own), false, `the facts read ${own}`)
  }
})

test('the oldest waiting message is the oldest pending inbound', () => {
  const facts = functionBody('function sessionStatusFacts(): SessionFacts {')
  assert.match(facts, /for \(const pending of pendingInbounds\.values\(\)\)/)
  assert.match(facts, /Math\.min\(oldest, pending\.ts\)/)
})

test('only the pairing lock holder reports, through the existing heartbeat', () => {
  const at = server.indexOf('versionHeartbeat = startVersionHeartbeat({')
  assert.ok(at >= 0)
  const call = server.slice(at, server.indexOf('\n    })\n', at))
  assert.match(call, /sessionStatus: \(\) => \(lockHeld \? buildSessionStatus\(sessionStatusFacts\(\), Date\.now\(\)\) : null\)/)
})

test('a blocking question to the owner counts as a question for as long as it waits', () => {
  const at = server.indexOf("case 'ask_user_input': {")
  const ask = server.slice(at, server.indexOf("case 'complete_voice_task': {", at))
  const up = ask.indexOf('asksWaiting += 1')
  const loop = ask.indexOf('while (Date.now() < deadline && answers.size < targetIds.size)')
  const down = ask.indexOf('asksWaiting -= 1')
  assert.ok(up >= 0 && loop > up && down > loop, 'counted around the wait loop')
  assert.match(ask.slice(loop, down + 40), /\} finally \{\s*asksWaiting -= 1/)
})

test('the not responding verdict goes out at once, and so does its clearing', () => {
  // Before: it rode the next 6 hourly beat, so it could reach the server
  // hours after the daemon knew.
  const overdue = functionBody('function checkReplyOverdue(): void {')
  const escalate = overdue.slice(overdue.indexOf("} else if (deafAction === 'escalate') {"))
  assert.match(escalate, /deafEscalatedAt = now\s*\n\s*sweepUnresponsiveReport\(\)/)
  const sweep = functionBody('function sweepUnresponsiveReport(): void {')
  assert.match(sweep, /currentUnresponsiveError\(now\) !== null/)
  assert.match(sweep, /versionHeartbeat\?\.sendNow\(\)/)
  // One reading for the beat and the sweep, so they cannot disagree.
  const at = server.indexOf('versionHeartbeat = startVersionHeartbeat({')
  assert.match(server.slice(at, at + 3000), /currentUnresponsiveError\(now\),\s*\n\s*\)/)
  assert.match(server, /setInterval\(sweepUnresponsiveReport, SESSION_STATUS_TICK_MS\)\.unref\(\)/)
})
