/**
 * The claude ancestor probe on a busy Windows PC (HOAI board row 7046de2a,
 * mission 154 goal 10).
 *
 * The daemon finds its own claude once (lib/agent-state.ts), and the signed
 * browser context carries that pid (lib/private-turn.mjs publishPrivateContext:
 * live only with a claudePid); the managed browser shim refuses every call
 * while the context is not live (bin/hoai-browser-mcp.mjs readManagedContext,
 * acting_context_unavailable). On AlienAres under normal worker load the probe
 * took 4.0 to 6.3 s against defaultExecSync's 5 s cap (one Get-CimInstance per
 * parent link, nine links up to wininit), a timed out probe read as "no claude",
 * and the miss was held for 10 minutes: every browser call refused for 10
 * minutes. Here the probe is one CIM query, a probe that could not be read is
 * retried within 30 s, and a probe that read the chain and found no claude is
 * still held, and still refused.
 *
 * Every exec here is faked: no test lists real processes.
 *
 * Run: npx tsx --test test/agent-state.ancestor-probe.test.ts
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as agentState from '../lib/agent-state.ts'
import { publishPrivateContext } from '../lib/private-turn.mjs'

const T0 = Date.parse('2026-10-15T19:00:00.000Z')
const ABSENT_HOLD_MS = 10 * 60_000
const UNREADABLE_RETRY_MS = 30_000

type WinRow = { ProcessId: number; ParentProcessId: number; Name: string; CreationDate: number | null; CommandLine: string | null }
const row = (pid: number, ppid: number, name: string, command: string | null = null): WinRow => ({
  ProcessId: pid,
  ParentProcessId: ppid,
  Name: name,
  CreationDate: T0 - (100_000 - pid),
  CommandLine: command,
})
// The chain measured on AlienAres: the daemon (bun), the launcher (node), the
// native claude, then everything above it up to wininit.
const DAEMON = row(29760, 29736, 'bun.exe', 'C:\\Users\\k\\.bun\\bin\\bun.exe C:/Users/k/.claude/plugins/cache/hoai/hoai/0.69.2/server.ts')
const LAUNCH = row(29736, 29700, 'node.exe', 'node C:/Users/k/.claude/plugins/cache/hoai/hoai/0.69.2/bin/bgos-launch.mjs C:/Users/k/.claude/plugins/cache/hoai/hoai/0.69.2/server.ts')
const CLAUDE = row(29700, 29600, 'claude.exe', '"C:\\Users\\k\\.local\\bin\\claude.exe" --dangerously-load-development-channels server:bgos')
const ABOVE = [row(29600, 29500, 'wsl.exe'), row(29500, 29400, 'wsl.exe'), row(29400, 29300, 'powershell.exe'), row(29300, 29200, 'svchost.exe'), row(29200, 29100, 'services.exe'), row(29100, 29000, 'wininit.exe')]
const CHAIN = [DAEMON, LAUNCH, CLAUDE, ...ABOVE]

// What defaultExecSync (lib/service-supervision.mjs) returns when execFileSync
// kills a child at its timeout: status null reads as code 1, and stdout is
// whatever the child had written, which is nothing until ConvertTo-Json runs.
const TIMED_OUT = { code: 1, stdout: '' }
const EXEC_CAP_MS = 5000
const timedOut = () => TIMED_OUT
const good = () => ({ code: 0, stdout: JSON.stringify(CHAIN) })
const noClaude = () => ({ code: 0, stdout: JSON.stringify([DAEMON, LAUNCH, { ...CLAUDE, Name: 'cmd.exe', CommandLine: 'cmd.exe /c x' }, ...ABOVE]) })

/**
 * A faked powershell.exe with this PC's cost shape, measured 10 times each:
 * starting powershell.exe ~270 ms, each Get-CimInstance Win32_Process ~0.5 to
 * 0.8 s whatever its -Filter (the provider walks every process per query), so
 * a query inside the per-link loop is paid once per link. Over the cap it
 * answers as defaultExecSync does on a timeout. The rows are the fake's own;
 * the script decides only how much the call costs.
 */
function busyPowerShell(rows: WinRow[], opts: { startupMs?: number; perQueryMs?: number; capMs?: number } = {}) {
  const startupMs = opts.startupMs ?? 270
  const perQueryMs = opts.perQueryMs ?? 600
  const capMs = opts.capMs ?? EXEC_CAP_MS
  const spent: number[] = []
  const exec = (file: string, args: string[]) => {
    assert.equal(file, 'powershell.exe')
    const script = String(args[args.length - 1] ?? '')
    // A query written after the loop opens is paid once per link.
    const loopAt = script.indexOf('for (')
    const parts = script.split('Get-CimInstance')
    let queries = 0
    let at = 0
    for (const part of parts.slice(0, -1)) {
      at += part.length
      queries += loopAt >= 0 && at > loopAt ? rows.length : 1
      at += 'Get-CimInstance'.length
    }
    const ms = startupMs + perQueryMs * queries
    spent.push(ms)
    if (ms > capMs) return TIMED_OUT
    return { code: 0, stdout: JSON.stringify(rows) }
  }
  return { exec, spent }
}

test('a slow probe: on a nine link chain of a busy PC the walk still answers inside the 5 s exec cap', () => {
  const { exec, spent } = busyPowerShell(CHAIN)
  assert.equal(agentState.nearestClaudeAncestorWin32(DAEMON.ProcessId, exec), CLAUDE.ProcessId)
  assert.equal(spent.length, 1, 'one PowerShell call')
  assert.ok(spent[0]! <= EXEC_CAP_MS, `the call costs ${spent[0]} ms, inside the cap`)
})

test('the ancestry script makes ONE Win32_Process query, before the walk, and still follows ParentProcessId from this process', () => {
  const cmd = agentState.win32AncestryCommand(DAEMON.ProcessId)!
  const script = cmd.args[3]!
  assert.deepEqual(cmd.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
  assert.equal(script.split('Get-CimInstance').length - 1, 1, 'one CIM query')
  assert.match(script, /Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate,CommandLine -ErrorAction Stop/, 'a CIM error ends the call non-zero')
  assert.ok(script.indexOf('Get-CimInstance') < script.indexOf('for ('), 'the query is not paid per link')
  assert.match(script, /^\$p = 29760;/)
  assert.match(script, /\$p = \$x\.ParentProcessId/)
  assert.match(script, /\$i -lt 64/, 'still bounded at 64 links')
  assert.ok(!script.includes('"'), 'no double quote (Node escapes one on the Windows command line)')
  // Win32_Process ids are UInt32 and a PowerShell literal is Int32; a
  // hashtable keyed by one never finds the other, so both sides are cast.
  assert.match(script, /\$all\[\[int64\]\$_\.ProcessId\] = \$_/)
  assert.match(script, /\$x = \$all\[\[int64\]\$p\]/)
})

test('a probe that could not be read is unreadable, never "no claude"', () => {
  const read = (exec: (file: string, args: string[]) => { code: number; stdout: string }) =>
    agentState.readClaudeAncestorWin32(DAEMON.ProcessId, exec)
  assert.deepEqual(read(busyPowerShell(CHAIN, { capMs: 100 }).exec), { readable: false }, 'timed out')
  assert.deepEqual(read(() => ({ code: 1, stdout: JSON.stringify(CHAIN) })), { readable: false }, 'non-zero exit')
  assert.deepEqual(read(() => ({ code: 0, stdout: '[{"ProcessId":29760,"Paren' })), { readable: false }, 'cut short')
  assert.deepEqual(read(() => { throw new Error('spawn EPERM') }), { readable: false }, 'spawn failed')
  // Review M1: a CIM error that does not stop the script (a WMI quota or a
  // cancelled call on a busy PC) leaves the table empty, and the script still
  // prints [] and exits 0. The daemon is alive, so a chain without its own pid
  // is no reading of anything.
  assert.deepEqual(read(() => ({ code: 0, stdout: '[]' })), { readable: false }, 'an empty chain')
  assert.deepEqual(read(() => ({ code: 0, stdout: JSON.stringify([LAUNCH, CLAUDE]) })), { readable: false }, 'a chain without this process')
  // A chain that was read is an answer, either way.
  assert.deepEqual(read(() => ({ code: 0, stdout: JSON.stringify(CHAIN) })), { readable: true, pid: CLAUDE.ProcessId })
  assert.deepEqual(read(noClaude), { readable: true, pid: null })
  assert.deepEqual(read(() => ({ code: 0, stdout: JSON.stringify([DAEMON, LAUNCH, { ...CLAUDE, CreationDate: T0 + 1 }]) })), { readable: true, pid: null }, 'a reused parent pid ends the walk: read, no claude')
  assert.equal(agentState.readClaudeAncestorWin32(0, () => ({ code: 0, stdout: '[]' })).readable, true, 'no pid to walk from: nothing to retry')
})

test('readClaudeAncestor: PowerShell on win32; elsewhere ps, whose every answer is read as before', () => {
  const { exec } = busyPowerShell(CHAIN)
  assert.deepEqual(agentState.readClaudeAncestor({ platform: 'win32', ownPid: DAEMON.ProcessId, execSync: exec }), { readable: true, pid: CLAUDE.ProcessId })
  const ppid: Record<number, number> = { 500: 400, 400: 300, 300: 1 }
  const comm: Record<number, string> = { 400: 'bun', 300: '/Users/x/.local/bin/claude' }
  const ps = (_file: string, args: string[]) => {
    const pid = Number(args[args.length - 1])
    return args[1] === 'ppid=' ? { code: 0, stdout: `${ppid[pid] ?? 0}\n` } : { code: 0, stdout: `${comm[pid] ?? 'launchd'}\n` }
  }
  assert.deepEqual(agentState.readClaudeAncestor({ platform: 'darwin', ownPid: 500, execSync: ps }), { readable: true, pid: 300 })
  // macOS and Linux keep their behaviour: a failed ps was a miss held for the
  // full retry window, and still is.
  const failing = () => ({ code: 1, stdout: '' })
  assert.deepEqual(agentState.readClaudeAncestor({ platform: 'linux', ownPid: 500, execSync: failing }), { readable: true, pid: null })
  assert.equal(agentState.findClaudeAncestor({ platform: 'win32', ownPid: DAEMON.ProcessId, execSync: exec }), CLAUDE.ProcessId)
})

/** The daemon's wiring, on a fake clock: server.ts agentClaudePid. */
function probeOnClock(script: Array<(file: string, args: string[]) => { code: number; stdout: string }>) {
  let now = T0
  let calls = 0
  const get = agentState.memoizeAncestorReading(ABSENT_HOLD_MS, UNREADABLE_RETRY_MS, () => now, () =>
    agentState.readClaudeAncestor({
      platform: 'win32',
      ownPid: DAEMON.ProcessId,
      execSync: (file, args) => script[Math.min(calls++, script.length - 1)]!(file, args),
    }),
  )
  return { get, at: (ms: number) => { now = T0 + ms }, calls: () => calls }
}

test('a timeout followed by a good answer: the claude pid is back within 30 s, not 10 minutes, and then kept', () => {
  const p = probeOnClock([timedOut, good])
  assert.equal(p.get(), null, 'the probe timed out: no pid yet')
  p.at(UNREADABLE_RETRY_MS - 1)
  assert.equal(p.get(), null)
  assert.equal(p.calls(), 1, 'not retried every second')
  p.at(UNREADABLE_RETRY_MS)
  assert.equal(p.get(), CLAUDE.ProcessId, 'retried after 30 s, not after 10 minutes')
  p.at(ABSENT_HOLD_MS * 50)
  assert.equal(p.get(), CLAUDE.ProcessId)
  assert.equal(p.calls(), 2, 'a found claude is never probed again')
})

test('a real absence is still refused: no claude in a chain that was read is held for 10 minutes, and the browser context is not live', () => {
  const p = probeOnClock([noClaude, good])
  assert.equal(p.get(), null)
  p.at(UNREADABLE_RETRY_MS)
  assert.equal(p.get(), null, 'an absence is not retried at the unreadable pace')
  p.at(ABSENT_HOLD_MS - 1)
  assert.equal(p.get(), null)
  assert.equal(p.calls(), 1)
  // What the shim reads: a context without a claude pid is never live.
  const dir = mkdtempSync(join(tmpdir(), 'ancestor-probe-'))
  try {
    const path = join(dir, 'private-context.json')
    const turn = { actingUserId: 'user_a', chatId: '7', turnId: 't', sessionId: 's', markerPath: join(dir, 'm'), promptHash: 'a'.repeat(64) }
    publishPrivateContext({ path, secret: 'k', assistantId: '1', ownerUserId: 'user_a', claudePid: p.get(), turn, now: T0 })
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).context.live, false)
    publishPrivateContext({ path, secret: 'k', assistantId: '1', ownerUserId: 'user_a', claudePid: CLAUDE.ProcessId, turn, now: T0 })
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).context.live, true, 'the same turn with the pid is live')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the cached answers expire: an absence after 10 minutes, a failed read after 30 s, then 60 s, 120 s, never past 10 minutes', () => {
  const absent = probeOnClock([noClaude, good])
  absent.get()
  absent.at(ABSENT_HOLD_MS)
  assert.equal(absent.get(), CLAUDE.ProcessId, 'the absence expired and was read again')
  assert.equal(absent.calls(), 2)

  // A probe that keeps timing out backs off, so a PC where it never answers
  // does not block the daemon for 5 s every 30 s, and never waits longer
  // than an absence would.
  const failing = probeOnClock([timedOut])
  const retries: number[] = []
  let t = 0
  failing.get()
  for (let step = 0; step < 40 * 60 && retries.length < 8; step++) {
    t += 1000
    failing.at(t)
    const before = failing.calls()
    failing.get()
    if (failing.calls() > before) retries.push(t)
  }
  const gaps = retries.map((at, i) => at - (i === 0 ? 0 : retries[i - 1]!))
  assert.deepEqual(gaps.slice(0, 6), [30_000, 60_000, 120_000, 240_000, 480_000, 600_000])
  assert.ok(gaps.every((gap) => gap <= ABSENT_HOLD_MS), 'never held past the absence window')

  // A read that throws is the old miss: held for the full window.
  let now = T0
  let tries = 0
  const throwing = agentState.memoizeAncestorReading(ABSENT_HOLD_MS, UNREADABLE_RETRY_MS, () => now, () => {
    tries += 1
    throw new Error('ps')
  })
  assert.equal(throwing(), null)
  now = T0 + UNREADABLE_RETRY_MS
  throwing()
  assert.equal(tries, 1)
  now = T0 + ABSENT_HOLD_MS
  throwing()
  assert.equal(tries, 2)
})

test('server.ts wires the probe with a short retry for a failed read and the 10 minute hold for an absence', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.match(server, /const CLAUDE_ANCESTOR_RETRY_MS = 10 \* 60_000\n/)
  assert.match(server, /const CLAUDE_ANCESTOR_UNREADABLE_RETRY_MS = 30_000\n/)
  assert.match(
    server,
    /const agentClaudePid = memoizeAncestorReading\(CLAUDE_ANCESTOR_RETRY_MS, CLAUDE_ANCESTOR_UNREADABLE_RETRY_MS, Date\.now, \(\) =>\s*readClaudeAncestor\(\{ platform: process\.platform, ownPid: process\.pid, execSync: defaultExecSync \}\),?\s*\)/,
  )
})
