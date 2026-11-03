import type { StreamMessageView } from './stream-apply.ts'

type Entry = {
  view: StreamMessageView
  generation: number
  time: number | null
  meta?: Record<string, string>
  tail: Promise<unknown>
}

function editTime(view: StreamMessageView): number | null {
  const raw = view.raw
  const value = raw.editedAt ?? raw.edited_at ?? raw.updatedAt ?? raw.updated_at
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) ? time : null
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
  private readonly pending = new Map<string, StreamMessageView>()
  private generation = 0

  constructor(private readonly max = 100_000) {}

  private key(view: StreamMessageView): string { return `${view.chatId}:${view.messageId}` }

  get readGeneration(): number { return this.generation }

  has(view: StreamMessageView): boolean { return this.entries.has(this.key(view)) }

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
    if (!isHuman(view) || this.has(view) || typeof view.raw.text !== 'string') return
    const key = this.key(view)
    const prior = this.pending.get(key)
    if (prior && (editTime(prior) ?? -Infinity) > (editTime(view) ?? Infinity)) return
    this.pending.set(key, view)
    this.bound(this.pending)
  }

  latest(view: StreamMessageView): StreamMessageView {
    const pending = this.pending.get(this.key(view))
    if (!pending || !isHuman(view) || (editTime(view) ?? -Infinity) > (editTime(pending) ?? Infinity)) return view
    const time = editTime(pending)
    return { ...view, text: pending.text, raw: { ...view.raw, text: pending.text, ...(time !== null ? { editedAt: time } : {}) } }
  }

  rememberOriginal(view: StreamMessageView | null, handoff: Promise<unknown>, meta?: Record<string, string>): void {
    if (!view || !isHuman(view) || this.has(view)) return
    const key = this.key(view)
    const entry: Entry = { view, generation: ++this.generation, time: editTime(view), tail: handoff, meta }
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
  ): Promise<boolean> {
    const key = this.key(view)
    const entry = this.entries.get(key)
    if (!entry || !isHuman(view) || typeof view.raw.text !== 'string') return false
    const result = entry.tail.then(async () => {
      if (this.entries.get(key) !== entry || entry.generation > readGeneration) return false
      const time = editTime(view)
      if (time !== null && entry.time !== null && time < entry.time) return false
      if (view.text === entry.view.text) {
        if (time !== null && (entry.time === null || time > entry.time)) {
          entry.time = time
          entry.generation = ++this.generation
        }
        return false
      }
      // Keep the original author: an edit event's envelope is not a new sender.
      const edited = { ...entry.view, text: view.text, raw: { ...entry.view.raw, text: view.text, ...(time !== null ? { editedAt: time } : {}) } }
      await deliver(edited, entry.meta)
      entry.view = edited
      entry.generation = ++this.generation
      if (time !== null) entry.time = time
      return true
    })
    // A failed edit is retryable and must not poison the queue.
    entry.tail = result.catch(() => undefined)
    return result
  }

}
