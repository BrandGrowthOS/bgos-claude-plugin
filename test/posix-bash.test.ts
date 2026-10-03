/**
 * The bash the suite hands its bash scripts to (test/helpers/posix-bash.ts).
 *
 * Nine tests parse or run bin/bgos-agent and bin/hoai-bootstrap.sh. On a Windows box whose PATH
 * resolves `bash` to the WSL launcher they all went red with "No such file or directory", which
 * read like nine broken scripts. The scripts were fine; the launcher cannot open a Windows path.
 * These cases pin the resolver: the launcher is never chosen, Git for Windows' bash is, and on
 * this machine the bash chosen really is a POSIX bash that can open this checkout.
 *
 * Run: npm test, or npx tsx --test test/posix-bash.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { bashOrSkip, bashPath, isWslLauncher, resolvePosixBash, windowsBashCandidates } from './helpers/posix-bash.ts'

const GIT_EXEC = 'C:\\Program Files\\Git\\mingw64\\libexec\\git-core'
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const WSL = 'C:\\Windows\\System32\\bash.exe'

test('the WSL launchers are recognised under every name Windows gives them', () => {
  for (const p of [WSL, 'C:\\WINDOWS\\system32\\bash.exe', 'C:\\Windows\\Sysnative\\bash.exe', 'C:\\Users\\k\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe']) {
    assert.equal(isWslLauncher(p), true, p)
  }
  assert.equal(isWslLauncher(GIT_BASH), false)
  assert.equal(isWslLauncher('/usr/bin/bash'), false)
})

test('Windows resolves Git for Windows\' bash, found from git itself, ahead of the install folders', () => {
  const env = { ProgramFiles: 'D:\\Apps' }
  assert.deepEqual(windowsBashCandidates(env, GIT_EXEC), [GIT_BASH, 'D:\\Apps\\Git\\bin\\bash.exe'])
  assert.equal(resolvePosixBash({ platform: 'win32', env, gitExecPath: GIT_EXEC, exists: () => true }), GIT_BASH)
})

test('Windows never hands a script to the WSL launcher, even when it is named explicitly', () => {
  const env = { HOAI_TEST_BASH: WSL, ProgramFiles: 'C:\\Program Files' }
  assert.equal(resolvePosixBash({ platform: 'win32', env, gitExecPath: null, exists: () => true }), GIT_BASH)
  // With nothing but the launcher on the machine there is no bash at all: the tests skip.
  assert.equal(resolvePosixBash({ platform: 'win32', env: { HOAI_TEST_BASH: WSL }, gitExecPath: null, exists: () => true }), null)
})

test('an explicit HOAI_TEST_BASH that exists wins on Windows', () => {
  const env = { HOAI_TEST_BASH: 'E:\\tools\\msys64\\usr\\bin\\bash.exe', ProgramFiles: 'C:\\Program Files' }
  assert.equal(resolvePosixBash({ platform: 'win32', env, gitExecPath: GIT_EXEC, exists: () => true }), 'E:\\tools\\msys64\\usr\\bin\\bash.exe')
  assert.equal(
    resolvePosixBash({ platform: 'win32', env, gitExecPath: GIT_EXEC, exists: (p) => p !== env.HOAI_TEST_BASH }),
    GIT_BASH,
    'a configured path that does not exist falls through to the next candidate',
  )
})

test('off Windows the bash on PATH is used, and its absence is reported, not guessed', () => {
  assert.equal(resolvePosixBash({ platform: 'linux', bareBashRuns: () => true }), 'bash')
  assert.equal(resolvePosixBash({ platform: 'darwin', bareBashRuns: () => false }), null)
})

test('on this machine the resolved bash is a real POSIX bash that can open this checkout', (t) => {
  const bash = bashOrSkip(t)
  if (!bash) return
  const uname = spawnSync(bash, ['-c', 'uname -s'], { encoding: 'utf8', windowsHide: true })
  assert.equal(uname.status, 0, uname.stderr)
  if (process.platform === 'win32') {
    // Git for Windows reports MINGW64_NT-..., MSYS2 MSYS_NT-...; the WSL launcher would say Linux.
    assert.match(uname.stdout.trim(), /^(MINGW|MSYS|CYGWIN)/, `not Git for Windows' bash: ${uname.stdout}`)
  }
  const self = fileURLToPath(import.meta.url)
  const opened = spawnSync(bash, ['-c', 'test -f "$1"', 'probe', bashPath(self)], { encoding: 'utf8', windowsHide: true })
  assert.equal(opened.status, 0, `${bash} cannot open ${bashPath(self)}: ${opened.stderr}`)
})
