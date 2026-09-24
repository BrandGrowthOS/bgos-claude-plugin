/**
 * The floor's evidence, made to FIT without losing what matched (0.49.0).
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
 * Plain JavaScript, node >= 18, no imports beyond the core, because the
 * floor's files are shared with the hook's bare `node` (lib/floor-state.mjs).
 */

import {
  FLOOR_SHELL_TOOLS,
  classifyCommand,
  classifyPath,
  lexShell,
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
 * @param {{ toolName: string, ruleId: string, evidence: string, max: number,
 *   measure?: (text: string) => number }} input
 * @returns {{ evidence: string, fits: boolean, compacted: boolean }}
 *   `fits`: the answer is within the limit AND the list still reads `ruleId`
 *   in it; `compacted`: words or folders were dropped.
 */
export function compactFloorEvidence({ toolName, ruleId, evidence, max, measure = byLength }) {
  const text = String(evidence ?? '')
  const name = String(toolName ?? '')
  if (measure(text) <= max) return { evidence: text, fits: true, compacted: false }
  if (FLOOR_SHELL_TOOLS.includes(name)) {
    const shortened = compactCommand(text, ruleId, max, measure)
    if (shortened !== null) return { evidence: shortened, fits: true, compacted: true }
  } else if (!name.startsWith('mcp__')) {
    const shortened = compactPath(text, ruleId, max, measure)
    if (shortened !== null) return { evidence: shortened, fits: true, compacted: true }
  }
  return { evidence: cutToFit(text, max, measure), fits: false, compacted: false }
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
 * `ruleId`, or when what the rule needs is itself over the limit.
 */
function compactCommand(text, ruleId, max, measure) {
  if (classifyCommand(text) !== ruleId) return null
  const lexed = lexShell(text)
  if (lexed.commands.length !== 1) return null
  const command = lexed.commands[0]
  const words = command.words
  if (command.writes.length > 1 || words.length < 2) return null
  const write = command.writes[0] ?? null
  const render = (dropped) => {
    const kept = []
    let run = 0
    for (let i = 0; i < words.length; i++) {
      if (dropped.has(i)) {
        run++
        continue
      }
      if (run > 0) kept.push(droppedWordsMarker(run))
      run = 0
      kept.push(words[i])
    }
    if (run > 0) kept.push(droppedWordsMarker(run))
    return write ? redirectEvidence(kept, write) : quoteWords(kept)
  }
  const holds = (dropped) => classifyCommand(render(dropped)) === ruleId
  const excess = (dropped) => measure(render(dropped)) - max
  // The program stays. Longest first, and among equals the LATER word first,
  // so the head of the command (what a person reads first) is kept longest.
  const order = []
  for (let i = 1; i < words.length; i++) order.push(i)
  order.sort((a, b) => words[b].length - words[a].length || b - a)
  const dropped = dropSome(order, (i) => words[i].length + 1, holds, excess)
  return dropped && excess(dropped) <= 0 && holds(dropped) ? render(dropped) : null
}

/** Drop middle folders of a path until it fits, keeping the rule. */
function compactPath(text, ruleId, max, measure) {
  if (classifyPath(text) !== ruleId) return null
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
  const holds = (dropped) => classifyPath(render(dropped)) === ruleId
  const excess = (dropped) => measure(render(dropped)) - max
  // Never the first part (the root, `~`, a drive) or the last (the file).
  const order = []
  for (let i = 1; i < parts.length - 1; i++) order.push(i)
  order.sort((a, b) => parts[b].length - parts[a].length || b - a)
  const dropped = dropSome(order, (i) => parts[i].length + 1, holds, excess)
  return dropped && excess(dropped) <= 0 && holds(dropped) ? render(dropped) : null
}

/**
 * Take items in `order` out, a batch at a time, until nothing is over: each
 * batch is as many as should cover what is still over, and a batch the rule
 * does not survive is halved until the one item it needs is found and kept (a
 * delta debugging search, so a long command costs a few dozen readings, not
 * one per word). Answers the set dropped, or null when nothing could be.
 */
function dropSome(order, sizeOf, holds, excess) {
  const dropped = new Set()
  const tryChunk = (chunk) => {
    if (chunk.length === 0) return
    for (const i of chunk) dropped.add(i)
    if (holds(dropped)) return
    for (const i of chunk) dropped.delete(i)
    if (chunk.length === 1) return
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
  return dropped.size > 0 ? dropped : null
}
