/**
 * Eval suite for the `call_owner` MCP tool's pure body-builder.
 *
 * Run with:  npm test      (node --test, no extra deps)
 *
 * Coverage:
 *   - Minimal body (assistantId only).
 *   - chatId inclusion / omission (finite vs undefined/null/NaN).
 *   - reason trimming, empty-drop, and 200-char truncation (counted after trim).
 *   - Full body with every field.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildCallOwnerBody, CALL_OWNER_REASON_MAX } from '../lib/call-owner.ts'

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

test('buildCallOwnerBody: omits empty / whitespace-only reason (never sends "")', () => {
  assert.deepEqual(buildCallOwnerBody({ assistantId: 900, reason: '' }), {
    assistantId: 900,
  })
  assert.deepEqual(buildCallOwnerBody({ assistantId: 900, reason: '   ' }), {
    assistantId: 900,
  })
  assert.deepEqual(buildCallOwnerBody({ assistantId: 900, reason: null }), {
    assistantId: 900,
  })
})

test('buildCallOwnerBody: truncates an over-long reason to 200 chars', () => {
  const body = buildCallOwnerBody({ assistantId: 900, reason: 'x'.repeat(500) })
  assert.equal(body.reason?.length, CALL_OWNER_REASON_MAX)
  assert.equal(body.reason, 'x'.repeat(200))
})

test('buildCallOwnerBody: truncation counts AFTER trim (leading/trailing space not billed)', () => {
  const padded = `${'   '}${'y'.repeat(250)}${'   '}`
  const body = buildCallOwnerBody({ assistantId: 900, reason: padded })
  assert.equal(body.reason?.length, 200)
  assert.equal(body.reason, 'y'.repeat(200))
})

test('buildCallOwnerBody: a reason at exactly 200 chars is kept whole', () => {
  const exact = 'z'.repeat(200)
  const body = buildCallOwnerBody({ assistantId: 900, reason: exact })
  assert.equal(body.reason, exact)
})

test('buildCallOwnerBody: full body with every field', () => {
  assert.deepEqual(
    buildCallOwnerBody({ assistantId: 900, chatId: 1050, reason: 'daily standup' }),
    { assistantId: 900, chatId: 1050, reason: 'daily standup' },
  )
})
