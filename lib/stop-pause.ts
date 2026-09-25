/**
 * The armed goal case: an owner Stop pauses the mission its armed goal is
 * looping on, and the owner's next message resumes it (P6 stage 3, C-32,
 * spec 4.3 and D13 item 3).
 *
 * WHY THIS EXISTS. Claude Code's stop is cooperative: the [stop_turn] notice
 * asks the live model to stand down on one chat, and nothing is killed. That
 * is enough on its own, EXCEPT while Keep working is armed: the native /goal
 * runs its own Stop hook, which re prompts the model the moment it stands
 * down, so a cooperative stop would not stick and the loop would carry on
 * behind the owner's back. The only way this daemon can stop that loop is the
 * way the owner's own Pause already does: pause the mission, whose echo
 * reaches the goal lane (server.ts applyMissionFrameToGoalLane), which types
 * `/goal clear` into the session and REMEMBERS the condition. So the Stop
 * pauses, with the contract's STOP_PAUSE_REASON, and the owner's next message
 * in that chat resumes, whose echo arms the same goal again.
 *
 * WHEN, exactly (every rule has a test in test/stop-pause.test.ts):
 *   - only where this daemon can type into its session, which is where it
 *     declares mission_pause on this beat (lib/declared-capabilities.ts);
 *   - only while its goal lane holds a goal it is writing onto, or an arm it
 *     typed and has not had answered, for the mission that IS the stopped
 *     chat's open mission, and only while that mission is active: a mission
 *     the owner already paused keeps their reason;
 *   - resumed only on an OWNER authored message in that chat (never a peer
 *     agent, a wake, a meeting turn or another person), and only a mission
 *     paused with exactly STOP_PAUSE_REASON, so an owner's own Pause from the
 *     Mission view is never undone by a message;
 *   - the first owner message in a chat after the daemon starts asks the
 *     server, because a restart forgets what this process paused (spec D12),
 *     and a read that fails is asked again on the owner's next message;
 *   - an owner message that races the Stop's own pause waits for it, so a
 *     quick Resume ends active, never paused (spec D11).
 *
 * Both writes are stamped as this daemon's own BEFORE the request goes out,
 * with the same ledger every mission tool uses (lib/mission-events.ts): the
 * backend emits the frame from inside the transaction it answers from, so the
 * echo beats the answer home, and an unstamped pause echo would be narrated
 * to the model as its owner's own Pause.
 *
 * Pure over injected I/O and import safe, like ./goal-writes.ts: no clock of
 * its own beyond the one bounded wait, no env, no socket. It NEVER throws: it
 * runs from the stop handler and from the inbound rails, and a failure here
 * must cost a pause, never a delivered message. server.ts holds the wiring,
 * pinned by test/stop-pause-wiring.test.ts.
 */

import { STOP_PAUSE_REASON } from './session-controls-contract.ts'
import type { GoalPendingArm } from './goal-writes.ts'
import type { MissionSnapshot } from './missions.ts'

/** The goal lane as server.ts holds it at the moment a Stop is delivered. */
export interface StopGoalView {
  /** mission_pause is declared on this beat: the injector answers, so this
   *  daemon can clear the native goal, which is what makes the pause hold. */
  pauseDeclared: boolean
  /** The goal the lane is reporting on (server.ts goalHeld), whoever typed
   *  it. It survives a pause, so on its own it does not mean "armed". */
  held: { missionId: number; condition: string } | null
  /** The mission the ARMED goal writes onto (server.ts goalMissionId). Null
   *  once the goal is paused, cleared or closed. */
  attachedMissionId: number | null
  /** An arm this daemon typed whose set sentinel has not come back yet
   *  (server.ts goalPendingArm). */
  pending: GoalPendingArm | null
  /** This daemon already stopped the loop itself, on the owner's turn cap or
   *  a stall (server.ts goalStopped). */
  loopStopped?: boolean
}

/**
 * The mission an armed goal is looping on, or null when nothing is armed.
 *
 * "Armed" is narrower than "held": the lane keeps a paused goal's condition so
 * a Resume can put it back, and pausing that mission again on a Stop would be
 * a second pause of work that is not running.
 */
export function armedGoalMissionFor(view: StopGoalView): number | null {
  if (view.pauseDeclared !== true) return null
  if (view.loopStopped === true) return null
  const held = view.held
  if (held === null) return null
  if (view.attachedMissionId === held.missionId) return held.missionId
  const pending = view.pending
  if (pending !== null && pending.missionId === held.missionId && !pending.stopped) {
    return held.missionId
  }
  return null
}

/** A mission this daemon (or another process of it) paused on a Stop: paused
 *  with EXACTLY the contract reason, and nothing else. */
export function isStopPausedMission(
  mission: MissionSnapshot | null | undefined,
): mission is MissionSnapshot {
  return (
    mission != null && mission.status === 'paused' && mission.pausedReason === STOP_PAUSE_REASON
  )
}

/**
 * Is this inbound message the OWNER typing, the one thing that resumes?
 *
 * A peer agent (agentOrigin, or a sender labelled agent), a wake or any other
 * automation (system), and a person the agent is shared with are not. An older
 * backend stamps no sender kind on a user row, which reads as a user.
 */
export function isOwnerAuthoredInbound(input: {
  senderType: string | null | undefined
  agentOrigin: unknown
  userId: string | null | undefined
  ownerUserId: string
}): boolean {
  if (input.agentOrigin != null) return false
  const kind = input.senderType == null || input.senderType === '' ? 'user' : input.senderType
  if (kind !== 'user') return false
  return typeof input.userId === 'string' && input.userId !== '' && input.userId === input.ownerUserId
}

export interface StopPauseLaneDeps {
  /** The chat's open mission (active or paused) as the server has it, or null. */
  readOpenMission(chatId: string): Promise<MissionSnapshot | null>
  /** PATCH pause with the reason; the snapshot the server answered. */
  pauseMission(missionId: number, reason: string): Promise<MissionSnapshot | null>
  /** PATCH resume; the snapshot the server answered. */
  resumeMission(missionId: number): Promise<MissionSnapshot | null>
  /** The self write ledger's PENDING stamp, taken before the request. */
  notePendingSelfWrite(missionId: number): void
  /** The self write ledger's WRITTEN stamp, taken when the answer lands. */
  noteSelfWritten(mission: MissionSnapshot): void
  log(line: string): void
  /** How long an owner message waits for this chat's earlier stop or resume
   *  to settle before it decides anyway. Default 10 s, Codex's bound. */
  settleTimeoutMs?: number
}

export type StopPauseOutcome =
  | { kind: 'paused'; missionId: number }
  | { kind: 'skipped'; why: string }
  | { kind: 'failed'; why: string }

export type StopResumeOutcome =
  | { kind: 'resumed'; missionId: number }
  | { kind: 'skipped'; why: string }
  | { kind: 'failed'; why: string }

const DEFAULT_SETTLE_TIMEOUT_MS = 10_000

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class StopPauseLane {
  // No TS parameter properties: node --test runs lib files in strip-only
  // mode in places, which rejects them (see lib/voice-rpc.ts VoiceRpcError).
  private readonly deps: StopPauseLaneDeps
  private readonly settleTimeoutMs: number
  /** chat id to the mission a Stop paused in this process. */
  private readonly pausedByChat = new Map<string, number>()
  /** Chats whose open mission has been read, successfully, since this
   *  process started. A failed read never lands a chat here. */
  private readonly checkedChats = new Set<string>()
  /** Per chat, the last stop or resume in flight: each one waits for the
   *  one before it, so a quick Resume can never overtake the Stop's pause. */
  private readonly tails = new Map<string, Promise<unknown>>()

  constructor(deps: StopPauseLaneDeps) {
    this.deps = deps
    const bound = deps.settleTimeoutMs
    this.settleTimeoutMs =
      typeof bound === 'number' && Number.isFinite(bound) && bound >= 0 ? bound : DEFAULT_SETTLE_TIMEOUT_MS
  }

  /**
   * The [stop_turn] notice reached the live session for this chat. Pause the
   * armed goal's mission when it is this chat's open, active mission. The
   * view is the goal lane as it was when the stop landed; the caller takes it
   * synchronously.
   */
  stopDelivered(chatId: string, view: StopGoalView): Promise<StopPauseOutcome> {
    const armed = armedGoalMissionFor(view)
    if (armed === null) {
      return Promise.resolve({ kind: 'skipped', why: 'no armed goal where this daemon can pause' })
    }
    return this.inTurn(chatId, () => this.pauseFor(chatId, armed), { kind: 'failed', why: 'unexpected' })
  }

  /**
   * An OWNER authored message for this chat is being delivered to the model.
   * Resume the mission a Stop paused, when there is one. The caller decides
   * who wrote the message (isOwnerAuthoredInbound); this only runs for the
   * owner.
   */
  ownerMessage(chatId: string): Promise<StopResumeOutcome> {
    return this.inTurn(chatId, () => this.resumeFor(chatId), { kind: 'failed', why: 'unexpected' })
  }

  private async pauseFor(chatId: string, armed: number): Promise<StopPauseOutcome> {
    let open: MissionSnapshot | null
    try {
      open = await this.deps.readOpenMission(chatId)
    } catch (err) {
      this.deps.log(`stop pause: could not read chat ${chatId}'s open mission: ${errorText(err)}`)
      return { kind: 'failed', why: 'read' }
    }
    if (open === null || open.id !== armed) {
      return { kind: 'skipped', why: `the armed goal's mission #${armed} is not chat ${chatId}'s open mission` }
    }
    if (open.status !== 'active') {
      // The owner paused it already (their reason stands), or it closed.
      return { kind: 'skipped', why: `mission #${armed} is ${open.status}` }
    }
    // BEFORE the request, never after the answer: the echo beats the answer.
    this.deps.notePendingSelfWrite(armed)
    let answer: MissionSnapshot | null
    try {
      answer = await this.deps.pauseMission(armed, STOP_PAUSE_REASON)
    } catch (err) {
      this.deps.log(`stop pause: mission #${armed} could not be paused: ${errorText(err)}`)
      return { kind: 'failed', why: 'pause' }
    }
    if (answer !== null) this.deps.noteSelfWritten(answer)
    if (!isStopPausedMission(answer)) {
      return { kind: 'skipped', why: `mission #${armed} did not come back paused by the stop` }
    }
    this.pausedByChat.set(chatId, armed)
    this.deps.log(`stop pause: mission #${armed} in chat ${chatId} paused, the owner's next message resumes it`)
    return { kind: 'paused', missionId: armed }
  }

  private async resumeFor(chatId: string): Promise<StopResumeOutcome> {
    const remembered = this.pausedByChat.get(chatId)
    if (remembered === undefined && this.checkedChats.has(chatId)) {
      return { kind: 'skipped', why: 'nothing stop paused in this chat' }
    }
    let open: MissionSnapshot | null
    try {
      open = await this.deps.readOpenMission(chatId)
    } catch (err) {
      this.deps.log(`stop resume: could not read chat ${chatId}'s open mission: ${errorText(err)}`)
      // The chat is NOT marked checked: a failed read proves nothing about
      // what the server holds, so the next owner message asks again (spec
      // D11 and D12, and Codex's noteOwnerTurn). This covers the restart
      // probe of a chat this process never paused, too: a stop pause from
      // before the restart would otherwise stay paused for good.
      return { kind: 'failed', why: 'read' }
    }
    this.checkedChats.add(chatId)
    if (!isStopPausedMission(open)) {
      this.pausedByChat.delete(chatId)
      return { kind: 'skipped', why: 'no mission paused by a stop in this chat' }
    }
    const missionId = open.id
    this.deps.notePendingSelfWrite(missionId)
    let answer: MissionSnapshot | null
    try {
      answer = await this.deps.resumeMission(missionId)
    } catch (err) {
      this.deps.log(`stop resume: mission #${missionId} could not be resumed: ${errorText(err)}`)
      this.pausedByChat.set(chatId, missionId)
      return { kind: 'failed', why: 'resume' }
    }
    if (answer !== null) this.deps.noteSelfWritten(answer)
    this.pausedByChat.delete(chatId)
    this.deps.log(`stop resume: mission #${missionId} in chat ${chatId} resumed on the owner's message`)
    return { kind: 'resumed', missionId }
  }

  /** Run after this chat's earlier stop or resume, waiting at most the
   *  settle bound for it, and never reject: anything unexpected is logged
   *  and answered with `failed`. */
  private inTurn<T>(chatId: string, run: () => Promise<T>, failed: T): Promise<T> {
    const before = this.tails.get(chatId) ?? Promise.resolve()
    const next = this.bounded(before).then(run)
    const tail = next.catch(() => undefined)
    this.tails.set(chatId, tail)
    void tail.then(() => {
      if (this.tails.get(chatId) === tail) this.tails.delete(chatId)
    })
    return next.catch((err: unknown) => {
      try {
        this.deps.log(`stop pause lane: ${errorText(err)}`)
      } catch {
        // A logger that throws must not reject into the inbound path either.
      }
      return failed
    })
  }

  private bounded(before: Promise<unknown>): Promise<void> {
    if (this.settleTimeoutMs === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.settleTimeoutMs)
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        ;(timer as { unref: () => void }).unref()
      }
      before.then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        () => {
          clearTimeout(timer)
          resolve()
        },
      )
    })
  }
}
