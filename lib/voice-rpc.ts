/**
 * voice_rpc frame handler — the Claude Code plugin side of BGOS's native
 * in-app WebRTC voice control plane.
 *
 * The BGOS backend pushes `voice_rpc {rpcId, op, assistantId, agentRoute,
 * chatId, payload}` frames to the `assistant:<id>` room this plugin's
 * socket already joined (the pairingless lane — pairing daemons like
 * OpenClaw get the same frames on `pairing:<id>`). We ACK immediately
 * (suppresses the backend's 1.5 s retry-emit), run the op, and POST the
 * outcome back with our X-API-Key:
 *
 *   POST /api/v1/integrations/voice-rpc/:rpcId/result
 *     {ok:true, payload} | {ok:false, error:{code, message}}
 *
 * Ops:
 *   mint    → POST https://api.openai.com/v1/realtime/client_secrets
 *             directly (key from BGOS_OPENAI_API_KEY / OPENAI_API_KEY in the
 *             plugin env — the Hermes-broker blueprint, spec §6.2). We own
 *             the mint, so the agent persona + recent chat context are baked
 *             into the session `instructions` → contextInjected:true (the
 *             app then skips client-side injection). 8 s inner cap, under
 *             the backend's 10 s mint deadline so our descriptive error
 *             always beats the generic timeout. The session bakes EXACTLY
 *             the claude_agent_consult tool — the app only registers its
 *             client-side dispatch/roundtable tools when the mint returned
 *             ≥1 baked tool (verified frontend gotcha).
 *   consult → push a [voice_consult] channel notification into the live
 *             Claude Code session and wait for the voice_consult_reply MCP
 *             tool to resolve it. 38 s inner cap < the backend's 45 s. A
 *             busy session (mid-turn) usually blows the budget — that is
 *             expected and degrades to a graceful spoken "still working"
 *             line app-side; a late voice_consult_reply is told to send the
 *             answer as a normal chat reply instead.
 *   dispatch → NOT expected on this lane (the backend delivers dispatches
 *             to pairingless agents as `voice_task_dispatch` events, plugin
 *             v0.13.0). Answered with a descriptive error, never silence —
 *             the G2 silent-drop lesson: every wire shape gets an explicit
 *             outcome.
 *
 * Deadline discipline (ported from openclaw-channel-bgos/voice-rpc-handler):
 * the daemon's inner cap must stay UNDER the backend's, because the backend
 * drops results that arrive after its own timeout — a descriptive error that
 * arrives in time always beats a better answer that arrives late.
 */

export type VoiceRpcOp = 'mint' | 'consult' | 'dispatch'

export interface VoiceRpcFrame {
  rpcId: string
  op: VoiceRpcOp
  assistantId: string | number
  agentRoute: string
  chatId: string | number | null
  payload: Record<string, unknown>
}

export interface VoiceRpcResultBody {
  ok: boolean
  payload?: Record<string, unknown>
  error?: { code: string; message: string }
}

/**
 * Validate a voice_rpc control frame. Backend emits camelCase:
 * {rpcId, op, assistantId, agentRoute, chatId, payload}. Ops are
 * WHITELISTED — anything else is dropped here (the backend's own timeout
 * surfaces the failure to the app, so silence for a malformed frame is
 * safe; a well-formed frame with an op we don't serve gets a descriptive
 * error in VoiceRpcHandler.handle instead). Port of the OpenClaw
 * bgos-ws.ts normalizer.
 */
export function normalizeVoiceRpc(raw: unknown): VoiceRpcFrame | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const rpcId = typeof r.rpcId === 'string' ? r.rpcId : ''
  const op =
    r.op === 'mint' || r.op === 'consult' || r.op === 'dispatch' ? r.op : null
  if (!rpcId || !op) return null
  return {
    rpcId,
    op,
    assistantId:
      typeof r.assistantId === 'number' || typeof r.assistantId === 'string'
        ? r.assistantId
        : '',
    agentRoute: typeof r.agentRoute === 'string' ? r.agentRoute : '',
    chatId:
      typeof r.chatId === 'number' || typeof r.chatId === 'string'
        ? r.chatId
        : null,
    payload:
      r.payload && typeof r.payload === 'object'
        ? (r.payload as Record<string, unknown>)
        : {},
  }
}

/** The SDP-exchange endpoint for a direct-OpenAI mint (wire contract). */
export const OFFER_URL = 'https://api.openai.com/v1/realtime/calls'
export const CLIENT_SECRETS_URL =
  'https://api.openai.com/v1/realtime/client_secrets'
/** Must not collide with the app's client-registered tool names
 *  (agent_dispatch / get_task_status / check_agent_status / roundtable_*):
 *  the app's tool router relays every OTHER name to the consult endpoint. */
export const CONSULT_TOOL_NAME = 'claude_agent_consult'

export interface AgentIdentity {
  name: string
  subtitle: string
}

export interface VoiceRpcTiming {
  /** Whole-mint wall clock (identity fetch + OpenAI call). < backend 10 s. */
  mintTimeoutMs: number
  /** Whole-consult wall clock (notification → tool reply). < backend 45 s. */
  consultTimeoutMs: number
  /** Slice of the mint budget spent on the best-effort identity fetch. */
  identityTimeoutMs: number
  /** How long a timed-out consult id is remembered to answer a LATE
   *  voice_consult_reply with "send it to the chat instead". */
  expiredConsultTtlMs: number
}

export const DEFAULT_TIMING: VoiceRpcTiming = {
  mintTimeoutMs: 8_000,
  consultTimeoutMs: 38_000,
  identityTimeoutMs: 2_500,
  expiredConsultTtlMs: 10 * 60_000,
}

export interface VoiceRpcConfig {
  /** OpenAI API key with Realtime access; '' = voice not configured. */
  openaiApiKey: string
  model: string
  voice: string
  /** Optional extra persona text (BGOS_VOICE_PERSONA). */
  persona: string
  assistantId: string
  chatIdFallback?: string | null
}

export interface VoiceRpcDeps {
  config: VoiceRpcConfig
  /** POST integrations/voice-rpc/:rpcId/ack (X-API-Key). */
  postAck(rpcId: string): Promise<unknown>
  /** POST integrations/voice-rpc/:rpcId/result (X-API-Key). */
  postResult(rpcId: string, body: VoiceRpcResultBody): Promise<unknown>
  /** Push a channel notification into the live Claude Code session. */
  notify(content: string, meta: Record<string, unknown>): Promise<unknown>
  /** Best-effort agent identity for the voice persona (caller caches). */
  getIdentity(timeoutMs: number): Promise<AgentIdentity | null>
  log(msg: string): void
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  timing?: Partial<VoiceRpcTiming>
}

class VoiceRpcError extends Error {
  // No TS parameter properties: node --test runs these files in strip-only
  // mode, which rejects them (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** Clamp a step's timeout so it can never overshoot the op deadline
 *  (inner < outer discipline; see the OpenClaw reference). */
function capToDeadline(timeoutMs: number, deadline: number): number {
  return Math.max(1, Math.min(timeoutMs, deadline - Date.now()))
}

/** The backend stores `new Date(Number(expiresAt) * 1000)` — the wire unit
 *  is epoch SECONDS. OpenAI's client_secrets returns seconds today, but
 *  normalize defensively (the OpenClaw lesson: providers have emitted both
 *  units historically). */
export function normalizeExpiresAtSeconds(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  // ~2286-11-20 in epoch seconds; anything bigger is epoch milliseconds.
  return n > 10_000_000_000 ? Math.floor(n / 1000) : Math.floor(n)
}

/** Realtime session instructions: persona + the dumb-mouth contract with a
 *  Claude-specific dispatch bias (Claude turns can take 10-60 s+, so consult
 *  is reserved for quick questions; real work goes through agent_dispatch,
 *  which is async by design). Exported for unit tests. */
export function buildMintInstructions(args: {
  identity: AgentIdentity | null
  persona: string
  recentContext: string
}): string {
  const name = args.identity?.name?.trim() || 'the agent'
  const subtitle = args.identity?.subtitle?.trim() ?? ''
  const parts: string[] = []
  parts.push(
    `You are ${name}, speaking with your user on a live voice call.` +
      (subtitle ? ` ${subtitle}.` : ''),
  )
  if (args.persona.trim()) parts.push(args.persona.trim())
  parts.push(
    'Personality: warm, capable, concise. Answer in one to three short ' +
      'sentences unless asked for more. Never mention being an AI model or ' +
      `a "realtime voice"; you ARE ${name}.`,
  )
  parts.push(
    'You are the VOICE of the agent, not its brain. The real agent — a ' +
      "Claude Code session with the user's files, tools, and memory — is " +
      'reachable through your tools:\n' +
      '- Handle greetings, chit-chat, and anything answerable from this ' +
      'conversation DIRECTLY. No tools for small talk.\n' +
      '- Your brain is a coding/ops agent whose turns can take a while. For ' +
      'anything multi-step, anything needing real work (files, code, ' +
      'research, messages), or anything that changes state, PREFER ' +
      'agent_dispatch: verbally acknowledge what you are kicking off, ' +
      'dispatch it, and the result is announced when ready.\n' +
      `- Use ${CONSULT_TOOL_NAME} ONLY for quick factual questions the real ` +
      'agent can answer in a sentence or two. Verbally acknowledge before ' +
      'consulting (it takes a few seconds). If a consult fails or times ' +
      'out, say the agent is still working on it and will follow up in the ' +
      'chat — never leave silence.\n' +
      '- Speak results naturally; keep technical detail light unless asked.',
  )
  const ctx = args.recentContext.trim()
  if (ctx) {
    parts.push(
      'Recent conversation with your user (for continuity):\n' +
        ctx.slice(0, 20_000),
    )
  }
  return parts.join('\n\n')
}

/** The consult tool definition baked into the realtime session at mint.
 *  Mirrors the backend's VoiceToolCallDto args shape. */
export function buildConsultToolDefinition(): Record<string, unknown> {
  return {
    type: 'function',
    name: CONSULT_TOOL_NAME,
    description:
      "Ask the agent's real brain (the live Claude Code session) a QUICK " +
      'question it can answer in a sentence or two. Takes several seconds; ' +
      'verbally acknowledge first. For real/multi-step work use ' +
      'agent_dispatch instead.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question, self-contained and specific.',
        },
        context: {
          type: 'string',
          description: 'Optional call context that helps answer.',
        },
        responseStyle: {
          type: 'string',
          description: 'Optional style hint, e.g. "one sentence".',
        },
      },
      required: ['question'],
    },
  }
}

/** The [voice_consult] channel-notification text. Exported for tests. */
export function buildConsultNotification(args: {
  consultId: string
  question: string
  context: string
  responseStyle: string
  budgetSeconds: number
}): string {
  return (
    `[voice_consult] Your user is asking you LIVE on a voice call ` +
    `(consult_id="${args.consultId}"):\n\n${args.question}` +
    (args.context ? `\n\nCall context: ${args.context}` : '') +
    (args.responseStyle ? `\n\nAnswer style: ${args.responseStyle}` : '') +
    `\n\nYou have ~${args.budgetSeconds} seconds. Call the ` +
    `voice_consult_reply tool FIRST — before any other tool — with ` +
    `consult_id="${args.consultId}" and a short, SPEAKABLE answer (1-3 ` +
    `sentences). Do NOT run other tools unless the question strictly ` +
    `requires it. If you cannot answer fully in time, reply with what you ` +
    `know and say the rest is coming — you can follow up in the chat.`
  )
}

export type ConsultReplyStatus = 'resolved' | 'late' | 'unknown'

interface PendingConsult {
  settle: (text: string) => void
  fail: (err: VoiceRpcError) => void
}

export class VoiceRpcHandler {
  private readonly deps: VoiceRpcDeps
  private readonly timing: VoiceRpcTiming
  /** Duplicate-frame guard: the backend re-emits once when its ACK doesn't
   *  land within 1.5 s; a consult dispatched twice would run two turns. */
  private readonly inFlight = new Set<string>()
  private readonly pendingConsults = new Map<string, PendingConsult>()
  /** consultId → expiry ts, so a LATE voice_consult_reply gets "send it to
   *  the chat instead" rather than "unknown id". Bounded + TTL'd. */
  private readonly expiredConsults = new Map<string, number>()

  constructor(deps: VoiceRpcDeps) {
    this.deps = deps
    this.timing = { ...DEFAULT_TIMING, ...deps.timing }
  }

  async handle(frame: VoiceRpcFrame): Promise<void> {
    if (!frame?.rpcId) return
    if (this.inFlight.has(frame.rpcId)) {
      this.deps.log(`voice_rpc duplicate frame ignored (rpc=${frame.rpcId})`)
      return
    }
    this.inFlight.add(frame.rpcId)
    try {
      // ACK is best-effort: a failed ACK only costs one retry-emit (which
      // the inFlight guard absorbs); it must not abort the op itself.
      try {
        await this.deps.postAck(frame.rpcId)
      } catch (err) {
        this.deps.log(
          `voice_rpc ack failed (non-fatal, rpc=${frame.rpcId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
      let payload: Record<string, unknown>
      if (frame.op === 'mint') {
        payload = await this.mint(frame)
      } else if (frame.op === 'consult') {
        payload = await this.consult(frame)
      } else {
        // The backend delivers dispatches to pairingless agents as
        // voice_task_dispatch events, not voice_rpc frames — answer
        // loudly so a future backend change fails fast, never silently.
        throw new VoiceRpcError(
          'UNSUPPORTED_OP',
          `unsupported voice_rpc op for the Claude Code channel: ${String(
            frame.op,
          )} (dispatch arrives as voice_task_dispatch)`,
        )
      }
      await this.postResult(frame.rpcId, { ok: true, payload })
    } catch (err) {
      const code = err instanceof VoiceRpcError ? err.code : 'PLUGIN_ERROR'
      await this.postResult(frame.rpcId, {
        ok: false,
        error: {
          code,
          message: err instanceof Error ? err.message : String(err),
        },
      })
    } finally {
      this.inFlight.delete(frame.rpcId)
    }
  }

  // ── mint ──────────────────────────────────────────────────────────────────

  private async mint(frame: VoiceRpcFrame): Promise<Record<string, unknown>> {
    const deadline = Date.now() + this.timing.mintTimeoutMs
    const { config } = this.deps
    if (!config.openaiApiKey) {
      throw new VoiceRpcError(
        'VOICE_NOT_CONFIGURED',
        'voice is not configured on this agent host: set BGOS_OPENAI_API_KEY ' +
          '(an OpenAI API key with Realtime access) in the plugin .mcp.json ' +
          'env and restart the agent',
      )
    }
    const identity = await this.deps
      .getIdentity(capToDeadline(this.timing.identityTimeoutMs, deadline))
      .catch(() => null)
    const recentContext =
      typeof frame.payload?.recentContext === 'string'
        ? frame.payload.recentContext
        : ''
    const instructions = buildMintInstructions({
      identity,
      persona: config.persona,
      recentContext,
    })
    const body = {
      expires_after: { anchor: 'created_at', seconds: 600 },
      session: {
        type: 'realtime',
        model: config.model,
        instructions,
        tools: [buildConsultToolDefinition()],
        audio: {
          // Input transcription is REQUIRED: the app builds the call
          // transcript (posted back into the chat) from realtime
          // transcription events. Server VAD gives natural turn-taking.
          input: {
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turn_detection: { type: 'server_vad' },
          },
          output: { voice: config.voice },
        },
      },
    }
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const ac = new AbortController()
    const timer = setTimeout(
      () => ac.abort(),
      capToDeadline(this.timing.mintTimeoutMs, deadline),
    )
    let res: Response
    try {
      res = await fetchImpl(CLIENT_SECRETS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openaiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
    } catch (err) {
      const aborted =
        (err as { name?: string })?.name === 'AbortError' || ac.signal.aborted
      throw new VoiceRpcError(
        'MINT_FAILED',
        aborted
          ? 'OpenAI mint timed out'
          : `OpenAI mint failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new VoiceRpcError(
        'MINT_FAILED',
        `OpenAI client_secrets ${res.status}: ${text.slice(0, 200)}`,
      )
    }
    const data = (await res.json()) as {
      value?: unknown
      expires_at?: unknown
    }
    const clientSecret = typeof data?.value === 'string' ? data.value : ''
    if (!clientSecret) {
      throw new VoiceRpcError(
        'MINT_FAILED',
        'OpenAI client_secrets returned no secret value',
      )
    }
    return {
      provider: 'openai',
      transport: 'webrtc',
      clientSecret,
      offerUrl: OFFER_URL,
      model: config.model,
      voice: config.voice,
      expiresAt:
        normalizeExpiresAtSeconds(data?.expires_at) ??
        Math.floor(Date.now() / 1000) + 600,
      // Context + persona ride the session instructions above — the app
      // must NOT inject recentContext again client-side.
      contextInjected: true,
    }
  }

  // ── consult ───────────────────────────────────────────────────────────────

  private async consult(
    frame: VoiceRpcFrame,
  ): Promise<Record<string, unknown>> {
    const { callId, name, args } = frame.payload as {
      callId?: string
      name?: string
      args?: Record<string, unknown>
    }
    if (!callId || !name) {
      throw new VoiceRpcError(
        'BAD_CONSULT',
        'consult payload missing callId/name',
      )
    }
    const question =
      typeof args?.question === 'string' ? args.question.trim() : ''
    if (!question) {
      throw new VoiceRpcError('BAD_CONSULT', 'consult args missing question')
    }
    const context = typeof args?.context === 'string' ? args.context.trim() : ''
    const responseStyle =
      typeof args?.responseStyle === 'string' ? args.responseStyle.trim() : ''
    const consultId = frame.rpcId
    const content = buildConsultNotification({
      consultId,
      question,
      context,
      responseStyle,
      // Advertise a bit less than the real cap so the agent aims inside it.
      budgetSeconds: Math.max(
        5,
        Math.floor((this.timing.consultTimeoutMs - 8_000) / 1000),
      ),
    })

    const text = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingConsults.delete(consultId)
        this.rememberExpired(consultId)
        reject(
          new VoiceRpcError(
            'CONSULT_TIMEOUT',
            'The agent is still working on it — it will follow up in the chat.',
          ),
        )
      }, this.timing.consultTimeoutMs)
      this.pendingConsults.set(consultId, {
        settle: (answer) => {
          clearTimeout(timer)
          this.pendingConsults.delete(consultId)
          resolve(answer)
        },
        fail: (err) => {
          clearTimeout(timer)
          this.pendingConsults.delete(consultId)
          reject(err)
        },
      })
      this.deps
        .notify(content, {
          event_type: 'voice_consult',
          consult_id: consultId,
          call_id: callId,
          chat_id:
            frame.chatId != null
              ? String(frame.chatId)
              : (this.deps.config.chatIdFallback ?? ''),
          assistant_id: this.deps.config.assistantId,
          transport: 'ws',
        })
        .catch((err) => {
          // If the live session is unreachable the consult can never
          // resolve — fail fast with a descriptive error instead of
          // burning the whole budget.
          this.pendingConsults
            .get(consultId)
            ?.fail(
              new VoiceRpcError(
                'CONSULT_DELIVERY_FAILED',
                `could not reach the live Claude session: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              ),
            )
        })
    })
    return { text }
  }

  /**
   * Called by the voice_consult_reply MCP tool. Returns how the reply was
   * received so the tool result can steer the agent:
   *   resolved — delivered to the live call
   *   late     — consult already timed out; send the answer as a chat reply
   *   unknown  — no such consult id (typo, or a restart dropped it)
   */
  resolveConsult(consultId: string, answer: string): ConsultReplyStatus {
    const pending = this.pendingConsults.get(consultId)
    if (pending) {
      pending.settle(answer)
      return 'resolved'
    }
    this.pruneExpired()
    if (this.expiredConsults.has(consultId)) return 'late'
    return 'unknown'
  }

  /** Number of consults currently awaiting a voice_consult_reply. */
  get pendingConsultCount(): number {
    return this.pendingConsults.size
  }

  private rememberExpired(consultId: string): void {
    this.pruneExpired()
    this.expiredConsults.set(
      consultId,
      Date.now() + this.timing.expiredConsultTtlMs,
    )
    // Hard bound so a pathological caller can't grow the map forever.
    if (this.expiredConsults.size > 200) {
      const first = this.expiredConsults.keys().next().value
      if (first !== undefined) this.expiredConsults.delete(first)
    }
  }

  private pruneExpired(): void {
    const now = Date.now()
    for (const [id, expiry] of this.expiredConsults) {
      if (expiry <= now) this.expiredConsults.delete(id)
    }
  }

  private async postResult(
    rpcId: string,
    body: VoiceRpcResultBody,
  ): Promise<void> {
    try {
      await this.deps.postResult(rpcId, body)
    } catch (err) {
      // Nothing else we can do — the backend's own timeout surfaces the
      // failure to the app.
      this.deps.log(
        `voice_rpc result post failed (rpc=${rpcId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
}
