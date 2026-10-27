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
  assert.match(caseBody('ask_user_input'), /askTracker\.hold\(askKey, deadline \+ ASK_HOLD_MARGIN_MS\)/)
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

test('fourth review, Important 2: a daemon not armed for delivery (passive, or still arming) reads the file on the ask tick, so it sees the asker end when it does', () => {
  // Fifth review, Minors 1 and 2: an armed daemon draining for an update reads too, and a throw is caught.
  assert.match(server, /setInterval\(\(\) => \{\n\s*if \(!channelArmed \|\| updateDrainMode\) refreshAskTracker\('tick'\)\n\s*\}, ASK_TICK_MS\)\.unref\(\)/)
  const fn = fnBody('function refreshAskTracker(via: string): void {', 600)
  assert.match(fn, /try \{\n\s*askTracker\.refresh\(\)\n\s*\} catch \(err\) \{\n\s*log\(/)
})

test('fourth review, Important 2: a passive daemon that takes the connection reads the file at once, before the slow arm', () => {
  const at = server.indexOf('promoting from passive to active and arming delivery')
  assert.ok(at > 0)
  const taken = server.lastIndexOf('        lockHeld = true\n', at)
  assert.ok(taken > 0)
  assert.match(server.slice(taken, at), /lockHeld = true\n(\s*\/\/[^\n]*\n)*\s*refreshAskTracker\('promotion'\)\n/)
})
