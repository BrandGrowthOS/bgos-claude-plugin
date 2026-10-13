import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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

/**
 * A scheduled fire is handled once (0.68.6). Delivery is at least once: after a restart the poll lane's restart
 * recovery re-offers a wake the agent already answered (lib/poll-core.ts selectRestartRecoveryIds), as backlog, with a
 * new delivery token and a new 15 minute window, and the tracker is per process. On Vera (2026-10-13) two old native
 * wakes were each admitted as a fresh private turn that way. So each agent keeps, in its own state folder, the fires it
 * opened a private turn for, for 48 hours (twice the 24 hour recovery window): a fire seen again still reaches the
 * agent as text, but opens no private turn.
 */
export const PRIVATE_FIRE_KEEP_MS = 48 * 3600_000
/** At most this many fires are kept; the oldest go first. */
export const PRIVATE_FIRE_MAX = 1000
export const privateFiresPath = (root, assistantId) => join(root, String(assistantId), 'private-fires.json')

/**
 * The fire a delivery carries, or null. A native wake (the backend's fireWake) is its eventMeta.payload.fireId; an
 * n8n Agent Scheduler card has no fire id, so it is its scheduled_action_id with the card's message id (each
 * recurrence is a new card); any other scheduler card is its message id, which restart recovery re-offers unchanged.
 * Only a scheduler system card has one, the same cards privateActor takes an actor from.
 * @param {{ senderType?: unknown, eventMeta?: any, messageId?: unknown }} [delivery]
 */
export function privateFireKey({ senderType, eventMeta, messageId } = {}) {
  if (String(senderType).toLowerCase() !== 'system' || eventMeta?.source !== 'scheduler') return null
  const payload = eventMeta.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const text = (value) => {
    const spelled = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : ''
    return spelled.length > 0 && spelled.length <= 256 ? spelled : ''
  }
  const fire = text(payload.fireId)
  if (fire) return `native:${fire}`
  const id = typeof messageId === 'number' || typeof messageId === 'string' ? Number(messageId) : NaN
  if (!Number.isSafeInteger(id) || id <= 0) return null
  const action = text(payload.scheduled_action_id)
  return action ? `n8n:${action}:${id}` : `scheduler:${id}`
}

/**
 * The fires one agent handled: `{ v: 1, fires: { <key>: <handled at ms> } }` at `path`. Read on every check, so a
 * key the previous daemon life (or the agent's other daemon, at a handover) wrote is seen; merged, pruned (48 hours,
 * newest PRIVATE_FIRE_MAX) and written atomically on every record, once more after a short pause if the first write
 * fails (a Windows rename can fail while a scanner holds the file). A missing or junk file is empty. record() answers
 * whether the key is on disk; it never throws.
 * @param {{ path: string, now?: () => number, keepMs?: number, max?: number }} options
 */
export function createFireLedger({ path, now = Date.now, keepMs = PRIVATE_FIRE_KEEP_MS, max = PRIVATE_FIRE_MAX }) {
  const write = (value) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
      renameSync(tmp, path)
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* Never written. */ }
      throw err
    }
  }
  const load = () => {
    const raw = readPrivateJson(path, 1048576)
    const fires = raw?.v === 1 && raw.fires && typeof raw.fires === 'object' && !Array.isArray(raw.fires) ? raw.fires : {}
    const cutoff = now() - keepMs
    return Object.entries(fires).filter(([, at]) => typeof at === 'number' && Number.isFinite(at) && at > cutoff)
  }
  return {
    /** When this fire was handled, or null. */
    handledAt(key) {
      const found = load().find(([candidate]) => candidate === key)
      return found ? found[1] : null
    },
    /** Record the fire as handled now; false when it could not be written. */
    record(key) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
        try {
          const kept = load().filter(([candidate]) => candidate !== key)
          kept.push([key, now()])
          kept.sort((a, b) => a[1] - b[1])
          write({ v: 1, fires: Object.fromEntries(kept.slice(-max)) })
          return true
        } catch {
          // Tried once more, then false.
        }
      }
      return false
    },
  }
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
 * The daemon's line for a scheduled fire delivered again after it was handled (0.68.6): one per replayed prompt.
 * @param {{ key?: string, handledAt?: number }} replay
 */
export function privateReplayLine(replay) {
  const at = new Date(Number(replay?.handledAt))
  return `private turn: replayed fire ${logField(replay?.key, 300)}, already handled at ${Number.isNaN(at.getTime()) ? '?' : at.toISOString()}`
}

/** Why a prompt that carried a delivery token opens no private turn, in the daemon's words. */
const BEGIN_REASONS = {
  'no-token': 'it carries no delivery token',
  ambiguous: 'it carries more than one delivery token',
  'unknown-token': 'its token is not one this daemon delivered, or it was already used',
  expired: 'its delivery is older than 15 minutes',
  peer: 'it is a peer agent\'s message',
  replayed: 'its scheduled fire was already handled',
  'beside-replay': 'a replayed scheduled fire was delivered just before it, and the CLI may run it inside this turn',
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
  'a replayed fire': 'that replays a scheduled fire already handled',
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
 *   onRepeat?: (repeat: { kind: 'prompt' | 'restamp', sessionId?: string, from?: string, to?: string }) => void,
 *   fires?: { handledAt: (key: string) => number | null, record: (key: string) => boolean } | null,
 *   onReplay?: (replay: { key: string, handledAt: number, sessionId: string }) => void }} [options]
 */
export function createPrivateTurnTracker({ now = Date.now, randomId = randomUUID, onRevoke = () => {}, onRepeat = () => {}, fires = null, onReplay = () => {} } = {}) {
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
  // Scheduled fires delivered and not yet begun, token -> key (0.68.6). The CLI can inject a card into a turn that is
  // running, or that begins right after it, with no prompt of its own: its work is done in that turn, so it is
  // recorded as handled when the next prompt begins or the turn ends. Its own prompt, if it comes later, still opens:
  // whether a delivery is a replay is decided when it is delivered, never later.
  const heldFires = new Map()
  const recordHeld = () => {
    for (const key of heldFires.values()) if (fires) fires.record(key)
    heldFires.clear()
  }
  /** When a delivery of this fire is still in flight here (held, or its turn open), the first delivery's time. */
  const inFlightAt = (key) => {
    for (const [token, held] of heldFires) if (held === key) return deliveries.get(token)?.at ?? now()
    const bound = active ?? pending
    return bound?.fireKey === key ? bound.at : null
  }
  // Replays delivered while no turn was open (the boot poll's sweep comes before the hook intake starts), tokens. The
  // next prompt to begin may have one injected into its turn, so it opens none; it clears them (0.68.6).
  const heldReplays = new Set()
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
    // Every fire waiting but this prompt's own is handled: it was injected into a turn, or is about to be (0.68.6).
    // This prompt's own is recorded when its turn becomes usable (current). A replay waiting beside it may run in it.
    if (matches.length === 1) {
      heldFires.delete(matches[0][1])
      heldReplays.delete(matches[0][1])
    }
    recordHeld()
    const besideReplay = heldReplays.size > 0
    heldReplays.clear()
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
    if (besideReplay && delivered.replayedAt === undefined) return 'beside-replay'
    pending = { ...delivered, sessionId: String(sessionId), promptHash: hash, promptId: submission }
    return 'opened'
  }

  return {
    /**
     * @param {{ content: string, actingUserId?: string | null, chatId: string | number,
     *   peerSourceAssistantId?: string | number | null, fireKey?: string | null }} delivery
     */
    deliver({ content, actingUserId, chatId, peerSourceAssistantId = null, fireKey = null }) {
      const token = randomId()
      const delivery = {
        actingUserId: actingUserId || null,
        chatId: String(chatId),
        at: now(),
        // Which peer agent sent this, when one did. Only used to COUNT refusals; it never makes anyone an actor.
        peerSource: peerSourceAssistantId == null || peerSourceAssistantId === '' ? null : String(peerSourceAssistantId),
      }
      deliveries.set(token, delivery)
      // The scheduled fire this card is, if it is one (privateFireKey), opens a private turn once (0.68.6). One this
      // agent already handled is a replay from here on: it still reaches the agent as text, says so, opens no turn,
      // and ends a turn it is injected into.
      let note = ''
      if (typeof fireKey === 'string' && fireKey) {
        delivery.fireKey = fireKey
        // Handled: in the record, or a delivery of it still in flight here (the backend firing it again before the
        // first one's turn was recorded). One begun but never usable is neither, so its re-fire still gets a turn.
        const handledAt = (fires ? fires.handledAt(fireKey) : null) ?? inFlightAt(fireKey)
        if (handledAt !== null) {
          delivery.replayedAt = handledAt
          note = `[replayed: this scheduled fire was already handled at ${new Date(handledAt).toISOString()}; it opens no private turn]\n`
        } else {
          heldFires.set(token, fireKey)
        }
      }
      if (delivery.replayedAt !== undefined && !(active ?? pending)) heldReplays.add(token)
      while (deliveries.size > 64) {
        const oldest = deliveries.keys().next().value
        deliveries.delete(oldest)
        heldFires.delete(oldest)
        heldReplays.delete(oldest)
      }
      // Even an unattributed delivery has a fresh token, so it cannot inherit a prior actor.
      // The CLI can inject this card MID turn with no new prompt. Unless it is the
      // same verified person in the same chat, nobody may act until the next
      // prompt admits a single actor again, and the newcomer is never bound here.
      const bound = active ?? pending
      if (bound && (delivery.replayedAt !== undefined || !delivery.actingUserId || delivery.actingUserId !== bound.actingUserId || delivery.chatId !== bound.chatId)) {
        pending = null
        active = null
        const why = delivery.replayedAt !== undefined ? 'a replayed fire'
          : !delivery.actingUserId ? (delivery.peerSource ? 'a peer agent' : 'no verified sender')
            : delivery.actingUserId !== bound.actingUserId ? 'another person' : 'another chat'
        lastClear = { kind: 'revoked', why, chatId: delivery.chatId }
        try { onRevoke({ chatId: delivery.chatId, why }) } catch { /* The tracker is already closed; publishing is best effort. */ }
      }
      return `${note}${content}\n<hoai-private-turn id="${token}"/>`
    },
    /**
     * promptHash is the forwarder's hash of a prompt it clipped down to its tokens. promptId is the CLI's
     * prompt_id: one per submission, the same for every hook of it.
     * @param {{ prompt: unknown, sessionId: unknown, promptHash?: unknown, promptId?: unknown }} turn
     * @returns {'opened' | 'repeat' | 'no-token' | 'ambiguous' | 'unknown-token' | 'expired' | 'peer' | 'no-actor' | 'replayed' | 'beside-replay'}
     */
    begin(turn) {
      let outcome = beginTurn(turn)
      // A scheduled fire this agent already handled, as its delivery found it (0.68.6), opens no turn, whatever token
      // it came with. A new fire is recorded when its turn becomes usable (current), so one delivered but never begun
      // or never adopted before a restart still runs once.
      if (outcome === 'opened' && pending?.replayedAt !== undefined) {
        try { onReplay({ key: pending.fireKey, handledAt: pending.replayedAt, sessionId: String(turn?.sessionId) }) } catch { /* A log line is best effort. */ }
        pending = null
        outcome = 'replayed'
      }
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
      if (pending.fireUnrecorded) return `${head}, but its scheduled fire ${logField(pending.fireKey, 300)} could not be recorded as handled, so a later replay of it could not be told apart; no turn is usable`
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
        if (pending.fireUnrecorded) return null
        for (const markerPath of markerPaths) {
          const marker = readPrivateJson(markerPath, 2048)
          if (marker?.schemaVersion === 1 && marker.live === true && marker.sessionId === pending.sessionId &&
              marker.promptHash === pending.promptHash && typeof marker.turnId === 'string' && marker.turnId) {
            // Usable from here: its fire is handled now (0.68.6). One that cannot be recorded is not adopted, since a
            // replay of it could not be told apart (fail closed).
            if (pending.fireKey && fires && !pending.fireRecorded) {
              if (!fires.record(pending.fireKey)) {
                pending.fireUnrecorded = true
                return null
              }
              pending.fireRecorded = true
            }
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
      recordHeld()
      heldReplays.clear()
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
