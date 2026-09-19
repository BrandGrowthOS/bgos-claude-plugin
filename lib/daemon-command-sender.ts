/**
 * Who may run a daemon-handled slash command, decided in one place for every
 * transport.
 *
 * /compact and /status never reach the model: the daemon acts on them itself
 * (lib/compact-inject.ts, lib/slash-status.ts). Until this file existed neither
 * handler asked WHO sent the command. One agent session serves every chat of
 * that agent, so a human the owner had shared the agent with could tap
 * /compact in their own chat and compact the owner's context. The same message
 * arrives over three rails (REST poll, WebSocket, update stream), so a gate
 * written at one rail is the defect class 0.39.7's meeting cards shipped with,
 * where one transport framed the card and the other did not. The two handlers
 * in server.ts call judgeDaemonCommand first, before anything else they do, so
 * a rail cannot reach the action without passing through it.
 *
 * The sender is read from the fields the backend stamps PER MESSAGE about the
 * human who wrote it, in each transport's own spelling:
 *
 *   WS inbound_message: a nested `sender: { userId, relationship }` block plus
 *     the mirror fields `isSharedRecipient` and `shareOwnerUserId` (both keys
 *     absent on a persistent group, where there is no share to describe).
 *   REST poll row and stream replay row: flat `sender_user_id` and
 *     `sender_relationship`, omitted entirely on authorless rows. The row's
 *     own `sender` key is the ROLE string ('user', 'assistant', 'system'),
 *     which is not a sender block and not an error.
 *
 * The top level `userId` / `user_id` is deliberately NOT read. On both
 * transports that is the assistant OWNER's id (the socket room the event was
 * emitted to, the poll row's owner column), so a reader that fell back to it
 * would call every recipient the owner, which is the exact hole this file
 * closes. server.ts's senderUserIdOf does fall back that way, on purpose, for
 * attribution where a wrong guess is harmless; it must not be reused here.
 *
 * Identity is by user id (the capability doc's rule: attribute by the sender
 * id, never by the owner). The relationship fields can only take ownership
 * away, never grant it: a sender whose id matches the owner but who is
 * labelled a share recipient is a contradiction and is treated as a stranger.
 *
 * Fail closed. A payload with no sender field, or one in a shape this reader
 * does not trust, cannot be proven to be the owner and is treated as a
 * stranger. What a stranger gets is decided per command on what the command
 * MUTATES or EXPOSES, not on symmetry:
 *
 *   /compact MUTATES the owner's session. A stranger is refused, with a short
 *     reply in their own chat, because a silent no-op reads as a broken
 *     command. Refused BEFORE the host's compact capability is consulted, so
 *     the refusal does not tell them whether this host can compact remotely.
 *   /status mutates nothing, but its full answer EXPOSES facts about the
 *     owner's machine (install method, supervisor, update enrolment) and the
 *     owner's traffic (when the last message arrived, which is one clock
 *     across every chat this daemon serves). A stranger is answered, because
 *     "is this agent up, and which version" is exactly the question a share
 *     recipient has when the agent looks dead, but only with those two facts.
 *     lib/slash-status.ts builds that reduced answer from the audience.
 */

export type DaemonCommand = 'compact' | 'status'

/** The backend's vocabulary; anything else reads as 'unrecognised'. */
export type SenderRelationship = 'owner' | 'shared_recipient' | 'room_member'

export interface SlashSender {
  /** The human sender's user id, or null when no transport shape carried one. */
  userId: string | null
  /** The backend's stated standing, null when absent. */
  relationship: SenderRelationship | 'unrecognised' | null
  /** The share question's answer when the wire answered it, null when the key was absent. */
  isSharedRecipient: boolean | null
  /** The owner's id when the backend marked this sender as a share recipient. */
  shareOwnerUserId: string | null
  /** A sender field was present but not in a shape this reader trusts. */
  malformed: boolean
}

export type DaemonCommandAudience = 'owner' | 'non_owner'

export type DaemonCommandRefusal = 'not_owner' | 'sender_unknown' | 'sender_malformed'

export type DaemonCommandVerdict =
  | { kind: 'allow'; audience: DaemonCommandAudience; sender: SlashSender }
  | { kind: 'refuse'; reason: DaemonCommandRefusal; reply: string; sender: SlashSender }

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function readRelationship(value: unknown): {
  value: SlashSender['relationship']
  malformed: boolean
} {
  if (value == null) return { value: null, malformed: false }
  if (typeof value !== 'string') return { value: null, malformed: true }
  const trimmed = value.trim()
  if (!trimmed) return { value: null, malformed: true }
  if (trimmed === 'owner' || trimmed === 'shared_recipient' || trimmed === 'room_member') {
    return { value: trimmed, malformed: false }
  }
  return { value: 'unrecognised', malformed: false }
}

function readShareFlag(value: unknown): { value: boolean | null; malformed: boolean } {
  if (value == null) return { value: null, malformed: false }
  if (typeof value === 'boolean') return { value, malformed: false }
  if (value === 'true') return { value: true, malformed: false }
  if (value === 'false') return { value: false, malformed: false }
  return { value: null, malformed: true }
}

/**
 * Normalise the sender fields of an inbound payload in any of the three
 * transport shapes. Never throws; never reads the owner-id fields.
 */
export function readSlashSender(payload: unknown): SlashSender {
  const none: SlashSender = {
    userId: null,
    relationship: null,
    isSharedRecipient: null,
    shareOwnerUserId: null,
    malformed: false,
  }
  if (!payload || typeof payload !== 'object') return none
  const p = payload as Record<string, unknown>
  let malformed = false

  // WS shape: a nested sender block. A block that names nobody is malformed.
  let nestedUserId: string | null = null
  let nestedRelationship: unknown
  const sender = p.sender
  if (sender && typeof sender === 'object') {
    const block = sender as Record<string, unknown>
    nestedUserId = nonEmptyString(block.userId ?? block.user_id)
    if (nestedUserId === null) malformed = true
    nestedRelationship = block.relationship
  }

  // Poll and stream row shape: flat fields. Present but unreadable is malformed.
  const flatRaw = p.sender_user_id ?? p.senderUserId
  let flatUserId: string | null = null
  if (flatRaw != null) {
    flatUserId = nonEmptyString(flatRaw)
    if (flatUserId === null) malformed = true
  }

  // Both shapes on one payload must agree, or neither can be trusted.
  if (nestedUserId !== null && flatUserId !== null && nestedUserId !== flatUserId) {
    malformed = true
  }

  const relationship = readRelationship(
    nestedRelationship ?? p.sender_relationship ?? p.senderRelationship,
  )
  const share = readShareFlag(p.isSharedRecipient ?? p.is_shared_recipient)

  return {
    userId: nestedUserId ?? flatUserId,
    relationship: relationship.value,
    isSharedRecipient: share.value,
    shareOwnerUserId: nonEmptyString(p.shareOwnerUserId ?? p.share_owner_user_id),
    malformed: malformed || relationship.malformed || share.malformed,
  }
}

/**
 * True only when the sender is provably the owner this daemon is paired to:
 * a readable sender id equal to the owner's, with no field claiming otherwise.
 */
export function isOwnerSender(sender: SlashSender, ownerUserId: string): boolean {
  const owner = nonEmptyString(ownerUserId)
  if (owner === null) return false
  if (sender.malformed) return false
  if (sender.userId === null) return false
  if (sender.userId !== owner) return false
  if (sender.relationship === 'shared_recipient') return false
  if (sender.isSharedRecipient === true) return false
  if (sender.shareOwnerUserId !== null) return false
  return true
}

function refusalReply(command: DaemonCommand, reason: DaemonCommandRefusal): string {
  const rule = `only this agent's owner can ${command} its session.`
  switch (reason) {
    case 'sender_unknown':
      return `/${command} was not run: this message carried no sender identity, and ${rule}`
    case 'sender_malformed':
      return `/${command} was not run: this message's sender identity could not be read, and ${rule}`
    case 'not_owner':
    default: {
      const why =
        command === 'compact' ? ' Compacting changes the context the owner is working in.' : ''
      return `/${command} was not run: ${rule}${why}`
    }
  }
}

/**
 * The one decision both server.ts handlers make before acting. Pure: the same
 * payload and owner always give the same verdict.
 */
export function judgeDaemonCommand(input: {
  command: DaemonCommand
  payload: unknown
  ownerUserId: string
}): DaemonCommandVerdict {
  const sender = readSlashSender(input.payload)
  if (isOwnerSender(sender, input.ownerUserId)) {
    return { kind: 'allow', audience: 'owner', sender }
  }
  if (input.command === 'status') {
    // Mutates nothing; the reduced answer is what any stranger may see.
    return { kind: 'allow', audience: 'non_owner', sender }
  }
  const reason: DaemonCommandRefusal = sender.malformed
    ? 'sender_malformed'
    : sender.userId === null
      ? 'sender_unknown'
      : 'not_owner'
  return { kind: 'refuse', reason, reply: refusalReply(input.command, reason), sender }
}

/** The allow arm, which is what `act` receives. */
export type DaemonCommandAllowed = Extract<DaemonCommandVerdict, { kind: 'allow' }>

export interface DaemonCommandRun {
  command: DaemonCommand
  payload: unknown
  ownerUserId: string
  /** The chat the command came from; a refusal is sent there. */
  chatId: string
  /** Delivers text to a chat. On a refusal it is called once, with the reply. */
  send: (chatId: string, text: string) => Promise<void>
  /** The command's own work. Reached only on an allow verdict, and handed it. */
  act: (verdict: DaemonCommandAllowed) => Promise<void>
  log?: (line: string) => void
}

/**
 * The enforcement seam. Both server.ts handlers are a single call to this
 * function with their real work passed as `act`, so the rule "a refused sender
 * never reaches the action" is code a test can drive with spies, rather than
 * text a test can only read. A refusal reply that fails to send is logged and
 * swallowed: the sender is refused either way. A rejection from `act`
 * propagates, so the rail's own catch still sees a failed command.
 */
export async function runDaemonCommand(run: DaemonCommandRun): Promise<'acted' | 'refused'> {
  const verdict = judgeDaemonCommand({
    command: run.command,
    payload: run.payload,
    ownerUserId: run.ownerUserId,
  })
  if (verdict.kind === 'refuse') {
    run.log?.(
      `/${run.command} refused (chat ${run.chatId}, ${verdict.reason}, ` +
        `sender ${verdict.sender.userId ?? 'unknown'})`,
    )
    try {
      await run.send(run.chatId, verdict.reply)
    } catch (err) {
      run.log?.(`/${run.command}: refusal reply failed: ${err}`)
    }
    return 'refused'
  }
  await run.act(verdict)
  return 'acted'
}
