import type { StreamMessageView } from './stream-apply.ts'

type Entry = {
  view: StreamMessageView
  generation: number
  time: number | null
  revision: number | null
  meta?: Record<string, string>
  tail: Promise<unknown>
}

export function humanEditTime(view: StreamMessageView): number | null {
  const raw = view.raw
  const value = raw.editedAt ?? raw.edited_at ?? raw.updatedAt ?? raw.updated_at
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) ? time : null
}

function editRevision(view: StreamMessageView): number | null {
  const value = view.raw.revision
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** Only human text is revised here. Machine, peer and command routing stays separate. */
function isHuman(view: StreamMessageView): boolean {
  return view.senderKind === 'user' && !view.agentOrigin && !view.eventMetaRaw &&
    view.raw.senderAssistantId == null && view.raw.sender_assistant_id == null
}

/**
 * Text versions share one ledger across all delivery lanes. IDs still dedupe
 * original messages; this ledger only knows originals handed to the transport.
 * Per-message queues serialize a push racing a read, including failed handoffs.
 * Like the forwarded ID cache, this state is bounded and local to this daemon.
 */
export class HumanMessageEdits {
  private readonly entries = new Map<string, Entry>()
  private readonly pending = new Map<string, { view: StreamMessageView; generation: number }>()
  private readonly deletedIds = new Set<number>()
  private readonly deletedChats = new Set<string>()
  private generation = 0

  constructor(private readonly max = 100_000) {}

  private key(view: StreamMessageView): string { return `${view.chatId}:${view.messageId}` }

  get readGeneration(): number { return this.generation }

  has(view: StreamMessageView): boolean { return this.entries.has(this.key(view)) }

  isDeleted(view: Pick<StreamMessageView, 'chatId' | 'messageId'>): boolean {
    return this.deletedIds.has(view.messageId) || this.deletedChats.has(view.chatId)
  }

  isChatDeleted(chatId: string): boolean { return this.deletedChats.has(chatId) }

  deleteMessage(messageId: number): void {
    this.deletedIds.add(messageId)
    for (const [key, entry] of this.entries) if (entry.view.messageId === messageId) this.entries.delete(key)
    for (const [key, { view }] of this.pending) if (view.messageId === messageId) this.pending.delete(key)
  }

  deleteChat(chatId: string): void {
    this.deletedChats.add(chatId)
    for (const [key, entry] of this.entries) if (entry.view.chatId === chatId) this.entries.delete(key)
    for (const [key, { view }] of this.pending) if (view.chatId === chatId) this.pending.delete(key)
  }

  oldestInChat(chatId: string): number | undefined {
    let oldest: number | undefined
    for (const { view } of this.entries.values()) {
      if (view.chatId === chatId) oldest = Math.min(oldest ?? view.messageId, view.messageId)
    }
    return oldest
  }

  private bound<T>(map: Map<string, T>): void {
    while (map.size > this.max) map.delete(map.keys().next().value!)
  }

  notePending(view: StreamMessageView): void {
    if (this.isDeleted(view) || !isHuman(view) || this.has(view) || typeof view.raw.text !== 'string') return
    const key = this.key(view)
    const prior = this.pending.get(key)?.view
    const revision = editRevision(view)
    const priorRevision = prior ? editRevision(prior) : null
    if (revision !== null && priorRevision !== null && priorRevision >= revision) return
    if (prior && (humanEditTime(prior) ?? -Infinity) > (humanEditTime(view) ?? Infinity)) return
    this.pending.set(key, { view, generation: ++this.generation })
    this.bound(this.pending)
  }

  latest(view: StreamMessageView, readGeneration?: number): StreamMessageView {
    const held = this.pending.get(this.key(view))
    const pending = held?.view
    if (!pending || !isHuman(view)) return view
    const revision = editRevision(view)
    const pendingRevision = editRevision(pending)
    const time = humanEditTime(pending)
    const currentTime = humanEditTime(view)
    if (revision !== null && pendingRevision !== null) {
      if (revision >= pendingRevision) return view
    } else if (time !== null && currentTime !== null) {
      if (currentTime >= time) return view
    } else if (readGeneration !== undefined && held!.generation <= readGeneration) {
      // This authoritative read started after the unversioned pending frame.
      return view
    }
    return { ...view, text: pending.text, raw: { ...view.raw, text: pending.text, ...(time !== null ? { editedAt: time } : {}), ...(pendingRevision !== null ? { revision: pendingRevision } : {}) } }
  }

  requiresOriginalRead(view: StreamMessageView): boolean {
    const pending = this.pending.get(this.key(view))?.view
    if (!pending || pending.text === view.text || this.isDeleted(view)) return false
    if (editRevision(view) !== null && editRevision(pending) !== null) return false
    return humanEditTime(view) === null || humanEditTime(pending) === null
  }

  async resolveOriginal(view: StreamMessageView, reconcile: (view: StreamMessageView) => Promise<StreamMessageView | null>): Promise<StreamMessageView | null> {
    while (this.requiresOriginalRead(view)) {
      const held = this.pending.get(this.key(view))
      const current = await reconcile(view)
      if (this.isDeleted(view) || !current || current.messageId !== view.messageId || current.chatId !== view.chatId || !isHuman(current)) return null
      const time = humanEditTime(current)
      const revision = editRevision(current)
      view = { ...view, text: current.text, raw: { ...view.raw, text: current.text, ...(time !== null ? { editedAt: time } : {}), ...(revision !== null ? { revision } : {}) } }
      if (this.pending.get(this.key(view)) === held) {
        this.pending.delete(this.key(view))
        return view
      }
    }
    return this.isDeleted(view) ? null : this.latest(view)
  }

  rememberOriginal(view: StreamMessageView | null, handoff: Promise<unknown>, meta?: Record<string, string>): void {
    if (!view || this.isDeleted(view) || !isHuman(view) || this.has(view)) return
    const key = this.key(view)
    const entry: Entry = { view, generation: ++this.generation, time: humanEditTime(view), revision: editRevision(view), tail: handoff, meta }
    this.entries.set(key, entry)
    this.bound(this.entries)
    void handoff.then(() => this.pending.delete(key), () => {
      if (this.entries.get(key) === entry) this.entries.delete(key)
    })
  }

  async deliverEdit(
    view: StreamMessageView,
    deliver: (view: StreamMessageView, meta?: Record<string, string>) => Promise<void>,
    readGeneration = Infinity,
    reconcile?: (view: StreamMessageView) => Promise<StreamMessageView | null>,
  ): Promise<boolean> {
    const key = this.key(view)
    const entry = this.entries.get(key)
    if (!entry || this.isDeleted(view) || !isHuman(view) || typeof view.raw.text !== 'string') return false
    const result = entry.tail.then(async () => {
      if (this.entries.get(key) !== entry || entry.generation > readGeneration) return false
      // Unversioned text and timestamp collisions can be replays or genuine edits.
      // Only an unconditional authoritative read can distinguish those cases.
      const incomingTime = humanEditTime(view)
      const incomingRevision = editRevision(view)
      const ambiguousTime = incomingTime !== null && incomingTime === entry.time &&
        (incomingRevision === null || entry.revision === null)
      if (view.text !== entry.view.text && ((incomingTime === null && incomingRevision === null) || ambiguousTime)) {
        const current = await reconcile?.(view)
        if (!current || current.chatId !== view.chatId || current.messageId !== view.messageId || !isHuman(current)) return false
        view = current
      }
      if (this.entries.get(key) !== entry || entry.generation > readGeneration) return false
      const time = humanEditTime(view)
      const revision = editRevision(view)
      if (revision !== null && entry.revision !== null && revision < entry.revision) return false
      if (revision !== null && revision === entry.revision && view.text !== entry.view.text) return false
      if (time !== null && entry.time !== null && time < entry.time) return false
      if (view.text === entry.view.text) {
        if (time !== null && (entry.time === null || time > entry.time)) {
          entry.time = time
          entry.generation = ++this.generation
        }
        if (revision !== null) entry.revision = revision
        return false
      }
      // Keep the original author: an edit event's envelope is not a new sender.
      const edited = { ...entry.view, text: view.text, raw: { ...entry.view.raw, text: view.text, ...(time !== null ? { editedAt: time } : {}), ...(revision !== null ? { revision } : {}) } }
      await deliver(edited, entry.meta)
      if (this.isDeleted(view) || this.entries.get(key) !== entry) return false
      entry.view = edited
      entry.generation = ++this.generation
      if (time !== null) entry.time = time
      if (revision !== null) entry.revision = revision
      return true
    })
    // A failed edit is retryable and must not poison the queue.
    entry.tail = result.catch(() => undefined)
    return result
  }

}
