/**
 * The real bin/win32-limit-screen.ps1 against a FAKE console: a hidden console holding a small node
 * program that prints Claude Code's usage limit picker and records every key byte it receives. Never
 * a real claude and never a real agent: that program is the only thing the helper attaches to.
 * Windows only (console API through PowerShell 5.1); skipped elsewhere.
 *
 * What it proves on a real console: `read` returns the visible screen and its sha256, and that text
 * passes the strict limit screen rules (lib/limit-screen.mjs readLimitScreen); `press` with that hash
 * sends exactly ONE Enter (one CR byte, nothing else); `press` with any other hash sends nothing; a
 * bad argument sends nothing.
 *
 * Run: npx tsx --test test/win32-limit-screen.console.test.ts
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readLimitScreen } from '../lib/limit-screen.mjs'
import { win32LimitHelperArgs } from '../lib/limit-keys.mjs'

const skip = process.platform !== 'win32' ? 'the helper drives the Windows console API' : false
const HELPER = fileURLToPath(new URL('../bin/win32-limit-screen.ps1', import.meta.url))

const PICKER = (pointer: string) =>
  [
    "  ⎿  You've hit your weekly limit · resets Nov 6, 8pm (Asia/Dubai)",
    '',
    '╭──────────────────────────────────────────────────╮',
    '│ What do you want to do?                          │',
    '│                                                  │',
    `│ ${pointer} 1. Stop and wait for limit to reset            │`,
    '│   2. Add funds to continue with usage credits    │',
    '│                                                  │',
    '│ Enter to confirm · Esc to cancel                 │',
    '╰──────────────────────────────────────────────────╯',
  ].join('\n')

// Prints the screen it is given, then records every byte of input as hex, one chunk per line.
const FAKE_PICKER = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const [screenFile, keysFile] = process.argv.slice(2)
writeFileSync(keysFile, '')
process.stdout.write(readFileSync(screenFile, 'utf8') + '\\n')
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on('data', (chunk) => appendFileSync(keysFile, Buffer.from(chunk).toString('hex') + '\\n'))
setTimeout(() => process.exit(3), 90_000)
`

const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`

function startFakePicker(dir: string, screen: string): { pid: number; keys: string } {
  const script = join(dir, 'fake-picker.mjs')
  const screenFile = join(dir, 'screen.txt')
  const keys = join(dir, 'keys.txt')
  writeFileSync(script, FAKE_PICKER)
  writeFileSync(screenFile, screen)
  const argList = [script, screenFile, keys].map((a) => psQuote(`"${a}"`)).join(',')
  const ps = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `$p = Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ${argList} -WindowStyle Hidden -PassThru; $p.Id`],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
  )
  const pid = Number(String(ps.stdout).trim())
  assert.ok(Number.isInteger(pid) && pid > 0, `the fake picker started (${ps.stderr})`)
  return { pid, keys }
}

function runHelper(args: string[] | null): Promise<{ code: number | null; stdout: string; stderr: string }> {
  assert.ok(args, 'the helper arguments were built')
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Read until the fake has painted its screen (it starts in a fresh console). */
async function readWhenPainted(pid: number): Promise<{ hash: string; text: string }> {
  const deadline = Date.now() + 30_000
  let last = ''
  while (Date.now() < deadline) {
    const out = await runHelper(win32LimitHelperArgs({ helper: HELPER, consolePid: pid, mode: 'read' }))
    last = `${out.code} ${out.stdout} ${out.stderr}`
    const m = /^HOAI-SCREEN ([0-9a-f]{64}) ([A-Za-z0-9+/=]*)\r?$/m.exec(out.stdout)
    if (out.code === 0 && m) {
      const text = Buffer.from(m[2]!, 'base64').toString('utf8')
      if (text.includes('Enter to confirm')) return { hash: m[1]!, text }
    }
    await sleep(300)
  }
  throw new Error(`the screen never painted: ${last.slice(0, 400)}`)
}

const keysOf = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [])

function stop(pid: number) {
  try {
    process.kill(pid)
  } catch {
    // already gone
  }
}

test('read: the visible screen and its sha256; the text passes the strict limit screen rules', { skip, timeout: 120_000 }, async () => {
  for (const pointer of ['❯', '>']) {
    const dir = mkdtempSync(join(tmpdir(), 'hoai-limit-console-'))
    const fake = startFakePicker(dir, PICKER(pointer))
    try {
      const { hash, text } = await readWhenPainted(fake.pid)
      assert.equal(hash, createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'), 'the hash is of the text returned')
      assert.equal(readLimitScreen(text).ok, true, `${pointer}: ${readLimitScreen(text).reason}\n${text}`)
      assert.deepEqual(keysOf(fake.keys), [], 'a read sends nothing')
    } finally {
      stop(fake.pid)
    }
  }
})

test('press with the approved hash: exactly ONE Enter (one CR byte) reaches the console', { skip, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hoai-limit-console-'))
  const fake = startFakePicker(dir, PICKER('❯'))
  try {
    const { hash } = await readWhenPainted(fake.pid)
    const out = await runHelper(win32LimitHelperArgs({ helper: HELPER, consolePid: fake.pid, mode: 'press', expectHash: hash }))
    assert.equal(out.code, 0, out.stderr)
    await sleep(1500)
    assert.deepEqual(keysOf(fake.keys), ['0d'])
  } finally {
    stop(fake.pid)
  }
})

test('press with any other hash (the screen changed since it was approved): nothing is sent, exit 7', { skip, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hoai-limit-console-'))
  const fake = startFakePicker(dir, PICKER('❯'))
  try {
    await readWhenPainted(fake.pid)
    const out = await runHelper(win32LimitHelperArgs({ helper: HELPER, consolePid: fake.pid, mode: 'press', expectHash: 'a'.repeat(64) }))
    assert.equal(out.code, 7, out.stderr)
    await sleep(1500)
    assert.deepEqual(keysOf(fake.keys), [])
  } finally {
    stop(fake.pid)
  }
})

test('a bad argument (a pid with letters, an unknown mode, a hash that is not one) sends nothing and fails', { skip, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hoai-limit-console-'))
  const fake = startFakePicker(dir, PICKER('❯'))
  try {
    const { hash } = await readWhenPainted(fake.pid)
    const base = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER]
    for (const args of [
      [...base, '-ConsolePid', `${fake.pid}x`, '-Mode', 'press', '-ExpectHash', hash],
      [...base, '-ConsolePid', String(fake.pid), '-Mode', 'type', '-ExpectHash', hash],
      [...base, '-ConsolePid', String(fake.pid), '-Mode', 'press', '-ExpectHash', 'hello'],
      [...base, '-ConsolePid', String(fake.pid), '-Mode', 'press'],
    ]) {
      const out = await runHelper(args)
      assert.notEqual(out.code, 0, args.join(' '))
    }
    await sleep(1500)
    assert.deepEqual(keysOf(fake.keys), [])
  } finally {
    stop(fake.pid)
  }
})

test('a console that is gone: read fails with exit 2, nothing to press', { skip, timeout: 60_000 }, async () => {
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true })
  const out = await runHelper(win32LimitHelperArgs({ helper: HELPER, consolePid: Number(dead.stdout), mode: 'read' }))
  assert.equal(out.code, 2, out.stdout + out.stderr)
  assert.doesNotMatch(out.stdout, /HOAI-SCREEN/)
})
