/**
 * agent-task-win32: the product supervisor on Windows, a per-agent logon
 * Scheduled Task "HOAI Agent <id>" (design 4, Windows bullet; G7: before this,
 * `reconcileAlwaysOn` stood down on win32 and a Windows agent had no supervisor
 * at all).
 *
 * Same unelevated pattern as the watcher's own task (lib/watcher-service.mjs
 * schtasksSpec): `schtasks /Create /SC ONLOGON` is admin-only ("Access is
 * denied", measured 2026-08-25), the Task Scheduler API is not, so the task is
 * registered by a GENERATED PowerShell script calling Register-ScheduledTask for
 * the current user. Two files in the agent's state dir (~\.bgos-agent\<id>):
 *
 *   run-agent.vbs           wscript runs it with //B (no script host window); it
 *                           starts `node <plugin root>\bin\hoai-core.mjs
 *                           --keep-alive` in the agent folder in a MINIMIZED
 *                           console (style 7: claude needs a real console, the
 *                           user never types in it) with HOAI_SUPERVISED=1 and
 *                           HOAI_SUPERVISED_ASSISTANT_ID=<id> in its
 *                           environment (run.sh's launch, design 4), WAITS on it and hands back
 *                           its exit code. Waiting is the difference from the
 *                           watcher's own launcher, on purpose: the task instance
 *                           then lives exactly as long as the launcher, so
 *                           MultipleInstances IgnoreNew stops a `schtasks /Run`
 *                           from starting a second session beside a live one, and
 *                           a crash is a task failure RestartCount can see.
 *   install-agent-task.ps1  install | run | uninstall | status, idempotent.
 *                           AtLogOn of the current user, RestartCount 999,
 *                           RestartInterval 1 minute, no execution time limit,
 *                           MultipleInstances IgnoreNew.
 *   supervisor-generation   2, the design 4 stamp (a task is never generation 1).
 *
 * `--keep-alive` (bin/hoai-core.mjs) relaunches claude after any exit, resuming
 * the agent's pinned session (finding 7). The watcher's sweep starts the task
 * (`schtasks /Run /TN "HOAI Agent <id>"`) when that launcher itself is dead.
 *
 * The plugin root is baked into the vbs, so the sweep rewrites the vbs when the
 * CURRENT root moves (a marketplace update changes the cache dir): a restart
 * then lands on the installed version, which is what makes "restart onto a
 * staged update" a plain restart here too.
 *
 * Paths are embedded in a VBScript literal and a PowerShell single-quoted
 * string; a quote in any of them is refused (thrown) rather than escaped, the
 * watcher's rule, so a generated file can never be mis-split. Both files are
 * pure ASCII whatever the paths hold (vbsString, psString from
 * lib/win32-script-text.mjs): neither reader decodes a BOM-less UTF-8 file as
 * UTF-8.
 *
 * Pure spec builder; runners take an injected exec + fs. Plain JavaScript,
 * node >= 18, import-safe.
 */

import {
  AGENT_TASK_LAUNCHER_FILE_NAME,
  SUPERVISOR_GENERATION_FILE_NAME,
  agentStateDir,
  agentTaskName,
  joinDir,
  validAssistantId,
} from './agent-inventory.mjs'
import { psString, vbsString } from './win32-script-text.mjs'

// Re-exported: one implementation, shared with the watcher's own service files.
export { psString, vbsString }

export const AGENT_TASK_SCRIPT_FILE_NAME = 'install-agent-task.ps1'
export const AGENT_TASK_GENERATION = 2
/** wscript Run window style: minimized, focus stays where it was. */
const VBS_WINDOW_MINIMIZED_NOACTIVATE = 7

/**
 * @typedef {{ file: string, args: string[] }} TaskCommand
 * @typedef {{
 *   assistantId: string, taskName: string, stateDir: string, launcherPath: string, scriptPath: string,
 *   cwd: string, pluginRoot: string, nodePath: string,
 *   files: Array<{ path: string, content: string }>,
 *   installCommands: TaskCommand[], runCommands: TaskCommand[],
 *   uninstallCommands: TaskCommand[], statusCommands: TaskCommand[],
 * }} AgentTaskSpec
 */

function required(name, value) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`agentTaskSpec: ${name} is required`)
  if (text.includes('"') || text.includes("'")) {
    throw new Error(`agentTaskSpec: ${name} contains a quote, which cannot be embedded in the vbs launcher or the task script`)
  }
  return text
}

/**
 * The pure task spec for one agent.
 * @param {{ assistantId: string | number, home: string, nodePath: string, pluginRoot: string, cwd: string }} params
 * @returns {AgentTaskSpec}
 */
export function agentTaskSpec({ assistantId, home, nodePath, pluginRoot, cwd }) {
  const id = validAssistantId(assistantId)
  if (!id) throw new Error('agentTaskSpec: assistantId must be digits')
  const homeDir = required('home', home)
  const node = required('nodePath', nodePath)
  const root = required('pluginRoot', pluginRoot)
  const folder = required('cwd', cwd)
  const taskName = agentTaskName(id)
  const stateDir = agentStateDir(homeDir, id)
  const launcherPath = joinDir(stateDir, AGENT_TASK_LAUNCHER_FILE_NAME)
  const scriptPath = joinDir(stateDir, AGENT_TASK_SCRIPT_FILE_NAME)
  const core = joinDir(joinDir(root, 'bin'), 'hoai-core.mjs')
  // VBScript doubles a quote inside a string literal; the whole command line
  // is one literal so paths with spaces stay one argument each.
  //
  // The PROCESS environment set here is what shell.Run hands its child, so
  // hoai-core starts exactly as run.sh starts it on posix: HOAI_SUPERVISED=1
  // (nobody is at that console, so the startup gate is always answered and a
  // path that would wait for a person stops by name instead) and
  // HOAI_SUPERVISED_ASSISTANT_ID (the pin is THIS agent's even in a folder that
  // declares none, and a folder pinned to another agent stops by name rather
  // than starting the wrong identity under this agent's task).
  const vbs = [
    `' ${taskName}: run this agent's hoai launcher (--keep-alive) in a minimized console.`,
    `' Generated by lib/agent-task-win32.mjs; the Scheduled Task '${taskName}' runs this at logon.`,
    'Set shell = CreateObject("WScript.Shell")',
    "' Unattended, and for this agent only (bin/hoai-core.mjs SUPERVISED_ENV), exactly as run.sh launches it.",
    'Set env = shell.Environment("PROCESS")',
    'env("HOAI_SUPERVISED") = "1"',
    `env("HOAI_SUPERVISED_ASSISTANT_ID") = "${id}"`,
    `shell.CurrentDirectory = ${vbsString(folder)}`,
    `WScript.Quit shell.Run(${vbsString(`"${node}" "${core}" --keep-alive`)}, ${VBS_WINDOW_MINIMIZED_NOACTIVATE}, True)`,
    '',
  ].join('\r\n')
  // No Run-key fallback, unlike the watcher's script: a Run-key agent could
  // never be started by `schtasks /Run`, so the sweep would report it started
  // when it was not. A refused registration fails by name and is retried
  // hourly instead.
  const ps1 = [
    `# ${taskName}: logon task that keeps this agent running (generated by lib/agent-task-win32.mjs).`,
    'param([Parameter(Mandatory = $true)][ValidateSet("install", "run", "uninstall", "status")][string]$Action)',
    `$name = '${taskName}'`,
    `$vbs = ${psString(launcherPath)}`,
    'function Register-Task {',
    '  $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B `"$vbs`""',
    '  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME',
    '  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew',
    '  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited',
    '  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null',
    '}',
    'switch ($Action) {',
    '  "install" {',
    '    try { Register-Task; Write-Output "task registered"; exit 0 }',
    '    catch { Write-Output ("task registration refused: " + $_.Exception.Message); exit 1 }',
    '  }',
    '  "run" {',
    '    try { Start-ScheduledTask -TaskName $name -ErrorAction Stop; Write-Output "task started"; exit 0 }',
    '    catch { Write-Output ("task start refused: " + $_.Exception.Message); exit 1 }',
    '  }',
    '  "uninstall" {',
    '    try { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop } catch {}',
    '    Write-Output "unregistered"; exit 0',
    '  }',
    '  "status" {',
    '    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue',
    '    if ($task) { Write-Output ("task " + $task.State); exit 0 }',
    '    Write-Output "not registered"; exit 1',
    '  }',
    '}',
    '',
  ].join('\r\n')
  const ps = (action) => ({
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Action', action],
  })
  return {
    assistantId: id,
    taskName,
    stateDir,
    launcherPath,
    scriptPath,
    cwd: folder,
    pluginRoot: root,
    nodePath: node,
    files: [
      { path: launcherPath, content: vbs },
      { path: scriptPath, content: ps1 },
      { path: joinDir(stateDir, SUPERVISOR_GENERATION_FILE_NAME), content: `${AGENT_TASK_GENERATION}\n` },
    ],
    installCommands: [ps('install')],
    runCommands: [{ file: 'schtasks.exe', args: ['/Run', '/TN', taskName] }],
    uninstallCommands: [ps('uninstall')],
    statusCommands: [ps('status')],
  }
}

// -- Runners ---------------------------------------------------------------------------

function firstLine(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? ''
}

async function runEach(commands, exec, ran) {
  for (const cmd of commands) {
    const res = await exec(cmd.file, cmd.args)
    ran.push({ file: cmd.file, args: [...cmd.args], code: res?.code ?? null })
    if (res?.code !== 0) {
      const detail = firstLine(res?.stderr) || firstLine(res?.stdout) || String(res?.error ?? '') || 'no output'
      return `${cmd.file} ${cmd.args.join(' ')} failed (rc ${res?.code ?? 'null'}): ${detail}`
    }
  }
  return null
}

/**
 * Write the task files, register the task, and start it when `start` is set.
 * The caller passes start=false while the agent may be running by hand: the
 * task then takes over at the next logon, or when the sweep sees the launcher
 * dead and the agent stopped (design decision D4, never a second session).
 * @param {AgentTaskSpec} spec
 * @param {{ exec: import('./watcher-bundle.mjs').Exec, fs: import('./watcher-bundle.mjs').WatcherFs, start?: boolean }} deps
 * @returns {Promise<{ ok: boolean, message: string, ran: Array<{ file: string, args: string[], code: number | null }> }>}
 */
export async function installAgentTask(spec, { exec, fs, start = false }) {
  const ran = []
  try {
    fs.mkdir(spec.stateDir)
    for (const file of spec.files) fs.writeFile(file.path, file.content)
  } catch (err) {
    return { ok: false, message: `write ${spec.stateDir} failed: ${String(err?.message ?? err)}`, ran }
  }
  const failed = await runEach(spec.installCommands, exec, ran)
  if (failed) return { ok: false, message: failed, ran }
  if (start) {
    const notStarted = await runEach(spec.runCommands, exec, ran)
    if (notStarted) return { ok: false, message: notStarted, ran }
  }
  return { ok: true, message: start ? 'task registered and started' : 'task registered', ran }
}

/**
 * Start the task now: `schtasks /Run /TN "HOAI Agent <id>"` (IgnoreNew makes a
 * second start while it runs a no-op).
 * @param {AgentTaskSpec} spec
 * @param {{ exec: import('./watcher-bundle.mjs').Exec }} deps
 */
export async function runAgentTask(spec, { exec }) {
  const failed = await runEach(spec.runCommands, exec, [])
  if (failed) return { ok: false, message: failed }
  const cmd = spec.runCommands[0]
  return { ok: true, message: `${cmd.file} ${cmd.args.join(' ')} ok` }
}

/**
 * Unregister the task (best effort) and remove ONLY the files this module
 * wrote; the session pin and every other state file stay (design 4: uninstall
 * keeps the pin).
 * @param {AgentTaskSpec} spec
 * @param {{ exec: import('./watcher-bundle.mjs').Exec, fs: import('./watcher-bundle.mjs').WatcherFs }} deps
 */
export async function uninstallAgentTask(spec, { exec, fs }) {
  const ran = []
  for (const cmd of spec.uninstallCommands) {
    const res = await exec(cmd.file, cmd.args)
    ran.push({ file: cmd.file, args: [...cmd.args], code: res?.code ?? null })
  }
  const removed = []
  for (const file of spec.files) {
    try {
      if (fs.exists(file.path)) {
        fs.rm(file.path)
        removed.push(file.path)
      }
    } catch {
      // left for the operator; the ran list shows the unregister happened
    }
  }
  return { ok: true, message: 'uninstalled', ran, removed }
}
