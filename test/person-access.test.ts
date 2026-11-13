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
  fetchPeopleAccess,
  queueAccessChange,
  readAccessRecord,
  recordFillOrigin,
  reconcilePeopleAccess,
} from '../lib/person-access.mjs'

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

test('clearing origins in a live browser goes through the page\'s own CDP; with none open it waits for the next start', async () => {
  const r = rig()
  try {
    const sent: any[] = []
    const page = { context: () => ({ newCDPSession: async () => ({ send: async (m: string, p: any) => { sent.push([m, p]); return {} }, detach: async () => {} }) }), isClosed: () => false }
    const live: any = { engine: { selectedPage: () => page, pages: () => [page] } }
    const pool: any = { peek: (ctx: any) => (ctx.principal === `user-${LEO}` ? live : null) }
    await clearPersonOrigins({ pool, agentRoot: r.agentRoot, assistantId: AGENT, userId: LEO, origins: [A, B] })
    assert.deepEqual(sent, [['Storage.clearDataForOrigin', { origin: A, storageTypes: 'all' }], ['Storage.clearDataForOrigin', { origin: B, storageTypes: 'all' }]])
    // Ben has no browser open: kept for his next start, then applied there once.
    await clearPersonOrigins({ pool, agentRoot: r.agentRoot, assistantId: AGENT, userId: BEN, origins: [B] })
    sent.length = 0
    await applyPendingClears({ agentRoot: r.agentRoot, assistantId: AGENT, principal: `user-${BEN}`, engine: live.engine })
    assert.deepEqual(sent, [['Storage.clearDataForOrigin', { origin: B, storageTypes: 'all' }]])
    sent.length = 0
    await applyPendingClears({ agentRoot: r.agentRoot, assistantId: AGENT, principal: `user-${BEN}`, engine: live.engine })
    assert.deepEqual(sent, [], 'once')
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
