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
 * Signals, and why there are now TWO of them:
 *
 *   - PASSIVE: `live` = at least one bgos MCP tool call since this process
 *     booted. A session that has spoken can obviously hear us, so this is a
 *     sound POSITIVE. It is NOT a sound negative, see below.
 *   - ACTIVE: when the passive signal is absent we PROBE, by asking the
 *     session to call `channel_ack` (buildLivenessProbeNotification). A
 *     session that hears the channel answers a direct question even when it
 *     has nothing to say to the user; a deaf one never does.
 *
 * WHY THE PASSIVE SIGNAL ALONE WAS WRONG (2026-08-26, Observer/930). Silence
 * is a CORRECT outcome here, and we ship it as one twice over: the
 * reply-overdue nudge itself ends "If you intended to stay silent, ignore
 * this notification", and most watch-style standing orders end "tell KC only
 * if blocked". So the daemon invited silence and then read silence as proof
 * of a broken install. Observer received its 00:30 wake, worked for 7m37s,
 * correctly stood down without calling a bgos tool, and at 00:38 was told in
 * its owner's chat that it "cannot receive your messages" and "was launched
 * without the channel flag". Both clauses were false: argv carried
 * `--dangerously-load-development-channels server:bgos` and the workspace
 * `.mcp.json` declared a matching `bgos` server. Across the fleet the check
 * had fired 13 times since 2026-08-22 and at least 6 were provably false (5
 * agents posted real replies within the hour; Observer was caught working in
 * its own terminal). Zero were confirmed true. A check that cannot tell a
 * busy or deliberately-quiet session from a deaf one is not evidence, and
 * this one accused healthy agents in front of their owner and told them to
 * quit sessions that were mid-task.
 *
 * Cursor PERSISTENCE stays gated on the passive signal (gatePersistedCursors):
 * the in-memory advance still happens (it dedups polls within the process),
 * but a not-live session must never write progress to disk, so a restart
 * after the operator fixes the launch flag re-frames everything since boot as
 * backlog and redelivers it. That direction is safe: its failure mode on a
 * healthy-but-quiet session is one duplicate batch, not a false accusation.
 *
 * Semantics confirmed by Data (2026-08-22, oneclick handoff reply 1):
 * at-least-once is the intended contract, a duplicate beats a silent loss.
 * The redelivery CAP is structural rather than a counter: within one
 * process the in-memory cursor dedups every poll (no notification loops),
 * so a permanently-deaf session redelivers at most once per RESTART, and
 * each restart also re-arms exactly one probe and at most one in-chat
 * escalation naming the fix.
 */

/**
 * One-way latch: flips true on the first bgos tool call this process sees
 * and stays true. `channel_ack` counts, which is what makes the active probe
 * work: a session with nothing to say can still prove it hears us.
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
 * How long the session gets to answer the probe before we accuse it, counted
 * in reply-overdue windows. Three windows (12 minutes at the 4 minute
 * default) on top of the two windows already spent waiting, so nothing is
 * said in the chat until a session has been silent for 20 minutes AND has
 * ignored a direct question. Generous on purpose: the cost of waiting longer
 * is a later warning, the cost of waiting too little is telling someone to
 * kill a session that is doing their work.
 */
export const DEAF_PROBE_GRACE_WINDOWS = 3

/** What the daemon should do about a session that has not spoken yet. */
export type DeafSessionAction = 'wait' | 'probe' | 'escalate'

/**
 * Three-way decision, replacing the old boolean shouldEscalateDeafSession.
 *
 *   'wait'     nothing to do.
 *   'probe'    send ONE channel_ack request and start the grace clock.
 *   'escalate' the probe went unanswered too; post the chat warning.
 *
 * 'probe' is returned at exactly the moment the old function returned true,
 * so the first four conditions below are unchanged decision records:
 *
 *   - the session is not live (zero bgos tool calls since boot),
 *   - there is a pending unanswered inbound,
 *   - the reply-overdue nudge for it already fired (reminded), and went
 *     unacted for at least ONE MORE full window (now - ts >= 2 * windowMs),
 *   - the escalation has not already fired this boot (once per boot).
 *
 * What is new is that reaching that moment now buys a QUESTION rather than an
 * accusation, and only an unanswered question earns the accusation.
 */
export function deafSessionAction(input: {
  live: boolean
  pending: { ts: number; reminded: boolean } | null
  now: number
  alreadyEscalated: boolean
  probeSentAt: number | null
  windowMs: number
}): DeafSessionAction {
  if (input.live) return 'wait'
  if (!input.pending) return 'wait'
  if (!input.pending.reminded) return 'wait'
  if (input.alreadyEscalated) return 'wait'
  if (input.now - input.pending.ts < 2 * input.windowMs) return 'wait'
  if (input.probeSentAt === null) return 'probe'
  if (input.now - input.probeSentAt < DEAF_PROBE_GRACE_WINDOWS * input.windowMs) {
    return 'wait'
  }
  return 'escalate'
}

/**
 * The user-facing chat warning for a session that ignored the probe.
 *
 * It states the OBSERVATION (it did not answer) rather than a cause we have
 * not established, and it leads with the diagnostic rather than the restart:
 * `hoai doctor` costs ten seconds and is non-destructive, while quitting a
 * Claude Code session throws away whatever it was in the middle of. The
 * launch command is still included verbatim, because for a genuinely deaf
 * session it is the fix and it must never be paraphrased.
 */
export function deafSessionChatMessage(launchCommand: string): string {
  return (
    'Heads up: this agent process is running, but the Claude Code session ' +
    'behind it has not answered a direct check, so it may not be receiving ' +
    'your messages. Nothing is lost either way, anything you send is queued.' +
    '\n\nFirst run:\n\nhoai doctor\n\n' +
    'If that reports the channel is missing, quit the session and start it ' +
    'again with:\n\n' +
    `${launchCommand}`
  )
}
