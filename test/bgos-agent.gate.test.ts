/**
 * The always-on supervisor's run.expect and run.sh, as bin/bgos-agent GENERATES
 * them, because that generated pair is what desktop one-click actually leaves
 * running under launchd or systemd.
 *
 * WHAT WAS MEASURED ON 2026-09-21 (Claude Code 2.1.278). The shipped run.expect,
 * run on a folder whose trust seed had missed, saw "confirm", pressed Enter on
 * "No, exit", and ended: exit code 0 after 2 seconds, no trust written, not one
 * line saying why. launchd restarted it forever, run.sh's WEDGED line guessed
 * "Likely auth", and the app told the owner to go and sign in. None of the
 * ergonomics fixes of that week touched this file; they all landed in the hoai
 * launcher, which one-click never runs.
 *
 * These tests generate the real files with the real bash function and then RUN
 * run.expect against a simulator, so what is pinned is the behaviour under
 * launchd (exit code, launch-status line), not the look of the text. They
 * return early where bash or expect is missing.
 *
 * Run: npm test, or npx tsx --test test/bgos-agent.gate.test.ts
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const agentPath = join(repoRoot, 'bin', 'bgos-agent')
const agentSource = readFileSync(agentPath, 'utf8')
const gateBlock = readFileSync(join(repoRoot, 'lib', 'gate-block.tcl'), 'utf8')
const expectBin = ['/usr/bin/expect', '/opt/homebrew/bin/expect', '/usr/local/bin/expect'].find((p) => existsSync(p))
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0
const SLOW = { timeout: 90_000 }

/** An early return reports PASS, so CI sets HOAI_REQUIRE_EXPECT=1 and a missing tool becomes a failure. */
function requireTools(): void {
  assert.notEqual(process.env.HOAI_REQUIRE_EXPECT, '1', 'HOAI_REQUIRE_EXPECT=1 but bash or expect is missing')
}

/** Cut one bash function (up to and including the line after its last heredoc terminator) out of the script. */
function bashFunction(name: string, lastTerminator: string): string {
  const lines = agentSource.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${name}() {`))
  assert.ok(start >= 0, `${name} not found`)
  const end = lines.findIndex((line, i) => i > start && line === lastTerminator)
  assert.ok(end > start, `${name}: heredoc terminator ${lastTerminator} not found`)
  return lines.slice(start, end + 2).join('\n')
}

const SIMULATOR = `
// SIMULATION, not Claude Code. Mode comes from HOAI_SIM_MODE because run.expect owns the argv.
// It repaints the selection marker on every Down the way the real TUI does, and goes live only
// if Enter lands on the wanted option; otherwise it leaves, as the real CLI does.
const M = '\\u276f'
const mode = process.env.HOAI_SIM_MODE
const born = Date.now()
const GATES = {
  trust: { head: 'Quick safety check: Is this a project you trust?', opts: ['No, exit', 'Yes, I trust this folder'], want: 1 },
  // MEASURED on the real CLI: a key that arrives before claude has finished initialising is
  // PAINTED and not honoured. Here "finished" is 2.5 s after the paint, to stand in for a loaded Mac.
  'slow-init': { head: 'Quick safety check: Is this a project you trust?', opts: ['No, exit', 'Yes, I trust this folder'], want: 1, deafMs: 2500 },
  unknown: { head: 'Claude Code would like to enable shiny new telemetry.', opts: ['Decline', 'Allow'], want: -1 },
}
if (mode === 'dies') process.exit(0)
const LIVE = '\\r\\n\\x1b[6Gbypass\\x1b[13Gpermissions\\x1b[25Gon\\r\\n'
const gate = GATES[mode]
let shown = 0, real = 0
const lines = () => gate.opts.map((o, i) => ' ' + (i === shown ? M : ' ') + ' ' + o).join('\\r\\n')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (d) => {
  const text = d.toString('latin1')
  if (gate && text.includes('\\x1b[B')) {
    shown = (shown + 1) % gate.opts.length
    if (!gate.deafMs || Date.now() - born > gate.deafMs) real = shown
    process.stdout.write('\\x1b[2A' + lines() + '\\r\\n')
  }
  if (text.includes('\\r')) {
    if (gate && real === gate.want) setTimeout(() => process.stdout.write(LIVE), 200)
    else setTimeout(() => process.exit(0), 100)
  }
})
if (gate) process.stdout.write(gate.head + '\\r\\n' + lines() + '\\r\\n Enter to confirm\\r\\n')
if (mode === 'signed-out') setTimeout(() => process.stdout.write(LIVE + '\\x1b[53GNot\\x1b[57Glogged\\x1b[64Gin\\x1b[69GRun\\x1b[73G/login\\r\\n'), 200)
// a live session ends when the test is done with it, well past the block's 3 s sign-in check
setTimeout(() => process.exit(0), 14000)
`

function generate(failcount?: number): { dir: string; runExpect: string; runSh: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hoai-agent-gate-'))
  const state = join(dir, 'state')
  mkdirSync(state)
  if (failcount !== undefined) writeFileSync(join(state, 'failcount'), `${failcount}\n`)
  // A two line sh wrapper, not a shebang: a shebang cannot carry a runtime path with a space in it.
  const simJs = join(dir, 'sim.cjs')
  writeFileSync(simJs, SIMULATOR)
  const sim = join(dir, 'fake-claude')
  writeFileSync(sim, `#!/bin/sh\nexec "${process.execPath}" "${simJs}" "$@"\n`)
  chmodSync(sim, 0o755)
  const script = [
    'set -euo pipefail',
    'die() { echo "DIE: $*" >&2; exit 1; }',
    `PLUGIN_DIR='${repoRoot}'`,
    bashFunction('write_run_expect', 'EXP_TAIL'),
    bashFunction('write_run_sh', 'SH'),
    `write_run_expect '${state}/run.expect' '${state}' '${sim}' 'plugin:hoai@hoai' ''`,
    `write_run_sh '${state}/run.sh' '${state}' '${state}/run.expect' '${expectBin ?? 'expect'}'`,
  ].join('\n')
  const gen = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  assert.equal(gen.status, 0, gen.stderr)
  return { dir: state, runExpect: readFileSync(join(state, 'run.expect'), 'utf8'), runSh: readFileSync(join(state, 'run.sh'), 'utf8') }
}

function runExpect(state: string, mode: string): Promise<{ status: number | null; launchStatus: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(expectBin!, ['-f', join(state, 'run.expect')], {
      stdio: 'ignore',
      env: { ...process.env, HOAI_SIM_MODE: mode },
    })
    child.on('error', reject)
    child.on('exit', (status) => {
      const file = join(state, 'launch-status')
      resolve({ status, launchStatus: existsSync(file) ? readFileSync(file, 'utf8').trim() : '' })
    })
  })
}

test('bin/bgos-agent: the script carries no key press of its own, it copies the shared gate block', () => {
  // No Tcl `send` anywhere in the bash source: the only sends that reach
  // run.expect arrive inside lib/gate-block.tcl.
  const code = agentSource
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
  assert.doesNotMatch(code, /\bsend (--|")/, 'a send in bin/bgos-agent is a second hand-kept copy of the gate rules')
  assert.match(code, /cat "\$gate_block" >> "\$1"/)
  assert.match(code, /\[ -f "\$gate_block" \] \|\| die /, 'a missing block must stop the install, never produce a wrapper with no gate handling')
})

test('generated run.expect: spawn line, then the shared block VERBATIM, then the supervisor tail', () => {
  if (!hasBash) return requireTools()
  const { runExpect: text } = generate()
  assert.match(text, /spawn ".*fake-claude" --dangerously-skip-permissions --dangerously-load-development-channels "plugin:hoai@hoai"/)
  assert.ok(text.includes(gateBlock), 'the block must be copied byte for byte, not re-typed')
  // The extra settle is derived from run.sh's own fail count, and it is set BEFORE the block reads it.
  const pre = text.slice(0, text.indexOf(gateBlock))
  assert.match(pre, /set hoai_extra_settle 0/)
  assert.match(pre, /open "\$hoai_statedir\/failcount"/)
  assert.match(pre, /\$hoai_fails >= 5 \? 10 : 2 \* \$hoai_fails/)
  const tail = text.slice(text.indexOf(gateBlock) + gateBlock.length)
  // The tail presses nothing either.
  assert.doesNotMatch(tail, /\bsend\b/)
  assert.match(tail, /launch-status/)
  assert.match(tail, /string match "gate-\*" \$hoai_outcome\]\} \{ catch \{close\}; exit 3 \}/)
  assert.match(tail, /"exited-during-startup"\} \{ exit 4 \}/)
  assert.match(tail, /"live-but-not-signed-in"\} \{ catch \{close\}; exit 5 \}/)
  assert.ok(tail.trimEnd().endsWith('expect eof'), 'a live agent is held until claude exits, with no interact (launchd has no terminal)')
  // The heredoc is quoted, so bash must not have eaten the Tcl variables.
  assert.match(tail, /\$hoai_outcome/)
  assert.match(tail, /set hoai_statedir|\$hoai_statedir/)
})

test('generated run.sh: WEDGED reports what run.expect measured instead of guessing, and the incumbent wait is visible', () => {
  if (!hasBash) return requireTools()
  const { runSh } = generate()
  assert.doesNotMatch(runSh, /Likely auth/, 'the old text blamed sign-in for a declined startup gate')
  assert.match(runSh, /Last launch: \$\(cat "\$sd\/launch-status"/)
  assert.match(runSh, /rc=0\n"\$expect_bin" "\$expectfile" \|\| rc=\$\?/)
  assert.match(runSh, /outcome=waiting-for-incumbent pids=/)
  // Cleared before every launch, so a launch that dies before run.expect writes its line is
  // never reported with the PREVIOUS launch's reason.
  assert.ok(runSh.indexOf('outcome=starting') > 0 && runSh.indexOf('outcome=starting') < runSh.indexOf('"$expect_bin" "$expectfile"'))
  // PARSE A FILE, NOT /dev/stdin. On CI this returned 126, which is bash
  // saying it could not EXECUTE or open the path; a real syntax error is 2.
  // So the check was reporting the plumbing, not the script, and it had never
  // parsed anything there. Same check, a path bash can actually open.
  const parseFile = join(mkdtempSync(join(tmpdir(), 'hoai-parse-')), 'run.sh')
  writeFileSync(parseFile, runSh)
  const parsed = spawnSync('bash', ['-n', parseFile], { encoding: 'utf8' })
  assert.notEqual(
    parsed.status,
    126,
    `bash could not open ${parseFile} (126), so this says nothing about the script: ${parsed.stderr}`,
  )
  assert.equal(parsed.status, 0, `generated run.sh must parse: ${parsed.stderr}`)
  // and the installer that GENERATES it, under whatever bash this machine has (3.2 on macOS, 5.x on CI)
  const parsedAgent = spawnSync('bash', ['-n', agentPath], { encoding: 'utf8' })
  assert.equal(parsedAgent.status, 0, `bin/bgos-agent itself must parse: ${parsedAgent.stderr}`)
})

test('behaviour: the generated run.sh really RUNS under the bash of this machine, keeps the exit code, counts the failure and names it', SLOW, async () => {
  if (!hasBash) return requireTools()
  // Parsing is not running. run.sh is what launchd and systemd execute on the
  // OWNER'S machine, with the owner's bash (3.2 on macOS, 5.x on Linux), so it
  // is executed here for real against a stand-in for expect that fails fast,
  // the way a declined gate does. Three laps take the fail count to the WEDGED
  // branch; the 60 s sleep there is the only thing stubbed out.
  const { dir } = generate()
  const stub = join(dir, 'fake-expect')
  writeFileSync(stub, `#!/bin/sh\necho "2026-09-22 00:00:00 outcome=gate-unrecognised answered=[] screen=\\"shiny new telemetry\\"" > "${dir}/launch-status"\nexit 3\n`)
  chmodSync(stub, 0o755)
  const runShPath = join(dir, 'run.sh')
  writeFileSync(
    runShPath,
    readFileSync(runShPath, 'utf8')
      .replace(/^expect_bin=.*$/m, `expect_bin="${stub}"`)
      .replace(/^  sleep 60$/m, '  : # the 60 s back-off, skipped in the test'),
  )
  const workdir = mkdtempSync(join(tmpdir(), 'hoai-agent-cwd-'))
  for (let lap = 1; lap <= 3; lap++) {
    const run = spawnSync('bash', [runShPath], { cwd: workdir, encoding: 'utf8', timeout: 60_000 })
    assert.equal(run.status, 0, `lap ${lap}: run.sh itself must not die (${run.stderr})`)
    assert.equal(readFileSync(join(dir, 'failcount'), 'utf8').trim(), String(lap))
  }
  const log = readFileSync(join(dir, 'agent.log'), 'utf8')
  assert.match(log, /starting agent \(consecutive fast-fails: 2\)/)
  assert.match(log, /WEDGED: agent exited after \d+s \(expect exit 3\), 3 times in a row\./, 'the exit code survives `|| rc=$?`')
  assert.match(log, /Last launch: .*outcome=gate-unrecognised .*shiny new telemetry/, 'the MEASURED reason, not a guess')
  assert.doesNotMatch(log, /syntax error|command not found|unbound variable|bad substitution/)
})

test('behaviour: the trust gate with "No, exit" first is ACCEPTED and the agent stays up (the shipped wrapper exited 0 in 2 s here)', SLOW, async () => {
  if (!hasBash || !expectBin) return requireTools()
  const { dir } = generate()
  const started = Date.now()
  const run = await runExpect(dir, 'trust')
  // The simulator only goes live when Enter lands on "Yes", and otherwise leaves
  // like the real CLI does. So status 0 after the simulator's own 14 s life
  // means the gate was answered correctly and the session was HELD.
  assert.equal(run.status, 0)
  assert.ok(Date.now() - started > 10_000, 'the supervisor must hold a live session, not return in seconds')
  assert.match(run.launchStatus, /outcome=live answered=\[trust\]/)
})

test('behaviour: a launch that LOSES the startup race is named, and the next one waits longer and wins (the fail count drives it)', SLOW, async () => {
  if (!hasBash || !expectBin) return requireTools()
  // MEASURED on a signed-in config, 2026-09-22: a Down sent before claude has
  // finished initialising is painted ("Yes" lights up) and not honoured, so the
  // Enter that follows declines and claude exits. The simulator's slow-init mode
  // is deaf for 2.5 s. With no counted failure the block's quiet second is not
  // enough, and the launch ends as a NAMED exit 4, which run.sh counts. With one
  // counted failure the same wrapper waits 2 s longer and gets through. Nothing
  // about the machine changed between the two: only the number run.sh wrote.
  const first = generate(0)
  const second = generate(1)
  const [lost, won] = await Promise.all([runExpect(first.dir, 'slow-init'), runExpect(second.dir, 'slow-init')])
  assert.equal(lost.status, 4)
  assert.match(lost.launchStatus, /outcome=exited-during-startup answered=\[trust\]/, 'the reason names the gate it answered before claude left')
  assert.equal(won.status, 0)
  assert.match(won.launchStatus, /outcome=live answered=\[trust\]/)
})

test('behaviour: a screen nobody can answer is a failed launch with a reason, exit 3, never a process that looks healthy', SLOW, async () => {
  if (!hasBash || !expectBin) return requireTools()
  const { dir } = generate()
  const run = await runExpect(dir, 'unknown')
  assert.equal(run.status, 3)
  assert.match(run.launchStatus, /outcome=gate-unrecognised answered=\[\] screen=".*shiny new telemetry/)
})

test('behaviour: claude exiting during startup is exit 4, and a signed-out claude is exit 5, each with its reason on disk', SLOW, async () => {
  if (!hasBash || !expectBin) return requireTools()
  const a = generate()
  const b = generate()
  const [died, signedOut] = await Promise.all([runExpect(a.dir, 'dies'), runExpect(b.dir, 'signed-out')])
  assert.equal(died.status, 4)
  assert.match(died.launchStatus, /outcome=exited-during-startup/)
  assert.equal(signedOut.status, 5)
  assert.match(signedOut.launchStatus, /outcome=live-but-not-signed-in/)
})
