/**
 * A faked OS service layer for the watcher service tests: the one user's
 * Task Scheduler and HKCU Run key (win32), the gui/<uid> launchd domain
 * (darwin) and the systemd --user manager (linux), driven ONLY by the
 * commands lib/watcher-service.mjs emits through its injected exec. No real
 * task, job, unit, registry value or process is ever touched.
 *
 * It models the primitives, never the decisions: the win32 task script's
 * actions are read from the generated install-task.ps1 in the memory fs at
 * the moment the command runs (its $name, $legacyName, $vbs, ... variables),
 * so a stale script on disk is executed as the stale script it is. Every
 * command appends a snapshot to `timeline`: which registrations exist and
 * which watcher processes run, per bundle directory, so a test can prove
 * "never without a registration" and "never two watchers at once".
 *
 * Two real hazards are modelled on request: `callerInUnit` (linux) makes the
 * process running the commands live inside that unit's cgroup, so stopping the
 * unit KILLS it (the exec throws CallerKilled after the manager finished the
 * job it was given); `bootoutLingers` (darwin) keeps a booted out job listed
 * and running for that many further launchctl calls, as a real bootout returns
 * before the job has unloaded. systemd's own parsing of `Environment=` (split
 * at whitespace outside double quotes) is modelled for `show`.
 */

import type { MemoryFs } from './memory-fs.ts'

export type ExecResult = { code: number | null; stdout: string; stderr: string; error: string | null; timedOut: boolean }

type Task = { description: string; action: string; state: string }
type LaunchdJob = { plistPath: string; content: string }

export type Snapshot = {
  cmd: string
  /** bundle dir (lower case) -> names of the registrations that would start a watcher from it */
  registrations: Record<string, string[]>
  /** bundle dir (lower case) -> number of watcher processes running from it */
  running: Record<string, number>
}

export type FakeHostOptions = {
  platform: 'win32' | 'darwin' | 'linux'
  fs: MemoryFs
  uid?: number
  /** linux: the HOME of the systemd --user manager (the only unit dir it reads). */
  managerHome?: string
  /** Commands that fail, matched as a substring of `<file> <args joined by space>`. */
  fail?: Array<{ match: string; code?: number; stderr?: string; times?: number }>
  /** linux: the installer runs inside this unit's cgroup; stopping the unit kills it. */
  callerInUnit?: string
  /** darwin: a booted out job stays listed and running for this many further launchctl calls. */
  bootoutLingers?: number
}

/** The process running the commands was killed (it lived in the cgroup of a unit that was stopped). */
export class CallerKilled extends Error {
  constructor(unit: string) {
    super(`the caller was killed with ${unit}`)
  }
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '', error: null, timedOut: false })
const bad = (code: number, stderr: string): ExecResult => ({ code, stdout: '', stderr, error: null, timedOut: false })

/** Evaluate a PowerShell string expression of 'literal' and [char]0xNNNN parts joined by +. */
export function evalPs(expr: string): string {
  const body = expr.startsWith('(') && expr.endsWith(')') ? expr.slice(1, -1) : expr
  let out = ''
  for (const part of body.split(' + ')) {
    const chr = /^\[char\]0x([0-9A-F]{4})$/.exec(part)
    if (chr) out += String.fromCharCode(parseInt(chr[1]!, 16))
    else if (/^'(?:[^']|'')*'$/.test(part)) out += part.slice(1, -1).replace(/''/g, "'")
    else throw new Error(`not a ps string part: ${part}`)
  }
  return out
}

function psVar(script: string, name: string): string | null {
  const line = script.split(/\r?\n/).find((l) => l.startsWith(`$${name} = `))
  if (!line) return null
  return evalPs(line.slice(`$${name} = `.length).trim())
}

function b64(text: string): string {
  return text ? Buffer.from(text, 'utf8').toString('base64') : '-'
}

function dirOf(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, '')
}

function key(dir: string): string {
  return dir.replace(/[\\/]+$/, '').toLowerCase()
}

/** The bundle dir a win32 action or Run value starts a watcher from (its run-hidden.vbs's dir). */
function bundleOfAction(action: string): string | null {
  const m = /"([^"]*run-hidden\.vbs)"/i.exec(action)
  return m ? dirOf(m[1]!) : null
}

function plistValue(content: string, keyName: string): string | null {
  const m = new RegExp(`<key>${keyName}</key><string>([^<]*)</string>`).exec(content)
  return m ? m[1]!.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : null
}

function plistArgs(content: string): string[] {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(content)
  if (!block) return []
  return [...block[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!.replace(/&amp;/g, '&'))
}

function unitValue(content: string, keyName: string): string | null {
  const line = content.split('\n').find((l) => l.startsWith(`${keyName}=`))
  return line ? line.slice(keyName.length + 1) : null
}

/** systemd's reading of the Environment= lines of a unit: words split at whitespace, "..." keeps one. */
function unitAssignments(content: string): string[] {
  const out: string[] = []
  for (const line of content.split('\n')) {
    if (!line.startsWith('Environment=')) continue
    const value = line.slice('Environment='.length)
    let word = ''
    let quoted = false
    let any = false
    for (let i = 0; i < value.length; i++) {
      const ch = value[i]!
      if (quoted && ch === '\\' && i + 1 < value.length) {
        word += value[++i]
        continue
      }
      if (ch === '"') {
        quoted = !quoted
        any = true
        continue
      }
      if (!quoted && /\s/.test(ch)) {
        if (word || any) out.push(word)
        word = ''
        any = false
        continue
      }
      word += ch
    }
    if (word || any) out.push(word)
  }
  // An assignment needs KEY=; systemd ignores a word without one.
  return out.filter((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
}

export function fakeServiceHost(options: FakeHostOptions) {
  const { platform, fs } = options
  const uid = options.uid ?? 501
  const managerHome = options.managerHome ?? '/home/kc'
  const failures = (options.fail ?? []).map((f) => ({ ...f, left: f.times ?? Infinity }))
  /** darwin: booted out jobs still unloading, with the launchctl calls they have left. */
  const lingering = new Map<string, { job: LaunchdJob; left: number }>()

  const calls: string[] = []
  const timeline: Snapshot[] = []
  // win32
  const tasks = new Map<string, Task>()
  const runValues = new Map<string, string>()
  /** bundle dir key -> running watcher count (win32 processes are not tied to the task once started) */
  const winProcs = new Map<string, number>()
  // darwin
  const launchd = new Map<string, LaunchdJob>()
  // linux
  const enabled = new Set<string>()
  const active = new Set<string>()
  /** bundle dir key -> how many times a watcher process was (re)started from it: a restart is a disruption too */
  const starts = new Map<string, number>()
  const started = (dir: string | null) => {
    if (dir) starts.set(key(dir), (starts.get(key(dir)) ?? 0) + 1)
  }
  const unitDir = (unit: string) => {
    const content = fs.readFile(unitPath(unit))
    return content ? unitValue(content, 'WorkingDirectory') : null
  }

  const unitPath = (unit: string) => `${managerHome}/.config/systemd/user/${unit}.service`

  function registrations(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    const add = (dir: string | null, name: string) => {
      if (!dir) return
      ;(out[key(dir)] ??= []).push(name)
    }
    for (const [name, task] of tasks) add(bundleOfAction(task.action), `task:${name}`)
    for (const [name, value] of runValues) add(bundleOfAction(value), `run:${name}`)
    for (const [label, job] of launchd) add(plistValue(job.content, 'WorkingDirectory'), `launchd:${label}`)
    for (const unit of enabled) {
      const content = fs.readFile(unitPath(unit))
      add(content ? unitValue(content, 'WorkingDirectory') : null, `systemd:${unit}`)
    }
    return out
  }

  function running(): Record<string, number> {
    const out: Record<string, number> = {}
    const add = (dir: string | null, n = 1) => {
      if (!dir || n <= 0) return
      out[key(dir)] = (out[key(dir)] ?? 0) + n
    }
    for (const [dir, n] of winProcs) add(dir, n)
    for (const [, job] of launchd) add(plistValue(job.content, 'WorkingDirectory'))
    for (const [, { job }] of lingering) add(plistValue(job.content, 'WorkingDirectory'))
    for (const unit of active) {
      const content = fs.readFile(unitPath(unit))
      add(content ? unitValue(content, 'WorkingDirectory') : null)
    }
    return out
  }

  function startWin(bundleDir: string | null) {
    if (!bundleDir) return
    winProcs.set(key(bundleDir), (winProcs.get(key(bundleDir)) ?? 0) + 1)
    started(bundleDir)
  }

  function win32Exec(args: string[]): ExecResult {
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
    const watcherScript = psVar(script, 'watcherScript')!
    const runValue = psVar(script, 'runValue')!
    const legacyRunValue = psVar(script, 'legacyRunValue')
    const description = psVar(script, 'description') ?? ''
    const launcher = `wscript.exe //B "${vbs}"`
    const probe = (taskName: string | null, valueName: string | null) => {
      const lines: string[] = []
      const task = taskName ? tasks.get(taskName) : undefined
      lines.push(task ? `task present ${task.state} ${b64(task.description)} ${b64(task.action)}` : 'task absent')
      const run = valueName ? runValues.get(valueName) : undefined
      lines.push(run ? `run present ${b64(run)}` : 'run absent')
      return ok(`${lines.join('\r\n')}\r\n`)
    }
    switch (action) {
      case 'install':
        if (failures.some((f) => f.match === 'Register-ScheduledTask' && f.left-- > 0)) {
          runValues.set(runValue, launcher)
          return ok('task registration refused: Access is denied.; falling back to the Run key\r\nrun key registered\r\n')
        }
        tasks.set(name, { description, action: `wscript.exe //B "${vbs}"`, state: 'Ready' })
        return ok('task registered\r\n')
      case 'start':
        startWin(tasks.has(name) ? bundleOfAction(tasks.get(name)!.action) : dirOf(vbs))
        return ok(tasks.has(name) ? 'task started\r\n' : 'started via wscript\r\n')
      case 'stop':
        winProcs.delete(key(dirOf(dirOf(watcherScript))))
        return ok('stopped\r\n')
      case 'uninstall':
        tasks.delete(name)
        runValues.delete(runValue)
        return ok('unregistered\r\n')
      case 'status':
        if (tasks.has(name)) return ok(`task ${tasks.get(name)!.state}\r\n`)
        if (runValues.has(runValue)) return ok('run key registered\r\n')
        return { ...ok('not registered\r\n'), code: 1 }
      case 'probe':
        return probe(name, runValue)
      case 'probe-legacy':
        return probe(legacyName, legacyRunValue)
      case 'retire-legacy-task':
        if (legacyName) tasks.delete(legacyName)
        return ok('legacy task unregistered\r\n')
      case 'retire-legacy-run':
        if (legacyRunValue) runValues.delete(legacyRunValue)
        return ok('legacy run key removed\r\n')
      default:
        return bad(1, `fake host: action ${action} is not modelled`)
    }
  }

  function launchdExec(args: string[]): ExecResult {
    const [verb] = args
    const targetLabel = (target: string) => target.replace(new RegExp(`^gui/${uid}/`), '')
    // Every launchctl call is one more moment for an unloading job to finish.
    for (const [label, entry] of lingering) {
      entry.left -= 1
      if (entry.left < 0) lingering.delete(label)
    }
    const listed = (label: string) => launchd.get(label) ?? lingering.get(label)?.job
    if (verb === 'bootout') {
      const label = targetLabel(args[1]!)
      if (!launchd.has(label)) return bad(113, `Boot-out failed: 113: Could not find service "${label}" in domain for user gui: ${uid}`)
      const job = launchd.get(label)!
      launchd.delete(label)
      if (options.bootoutLingers) lingering.set(label, { job, left: options.bootoutLingers })
      return ok()
    }
    if (verb === 'bootstrap') {
      const plistPath = args[2]!
      const content = fs.readFile(plistPath)
      if (content == null) return bad(5, 'Bootstrap failed: 5: Input/output error')
      const label = plistValue(content, 'Label')!
      if (launchd.has(label) || lingering.has(label)) return bad(5, 'Bootstrap failed: 5: Input/output error')
      launchd.set(label, { plistPath, content })
      started(plistValue(content, 'WorkingDirectory'))
      return ok()
    }
    if (verb === 'kickstart') {
      const label = targetLabel(args[2]!)
      const job = launchd.get(label)
      if (!job) return bad(113, `Could not find service "${label}" in domain for user gui: ${uid}`)
      started(plistValue(job.content, 'WorkingDirectory'))
      return ok()
    }
    if (verb === 'print') {
      const label = targetLabel(args[1]!)
      const job = listed(label)
      if (!job) return bad(113, `Bad request.\nCould not find service "${label}" in domain for user gui: ${uid}`)
      const programArgs = plistArgs(job.content)
      const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(job.content)?.[1] ?? ''
      const env = [...envBlock.matchAll(/<key>([^<]+)<\/key><string>([^<]*)<\/string>/g)].map((m) => `\t\t${m[1]} => ${m[2]!.replace(/&amp;/g, '&')}`)
      return ok(
        [
          `gui/${uid}/${label} = {`,
          '\tactive count = 1',
          `\tpath = ${job.plistPath}`,
          '\ttype = LaunchAgent',
          '\tstate = running',
          '',
          `\tprogram = ${programArgs[0] ?? ''}`,
          '\targuments = {',
          ...programArgs.map((a) => `\t\t${a}`),
          '\t}',
          '',
          `\tworking directory = ${plistValue(job.content, 'WorkingDirectory') ?? ''}`,
          '',
          '\tinherited environment = {',
          '\t\tSSH_AUTH_SOCK => /private/tmp/com.apple.launchd.x/Listeners',
          '\t}',
          '',
          '\tdefault environment = {',
          '\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin',
          '\t}',
          '',
          '\tenvironment = {',
          ...env,
          `\t\tXPC_SERVICE_NAME => ${label}`,
          '\t}',
          '',
          `\tdomain = gui/${uid} [100005]`,
          '}',
          '',
        ].join('\n'),
      )
    }
    return bad(1, `fake host: launchctl ${verb} is not modelled`)
  }

  /** linux: set when a stop took the cgroup the caller lives in; the exec throws once its job is done. */
  let killedWith: string | null = null
  const stopUnit = (name: string) => {
    if (active.delete(name) && options.callerInUnit === name) killedWith = name
  }
  /** The units a unit's drop-ins (<unit>.service.d/*.conf) make it conflict with. */
  const conflictsOf = (name: string) => {
    const dir = `${managerHome}/.config/systemd/user/${name}.service.d`
    const out: string[] = []
    for (const entry of fs.listDir(dir)) {
      if (!entry.endsWith('.conf')) continue
      for (const line of (fs.readFile(`${dir}/${entry}`) ?? '').split('\n')) {
        const m = /^Conflicts=(.+)\.service$/.exec(line.trim())
        if (m) out.push(m[1]!)
      }
    }
    return out
  }

  function systemdExec(args: string[]): ExecResult {
    if (args[0] !== '--user') return bad(1, 'fake host: only --user is modelled')
    const verb = args[1]
    const unit = args[args.length - 1]!
    const file = () => fs.readFile(unitPath(unit))
    switch (verb) {
      case 'daemon-reload':
        return ok()
      case 'enable': {
        if (file() == null) return bad(1, `Failed to enable unit: Unit file ${unit}.service does not exist.`)
        enabled.add(unit)
        if (args.includes('--now') && !active.has(unit)) {
          active.add(unit)
          started(unitDir(unit))
        }
        return ok()
      }
      case 'disable': {
        if (file() == null && !enabled.has(unit)) return bad(1, `Failed to disable unit: Unit file ${unit}.service does not exist.`)
        enabled.delete(unit)
        if (args.includes('--now')) stopUnit(unit)
        return ok()
      }
      case 'restart':
      case 'start':
        if (file() == null) return bad(5, `Failed to ${verb} ${unit}.service: Unit ${unit}.service not found.`)
        // One job: a conflicting unit is stopped first (After=), then this one starts.
        for (const other of conflictsOf(unit)) stopUnit(other)
        if (verb === 'restart') stopUnit(unit)
        if (verb === 'restart' || !active.has(unit)) started(unitDir(unit))
        active.add(unit)
        return ok()
      case 'stop':
        if (file() == null && !active.has(unit)) return bad(5, `Failed to stop ${unit}.service: Unit ${unit}.service not loaded.`)
        stopUnit(unit)
        return ok()
      case 'is-active':
        return active.has(unit) ? ok('active\n') : { ...ok('inactive\n'), code: 3 }
      case 'show': {
        const content = file()
        if (content == null && !enabled.has(unit)) {
          return ok(['LoadState=not-found', 'ActiveState=inactive', 'FragmentPath=', 'WorkingDirectory=', 'Environment='].join('\n') + '\n')
        }
        const envs = unitAssignments(content ?? '').map((v) => (/\s/.test(v) ? `"${v}"` : v))
        return ok(
          [
            `Environment=${envs.join(' ')}`,
            `WorkingDirectory=${content ? unitValue(content, 'WorkingDirectory') ?? '' : ''}`,
            `FragmentPath=${unitPath(unit)}`,
            'LoadState=loaded',
            `ActiveState=${active.has(unit) ? 'active' : 'inactive'}`,
          ].join('\n') + '\n',
        )
      }
      default:
        return bad(1, `fake host: systemctl ${verb} is not modelled`)
    }
  }

  async function exec(file: string, args: readonly string[]): Promise<ExecResult> {
    const line = `${file} ${args.join(' ')}`
    calls.push(line)
    let result: ExecResult
    const failure = failures.find((f) => f.match !== 'Register-ScheduledTask' && line.includes(f.match) && f.left > 0)
    if (failure) {
      failure.left -= 1
      result = bad(failure.code ?? 1, failure.stderr ?? `fake host: ${failure.match} failed`)
    } else if (platform === 'win32' && file === 'powershell.exe') result = win32Exec([...args])
    else if (platform === 'darwin' && file === 'launchctl') result = launchdExec([...args])
    else if (platform === 'linux' && file === 'systemctl') result = systemdExec([...args])
    else if (platform === 'linux' && file === 'loginctl') result = ok()
    else result = bad(127, `fake host: ${file} is not modelled on ${platform}`)
    timeline.push({ cmd: line, registrations: registrations(), running: running() })
    if (killedWith) {
      const unit = killedWith
      killedWith = null
      throw new CallerKilled(unit)
    }
    return result
  }

  return {
    exec,
    calls,
    timeline,
    tasks,
    runValues,
    launchd,
    enabled,
    active,
    registrations,
    running,
    /** bundle dir (any case) -> how many times a watcher was (re)started from it */
    startsOf: (dir: string) => starts.get(key(dir)) ?? 0,
    /** Seed a registration as an older install (or another HOME) left it, and its watcher running. */
    seed: {
      task(name: string, vbs: string, description = '') {
        tasks.set(name, { description, action: `wscript.exe //B "${vbs}"`, state: 'Ready' })
        startWin(dirOf(vbs))
      },
      runValue(name: string, vbs: string) {
        runValues.set(name, `wscript.exe //B "${vbs}"`)
      },
      launchd(plistPath: string, content: string) {
        fs.writeFile(plistPath, content)
        launchd.set(plistValue(content, 'Label')!, { plistPath, content })
      },
      unit(unit: string, content: string) {
        fs.writeFile(unitPath(unit), content)
        enabled.add(unit)
        active.add(unit)
      },
    },
  }
}

export type FakeServiceHost = ReturnType<typeof fakeServiceHost>
