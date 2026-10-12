/**
 * lib/claude-binary.mjs and bin/hoai-select-claude.mjs: which `claude` an
 * always-on install may bake (board row 84296679, kc-server, 2026-10-12).
 *
 * A stale /usr/local/bin/claude 2.1.22 led the watcher's service PATH, the
 * keep-alive reinstall baked it, and five agents crash-looped about 420 times
 * because that CLI answers `error: unknown option
 * '--dangerously-load-development-channels'` and exits 1.
 *
 * The rule is a CAPABILITY, not a version number: the exact binary is asked.
 * Real stand-in executables are used, so the probe really spawns a process.
 *
 * Run: npm test, or npx tsx --test test/claude-binary.test.ts
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEV_CHANNELS_FLAG,
  chooseClaude,
  claudeCandidates,
  classifyFlagProbe,
  describeSkipped,
  parseClaudeVersion,
  probeClaude,
} from '../lib/claude-binary.mjs'
import { main as selectMain } from '../bin/hoai-select-claude.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'

/** A stand-in claude: `--version` prints `version`; the bare flag prints `flagOutput` and exits `flagStatus`. */
function standIn(dir: string, version: string, kind: 'good' | 'stale' | 'odd'): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'claude')
  const flagLine =
    kind === 'good'
      ? `echo "error: option '${DEV_CHANNELS_FLAG} <servers...>' argument missing" >&2; exit 1`
      : kind === 'stale'
        ? `echo "error: unknown option '${DEV_CHANNELS_FLAG}'" >&2; exit 1`
        : 'exit 0'
  writeFileSync(
    path,
    `#!/bin/sh\ncase "$1" in\n  --version) echo "${version} (Claude Code)" ;;\n  *) ${flagLine} ;;\nesac\n`,
  )
  chmodSync(path, 0o755)
  return path
}

test('classifyFlagProbe: unknown option is unsupported, a missing argument is supported, anything else is unknown', () => {
  assert.equal(classifyFlagProbe({ status: 1, stderr: `error: unknown option '${DEV_CHANNELS_FLAG}'` }), 'unsupported')
  assert.equal(
    classifyFlagProbe({ status: 1, stderr: `error: option '${DEV_CHANNELS_FLAG} <servers...>' argument missing` }),
    'supported',
  )
  assert.equal(classifyFlagProbe({ status: 0, stdout: '', stderr: '' }), 'unknown')
  assert.equal(classifyFlagProbe({ status: 1, stderr: 'segmentation fault' }), 'unknown')
})

test('parseClaudeVersion reads the number out of the CLI banner', () => {
  assert.equal(parseClaudeVersion('2.1.296 (Claude Code)'), '2.1.296')
  assert.equal(parseClaudeVersion('2.1.22\n'), '2.1.22')
  assert.equal(parseClaudeVersion('no number here'), '')
})

test('probeClaude spawns the real binary and reads its version and capability', { skip: isWin }, () => {
  const root = mkdtempSync(join(tmpdir(), 'hoai-claude-'))
  const good = standIn(join(root, 'good'), '2.1.296', 'good')
  const stale = standIn(join(root, 'stale'), '2.1.22', 'stale')
  assert.deepEqual(
    (({ version, flag }) => ({ version, flag }))(probeClaude(good)),
    { version: '2.1.296', flag: 'supported' },
  )
  assert.deepEqual(
    (({ version, flag }) => ({ version, flag }))(probeClaude(stale)),
    { version: '2.1.22', flag: 'unsupported' },
  )
})

test('claudeCandidates: ~/.local/bin first, then PATH in order, one entry per real file', { skip: isWin }, () => {
  const root = mkdtempSync(join(tmpdir(), 'hoai-claude-'))
  const home = join(root, 'home')
  const native = standIn(join(home, '.local', 'bin'), '2.1.296', 'good')
  const sys = standIn(join(root, 'usr-local-bin'), '2.1.22', 'stale')
  const alias = join(root, 'alias')
  mkdirSync(alias)
  symlinkSync(native, join(alias, 'claude'))
  const list = claudeCandidates({ pathVar: [dirname(sys), alias, '/nonexistent'].join(':'), home })
  assert.deepEqual(list, [native, sys], 'the symlink to the native one is the same file and is listed once')
})

test('chooseClaude: the stale one FIRST on PATH is stepped over and named, the native one is chosen', { skip: isWin }, () => {
  const root = mkdtempSync(join(tmpdir(), 'hoai-claude-'))
  const home = join(root, 'home')
  const native = standIn(join(home, '.local', 'bin'), '2.1.296', 'good')
  const stale = standIn(join(root, 'usr-local-bin'), '2.1.22', 'stale')
  // The watcher's service PATH: the system dir leads, exactly as on kc-server.
  const chosen = chooseClaude({ pathVar: `${dirname(stale)}:${dirname(native)}`, home })
  assert.equal(chosen.ok, true)
  if (!chosen.ok) return
  assert.equal(chosen.path, native)
  assert.equal(chosen.version, '2.1.296')
  assert.deepEqual(
    chosen.skipped.map((s) => [s.path, s.version]),
    [], // ~/.local/bin is tried first, so nothing had to be stepped over
  )
})

test('chooseClaude: when ONLY a stale claude exists it is refused by name, never baked', { skip: isWin }, () => {
  const root = mkdtempSync(join(tmpdir(), 'hoai-claude-'))
  const stale = standIn(join(root, 'usr-local-bin'), '2.1.22', 'stale')
  const chosen = chooseClaude({ pathVar: dirname(stale), home: join(root, 'nohome') })
  assert.equal(chosen.ok, false)
  if (chosen.ok) return
  assert.equal(chosen.reason, 'none-supports-flag')
  assert.equal(chosen.skipped[0]!.path, stale)
  assert.match(describeSkipped(chosen.skipped[0]!), /2\.1\.22 does not know --dangerously-load-development-channels/)
})

test('chooseClaude: an unreadable wording is accepted, so a changed CLI can never lock an install out', { skip: isWin }, () => {
  const root = mkdtempSync(join(tmpdir(), 'hoai-claude-'))
  const odd = standIn(join(root, 'bin'), '9.9.9', 'odd')
  const chosen = chooseClaude({ pathVar: dirname(odd), home: join(root, 'nohome') })
  assert.equal(chosen.ok, true)
  if (chosen.ok) assert.equal(chosen.flag, 'unknown')
})

test('chooseClaude: no claude at all is its own named refusal', () => {
  const chosen = chooseClaude({ candidates: [] })
  assert.deepEqual(chosen, { ok: false, reason: 'no-claude', skipped: [] })
})

test('hoai-select-claude prints one machine line and names what it skipped on stderr', () => {
  const out: string[] = []
  const err: string[] = []
  const code = selectMain({
    choose: () => ({
      ok: true,
      path: '/home/kc/.local/bin/claude',
      version: '2.1.296',
      flag: 'supported',
      skipped: [{ path: '/usr/local/bin/claude', version: '2.1.22', flag: 'unsupported', detail: 'error: unknown option' }],
    }),
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
  })
  assert.equal(code, 0)
  assert.deepEqual(out, ['HOAI_CLAUDE_OK\t/home/kc/.local/bin/claude\t2.1.296\n'])
  assert.match(err.join(''), /skipping \/usr\/local\/bin\/claude 2\.1\.22 does not know/)
})

test('hoai-select-claude refuses with exit 1 and a named reason when every claude is stale', () => {
  const out: string[] = []
  const code = selectMain({
    choose: () => ({
      ok: false,
      reason: 'none-supports-flag',
      skipped: [{ path: '/usr/local/bin/claude', version: '2.1.22', flag: 'unsupported', detail: '' }],
    }),
    write: (s) => out.push(s),
    writeErr: () => {},
  })
  assert.equal(code, 1)
  assert.match(out.join(''), /^HOAI_CLAUDE_REFUSED\tnone-supports-flag\tevery claude found \(\/usr\/local\/bin\/claude 2\.1\.22\) is too old/)
})

test('the CLI runs for real and answers with one of the two protocol lines', { skip: isWin }, () => {
  const root = mkdtempSync(join(tmpdir(), 'hoai-claude-'))
  const stale = standIn(join(root, 'bin'), '2.1.22', 'stale')
  const res = spawnSync(process.execPath, [join(repoRoot, 'bin', 'hoai-select-claude.mjs')], {
    encoding: 'utf8',
    env: { PATH: dirname(stale), HOME: join(root, 'nohome') },
  })
  assert.equal(res.status, 1)
  assert.match(res.stdout, /^HOAI_CLAUDE_REFUSED\tnone-supports-flag\t/)
  assert.match(res.stderr, /skipping .*2\.1\.22 does not know --dangerously-load-development-channels/)
})
