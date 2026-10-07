/**
 * The always-on supervisor's startup gates, as the service RUNS them since
 * supervisor generation 2 (design section 4).
 *
 * WHAT WAS MEASURED ON 2026-09-21 (Claude Code 2.1.278). The shipped run.expect,
 * run on a folder whose trust seed had missed, saw "confirm", pressed Enter on
 * "No, exit", and ended: exit code 0 after 2 seconds, no trust written, not one
 * line saying why. launchd restarted it forever, run.sh's WEDGED line guessed
 * "Likely auth", and the app told the owner to go and sign in.
 *
 * Generation 1 fixed that inside a run.expect that bin/bgos-agent generated.
 * Generation 2 removes run.expect: run.sh starts hoai with HOAI_SUPERVISED=1,
 * and hoai builds the script from the SAME shared lib/gate-block.tcl with the
 * supervised tail (bin/hoai-core.mjs buildGateAutoAcceptExpect). So the
 * invariants these tests pinned against run.expect are pinned here against
 * that script, run for real under expect against a simulator: the trust gate
 * is ACCEPTED and the session HELD, a launch that lost the startup race is
 * named and the next one (with run.sh's fail count) wins, and a screen nobody
 * can answer, an exit during startup and a signed-out claude are each a named
 * exit with the reason in launch-status. Where bash or expect is missing they
 * SKIP with the reason (expect never exists on Windows); CI turns a missing
 * tool into a failure.
 *
 * Run: npm test, or npx tsx --test test/bgos-agent.gate.test.ts
 */
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import {
  EXIT_SUPERVISED_GATE,
  EXIT_SUPERVISED_SIGNED_OUT,
  EXIT_SUPERVISED_STARTUP_EXIT,
  buildGateAutoAcceptExpect,
  readGateBlock,
} from '../bin/hoai-core.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const agentSource = readFileSync(join(repoRoot, 'bin', 'bgos-agent'), 'utf8')
const expectBin = ['/usr/bin/expect', '/opt/homebrew/bin/expect', '/usr/local/bin/expect'].find((p) => existsSync(p))
const SLOW = { timeout: 90_000 }

function expectOrSkip(t: TestContext): boolean {
  if (expectBin) return true
  assert.notEqual(process.env.HOAI_REQUIRE_EXPECT, '1', 'HOAI_REQUIRE_EXPECT=1 but expect is missing')
  t.skip(
    process.platform === 'win32'
      ? 'expect does not exist on Windows, where the supervisor is the logon task running hoai --keep-alive'
      : 'expect is not installed on this machine',
  )
  return false
}

const SIMULATOR = `
// SIMULATION, not Claude Code. Mode comes from HOAI_SIM_MODE because the script owns the argv.
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

/** The supervised script hoai would spawn, with the simulator standing in for claude. */
function generate(failcount?: number): { dir: string; script: string } {
  const root = mkdtempSync(join(tmpdir(), 'hoai-agent-gate-'))
  const dir = join(root, 'state')
  mkdirSync(dir)
  if (failcount !== undefined) writeFileSync(join(dir, 'failcount'), `${failcount}\n`)
  const simJs = join(root, 'sim.cjs')
  writeFileSync(simJs, SIMULATOR)
  // A two line sh wrapper, not a shebang: a shebang cannot carry a runtime path with a space in it.
  const sim = join(root, 'fake-claude')
  writeFileSync(sim, `#!/bin/sh\nexec "${process.execPath}" "${simJs}" "$@"\n`)
  chmodSync(sim, 0o755)
  const script = buildGateAutoAcceptExpect({
    claudePath: sim,
    args: ['--dangerously-skip-permissions', '--dangerously-load-development-channels', 'plugin:hoai@hoai'],
    // A launchd job with no tmux: no terminal, so the live session is held with expect eof.
    supervised: { stateDir: dir, interactive: false, compact: 'compact=off reason=no-tmux' },
  })
  writeFileSync(join(dir, 'supervised.exp'), script)
  return { dir, script }
}

function runExpect(state: string, mode: string): Promise<{ status: number | null; launchStatus: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(expectBin!, ['-f', join(state, 'supervised.exp')], {
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

test('bin/bgos-agent carries no gate rules and no key press of its own: the supervisor runs hoai, which owns the shared block', () => {
  const code = agentSource
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
  // A send, a spawn or a copy of the block in the bash source would be a second hand-kept
  // copy of the gate rules, which is how the 2026-09-21 fix once reached one launcher and
  // not the other.
  assert.doesNotMatch(code, /\bsend (--|")/)
  assert.doesNotMatch(code, /gate-block\.tcl/)
  assert.doesNotMatch(code, /^\s*spawn /m)
  assert.doesNotMatch(code, /run\.expect"\s*\|\|/, 'run.expect is not the launch path any more')
  assert.match(code, /"\$root\/bin\/hoai-core\.mjs"/, 'run.sh starts hoai from the resolved plugin root')
  // And hoai's supervised script embeds that block verbatim.
  assert.ok(generateText().includes(readGateBlock()))
})

function generateText(): string {
  return buildGateAutoAcceptExpect({ claudePath: 'claude', args: [], supervised: { stateDir: '/s', interactive: false, compact: 'compact=on' } })
}

test('behaviour: the trust gate with "No, exit" first is ACCEPTED and the agent stays up (the generation 1 wrapper once exited 0 in 2 s here)', SLOW, async (t) => {
  if (!expectOrSkip(t)) return
  const { dir } = generate()
  const started = Date.now()
  const run = await runExpect(dir, 'trust')
  // The simulator only goes live when Enter lands on "Yes", and otherwise leaves
  // like the real CLI does. So status 0 after the simulator's own 14 s life
  // means the gate was answered correctly and the session was HELD.
  assert.equal(run.status, 0)
  assert.ok(Date.now() - started > 10_000, 'the supervisor must hold a live session, not return in seconds')
  assert.match(run.launchStatus, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} outcome=live answered=\[trust\] compact=off reason=no-tmux$/)
})

test('behaviour: a launch that LOSES the startup race is named, and the next one waits longer and wins (run.sh\'s fail count drives it)', SLOW, async (t) => {
  if (!expectOrSkip(t)) return
  // MEASURED on a signed-in config, 2026-09-22: a Down sent before claude has
  // finished initialising is painted ("Yes" lights up) and not honoured, so the
  // Enter that follows declines and claude exits. The simulator's slow-init mode
  // is deaf for 2.5 s. With no counted failure the block's quiet second is not
  // enough, and the launch ends as a NAMED exit, which run.sh counts. With one
  // counted failure the same script waits 2 s longer and gets through.
  const first = generate(0)
  const second = generate(1)
  const [lost, won] = await Promise.all([runExpect(first.dir, 'slow-init'), runExpect(second.dir, 'slow-init')])
  assert.equal(lost.status, EXIT_SUPERVISED_STARTUP_EXIT)
  assert.match(lost.launchStatus, /outcome=exited-during-startup answered=\[trust\]/, 'the reason names the gate it answered before claude left')
  assert.equal(won.status, 0)
  assert.match(won.launchStatus, /outcome=live answered=\[trust\]/)
})

test('behaviour: a screen nobody can answer is a failed launch with a reason, never a process that looks healthy', SLOW, async (t) => {
  if (!expectOrSkip(t)) return
  const { dir } = generate()
  const run = await runExpect(dir, 'unknown')
  assert.equal(run.status, EXIT_SUPERVISED_GATE)
  assert.match(run.launchStatus, /outcome=gate-unrecognised answered=\[\] screen=".*shiny new telemetry.*" compact=off reason=no-tmux/)
})

test('behaviour: claude exiting during startup, and a signed-out claude, are each a named exit with the reason on disk', SLOW, async (t) => {
  if (!expectOrSkip(t)) return
  const a = generate()
  const b = generate()
  const [died, signedOut] = await Promise.all([runExpect(a.dir, 'dies'), runExpect(b.dir, 'signed-out')])
  assert.equal(died.status, EXIT_SUPERVISED_STARTUP_EXIT)
  assert.match(died.launchStatus, /outcome=exited-during-startup/)
  assert.equal(signedOut.status, EXIT_SUPERVISED_SIGNED_OUT)
  assert.match(signedOut.launchStatus, /outcome=live-but-not-signed-in/)
})
