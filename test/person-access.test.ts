/**
 * When a person loses the owner's logins (M2; BGOS server 7e6ceb37fc), their
 * browser on this computer forgets them (lib/person-access.mjs):
 *
 *   - the host records, per person, each HTTPS origin a fill was made for
 *     (the person and the origin only, never a value);
 *   - the owner daemon hears `vault_person_access_changed {assistantId,
 *     userId, all, origins}` on its pairing room (a browser host joins no
 *     pairing room) and queues it for the host;
 *   - on every connect, and on each queued change, the host compares its
 *     record with GET /api/v1/vault/host/people-access: an origin no longer
 *     listed is cleared (cookies and storage) in that person's profile, a
 *     person no longer listed loses their profile; a 404 or no answer keeps
 *     the record for the next connect;
 *   - never the owner.
 *
 * No em or en dashes in this file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PEOPLE_ACCESS_PATH,
  applyAccessChange,
  applyPendingClears,
  clearPersonOrigins,
  drainAccessChanges,
  queueAccessReconcile,
  fetchPeopleAccess,
  queueAccessChange,
  readAccessRecord,
  recordFillOrigin,
  reconcilePeopleAccess,
} from '../lib/person-access.mjs'
import * as personAccess from '../lib/person-access.mjs'

// Read off the namespace, so each test fails by itself where they are missing.
const siteOfHost = (host: string, cookies: any[]) => (personAccess as any).siteOfHost(host, cookies)
const cookieInSite = (cookie: any, site: string) => (personAccess as any).cookieInSite(cookie, site)

const AGENT = 901
const OWNER = 'user_Owner1'
const LEO = 'user_Leo1'
const BEN = 'user_Ben1'
const A = 'https://a.example.com'
const B = 'https://b.example.com'

function rig() {
  const home = mkdtempSync(join(tmpdir(), 'pac-'))
  const agentRoot = join(home, '.bgos-agent')
  const cleared: Array<[string, string[]]> = []
  const deleted: string[] = []
  const effects = {
    clearOrigins: async (userId: string, origins: string[]) => { cleared.push([userId, [...origins].sort()]) },
    deleteProfile: async (userId: string) => { deleted.push(userId) },
  }
  return { home, agentRoot, cleared, deleted, effects, done: () => rmSync(home, { recursive: true, force: true }) }
}

test('a fill records the person and the HTTPS origin only, in an owner only file', () => {
  const r = rig()
  try {
    recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origin: A })
    recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origin: A })
    recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origin: B })
    recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: BEN, origin: B })
    assert.deepEqual(readAccessRecord({ agentRoot: r.agentRoot, assistantId: AGENT }), { [BEN]: [B], [LEO]: [A, B] })
    const file = join(r.agentRoot, String(AGENT), 'vault-people-access.json')
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o077, 0)
    assert.throws(() => recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origin: 'http://a.example.com' }))
    assert.throws(() => recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: '../x', origin: A }))
  } finally { r.done() }
})

test('on connect: an origin no longer listed is cleared, a person no longer listed loses the profile, the record follows', async () => {
  const r = rig()
  try {
    for (const [u, o] of [[LEO, A], [LEO, B], [BEN, B]] as const) recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: u, origin: o })
    const answer = { assistantId: AGENT, people: [{ userId: LEO, origins: [A] }] }
    await reconcilePeopleAccess({ agentRoot: r.agentRoot, assistantId: AGENT, answer, ownerUserId: OWNER, ...r.effects })
    assert.deepEqual(r.cleared, [[LEO, [B]]])
    assert.deepEqual(r.deleted, [BEN])
    assert.deepEqual(readAccessRecord({ agentRoot: r.agentRoot, assistantId: AGENT }), { [LEO]: [A] })
  } finally { r.done() }
})

test('a person listed with no origins (their owner vault is off) loses every recorded origin, but keeps the profile', async () => {
  const r = rig()
  try {
    for (const o of [A, B]) recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origin: o })
    await reconcilePeopleAccess({ agentRoot: r.agentRoot, assistantId: AGENT, answer: { assistantId: AGENT, people: [{ userId: LEO, origins: [] }] }, ownerUserId: OWNER, ...r.effects })
    assert.deepEqual(r.cleared, [[LEO, [A, B]]])
    assert.deepEqual(r.deleted, [])
    assert.deepEqual(readAccessRecord({ agentRoot: r.agentRoot, assistantId: AGENT }), {})
  } finally { r.done() }
})

test('an answer for another agent, or none, changes nothing; a 404 or no answer is null', async () => {
  const r = rig()
  try {
    recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origin: A })
    await reconcilePeopleAccess({ agentRoot: r.agentRoot, assistantId: AGENT, answer: { assistantId: 902, people: [] }, ownerUserId: OWNER, ...r.effects })
    await reconcilePeopleAccess({ agentRoot: r.agentRoot, assistantId: AGENT, answer: null, ownerUserId: OWNER, ...r.effects })
    assert.deepEqual([r.cleared, r.deleted], [[], []])
    assert.deepEqual(readAccessRecord({ agentRoot: r.agentRoot, assistantId: AGENT }), { [LEO]: [A] })
    const calls: any[] = []
    const ok = await fetchPeopleAccess({ backendUrl: 'https://api.example.com', token: 'pt', assistantId: AGENT,
      fetchImpl: async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ assistantId: AGENT, people: [] }), { status: 200 }) } })
    assert.deepEqual(ok, { assistantId: AGENT, people: [] })
    assert.equal(calls[0].url, `https://api.example.com${PEOPLE_ACCESS_PATH}?assistantId=${AGENT}`)
    assert.equal(calls[0].init.headers['X-BGOS-Pairing'], 'pt')
    assert.equal(await fetchPeopleAccess({ backendUrl: 'https://api.example.com', token: 'pt', assistantId: AGENT, fetchImpl: async () => new Response('', { status: 404 }) }), null)
    assert.equal(await fetchPeopleAccess({ backendUrl: 'https://api.example.com', token: 'pt', assistantId: AGENT, fetchImpl: async () => { throw new Error('down') } }), null)
  } finally { r.done() }
})

// Fix round 377, finding 10: a request carrying a credential header never follows a redirect, which would carry it on.
test('the people-access request and the lane session requests refuse redirects', async () => {
  const seen: any[] = []
  await fetchPeopleAccess({ backendUrl: 'https://api.example.com', token: 'pt', assistantId: AGENT, fetchImpl: async (_url: string, init: any) => { seen.push(init); return new Response('', { status: 404 }) } })
  assert.equal(seen[0].redirect, 'error')
  // A redirect answer, as fetch raises it under redirect: 'error', is no answer.
  assert.equal(await fetchPeopleAccess({ backendUrl: 'https://api.example.com', token: 'pt', assistantId: AGENT, fetchImpl: async () => { throw new TypeError('fetch failed: unexpected redirect') } }), null)
  const lane = readFileSync(join(import.meta.dirname, '..', 'lane-server.ts'), 'utf8')
  const laneFetch = lane.slice(lane.indexOf('async function laneFetch('), lane.indexOf('\n}\n', lane.indexOf('async function laneFetch(')))
  assert.match(laneFetch, /headers\['X-BGOS-Session'\] = session\.sessionToken[\s\S]*redirect: 'error',/)
  assert.equal((lane.match(/await fetch\(/g) ?? []).length, 1, 'laneFetch is the lane daemon\'s only request')
})

test('the frame: all deletes the person\'s profile, origins clear only those; never the owner, never another agent', async () => {
  const r = rig()
  try {
    for (const [u, o] of [[LEO, A], [LEO, B], [BEN, B]] as const) recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: u, origin: o })
    await applyAccessChange({ agentRoot: r.agentRoot, assistantId: AGENT, frame: { assistantId: AGENT, userId: LEO, all: false, origins: [B] }, ownerUserId: OWNER, ...r.effects })
    await applyAccessChange({ agentRoot: r.agentRoot, assistantId: AGENT, frame: { assistantId: AGENT, userId: BEN, all: true, origins: [] }, ownerUserId: OWNER, ...r.effects })
    await applyAccessChange({ agentRoot: r.agentRoot, assistantId: AGENT, frame: { assistantId: AGENT, userId: OWNER, all: true, origins: [] }, ownerUserId: OWNER, ...r.effects })
    await applyAccessChange({ agentRoot: r.agentRoot, assistantId: AGENT, frame: { assistantId: 902, userId: LEO, all: true, origins: [] }, ownerUserId: OWNER, ...r.effects })
    await applyAccessChange({ agentRoot: r.agentRoot, assistantId: AGENT, frame: { assistantId: AGENT, userId: LEO, all: false, origins: ['javascript:alert(1)'] }, ownerUserId: OWNER, ...r.effects })
    assert.deepEqual(r.cleared, [[LEO, [B]]])
    assert.deepEqual(r.deleted, [BEN])
    assert.deepEqual(readAccessRecord({ agentRoot: r.agentRoot, assistantId: AGENT }), { [LEO]: [A] })
  } finally { r.done() }
})

test('the daemon queues the frame for the host, which applies each once', async () => {
  const r = rig()
  try {
    recordFillOrigin({ agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origin: A })
    assert.equal(queueAccessChange({ agentRoot: r.agentRoot, assistantId: AGENT, frame: { assistantId: AGENT, userId: LEO, all: false, origins: [A] } }), true)
    assert.equal(queueAccessChange({ agentRoot: r.agentRoot, assistantId: AGENT, frame: { assistantId: 902, userId: LEO, all: true, origins: [] } }), false)
    assert.equal(queueAccessChange({ agentRoot: r.agentRoot, assistantId: AGENT, frame: { nonsense: true } }), false)
    assert.equal(await drainAccessChanges({ agentRoot: r.agentRoot, assistantId: AGENT, ownerUserId: OWNER, ...r.effects }), 1)
    assert.equal(await drainAccessChanges({ agentRoot: r.agentRoot, assistantId: AGENT, ownerUserId: OWNER, ...r.effects }), 0, 'once')
    assert.deepEqual(r.cleared, [[LEO, [A]]])
    assert.ok(!existsSync(join(r.agentRoot, String(AGENT), 'vault-people-access.queue.jsonl')) || readFileSync(join(r.agentRoot, String(AGENT), 'vault-people-access.queue.jsonl'), 'utf8') === '')
  } finally { r.done() }
})

// ── The host's side: the live browser, the next start, the fill record ──────

/**
 * S1: an origin a person lost is cleared for its whole site: cookies for the
 * site the browser itself proves (siteOfHost: the widest domain cookie it
 * would send the host, else the host; never a label guess), and storage
 * for every origin under it this browser knows of (the origin itself, the
 * bare and www site, each cookie domain under it, and the open frames).
 */
function fakeBrowser(cookies: any[], frameUrls: string[] = []) {
  const sent: any[] = []
  const frames = frameUrls.map((u) => ({ url: () => u }))
  const page = {
    isClosed: () => false,
    frames: () => frames,
    context: () => ({ newCDPSession: async () => ({ send: async (m: string, p: any) => { sent.push([m, p]); return m === 'Storage.getCookies' ? { cookies } : {} }, detach: async () => {} }) }),
  }
  return { sent, engine: { selectedPage: () => page, pages: () => [page] } }
}

// Fix round 377, finding 8: the site is what the browser's own cookies prove, never a guess from the labels.
test('S1: the site of a lost host is the widest domain cookie the browser would send it, else the host', () => {
  // A multi label public suffix: no browser keeps a .co.uk cookie, so the site never widens to co.uk.
  assert.equal(siteOfHost('example.co.uk', [{ domain: 'other.co.uk' }, { domain: '.other.co.uk' }]), 'example.co.uk')
  assert.equal(siteOfHost('login.example.co.uk', [{ domain: '.example.co.uk' }]), 'example.co.uk')
  // A private suffix (a tenant of a hosting domain): another tenant is never reached.
  assert.equal(siteOfHost('tenant.github.io', [{ domain: 'other.github.io' }, { domain: '.other.github.io' }]), 'tenant.github.io')
  // A parent's session cookie two labels up is the site, where the label guess stopped one short.
  assert.equal(siteOfHost('signin.team.example.com', [{ domain: '.team.example.com' }, { domain: '.example.com' }]), 'example.com')
  // A host only cookie of a parent is not sent to the host and proves nothing.
  assert.equal(siteOfHost('signin.team.example.com', [{ domain: 'example.com' }]), 'signin.team.example.com')
  assert.equal(siteOfHost('localhost', []), 'localhost')
})

test('S1: the cookies of a site, including those partitioned under it, and never a neighbour that only shares a suffix', () => {
  assert.equal(cookieInSite({ domain: '.example.co.uk' }, 'example.co.uk'), true)
  assert.equal(cookieInSite({ domain: 'a.example.co.uk' }, 'example.co.uk'), true)
  assert.equal(cookieInSite({ domain: 'other.co.uk' }, 'example.co.uk'), false)
  assert.equal(cookieInSite({ domain: 'notexample.co.uk' }, 'example.co.uk'), false)
  assert.equal(cookieInSite({ domain: 'idp.test', partitionKey: { topLevelSite: 'https://example.co.uk', hasCrossSiteAncestor: false } }, 'example.co.uk'), true)
  assert.equal(cookieInSite({ domain: 'idp.test', partitionKey: 'https://example.co.uk' }, 'example.co.uk'), true)
  assert.equal(cookieInSite({ domain: 'idp.test', partitionKey: { topLevelSite: 'https://other.co.uk' } }, 'example.co.uk'), false)
})

test('S1: clearing a lost login under a multi label suffix leaves its neighbours, and clears a parent cookie and a partitioned one', async () => {
  const r = rig()
  try {
    const cookies = [
      { name: 'sid', domain: '.example.co.uk', path: '/' },
      { name: 'neighbour', domain: 'other.co.uk', path: '/' },
      { name: 'embedded', domain: 'idp.test', path: '/', partitionKey: { topLevelSite: 'https://example.co.uk', hasCrossSiteAncestor: false } },
      { name: 'idp-own', domain: 'idp.test', path: '/' },
    ]
    const b = fakeBrowser(cookies, ['https://other.co.uk/'])
    const pool: any = { peek: () => ({ engine: b.engine }) }
    await clearPersonOrigins({ pool, agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origins: ['https://signin.example.co.uk'] })
    const deleted = b.sent.filter(([m]: any) => m === 'Network.deleteCookies').map(([, p]: any) => p)
    assert.deepEqual(deleted, [
      { name: 'sid', domain: '.example.co.uk', path: '/' },
      { name: 'embedded', domain: 'idp.test', path: '/', partitionKey: { topLevelSite: 'https://example.co.uk', hasCrossSiteAncestor: false } },
    ])
    const cleared = b.sent.filter(([m]: any) => m === 'Storage.clearDataForOrigin').map(([, p]: any) => p.origin)
    assert.equal(cleared.some((o: string) => o.includes('other.co.uk') || o === 'https://co.uk'), false, 'no neighbour, no suffix')
    assert.ok(cleared.includes('https://signin.example.co.uk') && cleared.includes('https://example.co.uk'))
  } finally { r.done() }
})

test('S1: clearing an origin clears cookies for its registrable domain and storage for every origin under it, now or at the next start', async () => {
  const r = rig()
  try {
    const cookies = [
      { name: 'sid', domain: '.example.com', path: '/' },
      { name: 'a', domain: 'a.example.com', path: '/x' },
      { name: 'keep', domain: 'other.com', path: '/' },
      { name: 'keep2', domain: 'notexample.com', path: '/' },
    ]
    const b = fakeBrowser(cookies, ['https://b.example.com/frame', 'https://other.com/'])
    const pool: any = { peek: (ctx: any) => (ctx.principal === `user-${LEO}` ? { engine: b.engine } : null) }
    await clearPersonOrigins({ pool, agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origins: ['https://login.example.com'] })
    const deleted = b.sent.filter(([m]: any) => m === 'Network.deleteCookies').map(([, p]: any) => p)
    assert.deepEqual(deleted, [{ name: 'sid', domain: '.example.com', path: '/' }, { name: 'a', domain: 'a.example.com', path: '/x' }])
    const cleared = b.sent.filter(([m]: any) => m === 'Storage.clearDataForOrigin').map(([, p]: any) => p.origin).sort()
    assert.deepEqual(cleared, ['https://a.example.com', 'https://b.example.com', 'https://example.com', 'https://login.example.com', 'https://www.example.com'])
    for (const [m, p] of b.sent) if (m === 'Storage.clearDataForOrigin') assert.equal(p.storageTypes, 'all')
    // Ben has no browser open: kept for his next start, then applied there once, the same way.
    await clearPersonOrigins({ pool, agentRoot: r.agentRoot, assistantId: AGENT, userId: BEN, origins: [B] })
    const later = fakeBrowser([{ name: 'x', domain: 'b.example.com', path: '/' }])
    await applyPendingClears({ agentRoot: r.agentRoot, assistantId: AGENT, principal: `user-${BEN}`, engine: later.engine })
    assert.ok(later.sent.some(([m, p]: any) => m === 'Network.deleteCookies' && p.name === 'x'))
    // No domain cookie proves example.com is Ben's login's site, so its own host is the site (fix round 377, finding 8).
    assert.ok(later.sent.some(([m, p]: any) => m === 'Storage.clearDataForOrigin' && p.origin === 'https://b.example.com'))
    assert.equal(later.sent.some(([m, p]: any) => m === 'Storage.clearDataForOrigin' && p.origin === 'https://example.com'), false)
    later.sent.length = 0
    await applyPendingClears({ agentRoot: r.agentRoot, assistantId: AGENT, principal: `user-${BEN}`, engine: later.engine })
    assert.deepEqual(later.sent, [], 'once')
  } finally { r.done() }
})

test('the owner daemon queues the frame from its pairing room; the host records a fill\'s origin', () => {
  const server = readFileSync(join(import.meta.dirname, '..', 'server.ts'), 'utf8')
  assert.match(server, /realtimeSocket\.on\('vault_person_access_changed', whenArmed\('vault_person_access_changed', \(frame: unknown\) => \{\n\s+queueAccessChange\(\{ agentRoot: joinPath\(homedir\(\), '\.bgos-agent'\), assistantId: String\(ASSISTANT_ID\), frame \}\)/)
  const host = readFileSync(join(import.meta.dirname, '..', 'bin', 'hoai-browser-host.mjs'), 'utf8')
  assert.match(host, /recordFillOrigin\(\{ agentRoot, assistantId, userId: actingUserId, origin \}\)/)
  assert.match(host, /fetchPeopleAccess\(\{ backendUrl: conn\.pairing\.backendUrl, token: conn\.pairing\.token, assistantId: id, fetchImpl: this\._fetch \}\)/)
  assert.match(host, /drainAccessChanges\(/)
})

test('V2: the owner daemon asks the host to reconcile on its (re)connect; the host reconciles on connect and every 10 minutes', async () => {
  const r = rig()
  try {
    let asked = 0
    assert.equal(queueAccessReconcile({ agentRoot: r.agentRoot, assistantId: AGENT }), true)
    assert.equal(await drainAccessChanges({ agentRoot: r.agentRoot, assistantId: AGENT, ownerUserId: OWNER, ...r.effects, reconcile: async () => { asked += 1 } }), 1)
    assert.equal(asked, 1)
    const server = readFileSync(join(import.meta.dirname, '..', 'server.ts'), 'utf8')
    const connect = server.slice(server.indexOf("realtimeSocket.on('connect', () => {"), server.indexOf("realtimeSocket.on('connect', () => {") + 2000)
    assert.match(connect, /queueAccessReconcile\(\{ agentRoot: joinPath\(homedir\(\), '\.bgos-agent'\), assistantId: String\(ASSISTANT_ID\) \}\)/)
    const host = readFileSync(join(import.meta.dirname, '..', 'bin', 'hoai-browser-host.mjs'), 'utf8')
    assert.match(host, /export const PEOPLE_ACCESS_RECONCILE_MS = 10 \* 60_000/)
    assert.match(host, /setInterval\(\(\) => \{ for \(const conn of this\.connections\.values\(\)\) for \(const id of conn\.pairing\.assistantIds\) void this\._reconcilePeopleAccess\(id\)/)
  } finally { r.done() }
})
