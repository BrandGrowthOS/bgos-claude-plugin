/**
 * The session mode report: the chip above the owner's composer.
 *
 * The chip is drawn from a field of the CHAT row, so the daemon has to report
 * the mode for it to appear at all. The pin that matters most here is
 * `enforced: false`: Codex has a real read only plan mode and reports true,
 * and this plugin has no mode of any kind. The app chooses the chip's words off
 * that flag, so a `true` from here would render "read only until approved" over
 * an agent launched with permissions skipped.
 *
 * Run with: npx tsx --test test/session-mode.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  CLAUDE_SESSION_MODE_ENFORCED,
  SESSION_MODES,
  buildSessionModeBody,
  sessionModePath,
  shouldReportSessionMode,
} from '../lib/session-mode.ts'
import { slashCommandSyncPath } from '../lib/slash-catalog.ts'

test('the route is pairing scoped, and there is no API key twin to send to', () => {
  assert.equal(
    sessionModePath('pairing', 9, 412),
    'integrations/assistants/9/chats/412/session-mode',
  )
  // NULL, NOT A SECOND SPELLING. This asserted
  // 'assistants/9/chats/412/session-mode' on the slash catalog's precedent,
  // and the backend serves no such route: session-mode.controller.ts declares
  // the integrations path alone, on purpose, because only the HOST may say
  // what mode the host is in. The old branch produced a PATCH that 404s and a
  // log line blaming the backend, per plan event, for every API key daemon.
  assert.equal(sessionModePath('apikey', 9, 412), null)
  // The slash catalog really does carry both spellings (the backend declares
  // @Put on each), which is why the shape was copied. It is the difference
  // that matters, so it is pinned here beside it.
  assert.ok(slashCommandSyncPath('pairing', '9').startsWith('integrations/'))
  assert.ok(!slashCommandSyncPath('apikey', '9').startsWith('integrations/'))
})

test('an API key daemon reports nothing, and remembers nothing it did not send', () => {
  // The skip is BEFORE the dedupe write in server.ts, so a daemon that cannot
  // report never records a mode as reported: if that connection were ever
  // paired, the first real report would still go out.
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const fn = server.slice(
    server.indexOf('function reportSessionMode('),
    server.indexOf('function clearPlanStatusLine('),
  )
  const skipAt = fn.indexOf('if (path === null) return')
  const rememberAt = fn.indexOf('lastSessionModeByChat.set(key, mode)')
  assert.ok(skipAt > 0, 'reportSessionMode must skip when there is no route')
  assert.ok(rememberAt > skipAt, 'the skip must come before the dedupe write')
})

test('ids are encoded, so a hostile chat id cannot walk the path', () => {
  assert.equal(
    sessionModePath('pairing', '9/../8', 'a b'),
    'integrations/assistants/9%2F..%2F8/chats/a%20b/session-mode',
  )
})

test('this channel reports enforced FALSE, and that is a statement not a default', () => {
  assert.equal(CLAUDE_SESSION_MODE_ENFORCED, false)
  assert.deepEqual(buildSessionModeBody('plan'), { mode: 'plan', enforced: false })
  assert.deepEqual(buildSessionModeBody('default'), { mode: 'default', enforced: false })
  assert.deepEqual([...SESSION_MODES], ['plan', 'default'])
})

test('an unchanged mode is not re-sent, and an unknown one always is', () => {
  // A repeat would put a PATCH on the wire per tap for no change on screen. But
  // a fresh daemon knows nothing about the chip the dead one left behind, so
  // its first report goes out whatever the value.
  assert.equal(shouldReportSessionMode(undefined, 'plan'), true)
  assert.equal(shouldReportSessionMode(undefined, 'default'), true)
  assert.equal(shouldReportSessionMode('plan', 'plan'), false)
  assert.equal(shouldReportSessionMode('plan', 'default'), true)
  assert.equal(shouldReportSessionMode('default', 'plan'), true)
})

test('the daemon never reads a mode back to decide anything', () => {
  // Stage 1's rule: the daemon offers, the server decides. The mode is a report
  // in one direction; nothing in lib/ may branch on a mode read from the server.
  const source = readFileSync(new URL('../lib/session-mode.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.ok(
    !/bgosGet|fetch\(|sessionModeOf|readSessionMode/.test(source),
    'session-mode.ts must stay pure: paths and bodies, no reads',
  )
})

test('a failed report is never fatal, and never leaves a false memory behind', () => {
  // The chip is cosmetic and the route may not exist yet on an older backend,
  // so the PATCH is fire and forget. The part that is NOT cosmetic is the
  // dedupe: remembering a value the server never received would suppress every
  // later attempt, and the chip would be wrong until a restart.
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const fn = server.slice(
    server.indexOf('function reportSessionMode('),
    server.indexOf('function clearPlanStatusLine('),
  )
  assert.ok(fn.length > 0, 'reportSessionMode must be declared before clearPlanStatusLine')
  assert.match(fn, /lastSessionModeByChat\.delete\(key\)/)
  assert.match(fn, /\.catch\(/)
})
