/**
 * lib/always-on-grace.ts, and the one place server.ts must consult it.
 *
 * Found by review, 2026-09-22: desktop one-click installs the supervisor FIRST
 * and records alwaysOn:true only AFTER it has seen the agent connect, and a new
 * assistant's flag defaults to false. So the supervised session's own daemon
 * booted, read "off" with a supervisor installed, and ran `bgos-agent
 * uninstall` on the job it was running in. The agent connected, the panel said
 * Connected, and the agent was gone.
 *
 * Run: npm test, or npx tsx --test test/always-on-grace.test.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { alwaysOnGraceRemainingMs, ALWAYS_ON_INSTALL_GRACE_MS, ALWAYS_ON_INSTALLED_AT_FILE } from '../lib/always-on-grace.ts'

const NOW = 1_790_000_000_000
const stamp = (msAgo: number) => String(Math.floor((NOW - msAgo) / 1000))

test('a supervisor installed moments ago has grace, one older than the grace has none', () => {
  assert.ok(alwaysOnGraceRemainingMs(stamp(5_000), NOW) > ALWAYS_ON_INSTALL_GRACE_MS - 7_000)
  assert.ok(alwaysOnGraceRemainingMs(stamp(ALWAYS_ON_INSTALL_GRACE_MS - 60_000), NOW) > 0)
  assert.equal(alwaysOnGraceRemainingMs(stamp(ALWAYS_ON_INSTALL_GRACE_MS + 1_000), NOW), 0)
  assert.equal(alwaysOnGraceRemainingMs(stamp(3 * 24 * 3600_000), NOW), 0)
})

test('the guard fails CLOSED: no stamp, junk, or a stamp from the future is no grace, so a real "off" is still honoured', () => {
  for (const bad of [null, undefined, '', 'soon', '12', '-5', '1790000000.5', String(Math.floor(NOW / 1000) + 3600), '{"at":1}']) {
    assert.equal(alwaysOnGraceRemainingMs(bad as string | null | undefined, NOW), 0, JSON.stringify(bad))
  }
  // trailing newline, as `date +%s > file` writes it
  assert.ok(alwaysOnGraceRemainingMs(`${stamp(1000)}\n`, NOW) > 0)
})

test('server.ts consults the grace in the UNINSTALL branch, before removing anything, and the installer stamps the same file name', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const server = readFileSync(join(root, 'server.ts'), 'utf8')
  const branch = server.slice(server.indexOf('} else if (!desired && installed) {'), server.indexOf("log('always-on: supervisor removed')"))
  assert.ok(branch.length > 0, 'the uninstall branch must exist')
  assert.ok(branch.indexOf('alwaysOnGraceRemainingMs(') > 0, 'the grace must be read in this branch')
  assert.ok(branch.indexOf('alwaysOnGraceRemainingMs(') < branch.indexOf("['uninstall'"), 'and BEFORE the uninstall is spawned')
  assert.match(branch, /if \(graceLeft > 0\) \{[\s\S]*?return\s*\n\s*\}/, 'a supervisor still in its grace is left alone')
  assert.match(branch, /ALWAYS_ON_INSTALLED_AT_FILE/)
  const agent = readFileSync(join(root, 'bin', 'bgos-agent'), 'utf8')
  assert.ok(agent.includes(`date +%s > "$statedir/${ALWAYS_ON_INSTALLED_AT_FILE}"`), 'bin/bgos-agent must stamp the file the daemon reads')
})

test('the Always-on toggle installs the supervisor for the folder the OPERATOR launched from, never for the daemon own cwd', () => {
  // bin/bgos-launch.mjs relocates a marketplace daemon's cwd to the plugin cache
  // root and hands the real folder over as BGOS_LAUNCH_CWD. `--dir process.cwd()`
  // therefore asked for a supervisor inside the plugin cache, which carries no
  // pin and is refused, so the toggle could never work for a marketplace agent.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const server = readFileSync(join(root, 'server.ts'), 'utf8')
  const start = server.indexOf('async function reconcileAlwaysOn()')
  const reconcile = server.slice(start, server.indexOf("log('always-on: supervisor installed", start))
  const code = reconcile.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
  assert.match(code, /\['install', '--assistant', ASSISTANT_ID, '--dir', LAUNCH_CWD, '--always-on', '--no-clone'\]/)
  assert.doesNotMatch(code, /'--dir', process\.cwd\(\)/)
  // and LAUNCH_CWD still falls back to the daemon's own cwd, which is what keeps a CLONE daemon exactly as it was
  assert.match(server, /const LAUNCH_CWD = process\.env\.BGOS_LAUNCH_CWD\?\.trim\(\) \|\| process\.cwd\(\)/)
})
