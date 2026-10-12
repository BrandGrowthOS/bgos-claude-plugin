/**
 * `bgos-agent update` pulls with `git reset --hard`, which REPLACES the script
 * that is running. The shell had already read the old function bodies, so the
 * rest of the update (the hook registration 0.67.2 added, the restart) ran as
 * it was before the pull: on KC's Mac the first update to 0.67.2 registered
 * nothing and a second run did (board bbbf3438 follow-up, 2026-10-12).
 *
 * This runs the REAL bin/bgos-agent against a local bare "origin": the checkout
 * starts with the current script, origin holds the same script with one extra
 * line that only the NEW file has. The line is printed at the end of
 * cmd_update. If the update does not hand over to the new file after the pull,
 * that line never prints.
 *
 * Run: npx tsx --test test/bgos-agent.update-reexec.test.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolvePosixBash } from './helpers/posix-bash.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASH = process.platform === 'win32' ? null : resolvePosixBash()
const probe = (script: string) => (BASH ? spawnSync(BASH, ['-c', script], { encoding: 'utf8' }) : null)
const hasGit = probe('command -v git')?.status === 0
const hasNode = probe('command -v node')?.status === 0
const SKIP = BASH && hasGit && hasNode ? false : 'needs bash, git and node'

const NEW_MARKER = 'NEW-SCRIPT-RAN-THE-REST-OF-UPDATE'

function sh(cwd: string, cmd: string, env: Record<string, string> = {}) {
  const res = spawnSync(BASH!, ['-c', cmd], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(res.status, 0, `${cmd}\n${res.stdout}\n${res.stderr}`)
  return res.stdout
}

/** A checkout whose origin has a newer commit that carries the NEW script. */
function fixture(scriptForCheckout: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'reexec-')))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const stubs = join(root, 'stubs')
  mkdirSync(stubs)
  // bun: `-e <script> <args>` is node's `-e` with the same argv shape; anything else is a no-op
  // (bun install, running the daemon wrapper), because there is no network and no daemon here.
  writeFileSync(
    join(stubs, 'bun'),
    '#!/bin/bash\nif [ "$1" = "-e" ]; then shift; s="$1"; shift; exec node -e "$s" -- "$@"; fi\nexit 0\n',
  )
  chmodSync(join(stubs, 'bun'), 0o755)

  const work = join(root, 'work')
  mkdirSync(join(work, 'bin'), { recursive: true })
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'hoai', version: '1.0.0' }))
  writeFileSync(join(work, 'bin', 'bgos-daemon-wrapper.mjs'), '// stub\n')
  const git = (c: string) => sh(work, `git ${c}`, { HOME: home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })
  git('init -q -b main')
  writeFileSync(join(work, 'bin', 'bgos-agent'), scriptForCheckout)
  chmodSync(join(work, 'bin', 'bgos-agent'), 0o755)
  git('add -A')
  git('commit -q -m v1')
  const origin = join(root, 'origin.git')
  sh(root, `git clone -q --bare "${work}" "${origin}"`, { HOME: home })
  git(`remote add origin "${origin}"`)
  git('fetch -q origin main')
  git('branch -q --set-upstream-to=origin/main main')

  // origin moves on: a new version, and the NEW script with a line only it has.
  const next = join(root, 'next')
  sh(root, `git clone -q "${origin}" "${next}"`, { HOME: home })
  const newScript = readFileSync(join(repoRoot, 'bin', 'bgos-agent'), 'utf8').replace(
    '\n  if [ "$installed" -eq 0 ]; then\n',
    `\n  echo "${NEW_MARKER}"\n  if [ "$installed" -eq 0 ]; then\n`,
  )
  assert.ok(newScript.includes(NEW_MARKER), 'the marker was injected into cmd_update')
  writeFileSync(join(next, 'bin', 'bgos-agent'), newScript)
  writeFileSync(join(next, 'package.json'), JSON.stringify({ name: 'hoai', version: '2.0.0' }))
  const gitNext = (c: string) => sh(next, `git ${c}`, { HOME: home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })
  gitNext('add -A')
  gitNext('commit -q -m v2')
  gitNext('push -q origin main')
  return { work, home, stubs }
}

function update(f: { work: string; home: string; stubs: string }) {
  return spawnSync(BASH!, [join(f.work, 'bin', 'bgos-agent'), 'update'], {
    cwd: f.work,
    encoding: 'utf8',
    env: { ...process.env, HOME: f.home, PATH: `${f.stubs}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: join(f.home, '.claude') },
  })
}

test('the rest of the update runs the NEW script, and the version message still names where it started', { skip: SKIP }, () => {
  const current = readFileSync(join(repoRoot, 'bin', 'bgos-agent'), 'utf8')
  const f = fixture(current)
  const res = update(f)
  const out = `${res.stdout}\n${res.stderr}`
  assert.equal(res.status, 0, out)
  assert.match(out, new RegExp(NEW_MARKER), 'a line only the new file has was printed')
  assert.match(out, /plugin updated: 1\.0\.0 -> 2\.0\.0/)
  assert.equal((out.match(/Fetching origin/g) ?? []).length, 1, 'the pull happens once')
})

test('the hand-over is not a loop: an update that is already the re-executed one does not exec again', { skip: SKIP }, () => {
  const current = readFileSync(join(repoRoot, 'bin', 'bgos-agent'), 'utf8')
  const f = fixture(current)
  const res = spawnSync(BASH!, [join(f.work, 'bin', 'bgos-agent'), 'update'], {
    cwd: f.work,
    encoding: 'utf8',
    env: { ...process.env, HOME: f.home, PATH: `${f.stubs}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: join(f.home, '.claude'), HOAI_UPDATE_REEXEC: '1', HOAI_UPDATE_FROM_VERSION: '0.9.0' },
  })
  const out = `${res.stdout}\n${res.stderr}`
  assert.equal(res.status, 0, out)
  assert.doesNotMatch(out, /Fetching origin/, 'the flag says the pull is done')
  assert.match(out, /0\.9\.0 -> 1\.0\.0/, 'the starting version comes from the environment')
})
