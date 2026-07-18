/**
 * Built-in slash-command catalog: the invariant that BGOS is never told a
 * host-only command "works" when the agent cannot actually invoke it.
 *
 * Regression guard for the dead Compact button: the BGOS context pill shows
 * its Compact action ONLY when this catalog advertises /compact. A BGOS
 * slash command reaches the model as an MCP channel event, not CLI input,
 * so the model cannot execute host-level compaction; advertising /compact
 * made the button provably do nothing (prod messages 25455/25428/24004/
 * 23196 went unanswered and uncompacted).
 *
 * Run with:  npm test      (node --test, no extra deps)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BUILTIN_COMMANDS } from '../lib/slash-catalog.ts'

test('builtin catalog does NOT advertise /compact (host-only, dead over the channel)', () => {
  assert.ok(
    !BUILTIN_COMMANDS.some((c) => c.command === '/compact'),
    '/compact must not be advertised: the agent cannot invoke host compaction from a channel event, and the BGOS Compact button gates on this entry',
  )
})

test('builtin catalog keeps its well-formed core entries', () => {
  const names = BUILTIN_COMMANDS.map((c) => c.command)
  for (const expected of ['/help', '/cost', '/status']) {
    assert.ok(names.includes(expected), `${expected} missing from catalog`)
  }
  assert.equal(new Set(names).size, names.length, 'duplicate command names')
  for (const c of BUILTIN_COMMANDS) {
    assert.match(c.command, /^\/[a-z][a-z-]*$/)
    assert.ok(c.description.length > 0)
    assert.equal(c.scope, 'all')
  }
})
