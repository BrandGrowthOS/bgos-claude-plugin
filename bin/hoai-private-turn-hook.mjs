#!/usr/bin/env node
// A synchronous boundary for private tools. The existing telemetry hook stays async.
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { findAttachedKey, floorKey, floorStateRoot, sessionFolders } from '../lib/floor-state.mjs'
import { PRIVATE_TOOL_MATCHER, privateAgentsPath, privateMarkerPath, privatePromptHash, readPrivateJson, writePrivateJson } from '../lib/private-turn.mjs'

/** This session's marker, or null for a standalone CLI session with no managed private tools. */
function managedMarkerPath(payload, env) {
  const root = floorStateRoot(env)
  const folders = sessionFolders(payload, env)
  const key = findAttachedKey({ root, folders }) || folders.map(floorKey).find(candidate => readPrivateJson(privateMarkerPath(root, candidate), 2048))
  return key ? privateMarkerPath(root, key) : null
}

export function recordPrivateBoundary(payload, env = process.env) {
  const path = managedMarkerPath(payload, env)
  if (!path) return false // A standalone CLI session has no managed private tools.
  const event = payload?.hook_event_name
  if (!['UserPromptSubmit', 'Stop', 'SessionEnd'].includes(event)) return false
  const sessionId = String(payload?.session_id ?? '').trim()
  if (!sessionId) throw new Error('Private tool turn has no session identity.')
  const marker = {
    schemaVersion: 1, turnId: randomUUID(), sessionId,
    promptHash: privatePromptHash(payload.prompt), live: event === 'UserPromptSubmit',
  }
  writePrivateJson(path, marker)
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
  const path = managedMarkerPath(payload, env)
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
  const path = managedMarkerPath(payload, env)
  if (!path) return null
  const agentId = helperId(payload)
  const marker = readPrivateJson(path, 2048)
  const known = readPrivateJson(privateAgentsPath(path), 16384)
  if (agentId && marker?.live === true && typeof marker.turnId === 'string' && marker.turnId &&
      known && typeof known === 'object' && Object.hasOwn(known, agentId) && known[agentId] === marker.turnId) return null
  return 'HOAI refused this private tool: this helper agent was started in an earlier turn (or its start was not recorded), so it cannot act for the person who sent the current message. Finish without it, or ask the sender to send the request again.'
}

/** Best effort: turn every existing marker for this session's folders non-live. */
export function invalidatePrivateBoundary(payload, env = process.env) {
  try {
    const root = floorStateRoot(env)
    for (const key of new Set(sessionFolders(payload, env).map(floorKey))) {
      const path = privateMarkerPath(root, key)
      if (!readPrivateJson(path, 2048)) continue
      try {
        writePrivateJson(path, { schemaVersion: 1, turnId: randomUUID(), sessionId: '', promptHash: '', live: false })
      } catch {
        try { rmSync(path, { force: true }) } catch { /* Nothing more can be done from a hook. */ }
      }
    }
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
    const recorded = recordPrivateBoundary(payload)
    if (recorded && recorded.marker.live && String(payload.prompt).includes('<hoai-private-turn id="')) {
      // Claude runs matching hooks in parallel. Give the existing async
      // forwarder and daemon intake time to publish before the first tool.
      const until = Date.now() + 2500
      while (Date.now() < until) {
        const ready = readPrivateJson(`${recorded.path}.ready`, 2048)
        if (ready?.turnId === recorded.marker.turnId && ready.sessionId === recorded.marker.sessionId) break
        await new Promise((resolve) => setTimeout(resolve, 25))
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
