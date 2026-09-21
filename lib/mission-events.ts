/**
 * What the daemon does when the OWNER changes a mission from the app.
 *
 * Until 0.41.0 missions were entirely PULL based here: the agent created one,
 * ticked it, and read it back. Nothing told the model that its owner had
 * pressed Set aside, Mark done, Pause or Resume, so the agent kept chasing a
 * goal that was already dead on the card the owner was looking at. This module
 * is the decision half of the fix; server.ts holds the socket wiring and the
 * one MCP notification that carries it.
 *
 * Pure and import-safe, like ./missions.ts and ./turn-chat.ts: no I/O, no
 * clock, no env, no process exit. Everything decidable lives here so it is
 * unit testable without importing the 10k line monolith.
 *
 * Four rules bind every string below, each of them learned from a defect:
 *
 *   1. Never throw into the socket handler. parseMissionEvent is TOTAL: junk
 *      in, null out.
 *   2. Channel meta must be ALL STRING valued, or the Claude Code harness
 *      silently drops the card and the notice vanishes with no error anywhere
 *      (lib/voice-rpc.ts:917-919). An empty value is an OMITTED KEY, never ''.
 *   3. No em dash and no en dash in anything that reaches the model
 *      (lib/capabilities.ts:9). There is no compiler behind that rule, so
 *      test/mission-events.test.ts loops every frame and asserts it.
 *   4. A mission title is owner-authored free text up to 200 characters and it
 *      is interpolated into a model-facing string. It is collapsed to one line
 *      and a literal channel marker inside it is defanged, or a crafted title
 *      could forge a second [mission_*] line and give the model instructions
 *      its owner never wrote.
 *
 * What is NARRATED is deliberately narrow: mission_paused, mission_resumed,
 * mission_abandoned, mission_completed, and mission_created when the OWNER
 * started it. mission_ticked is never narrated (the owner cannot tick, so
 * every tick is the agent's own write and the model already has the tool
 * result; telling it again is pure noise in its context window).
 * mission_failed is always an agent write, and mission_updated changes a card
 * the model re-reads on its next mission call, so neither is narrated here.
 */

import {
  MISSION_TITLE_MAX,
  formatMissionSummary,
  type MissionSnapshot,
  type MissionSnapshotStatus,
} from './missions.js'

export const MISSION_FRAMES = [
  'mission_created',
  'mission_ticked',
  'mission_paused',
  'mission_resumed',
  'mission_completed',
  'mission_abandoned',
  'mission_failed',
  'mission_updated',
] as const
export type MissionFrame = (typeof MISSION_FRAMES)[number]

/** The coarse word the channel card is keyed on, so a CLAUDE.md rule or a
 *  future filter can match one token instead of eight frames. Same pattern as
 *  boot_hello and liveness_probe. */
export type MissionNoticeKind =
  | 'mission_cleared'
  | 'mission_paused'
  | 'mission_resumed'
  | 'mission_started'

/** One mission event as the gateway builds it, after parsing. */
export interface MissionEventWire {
  frame: MissionFrame
  mission: MissionSnapshot
  assistantId: string | null
  userId: string | null
  /** The chat the backend resolved for this mission, or null on a backend
   *  older than this stage (and then server.ts falls back to the turn chat). */
  chatId: string | null
  /** 'owner' or 'agent' on a current backend, null on an older one. */
  clearedBy: 'owner' | 'agent' | null
  clearReason: string | null
  tickedGoalId: number | null
}

export interface MissionNotice {
  content: string
  meta: Record<string, string>
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const positiveInt = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
}

const idString = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'string' && v.trim() !== '') return v.trim()
  return null
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * One line, no channel marker, capped at the backend's own title limit.
 *
 * Collapsing the whitespace is what stops a newline starting what LOOKS like a
 * second channel line; defanging a literal `[mission_` is what stops the same
 * forgery on one line. Both are cheap and neither mangles an ordinary title.
 */
function safeText(raw: unknown, max: number): string {
  return String(raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\[(?=mission_)/gi, '(')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

const safeTitle = (raw: unknown): string => safeText(raw, MISSION_TITLE_MAX)

/** The whole snapshot, display-safe, for the one notice that prints a ledger. */
function safeMission(mission: MissionSnapshot): MissionSnapshot {
  return {
    ...mission,
    title: safeTitle(mission.title),
    miniGoals: mission.miniGoals.map((g) => ({
      ...g,
      name: safeText(g.name, 120),
      doneWhen: safeText(g.doneWhen, 200),
    })),
  }
}

/**
 * The gateway envelope in, a typed frame or null out. NEVER throws.
 *
 * `expectedAssistantId` is defence in depth: a paired daemon sits in BOTH the
 * pairing room and its assistant room, and an unsigned pairing can hold more
 * than one assistant, so a frame for a sibling agent is possible and must be
 * dropped rather than narrated to the wrong model. Omit it and no ownership
 * check is made, because inventing one from nothing would be worse.
 *
 * An UNKNOWN status is passed through rather than rejected: the notice text is
 * chosen by the FRAME, the status only rides the meta, and a notice must not
 * vanish because a newer backend grew a sixth value.
 */
export function parseMissionEvent(
  frame: string,
  payload: unknown,
  expectedAssistantId?: string | number | null,
): MissionEventWire | null {
  try {
    if (!(MISSION_FRAMES as readonly string[]).includes(frame)) return null
    if (!isPlainObject(payload)) return null

    const rawMission = payload.mission
    if (!isPlainObject(rawMission)) return null
    const id = positiveInt(rawMission.id)
    if (id == null) return null

    const assistantId = idString(payload.assistant_id ?? payload.assistantId)
    const expected = idString(expectedAssistantId)
    if (expected != null && assistantId !== expected) return null

    const rawGoals = Array.isArray(rawMission.miniGoals) ? rawMission.miniGoals : []
    const miniGoals: MissionSnapshot['miniGoals'] = []
    for (const raw of rawGoals) {
      if (!isPlainObject(raw)) continue
      const goalId = positiveInt(raw.id)
      if (goalId == null) continue
      miniGoals.push({
        id: goalId,
        name: text(raw.name),
        doneWhen: text(raw.doneWhen),
        done: raw.done === true,
        doneAt: typeof raw.doneAt === 'string' ? raw.doneAt : null,
        evidence: typeof raw.evidence === 'string' ? raw.evidence : null,
      })
    }

    const status = typeof rawMission.status === 'string' && rawMission.status
      ? (rawMission.status as MissionSnapshotStatus)
      : 'active'

    const mission: MissionSnapshot = {
      id,
      title: text(rawMission.title),
      status,
      miniGoals,
      chatId: positiveInt(rawMission.chatId),
      createdByAssistant:
        typeof rawMission.createdByAssistant === 'boolean'
          ? rawMission.createdByAssistant
          : undefined,
      pausedReason: typeof rawMission.pausedReason === 'string' ? rawMission.pausedReason : null,
      doneWhen: typeof rawMission.doneWhen === 'string' ? rawMission.doneWhen : null,
      updatedAt: typeof rawMission.updatedAt === 'string' ? rawMission.updatedAt : undefined,
    }

    const clearedByRaw = payload.cleared_by ?? payload.clearedBy
    const clearedBy =
      clearedByRaw === 'owner' || clearedByRaw === 'agent' ? clearedByRaw : null

    return {
      frame: frame as MissionFrame,
      mission,
      assistantId,
      userId: idString(payload.user_id ?? payload.userId),
      chatId: idString(payload.chat_id ?? payload.chatId) ?? null,
      clearedBy,
      clearReason: typeof payload.clear_reason === 'string' ? payload.clear_reason : null,
      tickedGoalId: positiveInt(payload.ticked_goal_id ?? payload.tickedGoalId),
    }
  } catch {
    return null
  }
}

/** The bounded-dedupe key for ONE delivery of ONE frame. `updatedAt` is bumped
 *  on every backend write, so it separates two real changes to one mission;
 *  the frame separates two frames that ride the same write. */
export function missionEventKey(event: MissionEventWire): string {
  return `${event.frame}:${event.mission.id}:${event.mission.updatedAt ?? ''}`
}

/**
 * The frames a PENDING self-write stamp is allowed to answer for.
 *
 * server.ts stamps the mission id BEFORE a tick or a complete request leaves,
 * because the WS frame the write causes can beat the HTTP response home and
 * the after-the-fact stamp (id plus updatedAt) is not written yet. One stamp
 * answers for ONE frame, so the two frames that are NEVER narrated are kept
 * out of this list: a tick that closes the last open goal emits mission_ticked
 * AND mission_completed off one call, and a tick that spent the stamp would
 * leave the completion looking like the owner's own Mark done.
 */
export const MISSION_SELF_WRITE_FRAMES: readonly MissionFrame[] = [
  'mission_created',
  'mission_paused',
  'mission_resumed',
  'mission_completed',
  'mission_abandoned',
  'mission_failed',
]

/**
 * May this frame spend a pending self-write stamp?
 *
 * Only when the backend did NOT say who wrote it. A backend of this stage
 * stamps `cleared_by` and that is the better answer; spending a stamp there
 * would leave the owner's NEXT change to the same mission unstamped and
 * therefore silent.
 */
export function missionFrameConsumesSelfWrite(event: MissionEventWire): boolean {
  if (event.clearedBy !== null) return false
  return MISSION_SELF_WRITE_FRAMES.includes(event.frame)
}

/** The self-write stamp key: the WRITE, whatever frame it arrives as. The
 *  agent's own create emits mission_created AND (on a replace) an abandon for
 *  the mission it displaced, so the stamp must not be keyed on the frame. */
export function missionSelfWriteKey(mission: {
  id: number
  updatedAt?: string
}): string {
  return `${mission.id}:${mission.updatedAt ?? ''}`
}

/** How many mission stamps a daemon keeps. It runs for weeks; the set does
 *  not. Matched to server.ts's forward cache so the two age alike. */
export const MISSION_SELF_WRITE_MAX = 200

/**
 * What this daemon wrote itself, so the event it caused is not narrated back
 * to the model that caused it.
 *
 * TWO stamps, because one write produces two chances to get this wrong.
 *
 *  - PENDING, by mission id, taken BEFORE the request leaves. The backend
 *    emits the WS frame inside the same transaction it answers the HTTP call
 *    from, so the frame regularly beats the response home. A daemon that only
 *    stamped the response had nothing in hand at that moment, and told the
 *    model that its owner had marked done the mission the model had just
 *    finished ticking itself. It is spent once, by one frame, so a later
 *    change by the owner to the same mission is still heard.
 *  - WRITTEN, by mission id plus updatedAt, taken when the response lands.
 *    It is not made redundant by the pending stamp: a frame delivered after
 *    the response (a reconnect catch up is the real case) finds no pending
 *    stamp, and the per-write key is what answers for it. It is not consumed,
 *    because both copies of one delivery are the same write.
 *
 * Neither stamp is needed against a backend of this stage, which names the
 * author on the wire; they are what keep a daemon in the field honest against
 * a backend that does not, and they cost two bounded sets.
 */
export interface MissionSelfWriteLedger {
  /** This daemon is ABOUT to write that mission. Call before the request. */
  notePending(missionId: unknown): void
  /** This daemon's write landed, with the snapshot it answered. */
  noteWritten(mission: unknown): void
  /** Did this daemon write the mission this frame is about? Spends a pending
   *  stamp when the frame is one that may spend it. */
  isSelfAuthored(event: MissionEventWire): boolean
  /** What is remembered right now. For the bound test, and for a log line. */
  size(): { pending: number; written: number }
}

export function createMissionSelfWriteLedger(
  limit: number = MISSION_SELF_WRITE_MAX,
): MissionSelfWriteLedger {
  const cap = Number.isInteger(limit) && limit > 0 ? limit : MISSION_SELF_WRITE_MAX
  const pending = new Set<number>()
  const written = new Set<string>()

  const evict = (set: Set<unknown>): void => {
    while (set.size > cap) {
      const first = set.values().next().value
      if (first === undefined) return
      set.delete(first)
    }
  }

  return {
    notePending(missionId) {
      const id = typeof missionId === 'number' ? missionId : Number.NaN
      if (!Number.isSafeInteger(id) || id <= 0) return
      pending.add(id)
      evict(pending)
    },
    noteWritten(mission) {
      const m = mission as { id?: unknown; updatedAt?: unknown } | null | undefined
      const id = m?.id
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return
      written.add(
        missionSelfWriteKey({
          id,
          updatedAt: typeof m?.updatedAt === 'string' ? m.updatedAt : undefined,
        }),
      )
      evict(written)
    },
    isSelfAuthored(event) {
      // Both are read, and the pending one is SPENT whenever it may be, even
      // when the written stamp already answered: the stamp was taken for this
      // frame, and leaving it behind would swallow the owner's next change.
      const byWrite = written.has(missionSelfWriteKey(event.mission))
      let byPending = false
      if (missionFrameConsumesSelfWrite(event) && pending.has(event.mission.id)) {
        pending.delete(event.mission.id)
        byPending = true
      }
      return byWrite || byPending
    },
    size: () => ({ pending: pending.size, written: written.size }),
  }
}

function clearedContent(event: MissionEventWire, title: string): string | null {
  const { mission } = event
  if (event.frame === 'mission_abandoned') {
    // A mission the owner REPLACED is not a mission the owner set aside.
    // createMission closes the chat's open mission to make room for the new
    // one and stamps that abandon `replaced`; the [mission_started] notice
    // riding the same write already says the new mission replaced any that
    // was open. Telling the model to STOP and post a "where I stopped" line
    // for the mission its owner just swapped out contradicts the start notice
    // it is about to read.
    if (event.clearReason === 'replaced') return null
    return (
      `[mission_cleared] Your owner SET ASIDE mission #${mission.id} "${title}". That mission ` +
      'is over. Stop working on it now: start no new steps for it, do not call tick_mini_goal ' +
      'or complete_mission for it (the server refuses writes to a closed mission), and never ' +
      'cite it again as something you are pursuing. If you were mid step, send ONE short line ' +
      'to that chat saying where you stopped, then stop. Do not create a replacement mission ' +
      'unless your owner asks for one. Other chats and other work are unaffected.'
    )
  }
  if (event.frame === 'mission_completed') {
    const total = mission.miniGoals.length
    const done = mission.miniGoals.filter((g) => g.done).length
    return (
      `[mission_cleared] Your owner marked mission #${mission.id} "${title}" DONE (${done} of ` +
      `${total} mini goals ticked). It is closed. Stop working on it and tick nothing further; ` +
      'the server refuses writes to a closed mission. Do not re open it and do not start a ' +
      'replacement unless your owner asks. If you were mid step, send ONE short line saying ' +
      'where you stopped.'
    )
  }
  return null
}

/**
 * The whole "say something / say nothing" decision, and the exact words.
 *
 * Null means say nothing, and silence is the default for everything that is
 * not in the narrated five. `selfAuthored` comes from the self-write stamp
 * server.ts records at each mission tool call, and `alreadySeen` from the
 * bounded frame dedupe: a paired daemon sits in two rooms that both carry
 * mission traffic, and a daemon in the field outlives a backend deploy, so the
 * dedupe holds whatever the backend does.
 *
 * Owner authored means `cleared_by === 'owner'`. A backend older than this
 * stage sends no `cleared_by` at all; then every frame whose write this daemon
 * did not stamp is treated as owner authored, which errs toward telling the
 * model once too often rather than never.
 */
export function decideMissionNotice(input: {
  event: MissionEventWire
  chatId: string | null
  selfAuthored: boolean
  alreadySeen: boolean
}): MissionNotice | null {
  const { event, chatId, selfAuthored, alreadySeen } = input
  if (alreadySeen || selfAuthored) return null
  if (event.clearedBy === 'agent') return null

  const mission = event.mission
  const title = safeTitle(mission.title)
  let kind: MissionNoticeKind
  let content: string

  switch (event.frame) {
    case 'mission_abandoned':
    case 'mission_completed': {
      const built = clearedContent(event, title)
      if (built == null) return null
      kind = 'mission_cleared'
      content = built
      break
    }
    case 'mission_paused': {
      const reason = safeText(mission.pausedReason, 200)
      kind = 'mission_paused'
      content =
        `[mission_paused] Your owner PAUSED mission #${mission.id} "${title}"` +
        (reason ? `. Reason: ${reason}` : '') +
        '. Stand down on that mission now: start no new steps and no new tool calls for it. ' +
        'The server refuses ticks while a mission is paused, so do not try. Wait for a resume; ' +
        'say nothing to the user about the pause unless you were mid step, in which case send ' +
        'ONE short line saying where you stopped. Other chats and other work are unaffected.'
      break
    }
    case 'mission_resumed': {
      const next = mission.miniGoals.find((g) => !g.done)
      kind = 'mission_resumed'
      content =
        `[mission_resumed] Your owner RESUMED mission #${mission.id} "${title}". ` +
        (next
          ? `Pick it up from the next open mini goal (${next.id}. ${safeText(next.name, 120)}, ` +
            `done when ${safeText(next.doneWhen, 200)}) and carry on. `
          : 'Pick it up and carry on. ') +
        'Do not redo the mini goals that are already ticked.'
      break
    }
    case 'mission_created': {
      // Only the OWNER's own creates. The agent's create already returned the
      // full snapshot as its tool result.
      if (mission.createdByAssistant !== false) return null
      kind = 'mission_started'
      content =
        `[mission_started] Your owner STARTED mission #${mission.id} "${title}" with ` +
        `${mission.miniGoals.length} mini goals. This is the mission you are pursuing now, ` +
        'and it replaced any mission that was open. Work it and tick each mini goal with ' +
        'tick_mini_goal the moment its check is true. Reply once, short, with how you will ' +
        'start.\n' +
        formatMissionSummary(safeMission(mission))
      break
    }
    default:
      // mission_ticked, mission_failed and mission_updated: never narrated.
      return null
  }

  const meta: Record<string, string> = { event_type: kind, mission_event: event.frame }
  const put = (key: string, value: string | null | undefined): void => {
    if (typeof value === 'string' && value !== '') meta[key] = value
  }
  put('mission_id', String(mission.id))
  put('mission_status', mission.status)
  put('mission_title', title)
  put('chat_id', chatId)
  put('assistant_id', event.assistantId)
  meta.requested_by = 'user'

  return { content, meta }
}
