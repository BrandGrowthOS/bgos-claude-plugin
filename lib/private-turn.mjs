import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const TOKEN_PATTERN = /<hoai-private-turn id="([a-f0-9-]{36})"\/>/g
export const PRIVATE_TURN_MAX_AGE_MS = 15 * 60_000
export const privatePromptHash = (prompt) => createHash('sha256').update(String(prompt ?? '')).digest('hex')
export const privateMarkerPath = (root, key) => join(root, 'private-turn', `${key}.json`)
/**
 * Why the private turn hook wrote no marker for a session's last prompt (0.68.4), beside the markers and named by the
 * session, never by a floor key: the hook writes it exactly when it found no key of its own daemon to write under.
 */
export const privateUnservedPath = (root, sessionId) => join(root, 'private-turn', 'unserved', `${sessionId}.json`)
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

/** Why a prompt that carried a delivery token opens no private turn, in the daemon's words. */
const BEGIN_REASONS = {
  'no-token': 'it carries no delivery token',
  ambiguous: 'it carries more than one delivery token',
  'unknown-token': 'its token is not one this daemon delivered, or it was already used',
  expired: 'its delivery is older than 15 minutes',
  peer: 'it is a peer agent\'s message',
  // A system card names a sender only as a scheduler event carrying eventMeta.payload.actingUserId (privateActor):
  // the n8n Agent Scheduler's reminder carries none (Vera, 2026-10-12 22:51Z).
  'no-actor': 'its delivery names no verified sender: neither a person\'s own message with their user_ id nor a scheduler event carrying eventMeta.payload.actingUserId',
}

/**
 * The daemon's line for what begin() decided about one prompt (Vera, 2026-10-12: a wake opened no turn and
 * nothing said why). One line per prompt that carried a delivery token.
 * @param {string} outcome begin()'s return value
 * @param {string} sessionId
 */
export function privateBeginLine(outcome, sessionId) {
  return outcome === 'opened'
    ? `private turn: the prompt in session ${sessionId} admitted its sender; the turn is usable once its marker matches`
    : `private turn: the prompt in session ${sessionId} opens no private turn: ${BEGIN_REASONS[outcome] ?? outcome}`
}

/**
 * The daemon's line when a card delivered mid turn ends the private turn (deliver(), revoke): before this it
 * ended silently, and a refusal after it read like any other.
 * @param {{ chatId?: string, why?: string }} info
 */
export function privateRevokeLine(info) {
  return `private turn: ${revokedBy(info)} ended the private turn; nobody may act until the next prompt`
}

const REVOKE_SENDERS = {
  'a peer agent': 'from a peer agent',
  'no verified sender': 'with no verified sender',
  'another person': 'from another person',
  'another chat': 'from the same person in another chat',
}

/** "a delivery from a peer agent (chat 1132)": which delivery ended a turn. */
const revokedBy = (info) => `a delivery ${REVOKE_SENDERS[info?.why] ?? 'from someone else'} (chat ${info?.chatId ?? '?'})`

/** A field read from a marker file, made safe for one log line. */
const logField = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, max)

/**
 * What the private turn hook left when it wrote no marker for this prompt, as a clause of the refusal line, or ''.
 * The note sits beside the markers (privateUnservedPath); a note of another submission of the session is not this
 * prompt's.
 */
function unservedNote(markerPaths, pending) {
  if (!markerPaths.length || !/^[A-Za-z0-9_-]{1,128}$/.test(pending.sessionId)) return ''
  const note = readPrivateJson(join(dirname(markerPaths[0]), 'unserved', `${pending.sessionId}.json`), 2048)
  if (!note || note.sessionId !== pending.sessionId || typeof note.why !== 'string' || typeof note.at !== 'number') return ''
  if (pending.promptId && typeof note.promptId === 'string' && note.promptId !== pending.promptId) return ''
  const at = new Date(note.at)
  const when = Number.isNaN(at.getTime()) ? '?' : `${at.toISOString().slice(11, 19)}Z`
  return `; the private turn hook of session ${logField(pending.sessionId, 64)} wrote no marker at ${when}: ${logField(note.why, 1024)}`
}

/**
 * Opaque delivery identity is separate from the activity rail's text matching.
 * @param {{ now?: () => number, randomId?: () => string, onRevoke?: (info: { chatId: string, why: string }) => void,
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
  /** What the last begin() decided, so a refused call can say it (explain). */
  let lastBegin = null
  /** How the turn that last begin() opened was closed, if it was. */
  let lastClear = null
  /** @returns {'opened' | 'repeat' | 'no-token' | 'ambiguous' | 'unknown-token' | 'expired' | 'peer' | 'no-actor'} */
  function beginTurn({ prompt, sessionId, promptHash, promptId }) {
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
      return 'repeat'
    }
    active = null
    pending = null
    peerPending = null
    if (recorded) {
      begun.add(boundary)
      while (begun.size > 64) begun.delete(begun.values().next().value)
    }
    if (matches.length !== 1) return matches.length === 0 ? 'no-token' : 'ambiguous'
    const token = matches[0][1]
    const delivered = deliveries.get(token)
    deliveries.delete(token)
    if (delivered && delivered.peerSource && !delivered.actingUserId && now() - delivered.at <= PRIVATE_TURN_MAX_AGE_MS) {
      peerPending = { sourceAssistantId: delivered.peerSource, chatId: delivered.chatId }
    }
    if (!delivered) return 'unknown-token'
    if (now() - delivered.at > PRIVATE_TURN_MAX_AGE_MS) return 'expired'
    if (!delivered.actingUserId) return delivered.peerSource ? 'peer' : 'no-actor'
    pending = { ...delivered, sessionId: String(sessionId), promptHash: hash, promptId: submission }
    return 'opened'
  }

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
        const why = !delivery.actingUserId ? (delivery.peerSource ? 'a peer agent' : 'no verified sender')
          : delivery.actingUserId !== bound.actingUserId ? 'another person' : 'another chat'
        lastClear = { kind: 'revoked', why, chatId: delivery.chatId }
        try { onRevoke({ chatId: delivery.chatId, why }) } catch { /* The tracker is already closed; publishing is best effort. */ }
      }
      return `${content}\n<hoai-private-turn id="${token}"/>`
    },
    /**
     * promptHash is the forwarder's hash of a prompt it clipped down to its tokens. promptId is the CLI's
     * prompt_id: one per submission, the same for every hook of it.
     * @param {{ prompt: unknown, sessionId: unknown, promptHash?: unknown, promptId?: unknown }} turn
     * @returns {'opened' | 'repeat' | 'no-token' | 'ambiguous' | 'unknown-token' | 'expired' | 'peer' | 'no-actor'}
     */
    begin(turn) {
      const outcome = beginTurn(turn)
      if (outcome !== 'repeat') {
        lastBegin = { outcome, sessionId: String(turn?.sessionId) }
        lastClear = null
      }
      return outcome
    },
    /**
     * Why current() has no turn to give right now, marker by marker. For the daemon's log when it refuses a
     * private call: the check that failed is otherwise invisible.
     * @param {{ markerPaths: string[] }} input
     */
    explain({ markerPaths }) {
      if (!pending) {
        const last = lastBegin ? `the last prompt, in session ${lastBegin.sessionId}: ${lastBegin.outcome}` : 'no prompt since this daemon started'
        const closed = !lastClear ? '' : lastClear.kind === 'ended' ? '; its turn then ended (Stop or SessionEnd)'
          : `; its turn was then revoked by ${revokedBy(lastClear)}`
        return `no private turn is open (${last}${closed})`
      }
      const same = (value, wanted, max) => (value === wanted ? 'same' : logField(value, max) || '-')
      const describe = (markerPath, marker) => {
        const name = logField(String(markerPath).split(/[\\/]/).pop(), 64)
        if (!marker) return `${name} absent`
        const schema = marker.schemaVersion === 1 ? '' : ` schema=${logField(marker.schemaVersion, 8)}`
        return `${name} live=${marker.live === true} session=${same(marker.sessionId, pending.sessionId, 12)} prompt=${same(marker.promptHash, pending.promptHash, 12)}${schema}`
      }
      const head = `admitted ${logField(pending.actingUserId, 64)} (session ${logField(pending.sessionId, 64)}, prompt ${pending.promptHash.slice(0, 12)})`
      if (active) {
        // Once a turn is adopted only its own file counts: say what changed in it.
        const marker = readPrivateJson(active.markerPath, 2048)
        const turn = marker ? ` turn=${marker.turnId === active.turnId ? 'same' : 'other'} promptId=${marker.promptId === undefined ? 'absent' : same(marker.promptId, active.promptId, 12)}` : ''
        return `${head}, adopted ${logField(String(active.markerPath).split(/[\\/]/).pop(), 64)} as turn ${logField(active.turnId, 8)}, but it no longer matches: ${describe(active.markerPath, marker)}${turn} (other files are not read again once a turn is adopted)`
      }
      const seen = markerPaths.map((markerPath) => {
        const marker = readPrivateJson(markerPath, 2048)
        return marker ? `${describe(markerPath, marker)} turn=${logField(marker.turnId, 8)}` : describe(markerPath, null)
      })
      return `${head}, waiting for its marker; none of the files this daemon reads matches: ${seen.join('; ')}${unservedNote(markerPaths, pending)}`
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
    end() {
      if (pending) lastClear = { kind: 'ended' }
      pending = null; active = null; peerPending = null
    },
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
