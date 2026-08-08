/**
 * Agent Update Stream: session client + fetch adapter
 * (docs/architecture/agent-message-routing.md sections 5.4 and 5.6; the doc
 * lives in the BGOS repo).
 *
 * The impure-but-injected half that UpdateStreamConsumer's pure arithmetic
 * sits on: it turns HTTP responses into the FetchResult union and owns the
 * session token lifecycle.
 *
 * Security rules pinned here (spec 5.6):
 *  - The session token is MEMORY ONLY. It is never persisted, never logged,
 *    never placed on a returned object, and never included in an error
 *    message. Only the on-disk pairing token survives a restart; the session
 *    is re-minted from it.
 *  - Expiry is not revocation, and the wire says which: a 401 with code
 *    'session_expired' re-mints ONCE (single flight across concurrent
 *    callers) and retries; 'pairing_revoked' is TERMINAL and surfaces as
 *    PairingRevokedError plus the sticky `revoked` flag so the caller can
 *    stop instead of hammering a dead credential.
 *  - Feature detect, never version sniff: a 404 on either endpoint means an
 *    old backend (or the SERVE flag off) and maps to 'not_found'.
 */

import type { FetchResult, StreamUpdate } from './update-stream.ts'

export const SESSION_ENDPOINT = 'integrations/session'
export const UPDATES_ENDPOINT = 'integrations/updates'
export const UPDATES_DEFAULT_LIMIT = 100
/** Fallback wait when a 429 carries no usable Retry-After signal. */
export const RATE_LIMIT_DEFAULT_RETRY_SECONDS = 30

export interface StreamAssistantState {
  assistantId: number
  seq: number
}

/** The mint response minus the secret: the token stays inside the client. */
export interface StreamSessionGrant {
  expiresAt: string
  stream: {
    enabled: boolean
    streamEpoch: number
    assistants: StreamAssistantState[]
  } | null
}

export type MintOutcome =
  | { kind: 'ok'; grant: StreamSessionGrant }
  | { kind: 'not_found' }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'revoked' }
  | { kind: 'failed'; status: number }

/** Terminal auth state: the pairing itself was revoked. Stop, do not retry. */
export class PairingRevokedError extends Error {
  constructor() {
    super('stream auth terminal: pairing_revoked')
    this.name = 'PairingRevokedError'
  }
}

export interface StreamClientDeps {
  /** e.g. https://host/api/v1 (no trailing slash). */
  apiBase: string
  /** The pairing auth headers (authHeaders(AUTH) in server.ts). */
  pairingHeaders: () => Record<string, string>
  fetchImpl?: typeof fetch
  log?: (msg: string) => void
}

type UnauthorizedCode = 'session_expired' | 'pairing_revoked' | ''

type UpdatesAttempt =
  | { kind: 'done'; result: FetchResult }
  | { kind: 'unauthorized'; code: UnauthorizedCode; hadSession: boolean }

async function bodyJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = (await response.json()) as unknown
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function retryAfterSecondsOf(
  response: Response,
  body: Record<string, unknown>,
): number {
  const fromBody = Number(body.retryAfterSeconds)
  if (Number.isFinite(fromBody) && fromBody > 0) return fromBody
  const fromHeader = Number(response.headers.get('retry-after'))
  if (Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader
  return RATE_LIMIT_DEFAULT_RETRY_SECONDS
}

function normalizeUpdate(raw: unknown): StreamUpdate | null {
  const r = raw as Record<string, unknown> | null | undefined
  const seq = Number(r?.seq)
  if (!Number.isFinite(seq)) return null
  const chatId = r?.chatId
  const messageId = r?.messageId
  return {
    seq,
    kind: String(r?.kind ?? ''),
    chatId: chatId == null ? null : Number(chatId),
    messageId: messageId == null ? null : Number(messageId),
    payload:
      r?.payload && typeof r.payload === 'object'
        ? (r.payload as Record<string, unknown>)
        : {},
  }
}

function normalizeGrantStream(
  raw: unknown,
): StreamSessionGrant['stream'] {
  const r = raw as Record<string, unknown> | null | undefined
  if (!r || typeof r !== 'object') return null
  const epoch = Number(r.streamEpoch)
  const assistants = Array.isArray(r.assistants)
    ? r.assistants
        .map((a) => {
          const entry = a as Record<string, unknown>
          const assistantId = Number(entry?.assistantId)
          const seq = Number(entry?.seq)
          if (!Number.isFinite(assistantId) || !Number.isFinite(seq)) return null
          return { assistantId, seq }
        })
        .filter((a): a is StreamAssistantState => a != null)
    : []
  return {
    enabled: r.enabled === true,
    streamEpoch: Number.isFinite(epoch) ? epoch : 0,
    assistants,
  }
}

export class StreamClient {
  private readonly apiBase: string
  private readonly pairingHeaders: () => Record<string, string>
  private readonly fetchImpl: typeof fetch
  private readonly log: (msg: string) => void
  /** MEMORY ONLY (spec 5.6): never persisted, logged, or exposed. */
  private sessionToken: string | null = null
  private remintInFlight: Promise<boolean> | null = null
  private revokedFlag = false

  constructor(deps: StreamClientDeps) {
    this.apiBase = deps.apiBase.replace(/\/$/, '')
    this.pairingHeaders = deps.pairingHeaders
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.log = deps.log ?? (() => undefined)
  }

  /** True after a pairing_revoked verdict: the caller must stop the stream. */
  get revoked(): boolean {
    return this.revokedFlag
  }

  get hasSession(): boolean {
    return this.sessionToken != null
  }

  /**
   * POST the session endpoint with the pairing credential. On success the
   * token is retained internally; the returned grant carries everything BUT
   * the secret.
   */
  async mintSession(): Promise<MintOutcome> {
    const response = await this.fetchImpl(`${this.apiBase}/${SESSION_ENDPOINT}`, {
      method: 'POST',
      headers: {
        ...this.pairingHeaders(),
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    if (response.status === 404) return { kind: 'not_found' }
    if (response.status === 429) {
      const body = await bodyJson(response)
      return {
        kind: 'rate_limited',
        retryAfterSeconds: retryAfterSecondsOf(response, body),
      }
    }
    if (response.status === 401) {
      const body = await bodyJson(response)
      if (body.code === 'pairing_revoked') {
        this.revokedFlag = true
        this.sessionToken = null
        return { kind: 'revoked' }
      }
      return { kind: 'failed', status: 401 }
    }
    if (!response.ok) return { kind: 'failed', status: response.status }
    const body = await bodyJson(response)
    const token = typeof body.sessionToken === 'string' ? body.sessionToken : ''
    if (!token) return { kind: 'failed', status: response.status }
    this.sessionToken = token
    return {
      kind: 'ok',
      grant: {
        expiresAt: String(body.expiresAt ?? ''),
        stream: normalizeGrantStream(body.stream),
      },
    }
  }

  /**
   * GET the updates endpoint and map every HTTP shape onto the FetchResult
   * union the consumer's chain understands. session_expired re-mints once
   * (single flight) and retries; pairing_revoked throws the terminal error.
   */
  async fetchUpdates(
    assistantId: number,
    since: number,
    limit: number = UPDATES_DEFAULT_LIMIT,
  ): Promise<FetchResult> {
    if (this.revokedFlag) throw new PairingRevokedError()
    const first = await this.requestUpdates(assistantId, since, limit)
    if (first.kind === 'done') return first.result
    if (first.code === 'pairing_revoked') {
      this.revokedFlag = true
      this.sessionToken = null
      throw new PairingRevokedError()
    }
    if (first.code !== 'session_expired' && !first.hadSession) {
      // The pairing header itself was refused without a machine readable
      // verdict; minting uses the same credential, so a retry cannot help.
      throw new Error('stream updates rejected the pairing credential (401)')
    }
    // session_expired (or an unlabeled 401 on a session token): re-mint once.
    const reminted = await this.remintOnce()
    if (!reminted) {
      throw new Error('stream session re-mint failed after session_expired')
    }
    const second = await this.requestUpdates(assistantId, since, limit)
    if (second.kind === 'done') return second.result
    if (second.code === 'pairing_revoked') {
      this.revokedFlag = true
      this.sessionToken = null
      throw new PairingRevokedError()
    }
    throw new Error('stream updates still unauthorized after one re-mint')
  }

  /** Single flight: concurrent 401s share one mint, never a mint stampede. */
  private remintOnce(): Promise<boolean> {
    if (!this.remintInFlight) {
      this.remintInFlight = this.mintSession()
        .then((outcome) => outcome.kind === 'ok')
        .catch(() => false)
        .finally(() => {
          this.remintInFlight = null
        })
    }
    return this.remintInFlight
  }

  private async requestUpdates(
    assistantId: number,
    since: number,
    limit: number,
  ): Promise<UpdatesAttempt> {
    const hadSession = this.sessionToken != null
    const headers: Record<string, string> = hadSession
      ? { 'X-BGOS-Session': this.sessionToken! }
      : this.pairingHeaders()
    const url =
      `${this.apiBase}/${UPDATES_ENDPOINT}` +
      `?assistant_id=${encodeURIComponent(assistantId)}` +
      `&since=${encodeURIComponent(since)}` +
      `&limit=${encodeURIComponent(limit)}`
    const response = await this.fetchImpl(url, { headers })
    if (response.status === 404) {
      return { kind: 'done', result: { kind: 'not_found' } }
    }
    if (response.status === 429) {
      const body = await bodyJson(response)
      return {
        kind: 'done',
        result: {
          kind: 'rate_limited',
          retryAfterSeconds: retryAfterSecondsOf(response, body),
        },
      }
    }
    if (response.status === 401) {
      const body = await bodyJson(response)
      const code =
        body.code === 'pairing_revoked'
          ? 'pairing_revoked'
          : body.code === 'session_expired'
            ? 'session_expired'
            : ''
      if (code === 'session_expired' || (code === '' && hadSession)) {
        // An expired session cannot authenticate the retry; drop it so the
        // re-mint installs a fresh one.
        this.sessionToken = null
      }
      return { kind: 'unauthorized', code, hadSession }
    }
    if (!response.ok) {
      // No headers, no credentials, no body echo: the message must stay
      // secret free whatever the server returned.
      throw new Error(`stream updates HTTP ${response.status}`)
    }
    const body = await bodyJson(response)
    if (body.tooOld === true) {
      return {
        kind: 'done',
        result: {
          kind: 'too_old',
          state: Number(body.state) || 0,
          streamEpoch: Number(body.streamEpoch) || 0,
        },
      }
    }
    if (body.invalidCursor === true) {
      return {
        kind: 'done',
        result: {
          kind: 'invalid_cursor',
          state: Number(body.state) || 0,
          streamEpoch: Number(body.streamEpoch) || 0,
        },
      }
    }
    const updates = Array.isArray(body.updates)
      ? body.updates
          .map(normalizeUpdate)
          .filter((u): u is StreamUpdate => u != null)
      : []
    return {
      kind: 'done',
      result: {
        kind: 'ok',
        updates,
        state: Number(body.state) || 0,
        final: body.final === true,
        streamEpoch: Number(body.streamEpoch) || 0,
      },
    }
  }
}
