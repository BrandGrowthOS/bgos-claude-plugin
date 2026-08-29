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
