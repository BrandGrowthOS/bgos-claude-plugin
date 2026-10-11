/**
 * Board bbbf3438, second half: four more bin scripts decided "am I the entry
 * point?" with a URL compare that does not resolve symlinks. Node resolves a
 * module's own URL to its real path but leaves argv[1] as the caller wrote it,
 * so a launch through an aliased path (/Users/fitecho is /Users/bgos on KC's
 * Mac) made main() silently never run: exit 0, no output, nothing done.
 *
 * Each case runs the REAL script as a child process, once by its real path
 * and once through a symlinked checkout, and asserts the same observable
 * effect. The effects are chosen so that a skipped main() looks different:
 *   hoai-hook                 writes the event spool line
 *   bgos-claim                prints its usage
 *   bgos-daemon-wrapper       refuses a relative install target (exit 2)
 *   hoai-private-turn-hook    refuses a prompt it cannot record (exit 2)
 *
 * Run: npx tsx --test test/entry-guard.symlink.test.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { floorKey, floorStateRoot, sessionFolders } from '../lib/floor-state.mjs'
import { privateMarkerPath } from '../lib/private-turn.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function aliasOfRepo(): string {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'entry-alias-')))
  const alias = join(scratch, 'alias')
  symlinkSync(repoRoot, alias)
  return alias
}

function run(script: string, root: string, args: string[], input: string, env: Record<string, string>) {
  return spawnSync(process.execPath, [join(root, 'bin', script), ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(full))
    else out.push(full)
  }
  return out
}

for (const [label, rootOf] of [
  ['real path', () => repoRoot],
  ['symlinked checkout', aliasOfRepo],
] as const) {
  test(`hoai-hook spools the event (${label})`, () => {
    const home = mkdtempSync(join(tmpdir(), 'entry-hook-'))
    const res = run(
      'hoai-hook.mjs',
      rootOf(),
      [],
      JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }),
      { HOME: home, USERPROFILE: home },
    )
    assert.equal(res.status, 0)
    assert.ok(
      filesUnder(home).some((f) => f.endsWith('events.jsonl')),
      'an events.jsonl spool line was written',
    )
  })

  test(`bgos-claim prints its usage (${label})`, () => {
    const res = run('bgos-claim.mjs', rootOf(), ['--help'], '', {})
    assert.equal(res.status, 0)
    assert.match(res.stdout, /bgos-claim/)
  })

  test(`bgos-daemon-wrapper refuses a relative install target (${label})`, () => {
    const res = run('bgos-daemon-wrapper.mjs', rootOf(), ['--install', 'relative/target.mjs'], '', {})
    assert.equal(res.status, 2)
    assert.match(res.stderr, /absolute path/)
  })

  test(`hoai-private-turn-hook refuses a prompt it cannot record (${label})`, () => {
    const state = mkdtempSync(join(tmpdir(), 'entry-private-'))
    const cwd = mkdtempSync(join(tmpdir(), 'entry-cwd-'))
    const env = { BGOS_PLUGIN_STATE_DIR: state, HOME: state, USERPROFILE: state }
    // A managed agent has a private-turn marker for its folder; with one in
    // place, a prompt that has no session id must be refused, not ignored.
    const payload = { hook_event_name: 'UserPromptSubmit', cwd, prompt: 'hello' }
    const root = floorStateRoot(env)
    const key = sessionFolders(payload, env).map(floorKey)[0]!
    const marker = privateMarkerPath(root, key)
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, JSON.stringify({ schemaVersion: 1 }))
    const res = run('hoai-private-turn-hook.mjs', rootOf(), [], JSON.stringify(payload), env)
    assert.equal(res.status, 2, res.stderr)
    assert.match(res.stderr, /could not establish the private tool turn/)
  })
}
