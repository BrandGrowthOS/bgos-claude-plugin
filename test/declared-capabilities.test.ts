/**
 * What this daemon TELLS the backend it can do.
 *
 * The declaration decides whether the owner is offered a Pause button on this
 * agent's mission card, and a button that does nothing is worse than no
 * button at all. So the one token this release must NOT declare has its own
 * assertion here, with the reason written down beside it.
 *
 * The grammar mirrors the backend's CAPABILITY_TOKEN_REGEX and @ArrayMaxSize
 * (backend/src/dto/integrations/pair-exchange.dto.ts). A token that fails
 * either is dropped or 400s at the far end, where nobody would see it.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { DECLARED_CAPABILITIES } from '../lib/declared-capabilities.ts'

/** backend/src/dto/integrations/pair-exchange.dto.ts:25 */
const CAPABILITY_TOKEN_REGEX = /^[a-z][a-z0-9_]{0,63}$/

test('every declared token matches the grammar the backend accepts', () => {
  assert.ok(Array.isArray(DECLARED_CAPABILITIES))
  assert.ok(DECLARED_CAPABILITIES.length > 0, 'declaring nothing hides every capability')
  for (const token of DECLARED_CAPABILITIES) {
    assert.match(token, CAPABILITY_TOKEN_REGEX, `"${token}" is not a legal capability token`)
  }
})

test('the list stays inside the backend ArrayMaxSize of 32', () => {
  assert.ok(DECLARED_CAPABILITIES.length <= 32)
})

test('the list is frozen, so no call site can push a token onto it at runtime', () => {
  assert.ok(Object.isFrozen(DECLARED_CAPABILITIES))
})

test('mission_events is declared: this daemon hears the owner decision and relays it', () => {
  assert.ok(DECLARED_CAPABILITIES.includes('mission_events'))
})

test('mission_pause is NOT declared, because nothing here can enforce a pause', () => {
  // Claude Code has no process-level handle on an in-flight turn: its stop is
  // cooperative (lib/voice-rpc.ts:893-905), so a Pause button on this agent
  // would lie to the owner. If a pause this daemon can actually enforce ever
  // lands, it arrives with the goal lane in stage 6 of the Mission program,
  // and THAT is when this token gets declared.
  assert.ok(!DECLARED_CAPABILITIES.includes('mission_pause'))
})

test('no token is declared twice', () => {
  assert.equal(new Set(DECLARED_CAPABILITIES).size, DECLARED_CAPABILITIES.length)
})
