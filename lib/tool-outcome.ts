/**
 * What a tool call actually did: its exit code, what it printed, and how many
 * lines an edit changed (stage 7 of the BGOS Mission program).
 *
 * Pure: no I/O, no clock, no network, and nothing here ever throws. Every
 * function takes the raw hook payload the forwarder spooled and answers only
 * what that payload proves. An answer it cannot prove is `null` or an absent
 * field, never a zero and never a NaN, because the card draws each part of a
 * row only where its datum exists.
 *
 * Every shape below was read off a LIVE turn on 2026-09-21, not inferred:
 * docs/reports/2026-09-21-turn-summary-card/probe/hooks.jsonl in the BGOS
 * repo, copied into test/fixtures/stage7-hooks.jsonl with the paths scrubbed.
 * Three things only that turn could settle:
 *
 *   1. A failing command arrives on PostToolUseFailure with `error` and NO
 *      `tool_response` at all. Its first line is `Exit code N` with no prefix
 *      (this machine's older transcripts carry `Error: `, so both are read),
 *      and what the command printed follows on the next lines, stdout then
 *      stderr, ALREADY MERGED by the runtime.
 *   2. A benign non zero exit is a PostToolUse SUCCESS with an empty stdout
 *      and a `returnCodeInterpretation` ("No matches found" for grep's 1).
 *      There is no code anywhere in that payload: claiming 0 would be a lie
 *      and claiming 1 a guess, so the row takes the interpretation as its
 *      short qualifier and carries no chip.
 *   3. A Write that CREATES carries `structuredPatch: []`, so its added count
 *      has to be read off `content`; an Edit carries hunks whose `lines` hold
 *      a `\ No newline at end of file` marker, which is not a removed line.
 *
 * THE CALLER OWNS THE ORDER. lib/hook-events.ts header rule 2 is redact before
 * you clip: mask with redactForWire FIRST, then clipOutputTail, and the per
 * card budget last. Clipping first can slice a token in half and hand the
 * scanner a value its pattern no longer matches, which is how a secret ships.
 */

/** The one line the runtime prints between the two streams on a SUCCESS. The
 *  app needs no second field and a reader can see where the split is. */
export const STDERR_LINE = 'stderr:'

/** `Exit code 3` (live) and `Error: Exit code 3` (older transcripts) are the
 *  same first line, so a change of mind upstream costs nothing. */
const EXIT_CODE_LINE = /^(?:Error:\s*)?Exit code (-?\d+)\b/

/** The wire's own range: minus one means killed by a signal with no code. A
 *  value outside it is dropped rather than sent, exactly as the server does. */
const EXIT_CODE_MIN = -1
const EXIT_CODE_MAX = 255

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

const firstLineOf = (text: string): string => text.split(/\r?\n/, 1)[0] ?? ''

const trimTrailingNewlines = (text: string): string => text.replace(/[\r\n]+$/, '')

/**
 * The string a failed call reported, wherever it appears. `error` is the live
 * shape; a STRING `tool_response` is the older form and the one the forwarder
 * leaves behind when it reduces an oversized payload. Neither is read off the
 * event NAME: a mapper keyed on the name is wrong in both directions, because
 * a failing command goes to PostToolUseFailure and a benign non zero exit does
 * not.
 */
function failureTextOf(raw: unknown): string | null {
  if (!isRecord(raw)) return null
  if (typeof raw.error === 'string' && raw.error !== '') return raw.error
  if (typeof raw.tool_response === 'string' && raw.tool_response !== '') return raw.tool_response
  return null
}

const responseOf = (raw: unknown): Record<string, unknown> | null => {
  if (!isRecord(raw)) return null
  return isRecord(raw.tool_response) ? raw.tool_response : null
}

/**
 * The runtime's own one line reading of a non zero exit that is not a failure,
 * for the row's `detail` slot. Empty when the runtime offered none.
 */
export function interpretationFor(raw: unknown): string {
  const response = responseOf(raw)
  if (!response) return ''
  return asString(response.returnCodeInterpretation).trim()
}

/**
 * The exit code, or null when the payload does not carry one. Three arms, in
 * this order:
 *
 *   1. a failure string whose first line is `Exit code N` gives N;
 *   2. a response carrying a returnCodeInterpretation gives NOTHING (arm 2 of
 *      the header: the interpretation goes to `detail` instead);
 *   3. a plain success response gives 0.
 *
 * Anything else, a failure whose string has no exit code line included, gives
 * null. Never a NaN: `exit NaN` on a card is worse than no chip at all.
 */
export function exitCodeFor(raw: unknown): number | null {
  const failure = failureTextOf(raw)
  if (failure !== null) {
    const match = EXIT_CODE_LINE.exec(firstLineOf(failure))
    if (!match) return null
    const code = Number(match[1])
    if (!Number.isInteger(code) || code < EXIT_CODE_MIN || code > EXIT_CODE_MAX) return null
    return code
  }
  const response = responseOf(raw)
  if (!response) return null
  if (interpretationFor(raw) !== '') return null
  if (response.interrupted === true) return null
  return 0
}

/**
 * The one output field: what the command printed, unmasked and unclipped (the
 * caller masks and clips, in that order). The two sides are NOT symmetric,
 * because the runtime is not:
 *
 *   - on a SUCCESS, stdout, then, only when stderr is not empty, a line
 *     reading exactly `stderr:` and the stderr;
 *   - on a FAILURE, the error string minus its first `Exit code N` line, with
 *     NO `stderr:` line added: the runtime already merged the two streams into
 *     that one string, so a boundary we draw would sit in the wrong place. The
 *     first line goes because the code is already on the chip.
 *
 * An interrupted command keeps what it printed, like any other.
 */
export function outputFor(raw: unknown): string {
  const failure = failureTextOf(raw)
  if (failure !== null) {
    const lines = failure.split(/\r?\n/)
    if (EXIT_CODE_LINE.test(lines[0] ?? '')) lines.shift()
    return trimTrailingNewlines(lines.join('\n'))
  }
  const response = responseOf(raw)
  if (!response) return ''
  const stdout = asString(response.stdout)
  const stderr = asString(response.stderr)
  const parts: string[] = []
  if (stdout.trim() !== '') parts.push(trimTrailingNewlines(stdout))
  if (stderr.trim() !== '') {
    parts.push(STDERR_LINE)
    parts.push(trimTrailingNewlines(stderr))
  }
  return parts.join('\n')
}

export interface EditCounts {
  linesAdded?: number
  linesRemoved?: number
}

const countContentLines = (content: string): number => {
  if (content === '') return 0
  return content.replace(/\r?\n$/, '').split(/\r?\n/).length
}

const positiveInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null

function countHunkLines(hunks: unknown[]): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0
  let linesRemoved = 0
  for (const hunk of hunks) {
    const lines = isRecord(hunk) && Array.isArray(hunk.lines) ? hunk.lines : []
    for (const entry of lines) {
      if (typeof entry !== 'string') continue
      // "\ No newline at end of file" is a marker, not a line the edit changed,
      // and the probe's one hunk Edit carried it.
      if (entry.startsWith('\\')) continue
      if (entry.startsWith('@@') || entry.startsWith('+++') || entry.startsWith('---')) continue
      if (entry.startsWith('+')) linesAdded += 1
      else if (entry.startsWith('-')) linesRemoved += 1
    }
  }
  return { linesAdded, linesRemoved }
}

/**
 * How many lines an edit added and removed, and NEVER a pair of zeroes: the
 * app draws `+0 -0` for a pair it is given, and "I do not know" is not zero.
 *
 * The hunks are the exact answer for an Edit and for a Write that UPDATES. A
 * Write that CREATES has no hunks at all, so its content is the addition. The
 * forwarder's reduced shapes (a `{ linesAdded, linesRemoved }` pair in place of
 * the hunks, a `{ lines }` count in place of the body) are read straight
 * through. Anything else, a Read included, leaves both fields absent.
 */
export function editCountsFor(raw: unknown): EditCounts {
  const response = responseOf(raw)
  if (!response) return {}

  const patch = response.structuredPatch
  if (Array.isArray(patch) && patch.length > 0) {
    const { linesAdded, linesRemoved } = countHunkLines(patch)
    if (linesAdded === 0 && linesRemoved === 0) return {}
    return { linesAdded, linesRemoved }
  }
  if (isRecord(patch)) {
    const linesAdded = positiveInt(patch.linesAdded) ?? 0
    const linesRemoved = positiveInt(patch.linesRemoved) ?? 0
    if (linesAdded === 0 && linesRemoved === 0) return {}
    return { linesAdded, linesRemoved }
  }

  // No hunks: the create arm. A Write that UPDATES never reaches this line,
  // because its patch is populated and the branch above answered it.
  const content = response.content
  if (typeof content === 'string') return { linesAdded: countContentLines(content) }
  if (isRecord(content)) {
    const lines = positiveInt(content.lines)
    if (lines !== null) return { linesAdded: lines }
  }
  return {}
}

/**
 * The TAIL of an output: the LAST maxLines lines, then, when it is still too
 * long, the LAST maxChars UTF-16 code units, dropping a leading LOW surrogate
 * so a lone half character can never reach the wire (Postgres refuses one
 * inside JSONB and would refuse the whole card with it).
 *
 * The end is the right end to keep for the same reason the 50 row cap drops
 * from the front: the end of a command's output is what the owner is looking
 * at. There is no ellipsis: the card's own footer says the output is a tail.
 */
export function clipOutputTail(text: string, maxChars: number, maxLines: number): string {
  if (typeof text !== 'string' || text === '') return ''
  const lines = text.split(/\r?\n/)
  let out = (lines.length > maxLines ? lines.slice(-maxLines) : lines).join('\n')
  if (out.length > maxChars) {
    out = out.slice(-maxChars)
    const first = out.charCodeAt(0)
    if (first >= 0xdc00 && first <= 0xdfff) out = out.slice(1)
  }
  return out
}

/**
 * The per card output budget: at most `budget` characters of `output` across
 * the whole card, spent from the END of the rows.
 *
 * The full tools array rides EVERY coalesced PATCH (one per 600 ms while a
 * turn is live) and every WS frame to every viewer of a shared agent, so a
 * turn of twenty open shell rows would otherwise ship 40 KB a second. A row
 * that loses its output keeps everything else, including its exit code; no row
 * is ever dropped by this rule, and a dropped output is invisible in the app
 * because the row simply has no chevron.
 */
export function clipCardOutput<T extends { output?: string }>(
  rows: readonly T[],
  budget: number,
): T[] {
  const out = rows.slice()
  let spent = 0
  let exhausted = false
  for (let index = rows.length - 1; index >= 0; index--) {
    const current = rows[index]
    if (!current) continue
    const text = typeof current.output === 'string' ? current.output : ''
    if (text === '') continue
    if (!exhausted && spent + text.length <= budget) {
      spent += text.length
      continue
    }
    exhausted = true
    const copy = { ...current }
    delete copy.output
    out[index] = copy
  }
  return out
}
