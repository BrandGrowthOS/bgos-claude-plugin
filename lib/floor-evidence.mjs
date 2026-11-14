/**
 * The floor's evidence, made to FIT without losing what matched (0.53.0).
 *
 * WHY THIS EXISTS. The evidence for a listed action is the whole simple
 * command that matched (lib/hard-floor-core.mjs), and three places have a
 * size limit for it: the floor check's body (4000 characters, the route's own
 * limit), the lead of the request card (lib/permission-relay.ts), and, before
 * this file, the hook's record. Each used to cut the text from its HEAD, and
 * the part that makes a command listed is often at its END: the redirect of
 * `echo "K=<4000 characters>" > .env`, the `--force` after three hundred
 * branch names, the `-rf` after five hundred folders, the `.git/hooks/`
 * destination of a `cp` of four hundred files. Cut from the head, the server
 * read a harmless command, answered `hold: false`, and with the owner's switch
 * ON the relay auto approved an action the switch exists to stop; and the
 * card, cut the same way, carried no command the server could stamp, so the
 * owner saw no pill, no floor line, and the rule that only a person may allow
 * it did not apply.
 *
 * WHAT IT DOES INSTEAD. It drops ARGUMENTS, never the operator: words of the
 * simple command (never its program) are taken out, longest first and from the
 * end, only while the list still reads the SAME rule in what is left, and each
 * run of dropped words is replaced by one marker word saying how many went
 * (`'...(350 more)'`), so a person reading the card sees that the list was
 * longer. Every candidate is re-read by the list itself (classifyCommand, or
 * classifyPath for an edit tool's path), so a word the rule needs (the `-u`
 * value of `sudo`, a `+main` refspec, the destination of `cp`) is kept
 * because dropping it changes the reading, not because this file knows the
 * rule. A path is shortened the same way, by its middle folders.
 *
 * WHEN IT CANNOT. An evidence whose essential words alone are over the limit
 * (a destination path of thousands of characters) comes back cut from its
 * head as before, and `fits` says so. The relay then treats a body the list
 * no longer reads as a question the server cannot answer for it
 * (lib/floor-check.ts, floorRouteFor): a `hold: false` does not auto approve
 * it, the owner is asked.
 *
 * EVERY KIND (0.87.7). A command can fall under several kinds, each matched
 * by its own simple command (an `.env` append, then `curl -T` of a key file).
 * fitFloorEvidence puts every kind's command into one text within the limit,
 * one per line, the most dangerous first: each is fitted by dropping its
 * arguments, and by shortening in its middle a word too long to keep (a
 * token, a deep path), while the list still reads ALL of that command's
 * kinds and no kind it lacks; the commands are then taken the most dangerous
 * first, each one that still fits, so one that cannot fit is left out and
 * never the ones after it. The work is counted, not timed: each command may
 * read so many characters in all (FLOOR_FIT_READ_BUDGET, shared out among
 * them), so the answer is the same on a fast machine and a slow one. The
 * relay sends that only when the server would read more kinds in it than in
 * the other ways to say it (lib/floor-check.ts, the body;
 * lib/permission-relay.ts, the card), so it never reads fewer than before.
 *
 * Plain JavaScript, node >= 18, no imports beyond the core, because the
 * floor's files are shared with the hook's bare `node` (lib/floor-state.mjs).
 */

import {
  FLOOR_EVIDENCE_SEPARATOR,
  FLOOR_SHELL_TOOLS,
  classifyCommand,
  classifyFloorAll,
  classifyPath,
  isTopFloorRuleId,
  lexShell,
  mostDangerousFirst,
  quoteWords,
  redirectEvidence,
} from './hard-floor-core.mjs'

/** The marker one run of dropped words becomes: `...(<n> more)`. */
export function droppedWordsMarker(count) {
  return `...(${count} more)`
}

/** The marker a run of dropped folders becomes. */
export const DROPPED_FOLDERS_MARKER = '...'

const byLength = (s) => String(s).length

/**
 * The evidence, within `max` as `measure` counts it, with the listed action
 * still in it.
 *
 * @param {{ toolName: string, ruleId: string, ruleIds?: readonly string[], evidence: string, max: number,
 *   measure?: (text: string) => number, budget?: number }} input
 *   `ruleIds`: more than one kind this one command must still read (a
 *   `sudo rm -rf`, a `curl -T` of a key file); without it, `ruleId` must stay
 *   the first kind it reads, as before. `budget`: how many characters the
 *   shortening may read in all (unbounded, as before, when absent).
 * @returns {{ evidence: string, fits: boolean, compacted: boolean }}
 *   `fits`: the answer is within the limit AND the list still reads `ruleId`
 *   (every one of `ruleIds`) in it; `compacted`: words or folders were dropped.
 */
export function compactFloorEvidence({ toolName, ruleId, ruleIds, evidence, max, measure = byLength, budget }) {
  const text = String(evidence ?? '')
  const name = String(toolName ?? '')
  if (measure(text) <= max) return { evidence: text, fits: true, compacted: false }
  const reads = readerFor(name, ruleId, ruleIds)
  const opts = { budget: typeof budget === 'number' ? readBudget(budget) : undefined }
  if (FLOOR_SHELL_TOOLS.includes(name)) {
    const shortened = compactCommand(text, reads, max, measure, opts)
    if (shortened !== null) return { evidence: shortened, fits: true, compacted: true }
  } else if (!name.startsWith('mcp__')) {
    const shortened = compactPath(text, reads, max, measure, opts)
    if (shortened !== null) return { evidence: shortened, fits: true, compacted: true }
  }
  return { evidence: cutToFit(text, max, measure), fits: false, compacted: false }
}

/**
 * How many characters one fitting may read in all while it shortens. The
 * relay holds the CLI while it fits, so a command of thousands of words must
 * not cost seconds; and the work is COUNTED, not timed, so the same request
 * is fitted the same way on any machine. Three quarters are shared out among
 * the commands for their smallest forms, a quarter for growing them back,
 * each command its own share, as long as its part of them, so a long one
 * cannot starve the others. Past a share, a command keeps what it has so
 * far, every step of which was read.
 */
export const FLOOR_FIT_READ_BUDGET = 1_000_000

/** Thrown inside a shortening whose reading is spent; caught where it stops. */
class FitBudgetSpent extends Error {}

/**
 * A count of characters a shortening may read: `take` charges one text and
 * throws once the count is spent (the text that crosses it is still read).
 * @param {number} chars
 */
function readBudget(chars) {
  let left = Math.max(0, chars)
  return {
    /** @param {string} text */
    take(text) {
      if (left <= 0) throw new FitBudgetSpent()
      left -= text.length
    },
    left: () => Math.max(0, left),
  }
}

/**
 * EVERY kind's command in one text within `max`, the most dangerous first
 * (0.87.7). `evidence` is the relay's (each kind's command, one per line) or
 * any text the list reads; it is read again here, each kind with its own
 * command, so the fitting needs nothing else.
 *
 *   1. it fits whole: as it is;
 *   2. every matched command, without the parts that matched nothing, fits;
 *   3. else each command is taken down to its smallest form (the words the
 *      list needs for that command's own kinds, found by reading parts of
 *      it, and a word too long to keep, a token or a deep path, shortened
 *      in its middle), and the commands are taken the most
 *      dangerous first, each one whose smallest form still fits beside those
 *      already taken: one that cannot fit is left out, never the ones after
 *      it. Then each one taken, the most dangerous first, gets back as many
 *      of its words, from its head, as the room allows.
 *
 * Every candidate is re-read by the list, which must still read EVERY kind
 * that command carries and no kind the command itself does not read, and the
 * fitting reads at most FLOOR_FIT_READ_BUDGET characters (`budget`) in all.
 *
 * @param {{ toolName: string, evidence: string, max: number, measure?: (text: string) => number, budget?: number }} input
 * @returns {{ evidence: string, parts: string[], fits: boolean, complete: boolean }}
 *   `parts`: what `evidence` joins, one per line; `fits`: within the limit
 *   and reading at least one matched command; `complete`: every kind the
 *   text read is still read.
 */
export function fitFloorEvidence({ toolName, evidence, max, measure = byLength, budget = FLOOR_FIT_READ_BUDGET }) {
  const name = String(toolName ?? '')
  const text = String(evidence ?? '')
  if (measure(text) <= max) return { evidence: text, parts: [text], fits: true, complete: true }
  const groups = floorEvidenceParts(name, text)
  if (groups.length === 0) {
    const head = cutToFit(text, max, measure)
    return { evidence: head, parts: [head], fits: false, complete: false }
  }
  const join = (parts) => parts.join(FLOOR_EVIDENCE_SEPARATOR)
  const whole = groups.map((group) => group.evidence)
  if (measure(join(whole)) <= max) return { evidence: join(whole), parts: whole, fits: true, complete: true }
  const shrinking = readBudget((budget * 3) / 4)
  const growing = readBudget(budget / 4)
  /** Each command, in turn, a share of what is left as long as its part of the commands left. */
  const shareOf = (pool, own, rest) => Math.floor((pool.left() * own.length) / Math.max(1, rest.reduce((sum, t) => sum + t.length, 0)))
  const forms = groups.map((group, i) =>
    smallestForm(name, group, spend(shrinking, shareOf(shrinking, group.evidence, whole.slice(i)))),
  )
  const smallest = forms.map((form, i) => form?.text ?? groups[i].evidence)
  /** @type {number[]} */
  const taken = []
  for (let i = 0; i < groups.length; i++) {
    if (measure(join([...taken.map((j) => smallest[j]), smallest[i]])) <= max) taken.push(i)
  }
  if (taken.length === 0) {
    const head = cutToFit(smallest[0], max, measure)
    return { evidence: head, parts: [head], fits: false, complete: false }
  }
  const parts = taken.map((i) => smallest[i])
  for (let k = 0; k < taken.length; k++) {
    const measureOne = (candidate) => measure(join(parts.map((part, j) => (j === k ? candidate : part))))
    const group = groups[taken[k]]
    if (measureOne(group.evidence) <= max) {
      parts[k] = group.evidence
      continue
    }
    const rest = taken.slice(k).map((i) => smallest[i])
    const grown = forms[taken[k]]?.grow(max, measureOne, spend(growing, shareOf(growing, smallest[taken[k]], rest))) ?? null
    if (grown !== null && measureOne(grown) <= max) parts[k] = grown
  }
  return { evidence: join(parts), parts, fits: true, complete: taken.length === groups.length }
}

/**
 * Of candidates in the order they are preferred, the one the list reads the
 * most TOP kinds in, then the most kinds, then the one that reads `lead` (the
 * request's most dangerous kind); the earlier one on a tie. What the relay
 * uses to choose between ways of saying the same request, so what it sends
 * never reads fewer kinds than any of them (the check's body, the card).
 * @template T
 * @param {readonly T[]} inOrder
 * @param {(candidate: T) => readonly { ruleId: string }[]} read
 * @param {string} [lead]
 * @returns {T}
 */
export function mostRead(inOrder, read, lead) {
  let best = inOrder[0]
  /** @type {number[]} */
  let bestScore = [-1, -1, -1]
  for (const candidate of inOrder) {
    const ids = read(candidate).map((m) => m.ruleId)
    const score = [ids.filter((id) => isTopFloorRuleId(id)).length, ids.length, lead && ids.includes(lead) ? 1 : 0]
    const better = score.findIndex((value, i) => value !== bestScore[i])
    if (better !== -1 && score[better] > bestScore[better]) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

/**
 * The matched commands of an evidence text, each once, the most dangerous
 * first, each with every kind it is the command for (its own kinds; it may
 * read more, which an earlier command already carries).
 * @param {string} toolName @param {string} evidence
 * @returns {{ evidence: string, ruleIds: string[] }[]}
 */
export function floorEvidenceParts(toolName, evidence) {
  return evidenceGroups(matchesIn(String(toolName ?? ''), String(evidence ?? '')))
}

/**
 * The kinds the list reads in an evidence text, in list order (what the
 * relay fits for; the same reading as the core's classifyToolCallAll).
 * @param {string} toolName @param {string} evidence
 * @returns {string[]}
 */
export function floorEvidenceKinds(toolName, evidence) {
  return matchesIn(String(toolName ?? ''), String(evidence ?? '')).map((m) => m.ruleId)
}

/**
 * The kinds the list reads in an evidence text, each with its own command,
 * in list order: a shell tool's text as a command, an edit tool's as its
 * path. A long text read a moment ago is not read again, so the relay's plan,
 * body and card read each long command once.
 * @param {string} toolName @param {string} evidence
 * @returns {readonly { ruleId: string, evidence: string }[]}
 */
export function floorEvidenceMatches(toolName, evidence) {
  return matchesIn(String(toolName ?? ''), String(evidence ?? ''))
}

/** The last few long texts read, so one request's plan, body and card read each once. */
const RECENT_READINGS = new Map()
const RECENT_READINGS_MAX = 16
const RECENT_READING_MIN_CHARS = 1000

/**
 * The kinds the list reads in one evidence text, each with its own command:
 * a shell tool's text as a command, any other tool's as the path it writes.
 * A long text read a moment ago is not read again (the list is a pure
 * function of the text).
 * @param {string} toolName @param {string} text
 * @returns {readonly { ruleId: string, evidence: string }[]}
 */
function matchesIn(toolName, text) {
  const shell = FLOOR_SHELL_TOOLS.includes(toolName)
  const read = () => (shell ? classifyFloorAll({ kind: 'command', command: text }) : classifyFloorAll({ kind: 'path', path: text }))
  if (text.length < RECENT_READING_MIN_CHARS) return read()
  const key = `${shell ? 'c' : 'p'}\u0000${text}`
  const known = RECENT_READINGS.get(key)
  if (known) return known
  const matches = Object.freeze(read().map((m) => Object.freeze({ ...m })))
  RECENT_READINGS.set(key, matches)
  if (RECENT_READINGS.size > RECENT_READINGS_MAX) RECENT_READINGS.delete(RECENT_READINGS.keys().next().value)
  return matches
}

/**
 * The matched commands, each once, the most dangerous first, each with every
 * kind it was the first command for.
 * @param {readonly { ruleId: string, evidence: string }[]} matches
 * @returns {{ evidence: string, ruleIds: string[] }[]}
 */
function evidenceGroups(matches) {
  /** @type {{ evidence: string, ruleIds: string[] }[]} */
  const groups = []
  /** @type {Map<string, { evidence: string, ruleIds: string[] }>} */
  const byEvidence = new Map()
  for (const match of mostDangerousFirst(matches)) {
    if (!match.evidence) continue
    let group = byEvidence.get(match.evidence)
    if (!group) {
      group = { evidence: match.evidence, ruleIds: [] }
      byEvidence.set(match.evidence, group)
      groups.push(group)
    }
    group.ruleIds.push(match.ruleId)
  }
  return groups
}

/**
 * What a single kind fitting must keep reading (compactFloorEvidence):
 * every one of `ruleIds` when there is more than one, else `ruleId` as the
 * FIRST kind, exactly as before 0.87.7.
 * @param {string} toolName @param {string} ruleId @param {readonly string[] | undefined} ruleIds
 * @returns {(text: string) => boolean}
 */
function readerFor(toolName, ruleId, ruleIds) {
  if (Array.isArray(ruleIds) && ruleIds.length > 1) return readsEvery(toolName, ruleIds)
  return FLOOR_SHELL_TOOLS.includes(toolName)
    ? (text) => classifyCommand(text) === ruleId
    : (text) => classifyPath(text) === ruleId
}

/**
 * Does the list still read EVERY one of `ruleIds` in a text? What a part of
 * a fitting of every kind must keep, even when it carries one kind: a later
 * command can read, first, a kind an earlier one carries (a second `sudo`).
 * @param {string} toolName @param {readonly string[]} ruleIds
 * @returns {(text: string) => boolean}
 */
function readsEvery(toolName, ruleIds) {
  return (text) => {
    const read = matchesIn(toolName, text).map((m) => m.ruleId)
    return ruleIds.every((id) => read.includes(id))
  }
}

/**
 * A share of a pool: a budget of `share` characters whose reading is also
 * charged to the pool.
 */
function spend(pool, share) {
  const own = readBudget(share)
  return {
    /** @param {string} text */
    take(text) {
      own.take(text)
      pool.take(text)
    },
    left: () => Math.min(own.left(), pool.left()),
  }
}

/**
 * One matched command at its smallest (`text`), with a way to grow it back
 * toward a limit (`grow`), while the list still reads every kind it carries
 * and no kind the command itself does not read. Null when nothing could go,
 * or its share of the reading was spent before anything did.
 * @returns {{ text: string, grow: (max: number, measure: (text: string) => number, budget: ReturnType<typeof readBudget>) => string | null } | null}
 */
function smallestForm(toolName, group, budget) {
  try {
    // The same reading as the shortening's first, which is charged for it.
    const allowed = new Set(matchesIn(toolName, group.evidence).map((m) => m.ruleId))
    const reads = readsWithin(toolName, group.ruleIds, allowed)
    if (FLOOR_SHELL_TOOLS.includes(toolName)) {
      const eachKind = group.ruleIds.map((id) => (/** @type {string} */ text) => matchesIn(toolName, text).some((m) => m.ruleId === id))
      return commandForm(group.evidence, reads, budget, eachKind)
    }
    const text = shrinkPath(group.evidence, reads, 0, byLength, { budget })
    if (text === null) return null
    return { text, grow: (max, measure, more) => budgeted(() => shrinkPath(group.evidence, reads, max, measure, { budget: more })) }
  } catch (error) {
    if (error instanceof FitBudgetSpent) return null
    throw error
  }
}

/**
 * Does the list read every one of `ruleIds` in a text, and nothing outside
 * `allowed`? What a shortened command must keep: its own kinds, and no kind
 * a shortening made up (two word ends joined into a key's shape).
 * @param {string} toolName @param {readonly string[]} ruleIds @param {ReadonlySet<string>} allowed
 * @returns {(text: string) => boolean}
 */
function readsWithin(toolName, ruleIds, allowed) {
  return (text) => {
    const read = matchesIn(toolName, text).map((m) => m.ruleId)
    return ruleIds.every((id) => read.includes(id)) && read.every((id) => allowed.has(id))
  }
}

/** The longest head of `text` within `max` (the old behaviour, the last resort). */
function cutToFit(text, max, measure) {
  if (measure(text) <= max) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(text.slice(0, mid)) <= max) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo)
}

/**
 * Drop words from one simple command until it fits, keeping the rule.
 * Null when the evidence is not one simple command the list reads as
 * `reads` wants, or when what the rule needs is itself over the limit.
 */
function compactCommand(text, reads, max, measure, opts = {}) {
  const shrunk = budgeted(() => shrinkCommand(text, reads, max, measure, opts))
  return shrunk !== null && measure(shrunk) <= max ? shrunk : null
}

/** A shortening's answer, or null when its reading was spent before it began. */
function budgeted(shorten) {
  try {
    return shorten()
  } catch (error) {
    if (error instanceof FitBudgetSpent) return null
    throw error
  }
}

/** A command of more words than twice this tries, first, keeping only this many at each end. */
const ENDS_KEPT = 24
/** A word longer than this may be shortened in its middle (a fitting of every kind only). */
const LONG_WORD = 100
/** How many of a command's longest words one shortening tries. */
const LONG_WORDS_TRIED = 8
/** What a long word keeps of each end. */
const WORD_END = 40
/** What a long run of letters and digits inside a word keeps of each end. */
const RUN_END = 24

/**
 * A long word's shorter forms: first its head and its end around a visible
 * `...`, the shorter first; then every long run of letters and digits in it
 * (a token's parts, a folder name of thousands of letters) kept at its two
 * ends, so a key's shape and a path's last parts still read where the `...`
 * form does not.
 * @param {string} word
 * @returns {string[]}
 */
function shorterWords(word) {
  const runs = word.replace(/[A-Za-z0-9_=-]{65,}/g, (run) => `${run.slice(0, RUN_END)}${run.slice(-RUN_END)}`)
  const cut = (text) => (text.length > 2 * WORD_END + 3 ? `${text.slice(0, WORD_END)}...${text.slice(-WORD_END)}` : null)
  const marked = [cut(runs), cut(word)].filter((form) => form !== null && form.length < word.length).sort((a, b) => a.length - b.length)
  const forms = [...marked, runs !== word ? runs : null].filter((form) => form !== null && form.length < word.length)
  return [...new Set(forms)]
}

/**
 * Drop words from one simple command, longest first, until it is within
 * `max` or nothing more can go, keeping what `reads` wants. Null when the
 * evidence is not one simple command `reads` accepts, or nothing could go.
 * `opts.budget` counts what is read (readBudget): once it is spent the
 * dropping stops where it is, and every step it kept was read.
 */
function shrinkCommand(text, reads, max, measure, opts = {}) {
  const command = oneCommand(text, reads, opts.budget ?? null)
  if (command === null || command.words.length < 2) return null
  const { words, render, holds } = command
  const excess = (dropped) => measure(render(dropped)) - max
  // The program stays. Longest first, and among equals the LATER word first,
  // so the head of the command (what a person reads first) is kept longest.
  const order = []
  for (let i = 1; i < words.length; i++) order.push(i)
  order.sort((a, b) => words[b].length - words[a].length || b - a)
  const dropped = new Set()
  try {
    dropSome(order, (i) => words[i].length + 1, holds, excess, dropped)
  } catch (error) {
    // Its share of the reading is spent: stop here, with what was read.
    if (!(error instanceof FitBudgetSpent)) throw error
  }
  return dropped.size > 0 ? render(dropped) : null
}

/**
 * One simple command the list reads as `reads` wants, as its words, a way to
 * render it with some words dropped (each run of them one marker word) and
 * with some shown shorter (`shown`), and a reading of that (`holds`, or
 * `holdsFor` another test of the text). Null when the text is not one simple
 * command `reads` accepts.
 */
function oneCommand(text, reads, budget) {
  /** @param {string} candidate @param {(text: string) => boolean} test */
  const readAs = (candidate, test) => {
    budget?.take(candidate)
    return test(candidate)
  }
  if (!readAs(text, reads)) return null
  const lexed = lexShell(text)
  if (lexed.commands.length !== 1) return null
  const command = lexed.commands[0]
  const words = command.words
  if (command.writes.length > 1 || words.length === 0) return null
  const write = command.writes[0] ?? null
  const shown = [...words]
  /** @param {ReadonlySet<number>} dropped */
  const render = (dropped) => {
    const kept = []
    let run = 0
    for (let i = 0; i < shown.length; i++) {
      if (dropped.has(i)) {
        run++
        continue
      }
      if (run > 0) kept.push(droppedWordsMarker(run))
      run = 0
      kept.push(shown[i])
    }
    if (run > 0) kept.push(droppedWordsMarker(run))
    return write ? redirectEvidence(kept, write) : quoteWords(kept)
  }
  /** @param {(text: string) => boolean} test */
  const holdsFor = (test) => (/** @type {ReadonlySet<number>} */ dropped) => readAs(render(dropped), test)
  const holds = holdsFor(reads)
  return { words, shown, render, holds, holdsFor }
}

/**
 * EVERY KIND'S FITTING of one simple command: its smallest form, and a way to
 * grow it back toward a limit.
 *
 * Every word too long to keep whole (over LONG_WORD) is first shown shortened
 * in its middle, all at once, when the command still reads as it must so: the
 * readings after that never carry such a word.
 *
 * The smallest form keeps the program and the words the list needs. It first
 * keeps only the program and the words at each end (a command's flags and
 * its destination are usually there); when that does not read, the words the
 * list needs are looked for in the middle half by half, each half read with
 * the ends alone, and when the words needed are on both sides, kind by kind
 * (neededAmong). A reading is of the ends and part of the middle, so it is
 * shorter than the command, and the readings in all come to a few times its
 * length. What is kept is then dropped down further where the list allows,
 * and a word too long to keep whole and too needed to drop (a token, a key
 * file at the end of a deep path; the program too when it is the command's
 * one word, a key on a line of its own) is shortened in its middle.
 *
 * `grow` puts back the dropped words from the head of the command, as many as
 * the limit allows and the list still reads as it must, halving the count
 * until it does. Every step of either is read; the budget only stops one
 * early, at the last step read. `eachKind`: a test of the text for each kind
 * the command carries.
 */
function commandForm(text, reads, budget, eachKind = []) {
  const command = oneCommand(text, reads, budget)
  if (command === null) return null
  const { words, shown, render, holds, holdsFor } = command
  const n = words.length
  const all = Array.from({ length: n }, (_, i) => i)
  /** @param {Iterable<number>} kept */
  const droppedFrom = (kept) => {
    const keep = new Set(kept)
    return new Set(all.filter((i) => !keep.has(i)))
  }
  const holdsKept = (kept) => holds(droppedFrom(kept))
  const kindsKept = eachKind.map((test) => {
    const holdsKind = holdsFor(test)
    return (/** @type {Iterable<number>} */ kept) => holdsKind(droppedFrom(kept))
  })
  /** @type {Set<number>} */
  let kept = new Set(all)
  let changed = false
  try {
    const long = all.filter((i) => (i > 0 || n === 1) && words[i].length > LONG_WORD)
    if (long.length > 0) {
      for (const i of long) shown[i] = shorterWords(words[i])[0] ?? words[i]
      let held = false
      try {
        held = holds(new Set())
      } finally {
        if (!held) for (const i of long) shown[i] = words[i]
      }
      if (held) changed = true
    }
    const ends = new Set(all.filter((i) => i === 0 || i <= ENDS_KEPT || i >= n - ENDS_KEPT))
    if (ends.size < n) {
      const middle = all.filter((i) => !ends.has(i))
      if (holdsKept(ends)) {
        kept = ends
        changed = true
      } else {
        const needed = neededAmong(ends, middle, holdsKept, kindsKept)
        const found = new Set([...ends, ...needed])
        if (found.size < n && holdsKept(found)) {
          kept = found
          changed = true
        }
      }
    }
    // Then drop what else can go, all at once, then half by half, the later words first.
    const dropped = droppedFrom(kept)
    const order = [...kept].filter((i) => i !== 0).sort((a, b) => b - a)
    const before = dropped.size
    dropSome(order, (i) => words[i].length + 1, holds, () => Number.POSITIVE_INFINITY, dropped)
    if (dropped.size > before) changed = true
    kept = new Set(all.filter((i) => !dropped.has(i)))
    // And shorten a word too long to keep whole, when not already.
    const longKept = [...kept].filter((i) => (i > 0 || n === 1) && words[i].length > LONG_WORD && shown[i] === words[i])
    longKept.sort((a, b) => words[b].length - words[a].length || b - a)
    for (const i of longKept.slice(0, LONG_WORDS_TRIED)) {
      for (const form of shorterWords(words[i])) {
        shown[i] = form
        let held = false
        try {
          held = holds(dropped)
        } finally {
          if (!held) shown[i] = words[i]
        }
        if (held) {
          changed = true
          break
        }
      }
    }
  } catch (error) {
    // Its share of the reading is spent: stop here, with what was read.
    if (!(error instanceof FitBudgetSpent)) throw error
  }
  if (!changed) return null
  const smallest = new Set(kept)
  const short = [...shown]
  return {
    text: render(droppedFrom(smallest)),
    /**
     * @param {number} max @param {(text: string) => number} measure
     * @param {ReturnType<typeof readBudget>} more
     */
    grow(max, measure, more) {
      for (let i = 0; i < n; i++) shown[i] = short[i]
      const back = all.filter((i) => !smallest.has(i))
      const keptWith = (count) => droppedFrom([...smallest, ...back.slice(0, count)])
      if (measure(render(keptWith(0))) > max) return null
      let lo = 0
      let hi = back.length
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        if (measure(render(keptWith(mid))) <= max) lo = mid
        else hi = mid - 1
      }
      try {
        for (let count = lo; count > 0; count = Math.floor(count / 2)) {
          more.take(render(keptWith(count)))
          if (reads(render(keptWith(count)))) return render(keptWith(count))
        }
      } catch (error) {
        if (!(error instanceof FitBudgetSpent)) throw error
      }
      return render(keptWith(0))
    },
  }
}

/**
 * The fewest words of `among` (in order) that, kept beside `base`, the list
 * still reads as it must, found half by half: a half that reads with `base`
 * alone is searched on its own. When neither does, the words needed are on
 * both sides; each kind's own words are often in one place (a flag here, a
 * key file there), so they are looked for kind by kind (`eachKind`, a test
 * for each kind), each kind's search again half by half. Only when that does
 * not read either is each half searched with the other kept whole, which
 * reads far more. `holdsKept(base, among)` is taken to hold.
 * @param {ReadonlySet<number>} base @param {readonly number[]} among
 * @param {(kept: Iterable<number>) => boolean} holdsKept
 * @param {readonly ((kept: Iterable<number>) => boolean)[]} [eachKind]
 * @returns {number[]}
 */
function neededAmong(base, among, holdsKept, eachKind = []) {
  if (among.length <= 1) return [...among]
  const mid = among.length >> 1
  const a = among.slice(0, mid)
  const b = among.slice(mid)
  if (holdsKept([...base, ...a])) return neededAmong(base, a, holdsKept, eachKind)
  if (holdsKept([...base, ...b])) return neededAmong(base, b, holdsKept, eachKind)
  if (eachKind.length > 1) {
    /** @type {number[]} */
    const found = []
    for (const holdsKind of eachKind) {
      const have = new Set([...base, ...found])
      if (holdsKind(have)) continue
      found.push(...neededAmong(have, among.filter((i) => !have.has(i)), holdsKind))
    }
    found.sort((x, y) => x - y)
    if (holdsKept([...base, ...found])) return found
  }
  const fromA = neededAmong(new Set([...base, ...b]), a, holdsKept)
  const fromB = neededAmong(new Set([...base, ...fromA]), b, holdsKept)
  return [...fromA, ...fromB]
}

/** Drop middle folders of a path until it fits, keeping the rule. */
function compactPath(text, reads, max, measure, opts = {}) {
  const shrunk = budgeted(() => shrinkPath(text, reads, max, measure, opts))
  return shrunk !== null && measure(shrunk) <= max ? shrunk : null
}

/** Drop middle folders of a path, longest first, until it is within `max` or none can go. */
function shrinkPath(text, reads, max, measure, opts = {}) {
  const budget = opts.budget ?? null
  const read = (candidate) => {
    budget?.take(candidate)
    return reads(candidate)
  }
  if (!read(text)) return null
  const separator = text.includes('/') ? '/' : '\\'
  const parts = text.split(separator)
  if (parts.length < 3) return null
  const render = (dropped) => {
    const kept = []
    let inRun = false
    for (let i = 0; i < parts.length; i++) {
      if (dropped.has(i)) {
        if (!inRun) kept.push(DROPPED_FOLDERS_MARKER)
        inRun = true
        continue
      }
      inRun = false
      kept.push(parts[i])
    }
    return kept.join(separator)
  }
  const holds = (dropped) => read(render(dropped))
  const excess = (dropped) => measure(render(dropped)) - max
  // Never the first part (the root, `~`, a drive) or the last (the file).
  const order = []
  for (let i = 1; i < parts.length - 1; i++) order.push(i)
  order.sort((a, b) => parts[b].length - parts[a].length || b - a)
  const dropped = new Set()
  try {
    dropSome(order, (i) => parts[i].length + 1, holds, excess, dropped)
  } catch (error) {
    if (!(error instanceof FitBudgetSpent)) throw error
  }
  return dropped.size > 0 ? render(dropped) : null
}

/**
 * Take items in `order` out of `dropped`'s complement, a batch at a time,
 * until nothing is over: each batch is as many as should cover what is still
 * over, and a batch the rule does not survive is halved until the one item
 * it needs is found and kept (a delta debugging search, so a long command
 * costs a few dozen readings, not one per word). `dropped` only ever holds a
 * set the rule was read to survive, even when a reading throws.
 */
function dropSome(order, sizeOf, holds, excess, dropped) {
  const tryChunk = (chunk) => {
    if (chunk.length === 0) return
    for (const i of chunk) dropped.add(i)
    let held = false
    try {
      held = holds(dropped)
    } finally {
      if (!held) for (const i of chunk) dropped.delete(i)
    }
    if (held || chunk.length === 1) return
    const mid = chunk.length >> 1
    tryChunk(chunk.slice(0, mid))
    if (excess(dropped) <= 0) return
    tryChunk(chunk.slice(mid))
  }
  let next = 0
  let over = excess(dropped)
  while (next < order.length && over > 0) {
    const batch = []
    let covered = 0
    while (next < order.length && (covered < over || batch.length === 0)) {
      covered += sizeOf(order[next])
      batch.push(order[next])
      next++
    }
    tryChunk(batch)
    over = excess(dropped)
  }
}
