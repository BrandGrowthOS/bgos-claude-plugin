import { describe, expect, test } from 'bun:test'
import {
  buildHealthLogEventBody,
  buildHealthLogListPath,
  buildHealthLogUndoPath,
  summarizeHealthLogList,
  summarizeHealthLogResult,
} from '../lib/health-log'

const DEPS = { assistantId: '873', uuid: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }

describe('buildHealthLogEventBody', () => {
  test('builds a minimal body with generated key, agent source, assistant id', () => {
    const r = buildHealthLogEventBody(
      { event_type: 'Meal', item_name: '  Chicken salad  ' },
      DEPS,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.body).toEqual({
      idempotencyKey: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      eventType: 'meal',
      itemName: 'Chicken salad',
      source: 'agent',
      assistantId: 873,
    })
  })

  test('carries optionals and allow_duplicate through', () => {
    const r = buildHealthLogEventBody(
      {
        event_type: 'supplement',
        item_name: 'Vitamin D',
        quantity: 2000,
        unit: 'IU',
        notes: 'morning',
        logged_at: '2026-07-18T09:30:00+04:00',
        timezone: 'Asia/Dubai',
        allow_duplicate: true,
      },
      DEPS,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.body.quantity).toBe(2000)
    expect(r.body.unit).toBe('IU')
    expect(r.body.loggedAt).toBe('2026-07-18T09:30:00+04:00')
    expect(r.body.allowDuplicate).toBe(true)
  })

  test('reuses a passed retry idempotency_key and rejects a malformed one', () => {
    const key = '123e4567-e89b-42d3-a456-426614174000'
    const ok = buildHealthLogEventBody(
      { event_type: 'meal', item_name: 'x', idempotency_key: key },
      DEPS,
    )
    expect(ok.ok && ok.body.idempotencyKey).toBe(key)
    const bad = buildHealthLogEventBody(
      { event_type: 'meal', item_name: 'x', idempotency_key: 'not-a-uuid' },
      DEPS,
    )
    expect(bad.ok).toBe(false)
  })

  test('rejects blanks, bad quantity, bad logged_at', () => {
    expect(buildHealthLogEventBody({ event_type: '  ', item_name: 'x' }, DEPS).ok).toBe(false)
    expect(buildHealthLogEventBody({ event_type: 'meal', item_name: '' }, DEPS).ok).toBe(false)
    expect(
      buildHealthLogEventBody(
        { event_type: 'meal', item_name: 'x', quantity: -1 },
        DEPS,
      ).ok,
    ).toBe(false)
    expect(
      buildHealthLogEventBody(
        { event_type: 'meal', item_name: 'x', logged_at: 'yesterday' },
        DEPS,
      ).ok,
    ).toBe(false)
  })

  test('omits assistantId when the daemon id is not numeric', () => {
    const r = buildHealthLogEventBody(
      { event_type: 'meal', item_name: 'x' },
      { assistantId: 'unknown', uuid: DEPS.uuid },
    )
    expect(r.ok && 'assistantId' in r.body).toBe(false)
  })
})

describe('summarizeHealthLogResult', () => {
  const body = buildHealthLogEventBody(
    { event_type: 'meal', item_name: 'Oats' },
    DEPS,
  )
  if (!body.ok) throw new Error('fixture build failed')

  test('created: confirms and echoes the id', () => {
    const s = summarizeHealthLogResult({ success: true, id: 'ev-1' }, body.body)
    expect(s).toContain('Logged')
    expect(s).toContain('ev-1')
  })

  test('idempotent replay: says nothing new was written', () => {
    const s = summarizeHealthLogResult(
      { success: true, id: 'ev-1', deduplicated: true },
      body.body,
    )
    expect(s).toContain('idempotent replay')
  })

  test('same-day duplicate: instructs ask-then-allow_duplicate with fresh key', () => {
    const s = summarizeHealthLogResult(
      {
        success: false,
        isDuplicate: true,
        existingLogId: 'ev-0',
        existingLoggedAt: '2026-07-18T08:00:00Z',
      },
      body.body,
    )
    expect(s).toContain('NOT logged')
    expect(s).toContain('allow_duplicate')
    expect(s).toContain('ev-0')
  })

  test('unknown shape: never claims success, echoes the retry key', () => {
    const s = summarizeHealthLogResult({}, body.body)
    expect(s).toContain('NOT logged')
    expect(s).toContain(body.body.idempotencyKey)
  })
})

describe('list + undo path builders', () => {
  test('list defaults to bare path, validates day', () => {
    const bare = buildHealthLogListPath({})
    expect(bare.ok && bare.path).toBe('health-log/events')
    const day = buildHealthLogListPath({ day: '2026-07-18', timezone: 'Asia/Dubai' })
    expect(day.ok && day.path).toBe(
      'health-log/events?day=2026-07-18&timezone=Asia%2FDubai',
    )
    expect(buildHealthLogListPath({ day: '18-07-2026' }).ok).toBe(false)
  })

  test('undo encodes the id and rejects junk', () => {
    const ok = buildHealthLogUndoPath('ev 1'.replace(' ', '-'))
    expect(ok.ok && ok.path).toBe('health-log/events/ev-1')
    expect(buildHealthLogUndoPath('').ok).toBe(false)
    expect(buildHealthLogUndoPath('a/b').ok).toBe(false)
    expect(buildHealthLogUndoPath(undefined).ok).toBe(false)
  })
})

describe('summarizeHealthLogList', () => {
  test('renders rows from array or {events} envelope, and the empty case', () => {
    const rows = [
      { id: 1, eventType: 'meal', itemName: 'Oats', quantity: 80, unit: 'g', loggedAt: '2026-07-18T07:00:00Z' },
      { id: 2, eventType: 'water', itemName: 'Water' },
    ]
    for (const resp of [rows, { events: rows }]) {
      const s = summarizeHealthLogList(resp)
      expect(s).toContain('2 event(s)')
      expect(s).toContain('[meal] Oats 80 g')
      expect(s).toContain('(id 2)')
    }
    expect(summarizeHealthLogList([])).toContain('No health events')
    expect(summarizeHealthLogList(null)).toContain('No health events')
  })
})
