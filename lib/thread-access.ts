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
 * restart. A file that is missing, not JSON, or silent about the setting
 * reads as on: it is the owner's own agent on the owner's own computer, and
 * only an explicit `false` takes the access away. A thread a share recipient
 * opens is confined whatever this says (threadAccess).
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

const OFF = ['false', '0', 'off', 'no']
const ON = ['true', '1', 'on', 'yes']

/** `threads.fullAccess`: the environment first, then the agent's settings file, else on. */
export function threadsFullAccess(input: {
  env: Record<string, string | undefined>
  /** The agent's settings file as text; throws or answers null when there is none. */
  readSettings(): string | null
}): boolean {
  const raw = input.env[THREADS_FULL_ACCESS_ENV]?.trim().toLowerCase() ?? ''
  if (OFF.includes(raw)) return false
  if (ON.includes(raw)) return true
  let text: string | null = null
  try {
    text = input.readSettings()
  } catch {
    return true
  }
  if (typeof text !== 'string' || text.trim() === '') return true
  try {
    const parsed = JSON.parse(text) as { threads?: { fullAccess?: unknown } } | null
    return parsed?.threads?.fullAccess !== false
  } catch {
    return true
  }
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
