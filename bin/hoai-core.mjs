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
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
import { buildLaunchRecipe, writeLaunchRecipe } from '../lib/agent-inventory.mjs'
import { observeMarketplaceInstall } from '../lib/plugin-cli.mjs'
import {
  MCP_CONFIG_FILE_NAME,
  parseMcpChannelServerName,
} from '../lib/service-supervision.mjs'
import { WIN_PATH_HELPER_FILE, installWrapper } from '../lib/hoai-wrapper-install.mjs'

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
 * Classify one token as a run flag: 'resume' (a synonym of bare `hoai`),
 * 'new' (force a fresh session), or null (not a run flag).
 * @param {unknown} token
 * @returns {'resume' | 'new' | null}
 */
export function classifyRunFlag(token) {
  const value = String(token ?? '')
    .trim()
    .toLowerCase()
  if (!value) return null
  if (RUN_RESUME_FLAGS.includes(value)) return 'resume'
  if (RUN_FRESH_FLAGS.includes(value)) return 'new'
  return null
}

/**
 * Route argv to an action. The first token decides:
 *   (nothing) / run  -> run     doctor -> doctor     pair -> pair
 *   setup -> setup              logs -> logs         help / -h / --help -> help
 *   install-cli -> install-cli (put the hoai command on PATH)
 * A run flag (-c / --continue / --resume, and --new) routes to run, either as
 * the first token or right after `run`; `fresh` says which kind it was.
 * An unknown first token that LOOKS like a pair code (BGOS-... / OC-...)
 * routes to pair with itself prepended, so `hoai BGOS-7F3A-2K` just works.
 * Anything else routes to help (with the tokens kept, so main can name them).
 * @param {readonly string[]} argv
 * @returns {{ action: 'run' | 'doctor' | 'pair' | 'setup' | 'logs' | 'install-cli' | 'help',
 *             rest: string[], fresh: boolean }}
 */
export function resolveHoaiAction(argv) {
  const args = Array.isArray(argv) ? argv.map((value) => String(value ?? '')) : []
  const route = (action, rest, fresh = false) => ({ action, rest, fresh })
  if (args.length === 0) return route('run', [])
  const first = args[0]
  const lowered = first.toLowerCase()
  const rest = args.slice(1)
  if (lowered === 'run') {
    const flag = classifyRunFlag(rest[0])
    return flag ? route('run', rest.slice(1), flag === 'new') : route('run', rest)
  }
  if (lowered === 'doctor') return route('doctor', rest)
  if (lowered === 'pair') return route('pair', rest)
  if (lowered === 'setup') return route('setup', rest)
  if (lowered === 'logs') return route('logs', rest)
  if (lowered === 'install-cli') return route('install-cli', rest)
  if (lowered === 'help' || lowered === '-h' || lowered === '--help') {
    return route('help', rest)
  }
  const runFlag = classifyRunFlag(first)
  if (runFlag) return route('run', rest, runFlag === 'new')
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
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, home?: string,
 *   readFile?: (path: string) => string | null, scriptDir?: string }} [opts]
 * @returns {{ spec: string, source: 'workspace' | 'install-method',
 *             method: string, serverName: string, conflict: boolean }}
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
    }
  }
  return {
    spec: detection.channelSpec,
    source: 'install-method',
    method: detection.method,
    serverName: '',
    conflict: declared === 'conflict',
  }
}

/** The full claude argv prefix for a launch from `cwd`: the permissions flag
 *  plus the channel flag pair for the resolved spec. One place, so the launch
 *  path and the relaunch path can never disagree about the spec. */
export function launchArgsFor(resolution) {
  return ['--dangerously-skip-permissions', ...channelFlagArgsForSpec(resolution.spec)]
}

/** The human line explaining WHICH channel was chosen and why. */
export function channelNote(resolution) {
  if (resolution.source === 'workspace') {
    return (
      `[hoai] channel ${resolution.spec} (declared by this folder's ${MCP_CONFIG_FILE_NAME}; ` +
      `install method ${resolution.method})`
    )
  }
  const conflictNote = resolution.conflict
    ? ` (this folder's ${MCP_CONFIG_FILE_NAME} declares MORE than one HOAI server, so it was ` +
      'not used; name exactly one to make the choice explicit)'
    : ''
  return `[hoai] install method: ${resolution.method}; channel ${resolution.spec}${conflictNote}`
}

// -- The run plan -------------------------------------------------------------

/**
 * Decide HOW a bare `hoai` launches the agent from this folder.
 *
 * The channel flag comes from install-method detection (the sibling
 * bgos-install-method.mjs is the evidence path). Identity precedence mirrors
 * the daemon's own resolver (lib/agent-credentials.ts):
 *   1. a <cwd>/.bgos-agent-id folder pin: launch is safe, the daemon
 *      self-resolves from the pin, NO env var needed;
 *   2. an explicit BGOS_ASSISTANT_ID env pin: also safe;
 *   3. neither, and MORE THAN ONE credentials-<id>.json under
 *      <home>/.bgos-agent: refuse with both remedies, because the daemon
 *      would refuse to boot for the same reason and a launch that dies at
 *      boot is worse than a clear message here;
 *   4. neither, and zero or one paired agent: launch, the daemon resolves it.
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
 *             detection: { method: string, channelSpec: string, pluginRoot: string } }
 *         | { ok: false, reason: string }}
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
  void exists // reserved for future probes; kept so callers can inject it now
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

  const folderPin = readFolderPin(cwd, readFile)
  if (folderPin) {
    return {
      ok: true,
      command: 'claude',
      args,
      detection,
      note:
        `${methodLine}\n` +
        `[hoai] launching as assistant ${folderPin} via the ${FOLDER_PIN_FILE} folder pin; ` +
        `no BGOS_ASSISTANT_ID env pin is needed, the daemon self-resolves from this folder.`,
    }
  }

  const envId = configuredAssistantId(env)
  if (envId) {
    return {
      ok: true,
      command: 'claude',
      args,
      detection,
      note: `${methodLine}\n[hoai] launching as assistant ${envId} (BGOS_ASSISTANT_ID env pin).`,
    }
  }

  const ids = listPairedAssistantIds(home, listDir)
  if (ids.length > 1) {
    // Short mirror of lib/agent-credentials.ts formatCredentialsRefusal: the
    // daemon itself refuses to boot unpinned on a multi-agent host.
    return {
      ok: false,
      reason:
        `this host has ${ids.length} paired agents (ids: ${ids.join(', ')}) and this folder ` +
        `has no ${FOLDER_PIN_FILE} pin, so hoai cannot tell which one to launch. ` +
        `Run hoai from the agent's own folder (pairing bakes the pin there), ` +
        `or set BGOS_ASSISTANT_ID=${ids[0]} in this agent's environment.`,
    }
  }
  const identityLine =
    ids.length === 1
      ? `[hoai] launching as this host's sole paired agent (assistant ${ids[0]}); the daemon self-resolves.`
      : `[hoai] no pairing on this host yet; if the agent cannot connect, run: hoai pair <CODE> (code from the HOAI app).`
  return { ok: true, command: 'claude', args, detection, note: `${methodLine}\n${identityLine}` }
}

// -- The supervise loop (one-click updates) -----------------------------------

/** Mirror of lib/update-readiness.ts SUPERVISOR_FILE / RESTART_MARKER_FILE:
 *  the daemon detects and pokes this launcher through these two files in the
 *  agent's state dir (~/.bgos-agent/<id>/). Pinned by
 *  test/update-readiness.test.ts, which imports both sides. */
export const SUPERVISOR_FILE_NAME = 'supervisor.json'
export const RESTART_MARKER_FILE_NAME = 'restart-requested.json'
/** The agent's pinned resume identity (GAP 1: identity-safe relaunch). A UUID
 *  minted once and stored here so every (re)launch resumes THIS agent's own
 *  session by id, never `--continue` (newest-in-shared-cwd, the identity bleed
 *  that caused the 2026-08-23 fleet incident). */
export const SESSION_ID_FILE_NAME = 'session-id'

/** Marker-triggered relaunch budget: 3 per rolling hour. A daemon stuck in
 *  an update-crash loop must not bounce the session forever. */
export const MAX_RELAUNCHES_PER_WINDOW = 3
export const RELAUNCH_WINDOW_MS = 60 * 60 * 1000
export const MARKER_POLL_MS = 3000

/** How long a relaunched session must survive to count as healthy. A resumed
 *  relaunch that dies faster than this (non-zero) is treated as a rejected
 *  resume and retried once as a fresh session, so the supervisor never leaves
 *  the agent dead after its own kill. Mirrors the tmux/expect keepalive.sh
 *  "resumed session died in <25s, retrying fresh" window. */
export const RELAUNCH_HEALTHY_MS = 25_000

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
  const pinned = readFolderPin(cwd, readFile) || configuredAssistantId(env)
  if (pinned) return /^\d+$/.test(pinned) ? pinned : ''
  const ids = listPairedAssistantIds(home, listDir)
  return ids.length === 1 ? ids[0] : ''
}

/** supervisor.json body: what the daemon validates before trusting this
 *  launcher as a restart authority (the pid must still be alive and the
 *  relaunch capability must be declared). */
export function supervisorFileBody(pid, startedAt) {
  return JSON.stringify({ pid, capabilities: ['relaunch'], startedAt })
}

/**
 * Pure relaunch budget: prior marker-relaunch timestamps plus now in,
 * decision out. `recent` is the pruned rolling window the caller keeps.
 * @param {readonly number[]} relaunchesAt
 * @param {number} now
 * @returns {{ allow: boolean, recent: number[] }}
 */
export function decideMarkerRelaunch(relaunchesAt, now) {
  const recent = (Array.isArray(relaunchesAt) ? relaunchesAt : []).filter(
    (at) => Number.isFinite(at) && now - at < RELAUNCH_WINDOW_MS,
  )
  return { allow: recent.length < MAX_RELAUNCHES_PER_WINDOW, recent }
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
 *   - a valid authority (integer pid + 'relaunch' cap) whose pid is ALIVE and
 *     is not our own                            -> refuse, name the owner
 *   - our own pid, a dead pid, malformed json, or a body without the relaunch
 *     capability                                -> arm and reclaim (a crashed
 *                                                  prior run left a stale file)
 * @param {{ existingRaw: string | null | undefined, ownPid: number,
 *   pidAlive?: (pid: number) => boolean }} params
 * @returns {{ arm: true, reclaimedStale?: true } | { arm: false, ownerPid: number }}
 */
export function decideSupervisorArming({ existingRaw, ownPid, pidAlive = defaultPidAlive }) {
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
  if (pidAlive(pid)) return { arm: false, ownerPid: pid }
  return { arm: true, reclaimedStale: true }
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

/**
 * A minimal expect script that spawns claude and auto-accepts the startup gate,
 * mirroring the fleet's proven run.expect: the Claude Code TUI splits words
 * with cursor-move escapes, so only the single contiguous word "confirm" (every
 * selection prompt's "Enter to confirm" footer) matches the raw PTY stream;
 * sending Enter on it accepts folder-trust, dev-channels, and bypass gates
 * alike. It stops on the live-TUI markers, nudges Enter on an unrecognised
 * prompt, then hands off with interact so a human at the terminal is still
 * relayed. A SIGTERM trap kills the spawned claude before exiting, so when the
 * supervisor SIGTERMs this expect process claude cannot be orphaned into a
 * second live session (which would reintroduce the identity bleed).
 *
 * Each arg is brace-quoted (Tcl literal, no substitution) so a future arg with
 * a space or a Tcl-special char cannot break or inject into the script; today's
 * args are fixed flags plus a regex-validated UUID, so this is defense in depth.
 * @param {{ claudePath: string, args: readonly string[] }} params
 * @returns {string}
 */
export function buildGateAutoAcceptExpect({ claudePath, args }) {
  const quoted = (args ?? []).map((a) => `{${a}}`).join(' ')
  const spawnLine = quoted ? `spawn ${claudePath} ${quoted}` : `spawn ${claudePath}`
  return [
    'set timeout 12',
    'set done 0',
    spawnLine,
    // Kill the spawned claude on SIGTERM so a supervisor kill never orphans it.
    'trap {catch {exec kill [exp_pid]}; exit 143} SIGTERM',
    'for {set i 0} {$i < 6 && !$done} {incr i} {',
    '  expect {',
    '    -re {(?i)experimental} { set done 1 }',
    '    -re {(?i)connecting}   { set done 1 }',
    '    -re {(?i)confirm}      { sleep 1; send "\\r" }',
    '    timeout                { send "\\r" }',
    '    eof                    { exit 1 }',
    '  }',
    '}',
    'set timeout -1',
    'interact',
  ].join('\n')
}

/**
 * The args for a relaunch: the channel resolved FRESH (an update can move a
 * marketplace cache dir, and a workspace can gain or lose an .mcp.json, so the
 * spec is re-resolved and never reused blind) plus the caller's identity-safe
 * session args (--resume <own-id> / --session-id <own-id>, or [] for a plain
 * fresh session). NEVER --continue: that resumes the newest session in a shared
 * cwd, which is another agent's (GAP 1).
 * @param {{ scriptDir?: string, env?: Record<string, string | undefined>,
 *   home?: string, cwd?: string, readFile?: (path: string) => string | null,
 *   sessionArgs?: readonly string[] }} [opts]
 */
export function relaunchClaudeArgs({
  scriptDir = '',
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  readFile = defaultReadText,
  sessionArgs = [],
} = {}) {
  // Resolved the SAME way as the first launch (workspace .mcp.json first, then
  // detection). A relaunch that resolved the channel differently from the
  // launch would bring the agent back deaf on a spec it was never listening on,
  // and the marker relaunch path is unattended, so nobody would see it happen.
  const resolution = resolveChannelSpec({ cwd, env, home, readFile, scriptDir })
  return [...launchArgsFor(resolution), ...sessionArgs]
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
    writeFileSync(path, content)
    return true
  } catch {
    return false
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

/** Is `expect` available to auto-accept the dev-channels startup gate? Never on
 *  win32 (no expect; win32 uses the console-input helper instead). */
function defaultHasExpect(platform) {
  if (platform === 'win32') return false
  return ['/usr/bin/expect', '/opt/homebrew/bin/expect', '/usr/local/bin/expect', '/bin/expect'].some(
    (p) => {
      try {
        return existsSync(p)
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
 *   generateId?: () => string, hasExpect?: boolean,
 *   freshSession?: boolean,
 * }} [opts]
 * @returns {Promise<number>}
 */
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
  const generateId = opts.generateId ?? randomUUID
  const hasExpect = opts.hasExpect ?? defaultHasExpect(platform)
  const freshSession = opts.freshSession === true

  // GAP 2: a clone (dev) launch shows the dev-channels confirm prompt at
  // (re)start; an unattended supervised launch strands on it. When expect is
  // available, spawn claude under it and auto-accept the gate (mirror of the
  // fleet's run.expect); otherwise spawn directly and warn once.
  let warnedGate = false
  const spawnGateHelper = opts.spawnGateHelper ?? defaultSpawnGateHelper
  const spawnSupervised = (spawnArgs, onSpawn) => {
    const method = relaunchInstallMethod({ scriptDir, env, home })
    if (relaunchNeedsGateAutoAccept(method)) {
      if (platform === 'win32') {
        // No expect on Windows: claude gets the console, and a hidden helper
        // attached to that same console accepts the gate once it is on screen.
        const exited = spawnClaude(spawnArgs, { platform, env, spawnImpl, writeErr, onSpawn })
        try {
          const helper = spawnGateHelper({ scriptDir, consolePid: process.pid, spawnImpl, writeErr, home })
          print(`[hoai] dev-channels gate helper armed (helper pid ${helper?.pid ?? '?'}, console ${process.pid})`)
        } catch (err) {
          writeErr(`[hoai] could not start the dev-channels gate helper: ${err?.message ?? err}\n`)
        }
        return exited
      }
      if (hasExpect) {
        const script = buildGateAutoAcceptExpect({ claudePath: 'claude', args: spawnArgs })
        return spawnExpectScript(script, { spawnImpl, writeErr, onSpawn })
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
    return spawnClaude(spawnArgs, { platform, env, spawnImpl, writeErr, onSpawn })
  }

  const id = superviseAssistantId({ cwd, env, home, readFile, listDir })
  if (!id) return spawnSupervised(args)
  const stateDir = joinDir(agentDir(home), id)
  const supervisorPath = joinDir(stateDir, SUPERVISOR_FILE_NAME)
  const markerPath = joinDir(stateDir, RESTART_MARKER_FILE_NAME)
  // Singleton guard: never start a second session behind a live supervisor.
  const arming = decideSupervisorArming({
    existingRaw: readFile(supervisorPath),
    ownPid: process.pid,
    pidAlive,
  })
  if (!arming.arm) {
    print(
      `[hoai] assistant ${id} is already supervised by a live launcher (pid ${arming.ownerPid}). ` +
        'Not starting a second session. If that launcher is actually stale, remove ' +
        `${supervisorPath} and re-run hoai; only stop pid ${arming.ownerPid} after confirming ` +
        'it really is this agent (a reused pid could be an unrelated process).',
    )
    return EXIT_ALREADY_SUPERVISED
  }
  const body = supervisorFileBody(process.pid, new Date(now()).toISOString())
  if (!writeFile(supervisorPath, body)) {
    // No state dir to arm in: launch exactly as before, unsupervised.
    return spawnSupervised(args)
  }
  // A marker left behind by a dead launcher is moot: this launch already
  // starts the newest installed code.
  if (exists(markerPath)) removeFile(markerPath)
  print(`[hoai] restart supervisor armed for assistant ${id}`)

  // Launch recipe (design 1.7): what a per-machine watcher needs to relaunch
  // THIS agent as itself in this folder when no supervisor is alive any more
  // (lib/agent-inventory.mjs readLaunchRecipe). Written at arm time and on
  // every relaunch; existence-only for others (contents are re-validated on
  // read). It never carries a session id (buildLaunchRecipe strips the
  // session args; hoai resumes its own pin itself) nor a token. Best effort:
  // a failed write changes nothing about this launch.
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
        argv: launchArgs,
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

  let relaunchesAt = []
  let exhausted = false
  let currentArgs = [...args, ...sessionArgsFor(pinnedId, sessionExistsNow())]
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
  try {
    while (true) {
      /** @type {import('node:child_process').ChildProcess | null} */
      let childRef = null
      let restartRequested = false
      const startedAt = now()
      const exited = spawnSupervised(currentArgs, (child) => {
        childRef = child
      })
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
        print('[hoai] restart requested by the daemon; restarting claude to pick up the update...')
        try {
          childRef.kill()
        } catch {
          // The child already died; its exit resolves the loop below.
        }
      }, pollMs)
      const code = await exited
      clearInterval(poller)
      if (restartRequested) {
        // A daemon-driven update restart: relaunch THIS agent's OWN session
        // (resume it when its transcript exists, else create it again by
        // id; never --continue), and give this cycle a fresh fallback.
        currentArgs = relaunchClaudeArgs({
          scriptDir,
          env,
          home,
          cwd,
          readFile,
          sessionArgs: sessionArgsFor(pinnedId, sessionExistsNow()),
        })
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
      const recovery = decideRelaunchRecovery({
        isResumeAttempt: currentArgs.includes('--resume') || lastLaunchWasRelaunch,
        exitCode: code,
        elapsedMs: now() - startedAt,
        freshTried,
      })
      if (recovery.action === 'retry-fresh') {
        freshTried = true
        lastLaunchWasRelaunch = false
        const freshId = String(generateId()).trim()
        // Mint and pin a NEW id so future relaunches resume the healthy session.
        // If the re-pin write fails, launch a PLAIN fresh session (claude mints
        // its own id): never --session-id an id that already exists (it errors),
        // and never --resume the session we just fled.
        let freshSessionArgs
        if (freshId && writeFile(sessionIdPath, freshId)) {
          pinnedId = freshId
          freshSessionArgs = sessionArgsFor(freshId, false)
        } else {
          freshSessionArgs = []
        }
        currentArgs = relaunchClaudeArgs({ scriptDir, env, home, cwd, readFile, sessionArgs: freshSessionArgs })
        recordRecipe(currentArgs)
        print(
          '[hoai] the resumed session exited immediately (a rejected resume or a fast ' +
            'fault); relaunching a FRESH own session so the agent is not left down...',
        )
        continue
      }
      return code
    }
  } finally {
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
  return readFolderPin(cwd, readFile) || configuredAssistantId(env) || 'unknown'
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
 * surface. cmd.exe exits 9009 when claude.cmd does not exist, which the
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
export function spawnClaude(args, { platform = process.platform, env = process.env, spawnImpl = spawn, writeErr = (text) => process.stderr.write(text), onSpawn } = {}) {
  const candidates = claudeSpawnCandidates(args, platform, env)
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
        child = spawnImpl(candidate.file, candidate.args, { stdio: 'inherit', shell: false })
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
 * @returns {Promise<string>} '' when neither source yields a root
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
  return String(detection?.pluginRoot ?? '').trim()
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
 * @returns {Promise<{ ok: boolean, binDir: string }>}
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
} = {}) {
  const pluginRoot = await resolveRoot({ env, home, scriptDir })
  if (!pluginRoot) {
    print('[hoai] could not work out where the plugin lives, so the hoai command was not installed.')
    return { ok: false, binDir: '' }
  }
  const result = installImpl({
    pluginRoot,
    platform,
    env,
    home,
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
  return { ok: result.ok, binDir: result.binDir }
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
  { spawnImpl = spawn, writeErr = (text) => process.stderr.write(text), onSpawn } = {},
) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl('expect', ['-c', script], { stdio: 'inherit', shell: false })
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

  const { action, rest, fresh } = resolveHoaiAction(argv)

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
    const outcome = await installHoaiCli({ platform, env, home, scriptDir })
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
    return 1
  }
  console.log(plan.note)
  if (fresh) {
    console.log(
      '[hoai] --new: starting a brand new conversation for this agent. The previous ' +
        'one stays on disk; it is simply not the one being resumed from now on.',
    )
  }
  return superviseClaude(plan.args, {
    platform,
    env,
    home,
    cwd,
    scriptDir,
    readFile,
    listDir,
    spawnImpl,
    freshSession: fresh,
  })
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
