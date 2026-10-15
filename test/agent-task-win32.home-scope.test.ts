/**
 * The per-agent Windows logon task is scoped to the HOME it was installed from (board row
 * d6198bb6, mission 154 goal 8), as #237 scoped the watcher's own task.
 *
 * Before: every agent task was "HOAI Agent <id>", one name per Windows user account. A watcher
 * or daemon in a scratch or second HOME holding credentials-<id>.json for the same agent
 * re-registered it (Register-ScheduledTask -Force), started it (schtasks /Run) or removed it
 * (Unregister-ScheduledTask), whoever had installed it. Now the name carries `home-<id>` (the
 * watcher's watcherHomeId), the task records its HOME and agent id (description, action path,
 * a launcher that pins USERPROFILE), every action reads the registration back first and refuses
 * one from another HOME, and an old "HOAI Agent <id>" is renamed in place only when it is this
 * HOME's (never a stop or start of the agent), left alone and reported otherwise.
 *
 * Every task call goes through test/helpers/fake-agent-tasks.ts. No real task is created,
 * changed, run or read.
 *
 * Run: npx tsx --test test/agent-task-win32.home-scope.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { agentTaskRegistration, agentTaskSpec, agentTaskStatus, installAgentTask, runAgentTask, uninstallAgentTask } from '../lib/agent-task-win32.mjs'
import { agentHomeId, agentServiceNames, listAgents } from '../lib/agent-inventory.mjs'
import { restartAgent } from '../lib/agent-restart.mjs'
import { runKeepAliveSweep } from '../lib/watcher-keepalive.mjs'
import { buildLaunchRecipe } from '../lib/agent-inventory.mjs'
import { watcherHomeId } from '../lib/watcher-service.mjs'
import { memoryFs, type MemoryFs } from './helpers/memory-fs.ts'
import { evalPs } from './helpers/fake-service-host.ts'
import { fakeAgentTasks, type FakeAgentTasks } from './helpers/fake-agent-tasks.ts'

const OWNER = 'C:\\Users\\kc'
const SCRATCH = 'E:\\rig\\scratch-home'
const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const ROOT = 'C:\\Users\\kc\\.claude\\plugins\\cache\\hoai\\hoai\\0.69.3'
const CWD = 'C:\\Users\\kc\\hoai-agents\\ava'
const SCRATCH_CWD = 'E:\\rig\\scratch-home\\agents\\ava'
const ID = '912'
// The HOME ids are pinned as literals: a change to the hash is a rename of every installed task.
const OWNER_ID = '66ede649'
const SCRATCH_ID = '9d34342e'
const OWNER_TASK = `HOAI Agent ${ID} home-${OWNER_ID}`
const SCRATCH_TASK = `HOAI Agent ${ID} home-${SCRATCH_ID}`
const OLD_TASK = `HOAI Agent ${ID}`
const stateDir = (home: string) => `${home}\\.bgos-agent\\${ID}`
const vbsOf = (home: string) => `${stateDir(home)}\\run-agent.vbs`

function spec(home = OWNER, cwd = CWD) {
  return agentTaskSpec({ assistantId: ID, home, nodePath: NODE, pluginRoot: ROOT, cwd })
}

function world(opts: { fail?: Array<{ match: string; code?: number; stderr?: string; times?: number }>; queryErrors?: Array<{ action: 'probe' | 'probe-legacy'; times?: number; after?: number }> } = {}) {
  const fs = memoryFs()
  const host = fakeAgentTasks({ fs, fail: opts.fail, queryErrors: opts.queryErrors })
  return { fs, host }
}

/** The 0.69.2 task, byte for byte as that version registered it: no description, the bare name. */
function seedOldTask(host: FakeAgentTasks, fs: MemoryFs, home = OWNER, running = true) {
  fs.writeFile(vbsOf(home), "' HOAI Agent 912: run this agent's hoai launcher (--keep-alive) in a hidden console (no window).\r\n")
  host.seed.task(OLD_TASK, vbsOf(home), { running })
}

const snapshotOf = (host: FakeAgentTasks, name: string) => JSON.stringify(host.tasks.get(name) ?? null)
/** A command that names the OLD task itself (not a scoped name it is the prefix of). */
const namesOldTask = (c: string) => new RegExp(`${OLD_TASK}(?! home-)`).test(c)
const k = (dir: string) => dir.toLowerCase()

// -- names and records ---------------------------------------------------------------------------

test('names: every agent service name carries #237\'s home-<id> (pinned), and without a HOME id they are the OLD names exactly', () => {
  assert.equal(agentHomeId(OWNER, 'win32'), OWNER_ID)
  assert.equal(agentHomeId(OWNER, 'win32'), watcherHomeId(OWNER, 'win32'), 'one HOME id for the watcher and its agents')
  for (const same of ['c:\\users\\KC', 'C:/Users/kc/', ' C:\\Users\\kc\\ ']) assert.equal(agentHomeId(same, 'win32'), OWNER_ID, same)
  assert.equal(agentHomeId(SCRATCH, 'win32'), SCRATCH_ID)
  assert.deepEqual(agentServiceNames(ID, OWNER_ID), {
    assistantId: ID,
    homeId: OWNER_ID,
    taskName: OWNER_TASK,
    launchdLabel: `ai.bgos.agent.${ID}.home-${OWNER_ID}`,
    systemdUnit: `bgos-agent-${ID}-home-${OWNER_ID}`,
    tmuxSocket: `hoai-${ID}-home-${OWNER_ID}`,
  })
  assert.deepEqual(agentServiceNames(ID, ''), {
    assistantId: ID,
    homeId: '',
    taskName: OLD_TASK,
    launchdLabel: `ai.bgos.agent.${ID}`,
    systemdUnit: `bgos-agent-${ID}`,
    tmuxSocket: `hoai-${ID}`,
  })
  // A junk id or HOME id names nothing new: never a guessed name.
  assert.equal(agentServiceNames('9 1', OWNER_ID), null)
  assert.equal(agentServiceNames(ID, 'xyz')!.homeId, '')
})

test('the task records its HOME and agent id: description, action path, and a launcher that pins USERPROFILE to that HOME', () => {
  const s = spec()
  assert.equal(s.taskName, OWNER_TASK)
  assert.equal(s.legacy.label, OLD_TASK)
  assert.equal(s.home, OWNER)
  assert.equal(s.homeId, OWNER_ID)
  const [vbs, ps1, generation] = s.files.map((f: any) => f.content)
  assert.ok(vbs.split('\r\n').includes('shell.Environment("Process")("USERPROFILE") = "C:\\Users\\kc"'), vbs)
  assert.ok(vbs.includes(`the Scheduled Task '${OWNER_TASK}' runs this at logon`))
  assert.equal(evalPs(/^\$description = (.*)$/m.exec(ps1)![1]!.trim()), `HOAI agent ${ID}, installed from home=${OWNER}`)
  assert.equal(evalPs(/^\$name = (.*)$/m.exec(ps1)![1]!.trim()), OWNER_TASK)
  assert.equal(evalPs(/^\$legacyName = (.*)$/m.exec(ps1)![1]!.trim()), OLD_TASK)
  assert.match(ps1, /Register-ScheduledTask -TaskName \$name -Description \$description /)
  assert.match(ps1, /ValidateSet\("install", "install-disabled", "run", "uninstall", "status", "probe", "probe-legacy", "retire-legacy-task"\)/)
  assert.equal(generation, '2\n', 'the design 4 generation stamp is unchanged')
  // A non-ASCII HOME survives the ANSI code page (vbsString / psString).
  const accent = agentTaskSpec({ assistantId: ID, home: 'C:\\Users\\Zoé', nodePath: NODE, pluginRoot: ROOT, cwd: CWD })
  assert.equal(/[^\x00-\x7f]/.test(accent.files[0].content + accent.files[1].content), false)
  assert.equal(evalPs(/^\$description = (.*)$/m.exec(accent.files[1].content)![1]!.trim()), `HOAI agent ${ID}, installed from home=C:\\Users\\Zoé`)
})

const POWERSHELL = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : ''
test('win32 only: Windows PowerShell 5.1 parses the generated agent task script cleanly (parse only, nothing in it runs)', { skip: process.platform !== 'win32' || !existsSync(POWERSHELL) }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-task-ps1-'))
  try {
    ;[OWNER, 'C:\\Users\\Jos\u00e9 \u0648\u0643\u064a\u0644', 'D:\\Users\\o r'].forEach((home, i) => {
      writeFileSync(join(dir, `t${i}.ps1`), agentTaskRegistration({ assistantId: ID, home }).script.content)
    })
    const script = `$n = 0; foreach ($f in Get-ChildItem -LiteralPath '${dir}' -Filter '*.ps1') { $t = $null; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$t, [ref]$e); $n += $e.Count; foreach ($x in $e) { Write-Output ($f.Name + ': ' + $x.Message) } }; Write-Output ('errors=' + $n)`
    const out = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
    assert.match(out, /errors=0\s*$/, out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// -- two HOMEs side by side ------------------------------------------------------------------------

test('two HOMEs with the same agent id side by side: each registers its own task, neither replaces the other', async () => {
  const { fs, host } = world()
  const owner = await installAgentTask(spec(), { exec: host.exec, fs, start: true })
  assert.equal(owner.ok, true, owner.message)
  const ownerTask = snapshotOf(host, OWNER_TASK)
  const scratch = await installAgentTask(spec(SCRATCH, SCRATCH_CWD), { exec: host.exec, fs, start: true })
  assert.equal(scratch.ok, true, scratch.message)
  assert.deepEqual([...host.tasks.keys()].sort(), [OWNER_TASK, SCRATCH_TASK].sort())
  assert.equal(snapshotOf(host, OWNER_TASK), ownerTask, 'the owner task, byte for byte')
  assert.equal(host.tasks.get(OWNER_TASK)!.action, `wscript.exe //B "${vbsOf(OWNER)}"`)
  assert.equal(host.tasks.get(SCRATCH_TASK)!.action, `wscript.exe //B "${vbsOf(SCRATCH)}"`)
  assert.equal(host.tasks.get(SCRATCH_TASK)!.description, `HOAI agent ${ID}, installed from home=${SCRATCH}`)
  assert.deepEqual(host.running(), { [k(stateDir(OWNER))]: 1, [k(stateDir(SCRATCH))]: 1 })
  // A start from either HOME starts that HOME's task, never the other's.
  host.endInstance(OWNER_TASK)
  const from = host.calls.length
  const started = await runAgentTask(agentTaskRegistration({ assistantId: ID, home: SCRATCH }), { exec: host.exec, fs })
  assert.equal(started.ok, true, started.message)
  assert.equal(host.instances.has(OWNER_TASK), false, 'the owner task was not started from the scratch HOME')
  assert.equal(host.calls.slice(from).some((c) => c === `schtasks.exe /Run /TN ${OWNER_TASK}`), false)
})

// -- a scratch HOME never touches the owner's task ---------------------------------------------------

test('a scratch HOME cannot touch the default HOME\'s 0.69.2 task: install, start, status and uninstall leave "HOAI Agent <id>" exactly as it was, and say so', async () => {
  const { fs, host } = world()
  seedOldTask(host, fs, OWNER, true)
  const before = snapshotOf(host, OLD_TASK)
  const installed = await installAgentTask(spec(SCRATCH, SCRATCH_CWD), { exec: host.exec, fs, start: true })
  assert.equal(installed.ok, true, installed.message)
  assert.deepEqual(installed.legacy, { label: OLD_TASK, state: 'foreign', home: OWNER })
  assert.ok(
    installed.notes.some((n: string) => n.startsWith(`left the Scheduled Task "${OLD_TASK}" alone: it was installed from another HOME (${OWNER})`)),
    installed.notes.join('\n'),
  )
  // The reader here is the scratch HOME and the task is the owner's real one: never a hint to remove it.
  assert.equal(installed.notes.some((n: string) => /Unregister-ScheduledTask/.test(n)), false, installed.notes.join('\n'))
  const started = await runAgentTask(agentTaskRegistration({ assistantId: ID, home: SCRATCH }), { exec: host.exec, fs })
  assert.equal(started.ok, true, started.message)
  const status = await agentTaskStatus(agentTaskRegistration({ assistantId: ID, home: SCRATCH }), { exec: host.exec, fs })
  assert.equal(status.label, SCRATCH_TASK)
  assert.ok(status.notes.some((n: string) => n.includes(`"${OLD_TASK}" alone`)), status.notes.join('\n'))
  const removed = await uninstallAgentTask(spec(SCRATCH, SCRATCH_CWD), { exec: host.exec, fs })
  assert.equal(removed.ok, true, removed.message)
  assert.equal(host.tasks.has(SCRATCH_TASK), false)
  assert.equal(snapshotOf(host, OLD_TASK), before, 'the owner task, byte for byte')
  assert.equal(host.instances.has(OLD_TASK), true, 'and its running agent untouched')
  // The old name was only ever READ from the scratch HOME (probe-legacy), never acted on.
  const touching = host.calls.filter((c) => namesOldTask(c) || (c.includes(stateDir(OWNER)) && !c.endsWith('-Action probe-legacy')))
  assert.deepEqual(touching, [])
  assert.equal(host.calls.some((c) => c.includes('retire-legacy-task')), false)
  assert.equal(fs.exists(vbsOf(OWNER)), true, 'the owner launcher is not the scratch HOME\'s to remove')
})

test('the restart ladder\'s task tier from a scratch HOME never starts the owner\'s task: its own task, or a refusal by name', async () => {
  const { fs, host } = world()
  seedOldTask(host, fs, OWNER, false)
  fs.writeFile(vbsOf(SCRATCH), "' scratch launcher\r\n")
  const row = { assistantId: ID, home: SCRATCH, supervisor: 'service', launcherLive: false, stateDir: stateDir(SCRATCH), service: { kind: 'schtasks', handle: SCRATCH_TASK, legacyHandle: OLD_TASK, via: 'canonical-file', file: vbsOf(SCRATCH), home: SCRATCH }, pluginStateDir: `${SCRATCH}\\.bgos-plugin-state\\${ID}`, credentialsPath: `${SCRATCH}\\.bgos-agent\\credentials-${ID}.json` }
  const refused = await restartAgent(row as any, { platform: 'win32', fs, exec: host.exec, now: () => 0, pidAlive: () => false })
  assert.equal(refused.ok, false)
  assert.equal(refused.how, 'task')
  assert.match(refused.message, /not registered/)
  assert.match(refused.message, new RegExp(`left the Scheduled Task "${OLD_TASK}" alone: it was installed from another HOME`))
  assert.equal(host.calls.some((c) => c.startsWith('schtasks.exe')), false, 'nothing was started')
  assert.equal(host.instances.size, 0)
})

test('this HOME\'s own name recording another HOME is refused, never replaced: install, start and uninstall leave it as it is, and no launcher is written', async () => {
  const { fs, host } = world()
  // A task under the owner's scoped name that runs the scratch HOME's launcher (copied, or a hash collision).
  host.seed.task(OWNER_TASK, vbsOf(SCRATCH), { description: `HOAI agent ${ID}, installed from home=${SCRATCH}` })
  const before = snapshotOf(host, OWNER_TASK)
  const installed = await installAgentTask(spec(), { exec: host.exec, fs, start: true })
  assert.equal(installed.ok, false)
  assert.equal(installed.message, `refused: the Scheduled Task "${OWNER_TASK}" records another HOME (${SCRATCH}), not this one (${OWNER}); it is left as it is`)
  assert.equal(fs.exists(vbsOf(OWNER)), false, 'a refused install writes no launcher (the inventory would read it as a task)')
  const started = await runAgentTask(agentTaskRegistration({ assistantId: ID, home: OWNER }), { exec: host.exec, fs })
  assert.equal(started.ok, false)
  assert.match(started.message, /^refused: /)
  const removed = await uninstallAgentTask(spec(), { exec: host.exec, fs })
  assert.equal(removed.ok, false)
  assert.match(removed.message, /^refused: /)
  assert.equal(snapshotOf(host, OWNER_TASK), before)
  assert.equal(host.calls.some((c) => c.endsWith('-Action install') || c.endsWith('-Action uninstall') || c.startsWith('schtasks.exe')), false)
})

test('a task under this HOME\'s own name whose HOME cannot be read is refused too (unknown is never acted on)', async () => {
  const { fs, host } = world()
  host.seed.task(OWNER_TASK, 'C:\\somewhere\\else.vbs')
  const installed = await installAgentTask(spec(), { exec: host.exec, fs, start: false })
  assert.equal(installed.ok, false)
  assert.equal(installed.message, `refused: the Scheduled Task "${OWNER_TASK}" exists but which HOME installed it could not be read; it is left as it is`)
  // An unreadable probe (PowerShell not answering) is unknown as well.
  const silent = world({ fail: [{ match: '-Action probe', code: 1, stderr: 'powershell: denied' }] })
  const quiet = await installAgentTask(spec(), { exec: silent.host.exec, fs: silent.fs, start: false })
  assert.equal(quiet.ok, false)
  assert.match(quiet.message, /^refused: which HOME the Scheduled Task ".*" belongs to could not be read \(powershell\.exe .* failed \(rc 1\): powershell: denied\); nothing was changed$/)
})

// -- the same HOME's old task is renamed in place ----------------------------------------------------

test('same-HOME migration: the 0.69.2 "HOAI Agent <id>" is renamed in place: the new task is registered BEFORE the old one goes, the running agent is never stopped or started', async () => {
  const { fs, host } = world()
  seedOldTask(host, fs, OWNER, true)
  const result = await installAgentTask(spec(), { exec: host.exec, fs, start: false })
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(result.legacy, { label: OLD_TASK, state: 'migrated', home: OWNER })
  assert.ok(result.notes.includes(`renamed the Scheduled Task "${OLD_TASK}" (installed from this HOME by an older version) to Scheduled Task "${OWNER_TASK}"`), result.notes.join('\n'))
  assert.deepEqual([...host.tasks.keys()], [OWNER_TASK])
  assert.equal(host.tasks.get(OWNER_TASK)!.description, `HOAI agent ${ID}, installed from home=${OWNER}`)
  // Never a moment without a registration of this agent, never two launchers.
  const dir = k(stateDir(OWNER))
  for (const snap of host.timeline) {
    assert.ok((snap.registrations[dir] ?? []).length >= 1, `no registration at: ${snap.cmd}`)
    assert.ok((snap.running[dir] ?? 0) <= 1, `two launchers at: ${snap.cmd}`)
  }
  const order = host.calls.map((c) => c.replace(/^.* -Action /, ''))
  assert.ok(order.indexOf('install') < order.indexOf('retire-legacy-task'), order.join(', '))
  assert.equal(host.calls.some((c) => c.startsWith('schtasks.exe') || c.endsWith('-Action run') || c.endsWith('-Action uninstall')), false, 'no start, no stop')
  assert.equal(host.startsOf(stateDir(OWNER)), 1, 'the running launcher kept running: not one new start')
  assert.equal(host.instances.has(OLD_TASK), true)
})

test('the watcher\'s rename keeps a task its owner DISABLED disabled: the new task is registered Disabled, never enabled or started; an explicit install enables it, as it always did', async () => {
  const { fs, host } = world()
  fs.writeFile(vbsOf(OWNER), "' launcher\r\n")
  host.seed.task(OLD_TASK, vbsOf(OWNER), { disabled: true })
  const result = await installAgentTask(spec(), { exec: host.exec, fs, start: false, keep: true })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.started, false)
  assert.deepEqual([...host.tasks.keys()], [OWNER_TASK])
  assert.equal(host.tasks.get(OWNER_TASK)!.state, 'Disabled', 'disabled as it was')
  assert.ok(host.calls.some((c) => c.endsWith('-Action install-disabled')))
  assert.equal(host.calls.some((c) => c.endsWith('-Action install') || c.startsWith('schtasks.exe')), false, 'never enabled, never started')
  // An explicit install (create_agent, the sweep's install of an agent with no task) registers it
  // enabled and starts it when asked: exactly what 0.69.2 did.
  const explicit = await installAgentTask(spec(), { exec: host.exec, fs, start: true })
  assert.equal(explicit.ok, true, explicit.message)
  assert.equal(explicit.started, true)
  assert.equal(host.tasks.get(OWNER_TASK)!.state, 'Running')
})

test('round 2 H1: the watcher\'s check registers this HOME\'s own task when the old name is ANOTHER HOME\'s (the 0.69.2 rig clobber): enabled, not started, verified; the foreign task left alone and named', async () => {
  const { fs, host } = world()
  fs.writeFile(vbsOf(OWNER), "' launcher\r\n")
  fs.writeFile(vbsOf(SCRATCH), "' the rig's 0.69.2 launcher\r\n")
  host.seed.task(OLD_TASK, vbsOf(SCRATCH))
  const foreign = snapshotOf(host, OLD_TASK)
  const result = await installAgentTask(spec(), { exec: host.exec, fs, start: false, keep: true })
  assert.equal(host.tasks.get(OWNER_TASK)?.state, 'Ready', 'this HOME\'s own task is registered, enabled, nothing started')
  assert.equal(result.ok, true, result.message)
  assert.equal(result.verified, true, 'this HOME\'s task was read back after it was registered')
  assert.equal(result.started, false)
  assert.equal(host.tasks.get(OWNER_TASK)?.description, `HOAI agent ${ID}, installed from home=${OWNER}`)
  assert.equal(snapshotOf(host, OLD_TASK), foreign, 'the other HOME\'s task, byte for byte')
  assert.ok(result.notes.some((n: string) => n.startsWith(`left the Scheduled Task "${OLD_TASK}" alone: it was installed from another HOME (${SCRATCH})`)), result.notes.join('\n'))
  // Said plainly (review of round 2): both tasks start at logon now; never how to remove the other one.
  const beside = result.notes.find((n: string) => n.startsWith(`registered this HOME's own Scheduled Task "${OWNER_TASK}" beside it`))
  assert.ok(beside, result.notes.join('\n'))
  assert.match(beside!, /the Scheduled Task "HOAI Agent 912" still starts at logon too/)
  assert.doesNotMatch(result.notes.join('\n'), /Unregister-ScheduledTask/)
  assert.deepEqual(host.calls.map((c) => c.replace(/^.* -Action /, '')), ['probe', 'probe-legacy', 'install', 'probe'])
})

test('round 2 H1: with NEITHER name registered (a task removed, or renamed away by another HOME\'s 0.69.3), the check registers this HOME\'s own task and verifies it, so the agent is supervised again', async () => {
  const { fs, host } = world()
  fs.writeFile(vbsOf(OWNER), "' launcher\r\n")
  const result = await installAgentTask(spec(), { exec: host.exec, fs, start: false, keep: true })
  assert.deepEqual([...host.tasks.keys()], [OWNER_TASK], 'this HOME\'s own task is registered')
  assert.equal(result.ok, true, result.message)
  assert.equal(result.verified, true)
  assert.deepEqual(host.calls.map((c) => c.replace(/^.* -Action /, '')), ['probe', 'probe-legacy', 'install', 'probe'])
})

test('round 2 H1: a registration the read-back cannot confirm is NOT verified (the sweep never records it as checked)', async () => {
  // The own probe answers, the registration "succeeds", the verifying probe after it fails.
  const { fs, host } = world({ queryErrors: [{ action: 'probe', after: 1, times: 1 }] })
  fs.writeFile(vbsOf(OWNER), "' launcher\r\n")
  const result = await installAgentTask(spec(), { exec: host.exec, fs, start: false, keep: true })
  assert.equal(result.ok, false, 'not done: the registration was not read back')
  assert.match(result.message, /could not be read back after it was registered/)
  assert.equal(result.verified, false)
})

test('round 2 M2: a Get-ScheduledTask that fails inside the probe is UNKNOWN, never "task absent": this HOME\'s old task is not left unrenamed and marked checked, and no second task is registered beside it', async () => {
  // The sweep's check: the old task is this HOME's, but the legacy probe's query fails once.
  const check = world({ queryErrors: [{ action: 'probe-legacy', times: 1 }] })
  seedOldTask(check.host, check.fs, OWNER, true)
  const kept = await installAgentTask(spec(), { exec: check.host.exec, fs: check.fs, start: false, keep: true })
  assert.equal(kept.ok, false, 'not done: the old task could not be read')
  assert.equal(kept.verified, false)
  assert.match(kept.message, /^refused: the old Scheduled Task "HOAI Agent 912" could not be read back/)
  assert.deepEqual([...check.host.tasks.keys()], [OLD_TASK], 'nothing registered beside it')
  // Read again (the query works now): renamed.
  const again = await installAgentTask(spec(), { exec: check.host.exec, fs: check.fs, start: false, keep: true })
  assert.equal(again.ok, true, again.message)
  assert.deepEqual([...check.host.tasks.keys()], [OWNER_TASK])
  // An explicit install (create_agent) with the same misread registers nothing either: never two AtLogOn tasks on one launcher.
  const explicit = world({ queryErrors: [{ action: 'probe-legacy', times: 1 }] })
  seedOldTask(explicit.host, explicit.fs, OWNER, false)
  const installed = await installAgentTask(spec(), { exec: explicit.host.exec, fs: explicit.fs, start: true })
  assert.equal(installed.ok, false)
  assert.deepEqual([...explicit.host.tasks.keys()], [OLD_TASK])
  assert.equal(explicit.host.calls.some((c) => c.endsWith('-Action install') || c.startsWith('schtasks.exe')), false)
  // A failed query of this HOME's OWN name is unknown too: refused, nothing written or started.
  const own = world({ queryErrors: [{ action: 'probe', times: 1 }] })
  const refused = await installAgentTask(spec(), { exec: own.host.exec, fs: own.fs, start: true })
  assert.equal(refused.ok, false)
  assert.match(refused.message, /^refused: which HOME the Scheduled Task ".*" belongs to could not be read/)
  assert.equal(own.host.tasks.size, 0)
})

test('round 2 M2: the generated probe asks with -ErrorAction Stop and calls only ObjectNotFound absent; anything else exits 2', () => {
  const ps1 = spec().files[1].content
  assert.match(ps1, /Get-ScheduledTask -TaskPath '\\' -TaskName \$taskName -ErrorAction Stop/)
  assert.match(ps1, /\$_\.CategoryInfo\.Category -eq 'ObjectNotFound'/)
  assert.match(ps1, /exit 2/)
  assert.doesNotMatch(ps1, /-TaskName \$taskName -ErrorAction SilentlyContinue/)
})

test('round 2 L1: a rollback whose unregister fails says what is really registered (both), never "unregistered again"', async () => {
  const { fs, host } = world({ fail: [{ match: 'retire-legacy-task', code: 1, stderr: 'Access is denied.' }, { match: '-Action uninstall', code: 1, stderr: 'Access is denied.' }] })
  seedOldTask(host, fs, OWNER, false)
  const result = await installAgentTask(spec(), { exec: host.exec, fs, start: false })
  assert.equal(result.ok, false)
  assert.match(result.message, new RegExp(`^the new task could not be unregistered again: both "${OLD_TASK}" and "${OWNER_TASK}" stay registered`))
  assert.deepEqual([...host.tasks.keys()].sort(), [OLD_TASK, OWNER_TASK].sort())
})

test('a failed retire when this HOME\'s new task was already there says so: nothing is unregistered and both stay', async () => {
  const { fs, host } = world({ fail: [{ match: 'retire-legacy-task', code: 1, stderr: 'Access is denied.' }] })
  host.seed.task(OWNER_TASK, vbsOf(OWNER), { description: `HOAI agent ${ID}, installed from home=${OWNER}` })
  host.seed.task(OLD_TASK, vbsOf(OWNER))
  const result = await installAgentTask(spec(), { exec: host.exec, fs, start: false, keep: true })
  assert.equal(result.ok, false)
  assert.match(result.message, new RegExp(`^the old "${OLD_TASK}" could not be retired; both it and "${OWNER_TASK}" stay registered: `))
  assert.deepEqual([...host.tasks.keys()].sort(), [OLD_TASK, OWNER_TASK].sort())
  assert.equal(host.calls.some((c) => c.endsWith('-Action uninstall')), false)
})

test('same-HOME migration rollback: when the old task cannot be retired the new one is unregistered again and the old one stays', async () => {
  const { fs, host } = world({ fail: [{ match: 'retire-legacy-task', code: 1, stderr: 'Access is denied.' }] })
  seedOldTask(host, fs, OWNER, false)
  const before = snapshotOf(host, OLD_TASK)
  const result = await installAgentTask(spec(), { exec: host.exec, fs, start: false })
  assert.equal(result.ok, false)
  assert.match(result.message, new RegExp(`^migration rolled back \\(the new task was unregistered again, the old "${OLD_TASK}" stays\\): `))
  assert.deepEqual([...host.tasks.keys()], [OLD_TASK])
  assert.equal(snapshotOf(host, OLD_TASK), before)
  assert.deepEqual(result.legacy, { label: OLD_TASK, state: 'own', home: OWNER })
})

test('a 0.69.2 task script still on disk is rewritten before anything runs: no stale script ever unregisters or registers the old name', async () => {
  const { fs, host } = world()
  seedOldTask(host, fs, OWNER, false)
  const stale = [
    '# HOAI Agent 912: logon task that keeps this agent running (generated by lib/agent-task-win32.mjs).',
    'param([Parameter(Mandatory = $true)][ValidateSet("install", "run", "uninstall", "status")][string]$Action)',
    "$name = 'HOAI Agent 912'",
    `$vbs = '${vbsOf(OWNER)}'`,
    '',
  ].join('\r\n')
  fs.writeFile(`${stateDir(OWNER)}\\install-agent-task.ps1`, stale)
  const removed = await uninstallAgentTask(spec(), { exec: host.exec, fs })
  assert.equal(removed.ok, true, removed.message)
  // The old task went because the probe proved it this HOME's (retire), not by a stale script's uninstall.
  assert.equal(host.tasks.size, 0)
  assert.ok(host.calls.some((c) => c.endsWith('-Action retire-legacy-task')))
  assert.ok(removed.notes.includes(`removed the Scheduled Task "${OLD_TASK}" (installed from this HOME by an older version)`), removed.notes.join('\n'))
})

// -- uninstall removes only its own -------------------------------------------------------------------

test('uninstall removes only its own: the scratch HOME\'s task goes, the owner\'s new and old tasks stay; the owner\'s own uninstall takes its old task too', async () => {
  const { fs, host } = world()
  await installAgentTask(spec(), { exec: host.exec, fs, start: false })
  await installAgentTask(spec(SCRATCH, SCRATCH_CWD), { exec: host.exec, fs, start: false })
  const owner = snapshotOf(host, OWNER_TASK)
  const removed = await uninstallAgentTask(spec(SCRATCH, SCRATCH_CWD), { exec: host.exec, fs })
  assert.equal(removed.ok, true, removed.message)
  assert.deepEqual([...host.tasks.keys()], [OWNER_TASK])
  assert.equal(snapshotOf(host, OWNER_TASK), owner)
  assert.equal(fs.exists(vbsOf(OWNER)), true)
  assert.equal(fs.exists(vbsOf(SCRATCH)), false, 'the scratch HOME\'s own files go')
  // The owner's uninstall, with a leftover old task of its own HOME: both go, and it says so.
  host.seed.task(OLD_TASK, vbsOf(OWNER))
  const mine = await uninstallAgentTask(spec(), { exec: host.exec, fs })
  assert.equal(mine.ok, true, mine.message)
  assert.equal(host.tasks.size, 0)
  assert.equal(mine.legacy!.state, 'removed')
  // An old task of ANOTHER HOME is left, and named.
  host.seed.task(OLD_TASK, vbsOf(SCRATCH))
  const again = await uninstallAgentTask(spec(), { exec: host.exec, fs })
  assert.equal(again.ok, true)
  assert.deepEqual([...host.tasks.keys()], [OLD_TASK])
  assert.ok(again.notes.some((n: string) => n.startsWith(`left the Scheduled Task "${OLD_TASK}" alone: it was installed from another HOME (${SCRATCH})`)), again.notes.join('\n'))
})

// -- the watcher supervises both names during the migration ------------------------------------------------

test('start: an agent not renamed yet is still supervised under its OLD name (proven this HOME\'s); a renamed one under the new name', async () => {
  const { fs, host } = world()
  seedOldTask(host, fs, OWNER, false)
  const reg = agentTaskRegistration({ assistantId: ID, home: OWNER })
  const old = await runAgentTask(reg, { exec: host.exec, fs })
  assert.equal(old.ok, true, old.message)
  assert.equal(old.name, OLD_TASK)
  assert.ok(host.calls.includes(`schtasks.exe /Run /TN ${OLD_TASK}`))
  host.endInstance(OLD_TASK)
  await installAgentTask(spec(), { exec: host.exec, fs, start: false })
  const renamed = await runAgentTask(reg, { exec: host.exec, fs })
  assert.equal(renamed.ok, true, renamed.message)
  assert.equal(renamed.name, OWNER_TASK)
  assert.ok(host.calls.includes(`schtasks.exe /Run /TN ${OWNER_TASK}`))
})

test('round 2 L12: a start of the OLD name that the sweep\'s rename retired in between (read back as this HOME\'s, gone at /Run) starts this HOME\'s renamed task instead', async () => {
  const { fs, host } = world()
  seedOldTask(host, fs, OWNER, false)
  const reg = agentTaskRegistration({ assistantId: ID, home: OWNER })
  let renamedAway = false
  const racing = async (file: string, args: readonly string[]) => {
    if (file === 'schtasks.exe' && args[2] === OLD_TASK && !renamedAway) {
      renamedAway = true
      // The sweep's rename runs right here: this HOME's new task registered, the old one retired.
      const renamed = await installAgentTask(spec(), { exec: host.exec, fs, start: false })
      assert.equal(renamed.ok, true, renamed.message)
    }
    return host.exec(file, args)
  }
  const started = await runAgentTask(reg, { exec: racing as any, fs })
  assert.equal(renamedAway, true)
  assert.equal(started.ok, true, started.message)
  assert.equal(started.name, OWNER_TASK)
  assert.equal(started.acted, true)
  assert.ok(host.calls.includes(`schtasks.exe /Run /TN ${OWNER_TASK}`), host.calls.join('\n'))
  assert.ok(host.instances.has(OWNER_TASK))
})

// -- the sweep: renames once, then supervises the renamed agent ---------------------------------------

const HOAI_CORE_KEEP_ALIVE = "export const RUN_KEEP_ALIVE_FLAGS = Object.freeze(['--keep-alive'])\n"
const T0 = Date.parse('2026-10-15T12:00:00.000Z')

function sweepMachine(fs: MemoryFs) {
  const files: Record<string, string> = {
    [`${ROOT}\\bin\\hoai-core.mjs`]: HOAI_CORE_KEEP_ALIVE,
    [`${OWNER}\\.bgos-agent\\credentials-${ID}.json`]: '{}',
    [`${stateDir(OWNER)}\\launch.json`]: JSON.stringify(buildLaunchRecipe({ assistantId: ID, cwd: CWD, argv: [], installMethod: 'marketplace', pluginRoot: ROOT, node: 'node', startedAt: 'x', pid: null })),
    [`${CWD}\\.bgos-agent-id`]: `${ID}\n`,
    [`${OWNER}\\.claude\\plugins\\installed_plugins.json`]: JSON.stringify({ plugins: { 'hoai@hoai': [{ scope: 'user', version: '0.69.3', installPath: ROOT, lastUpdated: '2026-10-15T11:00:00.000Z' }] } }),
    [`${stateDir(OWNER)}\\supervisor-generation`]: '2\n',
  }
  for (const [path, text] of Object.entries(files)) fs.writeFile(path, text)
  fs.mkdir(CWD)
}

function sweepCtx(fs: MemoryFs, host: FakeAgentTasks, logs: string[], now = { at: T0 }) {
  return {
    home: OWNER,
    env: { PATH: 'C:\\Windows' },
    platform: 'win32',
    fs,
    // The process listing (powershell -Command) answers an empty table; every task call goes to the fake.
    exec: async (file: string, args: readonly string[]) =>
      file === 'powershell.exe' && args.includes('-Command') ? { code: 0, stdout: '[]', stderr: '', error: null, timedOut: false } : host.exec(file, args),
    execSync: () => ({ code: 1, stdout: '' }),
    spawnDetached: () => ({ pid: 1 }),
    kill: () => true,
    now: () => now.at,
    sleep: async (ms: number) => {
      now.at += ms
    },
    log: (l: string) => logs.push(l),
    pidAlive: () => false,
    nodePath: NODE,
    uid: null,
    manifest: { version: '0.69.3', fingerprint: 'f', installedAt: 'x', pluginRoot: ROOT, files: [], claudeConfigDir: null },
    hasTmux: false,
    hasScript: false,
    hasCommand: () => false,
    verifyTimeoutMs: 30_000,
    fetchKeepAlive: async () => ({ ok: true, status: 200, json: { enabled: true, enabledAt: 'e', assistantIds: [Number(ID)] }, text: '', error: null }),
  }
}

test('the watcher renames this HOME\'s old task once (no start, no stop of a running agent), then supervises the renamed agent: a dead launcher is started under the NEW name', async () => {
  const { fs, host } = world()
  sweepMachine(fs)
  seedOldTask(host, fs, OWNER, true)
  // The agent runs (its launcher is live): the rename must not stop or start it.
  fs.writeFile(`${stateDir(OWNER)}\\supervisor.json`, JSON.stringify({ pid: 777, capabilities: ['relaunch'] }))
  const logs: string[] = []
  const clock = { at: T0 }
  const ctx = { ...sweepCtx(fs, host, logs, clock), pidAlive: (pid: number) => pid === 777 }
  await runKeepAliveSweep(ctx as any)
  assert.deepEqual([...host.tasks.keys()], [OWNER_TASK], logs.join('\n'))
  assert.equal(host.instances.has(OLD_TASK), true, 'the running launcher was left running')
  assert.equal(host.calls.some((c) => c.startsWith('schtasks.exe')), false)
  assert.ok(logs.some((l) => l.includes(`renamed the Scheduled Task "${OLD_TASK}"`)), logs.join('\n'))
  // Once renamed, the next sweep does not probe again.
  const probes = host.calls.length
  clock.at += 60_000
  await runKeepAliveSweep(ctx as any)
  assert.equal(host.calls.length, probes, 'a renamed task is not read back every sweep')
  // The launcher dies and the agent is down: the sweep starts it, under the new name.
  host.endInstance(OLD_TASK)
  fs.rm(`${stateDir(OWNER)}\\supervisor.json`)
  clock.at += 60_000
  const report = await runKeepAliveSweep({ ...ctx, pidAlive: () => false } as any)
  assert.ok(host.calls.includes(`schtasks.exe /Run /TN ${OWNER_TASK}`), host.calls.join('\n'))
  assert.equal(host.calls.some((c) => c === `schtasks.exe /Run /TN ${OLD_TASK}`), false)
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['supervised', 'task_started']])
})

test('the watcher\'s once-per-agent check only READS a task this HOME already has under its own name: never registered again under a running agent', async () => {
  const { fs, host } = world()
  sweepMachine(fs)
  fs.writeFile(vbsOf(OWNER), "' launcher\r\n")
  host.seed.task(OWNER_TASK, vbsOf(OWNER), { description: `HOAI agent ${ID}, installed from home=${OWNER}`, running: true })
  fs.writeFile(`${stateDir(OWNER)}\\supervisor.json`, JSON.stringify({ pid: 777, capabilities: ['relaunch'] }))
  const before = snapshotOf(host, OWNER_TASK)
  const logs: string[] = []
  await runKeepAliveSweep({ ...sweepCtx(fs, host, logs), pidAlive: (pid: number) => pid === 777 } as any)
  const acted = host.calls.filter((c) => !/-Action probe(-legacy)?$/.test(c))
  assert.deepEqual(acted, [], 'only the read-only probes ran')
  assert.ok(host.calls.some((c) => c.endsWith('-Action probe')), 'the task was read back')
  assert.equal(snapshotOf(host, OWNER_TASK), before)
  assert.equal(host.startsOf(stateDir(OWNER)), 1, 'its running launcher untouched')
})

test('the watcher\'s check is not done while the old task cannot be read back: logged, and tried again after the hour, never recorded as checked', async () => {
  const { fs, host } = world({ fail: [{ match: '-Action probe-legacy', code: 1, stderr: 'Get-ScheduledTask: CIM timeout', times: 1 }] })
  sweepMachine(fs)
  fs.writeFile(vbsOf(OWNER), "' launcher\r\n")
  host.seed.task(OWNER_TASK, vbsOf(OWNER), { description: `HOAI agent ${ID}, installed from home=${OWNER}`, running: true })
  fs.writeFile(`${stateDir(OWNER)}\\supervisor.json`, JSON.stringify({ pid: 777, capabilities: ['relaunch'] }))
  const logs: string[] = []
  const clock = { at: T0 }
  const ctx = { ...sweepCtx(fs, host, logs, clock), pidAlive: (pid: number) => pid === 777 }
  await runKeepAliveSweep(ctx as any)
  assert.ok(logs.some((l) => l.includes(`task "${OWNER_TASK}" NOT checked`) || l.includes('could not be read')), logs.join('\n'))
  const state = JSON.parse(fs.readFile(`${OWNER}\\.bgos-agent\\watcher\\keepalive-state.json`)!)
  assert.equal(state.agents[ID].taskName, undefined, 'not recorded as checked')
  // Within the hour: not read back again. After it: read back, and now recorded.
  const within = host.calls.length
  clock.at += 30 * 60_000
  await runKeepAliveSweep(ctx as any)
  assert.equal(host.calls.filter((c) => c.endsWith('-Action probe-legacy')).length, host.calls.slice(0, within).filter((c) => c.endsWith('-Action probe-legacy')).length)
  clock.at += 31 * 60_000
  await runKeepAliveSweep(ctx as any)
  const after = JSON.parse(fs.readFile(`${OWNER}\\.bgos-agent\\watcher\\keepalive-state.json`)!)
  assert.equal(after.agents[ID].taskName, OWNER_TASK)
})

test('round 2 H1 (the review\'s scenario): the owner\'s launcher is there and the old "HOAI Agent <id>" is a rig\'s: the sweep registers the owner\'s own task, records it only once verified, and starts THAT task when the launcher dies', async () => {
  const { fs, host } = world()
  sweepMachine(fs)
  fs.writeFile(vbsOf(OWNER), "' launcher\r\n")
  fs.writeFile(vbsOf(SCRATCH), "' the rig's 0.69.2 launcher\r\n")
  host.seed.task(OLD_TASK, vbsOf(SCRATCH))
  const foreign = snapshotOf(host, OLD_TASK)
  const logs: string[] = []
  const clock = { at: T0 }
  const ctx = sweepCtx(fs, host, logs, clock)
  const first = await runKeepAliveSweep(ctx as any)
  assert.ok(host.tasks.has(OWNER_TASK), logs.join('\n'))
  assert.equal(snapshotOf(host, OLD_TASK), foreign, 'the rig\'s task, byte for byte')
  assert.ok(logs.some((l) => l.includes(`left the Scheduled Task "${OLD_TASK}" alone: it was installed from another HOME (${SCRATCH})`)), logs.join('\n'))
  assert.ok(host.calls.includes(`schtasks.exe /Run /TN ${OWNER_TASK}`), 'the dead launcher started under this HOME\'s own task')
  assert.equal(host.calls.some((c) => c === `schtasks.exe /Run /TN ${OLD_TASK}`), false)
  assert.deepEqual(first.agents.map((a: any) => [a.state, a.reason]), [['supervised', 'task_started']])
  const state = JSON.parse(fs.readFile(`${OWNER}\\.bgos-agent\\watcher\\keepalive-state.json`)!)
  assert.equal(state.agents[ID].taskName, OWNER_TASK)
})

test('round 2 L2: a task start refused before any act (the read-back says no task of this HOME) spends no start of the episode', async () => {
  const { fs, host } = world()
  sweepMachine(fs)
  fs.writeFile(vbsOf(OWNER), "' launcher\r\n")
  // This HOME's own name is held by a registration of ANOTHER HOME: every start is refused before /Run.
  host.seed.task(OWNER_TASK, vbsOf(SCRATCH), { description: `HOAI agent ${ID}, installed from home=${SCRATCH}` })
  const logs: string[] = []
  const clock = { at: T0 }
  const ctx = sweepCtx(fs, host, logs, clock)
  const report = await runKeepAliveSweep(ctx as any)
  assert.equal(host.calls.some((c) => c.startsWith('schtasks.exe')), false)
  const state = JSON.parse(fs.readFile(`${OWNER}\\.bgos-agent\\watcher\\keepalive-state.json`)!)
  assert.equal(state.agents[ID].taskStarts ?? 0, 0, 'a refusal is not a start')
  assert.equal(report.agents[0].state, 'failed')
  assert.match(report.agents[0].reason, /refused: the Scheduled Task "HOAI Agent 912 home-66ede649" records another HOME/)
})

test('the watcher in a scratch HOME leaves the owner\'s old task alone (logged), registers its own, and never starts the owner\'s', async () => {
  const { fs, host } = world()
  seedOldTask(host, fs, OWNER, false)
  // The scratch HOME: its own credentials and recipe for the same agent, no task of its own yet.
  const sroot = 'E:\\rig\\scratch-home\\.claude\\plugins\\cache\\hoai\\hoai\\0.69.3'
  for (const [path, text] of Object.entries({
    [`${sroot}\\bin\\hoai-core.mjs`]: HOAI_CORE_KEEP_ALIVE,
    [`${SCRATCH}\\.bgos-agent\\credentials-${ID}.json`]: '{}',
    [`${stateDir(SCRATCH)}\\launch.json`]: JSON.stringify(buildLaunchRecipe({ assistantId: ID, cwd: SCRATCH_CWD, argv: [], installMethod: 'marketplace', pluginRoot: sroot, node: 'node', startedAt: 'x', pid: null })),
    [`${SCRATCH_CWD}\\.bgos-agent-id`]: `${ID}\n`,
    [`${SCRATCH}\\.claude\\plugins\\installed_plugins.json`]: JSON.stringify({ plugins: { 'hoai@hoai': [{ scope: 'user', version: '0.69.3', installPath: sroot, lastUpdated: '2026-10-15T11:00:00.000Z' }] } }),
  })) fs.writeFile(path, text)
  fs.mkdir(SCRATCH_CWD)
  const before = snapshotOf(host, OLD_TASK)
  const logs: string[] = []
  const ctx = { ...sweepCtx(fs, host, logs), home: SCRATCH, manifest: { version: '0.69.3', fingerprint: 'f', installedAt: 'x', pluginRoot: sroot, files: [], claudeConfigDir: null } }
  await runKeepAliveSweep(ctx as any)
  assert.equal(snapshotOf(host, OLD_TASK), before)
  assert.ok(host.tasks.has(SCRATCH_TASK), logs.join('\n'))
  assert.ok(logs.some((l) => l.includes(`left the Scheduled Task "${OLD_TASK}" alone: it was installed from another HOME (${OWNER})`)), logs.join('\n'))
  assert.equal(host.calls.some((c) => c === `schtasks.exe /Run /TN ${OLD_TASK}`), false)
  assert.equal(host.instances.has(OLD_TASK), false, 'the owner agent was not started from the scratch HOME')
})

test('inventory: a Windows agent task row names the NEW task, keeps the old name for the read-back, and carries its HOME', () => {
  const fs = memoryFs({
    [`${OWNER}\\.bgos-agent\\credentials-${ID}.json`]: '{}',
    [vbsOf(OWNER)]: "' launcher\r\n",
  })
  const [row] = listAgents({ home: OWNER, platform: 'win32', fs: { exists: fs.exists, readFile: fs.readFile, listDir: fs.listDir }, execSync: () => ({ code: 1, stdout: '' }), pidAlive: () => false })
  assert.equal(row!.home, OWNER)
  assert.deepEqual(row!.service, { kind: 'schtasks', handle: OWNER_TASK, legacyHandle: OLD_TASK, via: 'canonical-file', file: vbsOf(OWNER) })
})
