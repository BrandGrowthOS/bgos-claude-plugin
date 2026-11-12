/**
 * A thread lane manager on fakes (no claude, no git, no disk), for the full
 * access fork and the cleanup tests (0.88.0). The disk is a map of files and
 * a set of folders, so "nothing is left" is a question the test can ask of
 * every path at once; git answers from a small model of one repository.
 */

import { dirname, join, resolve, sep } from 'node:path'

import { ThreadLaneManager, type ThreadLaneDeps, type ThreadTurnInput } from '../../lib/thread-lanes.ts'
import type { StreamJsonChild } from '../../lib/stream-json-child.ts'
import { sessionTranscriptPath } from '../../bin/hoai-core.mjs'

export const MAIN = '435f1f18-2716-4c27-bfd8-e2c48f28b3ac'
export const FORK_A = 'dbd3b62b-f099-4f95-be1d-4687b4af9042'
export const FORK_B = '060f0349-719c-4450-aab2-189517f87a76'
export const COPY_ID = '11111111-2222-4333-8444-555555555555'
export const HOME = resolve('/home/u')
export const AGENT = resolve('/work/atlas')
export const CONFIG = join(HOME, '.claude')
export const STATE = join(HOME, '.bgos-agent', '7', 'threads')
export const MCP = join(STATE, 'empty-mcp.json')
export const TEMP_ROOT = resolve('/tmp/claude-501')
export const PLUGIN_STATE = join(HOME, '.bgos-plugin-state')
export const WINDOWS = sep === '\\'

export const wt = (root: string) => join(AGENT, '.hoai', 'threads', root)
export const transcript = (cwd: string, id: string) => sessionTranscriptPath(HOME, cwd, id, '')
export const projectDir = (cwd: string) => dirname(transcript(cwd, MAIN))
/** The CLI's temp folder for one session started in `cwd`. */
export const tempDir = (cwd: string, id: string) => join(TEMP_ROOT, projectDir(cwd).split(sep).pop()!, id)

export class FakeChild implements StreamJsonChild {
  pid?: number
  stdin: string[] = []
  killed: string[] = []
  private out: Array<(c: string) => void> = []
  private exits: Array<(code: number | null, signal: string | null) => void> = []
  write(c: string) { this.stdin.push(c) }
  end() {}
  kill(s: 'SIGTERM' | 'SIGKILL') { this.killed.push(s) }
  onStdout(cb: (c: string) => void) { this.out.push(cb) }
  onExit(cb: (code: number | null, signal: string | null) => void) { this.exits.push(cb) }
  frame(f: Record<string, unknown>) { for (const cb of this.out) cb(`${JSON.stringify(f)}\n`) }
  exit(code: number | null = 0) { for (const cb of this.exits) cb(code, null) }
  init(id: string) { this.frame({ type: 'system', subtype: 'init', session_id: id }) }
  result(text: string) {
    this.frame({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
    this.frame({ type: 'result', subtype: 'success', is_error: false, result: text })
  }
  /** The text of the n-th user message written to the child. */
  said(n = 0): string {
    const lines = this.stdin.filter((l) => l.includes('"type":"user"'))
    return JSON.parse(lines[n]!).message.content[0].text as string
  }
  /** The control responses written to the child. */
  answers(): Array<Record<string, any>> {
    return this.stdin.map((l) => JSON.parse(l)).filter((f) => f.type === 'control_response')
  }
}

export interface RigOptions {
  /** The agent folder is a git repository (default true). */
  repo?: boolean
  /** Why a worktree would copy too much, or null (lib/thread-repo-size.ts). */
  tooLarge?: string | null
  /** The owner's setting threads.fullAccess; undefined leaves the dependency out. */
  fullAccess?: boolean | (() => boolean)
  /** The main session's permission mode as its transcript names it. */
  mainMode?: string | null
  /** The main transcript holds an active goal. */
  activeGoal?: boolean
  approve?: ThreadLaneDeps['approve']
  files?: Record<string, string>
  mainId?: string | null
}

export function rig(opts: RigOptions = {}) {
  const repo = opts.repo ?? true
  const files = new Map<string, string>(Object.entries(opts.files ?? {}))
  const dirs = new Set<string>()
  const spawned: Array<{ command: string; args: string[]; cwd: string; env?: Record<string, string>; ownerEnv?: boolean; child: FakeChild }> = []
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const gitCalls: string[][] = []
  const logs: string[] = []
  const kept: Array<Record<string, unknown>> = []
  const approvals: Array<Record<string, unknown>> = []
  const sized: string[] = []
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const clock = { now: 1_000_000 }
  /** The repository: its branches (name to commit), which commits another ref also holds, and what is uncommitted where. */
  const git = {
    branches: new Map<string, string>([['main', 'c0']]),
    /** Commits reachable from a ref other than a thread's own branch (merged or pushed). */
    shared: new Set<string>(['c0']),
    /** Worktree folders with uncommitted changes. */
    dirty: new Set<string>(),
    /** `git commit` in a worktree fails. */
    commitFails: false,
    pruned: 0,
    commits: [] as Array<{ folder: string; message: string }>,
  }
  const mainPath = transcript(AGENT, MAIN)
  files.set(mainPath, '{"main":true}\n')
  const under = (p: string, parent: string) => p === parent || p.startsWith(parent + sep)
  const exists = (p: string) => files.has(p) || dirs.has(p) || [...files.keys(), ...dirs].some((k) => under(k, p))
  const rmrf = (p: string) => {
    for (const k of [...files.keys()]) if (under(k, p)) files.delete(k)
    for (const k of [...dirs]) if (under(k, p)) dirs.delete(k)
  }
  const usage = (p: string) => [...files.entries()].filter(([k]) => under(k, p)).reduce((n, [, v]) => n + v.length, 0)
  let lastPid = 4000
  const deps: ThreadLaneDeps = {
    spawn: (command, args, o) => {
      const child = new FakeChild()
      child.pid = ++lastPid
      spawned.push({ command, args, cwd: o.cwd, env: o.env, ownerEnv: o.ownerEnv, child })
      return child
    },
    processes: { stamp: async () => null, runsIn: async () => false, kill: () => {} },
    claudeBin: () => '/bin/claude',
    cliProblem: async () => null,
    mainSessionId: () => (opts.mainId === undefined ? MAIN : opts.mainId),
    agentFolder: AGENT,
    stateDir: STATE,
    home: HOME,
    configDir: '',
    emptyMcpConfigPath: () => MCP,
    shellSandbox: () => !WINDOWS,
    platform: 'darwin',
    tempRoots: [TEMP_ROOT],
    pluginStateDir: PLUGIN_STATE,
    ...(opts.fullAccess === undefined ? {} : { fullAccess: () => (typeof opts.fullAccess === 'function' ? opts.fullAccess() : opts.fullAccess === true) }),
    mainPermissionMode: async () => (opts.mainMode === undefined ? 'bypassPermissions' : opts.mainMode),
    newSessionId: () => COPY_ID,
    ...(opts.approve ? { approve: opts.approve } : {}),
    onBranchKept: (info) => { kept.push(info as unknown as Record<string, unknown>) },
    diskUsage: async (p) => { sized.push(p); return usage(p) },
    checkoutTooLarge: async () => opts.tooLarge ?? null,
    transcripts: {
      copyClearingGoal: async (from, to) => {
        const v = files.get(from)
        if (v === undefined) throw new Error(`ENOENT ${from}`)
        files.set(to, v.replace('"goal":"active"', '"goal":"cleared"'))
      },
      clearGoal: async () => false,
      hasActiveGoal: async (p) => (files.get(p) ?? '').includes('"goal":"active"'),
    },
    git: async (args) => {
      gitCalls.push(args)
      if (!repo) return { ok: false, stdout: '' }
      const folder = args[1]!
      const sub = args.slice(2)
      if (sub[0] === 'rev-parse' && sub[1] === '--show-prefix') return { ok: true, stdout: '\n' }
      if (sub[0] === 'rev-parse' && sub[1] === '--git-path') return { ok: true, stdout: '.git/info/exclude\n' }
      if (sub[0] === 'rev-parse' && sub[2] === '--git-common-dir') return { ok: true, stdout: `${join(AGENT, '.git')}\n` }
      if (sub[0] === 'rev-parse' && sub[2] === '--git-dir') return { ok: true, stdout: `${join(AGENT, '.git', 'worktrees', folder.split(sep).pop()!)}\n` }
      if (sub[0] === 'rev-parse' && sub[1] === '--show-ref-format') return { ok: true, stdout: 'files\n' }
      if (sub[0] === 'rev-parse' && sub[1] === '--verify') {
        const name = String(sub.at(-1)).replace(/^refs\/heads\//, '').replace(/\^\{commit\}$/, '')
        const tip = git.branches.get(name)
        return tip ? { ok: true, stdout: `${tip}\n` } : { ok: false, stdout: '' }
      }
      if (sub[0] === 'for-each-ref' && sub.includes('--contains')) {
        const tip = sub[sub.indexOf('--contains') + 1]!
        const own = [...git.branches.entries()].filter(([, c]) => c === tip).map(([n]) => `refs/heads/${n}`)
        return { ok: true, stdout: [...own, ...(git.shared.has(tip) ? ['refs/remotes/origin/main'] : [])].join('\n') + '\n' }
      }
      if (sub[0] === 'for-each-ref') return { ok: true, stdout: [...git.branches.keys()].map((n) => `refs/heads/${n}`).join('\n') + '\n' }
      if (sub[0] === 'status') return { ok: true, stdout: git.dirty.has(folder) ? ' M src/a.ts\n?? notes.txt\n' : '' }
      if (sub[0] === 'add') return { ok: true, stdout: '' }
      if (sub.includes('commit')) {
        if (git.commitFails) return { ok: false, stdout: '' }
        git.commits.push({ folder, message: String(sub.at(-1)) })
        git.dirty.delete(folder)
        const branch = `hoai/thread-${folder.split(sep).pop()!}`
        git.branches.set(branch, `saved-${folder.split(sep).pop()!}`)
        return { ok: true, stdout: '' }
      }
      if (sub[0] === 'branch' && sub[1] === '-D') return { ok: git.branches.delete(sub[2]!), stdout: '' }
      if (sub[0] === 'worktree' && sub[1] === 'add') {
        const made = join(AGENT, sub[2]!)
        dirs.add(made)
        files.set(join(made, '.git'), 'gitdir: x\n')
        files.set(join(made, 'checkout.bin'), 'x'.repeat(5000))
        const branch = sub[3] === '-b' ? sub[4]! : sub[3]!
        if (!git.branches.has(branch)) git.branches.set(branch, 'c0')
        return { ok: true, stdout: '' }
      }
      if (sub[0] === 'worktree' && sub[1] === 'remove') { rmrf(sub.at(-1)!); return { ok: true, stdout: '' } }
      if (sub[0] === 'worktree' && sub[1] === 'prune') { git.pruned++; return { ok: true, stdout: '' } }
      return { ok: true, stdout: '' }
    },
    fs: {
      exists,
      mkdir: (p) => { dirs.add(p) },
      readFile: (p) => { const v = files.get(p); if (v === undefined) throw new Error(`ENOENT ${p}`); return v },
      writeFile: (p, s) => { files.set(p, s) },
      appendFile: (p, s) => { files.set(p, (files.get(p) ?? '') + s) },
      copyFile: (a, b) => { const v = files.get(a); if (v === undefined) throw new Error(`ENOENT ${a}`); files.set(b, v) },
      unlink: (p) => { if (!files.delete(p)) throw new Error(`ENOENT ${p}`) },
      rmrf,
      createExclusive: (p, s) => { if (files.has(p)) throw new Error(`EEXIST ${p}`); files.set(p, s) },
      rename: (a, b) => { const v = files.get(a); if (v === undefined) throw new Error(`ENOENT ${a}`); files.delete(a); files.set(b, v) },
      list: (d) => {
        const names = new Set<string>()
        for (const k of [...files.keys(), ...dirs]) if (under(k, d) && k !== d) names.add(k.slice(d.length + 1).split(sep)[0]!)
        if (names.size === 0 && !dirs.has(d)) throw new Error(`ENOENT ${d}`)
        return [...names]
      },
    },
    post: async (path, body) => { posts.push({ path, body }) },
    now: () => clock.now,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true },
    log: (line) => { logs.push(line) },
  }
  if (opts.activeGoal) files.set(mainPath, '{"main":true,"goal":"active"}\n')
  const manager = new ThreadLaneManager(deps)
  /** Everything on the fake disk under `p`. */
  const left = (p: string) => [...files.keys(), ...dirs].filter((k) => under(k, p)).sort()
  const state = (rootId: string) => JSON.parse(files.get(join(STATE, `${rootId}.json`)) ?? 'null') as Record<string, any> | null
  /** What a real CLI leaves for one session started in `cwd`. */
  const sessionFiles = (cwd: string, id: string) => {
    files.set(transcript(cwd, id), `{"session":"${id}"}\n${'t'.repeat(3000)}`)
    files.set(join(projectDir(cwd), id, 'tool-results', 'out.txt'), 'r'.repeat(700))
    files.set(join(CONFIG, 'session-env', id, 'env.sh'), 'e'.repeat(50))
    files.set(join(CONFIG, 'file-history', id, 'a@v1'), 'h'.repeat(200))
    files.set(join(tempDir(cwd, id), 'tasks', 'b1.output'), 'o'.repeat(400))
    files.set(join(PLUGIN_STATE, 'hooks', id, 'events.jsonl'), 'v'.repeat(90))
  }
  return { manager, deps, files, dirs, spawned, posts, gitCalls, logs, kept, approvals, sized, timers, clock, git, mainPath, left, state, sessionFiles, exists }
}

export const turn = (rootId: string, over: Partial<ThreadTurnInput> = {}): ThreadTurnInput => ({
  chatId: '55', rootId, replyId: `${rootId}0`, mode: 'start', text: `work on ${rootId}`, title: `T${rootId}`, rootText: `root ${rootId}`, ...over,
})
/** Lets pending promise steps run without waiting on work that waits for a process exit. */
export const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((done) => setImmediate(done)) }
