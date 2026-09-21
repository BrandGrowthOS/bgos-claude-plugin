/**
 * The permission relay's pure half.
 *
 * WHY THIS FILE EXISTS. Until 0.42.1 this daemon asked its owner for a tool
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
 * THE ONE THING THIS DOES NOT FIX, SAID PLAINLY SO NOBODY READS IT AS FIXED.
 * The card has to go to POST /api/v1/messages, because that is the only route
 * whose DTO carries an `approvalMeta` at all (the /send-message body declares
 * none, and the whitelist strips what it does not declare). That route sends
 * NO device push: its DM arm does a WebSocket emit, an unread bump and the
 * activity detector, and every push helper in the backend, `needsYou`
 * category included, is called from the /send-message service alone. The
 * plain message this replaced DID ring the owner's phone, under the wrong
 * category and with no permission words, but it rang it. So until the backend
 * sends the approval push from the create path as well, a request raised
 * while the app is closed reaches nobody and then denies itself. That is a
 * backend change, not one this repo can make, and it is the one thing
 * standing between this and the stage it belongs to.
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
 * The retired vocabulary. NEW prompts never send it, but a daemon that
 * updates while a prompt is still on the owner's screen would otherwise hang
 * that prompt forever, so one release of tolerance: 0.42.1 still RECOGNISES
 * an incoming `perm:` click and resolves it. Drop this, and the two consumers
 * of it, once no 0.42.0 daemon is left in the fleet.
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
  /** How long this request waits, already resolved by permissionWaitSeconds. */
  waitSeconds: number
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
      agent_route: 'claude-code',
      // The CLI hands us no risk signal at all, so claiming low or high would
      // be an invention. The app hides the pill unless the owner turned
      // technical details on, so the value is an audit field here, not copy.
      risk: 'medium',
      request_id: input.requestId,
      // ALWAYS sent. See permissionWaitSeconds: an absent wait is not "as it
      // was", it is the server's 60 s, which is shorter than the clock this
      // change removed.
      wait_seconds: input.waitSeconds,
    },
  }
}

// ── The owner's wait ─────────────────────────────────────────────────────────

/** The server's own floor and ceiling for a per agent approval wait. */
export const APPROVAL_WAIT_MIN_SECONDS = 60
export const APPROVAL_WAIT_MAX_SECONDS = 1800

/**
 * Read `approvalWaitSeconds` off an assistant row. Anything that is not a
 * whole number inside the server's own range is ignored, which covers every
 * way this read can come back thin: an older backend without the column, a
 * 304 with no body, a null, a string, a value some other client wrote through
 * the API. A null answer is handed to permissionWaitSeconds, which decides
 * what a request with no owner preference actually waits.
 *
 * WHETHER A DAEMON SHOULD READ THIS AT ALL IS AN OPEN QUESTION, one level up.
 * The other reading of the rule is that a plugin never reads a per agent
 * setting: it always asks for the longest it can hold, and the SERVER stores
 * the smaller of that and the owner's choice. The two only differ when this
 * read fails, and permissionWaitSeconds answers that case the same way either
 * reading would, so the wait an owner gets is the same under both today. What
 * is left is the 3 s this read costs a blocked agent, and the day the server
 * starts clamping, this whole function is dead weight rather than wrong.
 */
export function parseApprovalWaitSeconds(data: unknown): number | null {
  if (data === null || typeof data !== 'object') return null
  const raw = (data as { approvalWaitSeconds?: unknown }).approvalWaitSeconds
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null
  if (raw < APPROVAL_WAIT_MIN_SECONDS || raw > APPROVAL_WAIT_MAX_SECONDS) return null
  return raw
}

/**
 * The generic fail closed wait the server applies when a row carries no
 * `wait_seconds` of its own (APPROVAL_TIMEOUT_SECONDS). Nothing here sends a
 * card without one any more; the number is kept because it is the reason why.
 */
export const DEFAULT_APPROVAL_WAIT_SECONDS = 60

/**
 * How long THIS request waits, and the one number both the card and the
 * backstop below are built from.
 *
 * WHY A FAILED READ IS NOT "SEND NOTHING" (found in review, and it was the
 * live case: a backend without the column answers every read thin). Sending
 * no `wait_seconds` does not leave the request as it was. The server then
 * applies its generic 60 s and refuses the owner's tap by the expiry flag, so
 * the window would have been SHORTER than the 120 s local clock this change
 * removed, on every request, for as long as the column took to deploy.
 *
 * So a request with no owner preference asks for the longest this daemon can
 * hold its own side open. That is also exactly what a plugin is asked to send
 * once the SERVER does the deciding (it stores the smaller of this and the
 * agent's own setting), so the number is right under both readings and the
 * owner can only ever gain time, never lose it.
 */
export function permissionWaitSeconds(fromAssistant: number | null | undefined): number {
  return fromAssistant ?? APPROVAL_WAIT_MAX_SECONDS
}

/**
 * The local backstop: the request's own wait plus 90 s of slack.
 *
 * It is NOT a second deadline racing the server. The server flags an
 * unanswered row somewhere between its deadline and the next 30 s sweep, and
 * the poll below reads that flag; the backstop only catches the case where no
 * answer of any kind ever comes back, so it must sit BEHIND every honest
 * server answer, never in front of one.
 */
export function permissionBackstopMs(waitSeconds: number): number {
  return (waitSeconds + 90) * 1000
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
 * The requester binding is unchanged: only the user who drove the session that
 * raised the request may answer it. The comparison is still a no op on a
 * backend that stamps no per sender id (senderUserIdOf falls back to the
 * owner), and tightens by itself the moment one does.
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
  pollIntervalMs: number
  /**
   * Is this request still ours to answer.
   *
   * THE WATCH CANNOT SEE A BUTTON CLICK. The click resolves the request on
   * the other side of the race, and the server stamps the answer on the CARD
   * row without writing any user message, so `verdictFrom` below is blind to
   * it for ever. Without this the loop polled on to the full backstop after
   * the owner had answered in five seconds, then stripped the buttons off the
   * answered card and logged that nobody had replied. Harmless at 120 s; not
   * harmless at half an hour times a fleet of daemons.
   */
  stillPending: () => boolean
  /** One look at the chat. Null means nothing new (a 304) or a failed look. */
  rows: () => Promise<readonly T[] | null>
  /** Has the SERVER declared this request dead. */
  expiredOn: (row: T) => boolean
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
    await w.sleep(w.pollIntervalMs)
    // Between two looks at the chat is the ONLY place this loop can learn the
    // owner answered, because the click is settled on the other side of the
    // race and leaves nothing here to read.
    if (!w.stillPending()) return cancelled
    const rows = await w.rows()
    if (!rows) continue

    for (const row of rows) {
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
