/**
 * Source guard: the mission listener is wired the way the two neighbouring
 * guards can still see.
 *
 * Three separate traps live here, and every one of them ships GREEN if it is
 * not pinned:
 *
 * 1. `test/pairing-lock-standdown.test.ts` counts handlers by matching a
 *    LITERAL single-quoted frame name inside `realtimeSocket.on(`. A loop such
 *    as `for (const f of MISSION_FRAMES) realtimeSocket.on(f, whenArmed(f, h))`
 *    matches neither of its two patterns, never enters `registered`, and ships
 *    an UNGATED handler with that whole suite green. So: eight literal
 *    registrations, and no `realtimeSocket.on(` anywhere may take a variable.
 * 2. Every handler body must open with the drain guard, like its neighbours.
 *    A daemon draining for an update must not act on a frame it is about to
 *    hand to its successor.
 * 3. The agent's own mission writes must be stamped, or the daemon narrates
 *    the model's own write back to it on every tick, forever. A FOURTH mission
 *    tool added later must not be able to forget the stamp quietly, so the
 *    stamp is asserted per tool case rather than once.
 *
 * The repo idiom for a source scan: read through an import.meta.url URL (it
 * resolves identically under bun and under the tsx runner) and normalise CRLF
 * to LF first, so the assertions describe the code and not the checkout.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/**
 * Every tool case in server.ts, as { name, body }, derived from the source
 * rather than listed.
 *
 * THE LISTS THIS REPLACES WERE THE DEFECT. Four separate tests named
 * create_mission, tick_mini_goal, complete_mission and set_mission_goals as
 * literals, so the "a FOURTH mission tool must not forget the stamp quietly"
 * promise in this file's own header was not kept: a fifth and a sixth
 * (add_mission_goals, cancel_mission_goal) were added and every one of those
 * tests stayed green while neither was checked at all. A literal scope list
 * always passes the case it guards.
 */
function toolCases(): Array<{ name: string; body: string }> {
  // ONLY the tool dispatch switch. server.ts holds several switches and one of
  // the others dispatches WS frames, whose `goal_cleared` case builds a mission
  // too, so a scan of the whole file collects frames as if they were tools and
  // then looks for a tool declaration that does not exist.
  const switchAt = server.indexOf('switch (req.params.name) {')
  assert.ok(switchAt > 0, 'the tool dispatch switch must be findable')
  const switchEnd = server.indexOf('\n    default:', switchAt)
  assert.ok(switchEnd > switchAt, 'the tool switch must have a default')
  const dispatch = server.slice(switchAt, switchEnd)

  const out: Array<{ name: string; body: string }> = []
  for (const m of dispatch.matchAll(/\n    case '([a-z_]+)': \{/g)) {
    const start = m.index as number
    // The last case of the switch ends at the switch, not 6000 characters
    // later: an unbounded slice is how `show_component` first appeared to build
    // a mission and to require chat_id, on a body that was not its own.
    const nextCase = dispatch.indexOf("\n    case '", start + 10)
    const end = nextCase > 0 ? nextCase : dispatch.length
    out.push({ name: m[1] as string, body: dispatch.slice(start, end) })
  }
  return out
}

/**
 * The mission tools: every case that builds a mission path or body.
 *
 * NOT "every case that calls resolveMissionToolChat", which was the first
 * derivation I tried and which over-collected: `show_component` resolves a
 * mission chat too, and it legitimately REQUIRES chat_id, so three tests here
 * failed on it. The build helpers are the thing only a mission tool touches.
 */
function missionToolCases(): Array<{ name: string; body: string }> {
  return toolCases().filter((c) => /buildMission[A-Za-z]*\(/.test(c.body))
}

/**
 * The mission tools that write a mission that ALREADY exists, which is the set
 * that can lose the stamp race. Derived by "it resolves an existing mission
 * id", which is exactly what create_mission does not do.
 */
function missionWriteCases(): Array<{ name: string; body: string }> {
  return missionToolCases().filter((c) => c.body.includes('resolveMissionId('))
}

test('the derived tool-case scan can actually see the cases (control for every derived test below)', () => {
  // Without this, a regex that matched nothing would make every derived test
  // below vacuously green, which is the failure the lists at least could not
  // have. Both counts are floors, not equalities, so adding a tool is not a
  // test change.
  const mission = missionToolCases().map((c) => c.name)
  const writes = missionWriteCases().map((c) => c.name)
  assert.ok(toolCases().length > 20, `tool-case scan found only ${toolCases().length}`)
  for (const known of [
    'create_mission',
    'tick_mini_goal',
    'complete_mission',
    'set_mission_goals',
    'add_mission_goals',
    'cancel_mission_goal',
  ]) {
    assert.ok(mission.includes(known), `${known} missing from the derived mission set`)
  }
  assert.ok(!writes.includes('create_mission'), 'create_mission has no mission to resolve')
  assert.ok(writes.length >= 5, `only ${writes.length} mission-write cases derived`)
})

const MISSION_FRAMES = [
  'mission_created',
  'mission_ticked',
  'mission_paused',
  'mission_resumed',
  'mission_completed',
  'mission_abandoned',
  'mission_failed',
  'mission_updated',
]

test('all eight mission frames are registered as literals, through the stand-down gate', () => {
  for (const frame of MISSION_FRAMES) {
    assert.match(
      server,
      new RegExp(`realtimeSocket\\.on\\('${frame}', whenArmed\\('${frame}',`),
      `${frame} must be registered literally and through whenArmed`,
    )
  }
})

test('no socket registration anywhere takes a variable frame name', () => {
  // The counting guard in pairing-lock-standdown.test.ts can only see literals,
  // so a single variable registration would make that guard blind.
  const all = [...server.matchAll(/realtimeSocket\.on\(/g)].length
  const literal = [...server.matchAll(/realtimeSocket\.on\('[A-Za-z0-9_]+'/g)].length
  assert.equal(
    all,
    literal,
    'a realtimeSocket.on(...) call uses a variable frame name; the stand-down counting guard cannot see it',
  )
})

test('every mission handler opens with the update drain guard', () => {
  for (const frame of MISSION_FRAMES) {
    const at = server.indexOf(`realtimeSocket.on('${frame}', whenArmed('${frame}',`)
    assert.ok(at > 0, `${frame} is not registered`)
    const head = server.slice(at, at + 220)
    assert.ok(
      head.includes('if (updateDrainMode) return'),
      `${frame}'s handler must open with the drain guard, like its neighbours`,
    )
  }
})

test('every mission handler hands the frame to the one function that cannot throw', () => {
  for (const frame of MISSION_FRAMES) {
    const at = server.indexOf(`realtimeSocket.on('${frame}', whenArmed('${frame}',`)
    const head = server.slice(at, at + 300)
    assert.ok(
      head.includes(`handleMissionEvent('${frame}'`),
      `${frame} must go through handleMissionEvent`,
    )
  }
  assert.match(server, /function handleMissionEvent\(/)
})

test('each mission tool case stamps its own write, so the echo can never start', () => {
  for (const c of missionToolCases()) {
    assert.ok(
      c.body.includes('rememberMissionSelfWrite('),
      `${c.name} must stamp its own write, or the daemon narrates the model's own write back to it`,
    )
  }
})

test('the writing tools stamp the mission BEFORE the request, not after the answer', () => {
  // The backend emits the WS frame from inside the transaction it answers the
  // HTTP call from, so the frame regularly arrives while the daemon is still
  // awaiting its response. Stamping only the response loses that race, and the
  // model is told its owner marked done the mission it had just ticked shut.
  // An explicit mission_id is not required for the stamp: both tools resolve a
  // mission id before they write, which is exactly what the stamp is keyed on.
  for (const c of missionWriteCases()) {
    const { name: tool, body: bodyText } = c
    const stamp = bodyText.indexOf('noteMissionPendingSelfWrite(')
    // Every verb a mission write can use. Naming only Patch and Put here was
    // the same literal-list defect: a tool writing by POST or DELETE would
    // have found no request at all and failed on a confusing message, or worse,
    // passed once the search was widened without the ordering being checked.
    const request = bodyText.search(/await bgos(Patch|Put|Post|Delete)\(/)
    assert.ok(stamp > 0, `${tool} must stamp the mission before it writes it`)
    assert.ok(request > 0, `${tool} request call not found`)
    assert.ok(
      stamp < request,
      `${tool} stamps its write AFTER the request; the frame can arrive first`,
    )
    assert.ok(
      bodyText.includes('rememberMissionSelfWrite('),
      `${tool} must still stamp the landed write, which is what covers a late frame`,
    )
  }
})

test('the mission listener asks the ledger, so both stamps are consulted on one line', () => {
  const start = server.indexOf('function handleMissionEvent(')
  assert.ok(start > 0)
  const end = server.indexOf('\n}', start)
  const bodyText = server.slice(start, end)
  assert.ok(
    bodyText.includes('missionSelfWrites.isSelfAuthored(event)'),
    'handleMissionEvent must consult the ledger, which reads the pending stamp and the landed one',
  )
})

test('missionChatId reads the mission first and falls back to the first monitored chat LAST', () => {
  const start = server.indexOf('function missionChatId(')
  assert.ok(start > 0, 'missionChatId must exist: a mission event is about a mission, not about a turn')
  const end = server.indexOf('\n}', start)
  const body = server.slice(start, end)

  const fromMission = body.indexOf('chatId')
  const fromTurn = body.indexOf('turnChat.current(')
  const fromFirst = body.indexOf('monitoredChatIds[0]')
  assert.ok(fromMission > 0, 'the mission own chat must be the first source')
  assert.ok(fromTurn > fromMission, 'the turn chat must come after the mission own chat')
  assert.ok(
    fromFirst > fromTurn,
    'monitoredChatIds[0] is a GUESS on a multi-chat agent and must be the last resort only',
  )
  // This once read `server.includes('missionChatId(')`, which matched the
  // definition line the test had just located, so it stayed green with every
  // call site deleted. Count the occurrences that are NOT the definition.
  const definedAt = server.indexOf('function missionChatId(') + 'function '.length
  const callSites = [...server.matchAll(/\bmissionChatId\(/g)].filter(
    (m) => m.index !== definedAt,
  ).length
  assert.ok(
    callSites > 0,
    'missionChatId must actually be called, not merely defined',
  )
})

test('the implicit mission chat goes through the pure rule, never straight to the first chat', () => {
  // A mission create the backend refuses is a 400 the agent cannot act on, so
  // the two implicit sources must skip a room and a chat whose last inbound
  // came from somebody other than the owner. The rule lives in
  // lib/missions.ts, where it is unit tested; this keeps the wiring honest.
  const start = server.indexOf('function resolveMissionToolChat(')
  assert.ok(start > 0, 'resolveMissionToolChat must exist')
  const end = server.indexOf('\n}', start)
  const bodyText = server.slice(start, end)
  assert.ok(
    bodyText.includes('pickImplicitMissionChat('),
    'the implicit chat must come from the pure rule, not from an inline guess',
  )
  assert.ok(bodyText.includes('isRoom:'), 'the rule must be told which chats are rooms')
  assert.ok(
    bodyText.includes('lastInboundUserId:'),
    'the rule must be told who last wrote in each chat, or a recipient DM is chosen',
  )

  // And the three tool cases have to ASK it. Everything above this line is
  // still green while resolveMissionToolChat sits in the file uncalled and the
  // cases pick monitoredChatIds[0] inline, which is the one shape this test
  // exists to forbid, so the call sites are pinned here rather than assumed.
  // Derived the other way round, because "the mission tools" above IS the set
  // that calls resolveMissionToolChat: here the DECLARED tool names are the
  // input, so a tool declared and then wired to an inline chat guess is caught.
  for (const c of missionToolCases()) {
    assert.ok(
      c.body.includes('resolveMissionToolChat('),
      `${c.name} must take its chat from resolveMissionToolChat, not from an inline guess`,
    )
  }
})

test('the mission tools accept an optional chat, and it stays optional', () => {
  // Making chat_id required would break every 0.40.0-era prompt habit and
  // every single-chat agent, and an omitted chat is DEFINED to mean the main
  // chat.
  for (const tool of missionToolCases().map((c) => c.name)) {
    const at = server.indexOf(`name: '${tool}',`)
    assert.ok(at > 0, `${tool} declaration not found`)
    const end = server.indexOf("    {\n      name: '", at)
    const decl = server.slice(at, end > 0 ? end : at + 5000)
    assert.ok(decl.includes('chat_id: {'), `${tool} must accept an optional chat_id`)
    assert.ok(
      !/required: \[[^\]]*chat_id/.test(decl),
      `${tool} must NOT make chat_id required`,
    )
  }
  assert.match(server, /required: \['title', 'mini_goals'\]/)
})

test('the create_mission description says one open mission per CHAT, because that is now true', () => {
  // The rule the model reads has to match the rule the server enforces. While
  // this said "one active mission per agent" an agent with two chats would
  // believe that starting a mission in chat B killed chat A's, which is the
  // opposite of what per-chat scope does, and it would refuse to start the
  // second one at all.
  const at = server.indexOf("name: 'create_mission',")
  assert.ok(at > 0)
  const decl = server.slice(at, server.indexOf("    {\n      name: '", at))
  assert.ok(
    !/active mission per agent/.test(decl),
    'create_mission must not tell the model a mission is one per agent',
  )
  assert.match(decl, /open mission per CHAT/)
})

test('the active-mission read is scoped to a chat, or a tick lands on another chat card', () => {
  const start = server.indexOf('async function resolveMissionId(')
  assert.ok(start > 0)
  const end = server.indexOf('\n}', start)
  const body = server.slice(start, end)
  assert.ok(
    /buildMissionActivePath\([^)]*,/.test(body),
    'resolveMissionId must pass the chat into buildMissionActivePath',
  )
})

// ── The goal lane's own wiring (stage 6) ─────────────────────────────────────
//
// The lane closes missions, so it inherits trap 3 above whole: an unstamped
// completion is narrated back to the model as the owner's own Mark done, and
// this one is worse than a tool's, because nothing typed it and there is no
// tool case to read. It also has a trap of its own: SubagentStop looks
// exactly like a goal checker and is not one (a control session with no goal
// at any point fired it once per turn, with an empty agent_type, carrying the
// composer's ghost prompt suggestions and an agent_transcript_path pointing
// at a file that does not exist), so a lane that keyed off it would report a
// verdict that never happened.

test('the goal lane stamps the mission BEFORE its complete and its fail leave', () => {
  const start = server.indexOf('async function writeGoalEffect(')
  assert.ok(start > 0, 'the goal lane must write its verdicts through one function')
  const end = server.indexOf('\n}', start)
  const body = server.slice(start, end)

  const stamp = body.indexOf('noteMissionPendingSelfWrite(')
  assert.ok(stamp > 0, 'the goal lane must stamp the mission it is about to close')
  // The complete and the fail share one request call, and it is the only
  // bgosPatch in this function, so the ordering assertion covers both.
  const request = body.indexOf('await bgosPatch(', stamp)
  assert.ok(request > stamp, 'the stamp must come before the request, not after the answer')
  assert.ok(
    body.includes('rememberMissionSelfWrite('),
    'the landed write must be stamped too, which is what covers a late frame',
  )
  // The check write must NOT be stamped: progress emits mission_updated,
  // which is not a self write frame, and spending a stamp on it would leave
  // the completion that follows looking like the owner's own Mark done.
  const progress = body.indexOf("write.route === 'progress'")
  assert.ok(progress > 0 && progress < stamp, 'the check write comes first and takes no stamp')
})

test('the goal lane reads nothing from SubagentStop, which is not the checker', () => {
  assert.equal(
    server.includes('SubagentStop'),
    false,
    'SubagentStop must not reach the goal lane: it fires once per turn with or without a goal',
  )
  const start = server.indexOf("case 'goal_poll': {")
  assert.ok(start > 0, 'runHookEffects must answer the goal_poll effect')
  const body = server.slice(start, start + 800)
  assert.ok(body.includes('void pollGoalStatus()'), 'the wake must read the transcript')
  // Twice, because the terminal verdict is written after this plugin's own
  // Stop hook in the same batch: the poll a Stop triggers is one behind.
  assert.ok(
    body.includes('GOAL_POLL_BEAT_MS'),
    'a second poll a beat later, or a closed goal is read one Stop late',
  )
})

test('a slow sweep runs beside the resting one, so a missed hook strands nothing', () => {
  assert.match(
    server,
    /setInterval\(\(\) => void pollGoalStatus\(\), GOAL_SWEEP_MS\)\.unref\(\)/,
    'the goal lane needs its own sweep: a hook this process never received is not a rare case',
  )
})

test('the goal lane hears every mission frame, even one the model is never told about', () => {
  const start = server.indexOf('function handleMissionEvent(')
  assert.ok(start > 0)
  const body = server.slice(start, server.indexOf('\n}', start))
  const lane = body.indexOf('applyMissionFrameToGoalLane(')
  const gate = body.indexOf('if (!notice) return')
  assert.ok(lane > 0, 'the frame must reach the goal lane')
  assert.ok(
    gate > lane,
    'Pause has to clear the native goal even on a frame that produces no notice at all',
  )
  // One ask of the ledger, because the pending stamp is CONSUMED by asking.
  assert.equal(
    [...body.matchAll(/missionSelfWrites\.isSelfAuthored\(/g)].length,
    1,
    'asking the ledger twice spends the pending stamp and narrates the daemon own write back',
  )
})

test('the owner Pause reaches the mission this lane REPORTS on, not only one it armed', () => {
  // A goal a person typed into their own terminal gets a derived mission and
  // no arm record at all, and the backend still offers Pause, Resume and Set
  // aside on it, because this daemon declared it can enforce them. The pure
  // decision reads the report record for exactly that case, so the wiring has
  // to hand it over; without it the buttons do nothing and the runtime keeps
  // looping on a mission the owner stopped.
  const start = server.indexOf('function applyMissionFrameToGoalLane(')
  assert.ok(start > 0, 'the frame wiring must live in one function')
  const body = server.slice(start, server.indexOf('\n}', start))
  assert.ok(
    body.includes('armed: goalArmRecord(),'),
    'the goal the owner switch armed is one of the two identities',
  )
  assert.ok(
    body.includes('reporting: goalReportRecord(),'),
    'the goal this lane reports on is the other, and it is the only one a typed goal has',
  )
  // The attachment survives the clear a pause types, or a Resume has nothing
  // to put back. Only a forget drops it.
  const clear = body.indexOf("if (command.kind === 'clear')")
  const forget = body.indexOf('if (command.forget)')
  const drop = body.indexOf('goalHeld = null')
  assert.ok(clear > 0, 'the clear branch must be there to read')
  assert.ok(forget > clear && drop > forget, 'the goal is forgotten on a forget and nowhere else')
  // The write half goes quiet with it: the checks are addressed to this id,
  // and a mission the owner paused must stop collecting them.
  assert.ok(
    body.slice(clear, forget).includes('goalMissionId = null'),
    'a paused mission takes no more checks',
  )

  // The report record is the ATTACHMENT, which is what a pause keeps, and not
  // the arm record, which is what the defect read.
  const reader = server.indexOf('function goalReportRecord(')
  assert.ok(reader > 0, 'the report record needs a reader of its own')
  const readerBody = server.slice(reader, server.indexOf('\n}', reader))
  assert.ok(readerBody.includes('goalHeld'), 'it is read off the attachment')
  assert.equal(
    readerBody.includes('goalArm'),
    false,
    'reading the arm record here would rebuild the defect',
  )

  // Both branches of the attach remember it: the goal the owner armed, and
  // the derived or adopted mission a typed goal lands on.
  const attach = server.indexOf('async function attachGoalToMission(')
  assert.ok(attach > 0)
  const attachBody = server.slice(attach, server.indexOf('\n}', attach))
  assert.equal(
    [...attachBody.matchAll(/goalHeld = /g)].length,
    2,
    'a goal the owner armed and a goal a person typed are both attached',
  )

  // And the two identities move together at the arm, or a frame landing
  // before the set sentinel reads an attachment to the previous mission.
  const arm = server.indexOf('async function armNativeGoal(')
  assert.ok(arm > 0)
  const armBody = server.slice(arm, server.indexOf('\n}', arm))
  assert.ok(
    armBody.includes('goalArm = {') && armBody.includes('goalHeld = {'),
    'the arm record and the attachment are set in the same place',
  )
})

test('the arm is recorded as pending BEFORE the keystrokes, and released at the sentinel and at the timeout', () => {
  // `live` is folded from the transcript, and the transcript says nothing
  // about a goal until its set sentinel is read, so for the whole
  // confirmation window an arm in flight is indistinguishable from a goal the
  // runtime dropped. The pending record is the only thing that tells them
  // apart, and it is worth nothing unless it is taken before the keystrokes
  // leave and released afterwards BOTH ways: a record left standing is a
  // mission that can never arm again for the life of the daemon.
  const arm = server.indexOf('async function armNativeGoal(')
  assert.ok(arm > 0, 'the arm must live in one function')
  const armBody = server.slice(arm, server.indexOf('\n}', arm))

  const serialised = armBody.indexOf('goalPendingArm !== null')
  const record = armBody.indexOf('goalPendingArm = {')
  const keystrokes = armBody.indexOf('runGoalInjection(steps')
  assert.ok(
    serialised > 0,
    'a second arm for the same mission while one is in flight must type nothing',
  )
  assert.ok(record > serialised, 'the guard reads the record before this arm claims it')
  assert.ok(
    keystrokes > record,
    'the pending arm must be recorded BEFORE the keystrokes leave, or a frame landing in between types a second /goal',
  )

  // A record the wiring never hands over is a rule the pure decision cannot
  // apply, and that is exactly how this defect shipped green once already.
  const frame = server.indexOf('function applyMissionFrameToGoalLane(')
  assert.ok(frame > 0)
  const frameBody = server.slice(frame, server.indexOf('\n}', frame))
  assert.ok(
    frameBody.includes('pending: goalPendingArm'),
    'the frame reader must be told which arm is in flight',
  )

  // Released by the runtime's own answer ...
  const attach = server.indexOf('async function attachGoalToMission(')
  assert.ok(attach > 0)
  const attachBody = server.slice(attach, server.indexOf('\n}', attach))
  assert.ok(
    attachBody.includes('goalPendingArm = null'),
    'the set sentinel is the answer, and it ends the window',
  )

  // ... and by the confirmation giving up, on every way out of it, which is
  // what the finally is for: the timeout is the path that would otherwise
  // leave the record standing for ever.
  const confirm = server.indexOf('async function confirmGoalArmed(')
  assert.ok(confirm > 0)
  const confirmBody = server.slice(confirm, server.indexOf('\n}', confirm))
  assert.ok(
    confirmBody.includes('no set sentinel'),
    'the timeout must still be what this watcher ends on',
  )
  assert.match(
    confirmBody,
    /finally \{[\s\S]*goalPendingArm = null/,
    'the confirmation must release the record on its way out, the timeout included',
  )
})

test("the sentinel consults the owner's stop BEFORE it hands the mission back", () => {
  // The hole this closes: a Pause or a Set aside landing inside the arming
  // window typed a clear at a goal that did not exist yet, and the sentinel
  // that arrived afterwards then restored the mission id and let the runtime
  // carry on looping on a mission the owner had stopped. The stop is recorded
  // on the pending arm by the frame, and the sentinel is where it is enforced.
  const frame = server.indexOf('function applyMissionFrameToGoalLane(')
  assert.ok(frame > 0)
  const frameBody = server.slice(frame, server.indexOf('\n}', frame))
  const marks = frameBody.indexOf('goalPendingStopFor(')
  const quiet = frameBody.indexOf("if (command.kind === 'none') return")
  assert.ok(marks > 0, 'the frame must record the stop on the arm in flight')
  assert.ok(
    quiet > marks,
    'the stop must be recorded before the no command exit: a frame that types no clear at all still has to be carried across the window',
  )

  const attach = server.indexOf('async function attachGoalToMission(')
  assert.ok(attach > 0)
  const attachBody = server.slice(attach, server.indexOf('\n}', attach))
  const consults = attachBody.indexOf('goalSentinelActionFor(')
  const restores = attachBody.indexOf('goalMissionId = goalArm.missionId')
  const derives = attachBody.indexOf('goalMissionId = await resolveGoalMission(')
  assert.ok(consults > 0, 'the sentinel must ask what the record says before doing anything with it')
  assert.ok(
    restores > consults && derives > consults,
    'the stop is read BEFORE the mission id is restored or derived, or the owner stop is overwritten by the goal that answered it',
  )
  // And the stop branch does the two things that make it a stop: the goal is
  // typed away again, and no mission is taken.
  const stop = attachBody.indexOf("action.kind === 'stop'")
  assert.ok(stop > consults && stop < restores, 'the stop is settled before the ordinary attach')
  const stopBody = attachBody.slice(stop, restores)
  assert.ok(stopBody.includes('clearNativeGoal('), 'the goal that armed after the stop is cleared again')
  assert.ok(stopBody.includes('goalMissionId = null'), 'a mission the owner stopped takes no more checks')
  assert.ok(stopBody.includes('return'), 'and it never falls through into deriving a mission of its own')
})

test('the goal set is the ONLY chat derived text this daemon ever types', () => {
  // The injector's safety invariant, from the wiring side: server.ts may build
  // a key sequence through the two builders in lib/compact-inject.ts and
  // through nothing else.
  const builders = [...server.matchAll(/build(Injection|GoalSetInjection)Steps\(/g)].length
  const sends = [...server.matchAll(/'send-keys'/g)].length
  assert.ok(builders > 0, 'the injection argv must come from the builders')
  assert.equal(sends, 0, 'server.ts must never build a send-keys argv of its own')
})
