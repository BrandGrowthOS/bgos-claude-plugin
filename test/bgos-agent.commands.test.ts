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
 * Every name of the agent's service and its tmux socket carries the HOME it was
 * installed from (board row d6198bb6): ai.bgos.agent.42.home-<hid>,
 * bgos-agent-42-home-<hid>, hoai-42-home-<hid>, where hid is #237's
 * watcherHomeId of this (temp) HOME's real path (round 2 H2: on macOS the temp
 * dir is reached through a symlink, /var to /private/var). bgos-agent computes it, and reads the
 * service back before it acts, through bin/hoai-agent-service.mjs on bun or
 * node: the `bun` on PATH hands over to the runtime running this test, and the
 * launchctl and systemctl fakes answer that read-back the way a real host does
 * for THIS HOME's registration (test/helpers/bash-service-probes.ts).
 *
 * Run: npx tsx --test test/bgos-agent.commands.test.ts
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import { resolvePosixBash } from './helpers/posix-bash.ts'
import { LAUNCHCTL_PRINT_FROM_PLIST, systemctlShowFromUnitFile } from './helpers/bash-service-probes.ts'
import { watcherHomeId } from '../lib/watcher-service.mjs'

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
  // This HOME's id (#237's watcherHomeId of its real path): HOME is a fresh temp dir, so it is computed here.
  const hid = watcherHomeId(realpathSync(home), OS === 'Darwin' ? 'darwin' : 'linux')
  const label = `ai.bgos.agent.42.home-${hid}`
  const unitName = `bgos-agent-42-home-${hid}`
  const sock = `hoai-42-home-${hid}`
  const plist = join(home, 'Library', 'LaunchAgents', `${label}.plist`)
  const unit = join(home, '.config', 'systemd', 'user', `${unitName}.service`)
  const shim = (name: string, body: string) => {
    // Each call records whether the service files still exist at that moment, so the ORDER is observable.
    writeFileSync(
      join(shims, name),
      `#!/bin/sh\n{ printf '%s' '${name}'; for a in "$@"; do printf ' %s' "$a"; done; [ -e '${plist}' ] && printf ' [plist]'; [ -e '${unit}' ] && printf ' [unit]'; printf '\\n'; } >> '${log}'\n${body}\n`,
    )
    chmodSync(join(shims, name), 0o755)
  }
  shim('tmux', `case "$3" in has-session) [ -f '${fake}/up' ] && exit 0; exit 1 ;; *) exit 0 ;; esac`)
  // The read-back (launchctl print, systemctl --user show) finds a job or unit exactly when its
  // service file is installed in this HOME; every other call succeeds, as before.
  shim('launchctl', `${LAUNCHCTL_PRINT_FROM_PLIST}\nexit 0`)
  shim('systemctl', `${systemctlShowFromUnitFile()}\nexit 0`)
  shim('loginctl', 'exit 0')
  // bin/hoai-agent-service.mjs (the HOME id, the read-back) runs on the runtime running this test.
  shim('bun', `exec '${process.execPath}' "$@"`)
  /**
   * The service file an always-on install of agent 42 from this HOME leaves for this OS (what the
   * read-back reads), with the content bin/bgos-agent writes (install_launchd, install_systemd):
   * the plist's Label, ProgramArguments `/bin/bash <HOME>/.bgos-agent/42/run.sh` and
   * EnvironmentVariables HOME; the unit's ExecStart of that run.sh and Environment=HOME.
   */
  const installService = () => {
    const stateDir = join(home, '.bgos-agent', '42')
    const workdir = join(home, '.bgos-agent', '42-workspace')
    const path = '/usr/local/bin:/usr/bin:/bin'
    if (OS === 'Darwin') {
      const x = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      mkdirSync(dirname(plist), { recursive: true })
      writeFileSync(
        plist,
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
          '<plist version="1.0">',
          '<dict>',
          `  <key>Label</key><string>${label}</string>`,
          '  <key>ProgramArguments</key>',
          '  <array>',
          '    <string>/bin/bash</string>',
          `    <string>${x(stateDir)}/run.sh</string>`,
          '  </array>',
          `  <key>WorkingDirectory</key><string>${x(workdir)}</string>`,
          '  <key>RunAtLoad</key><true/>',
          '  <key>KeepAlive</key><true/>',
          '  <key>ThrottleInterval</key><integer>10</integer>',
          '  <key>ProcessType</key><string>Interactive</string>',
          `  <key>StandardOutPath</key><string>${x(stateDir)}/service.out.log</string>`,
          `  <key>StandardErrorPath</key><string>${x(stateDir)}/service.err.log</string>`,
          '  <key>EnvironmentVariables</key>',
          '  <dict>',
          `    <key>PATH</key><string>${path}</string>`,
          `    <key>HOME</key><string>${x(home)}</string>`,
          '    <key>TERM</key><string>xterm-256color</string>',
          '    <key>USER</key><string>kc</string>',
          '    <key>LOGNAME</key><string>kc</string>',
          '    <key>CLAUDE_CODE_ENABLE_TODO_TOOLS</key><string>1</string>',
          '  </dict>',
          '</dict>',
          '</plist>',
          '',
        ].join('\n'),
      )
    } else {
      mkdirSync(dirname(unit), { recursive: true })
      writeFileSync(
        unit,
        [
          '[Unit]',
          'Description=BGOS Claude Code agent 42',
          'StartLimitIntervalSec=0',
          '',
          '[Service]',
          'Type=simple',
          `WorkingDirectory=${workdir}`,
          `ExecStart=/bin/bash "${stateDir}/run.sh"`,
          'Restart=always',
          'RestartSec=10',
          `Environment=PATH=${path}`,
          `Environment=HOME=${home}`,
          'Environment=TERM=xterm-256color',
          'Environment=USER=kc',
          'Environment=LOGNAME=kc',
          'Environment=CLAUDE_CODE_ENABLE_TODO_TOOLS=1',
          'StandardOutput=journal',
          'StandardError=journal',
          '',
          '[Install]',
          'WantedBy=default.target',
          '',
        ].join('\n'),
      )
    }
  }
  const run = (args: string[]) => {
    const r = spawnSync(BASH!, [agentBin, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { HOME: home, USER: 'kc', LOGNAME: 'kc', NO_COLOR: '1', PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin` },
    })
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
  }
  /** The same command in the background: resolves with its exit code and output when it ends. */
  const start = (args: string[]) => {
    const child = spawn(BASH!, [agentBin, ...args], {
      env: { HOME: home, USER: 'kc', LOGNAME: 'kc', NO_COLOR: '1', PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin` },
    })
    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (out += String(d)))
    const done = new Promise<{ status: number | null; out: string }>((resolve) => child.on('close', (status) => resolve({ status, out })))
    return { child, done }
  }
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])
  return { home, fake, label, unitName, sock, plist, unit, installService, state: join(home, '.bgos-agent', '42'), run, start, calls, cleanup: () => rmSync(home, { recursive: true, force: true }) }
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
  // The service file bin/bgos-agent writes for this OS, recording this HOME and agent 42's run.sh.
  m.installService()
  const r = m.run(['uninstall', '--assistant', '42'])
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(readdirSync(m.state), ['session-id'], 'only the pin survives')
  assert.equal(readFileSync(join(m.state, 'session-id'), 'utf8'), pin, 'byte for byte')
  assert.match(r.out, /its pinned session id is kept/)
  assert.doesNotMatch(r.out, /service note: |refused: /, 'this HOME\'s own registration: nothing left alone, nothing refused')
  const calls = m.calls()
  // Read back first, by this HOME's name, while its service file was still there (what the stop by name rests on).
  const readBack = calls.findIndex((c) => {
    const w = c.split(' ')
    return OS === 'Darwin' ? w[0] === 'launchctl' && w[1] === 'print' && w[2] === `gui/${process.getuid!()}/${m.label}` : w[0] === 'systemctl' && w[2] === 'show' && w[4] === m.unitName
  })
  assert.ok(readBack >= 0, calls.join('\n'))
  assert.match(calls[readBack]!, OS === 'Darwin' ? / \[plist\]$/ : / \[unit\]$/, 'the file existed when it was read back')
  const stop = OS === 'Darwin'
    ? calls.findIndex((c) => c.startsWith('launchctl bootout gui/') && c.includes(`/${m.label}`))
    : calls.findIndex((c) => c.startsWith(`systemctl --user stop ${m.unitName}`))
  assert.ok(stop >= 0, calls.join('\n'))
  assert.ok(readBack < stop, 'read back before it is stopped by name')
  // The OS's own service file is gone by the time the job is stopped.
  assert.doesNotMatch(calls[stop]!, OS === 'Darwin' ? /\[plist\]/ : /\[unit\]/)
  const killed = calls.findIndex((c) => c.startsWith(`tmux -L ${m.sock} kill-server`))
  assert.ok(killed > stop, 'the agent\'s own server, after the job was told to stop')
  assert.ok(!calls.some((c) => c.startsWith('tmux') && !c.includes(`-L ${m.sock} `)), 'never another tmux server')
})

test('uninstall takes the install lock: it waits for an install of the same agent that is still writing run.sh and the service file, then removes them (plugin-supervisor F6)', async (t) => {
  if (!ready(t)) return
  const m = machine()
  t.after(m.cleanup)
  mkdirSync(m.state, { recursive: true })
  writeFileSync(join(m.state, 'run.sh'), 'x')
  // The service file bin/bgos-agent writes for this OS, recording this HOME and agent 42's run.sh.
  m.installService()
  // An install in flight holds the lock: this test process stands in for it (alive, its real start time).
  const lock = join(m.home, '.bgos-agent', '42.install.lock')
  mkdirSync(lock)
  const started = String(spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).stdout).trim().replace(/\s+/g, ' ')
  writeFileSync(join(lock, 'pid'), `${process.pid}\n${started}\n`)
  const u = m.start(['uninstall', '--assistant', '42'])
  t.after(() => u.child.kill('SIGKILL'))
  await new Promise((resolve) => setTimeout(resolve, 1500))
  assert.ok(existsSync(join(m.state, 'run.sh')), 'nothing is removed under an install that is still writing')
  assert.ok(!m.calls().some((c) => c.startsWith('launchctl bootout') || c.startsWith('systemctl --user stop')), 'nor is the job stopped yet')
  // The install finishes and lets go of its lock.
  rmSync(lock, { recursive: true, force: true })
  const r = await u.done
  assert.equal(r.status, 0, r.out)
  assert.equal(existsSync(m.state), false, 'then the uninstall runs to the end')
  assert.ok(
    m.calls().some((c) => (OS === 'Darwin' ? c.startsWith(`launchctl bootout gui/${process.getuid!()}/${m.label}`) : c.startsWith(`systemctl --user stop ${m.unitName}`))),
    `read back as this HOME's own, it is stopped by this HOME's name: ${m.calls().join('\n')}`,
  )
  assert.equal(existsSync(OS === 'Darwin' ? m.plist : m.unit), false, 'the service file of this OS is gone')
  assert.equal(existsSync(lock), false, 'and lets go of the lock it took')
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
  assert.ok(m.calls().some((c) => c.startsWith(`tmux -L ${m.sock} attach -t =${m.sock}`)), m.calls().join('\n'))
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
  assert.match(off.out, new RegExp(`tmux session ${m.sock} is not running: remote compact OFF`))
  assert.match(off.out, /last launch: .*outcome=live answered=\[channels\] compact=on/)
  writeFileSync(join(m.fake, 'up'), '')
  const on = m.run(['status', '--assistant', '42'])
  assert.match(on.out, new RegExp(`tmux session ${m.sock} is up: remote compact ON`))
  // A generation 1 supervisor (run.sh, no stamp) is named as such.
  rmSync(join(m.state, 'supervisor-generation'))
  writeFileSync(join(m.state, 'run.sh'), 'x')
  assert.match(m.run(['status', '--assistant', '42']).out, /supervisor generation 1/)
})

test('logs tails the logs that exist: generation 2 writes no expect.log, and that is not "no logs yet"', (t) => {
  if (!ready(t)) return
  const m = machine()
  t.after(m.cleanup)
  mkdirSync(m.state, { recursive: true })
  writeFileSync(join(m.state, 'agent.log'), '[2026-10-06 10:00:00] starting agent (consecutive fast-fails: 0)\n')
  const gen2 = m.run(['logs', '--assistant', '42'])
  assert.equal(gen2.status, 0, gen2.out)
  assert.match(gen2.out, /starting agent \(consecutive fast-fails: 0\)/)
  assert.doesNotMatch(gen2.out, /no logs yet/, 'agent.log was shown, so there are logs')
  // A generation 1 supervisor not yet upgraded still has its expect.log, and both are shown.
  writeFileSync(join(m.state, 'expect.log'), 'spawn claude\n')
  const gen1 = m.run(['logs', '--assistant', '42'])
  assert.match(gen1.out, /starting agent/)
  assert.match(gen1.out, /spawn claude/)
  assert.doesNotMatch(gen1.out, /no logs yet/)
  // Nothing written yet is still said plainly.
  rmSync(join(m.state, 'agent.log'))
  rmSync(join(m.state, 'expect.log'))
  assert.match(m.run(['logs', '--assistant', '42']).out, /\(no logs yet\)/)
})

test('logs shows hoai\'s own stderr from the running launch (hoai.err): in tmux it reaches agent.log only once the session ends', (t) => {
  if (!ready(t)) return
  const m = machine()
  t.after(m.cleanup)
  mkdirSync(m.state, { recursive: true })
  writeFileSync(join(m.state, 'agent.log'), '[2026-10-06 10:00:00] agent 42 is running in tmux session hoai-42\n')
  writeFileSync(join(m.state, 'hoai.err'), '[hoai] could not register the activity hooks: EACCES\n')
  const out = m.run(['logs', '--assistant', '42']).out
  assert.match(out, /running in tmux session hoai-42/)
  assert.match(out, /could not register the activity hooks: EACCES/)
  // An empty one (the usual case: hoai said nothing on stderr) is not shown.
  writeFileSync(join(m.state, 'hoai.err'), '')
  assert.doesNotMatch(m.run(['logs', '--assistant', '42']).out, /hoai\.err/)
})

test('status names a crash loop: an installed, loaded unit is not an agent that is up (board row 84296679)', (t) => {
  if (!ready(t)) return
  const m = machine()
  t.after(m.cleanup)
  mkdirSync(m.state, { recursive: true })
  writeFileSync(join(m.state, 'supervisor-generation'), '2\n')
  // kc-server: claude 2.1.22 exited rc=1 at once on every launch, about 420 times.
  writeFileSync(
    join(m.state, 'launch-status'),
    "2026-10-12 10:41:03 outcome=exited-during-startup answered=[] screen=\"error: unknown option '--dangerously-load-development-channels'\" rc=1\n",
  )
  writeFileSync(join(m.state, 'failcount'), '12\n')
  // Installed and loaded: the read-back finds this HOME's job or unit, and status reports it as such.
  m.installService()
  const looping = m.run(['status', '--assistant', '42'])
  if (OS === 'Darwin') assert.match(looping.out, new RegExp(`${m.label.replace(/\./g, '\\.')} is loaded`))
  else assert.ok(m.calls().some((c) => c.startsWith(`systemctl --user status ${m.unitName} --no-pager`)), m.calls().join('\n'))
  assert.match(looping.out, /NOT RUNNING HEALTHY: the last launch did not come up \(12 consecutive fast fail\(s\)\).*unknown option/)

  // Three fast fails with an outcome this guard does not know is still a loop.
  writeFileSync(join(m.state, 'launch-status'), '2026-10-12 10:41:03 outcome=starting\n')
  assert.match(m.run(['status', '--assistant', '42']).out, /NOT RUNNING HEALTHY: 12 consecutive fast fails, this agent is crash looping/)

  // A healthy launch says nothing of the kind.
  writeFileSync(join(m.state, 'launch-status'), '2026-10-12 10:41:03 outcome=live answered=[channels] compact=on\n')
  writeFileSync(join(m.state, 'failcount'), '0\n')
  assert.doesNotMatch(m.run(['status', '--assistant', '42']).out, /NOT RUNNING HEALTHY/)
})
