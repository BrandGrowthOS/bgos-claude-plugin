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

/** The record: userId to its sorted origins. Anything unreadable is empty. */
export function readAccessRecord({ agentRoot, assistantId, fs = nodeFs }) {
  let raw
  try { raw = JSON.parse(fs.readFileSync(join(agentDir(agentRoot, assistantId), RECORD), 'utf8')) } catch { return {} }
  const out = {}
  for (const [userId, origins] of Object.entries(raw?.people ?? {})) {
    if (!isSafeLaneUserId(userId) || !Array.isArray(origins)) continue
    const kept = [...new Set(origins.map(httpsOrigin).filter(Boolean))].sort()
    if (kept.length) out[userId] = kept.slice(0, ORIGINS_MAX)
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
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
  const people = readAccessRecord({ agentRoot, assistantId, fs })
  people[userId] = [...new Set([...(people[userId] ?? []), o])].sort().slice(0, ORIGINS_MAX)
  writeAccessRecord({ agentRoot, assistantId, people, fs })
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
  for (const [userId, origins] of Object.entries(people)) {
    if (userId === ownerUserId) { delete people[userId]; continue }
    const now = listed.get(userId)
    if (!now) {
      await deleteProfile(userId)
      delete people[userId]
      deleted += 1
      continue
    }
    const gone = origins.filter((o) => !now.has(o))
    if (gone.length) {
      await clearOrigins(userId, gone)
      cleared += gone.length
      people[userId] = origins.filter((o) => now.has(o))
      if (!people[userId].length) delete people[userId]
    }
  }
  writeAccessRecord({ agentRoot, assistantId, people, fs })
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
  const people = readAccessRecord({ agentRoot, assistantId, fs })
  if (change.all) {
    await deleteProfile(change.userId)
    delete people[change.userId]
  } else {
    if (!change.origins.length) return false
    await clearOrigins(change.userId, change.origins)
    if (people[change.userId]) {
      people[change.userId] = people[change.userId].filter((o) => !change.origins.includes(o))
      if (!people[change.userId].length) delete people[change.userId]
    }
  }
  writeAccessRecord({ agentRoot, assistantId, people, fs })
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
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let frame
    try { frame = JSON.parse(line) } catch { continue }
    if (frame?.reconcile === true) { reconcileAsked = true; continue }
    if (await applyAccessChange({ agentRoot, assistantId, frame, ownerUserId, clearOrigins, deleteProfile, fs })) applied += 1
  }
  if (reconcileAsked && reconcile) {
    await reconcile()
    applied += 1
  }
  return applied
}

// ── The host's effects on a person's browser ────────────────────────────────

const PENDING = 'vault-people-pending-clear.json'

function readPending(fs, path) {
  try { const raw = JSON.parse(fs.readFileSync(path, 'utf8')); return raw && typeof raw === 'object' ? raw : {} } catch { return {} }
}

/**
 * The login's registrable domain. This repo carries no public suffix list, so:
 * the host after its first label, while that leaves at least two labels
 * (login.bank.example.com is bank.example.com, bank.example.com is
 * example.com, example.com stays).
 */
export function registrableDomain(host) {
  const labels = String(host ?? '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean)
  return labels.length > 2 ? labels.slice(1).join('.') : labels.join('.')
}

const underDomain = (host, domain) => {
  const h = String(host ?? '').toLowerCase().replace(/^\./, '')
  return h === domain || h.endsWith(`.${domain}`)
}

/**
 * S1: clear a lost site from one browser: cookies for each origin's
 * registrable domain, and storage (cookies included) for every origin under it
 * this browser knows of: the origin itself, the bare and www site, each cookie
 * domain under it and every open frame under it.
 */
async function clearInEngine(engine, origins) {
  const page = engine?.selectedPage?.() ?? engine?.pages?.()?.[0]
  if (!page || page.isClosed?.()) return false
  let cdp = null
  try {
    cdp = await page.context().newCDPSession(page)
    const all = (await cdp.send('Storage.getCookies'))?.cookies ?? []
    const frames = (engine.pages?.() ?? [page]).flatMap((p) => { try { return p.frames?.() ?? [] } catch { return [] } })
    const storageOrigins = new Set()
    const deleted = new Set()
    for (const origin of origins) {
      const domain = registrableDomain(new URL(origin).hostname)
      storageOrigins.add(origin)
      storageOrigins.add(`https://${domain}`)
      storageOrigins.add(`https://www.${domain}`)
      for (const cookie of all) {
        if (!underDomain(cookie?.domain, domain)) continue
        const key = `${cookie.name}\n${cookie.domain}\n${cookie.path}`
        if (!deleted.has(key)) {
          deleted.add(key)
          await cdp.send('Network.deleteCookies', { name: cookie.name, domain: cookie.domain, path: cookie.path })
        }
        storageOrigins.add(`https://${String(cookie.domain).replace(/^\./, '')}`)
      }
      for (const frame of frames) {
        try {
          const u = new URL(frame.url())
          if (u.protocol === 'https:' && underDomain(u.hostname, domain)) storageOrigins.add(u.origin)
        } catch {}
      }
    }
    for (const origin of storageOrigins) await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
    return true
  } catch {
    return false
  } finally {
    if (cdp) await cdp.detach?.().catch?.(() => {})
  }
}

/**
 * Clear cookies and storage for `origins` in this person's browser: now, in
 * the browser that is open (Storage.clearDataForOrigin, cookies included);
 * otherwise at its next start (applyPendingClears).
 */
export async function clearPersonOrigins({ pool, agentRoot, assistantId, userId, origins, fs = nodeFs }) {
  if (!isSafeLaneUserId(userId)) return false
  const clean = [...new Set((origins ?? []).map(httpsOrigin).filter(Boolean))]
  if (!clean.length) return false
  const slot = pool?.peek?.({ assistantId: Number(assistantId), principal: `user-${userId}` })
  if (slot && (await clearInEngine(slot.engine, clean))) return true
  const path = join(agentDir(agentRoot, assistantId), PENDING)
  const pending = readPending(fs, path)
  pending[userId] = [...new Set([...(Array.isArray(pending[userId]) ? pending[userId] : []), ...clean])].slice(0, ORIGINS_MAX)
  fs.mkdirSync(agentDir(agentRoot, assistantId), { recursive: true, mode: 0o700 })
  writePrivate(fs, path, `${JSON.stringify(pending)}\n`)
  return true
}

/** A person's browser just started: clear what waited for it, once. */
export async function applyPendingClears({ agentRoot, assistantId, principal, engine, fs = nodeFs }) {
  const m = /^user-(user_[A-Za-z0-9_-]{1,240})$/.exec(String(principal ?? ''))
  if (!m) return false
  const path = join(agentDir(agentRoot, assistantId), PENDING)
  const pending = readPending(fs, path)
  const origins = Array.isArray(pending[m[1]]) ? pending[m[1]].map(httpsOrigin).filter(Boolean) : []
  if (!origins.length) return false
  if (!(await clearInEngine(engine, origins))) return false
  delete pending[m[1]]
  writePrivate(fs, path, `${JSON.stringify(pending)}\n`)
  return true
}
