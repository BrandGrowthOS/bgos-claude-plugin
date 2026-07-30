/**
 * Compaction confirmation: pure transcript analysis that decides whether an
 * injected /compact actually ran. Fixtures mirror REAL transcript entries
 * observed on this fleet (compact_boundary system entry + assistant usage
 * entries), so the parser is exercised against the wire shapes the CLI
 * writes, not idealized ones.
 *
 * Run with:  npm test      (node --test, no extra deps)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { evaluateCompactionOutcome } from '../lib/compact-confirm.ts'

// Real-shape fixtures (field layout copied from a live transcript).
const boundaryLine = (ts: string): string =>
  JSON.stringify({
    parentUuid: null,
    logicalParentUuid: 'f53bd54e-45da-4bc9-9e4d-eb793994cfce',
    isSidechain: false,
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: ts,
    uuid: 'aaf7cfe5-e526-45fd-a7db-1f867009e3fa',
  })

// Model pinned to a 200k family: these tests assert that the after-pct comes
// from the first post-boundary turn, so the denominator is incidental and is
// held fixed here rather than tracking the window table.
const assistantLine = (usedTokens: number, id: string): string =>
  JSON.stringify({
    parentUuid: 'd947bb1e-c736-4152-8ff8-a3362f932166',
    isSidechain: false,
    type: 'assistant',
    message: {
      model: 'claude-haiku-4-5',
      id,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: usedTokens,
        output_tokens: 120,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  })

const summaryUserLine = JSON.stringify({
  parentUuid: 'aaf7cfe5-e526-45fd-a7db-1f867009e3fa',
  isSidechain: false,
  type: 'user',
  isCompactSummary: true,
  message: { role: 'user', content: 'This session is being continued...' },
})

const T0 = Date.parse('2026-07-18T12:00:00.000Z')

test('pending while no compact_boundary exists', () => {
  const chunk = [assistantLine(180_000, 'msg_a'), ''].join('\n')
  assert.deepEqual(evaluateCompactionOutcome(chunk, T0), { state: 'pending' })
})

test('pending when the only boundary predates the injection', () => {
  const chunk = [
    boundaryLine('2026-07-18T11:00:00.000Z'),
    assistantLine(9_000, 'msg_b'),
    '',
  ].join('\n')
  assert.deepEqual(evaluateCompactionOutcome(chunk, T0), { state: 'pending' })
})

test('compacted with after-pct from the first post-boundary assistant turn', () => {
  const chunk = [
    assistantLine(180_000, 'msg_pre'),
    boundaryLine('2026-07-18T12:00:30.000Z'),
    summaryUserLine,
    assistantLine(10_000, 'msg_post'),
    '',
  ].join('\n')
  const outcome = evaluateCompactionOutcome(chunk, T0)
  assert.equal(outcome.state, 'compacted')
  assert.ok(outcome.state === 'compacted')
  assert.equal(outcome.boundaryMs, Date.parse('2026-07-18T12:00:30.000Z'))
  // 10000 * 100 / 200000 = 5
  assert.equal(outcome.afterPct, 5)
})

test('compacted with null after-pct when the session is idle post-boundary', () => {
  const chunk = [
    assistantLine(180_000, 'msg_pre'),
    boundaryLine('2026-07-18T12:00:30.000Z'),
    summaryUserLine,
    '',
  ].join('\n')
  const outcome = evaluateCompactionOutcome(chunk, T0)
  assert.equal(outcome.state, 'compacted')
  assert.ok(outcome.state === 'compacted')
  assert.equal(outcome.afterPct, null)
})

test('pre-boundary assistant entries never leak into after-pct', () => {
  const chunk = [
    assistantLine(190_000, 'msg_pre'),
    boundaryLine('2026-07-18T12:00:30.000Z'),
    '',
  ].join('\n')
  const outcome = evaluateCompactionOutcome(chunk, T0)
  assert.ok(outcome.state === 'compacted')
  assert.equal(outcome.afterPct, null)
})

test('malformed and partial tail lines are skipped', () => {
  const chunk = [
    'not json at all',
    boundaryLine('2026-07-18T12:00:30.000Z'),
    assistantLine(20_000, 'msg_post').slice(0, 40), // torn mid-append
    '',
  ].join('\n')
  const outcome = evaluateCompactionOutcome(chunk, T0)
  assert.ok(outcome.state === 'compacted')
  assert.equal(outcome.afterPct, null)
})
