#!/usr/bin/env node
/**
 * hoai-core: the one command for a HOAI Claude Code agent folder.
 *
 * The troubleshooting story of one-click onboarding is "open the folder, run
 * hoai". Every decision lives HERE; bin/hoai (bash), bin/hoai.ps1 and
 * bin/hoai.cmd are thin dispatchers that only find a JS runtime and hand over.
 *
 *   hoai              launch the agent from this folder with the CORRECT
 *                     channel flag. The flag is resolved, never guessed: this
 *                     folder's .mcp.json decides when it declares a HOAI
 *                     server, else install-method detection does. Both
 *                     directions of getting it wrong are silent: on 2026-08-21
 *                     a marketplace install launched with the clone spec
 *                     dropped every inbound message, and the mirror image
 *                     (detection overruling a workspace that publishes its own
 *                     server) did the same to .mcp.json agents. The launch
 *                     is SUPERVISED: while claude runs, hoai watches the
 *                     agent's state dir for a restart-requested.json marker
 *                     (written by the daemon's one-click update handler) and
 *                     relaunches claude resuming THIS agent's own pinned session
 *                     (never --continue, which would resume a neighbour's
 *                     session in a shared cwd) when it appears, so interactive
 *                     sessions, Windows included, finally have a restart
 *                     authority.
 *   hoai -c           the same thing, spelled the way people type it.
 *   hoai --continue     -c, --continue and --resume are SYNONYMS of a bare
 *   hoai --resume       hoai; none of them forwards --continue to claude.
 *   hoai --new        start a genuinely NEW session for THIS agent in this
 *                     folder (the escape hatch when a conversation is stuck
 *                     or too long). Still identity safe: a new pinned id for
 *                     this agent, with the same detected channel flag.
 *   hoai --force      launch NOW: skip the wait for another claude that looks
 *                     like it owns this folder. The escape hatch for the
 *                     incumbent check itself, combinable with --new.
 *   hoai install-cli  put the `hoai` command itself on this machine's PATH
 *                     (what `hoai setup` does for you on a first run)
 *   hoai doctor       diagnose this host (hands off to bin/bgos-doctor.mjs)
 *   hoai pair <CODE>  pair this folder (hands off to bin/bgos-pair.mjs); a
 *                     bare BGOS-/OC- code routes here too
 *   hoai setup <CODE> first-run onboarding in ONE command: add the HOAI
 *                     marketplace, install the plugin, then pair. This exists
 *                     so the app has a line it can hand to ANY shell. It used
 *                     to hand out `claude plugin marketplace add ... && claude
 *                     plugin install ... && npx ... hoai-pair <CODE>`, and
 *                     `&&` is a parse error in Windows PowerShell 5.1, so the
 *                     whole paste died before the first step on the shell most
 *                     Windows owners have open. Sequencing the three steps
 *                     HERE means the pasted line carries no shell syntax at
 *                     all, and the code and assistant id reach bgos-pair as
 *                     argv entries rather than being re-parsed by whichever
 *                     shell pasted them.
 *   hoai logs         show the last lines of this agent's daemon log
 *   hoai help         usage
 *
 * Identity comes from the launch folder: pairing bakes a .bgos-agent-id pin
 * (see bin/bgos-pair.mjs bakeLaunchPin), server.ts self-resolves from it, so a
 * bare `hoai` in the agent's folder needs no env vars at all.
 *
 * Self-contained plain JavaScript: node >= 18 builtins only, no imports from
 * the TS plugin sources. Import-safe: every helper is exported and main() only
 * runs when the file is executed directly, so tests can import the pure pieces.
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  channelFlagArgsForSpec,
  claudeConfigDir,
  detectInstallMethod,
} from './bgos-install-method.mjs'
import {
  BEACON_HEARTBEAT_FILE_NAME,
  buildLaunchRecipe,
  isSupervisorWriter,
  parseSupervisorRecord,
  pluginStateDirFor,
  readBootClock,
  readLauncherProcesses,
  runsHoaiLauncher,
  writeLaunchRecipe,
} from '../lib/agent-inventory.mjs'
import { readChildProcesses, startLauncherWatchdog } from '../lib/launcher-liveness.mjs'
export { decideWatchdogAction, startLauncherWatchdog } from '../lib/launcher-liveness.mjs'
import {
  HOAI_MARKETPLACE as HOAI_MARKETPLACE_NAME,
  observeMarketplaceInstall,
} from '../lib/plugin-cli.mjs'
import {
  ensureHookEntries,
  ensureMarketplaceAutoUpdate,
  preseedClaudeTrust,
} from '../lib/claude-preseed.mjs'
import { declaredCheckout } from '../lib/clone-hooks.mjs'
import {
  MCP_CONFIG_FILE_NAME,
  parseMcpChannelServerName,
  readFolderIdentity,
} from '../lib/service-supervision.mjs'
import { WIN_PATH_HELPER_FILE, installWrapper } from '../lib/hoai-wrapper-install.mjs'
import { IDENTITY_FLAG, identityFilePath, identityLaunchArgs } from '../lib/agent-identity.mjs'
import { PROBE_TIMEOUT_MS, classifyFlagProbe } from '../lib/claude-binary.mjs'

/** Mirror of bgos-pair.mjs FOLDER_PIN_FILE_NAME / agent-credentials.ts
 *  FOLDER_PIN_FILE: the launch-folder pin whose number IS the assistant id. */
export const FOLDER_PIN_FILE = '.bgos-agent-id'

/** The unsubstituted plugin userConfig placeholder is not a real assistant id
 *  (mirror of the constant in bgos-pair.mjs / agent-credentials.ts). */
const ASSISTANT_ID_PLACEHOLDER = '${user_config.assistant_id}'

/** POSIX convention for "command not found". */
export const EXIT_NOT_FOUND = 127

/** A bare `hoai` that refuses to start because a live supervisor already owns
 *  this agent (the singleton guard). Distinct so a wrapper can tell "declined,
 *  already running" from a claude failure. */
export const EXIT_ALREADY_SUPERVISED = 3

/** A launch or relaunch that refuses because no channel spec could be resolved
 *  (the install method is undetermined and this folder publishes no .mcp.json).
 *  Distinct so a wrapper can tell "would have been deaf" from a claude crash. */
export const EXIT_CHANNEL_UNRESOLVED = 4

/** A launch that gave up waiting for an incumbent claude: INCUMBENT_WAIT_TIMEOUT_MS
 *  passed and a process still looked like it owned this folder. Distinct so a
 *  wrapper (and a KeepAlive) can tell "waited, then declined" from a claude
 *  crash, from the already-supervised refusal (3) and from an unresolved
 *  channel (4). It is the exit code the wait never had: before 2026-09-21 the
 *  wait had no end, so there was nothing to report. */
export const EXIT_INCUMBENT_TIMEOUT = 5

/** An UNATTENDED launch (HOAI_SUPERVISED=1 under bin/bgos-agent's run.sh, or
 *  --keep-alive under the Windows logon task) that only a person can unblock:
 *  no identity at all (pair this folder first), two agents and nothing saying
 *  which (choose one), or a folder that names two different agents. A launch
 *  in front of a person prints the same reason and waits for them; with nobody
 *  there, the honest outcome is to stop with a code a supervisor can count and
 *  a reason in launch-status, never a session that looks healthy while it
 *  waits for an answer nobody will give. */
export const EXIT_UNATTENDED_NEEDS_PERSON = 6

/** A supervised launch whose folder declares one agent while the service that
 *  started it was installed for another. Launching would bring up the folder's
 *  agent (a second session of it, somewhere else) under a supervisor that
 *  believes it is running a different one. */
export const EXIT_SUPERVISED_IDENTITY_MISMATCH = 7

/** A supervised posix launch with no `expect`: claude would sit on its first
 *  startup screen (the dev-channels warning shows on every launch) with
 *  nobody to answer it, looking alive and hearing nothing. */
export const EXIT_SUPERVISED_NO_EXPECT = 8

/** The supervised expect tail's three named failures (the gate block's
 *  outcomes, lib/gate-block.tcl): a startup screen hoai will not answer for
 *  anyone, claude exiting before its session was up, and a claude that came up
 *  signed out. Generation 1 spelled them 3, 4 and 5 in run.expect; those
 *  numbers already mean other things for hoai (above), so they moved here. */
export const EXIT_SUPERVISED_GATE = 9
export const EXIT_SUPERVISED_STARTUP_EXIT = 10
export const EXIT_SUPERVISED_SIGNED_OUT = 11

/** Exits that are not a rejected resume, so the one-shot fresh fallback must
 *  not spend itself on them: a fresh session meets the same screen, the same
 *  signed-out account. */
const SUPERVISED_NO_FRESH_RETRY = new Set([EXIT_SUPERVISED_GATE, EXIT_SUPERVISED_SIGNED_OUT])

/** HOAI_SUPERVISED=1: set by bin/bgos-agent's run.sh (supervisor generation 2)
 *  for a launch NOBODY is sitting in front of. Every path that would wait for a
 *  person exits with a named code and writes launch-status instead.
 *  HOAI_SUPERVISED_ASSISTANT_ID is the agent the service was installed for. */
export const SUPERVISED_ENV = 'HOAI_SUPERVISED'
export const SUPERVISED_ASSISTANT_ID_ENV = 'HOAI_SUPERVISED_ASSISTANT_ID'

/** @param {Record<string, string | undefined> | undefined} env */
export function isSupervisedLaunch(env) {
  return String(env?.[SUPERVISED_ENV] ?? '') === '1'
}

/**
 * The environment claude (and expect, which starts it) is spawned with: hoai's
 * own, without SUPERVISED_ENV and SUPERVISED_ASSISTANT_ID_ENV. hoai is their
 * only reader, and inherited they made every `hoai` an agent's Bash tool ran
 * act as THIS agent's service: in another agent's folder it stopped with
 * identity-mismatch (7), in a pinless one with already-supervised (3), and
 * both overwrote this agent's launch-status. hoai's own env keeps them (a
 * relaunch resolves the service identity from them). Names are case
 * insensitive on win32, as Windows treats them. Never mutates `env`.
 * @param {Record<string, string | undefined> | undefined} env
 * @param {string} [platform]
 * @returns {Record<string, string>}
 */
export function childEnvWithoutSupervision(env, platform = process.platform) {
  const drop = new Set([SUPERVISED_ENV, SUPERVISED_ASSISTANT_ID_ENV])
  const out = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined) continue
    if (drop.has(platform === 'win32' ? key.toUpperCase() : key)) continue
    out[key] = value
  }
  return out
}

/** The service's assistant id (digits only), or ''. @param {Record<string, string | undefined> | undefined} env */
export function supervisedServiceId(env) {
  const value = String(env?.[SUPERVISED_ASSISTANT_ID_ENV] ?? '').trim()
  return /^\d+$/.test(value) ? value : ''
}

/** The remote compact state a supervised launch reports in launch-status: ON
 *  exactly when the session sits in tmux under the name the daemon will type
 *  /compact into (BGOS_TMUX_SESSION, lib/compact-inject.ts), else OFF with the
 *  reason run.sh had for running without tmux. */
export function compactStatus(env) {
  return String(env?.BGOS_TMUX_SESSION ?? '').trim() ? 'compact=on' : 'compact=off reason=no-tmux'
}

/** The message printed instead of relaunching on an unresolved channel. */
export function unresolvedChannelMessage(resolution) {
  const reason = String(resolution?.reason ?? '').trim() || 'no evidence of an install was found'
  return (
    `[hoai] STOPPING rather than relaunching: no channel could be resolved for this folder. ` +
    `${reason} Nothing was launched, because an agent on a guessed channel starts, reports ` +
    'Connected, and never receives a message.'
  )
}

// -- Small pure helpers -------------------------------------------------------

/** Is this pid alive on THIS host? Mirror of lib/update-readiness.ts
 *  defaultPidAlive: signal 0 probes without touching the process, EPERM means
 *  it exists under another user (still alive). Kept in plain JS because hoai
 *  runs under bare node and must not import the TS sources. */
export function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/** How long reading one pid's command line may take. PowerShell's cold start
 *  is the slow one; ps answers at once. */
export const PID_COMMAND_LINE_TIMEOUT_MS = 10_000

/**
 * The command line and start time of `pid` on THIS host ({command,
 * startedAtMs}, either one null when it cannot be read), or null when nothing
 * can be read at all (the pid is gone, the query failed or timed out, `pid` is
 * not a pid). The query is lib/agent-inventory.mjs readLauncherProcesses, the
 * one the watcher's launcherLive uses, so hoai and the watcher judge a
 * supervisor.json pid the same way.
 * On Linux the reading also carries its start on the boot clock (read through
 * `opts.readFile`), which decideSupervisorArming compares with the file's
 * own boot stamp (review 3 F1).
 * @param {number} pid
 * @param {string} [platform]
 * @param {{ spawn?: typeof spawnSync, now?: number, readFile?: (path: string) => string | null }} [opts]
 * @returns {{ command: string | null, startedAtMs: number | null,
 *   boot?: { id: string, startedUptimeMs: number } } | null}
 */
export function defaultPidProcess(pid, platform = process.platform, opts = {}) {
  const run = opts.spawn ?? spawnSync
  const execSync = (file, args) => {
    const res = run(file, args, {
      encoding: 'utf8',
      timeout: PID_COMMAND_LINE_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    // A timed-out spawnSync reports status null: unreadable.
    return { code: typeof res?.status === 'number' ? res.status : 1, stdout: String(res?.stdout ?? '') }
  }
  const bootClock = () => readBootClock({ platform, readFile: opts.readFile ?? defaultReadText })
  return readLauncherProcesses({ platform, pids: [pid], execSync, now: opts.now ?? Date.now(), bootClock }).get(pid) ?? null
}

/** Best-effort text read; null when absent or unreadable. */
function defaultReadText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Best-effort directory listing; [] when missing or unreadable. */
function defaultListDir(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/** Join dir + name preserving the dir's separator style, so a win32 path stays
 *  win32 and a posix path stays posix (detection is tolerant of both). */
export function joinDir(dir, name) {
  const base = String(dir ?? '').replace(/[\\/]+$/, '')
  if (!base) return String(name ?? '')
  const sep = base.includes('\\') || /^[A-Za-z]:$/.test(base) ? '\\' : '/'
  return `${base}${sep}${name}`
}

/** <home>/.bgos-agent in the home path's separator style. */
export function agentDir(home) {
  return joinDir(home, '.bgos-agent')
}

/** The numeric id in a <cwd>/.bgos-agent-id pin, or '' when absent or junk
 *  (mirror of readFolderPinId in lib/agent-credentials.ts). */
export function readFolderPin(cwd, readFile = defaultReadText) {
  const dir = String(cwd ?? '').trim()
  if (!dir) return ''
  const raw = readFile(joinDir(dir, FOLDER_PIN_FILE))
  if (raw == null) return ''
  const id = String(raw).trim()
  return /^\d+$/.test(id) ? id : ''
}

/** The trimmed BGOS_ASSISTANT_ID, with the unsubstituted placeholder ignored. */
export function configuredAssistantId(env) {
  const value = String(env?.BGOS_ASSISTANT_ID ?? '').trim()
  return value && value !== ASSISTANT_ID_PLACEHOLDER ? value : ''
}

/**
 * The line hoai adds when it launches the host's sole agent from a folder its
 * daemon will refuse: the agent's credentials file records a home elsewhere,
 * and the folder declares no pin, so the daemon's home check (lib/agent-
 * credentials.ts decideHomeBinding) refuses it and the agent does not answer
 * (board fc75c7c3). '' when there is no home, it is this folder, or the file
 * cannot be read. Reads homeDir and homeSource only; never the token. The
 * comparison mirrors normalizeHomeDir (a .mjs never imports a .ts here).
 */
export function soleAgentHomeNote({ home, assistantId, cwd, readFile = defaultReadText, platform = process.platform }) {
  const id = String(assistantId ?? '').trim()
  if (!id) return ''
  let creds = null
  try {
    creds = JSON.parse(String(readFile(joinDir(agentDir(home), `credentials-${id}.json`)) ?? ''))
  } catch {
    return ''
  }
  const homeDir = typeof creds?.homeDir === 'string' ? creds.homeDir.trim() : ''
  if (!homeDir) return ''
  const norm = (dir) => {
    const raw = String(dir ?? '').trim()
    const out = raw.replace(/[\\/]+$/, '') || raw.slice(0, 1)
    return platform === 'win32' || platform === 'darwin' ? out.toLowerCase() : out
  }
  if (norm(homeDir) === norm(cwd)) return ''
  const source =
    creds.homeSource === 'pairing'
      ? 'set by pairing'
      : creds.homeSource === 'pin'
        ? 'confirmed by a start from its pinned folder'
        : 'unconfirmed, recorded by plugin 0.64.3 or earlier'
  return (
    `[hoai] WARNING: this folder is not agent ${id}'s home (${homeDir}, ${source}), and it ` +
    `has no ${FOLDER_PIN_FILE}, so the agent's daemon will refuse to connect here and the agent ` +
    `will not answer. Run hoai from ${homeDir}, or pin this folder: echo ${id} > ${FOLDER_PIN_FILE}`
  )
}

/** The assistant ids that have a credentials-<id>.json in the agent dir,
 *  ascending (mirror of listPerAssistantIds in lib/agent-credentials.ts). */
export function listPairedAssistantIds(home, listDir = defaultListDir) {
  return listDir(agentDir(home))
    .map((name) => /^credentials-(\d+)\.json$/.exec(name)?.[1])
    .filter((found) => Boolean(found))
    .sort((a, b) => Number(a) - Number(b))
}

// -- Action routing -----------------------------------------------------------

/**
 * The flags that mean "bring this agent back as itself", all SYNONYMS of a
 * bare `hoai`. They exist because people type them: before this, `hoai -c`
 * printed the help and left the user with nothing to run.
 *
 * They are spelled after the claude flags on purpose, and they do NOT forward
 * those flags to claude. `claude --continue` resumes whatever conversation is
 * NEWEST in the folder, which on a shared fleet folder brought several agents
 * up as the same assistant, fought over one pairing and drained the account
 * (2026-08-23). The run path instead resumes THIS agent's own pinned session
 * id (see sessionArgsFor), which is what the user meant by "continue" anyway.
 */
export const RUN_RESUME_FLAGS = Object.freeze(['-c', '--continue', '--resume'])

/**
 * The flags that mean "start a genuinely NEW session for this agent". The
 * escape hatch for a conversation that is stuck or has grown too long: without
 * it, a user whose `hoai` always resumes has to fall back to the long raw
 * claude command line, which is the exact thing this command exists to avoid.
 * Still identity safe: a new session for THIS agent in THIS folder, launched
 * with the install-method-correct channel flag.
 */
export const RUN_FRESH_FLAGS = Object.freeze(['--new'])

/**
 * The flags that mean "launch now, do not wait for any other claude in this
 * folder". The escape hatch for the incumbent wait itself (2026-09-21): the
 * wait can only ever see what `ps` and `lsof` will tell it, and an owner who
 * knows the other process is not a conflict must be able to say so rather than
 * sit at a terminal reading the same notice every thirty seconds.
 */
export const RUN_FORCE_FLAGS = Object.freeze(['--force'])

/**
 * The flag that makes hoai itself the keep-alive loop (design section 4): the
 * Windows per agent logon task runs `hoai-core.mjs --keep-alive`, because
 * Windows has no launchd or systemd to bring claude back. With it, an exit of
 * claude on its own is followed by a relaunch of the SAME pinned session after
 * a backoff, instead of hoai returning (see decideKeepAliveBackoff).
 */
export const RUN_KEEP_ALIVE_FLAGS = Object.freeze(['--keep-alive'])

/**
 * Classify one token as a run flag: 'resume' (a synonym of bare `hoai`),
 * 'new' (force a fresh session), 'force' (skip the incumbent wait),
 * 'keep-alive' (relaunch claude after every exit of its own), or null (not a
 * run flag).
 * @param {unknown} token
 * @returns {'resume' | 'new' | 'force' | 'keep-alive' | null}
 */
export function classifyRunFlag(token) {
  const value = String(token ?? '')
    .trim()
    .toLowerCase()
  if (!value) return null
  if (RUN_RESUME_FLAGS.includes(value)) return 'resume'
  if (RUN_FRESH_FLAGS.includes(value)) return 'new'
  if (RUN_FORCE_FLAGS.includes(value)) return 'force'
  if (RUN_KEEP_ALIVE_FLAGS.includes(value)) return 'keep-alive'
  return null
}

/**
 * Peel the leading run flags off a token list. They COMBINE, because they are
 * about different things: --new picks the session, --force answers the
 * incumbent check, and `hoai --new --force` is a sensible thing to type after
 * a crash left both a stuck conversation and a process hoai cannot inspect.
 * Consuming a run of them (rather than exactly one) is also what keeps
 * `hoai --force --new` off the unknown-flag path, which prints the help.
 * @param {readonly string[]} tokens
 * @returns {{ rest: string[], fresh: boolean, force: boolean, keepAlive: boolean }}
 */
function collectRunFlags(tokens) {
  let fresh = false
  let force = false
  let keepAlive = false
  let index = 0
  while (index < tokens.length) {
    const kind = classifyRunFlag(tokens[index])
    if (!kind) break
    if (kind === 'new') fresh = true
    if (kind === 'force') force = true
    if (kind === 'keep-alive') keepAlive = true
    index += 1
  }
  return { rest: tokens.slice(index), fresh, force, keepAlive }
}

/**
 * Route argv to an action. The first token decides:
 *   (nothing) / run  -> run     doctor -> doctor     pair -> pair
 *   setup -> setup              logs -> logs         help / -h / --help -> help
 *   install-cli -> install-cli (put the hoai command on PATH)
 * A run flag (-c / --continue / --resume, --new, --force and --keep-alive)
 * routes to run, either as the first token or right after `run`; `fresh`,
 * `force` and `keepAlive` say which ones were given, and they combine.
 * `keepAlive` is present only when given, so every route that does not ask for
 * it keeps exactly the shape it always had.
 * An unknown first token that LOOKS like a pair code (BGOS-... / OC-...)
 * routes to pair with itself prepended, so `hoai BGOS-7F3A-2K` just works.
 * Anything else routes to help (with the tokens kept, so main can name them).
 * @param {readonly string[]} argv
 * @returns {{ action: 'run' | 'doctor' | 'pair' | 'setup' | 'logs' | 'install-cli' | 'help',
 *             rest: string[], fresh: boolean, force: boolean, keepAlive?: true }}
 */
export function resolveHoaiAction(argv) {
  const args = Array.isArray(argv) ? argv.map((value) => String(value ?? '')) : []
  const route = (action, rest, fresh = false, force = false, keepAlive = false) =>
    keepAlive ? { action, rest, fresh, force, keepAlive: true } : { action, rest, fresh, force }
  if (args.length === 0) return route('run', [])
  const first = args[0]
  const lowered = first.toLowerCase()
  const rest = args.slice(1)
  if (lowered === 'run') {
    const run = collectRunFlags(rest)
    return route('run', run.rest, run.fresh, run.force, run.keepAlive)
  }
  if (lowered === 'doctor') return route('doctor', rest)
  if (lowered === 'pair') return route('pair', rest)
  if (lowered === 'setup') return route('setup', rest)
  if (lowered === 'logs') return route('logs', rest)
  if (lowered === 'install-cli') return route('install-cli', rest)
  if (lowered === 'help' || lowered === '-h' || lowered === '--help') {
    return route('help', rest)
  }
  if (classifyRunFlag(first)) {
    const run = collectRunFlags(args)
    return route('run', run.rest, run.fresh, run.force, run.keepAlive)
  }
  if (/^(BGOS|OC)-/i.test(first)) return route('pair', [first, ...rest])
  return route('help', args)
}

// -- Which channel this folder's agent actually listens on --------------------

/**
 * The channel spec for a launch from `cwd`, and where it came from.
 *
 * Two sources, and the ORDER is the whole point:
 *
 *   1. The workspace itself. If <cwd>/.mcp.json declares an MCP server of ours,
 *      Claude Code loads that entry's channel as `server:<entry name>`. That is
 *      not a guess, it is what the folder publishes, so it wins.
 *   2. Install-method detection, unchanged, for a folder that declares nothing.
 *      That is the bootstrap-installed case: the marketplace branch of
 *      hoai-bootstrap writes NO .mcp.json, so there is nothing to read and the
 *      plugin's own location is the only evidence there is.
 *
 * Why the order had to change. Detection answers "where do the plugin FILES
 * live", which is a PROXY for "how will the channel be loaded", and the proxy
 * breaks on exactly the population this repo has: an agent whose identity and
 * channel live only in its folder's .mcp.json, on a machine that ALSO has the
 * marketplace plugin installed. Detection there says `marketplace`, hoai would
 * launch `plugin:hoai@hoai`, and the workspace publishes `bgos`: the session
 * comes up, `claude mcp list` says Connected, and not one inbound message is
 * ever delivered. Silent deafness, which is the 2026-08-21 failure signature.
 * It also made the restart advice ("/exit, then run hoai from the same folder")
 * quietly wrong for every bgos-agent and bgos-claim workspace, which is worse
 * than having no advice at all.
 *
 * Reading, not guessing, is also what makes a RENAMED server work: the spec is
 * the entry's actual name, so a workspace whose server is `atlas` launches
 * `server:atlas`.
 *
 * `conflict` (two of our servers in one .mcp.json) falls back to detection
 * rather than picking one, because there is no single right answer and the
 * fallback is at least today's behavior.
 *
 * A detection that comes back UNDETERMINED (running through npx on a machine
 * with no readable install record) yields `spec: ''`. That is not a failure to
 * paper over: launchArgsFor refuses it and buildRunPlan turns it into a
 * refusal the user can read and act on, because a guessed spec launches an
 * agent that reports Connected and hears nothing.
 *
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, home?: string,
 *   readFile?: (path: string) => string | null, scriptDir?: string }} [opts]
 * @returns {{ spec: string, source: 'workspace' | 'install-method',
 *             method: string, serverName: string, conflict: boolean, reason: string }}
 */
export function resolveChannelSpec({
  cwd = process.cwd(),
  env = process.env,
  home = homedir(),
  readFile = defaultReadText,
  scriptDir = '',
} = {}) {
  const detection = detectInstallMethod({
    scriptPath: joinDir(scriptDir, 'bgos-install-method.mjs'),
    env,
    home,
  })
  const declared = parseMcpChannelServerName(readFile(joinDir(cwd, MCP_CONFIG_FILE_NAME)))
  if (declared && declared !== 'conflict') {
    return {
      spec: `server:${declared}`,
      source: 'workspace',
      method: detection.method,
      serverName: declared,
      conflict: false,
      reason: '',
    }
  }
  return {
    spec: detection.channelSpec,
    source: 'install-method',
    method: detection.method,
    serverName: '',
    conflict: declared === 'conflict',
    reason: String(detection.reason ?? ''),
  }
}

/** True when a resolution names a channel we can actually launch on. */
export function isResolvedChannel(resolution) {
  return Boolean(String(resolution?.spec ?? '').trim())
}

/** The full claude argv prefix for a launch from `cwd`: the permissions flag
 *  plus the channel flag pair for the resolved spec. One place, so the launch
 *  path and the relaunch path can never disagree about the spec.
 *
 *  Throws on an unresolved spec rather than emitting a flag with an empty
 *  value: `--dangerously-load-development-channels ''` is precisely the silent
 *  misconnection this whole module exists to prevent. Check isResolvedChannel
 *  first and present the reason. */
export function launchArgsFor(resolution) {
  if (!isResolvedChannel(resolution)) {
    throw new Error(
      'launchArgsFor: no channel spec was resolved for this launch. Refuse the launch and show ' +
        'the reason instead of spelling an empty channel flag.',
    )
  }
  return ['--dangerously-skip-permissions', ...channelFlagArgsForSpec(resolution.spec)]
}

/** The human line explaining WHICH channel was chosen and why, or WHY none
 *  could be chosen. */
export function channelNote(resolution) {
  if (resolution.source === 'workspace') {
    return (
      `[hoai] channel ${resolution.spec} (declared by this folder's ${MCP_CONFIG_FILE_NAME}; ` +
      `install method ${resolution.method})`
    )
  }
  if (!isResolvedChannel(resolution)) {
    const reason = String(resolution?.reason ?? '').trim() || 'no evidence of an install was found'
    return `[hoai] install method: UNDETERMINED, so no channel could be chosen. ${reason}`
  }
  const conflictNote = resolution.conflict
    ? ` (this folder's ${MCP_CONFIG_FILE_NAME} declares MORE than one HOAI server, so it was ` +
      'not used; name exactly one to make the choice explicit)'
    : ''
  return `[hoai] install method: ${resolution.method}; channel ${resolution.spec}${conflictNote}`
}

// -- The run plan -------------------------------------------------------------

/**
 * Environment every hoai launch adds.
 *
 * CLAUDE_CODE_ENABLE_TODO_TOOLS=1 turns on the CLI's TaskCreate / TaskUpdate
 * tools, which are the ONLY source of the live Steps strip in the app. Without
 * it every other part of the activity rail works and the strip stays empty for
 * ever, which reads as a broken feature rather than a missing flag. The
 * bootstraps and bgos-agent have carried it since 0.40.0; hoai is the launcher
 * an agent folder actually starts with, day after day, and it did not.
 */
export const LAUNCH_ENV = Object.freeze({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' })

/**
 * The settings entries a CLONE launch must register, or null for a marketplace
 * one.
 *
 * Claude Code reads a plugin's own hooks/hooks.json only for an INSTALLED
 * plugin under the plugins cache. A clone reaches the session as an MCP server
 * entry in the workspace .mcp.json, which is not an installed plugin, so
 * nothing would ever read its hooks file and no activity would appear, with no
 * error to notice. The workspace settings file IS read. A marketplace install
 * already has the rail and must be skipped, or every event fires twice.
 */
export function hookRegistrationFor({ cwd, scriptDir, method }) {
  if (String(method ?? '') === 'marketplace') return null
  const forwarderPath = joinDir(scriptDir, 'hoai-hook.mjs')
  if (!String(scriptDir ?? '').trim()) return null
  return {
    settingsPath: joinDir(joinDir(cwd, '.claude'), 'settings.local.json'),
    forwarderPath,
  }
}

/**
 * The bin folder whose hooks a launch from `cwd` should register: that of the
 * checkout the folder's own .mcp.json starts (lib/clone-hooks.mjs
 * declaredCheckout: its server.ts, or the wrapper's --plugin-dir), when that is
 * an absolute path holding a forwarder; else this launcher's own bin. The hooks
 * talk to the daemon that checkout runs, and the daemon's own boot
 * registration (board row f83db4b7) writes that checkout's hooks too: a launch
 * that wrote its OWN checkout's instead had the two rewriting each other's
 * block on every launch whenever `hoai` came from another checkout.
 * @param {{ cwd: string, scriptDir: string, serverName: string,
 *   readFile: (path: string) => string | null, exists: (path: string) => boolean }} input
 */
export function hookScriptDirFor({ cwd, scriptDir, serverName, readFile, exists }) {
  if (!serverName) return scriptDir
  const served = declaredCheckout(readFile(joinDir(cwd, MCP_CONFIG_FILE_NAME)), serverName)
  if (!/^([A-Za-z]:[\\/]|[\\/])/.test(served)) return scriptDir
  const bin = joinDir(served.replace(/[\\/]+$/, ''), 'bin')
  return exists(joinDir(bin, 'hoai-hook.mjs')) ? bin : scriptDir
}

/**
 * Decide HOW a bare `hoai` launches the agent from this folder.
 *
 * The channel flag comes from install-method detection (the sibling
 * bgos-install-method.mjs is the evidence path). Identity precedence mirrors
 * the daemon's own resolver (lib/agent-credentials.ts):
 *   1. a <cwd>/.bgos-agent-id folder pin: launch is safe, the daemon
 *      self-resolves from the pin, NO env var needed;
 *   2. an explicit BGOS_ASSISTANT_ID env pin: also safe;
 *   3. neither, on a SUPERVISED launch (HOAI_SUPERVISED=1) whose service
 *      names its agent (HOAI_SUPERVISED_ASSISTANT_ID): that agent, handed to
 *      the daemon as BGOS_ASSISTANT_ID in the plan's env;
 *   4. none of those, and MORE THAN ONE credentials-<id>.json under
 *      <home>/.bgos-agent: refuse with both remedies, because the daemon
 *      would refuse to boot for the same reason and a launch that dies at
 *      boot is worse than a clear message here;
 *   5. none of those, and zero or one paired agent: launch, the daemon resolves it.
 * @param {{
 *   cwd?: string,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   readFile?: (path: string) => string | null,
 *   exists?: (path: string) => boolean,
 *   listDir?: (path: string) => string[],
 *   scriptDir?: string,
 * }} [opts]
 * @returns {{ ok: true, command: 'claude', args: string[], note: string,
 *             env: Record<string, string>,
 *             hooks: { settingsPath: string, forwarderPath: string } | null,
 *             detection: { method: string, channelSpec: string, pluginRoot: string } }
 *         | { ok: false, reason: string,
 *             code: 'channel-unresolved' | 'identity-conflict' | 'identity-ambiguous' }}
 *
 * `code` names the refusal for an unattended launch (HOAI_SUPERVISED), which
 * writes it to launch-status instead of waiting for someone to read `reason`.
 */
export function buildRunPlan({
  cwd = process.cwd(),
  env = process.env,
  home = homedir(),
  readFile = defaultReadText,
  exists = existsSync,
  listDir = defaultListDir,
  scriptDir = '',
} = {}) {

  // The channel: what this FOLDER publishes if it publishes anything, else
  // install-method detection. See resolveChannelSpec for why that order.
  //
  // BOTH specs travel on --dangerously-load-development-channels; only the spec
  // differs. A comment here once said marketplace installs use the approved
  // --channels flag and only a clone needs the dangerous one. That was never
  // what this code does, and it is not true: verified live on 2.1.239,
  // --channels loads a marketplace plugin's tools promptlessly, `claude mcp
  // list` even reports Connected, and it wires NO inbound delivery for a
  // channel that is not on Anthropic's allowlist (HOAI is not, yet). It is a
  // third silent-drop vector, and a comment recommending it is how someone
  // re-introduces the bug while believing they follow the design.
  const resolution = resolveChannelSpec({ cwd, env, home, readFile, scriptDir })
  // No channel, no launch. This is the loud half of the 2026-08-24 fix: when
  // this folder publishes no .mcp.json AND the install method is undetermined
  // (hoai reached through npx, whose temp directory is not an install), the
  // only honest outcome is a refusal naming what to do. Launching on a guessed
  // spec would start a session that reports Connected and hears nothing, which
  // is the failure a user cannot see and cannot report.
  if (!isResolvedChannel(resolution)) {
    return {
      ok: false,
      code: 'channel-unresolved',
      reason:
        `${String(resolution.reason ?? '').trim() || 'the install method could not be determined'} ` +
        'hoai will not launch on a guessed channel: a wrong one starts an agent that looks ' +
        'connected and never receives a message.',
    }
  }
  const detection = {
    method: resolution.method,
    channelSpec: resolution.spec,
    pluginRoot: detectInstallMethod({
      scriptPath: joinDir(scriptDir, 'bgos-install-method.mjs'),
      env,
      home,
    }).pluginRoot,
  }
  const args = launchArgsFor(resolution)
  const methodLine = channelNote(resolution)
  // What the launch needs BESIDES the argv: the task tools flag, and (for a
  // clone) the hook entries that carry the activity rail into the session.
  const launchEnv = { ...LAUNCH_ENV }
  const hooks = hookRegistrationFor({
    cwd,
    scriptDir: hookScriptDirFor({ cwd, scriptDir, serverName: resolution.serverName, readFile, exists }),
    method: resolution.method,
  })

  const declared = folderIdentity(cwd, readFile)
  if (declared.conflict) {
    // Two sources naming two agents is not a missing pin, and saying so would
    // send the user to fix the wrong thing.
    return {
      ok: false,
      code: 'identity-conflict',
      reason:
        `this folder declares TWO different assistant ids (${FOLDER_PIN_FILE} and ` +
        `${MCP_CONFIG_FILE_NAME} disagree, or two ${MCP_CONFIG_FILE_NAME} servers name different ` +
        'ids). hoai will not guess which agent this folder is: make them agree, then re-run.',
    }
  }
  if (declared.id) {
    const via =
      declared.source === 'mcp'
        ? `the BGOS_ASSISTANT_ID this folder's ${MCP_CONFIG_FILE_NAME} declares`
        : `the ${FOLDER_PIN_FILE} folder pin`
    return {
      ok: true,
      command: 'claude',
      args,
      env: launchEnv,
      hooks,
      detection,
      note:
        `${methodLine}\n` +
        `[hoai] launching as assistant ${declared.id} via ${via}; ` +
        `no BGOS_ASSISTANT_ID env pin is needed, the daemon self-resolves from this folder.`,
    }
  }

  const envId = configuredAssistantId(env)
  if (envId) {
    return {
      ok: true,
      command: 'claude',
      args,
      env: launchEnv,
      hooks,
      detection,
      note: `${methodLine}\n[hoai] launching as assistant ${envId} (BGOS_ASSISTANT_ID env pin).`,
    }
  }

  // A SUPERVISED launch knows its agent even when the folder does not: the
  // service was installed for HOAI_SUPERVISED_ASSISTANT_ID. Asked BEFORE the
  // multi-agent refusal below, which otherwise stopped a pinless folder on a
  // host with two paired agents (identity-ambiguous, exit 6) before that id
  // was ever consulted, so run.sh lapped on a folder it was installed for. The
  // id also goes into the launch env as BGOS_ASSISTANT_ID, because the daemon
  // claude starts reads its identity from there and refuses to boot unpinned
  // on a multi-agent host for the same reason. Only when the folder declares
  // nothing: a folder that names ANOTHER agent was answered above, and
  // superviseClaude stops that launch as identity-mismatch (exit 7).
  const serviceId = isSupervisedLaunch(env) ? supervisedServiceId(env) : ''
  if (serviceId) {
    return {
      ok: true,
      command: 'claude',
      args,
      env: { ...launchEnv, BGOS_ASSISTANT_ID: serviceId },
      hooks,
      detection,
      note:
        `${methodLine}\n[hoai] launching as assistant ${serviceId}, the agent this supervisor was ` +
        `installed for (${SUPERVISED_ASSISTANT_ID_ENV}); this folder declares none, so the daemon ` +
        `is handed BGOS_ASSISTANT_ID=${serviceId}.`,
    }
  }

  const ids = listPairedAssistantIds(home, listDir)
  if (ids.length > 1) {
    // Short mirror of lib/agent-credentials.ts formatCredentialsRefusal: the
    // daemon itself refuses to boot unpinned on a multi-agent host.
    return {
      ok: false,
      code: 'identity-ambiguous',
      reason:
        `this host has ${ids.length} paired agents (ids: ${ids.join(', ')}) and this folder ` +
        `declares no assistant (no ${FOLDER_PIN_FILE} pin and no BGOS_ASSISTANT_ID in ` +
        `${MCP_CONFIG_FILE_NAME}), so hoai cannot tell which one to launch. ` +
        `Run hoai from the agent's own folder (pairing bakes the pin there, and ` +
        `bgos-agent / bgos-claim write the id into ${MCP_CONFIG_FILE_NAME}), ` +
        `or set BGOS_ASSISTANT_ID=${ids[0]} in this agent's environment.`,
    }
  }
  const homeNote = ids.length === 1 ? soleAgentHomeNote({ home, assistantId: ids[0], cwd, readFile }) : ''
  const identityLine =
    ids.length === 1
      ? `[hoai] launching as this host's sole paired agent (assistant ${ids[0]}); the daemon self-resolves.` +
        (homeNote ? `\n${homeNote}` : '')
      : `[hoai] no pairing on this host yet; if the agent cannot connect, run: hoai pair <CODE> (code from the HOAI app).`
  return {
    ok: true,
    command: 'claude',
    args,
    env: launchEnv,
    hooks,
    detection,
    note: `${methodLine}\n${identityLine}`,
  }
}

// -- The supervise loop (one-click updates) -----------------------------------

/** Mirror of lib/update-readiness.ts SUPERVISOR_FILE / RESTART_MARKER_FILE:
 *  the daemon detects and pokes this launcher through these two files in the
 *  agent's state dir (~/.bgos-agent/<id>/). Pinned by
 *  test/update-readiness.test.ts, which imports both sides. */
export const SUPERVISOR_FILE_NAME = 'supervisor.json'
export const RESTART_MARKER_FILE_NAME = 'restart-requested.json'
/** Mirror of lib/update-readiness.ts KEEPALIVE_MARKER_FILE: what a keepalive
 *  SCRIPT (not this launcher) declares so the daemon can accept it as a
 *  restart authority. Pinned by test/update-readiness.test.ts. */
export const KEEPALIVE_MARKER_FILE_NAME = 'keepalive.json'
/** The agent's pinned resume identity (GAP 1: identity-safe relaunch). A UUID
 *  minted once and stored here so every (re)launch resumes THIS agent's own
 *  session by id, never `--continue` (newest-in-shared-cwd, the identity bleed
 *  that caused the 2026-08-23 fleet incident). */
export const SESSION_ID_FILE_NAME = 'session-id'
/** A fresh session this launcher started and will pin once it outlives the
 *  health window: {sessionId, startedAt}. On disk from its spawn, so a launcher
 *  that dies or stops ticking inside that window (agent 867) does not take it
 *  along: the next launch pins it when its transcript proves it lived on
 *  (decidePendingPin). */
export const PENDING_PIN_FILE_NAME = 'session-id.pending'

/** Taking over a holder that supervises nothing (board row fabeef45, agent
 *  867). The holder must stay idle for the whole confirm window, read every
 *  poll, before anything is sent: a launcher between two children (a marker
 *  relaunch, the fresh retry) has one again within a second. Then SIGTERM, and
 *  SIGKILL when it is still there after the TERM wait. One launcher at a time
 *  takes over (the lock beside supervisor.json); a lock older than its stale
 *  age, empty, unreadable, or whose launcher is gone, was left by a takeover
 *  that died. */
export const TAKEOVER_CONFIRM_MS = 10_000
export const TAKEOVER_POLL_MS = 1_000
export const TAKEOVER_TERM_WAIT_MS = 5_000
export const TAKEOVER_KILL_WAIT_MS = 3_000
export const TAKEOVER_LOCK_SUFFIX = '.takeover'
export const TAKEOVER_LOCK_STALE_MS = 2 * 60_000
/** How long past its time a declared relaunch deadline (relaunchBy, written
 *  for the keep-alive backoff) still counts. */
export const RELAUNCH_DEADLINE_SLACK_MS = 30_000

/** Marker-triggered relaunch budget: 3 per rolling hour. A daemon stuck in
 *  an update-crash loop must not bounce the session forever. */
export const MAX_RELAUNCHES_PER_WINDOW = 3
/** Health relaunches (an unproven gate, no channel heartbeat) have a budget of their own, 3 per
 *  rolling hour too: a gate that keeps failing must never use up the update restarts, nor an update
 *  loop the relaunches that bring a broken launch back (board row 31583f86). */
export const MAX_HEALTH_RELAUNCHES_PER_WINDOW = 3
export const RELAUNCH_WINDOW_MS = 60 * 60 * 1000
export const MARKER_POLL_MS = 3000

/** How long a relaunched session must survive to count as healthy. A resumed
 *  relaunch that dies faster than this (non-zero) is treated as a rejected
 *  resume and retried once as a fresh session, so the supervisor never leaves
 *  the agent dead after its own kill. Mirrors the tmux/expect keepalive.sh
 *  "resumed session died in <25s, retrying fresh" window. */
export const RELAUNCH_HEALTHY_MS = 25_000

/** <statedir>/launch-status: ONE line saying how the most recent launch went,
 *  shared by every writer (bin/bgos-agent run.sh, the supervised expect tail
 *  below, and this loop), and read by `hoai-agent status` and the WEDGED line. */
export const LAUNCH_STATUS_FILE_NAME = 'launch-status'

/** The local `YYYY-MM-DD HH:MM:SS` stamp every launch-status writer uses (the
 *  Tcl side spells it `clock format ... {%Y-%m-%d %H:%M:%S}`, run.sh `date`). */
export function launchStatusStamp(at = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  )
}

/**
 * One launch-status line: `<stamp> outcome=<outcome> key=value ...`. A value
 * with a space is double quoted; quotes and line breaks inside it are dropped,
 * because the file is ONE line by contract and a reader splits on spaces.
 * @param {{ outcome: string, fields?: Record<string, string | number>, at?: Date }} input
 * @returns {string}
 */
export function launchStatusLine({ outcome, fields = {}, at = new Date() }) {
  const parts = [`outcome=${outcome}`]
  for (const [key, raw] of Object.entries(fields)) {
    const value = String(raw ?? '').replace(/["\r\n]+/g, ' ').trim()
    parts.push(/\s/.test(value) ? `${key}="${value}"` : `${key}=${value}`)
  }
  return `${launchStatusStamp(at)} ${parts.join(' ')}`
}

/** --keep-alive backoff (design section 4): 5 s, 10 s, 20 s, 40 s, then 60 s
 *  for every further quick exit, back to 5 s once a session has stayed up for
 *  KEEP_ALIVE_HEALTHY_RESET_MS. Fast enough that a one-off crash costs seconds,
 *  slow enough that an agent that cannot start does not burn the machine (or
 *  the account) relaunching claude in a tight loop. */
export const KEEP_ALIVE_BACKOFF_BASE_MS = 5_000
export const KEEP_ALIVE_BACKOFF_CAP_MS = 60_000
export const KEEP_ALIVE_HEALTHY_RESET_MS = 10 * 60 * 1000

/** A crash loop: CRASH_LOOP_EXITS or more exits inside CRASH_LOOP_WINDOW_MS.
 *  Recorded in launch-status so it is visible, not silent (fact 5 is this
 *  exact failure in the watcher: a loop every 5 s that nobody heard about). */
export const CRASH_LOOP_EXITS = 3
export const CRASH_LOOP_WINDOW_MS = 5 * 60 * 1000

/**
 * The keep-alive backoff. `streak` is how many relaunches the current run of
 * unhealthy exits has already cost; `ranMs` how long the session that just
 * exited stayed up. A session that stayed up KEEP_ALIVE_HEALTHY_RESET_MS ends
 * the streak, so the next wait is the first step again. Junk in, first step
 * out: never NaN, never less than 5 s, never more than 60 s.
 * @param {{ streak: number, ranMs: number, healthyResetMs?: number }} input
 * @returns {{ delayMs: number, streak: number }}
 */
export function decideKeepAliveBackoff({ streak, ranMs, healthyResetMs = KEEP_ALIVE_HEALTHY_RESET_MS }) {
  const prior = Number.isFinite(streak) && streak > 0 ? Math.floor(streak) : 0
  const healthy = Number.isFinite(ranMs) && ranMs >= healthyResetMs
  const step = healthy ? 0 : prior
  // The exponent is clamped so a streak of a million never computes 2 ** 1e6.
  const delayMs = Math.min(KEEP_ALIVE_BACKOFF_BASE_MS * 2 ** Math.min(step, 16), KEEP_ALIVE_BACKOFF_CAP_MS)
  return { delayMs, streak: step + 1 }
}

/**
 * Is the agent in a crash loop? `exitsAt` are the exit times the caller keeps
 * (the current one included); `recent` is the pruned window to keep for next
 * time. An exit exactly CRASH_LOOP_WINDOW_MS ago has left the window.
 * @param {{ exitsAt: readonly number[], now: number, windowMs?: number, threshold?: number }} input
 * @returns {{ crashLoop: boolean, recent: number[] }}
 */
export function decideCrashLoop({ exitsAt, now, windowMs = CRASH_LOOP_WINDOW_MS, threshold = CRASH_LOOP_EXITS }) {
  const recent = (Array.isArray(exitsAt) ? exitsAt : []).filter(
    (at) => Number.isFinite(at) && at <= now && now - at < windowMs,
  )
  return { crashLoop: recent.length >= threshold, recent }
}

/**
 * The assistant id this launch supervises: folder pin, else env pin, else
 * this host's sole paired agent, else '' (supervision off, launch exactly as
 * before). Mirrors buildRunPlan's identity precedence; ids are digits-only
 * (the state dirs are numeric), anything else disables supervision.
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, home?: string,
 *   readFile?: (path: string) => string | null, listDir?: (path: string) => string[] }} [opts]
 */
export function superviseAssistantId({
  cwd,
  env = {},
  home = homedir(),
  readFile = defaultReadText,
  listDir = defaultListDir,
} = {}) {
  const pinned = readFolderDeclaredId(cwd, readFile) || configuredAssistantId(env)
  if (pinned) return /^\d+$/.test(pinned) ? pinned : ''
  const ids = listPairedAssistantIds(home, listDir)
  return ids.length === 1 ? ids[0] : ''
}

/**
 * The assistant id THIS FOLDER declares, from either source of truth: the
 * `.bgos-agent-id` pin, or `.mcp.json`'s BGOS_ASSISTANT_ID.
 *
 * Why the second source matters here and not in the daemon: Claude Code
 * injects an MCP server entry's `env` block into the DAEMON's process
 * environment, so `configuredAssistantId(env)` finds the id there. `hoai` runs
 * OUTSIDE claude, launching it, so the launcher's own environment never
 * contains it. An agent installed by `bgos-agent install --key --user` or by
 * `bgos-claim` has its id only in `.mcp.json` and no `credentials-<id>.json`
 * at all, so every launcher-side reader that consulted the pin and the env
 * came back empty for it: `hoai` refused to launch it on a multi-agent host,
 * supervision was skipped so it had no launcher restart authority, and its
 * logs were keyed `unknown`.
 *
 * '' for a folder that declares nothing, and '' for a folder that declares two
 * DIFFERENT ids: an identity that cannot be established must not be launched,
 * supervised or logged under a guess. Callers that can say something useful
 * about the conflict check `.conflict` themselves.
 *
 * @param {string} cwd
 * @param {(path: string) => string | null} [readFile]
 * @returns {string}
 */
export function readFolderDeclaredId(cwd, readFile = defaultReadText) {
  return folderIdentity(cwd, readFile).id ?? ''
}

/** The full verdict, for callers that report WHERE the identity came from. */
export function folderIdentity(cwd, readFile = defaultReadText) {
  return readFolderIdentity(cwd, readFile)
}

/** supervisor.json body: what the daemon validates before trusting this
 *  launcher as a restart authority (the pid must still be alive and the
 *  relaunch capability must be declared). `boot` is the boot clock read with
 *  `startedAt` (lib/agent-inventory.mjs readBootClock, Linux only, review 3
 *  F1): it lets a reader prove this pid is still the writer on the clock ps
 *  measures etime with, which a wall clock step does not move. Written only
 *  when there is one.
 * `relaunchBy` (ISO) is written only while the launcher is between two
 * children on purpose, the keep-alive backoff: it has no child then, and
 * says by when it will have one again (holderActivity).
 * @param {number} pid
 * @param {string} startedAt
 * @param {{ id: string, uptimeMs: number } | null} [boot]
 * @param {{ relaunchBy?: string }} [extra]
 * @returns {string} */
export function supervisorFileBody(pid, startedAt, boot = null, { relaunchBy } = {}) {
  return JSON.stringify({ pid, capabilities: ['relaunch'], startedAt, ...(boot ? { boot } : {}), ...(relaunchBy ? { relaunchBy } : {}) })
}

/**
 * keepalive.json body: what a keepalive SCRIPT declares so the daemon inside
 * the session it launched can accept it as a restart authority
 * (lib/update-readiness.ts parseKeepaliveMarker validates exactly this).
 *
 * Unlike supervisor.json, the pid here is not the only reading that matters:
 * a keepalive starts claude inside a detached tmux, so its own pid is nowhere
 * in the daemon's ancestry and cannot prove ownership. `claudePid` is the
 * proof AND the restart target, so it is required.
 *
 * `boot` is the boot clock read with `startedAt` (supervisorFileBody says why),
 * written only when there is one.
 *
 * @param {{ pid: number, claudePid: number, tmuxSession?: string | null,
 *   startedAt: string, boot?: { id: string, uptimeMs: number } | null }} opts
 * @returns {string}
 */
export function keepaliveMarkerBody({ pid, claudePid, tmuxSession, startedAt, boot = null }) {
  return JSON.stringify({
    kind: 'keepalive',
    pid,
    claudePid,
    tmuxSession: tmuxSession ?? null,
    capabilities: ['relaunch'],
    startedAt,
    ...(boot ? { boot } : {}),
  })
}

/**
 * Pure relaunch budget: prior marker-relaunch timestamps plus now in,
 * decision out. `recent` is the pruned rolling window the caller keeps.
 * @param {readonly number[]} relaunchesAt
 * @param {number} now
 * @param {number} [max] the budget; health relaunches pass MAX_HEALTH_RELAUNCHES_PER_WINDOW
 * @returns {{ allow: boolean, recent: number[] }}
 */
export function decideMarkerRelaunch(relaunchesAt, now, max = MAX_RELAUNCHES_PER_WINDOW) {
  const recent = (Array.isArray(relaunchesAt) ? relaunchesAt : []).filter(
    (at) => Number.isFinite(at) && now - at < RELAUNCH_WINDOW_MS,
  )
  return { allow: recent.length < max, recent }
}

/**
 * The singleton guard's decision: given the CURRENT supervisor.json body (raw,
 * or null when absent), our own pid, and a pid-liveness probe, decide whether
 * this launch may arm as the restart authority for the agent.
 *
 * A second `hoai` in the same folder (a stray terminal, a launcher plus a
 * manual run) would otherwise produce two claude sessions AND two supervisors
 * racing the same marker. A restart authority must be a singleton per agent.
 *
 * Fails toward NOT double-launching a LIVE owner, but never wedges on junk:
 *   - absent/empty body                         -> arm (nothing owns it)
 *   - a valid authority (integer pid + 'relaunch' cap) whose pid is ALIVE, is
 *     not our own, and is still the launcher that
 *     wrote the file (isSupervisorWriter)       -> refuse, name the owner
 *   - our own pid, a dead pid, a live pid that is
 *     not that writer, malformed json, or a body
 *     without the relaunch capability           -> arm and reclaim (a crashed
 *                                                  prior run left a stale file)
 *
 * The pid identity is the writer's, not just "a hoai": it started no later
 * than the file's startedAt (plus a minute of slack; on Linux on the boot
 * clock the file also records, so a wall clock step after the stamp changes
 * nothing, review 3 F1) and runs hoai-core.mjs as its script. The record the agent's daemon writes for a declared marker
 * launcher (BGOS_SUPERVISOR_KIND=launcher) names the daemon's own pid, a
 * `bun server.ts`: its start alone proves it, and while it lives a bespoke
 * launcher owns the agent (a second session here is G11). A launcher that dies without its finally block (a power cut, a
 * panic, a SIGKILL, a Windows logoff) leaves the file behind, and after a
 * reboot its pid can belong to any process, another agent's hoai or tmux
 * server included: refusing behind it kept the agent down, lap after lap of
 * exit 3, for as long as that process ran. What cannot be read (pidProcess
 * answers null, and the default when no reader is given does) keeps the
 * liveness answer.
 *
 * A live writer is not yet a supervisor (board row fabeef45, kc-server agent
 * 867: two days down, 5,393 restarts of exit 3). Its loop can stop, and then
 * its claude is a zombie nobody reaps or relaunches. So a holder proven to be
 * a hoai launcher is asked for its children (holderChildren, holderActivity):
 * one with no live child and no relaunch deadline comes back with
 * `takeover: true`, which superviseClaude confirms over a window and then
 * acts on. Children that cannot be read (the default) keep the claim.
 * @param {{ existingRaw: string | null | undefined, ownPid: number,
 *   pidAlive?: (pid: number) => boolean,
 *   pidProcess?: (pid: number) => { command: string | null, startedAtMs: number | null } | null,
 *   holderChildren?: (pid: number) => Array<{ zombie: boolean, startedAtMs?: number | null }> | null,
 *   now?: number }} params
 * @returns {{ arm: true, reclaimedStale?: true } | { arm: false, ownerPid: number,
 *   takeover?: true, reason?: 'claude-zombie' | 'no-child' }}
 */
export function decideSupervisorArming({
  existingRaw,
  ownPid,
  pidAlive = defaultPidAlive,
  pidProcess = () => null,
  holderChildren = () => null,
  holderInFolder = () => null,
  now = Date.now(),
}) {
  if (existingRaw == null || String(existingRaw).length === 0) return { arm: true }
  let parsed
  try {
    parsed = JSON.parse(String(existingRaw))
  } catch {
    return { arm: true, reclaimedStale: true }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { arm: true, reclaimedStale: true }
  }
  const pid = parsed.pid
  const capabilities = Array.isArray(parsed.capabilities) ? parsed.capabilities : []
  const isAuthority =
    typeof pid === 'number' &&
    Number.isInteger(pid) &&
    pid > 0 &&
    capabilities.includes('relaunch')
  if (!isAuthority) return { arm: true, reclaimedStale: true }
  if (pid === ownPid) return { arm: true, reclaimedStale: true }
  if (!pidAlive(pid)) return { arm: true, reclaimedStale: true }
  const record = parseSupervisorRecord(String(existingRaw))
  const proc = pidProcess(pid)
  if (!isSupervisorWriter(record, proc)) return { arm: true, reclaimedStale: true }
  // Alive, and the launcher that wrote the claim. Does it still supervise a
  // claude? Asked only of a holder PROVEN to be a hoai launcher (its command
  // line read, running hoai-core.mjs): one that could not be read, or the
  // daemon's declared-launcher record, keeps the claim exactly as before.
  if (!proc || typeof proc.command !== 'string' || !runsHoaiLauncher(proc.command) || record?.declaredLauncher) {
    return { arm: false, ownerPid: pid }
  }
  const children = holderChildren(pid)
  const activity = holderActivity({ relaunchBy: parsed.relaunchBy, holderStartedAtMs: proc.startedAtMs, children, now })
  if (activity !== 'idle') return { arm: false, ownerPid: pid }
  // Ended only when it is provably THIS agent's launcher, not merely a hoai:
  // the writer check allows a minute of slack, and inside it a dead writer's
  // pid can be another agent's launcher in its own incumbent wait (no child
  // either), even one in the same folder. It started no later than its own
  // stamp, and its working folder is not another one: in this agent's folder
  // (linux, darwin) within HOLDER_START_TOLERANCE_MS, and where the folder
  // cannot be read (win32), to the ms.
  const inFolder = holderInFolder(pid)
  if (inFolder === false || !startedByStamp(record, proc, inFolder === true ? HOLDER_START_TOLERANCE_MS : 0)) {
    return { arm: false, ownerPid: pid }
  }
  return { arm: false, ownerPid: pid, takeover: true, reason: children.some((child) => child?.zombie === true) ? 'claude-zombie' : 'no-child' }
}

/** ps reads a start time in whole seconds (etime), so a writer read that way
 *  can look up to a second younger than it is. */
const HOLDER_START_TOLERANCE_MS = 2_000

/** Did `proc` start no later than `record`'s stamp, plus `toleranceMs`? On the
 *  boot clock when both carry it (a wall clock step moves neither), else on
 *  the wall clock. Unreadable is no. */
function startedByStamp(record, proc, toleranceMs) {
  if (record?.boot && proc?.boot) {
    return record.boot.id === proc.boot.id && proc.boot.startedUptimeMs <= record.boot.uptimeMs + toleranceMs
  }
  return typeof proc?.startedAtMs === 'number' && typeof record?.startedAtMs === 'number' && proc.startedAtMs <= record.startedAtMs + toleranceMs
}

/**
 * Does `pid` run in the folder `cwd` (both resolved)? true / false, or null
 * when it cannot be read: linux /proc/<pid>/cwd, darwin lsof; null on win32,
 * where reading another process's folder is no cheap call.
 * @param {number} pid
 * @param {string} [platform]
 * @param {string} [cwd]
 * @param {{ run?: typeof spawnSync }} [opts]
 * @returns {boolean | null}
 */
export function defaultHolderInFolder(pid, platform = process.platform, cwd = process.cwd(), { run = spawnSync } = {}) {
  try {
    const want = realpathSync(cwd)
    if (platform === 'linux') {
      try {
        return realpathSync(`/proc/${pid}/cwd`) === want
      } catch (err) {
        // A folder deleted under it reads as gone; another user's process cannot be read at all.
        return err?.code === 'ENOENT' ? false : null
      }
    }
    if (platform === 'darwin') {
      const res = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: PROCESS_PROBE_TIMEOUT_MS })
      const line = String(res?.stdout ?? '').split('\n').find((l) => l.startsWith('n'))
      return line ? realpathSync(line.slice(1)) === want : null
    }
    return null
  } catch {
    return null
  }
}

/**
 * What a live holder that wrote supervisor.json is doing with its claim
 * (board row fabeef45, agent 867):
 *   'supervising'  a child of it is alive: the claude it started, or the
 *                  expect it runs claude under. A zombie is not alive;
 *   'relaunching'  no child, inside the relaunch deadline it declared
 *                  (relaunchBy), and that deadline is no further out than a
 *                  keep-alive backoff can be: a wall clock stepped back must not
 *                  make a dead launcher look busy for days;
 *   'idle'         no live child, no deadline: it supervises nothing;
 *   'unknown'      its children could not be read, which proves nothing.
 * A child that started before its parent is not its child: Windows keeps a
 * dead parent's pid in ParentProcessId, and reuses pids.
 * @param {{ relaunchBy?: unknown, holderStartedAtMs?: number | null,
 *   children: Array<{ zombie: boolean, startedAtMs?: number | null }> | null, now: number }} input
 * @returns {'supervising' | 'relaunching' | 'idle' | 'unknown'}
 */
export function holderActivity({ relaunchBy, holderStartedAtMs = null, children, now }) {
  if (!Array.isArray(children)) return 'unknown'
  const olderThanHolder = (child) =>
    typeof holderStartedAtMs === 'number' && typeof child?.startedAtMs === 'number' && child.startedAtMs < holderStartedAtMs - 1_000
  if (children.some((child) => child && child.zombie !== true && !olderThanHolder(child))) return 'supervising'
  const by = typeof relaunchBy === 'string' ? Date.parse(relaunchBy) : Number.NaN
  if (Number.isFinite(by) && now <= by + RELAUNCH_DEADLINE_SLACK_MS && by - now <= KEEP_ALIVE_BACKOFF_CAP_MS + RELAUNCH_DEADLINE_SLACK_MS) {
    return 'relaunching'
  }
  return 'idle'
}

/**
 * The fresh session a launcher left in PENDING_PIN_FILE_NAME, judged by the
 * next launch: 'promote' it to the pin when its transcript was still being
 * written after the health window (it lived on, the launcher did not: agent
 * 867 lost two days of context to the older pin), 'drop' it when it died
 * inside the window (zaid 2026-09-02: a fast death must never take the pin),
 * has no transcript, is already the pin, or the file is junk; 'none' when
 * there is no file. It is also dropped when the pin is no longer the one it
 * was written beside (pinAtWrite): a pin rewritten meanwhile (the daemon pins
 * the live session, a /clear moved it on) names the live session and wins.
 * @param {{ pendingRaw: string | null | undefined, pinnedId: string, healthyMs: number,
 *   transcriptMtimeMs: (sessionId: string) => number | null }} input
 * @returns {{ action: 'promote', sessionId: string } | { action: 'drop' | 'none' }}
 */
export function decidePendingPin({ pendingRaw, pinnedId, healthyMs, transcriptMtimeMs }) {
  if (pendingRaw == null) return { action: 'none' }
  let parsed
  try {
    parsed = JSON.parse(String(pendingRaw))
  } catch {
    return { action: 'drop' }
  }
  const sessionId = String(parsed?.sessionId ?? '').trim()
  const startedAtMs = typeof parsed?.startedAt === 'string' ? Date.parse(parsed.startedAt) : Number.NaN
  if (!isSessionIdLike(sessionId) || !Number.isFinite(startedAtMs) || sessionId === pinnedId) return { action: 'drop' }
  if (typeof parsed?.pinAtWrite !== 'string' || parsed.pinAtWrite.trim() !== pinnedId) return { action: 'drop' }
  const lastWrite = transcriptMtimeMs(sessionId)
  if (typeof lastWrite !== 'number' || lastWrite < startedAtMs + healthyMs) return { action: 'drop' }
  return { action: 'promote', sessionId }
}

/**
 * Relaunch-verify decision (never leave the agent dead): after a self-initiated
 * child exit (no marker asked for the restart), decide whether to recover.
 *
 * `isResumeAttempt` is true when the child that exited was RESUMING an existing
 * session (--resume <id>): a marker relaunch, OR the initial launch of a fresh
 * hoai process whose pinned session already exists on disk (e.g. the external
 * keepalive restarted it). A resume that exits NON-ZERO inside the health window
 * is a rejected/corrupt/locked session (the keepalive.sh "resumed session died
 * in <25s" failure), so returning here would leave the agent dead or loop the
 * external supervisor on the same rejection forever. It retries ONCE as a fresh,
 * brand-new OWN session instead. A CLEAN exit (code 0) is a deliberate quit and
 * is always honored, never hijacked; a slow exit, an already-tried fallback, and
 * a fresh CREATE (--session-id, never a resume) all return unchanged, so a
 * fundamentally broken launch (e.g. claude not installed) is not looped on.
 * @param {{ isResumeAttempt: boolean, exitCode: number | null, elapsedMs: number,
 *   freshTried: boolean, healthyMs?: number }} params
 * @returns {{ action: 'return' | 'retry-fresh' }}
 */
export function decideRelaunchRecovery({
  isResumeAttempt,
  exitCode,
  elapsedMs,
  freshTried,
  healthyMs = RELAUNCH_HEALTHY_MS,
}) {
  if (
    isResumeAttempt &&
    !freshTried &&
    exitCode !== 0 &&
    Number.isFinite(elapsedMs) &&
    elapsedMs < healthyMs
  ) {
    return { action: 'retry-fresh' }
  }
  return { action: 'return' }
}

// -- Identity-safe session args (GAP 1) --------------------------------------

/** Claude Code's project-dir munge: every non-alphanumeric char of the cwd
 *  becomes '-'. Mirror of lib/usage-report.ts mungeCwd (kept in plain JS; hoai
 *  runs under bare node and must not import the TS sources). A session's
 *  transcript lives under ~/.claude/projects/<munged-cwd>/. */
export function mungeSessionCwd(cwd) {
  return String(cwd ?? '').replace(/[^a-zA-Z0-9]/g, '-')
}

/** Where Claude Code writes THIS session's transcript. Its existence is how we
 *  tell "resume my session" from "create it with a known id". */
export function sessionTranscriptPath(home, cwd, sessionId, configDir = '') {
  // CLAUDE_CONFIG_DIR moves the whole config tree, transcripts included.
  const base = String(configDir ?? '').trim() || joinDir(home, '.claude')
  const projects = joinDir(base, 'projects')
  const dir = joinDir(projects, mungeSessionCwd(cwd))
  return joinDir(dir, `${sessionId}.jsonl`)
}

/** A pinned id looks like a UUID; anything else is treated as no pin (we never
 *  pass junk to --session-id / --resume). */
export function isSessionIdLike(value) {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    String(value ?? '').trim(),
  )
}

/**
 * The identity-safe launch args for a pinned session id. Resume the agent's OWN
 * session when its transcript already exists, otherwise create it with that
 * exact id. NEVER --continue (newest-in-shared-cwd, the identity bleed). Empty
 * when no id is resolvable, so the caller falls back to a plain fresh launch.
 * @param {string} sessionId
 * @param {boolean} sessionExists
 * @returns {string[]}
 */
export function sessionArgsFor(sessionId, sessionExists) {
  if (!sessionId) return []
  return sessionExists ? ['--resume', sessionId] : ['--session-id', sessionId]
}

/**
 * Read the agent's pinned session id, or mint and persist one. Returns '' only
 * when there is neither a valid pin nor a way to write one (then the caller
 * launches a plain fresh session, exactly as before pinning existed).
 * @param {{ path: string, readFile: (p: string) => string | null,
 *   writeFile: (p: string, c: string) => boolean, generateId?: () => string }} deps
 * @returns {string}
 */
export function ensurePinnedSessionId({ path, readFile, writeFile, generateId = randomUUID }) {
  const existing = String(readFile(path) ?? '').trim()
  if (isSessionIdLike(existing)) return existing
  const fresh = String(generateId()).trim()
  if (!fresh) return ''
  return writeFile(path, fresh) ? fresh : ''
}

/**
 * `hoai --new`: mint a NEW pinned session id and repin the agent to it, so this
 * launch starts a clean conversation AND every later bare `hoai` resumes the
 * new one rather than the abandoned one. The old transcript is left on disk,
 * nothing is deleted.
 *
 * Returns '' when the repin cannot be written; the caller then launches a plain
 * fresh session (claude mints its own id), which is still a NEW session, just
 * an unpinned one. It NEVER falls back to reading the old pin, because the one
 * thing --new must not do is resume the session the user asked to leave.
 * @param {{ path: string, writeFile: (p: string, c: string) => boolean,
 *   generateId?: () => string }} deps
 * @returns {string}
 */
export function freshPinnedSessionId({ path, writeFile, generateId = randomUUID }) {
  const fresh = String(generateId()).trim()
  if (!fresh) return ''
  return writeFile(path, fresh) ? fresh : ''
}

// -- Startup-gate auto-accept (GAP 2) ----------------------------------------

/** Every launch that carries --dangerously-load-development-channels shows the
 *  "WARNING: Loading development channels" confirm at (re)start, for a
 *  marketplace install as much as for a clone (verified live on Claude Code
 *  2.1.241, Windows, 2026-08-25 disposable E2E; the earlier belief that a
 *  marketplace install never prompts was wrong). Its default answer is
 *  "I am using this for local development", one Enter accepts it, and no
 *  settings key silences it. So every (re)launch needs the gate accepted:
 *  under `expect` on posix, through the console-input helper on win32. The
 *  parameter is kept so callers stay explicit about what they detected. */
export function relaunchNeedsGateAutoAccept(installMethod) {
  return installMethod === 'clone' || installMethod === 'marketplace'
}

/** The win32 gate helper (bin/win32-accept-dev-channels.ps1): attaches to the
 *  console this launcher shares with claude, waits for the gate's marker text
 *  to be ON SCREEN, then injects exactly one Enter (the gate's default). It
 *  never presses blindly, so a prompt with a dangerous default (the bypass
 *  warning, which the settings file suppresses anyway) is never answered by
 *  it. Pure argv builder so the spawn is unit-testable. */
export const WIN32_GATE_HELPER_FILE = 'win32-accept-dev-channels.ps1'
export function win32GateHelperArgs({ scriptDir = '', consolePid, timeoutSeconds = 120, logFile = '' }) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    joinDir(scriptDir, WIN32_GATE_HELPER_FILE),
    '-ConsolePid',
    String(consolePid),
    '-TimeoutSeconds',
    String(timeoutSeconds),
    ...(logFile ? ['-LogFile', logFile] : []),
  ]
}

/** The helper's exit when it wrote the Enter but could not record both `attached` and
 *  `accepted` in its log. Agent 888, 16 Oct 07:59Z, a cold start after logon: the log had
 *  `start` and `accepted`, no `attached`, and claude never started its MCP server. The old
 *  helper lost a log line silently (PowerShell 5.1 Add-Content refuses a file another process
 *  has open for reading, as a non-terminating error) and exited 0 anyway, and hoai never looked
 *  at its exit. A 6 is a gate nobody can show was answered, so an unattended launch relaunches
 *  claude for it (superviseClaude, under the health relaunch budget). */
export const WIN32_GATE_EXIT_UNPROVEN = 6

/** How long after a launch an unattended hoai gives the channel to send its first heartbeat.
 *  A healthy daemon touches its beacon within seconds of finishing its boot sweep (and about every
 *  5 s after; a poll cycle that ran counts, so a backend that refuses does not stop it); 888 sat
 *  with no MCP server at all for 10 minutes. */
export const CHANNEL_HEARTBEAT_WAIT_MS = 3 * 60_000

/** The daemon's channel beacon (lib/pairing-lock.ts touchBeaconHeartbeat, `{ beaconAt, pid }`,
 *  in the plugin state dir), or null for anything else. */
export function parseChannelBeacon(raw) {
  if (typeof raw !== 'string' || !raw) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const beaconAt = Number(parsed?.beaconAt)
  const pid = Number(parsed?.pid)
  if (!Number.isFinite(beaconAt) || !Number.isInteger(pid) || pid <= 0) return null
  return { beaconAt, pid }
}

/** How long after a launch a beacon from the daemon the file already named still counts as a
 *  predecessor's: one winding down beacons within seconds of its claude's end, never a minute on. */
const PREDECESSOR_BEACON_GRACE_MS = 60_000

/** Has the agent's channel sent a heartbeat since THIS launch started? A beacon written since then
 *  counts, except one from the daemon the file named at that moment written in the first minute:
 *  the previous claude's daemon, winding down, can beacon once more after the relaunch, and that
 *  proves nothing. The same daemon still beaconing a minute on is a live channel (another session
 *  of this agent holds it), and relaunching this claude would not change that.
 *  @param {{ beacon: { beaconAt: number, pid: number } | null, startedAt: number, stalePid?: number | null }} input */
export function channelHeartbeatSince({ beacon, startedAt, stalePid = null }) {
  if (!beacon || beacon.beaconAt < startedAt) return false
  if (beacon.pid !== stalePid) return true
  return beacon.beaconAt - startedAt >= PREDECESSOR_BEACON_GRACE_MS
}

/** Login records older than this never count (lib/claude-login.ts LOGIN_STALE_MS, the daemon's rule). */
export const LOGIN_STALE_MS = 10 * 60_000
/** How much of each fresh transcript the shared-login check reads, from the end (the daemon's startup tail). */
export const LOGIN_TAIL_BYTES = 64 * 1024

// eslint-disable-next-line no-control-regex
const LOGIN_TEXT_CONTROL = /[\u0000-\u001f\u007f]/g

/**
 * The LAST login signal in a transcript chunk: `{ type: 'login_failed', at, text }` for the CLI's own
 * `authentication_failed` record, `{ type: 'activity', at }` for a real assistant turn (not synthetic,
 * not a sidechain), or null. A mirror of lib/claude-login.ts extractLoginSignal, which hoai cannot
 * import: it runs under bare node. Pinned against it by test/hoai-core.win-relaunch.test.ts.
 * @param {string} chunk
 * @param {number} nowMs
 */
export function loginSignalOf(chunk, nowMs) {
  let signal = null
  for (const line of String(chunk ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let e
    try {
      e = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof e !== 'object' || e === null || e.type !== 'assistant') continue
    const m = e.message
    if (typeof m !== 'object' || m === null) continue
    const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) || 0 : 0
    if (at === 0 || at < nowMs - LOGIN_STALE_MS) continue
    if (e.isApiErrorMessage === true) {
      if (e.error !== 'authentication_failed') continue
      const text = (Array.isArray(m.content) ? m.content : [])
        .filter((b) => typeof b === 'object' && b !== null && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join(' ')
        .replace(LOGIN_TEXT_CONTROL, ' ')
        .trim()
        .slice(0, 160)
      signal = { type: 'login_failed', at, text }
    } else {
      if (e.isSidechain === true || m.model === '<synthetic>') continue
      signal = { type: 'activity', at }
    }
  }
  return signal
}

/** The newest login signal (loginSignalOf) across every agent folder's transcripts under
 *  `<configDir>/projects`, counting only records from `since` on; files not written since then are not
 *  read. Null when there is none. Never throws. */
function fleetNewestLoginSignal({ configDir, since, listDir, mtimeMs, readTail }) {
  const projects = joinDir(configDir, 'projects')
  const list = (path) => {
    try {
      return listDir(path) ?? []
    } catch {
      return []
    }
  }
  let newest = null
  for (const folder of list(projects)) {
    const dir = joinDir(projects, folder)
    for (const name of list(dir)) {
      if (!String(name).endsWith('.jsonl')) continue
      const path = joinDir(dir, name)
      const mtime = mtimeMs(path)
      if (mtime == null || mtime < since) continue
      // loginSignalOf counts records from LOGIN_STALE_MS before its clock: this clock makes that `since`.
      const signal = loginSignalOf(readTail(path) ?? '', since + LOGIN_STALE_MS)
      if (signal && (!newest || signal.at >= newest.at)) newest = signal
    }
  }
  return newest
}

/**
 * Has the Claude login every agent of this credential store shares failed? The newest login signal
 * across the fresh transcripts (LOGIN_STALE_MS, the daemon's rule) of every agent folder under
 * `<configDir>/projects` decides: the CLI's failure record, unless some agent answered after it.
 * Returns `{ at, text }` (the CLI's words) or null; never throws.
 * @param {{ configDir: string, now: number, listDir: (path: string) => string[],
 *   mtimeMs: (path: string) => number | null, readTail: (path: string) => string | null }} input
 */
export function fleetClaudeLoginFailure({ configDir, now, listDir, mtimeMs, readTail }) {
  const newest = fleetNewestLoginSignal({ configDir, since: now - LOGIN_STALE_MS, listDir, mtimeMs, readTail })
  return newest?.type === 'login_failed' ? { at: newest.at, text: newest.text } : null
}

/**
 * Has some agent of this credential store answered since a login failure at `since`, at any age, with
 * no failure after that answer? Only that proves the login works again: a failure nobody has tried
 * past is still a failure once it is older than LOGIN_STALE_MS (lib/claude-login.ts reduceLoginState:
 * "a dead login stays dead until proven otherwise"). Never throws.
 * @param {{ configDir: string, since: number, listDir: (path: string) => string[],
 *   mtimeMs: (path: string) => number | null, readTail: (path: string) => string | null }} input
 */
export function fleetClaudeLoginAnswered({ configDir, since, listDir, mtimeMs, readTail }) {
  return fleetNewestLoginSignal({ configDir, since, listDir, mtimeMs, readTail })?.type === 'activity'
}

/** Did the CLI sign in again after a failure at `since`? It rewrites `<configDir>/.credentials.json` on
 *  /login (and on each token refresh, which also proves the login works). Only the file's time is
 *  looked at, never what it holds; a login kept elsewhere (the macOS Keychain) has no such file, and
 *  only an answer clears its failure.
 *  @param {{ configDir: string, since: number, mtimeMs: (path: string) => number | null }} input */
export function claudeSignedInSince({ configDir, since, mtimeMs }) {
  const written = mtimeMs(joinDir(configDir, '.credentials.json'))
  return written != null && written > since
}

/** A file's modification time in ms, or null. Never throws. */
export function fileMtimeMs(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/** The last `bytes` of a file as text, from its first whole line on, or null. Never throws. */
export function readFileTail(path, bytes) {
  let fd = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const from = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - from)
    const text = buf.subarray(0, readSync(fd, buf, 0, buf.length, from)).toString('utf8')
    return from > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Nothing more to do with it.
      }
    }
  }
}

/**
 * The shared startup gate block (lib/gate-block.tcl): ONE copy of the rules for
 * answering Claude Code's first-run screens, embedded here in the launcher's
 * expect script and copied by bin/bgos-agent into the supervisor's run.expect.
 * Two hand-kept copies is how the 2026-09-21 fix landed in this file and never
 * reached the supervisor that desktop one-click actually installs.
 * @param {(path: string) => string} [read]
 * @returns {string}
 */
export const GATE_BLOCK_FILE = 'gate-block.tcl'
export function readGateBlock(read = (p) => readFileSync(p, 'utf8')) {
  return String(read(fileURLToPath(new URL(`../lib/${GATE_BLOCK_FILE}`, import.meta.url))))
}

/**
 * The launcher's expect script: spawn claude, run the shared gate block, then
 * hand the terminal to the person with interact. A SIGTERM trap kills the
 * spawned claude before exiting, so when the supervisor SIGTERMs this expect
 * process claude cannot be orphaned into a second live session (which would
 * reintroduce the identity bleed).
 *
 * WHAT CHANGED, AND WHY (2026-09-21, measured against Claude Code 2.1.278).
 * This script used to press Enter on the single word "confirm", on the theory
 * that Enter "accepts folder-trust, dev-channels, and bypass gates alike". It
 * does not. Folder trust and the bypass warning list "No, exit" FIRST, so that
 * Enter declined them: claude exited in two seconds, code 0, nothing printed,
 * on exactly the launch where the pre-seed had missed. The earlier fix removed
 * the Enter on TIMEOUT and left this one, so "never presses blind" was true of
 * the timeout branch only. The gate block now reads each screen and derives
 * the key from it; see the file for the rules and the measurements.
 *
 * It also stops a failed launch from being silent. A claude that exits during
 * startup, and a screen the block cannot answer, each print one plain line
 * saying which, with the words that were on the screen. An unanswerable screen
 * is still handed to interact, because in a terminal a person may be right
 * there to answer it; the supervisor, which has nobody, exits with the reason
 * instead (bin/bgos-agent).
 *
 * Each arg is brace-quoted (Tcl literal, no substitution) so a future arg with
 * a space or a Tcl-special char cannot break or inject into the script; today's
 * args are fixed flags plus a regex-validated UUID, so this is defense in depth.
 *
 * SUPERVISED (HOAI_SUPERVISED=1, bin/bgos-agent's run.sh, nobody at the
 * terminal): `supervised` swaps the person-facing tail for the one generation
 * 1's run.expect carried, now in ONE place. The fail count run.sh keeps feeds
 * the extra settle (a launch that lost the startup race waits longer next
 * time, measured 2026-09-22); the measured outcome, plus the remote compact
 * state, is written to <stateDir>/launch-status; and a screen nobody can
 * answer, an exit during startup and a signed-out claude each stop with a
 * NAMED exit (EXIT_SUPERVISED_*) instead of waiting for a person. A live
 * session is then relayed with `interact` when there is a terminal (tmux,
 * where /compact is typed in, finding 8) and HELD with `expect eof` when there
 * is none (no tmux, stdin is /dev/null): interact would read EOF there at once
 * and end the agent the moment it came up.
 * @param {{ claudePath: string, args: readonly string[], gateBlock?: string,
 *   supervised?: { stateDir: string, interactive: boolean, compact: string } | null }} params
 * @returns {string}
 */
export function buildGateAutoAcceptExpect({ claudePath, args, gateBlock = readGateBlock(), supervised = null }) {
  const quoted = (args ?? []).map((a) => `{${a}}`).join(' ')
  const spawnLine = quoted ? `spawn ${claudePath} ${quoted}` : `spawn ${claudePath}`
  if (supervised) {
    return [
      `set hoai_statedir ${tclQuote(supervised.stateDir)}`,
      'set hoai_extra_settle 0',
      'catch {',
      '  set hoai_fh [open "$hoai_statedir/failcount"]',
      '  set hoai_fails [string trim [read $hoai_fh]]',
      '  close $hoai_fh',
      '  if {[string is integer -strict $hoai_fails] && $hoai_fails > 0} {',
      '    set hoai_extra_settle [expr {$hoai_fails >= 5 ? 10 : 2 * $hoai_fails}]',
      '  }',
      '}',
      spawnLine,
      // Kill the spawned claude on SIGTERM so a supervisor kill never orphans it.
      'trap {catch {exec kill [exp_pid]}; exit 143} SIGTERM',
      gateBlock,
      // A claude that exited during startup: its exit code and its last words go to hoai.err
      // (the file run.sh reads back and prints) and to the status line, so a CLI too old for
      // the launch flag says so instead of crash looping in silence (board row 84296679).
      'set hoai_rc ""',
      'if {$hoai_outcome eq "exited-during-startup"} {',
      '  set hoai_rc "?"',
      '  catch { set hoai_w [wait]; set hoai_rc [lindex $hoai_w 3] }',
      '  catch {',
      '    set hoai_ef [open "$hoai_statedir/hoai.err" a]',
      '    puts $hoai_ef "[clock format [clock seconds] -format {%Y-%m-%d %H:%M:%S}] claude exited during startup (rc=$hoai_rc): $hoai_screen"',
      '    close $hoai_ef',
      '  }',
      '}',
      'set hoai_line "outcome=$hoai_outcome answered=\\[$hoai_answered\\]"',
      'if {$hoai_rc ne ""} { append hoai_line " rc=$hoai_rc" }',
      'if {$hoai_screen ne ""} { append hoai_line " screen=\\"$hoai_screen\\"" }',
      // Static text from this launcher, brace-quoted: compact=on | compact=off reason=no-tmux.
      `append hoai_line { ${String(supervised.compact ?? '').replace(/[{}\\]/g, '')}}`,
      'catch {',
      '  set hoai_f [open "$hoai_statedir/launch-status" w]',
      '  puts $hoai_f "[clock format [clock seconds] -format {%Y-%m-%d %H:%M:%S}] $hoai_line"',
      '  close $hoai_f',
      '}',
      'puts "\\n\\[hoai\\] launch: $hoai_line"',
      `if {[string match "gate-*" $hoai_outcome]} { catch {close}; exit ${EXIT_SUPERVISED_GATE} }`,
      `if {$hoai_outcome eq "exited-during-startup"} { exit ${EXIT_SUPERVISED_STARTUP_EXIT} }`,
      `if {$hoai_outcome eq "live-but-not-signed-in"} { catch {close}; exit ${EXIT_SUPERVISED_SIGNED_OUT} }`,
      'set timeout -1',
      supervised.interactive ? 'interact' : 'expect eof',
    ].join('\n')
  }
  return [
    spawnLine,
    // Kill the spawned claude on SIGTERM so a supervisor kill never orphans it.
    'trap {catch {exec kill [exp_pid]}; exit 143} SIGTERM',
    gateBlock,
    'if {$hoai_outcome eq "exited-during-startup"} {',
    '  puts stderr "\\n\\[hoai\\] Claude Code exited during startup, before its session was up. Gates answered first: \\[$hoai_answered\\]. Run: hoai doctor"',
    '  exit 1',
    '}',
    'if {[string match "gate-*" $hoai_outcome]} {',
    '  puts stderr "\\n\\[hoai\\] Claude Code is showing a screen hoai will not answer for you ($hoai_outcome): $hoai_screen"',
    '  puts stderr "\\[hoai\\] It is waiting for an answer in this window. Nothing was pressed."',
    '}',
    'set timeout -1',
    'interact',
  ].join('\n')
}

/** A Tcl double-quoted word whose every special character is escaped, so a
 *  path (spaces, brackets, $, quotes, backslashes) is data, never code. */
export function tclQuote(value) {
  return `"${String(value ?? '').replace(/[\\$\[\]"{}]/g, (c) => `\\${c}`)}"`
}

/**
 * The args for a relaunch: the channel resolved FRESH (an update can move a
 * marketplace cache dir, and a workspace can gain or lose an .mcp.json, so the
 * spec is re-resolved and never reused blind) plus the caller's identity-safe
 * session args (--resume <own-id> / --session-id <own-id>, or [] for a plain
 * fresh session). NEVER --continue: that resumes the newest session in a shared
 * cwd, which is another agent's (GAP 1).
 *
 * Returns null when the fresh resolution names no channel. The relaunch path is
 * UNATTENDED, so this is the one place where "carry on with something" would
 * cost the most: it would bring the agent back on an empty channel flag and
 * nobody would be watching. The caller stops and prints instead.
 * `extraArgs` (the agent's identity flag, lib/agent-identity.mjs) go between
 * the two, so a relaunch is told who it is exactly like the first launch.
 * @param {{ scriptDir?: string, env?: Record<string, string | undefined>,
 *   home?: string, cwd?: string, readFile?: (path: string) => string | null,
 *   sessionArgs?: readonly string[], extraArgs?: readonly string[] }} [opts]
 * @returns {string[] | null}
 */
export function relaunchClaudeArgs({
  scriptDir = '',
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  readFile = defaultReadText,
  sessionArgs = [],
  extraArgs = [],
} = {}) {
  // Resolved the SAME way as the first launch (workspace .mcp.json first, then
  // detection). A relaunch that resolved the channel differently from the
  // launch would bring the agent back deaf on a spec it was never listening on,
  // and the marker relaunch path is unattended, so nobody would see it happen.
  const resolution = resolveChannelSpec({ cwd, env, home, readFile, scriptDir })
  if (!isResolvedChannel(resolution)) return null
  return [...launchArgsFor(resolution), ...extraArgs, ...sessionArgs]
}

/** The install method for a relaunch (fresh detection), used to decide whether
 *  the startup gate needs auto-accepting (GAP 2). */
export function relaunchInstallMethod({ scriptDir = '', env = process.env, home = homedir() } = {}) {
  return detectInstallMethod({
    scriptPath: joinDir(scriptDir, 'bgos-install-method.mjs'),
    env,
    home,
  }).method
}

/** Best-effort write with parent mkdir; false on failure. */
function defaultWriteFile(path, content) {
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    return false
  }
  // Whole or not at all (board row fabeef45): a reader never sees the file
  // half written, so an empty supervisor.json can only be what a crash or a
  // power cut left, and reads as stale. The temp file sits beside the target,
  // on the same disk, so the rename is atomic. Windows refuses a rename onto a
  // file another process holds open without delete sharing (an antivirus
  // scan): that one write goes in place, as before.
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, content)
    renameSync(temp, path)
    return true
  } catch {
    defaultRemoveFile(temp)
  }
  try {
    writeFileSync(path, content)
    return true
  } catch {
    return false
  }
}

/** Create `path` with `content` only when it does not exist yet: 'created',
 *  'exists', or 'failed' (no folder, no permission, a full disk). Of two
 *  launchers that find no claim, one wins. The content is written to a temp
 *  file first and hard linked into place, which fails when the name exists
 *  and never shows the file empty (and is the exclusive create that also
 *  holds on NFS). A disk without hard links (FAT, some network shares) gets an
 *  exclusive open instead. */
function defaultCreateExclusive(path, content) {
  const temp = `${path}.${process.pid}.new`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temp, content)
  } catch {
    defaultRemoveFile(temp)
    return 'failed'
  }
  try {
    linkSync(temp, path)
    return 'created'
  } catch (err) {
    if (err?.code === 'EEXIST') return 'exists'
  } finally {
    defaultRemoveFile(temp)
  }
  try {
    writeFileSync(path, content, { flag: 'wx' })
    return 'created'
  } catch (err) {
    return err?.code === 'EEXIST' ? 'exists' : 'failed'
  }
}

/** Best-effort delete; false when the file was not removed. */
function defaultRemoveFile(path) {
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

/** Spawn the win32 gate helper detached and hidden (stdio ignored, unref'd)
 *  so it outlives nothing and blocks nothing; the console pid is this
 *  launcher's own, which claude shares. */
function defaultSpawnGateHelper({ scriptDir, consolePid, spawnImpl = spawn, writeErr, home = homedir() }) {
  const logFile = joinDir(joinDir(agentDir(home), 'logs'), 'win32-gate-helper.log')
  // The helper's own stdout/stderr go to the log too, so a PowerShell that
  // refuses to run the script (policy, AMSI, a bad path) leaves a reason.
  let logFd = 'ignore'
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    logFd = openSync(logFile, 'a')
  } catch {}
  // NOT detached: a DETACHED_PROCESS powershell exits 0 without running the
  // script at all (measured 2026-08-25: detached -> silent exit 0, attached
  // -> runs, attaches, polls). Hidden so no second window flashes.
  const child = spawnImpl('powershell.exe', win32GateHelperArgs({ scriptDir, consolePid, logFile }), {
    stdio: ['ignore', logFd, logFd],
    detached: false,
    windowsHide: true,
    shell: false,
  })
  child.on?.('error', (err) => writeErr?.(`[hoai] dev-channels gate helper failed to start: ${err?.message ?? err}\n`))
  child.unref?.()
  return child
}

/** What hoai writes to the console before a relaunch on Windows: leave an alternate screen buffer a
 *  killed claude left active (conhost discards it), erase the screen and the scrollback, cursor home.
 *  The gate helper reads the active buffer up to 40 lines above the cursor; after this there is
 *  nothing of the old claude's there (measured on conhost with the real helper, alternate and main
 *  screen both). */
export const WIN32_CONSOLE_CLEAR = '\x1b[?1049l\x1b[2J\x1b[3J\x1b[H'

/** Write WIN32_CONSOLE_CLEAR to a console stream. Nothing for a stream that is not a TTY (a redirected
 *  stdout: claude draws nowhere a helper reads then). True when it was written. */
export function clearWin32Console(stream) {
  if (!stream?.isTTY) return false
  try {
    stream.write(WIN32_CONSOLE_CLEAR)
    return true
  } catch {
    return false
  }
}

/** Every Windows process as `<pid> <parent pid> <start ms or -> <name>` lines: Win32_Process through
 *  the System32 powershell, never a command line. */
const WIN32_PROCESS_ROWS_SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, " +
  "$(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { '-' }), $_.Name }"

/** WIN32_PROCESS_ROWS_SCRIPT's lines as `{ pid, ppid, startedAtMs, name }` (a name may hold spaces;
 *  an unknown start is null). Lines of any other shape are skipped. */
export function parseWin32ProcessRows(stdout) {
  const out = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+) (\d+) (\d+|-) (.+)$/)
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), startedAtMs: m[3] === '-' ? null : Number(m[3]), name: m[4] })
  }
  return out
}

/** Every process on this Windows computer (pid, parent pid, start, name), or null when it could not be
 *  listed. Fails closed: with no SystemRoot there is no System32 powershell to name, and a bare
 *  `powershell.exe` would be looked up in the current folder (the agent's) first.
 *  @param {{ spawnSyncImpl?: typeof spawnSync, env?: Record<string, string | undefined> }} [opts] */
export function listWin32Processes({ spawnSyncImpl = spawnSync, env = process.env } = {}) {
  const root = String(env.SystemRoot ?? env.SYSTEMROOT ?? '').trim()
  if (!root) return null
  const powershell = joinDir(joinDir(joinDir(joinDir(root, 'System32'), 'WindowsPowerShell'), 'v1.0'), 'powershell.exe')
  try {
    const r = spawnSyncImpl(powershell, ['-NoProfile', '-NonInteractive', '-Command', WIN32_PROCESS_ROWS_SCRIPT], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    })
    if (r?.status !== 0) return null
    return parseWin32ProcessRows(r.stdout)
  } catch {
    return null
  }
}

/** What ending a claude started through a shim takes, besides the shim (`rootPid`) itself: the
 *  processes the shim started, and theirs through any further cmd.exe layer (a .cmd that runs another
 *  with cmd /c); never deeper. Claude's own children (its MCP servers) are in claude's kill-on-close
 *  job and end with it, as under a native claude.exe; what the daemon started DETACHED to outlive
 *  claude (its browser host, which closes Chrome cleanly once the daemon is gone; a person lane's
 *  supervisor) must live on, and `taskkill /T` would end it: a detached process still names its parent.
 *  A process that started before its named parent is no child (a pid Windows reused), and neither is
 *  one whose start is unknown.
 *  @param {{ pid: number, ppid: number, startedAtMs: number | null, name: string }[]} processes
 *  @param {number} rootPid
 *  @returns {number[]} */
export function win32ShimTargets(processes, rootPid) {
  const root = processes.find((p) => p.pid === rootPid)
  // Only a shim hides claude: a native claude.exe's children are its MCP servers and tools, in its own
  // kill-on-close job, ended with it as on main.
  if (!root || !/^cmd\.exe$/i.test(root.name)) return []
  const targets = []
  const seen = new Set([rootPid])
  let layer = [root]
  while (layer.length > 0) {
    const next = []
    for (const parent of layer) {
      for (const p of processes) {
        if (p.ppid !== parent.pid || seen.has(p.pid)) continue
        if (p.startedAtMs == null || parent.startedAtMs == null || p.startedAtMs < parent.startedAtMs) continue
        seen.add(p.pid)
        targets.push(p.pid)
        if (/^cmd\.exe$/i.test(p.name)) next.push(p)
      }
    }
    layer = next
  }
  return targets
}

/** End a claude hoai started through a shim: the processes the shim started (win32ShimTargets), then
 *  the shim. A claude installed by npm is `claude.cmd`, which hoai starts as `cmd.exe /c claude.cmd`,
 *  and node's kill() of that child is TerminateProcess on cmd.exe alone: the real claude under it (node
 *  running cli.js) is not in libuv's kill-on-close job either (it breaks away silently), so it ran on
 *  beside the relaunched one (board row 978da5db, measured with a fake claude behind a real cmd-shim
 *  claude.cmd). True once the listing found the shim and every kill was sent; false (nothing ended,
 *  the caller's own kill() is the fallback) when the processes could not be listed.
 *  @param {number} pid
 *  @param {{ spawnSyncImpl?: typeof spawnSync, env?: Record<string, string | undefined>, kill?: (pid: number) => unknown }} [opts] */
export function endWin32ShimTree(pid, { spawnSyncImpl = spawnSync, env = process.env, kill = (target) => process.kill(target) } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const processes = listWin32Processes({ spawnSyncImpl, env })
  if (!processes || !processes.some((p) => p.pid === pid)) return false
  for (const target of [...win32ShimTargets(processes, pid), pid]) {
    try {
      kill(target)
    } catch {
      // Already gone.
    }
  }
  return true
}

/**
 * Is `expect` available to auto-accept the dev-channels startup gate? Never on
 * win32 (no expect; win32 uses the console-input helper instead).
 *
 * The well-known paths, AND every PATH directory: spawnExpectScript starts
 * `expect` by name through PATH, and bin/bgos-agent requires only `command -v
 * expect` at install and puts that directory on the service PATH. Checking the
 * fixed list alone would call a Nix or Linuxbrew expect missing, and under
 * HOAI_SUPERVISED that is a refusal (expect-missing): an agent kept down on a
 * host where the installer had just found expect.
 * @param {{ platform: string, env?: Record<string, string | undefined>,
 *   exists?: (path: string) => boolean }} input
 * @returns {boolean}
 */
export function hostHasExpect({ platform, env = process.env, exists = existsSync }) {
  if (platform === 'win32') return false
  const onPath = String(env?.PATH ?? '')
    .split(':')
    .filter((dir) => dir.startsWith('/'))
    .map((dir) => `${dir.replace(/\/+$/, '')}/expect`)
  return ['/usr/bin/expect', '/opt/homebrew/bin/expect', '/usr/local/bin/expect', '/bin/expect', ...onPath].some(
    (p) => {
      try {
        return exists(p)
      } catch {
        return false
      }
    },
  )
}

/**
 * Launch claude and supervise it: while the child runs, poll the agent's
 * state dir for a restart-requested.json marker (written by the daemon's
 * update_rpc handler). Marker present: delete it, SIGTERM the child, await
 * its exit, and relaunch with the correct channel flags RESUMING this agent's
 * own pinned session (--resume <id>, never --continue). This is the restart
 * authority for interactive sessions, Windows included, where no launchd/systemd
 * service exists.
 *
 * Guarantees:
 *   - marker CONTENTS are ignored, existence only, so the marker can never
 *     carry commands (and a stale marker from a previous run is consumed
 *     before the first spawn, never acted on);
 *   - a child exit WITHOUT a marker is a normal exit, no relaunch, exactly
 *     today's behavior;
 *   - at most MAX_RELAUNCHES_PER_WINDOW marker relaunches per rolling hour,
 *     then supervision stops (printed) and the session runs on to a normal
 *     exit;
 *   - supervisor.json is written at start and removed on the way out, and
 *     carries this launcher's pid so the daemon can verify liveness.
 * @param {readonly string[]} args
 * @param {{
 *   platform?: string, env?: Record<string, string | undefined>, home?: string,
 *   cwd?: string, scriptDir?: string,
 *   readFile?: (path: string) => string | null,
 *   listDir?: (path: string) => string[],
 *   spawnImpl?: typeof spawn, writeErr?: (text: string) => void,
 *   exists?: (path: string) => boolean,
 *   writeFile?: (path: string, content: string) => boolean,
 *   removeFile?: (path: string) => boolean,
 *   pollMs?: number, now?: () => number, print?: (line: string) => void,
 *   pidAlive?: (pid: number) => boolean,
 *   pidProcess?: (pid: number) => { command: string | null, startedAtMs: number | null } | null,
 *   generateId?: () => string, hasExpect?: boolean,
 *   freshSession?: boolean,
 *   listProcesses?: () => Array<{ pid: number, uid?: number | null, comm: string, cwd: string | null }>,
 *   sleep?: (ms: number) => Promise<void>,
 *   force?: boolean, incumbentTimeoutMs?: number,
 *   healthyMs?: number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   keepAlive?: boolean, signal?: AbortSignal | null,
 *   endProcessTree?: ((pid: number) => boolean) | null,
 *   spawnSyncImpl?: typeof spawnSync,
 *   clearConsole?: () => unknown,
 *   claudeLoginFailure?: () => { at: number, text: string } | null,
 *   claudeLoginBackSince?: (at: number) => boolean,
 * }} [opts]
 * @returns {Promise<number>}
 *
 * keepAlive (`hoai --keep-alive`, design section 4): an exit of claude on its
 * own is no longer the end. After the fresh fallback has had its one chance,
 * claude is relaunched RESUMING the pinned session after decideKeepAliveBackoff
 * says how long to wait, a crash loop is written to launch-status, and
 * supervisor.json is re-written before every relaunch. `signal` is the stop
 * request: once it aborts, the live claude is stopped and nothing is
 * relaunched (main wires SIGTERM and SIGHUP to it for --keep-alive and for a
 * supervised launch). A stop before anything is armed returns at once.
 */
/** Basename of a comm/path, lowercased, without a trailing .exe. */
function commBase(comm) {
  const base = String(comm ?? '').split(/[\\/]/).pop() ?? ''
  return base.toLowerCase().replace(/\.exe$/, '')
}

/** Normalise a cwd for comparison: forward slashes, no trailing slash,
 *  case-insensitive for win32-style paths (drive letter or backslashes). */
function normalizeCwd(p) {
  const s = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-zA-Z]:\//.test(s) || /\\/.test(String(p ?? '')) ? s.toLowerCase() : s
}

/**
 * The caller's own pid plus every ancestor reachable by walking `ppid`, as a
 * Set.
 *
 * It exists because `ownPid` was never enough. hoai and `hoai doctor` are both
 * typed INTO a claude session, so the node process doing the screening has a
 * claude PARENT sitting in exactly the folder being screened. Excluding only
 * our own pid left that parent looking like a same-cwd incumbent: measured live
 * on 2026-09-21, `probeIncumbent({cwd: process.cwd()})` answered
 * {hit:{pid:77299,reason:'same-cwd'},blocks:true} where 77299 was the claude
 * running the probe, so the doctor told the operator to `kill` the session they
 * were typing into, and the launcher waited the full ninety seconds on it and
 * then exited EXIT_INCUMBENT_TIMEOUT naming that same pid.
 *
 * The walk is hostile-input safe by construction: a pid already seen ends it
 * (a ppid cycle, which a reparented process table can show), and so does a
 * parent that is not in the list at all (ps raced us, or the parent already
 * exited). It never loops forever, because that would hang the very probe
 * whose whole job is to not hang.
 * @param {{ processes: Array<{ pid: number, ppid?: number | null }>, pid: number }} input
 * @returns {Set<number>}
 */
export function selfAndAncestorPids({ processes, pid }) {
  const parentOf = new Map()
  for (const p of Array.isArray(processes) ? processes : []) {
    if (!p) continue
    const self = Number(p.pid)
    if (!Number.isFinite(self)) continue
    const parent = Number(p.ppid)
    parentOf.set(self, Number.isFinite(parent) ? parent : null)
  }
  const seen = new Set()
  let cur = Number(pid)
  // `seen.has(cur)` is the cycle brake; `parent == null` is the missing-parent
  // brake. pid 0 is the kernel's placeholder for "no parent", never a process.
  while (Number.isFinite(cur) && cur > 0 && !seen.has(cur)) {
    seen.add(cur)
    const parent = parentOf.get(cur)
    if (parent == null) break
    cur = parent
  }
  return seen
}

/**
 * The incumbent check the singleton guard never had (board row 01a06223,
 * Poseidon 2026-09-02). decideSupervisorArming keys on supervisor.json, a
 * live LAUNCHER; a claude started by hand in the same folder was invisible to
 * it, so a KeepAlive around hoai beside such a session spawned a second claude
 * on the same pinned id. Three rules, each learned by hitting it:
 *   - the process list comes from ps, never pgrep (macOS pgrep omits the
 *     caller's own ancestors, so a session screening its own folder never
 *     sees itself);
 *   - only our own uid is in scope (only that uid can resume the pin), so
 *     another user's agent in an identical path is not ours to wait for;
 *   - within our uid an UNREADABLE cwd is REPORTED but no longer counts as
 *     occupied (2026-09-21). The rule used to be the opposite ("fail toward
 *     waiting, never toward a double launch"), and it stranded a real first
 *     install: one claude under the same uid whose cwd lsof would not show
 *     made every hoai launch wait forever, reprinting a notice every thirty
 *     seconds, on a machine with no conflict at all. An unreadable cwd is not
 *     evidence of a conflict, only an absence of evidence, so the hit is
 *     surfaced as a WARNING (see incumbentBlocks / waitForIncumbent) and the
 *     launch proceeds. A genuine same-cwd process is still a hard block.
 * A same-cwd hit WINS over an unreadable one, whatever order ps lists them in:
 * returning the first unreadable process would hide the real incumbent behind
 * it and hand back exactly the double launch this check exists to prevent.
 *
 * `ignorePids` is the fourth rule, added 2026-09-21: a caller that is itself
 * running INSIDE a claude session passes its own ancestry (see
 * selfAndAncestorPids), because that session is the caller, not a rival for
 * the pin. Without it both callers indicted their own parent: the doctor
 * printed a fix line saying to kill the pid the operator was typing into, and
 * the launcher waited ninety seconds on it and gave up. `ownPid` keeps working
 * exactly as before and is simply the degenerate one-pid case of the same idea.
 * @param {{ processes: Array<{ pid: number, ppid?: number | null, uid?: number | null, comm: string, cwd: string | null }>,
 *   cwd: string, uid?: number | null, ownPid: number,
 *   ignorePids?: Iterable<number> | null }} input
 * @returns {{ pid: number, reason: 'same-cwd' | 'unreadable-cwd' } | null}
 */
export function findIncumbentClaude({ processes, cwd, uid, ownPid, ignorePids = [] }) {
  const target = normalizeCwd(cwd)
  // Guarded the same way `processes` below it is: this is a pure decision
  // surface and every caller injects, so a list that is missing or malformed
  // has to mean "ignore nothing" rather than throw inside the launch path.
  const ignored =
    ignorePids instanceof Set
      ? ignorePids
      : new Set(typeof ignorePids?.[Symbol.iterator] === 'function' ? ignorePids : [])
  let unreadable = null
  for (const p of Array.isArray(processes) ? processes : []) {
    if (!p || p.pid === ownPid || ignored.has(p.pid)) continue
    if (commBase(p.comm) !== 'claude') continue
    if (uid != null && p.uid != null && p.uid !== uid) continue
    if (p.cwd == null) {
      if (!unreadable) unreadable = { pid: p.pid, reason: 'unreadable-cwd' }
      continue
    }
    if (normalizeCwd(p.cwd) === target) return { pid: p.pid, reason: 'same-cwd' }
  }
  return unreadable
}

/**
 * Does a findIncumbentClaude hit justify holding a launch back? Only a
 * 'same-cwd' hit does: that process demonstrably sits in this folder and a
 * pinned session can only be resumed once. An 'unreadable-cwd' hit is an
 * unknown, not a conflict, and treating unknown as occupied is what left a
 * first install waiting forever (2026-09-21). The two callers that matter,
 * the launch wait and the doctor row, must agree on this verdict, so it lives
 * here rather than being spelled out at each of them.
 * @param {{ pid: number, reason: 'same-cwd' | 'unreadable-cwd' } | null | undefined} hit
 * @returns {boolean}
 */
export function incumbentBlocks(hit) {
  return hit?.reason === 'same-cwd'
}

/** How long a launch waits for a blocking incumbent before it gives up and
 *  says so. Ninety seconds is long enough for a session being closed by hand
 *  ("/exit, then run hoai") and short enough that an operator gets an answer
 *  instead of a terminal that never returns. Overridable per call (timeoutMs)
 *  because the tests must not spend real seconds. */
export const INCUMBENT_WAIT_TIMEOUT_MS = 90_000

/**
 * The message printed instead of launching when the incumbent wait times out.
 * It names the pid and what to do about it, and it claims nothing it has not
 * established: hoai saw a process that looks like this folder's claude, which
 * on a recycled pid can be something else entirely, so "confirm before you
 * kill it" is part of the instruction, exactly as in the already-supervised
 * refusal.
 * @param {{ pid: number | null, cwd: string, waitedMs?: number }} input
 * @returns {string}
 */
export function incumbentTimeoutMessage({ pid, cwd, waitedMs = INCUMBENT_WAIT_TIMEOUT_MS }) {
  const seconds = Math.max(1, Math.round(Number(waitedMs) / 1000))
  return (
    `[hoai] STOPPING rather than launching: another claude (pid ${pid}) still looks like it ` +
    `owns ${cwd} after waiting ${seconds}s for it to exit, and a pinned session can only be ` +
    `resumed once. Inspect it with \`ps -p ${pid}\`, and stop it with \`kill ${pid}\` only ` +
    'after confirming it really is this agent (a reused pid could be an unrelated process). ' +
    'To launch anyway without waiting at all, run `hoai --force`.'
  )
}

/**
 * Wait until no BLOCKING incumbent claude owns `cwd` (see findIncumbentClaude
 * and incumbentBlocks). Prints once at the start and then about every thirty
 * seconds, so an operator at the terminal knows why hoai is not launching, and
 * gives up at `timeoutMs` rather than waiting out the user's whole afternoon:
 * an endless wait is indistinguishable from a hang, and that is how it was
 * reported (2026-09-21). A non-blocking unreadable-cwd hit prints one WARNING
 * naming the pid and does not hold the launch. The clock, the timers and the
 * process list are injected so tests are deterministic and never sleep.
 * `ignorePids` is forwarded to findIncumbentClaude unchanged, so a launcher
 * started from inside a claude session can hand over its own ancestry and not
 * spend ninety seconds waiting for the session that is running it (2026-09-21).
 * `stopped` ends the wait the moment the launch is asked to stop (the service
 * stopping an unattended launch), so a stop is never held for the full wait.
 * @param {{ cwd: string, uid?: number | null, ownPid: number,
 *   listProcesses: () => Array<{ pid: number, ppid?: number | null, uid?: number | null, comm: string, cwd: string | null }>,
 *   sleep: (ms: number) => Promise<void>, print: (line: string) => void,
 *   pollMs?: number, now?: () => number, timeoutMs?: number,
 *   ignorePids?: Iterable<number> | null, stopped?: () => boolean }} input
 * @returns {Promise<{ waited: boolean, polls: number, lastPid: number | null, timedOut: boolean, stopped?: true }>}
 */
export async function waitForIncumbent({
  cwd,
  uid,
  ownPid,
  listProcesses,
  sleep,
  print,
  pollMs = 1000,
  now = Date.now,
  timeoutMs = INCUMBENT_WAIT_TIMEOUT_MS,
  ignorePids = [],
  stopped = () => false,
}) {
  let polls = 0
  let lastPid = null
  let lastPrintPoll = -Infinity
  let warnedUnreadable = false
  const startedAt = now()
  const limit = Math.max(0, Number(timeoutMs))
  const printEvery = Math.max(1, Math.round(30_000 / Math.max(1, pollMs)))
  while (true) {
    // Asked to stop (the service is stopping this launch): the caller arms
    // nothing, so there is nothing left to wait for.
    if (stopped()) return { waited: polls > 1, polls, lastPid, timedOut: false, stopped: true }
    polls += 1
    const hit = findIncumbentClaude({ processes: listProcesses(), cwd, uid, ownPid, ignorePids })
    if (hit && !incumbentBlocks(hit) && !warnedUnreadable) {
      warnedUnreadable = true
      print(
        `[hoai] WARNING: another claude of yours (pid ${hit.pid}) is running and its working ` +
          `directory could not be read, so hoai cannot tell whether it is in ${cwd}. Launching ` +
          'anyway, because an unreadable directory is not evidence of a conflict. If this agent ' +
          `ends up with two live sessions, check that pid with \`ps -p ${hit.pid}\` and stop one.`,
      )
    }
    if (!incumbentBlocks(hit)) return { waited: polls > 1, polls, lastPid, timedOut: false }
    lastPid = hit.pid
    if (now() - startedAt >= limit) return { waited: polls > 1, polls, lastPid, timedOut: true }
    if (polls - lastPrintPoll >= printEvery) {
      lastPrintPoll = polls
      print(
        `[hoai] waiting for an incumbent claude (pid ${hit.pid}) in ${cwd} to exit before ` +
          'taking over; a pinned session can only be resumed once',
      )
    }
    await sleep(pollMs)
  }
}

/** How long `ps` and each `lsof` get before the incumbent probe gives up on
 *  them. Neither command has a deadline of its own, and `lsof -p <pid> -d cwd`
 *  blocks INDEFINITELY when any mount on the host is wedged (a dead NFS or
 *  FUSE server is the classic one). Unbounded, that made `hoai doctor` inherit
 *  the very hang it exists to diagnose: it printed not one row, and the
 *  bootstrap preflight stalled with no output at all (2026-09-21). Two seconds
 *  is far longer than either command needs on a healthy host, and a probe that
 *  times out simply leaves that process's cwd null, which since 2026-09-21 is
 *  the SAFE direction: an unreadable cwd is reported and no longer blocks a
 *  launch (see incumbentBlocks). */
export const PROCESS_PROBE_TIMEOUT_MS = 2_000

/** Posix process list for the incumbent check: `ps -Axo pid=,ppid=,uid=,comm=`,
 *  then the cwd of every claude through lsof (null when unreadable).
 *
 *  Two things beyond "every claude" are in the list on purpose.
 *
 *  ppid, so a caller can exclude its own claude ancestry (selfAndAncestorPids);
 *  without it the launcher and the doctor both indicted the session they were
 *  running inside (2026-09-21).
 *
 *  And the caller's OWN ancestry rows, claude or not. The chain from a `hoai`
 *  typed into a claude session runs node -> zsh -> claude -> tmux -> launchd:
 *  a claude-only list cannot bridge the shell in the middle, so the ancestry
 *  walk stopped at the node process and the claude parent was still reported
 *  as a blocking incumbent (measured that way on 2026-09-21 after ppid alone
 *  had been added). These extra rows cost nothing to the readers: every caller
 *  runs them through findIncumbentClaude, which keeps only comm === claude.
 *
 *  win32 returns an empty list in this phase: the fleet's Windows switch script
 *  kills the tmux claude before starting hoai, and a cwd probe for another
 *  process there is a different tool (documented on board row 01a06223).
 *  `spawn` and `selfPid` are injected only so the tests can drive the parse,
 *  the ancestry and the timeouts without a real ps or a real wedged mount.
 *  @param {string} [platform]
 *  @param {{ spawn?: typeof spawnSync, timeoutMs?: number, selfPid?: number }} [opts] */
export function defaultListProcesses(platform = process.platform, opts = {}) {
  if (platform === 'win32') return []
  const run = opts.spawn ?? spawnSync
  const timeout = opts.timeoutMs ?? PROCESS_PROBE_TIMEOUT_MS
  const selfPid = opts.selfPid ?? process.pid
  try {
    const ps = run('ps', ['-Axo', 'pid=,ppid=,uid=,comm='], { encoding: 'utf8', timeout })
    // A timed-out spawnSync reports status null, which this already rejects.
    if (ps.status !== 0 || !ps.stdout) return []
    const all = []
    for (const line of ps.stdout.split('\n')) {
      // Four fields now, and comm stays the trailing catch-all because a
      // command name may legitimately contain spaces ("Google Chrome Helper").
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
      if (!m) continue
      all.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), comm: m[4].trim(), cwd: null })
    }
    const ancestry = selfAndAncestorPids({ processes: all, pid: selfPid })
    const out = []
    for (const p of all) {
      const isClaude = commBase(p.comm) === 'claude'
      if (!isClaude && !ancestry.has(p.pid)) continue
      // lsof is only asked about claude: nothing else can be an incumbent, and
      // every probe skipped is a probe that cannot wedge.
      if (isClaude) {
        try {
          const lsof = run('lsof', ['-a', '-p', String(p.pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout })
          // A killed-on-timeout lsof leaves no usable 'n' line, so cwd stays
          // null: unreadable, which warns rather than blocking.
          const n = String(lsof?.stdout ?? '').split('\n').find((l) => l.startsWith('n'))
          if (n) p.cwd = n.slice(1)
        } catch {
          p.cwd = null
        }
      }
      out.push(p)
    }
    return out
  } catch {
    return []
  }
}

export async function superviseClaude(args, opts = {}) {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const cwd = opts.cwd ?? process.cwd()
  const scriptDir = opts.scriptDir ?? ''
  const readFile = opts.readFile ?? defaultReadText
  const listDir = opts.listDir ?? defaultListDir
  const spawnImpl = opts.spawnImpl ?? spawn
  const writeErr = opts.writeErr ?? ((text) => process.stderr.write(text))
  const exists = opts.exists ?? existsSync
  const writeFile = opts.writeFile ?? defaultWriteFile
  const removeFile = opts.removeFile ?? defaultRemoveFile
  const pollMs = opts.pollMs ?? MARKER_POLL_MS
  const now = opts.now ?? Date.now
  const print = opts.print ?? ((line) => console.log(line))
  const pidAlive = opts.pidAlive ?? defaultPidAlive
  const pidProcess = opts.pidProcess ?? ((pid) => defaultPidProcess(pid, platform, { readFile }))
  // The boot clock every supervisor.json stamp carries (review 3 F1), read
  // through the same reader as everything else here; null off Linux.
  const bootClock = opts.bootClock ?? (() => readBootClock({ platform, readFile }))
  // Taking over a holder that supervises nothing (decideSupervisorArming). The
  // real process table and the real kill only go together with the real pid
  // readers: a test that fakes a pid never has a real process read or signalled
  // under that number.
  const realPids = opts.pidAlive === undefined && opts.pidProcess === undefined
  const holderChildren = opts.holderChildren ?? (realPids ? (pid) => readChildProcesses({ platform, pid }) : () => null)
  const holderInFolder = opts.holderInFolder ?? (realPids ? (pid) => defaultHolderInFolder(pid, platform, cwd) : () => true)
  const signalPid =
    opts.signalPid ??
    (realPids && opts.holderChildren === undefined
      ? (pid, signal) => {
          try {
            process.kill(pid, signal)
            return true
          } catch {
            return false
          }
        }
      : () => false)
  const createExclusive =
    opts.createExclusive ??
    (opts.writeFile ? (path, content) => (exists(path) ? 'exists' : writeFile(path, content) ? 'created' : 'failed') : defaultCreateExclusive)
  // The launcher's own watchdog (lib/launcher-liveness.mjs). Only over a real
  // claude: a child from an injected spawn is no process it could look at.
  const startWatchdog = opts.startWatchdog ?? (spawnImpl === spawn ? startLauncherWatchdog : () => null)
  const takeoverConfirmMs = opts.takeoverConfirmMs ?? TAKEOVER_CONFIRM_MS
  const takeoverPollMs = opts.takeoverPollMs ?? TAKEOVER_POLL_MS
  const takeoverTermWaitMs = opts.takeoverTermWaitMs ?? TAKEOVER_TERM_WAIT_MS
  const takeoverKillWaitMs = opts.takeoverKillWaitMs ?? TAKEOVER_KILL_WAIT_MS
  const mtimeMs = opts.mtimeMs ?? fileMtimeMs
  const generateId = opts.generateId ?? randomUUID
  const hasExpect = opts.hasExpect ?? hostHasExpect({ platform, env, exists: opts.expectExists ?? existsSync })
  const freshSession = opts.freshSession === true
  const healthyMs = opts.healthyMs ?? RELAUNCH_HEALTHY_MS
  const setTimer = opts.setTimer ?? setTimeout
  const clearTimer = opts.clearTimer ?? clearTimeout
  const listProcesses = opts.listProcesses ?? (() => defaultListProcesses(platform))
  const force = opts.force === true
  const incumbentTimeoutMs = opts.incumbentTimeoutMs ?? INCUMBENT_WAIT_TIMEOUT_MS
  const probeIdentityFlag = opts.probeIdentityFlag ?? (() => defaultProbeIdentityFlag({ platform, env }))
  const keepAlive = opts.keepAlive === true
  const stopSignal = opts.signal ?? null
  // Has the Claude login every agent of this credential store shares failed? Asked only for a launch
  // with no channel heartbeat: the CLI's own records, in the store it signs in through.
  const loginStore = { configDir: claudeConfigDir({ env, home }), listDir, mtimeMs: fileMtimeMs, readTail: (path) => readFileTail(path, LOGIN_TAIL_BYTES) }
  const claudeLoginFailure = opts.claudeLoginFailure ?? (() => fleetClaudeLoginFailure({ ...loginStore, now: now() }))
  // Has the login come back since a failure: a sign-in after it, or an agent's answer after it.
  const claudeLoginBackSince =
    opts.claudeLoginBackSince ??
    ((at) => claudeSignedInSince({ ...loginStore, since: at }) || fleetClaudeLoginAnswered({ ...loginStore, since: at }))
  // The shared login failure an alert was made for: it stands, across relaunches too, until the
  // login comes back after it.
  let loginFailure = null
  // Nobody at the terminal (bin/bgos-agent run.sh v2): see SUPERVISED_ENV.
  const supervised = isSupervisedLaunch(env)
  // In tmux the launcher has a terminal and relays it; under launchd with no
  // tmux stdin is /dev/null (see buildGateAutoAcceptExpect).
  const stdinIsTTY = opts.stdinIsTTY ?? Boolean(process.stdin?.isTTY)
  // Set once the agent's state dir is known; the supervised expect tail writes
  // launch-status there and reads run.sh's fail count from it.
  let supervisedStateDir = ''
  // Every wait here (the incumbent wait, the keep-alive backoff) ends early on a
  // stop request: a launcher told to stop must not sit out a 60 s timer first
  // (and a ref'd timer would hold the process open for that long). An injected
  // sleep (tests) is used as given.
  const sleep =
    opts.sleep ??
    ((ms) =>
      new Promise((resolve) => {
        if (stopSignal?.aborted) return resolve()
        let handle = null
        const done = () => {
          if (handle !== null) clearTimer(handle)
          stopSignal?.removeEventListener?.('abort', done)
          resolve()
        }
        stopSignal?.addEventListener?.('abort', done, { once: true })
        handle = setTimer(done, ms)
      }))

  // Ending claude for a relaunch or a stop. On Windows the claude under the shim too, not the shim
  // alone (endWin32ShimTree: the cmd.exe of the npm shim left the real claude running), and never
  // deeper (what the daemon detached lives on). Only a claude node's own spawn started and whose exit
  // is not recorded yet, so its pid is still its own: a child from an injected spawn (a test's fake)
  // is ended by its own kill(), never by a kill aimed at a made up pid that may be anyone's.
  const endProcessTree =
    opts.endProcessTree ??
    (platform === 'win32' && spawnImpl === spawn ? (pid) => endWin32ShimTree(pid, { spawnSyncImpl: opts.spawnSyncImpl ?? spawnSync, env }) : null)
  // Only the npm shim hides claude: a native claude.exe is ended by its own kill(), its children with
  // its job as on main, and pays for no listing.
  const shimFile = String(env.ComSpec ?? env.COMSPEC ?? '').trim() || 'cmd.exe'
  const endClaude = (child) => {
    if (platform === 'win32' && endProcessTree && child.spawnfile === shimFile && child.exitCode == null && child.signalCode == null) {
      if (endProcessTree(child.pid)) return
      print(`[hoai] could not list the processes under claude (pid ${child.pid}); ending that process alone`)
    }
    child.kill()
  }

  // GAP 2: a clone (dev) launch shows the dev-channels confirm prompt at
  // (re)start; an unattended supervised launch strands on it. When expect is
  // available, spawn claude under it and auto-accept the gate (mirror of the
  // fleet's run.expect); otherwise spawn directly and warn once.
  let warnedGate = false
  const spawnGateHelper = opts.spawnGateHelper ?? defaultSpawnGateHelper
  const clearConsole = opts.clearConsole ?? (() => clearWin32Console(process.stdout))
  let spawnsSoFar = 0
  const spawnSupervised = (spawnArgs, onSpawn, onGateHelperExit) => {
    const relaunch = spawnsSoFar > 0
    spawnsSoFar += 1
    const method = relaunchInstallMethod({ scriptDir, env, home })
    // Built at every spawn: main() adds the plan's env before the first one.
    const childEnv = childEnvWithoutSupervision(env, platform)
    // Supervised, the gate is handled whatever detection says: every launch
    // carries the dev-channels flag, so the warning shows on every launch, and
    // an 'unknown' method (a workspace .mcp.json beside an npx root) would
    // otherwise hand claude a screen nobody will ever answer.
    if (supervised || relaunchNeedsGateAutoAccept(method)) {
      if (platform === 'win32') {
        // No expect on Windows: claude gets the console, and a hidden helper
        // attached to that same console accepts the gate once it is on screen.
        // A relaunch shares this console with the claude it replaced, which has
        // ended by now, and a killed claude leaves its last screen behind (the
        // gate in the alternate screen buffer included). The new helper reads the
        // screen seconds before the new claude draws anything, so a gate left
        // there got this launch's one Enter and the new gate none (board row
        // 978da5db, measured with a fake claude). Cleared first, screen and
        // scrollback, hoai's own lines about the relaunch included; never before
        // the first launch, so what a person had on screen before hoai is kept.
        if (relaunch) clearConsole()
        const exited = spawnClaude(spawnArgs, { platform, env, spawnImpl, writeErr, onSpawn, childEnv })
        try {
          const helper = spawnGateHelper({ scriptDir, consolePid: process.pid, spawnImpl, writeErr, home })
          print(`[hoai] dev-channels gate helper armed (helper pid ${helper?.pid ?? '?'}, console ${process.pid})`)
          // Its exit code says whether the gate is PROVEN answered (WIN32_GATE_EXIT_UNPROVEN).
          helper?.on?.('exit', (code) => onGateHelperExit?.(code))
        } catch (err) {
          writeErr(`[hoai] could not start the dev-channels gate helper: ${err?.message ?? err}\n`)
        }
        return exited
      }
      if (hasExpect) {
        const script = buildGateAutoAcceptExpect({
          claudePath: 'claude',
          args: spawnArgs,
          supervised:
            supervised && supervisedStateDir
              ? { stateDir: supervisedStateDir, interactive: stdinIsTTY, compact: compactStatus(env) }
              : null,
        })
        return spawnExpectScript(script, { spawnImpl, writeErr, onSpawn, childEnv })
      }
      if (!warnedGate) {
        warnedGate = true
        writeErr(
          '[hoai] this restart may block on the dev-channels confirmation prompt, and ' +
            'no `expect` was found to auto-accept it. Install expect (e.g. brew install ' +
            'expect, or apt install expect) so unattended restarts can pass the gate.\n',
        )
      }
    }
    return spawnClaude(spawnArgs, { platform, env, spawnImpl, writeErr, onSpawn, childEnv })
  }

  const resolvedId = superviseAssistantId({ cwd, env, home, readFile, listDir })
  // The agent the SERVICE was installed for. It fills in for a folder that
  // declares nothing (finding 7: the pin must still be this agent's), and it
  // must agree with a folder that does declare one.
  const serviceId = supervised ? supervisedServiceId(env) : ''
  if (resolvedId && serviceId && resolvedId !== serviceId) {
    writeFile(
      joinDir(joinDir(agentDir(home), serviceId), LAUNCH_STATUS_FILE_NAME),
      `${launchStatusLine({ outcome: 'identity-mismatch', fields: { folder: resolvedId, service: serviceId }, at: new Date(now()) })}\n`,
    )
    print(
      `[hoai] STOPPING (identity-mismatch): this service was installed for agent ${serviceId}, but ${cwd} ` +
        `is agent ${resolvedId}. Launching would start agent ${resolvedId} under a supervisor that believes ` +
        `it runs ${serviceId}. Reinstall the service with the folder that belongs to agent ${serviceId}.`,
    )
    return EXIT_SUPERVISED_IDENTITY_MISMATCH
  }
  const id = resolvedId || serviceId
  if (!id) {
    // No identity, so no pin, so every relaunch of a keep-alive loop would be a
    // brand NEW conversation (finding 7, the exact defect that made Ava add
    // --resume by hand). Unattended, the honest answer is to stop and say so.
    if (keepAlive || supervised) {
      print(
        '[hoai] STOPPING (identity-unknown): an unattended launch needs to know which agent this folder is, ' +
          'so that every relaunch resumes that agent\'s own conversation. This folder has no ' +
          `${FOLDER_PIN_FILE} pin and no BGOS_ASSISTANT_ID, and this host has no single paired agent. ` +
          'Pair this folder first (hoai pair <CODE>), then start it again.',
      )
      return EXIT_UNATTENDED_NEEDS_PERSON
    }
    return spawnSupervised(args)
  }
  const stateDir = joinDir(agentDir(home), id)
  const supervisorPath = joinDir(stateDir, SUPERVISOR_FILE_NAME)
  const markerPath = joinDir(stateDir, RESTART_MARKER_FILE_NAME)
  // How this agent's most recent launch went, for `hoai-agent status`, the
  // WEDGED line and the watcher. Only an unattended launch writes it: a person
  // at a terminal reads the same words on screen.
  const noteStatus = (outcome, fields = {}) => {
    if (!keepAlive && !supervised) return
    writeFile(
      joinDir(stateDir, LAUNCH_STATUS_FILE_NAME),
      `${launchStatusLine({ outcome, fields, at: new Date(now()) })}\n`,
    )
  }
  if (supervised) supervisedStateDir = stateDir
  // Nobody at the terminal: the launches noteStatus reports on, and the only ones hoai relaunches
  // for a gate that is not proven answered or a channel that never sent a heartbeat (board row
  // d806c69f). A person at the terminal sees the screen and is never relaunched under.
  const unattended = keepAlive || supervised
  // The channel's heartbeat: the beacon the daemon touches while it delivers (lib/pairing-lock.ts).
  const beaconPath = joinDir(pluginStateDirFor({ env, home, assistantId: id, cwd }), BEACON_HEARTBEAT_FILE_NAME)
  // A launch with no channel heartbeat CHANNEL_HEARTBEAT_WAIT_MS after it started is relaunched
  // ONCE; the next one is reported and left running. A launch that does send one earns it back.
  let heartbeatRelaunchSpent = false
  // Supervised on posix, the startup gates are answered under expect or not at
  // all. Without it claude would sit on the dev-channels warning (shown on
  // every launch) with nobody there: alive to the service, deaf to the owner.
  if (supervised && platform !== 'win32' && !hasExpect) {
    noteStatus('expect-missing')
    print(
      '[hoai] STOPPING (expect-missing): this agent runs unattended and Claude Code shows a startup ' +
        'screen on every launch; hoai answers it under expect, and no expect was found. Install it ' +
        '(macOS ships it; on Linux: apt install expect), and the agent starts on its next lap.',
    )
    return EXIT_SUPERVISED_NO_EXPECT
  }
  // A relaunch whose channel no longer resolves stops loudly (see
  // unresolvedChannelMessage); unattended, the reason also goes to launch-status.
  const stopUnresolved = () => {
    const resolution = resolveChannelSpec({ cwd, env, home, readFile, scriptDir })
    noteStatus('channel-unresolved', { detail: String(resolution.reason ?? '').trim() || 'undetermined' })
    print(unresolvedChannelMessage(resolution))
    return EXIT_CHANNEL_UNRESOLVED
  }
  // Incumbent wait: never start a second session beside a claude that already
  // owns this folder, supervised or not (a hand-started one is invisible to the
  // supervisor.json guard below). See findIncumbentClaude for the rules.
  //
  // --force skips the check ENTIRELY rather than waiting zero milliseconds: the
  // user typed it to launch now, so there is no notice to print and no process
  // list to consult. It is the answer to a wait that cannot be right in every
  // case, because ps and lsof are all it has to go on.
  if (force) {
    print(
      '[hoai] --force: launching without waiting for any other claude in this folder, as asked. ' +
        'If another session is live here, both are now resuming the same pinned id.',
    )
  } else {
    // Our own claude PARENT is not a rival for the pin, it is the terminal the
    // operator typed `hoai` into. Excluding only process.pid left the launcher
    // waiting the full ninety seconds on that session and then exiting
    // EXIT_INCUMBENT_TIMEOUT with its pid in the message, telling the user to
    // kill the window they were sitting in (measured live 2026-09-21, pid
    // 77299 in its own cwd). The ancestry is read once: it cannot change under
    // us in a way that matters, since an ancestor that exits is gone anyway.
    const ignorePids = selfAndAncestorPids({ processes: listProcesses(), pid: process.pid })
    const incumbent = await waitForIncumbent({
      cwd,
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      ownPid: process.pid,
      listProcesses,
      sleep,
      print,
      pollMs: Math.max(pollMs, 250),
      now,
      timeoutMs: incumbentTimeoutMs,
      ignorePids,
      stopped: () => stopSignal?.aborted === true,
    })
    // Giving up is an outcome, not a hang: say which pid, how to look at it and
    // how to launch anyway, then hand back a code a wrapper can act on.
    if (incumbent.timedOut) {
      noteStatus('incumbent-timeout', { pid: incumbent.lastPid ?? 'unknown' })
      print(incumbentTimeoutMessage({ pid: incumbent.lastPid, cwd, waitedMs: incumbentTimeoutMs }))
      return EXIT_INCUMBENT_TIMEOUT
    }
    // A wait ended by a stop request took nothing over: the incumbent may well still be there.
    if (incumbent.waited && !incumbent.stopped) {
      print(`[hoai] the incumbent claude (pid ${incumbent.lastPid}) has exited; taking over assistant ${id}`)
    }
  }
  // A stop that came before anything was armed (main wires SIGTERM and SIGHUP
  // to it for an unattended launch): nothing to clean up, nothing to start.
  if (stopSignal?.aborted) return exitCodeForChild(null, 'SIGTERM')
  // -- Claiming the agent: supervisor.json (board row fabeef45) ---------------
  // 'armed', 'unarmed' (nowhere to write it), or the exit code of a refusal.
  // A claim that is absent is created exclusively. One that is there (stale,
  // or naming a holder that supervises nothing) is replaced under the takeover
  // lock, judged again under it, so of two launchers only one ever arms.
  const takeoverLockPath = `${supervisorPath}${TAKEOVER_LOCK_SUFFIX}`
  const armBody = () => supervisorFileBody(process.pid, new Date(now()).toISOString(), bootClock())
  // The claim as the last judgement read it: it is replaced only while it still says that.
  let judgedRaw = null
  const decideArmingNow = () => {
    judgedRaw = readFile(supervisorPath)
    return decideSupervisorArming({ existingRaw: judgedRaw, ownPid: process.pid, pidAlive, pidProcess, holderChildren, holderInFolder, now: now() })
  }
  const refuseOwned = (ownerPid) => {
    noteStatus('already-supervised', { owner: ownerPid })
    print(
      `[hoai] assistant ${id} is already supervised by a live launcher (pid ${ownerPid}). ` +
        'Not starting a second session. If that launcher is actually stale, remove ' +
        `${supervisorPath} and re-run hoai; only stop pid ${ownerPid} after confirming ` +
        'it really is this agent (a reused pid could be an unrelated process).',
    )
    return EXIT_ALREADY_SUPERVISED
  }
  const ownerNow = () => parseSupervisorRecord(readFile(supervisorPath))?.pid ?? 'unknown'
  const standDown = (ownerPid) => {
    noteStatus('takeover-in-progress', { owner: ownerPid ?? 'none' })
    print(`[hoai] another launcher is taking assistant ${id} over right now (${takeoverLockPath}); not starting a second session`)
    return EXIT_ALREADY_SUPERVISED
  }
  // The takeover lock: {pid, startedAt}. One left empty, unreadable, by a
  // launcher that is gone, or older than any takeover takes, is stale.
  const takeoverLockIsStale = (raw) => {
    let lock
    try {
      lock = JSON.parse(String(raw ?? ''))
    } catch {
      return true
    }
    const at = typeof lock?.startedAt === 'string' ? Date.parse(lock.startedAt) : Number.NaN
    if (!Number.isInteger(lock?.pid) || lock.pid <= 0 || lock.pid === process.pid || !Number.isFinite(at)) return true
    return !pidAlive(lock.pid) || Math.abs(now() - at) > TAKEOVER_LOCK_STALE_MS
  }
  const lockIsOurs = () => {
    try {
      return JSON.parse(String(readFile(takeoverLockPath) ?? ''))?.pid === process.pid
    } catch {
      return false
    }
  }
  // 'ours', 'held' (another launcher's), or 'failed' (it cannot be made here:
  // no folder, a read-only or full disk).
  const takeTakeoverLock = () => {
    const body = JSON.stringify({ pid: process.pid, startedAt: new Date(now()).toISOString() })
    for (let attempt = 0; attempt < 2; attempt++) {
      const made = createExclusive(takeoverLockPath, body)
      if (made === 'failed') return 'failed'
      // Two launchers that both removed a stale lock: only the one named in it
      // goes on (the lib/restart-handoff.mjs pattern).
      if (made === 'created') return lockIsOurs() ? 'ours' : 'held'
      if (!takeoverLockIsStale(readFile(takeoverLockPath))) return 'held'
      removeFile(takeoverLockPath)
    }
    return 'held'
  }
  // true: gone, or no longer that launcher (a zombie's command line is not
  // hoai's), or the claim released. false: still there after `ms`. null: this
  // launcher was told to stop meanwhile.
  const waitReleased = async (owner, ms) => {
    const until = now() + ms
    while (true) {
      if (stopSignal?.aborted) return null
      if (!pidAlive(owner) || decideArmingNow().arm) return true
      if (now() >= until) return false
      await sleep(Math.min(250, ms))
    }
  }
  // End a holder proven to supervise nothing: SIGTERM, then SIGKILL when it
  // is still that idle launcher after the TERM wait (agent 867's ignored TERM).
  const endIdleHolder = async (owner, reason) => {
    const why = reason === 'claude-zombie' ? 'its claude has exited and was never reaped' : 'it has no claude'
    print(`[hoai] launcher pid ${owner} holds assistant ${id} but supervises nothing (${why}); ending it with SIGTERM`)
    signalPid(owner, 'SIGTERM')
    const afterTerm = await waitReleased(owner, takeoverTermWaitMs)
    if (afterTerm !== false) return afterTerm ? 'SIGTERM' : 'stopped'
    const still = decideArmingNow()
    if (!(still.takeover && still.ownerPid === owner)) return still.arm ? 'SIGTERM' : 'refused'
    print(`[hoai] launcher pid ${owner} ignored SIGTERM; ending it with SIGKILL`)
    signalPid(owner, 'SIGKILL')
    const afterKill = await waitReleased(owner, takeoverKillWaitMs)
    if (afterKill !== false) return afterKill ? 'SIGKILL' : 'stopped'
    return 'unkillable'
  }
  const claimSupervision = async () => {
    const verdict = decideArmingNow()
    if (verdict.arm) {
      const made = createExclusive(supervisorPath, armBody())
      if (made !== 'exists') return made === 'created' ? 'armed' : 'unarmed'
    } else if (!verdict.takeover) {
      return refuseOwned(verdict.ownerPid)
    }
    const lock = takeTakeoverLock()
    if (lock === 'failed') {
      // No lock can be made here: no live holder is ended without one, and a
      // stale claim is replaced as it always was, while it still says what was
      // judged (one another launcher armed meanwhile is theirs).
      if (!verdict.arm) return refuseOwned(verdict.ownerPid)
      if (judgedRaw === null || readFile(supervisorPath) !== judgedRaw) return refuseOwned(ownerNow())
      return writeFile(supervisorPath, armBody()) ? 'armed' : 'unarmed'
    }
    if (lock === 'held') return standDown(verdict.ownerPid)
    try {
      let again = decideArmingNow()
      if (again.takeover) {
        // Idle for the whole window, read every poll: a launcher between two
        // children has one again within a second, and is never signalled.
        const owner = again.ownerPid
        const until = now() + takeoverConfirmMs
        while (again.takeover && again.ownerPid === owner && now() < until) {
          await sleep(takeoverPollMs)
          if (stopSignal?.aborted) return exitCodeForChild(null, 'SIGTERM')
          again = decideArmingNow()
        }
        if (again.takeover && again.ownerPid === owner) {
          const ended = await endIdleHolder(owner, again.reason)
          if (ended === 'stopped') return exitCodeForChild(null, 'SIGTERM')
          if (ended === 'unkillable') {
            noteStatus('stale-launcher-unkillable', { owner })
            print(
              `[hoai] launcher pid ${owner} supervises nothing and is still there after SIGKILL; not starting a second ` +
                `session beside it. Its owner (or a reboot) has to end it, then the agent starts on its next launch.`,
            )
            return EXIT_ALREADY_SUPERVISED
          }
          if (ended !== 'refused') {
            noteStatus('took-over', { owner, reason: again.reason, signal: ended })
            print(`[hoai] took over assistant ${id} from launcher pid ${owner} (${ended})`)
          }
          again = decideArmingNow()
        }
      }
      if (!again.arm) return refuseOwned(again.ownerPid)
      // Released meanwhile: created exclusively, as for no claim at all.
      if (judgedRaw === null) {
        const made = createExclusive(supervisorPath, armBody())
        if (made === 'exists') return refuseOwned(ownerNow())
        return made === 'created' ? 'armed' : 'unarmed'
      }
      // Replaced only while the lock is still ours and the claim still says
      // what was judged stale: a launcher that armed meanwhile keeps its claim.
      if (!lockIsOurs()) return standDown(again.ownerPid)
      if (readFile(supervisorPath) !== judgedRaw) return refuseOwned(ownerNow())
      return writeFile(supervisorPath, armBody()) ? 'armed' : 'unarmed'
    } finally {
      if (lockIsOurs()) removeFile(takeoverLockPath)
    }
  }
  // Singleton guard: never start a second session behind a live supervisor,
  // and never stay down behind one that supervises nothing (agent 867).
  const claimed = await claimSupervision()
  // No state dir to arm in: launch exactly as before, unsupervised.
  if (claimed === 'unarmed') return spawnSupervised(args)
  if (claimed !== 'armed') return claimed
  // A marker left behind by a dead launcher is moot: this launch already
  // starts the newest installed code.
  if (exists(markerPath)) removeFile(markerPath)
  print(`[hoai] restart supervisor armed for assistant ${id}`)
  // If this launcher's own loop ever stops while it holds the claim and its
  // claude is gone, the watchdog releases the claim and ends it (agent 867).
  const watchdog = startWatchdog({
    claimPath: supervisorPath,
    pid: process.pid,
    platform,
    statusPath: unattended ? joinDir(stateDir, LAUNCH_STATUS_FILE_NAME) : null,
  })

  // Launch recipe (design 1.7): what a per-machine watcher needs to relaunch
  // THIS agent as itself in this folder when no supervisor is alive any more
  // (lib/agent-inventory.mjs readLaunchRecipe). Written at arm time and on
  // every relaunch; existence-only for others (contents are re-validated on
  // read). It never carries a session id (buildLaunchRecipe strips the
  // session args; hoai resumes its own pin itself) nor a token. Best effort:
  // a failed write changes nothing about this launch.
  // Who this agent is (lib/agent-identity.mjs): the identity file pairing and
  // the daemon write in the state folder rides every launch and relaunch as
  // --append-system-prompt-file, so the owner's global CLAUDE.md cannot make
  // it somebody else. Only when the file has text and this claude knows the
  // flag; a person's own flag wins. Each note is printed once, so a relaunch
  // loop does not repeat it. The answer is kept until a launch that carried
  // the flag dies at once (see the exit below), or a restart someone asked
  // for after a CLI that did not know it, and 'unknown' is never kept.
  const identityPath = identityFilePath(stateDir)
  // The person's own flag as they gave it, the pair or the one `=` token.
  // Every relaunch rebuilds its arguments from the channel and so drops the
  // person's; theirs is carried over there (relaunchIdentityArgs below), or
  // the agent would run with no identity at all after its first relaunch.
  const personIdentity = (() => {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === IDENTITY_FLAG) return args.slice(i, i + 2)
      if (String(args[i]).startsWith(`${IDENTITY_FLAG}=`)) return [args[i]]
    }
    return null
  })()
  const personChoseIdentity = personIdentity !== null
  let identityAnswer = null
  let identityNote = null
  // Launches with the flag that died inside the health window, and whether
  // this launcher has dropped the flag for the rest of its life.
  let identityFastDeaths = 0
  let identityOff = false
  const identityArgsNow = () => {
    if (personChoseIdentity || identityOff) return []
    const out = identityLaunchArgs({
      path: identityPath,
      exists: (path) => String(readFile(path) ?? '').trim() !== '',
      probe: () => {
        if (identityAnswer) return identityAnswer
        const answer = probeIdentityFlag()
        if (answer === 'supported' || answer === 'unsupported') identityAnswer = answer
        return answer
      },
      platform,
    })
    if (out.note && out.note !== identityNote) print(out.note)
    identityNote = out.note
    return out.args
  }
  const relaunchIdentityArgs = () => personIdentity ?? identityArgsNow()
  // The recipe never carries the launcher's own identity args: a watcher
  // relaunch goes through hoai, which adds them again from the file.
  const withoutOwnIdentity = (launchArgs) => {
    const out = []
    for (let i = 0; i < launchArgs.length; i++) {
      if (!personChoseIdentity && launchArgs[i] === IDENTITY_FLAG && launchArgs[i + 1] === identityPath) {
        i += 1
        continue
      }
      out.push(launchArgs[i])
    }
    return out
  }
  const recordRecipe = (launchArgs) => {
    const detection = detectInstallMethod({
      scriptPath: joinDir(scriptDir, 'bgos-install-method.mjs'),
      env,
      home,
    })
    writeLaunchRecipe({
      home,
      assistantId: id,
      writeFile,
      recipe: buildLaunchRecipe({
        assistantId: id,
        cwd,
        argv: withoutOwnIdentity(launchArgs),
        installMethod: detection.method,
        pluginRoot: detection.pluginRoot,
        node: process.execPath,
        claudeConfigDir: String(env.CLAUDE_CONFIG_DIR ?? '').trim() || null,
        startedAt: new Date(now()).toISOString(),
        pid: process.pid,
      }),
    })
  }
  recordRecipe(args)

  // GAP 1: pin a per-agent session id and resume THIS agent's OWN session on
  // every (re)launch, never --continue (newest-in-shared-cwd = identity bleed).
  // `hoai --new` repins to a BRAND NEW id first, so this launch creates a
  // clean session and later bare `hoai` runs resume that one.
  const sessionIdPath = joinDir(stateDir, SESSION_ID_FILE_NAME)
  let pinnedId = freshSession
    ? freshPinnedSessionId({ path: sessionIdPath, writeFile, generateId })
    : ensurePinnedSessionId({ path: sessionIdPath, readFile, writeFile, generateId })
  // A fresh session an earlier launcher started and never got to pin (it died,
  // or its loop stopped, inside the health window, while the session lived
  // on): pinned now when its transcript proves it, or dropped (decidePendingPin).
  // `--new` asked for a new conversation, so whatever was pending goes.
  const pendingPinPath = joinDir(stateDir, PENDING_PIN_FILE_NAME)
  const pending = freshSession
    ? { action: 'drop' }
    : decidePendingPin({
        pendingRaw: readFile(pendingPinPath),
        pinnedId,
        healthyMs,
        transcriptMtimeMs: (sessionId) => mtimeMs(sessionTranscriptPath(home, cwd, sessionId, env.CLAUDE_CONFIG_DIR)),
      })
  if (pending.action === 'promote' && writeFile(sessionIdPath, pending.sessionId)) {
    print(`[hoai] the fresh session ${pending.sessionId} an earlier launch started outlived its health window; it is now this agent's pinned session`)
    pinnedId = pending.sessionId
    removeFile(pendingPinPath)
  } else if (pending.action === 'drop' && exists(pendingPinPath)) {
    removeFile(pendingPinPath)
  }
  // Whether the pinned session can be RESUMED is answered by its transcript
  // on disk, every time, including a marker relaunch. "We launched it, so
  // it exists" is not true for a channel-only session: Claude Code writes
  // no transcript for one, so --resume is rejected on the spot, the fresh
  // fallback mints a NEW id, and every restart cost a doomed launch and the
  // agent's pinned identity. No transcript means create it again with the
  // SAME id (never --continue); the fresh fallback below still covers a
  // rejected resume.
  const sessionExistsNow = () =>
    pinnedId ? exists(sessionTranscriptPath(home, cwd, pinnedId, env.CLAUDE_CONFIG_DIR)) : false
  // The pin on disk can change under a live launcher: the daemon rewrites it
  // when the live session is a different resumable one (design 13, 'Plugin:
  // daemon'). Every relaunch reads it again, or the id read at launch would
  // undo that rewrite at the next marker or --keep-alive relaunch (review
  // daemon F6: A, then B, then A again). Junk on disk is no pin, so the last
  // good id stands. A `--new` whose repin could not be written left the
  // abandoned pin on disk: that one id is never taken back, because resuming
  // it is the one thing --new must not do. The deferred fresh-retry pin is
  // untouched: until it commits, the file still names the previous session.
  const abandonedPin = freshSession && !pinnedId ? String(readFile(sessionIdPath) ?? '').trim() : ''
  const rereadPin = () => {
    const onDisk = String(readFile(sessionIdPath) ?? '').trim()
    if (isSessionIdLike(onDisk) && onDisk !== abandonedPin) pinnedId = onDisk
  }

  let relaunchesAt = []
  let healthRelaunchesAt = []
  let exhausted = false
  let currentArgs = [...args, ...identityArgsNow(), ...sessionArgsFor(pinnedId, sessionExistsNow())]
  // The never-leave-dead fresh fallback is one-shot per relaunch cycle; a
  // marker relaunch (a genuine update) resets it below. Recovery keys on whether
  // the exited child was RESUMING a session (--resume present), which covers a
  // marker relaunch AND a fresh hoai process whose pinned session already exists
  // (the external keepalive restarted it); a fresh --session-id CREATE that dies
  // fast is never looped on.
  let freshTried = false
  // A marker relaunch that dies fast gets the same one-shot fresh retry a
  // rejected --resume gets: since 604e914 a transcript-less relaunch is
  // --session-id <pinned>, and keying recovery on '--resume' alone left
  // that (the normal) shape with no retry at all.
  let lastLaunchWasRelaunch = false
  // A fresh-retry id waiting to be pinned: committed to the session-id file
  // only once that session has outlived the health window (see retry-fresh).
  let pendingPin = null
  // --keep-alive: the current run of quick exits, and the recent exit times the
  // crash loop is judged on.
  let keepAliveStreak = 0
  let exitTimes = []
  try {
    while (true) {
      /** @type {import('node:child_process').ChildProcess | null} */
      let childRef = null
      let restartRequested = false
      // Set only by the restart marker (the app, a plugin update): hoai's own
      // health relaunch is no sign that the CLI underneath changed.
      let markerRestart = false
      // False once this launch's claude has exited: a late helper exit or check is not about it.
      let live = true
      const startedAt = now()
      // Relaunch THIS claude because it is not proven healthy: the same relaunch a restart marker
      // gets (its own pinned session, a fresh fallback cycle), on a budget of its own so it can
      // never loop. Past the budget it is reported and claude is left as it is.
      const healthRelaunch = (reason, why) => {
        // A launcher asked to stop is ending this claude anyway; nothing to relaunch or record.
        if (!live || restartRequested || !childRef || stopSignal?.aborted) return
        const decision = decideMarkerRelaunch(healthRelaunchesAt, now(), MAX_HEALTH_RELAUNCHES_PER_WINDOW)
        healthRelaunchesAt = decision.recent
        if (!decision.allow) {
          noteStatus('health-relaunch-refused', { reason })
          print(
            `[hoai] ${why}. NOT relaunching: ${MAX_HEALTH_RELAUNCHES_PER_WINDOW} health relaunches in the last hour ` +
              'already, so claude is left as it is. Run hoai doctor in this folder.',
          )
          return
        }
        healthRelaunchesAt.push(now())
        restartRequested = true
        noteStatus('health-relaunch', { reason })
        print(`[hoai] ${why}. Relaunching claude on this agent's own session...`)
        try {
          endClaude(childRef)
        } catch {
          // Already gone; its exit resolves the loop below.
        }
      }
      // Read before the spawn: whatever daemon the beacon names now is not this launch's.
      const staleBeaconPid = unattended ? (parseChannelBeacon(readFile(beaconPath))?.pid ?? null) : null
      const exited = spawnSupervised(
        currentArgs,
        (child) => {
          childRef = child
        },
        (code) => {
          if (!unattended || code !== WIN32_GATE_EXIT_UNPROVEN) return
          healthRelaunch(
            'gate-accept-unproven',
            `the dev-channels gate helper wrote the Enter but could not record "attached" and "accepted" in its log ` +
              `(exit ${code}), so nothing proves the gate was answered`,
          )
        },
      )
      let heartbeatTimer = null
      // Alerted once per launch: the check keeps coming back while the login stays failed, quietly.
      let loginAlerted = false
      const armHeartbeatCheck = () => {
        heartbeatTimer = setTimer(checkHeartbeat, CHANNEL_HEARTBEAT_WAIT_MS)
        // Never what keeps this process alive; claude's own handle does that.
        if (heartbeatTimer && typeof heartbeatTimer === 'object' && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()
      }
      const checkHeartbeat = () => {
        heartbeatTimer = null
        if (!live || restartRequested) return
        const beacon = parseChannelBeacon(readFile(beaconPath))
        if (channelHeartbeatSince({ beacon, startedAt, stalePid: staleBeaconPid })) {
          heartbeatRelaunchSpent = false
          return
        }
        const waited = `${Math.round((now() - startedAt) / 1000)}s`
        // The Claude login every agent here shares has failed: this session cannot sign in, and a
        // relaunched one meets the same wall. Alert instead, spend nothing, and look again later. The
        // failure stands until the login comes back after it, a sign-in or an answer (not merely once
        // it is too old to read as fresh); then a launch still without a heartbeat has another cause
        // and gets its one relaunch (board row 31583f86).
        if (loginFailure && claudeLoginBackSince(loginFailure.at)) loginFailure = null
        else loginFailure ??= claudeLoginFailure()
        const login = loginFailure
        if (login) {
          if (!loginAlerted) {
            loginAlerted = true
            const failedAt = new Date(login.at).toISOString()
            noteStatus('claude-login-expired', { waited, failedAt, cli: login.text })
            print(
              `[hoai] ALERT (claude-login-expired): claude has run ${waited} and its channel has sent no heartbeat, ` +
                `and the Claude login the agents on this computer share has failed (first seen failing at ${failedAt}` +
                `${login.text ? `; the CLI says: "${login.text}"` : ''}). A relaunch cannot fix that, so hoai does not ` +
                'relaunch. Sign in again: run /login in a claude session on this computer. hoai looks again every 3 ' +
                'minutes and relaunches claude once the login is back.',
            )
          }
          armHeartbeatCheck()
          return
        }
        if (!heartbeatRelaunchSpent) {
          heartbeatRelaunchSpent = true
          healthRelaunch('no-channel-heartbeat', `claude has run ${waited} and its channel has sent no heartbeat (${beaconPath})`)
          return
        }
        noteStatus('no-channel-heartbeat', { waited, beacon: beaconPath })
        print(
          `[hoai] ALERT (no-channel-heartbeat): claude has run ${waited} and its channel has sent no heartbeat ` +
            `(${beaconPath}), after the one relaunch hoai makes for that. Not relaunching again: the agent stays ` +
            'up for a person to look at. Run hoai doctor in this folder.',
        )
      }
      if (unattended) armHeartbeatCheck()
      // A stop request ends the live claude; the exit below then returns
      // instead of relaunching. Checked once more after registering, because an
      // abort that already happened fires no event.
      const onStop = () => {
        try {
          if (childRef) endClaude(childRef)
        } catch {
          // Already gone; its exit resolves the loop.
        }
      }
      stopSignal?.addEventListener?.('abort', onStop, { once: true })
      if (stopSignal?.aborted) onStop()
      // Deferred pin commit. A fresh session that dies inside the health
      // window (like the resume before it) is an environment fault, not a
      // rejected resume; the pin must still name the previous session so the
      // next hoai resumes the agent's real context (zaid, 2026-09-02: a
      // redirected console put claude in print mode and the old rule burned
      // the pin on the retry). Committed only if the child is still up.
      let pinTimer = null
      // The fresh session this launch runs while its window is open: a relaunch hoai itself asks for
      // in that window carries it on (below), because the session is not what was judged.
      let windowPin = null
      if (pendingPin) {
        const candidate = pendingPin
        pendingPin = null
        windowPin = candidate
        // On disk from now on, so a launcher that dies or stops ticking inside
        // the window does not take the fresh session with it (agent 867).
        writeFile(pendingPinPath, JSON.stringify({ sessionId: candidate, startedAt: new Date(startedAt).toISOString(), pinAtWrite: pinnedId }))
        pinTimer = setTimer(() => {
          pinTimer = null
          windowPin = null
          if (writeFile(sessionIdPath, candidate)) {
            pinnedId = candidate
            removeFile(pendingPinPath)
            print('[hoai] the fresh session stayed up; it is now this agent\'s pinned session')
          } else {
            print(
              '[hoai] warning: the fresh session stayed up but its pin could not be written; the previous pin stands, ' +
                `and the next launch pins it from ${pendingPinPath}`,
            )
          }
        }, healthyMs)
        // Never let the pending pin hold the process open past the child.
        if (pinTimer && typeof pinTimer === 'object' && typeof pinTimer.unref === 'function') pinTimer.unref()
      }
      const poller = setInterval(() => {
        if (exhausted || restartRequested || !childRef) return
        if (!exists(markerPath)) return
        removeFile(markerPath)
        const decision = decideMarkerRelaunch(relaunchesAt, now())
        relaunchesAt = decision.recent
        if (!decision.allow) {
          exhausted = true
          print(
            `[hoai] restart marker ignored: ${MAX_RELAUNCHES_PER_WINDOW} relaunches in the ` +
              'last hour. Not relaunching again; exit and run hoai to pick up the update.',
          )
          return
        }
        relaunchesAt.push(now())
        restartRequested = true
        markerRestart = true
        print('[hoai] restart requested by the daemon; restarting claude to pick up the update...')
        try {
          endClaude(childRef)
        } catch {
          // The child already died; its exit resolves the loop below.
        }
      }, pollMs)
      // Never what keeps this process alive: while claude runs, its own child
      // handle does, and nothing here waits on an exit without one. A ref'd
      // poller kept a loop that outlived its caller (a test left with a fake
      // child nobody exits) ticking every few ms, and held `tsx --test` open,
      // idle, for hours.
      poller.unref?.()
      const code = await exited
      live = false
      if (heartbeatTimer) {
        clearTimer(heartbeatTimer)
        heartbeatTimer = null
      }
      clearInterval(poller)
      stopSignal?.removeEventListener?.('abort', onStop)
      if (pinTimer) {
        clearTimer(pinTimer)
        pinTimer = null
        // Died inside its window: never the pin (a relaunch that carries it writes it again).
        removeFile(pendingPinPath)
      }
      // Asked to stop: whatever the exit, nothing is relaunched.
      if (stopSignal?.aborted) return code
      const elapsedMs = now() - startedAt
      // A launch that outlived the health window clears the identity flag's
      // fast deaths, however it ended: most runs of an always on agent end
      // by a marker relaunch, and two deaths days apart say nothing about
      // the flag (plugin review 2).
      if (elapsedMs >= healthyMs) identityFastDeaths = 0
      if (restartRequested) {
        // A restart someone asked for (the app, a plugin update) gives back
        // an identity this launcher dropped, and asks again a CLI that did
        // not know the flag: either may have been updated since. Only the
        // marker: a health relaunch hoai makes itself keeps both as they are.
        const identityWasOff = markerRestart && identityOff
        if (markerRestart) {
          if (identityOff) {
            identityOff = false
            identityFastDeaths = 0
          }
          if (identityAnswer === 'unsupported') identityAnswer = null
        }
        // A daemon-driven update restart: relaunch THIS agent's OWN session
        // (resume it when its transcript exists, else create it again by
        // id; never --continue), and give this cycle a fresh fallback.
        const pinBefore = pinnedId
        rereadPin()
        // Inside a fresh session's window the pin still names the session whose resume was just
        // rejected. An update, an unproven gate or a missing heartbeat is no verdict on the fresh
        // session, so it is the one relaunched, and its window starts again (board row 978da5db).
        // A pin the daemon rewrote meanwhile names the live session and wins, as everywhere.
        const carried = windowPin && pinnedId === pinBefore ? windowPin : null
        const sessionArgs = carried
          ? sessionArgsFor(carried, exists(sessionTranscriptPath(home, cwd, carried, env.CLAUDE_CONFIG_DIR)))
          : sessionArgsFor(pinnedId, sessionExistsNow())
        const identityArgs = relaunchIdentityArgs()
        const relaunchArgs = relaunchClaudeArgs({ scriptDir, env, home, cwd, readFile, sessionArgs, extraArgs: identityArgs })
        if (!relaunchArgs) return stopUnresolved()
        if (identityWasOff && identityArgs.includes(IDENTITY_FLAG)) {
          noteStatus('identity-flag-restored')
          print(`[hoai] this agent's identity is back: the relaunch passes ${IDENTITY_FLAG} ${identityPath} again`)
        }
        if (carried) pendingPin = carried
        currentArgs = relaunchArgs
        freshTried = false
        lastLaunchWasRelaunch = true
        recordRecipe(currentArgs)
        print(`[hoai] relaunching: claude ${currentArgs.join(' ')}`)
        continue
      }
      // A self-initiated exit. If a RESUME died non-zero inside the health
      // window we already killed the old session (or the external keepalive
      // would loop on the same rejection), so never leave the agent dead: retry
      // once as a brand-new OWN session (a fresh pinned id).
      // A screen nobody may answer, or a signed-out account, is not a rejected
      // resume: a fresh session meets the same wall, and the retry would spend
      // the one-shot fallback (and overwrite launch-status) for nothing.
      const namedSupervisedExit = supervised && SUPERVISED_NO_FRESH_RETRY.has(code)
      const recovery = namedSupervisedExit
        ? { action: 'return' }
        : decideRelaunchRecovery({
            isResumeAttempt: currentArgs.includes('--resume') || lastLaunchWasRelaunch,
            exitCode: code,
            elapsedMs,
            freshTried,
            healthyMs,
          })
      // A launch that carried the identity flag and died at once may have
      // died OF it: the CLI under a long lived launcher can change (a
      // reinstall, an old binary back on PATH), and one can parse the flag and
      // still refuse the session. So the answer is asked again before the next
      // launch, and when a second launch with it dies at once, or this one
      // would otherwise end the launcher, this agent's own session comes back
      // once without it (plugin review I1). Without the flag the agent is
      // only missing its name; with it, it would not start at all.
      // Under --keep-alive an exit 0 is relaunched like any other, so it counts
      // too; supervised, the service restarts any exit (plugin review 4).
      const identityDeath = code !== 0 || keepAlive || supervised
      if (!personChoseIdentity && currentArgs.includes(IDENTITY_FLAG) && identityDeath && !namedSupervisedExit && elapsedMs < healthyMs) {
        identityAnswer = null
        identityFastDeaths += 1
        const lastChance = recovery.action !== 'retry-fresh' && !keepAlive
        if (!identityOff && (identityFastDeaths >= 2 || lastChance)) {
          identityOff = true
          noteStatus('identity-flag-dropped', { exit: code })
          print(
            `[hoai] claude exited at once (code ${code}) with ${IDENTITY_FLAG}, which may be the cause; ` +
              `relaunching this agent's own session without it, so it runs without its identity (${identityPath}) ` +
              'until the agent is restarted (from the app, by a plugin update, or hoai starting again). ' +
              'Update Claude Code, then restart the agent, to give it back.',
          )
          rereadPin()
          const plainArgs = relaunchClaudeArgs({
            scriptDir,
            env,
            home,
            cwd,
            readFile,
            sessionArgs: sessionArgsFor(pinnedId, sessionExistsNow()),
            extraArgs: [],
          })
          if (!plainArgs) return stopUnresolved()
          // A new cycle without the flag, with its own one fresh retry: the
          // launch that died may have been the fresh retry already, and the
          // resume it fled may be rejected again (plugin review 2). If this
          // cycle dies at once too, the flag was not the cause. A fresh retry
          // only ever follows a resume or a relaunch, so after one this launch
          // of the pin counts as a relaunch: with no transcript it is
          // --session-id <pin>, which is not a --resume (plugin review 3).
          currentArgs = plainArgs
          if (freshTried) lastLaunchWasRelaunch = true
          freshTried = false
          recordRecipe(currentArgs)
          continue
        }
      }
      if (recovery.action === 'retry-fresh') {
        freshTried = true
        lastLaunchWasRelaunch = false
        const freshId = String(generateId()).trim()
        // Mint a NEW id for the retry, but do NOT pin it yet: the pin is
        // committed at the spawn site only once the fresh session has outlived
        // the health window. Never --resume the session we just fled, and never
        // --session-id an id that already exists (it errors).
        let freshSessionArgs
        if (freshId && isSessionIdLike(freshId)) {
          pendingPin = freshId
          freshSessionArgs = sessionArgsFor(freshId, false)
        } else {
          freshSessionArgs = []
        }
        const freshArgs = relaunchClaudeArgs({
          scriptDir,
          env,
          home,
          cwd,
          readFile,
          sessionArgs: freshSessionArgs,
          extraArgs: relaunchIdentityArgs(),
        })
        if (!freshArgs) return stopUnresolved()
        currentArgs = freshArgs
        recordRecipe(currentArgs)
        print(
          '[hoai] the resumed session exited immediately (a rejected resume or a fast ' +
            'fault); relaunching a FRESH own session so the agent is not left down...',
        )
        continue
      }
      if (!keepAlive) return code

      // --keep-alive: claude exited on its own and the fresh fallback has had
      // its chance. Wait, then bring the SAME agent back on its pinned session.
      exitTimes.push(now())
      const loop = decideCrashLoop({ exitsAt: exitTimes, now: now() })
      exitTimes = loop.recent
      const backoff = decideKeepAliveBackoff({ streak: keepAliveStreak, ranMs: elapsedMs })
      keepAliveStreak = backoff.streak
      // A session that outlived the health window has earned the fresh fallback
      // again: a resume rejected days later deserves its one retry too.
      if (elapsedMs >= healthyMs) freshTried = false
      const ranS = Math.round(elapsedMs / 1000)
      const delayS = Math.round(backoff.delayMs / 1000)
      if (loop.crashLoop) {
        noteStatus('crash-loop', {
          exits: loop.recent.length,
          window: `${Math.round(CRASH_LOOP_WINDOW_MS / 1000)}s`,
          exit: code,
          delay: `${delayS}s`,
        })
        print(
          `[hoai] CRASH LOOP: claude exited ${loop.recent.length} times in the last ` +
            `${Math.round(CRASH_LOOP_WINDOW_MS / 60_000)} minutes (last exit ${code}). Relaunching in ${delayS}s; ` +
            'run hoai doctor in this folder to see why it does not stay up.',
        )
      } else {
        noteStatus('keep-alive-relaunch', { exit: code, ran: `${ranS}s`, delay: `${delayS}s` })
        print(
          `[hoai] claude exited (code ${code}) after ${ranS}s; --keep-alive relaunches it in ${delayS}s, ` +
            "resuming this agent's own session",
        )
      }
      // No child until that relaunch: the claim says by when, so a launcher
      // reading it meanwhile sees a holder between children, not an idle one.
      writeFile(
        supervisorPath,
        supervisorFileBody(process.pid, new Date(now()).toISOString(), bootClock(), {
          relaunchBy: new Date(now() + backoff.delayMs).toISOString(),
        }),
      )
      await sleep(backoff.delayMs)
      if (stopSignal?.aborted) return code
      // The channel is re-resolved, and the session args are the identity-safe
      // pair: --resume <pin> when its transcript exists, else --session-id <pin>.
      rereadPin()
      const keepArgs = relaunchClaudeArgs({
        scriptDir,
        env,
        home,
        cwd,
        readFile,
        sessionArgs: sessionArgsFor(pinnedId, sessionExistsNow()),
        extraArgs: relaunchIdentityArgs(),
      })
      if (!keepArgs) return stopUnresolved()
      currentArgs = keepArgs
      // Counted as a relaunch, so a fast death of it gets the fresh fallback the
      // same way a marker relaunch does.
      lastLaunchWasRelaunch = true
      // The daemon trusts a restart authority only while supervisor.json names
      // a live launcher with the relaunch capability. Re-written, not assumed:
      // something may have removed it while claude ran.
      writeFile(supervisorPath, supervisorFileBody(process.pid, new Date(now()).toISOString(), bootClock()))
      recordRecipe(currentArgs)
      continue
    }
  } finally {
    watchdog?.stop()
    removeFile(supervisorPath)
  }
}

// -- Logs ---------------------------------------------------------------------

/**
 * Mirror of lib/log-path.ts resolveLogPath, kept in plain JS because hoai runs
 * under bare node and must not import TS sources (a test in log-path.test.ts
 * pins the TS rule; this one restates it): a non-empty (trimmed) BGOS_LOG_FILE
 * wins, else <home>/.bgos-agent/logs/bgos-plugin-<id>.log ('unknown' when the
 * id is missing or blank).
 * @param {{ env?: Record<string, string | undefined>, home?: string, assistantId?: string | number | null }} [opts]
 */
export function hoaiLogPath({ env = {}, home = homedir(), assistantId } = {}) {
  const override = String(env.BGOS_LOG_FILE ?? '').trim()
  if (override) return override
  const id = String(assistantId ?? '').trim() || 'unknown'
  return joinDir(joinDir(agentDir(home), 'logs'), `bgos-plugin-${id}.log`)
}

/**
 * The id the log file is keyed by: folder pin, else env pin, else 'unknown'.
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, readFile?: (path: string) => string | null }} [opts]
 */
export function logsAssistantId({ cwd, env = {}, readFile = defaultReadText } = {}) {
  return readFolderDeclaredId(cwd, readFile) || configuredAssistantId(env) || 'unknown'
}

/** The last `count` non-trailing-blank lines of a text blob. */
export function lastLines(text, count = 60) {
  const lines = String(text ?? '').split(/\r?\n/)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-count)
}

// -- Spawning claude ----------------------------------------------------------

/**
 * The spawn attempts for launching claude, in order, all with shell:false.
 *
 * win32 needs a chain: a bare 'claude' resolves a native claude.exe via the
 * spawn PATH search, but the npm-shim install ships only claude.cmd, which
 * node refuses to spawn without a shell (the EINVAL .cmd injection guard). So
 * the claude.cmd attempt goes through ComSpec (/c) explicitly; the args are
 * fixed constants with no user input, so the cmd.exe hop has no injection
 * surface. The one exception is the identity file path, which comes from the
 * home folder: identityLaunchArgs never passes one holding a character cmd.exe
 * re-reads. cmd.exe exits 9009 when claude.cmd does not exist, which the
 * runner treats as "not found, try the next candidate".
 * @param {readonly string[]} args
 * @param {string} platform
 * @param {Record<string, string | undefined>} [env]
 * @returns {Array<{ file: string, args: string[], notFoundExitCodes: number[] }>}
 */
export function claudeSpawnCandidates(args, platform, env = {}) {
  if (platform !== 'win32') return [{ file: 'claude', args: [...args], notFoundExitCodes: [] }]
  const comspec = String(env.ComSpec ?? env.COMSPEC ?? '').trim() || 'cmd.exe'
  return [
    { file: 'claude', args: [...args], notFoundExitCodes: [] },
    { file: comspec, args: ['/c', 'claude.cmd', ...args], notFoundExitCodes: [9009] },
    { file: 'claude.exe', args: [...args], notFoundExitCodes: [] },
  ]
}

/**
 * Whether the claude this launcher starts knows --append-system-prompt-file. A
 * bare use answers "argument missing" when it does and "unknown option" when
 * it does not (classifyFlagProbe, the same reading as the channels flag). The
 * same candidates as the launch, in the same order, hidden and killed after
 * PROBE_TIMEOUT_MS; 'unknown' when none of them ran.
 * @param {{ platform?: string, env?: Record<string, string | undefined>, run?: typeof spawnSync }} [opts]
 * @returns {'supported' | 'unsupported' | 'unknown'}
 */
export function defaultProbeIdentityFlag({ platform = process.platform, env = process.env, run = spawnSync } = {}) {
  for (const candidate of claudeSpawnCandidates([IDENTITY_FLAG], platform, env)) {
    let out
    try {
      out = run(candidate.file, candidate.args, {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      if (spawnErrorMeansNotFound(error)) continue
      return 'unknown'
    }
    if (spawnErrorMeansNotFound(out?.error)) continue
    if (candidate.notFoundExitCodes.includes(out?.status)) continue
    return classifyFlagProbe(out)
  }
  return 'unknown'
}

/** Map a child's (code, signal) exit to this process's exit code. */
export function exitCodeForChild(code, signal) {
  if (signal === 'SIGINT') return 130
  if (signal === 'SIGTERM') return 143
  if (signal) return 1
  return code ?? 1
}

/** A spawn failure that means "this candidate does not exist here": ENOENT
 *  (nothing by that name) or EINVAL (node's .cmd-without-shell guard). */
function spawnErrorMeansNotFound(err) {
  return err?.code === 'ENOENT' || err?.code === 'EINVAL'
}

/**
 * Try the candidates in order; resolve with the exit code of the first one
 * that actually runs, or EXIT_NOT_FOUND after printing an install hint when
 * none of them exists. `onSpawn` (optional) receives every spawned candidate
 * child, so the supervise loop can SIGTERM the live one; a fallback attempt
 * calls it again with the replacement child.
 */
export function spawnClaude(args, { platform = process.platform, env = process.env, spawnImpl = spawn, writeErr = (text) => process.stderr.write(text), onSpawn, childEnv } = {}) {
  const candidates = claudeSpawnCandidates(args, platform, env)
  // `childEnv` (the supervise loop's childEnvWithoutSupervision) is the env the
  // child gets; without it the child inherits this process's, as before.
  const spawnOpts = childEnv ? { stdio: 'inherit', shell: false, env: childEnv } : { stdio: 'inherit', shell: false }
  return new Promise((resolve) => {
    const tryNext = (index) => {
      if (index >= candidates.length) {
        writeErr(
          '[hoai] claude was not found on this machine. Install Claude Code (claude.ai/code) ' +
            'and make sure the claude command is on PATH, then run hoai again.\n',
        )
        resolve(EXIT_NOT_FOUND)
        return
      }
      const candidate = candidates[index]
      let child
      try {
        child = spawnImpl(candidate.file, candidate.args, spawnOpts)
      } catch (err) {
        if (spawnErrorMeansNotFound(err)) return tryNext(index + 1)
        writeErr(`[hoai] could not start ${candidate.file}: ${err?.message ?? err}\n`)
        resolve(1)
        return
      }
      onSpawn?.(child)
      child.on('error', (err) => {
        if (spawnErrorMeansNotFound(err)) return tryNext(index + 1)
        writeErr(`[hoai] could not start ${candidate.file}: ${err?.message ?? err}\n`)
        resolve(1)
      })
      child.on('exit', (code, signal) => {
        if (!signal && candidate.notFoundExitCodes.includes(code ?? -1)) return tryNext(index + 1)
        resolve(exitCodeForChild(code, signal))
      })
    }
    tryNext(0)
  })
}

// -- setup: marketplace + install + pair, in one shell-neutral command --------

/** The marketplace the HOAI plugin is published from. */
export const HOAI_MARKETPLACE = 'BrandGrowthOS/hoai-marketplace'

/** The plugin ref inside that marketplace. */
export const HOAI_PLUGIN_REF = 'hoai@hoai'

/** `hoai setup` ran with no pair code (nothing to pair, nothing to do). */
export const EXIT_SETUP_NO_CODE = 2

/**
 * Split `setup <CODE> [...]` into the pair code and the argv that goes on to
 * bgos-pair.
 *
 * Everything after the code is passed through UNTOUCHED and in order, so
 * `--assistant-id <id>` (and any other pair flag, e.g. --backend) reaches the
 * pair CLI exactly as the caller wrote it. Nothing is re-quoted or re-parsed
 * on the way: these become argv entries of a shell:false spawn, which is what
 * lets a value containing a space or a shell metacharacter survive verbatim on
 * macOS, Linux and Windows alike.
 *
 * @param {readonly string[]} rest argv after the `setup` token
 * @returns {{ ok: true, code: string, pairArgs: string[] }
 *          | { ok: false, reason: string }}
 */
export function parseSetupArgs(rest) {
  const args = Array.isArray(rest) ? rest.map((value) => String(value ?? '')) : []
  const code = args[0] ?? ''
  if (code === '' || code.startsWith('-')) {
    return {
      ok: false,
      reason:
        'hoai setup needs the one time pair code from the app, e.g. hoai setup BGOS-7F3A-2K',
    }
  }
  return { ok: true, code, pairArgs: [...args] }
}

/**
 * Run the four first-run steps in order, each as its own child process with
 * no shell involved:
 *   1. claude plugin marketplace add BrandGrowthOS/hoai-marketplace
 *   2. claude plugin install hoai@hoai
 *   3. put the `hoai` command itself on this machine's PATH
 *   4. bgos-pair <CODE> [...]
 *
 * Step 1 is deliberately NON fatal on a plain failure. The old `&&` chain
 * aborted the whole line when the marketplace was already added, which is the
 * normal state of any machine connecting a SECOND agent, so a re-run could
 * never reach the pair step. `claude` being missing entirely is a different
 * thing and does stop the run: spawnClaude has already printed the install
 * hint, and the later steps could only repeat it.
 *
 * Step 3 is also non fatal: a shim that could not be written is worth saying
 * out loud, but it is not worth abandoning a machine one step from paired. It
 * runs BEFORE pairing so that the pairing step's own closing instruction ("run
 * hoai from this folder") is true by the time the user reads it.
 *
 * @param {readonly string[]} pairArgs argv for bgos-pair (code first)
 * @returns {Promise<number>} exit code (0 only when the fatal steps passed)
 */
export async function runSetup(
  pairArgs,
  {
    platform = process.platform,
    env = process.env,
    home = homedir(),
    scriptDir = defaultScriptDir(),
    spawnImpl = spawn,
    spawnClaudeImpl = spawnClaude,
    installCliImpl = installHoaiCli,
    ensureAutoUpdateImpl = ensureMarketplaceAutoUpdate,
    print = (text) => console.log(text),
    writeErr = (text) => process.stderr.write(text),
  } = {},
) {
  const claudeOpts = { platform, env, spawnImpl, writeErr }

  print(`[hoai] 1/4 adding the HOAI marketplace (${HOAI_MARKETPLACE})`)
  const added = await spawnClaudeImpl(
    ['plugin', 'marketplace', 'add', HOAI_MARKETPLACE],
    claudeOpts,
  )
  if (added === EXIT_NOT_FOUND) return EXIT_NOT_FOUND
  if (added !== 0) {
    print(
      '[hoai] the marketplace was not added just now (most often it is already there). Continuing.',
    )
  }

  // Enrol this machine in Claude Code's own plugin auto-update, so a published release reaches it
  // without anybody typing anything. Claude Code defaults that ON only for Anthropic's own
  // marketplace names, so without this key the machine stays on today's version forever while every
  // check reports success.
  //
  // AFTER the add, never before: `plugin marketplace add` rewrites the entry to just its source, on
  // both the "added" and the "already on disk" branches, so an earlier write would be undone here.
  try {
    const enrolled = ensureAutoUpdateImpl({
      configDir: claudeConfigDir({ env, home }),
      marketplace: HOAI_MARKETPLACE_NAME,
    })
    if (enrolled.changed) {
      print('[hoai] this machine will now update the HOAI plugin automatically')
    }
  } catch (err) {
    // Never fail setup over a settings write. The agent still works; it just will not self-update.
    print(`[hoai] could not enable automatic updates (${err}). Setup continues.`)
  }

  print(`[hoai] 2/4 installing the HOAI plugin (${HOAI_PLUGIN_REF})`)
  const installed = await spawnClaudeImpl(
    ['plugin', 'install', HOAI_PLUGIN_REF],
    claudeOpts,
  )
  if (installed !== 0) {
    writeErr(
      `[hoai] could not install ${HOAI_PLUGIN_REF}. Fix the error above, then run this command again.\n`,
    )
    return installed
  }

  print('[hoai] 3/4 putting the hoai command on your PATH')
  await installCliImpl({ platform, env, home, scriptDir, print })

  print('[hoai] 4/4 pairing this machine with the code from the app')
  return runSiblingScript(joinDir(scriptDir, 'bgos-pair.mjs'), pairArgs, spawnImpl)
}

// NOTE (2026-08-30): a watcher install ran here briefly and was removed before it shipped.
// `hoai-watcher install` stages the bundle and registers the OS service but does NOT enrol
// credentials: its own output says "no credentials yet: the daemon enrolls this machine". So
// installing from setup, before any daemon has run, produced a service that starts, finds no
// credentials, and retries every 30 seconds forever. It also resolved its script path from this
// script's own directory, which under the `npx --package github:... hoai setup` line the app hands
// out is a temp directory npm deletes on exit.
//
// The goal is still right and is recorded rather than dropped: a machine whose agent is broken
// cannot receive a watcher today, because watcher_install_rpc is addressed to a live agent. Closing
// that needs enrolment to be part of whatever installs it, which is a larger change than a setup
// step and wants its own design.

// -- Putting `hoai` itself on PATH -------------------------------------------

/**
 * WHICH plugin root the `hoai` shim should point at.
 *
 * The marketplace install path wins whenever one is recorded, because that is
 * the directory a one-click update re-points the shim to
 * (lib/update-executor.mjs refreshAlias) and it outlives this process. The
 * running script's own root is the fallback, which is right for a clone
 * install. It matters most in the case this exists for: `npx --yes --package
 * github:BrandGrowthOS/bgos-claude-plugin hoai setup <CODE>` runs from a temp
 * npx directory that is deleted the moment setup returns, so a shim pointed
 * there would be dead on arrival.
 *
 * Which is why the fallback now REFUSES an ephemeral execution root outright
 * rather than returning it. It used to hand back the npx directory whenever
 * the marketplace observation came up empty, and installHoaiCli would write a
 * `hoai` shim aimed at a directory npm was about to delete: a command on PATH
 * that fails with "hoai-core.mjs not found" the next day. '' makes
 * installHoaiCli say it could not work out where the plugin lives, which is
 * both true and fixable.
 * @returns {Promise<string>} '' when neither source yields a persistent root
 */
export async function resolveWrapperPluginRoot({
  env = process.env,
  home = homedir(),
  scriptDir = '',
  exists = existsSync,
  observe = observeMarketplaceInstall,
} = {}) {
  try {
    const observation = await observe({ configDir: claudeConfigDir({ env, home }) })
    const installPath = String(observation?.installed?.installPath ?? '').trim()
    if (installPath && exists(installPath)) return installPath
  } catch {
    // No readable config dir: fall through to this script's own root.
  }
  const detection = detectInstallMethod({
    scriptPath: joinDir(scriptDir, 'bgos-install-method.mjs'),
    env,
    home,
  })
  if (detection?.ephemeralExecution) return ''
  return String(detection?.pluginRoot ?? '').trim() || String(detection?.executionRoot ?? '').trim()
}

/**
 * Put the `hoai` command on this machine's PATH (or repair a shim that points
 * somewhere stale). Best effort by design: onboarding must not fail because a
 * shim could not be written, so this always resolves and only ever prints.
 *
 * The Windows User-PATH write goes through bin/hoai-add-to-path.ps1, the same
 * registry mechanism bin/hoai-bootstrap.ps1 uses. No shell alias is ever
 * written, on any platform: an alias would have to freeze a channel spec, and
 * the correct spec is only knowable at run time.
 *
 * `force` re-points a shim that belongs to another install; without it such a
 * shim is left alone and reported. `kept` lists every shim we declined, and it
 * is ALWAYS an array, including on the early exit below: a caller that reads
 * `.kept.length` must not have to know which path was taken.
 * @returns {Promise<{ ok: boolean, binDir: string,
 *                     kept: Array<{ path: string, pointsAt: string,
 *                                   wanted: string, reason: string }> }>}
 */
export async function installHoaiCli({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  scriptDir = '',
  spawnSyncImpl = spawnSync,
  print = (line) => console.log(line),
  installImpl = installWrapper,
  resolveRoot = resolveWrapperPluginRoot,
  force = false,
} = {}) {
  const pluginRoot = await resolveRoot({ env, home, scriptDir })
  if (!pluginRoot) {
    print('[hoai] could not work out where the plugin lives, so the hoai command was not installed.')
    // kept:[] rather than omitted, so every caller can read .kept.length
    // without first working out which return it got.
    return { ok: false, binDir: '', kept: [] }
  }
  const result = installImpl({
    pluginRoot,
    platform,
    env,
    home,
    force,
    runPathHelper: (binDir) => runWinPathHelper(binDir, { scriptDir, spawnSyncImpl }),
  })
  if (result.wrote.length > 0) {
    print(`[hoai] the hoai command is installed in ${result.binDir} (pointing at ${pluginRoot})`)
  }
  for (const profile of result.profiles) {
    print(`[hoai] added ${result.binDir} to your PATH in ${profile}`)
  }
  for (const note of result.notes) print(`[hoai] ${note}`)
  if (result.wrote.length > 0 && !result.onPath && result.profiles.length === 0) {
    print(`[hoai] open a new terminal (or add ${result.binDir} to your PATH) before typing hoai.`)
  }
  // ANNOUNCE WHAT WAS LEFT ALONE (KC's ruling, 2026-09-21: ask or announce,
  // never silently replace). installWrapper declines to re-point a shim that
  // belongs to another install, or a file the owner wrote themselves. Saying
  // nothing here would be the worst of both worlds: the command reports
  // success, writes nothing, and the owner still has no idea WHICH install
  // their `hoai` runs. So name what is there, name what this install would
  // have pointed it at, say plainly which one wins when they type the word,
  // and give the one command that changes it on purpose.
  for (const kept of result.kept ?? []) {
    if (kept.reason === 'foreign-file') {
      print(`[hoai] ${kept.path} already exists and is not a link this install made, so it was left alone.`)
    } else {
      print(`[hoai] ${kept.path} already points at ${kept.pointsAt}, so it was left alone.`)
    }
    print(`[hoai] this install is at ${kept.wanted}, and typing hoai will NOT run it.`)
    print('[hoai] that is deliberate: replacing a command you already have is not something to do quietly.')
    print('[hoai] to point it at this install instead, run: hoai install-cli --force')
  }
  return { ok: result.ok, binDir: result.binDir, kept: result.kept ?? [] }
}

/** The argv for bin/hoai-add-to-path.ps1. Pure so the spawn is unit-testable
 *  (the same shape as win32GateHelperArgs). */
export function winPathHelperArgs({ scriptDir = '', binDir = '' }) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    joinDir(scriptDir, WIN_PATH_HELPER_FILE),
    '-Dir',
    binDir,
  ]
}

/** Add a directory to the Windows User PATH through the PowerShell helper.
 *  Synchronous on purpose: it is one short registry write and the caller has
 *  nothing useful to do while it runs. Returns false on any failure. */
function runWinPathHelper(binDir, { scriptDir = '', spawnSyncImpl = spawnSync } = {}) {
  try {
    const result = spawnSyncImpl('powershell', winPathHelperArgs({ scriptDir, binDir }), {
      stdio: 'inherit',
      shell: false,
    })
    return result?.status === 0
  } catch {
    return false
  }
}

/**
 * Spawn `expect -c <script>` and resolve with its exit code. Used by the
 * supervised launch to auto-accept the dev-channels startup gate (GAP 2). The
 * script (from buildGateAutoAcceptExpect) is fixed structure with the claude
 * args interpolated; expect owns the PTY and hands off with interact, so a
 * human at the terminal is still relayed and the supervisor's kill still ends
 * the session. `onSpawn` receives the expect child so the loop can SIGTERM it.
 */
export function spawnExpectScript(
  script,
  { spawnImpl = spawn, writeErr = (text) => process.stderr.write(text), onSpawn, childEnv } = {},
) {
  return new Promise((resolve) => {
    let child
    try {
      // claude inherits expect's env, so `childEnv` is claude's too (see spawnClaude).
      child = spawnImpl('expect', ['-c', script], childEnv ? { stdio: 'inherit', shell: false, env: childEnv } : { stdio: 'inherit', shell: false })
    } catch (err) {
      writeErr(`[hoai] could not start expect: ${err?.message ?? err}\n`)
      resolve(1)
      return
    }
    onSpawn?.(child)
    child.on('error', (err) => {
      writeErr(`[hoai] expect error: ${err?.message ?? err}\n`)
      resolve(1)
    })
    child.on('exit', (code, signal) => resolve(exitCodeForChild(code, signal)))
  })
}

/** Run a sibling bin/ script under this same node, forwarding the exit code. */
function runSiblingScript(scriptPath, args, spawnImpl = spawn) {
  return new Promise((resolve) => {
    const child = spawnImpl(process.execPath, [scriptPath, ...args], {
      stdio: 'inherit',
      shell: false,
    })
    child.on('error', (err) => {
      console.error(`[hoai] could not start ${scriptPath}: ${err?.message ?? err}`)
      resolve(1)
    })
    child.on('exit', (code, signal) => resolve(exitCodeForChild(code, signal)))
  })
}

// -- Usage --------------------------------------------------------------------

export const USAGE = `hoai: the one command for a HOAI Claude Code agent folder

Usage:
  hoai                 start this folder's agent with the correct channel flag.
                       On a first run it starts a new conversation; after that
                       it brings the agent back with its own history.
  hoai -c              exactly the same as a bare hoai. So are --continue and
                       --resume: they are spellings people type, not different
                       modes, and none of them is passed on to claude.
  hoai --new           start a brand new conversation for this agent instead of
                       carrying on the old one. Nothing is deleted.
  hoai --force         launch straight away, without waiting for another claude
                       that looks like it is already running in this folder.
                       Use it when you know that other process is not this
                       agent. Can be combined: hoai --new --force.
  hoai --keep-alive    keep this agent running: when claude exits, start it
                       again on the same conversation, waiting 5 s at first
                       and up to 60 s when it keeps exiting (the Windows
                       logon task runs this).
  hoai doctor [...]    diagnose this host's HOAI agent setup
  hoai setup <CODE>    first run: add the marketplace, install HOAI, put the
                       hoai command on your PATH, then pair (this is the line
                       the app hands you; it works the same in bash, zsh and
                       Windows PowerShell)
  hoai pair <CODE>     pair this folder with a one time code from the HOAI app
  hoai <CODE>          shorthand for hoai pair <CODE> (BGOS-... / OC-... codes)
  hoai install-cli     put the hoai command on your PATH (or repair it)
  hoai logs            show the last 60 lines of this agent's daemon log
  hoai help            show this help

To restart the agent by hand: type /exit, then run hoai from the same folder.
There is no long claude command line to remember, and no channel flag to get
wrong: hoai works out the right one for this FOLDER every time it starts. If
the folder has an .mcp.json declaring a HOAI server, that is the channel it
launches; otherwise it goes by how the plugin itself was installed.

Run hoai from the agent's own folder: pairing bakes a ${FOLDER_PIN_FILE} pin
there, and a bare hoai launch self-resolves that identity with no env vars.
`

// -- main ---------------------------------------------------------------------

/** The real directory this script lives in (symlink shims resolved). */
function defaultScriptDir() {
  const self = fileURLToPath(import.meta.url)
  let resolved = self
  try {
    resolved = realpathSync(self)
  } catch {
    resolved = self
  }
  return dirname(resolved)
}

/**
 * @param {string[]} [argv]
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   cwd?: string,
 *   platform?: string,
 *   scriptDir?: string,
 *   readFile?: (path: string) => string | null,
 *   listDir?: (path: string) => string[],
 *   spawnImpl?: typeof spawn,
 *   print?: (line: string) => void,
 *   pollMs?: number,
 *   listProcesses?: () => Array<{ pid: number, uid?: number | null, comm: string, cwd: string | null }>,
 *   sleep?: (ms: number) => Promise<void>,
 *   incumbentTimeoutMs?: number,
 *   now?: () => number,
 *   healthyMs?: number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   pidAlive?: (pid: number) => boolean,
 *   pidProcess?: (pid: number) => { command: string | null, startedAtMs: number | null } | null,
 *   signals?: { once: (name: string, fn: () => void) => unknown, removeListener: (name: string, fn: () => void) => unknown },
 * }} [opts]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), opts = {}) {
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const cwd = opts.cwd ?? process.cwd()
  const platform = opts.platform ?? process.platform
  const scriptDir = opts.scriptDir ?? defaultScriptDir()
  const readFile = opts.readFile ?? defaultReadText
  const listDir = opts.listDir ?? defaultListDir
  const spawnImpl = opts.spawnImpl ?? spawn

  const { action, rest, fresh, force, keepAlive = false } = resolveHoaiAction(argv)

  if (action === 'help') {
    if (rest.length > 0 && !/^(help|-h|--help)$/i.test(rest[0] ?? '')) {
      console.error(`[hoai] unknown command: ${rest[0]}`)
    }
    process.stdout.write(USAGE)
    return 0
  }

  if (action === 'doctor') {
    // The doctor is a sibling bin/ tool; when this checkout predates it, node
    // reports the missing file on its own, which is the honest answer.
    return runSiblingScript(joinDir(scriptDir, 'bgos-doctor.mjs'), rest, spawnImpl)
  }

  if (action === 'pair') {
    return runSiblingScript(joinDir(scriptDir, 'bgos-pair.mjs'), rest, spawnImpl)
  }

  if (action === 'setup') {
    const parsed = parseSetupArgs(rest)
    if (!parsed.ok) {
      console.error(`[hoai] ${parsed.reason}`)
      return EXIT_SETUP_NO_CODE
    }
    return runSetup(parsed.pairArgs, { platform, env, home, scriptDir, spawnImpl })
  }

  if (action === 'install-cli') {
    // --force is the deliberate ask. Without it this command never replaces a
    // shim another install owns; with it, the owner has said so out loud.
    const force = rest.some((token) => String(token ?? '').trim().toLowerCase() === '--force')
    // Injected like every other effect in this file, so the --force wiring is
    // testable without writing to a real home.
    const installCli = opts.installCliImpl ?? installHoaiCli
    const outcome = await installCli({ platform, env, home, scriptDir, force })
    return outcome.ok ? 0 : 1
  }

  if (action === 'logs') {
    const id = logsAssistantId({ cwd, env, readFile })
    const path = hoaiLogPath({ env, home, assistantId: id })
    const text = readFile(path)
    if (text == null) {
      console.log(`[hoai] no log file yet. It would be at: ${path}`)
      console.log('[hoai] (a non-empty BGOS_LOG_FILE overrides that location)')
      return 0
    }
    const lines = lastLines(text, 60)
    console.log(`[hoai] last ${lines.length} line(s) of ${path}:`)
    for (const line of lines) console.log(line)
    return 0
  }

  // run
  const plan = buildRunPlan({ cwd, env, home, readFile, listDir, scriptDir })
  if (!plan.ok) {
    console.error(`[hoai] ${plan.reason}`)
    // Unattended, a refusal is an OUTCOME a supervisor must be able to count
    // and an owner to read later: no channel (named code 4), or a folder that
    // needs a person to say which agent it is (6). The line goes to the
    // service agent's launch-status, the one `hoai-agent status` shows.
    if (isSupervisedLaunch(env) || keepAlive) {
      const statusId = supervisedServiceId(env) || superviseAssistantId({ cwd, env, home, readFile, listDir })
      if (statusId) {
        ;(opts.writeFile ?? defaultWriteFile)(
          joinDir(joinDir(agentDir(home), statusId), LAUNCH_STATUS_FILE_NAME),
          `${launchStatusLine({ outcome: plan.code, fields: { detail: plan.reason } })}\n`,
        )
      }
      return plan.code === 'channel-unresolved' ? EXIT_CHANNEL_UNRESOLVED : EXIT_UNATTENDED_NEEDS_PERSON
    }
    return 1
  }
  console.log(plan.note)
  // The plan's environment and its hook entries are part of the launch, not
  // decoration: applied here, before claude is spawned, so the child inherits
  // the task tools flag and the session finds its forwarder registered.
  const applyEnv = { ...(plan.env ?? {}) }
  for (const [key, value] of Object.entries(applyEnv)) {
    if (!env[key]) env[key] = value
  }
  if (plan.hooks) {
    const register = opts.registerHooks ?? ensureHookEntries
    try {
      // Best effort, every launch: a folder scaffolded before the rail existed,
      // or one whose settings file a concurrent claude rewrote, gets it back
      // here or never.
      register(plan.hooks)
    } catch (err) {
      console.error(`[hoai] could not register the activity hooks: ${err?.message ?? err}`)
    }
  }
  // Pre-seed Claude Code's one-time prompts for THIS launch folder, on EVERY
  // launch, immediately before claude is spawned.
  //
  // WHY HERE and not only where an agent is created. preseedClaudeTrust had
  // exactly one production caller, the watcher's create-agent job
  // (lib/watcher-core.mjs). A hand-typed `hoai` seeded nothing, and a
  // hand-typed `hoai` is the line bgos-pair tells every user to run, so the
  // ordinary first install reached the trust dialog with nothing seeded and
  // stopped there with no error anywhere. Doing it on every launch rather than
  // once also REPAIRS agents paired by older versions, which is the half that
  // reaches machines already out there.
  //
  // Best effort by design: the seed is an unattended-launch convenience, and a
  // settings file we could not write must never be the reason a launch the user
  // asked for does not happen. The worst case without it is the prompt the user
  // is sitting in front of anyway.
  const preseed = opts.preseedTrust ?? preseedClaudeTrust
  try {
    preseed({ configDir: claudeConfigDir({ env, home }), cwd, env, home })
  } catch (err) {
    console.error(`[hoai] could not pre-seed the one-time prompts: ${err?.message ?? err}`)
  }
  if (fresh) {
    console.log(
      '[hoai] --new: starting a brand new conversation for this agent. The previous ' +
        'one stays on disk; it is simply not the one being resumed from now on.',
    )
  }
  // --keep-alive is stopped from outside (the logon task ending, the console
  // closing) by a signal. Turned into the loop's stop request, so the live
  // claude is ended and NOT relaunched; without it the loop would read the
  // signal-killed claude as one more exit to recover from.
  //
  // A supervised launch (run.sh) is stopped by a signal on EVERY stop too:
  // run.sh's on_stop kills the agent's tmux server, which hangs hoai up
  // (SIGHUP); without tmux it TERMs hoai's process group; systemd and launchd
  // TERM it at shutdown. Dying on the default action skipped superviseClaude's
  // finally, so supervisor.json outlived every stop, and after a reboot its
  // pid could be any live process: the agent refused to start behind it.
  // Handled here, the loop ends the session and the finally removes the file.
  // The handlers go with the launch (an injected emitter stands in for
  // `process` in tests).
  let signal = opts.signal ?? null
  let unwireStop = () => {}
  if ((keepAlive || isSupervisedLaunch(env)) && !signal) {
    const signals = opts.signals ?? process
    const controller = new AbortController()
    const stop = () => controller.abort()
    signals.once('SIGTERM', stop)
    signals.once('SIGHUP', stop)
    unwireStop = () => {
      signals.removeListener('SIGTERM', stop)
      signals.removeListener('SIGHUP', stop)
    }
    signal = controller.signal
  }
  try {
    return await superviseClaude(plan.args, {
      platform,
      env,
      home,
      cwd,
      scriptDir,
      readFile,
      listDir,
      spawnImpl,
      freshSession: fresh,
      force,
      keepAlive,
      signal,
      stdinIsTTY: opts.stdinIsTTY,
      print: opts.print,
      pollMs: opts.pollMs,
      pidAlive: opts.pidAlive,
      pidProcess: opts.pidProcess,
      listProcesses: opts.listProcesses,
      sleep: opts.sleep,
      incumbentTimeoutMs: opts.incumbentTimeoutMs,
      now: opts.now,
      healthyMs: opts.healthyMs,
      setTimer: opts.setTimer,
      clearTimer: opts.clearTimer,
      hasExpect: opts.hasExpect,
      expectExists: opts.expectExists,
    })
  } finally {
    unwireStop()
  }
}

/**
 * True when this file is the process entry point. Compares REAL paths on both
 * sides so a symlinked bin (npm/npx puts a shim in node_modules/.bin, and paths
 * under /tmp resolve through /private/tmp on macOS) still runs main(); a plain
 * href compare would fail those and silently do nothing.
 */
export function isRunAsMain(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (typeof argv1 !== 'string') return false
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1)
  } catch {
    return moduleUrl === pathToFileURL(argv1).href
  }
}

if (isRunAsMain()) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      console.error(`[hoai] fatal: ${err?.message ?? err}`)
      process.exitCode = 1
    })
}
