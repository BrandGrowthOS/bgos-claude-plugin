/**
 * The real bin/win32-accept-dev-channels.ps1 against a FAKE console (board row d806c69f).
 *
 * The console is a hidden one holding a small node program that prints the dev-channels gate's
 * marker text and waits for one Enter, the way Claude Code's gate does. Never a real claude: that
 * program is the only thing the helper attaches to. Windows only (console API through PowerShell
 * 5.1); skipped elsewhere.
 *
 * Agent 888's log (16 Oct 07:59Z, a cold start after logon) had `start` and `accepted` with no
 * `attached`: the 0.69.6 helper wrote with Add-Content, which PowerShell 5.1 refuses while any other
 * process has the file open for reading, the helper never knew, and it exited 0 all the same. Here a
 * reader holds the log the whole time: every line must still land. And a log that nothing can write
 * (held exclusively) must still get its Enter pressed, and exit 6, not 0.
 *
 * Run: npx tsx --test test/win32-gate-helper.console.test.ts
 */

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { win32GateHelperArgs } from '../bin/hoai-core.mjs'

const skip = process.platform !== 'win32' ? 'the helper drives the Windows console API' : false
const BIN_DIR = fileURLToPath(new URL('../bin/', import.meta.url)).replace(/[\\/]+$/, '')

const FAKE_GATE = `import { writeFileSync } from 'node:fs'
const result = process.argv[2]
process.stdout.write('WARNING: Loading development channels\\n\\n  1. I am using this for local development\\n  2. Exit\\n')
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on('data', (chunk) => {
  if (chunk.includes(13)) {
    writeFileSync(result, 'enter')
    process.exit(0)
  }
})
setTimeout(() => process.exit(3), 90_000)
`

const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`

/** A hidden console of its own (Start-Process, as the agent task's wscript gives hoai one), holding the fake gate. */
function startFakeGate(dir: string): { pid: number; result: string } {
  const script = join(dir, 'fake-gate.mjs')
  const result = join(dir, 'fake-gate.result')
  writeFileSync(script, FAKE_GATE)
  const argList = [script, result].map((a) => psQuote(`"${a}"`)).join(',')
  const ps = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `$p = Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ${argList} -WindowStyle Hidden -PassThru; $p.Id`],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
  )
  const pid = Number(String(ps.stdout).trim())
  assert.ok(Number.isInteger(pid) && pid > 0, `the fake gate started (${ps.stderr})`)
  return { pid, result }
}

function runHelper(consolePid: number, logFile: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', win32GateHelperArgs({ scriptDir: BIN_DIR, consolePid, timeoutSeconds: 60, logFile }), {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('exit', (code) => resolve({ code, stderr }))
  })
}

async function waitForFile(path: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return existsSync(path)
}

function stop(pid: number) {
  try {
    process.kill(pid)
  } catch {
    // Already gone: it exits by itself on the Enter.
  }
}

test('attached then accepted: the helper presses Enter once the gate is on screen, logs start, attached and accepted, and exits 0', { skip, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hoai-gate-console-'))
  const logFile = join(dir, 'win32-gate-helper.log')
  const gate = startFakeGate(dir)
  try {
    const { code, stderr } = await runHelper(gate.pid, logFile)
    assert.equal(code, 0, stderr)
    assert.equal(await waitForFile(gate.result, 10_000), true, 'the fake gate got its Enter')
    const lines = readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean)
    const words = lines.map((line) => line.replace(/^\S+ pid=\d+ /, '').split(' ')[0])
    assert.deepEqual(words, ['start', 'attached', 'accepted'], lines.join('\n'))
    assert.equal(new Set(lines.map((line) => /pid=(\d+)/.exec(line)?.[1])).size, 1, 'one helper wrote all three')
  } finally {
    stop(gate.pid)
  }
})

test('the 888 condition: another process holds the log open for reading the whole time, and every line still lands (start, attached, accepted, exit 0)', { skip, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hoai-gate-console-'))
  const logFile = join(dir, 'win32-gate-helper.log')
  writeFileSync(logFile, '')
  const reader = openSync(logFile, 'r')
  const gate = startFakeGate(dir)
  try {
    const { code, stderr } = await runHelper(gate.pid, logFile)
    assert.equal(await waitForFile(gate.result, 10_000), true, 'the fake gate got its Enter')
    assert.equal(code, 0, stderr.slice(0, 400))
    const lines = readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean)
    assert.deepEqual(lines.map((line) => line.replace(/^\S+ pid=\d+ /, '').split(' ')[0]), ['start', 'attached', 'accepted'], lines.join('\n'))
  } finally {
    closeSync(reader)
    stop(gate.pid)
  }
})

test('a log nothing can write (held exclusively): the helper still presses Enter, says why on stderr, and exits 6, not 0', { skip, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hoai-gate-console-'))
  const logFile = join(dir, 'win32-gate-helper.log')
  writeFileSync(logFile, '')
  // libuv's UV_FS_O_EXLOCK (share nothing), which node does not export by name.
  const exclusive = openSync(logFile, constants.O_RDWR | 0x10000000)
  const gate = startFakeGate(dir)
  try {
    const { code, stderr } = await runHelper(gate.pid, logFile)
    assert.equal(await waitForFile(gate.result, 10_000), true, 'the fake gate got its Enter')
    assert.equal(code, 6, `an Enter the log cannot show is not proven (stderr: ${stderr.slice(0, 400)})`)
    assert.match(stderr, /log write refused/)
    assert.doesNotMatch(stderr, /\b(attached|accepted)\b/, 'the fallback note never reads as a pass')
  } finally {
    closeSync(exclusive)
    stop(gate.pid)
  }
  assert.equal(readFileSync(logFile, 'utf8'), '')
})
