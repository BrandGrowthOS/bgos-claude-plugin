/**
 * A driver object that is gone is the privacy owner's own refusal, never a throw.
 *
 * WHY THIS FILE EXISTS. Playwright's in process connection looks an object up
 * by its guid and reads a field off the answer, so for an object the driver
 * has let go of (a tab that closed as it opened) it throws a bare TypeError:
 * "Cannot read properties of undefined (reading '_object')". The desktop saw
 * exactly that while admitting a new tab (GlitchTip hoai-desktop-main 1631).
 * The privacy owner had already counted the page as protected, the throw
 * stopped it before the guarded reads were installed, and it never tried
 * again: reproduced in real Chromium on the BGOS side, the next snapshot of
 * that tab answered with the page as it was, a typed password included.
 *
 * `lib/browser-host-core/answer-privacy.js` here is an OLDER copy of the BGOS
 * file (vendor.json says which commit) and had the same twelve lookups, so it
 * takes the same change on its own bytes. These are the BGOS cases of
 * `__tests__/answer-privacy.gone-object.test.js`, run against this copy. The
 * real Chromium case lives on the BGOS side, where the engine is.
 *
 * No em dashes or en dashes anywhere in this file.
 *
 * Run: npx tsx --test test/browser-host-core.gone-object.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import privacy from '../lib/browser-host-core/answer-privacy.js'
import fixture from './privacy-fixture.cjs'

const { AnswerPrivacy, UNREADABLE } = privacy
const { privacyPage } = fixture

// Exactly what playwright-core does for a guid it no longer holds.
const lostByTheDriver = (): never => (new Map<string, { _object: never }>().get('gone') as { _object: never })._object
const REFUSED = { code: 'privacy_unavailable', message: UNREADABLE }
const RAW_TREE = '- textbox "Account password": made-up-value-of-the-field'

type Lookup = (object: unknown) => unknown

// A page with reads of its own, as Playwright hands one over. `raw` counts every unguarded read that ran.
function livePage(lookup: Lookup) {
  const raw = { tree: 0, picture: 0 }
  const frame = {}
  const page: any = {
    _connection: { toImpl: lookup },
    mainFrame: () => frame, frames: () => [frame], locator: () => ({}), url: () => 'https://example.test/',
    ariaSnapshot: async () => { raw.tree++; return RAW_TREE },
    screenshot: async () => { raw.picture++; return Buffer.from('picture') },
  }
  return { page, frame, raw }
}
// The driver's side of a page: one top session and a map the driver adds a session to for each frame in another process.
function driverSide() {
  const client = () => ({ on() {}, send: async () => ({}) })
  const delegate = { _mainFrameSession: { _client: client() }, _sessions: new Map<string, unknown>() }
  return { delegate, client }
}

test('the double throws what Playwright throws', () => {
  assert.throws(lostByTheDriver, { name: 'TypeError', message: "Cannot read properties of undefined (reading '_object')" })
})

test('a tab the driver let go of as it opened is admitted without a throw and keeps its guarded reads', async () => {
  const owner = new AnswerPrivacy()
  const { page, raw } = livePage(lostByTheDriver)
  assert.doesNotThrow(() => owner.protectPage(page))
  await assert.rejects(page.ariaSnapshot(), REFUSED)
  await assert.rejects(page.screenshot(), REFUSED)
  await assert.rejects(page.ariaSnapshotJSON(), REFUSED)
  assert.deepEqual(raw, { tree: 0, picture: 0 }, 'an unguarded read ran')
})

test('its tab snapshot is guarded too', async () => {
  const owner = new AnswerPrivacy()
  const { page, raw } = livePage(lostByTheDriver)
  // Playwright's Tab builds its snapshot from the page's own tree read.
  const tab: any = { page, captureSnapshot: async () => ({ ariaSnapshot: await page.ariaSnapshot(), events: [] }) }
  assert.doesNotThrow(() => owner.protectTab(tab))
  await assert.rejects(tab.captureSnapshot(), REFUSED)
  assert.equal(raw.tree, 0, 'an unguarded read ran')
})

test("a read of such a page answers the owner's own refusal, never Playwright's words", async () => {
  const owner = new AnswerPrivacy()
  const { page } = livePage(lostByTheDriver)
  await assert.rejects(owner.read(page), REFUSED)
  owner.protectPage(page)
  await assert.rejects(owner.read(page), REFUSED)
})

// BGOS contract 3.50: a failed read fails one call, and a later read retries.
test('nothing is kept from a watch that could not start: the next read asks the driver again', async () => {
  const owner = new AnswerPrivacy()
  const page: any = privacyPage(['a value of the page'])
  const real = page._connection.toImpl as Lookup
  let lost = true, asked = 0
  page._connection.toImpl = (object: unknown) => { asked++; return lost ? lostByTheDriver() : real(object) }
  await assert.rejects(owner.read(page), REFUSED)
  await assert.rejects(owner.read(page), REFUSED)
  assert.equal(asked, 2, 'a refused read asks the driver once and stops there')
  lost = false
  const facts = await owner.read(page)
  assert.deepEqual(facts.values, ['a value of the page'])
})

test('any failure to start watching a tab refuses its reads, whatever threw', async () => {
  const owner = new AnswerPrivacy()
  // A driver page with no session map: the watch cannot hook the sessions the driver adds later.
  const { page, raw } = livePage(() => ({ delegate: { _mainFrameSession: { _client: { on() {}, send: async () => ({}) } } } }))
  assert.doesNotThrow(() => owner.protectPage(page))
  await assert.rejects(page.ariaSnapshot(), REFUSED)
  await assert.rejects(owner.read(page), REFUSED)
  assert.equal(raw.tree, 0, 'an unguarded read ran')
})

test('a frame session the driver adds after the top frame is gone does not throw into the driver, and the tab is held as when a watch fails a moment later', async () => {
  const owner = new AnswerPrivacy()
  const side = driverSide()
  let topGone = false
  const { page, frame } = livePage((object) => {
    if (object === frame) return topGone ? lostByTheDriver() : { _id: 'top-frame' }
    return { delegate: side.delegate }
  })
  owner.protectPage(page)
  assert.equal(owner.personMode(page), false)
  topGone = true
  const session = { _client: side.client() }
  // This is Playwright's own call, from inside its target attach: a throw here lands in the driver.
  assert.doesNotThrow(() => side.delegate._sessions.set('frame-session', session))
  assert.equal(side.delegate._sessions.get('frame-session'), session)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(owner.personMode(page), true, 'a frame session nobody watches did not hold the tab')
  await assert.rejects(owner.read(page), REFUSED)
})

test('a session that is there at admission and cannot be watched fails the watch, and the tab is held', async () => {
  const owner = new AnswerPrivacy()
  const side = driverSide()
  side.delegate._sessions.set('first-session', { _client: side.client() })
  const { page, frame, raw } = livePage((object) => (object === frame ? lostByTheDriver() : { delegate: side.delegate }))
  assert.doesNotThrow(() => owner.protectPage(page))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(owner.personMode(page), true)
  await assert.rejects(owner.read(page), REFUSED)
  await assert.rejects(page.ariaSnapshot(), REFUSED)
  assert.equal(raw.tree, 0, 'an unguarded read ran')
})

test('kept: a child frame the driver let go of costs the reply that frame, never the page', async () => {
  const page: any = privacyPage(['a value of the main frame'])
  const main = page.mainFrame(), child = { frameElement: async () => { throw new Error('detached') } }
  const real = page._connection.toImpl as Lookup
  page.frames = () => [main, child]
  page._connection.toImpl = (object: unknown) => (object === child ? lostByTheDriver() : real(object))
  const facts = await new AnswerPrivacy().read(page)
  assert.deepEqual(facts.unread, [child])
  assert.deepEqual(facts.values, ['a value of the main frame'])
})

test("kept: a fenced read of a page whose top frame is gone is the owner's refusal", async () => {
  const owner = new AnswerPrivacy()
  const page: any = privacyPage()
  const real = page._connection.toImpl as Lookup
  page._connection.toImpl = (object: unknown) => (object === page.mainFrame() ? lostByTheDriver() : real(object))
  owner.fenced = true
  await assert.rejects(owner.read(page), REFUSED)
})

test('kept: a pure fixture with no driver behind it still reads', async () => {
  const owner = new AnswerPrivacy()
  const page = privacyPage(['123456'])
  assert.equal(await owner.watchPersonInput(page), undefined)
  const facts = await owner.read(page)
  assert.deepEqual(facts.values, ['123456'])
  assert.equal(owner.text('a 123456 b'), 'a (masked) b')
})

test('every lookup of a driver object goes through the one guarded place', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'lib', 'browser-host-core', 'answer-privacy.js'), 'utf8')
    .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n')
  const lookups = source.match(/\btoImpl\b/g) || []
  assert.equal(lookups.length, 1, `toImpl is named ${lookups.length} times outside comments`)
  assert.match(source, /const implOf = \(page, object\) => \{ try \{ return page\?\._connection\?\.toImpl\?\.\(object\); \} catch \{ return null; \} \};/)
})
