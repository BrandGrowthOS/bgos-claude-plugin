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
    let pos = size
    // Bytes after the last newline seen so far that belong to the line in progress (read backwards).
    let carry = Buffer.alloc(0)
    let carryEnd = size
    while (pos > 0) {
      const len = Math.min(chunkBytes, pos)
      pos -= len
      const chunk = Buffer.alloc(len)
      await readFully(fh, chunk, pos)
      let buf = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk
      const bufStart = pos
      let lineEnd = buf.length
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i] !== NEWLINE) continue
        const line = buf.subarray(i + 1, lineEnd)
        const edit = goalEdit(line)
        if (edit.done) return edit.replacement ? { start: bufStart + i + 1, end: bufStart + lineEnd, replacement: edit.replacement } : null
        lineEnd = i
      }
      carry = Buffer.from(buf.subarray(0, lineEnd))
      carryEnd = bufStart + lineEnd
      buf = Buffer.alloc(0)
    }
    if (carry.length > 0) {
      const edit = goalEdit(carry)
      if (edit.done && edit.replacement) return { start: 0, end: carryEnd, replacement: edit.replacement }
    }
    return null
  } finally {
    await fh.close()
  }
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

/** Write `path` again with one row replaced, through a temporary file renamed over it. */
async function spliceRow(path: string, edit: GoalRowEdit, chunkBytes: number): Promise<void> {
  const temporary = `${path}.thread-goal.tmp`
  try {
    const src = await open(path, 'r')
    try {
      const { size } = await src.stat()
      const dst = await open(temporary, 'w')
      try {
        await copyRange(src, dst, 0, edit.start, chunkBytes)
        await dst.write(edit.replacement)
        await copyRange(src, dst, edit.end, size, chunkBytes)
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
  await spliceRow(path, edit, chunkBytes)
  return true
}
