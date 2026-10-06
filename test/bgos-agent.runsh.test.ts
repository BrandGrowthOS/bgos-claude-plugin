/**
 * run.sh, supervisor generation 2 (design section 4), RUN, not read.
 *
 * run.sh is what launchd and systemd execute on the owner's machine, so these
 * tests generate it with the real bin/bgos-agent write_run_sh and run it with
 * bash in a temp HOME. Every outside effect is a recording fake on PATH: tmux,
 * node (except the root lookup, which hands over to the real node so the
 * actual JS runs), ps, lsof, uname and sleep. PATH holds ONLY those fakes plus
 * a short allowlist of real tools (date, cat, awk, sed, head, readlink, rm), so
 * no real tmux, launchctl or claude can ever be reached from here.
 *
 * Pinned, by what run.sh DID:
 *   - with tmux: hoai (bin/hoai-core.mjs from the CURRENT plugin root) in a
 *     detached session on the agent's OWN socket, -c the workdir, HOAI_SUPERVISED
 *     and BGOS_TMUX_SESSION / BGOS_TMUX_SOCKET in its environment (finding 8:
 *     what turns remote compact ON), 200x50 manual, polled until it ends;
 *   - the root resolved at every launch: a marketplace agent from its install
 *     record (user scope, honouring CLAUDE_CONFIG_DIR), a clone from its
 *     checkout; none found is plugin-root-missing in launch-status and a
 *     nonzero exit, never a guess;
 *   - a stale server on the agent's socket killed BEFORE the singleton wait;
 *   - TERM stops the agent: the tmux server (or the foreground hoai) is ended
 *     and run.sh exits 0 at once;
 *   - no tmux: hoai in the foreground, launch-status compact=off reason=no-tmux;
 *   - the singleton wait and the WEDGED accounting still work, interruptibly.
 *
 * Run: npx tsx --test test/bgos-agent.runsh.test.ts
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import { assertBashParses, resolvePosixBash } from './helpers/posix-bash.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const agentSource = readFileSync(join(repoRoot, 'bin', 'bgos-agent'), 'utf8')
// Absolute, because run.sh runs on a PATH of fakes only (resolvePosixBash may answer a bare `bash`).
const BASH = (() => {
  const found = process.platform === 'win32' ? null : resolvePosixBash()
  if (!found || found.startsWith('/')) return found
  return String(spawnSync(found, ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout ?? '').trim() || null
})()
const TOOLS = ['date', 'cat', 'awk', 'sed', 'head', 'readlink', 'rm']

function ready(t: TestContext): boolean {
  if (BASH) return true
  t.skip(process.platform === 'win32' ? 'run.sh is the macOS and Linux supervisor; Windows runs hoai --keep-alive' : 'no bash')
  return false
}

/** write_run_sh, cut out of bin/bgos-agent: from its first line to the `}` after its heredoc. */
function writeRunShSource(): string {
  const lines = agentSource.split('\n')
  const start = lines.findIndex((l) => l.startsWith('write_run_sh() {'))
  assert.ok(start >= 0, 'write_run_sh not found')
  const term = lines.findIndex((l, i) => i > start && l === 'SH')
  const end = lines.findIndex((l, i) => i > term && l === '}')
  assert.ok(term > start && end > term, 'write_run_sh has the shape this harness cuts')
  return lines.slice(start, end + 1).join('\n')
}

function realTool(name: string): string {
  return String(spawnSync(BASH!, ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout ?? '').trim()
}

const RECORD = (name: string) => `{ printf '%s' '${name}'; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "$LOG"`

interface Box {
  root: string
  home: string
  state: string
  workdir: string
  realWorkdir: string
  fake: string
  fakeNode: string
  log: string
  cloneRoot: string
  mktRoot: string
  generate: (topology: 'marketplace' | 'clone', opts?: { pluginKey?: string; cloneRoot?: string }) => string
  env: (extra?: Record<string, string>) => Record<string, string>
  calls: () => string[][]
  agentLog: () => string
  status: () => string
  cleanup: () => void
}

function sandbox({ tmux = true }: { tmux?: boolean } = {}): Box {
  const root = mkdtempSync(join(tmpdir(), 'hoai-runsh-'))
  const home = join(root, 'home')
  const state = join(home, '.bgos-agent', '42')
  // A space in the workdir: every path run.sh hands on must survive it.
  const workdir = join(root, 'agent work')
  const bin = join(root, 'fakebin')
  const tools = join(root, 'tools')
  const fake = join(root, 'fake')
  const log = join(root, 'calls.log')
  for (const d of [state, workdir, bin, tools, fake]) mkdirSync(d, { recursive: true })
  const realWorkdir = realpathSync(workdir)
  for (const name of TOOLS) {
    const real = realTool(name)
    assert.ok(real, `${name} must exist on this machine`)
    symlinkSync(real, join(tools, name))
  }
  const script = (name: string, body: string) => {
    const path = join(bin, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }
  if (tmux) {
    script(
      'tmux',
      `${RECORD('tmux')}
sub=""
[ "$1" = "-L" ] && sub="$3"
case "$sub" in
  list-sessions) [ -f "$FAKE/stale" ] && exit 0; exit 1 ;;
  kill-server) rm -f "$FAKE/stale" "$FAKE/up-forever"; exit 0 ;;
  new-session) [ -f "$FAKE/new-session-rc" ] && exit "$(cat "$FAKE/new-session-rc")"; exit 0 ;;
  has-session)
    [ -f "$FAKE/up-forever" ] && exit 0
    n=$(cat "$FAKE/up-count" 2>/dev/null || echo 0)
    if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$FAKE/up-count"; exit 0; fi
    exit 1 ;;
  *) exit 0 ;;
esac`,
    )
  }
  const fakeNode = script(
    'node',
    `if [ "$1" = "-e" ]; then
  { printf 'node-resolve\\t%s\\t%s\\n' "$3" "$4"; } >> "$LOG"
  exec "${process.execPath}" "$@"
fi
{ printf 'node'; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\tHOAI_SUPERVISED=%s\\tHOAI_SUPERVISED_ASSISTANT_ID=%s\\tBGOS_TMUX_SESSION=%s\\n' "\${HOAI_SUPERVISED-unset}" "\${HOAI_SUPERVISED_ASSISTANT_ID-unset}" "\${BGOS_TMUX_SESSION-unset}"; } >> "$LOG"
if [ -f "$FAKE/node-block" ]; then
  trap 'echo node-got-TERM >> "$LOG"; exit 143' TERM
  while :; do /bin/sleep 0.05; done
fi
exit "$(cat "$FAKE/node-rc" 2>/dev/null || echo 0)"`,
  )
  script(
    'ps',
    `${RECORD('ps')}
n=$(cat "$FAKE/ps-count" 2>/dev/null || echo 0)
if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$FAKE/ps-count"; echo "  4242 /usr/local/bin/claude"; fi
exit 0`,
  )
  script('lsof', `${RECORD('lsof')}\nprintf 'p4242\\nn%s\\n' "$FAKE_WORKDIR"`)
  script('uname', 'echo Darwin')
  // Instant by default; a REAL sleep when asked, so a wait that is not interruptible shows.
  script('sleep', `${RECORD('sleep')}\n[ -f "$FAKE/sleep-real" ] && exec /bin/sleep "$1"\nexec /bin/sleep 0.02`)

  const cloneRoot = join(root, 'clone')
  mkdirSync(join(cloneRoot, 'bin'), { recursive: true })
  writeFileSync(join(cloneRoot, 'bin', 'hoai-core.mjs'), '// stand-in\n')
  const mktRoot = join(home, '.claude', 'plugins', 'cache', 'hoai', 'hoai', '0.62.0')
  mkdirSync(join(mktRoot, 'bin'), { recursive: true })
  writeFileSync(join(mktRoot, 'bin', 'hoai-core.mjs'), '// stand-in\n')

  const genFile = join(root, 'gen.sh')
  writeFileSync(genFile, ['set -euo pipefail', 'SUPERVISOR_GENERATION=2', writeRunShSource(), 'write_run_sh "$@"', ''].join('\n'))
  const generate = (topology: 'marketplace' | 'clone', opts: { pluginKey?: string; cloneRoot?: string } = {}) => {
    const out = join(state, 'run.sh')
    const r = spawnSync(BASH!, [genFile, out, state, '42', fakeNode, topology, topology === 'marketplace' ? (opts.pluginKey ?? 'hoai@hoai') : '', opts.cloneRoot ?? cloneRoot], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return out
  }
  const env = (extra: Record<string, string> = {}) => ({
    HOME: home,
    PATH: `${bin}:${tools}`,
    LOG: log,
    FAKE: fake,
    FAKE_WORKDIR: realWorkdir,
    ...extra,
  })
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'))
      : []
  const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
  return {
    root,
    home,
    state,
    workdir,
    realWorkdir,
    fake,
    fakeNode,
    log,
    cloneRoot,
    mktRoot,
    generate,
    env,
    calls,
    agentLog: () => read(join(state, 'agent.log')),
    status: () => read(join(state, 'launch-status')).trim(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function runSync(box: Box, runSh: string, extra: Record<string, string> = {}) {
  const r = spawnSync(BASH!, [runSh], { cwd: box.workdir, env: box.env(extra), encoding: 'utf8', timeout: 30_000 })
  // A run that never got going is a harness fault, reported as one, not as a wrong exit code.
  assert.ok(r.status !== null, `run.sh did not exit normally: signal ${r.signal}, ${r.error ?? ''} ${r.stderr}`)
  return r
}

function installRecord(configDir: string, plugins: Record<string, unknown>) {
  mkdirSync(join(configDir, 'plugins'), { recursive: true })
  writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }))
}

const indexOf = (calls: string[][], pred: (c: string[]) => boolean) => calls.findIndex(pred)
const isTmux = (sub: string) => (c: string[]) => c[0] === 'tmux' && c[1] === '-L' && c[2] === 'hoai-42' && c[3] === sub

test('tmux + marketplace: the stale server goes first, then the singleton wait, then hoai from the CURRENT root in a detached session on the agent\'s own socket with the compact env', (t) => {
  if (!ready(t)) return
  const box = sandbox()
  t.after(box.cleanup)
  // A project-scope record first: the user-scope one is the one a launch must take.
  installRecord(join(box.home, '.claude'), { 'hoai@hoai': [{ scope: 'project', installPath: '/elsewhere' }, { scope: 'user', installPath: box.mktRoot }] })
  writeFileSync(join(box.fake, 'stale'), '')
  writeFileSync(join(box.fake, 'up-count'), '2')
  const runSh = box.generate('marketplace')
  assertBashParses(BASH!, runSh)
  const r = runSync(box, runSh)
  assert.equal(r.status, 0, box.agentLog())
  const calls = box.calls()
  const stale = indexOf(calls, isTmux('list-sessions'))
  const killed = indexOf(calls, isTmux('kill-server'))
  const singleton = indexOf(calls, (c) => c[0] === 'ps')
  const resolved = indexOf(calls, (c) => c[0] === 'node-resolve')
  const launched = indexOf(calls, isTmux('new-session'))
  assert.ok(stale >= 0 && killed > stale, 'a server left on the socket is ended')
  assert.ok(singleton > killed, 'BEFORE the singleton wait, which would otherwise wait on our own orphan')
  assert.ok(resolved > singleton && launched > resolved, 'the root is resolved at this launch, then hoai starts')
  assert.deepEqual(calls[resolved]!.slice(1), [join(box.home, '.claude', 'plugins', 'installed_plugins.json'), 'hoai@hoai'])
  assert.deepEqual(calls[launched], [
    'tmux', '-L', 'hoai-42', 'new-session', '-d', '-s', 'hoai-42', '-x', '200', '-y', '50', '-c', box.realWorkdir,
    '/usr/bin/env', 'HOAI_SUPERVISED=1', 'HOAI_SUPERVISED_ASSISTANT_ID=42', 'BGOS_TMUX_SESSION=hoai-42', 'BGOS_TMUX_SOCKET=hoai-42',
    box.fakeNode, join(box.mktRoot, 'bin', 'hoai-core.mjs'),
  ])
  assert.deepEqual(calls[launched + 1], ['tmux', '-L', 'hoai-42', 'set-option', '-g', 'window-size', 'manual'])
  assert.deepEqual(calls[launched + 2], ['tmux', '-L', 'hoai-42', 'resize-window', '-t', '=hoai-42:', '-x', '200', '-y', '50'])
  // Polled until the session ends (2 up, then gone), each nap a `sleep 5 & wait`.
  const polls = calls.filter(isTmux('has-session'))
  assert.equal(polls.length, 3)
  assert.ok(polls.every((c) => c[4] === '-t' && c[5] === '=hoai-42'))
  assert.equal(calls.filter((c) => c[0] === 'sleep' && c[1] === '5').length, 2)
  assert.ok(!calls.some((c) => c[0] === 'node'), 'hoai itself runs inside tmux, never beside it')
  assert.match(box.agentLog(), /running in tmux session hoai-42 \(remote compact ON/)
  assert.match(box.agentLog(), /tmux server from an earlier run is still on socket hoai-42/)
  assert.equal(readFileSync(join(box.state, 'failcount'), 'utf8').trim(), '1', 'a lap under 20 s is counted')
})

test('tmux + clone: the root is the checkout recorded at install, no install record is read, and a clean socket is left alone', (t) => {
  if (!ready(t)) return
  const box = sandbox()
  t.after(box.cleanup)
  const runSh = box.generate('clone')
  const r = runSync(box, runSh)
  assert.equal(r.status, 0, box.agentLog())
  const calls = box.calls()
  assert.equal(indexOf(calls, isTmux('kill-server')), -1)
  assert.equal(indexOf(calls, (c) => c[0] === 'node-resolve'), -1)
  const launched = calls.find(isTmux('new-session'))!
  assert.equal(launched.at(-1), join(box.cloneRoot, 'bin', 'hoai-core.mjs'))
})

test('marketplace under a custom CLAUDE_CONFIG_DIR: the install record is read from THAT config dir', (t) => {
  if (!ready(t)) return
  const box = sandbox()
  t.after(box.cleanup)
  const custom = join(box.root, 'custom claude')
  installRecord(custom, { 'hoai@hoai': [{ scope: 'user', installPath: box.mktRoot }] })
  const r = runSync(box, box.generate('marketplace'), { CLAUDE_CONFIG_DIR: custom })
  assert.equal(r.status, 0, box.agentLog())
  const calls = box.calls()
  assert.equal(calls.find((c) => c[0] === 'node-resolve')?.[1], join(custom, 'plugins', 'installed_plugins.json'))
  assert.equal(calls.find(isTmux('new-session'))?.at(-1), join(box.mktRoot, 'bin', 'hoai-core.mjs'))
})

test('no plugin root is a NAMED failure: plugin-root-missing in launch-status, a nonzero exit, and nothing launched', (t) => {
  if (!ready(t)) return
  const cases: Array<{ name: string; setup: (box: Box) => string; topology: RegExp }> = [
    { name: 'no install record at all', setup: (box) => box.generate('marketplace'), topology: /topology=marketplace key=hoai@hoai root="none"/ },
    {
      name: 'a record whose directory has no hoai',
      setup: (box) => {
        installRecord(join(box.home, '.claude'), { 'hoai@hoai': [{ scope: 'user', installPath: join(box.root, 'gone') }] })
        return box.generate('marketplace')
      },
      topology: /topology=marketplace key=hoai@hoai root=".*gone"/,
    },
    {
      name: 'a record for another marketplace only',
      setup: (box) => {
        installRecord(join(box.home, '.claude'), { 'hoai@other': [{ scope: 'user', installPath: box.mktRoot }] })
        return box.generate('marketplace')
      },
      topology: /topology=marketplace key=hoai@hoai/,
    },
    { name: 'a clone checkout that is gone', setup: (box) => box.generate('clone', { cloneRoot: join(box.root, 'deleted checkout') }), topology: /topology=clone key=none root=".*deleted checkout"/ },
  ]
  for (const c of cases) {
    const box = sandbox()
    try {
      const r = runSync(box, c.setup(box))
      assert.notEqual(r.status, 0, c.name)
      assert.match(box.status(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} outcome=plugin-root-missing /, c.name)
      assert.match(box.status(), c.topology, c.name)
      assert.equal(box.calls().filter(isTmux('new-session')).length, 0, c.name)
      assert.ok(!box.calls().some((call) => call[0] === 'node'), c.name)
      assert.match(box.agentLog(), /cannot launch agent 42/)
    } finally {
      box.cleanup()
    }
  }
})

test('no tmux on the host: hoai runs in the foreground with HOAI_SUPERVISED and no tmux env, launch-status says compact=off reason=no-tmux, and its exit is run.sh\'s', (t) => {
  if (!ready(t)) return
  const box = sandbox({ tmux: false })
  t.after(box.cleanup)
  writeFileSync(join(box.fake, 'node-rc'), '7')
  const r = runSync(box, box.generate('clone'))
  assert.equal(r.status, 7)
  const node = box.calls().find((c) => c[0] === 'node')
  assert.deepEqual(node, ['node', join(box.cloneRoot, 'bin', 'hoai-core.mjs'), 'HOAI_SUPERVISED=1', 'HOAI_SUPERVISED_ASSISTANT_ID=42', 'BGOS_TMUX_SESSION=unset'])
  assert.match(box.status(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} outcome=starting compact=off reason=no-tmux$/)
  assert.match(box.agentLog(), /tmux is not installed: running agent 42 without it, so remote compact is OFF/)
})

function untilFile(path: string, pattern: RegExp, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (existsSync(path) && pattern.test(readFileSync(path, 'utf8'))) return resolve()
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`))
      setTimeout(tick, 20)
    }
    tick()
  })
}

function runAsync(box: Box, runSh: string) {
  const child = spawn(BASH!, [runSh], { cwd: box.workdir, env: box.env(), stdio: 'ignore' })
  let sentAt = 0
  const exited = new Promise<{ code: number | null; ms: number }>((resolve) => {
    child.on('exit', (code) => resolve({ code, ms: sentAt ? Date.now() - sentAt : -1 }))
  })
  const term = () => {
    sentAt = Date.now()
    child.kill('SIGTERM')
  }
  return { child, exited, term }
}

test('TERM (kickstart -k, bootout, systemctl restart, uninstall) ends the agent\'s tmux server and run.sh exits 0 at once', async (t) => {
  if (!ready(t)) return
  const box = sandbox()
  t.after(box.cleanup)
  writeFileSync(join(box.fake, 'up-forever'), '')
  // Real 5 s naps: the stop must not wait for the current one to finish.
  writeFileSync(join(box.fake, 'sleep-real'), '')
  const run = runAsync(box, box.generate('clone'))
  t.after(() => run.child.kill('SIGKILL'))
  await untilFile(box.log, /has-session/, 'the poll loop')
  run.term()
  const { code, ms } = await run.exited
  assert.equal(code, 0)
  assert.ok(ms < 3_000, `the trap ran at once, not after a nap (${ms} ms)`)
  const calls = box.calls()
  const launched = indexOf(calls, isTmux('new-session'))
  const killed = calls.findIndex((c, i) => i > launched && isTmux('kill-server')(c))
  assert.ok(launched >= 0 && killed > launched, 'the server is killed after it was started, by the trap')
  assert.match(box.agentLog(), /stop requested: ending agent 42/)
})

test('TERM with no tmux stops the foreground hoai too, and run.sh exits 0', async (t) => {
  if (!ready(t)) return
  const box = sandbox({ tmux: false })
  t.after(box.cleanup)
  writeFileSync(join(box.fake, 'node-block'), '')
  const run = runAsync(box, box.generate('clone'))
  t.after(() => run.child.kill('SIGKILL'))
  await untilFile(box.log, /^node\t/m, 'hoai to start')
  run.term()
  const { code } = await run.exited
  assert.equal(code, 0)
  await untilFile(box.log, /node-got-TERM/, 'hoai to be told to stop')
})

test('the singleton wait still holds the launch while a claude sits in this workdir, and says so', (t) => {
  if (!ready(t)) return
  const box = sandbox()
  t.after(box.cleanup)
  writeFileSync(join(box.fake, 'ps-count'), '2')
  const r = runSync(box, box.generate('clone'))
  assert.equal(r.status, 0, box.agentLog())
  const calls = box.calls()
  assert.ok(calls.some((c) => c[0] === 'lsof' && c.includes('4242')), 'the incumbent\'s cwd was read')
  const waited = indexOf(calls, (c) => c[0] === 'sleep' && c[1] === '5')
  assert.ok(waited >= 0 && waited < indexOf(calls, isTmux('new-session')), 'it waited before launching')
  assert.match(box.agentLog(), /waiting for an incumbent claude in .*agent work to exit before taking over/)
})

test('WEDGED: the third fast lap is named with the measured reason, and the back-off sleep is interruptible', (t) => {
  if (!ready(t)) return
  const box = sandbox()
  t.after(box.cleanup)
  writeFileSync(join(box.state, 'failcount'), '2\n')
  const r = runSync(box, box.generate('marketplace'))
  assert.notEqual(r.status, 0)
  assert.equal(readFileSync(join(box.state, 'failcount'), 'utf8').trim(), '3')
  assert.match(box.agentLog(), /starting agent \(consecutive fast-fails: 2\)/)
  assert.match(box.agentLog(), /WEDGED: agent exited after \d+s \(plugin root missing\), 3 times in a row\./)
  assert.match(box.agentLog(), /Last launch: .*outcome=plugin-root-missing/)
  assert.ok(box.calls().some((c) => c[0] === 'sleep' && c[1] === '60'))
  assert.doesNotMatch(box.agentLog(), /syntax error|command not found|unbound variable|bad substitution/)
})
