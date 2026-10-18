/**
 * The owner lists and forgets the answers the agent's own browser saved
 * (Always allow, Trust this site), and a forgotten site asks again
 * (HOAI board row 79fda9a6).
 *
 * THE GAP THIS PINS. Since 0.68.5 (#224) the browser host files every Always
 * allow and Trust this site under agentGrants["assistant-<id>"] in
 * ~/.bgos-agent/<id>/browser/<principal>/agent-browser.settings.json, and
 * nothing but a hand edit of that file could take one back.
 *
 * What each case buys:
 *  - a forgotten site asks again, on the next visit of the SAME live browser
 *    (the grant cached on the slot goes too) and after a restart (the file);
 *  - forgetting one site leaves every other saved site working;
 *  - forget all clears every saved answer of this agent, in every person's
 *    folder, and keeps an owner's Deny;
 *  - the list is per agent: another agent's saved sites never appear in it
 *    and a forget never touches them;
 *  - the agent itself cannot forget: no tool on its own channel does it, and
 *    the socket event that does is refused for an agent this pairing does
 *    not serve;
 *  - the file stays readable by an older host: unknown keys survive, and the
 *    vendored sessionGrants still reads what is left.
 *
 * No real Chrome: the real pool, host core, gate keeper and settings file
 * over a fake engine and a fake backend that answers each card with the
 * choice the case sets, as test/hoai-browser-host.trust-persist.test.ts does.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BrowserHostCore, BrowserPool, PairingConnection, SESSION_TOOLS, browserPathsFor, handshakeOptions, hostProfiles, hostSettings } from '../bin/hoai-browser-host.mjs'
import { GateKeeper } from '../lib/browser-gate.mjs'

type Card = Record<string, any>

const SHOP = 'https://shop.example.com'
const MAIL = 'https://mail.example.com'
const OWNER = 'owner'
const KEY = (id: number) => `assistant-${id}`

/** A backend whose answer to the next card the case can change. */
function backend(initial: string) {
  const cards: Card[] = []
  const answered = new Map<string, string>()
  const state = { choice: initial }
  return {
    cards,
    state,
    postCard: async (card: Card) => {
      cards.push(card)
      answered.set(String(card.gateId), state.choice)
      return true
    },
    readGate: async (gateId: string) => ({ state: answered.has(gateId) ? 'answered' : 'unknown', choice: answered.get(gateId) ?? null }),
  }
}

/** One run of the host: what a restart throws away and builds again. */
function startHost(agentRoot: string, choice: string) {
  const srv = backend(choice)
  let n = 0
  const gates = new GateKeeper({ postCard: srv.postCard, readGate: srv.readGate, randomBytes: (k: number) => Buffer.from(`${++n}`.padStart(k, 'g')), sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)), pollMs: 5 })
  const pool = new BrowserPool({
    agentRoot,
    createEngine: () => {
      let url = 'about:blank'
      return {
        alive: false,
        async start() {
          this.alive = true
        },
        pages: () => [{ url: () => url, title: async () => 'Page' }],
        async callTool(name: string, args: Record<string, any>) {
          if (name === 'browser_navigate') url = String(args.url)
          return { content: [{ type: 'text', text: `${name} ran` }] }
        },
        async stop() {
          this.alive = false
        },
      }
    },
  })
  const tools = [{ name: 'browser_navigate', description: '', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } }]
  const core: any = new BrowserHostCore({ pool, browserTools: tools, deviceLabel: 'box-1', gates })
  const call = async (assistantId: number, name: string, args: Record<string, unknown> = {}, principal = OWNER) => {
    const r = await core.callTool({ assistantId, principal, assistantName: 'Data' }, name, args)
    return { isError: r.isError === true, text: (r.content ?? []).map((c: any) => c.text ?? '').join('\n') }
  }
  /** Visit a site and say whether the owner was asked. */
  const visit = async (assistantId: number, site: string, principal = OWNER) => {
    const before = srv.cards.length
    const nav = await call(assistantId, 'browser_navigate', { url: `${site}/` }, principal)
    assert.equal(nav.isError, false, nav.text)
    return srv.cards.length > before
  }
  return { srv, core, pool, call, visit, stop: () => pool.stopAll() }
}

function root() {
  const home = mkdtempSync(join(tmpdir(), 'forget-sites-'))
  return { home, agentRoot: join(home, '.bgos-agent'), done: () => rmSync(home, { recursive: true, force: true }) }
}

function settingsFile(agentRoot: string, assistantId: number, principal = OWNER) {
  return hostSettings.settingsPath(browserPathsFor({ agentRoot, assistantId, principal }).profileDir)
}

function saved(agentRoot: string, assistantId: number, principal = OWNER) {
  const file = settingsFile(agentRoot, assistantId, principal)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

/** Write a settings file by hand, as an earlier host (or a person) left it. */
function writeSaved(agentRoot: string, assistantId: number, settings: Record<string, unknown>, principal = OWNER) {
  const dir = browserPathsFor({ agentRoot, assistantId, principal }).profileDir
  mkdirSync(dir, { recursive: true })
  writeFileSync(hostSettings.settingsPath(dir), JSON.stringify(settings, null, 2) + '\n')
}

const origins = (list: any) => (list.sites as any[]).map((s) => s.origin)

test('a forgotten Always allow asks again on the next visit, in the same live browser and after a restart', async () => {
  const r = root()
  try {
    const host = startHost(r.agentRoot, 'always_allow')
    assert.equal(await host.visit(900, SHOP), true, 'the first visit asks')
    assert.equal(await host.visit(900, SHOP), false, 'Always allow holds in the live browser')
    assert.deepEqual(origins(host.core.savedSites(900)), [SHOP])

    host.srv.state.choice = 'allow_once'
    const forgot = host.core.forgetSavedSites(900, { origin: SHOP })
    assert.equal(forgot.ok, true)
    assert.equal(forgot.forgot, 1)
    assert.deepEqual(forgot.sites, [])
    assert.equal(await host.visit(900, SHOP), true, 'the live browser asks again: the slot dropped its cached grant')
    await host.stop()

    assert.equal(saved(r.agentRoot, 900).agentGrants[KEY(900)][SHOP], undefined, 'the file no longer holds it')
    const again = startHost(r.agentRoot, 'allow_once')
    assert.equal(await again.visit(900, SHOP), true, 'after a restart it still asks')
    await again.stop()
  } finally {
    r.done()
  }
})

test('a forgotten Trust this site asks again, and the list said it was trusted', async () => {
  const r = root()
  try {
    const host = startHost(r.agentRoot, 'trust_site')
    assert.equal(await host.visit(900, SHOP), true)
    const [row] = host.core.savedSites(900).sites
    assert.deepEqual(row, { origin: SHOP, trusted: true, allowed: [] })
    host.srv.state.choice = 'allow_once'
    assert.equal(host.core.forgetSavedSites(900, { origin: SHOP }).forgot, 1)
    assert.equal(await host.visit(900, SHOP), true)
    await host.stop()
  } finally {
    r.done()
  }
})

test('forgetting one site leaves every other saved site working', async () => {
  const r = root()
  try {
    const host = startHost(r.agentRoot, 'always_allow')
    assert.equal(await host.visit(900, SHOP), true)
    host.srv.state.choice = 'trust_site'
    assert.equal(await host.visit(900, MAIL), true)
    assert.deepEqual(origins(host.core.savedSites(900)), [MAIL, SHOP], 'sorted, so the list does not reshuffle')

    host.srv.state.choice = 'allow_once'
    const out = host.core.forgetSavedSites(900, { origin: SHOP })
    assert.deepEqual(origins(out), [MAIL])
    assert.equal(await host.visit(900, MAIL), false, 'the other site still opens without asking')
    assert.equal(await host.visit(900, SHOP), true)
    await host.stop()
    assert.equal(saved(r.agentRoot, 900).agentGrants[KEY(900)][MAIL].trust, 'allow')
  } finally {
    r.done()
  }
})

test('forget all clears every saved answer of this agent in every person folder, and keeps a Deny', async () => {
  const r = root()
  try {
    // BOTH: trusted once, then denied (applyGateAnswer keeps the trust beside
    // the Deny). The forget takes the trust and keeps the Deny.
    const BOTH = 'https://both.example.com'
    writeSaved(r.agentRoot, 900, { v: 2, agentGrants: { [KEY(900)]: { [SHOP]: { access: 'allow' }, 'https://bad.example.com': { access: 'deny' }, [BOTH]: { access: 'deny', trust: 'allow' } } } })
    writeSaved(r.agentRoot, 900, { v: 2, agentGrants: { [KEY(900)]: { [MAIL]: { trust: 'allow' } } } }, 'user-friend')
    const host = startHost(r.agentRoot, 'allow_once')
    assert.deepEqual(origins(host.core.savedSites(900)), [MAIL, SHOP], 'both people, one list; a refused site (a Deny, alone or over a trust) is not listed as saved')
    // The friend's browser is LIVE and has the trust cached before the forget.
    assert.equal(await host.visit(900, MAIL, 'user-friend'), false)

    const out = host.core.forgetSavedSites(900, { all: true })
    assert.equal(out.ok, true)
    assert.equal(out.forgot, 3)
    assert.deepEqual(out.sites, [])
    assert.equal(await host.visit(900, SHOP), true)
    assert.equal(await host.visit(900, MAIL, 'user-friend'), true, "the friend's live browser asks again too")
    await host.stop()
    assert.deepEqual(saved(r.agentRoot, 900).agentGrants[KEY(900)], { 'https://bad.example.com': { access: 'deny' }, [BOTH]: { access: 'deny' } })
    assert.deepEqual(saved(r.agentRoot, 900, 'user-friend').agentGrants[KEY(900)], {})
  } finally {
    r.done()
  }
})

test('the list and the forget are per agent: another agent keeps its own saved sites', async () => {
  const r = root()
  try {
    const host = startHost(r.agentRoot, 'always_allow')
    assert.equal(await host.visit(900, SHOP), true)
    assert.equal(await host.visit(901, SHOP), true)
    assert.deepEqual(origins(host.core.savedSites(902)), [], 'an agent with no folder lists nothing')
    host.core.forgetSavedSites(900, { all: true })
    assert.deepEqual(origins(host.core.savedSites(901)), [SHOP])
    assert.equal(await host.visit(901, SHOP), false, 'agent 901 is not asked again')
    await host.stop()
  } finally {
    r.done()
  }
})

test('a forget the file cannot hold says so; nothing to forget is not a failure', async () => {
  const r = root()
  try {
    const host = startHost(r.agentRoot, 'allow_once')
    assert.deepEqual(host.core.forgetSavedSites(900, { origin: SHOP }), { ok: true, forgot: 0, sites: [] })
    assert.equal(host.core.forgetSavedSites(900, {}).ok, false, 'neither one site nor all is refused')
    assert.equal(host.core.forgetSavedSites(900, { origin: SHOP, all: true }).ok, false, 'both at once is refused')
    assert.equal(host.core.forgetSavedSites(0, { all: true }).ok, false, 'no agent id, no forget')
    if (process.platform !== 'win32') {
      writeSaved(r.agentRoot, 900, { v: 2, agentGrants: { [KEY(900)]: { [SHOP]: { access: 'allow' } } } })
      chmodSync(settingsFile(r.agentRoot, 900), 0o000)
      try {
        const out = host.core.forgetSavedSites(900, { all: true })
        assert.equal(out.ok, false, 'a file the host could not read and rewrite is not reported as forgotten')
        assert.equal(out.reason, 'not_saved')
      } finally {
        chmodSync(settingsFile(r.agentRoot, 900), 0o600)
      }
    }
    await host.stop()
  } finally {
    r.done()
  }
})

test('the file stays valid for an older host: unknown keys survive, and sessionGrants reads what is left', async () => {
  const r = root()
  try {
    writeSaved(r.agentRoot, 900, {
      v: 2,
      futureSwitch: { kept: true },
      allowVision: true,
      alwaysGrants: { [SHOP]: { access: 'allow' } },
      agentGrants: { [KEY(900)]: { [SHOP]: { access: 'allow', write: 'allow', futureGate: 'allow' }, [MAIL]: { access: 'allow' } }, 'client-other': { [SHOP]: { access: 'allow' } } },
    })
    const host = startHost(r.agentRoot, 'allow_once')
    assert.deepEqual(host.core.savedSites(900).sites.find((s: any) => s.origin === SHOP), { origin: SHOP, trusted: false, allowed: ['open', 'write'] })
    host.core.forgetSavedSites(900, { origin: SHOP })
    await host.stop()
    const file = saved(r.agentRoot, 900)
    assert.deepEqual(file.futureSwitch, { kept: true }, 'a key this host does not know is kept')
    assert.equal(file.allowVision, true)
    assert.deepEqual(file.agentGrants['client-other'], { [SHOP]: { access: 'allow' } }, 'another key in the file is untouched')
    assert.deepEqual(file.alwaysGrants, {}, 'the legacy map the session also reads is cleared for that site')
    // A field this host does not know (futureGate) goes with its site: a
    // forget that left part of a grant behind would not be a forget.
    assert.deepEqual(hostProfiles.sessionGrants(file, KEY(900)), { [MAIL]: { access: 'allow' } })
  } finally {
    r.done()
  }
})

test('the agent cannot forget through its own channel: no tool does it, and an unknown tool changes nothing', async () => {
  const r = root()
  try {
    const host = startHost(r.agentRoot, 'always_allow')
    assert.equal(await host.visit(900, SHOP), true)
    const names = (await host.core.roster()).map((t: any) => t.name)
    assert.ok(!names.some((n: string) => /forget|saved|revoke|trust/i.test(n)), `no forget tool on the agent's roster: ${names.join(', ')}`)
    assert.ok(!SESSION_TOOLS.some((t: any) => /forget|saved|revoke/i.test(t.name)))
    const before = readFileSync(settingsFile(r.agentRoot, 900), 'utf8')
    const res = await host.call(900, 'hoai_browser_forget_sites', { all: true })
    assert.equal(res.isError, true)
    assert.equal(readFileSync(settingsFile(r.agentRoot, 900), 'utf8'), before)
    await host.stop()
  } finally {
    r.done()
  }
})

/** A fake socket.io client socket that can deliver an event with an ack. */
function fakeSocket() {
  const socket: any = Object.assign(new EventEmitter(), { id: 'host-socket', connected: true, connect() {}, disconnect() {} })
  socket.ask = (event: string, payload: unknown) =>
    new Promise((resolve) => {
      if (!socket.emit(event, payload, resolve)) resolve('no listener')
    })
  return socket
}

test('the owner request reaches the host only as browser_saved_sites, only for an agent this pairing serves', async () => {
  const seen: any[] = []
  const socket = fakeSocket()
  const conn = new PairingConnection({
    pairing: { key: 'k', pairingId: 1, backendUrl: 'https://api.test', token: 'tok', assistantIds: [900] },
    deviceLabel: 'box',
    relay: {} as any,
    io: (() => socket) as any,
    savedSites: (input: any) => {
      seen.push(input)
      return input.op === 'list' ? { ok: true, sites: [] } : { ok: true, forgot: 1, sites: [] }
    },
  } as any).start()
  try {
    socket.emit('connect')
    assert.deepEqual(await socket.ask('browser_saved_sites', { assistantId: 900, op: 'list' }), { ok: true, sites: [] })
    assert.deepEqual(await socket.ask('browser_saved_sites', { assistantId: 900, op: 'forget', origin: SHOP }), { ok: true, forgot: 1, sites: [] })
    assert.deepEqual(await socket.ask('browser_saved_sites', { assistantId: 901, op: 'forget', all: true }), { ok: false, reason: 'not_served' })
    assert.deepEqual(await socket.ask('browser_saved_sites', { assistantId: 900, op: 'grant', origin: SHOP }), { ok: false, reason: 'bad_request' })
    assert.deepEqual(await socket.ask('browser_saved_sites', { assistantId: 900, op: 'forget', origin: 42 }), { ok: false, reason: 'bad_request' })
    assert.equal(seen.length, 2, 'only the two well formed requests for a served agent reached the host')
    assert.deepEqual(seen[1], { assistantId: 900, op: 'forget', origin: SHOP })
  } finally {
    conn.stop()
  }
})

test('a forget keeps every Deny the policy enforces, per kind as well as for the whole site', async () => {
  const r = root()
  try {
    writeSaved(r.agentRoot, 900, { v: 2, agentGrants: { [KEY(900)]: { [SHOP]: { access: 'allow', uploads: 'deny', downloads: 'deny' } } } })
    const host = startHost(r.agentRoot, 'allow_once')
    assert.equal(host.core.forgetSavedSites(900, { origin: SHOP }).forgot, 1)
    await host.stop()
    assert.deepEqual(saved(r.agentRoot, 900).agentGrants[KEY(900)], { [SHOP]: { uploads: 'deny', downloads: 'deny' } })
  } finally {
    r.done()
  }
})

test('a symbolic link among the person folders is never followed: its file is neither listed nor written', async () => {
  if (process.platform === 'win32') return
  const r = root()
  try {
    const elsewhere = join(r.home, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    const target = join(elsewhere, 'agent-browser.settings.json')
    const body = JSON.stringify({ v: 2, agentGrants: { [KEY(900)]: { [SHOP]: { access: 'allow' } } } })
    writeFileSync(target, body)
    mkdirSync(join(r.agentRoot, '900', 'browser'), { recursive: true })
    symlinkSync(elsewhere, join(r.agentRoot, '900', 'browser', 'user-linked'))
    const host = startHost(r.agentRoot, 'allow_once')
    assert.deepEqual(origins(host.core.savedSites(900)), [])
    host.core.forgetSavedSites(900, { all: true })
    await host.stop()
    assert.equal(readFileSync(target, 'utf8'), body)
  } finally {
    r.done()
  }
})

test('a site saved only in the legacy map and cached in a live browser asks again after a forget', async () => {
  const r = root()
  try {
    writeSaved(r.agentRoot, 900, { v: 1, alwaysGrants: { [SHOP]: { access: 'allow' } } })
    const host = startHost(r.agentRoot, 'allow_once')
    assert.equal(await host.visit(900, SHOP), false, 'the legacy grant is honoured and now cached')
    assert.equal(host.core.forgetSavedSites(900, { origin: SHOP }).forgot, 1)
    assert.equal(await host.visit(900, SHOP), true)
    await host.stop()
  } finally {
    r.done()
  }
})

test('the host tells the backend it answers browser_saved_sites, in its handshake', () => {
  const opts: any = handshakeOptions({ token: 'tok', assistantIds: [900] }, 'box')
  assert.deepEqual(opts.auth.features, ['saved_sites'])
  assert.equal(opts.auth.role, 'browser_host')
})
