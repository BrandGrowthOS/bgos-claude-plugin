/**
 * lib/watcher-service.mjs: the always-on service that keeps the per-machine
 * watcher running, per platform: launchd (darwin), systemd --user (linux),
 * a logon Scheduled Task + hidden vbs launcher (win32). Pure spec builders
 * are table-tested for exact file contents and argv; the install/uninstall
 * runners are tested with a recording exec and an in-memory fs (order,
 * ignore-rc commands, a failing start reported by name, mode 0600 on the
 * credentials file).
 *
 * Run: npx tsx --test test/watcher-service.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  WATCHER_LAUNCHD_LABEL,
  WATCHER_SYSTEMD_UNIT,
  WATCHER_TASK_NAME,
  applyWin32CredentialsAcl,
  installWatcherService,
  readWatcherCredentials,
  uninstallWatcherService,
  watcherCredentialsPath,
  watcherServiceSpec,
  writeWatcherCredentials,
  xmlEscape,
} from '../lib/watcher-service.mjs'
import { memoryFs } from './helpers/memory-fs.ts'

const POSIX = { home: '/home/kc', nodePath: '/usr/local/bin/node', bundleDir: '/home/kc/.bgos-agent/watcher', uid: 501, username: 'kc' }
const WIN = {
  home: 'C:\\Users\\kc',
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  bundleDir: 'C:\\Users\\kc\\.bgos-agent\\watcher',
  uid: null,
  username: 'kc',
  localAppData: 'C:\\Users\\kc\\AppData\\Local',
}

/** A recording exec: every call is logged; outcomes come from a script keyed
 *  by `<file> <first arg>` (default rc 0). */
function recordingExec(outcomes: Record<string, { code: number; stderr?: string; stdout?: string }> = {}) {
  const calls: Array<{ file: string; args: string[] }> = []
  const exec = async (file: string, args: readonly string[]) => {
    calls.push({ file, args: [...args] })
    const key = `${file} ${args[0] ?? ''}`.trim()
    const hit = outcomes[key] ?? outcomes[file] ?? { code: 0 }
    return { code: hit.code, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '', error: null, timedOut: false }
  }
  return { calls, exec }
}

test('constants', () => {
  assert.equal(WATCHER_LAUNCHD_LABEL, 'ai.bgos.watcher')
  assert.equal(WATCHER_SYSTEMD_UNIT, 'bgos-watcher')
  assert.equal(WATCHER_TASK_NAME, 'HOAI Watcher')
  assert.equal(xmlEscape('a<b>&"c"'), 'a&lt;b&gt;&amp;&quot;c&quot;')
})

test('watcherCredentialsPath: <watcherHome>/credentials.json', () => {
  assert.equal(watcherCredentialsPath('/home/kc'), '/home/kc/.bgos-agent/watcher/credentials.json')
  assert.equal(watcherCredentialsPath('C:\\Users\\kc'), 'C:\\Users\\kc\\.bgos-agent\\watcher\\credentials.json')
})

// -- darwin ---------------------------------------------------------------------------

test('darwin spec: launchd plist (KeepAlive, RunAtLoad, node + watcher run, logs, PATH env) and the launchctl ladder', () => {
  const spec = watcherServiceSpec({ platform: 'darwin', ...POSIX })
  assert.equal(spec.kind, 'launchd')
  assert.equal(spec.label, 'ai.bgos.watcher')
  assert.deepEqual(spec.dirs, ['/home/kc/.bgos-agent/watcher/logs'])
  assert.equal(spec.files.length, 1)
  assert.equal(spec.files[0]!.path, '/home/kc/Library/LaunchAgents/ai.bgos.watcher.plist')
  assert.equal(spec.files[0]!.mode, 0o644)
  assert.equal(
    spec.files[0]!.content,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key><string>ai.bgos.watcher</string>',
      '  <key>ProgramArguments</key>',
      '  <array>',
      '    <string>/usr/local/bin/node</string>',
      '    <string>/home/kc/.bgos-agent/watcher/bin/hoai-watcher.mjs</string>',
      '    <string>run</string>',
      '  </array>',
      '  <key>WorkingDirectory</key><string>/home/kc/.bgos-agent/watcher</string>',
      '  <key>RunAtLoad</key><true/>',
      '  <key>KeepAlive</key><true/>',
      '  <key>ThrottleInterval</key><integer>10</integer>',
      '  <key>ProcessType</key><string>Background</string>',
      '  <key>StandardOutPath</key><string>/home/kc/.bgos-agent/watcher/logs/service.out.log</string>',
      '  <key>StandardErrorPath</key><string>/home/kc/.bgos-agent/watcher/logs/service.err.log</string>',
      '  <key>EnvironmentVariables</key>',
      '  <dict>',
      '    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/home/kc/.bun/bin:/home/kc/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>',
      '    <key>HOME</key><string>/home/kc</string>',
      '    <key>USER</key><string>kc</string>',
      '    <key>LOGNAME</key><string>kc</string>',
      '  </dict>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n'),
  )
  assert.deepEqual(spec.installCommands, [
    { file: 'launchctl', args: ['bootout', 'gui/501/ai.bgos.watcher'], ignoreFailure: true },
    { file: 'launchctl', args: ['bootstrap', 'gui/501', '/home/kc/Library/LaunchAgents/ai.bgos.watcher.plist'], ignoreFailure: false },
  ])
  assert.deepEqual(spec.startCommands, [
    { file: 'launchctl', args: ['kickstart', '-k', 'gui/501/ai.bgos.watcher'], ignoreFailure: false },
  ])
  assert.deepEqual(spec.stopCommands, [
    { file: 'launchctl', args: ['bootout', 'gui/501/ai.bgos.watcher'], ignoreFailure: true },
  ])
  assert.deepEqual(spec.uninstallCommands, [
    { file: 'launchctl', args: ['bootout', 'gui/501/ai.bgos.watcher'], ignoreFailure: true },
  ])
  assert.deepEqual(spec.statusCommands, [
    { file: 'launchctl', args: ['print', 'gui/501/ai.bgos.watcher'], ignoreFailure: true },
  ])
})

test('darwin spec: xml-escapes a hostile home and refuses to build without a uid', () => {
  const spec = watcherServiceSpec({ platform: 'darwin', ...POSIX, home: '/Users/a&b', bundleDir: '/Users/a&b/.bgos-agent/watcher' })
  assert.equal(spec.files[0]!.content.includes('/Users/a&amp;b/.bgos-agent/watcher'), true)
  assert.equal(spec.files[0]!.content.includes('/Users/a&b'), false)
  assert.throws(() => watcherServiceSpec({ platform: 'darwin', ...POSIX, uid: null }), /uid/)
})

// -- linux -----------------------------------------------------------------------------

test('linux spec: systemd --user unit (Restart=always, RestartSec=5, quoted ExecStart, PATH env) and the systemctl ladder with best-effort linger', () => {
  const spec = watcherServiceSpec({ platform: 'linux', ...POSIX })
  assert.equal(spec.kind, 'systemd')
  assert.equal(spec.label, 'bgos-watcher')
  assert.equal(spec.files[0]!.path, '/home/kc/.config/systemd/user/bgos-watcher.service')
  assert.equal(spec.files[0]!.mode, 0o644)
  assert.equal(
    spec.files[0]!.content,
    [
      '[Unit]',
      'Description=HOAI per-machine watcher (bgos-watcher)',
      'StartLimitIntervalSec=0',
      '',
      '[Service]',
      'Type=simple',
      'WorkingDirectory=/home/kc/.bgos-agent/watcher',
      'ExecStart="/usr/local/bin/node" "/home/kc/.bgos-agent/watcher/bin/hoai-watcher.mjs" run',
      'Restart=always',
      'RestartSec=5',
      'Environment=PATH=/usr/local/bin:/opt/homebrew/bin:/home/kc/.bun/bin:/home/kc/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      'Environment=HOME=/home/kc',
      'Environment=USER=kc',
      'Environment=LOGNAME=kc',
      'StandardOutput=journal',
      'StandardError=journal',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'),
  )
  assert.deepEqual(spec.installCommands, [
    { file: 'systemctl', args: ['--user', 'daemon-reload'], ignoreFailure: false },
    { file: 'systemctl', args: ['--user', 'enable', '--now', 'bgos-watcher'], ignoreFailure: false },
    { file: 'loginctl', args: ['enable-linger', 'kc'], ignoreFailure: true },
  ])
  assert.deepEqual(spec.startCommands, [
    { file: 'systemctl', args: ['--user', 'restart', 'bgos-watcher'], ignoreFailure: false },
  ])
  assert.deepEqual(spec.stopCommands, [
    { file: 'systemctl', args: ['--user', 'stop', 'bgos-watcher'], ignoreFailure: true },
  ])
  assert.deepEqual(spec.uninstallCommands, [
    { file: 'systemctl', args: ['--user', 'disable', '--now', 'bgos-watcher'], ignoreFailure: true },
    { file: 'systemctl', args: ['--user', 'daemon-reload'], ignoreFailure: true },
  ])
  assert.deepEqual(spec.statusCommands, [
    { file: 'systemctl', args: ['--user', 'is-active', 'bgos-watcher'], ignoreFailure: true },
  ])
})

test('linux spec: no username means no linger command (never enable-linger for an empty principal)', () => {
  const spec = watcherServiceSpec({ platform: 'linux', ...POSIX, username: '' })
  assert.equal(spec.installCommands.some((c) => c.file === 'loginctl'), false)
  assert.equal(spec.files[0]!.content.includes('Environment=USER='), false)
})

// -- win32 -------------------------------------------------------------------------------

test('win32 spec: run-hidden.vbs plus a generated install-task.ps1 driven through the Task Scheduler API (never schtasks /SC ONLOGON)', () => {
  const spec = watcherServiceSpec({ platform: 'win32', ...WIN })
  assert.equal(spec.kind, 'schtasks')
  assert.equal(spec.label, 'HOAI Watcher')
  assert.deepEqual(spec.dirs, ['C:\\Users\\kc\\.bgos-agent\\watcher\\logs'])
  assert.equal(spec.files.length, 2)
  assert.equal(spec.files[0]!.path, 'C:\\Users\\kc\\.bgos-agent\\watcher\\run-hidden.vbs')
  assert.equal(spec.files[0]!.mode, null)
  assert.equal(
    spec.files[0]!.content,
    [
      "' HOAI Watcher: start the per-machine watcher with no console window.",
      "' Generated by lib/watcher-service.mjs; the Scheduled Task 'HOAI Watcher' runs this at logon.",
      'Set shell = CreateObject("WScript.Shell")',
      'shell.CurrentDirectory = "C:\\Users\\kc\\.bgos-agent\\watcher"',
      'shell.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\Users\\kc\\.bgos-agent\\watcher\\bin\\hoai-watcher.mjs"" run", 0, False',
      '',
    ].join('\r\n'),
  )
  const script = spec.files[1]!
  assert.equal(script.path, 'C:\\Users\\kc\\.bgos-agent\\watcher\\install-task.ps1')
  assert.match(script.content, /Register-ScheduledTask -TaskName \$name/)
  assert.match(script.content, /New-ScheduledTaskTrigger -AtLogOn/)
  assert.match(script.content, /-RunLevel Limited/)
  assert.match(script.content, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/)
  assert.match(script.content, /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run/)
  assert.match(script.content, /\$vbs = 'C:\\Users\\kc\\\.bgos-agent\\watcher\\run-hidden\.vbs'/)
  assert.ok(!/schtasks/.test(script.content), 'schtasks.exe is never used')
  // The stop action targets THIS bundle's node process by exact script path;
  // matching the bare file name killed any process that merely mentioned it.
  assert.ok(script.content.includes(`$watcherScript = 'C:\Users\kc\.bgos-agent\watcher\bin\hoai-watcher.mjs'`), 'the exact script path is pinned')
  assert.ok(script.content.includes('$_.Name -eq \"node.exe\" -and $_.ProcessId -ne $PID -and $_.CommandLine -like (\"*\" + $watcherScript + \"*\")'), 'stop matches node.exe by exact path, never itself')
  assert.ok(!script.content.includes('-match \"hoai-watcher.mjs\"'), 'never a bare file-name match')
  const ps = (action: string, ignoreFailure: boolean) => ({
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\Users\\kc\\.bgos-agent\\watcher\\install-task.ps1', '-Action', action],
    ignoreFailure,
  })
  assert.deepEqual(spec.installCommands, [ps('install', false)])
  // Stop first (allowed to fail), then start: a re-install must not leave a
  // second watcher running under the old token.
  assert.deepEqual(spec.startCommands, [ps('stop', true), ps('start', false)])
  assert.deepEqual(spec.stopCommands, [ps('stop', true)])
  assert.deepEqual(spec.uninstallCommands, [ps('uninstall', true)])
  assert.deepEqual(spec.statusCommands, [ps('status', true)])
})

test('win32 spec: a double quote inside a path is refused (it would break the vbs string and the /TR line)', () => {
  assert.throws(() => watcherServiceSpec({ platform: 'win32', ...WIN, bundleDir: 'C:\\x"y' }), /quote/)
})

test('unsupported platform is refused by name', () => {
  assert.throws(() => watcherServiceSpec({ platform: 'freebsd', ...POSIX }), /freebsd/)
})

// -- installWatcherService --------------------------------------------------------------------

test('installWatcherService (darwin): mkdirs logs, writes the plist, runs bootout (rc ignored) then bootstrap then kickstart, in order', async () => {
  const spec = watcherServiceSpec({ platform: 'darwin', ...POSIX })
  const fs = memoryFs()
  const { calls, exec } = recordingExec({ 'launchctl bootout': { code: 3, stderr: 'Boot-out failed: 3: No such process' } })
  const result = await installWatcherService(spec, { exec, fs })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.message, 'installed')
  assert.equal(fs.dirs.has('/home/kc/.bgos-agent/watcher/logs'), true)
  assert.equal(fs.files.get('/home/kc/Library/LaunchAgents/ai.bgos.watcher.plist'), spec.files[0]!.content)
  assert.equal(fs.modes.get('/home/kc/Library/LaunchAgents/ai.bgos.watcher.plist'), 0o644)
  assert.deepEqual(
    calls.map((c) => `${c.file} ${c.args.join(' ')}`),
    [
      'launchctl bootout gui/501/ai.bgos.watcher',
      'launchctl bootstrap gui/501 /home/kc/Library/LaunchAgents/ai.bgos.watcher.plist',
      'launchctl kickstart -k gui/501/ai.bgos.watcher',
    ],
  )
  assert.deepEqual(
    result.ran.map((r) => [r.args[0], r.code, r.ignored]),
    [
      ['bootout', 3, true],
      ['bootstrap', 0, false],
      ['kickstart', 0, false],
    ],
  )
})

test('installWatcherService (linux): a failing START command is reported by name with the stderr line; files stay written', async () => {
  const spec = watcherServiceSpec({ platform: 'linux', ...POSIX })
  const fs = memoryFs()
  const { calls, exec } = recordingExec({
    'systemctl --user': { code: 0 },
    'loginctl enable-linger': { code: 1, stderr: 'Could not enable linger: Access denied' },
  })
  // Make only the restart fail: same file + first arg as the others, so key on the full argv.
  const failingExec = async (file: string, args: readonly string[]) => {
    if (file === 'systemctl' && args[1] === 'restart') {
      calls.push({ file, args: [...args] })
      return { code: 5, stdout: '', stderr: 'Failed to restart bgos-watcher.service: Unit not found.\nmore', error: null, timedOut: false }
    }
    return exec(file, args)
  }
  const result = await installWatcherService(spec, { exec: failingExec, fs })
  assert.equal(result.ok, false)
  assert.equal(
    result.message,
    'systemctl --user restart bgos-watcher failed (rc 5): Failed to restart bgos-watcher.service: Unit not found.',
  )
  assert.equal(fs.files.has('/home/kc/.config/systemd/user/bgos-watcher.service'), true)
  assert.deepEqual(
    calls.map((c) => `${c.file} ${c.args.join(' ')}`),
    [
      'systemctl --user daemon-reload',
      'systemctl --user enable --now bgos-watcher',
      'loginctl enable-linger kc',
      'systemctl --user restart bgos-watcher',
    ],
  )
  // The best-effort linger failure was recorded as ignored, not fatal.
  assert.deepEqual(result.ran.find((r) => r.file === 'loginctl'), { file: 'loginctl', args: ['enable-linger', 'kc'], code: 1, ignored: true })
})

test('installWatcherService (win32): writes the vbs + task script, registers then starts; a refused install stops before start', async () => {
  const spec = watcherServiceSpec({ platform: 'win32', ...WIN })
  const fs = memoryFs()
  // recordingExec keys on `<file> <first arg>`; install runs first, so the refusal lands on the install action and the ladder stops there.
  const { calls, exec } = recordingExec({ 'powershell.exe -NoProfile': { code: 1, stdout: 'run key refused: Access is denied.' } })
  const result = await installWatcherService(spec, { exec, fs })
  assert.equal(result.ok, false)
  assert.match(result.message, /-Action install failed \(rc 1\): run key refused: Access is denied\./)
  assert.equal(calls.length, 1)
  assert.equal(fs.files.get('C:\\Users\\kc\\.bgos-agent\\watcher\\run-hidden.vbs'), spec.files[0]!.content)
  assert.equal(fs.files.get('C:\\Users\\kc\\.bgos-agent\\watcher\\install-task.ps1'), spec.files[1]!.content)
  const ok = await installWatcherService(spec, { exec: recordingExec().exec, fs })
  assert.equal(ok.ok, true)
})

test('installWatcherService: a spawn failure (command not found) is reported, never thrown', async () => {
  const spec = watcherServiceSpec({ platform: 'linux', ...POSIX })
  const exec = async () => ({ code: null, stdout: '', stderr: '', error: 'spawn systemctl ENOENT', timedOut: false })
  const result = await installWatcherService(spec, { exec, fs: memoryFs() })
  assert.equal(result.ok, false)
  assert.equal(result.message, 'systemctl --user daemon-reload failed (rc null): spawn systemctl ENOENT')
})

test('installWatcherService: a file write failure is reported before any command runs', async () => {
  const spec = watcherServiceSpec({ platform: 'linux', ...POSIX })
  const fs = memoryFs()
  fs.writeFile = () => {
    throw new Error('EACCES: permission denied')
  }
  const { calls, exec } = recordingExec()
  const result = await installWatcherService(spec, { exec, fs })
  assert.equal(result.ok, false)
  assert.match(result.message, /write .*bgos-watcher\.service failed: EACCES/)
  assert.equal(calls.length, 0)
})

// -- uninstallWatcherService ------------------------------------------------------------------

test('uninstallWatcherService: stop + uninstall commands (failures recorded, never fatal), then service files removed', async () => {
  const spec = watcherServiceSpec({ platform: 'linux', ...POSIX })
  const fs = memoryFs({ '/home/kc/.config/systemd/user/bgos-watcher.service': 'x' })
  const { calls, exec } = recordingExec({ 'systemctl --user': { code: 5, stderr: 'not loaded' } })
  const result = await uninstallWatcherService(spec, { exec, fs })
  assert.equal(result.ok, true)
  assert.deepEqual(
    calls.map((c) => c.args.join(' ')),
    ['--user stop bgos-watcher', '--user disable --now bgos-watcher', '--user daemon-reload'],
  )
  assert.equal(fs.files.has('/home/kc/.config/systemd/user/bgos-watcher.service'), false)
  assert.deepEqual(result.removed, ['/home/kc/.config/systemd/user/bgos-watcher.service'])
})

// -- credentials ---------------------------------------------------------------------------------

const CREDS = { pairingId: 77, token: 'bgp_' + 'a'.repeat(40), backendUrl: 'https://api.example.test/api/v1', machineId: '0f3b3c1e-7d3a-4d0c-9a4c-1f2e3d4c5b6a' }

test('writeWatcherCredentials: exact JSON, mode 0600, returns the path; readWatcherCredentials round trips', () => {
  const fs = memoryFs()
  const path = writeWatcherCredentials('/home/kc', CREDS, fs)
  assert.equal(path, '/home/kc/.bgos-agent/watcher/credentials.json')
  assert.equal(fs.files.get(path), `${JSON.stringify(CREDS, null, 2)}\n`)
  assert.equal(fs.modes.get(path), 0o600)
  assert.deepEqual(readWatcherCredentials('/home/kc', fs), CREDS)
})

test('writeWatcherCredentials: refuses incomplete credentials (no half-written secret file)', () => {
  const fs = memoryFs()
  assert.throws(() => writeWatcherCredentials('/home/kc', { ...CREDS, token: '' }, fs), /token/)
  assert.throws(() => writeWatcherCredentials('/home/kc', { ...CREDS, backendUrl: '' }, fs), /backendUrl/)
  assert.throws(() => writeWatcherCredentials('/home/kc', { ...CREDS, machineId: '' }, fs), /machineId/)
  assert.throws(() => writeWatcherCredentials('/home/kc', { ...CREDS, pairingId: 'x' }, fs), /pairingId/)
  assert.equal(fs.files.size, 0)
})

test('readWatcherCredentials: null for absent, junk, or incomplete; a numeric-string pairingId is kept as given', () => {
  assert.equal(readWatcherCredentials('/home/kc', memoryFs()), null)
  assert.equal(readWatcherCredentials('/home/kc', memoryFs({ '/home/kc/.bgos-agent/watcher/credentials.json': 'junk' })), null)
  assert.equal(
    readWatcherCredentials('/home/kc', memoryFs({ '/home/kc/.bgos-agent/watcher/credentials.json': JSON.stringify({ ...CREDS, token: 1 }) })),
    null,
  )
  assert.deepEqual(
    readWatcherCredentials('/home/kc', memoryFs({ '/home/kc/.bgos-agent/watcher/credentials.json': JSON.stringify({ ...CREDS, pairingId: '77' }) })),
    { ...CREDS, pairingId: '77' },
  )
})

test('applyWin32CredentialsAcl: the exact icacls argv from bgos-pair (inheritance:r + grant:r user:F), reported honestly', async () => {
  const { calls, exec } = recordingExec()
  const ok = await applyWin32CredentialsAcl('C:\\Users\\kc\\.bgos-agent\\watcher\\credentials.json', { username: 'kc', exec })
  assert.deepEqual(ok, { ok: true, message: 'locked to your Windows user' })
  assert.deepEqual(calls, [
    { file: 'icacls', args: ['C:\\Users\\kc\\.bgos-agent\\watcher\\credentials.json', '/inheritance:r', '/grant:r', 'kc:F'] },
  ])
  const denied = recordingExec({ icacls: { code: 5, stderr: 'Access is denied.' } })
  const bad = await applyWin32CredentialsAcl('C:\\x', { username: 'kc', exec: denied.exec })
  assert.equal(bad.ok, false)
  assert.match(bad.message, /UNPROTECTED.*Access is denied/)
  const noUser = await applyWin32CredentialsAcl('C:\\x', { username: '', exec })
  assert.equal(noUser.ok, false)
  assert.match(noUser.message, /UNPROTECTED/)
})
