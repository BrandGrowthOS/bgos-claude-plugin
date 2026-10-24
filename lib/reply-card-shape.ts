/**
 * Is the reply the agent just sent card shaped, and should the reply tool say
 * so (0.74.2)?
 *
 * Measured 2026-10-25, read only on production: 61 of 63 live Claude Code
 * daemons declare ui_card, so the BGOS canon tells their agent it can compose
 * a card (show_component, kind ui_card, the Cards you compose section), and
 * ZERO cards were sent in 14 days. KC asked Mark to draft an email and got a
 * code block. A line on every message is too heavy for a simple reply, so the
 * decision is to nudge only when the reply just sent is card shaped, in the
 * reply tool's RESULT (what the agent reads next), never in the message.
 *
 * Four shapes, each one a block the ui_card grammar really has (backend
 * src/renderables/ui-card-schema.ts, UI_CARD_BLOCK_TYPES):
 *
 *   email_draft  To, Cc or Subject header lines, with a Subject and a To or
 *                Cc within a few lines of each other. In a code block too
 *                (Mark's draft was in one), but only a fence with no tag or a
 *                prose tag, and only bare unindented `To:` lines that do not
 *                read as code: a nodemailer sendMail, an EmailDraftDto or a
 *                send mail CI step SENDS email, it is not a draft. A keyvalue
 *                block.
 *   table        a markdown table, outside code, of 3 or more body rows. A
 *                table block.
 *   status_list  5 or more list items each LED by a status word or emoji
 *                (done, blocked, open, pending, failed, a tick), and most of
 *                the list. A word counts only with a mark after it (a colon,
 *                a dash, a bracket, bold), so a step list that says "Open the
 *                app" stays prose. A `- [ ]` / `- [x]` task box is NOT a
 *                status: the app renders a checklist as task boxes (5.9.0).
 *                A list block, the status as each item's meta.
 *   comparison   2 or more options that are CHOICES: headed Option A, Plan 2
 *                and the like, or under a line that names them ("A vs B", a
 *                heading "Self hosted or managed"), sharing labelled fields
 *                that read as attributes of a choice (cost, risk, effort,
 *                setup). Review findings, install steps per platform, before
 *                and after, per PR status share fields too and are reports.
 *                A compare block.
 *
 * Everything else is null, and so is any text under 300 characters: a small
 * reply is never worth a card. Conservative on purpose: when unsure, null. A
 * nudge that fires on prose teaches the agent to ignore it.
 *
 * COST. This runs on the daemon's one thread after every reply, on text the
 * agent wrote, so no regex here may backtrack on a run of spaces (review of
 * PR #277: one line of "done" and 20,000 spaces cost about 6 seconds, 500
 * lines of "Subject" and 1,000 spaces 12, and 500 list items of "[" and 1,000
 * spaces did not finish).
 * Each line regex reads at most the first 160 characters of its line, a
 * labelled line (`To:`, `Cost:`) needs its colon in the first 60, and no two
 * adjacent quantifiers can both take the same spaces.
 */

export type ReplyCardShape = 'email_draft' | 'table' | 'status_list' | 'comparison'

/** The token a daemon declares when it can send a card it composes (lib/declared-capabilities.ts). */
export const UI_CARD = 'ui_card'

/** Shorter than this is never card shaped. */
export const MIN_CARD_SHAPED_CHARS = 300

/** At most one nudge per chat in this window. */
export const CARD_NUDGE_WINDOW_MS = 30 * 60_000

/** Every line regex reads at most this much of its line. */
const LINE_HEAD = 160
/** A labelled line has its colon this early, or it is not a label. */
const LABEL_COLON_WITHIN = 60

function headOf(line: string): string {
  return line.length > LINE_HEAD ? line.slice(0, LINE_HEAD) : line
}

function hasLabelColon(line: string): boolean {
  return line.slice(0, LABEL_COLON_WITHIN).includes(':')
}

/** A fence opening, and its tag (`ts`, `yaml`, empty). */
const FENCE = /^[ \t]*(```|~~~)[ \t]*([^\s`~]*)/

/** The text with every fenced code block blanked out, line for line. */
function outsideCode(lines: readonly string[]): string[] {
  const out: string[] = []
  let fence: string | null = null
  for (const line of lines) {
    const open = FENCE.exec(headOf(line))
    if (fence === null && open) {
      fence = open[1]
      out.push('')
    } else if (fence !== null) {
      if (line.trim().startsWith(fence)) fence = null
      out.push('')
    } else {
      out.push(line)
    }
  }
  return out
}

// ── email_draft ──────────────────────────────────────────────────────────────

/** Outside code: `To: x`, `**Cc:** x`, `- Subject: x`, `> To: x`, the header at the very start of its line. */
const EMAIL_HEADER = /^[ \t]*(?:>[ \t]*)?(?:[-*][ \t]+)?(?:\*\*|__)?(to|cc|bcc|subject)(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*\S/i

/** Inside a fence: the bare header of a pasted draft, unindented and capitalised as a mail client writes it. */
const FENCED_EMAIL_HEADER = /^(To|TO|Cc|CC|Bcc|BCC|Subject|SUBJECT):[ \t]*\S/

/** A fence tagged as prose may hold a draft; any other tag (ts, yaml, js) is code, which may SEND mail. */
const PROSE_FENCE_TAGS = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'email', 'eml', 'mail', 'markdown', 'md'])

/**
 * A header shaped line that is code: braces, a quote before the colon, or a
 * trailing comma or semicolon (`to: user.email,`, `to: string[];`). A
 * semicolon BETWEEN recipients is how Outlook writes them, so only a trailing
 * one counts.
 */
function readsAsCode(line: string): boolean {
  const head = headOf(line)
  if (head.includes('{') || head.includes('}')) return true
  if (/["'`]/.test(head.slice(0, head.indexOf(':')))) return true
  const end = line.trimEnd()
  return end.endsWith(',') || end.endsWith(';')
}

/** A Subject and a To or Cc within this many lines of each other. */
const EMAIL_HEADER_SPAN = 6

function isEmailDraft(lines: readonly string[]): boolean {
  let fence: string | null = null
  let proseFence = false
  // One ordered pass: each header is compared with the nearest header of the
  // other kind before it, not every Subject with every recipient.
  let lastSubject = -Infinity
  let lastRecipient = -Infinity
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (fence === null) {
      const open = FENCE.exec(headOf(line))
      if (open) {
        fence = open[1]
        proseFence = PROSE_FENCE_TAGS.has(open[2].toLowerCase())
        continue
      }
    } else if (line.trim().startsWith(fence)) {
      fence = null
      continue
    }
    if ((fence !== null && !proseFence) || !hasLabelColon(line)) continue
    // A prose `To: be fair` is a header only if a Subject sits right by it.
    const m = (fence === null ? EMAIL_HEADER : FENCED_EMAIL_HEADER).exec(headOf(line))
    if (!m || readsAsCode(line)) continue
    if (m[1].toLowerCase() === 'subject') {
      if (i - lastRecipient <= EMAIL_HEADER_SPAN) return true
      lastSubject = i
    } else {
      if (i - lastSubject <= EMAIL_HEADER_SPAN) return true
      lastRecipient = i
    }
  }
  return false
}

// ── table ────────────────────────────────────────────────────────────────────

/** `| --- | ---: |`, read with its spaces taken out, so no run of them can backtrack. */
const TABLE_SEPARATOR = /^\|?:?-+:?(?:\|:?-+:?)+\|?$/
const MIN_TABLE_ROWS = 3

function isTableSeparator(line: string): boolean {
  return line.includes('|') && line.includes('-') && TABLE_SEPARATOR.test(line.replace(/[ \t]+/g, ''))
}

function isTable(lines: readonly string[]): boolean {
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i - 1].includes('|') || !isTableSeparator(lines[i])) continue
    let rows = 0
    for (let j = i + 1; j < lines.length && lines[j].includes('|') && lines[j].trim() !== ''; j++) rows++
    if (rows >= MIN_TABLE_ROWS) return true
  }
  return false
}

// ── status_list ──────────────────────────────────────────────────────────────

const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+(.*)$/
const STATUS_EMOJI = /^(?:✅|☑️|✔️|✔|❌|✖️|✗|⚠️|⏳|⌛|🚧|⛔|🛑|🔴|🟠|🟡|🟢|🔵|⚪|⬜|🔄|⏸️|🆕)/u
const STATUS_WORD =
  /^(?:done|blocked|open|pending|failed|failing|passed|passing|complete|completed|in progress|wip|todo|to do|waiting|on hold|shipped|merged|fixed|ready|running|skipped|cancelled|canceled|closed|ok|not started)\b/i
/** After the word: a colon, a dash, a bracket or a pipe, so "Open the app" is a step, not a status. */
const STATUS_MARK = /^[ \t]*(?::|-\s|\||\]|\))/
/** `**Done**`, `**Done:**`, `[done]`, `` `open` ``: a word between marks, the closing mark found without backtracking. */
const MARKED_WORD = /^(?:\*\*|__|\[|`)([^*_\]`]{1,24})(?:\*\*|__|\]|`)/
const MIN_STATUS_ITEMS = 5
/** The status items must be most of the list, not a few among notes. */
const MIN_STATUS_SHARE = 0.75

function isStatusLed(item: string): boolean {
  // A `[ ]` or `[x]` task box is not here on purpose: the app draws a
  // checklist as task boxes, so it already reads well as it is.
  if (STATUS_EMOJI.test(item)) return true
  // A marked word is a status as it stands.
  const marked = MARKED_WORD.exec(item)
  if (marked) {
    const word = marked[1].trim().replace(/:$/, '').trim()
    if (STATUS_WORD.test(word) && word.replace(STATUS_WORD, '').trim() === '') return true
  }
  const word = STATUS_WORD.exec(item)
  return word !== null && STATUS_MARK.test(item.slice(word[0].length))
}

function isStatusList(lines: readonly string[]): boolean {
  let items = 0
  let led = 0
  for (const line of lines) {
    const m = LIST_ITEM.exec(headOf(line))
    if (!m) continue
    items++
    if (isStatusLed(m[1].trim())) led++
  }
  return led >= MIN_STATUS_ITEMS && led / items >= MIN_STATUS_SHARE
}

// ── comparison ───────────────────────────────────────────────────────────────

const HEADING = /^[ \t]*#{1,6}[ \t]+\S/
/** A line that is all bold, `**Option A: Bundle deal**` or `**Option B**:`. */
const BOLD_LINE = /^[ \t]*(?:[-*+][ \t]+)?(\*\*|__)[^*_]+\1[ \t]*(?::[ \t]*)?$/
/**
 * Option A, Plan 2, Choice B, Approach one: an option by its label. Case
 * sensitive on purpose: with an `i` flag the letter matched "Plan a visit"
 * and "Choice a".
 */
const OPTION_LABEL =
  /^[ \t]*(?:[-*+][ \t]+)?(?:#{1,6}[ \t]+)?(?:\*\*|__)?(?:[Oo]ption|OPTION|[Pp]lan|PLAN|[Cc]hoice|[Aa]pproach|[Aa]lternative)[ \t]+(?:[A-Z]|[1-9]|[Oo]ne|[Tt]wo|[Tt]hree|[Ff]our)\b/
/** "Postgres vs a managed database", "A versus B": a line that names the choice. */
const NAMES_A_VS_B = /\s(?:vs\.?|versus)\s/i
/** A heading or bold line naming two choices with "or": "Self hosted or managed?" */
const NAMES_A_OR_B = /\sor\s/i
/** Before and after is one thing at two times, not two choices (two tests, so nothing backtracks between the words). */
const BEFORE = /\bbefore\b/i
const AFTER = /\bafter\b/i
/** `- Price: x`, `Cost: x`, `**Risk:** x`: a short label, a colon and a value. */
const FIELD =
  /^[ \t]*(?:[-*+][ \t]+|\d{1,3}[.)][ \t]+)?(?:\*\*|__)?([A-Za-z][A-Za-z0-9/&'-]*(?: [A-Za-z0-9/&'-]+)*)(?:[ \t]*(?:\*\*|__))?[ \t]*:(?:\*\*|__)?[ \t]*\S/
const MAX_LABEL_CHARS = 30
/**
 * Label words that are attributes of a choice: what it costs, risks, takes and
 * gives. File, Scenario, Confidence, Status, CI, Install are a report's.
 */
const CHOICE_ATTRIBUTES = new Set([
  'price', 'pricing', 'cost', 'costs', 'budget', 'spend', 'fee', 'fees', 'margin', 'revenue', 'roi', 'payback',
  'savings', 'lift', 'impact', 'upside', 'downside', 'risk', 'risks', 'pro', 'pros', 'con', 'cons', 'benefit',
  'benefits', 'drawback', 'drawbacks', 'tradeoff', 'tradeoffs', 'trade-off', 'trade-offs', 'effort', 'complexity',
  'setup', 'maintenance', 'backup', 'backups', 'speed', 'performance', 'scale', 'scalability', 'reliability',
  'security', 'support', 'lock-in', 'timeline', 'timing', 'duration', 'reach', 'fit', 'best', 'verdict',
  'recommendation', 'ease', 'flexibility', 'value',
])
const MIN_SHARED_FIELDS = 2
/** Of the shared fields, at least this many must be attributes of a choice. */
const MIN_SHARED_ATTRIBUTES = 2
/** Of the larger option's fields, this share must be in the smaller one too. */
const MIN_FIELD_OVERLAP = 0.6
/**
 * Only the first options with fields are compared, pair by pair. A compare
 * block holds at most four, and without a cap a reply of thousands of headings
 * would cost a quadratic scan on the daemon's one thread.
 */
const MAX_OPTIONS_COMPARED = 16

interface Option {
  fields: Set<string>
  /** Headed by its label: Option A, Plan 2. */
  labelled: boolean
  /** Under a line that named the choice (A vs B, a heading with "or"). */
  named: boolean
}

function isChoiceAttribute(label: string): boolean {
  return label.split(/[ /&]+/).some((word) => CHOICE_ATTRIBUTES.has(word))
}

function namesAChoice(head: string, isHeader: boolean): boolean {
  if (!NAMES_A_VS_B.test(head) && !(isHeader && NAMES_A_OR_B.test(head))) return false
  return !(BEFORE.test(head) && AFTER.test(head))
}

function isComparison(lines: readonly string[]): boolean {
  const options: Option[] = []
  let current: Option | null = null
  let named = false
  for (const line of lines) {
    const head = headOf(line)
    const labelled = OPTION_LABEL.test(head)
    const isHeader = labelled || HEADING.test(head) || BOLD_LINE.test(head)
    if (isHeader) {
      current = { fields: new Set(), labelled, named }
      options.push(current)
    }
    // A naming line counts for the options AFTER it, not for itself.
    if (!named && namesAChoice(head, isHeader)) named = true
    if (isHeader || !current || !hasLabelColon(line)) continue
    const field = FIELD.exec(head)
    if (field && field[1].length <= MAX_LABEL_CHARS) current.fields.add(field[1].toLowerCase())
  }
  const fielded = options.filter((o) => o.fields.size >= MIN_SHARED_FIELDS).slice(0, MAX_OPTIONS_COMPARED)
  for (let a = 0; a < fielded.length; a++) {
    for (let b = a + 1; b < fielded.length; b++) {
      const x = fielded[a]
      const y = fielded[b]
      if (!((x.labelled && y.labelled) || (x.named && y.named))) continue
      const shared = [...x.fields].filter((label) => y.fields.has(label))
      const larger = Math.max(x.fields.size, y.fields.size)
      if (shared.length < MIN_SHARED_FIELDS || shared.length / larger < MIN_FIELD_OVERLAP) continue
      if (shared.filter(isChoiceAttribute).length >= MIN_SHARED_ATTRIBUTES) return true
    }
  }
  return false
}

/**
 * The card shape of a reply, or null. Pure, and never throws: anything that is
 * not a string is null.
 */
export function classify(text: string): ReplyCardShape | null {
  if (typeof text !== 'string' || text.trim().length < MIN_CARD_SHAPED_CHARS) return null
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  // An email draft counts in a code block too: that is how Mark sent his.
  if (isEmailDraft(lines)) return 'email_draft'
  const prose = outsideCode(lines)
  if (isTable(prose)) return 'table'
  if (isStatusList(prose)) return 'status_list'
  if (isComparison(prose)) return 'comparison'
  return null
}

/** How the card would be built, named in the line. */
const SHAPE_HINTS: Record<ReplyCardShape, string> = {
  email_draft: 'an email draft: a keyvalue block for To, Cc and Subject, then the body',
  table: 'a table: a table block with the same columns and rows',
  status_list: 'a status list: a list block, one item per line with its status as the meta',
  comparison: 'a comparison: a compare block, one column per option with its fields as facts',
}

/** The ONE line appended to the reply tool's result. */
export function cardNudgeLine(shape: ReplyCardShape): string {
  return (
    `This reply would read better as a card (${SHAPE_HINTS[shape]}). ` +
    'Next time call show_component with kind ui_card (see Cards you compose in bgos_capabilities).'
  )
}

/**
 * The per chat memory: at most one nudge per chat per window, kept in memory
 * only (a restart forgets it, which costs at most one extra line). Bounded, so
 * a daemon that talks in many chats cannot grow it without end.
 */
export class ReplyCardNudges {
  private readonly lastNudgeAt = new Map<string, number>()
  private readonly now: () => number
  private readonly windowMs: number
  private readonly maxChats: number

  constructor(opts: { now?: () => number; windowMs?: number; maxChats?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.windowMs = opts.windowMs ?? CARD_NUDGE_WINDOW_MS
    this.maxChats = opts.maxChats ?? 256
  }

  get size(): number {
    return this.lastNudgeAt.size
  }

  /**
   * The line to append to a SENT reply's tool result, or null. `declared` is
   * asked only for a card shaped reply, and the window is spent only when the
   * line is given. Never throws: any error is logged and reads as null.
   */
  forReply(input: { chatId: string; text: string; declared: () => boolean; log: (line: string) => void }): string | null {
    try {
      const shape = classify(input.text)
      if (shape === null) return null
      const at = this.now()
      const last = this.lastNudgeAt.get(input.chatId)
      if (last !== undefined && at - last < this.windowMs) return null
      if (!input.declared()) return null
      this.remember(input.chatId, at)
      return cardNudgeLine(shape)
    } catch (err) {
      input.log(`reply card nudge skipped: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  private remember(chatId: string, at: number): void {
    this.lastNudgeAt.delete(chatId)
    this.lastNudgeAt.set(chatId, at)
    if (this.lastNudgeAt.size <= this.maxChats) return
    for (const [id, when] of this.lastNudgeAt) {
      if (at - when >= this.windowMs) this.lastNudgeAt.delete(id)
    }
    // Still full: drop the oldest (a Map keeps insertion order).
    for (const id of this.lastNudgeAt.keys()) {
      if (this.lastNudgeAt.size <= this.maxChats) break
      this.lastNudgeAt.delete(id)
    }
  }
}
