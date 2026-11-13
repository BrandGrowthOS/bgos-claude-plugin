/**
 * Windows' home lookup on a Mac, for test/attach-scope.test.ts. No Windows process runs.
 *
 * On Windows os.homedir() reads USERPROFILE and ignores HOME. A process without
 * USERPROFILE gets the account's real profile. This preload gives every node
 * child that test starts the same rule, with an empty decoy folder standing in
 * for the real profile, so nothing here reads this machine's home.
 *
 * Use: node --import tsx --import ./docs/evidence/2026-11-04-wintest2/win32-homedir.mjs \
 *        --test-reporter=tap test/attach-scope.test.ts
 */
import childProcess from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import { join } from 'node:path'

const decoy = mkdtempSync(join(os.tmpdir(), 'win32-real-profile-'))
const childShim = `data:text/javascript,${encodeURIComponent(`
  import os from 'node:os'
  import { syncBuiltinESMExports } from 'node:module'
  os.homedir = () => process.env.USERPROFILE ?? ${JSON.stringify(decoy)}
  syncBuiltinESMExports()
`)}`

const realSpawnSync = childProcess.spawnSync
childProcess.spawnSync = (command, args, options) => (command === process.execPath
  ? realSpawnSync(command, ['--import', childShim, ...args], options)
  : realSpawnSync(command, args, options))
syncBuiltinESMExports()
