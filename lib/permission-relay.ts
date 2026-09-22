/**
 * The permission relay's pure half.
 *
 * WHY THIS FILE EXISTS. Until 0.44.1 this daemon asked its owner for a tool
 * permission on a rail of its very own: a PLAIN message carrying
 * `perm:<choice>:<id>` buttons, and a hard coded 120 s local wait. It looked
 * like the platform's approval card and was nothing like it. The consequences
 * were all invisible from inside this repo, which is why they lasted:
 *
 *   - the app rendered a row of grey chips, never the approval card, so none
 *     of the card's words, colours or fail closed line reached Claude Code;
 *   - `classifyAssistantReply` saw a standard message and answered "done", so
 *     an agent sitting on a live permission prompt read as FINISHED on every
 *     needs you surface;
 *   - the push classifier gates on `approvalMeta`, so the prompt went out
 *     under the ordinary message category and the wrong toggle;
 *     BUT READ THE NOTE BELOW: this one is NOT fixed here, and the move made
 *     it worse before it makes it better;
 *   - `findPendingApprovals` filters on `message_type = 'approval_request'`,
 *     so a waiting request never reached the morning report;
 *   - and the plugin's own offline capability text told its agent "Approvals
 *     use the ea:{choice}:{id} callback format", which was simply false here.
 *
 * So the relay moves onto the rail the rest of the platform already uses, and
 * everything that can be decided from data alone is decided HERE, because
 * server.ts is one 11,000 line file and nothing inside it can be unit tested
 * without booting a daemon.
 *
 * THE ORDER THIS SHIPS IN, AND THE TWO BACKEND HALVES IT WAITS ON. Both are
 * on one BGOS branch, `feat/p2-requests-wait-for-you`, and neither is on the
 * deployed backend, so this release should reach hosts AFTER that one is out.
 *
 *   - THE PUSH. The card has to go to POST /api/v1/messages, because that is
 *     the only route whose DTO carries an `approvalMeta` at all (the
 *     /send-message body declares none, and the whitelist strips what it does
 *     not declare). That route sends NO device push today: its DM arm does a
 *     WebSocket emit, an unread bump and the activity detector, and every push
 *     helper in the backend, `needsYou` category included, is called from the
 *     /send-message service alone. The plain message this replaced DID ring
 *     the owner's phone, under the wrong category and with no permission
 *     words, but it rang it.
 *   - THE PER AGENT CLAMP, which is what makes the offer below an offer. The
 *     deployed backend caps `wait_seconds` at 1800 and stores what it is
 *     given, so until the clamp lands every request from this daemon waits the
 *     full 30 minutes whatever the owner chose for this agent.
 *
 * THE SERVER IS THE ONLY JUDGE OF WHEN A REQUEST IS DEAD. A daemon that runs
 * a shorter clock of its own declares a decline while the card in the owner's
 * hand is still tappable, so the owner taps Allow and nothing happens. The
 * wait therefore ends on one of three things: the owner's answer, the
 * server's own `approval_meta.expired` flag, or a local backstop that sits
 * well BEHIND the server's deadline and exists only for a server that never
 * answers at all.
 */

export type PermissionBehavior = 'allow' | 'deny'
export type PermissionChoice = 'once' | 'session' | 'permanent' | 'deny'

/**
 * The shape of a request id as this CLI mints it: five characters with the
 * visually ambiguous glyphs (l, o and their digit twins) left out, because a
 * click has always had to be typeable as the "yes <id>" fallback too. Both
 * callback vocabularies below are pinned to it, so a foreign `ea:` click
 * carrying a UUID (a Codex approval, say) never parses as ours and is left
 * alone.
 */
const REQUEST_ID_PATTERN = '([a-km-z]{5})'

/** Typed fallback verdict: "yes abcde" or "no abcde". */
export const VERDICT_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

/**
 * The platform's approval vocabulary, and the only one NEW prompts speak.
 * Exactly two choices, because `choiceToBehavior` collapses every yes into a
 * bare allow (the channel protocol accepts nothing else), and a wider yes on
 * the card would promise the owner a memory this agent does not have.
 */
export const APPROVAL_CALLBACK_RE = new RegExp(
  `^ea:(once|deny):${REQUEST_ID_PATTERN}$`,
  'i',
)

/**
 * The retired vocabulary, kept for one release, and NOT for the reason the
 * first version of this comment gave. It CANNOT carry a prompt across a
 * restart: `pendingPermissions` is an in memory map, so the only process that
 * can still hold an entry for a `perm:` card is the one that posted it, and a
 * daemon that updated is not that process. A click on such a card resolves to
 * nothing, whatever this pattern does.
 *
 * What it buys is quiet. Recognised here, an orphaned legacy click reads as a
 * STALE permission click and both intakes swallow it; unrecognised, it would
 * be forwarded to the model as an ordinary `[button_clicked]` event, which is
 * a permission answer for a dead prompt arriving as chatter in the agent's
 * context. Drop this, and the two consumers of it, once no 0.44.0 or older
 * daemon is left in the fleet.
 */
export const PERMISSION_CALLBACK_RE = new RegExp(
  `^perm:(once|session|permanent|deny):${REQUEST_ID_PATTERN}$`,
  'i',
)

/**
 * Both vocabularies in one test, for the stream intake's `decideButtonsAnswered`
 * gate (it takes a single regex and only asks "is this a permission click").
 */
export const PERMISSION_CLICK_RE = new RegExp(
  `^(?:ea:(?:once|deny)|perm:(?:once|session|permanent|deny)):${REQUEST_ID_PATTERN}$`,
  'i',
)

export interface ParsedPermissionClick {
  choice: PermissionChoice
  requestId: string
  /** Which vocabulary carried it, so the log can say when a legacy one arrives. */
  vocabulary: 'ea' | 'perm'
}

/** Read a button callback as a permission verdict, in either vocabulary. */
export function parsePermissionClick(
  callbackData: string,
): ParsedPermissionClick | null {
  const current = APPROVAL_CALLBACK_RE.exec(callbackData)
  if (current) {
    return {
      choice: current[1]!.toLowerCase() as PermissionChoice,
      requestId: current[2]!,
      vocabulary: 'ea',
    }
  }
  const legacy = PERMISSION_CALLBACK_RE.exec(callbackData)
  if (legacy) {
    return {
      choice: legacy[1]!.toLowerCase() as PermissionChoice,
      requestId: legacy[2]!,
      vocabulary: 'perm',
    }
  }
  return null
}

export function choiceToBehavior(choice: PermissionChoice): PermissionBehavior {
  // Claude Code's channel permission protocol, as used by the official
  // Telegram plugin, accepts only behavior='allow' or 'deny'. Every yes
  // collapses to 'allow'; the card offers only "Allow once" precisely so the
  // owner is never shown a scope this collapse would quietly discard.
  return choice === 'deny' ? 'deny' : 'allow'
}

/**
 * Read a verdict out of a message the owner sent. Accepts a button callback
 * replayed as text, the typed "yes <id>" / "no <id>" fallback, and the visible
 * button LABEL, which some clients materialise instead of the callback.
 */
export function parsePermissionChoice(
  text: string,
  requestId: string,
): PermissionChoice | null {
  const trimmed = text.trim()
  const click = parsePermissionClick(trimmed)
  if (click && click.requestId.toLowerCase() === requestId.toLowerCase()) {
    return click.choice
  }

  const typed = VERDICT_RE.exec(trimmed)
  if (typed && typed[2]?.toLowerCase() === requestId.toLowerCase()) {
    return typed[1]!.toLowerCase().startsWith('y') ? 'once' : 'deny'
  }

  // Label matching is safe here because the caller only inspects messages
  // newer than the prompt itself. The retired labels stay listed for the same
  // one release of tolerance as the `perm:` vocabulary above.
  //
  // THE APP'S OWN WORDS COME FIRST, because it no longer renders this
  // plugin's English at all: it reads the `ea:` code and writes "Yes, this
  // once" in the owner's language. A client that materialises a tap as its
  // visible label rather than its callbackData therefore matched NOTHING in
  // this list after the move, and the owner's yes was lost.
  //
  // A bare "No" is deliberately absent. These texts are swallowed rather than
  // forwarded to the model, and "no" is an ordinary thing to say to an agent.
  // The asymmetry is safe: an unheard No still ends the wait as a deny, an
  // unheard Yes throws the owner's permission away. The localised twins are
  // left out for the same reason, the callbackData path is the real one.
  const normalized = trimmed.toLowerCase().replace(/[✅🔒❌]/g, '').trim()
  if (normalized === 'yes, this once') return 'once'
  if (normalized === 'allow once') return 'once'
  if (normalized === 'allow for session') return 'session'
  if (normalized === 'allow permanently' || normalized === 'always allow') return 'permanent'
  if (normalized === 'do not allow' || normalized === 'deny' || normalized === 'not allowed') return 'deny'

  return null
}

/**
 * The owner's tap, read off the CARD ROW itself.
 *
 * THIS IS THE CLICK TRANSPORT, and until 0.44.1 shipped it was missing. A tap
 * on an approval card writes no user message at all: the backend stamps
 * `answered_at` and an `answer_payload` on the card row and pushes the event
 * to whichever daemon is paired for clicks. This one is not: it registers no
 * inbound click listener, and its only other lane is the opt in update
 * stream, off by default. So with the card off the newest page, or with the
 * daemon draining for an update, the owner's Allow reached nothing and the
 * request died at the backstop as a deny.
 *
 * Both halves are required. An `answer_payload` with no `answered_at` is not
 * an answer, and `answered_at` with no callback is an answer this daemon
 * cannot read; either way the wait goes on rather than inventing a verdict.
 * The payload is the backend's camelCase shape, with the pre 2026-04-22 snake
 * twin read as a fallback, and the callback goes through the same parser both
 * click intakes use, so it accepts exactly what they accept and nothing else:
 * the request id must be this request's.
 */
export function answeredPermissionChoice(
  row:
    | {
        answeredAt?: string | null
        answerPayload?:
          | { callbackData?: string; callback_data?: string }
          | null
      }
    | null
    | undefined,
  requestId: string,
): PermissionChoice | null {
  if (row === null || row === undefined) return null
  const answeredAt = row.answeredAt
  if (typeof answeredAt !== 'string' || answeredAt.trim() === '') return null
  const payload = row.answerPayload
  if (payload === null || typeof payload !== 'object') return null
  const callbackData = payload.callbackData ?? payload.callback_data
  if (typeof callbackData !== 'string' || callbackData === '') return null
  return parsePermissionChoice(callbackData, requestId)
}

/**
 * The sender id an inbound shaped object CARRIES, or null when it carries
 * none. server.ts's `senderUserIdOf` is this function plus `?? USER_ID`, so
 * the owner fallback lives in exactly one place and the two readers cannot
 * drift apart about what counts as an id.
 *
 * NULL IS THE POINT, and a re review is what found it missing. The card read
 * in `waitForVerdict` compares the tapper against the user who raised the
 * request, and it reads that tapper off the ANSWER PAYLOAD, which no backend
 * stamps an id on today. Read through the owner fallback, an unstamped tap
 * therefore reads as the OWNER, and on a SHARED assistant, where the requester
 * is the person the agent was shared with, every real tap compares unequal and
 * the owner's Allow becomes a deny at the backstop. Told apart, an unstamped
 * tap can be taken for what it is, a tap nobody can attribute, and only a tap
 * that NAMES a different user is dropped.
 */
export function senderUserIdCandidate(message: unknown): string | null {
  const m = message as Record<string, unknown> | null | undefined
  // A WS payload carries a nested sender object; a REST poll row carries a
  // flat senderUserId (its own `sender` field is the role string, not an
  // object, so reading .userId off it is a harmless undefined).
  const nestedSender = m?.sender as { userId?: unknown } | null | undefined
  const candidate =
    (nestedSender?.userId as string | undefined) ??
    (m?.senderUserId as string | undefined) ??
    (m?.sender_user_id as string | undefined) ??
    (m?.userId as string | undefined) ??
    (m?.user_id as string | undefined)
  return typeof candidate === 'string' && candidate !== '' ? candidate : null
}

// ── The card ─────────────────────────────────────────────────────────────────

export interface PermissionOption {
  text: string
  callbackData: string
  style: 'success' | 'danger'
}

/**
 * The two buttons, in the platform's vocabulary. The English here is only
 * what an OLD app would render: a current app relabels both from the `ea:`
 * code itself, in the owner's own language.
 */
export function permissionApprovalOptions(requestId: string): PermissionOption[] {
  return [
    { text: 'Allow once', callbackData: `ea:once:${requestId}`, style: 'success' },
    { text: 'Deny', callbackData: `ea:deny:${requestId}`, style: 'danger' },
  ]
}

/**
 * How much of an input preview travels in `approval_meta.tool`. The preview is
 * whatever the CLI hands us and has no documented ceiling, and this field is
 * no longer only a line in a chat bubble: it is a JSONB value the morning
 * report selects out (`m.approval_meta->>'tool'`) and the card's command panel
 * always shows. A generous cap keeps one runaway tool input from bloating
 * every read of the row.
 */
export const APPROVAL_TOOL_MAX_CHARS = 2000

/**
 * Which agent framework raised the request, as the card's `approval_meta`
 * carries it. It is also how the boot sweep below recognises a card this
 * daemon's own kind posted, so the two must stay one constant.
 */
export const PERMISSION_AGENT_ROUTE = 'claude-code'

/**
 * Cap the preview, AND SAY SO WHERE IT WAS CUT. The card's command panel is
 * always visible precisely so a person can see what they are allowing, and a
 * silent prefix renders as a complete, shorter command: the owner would
 * approve an action whose tail they never saw. The marker is inside the cap,
 * so the field is never longer than the number above.
 */
function capToolPreview(preview: string): string {
  if (preview.length <= APPROVAL_TOOL_MAX_CHARS) return preview
  return `${preview.slice(0, APPROVAL_TOOL_MAX_CHARS - 3)}...`
}

/** The card's text: the CLI's own words for the ask. */
export function permissionCardText(
  description: string | undefined,
  toolName: string,
): string {
  const ask = (description ?? '').trim()
  if (ask) return ask
  // Blank description: say the one thing we always know. Never an empty card.
  return `Claude Code wants to use ${toolName}.`
}

export interface PermissionRequestBodyInput {
  chatId: string | number
  requestId: string
  toolName: string
  description?: string
  inputPreview?: string
}

/**
 * The POST /api/v1/messages body for one permission request.
 *
 * The three fields that make the app render an approval CARD rather than a
 * message with chips are `messageType: 'approval_request'`, at least one
 * option, and a non null `approvalMeta`. All three are here, and the test
 * beside this file pins them, because dropping any one of them silently
 * returns this relay to the grey chips it just left.
 *
 * `assistantId` is deliberately NOT sent: this route resolves the author from
 * the credential, and a stray `assistantId` is exactly the unknown field the
 * backend's whitelist shadow log caught coming from a daemon in July.
 */
export function buildPermissionRequestBody(
  input: PermissionRequestBodyInput,
): Record<string, unknown> {
  const preview = (input.inputPreview ?? '').trim()
  return {
    chatId: Number(input.chatId),
    sender: 'assistant',
    text: permissionCardText(input.description, input.toolName),
    messageType: 'approval_request',
    options: permissionApprovalOptions(input.requestId),
    approvalMeta: {
      tool: preview ? capToolPreview(preview) : input.toolName,
      agent_route: PERMISSION_AGENT_ROUTE,
      // The CLI hands us no risk signal at all, so claiming low or high would
      // be an invention. The app hides the pill unless the owner turned
      // technical details on, so the value is an audit field here, not copy.
      risk: 'medium',
      request_id: input.requestId,
      // ALWAYS sent, always the same number. See PERMISSION_HOLD_SECONDS: an
      // absent wait is not "as it was", it is the server's 60 s, which is
      // shorter than the clock this change removed.
      wait_seconds: PERMISSION_HOLD_SECONDS,
    },
  }
}

// ── The wait: this daemon offers, the server decides ─────────────────────────

/**
 * The longest this daemon keeps its own side of a request open, and the number
 * every card carries.
 *
 * IT IS AN OFFER, NOT A CHOICE, and that is the whole design. This plugin
 * never reads a per agent setting (there is a guard test for it, beside the
 * others): it sends the longest it can hold, and the SERVER stores the smaller
 * of this and the owner's own choice for this agent
 * (`assistants.approval_wait_seconds`, 10 minutes unless the owner changes
 * it). The stored number comes back on the created message, which is where
 * the backstop below reads it and what the card in the owner's hand says.
 * That clamp is the backend half named at the top of this file, and it is not
 * deployed yet: until it is, the server stores this number whole and every
 * request waits the full half hour.
 *
 * Sending nothing instead would not leave the request as it was: the server
 * applies its generic 60 s to a row with no `wait_seconds`, which is SHORTER
 * than the 120 s local clock this whole change removed.
 */
export const PERMISSION_HOLD_SECONDS = 1800

/**
 * The wait the SERVER stored, read off the message the POST just created.
 *
 * This is the only place this daemon ever learns the owner's real wait. A
 * whole number from 1 to the hold above is usable; everything else reads as
 * "not stated", which covers an older backend that echoes no `approvalMeta`,
 * a response shape that moved, and a value some other client wrote. The
 * backstop answers that case with the hold, which is the longest the server
 * could possibly have stored, so a thin response can only ever make this
 * daemon wait LONGER than it needed to, never shorter than the owner's card.
 */
export function storedWaitSeconds(posted: unknown): number | null {
  if (posted === null || typeof posted !== 'object') return null
  const meta = (posted as { approvalMeta?: unknown }).approvalMeta
  if (meta === null || typeof meta !== 'object') return null
  const raw = (meta as { wait_seconds?: unknown }).wait_seconds
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null
  if (raw < 1 || raw > PERMISSION_HOLD_SECONDS) return null
  return raw
}

/**
 * The local backstop: the wait the server stored, plus 90 s of slack.
 *
 * It is NOT a second deadline racing the server. The server flags an
 * unanswered row somewhere between its deadline and the next 30 s sweep, and
 * the poll below reads that flag; the backstop only catches the case where no
 * answer of any kind ever comes back, so it must sit BEHIND every honest
 * server answer, never in front of one. A response that stated no wait falls
 * back to the hold, for the same reason.
 */
export function permissionBackstopMs(storedSeconds: number | null): number {
  return ((storedSeconds ?? PERMISSION_HOLD_SECONDS) + 90) * 1000
}

/**
 * How often the watch below looks at the chat, as a function of how long this
 * request has been waiting.
 *
 * WHY IT IS NOT ONE NUMBER. A 30 minute request at a flat 1.5 s is about
 * 1,200 reads of the chat, per waiting daemon, and a fleet of them sits on the
 * same backend. The first minute keeps the fast cadence because that is where
 * an answer usually lands and a person watching the card expects their tap to
 * do something; after that the request is parked, and the server's own expiry
 * is what ends the wait anyway, so a slower look costs the owner nothing. The
 * same 30 minutes now costs about 390 looks here.
 *
 * THIS IS THE SMALLER HALF OF THE BILL, and the comment used to pretend it was
 * the whole of it. A pending request also fast scopes its chat on the
 * scheduler tick (pendingPermissionFastChatIds, below), which is a second read
 * of the same endpoint every 2 s; that one is bounded too, and the two
 * together are what a parked request actually costs.
 */
export const PERMISSION_POLL_FAST_MS = 1500
export const PERMISSION_POLL_SLOW_MS = 5000
export const PERMISSION_POLL_FAST_WINDOW_MS = 60_000

export function permissionPollIntervalMs(ageMs: number): number {
  // The boundary is `>=` so the tick at exactly 60 s is already the slow one.
  // Neither spelling can busy loop, whatever the clock does: the slowest thing
  // either branch returns is a 1.5 s sleep. The clock hazard in this file is
  // the other one, and it is on the BACKSTOP: the watch takes its elapsed time
  // from a monotonic reading (server.ts hands it performance.now()) precisely
  // because a wall clock that steps FORWARD, after a laptop resumes or an NTP
  // correction lands, would carry the elapsed time past the timeout and deny a
  // request whose card is still tappable, which is the 120 s bug in a new hat.
  return ageMs >= PERMISSION_POLL_FAST_WINDOW_MS
    ? PERMISSION_POLL_SLOW_MS
    : PERMISSION_POLL_FAST_MS
}

/**
 * The ceiling on how long a pending request can keep its chat on the
 * scheduler's 2 s fast scope.
 *
 * THE SECOND LOOP, found in review after the first version of this lane
 * counted only the watch. `fastScopeChatIds` reads the pending map, so every
 * unanswered request pins its chat at the base tick (2 s) for as long as its
 * entry lives. Unbounded, that is exactly the defect
 * BUTTON_PROMPT_FAST_WINDOW_MS exists to stop one loop over, in the same file,
 * for the same reason ("without a bound an abandoned prompt pins its chat at
 * 2s forever").
 *
 * IT IS THE WAIT, NOT TEN MINUTES, and that is the correction a second review
 * forced. The first version of this bound dropped the chat at ten minutes and
 * argued that a tap past it still arrived "on the socket", with the watch
 * reading every 5 s behind it. Neither was a mechanism: this daemon registers
 * no inbound click listener at all (its only WebSocket click lane is the opt
 * in update stream), and the watch could not see a tap either until
 * `answeredPermissionChoice` above gave it one.
 *
 * What the scope really buys is the OTHER click lane: the ordinary poll reads
 * `answered_at` flipping on the newest page, and a chat outside the fast scope
 * is read on the five minute full sweep instead of every 2 s, so a tap could
 * sit heard by nobody for five minutes. So the scope lasts as long as this
 * daemon is still listening to the request: `waitMs`, the backstop built from
 * the wait the SERVER stored, which is the owner's own per agent choice once
 * the clamp is deployed and this daemon's hold until then.
 *
 * The number below is therefore not the bound, it is the leak guard: an entry
 * whose stored wait was never learned, and an entry some later path forgets to
 * delete, still cannot pin a chat past the longest this daemon could still be
 * listening to it.
 *
 * WHICH IS THE BACKSTOP, NOT THE WAIT, and the 90 s between the two is not a
 * rounding. `permissionBackstopMs` sits that far behind the stored wait
 * precisely so a server that never answers is still given every chance, and
 * the watch goes on reading the card through all of it. A ceiling at the bare
 * wait therefore cut the unclamped case 90 s short of the loop that was still
 * listening, which is the one thing the paragraph above promises it cannot
 * do.
 */
export const PENDING_PERMISSION_FAST_MAX_MS = permissionBackstopMs(PERMISSION_HOLD_SECONDS)

export function pendingPermissionFastChatIds(
  pending: Iterable<{ chatId: string; createdAt: number; waitMs?: number }>,
  nowMs: number,
  maxMs: number = PENDING_PERMISSION_FAST_MAX_MS,
): string[] {
  const out = new Set<string>()
  for (const p of pending) {
    const age = nowMs - p.createdAt
    // A backwards clock reads as "not fresh" rather than as forever, the same
    // rule activeButtonPromptChatIds applies to a prompt.
    if (age < 0) continue
    // An entry that has not learned its wait yet (the card is posted after the
    // entry exists) is treated as the longest it could be, which is also the
    // ceiling, so the fast scope is never dropped while the post is in flight.
    const windowMs = Math.min(p.waitMs ?? maxMs, maxMs)
    if (age >= windowMs) continue
    out.add(String(p.chatId))
  }
  return [...out]
}

/**
 * The id of the card that was just posted, or null.
 *
 * Null is not cosmetic: it turns OFF both halves of the server-is-the-judge
 * arm at once, because `expiredOn` can then never match a row and
 * `retireCard` has nothing to PATCH, and the request falls all the way
 * through to the backstop. The caller logs that in those words rather than
 * printing "message unknown" and moving on.
 */
export function cardMessageIdFrom(posted: unknown): number | null {
  if (posted === null || typeof posted !== 'object') return null
  const id = (posted as { id?: unknown }).id
  return typeof id === 'number' && Number.isFinite(id) ? id : null
}

/** True when the server has already declared this request dead. */
export function isApprovalExpired(
  row: { approvalMeta?: { expired?: unknown } | null } | null | undefined,
): boolean {
  return row?.approvalMeta?.expired === true
}

// ── The cards a crash left behind ────────────────────────────────────────────

export interface PermissionCardRowLike {
  id: number
  sender: string | null
  messageType?: string | null
  answeredAt?: string | null
  /**
   * When the row was written, epoch ms, or null on a row carrying no readable
   * date. It is what `createdBefore` below is compared against.
   */
  createdAt?: number | null
  /** Does the row still carry its buttons, i.e. is it still tappable. */
  hasOptions: boolean
  approvalMeta?:
    | { expired?: unknown; agent_route?: unknown; request_id?: unknown }
    | null
}

export interface OrphanedPermissionCard {
  id: number
  /** `approval_meta.request_id`, when the row carries a readable one. */
  requestId: string | null
}

/**
 * How far BEHIND its own boot instant the sweep's caller sets `createdBefore`,
 * and it is there because the two sides of that comparison come off DIFFERENT
 * CLOCKS. The row's date is the BACKEND's stamp; the bound is this host's
 * `Date.now()`. A host running a minute ahead of the backend would read
 * another daemon's fresh card as older than its own boot and retire a card
 * that daemon is still waiting on. A minute of margin makes the bound smaller,
 * which is the protective direction: a smaller bound skips MORE rows, and the
 * rows it skips are this daemon's own orphans from the last minute before it
 * stopped, which keep their buttons until the server's own expiry.
 */
export const SWEEP_CLOCK_SKEW_MARGIN_MS = 60_000

/**
 * The cards this daemon left live looking when it died mid wait.
 *
 * `pendingPermissions` is memory, so a crash or a manual restart takes every
 * open request with it and nothing re-sends a verdict. The CARD does not go
 * anywhere: its buttons are stripped by the watch's backstop, which died with
 * the process, so the only thing left to retire it is the server's own expiry
 * at `created_at + wait_seconds`. That used to be a minute. It is now up to
 * half an hour of a card the owner can tap, whose tap the app will show as
 * answered while nothing is listening.
 *
 * So the boot sweep retires them itself. Every clause here is a way to not
 * touch a card that is not ours to touch:
 *
 *   - `hasOptions` is what makes this idempotent. A retired card is one with
 *     no buttons left, and nothing in the retirement changes `answered_at` or
 *     `expired`, so without this clause every boot would PATCH and log the
 *     same dead cards for ever.
 *   - the route is this daemon's own kind, so a Codex or Hermes approval in a
 *     shared chat is left strictly alone. It cannot tell one claude-code
 *     daemon from ANOTHER, and the chats this pairing monitors are no defence
 *     there, which is what the first version of this comment claimed: two
 *     daemons on one pairing monitor the SAME chats, so on that clause alone a
 *     booting daemon would strip the buttons off a card the other one is at
 *     that moment still waiting on.
 *   - answered and expired rows are already settled, and an answered one is
 *     the owner's record of what they chose.
 *   - `heldRequestIds` is the live guard for THIS process: the sweep runs
 *     after the MCP transport is up, so a request raised during boot is
 *     already being watched here and must not have its buttons taken away. It
 *     knows nothing about any other process.
 *   - `createdBefore` is the live guard for every other one, and it is the
 *     time bound the second review asked for: a row written at or after this
 *     process started cannot be a card THIS process left behind, so it is left
 *     alone whoever posted it. That covers every card another daemon raises
 *     from the moment this one boots. Three honest limits: a card another
 *     daemon raised BEFORE this boot still reads as an orphan; a row with no
 *     readable date is still swept, because the alternative is a sweep that
 *     silently does nothing on a backend that sends no date; and the two sides
 *     of the comparison come off DIFFERENT CLOCKS, the backend's stamp against
 *     this host's, which is why the caller sets the bound a
 *     SWEEP_CLOCK_SKEW_MARGIN_MS behind its own boot rather than on it, and
 *     pays for that with its own orphans from the last minute before it
 *     stopped.
 */
export function orphanedPermissionCards(
  rows: readonly PermissionCardRowLike[] | null | undefined,
  opts?: { heldRequestIds?: ReadonlySet<string>; createdBefore?: number },
): OrphanedPermissionCard[] {
  if (!rows) return []
  const held = opts?.heldRequestIds
  const createdBefore = opts?.createdBefore
  const out: OrphanedPermissionCard[] = []
  for (const row of rows) {
    if (row.sender !== 'assistant') continue
    if (row.messageType !== 'approval_request') continue
    if (!row.hasOptions) continue
    if (typeof row.answeredAt === 'string' && row.answeredAt.trim() !== '') continue
    const meta = row.approvalMeta
    if (meta === null || meta === undefined) continue
    if (meta.agent_route !== PERMISSION_AGENT_ROUTE) continue
    if (meta.expired === true) continue
    // Not ours to retire: this process did not exist when the card was
    // posted, so whoever is waiting on it, it is not a run that stopped.
    if (
      createdBefore !== undefined &&
      typeof row.createdAt === 'number' &&
      Number.isFinite(row.createdAt) &&
      row.createdAt >= createdBefore
    ) {
      continue
    }
    const rawId = meta.request_id
    const requestId = typeof rawId === 'string' && rawId !== '' ? rawId : null
    if (requestId !== null && held?.has(requestId)) continue
    out.push({ id: row.id, requestId })
  }
  return out
}

/**
 * One look at the chat, with the card guaranteed to be among the rows the
 * watch scans for as long as the server will still hand it over.
 *
 * THE READ IS A PAGE, and the first version of this wait quietly depended on
 * it not being one. `chats/<id>/messages` with no cursor is the NEWEST 50
 * rows, and the watch's expiry arm can only fire on a row it is given. At
 * 120 s that was safe; at the owner's whole wait it is not. The card goes into
 * `monitoredChatIds[0]`, which may be a busy meeting chat, and 50 messages
 * later the card is off the page: the server flags the row dead, the watch
 * never sees it, and the request runs to the backstop with the CLI blocked and
 * an auto update's drain held open behind it. That is the same shape as the
 * bug this whole change removes, at the other end of the wait.
 *
 * So the page is still what the typed fallback is read from, and the EXPIRY
 * stops depending on it: the first page that comes back without the card
 * switches on one anchored read of the card row itself, which is a single row
 * on its own validator. It stays on from then on, because "off the page" only
 * goes one way, and because the page's own 304 means "nothing new in the
 * newest 50", which is true and useless once the card is not among them.
 */
export function permissionRowsReader<T>(opts: {
  /** Null turns this off entirely: with no card id there is nothing to anchor. */
  cardMessageId: number | null
  idOf: (row: T) => number | null
  /** The page: rows, or null for a 304 or a failed look. */
  page: () => Promise<readonly T[] | null>
  /** The anchored read of the card row, or null for a 304 or a failed look. */
  card: () => Promise<T | null>
}): () => Promise<readonly T[] | null> {
  let offPage = false
  return async () => {
    const rows = await opts.page()
    if (opts.cardMessageId === null) return rows
    if (!offPage) {
      if (rows === null) return rows
      if (rows.some((row) => opts.idOf(row) === opts.cardMessageId)) return rows
      offPage = true
    }
    const card = await opts.card()
    if (card === null) return rows
    return rows === null ? [card] : [...rows, card]
  }
}

// ── Resolving a click ────────────────────────────────────────────────────────

export interface PendingPermissionLike {
  requesterUserId: string
  resolve: (choice: PermissionChoice) => void
}

export type PermissionClickOutcome =
  | { kind: 'not_permission' }
  | { kind: 'stale'; choice: PermissionChoice; requestId: string }
  | {
      kind: 'foreign'
      choice: PermissionChoice
      requestId: string
      clickerUserId: string
      requesterUserId: string
    }
  | {
      kind: 'resolved'
      choice: PermissionChoice
      requestId: string
      vocabulary: 'ea' | 'perm'
    }

/**
 * The one place a button click becomes a verdict, shared by BOTH transports
 * (the REST poll and the WebSocket stream). They used to carry a hand copied
 * version of this each, which is how the two drifted far enough apart that the
 * stream path needed a log line for "the other one's regex did not re-parse".
 *
 * The requester binding is unchanged, and the caller still reads the clicker
 * id through the OWNER FALLBACK: no click payload carries an id today, so it
 * reads as the owner, and on a SHARED assistant, where the requester is the
 * person the agent was shared with, their own click is refused here as
 * foreign. That rule predates the card read and is deliberately left as it is,
 * because a click refused here is not a verdict lost: the watch reads the same
 * answer off the card row a tick later, and THAT read is null aware
 * (`senderUserIdCandidate` above) precisely because its miss would cost the
 * owner a real approval at the backstop. Both decide on the same field the day
 * the backend stamps a clicker id on an answer.
 */
export function resolvePermissionClick(opts: {
  callbackData: string
  clickerUserId: string
  pending: Map<string, PendingPermissionLike>
}): PermissionClickOutcome {
  const click = parsePermissionClick(opts.callbackData)
  if (!click) return { kind: 'not_permission' }

  const entry = opts.pending.get(click.requestId)
  if (!entry) {
    return { kind: 'stale', choice: click.choice, requestId: click.requestId }
  }
  if (opts.clickerUserId !== entry.requesterUserId) {
    return {
      kind: 'foreign',
      choice: click.choice,
      requestId: click.requestId,
      clickerUserId: opts.clickerUserId,
      requesterUserId: entry.requesterUserId,
    }
  }
  entry.resolve(click.choice)
  opts.pending.delete(click.requestId)
  return {
    kind: 'resolved',
    choice: click.choice,
    requestId: click.requestId,
    vocabulary: click.vocabulary,
  }
}

// ── Waiting for the verdict ──────────────────────────────────────────────────

export interface PermissionVerdict {
  choice: PermissionChoice
  /** Which of the four endings happened, so the caller's log can say so. */
  via: 'answer' | 'expired' | 'backstop' | 'cancelled'
}

export interface VerdictWatch<T> {
  requestId: string
  /** The local backstop, from permissionBackstopMs. */
  timeoutMs: number
  /**
   * Is this request still ours to answer.
   *
   * A click intake can settle the request on the OTHER side of the race, and
   * when it does there is nothing left here to wait for. Without this the loop
   * polled on to the full backstop after the owner had answered in five
   * seconds, then stripped the buttons off the answered card and logged that
   * nobody had replied. Harmless at 120 s; not harmless at half an hour times
   * a fleet of daemons.
   */
  stillPending: () => boolean
  /** One look at the chat. Null means nothing new (a 304) or a failed look. */
  rows: () => Promise<readonly T[] | null>
  /** Has the SERVER declared this request dead. */
  expiredOn: (row: T) => boolean
  /**
   * Did the owner TAP, as stamped on the card row.
   *
   * THIS LOOP IS THE CLICK TRANSPORT, which is the whole of the second
   * review's first finding. A tap writes no user message, so `verdictFrom`
   * below can never see one, and the daemon's other two lanes both fail
   * exactly when the wait is long: the ordinary chat poll reads the newest 50
   * rows and stops seeing the card in a busy chat, and every intake is closed
   * while an update drains. The read this loop already does is not drain
   * gated and is anchored on the card once the page drops it, so reading the
   * answer HERE is the one lane that survives both. See
   * `answeredPermissionChoice`.
   *
   * The requester binding is the CALLER's, and on this lane it is NULL AWARE.
   * The tapper id is read off the answer payload, which carries no id on any
   * backend today: read through the owner fallback an unstamped tap would
   * compare unequal on a shared assistant and be thrown away, which is a
   * backstop deny of an approval the owner really gave. So an unstamped tap is
   * ACCEPTED, a tap that names a different user is dropped, and the two click
   * intakes keep their stricter rule because a click they drop reaches this
   * read anyway. All three decide on the same field the day the backend stamps
   * one.
   */
  answeredOn: (row: T) => PermissionChoice | null
  /** Did the owner answer, on this row. Impure by design: the caller advances
   *  its cursor here, exactly as it always did. */
  verdictFrom: (row: T) => PermissionChoice | null
  /** Best effort: strip the options off a card nobody is listening to. */
  retireCard: () => Promise<void>
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
}

/**
 * Watch one permission request until the owner answers, the server retires it,
 * or the backstop fires. Pure of everything but the callbacks it is handed, so
 * the three endings are testable on a fake clock instead of a live daemon.
 */
export async function watchPermissionVerdict<T>(
  w: VerdictWatch<T>,
): Promise<PermissionVerdict> {
  const startedAt = w.now()
  // The verdict arrived on the other transport. Nothing to log and nothing to
  // retire: the owner answered, and the card is theirs.
  const cancelled: PermissionVerdict = { choice: 'deny', via: 'cancelled' }

  while (w.now() - startedAt < w.timeoutMs) {
    // The cadence lives in the loop, not at the call site: the reads this
    // saves are the loop's own looks at the chat.
    await w.sleep(permissionPollIntervalMs(w.now() - startedAt))
    // ONE OF THE TWO WAYS AN ANSWER REACHES THIS LOOP: an intake settled the
    // request on the other side of the race, so the entry is gone from the map
    // and there is nothing left here to wait for. The other way is `answeredOn`
    // on the rows read just below, for the tap no intake heard at all. This
    // was the only way until that arm shipped, and the comment here went on
    // saying so after it was no longer true.
    if (!w.stillPending()) return cancelled
    const rows = await w.rows()
    if (!rows) continue

    for (const row of rows) {
      // THE TAP COMES FIRST, deliberately. The app's own rule is that an
      // answered card is answered whatever else is stamped on it, and the
      // owner's Allow must not lose a race with an expiry flag written in the
      // same window.
      const answered = w.answeredOn(row)
      if (answered) {
        w.log(`Permission [${w.requestId}]: the owner answered on the card (${answered})`)
        return { choice: answered, via: 'answer' }
      }
      if (w.expiredOn(row)) {
        w.log(`Permission [${w.requestId}]: the server retired this request, denying`)
        return { choice: 'deny', via: 'expired' }
      }
      const choice = w.verdictFrom(row)
      if (choice) return { choice, via: 'answer' }
    }
  }

  // One last look before the backstop: a click during the final read must not
  // cost the owner the buttons off a card they have already answered.
  if (!w.stillPending()) return cancelled

  // Nothing came back at all, not even an expiry: the owner must not be left
  // with a card that still looks answerable, so retire it on the way out.
  w.log(
    `Permission [${w.requestId}]: local backstop reached with no answer and ` +
      `no expiry from the server, denying`,
  )
  try {
    await w.retireCard()
  } catch (err) {
    w.log(`Permission [${w.requestId}]: could not retire the card (ignored): ${err}`)
  }
  return { choice: 'deny', via: 'backstop' }
}
