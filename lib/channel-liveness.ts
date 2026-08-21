/**
 * Channel liveness (fix 04, the double-silent failure).
 *
 * The plugin delivers inbound chat messages to Claude Code as MCP channel
 * notifications. A session launched WITHOUT the channel flag (or with the
 * wrong spec for its install method) ACCEPTS those notifications at the
 * transport and then silently discards them; the daemon sees a successful
 * hand-off, advances + persists the per-chat cursor, and the message is
 * lost forever, even after the operator fixes the flag and restarts. The
 * reply-overdue nudge is itself a channel notification, so a deaf session
 * discards the rescue too.
 *
 * Working signal: a session that can hear us eventually CALLS a bgos tool
 * (reply, ask_user_input, anything); a deaf session never does, because it
 * never sees a reason to. So:
 *
 *   - live = at least one bgos MCP tool call since this process booted.
 *   - Cursor PERSISTENCE is gated on liveness (gatePersistedCursors): the
 *     in-memory advance still happens (it dedups polls within the process),
 *     but a not-live session must never write progress to disk, so a
 *     restart after the operator fixes the launch flag re-frames everything
 *     since boot as backlog and redelivers it.
 *   - When the nudge itself goes unacted on a not-live session
 *     (shouldEscalateDeafSession), the daemon posts a warning INTO THE CHAT
 *     over REST (the path that provably works) naming the exact launch
 *     command (deafSessionChatMessage), once per boot.
 */

/**
 * One-way latch: flips true on the first bgos tool call this process sees
 * and stays true. A named home for the concept so future signals (e.g. an
 * explicit channel ack) have somewhere to land.
 */
export class ChannelLiveness {
  private toolCallSeen = false

  markToolCall(): void {
    this.toolCallSeen = true
  }

  get live(): boolean {
    return this.toolCallSeen
  }
}

/**
 * The cursor record a session is allowed to persist.
 *
 * Live session: everything it advanced to (returned as given; the same
 * reference is fine, callers treat the result as read-only).
 *
 * Not-live session: ONLY the entries that existed at boot, each with its
 * BOOT value. Advances made while deaf are withheld (the deliveries behind
 * them were discarded), and chats first seen after boot are omitted
 * entirely so a restart re-frames them as backlog. Never mutates either
 * input.
 */
export function gatePersistedCursors(input: {
  current: Record<string, number>
  boot: Record<string, number>
  live: boolean
}): Record<string, number> {
  if (input.live) return input.current
  const gated: Record<string, number> = {}
  for (const [chatId, value] of Object.entries(input.boot)) {
    gated[chatId] = value
  }
  return gated
}

/**
 * Should the deaf-session warning be posted into the chat? True only when
 * every condition holds:
 *
 *   - the session is not live (zero bgos tool calls since boot),
 *   - there is a pending unanswered inbound,
 *   - the reply-overdue nudge for it already fired (reminded), and went
 *     unacted for at least ONE MORE full window (now - ts >= 2 * windowMs),
 *   - the escalation has not already fired this boot (once per boot).
 */
export function shouldEscalateDeafSession(input: {
  live: boolean
  pending: { ts: number; reminded: boolean } | null
  now: number
  alreadyEscalated: boolean
  windowMs: number
}): boolean {
  if (input.live) return false
  if (!input.pending) return false
  if (!input.pending.reminded) return false
  if (input.alreadyEscalated) return false
  return input.now - input.pending.ts >= 2 * input.windowMs
}

/**
 * The user-facing chat warning for a deaf session. Plain language, no
 * jargon beyond the one command the user must paste; the launch command is
 * included verbatim.
 */
export function deafSessionChatMessage(launchCommand: string): string {
  return (
    'Heads up: this agent process is running, but the Claude Code session ' +
    'behind it cannot receive your messages. It was launched without the ' +
    'channel flag, so everything you send here is queued, not lost. To fix ' +
    'it, quit that Claude Code session and start it again with:\n\n' +
    `${launchCommand}\n\n` +
    'Or run: hoai doctor'
  )
}
