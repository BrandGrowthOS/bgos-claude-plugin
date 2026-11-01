/**
 * THE FLOOR IN A PERSON'S LANE: rules version 4 (person lanes, shared agents
 * Phase 3, P3; design 7.2 items 7 and 8).
 *
 * A recipient's lane runs on the OWNER's computer. Version 3 of the floor
 * (hard-floor-core.mjs) lists actions that change things and act on the
 * owner's behalf, and deliberately no secret READS. In a lane that is not
 * enough, so a lane's answer is version 3's list PLUS one rule, and the floor
 * is ON in every lane whatever the owner's switch says:
 *
 *   reads_a_secret   any path, in any input, under `.ssh`, `.aws`,
 *                    `.config/gcloud`, `.gnupg`, a home `.claude*`, an
 *                    agent's browser profile (`.bgos-agent/<id>/browser`),
 *                    ANOTHER person's lane (`.bgos-agent/<id>/people/<not
 *                    this person>`), the owner's saved email files
 *                    (`.bgos-agent/email-files`), `.bgos-plugin-state`, a
 *                    `credentials-*.json`, a keychain, or any `.env*`.
 *
 * This is a port of the backend's classifier
 * (backend/src/services/hard-floor-lane.ts). The two are held together by the
 * shared case list, lib/hard-floor-lane-fixture.ts, copied byte for byte from
 * the backend and pinned by sha256 in test/hard-floor-lane.test.ts, which runs
 * every case through this file. Plain JavaScript for the same reason as the
 * version 3 core: the lane's floor hook (bin/hoai-lane-floor-hook.mjs) runs on
 * a bare `node`. Pure: no env, no clock, no network.
 *
 * No em or en dashes in this file.
 */
import { classifyFloor, classifyToolCall, HARD_FLOOR_RULES_VERSION } from './hard-floor-core.mjs'

export const HARD_FLOOR_LANE_RULES_VERSION = 4

/** The one rule a lane adds to version 3. */
export const LANE_SECRET_READ_RULE = Object.freeze({
  id: 'reads_a_secret',
  words: "reading a secret, a sign in, or another person's files on this computer",
})

function laneMatch(evidence) {
  return {
    ruleId: LANE_SECRET_READ_RULE.id,
    rulesVersion: HARD_FLOOR_LANE_RULES_VERSION,
    words: LANE_SECRET_READ_RULE.words,
    evidence,
  }
}

function asLaneVersion(match) {
  return match ? { ...match, rulesVersion: HARD_FLOOR_LANE_RULES_VERSION } : null
}

/**
 * The shared fixture's entry: one of the version 3 input kinds, and whose lane
 * it is. Version 3's list first, so an action on both lists answers by the
 * owner's rule id.
 *
 * @param {{ kind: string, [key: string]: unknown }} input
 * @param {{ actorUserId: string }} ctx
 */
export function classifyLaneFloor(input, ctx) {
  const owner = classifyFloor(input)
  if (owner) return asLaneVersion(owner)
  const hit = pathTokensOf(inputText(input)).find((token) => lanePathIsSecret(token, ctx))
  return hit === undefined ? null : laneMatch(hit)
}

/**
 * The hook's entry: a tool call as the CLI hands it to a PreToolUse hook.
 *
 * @param {string} toolName
 * @param {unknown} toolInput
 * @param {{ actorUserId: string }} ctx
 */
export function classifyLaneToolCall(toolName, toolInput, ctx) {
  const owner = classifyToolCall(toolName, toolInput)
  if (owner) return asLaneVersion(owner)
  let rendered = ''
  try {
    rendered = JSON.stringify(toolInput) ?? ''
  } catch {
    rendered = ''
  }
  const hit = pathTokensOf(`${toolName ?? ''} ${rendered}`).find((token) => lanePathIsSecret(token, ctx))
  return hit === undefined ? null : laneMatch(hit)
}

/** Every text the input carries, as one string. */
function inputText(input) {
  if (typeof input !== 'object' || input === null) return ''
  switch (input.kind) {
    case 'command':
      return String(input.command ?? '')
    case 'path':
      return String(input.path ?? '')
    case 'tool':
      return String(input.toolName ?? '')
    case 'request':
      return `${input.toolName ?? ''} ${input.inputPreview ?? ''}`
    default:
      return ''
  }
}

/**
 * Path shaped tokens: backslashes (JSON escaped or not) read as slashes, then
 * split on whitespace, quotes and JSON or shell punctuation. A token is kept
 * when it has a slash in it or begins with a dot or a tilde.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function pathTokensOf(text) {
  return String(text ?? '')
    .replace(/\\\\/g, '/')
    .replace(/\\/g, '/')
    .split(/[\s"'`,;|&<>(){}[\]=]+/)
    .filter((token) => token !== '' && (token.includes('/') || token.startsWith('.') || token.startsWith('~')))
}

const ROOTED = /^(?:~|\$home|%userprofile%|[a-z]:|\/)/
const ROOT_MARKER = /^(?:~|\$home|%userprofile%|[a-z]:)$/

/**
 * The path's segments with `.` dropped and every `..` applied (lexically).
 * `climbsOut` when a `..` would go above the path's first segment.
 *
 * @param {string} lowerPath
 */
export function resolvedSegments(lowerPath) {
  const segments = []
  let climbsOut = false
  for (const seg of lowerPath.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg !== '..') {
      segments.push(seg)
    } else if (segments.length === 0 || (segments.length === 1 && ROOT_MARKER.test(segments[0]))) {
      climbsOut = true
    } else {
      segments.pop()
    }
  }
  return { segments, climbsOut }
}

/**
 * Is this one path a secret for this lane (case folded, as macOS and Windows
 * are).
 *
 * @param {string} path
 * @param {{ actorUserId: string }} ctx
 */
export function lanePathIsSecret(path, ctx) {
  const lower = String(path).toLowerCase()
  const own = String(ctx?.actorUserId ?? '').toLowerCase()
  const { segments, climbsOut } = resolvedSegments(lower)
  if (climbsOut) return true
  let insideOwnLane = false
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]
    const next = segments[i + 1]
    if (seg === '.ssh' || seg === '.aws' || seg === '.gnupg') return true
    if (seg === '.config' && next === 'gcloud') return true
    if (seg.startsWith('.env')) return true
    if (seg === '.bgos-plugin-state') return true
    if (seg === 'library' && next === 'keychains') return true
    if (seg.endsWith('.keychain') || seg.endsWith('.keychain-db')) return true
    if (seg === '.bgos-agent') {
      // The owner's email files (read attachments): a stranger's mail to the
      // owner's agent, saved for the OWNER's turns, never a person's.
      if (next === 'email-files') return true
      const area = segments[i + 2]
      if (area === 'browser') return true
      if (area === 'people') {
        const person = segments[i + 3]
        if (person === undefined || own === '' || person !== own) return true
        insideOwnLane = true
      }
    }
    if (seg.startsWith('.claude')) {
      const relativeInside = !ROOTED.test(lower)
      if (!insideOwnLane && !relativeInside) return true
    }
  }
  const base = segments[segments.length - 1] ?? ''
  return /^credentials-.*\.json$/.test(base)
}

/** The version 3 list this one extends (for the version test). */
export const HARD_FLOOR_OWNER_RULES_VERSION = HARD_FLOOR_RULES_VERSION
