/**
 * Every way page content reaches the agent on this machine's host, on the real core, the real
 * engine and a real Chromium, and that a normal site still browses. Made up values on loopback.
 * No em or en dashes in this file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BrowserHostCore, ChromiumEngine, DEFAULT_CAPS, listTools, resolveChromeExecutable, servedBrowserTools } from '../bin/hoai-browser-host.mjs'
import { GateKeeper } from '../lib/browser-gate.mjs'
import { CSRF, serveSite } from './browser-site-fixture.ts'

const chrome = resolveChromeExecutable()
const skip = chrome.path ? false : 'no Chrome or Chromium is installed on this machine'
const OWNER = { assistantId: 42, assistantName: 'Atlas', principal: 'user-owner_1' }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const textOf = (reply: any) => (reply?.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
const hasImage = (reply: any) => (reply?.content || []).some((part: any) => part.type === 'image')
const refOf = (tree: string, name: string) => new RegExp(`${name}[^\\n]*?\\[ref=((?:f\\d+)?e\\d+)\\]`).exec(tree)?.[1]
// A wait for what a test checks, with a deadline that fails in plain words instead of the test running out of time.
const within = <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(what)), ms) })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

async function rig(t: any, html?: any, { answer = 'deny', write = 'allow', navigate = 'allow', path = '/', gates: gated = true }: any = {}) {
  const site = await serveSite(typeof html === 'string' ? ((p: string) => (p === '/' ? html : undefined)) : html)
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b9r-')))
  const engine: any = new ChromiumEngine({ executable: chrome.path!, profileDir: join(home, 'browser', 'k'), outputDir: join(home, 'output', 'k'), scope: 'fixture' })
  await engine.start()
  const cards: any[] = []
  const slot: any = { engine, paths: { key: 'k' } }
  const pool: any = { acquire: async () => slot, peek: () => slot, slotKey: () => 'k', pathsFor: () => slot.paths, release: async () => true }
  const gates = gated ? new GateKeeper({ postCard: async (card: any) => { cards.push(card); return true }, readGate: async (gateId: string) => (answer === 'pending' ? { gateId, state: 'pending', status: 'pending' } : { gateId, state: 'answered', status: 'answered', answered: true, choice: answer, answer }), randomBytes: (n: number) => Buffer.alloc(n, 7), sleep: async () => {}, log: () => {} } as any) : undefined
  const core: any = new BrowserHostCore({ pool, browserTools: servedBrowserTools(await listTools({ caps: DEFAULT_CAPS, outputDir: join(home, 'tools') })), deviceLabel: 'Build box', gates, isOwnerPrincipal: () => true } as any)
  core._settingsFor = () => ({})
  core._grantsFor = () => ({ [site.origin]: { navigate, write, access: 'allow' } })
  t.after(async () => { await engine.stop().catch(() => {}); await site.close(); rmSync(home, { recursive: true, force: true }) })
  await engine.callTool('browser_navigate', { url: `${site.origin}${path}` })
  return { core, engine, site, cards, clicks: site.clicks, page: engine.selectedPage(), origin: site.origin, call: (name: string, args: any = {}) => core.callTool(OWNER, name, args) }
}

test('P1-4 a gate reads the page, never the net: a hidden field beside a button changes no card', { skip, timeout: 60_000 }, async (t) => {
  const r = await rig(t, `<form onsubmit="return false"><input type=hidden name=token value="Delete account"><button onclick="fetch('/clicked/d')">Delete account</button></form><div><div><button id="show-password">
  <svg></svg>
</button><button onclick="fetch('/clicked/e')">Delete account two</button></div></div>`)
  const tree = textOf(await r.call('browser_snapshot'))
  assert.doesNotMatch(tree, /\(masked\)- /, 'every line is whole')
  for (const name of ['Delete account two', 'button "Delete account"']) {
    const ref = refOf(tree, name)
    assert.ok(ref, tree)
    await r.call('browser_click', { target: ref, element: 'Show the report', wait_seconds: 1 })
    await pause(150)
  }
  assert.deepEqual(r.clicks, [], 'neither delete ran')
  assert.equal(r.cards.length, 2)
  for (const card of r.cards) assert.equal(card.kind, 'sensitive')
  assert.match(r.cards[0].summary, /Delete account two/)
  assert.doesNotMatch(r.cards[0].summary, /^click Show the report/, 'the agent\'s words never name the target')
})

test('P1-5 the host\'s own refusals reach the agent, with the gate id and the do not retry', { skip, timeout: 60_000 }, async (t) => {
  const r = await rig(t, '<button>Delete account</button>')
  const tree = textOf(await r.call('browser_snapshot'))
  const denied = await r.call('browser_click', { target: refOf(tree, 'Delete account'), element: 'x', wait_seconds: 1 })
  assert.equal(denied.isError, true)
  assert.match(textOf(denied), /policy_denied/, textOf(denied))
  assert.match(textOf(denied), /do not retry/)
  r.core._permit = async () => ({ parked: true, gateId: 'gate_123', summary: 'Delete account', expiresAt: 'later' })
  const parked = await r.call('browser_click', { target: refOf(tree, 'Delete account'), element: 'x' })
  assert.match(textOf(parked), /gate_parked/, textOf(parked))
  const gateId = /gateId "([^"]+)"/.exec(textOf(parked))?.[1]
  assert.ok(gateId, 'the agent has the id it needs to keep waiting')
  assert.match(textOf(await r.call('browser_snapshot', { target: 'input[type=password]' })), /host element refs/)
  assert.match(textOf(await r.call('browser_nonsense')), /Unknown tool/)
  assert.match(textOf(await r.call('hoai_browser_wait_gate', { gate_id: 'gate_nope' })), /No permission request/)
})

// P1-6 was one case that proved five things on one browser, one after the other, and on a Windows runner it took 174.6 s
// of its 180 s (main, run 44091603735). Nearly all of it was the first part, frames that come and go: before each read
// the privacy owner waited until the person input watcher had no work in flight, and a page that added an iframe every
// 10 ms kept adding work, so on a slow machine a read waited until it happened to find a gap. Measured on Linux with the
// browser on one core: one read waited 58.6 s. The product fix (lib/browser-host-core/answer-privacy.js, from BGOS
// d9d49f02b9 and e7f147df0d) waits only for the work begun before the read. Each claim is now its own test with its own
// browser, so one slow part cannot use up another's time, and every wait a claim depends on fails in plain words.

// The longest a whole read may take by its own bounds (the read, the tree, the read after it) and a margin, so a read
// that is only slow is not called stuck.
const READ_COMES_BACK_MS = 30_000

test('P1-6 a slow frame leaves the page readable', { skip, timeout: 60_000 }, async (t) => {
  const r = await rig(t, undefined, { path: '/plain' })
  r.page.goto(`${r.origin}/slow`, { waitUntil: 'commit' }).catch(() => {})
  await pause(400)
  const slow = textOf(await within(r.call('browser_snapshot'), READ_COMES_BACK_MS, `a read did not come back within ${READ_COMES_BACK_MS / 1000} s on a page whose frame never loads`))
  assert.match(slow, /Article with a slow embed/, slow)
})

test('P1-6 frames that come and go lock nothing: every read on the page reads it, and so does the read after', { skip, timeout: 90_000 }, async (t) => {
  // Before the rig, so the churn stops before the browser closes on any failure.
  let churning = true, gone = 0, broke: any = null
  t.after(() => { churning = false })
  const r = await rig(t, '<h1>Ads</h1><div id=s></div>')
  // Ad frames come and go through every read: each one is added once the last is reported gone, so the page never makes
  // them faster than this machine can report them gone. A page timer every 10 ms measured the machine, not the reads.
  // Frames that never stop are the next test's, on a chain.
  const churn = (async () => {
    while (churning) {
      const detached = new Promise(resolve => r.page.once('framedetached', resolve))
      await r.page.evaluate(() => { const f = document.createElement('iframe'); f.srcdoc = '<p>ad</p>'; document.querySelector('#s')!.appendChild(f); setTimeout(() => f.remove(), 15) })
      await within(detached, 10_000, 'an ad frame the page removed was never reported gone')
      gone += 1
    }
  })()
  churn.catch((error) => { broke = error })
  // At least 10 reads and at least 10 frames gone, whichever comes last, so neither count races the other.
  for (let reads = 0; reads < 10 || gone < 10; reads += 1) {
    if (broke) throw broke
    const tree = textOf(await within(r.call('browser_snapshot'), READ_COMES_BACK_MS, `read ${reads + 1} did not come back within ${READ_COMES_BACK_MS / 1000} s while frames came and went`))
    assert.match(tree, /heading "Ads"/, tree)
  }
  churning = false
  await churn
  if (broke) throw broke
  await r.page.setContent('<h1>After the ads</h1>')
  assert.match(textOf(await r.call('browser_snapshot')), /heading "After the ads"/, 'the read after the frames stopped')
})

// Frames on a chain: the watcher's answer about each new frame is held until the next frame's is held too, so its work
// is never finished, however fast or slow the machine is. A slow machine reached this state by itself on a page that
// made a frame every 10 ms (the old P1-6 case, near its limit on Windows). Here it is the same every run. A test can
// also pin the answers held right now: the chain keeps going but leaves those for the test to release.
// Ported from BGOS frontend/electron-app/agent-browser/__tests__/browser-answer-routes.chromium.test.js (e7f147df0d).
function framesThatNeverStop(page: any, client: any) {
  const connection = client._connection, rawSend = connection._rawSend, onMessage = client._onMessage
  const asked = new Map<number, number>(), held = new Map<number, { order: number, release: () => void }>(), pinned = new Set<number>(), waiters = new Set<() => void>()
  let order = 0, stopped = false
  const wake = () => { for (const waiter of [...waiters]) waiter() }
  const until = (done: () => boolean) => new Promise<void>(resolve => {
    const check = () => { if (stopped || done()) { waiters.delete(check); resolve() } }
    waiters.add(check)
    check()
  })
  connection._rawSend = function (sessionId: string, method: string, params: any) {
    const id = rawSend.call(this, sessionId, method, params)
    if (sessionId === client._sessionId && method === 'Page.createIsolatedWorld' && params?.worldName?.startsWith('hoaiPersonWorld')) asked.set(id, ++order)
    return id
  }
  client._onMessage = function (message: any) {
    if (!asked.has(message.id)) return onMessage.call(this, message)
    const askedAs = asked.get(message.id)!
    asked.delete(message.id)
    held.set(message.id, { order: askedAs, release: () => { held.delete(message.id); onMessage.call(this, message) } })
    wake()
  }
  const newest = () => Math.max(0, ...[...held.values()].map(answer => answer.order))
  const addFrame = () => page.evaluate(() => { document.querySelector('#s')!.firstChild?.remove(); document.querySelector('#s')!.appendChild(document.createElement('iframe')) })
  let begun!: () => void
  const started = new Promise<void>(resolve => { begun = resolve })
  const running = (async () => {
    await addFrame()
    await until(() => held.size > 0)
    begun()
    while (!stopped) {
      const earlier = [...held.keys()].filter(id => !pinned.has(id)), mark = order
      await addFrame()
      await until(() => newest() > mark)
      // A pin can land while this turn waits, so it is checked at the release, not when `earlier` was listed.
      for (const id of earlier) if (!pinned.has(id)) held.get(id)?.release()
    }
  })()
  running.catch(() => {})
  return {
    // The first frame's answer is held: from here on the watcher always has a frame it is still waiting on.
    started: Promise.race([started, running]),
    // The answers held now stay held until releasePinned. Returns the order they were asked up to.
    pin: () => { for (const id of held.keys()) pinned.add(id); return { order, count: pinned.size } },
    releasePinned: () => { for (const id of [...pinned]) held.get(id)?.release(); pinned.clear() },
    // An answer to a frame asked for after that order is held.
    heldAfter: (mark: number) => until(() => newest() > mark),
    // Is an answer still held for a frame asked for after that order?
    holdsAfter: (mark: number) => [...held.values()].some(answer => answer.order > mark),
    stop: async () => {
      stopped = true
      wake()
      await running.catch(() => {})
      connection._rawSend = rawSend
      client._onMessage = onMessage
      pinned.clear()
      for (const answer of [...held.values()]) answer.release()
    },
  }
}

// A read that waits for frames that came after it started never comes back, so this is the plain words for that.
const CHAIN_READ_COMES_BACK_MS = 60_000
const CHAIN_STARTS_MS = 10_000

test('P1-6 a read waits only for the frames it started with, so a page that keeps making frames cannot hold it', { skip, timeout: 120_000 }, async (t) => {
  const r = await rig(t, '<h1>Steady</h1><div id=s></div>')
  assert.match(textOf(await r.call('browser_snapshot')), /heading "Steady"/)
  const client = (await r.page._connection.toImpl(r.page.mainFrame()).utilityContext()).delegate._client
  const frames = framesThatNeverStop(r.page, client)
  t.after(() => frames.stop())
  await within(frames.started, CHAIN_STARTS_MS, `no new frame's watcher answer was seen within ${CHAIN_STARTS_MS / 1000} s, so this test could not keep frames coming`)
  // Every wait the read makes on the watcher, and whether it has ended.
  // ChromiumEngine drives the shared PlaywrightEngine, which owns the privacy reads.
  const privacy = r.engine._engine._privacy, watch = privacy.watchPersonInput, waits: { ended: boolean }[] = []
  let firstWait!: () => void
  const waited = new Promise<void>(resolve => { firstWait = resolve })
  privacy.watchPersonInput = function (...args: any[]) {
    const out = watch.apply(this, args), row = { ended: false }
    waits.push(row)
    Promise.resolve(out).then(() => { row.ended = true }, () => { row.ended = true })
    firstWait()
    return out
  }
  t.after(() => { privacy.watchPersonInput = watch })

  // One side: the frame work begun before the read holds it. Two newer frames arrive and the read still waits.
  const before = frames.pin()
  assert.ok(before.count > 0, 'a frame\'s watcher answer was held when the read began')
  const reading = r.call('browser_snapshot')
  await within(waited, CHAIN_STARTS_MS, `the read did not ask the watcher within ${CHAIN_STARTS_MS / 1000} s`)
  await within(frames.heldAfter(before.order + 1), CHAIN_STARTS_MS, `newer frames stopped arriving within ${CHAIN_STARTS_MS / 1000} s`)
  assert.equal(waits.some(row => row.ended), false, 'the read still waits for the frame work begun before it, with newer frames held after it')

  // The other side: once that work is done the read comes back, while the newer frames' work is still unfinished.
  frames.releasePinned()
  const reply: any = await within(reading, CHAIN_READ_COMES_BACK_MS, `a read did not come back within ${CHAIN_READ_COMES_BACK_MS / 1000} s while new frames kept arriving: it is waiting for frames that came after it started`)
  const newerUnfinished = frames.holdsAfter(before.order)
  await frames.stop()
  assert.ok(newerUnfinished, 'the read came back before the work for frames made after it began had finished')
  assert.notEqual(reply.isError, true, textOf(reply))
  assert.match(textOf(reply), /heading "Steady"/)
  assert.match(textOf(await r.call('browser_snapshot')), /heading "Steady"/, 'and the next read is an ordinary read')
})

test('P1-6 a busy page locks nothing: the read during it ends, and the call after it reads', { skip, timeout: 60_000 }, async (t) => {
  const r = await rig(t, '<h1>Hydrating</h1>')
  await r.page.evaluate(() => { setTimeout(() => { const end = Date.now() + 2600; while (Date.now() < end); }, 50) })
  await pause(100)
  await within(r.call('browser_snapshot'), READ_COMES_BACK_MS, `a read during a busy page did not come back within ${READ_COMES_BACK_MS / 1000} s`)
  await pause(2800)
  await r.page.setContent('<h1>Recovered page</h1>')
  const after = textOf(await within(r.call('browser_snapshot'), READ_COMES_BACK_MS, `the call after a busy page did not come back within ${READ_COMES_BACK_MS / 1000} s: the busy page locked the browser`))
  assert.match(after, /Recovered page/, after)
})

test('P1-6 big fields lock nothing: four pages with a 270 KB hidden field each read in turn', { skip, timeout: 60_000 }, async (t) => {
  const r = await rig(t, '<h1>Start</h1>')
  for (let index = 0; index < 4; index += 1) {
    await r.page.setContent(`<form><input type=hidden name=__VIEWSTATE value="${Buffer.from(String(index).repeat(200 * 1024)).toString('base64')}"><h1>Page ${index}</h1></form>`)
    assert.match(textOf(await within(r.call('browser_snapshot'), READ_COMES_BACK_MS, `page ${index} with a big field did not come back within ${READ_COMES_BACK_MS / 1000} s`)), new RegExp(`Page ${index}`))
  }
})

test('P1-6 one failed read fails one call in plain words, and the next call works', { skip, timeout: 60_000 }, async (t) => {
  const r = await rig(t, '<div><meter value=3 max=5></meter>x</div><h1>Meter</h1>')
  assert.match(textOf(await r.call('browser_snapshot')), /heading "Meter"/)
  const toImpl = r.page._connection.toImpl
  const frame = toImpl(r.page.mainFrame()), utilityContext = frame.utilityContext
  frame.utilityContext = () => Promise.reject(new Error('MADEUPPAGEDETAIL'))
  const failed = textOf(await r.call('browser_snapshot'))
  frame.utilityContext = utilityContext
  assert.match(failed, /could not be read/i)
  assert.doesNotMatch(failed, /MADEUPPAGEDETAIL|Meter/)
  const next = textOf(await within(r.call('browser_snapshot'), READ_COMES_BACK_MS, `the call after a failed read did not come back within ${READ_COMES_BACK_MS / 1000} s`))
  assert.match(next, /heading "Meter"/, next)
})

test('P1-6 a dialog in a background tab stops nothing, and a click during a dialog says so and recovers', { skip, timeout: 90_000 }, async (t) => {
  const r = await rig(t, '<button id=a onclick="setTimeout(()=>alert(1),0)">Show the report</button><button id=b>Another report</button>')
  const tree = textOf(await r.call('browser_snapshot'))
  await r.call('browser_click', { target: refOf(tree, 'Show the report'), element: 'x' })
  await pause(300)
  const during = textOf(await r.call('browser_click', { target: refOf(tree, 'Another report'), element: 'y' }))
  assert.match(during, /dialog/i, during)
  assert.equal(r.cards.length, 0, 'a click that cannot run asks nobody')
  await r.call('browser_handle_dialog', { accept: false })
  assert.match(textOf(await r.call('browser_snapshot')), /Another report/)
  await r.call('browser_tabs', { action: 'new' })
  r.engine.pages()[0].evaluate(() => { setTimeout(() => alert('x'), 5) }).catch(() => {})
  await pause(200)
  for (let index = 0; index < 2; index += 1) assert.doesNotMatch(textOf(await r.call('browser_snapshot')), /could not be|failed/i)
})

test('P1-8 two refs from one snapshot both work, and a form fills', { skip, timeout: 60_000 }, async (t) => {
  const r = await rig(t, `<button onclick="fetch('/clicked/a')">Show the report</button><button onclick="fetch('/clicked/b')">Show the chart</button><input aria-label=One><input aria-label=Two>`)
  const tree = textOf(await r.call('browser_snapshot'))
  assert.equal((await r.call('browser_click', { target: refOf(tree, 'Show the report'), element: 'x' })).isError === true, false)
  const second = await r.call('browser_click', { target: refOf(tree, 'Show the chart'), element: 'y' })
  assert.equal(second.isError === true, false, textOf(second))
  const filled = await r.call('browser_fill_form', { fields: [{ target: refOf(tree, 'One'), name: 'One', type: 'textbox', value: 'hello' }, { target: refOf(tree, 'Two'), name: 'Two', type: 'textbox', value: 'world' }] })
  assert.equal(filled.isError === true, false, textOf(filled))
  await pause(150)
  assert.deepEqual(r.clicks, ['a', 'b'])
  assert.deepEqual(await r.page.evaluate(() => [...document.querySelectorAll('input')].map((input: any) => input.value)), ['hello', 'world'])
})

test('P2-1 wait_for waits, and says when the text did not appear', { skip, timeout: 60_000 }, async (t) => {
  const r = await rig(t, '<div id=x>loading</div><script>setTimeout(()=>{document.getElementById("x").textContent="READY NOW"},800)</script>')
  await r.page.reload()
  const started = Date.now()
  const came = await r.call('browser_wait_for', { text: 'READY NOW' })
  assert.ok(Date.now() - started >= 400, 'it waited')
  assert.equal(came.isError === true, false, textOf(came))
  const never = await r.call('browser_wait_for', { text: 'NEVER HERE', time: 1 })
  assert.equal(never.isError, true)
  assert.match(textOf(never), /did not (appear|match)/i)
})

test('P2-5 slow typing is refused, and a label is read as its control', { skip, timeout: 90_000 }, async (t) => {
  const r = await rig(t, `<form onsubmit="fetch('/clicked/submit');return false"><input aria-label=Note><button type=submit>Delete account</button></form>
    <label for=hid>Continue</label><button id=hid onclick="fetch('/clicked/label')">Delete account three</button>
    <button onclick="fetch('/clicked/span')"><span>Go</span> Delete account two</button>
    <button id=n onclick="if(confirm('Delete your account?'))fetch('/clicked/confirm')">Next step</button>`)
  const tree = textOf(await r.call('browser_snapshot'))
  const refused = await r.call('browser_type', { target: refOf(tree, 'Note'), text: 'x\n', slowly: true, element: 'Note', wait_seconds: 1 })
  assert.equal(refused.isError, true)
  assert.match(textOf(refused), /separate.*browser_click/)
  assert.equal(r.cards.length, 0)
  assert.equal(await r.page.locator('input').inputValue(), '')
  const label = /text: Continue|generic \[ref=(e\d+)\]: Continue/.exec(tree)
  const ref = label?.[1] || refOf(tree, 'Continue')
  assert.ok(ref, tree)
  await r.call('browser_click', { target: ref, element: 'Continue', wait_seconds: 1 })
  assert.match(r.cards.at(-1)?.summary, /Delete account three/, 'a label is read as the control it clicks')
  await pause(150)
  assert.deepEqual(r.clicks, [], 'neither ran')
})

test('P2-6 Backspace still runs, Enter cannot submit a search or activate Delete', { skip, timeout: 90_000 }, async (t) => {
  const r = await rig(t, `<form action="/search"><input aria-label=Search name=q><button>Search</button></form><button id=d onclick="fetch('/clicked/d')">Delete account</button>`)
  await r.call('browser_snapshot')
  await r.page.locator('[name=q]').fill('shoes')
  const back = await r.call('browser_press_key', { key: 'Backspace', wait_seconds: 1 })
  assert.equal(back.isError === true, false, textOf(back))
  assert.equal(r.cards.length, 0, 'Backspace asks nobody')
  const enter = await r.call('browser_press_key', { key: 'Enter', wait_seconds: 1 })
  assert.equal(enter.isError, true, textOf(enter))
  assert.match(textOf(enter), /form_submit_approval_required/)
  assert.equal(r.page.url(), `${r.origin}/`)
  assert.equal(r.cards.length, 0)
  await r.page.locator('#d').focus()
  const refused = await r.call('browser_press_key', { key: 'Enter', wait_seconds: 1 })
  assert.equal(refused.isError, true)
  assert.match(textOf(refused), /form_submit_approval_required/)
  assert.equal(r.cards.length, 0)
  await pause(100)
  assert.deepEqual(r.clicks, [])
})

test('RULING a card says what the host read, marks the agent\'s words apart, and says when it could not read', { skip, timeout: 60_000 }, async (t) => {
  const r = await rig(t, `<button onclick="fetch('/clicked/d')">Delete account</button><button id=x onclick="fetch('/clicked/x')" aria-label=""><svg width=20 height=20></svg></button>`, { write: 'ask' })
  r.core._grantsFor = () => ({ [r.origin]: { navigate: 'allow', access: 'allow' } })
  const tree = textOf(await r.call('browser_snapshot'))
  await r.call('browser_click', { target: refOf(tree, 'Delete account'), element: 'Tidy the list', wait_seconds: 1 })
  const named = r.cards.at(-1)
  assert.match(named.summary, /click "Delete account"/, named.summary)
  assert.match(named.summary, /the agent says: Tidy the list/)
  const blindRef = /- button \[ref=(e\d+)\]/.exec(tree)?.[1]
  assert.ok(blindRef, tree)
  await r.call('browser_click', { target: blindRef, element: 'Open the note', wait_seconds: 1 })
  const blind = r.cards.at(-1)
  assert.match(blind.summary, /could not read/i, blind.summary)
  assert.match(blind.summary, /the agent says: Open the note/)
  assert.equal(blind.kind, 'sensitive')
  assert.deepEqual(blind.choices, ['allow_once', 'deny'])
  await r.page.setContent('<div id=c contenteditable style="-webkit-text-security:disc">MADEUPCARD</div>')
  const held = textOf(await r.call('browser_snapshot'))
  const before = r.cards.length
  const answer = await r.call('browser_click', { target: 'e2', element: 'x', wait_seconds: 1 })
  assert.equal(r.cards.length, before)
  assert.equal(textOf(answer), 'This browser is private. Finish here, then press Hand back so I can carry on.')
  assert.doesNotMatch(JSON.stringify(r.cards), /MADEUPCARD/)
})

test('normal browsing on a real site: read, click, two fields from one snapshot, wait, screenshot, slow frame, alert', { skip, timeout: 180_000 }, async (t) => {
  const r = await rig(t, undefined, { answer: 'allow_once' })
  const tree = textOf(await r.call('browser_snapshot'))
  assert.equal(tree.includes('(masked)'), false, tree)
  assert.equal(tree.includes(CSRF), false)
  assert.match(tree, /heading "Corner Shop" \[level=1\]/)
  assert.match(tree, /heading "Orders 2021 for 100 items"/)
  assert.match(tree, /button "Pin message"/)
  assert.equal((await r.call('browser_click', { target: refOf(tree, 'Show the report'), element: 'r' })).isError === true, false)
  assert.equal(await r.page.locator('#out').textContent(), 'report shown')
  assert.equal((await r.call('browser_click', { target: refOf(tree, 'Show the chart'), element: 'c' })).isError === true, false)
  assert.equal(await r.page.locator('#out').textContent(), 'chart shown')
  const filled = await r.call('browser_fill_form', { fields: [
    { target: refOf(tree, 'First name'), name: 'First', type: 'textbox', value: 'Sam' },
    { target: refOf(tree, 'Last name'), name: 'Last', type: 'textbox', value: 'Reed' },
  ] })
  assert.equal(filled.isError === true, false, textOf(filled))
  assert.equal(await r.page.locator('[name=first]').inputValue(), 'Sam')
  assert.equal(await r.page.locator('[name=last]').inputValue(), 'Reed')
  const booked = await r.call('browser_click', { target: refOf(tree, 'Book delivery'), element: 'b' })
  assert.notEqual(booked.isError, true, textOf(booked))
  assert.equal(r.cards.length, 1, 'the submit step needs a fresh approval after filling')
  assert.match(r.cards[0].summary, /Book delivery/)
  assert.deepEqual(r.cards[0].choices, ['allow_once', 'deny'])
  const waited = await r.call('browser_wait_for', { text: 'Delivery booked' })
  assert.equal(waited.isError === true, false, textOf(waited))
  assert.ok(hasImage(await r.call('browser_take_screenshot')))
  assert.notEqual((await r.call('browser_click', { target: refOf(tree, 'Say hello'), element: 'h' })).isError, true)
  assert.equal(r.cards.length, 2, 'the populated form retains its barrier after submit')
  assert.match(r.cards[1].summary, /Say hello/)
  assert.deepEqual(r.cards[1].choices, ['allow_once', 'deny'])
  await pause(150)
  assert.match(textOf(await r.call('browser_snapshot')), /dialog/i)
  const answered = await r.call('browser_handle_dialog', { accept: true, wait_seconds: 1 })
  assert.equal(answered.isError === true, false, textOf(answered))
  assert.equal(r.cards.length, 3, 'the dialog action also needs its own approval while fields remain tracked')
  assert.deepEqual(r.cards[2].choices, ['allow_once', 'deny'])
  assert.match(textOf(await r.call('browser_snapshot')), /Corner Shop/)
  await r.call('browser_navigate', { url: `${r.origin}/slow` })
  const slow = textOf(await r.call('browser_snapshot'))
  assert.match(slow, /Article with a slow embed/)
  assert.equal((await r.call('browser_click', { target: refOf(slow, 'Mark read'), element: 'm' })).isError === true, false)
  assert.equal(await r.page.locator('#o').textContent(), 'read')
  assert.ok(hasImage(await r.call('browser_take_screenshot')))
  const products = await r.call('browser_navigate', { url: `${r.origin}/products?page=1` })
  assert.match(textOf(products), /products\?page=1/)
})
