/**
 * claudeProjectCwd under bun (plugin 0.67.4).
 *
 * The daemon runs on bun (bin/bgos-launch.mjs starts server.ts with it), and
 * Claude Code is a bun build that names its session folder with the plain
 * `realpathSync` of `fs`. So the folder rule has to hold in this runtime, not
 * only under node: a link resolves, an 8.3 short name and the drive letter stay
 * as spelled (`.native` would expand both, and a name that differs from the
 * CLI's is the bug), a folder that cannot be resolved stays as given. The
 * node:test twin with the hooks and the intake is
 * test/private-turn-linked-folder.test.ts.
 */
import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeProjectCwd } from '../lib/session-binding.ts'

const win = process.platform === 'win32'
const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function scratch(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('a folder reached through a link resolves to the real folder; a plain or missing folder stays as given', () => {
  const root = scratch('hoai-linked-bun-')
  const real = join(root, 'agents', 'vera')
  mkdirSync(real, { recursive: true })
  // A junction on Windows (no privilege needed), a symlink elsewhere.
  symlinkSync(join(root, 'agents'), join(root, 'hoai-agents'), 'junction')
  cleanups.push(() => {
    try { unlinkSync(join(root, 'hoai-agents')) } catch { /* already gone */ }
  })
  expect(claudeProjectCwd(join(root, 'hoai-agents', 'vera'))).toBe(real)
  expect(claudeProjectCwd(real)).toBe(real)
  const missing = join(root, 'not-created', 'vera')
  expect(existsSync(missing)).toBe(false)
  expect(claudeProjectCwd(missing)).toBe(missing)
})

test.skipIf(!win)('an 8.3 short name and the drive letter stay as spelled (Windows)', () => {
  const root = scratch('hoai-short-bun-')
  const long = join(root, 'LongFolderName', 'vera')
  mkdirSync(long, { recursive: true })
  const lowerDrive = long.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
  expect(lowerDrive).not.toBe(long)
  expect(claudeProjectCwd(lowerDrive)).toBe(lowerDrive)
  // No quote inside the command: a runtime would escape one as \", which cmd does not read.
  if (/[\s"]/.test(long)) return
  const shortName = spawnSync('cmd.exe', ['/d', '/s', '/c', `for %I in (${long}) do @echo %~sI`], { encoding: 'utf8', windowsHide: true }).stdout.trim()
  // 8.3 names can be off on a volume; then there is nothing more to hold.
  if (!shortName || shortName === long || !existsSync(shortName)) return
  expect(shortName).toContain('~')
  expect(claudeProjectCwd(shortName)).toBe(shortName)
})
