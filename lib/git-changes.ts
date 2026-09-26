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
 * The rules, and why each one is here (spec 10.1):
 *  - READ ONLY. The commands below are the whole list. None of them writes the
 *    index, the working tree or a ref. One read still WOULD write: a diff
 *    that finds a file touched but unchanged refreshes its stat data and
 *    rewrites .git/index, and GIT_OPTIONAL_LOCKS=0 alone does not stop that
 *    (measured on Git 2.55, a scratch repository, 2026-09-26). The refresh is
 *    diff.autoRefreshIndex, so both diffs run with it off, and
 *    GIT_OPTIONAL_LOCKS=0 covers every other optional lock. The agent may be
 *    mid edit in this very folder; the panel must never be the thing that
 *    races it for the index lock.
 *  - THE FOLDER IT IS GIVEN. The first command runs in the working folder and
 *    prints the repository root; every later command runs in that ROOT, so
 *    the tracked paths (Git prints them root relative) and the untracked names
 *    (which ls-files prints folder relative) agree. The process folder is
 *    never read: on a marketplace install it is the plugin cache. And the
 *    variables that would point Git at another repository whatever the
 *    folder says (GIT_DIR and friends) are dropped from its environment.
 *  - GIT BY ITS ABSOLUTE PATH. spawn('git', { cwd }) on Windows looks in the
 *    working folder BEFORE PATH (libuv's search_path, which uv_spawn hands
 *    the child's cwd; git.com is tried before git.exe), and a relative PATH
 *    entry does the same on any host. The agent writes that folder, so a
 *    git.exe it left there would run as the owner, outside the agent's own
 *    permission prompts, each time the owner opened the panel. Measured on
 *    node 24.16 and bun 1.3.9 on Windows (review round 1, D-R2). So Git is
 *    looked up on PATH's ABSOLUTE entries only and spawned by that path; no
 *    Git there reads as git_missing.
 *  - A STREAM CAP, NOT A BUFFER. stdout is read until the cap and then the
 *    child is killed, so a huge diff costs one megabyte and a flag, never a
 *    failed read (a maxBuffer overflow fails the whole call).
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
import { access as fsAccess, lstat as fsLstat, readFile as fsReadFile, stat as fsStat } from 'node:fs/promises'

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
}

export type RunGit = (
  args: readonly string[],
  opts: { cwd: string; env: Record<string, string | undefined>; maxBytes: number; signal: AbortSignal },
) => Promise<GitRun>

type ChildLike = {
  stdout: NodeJS.ReadableStream | null
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

/**
 * Run the Git that PATH names, by its absolute path (see the rule above),
 * through spawn, reading stdout until `maxBytes` and then killing the child.
 * Resolves once, never rejects: a spawn failure comes back as `spawnError`
 * (ENOENT too when no PATH entry holds Git), a budget abort as `aborted`.
 * PATH is looked up once per adapter; server.ts makes one per read.
 */
export function createNodeRunGit(
  spawnImpl: SpawnLike = spawn as unknown as SpawnLike,
  findGit: FindGit = createFindGit(),
): RunGit {
  let git: Promise<string | null> | null = null
  return async (args, opts) => {
    if (opts.signal.aborted) return { code: null, stdout: Buffer.alloc(0), stderr: '', truncated: false, aborted: true }
    git ??= findGit(opts.env).catch(() => null)
    const bin = await git
    if (!bin) return { code: null, stdout: Buffer.alloc(0), stderr: '', truncated: false, spawnError: 'ENOENT' }
    return spawnGit(spawnImpl, bin, args, opts)
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

/** The file reads the untracked step needs. */
export type ChangesFs = {
  lstat(path: string): Promise<{ isFile(): boolean; size: number }>
  readFile(path: string): Promise<Uint8Array>
}

export const nodeChangesFs: ChangesFs = {
  lstat: (path) => fsLstat(path),
  readFile: (path) => fsReadFile(path),
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
  | { ok: false; code: 'too_slow'; message: string }

export const CHANGES_TOO_SLOW_MESSAGE = 'reading the changes took longer than the time allowed'

// The commands, whole. Nothing else is ever run (spec 10.1 item 7). The
// patch asks for Git's own a/ and b/ prefixes: a host whose config sets
// diff.mnemonicPrefix, diff.noprefix, diff.srcPrefix or diff.dstPrefix would
// otherwise write its own, and under diff.noprefix a top folder named a or b
// cannot be told from a prefix (lane B's review, B-3). numstat prints paths
// with no prefix at all, so it needs neither flag.
const GIT_TOPLEVEL = ['rev-parse', '--show-toplevel']
const GIT_VERIFY_HEAD = ['rev-parse', '--verify', '--quiet', 'HEAD']
const GIT_BRANCH = ['symbolic-ref', '--quiet', '--short', 'HEAD']
const GIT_SHORT_HEAD = ['rev-parse', '--short', 'HEAD']
const GIT_NUMSTAT = [
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
  '--find-renames',
  'HEAD',
  '--',
]
const GIT_UNTRACKED = ['ls-files', '--others', '--exclude-standard', '-z']

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

function gitEnv(base: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base }
  for (const key of REPOSITORY_OVERRIDES) delete env[key]
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  env.LC_ALL = 'C'
  return env
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

/**
 * Collect the uncommitted changes of the repository holding `workdir`.
 *
 * Resolves `{ ok: true, payload }` for every state (ok, not_git, no_commits,
 * git_missing), `{ ok: false, code: 'too_slow' }` past the budget, and
 * REJECTS on anything else (a Git failure that is not one of those states);
 * the handler answers a rejection read_failed.
 */
export async function collectChanges(input: {
  workdir: string
  caps: ChangesCaps
  runGit: RunGit
  fs: ChangesFs
  now: () => number
  env?: Record<string, string | undefined>
}): Promise<ChangesCollectResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<ChangesCollectResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ ok: false, code: 'too_slow', message: CHANGES_TOO_SLOW_MESSAGE })
    }, input.caps.budgetMs)
  })
  const reading = readChanges(input, controller.signal).catch((err: unknown) => {
    // A read the budget already answered ends quietly; anything else is real.
    if (err instanceof BudgetSpent) return new Promise<ChangesCollectResult>(() => {})
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
  },
  signal: AbortSignal,
): Promise<ChangesCollectResult> {
  const { caps } = input
  const env = gitEnv(input.env ?? process.env)
  const takenAt = new Date(input.now()).toISOString()
  const run = async (args: readonly string[], cwd: string, maxBytes: number): Promise<GitRun> => {
    if (signal.aborted) throw new BudgetSpent()
    const r = await input.runGit(args, { cwd, env, maxBytes, signal })
    if (signal.aborted || r.aborted) throw new BudgetSpent()
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

/**
 * One untracked name, read under the root. A regular file within the text cap
 * is read: a NUL in its first 8,000 bytes makes it binary, else it is text. A
 * larger one is its size only. A symlink or anything that is not a regular
 * file is binary with its size, never followed. A name that cannot be read
 * (gone since the list, or refused) is its name with no text, which the
 * backend shows as not drawn.
 */
async function readUntracked(fs: ChangesFs, root: string, name: string, maxText: number): Promise<ChangesUntrackedFile> {
  const full = `${root.replace(/[\\/]+$/, '')}/${name}`
  let st: { isFile(): boolean; size: number }
  try {
    st = await fs.lstat(full)
  } catch {
    return { path: name, bytes: 0 }
  }
  const size = Number.isFinite(st.size) && st.size >= 0 ? Math.floor(st.size) : 0
  if (!st.isFile()) return { path: name, bytes: size, binary: true }
  if (size > maxText) return { path: name, bytes: size }
  let data: Buffer
  try {
    data = Buffer.from(await fs.readFile(full))
  } catch {
    return { path: name, bytes: size }
  }
  // It grew between the two calls.
  if (data.length > maxText) return { path: name, bytes: data.length }
  if (data.subarray(0, CHANGES_BINARY_SNIFF_BYTES).includes(0)) return { path: name, bytes: data.length, binary: true }
  return { path: name, bytes: data.length, text: data.toString('utf8') }
}
