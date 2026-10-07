/**
 * lib/win32-script-text.mjs: the ASCII-only string expressions every
 * generated Windows script uses (the watcher's run-hidden.vbs and
 * install-task.ps1, the agent task's run-agent.vbs and install-agent-task.ps1).
 * A leaf module: it imports nothing, so the watcher's service module can use
 * it without pulling agent-inventory into its import graph.
 *
 * Run: npx tsx --test test/win32-script-text.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { psString, vbsString } from '../lib/win32-script-text.mjs'
import * as agentTask from '../lib/agent-task-win32.mjs'

test('vbsString: an ASCII path is the plain literal it always was (a quote doubled); other units are ChrW(n), joined by &', () => {
  assert.equal(vbsString('C:\\Users\\kc'), '"C:\\Users\\kc"')
  assert.equal(vbsString('a"b'), '"a""b"')
  assert.equal(vbsString(''), '""')
  assert.equal(vbsString('Jos\u00e9\\x'), '"Jos" & ChrW(233) & "\\x"')
  // VBScript & is always string concatenation, so a leading ChrW needs nothing before it.
  assert.equal(vbsString('\u00e9'), 'ChrW(233)')
})

test('psString: an ASCII path is the plain literal; a [char] is never FIRST, because PowerShell adds a leading [char] to the next part as a number', () => {
  assert.equal(psString('C:\\Users\\kc'), "'C:\\Users\\kc'")
  assert.equal(psString("a'b"), "'a''b'")
  assert.equal(psString(''), "''")
  assert.equal(psString('Jos\u00e9\\x'), "('Jos' + [char]0x00E9 + '\\x')")
  // [char]0x00E9 + [char]0x0648 is an int in PowerShell, and so is a lone [char]
  // assigned where a path string is meant: an empty literal first makes every + a concatenation.
  assert.equal(psString('\u00e9\u0648'), "('' + [char]0x00E9 + [char]0x0648)")
  assert.equal(psString('\u00e9'), "('' + [char]0x00E9)")
  assert.equal(psString('\u00e9x'), "('' + [char]0x00E9 + 'x')")
})

test('the agent task keeps exporting the same functions (one implementation, shared)', () => {
  assert.equal(agentTask.vbsString, vbsString)
  assert.equal(agentTask.psString, psString)
})

test('win32-script-text is a leaf: it imports nothing, so the watcher service never pulls agent-inventory in through it', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'lib', 'win32-script-text.mjs'), 'utf8')
  assert.deepEqual([...source.matchAll(/(?:^|\n)\s*import\s|import\(/g)].map((m) => m[0]), [])
})
