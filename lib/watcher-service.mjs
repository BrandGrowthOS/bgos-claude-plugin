/**
 * watcher-service: the always-on OS service that keeps the per-machine
 * watcher (bin/hoai-watcher.mjs run) alive across reboots and crashes, plus
 * the watcher's own credentials file.
 *
 * Per platform (design 1.5 / 7.5), mirroring the per-agent service shapes in
 * bin/bgos-agent so an operator sees one familiar pattern:
 *   darwin  ~/Library/LaunchAgents/ai.bgos.watcher.plist, KeepAlive +
 *           RunAtLoad, ProgramArguments [node, <bundle>/bin/hoai-watcher.mjs,
 *           run]; install = launchctl bootout (rc ignored) then bootstrap,
 *           start = kickstart -k
 *   linux   ~/.config/systemd/user/bgos-watcher.service, Restart=always,
 *           RestartSec=5; install = daemon-reload, enable --now, plus a
 *           best-effort loginctl enable-linger so it survives logout
 *   win32   a logon Scheduled Task "HOAI Watcher" running wscript.exe //B
 *           <bundle>\run-hidden.vbs, which starts node hidden (no console);
 *           registered through the Task Scheduler API from a generated
 *           <bundle>\install-task.ps1 (Register-ScheduledTask works
 *           unelevated; schtasks /SC ONLOGON is admin-only), falling back to
 *           the per-user Run key. PATH independent: the absolute node path recorded
 *           at install time is baked into every service file.
 *
 * The spec builder is PURE (exact file contents + argv, table-tested); the
 * runners take an injected exec + fs so install/uninstall are testable with
 * a recording exec. Commands flagged ignoreFailure are best effort (a bootout
 * of a not-loaded label, enable-linger without polkit rights); any other
 * non-zero exit stops the ladder and is reported by name, never thrown.
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe.
 */

import { joinDir, nodeExec, nodeFs, watcherHome } from './watcher-bundle.mjs'

export const WATCHER_LAUNCHD_LABEL = 'ai.bgos.watcher'
export const WATCHER_SYSTEMD_UNIT = 'bgos-watcher'
export const WATCHER_TASK_NAME = 'HOAI Watcher'
export const WATCHER_HIDDEN_LAUNCHER_FILE = 'run-hidden.vbs'
/** The generated PowerShell task script (install / start / stop / uninstall / status). */
export const WATCHER_TASK_SCRIPT_FILE = 'install-task.ps1'
export const CREDENTIALS_FILE_NAME = 'credentials.json'
export const CREDENTIALS_FILE_MODE = 0o600

/**
 * @typedef {{ file: string, args: string[], ignoreFailure: boolean }} ServiceCommand
 * @typedef {{
 *   kind: 'launchd' | 'systemd' | 'schtasks',
 *   label: string,
 *   bundleDir: string,
 *   dirs: string[],
 *   files: Array<{ path: string, content: string, mode: number | null }>,
 *   installCommands: ServiceCommand[],
 *   startCommands: ServiceCommand[],
 *   stopCommands: ServiceCommand[],
 *   uninstallCommands: ServiceCommand[],
 *   statusCommands: ServiceCommand[],
 * }} WatcherServiceSpec
 */

/** @typedef {{ pairingId: number | string, token: string, backendUrl: string, machineId: string }} WatcherCredentials */

// -- Small helpers ----------------------------------------------------------------

export function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function command(file, args, ignoreFailure = false) {
  return { file, args: [...args], ignoreFailure }
}

/** The PATH a headless service needs to find node, bun, hoai and the claude CLI. */
export function servicePath(home) {
  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    joinDir(joinDir(home, '.bun'), 'bin'),
    joinDir(joinDir(home, '.local'), 'bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':')
}

export function watcherScriptPath(bundleDir) {
  return joinDir(joinDir(bundleDir, 'bin'), 'hoai-watcher.mjs')
}

// -- Spec builders --------------------------------------------------------------------

function launchdSpec({ home, nodePath, bundleDir, uid, username }) {
  if (uid === null || uid === undefined || !Number.isInteger(uid) || uid < 0) {
    throw new Error('watcherServiceSpec: darwin needs the numeric uid (launchctl gui/<uid> domain)')
  }
  const plistPath = joinDir(joinDir(joinDir(home, 'Library'), 'LaunchAgents'), `${WATCHER_LAUNCHD_LABEL}.plist`)
  const logsDir = joinDir(bundleDir, 'logs')
  const user = String(username ?? '').trim()
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${WATCHER_LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xmlEscape(nodePath)}</string>`,
    `    <string>${xmlEscape(watcherScriptPath(bundleDir))}</string>`,
    '    <string>run</string>',
    '  </array>',
    `  <key>WorkingDirectory</key><string>${xmlEscape(bundleDir)}</string>`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>ThrottleInterval</key><integer>10</integer>',
    '  <key>ProcessType</key><string>Background</string>',
    `  <key>StandardOutPath</key><string>${xmlEscape(joinDir(logsDir, 'service.out.log'))}</string>`,
    `  <key>StandardErrorPath</key><string>${xmlEscape(joinDir(logsDir, 'service.err.log'))}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>PATH</key><string>${xmlEscape(servicePath(home))}</string>`,
    `    <key>HOME</key><string>${xmlEscape(home)}</string>`,
    ...(user ? [`    <key>USER</key><string>${xmlEscape(user)}</string>`, `    <key>LOGNAME</key><string>${xmlEscape(user)}</string>`] : []),
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
  const target = `gui/${uid}/${WATCHER_LAUNCHD_LABEL}`
  return {
    kind: 'launchd',
    label: WATCHER_LAUNCHD_LABEL,
    bundleDir,
    dirs: [logsDir],
    files: [{ path: plistPath, content, mode: 0o644 }],
    installCommands: [
      command('launchctl', ['bootout', target], true),
      command('launchctl', ['bootstrap', `gui/${uid}`, plistPath]),
    ],
    startCommands: [command('launchctl', ['kickstart', '-k', target])],
    stopCommands: [command('launchctl', ['bootout', target], true)],
    uninstallCommands: [command('launchctl', ['bootout', target], true)],
    statusCommands: [command('launchctl', ['print', target], true)],
  }
}

function systemdSpec({ home, nodePath, bundleDir, username }) {
  const unitPath = joinDir(joinDir(joinDir(joinDir(home, '.config'), 'systemd'), 'user'), `${WATCHER_SYSTEMD_UNIT}.service`)
  const logsDir = joinDir(bundleDir, 'logs')
  const user = String(username ?? '').trim()
  const content = [
    '[Unit]',
    `Description=HOAI per-machine watcher (${WATCHER_SYSTEMD_UNIT})`,
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${bundleDir}`,
    `ExecStart="${nodePath}" "${watcherScriptPath(bundleDir)}" run`,
    'Restart=always',
    'RestartSec=5',
    `Environment=PATH=${servicePath(home)}`,
    `Environment=HOME=${home}`,
    ...(user ? [`Environment=USER=${user}`, `Environment=LOGNAME=${user}`] : []),
    'StandardOutput=journal',
    'StandardError=journal',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
  return {
    kind: 'systemd',
    label: WATCHER_SYSTEMD_UNIT,
    bundleDir,
    dirs: [logsDir],
    files: [{ path: unitPath, content, mode: 0o644 }],
    installCommands: [
      command('systemctl', ['--user', 'daemon-reload']),
      command('systemctl', ['--user', 'enable', '--now', WATCHER_SYSTEMD_UNIT]),
      ...(user ? [command('loginctl', ['enable-linger', user], true)] : []),
    ],
    startCommands: [command('systemctl', ['--user', 'restart', WATCHER_SYSTEMD_UNIT])],
    stopCommands: [command('systemctl', ['--user', 'stop', WATCHER_SYSTEMD_UNIT], true)],
    uninstallCommands: [
      command('systemctl', ['--user', 'disable', '--now', WATCHER_SYSTEMD_UNIT], true),
      command('systemctl', ['--user', 'daemon-reload'], true),
    ],
    statusCommands: [command('systemctl', ['--user', 'is-active', WATCHER_SYSTEMD_UNIT], true)],
  }
}

function schtasksSpec({ nodePath, bundleDir }) {
  for (const [name, value] of [['nodePath', nodePath], ['bundleDir', bundleDir]]) {
    if (String(value).includes('"') || String(value).includes("'")) {
      throw new Error(`watcherServiceSpec: ${name} contains a quote, which cannot be embedded in the vbs launcher or the task script`)
    }
  }
  const vbsPath = joinDir(bundleDir, WATCHER_HIDDEN_LAUNCHER_FILE)
  const taskScriptPath = joinDir(bundleDir, WATCHER_TASK_SCRIPT_FILE)
  const logsDir = joinDir(bundleDir, 'logs')
  // VBScript doubles embedded quotes inside a string literal; the whole
  // command line is one literal so paths with spaces stay intact.
  const content = [
    "' HOAI Watcher: start the per-machine watcher with no console window.",
    `' Generated by lib/watcher-service.mjs; the Scheduled Task '${WATCHER_TASK_NAME}' runs this at logon.`,
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = "${bundleDir}"`,
    `shell.Run """${nodePath}"" ""${watcherScriptPath(bundleDir)}"" run", 0, False`,
    '',
  ].join('\r\n')
  // The task is registered through the Task Scheduler API (Register-
  // ScheduledTask), which an unelevated user may do; `schtasks /Create /SC
  // ONLOGON` is admin-only and fails with "Access is denied" (measured
  // 2026-08-25). When even the API refuses, the per-user Run key keeps the
  // watcher starting at logon. Every action is idempotent.
  const taskScript = [
    `# ${WATCHER_TASK_NAME}: logon task for the per-machine watcher (generated by lib/watcher-service.mjs).`,
    'param([Parameter(Mandatory = $true)][ValidateSet("install", "start", "stop", "uninstall", "status")][string]$Action)',
    `$name = '${WATCHER_TASK_NAME}'`,
    `$vbs = '${vbsPath}'`,
    `$runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'`,
    `$runValue = 'HOAIWatcher'`,
    '$launcher = "wscript.exe //B `"$vbs`""',
    'function Register-Task {',
    '  $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B `"$vbs`""',
    '  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME',
    '  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)',
    '  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited',
    '  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null',
    '}',
    'switch ($Action) {',
    '  "install" {',
    '    try { Register-Task; Write-Output "task registered"; exit 0 }',
    '    catch {',
    '      Write-Output ("task registration refused: " + $_.Exception.Message + "; falling back to the Run key")',
    '      try { New-ItemProperty -Path $runKey -Name $runValue -Value $launcher -PropertyType String -Force -ErrorAction Stop | Out-Null; Write-Output "run key registered"; exit 0 }',
    '      catch { Write-Output ("run key refused: " + $_.Exception.Message); exit 1 }',
    '    }',
    '  }',
    '  "start" {',
    '    try { Start-ScheduledTask -TaskName $name -ErrorAction Stop; Write-Output "task started"; exit 0 }',
    '    catch { Start-Process -FilePath "wscript.exe" -ArgumentList @("//B", "`"$vbs`"") -WindowStyle Hidden; Write-Output "started via wscript"; exit 0 }',
    '  }',
    '  "stop" {',
    '    try { Stop-ScheduledTask -TaskName $name -ErrorAction Stop } catch {}',
    '    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "hoai-watcher.mjs" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    '    Write-Output "stopped"; exit 0',
    '  }',
    '  "uninstall" {',
    '    try { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop } catch {}',
    '    try { Remove-ItemProperty -Path $runKey -Name $runValue -ErrorAction Stop } catch {}',
    '    Write-Output "unregistered"; exit 0',
    '  }',
    '  "status" {',
    '    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue',
    '    if ($task) { Write-Output ("task " + $task.State); exit 0 }',
    '    $run = (Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue).$runValue',
    '    if ($run) { Write-Output "run key registered"; exit 0 }',
    '    Write-Output "not registered"; exit 1',
    '  }',
    '}',
    '',
  ].join('\r\n')
  const ps = (action) =>
    command('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', taskScriptPath, '-Action', action], action !== 'install' && action !== 'start')
  return {
    kind: 'schtasks',
    label: WATCHER_TASK_NAME,
    bundleDir,
    dirs: [logsDir],
    files: [
      { path: vbsPath, content, mode: null },
      { path: taskScriptPath, content: taskScript, mode: null },
    ],
    installCommands: [ps('install')],
    startCommands: [ps('start')],
    stopCommands: [ps('stop')],
    uninstallCommands: [ps('uninstall')],
    statusCommands: [ps('status')],
  }
}

/**
 * The pure service spec for a platform.
 * @param {{ platform: string, home: string, nodePath: string, bundleDir?: string,
 *   uid?: number | null, localAppData?: string, username?: string }} params
 * @returns {WatcherServiceSpec}
 */
export function watcherServiceSpec({ platform, home, nodePath, bundleDir, uid = null, localAppData, username = '' }) {
  void localAppData // reserved (the win32 layout keeps everything under the bundle dir today)
  const node = String(nodePath ?? '').trim()
  if (!node) throw new Error('watcherServiceSpec: nodePath is required (the absolute node binary recorded at install)')
  const dir = String(bundleDir ?? '').trim() || watcherHome(home)
  if (platform === 'darwin') return launchdSpec({ home, nodePath: node, bundleDir: dir, uid, username })
  if (platform === 'linux') return systemdSpec({ home, nodePath: node, bundleDir: dir, username })
  if (platform === 'win32') return schtasksSpec({ nodePath: node, bundleDir: dir })
  throw new Error(`watcherServiceSpec: unsupported platform ${platform}`)
}

// -- Runners --------------------------------------------------------------------------

function firstLine(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? ''
}

function describeFailure(cmd, result) {
  const detail = firstLine(result.stderr) || firstLine(result.stdout) || String(result.error ?? '') || 'no output'
  return `${cmd.file} ${cmd.args.join(' ')} failed (rc ${result.code}): ${detail}`
}

async function runLadder(commands, exec, ran) {
  for (const cmd of commands) {
    const result = await exec(cmd.file, cmd.args)
    const failed = result.code !== 0
    ran.push({ file: cmd.file, args: [...cmd.args], code: result.code, ignored: Boolean(cmd.ignoreFailure) })
    if (failed && !cmd.ignoreFailure) return describeFailure(cmd, result)
  }
  return null
}

/**
 * Write the service files, run the install ladder, then the start ladder.
 * @param {WatcherServiceSpec} spec
 * @param {{ exec?: import('./watcher-bundle.mjs').Exec, fs?: import('./watcher-bundle.mjs').WatcherFs }} deps
 * @returns {Promise<{ ok: boolean, message: string, ran: Array<{ file: string, args: string[], code: number | null, ignored: boolean }> }>}
 */
export async function installWatcherService(spec, { exec = nodeExec(), fs = nodeFs() } = {}) {
  const ran = []
  for (const dir of spec.dirs ?? []) {
    try {
      fs.mkdir(dir)
    } catch (err) {
      return { ok: false, message: `mkdir ${dir} failed: ${String(err?.message ?? err)}`, ran }
    }
  }
  for (const file of spec.files) {
    try {
      fs.writeFile(file.path, file.content, file.mode != null ? { mode: file.mode } : undefined)
    } catch (err) {
      return { ok: false, message: `write ${file.path} failed: ${String(err?.message ?? err)}`, ran }
    }
  }
  const installFailure = await runLadder(spec.installCommands, exec, ran)
  if (installFailure) return { ok: false, message: installFailure, ran }
  const startFailure = await runLadder(spec.startCommands, exec, ran)
  if (startFailure) return { ok: false, message: startFailure, ran }
  return { ok: true, message: 'installed', ran }
}

/**
 * Stop + unregister the service (every command best effort, all recorded),
 * then remove the service files. Never throws.
 * @param {WatcherServiceSpec} spec
 * @param {{ exec?: import('./watcher-bundle.mjs').Exec, fs?: import('./watcher-bundle.mjs').WatcherFs }} deps
 */
export async function uninstallWatcherService(spec, { exec = nodeExec(), fs = nodeFs() } = {}) {
  const ran = []
  const lenient = (cmds) => cmds.map((c) => ({ ...c, ignoreFailure: true }))
  await runLadder(lenient(spec.stopCommands), exec, ran)
  await runLadder(lenient(spec.uninstallCommands), exec, ran)
  const removed = []
  for (const file of spec.files) {
    try {
      if (fs.exists(file.path)) {
        fs.rm(file.path)
        removed.push(file.path)
      }
    } catch {
      // A file we cannot remove is left for the operator; the ran list shows the unload happened.
    }
  }
  return { ok: true, message: 'uninstalled', ran, removed }
}

/** Run the spec's status commands; returns their combined output (best effort). */
export async function watcherServiceStatus(spec, { exec = nodeExec() } = {}) {
  const ran = []
  const lines = []
  for (const cmd of spec.statusCommands) {
    const result = await exec(cmd.file, cmd.args)
    ran.push({ file: cmd.file, args: [...cmd.args], code: result.code, ignored: true })
    lines.push(String(result.stdout ?? '').trim() || String(result.stderr ?? '').trim() || String(result.error ?? ''))
  }
  const active = ran.length > 0 && ran.every((r) => r.code === 0)
  return { active, output: lines.join('\n').trim(), ran }
}

// -- Credentials ----------------------------------------------------------------------

export function watcherCredentialsPath(home) {
  return joinDir(watcherHome(home), CREDENTIALS_FILE_NAME)
}

function validateCredentials(creds) {
  const pairingId = creds?.pairingId
  const pairingOk =
    (typeof pairingId === 'number' && Number.isInteger(pairingId) && pairingId > 0) ||
    (typeof pairingId === 'string' && /^\d+$/.test(pairingId))
  if (!pairingOk) return 'pairingId must be a positive integer'
  if (typeof creds.token !== 'string' || !creds.token.trim()) return 'token must be a non-empty string'
  if (typeof creds.backendUrl !== 'string' || !creds.backendUrl.trim()) return 'backendUrl must be a non-empty string'
  if (typeof creds.machineId !== 'string' || !creds.machineId.trim()) return 'machineId must be a non-empty string'
  return null
}

/**
 * Write <watcherHome>/credentials.json at mode 0600. On win32 the mode is a
 * no-op; call applyWin32CredentialsAcl afterwards (icacls, like bgos-pair).
 * Throws on incomplete credentials BEFORE writing anything.
 * @param {string} home
 * @param {WatcherCredentials} creds
 * @param {import('./watcher-bundle.mjs').WatcherFs} [fs]
 * @returns {string} the path written
 */
export function writeWatcherCredentials(home, creds, fs = nodeFs()) {
  const problem = validateCredentials(creds)
  if (problem) throw new Error(`writeWatcherCredentials: ${problem}`)
  const path = watcherCredentialsPath(home)
  const body = {
    pairingId: creds.pairingId,
    token: creds.token,
    backendUrl: creds.backendUrl,
    machineId: creds.machineId,
  }
  fs.writeFile(path, `${JSON.stringify(body, null, 2)}\n`, { mode: CREDENTIALS_FILE_MODE })
  fs.chmod(path, CREDENTIALS_FILE_MODE)
  return path
}

/**
 * Read + validate the watcher credentials; null when absent, junk, or
 * incomplete (the watcher then waits, it never runs half-authenticated).
 * @returns {WatcherCredentials | null}
 */
export function readWatcherCredentials(home, fs = nodeFs()) {
  const raw = fs.readFile(watcherCredentialsPath(home))
  if (raw == null) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (validateCredentials(parsed)) return null
  return {
    pairingId: parsed.pairingId,
    token: parsed.token,
    backendUrl: parsed.backendUrl,
    machineId: parsed.machineId,
  }
}

/**
 * Lock a credentials file to the current Windows user with icacls (the exact
 * argv bgos-pair uses: strip inheritance, then grant the user full control).
 * Reports honestly: a failed lock says UNPROTECTED so the operator knows.
 * @param {string} path
 * @param {{ username: string, exec?: import('./watcher-bundle.mjs').Exec, executable?: string }} deps
 */
export async function applyWin32CredentialsAcl(path, { username, exec = nodeExec(), executable = 'icacls' }) {
  const user = String(username ?? '').trim()
  if (!user) {
    return { ok: false, message: 'UNPROTECTED, no Windows username to grant to; restrict the credentials file by hand' }
  }
  const result = await exec(executable, [String(path), '/inheritance:r', '/grant:r', `${user}:F`])
  if (result.code === 0) return { ok: true, message: 'locked to your Windows user' }
  const detail = firstLine(result.stderr) || firstLine(result.stdout) || String(result.error ?? `rc ${result.code}`)
  return { ok: false, message: `UNPROTECTED, the Windows ACL could not be applied, restrict it by hand: ${detail}` }
}
