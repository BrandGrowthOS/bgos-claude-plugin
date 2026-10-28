// Pure helpers for the `list_chats` tool (backend GET /api/v1/peers/reachable).
// Extracted so the path + summary logic is unit-tested without importing the
// server.ts monolith.

export function buildReachableChatsPath(): string {
  return 'peers/reachable'
}

type ReachableBinding =
  | { status?: unknown; revivable?: unknown }
  | null
  | undefined

type ReachableChat = {
  kind?: unknown
  binding?: ReachableBinding
}

/**
 * A one-line signal an agent can read at a glance before the raw JSON: how many
 * chats are reachable, how many are CLOSED peer-bridged bindings (the ones the
 * poll inbox hides), and how many of those a plain reply will revive.
 */
export function summarizeReachableChats(payload: unknown): string {
  const chats: ReachableChat[] = Array.isArray(
    (payload as { chats?: unknown })?.chats,
  )
    ? ((payload as { chats: ReachableChat[] }).chats)
    : []
  let closedBridged = 0
  let revivable = 0
  for (const c of chats) {
    const binding = c?.binding
    if (c?.kind === 'a2a' && binding && binding.status === 'closed') {
      closedBridged += 1
      if (binding.revivable === true) revivable += 1
    }
  }
  return `${chats.length} reachable chat(s); ${closedBridged} closed bridged (${revivable} revivable by replying).`
}
