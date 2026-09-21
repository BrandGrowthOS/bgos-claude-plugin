/**
 * Capability bootstrap: pickCapabilities selects the served canon when the
 * backend response is well-formed, and falls back to the bundled copy otherwise.
 *
 * Run with: npm test  (node --test, no extra deps)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  pickCapabilities,
  BGOS_CAPABILITIES_FALLBACK,
  MAX_CAPABILITIES_BYTES,
} from '../lib/capabilities.ts'

const SERVED_TEXT =
  '# BGOS Channel Agent Capabilities\n(channel: claude, canon v2026.07.11)\n\nGuide body.'

test('uses the served canon when the response carries both markers', () => {
  const r = pickCapabilities({ text: SERVED_TEXT, version: '2026.07.11' })
  assert.equal(r.source, 'backend')
  assert.equal(r.version, '2026.07.11')
  assert.equal(r.text, SERVED_TEXT)
})

test('defaults version to "unknown" when the backend omits it', () => {
  const r = pickCapabilities({ text: SERVED_TEXT })
  assert.equal(r.source, 'backend')
  assert.equal(r.version, 'unknown')
})

test('falls back to the bundled copy on null (fetch failed)', () => {
  const r = pickCapabilities(null)
  assert.equal(r.source, 'fallback')
  assert.equal(r.version, 'bundled')
  assert.equal(r.text, BGOS_CAPABILITIES_FALLBACK)
})

test('falls back when the served canon exceeds the size cap (DoS/injection guard)', () => {
  const oversized =
    '# BGOS Channel Agent Capabilities\n' + 'x'.repeat(MAX_CAPABILITIES_BYTES + 1)
  const r = pickCapabilities({ text: oversized, version: 'evil' })
  assert.equal(r.source, 'fallback')
  assert.equal(r.text, BGOS_CAPABILITIES_FALLBACK)
  // A canon right at the cap with valid markers is still accepted.
  const marker = '# BGOS Channel Agent Capabilities\n'
  const atCap = marker + 'y'.repeat(MAX_CAPABILITIES_BYTES - marker.length)
  assert.equal(pickCapabilities({ text: atCap, version: '1' }).source, 'backend')
})

test('falls back when the response is missing the markers', () => {
  const r = pickCapabilities({ text: 'some unrelated body', version: '9' })
  assert.equal(r.source, 'fallback')
  assert.equal(r.text, BGOS_CAPABILITIES_FALLBACK)
})

test('falls back when text is not a string', () => {
  const r = pickCapabilities({ text: 123 })
  assert.equal(r.source, 'fallback')
})

test('the bundled fallback itself carries the markers (so injection guards match)', () => {
  assert.ok(BGOS_CAPABILITIES_FALLBACK.includes('BGOS Channel'))
  assert.ok(BGOS_CAPABILITIES_FALLBACK.includes('Agent Capabilities'))
})

// The Claude channel's goal lane sentence, copied BYTE FOR BYTE out of the
// served canon (backend/src/integrations/capability-canon.ts,
// CLAUDE_GOAL_LANE_SENTENCE, gated at GOAL_LANE_MIN_DAEMON.claude = 0.42.0).
// The two repositories cannot import from one another, so the only thing that
// can keep the offline copy honest is a literal it is compared against here.
const SERVED_CLAUDE_GOAL_LANE_SENTENCE =
  "- Your owner can ask you to keep working until a condition holds. Where this host can type into your session it sets a native goal for you and clears it at your owner's turn cap; where it cannot there is no switch on their side and nothing pretends otherwise. You never set a goal yourself and there is no tool for it, so do not try to type a slash command. While a goal is active a separate checker reads your work after every turn and answers met, not yet with a reason, or cannot be done with a reason, and the host posts every answer onto the mission for you: do not narrate the checks, do not argue with the checker, and never tick a mini goal because a check passed."

test('the bundled fallback carries the served goal lane sentence, word for word', () => {
  // The fetch that fails is exactly the moment the agent has no other source
  // for this: it is the one capability on this channel the model must not act
  // on by itself, because it CANNOT (there is no tool for a goal and a model
  // has no way to type a slash command), and a half remembered version of
  // that reads as permission to try.
  assert.ok(
    BGOS_CAPABILITIES_FALLBACK.includes(SERVED_CLAUDE_GOAL_LANE_SENTENCE),
    'the offline copy has drifted from the served Claude delta; copy the sentence across verbatim',
  )
})

// The Claude channel's turn summary sentence (Mission program stage 7, C-30),
// copied BYTE FOR BYTE out of the served canon
// (backend/src/integrations/capability-canon.ts, CLAUDE_TURN_SUMMARY_SENTENCE,
// gated at TURN_SUMMARY_MIN_DAEMON.claude = 0.43.0).
const SERVED_CLAUDE_TURN_SUMMARY_SENTENCE =
  "- Your tool rows now carry what your commands printed, their exit codes and your edits' line counts, and this host fills every one of them from your own hook events: it takes the output tail from the tool result, masks secrets in it, caps it, reads the exit code off the runtime's own failure line, and counts the plus and minus lines off the patch. You write none of it and you cannot add to it. So do not paste command output into your reply, do not restate an exit code or a line count in prose, and do not close a turn with a summary of what you did: the folded card already says how long the turn took, how many tools ran, how many failed and how many files changed, and saying it again reads to your owner as a second, competing answer."

test('the bundled fallback carries the served turn summary sentence, word for word', () => {
  // This one tells the model what NOT to do: the host fills the output, the
  // exit code and the line counts from the hook events, so pasting command
  // output into a reply or closing a turn with a summary of the work is a
  // second, competing answer beside the card the owner is already reading.
  assert.ok(
    BGOS_CAPABILITIES_FALLBACK.includes(SERVED_CLAUDE_TURN_SUMMARY_SENTENCE),
    'the offline copy has drifted from the served Claude delta; copy the sentence across verbatim',
  )
})

test('the fallback stays free of dashes, because it is injected into a prompt', () => {
  assert.equal(/[\u2013\u2014]/.test(BGOS_CAPABILITIES_FALLBACK), false)
})
