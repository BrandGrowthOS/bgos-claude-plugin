/**
 * A faked Windows Task Scheduler for the PER-AGENT logon tasks ("HOAI Agent <id>",
 * lib/agent-task-win32.mjs), driven ONLY by the commands the code emits through its
 * injected exec: `powershell.exe ... -File <install-agent-task.ps1> -Action <a>` and
 * `schtasks.exe /Run /TN <name>`. No real task is ever created, changed, run or read.
 *
 * Like test/helpers/fake-service-host.ts it models the primitives, never the decisions:
 * the task script's actions are read from the generated install-agent-task.ps1 in the
 * memory fs at the moment the command runs (its $name, $legacyName, $vbs and $description
 * variables, and its ValidateSet), so a stale script on disk runs as the stale script it is.
 *
 * A started task is an INSTANCE: the launcher of that task, running the task's action
 * (wscript //B <vbs>). MultipleInstances IgnoreNew is per task: a second start of the same
 * task while its instance runs is a no-op, a start of ANOTHER task running the same vbs is a
 * second launcher. Unregistering a task leaves its running instance alone (the Task
 * Scheduler does not end a running instance when the task is deleted; see the PR notes).
 * Every command appends a snapshot to `timeline`: the registrations and the launchers
 * running, per agent state dir, so a test can prove "never without a registration" and
 * "never two launchers of one agent".
 */

import type { MemoryFs } from './memory-fs.ts'
import { evalPs } from './fake-service-host.ts'

export type ExecResult = { code: number | null; stdout: string; stderr: string; error: string | null; timedOut: boolean }
type Task = { description: string; action: string; state: string }

export type AgentTaskSnapshot = {
  cmd: string
  /** agent state dir (lower case) -> the task names whose action runs that dir's run-agent.vbs */
  registrations: Record<string, string[]>
  /** agent state dir (lower case) -> launchers running from it */
  running: Record<string, number>
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '', error: null, timedOut: false })
const bad = (code: number, stderr: string, stdout = ''): ExecResult => ({ code, stdout, stderr, error: null, timedOut: false })

function psVar(script: string, name: string): string | null {
  const line = script.split(/\r?\n/).find((l) => l.startsWith(`$${name} = `))
  if (!line) return null
  return evalPs(line.slice(`$${name} = `.length).trim())
}

function b64(text: string): string {
  return text ? Buffer.from(text, 'utf8').toString('base64') : '-'
}

const dirOf = (path: string) => path.replace(/[\\/][^\\/]*$/, '')
const key = (dir: string) => dir.replace(/[\\/]+$/, '').toLowerCase()
/** The state dir a task action runs the launcher of (`wscript.exe //B "<dir>\run-agent.vbs"`). */
const stateDirOfAction = (action: string) => {
  const m = /"([^"]*run-agent\.vbs)"/i.exec(action)
  return m ? dirOf(m[1]!) : null
}

export type FakeAgentTaskOptions = {
  fs: MemoryFs
  /** Commands that fail, matched as a substring of `<file> <args joined by space>`. */
  fail?: Array<{ match: string; code?: number; stderr?: string; times?: number }>
}

export function fakeAgentTasks(options: FakeAgentTaskOptions) {
  const { fs } = options
  const failures = (options.fail ?? []).map((f) => ({ ...f, left: f.times ?? Infinity }))
  const tasks = new Map<string, Task>()
  /** task name -> its running instance (a launcher), at most one (IgnoreNew) */
  const instances = new Map<string, { stateDir: string }>()
  const calls: string[] = []
  const timeline: AgentTaskSnapshot[] = []
  /** state dir key -> how many launchers were ever started from it */
  const starts = new Map<string, number>()

  function registrations(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [name, task] of tasks) {
      const dir = stateDirOfAction(task.action)
      if (dir) (out[key(dir)] ??= []).push(name)
    }
    return out
  }

  function running(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [, inst] of instances) out[key(inst.stateDir)] = (out[key(inst.stateDir)] ?? 0) + 1
    return out
  }

  /** Start a task's instance; IgnoreNew: a no-op while that task's own instance runs. */
  function startTask(name: string): ExecResult {
    const task = tasks.get(name)
    if (!task) return bad(1, 'ERROR: The system cannot find the file specified.')
    if (task.state === 'Disabled') return bad(1, 'ERROR: The task is disabled.')
    if (instances.has(name)) return ok(`SUCCESS: Attempted to run the scheduled task "${name}".\r\n`)
    const dir = stateDirOfAction(task.action)
    if (dir) {
      instances.set(name, { stateDir: dir })
      starts.set(key(dir), (starts.get(key(dir)) ?? 0) + 1)
    }
    task.state = 'Running'
    return ok(`SUCCESS: Attempted to run the scheduled task "${name}".\r\n`)
  }

  function powershell(args: string[]): ExecResult {
    const file = args[args.indexOf('-File') + 1]!
    const action = args[args.indexOf('-Action') + 1]!
    const script = fs.readFile(file)
    if (script == null) return bad(1, `The argument '${file}' to the -File parameter does not exist.`)
    const validate = /ValidateSet\(([^)]*)\)/.exec(script)
    const allowed = validate ? [...validate[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!) : []
    if (!allowed.includes(action)) return bad(1, `Cannot validate argument on parameter 'Action'. The argument "${action}" does not belong to the set`)
    const name = psVar(script, 'name')!
    const legacyName = psVar(script, 'legacyName')
    const vbs = psVar(script, 'vbs')!
    const description = psVar(script, 'description') ?? ''
    const probe = (taskName: string | null) => {
      const task = taskName ? tasks.get(taskName) : undefined
      return ok(`${task ? `task present ${task.state} ${b64(task.description)} ${b64(task.action)}` : 'task absent'}\r\n`)
    }
    switch (action) {
      case 'install':
        // Register-ScheduledTask -Force: a same-named task is REPLACED (its running instance is not ended).
        tasks.set(name, { description, action: `wscript.exe //B "${vbs}"`, state: instances.has(name) ? 'Running' : 'Ready' })
        return ok('task registered\r\n')
      case 'install-disabled':
        // The same registration with New-ScheduledTaskSettingsSet -Disable: it never starts.
        tasks.set(name, { description, action: `wscript.exe //B "${vbs}"`, state: 'Disabled' })
        return ok('task registered (disabled)\r\n')
      case 'run':
        return startTask(name).code === 0 ? ok('task started\r\n') : bad(1, '', 'task start refused: The system cannot find the file specified.\r\n')
      case 'uninstall':
        tasks.delete(name)
        return ok('unregistered\r\n')
      case 'status':
        if (tasks.has(name)) return ok(`task ${tasks.get(name)!.state}\r\n`)
        return { ...ok('not registered\r\n'), code: 1 }
      case 'probe':
        return probe(name)
      case 'probe-legacy':
        return probe(legacyName)
      case 'retire-legacy-task':
        if (!legacyName || !tasks.has(legacyName)) return bad(1, '', 'legacy task not unregistered: The system cannot find the file specified.\r\n')
        tasks.delete(legacyName)
        return ok('legacy task unregistered\r\n')
      default:
        return bad(1, `fake agent tasks: action ${action} is not modelled`)
    }
  }

  async function exec(file: string, args: readonly string[]): Promise<ExecResult> {
    const line = `${file} ${args.join(' ')}`
    calls.push(line)
    let result: ExecResult
    const failure = failures.find((f) => line.includes(f.match) && f.left > 0)
    if (failure) {
      failure.left -= 1
      result = bad(failure.code ?? 1, failure.stderr ?? `fake agent tasks: ${failure.match} failed`)
    } else if (file === 'powershell.exe') result = powershell([...args])
    else if (file === 'schtasks.exe' && args[0] === '/Run' && args[1] === '/TN') result = startTask(String(args[2]))
    else result = bad(127, `fake agent tasks: ${file} is not modelled`)
    timeline.push({ cmd: line, registrations: registrations(), running: running() })
    return result
  }

  return {
    exec,
    calls,
    timeline,
    tasks,
    instances,
    registrations,
    running,
    startsOf: (dir: string) => starts.get(key(dir)) ?? 0,
    /** The launcher of a task exits (a crash, or claude ended for good): its instance is gone. */
    endInstance(name: string) {
      instances.delete(name)
      const task = tasks.get(name)
      if (task) task.state = 'Ready'
    },
    seed: {
      /** A task as 0.69.2 registered it (no description), optionally with its launcher running. */
      task(name: string, vbs: string, { description = '', running = false, disabled = false }: { description?: string; running?: boolean; disabled?: boolean } = {}) {
        tasks.set(name, { description, action: `wscript.exe //B "${vbs}"`, state: disabled ? 'Disabled' : running ? 'Running' : 'Ready' })
        if (running) {
          instances.set(name, { stateDir: dirOf(vbs) })
          starts.set(key(dirOf(vbs)), (starts.get(key(dirOf(vbs))) ?? 0) + 1)
        }
      },
    },
  }
}

export type FakeAgentTasks = ReturnType<typeof fakeAgentTasks>
