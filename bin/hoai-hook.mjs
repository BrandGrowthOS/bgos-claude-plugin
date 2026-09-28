#!/usr/bin/env node
/**
 * hoai-hook: the Claude Code hook forwarder.
 *
 * Claude Code runs this once per registered hook event, with the payload as
 * JSON on stdin. It appends one line to this session's spool file and exits.
 * That is the whole job:
 *
 *   <state>/hooks/<session_id>/events.jsonl
 *   { "id": "<line id>", "receivedAt": <ms>, "event": "<name>", "payload": { ... } }
 *
 * The daemon (server.ts, through lib/hook-intake.ts) watches that directory and
 * drains it. See lib/hook-intake.ts for why the transport is a file rather than
 * a loopback port.
 *
 * Four rules this file exists to hold:
 *
 * 1. IT ALWAYS EXITS 0. Exit code 2 from a hook BLOCKS the tool call on
 *    PreToolUse, PREVENTS a task on TaskCreated and STOPS the agentic loop on
 *    PostToolBatch. A telemetry forwarder that can block the agent is a defect,
 *    not a feature, so every path here, a crash included, ends at exit code 0
 *    and writes nothing to stdout.
 *    THE ONE BLOCKING HOOK IS NOT THIS FILE (0.53.0). The plugin registers a
 *    second PreToolUse script, bin/hoai-floor-hook.mjs, with `async: false`,
 *    because the owner's "Always ask before risky actions" needs a listed
 *    action (a recursive delete, a force push, a change inside .git, to an
 *    .env file or to a home settings file, a tool that sends, posts, pays or
 *    deletes) to stop and ask even under full access, and a blocking hook's
 *    `ask` is the only thing the CLI honours there (map part 24, run D1). It
 *    only ever asks, never denies and never exits 2, and it fails open. This
 *    forwarder stays exactly as it was: async, exit 0, unable to stop anything.
 * 2. IT READS STDIN AS BYTES. The live probe crashed a hook that read stdin in
 *    text mode on Windows: the console code page could not decode a box glyph
 *    the payload carried. Collect Buffers, decode UTF-8 explicitly.
 * 3. IT OPENS NO SOCKET AND READS NO CREDENTIALS. This process runs inside the
 *    user's session on every tool call. It touches one directory under the
 *    plugin state root and nothing else.
 * 4. IT NEVER GROWS WITHOUT BOUND. A payload over 256 KB is reduced to the
 *    fields the mapper actually reads, and a spool past 2 MB is rotated.
 * 5. ITS LINE ID IS MINTED, NOT MEASURED. Two hook processes fire at once on
 *    any parallel tool call. When the line's identity was the file SIZE each
 *    of them stat'ed, both read the same number, both appended, and the daemon
 *    saw one identity for two different events: the second one was dropped as
 *    a duplicate. The id is now a per process random tag plus a counter, so it
 *    cannot collide however many forwarders run, and each line is written with
 *    ONE appendFileSync (an O_APPEND write of a single small line, which the
 *    OS does not interleave) rather than a seek the other process can race.
 *
 * Plain JavaScript, node >= 18 builtins only, import safe (nothing runs on
 * import; main() is called only when this file is argv[1]).
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Mirrors lib/hook-intake.ts. A drift test pins the two together. */
export const SPOOL_DIR_NAME = 'hooks'
export const SPOOL_FILE_NAME = 'events.jsonl'
export const SPOOL_ROTATED_NAME = 'events.1.jsonl'
export const SPOOL_MAX_BYTES = 2 * 1024 * 1024
/** Over this, the payload is reduced to the fields the mapper reads. */
export const PAYLOAD_MAX_BYTES = 256 * 1024
/** Per field clip inside a reduced tool_input. */
export const REDUCED_FIELD_MAX = 200

/**
 * This process's tag: random, so two forwarders started in the same
 * millisecond (same pid clock, same file size) still mint different ids.
 */
export const LINE_ID_TAG = `${process.pid.toString(36)}${randomBytes(4).toString('hex')}`

let lineCounter = 0

/** The next line id for this process. Monotonic within it, unique across it. */
export function nextLineId(tag = LINE_ID_TAG) {
  lineCounter += 1
  return `${tag}-${lineCounter}`
}

/** The plugin state root, exactly as lib/cursor-store.ts and lib/hook-intake.ts
 *  derive it. */
export function stateRoot(env = process.env, home = homedir()) {
  return env.BGOS_PLUGIN_STATE_DIR || join(home, '.bgos-plugin-state')
}

/** Sanitise a session id into a directory name. Twin of safeSessionKey in
 *  lib/hook-intake.ts; the drift test compares the two. */
export function safeSessionKey(sessionId) {
  const raw = String(sessionId ?? '').trim()
  // Dots are dropped along with every separator, so no arrangement of the
  // incoming value can produce a '..' segment and climb out of the spool root.
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '_')
  if (!safe) return 'unknown'
  if (safe.length <= 64) return safe
  return `${safe.slice(0, 48)}-${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`
}

export function spoolDir(sessionId, env = process.env, home = homedir()) {
  return join(stateRoot(env, home), SPOOL_DIR_NAME, safeSessionKey(sessionId))
}

export function spoolPath(sessionId, env = process.env, home = homedir()) {
  return join(spoolDir(sessionId, env, home), SPOOL_FILE_NAME)
}

/** The payload fields the mapper reads, plus the envelope every event carries. */
export const KEPT_PAYLOAD_KEYS = [
  'hook_event_name',
  'session_id',
  'transcript_path',
  'cwd',
  'prompt_id',
  'permission_mode',
  'tool_name',
  'tool_use_id',
  'duration_ms',
  'source',
  'trigger',
  'stop_hook_active',
  // Stage 7 reads what the call did: the response on a success, the error
  // string on a failure (its first line carries the exit code), and the one
  // boolean that says the owner stopped it. tool_response AND error are
  // REDUCED below rather than kept whole, because keeping a whole file body is
  // the one thing this reduction exists to prevent, and because the generic
  // clipper keeps a HEAD, which is the wrong end of a failure.
  'tool_response',
  'error',
  'is_interrupt',
  // Stage 8 reads the child agents a turn spawns. agent_id says whose work a
  // tool event is (a parent's own events carry none), agent_type is the child's
  // kind word, and last_assistant_message is what the child replied when it
  // stopped. agent_transcript_path is deliberately NOT here: nothing reads the
  // child's own transcript, and keeping it invites something to start.
  'agent_id',
  'agent_type',
  'last_assistant_message',
]

/** Double the 2048 the wire keeps, so the mapper still has slack to mask the
 *  output and only then cut it to its tail. */
export const REDUCED_OUTPUT_MAX = 4096

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

const clipValue = (value) => {
  if (typeof value === 'string') {
    return value.length > REDUCED_FIELD_MAX ? `${value.slice(0, REDUCED_FIELD_MAX)}...` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  return undefined
}

const tailOf = (text, max = REDUCED_OUTPUT_MAX) => (text.length > max ? text.slice(-max) : text)

const countContentLines = (content) =>
  content === '' ? 0 : content.replace(/\r?\n$/, '').split(/\r?\n/).length

/**
 * The same counting rule as lib/tool-outcome.ts: a `+` line is added, a `-`
 * line is removed, and the `\ No newline at end of file` marker is neither.
 * It is written twice on purpose. This process is plain node with no
 * TypeScript loader, so it cannot import that module, and both copies are
 * pinned by tests.
 */
function countPatchLines(hunks) {
  let linesAdded = 0
  let linesRemoved = 0
  for (const hunk of hunks) {
    const lines = isRecord(hunk) && Array.isArray(hunk.lines) ? hunk.lines : []
    for (const entry of lines) {
      if (typeof entry !== 'string') continue
      if (entry.startsWith('\\')) continue
      // No header skip: see lib/tool-outcome.ts, same rule, same reason.
      if (entry.startsWith('+')) linesAdded += 1
      else if (entry.startsWith('-')) linesRemoved += 1
    }
  }
  return { linesAdded, linesRemoved }
}

/**
 * A tool response, reduced to what the mapper reads and nothing more.
 *
 * A failure arrives as a STRING whose FIRST line is the exit code, so that
 * line is kept whole and the LAST 4096 characters of the rest follow it: the
 * code and the tail of what the command printed both survive. A success
 * arrives as an object, and only a handful of its fields are ever read: the
 * two streams (their tails), whether the owner interrupted it, the runtime's
 * own reading of a non zero exit, and the two line counts. The hunks become
 * those counts and the file body becomes one number, because the body itself
 * never reaches the wire and there is no reason to spool it.
 */
export function reduceToolResponse(response) {
  if (typeof response === 'string') {
    const newline = response.indexOf('\n')
    if (newline === -1) return tailOf(response)
    return `${response.slice(0, newline + 1)}${tailOf(response.slice(newline + 1))}`
  }
  if (!isRecord(response)) return undefined
  const out = {}
  if (typeof response.stdout === 'string') out.stdout = tailOf(response.stdout)
  if (typeof response.stderr === 'string') out.stderr = tailOf(response.stderr)
  if (typeof response.interrupted === 'boolean') out.interrupted = response.interrupted
  if (typeof response.returnCodeInterpretation === 'string') {
    out.returnCodeInterpretation = clipValue(response.returnCodeInterpretation)
  }
  if (Array.isArray(response.structuredPatch) && response.structuredPatch.length > 0) {
    out.structuredPatch = countPatchLines(response.structuredPatch)
  }
  if (typeof response.type === 'string') out.type = clipValue(response.type)
  // The launch of a child agent (stage 8). agentId is the ONLY place the
  // child's id and the row's tool_use_id are ever seen together, and isAsync
  // and status are how a launch is told apart from a finished call: never the
  // tool name, never the event name.
  if (typeof response.agentId === 'string') out.agentId = clipValue(response.agentId)
  if (typeof response.isAsync === 'boolean') out.isAsync = response.isAsync
  if (typeof response.status === 'string') out.status = clipValue(response.status)
  // ONLY a create: the line count of a body is an addition only when the whole
  // body is new. An update arrives with an empty patch whenever nothing
  // changed, the diff timed out or the write was staged, and sending its body
  // count made the row claim the entire file. lib/tool-outcome.ts gates on the
  // same `type`, so the rule is one rule on both paths.
  if (typeof response.content === 'string' && response.type === 'create') {
    out.content = { lines: countContentLines(response.content) }
  }
  return out
}

/**
 * Reduce an oversized payload to what the mapper reads.
 *
 * The field that actually gets big is tool_input: a Write carries the whole
 * file, an Edit carries both sides of the change. Neither ever reaches the
 * wire (the tool row's args field is 120 characters), so there is no reason to
 * spool megabytes of it. Small payloads pass through byte for byte.
 *
 * Stage 7 added the second big field, tool_response, and it is NOT dropped:
 * the row's output, its exit code and an edit's counts are all read out of it,
 * so it is reduced (reduceToolResponse above) instead. Dropping it would cost
 * the owner exactly the rows a very large call produces.
 *
 * `error` goes through the SAME reducer, and not through the generic per field
 * clipper, because the generic one keeps a head: a failing command's string
 * carries its exit code on the first line and what it printed after that, and
 * the end is the part the owner is looking for.
 */
export function clipPayload(payload, maxBytes = PAYLOAD_MAX_BYTES) {
  if (!isRecord(payload)) return {}
  let size
  try {
    size = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  } catch {
    size = maxBytes + 1
  }
  if (size <= maxBytes) return payload

  const reduced = {}
  for (const key of KEPT_PAYLOAD_KEYS) {
    if (payload[key] !== undefined) reduced[key] = clipValue(payload[key]) ?? payload[key]
  }
  if (isRecord(payload.tool_input)) {
    const input = {}
    for (const [key, value] of Object.entries(payload.tool_input)) {
      const clipped = clipValue(value)
      if (clipped !== undefined) input[key] = clipped
    }
    reduced.tool_input = input
  }
  if (typeof payload.error === 'string') {
    // The kept keys loop above clipped this to its FIRST 200 characters, and a
    // failure string is the one field whose end is the point: its first line
    // carries the exit code and everything after it is what the command
    // printed before it failed. The live failure shape carries NO
    // tool_response at all, so this string is the only copy there is.
    reduced.error = reduceToolResponse(payload.error)
  }
  if ('tool_response' in payload) {
    // The kept keys loop above has no way to shrink an object, so it put the
    // whole response in. Replace it with the reduced one, or drop it.
    const response = reduceToolResponse(payload.tool_response)
    if (response === undefined) delete reduced.tool_response
    else reduced.tool_response = response
  }
  if (Array.isArray(payload.background_tasks)) {
    reduced.background_tasks = payload.background_tasks.slice(0, 10).map((task) => {
      if (!isRecord(task)) return clipValue(task) ?? ''
      const out = {}
      for (const key of ['description', 'subject', 'name', 'prompt', 'command', 'status']) {
        const clipped = clipValue(task[key])
        if (clipped !== undefined) out[key] = clipped
      }
      return out
    })
  }
  reduced.hoai_clipped = true
  return reduced
}

/**
 * Make room for one more line: rotate when the file has grown past the cap.
 * Returns false only when rotation was needed and failed, which is the one
 * case where dropping the event beats growing the file forever.
 *
 * The size is read for ROTATION and nothing else. It is deliberately not the
 * line's identity (header rule 5): two forwarders stat the same number.
 */
export function rotateIfFull(path, fs, maxBytes = SPOOL_MAX_BYTES) {
  let size = 0
  try {
    size = fs.size(path)
  } catch {
    size = 0
  }
  if (size < maxBytes) return true
  try {
    fs.rotate(path)
    return true
  } catch {
    // Rotation failed (a live reader on Windows, a read only directory).
    return false
  }
}

/** The one line the forwarder writes. Pure, so the shape is testable. */
export function buildSpoolLine({ id, receivedAt, event, payload }) {
  return `${JSON.stringify({ id, receivedAt, event, payload })}\n`
}

function defaultSpoolFs() {
  return {
    size: (path) => {
      try {
        return statSync(path).size
      } catch {
        return 0
      }
    },
    rotate: (path) => {
      const rotated = join(path, '..', SPOOL_ROTATED_NAME)
      try {
        unlinkSync(rotated)
      } catch {
        /* nothing to replace */
      }
      renameSync(path, rotated)
    },
    mkdir: (dir) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    },
    append: (path, text) => {
      appendFileSync(path, text, { mode: 0o600 })
    },
  }
}

/**
 * Append one payload to its session spool. Returns the line's id, or null
 * when nothing was written. Never throws.
 */
export function appendEvent(payload, opts = {}) {
  const fs = opts.fs ?? defaultSpoolFs()
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const now = opts.now ?? Date.now()
  if (!isRecord(payload)) return null
  const sessionId = String(payload.session_id ?? '').trim()
  if (!sessionId) return null
  const dir = spoolDir(sessionId, env, home)
  const path = join(dir, SPOOL_FILE_NAME)
  try {
    fs.mkdir(dir)
  } catch {
    return null
  }
  if (!rotateIfFull(path, fs, opts.maxBytes ?? SPOOL_MAX_BYTES)) return null
  const id = opts.lineId ?? nextLineId(opts.lineIdTag)
  const line = buildSpoolLine({
    id,
    receivedAt: now,
    event: String(payload.hook_event_name ?? ''),
    payload: clipPayload(payload, opts.payloadMaxBytes ?? PAYLOAD_MAX_BYTES),
  })
  try {
    // ONE call: appendFileSync opens O_APPEND, writes the whole line and
    // closes. A reader either sees the complete line or does not see it, and a
    // second forwarder's line lands after it rather than inside it.
    fs.append(path, line)
  } catch {
    return null
  }
  return id
}

/** Read the whole of a stream as BYTES, then decode UTF-8 (rule 2 in the
 *  header). Bounded, so a runaway producer cannot exhaust memory. */
/** @param {AsyncIterable<Buffer|string>} stream */
export async function readStdin(stream = /** @type {any} */ (process.stdin), maxBytes = 8 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
    total += buf.length
    if (total > maxBytes) break
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Parse the hook payload. Never throws: junk on stdin is a no-op, not a crash. */
export function parseStdinPayload(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Every path ends here: exit code 0, nothing on stdout. */
export async function main(opts = {}) {
  try {
    const text = await readStdin(opts.stdin ?? process.stdin)
    const payload = parseStdinPayload(text)
    if (payload !== null) appendEvent(payload, opts)
  } catch {
    // A hook that fails is a hook that logged nothing. It must not be a hook
    // that blocked a tool call.
  }
  process.exitCode = 0
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  void main()
}
