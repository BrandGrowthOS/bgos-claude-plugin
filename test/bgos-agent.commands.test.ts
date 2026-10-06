/**
 * bin/bgos-agent's commands around supervisor generation 2 (design section 4),
 * run for real: uninstall, attach and status.
 *
 *   - uninstall keeps the agent's pinned session id (finding 7: the next
 *     launch, by hand or by a supervisor installed again, resumes the same
 *     conversation), removes everything else, removes the service file BEFORE
 *     it stops the job (from inside the agent the stop ends this very process),
 *     and ends the agent's own tmux server;
 *   - attach opens the agent's tmux session on its own socket, and says why
 *     when there is none;
 *   - status says whether that session is up, which is whether remote compact
 *     can reach the agent (finding 8), and which supervisor generation it is.
 *
 * HOME is a temp dir and tmux, launchctl, systemctl and loginctl are recording
 * fakes FIRST on PATH, so no real service or tmux server is ever touched.
 *
 * Run: npx tsx --test test/bgos-agent.commands.test.ts
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import { resolvePosixBash } from './helpers/posix-bash.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const agentBin = join(repoRoot, 'bin', 'bgos-agent')
const BASH = process.platform === 'win32' ? null : resolvePosixBash()
const OS = process.platform === 'darwin' ? 'Darwin' : 'Linux'

function ready(t: TestContext): boolean {
  if (BASH) return true
  t.skip(process.platform === 'win32' ? 'bin/bgos-agent is the macOS and Linux installer' : 'no bash')
  return false
}

function machine() {
  const home = mkdtempSync(join(tmpdir(), 'hoai-cmds-'))
  const shims = join(home, 'shims')
  const fake = join(home, 'fake')
  const log = join(home, 'calls.log')
  mkdirSync(shims)
  mkdirSync(fake)
  const plist = join(home, 'Library', 'LaunchAgents', 'ai.bgos.agent.42.plist')
  const unit = join(home, '.config', 'systemd', 'user', 'bgos-agent-42.service')
  const shim = (name: string, body: string) => {
    // Each call records whether the service files still exist at that moment, so the ORDER is observable.
    writeFileSync(
      join(shims, name),
      `#!/bin/sh\n{ printf '%s' '${name}'; for a in "$@"; do printf ' %s' "$a"; done; [ -e '${plist}' ] && printf ' [plist]'; [ -e '${unit}' ] && printf ' [unit]'; printf '\\n'; } >> '${log}'\n${body}\n`,
    )
    chmodSync(join(shims, name), 0o755)
  }
  shim('tmux', `case "$3" in has-session) [ -f '${fake}/up' ] && exit 0; exit 1 ;; *) exit 0 ;; esac`)
  shim('launchctl', '[ "$1" = "print" ] && exit 1\nexit 0')
  shim('systemctl', 'exit 0')
  shim('loginctl', 'exit 0')
  const run = (args: string[]) => {
    const r = spawnSync(BASH!, [agentBin, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { HOME: home, USER: 'kc', LOGNAME: 'kc', NO_COLOR: '1', PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin` },
    })
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
  }
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])
  return { home, fake, plist, unit, state: join(home, '.bgos-agent', '42'), run, calls, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

test('uninstall keeps the pinned session id and nothing else, removes the service file before it stops the job, and ends the agent\'s own tmux server', (t) => {
  if (!ready(t)) return
  const m = machine()
  t.after(m.cleanup)
  const pin = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n'
  mkdirSync(join(m.state, 'logs'), { recursive: true })
  for (const f of ['run.sh', 'launch-status', 'failcount', 'supervisor-generation', 'installed-at', 'supervisor.json', '.hidden']) {
    writeFileSync(join(m.state, f), 'x')
  }
  writeFileSync(join(m.state, 'session-id'), pin)
  mkdirSync(dirname(m.plist), { recursive: true })
  mkdirSync(dirname(m.unit), { recursive: true })
  writeFileSync(m.plist, '<plist/>')
  writeFileSync(m.unit, '[Unit]')
  const r = m.run(['uninstall', '--assistant', '42'])
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(readdirSync(m.state), ['session-id'], 'only the pin survives')
  assert.equal(readFileSync(join(m.state, 'session-id'), 'utf8'), pin, 'byte for byte')
  assert.match(r.out, /its pinned session id is kept/)
  const calls = m.calls()
  const stop = OS === 'Darwin'
    ? calls.findIndex((c) => c.startsWith('launchctl bootout gui/'))
    : calls.findIndex((c) => c.startsWith('systemctl --user stop bgos-agent-42'))
  assert.ok(stop >= 0, calls.join('\n'))
  // The OS's own service file is gone by the time the job is stopped.
  assert.doesNotMatch(calls[stop]!, OS === 'Darwin' ? /\[plist\]/ : /\[unit\]/)
  const killed = calls.findIndex((c) => c.startsWith('tmux -L hoai-42 kill-server'))
  assert.ok(killed > stop, 'the agent\'s own server, after the job was told to stop')
  assert.ok(!calls.some((c) => c.startsWith('tmux') && !c.includes('-L hoai-42')), 'never another tmux server')
})

test('uninstall of an agent with no pin removes its state dir entirely, exactly as before', (t) => {
  if (!ready(t)) return
  const m = machine()
  t.after(m.cleanup)
  mkdirSync(m.state, { recursive: true })
  writeFileSync(join(m.state, 'run.sh'), 'x')
  const r = m.run(['uninstall', '--assistant', '42'])
  assert.equal(r.status, 0, r.out)
  assert.equal(existsSync(m.state), false)
})

test('attach opens the agent\'s tmux session on its own socket, and refuses by name when there is none', (t) => {
  if (!ready(t)) return
  const m = machine()
  t.after(m.cleanup)
  const down = m.run(['attach', '--assistant', '42'])
  assert.equal(down.status, 1)
  assert.match(down.out, /agent 42 has no tmux session right now/)
  writeFileSync(join(m.fake, 'up'), '')
  const up = m.run(['attach', '--assistant', '42'])
  assert.equal(up.status, 0, up.out)
  assert.ok(m.calls().some((c) => c.startsWith('tmux -L hoai-42 attach -t =hoai-42')), m.calls().join('\n'))
})

test('status says whether the tmux session is up (remote compact ON or OFF) and which supervisor generation runs', (t) => {
  if (!ready(t)) return
  const m = machine()
  t.after(m.cleanup)
  mkdirSync(m.state, { recursive: true })
  writeFileSync(join(m.state, 'supervisor-generation'), '2\n')
  writeFileSync(join(m.state, 'launch-status'), '2026-10-06 10:00:00 outcome=live answered=[channels] compact=on\n')
  const off = m.run(['status', '--assistant', '42'])
  assert.match(off.out, /supervisor generation 2/)
  assert.match(off.out, /tmux session hoai-42 is not running: remote compact OFF/)
  assert.match(off.out, /last launch: .*outcome=live answered=\[channels\] compact=on/)
  writeFileSync(join(m.fake, 'up'), '')
  const on = m.run(['status', '--assistant', '42'])
  assert.match(on.out, /tmux session hoai-42 is up: remote compact ON/)
  // A generation 1 supervisor (run.sh, no stamp) is named as such.
  rmSync(join(m.state, 'supervisor-generation'))
  writeFileSync(join(m.state, 'run.sh'), 'x')
  assert.match(m.run(['status', '--assistant', '42']).out, /supervisor generation 1/)
})
