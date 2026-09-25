/**
 * Pure, side-effect-free builders for the `create_mission` / `tick_mini_goal`
 * / `complete_mission` MCP tools (BGOS capability #20, Missions).
 *
 * Like ./lib/schedule.ts, everything here is deterministic and import-safe
 * (no env reads, no network, no clock, no process exit), so it can be unit
 * and eval tested directly. server.ts imports these for the CallTool
 * handlers; the eval suite (test/missions.test.ts) imports them too.
 *
 * Wire contract (user-scoped routes; the plugin authenticates with X-API-Key
 * and its assistants have pairingId = null, so the /integrations twins used
 * by pairing-managed plugins do not apply here):
 *
 *   POST  assistants/:assistantId/missions                      create
 *   GET   assistants/:assistantId/missions/active               { mission | null }
 *   PATCH assistants/:assistantId/missions/:missionId/tick      { goalId, evidence? }
 *   PATCH assistants/:assistantId/missions/:missionId/complete  { summary? }
 *   PATCH assistants/:assistantId/missions/:missionId/progress  the goal lane
 *   PATCH assistants/:assistantId/missions/:missionId/fail      the goal lane
 *
 * The last two are the GOAL LANE's (stage 6). They are not tool calls: the
 * daemon builds them from what the runtime's own checker wrote into the
 * session transcript, so their inputs are typed rather than snake_case tool
 * args. Two blocks ride them, and three rules bind both:
 *
 *   verdict    { verdict, reason, by?, check? }, the checker's answer
 *   runReport  { turnsUsed?, turnCap?, workingMs? }, what the RUNTIME counted
 *
 * 1. NEVER SEND `at`, `source` OR ANYTHING ELSE THE SERVER OWNS. When a check
 *    happened, and whose runtime counted a turn, are stamped by the server;
 *    the ValidationPipe strips them on the way in, so sending one is not an
 *    error, it is a lie with no error anywhere.
 * 2. A COUNT NOBODY COUNTED IS WORSE THAN NO COUNT. A run report field the
 *    wire cannot carry is DROPPED, never clamped, and a run report with no
 *    usable field left is omitted whole. The app draws each half only when it
 *    is present, so absent is a finished view and a clamped 900 is a lie.
 * 3. AN ABSENT BLOCK IS AN ABSENT KEY. Never `verdict: null`, never an empty
 *    object: the backend runs whitelist: true and would strip or reject it.
 *
 * Create body: { title, miniGoals: [{ name, doneWhen }], chatId? }.
 * Complete body: { summary? }, where summary is at most 500 chars. The backend
 * accepts 2..12 goals (the trained flow targets 4 to 10), assigns goal ids
 * 1..n, auto-completes on the last tick, and treats a tick of an already-done
 * goal as an idempotent no-op. All write responses embed the full mission
 * snapshot as { ok, mission }; the active read returns { mission | null }.
 *
 * A mission belongs to ONE CHAT. `chatId` on the create body names it, and
 * `?chatId=` on the active read asks for that chat's open mission. OMITTING
 * the chat means the agent's MAIN chat, which is exactly what a single-chat
 * agent has always meant, so the requests below are byte identical to the
 * pre-0.41.0 ones when no chat is named. Each chat holds at most one open
 * mission, so creating one in chat A never sets aside chat B's mission. Never
 * send `chatId: null`: the backend's ValidationPipe runs with whitelist: true
 * and strips an undeclared or wrongly typed field in silence, so a null would
 * be a lie with no error anywhere.
 *
 * Validation failures return { ok: false, error } rather than throwing, so
 * the thin server wiring can relay a clear, actionable message to the agent
 * as the tool result.
 */

export const MISSION_MIN_GOALS = 2
export const MISSION_MAX_GOALS = 12
export const MISSION_TITLE_MAX = 200
export const MISSION_GOAL_NAME_MAX = 120
export const MISSION_DONE_WHEN_MAX = 200
export const MISSION_EVIDENCE_MAX = 200
export const MISSION_SUMMARY_MAX = 500
/** MissionFeedEntryInputDto.text. */
export const MISSION_FEED_TEXT_MAX = 200
/** MissionVerdictInputDto.reason. */
export const MISSION_VERDICT_REASON_MAX = 240
/** MissionVerdictInputDto.check. */
export const MISSION_VERDICT_CHECK_MAX = 999
/** MissionRunReportInputDto.turnsUsed. */
export const MISSION_TURNS_USED_MAX = 100_000
/** MissionRunReportInputDto.turnCap, and the owner's own cap range. */
export const MISSION_TURN_CAP_MAX = 200
/** MissionRunReportInputDto.workingMs, one day. */
export const MISSION_WORKING_MS_MAX = 86_400_000

/** What the trained flow should aim for (the hard caps are 2..12). */
export const MISSION_TARGET_RANGE = '4 to 10'

export interface MissionGoalBody {
  name: string
  doneWhen: string
}

export interface MissionCreateBody {
  title: string
  miniGoals: MissionGoalBody[]
  /** Present ONLY when the caller named a chat. Never null: see the header. */
  chatId?: number
}

export interface MissionTickBody {
  goalId: number
  evidence?: string
}

/** The three words a checker can return, the backend's MISSION_VERDICTS. */
export const MISSION_VERDICTS = ['met', 'not_yet', 'impossible'] as const
export type MissionVerdictWord = (typeof MISSION_VERDICTS)[number]

/** The five feed kinds the backend accepts (MISSION_FEED_KINDS). */
export const MISSION_FEED_KINDS = [
  'started',
  'worked',
  'checked',
  'paused',
  'resumed',
  'done',
  'failed',
] as const
export type MissionFeedKind = (typeof MISSION_FEED_KINDS)[number]

/** The checker's answer, as it goes ON THE WIRE. No `at`: see rule 1. */
export interface MissionVerdictBody {
  verdict: MissionVerdictWord
  reason: string
  by?: 'checker' | 'agent'
  check?: number
}

/** What the runtime counted. No `source`: see rule 1. */
export interface MissionRunReportBody {
  turnsUsed?: number
  turnCap?: number
  workingMs?: number
}

export interface MissionFeedEntryBody {
  kind: MissionFeedKind
  text: string
}

export interface MissionCompleteBody {
  summary?: string
  verdict?: MissionVerdictBody
  runReport?: MissionRunReportBody
}

export interface MissionFailBody {
  summary?: string
  verdict?: MissionVerdictBody
  runReport?: MissionRunReportBody
}

export interface MissionProgressBody {
  feedEntry?: MissionFeedEntryBody
  effort?: { used: number; budget: number; unit: 'turns' }
  verdict?: MissionVerdictBody
  runReport?: MissionRunReportBody
}

/** What a caller hands in. Every count may be null, because a runtime that
 *  counted nothing must be able to say so without inventing a zero. */
export interface MissionRunReportInput {
  turnsUsed?: number | null
  turnCap?: number | null
  workingMs?: number | null
}

export interface MissionVerdictInput {
  verdict: MissionVerdictWord
  reason: string
  by?: 'checker' | 'agent'
  check?: number | null
}

export interface MissionProgressInput {
  feedEntry?: MissionFeedEntryBody
  effort?: { used: number; budget: number }
  verdict?: MissionVerdictInput
  runReport?: MissionRunReportInput
}

/** The five wire statuses (backend MissionDto.status). The union was three
 *  for as long as the tools only ever wrote, and 'paused' and 'failed' have
 *  always been on the wire: now that the daemon LISTENS for the owner's own
 *  pause, a narrow union would type every new path against a lie. */
export type MissionSnapshotStatus =
  | 'active'
  | 'paused'
  | 'completed'
  | 'abandoned'
  | 'failed'

/** The mission snapshot shape the backend returns (subset the tools read).
 *  Everything below `miniGoals` is OPTIONAL because an older backend does not
 *  send it and a reader must degrade rather than blank the notice. */
export interface MissionSnapshot {
  id: number
  title: string
  status: MissionSnapshotStatus
  miniGoals: Array<{
    id: number
    name: string
    doneWhen: string
    done: boolean
    doneAt: string | null
    evidence: string | null
  }>
  /** The chat this mission belongs to; null (or absent) means the main chat. */
  chatId?: number | null
  /** True when the AGENT created it, false when the owner did. The notice
   *  builder tells the model only about the owner's own creates. */
  createdByAssistant?: boolean
  /** The reason the owner typed when pausing, shown to them on the strip. */
  pausedReason?: string | null
  /** The mission-level done-when line, when the owner wrote one. */
  doneWhen?: string | null
  /** Bumped on EVERY write, so it is a precise per-write key for the self
   *  write stamp and the frame dedupe in server.ts. */
  updatedAt?: string
  /** The owner's Keep working instruction for THIS mission. Absent means a
   *  backend older than the column, which is read as false. */
  keepWorking?: boolean
  /** The owner's turn limit for THIS mission, null when Keep working is off. */
  turnCap?: number | null
}

export type MissionBuildResult<T> = { ok: true; body: T } | { ok: false; error: string }
export type MissionPathResult = { ok: true; path: string } | { ok: false; error: string }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const GOALS_HELP =
  `mini_goals must be an array of ${MISSION_MIN_GOALS}..${MISSION_MAX_GOALS} binary goals ` +
  `(aim for ${MISSION_TARGET_RANGE}), each { name, done_when } where done_when states the ` +
  'observable check that proves the goal, e.g. "the URL returns 200".'

/**
 * The 2..12 { name, done_when } goals a create and a set-goals write share,
 * validated once so the two tools can never disagree about what a goal is.
 */
function parseMissionGoals(mini_goals: unknown): MissionBuildResult<MissionGoalBody[]> {
  if (!Array.isArray(mini_goals)) {
    return { ok: false, error: GOALS_HELP }
  }
  if (mini_goals.length < MISSION_MIN_GOALS || mini_goals.length > MISSION_MAX_GOALS) {
    return {
      ok: false,
      error:
        `A mission needs ${MISSION_MIN_GOALS} to ${MISSION_MAX_GOALS} mini-goals, got ` +
        `${mini_goals.length}. Aim for ${MISSION_TARGET_RANGE}: decompose the request into ` +
        'binary outcomes, not keystrokes.',
    }
  }

  const miniGoals: MissionGoalBody[] = []
  for (let i = 0; i < mini_goals.length; i++) {
    const raw = mini_goals[i]
    if (!isPlainObject(raw)) {
      return { ok: false, error: `Mini-goal ${i + 1} is not an object. ${GOALS_HELP}` }
    }
    const name = raw.name
    // done_when is the documented tool key; doneWhen is accepted as an alias
    // so an agent echoing the wire shape back is not punished for it.
    const doneWhenRaw = raw.done_when !== undefined ? raw.done_when : raw.doneWhen
    if (typeof name !== 'string' || !name.trim()) {
      return { ok: false, error: `Mini-goal ${i + 1} needs a non-empty name.` }
    }
    if (typeof doneWhenRaw !== 'string' || !doneWhenRaw.trim()) {
      return {
        ok: false,
        error:
          `Mini-goal ${i + 1} ("${name.trim().slice(0, 40)}") needs a done_when line: the ` +
          'observable check that proves it, e.g. "the URL returns 200".',
      }
    }
    const trimmedName = name.trim()
    const trimmedDoneWhen = doneWhenRaw.trim()
    if (trimmedName.length > MISSION_GOAL_NAME_MAX) {
      return {
        ok: false,
        error: `Mini-goal ${i + 1} name is too long (${trimmedName.length} chars, max ${MISSION_GOAL_NAME_MAX}).`,
      }
    }
    if (trimmedDoneWhen.length > MISSION_DONE_WHEN_MAX) {
      return {
        ok: false,
        error:
          `Mini-goal ${i + 1} done_when is too long (${trimmedDoneWhen.length} chars, ` +
          `max ${MISSION_DONE_WHEN_MAX}).`,
      }
    }
    miniGoals.push({ name: trimmedName, doneWhen: trimmedDoneWhen })
  }
  return { ok: true, body: miniGoals }
}

/** PUT integrations/assistants/:id/missions/:missionId/goals body. */
export interface MissionSetGoalsBody {
  miniGoals: MissionGoalBody[]
}

/**
 * Build the set_mission_goals body: the mini goals of an open mission that has
 * NONE yet. Same shape and bounds as create's, and nothing else goes on the
 * wire (the backend keeps the mission's own title, chat and switch).
 */
export function buildMissionSetGoalsBody(input: {
  mini_goals?: unknown
}): MissionBuildResult<MissionSetGoalsBody> {
  const goals = parseMissionGoals(input.mini_goals)
  if (!goals.ok) return goals
  return { ok: true, body: { miniGoals: goals.body } }
}

/** Build the POST assistants/:id/missions body from snake_case tool args. */
export function buildMissionCreateBody(input: {
  title?: unknown
  mini_goals?: unknown
  chat_id?: unknown
}): MissionBuildResult<MissionCreateBody> {
  const { title, mini_goals, chat_id } = input

  if (typeof title !== 'string' || !title.trim()) {
    return { ok: false, error: 'title is required: a short mission headline the user will see on the card.' }
  }
  const trimmedTitle = title.trim()
  if (trimmedTitle.length > MISSION_TITLE_MAX) {
    return {
      ok: false,
      error: `title is too long (${trimmedTitle.length} chars, max ${MISSION_TITLE_MAX}).`,
    }
  }

  const goals = parseMissionGoals(mini_goals)
  if (!goals.ok) return goals
  const miniGoals = goals.body

  const body: MissionCreateBody = { title: trimmedTitle, miniGoals }
  // A chat is OPTIONAL and, when absent, the key must not exist at all. A
  // refusal here is better than a silent main-chat create: a mission planted
  // in the wrong chat sets aside the wrong chat's mission.
  if (chat_id !== undefined && chat_id !== null && chat_id !== '') {
    if (!isPositiveIntLike(chat_id)) {
      return {
        ok: false,
        error:
          `chat_id must be a positive integer chat id (got ${JSON.stringify(chat_id)}). ` +
          'Pass the chat_id (or session_handle) of the turn you are answering, or omit ' +
          "it to mean this agent's main chat.",
      }
    }
    body.chatId = Number(chat_id)
  }
  return { ok: true, body }
}

/** Build the PATCH .../tick body from snake_case tool args. */
export function buildMissionTickBody(input: {
  goal_id?: unknown
  evidence?: unknown
}): MissionBuildResult<MissionTickBody> {
  const { goal_id, evidence } = input

  if (typeof goal_id !== 'number' || !Number.isInteger(goal_id) || goal_id < 1) {
    return {
      ok: false,
      error:
        `goal_id must be a positive integer (got ${JSON.stringify(goal_id)}). Use the ids ` +
        'from the create_mission result or from get-active.',
    }
  }

  const body: MissionTickBody = { goalId: goal_id }
  if (evidence != null && evidence !== '') {
    if (typeof evidence !== 'string') {
      return { ok: false, error: 'evidence must be a short string (what proved the done_when check).' }
    }
    const trimmed = evidence.trim()
    if (trimmed.length > MISSION_EVIDENCE_MAX) {
      return {
        ok: false,
        error: `evidence is too long (${trimmed.length} chars, max ${MISSION_EVIDENCE_MAX}).`,
      }
    }
    if (trimmed) body.evidence = trimmed
  }
  return { ok: true, body }
}

/**
 * Trim, cap, and never leave a lone high surrogate at the cut. The same guard
 * the summary has always had, now shared by every capped string here.
 */
function wireText(raw: unknown, max: number): string {
  let trimmed = String(raw ?? '').trim().slice(0, max)
  const last = trimmed.charCodeAt(trimmed.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) trimmed = trimmed.slice(0, -1)
  return trimmed
}

/** A whole number the wire can carry, or undefined. NEVER a clamp: see rule 2
 *  in the header. A count outside the range is a count nobody counted. */
function wireInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  if (value < min || value > max) return undefined
  return value
}

type VerdictResult =
  | { ok: true; verdict?: MissionVerdictBody }
  | { ok: false; error: string }

/**
 * The checker's answer, ready for the wire.
 *
 * A word outside the three is REFUSED: only this daemon builds one, so a
 * fourth word is a bug in the caller and a quiet omission would hide it. A
 * verdict with no reason is OMITTED instead, because the backend requires a
 * non empty reason and losing the whole write (a completion, say) over a
 * missing sentence would cost the owner far more than losing one check line.
 */
function buildVerdict(input: MissionVerdictInput | undefined): VerdictResult {
  if (input == null) return { ok: true }
  if (!isPlainObject(input)) return { ok: false, error: 'verdict must be an object.' }
  const word = input.verdict
  if (typeof word !== 'string' || !(MISSION_VERDICTS as readonly string[]).includes(word)) {
    return {
      ok: false,
      error: `verdict must be one of ${MISSION_VERDICTS.join(', ')} (got ${JSON.stringify(word)}).`,
    }
  }
  const reason = wireText(input.reason, MISSION_VERDICT_REASON_MAX)
  if (!reason) return { ok: true }
  const verdict: MissionVerdictBody = { verdict: word as MissionVerdictWord, reason }
  if (input.by === 'checker' || input.by === 'agent') verdict.by = input.by
  const check = wireInt(input.check, 1, MISSION_VERDICT_CHECK_MAX)
  if (check !== undefined) verdict.check = check
  return { ok: true, verdict }
}

/** What the runtime counted, ready for the wire, or undefined when it counted
 *  nothing the wire can carry. */
function buildRunReport(input: MissionRunReportInput | undefined): MissionRunReportBody | undefined {
  if (input == null || !isPlainObject(input)) return undefined
  const report: MissionRunReportBody = {}
  const turnsUsed = wireInt(input.turnsUsed, 0, MISSION_TURNS_USED_MAX)
  if (turnsUsed !== undefined) report.turnsUsed = turnsUsed
  const turnCap = wireInt(input.turnCap, 1, MISSION_TURN_CAP_MAX)
  if (turnCap !== undefined) report.turnCap = turnCap
  const workingMs = wireInt(input.workingMs, 0, MISSION_WORKING_MS_MAX)
  if (workingMs !== undefined) report.workingMs = workingMs
  return Object.keys(report).length > 0 ? report : undefined
}

/** Build the PATCH .../complete body. `summary` still arrives from the
 *  complete_mission tool; the two blocks arrive from the goal lane. */
export function buildMissionCompleteBody(
  {
    summary,
    verdict,
    runReport,
  }: {
    summary?: unknown
    verdict?: MissionVerdictInput
    runReport?: MissionRunReportInput
  } = {},
): MissionBuildResult<MissionCompleteBody> {
  const body: MissionCompleteBody = {}
  if (summary != null && typeof summary !== 'string') {
    return { ok: false, error: 'summary must be a string' }
  }
  if (typeof summary === 'string') {
    const trimmed = wireText(summary, MISSION_SUMMARY_MAX)
    if (trimmed) body.summary = trimmed
  }
  const checked = buildVerdict(verdict)
  if (!checked.ok) return checked
  if (checked.verdict) body.verdict = checked.verdict
  const report = buildRunReport(runReport)
  if (report) body.runReport = report
  return { ok: true, body }
}

/**
 * Build the PATCH .../fail body.
 *
 * The goal lane's only way to say "the checker decided this cannot be done":
 * the judge's reason is the summary AND the verdict's reason, so an app that
 * knows nothing about verdicts still shows the owner why it stopped.
 */
export function buildMissionFailBody(
  {
    summary,
    verdict,
    runReport,
  }: {
    summary?: unknown
    verdict?: MissionVerdictInput
    runReport?: MissionRunReportInput
  } = {},
): MissionBuildResult<MissionFailBody> {
  return buildMissionCompleteBody({ summary, verdict, runReport })
}

/**
 * Build the PATCH .../progress body: one check, as the owner will read it.
 *
 * A body that would change nothing is refused rather than sent. The backend
 * answers 200 and does nothing for one of those, which reads at the call site
 * exactly like a write that worked.
 */
export function buildMissionProgressBody(
  input: MissionProgressInput = {},
): MissionBuildResult<MissionProgressBody> {
  const body: MissionProgressBody = {}

  if (input.feedEntry != null) {
    const { kind, text } = input.feedEntry
    if (typeof kind !== 'string' || !(MISSION_FEED_KINDS as readonly string[]).includes(kind)) {
      return {
        ok: false,
        error: `feed entry kind must be one of ${MISSION_FEED_KINDS.join(', ')} (got ${JSON.stringify(kind)}).`,
      }
    }
    const clipped = wireText(text, MISSION_FEED_TEXT_MAX)
    if (!clipped) return { ok: false, error: 'a feed entry needs a line of text the owner can read.' }
    body.feedEntry = { kind: kind as MissionFeedKind, text: clipped }
  }

  if (input.effort != null) {
    const used = wireInt(input.effort.used, 0, MISSION_TURNS_USED_MAX)
    const budget = wireInt(input.effort.budget, 1, MISSION_TURNS_USED_MAX)
    if (used === undefined || budget === undefined) {
      return { ok: false, error: 'effort needs a whole used count and a budget of at least 1.' }
    }
    body.effort = { used, budget, unit: 'turns' }
  }

  const checked = buildVerdict(input.verdict)
  if (!checked.ok) return checked
  if (checked.verdict) body.verdict = checked.verdict

  const report = buildRunReport(input.runReport)
  if (report) body.runReport = report

  if (Object.keys(body).length === 0) {
    return {
      ok: false,
      error: 'a progress write needs a feed entry, an effort count, a verdict or a run report.',
    }
  }
  return { ok: true, body }
}

/**
 * Which chat an IMPLICIT mission create or read lands in, when the agent named
 * none.
 *
 * The backend refuses a mission in any chat that is not one of the OWNER's own
 * DMs with this agent (mission.service.ts requireOwnedChatKey): a room is
 * refused because a mission is one agent's promise and a room has many, and a
 * chat belonging to somebody else is refused because the card would be planted
 * in their chat. A share recipient's DM with a shared agent is exactly that
 * second case, and it is the one stage 3 recorded as a real security finding.
 *
 * So an implicit source the create route would refuse is SKIPPED rather than
 * sent, and when none is left the answer is null. Null is not a failure: it
 * MEANS the agent's main chat, which is what a single-chat agent has always
 * had and what the backend resolves a missing chat to.
 *
 * An EXPLICIT chat_id is not this function's business. The agent named it, the
 * daemon checks only that it may reach it, and the backend answers for it.
 *
 * The two things the daemon knows, passed in rather than read, so this stays
 * pure: whether a chat is a room (the meeting chats it tracks), and who sent
 * the last inbound it saw there. A chat it has seen NO inbound in is not
 * refused for that: silence is not somebody else, and a proactive create in a
 * chat this process has only written to must keep working.
 *
 * One consequence worth stating: a peer (a2a) chat whose last message came
 * from the other agent's owner is skipped too, even though the backend would
 * accept it, because from here it looks exactly like a recipient's chat. The
 * mission then lands in the agent's main chat, which is always valid and is
 * where its owner is watching; an explicit chat_id still puts it in the peer
 * chat.
 */
export interface ImplicitMissionChatInput {
  /** The chat of the live turn, from the turn-chat tracker. */
  turnChatId?: string | number | null
  /** Every chat this daemon watches, in the order it watches them. */
  monitoredChatIds: readonly string[]
  /** The account this daemon's credentials belong to. */
  ownerUserId: string
  /** Is that chat a room? A meeting chat is the case that exists today. */
  isRoom: (chatId: string) => boolean
  /** Who sent the last inbound seen there, or null/undefined for none seen. */
  lastInboundUserId: (chatId: string) => string | null | undefined
}

export function pickImplicitMissionChat(input: ImplicitMissionChatInput): string | null {
  const { monitoredChatIds, ownerUserId, isRoom, lastInboundUserId } = input
  const usable = (chatId: string): boolean => {
    if (isRoom(chatId)) return false
    const sender = lastInboundUserId(chatId)
    if (typeof sender !== 'string' || sender === '') return true
    return sender === ownerUserId
  }
  const turn = String(input.turnChatId ?? '').trim()
  if (turn !== '' && usable(turn)) return turn
  for (const chatId of monitoredChatIds) {
    const id = String(chatId ?? '').trim()
    if (id !== '' && usable(id)) return id
  }
  return null
}

const isPositiveIntLike = (v: unknown): boolean => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n > 0
}

const BAD_ASSISTANT = 'assistant id is not configured (BGOS_ASSISTANT_ID); cannot build a mission route.'

export function buildMissionCreatePath(assistantId: unknown): MissionPathResult {
  if (!isPositiveIntLike(assistantId)) return { ok: false, error: BAD_ASSISTANT }
  return { ok: true, path: `assistants/${assistantId}/missions` }
}

/**
 * The active-mission read, optionally scoped to ONE chat.
 *
 * With no chat (or a chat that is not a usable id) the path is byte identical
 * to the pre-0.41.0 one, which is the single-chat agent's no-change proof. A
 * junk chat is ignored rather than fatal: a read is not a write, and answering
 * with the main chat's mission beats refusing to look. The query string is
 * part of the daemon's ETag cache key (bgosGet keys on the path), so two chats
 * can never share one cached snapshot.
 */
export function buildMissionActivePath(
  assistantId: unknown,
  chatId?: unknown,
): MissionPathResult {
  if (!isPositiveIntLike(assistantId)) return { ok: false, error: BAD_ASSISTANT }
  const base = `assistants/${assistantId}/missions/active`
  if (!isPositiveIntLike(chatId)) return { ok: true, path: base }
  return { ok: true, path: `${base}?chatId=${Number(chatId)}` }
}

export function buildMissionTickPath(assistantId: unknown, missionId: unknown): MissionPathResult {
  if (!isPositiveIntLike(assistantId)) return { ok: false, error: BAD_ASSISTANT }
  if (!isPositiveIntLike(missionId)) {
    return { ok: false, error: `mission id must be a positive integer (got ${JSON.stringify(missionId)}).` }
  }
  return { ok: true, path: `assistants/${assistantId}/missions/${missionId}/tick` }
}

export function buildMissionCompletePath(assistantId: unknown, missionId: unknown): MissionPathResult {
  if (!isPositiveIntLike(assistantId)) return { ok: false, error: BAD_ASSISTANT }
  if (!isPositiveIntLike(missionId)) {
    return { ok: false, error: `mission id must be a positive integer (got ${JSON.stringify(missionId)}).` }
  }
  return { ok: true, path: `assistants/${assistantId}/missions/${missionId}/complete` }
}

/**
 * The set_mission_goals write. The PAIRING family, like the goal lane's
 * /stopped report: goals are the agent's own promise, and the backend gives
 * the owner no twin of this door.
 */
export function buildMissionSetGoalsPath(assistantId: unknown, missionId: unknown): MissionPathResult {
  if (!isPositiveIntLike(assistantId)) return { ok: false, error: BAD_ASSISTANT }
  if (!isPositiveIntLike(missionId)) {
    return { ok: false, error: `mission id must be a positive integer (got ${JSON.stringify(missionId)}).` }
  }
  return { ok: true, path: `integrations/assistants/${assistantId}/missions/${missionId}/goals` }
}

/** The goal lane's check write. */
export function buildMissionProgressPath(assistantId: unknown, missionId: unknown): MissionPathResult {
  if (!isPositiveIntLike(assistantId)) return { ok: false, error: BAD_ASSISTANT }
  if (!isPositiveIntLike(missionId)) {
    return { ok: false, error: `mission id must be a positive integer (got ${JSON.stringify(missionId)}).` }
  }
  return { ok: true, path: `assistants/${assistantId}/missions/${missionId}/progress` }
}

/**
 * The armed goal case's pause (P6 stage 3, lib/stop-pause.ts): an owner Stop
 * pauses the mission its armed goal loops on, with the contract's reason.
 * The user scoped family, like every other goal lane write: it admits an
 * X-API-Key install and a paired one alike.
 */
export function buildMissionPausePath(assistantId: unknown, missionId: unknown): MissionPathResult {
  if (!isPositiveIntLike(assistantId)) return { ok: false, error: BAD_ASSISTANT }
  if (!isPositiveIntLike(missionId)) {
    return { ok: false, error: `mission id must be a positive integer (got ${JSON.stringify(missionId)}).` }
  }
  return { ok: true, path: `assistants/${assistantId}/missions/${missionId}/pause` }
}

/** Its resume, on the owner's next message in that chat. */
export function buildMissionResumePath(assistantId: unknown, missionId: unknown): MissionPathResult {
  if (!isPositiveIntLike(assistantId)) return { ok: false, error: BAD_ASSISTANT }
  if (!isPositiveIntLike(missionId)) {
    return { ok: false, error: `mission id must be a positive integer (got ${JSON.stringify(missionId)}).` }
  }
  return { ok: true, path: `assistants/${assistantId}/missions/${missionId}/resume` }
}

/** The goal lane's "the checker said this cannot be done" write. */
export function buildMissionFailPath(assistantId: unknown, missionId: unknown): MissionPathResult {
  if (!isPositiveIntLike(assistantId)) return { ok: false, error: BAD_ASSISTANT }
  if (!isPositiveIntLike(missionId)) {
    return { ok: false, error: `mission id must be a positive integer (got ${JSON.stringify(missionId)}).` }
  }
  return { ok: true, path: `assistants/${assistantId}/missions/${missionId}/fail` }
}

/**
 * Compact, agent-facing mission summary for tool results: progress count, a
 * checkbox ledger with the goal ids the agent needs for tick_mini_goal, and
 * the next open goal. Pure formatting, no I/O.
 */
export function formatMissionSummary(mission: MissionSnapshot): string {
  const total = mission.miniGoals.length
  const done = mission.miniGoals.filter((g) => g.done).length
  const lines: string[] = [
    `Mission #${mission.id}: "${mission.title}" (${mission.status}), ${done} of ${total} mini-goals done.`,
  ]
  for (const g of mission.miniGoals) {
    lines.push(`  [${g.done ? 'x' : ' '}] ${g.id}. ${g.name} (done when ${g.doneWhen})`)
  }
  if (mission.status === 'active') {
    const next = mission.miniGoals.find((g) => !g.done)
    if (next) lines.push(`Next: ${next.id}. ${next.name}`)
  }
  return lines.join('\n')
}
