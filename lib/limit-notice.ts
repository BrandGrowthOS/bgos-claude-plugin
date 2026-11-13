/**
 * The daemon's half of the limit watch (lib/watcher-limit.mjs): tell the owner, in plain words, that
 * the watcher freed this agent from Claude Code's usage limit screen, or why it could not.
 *
 * The watcher has no way to post into a chat; this daemon does. The watcher drops
 * ~/.bgos-agent/<id>/limit-notice.json with tokens and times only. Every few seconds the daemon reads
 * it, refuses it whole unless every field is one the watcher writes (lib/limit-screen.mjs
 * parseLimitNotice), builds the words from fixed templates (limitNoticeText), and posts them in the
 * owner's chat as a connection notice, the deaf warning's path. Nothing in the file ever reaches the
 * owner as text.
 *
 *   posted        the words went out; the file is taken
 *   duplicate     the same notice as the last one posted; taken, not posted again
 *   invalid       not a notice; taken (deleted), never posted
 *   post_failed   the post failed or threw; the file stays for a retry
 *   retry_later   inside a minute of a failed post
 *   none          no file
 */

import { LIMIT_NOTICE_FILE_NAME, limitNoticeText, parseLimitNotice } from './limit-screen.mjs'

export { LIMIT_NOTICE_FILE_NAME }
/** How often the daemon looks for a notice (the probe file's cadence). */
export const LIMIT_NOTICE_POLL_MS = 3_000
/** After a failed post, the next try is at least this far away. */
export const LIMIT_NOTICE_RETRY_MS = 60_000

export type LimitNoticeTick = { reason: 'none' | 'invalid' | 'duplicate' | 'posted' | 'post_failed' | 'retry_later' }

export function createLimitNoticeIntake(deps: {
  path: string
  readFile: (path: string) => string | null
  removeFile: (path: string) => void
  post: (text: string) => Promise<boolean>
  now: () => number
  log: (line: string) => void
}): { tick: () => Promise<LimitNoticeTick> } {
  let lastKey: string | null = null
  let lastFailAtMs: number | null = null
  const take = () => {
    try {
      deps.removeFile(deps.path)
    } catch {
      // already gone
    }
  }
  return {
    async tick() {
      let raw: string | null = null
      try {
        raw = deps.readFile(deps.path)
      } catch {
        raw = null
      }
      if (raw == null) return { reason: 'none' }
      const notice = parseLimitNotice(raw)
      if (!notice) {
        take()
        deps.log('limit notice: dropped a file that is not a limit notice')
        return { reason: 'invalid' }
      }
      if (notice.key === lastKey) {
        take()
        return { reason: 'duplicate' }
      }
      if (lastFailAtMs !== null && deps.now() - lastFailAtMs < LIMIT_NOTICE_RETRY_MS) return { reason: 'retry_later' }
      let ok = false
      try {
        ok = await deps.post(limitNoticeText(notice))
      } catch {
        ok = false
      }
      if (!ok) {
        lastFailAtMs = deps.now()
        deps.log(`limit notice: the post failed (${notice.outcome}); trying again in a minute`)
        return { reason: 'post_failed' }
      }
      lastFailAtMs = null
      lastKey = notice.key
      take()
      deps.log(`limit notice: told the owner (${notice.outcome}${notice.why ? `:${notice.why}` : ''})`)
      return { reason: 'posted' }
    },
  }
}
