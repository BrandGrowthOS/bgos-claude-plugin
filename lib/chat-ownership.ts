/**
 * WHOSE CHAT IS IT, as far as this daemon can tell (shared agents Phase 0,
 * item 0.8; BGOS docs/reports/2026-10-14-shared-agents-review MATRIX M13.2).
 *
 * A Claude Code permission card asks about an action on the OWNER's machine,
 * so it belongs in the owner's own chat. The card used to go to the first
 * monitored chat, which on a shared agent can be a share recipient's DM: the
 * recipient then saw the owner's command text and the owner never saw the
 * card. pickPermissionChat (lib/peer-refusal.ts) asks this record instead.
 *
 * TWO SOURCES, both the server's own words, never the text:
 *
 *   - a chat list row that names its user (`userId` / `user_id`), when the
 *     backend sends one: that is the chat's owner, outright;
 *   - a person's message in the chat, by its server stamped author (the
 *     daemon passes privateSenderUserId, never senderUserIdOf, whose fallback
 *     to the owner would make every unstamped row the owner's).
 *
 * THE RULES. Only a MAIN chat can be the owner's own chat: a row whose kind
 * says otherwise (a peer side thread, a meeting, a group) never is, whoever
 * owns the row. A chat where anybody but the owner was seen is somebody
 * else's, for good: a main chat belongs to one person, so the owner turning up
 * in it later does not make it theirs, and a card there could still be read
 * by the other person. Silence is not evidence either way: a chat nobody was
 * seen in is unknown, and pickPermissionChat keeps today's order for those.
 *
 * Bounded, oldest first out, like the refused chat sets: forgetting a chat
 * costs a preference, never a wrong card.
 */

export const CHAT_OWNERSHIP_MAX = 500

export interface ChatOwnership {
  /** A chat list row: its kind and, when the backend sends it, its user. */
  noteRow(row: { chatId: string | number; kind?: unknown; userId?: unknown }): void
  /** A person's message in the chat, with its server stamped author, or null when it carries none. */
  noteAuthor(chatId: string | number, authorUserId: string | null | undefined): void
  /** Known to be the owner's own main chat. */
  isOwners(chatId: string): boolean
  /** Known to be somebody else's (a share recipient's) chat. */
  isOthers(chatId: string): boolean
  /** The owner's own chats, the most recently confirmed first. */
  ownerChats(): string[]
}

const id = (value: unknown): string => String(value ?? '').trim()
const stated = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

export function createChatOwnership(ownerUserId: string, limit: number = CHAT_OWNERSHIP_MAX): ChatOwnership {
  // Insertion ordered: a chat confirmed again moves to the end, so the newest is last.
  const owners = new Set<string>()
  const others = new Set<string>()
  const notMain = new Set<string>()
  const bound = (set: Set<string>) => {
    while (set.size > limit) {
      const oldest = set.values().next().value
      if (oldest === undefined) break
      set.delete(oldest)
    }
  }
  const markOther = (chatId: string) => {
    owners.delete(chatId)
    others.delete(chatId)
    others.add(chatId)
    bound(others)
  }
  const markOwner = (chatId: string) => {
    if (others.has(chatId) || notMain.has(chatId)) return
    owners.delete(chatId)
    owners.add(chatId)
    bound(owners)
  }
  return {
    noteRow(row) {
      const chatId = id(row.chatId)
      if (chatId === '') return
      const kind = stated(row.kind)
      if (kind !== null && kind !== 'main') {
        notMain.add(chatId)
        bound(notMain)
        owners.delete(chatId)
      }
      const user = stated(row.userId)
      if (user === null) return
      if (user === ownerUserId) markOwner(chatId)
      else markOther(chatId)
    },
    noteAuthor(chatId, authorUserId) {
      const chat = id(chatId)
      const author = stated(authorUserId)
      if (chat === '' || author === null) return
      if (author === ownerUserId) markOwner(chat)
      else markOther(chat)
    },
    isOwners: (chatId) => owners.has(id(chatId)),
    isOthers: (chatId) => others.has(id(chatId)),
    ownerChats: () => [...owners].reverse(),
  }
}
