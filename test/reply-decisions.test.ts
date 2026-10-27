/**
 * A reply with buttons asks exactly one thing (scope section 6). When one
 * asks 2 or more decisions, the reply tool still sends it as written and adds
 * ONE line to its result naming the ask_user_input card (lib/reply-card-shape.ts
 * decisionCount and multiDecisionLine). Conservative on purpose: a decision is
 * a prose line that ENDS in a question mark, so a rhetorical question answered
 * on the same line, a quote, code and a URL never count, and "Or ...?" restates
 * the choice before it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { decisionCount, multiDecisionLine } from '../lib/reply-card-shape.ts'

test('two questions on their own lines are two decisions', () => {
  assert.equal(decisionCount('Should I deploy tonight?\nWhich region should it go to?'), 2)
})

test('a list of questions counts each one', () => {
  const text = 'Before I start:\n1. Postgres or MySQL?\n2. Keep the old table?\n3. Run the backfill now?'
  assert.equal(decisionCount(text), 3)
  assert.equal(decisionCount('Two things:\n- **Ship it today?**\n- Tell the team?'), 2)
})

test('numbered questions on one line count each one', () => {
  assert.equal(decisionCount('1) Postgres or MySQL? 2) Keep the old table?'), 2)
})

test('one question, or one restated with Or, is one decision', () => {
  assert.equal(decisionCount('Should I go ahead?'), 1)
  assert.equal(decisionCount('Should I go ahead?\nOr would you rather wait until Monday?'), 1)
})

test('a rhetorical question answered on its line, a quote, code and a URL never count', () => {
  const text = [
    'Why did it fail? The cache was stale, so I cleared it.',
    '> Can we ship by Friday?',
    'See https://example.com/search?q=one for the trace.',
    '```',
    'if (ready?) deploy()?',
    '```',
    'Want me to rerun the job?',
  ].join('\n')
  assert.equal(decisionCount(text), 1)
})

test('never throws on a non string', () => {
  assert.equal(decisionCount(undefined as unknown as string), 0)
})

test('the line names the card, says the reply went as written, and has no dashes', () => {
  const line = multiDecisionLine(3)
  assert.match(line, /3 decisions/)
  assert.match(line, /ask_user_input/)
  assert.match(line, /exactly one/)
  assert.match(line, /sent as you wrote it/i)
  assert.doesNotMatch(line, /[–—]/)
})

test('the reply tool warns after the send, only for a reply with buttons, never in a peer thread', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const at = server.indexOf("\n    case 'reply': {")
  const body = server.slice(at, server.indexOf("\n    case '", at + 10))
  const sent = body.indexOf('log(`reply sent to chat')
  const warn = body.indexOf('decisionCount(')
  assert.ok(sent >= 0 && warn > sent, 'counted after the message went out')
  assert.match(body.slice(warn - 200, warn + 200), /options\.length > 0/)
  assert.match(body.slice(warn - 200, warn + 200), /peerConvByChat\.has\(String\(resolvedChatId\)\)/)
  assert.match(body, /multiDecisionLine\(decisions\)/)
})

test('an Arabic or full width question mark ends a question too (review of PR 1, Minor 12)', () => {
  assert.equal(decisionCount('هل أنشر الليلة؟\nأي منطقة؟'), 2)
  assert.equal(decisionCount('今晚部署吗？\n哪个区域？'), 2)
})
