#!/usr/bin/env node
// A synchronous boundary for private tools. The existing telemetry hook stays async.
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { findAttachedKey, floorKey, floorStateRoot, sessionFolders } from '../lib/floor-state.mjs'
import { privateMarkerPath, privatePromptHash, readPrivateJson, writePrivateJson } from '../lib/private-turn.mjs'

export function recordPrivateBoundary(payload, env = process.env) {
  const root = floorStateRoot(env)
  const folders = sessionFolders(payload, env)
  const key = findAttachedKey({ root, folders }) || folders.map(floorKey).find(candidate => readPrivateJson(privateMarkerPath(root, candidate), 2048))
  if (!key) return false // A standalone CLI session has no managed private tools.
  const event = payload?.hook_event_name
  if (!['UserPromptSubmit', 'Stop', 'SessionEnd'].includes(event)) return false
  const sessionId = String(payload?.session_id ?? '').trim()
  if (!sessionId) throw new Error('Private tool turn has no session identity.')
  const path = privateMarkerPath(root, key)
  const marker = {
    schemaVersion: 1, turnId: randomUUID(), sessionId,
    promptHash: privatePromptHash(payload.prompt), live: event === 'UserPromptSubmit',
  }
  writePrivateJson(path, marker)
  return { path, marker }
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
      if (size > 2 * 1024 * 1024) throw new Error('Private tool turn payload is too large.')
      chunks.push(chunk)
    }
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
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
