/**
 * Can this claude run thread lanes and By the way? (Threads phase 1, gate
 * review finding 2.)
 *
 * A thread lane runs `--restricted --tools <list> --permission-mode
 * acceptEdits|dontAsk --settings <json>` resumed with `--fork-session` over
 * stream json (lib/thread-lane-args.ts threadLaneArgs), and an aside runs
 * `--tools "" --permission-mode dontAsk --max-turns 1` with partial messages
 * (asideArgs). `--restricted` exists from CLI 2.1.301 (measured,
 * docs/thread-lanes-spike.md); an older CLI refused the lane's command and the
 * person read only the generic "turn failed". So message_threads,
 * thread_sessions and asides are declared only where this probe says yes, and
 * a turn or a side question that still reaches a CLI that says no fails with
 * the real cause.
 *
 * The probe asks the binary for its version (2.1.301 or later), its help
 * (every flag defined, at the start of a help line), its permission modes
 * (handed an unknown one, the CLI lists them) and the hidden `--max-turns`
 * (given bare, a known flag answers "argument missing"). Each spawn returns at
 * once without starting a session. The answer is cached per binary (its real
 * path, size and modification time), never when no version could be read
 * (a timeout is not an answer).
 *
 * Erasable TypeScript only. No em or en dashes in this file.
 */

import * as nodeFs from 'node:fs'
import { execFile, spawnSync } from 'node:child_process'
import { dirname } from 'node:path'

export const THREADS_MIN_CLI = '2.1.301'
const MIN: readonly number[] = THREADS_MIN_CLI.split('.').map(Number)

/** Flags `claude --help` must define for a lane and an aside. */
export const THREADS_HELP_FLAGS: readonly string[] = Object.freeze([
  '--restricted',
  '--tools',
  '--fork-session',
  '--resume',
  '--settings',
  '--permission-mode',
  '--strict-mcp-config',
  '--mcp-config',
  '--input-format',
  '--output-format',
  '--include-partial-messages',
  '--verbose',
])

/** Flags the help hides that an aside needs. */
export const THREADS_HIDDEN_VALUE_FLAGS: readonly string[] = Object.freeze(['--max-turns'])

/** A working lane runs acceptEdits; a read only lane and an aside run dontAsk. */
export const THREADS_PERMISSION_MODES: readonly string[] = Object.freeze(['acceptEdits', 'dontAsk'])

const MODE_PROBE_VALUE = 'hoai-lane-probe'
export const THREADS_PROBE_TIMEOUT_MS = 10_000
/** Bump when the probe's questions change, so an old cached answer is asked again. */
export const THREADS_PROBE_VERSION = 1

const UNREADABLE = 'a readable version'
const TOO_OLD = `version ${THREADS_MIN_CLI} or later`

export interface ProbeOutput {
  status?: number | null
  stdout?: string
  stderr?: string
}

export interface ThreadsCliAnswer {
  ok: boolean
  missing: string[]
  version: string | null
  cached?: boolean
  /** platform or no_claude: threads are off for a reason this probe did not ask. */
  reason?: string
}

function text(out: ProbeOutput | undefined): string {
  return `${out?.stdout ?? ''}\n${out?.stderr ?? ''}`
}

/** [major, minor, patch] from what `claude --version` prints, or null. */
export function parseCliVersion(output: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function atLeastMin(v: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i]! !== MIN[i]!) return v[i]! > MIN[i]!
  }
  return true
}

/** Read the probe's outputs into one answer; anything unread is a no. */
export function classifyThreadsCliProbe(outs: {
  version: ProbeOutput
  help: ProbeOutput
  mode: ProbeOutput
  hidden: Record<string, ProbeOutput>
}): { ok: boolean; missing: string[]; version: string | null } {
  const v = parseCliVersion(outs.version?.stdout ?? '')
  if (!v) return { ok: false, missing: [UNREADABLE], version: null }
  const missing: string[] = []
  if (!atLeastMin(v)) missing.push(TOO_OLD)
  const help = text(outs.help)
  for (const flag of THREADS_HELP_FLAGS) {
    // Only where an option is DEFINED (the start of a help line, after an
    // optional short alias), never inside another option's description.
    const re = new RegExp(`^\\s+(?:-[A-Za-z], )?${flag.replace(/-/g, '\\-')}(?=[\\s,<=[]|$)`, 'm')
    if (!re.test(help)) missing.push(flag)
  }
  const choices = (/Allowed choices are ([^\n]+)/i.exec(text(outs.mode))?.[1] ?? '').split(/[\s,.]+/)
  for (const mode of THREADS_PERMISSION_MODES) if (!choices.includes(mode)) missing.push(`--permission-mode ${mode}`)
  for (const flag of THREADS_HIDDEN_VALUE_FLAGS) {
    const said = text(outs.hidden?.[flag]).toLowerCase()
    const known = /argument missing|missing required argument|requires an argument|expected an argument/.test(said) && !/unknown option/.test(said)
    if (!known) missing.push(flag)
  }
  return { ok: missing.length === 0, missing, version: v.join('.') }
}

type Run = (command: string, args: string[], opts: Record<string, unknown>) => ProbeOutput

/** Ask one binary every question. */
export function probeThreadsCli(
  claudePath: string,
  deps: { run?: Run; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): { ok: boolean; missing: string[]; version: string | null } {
  const run: Run = deps.run ?? (spawnSync as unknown as Run)
  const ask = (args: string[]): ProbeOutput => {
    try {
      return run(claudePath, args, {
        encoding: 'utf8',
        timeout: deps.timeoutMs ?? THREADS_PROBE_TIMEOUT_MS,
        env: deps.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      return { status: null, stdout: '', stderr: String((err as Error)?.message ?? err) }
    }
  }
  const version = ask(['--version'])
  const help = ask(['--help'])
  const mode = ask(['--permission-mode', MODE_PROBE_VALUE])
  const hidden: Record<string, ProbeOutput> = {}
  for (const flag of THREADS_HIDDEN_VALUE_FLAGS) hidden[flag] = ask([flag])
  return classifyThreadsCliProbe({ version, help, mode, hidden })
}

/** Threads can run with this binary, asked once per binary. */
export function threadsCliSupport(input: {
  claudePath: string | null
  cachePath: string
  platform?: NodeJS.Platform
  fs?: Pick<typeof nodeFs, 'realpathSync' | 'statSync' | 'readFileSync' | 'mkdirSync' | 'writeFileSync' | 'renameSync'>
  probe?: (claudePath: string) => { ok: boolean; missing: string[]; version: string | null }
  now?: () => number
}): ThreadsCliAnswer {
  const fs = input.fs ?? nodeFs
  const platform = input.platform ?? process.platform
  if (platform === 'win32') return { ok: false, missing: [], version: null, cached: false, reason: 'platform' }
  if (!input.claudePath) return { ok: false, missing: [], version: null, cached: false, reason: 'no_claude' }
  let key: string
  try {
    const real = fs.realpathSync(input.claudePath)
    const st = fs.statSync(real)
    key = `${THREADS_PROBE_VERSION}:${real}:${st.size}:${Math.trunc(st.mtimeMs)}`
  } catch {
    return { ok: false, missing: [], version: null, cached: false, reason: 'no_claude' }
  }
  try {
    const cached = JSON.parse(String(fs.readFileSync(input.cachePath, 'utf8')))
    if (cached?.key === key && typeof cached.ok === 'boolean') {
      return {
        ok: cached.ok,
        missing: Array.isArray(cached.missing) ? cached.missing.map(String) : [],
        version: typeof cached.version === 'string' ? cached.version : null,
        cached: true,
      }
    }
  } catch {
    // No cache yet.
  }
  const answer = (input.probe ?? ((p: string) => probeThreadsCli(p)))(input.claudePath)
  if (answer.version !== null) {
    try {
      fs.mkdirSync(dirname(input.cachePath), { recursive: true })
      const tmp = `${input.cachePath}.${process.pid}.tmp`
      const at = new Date((input.now ?? Date.now)()).toISOString()
      fs.writeFileSync(tmp, `${JSON.stringify({ key, ok: answer.ok, missing: answer.missing, version: answer.version, at })}\n`)
      fs.renameSync(tmp, input.cachePath)
    } catch {
      // A cache that cannot be written only costs a probe next time.
    }
  }
  return { ok: answer.ok, missing: answer.missing, version: answer.version, cached: false }
}

/**
 * The plain sentence a person reads when this claude cannot run a thread
 * turn or a side question, or null when it can (or when the reason is one
 * checked elsewhere: no binary at all, the platform).
 */
export function threadsCliProblem(answer: ThreadsCliAnswer, what: 'turn' | 'aside'): string | null {
  if (answer.ok || answer.reason) return null
  const turn = what === 'turn'
  const why = answer.version === null
    ? 'its version could not be read'
    : answer.missing.includes(TOO_OLD)
      ? `it is version ${answer.version} and ${turn ? 'threads need' : 'they need'} ${THREADS_MIN_CLI} or later`
      : `version ${answer.version} lacks ${answer.missing.join(', ')}`
  return turn
    ? `This turn failed because Claude Code on this computer cannot run threads: ${why}. Update Claude Code, then send your reply again.`
    : `Claude Code on this computer cannot answer side questions: ${why}. Update Claude Code, then ask again.`
}

// -- Follow up (item 2): never on the event loop, and a failed probe is kept --

/** How long a probe that read no version (it hung or failed) is kept before claude is asked again. */
export const THREADS_FAILED_RETRY_MS = 10 * 60_000

type AsyncRun = (command: string, args: string[], timeoutMs: number) => Promise<ProbeOutput>

const execAsync: AsyncRun = (command, args, timeoutMs) =>
  new Promise((done) => {
    try {
      execFile(
        command,
        args,
        { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: process.env },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0
          done({ status: code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        },
      )
    } catch (err) {
      done({ status: null, stdout: '', stderr: String((err as Error)?.message ?? err) })
    }
  })

/**
 * The probe, asynchronous: the four questions at once, each cut at the
 * timeout (a hung claude costs one timeout, off the event loop, never 4 x 10 s
 * of a blocked daemon).
 */
export async function probeThreadsCliAsync(
  claudePath: string,
  deps: { run?: AsyncRun; timeoutMs?: number } = {},
): Promise<{ ok: boolean; missing: string[]; version: string | null }> {
  const run = deps.run ?? execAsync
  const t = deps.timeoutMs ?? THREADS_PROBE_TIMEOUT_MS
  const [version, help, mode, ...hiddenOuts] = await Promise.all([
    run(claudePath, ['--version'], t),
    run(claudePath, ['--help'], t),
    run(claudePath, ['--permission-mode', MODE_PROBE_VALUE], t),
    ...THREADS_HIDDEN_VALUE_FLAGS.map((flag) => run(claudePath, [flag], t)),
  ])
  const hidden: Record<string, ProbeOutput> = {}
  THREADS_HIDDEN_VALUE_FLAGS.forEach((flag, i) => { hidden[flag] = hiddenOuts[i]! })
  return classifyThreadsCliProbe({ version: version!, help: help!, mode: mode!, hidden })
}

type GateFs = Pick<typeof nodeFs, 'realpathSync' | 'statSync' | 'readFileSync' | 'mkdirSync' | 'writeFileSync' | 'renameSync'>

/**
 * The daemon's one view of "can this claude run threads" (follow up to
 * finding 2). current() answers at once and never waits: a cached answer for
 * this binary, or `probing` while the one shared probe runs in the background
 * (threads stay undeclared until it answers; capabilities go out on every
 * heartbeat). ready() waits for that answer, asynchronously, for a turn or a
 * side question. An answer with a version is kept per binary (on disk too);
 * one that read nothing (claude hung or failed) is kept for
 * THREADS_FAILED_RETRY_MS, so no later turn waits on it again, also after a
 * restart.
 */
export class ThreadsCliGate {
  private readonly deps: {
    claudePath(): string | null
    cachePath: string
    platform?: NodeJS.Platform
    fs?: GateFs
    probe?: (claudePath: string) => Promise<{ ok: boolean; missing: string[]; version: string | null }>
    now?: () => number
    onAnswer?(answer: ThreadsCliAnswer): void
  }

  private memo: { key: string; answer: ThreadsCliAnswer; retryAt: number | null } | null = null
  private inflight: { key: string; promise: Promise<ThreadsCliAnswer> } | null = null

  constructor(deps: ThreadsCliGate['deps']) {
    this.deps = deps
  }

  current(): ThreadsCliAnswer {
    const at = this.where()
    if ('answer' in at) return at.answer
    const known = this.known(at.key)
    if (known) return known
    void this.start(at.key, at.path)
    return { ok: false, missing: [], version: null, reason: 'probing' }
  }

  async ready(): Promise<ThreadsCliAnswer> {
    const at = this.where()
    if ('answer' in at) return at.answer
    return this.known(at.key) ?? this.start(at.key, at.path)
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** The binary's cache key, or the answer when there is no binary to ask. */
  private where(): { key: string; path: string } | { answer: ThreadsCliAnswer } {
    if ((this.deps.platform ?? process.platform) === 'win32') return { answer: { ok: false, missing: [], version: null, reason: 'platform' } }
    const path = this.deps.claudePath()
    if (!path) return { answer: { ok: false, missing: [], version: null, reason: 'no_claude' } }
    try {
      const fs = this.deps.fs ?? nodeFs
      const real = fs.realpathSync(path)
      const st = fs.statSync(real)
      return { key: `${THREADS_PROBE_VERSION}:${real}:${st.size}:${Math.trunc(st.mtimeMs)}`, path }
    } catch {
      return { answer: { ok: false, missing: [], version: null, reason: 'no_claude' } }
    }
  }

  private fresh(retryAt: number | null): boolean {
    return retryAt === null || this.now() < retryAt
  }

  private known(key: string): ThreadsCliAnswer | null {
    if (this.memo?.key === key && this.fresh(this.memo.retryAt)) return this.memo.answer
    try {
      const cached = JSON.parse(String((this.deps.fs ?? nodeFs).readFileSync(this.deps.cachePath, 'utf8')))
      if (cached?.key !== key || typeof cached.ok !== 'boolean') return null
      const version = typeof cached.version === 'string' ? cached.version : null
      const retryAt = version === null ? (typeof cached.retryAt === 'number' ? cached.retryAt : 0) : null
      if (!this.fresh(retryAt)) return null
      const answer: ThreadsCliAnswer = {
        ok: cached.ok,
        missing: Array.isArray(cached.missing) ? cached.missing.map(String) : [],
        version,
        cached: true,
      }
      this.memo = { key, answer, retryAt }
      return answer
    } catch {
      return null
    }
  }

  private start(key: string, path: string): Promise<ThreadsCliAnswer> {
    if (this.inflight?.key === key) return this.inflight.promise
    const probe = this.deps.probe ?? ((p: string) => probeThreadsCliAsync(p))
    const promise = probe(path)
      .catch(() => ({ ok: false, missing: [UNREADABLE], version: null }))
      .then((found) => {
        const answer: ThreadsCliAnswer = { ok: found.ok, missing: found.missing, version: found.version, cached: false }
        const retryAt = found.version === null ? this.now() + THREADS_FAILED_RETRY_MS : null
        this.memo = { key, answer, retryAt }
        this.save(key, answer, retryAt)
        if (this.inflight?.key === key) this.inflight = null
        this.deps.onAnswer?.(answer)
        return answer
      })
    this.inflight = { key, promise }
    return promise
  }

  private save(key: string, answer: ThreadsCliAnswer, retryAt: number | null): void {
    const fs = this.deps.fs ?? nodeFs
    try {
      fs.mkdirSync(dirname(this.deps.cachePath), { recursive: true })
      const tmp = `${this.deps.cachePath}.${process.pid}.tmp`
      const at = new Date(this.now()).toISOString()
      fs.writeFileSync(tmp, `${JSON.stringify({ key, ok: answer.ok, missing: answer.missing, version: answer.version, retryAt, at })}\n`)
      fs.renameSync(tmp, this.deps.cachePath)
    } catch {
      // A cache that cannot be written only costs a probe after a restart.
    }
  }
}
