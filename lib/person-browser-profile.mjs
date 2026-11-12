/**
 * person-browser-profile: where a PERSON's browser lives on this computer,
 * and its removal when the share that gave it ends (shared agent vault,
 * plugin 0.90.0; BGOS plan 2026-11-13 section 8).
 *
 * The browser host (bin/hoai-browser-host.mjs browserPathsFor) keeps one
 * profile per agent and principal: ~/.bgos-agent/<id>/browser/<dir>, its
 * page output in browser-output/<dir> and its downloads in
 * browser-downloads/<dir>, `<dir>` being principalDirName of the
 * principal, `user-<clerkUserId>` for a person. principalDirName lives here so
 * the host, the owner's daemon and a lane daemon all fold a principal into a
 * path the same way.
 *
 * A share ENDED when the server's `lane_revoked` says share_revoked,
 * view_removed or agent_transferred. Any other stop (the lane allow list, a
 * refused session) keeps the person's profile. The owner's daemon writes the
 * reason into the lane's revoke marker (lib/lane-owner.ts handleLaneRevoked),
 * so the browser host can close a browser still open for that person before
 * the folders go.
 *
 * Plain JavaScript, node builtins only. No em or en dashes in this file.
 */
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { isSafeAssistantId, isSafeLaneUserId } from './lane-core.mjs'
import { downloadPaths } from './browser-downloads.mjs'

const CANONICAL_PRINCIPAL = /^[a-z0-9][a-z0-9_-]{0,63}$/
// Names Windows reserves for devices, with or without an extension.
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/

/**
 * The directory name for a principal. INJECTIVE, including on a
 * case-insensitive file system (the macOS and Windows defaults):
 *
 *   - a principal that is already a safe lowercase name (`owner`,
 *     `user-42`) is used as is. Such names contain no dot;
 *   - anything else (upper case, as in every Clerk id, a dot, a slash, a
 *     space, non-ASCII) becomes `<readable>.<sha256 of the exact string>`.
 *     The dot cannot occur in the first form, so the two forms never meet,
 *     and the digest is of the untouched string, so two principals that
 *     read the same after folding still differ. Every character is lower
 *     case, so a case-insensitive disk cannot merge two names either.
 *
 * Never contains a path separator and is never `.` or `..`.
 */
export function principalDirName(principal) {
  const p = String(principal)
  if (CANONICAL_PRINCIPAL.test(p) && !WINDOWS_DEVICE_NAME.test(p)) return p
  let readable = p
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[_-]+/, '')
    .slice(0, 24)
  if (!readable || WINDOWS_DEVICE_NAME.test(readable)) readable = `p_${readable}`
  const digest = createHash('sha256').update(p, 'utf8').digest('hex').slice(0, 32)
  return `${readable}.${digest}`
}

/** The reasons of `lane_revoked` (BGOS LanesEndedReason) that mean the share itself ended. */
export const SHARE_ENDED_REASONS = Object.freeze(['share_revoked', 'view_removed', 'agent_transferred'])

export function shareEndedReason(reason) {
  return SHARE_ENDED_REASONS.includes(reason)
}

/** The principal the relay names a person by. */
export function personPrincipal(userId) {
  return `user-${userId}`
}

function checked(assistantId, userId) {
  if (!isSafeAssistantId(assistantId)) throw new Error('person browser: unsafe assistant id')
  if (!isSafeLaneUserId(userId)) throw new Error('person browser: unsafe person id')
}

/** The person's profile, its page output and its downloads (held and kept), as the host keys them. */
export function personBrowserDirs({ agentRoot, assistantId, userId }) {
  checked(assistantId, userId)
  const key = principalDirName(personPrincipal(userId))
  return [
    join(agentRoot, String(assistantId), 'browser', key),
    join(agentRoot, String(assistantId), 'browser-output', key),
    downloadPaths({ agentRoot, assistantId, key }).dir,
  ]
}

/** The lane's revoke marker (lib/lane-core.mjs lanePaths revokedPath), from the agent root. */
export function personRevokedPath({ agentRoot, assistantId, userId }) {
  checked(assistantId, userId)
  return join(agentRoot, String(assistantId), 'people', userId, 'revoked.json')
}

/** Did the server say this person's share ENDED (the reason the owner's daemon kept in the marker)? */
export function personShareEnded({ agentRoot, assistantId, userId, readText = (p) => readFileSync(p, 'utf8') }) {
  try {
    const marker = JSON.parse(readText(personRevokedPath({ agentRoot, assistantId, userId })))
    return shareEndedReason(marker?.shareReason)
  } catch {
    return false
  }
}

/** Remove the person's browser folders. Returns the folders that were there. Never the owner's (`ownerUserId`). */
export function deletePersonBrowserProfile({ agentRoot, assistantId, userId, ownerUserId = /** @type {string | null} */ (null), rm = (p) => rmSync(p, { recursive: true, force: true }), exists = existsSync }) {
  if (ownerUserId && userId === ownerUserId) throw new Error('person browser: that is the owner')
  const removed = []
  for (const dir of personBrowserDirs({ agentRoot, assistantId, userId })) {
    if (!exists(dir)) continue
    rm(dir)
    removed.push(dir)
  }
  return removed
}

/**
 * A lane daemon's own `lane_revoked`: when it names this lane's person and
 * agent and the share ended, delete that person's browser folders. Returns
 * what was removed (nothing for any other frame).
 */
export function laneRevokedProfileCleanup(frame, lane, agentRoot) {
  const f = frame && typeof frame === 'object' ? frame : {}
  if (f.actorUserId !== lane.userId || String(f.assistantId) !== String(lane.assistantId) || !shareEndedReason(f.reason)) return []
  return deletePersonBrowserProfile({ agentRoot, assistantId: lane.assistantId, userId: lane.userId })
}
