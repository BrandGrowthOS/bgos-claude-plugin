// ── Agent email files, outbound: the content stage of rule 4 ──
//
// HOAI row 5b141728, step 2 (DESIGN-OUT.md D7, rule 4), review round 7. What lib/email-outbound-files.ts reads of a
// text, Word or Excel file's words, moved here whole so it runs in a worker thread
// (lib/email-outbound-content-worker.ts) that the daemon's main thread ends at a hard deadline: a text file's header
// (a password column), a Word or Excel file's rows and words (officeWords), and on the decoded text a private key, a
// cookie file's header, this daemon's own credential, a recovery key, a wallet recovery phrase, the shared secret
// scanner (lib/secret-scan.ts) and a password written out. No file system call and no clock other than the Worker's
// own: the bytes come in, a verdict goes out (ContentVerdict), and email-outbound-files.ts says the sentence.
//
// The vocabulary of password words is here too, because the name rules of email-outbound-files.ts read it as well.
//
// No em or en dashes in this file.

import { createInflateRaw } from 'node:zlib'

import { BIP39_ENGLISH_WORDS } from './bip39-english.ts'
import { scanText } from './secret-scan.ts'

const MB = 1024 * 1024

/**
 * Round 9: the content stage's own budget, on the Worker's own clock (Date.now). Every check reads it between its
 * steps (the walks every STEPS_PER_CHECK steps, the scanner between its pieces, the readers of a Word or Excel file at
 * every element), and a file over it is refused by the Worker itself ('unsafe', "could not be read safely"), which then
 * takes the next file. The main thread's hard deadline (email-outbound-files.ts outboundContentHardDeadlineMs) ends
 * after it, so the Worker is replaced only when something no check reads runs long. Round 11: under bun a replaced
 * Worker is not stopped while its code runs (terminate lands at its next turn of the event loop) and keeps what it has
 * built, so every loop of the stage reads the budget (or is bounded by a cap it charges), and the Worker answers
 * every file itself.
 */
export interface StageClock {
  deadline: number
}
/** Round 9: no budget (a walk called on its own, by a test). */
const NO_CLOCK: StageClock = Object.freeze({ deadline: Number.POSITIVE_INFINITY })
/** Round 9: the stage is over its budget. */
class OverBudget extends Error {}
/** Round 9: how many steps a walk takes between two reads of the clock. */
const STEPS_PER_CHECK = 1024

function checkBudget(clock: StageClock): void {
  if (Date.now() > clock.deadline) throw new OverBudget()
}

/**
 * Round 9: one file's budget. By default it starts as officeReadBudgetMs of the file's size and grows, once a Word or
 * Excel file's parts are inflated and its words taken, to that of the larger of its size and its words (at most
 * OFFICE_TEXT_MAX, the cap on words): a 24 KB Word file of 24 MB of words is read as 24 MB. A budget a test passes is
 * fixed.
 */
interface StageBudget extends StageClock {
  start: number
  grows: boolean
}

function grow(budget: StageBudget, size: number): void {
  if (!budget.grows) return
  budget.deadline = Math.max(budget.deadline, budget.start + officeReadBudgetMs(Math.min(size, OFFICE_TEXT_MAX)))
}

/**
 * Round 4: ONE vocabulary of password words, read by the name rules below, PASSWORD_COLUMN and the written password
 * rule. The word password in German, French, Spanish, Portuguese and Dutch, with their plurals.
 */
export const FOREIGN_PASSWORD_WORDS = String.raw`passw[oö]rt(?:er)?|mots?[ _-]de[ _-]passe|contrase[ñn]as?|senhas?|wachtwoord(?:en)?`
/** Short and other words for a password or a PIN: pw, pws, passcode(s), passkey(s); pass(es) and pin(s) beside them. */
export const SHORT_PASSWORD_WORDS = String.raw`pws?|passcodes?|passkeys?`
/**
 * A pass or a pin that is not a password: a boarding, day or season pass, a first or final pass over a draft, a map
 * or safety pin. Each must start a word (bypass is not a pass, as bitlocker is not a locker).
 */
export const PASS_NOT_A_PASSWORD = String.raw`boarding|day|bus|season|ski|train|rail|transit|travel|parking|park|press|guest|visitor|hall|festival|event|museum|backstage|gym|mountain|first|second|third|final|map|safety|hair|lapel|bowling|drawing|push|location`
/** pass, passes, pin or pins, not after one of those words. */
export const PASS_OR_PIN = String.raw`(?<![a-z0-9])(?<!(?<![a-z0-9])(?:${PASS_NOT_A_PASSWORD})[ _-])(?:pass(?:es)?|pins?)`

/**
 * A column named password, passwd or login_password: every browser and password manager export has one. Round 3:
 * passcode, and the word in German, French, Spanish, Portuguese and Dutch. Round 4: passkey, and the one vocabulary.
 */
const PASSWORD_COLUMN = new RegExp(String.raw`^(?:.*[ _-])?(?:pass(?:word|wd)s?|passcodes?|passkeys?|${FOREIGN_PASSWORD_WORDS})$`)
/**
 * A short or loose name for one (pass, pw, pwd, pin, pin code, secret): a password column only beside an account column.
 * Round 6: not pins, the plural (`Item | Pins | Site` is a stock list).
 */
const LOOSE_PASSWORD_COLUMN = /^(?:.*[ _-])?(?:pass|pws?|pwds?|pin|pin[ _-]?codes?|secret)$/
/** A user, login, email or site column: what a home made password table puts beside the password. */
const ACCOUNT_WORDS = String.raw`user(?: ?name)?|userid|login(?: ?name)?|e-?mail(?: address)?|account|(?:web ?)?site|sitio|url|uri|benutzername|identifiant|usuario|utilisateur`
const ACCOUNT_COLUMN = new RegExp(String.raw`^(?:.*[ _-])?(?:${ACCOUNT_WORDS})$`)
/** Round 13: an account word as a cell on its own (Site, Email, User name), with nothing before it. */
const ACCOUNT_CELL = new RegExp(String.raw`^(?:${ACCOUNT_WORDS})$`)

/**
 * Round 11: the longest cell whose name is read whole. A longer cell is no header: its name is read from its last
 * HEADER_CELL_MAX characters (past any trailing whitespace; round 12: nor is what round 10 took off its ends
 * counted), cut after the first separator in them, so the same anchored rules see how it ends and never a word cut in
 * two. The work on one cell is bounded whatever its length (a sheet's cells may each point at one shared string of
 * 25 MB: the reviewer's amp shape).
 */
const HEADER_CELL_MAX = 256
/**
 * Round 11: the marks a table cell's name may end with (Password:, Password.), taken off a cell of a sheet or Word
 * table only: on a text file's line or a Word paragraph, "Password:" is a label the written password rules read, and
 * "Reset your password." is prose. A parenthesised note (Password (current)) is taken off both. Round 12: '?' is not
 * one of them (a question, "Forgot your password?", is not a header), and they are taken off by a walk back from the
 * end over their codes and whitespace (trimMarks): round 11's regex, /[\s.,;:!?]+$/, backtracked from every mark of a
 * run that does not end the cell, quadratic (110 us for 255 dots then a letter, under bun).
 */
const HEADER_MARK_CODES: ReadonlySet<number> = new Set([...'.,;:!'].map((mark) => mark.charCodeAt(0)))
const HEADER_NOTE = /\s*\([^()]*\)$/

/** Round 11: at most this many words make a header whose note (and, see HEADER_MARKED_WORDS_MAX, marks) is taken off. */
const HEADER_WORDS_MAX = 4
/**
 * Round 12: at most this many words, once its note and marks are off, make a sheet or Word table cell whose trailing
 * marks are taken off ("Your password." is a header, "Remember your password." is not). Round 11 took them off a cell
 * of up to 4 words.
 */
const HEADER_MARKED_WORDS_MAX = 2
/**
 * Round 13: at most this many words, once its note and marks are off, make a sheet or Word table cell that ends with a
 * colon lose its marks: a colon ends a label ("Email account password:" beside "Account"), where a full stop or '!'
 * ends prose ("Remember your password."), which keeps HEADER_MARKED_WORDS_MAX.
 */
const HEADER_LABEL_WORDS_MAX = 3

/** Round 13: whether a name's last character that is not whitespace is a colon. */
function endsWithColon(name: string): boolean {
  let end = name.length
  while (end > 0 && isWhite(name.charCodeAt(end - 1))) end--
  return end > 0 && name.charCodeAt(end - 1) === 58
}

/** Round 12: a name with its trailing marks (HEADER_MARK_CODES) and whitespace taken off, by a walk back from its end. */
function trimMarks(name: string): string {
  let end = name.length
  while (end > 0) {
    const code = name.charCodeAt(end - 1)
    if (!HEADER_MARK_CODES.has(code) && !isWhite(code)) break
    end--
  }
  return name.slice(0, end)
}

/** Round 11: the words of a name whose whitespace is collapsed (one space between two words). */
function wordsIn(name: string): number {
  let words = name === '' ? 0 : 1
  for (let at = name.indexOf(' '); at >= 0; at = name.indexOf(' ', at + 1)) words++
  return words
}

/** Round 11: whitespace as \s reads it (the characters trim takes off), by character code. */
function isWhite(code: number): boolean {
  return (
    (code >= 9 && code <= 13) || code === 32 || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff
  )
}

/**
 * A cell's name as the table check reads it: trimmed, its quotes taken off, in lower case. Round 11: its whitespace and
 * line breaks collapsed to one space (Login\nPassword is login password), and a parenthesised note (Password (current))
 * and, for a cell of a sheet or Word table (`tableCell`), its trailing marks (Password:) taken off, before the anchored
 * rules read it; a cell longer than HEADER_CELL_MAX is read on its end only (see there).
 */
function headerName(cell: string, tableCell = true): string {
  let text = cell
  let cut = false
  if (text.length > HEADER_CELL_MAX) {
    // Round 12: what round 10 took off a cell is not counted: the whitespace at both ends, then a quote at each end,
    // then the whitespace again (round 11 counted all but the trailing whitespace, so "Password" in quotes after 300
    // spaces, or Password, 300 spaces and a quote, was cut, and named nothing; round 10 read each whole and refused it).
    let end = text.length
    let start = 0
    const skipWhite = () => {
      while (end > start && isWhite(text.charCodeAt(end - 1))) end--
      while (start < end && isWhite(text.charCodeAt(start))) start++
    }
    skipWhite()
    if (start < end && text.charCodeAt(start) === 0x22) start++
    if (end > start && text.charCodeAt(end - 1) === 0x22) end--
    skipWhite()
    cut = end - start > HEADER_CELL_MAX
    text = text.slice(cut ? end - HEADER_CELL_MAX : start, end)
  }
  let name = text.replace(/\s+/g, ' ').toLowerCase()
  if (cut) {
    // The window may start inside a word: only what follows its first separator is read, the separator kept, so the
    // rules' (?:.*[ _-])? reads a word that follows one, as on the whole cell.
    name = name.trimEnd().replace(/"$/, '')
    const separator = name.search(/[ _-]/)
    name = separator < 0 ? '' : name.slice(separator)
  } else {
    name = name.trim().replace(/^"|"$/g, '').trim()
  }
  // Only a header's few words lose their marks and note: a line of prose that ends "your password." is not a header.
  if (wordsIn(name.trimStart()) <= HEADER_WORDS_MAX) {
    const noteOff = (text: string) => text.replace(HEADER_NOTE, '')
    // Round 12: the marks only when what is left is at most HEADER_MARKED_WORDS_MAX words (round 13: a label that ends
    // with a colon, HEADER_LABEL_WORDS_MAX).
    const bare = tableCell ? trimMarks(noteOff(trimMarks(name))) : null
    const most = endsWithColon(name) ? HEADER_LABEL_WORDS_MAX : HEADER_MARKED_WORDS_MAX
    name = bare !== null && wordsIn(bare.trimStart()) <= most ? bare : noteOff(name)
    name = name.replace(/"$/, '').trimEnd()
  }
  return name
}

/**
 * Round 12: what may follow a strict password word in a cell of at most HEADER_MARKED_WORDS_MAX words: a required
 * field's star or two (Password*), a hash, or a number of up to 3 digits (Password 1, Password #2, Passwort2). Eight
 * stars are a placeholder (Password ********), and four digits a written passcode, which are not read here.
 */
const STRICT_SUFFIX = /[ _]?(?:\*{1,2}|#\d{0,3}|\d{1,3})$/

/** Round 12: a name of at most HEADER_MARKED_WORDS_MAX words with a STRICT_SUFFIX taken off, or null. */
function withoutSuffix(name: string): string | null {
  if (wordsIn(name.trimStart()) > HEADER_MARKED_WORDS_MAX) return null
  const suffix = STRICT_SUFFIX.exec(name)
  return suffix === null ? null : name.slice(0, suffix.index)
}

/** Round 12: a header name that is a strict password column, as is or once a STRICT_SUFFIX is taken off. */
function namesStrict(name: string, rule: RegExp = PASSWORD_COLUMN): boolean {
  if (rule.test(name)) return true
  const bare = withoutSuffix(name)
  return bare !== null && rule.test(bare)
}

/**
 * Round 10: one row of cells (a text header line, a Word table row, an Excel sheet row: round 5), read a cell at a
 * time, so a first column of a million rows is judged without holding its cells. It names a password column when a
 * cell names one, or when a loose cell (pass, pw, pin, secret) and an account cell (user, login, email, site) are both
 * in it. Round 10: no gradebook exemption (rounds 8 and 9 let a pass column beside a grade go; each narrowing was
 * fooled by where the cells sat), so Student, Email, Grade, Pass is refused, as it was before round 8.
 */
class PasswordRow {
  cells = 0
  private strict = false
  private loose = false
  private account = false

  /**
   * Round 11: the stage's budget, read every ROW_CELLS_PER_CHECK cells (a row of a sheet may hold 50000 cells), and
   * whether the cells are a sheet's or Word table's (headerName's `tableCell`), not a text line's.
   */
  constructor(private readonly clock: StageClock = NO_CLOCK, private readonly tableCells = true) {}

  add(cell: string): void {
    if (this.cells++ % ROW_CELLS_PER_CHECK === 0) checkBudget(this.clock)
    if (this.strict) return
    const name = headerName(cell, this.tableCells)
    if (namesStrict(name)) this.strict = true
    if (LOOSE_PASSWORD_COLUMN.test(name)) this.loose = true
    if (ACCOUNT_COLUMN.test(name)) this.account = true
  }

  get names(): boolean {
    return this.strict || (this.loose && this.account)
  }
}

/** Round 11: how many cells a row adds between two reads of the budget. */
const ROW_CELLS_PER_CHECK = 64

/** Cells of one row that name a password column (PasswordRow). */
function looksLikePasswordTable(cells: Iterable<string>, clock: StageClock = NO_CLOCK, tableCells = true): boolean {
  const row = new PasswordRow(clock, tableCells)
  for (const cell of cells) row.add(cell)
  return row.names
}

/** Round 11: what a text header line is split on into cells: a comma, a semicolon, a tab or a bar. */
const HEADER_SEPARATORS = /[,;\t|]/
const HEADER_SEPARATORS_ALL = /[,;\t|]/g

/**
 * Round 12: what a Word paragraph is split on: a text line's separators, and a spaced dash or slash
 * (Site - Username - Password, Website / Username / Password), read only when a paragraph holds two of them
 * (twoFinds), so a title such as "Passwords - Overview" or "Password / PIN policy" is one cell. Round 13: a spaced
 * en dash (U+2013, what Word's AutoFormat makes of ' - ' between words) or em dash (U+2014) is a spaced dash too; and
 * a run of two or more spaces (a header lined up with the space bar: Site, eight spaces, Username, eight spaces,
 * Password) is a separator when a paragraph holds two such runs, so one stray double space ("Reset your  password")
 * splits nothing. Each is read under the same header length rule.
 */
const SPACED_SEPARATORS_ALL = / [-/\u2013\u2014] /g
const SPACE_RUNS_ALL = / {2,}/g
const WORD_SEPARATORS_DASHES = /[,;\t|]| [-/\u2013\u2014] /g
const WORD_SEPARATORS_SPACES = /[,;\t|]| {2,}/g
const WORD_SEPARATORS_BOTH = /[,;\t|]| [-/\u2013\u2014] | {2,}/g

/** Round 12: whether a paragraph holds two finds of `separators` (two calls of exec, no backtracking). */
function twoFinds(line: string, separators: RegExp): boolean {
  separators.lastIndex = 0
  const first = separators.exec(line)
  if (first === null) return false
  separators.lastIndex = first.index + first[0].length
  return separators.exec(line) !== null
}

/** Round 13: what a Word paragraph's line is split on, by whether it holds two spaced dashes and two runs of spaces. */
function wordSeparators(dashes: boolean, spaces: boolean): RegExp {
  if (dashes) return spaces ? WORD_SEPARATORS_BOTH : WORD_SEPARATORS_DASHES
  return spaces ? WORD_SEPARATORS_SPACES : HEADER_SEPARATORS_ALL
}

/**
 * Round 11: a line's cells (split on HEADER_SEPARATORS) one at a time, so a long line is never split all at once.
 * Round 12: or on `separators` (WORD_SEPARATORS_ALL, a Word paragraph's), each match one separator.
 */
function* lineCells(line: string, separators: RegExp = HEADER_SEPARATORS_ALL): Generator<string> {
  let at = 0
  for (;;) {
    separators.lastIndex = at
    const separator = separators.exec(line)
    if (separator === null) {
      yield line.slice(at)
      return
    }
    yield line.slice(at, separator.index)
    at = separator.index + separator[0].length
  }
}

/** Round 12: at most this many words make a Word paragraph's cell header length (Site, User name, Password). */
const WORD_HEADER_WORDS_MAX = 3

/**
 * Round 12: whether a cell of a Word paragraph is header length: at most HEADER_CELL_MAX characters and
 * WORD_HEADER_WORDS_MAX words (its runs of whitespace read as one), counted up to the first word past the limit.
 */
function isHeaderLength(cell: string): boolean {
  if (cell.length > HEADER_CELL_MAX) return false
  let words = 0
  let inWord = false
  for (let at = 0; at < cell.length; at++) {
    const white = isWhite(cell.charCodeAt(at))
    if (!white && !inWord && ++words > WORD_HEADER_WORDS_MAX) return false
    inWord = !white
  }
  return true
}

/** Round 11: a strict password word as a cell on its own (Password, Passwords, Passwort): a header, not prose. */
const STRICT_PASSWORD_CELL = new RegExp(String.raw`^(?:pass(?:word|wd)s?|passcodes?|passkeys?|${FOREIGN_PASSWORD_WORDS})$`)

/**
 * Round 11: one Word paragraph read as a text file's header line. Round 12: only a paragraph that is split by a
 * separator (a comma, semicolon, tab or bar, or two spaced dashes or slashes) into cells that are all header length
 * (isHeaderLength: 3 words or fewer) is read at all, so a title ("How to reset your password"), a heading
 * ("2. Passwords") and a sentence ("To sign in, enter your username and password, then click OK.") are not headers.
 * Such a paragraph among the first HEADER_LINES non empty ones is judged by the table check (as a text file's first
 * lines are); below them, only when one of its cells is a strict password word on its own (or with a STRICT_SUFFIX)
 * and at least two other cells are not blank (Site<tab>Username<tab>Password).
 *
 * Round 13: a paragraph is split at its line breaks (<w:br/>, Shift+Enter) first, and each line is judged as a
 * paragraph of its own and counts toward HEADER_LINES, so a list typed in one paragraph is read line by line. Below
 * the first lines, a line split by tabs or bars only (no comma or semicolon) needs one other cell that holds a letter
 * beside the strict one (Account<tab>Password, Site | Password); a line with a comma, a semicolon, spaced dashes or
 * runs of spaces still needs two other cells, or one that is an account word on its own (ACCOUNT_CELL:
 * "Site, Password"), so "Fields: Email, Password" and "Passwords, PINs" are not headers. The cell beside must hold a
 * letter, so a number ("2.<tab>Passwords") or a blank to fill in ("Password<tab>________") is not one.
 */
class WordHeader {
  private lines = 0

  constructor(private readonly clock: StageClock) {}

  /** Whether this paragraph names a password column: round 13, any of its lines. */
  names(paragraph: string): boolean {
    let at = 0
    for (let steps = 0; ; steps++) {
      if (steps % ROW_CELLS_PER_CHECK === 0) checkBudget(this.clock)
      const newline = paragraph.indexOf('\n', at)
      // An empty line is blank: it counts toward nothing and names nothing (no string is made for it).
      if (newline !== at && this.lineNames(newline < 0 ? (at === 0 ? paragraph : paragraph.slice(at)) : paragraph.slice(at, newline))) return true
      if (newline < 0) return false
      at = newline + 1
    }
  }

  /** Whether one line of a paragraph names a password column. */
  private lineNames(line: string): boolean {
    const top = this.lines < HEADER_LINES
    if (top) {
      if (isBlank(line)) return false
      this.lines++
    }
    const dashes = twoFinds(line, SPACED_SEPARATORS_ALL)
    const spaces = twoFinds(line, SPACE_RUNS_ALL)
    if (!dashes && !spaces && !HEADER_SEPARATORS.test(line)) return false
    const row = top ? new PasswordRow(this.clock, false) : null
    let strict = false
    let others = 0
    let lettered = false
    let account = false
    let steps = 0
    for (const cell of lineCells(line, wordSeparators(dashes, spaces))) {
      if (steps++ % ROW_CELLS_PER_CHECK === 0) checkBudget(this.clock)
      if (!isHeaderLength(cell)) return false
      if (row !== null) {
        row.add(cell)
        continue
      }
      if (isBlank(cell)) continue
      const name = headerName(cell, false)
      if (!strict && namesStrict(name, STRICT_PASSWORD_CELL)) {
        strict = true
        continue
      }
      others++
      if (HAS_LETTER.test(cell)) lettered = true
      if (ACCOUNT_CELL.test(name)) account = true
    }
    if (row !== null) return row.names
    if (!strict || others === 0) return false
    if (others >= 2) return true
    // Round 13: one other cell. Read only now, once every cell was header length.
    const tabsOrBars = !dashes && !spaces && !WORD_COMMA_OR_SEMICOLON.test(line)
    return tabsOrBars ? lettered : account
  }
}

/** Round 13: a comma or a semicolon (a line split only by tabs or bars has neither). */
const WORD_COMMA_OR_SEMICOLON = /[,;]/

/** Round 11: a text of whitespace only (as trim() === ''), read up to its first other character. */
function isBlank(text: string): boolean {
  for (let at = 0; at < text.length; at++) if (!isWhite(text.charCodeAt(at))) return false
  return true
}

/** How many non empty lines at the top may hold the header: Excel's sep= line and a title line can come first. */
const HEADER_LINES = 5

/** A text file whose header, in its first few lines, has a password column: a renamed password export. */
function hasPasswordColumn(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 4096))
  const lines = head.split('\n').filter((line) => line.trim() !== '').slice(0, HEADER_LINES)
  return lines.some((line) => looksLikePasswordTable(lineCells(line), NO_CLOCK, false))
}

/**
 * The words a password is written out after (round 4: the one vocabulary): password, passwd, pwd, pw, passcode,
 * passkey, the foreign words, an api key and a token. Round 5: an api key or a token is captured (group 1), because
 * its value must hold a letter: `Input tokens: 1,234,567` is a count.
 */
const WRITTEN_WORDS = String.raw`(?:password|passwd|pwd|pw|passcode|passkey|${FOREIGN_PASSWORD_WORDS}|(api[ _-]?key|token))s?`
/**
 * Between the word and the value: ':', '=' or a full width colon (round 4), or ' - ' or ' is ' (round 4), which prose
 * uses too, so after those two the value must hold something other than letters.
 */
const WRITTEN_SEPARATOR = String.raw`[ \t]*(?:([:=\uFF1A])|[ \t](?:-|is)(?=[ \t]))[ \t]*`
/**
 * A password, passcode, api key or token written out: the word, a separator, then a value of six or more characters.
 * Groups: 1 an api key or token word, 2 a strict separator, 3 the value.
 */
const WRITTEN_PASSWORD = new RegExp(String.raw`(?<![a-z0-9])${WRITTEN_WORDS}${WRITTEN_SEPARATOR}["']?([^\s"']{6,})`, 'gi')
/** Round 4: a pass written out (wifi pass = ...), not a boarding or day pass: its value must hold something other than letters. */
const WRITTEN_PASS = new RegExp(String.raw`(?<![a-z0-9])(?<!(?<![a-z0-9])(?:${PASS_NOT_A_PASSWORD})[ _-])pass(?:es)?${WRITTEN_SEPARATOR}["']?([^\s"']{6,})`, 'gi')
/**
 * Round 4: a PIN, PIN code or passcode written out as four or more digits (a phone's passcode is often 4 to 6). Round 5:
 * not pins, the plural (`Pins: 1500` is a stock count).
 */
const WRITTEN_PIN = new RegExp(String.raw`(?<![a-z0-9])(?:pin(?:[ _-]?codes?)?|passcodes?)${WRITTEN_SEPARATOR}["']?(\d{4,})(?![\d])`, 'gi')
/**
 * Round 4: a bare `password:` that ends its line, and the value alone on the next line that is not empty. Round 8: read
 * as a line walk (NEXT_LINE_LABEL, then the blank lines skipped by indexOf, then NEXT_LINE_VALUE on the value line):
 * the one regex it was, with (?:[ \t]*\r?\n)* over the blank lines, found nothing under bun past about a million blank
 * lines (JavaScriptCore gives up and says no match, where V8 throws).
 */
const NEXT_LINE_WORDS = String.raw`(?:password|passwd|pwd|pw|passcode|passkey|${FOREIGN_PASSWORD_WORDS})`
const NEXT_LINE_LABEL = new RegExp(String.raw`(?<![a-z0-9])${NEXT_LINE_WORDS}s?[ \t]*[:=\uFF1A][ \t]*\r?\n`, 'iy')
/** The value line, from its start: the value alone (quoted or not) and only spaces after it. */
const NEXT_LINE_VALUE = /[ \t]*["']?([^\s"']{6,}?)["']?[ \t]*\r?$/my

/**
 * Round 8: the regexes that start with a lookbehind ((?<![a-z0-9]) and the words) are tried only where one of their
 * words starts: `words` (a regex of the words alone, 'gi') finds each such place, from left to right, and `rule` (the
 * same rule, sticky) is tried there. JavaScriptCore (bun) cannot skip ahead to a regex's first letters when the regex
 * starts with a lookbehind, so the rule alone tried every position of the text: 0.9 to 1.5 s each on 25 MB of prose
 * (node: 3 to 50 ms). The matches are the rule's own, in the same order: each of them starts where a word does, the
 * places are tried in order, and the search goes on after a match from its end, as matchAll does.
 */
function* matchesWhereWordsStart(text: string, words: RegExp, rule: RegExp, clock: StageClock = NO_CLOCK): Generator<RegExpExecArray> {
  let from = 0
  // Round 9: the budget, every STEPS_PER_CHECK places tried (24 MB of 'pw ' is 8 million places).
  let steps = 0
  while (from <= text.length) {
    if (steps++ % STEPS_PER_CHECK === 0) checkBudget(clock)
    words.lastIndex = from
    const word = words.exec(text)
    if (word === null) return
    rule.lastIndex = word.index
    const match = rule.exec(text)
    if (match === null) {
      from = word.index + 1
      continue
    }
    yield match
    from = match.index + Math.max(1, match[0].length)
  }
}

/** Round 8: the sticky copy of a rule, tried at one place. */
const sticky = (rule: RegExp): RegExp => new RegExp(rule.source, rule.flags.replace('g', '') + 'y')
const WRITTEN_PASSWORD_AT = sticky(WRITTEN_PASSWORD)
const WRITTEN_PASSWORD_WORDS = new RegExp(WRITTEN_WORDS, 'gi')
const WRITTEN_PASS_AT = sticky(WRITTEN_PASS)
const WRITTEN_PASS_WORDS = /pass/gi
const WRITTEN_PIN_AT = sticky(WRITTEN_PIN)
const WRITTEN_PIN_WORDS = /pin|passcode/gi
const NEXT_LINE_LABEL_WORDS = new RegExp(NEXT_LINE_WORDS, 'gi')

/**
 * Round 8: each value a bare label's next line that is not empty holds alone, as the round 4 regex found it: the label
 * ends its line, blank lines (only spaces, tabs and a \r) are skipped, and the next line must be the value alone.
 */
function* nextLineValues(text: string, clock: StageClock = NO_CLOCK): Generator<string> {
  let from = 0
  // Round 9: the budget, every STEPS_PER_CHECK labels tried or blank lines skipped.
  let steps = 0
  while (from <= text.length) {
    if (steps++ % STEPS_PER_CHECK === 0) checkBudget(clock)
    NEXT_LINE_LABEL_WORDS.lastIndex = from
    const word = NEXT_LINE_LABEL_WORDS.exec(text)
    if (word === null) return
    NEXT_LINE_LABEL.lastIndex = word.index
    const label = NEXT_LINE_LABEL.exec(text)
    if (label === null) {
      from = word.index + 1
      continue
    }
    // The blank lines after the label, each read once.
    let line = label.index + label[0].length
    for (;;) {
      if (steps++ % STEPS_PER_CHECK === 0) checkBudget(clock)
      const newline = text.indexOf('\n', line)
      if (newline < 0) break
      let at = line
      while (at < newline && (text[at] === ' ' || text[at] === '\t')) at++
      if (at < newline && text[at] === '\r') at++
      if (at !== newline) break
      line = newline + 1
    }
    NEXT_LINE_VALUE.lastIndex = line
    const value = NEXT_LINE_VALUE.exec(text)
    if (value === null) {
      from = word.index + 1
      continue
    }
    yield value[1]!
    from = value.index + Math.max(1, value[0].length)
  }
}
/** A value that only holds the place of one: ********, ${DB_PASSWORD}, <your key>, changeme, your_token_here. */
const PLACEHOLDER = /^(?:\*+|x+|\.+|<.*|\$\{.*|\{\{.*|%.*%|your[_-].*|change[_-]?me|redacted|hidden|none|null|example.*|placeholder|required|optional)$/i
/** A value of letters only (a word of prose), with any closing punctuation. */
const LETTERS_ONLY = /^\p{L}+[.,;:!?)]*$/u
/** Round 5: a letter anywhere in a value; an api key or token value without one is a number (a count), not a key. */
const HAS_LETTER = /\p{L}/u

/** Round 7: the closing punctuation a written value may end with (LETTERS_ONLY allows the same marks). */
const CLOSING_MARKS: ReadonlySet<string> = new Set(['.', ',', ';', ':', '!', '?', ')'])

/** One written value: not a placeholder, and when `loose` (after ' - ', ' is ', or a pass) not a word of prose. */
function isWrittenValue(value: string, loose: boolean): boolean {
  // Round 7: the closing punctuation is stripped by a backward loop: the regex /[.,;:!?)]+$/ tries again from every
  // mark of a long run that does not end the value (pwd: ....a), which is quadratic.
  let end = value.length
  while (end > 0 && CLOSING_MARKS.has(value[end - 1]!)) end--
  const core = value.slice(0, end)
  if (core === '' || PLACEHOLDER.test(core)) return false
  return !(loose && LETTERS_ONLY.test(value))
}

/** A line in notes that writes a password or key out (Gmail password: ...), which the shared scanner's rules miss. */
function hasWrittenPassword(text: string, clock: StageClock = NO_CLOCK): boolean {
  for (const m of matchesWhereWordsStart(text, WRITTEN_PASSWORD_WORDS, WRITTEN_PASSWORD_AT, clock)) {
    if (m[1] !== undefined && !HAS_LETTER.test(m[3]!)) continue
    if (isWrittenValue(m[3]!, m[2] === undefined)) return true
  }
  for (const m of matchesWhereWordsStart(text, WRITTEN_PASS_WORDS, WRITTEN_PASS_AT, clock)) if (isWrittenValue(m[2]!, true)) return true
  for (const m of matchesWhereWordsStart(text, WRITTEN_PIN_WORDS, WRITTEN_PIN_AT, clock)) if (m[2]) return true
  for (const value of nextLineValues(text, clock)) if (isWrittenValue(value, false)) return true
  return false
}

/** Round 4: a BitLocker recovery key: eight groups of six digits. */
const BITLOCKER_RECOVERY_KEY = /\b\d{6}(?:-\d{6}){7}\b/
/** Round 4: `recovery key:` and what follows it on the line (a FileVault or other key written in groups). */
const RECOVERY_KEY_LABEL = /recovery[ _-]?key[ \t]*[:=\uFF1A][ \t]*([^\r\n]*)/gi
/**
 * Four or more groups of four to eight capitals or digits, one separator throughout: RIGD-UMMY-NOTA-KEYX. Round 8: only
 * the first four groups are read ({2}, not {2,}): a fifth group follows a separator, so the fourth is already followed
 * by no letter or digit, and the answer is the same; {2,} over a million groups found nothing under bun.
 */
const GROUPED_KEY = /^[A-Z0-9]{4,8}([- ])[A-Z0-9]{4,8}(?:\1[A-Z0-9]{4,8}){2}(?![A-Za-z0-9])/

// Round 4: the BIP39 English list (lib/bip39-english.ts, its hash checked by a test); every word is 3 to 8 letters a to z.
/** Round 8: the shortest and longest words on the list (3 and 8 letters). */
const BIP39_SHORTEST = Math.min(...BIP39_ENGLISH_WORDS.map((word) => word.length))
const BIP39_LONGEST = Math.max(...BIP39_ENGLISH_WORDS.map((word) => word.length))
/** Round 8: each list word as a number (wordCode), so the walk below looks a word up with no string made. */
const BIP39_CODES: ReadonlySet<number> = new Set(BIP39_ENGLISH_WORDS.map((word) => wordCode(word)))
/** A wallet recovery phrase is 12, 15, 18, 21 or 24 words: any run of 12 holds the shortest. */
const RECOVERY_PHRASE_RUN = 12

/**
 * Round 4: a run of 12 or more list words one after another (numbers, punctuation and line breaks between them do
 * not break it; any other word does). Ordinary prose breaks the run within a few words: the, of, and, is and to are
 * not on the list.
 */
function hasRecoveryPhrase(text: string, clock: StageClock = NO_CLOCK): boolean {
  // Round 8: the words (runs of ASCII letters, as /[a-z]+/gi read them) are walked by character code and each read as
  // a number (BIP39_CODES), with no string made: 1.1 s on 25 MB of prose under bun before, with a string per word.
  let run = 0
  let at = 0
  // Round 9: the budget, every STEPS_PER_CHECK words or characters between them.
  let steps = 0
  while (at < text.length) {
    if (steps++ % STEPS_PER_CHECK === 0) checkBudget(clock)
    if (!isAsciiLetter(text.charCodeAt(at))) {
      at++
      continue
    }
    const start = at
    let code = 0
    while (at < text.length) {
      const c = text.charCodeAt(at)
      if (!isAsciiLetter(c)) break
      // Only the first BIP39_LONGEST + 1 letters count: a longer word is on no list, whatever it reads.
      if (at - start <= BIP39_LONGEST) code = code * 27 + ((c | 32) - 96)
      at++
    }
    const length = at - start
    if (length < BIP39_SHORTEST || length > BIP39_LONGEST || !BIP39_CODES.has(code)) run = 0
    else if (++run >= RECOVERY_PHRASE_RUN) return true
  }
  return false
}

/** Round 8: a word of 1 to 9 ASCII letters as a number: each letter a to z (either case) a digit 1 to 26 in base 27. */
function wordCode(word: string): number {
  let code = 0
  for (let k = 0; k < word.length; k++) code = code * 27 + ((word.charCodeAt(k) | 32) - 96)
  return code
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

/** A text that holds a disk recovery key (BitLocker's shape, or a recovery key written out in groups). */
function hasRecoveryKey(text: string, clock: StageClock = NO_CLOCK): boolean {
  if (BITLOCKER_RECOVERY_KEY.test(text)) return true
  // Round 9: the budget, every STEPS_PER_CHECK labels.
  let steps = 0
  for (const m of text.matchAll(RECOVERY_KEY_LABEL)) {
    if (steps++ % STEPS_PER_CHECK === 0) checkBudget(clock)
    if (GROUPED_KEY.test(m[1]!)) return true
  }
  return false
}

/** At most this many bytes of a Word or Excel file's text part are inflated; a part past it is refused, never passed unread. */
const OFFICE_PART_MAX = 64 * MB
/**
 * Round 6: at most this many bytes are inflated from one Word or Excel file, summed over every part read. A file that
 * spends it is refused (OFFICE_UNSAFE), so many parts (or many entries that point at one part) cannot add up.
 */
const OFFICE_INFLATE_BUDGET = 64 * MB
/** Round 6: at most this many bytes of one sheet are inflated, for its first rows; the header is near the top. */
const SHEET_HEAD_MAX = 1 * MB
/** Round 6: at most this many sheets are judged; a workbook with more is refused. */
const SHEETS_MAX = 64
/**
 * Round 6: how long reading one Word or Excel file's words may take, checked inside every scan loop. Round 7: on the
 * Worker's own clock (Date.now), inside the Worker deadline (OUTBOUND_CONTENT_DEADLINE_MS in email-outbound-files.ts).
 */
export const OFFICE_READ_MS = 2000
/**
 * Round 8: the budget for one file, which grows with it as the Worker deadline does (email-outbound-files.ts
 * outboundContentDeadlineMs, 5 s plus 1 s per MB): 2 s plus 1 s per MB, so it always ends 3 s inside the deadline.
 */
export function officeReadBudgetMs(size: number): number {
  return Math.min(37_000, OFFICE_READ_MS + Math.ceil((1000 * Math.max(0, size)) / MB))
}
/**
 * Round 7: at most this many characters of words are taken from one Word or Excel file (the cap a text file has: 25 MB),
 * so the checks read no more than a text file can give them; past it the file is refused.
 */
export const OFFICE_TEXT_MAX = 25 * MB
/**
 * Round 11: at most this many elements are read from one Word or Excel file (a shared string, a sheet row, cell or
 * value, a Word row, cell or table, a relationship, and each Word paragraph); past it the file is refused ('could not
 * be read safely'), so a file of millions of tiny elements (peak.mjs's siTiny: 5.7 million shared strings of 'ab' in
 * 120 KB) is refused rather than read. Round 10 charged 8 characters for each against OFFICE_TEXT_MAX instead, which
 * refused an ordinary workbook of 900000 strings of 21 characters; its own cap leaves the words their whole 25 MB.
 */
export const OFFICE_ELEMENTS_MAX = 3_000_000

/** Round 6: a Word or Excel file that would cost too much to read (a zip bomb's shape, or past the clock). */
class OfficeUnsafe extends Error {}

/** Round 6: one Word or Excel file being read: its bytes, the inflate budget left, and the clock. */
interface OfficeRead {
  bytes: Uint8Array
  left: number
  /** Round 7: characters of words taken so far (OFFICE_TEXT_MAX). */
  words: number
  /** Round 11: elements read so far (OFFICE_ELEMENTS_MAX). */
  elements: number
  /** Round 9: the stage's one budget (the read and every check after it), which grows as the parts are inflated. */
  budget: StageBudget
}

/**
 * Round 10: under bun the Worker's heap grows with the garbage of a big read (a match, slices and a string per element,
 * the inflated part and its decoded copy) and the memory is never given back, so the high water mark stays: peak.mjs's
 * 5.7 million shared strings took the daemon to 1.4 to 2.3 GB. A full collection after a big part is inflated and again
 * after it is decoded, every GC_TICKS elements, and after a job that ran GC_JOB_MS or more keeps the high water mark
 * near what is live (measured under bun 1.3.9: _rig/r10/bun-check.sh). Under node (the tests) there is no Bun and
 * nothing is called.
 */
const GC_PART_BYTES = 8 * MB
const GC_TICKS = 65_536
const GC_JOB_MS = 100
let ticksSinceGc = 0
function collectGarbage(): void {
  ticksSinceGc = 0
  const bun = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun
  if (bun !== undefined) bun.gc(true)
}

/** Round 6: past the wall clock budget, the read stops and the file is refused (round 9: the stage's one budget). */
function tick(read: OfficeRead): void {
  checkBudget(read.budget)
  if (++ticksSinceGc >= GC_TICKS) collectGarbage()
}

/** Round 7: `taken` characters of words more; past OFFICE_TEXT_MAX in all, the file is refused. */
function take(read: OfficeRead, taken: number): void {
  read.words += taken
  if (read.words > OFFICE_TEXT_MAX) throw new OfficeUnsafe()
}

/** Round 11: one element more; past OFFICE_ELEMENTS_MAX in all, the file is refused. */
function element(read: OfficeRead): void {
  if (++read.elements > OFFICE_ELEMENTS_MAX) throw new OfficeUnsafe()
}

/** One entry of a zip's central directory: its name, folded as officeTypeOf folds it, and where its bytes are. */
interface ZipEntry {
  name: string
  method: number
  packed: number
  /** Round 10: the inflated size the zip declares (a hint for the inflate's first buffer, never trusted). */
  size: number
  local: number
}

/**
 * Every entry of a zip (isType has already read its central directory), 'unreadable', or (round 6) 'unsafe' when two
 * entries' local bytes repeat or overlap: one blob read under many names is a zip bomb's shape.
 */
function zipEntries(bytes: Uint8Array, clock: StageClock = NO_CLOCK): ZipEntry[] | 'unreadable' | 'unsafe' {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at
      break
    }
  }
  if (end < 0) return 'unreadable'
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  const entries: ZipEntry[] = []
  const spans: [number, number][] = []
  for (let n = 0; n < count; n++) {
    // Round 11: the budget, every STEPS_PER_CHECK entries (at most 65535).
    if (n % STEPS_PER_CHECK === 0) checkBudget(clock)
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) return 'unreadable'
    const nameLength = view.getUint16(at + 28, true)
    const entry: ZipEntry = {
      // Folded as officeTypeOf folds it (lib/email-files.ts), so Word/Document.xml is the part the type check found.
      name: new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)).toLowerCase(),
      method: view.getUint16(at + 10, true),
      packed: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      local: view.getUint32(at + 42, true),
    }
    entries.push(entry)
    // Round 6: where this entry's local header, name, extra field and data lie.
    if (entry.local + 30 > bytes.length || view.getUint32(entry.local, true) !== 0x04034b50) return 'unreadable'
    const dataAt = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true)
    spans.push([entry.local, dataAt + entry.packed])
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
  }
  spans.sort((a, b) => a[0] - b[0])
  for (let n = 1; n < spans.length; n++) if (spans[n]![0] < spans[n - 1]![1]) return 'unsafe'
  return entries
}

/**
 * Round 6: a deflate stream inflated until it ends or until `limit` bytes are out, whichever comes first: the bytes, and
 * whether there was more. A stream is used so the inflate stops at the limit, never inflating the rest.
 */
function inflateUpTo(body: Uint8Array, limit: number, read: OfficeRead, declared: number): Promise<{ out: Uint8Array; more: boolean } | 'unreadable' | 'unsafe'> {
  return new Promise((resolve) => {
    const z = createInflateRaw({ chunkSize: 64 * 1024 })
    // Round 10: inflated into ONE buffer, sized by the size the zip declares (at most limit + 1, to see there is more)
    // and doubled when the stream is longer, not a list of chunks joined by Buffer.concat at the end: two copies of a
    // 60 MB part at once, which under bun stay in the daemon's memory.
    let out = new Uint8Array(Math.min(limit + 1, Math.max(64 * 1024, declared + 1)))
    let size = 0
    let done = false
    const finish = (value: { out: Uint8Array; more: boolean } | 'unreadable' | 'unsafe') => {
      if (done) return
      done = true
      resolve(value)
      z.destroy()
    }
    z.on('data', (chunk: Buffer) => {
      if (done) return
      const kept = Math.min(chunk.length, limit + 1 - size)
      if (size + kept > out.length) {
        const more = new Uint8Array(Math.min(limit + 1, Math.max(out.length * 2, size + kept)))
        more.set(out.subarray(0, size))
        out = more
      }
      out.set(chunk.subarray(0, kept), size)
      size += kept
      if (Date.now() > read.budget.deadline) finish('unsafe')
      else if (size > limit) finish({ out: out.subarray(0, limit), more: true })
    })
    z.on('end', () => finish({ out: out.subarray(0, size), more: false }))
    // Not a deflate stream.
    z.on('error', () => finish('unreadable'))
    z.end(body)
  })
}

/**
 * One entry's bytes, inflated under the cap, or 'unreadable' when it cannot be read whole. With `head` (round 5), only
 * its first `head` bytes: the first rows of a sheet. Round 6: everything inflated is taken from the file's one budget,
 * and a part that would go past what is left of it refuses the file (OfficeUnsafe).
 */
async function zipInflate(read: OfficeRead, entry: ZipEntry, head?: number, max?: number): Promise<Uint8Array | 'unreadable'> {
  const { bytes } = read
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const { local, packed, method } = entry
  if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) return 'unreadable'
  const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
  if (dataAt + packed > bytes.length) return 'unreadable'
  const body = bytes.subarray(dataAt, dataAt + packed)
  // Round 8: `max`, a part's own cap that refuses the file past it (Word's main part: OFFICE_TEXT_MAX).
  const cap = head ?? max ?? OFFICE_PART_MAX
  const limit = Math.min(cap, read.left)
  let got: { out: Uint8Array; more: boolean } | 'unreadable' | 'unsafe'
  if (method === 0) got = { out: body.subarray(0, limit), more: body.length > limit }
  else if (method === 8) got = await inflateUpTo(body, limit, read, entry.size)
  else return 'unreadable'
  if (got === 'unsafe') throw new OfficeUnsafe()
  if (got === 'unreadable') return got
  read.left -= got.out.length
  // Round 9: the budget grows to what has been inflated (the words are read from it).
  grow(read.budget, OFFICE_INFLATE_BUDGET - read.left)
  tick(read)
  if (got.more) {
    // The file's budget is spent: refused. A whole part past its own cap is not read whole: refused as before.
    if (limit < cap || max !== undefined) throw new OfficeUnsafe()
    if (head === undefined) return 'unreadable'
  }
  return got.out
}

/** Round 11: the character each named entity stands for, by its name's length and letters (amp, lt, gt, quot, apos). */
const NAMED_ENTITIES: readonly [string, string][] = [['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]
/** Round 11: where the reference read by entityAt ends (just after its ';'). */
let entityEnd = 0

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

function isHexDigit(code: number): boolean {
  return isDigit(code) || ((code | 32) >= 97 && (code | 32) <= 102)
}

/** A character reference's text: '' for 0 or past the last code point, as round 10's regex replaced it. */
function codePointText(code: number): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
}

/**
 * Round 11: the character the reference that starts at `at` (an '&') stands for, as round 10's regex read one
 * (/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi: a decimal or hex number of any length, or one of five names,
 * in any case, then ';'), or null when none starts there. entityEnd is set to just after its ';'.
 */
function entityAt(text: string, at: number): string | null {
  let k = at + 1
  if (text.charCodeAt(k) === 35) {
    k++
    const start = text.charCodeAt(k) === 120 || text.charCodeAt(k) === 88 ? k + 1 : k
    const hex = start !== k
    let end = start
    while (end < text.length && (hex ? isHexDigit(text.charCodeAt(end)) : isDigit(text.charCodeAt(end)))) end++
    if (end === start || text.charCodeAt(end) !== 59) return null
    entityEnd = end + 1
    const digits = text.slice(start, end)
    return codePointText(hex ? Number.parseInt(digits, 16) : Number(digits))
  }
  for (const [name, char] of NAMED_ENTITIES) {
    let n = 0
    while (n < name.length && (text.charCodeAt(k + n) | 32) === name.charCodeAt(n)) n++
    if (n === name.length && text.charCodeAt(k + n) === 59) {
      entityEnd = k + n + 1
      return char
    }
  }
  return null
}

/**
 * The five XML entities and character references, read. Round 11: by a walk from '&' to '&', the text joined in pieces
 * (TextPieces), with the budget read every STEPS_PER_CHECK references: round 10's one replace over the whole text made a
 * string for every match (60 MB of '&lt;b' took a Worker to 2 GB under bun).
 */
function xmlEntities(text: string, clock: StageClock = NO_CLOCK): string {
  let amp = text.indexOf('&')
  if (amp < 0) return text
  const out = new TextPieces()
  let from = 0
  let steps = 0
  while (amp >= 0) {
    if (steps++ % STEPS_PER_CHECK === 0) checkBudget(clock)
    const char = entityAt(text, amp)
    if (char === null) {
      amp = text.indexOf('&', amp + 1)
      continue
    }
    if (amp > from) out.push(text.slice(from, amp))
    out.push(char)
    from = entityEnd
    amp = text.indexOf('&', from)
  }
  if (from < text.length) out.push(text.slice(from))
  return out.text()
}

/**
 * XML text with its tags taken out and its five entities and character references read. Round 6: tags are found by
 * indexOf ('<', then its '>'), so a run of '<' with no '>' is read once, not once per '<'; text from an unclosed '<'
 * on is kept as it is. Round 11: the text between the tags is joined in pieces (TextPieces), not held as one string
 * each until the end (one shared string of millions of tags), and the budget is read every STEPS_PER_CHECK tags; the
 * entities are then read over the joined text, as before (a reference split by a tag is read whole, as round 10 read it).
 */
const WORD_TAB_OR_BREAK = /^<(?:[a-z_][\w.-]*:)?(tab|br)\/>$/i
function xmlText(xml: string, clock: StageClock = NO_CLOCK): string {
  let lt = xml.indexOf('<')
  if (lt < 0) return xmlEntities(xml, clock)
  const out = new TextPieces()
  let at = 0
  let steps = 0
  for (;;) {
    if (steps++ % STEPS_PER_CHECK === 0) checkBudget(clock)
    if (lt < 0) {
      out.push(xml.slice(at))
      break
    }
    if (lt > at) out.push(xml.slice(at, lt))
    const gt = xml.indexOf('>', lt + 1)
    if (gt < 0) {
      out.push(xml.slice(lt))
      break
    }
    // Round 7: a tab or a line break under any prefix (<w:tab/>, <x:br/>); only a short tag can be one.
    const brk = gt - lt <= 64 ? WORD_TAB_OR_BREAK.exec(xml.slice(lt, gt + 1))?.[1] : undefined
    if (brk === 'tab') out.push('\t')
    else if (brk === 'br') out.push('\n')
    at = gt + 1
    lt = xml.indexOf('<', at)
  }
  return xmlEntities(out.text(), clock)
}

/** Round 7: any namespace prefix, or none (an XML name: a letter or '_', then letters, digits, '.', '-' or '_'). */
const XML_PREFIX = String.raw`(?:[a-z_][\w.-]*:)?`

/**
 * Round 7: where the opening tag that starts at `from` ends: its first '>' outside a quoted attribute value ('/>' or '>'
 * inside quotes is not the end), or -1 when there is none. Each character of the tag is read once.
 */
function tagEnd(xml: string, from: number, clock: StageClock = NO_CLOCK): number {
  let quote = ''
  for (let at = from; at < xml.length; at++) {
    // Round 11: the budget, every TAG_CHARS_PER_CHECK characters of one tag (an attribute may be megabytes long).
    if ((at - from) % TAG_CHARS_PER_CHECK === TAG_CHARS_PER_CHECK - 1) checkBudget(clock)
    const ch = xml[at]!
    if (quote !== '') {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      return at
    }
  }
  return -1
}

/** Round 11: how many characters of one tag tagEnd reads between two reads of the budget. */
const TAG_CHARS_PER_CHECK = 65_536

/** Round 6: the opening tag of each element these scans read: its name, with any namespace prefix when `prefixed`. */
const openingTags = new Map<string, RegExp>()
function openingTag(name: string, prefixed: boolean): RegExp {
  const key = `${prefixed ? 'p' : ''}:${name}`
  let re = openingTags.get(key)
  if (re === undefined) {
    re = new RegExp(String.raw`<(${prefixed ? XML_PREFIX : ''}${name})(?=[\s/>])`, prefixed ? 'gi' : 'g')
    openingTags.set(key, re)
  }
  return re
}

/**
 * Round 6: each element `name` in the XML, in order: its attributes and the text inside it. Read by indexOf: the
 * opening tag, its '>', then the closing tag found once, and the scan goes on after it, so no text is read twice
 * (linear, where a lazy regex over many unclosed tags is quadratic). A closing tag or '>' that is missing ends the
 * whole scan: the rest is read as cut off. The clock is checked at every element, and (round 11) each counts against
 * OFFICE_ELEMENTS_MAX.
 */
function* xmlElements(xml: string, name: string, prefixed: boolean, read: OfficeRead): Generator<{ attrs: string; inner: string }> {
  // One regex per name, shared: its lastIndex is set before each exec and read at once, before any yield.
  const re = openingTag(name, prefixed)
  let at = 0
  for (;;) {
    tick(read)
    re.lastIndex = at
    const open = re.exec(xml)
    if (open === null) return
    const after = re.lastIndex
    // Round 7: the tag's end outside quoted attribute values.
    const gt = tagEnd(xml, after, read.budget)
    if (gt < 0) return
    // Round 11: every element read counts against OFFICE_ELEMENTS_MAX (round 10: 8 characters of words each).
    if (xml[gt - 1] === '/') {
      element(read)
      yield { attrs: xml.slice(after, gt - 1), inner: '' }
      at = gt + 1
      continue
    }
    const close = `</${open[1]}>`
    const end = xml.indexOf(close, gt + 1)
    if (end < 0) return
    element(read)
    yield { attrs: xml.slice(after, gt), inner: xml.slice(gt + 1, end) }
    at = end + close.length
  }
}

/** Round 7: the end of a Word paragraph, under any namespace prefix. */
const WORD_PARAGRAPH_END = new RegExp(String.raw`</${XML_PREFIX}p>`, 'gi')

/** Round 5: a worksheet part's usual place, a cell's type (the t attribute) and (round 6) its column (the r attribute). */
const SHEET_PART = /^xl\/worksheets\/[^/]+\.xml$/
const SHEET_CELL_TYPE = /(?:^|\s)t\s*=\s*["']([^"']*)["']/
const SHEET_CELL_COLUMN = /(?:^|\s)r\s*=\s*["']([a-z]+)/i
/** Round 6: the workbook's relationships part, and a relationship's type, target and target mode. */
const WORKBOOK_RELS = 'xl/_rels/workbook.xml.rels'
const REL_TYPE = /(?:^|\s)Type\s*=\s*["']([^"']*)["']/
const REL_TARGET = /(?:^|\s)Target\s*=\s*["']([^"']*)["']/
const REL_EXTERNAL = /(?:^|\s)TargetMode\s*=\s*["']External["']/i

/**
 * Round 5: the first non empty rows of one sheet (HEADER_LINES of them, as a text file's header lines), each cell's
 * text: a shared string by its index (t="s"), an inline string (t="inlineStr"), or the value itself. The inline
 * strings and formula strings are returned too, so the other checks read them. Round 6: column A of those rows is
 * returned as one more row (a table laid down a column), and the shared strings the rows used are marked. Round 11:
 * every cell's words are charged against the cap on words as the row reads them, a shared string once for each cell
 * that points at it (the reviewer's amp shape: 50000 cells pointing at one string of up to 25 MB was hours of one core
 * per Worker, with no budget read), and the budget is read before each row's blank check.
 */
function sheetHeadRows(xml: string, shared: SharedStrings, used: Set<number>, read: OfficeRead): { rows: string[][]; own: string[] } {
  const rows: string[][] = []
  const own: string[] = []
  const columnA: string[] = []
  for (const row of xmlElements(xml, 'row', true, read)) {
    const cells: string[] = []
    let first = ''
    for (const cell of xmlElements(row.inner, 'c', true, read)) {
      const kind = SHEET_CELL_TYPE.exec(cell.attrs)?.[1] ?? 'n'
      const column = SHEET_CELL_COLUMN.exec(cell.attrs)?.[1]
      let value: string | undefined
      for (const v of xmlElements(cell.inner, 'v', true, read)) {
        value = v.inner
        break
      }
      let words: string
      if (kind === 'inlineStr') {
        words = xmlText(cell.inner, read.budget)
        own.push(words)
      } else if (kind === 's') {
        const index = value === undefined ? Number.NaN : Number(value.trim())
        words = shared.at(index) ?? ''
        if (Number.isInteger(index)) used.add(index)
      } else {
        words = value === undefined ? '' : xmlText(value, read.budget)
        if (kind === 'str') own.push(words)
      }
      // Round 11: the words this cell reads, charged as it reads them.
      take(read, words.length)
      // Column A: the cell its r attribute puts there, or the row's first cell when the cells carry no r.
      if (column === undefined ? cells.length === 0 : column.toUpperCase() === 'A') first = words
      cells.push(words)
    }
    // Round 11: the budget, then the blank check one cell at a time (each read up to its first other character).
    checkBudget(read.budget)
    if (cells.every(isBlank)) continue
    rows.push(cells)
    columnA.push(first)
    if (rows.length >= HEADER_LINES) break
  }
  if (columnA.length > 1) rows.push(columnA)
  return { rows, own }
}

/**
 * Round 12: the longest relationship target read (as written, before its entities are read: they only shorten it). A
 * part's path in a file Excel writes is a few dozen characters; a longer target is refused as unsafe before it is read
 * (the reviewer's 'a/' repeated 31 million times, a 62 KB file, took the Worker to 1.6 GB in round 11's split).
 */
const REL_TARGET_MAX = 260
/**
 * Round 13: at most this many relationships are read from the workbook's relationships part, and the part is inflated
 * up to RELS_PART_MAX and no further; past either the file is refused as unsafe. A workbook Excel writes has one
 * relationship for each sheet and a few more (styles, theme, shared strings), in a part of a few KB. The round 12
 * reviewer's 55000 targets of 1024 characters (a 0.66 MB file, its part 63 MB) took bun to about 1 GB.
 */
const RELS_MAX = 4096
const RELS_PART_MAX = 2 * MB

/**
 * Round 6: a relationship target, read from xl/ as Excel reads it ('/xl/s.xml', 's.xml', '../xl/s.xml'), folded.
 * Round 12: walked a segment at a time by indexOf (no array of every segment), on a target of at most REL_TARGET_MAX
 * characters (the caller refuses a longer one).
 */
function workbookTarget(target: string): string {
  const path = (target.startsWith('/') ? target.slice(1) : `xl/${target}`).replace(/\\/g, '/')
  const out: string[] = []
  for (let at = 0; at <= path.length; ) {
    const slash = path.indexOf('/', at)
    const end = slash < 0 ? path.length : slash
    const part = path.slice(at, end)
    if (part === '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
    at = end + 1
  }
  return out.join('/').toLowerCase()
}

/**
 * A Word file's words (word/document.xml: one line per paragraph) or an Excel file's (its shared strings, one cell
 * each), so a pasted key or a written password in one is refused as in a text file. Round 5: the table check reads
 * ROWS, as a text file's header lines are read one by one: each row of each Word table, and the first rows of each
 * Excel sheet (shared string indexes and inline strings). A gradebook's Pass cell and its Email column are not one
 * row, so they are not a password table. A workbook with no sheet part has only its shared strings, which are then
 * read as one row (the stricter reading). A PDF's words are not read.
 *
 * Round 6: bounded. One inflate budget for the whole file, only the head of each sheet, at most SHEETS_MAX sheets, no
 * two entries over the same bytes, linear scans, and a wall clock budget: past any of them the file is refused
 * ('unsafe'). The sheets read are those the workbook's relationships name (wherever they are) and those in
 * xl/worksheets/; a sheet the relationships name that is not in the file is refused. With no relationships part (not
 * a file Excel writes), the shared strings no judged row used are judged as one more row. Each Word table's first
 * column, and column A of each sheet's first rows, are judged as one row too.
 */
async function officeWords(
  bytes: Uint8Array,
  type: 'docx' | 'xlsx',
  budget: StageBudget,
): Promise<{ ok: true; text: string; table: boolean } | { ok: false; unsafe: boolean }> {
  let entries: ReturnType<typeof zipEntries>
  try {
    entries = zipEntries(bytes, budget)
  } catch (err) {
    if (err instanceof OverBudget) return { ok: false, unsafe: true }
    throw err
  }
  if (entries === 'unreadable') return { ok: false, unsafe: false }
  if (entries === 'unsafe') return { ok: false, unsafe: true }
  const read: OfficeRead = { bytes, left: OFFICE_INFLATE_BUDGET, words: 0, elements: 0, budget }
  try {
    const got = await officeWordsOf(read, entries, type)
    return got === 'unreadable' ? { ok: false, unsafe: false } : { ok: true, ...got }
  } catch (err) {
    if (err instanceof OfficeUnsafe || err instanceof OverBudget) return { ok: false, unsafe: true }
    throw err
  }
}

/** Round 10: how many small pieces TextPieces holds before it joins them into one chunk. */
const PIECES_PER_CHUNK = 4096

/**
 * Round 10: a text made of many small pieces (paragraphs, shared strings) without holding them: every PIECES_PER_CHUNK
 * pieces are joined into one string. Millions of small strings held at once cost far more than their characters.
 */
class TextPieces {
  length = 0
  private pieces: string[] = []
  private chunks: string[] = []

  push(piece: string): void {
    this.pieces.push(piece)
    this.length += piece.length
    if (this.pieces.length >= PIECES_PER_CHUNK) this.flush()
  }

  text(): string {
    // Round 11: a few pieces (most calls of xmlText) are joined once.
    if (this.chunks.length === 0) {
      const text = this.pieces.join('')
      this.pieces = []
      this.chunks = [text]
      return text
    }
    this.flush()
    const text = this.chunks.join('')
    this.chunks = [text]
    return text
  }

  private flush(): void {
    if (this.pieces.length === 0) return
    this.chunks.push(this.pieces.join(''))
    this.pieces = []
  }
}

/**
 * Round 10: a workbook's shared strings as ONE string (each followed by a line break) and where each starts, not as a
 * string each.
 */
class SharedStrings {
  private starts = new Int32Array(1024)
  private pieces = new TextPieces()
  count = 0
  /** Each string followed by '\n', once done. */
  all = ''

  push(words: string): void {
    if (this.count === this.starts.length) {
      const more = new Int32Array(this.starts.length * 2)
      more.set(this.starts)
      this.starts = more
    }
    this.starts[this.count++] = this.pieces.length
    this.pieces.push(words)
    this.pieces.push('\n')
  }

  done(): void {
    this.all = this.pieces.text()
    this.pieces = new TextPieces()
  }

  /** The string at `index`, or undefined when there is none (not an integer, or out of range). */
  at(index: number): string | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) return undefined
    const end = index + 1 < this.count ? this.starts[index + 1]! - 1 : this.all.length - 1
    return this.all.slice(this.starts[index]!, end)
  }

  /** Every string but the `skip`ped ones, one at a time, the budget read as they go. */
  *each(skip: ReadonlySet<number>, clock: StageClock): Generator<string> {
    for (let index = 0; index < this.count; index++) {
      if (index % STEPS_PER_CHECK === 0) checkBudget(clock)
      if (!skip.has(index)) yield this.at(index)!
    }
  }

  /** The strings one per line, as shared.join('\n') gave them. */
  lines(): string {
    return this.all.slice(0, -1)
  }
}

/**
 * Round 10: one part inflated and decoded, so its bytes are not held while its text is read; for a big part, the
 * inflate's garbage and then the bytes are collected (collectGarbage) before its text is read.
 */
async function inflatedText(read: OfficeRead, entry: ZipEntry, head?: number, max?: number): Promise<string | 'unreadable'> {
  let part: Uint8Array | 'unreadable' | null = await zipInflate(read, entry, head, max)
  if (part === 'unreadable') return part
  const big = part.length >= GC_PART_BYTES
  if (big) collectGarbage()
  const text = new TextDecoder().decode(part)
  part = null
  if (big) collectGarbage()
  return text
}

/**
 * The words of a Word or Excel file and whether a row of it names a password column. Round 10: each row is judged as
 * it is read (no gradebook exemption, so no row needs the values below it), each Word table's first column and column A
 * of each sheet's first rows as one row more, and no row is held.
 */
async function officeWordsOf(read: OfficeRead, entries: ZipEntry[], type: 'docx' | 'xlsx'): Promise<{ text: string; table: boolean } | 'unreadable'> {
  const find = (want: string) => entries.find((e) => e.name === want)
  let table = false
  if (type === 'docx') {
    const main = find('word/document.xml')
    // A Word file always has its main part (the type check found it), so a part not found is not read: refused.
    // Round 8: inflated up to the 25 MB cap on a file's words, and no further: the words are never more than the XML,
    // so a main part past it is refused (OfficeUnsafe) without inflating the rest.
    const xml = main === undefined ? 'unreadable' : await inflatedText(read, main, undefined, OFFICE_TEXT_MAX)
    if (xml === 'unreadable') return xml
    // Round 7: rows, cells and tables under any namespace prefix (x:tr, or tr under a default namespace), as Excel's are.
    for (const row of xmlElements(xml, 'tr', true, read)) {
      const cells = new PasswordRow(read.budget)
      for (const cell of xmlElements(row.inner, 'tc', true, read)) cells.add(xmlText(cell.inner, read.budget))
      if (cells.names) table = true
    }
    // Round 6: each table's first column, as one row (a table laid down a column: Bank, Login, PIN).
    for (const tbl of xmlElements(xml, 'tbl', true, read)) {
      const column = new PasswordRow(read.budget)
      for (const row of xmlElements(tbl.inner, 'tr', true, read)) {
        for (const cell of xmlElements(row.inner, 'tc', true, read)) {
          column.add(xmlText(cell.inner, read.budget))
          break
        }
      }
      if (column.cells > 1 && column.names) table = true
    }
    // Round 8: the paragraphs are walked one at a time and their words counted as they are taken (split made every
    // paragraph's string first, millions of them for <w:p/> over and over). Round 10: the lines are joined as they
    // come (TextPieces). Round 11: each paragraph counts against OFFICE_ELEMENTS_MAX, and each is read as a text file's
    // header line too (WordHeader: a password list typed as tabbed or comma separated paragraphs).
    const lines = new TextPieces()
    const header = new WordHeader(read.budget)
    let at = 0
    for (;;) {
      tick(read)
      WORD_PARAGRAPH_END.lastIndex = at
      const end = WORD_PARAGRAPH_END.exec(xml)
      const line = xmlText(xml.slice(at, end === null ? xml.length : end.index), read.budget)
      take(read, line.length + 1)
      element(read)
      if (!table && header.names(line)) table = true
      if (at > 0) lines.push('\n')
      lines.push(line)
      if (end === null) break
      at = end.index + end[0].length
    }
    return { text: lines.text(), table }
  }
  const strings = find('xl/sharedstrings.xml')
  const sst = strings === undefined ? null : await inflatedText(read, strings)
  if (sst === 'unreadable') return sst
  const shared = new SharedStrings()
  if (sst !== null) {
    for (const si of xmlElements(sst, 'si', true, read)) {
      const words = xmlText(si.inner, read.budget)
      take(read, words.length + 1)
      shared.push(words)
    }
  }
  shared.done()
  // Round 6: the sheets the workbook's relationships name, then any other part in xl/worksheets/.
  const names = new Set<string>()
  const relsEntry = find(WORKBOOK_RELS)
  if (relsEntry !== undefined) {
    const rels = await inflatedText(read, relsEntry, undefined, RELS_PART_MAX)
    if (rels === 'unreadable') return rels
    let relationships = 0
    for (const rel of xmlElements(rels, 'Relationship', true, read)) {
      if (++relationships > RELS_MAX) throw new OfficeUnsafe()
      const target = REL_TARGET.exec(rel.attrs)?.[1]
      if (!/\/worksheet$/i.test(REL_TYPE.exec(rel.attrs)?.[1] ?? '') || target === undefined || REL_EXTERNAL.test(rel.attrs)) continue
      // Round 12: a target longer than any part's path is refused before it is read.
      if (target.length > REL_TARGET_MAX) throw new OfficeUnsafe()
      names.add(workbookTarget(xmlEntities(target, read.budget)))
      // Round 13: at once, so at most SHEETS_MAX + 1 targets are walked (round 12 looked after the loop).
      if (names.size > SHEETS_MAX) throw new OfficeUnsafe()
    }
  }
  for (const entry of entries) if (SHEET_PART.test(entry.name)) names.add(entry.name)
  const used = new Set<number>()
  // A workbook with no sheet part: its shared strings are judged as one row (the stricter reading).
  if (names.size === 0) return { text: shared.lines(), table: shared.count > 0 && looksLikePasswordTable(shared.each(used, read.budget), read.budget) }
  if (names.size > SHEETS_MAX) throw new OfficeUnsafe()
  const own: string[] = []
  for (const name of names) {
    const sheet = find(name)
    // A sheet the workbook names that is not in the file is not read: refused, never passed unread.
    const head = sheet === undefined ? 'unreadable' : await inflatedText(read, sheet, SHEET_HEAD_MAX)
    if (head === 'unreadable') return head
    const got = sheetHeadRows(head, shared, used, read)
    if (got.rows.some((row) => looksLikePasswordTable(row, read.budget))) table = true
    // Round 11: one at a time (a spread of tens of thousands of strings passes them all as arguments).
    for (const words of got.own) {
      take(read, words.length + 1)
      own.push(words)
    }
  }
  // Round 6: with no relationships part, a sheet may sit where it is not looked for; the shared strings no judged row
  // used are judged as one more row, so such a sheet's header is not missed.
  if (relsEntry === undefined && !table) {
    const unused = new PasswordRow(read.budget)
    for (const words of shared.each(used, read.budget)) unused.add(words)
    if (unused.cells > 0 && unused.names) table = true
  }
  return { text: [...(shared.count > 0 ? [shared.lines()] : []), ...own].join('\n'), table }
}

/**
 * A private key's armour line: PRIVATE KEY (PKCS#8), RSA, EC, DSA, OPENSSH and ENCRYPTED ones, and a PGP key block.
 * Round 8: read only at each '-----BEGIN ' (indexOf), on at most ARMOUR_WINDOW characters from it: over a million
 * groups the one regex on the whole text found nothing under bun (JavaScriptCore gives up and says no match).
 */
const PRIVATE_KEY_ARMOUR = /^-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/
const ARMOUR_BEGIN = '-----BEGIN '
/** Round 8: the longest armour line read (a real one is under 40 characters). */
const ARMOUR_WINDOW = 200
/**
 * Round 8: a label still running at the window's end (only capitals, digits and spaces after -----BEGIN): no real
 * armour is that long, and what comes after it is not read, so it is refused as a key (fail closed).
 */
const ARMOUR_LABEL_RUNNING = /^-----BEGIN [A-Z0-9 ]*$/

/** Round 8: an armour line at any '-----BEGIN ' of the text, each read on at most ARMOUR_WINDOW characters. */
function hasPrivateKeyArmour(text: string, clock: StageClock = NO_CLOCK): boolean {
  // Round 9: the budget, every STEPS_PER_CHECK armour starts.
  let steps = 0
  for (let at = text.indexOf(ARMOUR_BEGIN); at >= 0; at = text.indexOf(ARMOUR_BEGIN, at + 1)) {
    if (steps++ % STEPS_PER_CHECK === 0) checkBudget(clock)
    const window = text.slice(at, at + ARMOUR_WINDOW)
    if (PRIVATE_KEY_ARMOUR.test(window)) return true
    if (window.length === ARMOUR_WINDOW && ARMOUR_LABEL_RUNNING.test(window)) return true
  }
  return false
}

/** An age secret key (sops keeps its key in ~/.config/sops/age/keys.txt). */
const AGE_SECRET_KEY = /\bAGE-SECRET-KEY-1[0-9A-Z]+/

/** A text file that holds a private key armour line or an age key anywhere: a key pasted or renamed into a .txt or .csv. */
function hasPrivateKey(text: string, clock: StageClock): boolean {
  return hasPrivateKeyArmour(text, clock) || AGE_SECRET_KEY.test(text)
}

/** The first line curl, wget and the browser cookie export add ons write: every cookie after it signs in as the owner. */
const COOKIE_FILE_HEADER = /^# (?:netscape )?http cookie file/i

/** This daemon's own credential in the text, even split by spacing (agent-email-tools.ts secretRefusal reads an email the same way). */
function holdsOwnCredential(text: string, secrets: readonly string[]): boolean {
  // Round 7: with no credential to look for, the text is not compacted.
  if (!secrets.some((secret) => typeof secret === 'string' && secret.length >= 8)) return false
  const compact = text.replace(/\s+/g, '')
  return secrets.some((secret) => typeof secret === 'string' && secret.length >= 8 && compact.includes(secret.replace(/\s+/g, '')))
}

/** Round 7: what the content stage found, first by the order the checks run in; email-outbound-files.ts says the sentence. */
export type ContentVerdict =
  | { kind: 'ok' }
  | { kind: 'unsafe' }
  | { kind: 'unread' }
  | { kind: 'table' }
  | { kind: 'private_key' }
  | { kind: 'cookie' }
  | { kind: 'own_credential' }
  | { kind: 'recovery_key' }
  | { kind: 'recovery_phrase' }
  | { kind: 'secret'; rule: string }
  | { kind: 'written' }

/** Round 7: every kind a verdict may have (the main thread refuses a reply with any other). */
export const CONTENT_VERDICT_KINDS: readonly ContentVerdict['kind'][] = Object.freeze([
  'ok', 'unsafe', 'unread', 'table', 'private_key', 'cookie', 'own_credential', 'recovery_key', 'recovery_phrase', 'secret', 'written',
])

/**
 * Round 7: a turn of the event loop. Under bun, worker.terminate() takes effect only when the Worker's code returns
 * to its event loop (node's interrupts it anywhere), so the stage yields between its checks: a Worker terminated at
 * the deadline then stops at the next yield, not at the end of the whole stage.
 */
function yieldTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Round 7: how much text the scanner reads between two yields; each piece ends at a line break. */
const SCAN_PIECE = 1 * MB

/**
 * Round 7: the rule of the scanner's first finding (lib/secret-scan.ts scanText, which reads line by line), read a
 * piece of whole lines at a time with a yield between pieces. Each piece ends just after a '\n', so its lines are the
 * text's lines and its first finding, if any, is the text's first.
 */
async function firstSecretRule(name: string, text: string, clock: StageClock = NO_CLOCK): Promise<string | null> {
  let start = 0
  while (start < text.length) {
    // Round 9: the budget, before each piece (a piece is one scanText call, which reads no clock).
    checkBudget(clock)
    const newline = text.indexOf('\n', start + SCAN_PIECE)
    const end = newline < 0 ? text.length : newline + 1
    const found = scanText(name, text.slice(start, end))
    if (found.length > 0) return found[0]!.rule
    start = end
    await yieldTurn()
  }
  return null
}

/** Round 7: the files whose words the content stage reads. */
export type ContentType = 'text' | 'docx' | 'xlsx'

/**
 * Round 7: the whole content stage of one file whose type its bytes have already proved: a text file's whole text,
 * decoded once (at most 25 MB, already read), or a Word or Excel file's own words (round 3), then every check in the
 * order readOutboundFile ran them. Run in the content Worker; `name` is what the scanner's findings are filed under.
 * Round 9: under one budget for the whole stage (StageBudget): officeReadBudgetMs of the larger of the file's size and
 * its words, or `budgetMs` when given (a test's, fixed). Over it, at any check, the file is 'unsafe'.
 */
export async function outboundContentVerdict(
  bytes: Uint8Array,
  type: ContentType,
  name: string,
  secrets: readonly string[],
  budgetMs?: number,
): Promise<ContentVerdict> {
  const start = Date.now()
  const budget: StageBudget =
    budgetMs === undefined
      ? { start, deadline: start + officeReadBudgetMs(bytes.length), grows: true }
      : { start, deadline: start + budgetMs, grows: false }
  try {
    return await verdictWithin(bytes, type, name, secrets, budget)
  } catch (err) {
    // Round 9: over the budget, the Worker answers itself and takes the next file.
    if (err instanceof OverBudget) return { kind: 'unsafe' }
    throw err
  } finally {
    // Round 10: a heavy job's garbage is collected before the next file (see collectGarbage).
    if (Date.now() - start >= GC_JOB_MS) collectGarbage()
  }
}

async function verdictWithin(bytes: Uint8Array, type: ContentType, name: string, secrets: readonly string[], budget: StageBudget): Promise<ContentVerdict> {
  let text = ''
  let table = false
  if (type === 'text') {
    table = hasPasswordColumn(bytes)
    text = new TextDecoder().decode(bytes)
  } else {
    const words = await officeWords(bytes, type, budget)
    // Round 6: a file that would cost too much to read (a zip bomb's shape, or past the clock) is never attached.
    if (!words.ok) return { kind: words.unsafe ? 'unsafe' : 'unread' }
    text = words.text
    // Round 9: the checks below read the words, so the budget is that of the words when they are more than the file.
    grow(budget, text.length)
    // Round 5: row by row, as a text file's header lines are read (never every cell of the file at once). Round 10:
    // judged as they were read.
    table = words.table
  }
  if (table) return { kind: 'table' }
  await turnWithin(budget)
  if (hasPrivateKey(text, budget)) return { kind: 'private_key' }
  if (COOKIE_FILE_HEADER.test(text)) return { kind: 'cookie' }
  await turnWithin(budget)
  if (holdsOwnCredential(text, secrets)) return { kind: 'own_credential' }
  await turnWithin(budget)
  if (hasRecoveryKey(text, budget)) return { kind: 'recovery_key' }
  await turnWithin(budget)
  if (hasRecoveryPhrase(text, budget)) return { kind: 'recovery_phrase' }
  await turnWithin(budget)
  // The scanner an email's words go through (lib/secret-scan.ts): only the rule's name is said, never the value.
  const rule = await firstSecretRule(name, text, budget)
  if (rule !== null) return { kind: 'secret', rule }
  await turnWithin(budget)
  if (hasWrittenPassword(text, budget)) return { kind: 'written' }
  return { kind: 'ok' }
}

/** Round 9: a turn of the event loop between two checks (round 7), then the budget. */
async function turnWithin(clock: StageClock): Promise<void> {
  await yieldTurn()
  checkBudget(clock)
}

/**
 * Round 8: the walks that replace a regex, for the tests that compare each with the regex it replaced (on node, where
 * the regex finds what it should): the written password rules tried where their words start, the next line values,
 * and the armour read at each -----BEGIN.
 */
export const CONTENT_WALKS_FOR_TESTS = Object.freeze({
  // Round 9: each walk takes a budget (a StageClock) and throws OverBudget past it.
  writtenPasswordMatches: (text: string, clock?: StageClock) => [...matchesWhereWordsStart(text, WRITTEN_PASSWORD_WORDS, WRITTEN_PASSWORD_AT, clock)],
  writtenPassMatches: (text: string, clock?: StageClock) => [...matchesWhereWordsStart(text, WRITTEN_PASS_WORDS, WRITTEN_PASS_AT, clock)],
  writtenPinMatches: (text: string, clock?: StageClock) => [...matchesWhereWordsStart(text, WRITTEN_PIN_WORDS, WRITTEN_PIN_AT, clock)],
  WRITTEN_PASSWORD,
  WRITTEN_PASS,
  WRITTEN_PIN,
  nextLineValues: (text: string, clock?: StageClock) => [...nextLineValues(text, clock)],
  hasPrivateKeyArmour,
  hasRecoveryPhrase,
  hasRecoveryKey,
  firstSecretRule,
  OverBudget,
})

/** Round 10: the text joined as it comes and the shared strings, for the test that pins they hold no string each. */
export const TEXT_PIECES_FOR_TESTS = Object.freeze({ TextPieces, SharedStrings, PIECES_PER_CHUNK })

/**
 * Round 11: the header rules and the XML text reader, for the tests that pin a long cell's name, a row's budget and
 * the text read in pieces.
 */
export const HEADER_FOR_TESTS = Object.freeze({ PasswordRow, headerName, HEADER_CELL_MAX, xmlText })
/** Round 12: the relationship target's fold and its cap, for the tests. */
export const RELS_FOR_TESTS = Object.freeze({ workbookTarget, REL_TARGET_MAX, RELS_MAX, RELS_PART_MAX })
