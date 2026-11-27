/**
 * person-access: a person who loses the owner's logins loses them from their
 * browser on this computer too (shared agent vault M2; BGOS server
 * 7e6ceb37fc).
 *
 *   - The browser host RECORDS, per person, each HTTPS origin a fill of the
 *     owner's login was made for: `<agent>/vault-people-access.json`, the
 *     person and the origin only, never a value, owner only.
 *   - The server tells the agent's own pairing room
 *     `vault_person_access_changed {assistantId, userId, all, origins}`. A
 *     browser host joins no pairing room, so the OWNER's daemon hears it and
 *     QUEUES it (`vault-people-access.queue.jsonl`); the host drains the queue
 *     on its sweep and applies each change once.
 *   - A daemon that was offline misses the frame, so on every connect the
 *     host asks GET /api/v1/vault/host/people-access?assistantId=<id> with
 *     the agent's own pairing ({assistantId, people: [{userId, origins}]},
 *     origins [] while that person's owner vault is off) and compares: a
 *     recorded origin no longer listed is cleared (cookies and storage) in
 *     that person's profile, a person no longer listed loses their profile.
 *     A 404 or no answer keeps the record for the next connect.
 *   - Never the owner.
 *
 * The effects (clear origins, delete a profile) are the host's, injected.
 * Plain JavaScript, node builtins only. No em or en dashes in this file.
 */
import * as nodeFs from 'node:fs'
import { join } from 'node:path'

import { isSafeAssistantId, isSafeLaneUserId } from './lane-core.mjs'

export const PEOPLE_ACCESS_PATH = '/api/v1/vault/host/people-access'
const RECORD = 'vault-people-access.json'
const QUEUE = 'vault-people-access.queue.jsonl'
const ORIGINS_MAX = 200
const QUEUE_MAX_BYTES = 256 * 1024

function httpsOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const u = new URL(value)
    return u.protocol === 'https:' && u.origin === value ? value : null
  } catch {
    return null
  }
}

function agentDir(agentRoot, assistantId) {
  if (!isSafeAssistantId(assistantId)) throw new Error('person access: unsafe assistant id')
  return join(agentRoot, String(assistantId))
}

function writePrivate(fs, path, text) {
  const tmp = `${path}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  fs.renameSync(tmp, path)
  try { fs.chmodSync(path, 0o600) } catch {}
}

/** The record is unreadable: every fill of the owner's logins is refused until it is readable (fix round 377, finding 2). */
export class AccessRecordError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

/**
 * The record: userId to its sorted origins. No file is an empty record. A file
 * that cannot be read or parsed, or names more origins for a person than the
 * record keeps, is NOT empty: it throws `access_record_unreadable`, so nothing
 * is filled and nothing is written over it (fix round 377, finding 2: an
 * unreadable record read as empty was then written back empty, and its sites
 * were never cleared).
 */
export function readAccessRecord({ agentRoot, assistantId, fs = nodeFs }) {
  let text
  try {
    text = fs.readFileSync(join(agentDir(agentRoot, assistantId), RECORD), 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return {}
    throw new AccessRecordError('access_record_unreadable')
  }
  let raw
  try { raw = JSON.parse(text) } catch { throw new AccessRecordError('access_record_unreadable') }
  if (!raw || typeof raw !== 'object' || (raw.people !== undefined && (typeof raw.people !== 'object' || raw.people === null))) throw new AccessRecordError('access_record_unreadable')
  const out = {}
  for (const [userId, origins] of Object.entries(raw.people ?? {})) {
    if (!isSafeLaneUserId(userId) || !Array.isArray(origins)) throw new AccessRecordError('access_record_unreadable')
    const kept = [...new Set(origins.map(httpsOrigin).filter(Boolean))].sort()
    if (kept.length > ORIGINS_MAX) throw new AccessRecordError('access_record_unreadable')
    if (kept.length) out[userId] = kept
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
}

/**
 * Change the record by `edit`, read and written in one synchronous step, so
 * no other change made while an effect was awaited is lost (fix round 377,
 * finding 2: a reconcile wrote back the record it read before its awaits, and
 * a fill recorded meanwhile vanished from it).
 */
function updateAccessRecord({ agentRoot, assistantId, fs }, edit) {
  const people = readAccessRecord({ agentRoot, assistantId, fs })
  edit(people)
  writeAccessRecord({ agentRoot, assistantId, people, fs })
}

function writeAccessRecord({ agentRoot, assistantId, people, fs = nodeFs }) {
  const dir = agentDir(agentRoot, assistantId)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  writePrivate(fs, join(dir, RECORD), `${JSON.stringify({ v: 1, people })}\n`)
}

/** A fill of the owner's login for `userId` was made for `origin`. */
export function recordFillOrigin({ agentRoot, assistantId, userId, origin, fs = nodeFs }) {
  if (!isSafeLaneUserId(userId)) throw new Error('person access: unsafe person id')
  const o = httpsOrigin(origin)
  if (!o) throw new Error('person access: not an https origin')
  updateAccessRecord({ agentRoot, assistantId, fs }, (people) => {
    const next = [...new Set([...(people[userId] ?? []), o])].sort()
    // A full record refuses a new site rather than forgetting one it holds, which could then never be cleared.
    if (next.length > ORIGINS_MAX) throw new AccessRecordError('access_record_full')
    people[userId] = next
  })
}

/** GET people-access with the agent's own pairing; null on a 404, an error or a shape it cannot read. */
/**
 * @param {{ backendUrl: string, token: string, assistantId: number | string, fetchImpl?: (url: string, init: any) => Promise<Response>, timeoutMs?: number }} input
 */
export async function fetchPeopleAccess({ backendUrl, token, assistantId, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
  try {
    const base = String(backendUrl ?? '').trim().replace(/\/+$/, '').replace(/\/api\/v1$/, '')
    const res = await fetchImpl(`${base}${PEOPLE_ACCESS_PATH}?assistantId=${encodeURIComponent(String(assistantId))}`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-BGOS-Pairing': token },
      // Never followed (fix round 377, finding 10): a redirect would carry the pairing header to wherever it points.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const body = await res.json()
    if (!body || typeof body !== 'object' || !Array.isArray(body.people) || Number(body.assistantId) !== Number(assistantId)) return null
    return body
  } catch {
    return null
  }
}

/**
 * Compare the record with the server's answer for this agent and apply the
 * difference. An answer that is null or for another agent changes nothing.
 * Returns what it did.
 */
export async function reconcilePeopleAccess({ agentRoot, assistantId, answer, ownerUserId = /** @type {string | null} */ (null), clearOrigins, deleteProfile, fs = nodeFs }) {
  if (!answer || Number(answer.assistantId) !== Number(assistantId) || !Array.isArray(answer.people)) return { cleared: 0, deleted: 0 }
  const listed = new Map()
  for (const p of answer.people) {
    if (!p || !isSafeLaneUserId(p.userId) || !Array.isArray(p.origins)) continue
    listed.set(p.userId, new Set(p.origins.map(httpsOrigin).filter(Boolean)))
  }
  const people = readAccessRecord({ agentRoot, assistantId, fs })
  let cleared = 0
  let deleted = 0
  // Each removal is written back only once its effect succeeded, as its own
  // delta on the record as it is THEN (a fill recorded meanwhile stays), and a
  // removal whose effect failed stays recorded, so the next reconcile tries it
  // again (fix round 377, finding 2).
  for (const [userId, origins] of Object.entries(people)) {
    if (userId === ownerUserId) {
      updateAccessRecord({ agentRoot, assistantId, fs }, (p) => { delete p[userId] })
      continue
    }
    const now = listed.get(userId)
    if (!now) {
      if (await deleteProfile(userId) === false) continue
      updateAccessRecord({ agentRoot, assistantId, fs }, (p) => { delete p[userId] })
      deleted += 1
      continue
    }
    const gone = origins.filter((o) => !now.has(o))
    if (gone.length) {
      if (await clearOrigins(userId, gone) === false) continue
      cleared += gone.length
      updateAccessRecord({ agentRoot, assistantId, fs }, (p) => {
        if (!p[userId]) return
        p[userId] = p[userId].filter((o) => !gone.includes(o))
        if (!p[userId].length) delete p[userId]
      })
    }
  }
  return { cleared, deleted }
}

/** A well formed change for this agent and a person who is not the owner, else null. */
function readChange(frame, assistantId, ownerUserId) {
  const f = frame && typeof frame === 'object' ? frame : null
  if (!f || Number(f.assistantId) !== Number(assistantId) || !isSafeLaneUserId(f.userId) || f.userId === ownerUserId) return null
  if (typeof f.all !== 'boolean' || !Array.isArray(f.origins)) return null
  return { assistantId: Number(assistantId), userId: f.userId, all: f.all, origins: [...new Set(f.origins.map(httpsOrigin).filter(Boolean))] }
}

/** Apply one `vault_person_access_changed`: all deletes the person's profile, else only those origins are cleared. */
export async function applyAccessChange({ agentRoot, assistantId, frame, ownerUserId = /** @type {string | null} */ (null), clearOrigins, deleteProfile, fs = nodeFs }) {
  const change = readChange(frame, assistantId, ownerUserId)
  if (!change) return false
  // Read first: an unreadable record throws here, before any effect.
  readAccessRecord({ agentRoot, assistantId, fs })
  if (change.all) {
    // A deletion that failed is kept by the host (deleteProfile answers false)
    // and the record keeps the person, so the next reconcile asks again.
    if (await deleteProfile(change.userId) === false) return false
    updateAccessRecord({ agentRoot, assistantId, fs }, (p) => { delete p[change.userId] })
  } else {
    if (!change.origins.length) return false
    if (await clearOrigins(change.userId, change.origins) === false) return false
    updateAccessRecord({ agentRoot, assistantId, fs }, (p) => {
      if (!p[change.userId]) return
      p[change.userId] = p[change.userId].filter((o) => !change.origins.includes(o))
      if (!p[change.userId].length) delete p[change.userId]
    })
  }
  return true
}

/** The owner's daemon: queue a frame for this agent's browser host. True when queued. */
export function queueAccessChange({ agentRoot, assistantId, frame, fs = nodeFs }) {
  const change = readChange(frame, assistantId, null)
  if (!change) return false
  const dir = agentDir(agentRoot, assistantId)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, QUEUE)
  try { if (fs.statSync(path).size > QUEUE_MAX_BYTES) return false } catch {}
  fs.appendFileSync(path, `${JSON.stringify(change)}\n`, { mode: 0o600 })
  return true
}

/** The owner's daemon (re)connected: ask the host to reconcile with the server, which it does on its next sweep. */
export function queueAccessReconcile({ agentRoot, assistantId, fs = nodeFs }) {
  const dir = agentDir(agentRoot, assistantId)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, QUEUE)
  try { if (fs.statSync(path).size > QUEUE_MAX_BYTES) return false } catch {}
  fs.appendFileSync(path, `${JSON.stringify({ reconcile: true })}\n`, { mode: 0o600 })
  return true
}

/** The host: apply every queued change once, and one reconcile however many were asked. Returns how many applied. */
export async function drainAccessChanges({ agentRoot, assistantId, ownerUserId = /** @type {string | null} */ (null), clearOrigins, deleteProfile, reconcile = /** @type {null | (() => Promise<unknown>)} */ (null), fs = nodeFs }) {
  const path = join(agentDir(agentRoot, assistantId), QUEUE)
  const taken = `${path}.${process.pid}.draining`
  try { fs.renameSync(path, taken) } catch { return 0 }
  let text = ''
  try { text = fs.readFileSync(taken, 'utf8') } finally { try { fs.unlinkSync(taken) } catch {} }
  let applied = 0
  let reconcileAsked = false
  // A change whose effect failed (or that met an unreadable record) goes back
  // in the queue, so no removal is ever dropped (fix round 377, finding 2).
  const retry = []
  let failed = false
  const watched = (fn) => async (...args) => {
    try {
      const result = await fn(...args)
      if (result === false) failed = true
      return result
    } catch (err) {
      failed = true
      throw err
    }
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let frame
    try { frame = JSON.parse(line) } catch { continue }
    if (frame?.reconcile === true) { reconcileAsked = true; continue }
    failed = false
    try {
      if (await applyAccessChange({ agentRoot, assistantId, frame, ownerUserId, clearOrigins: watched(clearOrigins), deleteProfile: watched(deleteProfile), fs })) applied += 1
    } catch {
      failed = true
    }
    if (failed) retry.push(line)
  }
  if (retry.length) fs.appendFileSync(path, `${retry.join('\n')}\n`, { mode: 0o600 })
  if (reconcileAsked && reconcile) {
    await reconcile()
    applied += 1
  }
  return applied
}

// ── The host's effects on a person's browser ────────────────────────────────

const PENDING = 'vault-people-pending-clear.json'

/** The clears waiting for a browser's next start. No file is none; a file that cannot be read THROWS, never reads as none. */
function readPending(fs, path) {
  let text
  try {
    text = fs.readFileSync(path, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return {}
    throw new AccessRecordError('pending_clear_unreadable')
  }
  let raw
  try { raw = JSON.parse(text) } catch { throw new AccessRecordError('pending_clear_unreadable') }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AccessRecordError('pending_clear_unreadable')
  return raw
}

const hostOf = (value) => String(value ?? '').toLowerCase().replace(/\.$/, '')
const isUnder = (host, parent) => host === parent || host.endsWith(`.${parent}`)

/**
 * The site a lost host belongs to, as this browser itself proves it (fix
 * round 377, finding 8): the shortest domain of a DOMAIN cookie (`.example.com`)
 * the browser would send to the host, or the host itself when there is none.
 * A browser never stores a domain cookie for a public suffix (ICANN or
 * private: `co.uk`, `github.io`), so the answer is never wider than the
 * host's registrable domain, and no list of suffixes is needed. The label
 * guess this replaces took `co.uk` for `example.co.uk`, and stopped one label
 * short of a parent's session cookie (`team.example.com` for
 * `signin.team.example.com`, where the cookie was `.example.com`).
 *
 * @param {string} host
 * @param {Array<{ domain?: unknown }>} cookies every cookie of the browser
 */
export function siteOfHost(host, cookies) {
  const h = hostOf(host)
  let site = h
  for (const cookie of cookies ?? []) {
    const raw = String(cookie?.domain ?? '').toLowerCase()
    if (!raw.startsWith('.')) continue
    const domain = hostOf(raw.slice(1))
    if (domain !== '' && isUnder(h, domain) && domain.length < site.length) site = domain
  }
  return site
}

/**
 * A cookie of the site: set for the site or any host under it, or kept in a
 * partition whose top level site is the site (an embedded login's session
 * on that site, whatever its own domain).
 */
export function cookieInSite(cookie, site) {
  if (site === '') return false
  const domain = hostOf(String(cookie?.domain ?? '').toLowerCase().replace(/^\./, ''))
  if (domain !== '' && isUnder(domain, site)) return true
  const key = cookie?.partitionKey
  const top = typeof key === 'string' ? key : typeof key?.topLevelSite === 'string' ? key.topLevelSite : ''
  try {
    return top !== '' && isUnder(hostOf(new URL(top).hostname), site)
  } catch {
    return false
  }
}

/**
 * S1: clear a lost site from one browser: every cookie of the lost host's
 * site (siteOfHost), each in its own partition, and storage (cookies
 * included) for every origin of that site this browser knows of: the origin
 * itself, the bare and www site, each cookie domain in it and every open
 * frame in it.
 */
async function clearInEngine(engine, origins) {
  let page = engine?.selectedPage?.() ?? engine?.pages?.()?.[0]
  // A browser with no page yet (a start whose clear must run first) gets one
  // for the clear alone, closed after it (fix round 377, finding 2).
  let opened = null
  if ((!page || page.isClosed?.()) && typeof engine?.newPage === 'function') {
    try { opened = await engine.newPage(); page = opened } catch { page = null }
  }
  if (!page || page.isClosed?.()) return false
  let cdp = null
  try {
    cdp = await page.context().newCDPSession(page)
    const all = (await cdp.send('Storage.getCookies'))?.cookies ?? []
    const frames = (engine.pages?.() ?? [page]).flatMap((p) => { try { return p.frames?.() ?? [] } catch { return [] } })
    const storageOrigins = new Set()
    const deleted = new Set()
    for (const origin of origins) {
      const site = siteOfHost(new URL(origin).hostname, all)
      storageOrigins.add(origin)
      storageOrigins.add(`https://${site}`)
      storageOrigins.add(`https://www.${site}`)
      for (const cookie of all) {
        if (!cookieInSite(cookie, site)) continue
        const partitionKey = cookie.partitionKey ?? undefined
        const key = `${cookie.name}\n${cookie.domain}\n${cookie.path}\n${JSON.stringify(partitionKey ?? null)}`
        if (!deleted.has(key)) {
          deleted.add(key)
          // A partitioned cookie is deleted in its own partition, or it stays.
          await cdp.send('Network.deleteCookies', { name: cookie.name, domain: cookie.domain, path: cookie.path, ...(partitionKey !== undefined ? { partitionKey } : {}) })
        }
        storageOrigins.add(`https://${hostOf(String(cookie.domain).replace(/^\./, ''))}`)
      }
      for (const frame of frames) {
        try {
          const u = new URL(frame.url())
          if (u.protocol === 'https:' && isUnder(hostOf(u.hostname), site)) storageOrigins.add(u.origin)
        } catch {}
      }
    }
    for (const origin of storageOrigins) await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
    return true
  } catch {
    return false
  } finally {
    if (cdp) await cdp.detach?.().catch?.(() => {})
    if (opened) await Promise.resolve(opened.close?.()).catch(() => {})
  }
}

/**
 * Clear cookies and storage for `origins` in this person's browser: now, in
 * the browser that is open (Storage.clearDataForOrigin, cookies included);
 * otherwise at its next start (applyPendingClears).
 */
export async function clearPersonOrigins({ pool, agentRoot, assistantId, userId, origins, forgetSaved = /** @type {null | ((hosts: string[], liveEngine: any) => Promise<unknown> | unknown)} */ (null), fs = nodeFs }) {
  if (!isSafeLaneUserId(userId)) return false
  const clean = [...new Set((origins ?? []).map(httpsOrigin).filter(Boolean))]
  if (!clean.length) return false
  const ctx = { assistantId: Number(assistantId), principal: `user-${userId}` }
  const slot = pool?.peek?.(ctx)
  let cleared = false
  if (slot) {
    cleared = await clearInEngine(slot.engine, clean)
    // A running browser whose clear failed is closed, so the clear runs at its
    // next start, before anybody can use it (fix round 377, finding 2).
    if (!cleared) {
      try { await pool.release(ctx) } catch { return false }
    }
  }
  if (!cleared) {
    const path = join(agentDir(agentRoot, assistantId), PENDING)
    // Every outstanding clear is kept, never cut to a size (fix round 377, finding 2).
    const pending = readPending(fs, path)
    pending[userId] = [...new Set([...(Array.isArray(pending[userId]) ? pending[userId] : []), ...clean])]
    fs.mkdirSync(agentDir(agentRoot, assistantId), { recursive: true, mode: 0o700 })
    writePrivate(fs, path, `${JSON.stringify(pending)}\n`)
  }
  // Then the saved, encrypted copy of this person's site state
  // (lib/agent-browser-vault.mjs) forgets them, AFTER the live browser no
  // longer holds them, so no snapshot can write them back: an unlock later
  // never restores them. A copy that cannot be marked is a clear that did not
  // happen: the caller keeps the record and tries again.
  if (forgetSaved) {
    try {
      if (await forgetSaved(clean.map((o) => new URL(o).hostname), cleared ? slot.engine : null) === false) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * Synchronous: does a clear still wait for this person's browser? An
 * unreadable queue answers yes, so the start runs applyPendingClears, which
 * then refuses the browser (fix round 377, finding 2).
 */
export function hasPendingClear({ agentRoot, assistantId, principal, fs = nodeFs }) {
  const m = /^user-(user_[A-Za-z0-9_-]{1,240})$/.exec(String(principal ?? ''))
  if (!m) return false
  try {
    const pending = readPending(fs, join(agentDir(agentRoot, assistantId), PENDING))
    return Array.isArray(pending[m[1]]) && pending[m[1]].length > 0
  } catch {
    return true
  }
}

// ── A profile deletion that failed is kept, and tried again before reuse ────

const PENDING_DELETE = 'vault-people-pending-delete.json'

function readPendingDeletes(fs, path) {
  let text
  try {
    text = fs.readFileSync(path, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return []
    throw new AccessRecordError('pending_delete_unreadable')
  }
  let raw
  try { raw = JSON.parse(text) } catch { throw new AccessRecordError('pending_delete_unreadable') }
  if (!raw || !Array.isArray(raw.userIds) || !raw.userIds.every(isSafeLaneUserId)) throw new AccessRecordError('pending_delete_unreadable')
  return raw.userIds
}

/** A person's browser profile could not be deleted: kept, so it is deleted before that browser opens again. */
export function markProfileDeletePending({ agentRoot, assistantId, userId, fs = nodeFs }) {
  if (!isSafeLaneUserId(userId)) throw new Error('person access: unsafe person id')
  const dir = agentDir(agentRoot, assistantId)
  const path = join(dir, PENDING_DELETE)
  const userIds = [...new Set([...readPendingDeletes(fs, path), userId])].sort()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  writePrivate(fs, path, `${JSON.stringify({ v: 1, userIds })}\n`)
}

/** Is a deletion of this person's profile still owed? An unreadable record answers yes. */
export function profileDeletePending({ agentRoot, assistantId, userId, fs = nodeFs }) {
  try {
    return readPendingDeletes(fs, join(agentDir(agentRoot, assistantId), PENDING_DELETE)).includes(userId)
  } catch {
    return true
  }
}

/** The owed deletion of this person's profile was done. */
export function settleProfileDelete({ agentRoot, assistantId, userId, fs = nodeFs }) {
  const dir = agentDir(agentRoot, assistantId)
  const path = join(dir, PENDING_DELETE)
  let userIds
  try { userIds = readPendingDeletes(fs, path) } catch { userIds = [] }
  if (!userIds.includes(userId)) return
  writePrivate(fs, path, `${JSON.stringify({ v: 1, userIds: userIds.filter((u) => u !== userId) })}\n`)
}

/** A clear that waited for this person's browser could not run: the browser must not be used (fix round 377, finding 2). */
export class PendingClearError extends Error {
  constructor() {
    super('pending_clear_failed')
    this.code = 'pending_clear_failed'
  }
}

/**
 * A person's browser just started: clear what waited for it, once. True when
 * a clear ran, false when nothing waited. A clear that waited and could not
 * run THROWS (PendingClearError), and the pool then stops that browser before
 * anybody can use it (BrowserPool afterStart), rather than handing out a
 * browser that may still hold a lost site's session.
 */
export async function applyPendingClears({ agentRoot, assistantId, principal, engine, fs = nodeFs }) {
  const m = /^user-(user_[A-Za-z0-9_-]{1,240})$/.exec(String(principal ?? ''))
  if (!m) return false
  const path = join(agentDir(agentRoot, assistantId), PENDING)
  let pending
  try { pending = readPending(fs, path) } catch { throw new PendingClearError() }
  const origins = Array.isArray(pending[m[1]]) ? pending[m[1]].map(httpsOrigin).filter(Boolean) : []
  if (!origins.length) return false
  if (!(await clearInEngine(engine, origins))) throw new PendingClearError()
  // Read again: a clear queued while this one ran stays.
  const now = readPending(fs, path)
  const left = (Array.isArray(now[m[1]]) ? now[m[1]] : []).filter((o) => !origins.includes(o))
  if (left.length) now[m[1]] = left
  else delete now[m[1]]
  writePrivate(fs, path, `${JSON.stringify(now)}\n`)
  return true
}
