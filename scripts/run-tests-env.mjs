/**
 * The environment `npm test` hands every test family (scripts/run-tests.mjs).
 *
 * On macOS $TMPDIR (/var/folders/...) is a link into /private/var, and the browser profile code refuses a path
 * through a link on purpose, so on a stock Mac every browser profile test whose fixtures live under tmpdir() was
 * refused (45 failures) and two of them hung, while CI (Linux, a real /tmp) never saw it. So the folder is handed over
 * as its real path. Windows is left alone (its temp folder comes from TEMP and TMP), and a folder that cannot be
 * resolved is left as it is.
 */
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'

/**
 * @param {Record<string, string | undefined>} env the environment to adjust in place
 * @param {string} [platform]
 * @param {() => string} [currentTmpdir]
 */
export function useRealTmpdir(env, platform = process.platform, currentTmpdir = tmpdir) {
  if (platform === 'win32') return
  try {
    env.TMPDIR = realpathSync(currentTmpdir())
  } catch {}
}
