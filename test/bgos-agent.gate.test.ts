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

/** Cut one bash function (up to and including the line after its last heredoc terminator) out of the script. */
function bashFunction(name: string, lastTerminator: string): string {
  const lines = agentSource.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${name}() {`))
  assert.ok(start >= 0, `${name} not found`)
  const end = lines.findIndex((line, i) => i > start && line === lastTerminator)
  assert.ok(end > start, `${name}: heredoc terminator ${lastTerminator} not found`)
  return lines.slice(start, end + 2).join('\n')
}

const SIMULATOR = `#!${process.execPath}
// SIMULATION, not Claude Code. Mode comes from HOAI_SIM_MODE because run.expect owns the argv.
const M = '\\u276f'
const mode = process.env.HOAI_SIM_MODE
const SCREENS = {
  trust: 'Quick safety check: Is this a project you trust?\\r\\n ' + M + ' No, exit\\r\\n   Yes, I trust this folder\\r\\n Enter to confirm\\r\\n',
  unknown: 'Claude Code would like to enable shiny new telemetry.\\r\\n ' + M + ' Decline\\r\\n   Allow\\r\\n Enter to confirm\\r\\n',
}
if (mode === 'dies') process.exit(0)
let got = Buffer.alloc(0)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (d) => { got = Buffer.concat([got, d]) })
process.stdout.write(SCREENS[mode] ?? '')
const live = '\\r\\n\\x1b[6Gbypass\\x1b[13Gpermissions\\x1b[25Gon\\r\\n'
if (mode === 'trust') setTimeout(() => {
  // only go live if the block really sent Down then Enter; otherwise behave like the real CLI and leave
  if (got.toString('hex') === '1b5b420d') process.stdout.write(live)
  else process.exit(0)
}, 2800)
if (mode === 'signed-out') setTimeout(() => process.stdout.write(live + '\\x1b[53GNot\\x1b[57Glogged\\x1b[64Gin\\x1b[69GRun\\x1b[73G/login\\r\\n'), 200)
// a live session ends when the test is done with it: 7 s is past the block's 3 s sign-in check
setTimeout(() => process.exit(0), mode === 'trust' ? 7000 : 12000)
`

function generate(): { dir: string; runExpect: string; runSh: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hoai-agent-gate-'))
  const state = join(dir, 'state')
  mkdirSync(state)
  const sim = join(dir, 'fake-claude')
  writeFileSync(sim, SIMULATOR)
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
  if (!hasBash) return
  const { runExpect: text } = generate()
  assert.match(text, /spawn ".*fake-claude" --dangerously-skip-permissions --dangerously-load-development-channels "plugin:hoai@hoai"/)
  assert.ok(text.includes(gateBlock), 'the block must be copied byte for byte, not re-typed')
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
  if (!hasBash) return
  const { runSh } = generate()
  assert.doesNotMatch(runSh, /Likely auth/, 'the old text blamed sign-in for a declined startup gate')
  assert.match(runSh, /Last launch: \$\(cat "\$sd\/launch-status"/)
  assert.match(runSh, /rc=0\n"\$expect_bin" "\$expectfile" \|\| rc=\$\?/)
  assert.match(runSh, /outcome=waiting-for-incumbent pids=/)
  assert.equal(spawnSync('bash', ['-n', '/dev/stdin'], { input: runSh }).status, 0, 'generated run.sh must parse')
})

test('behaviour: the trust gate with "No, exit" first is ACCEPTED and the agent stays up (the shipped wrapper exited 0 in 2 s here)', SLOW, async () => {
  if (!hasBash || !expectBin) return
  const { dir } = generate()
  const started = Date.now()
  const run = await runExpect(dir, 'trust')
  // The simulator only goes live for the exact bytes Down, Enter, and otherwise
  // leaves like the real CLI does. So status 0 after the simulator's own 7 s
  // life means the gate was answered correctly and the session was HELD.
  assert.equal(run.status, 0)
  assert.ok(Date.now() - started > 5000, 'the supervisor must hold a live session, not return in seconds')
  assert.match(run.launchStatus, /outcome=live answered=\[trust\]/)
})

test('behaviour: a screen nobody can answer is a failed launch with a reason, exit 3, never a process that looks healthy', SLOW, async () => {
  if (!hasBash || !expectBin) return
  const { dir } = generate()
  const run = await runExpect(dir, 'unknown')
  assert.equal(run.status, 3)
  assert.match(run.launchStatus, /outcome=gate-unrecognised answered=\[\] screen=".*shiny new telemetry/)
})

test('behaviour: claude exiting during startup is exit 4, and a signed-out claude is exit 5, each with its reason on disk', SLOW, async () => {
  if (!hasBash || !expectBin) return
  const a = generate()
  const b = generate()
  const [died, signedOut] = await Promise.all([runExpect(a.dir, 'dies'), runExpect(b.dir, 'signed-out')])
  assert.equal(died.status, 4)
  assert.match(died.launchStatus, /outcome=exited-during-startup/)
  assert.equal(signedOut.status, 5)
  assert.match(signedOut.launchStatus, /outcome=live-but-not-signed-in/)
})
