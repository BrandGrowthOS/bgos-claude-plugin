/**
 * docs/evidence/2026-10-16-gate-attach/gate-proof.ps1, the read-only proof of one Windows agent's
 * start, run for real against FAKE files (HOAI board row 31583f86, the #246 review's Low 3).
 *
 * The gate log is shared by every agent of the Windows user. Without the agent's launcher pid
 * (no supervisor.json, no -ConsolePid) the script judged EVERY helper since -Since, and any one
 * PASS among them made the result: an old PASS (an earlier start, or another agent's helper)
 * outweighed the newest run's UNPROVEN. It now judges only the newest helper run since -Since (of the
 * agent's launcher when that is known, else of the whole log), and a pid that ran twice is two runs
 * (Windows reuses pids).
 *
 * Every file is fake and lives in a temporary USERPROFILE and TEMP: the script reads nothing else
 * and writes only its report into TEMP. Windows only (PowerShell 5.1, and pwsh when PWSH_EXE names
 * one); skipped elsewhere, where the source contract test below still runs.
 *
 * Run: npx tsx --test test/gate-proof.script.test.ts
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const SCRIPT = fileURLToPath(new URL('../docs/evidence/2026-10-16-gate-attach/gate-proof.ps1', import.meta.url))
const skip = process.platform !== 'win32' ? 'the proof script is PowerShell' : false
const ID = '9901'
const NOW = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()

/** The shells to run it with: Windows PowerShell 5.1 always, pwsh too when PWSH_EXE names one. */
const SHELLS = ['powershell.exe', ...(process.env.PWSH_EXE ? [process.env.PWSH_EXE] : [])]

interface Run {
  pid: number
  console: number
  at: number
  words: string[]
}

/** A fake USERPROFILE with the gate log, the daemon log (a boot) and a fresh channel beacon. */
function profile(runs: Run[], { supervisorPid = 0, bootAt = NOW - 60_000 }: { supervisorPid?: number; bootAt?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gate-proof-home-'))
  const temp = mkdtempSync(join(tmpdir(), 'gate-proof-temp-'))
  const logs = join(home, '.bgos-agent', 'logs')
  mkdirSync(logs, { recursive: true })
  mkdirSync(join(home, '.bgos-agent', ID), { recursive: true })
  mkdirSync(join(home, '.bgos-plugin-state', ID), { recursive: true })
  const lines: string[] = []
  for (const run of runs) {
    run.words.forEach((word, i) => {
      const text = word === 'start' ? `start console=${run.console} timeout=120` : word === 'unproven' ? 'unproven: the Enter was written but the log does not show it (attach line recorded: True)' : word
      lines.push(`${iso(run.at + i * 1000)} pid=${run.pid} ${text}`)
    })
  }
  writeFileSync(join(logs, 'win32-gate-helper.log'), `${lines.join('\r\n')}\r\n`)
  writeFileSync(join(logs, `bgos-plugin-${ID}.log`), `${iso(bootAt)} [bgos] Starting BGOS channel plugin\n`)
  writeFileSync(join(home, '.bgos-plugin-state', ID, 'channel-beacon.json'), `${JSON.stringify({ beaconAt: NOW - 5_000, pid: 7140 })}\n`)
  if (supervisorPid) writeFileSync(join(home, '.bgos-agent', ID, 'supervisor.json'), JSON.stringify({ pid: supervisorPid, capabilities: ['relaunch'] }))
  return { home, temp }
}

function prove(shell: string, p: { home: string; temp: string }, extra: string[] = []): { out: string; result: string } {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(BGOS_|HOAI_)/i.test(k)) env[k] = v
  Object.assign(env, { USERPROFILE: p.home, TEMP: p.temp, TMP: p.temp })
  const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Id', ID, '-Since', iso(NOW - 30 * 60_000), ...extra], {
    encoding: 'utf8',
    env,
    windowsHide: true,
    timeout: 60_000,
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  return { out, result: /RESULT: (\w+)/.exec(out)?.[1] ?? `none (exit ${r.status})` }
}

for (const shell of SHELLS) {
  test(`${shell}: no launcher pid, an old PASS then a newer UNPROVEN from another helper: only the newest run is judged, FAIL`, { skip, timeout: 120_000 }, () => {
    const p = profile([
      { pid: 4100, console: 2500, at: NOW - 20 * 60_000, words: ['start', 'attached', 'accepted'] },
      { pid: 4200, console: 2600, at: NOW - 2 * 60_000, words: ['start', 'attached', 'unproven'] },
    ], { bootAt: NOW - 20 * 60_000 + 30_000 })
    const { out, result } = prove(shell, p)
    assert.equal(result, 'FAIL', out)
    assert.match(out, /helper pid 4200 : UNPROVEN/, out)
    assert.doesNotMatch(out, /helper pid 4100 : PASS/, out)
    assert.match(out, /helper pid 4100 .*not judged/, out)
  })

  test(`${shell}: no launcher pid, ONE pid that ran twice (Windows reuses pids): an old PASS and a newer UNPROVEN are two runs, FAIL`, { skip, timeout: 120_000 }, () => {
    const p = profile([
      { pid: 4300, console: 2500, at: NOW - 20 * 60_000, words: ['start', 'attached', 'accepted'] },
      { pid: 4300, console: 2700, at: NOW - 2 * 60_000, words: ['start', 'attached', 'unproven'] },
    ], { bootAt: NOW - 20 * 60_000 + 30_000 })
    const { out, result } = prove(shell, p)
    assert.equal(result, 'FAIL', out)
    assert.match(out, /helper pid 4300 : UNPROVEN/, out)
  })

  test(`${shell}: no launcher pid, the newest run passed with its daemon boot and beacon: PASS`, { skip, timeout: 120_000 }, () => {
    const p = profile([
      { pid: 4400, console: 2500, at: NOW - 20 * 60_000, words: ['start', 'attached', 'unproven'] },
      { pid: 4500, console: 2600, at: NOW - 2 * 60_000, words: ['start', 'attached', 'accepted'] },
    ], { bootAt: NOW - 2 * 60_000 + 30_000 })
    const { out, result } = prove(shell, p)
    assert.equal(result, 'PASS', out)
    assert.match(out, /helper pid 4500 : PASS/, out)
  })

  test(`${shell}: the launcher pid known (supervisor.json): its own helpers are judged as before, another launcher's never`, { skip, timeout: 120_000 }, () => {
    const p = profile([
      { pid: 4600, console: 2500, at: NOW - 3 * 60_000, words: ['start', 'attached', 'accepted'] },
      { pid: 4700, console: 2600, at: NOW - 2 * 60_000, words: ['start', 'attached', 'unproven'] },
    ], { supervisorPid: 2500, bootAt: NOW - 3 * 60_000 + 30_000 })
    const { out, result } = prove(shell, p)
    assert.equal(result, 'PASS', out)
    assert.match(out, /helper pid 4700 : another launcher's \(console 2600\), not judged/, out)
  })

  test(`${shell}: the launcher pid known, an older PASS then a newer UNPROVEN from that same launcher: only its newest run is judged, FAIL`, { skip, timeout: 120_000 }, () => {
    const p = profile([
      { pid: 4800, console: 2500, at: NOW - 20 * 60_000, words: ['start', 'attached', 'accepted'] },
      { pid: 4900, console: 2500, at: NOW - 2 * 60_000, words: ['start', 'attached', 'unproven'] },
    ], { supervisorPid: 2500, bootAt: NOW - 20 * 60_000 + 30_000 })
    const { out, result } = prove(shell, p)
    assert.equal(result, 'FAIL', out)
    assert.match(out, /helper pid 4900 : UNPROVEN/, out)
    assert.match(out, /helper pid 4800 .*not judged/, out)
  })
}

test('the proof script judges only the newest helper run when it does not know the launcher (source contract)', () => {
  const src = readFileSync(SCRIPT, 'utf8')
  // A run starts at a "start" line: a pid that ran twice is two runs.
  assert.match(src, /if \(\$word -eq 'start'/)
  assert.match(src, /newest helper run/)
  assert.match(src, /not judged/)
})
