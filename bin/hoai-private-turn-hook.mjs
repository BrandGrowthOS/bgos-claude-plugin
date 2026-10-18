#!/usr/bin/env node
// A synchronous boundary for private tools. The existing telemetry hook stays async.
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findOwnAttachedKey, floorKey, floorStateRoot, sessionFolders } from '../lib/floor-state.mjs'
import { PRIVATE_TOOL_MATCHER, privateAgentsPath, privateMarkerPath, privatePromptHash, privateTurnRecord, privateUnservedPath, readPrivateJson, writePrivateJson } from '../lib/private-turn.mjs'

const envText = (env, name) => (env && typeof env[name] === 'string' ? env[name].trim() : '')

/** The longest the hook waits for the daemon's receipt (<marker>.ready) after writing a live marker. */
export const PRIVATE_TURN_READY_WAIT_MS = 2500
/**
 * The latest it waits, counted from its own process start (0.68.4). The CLI's timeout counts from the spawn, and the
 * 2.5 s used to count from the marker write, so a slow node start added on top: Vera's hook took 3082 to 3706 ms
 * against a 3 s limit (Data, board row d6aa4f1f). The imports cost about 8 ms; the start is what varied. The CLI's
 * timeout for this hook is 5 s (hooks/hooks.json, lib/claude-preseed.mjs PRIVATE_HOOK_TIMEOUT_SECONDS): 2 s over this
 * deadline for what the process cannot see of itself, its creation and its exit.
 */
export const PRIVATE_TURN_HOOK_DEADLINE_MS = 3000
/** When the wait for the receipt ends, given the ms since this process started when the marker was written. */
export function readyWaitEnd(sinceStartMs) {
  return Math.min(sinceStartMs + PRIVATE_TURN_READY_WAIT_MS, PRIVATE_TURN_HOOK_DEADLINE_MS)
}

/** One attached entry the hook passed over, in a few words. */
function describeEntry({ key, state, pid, projectDir }) {
  if (state === 'other-project') return `${key}: pid ${pid} serves the transcripts in ${projectDir}`
  if (state === 'older-daemon') return `${key}: pid ${pid}, a daemon older than 0.68.4, at a folder other than this session's project folder`
  if (state === 'not-running') return `${key}: pid ${pid} is not running`
  return `${key}: unreadable`
}

/**
 * This session's marker: { path } under the key whose live daemon serves this session, else { path: null, why, stale },
 * `why` null when there is nothing to say (a standalone CLI session: nothing attached, no marker, no managed tools).
 * Before 0.68.4 the marker went under the first live attached entry of ANY daemon, or with none under the first of
 * the session's folders that held a marker. On a computer running several agents that was another agent's key, so
 * neither daemon could use the turn and the other agent's own marker was overwritten (Vera's under Mark's,
 * 2026-10-13). Now nothing is written unless this session's own daemon is attached (findOwnAttachedKey).
 * `stale`: this session's own live markers at keys no other live daemon holds. With nowhere to write, they are
 * closed instead, so a turn they carried (its signed browser context lives up to 60 s) cannot outlast this boundary.
 * `holding`: this session's stale closes that still hold a CLI turn (closeMarkers) at such keys.
 */
function managedMarker(payload, env) {
  const root = floorStateRoot(env)
  const folders = sessionFolders(payload, env)
  const projectFolder = envText(env, 'CLAUDE_PROJECT_DIR')
  const transcriptPath = typeof payload?.transcript_path === 'string' ? payload.transcript_path : ''
  const base = projectFolder || (typeof payload?.cwd === 'string' ? payload.cwd : '')
  const { key, seen, daemon } = findOwnAttachedKey({ root, folders, transcriptPath, projectFolder, base })
  if (key) return { root, path: privateMarkerPath(root, key), stale: [], holding: [], daemon }
  const held = new Set(seen.filter((entry) => entry.state === 'other-project' || entry.state === 'older-daemon').map((entry) => entry.key))
  const sessionId = String(payload?.session_id ?? '').trim()
  const markers = folders.map(floorKey).filter(Boolean)
    .map((candidate) => ({ key: candidate, path: privateMarkerPath(root, candidate), marker: readPrivateJson(privateMarkerPath(root, candidate), 2048) }))
    .filter((entry) => entry.marker)
  const stale = markers.filter((entry) => sessionId && entry.marker.sessionId === sessionId && entry.marker.live === true && !held.has(entry.key)).map((entry) => entry.path)
  const holding = markers.filter((entry) => sessionId && entry.marker.live === false && entry.marker.staleTurn === sessionId && !held.has(entry.key)).map((entry) => entry.path)
  if (seen.length === 0 && markers.length === 0) return { root, path: null, why: null, stale, holding }
  const found = seen.length > 0 ? seen.map(describeEntry).join('; ') : 'none of them has a daemon attached'
  return { root, path: null, why: `no live daemon attached to this session's folders serves its transcript ${transcriptPath || '(none named)'} (${found})`, stale, holding }
}

/** What a stale close keeps of the live marker it closes: the record of its CLI turn (privateTurnRecord). */
const HELD_TURN_KEYS = ['cliTurn', 'after', 'afterLive', 'tags', 'tagsLost', 'untracked', 'prompts', 'daemon']

/**
 * Best effort: turn these markers non-live. With `holdFor`, a session's prompt that found no daemon of its own
 * attached (a daemon standing down after it lost the pairing lock, a torn read of its attached entry): the CLI is still
 * in the turn that session's live marker names, so the close holds that turn (`staleTurn`, the session) and its record,
 * and the next prompt with the daemon attached again continues it, unsure, since this prompt ran in it with no marker
 * (lib/private-turn.mjs privateTurnRecord). Without it the turn is over for good (a Stop, a SessionEnd); the next
 * prompt used to open a new CLI turn inside the same one (the re-review of c69224fe).
 */
function closeMarkers(paths, holdFor = '') {
  for (const path of paths) {
    try {
      const marker = holdFor ? readPrivateJson(path, 2048) : null
      const held = {}
      if (marker?.live === true && marker.sessionId === holdFor && typeof marker.cliTurn === 'string' && marker.cliTurn) {
        for (const key of HELD_TURN_KEYS) if (marker[key] !== undefined) held[key] = marker[key]
        held.staleTurn = holdFor
      }
      writePrivateJson(path, { schemaVersion: 1, turnId: randomUUID(), sessionId: '', promptHash: '', live: false, ...held })
    } catch {
      try { rmSync(path, { force: true }) } catch { /* Nothing more can be done from a hook. */ }
    }
  }
}

/** A session id safe to name a file by, or ''. */
const fileSafeSession = (sessionId) => (/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ? sessionId : '')

/**
 * @param {(why: string) => void} [report] told why a prompt's marker was not written, when there is a reason to give
 */
export function recordPrivateBoundary(payload, env = process.env, report = () => {}) {
  const event = payload?.hook_event_name
  if (!['UserPromptSubmit', 'Stop', 'SessionEnd'].includes(event)) return false
  const target = managedMarker(payload, env)
  const sessionId = String(payload?.session_id ?? '').trim()
  const notePath = fileSafeSession(sessionId) ? privateUnservedPath(target.root, sessionId) : ''
  if (!target.path) {
    if (event === 'UserPromptSubmit') closeMarkers(target.stale, sessionId)
    else closeMarkers([...target.stale, ...target.holding])
    // A standalone CLI session has no managed private tools; any other session's prompt says why it has no turn,
    // here and in a note its own daemon's refusal line quotes (lib/private-turn.mjs explain).
    if (event === 'UserPromptSubmit' && target.why) {
      try { report(target.why) } catch { /* Reporting is best effort. */ }
      const promptId = typeof payload?.prompt_id === 'string' ? payload.prompt_id.trim().slice(0, 128) : ''
      if (notePath) {
        try { writePrivateJson(notePath, { schemaVersion: 1, at: Date.now(), sessionId, ...(promptId ? { promptId } : {}), why: target.why.slice(0, 1024) }) } catch { /* The stderr line still says it. */ }
      }
    }
    return false
  }
  const path = target.path
  if (!sessionId) throw new Error('Private tool turn has no session identity.')
  // promptId: the CLI's prompt_id, shared by every hook of one submission, so the daemon can tell a second hook
  // source re-stamping this marker from the same words submitted again (lib/private-turn.mjs current).
  const promptId = typeof payload?.prompt_id === 'string' ? payload.prompt_id.trim().slice(0, 128) : ''
  const turnId = randomUUID()
  // A prompt records the CLI turn it belongs to, from the marker before it (lib/private-turn.mjs privateTurnRecord):
  // this hook runs in step with the CLI, the forwarder lines the daemon reads do not (board row f81a527c).
  const previous = event === 'UserPromptSubmit' ? readPrivateJson(path, 2048) : null
  const record = event === 'UserPromptSubmit'
    ? privateTurnRecord({ previous, previousUnreadable: previous === null && existsSync(path), previousMissing: previous === null && !existsSync(path), sessionId, prompt: payload.prompt, turnId, promptId, daemon: target.daemon })
    : {}
  const marker = {
    schemaVersion: 1, turnId, sessionId,
    promptHash: privatePromptHash(payload.prompt), live: event === 'UserPromptSubmit',
    ...(promptId ? { promptId } : {}),
    ...record,
  }
  writePrivateJson(path, marker)
  if (notePath && event === 'UserPromptSubmit') {
    try { rmSync(notePath, { force: true }) } catch { /* A stale note only adds words to a refusal line. */ }
  }
  return { path, marker }
}

const helperId = (payload) => {
  const id = String(payload?.agent_id ?? '').trim()
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null
}

/**
 * SubagentStart: remember which turn started this helper. A background helper
 * keeps running after its turn, and an MCP call carries no caller identity, so
 * without this record it would act as whoever sends the NEXT message.
 */
export function recordSubagentTurn(payload, env = process.env) {
  const path = managedMarker(payload, env).path
  const agentId = helperId(payload)
  if (!path || !agentId) return false
  const marker = readPrivateJson(path, 2048)
  if (marker?.live !== true || typeof marker.turnId !== 'string' || !marker.turnId) return false
  const agentsPath = privateAgentsPath(path)
  const known = readPrivateJson(agentsPath, 16384)
  const kept = Object.entries(known && typeof known === 'object' && !Array.isArray(known) ? known : {})
    .filter(([id, turnId]) => id !== agentId && typeof turnId === 'string').slice(-63)
  writePrivateJson(agentsPath, Object.fromEntries([...kept, [agentId, marker.turnId]]))
  return true
}

/**
 * PreToolUse on a private tool: a helper may act only inside the live turn that
 * started it. The main agent is left to the daemon and the browser shim, which
 * check the live turn themselves. Returns the refusal text, or null.
 */
export function privateToolRefusal(payload, env = process.env) {
  if (!new RegExp(PRIVATE_TOOL_MATCHER).test(String(payload?.tool_name ?? ''))) return null
  if (String(payload?.agent_id ?? '').trim() === '') return null
  const target = managedMarker(payload, env)
  // A helper in a session whose own daemon is not attached: the turn that started it cannot be checked.
  if (!target.path) return target.why ? 'HOAI refused this private tool: no HOAI daemon of this agent is attached to the session, so the turn that started this helper agent cannot be checked.' : null
  const path = target.path
  const agentId = helperId(payload)
  const marker = readPrivateJson(path, 2048)
  const known = readPrivateJson(privateAgentsPath(path), 16384)
  if (agentId && marker?.live === true && typeof marker.turnId === 'string' && marker.turnId &&
      known && typeof known === 'object' && Object.hasOwn(known, agentId) && known[agentId] === marker.turnId) return null
  return 'HOAI refused this private tool: this helper agent was started in an earlier turn (or its start was not recorded), so it cannot act for the person who sent the current message. Finish without it, or ask the sender to send the request again.'
}

/**
 * Best effort: turn this session's marker non-live: the one under its own daemon's key, else its own live markers at
 * keys no other live daemon holds. Every marker of the session's folders used to be closed, and one of those folders
 * can be another agent's, whose live turn it ended.
 */
export function invalidatePrivateBoundary(payload, env = process.env) {
  try {
    const target = managedMarker(payload, env)
    closeMarkers(target.path ? (readPrivateJson(target.path, 2048) ? [target.path] : []) : [...target.stale, ...target.holding])
  } catch { /* An unreadable payload has no folders to close. */ }
}

export async function main() {
  let payload = null
  try {
    const chunks = []
    let size = 0
    for await (const chunk of process.stdin) {
      size += chunk.length
      if (size > 16 * 1024 * 1024) throw new Error('Private tool turn payload is too large.')
      chunks.push(chunk)
    }
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (payload?.hook_event_name === 'PreToolUse') {
      const refusal = privateToolRefusal(payload)
      if (refusal) {
        process.stderr.write(`${refusal}\n`)
        process.exitCode = 2
      }
      return
    }
    if (payload?.hook_event_name === 'SubagentStart') {
      recordSubagentTurn(payload)
      return
    }
    let unserved = ''
    const recorded = recordPrivateBoundary(payload, process.env, (why) => { unserved = why })
    if (unserved) {
      // Exit 1: a non blocking error the CLI records with the prompt. The prompt runs; its private tools refuse.
      process.stderr.write(`HOAI wrote no private turn marker: ${unserved}. Private tools refuse this turn.\n`)
      process.exitCode = 1
      return
    }
    if (recorded && recorded.marker.live && String(payload.prompt).includes('<hoai-private-turn id="')) {
      // Claude runs matching hooks in parallel. Give the existing async
      // forwarder and daemon intake time to publish before the first tool,
      // within the deadline counted from this process's start (performance.now()).
      const until = readyWaitEnd(performance.now())
      while (performance.now() < until) {
        const ready = readPrivateJson(`${recorded.path}.ready`, 2048)
        if (ready?.turnId === recorded.marker.turnId && ready.sessionId === recorded.marker.sessionId) break
        await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(25, until - performance.now()))))
      }
    }
  } catch {
    const event = payload?.hook_event_name
    if (event === 'PreToolUse' || event === 'SubagentStart') {
      // A helper whose turn cannot be checked is refused; the main agent is not.
      if (event === 'PreToolUse' && String(payload?.agent_id ?? '').trim() !== '') {
        process.stderr.write('HOAI refused this private tool: the turn that started this helper agent could not be checked.\n')
        process.exitCode = 2
      }
      return
    }
    if (event === 'Stop' || event === 'SessionEnd') {
      // Exit 2 on Stop would block stopping and loop. Close the marker instead,
      // so private tools refuse until the next prompt, and let the turn end.
      invalidatePrivateBoundary(payload)
      process.stderr.write('HOAI could not record the end of the private tool turn. Private tools stay refused until the next prompt.\n')
      return
    }
    // Letting the next prompt run with the old marker would expose another person's profile.
    process.stderr.write('HOAI could not establish the private tool turn. Check the local agent state directory, then retry the prompt.\n')
    process.exitCode = 2
  }
}
// REAL paths on both sides: node resolves the module URL through symlinks but
// leaves argv[1] as the caller wrote it, so a launch through an aliased home
// (/Users/fitecho is /Users/bgos) skipped main() silently (board bbbf3438).
function isRunAsMain(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (typeof argv1 !== 'string' || !argv1) return false
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1)
  } catch {
    return moduleUrl === pathToFileURL(argv1).href
  }
}
if (isRunAsMain()) await main()
