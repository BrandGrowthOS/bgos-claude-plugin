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
          // A field type this plugin version does not know how to check yet
          // (string, number, boolean, array, and object are all checked now).
          slots: { type: 'integer' },
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
        slots: 'not-actually-an-integer',
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

// The rich Budget-board schema the backend serves for health_tracker_card
// since app 4.11.0: structured macros and supplements arrays. Mirrors
// backend/src/renderables/renderables-manifest.ts (the live manifest is
// authoritative at runtime; this fixture only drives the validator tests).
const RICH_HEALTH_SCHEMA: RenderableWireSchema = {
  type: 'object',
  required: ['kind'],
  properties: {
    kind: { type: 'string', const: 'health_tracker_card' },
    note: { type: 'string', maxLength: 300 },
    headline: { type: 'string', maxLength: 80 },
    macros: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        required: ['key', 'value', 'target'],
        properties: {
          key: { type: 'string', maxLength: 32 },
          label: { type: 'string', maxLength: 40 },
          value: { type: 'number', minimum: 0 },
          target: { type: 'number', exclusiveMinimum: 0 },
          targetHigh: { type: 'number' },
          unit: { type: 'string', maxLength: 16 },
          cap: { type: 'boolean' },
        },
      },
    },
    supplements: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        required: ['name', 'taken'],
        properties: {
          name: { type: 'string', maxLength: 60 },
          taken: { type: 'boolean' },
          time: { type: 'string', maxLength: 24 },
          note: { type: 'string', maxLength: 80 },
        },
      },
    },
    streak: { type: 'number' },
    streakLabel: { type: 'string', maxLength: 40 },
  },
}

const VALID_MACROS = [
  { key: 'calories', value: 1670, target: 3000, unit: 'kcal' },
  { key: 'protein', value: 132, target: 160, targetHigh: 240, unit: 'g' },
  { key: 'sodium', value: 1800, target: 2300, unit: 'mg', cap: true },
]

const VALID_SUPPLEMENTS = [
  { name: 'Vitamin D', taken: true, time: '9:12 AM' },
  { name: 'Magnesium', taken: false, time: 'this evening' },
]

describe('validateComponentPayload with the rich Budget-board schema', () => {
  test('valid macros and supplements pass', () => {
    expect(
      validateComponentPayload(RICH_HEALTH_SCHEMA, {
        note: 'On pace',
        macros: VALID_MACROS,
        supplements: VALID_SUPPLEMENTS,
        streak: 5,
      }),
    ).toEqual({ ok: true })
  })

  test('a legacy note-only payload still passes unchanged', () => {
    expect(validateComponentPayload(RICH_HEALTH_SCHEMA, { note: 'hi' })).toEqual(
      { ok: true },
    )
    expect(validateComponentPayload(RICH_HEALTH_SCHEMA, {})).toEqual({
      ok: true,
    })
  })

  test('a non-array macros names the field', () => {
    expect(
      validateComponentPayload(RICH_HEALTH_SCHEMA, { macros: 'protein 132g' }),
    ).toEqual({ ok: false, error: 'macros must be an array' })
  })

  test('a missing required item field names the exact entry and field', () => {
    expect(
      validateComponentPayload(RICH_HEALTH_SCHEMA, {
        macros: [{ key: 'protein', value: 132 }],
      }),
    ).toEqual({ ok: false, error: 'macros[0].target is required' })
  })

  test('an item field type mismatch names the exact entry and field', () => {
    expect(
      validateComponentPayload(RICH_HEALTH_SCHEMA, {
        macros: [
          { key: 'calories', value: 1670, target: 3000 },
          { key: 'protein', value: '132', target: 160 },
        ],
      }),
    ).toEqual({ ok: false, error: 'macros[1].value must be a number' })
    expect(
      validateComponentPayload(RICH_HEALTH_SCHEMA, {
        supplements: [{ name: 'Vitamin D', taken: 'yes' }],
      }),
    ).toEqual({ ok: false, error: 'supplements[0].taken must be a boolean' })
  })

  test('a non-object item names the entry', () => {
    expect(
      validateComponentPayload(RICH_HEALTH_SCHEMA, { macros: ['protein'] }),
    ).toEqual({ ok: false, error: 'macros[0] must be an object' })
  })

  test('number bounds are enforced with the specific limit', () => {
    expect(
      validateComponentPayload(RICH_HEALTH_SCHEMA, {
        macros: [{ key: 'protein', value: -1, target: 160 }],
      }),
    ).toEqual({ ok: false, error: 'macros[0].value must be at least 0' })
    expect(
      validateComponentPayload(RICH_HEALTH_SCHEMA, {
        macros: [{ key: 'protein', value: 132, target: 0 }],
      }),
    ).toEqual({
      ok: false,
      error: 'macros[0].target must be greater than 0',
    })
  })

  test('maxItems is enforced with the specific limit', () => {
    const tooMany = Array.from({ length: 13 }, (_, i) => ({
      key: `m${i}`,
      value: 1,
      target: 2,
    }))
    expect(
      validateComponentPayload(RICH_HEALTH_SCHEMA, { macros: tooMany }),
    ).toEqual({ ok: false, error: 'macros must have at most 12 items' })
  })

  test('string constraints inside items are enforced', () => {
    expect(
      validateComponentPayload(RICH_HEALTH_SCHEMA, {
        macros: [{ key: 'x'.repeat(33), value: 1, target: 2 }],
      }),
    ).toEqual({
      ok: false,
      error: 'macros[0].key must be at most 32 characters',
    })
  })

  test('unknown extra fields inside items are ignored (additive-only)', () => {
    expect(
      validateComponentPayload(RICH_HEALTH_SCHEMA, {
        macros: [{ key: 'protein', value: 132, target: 160, future: { x: 1 } }],
      }),
    ).toEqual({ ok: true })
  })

  test('top-level number fields are checked', () => {
    expect(
      validateComponentPayload(RICH_HEALTH_SCHEMA, { streak: 'five' }),
    ).toEqual({ ok: false, error: 'streak must be a number' })
  })
})

describe('rich payload passthrough (buildComponentEventMessage)', () => {
  test('macros and supplements ride the eventMeta payload untouched', () => {
    const r = buildComponentEventMessage({
      kind: 'health_tracker_card',
      chatId: 1048,
      assistantId: '873',
      payload: {
        note: 'On pace',
        macros: VALID_MACROS,
        supplements: VALID_SUPPLEMENTS,
      },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.body.eventMeta.payload).toEqual({
      kind: 'health_tracker_card',
      note: 'On pace',
      macros: VALID_MACROS,
      supplements: VALID_SUPPLEMENTS,
    })
    // The note still drives peek and the text fallback.
    expect(r.body.eventMeta.peek).toBe('On pace')
    expect(r.body.text).toBe('Health tracker: On pace')
  })
})

describe('bundled fallback carries the rich Budget-board schema', () => {
  test('macros and supplements are declared with item schemas', () => {
    const entry = findRenderable(
      BUNDLED_RENDERABLES_FALLBACK,
      'health_tracker_card',
    )
    const props = (entry?.payloadSchema as {
      properties: Record<string, Record<string, unknown>>
    }).properties
    expect(props.macros.type).toBe('array')
    expect(props.supplements.type).toBe('array')
    const macroItems = props.macros.items as {
      required: string[]
      properties: Record<string, unknown>
    }
    expect(macroItems.required).toEqual(['key', 'value', 'target'])
    const suppItems = props.supplements.items as { required: string[] }
    expect(suppItems.required).toEqual(['name', 'taken'])
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
