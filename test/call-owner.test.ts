/**
 * Eval suite for the `call_owner` MCP tool's pure body-builder.
 *
 * Run with:  npm test      (node --test via tsx, no extra deps)
 *
 * Coverage:
 *   - Minimal body (assistantId only).
 *   - chatId inclusion / omission (finite vs undefined/null/NaN).
 *   - reason normalization: the ring-screen rule (Kc, 2026-09-03). One or
 *     two plain sentences, at most 140 characters, no markdown or line
 *     breaks, cut at a word boundary, never an added ellipsis. The backend
 *     applies the same rule (BGOS backend/src/voice/call-reason.ts); the
 *     plugin pre-caps so the wire body already matches what the phone shows.
 *   - Full body with every field.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCallOwnerBody,
  CALL_OWNER_REASON_MAX,
  CALL_OWNER_REASON_MAX_SENTENCES,
  normalizeCallOwnerReason,
} from '../lib/call-owner.ts'

test('the caps match the ring-screen rule: two sentences, 140 characters', () => {
  assert.equal(CALL_OWNER_REASON_MAX, 140)
  assert.equal(CALL_OWNER_REASON_MAX_SENTENCES, 2)
})

test('buildCallOwnerBody: minimal, assistantId only', () => {
  assert.deepEqual(buildCallOwnerBody({ assistantId: 900 }), { assistantId: 900 })
})

test('buildCallOwnerBody: includes chatId when it is a finite number', () => {
  assert.deepEqual(buildCallOwnerBody({ assistantId: 900, chatId: 1050 }), {
    assistantId: 900,
    chatId: 1050,
  })
})

test('buildCallOwnerBody: omits chatId when undefined / null / NaN', () => {
  assert.deepEqual(buildCallOwnerBody({ assistantId: 900, chatId: undefined }), {
    assistantId: 900,
  })
  assert.deepEqual(buildCallOwnerBody({ assistantId: 900, chatId: null }), {
    assistantId: 900,
  })
  assert.deepEqual(buildCallOwnerBody({ assistantId: 900, chatId: Number.NaN }), {
    assistantId: 900,
  })
})

test('buildCallOwnerBody: includes a trimmed reason', () => {
  assert.deepEqual(
    buildCallOwnerBody({ assistantId: 900, reason: '  hop on a quick call  ' }),
    { assistantId: 900, reason: 'hop on a quick call' },
  )
})

test('buildCallOwnerBody: omits empty / whitespace-only / markup-only reason (never sends "")', () => {
  assert.deepEqual(buildCallOwnerBody({ assistantId: 900, reason: '' }), {
    assistantId: 900,
  })
  assert.deepEqual(buildCallOwnerBody({ assistantId: 900, reason: '   ' }), {
    assistantId: 900,
  })
  assert.deepEqual(buildCallOwnerBody({ assistantId: 900, reason: '** **' }), {
    assistantId: 900,
  })
  assert.deepEqual(buildCallOwnerBody({ assistantId: 900, reason: null }), {
    assistantId: 900,
  })
})

test('buildCallOwnerBody: a single unbroken token is hard-cut to 140 chars (no boundary to use)', () => {
  const body = buildCallOwnerBody({ assistantId: 900, reason: 'x'.repeat(500) })
  assert.equal(body.reason?.length, CALL_OWNER_REASON_MAX)
  assert.equal(body.reason, 'x'.repeat(140))
})

test('buildCallOwnerBody: a long sentence is cut at a word boundary under 140, whole words only, no ellipsis', () => {
  const words: string[] = []
  let i = 0
  while (words.join(' ').length < 300) words.push(`word${i++}`)
  const body = buildCallOwnerBody({ assistantId: 900, reason: words.join(' ') })
  assert.ok(body.reason)
  assert.ok(body.reason.length <= CALL_OWNER_REASON_MAX)
  const outWords = body.reason.split(' ')
  assert.deepEqual(outWords, words.slice(0, outWords.length))
  assert.ok(!body.reason.endsWith(' '))
  assert.ok(!body.reason.includes('…'))
  assert.ok(!body.reason.endsWith('...'))
})

test('buildCallOwnerBody: truncation counts AFTER trim (leading/trailing space not billed)', () => {
  const padded = `${'   '}${'y'.repeat(250)}${'   '}`
  const body = buildCallOwnerBody({ assistantId: 900, reason: padded })
  assert.equal(body.reason?.length, 140)
  assert.equal(body.reason, 'y'.repeat(140))
})

test('buildCallOwnerBody: a reason at exactly 140 chars is kept whole', () => {
  const exact = 'z'.repeat(140)
  const body = buildCallOwnerBody({ assistantId: 900, reason: exact })
  assert.equal(body.reason, exact)
})

test('buildCallOwnerBody: newlines and whitespace runs collapse to single spaces', () => {
  assert.deepEqual(
    buildCallOwnerBody({ assistantId: 900, reason: 'Build   done.\n\nWant to\ttalk?' }),
    { assistantId: 900, reason: 'Build done. Want to talk?' },
  )
})

test('buildCallOwnerBody: markdown emphasis, code ticks and leading list markers are stripped', () => {
  assert.deepEqual(
    buildCallOwnerBody({ assistantId: 900, reason: '**Standup** in _five_ with `Ava`' }),
    { assistantId: 900, reason: 'Standup in five with Ava' },
  )
  assert.deepEqual(
    buildCallOwnerBody({ assistantId: 900, reason: '- Review the deck' }),
    { assistantId: 900, reason: 'Review the deck' },
  )
  assert.deepEqual(
    buildCallOwnerBody({ assistantId: 900, reason: '1. Review the deck' }),
    { assistantId: 900, reason: 'Review the deck' },
  )
  assert.deepEqual(
    buildCallOwnerBody({ assistantId: 900, reason: '# Heads up' }),
    { assistantId: 900, reason: 'Heads up' },
  )
})

test('buildCallOwnerBody: a paragraph keeps only its first two sentences', () => {
  const paragraph =
    'The deploy is green. I found one issue in the login flow! ' +
    'It only happens on Android. We should talk before I patch it.'
  assert.deepEqual(buildCallOwnerBody({ assistantId: 900, reason: paragraph }), {
    assistantId: 900,
    reason: 'The deploy is green. I found one issue in the login flow!',
  })
})

test('normalizeCallOwnerReason: a decimal or a domain is not a sentence end', () => {
  assert.equal(
    normalizeCallOwnerReason('Revenue is up 3.5 today. See api.example.com now. Third.'),
    'Revenue is up 3.5 today. See api.example.com now.',
  )
})

test('normalizeCallOwnerReason: null for empty and non-string input', () => {
  assert.equal(normalizeCallOwnerReason(''), null)
  assert.equal(normalizeCallOwnerReason('  \n '), null)
  assert.equal(normalizeCallOwnerReason(null), null)
  assert.equal(normalizeCallOwnerReason(undefined), null)
  assert.equal(normalizeCallOwnerReason(42), null)
})

test('buildCallOwnerBody: full body with every field', () => {
  assert.deepEqual(
    buildCallOwnerBody({ assistantId: 900, chatId: 1050, reason: 'daily standup' }),
    { assistantId: 900, chatId: 1050, reason: 'daily standup' },
  )
})
