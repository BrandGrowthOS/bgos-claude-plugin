/**
 * What this daemon TELLS the backend it can do.
 *
 * The declaration decides which controls the owner is offered on this agent's
 * mission card, and a button that does nothing is worse than no button at all.
 * So each token has its own assertion here, with the reason written beside it,
 * and the two that depend on the HOST have a case for a host that cannot.
 *
 * The grammar mirrors the backend's CAPABILITY_TOKEN_REGEX and @ArrayMaxSize
 * (backend/src/dto/integrations/pair-exchange.dto.ts). A token that fails
 * either is dropped or 400s at the far end, where nobody would see it.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  DECLARED_CAPABILITIES_BASE,
  declaredCapabilities,
} from '../lib/declared-capabilities.ts'
import { STOP_PAUSES_MISSION } from '../lib/session-controls-contract.ts'

/** backend/src/dto/integrations/pair-exchange.dto.ts:25 */
const CAPABILITY_TOKEN_REGEX = /^[a-z][a-z0-9_]{0,63}$/

/** Every shape this daemon can be in: a host it can type into, and one it
 *  cannot (Windows, or a Mac outside tmux). */
const SHAPES = [true, false] as const

test('every declared token matches the grammar the backend accepts', () => {
  for (const canInjectGoal of SHAPES) {
    const declared = declaredCapabilities({ canInjectGoal })
    assert.ok(Array.isArray(declared))
    assert.ok(declared.length > 0, 'declaring nothing hides every capability')
    for (const token of declared) {
      assert.match(token, CAPABILITY_TOKEN_REGEX, `"${token}" is not a legal capability token`)
    }
  }
})

test('the list stays inside the backend ArrayMaxSize of 32', () => {
  for (const canInjectGoal of SHAPES) {
    assert.ok(declaredCapabilities({ canInjectGoal }).length <= 32)
  }
})

test('the base is frozen, so no call site can push a token onto it at runtime', () => {
  assert.ok(Object.isFrozen(DECLARED_CAPABILITIES_BASE))
})

test('mission_events is declared on every host: this daemon hears the owner decision', () => {
  for (const canInjectGoal of SHAPES) {
    assert.ok(declaredCapabilities({ canInjectGoal }).includes('mission_events'))
  }
})

test('mission_goal_checks is declared on every host, because the checker is the runtime own', () => {
  // Claude Code's /goal runs its checker as a session scoped Stop hook and
  // writes the verdict into the session transcript, which a file read reaches
  // on Mac, Linux and Windows alike. Reporting those verdicts needs no tmux,
  // so this token is not gated on the injector.
  for (const canInjectGoal of SHAPES) {
    assert.ok(declaredCapabilities({ canInjectGoal }).includes('mission_goal_checks'))
  }
})

test('the goal loop and the pause are declared ONLY where the daemon can type', () => {
  const canType = declaredCapabilities({ canInjectGoal: true })
  assert.ok(canType.includes('mission_goal_loop'))
  assert.ok(canType.includes('mission_pause'))
})

test('mission_set_goals is declared on every host: set_mission_goals is a plain tool call', () => {
  // A Keep working wake on a mission with NO goals asks the agent to write
  // them, and the backend only arms that wake for a daemon declaring this. The
  // tool is an HTTP write the model makes itself, so no tmux is needed.
  for (const canInjectGoal of SHAPES) {
    assert.ok(declaredCapabilities({ canInjectGoal }).includes('mission_set_goals'))
  }
})

test('a host that cannot type declares the READ half only', () => {
  // The Windows case, and a Mac or Linux host whose CLI is not in a tmux pane.
  // Arming a goal is the injector and nothing else, and a pause this daemon
  // enforces IS clearing the goal, so both promises are false here. An owner
  // on such an agent sees no Keep working switch and no Pause button, which is
  // the honest answer, and still sees every Last check.
  assert.deepEqual(
    [...declaredCapabilities({ canInjectGoal: false })],
    ['mission_events', 'mission_goal_checks', 'mission_set_goals'],
  )
})

test('no token is declared twice, on either host', () => {
  for (const canInjectGoal of SHAPES) {
    const declared = declaredCapabilities({ canInjectGoal })
    assert.equal(new Set(declared).size, declared.length)
  }
})

test('stop_pauses_mission is declared ONLY where the daemon can type, spelled by the contract file', () => {
  // P6 stage 3 (spec 4.3, D13 item 4). The token tells BGOS to serve the
  // sentence "your host also pauses the goal and the mission" to this agent,
  // so it ships only with the code that keeps it: the armed goal case
  // (lib/stop-pause.ts), which pauses on a Stop only where this daemon can
  // clear the native goal, which is where it declares mission_pause.
  assert.equal(STOP_PAUSES_MISSION, 'stop_pauses_mission')
  assert.ok(declaredCapabilities({ canInjectGoal: true }).includes(STOP_PAUSES_MISSION))
  assert.ok(!declaredCapabilities({ canInjectGoal: false }).includes(STOP_PAUSES_MISSION))
})

test('the stop pause token rides with mission_pause and nothing else, the gate the stop pause runs behind', () => {
  // server.ts stopGoalView gates the stop pause on
  // declaredCapabilities(...).includes('mission_pause'), so a daemon that
  // declared stop_pauses_mission without mission_pause would promise a pause
  // it never makes, and one declaring mission_pause without it would make a
  // pause the canon never tells its agent about.
  for (const canInjectGoal of SHAPES) {
    const declared = declaredCapabilities({ canInjectGoal })
    assert.equal(declared.includes(STOP_PAUSES_MISSION), declared.includes('mission_pause'))
  }
  assert.deepEqual(
    [...declaredCapabilities({ canInjectGoal: true })],
    [
      'mission_events',
      'mission_goal_checks',
      'mission_set_goals',
      'mission_goal_loop',
      'mission_pause',
      'stop_pauses_mission',
    ],
  )
})

test('a late tmux upgrade changes the answer, because it is computed per beat', () => {
  // lib/compact-capability.ts can upgrade the target up to thirty minutes
  // after boot, and the heartbeat sends a THUNK, so the same process must be
  // able to answer differently on a later beat. A frozen constant could not.
  const before = declaredCapabilities({ canInjectGoal: false })
  const after = declaredCapabilities({ canInjectGoal: true })
  assert.ok(!before.includes('mission_goal_loop'))
  assert.ok(after.includes('mission_goal_loop'))
})
