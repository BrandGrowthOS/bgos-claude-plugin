/**
 * bin/bgos-agent's per-agent install lock, RUN, not read (plugin-supervisor
 * review F6).
 *
 * The daemon's reconcile and the watcher's sweep can both decide to install
 * the same agent in the same minute, so an install takes
 * ~/.bgos-agent/<id>.install.lock first. Two defects in the takeover of a
 * lock older than ten minutes:
 *   - it was check, then rm, then mkdir: a contender that checked the OLD lock
 *     and was then descheduled removed the FRESH lock another contender had
 *     just taken, and both installed at once. Now the takeover is serialized
 *     (mkdir of <lock>.takeover) and the lock is judged stale again under it;
 *   - age alone made a live install that ran long (a hung git clone) lose its
 *     lock. Now the holder is named by its pid AND that pid's start time, and a
 *     holder that is still running is never taken over (a reused pid, with
 *     another start time, is not the holder).
 *
 * The lock section of the script is cut out by its markers and run with bash
 * in a temp dir. The only fake is `find`, which can hold one contender between
 * its age check and what it does next, so the race is reproduced every time.
 *
 * Run: npx tsx --test test/bgos-agent.lock.test.ts
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import { resolvePosixBash } from './helpers/posix-bash.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const agentSource = readFileSync(join(repoRoot, 'bin', 'bgos-agent'), 'utf8')
const BASH = process.platform === 'win32' ? null : resolvePosixBash()

function ready(t: TestContext): boolean {
  if (BASH) return true
  t.skip(process.platform === 'win32' ? 'bin/bgos-agent is the macOS and Linux installer' : 'no bash')
  return false
}

/** The lock section of bin/bgos-agent: from its header to the validators that follow it. */
function lockSource(): string {
  const start = agentSource.indexOf('# --- one install per agent at a time')
  const end = agentSource.indexOf('# --- validators')
  assert.ok(start >= 0 && end > start, 'the lock section has the markers this harness cuts on')
  return agentSource.slice(start, end)
}

/** `ps -o lstart=` of a pid, whitespace squeezed: what the lock records as its holder's start. */
function startedOf(pid: number): string {
  const out = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).stdout
  return String(out ?? '').trim().replace(/\s+/g, ' ')
}

function box() {
  const root = mkdtempSync(join(tmpdir(), 'hoai-lock-'))
  const stateRoot = join(root, '.bgos-agent')
  const fake = join(root, 'fake')
  const bin = join(root, 'bin')
  for (const d of [stateRoot, fake, bin]) mkdirSync(d, { recursive: true })
  const lock = join(stateRoot, '42.install.lock')
  // Contender B is held up once, until A holds the lock, at the step DELAY_AT names:
  //   check     its age check has been answered (from the OLD lock) but not yet returned;
  //   takeover  it has judged the old lock stale and is about to start taking it over.
  // Everything else is the real tool.
  const hold = `if [ "\${WHO:-}" = B ] && [ ! -f "$FAKE/b-delayed" ]; then
  : > "$FAKE/b-delayed"
  while [ ! -f "$FAKE/holds-A" ]; do /bin/sleep 0.02; done
fi`
  writeFileSync(
    join(bin, 'find'),
    `#!/bin/sh
out="$(/usr/bin/find "$@" 2>/dev/null)"
[ "\${DELAY_AT:-check}" = check ] && { ${hold}
}
[ -n "$out" ] && printf '%s\\n' "$out"
exit 0
`,
  )
  writeFileSync(
    join(bin, 'mkdir'),
    `#!/bin/sh
for last in "$@"; do :; done
case "$last" in
  *.takeover) [ "\${DELAY_AT:-check}" = takeover ] && { ${hold}
} ;;
esac
exec /bin/mkdir "$@"
`,
  )
  chmodSync(join(bin, 'find'), 0o755)
  chmodSync(join(bin, 'mkdir'), 0o755)
  const script = join(root, 'contender.sh')
  writeFileSync(
    script,
    [
      'set -euo pipefail',
      'STATE_ROOT="$1"',
      'statedir_for() { printf \'%s/%s\' "$STATE_ROOT" "$1"; }',
      'warn() { printf \'! %s\\n\' "$*" >&2; }',
      lockSource(),
      'if acquire_install_lock 42; then',
      '  echo ACQUIRED',
      '  : > "$FAKE/holds-$WHO"',
      '  if [ -n "${HOLD_UNTIL:-}" ]; then while [ ! -f "$HOLD_UNTIL" ]; do /bin/sleep 0.02; done; fi',
      '  if [ "$(head -n 1 "$INSTALL_LOCK/pid" 2>/dev/null)" = "$$" ]; then echo STILL-MINE; else echo STOLEN; fi',
      'else',
      '  echo STOOD-DOWN',
      'fi',
      '',
    ].join('\n'),
  )
  const env = (who: string, extra: Record<string, string> = {}) => ({ PATH: `${bin}:/usr/bin:/bin`, FAKE: fake, WHO: who, HOME: root, ...extra })
  const run = (who: string, extra: Record<string, string> = {}) => {
    const r = spawnSync(BASH!, [script, stateRoot], { encoding: 'utf8', env: env(who, extra), timeout: 30_000 })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const start = (who: string, extra: Record<string, string> = {}) => {
    const child = spawn(BASH!, [script, stateRoot], { env: env(who, extra) })
    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (out += String(d)))
    const done = new Promise<string>((resolve) => child.on('close', () => resolve(out)))
    return { child, done }
  }
  /** A lock left by an install, aged past the stale limit, holding the given pid file. */
  const staleLock = (pidFile: string | null) => {
    mkdirSync(lock, { recursive: true })
    if (pidFile !== null) writeFileSync(join(lock, 'pid'), pidFile)
    const old = new Date(Date.now() - 11 * 60_000)
    utimesSync(lock, old, old)
  }
  return { root, fake, lock, run, start, staleLock, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

async function untilExists(path: string, what: string) {
  const deadline = Date.now() + 10_000
  while (!existsSync(path)) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

for (const delayAt of ['check', 'takeover'] as const) {
  test(`two contenders on one stale lock: the one held up ${delayAt === 'check' ? 'after its age check' : 'after judging the lock stale, before taking it over'} does NOT remove the fresh lock the other has just taken`, async (t) => {
    if (!ready(t)) return
    const b = box()
    t.after(b.cleanup)
    b.staleLock(null)
    const release = join(b.fake, 'release-A')
    // B goes first and is held up at that step.
    const contenderB = b.start('B', { DELAY_AT: delayAt })
    t.after(() => contenderB.child.kill('SIGKILL'))
    await untilExists(join(b.fake, 'b-delayed'), 'B to have judged the old lock stale')
    // A takes the stale lock over and holds it.
    const contenderA = b.start('A', { HOLD_UNTIL: release })
    t.after(() => contenderA.child.kill('SIGKILL'))
    const outB = await contenderB.done
    writeFileSync(release, '')
    const outA = await contenderA.done
    assert.match(outA, /ACQUIRED/)
    assert.match(outB, /STOOD-DOWN/, `B must stand down, not take A's fresh lock: ${outB}`)
    assert.match(outA, /STILL-MINE/, 'A held its lock throughout')
    assert.equal(existsSync(b.lock), false, 'and released it on the way out')
    assert.equal(existsSync(`${b.lock}.takeover`), false, 'no takeover marker is left behind')
  })
}

test('a lock older than ten minutes whose install is STILL RUNNING (same pid, same start time) is never taken over', (t) => {
  if (!ready(t)) return
  const b = box()
  t.after(b.cleanup)
  // This test process stands in for a hung install: alive, with the start time it really has.
  b.staleLock(`${process.pid}\n${startedOf(process.pid)}\n`)
  const r = b.run('A')
  assert.match(r.out, /STOOD-DOWN/, r.out)
  assert.equal(readFileSync(join(b.lock, 'pid'), 'utf8').split('\n')[0], String(process.pid), 'its lock is untouched')
})

test('a stale lock is taken over when its holder is gone: a dead pid, a pid reused by another process (other start time), or no pid file at all', (t) => {
  if (!ready(t)) return
  const dead = spawnSync('/bin/sh', ['-c', 'echo $$']).stdout.toString().trim()
  const cases: Array<[string, string | null]> = [
    ['dead pid', `${dead}\n${startedOf(process.pid)}\n`],
    ['reused pid', `${process.pid}\nMon Jan  5 00:00:00 2026\n`],
    ['no pid file (an install from before the start time was recorded)', null],
    ['a pid with no start time', `${process.pid}\n`],
  ]
  for (const [name, pidFile] of cases) {
    const b = box()
    try {
      b.staleLock(pidFile)
      const r = b.run('A')
      assert.match(r.out, /ACQUIRED/, `${name}: ${r.out}`)
      assert.match(r.out, /removing a stale install lock for agent 42/, name)
    } finally {
      b.cleanup()
    }
  }
})

test('the lock records its holder as pid and start time, which is what the next contender checks', (t) => {
  if (!ready(t)) return
  const b = box()
  t.after(b.cleanup)
  const release = join(b.fake, 'release-A')
  const a = b.start('A', { HOLD_UNTIL: release })
  t.after(() => a.child.kill('SIGKILL'))
  return untilExists(join(b.fake, 'holds-A'), 'A to hold the lock').then(async () => {
    const [pid, started] = readFileSync(join(b.lock, 'pid'), 'utf8').split('\n')
    assert.equal(pid, String(a.child.pid))
    assert.equal(started, startedOf(a.child.pid!))
    writeFileSync(release, '')
    await a.done
  })
})

test('a takeover marker left by a contender killed mid-takeover is cleared after a minute: that attempt stands down, the next one proceeds', (t) => {
  if (!ready(t)) return
  const b = box()
  t.after(b.cleanup)
  b.staleLock(null)
  const marker = `${b.lock}.takeover`
  mkdirSync(marker)
  // A fresh marker: another contender is taking over right now.
  assert.match(b.run('A').out, /STOOD-DOWN/)
  assert.ok(existsSync(marker), 'a live takeover is left alone')
  const old = new Date(Date.now() - 2 * 60_000)
  utimesSync(marker, old, old)
  assert.match(b.run('A').out, /STOOD-DOWN/)
  assert.equal(existsSync(marker), false, 'an abandoned one is cleared')
  assert.match(b.run('A').out, /ACQUIRED/)
})
