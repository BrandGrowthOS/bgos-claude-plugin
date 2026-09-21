/**
 * Source guards over the daemon's own text, in the style of
 * test/pairing-lock-standdown.test.ts: the card's minutes come from the hook's
 * receipt and not from the moment the daemon drained the spool, and the final
 * card is read out of the pending state BEFORE the turn end clears it.
 *
 * These are scans rather than behaviour tests because server.ts is the daemon:
 * importing it starts one. What can be driven is driven, in
 * test/hook-card-clock.test.ts (the wire body) and test/hook-events.test.ts
 * (the clock on the effects). What is left here is the wiring between them,
 * and it is exactly the wiring a later refactor reverts without anyone
 * noticing, because the card still draws, just with the wrong number on it.
 *
 * Mutations these tests are proven against (task C2):
 *   - onEvent: (payload) => onHookPayload(payload)   -> the SpoolLine case red
 *   - applyHookEventToTurn(..., Date.now())          -> the receipt case red
 *   - read pending after endHookTurn(keepCard)       -> the final card case red
 *   - build the final body without the shared builder -> the one builder case red
 *   - drop startedAt from the pending assignment      -> the carry case goes red
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

// Normalised to LF the moment it is read. Every assertion below is a regex or
// index arithmetic over offsets, and this checkout has git autocrlf on: the
// same source then fails patterns that pass on CI, which is a property of the
// CHECKOUT and not of the daemon. The idiom is test/channel-transport.test.ts's.
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

test('the intake hands the spool line through, so the clock is the hook process own', () => {
  // lib/hook-intake.ts passes (payload, line) already and stage 4 dropped the
  // second argument. line.receivedAt was stamped inside the hook process;
  // Date.now() here is the moment the daemon drained the file, which idle
  // polling delays by 2 seconds and an unproven session by up to a minute.
  assert.match(server, /onEvent:\s*\(payload,\s*line\)\s*=>\s*onHookPayload\(payload,\s*line\)/)
  assert.match(server, /function onHookPayload\(\s*payload: Record<string, unknown>,\s*line\?: SpoolLine,?\s*\)/)
})

test('the turn machine is driven by the hook receipt, never by the drain clock', () => {
  const body = functionBody('function onHookPayload(')
  assert.match(body, /const receivedAt = line\?\.receivedAt \?\? Date\.now\(\)/)
  assert.match(body, /applyHookEventToTurn\(hookTurn, event, receivedAt\)/)
  assert.equal(
    /applyHookEventToTurn\([^)]*Date\.now\(\)\)/.test(server),
    false,
    'a bare Date.now() here is the drain time and the card would report it as the turn',
  )
})

test('the final card is read out of the pending state before the turn end clears it', () => {
  const body = functionBody('async function finishHookTurn(')
  const capture = body.indexOf('const pending = hookCardPending')
  // The CALL on its own line, not a mention of the name inside a comment.
  // The CALL, whatever it is handed: stage 8 gave it the keep flag, which is
  // the mapper's answer to "is a child agent still working".
  const clear = body.search(/\n\s*endHookTurn\([^)]*\)\n/)
  assert.ok(capture >= 0, 'finishHookTurn no longer captures the pending card')
  assert.ok(clear >= 0, 'finishHookTurn no longer clears the turn')
  assert.ok(
    capture < clear,
    'endHookTurn() nulls hookCardPending, so the summary fields have to be taken first',
  )
})

test('every card write goes through the one builder, coalesced or final', () => {
  // The budget and the clock conversion live in lib/hook-card-body.ts. Two
  // write paths, one builder: a body built by hand at either of them is a body
  // that ships the whole of a long turn's output on every PATCH.
  assert.match(server, /import \{[^}]*hookCardWireBody[^}]*\} from '\.\/lib\/hook-card-body\.js'/)
  assert.match(functionBody('function hookCardBody('), /return hookCardWireBody\(pending\)/)
  const writes = server.match(/writeHookCard\(chatId, cardId, hookCardBody\(pending\)\)/g) ?? []
  assert.equal(writes.length, 2, 'the coalescer and the turn end, and nothing else, write a card')
})

test('the card state carries the turn clock the mapper worked out', () => {
  const body = functionBody('function runHookEffects(')
  assert.match(body, /startedAt: effect\.startedAt/)
  assert.match(body, /finishedAt: effect\.finishedAt/)
})
