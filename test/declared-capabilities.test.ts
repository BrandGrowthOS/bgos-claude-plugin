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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  DECLARED_CAPABILITIES_BASE,
  DECLARED_CAPABILITIES_PAIRING,
  declaredCapabilities,
} from '../lib/declared-capabilities.ts'
import { capabilitiesFetchPath } from '../lib/capabilities.ts'
import { consultFloor, floorCheckPath } from '../lib/floor-check.ts'
import { classifyToolCall } from '../lib/hard-floor.ts'

/** backend/src/dto/integrations/pair-exchange.dto.ts:25 */
const CAPABILITY_TOKEN_REGEX = /^[a-z][a-z0-9_]{0,63}$/

/** Every shape this daemon can be in: a host it can type into, and one it
 *  cannot (Windows, or a Mac outside tmux). */
const SHAPES = [true, false] as const

test('every declared token matches the grammar the backend accepts', () => {
  for (const canInjectGoal of SHAPES) {
    const declared = declaredCapabilities({ canInjectGoal, authMode: 'pairing' })
    assert.ok(Array.isArray(declared))
    assert.ok(declared.length > 0, 'declaring nothing hides every capability')
    for (const token of declared) {
      assert.match(token, CAPABILITY_TOKEN_REGEX, `"${token}" is not a legal capability token`)
    }
  }
})

test('the list stays inside the backend ArrayMaxSize of 32', () => {
  for (const canInjectGoal of SHAPES) {
    assert.ok(declaredCapabilities({ canInjectGoal, authMode: 'pairing' }).length <= 32)
  }
})

test('the base is frozen, so no call site can push a token onto it at runtime', () => {
  assert.ok(Object.isFrozen(DECLARED_CAPABILITIES_BASE))
  assert.ok(Object.isFrozen(DECLARED_CAPABILITIES_PAIRING))
})

test('mission_events is declared on every host: this daemon hears the owner decision', () => {
  for (const canInjectGoal of SHAPES) {
    assert.ok(declaredCapabilities({ canInjectGoal, authMode: 'pairing' }).includes('mission_events'))
  }
})

test('mission_goal_checks is declared on every host, because the checker is the runtime own', () => {
  // Claude Code's /goal runs its checker as a session scoped Stop hook and
  // writes the verdict into the session transcript, which a file read reaches
  // on Mac, Linux and Windows alike. Reporting those verdicts needs no tmux,
  // so this token is not gated on the injector.
  for (const canInjectGoal of SHAPES) {
    assert.ok(declaredCapabilities({ canInjectGoal, authMode: 'pairing' }).includes('mission_goal_checks'))
  }
})

test('the goal loop and the pause are declared ONLY where the daemon can type', () => {
  const canType = declaredCapabilities({ canInjectGoal: true, authMode: 'pairing' })
  assert.ok(canType.includes('mission_goal_loop'))
  assert.ok(canType.includes('mission_pause'))
})

test('a host that cannot type declares the READ half only', () => {
  // The Windows case, and a Mac or Linux host whose CLI is not in a tmux pane.
  // Arming a goal is the injector and nothing else, and a pause this daemon
  // enforces IS clearing the goal, so both promises are false here. An owner
  // on such an agent sees no Keep working switch and no Pause button, which is
  // the honest answer, and still sees every Last check.
  assert.deepEqual(
    [...declaredCapabilities({ canInjectGoal: false, authMode: 'pairing' })],
    ['mission_events', 'mission_goal_checks', 'permission_card', 'plan_card', 'hard_floor'],
  )
})

/**
 * permission_card (0.47.0, the permission relay on the request rail).
 *
 * The BGOS canon tells an agent about the permission request card only when
 * its daemon declares this token, with no version floor (BGOS #1624), so the
 * declaration IS the gate: drop it and a daemon that posts the card is never
 * told the card exists.
 *
 * MUTATION PROOF (applied to lib/declared-capabilities.ts, confirmed red,
 * restored): removed 'permission_card' from DECLARED_CAPABILITIES_BASE ->
 * five red: this test, the read half pin above,
 * test/version-heartbeat.test.ts's "what rides the beat", and
 * test/capabilities-fetch-path.test.ts's "the daemon's own base declaration
 * reaches the fetch" and "the canon fetch at connect carries the declared
 * list".
 */
test('permission_card is declared on every host, because the relay has no platform limit', () => {
  for (const canInjectGoal of SHAPES) {
    assert.ok(declaredCapabilities({ canInjectGoal, authMode: 'pairing' }).includes('permission_card'))
  }
  assert.ok(DECLARED_CAPABILITIES_BASE.includes('permission_card'))
  assert.deepEqual(
    [...declaredCapabilities({ canInjectGoal: true, authMode: 'pairing' })],
    ['mission_events', 'mission_goal_checks', 'permission_card', 'plan_card', 'hard_floor', 'mission_goal_loop', 'mission_pause'],
  )
})

/**
 * plan_card (0.48.0, the propose_plan tool and its card).
 *
 * The BGOS canon tells an agent about propose_plan and the plan card only
 * when its daemon declares this token, with no version floor (BGOS #1624):
 * drop it and an agent that HAS the tool is never told how to use it.
 *
 * MUTATION PROOF (applied to lib/declared-capabilities.ts, confirmed red,
 * restored): removed 'plan_card' from DECLARED_CAPABILITIES_BASE -> five
 * red: this test, the read half pin above, the permission_card case's full pin,
 * test/version-heartbeat.test.ts's "what rides the beat" and
 * test/capabilities-fetch-path.test.ts's "the plan card token reaches the
 * fetch" fail.
 */
test('plan_card is declared on every host, because propose_plan is a typed tool with no platform limit', () => {
  for (const canInjectGoal of SHAPES) {
    assert.ok(declaredCapabilities({ canInjectGoal, authMode: 'pairing' }).includes('plan_card'))
  }
  assert.ok(DECLARED_CAPABILITIES_BASE.includes('plan_card'))
})

/**
 * hard_floor (0.49.0, the Always ask floor: the blocking hook and the hold).
 *
 * The promise: this daemon installs the blocking floor hook
 * (bin/hoai-floor-hook.mjs, registered in hooks/hooks.json) and holds an
 * action on the owner's Always ask list for the owner before any auto
 * approve (lib/floor-check.ts, asked by the relay first). The BGOS canon
 * tells the floor sentence only to a daemon that declares this token beside
 * permission_card (BGOS hardFloorTold), with no version floor, so the
 * declaration IS the gate. The hook ships in hooks/hooks.json on every host,
 * so the token is in the base, not the injector half.
 *
 * MUTATION PROOF (applied to lib/declared-capabilities.ts, confirmed red,
 * restored): removed HARD_FLOOR_TOKEN from DECLARED_CAPABILITIES_BASE -> five
 * red among the node files: this test, the read half pin above, the
 * permission_card case's full pin, test/capabilities-fetch-path.test.ts's
 * "the hard floor token reaches the fetch too" and
 * test/claude-capability-tokens.pin.test.ts's "this release declares
 * permission_card, plan_card and hard_floor" (test/version-heartbeat.test.ts's
 * "what rides the beat", a bun file, pins the same list).
 */
test('hard_floor is declared on every host of a pairing connection, because the hook and the hold have no platform limit', () => {
  for (const canInjectGoal of SHAPES) {
    const declared = declaredCapabilities({ canInjectGoal, authMode: 'pairing' })
    assert.ok(declared.includes('hard_floor'))
    // The canon tells the floor sentence only beside the relay it names.
    assert.ok(declared.includes('permission_card'))
  }
  assert.ok(DECLARED_CAPABILITIES_PAIRING.includes('hard_floor'))
  assert.equal(DECLARED_CAPABILITIES_BASE.includes('hard_floor'), false, 'the base is declared on API key connections too')
  // The promise is only true while the hook this token vouches for is really
  // registered as a blocking PreToolUse hook.
  const hooks = readFileSync(join(import.meta.dirname, '..', 'hooks', 'hooks.json'), 'utf8')
  assert.match(hooks, /hoai-floor-hook\.mjs/)
})

test('no token is declared twice, on either host or either connection', () => {
  for (const canInjectGoal of SHAPES) {
    for (const authMode of ['pairing', 'apikey'] as const) {
      const declared = declaredCapabilities({ canInjectGoal, authMode })
      assert.equal(new Set(declared).size, declared.length)
    }
  }
})

/**
 * hard_floor on a legacy API key connection (P2 stage 6, wave B1b Fix).
 *
 * The defect: the token sat in the base, so an API key daemon declared it
 * too. The canon fetch carries the list and the backend counts the fetch's
 * own list for a caller with no pairing, so that daemon's agent was told a
 * hook stops a listed action and the relay holds it. But the floor check
 * route is pairing scoped: floorCheckPath answers null for 'apikey',
 * consultFloor reads that as unsupported, and the relay auto approved the
 * very action the canon said it would hold.
 *
 * permission_card and plan_card do not share the flaw (the card is a POST to
 * `messages`, propose_plan a typed tool, and an API key does both), so they
 * stay declared on every connection.
 *
 * MUTATION PROOF (applied to lib/declared-capabilities.ts, confirmed red,
 * restored): declaredCapabilities spread DECLARED_CAPABILITIES_PAIRING
 * unconditionally (the authMode check removed) -> the two cases below red.
 */
test('an API key connection does not declare hard_floor, on either host, and keeps both cards', () => {
  for (const canInjectGoal of SHAPES) {
    const declared = declaredCapabilities({ canInjectGoal, authMode: 'apikey' })
    assert.equal(declared.includes('hard_floor'), false, 'an API key relay cannot hold a listed action')
    assert.ok(declared.includes('permission_card'))
    assert.ok(declared.includes('plan_card'))
    assert.deepEqual(
      [...declared],
      declaredCapabilities({ canInjectGoal, authMode: 'pairing' }).filter((t) => t !== 'hard_floor'),
    )
    // And the canon fetch at connect, which is what the backend counts for
    // a caller with no pairing, does not carry it either.
    const path = capabilitiesFetchPath('0.49.0', declared)
    const sent = new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('capabilities')!.split(',')
    assert.equal(sent.includes('hard_floor'), false)
  }
})

test('hard_floor is declared exactly where the relay can really hold a listed action', async () => {
  // The promise and the behaviour, side by side, per connection: the relay
  // holds only where there is a floor check route to ask, and it asks the
  // route only where floorCheckPath names one.
  const match = classifyToolCall('Bash', { command: 'rm -rf ~/work' })
  assert.ok(match, 'the probe command is on the list')
  for (const authMode of ['pairing', 'apikey'] as const) {
    const decision = await consultFloor({
      toolName: 'Bash',
      inputPreview: '{ "command": "rm -rf ~/work" }',
      requestId: `r-${authMode}`,
      match,
      path: floorCheckPath(authMode, 7),
      send: async () => ({ status: 200, text: JSON.stringify({ hold: true }) }),
      autoApprove: true,
    })
    const holds = decision.route === 'hold'
    for (const canInjectGoal of SHAPES) {
      assert.equal(
        declaredCapabilities({ canInjectGoal, authMode }).includes('hard_floor'),
        holds,
        `${authMode}: declares hard_floor ${!holds} but the relay ${holds ? 'holds' : 'answers ' + decision.route}`,
      )
    }
  }
})

test('server.ts passes the live AUTH.mode at every declaration, never a literal', () => {
  const server = readFileSync(join(import.meta.dirname, '..', 'server.ts'), 'utf8').replace(/\r\n/g, '\n')
  const calls = server.match(/declaredCapabilities\(\{[^}]*\}\)/g) ?? []
  assert.equal(calls.length, 2, 'the canon fetch and the heartbeat, and nothing else')
  for (const call of calls) assert.match(call, /authMode: AUTH\.mode \}\)$/)
})

test('a late tmux upgrade changes the answer, because it is computed per beat', () => {
  // lib/compact-capability.ts can upgrade the target up to thirty minutes
  // after boot, and the heartbeat sends a THUNK, so the same process must be
  // able to answer differently on a later beat. A frozen constant could not.
  const before = declaredCapabilities({ canInjectGoal: false, authMode: 'pairing' })
  const after = declaredCapabilities({ canInjectGoal: true, authMode: 'pairing' })
  assert.ok(!before.includes('mission_goal_loop'))
  assert.ok(after.includes('mission_goal_loop'))
})
