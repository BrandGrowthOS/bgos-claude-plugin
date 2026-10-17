#!/usr/bin/env node
/**
 * THE FLOOR HOOK OF A PERSON'S LANE (shared agents Phase 3, P3; design 7.2
 * item 8). Registered by the lane's own settings file (lib/lane-core.mjs
 * laneSettingsBody) as a PreToolUse hook on every tool, with the lane's
 * person on its command line: `hoai-lane-floor-hook.mjs --lane <userId>`.
 *
 * It differs from the owner's floor hook (bin/hoai-floor-hook.mjs) in the
 * three ways a lane needs:
 *
 *   1. RULES VERSION 4 (lib/hard-floor-lane.mjs): version 3's actions plus
 *      any read of a secret or of another person's lane, judged here on the
 *      same bytes the backend judges (lib/hard-floor-lane-fixture.ts).
 *   2. The floor is ON whatever the owner's switch says, and a hold is a
 *      DENY: under `--permission-mode dontAsk` nothing could ask anyway.
 *   3. It fails CLOSED. Unreadable input, a missing or unsafe person id, a
 *      classifier that throws or a hook that runs out of time all answer
 *      deny. In a lane a false hold refuses one action; a missed one hands
 *      the owner's secret to a stranger.
 *
 * No network and no credentials: nothing here can fail open on a backend.
 *
 * No em or en dashes in this file.
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

// No static import of the plugin's own modules: if they cannot be loaded (a
// moved or half updated plugin folder), the hook must still answer, and its
// answer is deny (security review finding 8). The rules are loaded in main().

/** A person id as lib/lane-core.mjs LANE_USER_ID_RE allows it (a test pins the two equal). */
export const HOOK_LANE_USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** The hook answers within this, or denies. */
export const LANE_FLOOR_HOOK_BUDGET_MS = 3_000
export const LANE_FLOOR_STDIN_MAX_BYTES = 16 * 1024 * 1024

/** The PreToolUse answer that refuses the call. */
export function laneFloorDeny(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: String(reason),
    },
  })
}

/** The person id from argv (`--lane <userId>`), or null. */
export function laneFromArgv(argv) {
  const i = argv.indexOf('--lane')
  const value = i >= 0 ? argv[i + 1] : undefined
  return typeof value === 'string' && HOOK_LANE_USER_ID_RE.test(value) ? value : null
}

/**
 * Decide one hook call. Returns the line to print, or '' to let the call
 * through (no output means the CLI's own permission rules decide, which in a
 * lane is the allow list under dontAsk).
 *
 * @param {string} text the hook's stdin
 * @param {string | null} userId
 * @param {((toolName: string, toolInput: unknown, ctx: { actorUserId: string }) => unknown) | null} classify
 *   lib/hard-floor-lane.mjs classifyLaneToolCall, or null when it could not be loaded
 */
export function decideLaneFloor(text, userId, classify) {
  if (typeof classify !== 'function') return laneFloorDeny('This lane\'s floor could not load its rules, so it refuses every action.')
  if (!userId) return laneFloorDeny('This lane\'s floor does not know whose lane it is, so it refuses every action.')
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return laneFloorDeny('This lane\'s floor could not read the action, so it refuses it.')
  }
  if (!payload || typeof payload !== 'object' || typeof payload.tool_name !== 'string') {
    return laneFloorDeny('This lane\'s floor could not read the action, so it refuses it.')
  }
  let match
  try {
    match = classify(payload.tool_name, payload.tool_input, { actorUserId: userId })
  } catch {
    return laneFloorDeny('This lane\'s floor could not judge the action, so it refuses it.')
  }
  if (!match) return ''
  return laneFloorDeny(`Not on this computer from a shared lane: ${match.words}.`)
}

async function readStdin(limit) {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > limit) throw new Error('stdin too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function main(argv = process.argv.slice(2)) {
  const userId = laneFromArgv(argv)
  const deadline = setTimeout(() => {
    process.stdout.write(laneFloorDeny('This lane\'s floor ran out of time, so it refuses the action.'))
    process.exit(0)
  }, LANE_FLOOR_HOOK_BUDGET_MS)
  let classify = null
  try {
    classify = (await import('../lib/hard-floor-lane.mjs')).classifyLaneToolCall
  } catch { /* decideLaneFloor denies without its rules */ }
  let out
  try {
    out = decideLaneFloor(await readStdin(LANE_FLOOR_STDIN_MAX_BYTES), userId, classify)
  } catch {
    out = laneFloorDeny('This lane\'s floor could not read the action, so it refuses it.')
  }
  clearTimeout(deadline)
  if (out) process.stdout.write(out)
  process.exit(0)
}

function isRunAsMain(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (typeof argv1 !== 'string') return false
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1)
  } catch {
    return moduleUrl === pathToFileURL(argv1).href
  }
}

if (isRunAsMain()) {
  try {
    await main()
  } catch {
    process.stdout.write(laneFloorDeny('This lane\'s floor failed, so it refuses the action.'))
    process.exit(0)
  }
}
