/**
 * PERSON LANES, a person's own memory (shared agents Phase 3, P5; design
 * section 6 row Memory and its "As built in P4" list; spike S2).
 *
 * WHERE IT LIVES. `<lane>/work/memory/`: a MEMORY.md index (one line per
 * memory) and one note file per memory, the format lib/memory.ts reads and
 * writes for the owner's memory screen. It sits inside `work/`, the only
 * folder the lane's file tools reach, so the model reads and saves it with
 * Read, Edit and Write. Nothing of the owner's memory or another person's
 * lane is in it.
 *
 * HOW THE MODEL KNOWS IT. Under `--restricted` the CLI's auto memory is off
 * and no CLAUDE.md loads, and no setting brings either back (spike S2). What
 * does reach the model is `--append-system-prompt-file`, so the supervisor
 * writes `<lane>/system-prompt.md` at every start: what this lane may do
 * (from the share's policy), the memory folder and its format, and the index
 * as it stands, cut where the CLI cuts its own (200 lines, 25,000 bytes). A
 * memory the person edits from the app therefore reaches the model at the
 * lane's next start, as the owner's own memory screen promises.
 *
 * ONCE PER rpcId, ACROSS PROCESSES (P4 as built). The server sends a memory
 * frame to every socket that declared lane memory and re-sends it once after
 * 1.5 s, so two processes can hold one write: the lane daemon and the owner's
 * daemon around a stop, a lane relaunched after it applied a write and before
 * it acked. The FIRST process to create the marker file for that rpcId
 * (`<lane>/memory-rpc/<sha256>.json`, exclusive create) applies it; every
 * other one applies nothing and re-sends the first one's answer once it is
 * written. The markers sit in the lane folder, outside `work/`, where the
 * lane's model cannot reach them.
 *
 * Plain JavaScript: the supervisor runs on a bare `node`.
 *
 * No em or en dashes in this file.
 */
import * as nodeFs from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { readToolPolicy } from './lane-policy.mjs'

/** The CLI truncates the index at 200 lines and 25 KB when it loads it (lib/memory.ts). */
export const LANE_MEMORY_INDEX_MAX_LINES = 200
export const LANE_MEMORY_INDEX_MAX_BYTES = 25_000

/** The index as the model is shown it: cut at 200 lines and 25,000 bytes, on a line. */
export function truncateMemoryIndex(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n').slice(0, LANE_MEMORY_INDEX_MAX_LINES)
  const out = []
  let bytes = 0
  for (const line of lines) {
    const size = Buffer.byteLength(`${line}\n`, 'utf8')
    if (bytes + size > LANE_MEMORY_INDEX_MAX_BYTES) break
    out.push(line)
    bytes += size
  }
  return out.join('\n').trim()
}

/**
 * The lane's system prompt file: what this lane may do on the owner's
 * computer, and the person's own memory.
 *
 * @param {{ workDir: string, memoryDir: string, indexText: string | null, policy: unknown,
 *   agentFolder?: string | null, ownerServerNames?: string[] }} params
 */
export function laneSystemPromptBody({ workDir, memoryDir, indexText, policy, agentFolder = null, ownerServerNames = [] }) {
  const p = readToolPolicy(policy)
  const can = [`- Read and write files in your working folder, ${workDir}.`]
  if (p.readAgentFolder && agentFolder) can.push(`- Read, but never change, your owner's agent folder, ${agentFolder}.`)
  if (p.webFetch) can.push('- Fetch web pages and search the web.')
  if (p.shell) can.push('- Run commands on your owner\'s computer.')
  if (p.ownerMcpServers && ownerServerNames.length > 0) can.push(`- Use these tools of your owner's: ${ownerServerNames.join(', ')}.`)
  const index = truncateMemoryIndex(indexText ?? '')
  return [
    '# This lane',
    '',
    'You are talking with ONE person, in their own private chat, in their own lane on your owner\'s computer. This lane is theirs alone: your owner\'s conversations and memory, and other people\'s lanes, are not here.',
    '',
    '## What you can do in this lane',
    '',
    ...can,
    '',
    'Nothing else on your owner\'s computer is open to you. If the person asks for something you cannot do here, tell them so in one plain sentence.',
    '',
    '## Your memory of this person',
    '',
    `Your memory of this person is the folder ${memoryDir}. MEMORY.md there is the index, one line per memory, written as`,
    '- [Title](file-name.md) - one line about it',
    'and each memory is its own file in that folder, starting with',
    '---',
    'name: a short name',
    'description: one line about it',
    'metadata:',
    '  type: user (about this person) or project (anything else worth keeping)',
    '---',
    'and then the memory itself.',
    '',
    'Save a memory when you learn something about this person, or about your work together, that will help in a later conversation; update one that changed and remove one that is wrong, its file and its index line together. Keep the index short. This memory is this person\'s own: nothing from your owner\'s memory or anyone else\'s is in it. The person can read, correct and delete these notes from the app, and their edits reach you at your next start. If a note changed or is gone and you did not change it, the person most likely did: leave it as it is.',
    '',
    'The index as it stood when this session started:',
    '',
    index === '' ? '(empty: nothing saved yet)' : index,
    '',
  ].join('\n')
}

// ── Once per rpcId, across processes ────────────────────────────────────────

/** Markers older than this are removed on the next claim. */
export const LANE_MEMORY_MARKER_KEEP_MS = 24 * 60 * 60_000

function markerPath(dir, rpcId) {
  return join(dir, `${createHash('sha256').update(String(rpcId)).digest('hex').slice(0, 40)}.json`)
}

/**
 * Claim one write. `first` means apply it now; `done` carries the answer the
 * process that applied it wrote; `running` means another process holds it
 * and will answer itself.
 *
 * @param {string} dir
 * @param {string} rpcId
 * @param {{ fs?: typeof nodeFs, now?: () => number }} [deps]
 * @returns {{ kind: 'first' } | { kind: 'done', result: unknown } | { kind: 'running' }}
 */
export function claimLaneMemoryWrite(dir, rpcId, { fs = nodeFs, now = Date.now } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  pruneLaneMemoryMarkers(dir, { fs, now })
  const path = markerPath(dir, rpcId)
  try {
    fs.writeFileSync(path, `${JSON.stringify({ state: 'running', at: new Date(now()).toISOString() })}\n`, { flag: 'wx', mode: 0o600 })
    return { kind: 'first' }
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err
  }
  try {
    const raw = JSON.parse(String(fs.readFileSync(path, 'utf8')))
    if (raw?.state === 'done' && raw.result && typeof raw.result === 'object') return { kind: 'done', result: raw.result }
  } catch { /* being written: running */ }
  return { kind: 'running' }
}

/** Record the answer of a claimed write, so a duplicate re-sends it. */
export function finishLaneMemoryWrite(dir, rpcId, result, { fs = nodeFs, now = Date.now } = {}) {
  const path = markerPath(dir, rpcId)
  const tmp = `${path}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ state: 'done', result, at: new Date(now()).toISOString() })}\n`, { mode: 0o600 })
  fs.renameSync(tmp, path)
}

/** Best effort: drop markers past LANE_MEMORY_MARKER_KEEP_MS. */
export function pruneLaneMemoryMarkers(dir, { fs = nodeFs, now = Date.now } = {}) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!/^[0-9a-f]{40}\.json$/.test(name)) continue
    try {
      const st = fs.statSync(join(dir, name))
      if (now() - st.mtimeMs > LANE_MEMORY_MARKER_KEEP_MS) fs.unlinkSync(join(dir, name))
    } catch { /* raced */ }
  }
}
