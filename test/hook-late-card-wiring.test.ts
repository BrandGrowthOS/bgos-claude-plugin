/**
 * Source guards over the daemon's own text: the card a child agent outlives
 * (stage 8 of the BGOS Mission program, task C2).
 *
 * Until this stage the daemon held ONE card id for one turn and threw it away
 * at the turn end. A helper that finished after its parent stopped therefore
 * found no id and POSTED a second card, and the owner read two cards for one
 * turn with the first stuck on running for ever. What replaces it is a small
 * map from a card's own key to the message it became, and four things that
 * have to be true around it: the turn end may not drop the entry of a card it
 * is deliberately keeping; a PATCH may not be dropped because the turn's chat
 * record went stale, since a PATCH never uses a chat; nothing may gate the
 * write back on a turn that is already over; and the intake has to keep its
 * live cadence while a child is still working.
 *
 * These are scans and not behaviour tests because server.ts IS the daemon:
 * importing it starts one. What can be driven is driven in
 * test/hook-card-clock.test.ts (the wire body) and test/hook-subagent-rows.ts
 * (the mapper's own rows). What is left here is the wiring between them, and
 * it is exactly the wiring a later refactor reverts without anyone noticing,
 * because the card still draws.
 *
 * Mutations these tests are proven against (task C2):
 *   - keep the single hookCardId                 -> the map case goes red
 *   - bail on a null chat alone                  -> the late PATCH case red
 *   - gate the write back on the turn token      -> the write back case red
 *   - delete the entry whatever the flag says    -> the keep flag case red
 *   - read pending after endHookTurn(...)        -> the capture order case red
 *   - isTurnLive: () => hookTurnLive             -> the cadence case goes red
 *   - drop cardKey from the pending assignment   -> the carry case goes red
 *   - leave the map behind at stand down         -> the stand down case red
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

// Normalised to LF the moment it is read, for the same reason
// test/hook-clock-wiring.test.ts does it: every assertion below is a regex or
// index arithmetic over offsets, and this checkout has git autocrlf on, so the
// same source fails patterns that pass on CI. That is a property of the
// CHECKOUT and not of the daemon.
const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n',
)

/** The body of one top level function, from its opening line to the closing
 *  brace in the first column. */
const functionBody = (signature: string): string => {
  const start = server.indexOf(signature)
  assert.ok(start >= 0, `server.ts no longer has ${signature}`)
  const end = server.indexOf('\n}\n', start)
  assert.ok(end > start, `could not find the end of ${signature}`)
  return server.slice(start, end)
}

/** Every offset at which a needle appears. */
const offsetsOf = (needle: string): number[] => {
  const out: number[] = []
  let at = server.indexOf(needle)
  while (at >= 0) {
    out.push(at)
    at = server.indexOf(needle, at + 1)
  }
  return out
}

test('a card is addressed through a keyed map, so a late update patches it', () => {
  // The single id was the whole defect: one turn, one card, and a child that
  // reported after the turn end had nothing to address.
  assert.equal(
    /let hookCardId: string \| null/.test(server),
    false,
    'the single card id is what made a late child post a second card',
  )
  assert.match(server, /const hookCardIds = new Map<string, string>\(\)/)
  const flush = functionBody('async function flushHookCard(): Promise<void> {')
  assert.match(flush, /hookCardIds\.get\(/, 'the flusher resolves the id through the map')
  assert.match(flush, /pending\.cardKey/, 'and it resolves it by the card key it was handed')
})

test('the write back is not gated on the turn being the one that started it', () => {
  // The card key IS the guard: a later turn has a key of its own and cannot
  // reach an older entry. A token that refused a write back after the turn
  // ended would leave a carried card unable to learn its own id, so the very
  // first POST for a card whose child outlives the turn would be forgotten.
  assert.equal(
    /hookTurnToken/.test(server),
    false,
    'the turn token guarded a write back that now has to happen after the turn',
  )
  const flush = functionBody('async function flushHookCard(): Promise<void> {')
  assert.match(flush, /rememberHookCardId\(/, 'a minted id is written back under its own key')
})

test('a pending write survives a chat record that has gone stale', () => {
  // writeHookCard's PATCH path never uses a chat id. The turn chat record is
  // dropped after fifteen minutes, and a child that runs longer than that is
  // exactly the case this lane exists for, so a bail on the chat alone would
  // throw away the update that carries the helper's result.
  const flush = functionBody('async function flushHookCard(): Promise<void> {')
  assert.match(flush, /if \(chatId === null && cardId === null\)/)
  assert.equal(
    /\n\s*if \(chatId === null\) \{\n\s*hookCardPending = null/.test(flush),
    false,
    'a bail on the chat alone drops the PATCH a long running helper needs',
  )
})

test('the turn end keeps a card whose child is still working', () => {
  const end = functionBody('function endHookTurn(')
  assert.match(server, /function endHookTurn\(keepCard: boolean\): void \{/)
  // The flag has to GUARD the forgetting, not merely be in the signature: a
  // turn end that drops every id whatever it was told is the old behaviour
  // back, and the child that reports a minute later posts a second card.
  assert.match(end, /if \(!keepCard\) \{/, 'the flag decides whether this turn keeps its card')
  const guard = end.indexOf('if (!keepCard) {')
  const drop = end.indexOf('hookCardIds.delete(')
  assert.ok(drop > guard, 'the ids are forgotten inside the guard, not beside it')
  // Every call site passes the flag. A bare call is the old behaviour back.
  assert.equal(/endHookTurn\(\)/.test(server), false, 'a bare turn end forgets the flag')
  const finish = functionBody('async function finishHookTurn(')
  assert.match(finish, /endHookTurn\(keepCard\)/)
  assert.match(server, /finishHookTurn\(effect\.keepCard\)/, 'the mapper decides, the daemon obeys')
})

test('nothing but the turn end and the bounded remember touches the map entries', () => {
  // A delete anywhere else is a card that quietly becomes unreachable, which
  // reads on screen as a second card for the same turn.
  const end = functionBody('function endHookTurn(')
  const remember = functionBody('function rememberHookCardId(')
  const endAt = server.indexOf('function endHookTurn(')
  const rememberAt = server.indexOf('function rememberHookCardId(')
  const deletes = offsetsOf('hookCardIds.delete(')
  assert.ok(deletes.length > 0, 'the turn end no longer forgets an ended turn card')
  for (const at of deletes) {
    const inEnd = at >= endAt && at < endAt + end.length
    const inRemember = at >= rememberAt && at < rememberAt + remember.length
    assert.ok(inEnd || inRemember, `a card id is deleted outside the turn end at offset ${at}`)
  }
})

test('the final card is still read out of the pending state before the turn end clears it', () => {
  // The shipped stage 7 order, restated here because this task changed the
  // line that clears it: endHookTurn nulls hookCardPending, so the summary
  // fields have to be taken first or the last card goes out without them.
  const body = functionBody('async function finishHookTurn(')
  const capture = body.indexOf('const pending = hookCardPending')
  const clear = body.search(/\n\s*endHookTurn\(keepCard\)\n/)
  assert.ok(capture >= 0, 'finishHookTurn no longer captures the pending card')
  assert.ok(clear >= 0, 'finishHookTurn no longer ends the turn')
  assert.ok(capture < clear, 'the summary fields have to be taken before they are cleared')
})

test('the intake keeps its live cadence while a child agent is still working', () => {
  // The qualifier on a running helper row arrives on the next drain. At the
  // idle cadence that is two seconds, on a row whose whole point is that it
  // moves while the owner watches it.
  assert.match(server, /isTurnLive: \(\) => hookTurnLive \|\| hookTurn\.carried !== null/)
})

test('the card state carries the key of the card it belongs to', () => {
  const body = functionBody('function runHookEffects(')
  assert.match(body, /cardKey: effect\.cardKey/)
})

test('standing down forgets the cards, the way it forgets the pending state', () => {
  const body = functionBody('function stopHookIntake(): void {')
  assert.match(body, /hookCardIds\.clear\(\)/)
})
