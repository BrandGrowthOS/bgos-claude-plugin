#!/usr/bin/env node
// A synchronous boundary for private tools. The existing telemetry hook stays async.
import { randomUUID } from 'node:crypto'
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

export async function main() {
  try {
    const chunks = []
    let size = 0
    for await (const chunk of process.stdin) {
      size += chunk.length
      if (size > 2 * 1024 * 1024) throw new Error('Private tool turn payload is too large.')
      chunks.push(chunk)
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
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
    // Letting the next prompt run with the old marker would expose another person's profile.
    process.stderr.write('HOAI could not establish the private tool turn. Check the local agent state directory, then retry the prompt.\n')
    process.exitCode = 2
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
