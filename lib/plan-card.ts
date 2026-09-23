// ── The plan card: the wire shape, the three chips, the answer, the wait ─────
//
// WHAT THIS IS. An agent's plan reaches the owner as its OWN card in the chat:
// a title, one line saying how many steps and files, numbered steps each with
// the file it touches, a check line, and three buttons. Nothing is edited until
// the owner taps Go ahead.
//
// WHAT THIS CHANNEL CAN AND CANNOT DO, said once, here, because every other
// comment in this file assumes it. On Claude Code the wait is a CONVENTION the
// agent honours, not a lock. Every HOAI agent is launched with
// `--dangerously-skip-permissions` (bin/hoai-core.mjs, bin/bgos-agent) and the
// shipped manifest sets `BGOS_AUTO_APPROVE: "true"`, which the permission relay
// answers `allow` to before anything else runs. The hook rail cannot gate
// either: every entry is `async: true` and bin/hoai-hook.mjs always exits 0 by
// explicit rule. So nothing in this plugin can stop a model editing a file
// before its plan is approved. The tool description and the served canon both
// say so in as many words, and the card's `enforced` flag is FALSE on this
// channel for exactly that reason. Codex, which has a real read only mode,
// sends `true`.
//
// THE SHAPE, and why it is not a new message type. A plan is a
// `messageType: 'event'` row whose `eventMeta.payload.kind` is the renderable
// kind `plan_card`, with the three chips in `options`. The app renders the
// registered component AND the inline options card under it; an installed app
// that does not know the kind degrades to the quiet event row with the chips
// still under it and still answerable. A new MessageType would have bought
// server side readers that are written against the JSONB discriminator anyway.
//
// THE ANSWER IS NOT IN THE PAYLOAD. The settled row (Go ahead, by whom, when)
// is drawn from the message's own `answeredAt` / `answerPayload`, the same fact
// the chips collapse on, so approving needs no PATCH. `state: 'superseded'` IS
// in the payload, because a revision has to dim the card it replaces, and that
// is a write only the poster can make.
//
// Everything here is pure: no I/O, no clock of its own, no process state. The
// daemon supplies the ids, the clock and the HTTP.

/** The renderable kind, registered in both manifests (backend and app). */
export const PLAN_CARD_KIND = 'plan_card'

/** Payload version. Additive only: a reader that predates a field ignores it. */
export const PLAN_CARD_PAYLOAD_VERSION = 1

/**
 * Which framework proposed this plan. Mirrors PERMISSION_AGENT_ROUTE's job in
 * lib/permission-relay.ts: it is how a sweep or a report tells one daemon's
 * cards from another's.
 */
export const PLAN_AGENT_ROUTE = 'claude-code'

/**
 * FALSE on this channel, always, and it is not a placeholder. See the header:
 * nothing here can enforce the wait. The app reads this field to choose between
 * "read only until approved" and "<Agent> will propose before it changes
 * anything", so sending `true` would put a promise on screen that this plugin
 * cannot keep.
 */
export const PLAN_ENFORCED_ON_THIS_CHANNEL = false

/** Caps, from the design spec, section 4. Prose is clamped; structure refuses. */
export const PLAN_TITLE_MAX = 120
export const PLAN_SUMMARY_MAX = 500
export const PLAN_STEP_TEXT_MAX = 200
export const PLAN_STEP_FILE_MAX = 200
export const PLAN_CHECK_MAX = 300
export const PLAN_NOTE_MAX = 300
export const PLAN_STEPS_MAX = 30
export const PLAN_FILES_MAX = 30

/** The per step revision tags a revised plan may carry. */
export const PLAN_STEP_TAGS = ['unchanged', 'changed', 'dropped'] as const
export type PlanStepTag = (typeof PLAN_STEP_TAGS)[number]

/** How the plan was asked for. Claude Code never sends `mode` (see the header). */
export const PLAN_DOORS = ['typed', 'decided', 'mode'] as const
export type PlanDoor = (typeof PLAN_DOORS)[number]

export type PlanCardState = 'proposed' | 'superseded'

export interface PlanCardStep {
  text: string
  file?: string
  check?: string
  tag?: PlanStepTag
}

export interface PlanCardPayload {
  kind: typeof PLAN_CARD_KIND
  v: number
  title: string
  summary?: string
  steps: PlanCardStep[]
  files?: string[]
  check?: string
  door: PlanDoor
  enforced: boolean
  plan_id: string
  revision: number
  supersedes?: number
  state: PlanCardState
  note?: string
  agent_route: string
}

/**
 * The chip CODES. `callbackData` is a code the app relabels, exactly as `ea:`
 * codes are relabelled today, so this plugin never chooses the words the owner
 * reads and Arabic comes for free. The `text` here is only what an OLD app,
 * which does not know these codes, would draw.
 */
export const PLAN_CHIP_GO = 'plan:go'
export const PLAN_CHIP_CHANGE = 'plan:change'
export const PLAN_CHIP_NO = 'plan:no'

export type PlanChoice = 'go' | 'change' | 'no'

export interface PlanCardOption {
  text: string
  callbackData: string
  style: 'default' | 'primary' | 'success' | 'danger'
}

export function planCardOptions(): PlanCardOption[] {
  return [
    { text: 'Go ahead', callbackData: PLAN_CHIP_GO, style: 'success' },
    { text: 'Change the plan', callbackData: PLAN_CHIP_CHANGE, style: 'default' },
    { text: 'Do not do this', callbackData: PLAN_CHIP_NO, style: 'danger' },
  ]
}

/** Which plan answer a callback code is, or null when it is not one at all. */
export function planChoiceOf(callbackData: unknown): PlanChoice | null {
  switch (typeof callbackData === 'string' ? callbackData : '') {
    case PLAN_CHIP_GO:
      return 'go'
    case PLAN_CHIP_CHANGE:
      return 'change'
    case PLAN_CHIP_NO:
      return 'no'
    default:
      return null
  }
}

/**
 * The summary line the model reads for a plan answer.
 *
 * Go ahead and Do not do this ride the ordinary click wording, because the
 * generic intake already says the right thing: `Clicked: Go ahead`. The typed
 * revision does NOT: the app posts the owner's words as `custom_text` on the
 * click rather than as a separate message (one stimulus, never a click plus a
 * message), and the generic intake would render that as `Clicked: "make it
 * shorter"`, which reads as a button label. `Change the plan: make it shorter`
 * is what actually happened.
 *
 * THE LABEL IS THE PLUGIN'S, NOT THE APP'S, and that is the second reason this
 * function exists. The chips are CODES the app relabels in the owner's own
 * language, so the `button_text` that comes back on the click can be Arabic.
 * That is right on screen and wrong in a transcript a model reads to decide
 * what to do: `Clicked: <arabic>` does not distinguish Go ahead from Do not do
 * this. So a plan answer is named here, in the one language the directive
 * beside it is written in, off the code rather than off the label.
 *
 * Returns null for anything that is not a plan code, which leaves the existing
 * wording exactly as it was for every other button in the app.
 */
export function describePlanClick(input: {
  callbackData: unknown
  customText?: string | null
}): string | null {
  const choice = planChoiceOf(input.callbackData)
  if (choice === null) return null
  if (choice === 'change') {
    const typed = (input.customText ?? '').trim()
    return typed ? `Change the plan: ${typed}` : 'Change the plan (no words given)'
  }
  return `Clicked: ${choice === 'go' ? 'Go ahead' : 'Do not do this'}`
}

/**
 * What the model is told to do next, appended under the click summary. The
 * click alone is ambiguous on this channel: nothing here starts a turn for the
 * agent or flips a mode, so the instruction has to travel with the answer.
 */
export function planAnswerDirective(choice: PlanChoice): string {
  switch (choice) {
    case 'go':
      return 'The owner approved the plan. Carry it out now, in the order you proposed, and keep your live Steps honest as you work.'
    case 'change':
      return 'The owner wants the plan changed, in their words above. Do NOT start work. Propose a revised plan with propose_plan, passing supersedes set to this message id.'
    case 'no':
      return 'The owner turned the plan down. Do NOT start work and do NOT propose a replacement unasked. Acknowledge briefly and wait for new instructions.'
  }
}

function clamp(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

export interface PlanCardInput {
  title?: unknown
  summary?: unknown
  steps?: unknown
  files?: unknown
  check?: unknown
  door?: unknown
  note?: unknown
  supersedes?: unknown
}

export interface PlanCardIdentity {
  planId: string
  revision: number
}

/**
 * Read the `supersedes` argument on its own, BEFORE the payload is built.
 *
 * It is separate because the plan's identity depends on it: a revision keeps
 * the id of the plan it replaces and counts up. Building a payload with a
 * placeholder id and patching it afterwards would leave a shape that is only
 * correct if the caller remembers the second step.
 */
export function parsePlanSupersedes(
  raw: unknown,
): { ok: true; supersedes?: number } | { ok: false; error: string } {
  if (raw == null || raw === '') return { ok: true }
  const asNumber = Number(raw)
  if (!Number.isInteger(asNumber) || asNumber <= 0) {
    return { ok: false, error: 'supersedes must be the message id of the plan this replaces' }
  }
  return { ok: true, supersedes: asNumber }
}

export type PlanCardBuild =
  | { ok: true; payload: PlanCardPayload }
  | { ok: false; error: string }

/**
 * Validate and normalize what the model passed into the payload that goes on
 * the wire.
 *
 * The split between refusing and clamping is deliberate. A STRUCTURAL mistake
 * (no title, no steps, more than thirty) is refused, because the model can fix
 * it and a half plan on the owner's screen is worse than an error in the
 * transcript. PROSE over its cap is clamped, because losing a whole plan to a
 * sentence three characters long is the wrong trade, and the caps are generous.
 */
export function buildPlanCardPayload(
  input: PlanCardInput,
  identity: PlanCardIdentity,
): PlanCardBuild {
  const title = clamp(input.title, PLAN_TITLE_MAX)
  if (!title) return { ok: false, error: 'title is required' }

  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    return { ok: false, error: 'steps is required and must have at least one step' }
  }
  if (input.steps.length > PLAN_STEPS_MAX) {
    return {
      ok: false,
      error: `steps must have ${PLAN_STEPS_MAX} or fewer entries (got ${input.steps.length})`,
    }
  }

  const steps: PlanCardStep[] = []
  for (const [index, raw] of input.steps.entries()) {
    const row = (raw ?? {}) as Record<string, unknown>
    const text = clamp(typeof row.text === 'string' ? row.text : raw, PLAN_STEP_TEXT_MAX)
    if (!text) return { ok: false, error: `step ${index + 1} has no text` }
    const step: PlanCardStep = { text }
    const file = clamp(row.file, PLAN_STEP_FILE_MAX)
    if (file) step.file = file
    const check = clamp(row.check, PLAN_CHECK_MAX)
    if (check) step.check = check
    const tag = typeof row.tag === 'string' ? row.tag.trim().toLowerCase() : ''
    if (tag) {
      if (!(PLAN_STEP_TAGS as readonly string[]).includes(tag)) {
        return {
          ok: false,
          error: `step ${index + 1} has tag "${tag}"; use one of ${PLAN_STEP_TAGS.join(', ')}`,
        }
      }
      step.tag = tag as PlanStepTag
    }
    steps.push(step)
  }

  let files: string[] | undefined
  if (input.files != null) {
    if (!Array.isArray(input.files)) return { ok: false, error: 'files must be an array of paths' }
    if (input.files.length > PLAN_FILES_MAX) {
      return {
        ok: false,
        error: `files must have ${PLAN_FILES_MAX} or fewer entries (got ${input.files.length})`,
      }
    }
    const kept: string[] = []
    for (const raw of input.files) {
      const one = clamp(raw, PLAN_STEP_FILE_MAX)
      if (one && !kept.includes(one)) kept.push(one)
    }
    if (kept.length > 0) files = kept
  }

  const doorRaw = typeof input.door === 'string' ? input.door.trim().toLowerCase() : ''
  // `mode` is a Codex door (a real read only session mode). A Claude Code
  // daemon that claimed it would put "Plan mode is on" under a card nothing
  // switched, so it is refused here rather than quietly rewritten.
  if (doorRaw === 'mode') {
    return {
      ok: false,
      error: 'door "mode" belongs to a channel with a real plan mode; use "typed" or "decided"',
    }
  }
  if (doorRaw && doorRaw !== 'typed' && doorRaw !== 'decided') {
    return { ok: false, error: `door must be one of typed, decided (got "${doorRaw}")` }
  }
  const door: PlanDoor = doorRaw === 'typed' ? 'typed' : 'decided'

  const parsedSupersedes = parsePlanSupersedes(input.supersedes)
  if (!parsedSupersedes.ok) return { ok: false, error: parsedSupersedes.error }
  const supersedes = parsedSupersedes.supersedes

  const payload: PlanCardPayload = {
    kind: PLAN_CARD_KIND,
    v: PLAN_CARD_PAYLOAD_VERSION,
    title,
    steps,
    door,
    enforced: PLAN_ENFORCED_ON_THIS_CHANNEL,
    plan_id: identity.planId,
    revision: identity.revision,
    state: 'proposed',
    agent_route: PLAN_AGENT_ROUTE,
  }
  const summary = clamp(input.summary, PLAN_SUMMARY_MAX)
  if (summary) payload.summary = summary
  if (files) payload.files = files
  const check = clamp(input.check, PLAN_CHECK_MAX)
  if (check) payload.check = check
  const note = clamp(input.note, PLAN_NOTE_MAX)
  if (note) payload.note = note
  if (supersedes !== undefined) payload.supersedes = supersedes
  return { ok: true, payload }
}

/**
 * The canonical text of the row. It is what every surface that does NOT render
 * the card shows: a notification, a search result, an old app, the morning
 * report. So it carries the plan itself, not a label.
 */
export function planCardText(payload: PlanCardPayload): string {
  const lines: string[] = [payload.title]
  if (payload.summary) lines.push('', payload.summary)
  lines.push('')
  for (const [index, step] of payload.steps.entries()) {
    const tag = step.tag ? ` [${step.tag}]` : ''
    lines.push(`${index + 1}. ${step.text}${tag}`)
    if (step.file) lines.push(`   ${step.file}`)
  }
  if (payload.check) lines.push('', `Check. ${payload.check}`)
  lines.push('', 'Nothing changes until you answer.')
  return lines.join('\n')
}

/** The collapsed card headline, and the one line under it. */
export function planCardEventTitle(payload: PlanCardPayload): string {
  return payload.revision > 1 ? `Plan (revised): ${payload.title}` : `Plan: ${payload.title}`
}

export function planCardPeek(payload: PlanCardPayload): string {
  const steps = `${payload.steps.length} step${payload.steps.length === 1 ? '' : 's'}`
  const fileCount = payload.files?.length ?? 0
  const files = fileCount > 0 ? `, ${fileCount} file${fileCount === 1 ? '' : 's'}` : ''
  return `${steps}${files}. Nothing changes until you answer.`
}

export interface PlanCardMessageBody {
  chatId: number
  sender: 'assistant'
  text: string
  messageType: 'event'
  renderMode: 'inline'
  options: PlanCardOption[]
  eventMeta: {
    source: string
    title: string
    peek: string
    payload: PlanCardPayload
  }
  sessionHandle?: string
}

/**
 * The body POSTed to `messages`. It has to be `messages` and not
 * `send-message`, because that is the only route that takes `eventMeta`, the
 * same reason the permission card goes there (server.ts, the comment above the
 * card post).
 *
 * `assistantId` is deliberately absent: this route resolves the author from the
 * credential, and a stray `assistantId` is exactly the unknown field the
 * backend's whitelist shadow log caught coming from a daemon. Same rule as
 * buildPermissionRequestBody.
 */
export function buildPlanCardBody(input: {
  chatId: string | number
  payload: PlanCardPayload
  sessionHandle?: string | null
}): { ok: true; body: PlanCardMessageBody } | { ok: false; error: string } {
  const chatId = Number(input.chatId)
  if (!Number.isInteger(chatId) || chatId <= 0) {
    return { ok: false, error: 'chat id did not resolve to a number' }
  }
  const body: PlanCardMessageBody = {
    chatId,
    sender: 'assistant',
    text: planCardText(input.payload),
    messageType: 'event',
    renderMode: 'inline',
    options: planCardOptions(),
    eventMeta: {
      source: 'agent',
      title: planCardEventTitle(input.payload),
      peek: planCardPeek(input.payload),
      payload: input.payload,
    },
  }
  if (input.sessionHandle) body.sessionHandle = input.sessionHandle
  return { ok: true, body }
}

/**
 * The PATCH that retires the plan a revision replaces: the chips come off and
 * the payload flips to `superseded`, so the old card keeps its steps, dims, and
 * reads "Superseded by the plan below".
 *
 * `edit_message` cannot do this. It takes {message_id, text} and POSTs to
 * `webhook/edited_message`, carrying no options at all. The working mechanism
 * is the direct PATCH the permission relay's backstop and boot sweep already
 * use, which is what this body is for.
 */
export function buildPlanSupersedeBody(
  previous: PlanCardPayload,
): Record<string, unknown> {
  return {
    options: [],
    eventMeta: {
      source: 'agent',
      title: planCardEventTitle(previous),
      peek: planCardPeek(previous),
      payload: { ...previous, state: 'superseded' as const },
    },
  }
}

// ── The wait ─────────────────────────────────────────────────────────────────

/**
 * The status line written beside the agent while a plan waits, and how long it
 * survives with nothing to clear it.
 *
 * 1440 minutes is the DTO's ceiling, not a guess: a plan wait has no end by
 * design, so the honest choice between a line that vanishes in two hours (the
 * server default) and one that outlives the card is the longest the server will
 * store. It is cleared the moment any chip is tapped.
 */
export const PLAN_STATUS_TEXT = 'Waiting for your go ahead'
export const PLAN_STATUS_TTL_MINUTES = 1440

export function planStatusBody(): Record<string, unknown> {
  return { statusText: PLAN_STATUS_TEXT, ttlMinutes: PLAN_STATUS_TTL_MINUTES }
}

export function planStatusClearBody(): Record<string, unknown> {
  return { statusText: '' }
}

/**
 * How long a chat with an unanswered plan stays on the 2 s poll.
 *
 * THIS NUMBER IS THE HONEST PART OF THE PLAN WAIT. A click has ONE transport on
 * this plugin and it is the poll: no `inbound_click` socket listener is
 * registered, and the Agent Update Stream is off unless BGOS_UPDATE_STREAM is
 * "true". Inside the fast scope a tap lands in seconds; outside it, on the
 * healthy full sweep, a tap can sit unheard for five minutes.
 *
 * A plan wait has no end, so it cannot bound its own scope the way a permission
 * request does (PENDING_PERMISSION_FAST_MAX_MS is built from the request's
 * stored wait). Pinning the chat at 2 s forever instead would be 1,800 reads an
 * hour of a chat nobody is looking at, for a plan that may be answered tomorrow.
 * Half an hour is the scope bound the permission card uses, with a number this
 * time: a tap in the first thirty minutes lands at once, a later one within the
 * five minute sweep, and the PR says so rather than pretending otherwise.
 */
export const PENDING_PLAN_FAST_MAX_MS = 30 * 60_000

export interface PendingPlan {
  chatId: string
  messageId: number
  planId: string
  revision: number
  postedAtMs: number
  payload: PlanCardPayload
}

/**
 * Which chats earn the 2 s tick because a plan is open there. Same shape and
 * same clock rules as pendingPermissionFastChatIds: a backwards clock reads as
 * "not fresh" rather than as forever.
 */
export function pendingPlanFastChatIds(
  pending: Iterable<{ chatId: string; postedAtMs: number }>,
  nowMs: number,
  maxMs: number = PENDING_PLAN_FAST_MAX_MS,
): string[] {
  const out = new Set<string>()
  for (const p of pending) {
    const age = nowMs - p.postedAtMs
    if (age < 0) continue
    if (age >= maxMs) continue
    out.add(String(p.chatId))
  }
  return [...out]
}

/**
 * The identity of the next card in a chat: a revision keeps its plan's id and
 * counts up, a fresh plan starts at 1.
 *
 * The `supersedes` id is what decides it, NOT whatever happens to be open,
 * because a daemon that restarted mid wait has no record of the plan it is
 * revising. In that case the revision starts a new plan id and still PATCHes
 * the row the model named, which is the honest degradation: the old card dims,
 * the new one is not labelled revision 2.
 */
export function nextPlanIdentity(input: {
  supersedes?: number
  open?: PendingPlan | null
  mintPlanId: () => string
}): PlanCardIdentity {
  const { supersedes, open } = input
  if (supersedes != null && open != null && open.messageId === supersedes) {
    return { planId: open.planId, revision: open.revision + 1 }
  }
  return { planId: input.mintPlanId(), revision: 1 }
}
