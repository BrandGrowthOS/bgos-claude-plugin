/**
 * The synchronous PreToolUse hook sees the raw Bash command. The channel only
 * gets a display preview, with invisible characters replaced by spaces.
 * Keep a short lived, owner only copy for the command panel, never for a
 * permission decision. A full command match is required; the floor's loose
 * probe and oldest-record fallback are deliberately unsuitable here.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PERMISSION_INPUT_MAX_BYTES = 64 * 1024
export const PERMISSION_INPUT_MAX_RECORDS = 64
export const PERMISSION_INPUT_TTL_MS = 120_000

const directory = (root, key) => join(root, 'permission-input', key)
const hash = (text) => createHash('sha256').update(text).digest('hex')
// Only restore display whitespace and the three format controls seen in the
// live run. Redacted, elided, or otherwise changed commands cannot match.
const fold = (text) => text.replace(/[\u200b\u2060\u202e]/g, ' ').replace(/\s+/g, ' ').trim()

function records(dir, now) {
  const found = []
  for (const name of readdirSync(dir)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    const path = join(dir, name)
    try {
      if (statSync(path).size > PERMISSION_INPUT_MAX_BYTES + 2048) throw new Error('oversized')
      const record = JSON.parse(readFileSync(path, 'utf8'))
      if (record.v !== 1 || typeof record.at !== 'number' || !Number.isFinite(record.at) ||
          now - record.at > PERMISSION_INPUT_TTL_MS || record.at > now + 1000 ||
          typeof record.sessionId !== 'string' || typeof record.command !== 'string' ||
          Buffer.byteLength(record.command) > PERMISSION_INPUT_MAX_BYTES) throw new Error('invalid')
      found.push({ path, record })
    } catch {
      try { unlinkSync(path) } catch {}
    }
  }
  return found.sort((a, b) => a.record.at - b.record.at)
}

/** All Bash calls are recorded, so a plain-space twin makes a match ambiguous. */
export function writePermissionInput({ root, key, payload, now = Date.now() }) {
  let temporary
  try {
    const command = payload.tool_input?.command
    if (payload.hook_event_name !== 'PreToolUse' || payload.tool_name !== 'Bash' ||
        typeof command !== 'string' || Buffer.byteLength(command) > PERMISSION_INPUT_MAX_BYTES ||
        typeof payload.session_id !== 'string' || !payload.session_id ||
        typeof payload.tool_use_id !== 'string' || !payload.tool_use_id || !key) return
    const dir = directory(root, key)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${hash(`${payload.session_id}\n${payload.tool_use_id}`)}.json`)
    for (const old of records(dir, now).slice(0, -(PERMISSION_INPUT_MAX_RECORDS - 1))) {
      try { unlinkSync(old.path) } catch {}
    }
    temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
    writeFileSync(temporary, JSON.stringify({ v: 1, at: now, sessionId: payload.session_id, command }), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } catch {
    // A missing copy must never change the hook's permission decision.
  } finally {
    if (temporary) { try { unlinkSync(temporary) } catch {} }
  }
}

/** Return a reconstructed preview, or the original preview on every uncertainty. */
export function takePermissionInput({ root, keys, sessionId, toolName, inputPreview, now = Date.now() }) {
  if (toolName !== 'Bash' || !sessionId || typeof inputPreview !== 'string') return inputPreview
  try {
    const preview = JSON.parse(inputPreview)
    if (!preview || typeof preview.command !== 'string') return inputPreview
    const candidates = new Map()
    for (const key of new Set(keys)) {
      let entries = []
      try { entries = records(directory(root, key), now) } catch {}
      for (const entry of entries) {
        if (entry.record.sessionId === sessionId && fold(entry.record.command) === fold(preview.command)) {
          candidates.set(entry.path, entry)
        }
      }
    }
    // Consume ambiguous matches too: neither may be borrowed by a later ask.
    for (const { path } of candidates.values()) unlinkSync(path)
    if (candidates.size !== 1) return inputPreview
    const [{ record }] = candidates.values()
    if (!/[\u200b\u2060\u202e\u2028]/.test(record.command)) return inputPreview
    return JSON.stringify({ ...preview, command: record.command })
  } catch {
    return inputPreview
  }
}
