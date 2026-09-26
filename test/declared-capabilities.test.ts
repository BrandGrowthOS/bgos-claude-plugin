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
import {
  floorBootLine,
  floorHookPresence,
  registersFloorHook,
  type FloorHookPresenceInput,
} from '../lib/floor-hook-presence.ts'
import { ensureHookEntries } from '../lib/claude-preseed.mjs'

/** backend/src/dto/integrations/pair-exchange.dto.ts:25 */
const CAPABILITY_TOKEN_REGEX = /^[a-z][a-z0-9_]{0,63}$/

/** Every shape this daemon can be in: a host it can type into, and one it
 *  cannot (Windows, or a Mac outside tmux). */
const SHAPES = [true, false] as const

test('every declared token matches the grammar the backend accepts', () => {
  for (const canInjectGoal of SHAPES) {
    const declared = declaredCapabilities({ canInjectGoal, floorHook: true, authMode: 'pairing' })
    assert.ok(Array.isArray(declared))
    assert.ok(declared.length > 0, 'declaring nothing hides every capability')
    for (const token of declared) {
      assert.match(token, CAPABILITY_TOKEN_REGEX, `"${token}" is not a legal capability token`)
    }
  }
})

test('the list stays inside the backend ArrayMaxSize of 32', () => {
  for (const canInjectGoal of SHAPES) {
    assert.ok(declaredCapabilities({ canInjectGoal, floorHook: true, authMode: 'pairing' }).length <= 32)
  }
})

test('the base is frozen, so no call site can push a token onto it at runtime', () => {
  assert.ok(Object.isFrozen(DECLARED_CAPABILITIES_BASE))
  assert.ok(Object.isFrozen(DECLARED_CAPABILITIES_PAIRING))
})

test('mission_events is declared on every host: this daemon hears the owner decision', () => {
  for (const canInjectGoal of SHAPES) {
    assert.ok(declaredCapabilities({ canInjectGoal, floorHook: true, authMode: 'pairing' }).includes('mission_events'))
  }
})

test('mission_goal_checks is declared on every host, because the checker is the runtime own', () => {
  // Claude Code's /goal runs its checker as a session scoped Stop hook and
  // writes the verdict into the session transcript, which a file read reaches
  // on Mac, Linux and Windows alike. Reporting those verdicts needs no tmux,
  // so this token is not gated on the injector.
  for (const canInjectGoal of SHAPES) {
    assert.ok(declaredCapabilities({ canInjectGoal, floorHook: true, authMode: 'pairing' }).includes('mission_goal_checks'))
  }
})

test('the goal loop and the pause are declared ONLY where the daemon can type', () => {
  const canType = declaredCapabilities({ canInjectGoal: true, floorHook: true, authMode: 'pairing' })
  assert.ok(canType.includes('mission_goal_loop'))
  assert.ok(canType.includes('mission_pause'))
})

test('mission_set_goals is declared on every host: set_mission_goals is a plain tool call', () => {
  // A Keep working wake on a mission with NO goals asks the agent to write
  // them, and the backend only arms that wake for a daemon declaring this. The
  // tool is an HTTP write the model makes itself, so no tmux is needed.
  for (const canInjectGoal of SHAPES) {
    assert.ok(declaredCapabilities({ canInjectGoal, floorHook: true, authMode: 'pairing' }).includes('mission_set_goals'))
  }
})

test('a host that cannot type declares the READ half only', () => {
  // The Windows case, and a Mac or Linux host whose CLI is not in a tmux pane.
  // Arming a goal is the injector and nothing else, and a pause this daemon
  // enforces IS clearing the goal, so both promises are false here. An owner
  // on such an agent sees no Keep working switch and no Pause button, which is
  // the honest answer, and still sees every Last check.
  assert.deepEqual(
    [...declaredCapabilities({ canInjectGoal: false, floorHook: true, authMode: 'pairing' })],
    ['mission_events', 'mission_goal_checks', 'mission_set_goals', 'permission_card', 'plan_card', 'hard_floor'],
  )
})

/**
 * permission_card (0.49.0, the permission relay on the request rail).
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
    assert.ok(declaredCapabilities({ canInjectGoal, floorHook: true, authMode: 'pairing' }).includes('permission_card'))
  }
  assert.ok(DECLARED_CAPABILITIES_BASE.includes('permission_card'))
  assert.deepEqual(
    [...declaredCapabilities({ canInjectGoal: true, floorHook: true, authMode: 'pairing' })],
    [
      'mission_events',
      'mission_goal_checks',
      'mission_set_goals',
      'permission_card',
      'plan_card',
      'hard_floor',
      'mission_goal_loop',
      'mission_pause',
    ],
  )
})

/**
 * plan_card (0.50.0, the propose_plan tool and its card).
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
    assert.ok(declaredCapabilities({ canInjectGoal, floorHook: true, authMode: 'pairing' }).includes('plan_card'))
  }
  assert.ok(DECLARED_CAPABILITIES_BASE.includes('plan_card'))
})

/**
 * hard_floor (0.53.0, the Always ask floor: the blocking hook and the hold).
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
    const declared = declaredCapabilities({ canInjectGoal, floorHook: true, authMode: 'pairing' })
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
      const declared = declaredCapabilities({ canInjectGoal, floorHook: true, authMode })
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
    const declared = declaredCapabilities({ canInjectGoal, floorHook: true, authMode: 'apikey' })
    assert.equal(declared.includes('hard_floor'), false, 'an API key relay cannot hold a listed action')
    assert.ok(declared.includes('permission_card'))
    assert.ok(declared.includes('plan_card'))
    assert.deepEqual(
      [...declared],
      declaredCapabilities({ canInjectGoal, floorHook: true, authMode: 'pairing' }).filter((t) => t !== 'hard_floor'),
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
        declaredCapabilities({ canInjectGoal, floorHook: true, authMode }).includes('hard_floor'),
        holds,
        `${authMode}: declares hard_floor ${!holds} but the relay ${holds ? 'holds' : 'answers ' + decision.route}`,
      )
    }
  }
})

test('server.ts passes the live AUTH.mode and the boot time floor hook lookup at every declaration, never a literal', () => {
  const server = readFileSync(join(import.meta.dirname, '..', 'server.ts'), 'utf8').replace(/\r\n/g, '\n')
  const calls = server.match(/declaredCapabilities\(\{[^}]*\}\)/g) ?? []
  assert.equal(calls.length, 2, 'the canon fetch and the heartbeat, and nothing else')
  for (const call of calls) {
    assert.match(call, /authMode: AUTH\.mode \}\)$/)
    assert.match(call, /floorHook: FLOOR_HOOK\.registered,/)
  }
  // And the lookup is the real one, over the session's own folders.
  assert.match(server, /const FLOOR_HOOK: FloorHookPresence = \(\(\) => \{\n\s*try \{\n\s*return floorHookPresence\(\{/)
  assert.match(server, /folders: FLOOR_FOLDERS,/)
})

// ── hard_floor only where the floor hook is REALLY registered (review) ───────

/**
 * THE REVIEW: hard_floor was declared on every pairing whether or not the
 * session's CLI carried the blocking hook. A clone gets the entry only when a
 * launcher or bgos-agent install writes it into a settings file; an always on
 * agent installed at 0.48.0 and moved to 0.53.0 by `bgos-agent update` starts
 * `claude` from its service with 0.48.0's settings, so no request is ever
 * raised for `rm -rf` under --dangerously-skip-permissions, while the canon
 * told its agent (and the owner turned the switch on believing) a hook stops
 * it. Now the daemon looks at boot and declares only what it found.
 *
 * MUTATION PROOF (applied to lib/declared-capabilities.ts, confirmed red,
 * restored): the `&& input.floorHook === true` removed from the pairing
 * condition -> the first case below red, 1 of 19.
 */
test('a pairing whose session has no floor hook does not declare hard_floor, and keeps everything else', () => {
  for (const canInjectGoal of SHAPES) {
    const without = declaredCapabilities({ canInjectGoal, floorHook: false, authMode: 'pairing' })
    assert.equal(without.includes('hard_floor'), false)
    assert.deepEqual(
      [...without],
      declaredCapabilities({ canInjectGoal, floorHook: true, authMode: 'pairing' }).filter((t) => t !== 'hard_floor'),
    )
    const path = capabilitiesFetchPath('0.49.0', without)
    const sent = new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('capabilities')!.split(',')
    assert.equal(sent.includes('hard_floor'), false, 'nor does the canon fetch carry it')
  }
})

const memFs = (files: Record<string, string>) => ({
  readFile: (p: string) => {
    const text = files[p.replace(/\\/g, '/')]
    if (text === undefined) throw new Error(`ENOENT ${p}`)
    return text
  },
  exists: (p: string) => files[p.replace(/\\/g, '/')] !== undefined,
})
const presence = (over: Partial<FloorHookPresenceInput> & { files: Record<string, string> }) => {
  const fs = memFs(over.files)
  return floorHookPresence({
    installMethod: 'clone',
    pluginRoot: '/p',
    folders: ['/agent'],
    configDir: '/home/kc/.claude',
    env: {},
    join: (...parts: string[]) => parts.join('/'),
    ...fs,
    ...over,
  })
}

/** What the clone launchers write today (ensureHookEntries, 0.53.0), read back. */
function cloneSettings(floorHookPath?: string | null): string {
  let text = ''
  const fs = {
    readFile: () => (text ? text : null),
    writeFile: (_p: string, c: string) => {
      text = c
    },
  }
  ensureHookEntries({
    settingsPath: '/agent/.claude/settings.local.json',
    forwarderPath: '/p/bin/hoai-hook.mjs',
    floorHookPath,
    fs,
  })
  return text
}

test('the floor hook is found in the plugin\'s own hooks file on a marketplace install', () => {
  const hooksJson = readFileSync(join(import.meta.dirname, '..', 'hooks', 'hooks.json'), 'utf8')
  assert.equal(presence({ installMethod: 'marketplace', files: { '/p/hooks/hooks.json': hooksJson } }).registered, true)
  // The same file on a CLONE is never read by the CLI, so it does not count.
  assert.equal(presence({ installMethod: 'clone', files: { '/p/hooks/hooks.json': hooksJson } }).registered, false)
})

test('a clone counts only the settings entry the launchers write, and only while its script exists', () => {
  const written = cloneSettings()
  assert.match(written, /hoai-floor-hook\.mjs/)
  assert.equal(
    presence({ files: { '/agent/.claude/settings.local.json': written, '/p/bin/hoai-floor-hook.mjs': '' } }).registered,
    true,
  )
  // The script moved or was deleted: the entry runs nothing.
  assert.equal(presence({ files: { '/agent/.claude/settings.local.json': written } }).registered, false)
  // THE REVIEW'S CASE: a 0.48.0 workspace, the forwarder entries and no floor entry.
  const old = cloneSettings(null)
  assert.doesNotMatch(old, /hoai-floor-hook/)
  assert.equal(
    presence({ files: { '/agent/.claude/settings.local.json': old, '/p/bin/hoai-floor-hook.mjs': '' } }).registered,
    false,
  )
  // No settings at all.
  assert.equal(presence({ files: {} }).registered, false)
})

test('an async floor entry cannot stop anything and does not count; a user or project settings file does', () => {
  const asyncEntry = JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node', args: ['/p/bin/hoai-floor-hook.mjs'], async: true }] }] },
  })
  const syncEntry = asyncEntry.replace('"async":true', '"async":false')
  const script = { '/p/bin/hoai-floor-hook.mjs': '' }
  assert.equal(presence({ files: { '/agent/.claude/settings.local.json': asyncEntry, ...script } }).registered, false)
  assert.equal(presence({ files: { '/agent/.claude/settings.json': syncEntry, ...script } }).registered, true)
  assert.equal(presence({ files: { '/home/kc/.claude/settings.json': syncEntry, ...script } }).registered, true)
  // ${CLAUDE_PLUGIN_ROOT} is expanded only in a plugin's own hooks file.
  const variable = syncEntry.replace('/p/bin', '${CLAUDE_PLUGIN_ROOT}/bin')
  assert.equal(registersFloorHook(JSON.parse(variable), { exists: () => true, pluginRootVariable: false }), false)
  assert.equal(registersFloorHook(JSON.parse(variable), { exists: () => true, pluginRootVariable: true }), true)
})

test('a late tmux upgrade changes the answer, because it is computed per beat', () => {
  // lib/compact-capability.ts can upgrade the target up to thirty minutes
  // after boot, and the heartbeat sends a THUNK, so the same process must be
  // able to answer differently on a later beat. A frozen constant could not.
  const before = declaredCapabilities({ canInjectGoal: false, floorHook: true, authMode: 'pairing' })
  const after = declaredCapabilities({ canInjectGoal: true, floorHook: true, authMode: 'pairing' })
  assert.ok(!before.includes('mission_goal_loop'))
  assert.ok(after.includes('mission_goal_loop'))
})

// ── The boot line says what is really declared (final live proof) ───────────

/**
 * THE FINAL LIVE PROOF'S SECOND PLUGIN MINOR. The boot line depended on the
 * hook alone, so an API key daemon whose hook was found said "declaring the
 * floor capability on a pairing" while declaring nothing at all: hard_floor
 * needs a pairing as well (DECLARED_CAPABILITIES_PAIRING). Now the line reads
 * "declared" off declaredCapabilities itself, and on an API key it says
 * plainly that the floor is not declared.
 *
 * MUTATION PROOF (applied to lib/floor-hook-presence.ts, confirmed red,
 * restored): floorBootLine's `declared` replaced with `presence.registered`
 * (the old rule, the hook alone) -> the first two tests below red, 2 of 79 in
 * this run (the API key daemon with the hook said "is declared on this
 * pairing" again).
 */
test('the floor boot line says declared exactly when the declaration carries hard_floor, in every auth mode and hook state', () => {
  for (const authMode of ['pairing', 'apikey'] as const) {
    for (const registered of [true, false]) {
      const line = floorBootLine({ registered, where: '/x/hooks.json' }, authMode)
      const declared = declaredCapabilities({ canInjectGoal: false, floorHook: registered, authMode }).includes('hard_floor')
      const label = `${authMode}, hook ${registered ? 'found' : 'missing'}`
      assert.equal(/\bis declared on this pairing\b/.test(line), declared, `${label}: ${line}`)
      assert.equal(/is NOT declared/.test(line), !declared, `${label}: ${line}`)
      // It names where the hook was looked for, and whether it was found.
      assert.ok(line.includes('/x/hooks.json'), label)
      assert.equal(line.includes('hook is NOT registered'), !registered, label)
      // And never the old sentence, which claimed a declaration by the hook alone.
      assert.ok(!line.includes('declaring the floor capability'), label)
    }
  }
})

test('on an API key the boot line says plainly that the floor is not declared, and why', () => {
  const withHook = floorBootLine({ registered: true, where: 'plugin hooks.json' }, 'apikey')
  assert.match(withHook, /API key/)
  assert.match(withHook, /floor capability \(hard_floor\) is NOT declared/)
  assert.match(withHook, /not held for the owner/)
  assert.match(withHook, /Pair the agent/)
  const noHook = floorBootLine({ registered: false, where: 'no entry' }, 'apikey')
  assert.match(noHook, /API key/)
  assert.match(noHook, /is NOT declared/)
  assert.match(noHook, /pair the agent, then relaunch/)
  // A pairing with no hook still points at the launcher, as before.
  assert.match(floorBootLine({ registered: false, where: 'no entry' }, 'pairing'), /Relaunch through a launcher/)
})

test('server.ts logs the floor boot line from the live AUTH.mode and the boot time lookup', () => {
  const server = readFileSync(join(import.meta.dirname, '..', 'server.ts'), 'utf8').replace(/\r\n/g, '\n')
  assert.match(server, /log\(floorBootLine\(FLOOR_HOOK, AUTH\.mode\)\)/)
  assert.ok(!server.includes('declaring the floor capability on a pairing'), 'the hook only sentence is gone')
})
