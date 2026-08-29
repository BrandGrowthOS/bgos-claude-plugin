/**
 * The one command we answer ourselves.
 *
 * Anthropic's Telegram channel ships three chat commands and implements all three in its own code,
 * which is why they cannot be wrong. Its /status reads the bridge's own state file and replies. Ours
 * had a /status too, and it was a label handed to a model with an instruction to "execute its
 * registered behavior now", so what came back was whatever the model could infer.
 *
 * Everything below is a fact the daemon already holds at the moment the question is asked. Nothing
 * here is inferred, and anything unknown says so rather than being estimated: reporting a version we
 * are not sure of is worse than reporting none, because the whole point of this command is to be the
 * thing you can trust when the rest looks ambiguous.
 */

export interface StatusFacts {
  /** BGOS assistant id this daemon is bound to. */
  assistantId: string | null
  /** Display name, when the daemon has resolved one. */
  assistantName: string | null
  /** Running plugin version, or null when it could not be read. */
  version: string | null
  /** 'marketplace' | 'clone' | 'unknown', from install-method detection. */
  installMethod: string
  /** Supervisor holding this agent up, or 'none'. */
  supervised: string
  /**
   * Whether this machine is enrolled in Claude Code's marketplace auto-update.
   * null means we could not determine it, which must NOT be reported as either answer.
   */
  autoUpdateEnrolled: boolean | null
  /** Milliseconds since the last inbound message, or null when none has arrived. */
  lastInboundAgoMs: number | null
}

/** Human-readable age, kept coarse because precision here would be false precision. */
function describeAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/**
 * Build the /status reply. Short enough to read on a phone: the caller renders it as one chat
 * bubble, so it is capped at a handful of lines by test/slash-status.test.ts.
 */
export function buildStatusAnswer(facts: StatusFacts): string {
  const name = facts.assistantName?.trim()
    ? facts.assistantName.trim()
    : `Agent ${facts.assistantId ?? 'unknown'}`

  const version = facts.version?.trim() ? `v${facts.version.trim()}` : 'version not reported'

  const install =
    facts.installMethod === 'unknown' || !facts.installMethod
      ? 'install method unknown'
      : `installed via ${facts.installMethod}`

  const supervisor =
    facts.supervised && facts.supervised !== 'none'
      ? `kept running by ${facts.supervised}`
      : 'no supervisor, so restarts are manual'

  const lines = [`**${name}** is connected.`, `${version}, ${install}.`, `${supervisor}.`]

  // Only stated when we actually know. An agent that is not enrolled will never update itself, and
  // that is precisely the silent failure this release exists to end, so it is worth a line.
  if (facts.autoUpdateEnrolled === true) {
    lines.push('This machine updates automatically when a new version is published.')
  } else if (facts.autoUpdateEnrolled === false) {
    lines.push('Updates here are not automatic yet: this machine still needs them applied by hand.')
  }

  lines.push(
    facts.lastInboundAgoMs === null
      ? 'No messages yet this session.'
      : `Last message ${describeAge(facts.lastInboundAgoMs)}.`,
  )

  return lines.join('\n')
}
