/**
 * The browser host's side of downloads (HOAI board row 67562770), without a
 * real Chrome: the host core over a fake engine that starts a download the
 * way Playwright hands one over, the real GateKeeper against a fake backend,
 * and the real download store in a temp folder. The real Chrome end to end
 * is hoai-browser-host.downloads.chromium.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BrowserHostCore, BrowserPool, DOWNLOAD_SENTENCE, hostInstructions, loadPlaywright } from '../bin/hoai-browser-host.mjs'
import { GateKeeper } from '../lib/browser-gate.mjs'
import { DownloadStore } from '../lib/browser-downloads.mjs'

type Card = Record<string, any>

function server() {
  const cards: Card[] = []
  const state = new Map<string, { state: string; choice: string | null }>()
  return {
    cards,
    answer(gateId: string, choice: string | null, as = 'answered') {
      state.set(gateId, { state: as, choice })
    },
    postCard: async (card: Card) => {
      cards.push(card)
      // Navigations and clicks are allowed at once; a download waits for the test.
      state.set(String(card.gateId), card.kind === 'download' ? { state: 'open', choice: null } : { state: 'answered', choice: 'allow_once' })
      return true
    },
    readGate: async (gateId: string) => state.get(gateId) ?? { state: 'unknown', choice: null },
  }
}

const readyGuard = { ready: true, reason: null, prepare: async () => true, verify: () => true }

function fakeDownload(held: string, name: string) {
  mkdirSync(held, { recursive: true })
  const final = join(held, randomUUID())
  writeFileSync(`${final}.crdownload`, 'PLUGDL-HOST-BYTES')
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
  const home = mkdtempSync(join(tmpdir(), 'dl-host-'))
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
        async start() {
          this.alive = true
        },
        pages: () => [{ url: () => 'https://files.example.com/', title: async () => 'Files' }],
        async callTool(name: string) {
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
  ]
  const core: any = new BrowserHostCore({ pool, browserTools: tools, deviceLabel: 'box-1', gates, downloadStore: () => store })
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

test("a gated action of the agent WAITS behind the page's download ask instead of being told busy, then is asked itself", async () => {
  const s = setup()
  try {
    await s.call('browser_navigate', { url: 'https://files.example.com/' })
    s.engines[0].downloadOnClick = 'a.csv'
    await s.call('browser_click', { element: 'Download' })
    await until(() => s.srv.cards.some((c) => c.kind === 'download'), () => 'download asked')
    s.engines[0].downloadOnClick = null
    const ask = s.srv.cards.find((c) => c.kind === 'download')!
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
    // settings (profiles.sessionGrants; the host's key for a numeric agent
    // id reads the alwaysGrants overlay).
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
