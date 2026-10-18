/**
 * The two Windows relaunch fixes against REAL processes and a REAL console, with a FAKE claude
 * (HOAI board row 978da5db). Never a real claude: PATH is cut down to a temporary folder holding
 * an npm style `claude.cmd` shim whose cli.js is a small node program, plus node and System32.
 * Windows only; skipped elsewhere.
 *
 *   1. hoai starts an npm installed claude as `cmd.exe /c claude.cmd`. node's kill() of that child
 *      is TerminateProcess on cmd.exe alone: the real claude (node running cli.js) is not in libuv's
 *      kill-on-close job (it breaks away silently) and runs on. endWin32ProcessTree (taskkill /T /F)
 *      ends it too.
 *   2. A killed claude leaves its last screen on the console the next launch shares. The real gate
 *      helper, started for the next launch, pressed Enter on a gate left there. clearWin32Console,
 *      what hoai writes before a relaunch, leaves the helper nothing to press on.
 *
 * Run: npx tsx --test test/win32-relaunch.console.test.ts
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as core from '../bin/hoai-core.mjs'

const { spawnClaude, win32GateHelperArgs } = core
const fixed = core as unknown as { endWin32ProcessTree?: (pid: number, opts?: object) => boolean }
const skip = process.platform !== 'win32' ? 'Windows processes and the Windows console' : false
const BIN_DIR = fileURLToPath(new URL('../bin/', import.meta.url)).replace(/[\\/]+$/, '')
const CORE_URL = pathToFileURL(fileURLToPath(new URL('../bin/hoai-core.mjs', import.meta.url))).href

/** cmd-shim's template, what `npm install -g @anthropic-ai/claude-code` writes as claude.cmd. */
const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  '',
].join('\r\n')

/** The fake claude: records its pid, then waits (as a session does) until something ends it. */
const FAKE_CLI = `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.FAKE_CLAUDE_PID_FILE, String(process.pid))
setInterval(() => {}, 1000)
setTimeout(() => process.exit(7), 120_000)
`

function npmInstall(dir: string) {
  const pkg = join(dir, 'node_modules', '@anthropic-ai', 'claude-code')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'cli.js'), FAKE_CLI)
  writeFileSync(join(pkg, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(dir, 'claude.cmd'), NPM_SHIM)
}

/** PATH with the fake npm folder, node, and System32: never a real claude. */
function shimEnv(dir: string, pidFile: string): Record<string, string> {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(path|BGOS_.*|HOAI_.*)$/i.test(k)) env[k] = v
  env.PATH = [dir, dirname(process.execPath), join(root, 'System32'), root].join(';')
  env.FAKE_CLAUDE_PID_FILE = pidFile
  return env
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return check()
}

/** Start the fake claude the way hoai does (spawnClaude, the npm shim candidate). */
async function launchThroughShim(): Promise<{ cmd: import('node:child_process').ChildProcess; claudePid: number; exited: Promise<number> }> {
  const dir = mkdtempSync(join(tmpdir(), 'hoai-shim-'))
  npmInstall(dir)
  const pidFile = join(dir, 'fake-claude.pid')
  const env = shimEnv(dir, pidFile)
  let cmd: import('node:child_process').ChildProcess | null = null
  const exited = spawnClaude(['--dangerously-skip-permissions'], {
    platform: 'win32',
    env,
    childEnv: env,
    writeErr: () => {},
    onSpawn: (child: import('node:child_process').ChildProcess) => {
      cmd = child
    },
  } as never) as Promise<number>
  assert.equal(await until(() => existsSync(pidFile), 30_000), true, 'the fake claude started through claude.cmd')
  const claudePid = Number(readFileSync(pidFile, 'utf8'))
  assert.ok(cmd, 'spawnClaude handed back the child it started')
  return { cmd: cmd!, claudePid, exited }
}

test('the npm shim shape for real: hoai s child is cmd.exe, and the fake claude is a different process under it', { skip, timeout: 120_000 }, async () => {
  const { cmd, claudePid, exited } = await launchThroughShim()
  try {
    assert.notEqual(cmd.pid, claudePid)
    assert.equal(alive(claudePid), true)
  } finally {
    spawnSync('taskkill.exe', ['/PID', String(cmd.pid), '/T', '/F'], { windowsHide: true })
    await exited
  }
})

test('control: kill() of the shim child (main before this fix) ends cmd.exe and leaves the fake claude running', { skip, timeout: 120_000 }, async () => {
  const { cmd, claudePid, exited } = await launchThroughShim()
  try {
    cmd.kill()
    await exited
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.equal(alive(claudePid), true, 'the real claude outlived its shim: the bug')
  } finally {
    // Ours: started above, through our own shim, and checked alive just before.
    if (alive(claudePid)) process.kill(claudePid)
  }
})

test('endWin32ProcessTree ends the fake claude under the shim, not just cmd.exe', { skip, timeout: 120_000 }, async () => {
  assert.equal(typeof fixed.endWin32ProcessTree, 'function')
  const { cmd, claudePid, exited } = await launchThroughShim()
  try {
    assert.equal(fixed.endWin32ProcessTree!(cmd.pid!), true)
    await exited
    assert.equal(await until(() => !alive(claudePid), 10_000), true, 'the fake claude is gone with its shim')
  } finally {
    // Only when the assertion above failed: ours, still alive.
    if (alive(claudePid)) process.kill(claudePid)
  }
})

// -- the console a killed claude leaves behind -------------------------------------------------------

/** A console host: it starts a fake claude that draws the gate (in the alternate screen when asked,
 *  as Claude Code's TUI does), kills it, then clears the console the way hoai does before a relaunch
 *  (or not), and waits there for the gate helper. */
const HOST = `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const [coreUrl, ready, mode, screen] = process.argv.slice(2)
const draw = (screen === 'alt' ? 'process.stdout.write("\\\\x1b[?1049h");' : '') +
  'process.stdout.write("WARNING: Loading development channels\\\\n\\\\n  1. I am using this for local development\\\\n  2. Exit\\\\n"); setInterval(() => {}, 1000)'
const claude = spawn(process.execPath, ['-e', draw], { stdio: 'inherit' })
await new Promise((resolve) => setTimeout(resolve, 2000))
claude.kill()
await new Promise((resolve) => claude.on('exit', resolve))
if (mode === 'clear') {
  const core = await import(coreUrl)
  core.clearWin32Console(process.stdout)
}
writeFileSync(ready, String(process.pid))
setInterval(() => {}, 1000)
setTimeout(() => process.exit(0), 90_000)
`

const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`

/** The host in a hidden console of its own (Start-Process, as the agent task's wscript gives hoai one). */
async function startHost(mode: 'clear' | 'none', screen: 'alt' | 'main'): Promise<{ pid: number; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'hoai-stale-gate-'))
  const script = join(dir, 'host.mjs')
  const ready = join(dir, 'ready')
  writeFileSync(script, HOST)
  const argList = [script, CORE_URL, ready, mode, screen].map((a) => psQuote(`"${a}"`)).join(',')
  const ps = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `$p = Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ${argList} -WindowStyle Hidden -PassThru; $p.Id`],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
  )
  const started = Number(String(ps.stdout).trim())
  assert.ok(Number.isInteger(started) && started > 0, `the host started (${ps.stderr})`)
  assert.equal(await until(() => existsSync(ready), 30_000), true, 'the host drew, killed and (maybe) cleared')
  return { pid: Number(readFileSync(ready, 'utf8')), dir }
}

function runHelper(consolePid: number, logFile: string, timeoutSeconds: number): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', win32GateHelperArgs({ scriptDir: BIN_DIR, consolePid, timeoutSeconds, logFile }), {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('exit', (code) => resolve(code))
  })
}

const words = (logFile: string) =>
  readFileSync(logFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.replace(/^\S+ pid=\d+ /, '').split(' ')[0])

for (const screen of ['alt', 'main'] as const) {
  test(`control (${screen} screen): with nothing cleared, the next helper presses Enter on the killed claudes gate`, { skip, timeout: 120_000 }, async () => {
    const host = await startHost('none', screen)
    const log = join(host.dir, 'helper.log')
    try {
      assert.equal(await runHelper(host.pid, log, 8), 0, words(log).join(','))
      assert.deepEqual(words(log), ['start', 'attached', 'accepted'], 'an Enter for a prompt no live claude is showing')
    } finally {
      if (alive(host.pid)) process.kill(host.pid)
    }
  })

  test(`after clearWin32Console (${screen} screen), the next helper finds no gate and presses nothing`, { skip, timeout: 120_000 }, async () => {
    const host = await startHost('clear', screen)
    const log = join(host.dir, 'helper.log')
    try {
      assert.equal(await runHelper(host.pid, log, 8), 4, words(log).join(','))
      assert.deepEqual(words(log), ['start', 'attached', 'timeout'])
    } finally {
      if (alive(host.pid)) process.kill(host.pid)
    }
  })
}
