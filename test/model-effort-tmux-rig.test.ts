/**
 * Owner model and effort control (Route A): end to end on a REAL tmux server
 * with a FAKE agent (test/fixtures/fake-claude-tui.mjs).
 *
 * The unit cases (model-effort-control.test.ts) prove the transaction; this
 * one proves the transport: the real argv from lib/compact-inject.ts typed by
 * real tmux send-keys, the real pane probes, the real `ps` ancestry, and
 * confirmation from observations written by the real status line bridge.
 *
 * Each tmux server is this test's own, on a socket FILE inside the test's own
 * temp folder (-S <tmp>/tmux.sock, -f /dev/null), killed with kill-server on
 * that socket only and the folder removed. No other tmux server, session or
 * agent on the machine is touched, and nothing is left in the shared tmux
 * socket folder. Skipped where tmux is absent (Windows).
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import type { TmuxTarget } from '../lib/compact-inject.ts'
import { ModelEffortControl } from '../lib/model-effort-control.ts'
import { processAncestry } from '../lib/model-effort-pane.ts'
import { modelControlDir, readObservation } from '../lib/model-control-store.mjs'

const execFileAsync = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HELP = spawnSync('cat', [join(ROOT, 'test', 'fixtures', 'claude-help-2.1.309.txt')], { encoding: 'utf8' }).stdout
const hasTmux = spawnSync('tmux', ['-V']).status === 0
const started: Array<{ socket: string; folder: string }> = []

after(() => {
  for (const { socket, folder } of started) {
    spawnSync('tmux', ['-S', socket, 'kill-server'])
    rmSync(folder, { recursive: true, force: true })
  }
})

async function exec(argv: string[]): Promise<string> {
  const { stdout } = await execFileAsync(argv[0]!, argv.slice(1), { timeout: 5_000 })
  return stdout
}

type Exec = (argv: string[]) => Promise<string>

async function startRig(name: string, env: Record<string, string> = {}, wrapExec?: (socket: string, run: Exec) => Exec) {
  const state = mkdtempSync(join(tmpdir(), 'hoai-mec-rig-'))
  const sessionId = `rig-${name}-${process.pid}`
  const socket = join(state, 'tmux.sock')
  const command = [
    `BGOS_PLUGIN_STATE_DIR='${state}'`,
    `FAKE_TUI_SESSION_ID='${sessionId}'`,
    `FAKE_TUI_BRIDGE='${join(ROOT, 'bin', 'hoai-statusline-bridge.mjs')}'`,
    ...Object.entries(env).map(([k, v]) => `${k}='${v}'`),
    `exec '${process.execPath}' '${join(ROOT, 'test', 'fixtures', 'fake-claude-tui.mjs')}'`,
  ].join(' ')
  const run = spawnSync('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'rig', '-x', '120', '-y', '30', command])
  assert.equal(run.status, 0, String(run.stderr))
  started.push({ socket, folder: state })
  const target: TmuxTarget = { target: 'rig', socketArgs: ['-S', socket], source: 'tmux-pane' }
  const panePid = Number((await exec(['tmux', '-S', socket, 'display-message', '-p', '-t', 'rig', '#{pane_pid}'])).trim())
  const dir = modelControlDir({ env: { BGOS_PLUGIN_STATE_DIR: state }, home: state })
  // Wait for the first status line observation and the stand in daemon, the
  // fake agent's own child, whose ancestry a real daemon would walk.
  const pidFile = join(state, 'daemon.pid')
  for (let i = 0; i < 50 && !(readObservation(dir, sessionId) && existsSync(pidFile)); i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  const daemonPid = Number(readFileSync(pidFile, 'utf8').trim())
  // And for the composer to be drawn: an observation can land before the
  // first frame, and a screen read then finds no composer.
  for (let i = 0; i < 50 && !/❯/.test(await capture(socket)); i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  const control = new ModelEffortControl({
    optedIn: () => true,
    target: () => target,
    sessionId: () => sessionId,
    turnState: () => 'idle',
    dialogOpen: () => false,
    otherInjectionBusy: () => false,
    // A daemon walks up from itself to the pane's root, the fake agent.
    ancestry: () => processAncestry(daemonPid, exec),
    readObservation: (sid) => readObservation(dir, sid),
    helpText: async () => HELP,
    exec: wrapExec ? wrapExec(socket, exec) : exec,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: () => {},
  }, { confirmTimeoutMs: 8_000, pollMs: 100, staleMs: 15_000 })
  return { control, socket, target, panePid, daemonPid }
}

async function capture(socket: string): Promise<string> {
  return exec(['tmux', '-S', socket, 'capture-pane', '-p', '-t', 'rig'])
}

test('the ancestry of a real process names its own tty and foreground group', { skip: !hasTmux }, async () => {
  const { panePid, daemonPid } = await startRig('ps')
  const chain = await processAncestry(daemonPid, exec)
  assert.ok(chain.length >= 2)
  assert.equal(chain[0]!.pid, daemonPid)
  assert.equal(chain[1]!.pid, panePid, 'the stand in daemon is the fake agent\'s child')
  assert.match(chain[0]!.tty, /^ttys?\d+|^pts\//)
  assert.equal(chain[0]!.pgid, chain[0]!.tpgid, 'the agent\'s job is the foreground of its pane')
})

test('set_model and set_effort are typed by real tmux and confirmed by the real bridge', { skip: !hasTmux }, async () => {
  const { control, socket } = await startRig('apply')
  const model = await control.handle({ op: 'set_model', value: 'sonnet' })
  assert.equal(model.ok, true, JSON.stringify(model))
  if (model.ok) assert.equal(model.report.model, 'claude-sonnet-5-5')
  const effort = await control.handle({ op: 'set_effort', value: 'max' })
  assert.equal(effort.ok, true, JSON.stringify(effort))
  if (effort.ok) {
    assert.equal(effort.report.effort, 'max')
    assert.equal(effort.report.model, 'claude-sonnet-5-5')
  }
  assert.match(await capture(socket), /Set effort max/)
})

test('a real draft in the pane is refused and left exactly as the owner typed it', { skip: !hasTmux }, async () => {
  const { control, socket } = await startRig('draft')
  // The owner's own typing, simulated in this test's own pane.
  await exec(['tmux', '-S', socket, 'send-keys', '-t', 'rig', '-l', '--', 'half a thought'])
  // Wait until the draft is on screen: a key still in flight when the control
  // reads the pane is the one race no screen read can close (RESULT.md).
  for (let i = 0; i < 100 && !/❯ half a thought/.test(await capture(socket)); i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.match(await capture(socket), /❯ half a thought/, 'the owner\'s draft is drawn before the request')
  const out = await control.handle({ op: 'set_model', value: 'sonnet' })
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, 'composer_not_empty')
  assert.match(await capture(socket), /❯ half a thought/)
})

test('echoed input that never applies is not confirmed', { skip: !hasTmux }, async () => {
  const { control } = await startRig('echo', { FAKE_TUI_APPLY: '0' })
  const out = await control.handle({ op: 'set_effort', value: 'low' })
  assert.equal(out.ok, false)
  if (!out.ok) {
    assert.equal(out.code, 'not_confirmed')
    assert.equal(out.report!.effort, 'high')
    assert.match(out.message, /still in the agent's message box/)
  }
})

async function typeAsOwner(socket: string, text: string): Promise<void> {
  // The owner's own typing, simulated in this test's own pane; then wait until
  // it is drawn (a key still in flight is the race no screen read can close).
  await exec(['tmux', '-S', socket, 'send-keys', '-t', 'rig', '-l', '--', text])
  for (let i = 0; i < 100 && !(await capture(socket)).includes(`❯ ${text}`); i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok((await capture(socket)).includes(`❯ ${text}`), 'the owner\'s draft is drawn before the request')
}

// Security review H1, the reviewer's own end to end case: before the fix the
// control typed `/model sonnet` and Enter after this draft and the screen
// showed `● Unknown: const f = () =>/model sonnet`.
test('H1: a real draft ending with > is refused and left exactly as the owner typed it', { skip: !hasTmux }, async () => {
  const { control, socket } = await startRig('arrow')
  await typeAsOwner(socket, 'const f = () =>')
  const out = await control.handle({ op: 'set_model', value: 'sonnet' })
  const screen = await capture(socket)
  assert.doesNotMatch(screen, /Unknown:|\/model sonnet/, screen)
  assert.equal(out.ok, false, JSON.stringify(out))
  if (!out.ok) assert.equal(out.code, 'composer_not_empty')
  assert.match(screen, /❯ const f = \(\) =>/)
})

// Security review M2 on a real tmux server: the target is a session NAME, and
// a window opened in that session right after the control read the agent's
// screen becomes what the name resolves to. The keys must still reach the
// proven pane, and nothing the window's program (cat, which echoes) receives.
test('M2: a window opened mid request does not receive the keys; the proven pane does', { skip: !hasTmux }, async () => {
  let opened = false
  const { control, socket } = await startRig('window', {}, (sock, run) => async (argv) => {
    const out = await run(argv)
    if (!opened && argv.includes('capture-pane')) {
      opened = true
      await run(['tmux', '-S', sock, 'new-window', '-t', 'rig', 'cat'])
    }
    return out
  })
  const out = await control.handle({ op: 'set_model', value: 'sonnet' })
  assert.ok(opened)
  const other = await capture(socket)
  assert.doesNotMatch(other, /\/model/, `the new window received keys: ${other}`)
  assert.equal(out.ok, true, JSON.stringify(out))
  if (out.ok) assert.equal(out.report.model, 'claude-sonnet-5-5')
})
