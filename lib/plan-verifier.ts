// ── The /plan verifier: did a plan actually arrive? ──────────────────────────
//
// WHY THIS EXISTS. `/plan` reaches the model as a directive, not as a lock (see
// lib/plan-card.ts's header: nothing on this channel can enforce anything). A
// directive can be ignored, misread, or answered in prose, and the owner who
// typed `/plan` would then be left watching a chat that says nothing while the
// agent quietly starts work. The verifier is the one honest thing a daemon CAN
// do about that: watch its own tool chokepoint, and if no plan was proposed,
// say so in the chat rather than let the silence stand.
//
// IT IS NOT A GATE. It observes and reports. Work may already have happened by
// the time it fires, and its message says nothing about what did or did not
// change, because it does not know.
//
// THREE ENDINGS, and the difference between them is the point:
//   - `proposed`: the first propose_plan call of the turn cancelled it. Silent.
//   - `turn_ended`: the Stop hook says the turn finished with no plan. This is
//     an OBSERVED fact, not a guess, so the line goes out at once instead of
//     waiting out the window. It is the better ending and it needs the hook
//     rail, which a clone install does not get until ensureHookEntries has run
//     (lib/claude-preseed.mjs), hence the timer below.
//   - `timeout`: the window elapsed with neither. The fallback for the install
//     where Stop never arrives.
//
// Everything here is pure: the daemon owns the clock, the timer and the POST.

/**
 * How long the daemon waits before saying no plan came, when no Stop hook
 * settles it first. Five minutes is long enough that a model reading a large
 * repo before proposing is not interrupted, and short enough that an owner who
 * typed /plan is not left guessing through a whole sweep cycle.
 */
export const PLAN_VERIFIER_WINDOW_MS = 5 * 60_000

/**
 * What the DAEMON posts into the chat when no plan arrived. The daemon is
 * speaking here, not the model, so it states the fact and the next move and
 * claims nothing about the state of the working tree, which it cannot see.
 */
export const PLAN_VERIFIER_MESSAGE =
  'You asked for a plan and none arrived. Type /plan again with a bit more detail, ' +
  'or just say what you want done.'

export interface PlanVerifierEntry {
  chatId: string
  /** The message id of the /plan the owner sent, for the log line. */
  messageId: number
  armedAtMs: number
  deadlineMs: number
}

export type PlanVerifierState = Map<string, PlanVerifierEntry>

export function createPlanVerifierState(): PlanVerifierState {
  return new Map()
}

/**
 * Arm on delivery of a /plan directive. ONE entry per chat: a second /plan in
 * the same chat replaces the first, because the owner asking again is not two
 * separate complaints and two lines would be noise.
 */
export function armPlanVerifier(
  state: PlanVerifierState,
  input: {
    chatId: string | number
    messageId: number
    nowMs: number
    windowMs?: number
  },
): PlanVerifierEntry {
  const windowMs = input.windowMs ?? PLAN_VERIFIER_WINDOW_MS
  const entry: PlanVerifierEntry = {
    chatId: String(input.chatId),
    messageId: input.messageId,
    armedAtMs: input.nowMs,
    deadlineMs: input.nowMs + windowMs,
  }
  state.set(entry.chatId, entry)
  return entry
}

/**
 * Is a /plan verifier armed for this chat right now?
 *
 * Asked by the daemon before it reports session mode `plan` off a card. The
 * card's `door` field is filled by the MODEL, and `typed` is a claim that the
 * owner typed /plan. This state is the daemon's own record of the same fact,
 * written when the directive was DELIVERED, so a model that says `typed` in a
 * chat where nobody typed anything cannot put a Plan mode chip on that chat.
 * Read only: arming and disarming stay with the three functions that own them.
 */
export function isPlanVerifierArmed(
  state: PlanVerifierState,
  chatId: string | number | null | undefined,
): boolean {
  if (chatId == null || chatId === '') return false
  return state.has(String(chatId))
}

/**
 * The first propose_plan call settles it, silently.
 *
 * It settles EVERY armed chat, not only the one the plan was posted in, and
 * that is deliberate. A turn is one model, one transcript: if it proposed a
 * plan anywhere it answered the directive, and firing a "no plan came" line
 * into a second chat because the plan landed in the first would be a false
 * report. The cost of the wide cancel is a missed complaint, which is the safe
 * direction for a message that interrupts an owner.
 */
export function cancelPlanVerifiers(state: PlanVerifierState): PlanVerifierEntry[] {
  const cancelled = [...state.values()]
  state.clear()
  return cancelled
}

/**
 * The Stop hook: the turn finished. Anything still armed in the chat that turn
 * belonged to did not get its plan, so it fires NOW.
 *
 * A null chat id means the hook rail could not say which chat the turn was for
 * (lib/turn-chat.ts resolves it from the transcript and can come up empty). In
 * that case nothing is settled and the timer keeps its job, because firing on
 * every armed chat off an unattributed turn end would post the line into chats
 * whose plan is still coming.
 */
export function endTurnPlanVerifiers(
  state: PlanVerifierState,
  chatId: string | number | null | undefined,
): PlanVerifierEntry[] {
  if (chatId == null || chatId === '') return []
  const key = String(chatId)
  const entry = state.get(key)
  if (!entry) return []
  state.delete(key)
  return [entry]
}

/**
 * Disarm one chat's verifier with NO line posted.
 *
 * Used when the owner closes the Plan mode chip (`/code`): they have withdrawn
 * the request, so a complaint that no plan came would be about a plan nobody
 * is waiting for any more.
 */
export function disarmPlanVerifier(
  state: PlanVerifierState,
  chatId: string | number,
): boolean {
  return state.delete(String(chatId))
}

/**
 * The fallback ending: entries whose window has elapsed. Removed as they are
 * returned, so the line is posted exactly once per arm.
 *
 * A backwards clock cannot fire one early: the comparison is against the stored
 * deadline, and an entry whose deadline is in the future stays put however far
 * the clock moved.
 */
export function duePlanVerifiers(
  state: PlanVerifierState,
  nowMs: number,
): PlanVerifierEntry[] {
  const due: PlanVerifierEntry[] = []
  for (const [key, entry] of state) {
    if (nowMs >= entry.deadlineMs) {
      due.push(entry)
      state.delete(key)
    }
  }
  return due
}
