/**
 * Eval suite for the `schedule` / `list_schedules` / `cancel_schedule` MCP
 * tools' pure builders.
 *
 * Run with:  npm test      (node --test, no extra deps)
 *
 * The wire contract is the FINAL agent-scoped backend surface
 * (/tmp/sched-contract-final.txt, authoritative):
 *   POST   scheduled-tasks/agent          { kind?, topic (1..500), instruction? (<=2000),
 *                                           fireAt? (ISO w/ offset), everyHours? (int 1..8760),
 *                                           recurrence?, chatId? (defaults to the agent main chat) }
 *          At least one of fireAt / everyHours / recurrence; everyHours+recurrence is a 400;
 *          fireAt+everyHours = anchored repeat.
 *   GET    scheduled-tasks/agent?status=active|done|cancelled|all   (default active)
 *   DELETE scheduled-tasks/agent/:id      soft cancel, idempotent
 *
 * Coverage:
 *   - kind whitelist (wake | call only).
 *   - topic required, trimmed, rejected over 500; instruction optional,
 *     trimmed, rejected over 2000, omitted when empty/null.
 *   - chatId optional: omitted unless a finite number (server defaults).
 *   - `when` as an ISO datetime string -> fireAt (offset + real calendar day
 *     required, no repeat fields).
 *   - `when` as { everyHours: N } -> everyHours (int 1..8760), periodHours
 *     accepted as an alias, optional fireAt anchor for anchored repeats.
 *   - `when` as a recurrence object -> recurrence only (no fireAt; the
 *     backend computes the first occurrence), validated to the backend's
 *     exact rules, nulls omitted, unknown keys dropped, freq+everyHours
 *     rejected.
 *   - list path builder: status enum validation, default plain path.
 *   - cancel path builder: agent-scoped path, trimming, URI encoding,
 *     rejection of empty/invalid ids.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildScheduleCreateBody,
  buildScheduleListPath,
  buildScheduleCancelPath,
  SCHEDULE_KINDS,
  SCHEDULE_TOPIC_MAX,
  SCHEDULE_INSTRUCTION_MAX,
  RECURRENCE_FREQS,
} from '../lib/schedule.ts'

// ── helpers ──────────────────────────────────────────────────────────────────

const WAKE_AT = '2026-07-10T09:00:00+04:00'

function base(overrides: Record<string, unknown> = {}) {
  return { kind: 'wake', topic: 't', when: WAKE_AT, ...overrides }
}

function okBody(input: Record<string, unknown>) {
  const result = buildScheduleCreateBody(input as any)
  assert.equal(result.ok, true, `expected ok, got error: ${(result as any).error}`)
  return (result as Extract<typeof result, { ok: true }>).body
}

function errOf(input: Record<string, unknown>) {
  const result = buildScheduleCreateBody(input as any)
  assert.equal(result.ok, false, `expected an error, got body: ${JSON.stringify((result as any).body)}`)
  return (result as Extract<typeof result, { ok: false }>).error
}

// ── exported constants ───────────────────────────────────────────────────────

test('constants: whitelists and caps are the contract values', () => {
  assert.deepEqual([...SCHEDULE_KINDS], ['wake', 'call'])
  assert.deepEqual([...RECURRENCE_FREQS], ['daily', 'weekly', 'monthly'])
  assert.equal(SCHEDULE_TOPIC_MAX, 500)
  assert.equal(SCHEDULE_INSTRUCTION_MAX, 2000)
})

// ── kind ─────────────────────────────────────────────────────────────────────

test('kind: accepts wake and call', () => {
  assert.equal(okBody(base({ kind: 'wake' })).kind, 'wake')
  assert.equal(okBody(base({ kind: 'call' })).kind, 'call')
})

test('kind: rejects anything outside the whitelist', () => {
  assert.match(errOf(base({ kind: 'sms' })), /kind/i)
  assert.match(errOf(base({ kind: 'WAKE' })), /kind/i)
  assert.match(errOf(base({ kind: 'meeting' })), /kind/i)
  assert.match(errOf(base({ kind: undefined })), /kind/i)
  assert.match(errOf(base({ kind: 42 })), /kind/i)
})

// ── topic ────────────────────────────────────────────────────────────────────

test('topic: required, non-empty after trim', () => {
  assert.match(errOf(base({ topic: undefined })), /topic/i)
  assert.match(errOf(base({ topic: '' })), /topic/i)
  assert.match(errOf(base({ topic: '   ' })), /topic/i)
  assert.match(errOf(base({ topic: 7 })), /topic/i)
})

test('topic: trimmed before sending', () => {
  assert.equal(okBody(base({ topic: '  check the deploy  ' })).topic, 'check the deploy')
})

test('topic: rejects (never silently truncates) over the cap; exactly the cap is fine', () => {
  const exact = 'x'.repeat(SCHEDULE_TOPIC_MAX)
  assert.equal(okBody(base({ topic: exact })).topic, exact)
  assert.match(errOf(base({ topic: 'x'.repeat(SCHEDULE_TOPIC_MAX + 1) })), /topic/i)
})

// ── instruction (optional detailed brief) ────────────────────────────────────

test('instruction: optional; trimmed; omitted when absent, null, or empty', () => {
  assert.equal('instruction' in okBody(base()), false)
  assert.equal('instruction' in okBody(base({ instruction: null })), false)
  assert.equal('instruction' in okBody(base({ instruction: '' })), false)
  assert.equal('instruction' in okBody(base({ instruction: '   ' })), false)
  assert.equal(
    okBody(base({ instruction: '  read the CI log first  ' })).instruction,
    'read the CI log first',
  )
})

test('instruction: rejected over 2000 chars; exactly 2000 is fine', () => {
  const exact = 'y'.repeat(SCHEDULE_INSTRUCTION_MAX)
  assert.equal(okBody(base({ instruction: exact })).instruction, exact)
  assert.match(
    errOf(base({ instruction: 'y'.repeat(SCHEDULE_INSTRUCTION_MAX + 1) })),
    /instruction/i,
  )
  assert.match(errOf(base({ instruction: 42 })), /instruction/i)
})

// ── chatId (optional; the backend defaults to the agent main chat) ──────────

test('chatId: omitted when undefined / null / NaN (server defaults to the main chat)', () => {
  assert.equal('chatId' in okBody(base()), false)
  assert.equal('chatId' in okBody(base({ chatId: null })), false)
  assert.equal('chatId' in okBody(base({ chatId: Number.NaN })), false)
})

test('chatId: included when a finite number', () => {
  assert.equal(okBody(base({ chatId: 946 })).chatId, 946)
})

// ── when: ISO string, one-shot -> fireAt ─────────────────────────────────────

test('when string: a valid ISO datetime becomes fireAt with NO repeat fields', () => {
  const body = okBody(base({ when: `  ${WAKE_AT}  ` }))
  assert.equal(body.fireAt, WAKE_AT)
  assert.equal('everyHours' in body, false)
  assert.equal('recurrence' in body, false)
})

test('when string: Z and seconds-less forms are accepted', () => {
  assert.equal(okBody(base({ when: '2026-07-10T05:00:00Z' })).fireAt, '2026-07-10T05:00:00Z')
  assert.equal(okBody(base({ when: '2026-07-10T05:00Z' })).fireAt, '2026-07-10T05:00Z')
})

test('when string: date-only and offset-less naive datetimes are rejected (offset required)', () => {
  assert.match(errOf(base({ when: '2026-07-10' })), /offset/i)
  assert.match(errOf(base({ when: '2026-07-10T09:00:00' })), /offset/i)
})

test('when string: impossible calendar dates are rejected even though Date.parse rolls them over', () => {
  assert.match(errOf(base({ when: '2026-02-30T09:00:00+04:00' })), /when/i)
  assert.match(errOf(base({ when: '2026-06-31T09:00:00Z' })), /when/i)
  assert.match(errOf(base({ when: '2027-02-29T09:00:00Z' })), /when/i)
  assert.equal(okBody(base({ when: '2028-02-29T09:00:00Z' })).fireAt, '2028-02-29T09:00:00Z')
})

test('when string: rejects prose, malformed dates, and non-ISO parseable strings', () => {
  assert.match(errOf(base({ when: 'tomorrow 9am' })), /when/i)
  assert.match(errOf(base({ when: '2026-13-45T00:00:00Z' })), /when/i)
  assert.match(errOf(base({ when: 'July 10 2026' })), /when/i)
  assert.match(errOf(base({ when: '' })), /when/i)
  assert.match(errOf(base({ when: '   ' })), /when/i)
})

test('when: required (missing / null / array / number rejected)', () => {
  assert.match(errOf(base({ when: undefined })), /when/i)
  assert.match(errOf(base({ when: null })), /when/i)
  assert.match(errOf(base({ when: [WAKE_AT] })), /when/i)
  assert.match(errOf(base({ when: 12345 })), /when/i)
})

// ── when: { everyHours } (periodHours accepted as an alias) ──────────────────

test('when everyHours: integer hours 1..8760 on the wire, no fireAt unless anchored', () => {
  const body = okBody(base({ when: { everyHours: 24 } }))
  assert.equal(body.everyHours, 24)
  assert.equal('fireAt' in body, false)
  assert.equal('recurrence' in body, false)
  assert.equal(okBody(base({ when: { everyHours: 1 } })).everyHours, 1)
  assert.equal(okBody(base({ when: { everyHours: 8760 } })).everyHours, 8760)
})

test('when everyHours: periodHours is accepted as an alias for tolerance', () => {
  const body = okBody(base({ when: { periodHours: 6 } }))
  assert.equal(body.everyHours, 6)
  assert.equal('periodHours' in body, false)
})

test('when everyHours: an optional ISO fireAt anchors the repeat (first fire pinned)', () => {
  const body = okBody(base({ when: { everyHours: 6, fireAt: WAKE_AT } }))
  assert.equal(body.everyHours, 6)
  assert.equal(body.fireAt, WAKE_AT)
})

test('when everyHours: a bad anchor fireAt is rejected, not dropped', () => {
  assert.match(errOf(base({ when: { everyHours: 6, fireAt: '2026-07-10' } })), /offset/i)
  assert.match(errOf(base({ when: { everyHours: 6, fireAt: 'tomorrow' } })), /when|fireAt/i)
})

test('when everyHours: rejects zero, negative, fractional, over-cap, non-number, and conflicting alias', () => {
  assert.match(errOf(base({ when: { everyHours: 0 } })), /everyHours/i)
  assert.match(errOf(base({ when: { everyHours: -3 } })), /everyHours/i)
  assert.match(errOf(base({ when: { everyHours: 0.5 } })), /everyHours/i)
  assert.match(errOf(base({ when: { everyHours: 8761 } })), /everyHours/i)
  assert.match(errOf(base({ when: { everyHours: '24' } })), /everyHours/i)
  assert.match(errOf(base({ when: { everyHours: 6, periodHours: 12 } })), /everyHours/i)
})

// ── when: recurrence object ──────────────────────────────────────────────────

test('recurrence daily: normalized rule only; the backend computes the first occurrence', () => {
  const body = okBody(base({ when: { freq: 'daily', atMinute: 540, tz: 'Asia/Dubai' } }))
  assert.deepEqual(body.recurrence, { freq: 'daily', atMinute: 540, tz: 'Asia/Dubai' })
  assert.equal('fireAt' in body, false)
  assert.equal('everyHours' in body, false)
})

test('recurrence weekly: daysOfWeek is REQUIRED (backend rule)', () => {
  assert.match(errOf(base({ when: { freq: 'weekly', atMinute: 0, tz: 'UTC' } })), /daysOfWeek/i)
  assert.deepEqual(
    okBody(base({ when: { freq: 'weekly', atMinute: 480, tz: 'Asia/Dubai', daysOfWeek: [1, 2, 3, 4, 5] } }))
      .recurrence,
    { freq: 'weekly', atMinute: 480, tz: 'Asia/Dubai', daysOfWeek: [1, 2, 3, 4, 5] },
  )
})

test('recurrence monthly: dayOfMonth is REQUIRED and 1..31', () => {
  assert.match(errOf(base({ when: { freq: 'monthly', atMinute: 0, tz: 'UTC' } })), /dayOfMonth/i)
  assert.match(
    errOf(base({ when: { freq: 'monthly', atMinute: 0, tz: 'UTC', dayOfMonth: 0 } })),
    /dayOfMonth/i,
  )
  assert.match(
    errOf(base({ when: { freq: 'monthly', atMinute: 0, tz: 'UTC', dayOfMonth: 32 } })),
    /dayOfMonth/i,
  )
  assert.match(
    errOf(base({ when: { freq: 'monthly', atMinute: 0, tz: 'UTC', dayOfMonth: 15.5 } })),
    /dayOfMonth/i,
  )
  assert.equal(
    okBody(base({ when: { freq: 'monthly', atMinute: 0, tz: 'UTC', dayOfMonth: 31 } })).recurrence
      ?.dayOfMonth,
    31,
  )
})

test('recurrence interval: integer 1..366 when present (backend rule)', () => {
  assert.equal(
    okBody(base({ when: { freq: 'daily', atMinute: 0, tz: 'UTC', interval: 2 } })).recurrence
      ?.interval,
    2,
  )
  for (const bad of [0, 367, 1.5, '2']) {
    assert.match(
      errOf(base({ when: { freq: 'daily', atMinute: 0, tz: 'UTC', interval: bad } })),
      /interval/i,
      `expected rejection for interval ${JSON.stringify(bad)}`,
    )
  }
})

test('recurrence: freq outside the whitelist is rejected', () => {
  assert.match(errOf(base({ when: { freq: 'yearly', atMinute: 0, tz: 'UTC' } })), /freq/i)
  assert.match(errOf(base({ when: { freq: 'DAILY', atMinute: 0, tz: 'UTC' } })), /freq/i)
})

test('recurrence: tz must be a REAL IANA zone, trimmed on the wire, max 64 chars', () => {
  assert.match(errOf(base({ when: { freq: 'daily', atMinute: 0 } })), /tz/i)
  assert.match(errOf(base({ when: { freq: 'daily', atMinute: 0, tz: '' } })), /tz/i)
  assert.match(errOf(base({ when: { freq: 'daily', atMinute: 0, tz: 9 } })), /tz/i)
  assert.match(errOf(base({ when: { freq: 'daily', atMinute: 0, tz: 'Not/AZone' } })), /tz/i)
  assert.match(
    errOf(base({ when: { freq: 'daily', atMinute: 0, tz: `Etc/${'x'.repeat(70)}` } })),
    /tz/i,
  )
  assert.equal(
    okBody(base({ when: { freq: 'daily', atMinute: 0, tz: '  Asia/Dubai  ' } })).recurrence?.tz,
    'Asia/Dubai',
  )
})

test('recurrence: atMinute must be an integer 0..1439 (minutes after local midnight)', () => {
  assert.match(errOf(base({ when: { freq: 'daily', tz: 'UTC' } })), /atMinute/i)
  assert.match(errOf(base({ when: { freq: 'daily', atMinute: -1, tz: 'UTC' } })), /atMinute/i)
  assert.match(errOf(base({ when: { freq: 'daily', atMinute: 1440, tz: 'UTC' } })), /atMinute/i)
  assert.match(errOf(base({ when: { freq: 'daily', atMinute: 8.5, tz: 'UTC' } })), /atMinute/i)
  assert.equal(
    okBody(base({ when: { freq: 'daily', atMinute: 1439, tz: 'UTC' } })).recurrence?.atMinute,
    1439,
  )
})

test('recurrence: daysOfWeek must be integers 0..6 (0=Sunday..6=Saturday)', () => {
  for (const bad of [[7], [-1], [1.5], ['1'], [], 'mon']) {
    assert.match(
      errOf(base({ when: { freq: 'weekly', atMinute: 0, tz: 'UTC', daysOfWeek: bad } })),
      /daysOfWeek/i,
      `expected rejection for daysOfWeek ${JSON.stringify(bad)}`,
    )
  }
})

test('recurrence: explicit null optional keys are omitted, never sent as null', () => {
  const body = okBody(
    base({
      when: { freq: 'daily', atMinute: 0, tz: 'UTC', interval: null, daysOfWeek: null, dayOfMonth: null },
    }),
  )
  assert.deepEqual(body.recurrence, { freq: 'daily', atMinute: 0, tz: 'UTC' })
})

test('recurrence: unknown keys are dropped from the wire body', () => {
  const body = okBody(
    base({ when: { freq: 'daily', atMinute: 0, tz: 'UTC', junk: 'x', nested: { a: 1 } } }),
  )
  assert.deepEqual(body.recurrence, { freq: 'daily', atMinute: 0, tz: 'UTC' })
})

test('recurrence: an object carrying BOTH freq and everyHours is a backend 400, rejected client-side', () => {
  assert.match(
    errOf(base({ when: { freq: 'daily', atMinute: 0, tz: 'UTC', everyHours: 24 } })),
    /one of/i,
  )
  assert.match(
    errOf(base({ when: { freq: 'daily', atMinute: 0, tz: 'UTC', periodHours: 24 } })),
    /one of/i,
  )
})

test('when object: unrecognized shape (neither freq nor everyHours) is rejected', () => {
  assert.match(errOf(base({ when: {} })), /when/i)
  assert.match(errOf(base({ when: { foo: 1 } })), /when/i)
})

// ── full body ────────────────────────────────────────────────────────────────

test('full body: every field together, nothing extra on the wire', () => {
  const body = okBody({
    kind: 'call',
    topic: 'weekly review call',
    instruction: 'pull the week numbers before ringing',
    when: { freq: 'weekly', atMinute: 600, tz: 'Asia/Dubai', daysOfWeek: [5] },
    chatId: 946,
  })
  assert.deepEqual(body, {
    kind: 'call',
    topic: 'weekly review call',
    instruction: 'pull the week numbers before ringing',
    chatId: 946,
    recurrence: { freq: 'weekly', atMinute: 600, tz: 'Asia/Dubai', daysOfWeek: [5] },
  })
})

// ── list path ────────────────────────────────────────────────────────────────

test('list: plain agent path by default (backend defaults to active)', () => {
  assert.deepEqual(buildScheduleListPath(undefined), { ok: true, path: 'scheduled-tasks/agent' })
})

test('list: valid status filters become a query param', () => {
  for (const status of ['active', 'done', 'cancelled', 'all']) {
    assert.deepEqual(buildScheduleListPath(status), {
      ok: true,
      path: `scheduled-tasks/agent?status=${status}`,
    })
  }
})

test('list: an unknown status is rejected, not passed through', () => {
  for (const bad of ['pending', 'ACTIVE', 42, {}]) {
    const result = buildScheduleListPath(bad as any)
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`)
  }
})

// ── cancel path ──────────────────────────────────────────────────────────────

test('cancel: builds the agent-scoped DELETE path from a string or number id', () => {
  assert.deepEqual(buildScheduleCancelPath('abc-123'), {
    ok: true,
    path: 'scheduled-tasks/agent/abc-123',
  })
  assert.deepEqual(buildScheduleCancelPath(42), { ok: true, path: 'scheduled-tasks/agent/42' })
})

test('cancel: trims string ids and URI-encodes unsafe characters', () => {
  assert.deepEqual(buildScheduleCancelPath('  abc  '), { ok: true, path: 'scheduled-tasks/agent/abc' })
  assert.deepEqual(buildScheduleCancelPath('a/b?c'), {
    ok: true,
    path: 'scheduled-tasks/agent/a%2Fb%3Fc',
  })
})

test('cancel: rejects empty, missing, and non-finite ids', () => {
  for (const bad of ['', '   ', null, undefined, Number.NaN, {}, []]) {
    const result = buildScheduleCancelPath(bad as any)
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`)
  }
})
