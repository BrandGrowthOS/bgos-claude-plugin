// ── Native health logging (pure builders, unit-tested) ───────────────────────
//
// Tool-facing layer over the backend's health-log API (POST/GET/DELETE
// /api/v1/health-log/events). Built so nutritionist-style agents (David) can
// log meals, supplements, and habits without ever touching raw credentials:
// the daemon holds the auth, the tool enforces the reliability contract.
//
// Reliability contract (mirrors backend health-log.service):
//  - R2 idempotency: ONE UUID per user intent. The tool generates one per
//    call; on a network-error retry the agent passes the SAME key back via
//    idempotency_key (it is echoed in every result and error) so a retry can
//    never double-log.
//  - R3 ack: the agent may tell the user "logged" ONLY on {success: true}.
//  - R6 duplicates: a same-item same-local-day log answers
//    {success: false, isDuplicate: true}; the agent asks the user, then
//    retries with allow_duplicate: true AND a FRESH key.
//  - R7 undo: DELETE by the id returned from the POST.

export interface HealthLogBuildDeps {
  assistantId: string
  uuid: () => string
}

export interface BuiltHealthLogBody {
  idempotencyKey: string
  eventType: string
  itemName: string
  quantity?: number
  unit?: string
  notes?: string
  loggedAt?: string
  timezone?: string
  assistantId?: number
  source: 'agent'
  allowDuplicate?: boolean
}

type BuildResult =
  | { ok: true; body: BuiltHealthLogBody }
  | { ok: false; error: string }

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function cleanString(
  value: unknown,
  field: string,
  maxLen: number,
  required: boolean,
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (value == null || value === '') {
    if (required) return { ok: false, error: `${field} is required` }
    return { ok: true, value: undefined }
  }
  if (typeof value !== 'string') {
    return { ok: false, error: `${field} must be a string` }
  }
  const trimmed = value.trim()
  if (!trimmed) {
    if (required) return { ok: false, error: `${field} must not be blank` }
    return { ok: true, value: undefined }
  }
  if (trimmed.length > maxLen) {
    return { ok: false, error: `${field} must be at most ${maxLen} characters` }
  }
  return { ok: true, value: trimmed }
}

export function buildHealthLogEventBody(
  args: Record<string, unknown>,
  deps: HealthLogBuildDeps,
): BuildResult {
  const eventType = cleanString(args.event_type, 'event_type', 64, true)
  if (!eventType.ok) return eventType
  const itemName = cleanString(args.item_name, 'item_name', 200, true)
  if (!itemName.ok) return itemName
  const unit = cleanString(args.unit, 'unit', 32, false)
  if (!unit.ok) return unit
  const notes = cleanString(args.notes, 'notes', 2000, false)
  if (!notes.ok) return notes
  const timezone = cleanString(args.timezone, 'timezone', 64, false)
  if (!timezone.ok) return timezone

  let quantity: number | undefined
  if (args.quantity != null) {
    const q = typeof args.quantity === 'string' ? Number(args.quantity) : args.quantity
    if (typeof q !== 'number' || !Number.isFinite(q) || q < 0 || q > 1_000_000) {
      return { ok: false, error: 'quantity must be a number between 0 and 1000000' }
    }
    quantity = q
  }

  let loggedAt: string | undefined
  if (args.logged_at != null && args.logged_at !== '') {
    if (
      typeof args.logged_at !== 'string' ||
      Number.isNaN(Date.parse(args.logged_at))
    ) {
      return {
        ok: false,
        error:
          'logged_at must be an ISO 8601 datetime (e.g. 2026-07-18T09:30:00+04:00)',
      }
    }
    loggedAt = args.logged_at
  }

  let idempotencyKey: string
  if (args.idempotency_key != null && args.idempotency_key !== '') {
    if (
      typeof args.idempotency_key !== 'string' ||
      !UUID_RE.test(args.idempotency_key)
    ) {
      return {
        ok: false,
        error:
          'idempotency_key must be the UUID echoed by a previous attempt; ' +
          'omit it for a new log',
      }
    }
    idempotencyKey = args.idempotency_key
  } else {
    idempotencyKey = deps.uuid()
  }

  const assistantIdNum = Number(deps.assistantId)

  const body: BuiltHealthLogBody = {
    idempotencyKey,
    // Backend normalizes to lowercase; do it here so the echo matches.
    eventType: (eventType.value as string).toLowerCase(),
    itemName: itemName.value as string,
    source: 'agent',
  }
  if (quantity !== undefined) body.quantity = quantity
  if (unit.value !== undefined) body.unit = unit.value
  if (notes.value !== undefined) body.notes = notes.value
  if (loggedAt !== undefined) body.loggedAt = loggedAt
  if (timezone.value !== undefined) body.timezone = timezone.value
  if (Number.isInteger(assistantIdNum) && assistantIdNum > 0) {
    body.assistantId = assistantIdNum
  }
  if (args.allow_duplicate === true) body.allowDuplicate = true

  return { ok: true, body }
}

/** Render the backend's settled outcome for the agent, enforcing R3/R6. */
export function summarizeHealthLogResult(
  resp: Record<string, unknown> | null | undefined,
  body: BuiltHealthLogBody,
): string {
  const key = body.idempotencyKey
  if (resp && resp.success === true) {
    const id = typeof resp.id === 'string' || typeof resp.id === 'number' ? resp.id : 'unknown'
    if (resp.deduplicated === true) {
      return (
        `Already logged (idempotent replay, nothing new written). ` +
        `Event id: ${id}. You may confirm to the user it is logged.`
      )
    }
    return (
      `Logged: ${body.eventType} "${body.itemName}" (event id: ${id}). ` +
      `You may now confirm to the user. Keep idempotency_key ${key} only if ` +
      `you need to retry THIS same intent.`
    )
  }
  if (resp && resp.isDuplicate === true) {
    const existingId = resp.existingLogId ?? 'unknown'
    const existingAt = resp.existingLoggedAt ?? 'earlier today'
    return (
      `NOT logged: "${body.itemName}" was already logged today ` +
      `(existing id ${existingId}, at ${existingAt}). Ask the user whether ` +
      `to log it again; only on a clear yes, call log_health_event again ` +
      `with allow_duplicate: true and WITHOUT idempotency_key (a fresh key ` +
      `is generated).`
    )
  }
  return (
    `NOT logged: the backend did not confirm success. Do not tell the user ` +
    `it is logged. To retry this same intent safely, call log_health_event ` +
    `again with idempotency_key: ${key}.`
  )
}

type PathResult = { ok: true; path: string } | { ok: false; error: string }

export function buildHealthLogListPath(
  args: Record<string, unknown>,
): PathResult {
  const params = new URLSearchParams()
  if (args.day != null && args.day !== '') {
    if (typeof args.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args.day)) {
      return { ok: false, error: 'day must be YYYY-MM-DD' }
    }
    params.set('day', args.day)
  }
  const timezone = cleanString(args.timezone, 'timezone', 64, false)
  if (!timezone.ok) return timezone
  if (timezone.value) params.set('timezone', timezone.value)
  const qs = params.toString()
  return { ok: true, path: `health-log/events${qs ? `?${qs}` : ''}` }
}

export function buildHealthLogUndoPath(id: unknown): PathResult {
  if (typeof id !== 'string' && typeof id !== 'number') {
    return { ok: false, error: 'event_id is required (the id returned by log_health_event)' }
  }
  const s = String(id).trim()
  if (!s || s.length > 128 || /[\s/]/.test(s)) {
    return { ok: false, error: 'event_id looks invalid' }
  }
  return { ok: true, path: `health-log/events/${encodeURIComponent(s)}` }
}

interface HealthLogRow {
  id?: unknown
  eventType?: unknown
  itemName?: unknown
  quantity?: unknown
  unit?: unknown
  loggedAt?: unknown
}

/** Compact one-line-per-event rendering of the list response. */
export function summarizeHealthLogList(resp: unknown): string {
  const rows: HealthLogRow[] = Array.isArray(resp)
    ? (resp as HealthLogRow[])
    : Array.isArray((resp as Record<string, unknown> | null)?.events)
      ? ((resp as Record<string, unknown>).events as HealthLogRow[])
      : []
  if (!rows.length) return 'No health events logged for that day.'
  const lines = rows.slice(0, 100).map((r) => {
    const qty =
      r.quantity != null
        ? ` ${r.quantity}${typeof r.unit === 'string' && r.unit ? ` ${r.unit}` : ''}`
        : ''
    const at =
      typeof r.loggedAt === 'string' ? ` at ${r.loggedAt}` : ''
    return `- [${String(r.eventType ?? '?')}] ${String(r.itemName ?? '?')}${qty}${at} (id ${String(r.id ?? '?')})`
  })
  const more = rows.length > 100 ? `\n(and ${rows.length - 100} more)` : ''
  return `${rows.length} event(s):\n${lines.join('\n')}${more}`
}
