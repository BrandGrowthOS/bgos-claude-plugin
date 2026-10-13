/**
 * The owner's Always allow and Trust this site outlive the browser host
 * (HOAI board row b774a758).
 *
 * THE BUG THIS PINS. The host files a remembered answer under
 * profiles.agentProfileKey(...), the desktop's own key function, vendored
 * byte for byte. That function takes the agent id as a STRING ("relay:<id>"
 * for an assistant the backend resolved, "<client>@<version>" for a loopback
 * client) and returns null for anything else. The host handed it
 * ctx.assistantId, which relay() has already turned into a NUMBER, so the key
 * was always null and _remember() wrote nothing: every Always allow and every
 * Trust this site lasted until the host restarted, and the owner was asked
 * again.
 *
 * What each case buys:
 *  - restart, same agent: the two answers meant to last do last, filed under
 *    "assistant-<id>", the key the desktop uses for the same assistant.
 *  - a different agent: one agent's trust never reaches another, even when
 *    the other agent's folder holds a copy of the first one's settings file.
 *  - an invalid id: no key, so nothing is written anywhere (fail closed).
 *  - revoke: profiles.withoutTrustGrant, the revoke the desktop runs, finds
 *    the trust under that same key and takes it off for good.
 *  - Allow once and Allow for this session: still never written to disk.
 *
 * No real Chrome: the real pool, host core, gate keeper and settings file
 * over a fake engine and a fake backend that answers each card with the
 * choice the case sets. A "restart" is a new pool, core and gate keeper over
 * the same agent root.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BrowserHostCore, BrowserPool, browserPathsFor, hostProfiles, hostSettings } from '../bin/hoai-browser-host.mjs'
import { GateKeeper } from '../lib/browser-gate.mjs'

type Card = Record<string, any>

const SITE = 'https://shop.example.com'
const OWNER = 'owner'

/** A backend that answers every card at once with `choice`. */
function backend(choice: string) {
  const cards: Card[] = []
  const answered = new Map<string, string>()
  return {
    cards,
    postCard: async (card: Card) => {
      cards.push(card)
      answered.set(String(card.gateId), choice)
      return true
    },
    readGate: async (gateId: string) => (answered.has(gateId) ? { state: 'answered', choice: answered.get(gateId) } : { state: 'unknown', choice: null }),
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
  const tools = [
    { name: 'browser_navigate', description: '', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
    { name: 'browser_click', description: '', inputSchema: { type: 'object', properties: { element: { type: 'string' } } } },
  ]
  const core: any = new BrowserHostCore({ pool, browserTools: tools, deviceLabel: 'box-1', gates })
  const call = async (assistantId: unknown, name: string, args: Record<string, unknown> = {}) => {
    try {
      const r = await core.callTool({ assistantId, principal: OWNER, assistantName: 'Data' }, name, args)
      return { isError: r.isError === true, text: (r.content ?? []).map((c: any) => c.text ?? '').join('\n') }
    } catch (err: any) {
      // A call with no usable id never gets a browser: refused, not run.
      return { isError: true, text: String(err?.message ?? err) }
    }
  }
  return { srv, core, pool, call, stop: () => pool.stopAll() }
}

function root() {
  const home = mkdtempSync(join(tmpdir(), 'trust-persist-'))
  return { home, agentRoot: join(home, '.bgos-agent'), done: () => rmSync(home, { recursive: true, force: true }) }
}

function profileDir(agentRoot: string, assistantId: number) {
  return browserPathsFor({ agentRoot, assistantId, principal: OWNER }).profileDir
}

function savedSettings(agentRoot: string, assistantId: number) {
  const file = hostSettings.settingsPath(profileDir(agentRoot, assistantId))
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

/** Every file under a folder, relative, sorted: what a run left on disk. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p, rel ? `${rel}/${name}` : name)
      else out.push(rel ? `${rel}/${name}` : name)
    }
  }
  walk(dir, '')
  return out.sort()
}

/** Agent `id` asks for SITE, the owner answers `choice`, the host goes away. */
async function answerOnce(agentRoot: string, id: number, choice: string) {
  const host = startHost(agentRoot, choice)
  const nav = await host.call(id, 'browser_navigate', { url: `${SITE}/` })
  assert.equal(nav.isError, false, nav.text)
  assert.equal(host.srv.cards.length, 1, 'the first visit asks the owner')
  assert.ok(host.srv.cards[0].choices.includes(choice), `the navigate card offers ${choice}`)
  await host.stop()
}

test('Always allow survives a host restart for the same agent, filed under its assistant key in its own folder', async () => {
  const r = root()
  try {
    await answerOnce(r.agentRoot, 900, 'always_allow')
    const saved = savedSettings(r.agentRoot, 900)
    assert.ok(saved, 'the answer is written to the agent\'s own browser settings')
    assert.deepEqual(Object.keys(saved.agentGrants ?? {}), ['assistant-900'])
    assert.equal(saved.agentGrants['assistant-900'][SITE].access, 'allow')

    const after = startHost(r.agentRoot, 'deny')
    const nav = await after.call(900, 'browser_navigate', { url: `${SITE}/again` })
    assert.equal(nav.isError, false, nav.text)
    assert.equal(after.srv.cards.length, 0, 'after a restart the same agent is not asked again')
    await after.stop()
  } finally {
    r.done()
  }
})

test('Trust this site survives a host restart for the same agent and covers the whole site', async () => {
  const r = root()
  try {
    await answerOnce(r.agentRoot, 900, 'trust_site')
    const saved = savedSettings(r.agentRoot, 900)
    assert.ok(saved, 'the trust is written to the agent\'s own browser settings')
    assert.equal(hostProfiles.trustedOrigins(saved, 'assistant-900').join(','), SITE)

    const after = startHost(r.agentRoot, 'deny')
    const nav = await after.call(900, 'browser_navigate', { url: `${SITE}/cart` })
    assert.equal(nav.isError, false, nav.text)
    const click = await after.call(900, 'browser_click', { element: 'Add to cart' })
    assert.equal(click.isError, false, click.text)
    assert.equal(after.srv.cards.length, 0, 'a trusted site is neither navigated nor written to under a card')
    await after.stop()
  } finally {
    r.done()
  }
})

test("a different agent never inherits another agent's Always allow or trust, even from a copy of its settings file", async () => {
  const r = root()
  try {
    await answerOnce(r.agentRoot, 900, 'trust_site')
    const host = startHost(r.agentRoot, 'always_allow')
    await host.call(900, 'browser_navigate', { url: `${SITE}/` })
    assert.equal(host.srv.cards.length, 0)
    await host.stop()
    const mine = savedSettings(r.agentRoot, 900)
    // Whatever key the host filed it under: this case is about the leak, not the name.
    assert.ok(Object.keys(mine?.agentGrants ?? {}).length > 0, 'agent 900 has a remembered grant to leak')

    // The worst case: agent 901's folder holds a copy of 900's file.
    mkdirSync(profileDir(r.agentRoot, 901), { recursive: true })
    writeFileSync(hostSettings.settingsPath(profileDir(r.agentRoot, 901)), JSON.stringify(mine))

    const other = startHost(r.agentRoot, 'deny')
    const nav = await other.call(901, 'browser_navigate', { url: `${SITE}/` })
    assert.equal(nav.isError, true, 'agent 901 is asked, and the owner\'s Deny holds')
    assert.equal(other.srv.cards.length, 1, 'agent 901 is asked about a site only agent 900 is trusted on')
    assert.equal(other.srv.cards[0].assistantId, 901)
    await other.stop()
    const after = savedSettings(r.agentRoot, 900)
    assert.deepEqual(after, mine, 'nothing of agent 901 lands in agent 900\'s file')
  } finally {
    r.done()
  }
})

test('a missing or invalid agent id has no key and saves nothing anywhere', async () => {
  const r = root()
  try {
    const core: any = startHost(r.agentRoot, 'always_allow').core
    for (const bad of [undefined, null, 0, -900, 1.5, Number.NaN, 2 ** 53, '', ' ', '900a', 'relay:900', 'unknown', {}, [900]]) {
      assert.equal(core._profileKey({ assistantId: bad }), null, `no key for ${JSON.stringify(bad)}`)
    }
    assert.equal(core._profileKey({ assistantId: 900 }), 'assistant-900')
    assert.equal(core._profileKey({ assistantId: '900' }), 'assistant-900', 'the id as digits is the same agent')
    assert.notEqual(core._profileKey({ assistantId: 900 }), core._profileKey({ assistantId: 901 }))

    // Through the host: a call with no usable id never reaches a browser.
    for (const choice of ['always_allow', 'trust_site']) {
      const host = startHost(r.agentRoot, choice)
      const nav = await host.call('not-an-id', 'browser_navigate', { url: `${SITE}/` })
      assert.equal(nav.isError, true)
      await host.stop()
    }
    assert.deepEqual(filesUnder(r.agentRoot), [], 'nothing written under the agent root')

    // And _remember itself, handed a real folder but no usable id, writes nothing.
    const dir = join(r.home, 'some-profile')
    mkdirSync(dir, { recursive: true })
    for (const choice of ['always_allow', 'trust_site']) {
      const slot: any = { paths: { profileDir: dir }, grants: null, settings: null }
      core._remember({ assistantId: null, principal: OWNER }, slot, core._settingsFor(slot), { gate: 'navigate', origin: SITE, choice })
    }
    assert.deepEqual(filesUnder(dir), [], 'no settings file for an agent with no key')
  } finally {
    r.done()
  }
})

test("revoking the trust (the desktop's withoutTrustGrant) takes it off for good, and the owner is asked again after a restart", async () => {
  const r = root()
  try {
    await answerOnce(r.agentRoot, 900, 'trust_site')
    const dir = profileDir(r.agentRoot, 900)
    let revoked = false
    hostSettings.updateSettings(dir, (fresh: any) => {
      const next = hostProfiles.withoutTrustGrant(fresh, 'assistant-900', SITE)
      revoked = next !== null
      return next || fresh
    })
    assert.equal(revoked, true, 'the revoke finds the trust under the key the host filed it under')
    assert.deepEqual(hostProfiles.trustedOrigins(savedSettings(r.agentRoot, 900), 'assistant-900'), [])

    const after = startHost(r.agentRoot, 'deny')
    const nav = await after.call(900, 'browser_navigate', { url: `${SITE}/` })
    assert.equal(nav.isError, true, 'the owner\'s Deny holds')
    assert.equal(after.srv.cards.length, 1, 'a revoked site is asked about again')
    await after.stop()
  } finally {
    r.done()
  }
})

for (const choice of ['allow_once', 'allow_session']) {
  test(`${choice} is never written to disk and does not survive a restart`, async () => {
    const r = root()
    try {
      await answerOnce(r.agentRoot, 900, choice)
      const saved = savedSettings(r.agentRoot, 900)
      assert.deepEqual(saved?.agentGrants ?? {}, {}, `${choice} files no grant`)

      const after = startHost(r.agentRoot, 'deny')
      const nav = await after.call(900, 'browser_navigate', { url: `${SITE}/` })
      assert.equal(nav.isError, true)
      assert.equal(after.srv.cards.length, 1, `after a restart the owner is asked again despite ${choice}`)
      await after.stop()
    } finally {
      r.done()
    }
  })
}
