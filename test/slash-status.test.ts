/**
 * /status is the one command we can answer the way Anthropic's Telegram channel answers all three of
 * its chat commands: from state the bridge already owns, with no model in the loop, so the answer
 * cannot be wrong.
 *
 * The contrast this exists to close: our sixteen advertised builtins were all handed to the model as
 * a one-line label with an instruction to "execute its registered behavior now" and not to defer to
 * the terminal. For a command naming a terminal screen the model cannot open, the only compliant move
 * left is improvisation. A user tapped /clear, was told nothing, and was told thirteen minutes later
 * that context "has now been cleared". It had not.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { buildStatusAnswer, type StatusFacts } from '../lib/slash-status.ts'

const BASE: StatusFacts = {
  assistantId: '900',
  assistantName: 'Data',
  version: '0.38.6',
  installMethod: 'marketplace',
  supervised: 'launchd',
  autoUpdateEnrolled: true,
  lastInboundAgoMs: 12_000,
}

test('reports the facts the daemon owns, and names the agent', () => {
  const out = buildStatusAnswer(BASE)
  assert.match(out, /Data/)
  assert.match(out, /0\.38\.6/)
  assert.match(out, /marketplace/)
  assert.match(out, /launchd/)
})

test('says a missing fact is missing rather than inventing one', () => {
  const out = buildStatusAnswer({
    ...BASE,
    assistantName: null,
    version: null,
    installMethod: 'unknown',
  })
  assert.match(out, /not reported/i, 'an absent version must say so')
  assert.match(out, /unknown/i, 'an undetermined install method must say so')
  assert.doesNotMatch(out, /undefined|null|NaN/, 'never leak a placeholder into user-facing text')
})

test('an unsupervised agent is told plainly that restarts are manual', () => {
  const out = buildStatusAnswer({ ...BASE, supervised: 'none' })
  assert.match(out, /manual/i)
})

test('auto-update enrolment is reported both ways, because its absence is the silent failure', () => {
  assert.match(buildStatusAnswer({ ...BASE, autoUpdateEnrolled: true }), /updates automatically/i)
  const off = buildStatusAnswer({ ...BASE, autoUpdateEnrolled: false })
  assert.match(off, /not.*automatic|manual/i)
})

test('auto-update enrolment we could not determine is not reported as either', () => {
  const out = buildStatusAnswer({ ...BASE, autoUpdateEnrolled: null })
  assert.doesNotMatch(out, /updates automatically/i)
})

test('never says how long ago a message arrived when nothing has arrived', () => {
  const out = buildStatusAnswer({ ...BASE, lastInboundAgoMs: null })
  assert.match(out, /no messages yet/i)
  assert.doesNotMatch(out, /\bago\b/)
})

test('the answer is short enough to read on a phone', () => {
  const out = buildStatusAnswer(BASE)
  assert.ok(out.split('\n').length <= 6, 'status must stay glanceable')
  assert.ok(out.length < 400, `status was ${out.length} chars, too long for a chat bubble`)
})


// --- wiring contracts, both found by RUNNING the daemon ---------------------

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

test('the inbound clock is stamped before the daemon-answered commands take their early return', () => {
  // Found by driving the real daemon against a stub backend, not by a test: it answered a /status
  // that the user had just sent with "No messages yet this session". The clock was being stamped
  // where a message is handed to the MODEL, and /status never gets that far because it returns
  // first. Every unit test around it passed either way, which is exactly why this one is here.
  const pollLoopAt = serverSource.indexOf('const isSlashCommand = isSlashCommandPayload(msg.message)')
  assert.notEqual(pollLoopAt, -1, 'the poll accept point must still be findable')
  const stampAt = serverSource.lastIndexOf('lastInboundAtMs = Date.now()', pollLoopAt)
  assert.notEqual(stampAt, -1, 'the poll path must stamp the clock')

  const statusBranchAt = serverSource.indexOf("slashRoute.kind === 'status'", pollLoopAt)
  assert.notEqual(statusBranchAt, -1)
  assert.ok(
    stampAt < statusBranchAt,
    'the clock must be stamped BEFORE the status branch returns, or /status reports no messages',
  )
})

test('the websocket path stamps the clock at its own accept point too', () => {
  // The same defect, one rail over. Both paths deliver, so both have to record.
  const wsAcceptAt = serverSource.indexOf('const isWsSlashCommand = isSlashCommandPayload(payload ?? {})')
  assert.notEqual(wsAcceptAt, -1)
  const stampAt = serverSource.lastIndexOf('lastInboundAtMs = Date.now()', wsAcceptAt)
  assert.notEqual(stampAt, -1)
  const statusBranchAt = serverSource.indexOf("slashRoute.kind === 'status'", wsAcceptAt)
  assert.notEqual(statusBranchAt, -1)
  assert.ok(stampAt < statusBranchAt, 'same ordering, websocket rail')
})

test('/status is answered by the daemon at both delivery rails, and deduped across them', () => {
  // Poll and WebSocket both deliver the same message. Without the shared id set a user gets two
  // identical status bubbles, which is the failure the compact path already solved this way.
  const handled = serverSource.match(/alreadyHandledStatus\(/g) ?? []
  assert.equal(handled.length, 4, 'the definition plus one call on each of the THREE delivery rails')
  assert.match(serverSource, /handleStatusCommand\(chatId\)/)
})


test('the stream rail ANSWERS /status, because it can be the only rail that sees the message', () => {
  // Not a style choice, and the reason is easy to get wrong: forwardStreamInbound claims the message
  // id before anything else, deliberately, "so the WS and poll transports dedup against it". When the
  // stream sees a message first it is therefore the ONLY rail that will ever offer it, because both
  // others then skip it.
  //
  // The first version of this change copied the /compact precedent one line above and returned
  // silently, so a /status delivered over the stream was claimed, ignored, and never answered. The
  // precedent is correct for /compact and does not transfer: a replayed compact targets a session
  // state that no longer exists, while a status reply is built from current facts at send time, so a
  // late one is still a correct one.
  const at = serverSource.indexOf('async function forwardStreamInbound(')
  assert.notEqual(at, -1)
  const end = serverSource.indexOf('\nasync function ', at + 10)
  const body = serverSource.slice(at, end === -1 ? at + 12000 : end)

  const statusAt = body.indexOf("slashRoute.kind === 'status'")
  assert.notEqual(statusAt, -1, 'the stream rail must route status at all')
  const branch = body.slice(statusAt, statusAt + 2200)
  assert.match(branch, /handleStatusCommand\(chatId\)/, 'and must actually answer it')
  assert.match(branch, /alreadyHandledStatus/, 'guarded by the same shared id set as the other rails')

  // The contrast that makes the reasoning legible: /compact on this same rail must NOT act.
  const compactAt = body.indexOf("slashRoute.kind === 'compact'")
  assert.notEqual(compactAt, -1)
  const compactBranch = body.slice(compactAt, statusAt)
  assert.equal(
    /handleRemoteCompact\(/.test(compactBranch),
    false,
    'a replayed compact targets a dead session state and must stay ignored here',
  )
})
