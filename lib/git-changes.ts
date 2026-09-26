/**
 * The changes collector (HOAI P7 stage 3, C-31): read this agent's
 * uncommitted changes with read only Git, for the owner's Changes panel.
 *
 * The backend (backend/src/changes-panel/changes-view.ts) is the smart half.
 * It splits the patch into files, counts from numstat, masks secrets and caps
 * what reaches the app. This half is thin on purpose (spec F9): it runs Git
 * in the agent's working folder and sends the RAW output, each stream cut at
 * the byte cap the frame carries, plus the text of the first few untracked
 * files. The answer is spec 9.3's payload, `v: 1`.
 *
 * WHAT THE READ DEFENDS AGAINST, AND WHAT IT DOES NOT (fix round w6). It
 * defends the owner against untrusted repository CONTENT, what a clone
 * carries (a git binary planted in the folder, attributes, the files
 * themselves), and against Git WRITING the repository (the index refresh,
 * its locks). It does NOT defend against the agent itself: the agent runs as
 * the same user, with the same reach, on the same machine, and can already
 * run any program and read any file there, and the answer goes only to the
 * owner who owns that machine. A setting only the agent's own local config
 * or its .git file can make (core.worktree, a gitfile or GIT_DIR pointing
 * elsewhere, a clean filter, a promisor remote's programs) can mislead its
 * own panel; the checks that exist for those (the top folder rule,
 * GIT_NO_LAZY_FETCH, the Git floor) are defence in depth, and each rule
 * below says exactly what it covers. The git dir and the common dir are NOT
 * contained, on purpose: an agent that runs in a Git worktree keeps its
 * common dir outside its folder.
 *
 * The rules, and why each one is here (spec 10.1):
 *  - READ ONLY. The commands below are the whole list, after the one read of
 *    `git version` per Git path (GIT 2.36 OR LATER). None of them writes the
 *    index, the working tree or a ref (a lazy fetch, on a Git that does not
 *    know GIT_NO_LAZY_FETCH, would still add objects: see NO LAZY FETCH).
 *    One read still WOULD write: a diff that finds a file touched but
 *    unchanged refreshes its stat data and rewrites .git/index, and
 *    GIT_OPTIONAL_LOCKS=0 alone does not stop that (measured on Git 2.55, a
 *    scratch repository, 2026-09-26). The refresh is
 *    diff.autoRefreshIndex, so both diffs run with it off, and
 *    GIT_OPTIONAL_LOCKS=0 covers every other optional lock. The agent may be
 *    mid edit in this very folder; the panel must never be the thing that
 *    races it for the index lock.
 *  - GIT 2.36 OR LATER. From Git 2.36 core.fsmonitor=false (the next rule)
 *    reads as off; before it, the same setting is read as the path of a
 *    program to run (the review's finding W4-N3; Git's own 2.36.0 release
 *    notes do not name it, and no Git before 2.36 was run here). So the
 *    adapter reads `git version` for the Git path it resolves before any
 *    other command; a Git below 2.36, or a version it cannot read, answers
 *    read_failed in the words the Codex daemon sends for it too ("changes
 *    could not be read on the agent host: Git 2.36 or later is needed to read
 *    changes safely", round w7) and no other command runs (fix round w5,
 *    W4-N3). Only an ACCEPTED Git is kept, once per Git path: a refusal is
 *    read again at the next read, so an owner who updates Git needs no daemon
 *    restart (fix round w6, as lane C does). The floor stays 2.36: 2.45 would
 *    refuse Ubuntu 24.04's Git 2.43, which honours GIT_NO_LAZY_FETCH
 *    (measured by lane C in fix round w5, probe 2, on this machine's WSL, not
 *    under this lane's Windows Git). What the floor covers: the meaning of
 *    the fsmonitor flag below, nothing more; it is defence in depth.
 *  - NO FSMONITOR HOOK. core.fsmonitor in the repository's own config names
 *    a program Git runs when it reads the index; every command here turns it
 *    off on the command line (fix round w4, F1), so on a Git that passes the
 *    floor a panel read never runs the fsmonitor program that config names.
 *    That is the repository's local config, which no clone carries, so this
 *    is defence in depth. It is the one program this rule turns off: NOT
 *    TURNED OFF below names one that still runs, and NO LAZY FETCH the ones
 *    an older Git can still start.
 *  - NO LAZY FETCH, ON A GIT THAT KNOWS GIT_NO_LAZY_FETCH. In a partial
 *    clone a read that needs an object the clone left out asks the promisor
 *    remote for it, and that fetch runs the programs the repository's config
 *    names (the upload-pack program, a transport helper) and can wait on the
 *    network (measured on Git 2.55: the numstat ran the upload-pack program a
 *    clone's config named). Every command runs with GIT_NO_LAZY_FETCH=1, so
 *    on a Git that knows the variable such a read fails instead (fix round
 *    w5, W4-N1). Git's release notes first name it in 2.45.0 (with its
 *    --no-lazy-fetch flag), and Ubuntu 24.04's build of Git 2.43.0 honours it
 *    too (measured by lane C in fix round w5, probe 2, on this machine's WSL,
 *    not under this lane's Windows Git). A Git from 2.36 that does not know it
 *    passes the floor and can still fetch lazily in a partial clone: a
 *    documented gap. The variable, never the flag, which an older Git rejects
 *    as an unknown option. A promisor remote is the clone's local config, so
 *    this is defence in depth.
 *  - THE FOLDER IT IS GIVEN. The first command runs in the working folder and
 *    prints the repository root; every later command runs in that ROOT, so
 *    the tracked paths (Git prints them root relative) and the untracked names
 *    (which ls-files prints folder relative) agree. The process folder is
 *    never read: on a marketplace install it is the plugin cache. And the
 *    variables that would point Git at another repository whatever the
 *    folder says (GIT_DIR and friends) are dropped from its environment, in
 *    any spelling on Windows, whose names are case blind (fix round w4, F5).
 *  - THE TOP FOLDER INSIDE THE AGENT'S FOLDER. core.worktree in the
 *    repository's own config makes rev-parse print THAT folder as the root,
 *    wherever it is (measured on Git 2.55: every later command then read the
 *    other folder's own repository and a new file there was sent whole). So
 *    the root the first command prints must be the working folder or one of
 *    its ancestors, compared by what the host resolves each to (realpath, so
 *    a link, a junction or another case on Windows compares as the folder it
 *    is); anything else answers read_failed in the words the Codex daemon
 *    sends for it too ("changes could not be read on the agent host", fix
 *    round w6) and nothing else runs or is read (fix round w5, W4-N4). What
 *    it covers: the top folder, so the working tree the read walks and the
 *    files it opens. core.worktree is local config, so this is defence in
 *    depth. The git dir and the common dir are NOT checked (the threat model
 *    above): a gitfile pointing elsewhere still reads that repository's index
 *    and history against this folder.
 *  - NOT TURNED OFF: A CLEAN FILTER. A filter.<name>.clean program that the
 *    repository's own config names (and its attributes assign to a changed
 *    file) still runs on both diffs: Git passes the working file through it
 *    to compare it with HEAD (measured on Git 2.55, fix round w4). This is an
 *    ACCEPTED LIMIT, not an oversight (fix round w5), and the threat model
 *    above is why: it needs the repository's local config, which no clone
 *    carries, so it is something the agent set up on this host, and this
 *    daemon runs as the same user with the same reach as the agent. Unlike
 *    the fsmonitor there is no one switch that turns it off: filter names are
 *    free, so no -c can name them all ahead of time. And reading attributes
 *    from an empty tree instead (the --attr-source flag from Git 2.41, the
 *    attr.tree setting from Git 2.43, by Git's release notes) would raise the
 *    floor and still not cover .git/info/attributes. The long running
 *    filter.<name>.process form is the same mechanism (not measured here).
 *  - GIT BY ITS ABSOLUTE PATH. spawn('git', { cwd }) on Windows looks in the
 *    working folder BEFORE PATH (libuv's search_path, which uv_spawn hands
 *    the child's cwd; git.com is tried before git.exe), and a relative PATH
 *    entry does the same on any host. That folder holds the repository's
 *    files, and a cloned repository can carry a git.exe as an ordinary file
 *    (the untrusted CONTENT of the threat model), so that git.exe would run
 *    as the owner, outside the agent's own permission prompts, each time the
 *    owner opened the panel. Measured on node 24.16 and bun 1.3.9 on Windows
 *    (review round 1, D-R2). So Git is looked up on PATH's ABSOLUTE entries
 *    only and spawned by that path; no Git there reads as git_missing.
 *  - A STREAM CAP, NOT A BUFFER. stdout is read until the cap and then the
 *    child is killed and the read answers at once, never waiting on a close a
 *    launcher's grandchild can hold off (fix round w4, R-6), so a huge diff
 *    costs one megabyte and a flag, never a failed read (a maxBuffer overflow
 *    fails the whole call). An untracked file is the same: one handle,
 *    fstat'd before any byte is read, and read (at most the text cap and one
 *    byte) only while it is still the regular file the lstat saw (review
 *    round 1, D-R3; fix round w4, F7), so a file that grows is never loaded
 *    whole and a name swapped between the two is never read at all.
 *  - A BUDGET. Past budgetMs the running child is killed and the answer is
 *    too_slow; nothing more runs.
 *  - CAPS FROM THE FRAME, NEVER ABOVE THE DEFAULTS. The defaults are the
 *    backend's own CHANGES_FRAME_PAYLOAD numbers, and the backend refuses an
 *    answer past them, so a frame asking for more gets the defaults.
 *  - A BASENAME. The folder is the root's last name, never its path: an
 *    absolute path names the operating system user.
 *
 * Node APIs only (no Bun.*), so its tests run under tsx on node.
 */

import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  access as fsAccess,
  lstat as fsLstat,
  open as fsOpen,
  realpath as fsRealpath,
  stat as fsStat,
} from 'node:fs/promises'
import { posix as posixPath, win32 as win32Path } from 'node:path'

export type ChangesCaps = {
  maxPatchBytes: number
  maxNumstatBytes: number
  maxUntrackedListBytes: number
  maxUntrackedTextFiles: number
  maxUntrackedTextBytes: number
  budgetMs: number
}

/** The backend's CHANGES_FRAME_PAYLOAD numbers: the most this daemon ever reads. */
export const CHANGES_DEFAULT_CAPS: Readonly<ChangesCaps> = Object.freeze({
  maxPatchBytes: 1_048_576,
  maxNumstatBytes: 262_144,
  maxUntrackedListBytes: 65_536,
  maxUntrackedTextFiles: 20,
  maxUntrackedTextBytes: 65_536,
  budgetMs: 10_000,
})

/** A NUL in the first this many bytes makes an untracked file binary (Git's own rule). */
export const CHANGES_BINARY_SNIFF_BYTES = 8000
/** The folder name is cut here (spec 9.3). */
export const CHANGES_FOLDER_MAX = 120
/** The small commands print one line; this is plenty and bounds a surprise. */
const SMALL_OUTPUT_BYTES = 65_536
/** Kept from stderr, for telling "not a repository" from anything else. */
const STDERR_KEEP = 4096

const CAP_KEYS: ReadonlyArray<keyof ChangesCaps> = [
  'maxPatchBytes',
  'maxNumstatBytes',
  'maxUntrackedListBytes',
  'maxUntrackedTextFiles',
  'maxUntrackedTextBytes',
  'budgetMs',
]

/**
 * The frame's caps: each a positive whole number no larger than the default,
 * or the default. A missing field, a string, a fraction or a number above the
 * default all read as the default.
 */
export function readCaps(payload: unknown): ChangesCaps {
  const p =
    payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
  const out = { ...CHANGES_DEFAULT_CAPS }
  for (const key of CAP_KEYS) {
    const v = p[key]
    if (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= CHANGES_DEFAULT_CAPS[key]) out[key] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// running Git
// ---------------------------------------------------------------------------

export type GitRun = {
  /** The exit code, or null when the child was killed or never started. */
  code: number | null
  /** stdout, at most the cap. */
  stdout: Buffer
  stderr: string
  /** True when stdout reached the cap and the child was killed. */
  truncated: boolean
  /** The spawn error code (ENOENT when Git is not installed). */
  spawnError?: string
  /** True when the budget ran out while it ran. */
  aborted?: boolean
  /** Set when nothing was run because the Git is below the floor (fix round w5, W4-N3). */
  refused?: 'git_too_old'
}

export type RunGit = (
  args: readonly string[],
  opts: { cwd: string; env: Record<string, string | undefined>; maxBytes: number; signal: AbortSignal },
) => Promise<GitRun>

type ChildLike = {
  /** A Readable, so the adapter can close its own end at the cap (fix round w4, R-6). */
  stdout: (NodeJS.ReadableStream & { destroy(error?: Error): unknown }) | null
  stderr: NodeJS.ReadableStream | null
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
  kill(signal?: NodeJS.Signals | number): boolean
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string
    env: Record<string, string | undefined>
    stdio: ['ignore', 'pipe', 'pipe']
    windowsHide: boolean
  },
) => ChildLike

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && code ? code : 'spawn_failed'
}

/** Finds the Git to run: an absolute path, or null when no PATH entry holds one. */
export type FindGit = (env: Record<string, string | undefined>) => Promise<string | null>

export type FindGitDeps = {
  platform: string
  /** True when the path is a file this process may run. */
  isRunnable: (path: string) => Promise<boolean>
}

async function nodeIsRunnable(path: string): Promise<boolean> {
  try {
    const st = await fsStat(path)
    if (!st.isFile()) return false
    if (process.platform !== 'win32') await fsAccess(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** PATH's value. Windows spells the name Path and reads it case blind. */
function pathVariable(env: Record<string, string | undefined>, win: boolean): string {
  if (!win) return typeof env.PATH === 'string' ? env.PATH : ''
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === 'PATH' && typeof value === 'string') return value
  }
  return ''
}

/**
 * An entry that names a folder on its own, whatever folder Git runs in. Empty,
 * `.`, `bin`, a drive relative `C:tools` and a rooted `\tools` with no drive
 * all depend on the working folder, so they are never looked at.
 */
function isAbsoluteEntry(dir: string, win: boolean): boolean {
  if (win) return /^[A-Za-z]:[\\/]/.test(dir) || /^[\\/]{2}[^\\/]/.test(dir)
  return dir.startsWith('/')
}

/**
 * The Git lookup: the first absolute PATH entry holding `git.exe` (Windows) or
 * a runnable `git` (elsewhere), in PATH order. Never the working folder.
 */
export function createFindGit(deps: Partial<FindGitDeps> = {}): FindGit {
  const platform = deps.platform ?? process.platform
  const isRunnable = deps.isRunnable ?? nodeIsRunnable
  const win = platform === 'win32'
  return async (env) => {
    for (const raw of pathVariable(env, win).split(win ? ';' : ':')) {
      const dir = win ? raw.trim().replace(/^"(.*)"$/, '$1').trim() : raw
      if (!isAbsoluteEntry(dir, win)) continue
      const candidate = win ? `${dir.replace(/[\\/]+$/, '')}\\git.exe` : `${dir.replace(/\/+$/, '')}/git`
      if (await isRunnable(candidate)) return candidate
    }
    return null
  }
}

/** The oldest Git whose core.fsmonitor=false means off (fix round w5, W4-N3). */
export const CHANGES_GIT_FLOOR: Readonly<{ major: number; minor: number }> = Object.freeze({ major: 2, minor: 36 })

/** `git version`, read once per Git path before any other command. It reads no repository. */
const GIT_VERSION = ['version']

/**
 * True when `git version` printed a Git at or above the floor. It reads the
 * first line as "git version <major>.<minor>" and whatever follows (".0",
 * ".windows.3", " (Apple Git-145)"); anything else is not a version it can
 * trust, so it is false.
 */
export function gitVersionMeetsFloor(text: string): boolean {
  const line = String(text ?? '').split('\n')[0].replace(/\r$/, '').trim()
  const m = /^git version (\d+)\.(\d+)(?:[.\s]|$)/.exec(line)
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  return major > CHANGES_GIT_FLOOR.major || (major === CHANGES_GIT_FLOOR.major && minor >= CHANGES_GIT_FLOOR.minor)
}

/**
 * What the adapter knows of each Git path it resolved: a Git that met the
 * floor, or the version read still running. Only an acceptance stays once
 * the read settles (fix round w6, as lane C does). A refusal is let go, so the
 * next read asks again and a Git the owner updates in place is seen without a
 * restart; a version read that did not finish (it could not start, or the
 * budget stopped it) says nothing about the Git and is let go too.
 */
export type GitVersionCache = Map<string, Promise<boolean | GitRun>>

/** The daemon's one cache: server.ts makes an adapter per read, and the Git path rarely changes. */
const SHARED_GIT_VERSIONS: GitVersionCache = new Map()

/**
 * Run the Git that PATH names, by its absolute path (see the rule above),
 * through spawn, reading stdout until `maxBytes` and then killing the child.
 * Resolves once, never rejects: a spawn failure comes back as `spawnError`
 * (ENOENT too when no PATH entry holds Git), a budget abort as `aborted`, and
 * a Git below the floor as `refused`, with nothing run but `git version`.
 * PATH is looked up once per adapter; server.ts makes one per read. An
 * accepted Git's version is read once per Git path, in `versions` (the
 * daemon's own cache unless a test passes one); a refusal is read again at
 * the next read (fix round w6).
 */
export function createNodeRunGit(
  spawnImpl: SpawnLike = spawn as unknown as SpawnLike,
  findGit: FindGit = createFindGit(),
  versions: GitVersionCache = SHARED_GIT_VERSIONS,
): RunGit {
  let git: Promise<string | null> | null = null
  return async (args, opts) => {
    if (opts.signal.aborted) return { code: null, stdout: Buffer.alloc(0), stderr: '', truncated: false, aborted: true }
    git ??= findGit(opts.env).catch(() => null)
    const bin = await git
    if (!bin) return { code: null, stdout: Buffer.alloc(0), stderr: '', truncated: false, spawnError: 'ENOENT' }
    const floor = await meetsFloor(spawnImpl, bin, opts, versions)
    if (floor !== true) return floor
    return spawnGit(spawnImpl, bin, args, opts)
  }
}

/**
 * True when the Git at `bin` meets the floor. Otherwise the run to answer
 * with: `refused` for a Git below it (or a version it cannot read), or the
 * version read's own spawn error or abort. None of those is kept.
 */
async function meetsFloor(
  spawnImpl: SpawnLike,
  bin: string,
  opts: { cwd: string; env: Record<string, string | undefined>; maxBytes: number; signal: AbortSignal },
  versions: GitVersionCache,
): Promise<true | GitRun> {
  for (;;) {
    let entry = versions.get(bin)
    if (!entry) {
      const reading: Promise<boolean | GitRun> = spawnGit(spawnImpl, bin, GIT_VERSION, {
        ...opts,
        maxBytes: SMALL_OUTPUT_BYTES,
      }).then((run) => {
        // A version read that did not finish says nothing about the Git.
        const answer: boolean | GitRun =
          run.spawnError || run.aborted
            ? run
            : run.code === 0 && !run.truncated && gitVersionMeetsFloor(run.stdout.toString('utf8'))
        // Only an ACCEPTED Git is kept (fix round w6, as lane C does): a
        // refusal is read again at the next read, so a Git the owner updates
        // in place reads without a daemon restart. The reads already waiting
        // on this one still share its answer.
        if (answer !== true && versions.get(bin) === reading) versions.delete(bin)
        return answer
      })
      versions.set(bin, reading)
      entry = reading
    }
    const known = await entry
    if (known === true) return true
    if (known === false) {
      return { code: null, stdout: Buffer.alloc(0), stderr: '', truncated: false, refused: 'git_too_old' }
    }
    // Another read's budget stopped the version read this one was waiting on: read it again under this one's.
    if (known.aborted && !opts.signal.aborted) continue
    return known
  }
}

function spawnGit(
  spawnImpl: SpawnLike,
  bin: string,
  args: readonly string[],
  opts: { cwd: string; env: Record<string, string | undefined>; maxBytes: number; signal: AbortSignal },
): Promise<GitRun> {
  return new Promise<GitRun>((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let truncated = false
    let stderr = ''
    let settled = false
    let child: ChildLike | null = null

    const finish = (run: Omit<GitRun, 'stdout' | 'stderr' | 'truncated'>) => {
      if (settled) return
      settled = true
      opts.signal.removeEventListener('abort', onAbort)
      resolve({ ...run, stdout: Buffer.concat(chunks, size), stderr: stderr.slice(0, STDERR_KEEP), truncated })
    }
    const kill = () => {
      try {
        child?.kill()
      } catch {
        // Already gone.
      }
    }
    function onAbort() {
      kill()
      finish({ code: null, aborted: true })
    }

    if (opts.signal.aborted) {
      finish({ code: null, aborted: true })
      return
    }
    try {
      child = spawnImpl(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      finish({ code: null, spawnError: errorCode(err) })
      return
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated || settled) return
      const room = opts.maxBytes - size
      if (chunk.length > room) {
        if (room > 0) {
          chunks.push(chunk.subarray(0, room))
          size += room
        }
        truncated = true
        kill()
        // Answer now, never on 'close' (fix round w4, R-6, as lane C does):
        // a kill ends Git for Windows' cmd\git.exe launcher, but the git it
        // started can hold the pipes for as long as it lives, and the read
        // already has everything it will send. Closing our end of stdout
        // makes that git's next write fail, so it ends too.
        try {
          child?.stdout?.destroy()
        } catch {
          // Already closed.
        }
        finish({ code: null })
        return
      }
      chunks.push(chunk)
      size += chunk.length
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_KEEP) stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => finish({ code: null, spawnError: errorCode(err) }))
    child.on('close', (code) => finish({ code }))
  })
}

/** What the untracked step reads of a file: its kind, size and identity. */
export type ChangesStat = { isFile(): boolean; size: number; dev?: number; ino?: number }

/**
 * One open file. The untracked step calls stat() first and read() only when
 * the handle is still the regular file the lstat saw (fix round w4, F7).
 */
export type ChangesFileHandle = {
  /** The OPEN file's kind, size and identity (fstat), so a name swapped after an lstat shows. */
  stat(): Promise<ChangesStat>
  /** Reads at most `maxBytes` from the start, into a buffer of that size. */
  read(maxBytes: number): Promise<Uint8Array>
  close(): Promise<void>
}

/** The file reads the untracked step needs, and the realpath the folder check needs. */
export type ChangesFs = {
  /** What the host resolves a path to: links, junctions and, on Windows, its case (fix round w5, W4-N4). */
  realpath(path: string): Promise<string>
  lstat(path: string): Promise<ChangesStat>
  /** Opens `path` once, never through a symlink where the host can refuse one. Reads nothing. */
  open(path: string): Promise<ChangesFileHandle>
}

/**
 * O_NOFOLLOW refuses a symlink at the open and O_NONBLOCK keeps a FIFO put in
 * a file's place from blocking the open. Windows has neither (both are
 * undefined in fs.constants there); the file id check in readUntracked is
 * what catches a swapped name on that host.
 */
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)

export const nodeChangesFs: ChangesFs = {
  realpath: (path) => fsRealpath(path),
  lstat: (path) => fsLstat(path),
  open: async (path) => {
    const handle = await fsOpen(path, OPEN_FLAGS)
    return {
      stat: () => handle.stat(),
      read: async (maxBytes) => {
        const buf = Buffer.alloc(Math.max(0, maxBytes))
        let got = 0
        while (got < buf.length) {
          const { bytesRead } = await handle.read(buf, got, buf.length - got, got)
          if (bytesRead === 0) break
          got += bytesRead
        }
        return buf.subarray(0, got)
      },
      close: () => handle.close(),
    }
  },
}

// ---------------------------------------------------------------------------
// the answer
// ---------------------------------------------------------------------------

export type ChangesState = 'ok' | 'not_git' | 'no_commits' | 'git_missing'

export type ChangesUntrackedFile = { path: string; bytes: number; text?: string; binary?: true }

/** Spec 9.3, the `ok: true` payload the backend reads with readDaemonAnswer. */
export type ChangesPayload = {
  v: 1
  state: ChangesState
  folder: string
  branch: string | null
  head: string | null
  numstat: string
  numstatTruncated: boolean
  patch: string
  patchTruncated: boolean
  untracked: string
  untrackedTruncated: boolean
  untrackedFiles: ChangesUntrackedFile[]
  takenAt: string
}

export type ChangesCollectResult =
  | { ok: true; payload: ChangesPayload }
  | { ok: false; code: 'too_slow' | 'read_failed'; message: string }

export const CHANGES_TOO_SLOW_MESSAGE = 'reading the changes took longer than the time allowed'
/**
 * A Git below the floor (fix round w5, W4-N3), in the very words the Codex
 * daemon sends for the same refusal (its READ_FAILED_MESSAGE, a colon, then
 * its GIT_FLOOR_MESSAGE; round w7), so the owner reads one sentence whatever
 * the agent. The part after the colon says what the owner can do.
 */
export const CHANGES_GIT_TOO_OLD_MESSAGE =
  'changes could not be read on the agent host: Git 2.36 or later is needed to read changes safely'
/**
 * A root that is not the working folder or above it (fix round w5, W4-N4), in
 * the very words the Codex daemon sends for the same refusal (its
 * READ_FAILED_MESSAGE, fix round w6), so the owner reads one sentence whatever
 * the agent. It names neither folder.
 */
export const CHANGES_OUTSIDE_FOLDER_MESSAGE = 'changes could not be read on the agent host'

// The commands, whole (spec 10.1 item 7). Before them the adapter runs one
// Git read more: `git version`, once per Git path it resolves and accepts
// (GIT_VERSION above, the header's GIT 2.36 OR LATER rule; a refused Git is
// asked again at the next read, and none of these runs). Nothing else is
// ever run.
//
// The patch asks for Git's own a/ and b/ prefixes: a host whose config sets
// diff.mnemonicPrefix, diff.noprefix, diff.srcPrefix or diff.dstPrefix would
// otherwise write its own, and under diff.noprefix a top folder named a or b
// cannot be told from a prefix (lane B's review, B-3). numstat prints paths
// with no prefix at all, so it needs neither flag.
//
// The patch also asks for Git's short submodule format by name: a host whose
// config sets diff.submodule=log writes a moved submodule as
// "Submodule <path> <a>..<b>:" and its commit subjects, and =diff writes the
// submodule's own files inline. Neither starts with a diff --git line of its
// own, so the backend's splitter would hang them on the file before, or draw
// files numstat never names. Short is Git's default: one
// "diff --git a/<path> b/<path>" section whose two lines are the old and the
// new "Subproject commit" (lane C's review, C-R3, measured on Git 2.55).
// numstat is one "1 1 <path>" record under every setting, so it needs none.
//
// And every command starts with -c core.fsmonitor=false. core.fsmonitor in
// the repository's own config names a program Git runs each time it reads
// the index: both diffs and ls-files ran it, twice each, on Git 2.55 (fix
// round w4, F1, measured; the four small commands did not). The agent writes
// that config, so without the flag each panel read would run a program the
// agent picked, as the owner, outside the agent's own permission prompts. A
// -c on the command line wins over every config file. The small commands
// carry it too, so the rule is one line: no command here runs that hook.
// Only on Git 2.36 or later, where false means off; the adapter refuses an
// older Git before any of these runs (fix round w5, W4-N3). It turns off that
// hook and nothing else: a clean filter still runs (the header's NOT TURNED
// OFF rule).
const NO_FSMONITOR = ['-c', 'core.fsmonitor=false']
const GIT_TOPLEVEL = [...NO_FSMONITOR, 'rev-parse', '--show-toplevel']
const GIT_VERIFY_HEAD = [...NO_FSMONITOR, 'rev-parse', '--verify', '--quiet', 'HEAD']
const GIT_BRANCH = [...NO_FSMONITOR, 'symbolic-ref', '--quiet', '--short', 'HEAD']
const GIT_SHORT_HEAD = [...NO_FSMONITOR, 'rev-parse', '--short', 'HEAD']
const GIT_NUMSTAT = [
  ...NO_FSMONITOR,
  '-c',
  'core.quotepath=false',
  '-c',
  'diff.autoRefreshIndex=false',
  'diff',
  '--numstat',
  '-z',
  '--no-ext-diff',
  '--no-textconv',
  '--find-renames',
  'HEAD',
  '--',
]
const GIT_PATCH = [
  ...NO_FSMONITOR,
  '-c',
  'core.quotepath=false',
  '-c',
  'diff.autoRefreshIndex=false',
  '--no-pager',
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--submodule=short',
  '--find-renames',
  'HEAD',
  '--',
]
const GIT_UNTRACKED = [...NO_FSMONITOR, 'ls-files', '--others', '--exclude-standard', '-z']

/** Variables that would make Git read another repository whatever cwd says. */
const REPOSITORY_OVERRIDES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]

/**
 * Git's environment: a copy of the daemon's without the repository overrides.
 * A Windows environment name is case blind, so there Git reads Git_Dir as
 * GIT_DIR (measured on Git 2.55 through node's spawn, fix round w4, F5), and
 * every spelling of the eight is dropped. Elsewhere names are case sensitive
 * and Git reads only the capitals; another spelling is not Git's and stays.
 */
function gitEnv(base: Record<string, string | undefined>, platform: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base }
  if (platform === 'win32') {
    for (const key of Object.keys(env)) if (REPOSITORY_OVERRIDES.includes(key.toUpperCase())) delete env[key]
  } else {
    for (const key of REPOSITORY_OVERRIDES) delete env[key]
  }
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  env.LC_ALL = 'C'
  // No lazy fetch from a partial clone's promisor remote, on a Git that
  // knows the variable (fix round w5, W4-N1, the header's NO LAZY FETCH
  // rule, which names the gap on one that does not). Set in capitals over
  // whatever the daemon had: on Windows, where a second spelling could ride
  // along, node's spawn and bun's both hand the child the capital one
  // (measured, node 24.16 and bun 1.3.9).
  env.GIT_NO_LAZY_FETCH = '1'
  return env
}

/**
 * True when `top` is `work` or one of its ancestors. Windows compares names
 * case blind with either slash; elsewhere a name is exact. Another drive, a
 * folder below, or a sibling whose name only starts the same is not.
 */
function isSameOrAncestor(top: string, work: string, platform: string): boolean {
  const p = platform === 'win32' ? win32Path : posixPath
  const rel = p.relative(top, work)
  if (rel === '') return true
  if (p.isAbsolute(rel)) return false
  return rel.split(p.sep)[0] !== '..'
}

/** The last name of a path, either slash, trailing slashes ignored, cut at 120. */
export function folderName(path: string): string {
  const parts = String(path ?? '').split(/[\\/]+/).filter((p) => p.length > 0)
  return (parts.length ? parts[parts.length - 1] : '').slice(0, CHANGES_FOLDER_MAX)
}

function emptyPayload(state: ChangesState, folder: string, takenAt: string): ChangesPayload {
  return {
    v: 1,
    state,
    folder,
    branch: null,
    head: null,
    numstat: '',
    numstatTruncated: false,
    patch: '',
    patchTruncated: false,
    untracked: '',
    untrackedTruncated: false,
    untrackedFiles: [],
    takenAt,
  }
}

function firstLine(run: GitRun): string | null {
  if (run.code !== 0) return null
  const line = run.stdout.toString('utf8').split('\n')[0].replace(/\r$/, '').trim()
  return line || null
}

/** Stops the read quietly once the budget has already answered. */
class BudgetSpent extends Error {}

/** Stops the read with a read_failed the owner reads in these words (fix round w5). */
class ReadRefused extends Error {}

/**
 * Collect the uncommitted changes of the repository holding `workdir`.
 *
 * Resolves `{ ok: true, payload }` for every state (ok, not_git, no_commits,
 * git_missing), `{ ok: false, code: 'too_slow' }` past the budget,
 * `{ ok: false, code: 'read_failed' }` in plain words for a Git below 2.36 or
 * a root outside the working folder, and REJECTS on anything else (a Git
 * failure that is not one of those states); the handler answers a rejection
 * read_failed with its own words.
 */
export async function collectChanges(input: {
  workdir: string
  caps: ChangesCaps
  runGit: RunGit
  fs: ChangesFs
  now: () => number
  env?: Record<string, string | undefined>
  /** The host's platform (process.platform by default); decides how Git's environment names compare. */
  platform?: string
}): Promise<ChangesCollectResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<ChangesCollectResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ ok: false, code: 'too_slow', message: CHANGES_TOO_SLOW_MESSAGE })
    }, input.caps.budgetMs)
  })
  const reading = readChanges(input, controller.signal).catch((err: unknown): Promise<ChangesCollectResult> => {
    // A read the budget already answered ends quietly; a refusal answers in
    // its own words; anything else is real.
    if (err instanceof BudgetSpent) return new Promise<ChangesCollectResult>(() => {})
    if (err instanceof ReadRefused) return Promise.resolve({ ok: false, code: 'read_failed', message: err.message })
    throw err
  })
  try {
    return await Promise.race([reading, budget])
  } finally {
    clearTimeout(timer)
  }
}

async function readChanges(
  input: {
    workdir: string
    caps: ChangesCaps
    runGit: RunGit
    fs: ChangesFs
    now: () => number
    env?: Record<string, string | undefined>
    platform?: string
  },
  signal: AbortSignal,
): Promise<ChangesCollectResult> {
  const { caps } = input
  const platform = input.platform ?? process.platform
  const env = gitEnv(input.env ?? process.env, platform)
  const takenAt = new Date(input.now()).toISOString()
  const run = async (args: readonly string[], cwd: string, maxBytes: number): Promise<GitRun> => {
    if (signal.aborted) throw new BudgetSpent()
    const r = await input.runGit(args, { cwd, env, maxBytes, signal })
    if (signal.aborted || r.aborted) throw new BudgetSpent()
    // A Git below the floor ran nothing but its version (fix round w5, W4-N3).
    if (r.refused) throw new ReadRefused(CHANGES_GIT_TOO_OLD_MESSAGE)
    return r
  }
  const done = (payload: ChangesPayload): ChangesCollectResult => ({ ok: true, payload })

  // 1. The root, run in the working folder.
  const top = await run(GIT_TOPLEVEL, input.workdir, SMALL_OUTPUT_BYTES)
  if (top.spawnError === 'ENOENT') {
    // Node reports a spawn whose cwd does not exist as ENOENT too, so ENOENT
    // means Git is missing only while the folder is there.
    if (!(await folderExists(input.fs, input.workdir))) throw new Error('the working folder is not there')
    if (signal.aborted) throw new BudgetSpent()
    return done(emptyPayload('git_missing', folderName(input.workdir), takenAt))
  }
  if (top.spawnError) throw new Error(`git could not start (${top.spawnError})`)
  if (top.code !== 0) {
    if (top.code === 128 && /not a git repository/i.test(top.stderr)) {
      return done(emptyPayload('not_git', folderName(input.workdir), takenAt))
    }
    throw new Error(`git rev-parse --show-toplevel exited ${String(top.code)}`)
  }
  const root = firstLine(top)
  if (!root) throw new Error('git printed no repository root')
  // The root must be the working folder or above it, as the host resolves
  // both (fix round w5, W4-N4): a core.worktree can name any folder at all.
  const [realRoot, realWork] = await Promise.all([input.fs.realpath(root), input.fs.realpath(input.workdir)])
  if (signal.aborted) throw new BudgetSpent()
  if (!isSameOrAncestor(realRoot, realWork, platform)) throw new ReadRefused(CHANGES_OUTSIDE_FOLDER_MESSAGE)
  const folder = folderName(root)

  // 2. A first commit.
  const verify = await run(GIT_VERIFY_HEAD, root, SMALL_OUTPUT_BYTES)
  if (verify.spawnError) throw new Error(`git could not start (${verify.spawnError})`)
  if (verify.code !== 0) return done(emptyPayload('no_commits', folder, takenAt))

  // 3. Branch (null when detached) and head.
  const branch = firstLine(await run(GIT_BRANCH, root, SMALL_OUTPUT_BYTES))
  const head = firstLine(await run(GIT_SHORT_HEAD, root, SMALL_OUTPUT_BYTES))

  // 4 to 6. The three raw streams, each at its own cap.
  const stream = async (args: readonly string[], maxBytes: number) => {
    const r = await run(args, root, maxBytes)
    if (r.spawnError) throw new Error(`git could not start (${r.spawnError})`)
    if (!r.truncated && r.code !== 0) throw new Error(`git ${args.join(' ')} exited ${String(r.code)}`)
    return { text: r.stdout.toString('utf8'), truncated: r.truncated }
  }
  const numstat = await stream(GIT_NUMSTAT, caps.maxNumstatBytes)
  const patch = await stream(GIT_PATCH, caps.maxPatchBytes)
  const untracked = await stream(GIT_UNTRACKED, caps.maxUntrackedListBytes)

  // 7. The first untracked files. A name the cap cut (no NUL after it) is not read.
  const names = untracked.text.split('\0')
  names.pop()
  const untrackedFiles: ChangesUntrackedFile[] = []
  for (const name of names.filter((n) => n.length > 0).slice(0, caps.maxUntrackedTextFiles)) {
    if (signal.aborted) throw new BudgetSpent()
    untrackedFiles.push(await readUntracked(input.fs, root, name, caps.maxUntrackedTextBytes))
  }
  if (signal.aborted) throw new BudgetSpent()

  return done({
    v: 1,
    state: 'ok',
    folder,
    branch,
    head,
    numstat: numstat.text,
    numstatTruncated: numstat.truncated,
    patch: patch.text,
    patchTruncated: patch.truncated,
    untracked: untracked.text,
    untrackedTruncated: untracked.truncated,
    untrackedFiles,
    takenAt,
  })
}

async function folderExists(fs: ChangesFs, path: string): Promise<boolean> {
  try {
    const st = await fs.lstat(path)
    return !st.isFile()
  } catch {
    return false
  }
}

function wholeSize(size: number): number {
  return Number.isFinite(size) && size >= 0 ? Math.floor(size) : 0
}

/**
 * The same file, as far as the host can tell: the file ids match. A host that
 * reports no id (0 or none) cannot tell, and the kind check and the bounded
 * read still hold.
 */
function sameFile(a: ChangesStat, b: ChangesStat): boolean {
  const known = (s: ChangesStat) => typeof s.ino === 'number' && s.ino > 0
  if (!known(a) || !known(b)) return true
  return a.ino === b.ino && a.dev === b.dev
}

/**
 * One untracked name, read under the root. A regular file within the text cap
 * is read: a NUL in its first 8,000 bytes makes it binary, else it is text. A
 * larger one is its size only. A symlink or anything that is not a regular
 * file is binary with its size, never followed. The read is ONE handle, and
 * that handle is fstat'd BEFORE any byte is read (fix round w4, F7): a name
 * that is no longer the regular file the lstat saw (swapped for a link or a
 * device) is its lstat size with not one byte read, and a file the fstat shows
 * already past the cap is its size, unread. Only the same regular file is
 * read, at most the cap and one byte, so one that grows between the fstat and
 * the read is still its size only. A name that cannot be read (gone since the
 * list, or refused) is its name with no text, which the backend shows as not
 * drawn. The handle is always closed.
 */
async function readUntracked(fs: ChangesFs, root: string, name: string, maxText: number): Promise<ChangesUntrackedFile> {
  const full = `${root.replace(/[\\/]+$/, '')}/${name}`
  let st: ChangesStat
  try {
    st = await fs.lstat(full)
  } catch {
    return { path: name, bytes: 0 }
  }
  const size = wholeSize(st.size)
  if (!st.isFile()) return { path: name, bytes: size, binary: true }
  if (size > maxText) return { path: name, bytes: size }
  let handle: ChangesFileHandle
  try {
    handle = await fs.open(full)
  } catch {
    return { path: name, bytes: size }
  }
  try {
    const now = await handle.stat()
    // Swapped since the lstat: no longer a regular file, or another file. Nothing is read.
    if (!now.isFile() || !sameFile(st, now)) return { path: name, bytes: size }
    // Grown past the cap since the lstat: its size, nothing read.
    const nowSize = wholeSize(now.size)
    if (nowSize > maxText) return { path: name, bytes: nowSize }
    const read = await handle.read(maxText + 1)
    const data = Buffer.from(read.buffer, read.byteOffset, read.byteLength)
    // It grew past the cap between the fstat and the read.
    if (data.length > maxText) return { path: name, bytes: Math.max(nowSize, data.length) }
    if (data.subarray(0, CHANGES_BINARY_SNIFF_BYTES).includes(0)) return { path: name, bytes: data.length, binary: true }
    return { path: name, bytes: data.length, text: data.toString('utf8') }
  } catch {
    return { path: name, bytes: size }
  } finally {
    await handle.close().catch(() => {})
  }
}
