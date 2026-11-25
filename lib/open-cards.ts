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
 * it posts one, removes it when it is answered or settled, and flushes on the
 * cursor timer and at exit; a failed flush keeps the flag for the next one.
 */
export class OpenCardStore {
  private cards = new Map<number, OpenCard>()
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

  get isDirty(): boolean {
    return this.dirty
  }

  add(card: OpenCard): void {
    if (this.cards.has(card.id)) return
    this.cards.set(card.id, { id: card.id, chatId: card.chatId, postedAtMs: card.postedAtMs })
    this.dirty = true
  }

  remove(id: number): void {
    if (this.cards.delete(id)) this.dirty = true
  }

  list(): OpenCard[] {
    return pruneOpenCards([...this.cards.values()], this.now())
  }

  /** Write the live set when it changed since the last good write. */
  flushIfDirty(): boolean {
    if (!this.dirty) return false
    const cards = this.list()
    this.cards = new Map(cards.map((card) => [card.id, card]))
    if (!saveOpenCards(this.filePath, cards)) return false
    this.dirty = false
    return true
  }
}
