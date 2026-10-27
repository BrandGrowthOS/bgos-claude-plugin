/**
 * The review of PR 1 (askcard), read off server.ts. Each pin names the
 * finding it closes; the behaviour itself is in lib/ask-tracker.ts and its
 * tests, and the rig (stub backend, real daemon) runs every path end to end.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function caseBody(name: string): string {
  const at = server.indexOf(`\n    case '${name}': {`)
  assert.ok(at > 0, `case '${name}'`)
  return server.slice(at, server.indexOf("\n    case '", at + 10))
}

function fnBody(signature: string, length = 4000): string {
  const at = server.indexOf(signature)
  assert.ok(at > 0, signature)
  return server.slice(at, at + length)
}

test('Important 4: a blocking wait the client cancelled hands its group to the event, never to a dropped result', () => {
  assert.match(server, /mcp\.setRequestHandler\(CallToolRequestSchema, \(req, extra\) => \{/)
  const ask = caseBody('ask_user_input')
  assert.match(ask, /while \(Date\.now\(\) < deadline && !askTracker\.isComplete\(askKey\) && !extra\.signal\.aborted\)/)
  // In the daemon holding the connection; a passive one retires the card instead (second review of #282, Important 3).
  const cancelled = ask.indexOf('if (extra.signal.aborted && lockHeld) {')
  assert.ok(cancelled > 0, 'the cancel is checked after the wait')
  assert.ok(cancelled < ask.indexOf('askTracker.delivered(askKey)'), 'before a result could mark the group delivered')
  assert.match(ask.slice(cancelled, cancelled + 600), /announceCompleteAsks\('wait cancelled'\)/)
})

test('Important 1: the hold is on disk with its deadline, so another daemon never announces a group this wait owns', () => {
  assert.match(caseBody('ask_user_input'), /askTracker\.hold\(askKey, deadline \+ HTTP_TIMEOUT_MS \+ ASK_HOLD_MARGIN_MS\)/)
})

test('Important 1: only the armed daemon holding the pairing announces, from the file as it stands now', () => {
  const body = fnBody('function announceCompleteAsks(via: string): void {')
  assert.match(body, /^function announceCompleteAsks\(via: string\): void \{\n(\s*\/\/[^\n]*\n)*\s*if \(!channelArmed \|\| !lockHeld \|\| updateDrainMode\) return\n\s*askTracker\.refresh\(\)\n/)
})

test('Important 1: every reconcile pass starts from the file, and the arm reads it again', () => {
  assert.match(fnBody('async function reconcilePendingAsks(via: string, opts: { dueOnly?: boolean } = {}): Promise<void> {'), /askTracker\.refresh\(\)/)
  const step5b = fnBody('// Step 5b: pending ask groups', 2400)
  assert.match(step5b, /askTracker\.refresh\(\)/)
})

test('Important 2: a timer reads each pending group at its own cadence (askReadIntervalMs)', () => {
  const step5b = fnBody('// Step 5b: pending ask groups', 2400)
  assert.match(step5b, /reconcilePendingAsks\('timer', \{ dueOnly: true \}\)/)
  assert.match(step5b, /ASK_TICK_MS/)
  const reconcile = fnBody('async function reconcilePendingAsks(via: string, opts: { dueOnly?: boolean } = {}): Promise<void> {')
  assert.match(reconcile, /askReadIntervalMs\(ask, now\)/)
})

test('Minor 10: an announce in a share recipient\'s chat is refused and dropped, on every door', () => {
  const body = fnBody('function announceCompleteAsks(via: string): void {')
  assert.match(body, /ownerAnnounceRefused\(\{ lanesOn: lanesOnForThisAgent, chatIsOthers: chatOwnership\.isOthers\(ask\.chatId\) \}\)/)
})

test('Minor 6: withdraw_ask reads the group first and retires only the questions still open', () => {
  const body = caseBody('withdraw_ask')
  const read = body.indexOf('await readAskGroup(ask)')
  assert.ok(read > 0 && read < body.indexOf('bgosPatch('), 'read before any PATCH')
  assert.match(body, /ask\.questions\.filter\(\(q\) => ask\.answers\[String\(q\.messageId\)\] === undefined\)/)
})

test('Minor 9: a card whose post failed half way retires the questions it did post', () => {
  const body = caseBody('ask_user_input')
  const failed = body.lastIndexOf('} catch (err) {', body.indexOf('ask_user_input failed:'))
  assert.ok(failed > 0)
  assert.match(body.slice(failed, failed + 1200), /retireOrphanAskRows\(postedIds\)/)
})

test('recheck of #282, pid reuse: every daemon, armed, passive or draining, says on the ask tick that it runs (its lease), and a throw is caught', () => {
  assert.match(server, /setInterval\(\(\) => heartbeatAskTracker\(\), ASK_TICK_MS\)\.unref\(\)/)
  const fn = fnBody('function heartbeatAskTracker(): void {', 600)
  assert.match(fn, /try \{\n\s*askTracker\.heartbeat\(\)\n\s*\} catch \(err\) \{\n\s*log\(/)
  // Fifth review, Minor 2: the promotion's read is caught too.
  const refresh = fnBody('function refreshAskTracker(via: string): void {', 600)
  assert.match(refresh, /try \{\n\s*askTracker\.refresh\(\)\n\s*\} catch \(err\) \{\n\s*log\(/)
})

test('recheck of #282, item 1: every reconcile pass (boot, connect, the timer) retires the cards no daemon may announce', () => {
  const reconcile = fnBody('async function reconcilePendingAsks(via: string, opts: { dueOnly?: boolean } = {}): Promise<void> {', 2400)
  const announce = reconcile.indexOf('announceCompleteAsks(via)')
  const retire = reconcile.indexOf('await retireOrphanedAsks(via)')
  assert.ok(announce > 0 && retire > announce, 'after the announce, inside the pass')
  assert.ok(retire < reconcile.indexOf('askReconcileRunning = false'))
  const fn = fnBody('async function retireOrphanedAsks(via: string): Promise<void> {', 600)
  assert.match(fn, /if \(!channelArmed \|\| !lockHeld \|\| updateDrainMode\) return/)
})

test('second fresh review of the recheck, Minors 1 and 2: a retire counts from the last taking of the connection, and asks the lock file before each card', () => {
  const fn = fnBody('async function retireOrphanedAsks(via: string): Promise<void> {', 1600)
  assert.match(fn, /for \(const ask of askTracker\.retirable\(connectedSince\)\) \{\n(\s*\/\/[^\n]*\n)*\s*if \(!orphanRetireMayRun\(\)\) return\n/)
  // Third fresh review, Minor 1: and again after the read, before the PATCH.
  assert.match(fn, /await readAskGroup\(ask\)[\s\S]*?if \(!orphanRetireMayRun\(\)\) return\n\s*const open = /)
  assert.match(
    fnBody('function orphanRetireMayRun(): boolean {', 300),
    /return channelArmed && lockHeld && !updateDrainMode && pairingLockNamesThisDaemon\(\)/,
  )
  assert.match(fnBody('function pairingLockNamesThisDaemon(): boolean {', 300), /parseLockRecord\(readFileSync\(PAIRING_LOCK_PATH, 'utf8'\)\)\?\.pid === process\.pid/)
  // Every place this daemon takes the connection stamps it.
  for (const taken of ['lockHeld = true\n', 'channelArmed = true\n']) {
    let at = server.indexOf(taken)
    let seen = 0
    while (at >= 0) {
      assert.match(server.slice(at + taken.length, at + taken.length + 80), /^\s*connectedSince = Date\.now\(\)\n/, `${taken.trim()} at ${at}`)
      seen++
      at = server.indexOf(taken, at + 1)
    }
    assert.ok(seen >= 2, `${taken.trim()} sites: ${seen}`)
  }
})

test('second fresh review of the recheck, Minor 3: a passive wait holds its card again before it retires it', () => {
  const body = caseBody('ask_user_input')
  assert.match(body, /askTracker\.hold\(askKey, Date\.now\(\) \+ askPassiveRetireHoldMs\(ask\.questions\.length\)\)\n\s*askTracker\.beginWithdraw\(askKey\)/)
})

test('fourth review, Important 2: a passive daemon that takes the connection reads the file at once, before the slow arm', () => {
  const at = server.indexOf('promoting from passive to active and arming delivery')
  assert.ok(at > 0)
  const taken = server.lastIndexOf('        lockHeld = true\n', at)
  assert.ok(taken > 0)
  assert.match(server.slice(taken, at), /lockHeld = true\n\s*connectedSince = Date\.now\(\)\n(\s*\/\/[^\n]*\n)*\s*refreshAskTracker\('promotion'\)\n/)
})

test('lease follow-up of #282, item 2: the retire keeps a live asker\'s card on file for it, and every daemon\'s ask tick tells its own session of its retired cards', () => {
  const retire = fnBody('async function retireOrphanedAsks(via: string): Promise<void> {', 4000)
  // The connected daemon's own lane verdict decides whether the asker is told (fresh review of the follow-up, Important 2).
  assert.match(retire, /const refused = ownerAnnounceRefused\(\{ lanesOn: lanesOnForThisAgent, chatIsOthers: chatOwnership\.isOthers\(ask\.chatId\) \}\)/)
  assert.match(retire, /if \(!askTracker\.retire\(ask\.askId, \{ withdrawn, tellAsker: !refused \}\)\) continue/)
  assert.match(retire, /sendAskWithdrawn\(ask, withdrawn, \{ toAsker: false, via, askerEnded \}\)/)
  const tick = fnBody('function heartbeatAskTracker(): void {', 600)
  assert.match(tick, /\n\s*tellRetiredOwnAsks\(\)\n\}/)
  const tell = fnBody('function tellRetiredOwnAsks(): void {', 900)
  assert.match(tell, /send: \(ask, withdrawn\) => sendAskWithdrawn\(ask, withdrawn, \{ toAsker: true, via: 'the ask tick' \}\)/)
  assert.doesNotMatch(tell, /channelArmed|lockHeld/, 'the asker is passive by then')
})

test('lease follow-up of #282, rig: the retire still logs the line it always did (the rig and anyone reading the log match it)', () => {
  const send = fnBody('function sendAskWithdrawn(ask: PendingAsk, withdrawn: number, opts: AskWithdrawnOpts): Promise<void> {', 2500)
  assert.match(send, /log\(`ask_withdrawn: retired group \$\{ask\.askId\} in chat \$\{ask\.chatId\} and told this session/)
})

test('gaps after #284, gap 1: the ask tick tells through lib/ask-retired-tell.ts with this session\'s channel presence, and a failed send rejects so the next tick sends it again', () => {
  const tell = fnBody('function tellRetiredOwnAsks(): void {', 900)
  assert.match(tell, /tellRetiredOwnOnTick\(\{\s*tracker: askTracker,\s*channelLoaded: channelPresence\(\)\.loaded,/)
  const send = fnBody('function sendAskWithdrawn(ask: PendingAsk, withdrawn: number, opts: AskWithdrawnOpts): Promise<void> {', 2500)
  assert.match(send, /return trackMessageOperation\(/)
  assert.match(send, /\.catch\(\(err\) => \{\n\s*log\(`ask_withdrawn: group \$\{ask\.askId\} was retired, but telling this session failed: \$\{err\}`\)\n\s*throw err\n/)
  // The connected session's own tell has nobody to retry it: its failure is logged and dropped.
  const retire = fnBody('async function retireOrphanedAsks(via: string): Promise<void> {', 4000)
  assert.match(retire, /sendAskWithdrawn\(ask, withdrawn, \{ toAsker: false, via, askerEnded \}\)\.catch\(\(\) => \{/)
})

test('gaps after #284, gap 1: every tool result of this daemon carries the ask_withdrawn its session could not hear on a channel that is not loaded, wrapped as the event is', () => {
  const handlerAt = server.indexOf('mcp.setRequestHandler(CallToolRequestSchema, (req, extra) => {')
  const dispatch = server.indexOf('\n  return trackMessageOperation(async () => {\n  const rawArgs', handlerAt)
  assert.ok(handlerAt > 0 && dispatch > handlerAt, 'the dispatch of every tool')
  const end = server.indexOf('\n  }).then(withRetiredOwnAskNotes)\n})\n', dispatch)
  assert.ok(end > dispatch, 'the dispatch result goes through withRetiredOwnAskNotes')
  // The first top level close after the dispatch is the handler's own, right after the then.
  assert.equal(server.indexOf('\n})\n', dispatch), end + '\n  }).then(withRetiredOwnAskNotes)'.length, 'inside the same handler')
  const notes = fnBody('function withRetiredOwnAskNotes<', 2000)
  assert.match(notes, /retiredOwnNotes\(\{\s*tracker: askTracker,\s*channelLoaded: channelPresence\(\)\.loaded,/)
  assert.match(notes, /askWithdrawnContent\(ask, withdrawn, \{ toAsker: true \}\)/)
  // One builder for the event and the note: the lane check and the private tap wrapping are the event's.
  const content = fnBody('function askWithdrawnContent(', 2000)
  assert.match(content, /ownerAnnounceRefused\(\{ lanesOn: lanesOnForThisAgent, chatIsOthers: chatOwnership\.isOthers\(ask\.chatId\) \}\)/)
  assert.match(content, /privateTapCard\(/)
  assert.match(fnBody('function sendAskWithdrawn(ask: PendingAsk, withdrawn: number, opts: AskWithdrawnOpts): Promise<void> {', 2500), /askWithdrawnContent\(ask, withdrawn, opts\)/)
})

test('gaps after #284, gap 2: the connected session is told why the card was retired (its asker ended, or runs on without the connection)', () => {
  const retire = fnBody('async function retireOrphanedAsks(via: string): Promise<void> {', 4000)
  const at = retire.indexOf('const askerEnded = askTracker.askerEnded(ask)')
  assert.ok(at > 0, 'read before the retire forgets the group')
  assert.ok(at < retire.indexOf('askTracker.retire(ask.askId'))
  assert.match(fnBody('function askWithdrawnContent(', 2000), /askerEnded: opts\.askerEnded/)
})
