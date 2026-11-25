/**
 * Pure, side-effect-free builders for the `schedule` / `list_schedules` /
 * `cancel_schedule` / `end_run` MCP tools.
 *
 * Like ./lib/call-owner.ts, everything here is deterministic and import-safe
 * (no env reads, no network, no clock, no process exit), so it can be unit and
 * eval tested directly. server.ts imports these for the CallTool handlers; the
 * eval suite (test/schedule.test.ts) imports them too.
 *
 * The wire contract is the FINAL agent-scoped backend surface (Home of Agents
 * native scheduler; /tmp/sched-contract-final.txt is authoritative). Every
 * endpoint authenticates with X-API-Key + X-Caller-Assistant-Id (the plugin's
 * peer client):
 *
 *   POST   scheduled-tasks/agent          create a task
 *   GET    scheduled-tasks/agent?status=  list this agent's tasks
 *                                         (active | done | cancelled | all,
 *                                          default active)
 *   DELETE scheduled-tasks/agent/:id      SOFT cancel (200 with the task view,
 *                                         idempotent; 400 on a done one-shot;
 *                                         404 anti-enumeration)
 *   POST   scheduled-tasks/agent/:id/run-end
 *                                         end one run of a routine (end_run):
 *                                         { fireId, outcome, reasonCode?, reason? } answers
 *                                         { ended, outcome }; 409 when the run
 *                                         must answer or the fire is not the
 *                                         latest; 404 while the server offers
 *                                         no run ends or the task is not yours
 *
 * Create body:
 *   {
 *     kind?: 'wake' | 'call',           // backend defaults to wake; we always send it
 *     topic: string,                    // 1..500, the headline instruction
 *     instruction?: string,             // <=2000, optional detailed brief
 *     fireAt?: string,                  // ISO datetime WITH offset
 *     everyHours?: number,              // int 1..8760
 *     recurrence?: {                    // structured repeat
 *       freq: 'daily' | 'weekly' | 'monthly',
 *       atMinute: number,               // minutes after LOCAL midnight in tz, 0..1439
 *       tz: string,                     // real IANA zone, <= 64 chars
 *       interval?: number,              // 1..366
 *       daysOfWeek?: number[],          // 0=Sunday..6=Saturday; REQUIRED for weekly
 *       dayOfMonth?: number,            // 1..31, clamped to month length; REQUIRED for monthly
 *     },
 *     chatId?: number,                  // omitted = backend uses the agent's main chat
 *     runDisplay?: 'inbox' | 'timeline' | 'cards', // wakes only; omitted = follow the owner's Settings
 *     clientRequestId?: string,         // 16..100 of A-Z a-z 0-9 _ - ; see below
 *   }
 *   At least ONE of fireAt / everyHours / recurrence (backend 400 otherwise).
 *   everyHours + recurrence together is a 400. fireAt + everyHours is an
 *   ANCHORED repeat (first fire pinned at fireAt, then every N hours). The
 *   201 response is the agent task view { id, kind, topic, instruction,
 *   chatId, nextFireAt, everyHours, recurrence, status }.
 *
 * clientRequestId is the request's own name. The backend
 * answers a second send of the same id with the same body by returning the
 * first result and making nothing new; the same id with another body is a 409.
 * An older backend either drops the field without a word or refuses it with
 * a 400; ./schedule-send.ts handles both. The
 * builder only checks the shape and carries the id: it never makes one (no
 * randomness here) and never derives one from the body, because two identical
 * routines that were both asked for must both be made.
 *
 * The tool's single `when` argument maps onto that:
 *   - ISO datetime string             -> fireAt (one-shot)
 *   - { everyHours: N, fireAt? }      -> everyHours (+ optional anchor);
 *                                        periodHours is accepted as an alias
 *   - recurrence object               -> recurrence (the backend computes the
 *                                        first occurrence itself)
 *
 * Validation failures return { ok: false, error } rather than throwing, so the
 * thin server wiring can relay a clear, actionable message to the agent as the
 * tool result.
 */

/** The task kinds this tool schedules ('meeting' is a different UX surface). */
export const SCHEDULE_KINDS = ['wake', 'call'] as const
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number]

/**
 * Length cap for the topic (the headline instruction). Matches the backend's
 * 500-char cap. Over-long topics are REJECTED, not truncated: a silently
 * truncated instruction could fire later with half its meaning missing.
 */
export const SCHEDULE_TOPIC_MAX = 500

/** Length cap for the optional detailed brief (backend: 2000). */
export const SCHEDULE_INSTRUCTION_MAX = 2000

/** Recurrence frequencies the backend understands. */
export const RECURRENCE_FREQS = ['daily', 'weekly', 'monthly'] as const
export type RecurrenceFreq = (typeof RECURRENCE_FREQS)[number]

/** The shape the backend accepts for clientRequestId (SCHEDULE_REQUEST_ID_PATTERN there). */
export const SCHEDULE_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,100}$/

/** Backend caps: everyHours 1..8760, recurrence.interval 1..366, tz <= 64. */
const EVERY_HOURS_MAX = 8760
const INTERVAL_MAX = 366
const TZ_MAX = 64

/** Task-list status filters the backend accepts (default: active). */
export const SCHEDULE_LIST_STATUSES = ['active', 'done', 'cancelled', 'all'] as const
export type ScheduleListStatus = (typeof SCHEDULE_LIST_STATUSES)[number]

export interface ScheduleRecurrence {
  freq: RecurrenceFreq
  atMinute: number
  tz: string
  interval?: number
  daysOfWeek?: number[]
  dayOfMonth?: number
}

export interface ScheduleCreateBody {
  kind: ScheduleKind
  topic: string
  instruction?: string
  fireAt?: string
  everyHours?: number
  recurrence?: ScheduleRecurrence
  chatId?: number
  /** The boards each run of a wake may use (0.86.20): the server's grant. */
  boards?: Array<{ boardId: string; access: 'read' | 'write' }>
  /** How this routine's runs show in the owner's chat (when_it_runs). Absent = follow the owner's Settings. */
  runDisplay?: RunDisplay
  clientRequestId?: string
}

/**
 * WHEN A ROUTINE RUNS (2026-11-22): the three ways a routine's runs can show in the owner's chat with the agent, in
 * the words the tool offers, mapped to the words the server stores (the same three the owner's Settings choice is
 * stored as: Show nothing is inbox, One line a day is timeline, A card every run is cards). This map is the one place
 * the tool's words meet the wire's. Leaving when_it_runs out sends nothing, so the routine follows the owner's own
 * "When a routine runs" setting, including a later change there; the agent sets it only when its owner asked for
 * this routine. The 30 minute "tell me if nothing came" switch is the owner's alone and has no word here.
 */
export const WHEN_IT_RUNS_TO_RUN_DISPLAY = Object.freeze({
  show_nothing: 'inbox',
  one_line_a_day: 'timeline',
  card_every_run: 'cards',
} as const)
export type WhenItRuns = keyof typeof WHEN_IT_RUNS_TO_RUN_DISPLAY
export type RunDisplay = (typeof WHEN_IT_RUNS_TO_RUN_DISPLAY)[WhenItRuns]
export const WHEN_IT_RUNS_CHOICES = Object.freeze(Object.keys(WHEN_IT_RUNS_TO_RUN_DISPLAY) as WhenItRuns[])

/** The plain words for a stored choice, for what the agent reads back. */
export const RUN_DISPLAY_WORDS: Readonly<Record<RunDisplay, string>> = Object.freeze({
  inbox: 'show nothing',
  timeline: 'one line a day',
  cards: 'a card every run',
})

/**
 * The server word for a when_it_runs argument. Absent, null or blank is no choice (follow Settings); a call is refused,
 * as boards are, because a call rings the owner and shows no run in the chat; anything else is refused with the three
 * words, never guessed.
 */
function buildRunDisplay(input: unknown, kind: unknown): { ok: true; runDisplay: RunDisplay | undefined } | { ok: false; error: string } {
  if (input == null) return { ok: true, runDisplay: undefined }
  const choice = typeof input === 'string' ? input.trim() : input
  if (choice === '') return { ok: true, runDisplay: undefined }
  if (typeof choice !== 'string' || !Object.hasOwn(WHEN_IT_RUNS_TO_RUN_DISPLAY, choice)) {
    return {
      ok: false,
      error:
        `when_it_runs must be show_nothing, one_line_a_day or card_every_run (got ${JSON.stringify(input)}). ` +
        "Leave it out to follow your owner's When a routine runs setting.",
    }
  }
  if (kind !== 'wake') {
    return { ok: false, error: 'when_it_runs is for wakes only; a call rings the owner and shows no run in the chat.' }
  }
  return { ok: true, runDisplay: WHEN_IT_RUNS_TO_RUN_DISPLAY[choice as WhenItRuns] }
}

/** How many boards one schedule may name (the server's SCHEDULE_GRANT_MAX_BOARDS). */
export const SCHEDULE_BOARDS_MAX = 10
const BOARD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The boards a wake names, as the server reads them: one entry per board (write wins), lower case ids. An error
 * sentence for anything else.
 */
function buildScheduleBoards(input: unknown, kind: unknown): { ok: true; boards: ScheduleCreateBody['boards'] } | { ok: false; error: string } {
  if (input == null) return { ok: true, boards: undefined }
  if (!Array.isArray(input)) return { ok: false, error: 'boards must be a list of { board_id, access } (access is read or write).' }
  if (input.length === 0) return { ok: true, boards: undefined }
  if (kind !== 'wake') return { ok: false, error: 'Only a wake can name boards; a call rings the owner and uses none.' }
  const byId = new Map<string, 'read' | 'write'>()
  for (const item of input) {
    const raw = isPlainObject(item) ? (item.board_id ?? item.boardId) : undefined
    const boardId = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    if (!BOARD_ID_RE.test(boardId)) return { ok: false, error: 'Each board needs its board id (the id boards_list shows), not its name.' }
    const access = isPlainObject(item) && item.access != null ? item.access : 'read'
    if (access !== 'read' && access !== 'write') return { ok: false, error: "A board's access is read or write." }
    byId.set(boardId, byId.get(boardId) === 'write' ? 'write' : access)
  }
  if (byId.size > SCHEDULE_BOARDS_MAX) return { ok: false, error: `A schedule can name at most ${SCHEDULE_BOARDS_MAX} boards.` }
  return { ok: true, boards: [...byId].map(([boardId, access]) => ({ boardId, access })) }
}

export interface ScheduleCreateInput {
  /** 'wake' (deliver the topic back to the agent) or 'call' (ring the owner). */
  kind?: unknown
  /** The headline instruction to deliver at fire time. Required, trimmed, capped. */
  topic?: unknown
  /** Optional detailed brief (<=2000 chars), trimmed, omitted when empty. */
  instruction?: unknown
  /** ISO datetime string, { everyHours, fireAt? }, or a recurrence object. */
  when?: unknown
  /** Chat to bind to. Omitted from the body unless a finite number. */
  chatId?: number | null
  /** Optional, wakes only: [{ board_id, access }] the runs may use whoever posts meanwhile. */
  boards?: unknown
  /** Optional, wakes only: show_nothing | one_line_a_day | card_every_run. Absent = follow the owner's Settings. */
  whenItRuns?: unknown
  /** This request's own name (16..100 of A-Z a-z 0-9 _ -), made by the caller, never derived from the body. Omitted = no id on the wire. */
  clientRequestId?: unknown
}

export type ScheduleBuildResult =
  | { ok: true; body: ScheduleCreateBody }
  | { ok: false; error: string }

export type SchedulePathResult =
  | { ok: true; path: string }
  | { ok: false; error: string }

const WHEN_HELP =
  'Pass `when` as an ISO datetime string WITH a timezone offset for a ' +
  'one-shot (e.g. "2026-07-10T09:00:00+04:00" or "...T05:00:00Z"), ' +
  '{ everyHours: N } for a repeat every N whole hours (optionally with a ' +
  'fireAt anchor for the first fire), or a recurrence object ' +
  '{ freq: "daily"|"weekly"|"monthly", atMinute, tz, daysOfWeek (weekly), ' +
  'dayOfMonth (monthly), interval? }.'

/**
 * ISO datetime with a REQUIRED explicit timezone (Z or +hh:mm): a naive
 * datetime or bare date is ambiguous (the backend would have to guess a
 * timezone, and a Dubai 9am reminder parsed as UTC fires 4 hours off).
 */
const ISO_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/

/** Last day of `month` (1..12) in `year`, from explicit components (no clock). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Sanity-check an ISO datetime string without a clock: it must be a full
 * datetime with an explicit offset, parse to a real timestamp, AND name a
 * calendar day that exists. Date.parse alone silently rolls impossible dates
 * over (2026-02-30 becomes March 2), which would fire the task on a different
 * day than the agent told the user, so the day is checked against the month's
 * real length. Prose ("tomorrow 9am") and locale formats ("July 10 2026") are
 * rejected so the agent converts to ISO itself; a past date is the backend's
 * call to reject, not ours.
 */
function isIsoDateString(value: string): boolean {
  const match = ISO_DATETIME_RE.exec(value)
  if (!match) return false
  if (!Number.isFinite(Date.parse(value))) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) return false
  return day >= 1 && day <= daysInMonth(year, month)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Does the runtime ICU know this zone? (Same probe the backend uses.) */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const BAD_ISO_ERROR = (label: string, value: unknown) =>
  `${label} is not a valid ISO datetime with a timezone offset ` +
  `(got ${JSON.stringify(value)}). Use a full datetime on a real calendar ` +
  `day and include the offset (Z or +04:00), not a bare date. ${WHEN_HELP}`

/**
 * Build the POST scheduled-tasks/agent body. Pure: no I/O, no clock. Every
 * validation rule mirrors the backend contract so the agent gets a teaching
 * error client-side instead of an opaque 400. See the module header for the
 * exact wire shape.
 */
export function buildScheduleCreateBody(input: ScheduleCreateInput): ScheduleBuildResult {
  const { kind, topic, instruction, chatId } = input
  // Recover a recurrence / everyHours OBJECT that some MCP clients serialize
  // to a JSON string before it reaches this tool (the input schema was
  // type-less, so the object round-tripped as text and only ever hit the
  // one-shot ISO validator). A string that parses to a plain object is the
  // object form, not a one-shot datetime.
  let when = input.when
  if (typeof when === 'string') {
    const t = when.trim()
    if (t.startsWith('{') && t.endsWith('}')) {
      try {
        const parsed = JSON.parse(t)
        if (isPlainObject(parsed)) when = parsed
      } catch {
        // not JSON, validate as an ISO datetime string below
      }
    }
  }

  if (typeof kind !== 'string' || !(SCHEDULE_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      error: `kind must be one of: ${SCHEDULE_KINDS.join(', ')} (got ${JSON.stringify(kind)}).`,
    }
  }

  if (typeof topic !== 'string' || !topic.trim()) {
    return {
      ok: false,
      error: 'topic is required: a short instruction to deliver back at fire time.',
    }
  }
  const trimmedTopic = topic.trim()
  if (trimmedTopic.length > SCHEDULE_TOPIC_MAX) {
    return {
      ok: false,
      error:
        `topic is too long (${trimmedTopic.length} chars, max ${SCHEDULE_TOPIC_MAX}). ` +
        'Shorten the headline; put the detail in `instruction` instead.',
    }
  }

  const body: ScheduleCreateBody = { kind: kind as ScheduleKind, topic: trimmedTopic }

  if (instruction != null && instruction !== '') {
    if (typeof instruction !== 'string') {
      return { ok: false, error: 'instruction must be a string (a detailed brief for fire time).' }
    }
    const trimmedInstruction = instruction.trim()
    if (trimmedInstruction.length > SCHEDULE_INSTRUCTION_MAX) {
      return {
        ok: false,
        error:
          `instruction is too long (${trimmedInstruction.length} chars, ` +
          `max ${SCHEDULE_INSTRUCTION_MAX}).`,
      }
    }
    if (trimmedInstruction) body.instruction = trimmedInstruction
  }

  if (typeof when === 'string') {
    const trimmedWhen = when.trim()
    if (!trimmedWhen || !isIsoDateString(trimmedWhen)) {
      return { ok: false, error: BAD_ISO_ERROR('when', when) }
    }
    body.fireAt = trimmedWhen
  } else if (isPlainObject(when)) {
    const hasFreq = 'freq' in when
    const everyRaw = 'everyHours' in when ? when.everyHours : undefined
    const aliasRaw = 'periodHours' in when ? when.periodHours : undefined
    const hasEvery = everyRaw !== undefined || aliasRaw !== undefined

    if (hasFreq && hasEvery) {
      return {
        ok: false,
        error:
          'when must be one of: a recurrence object OR { everyHours }, not both at once ' +
          '(the backend rejects everyHours + recurrence together).',
      }
    }

    if (hasEvery) {
      if (everyRaw !== undefined && aliasRaw !== undefined) {
        return {
          ok: false,
          error: 'Pass everyHours only (periodHours is just an alias); not both keys.',
        }
      }
      const everyHours = everyRaw !== undefined ? everyRaw : aliasRaw
      if (
        typeof everyHours !== 'number' ||
        !Number.isInteger(everyHours) ||
        everyHours < 1 ||
        everyHours > EVERY_HOURS_MAX
      ) {
        return {
          ok: false,
          error:
            `everyHours must be a whole number of hours 1..${EVERY_HOURS_MAX} ` +
            `(got ${JSON.stringify(everyHours)}). For sub-hourly or local-time ` +
            'precision use a recurrence object.',
        }
      }
      body.everyHours = everyHours

      // Optional anchor: pins the FIRST fire, then the repeat runs every N
      // hours from it. A bad anchor is an error, never silently dropped.
      if (when.fireAt != null) {
        const anchor = when.fireAt
        if (typeof anchor !== 'string' || !isIsoDateString(anchor.trim())) {
          return { ok: false, error: BAD_ISO_ERROR('fireAt (the anchor)', anchor) }
        }
        body.fireAt = anchor.trim()
      }
    } else if (hasFreq) {
      const freq = when.freq
      if (typeof freq !== 'string' || !(RECURRENCE_FREQS as readonly string[]).includes(freq)) {
        return {
          ok: false,
          error: `recurrence freq must be one of: ${RECURRENCE_FREQS.join(', ')} (got ${JSON.stringify(freq)}).`,
        }
      }

      const tz = when.tz
      const trimmedTz = typeof tz === 'string' ? tz.trim() : ''
      if (!trimmedTz || trimmedTz.length > TZ_MAX || !isValidTimeZone(trimmedTz)) {
        return {
          ok: false,
          error: 'recurrence tz must be a real IANA timezone like "Asia/Dubai" or "UTC".',
        }
      }

      const atMinute = when.atMinute
      if (
        typeof atMinute !== 'number' ||
        !Number.isInteger(atMinute) ||
        atMinute < 0 ||
        atMinute > 1439
      ) {
        return {
          ok: false,
          error:
            'recurrence atMinute is required: an integer 0..1439, minutes after midnight ' +
            'in tz (e.g. 8am = 480).',
        }
      }

      const recurrence: ScheduleRecurrence = { freq: freq as RecurrenceFreq, atMinute, tz: trimmedTz }

      // Optional keys: an explicit null is treated as absent (LLM callers
      // routinely emit nulls) so the wire body never carries interval: null.
      if (when.daysOfWeek != null) {
        const daysOfWeek = when.daysOfWeek
        if (
          !Array.isArray(daysOfWeek) ||
          daysOfWeek.length === 0 ||
          !daysOfWeek.every((d) => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)
        ) {
          return {
            ok: false,
            error:
              'recurrence daysOfWeek must be a non-empty array of integers 0..6 ' +
              '(0=Sunday .. 6=Saturday, e.g. every Saturday = [6]).',
          }
        }
        recurrence.daysOfWeek = daysOfWeek as number[]
      }
      if (freq === 'weekly' && !recurrence.daysOfWeek) {
        return {
          ok: false,
          error:
            'weekly recurrence needs daysOfWeek: which weekdays fire, integers 0..6 ' +
            '(0=Sunday .. 6=Saturday, e.g. weekdays = [1,2,3,4,5]).',
        }
      }

      if (when.dayOfMonth != null) {
        const dayOfMonth = when.dayOfMonth
        if (
          typeof dayOfMonth !== 'number' ||
          !Number.isInteger(dayOfMonth) ||
          dayOfMonth < 1 ||
          dayOfMonth > 31
        ) {
          return {
            ok: false,
            error: 'recurrence dayOfMonth must be an integer 1..31 (clamped to the month length).',
          }
        }
        recurrence.dayOfMonth = dayOfMonth
      }
      if (freq === 'monthly' && recurrence.dayOfMonth === undefined) {
        return {
          ok: false,
          error: 'monthly recurrence needs dayOfMonth: which day fires, an integer 1..31.',
        }
      }

      if (when.interval != null) {
        const interval = when.interval
        if (
          typeof interval !== 'number' ||
          !Number.isInteger(interval) ||
          interval < 1 ||
          interval > INTERVAL_MAX
        ) {
          return {
            ok: false,
            error: `recurrence interval must be an integer 1..${INTERVAL_MAX} (every N days/weeks/months).`,
          }
        }
        recurrence.interval = interval
      }

      body.recurrence = recurrence
    } else {
      return { ok: false, error: `when object not recognized. ${WHEN_HELP}` }
    }
  } else {
    return { ok: false, error: `when is required. ${WHEN_HELP}` }
  }

  if (typeof chatId === 'number' && Number.isFinite(chatId)) {
    body.chatId = chatId
  }

  const boards = buildScheduleBoards(input.boards, kind)
  if (!boards.ok) return boards
  if (boards.boards) body.boards = boards.boards

  const runDisplay = buildRunDisplay(input.whenItRuns, kind)
  if (!runDisplay.ok) return runDisplay
  if (runDisplay.runDisplay) body.runDisplay = runDisplay.runDisplay

  const { clientRequestId } = input
  if (clientRequestId != null) {
    if (typeof clientRequestId !== 'string' || !SCHEDULE_REQUEST_ID_PATTERN.test(clientRequestId)) {
      return {
        ok: false,
        error:
          'The add-on made a request name the server would refuse, so nothing was scheduled. ' +
          'This is a fault in the add-on, not in your arguments: try schedule again.',
      }
    }
    body.clientRequestId = clientRequestId
  }

  return { ok: true, body }
}

/**
 * Build the GET path for listing this agent's scheduled tasks. The backend
 * defaults to active tasks; a status filter must be one of the known values
 * so a typo never silently returns the wrong slice.
 */
export function buildScheduleListPath(status: unknown): SchedulePathResult {
  if (status === undefined || status === null || status === '') {
    return { ok: true, path: 'scheduled-tasks/agent' }
  }
  if (
    typeof status !== 'string' ||
    !(SCHEDULE_LIST_STATUSES as readonly string[]).includes(status)
  ) {
    return {
      ok: false,
      error: `status must be one of: ${SCHEDULE_LIST_STATUSES.join(', ')} (or omitted for active).`,
    }
  }
  return { ok: true, path: `scheduled-tasks/agent?status=${status}` }
}

/**
 * Build the DELETE path for cancelling a scheduled task (soft cancel,
 * idempotent). Accepts the id as a string (trimmed) or a finite number,
 * URI-encodes it, and rejects anything empty or non-identifying so we never
 * issue DELETE scheduled-tasks/agent/.
 */
export function buildScheduleCancelPath(id: unknown): SchedulePathResult {
  let idText: string | null = null

  if (typeof id === 'string' && id.trim()) {
    idText = id.trim()
  } else if (typeof id === 'number' && Number.isFinite(id)) {
    idText = String(id)
  }

  if (!idText) {
    return {
      ok: false,
      error: 'schedule_id is required: pass the task id from list_schedules.',
    }
  }

  return { ok: true, path: `scheduled-tasks/agent/${encodeURIComponent(idText)}` }
}

/**
 * WHEN A ROUTINE RUNS (2026-11-22): the two ways the agent may end one run of its routine with end_run, the server's
 * RUN_END_OUTCOMES. no_change posts nothing (only a run whose wake carries quietEnd: the server answers 409 with one
 * sentence for any other); could_not_check tells the owner, on a Could not check card, with a reason code. The server
 * also ends a run itself (no answer); that outcome is the server's alone and never sent from here.
 */
export const RUN_END_OUTCOMES = Object.freeze(['no_change', 'could_not_check'] as const)
export type RunEndOutcome = (typeof RUN_END_OUTCOMES)[number]

/**
 * Why a run could not check: a code from this fixed list, never words the agent wrote. An agent reads hostile pages,
 * so what it writes must not reach a card the owner trusts. The app holds the words for each code, and the agent puts
 * any details in a normal reply.
 */
export const RUN_END_REASON_CODES = Object.freeze([
  'site_unreachable',
  'needs_sign_in',
  'ran_out_of_time',
  'missing_access',
  'something_else',
] as const)
export type RunEndReasonCode = (typeof RUN_END_REASON_CODES)[number]

/**
 * Fixed plain words for each code, sent as `reason` beside the code. A server that reads the code ignores them; an
 * older one shows `reason` as it came, so it gets these and never the code's raw name or anything the agent wrote.
 */
export const RUN_END_REASON_WORDS: Readonly<Record<RunEndReasonCode, string>> = Object.freeze({
  site_unreachable: 'could not reach the site',
  needs_sign_in: 'needs you to sign in',
  ran_out_of_time: 'ran out of time',
  missing_access: 'missing access or a file',
  something_else: 'could not finish this run',
})

/** The server's cap on the fire id. */
export const RUN_END_FIRE_ID_MAX = 160

const RUN_END_REASON_REFUSAL = `reason must be one of ${RUN_END_REASON_CODES.slice(0, -1).join(', ')} or ${RUN_END_REASON_CODES[RUN_END_REASON_CODES.length - 1]}: pick the closest and call end_run again. Put any details in a normal reply.`

export interface RunEndInput {
  /** The wake's scheduledTaskId: a whole number above 0, as a number or its digits. */
  taskId?: unknown
  /** The wake's fireId, as it came. */
  fireId?: unknown
  outcome?: unknown
  /** Why the check could not be done, a code from RUN_END_REASON_CODES: required for could_not_check, unused for no_change. */
  reason?: unknown
}

export type RunEndBody = {
  fireId: string
  outcome: RunEndOutcome
  /** The reason code, for a server that reads it. */
  reasonCode?: RunEndReasonCode
  /** The code's fixed words, for an older server that shows this field as it came. */
  reason?: string
}

export type RunEndRequest = { ok: true; path: string; body: RunEndBody } | { ok: false; error: string }

/** The fire id shape the server writes: scheduled-wake:<task id>:<the fire's ISO time>. */
const WAKE_FIRE_ID_RE = /^scheduled-wake:([1-9][0-9]*):/

/**
 * Build POST scheduled-tasks/agent/:id/run-end. Pure: no I/O, no clock. The model copies both ids out of the wake's
 * event payload, so they are checked here first and a slip reads as one sentence before anything is sent: the task id
 * is a whole number above 0, the fire id is not blank and fits the server's cap, and a fire id in the server's own
 * shape must name this same task. Anything else about the fire (the latest run, a wake at all) is the server's to say.
 */
export function buildScheduleRunEndRequest(input: RunEndInput): RunEndRequest {
  const rawTask = typeof input.taskId === 'string' ? input.taskId.trim() : input.taskId
  const taskId =
    typeof rawTask === 'number' ? rawTask : typeof rawTask === 'string' && /^[1-9][0-9]*$/.test(rawTask) ? Number(rawTask) : Number.NaN
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    return {
      ok: false,
      error: "task_id must be the routine's id, a whole number above 0: copy scheduledTaskId from the wake's event payload.",
    }
  }
  const fireId = typeof input.fireId === 'string' ? input.fireId.trim() : ''
  if (!fireId) return { ok: false, error: "fire_id is required: copy fireId from the wake's event payload." }
  if (fireId.length > RUN_END_FIRE_ID_MAX) {
    return { ok: false, error: `fire_id is too long (${fireId.length} characters, at most ${RUN_END_FIRE_ID_MAX}): copy fireId from the wake's event payload as it is.` }
  }
  const named = WAKE_FIRE_ID_RE.exec(fireId)
  if (named && Number(named[1]) !== taskId) {
    return {
      ok: false,
      error: `fire_id belongs to routine ${named[1]}, not to task_id ${taskId}. Copy both from the same wake's event payload.`,
    }
  }
  const outcome = input.outcome
  if (typeof outcome !== 'string' || !(RUN_END_OUTCOMES as readonly string[]).includes(outcome)) {
    return { ok: false, error: 'outcome must be no_change or could_not_check.' }
  }
  if (outcome === 'no_change') {
    return { ok: true, path: `scheduled-tasks/agent/${taskId}/run-end`, body: { fireId, outcome } }
  }
  // Only a known code is sent, and the refusal never repeats what was passed.
  const { reason } = input
  if (!(RUN_END_REASON_CODES as readonly unknown[]).includes(reason)) {
    return { ok: false, error: RUN_END_REASON_REFUSAL }
  }
  const reasonCode = reason as RunEndReasonCode
  const body: RunEndBody = { fireId, outcome: outcome as RunEndOutcome, reasonCode, reason: RUN_END_REASON_WORDS[reasonCode] }
  return { ok: true, path: `scheduled-tasks/agent/${taskId}/run-end`, body }
}
