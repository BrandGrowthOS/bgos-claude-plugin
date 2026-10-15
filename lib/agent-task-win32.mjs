/**
 * agent-task-win32: the product supervisor on Windows, a per-agent logon
 * Scheduled Task "HOAI Agent <id> home-<hid>" (design 4, Windows bullet; G7:
 * before this, `reconcileAlwaysOn` stood down on win32 and a Windows agent had
 * no supervisor at all).
 *
 * Same unelevated pattern as the watcher's own task (lib/watcher-service.mjs
 * schtasksSpec): `schtasks /Create /SC ONLOGON` is admin-only ("Access is
 * denied", measured 2026-08-25), the Task Scheduler API is not, so the task is
 * registered by a GENERATED PowerShell script calling Register-ScheduledTask for
 * the current user. Two files in the agent's state dir (~\.bgos-agent\<id>):
 *
 *   run-agent.vbs           wscript runs it with //B (no script host window); it
 *                           starts `node <plugin root>\bin\hoai-core.mjs
 *                           --keep-alive` in the agent folder in a HIDDEN
 *                           console (style 0: claude needs a real console, the
 *                           user never types in it, and since board row
 *                           d133ddb2 nobody sees it either; it was style 7,
 *                           minimized, before. Show agent windows opens a watch
 *                           only viewer BESIDE it, lib/agent-windows.mjs, and
 *                           never changes this launch) with HOAI_SUPERVISED=1 and
 *                           HOAI_SUPERVISED_ASSISTANT_ID=<id> in its
 *                           environment (run.sh's launch, design 4), and
 *                           USERPROFILE pinned to the HOME the task was
 *                           installed from (as the watcher's run-hidden.vbs),
 *                           WAITS on it and hands back
 *                           its exit code. Waiting is the difference from the
 *                           watcher's own launcher, on purpose: the task instance
 *                           then lives exactly as long as the launcher, so
 *                           MultipleInstances IgnoreNew stops a `schtasks /Run`
 *                           from starting a second session beside a live one, and
 *                           a crash is a task failure RestartCount can see.
 *   install-agent-task.ps1  install | install-disabled | run | uninstall | status
 *                           | probe | probe-legacy | retire-legacy-task, idempotent.
 *                           AtLogOn of the current user, RestartCount 999,
 *                           RestartInterval 1 minute, no execution time limit,
 *                           MultipleInstances IgnoreNew.
 *   supervisor-generation   2, the design 4 stamp (a task is never generation 1).
 *
 * Scoped to the HOME it was installed from (board row d6198bb6, as #237 scoped
 * the watcher's own task). The task used to be "HOAI Agent <id>", one name per
 * Windows user account, so a watcher or daemon in a scratch or second HOME
 * holding credentials-<id>.json for the same agent re-registered it
 * (Register-ScheduledTask -Force), started it or removed it, whoever had
 * installed it. Now the name carries `home-<hid>` (lib/agent-inventory.mjs
 * agentServiceNames, the watcher's watcherHomeId), the task records its HOME
 * and agent id (the description `HOAI agent <id>, installed from home=<HOME>`,
 * the action's launcher path, the launcher's USERPROFILE pin), and every runner
 * reads the registration back first (the script's probe actions, base64 UTF-8,
 * judged by #237's readProbe and classifyRegistration with the agent's own
 * record, lib/agent-service.mjs): one under this HOME's name that records
 * another HOME, or none readable, is refused and left exactly as it is. An old
 * "HOAI Agent <id>" is renamed in place when it records THIS HOME (the new task
 * registered first, then the old one retired, never a stop or start of the
 * agent, a Disabled task kept disabled), and left alone and reported otherwise.
 *
 * `--keep-alive` (bin/hoai-core.mjs) relaunches claude after any exit, resuming
 * the agent's pinned session (finding 7). The watcher's sweep starts the task
 * (`schtasks /Run /TN "HOAI Agent <id> home-<hid>"`, or the old name while the
 * agent is not renamed yet) when that launcher itself is dead.
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
  agentServiceNamesFor,
  agentStateDir,
  joinDir,
  validAssistantId,
} from './agent-inventory.mjs'
import { agentServiceRecord, agentTaskDescription } from './agent-service.mjs'
import { artifactName, leftAlone, probeRegistration, refusal } from './watcher-service.mjs'
import { psString, vbsString } from './win32-script-text.mjs'

// Re-exported: one implementation, shared with the watcher's own service files.
export { psString, vbsString }

export const AGENT_TASK_SCRIPT_FILE_NAME = 'install-agent-task.ps1'
export const AGENT_TASK_GENERATION = 2
/** wscript Run window style: hidden. The console exists (claude needs one), its window is never shown.
 *  The sweep's refreshTaskLauncher rewrites an installed launcher whose text differs, so a style 7
 *  launcher becomes this one at the agent's next start; a console already running keeps its window
 *  until the windows pass hides it in place (lib/agent-windows.mjs). */
const VBS_WINDOW_HIDDEN = 0

/**
 * @typedef {{ file: string, args: string[] }} TaskCommand
 * @typedef {{
 *   kind: 'schtasks', platform: 'win32', noun: 'agent', record: import('./watcher-service.mjs').RegistrationRecord,
 *   assistantId: string, home: string, homeId: string, taskName: string, label: string,
 *   stateDir: string, launcherPath: string, scriptPath: string, script: { path: string, content: string },
 *   probeCommand: TaskCommand, installCommands: TaskCommand[], installDisabledCommands: TaskCommand[],
 *   runCommands: TaskCommand[], uninstallCommands: TaskCommand[], statusCommands: TaskCommand[],
 *   legacy: { label: string, probeCommand: TaskCommand, retire: { task: TaskCommand }, runCommands: TaskCommand[] },
 * }} AgentTaskRegistration
 * @typedef {AgentTaskRegistration & {
 *   cwd: string, pluginRoot: string, nodePath: string,
 *   files: Array<{ path: string, content: string }>,
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
 * The registration of one agent's task in one HOME, with no launcher: what the
 * read-back, a start and an uninstall need (the restart ladder knows no plugin
 * root or node path). Its script is the whole install-agent-task.ps1, so a
 * runner that writes it first never runs a stale one an older version left.
 * @param {{ assistantId: string | number, home: string }} params
 * @returns {AgentTaskRegistration}
 */
export function agentTaskRegistration({ assistantId, home }) {
  const id = validAssistantId(assistantId)
  if (!id) throw new Error('agentTaskSpec: assistantId must be digits')
  const homeDir = required('home', home)
  const names = agentServiceNamesFor(id, homeDir, 'win32')
  const taskName = names.current.taskName
  const legacyName = names.legacy.taskName
  const stateDir = agentStateDir(homeDir, id)
  const launcherPath = joinDir(stateDir, AGENT_TASK_LAUNCHER_FILE_NAME)
  const scriptPath = joinDir(stateDir, AGENT_TASK_SCRIPT_FILE_NAME)
  // No Run-key fallback, unlike the watcher's script: a Run-key agent could
  // never be started by `schtasks /Run`, so the sweep would report it started
  // when it was not. A refused registration fails by name and is retried
  // hourly instead.
  //
  // probe / probe-legacy print what a registration records, for the runner to
  // judge (lib, not here, is where ownership is decided): its state, its
  // description and its actions, base64 UTF-8 so a non-ASCII HOME survives the
  // console code page (#237's Write-Probe). retire-legacy-task removes the OLD
  // unscoped task, and only ever runs once the probe proved it this HOME's.
  // install-disabled registers the task Disabled: a rename keeps a task its
  // owner disabled exactly as it was.
  const ps1 = [
    `# ${taskName}: logon task that keeps this agent running (generated by lib/agent-task-win32.mjs).`,
    'param([Parameter(Mandatory = $true)][ValidateSet("install", "install-disabled", "run", "uninstall", "status", "probe", "probe-legacy", "retire-legacy-task")][string]$Action)',
    `$name = '${taskName}'`,
    `$legacyName = '${legacyName}'`,
    `$description = ${psString(agentTaskDescription(id, homeDir))}`,
    `$vbs = ${psString(launcherPath)}`,
    'function Register-Task([bool]$disabled) {',
    '  $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B `"$vbs`""',
    '  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME',
    '  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -Disable:$disabled',
    '  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited',
    '  Register-ScheduledTask -TaskName $name -Description $description -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null',
    '}',
    'function Encode-Text([string]$text) {',
    "  if ([string]::IsNullOrEmpty($text)) { return '-' }",
    '  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))',
    '}',
    'function Write-Probe([string]$taskName) {',
    "  $task = Get-ScheduledTask -TaskPath '\\' -TaskName $taskName -ErrorAction SilentlyContinue",
    '  if ($task) {',
    '    $actions = ($task.Actions | ForEach-Object { [string]$_.Execute + " " + [string]$_.Arguments }) -join "`n"',
    '    Write-Output ("task present " + [string]$task.State + " " + (Encode-Text ([string]$task.Description)) + " " + (Encode-Text $actions))',
    '  } else { Write-Output "task absent" }',
    '}',
    'switch ($Action) {',
    '  "install" {',
    '    try { Register-Task $false; Write-Output "task registered"; exit 0 }',
    '    catch { Write-Output ("task registration refused: " + $_.Exception.Message); exit 1 }',
    '  }',
    '  "install-disabled" {',
    '    try { Register-Task $true; Write-Output "task registered (disabled)"; exit 0 }',
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
    '  "probe" { Write-Probe $name; exit 0 }',
    '  "probe-legacy" { Write-Probe $legacyName; exit 0 }',
    '  "retire-legacy-task" {',
    "    try { Unregister-ScheduledTask -TaskPath '\\' -TaskName $legacyName -Confirm:$false -ErrorAction Stop; Write-Output \"legacy task unregistered\"; exit 0 }",
    '    catch { Write-Output ("legacy task not unregistered: " + $_.Exception.Message); exit 1 }',
    '  }',
    '}',
    '',
  ].join('\r\n')
  const ps = (action) => ({
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Action', action],
  })
  return {
    kind: 'schtasks',
    platform: 'win32',
    noun: 'agent',
    record: agentServiceRecord(id),
    assistantId: id,
    home: homeDir,
    homeId: names.current.homeId,
    taskName,
    label: taskName,
    stateDir,
    launcherPath,
    scriptPath,
    script: { path: scriptPath, content: ps1 },
    probeCommand: ps('probe'),
    installCommands: [ps('install')],
    installDisabledCommands: [ps('install-disabled')],
    runCommands: [{ file: 'schtasks.exe', args: ['/Run', '/TN', taskName] }],
    uninstallCommands: [ps('uninstall')],
    statusCommands: [ps('status')],
    legacy: {
      label: legacyName,
      probeCommand: ps('probe-legacy'),
      retire: { task: ps('retire-legacy-task') },
      runCommands: [{ file: 'schtasks.exe', args: ['/Run', '/TN', legacyName] }],
    },
  }
}

/**
 * The pure task spec for one agent: its registration plus the launcher.
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
  const reg = agentTaskRegistration({ assistantId: id, home: homeDir })
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
  // than starting the wrong identity under this agent's task). USERPROFILE is
  // the HOME this task was installed from: node's os.homedir() reads it on
  // Windows, so hoai-core runs against that HOME's credentials and session pin,
  // never the logon profile's (the watcher's run-hidden.vbs pins it the same way).
  const vbs = [
    `' ${reg.taskName}: run this agent's hoai launcher (--keep-alive) in a hidden console (no window).`,
    `' Generated by lib/agent-task-win32.mjs; the Scheduled Task '${reg.taskName}' runs this at logon.`,
    'Set shell = CreateObject("WScript.Shell")',
    "' Unattended, and for this agent only (bin/hoai-core.mjs SUPERVISED_ENV), exactly as run.sh launches it.",
    'Set env = shell.Environment("PROCESS")',
    'env("HOAI_SUPERVISED") = "1"',
    `env("HOAI_SUPERVISED_ASSISTANT_ID") = "${id}"`,
    "' The HOME this task was installed from (node's os.homedir() reads USERPROFILE on Windows).",
    `shell.Environment("Process")("USERPROFILE") = ${vbsString(homeDir)}`,
    `shell.CurrentDirectory = ${vbsString(folder)}`,
    `WScript.Quit shell.Run(${vbsString(`"${node}" "${core}" --keep-alive`)}, ${VBS_WINDOW_HIDDEN}, True)`,
    '',
  ].join('\r\n')
  return {
    ...reg,
    cwd: folder,
    pluginRoot: root,
    nodePath: node,
    files: [
      { path: reg.launcherPath, content: vbs },
      { path: reg.scriptPath, content: reg.script.content },
      { path: joinDir(reg.stateDir, SUPERVISOR_GENERATION_FILE_NAME), content: `${AGENT_TASK_GENERATION}\n` },
    ],
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

/** An exec that carries a time limit into every call (a hung PowerShell must not hold the sweep). */
function timed(exec, timeoutMs) {
  return timeoutMs ? (file, args) => exec(file, args, { timeoutMs }) : exec
}

/** The task script, written before any probe: a stale one (no probe, the old name) is never what runs. */
function writeScript(reg, fs) {
  try {
    fs.mkdir(reg.stateDir)
    fs.writeFile(reg.script.path, reg.script.content)
    return null
  } catch (err) {
    return `write ${reg.script.path} failed: ${String(err?.message ?? err)}`
  }
}

/** Is a judged registration's task Disabled? A rename or re-registration keeps it so. */
function disabledTask(judged) {
  return judged.artifacts.some((a) => a.what === 'task' && a.taskState === 'Disabled')
}

const renamed = (spec) => `renamed the ${artifactName(spec, 'legacy', 'task')} (installed from this HOME by an older version) to ${artifactName(spec, 'own', 'task')}`

/**
 * Register this HOME's task for the agent, and start it when `start` is set.
 * The caller passes start=false while the agent may be running by hand: the
 * task then takes over at the next logon, or when the sweep sees the launcher
 * dead and the agent stopped (design decision D4, never a second session).
 *
 * In order: the task script; the probe of this HOME's own name, refused when it
 * records another HOME or cannot be read (nothing else is written, so the
 * inventory never reads a launcher of a task that is not this HOME's); the probe
 * of the OLD name, left alone and named in `notes` when another HOME installed
 * it; the launcher; then either the rename of this HOME's old task (the new task
 * registered first, the old one retired after, the new one unregistered again
 * when that fails) or the registration. Never a stop or start of the agent in a
 * rename: its running launcher keeps running, and IgnoreNew guards the new task.
 * A Disabled task is registered Disabled again, and never started. `keep` (the
 * sweep's once-per-agent check) leaves a task already registered under this
 * HOME's name exactly as it is: it is only read back, never registered again
 * under a running agent.
 * @param {AgentTaskSpec} spec
 * @param {{ exec: import('./watcher-bundle.mjs').Exec, fs: import('./watcher-bundle.mjs').WatcherFs, start?: boolean, keep?: boolean, timeoutMs?: number }} deps
 * @returns {Promise<{ ok: boolean, message: string, ran: Array<{ file: string, args: string[], code: number | null }>, legacy: { label: string, state: string, home: string | null } | null, notes: string[] }>}
 */
export async function installAgentTask(spec, { exec, fs, start = false, keep = false, timeoutMs = 0 }) {
  const run = timed(exec, timeoutMs)
  const ran = []
  /** @type {string[]} */
  const notes = []
  let legacy = null
  const done = (ok, message) => ({ ok, message, ran, legacy, notes })
  const scriptFailure = writeScript(spec, fs)
  if (scriptFailure) return done(false, scriptFailure)
  const own = await probeRegistration(spec, spec.probeCommand, run, ran, fs)
  if (own.state === 'foreign' || own.state === 'unknown') return done(false, refusal(spec, own))
  const old = await probeRegistration(spec, spec.legacy.probeCommand, run, ran, fs)
  legacy = { label: spec.legacy.label, state: old.state, home: old.home }
  notes.push(...leftAlone(spec, old, fs))
  try {
    for (const file of spec.files) if (file.path !== spec.scriptPath) fs.writeFile(file.path, file.content)
  } catch (err) {
    return done(false, `write ${spec.stateDir} failed: ${String(err?.message ?? err)}`)
  }
  const rename = old.state === 'own'
  const disabled = own.state === 'own' ? disabledTask(own) : rename ? disabledTask(old) : false
  if (!(keep && own.state === 'own')) {
    const failed = await runEach(disabled ? spec.installDisabledCommands : spec.installCommands, run, ran)
    if (failed) return done(false, failed)
  }
  if (rename) {
    const notRetired = await runEach([spec.legacy.retire.task], run, ran)
    if (notRetired) {
      // The new task goes again only when this install registered it.
      if (own.state === 'absent') await runEach(spec.uninstallCommands, run, ran)
      return done(false, `migration rolled back (the new task was unregistered again, the old "${spec.legacy.label}" stays): ${notRetired}`)
    }
    legacy = { ...legacy, state: 'migrated' }
    notes.push(renamed(spec))
  }
  if (start && !disabled) {
    const notStarted = await runEach(spec.runCommands, run, ran)
    if (notStarted) return done(false, notStarted)
  }
  if (keep && own.state === 'own' && !rename) return done(true, 'task registered (kept as it was)')
  return done(true, start && !disabled ? 'task registered and started' : disabled ? 'task registered (disabled, as it was)' : 'task registered')
}

/**
 * Start the agent's task now: `schtasks /Run /TN "<name>"` (IgnoreNew makes a
 * second start while it runs a no-op), after reading the registration back.
 * This HOME's own task is started; while the agent is not renamed yet, its OLD
 * task when that is proven this HOME's (the watcher supervises both names until
 * the sweep renames it); another HOME's task, or one whose HOME cannot be read,
 * never: refused by name.
 * @param {AgentTaskRegistration} reg
 * @param {{ exec: import('./watcher-bundle.mjs').Exec, fs: import('./watcher-bundle.mjs').WatcherFs, timeoutMs?: number }} deps
 * @returns {Promise<{ ok: boolean, message: string, name: string | null, ran: Array<Record<string, unknown>>, notes: string[] }>}
 */
export async function runAgentTask(reg, { exec, fs, timeoutMs = 0 }) {
  const run = timed(exec, timeoutMs)
  const ran = []
  /** @type {string[]} */
  const notes = []
  const scriptFailure = writeScript(reg, fs)
  if (scriptFailure) return { ok: false, message: `${scriptFailure}; nothing was started`, name: null, ran, notes }
  const own = await probeRegistration(reg, reg.probeCommand, run, ran, fs)
  if (own.state === 'foreign' || own.state === 'unknown') return { ok: false, message: refusal(reg, own), name: null, ran, notes }
  let target = { name: reg.taskName, commands: reg.runCommands }
  if (own.state === 'absent') {
    const old = await probeRegistration(reg, reg.legacy.probeCommand, run, ran, fs)
    notes.push(...leftAlone(reg, old, fs))
    if (old.state !== 'own') {
      const why = [`no task of this HOME to start: the ${artifactName(reg, 'own', 'task')} is not registered`, ...notes].join('; ')
      return { ok: false, message: why, name: null, ran, notes }
    }
    target = { name: reg.legacy.label, commands: reg.legacy.runCommands }
    notes.push(`started the ${artifactName(reg, 'legacy', 'task')} (installed from this HOME by an older version; the watcher renames it to "${reg.taskName}")`)
  }
  const failed = await runEach(target.commands, run, ran)
  if (failed) return { ok: false, message: failed, name: target.name, ran, notes }
  const cmd = target.commands[0]
  return { ok: true, message: `${cmd.file} ${cmd.args.join(' ')} ok`, name: target.name, ran, notes }
}

/**
 * Unregister this HOME's task and remove ONLY the files this module wrote; the
 * session pin and every other state file stay (design 4: uninstall keeps the
 * pin). Read back first: a task under this HOME's name that records ANOTHER
 * HOME is refused (ok false) and nothing of it, files included, is touched (no
 * purge); one whose HOME cannot be read is not unregistered by name, but this
 * HOME's files still go (said in `notes`). This HOME's OLD task is retired when
 * the probe proves it this HOME's; another HOME's old task is left alone and
 * named. The task script is rewritten first, so a stale one with the old name
 * in it never runs.
 * @param {AgentTaskSpec} spec
 * @param {{ exec: import('./watcher-bundle.mjs').Exec, fs: import('./watcher-bundle.mjs').WatcherFs, timeoutMs?: number }} deps
 */
export async function uninstallAgentTask(spec, { exec, fs, timeoutMs = 0 }) {
  const run = timed(exec, timeoutMs)
  const ran = []
  /** @type {string[]} */
  const notes = []
  const scriptFailure = writeScript(spec, fs)
  if (scriptFailure) return { ok: false, message: `${scriptFailure}; nothing was unregistered`, ran, removed: [], legacy: null, notes }
  const own = await probeRegistration(spec, spec.probeCommand, run, ran, fs)
  const refused = own.state === 'foreign'
  if (own.state === 'unknown') {
    notes.push(`did not unregister the ${artifactName(spec, 'own', 'task')} by name: ${refusal(spec, own).replace(/^refused: /, '')}; this HOME's own files are removed`)
  } else if (own.state === 'own') {
    for (const cmd of spec.uninstallCommands) {
      const res = await run(cmd.file, cmd.args)
      ran.push({ file: cmd.file, args: [...cmd.args], code: res?.code ?? null })
    }
  }
  const old = await probeRegistration(spec, spec.legacy.probeCommand, run, ran, fs)
  notes.push(...leftAlone(spec, old, fs))
  let retired = false
  if (old.state === 'own') {
    const failure = await runEach([spec.legacy.retire.task], run, ran)
    if (failure) notes.push(`could not remove the ${artifactName(spec, 'legacy', 'task')} (installed from this HOME by an older version): ${failure}`)
    else {
      retired = true
      notes.push(`removed the ${artifactName(spec, 'legacy', 'task')} (installed from this HOME by an older version)`)
    }
  }
  const legacy = { label: spec.legacy.label, state: old.state === 'own' && retired ? 'removed' : old.state, home: old.home }
  const removed = []
  if (!refused) {
    for (const file of spec.files ?? [spec.script]) {
      try {
        if (fs.exists(file.path)) {
          fs.rm(file.path)
          removed.push(file.path)
        }
      } catch {
        // left for the operator; the ran list shows the unregister happened
      }
    }
  }
  if (refused) return { ok: false, message: refusal(spec, own), ran, removed, legacy, notes }
  return { ok: true, message: 'uninstalled', ran, removed, legacy, notes }
}

/**
 * This HOME's task state for one agent (hoai-watcher status), read back: its
 * own task, or while the agent is not renamed yet its OLD task when that is
 * this HOME's. Another HOME's registration is never reported as this HOME's,
 * and an old one another HOME installed is named in `notes`. The script is
 * refreshed only in a state dir that exists: status never creates one.
 * @param {AgentTaskRegistration} reg
 * @param {{ exec: import('./watcher-bundle.mjs').Exec, fs: import('./watcher-bundle.mjs').WatcherFs }} deps
 */
export async function agentTaskStatus(reg, { exec, fs }) {
  const ran = []
  if (fs.exists(reg.stateDir) && fs.readFile(reg.script.path) !== reg.script.content) writeScript(reg, fs)
  const own = await probeRegistration(reg, reg.probeCommand, exec, ran, fs)
  const old = await probeRegistration(reg, reg.legacy.probeCommand, exec, ran, fs)
  const taskStateOf = (judged) => judged.artifacts.find((a) => a.what === 'task')?.taskState ?? ''
  let state = 'absent'
  let label = reg.taskName
  let line = `${artifactName(reg, 'own', 'task')} is not registered`
  if (own.state === 'own') {
    state = 'own'
    line = `${artifactName(reg, 'own', 'task')} ${taskStateOf(own) || 'registered'}`
  } else if (own.state === 'absent' && old.state === 'own') {
    state = 'legacy'
    label = reg.legacy.label
    line = `${artifactName(reg, 'legacy', 'task')} ${taskStateOf(old) || 'registered'} (installed from this HOME by an older version; the watcher renames it to "${reg.taskName}")`
  } else if (own.state !== 'absent') {
    state = 'refused'
    line = refusal(reg, own).replace(/^refused: /, '')
  }
  const active = state === 'own' || state === 'legacy'
  return { state, label, active, line, notes: leftAlone(reg, old, fs), legacy: { label: reg.legacy.label, state: old.state, home: old.home }, ran }
}
