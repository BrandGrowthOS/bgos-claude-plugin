/**
 * The thread lane's transcript work, done on disk in pieces, never as one
 * string in the daemon (THREADCRASH, 0.87.1).
 *
 * 0.86.2 began clearing the main session's active /goal in a thread's copy of
 * its transcript (lib/thread-lane-args.ts threadLaneTranscript). It did it by
 * reading the WHOLE transcript into one string, splitting it into lines,
 * parsing every line from the end and writing the result back, synchronously,
 * on the daemon's only thread. An agent's main transcript grows for days: at
 * hundreds of megabytes that is several gigabytes of memory and seconds with
 * the event loop stopped, measured at about 4.5 times the file size, and the
 * daemon died there before it could start the lane.
 *
 * Here the copy is the file system's own (a clone on APFS), the search for the
 * latest goal row walks the file backwards in chunks of CHUNK_BYTES and parses
 * only a line that names goal_status, and the one row that changes is spliced
 * into a new file by streaming the bytes around it. Memory stays near one
 * chunk plus the longest line; every step is asynchronous.
 *
 * The rule is threadLaneTranscript's, byte for byte (test/thread-transcript.test.ts
 * holds the two equal): the LAST goal_status attachment row decides; met or
 * failed leaves the file alone; otherwise that row becomes the CLI's
 * goal-clear sentinel.
 *
 * Erasable TypeScript only. No em or en dashes in this file.
 */

import { constants as fsConstants } from 'node:fs'
import { copyFile, open, rename, rm, type FileHandle } from 'node:fs/promises'

export const CHUNK_BYTES = 1024 * 1024
const NEWLINE = 0x0a
const MARKER = Buffer.from('goal_status')

/** Where the active goal row sits in the file, and what replaces it. */
export interface GoalRowEdit {
  start: number
  end: number
  replacement: Buffer
}

/** The sentinel row for a parsed goal_status row, or null when it changes nothing. */
function goalEdit(line: Buffer): { done: boolean; replacement: Buffer | null } {
  if (line.indexOf(MARKER) < 0) return { done: false, replacement: null }
  let row: { type?: unknown; attachment?: { type?: unknown; met?: unknown; failed?: unknown; condition?: unknown } } | null
  try {
    row = JSON.parse(line.toString('utf8'))
  } catch {
    return { done: false, replacement: null }
  }
  if (row?.type !== 'attachment' || row.attachment?.type !== 'goal_status') return { done: false, replacement: null }
  if (row.attachment.met || row.attachment.failed) return { done: true, replacement: null }
  const cleared = { ...row, attachment: { type: 'goal_status', met: true, sentinel: true, condition: row.attachment.condition } }
  return { done: true, replacement: Buffer.from(JSON.stringify(cleared), 'utf8') }
}

/**
 * The latest goal_status row of the transcript at `path`, when it is still
 * active; null when there is none or it is met or failed. Reads backwards in
 * chunks; parses only lines that contain "goal_status".
 */
export async function findActiveGoalRow(path: string, chunkBytes: number = CHUNK_BYTES): Promise<GoalRowEdit | null> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    let found: GoalRowEdit | null | undefined
    await scanLinesBackwards(fh, size, chunkBytes, (line, start, end) => {
      const edit = goalEdit(line)
      if (!edit.done) return false
      found = edit.replacement ? { start, end, replacement: edit.replacement } : null
      return true
    })
    return found ?? null
  } finally {
    await fh.close()
  }
}

/**
 * Every line of the file, last first, with its byte range, until `onLine`
 * answers true. Linear in the file's size at any chunk size: the part of a
 * line that runs over several chunks is kept as a list of pieces and joined
 * once, when the line is complete (0.88.0; joining the growing piece on every
 * chunk made a 270 KB line read one byte at a time take over a minute).
 */
async function scanLinesBackwards(
  fh: FileHandle,
  size: number,
  chunkBytes: number,
  onLine: (line: Buffer, start: number, end: number) => boolean,
): Promise<void> {
  let pos = size
  // The pieces of the line in progress that lie after the current chunk, last piece first.
  let tail: Buffer[] = []
  // Where the line in progress ends in the file.
  let lineEndAt = size
  while (pos > 0) {
    const len = Math.min(chunkBytes, pos)
    pos -= len
    const chunk = Buffer.alloc(len)
    await readFully(fh, chunk, pos)
    let lineEnd = len
    for (let i = len - 1; i >= 0; i--) {
      if (chunk[i] !== NEWLINE) continue
      const head = chunk.subarray(i + 1, lineEnd)
      const line = tail.length === 0 ? head : Buffer.concat([head, ...tail.reverse()])
      if (onLine(line, pos + i + 1, lineEndAt)) return
      tail = []
      lineEnd = i
      lineEndAt = pos + i
    }
    if (lineEnd > 0) tail.push(Buffer.from(chunk.subarray(0, lineEnd)))
  }
  if (tail.length > 0) onLine(Buffer.concat(tail.reverse()), 0, lineEndAt)
}

async function readFully(fh: FileHandle, into: Buffer, position: number): Promise<void> {
  let done = 0
  while (done < into.length) {
    const { bytesRead } = await fh.read(into, done, into.length - done, position + done)
    if (bytesRead === 0) throw new Error('the transcript shrank while it was read')
    done += bytesRead
  }
}

/** Copy [from, to) of `src` into `dst` in chunks. */
async function copyRange(src: FileHandle, dst: FileHandle, from: number, to: number, chunkBytes: number): Promise<void> {
  const buf = Buffer.alloc(Math.min(chunkBytes, Math.max(1, to - from)))
  for (let at = from; at < to; ) {
    const len = Math.min(buf.length, to - at)
    const { bytesRead } = await src.read(buf, 0, len, at)
    if (bytesRead === 0) throw new Error('the transcript shrank while it was copied')
    await dst.write(buf, 0, bytesRead)
    at += bytesRead
  }
}

/**
 * Write `path` again with one row replaced, through a temporary file renamed
 * over it. The bytes around the row are copied CHUNK_BYTES at a time whatever
 * chunk the search used (0.88.0): the search's chunk size is there to test
 * line boundaries, and a copy one byte at a time made a test of a 270 KB line
 * take over a minute.
 */
async function spliceRow(path: string, edit: GoalRowEdit): Promise<void> {
  const temporary = `${path}.thread-goal.tmp`
  try {
    const src = await open(path, 'r')
    try {
      const { size } = await src.stat()
      const dst = await open(temporary, 'w')
      try {
        await copyRange(src, dst, 0, edit.start, CHUNK_BYTES)
        await dst.write(edit.replacement)
        await copyRange(src, dst, edit.end, size, CHUNK_BYTES)
        await dst.sync()
      } finally {
        await dst.close()
      }
    } finally {
      await src.close()
    }
    // Only after both are closed: Windows refuses to rename over a file that is still open (EPERM).
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

/**
 * The thread's copy of the main transcript: the file system copies it (a clone
 * where it can), then the active goal, if any, is cleared in the COPY only.
 * Never touches `from`.
 */
export async function copyTranscriptClearingGoal(from: string, to: string, chunkBytes: number = CHUNK_BYTES): Promise<void> {
  if (from === to) throw new Error('refusing to rewrite the main transcript in place')
  await copyFile(from, to, fsConstants.COPYFILE_FICLONE)
  await clearActiveGoal(to, chunkBytes)
}

/** Clear the active goal of the transcript at `path` (a thread's own fork), in place and atomically. */
export async function clearActiveGoal(path: string, chunkBytes: number = CHUNK_BYTES): Promise<boolean> {
  const edit = await findActiveGoalRow(path, chunkBytes)
  if (!edit) return false
  await spliceRow(path, edit)
  return true
}

const MODE_MARKER = Buffer.from('permission-mode')

/**
 * The permission mode the session at `path` is in now: its LATEST
 * `{"type":"permission-mode","permissionMode":...}` row (the CLI writes one at
 * start and at every change of mode; measured on 2.1.322). Null when the
 * transcript holds none (a headless run writes none) or cannot be read. Read
 * backwards in chunks like findActiveGoalRow, parsing only lines that name
 * the row type, so a transcript of hundreds of megabytes costs one chunk.
 * An owner's full access thread starts in this mode
 * (lib/thread-lane-args.ts threadFullPermissionMode).
 */
export async function latestPermissionMode(path: string, chunkBytes: number = CHUNK_BYTES): Promise<string | null> {
  const modeOf = (line: Buffer): string | null => {
    if (line.indexOf(MODE_MARKER) < 0) return null
    try {
      const row = JSON.parse(line.toString('utf8')) as { type?: unknown; permissionMode?: unknown } | null
      return row?.type === 'permission-mode' && typeof row.permissionMode === 'string' && row.permissionMode !== '' ? row.permissionMode : null
    } catch {
      return null
    }
  }
  let fh: FileHandle
  try {
    fh = await open(path, 'r')
  } catch {
    return null
  }
  try {
    const { size } = await fh.stat()
    let mode: string | null = null
    await scanLinesBackwards(fh, size, chunkBytes, (line) => {
      mode = modeOf(line)
      return mode !== null
    })
    return mode
  } catch {
    return null
  } finally {
    await fh.close()
  }
}
