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
 *                Cc within a few lines of each other, in or out of a code
 *                block (Mark's draft was in one). A keyvalue block.
 *   table        a markdown table, outside code, of 3 or more body rows. A
 *                table block.
 *   status_list  5 or more list items each LED by a status word or emoji
 *                (done, blocked, open, pending, failed, a check box, a tick),
 *                and most of the list. A word counts only with a mark after
 *                it (a colon, a dash, a bracket, bold), so a step list that
 *                says "Open the app" stays prose. A list block, the status as
 *                each item's meta.
 *   comparison   2 or more options (a heading, a line in bold, or Option A,
 *                Plan B) carrying mostly the same labelled fields. A compare
 *                block.
 *
 * Everything else is null, and so is any text under 300 characters: a small
 * reply is never worth a card. Conservative on purpose: when unsure, null. A
 * nudge that fires on prose teaches the agent to ignore it.
 */

export type ReplyCardShape = 'email_draft' | 'table' | 'status_list' | 'comparison'

/** The token a daemon declares when it can send a card it composes (lib/declared-capabilities.ts). */
export const UI_CARD = 'ui_card'

/** Shorter than this is never card shaped. */
export const MIN_CARD_SHAPED_CHARS = 300

/** At most one nudge per chat in this window. */
export const CARD_NUDGE_WINDOW_MS = 30 * 60_000

const FENCE = /^\s*(```|~~~)/

/** The text with every fenced code block blanked out, line for line. */
function outsideCode(lines: readonly string[]): string[] {
  const out: string[] = []
  let fence: string | null = null
  for (const line of lines) {
    const open = FENCE.exec(line)
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

/** `To: x`, `**Cc:** x`, `- Subject: x`, `> To: x`: the header at the very start of its line. */
const EMAIL_HEADER = /^\s*(?:>\s*)?(?:[-*]\s+)?(?:\*\*|__)?(to|cc|bcc|subject)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*\S/i

/** A Subject and a To or Cc within this many lines of each other. */
const EMAIL_HEADER_SPAN = 6

function isEmailDraft(lines: readonly string[]): boolean {
  const subjects: number[] = []
  const recipients: number[] = []
  lines.forEach((line, i) => {
    const m = EMAIL_HEADER.exec(line)
    if (!m) return
    // A prose `To: be fair` is a header only if a Subject sits right by it.
    if (m[1].toLowerCase() === 'subject') subjects.push(i)
    else recipients.push(i)
  })
  return subjects.some((s) => recipients.some((r) => Math.abs(s - r) <= EMAIL_HEADER_SPAN))
}

// ── table ────────────────────────────────────────────────────────────────────

const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/
const MIN_TABLE_ROWS = 3

function isTable(lines: readonly string[]): boolean {
  for (let i = 1; i < lines.length; i++) {
    if (!TABLE_SEPARATOR.test(lines[i]) || !lines[i - 1].includes('|')) continue
    let rows = 0
    for (let j = i + 1; j < lines.length && lines[j].includes('|') && lines[j].trim() !== ''; j++) rows++
    if (rows >= MIN_TABLE_ROWS) return true
  }
  return false
}

// ── status_list ──────────────────────────────────────────────────────────────

const LIST_ITEM = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(.*)$/
const STATUS_EMOJI = /^(?:✅|☑️|✔️|✔|❌|✖️|✗|⚠️|⏳|⌛|🚧|⛔|🛑|🔴|🟠|🟡|🟢|🔵|⚪|⬜|🔄|⏸️|🆕)/u
const STATUS_WORD =
  /^(?:done|blocked|open|pending|failed|failing|passed|passing|complete|completed|in progress|wip|todo|to do|waiting|on hold|shipped|merged|fixed|ready|running|skipped|cancelled|canceled|closed|ok|not started)\b/i
/** After the word: a colon, a dash, a bracket or a pipe, so "Open the app" is a step, not a status. */
const STATUS_MARK = /^\s*(?::|-\s|\||\]|\))/
const MIN_STATUS_ITEMS = 5
/** The status items must be most of the list, not a few among notes. */
const MIN_STATUS_SHARE = 0.75

function isStatusLed(item: string): boolean {
  if (/^\[[ xX]\]\s/.test(item)) return true
  if (STATUS_EMOJI.test(item)) return true
  // `**Done**: x`, `**Done:** x`, `[done] x`, `` `open` x ``: a marked word is a status as it stands.
  const marked = /^(\*\*|__|\[|`)\s*([^*_\]`]{1,20}?)\s*:?\s*(\*\*|__|\]|`)/.exec(item)
  if (marked && STATUS_WORD.test(marked[2]) && marked[2].replace(STATUS_WORD, '').replace(/:$/, '').trim() === '') {
    return true
  }
  const word = STATUS_WORD.exec(item)
  return word !== null && STATUS_MARK.test(item.slice(word[0].length))
}

function isStatusList(lines: readonly string[]): boolean {
  let items = 0
  let led = 0
  for (const line of lines) {
    const m = LIST_ITEM.exec(line)
    if (!m) continue
    items++
    if (isStatusLed(m[1].trim())) led++
  }
  return led >= MIN_STATUS_ITEMS && led / items >= MIN_STATUS_SHARE
}

// ── comparison ───────────────────────────────────────────────────────────────

const HEADING = /^\s*#{1,6}\s+\S/
/** A line that is all bold, `**Option A: Bundle deal**` or `**Option B**:`. */
const BOLD_LINE = /^\s*(?:[-*+]\s+)?(\*\*|__)[^*_]+\1\s*:?\s*$/
const OPTION_LINE = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?(?:option|plan|choice|approach|alternative)\s+(?:[A-Z0-9]\b|\d+\b|one\b|two\b|three\b)/i
/** `- Price: x`, `Cost: x`, `**Risk:** x`: a short label, a colon and a value. */
const FIELD = /^\s*(?:[-*+]\s+|\d{1,3}[.)]\s+)?(?:\*\*|__)?([A-Za-z][A-Za-z0-9 /&'-]{0,29}?)\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*\S/
const MIN_SHARED_FIELDS = 2
/** Of the larger option's fields, this share must be in the smaller one too. */
const MIN_FIELD_OVERLAP = 0.6
/**
 * Only the first options with fields are compared, pair by pair. A compare
 * block holds at most four, and without a cap a reply of thousands of headings
 * would cost a quadratic scan on the daemon's one thread.
 */
const MAX_OPTIONS_COMPARED = 16

function isOptionHeader(line: string): boolean {
  return HEADING.test(line) || BOLD_LINE.test(line) || OPTION_LINE.test(line)
}

function isComparison(lines: readonly string[]): boolean {
  const options: Array<Set<string>> = []
  let current: Set<string> | null = null
  for (const line of lines) {
    if (isOptionHeader(line)) {
      current = new Set()
      options.push(current)
      continue
    }
    const field = FIELD.exec(line)
    if (current && field) current.add(field[1].trim().toLowerCase())
  }
  const fielded = options.filter((o) => o.size >= MIN_SHARED_FIELDS).slice(0, MAX_OPTIONS_COMPARED)
  for (let a = 0; a < fielded.length; a++) {
    for (let b = a + 1; b < fielded.length; b++) {
      const shared = [...fielded[a]].filter((label) => fielded[b].has(label)).length
      const larger = Math.max(fielded[a].size, fielded[b].size)
      if (shared >= MIN_SHARED_FIELDS && shared / larger >= MIN_FIELD_OVERLAP) return true
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
