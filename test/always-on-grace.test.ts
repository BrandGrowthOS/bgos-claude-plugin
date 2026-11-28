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
import { INSTALL_GRACE_MS, INSTALLED_AT_FILE_NAME } from '../lib/agent-kept.mjs'

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

test('server.ts decides through lib/agent-kept.mjs before it installs or removes anything: the grace is that decision\'s, only for an install never seen kept, and the installer stamps the same file name', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const server = readFileSync(join(root, 'server.ts'), 'utf8')
  const start = server.indexOf('async function reconcileAlwaysOn(')
  const body = server.slice(start, server.indexOf('\n// ── Startup', start))
  const decideAt = body.indexOf('decideKeptSupervisor(')
  assert.ok(start > 0 && decideAt > 0, 'the kept decision drives the reconcile')
  assert.ok(decideAt < body.indexOf("['install'"), 'before any install is spawned')
  assert.ok(decideAt < body.indexOf('releasePosixSupervisor('), 'and before any removal')
  // What it reads: this install's stamp, whether this install was seen kept, and the computer's switch.
  assert.match(body, /INSTALLED_AT_FILE_NAME/)
  assert.match(body, /KEPT_SEEN_FILE_NAME/)
  assert.match(body, /keepAliveStandingFromCache\(/)
  const graceAt = body.indexOf("if (kept.action === 'grace') {")
  const grace = body.slice(graceAt, body.indexOf("if (kept.action === 'remove') {", graceAt))
  assert.ok(graceAt > 0 && grace.length > 0, 'the grace branch, before the removal')
  assert.match(grace, /\n\s*return\s*\n\s*\}\s*$/, 'an install inside its grace is left alone: the branch returns')
  assert.equal(ALWAYS_ON_INSTALLED_AT_FILE, INSTALLED_AT_FILE_NAME)
  assert.equal(ALWAYS_ON_INSTALL_GRACE_MS, INSTALL_GRACE_MS)
  const agent = readFileSync(join(root, 'bin', 'bgos-agent'), 'utf8')
  assert.ok(agent.includes(`date +%s > "$statedir/${ALWAYS_ON_INSTALLED_AT_FILE}"`), 'bin/bgos-agent must stamp the file the daemon reads')
})
