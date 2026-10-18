/**
 * The answers an agent's own browser saved for its owner, as the owner sees
 * them, and how the owner takes them back (HOAI board row 79fda9a6).
 *
 * WHERE THEY LIVE. `_remember` in bin/hoai-browser-host.mjs files every
 * Always allow and Trust this site through the vendored profiles.js, under
 * `agentGrants["assistant-<id>"][origin]` in
 * ~/.bgos-agent/<id>/browser/<principal>/agent-browser.settings.json: one
 * file per agent AND per person it browsed for, on the agent's own machine.
 * A session also honours the legacy global `alwaysGrants` map beneath the
 * agent's own (profiles.sessionGrants), so a forget clears both, the way
 * profiles.withoutTrustGrant does.
 *
 * WHY THIS IS NOT IN THE VENDORED COPY. lib/browser-host-core/ is a byte
 * identical copy of the desktop's rule tier (vendor.json); a change there is
 * a change to the desktop. These helpers only read and remove what that tier
 * wrote, so they sit beside it and leave it alone.
 *
 * WHAT A FORGET REMOVES. The whole saved grant of that origin, every field,
 * including one a newer host added that this one does not know: a forget
 * that left part of a grant behind would not be a forget. The one thing it
 * keeps is an owner's Deny (`access: "deny"`), because forgetting a refusal
 * would be the opposite of what the owner asked for. Every other key of the
 * file (switches, other agents' maps, keys a newer host added) is kept as
 * read, so an older or newer reader still finds a file it understands.
 *
 * Pure apart from savedSiteDirs, which only lists folders.
 */

import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** The grant fields the list names, in the order it names them, and the word for each. */
export const SAVED_GRANT_WORDS = [
  ['access', 'open'],
  ['write', 'write'],
  ['uploads', 'upload'],
  ['downloads', 'download'],
  ['evaluate', 'script'],
]

/** The most sites one answer carries; a longer list is cut, never failed. */
export const SAVED_SITES_MAX = 500

/** The longest origin a forget request may name. */
export const SAVED_SITE_ORIGIN_MAX = 300

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/** What the list says about one grant, or null when it saves nothing (absent, or only a Deny). */
export function describeGrant(origin, grant) {
  if (!isPlainObject(grant)) return null
  const trusted = grant.trust === 'allow'
  const allowed = SAVED_GRANT_WORDS.filter(([field]) => grant[field] === 'allow').map(([, word]) => word)
  const anyOther = Object.entries(grant).some(([field, value]) => field !== 'trust' && field !== 'access' && value === 'allow' && !SAVED_GRANT_WORDS.some(([f]) => f === field))
  if (!trusted && allowed.length === 0 && !anyOther) return null
  return { origin, trusted, allowed }
}

/**
 * The saved sites of one settings file for this agent key, as a session of
 * that agent would honour them (legacy map overlaid by the agent's own),
 * sorted by origin.
 */
export function savedSitesOf(settings, key, sessionGrants) {
  if (!key || !isPlainObject(settings)) return []
  const grants = sessionGrants(settings, key)
  return Object.keys(grants)
    .sort()
    .map((origin) => describeGrant(origin, grants[origin]))
    .filter(Boolean)
}

/** One grant after a forget: the owner's Deny alone, or nothing. */
function forgotten(grant) {
  return isPlainObject(grant) && grant.access === 'deny' ? { access: 'deny' } : null
}

/**
 * A grant map with `origin` forgotten (or every origin, when origin is null).
 * Returns { map, forgot } with a NEW map, or forgot = [] and the same map
 * when nothing in it was saved.
 */
export function forgetInGrants(map, origin) {
  if (!isPlainObject(map)) return { map, forgot: [] }
  const targets = origin === null ? Object.keys(map) : Object.prototype.hasOwnProperty.call(map, origin) ? [origin] : []
  const forgot = targets.filter((o) => describeGrant(o, map[o]))
  if (!forgot.length) return { map, forgot: [] }
  const next = Object.assign({}, map)
  for (const o of forgot) {
    const left = forgotten(map[o])
    if (left) next[o] = left
    else delete next[o]
  }
  return { map: next, forgot }
}

/**
 * The settings with this agent's saved answer for `origin` (or all of them,
 * origin null) forgotten, in the agent's own map and in the legacy map.
 * Returns { settings, forgot } with the origins that were forgotten, or null
 * when there was nothing to forget, so the caller writes nothing.
 */
export function withoutSavedSites(settings, key, origin) {
  if (!key || !isPlainObject(settings)) return null
  const agentGrants = isPlainObject(settings.agentGrants) ? settings.agentGrants : null
  const mine = forgetInGrants(agentGrants ? agentGrants[key] : null, origin)
  const legacy = forgetInGrants(settings.alwaysGrants, origin)
  if (!mine.forgot.length && !legacy.forgot.length) return null
  const out = Object.assign({}, settings)
  if (mine.forgot.length) out.agentGrants = Object.assign({}, agentGrants, { [key]: mine.map })
  if (legacy.forgot.length) out.alwaysGrants = legacy.map
  return { settings: out, forgot: [...new Set([...mine.forgot, ...legacy.forgot])].sort() }
}

/**
 * The profile folders of one agent that hold a settings file: one per person
 * (principal) it browsed for, `<agentRoot>/<id>/browser/<principal>/`. A
 * symbolic link is never followed, so a link planted in the folder cannot
 * point a forget at some other file.
 */
export function savedSiteDirs(agentRoot, assistantId, settingsFile) {
  const base = join(agentRoot, String(assistantId), 'browser')
  let entries
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(base, entry.name)
    try {
      if (lstatSync(join(dir, settingsFile)).isFile()) dirs.push(dir)
    } catch {}
  }
  return dirs.sort()
}

/**
 * One owner request as the socket carried it, checked, or null. Exactly one
 * of `origin` (a string) or `all: true` on a forget; nothing else is read.
 */
export function readSavedSitesRequest(input) {
  if (!isPlainObject(input)) return null
  const assistantId = input.assistantId
  if (!Number.isSafeInteger(assistantId) || assistantId <= 0) return null
  if (input.op === 'list') return { assistantId, op: 'list' }
  if (input.op !== 'forget') return null
  const hasOrigin = input.origin !== undefined
  const all = input.all === true
  if (hasOrigin === all) return null
  if (all) return { assistantId, op: 'forget', all: true }
  if (typeof input.origin !== 'string' || !input.origin || input.origin.length > SAVED_SITE_ORIGIN_MAX) return null
  return { assistantId, op: 'forget', origin: input.origin }
}
