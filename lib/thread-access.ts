/**
 * The owner's setting `threads.fullAccess` (0.88.0), and what a closed thread
 * leaves on disk.
 *
 * FULL ACCESS. A thread the agent's owner opens is a true fork with the
 * agent's own access (lib/thread-lane-args.ts threadFullArgs). It is ON by
 * default. The owner turns it off for one agent in that agent's own settings
 * file on its computer:
 *
 *   ~/.bgos-agent/<assistant id>/settings.json   {"threads": {"fullAccess": false}}
 *
 * or for one daemon with HOAI_THREADS_FULL_ACCESS=false in its environment
 * (the variable wins over the file). Off, the owner's threads run confined
 * as before 0.88.0. It is read at every thread start, so a change needs no
 * restart. On is the default, so a file that is not there, is empty, or says
 * nothing about the setting reads as on. But a setting somebody WROTE and
 * this code cannot read is never read as on, because the owner may have
 * meant off: a file that is there and cannot be read or is not a JSON object,
 * a `fullAccess` that is anything but `true`, and a variable with a value
 * that is neither a yes nor a no all read as off, and the owner's threads
 * run confined. A thread a share recipient opens is confined whatever this
 * says (threadAccess).
 *
 * Erasable TypeScript only. No em or en dashes in this file.
 */

import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const THREADS_FULL_ACCESS_ENV = 'HOAI_THREADS_FULL_ACCESS'
export const AGENT_SETTINGS_FILE = 'settings.json'

/** Where one agent's own settings live: <agent state dir>/settings.json. */
export function agentSettingsPath(agentStateDir: string): string {
  return join(agentStateDir, AGENT_SETTINGS_FILE)
}

/** The values of the variable that say yes. Any other value written there, `false` and `0` included, is a no. */
const ON = ['true', '1', 'on', 'yes']

/** `threads.fullAccess`: the environment first, then the agent's settings file, else on. */
export function threadsFullAccess(input: {
  env: Record<string, string | undefined>
  /** The agent's settings file as text; throws or answers null when there is none. */
  readSettings(): string | null
}): boolean {
  const raw = input.env[THREADS_FULL_ACCESS_ENV]?.trim().toLowerCase() ?? ''
  if (ON.includes(raw)) return true
  // A no, and anything else that was written there: never a yes.
  if (raw !== '') return false
  let text: string | null = null
  try {
    text = input.readSettings()
  } catch (err) {
    // No such file is the default; a file that is there and cannot be read is not.
    return (err as { code?: unknown } | null)?.code === 'ENOENT'
  }
  if (text === null || text === undefined) return true
  if (typeof text !== 'string') return false
  if (text.trim() === '') return true
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const threads = (parsed as { threads?: unknown }).threads
  if (threads === undefined) return true
  if (!threads || typeof threads !== 'object' || Array.isArray(threads)) return false
  const value = (threads as { fullAccess?: unknown }).fullAccess
  return value === undefined || value === true
}

/**
 * The bytes a file or a whole folder holds on disk (its own size, links not
 * followed), 0 when it is not there. Asynchronous and one entry at a time: a
 * thread's worktree can hold a hundred thousand files, and the daemon's only
 * thread must not stop for them. An entry that cannot be read counts as 0.
 */
export async function diskUsage(path: string): Promise<number> {
  let info
  try {
    info = await lstat(path)
  } catch {
    return 0
  }
  if (!info.isDirectory()) return info.size
  let total = 0
  let names: string[] = []
  try {
    names = await readdir(path)
  } catch {
    return 0
  }
  for (const name of names) total += await diskUsage(join(path, name))
  return total
}
