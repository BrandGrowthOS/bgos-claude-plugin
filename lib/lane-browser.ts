/**
 * PERSON LANES, the Agent Browser and the shared vault in a person's lane
 * (plugin 0.90.0; BGOS plan docs/superpowers/plans/2026-11-13-shared-agent-
 * vault-build.md sections 4.1, 4.2 and 9).
 *
 * THE BROWSER. When the share's tool policy has `browser: true` (and so the
 * lane was launched with it, lib/lane-policy.mjs), the lane daemon serves the
 * Agent Browser tools under its own `bgos` server and forwards each call to
 * the relay, POST integrations/browser/mcp, with the LANE's own http: the
 * lane session (X-BGOS-Session), never the pairing token, and never the
 * browser shim, whose local door is the owner's own desktop browser (D3). The
 * server elects this agent's own browser host for the person (or the
 * person's own desktop) and the host runs the person's own profile. A call
 * the relay holds is collected on GET integrations/browser/mcp/<rpcId>.
 *
 * Only the names in LANE_BROWSER_TOOL_NAMES are served and forwarded: a tool
 * a host adds later, a file upload from the owner's computer and the host's
 * hoai_vault_fill never reach the lane's model. With no host online the lane
 * serves one status tool that says so, and `refresh` (on every lane
 * heartbeat) tells Claude Code when the list changes.
 *
 * THE VAULT. Two tools, served while the server lets this person use the
 * vault (GET vault/lane/items answers; a 403 or 404 means not shared):
 *   vault_items  GET vault/lane/items, metadata only, copied field by field.
 *   vault_fill   POST vault/lane/items/<itemId>/fill {sessionId, tabId,
 *                origin}. `ready` carries a one use ticket; `waiting` means
 *                the owner was asked: the person is told once, in one plain
 *                sentence, and the lane polls GET vault/lane/fills/<requestId>
 *                every few seconds up to the request's expiry. With a ticket
 *                the lane calls the relay tool hoai_vault_fill {ticket,
 *                sessionId, tabId, origin}; the agent's own host redeems it,
 *                fills and answers a receipt.
 * Neither tool takes or returns a password, a value or the ticket.
 *
 * Every effect is injected, so all of it is tested with fakes
 * (test/lane-browser.test.ts). Erasable TypeScript only.
 *
 * No em or en dashes in this file.
 */
import { LANE_BROWSER_TOOL_NAMES } from './lane-policy.mjs'

/** The lane's own http: the lane session and nothing else (lane-server.ts laneFetch). Throws on a non 2xx with `status` and `body`. */
export interface LaneHttp {
  get(path: string, timeoutMs?: number): Promise<unknown>
  post(path: string, body: unknown, timeoutMs?: number): Promise<unknown>
}

export interface McpTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  [key: string]: unknown
}

export interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>
  isError?: boolean
  [key: string]: unknown
}

const RELAY_PATH = 'integrations/browser/mcp'
/** The backend holds a relayed call at most this long (the shim's RELAY_WAIT_MS). */
const RELAY_WAIT_MS = 45_000
/** One HTTP request to the relay, a little over its hold. */
const RELAY_REQUEST_MS = 60_000
/** A call the relay holds is collected for at most this long (the shim's RELAY_TOTAL_MS). */
const RELAY_TOTAL_MS = 180_000
/** How often a fill that waits for the owner asks again. */
export const LANE_VAULT_POLL_MS = 3_000
/** The longest a fill waits for the owner, whatever the server says (its requests live 10 minutes). */
export const LANE_VAULT_WAIT_MAX_MS = 10 * 60_000 + 5_000

/** What the person reads, once, when a fill waits for the owner. One sentence. */
export const LANE_VAULT_WAITING_SENTENCE =
  'I asked the owner of this agent to approve signing you in with their saved login, and I will carry on as soon as they answer.'

const OFFLINE_TOOL: McpTool = {
  name: 'hoai_browser_status',
  description: 'Status of your browser. While no browser host is online for this person this is the only browser tool, and it says why.',
  inputSchema: { type: 'object', properties: {} },
}

const NO_SECRET =
  'It never takes or returns a password or any other saved value: the agent\'s own browser host fills the login into the page, and you never see it.'

export const LANE_VAULT_TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: 'vault_items',
    description:
      'List the saved logins you may use for the person you are talking to: the owner\'s logins the owner shared with them, and their own. Each has id, name, website, username, ask (true when the owner approves each use) and own. Metadata only. ' +
      NO_SECRET.replace('It never takes or returns', 'This tool never takes or returns'),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'vault_fill',
    description:
      'Sign in with a saved login from vault_items on the page open in your browser. Give the login id, the sessionId and tabId that hoai_browser_status shows for the tab, and the exact HTTPS origin of that tab, which must be the login\'s website. When the owner asks to approve each use, the person is told and this waits for the owner. Answers {filled: true} or {filled: false, reason}. ' +
      NO_SECRET.replace('It never takes or returns', 'This tool never takes or returns'),
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'A login id from vault_items.' },
        sessionId: { type: 'string', description: 'The browser session id from hoai_browser_status.' },
        tabId: { type: 'string', description: 'The tab id from hoai_browser_status.' },
        origin: { type: 'string', description: 'The exact HTTPS origin of that tab, for example https://example.com.' },
      },
      required: ['itemId', 'sessionId', 'tabId', 'origin'],
      additionalProperties: false,
    },
  },
])

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })
const json = (value: unknown, isError = false): ToolResult => text(JSON.stringify(value), isError)

/** The status and the server's own sentence of an http failure, never more than 300 characters of it. */
function failure(err: unknown): { status: number | null; code: string | null; message: string | null } {
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : null
  let code: string | null = null
  let message: string | null = null
  const body = (err as { body?: unknown })?.body
  if (typeof body === 'string' && body !== '') {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>
      if (typeof parsed.code === 'string') code = parsed.code.slice(0, 80)
      else if (typeof parsed.error === 'string') code = parsed.error.slice(0, 80)
      const m = parsed.message
      if (typeof m === 'string') message = m.slice(0, 300)
      else if (Array.isArray(m) && typeof m[0] === 'string') message = String(m[0]).slice(0, 300)
    } catch { /* not JSON */ }
  }
  return { status, code, message }
}

// ── The relay, as this lane ─────────────────────────────────────────────────

export interface LaneBrowserRelayDeps {
  http: LaneHttp
  assistantId: string
  /** The relay's MCP session key for this lane process ([A-Za-z0-9_-], at most 64); sent as the relay body's own key. */
  relaySessionKey: string
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export type RelayAnswer = { ok: true; message: Record<string, unknown> } | { ok: false; code: string; text: string }

const RELAY_TEXT: Record<string, string> = {
  host_offline: 'No browser host is online for this person right now: the agent\'s own computer is not running its browser, and the person has no Home of Agents desktop app open.',
  browser_disabled: 'The browser is not available on this share. Ask the owner of this agent to turn it on for this person.',
  rate_limited: 'Too many browser calls at once or in the last minute. Nothing ran. Wait a little, then try again.',
  throttled: 'HOAI asked this lane to slow down. Nothing ran. Wait a little, then try again.',
  host_timeout: 'The browser did not answer in time. Check the page with browser_snapshot before you try again.',
  relay_unreachable: 'HOAI could not be reached just now. Try again in a moment.',
  relay_error: 'The browser relay could not take this call. Try again once.',
}

export class LaneBrowserRelay {
  private readonly deps: LaneBrowserRelayDeps
  private initialized = false
  private seq = 0

  constructor(deps: LaneBrowserRelayDeps) {
    this.deps = deps
  }

  /** Forget the relay session (a host that went away is elected afresh on the next call). */
  reset(): void {
    this.initialized = false
  }

  private refusal(err: unknown): RelayAnswer {
    const f = failure(err)
    const code = f.code && RELAY_TEXT[f.code] ? f.code
      : f.status === 403 ? 'browser_disabled'
        : f.status === 429 ? 'throttled'
          : f.status === 504 ? 'host_timeout'
            : f.status === null ? 'relay_unreachable'
              : 'relay_error'
    // The relay's own sentence wins: it names what it refused (a fill elected on
    // the person's desktop, a host that dropped).
    return { ok: false, code, text: f.message ?? RELAY_TEXT[code]! }
  }

  /** One JSON-RPC message through the relay. Never throws. */
  async send(message: Record<string, unknown>): Promise<RelayAnswer> {
    const { http, sleep, now } = this.deps
    const startedAt = now()
    let answer: unknown
    try {
      answer = await http.post(RELAY_PATH, { clientId: this.deps.relaySessionKey, message, waitMs: RELAY_WAIT_MS, assistantId: Number(this.deps.assistantId) }, RELAY_REQUEST_MS)
    } catch (err) {
      return this.refusal(err)
    }
    for (;;) {
      const a = (answer ?? {}) as Record<string, unknown>
      if (a.status === 'done') return { ok: true, message: (a.message && typeof a.message === 'object' ? a.message : {}) as Record<string, unknown> }
      if (a.status === 'pending' && typeof a.rpcId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(a.rpcId)) {
        if (now() - startedAt > RELAY_TOTAL_MS) return { ok: false, code: 'host_timeout', text: RELAY_TEXT.host_timeout! }
        await sleep(Math.max(250, Number(a.pollAfterMs) || 2_000))
        try {
          answer = await http.get(`${RELAY_PATH}/${encodeURIComponent(a.rpcId)}`, RELAY_REQUEST_MS)
        } catch (err) {
          const refused = this.refusal(err)
          // The call was sent: it may have run.
          return refused.ok ? refused : { ...refused, text: `${refused.text} The call was sent and may have run; check the page before you repeat it.` }
        }
        continue
      }
      return { ok: false, code: 'relay_error', text: RELAY_TEXT.relay_error! }
    }
  }

  private async request(method: string, params: Record<string, unknown>): Promise<RelayAnswer> {
    this.seq += 1
    return this.send({ jsonrpc: '2.0', id: `lane-${this.seq}`, method, params })
  }

  /** initialize once per relay session. */
  async ensureInit(): Promise<{ ok: true } | { ok: false; code: string; text: string }> {
    if (this.initialized) return { ok: true }
    const init = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hoai-lane', version: '1' } })
    if (!init.ok) return init
    if (init.message.error) return { ok: false, code: 'relay_error', text: RELAY_TEXT.relay_error! }
    await this.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    this.initialized = true
    return { ok: true }
  }

  /** The host's tool list, or the refusal that kept it away. */
  async listTools(): Promise<{ ok: true; tools: McpTool[] } | { ok: false; code: string; text: string }> {
    const init = await this.ensureInit()
    if (!init.ok) return init
    const listed = await this.request('tools/list', {})
    if (!listed.ok) {
      this.reset()
      return listed
    }
    const tools = (listed.message.result as { tools?: unknown } | undefined)?.tools
    return { ok: true, tools: Array.isArray(tools) ? (tools as McpTool[]).filter((t) => t && typeof t.name === 'string') : [] }
  }

  /** One tool call on the host. A refusal is a tool error with the relay's sentence. */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const init = await this.ensureInit()
    if (!init.ok) return text(init.text, true)
    const called = await this.request('tools/call', { name, arguments: args })
    if (!called.ok) {
      if (called.code === 'host_offline' || called.code === 'relay_unreachable') this.reset()
      return text(called.text, true)
    }
    if (called.message.error) {
      const e = called.message.error as { message?: unknown }
      return text(typeof e.message === 'string' ? e.message.slice(0, 500) : 'The browser could not run this call.', true)
    }
    const result = called.message.result as ToolResult | undefined
    return result && Array.isArray(result.content) ? result : text('The browser answered nothing.', true)
  }
}

// ── The tools the lane serves ───────────────────────────────────────────────

export interface LaneBrowserToolsDeps {
  /** The share's browser option as THIS launch has it (lib/lane-controls.ts launchedFacts). */
  enabled: boolean
  relay: LaneBrowserRelay
  http: LaneHttp
  sleep: (ms: number) => Promise<void>
  now: () => number
  log: (line: string) => void
  /** Tell the person, in their chat, one plain sentence. */
  tellPerson: (sentence: string) => Promise<void>
  /** notifications/tools/list_changed to Claude Code. */
  onListChanged: () => void
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const TICKET_RE = /^[A-Za-z0-9_-]{20,200}$/

function exactHttpsOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const u = new URL(value)
    return u.protocol === 'https:' && u.origin === value ? value : null
  } catch {
    return null
  }
}

export class LaneBrowserTools {
  private readonly deps: LaneBrowserToolsDeps
  private roster: McpTool[] | null = null
  private offlineText: string = RELAY_TEXT.host_offline!
  private vaultOffered = false
  private lastKey: string | null = null

  constructor(deps: LaneBrowserToolsDeps) {
    this.deps = deps
  }

  private served(): McpTool[] {
    if (!this.deps.enabled) return []
    const browser = this.roster ?? [OFFLINE_TOOL]
    return [...browser, ...(this.vaultOffered ? LANE_VAULT_TOOLS.map((t) => ({ ...t })) : [])]
  }

  private async load(): Promise<void> {
    if (!this.deps.enabled) return
    const listed = await this.deps.relay.listTools()
    if (listed.ok) {
      const byName = new Map(listed.tools.map((t) => [t.name, t]))
      // The fixed list, in its own order: never a tool the lane does not name.
      this.roster = LANE_BROWSER_TOOL_NAMES.filter((name: string) => byName.has(name)).map((name: string) => ({ ...byName.get(name)! }))
    } else {
      this.roster = null
      this.offlineText = listed.text
    }
    try {
      await this.deps.http.get('vault/lane/items')
      this.vaultOffered = true
    } catch (err) {
      const f = failure(err)
      // Not shared (403) or not served (404): no vault tools. A blip keeps what was known.
      if (f.status === 403 || f.status === 404 || f.status === 401) this.vaultOffered = false
    }
  }

  private key(): string {
    return this.served().map((t) => t.name).join(',')
  }

  /** What is served now, without asking anything. */
  current(): McpTool[] {
    return this.served()
  }

  /** The tools to list now (reads the relay and the vault once). */
  async list(): Promise<McpTool[]> {
    await this.load()
    this.lastKey = this.key()
    return this.served()
  }

  /** Read both again and tell Claude Code when what is served changed. */
  async refresh(): Promise<void> {
    if (!this.deps.enabled) return
    await this.load()
    const key = this.key()
    if (this.lastKey !== null && key !== this.lastKey) {
      this.lastKey = key
      this.deps.onListChanged()
    }
  }

  /** Is `name` one of the tools this lane serves (whatever is served right now)? */
  handles(name: string): boolean {
    if (!this.deps.enabled) return false
    return (LANE_BROWSER_TOOL_NAMES as readonly string[]).includes(name) || name === 'vault_items' || name === 'vault_fill'
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    if (!this.deps.enabled || !this.handles(name)) return text(`Unknown tool: ${name}`, true)
    const a = (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Record<string, unknown>
    if (name === 'vault_items') return this.vaultItems()
    if (name === 'vault_fill') return this.vaultFill(a)
    if (!this.roster) {
      await this.load()
      if (!this.roster) return text(this.offlineText, name !== 'hoai_browser_status')
      this.deps.onListChanged()
    }
    if (!this.roster.some((t) => t.name === name)) return text(`Unknown tool: ${name}`, true)
    return this.deps.relay.callTool(name, a)
  }

  private async vaultItems(): Promise<ToolResult> {
    try {
      const answer = (await this.deps.http.get('vault/lane/items')) as { items?: unknown } | null
      const rows = Array.isArray(answer?.items) ? answer!.items as Array<Record<string, unknown>> : []
      const str = (v: unknown) => (typeof v === 'string' ? v : null)
      const items = rows.filter((r) => r && typeof r === 'object').map((r) => ({
        id: str(r.id),
        name: str(r.name),
        website: str(r.website),
        username: str(r.username),
        ask: r.ask === true,
        own: r.own === true,
      }))
      this.deps.log(`vault: items listed (${items.length})`)
      return json({ items })
    } catch (err) {
      const f = failure(err)
      this.deps.log(`vault: items refused (${f.status ?? 'network'})`)
      return json({ error: 'vault_unavailable', message: f.message ?? 'The saved logins could not be read just now.' }, true)
    }
  }

  private async vaultFill(a: Record<string, unknown>): Promise<ToolResult> {
    const allowed = new Set(['itemId', 'sessionId', 'tabId', 'origin'])
    const origin = exactHttpsOrigin(a.origin)
    if (Object.keys(a).some((k) => !allowed.has(k)) || !ID_RE.test(String(a.itemId ?? '')) || !ID_RE.test(String(a.sessionId ?? '')) || !ID_RE.test(String(a.tabId ?? '')) || !origin) {
      return json({ error: 'vault_input_invalid', message: 'Give itemId from vault_items, sessionId and tabId from hoai_browser_status, and the exact HTTPS origin of the tab. Never a password.' }, true)
    }
    const itemId = String(a.itemId)
    const target = { sessionId: String(a.sessionId), tabId: String(a.tabId), origin }
    let ticket: string | null = null
    try {
      const asked = (await this.deps.http.post(`vault/lane/items/${encodeURIComponent(itemId)}/fill`, target)) as Record<string, unknown> | null
      if (asked?.status === 'ready' && typeof asked.ticket === 'string') ticket = asked.ticket
      else if (asked?.status === 'waiting' && typeof asked.requestId === 'string' && ID_RE.test(asked.requestId)) {
        const waited = await this.waitForOwner(asked.requestId, asked.expiresAt)
        if (!waited.ok) return json({ filled: false, reason: waited.reason, message: waited.message })
        ticket = waited.ticket
      } else return json({ filled: false, reason: 'vault_unavailable', message: 'The vault did not give a fill for this login.' })
    } catch (err) {
      const f = failure(err)
      this.deps.log(`vault: fill refused (${f.status ?? 'network'})`)
      return json({ error: 'vault_refused', message: f.message ?? 'The vault could not take this fill just now.' }, true)
    }
    if (!ticket || !TICKET_RE.test(ticket)) return json({ filled: false, reason: 'vault_unavailable', message: 'The vault did not give a usable fill.' })
    const done = await this.deps.relay.callTool('hoai_vault_fill', { ticket, ...target })
    ticket = null
    const said = done.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('')
    let receipt: Record<string, unknown> | null = null
    try { receipt = JSON.parse(said) as Record<string, unknown> } catch { /* a sentence */ }
    if (receipt && receipt.filled === true) {
      this.deps.log(`vault: login ${itemId} filled`)
      return json({ filled: true })
    }
    if (receipt && receipt.filled === false) {
      const reason = typeof receipt.reason === 'string' && /^[a-z_]{1,64}$/.test(receipt.reason) ? receipt.reason : 'not_filled'
      this.deps.log(`vault: login ${itemId} not filled (${reason})`)
      return json({ filled: false, reason })
    }
    this.deps.log(`vault: login ${itemId} not filled (host answer)`)
    return json({ filled: false, reason: 'host_refused', message: said.slice(0, 300) || 'The browser did not fill the login.' }, done.isError === true)
  }

  private async waitForOwner(requestId: string, expiresAt: unknown): Promise<{ ok: true; ticket: string } | { ok: false; reason: string; message: string }> {
    const { http, sleep, now, tellPerson, log } = this.deps
    const started = now()
    const parsed = typeof expiresAt === 'string' ? Date.parse(expiresAt) : typeof expiresAt === 'number' ? expiresAt : NaN
    const until = Math.min(Number.isFinite(parsed) ? parsed : started + LANE_VAULT_WAIT_MAX_MS, started + LANE_VAULT_WAIT_MAX_MS)
    try { await tellPerson(LANE_VAULT_WAITING_SENTENCE) } catch { log('vault: the person could not be told that the owner was asked') }
    log(`vault: fill ${requestId} waits for the owner`)
    const ownerSilent = { ok: false as const, reason: 'owner_did_not_answer', message: 'The owner did not answer in time, so nothing was filled.' }
    while (now() < until) {
      await sleep(LANE_VAULT_POLL_MS)
      let answer: Record<string, unknown> | null = null
      try {
        answer = (await http.get(`vault/lane/fills/${encodeURIComponent(requestId)}`)) as Record<string, unknown> | null
      } catch (err) {
        const f = failure(err)
        if (f.status === 403 || f.status === 404) return { ok: false, reason: 'vault_unavailable', message: f.message ?? 'This fill is no longer available.' }
        continue
      }
      const status = answer?.status
      if (status === 'waiting') continue
      if (status === 'ready') {
        return typeof answer?.ticket === 'string'
          ? { ok: true, ticket: answer.ticket }
          : { ok: false, reason: 'already_used', message: 'This approval was already used. Ask again with vault_fill.' }
      }
      if (status === 'denied') return { ok: false, reason: 'owner_denied', message: 'The owner said no, so nothing was filled.' }
      if (status === 'expired') return ownerSilent
    }
    return ownerSilent
  }
}
