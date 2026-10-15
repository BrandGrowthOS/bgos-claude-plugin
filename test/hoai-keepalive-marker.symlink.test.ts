/**
 * Board bbbf3438: a connector update reported agent_deaf_after_update for an
 * agent it never restarted. The keepalive launcher (run.sh) calls
 * bin/hoai-keepalive-marker.mjs through an ALIASED path (/Users/fitecho is the
 * same directory as /Users/bgos). The script's main-guard compared the
 * module's resolved URL with the alias in argv[1], so main() never ran: exit 0,
 * no output, keepalive.json never refreshed, and the update had no live
 * session to restart.
 *
 * This runs the REAL script as a child process through a symlinked checkout
 * and asserts the marker file is written, which is the only thing the
 * launcher needs.
 *
 * Run: npx tsx --test test/hoai-keepalive-marker.symlink.test.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { linkFolder } from './helpers/links.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function runMarker(scriptPath: string, home: string) {
  return spawnSync(
    process.execPath,
    [scriptPath, '--assistant', '1050', '--keepalive-pid', '4242', '--claude-pid', '4343'],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' },
  )
}

test('the marker is written when the script is run through its real path', () => {
  const home = mkdtempSync(join(tmpdir(), 'kamark-real-'))
  const res = runMarker(join(repoRoot, 'bin', 'hoai-keepalive-marker.mjs'), home)
  assert.equal(res.status, 0)
  const file = join(home, '.bgos-agent', '1050', 'keepalive.json')
  assert.ok(existsSync(file), 'keepalive.json written')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).claudePid, 4343)
})

test('the marker is written when the script is run through a symlinked checkout', () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'kamark-link-')))
  const alias = join(scratch, 'alias')
  linkFolder(repoRoot, alias)
  const home = mkdtempSync(join(tmpdir(), 'kamark-home-'))
  const res = runMarker(join(alias, 'bin', 'hoai-keepalive-marker.mjs'), home)
  assert.equal(res.status, 0)
  const file = join(home, '.bgos-agent', '1050', 'keepalive.json')
  assert.ok(existsSync(file), 'keepalive.json written through the alias')
  const body = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(body.pid, 4242)
  assert.equal(body.claudePid, 4343)
  assert.ok(res.stdout.trim().endsWith('keepalive.json'), 'prints the path it wrote')
})
