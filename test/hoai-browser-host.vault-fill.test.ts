/**
 * hoai_vault_fill on this agent's own browser host, for a PERSON (shared agent
 * vault, plugin 0.90.0; BGOS plan 2026-11-13 section 4.3):
 *
 *   - only on a person's turn (never the owner's: the owner's own fills are
 *     their desktop's), only for the session and tab ids this host showed in
 *     hoai_browser_status for that person, and only on the page's own origin;
 *   - page secrecy from before anything is typed until the login document is
 *     gone: every other browser call on that person's browser is refused, the
 *     owner and live view input is held off, and no live view frame is sent;
 *   - the fill itself (runPersonVaultFill): the redeem with the agent's OWN
 *     pairing on POST /api/v1/vault/host/fills/<ticket>/redeem, the checks of
 *     lib/agent-host-vault-fill.mjs, the open with this host's key, the typed
 *     value registered as a secret, and a receipt that never has the value;
 *   - a person whose share ended loses an open browser and its folders.
 *
 * No em or en dashes in this file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BrowserHostCore, BrowserPool, ChromiumEngine, browserPathsFor, fillIdsOf, fillTabIdOf, runPersonVaultFill, sweepEndedShares } from '../bin/hoai-browser-host.mjs'
import { RemoteBrowserViews } from '../lib/remote-view.mjs'
import { vaultHostDir } from '../lib/vault-host.mjs'
import { anchorOwnerAccount, confirmHostPin, loadOrCreateHostKey, provisionSigningIdentity, registerHostKey, testSecurity } from './helpers/vault-host.mjs'
import { account, signedState } from './helpers/vault-state-fixture.mjs'

const AGENT = 901
const OWNER = 'user_Owner1'
const LEO = 'user_Leo1'
const ORIGIN = 'https://bank.example.com'
const ITEM = '2f1c3a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const TICKET = 'K'.repeat(43)
const PERSON = { assistantId: AGENT, assistantName: 'Atlas', principal: `user-${LEO}` }
const OWNER_CTX = { assistantId: AGENT, assistantName: 'Atlas', principal: `user-${OWNER}` }
const textOf = (r: any) => (r?.content || []).map((c: any) => c.text).join('')

function fakePage(url = `${ORIGIN}/login`) {
  return { url: () => url, title: async () => 'Sign in', isClosed: () => false }
}

function core(opts: { vaultFill?: any; pages?: any[]; deadlineMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hvf-'))
  const pages = opts.pages ?? [fakePage()]
  const calls: string[] = []
  const pool = new BrowserPool({
    agentRoot: join(home, '.bgos-agent'),
    createEngine: () => ({
      alive: false,
      async start() { this.alive = true },
      pages: () => pages,
      selectedPage: () => pages[0],
      registerSecret: () => {},
      async callTool(name: string) { calls.push(name); return { content: [{ type: 'text', text: `${name} ran` }] } },
      async stop() { this.alive = false },
    }),
  })
  const tools = ['browser_snapshot', 'browser_navigate'].map((name) => ({ name, description: '', inputSchema: { type: 'object', properties: {} } }))
  const c: any = new BrowserHostCore({ pool, browserTools: tools, deviceLabel: 'box-1', isOwnerPrincipal: (ctx: any) => ctx.principal === 'owner' || ctx.principal === `user-${OWNER}`, vaultFill: opts.vaultFill ?? null } as any)
  if (opts.deadlineMs) c.vaultFillDeadlineMs = opts.deadlineMs
  c._runHeld = async (verdict: any) => verdict.run ? verdict.run() : { content: [{ type: 'text', text: 'ran' }] }
  c._permit = async () => ({ allowed: true })
  return { home, pool, core: c, calls, done: () => rmSync(home, { recursive: true, force: true }) }
}

async function idsFor(c: any, ctx: any) {
  const status = textOf(await c.callTool(ctx, 'hoai_browser_status', {}))
  const m = /sessionId (vs_[A-Za-z0-9_-]+), tabId of each tab: 0 (tab_[A-Za-z0-9_-]+)/.exec(status)
  return m ? { sessionId: m[1]!, tabId: m[2]!, status } : { sessionId: '', tabId: '', status }
}

test('a person\'s status shows the fill ids; the owner\'s status is as before', async () => {
  const r = core()
  try {
    await r.pool.acquire(PERSON)
    const ids = await idsFor(r.core, PERSON)
    assert.match(ids.sessionId, /^vs_/)
    assert.match(ids.tabId, /^tab_/)
    assert.deepEqual(await idsFor(r.core, PERSON).then((x) => [x.sessionId, x.tabId]), [ids.sessionId, ids.tabId], 'stable while the browser lives')
    await r.pool.acquire(OWNER_CTX)
    assert.doesNotMatch((await idsFor(r.core, OWNER_CTX)).status, /vault_fill|sessionId vs_/)
  } finally { r.done() }
})

test('a person\'s fill runs under page secrecy and answers a receipt with no value', async () => {
  let r: ReturnType<typeof core>
  let during: any = {}
  const seen: any[] = []
  r = core({
    vaultFill: async (input: any) => {
      seen.push({ ...input, page: input.page.url(), engine: !!input.engine })
      const slot = r.pool.peek(PERSON)
      during.held = !!slot.vaultHold && slot.ownerInputLease === slot.vaultHold
      during.snapshot = textOf(await r.core.callTool(PERSON, 'browser_snapshot', {}))
      during.navigate = textOf(await r.core.callTool(PERSON, 'browser_navigate', { url: 'https://x.example.com' }))
      return { filled: true, password: 'must-not-leak' }
    },
  })
  try {
    await r.pool.acquire(PERSON)
    const { sessionId, tabId } = await idsFor(r.core, PERSON)
    const answer = await r.core.callTool(PERSON, 'hoai_vault_fill', { ticket: TICKET, itemId: ITEM, sessionId, tabId, origin: ORIGIN })
    assert.deepEqual(JSON.parse(textOf(answer)), { filled: true })
    assert.deepEqual(seen, [{ assistantId: AGENT, actingUserId: LEO, ticket: TICKET, itemId: ITEM, sessionId, tabId, origin: ORIGIN, page: `${ORIGIN}/login`, engine: true }])
    assert.equal(during.held, true)
    assert.match(during.snapshot, /login is being filled/)
    assert.match(during.navigate, /login is being filled/)
    assert.deepEqual(r.calls, [], 'no browser call ran during the fill')
    const slot = r.pool.peek(PERSON)
    assert.equal(slot.vaultHold, null)
    assert.equal(slot.ownerInputLease, null, 'released after')
    assert.match(textOf(await r.core.callTool(PERSON, 'browser_snapshot', {})), /ran/)
  } finally { r.done() }
})

test('refused before anything is redeemed: the owner\'s turn, stale ids, another origin, no browser, a bad input', async () => {
  let called = 0
  const r = core({ vaultFill: async () => { called += 1; return { filled: true } } })
  try {
    const none = JSON.parse(textOf(await r.core.callTool(PERSON, 'hoai_vault_fill', { ticket: TICKET, itemId: ITEM, sessionId: 'vs_x', tabId: 'tab_x', origin: ORIGIN })))
    assert.deepEqual(none, { filled: false, reason: 'no_browser' })
    await r.pool.acquire(PERSON)
    await r.pool.acquire(OWNER_CTX)
    const { sessionId, tabId } = await idsFor(r.core, PERSON)
    const reason = async (ctx: any, args: any) => JSON.parse(textOf(await r.core.callTool(ctx, 'hoai_vault_fill', args))).reason
    assert.equal(await reason(OWNER_CTX, { ticket: TICKET, itemId: ITEM, sessionId, tabId, origin: ORIGIN }), 'owner_turn')
    assert.equal(await reason({ ...PERSON, principal: 'owner' }, { ticket: TICKET, itemId: ITEM, sessionId, tabId, origin: ORIGIN }), 'owner_turn')
    assert.equal(await reason(PERSON, { itemId: ITEM, ticket: TICKET, sessionId: 'vs_other', tabId, origin: ORIGIN }), 'stale_target')
    assert.equal(await reason(PERSON, { itemId: ITEM, ticket: TICKET, sessionId, tabId: 'tab_other', origin: ORIGIN }), 'stale_target')
    assert.equal(await reason(PERSON, { itemId: ITEM, ticket: TICKET, sessionId, tabId, origin: 'https://other.example.com' }), 'origin_mismatch')
    assert.equal(await reason(PERSON, { itemId: ITEM, ticket: 'short', sessionId, tabId, origin: ORIGIN }), 'bad_input')
    assert.equal(await reason(PERSON, { itemId: ITEM, ticket: TICKET, sessionId, tabId, origin: 'http://bank.example.com' }), 'bad_input')
    // M4: the login the lane asked for is named, and must be a login id.
    assert.equal(await reason(PERSON, { ticket: TICKET, sessionId, tabId, origin: ORIGIN }), 'bad_input')
    assert.equal(await reason(PERSON, { ticket: TICKET, itemId: '../x', sessionId, tabId, origin: ORIGIN }), 'bad_input')
    assert.equal(called, 0)
  } finally { r.done() }
})

test('the target is the acting person\'s own browser: the owner\'s or another person\'s session and tab ids are refused', async () => {
  let called = 0
  const ownerPages = [fakePage()]
  const r = core({ vaultFill: async () => { called += 1; return { filled: true } } })
  try {
    await r.pool.acquire(PERSON)
    const ownerSlot = await r.pool.acquire(OWNER_CTX)
    const ben = { ...PERSON, principal: 'user-user_Ben1' }
    const benSlot = await r.pool.acquire(ben)
    const reason = async (args: any) => JSON.parse(textOf(await r.core.callTool(PERSON, 'hoai_vault_fill', args))).reason
    for (const slot of [ownerSlot, benSlot]) {
      const ids = fillIdsOf(slot.engine)
      const tab = fillTabIdOf(slot.engine, slot.engine.pages()[0])
      assert.equal(await reason({ ticket: TICKET, itemId: ITEM, sessionId: ids.sessionId, tabId: tab, origin: ORIGIN }), 'stale_target')
      // Leo's own session id with another browser's tab id: refused too.
      const leo = await idsFor(r.core, PERSON)
      assert.equal(await reason({ ticket: TICKET, itemId: ITEM, sessionId: leo.sessionId, tabId: tab, origin: ORIGIN }), 'stale_target')
    }
    assert.equal(called, 0)
    void ownerPages
  } finally { r.done() }
})

test('review finding 4: a fill that never ends closes that browser and lets go of the page at the deadline', async () => {
  const r = core({ vaultFill: () => new Promise(() => {}), deadlineMs: 50 })
  try {
    await r.pool.acquire(PERSON)
    const { sessionId, tabId } = await idsFor(r.core, PERSON)
    const answer = JSON.parse(textOf(await r.core.callTool(PERSON, 'hoai_vault_fill', { ticket: TICKET, itemId: ITEM, sessionId, tabId, origin: ORIGIN })))
    assert.deepEqual(answer, { filled: false, reason: 'timed_out' })
    assert.equal(r.pool.peek(PERSON), null, 'the browser that held the value was closed')
    const slot = (r.pool as any)._slots.get(r.pool.slotKey(PERSON))
    assert.equal(slot.vaultHold, null)
    assert.equal(slot.ownerInputLease, null)
    assert.match(textOf(await r.core.callTool(PERSON, 'browser_snapshot', {})), /ran/, 'the next call opens a fresh browser')
  } finally { r.done() }
})

test('the live view sends no frame while a login is being filled', () => {
  const page = fakePage()
  const engine: any = { pages: () => [page] }
  const slot: any = { engine }
  const pool: any = { peek: () => slot, slotKey: () => 'k' }
  const views = new RemoteBrowserViews({ pool })
  const sent: any[] = []
  const acks: any[] = []
  const view: any = { viewId: 'v1', closed: false, context: PERSON, engine, page, sessionId: 's', tabId: 't', pendingFrame: null, latestFrame: null,
    cdp: { send: async (m: string, p: any) => { acks.push([m, p]) } }, sendFrame: (m: any) => { sent.push(m); return true } }
  views.views.set('v1', view)
  slot.vaultHold = { kind: 'vault_fill' }
  ;(views as any)._frame(view, { sessionId: 1, data: 'AAAA' })
  assert.equal(sent.length, 0)
  assert.deepEqual(acks, [['Page.screencastFrameAck', { sessionId: 1 }]])
  slot.vaultHold = null
  ;(views as any)._frame(view, { sessionId: 2, data: 'BBBB' })
  assert.equal(sent.length, 1)
})

// ── runPersonVaultFill: the redeem, the checks, the open, the fill ──────────

async function hostRig(people: any[], opts: { pinned?: boolean; anchored?: boolean; access?: any } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hvr-'))
  const agentRoot = join(home, '.bgos-agent')
  const dir = vaultHostDir(join(agentRoot, String(AGENT)))
  const record = await loadOrCreateHostKey(dir, AGENT)
  const signing = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
  await provisionSigningIdentity(dir, AGENT, signing)
  if (opts.pinned !== false) {
    await registerHostKey({ stateDir: dir, assistantId: AGENT, ownerId: OWNER, apiBase: 'https://api.example.com/api/v1', pairingToken: 'pt_x',
      fetch: (async () => new Response(JSON.stringify({ registered: true, publicKey: record.publicKey }), { status: 201 })) as never })
    await confirmHostPin(dir)
  }
  const acct = account()
  // The owner's account key, anchored here (H2): by the terminal pin in these tests.
  if (opts.anchored !== false) await anchorOwnerAccount(dir, { ownerId: OWNER, accountPublic: acct.accountPublic, via: 'terminal' }, undefined, testSecurity)
  const state = signedState({ ownerId: OWNER, assistantId: AGENT, hostSeed: record.hostSeed, acct, people, items: [{ id: ITEM, website: ORIGIN, username: 'owner@example.com', password: 'made-up-secret-9' }] })
  const redeemed = { state, itemId: ITEM, devices: acct.devices, accountPublic: acct.accountPublic }
  const fetches: any[] = []
  const typed: any[] = []
  const secrets: string[] = []
  const handBacks: number[] = []
  const steps: string[] = []
  const accessAsks: string[] = []
  const pairing = { backendUrl: 'https://api.example.com', token: 'pt_secret_pairing', ownerUserId: OWNER, assistantIds: [AGENT] }
  const run = (over: Record<string, unknown> = {}, answer: any = redeemed, status = 200) => runPersonVaultFill({
    pairing, agentRoot, assistantId: AGENT, actingUserId: LEO, ticket: TICKET, sessionId: 'vs_1', tabId: 'tab_1', origin: ORIGIN,
    itemId: ITEM,
    page: fakePage(), engine: { registerSecret: (s: string) => secrets.push(s), handBackPrivacy: () => { handBacks.push(1); steps.push('release'); return { ok: true } } }, security: testSecurity,
    forgetHistory: async () => { steps.push('forget history'); return { ok: true } },
    fetchImpl: async (url: string, init: any) => {
      // V2: who may still use which of the owner's sites, asked before every person fill.
      if (url.startsWith('https://api.example.com/api/v1/vault/host/people-access')) {
        accessAsks.push(url)
        const access = 'access' in opts ? opts.access : { assistantId: AGENT, people: [{ userId: LEO, origins: [ORIGIN] }] }
        return access === null ? new Response('', { status: 404 }) : new Response(JSON.stringify(access), { status: 200 })
      }
      fetches.push({ url, init })
      return new Response(JSON.stringify(answer), { status })
    },
    pageFill: async (_page: any, values: any, o: any) => { typed.push({ ...values, origin: o.origin }); steps.push('fill'); return { filled: true } },
    ...over,
  } as never)
  return { home, dir, run, fetches, typed, secrets, handBacks, steps, accessAsks, redeemed, done: () => rmSync(home, { recursive: true, force: true }) }
}

test('the redeem goes out with the agent\'s own pairing, then the login is opened, registered and typed', async () => {
  const h = await hostRig([{ userId: LEO, askMode: 'never', items: [{ itemId: ITEM, ask: false }] }])
  try {
    const receipt = await h.run()
    assert.deepEqual(receipt, { filled: true })
    assert.equal(h.fetches.length, 1)
    assert.equal(h.fetches[0].url, `https://api.example.com/api/v1/vault/host/fills/${TICKET}/redeem`)
    assert.equal(h.fetches[0].init.method, 'POST')
    assert.equal(h.fetches[0].init.headers['X-BGOS-Pairing'], 'pt_secret_pairing')
    assert.deepEqual(JSON.parse(h.fetches[0].init.body), { assistantId: AGENT, actingUserId: LEO, sessionId: 'vs_1', tabId: 'tab_1', origin: ORIGIN })
    assert.deepEqual(h.typed, [{ username: 'owner@example.com', password: 'made-up-secret-9', origin: ORIGIN }])
    assert.deepEqual(h.secrets, ['made-up-secret-9'], 'every later answer of this browser hides the value')
    assert.equal(h.handBacks.length, 1, 'the page is released once the login document is gone')
    assert.doesNotMatch(JSON.stringify(receipt), /made-up-secret/)
    const record = JSON.parse(readFileSync(join(h.dir, 'vault-host.json'), 'utf8'))
    assert.ok(record.fillTrust[OWNER].accountPublic, 'the owner\'s account key is pinned on first use')
  } finally { h.done() }
})

test('a refused redeem, an unpinned host or a state that does not verify types nothing', async () => {
  const people = [{ userId: LEO, askMode: 'never', items: [{ itemId: ITEM, ask: false }] }]
  const h = await hostRig(people)
  try {
    assert.deepEqual(await h.run({}, { message: 'no' }, 403), { filled: false, reason: 'redeem_refused' })
    const tampered = { ...h.redeemed, state: { ...h.redeemed.state, people: [{ userId: LEO, askMode: 'never', items: [{ itemId: null, ask: false }] }] } }
    assert.deepEqual(await h.run({}, tampered), { filled: false, reason: 'vault_state_unverified' })
    assert.deepEqual(await h.run({ actingUserId: 'user_Other1' }), { filled: false, reason: 'vault_not_shared_with_person' })
    assert.deepEqual(h.typed, [])
    assert.equal(h.handBacks.length, 0, 'nothing typed, nothing released')
  } finally { h.done() }
  const u = await hostRig(people, { pinned: false })
  try {
    assert.deepEqual(await u.run(), { filled: false, reason: 'vault_host_not_pinned' })
    assert.equal(u.fetches.length, 0, 'nothing redeemed')
  } finally { u.done() }
})

test('a failed sign in is passed on as the page fill said, never with the value', async () => {
  const h = await hostRig([{ userId: LEO, askMode: 'never', items: [{ itemId: ITEM, ask: false }] }])
  try {
    const receipt = await h.run({ pageFill: async () => ({ filled: false, reason: 'sign_in_failed' }) })
    assert.deepEqual(receipt, { filled: false, reason: 'sign_in_failed' })
    assert.equal(h.handBacks.length, 1, 'released after the fields were emptied')
    const kept = await h.run({ engine: { registerSecret: () => {}, handBackPrivacy: () => ({ ok: false, reason: 'reload_required' }) } })
    assert.deepEqual(kept, { filled: true, private: 'kept' }, 'a page that needs a reload stays private, and the receipt says so')
  } finally { h.done() }
})

test('a person whose share ended loses an open browser and its folders; others keep theirs', async () => {
  const r = core()
  try {
    const agentRoot = join(r.home, '.bgos-agent')
    await r.pool.acquire(PERSON)
    const ben = { ...PERSON, principal: 'user-user_Ben1' }
    await r.pool.acquire(ben)
    const leoPaths = browserPathsFor({ agentRoot, assistantId: AGENT, principal: PERSON.principal })
    const benPaths = browserPathsFor({ agentRoot, assistantId: AGENT, principal: ben.principal })
    for (const d of [leoPaths.profileDir, benPaths.profileDir]) mkdirSync(d, { recursive: true })
    const marker = join(agentRoot, String(AGENT), 'people', LEO, 'revoked.json')
    mkdirSync(join(marker, '..'), { recursive: true })
    writeFileSync(marker, JSON.stringify({ reason: 'revoked', shareReason: 'share_revoked' }))
    const swept = await sweepEndedShares({ pool: r.pool, agentRoot, isOwnerPrincipal: (ctx: any) => ctx.principal === `user-${OWNER}`, log: () => {} })
    assert.deepEqual(swept, [LEO])
    assert.equal(r.pool.peek(PERSON), null, 'the browser was closed first')
    assert.ok(!existsSync(leoPaths.profileDir))
    assert.ok(r.pool.peek(ben), 'another person keeps theirs')
    assert.ok(existsSync(benPaths.profileDir))
  } finally { r.done() }
})

test('review finding 6: the sweep also removes folders of an ended share with no browser open (one written again after a close)', async () => {
  const r = core()
  try {
    const agentRoot = join(r.home, '.bgos-agent')
    const leoPaths = browserPathsFor({ agentRoot, assistantId: AGENT, principal: PERSON.principal })
    mkdirSync(leoPaths.profileDir, { recursive: true })
    const marker = join(agentRoot, String(AGENT), 'people', LEO, 'revoked.json')
    mkdirSync(join(marker, '..'), { recursive: true })
    writeFileSync(marker, JSON.stringify({ reason: 'revoked', shareReason: 'view_removed' }))
    const benPaths = browserPathsFor({ agentRoot, assistantId: AGENT, principal: 'user-user_Ben1' })
    mkdirSync(benPaths.profileDir, { recursive: true })
    mkdirSync(join(agentRoot, String(AGENT), 'people', 'user_Ben1'), { recursive: true })
    assert.deepEqual(await sweepEndedShares({ pool: r.pool, agentRoot, log: () => {} }), [LEO])
    assert.ok(!existsSync(leoPaths.profileDir))
    assert.ok(existsSync(benPaths.profileDir), 'no marker, kept')
    assert.deepEqual(await sweepEndedShares({ pool: r.pool, agentRoot, log: () => {} }), [], 'nothing left to do')
  } finally { r.done() }
})

test('H1: after every person\'s fill, success or not, the tab\'s history is forgotten before the page is released', async () => {
  const h = await hostRig([{ userId: LEO, askMode: 'never', items: [{ itemId: ITEM, ask: false }] }])
  try {
    assert.deepEqual(await h.run(), { filled: true })
    assert.deepEqual(h.steps, ['fill', 'forget history', 'release'])
    h.steps.length = 0
    assert.deepEqual(await h.run({ pageFill: async () => { h.steps.push('fill'); return { filled: false, reason: 'sign_in_failed' } } }), { filled: false, reason: 'sign_in_failed' })
    assert.deepEqual(h.steps, ['fill', 'forget history', 'release'])
    // A history that could not be forgotten is no success, and the page stays private.
    h.steps.length = 0
    const kept = await h.run({ forgetHistory: async () => { h.steps.push('forget history'); return { ok: false } } })
    assert.deepEqual(kept, { filled: false, reason: 'history_not_cleared', private: 'kept' })
    assert.deepEqual(h.steps, ['fill', 'forget history'], 'not released')
  } finally { h.done() }
})

test('H2: no anchored owner account on this host, no fill of the owner\'s login; M4: another login than asked is refused', async () => {
  const people = [{ userId: LEO, askMode: 'never', items: [{ itemId: null, ask: false }] }]
  const u = await hostRig(people, { anchored: false })
  try {
    assert.deepEqual(await u.run(), { filled: false, reason: 'vault_owner_account_unconfirmed' })
    assert.deepEqual(u.typed, [])
  } finally { u.done() }
  const h = await hostRig(people)
  try {
    assert.deepEqual(await h.run({ itemId: '3f1c3a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b' }), { filled: false, reason: 'vault_item_mismatch' })
    assert.deepEqual(h.typed, [])
  } finally { h.done() }
})

test('M6: a browser call that does not finish in time keeps the fill out: browser_busy, nothing redeemed, the hold let go', async () => {
  let called = 0
  const r = core({ vaultFill: async () => { called += 1; return { filled: true } } })
  try {
    const slot = await r.pool.acquire(PERSON)
    r.core.vaultFillDrainMs = 30
    slot.runningTools = new Set([new Promise(() => {})])
    const { sessionId, tabId } = await idsFor(r.core, PERSON)
    const answer = JSON.parse(textOf(await r.core.callTool(PERSON, 'hoai_vault_fill', { ticket: TICKET, itemId: ITEM, sessionId, tabId, origin: ORIGIN })))
    assert.deepEqual(answer, { filled: false, reason: 'browser_busy' })
    assert.equal(called, 0)
    assert.equal(slot.vaultHold, null)
    assert.equal(slot.ownerInputLease, null)
  } finally { r.done() }
})

test('H1: the live view takes no command while a login is being filled, and frames come back after', async () => {
  const page = fakePage()
  const engine: any = { pages: () => [page] }
  const slot: any = { engine }
  const pool: any = { peek: () => slot, slotKey: () => 'k' }
  const views = new RemoteBrowserViews({ pool })
  const sent: any[] = []
  const view: any = { viewId: 'v1', connectionId: 'c1', closed: false, context: PERSON, engine, page, sessionId: 's', tabId: 't', pendingFrame: null, latestFrame: null, queued: 0, tail: Promise.resolve(),
    cdp: { send: async () => ({}) }, sendFrame: (m: any) => { sent.push(m); return true } }
  views.views.set('v1', view)
  slot.vaultHold = { kind: 'vault_fill' }
  for (const method of ['hoai.input.acquire', 'hoai.input.pointer', 'hoai.browser.navigation', 'hoai.input.reload', 'Page.startScreencast']) {
    sent.length = 0
    const done = await views.command({ viewId: 'v1', frame: { id: 1, method, params: {}, sessionId: 's', tabId: 't' } }, 'c1')
    assert.equal(done, false, method)
    assert.equal(sent[0]?.frame?.error?.code, 'vault_fill_running', method)
  }
})

test('V2: before every person fill of an owner login the host asks who may still use which site; not listed, nothing is typed', async () => {
  const people = [{ userId: LEO, askMode: 'never', items: [{ itemId: null, ask: false }] }]
  const ok = await hostRig(people)
  try {
    assert.deepEqual(await ok.run(), { filled: true })
    assert.deepEqual(ok.accessAsks, [`https://api.example.com/api/v1/vault/host/people-access?assistantId=${AGENT}`])
  } finally { ok.done() }
  for (const [why, access, reason] of [
    ['the person is not listed', { assistantId: AGENT, people: [] }, 'vault_access_ended'],
    ['the site is not listed for them', { assistantId: AGENT, people: [{ userId: LEO, origins: ['https://other.example.com'] }] }, 'vault_access_ended'],
    ['their owner vault is off (origins [])', { assistantId: AGENT, people: [{ userId: LEO, origins: [] }] }, 'vault_access_ended'],
    ['no answer (404)', null, 'vault_access_unconfirmed'],
  ] as const) {
    const h = await hostRig(people, { access })
    try {
      assert.deepEqual(await h.run(), { filled: false, reason }, why)
      assert.deepEqual(h.typed, [], why)
    } finally { h.done() }
  }
})

/**
 * S3: Chromium's own password saving and autofill are off in the browser a
 * person's turn runs in: the preferences are written into the profile Chrome
 * starts with, BEFORE it launches, so no saved password prompt or store ever
 * holds the owner's login.
 */
test('S3: password saving and autofill are off before the browser launches', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hvp-')))
  try {
    let seen: any = null
    const engine: any = new ChromiumEngine({
      executable: '/nonexistent/chrome', profileDir: join(home, 'browser', 'k'), outputDir: join(home, 'output', 'k'), scope: 'fixture',
      launch: (async ({ profileDir }: { profileDir: string }) => {
        seen = JSON.parse(readFileSync(join(profileDir, 'Default', 'Preferences'), 'utf8'))
        throw new Error('stop before a real launch')
      }) as never,
    })
    await assert.rejects(engine.start(), /stop before a real launch/)
    assert.ok(seen, 'the preferences were there when Chrome would start')
    assert.equal(seen.credentials_enable_service, false)
    assert.equal(seen.profile.password_manager_enabled, false)
    assert.equal(seen.autofill.profile_enabled, false)
    assert.equal(seen.autofill.credit_card_enabled, false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
