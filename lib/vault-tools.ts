import { z } from 'zod'
import {
  VaultError,
  buildFillIntent,
  hostPinStatus,
  loadOrCreateHostKey,
  signFillIntent,
  vaultCall,
  verifyFillIntent,
} from './vault-host.mjs'

// The agent half of HOAI vault request and fill (capability canon, "Agent
// vault"). Every tool returns metadata, a request receipt or a one-use fill
// ticket with its signed intent. None takes, returns or logs a value: values
// are decrypted only by the owner's desktop, under its own OS unlock.

const HOST_SETUP =
  'Ask the owner to run `hoai vault-host` in a terminal on this agent machine. It registers this host, shows its fingerprint there (never in chat) for the owner to compare and pin in HOAI, and records the pin. Do not ask for or relay the fingerprint yourself.'

export const VAULT_GUIDANCE =
  'Never ask for, accept or repeat a password or other vault value in chat or tool input. To sign in with a saved login, call vault_items, then vault_fill_prepare with the login id and the HOAI browser sessionId, tabId and exact HTTPS origin, and pass its ticket, sessionId, tabId, origin and request unchanged to hoai_vault_fill on the HOAI desktop browser. It fills under the owner credential hold and returns a receipt only. If no saved login fits, call vault_request_login so the owner adds it in the secure form.'

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Use the item id exactly as vault_items returned it.')
const httpsOrigin = z.string().max(2048).refine((value) => {
  try {
    const u = new URL(value)
    return u.protocol === 'https:' && u.origin === value
  } catch {
    return false
  }
}, 'Use the exact HTTPS origin of the browser tab, for example https://example.com.')
const httpsWebsite = z.string().min(1).max(2048).refine((value) => {
  try {
    const u = new URL(value)
    return u.protocol === 'https:' && !u.username && !u.password
  } catch {
    return false
  }
}, 'Use an HTTPS website without credentials in it.')
const bounded = z.string().min(1).max(128)

const schemas = {
  vault_items: z.strictObject({
    q: z.string().max(120).optional().describe('Optional name or label to search for.'),
  }),
  vault_request_login: z.strictObject({
    name: z.string().min(1).max(120).describe('What the login is for, as the owner will see it.'),
    website: httpsWebsite.describe('The HTTPS website the login is for.'),
    username: z.string().max(320).optional().describe('Optional username or email to suggest. Never a password.'),
  }),
  vault_fill_prepare: z.strictObject({
    itemId: uuid.describe('A login id from vault_items.'),
    sessionId: bounded.describe('The HOAI desktop browser session id.'),
    tabId: bounded.describe('The HOAI desktop browser tab id.'),
    origin: httpsOrigin.describe('The exact HTTPS origin of that tab; it must match the login website.'),
  }),
}
type VaultToolName = keyof typeof schemas

const descriptions: Record<VaultToolName, string> = {
  vault_items:
    "List the owner's vault items this agent may use: id, name, kind, labels, website, username, env name, reference and revision. Metadata only; values never leave the owner's devices. ",
  vault_request_login:
    "Ask the owner to add a login. Opens the secure Add a login form in the owner's chat, prefilled with name, website and optional username. Returns {requested, messageId}. Never put a password in any field. ",
  vault_fill_prepare:
    'Prepare a one-use fill of a saved login into the HOAI desktop browser. Builds and signs the fill intent on this host and returns {ticket, sessionId, tabId, origin, request:{intent, signature}}; pass them unchanged to hoai_vault_fill. Refused until the owner has pinned this host. ',
}

export const VAULT_TOOL_DECLS = (Object.keys(schemas) as VaultToolName[]).map((name) => ({
  name,
  description: descriptions[name] + VAULT_GUIDANCE,
  inputSchema: z.toJSONSchema(schemas[name], { target: 'draft-7' }) as {
    type: 'object'
    properties: Record<string, unknown>
    additionalProperties: false
  },
}))

export interface VaultToolDeps {
  assistantId: string | number
  /** The paired owner. */
  ownerId: string
  /** Who the current turn was admitted for. Only the owner may use the vault. */
  actingUserId: string
  apiBase: string
  pairingToken: string
  /** The agent's vault host folder (lib/vault-host.mjs vaultHostDir). */
  stateDir: string
  fetch?: typeof globalThis.fetch
  /** Log sink. Gets codes and item ids only, never a value, key, ticket or fingerprint. */
  log?: (line: string) => void
}

type Row = Record<string, unknown>
const isRow = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v)

const MESSAGES: Record<string, string> = {
  VAULT_INPUT_INVALID: 'The input is not valid for this tool. Never include a password or other value.',
  VAULT_OWNER_ONLY: 'Only the owner can use this agent vault. This turn was not admitted for the owner.',
  VAULT_HOST_NOT_PINNED: `This agent machine is not yet pinned by the owner, so no fill was requested. ${HOST_SETUP}`,
  VAULT_HOST_SETUP_REQUIRED: `This agent machine has no vault host identity yet. ${HOST_SETUP}`,
  VAULT_HOST_KEY_EXPOSED: 'The vault host key file is readable by other users, so it is not used. Ask the owner to remove it and run `hoai vault-host` in a terminal on this agent machine.',
  VAULT_HOST_KEY_INVALID: 'The vault host key file is damaged or belongs to another agent. Ask the owner to remove it and run `hoai vault-host` in a terminal on this agent machine.',
  VAULT_SIGNING_KEY_INVALID: `The stored agent signing key is not usable. ${HOST_SETUP}`,
  VAULT_NOT_PAIRED: 'The vault needs this agent\'s owner pairing. Ask the owner to pair this agent again.',
  VAULT_ORIGIN_MISMATCH: 'That login is saved for a different website than this tab. Use a login whose website matches the tab origin, or ask the owner with vault_request_login.',
  VAULT_REQUEST_REFUSED: 'The vault refused this request. Check the item, website and tab and try again once; do not retry in a loop.',
  VAULT_UNAVAILABLE: 'The vault item or service is not available to this agent. Do not retry in a loop; ask the owner to check the item is shared with this agent.',
}

class ToolRefusal extends Error {
  constructor(public code: string) { super(code) }
}

function refusal(code: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: code, message: MESSAGES[code] ?? MESSAGES.VAULT_UNAVAILABLE }) }],
    isError: true as const,
  }
}

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })

const str = (v: unknown) => (typeof v === 'string' ? v : null)
const posInt = (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null)

/** The metadata an agent may see, copied field by field. Nothing else crosses. */
function publicItem(row: Row) {
  return {
    id: str(row.id),
    name: str(row.name),
    kind: str(row.kind),
    labels: Array.isArray(row.labels) ? row.labels.filter((l): l is string => typeof l === 'string') : [],
    website: str(row.website),
    username: str(row.username),
    envName: str(row.envName),
    reference: str(row.reference),
    vaultAssistantId: posInt(row.vaultAssistantId),
    revision: posInt(row.revision),
  }
}

function rows(answer: unknown): Row[] {
  if (!isRow(answer) || !Array.isArray(answer.items)) throw new ToolRefusal('VAULT_UNAVAILABLE')
  return answer.items.filter(isRow)
}

type VaultToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true }

export async function handleVaultTool(name: string, args: unknown, deps: VaultToolDeps): Promise<VaultToolResult> {
  const log = (line: string) => { try { deps.log?.(`vault: ${line}`) } catch {} }
  try {
    if (!Object.hasOwn(schemas, name)) throw new ToolRefusal('VAULT_INPUT_INVALID')
    if (!deps.ownerId || deps.actingUserId !== deps.ownerId) throw new ToolRefusal('VAULT_OWNER_ONLY')
    const parsed = schemas[name as VaultToolName].safeParse(args ?? {})
    if (!parsed.success) throw new ToolRefusal('VAULT_INPUT_INVALID')
    const assistantId = Number(deps.assistantId)
    if (!Number.isSafeInteger(assistantId) || assistantId <= 0) throw new ToolRefusal('VAULT_NOT_PAIRED')
    // First use creates the host key; a key other users can read is refused here.
    const host = loadOrCreateHostKey(deps.stateDir, assistantId)
    const call = (method: 'GET' | 'POST', sub: string, extra: { query?: Row; body?: Row } = {}) => {
      if (!host.signingSecret) throw new ToolRefusal('VAULT_HOST_SETUP_REQUIRED')
      return vaultCall({ method, apiBase: deps.apiBase, assistantId, sub, ...extra, signingSecret: host.signingSecret, pairingToken: deps.pairingToken, fetch: deps.fetch })
    }

    if (name === 'vault_items') {
      const input = parsed.data as { q?: string }
      const items = rows(await call('GET', 'items', { query: { q: input.q?.trim() } })).map(publicItem)
      log(`items listed (${items.length})`)
      return ok({ items })
    }

    if (name === 'vault_request_login') {
      const input = parsed.data as { name: string; website: string; username?: string }
      const body: Row = { name: input.name, website: input.website, ...(input.username ? { username: input.username } : {}) }
      const answer = await call('POST', 'request', { body })
      if (!isRow(answer) || answer.requested !== true) throw new ToolRefusal('VAULT_UNAVAILABLE')
      log('login requested from the owner')
      return ok({ requested: true, ...(posInt(answer.messageId) ? { messageId: posInt(answer.messageId) } : {}) })
    }

    // vault_fill_prepare
    const input = parsed.data as { itemId: string; sessionId: string; tabId: string; origin: string }
    if (hostPinStatus(host) !== 'pinned') throw new ToolRefusal('VAULT_HOST_NOT_PINNED')
    const item = rows(await call('GET', 'items')).find((row) => row.id === input.itemId)
    if (!item || item.kind !== 'login') throw new ToolRefusal('VAULT_UNAVAILABLE')
    if (item.website !== input.origin) throw new ToolRefusal('VAULT_ORIGIN_MISMATCH')
    if (item.ownerId !== deps.ownerId || !str(item.vaultId) || !posInt(item.vaultAssistantId) || !posInt(item.revision)) {
      throw new ToolRefusal('VAULT_UNAVAILABLE')
    }
    const intent = buildFillIntent({
      ownerId: deps.ownerId,
      assistantId,
      vaultAssistantId: item.vaultAssistantId,
      vaultId: item.vaultId,
      itemId: input.itemId,
      revision: item.revision,
      sessionId: input.sessionId,
      tabId: input.tabId,
      origin: input.origin,
    })
    const signature = signFillIntent(intent, host.signingSecret)
    // The same check the server and desktop make, before anything leaves here.
    if (!verifyFillIntent(intent, signature, host.identityPublic)) throw new ToolRefusal('VAULT_UNAVAILABLE')
    const answer = await call('POST', `items/${input.itemId}/fill`, {
      body: { sessionId: input.sessionId, tabId: input.tabId, origin: input.origin, intent, signature },
    })
    const ticket = isRow(answer) ? str(answer.ticket) : null
    if (!ticket || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new ToolRefusal('VAULT_UNAVAILABLE')
    log(`fill ticket issued for item ${input.itemId}`)
    return ok({
      ticket,
      sessionId: input.sessionId,
      tabId: input.tabId,
      origin: input.origin,
      request: { intent, signature },
      expiresIn: posInt(isRow(answer) ? answer.expiresIn : null) ?? 60,
      next: 'Call hoai_vault_fill on the HOAI desktop browser now with ticket, sessionId, tabId, origin and request exactly as given. It returns a receipt only.',
    })
  } catch (error) {
    const code = error instanceof ToolRefusal || error instanceof VaultError
      ? (error as { code: string }).code
      : 'VAULT_UNAVAILABLE'
    const status = error instanceof VaultError && typeof (error as { status?: number }).status === 'number' ? ` (HTTP ${(error as { status?: number }).status})` : ''
    log(`${name} refused ${code}${status}`)
    return refusal(code)
  }
}
