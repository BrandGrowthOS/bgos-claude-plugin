// ── /steer: interrupt the running turn, then deliver the text ───────────────
//
// The app's "Send now" on a queued follow up sends a slash_command
// `/steer {text}` when this agent's synced catalog registers `steer`. What the
// owner means by it (KC 2026-10-03, msg 98508): send it NOW and interrupt the
// turn that is running, not "queue it behind the turn".
//
// A channel notification cannot do that on its own. Proven on a real session
// (docs/reports/2026-10-09-steer-interrupt): a notification sent
// during a long tool call waits until that tool returns (60s in the probe),
// because the CLI only reads queued input at a tool boundary or a turn's end.
// What DOES interrupt is the CLI's own Escape key, and the daemon can press it
// only where it already has tmux control of the CLI pane, the same supervisor
// path that powers remote /compact (lib/compact-inject.ts). So:
//
//   1. if the steer is due an interrupt (planSteer), press ONE fixed Escape
//      into the pane (buildInterruptSteps: no chat text ever reaches tmux),
//      wait a beat for the CLI to settle the interrupted turn;
//   2. ALWAYS deliver the text as an ordinary channel message, whether or not
//      the interrupt happened or succeeded. Probed both ways: a channel
//      message queued before the Escape survives the interrupt and is
//      answered, and one sent after it starts the next turn at once.
//
// The fallback rule (the Codex lesson): a /steer with no running turn is
// delivered as a plain message, never dropped. A failed Escape is the same
// fallback, never a lost message.
//
// `steer` is advertised ONLY when the tmux capability is ON (the catalog
// invariant in lib/slash-catalog.ts: advertise only what we can perform).
// Without it the app sees no `steer` and sends plainly, so a steer that only
// queues never calls itself a steer.

import { createHash } from 'node:crypto'

export const STEER_COMMAND_NAME = 'steer'

/** The first plugin release whose /steer interrupts. The app floors on it. */
export const CLAUDE_STEER_SINCE = '0.64.0'

/** The message type the app sends a steer as. */
export const STEER_MESSAGE_TYPE = 'slash_command'

/** The text shape the app builds and routeSlashCommand parses. */
export const STEER_TEXT_SHAPE = '/steer {text}'

/**
 * THE CROSS REPO PIN. sha256 of `steer;slash_command;/steer {text};0.64.0`.
 * BGOS carries the same constant beside its Claude Code branch of
 * `sendNowModeFor` (frontend/expo-app/src/components/chat/followUpTrayModel.ts,
 * CLAUDE_TRAY_STEER_CONTRACT_SHA256). Each side rebuilds the string from its
 * OWN source values in a test, so a one sided change turns a hash pin red.
 */
export const CLAUDE_STEER_CONTRACT_SHA256 =
  '1e45af97de1641d775f0adfbac45765f7e2ded2c4f7426bd55b78822c5174be0'

export function steerContractString(): string {
  return [STEER_COMMAND_NAME, STEER_MESSAGE_TYPE, STEER_TEXT_SHAPE, CLAUDE_STEER_SINCE].join(';')
}

export function steerContractSha256(): string {
  return createHash('sha256').update(steerContractString()).digest('hex')
}

/**
 * A steer older than this is a replay (a restart's backlog, a reconnect's
 * stream), not "now": it targets a turn that is long over, and pressing
 * Escape for it would interrupt whatever runs today. Two minutes, generous
 * for clock skew between the backend and this machine.
 */
export const STEER_FRESH_MS = 2 * 60_000

/**
 * How long the daemon waits after the Escape before delivering. The probe saw
 * the CLI print "Interrupted" well inside a second; delivery is safe either
 * way (a message queued before the interrupt survives it), so this only keeps
 * the order tidy in the transcript.
 */
export const STEER_SETTLE_MS = 800

/** Whether a turn runs, as far as the daemon's hook rail can tell. */
export type SteerTurnState = 'live' | 'idle' | 'unknown'

export type SteerPlan =
  | { interrupt: true; reason: 'turn_live' | 'turn_unknown' }
  | {
      interrupt: false
      reason: 'no_terminal' | 'not_owner' | 'stale' | 'idle' | 'empty' | 'dialog_open' | 'other_chat'
    }

/**
 * Should this /steer press Escape before it is delivered?
 *
 *   no tmux target   nothing to press; plain delivery (the catalog does not
 *                    advertise steer here, so this is a hand typed /steer)
 *   not the owner    one session serves every chat of this agent, so a share
 *                    recipient's steer would interrupt the OWNER's turn
 *   stale            a replay targets a turn that is long over
 *   empty text       nothing to steer with; an interrupt alone is a stop
 *   other chat       the hooks name the running turn's chat and it is not
 *                    this one: one session serves every chat of the agent,
 *                    and Send now in chat B must not stop chat A's work
 *   dialog open      a permission prompt the app relays is up: Escape would
 *                    reject it in the terminal while the app's card stays
 *                    pending, so the steer waits its turn like a message
 *   idle             no turn to interrupt (the hook rail says so); a lone
 *                    Escape is harmless there but there is no reason to send it
 *   live / unknown   press. Unknown means the hook rail is not reporting
 *                    (no plugin hooks on this install, or before the first
 *                    event); probed: one Escape on an idle CLI changes nothing,
 *                    and a draft in the composer survives it.
 */
export function planSteer(input: {
  hasTerminal: boolean
  isOwner: boolean
  fresh: boolean
  text: string
  turn: SteerTurnState
  /** A relayed permission prompt is waiting for an answer. */
  dialogOpen?: boolean
  /** The hooks name the running turn's chat and it is a different chat. */
  otherChatTurn?: boolean
}): SteerPlan {
  if (!input.hasTerminal) return { interrupt: false, reason: 'no_terminal' }
  if (!input.isOwner) return { interrupt: false, reason: 'not_owner' }
  if (!input.fresh) return { interrupt: false, reason: 'stale' }
  if (input.text.trim() === '') return { interrupt: false, reason: 'empty' }
  if (input.turn === 'idle') return { interrupt: false, reason: 'idle' }
  if (input.dialogOpen === true) return { interrupt: false, reason: 'dialog_open' }
  if (input.otherChatTurn === true) return { interrupt: false, reason: 'other_chat' }
  return { interrupt: true, reason: input.turn === 'live' ? 'turn_live' : 'turn_unknown' }
}

/**
 * Is a message sent at `sentDate` still "now"? Unreadable or missing reads as
 * NOT fresh: the cost of a wrong "fresh" is interrupting an unrelated turn,
 * the cost of a wrong "stale" is a steer that queues, and the text is
 * delivered either way.
 */
export function isFreshSteer(sentDate: unknown, nowMs: number, freshMs = STEER_FRESH_MS): boolean {
  if (typeof sentDate !== 'string' && typeof sentDate !== 'number') return false
  const at = typeof sentDate === 'number' ? sentDate : Date.parse(sentDate)
  if (!Number.isFinite(at)) return false
  return nowMs - at <= freshMs
}

/** The hook rail's view as a SteerTurnState. */
export function steerTurnState(input: { signal: 'hooks' | 'none'; live: boolean }): SteerTurnState {
  if (input.signal !== 'hooks') return 'unknown'
  return input.live ? 'live' : 'idle'
}

/**
 * The text a steer delivers: the inbound content with the leading `/steer`
 * token taken out, so everything the channel builder put around the words
 * (attachment lines, a backlog prefix, a plan or peer marker) still reaches
 * the model. Falls back to the bare arguments when the content carries
 * nothing else (a structured frame whose text is empty).
 */
export function steerContent(sourceContent: string | undefined, commandArgs: string): string {
  const stripped = String(sourceContent ?? '')
    .replace(/(^|\n)[ \t]*\/steer(?=\s|$)[ \t]*/i, '$1')
    .trim()
  return stripped || commandArgs.trim()
}

/**
 * The channel card a steer delivers. Its meta is EMPTY on purpose: an ordinary
 * message carries no event_type and no command_name, and a steer is an
 * ordinary message that arrives early. The `steer` marker
 * (STEER_INTERRUPTED_META) is added at delivery time and ONLY when the Escape
 * was really pressed, because the model is told that marker means "your turn
 * was interrupted on purpose", which must never be said of a steer that was
 * not (an idle one, a share recipient's, a stale one, a failed press).
 */
export function buildSteerDelivery(input: { sourceContent?: string; commandArgs: string }): {
  content: string
  meta: Record<string, string>
} {
  return { content: steerContent(input.sourceContent, input.commandArgs), meta: {} }
}

/** Added to the card only when the interrupt happened. All string (wake card contract). */
export const STEER_INTERRUPTED_META: Readonly<Record<string, string>> = Object.freeze({ steer: 'true' })

export type SteerOutcome =
  | 'interrupted'
  | 'interrupt_failed'
  | 'plain'
  | 'cooldown'
  | 'injection_busy'
  | 'already_pressed'

/**
 * No second Escape within this window. Claude Code fires no Stop hook on an
 * interrupt, so the hook rail still reads "live" right after one, and a second
 * steer a second later would press again into an idle CLI: two Escapes close
 * together clear the composer's draft or open the rewind menu.
 */
export const STEER_ESCAPE_COOLDOWN_MS = 3_000

const PRESSED_IDS_MAX = 200

/**
 * The one place a steer's Escape is pressed, and the order of everything
 * delivered around it.
 *
 *   - Steers run one at a time, in arrival order (a single chain), so two
 *     steers in one poll batch cannot press two Escapes at once.
 *   - An ordinary message that arrives while a steer is still in flight is
 *     delivered AFTER it, so the model never sees a later message first.
 *     With nothing in flight it is delivered at once, exactly as before.
 *   - No Escape inside the cooldown, none while the daemon is itself typing
 *     into the composer (/compact, /goal: an Escape there would cancel the
 *     compaction or eat the typed command), and never a second one for the
 *     same message id (a stream retry after a failed handoff).
 *   - Delivery ALWAYS happens, interrupt or not; `deliver` is told whether
 *     the interrupt happened so the card carries the marker only then.
 */
export class SteerGate {
  private chain: Promise<void> = Promise.resolve()
  private inFlight = 0
  private lastEscapeAtMs = Number.NEGATIVE_INFINITY
  private readonly pressed = new Set<string>()

  constructor(
    private readonly deps: {
      now: () => number
      /** The daemon is typing into the composer itself (/compact, /goal). */
      injectionBusy: () => boolean
      interrupt: () => Promise<void>
      sleep: (ms: number) => Promise<void>
      log: (line: string) => void
      settleMs?: number
      cooldownMs?: number
    },
  ) {}

  /** Deliver a steer after any steer before it. Rejects only if `deliver` does. */
  steer(input: {
    messageId: string
    plan: SteerPlan
    deliver: (interrupted: boolean) => Promise<void>
  }): Promise<SteerOutcome> {
    return this.enqueue(async () => {
      const outcome = await this.press(input.messageId, input.plan)
      this.deps.log(`steer: ${outcome} (${input.plan.reason})`)
      await input.deliver(outcome === 'interrupted')
      return outcome
    })
  }

  /** Deliver an ordinary message: at once, or behind a steer still in flight. */
  ordinary(deliver: () => Promise<void>): Promise<void> {
    if (this.inFlight === 0) return deliver()
    return this.enqueue(deliver)
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.inFlight++
    const run = this.chain.then(task)
    const settled = run.then(
      () => {},
      () => {},
    )
    this.chain = settled.then(() => {
      this.inFlight--
    })
    return run
  }

  private async press(messageId: string, plan: SteerPlan): Promise<SteerOutcome> {
    if (!plan.interrupt) return 'plain'
    if (this.pressed.has(messageId)) return 'already_pressed'
    if (this.deps.injectionBusy()) return 'injection_busy'
    const cooldown = this.deps.cooldownMs ?? STEER_ESCAPE_COOLDOWN_MS
    if (this.deps.now() - this.lastEscapeAtMs < cooldown) return 'cooldown'
    try {
      await this.deps.interrupt()
    } catch (err) {
      this.deps.log(`steer: interrupt failed, delivering as a plain message: ${err}`)
      return 'interrupt_failed'
    }
    this.lastEscapeAtMs = this.deps.now()
    this.pressed.add(messageId)
    if (this.pressed.size > PRESSED_IDS_MAX) {
      const oldest = this.pressed.values().next().value
      if (oldest !== undefined) this.pressed.delete(oldest)
    }
    await this.deps.sleep(this.deps.settleMs ?? STEER_SETTLE_MS)
    return 'interrupted'
  }
}
