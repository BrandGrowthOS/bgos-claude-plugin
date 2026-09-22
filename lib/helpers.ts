/**
 * The child agents a turn spawns, as pure derivations (stage 8 of the BGOS
 * Mission program, task C1).
 *
 * Three small rules live here rather than inside the mapper's switch, because
 * each of them is a rule about the RUNTIME rather than about a card, and each
 * one is the difference between a helper row that tells the truth and one that
 * lies:
 *
 * 1. AN ASYNC LAUNCH IS NOT A FINISHED CALL. The Agent tool answers in a few
 *    milliseconds with `{isAsync: true, status: "async_launched", agentId}`
 *    while the child it started runs for seconds or minutes. The launch is read
 *    off the RESPONSE and never off the tool name or the event name, which is
 *    the same rule lib/tool-outcome.ts holds for a failure.
 * 2. THE QUALIFIER IS THE CHILD'S LATEST TOOL, in the card's own vocabulary
 *    ("Bash wc -l hay.txt"), so a reader of the parent's card and a reader of a
 *    row see one wording.
 * 3. A RESULT KEEPS ITS HEAD. A child's last message is an answer, and an
 *    answer's first sentence is the part worth 240 characters. Command output
 *    keeps its TAIL for the opposite reason, which is why this cut is its own
 *    function rather than a flag on that one.
 *
 * Nothing here does I/O, reads a clock or knows what a card is.
 */

/** The wire cap on a row's `result`, the backend DTO's own number. */
export const RESULT_MAX = 240

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The status string a launched child's response carries. */
export const ASYNC_LAUNCH_STATUS = 'async_launched'

/**
 * Did this tool response LAUNCH something that is still running?
 *
 * Read off the response alone. Branching on the tool name would be wrong in
 * both directions: an Agent call that returned a plain result is a finished
 * call, and any future tool that launches work in the background is not.
 */
export function isAsyncLaunch(response: unknown): boolean {
  if (!isRecord(response)) return false
  return response.isAsync === true || response.status === ASYNC_LAUNCH_STATUS
}

/**
 * The child's own id, as the launch response gives it. Empty when the response
 * carries none, which leaves the row running and untrackable rather than
 * closed: a row closed on a guess is worse than a row that is honestly open.
 */
export function launchedAgentId(response: unknown): string {
  if (!isRecord(response)) return ''
  return typeof response.agentId === 'string' ? response.agentId.trim() : ''
}

/**
 * The short line a helper row shows WHILE it works: the child's latest tool and
 * the same argument summary the child's own row carries.
 */
export function helperQualifier(toolLabel: string, argsSummary: string): string {
  const name = String(toolLabel ?? '').trim()
  const args = String(argsSummary ?? '').trim()
  if (!name) return ''
  return args ? `${name} ${args}` : name
}

/**
 * The FIRST `max` characters, with the ellipsis marking the cut and never a
 * lone high surrogate left at it. The masking runs BEFORE this, always: a cut
 * hands the scanner a value its pattern no longer matches, and the head of a
 * live key ships as plain text.
 */
export function clipResultHead(text: string, max: number = RESULT_MAX): string {
  if (typeof text !== 'string') return ''
  if (text.length <= max) return text
  let cut = text.slice(0, max - 1)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return `${cut}…`
}
