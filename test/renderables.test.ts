import { describe, expect, test } from 'bun:test'
import {
  BUNDLED_RENDERABLES_FALLBACK,
  buildComponentEventMessage,
  deriveComponentTitle,
  findRenderable,
  listRenderableKinds,
  normalizeComponentPayloadArg,
  validateComponentPayload,
  type RenderableWireSchema,
} from '../lib/renderables'
import { buildHealthTrackerCardMessage } from '../lib/health-log'

// The wire shape GET /api/v1/renderables serves (Phase A, BGOS #767).
const MANIFEST = {
  renderables: [
    {
      kind: 'health_tracker_card',
      payloadSchema: {
        type: 'object',
        required: ['kind'],
        properties: {
          kind: { type: 'string', const: 'health_tracker_card' },
          note: { type: 'string', maxLength: 300 },
        },
      },
      minAppVersion: '4.0.0',
      category: 'health',
      description:
        'The native health tracker card inline in chat (tap-through opens ' +
        'the full dashboard). Optional note renders as a short agent ' +
        'message on the card.',
    },
    {
      kind: 'calendar_peek',
      payloadSchema: {
        type: 'object',
        required: ['kind', 'day'],
        properties: {
          kind: { type: 'string', const: 'calendar_peek' },
          day: { type: 'string', maxLength: 10 },
          headline: { type: 'string', maxLength: 120 },
          // A field type this plugin version does not know how to check yet.
          slots: { type: 'array' },
        },
      },
      minAppVersion: '4.1.0',
      category: 'productivity',
      description: 'Calendar peek',
    },
  ],
}

describe('findRenderable / listRenderableKinds', () => {
  test('finds an entry by kind', () => {
    const entry = findRenderable(MANIFEST, 'health_tracker_card')
    expect(entry?.kind).toBe('health_tracker_card')
    expect(entry?.minAppVersion).toBe('4.0.0')
  })

  test('unknown kind answers undefined and the kind list stays honest', () => {
    expect(findRenderable(MANIFEST, 'mission_progress')).toBeUndefined()
    expect(listRenderableKinds(MANIFEST)).toEqual([
      'health_tracker_card',
      'calendar_peek',
    ])
  })

  test('is defensive against malformed manifests', () => {
    for (const bad of [null, undefined, 42, 'x', [], {}, { renderables: 7 }]) {
      expect(findRenderable(bad, 'health_tracker_card')).toBeUndefined()
      expect(listRenderableKinds(bad)).toEqual([])
    }
    // Entries without a string kind are skipped, valid siblings survive.
    const mixed = {
      renderables: [null, { note: 'x' }, { kind: 'ok_card' }],
    }
    expect(listRenderableKinds(mixed)).toEqual(['ok_card'])
  })

  test('bundled fallback mirrors the Phase A backend entry', () => {
    const entry = findRenderable(
      BUNDLED_RENDERABLES_FALLBACK,
      'health_tracker_card',
    )
    expect(entry?.kind).toBe('health_tracker_card')
    const schema = entry?.payloadSchema as {
      properties: Record<string, Record<string, unknown>>
    }
    expect(schema.properties.note.maxLength).toBe(300)
  })
})

describe('normalizeComponentPayloadArg', () => {
  test('missing payload becomes an empty object', () => {
    expect(normalizeComponentPayloadArg(undefined)).toEqual({
      ok: true,
      payload: {},
    })
    expect(normalizeComponentPayloadArg(null)).toEqual({ ok: true, payload: {} })
  })

  test('non-object payloads are rejected with a clear error', () => {
    for (const bad of ['x', 5, true, ['a']]) {
      const r = normalizeComponentPayloadArg(bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('payload must be a JSON object')
    }
  })
})

describe('validateComponentPayload', () => {
  const schema = MANIFEST.renderables[0].payloadSchema as RenderableWireSchema
  const calendarSchema = MANIFEST.renderables[1]
    .payloadSchema as RenderableWireSchema

  test('accepts a valid payload (kind is never required from the agent)', () => {
    expect(validateComponentPayload(schema, { note: 'hi' })).toEqual({
      ok: true,
    })
    expect(validateComponentPayload(schema, {})).toEqual({ ok: true })
  })

  test('ignores unknown extra fields (additive-only forward compat)', () => {
    expect(
      validateComponentPayload(schema, {
        note: 'hi',
        futureField: { deep: true },
        another: 7,
      }),
    ).toEqual({ ok: true })
  })

  test('type mismatch names the field', () => {
    const r = validateComponentPayload(schema, { note: 42 })
    expect(r).toEqual({ ok: false, error: 'note must be a string' })
  })

  test('maxLength is enforced with the specific limit', () => {
    const r = validateComponentPayload(schema, { note: 'x'.repeat(301) })
    expect(r).toEqual({
      ok: false,
      error: 'note must be at most 300 characters',
    })
    expect(validateComponentPayload(schema, { note: 'x'.repeat(300) })).toEqual(
      { ok: true },
    )
  })

  test('missing required field is reported', () => {
    const r = validateComponentPayload(calendarSchema, { headline: 'Busy' })
    expect(r).toEqual({ ok: false, error: 'day is required' })
  })

  test('payload.kind may be included only when it matches the schema const', () => {
    expect(
      validateComponentPayload(schema, { kind: 'health_tracker_card' }),
    ).toEqual({ ok: true })
    const mismatch = validateComponentPayload(schema, { kind: 'other_card' })
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) {
      expect(mismatch.error).toContain('payload.kind must be "health_tracker_card"')
    }
    const nonString = validateComponentPayload(schema, { kind: 9 })
    expect(nonString.ok).toBe(false)
  })

  test('a declared type this plugin version does not know passes unchecked', () => {
    expect(
      validateComponentPayload(calendarSchema, {
        day: '2026-07-18',
        slots: 'not-actually-an-array',
      }),
    ).toEqual({ ok: true })
  })

  test('tolerates a missing or malformed schema (nothing to check)', () => {
    expect(validateComponentPayload(undefined, { anything: 1 })).toEqual({
      ok: true,
    })
    expect(
      validateComponentPayload(
        { required: 'nope', properties: [] } as unknown as RenderableWireSchema,
        { anything: 1 },
      ),
    ).toEqual({ ok: true })
  })
})

describe('deriveComponentTitle', () => {
  test('derives from the kind, stripping the presentation suffix', () => {
    expect(deriveComponentTitle('health_tracker_card')).toBe('Health tracker')
    expect(deriveComponentTitle('mission_progress')).toBe('Mission progress')
    expect(deriveComponentTitle('analytics-card')).toBe('Analytics')
  })

  test('a long sentence description falls back to the kind', () => {
    expect(
      deriveComponentTitle(
        'health_tracker_card',
        MANIFEST.renderables[0].description,
      ),
    ).toBe('Health tracker')
  })

  test('a short phrase description is used directly', () => {
    expect(deriveComponentTitle('calendar_peek', 'Calendar peek')).toBe(
      'Calendar peek',
    )
  })
})

describe('buildComponentEventMessage', () => {
  const base = {
    kind: 'health_tracker_card',
    chatId: 1048,
    assistantId: '873',
    description: MANIFEST.renderables[0].description,
  }

  test('produces the event wire body shape', () => {
    const r = buildComponentEventMessage({ ...base, payload: { note: 'hi' } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.body).toEqual({
      chatId: 1048,
      assistantId: 873,
      sender: 'assistant',
      text: 'Health tracker: hi',
      messageType: 'event',
      eventMeta: {
        source: 'agent',
        title: 'Health tracker',
        peek: 'hi',
        payload: { kind: 'health_tracker_card', note: 'hi' },
      },
    })
  })

  test('no note means no peek and a bare title fallback', () => {
    const r = buildComponentEventMessage({ ...base, payload: {} })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.body.text).toBe('Health tracker')
    expect(r.body.eventMeta.peek).toBeUndefined()
    expect(r.body.eventMeta.payload).toEqual({ kind: 'health_tracker_card' })
  })

  test('extra payload fields ride along; payload.kind can never clobber', () => {
    const r = buildComponentEventMessage({
      ...base,
      kind: 'calendar_peek',
      description: 'Calendar peek',
      payload: { kind: 'evil_kind', day: '2026-07-18', headline: 'Busy' },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.body.eventMeta.payload).toEqual({
      kind: 'calendar_peek',
      day: '2026-07-18',
      headline: 'Busy',
    })
    expect(r.body.eventMeta.title).toBe('Calendar peek')
  })

  test('rejects bad ids the same way the V1 builder did', () => {
    expect(
      buildComponentEventMessage({ ...base, assistantId: 'nope', payload: {} }),
    ).toEqual({ ok: false, error: 'daemon assistant id is not numeric' })
    expect(
      buildComponentEventMessage({ ...base, chatId: Number.NaN, payload: {} }),
    ).toEqual({ ok: false, error: 'chat id did not resolve to a number' })
    expect(buildComponentEventMessage({ ...base, kind: ' ', payload: {} })).toEqual(
      { ok: false, error: 'kind is required' },
    )
  })
})

describe('alias parity: show_health_tracker == show_component', () => {
  const deps = { chatId: 1048, assistantId: '873' }
  const entry = MANIFEST.renderables[0]

  function genericBody(note?: string) {
    const r = buildComponentEventMessage({
      kind: 'health_tracker_card',
      payload: note !== undefined ? { note } : {},
      chatId: deps.chatId,
      assistantId: deps.assistantId,
      description: entry.description,
    })
    expect(r.ok).toBe(true)
    return r.ok ? r.body : undefined
  }

  test('identical wire bodies for the same note', () => {
    const v1 = buildHealthTrackerCardMessage({ note: 'Protein streak: 5 days' }, deps)
    expect(v1.ok).toBe(true)
    if (!v1.ok) return
    expect(genericBody('Protein streak: 5 days')).toEqual(
      v1.body as unknown as ReturnType<typeof genericBody>,
    )
  })

  test('identical wire bodies with no note', () => {
    const v1 = buildHealthTrackerCardMessage({}, deps)
    expect(v1.ok).toBe(true)
    if (!v1.ok) return
    expect(genericBody(undefined)).toEqual(
      v1.body as unknown as ReturnType<typeof genericBody>,
    )
  })

  test('identical maxLength error message at the 300-char cap', () => {
    const long = 'x'.repeat(301)
    const v1 = buildHealthTrackerCardMessage({ note: long }, deps)
    expect(v1.ok).toBe(false)
    const generic = validateComponentPayload(
      entry.payloadSchema as RenderableWireSchema,
      { note: long },
    )
    expect(generic.ok).toBe(false)
    if (!v1.ok && !generic.ok) expect(generic.error).toBe(v1.error)
  })
})
