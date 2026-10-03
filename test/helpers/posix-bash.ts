/**
 * A POSIX bash that can read THIS checkout, for the tests that parse or run the repo's bash.
 *
 * On macOS and Linux that is `bash` on PATH. On Windows a bare `bash` is very often the WSL
 * launcher (C:\Windows\System32\bash.exe), because Git for Windows puts only Git\cmd on PATH by
 * default. The launcher runs another OS's bash in another filesystem and re-parses its argv
 * through a Linux shell, so it cannot open E:\... at all (the backslashes are eaten), and any
 * answer it gives describes the launcher, not the script. Git for Windows' own bash can, and it
 * is the one Claude Code itself uses on Windows, so that is what is resolved here. The launcher
 * is never used, and paths go to bash in forward slash form (bashPath), because bash treats a
 * command name as a path only when it contains '/'.
 *
 * Where no usable bash exists the tests SKIP with a reason, and fail instead when
 * HOAI_REQUIRE_BASH=1 (CI sets it), so a missing bash can never read as a green run.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 as win32Path } from 'node:path'
import type { TestContext } from 'node:test'

/** The WSL launchers Windows can put on PATH under the name bash.exe. */
export function isWslLauncher(path: string): boolean {
  return /[\\/](System32|Sysnative|WindowsApps)[\\/]bash\.exe$/i.test(path)
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv
  platform?: string
  exists?: (path: string) => boolean
  /** `git --exec-path` (<Git>/mingw64/libexec/git-core); null when git is absent. */
  gitExecPath?: string | null
  /** Does a bare `bash` run on this machine (posix only)? */
  bareBashRuns?: () => boolean
}

function defaultGitExecPath(): string | null {
  const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true })
  return git.status === 0 ? git.stdout.trim() : null
}

/** Every place a Windows run looks for Git for Windows' bash, in order. */
export function windowsBashCandidates(env: NodeJS.ProcessEnv, gitExecPath: string | null): string[] {
  const out: string[] = []
  for (const v of [env.HOAI_TEST_BASH, env.CLAUDE_CODE_GIT_BASH_PATH]) {
    if (v && v.trim()) out.push(v.trim())
  }
  // <Git>\mingw64\libexec\git-core -> <Git>\bin\bash.exe, the wrapper that puts /usr/bin on PATH.
  if (gitExecPath) out.push(win32Path.join(gitExecPath, '..', '..', '..', 'bin', 'bash.exe'))
  for (const root of [env.ProgramFiles, env.ProgramW6432, env.LOCALAPPDATA && win32Path.join(env.LOCALAPPDATA, 'Programs')]) {
    if (root) out.push(win32Path.join(root, 'Git', 'bin', 'bash.exe'))
  }
  return out
}

/** The bash to use, or null when this machine has none that can read the checkout. */
export function resolvePosixBash(opts: ResolveOptions = {}): string | null {
  const platform = opts.platform ?? process.platform
  if (platform !== 'win32') {
    const runs = opts.bareBashRuns ?? (() => spawnSync('bash', ['-c', 'exit 0']).status === 0)
    return runs() ? 'bash' : null
  }
  const env = opts.env ?? process.env
  const exists = opts.exists ?? existsSync
  const gitExecPath = opts.gitExecPath !== undefined ? opts.gitExecPath : defaultGitExecPath()
  return windowsBashCandidates(env, gitExecPath).find((p) => !isWslLauncher(p) && exists(p)) ?? null
}

/** A path as bash on this OS takes it: C:/x/y on Windows, unchanged elsewhere. */
export function bashPath(path: string): string {
  return process.platform === 'win32' ? path.replace(/\\/g, '/') : path
}

const NO_BASH =
  'no POSIX bash that can read this checkout: on Windows install Git for Windows (the Git Bash ' +
  'Claude Code itself uses) or set HOAI_TEST_BASH; the WSL launcher is never used'

/** The bash for this test, or null after skipping it (a failure when HOAI_REQUIRE_BASH=1). */
export function bashOrSkip(t: TestContext): string | null {
  const bash = resolvePosixBash()
  if (bash) return bash
  assert.notEqual(process.env.HOAI_REQUIRE_BASH, '1', `HOAI_REQUIRE_BASH=1 but there is ${NO_BASH}`)
  t.skip(NO_BASH)
  return null
}

/**
 * `bash -n` on a file, with a negative control first: a deliberately broken file must fail with
 * status 2 (a syntax error). A 126 or 127 means this bash could not open or run the path at all,
 * which would otherwise pass as "parses" the moment someone forgets to check the status.
 */
export function assertBashParses(bash: string, file: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'hoai-bash-ctl-'))
  const broken = join(dir, 'broken.sh')
  writeFileSync(broken, 'if true; then\n')
  const control = spawnSync(bash, ['-n', bashPath(broken)], { encoding: 'utf8', windowsHide: true })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(
    control.status,
    2,
    `this bash cannot parse a file at this path form, so a parse result would mean nothing: ${control.status} ${control.stderr}`,
  )
  const check = spawnSync(bash, ['-n', bashPath(file)], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
  assert.equal(check.status, 0, `bash -n errors: ${check.stdout} ${check.stderr}`)
}
