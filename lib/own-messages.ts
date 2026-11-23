/**
 * The messages this agent sent, as the server answered when the daemon created them. edit_message edits only these.
 *
 * WHY THIS EXISTS (round 2 of the edit_message fix, review F1). edit_message edits through
 * PATCH /api/v1/messages/:id with this daemon's credential, which is the OWNER's. The backend admits any row the owner
 * may edit: in a main chat that is every row of every chat of every agent the owner has, the owner's own lines
 * included, and in a room or channel the owner's own lines that other members read. The model routinely sees the
 * owner's message ids (an inbound message's meta, the reply overdue notice), so one mistaken or asked for call would
 * rewrite the owner's words in place, shown as theirs. The backend refuses a pairing that POSTs a `sender='user'` row,
 * but a PATCH has no matching gate yet, and there is no read of one row by id to check the sender first.
 *
 * So the daemon keeps the ids the SERVER named as this agent's own rows in its answer to the create
 * (POST /send-message answers `{message: row}`, POST /messages answers the row): `sender` is `'assistant'`, and
 * `senderAssistantId` is absent or this agent's id. Null there is an agent's ordinary row in its own chat (the server
 * sets it for meeting turns and A2A rows); any other id is another agent's. The record is per agent, beside the chat
 * cursors, bounded, and survives a restart, so the agent can still edit a reply it sent before the daemon restarted.
 * A message sent before this record existed is refused, which is the safe direction.
 *
 * Writes are atomic (temp file and rename) and never throw; a failed write keeps the id in memory and logs once.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const OWN_MESSAGES_FILE_NAME = 'own-messages.json'

/** How many ids are kept. The newest win; an agent edits recent messages. */
export const OWN_MESSAGES_LIMIT = 5000

/** The two routes whose answer is the row the daemon just created. */
const CREATE_PATHS = new Set(['messages', 'send-message'])

/** A message id as the backend writes it: a positive integer that fits a bigint. */
const ID_RE = /^[1-9]\d{0,17}$/

/** The refusal edit_message answers for any other id. One line. */
export function ownMessageRefusal(id: string): string {
  return `Error: edit_message edits only a message this agent sent, and message ${id} is not one of them, so nothing was changed`
}

/** The record's file: per agent, beside chat-cursors.json (lib/cursor-store.ts). */
export function ownMessagesFilePath(cursorFilePath: string): string {
  return join(dirname(cursorFilePath), OWN_MESSAGES_FILE_NAME)
}

function idOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null
  if (typeof value === 'string' && ID_RE.test(value.trim())) {
    const n = Number(value.trim())
    return Number.isSafeInteger(n) ? n : null
  }
  return null
}

/**
 * The id of the row a create answer names as this agent's own, or null. `assistantId` is this daemon's agent; when
 * the daemon has none, only a row naming no other agent counts (the daemon's credential wrote it either way).
 */
export function ownMessageIdFromAnswer(answer: unknown, assistantId: unknown): number | null {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return null
  const wrapped = (answer as { message?: unknown }).message
  const row = (wrapped !== undefined ? wrapped : answer) as Record<string, unknown> | null
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null
  if (row.sender !== 'assistant') return null
  const id = idOf(row.id)
  if (id === null) return null
  const named = row.senderAssistantId
  if (named !== null && named !== undefined) {
    const mine = String(assistantId ?? '').trim()
    if (mine === '' || String(named).trim() !== mine) return null
  }
  return id
}

export class OwnMessages {
  private readonly ids = new Set<number>()
  private readonly filePath: string | null
  private readonly assistantId: unknown
  private readonly limit: number
  private readonly log: (line: string) => void

  constructor(opts: { filePath: string | null; assistantId: unknown; limit?: number; log?: (line: string) => void }) {
    this.filePath = opts.filePath
    this.assistantId = opts.assistantId
    this.limit = Math.max(1, Math.floor(opts.limit ?? OWN_MESSAGES_LIMIT))
    this.log = opts.log ?? (() => {})
    if (this.filePath) this.load(this.filePath)
  }

  get size(): number {
    return this.ids.size
  }

  /** Is this id a message this agent sent? Reads it as edit_message gets it: a number or a string, trimmed. */
  has(id: unknown): boolean {
    const n = idOf(id)
    return n !== null && this.ids.has(n)
  }

  /** Notes the row a create answered with, when it is this agent's own. Returns the id noted, or null. */
  note(answer: unknown): number | null {
    const id = ownMessageIdFromAnswer(answer, this.assistantId)
    if (id === null) return null
    this.ids.delete(id)
    this.ids.add(id)
    while (this.ids.size > this.limit) this.ids.delete(this.ids.values().next().value as number)
    this.save()
    return id
  }

  /** note(), only for an answer of one of the two create routes (`messages`, `send-message`). */
  noteCreate(path: string, answer: unknown): number | null {
    const route = String(path ?? '').replace(/^\/+/, '').split('?')[0]
    return CREATE_PATHS.has(route) ? this.note(answer) : null
  }

  private load(filePath: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch {
      return
    }
    const list = (parsed as { ids?: unknown } | null)?.ids
    if (!Array.isArray(list)) return
    for (const value of list.slice(-this.limit)) {
      const id = typeof value === 'number' ? idOf(value) : null
      if (id !== null) this.ids.add(id)
    }
  }

  private save(): void {
    if (!this.filePath) return
    const tmp = `${this.filePath}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(tmp, JSON.stringify({ v: 1, ids: [...this.ids] }), { mode: 0o600 })
      renameSync(tmp, this.filePath)
    } catch (err) {
      this.log(`own messages: could not save ${this.filePath} (kept in memory): ${String(err)}`)
    }
  }
}
