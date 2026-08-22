#!/usr/bin/env node
/**
 * hoai-core: the one command for a HOAI Claude Code agent folder.
 *
 * The troubleshooting story of one-click onboarding is "open the folder, run
 * hoai". Every decision lives HERE; bin/hoai (bash), bin/hoai.ps1 and
 * bin/hoai.cmd are thin dispatchers that only find a JS runtime and hand over.
 *
 *   hoai              launch the agent from this folder with the CORRECT
 *                     channel flag. The flag is detected, never guessed: on
 *                     2026-08-21 a marketplace install launched with the clone
 *                     spec dropped every inbound message silently. The launch
 *                     is SUPERVISED: while claude runs, hoai watches the
 *                     agent's state dir for a restart-requested.json marker
 *                     (written by the daemon's one-click update handler) and
 *                     relaunches claude with --continue when it appears, so
 *                     interactive sessions, Windows included, finally have a
 *                     restart authority.
 *   hoai doctor       diagnose this host (hands off to bin/bgos-doctor.mjs)
 *   hoai pair <CODE>  pair this folder (hands off to bin/bgos-pair.mjs); a
 *                     bare BGOS-/OC- code routes here too
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

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { detectInstallMethod, launchFlagArgs } from './bgos-install-method.mjs'

/** Mirror of bgos-pair.mjs FOLDER_PIN_FILE_NAME / agent-credentials.ts
 *  FOLDER_PIN_FILE: the launch-folder pin whose number IS the assistant id. */
export const FOLDER_PIN_FILE = '.bgos-agent-id'

/** The unsubstituted plugin userConfig placeholder is not a real assistant id
 *  (mirror of the constant in bgos-pair.mjs / agent-credentials.ts). */
const ASSISTANT_ID_PLACEHOLDER = '${user_config.assistant_id}'

/** POSIX convention for "command not found". */
export const EXIT_NOT_FOUND = 127

// -- Small pure helpers -------------------------------------------------------

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
 * Route argv to an action. The first token decides:
 *   (nothing) / run  -> run     doctor -> doctor     pair -> pair
 *   logs -> logs                help / -h / --help -> help
 * An unknown first token that LOOKS like a pair code (BGOS-... / OC-...)
 * routes to pair with itself prepended, so `hoai BGOS-7F3A-2K` just works.
 * Anything else routes to help (with the tokens kept, so main can name them).
 * @param {readonly string[]} argv
 * @returns {{ action: 'run' | 'doctor' | 'pair' | 'logs' | 'help', rest: string[] }}
 */
export function resolveHoaiAction(argv) {
  const args = Array.isArray(argv) ? argv.map((value) => String(value ?? '')) : []
  if (args.length === 0) return { action: 'run', rest: [] }
  const first = args[0]
  const lowered = first.toLowerCase()
  const rest = args.slice(1)
  if (lowered === 'run') return { action: 'run', rest }
  if (lowered === 'doctor') return { action: 'doctor', rest }
  if (lowered === 'pair') return { action: 'pair', rest }
  if (lowered === 'logs') return { action: 'logs', rest }
  if (lowered === 'help' || lowered === '-h' || lowered === '--help') {
    return { action: 'help', rest }
  }
  if (/^(BGOS|OC)-/i.test(first)) return { action: 'pair', rest: [first, ...rest] }
  return { action: 'help', rest: args }
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
  const detection = detectInstallMethod({
    scriptPath: joinDir(scriptDir, 'bgos-install-method.mjs'),
    env,
    home,
  })
  // Flag per method (see bgos-install-method.mjs launchFlagArgs): marketplace
  // installs use the approved --channels flag, which loads a store channel
  // with no confirmation prompt; only a local clone needs the dangerous flag.
  const args = ['--dangerously-skip-permissions', ...launchFlagArgs(detection.method)]
  const methodLine = `[hoai] install method: ${detection.method}; channel ${detection.channelSpec}`

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

/** Marker-triggered relaunch budget: 3 per rolling hour. A daemon stuck in
 *  an update-crash loop must not bounce the session forever. */
export const MAX_RELAUNCHES_PER_WINDOW = 3
export const RELAUNCH_WINDOW_MS = 60 * 60 * 1000
export const MARKER_POLL_MS = 3000

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
 * The args for a marker-triggered relaunch: FRESH install-method detection
 * (an update can move a marketplace cache dir, so the flag is re-detected,
 * never reused blind) plus --continue so the session resumes where it was
 * instead of starting cold.
 * @param {{ scriptDir?: string, env?: Record<string, string | undefined>, home?: string }} [opts]
 */
export function relaunchClaudeArgs({ scriptDir = '', env = process.env, home = homedir() } = {}) {
  const detection = detectInstallMethod({
    scriptPath: joinDir(scriptDir, 'bgos-install-method.mjs'),
    env,
    home,
  })
  return ['--dangerously-skip-permissions', ...launchFlagArgs(detection.method), '--continue']
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

/**
 * Launch claude and supervise it: while the child runs, poll the agent's
 * state dir for a restart-requested.json marker (written by the daemon's
 * update_rpc handler). Marker present: delete it, SIGTERM the child, await
 * its exit, and relaunch with the correct channel flags plus --continue.
 * This is the restart authority for interactive sessions, Windows included,
 * where no launchd/systemd service exists.
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

  const spawnOnce = (spawnArgs, onSpawn) =>
    spawnClaude(spawnArgs, { platform, env, spawnImpl, writeErr, onSpawn })

  const id = superviseAssistantId({ cwd, env, home, readFile, listDir })
  if (!id) return spawnOnce(args)
  const stateDir = joinDir(agentDir(home), id)
  const supervisorPath = joinDir(stateDir, SUPERVISOR_FILE_NAME)
  const markerPath = joinDir(stateDir, RESTART_MARKER_FILE_NAME)
  const body = supervisorFileBody(process.pid, new Date(now()).toISOString())
  if (!writeFile(supervisorPath, body)) {
    // No state dir to arm in: launch exactly as before, unsupervised.
    return spawnOnce(args)
  }
  // A marker left behind by a dead launcher is moot: this launch already
  // starts the newest installed code.
  if (exists(markerPath)) removeFile(markerPath)
  print(`[hoai] restart supervisor armed for assistant ${id}`)
  let relaunchesAt = []
  let exhausted = false
  let currentArgs = [...args]
  try {
    while (true) {
      /** @type {import('node:child_process').ChildProcess | null} */
      let childRef = null
      let restartRequested = false
      const exited = spawnOnce(currentArgs, (child) => {
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
      if (!restartRequested) return code
      currentArgs = relaunchClaudeArgs({ scriptDir, env, home })
      print(`[hoai] relaunching: claude ${currentArgs.join(' ')}`)
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
  hoai                 launch the agent from this folder with the correct channel flag
  hoai doctor [...]    diagnose this host's HOAI agent setup
  hoai pair <CODE>     pair this folder with a one time code from the HOAI app
  hoai <CODE>          shorthand for hoai pair <CODE> (BGOS-... / OC-... codes)
  hoai logs            show the last 60 lines of this agent's daemon log
  hoai help            show this help

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

  const { action, rest } = resolveHoaiAction(argv)

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
  return superviseClaude(plan.args, {
    platform,
    env,
    home,
    cwd,
    scriptDir,
    readFile,
    listDir,
    spawnImpl,
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
