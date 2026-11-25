/**
 * THE CARDS THIS DAEMON POSTED THAT ARE STILL OPEN, KEPT ACROSS A RESTART.
 *
 * The poll announces a tap only when it saw the card unanswered on an earlier
 * poll, and the receipts of the cards this daemon posted (postedButtonCards in
 * server.ts) lived in memory. A restart between a question and its answer lost
 * the answer: the cursor, kept on disk, starts the next poll above the card, so
 * no read ever saw it again. This file keeps the open receipts so the next boot
 * can read each one once through the same exact read a live card uses.
 *
 * WHAT IT HOLDS, and nothing more: the card's id, its chat's id and when it was
 * posted. No text, no options, no answer. A card leaves the file when it is
 * answered or settled, when it is older than OPEN_CARD_MAX_AGE_MS, and when the
 * file would pass OPEN_CARDS_MAX (the oldest go first). It lives in the plugin's
 * own state folder, beside the cursor file.
 *
 * A missing, unreadable or broken file is no cards: an upgrade from a build that
 * kept no file replays nothing (its taps were heard by that build or are past
 * recovering), and a broken file never throws.
 *
 * No em or en dashes in this file.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const OPEN_CARDS_FILE_NAME = 'open-cards.json'
export const OPEN_CARD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const OPEN_CARDS_MAX = 500
const FILE_VERSION = 1

export interface OpenCard {
  id: number
  chatId: string
  postedAtMs: number
}

export interface LoadedOpenCards {
  cards: OpenCard[]
  /** True only when a parseable file of this version was read. */
  fileExisted: boolean
}

function validCard(value: unknown): OpenCard | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const id = row.id
  const chatId = row.chatId
  const postedAtMs = row.postedAtMs
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return null
  if (typeof chatId !== 'string' || chatId.trim() === '') return null
  if (typeof postedAtMs !== 'number' || !Number.isFinite(postedAtMs)) return null
  return { id, chatId, postedAtMs }
}

/** Cards younger than the age limit, the newest OPEN_CARDS_MAX, one per id, oldest first. */
export function pruneOpenCards(cards: readonly OpenCard[], nowMs: number): OpenCard[] {
  const byId = new Map<number, OpenCard>()
  for (const card of cards) {
    if (nowMs - card.postedAtMs > OPEN_CARD_MAX_AGE_MS) continue
    byId.set(card.id, card)
  }
  const kept = [...byId.values()].sort((a, b) => a.postedAtMs - b.postedAtMs || a.id - b.id)
  return kept.slice(Math.max(0, kept.length - OPEN_CARDS_MAX))
}

/** Read and validate the file. Never throws. */
export function loadOpenCards(filePath: string, nowMs: number): LoadedOpenCards {
  const none = (): LoadedOpenCards => ({ cards: [], fileExisted: false })
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return none()
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return none()
  const envelope = parsed as { v?: unknown; cards?: unknown }
  if (envelope.v !== FILE_VERSION || !Array.isArray(envelope.cards)) return none()
  const cards: OpenCard[] = []
  for (const value of envelope.cards) {
    const card = validCard(value)
    if (card) cards.push(card)
  }
  return { cards: pruneOpenCards(cards, nowMs), fileExisted: true }
}

/** Write a sibling tempfile, then rename, so a crash never leaves half a file. Never throws. */
export function saveOpenCards(filePath: string, cards: readonly OpenCard[]): boolean {
  const tmp = `${filePath}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    const body = JSON.stringify({
      v: FILE_VERSION,
      cards: cards.map(({ id, chatId, postedAtMs }) => ({ id, chatId, postedAtMs })),
    })
    writeFileSync(tmp, body, { mode: 0o600 })
    renameSync(tmp, filePath)
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      /* never written, or already gone */
    }
    return false
  }
}

/**
 * The live set of open cards and its dirty flag. The daemon adds a card when
 * it posts one, removes it when it is answered or settled, and writes on the
 * cursor timer, at exit and at once on every removal.
 *
 * SEVERAL DAEMONS SHARE THE FILE (review of #417, R2). A write is the file as
 * it is now, plus what this process added, less what it removed; a reload (at
 * every arm) is the same, so a daemon that was passive for hours reads the
 * holder's file of now, and never writes its own stale picture over it.
 */
export class OpenCardStore {
  private cards = new Map<number, OpenCard>()
  private added = new Map<number, OpenCard>()
  private removed = new Set<number>()
  private dirty = false

  constructor(
    readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Read the file; what it held is also the live set from now on. */
  load(): LoadedOpenCards {
    const loaded = loadOpenCards(this.filePath, this.now())
    this.cards = new Map(loaded.cards.map((card) => [card.id, card]))
    return loaded
  }

  /** The file as it is now, with this process's own additions and removals on top. */
  reload(): OpenCard[] {
    this.cards = this.merged()
    return this.list()
  }

  get isDirty(): boolean {
    return this.dirty
  }

  add(card: OpenCard): void {
    if (this.cards.has(card.id) || this.removed.has(card.id)) return
    const kept = { id: card.id, chatId: card.chatId, postedAtMs: card.postedAtMs }
    this.cards.set(card.id, kept)
    this.added.set(card.id, kept)
    this.dirty = true
  }

  remove(id: number): void {
    this.added.delete(id)
    if (this.removed.has(id)) return
    this.removed.add(id)
    this.cards.delete(id)
    this.dirty = true
  }

  list(): OpenCard[] {
    return pruneOpenCards([...this.cards.values()], this.now())
  }

  /** Write the file as it is now plus this process's changes, when they changed. */
  flushIfDirty(): boolean {
    if (!this.dirty) return false
    const merged = pruneOpenCards([...this.merged().values()], this.now())
    this.cards = new Map(merged.map((card) => [card.id, card]))
    if (!saveOpenCards(this.filePath, merged)) return false
    this.added.clear()
    this.dirty = false
    return true
  }

  private merged(): Map<number, OpenCard> {
    const onDisk = loadOpenCards(this.filePath, this.now()).cards
    const next = new Map(onDisk.map((card) => [card.id, card]))
    for (const [id, card] of this.added) next.set(id, card)
    for (const id of this.removed) next.delete(id)
    return next
  }
}

/**
 * THE SECOND ROUTE FOR A TAP IN A CHAT THE POLL DOES NOT WATCH, ON A BOUNDED
 * SCHEDULE (review of #417, R3).
 *
 * The poll reads only the chats whose agent is this one. A card this agent
 * posted in a channel or room another agent founded was read once after the
 * post and then left to the stream alone. Each such open card is read again by
 * its exact id (one row, so a channel's other messages are never read):
 *   - first after a random part of a minute, so a fleet that restarts together
 *     does not read together;
 *   - then after 1, 2, 4 ... minutes, at most every OPEN_CARD_WATCH_MAX_MS;
 *   - never once the card is older than the file keeps (OPEN_CARD_MAX_AGE_MS);
 *   - not at all while a 429 or a 5xx pause holds, the pause doubling while
 *     they last and ending at the next good read;
 *   - at most OPEN_CARD_WATCH_MAX_READS a tick, the longest waiting first.
 * A card read back at boot gets one read through the same budget, wherever its
 * chat is. With group lanes on, a chat the poll does not watch is the group
 * lane's, and is not read here at all (R1).
 */
export const OPEN_CARD_WATCH_FIRST_MS = 60_000
export const OPEN_CARD_WATCH_MAX_MS = 30 * 60_000
export const OPEN_CARD_WATCH_MAX_READS = 10

export interface WatchCard {
  id: number
  chatId: string
  postedAtMs: number
  settled: boolean
  /** Read back at boot and not yet read since. */
  rehydrated: boolean
}

export interface OpenCardWatch {
  /** The cards to read now. A card seen for the first time is scheduled, not read. */
  due(input: { cards: readonly WatchCard[]; monitored: ReadonlySet<string>; nowMs: number; unmonitoredAllowed: boolean }): WatchCard[]
  /** A read was sent: the next one waits twice as long, up to the cap. */
  noteRead(id: number, nowMs: number): void
  /** A read failed with this status (null when unknown): a 429 or a 5xx pauses every read. */
  noteFailure(status: number | null, nowMs: number): void
  /** A read came back: the pause, if any, starts again from one minute next time. */
  noteSuccess(): void
}

export function createOpenCardWatch(opts: { random?: () => number } = {}): OpenCardWatch {
  const random = opts.random ?? Math.random
  const nextAt = new Map<number, number>()
  const reads = new Map<number, number>()
  let pausedUntil = 0
  let pauses = 0
  return {
    due({ cards, monitored, nowMs, unmonitoredAllowed }) {
      if (nowMs < pausedUntil) return []
      const ready: Array<{ card: WatchCard; at: number }> = []
      const live = new Set<number>()
      for (const card of cards) {
        live.add(card.id)
        if (card.settled) continue
        if (nowMs - card.postedAtMs > OPEN_CARD_MAX_AGE_MS) continue
        const unmonitored = !monitored.has(card.chatId)
        if (unmonitored && !unmonitoredAllowed) continue
        if (!unmonitored && !card.rehydrated) continue
        const at = nextAt.get(card.id)
        if (at === undefined) {
          nextAt.set(card.id, nowMs + Math.floor(random() * OPEN_CARD_WATCH_FIRST_MS))
          continue
        }
        if (nowMs < at) continue
        ready.push({ card, at })
      }
      for (const id of nextAt.keys()) if (!live.has(id)) { nextAt.delete(id); reads.delete(id) }
      ready.sort((a, b) => a.at - b.at || a.card.id - b.card.id)
      return ready.slice(0, OPEN_CARD_WATCH_MAX_READS).map((entry) => entry.card)
    },
    noteRead(id, nowMs) {
      const n = (reads.get(id) ?? 0) + 1
      reads.set(id, n)
      nextAt.set(id, nowMs + Math.min(OPEN_CARD_WATCH_FIRST_MS * 2 ** (n - 1), OPEN_CARD_WATCH_MAX_MS))
    },
    noteFailure(status, nowMs) {
      if (status === null || (status !== 429 && status < 500)) return
      pauses += 1
      pausedUntil = nowMs + Math.min(OPEN_CARD_WATCH_FIRST_MS * 2 ** (pauses - 1), OPEN_CARD_WATCH_MAX_MS)
    },
    noteSuccess() {
      pauses = 0
    },
  }
}

/** The HTTP status of a failed read, from the error the plugin's GET throws ("GET 429: ..."). */
export function readFailureStatus(err: unknown): number | null {
  const message = err instanceof Error ? err.message : null
  const match = message ? /^GET (\d{3})\b/.exec(message) : null
  return match ? Number(match[1]) : null
}

/** An answer older than this is not announced as a fresh turn (review of #417, R5). */
export const OPEN_CARD_STALE_ANSWER_MS = 24 * 60 * 60 * 1000
