import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const TOKEN_PATTERN = /<hoai-private-turn id="([a-f0-9-]{36})"\/>/g
export const PRIVATE_TURN_MAX_AGE_MS = 15 * 60_000
export const privatePromptHash = (prompt) => createHash('sha256').update(String(prompt ?? '')).digest('hex')
export const privateMarkerPath = (root, key) => join(root, 'private-turn', `${key}.json`)
/** The helpers (subagents) started in each turn, beside the turn marker. */
export const privateAgentsPath = (markerPath) => `${markerPath}.agents.json`
/** Every tool that acts as the verified sender: the Agent Browser and the bgos schedule and boards tools, under any install prefix. */
export const PRIVATE_TOOL_MATCHER = '^mcp__(.*_)?(hoai-browser__.+|bgos__(schedule|list_schedules|cancel_schedule|boards_.+))$'
export const privateContextPath = (root, assistantId) => join(root, String(assistantId), 'browser-turn.json')

/** Author stamps only. Legacy userId/user_id name the transport owner. */
export function privateSenderUserId(message) {
  const candidate = message?.sender?.userId ?? message?.senderUserId ?? message?.sender_user_id
  return typeof candidate === 'string' && candidate ? candidate : null
}

export function readPrivateJson(path, maxBytes = 8192) {
  try {
    if (statSync(path).size > maxBytes) return null
    const raw = readFileSync(path, 'utf8')
    if (Buffer.byteLength(raw) > maxBytes) return null
    return JSON.parse(raw)
  } catch { return null }
}

export function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
  renameSync(tmp, path)
}

/** Only authenticated delivery fields may supply an actor. Never use user_id. */
export function privateActor({ senderType, senderUserId, agentOrigin, eventMeta } = {}) {
  if (agentOrigin) return null
  const valid = (value) => typeof value === 'string' && /^user_[A-Za-z0-9_-]+$/.test(value) ? value : null
  if (String(senderType).toLowerCase() === 'user') return valid(senderUserId)
  if (String(senderType).toLowerCase() === 'system' && eventMeta?.source === 'scheduler' &&
      eventMeta.payload && typeof eventMeta.payload === 'object' && !Array.isArray(eventMeta.payload)) {
    return valid(eventMeta.payload.actingUserId)
  }
  return null
}

/**
 * The daemon's line for a second record of one submission's boundary. It is the only trace of a second hook source
 * (the CLI runs a hook once per distinct command, so the same script under two spellings runs twice).
 * @param {{ kind: 'prompt' | 'restamp', sessionId?: string, from?: string, to?: string }} repeat
 */
export function privateRepeatLine(repeat) {
  return repeat?.kind === 'restamp'
    ? `private turn: the marker was stamped again for the same submission (turn ${repeat.from} became ${repeat.to}); the turn stands. Is the private turn hook registered twice?`
    : `private turn: the same submission reached the daemon twice in session ${repeat?.sessionId}; what its first record decided stands. Is the hook forwarder registered twice?`
}

/**
 * Opaque delivery identity is separate from the activity rail's text matching.
 * @param {{ now?: () => number, randomId?: () => string, onRevoke?: () => void,
 *   onRepeat?: (repeat: { kind: 'prompt' | 'restamp', sessionId?: string, from?: string, to?: string }) => void }} [options]
 */
export function createPrivateTurnTracker({ now = Date.now, randomId = randomUUID, onRevoke = () => {}, onRepeat = () => {} } = {}) {
  const deliveries = new Map()
  let pending = null
  let active = null
  // The peer agent behind the current turn, kept apart from `pending` on purpose: a peer turn has no actor, so
  // `pending` stays null and every private call refuses; this only lets the refusal be counted.
  let peerPending = null
  // Submissions carrying a delivery token that begin() already took: session, prompt hash and the CLI's own
  // prompt_id, which every hook of one submission shares and a resubmission does not. The same key again is a
  // second record of the SAME boundary (a second hook source), never a new prompt, so it must not undo what the
  // first record decided. Without a prompt_id nothing is remembered and every record is a new prompt.
  const begun = new Set()
  return {
    /**
     * @param {{ content: string, actingUserId?: string | null, chatId: string | number,
     *   peerSourceAssistantId?: string | number | null }} delivery
     */
    deliver({ content, actingUserId, chatId, peerSourceAssistantId = null }) {
      const token = randomId()
      const delivery = {
        actingUserId: actingUserId || null,
        chatId: String(chatId),
        at: now(),
        // Which peer agent sent this, when one did. Only used to COUNT refusals; it never makes anyone an actor.
        peerSource: peerSourceAssistantId == null || peerSourceAssistantId === '' ? null : String(peerSourceAssistantId),
      }
      deliveries.set(token, delivery)
      while (deliveries.size > 64) deliveries.delete(deliveries.keys().next().value)
      // Even an unattributed delivery has a fresh token, so it cannot inherit a prior actor.
      // The CLI can inject this card MID turn with no new prompt. Unless it is the
      // same verified person in the same chat, nobody may act until the next
      // prompt admits a single actor again, and the newcomer is never bound here.
      const bound = active ?? pending
      if (bound && (!delivery.actingUserId || delivery.actingUserId !== bound.actingUserId || delivery.chatId !== bound.chatId)) {
        pending = null
        active = null
        try { onRevoke() } catch { /* The tracker is already closed; publishing is best effort. */ }
      }
      return `${content}\n<hoai-private-turn id="${token}"/>`
    },
    /**
     * promptHash is the forwarder's hash of a prompt it clipped down to its tokens. promptId is the CLI's
     * prompt_id: one per submission, the same for every hook of it.
     * @param {{ prompt: unknown, sessionId: unknown, promptHash?: unknown, promptId?: unknown }} turn
     */
    begin({ prompt, sessionId, promptHash, promptId }) {
      const matches = [...String(prompt ?? '').matchAll(TOKEN_PATTERN)]
      const hash = typeof promptHash === 'string' && /^[a-f0-9]{64}$/.test(promptHash) ? promptHash : privatePromptHash(prompt)
      const submission = typeof promptId === 'string' ? promptId.trim().slice(0, 128) : ''
      const boundary = `${String(sessionId)}\n${hash}\n${submission}`
      // The same submission recorded again: what its first record decided stands, and its spent token cannot be
      // looked up twice. Without this the second record cleared the turn and found no delivery: the wake's
      // boards_query refused although begin() had opened the owner's turn. The same words submitted again carry
      // another prompt_id and are a new prompt, as is anything with no token or no prompt_id.
      const recorded = matches.length > 0 && submission !== ''
      if (recorded && begun.has(boundary)) {
        try { onRepeat({ kind: 'prompt', sessionId: String(sessionId) }) } catch { /* A log line is best effort. */ }
        return
      }
      active = null
      pending = null
      peerPending = null
      if (recorded) {
        begun.add(boundary)
        while (begun.size > 64) begun.delete(begun.values().next().value)
      }
      if (matches.length !== 1) return
      const token = matches[0][1]
      const delivered = deliveries.get(token)
      deliveries.delete(token)
      if (delivered && delivered.peerSource && !delivered.actingUserId && now() - delivered.at <= PRIVATE_TURN_MAX_AGE_MS) {
        peerPending = { sourceAssistantId: delivered.peerSource, chatId: delivered.chatId }
      }
      if (!delivered || !delivered.actingUserId || now() - delivered.at > PRIVATE_TURN_MAX_AGE_MS) return
      pending = { ...delivered, sessionId: String(sessionId), promptHash: hash, promptId: submission }
    },
    current({ markerPaths }) {
      if (!pending) return null
      if (!active) {
        for (const markerPath of markerPaths) {
          const marker = readPrivateJson(markerPath, 2048)
          if (marker?.schemaVersion === 1 && marker.live === true && marker.sessionId === pending.sessionId &&
              marker.promptHash === pending.promptHash && typeof marker.turnId === 'string' && marker.turnId) {
            active = { ...pending, markerPath, turnId: marker.turnId }
            break
          }
        }
      }
      if (!active) return null
      const marker = readPrivateJson(active.markerPath, 2048)
      if (marker?.live !== true || marker.sessionId !== active.sessionId || marker.promptHash !== active.promptHash ||
          typeof marker.turnId !== 'string' || !marker.turnId) return null
      // Still live for this very submission in this session, but stamped again: a second run of the private turn
      // hook for the same boundary (a second hook source) mints its own turnId. It is the same turn under a new
      // name, so follow it; dropping it refused the turn that had just been adopted. Only the same prompt_id is the
      // same submission: the same words submitted again (after an interrupt, no Stop) end the turn as before, and
      // so does another prompt, another session or a closed marker.
      if (marker.turnId !== active.turnId) {
        if (!active.promptId || marker.promptId !== active.promptId) return null
        try { onRepeat({ kind: 'restamp', from: active.turnId, to: marker.turnId }) } catch { /* A log line is best effort. */ }
        active = { ...active, turnId: marker.turnId }
      }
      return { ...active }
    },
    /** The peer agent whose request this turn is, or null (a human turn, a scheduler card, no turn). Counting only. */
    peerTurn() { return peerPending ? { ...peerPending } : null },
    end() { pending = null; active = null; peerPending = null },
  }
}

export function publishPrivateContext({ path, secret, assistantId, ownerUserId, claudePid, pid = process.pid, turn, now = Date.now() }) {
  const context = {
    schemaVersion: 1, assistantId: String(assistantId), ownerUserId,
    actingUserId: turn?.actingUserId ?? null, chatId: turn?.chatId ?? null,
    turnId: turn?.turnId ?? null, sessionId: turn?.sessionId ?? null,
    markerPath: turn?.markerPath ?? null, promptHash: turn?.promptHash ?? null,
    claudePid, pid, updatedAt: now, live: Boolean(turn && claudePid),
  }
  const signature = createHmac('sha256', secret).update(JSON.stringify(context)).digest('hex')
  writePrivateJson(path, { context, signature })
  // This receipt only lets the synchronous hook finish sooner. Tool readers
  // still verify the signed per-agent context and the current marker.
  if (turn) writePrivateJson(`${turn.markerPath}.ready`, { turnId: turn.turnId, sessionId: turn.sessionId })
  return context
}

export function requirePrivateTurn(tracker, markerPaths, ownerUserId) {
  const turn = tracker.current({ markerPaths })
  if (!turn) throw new Error('This private action did not start because its current sender could not be verified. Send a new message in your HOAI chat and try again.')
  return { ...turn, headers: turn.actingUserId === ownerUserId ? {} : { 'X-BGOS-Acting-User': turn.actingUserId } }
}
