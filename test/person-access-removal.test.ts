/**
 * REMOVING A PERSON'S ACCESS TO AN OWNER LOGIN REMOVES IT FROM THEIR BROWSER,
 * whatever fails along the way (fix round 377, finding 2).
 *
 * WHAT THESE TESTS HOLD.
 *   - the record of filled sites fails closed: a fill whose site cannot be
 *     recorded types nothing, a full record refuses a new site rather than
 *     forget one, and an unreadable record is never read as empty or written
 *     over;
 *   - a reconcile writes only its own removals, after their effects, onto the
 *     record as it is then: a fill recorded while it awaited stays; a removal
 *     whose effect failed stays recorded, and a queued change that failed is
 *     queued again;
 *   - a browser is not handed out until its startup clear has finished, and
 *     a startup clear that cannot run closes that browser;
 *   - the saved, encrypted copy of the person's site state forgets a lost
 *     site, so an unlock later never restores it;
 *   - a profile whose deletion failed is kept owed and deleted before that
 *     browser opens again.
 *
 * Run with: npx tsx --test test/person-access-removal.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as access from '../lib/person-access.mjs'
import * as vaultModule from '../lib/agent-browser-vault.mjs'
import { BrowserPool } from '../bin/hoai-browser-host.mjs'

const pa: any = access
const vm: any = vaultModule
const AGENT = 901
const OWNER = 'user_owner'
const LEO = 'user_leo'
const A = 'https://a.example.com'
const B = 'https://b.example.com'

function rig() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pa-removal-')))
  const agentRoot = join(root, '.bgos-agent')
  mkdirSync(join(agentRoot, String(AGENT)), { recursive: true })
  return { root, agentRoot, done: () => rmSync(root, { recursive: true, force: true }) }
}
const recordPath = (agentRoot: string) => join(agentRoot, String(AGENT), 'vault-people-access.json')

test('a site that cannot be recorded is a fill that does not happen: the write failing, the record full, the record unreadable', () => {
  const r = rig()
  try {
    // The write fails: the error reaches the caller, it is not swallowed here.
    const failing = { ...nodeFs, writeFileSync: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) } }
    assert.throws(() => pa.recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origin: A, fs: failing }))
    // Full: the 201st site is refused, and all 200 recorded are kept.
    for (let i = 0; i < 200; i++) pa.recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origin: `https://s${i}.example.com` })
    assert.throws(() => pa.recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origin: A }), (e: any) => e.code === 'access_record_full')
    assert.equal(pa.readAccessRecord({ agentRoot: r.agentRoot, assistantId: AGENT })[LEO].length, 200)
    // A site already recorded is no new site.
    pa.recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origin: 'https://s0.example.com' })
    // Unreadable: thrown, never read as empty, and never written over.
    writeFileSync(recordPath(r.agentRoot), '{not json')
    assert.throws(() => pa.readAccessRecord({ agentRoot: r.agentRoot, assistantId: AGENT }), (e: any) => e.code === 'access_record_unreadable')
    assert.throws(() => pa.recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origin: B }))
    assert.equal(readFileSync(recordPath(r.agentRoot), 'utf8'), '{not json')
  } finally { r.done() }
})

test('the host types nothing when the site could not be recorded', () => {
  const host = readFileSync(join(import.meta.dirname, '..', 'bin', 'hoai-browser-host.mjs'), 'utf8')
  const record = host.indexOf('recordFillOrigin({ agentRoot, assistantId, userId: actingUserId, origin })')
  const fill = host.indexOf('await pageFill(page,', record)
  assert.ok(record > 0 && fill > record, 'recorded before the fill')
  const between = host.slice(record, fill)
  assert.match(between, /catch \(err\) \{\n\s*return \{ filled: false, reason: err\?\.code === 'access_record_full' \? 'vault_access_record_full' : 'vault_access_unrecorded' \}/)
})

test('a fill recorded while a reconcile awaits its clear is not lost when the reconcile writes', async () => {
  const r = rig()
  try {
    pa.recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origin: A })
    const answer = { assistantId: AGENT, people: [{ userId: LEO, origins: [] }] }
    await pa.reconcilePeopleAccess({
      agentRoot: r.agentRoot, assistantId: AGENT, answer, ownerUserId: OWNER,
      // While the clear of A is awaited, a fill of B is recorded.
      clearOrigins: async () => { pa.recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origin: B }); return true },
      deleteProfile: async () => true,
    })
    assert.deepEqual(pa.readAccessRecord({ agentRoot: r.agentRoot, assistantId: AGENT }), { [LEO]: [B] }, 'A removed, B kept')
  } finally { r.done() }
})

test('a removal whose effect failed stays recorded, and a queued change that failed is queued again', async () => {
  const r = rig()
  try {
    pa.recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origin: A })
    pa.recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: 'user_ben', origin: B })
    const answer = { assistantId: AGENT, people: [{ userId: LEO, origins: [] }] }
    await pa.reconcilePeopleAccess({ agentRoot: r.agentRoot, assistantId: AGENT, answer, ownerUserId: OWNER, clearOrigins: async () => false, deleteProfile: async () => false })
    assert.deepEqual(pa.readAccessRecord({ agentRoot: r.agentRoot, assistantId: AGENT }), { [LEO]: [A], user_ben: [B] }, 'both kept for the next reconcile')
    // A queued change whose clear failed goes back in the queue.
    assert.equal(pa.queueAccessChange({ agentRoot: r.agentRoot, assistantId: AGENT, frame: { assistantId: AGENT, userId: LEO, all: false, origins: [A] } }), true)
    let fail = true
    const effects = { clearOrigins: async () => !fail, deleteProfile: async () => true }
    assert.equal(await pa.drainAccessChanges({ agentRoot: r.agentRoot, assistantId: AGENT, ownerUserId: OWNER, ...effects }), 0)
    fail = false
    assert.equal(await pa.drainAccessChanges({ agentRoot: r.agentRoot, assistantId: AGENT, ownerUserId: OWNER, ...effects }), 1, 'tried again, applied once')
    assert.deepEqual(pa.readAccessRecord({ agentRoot: r.agentRoot, assistantId: AGENT }), { user_ben: [B] })
  } finally { r.done() }
})

test('an unreadable record changes nothing and loses no queued change', async () => {
  const r = rig()
  try {
    writeFileSync(recordPath(r.agentRoot), '[]x')
    let effects = 0
    const fx = { clearOrigins: async () => { effects++; return true }, deleteProfile: async () => { effects++; return true } }
    await assert.rejects(pa.reconcilePeopleAccess({ agentRoot: r.agentRoot, assistantId: AGENT, answer: { assistantId: AGENT, people: [] }, ownerUserId: OWNER, ...fx }))
    pa.queueAccessChange({ agentRoot: r.agentRoot, assistantId: AGENT, frame: { assistantId: AGENT, userId: LEO, all: true, origins: [] } })
    assert.equal(await pa.drainAccessChanges({ agentRoot: r.agentRoot, assistantId: AGENT, ownerUserId: OWNER, ...fx }), 0)
    assert.equal(effects, 0)
    assert.equal(readFileSync(recordPath(r.agentRoot), 'utf8'), '[]x')
    assert.match(readFileSync(join(r.agentRoot, String(AGENT), 'vault-people-access.queue.jsonl'), 'utf8'), /user_leo/, 'still queued')
  } finally { r.done() }
})

// ── The browser is not handed out before its startup clear ──────────────────

function poolRig(opts: { afterStart?: any; pendingClear?: any; beforeStart?: any } = {}) {
  const r = rig()
  const engines: any[] = []
  const pool = new BrowserPool({
    agentRoot: r.agentRoot,
    createEngine: () => {
      const engine: any = { alive: false, stopped: 0, async start() { this.alive = true }, pages: () => [], async stop() { this.alive = false; this.stopped++ } }
      engines.push(engine)
      return engine
    },
    ...opts,
  } as any)
  return { ...r, pool, engines }
}
const PERSON = { assistantId: AGENT, principal: `user-${LEO}` }

test('a browser is not visible, nor handed to a second caller, until its startup clear has finished', async () => {
  let open!: () => void
  const clearing = new Promise<void>((resolve) => { open = resolve })
  let cleared = false
  const p = poolRig({ afterStart: async () => { await clearing; cleared = true; return true } })
  try {
    const first = p.pool.acquire(PERSON)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(p.pool.peek(PERSON), null, 'no browser to peek at while it is being cleared')
    let secondGot = false
    const second = p.pool.acquire(PERSON).then((slot: any) => { secondGot = true; return slot })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(secondGot, false, 'a second caller waits too')
    open()
    const [a, b] = await Promise.all([first, second])
    assert.equal(cleared, true)
    assert.equal(a, b)
    assert.ok(p.pool.peek(PERSON))
    assert.equal(p.engines.length, 1)
  } finally { p.done() }
})

test('a startup clear that cannot run closes the browser, and the caller gets no browser', async () => {
  const p = poolRig({ afterStart: async () => { throw new pa.PendingClearError() } })
  try {
    await assert.rejects(p.pool.acquire(PERSON), (e: any) => e.code === 'browser_cleanup_failed')
    assert.equal(p.engines[0].stopped, 1)
    assert.equal(p.pool.peek(PERSON), null)
  } finally { p.done() }
  // And the real clear throws when a clear waits and the browser has no page to run it in.
  const r = rig()
  try {
    writeFileSync(join(r.agentRoot, String(AGENT), 'vault-people-pending-clear.json'), JSON.stringify({ [LEO]: [A] }))
    await assert.rejects(pa.applyPendingClears({ agentRoot: r.agentRoot, assistantId: AGENT, principal: `user-${LEO}`, engine: { pages: () => [] } }), (e: any) => e.code === 'pending_clear_failed')
    assert.equal(pa.hasPendingClear({ agentRoot: r.agentRoot, assistantId: AGENT, principal: `user-${LEO}` }), true, 'still owed')
    // Nothing waiting: no throw, nothing done.
    assert.equal(await pa.applyPendingClears({ agentRoot: r.agentRoot, assistantId: AGENT, principal: 'user-user_other', engine: { pages: () => [] } }), false)
  } finally { r.done() }
})

test('a clear queued while the startup clear ran is run before the browser is handed out', async () => {
  let rounds = 0
  let queued = false
  const p = poolRig({
    afterStart: async () => { rounds++; queued = rounds === 1; return true },
    pendingClear: () => queued,
  })
  try {
    await p.pool.acquire(PERSON)
    assert.ok(rounds >= 2, 'ran again for the clear queued meanwhile')
  } finally { p.done() }
})

test('the host wires the startup clear, its synchronous check and the owed deletion into the pool', () => {
  const host = readFileSync(join(import.meta.dirname, '..', 'bin', 'hoai-browser-host.mjs'), 'utf8')
  assert.match(host, /pendingClear: \(ctx\) => hasPendingClear\(\{ agentRoot, assistantId: ctx\.assistantId, principal: ctx\.principal \}\)/)
  assert.match(host, /beforeStart: \(ctx\) => this\._retryProfileDelete\(ctx\)/)
  const acquire = host.slice(host.indexOf('  async acquire(ctx) {'), host.indexOf('  /** The slot only when its engine is running; never launches. */'))
  assert.ok(acquire.indexOf('slot.engine = engine') > acquire.indexOf('this.afterStart(engine, slot, ctx)'), 'handed out after the clear')
  assert.equal((acquire.match(/slot\.engine = engine/g) ?? []).length, 1)
})

// ── The saved copy forgets a lost site ───────────────────────────────────────

const PASSPHRASE = 'fixture person passphrase 123'
const SAVED = {
  cookies: [
    { name: 'sid', value: 'LOST_SITE_COOKIE', domain: '.example.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'keep', value: 'OTHER_SITE_COOKIE', domain: 'other.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
  ],
  origins: [
    { origin: 'https://login.example.test', localStorage: [{ name: 'auth', value: 'LOST_SITE_STORAGE' }] },
    { origin: 'https://other.test', localStorage: [{ name: 'auth', value: 'OTHER_SITE_STORAGE' }] },
  ],
}

async function savedCopy(t: any) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pa-saved-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'profile')
  const scope = vm.browserVaultScope({ assistantId: AGENT, principal: `user-${LEO}` })
  const vault = await vm.AgentBrowserVault.create({ profileDir: dir, scope, snapshotMs: 100000 })
  vault.bind({ storageState: async () => structuredClone(SAVED), setStorageState: async () => {} })
  await vault.unlock(PASSPHRASE); await vault.restore(); await vault.snapshot(); await vault.lock()
  return { dir, scope }
}

test('a site forgotten while the saved copy is locked is gone at the next unlock, before anything is restored', async (t) => {
  const { dir, scope } = await savedCopy(t)
  assert.equal(vm.forgetSavedSites(dir, ['login.example.test']), true)
  const reopened = await vm.AgentBrowserVault.create({ profileDir: dir, scope, snapshotMs: 100000 })
  t.after(() => reopened.lock())
  await reopened.unlock(PASSPHRASE)
  let restored: any
  await reopened.restore({ setStorageState: async (next: any) => { restored = next }, storageState: async () => ({ cookies: [], origins: [] }) })
  const text = JSON.stringify(restored)
  assert.equal(text.includes('LOST_SITE_COOKIE') || text.includes('LOST_SITE_STORAGE'), false, 'the lost site is not restored')
  assert.ok(text.includes('OTHER_SITE_COOKIE') && text.includes('OTHER_SITE_STORAGE'), 'another site is')
  assert.equal(existsSync(join(dir, 'agent-browser.vault.forget.json')), false, 'the mark is spent')
  // The forgetting was written: a further unlock does not bring it back either.
  await reopened.lock()
  await reopened.unlock(PASSPHRASE)
  await reopened.restore({ setStorageState: async (next: any) => { restored = next }, storageState: async () => ({ cookies: [], origins: [] }) })
  assert.equal(JSON.stringify(restored).includes('LOST_SITE_COOKIE'), false)
})

test('an open saved copy forgets the site at once, and the mark never blocks an unlock as a stray file', async (t) => {
  const { dir, scope } = await savedCopy(t)
  const vault = await vm.AgentBrowserVault.create({ profileDir: dir, scope, snapshotMs: 100000 })
  t.after(() => vault.lock())
  await vault.unlock(PASSPHRASE)
  assert.deepEqual(await vault.forgetSites(['login.example.test']), { forgotten: 'now' })
  await vault.lock()
  // A locked copy is marked, and the mark is not a leftover file that asks for consent to clear.
  assert.deepEqual(await vault.forgetSites(['other.test']), { forgotten: 'at_unlock' })
  assert.equal(vault.status().legacy, false)
  await vault.unlock(PASSPHRASE)
  let restored: any
  await vault.restore({ setStorageState: async (next: any) => { restored = next }, storageState: async () => ({ cookies: [], origins: [] }) })
  assert.equal(JSON.stringify(restored).includes('LOST_SITE_COOKIE'), false)
  assert.equal(JSON.stringify(restored).includes('OTHER_SITE_COOKIE'), false)
})

test('clearing a person\'s site marks the saved copy after the live browser no longer holds it, and a mark that fails is a clear that did not happen', async () => {
  const r = rig()
  try {
    const order: string[] = []
    const page = { isClosed: () => false, frames: () => [], context: () => ({ newCDPSession: async () => ({ send: async (m: string) => { order.push(m); return m === 'Storage.getCookies' ? { cookies: [] } : {} }, detach: async () => {} }) }) }
    const pool: any = { peek: () => ({ engine: { selectedPage: () => page, pages: () => [page] } }) }
    assert.equal(await pa.clearPersonOrigins({ pool, agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origins: [A], forgetSaved: async (hosts: string[]) => { order.push(`forget ${hosts.join(',')}`) } }), true)
    assert.ok(order.indexOf('forget a.example.com') > order.indexOf('Storage.clearDataForOrigin'), 'the saved copy after the live browser')
    assert.equal(await pa.clearPersonOrigins({ pool, agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origins: [A], forgetSaved: async () => { throw new Error('cannot write') } }), false)
    // A running browser whose live clear failed is closed, and the clear waits for its next start.
    let released = 0
    const broken: any = { peek: () => ({ engine: { pages: () => [] } }), release: async () => { released++ } }
    assert.equal(await pa.clearPersonOrigins({ pool: broken, agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origins: [B] }), true)
    assert.equal(released, 1)
    assert.equal(pa.hasPendingClear({ agentRoot: r.agentRoot, assistantId: AGENT, principal: `user-${LEO}` }), true)
  } finally { r.done() }
})

test('a person with no browser profile on this computer has nothing saved to forget: the removal completes', async () => {
  const r = rig()
  try {
    const missing = join(r.root, 'no-such-profile')
    assert.equal(vm.forgetSavedSites(missing, ['a.example.com']), true)
    pa.recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origin: A })
    const answer = { assistantId: AGENT, people: [{ userId: LEO, origins: [] }] }
    // The host's own wiring: no live browser, so the saved copy is marked by path.
    await pa.reconcilePeopleAccess({
      agentRoot: r.agentRoot, assistantId: AGENT, answer, ownerUserId: OWNER, deleteProfile: async () => true,
      clearOrigins: (userId: string, origins: string[]) => pa.clearPersonOrigins({ pool: { peek: () => null }, agentRoot: r.agentRoot, assistantId: AGENT, userId, origins, forgetSaved: (hosts: string[]) => vm.forgetSavedSites(missing, hosts) }),
    })
    assert.deepEqual(pa.readAccessRecord({ agentRoot: r.agentRoot, assistantId: AGENT }), {}, 'removed, not retried forever')
  } finally { r.done() }
})

// ── A deletion that failed is owed, and done before reuse ────────────────────

test('an owed deletion that cannot be written to disk is still owed while this host runs', () => {
  const r = rig()
  try {
    const full = { ...nodeFs, writeFileSync: () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }) } }
    assert.throws(() => pa.markProfileDeletePending({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, fs: full }), /no space/)
    // Nothing reached the disk, and that browser still does not open.
    assert.equal(pa.profileDeletePending({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO }), true)
    assert.equal(pa.profileDeletePending({ agentRoot: r.agentRoot, assistantId: AGENT, userId: 'user_other' }), false)
    // Done, it is owed no longer.
    pa.settleProfileDelete({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO })
    assert.equal(pa.profileDeletePending({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO }), false)
  } finally { r.done() }
})

test('the host says so when an owed deletion could not be recorded, never that the browser stays closed', () => {
  const host = readFileSync(join(import.meta.dirname, '..', 'bin', 'hoai-browser-host.mjs'), 'utf8')
  const effects = host.slice(host.indexOf('  _accessEffects(id) {'), host.indexOf('  /** M2: the changes the owner\'s daemon queued from its pairing room. */'))
  assert.doesNotMatch(effects, /try \{ markProfileDeletePending\([^)]*\) \} catch \{\}/, 'a failed mark is not swallowed')
})

test('a profile deletion that failed is owed and done before that browser opens again; a second failure keeps it closed', async () => {
  const r = rig()
  try {
    pa.markProfileDeletePending({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO })
    assert.equal(pa.profileDeletePending({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO }), true)
    assert.equal(pa.profileDeletePending({ agentRoot: r.agentRoot, assistantId: AGENT, userId: 'user_other' }), false)
    pa.settleProfileDelete({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO })
    assert.equal(pa.profileDeletePending({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO }), false)
  } finally { r.done() }
  const p = poolRig({ beforeStart: async () => { throw new Error('the folders could not be deleted') } })
  try {
    await assert.rejects(p.pool.acquire(PERSON), (e: any) => e.code === 'browser_cleanup_pending')
    assert.equal(p.engines.length, 0, 'no browser was made')
  } finally { p.done() }
})

test('the host answers a failed close or deletion as not deleted, and keeps it owed', () => {
  const host = readFileSync(join(import.meta.dirname, '..', 'bin', 'hoai-browser-host.mjs'), 'utf8')
  const effects = host.slice(host.indexOf('  _accessEffects(id) {'), host.indexOf('  /** M2: the changes the owner\'s daemon queued from its pairing room. */'))
  assert.doesNotMatch(effects, /try \{ await this\.pool\.release\(ctx\) \} catch \{\}/, 'a failed close is not swallowed')
  assert.doesNotMatch(effects, /try \{ deletePersonBrowserProfile\([^)]*\) \} catch \{\}/, 'a failed deletion is not swallowed')
  assert.match(effects, /markProfileDeletePending\(\{ agentRoot: this\.agentRoot, assistantId: id, userId \}\)/)
  assert.match(effects, /return false\n/)
  assert.match(effects, /forgetSaved: async \(hosts, liveEngine\) => \{/)
})
