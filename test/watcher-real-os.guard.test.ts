/**
 * GUARD (board row afa70b0c): no test that drives the watcher loop reaches the real window or
 * process layer of the computer it runs on.
 *
 * runWatcher goes on to its windows pass (lib/agent-windows.mjs runWindowsPass) whenever a
 * heartbeat's self refresh does not end the process. On win32 that pass lists every process through
 * PowerShell (lib/process-tree.mjs listProcesses, through the deps' exec) and, with Show agent
 * windows off, ends every HOAI viewer it lists (deps.kill, whose default is process.kill).
 * test/watcher-self-refresh.test.ts ran its real files case with the real exec and no kill, so a
 * self refresh that failed there on a Windows PC listed the owner's real processes and closed all
 * their open viewer windows. Every worker skipped that file from 2026-10-15 for that reason.
 *
 * Three checks:
 *  1. static: every test file that drives the loop (calls runWatcher, or imports a test module that
 *     does) loads test/helpers/real-os-sentinel.ts as its FIRST import, so a real listing, signal or
 *     launch fails that file instead of acting;
 *  2. the sentinel refuses and records a real launch and a real signal before anything runs, proven
 *     on harmless targets only (a binary that does not exist, signal 0 to this test's parent), so a
 *     broken sentinel would still touch nothing;
 *  3. the self refresh harness itself (test/helpers/watcher-self-refresh-harness.ts, the very deps
 *     test/watcher-self-refresh.test.ts runs), driven through a FAILED self refresh, reaches the
 *     windows pass through the fake layer (test/helpers/fake-window-host.ts) only: the fake answers
 *     the listing, the fake's viewer is the one closed, and the sentinel saw nothing.
 */

import './helpers/real-os-sentinel.ts'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nodeExec, nodeSpawnDetached } from '../lib/watcher-bundle.mjs'
import { WIN32_PROCESS_SCRIPT } from '../lib/process-tree.mjs'
import { RealOsRefused, allowedRealChild, realOsSentinelInstalled, takeRealOsRefusals } from './helpers/real-os-sentinel.ts'
import { fakeWindowHost, viewerProcess } from './helpers/fake-window-host.ts'
import { WINDOWS, liveEntry, probesOf, realFilesRun, staleMachine, stateOf, watcherRun } from './helpers/watcher-self-refresh-harness.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
const repo = dirname(testDir)
const SENTINEL = join(testDir, 'helpers', 'real-os-sentinel.ts')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...tsFiles(path))
    else if (name.endsWith('.ts')) out.push(path)
  }
  return out
}

/** A call of runWatcher (not its name in a declaration a test writes into a fake bundle). */
const CALLS_LOOP = /(?<![\w$.]|function\s+)runWatcher\s*\(/
const IMPORT_RE = /^import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm

function relativeImports(path: string, source: string): string[] {
  return [...source.matchAll(IMPORT_RE)].map((m) => m[1]!).filter((s) => s.startsWith('.')).map((s) => resolve(dirname(path), s))
}

test('static: every test file that drives the watcher loop loads the real OS sentinel as its first import', () => {
  const sources = new Map(tsFiles(testDir).map((path) => [path, readFileSync(path, 'utf8')]))
  const drives = new Set([...sources].filter(([, source]) => CALLS_LOOP.test(source)).map(([path]) => path))
  // A file that imports a driver drives the loop through it (the self refresh test, through its harness).
  for (let grew = true; grew; ) {
    grew = false
    for (const [path, source] of sources) {
      if (!drives.has(path) && relativeImports(path, source).some((dep) => drives.has(dep))) {
        drives.add(path)
        grew = true
      }
    }
  }
  const names = [...drives].map((p) => relative(repo, p).replace(/\\/g, '/')).sort()
  // Never vacuous: the files this row is about are found as drivers.
  for (const expected of ['test/watcher-core.test.ts', 'test/watcher-self-refresh.test.ts', 'test/helpers/watcher-self-refresh-harness.ts']) {
    assert.equal(names.includes(expected), true, `${expected} is found as a driver of the watcher loop (found: ${names.join(', ')})`)
  }
  const unguarded = [...drives]
    .filter((path) => {
      const first = [...sources.get(path)!.matchAll(IMPORT_RE)][0]?.[1] ?? ''
      return !first.startsWith('.') || resolve(dirname(path), first) !== SENTINEL
    })
    .map((p) => relative(repo, p).replace(/\\/g, '/'))
    .sort()
  assert.deepEqual(unguarded, [], `these drive the watcher loop without the real OS sentinel as their first import: ${unguarded.join(', ')}`)
})

test('the sentinel refuses and records a real launch and a real signal before anything runs (harmless targets only)', async () => {
  assert.equal(realOsSentinelInstalled(), true)
  takeRealOsRefusals()
  // A binary that does not exist and a signal 0 (it only asks): a broken sentinel would still touch nothing.
  const missing = 'hoai-real-os-sentinel-no-such-tool.exe'
  // Through the production wrappers the watcher uses (lib/watcher-bundle.mjs, named imports).
  const res = await nodeExec()(missing, ['--list'])
  assert.equal(res.code, null)
  assert.match(String(res.error), /refused/)
  assert.throws(() => nodeSpawnDetached()(missing, ['--open']), RealOsRefused)
  assert.throws(() => process.kill(process.ppid, 0), RealOsRefused)
  // Through this file's own named imports.
  assert.throws(() => spawnSync(missing, ['--close']), RealOsRefused)
  assert.throws(() => execFileSync(missing, ['--close']), RealOsRefused)
  assert.deepEqual(
    takeRealOsRefusals().map((r) => r.api),
    ['child_process.execFile', 'child_process.spawn', 'process.kill', 'child_process.spawnSync', 'child_process.execFileSync'],
  )
  // Only the staged bundle probe (this node, a bin/hoai-watcher.mjs, help) and esbuild may start.
  assert.equal(allowedRealChild(process.execPath, [join('x', 'next', 'bin', 'hoai-watcher.mjs'), 'help']), true)
  assert.equal(allowedRealChild('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN32_PROCESS_SCRIPT]), false)
  assert.equal(allowedRealChild('wscript.exe', ['//B', 'run-hidden.vbs']), false)
  assert.equal(allowedRealChild(process.execPath, ['-e', 'process.exit(0)']), false)
})

test('the self refresh harness, its refresh failed on Windows, reaches the windows pass through the fake layer only (in-memory home)', async () => {
  const { fs } = await staleMachine(WINDOWS)
  const host = fakeWindowHost({ processes: [viewerProcess({ pid: 7001, assistantId: '912', consolePid: 6001 })] })
  const w = watcherRun(WINDOWS, fs, { probeCode: 1, host })
  assert.equal(await w.run(), 0, 'a failed refresh leaves the watcher up')
  assert.deepEqual(takeRealOsRefusals(), [], 'nothing reached the real window or process layer')
  assert.equal(stateOf(WINDOWS, fs).bundleRefresh?.outcome, 'watcher_refresh_failed:staged_bundle_unloadable', 'the self refresh failed')
  assert.equal(fs.readFile(liveEntry(WINDOWS)), '// bin/hoai-watcher.mjs 0.61.1\n', 'nothing was swapped')
  assert.deepEqual(host.listings, ['win32'], 'the windows pass listed processes, and the fake layer answered')
  // Show agent windows is off, so the pass closes every viewer it lists: here, only the fake one.
  assert.deepEqual(host.kills, [{ pid: 7001, signal: 'SIGTERM' }])
  assert.deepEqual(host.refused, [])
})

test('the real files run, its refresh failed, reaches the windows pass through the fake layer only (the win32 pass, on any host)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'watcher-real-os-guard-'))
  try {
    const host = fakeWindowHost({ processes: [viewerProcess({ pid: 7002, assistantId: '913', consolePid: 6002 })] })
    const run = await realFilesRun(repo, base, { platform: 'win32', probe: 'fails', host })
    assert.deepEqual(takeRealOsRefusals(), [], 'nothing reached the real window or process layer')
    assert.equal(run.code, 0, 'a failed refresh leaves the watcher up')
    assert.equal(readFileSync(join(run.live, 'bin', 'hoai-watcher.mjs'), 'utf8'), '// an old entry\n', 'nothing was swapped')
    assert.deepEqual(probesOf(run.execs.map(([file, ...args]) => ({ file, args }))), [{ file: process.execPath, args: [join(run.live, 'next', 'bin', 'hoai-watcher.mjs'), 'help'] }])
    assert.deepEqual(host.listings, ['win32'], 'the windows pass listed processes, and the fake layer answered')
    assert.deepEqual(host.kills, [{ pid: 7002, signal: 'SIGTERM' }])
    assert.deepEqual(host.refused, [])
    assert.deepEqual(run.spawns, [], 'no successor, no viewer')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
