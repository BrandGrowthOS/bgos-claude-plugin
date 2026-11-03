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
import { spawnSync } from 'node:child_process'
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
