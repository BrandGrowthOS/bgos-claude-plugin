/**
 * The goal lane's transcript reader (stage 6 of the Mission program).
 *
 * A cursored tailer in the shape of RestingWatcher (./resting.ts:415-500),
 * with one deliberate difference: RestingWatcher walks EVERY .jsonl in the
 * workspace's project directory, because a usage cap is account wide and any
 * session's transcript is evidence of it. A GOAL is not like that. It belongs
 * to one session, and a goal set in a neighbouring session on the same machine
 * must never be adopted into this owner's mission. So the path here comes from
 * sessionBinder.provenTranscriptPath() (./session-binding.ts:362) and from
 * nowhere else: that method answers only for a POSITIVELY proven binding, and
 * while it answers null this reader reads nothing at all.
 *
 * The rest is ordinary cursor bookkeeping, and every rule in it has a reason:
 *
 *   - the path is asked for on EVERY read, never remembered, and a change of
 *     path resets the cursor, because a byte count of one session's file says
 *     nothing about another's;
 *   - a new path starts a bounded tail back rather than at byte zero, so a
 *     goal armed just before the daemon restarted is still seen, and the
 *     caller's `sinceMs` floor in extractGoalRecords is what keeps that replay
 *     safe (a resumed session rewrites its parent's rows with their ORIGINAL
 *     timestamps, and completing a mission off last week's goal is exactly the
 *     failure this lane must not have);
 *   - a file that shrank was rotated or truncated, so the cursor restarts at
 *     zero;
 *   - a single read is capped the way SessionTranscriptBinder.readTail caps
 *     one, so a long quiet period followed by a big append cannot pull an
 *     unbounded buffer into memory;
 *   - a partial trailing line is left for the next read, because a live file
 *     is being appended to while this runs;
 *   - every fs failure answers with nothing. A goal is a nicety on top of a
 *     chat daemon and it must never take the daemon down.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

/** How far back into a newly bound transcript the first read looks. */
export const GOAL_TAIL_STARTUP_BYTES = 64 * 1024

/** The most one read will pull, matching the binder's own tail window. */
export const GOAL_TAIL_READ_MAX_BYTES = 256 * 1024

export interface GoalTailOptions {
  startupTailBytes?: number
  readMaxBytes?: number
}

export class GoalTail {
  private readonly provenPath: () => string | null
  private readonly startupTailBytes: number
  private readonly readMaxBytes: number
  private path: string | null = null
  private cursor: number | null = null

  constructor(provenPath: () => string | null, opts: GoalTailOptions = {}) {
    this.provenPath = provenPath
    this.startupTailBytes = opts.startupTailBytes ?? GOAL_TAIL_STARTUP_BYTES
    this.readMaxBytes = opts.readMaxBytes ?? GOAL_TAIL_READ_MAX_BYTES
  }

  /** The transcript the last read came from, or null. Telemetry only. */
  boundPath(): string | null {
    return this.path
  }

  /**
   * The COMPLETE lines appended since the last read, or an empty string when
   * there are none, when no transcript is proven, or when the file could not
   * be read. Never throws.
   */
  read(): string {
    const path = this.provenPath()
    if (typeof path !== 'string' || path === '') return ''
    if (path !== this.path) {
      this.path = path
      this.cursor = null
    }

    try {
      const fd = openSync(path, 'r')
      try {
        const size = fstatSync(fd).size
        if (this.cursor === null) {
          this.cursor = Math.max(0, size - this.startupTailBytes)
        }
        if (size < this.cursor) this.cursor = 0
        if (size <= this.cursor) return ''

        const from = Math.max(this.cursor, size - this.readMaxBytes)
        const buf = Buffer.alloc(size - from)
        const read = readSync(fd, buf, 0, buf.length, from)
        const chunk = buf.subarray(0, read).toString('utf8')

        const lastNewline = chunk.lastIndexOf('\n')
        if (lastNewline === -1) {
          // Nothing complete yet. Advancing to `from` costs nothing when it is
          // the cursor already and stops a capped read repeating itself.
          this.cursor = from
          return ''
        }
        const complete = chunk.slice(0, lastNewline + 1)
        this.cursor = from + Buffer.byteLength(complete, 'utf8')
        return complete
      } finally {
        closeSync(fd)
      }
    } catch {
      return ''
    }
  }
}
