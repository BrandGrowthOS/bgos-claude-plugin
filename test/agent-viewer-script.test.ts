/**
 * bin/hoai-agent-viewer.ps1 + bin/hoai-agent-viewer.vbs: the Windows watch only viewer (board row
 * d133ddb2, Kc's choice 3). The viewer attaches to the agent's hidden console and READS its screen;
 * it can never type, never resize or close that console, never start or stop anything. These are
 * source pins, because the files run only on a real Windows desktop (the PC proof in the PR runs
 * them); the windows pass that starts them is pinned in test/agent-windows.test.ts.
 *
 * Run: npx tsx --test test/agent-viewer-script.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { WATCHER_BUNDLE_FILES } from '../lib/watcher-bundle.mjs'

const ps1 = readFileSync(new URL('../bin/hoai-agent-viewer.ps1', import.meta.url), 'utf8')
const vbs = readFileSync(new URL('../bin/hoai-agent-viewer.vbs', import.meta.url), 'utf8')
/** The source without comment lines, so a comment naming a forbidden call is not mistaken for one. */
const ps1Code = ps1
  .split('\n')
  .filter((line) => !/^\s*(#|\/\/)/.test(line))
  .join('\n')

test('viewer files: pure ASCII (PowerShell 5.1 and WSH read them as ANSI), LF only, shipped in the watcher bundle', () => {
  for (const [name, text] of [['ps1', ps1], ['vbs', vbs]] as const) {
    assert.deepEqual([...text].filter((ch) => ch.charCodeAt(0) > 0x7e), [], `${name} is ASCII`)
    assert.equal(text.includes('\r'), false, `${name} is LF only`)
  }
  assert.ok(WATCHER_BUNDLE_FILES.includes('bin/hoai-agent-viewer.ps1'))
  assert.ok(WATCHER_BUNDLE_FILES.includes('bin/hoai-agent-viewer.vbs'))
})

test('viewer ps1: watch only, nothing can reach the agent: no console input, no keys, no window messages, no console resize or close, no process or task control, no file writes', () => {
  const forbidden = [
    'WriteConsoleInput',
    'CONIN$',
    'SendKeys',
    'keybd_event',
    'SendInput',
    'PostMessage',
    'SendMessage',
    'GenerateConsoleCtrlEvent',
    'SetConsoleScreenBufferSize',
    'SetConsoleWindowInfo',
    'SetConsoleActiveScreenBuffer',
    'SetConsoleMode',
    'WriteConsoleOutput',
    'FillConsoleOutput',
    'Stop-Process',
    'taskkill',
    'schtasks',
    'ScheduledTask',
    'Start-Process',
    'Set-Content',
    'Add-Content',
    'Out-File',
    'New-Item',
    'Remove-Item',
    'WriteAllText',
  ]
  for (const name of forbidden) assert.equal(ps1Code.includes(name), false, `must not use ${name}`)
})

test('viewer ps1: digits only in, reads the screen through CONOUT$ with GENERIC_READ alone, and closes itself when the agent leaves the console', () => {
  assert.match(ps1, /\[ValidatePattern\('\^\\d\+\$'\)\]\[string\]\$ConsolePid/)
  assert.match(ps1, /\[ValidatePattern\('\^\\d\+\$'\)\]\[string\]\$AssistantId/)
  assert.match(ps1, /\[ValidateSet\('view', 'hide'\)\]\[string\]\$Mode = 'view'/)
  assert.match(ps1Code, /AttachConsole/)
  assert.match(ps1Code, /ReadConsoleOutputCharacterW/)
  assert.match(ps1Code, /GetConsoleScreenBufferInfo/)
  assert.match(ps1Code, /"CONOUT\$"/)
  // GENERIC_READ (0x80000000) and nothing else on the screen buffer handle.
  assert.match(ps1Code, /GENERIC_READ = 0x80000000/)
  assert.equal(/GENERIC_WRITE|0x40000000|0xC0000000|3221225472/.test(ps1Code), false, 'never a write handle')
  assert.match(ps1Code, /GetConsoleProcessList/, 'the agent left the console: the viewer closes, it never keeps a dead console alive')
  assert.match(ps1Code, /ReadOnly = true/)
  assert.match(ps1Code, /ShowWithoutActivation/, 'a new viewer never takes the keyboard from what the owner is typing in')
  assert.match(ps1, /Close this window any time: /)
  assert.match(ps1, /\(watch only\)/)
})

test('viewer ps1 hide mode: hides the agent console window (SW_HIDE) only when asked, never closes it; view mode never touches the agent console window', () => {
  const hide = ps1Code.slice(ps1Code.indexOf("if ($Mode -eq 'hide')"))
  assert.ok(ps1Code.includes("if ($Mode -eq 'hide')"), 'a hide branch')
  assert.match(hide, /ShowWindow\(\$console, 0\)/)
  // The only ShowWindow on the console window is in the hide branch, and it is SW_HIDE (0).
  const calls = [...ps1Code.matchAll(/ShowWindow\(\$console, (\d+)\)/g)].map((m) => m[1])
  assert.deepEqual(calls, ['0'])
  assert.equal(/DestroyWindow|CloseWindow|WM_CLOSE/.test(ps1Code), false)
})

test('viewer vbs: runs the ps1 beside it with window style 0 and does not wait; it forwards its (digits only) arguments and adds nothing else', () => {
  assert.match(vbs, /GetParentFolderName\(WScript\.ScriptFullName\)/)
  assert.match(vbs, /hoai-agent-viewer\.ps1/)
  assert.match(vbs, /For Each a In WScript\.Arguments/)
  assert.match(vbs, /, 0, False\n/)
  assert.match(vbs, /-STA/)
  assert.equal(/, [1-9], /.test(vbs), false, 'never a visible window style')
})
