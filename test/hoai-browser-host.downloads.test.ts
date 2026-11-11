/**
 * The browser host's side of downloads (HOAI board row 67562770), without a
 * real Chrome: the host core over a fake engine that starts a download the
 * way Playwright hands one over, the real GateKeeper against a fake backend,
 * and the real download store in a temp folder. The real Chrome end to end
 * is hoai-browser-host.downloads.chromium.test.ts.
 */
import { test as nativeTest, type TestContext } from 'node:test'
import { scratchDir } from './helpers/scratch-dirs'

// Production background timers are unreferenced. A synthetic test has no
// browser socket to keep Node alive while those original timers settle.
function test(name: string, body: (context: TestContext) => void | Promise<void>) {
  return nativeTest(name, { timeout: 15_000 }, async context => {
    const fixtureKeeper = setInterval(() => {}, 1000)
    context.after(() => clearInterval(fixtureKeeper))
    try { await body(context) } finally { clearInterval(fixtureKeeper) }
  })
}
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { BrowserHostCore, BrowserPool, DOWNLOAD_SENTENCE, hostInstructions, loadPlaywright, ownerGaveLine } from '../bin/hoai-browser-host.mjs'
import { GATE_ATTACH_MS, GateKeeper } from '../lib/browser-gate.mjs'
import { DownloadStore } from '../lib/browser-downloads.mjs'
import { RemoteOwnerInput, runAgentBrowserWork } from '../lib/remote-input.mjs'

type Card = Record<string, any>

function server() {
  const cards: Card[] = []
  const state = new Map<string, { state: string; choice: string | null }>()
  let holding = false
  return {
    cards,
    /** From now on every card waits for the test, as a download's does. */
    holdCards(on: boolean) { holding = on },
    answer(gateId: string, choice: string | null, as = 'answered') {
      state.set(gateId, { state: as, choice })
    },
    postCard: async (card: Card) => {
      cards.push(card)
      // Navigations and clicks are allowed at once; a download waits for the test.
      state.set(String(card.gateId), card.kind === 'download' || holding ? { state: 'open', choice: null } : { state: 'answered', choice: 'allow_once' })
      return true
    },
    readGate: async (gateId: string) => state.get(gateId) ?? { state: 'unknown', choice: null },
  }
}

const readyGuard = { ready: true, reason: null, prepare: async () => true, verify: () => true }

function fakeDownload(held: string, name: string, body = 'PLUGDL-HOST-BYTES') {
  mkdirSync(held, { recursive: true })
  const final = join(held, randomUUID())
  writeFileSync(`${final}.crdownload`, body)
  renameSync(`${final}.crdownload`, final)
  return {
    suggestedFilename: () => name,
    url: () => 'https://files.example.com/x?sig=SECRET',
    page: () => ({ url: () => 'https://files.example.com/' }),
    failure: async () => null,
    path: async () => final,
    cancel: async () => {},
    _artifact: { _initializer: { absolutePath: final } },
  }
}

function setup() {
  const home = scratchDir('dl-host-')
  const agentRoot = join(home, '.bgos-agent')
  const srv = server()
  let n = 0
  const gates = new GateKeeper({ postCard: srv.postCard, readGate: srv.readGate, randomBytes: (k: number) => Buffer.from(`${++n}`.padStart(k, 'h')), sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)), pollMs: 5 })
  const store = new DownloadStore({ agentRoot, assistantId: 900, gates, deviceLabel: 'box-1', home, guard: readyGuard, noticePollMs: 5 })
  const engines: any[] = []
  const pool = new BrowserPool({
    agentRoot,
    createEngine: ({ heldDir }: { heldDir: string }) => {
      const engine: any = {
        alive: false,
        heldDir,
        downloadOnClick: null as string | null,
        /** Runs inside the engine's callTool, so a test can land a download while an action is in flight. */
        during: null as null | ((name: string) => void | Promise<void>),
        async start() {
          this.alive = true
        },
        pages: () => [{ url: () => 'https://files.example.com/', title: async () => 'Files' }],
        async callTool(name: string) {
          if (engine.during) await engine.during(name)
          if (name === 'browser_click' && engine.downloadOnClick) engine.onDownload(fakeDownload(heldDir, engine.downloadOnClick))
          return { content: [{ type: 'text', text: `${name} ran` }] }
        },
        async stop() {
          await engine.beforeClose?.()
          this.alive = false
        },
      }
      engines.push(engine)
      return engine
    },
    bindEngine: (engine: any, slot: any, ctx: any) => core.bindEngine(engine, slot, ctx),
  })
  const tools = [
    { name: 'browser_navigate', description: '', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
    { name: 'browser_click', description: '', inputSchema: { type: 'object', properties: { element: { type: 'string' } } } },
    { name: 'browser_snapshot', description: '', inputSchema: { type: 'object', properties: {} } },
  ]
  const core: any = new BrowserHostCore({ pool, browserTools: tools, deviceLabel: 'box-1', gates, downloadStore: () => store, isOwnerPrincipal: () => true })
  const ctx = { assistantId: 900, principal: 'owner', assistantName: 'Data' }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await core.callTool(ctx, name, args)
    return { isError: r.isError === true, text: (r.content ?? []).map((c: any) => c.text ?? '').join('\n') }
  }
  return { home, agentRoot, srv, gates, store, pool, core, ctx, call, engines, done: () => rmSync(home, { recursive: true, force: true }) }
}

async function until(ok: () => boolean | Promise<boolean>, what: () => string, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ok()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out: ${what()}`)
}

test("the host's own agent text is true about downloads on this machine, and dash free", () => {
  const text = hostInstructions('box-1')
  assert.ok(text.includes(DOWNLOAD_SENTENCE))
  assert.match(DOWNLOAD_SENTENCE, /asked for as its own card, for 60 seconds whatever wait_seconds your action carried/)
  assert.match(DOWNLOAD_SENTENCE, /Not answered, it is kept for the owner on this machine/)
  assert.match(DOWNLOAD_SENTENCE, /Do not download a kept file again/)
  assert.doesNotMatch(text, /[\u2013\u2014]/, 'no em or en dashes')
})

test("Playwright's MCP tab never saves a download by itself: its saver is switched off when Playwright loads", async () => {
  const { tools } = loadPlaywright() as any
  let saved = 0
  const download = { suggestedFilename: () => 'x.p8', saveAs: async () => saved++ }
  await tools.Tab.prototype._downloadStarted.call({ context: { outputFile: async () => 'x' }, _downloads: [], _addLogEntry: () => {} }, download)
  assert.equal(saved, 0)
})

test('a click that starts a download is told in its own reply that the owner is asked, and status lists it with no URL', async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    s.engines[0].downloadOnClick = 'AuthKey_7KQ2X9.p8'
    const click = await s.call('browser_click', { element: 'Download' })
    assert.match(click.text, /### Download\n- AuthKey_7KQ2X9\.p8 \(dl_[0-9a-f]+\): your owner is asked before it is saved/)
    await until(() => s.srv.cards.some((c) => c.kind === 'download'), () => 'the download card')
    const status = await s.call('hoai_browser_status')
    assert.match(status.text, /Downloads: dl_[0-9a-f]+ AuthKey_7KQ2X9\.p8, 17 B, waiting for your owner's answer/)
    assert.match(status.text, /Waiting for the owner about a download the page started, AuthKey_7KQ2X9\.p8/)
    assert.doesNotMatch(status.text, /sig=|SECRET/)
  } finally {
    s.done()
  }
})

// Playwright's click returns about 500 ms after the click, and Chrome raises a download when the site's headers arrive.
// A slower site raises it after the click's reply has gone, and the reply of the next call used to count only what
// began during that call, so no reply ever named it (Windows CI, runs 41299037606 and 41498314780).
test("a download Chrome raises after the click's reply has gone is told in the agent's next reply, and only once", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const click = await s.call('browser_click', { element: 'Download' })
    assert.doesNotMatch(click.text, /### Download/, 'nothing was raised when the click answered')
    s.engines[0].onDownload(fakeDownload(s.engines[0].heldDir, 'Late.p8'))
    const next = await s.call('browser_snapshot')
    assert.match(next.text, /### Download\n- Late\.p8 \(dl_[0-9a-f]+\): your owner is asked before it is saved/)
    const after = await s.call('browser_snapshot')
    assert.doesNotMatch(after.text, /### Download/, 'told once, not on every reply after it')
  } finally {
    s.done()
  }
})

test("a gated action of the agent WAITS behind the page's download ask instead of being told busy, then is asked itself", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    s.engines[0].downloadOnClick = 'a.csv'
    await s.call('browser_click', { element: 'Download' })
    await until(() => s.srv.cards.some((c) => c.kind === 'download'), () => 'download asked')
    s.engines[0].downloadOnClick = null
    const ask = s.srv.cards.find((c) => c.kind === 'download')!
    const budgets: number[] = []
    const raise = s.gates.raise.bind(s.gates)
    s.gates.raise = (o: any) => {
      if (o.kind === 'navigate') budgets.push(o.attachMs)
      return raise(o)
    }
    let done = false
    const navigating = s.call('browser_navigate', { url: 'https://other.example.org/' }).then((r) => {
      done = true
      return r
    })
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(done, false, 'still waiting for the download ask')
    s.srv.answer(String(ask.gateId), 'deny')
    const nav = await navigating
    assert.equal(nav.isError, false, nav.text)
    assert.doesNotMatch(nav.text, /gate_parked|busy/)
    assert.ok(s.srv.cards.some((c) => c.kind === 'navigate' && c.origin === 'https://other.example.org'), 'its own ask came after')
    // The relay cuts a call at 120 s: the time spent behind the download comes
    // out of the call's own budget, or an Allow could land after the cut.
    assert.equal(budgets.length, 1)
    assert.ok(Number.isFinite(budgets[0]) && budgets[0]! <= GATE_ATTACH_MS - 50, `the call's budget after waiting: ${budgets[0]}`)
  } finally {
    s.done()
  }
})

test('hoai_browser_wait_gate on a download ask answers with the download, never "ask again" or "do not retry"', async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    s.engines[0].downloadOnClick = 'billing.csv'
    await s.call('browser_click', { element: 'Download' })
    await until(() => s.srv.cards.some((c) => c.kind === 'download'), () => 'download asked')
    const ask = s.srv.cards.find((c) => c.kind === 'download')!
    s.srv.answer(String(ask.gateId), 'allow_once')
    const waited = await s.call('hoai_browser_wait_gate', { gate_id: String(ask.gateId) })
    assert.equal(waited.isError, false, waited.text)
    assert.match(waited.text, /about the download billing\.csv/)
    assert.doesNotMatch(waited.text, /ask again|do not retry|policy_denied/i)
    await until(async () => /billing\.csv, 17 B, saved in your browser folder: /.test((await s.call('hoai_browser_status')).text), () => 'saved')
    assert.ok(readdirSync(join(s.agentRoot, '900', 'browser-output', 'owner')).includes('billing.csv'))
  } finally {
    s.done()
  }
})

test('after the session closes, a kept file still reads as kept, with no path', async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    s.engines[0].downloadOnClick = 'AuthKey.p8'
    await s.call('browser_click', { element: 'Download' })
    await until(() => s.srv.cards.some((c) => c.kind === 'download'), () => 'asked')
    s.srv.answer(String(s.srv.cards.find((c) => c.kind === 'download')!.gateId), null, 'expired')
    await until(async () => /kept for your owner/.test((await s.call('hoai_browser_status')).text), () => 'kept')
    await s.call('hoai_browser_close_session')
    const status = await s.call('hoai_browser_status')
    assert.match(status.text, /^No browser session is open/)
    assert.match(status.text, /AuthKey\.p8, 17 B, kept for your owner \(no answer\)/)
    assert.doesNotMatch(status.text, /browser-downloads|[\\/]kept[\\/]/)
  } finally {
    s.done()
  }
})

test('a site the owner trusts covers its downloads from the first one, before any tool call seeded the grants', async () => {
  const s = setup()
  try {
    const profileDir = join(s.agentRoot, '900', 'browser', 'owner')
    mkdirSync(profileDir, { recursive: true })
    // A remembered Trust this site, in the grants this host seeds from the
    // settings (profiles.sessionGrants, which reads the legacy alwaysGrants
    // overlay for every agent, under its own agentGrants key).
    writeFileSync(join(profileDir, 'agent-browser.settings.json'), JSON.stringify({ v: 1, alwaysGrants: { 'https://files.example.com': { trust: 'allow' } } }))
    await s.call('hoai_browser_open_session', { purpose: 'files' })
    const slot = s.pool.peek(s.ctx)
    slot.downloads.onDownload(fakeDownload(s.engines[0].heldDir, 'trusted.csv'))
    const saved = () => {
      try {
        return readdirSync(join(s.agentRoot, '900', 'browser-output', 'owner')).includes('trusted.csv')
      } catch {
        return false
      }
    }
    await until(saved, () => JSON.stringify(s.srv.cards))
    assert.equal(s.srv.cards.filter((c) => c.kind === 'download').length, 0, 'nobody was asked')
  } finally {
    s.done()
  }
})

test('a browser that fails to start leaves no download watcher behind; the next start gets its own', async () => {
  const s = setup()
  try {
    let fail = true
    const create = (s.pool as any)._createEngine
    ;(s.pool as any)._createEngine = async (o: any) => {
      const engine = await create(o)
      const start = engine.start.bind(engine)
      engine.start = async () => {
        if (fail) throw new Error('chrome did not start')
        return start()
      }
      return engine
    }
    await assert.rejects(s.call('hoai_browser_open_session', { purpose: 'x' }).then((r) => { if (r.isError) throw new Error(r.text) }))
    const slot = (s.pool as any)._slots.values().next().value
    const first = slot.downloads
    assert.ok(first, 'the first session had its downloads bound')
    assert.equal(first._timer, null, 'its watcher is not running after the failed start')
    fail = false
    await s.call('hoai_browser_open_session', { purpose: 'x' })
    assert.notEqual(slot.downloads, first)
    assert.equal(first._timer, null, 'and the replaced one never starts')
    assert.notEqual(slot.downloads._timer, null, 'the live session watches its folder')
  } finally {
    s.done()
  }
})

test("the owner's own download never reaches the agent's replies, and the agent's next one still does", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const slot = s.pool.peek(s.ctx)
    slot.ownerInputLease = { pending: false }
    s.engines[0].onDownload(fakeDownload(s.engines[0].heldDir, 'tax-return-private.pdf'))
    slot.ownerInputLease = null
    const next = await s.call('browser_snapshot')
    assert.doesNotMatch(next.text, /tax-return|### Download/, 'the owner asked for that file, and the agent did not')
    s.engines[0].onDownload(fakeDownload(s.engines[0].heldDir, 'Late.p8'))
    const after = await s.call('browser_snapshot')
    assert.match(after.text, /### Download\n- Late\.p8 \(dl_[0-9a-f]+\): your owner is asked/)
    assert.doesNotMatch(after.text, /tax-return/)
  } finally {
    s.done()
  }
})

test("an owner's download refused at the start, or one that cannot start, names nothing to the agent", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const slot = s.pool.peek(s.ctx)
    const held = s.engines[0].heldDir
    const noPath: any = fakeDownload(held, 'no-path-private.pdf')
    delete noPath._artifact
    for (const [guard, download] of [
      [{ ...readyGuard, verify: () => false }, fakeDownload(held, 'folder-refused-private.pdf')],
      [readyGuard, noPath],
      [{ ...readyGuard, verify: () => { throw new Error('the folder check broke') } }, fakeDownload(held, 'cannot-start-private.pdf')],
    ] as const) {
      slot.ownerInputLease = { pending: false }
      ;(s.store as any).guard = guard
      s.engines[0].onDownload(download)
      ;(s.store as any).guard = readyGuard
      slot.ownerInputLease = null
    }
    const next = await s.call('browser_snapshot')
    assert.doesNotMatch(next.text, /private|### Download/, 'the owner asked for those files, and the agent did not')
  } finally {
    s.done()
  }
})

test("an owner's download Chrome raises after the hand-back names nothing to the agent, and the agent's next action opens the way again", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const slot = s.pool.peek(s.ctx)
    const input = new RemoteOwnerInput({ current: () => slot })
    const view: any = { engine: slot.engine, cdp: { send: async () => ({}) } }
    await input.acquire(view)
    input.release(view)
    assert.equal(slot.ownerInputLease, null, 'the owner handed the browser back')
    s.engines[0].onDownload(fakeDownload(s.engines[0].heldDir, 'tax-return-private.pdf'))
    const next = await s.call('browser_snapshot')
    assert.doesNotMatch(next.text, /tax-return|### Download/, 'the agent has not acted since the owner held the browser')
    await until(() => s.srv.cards.some((c) => c.kind === 'download'), () => 'the owner is still asked, as before')
    // A read is not acting (the test below); the agent acts once the owner has answered their own ask.
    s.srv.answer(String(s.srv.cards.find((c) => c.kind === 'download')!.gateId), 'deny')
    await until(() => !s.gates.pending(s.pool.slotKey(s.ctx)), () => "the owner's ask is answered")
    const acted = await s.call('browser_click', { element: 'Next' })
    assert.equal(acted.isError, false, acted.text)
    assert.doesNotMatch(acted.text, /tax-return/)
    s.engines[0].onDownload(fakeDownload(s.engines[0].heldDir, 'Late.p8'))
    const after = await s.call('browser_snapshot')
    assert.match(after.text, /### Download\n- Late\.p8 \(dl_[0-9a-f]+\): your owner is asked/, 'the agent has acted since')
    assert.doesNotMatch(after.text, /tax-return/)
  } finally {
    s.done()
  }
})

test("the agent only reading the page after the hand-back does not make the owner's late download the agent's", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const slot = s.pool.peek(s.ctx)
    const input = new RemoteOwnerInput({ current: () => slot })
    const view: any = { engine: slot.engine, cdp: { send: async () => ({}) } }
    await input.acquire(view)
    input.release(view)
    // A read starts no download, so it is not the agent acting; Chrome raises the owner's download after it.
    const read = await s.call('browser_snapshot')
    assert.equal(read.isError, false, read.text)
    const row = s.engines[0].onDownload(fakeDownload(s.engines[0].heldDir, 'tax-return-private.pdf', 'x'.repeat(4321)))
    const key = s.pool.slotKey(s.ctx)
    await until(() => !!row.askGateId && s.gates.pending(key)?.gateId === row.askGateId, () => 'the owner is asked')
    assert.equal(row.owner, true, "the store holds it as the owner's")
    const next = await s.call('browser_snapshot')
    const status = await s.call('hoai_browser_status')
    for (const [what, answer] of [['the next reply', next], ['status', status]] as const) {
      assert.doesNotMatch(answer.text, /tax-return/, `${what} names the owner's file: ${answer.text}`)
      assert.doesNotMatch(answer.text, new RegExp(`\\b${row.handle}\\b`), `${what} gives its handle: ${answer.text}`)
      assert.doesNotMatch(answer.text, /4\.2 KB/, `${what} gives its size: ${answer.text}`)
    }
    assert.ok(status.text.includes(`Your owner has a request open until ${s.gates.pending(key).expiresAt}.`), status.text)
  } finally {
    s.done()
  }
})

test("an agent call that never ran does not make the owner's late download the agent's", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const slot = s.pool.peek(s.ctx)
    const input = new RemoteOwnerInput({ current: () => slot })
    const view: any = { engine: slot.engine, cdp: { send: async () => ({}) } }
    await input.acquire(view)
    input.release(view)
    const refused = await s.call('browser_navigate', { url: 'file:///etc/passwd' })
    assert.equal(refused.isError, true, refused.text)
    s.engines[0].onDownload(fakeDownload(s.engines[0].heldDir, 'tax-return-private.pdf'))
    const next = await s.call('browser_snapshot')
    assert.doesNotMatch(next.text, /tax-return|### Download/, 'nothing of the agent ran since the owner held the browser')
  } finally {
    s.done()
  }
})

test("the agent's click still waiting for the owner, who looks in and hands back before allowing it, is the agent's own", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const slot = s.pool.peek(s.ctx)
    s.engines[0].downloadOnClick = 'AgentsOwn.p8'
    const before = s.srv.cards.length
    s.srv.holdCards(true)
    const clicking = s.call('browser_click', { element: 'Download' })
    await until(() => s.srv.cards.length > before, () => 'the click is asked')
    const input = new RemoteOwnerInput({ current: () => slot })
    const view: any = { engine: slot.engine, cdp: { send: async () => ({}) } }
    await input.acquire(view)
    input.release(view)
    s.srv.answer(String(s.srv.cards.at(-1)!.gateId), 'allow_once')
    const clicked = await clicking
    assert.match(clicked.text, /### Download\n- AgentsOwn\.p8 \(dl_[0-9a-f]+\): your owner is asked/, 'it started after the hand-back, from the agent\'s own action')
  } finally {
    s.done()
  }
})

test("a click the owner's lease refuses at the gate's answer does not make the owner's late download the agent's", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const slot = s.pool.peek(s.ctx)
    const before = s.srv.cards.length
    s.srv.holdCards(true)
    const clicking = s.call('browser_click', { element: 'Download' })
    await until(() => s.srv.cards.length > before, () => 'the click is asked')
    const input = new RemoteOwnerInput({ current: () => slot })
    const view: any = { engine: slot.engine, cdp: { send: async () => ({}) } }
    await input.acquire(view)
    s.srv.answer(String(s.srv.cards.at(-1)!.gateId), 'allow_once')
    const clicked = await clicking
    assert.equal(clicked.isError, true, 'the owner holds the browser, so the click did not run')
    input.release(view)
    s.srv.holdCards(false)
    s.engines[0].onDownload(fakeDownload(s.engines[0].heldDir, 'tax-return-private.pdf'))
    const next = await s.call('browser_snapshot')
    assert.doesNotMatch(next.text, /tax-return|### Download/, 'nothing of the agent ran since the owner held the browser')
  } finally {
    s.done()
  }
})

test('the work the agent started before the owner took over is still its own while it drains', async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const slot = s.pool.peek(s.ctx)
    let finish!: () => void
    const running = runAgentBrowserWork(slot, () => new Promise<void>((resolve) => { finish = resolve }))
    await new Promise((resolve) => setImmediate(resolve))
    const input = new RemoteOwnerInput({ current: () => slot })
    const view: any = { engine: slot.engine, cdp: { send: async () => ({}) } }
    const acquiring = input.acquire(view)
    await new Promise((resolve) => setImmediate(resolve))
    s.engines[0].onDownload(fakeDownload(s.engines[0].heldDir, 'Drained.p8'))
    finish()
    await running
    await acquiring
    input.release(view)
    const next = await s.call('browser_snapshot')
    assert.match(next.text, /### Download\n- Drained\.p8 \(dl_[0-9a-f]+\): your owner is asked/, 'raised before the owner had the browser')
  } finally {
    s.done()
  }
})

test('a file no download event claimed, found while the owner holds the browser, is not pushed to the agent', async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const slot = s.pool.peek(s.ctx)
    slot.ownerInputLease = { pending: false }
    const held = s.engines[0].heldDir
    mkdirSync(held, { recursive: true })
    writeFileSync(join(held, randomUUID()), 'x')
    slot.downloads._adoptUnclaimed(true)
    slot.ownerInputLease = null
    const next = await s.call('browser_snapshot')
    assert.doesNotMatch(next.text, /### Download/)
    const input = new RemoteOwnerInput({ current: () => slot })
    const view: any = { engine: slot.engine, cdp: { send: async () => ({}) } }
    await input.acquire(view)
    input.release(view)
    writeFileSync(join(held, randomUUID()), 'x')
    slot.downloads._adoptUnclaimed(true)
    const after = await s.call('browser_snapshot')
    assert.doesNotMatch(after.text, /### Download/, 'found after the hand-back, before the agent acted')
  } finally {
    s.done()
  }
})

test('a reply that cannot carry the line does not use the download up: the next one still names it', () => {
  const core: any = new BrowserHostCore({ pool: {} as any, browserTools: [], deviceLabel: 'box-1' })
  const rows = [{ fileName: 'x.p8', handle: 'dl_ab', state: 'asking' }]
  let handedOut = 0
  const slot = { downloads: { untold: () => (handedOut++ ? [] : rows) } }
  assert.deepEqual(core._withDownloads(slot, { isError: true }), { isError: true })
  assert.match(core._withDownloads(slot, { content: [] }).content[0].text, /x\.p8 \(dl_ab\): your owner is asked/)
})

test("the reply of a call whose download is held says held, not 'not saved'", () => {
  const core: any = new BrowserHostCore({ pool: {} as any, browserTools: [], deviceLabel: 'box-1' })
  const result = core._withDownloads({ downloads: { untold: () => [{ fileName: 'x.p8', handle: 'dl_ab', state: 'held' }] } }, { content: [] })
  assert.match(result.content[0].text, /^### Download\n- x\.p8 \(dl_ab\): held on this machine for your owner until the browser host next starts; you are not given it\.$/)
})

// ── The owner's download stays the owner's in every answer ─────────────────────
//
// A download the page raises while the owner holds the browser, or after they hand it back and before the agent acts
// again, may be the owner's (SlotDownloads._mayBeOwners). The agent may learn that the owner has a request open, and
// until when; never the file's name, its size or its handle, on any path and in no later reply. The owner's card keeps
// the name. The agent's own download reads as before.

const OWNER_FILE = 'tax-return-private.pdf'
/** 4321 bytes read as "4.2 KB": a size no other file in these tests has. */
const OWNER_BODY = 'x'.repeat(4321)

function ownerView(s: ReturnType<typeof setup>) {
  const slot = s.pool.peek(s.ctx)
  const input = new RemoteOwnerInput({ current: () => slot })
  const view: any = { engine: slot.engine, cdp: { send: async () => ({}) } }
  return { slot, input, view }
}

/** The owner holds the browser while the page raises their download: kept for them, with no ask. */
async function ownerHeldDownload(s: ReturnType<typeof setup>) {
  const { input, view } = ownerView(s)
  await input.acquire(view)
  const row = s.engines[0].onDownload(fakeDownload(s.engines[0].heldDir, OWNER_FILE, OWNER_BODY))
  input.release(view)
  await until(() => row.state === 'kept' && row.keptReady === true, () => `kept: ${row.state}`)
  return row
}

/** The owner looks in and hands back; the page raises a download before the agent acts again: the owner is asked. */
async function ownerAskAfterHandBack(s: ReturnType<typeof setup>) {
  const { input, view } = ownerView(s)
  await input.acquire(view)
  input.release(view)
  const row = s.engines[0].onDownload(fakeDownload(s.engines[0].heldDir, OWNER_FILE, OWNER_BODY))
  const key = s.pool.slotKey(s.ctx)
  await until(() => !!row.askGateId && s.gates.pending(key)?.gateId === row.askGateId, () => 'the owner is asked')
  return { row, gate: s.gates.pending(key) }
}

function assertNamesNothing(text: string, row: any, what: string) {
  assert.doesNotMatch(text, /tax-return/, `${what} names the owner's file: ${text}`)
  assert.doesNotMatch(text, new RegExp(`\\b${row.handle}\\b`), `${what} gives the owner's file its handle ${row.handle}: ${text}`)
  assert.doesNotMatch(text, /4\.2 KB/, `${what} gives the owner's file its size: ${text}`)
}

function ownerCardNamesIt(s: ReturnType<typeof setup>) {
  assert.ok(s.srv.cards.some((c) => c.kind === 'download' && c.summary.includes(OWNER_FILE)), "the owner's card keeps the name")
}

test("the host's own words to the agent promise only its own downloads, and say what it hears of the owner's", () => {
  assert.doesNotMatch(DOWNLOAD_SENTENCE, /every file still kept for the owner/)
  assert.match(DOWNLOAD_SENTENCE, /you are told only that your owner has a request open, and until when/)
  assert.match(DOWNLOAD_SENTENCE, /If your owner gives you one of theirs with Allow once, you are told its name once, when it is in your browser folder; it is not listed in hoai_browser_status\./)
  assert.doesNotMatch(DOWNLOAD_SENTENCE, /[\u2013\u2014]/)
})

test("status never lists the owner's download, while the session runs or after it closes; the agent's own is still there", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    s.engines[0].downloadOnClick = 'AgentsOwn.p8'
    await s.call('browser_click', { element: 'Download' })
    s.engines[0].downloadOnClick = null
    await until(() => s.srv.cards.some((c) => c.kind === 'download'), () => "the agent's download is asked")
    s.srv.answer(String(s.srv.cards.find((c) => c.kind === 'download')!.gateId), 'allow_once')
    await until(async () => /AgentsOwn\.p8, 17 B, saved in your browser folder/.test((await s.call('hoai_browser_status')).text), () => 'saved')
    const owner = await ownerHeldDownload(s)
    ownerCardNamesIt(s)
    const open = await s.call('hoai_browser_status')
    await s.call('hoai_browser_close_session')
    const closed = await s.call('hoai_browser_status')
    for (const [what, answer] of [['status, session open', open], ['status, session closed', closed]] as const) {
      assertNamesNothing(answer.text, owner, what)
      assert.match(answer.text, /AgentsOwn\.p8, 17 B, saved in your browser folder/, `${what}: the agent's own download reads as before`)
      assert.doesNotMatch(answer.text, /Do not download/, `${what}: the agent fetched nothing that is kept`)
    }
  } finally {
    s.done()
  }
})

test("the owner's ask after the hand-back: status says only that the owner has a request open, and until when", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const { row, gate } = await ownerAskAfterHandBack(s)
    ownerCardNamesIt(s)
    const status = await s.call('hoai_browser_status')
    assertNamesNothing(status.text, row, 'status')
    assert.ok(status.text.includes(`Your owner has a request open until ${gate.expiresAt}.`), status.text)
    assert.ok(!status.text.includes(String(gate.gateId)), 'nothing to wait on: the request is not the agent\'s')
  } finally {
    s.done()
  }
})

test("an action of the agent's held behind the owner's ask is told only that the owner has a request open, and until when", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const { row, gate } = await ownerAskAfterHandBack(s)
    // The call's wait behind the ask ran out of its budget (_behindDownloadAsk): the browser answers busy.
    s.core._behindDownloadAsk = async () => true
    const nav = await s.call('browser_navigate', { url: 'https://other.example.org/' })
    assert.equal(nav.isError, true, nav.text)
    assertNamesNothing(nav.text, row, 'the held action')
    assert.ok(nav.text.includes(`Your owner has a request open until ${gate.expiresAt}`), nav.text)
    assert.ok(!nav.text.includes(String(gate.gateId)), 'nothing to wait on: the request is not the agent\'s')
  } finally {
    s.done()
  }
})

test("an action of the agent's held behind its OWN download's ask is still told which file it waits for", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    s.engines[0].downloadOnClick = 'AgentsOwn.p8'
    await s.call('browser_click', { element: 'Download' })
    s.engines[0].downloadOnClick = null
    await until(() => !!s.gates.pending(s.pool.slotKey(s.ctx)), () => "the agent's download is asked")
    s.core._behindDownloadAsk = async () => true
    const nav = await s.call('browser_navigate', { url: 'https://other.example.org/' })
    assert.equal(nav.isError, true, nav.text)
    assert.match(nav.text, /Another permission request is already waiting for the owner \(download AgentsOwn\.p8 into /)
  } finally {
    s.done()
  }
})

test("hoai_browser_wait_gate on the owner's ask names nothing, and says the agent's own actions can go ahead", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const { row, gate } = await ownerAskAfterHandBack(s)
    s.srv.answer(String(gate.gateId), 'deny')
    const waited = await s.call('hoai_browser_wait_gate', { gate_id: String(gate.gateId) })
    assert.equal(waited.isError, false, waited.text)
    assertNamesNothing(waited.text, row, 'wait_gate')
    assert.match(waited.text, /your own actions can go ahead/)
  } finally {
    s.done()
  }
})

/** Every line of these answers that names the owner's file, under its own name or a unique one ("... (1).pdf"). */
function linesNaming(answers: Array<{ text: string }>) {
  return answers.flatMap((a) => a.text.split('\n')).filter((line) => line.includes('tax-return-private'))
}

/** The agent's next answers: a status, a reply, a status again, a reply again. */
async function nextAnswers(s: ReturnType<typeof setup>, extra: Array<() => Promise<{ text: string }>> = []) {
  const out: Array<{ text: string }> = [await s.call('hoai_browser_status'), await s.call('browser_snapshot'), await s.call('hoai_browser_status')]
  for (const more of extra) out.push(await more())
  out.push(await s.call('browser_snapshot'))
  return out
}

/** Named once, in exactly the host's one line, under the name it was saved as; no answer gives its handle or size. */
function namedOnceInOneLine(answers: Array<{ text: string }>, row: any, s: ReturnType<typeof setup>) {
  const named = linesNaming(answers)
  assert.equal(named.length, 1, `named once, in one line: ${JSON.stringify(named)}`)
  assert.ok(row.savedPath, 'it is in the agent folder')
  assert.equal(named[0], ownerGaveLine(basename(row.savedPath), s.store.displayOutputDir(s.pool.pathsFor(s.ctx).key)))
  for (const a of answers) {
    assert.doesNotMatch(a.text, new RegExp(`\\b${row.handle}\\b`), `no answer gives the handle: ${a.text}`)
    assert.doesNotMatch(a.text, /4\.2 KB/, `no answer gives the size: ${a.text}`)
  }
}

test("the owner's Allow once on their kept file's card tells the agent its name in one line, once: never again, nor after a restart", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const owner = await ownerHeldDownload(s)
    await until(() => owner.notice?.told === true, () => "the owner's notice is posted")
    s.srv.answer(String(owner.notice.gateId), 'allow_once')
    await until(() => owner.state === 'saved', () => `saved: ${owner.state}`)
    const answers = await nextAnswers(s, [() => s.call('hoai_browser_wait_gate', { gate_id: String(owner.notice.gateId) })])
    namedOnceInOneLine(answers, owner, s)
    await s.call('hoai_browser_close_session')
    // A new host process reads the same folder.
    const fresh = new DownloadStore({ agentRoot: s.agentRoot, assistantId: 900, gates: s.gates, deviceLabel: 'box-1', home: s.home, guard: readyGuard, noticePollMs: 5 })
    s.core._downloadStore = () => fresh
    try {
      const after = [await s.call('hoai_browser_status'), await s.call('browser_navigate', { url: 'https://files.example.com/' }), await s.call('hoai_browser_status')]
      assert.deepEqual(linesNaming(after), [], 'never again after a restart')
    } finally {
      fresh.stop()
    }
  } finally {
    s.done()
  }
})

test("the owner's Allow once whose save fails names nothing; their Allow once on the card that keeps it then names it once", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const { row, gate } = await ownerAskAfterHandBack(s)
    // The agent folder refuses the file once (a full disk): the owner said yes, so it is kept for them, with a card.
    const store: any = s.store
    const give = store.give.bind(store)
    let refused = 0
    store.give = (...args: any[]) => (refused++ === 0 ? Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' })) : give(...args))
    s.srv.answer(String(gate.gateId), 'allow_once')
    await until(() => row.state === 'kept' && row.keptReady === true && row.notice?.told === true, () => `kept after the failed save: ${row.state}`)
    const before = await nextAnswers(s)
    assert.deepEqual(linesNaming(before), [], 'nothing is named while the file is not in the agent folder')
    for (const a of before) assertNamesNothing(a.text, row, 'an answer after the failed save')
    s.srv.answer(String(row.notice.gateId), 'allow_once')
    await until(() => row.state === 'saved', () => `saved: ${row.state}`)
    namedOnceInOneLine(await nextAnswers(s), row, s)
  } finally {
    s.done()
  }
})

test("the owner's file saved under a unique name, because the agent folder has one of that name, is told by the name it has", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const dir = s.store.outputDir(s.pool.pathsFor(s.ctx).key)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, OWNER_FILE), 'the agent kept one of this name')
    const { row, gate } = await ownerAskAfterHandBack(s)
    s.srv.answer(String(gate.gateId), 'allow_once')
    await until(() => row.state === 'saved', () => `saved: ${row.state}`)
    assert.equal(basename(row.savedPath), 'tax-return-private (1).pdf')
    namedOnceInOneLine(await nextAnswers(s), row, s)
  } finally {
    s.done()
  }
})

test("a host that restarts after the owner's Allow once, before the agent's next answer, never names the file", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const { row, gate } = await ownerAskAfterHandBack(s)
    s.srv.answer(String(gate.gateId), 'allow_once')
    await until(() => row.state === 'saved', () => `saved: ${row.state}`)
    const closed = await s.call('hoai_browser_close_session')
    const fresh = new DownloadStore({ agentRoot: s.agentRoot, assistantId: 900, gates: s.gates, deviceLabel: 'box-1', home: s.home, guard: readyGuard, noticePollMs: 5 })
    s.core._downloadStore = () => fresh
    try {
      const after = [closed, await s.call('hoai_browser_status'), await s.call('browser_navigate', { url: 'https://files.example.com/' }), await s.call('hoai_browser_status')]
      assert.deepEqual(linesNaming(after), [], 'never named after a restart')
      for (const a of after) assertNamesNothing(a.text, row, 'an answer after the restart')
    } finally {
      fresh.stop()
    }
  } finally {
    s.done()
  }
})

test('the store hands out a given file once, however often it is given', () => {
  const s = setup()
  try {
    const row: any = { owner: true, fileName: OWNER_FILE }
    s.store.given('a-key', row)
    assert.deepEqual(s.store.takeGiven('a-key'), [row])
    s.store.given('a-key', row)
    assert.deepEqual(s.store.takeGiven('a-key'), [], 'already named once')
  } finally {
    s.done()
  }
})

test("the owner's Deny on their kept file's card tells the agent nothing", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const owner = await ownerHeldDownload(s)
    await until(() => owner.notice?.told === true, () => "the owner's notice is posted")
    s.srv.answer(String(owner.notice.gateId), 'deny')
    await until(() => owner.state === 'deleted', () => `deleted: ${owner.state}`)
    const answers = await nextAnswers(s)
    assert.deepEqual(linesNaming(answers), [], 'Deny names nothing')
    for (const a of answers) assertNamesNothing(a.text, owner, 'an answer after Deny')
  } finally {
    s.done()
  }
})

for (const choice of ['allow_once', 'deny'] as const) {
  test(`the owner's ${choice === 'allow_once' ? 'Allow once' : 'Deny'} on their own download's ask ${choice === 'allow_once' ? 'tells the agent its name in one line, once' : 'tells the agent nothing'}`, async () => {
    const s = setup()
    try {
      await s.call('browser_navigate', { url: 'https://files.example.com/' })
      const { row, gate } = await ownerAskAfterHandBack(s)
      s.srv.answer(String(gate.gateId), choice)
      await until(() => row.state === (choice === 'deny' ? 'deleted' : 'saved'), () => `settled: ${row.state}`)
      const answers = await nextAnswers(s, [() => s.call('hoai_browser_wait_gate', { gate_id: String(gate.gateId) })])
      if (choice === 'allow_once') namedOnceInOneLine(answers, row, s)
      else {
        assert.deepEqual(linesNaming(answers), [], 'Deny names nothing')
        for (const a of answers) assertNamesNothing(a.text, row, 'an answer after Deny')
      }
    } finally {
      s.done()
    }
  })
}

// The owner's word is Allow once. Allow for this session and Trust this site stay on the owner's card and still give
// the file to the agent's folder, but they do not name it.
for (const choice of ['allow_session', 'trust_site'] as const) {
  test(`the owner's ${choice} on their own download's ask gives the file and names nothing`, async () => {
    const s = setup()
    try {
      await s.call('browser_navigate', { url: 'https://files.example.com/' })
      const { row, gate } = await ownerAskAfterHandBack(s)
      s.srv.answer(String(gate.gateId), choice)
      await until(() => row.state === 'saved', () => `saved: ${row.state}`)
      const answers = await nextAnswers(s)
      assert.deepEqual(linesNaming(answers), [], `${choice} names nothing`)
      for (const a of answers) assertNamesNothing(a.text, row, `an answer after ${choice}`)
    } finally {
      s.done()
    }
  })
}

test("after the host restarts, the owner's kept file is still not named; the agent's own kept file still is", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    s.engines[0].downloadOnClick = 'AgentsOwn.p8'
    await s.call('browser_click', { element: 'Download' })
    s.engines[0].downloadOnClick = null
    await until(() => s.srv.cards.some((c) => c.kind === 'download'), () => "the agent's download is asked")
    s.srv.answer(String(s.srv.cards.find((c) => c.kind === 'download')!.gateId), null, 'expired')
    await until(async () => /AgentsOwn\.p8, 17 B, kept for your owner \(no answer\)/.test((await s.call('hoai_browser_status')).text), () => 'kept')
    const owner = await ownerHeldDownload(s)
    await s.call('hoai_browser_close_session')
    // A new host process reads the same folder.
    const fresh = new DownloadStore({ agentRoot: s.agentRoot, assistantId: 900, gates: s.gates, deviceLabel: 'box-1', home: s.home, guard: readyGuard, noticePollMs: 5 })
    s.core._downloadStore = () => fresh
    try {
      const status = await s.call('hoai_browser_status')
      assertNamesNothing(status.text, owner, 'status after a restart')
      assert.match(status.text, /AgentsOwn\.p8, 17 B, kept for your owner \(no answer\)/)
    } finally {
      fresh.stop()
    }
  } finally {
    s.done()
  }
})

test("the owner's ask nobody answers is kept for them, and after the host restarts it is still not named", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const { row, gate } = await ownerAskAfterHandBack(s)
    s.srv.answer(String(gate.gateId), null, 'expired')
    await until(() => row.state === 'kept' && row.keptReady === true, () => `kept: ${row.state}`)
    assert.notEqual(row.keptReason, 'owner_download', 'kept for no answer: only the index says whose it may be')
    await s.call('hoai_browser_close_session')
    const fresh = new DownloadStore({ agentRoot: s.agentRoot, assistantId: 900, gates: s.gates, deviceLabel: 'box-1', home: s.home, guard: readyGuard, noticePollMs: 5 })
    s.core._downloadStore = () => fresh
    try {
      assertNamesNothing((await s.call('hoai_browser_status')).text, row, 'status after a restart')
    } finally {
      fresh.stop()
    }
  } finally {
    s.done()
  }
})

test("hoai_browser_wait_gate on a download ask no row explains, still open, names nothing", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const key = s.pool.slotKey(s.ctx)
    void s.gates.raise({ key, assistantId: 900, kind: 'download', origin: 'https://files.example.com', summary: `download ${OWNER_FILE} into ~/x on box-1.`, choices: ['allow_once', 'deny'], waitSeconds: 60, attachMs: Infinity })
    await until(() => !!s.gates.pending(key), () => 'asked')
    const { gateId, expiresAt } = s.gates.pending(key)
    // The call's own wait runs out at once: the request is still open when it answers.
    const attach = s.gates.attach.bind(s.gates)
    s.gates.attach = (id: string) => attach(id, { waitMs: 20 })
    const waited = await s.call('hoai_browser_wait_gate', { gate_id: String(gateId) })
    assert.doesNotMatch(waited.text, /tax-return/, waited.text)
    assert.ok(waited.text.includes(`Your owner has a request open until ${expiresAt}`), waited.text)
  } finally {
    s.done()
  }
})

test("a file an older host kept as the owner's own download is not named after the update", async () => {
  const s = setup()
  try {
    const key = s.pool.pathsFor(s.ctx).key
    const dir = join(s.agentRoot, '900', 'browser-downloads', key)
    mkdirSync(join(dir, 'kept'), { recursive: true })
    const id = randomUUID()
    writeFileSync(join(dir, 'kept', id), OWNER_BODY)
    // Written before the index carried who a file may belong to: only why it was kept.
    const record = { id, handle: 'dl_0a1b', fileName: OWNER_FILE, origin: 'https://files.example.com', agentName: 'Data', startedAt: Date.now(), bytes: OWNER_BODY.length, state: 'kept', keptReason: 'owner_download', keptUntil: Date.now() + 60_000, notice: { told: true, gateId: null, expiresAt: null } }
    writeFileSync(join(dir, 'downloads.json'), JSON.stringify({ v: 1, records: [record] }))
    const status = await s.call('hoai_browser_status')
    assertNamesNothing(status.text, record, 'status')
  } finally {
    s.done()
  }
})

test('a download ask open on the browser that no row explains never shows its summary to the agent', async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const key = s.pool.slotKey(s.ctx)
    void s.gates.raise({ key, assistantId: 900, kind: 'download', origin: 'https://files.example.com', summary: `download ${OWNER_FILE} into ~/x on box-1.`, choices: ['allow_once', 'deny'], waitSeconds: 60, attachMs: Infinity })
    await until(() => !!s.gates.pending(key), () => 'asked')
    const expiresAt = s.gates.pending(key).expiresAt
    const status = await s.call('hoai_browser_status')
    s.core._behindDownloadAsk = async () => true
    const nav = await s.call('browser_navigate', { url: 'https://other.example.org/' })
    for (const [what, answer] of [['status', status], ['the held action', nav]] as const) {
      assert.doesNotMatch(answer.text, /tax-return/, `${what}: ${answer.text}`)
      assert.ok(answer.text.includes(`Your owner has a request open until ${expiresAt}`), `${what}: ${answer.text}`)
    }
  } finally {
    s.done()
  }
})

test("a file first found while the owner held the browser stays the owner's, even when the agent acts before it is adopted", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const { slot, input, view } = ownerView(s)
    await input.acquire(view)
    const held = s.engines[0].heldDir
    mkdirSync(held, { recursive: true })
    writeFileSync(join(held, randomUUID()), OWNER_BODY)
    // The watcher sees it while the owner holds the browser; no download event claims it.
    slot.downloads._adoptUnclaimed(false)
    input.release(view)
    const acted = await s.call('browser_click', { element: 'Next' })
    assert.equal(acted.isError, false, acted.text)
    slot.downloads._adoptUnclaimed(true)
    const row = slot.downloads.records.at(-1)
    const next = await s.call('browser_snapshot')
    const status = await s.call('hoai_browser_status')
    assert.doesNotMatch(next.text, /### Download/, 'the next reply')
    assertNamesNothing(status.text, row, 'status')
  } finally {
    s.done()
  }
})

test("the owner's downloads never push the agent's own out of status", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    s.engines[0].downloadOnClick = 'AgentsOwn.p8'
    await s.call('browser_click', { element: 'Download' })
    s.engines[0].downloadOnClick = null
    await until(() => s.srv.cards.some((c) => c.kind === 'download'), () => "the agent's download is asked")
    s.srv.answer(String(s.srv.cards.find((c) => c.kind === 'download')!.gateId), 'allow_once')
    await until(async () => /AgentsOwn\.p8, 17 B, saved in your browser folder/.test((await s.call('hoai_browser_status')).text), () => 'saved')
    // 31 of the owner's own, each refused at the start (the folder check fails): none is kept, all are newer, and they
    // are more than the 30 finished downloads the store remembers for one person.
    const slot = s.pool.peek(s.ctx)
    slot.ownerInputLease = { pending: false }
    ;(s.store as any).guard = { ...readyGuard, verify: () => false }
    for (let i = 0; i < 31; i++) s.engines[0].onDownload(fakeDownload(s.engines[0].heldDir, `tax-return-${i}.pdf`))
    ;(s.store as any).guard = readyGuard
    slot.ownerInputLease = null
    // A row counts as finished once its bytes are gone, so wait for every delete.
    const owners = () => slot.downloads.records.filter((r: any) => /^tax-return-/.test(r.fileName))
    await until(() => owners().length === 31 && owners().every((r: any) => r.state === 'deleted' && !r.doomed), () => 'every one of them is deleted')
    const status = await s.call('hoai_browser_status')
    assert.match(status.text, /AgentsOwn\.p8, 17 B, saved in your browser folder/)
    assert.doesNotMatch(status.text, /tax-return/)
  } finally {
    s.done()
  }
})

test("a download that may be the owner's is never settled by the agent's site rules: the owner is asked", async () => {
  const s = setup()
  try {
    const profileDir = join(s.agentRoot, '900', 'browser', 'owner')
    mkdirSync(profileDir, { recursive: true })
    // A remembered Trust this site, which covers the agent's own downloads from it without an ask (the trusted site
    // test earlier in this file).
    writeFileSync(join(profileDir, 'agent-browser.settings.json'), JSON.stringify({ v: 1, alwaysGrants: { 'https://files.example.com': { trust: 'allow' } } }))
    await s.call('hoai_browser_open_session', { purpose: 'files' })
    const { slot, input, view } = ownerView(s)
    await input.acquire(view)
    input.release(view)
    const row = slot.downloads.onDownload(fakeDownload(s.engines[0].heldDir, OWNER_FILE, OWNER_BODY))
    await until(() => s.srv.cards.some((c) => c.kind === 'download' && c.summary.includes(OWNER_FILE)), () => `the owner is asked: ${row.state}`)
    assert.equal(row.owner, true)
    assert.equal(row.state, 'asking', 'not saved by the rule')
    let saved: string[] = []
    try {
      saved = readdirSync(join(s.agentRoot, '900', 'browser-output', 'owner'))
    } catch {}
    assert.ok(!saved.includes(OWNER_FILE), "nothing in the agent's folder")
    const status = await s.call('hoai_browser_status')
    assertNamesNothing(status.text, row, 'status')
  } finally {
    s.done()
  }
})

// ── The agent's action racing the owner's download (board row 0ce57b35) ─────────────────────────────────────────────
//
// The owner clicks a download link, hands the browser back, and the agent's allowed navigation goes out before Chrome
// raises the owner's download. Chrome's event then lands while the navigation is in flight, or in the same tick as its
// end. The host cannot tell that file from one the navigation started, so it stays the owner's: nothing the agent
// receives names it, gives its handle or its size, or counts it. Each timing is injected through the fake engine, with
// no sleep.

/** The owner takes the browser, clicks once (a pointer down and up, as the remote view sends it) and hands it back. */
async function ownerClicksAndHandsBack(s: ReturnType<typeof setup>) {
  const { slot, input, view } = ownerView(s)
  view.page = { evaluate: async () => ({ allowed: true, credential: false, editable: false }) }
  const { leaseId } = await input.acquire(view)
  await input.pointer(view, { leaseId, type: 'down', x: 10, y: 10, button: 'left' })
  await input.pointer(view, { leaseId, type: 'up', x: 10, y: 10, button: 'left' })
  input.release(view)
  assert.equal(slot.ownerInputLease, null, 'the owner handed the browser back')
  return slot
}

/** Everything the agent can read next: the navigation's own reply, status, a read's reply, and status once asked. */
async function agentReadsAfter(s: ReturnType<typeof setup>, nav: { text: string }, row: any) {
  const key = s.pool.slotKey(s.ctx)
  const answers: Array<[string, { text: string }]> = [['the navigation reply', nav], ['status', await s.call('hoai_browser_status')], ['the next read', await s.call('browser_snapshot')]]
  await until(() => !!row.askGateId && s.gates.pending(key)?.gateId === row.askGateId, () => `the owner is asked: ${row.state}`)
  answers.push(['status while the owner is asked', await s.call('hoai_browser_status')])
  answers.push(['the read after that', await s.call('browser_snapshot')])
  for (const [what, answer] of answers) {
    assertNamesNothing(answer.text, row, what)
    assert.doesNotMatch(answer.text, /### Download|Downloads:|Do not download/, `${what} lists or counts a download: ${answer.text}`)
  }
  assert.ok(answers[3][1].text.includes(`Your owner has a request open until ${s.gates.pending(key).expiresAt}.`), answers[3][1].text)
  ownerCardNamesIt(s)
}

const RACES: Array<[string, (land: () => void) => (name: string) => void | Promise<void>]> = [
  // The navigation waits on the page; Chrome raises the owner's download before it ends.
  ['while the navigation is in flight', (land) => async () => {
    await Promise.resolve()
    land()
    await Promise.resolve()
  }],
  // Chrome raises it in the very tick the navigation starts.
  ['in the tick the navigation starts', (land) => () => land()],
  // Chrome raises it in the tick the navigation ends, after its reply is settled.
  ['in the tick the navigation ends', (land) => () => { process.nextTick(land) }],
]

for (const [when, timing] of RACES) {
  test(`an owner's download Chrome raises ${when} after the owner's click is never named to the agent`, async () => {
    const s = setup()
    try {
      await s.call('browser_navigate', { url: 'https://files.example.com/' })
      const slot = await ownerClicksAndHandsBack(s)
      let row: any = null
      const land = () => { row = slot.downloads.onDownload(fakeDownload(s.engines[0].heldDir, OWNER_FILE, OWNER_BODY)) }
      s.engines[0].during = (name: string) => (name === 'browser_navigate' ? timing(land)(name) : undefined)
      const nav = await s.call('browser_navigate', { url: 'https://files.example.com/reports' })
      s.engines[0].during = null
      assert.equal(nav.isError, false, nav.text)
      await until(() => row !== null, () => 'the download landed')
      await agentReadsAfter(s, nav, row)
      assert.equal(row.owner, true, "the store holds it as the owner's")
    } finally {
      s.done()
    }
  })
}

test("after the owner's click, the agent's own download in its next action is not named either: the host cannot tell the two apart", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    await ownerClicksAndHandsBack(s)
    s.engines[0].downloadOnClick = OWNER_FILE
    const clicked = await s.call('browser_click', { element: 'Download' })
    s.engines[0].downloadOnClick = null
    assert.equal(clicked.isError, false, clicked.text)
    const row = s.pool.peek(s.ctx).downloads.records.at(-1)
    await agentReadsAfter(s, clicked, row)
    assert.equal(row.owner, true, 'unknown, so the owner\'s')
  } finally {
    s.done()
  }
})

test("agent actions alongside the first one after the owner's click keep the owner's window open until the last of them ends", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const slot = await ownerClicksAndHandsBack(s)
    // Each action waits in the engine until the test ends it: A and B run together, A ends, C starts beside B.
    const running: Array<() => void> = []
    s.engines[0].during = () => new Promise<void>((done) => { running.push(done) })
    // One permission card at a time per browser: each action starts once the one before it is in the engine.
    const a = s.call('browser_navigate', { url: 'https://files.example.com/a' })
    await until(() => running.length === 1, () => 'A is in flight')
    const b = s.call('browser_navigate', { url: 'https://files.example.com/b' })
    await until(() => running.length === 2, () => 'A and B are in flight')
    running[0]()
    const replies = [await a]
    const c = s.call('browser_navigate', { url: 'https://files.example.com/c' })
    await until(() => running.length === 3, () => 'C is in flight beside B')
    const row = slot.downloads.onDownload(fakeDownload(s.engines[0].heldDir, OWNER_FILE, OWNER_BODY))
    running[1]()
    running[2]()
    replies.push(await b, await c)
    s.engines[0].during = null
    for (const [i, reply] of replies.entries()) assertNamesNothing(reply.text, row, `reply ${'ABC'[i]}`)
    await agentReadsAfter(s, replies[2], row)
    assert.equal(row.owner, true, "the store holds it as the owner's")
    // All three ended and the owner has answered their own ask: the agent's next action is its own again.
    s.srv.answer(String(row.askGateId), 'deny')
    await until(() => !s.gates.pending(s.pool.slotKey(s.ctx)), () => "the owner's ask is answered")
    s.engines[0].downloadOnClick = 'AgentsOwn.p8'
    const clicked = await s.call('browser_click', { element: 'Download' })
    assert.match(clicked.text, /### Download\n- AgentsOwn\.p8 \(dl_[0-9a-f]+\): your owner is asked/)
  } finally {
    s.done()
  }
})

test("once the agent's first action after the owner's click has ended, its next action's download is its own again", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    await ownerClicksAndHandsBack(s)
    const nav = await s.call('browser_navigate', { url: 'https://files.example.com/reports' })
    assert.equal(nav.isError, false, nav.text)
    s.engines[0].downloadOnClick = 'AgentsOwn.p8'
    const clicked = await s.call('browser_click', { element: 'Download' })
    assert.match(clicked.text, /### Download\n- AgentsOwn\.p8 \(dl_[0-9a-f]+\): your owner is asked/, 'the agent acted again after its first action ended')
  } finally {
    s.done()
  }
})

test("a read after the owner's click does not end the owner's window, and neither does an action that never ran", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    const slot = await ownerClicksAndHandsBack(s)
    assert.equal((await s.call('browser_snapshot')).isError, false)
    assert.equal((await s.call('browser_navigate', { url: 'file:///etc/passwd' })).isError, true)
    let row: any = null
    s.engines[0].during = (name: string) => { if (name === 'browser_navigate') row = slot.downloads.onDownload(fakeDownload(s.engines[0].heldDir, OWNER_FILE, OWNER_BODY)) }
    const nav = await s.call('browser_navigate', { url: 'https://files.example.com/reports' })
    s.engines[0].during = null
    await agentReadsAfter(s, nav, row)
    assert.equal(row.owner, true, "the store holds it as the owner's")
  } finally {
    s.done()
  }
})
