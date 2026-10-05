/**
 * lib/reconnect-spread.ts: the per-process delays that keep a fleet of daemons
 * from all coming back inside one second after a backend deploy.
 *
 * WHY THIS FILE EXISTS, and it is the part worth reading. On 2026-10-05 an
 * nginx reload during a blue/green deploy dropped 123 sockets in one second,
 * 51 of them distinct agent pairings. Every daemon reconnected on the same
 * schedule into a new container whose auth cache is a process singleton, so
 * each pairing's first authenticated request paid a bcrypt cost-12 compare on
 * a two vCPU box. The backend started no request handlers for about six
 * seconds and the owner's message took about 16 seconds to appear.
 *
 * Run: npx tsx --test test/reconnect-spread.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CATCHUP_DELAY_MAX_MS,
  RECONNECT_BASE_DELAY_MAX_MS,
  RECONNECT_BASE_DELAY_MIN_MS,
  drawCatchupDelayMs,
  drawReconnectBaseDelayMs,
} from '../lib/reconnect-spread.ts'

test('the reconnect base spans the whole declared window, ends included', () => {
  assert.equal(drawReconnectBaseDelayMs(0), RECONNECT_BASE_DELAY_MIN_MS)
  assert.equal(drawReconnectBaseDelayMs(1), RECONNECT_BASE_DELAY_MAX_MS)
  assert.equal(drawReconnectBaseDelayMs(0.5), 2750)
})

test('the catch-up delay starts at zero and reaches the ceiling', () => {
  // Zero on purpose: someone has to go first, and a floor would delay every
  // daemon's recovery to buy nothing. The SPREAD is the point, not the wait.
  assert.equal(drawCatchupDelayMs(0), 0)
  assert.equal(drawCatchupDelayMs(0.999999), CATCHUP_DELAY_MAX_MS - 1)
  assert.equal(drawCatchupDelayMs(0.5), 2500)
})

/**
 * THE ASSERTION THE OLD CODE FAILS, and the only one here that is about the
 * defect rather than about arithmetic. `reconnectionDelay: 1000` gave every
 * process the same base; socket.io's default 0.5 jitter then drew it over
 * roughly 500 to 1500 ms, a window about 1 s wide. 51 daemons in a 1 s window
 * is about 50 first-requests per second against a cold cache.
 *
 * Expressed as a RATIO rather than as a number of milliseconds, because the
 * claim is "the window got materially wider", and a ratio keeps saying that if
 * the ends are ever retuned. 4x is the floor I am willing to call a fix.
 */
test('the drawn window is several times wider than the fixed base it replaces', () => {
  const OLD_BASE_MS = 1000
  const OLD_JITTER = 0.5 // socket.io-client's default randomizationFactor
  const oldWindowMs = OLD_BASE_MS * OLD_JITTER * 2 // 500 to 1500
  const newWindowMs =
    drawReconnectBaseDelayMs(1) - drawReconnectBaseDelayMs(0)

  assert.equal(oldWindowMs, 1000)
  assert.ok(
    newWindowMs >= oldWindowMs * 4,
    `the drawn window is ${newWindowMs}ms against the old ${oldWindowMs}ms; ` +
      `that is ${(newWindowMs / oldWindowMs).toFixed(1)}x and the floor is 4x`,
  )
})

/**
 * NON-VACUITY. Every test above would still pass if both functions ignored
 * their argument and returned a constant, as long as the constant happened to
 * match. These assert the output actually TRACKS the input, which is the one
 * property that makes two daemons differ.
 */
test('two different readings produce two different delays, on both draws', () => {
  assert.notEqual(drawReconnectBaseDelayMs(0.1), drawReconnectBaseDelayMs(0.9))
  assert.notEqual(drawCatchupDelayMs(0.1), drawCatchupDelayMs(0.9))
})

/**
 * A broken generator must regress to the OLD behaviour, not to something
 * worse. Collapsing to 0 would give a herd that is FASTER than the one this
 * replaces; collapsing to the ceiling would read as a hang. The midpoint is
 * the only choice that fails visibly and harmlessly.
 */
test('an unusable reading collapses to the midpoint, never to an end', () => {
  for (const bad of [NaN, Infinity, -Infinity, -0.0001, 1.0001]) {
    assert.equal(drawReconnectBaseDelayMs(bad), drawReconnectBaseDelayMs(0.5))
    assert.equal(drawCatchupDelayMs(bad), drawCatchupDelayMs(0.5))
    assert.notEqual(drawReconnectBaseDelayMs(bad), RECONNECT_BASE_DELAY_MIN_MS)
    assert.notEqual(drawReconnectBaseDelayMs(bad), RECONNECT_BASE_DELAY_MAX_MS)
  }
})

/**
 * THE WIRING, which is the half a pure-module test cannot see.
 *
 * Both functions above could be perfect and unused. The guard therefore reads
 * a SECOND source, server.ts itself, because a check derived only from the
 * module it is checking can confirm the module and nothing about the fleet.
 *
 * Comments are stripped before every match, so no assertion here can be
 * satisfied by the very prose that explains it. That is not hypothetical: two
 * guards I wrote earlier the same day passed against their own comments.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function serverSourceWithoutComments(): string {
  const raw = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'server.ts'),
    'utf8',
  )
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
  // Control: the strip must actually remove something, or every assertion
  // below is being made against the full file including its prose.
  assert.ok(
    stripped.length < raw.length,
    'comment stripping removed nothing, so these assertions are not comment-proof',
  )
  return stripped
}

test('the daemon socket takes its reconnect base from the draw, not a literal', () => {
  const src = serverSourceWithoutComments()
  assert.match(src, /reconnectionDelay: reconnectBaseMs/)
  assert.match(src, /drawReconnectBaseDelayMs\(Math\.random\(\)\)/)
  // The exact regression: a hardcoded base is what every daemon shared.
  assert.doesNotMatch(src, /reconnectionDelay: \d/)
})

test('the legacy post-reconnect catch-up is delayed, not fired at once', () => {
  const src = serverSourceWithoutComments()
  assert.match(src, /drawCatchupDelayMs\(Math\.random\(\)\)/)
  // pollAllChats must sit inside a timer on the reconnect path. The bare
  // immediate call is the shape that sent one request per monitored chat,
  // across the whole fleet, in the same instant.
  assert.match(src, /setTimeout\(\(\) => \{\s*pollAllChats\(\)/)
})
