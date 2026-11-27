/**
 * WHAT A LANE FOLDER MOVE OWES AFTER IT (fix round 377, finding 7, and its
 * re-review). openLaneFolders (lib/lane-core.mjs) moves an earlier version's
 * lane folder, named by the id, under its key. Two things follow it, and both
 * callers that open a lane's folders run them here, the supervisor at a wake
 * and the owner's sweep on its drain tick:
 *   - the Claude project folders of the old working folder, and of every
 *     folder under it (its threads), move to the new one's names, so
 *     `--resume` finds the session the lane pinned;
 *   - the lane's saved thread state, which names the old folders, is set
 *     aside, so each thread forks afresh from the moved session.
 *
 * openLaneFolders writes the owed marker (LANE_CARRY_OWED_FILE) before it
 * moves anything, and it is removed only once both are done. A move that
 * failed half way is finished at the next open of the folders, whoever opens
 * them and whatever openLaneFolders answers then.
 */
import { join } from 'node:path'

import { openLaneFolders } from './lane-core.mjs'
import { mungeSessionCwd } from '../bin/hoai-core.mjs'

/**
 * The Claude project folders of `fromWorkDir`, and of every folder under it,
 * moved to `toWorkDir`'s names in each config tree the lane's Claude may use.
 * A name already taken at the new path is left as it is. Returns how many moved.
 *
 * @param {{ fs: any, home: string, fromWorkDir: string, toWorkDir: string, configDirs: string[] }} input
 */
export function moveLaneTranscripts({ fs, home, fromWorkDir, toWorkDir, configDirs }) {
  const from = mungeSessionCwd(fromWorkDir)
  const to = mungeSessionCwd(toWorkDir)
  let moved = 0
  for (const base of [...new Set(configDirs.map((d) => String(d ?? '').trim()))]) {
    // Where sessionTranscriptPath files every project: the config tree's own, else ~/.claude.
    const projects = join(base || join(home, '.claude'), 'projects')
    let names = []
    try { names = fs.readdirSync(projects).map(String) } catch { continue }
    for (const name of names) {
      if (name !== from && !name.startsWith(`${from}-`)) continue
      const target = join(projects, `${to}${name.slice(from.length)}`)
      if (fs.existsSync(target)) continue
      fs.renameSync(join(projects, name), target)
      moved += 1
    }
  }
  return moved
}

/**
 * Open a person's lane folders (openLaneFolders), then do whatever a move of
 * them still owes. Throws when either step fails; the marker then stays, so
 * the next open tries the owed work again.
 *
 * @param {{ paths: any, userId: string, fs: any, home: string, ownerConfigDir?: string | null,
 *   now?: () => number, platform?: string }} input
 * @returns {{ opened: 'existing' | 'new' | 'migrated' | 'quarantined', carried: number | null }}
 *   carried: how many project folders moved, or null when nothing was owed
 */
export function openLaneFoldersCarried({ paths, userId, fs, home, ownerConfigDir = '', now = Date.now, platform = process.platform }) {
  const { opened } = openLaneFolders({ paths, userId, fs, now, platform })
  if (!fs.existsSync(paths.carryOwedPath)) return { opened, carried: null }
  const carried = moveLaneTranscripts({
    fs,
    home,
    fromWorkDir: join(paths.legacyLaneDir, 'work'),
    toWorkDir: paths.workDir,
    configDirs: [paths.configDir, ownerConfigDir ?? ''],
  })
  const threadState = join(paths.stateDir, 'threads')
  if (fs.existsSync(threadState)) {
    const aside = join(paths.lanesStateDir, '.quarantine')
    fs.mkdirSync(aside, { recursive: true, mode: 0o700 })
    fs.renameSync(threadState, join(aside, `${paths.laneKey}-threads-${now()}`))
  }
  fs.unlinkSync(paths.carryOwedPath)
  return { opened, carried }
}
