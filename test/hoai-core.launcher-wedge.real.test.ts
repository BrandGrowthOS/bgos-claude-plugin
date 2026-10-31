/**
 * The kc-server wedge of 2026-10-29/30 with REAL processes (macOS and Linux,
 * wherever a real `expect` is installed): David 873, Ava 871 and nono 1104
 * were dark about 8 h, about 400 restarts each. After "stop requested" the
 * launcher that supervised the agent kept running, its expect kept running,
 * and the claude under that expect was a zombie nobody reaped:
 *
 *   node hoai-core.mjs        <- held supervisor.json, so every new launch
 *     `-expect -c set hoai_statedir "~/.bgos-agent/<id>" ...   ended at once
 *         `-(claude)          <- zombie        with outcome=already-supervised
 *
 * The agent 867 takeover (test/hoai-core.launcher-zombie.real.test.ts) looked
 * at the launcher's DIRECT children only, and its direct child here is a live
 * expect. The loop was not stuck either (it was awaiting expect's exit), so
 * the watchdog never fired.
 *
 * The expect here is the real one, scripted into the state the launchers were
 * found in (it ignores TERM and HUP and never reaps its claude: FAKE/expect
 * below); claude is a two line shell script. Every file lives in a scratch
 * HOME under the OS temp folder, and every process signalled is one this test
 * started (its pid recorded from the process itself).
 *
 *   - the wedge: a real hoai (main, HOAI_SUPERVISED) is stopped the way
 *     run.sh's tmux kill-server stops it (SIGHUP) while its claude ends; it
 *     must let go of the agent by itself, and the next launch must start. On
 *     main the old launcher stayed forever and the next launch exited 3;
 *   - the takeover, against a holder that never lets go by itself (an older
 *     launcher still running when the fix lands): its claude a zombie under
 *     expect, or no claude under expect at all, is taken over and the stuck
 *     expect ended with it; a live claude under expect, or an expect that
 *     names another agent's state dir, is never touched.
 *
 * Run: npx tsx --test test/hoai-core.launcher-wedge.real.test.ts
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { EXIT_ALREADY_SUPERVISED, SUPERVISOR_FILE_NAME, superviseClaude } from '../bin/hoai-core.mjs'

const REPO = join(import.meta.dirname, '..')
const ID = '998'
const REAL_EXPECT =
  process.platform === 'win32' ? '' : String(spawnSync('/bin/sh', ['-c', 'command -v expect'], { encoding: 'utf8' }).stdout ?? '').trim()
const SKIP = process.platform === 'win32' ? 'posix only: Windows has no expect' : !REAL_EXPECT ? 'no expect on this host' : false

function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-wedge-real-')))
  const home = join(root, 'home')
  const cwd = join(root, 'agent')
  const fake = join(root, 'fake')
  const bin = join(fake, 'bin')
  const launcher = join(root, 'launcher')
  const stateDir = join(home, '.bgos-agent', ID)
  for (const dir of [stateDir, cwd, bin, launcher]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(cwd, '.bgos-agent-id'), `${ID}\n`)
  // claude: says who it is, then lives on as a sleep (same pid) until it is ended.
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n# fake claude for a test, never the real one\necho $$ > "$FAKE/claude.pid"\nexec sleep 600\n')
  // expect: the REAL expect, made to hang the way kc-server's did. It keeps the first line of the
  // script hoai hands it (`set hoai_statedir "<dir>"`), so its command line is a real one.
  writeFileSync(
    join(bin, 'expect'),
    [
      '#!/bin/sh',
      '# fake expect for a test: the real expect, scripted to ignore TERM and HUP and never reap claude',
      'first=$(printf "%s\\n" "$2" | head -n 1)',
      'tail="vwait forever"',
      '[ "$(cat "$FAKE/expect-mode" 2>/dev/null)" = reap ] && tail="catch wait',
      'vwait forever"',
      'echo $$ > "$FAKE/expect.pid"',
      `exec ${JSON.stringify(REAL_EXPECT)} -c "$first`,
      'spawn claude',
      'trap SIG_IGN {SIGTERM SIGHUP}',
      '$tail"',
      '',
    ].join('\n'),
  )
  chmodSync(join(bin, 'claude'), 0o755)
  chmodSync(join(bin, 'expect'), 0o755)
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, FAKE: fake, HOAI_SUPERVISED: '1', HOAI_SUPERVISED_ASSISTANT_ID: ID }
  const claim = join(stateDir, SUPERVISOR_FILE_NAME)
  return { root, home, cwd, fake, bin, launcher, stateDir, claim, env, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

type Box = ReturnType<typeof scratch>

async function until(check: () => boolean, what: string, ms = 15_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function pidIn(box: Box, name: string): number | null {
  const raw = existsSync(join(box.fake, name)) ? readFileSync(join(box.fake, name), 'utf8').trim() : ''
  return /^\d+$/.test(raw) ? Number(raw) : null
}

/** ps's state letter for a pid this test started, or null once it is gone. */
function stateOf(pid: number): string | null {
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  const stat = String(r.stdout ?? '').trim()
  return stat ? stat[0]! : null
}

function alive(proc: ChildProcess) {
  return proc.exitCode === null && proc.signalCode === null
}

/** The command line of a pid, or '' once it is gone. */
function commandOf(pid: number): string {
  return String(spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim()
}

/**
 * Ends what a red run left behind: only pids this test started and recorded, and only while
 * each still runs what this test started there (the expect names this scratch folder, claude is
 * the `sleep 600` it became), never a pid reused since.
 */
function endRecorded(box: Box, ...procs: ChildProcess[]) {
  for (const proc of procs) if (alive(proc)) proc.kill('SIGKILL')
  for (const [name, ours] of [
    ['expect.pid', (command: string) => command.includes(box.root)],
    ['claude.pid', (command: string) => command === 'sleep 600'],
  ] as const) {
    const pid = pidIn(box, name)
    if (pid === null || !ours(commandOf(pid))) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

function watch(proc: ChildProcess) {
  let out = ''
  proc.stdout?.on('data', (d) => (out += String(d)))
  proc.stderr?.on('data', (d) => (out += String(d)))
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })))
  return { proc, exited, output: () => out }
}

/** The REAL launcher, main() itself, at <launcher>/hoai-core.mjs (the script name the owner check reads). */
function realHoai(box: Box) {
  const path = join(box.launcher, 'hoai-core.mjs')
  const core = pathToFileURL(join(REPO, 'bin', 'hoai-core.mjs')).href
  writeFileSync(
    path,
    [
      `const core = await import(${JSON.stringify(core)})`,
      'const code = await core.main([], {',
      `  env: ${JSON.stringify(box.env)},`,
      `  home: ${JSON.stringify(box.home)},`,
      `  cwd: ${JSON.stringify(box.cwd)},`,
      `  scriptDir: ${JSON.stringify(join(REPO, 'bin'))},`,
      '  registerHooks: () => {},',
      '  preseedTrust: () => {},',
      '  listProcesses: () => [],',
      '  hasExpect: true,',
      '})',
      'process.exit(code)',
    ].join('\n'),
  )
  return watch(spawn(process.execPath, [path], { cwd: box.cwd, env: { ...process.env, ...box.env, PATH: `${box.env.PATH}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] }))
}

/**
 * A holder that never lets go by itself: an older launcher still running when
 * the fix lands. It claims the agent with the real supervisorFileBody, runs the
 * real supervised expect script (through FAKE/expect), has already spent its
 * stop (a TERM changes nothing), and lets go only when its expect exits, as
 * superviseClaude's finally does. Its loop keeps ticking, so no watchdog fires.
 */
function oldHolder(box: Box, stateDir = box.stateDir) {
  const path = join(box.launcher, 'hoai-core.mjs')
  const core = pathToFileURL(join(REPO, 'bin', 'hoai-core.mjs')).href
  const inventory = pathToFileURL(join(REPO, 'lib', 'agent-inventory.mjs')).href
  writeFileSync(
    path,
    [
      `import { spawn } from 'node:child_process'`,
      `import { rmSync, writeFileSync } from 'node:fs'`,
      `const core = await import(${JSON.stringify(core)})`,
      `const { readBootClock } = await import(${JSON.stringify(inventory)})`,
      `const claim = ${JSON.stringify(box.claim)}`,
      `writeFileSync(claim, core.supervisorFileBody(process.pid, new Date().toISOString(), readBootClock({ platform: process.platform })))`,
      `const script = core.buildGateAutoAcceptExpect({ claudePath: 'claude', args: [], supervised: { stateDir: ${JSON.stringify(stateDir)}, interactive: false, compact: '' } })`,
      `const child = spawn('expect', ['-c', script], { stdio: 'ignore' })`,
      `process.on('SIGTERM', () => console.log('holder got TERM'))`,
      `process.on('SIGHUP', () => {})`,
      `child.on('exit', () => { rmSync(claim, { force: true }); console.log('holder let go'); process.exit(0) })`,
      'setInterval(() => {}, 1000)',
    ].join('\n'),
  )
  return watch(spawn(process.execPath, [path], { cwd: box.cwd, env: { ...process.env, ...box.env }, stdio: ['ignore', 'pipe', 'pipe'] }))
}

/** The next launch, in this process: real process readers and the real kill, a fake claude spawn. */
async function launchAgainst(box: Box) {
  const spawns: string[][] = []
  const prints: string[] = []
  const code = await superviseClaude(['--dangerously-load-development-channels', 'server:bgos'], {
    platform: process.platform,
    env: { HOAI_SUPERVISED: '1', HOAI_SUPERVISED_ASSISTANT_ID: ID },
    home: box.home,
    cwd: box.cwd,
    scriptDir: join(REPO, 'bin'),
    hasExpect: true,
    listProcesses: () => [],
    print: (l: string) => prints.push(l),
    writeErr: () => {},
    takeoverConfirmMs: 1_500,
    takeoverPollMs: 250,
    takeoverTermWaitMs: 3_000,
    startWatchdog: () => ({ stop() {} }),
    spawnImpl: ((_file: string, args: readonly string[]) => {
      spawns.push([...args])
      const child = new EventEmitter() as EventEmitter & { kill: () => void; pid: number }
      child.pid = 0
      child.kill = () => setImmediate(() => child.emit('exit', null, 'SIGTERM'))
      setImmediate(() => child.emit('exit', 0, null))
      return child
    }) as never,
  } as never)
  return { code, spawns, prints }
}

const launchStatus = (box: Box) => (existsSync(join(box.stateDir, 'launch-status')) ? readFileSync(join(box.stateDir, 'launch-status'), 'utf8') : '')

test('the wedge: a supervised hoai stopped while its claude ends lets go of the agent by itself, and the next launch starts (main: exit 3 behind it for good)', { skip: SKIP, timeout: 60_000 }, async () => {
  const box = scratch()
  const a = realHoai(box)
  try {
    await until(() => pidIn(box, 'claude.pid') !== null && existsSync(box.claim), `the launcher to start its claude\n${a.output()}`)
    const claudePid = pidIn(box, 'claude.pid')!
    const expectPid = pidIn(box, 'expect.pid')!
    assert.equal(JSON.parse(readFileSync(box.claim, 'utf8')).pid, a.proc.pid, 'armed: the claim names the launcher')
    // run.sh's on_stop: tmux kill-server hangs the launcher up. The stop ends claude, and expect,
    // as on kc-server, neither exits nor reaps it.
    a.proc.kill('SIGHUP')
    process.kill(claudePid, 'SIGTERM')
    await until(() => stateOf(claudePid) === 'Z', 'claude to be a zombie under expect')
    assert.notEqual(stateOf(expectPid), null, 'expect is still there, over a zombie: the kc-server shape')
    const ended = await Promise.race([a.exited, new Promise((resolve) => setTimeout(() => resolve('still running'), 15_000))])
    // The relaunch systemd makes: on main this ended at once with already-supervised owner=<a>.
    const next = await launchAgainst(box)
    assert.equal(next.code, 0, `the next launch must start, not end as already-supervised behind pid ${a.proc.pid}:\n${next.prints.join('\n')}\n${launchStatus(box)}`)
    assert.equal(next.spawns.length, 1, next.prints.join('\n'))
    assert.notEqual(ended, 'still running', `the stopped launcher let go by itself\n${a.output()}`)
    assert.equal(stateOf(expectPid), null, 'its stuck expect is gone')
    assert.equal(stateOf(claudePid), null, 'and with it the zombie')
  } finally {
    endRecorded(box, a.proc)
    box.cleanup()
  }
})

for (const shape of ['claude-zombie', 'claude-missing'] as const) {
  test(`takeover: a holder whose expect runs no live claude (${shape === 'claude-zombie' ? 'a zombie claude' : 'no claude at all'}) is taken over, its stuck expect ended with it, and the agent launches`, { skip: SKIP, timeout: 60_000 }, async () => {
    const box = scratch()
    if (shape === 'claude-missing') writeFileSync(join(box.fake, 'expect-mode'), 'reap')
    const holder = oldHolder(box)
    try {
      await until(() => pidIn(box, 'claude.pid') !== null, `the holder to start its claude\n${holder.output()}`)
      const claudePid = pidIn(box, 'claude.pid')!
      const expectPid = pidIn(box, 'expect.pid')!
      process.kill(claudePid, 'SIGTERM')
      if (shape === 'claude-zombie') await until(() => stateOf(claudePid) === 'Z', 'claude to be a zombie under expect')
      else await until(() => stateOf(claudePid) === null, 'expect to reap claude and keep running with no child')
      assert.notEqual(stateOf(expectPid), null)
      const next = await launchAgainst(box)
      assert.equal(next.code, 0, `${next.prints.join('\n')}\n${launchStatus(box)}`)
      assert.equal(next.spawns.length, 1, next.prints.join('\n'))
      assert.ok(next.prints.some((l) => l.includes(`took over assistant ${ID} from launcher pid ${holder.proc.pid}`)), next.prints.join('\n'))
      assert.match(launchStatus(box), new RegExp(`outcome=took-over owner=${holder.proc.pid} reason=${shape}`), 'and the takeover is logged where status reads it')
      await Promise.race([holder.exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
      assert.equal(alive(holder.proc), false, 'the stale owner is gone')
      assert.equal(stateOf(expectPid), null, 'its stuck expect is gone')
      assert.equal(stateOf(claudePid), null, 'and no zombie is left')
    } finally {
      endRecorded(box, holder.proc)
      box.cleanup()
    }
  })
}

test('takeover control: a holder whose expect runs a LIVE claude stays the owner: exit 3, nothing signalled', { skip: SKIP, timeout: 60_000 }, async () => {
  const box = scratch()
  const holder = oldHolder(box)
  try {
    await until(() => pidIn(box, 'claude.pid') !== null, `the holder to start its claude\n${holder.output()}`)
    const claudePid = pidIn(box, 'claude.pid')!
    const expectPid = pidIn(box, 'expect.pid')!
    const next = await launchAgainst(box)
    assert.equal(next.code, EXIT_ALREADY_SUPERVISED, next.prints.join('\n'))
    assert.equal(next.spawns.length, 0)
    assert.ok(alive(holder.proc), 'the owner is untouched')
    assert.doesNotMatch(holder.output(), /holder got TERM/, 'never signalled')
    assert.equal(stateOf(expectPid) !== null && stateOf(expectPid) !== 'Z', true, 'its expect runs on')
    assert.equal(stateOf(claudePid) !== null && stateOf(claudePid) !== 'Z', true, 'and its claude')
    assert.ok(existsSync(box.claim))
  } finally {
    endRecorded(box, holder.proc)
    box.cleanup()
  }
})

test('takeover control: an expect over a zombie that names ANOTHER agent\'s state dir is not this agent\'s: exit 3, nothing signalled', { skip: SKIP, timeout: 60_000 }, async () => {
  const box = scratch()
  const holder = oldHolder(box, join(box.home, '.bgos-agent', '1104'))
  try {
    await until(() => pidIn(box, 'claude.pid') !== null, `the holder to start its claude\n${holder.output()}`)
    const claudePid = pidIn(box, 'claude.pid')!
    const expectPid = pidIn(box, 'expect.pid')!
    process.kill(claudePid, 'SIGTERM')
    await until(() => stateOf(claudePid) === 'Z', 'claude to be a zombie under expect')
    const next = await launchAgainst(box)
    assert.equal(next.code, EXIT_ALREADY_SUPERVISED, next.prints.join('\n'))
    assert.equal(next.spawns.length, 0)
    assert.ok(alive(holder.proc), 'the owner is untouched')
    assert.doesNotMatch(holder.output(), /holder got TERM/, 'never signalled')
    assert.notEqual(stateOf(expectPid), null, 'its expect is untouched')
  } finally {
    endRecorded(box, holder.proc)
    box.cleanup()
  }
})
