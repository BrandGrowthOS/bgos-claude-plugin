import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The repo idiom for a source scan: an import.meta.url URL resolves identically
// under bun and under the tsx runner the canonical `npm test` orchestrator uses,
// where import.meta.dir does not exist.
// Normalised to LF the moment it is read. Every assertion below is either a
// regex anchored on a newline or index arithmetic over offsets, and a checkout
// with git autocrlf hands us CRLF: the same source then fails patterns that
// pass here, which is a property of the CHECKOUT, not of the daemon. Normalise
// once, so the scans describe the code rather than the line endings.
const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n',
)

test('losing the pairing lock stands the daemon down, it does not merely warn', () => {
  // The detailed form must be what the poll tick calls: the boolean form
  // cannot name the rival holder.
  assert.match(server, /refreshPairingLockDetailed\(/)
  // There must be a real consequence, not only a log line.
  assert.match(server, /channelArmed\s*=\s*false/)
  // And the daemon must be able to come back if the rival dies.
  assert.match(server, /lockRecheck|resumeLockRecheck/)
})

test('the poll tick refuses to forward while not armed', () => {
  assert.match(server, /if\s*\(\s*!channelArmed\s*\)/)
})

// A stood-down daemon must behave like a daemon that was passive from boot. A
// passive daemon never joins the pairing room, so it never receives ANY of
// these frames; one that keeps its socket open must therefore refuse to act on
// them. Round one of this bug was every voice_rpc frame handled two to four
// times, N duplicate consult cards, and "late/unknown voice_rpc result"
// warnings, which is what gating only the poll tick would leave in place.
const PAIRING_FRAMES = [
  'voice_rpc',
  'export_pack',
  'export_pack_manifest',
  'voice_task_dispatch',
  'update_rpc',
  'watcher_install_rpc',
  'inbound_message',
  'peer_conversation_closed',
  'peer_turn_yielded',
  'meeting_invitation',
  'meeting_message',
  'meeting_turn_changed',
  'meeting_state_resync',
  'meeting_closed',
  'meeting_participant_left',
  'meeting_participant_added',
  'meeting_policy_changed',
  'stream_authority',
  'update_state',
  // Missions (0.41.0): the owner's own Set aside, Mark done, Pause, Resume and
  // Start reach the agent in band. A stood-down daemon must not relay them:
  // several daemons can resolve one pairing on a shared host, and the passive
  // ones would each tell their model the same thing.
  'mission_created',
  'mission_ticked',
  'mission_paused',
  'mission_resumed',
  'mission_completed',
  'mission_abandoned',
  'mission_failed',
  'mission_updated',
]

// Transport bookkeeping, not work done on the pairing's behalf: a passive
// daemon still needs its own connection state to be correct, so these stay
// unwrapped on purpose.
const TRANSPORT_FRAMES = ['connect', 'disconnect', 'connect_error']

test('the stand-down gate wraps every socket handler that acts for the pairing', () => {
  assert.match(server, /const whenArmed\s*=/)
  for (const frame of PAIRING_FRAMES) {
    assert.match(
      server,
      new RegExp(`realtimeSocket\\.on\\('${frame}', whenArmed\\('${frame}',`),
      `${frame} must be registered through whenArmed, or a stood-down daemon still acts on it`,
    )
  }
})

test('the wrapped set is exactly the handlers minus the transport ones', () => {
  // Counting, not just spot-checking, so a NEW handler added later cannot slip
  // in unwrapped and unnoticed: this fails the moment the two lists disagree.
  // The character class must stay WIDER than the frame names in use today. It
  // was [a-z_]+, and a future realtimeSocket.on('meeting_v2', ...) would have
  // matched neither pattern (the closing quote has to follow the class
  // directly), so it would never enter `registered`, both assertions below
  // would still pass, and the handler would ship ungated with the suite green.
  const registered = [...server.matchAll(/realtimeSocket\.on\('([A-Za-z0-9_]+)'/g)].map((m) => m[1])
  const wrapped = [...server.matchAll(/whenArmed\('([A-Za-z0-9_]+)'/g)].map((m) => m[1])
  assert.deepEqual(
    [...new Set(registered)].sort(),
    [...PAIRING_FRAMES, ...TRANSPORT_FRAMES].sort(),
    'server.ts registers a socket handler this test does not classify; wrap it or list it as transport',
  )
  assert.deepEqual([...new Set(wrapped)].sort(), [...PAIRING_FRAMES].sort())
  for (const frame of TRANSPORT_FRAMES) {
    assert.ok(!wrapped.includes(frame), `${frame} must not be gated on channelArmed`)
  }
})

test('the poll tick reschedules itself from a finally, so standing down cannot kill the loop', () => {
  // The stand-down guard returns from INSIDE the tick's try block, and a return
  // skips everything after a try/catch. If the reschedule sits after the block
  // rather than in a finally, the tick that stands the daemon down is the last
  // tick the process ever runs: no lock heartbeat (so a reclaim later goes
  // stale and is taken by a rival with nothing left to notice), no beacon
  // heartbeat, no stream gap deadlines, no WS-down catch-up. The daemon looks
  // healthy for hours. Nothing else in this file can see that, because the
  // guard's PLACEMENT is right and only its control flow is wrong.
  // Whitespace and comment lines only between the finally and the reschedule,
  // so this cannot be satisfied by some unrelated finally elsewhere in the file
  // that merely happens to precede the scheduler.
  assert.match(server, /finally\s*\{(?:\s|\/\/[^\n]*\n)*setTimeout\(tick,/)
  // And the scheduler must exist EXACTLY twice: the initial kick that starts
  // the chain, plus the one reschedule in the finally. The previous form of
  // this assertion was a negative regex over "} catch (err) { ... } setTimeout",
  // which was vacuous: a mutant that KEPT the finally reschedule and added a
  // bare one after the block matched neither the catch shape nor anything else,
  // passed, and doubled the tick chain on every cycle for the life of the
  // process. Counting cannot be fooled that way.
  assert.equal(
    [...server.matchAll(/setTimeout\(tick,/g)].length,
    2,
    'exactly two: the initial kick and the finally reschedule; a third doubles the poll loop',
  )
})

test('the stand-down early return sits INSIDE the tick try, ahead of the finally', () => {
  // Placement is the whole point and no regex over the file can see it: the
  // guard must return from inside the try so the finally still reschedules.
  // Moved below the finally it would be dead code (the tick already returned or
  // fell through); moved out of the try it would skip the reschedule, and the
  // stand-down tick would be the last tick the process ever ran.
  const tickStart = server.indexOf('const tick = async (): Promise<void> => {')
  assert.ok(tickStart !== -1, 'the poll tick must be findable')
  const tryStart = server.indexOf('try {', tickStart)
  const finallyStart = server.indexOf('} finally {', tickStart)
  const guard = server.indexOf('if (!channelArmed) return', tryStart)
  assert.ok(tryStart !== -1 && finallyStart !== -1, "the tick's try/finally must be findable")
  assert.ok(guard !== -1, 'the stand-down guard must be findable')
  assert.ok(guard > tryStart, 'the guard must be inside the try, not before it')
  assert.ok(guard < finallyStart, 'the guard must return before the finally, not after it')
})

test('standing down does not disconnect the socket, so re-arming stays cheap', () => {
  // The stand-down block itself must not tear the transport down: the re-arm
  // path relies on the connection still being there, and connectWebsocket is
  // one-shot per process.
  // Anchored on the refresh branch, not on the first 'channelArmed = false' in
  // the file: that one is the module-scope declaration, and slicing from there
  // swallows the whole of connectWebsocket.
  const start = server.indexOf('if (!refreshed.held)')
  const end = server.indexOf('resumeLockRecheck()', start)
  assert.ok(start !== -1 && end > start, 'the stand-down branch must be findable')
  const standDown = server.slice(start, end)
  assert.doesNotMatch(standDown, /realtimeSocket\?\.(disconnect|close)\(/)
  assert.doesNotMatch(standDown, /process\.exit\(/)
})

test('the heartbeat is gated on lock OWNERSHIP, not on being armed', () => {
  // channelArmed is set at the END of the arm, and arming runs discoverChats
  // (up to tens of seconds). Gating the heartbeat on it left the lock owned and
  // unrefreshed for that whole window, so it went stale (15s), a rival reclaimed
  // and armed, and this daemon then set channelArmed anyway: two armed daemons
  // on one pairing until the next tick noticed.
  assert.match(server, /let lockHeld = false/)
  // Both acquisition sites must claim ownership immediately, which is the point
  // of the separate flag.
  assert.match(server, /lockAtBoot\.acquired\)\s*\{[\s\S]{0,600}?lockHeld = true/)
  assert.match(server, /res\.acquired\)[\s\S]{0,600}?lockHeld = true/)
  // And the heartbeat predicate must read it.
  assert.match(server, /const heartbeatThisTick =\s*\n\s*lockHeld &&/)
  // Losing the lock drops both flags.
  assert.match(server, /if \(!refreshed\.held\)\s*\{[\s\S]{0,200}?lockHeld = false/)
})

test('a failed re-arm gives the lock back instead of holding it deaf', () => {
  // Without this the daemon keeps the pairing lock (its heartbeat is on
  // lockHeld, so the lock stays alive), never reaches channelArmed, and has
  // already cleared its recheck interval: nothing delivers for that pairing
  // again and no rival can take over.
  const start = server.indexOf('void armDelivery().catch(')
  assert.ok(start !== -1, 'the promotion arm must be findable')
  const block = server.slice(start, start + 1200)
  assert.match(block, /channelArmed = false/)
  assert.match(block, /lockHeld = false/)
  assert.match(block, /resumeLockRecheck\(\)/)
})

test('the re-arm catches the shared cursor file up before it polls again', () => {
  // A stood-down daemon's chatLastSeen is frozen at boot-era values while the
  // holder advances the shared file. Without a merge the first poll after
  // reclaiming re-forwards the holder's deliveries and the first flush rewinds
  // the file.
  const rearm = server.indexOf('if (deliveryLoopsStarted) {')
  const merge = server.indexOf('mergeCursorMaps(', rearm)
  const armedAgain = server.indexOf('channelArmed = true', rearm)
  assert.ok(rearm !== -1, 'the re-arm path must be findable')
  assert.ok(merge !== -1, 'the re-arm must merge the cursor file')
  assert.ok(armedAgain !== -1)
  assert.ok(merge < armedAgain, 'the merge must happen before delivery is re-armed')
  // And the flush must merge too, so the exit hooks and the flush timer cannot
  // rewind a concurrent holder's cursors either.
  const flush = server.indexOf('function flushChatCursors(): void {')
  assert.ok(flush !== -1)
  const flushBody = server.slice(flush, server.indexOf('\n}', flush))
  assert.match(flushBody, /mergeCursorMaps\(/)
})

test('the four lock lifecycle lines name this daemon pid', () => {
  // Every rival daemon for a pairing appends to the SAME per-assistant log
  // file and log() carries no pid, so without this an operator reading the log
  // cannot tell which process owns the channel. Only these four lines carry it:
  // a global prefix would rewrite every line a log parser already reads.
  for (const re of [
    /pid \$\{process\.pid\}: pairing lock acquired/,
    /pid \$\{process\.pid\}: \$\{formatPassiveBanner/,
    /pid \$\{process\.pid\}: pairing lock reclaimed on recheck/,
    /pid \$\{process\.pid\}: pairing lock now held by pid/,
  ]) {
    assert.match(server, re)
  }
})

test('an arm that lost the lock while it ran does not arm anyway', () => {
  // The poll tick starts partway through the arm, so it can stand this daemon
  // down (rival holds the lock) while chat discovery and the boot sweep are
  // still running. Both arm paths must re-check ownership before flipping
  // delivery on, or the daemon re-arms itself straight after a correct stand
  // down and is armed without the lock: the exact bug, one layer down.
  const armStart = server.indexOf('const armDelivery = async (): Promise<void> => {')
  assert.ok(armStart !== -1, 'armDelivery must be findable')
  const arm = server.slice(armStart)
  const armEnd = arm.indexOf('\n  }\n')
  const body = arm.slice(0, armEnd === -1 ? arm.length : armEnd)
  const gates = [...body.matchAll(/if \(!lockHeld\) \{/g)].length
  const arms = [...body.matchAll(/channelArmed = true/g)].length
  assert.equal(arms, 2, 'the re-arm path and the end of the first arm')
  assert.equal(gates, arms, 'every channelArmed = true in armDelivery must sit behind a lockHeld gate')
  // And each gate must ASK the lock file, not just read the flag. lockHeld is
  // only ever cleared by the poll tick, so it is stale-true for an arm that ran
  // before the tick existed: a boot-passive daemon promoted into the full first
  // arm can be reclaimed on staleness with nothing left to notice, and the flag
  // alone would wave it through.
  assert.equal(
    [...body.matchAll(/gateRefresh = refreshPairingLockDetailed\(/g)].length,
    arms,
    'each arm gate refreshes the lock synchronously before arming',
  )
  assert.equal(
    [...body.matchAll(/lastDeliveryHeartbeatAt = gateNow/g)].length,
    arms,
    'a gate refresh must spend the throttle slot, or the next tick spends a second one',
  )
})

test('the delivery-loops latch is only undone when the loops were never built', () => {
  // deliveryLoopsStarted latches BEFORE the loops are built, which is what stops
  // a concurrent armDelivery from starting a second poll chain. That makes it a
  // lie if the arm throws before the poll kick: the promotion catch retries, the
  // retry takes the short re-arm path, and the daemon arms with no tick, no WS
  // and no flush interval. Undoing it unconditionally is the opposite bug: an
  // arm that threw AFTER the kick would run the full path again and leave two
  // interleaved poll chains forever. So the undo is conditional on the second
  // flag, which is set at the kick itself.
  assert.match(server, /let pollLoopKicked = false/)
  assert.match(server, /setTimeout\(tick, POLL_INTERVAL_MS\)\n\s*pollLoopKicked = true/)
  assert.match(server, /if \(!pollLoopKicked\) deliveryLoopsStarted = false/)
  const start = server.indexOf('void armDelivery().catch(')
  const block = server.slice(start, start + 1200)
  assert.match(block, /if \(!pollLoopKicked\) deliveryLoopsStarted = false/)
})

test('a stand-down clears the heartbeat-write warning latch', () => {
  // Otherwise the sequence error, stand down, reclaim, error again is silent the
  // second time: the daemon looks healthy while its heartbeat writes keep
  // failing, which is exactly what the warning exists to catch.
  const clears = [...server.matchAll(/lockIoErrorWarned = false/g)].length
  assert.ok(clears >= 4, `expected a clear on a healthy refresh and on each stand-down, saw ${clears}`)
  const standDown = server.indexOf('if (!refreshed.held)')
  const armed = server.indexOf('if (!channelArmed) return', standDown)
  assert.match(server.slice(standDown, armed), /lockIoErrorWarned = false/)
})

test('the once-per-spell ignore log is cleared on both edges of a passive spell', () => {
  // Cleared only on stand-down, the set would still hold the previous spell's
  // frame kinds when the daemon stands down a second time, so the second spell
  // would log nothing and look like it was never deaf.
  assert.equal(
    [...server.matchAll(/standDownIgnoredFrames\.clear\(\)/g)].length,
    4,
    'the three stand-down sites (the tick and the two arm gates) plus the re-arm',
  )
  const rearm = server.indexOf('if (deliveryLoopsStarted) {')
  const armedAgain = server.indexOf('channelArmed = true', rearm)
  const cleared = server.indexOf('standDownIgnoredFrames.clear()', rearm)
  assert.ok(cleared !== -1 && cleared < armedAgain, 'the re-arm must clear it before arming')
})

// ── The hook intake stands down with everything else (stage 4) ───────────────
//
// Several daemons can resolve one pairing on a shared host, and after stage 4
// they all watch the SAME spool directory. If a passive one drained it too,
// every tool row would reach the chat twice, which is the 2026-09-04 three
// daemon incident again with cards instead of messages. The lock holder rule is
// the whole defence, so it is pinned in the source rather than trusted.

test('the hook intake is started only inside the lock holder branch', () => {
  // startHookIntake (the library) must have exactly ONE call site, inside the
  // helper, and that helper must refuse before it when the lock is not ours.
  const calls = [...server.matchAll(/\bstartHookIntake\(\{/g)]
  assert.equal(calls.length, 1, 'one construction site, so one place can be wrong')

  const start = server.indexOf('function startHookIntakeIfHolder(')
  assert.ok(start > 0, 'the lock holder helper must exist and be named')
  const body = server.slice(start, calls[0]!.index!)
  assert.match(
    body,
    /if\s*\(\s*!lockHeld\s*\)\s*return/,
    'the intake must refuse to start for a daemon that does not hold the pairing lock',
  )
  // And the running intake re-checks on every pump, so a daemon that stands
  // down between two pumps stops consuming without waiting to be told.
  assert.match(server, /isArmed:\s*\(\)\s*=>\s*channelArmed\s*&&\s*lockHeld/)
})

test('every stand-down stops the hook intake, and so does every exit', () => {
  const lines = server.split('\n')
  const standDowns = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /^\s*lockHeld = false\b/.test(line))
  assert.ok(standDowns.length >= 4, `expected every stand-down site, found ${standDowns.length}`)
  for (const { i } of standDowns) {
    const window = lines.slice(i, i + 8).join('\n')
    assert.match(
      window,
      /stopHookIntake\(\)/,
      `stand-down at line ${i + 1} keeps draining hook spools; it would post every row twice`,
    )
  }
  // The process-level hooks too: a daemon that dies mid turn must not leave a
  // watcher and a coalescer timer behind.
  const shutdown = server.slice(server.indexOf('selfUpdater?.markGracefulStop()'))
  assert.match(shutdown.slice(0, 400), /stopHookIntake\(\)/)
  const onExit = server.slice(server.indexOf("process.on('exit', () => {"))
  assert.match(onExit.slice(0, 300), /stopHookIntake\(\)/)
})

test('every actingUser.noteInbound site notes the turn chat beside it', () => {
  // The two trackers answer different questions and must not be merged:
  // actingUser records HUMAN turns only and is never cleared, so a scheduled
  // wake, a peer turn or a meeting would file this turn's tool rows under the
  // last human chat. A new inbound site that forgets turnChat sends the rows to
  // the wrong conversation, silently.
  const lines = server.split('\n')
  const inbound = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.includes('actingUser.noteInbound('))
  assert.equal(inbound.length, 3, 'the three inbound sites: poll, update stream, websocket')
  for (const { i } of inbound) {
    const window = lines.slice(i, i + 20).join('\n')
    assert.match(
      window,
      /turnChat\.note\(/,
      `the inbound site at line ${i + 1} records the acting user but not the turn chat`,
    )
    // And the delivered TEXT, which is the only positive proof a Claude Code
    // session is the one this daemon feeds (lib/hook-intake.ts admission).
    assert.match(
      window,
      /\n\s*text[:,]/,
      `the inbound site at line ${i + 1} notes the chat but not the text, so a session ` +
        'that arrives before any reply marker can never prove itself and its whole first ' +
        'turn is dropped',
    )
  }
  // Plus the two meeting deliveries, which have no acting user at all.
  assert.equal(
    [...server.matchAll(/turnChat\.note\(/g)].length,
    5,
    'three inbound sites plus the two meeting delivery sites',
  )
  assert.match(server, /turnChat\.end\(/, 'the turn chat is cleared when the turn ends')
})

test('the daemon never reads the owner\u2019s Show technical details switch', () => {
  // Rule 1 of stage 4: the plugin always sends, the app decides what to draw.
  // The backend derives the agent's live status from a tool row arriving, and a
  // shared agent has several viewers, so gating here would blind the header for
  // everyone to save one HTTP call.
  for (const [name, source] of [
    ['server.ts', server],
    ['lib/hook-events.ts', readFileSync(new URL('../lib/hook-events.ts', import.meta.url), 'utf8')],
    ['lib/hook-intake.ts', readFileSync(new URL('../lib/hook-intake.ts', import.meta.url), 'utf8')],
    ['bin/hoai-hook.mjs', readFileSync(new URL('../bin/hoai-hook.mjs', import.meta.url), 'utf8')],
  ] as const) {
    assert.ok(
      !/showTechnicalDetails|show_technical_details/.test(source),
      `${name} must not know the per agent switch exists`,
    )
  }
})

test('the Steps snapshot goes to the route BOTH auth modes accept', () => {
  // The user family works for a pairing caller and for a legacy X-API-Key
  // caller; the /integrations twin refuses the API key half of the fleet with a
  // 403 that would look exactly like "this chat does not take Steps".
  assert.match(server, /bgosPut\(\s*`assistants\/\$\{ASSISTANT_ID\}\/chats\/\$\{chatId\}\/steps`/)
  assert.ok(
    !/integrations\/assistants\/\$\{ASSISTANT_ID\}\/chats\/\$\{chatId\}\/steps/.test(server),
    'the pairing-scoped twin would 401 a legacy install',
  )
})

// ── The hook rail's own failure modes (stage 4 review) ────────────────────

test('the intake binds on PROOF: a delivered prompt, or the proven transcript', () => {
  // "First session seen under our project dir" used to be the whole rule, so a
  // human's own claude in the agent folder, or a session that died last week,
  // could capture the rail and the real agent's rows were then refused as
  // foreign for the life of the daemon.
  const start = server.indexOf('function startHookIntakeIfHolder(')
  assert.ok(start > 0)
  const body = server.slice(start, start + 2_000)
  assert.match(
    body,
    /provesDelivery:\s*\(prompt\)\s*=>\s*turnChat\.matchDelivered\(prompt\)\s*!==\s*null/,
    'proof a (the prompt carries a message we delivered) must be wired into the intake',
  )
  assert.match(
    body,
    /provenTranscript:\s*\(\)\s*=>/,
    'proofs b and c (the transcript the binding chain proved) must be wired into the intake',
  )
  assert.match(
    body,
    /sessionBinder\.provenTranscriptPath\(\)/,
    'and they must read the POSITIVE half of the chain, never the newest-mtime guess',
  )
})

test('the turn\u2019s chat is fixed at its prompt, not at whatever arrived last', () => {
  const start = server.indexOf('function onHookPayload(')
  assert.ok(start > 0)
  const body = server.slice(start, server.indexOf('\n}', start))
  assert.match(
    body,
    /turnChat\.beginTurn\(/,
    'a UserPromptSubmit must BIND the chat, or a peer message mid turn re-points the rows',
  )
  assert.match(body, /turnChat\.matchDelivered\(payload\.prompt\)/)
})

test('a turn end AWAITS the card already on the wire before its final one', () => {
  // The defect: a `done` card that arrived while a POST or PATCH was in flight
  // found the flusher busy, left its state pending, and had it cleared by the
  // turn end a microsecond later. The card stayed on "running" for ever, on
  // exactly the turns busy enough to matter. The Codex poster's finalizeTurn
  // has awaited its flushInFlight since 0.3; this is the same rule.
  const start = server.indexOf('async function finishHookTurn(')
  assert.ok(start > 0, 'the turn end must be the awaiting one')
  const body = server.slice(start, server.indexOf('\nfunction runHookEffects(', start))
  const capture = body.indexOf('const pending = hookCardPending')
  const clear = body.indexOf('endHookTurn()')
  const awaitFlight = body.indexOf('await flight')
  const finalWrite = body.indexOf('await writeHookCard(')
  assert.ok(capture > 0, 'the final card must be taken out of the state first')
  assert.ok(clear > capture, 'then the turn state is cleared, so a NEW turn is not cut short')
  assert.ok(awaitFlight > clear, 'then the write already on the wire is awaited')
  assert.ok(finalWrite > awaitFlight, 'and only then does the final done card go out')
  assert.match(
    server,
    /case 'turn_end': \{\s*\n\s*void finishHookTurn\(\)/,
    'the turn_end effect must run the awaiting version',
  )
})

test('a 403 is read from the STATUS, never from the text of the error', () => {
  // The Steps URL embeds the chat id, so a chat numbered 4403 matched a
  // substring check and silenced its own Steps strip for the life of the
  // daemon; so did any timeout message that happened to contain 403.
  const start = server.indexOf('async function putHookSteps(')
  assert.ok(start > 0)
  const body = server.slice(start, server.indexOf('\nfunction startHookStepsHeartbeat(', start))
  assert.match(body, /httpStatusOf\(err\)\s*===\s*403/)
  assert.ok(
    !/includes\(['"]403['"]\)/.test(body),
    'a status is a number, and searching for it in a sentence is how a chat id silences a chat',
  )
  assert.match(server, /class HttpError extends Error/)
  assert.match(server, /throw new HttpError\(`PUT \$\{response\.status\}/)
})

test('the hook rail never sends assistantId to POST /messages', () => {
  // CreateMessageDto does not declare it: the backend's whitelist strips it and
  // its unknown-field shadow interceptor logs a line for every card and marker
  // this rail posts. The daemon's own credentials already say who is speaking.
  const start = server.indexOf('async function writeHookCard(')
  const end = server.indexOf('async function putHookSteps(')
  assert.ok(start > 0 && end > start)
  const rail = server.slice(start, end)
  assert.ok(
    !/assistantId:\s*Number\(ASSISTANT_ID\)/.test(rail),
    'the tool card POST must not carry assistantId',
  )
  assert.match(rail, /messageType: 'tool_progress'/)
  const marker = server.slice(
    server.indexOf('async function postHookMarker('),
    server.indexOf('async function finishHookTurn('),
  )
  assert.ok(marker.length > 0)
  assert.match(
    marker,
    /const \{ assistantId: _unused, \.\.\.markerBody \}/,
    'the marker body comes from the component builder, which adds assistantId; strip it',
  )
})

test('show_component refuses the host posted (activity) kinds', () => {
  const start = server.indexOf('async function handleShowComponent(')
  assert.ok(start > 0)
  const body = server.slice(start, server.indexOf('\nmcp.setRequestHandler(CallToolRequestSchema', start))
  const guard = body.indexOf('isHostPostedKind(entry)')
  const build = body.indexOf('buildComponentEventMessage(')
  assert.ok(guard > 0, 'an agent must not be able to summon a marker the host posts')
  assert.ok(guard < build, 'and the refusal must come before anything is built or sent')
  assert.match(body, /HOST_POSTED_REFUSAL/)
})
