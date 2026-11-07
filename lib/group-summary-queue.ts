/**
 * Group pause summaries for the MAIN session (group threads, spec section 4
 * and risk 3).
 *
 * The server's Group summary card in the owner's main chat is an app only
 * card: no agent read returns it, so it wakes nobody. The main agent still
 * has to know what happened in its groups, so the daemon, which drafted each
 * pause summary itself (lib/group-lanes.ts), keeps them here and puts them in
 * front of the main session's NEXT turn as context. Never as a turn of its
 * own: nothing here sends anything, it only rides along with a card that is
 * going out anyway.
 *
 * Kept on disk with the daemon's other state, so a restart keeps them, at
 * most GROUP_SUMMARY_QUEUE_MAX (the oldest go first), and cleared once
 * handed over. A card that fails to go out puts its summaries back.
 *
 * Every effect is injected; unit tested in test/group-summary-queue.test.ts.
 * Erasable TypeScript only.
 */

export const GROUP_SUMMARY_QUEUE_MAX = 10

export interface QueuedGroupSummary {
  chatId: string
  title: string
  summary: string
}

export interface GroupSummaryQueueFs {
  readFile(path: string): string
  writeFile(path: string, data: string): void
  mkdir(path: string): void
  unlink(path: string): void
}

/** The framing line before one group's summary, exactly as the main agent reads it. */
export function groupSummaryHeader(title: string): string {
  const t = String(title ?? '').replace(/[\r\n\u2028\u2029"]+/g, ' ').replace(/\s+/g, ' ').trim() || 'a group'
  return `From the group "${t}" (this is from the group "${t}"; do not repeat it outside "${t}" unless your owner asks):`
}

/** The block put before the main session's next card: each summary under its framing line. */
export function groupSummaryPrefix(items: readonly QueuedGroupSummary[]): string {
  return items.map((item) => `${groupSummaryHeader(item.title)}\n${item.summary.trim()}`).join('\n\n')
}

/** The card's content with the summaries in front of it. */
export function withGroupSummaries(content: string, items: readonly QueuedGroupSummary[]): string {
  if (items.length === 0) return content
  return `${groupSummaryPrefix(items)}\n\n${content}`
}

export interface GroupSummaryQueue {
  add(item: QueuedGroupSummary): void
  size(): number
  /** Take every queued summary for one card. restore() puts them back in front when the card did not go out. */
  take(): { items: QueuedGroupSummary[]; restore(): void } | null
}

export function createGroupSummaryQueue(opts: {
  path: string
  dir: string
  fs: GroupSummaryQueueFs
  max?: number
  log?(msg: string): void
}): GroupSummaryQueue {
  const max = opts.max ?? GROUP_SUMMARY_QUEUE_MAX
  let items: QueuedGroupSummary[] = read()

  function read(): QueuedGroupSummary[] {
    let raw: unknown
    try {
      raw = JSON.parse(opts.fs.readFile(opts.path))
    } catch {
      return []
    }
    if (!Array.isArray(raw)) return []
    const out: QueuedGroupSummary[] = []
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue
      const x = r as Record<string, unknown>
      if (typeof x.summary !== 'string' || x.summary.trim() === '') continue
      out.push({ chatId: String(x.chatId ?? ''), title: typeof x.title === 'string' ? x.title : '', summary: x.summary })
    }
    return out.slice(-max)
  }

  function save(): void {
    try {
      if (items.length === 0) {
        try {
          opts.fs.unlink(opts.path)
        } catch {}
        return
      }
      opts.fs.mkdir(opts.dir)
      opts.fs.writeFile(opts.path, `${JSON.stringify(items)}\n`)
    } catch (err) {
      opts.log?.(`groups: could not save the group summaries for the main session (${err instanceof Error ? err.name : 'error'})`)
    }
  }

  return {
    add(item) {
      if (!item || typeof item.summary !== 'string' || item.summary.trim() === '') return
      items.push({ chatId: String(item.chatId), title: String(item.title ?? ''), summary: item.summary })
      if (items.length > max) items = items.slice(-max)
      save()
    },
    size() {
      return items.length
    },
    take() {
      if (items.length === 0) return null
      const taken = items
      items = []
      save()
      return {
        items: taken,
        restore() {
          items = [...taken, ...items].slice(-max)
          save()
        },
      }
    },
  }
}
