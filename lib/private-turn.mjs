import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const TOKEN_PATTERN = /<hoai-private-turn id="([a-f0-9-]{36})"\/>/g
export const PRIVATE_TURN_MAX_AGE_MS = 15 * 60_000
export const privatePromptHash = (prompt) => createHash('sha256').update(String(prompt ?? '')).digest('hex')
export const privateMarkerPath = (root, key) => join(root, 'private-turn', `${key}.json`)
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

/** Opaque delivery identity is separate from the activity rail's text matching. */
export function createPrivateTurnTracker({ now = Date.now, randomId = randomUUID } = {}) {
  const deliveries = new Map()
  let pending = null
  let active = null
  return {
    deliver({ content, actingUserId, chatId }) {
      const token = randomId()
      deliveries.set(token, { actingUserId: actingUserId || null, chatId: String(chatId), at: now() })
      while (deliveries.size > 64) deliveries.delete(deliveries.keys().next().value)
      // Even an unattributed delivery has a fresh token, so it cannot inherit a prior actor.
      return `${content}\n<hoai-private-turn id="${token}"/>`
    },
    begin({ prompt, sessionId }) {
      active = null
      pending = null
      const matches = [...String(prompt ?? '').matchAll(TOKEN_PATTERN)]
      if (matches.length !== 1) return
      const token = matches[0][1]
      const delivered = deliveries.get(token)
      deliveries.delete(token)
      if (!delivered || !delivered.actingUserId || now() - delivered.at > PRIVATE_TURN_MAX_AGE_MS) return
      pending = { ...delivered, sessionId: String(sessionId), promptHash: privatePromptHash(prompt) }
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
      if (marker?.live !== true || marker.turnId !== active.turnId || marker.sessionId !== active.sessionId || marker.promptHash !== active.promptHash) return null
      return { ...active }
    },
    end() { pending = null; active = null },
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
