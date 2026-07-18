// ── Renderable components (generic show_component, pure helpers) ─────────────
//
// Phase B of the renderable-components platform: fetchless helpers around the
// manifest served at GET /api/v1/renderables (BGOS backend, merged in #767).
// The manifest wire shape is { renderables: [{ kind, payloadSchema,
// minAppVersion, category, description }] } where payloadSchema is a
// JSON-schema-ish plain object: { type: 'object', required: string[],
// properties: { field: { type, maxLength?, const? } } }.
//
// Validation mirrors the app's additive-only semantics
// (frontend/expo-app/src/renderables/decideRender.ts):
//  - unknown EXTRA payload fields are ignored (forward compatibility),
//  - declared fields are type/maxLength checked when present,
//  - required fields (other than the injected `kind` discriminator) must be
//    present,
//  - the string field type is fully checked today; a declared type this
//    plugin version does not know passes UNCHECKED (the app degrades any
//    invalid payload to the quiet event card, so a permissive preflight can
//    never break a client; a strict one could reject valid future payloads).
//
// No em dashes or en dashes anywhere in this file.

export interface RenderableWireEntry {
  kind: string
  payloadSchema?: RenderableWireSchema
  minAppVersion?: string
  category?: string
  description?: string
}

/** JSON-schema-ish payload schema as served by the backend (untrusted). */
export interface RenderableWireSchema {
  type?: unknown
  required?: unknown
  properties?: unknown
}

type ValidationResult = { ok: true } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Bundled fallback catalog, mirroring the backend manifest at the time this
 * plugin version shipped. Used ONLY when GET /api/v1/renderables is
 * unreachable (e.g. an older backend), so show_health_tracker and
 * show_component with known kinds keep working. The live manifest always
 * wins when it can be fetched.
 */
export const BUNDLED_RENDERABLES_FALLBACK: {
  renderables: RenderableWireEntry[]
} = {
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
        'the full dashboard). Optional note renders as a short agent message ' +
        'on the card.',
    },
  ],
}

function manifestEntries(manifest: unknown): RenderableWireEntry[] {
  if (!isRecord(manifest)) return []
  const list = manifest.renderables
  if (!Array.isArray(list)) return []
  return list.filter(
    (entry): entry is RenderableWireEntry =>
      isRecord(entry) && typeof entry.kind === 'string' && entry.kind !== '',
  )
}

/** Look one kind up in a fetched manifest (defensive against a bad shape). */
export function findRenderable(
  manifest: unknown,
  kind: string,
): RenderableWireEntry | undefined {
  return manifestEntries(manifest).find((entry) => entry.kind === kind)
}

/** All kinds a fetched manifest declares (for honest unknown-kind errors). */
export function listRenderableKinds(manifest: unknown): string[] {
  return manifestEntries(manifest).map((entry) => entry.kind)
}

/** Normalize the tool's optional `payload` argument to a plain object. */
export function normalizeComponentPayloadArg(
  value: unknown,
):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, payload: {} }
  if (!isRecord(value)) {
    return {
      ok: false,
      error: 'payload must be a JSON object of component fields (or omitted)',
    }
  }
  return { ok: true, payload: value }
}

type FieldCheck = (
  name: string,
  spec: Record<string, unknown>,
  value: unknown,
) => string | null

// One checker per declared field type; add entries here as the manifest
// grows richer types (number, boolean, arrays of strings, ...). A type with
// no entry passes unchecked (see the header note on permissive preflight).
const FIELD_CHECKS: Record<string, FieldCheck> = {
  string: (name, spec, value) => {
    if (typeof value !== 'string') return `${name} must be a string`
    if (typeof spec.maxLength === 'number' && value.length > spec.maxLength) {
      return `${name} must be at most ${spec.maxLength} characters`
    }
    if (typeof spec.const === 'string' && value !== spec.const) {
      return `${name} must be "${spec.const}"`
    }
    return null
  },
}

/**
 * Validate an agent-supplied payload against one manifest entry's schema.
 * The `kind` discriminator is special: the tool injects it, so it is never
 * required here, but if the agent DID include it, it must match the schema's
 * const (a mismatched kind inside payload is always a mistake).
 */
export function validateComponentPayload(
  schema: RenderableWireSchema | undefined,
  payload: Record<string, unknown>,
): ValidationResult {
  const required = Array.isArray(schema?.required)
    ? (schema.required.filter((f) => typeof f === 'string') as string[])
    : []
  const properties = isRecord(schema?.properties) ? schema.properties : {}

  const kindSpec = isRecord(properties.kind) ? properties.kind : undefined
  if (payload.kind !== undefined) {
    if (typeof payload.kind !== 'string') {
      return { ok: false, error: 'payload.kind must be a string when present' }
    }
    if (
      kindSpec &&
      typeof kindSpec.const === 'string' &&
      payload.kind !== kindSpec.const
    ) {
      return {
        ok: false,
        error:
          `payload.kind must be "${kindSpec.const}" ` +
          '(or omit it; the tool sets the kind for you)',
      }
    }
  }

  const declared = new Set<string>([...required, ...Object.keys(properties)])
  for (const name of declared) {
    if (name === 'kind') continue
    const value = payload[name]
    if (value === undefined) {
      if (required.includes(name)) {
        return { ok: false, error: `${name} is required` }
      }
      continue
    }
    const spec = isRecord(properties[name]) ? properties[name] : undefined
    if (!spec || typeof spec.type !== 'string') continue
    const check = FIELD_CHECKS[spec.type]
    if (!check) continue
    const error = check(name, spec, value)
    if (error) return { ok: false, error }
  }
  // Unknown extra fields in payload are intentionally ignored (additive-only
  // forward compatibility, mirroring the app's validator).
  return { ok: true }
}

/**
 * Short human title for the card header and text fallback. Prefers a short
 * phrase-like manifest description; otherwise derives from the kind by
 * stripping a presentation suffix (health_tracker_card -> "Health tracker").
 * Deterministic on manifest data so alias and generic paths always agree.
 */
export function deriveComponentTitle(
  kind: string,
  description?: string,
): string {
  const phrase = (description ?? '').trim()
  if (phrase && phrase.length <= 40 && !/[.!?]/.test(phrase)) return phrase
  const base = kind
    .replace(/[_-](card|view|widget)$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
  if (!base) return kind
  return base.charAt(0).toUpperCase() + base.slice(1).toLowerCase()
}

export interface ComponentEventMessage {
  chatId: number
  assistantId: number
  sender: 'assistant'
  text: string
  messageType: 'event'
  eventMeta: {
    source: 'agent'
    title: string
    peek?: string
    payload: Record<string, unknown> & { kind: string }
  }
}

export interface BuildComponentEventInput {
  kind: string
  payload: Record<string, unknown>
  chatId: number
  assistantId: string | number
  description?: string
}

/**
 * Build the outbound event wire body for one component card. Same recipe the
 * V1 health tracker builder used (and byte-for-byte compatible with it for
 * kind health_tracker_card, guarded by the alias-parity test): messageType
 * "event", eventMeta { source: "agent", title, peek?, payload: { kind,
 * ...fields } }, plus a readable text fallback for surfaces that do not
 * render the card.
 */
export function buildComponentEventMessage(
  input: BuildComponentEventInput,
): { ok: true; body: ComponentEventMessage } | { ok: false; error: string } {
  const { kind, payload, chatId, description } = input
  if (typeof kind !== 'string' || !kind.trim()) {
    return { ok: false, error: 'kind is required' }
  }
  const assistantIdNum = Number(input.assistantId)
  if (!Number.isInteger(assistantIdNum) || assistantIdNum <= 0) {
    return { ok: false, error: 'daemon assistant id is not numeric' }
  }
  if (!Number.isInteger(chatId) || chatId <= 0) {
    return { ok: false, error: 'chat id did not resolve to a number' }
  }

  // Never let a payload-supplied kind clobber the routed kind.
  const { kind: _ignored, ...fields } = payload

  const note =
    typeof fields.note === 'string' && fields.note.trim() !== ''
      ? fields.note
      : undefined

  const title = deriveComponentTitle(kind, description)
  const eventMeta: ComponentEventMessage['eventMeta'] = {
    source: 'agent',
    title,
    payload: { kind, ...fields },
  }
  if (note !== undefined) eventMeta.peek = note

  return {
    ok: true,
    body: {
      chatId,
      assistantId: assistantIdNum,
      sender: 'assistant',
      // Canonical text fallback for surfaces that do not render the card.
      text: note !== undefined ? `${title}: ${note}` : title,
      messageType: 'event',
      eventMeta,
    },
  }
}
