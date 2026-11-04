/**
 * Thread lanes on Claude Code (Threads phase 1, plan "Plugin (PR 2)" task 2,
 * spec 7.3 and 19): one long lived `claude -p` per thread, forked from the
 * main session on its first start and resumed by its own id after, in its own
 * git worktree (read only plain folder when the agent folder is no
 * repository), 2 running at once per agent with a third waiting, 20 minute
 * idle stop. Every dependency is a fake: no claude, no git, no disk.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { basename, dirname, join, resolve, sep } from 'node:path'

import {
  THREAD_ORPHAN_POLL_MS,
  THREAD_POST_RETRY_MS,
  THREAD_TURN_TIMEOUT_MS,
  ThreadLaneManager,
  ThreadLaneError,
  threadsPendingPath,
  type ThreadLaneDeps,
  type ThreadTurnInput,
} from '../lib/thread-lanes.ts'
import { THREAD_TEXT_MAX, threadLaneArgs, threadTurnPrompt } from '../lib/thread-lane-args.ts'
import { userMessageLine, type StreamJsonChild } from '../lib/stream-json-child.ts'
import { sessionTranscriptPath } from '../bin/hoai-core.mjs'

const MAIN = '435f1f18-2716-4c27-bfd8-e2c48f28b3ac'
const FORK_A = 'dbd3b62b-f099-4f95-be1d-4687b4af9042'
const FORK_B = '060f0349-719c-4450-aab2-189517f87a76'
// Absolute native paths even on Windows; drive-less \work fixtures fail confinement.
const HOME = resolve('/home/u')
const AGENT = resolve('/work/atlas')
const STATE = join(HOME, '.bgos-agent', '7', 'threads')
const MCP = join(STATE, 'empty-mcp.json')
const WINDOWS = sep === '\\'
const POSIX_SANDBOX = { skip: WINDOWS ? 'POSIX Bash sandbox only; Windows has no lane Bash sandbox' : false }
const MIN = 60_000
const DAY = 24 * 60 * MIN

class FakeChild implements StreamJsonChild {
  pid?: number
  stdin: string[] = []
  ended = false
  killed: string[] = []
  exited = false
  private out: Array<(c: string) => void> = []
  private exits: Array<(code: number | null, signal: string | null) => void> = []
  write(c: string) { this.stdin.push(c) }
  end() { this.ended = true }
  kill(s: 'SIGTERM' | 'SIGKILL') { this.killed.push(s) }
  onStdout(cb: (c: string) => void) { this.out.push(cb) }
  onExit(cb: (code: number | null, signal: string | null) => void) { this.exits.push(cb) }
  frame(f: Record<string, unknown>) { for (const cb of this.out) cb(`${JSON.stringify(f)}\n`) }
  exit(code: number | null = 0) { this.exited = true; for (const cb of this.exits) cb(code, null) }
  init(id: string) { this.frame({ type: 'system', subtype: 'init', session_id: id }) }
  result(text: string, isError = false) {
    this.frame(isError ? { type: 'result', subtype: 'error_during_execution', is_error: true } : { type: 'result', subtype: 'success', is_error: false, result: text })
  }
}

interface Timer { fn: () => void; ms: number; cleared: boolean; fired: boolean }

function rig(opts: { repo?: boolean; mainId?: string | null; startAt?: number; files?: Record<string, string>; shell?: boolean; failPosts?: (path: string, body: Record<string, unknown>) => boolean; cliProblem?: string | null | (() => Promise<string | null>); platform?: NodeJS.Platform; git?: (sub: string[]) => { ok: boolean; stdout: string } | undefined } = {}) {
  const repo = opts.repo ?? true
  const files = new Map<string, string>(Object.entries(opts.files ?? {}))
  const dirs = new Set<string>()
  const spawned: Array<{ command: string; args: string[]; cwd: string; child: FakeChild }> = []
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const failedPosts: Array<{ path: string; body: Record<string, unknown> }> = []
  const gitCalls: string[][] = []
  const removed: string[] = []
  const branchesDeleted: string[] = []
  const timers: Timer[] = []
  const clock = { now: opts.startAt ?? 1_000_000 }
  /** The machine's processes as the lanes see them: a stamp while alive, and what stops each. */
  const procs = new Map<number, { stamp: string; alive: boolean; dies: 'SIGTERM' | 'SIGKILL' | 'never' }>()
  const procKills: Array<[number, string]> = []
  /** ps (or /proc) failing: no start stamp can be read while this is true. */
  const ctl = { stampDown: false }
  /** The folder each process runs in, as the lane's cwd check reads it. */
  const procCwd = new Map<number, string>()
  let lastPid = 4000
  const mainSrc = sessionTranscriptPath(HOME, AGENT, MAIN, '')
  files.set(mainSrc, '{"main":true}\n')
  const deps: ThreadLaneDeps = {
    spawn: (command, args, o) => {
      const child = new FakeChild()
      const pid = ++lastPid
      child.pid = pid
      procs.set(pid, { stamp: `S${pid}`, alive: true, dies: 'SIGTERM' })
      procCwd.set(pid, o.cwd)
      child.onExit(() => { procs.get(pid)!.alive = false })
      spawned.push({ command, args, cwd: o.cwd, child })
      return child
    },
    processes: {
      // Asynchronous, like the real ps and /proc reads: never a blocked event loop.
      stamp: async (pid) => { if (ctl.stampDown) return undefined; const p = procs.get(pid); return p && p.alive ? p.stamp : null },
      runsIn: async (pid, dir) => { const p = procs.get(pid); return !ctl.stampDown && p !== undefined && p.alive && procCwd.get(pid) === dir },
      kill: (pid, signal) => {
        procKills.push([pid, signal])
        const p = procs.get(pid)
        if (p && p.dies !== 'never' && (signal === 'SIGKILL' || p.dies === signal)) p.alive = false
      },
    },
    claudeBin: () => '/bin/claude',
    cliProblem: async () => (typeof opts.cliProblem === 'function' ? opts.cliProblem() : opts.cliProblem ?? null),
    mainSessionId: () => (opts.mainId === undefined ? MAIN : opts.mainId),
    agentFolder: AGENT,
    stateDir: STATE,
    home: HOME,
    configDir: '',
    emptyMcpConfigPath: () => MCP,
    emailFilesDir: join(HOME, '.bgos-agent/email-files/7'),
    shellSandbox: () => opts.shell ?? !WINDOWS,
    platform: opts.platform ?? 'darwin',
    git: async (args) => {
      gitCalls.push(args)
      const sub = args.slice(2)
      if (!repo) return { ok: false, stdout: '' }
      const over = opts.git?.(sub)
      if (over) return over
      if (sub[0] === 'rev-parse' && sub[1] === '--show-prefix') return { ok: true, stdout: '\n' }
      if (sub[0] === 'rev-parse' && sub[1] === '--git-path') return { ok: true, stdout: '.git/info/exclude\n' }
      if (sub[0] === 'rev-parse' && sub[2] === '--git-common-dir') return { ok: true, stdout: `${join(AGENT, '.git')}\n` }
      if (sub[0] === 'rev-parse' && sub[2] === '--git-dir') return { ok: true, stdout: `${join(AGENT, '.git', 'worktrees', basename(args[1]!))}\n` }
      if (sub[0] === 'for-each-ref') return { ok: true, stdout: `refs/heads/main\nrefs/heads/hoai/thread-${'101'}\n` }
      if (sub[0] === 'branch' && sub[1] === '-D') { branchesDeleted.push(sub[2]!); return { ok: true, stdout: '' } }
      if (sub[0] === 'worktree' && sub[1] === 'add') { dirs.add(join(AGENT, sub[2]!)); return { ok: true, stdout: '' } }
      if (sub[0] === 'worktree' && sub[1] === 'remove') { removed.push(sub[3]!); dirs.delete(sub[3]!); return { ok: true, stdout: '' } }
      return { ok: true, stdout: '' }
    },
    fs: {
      exists: (p) => files.has(p) || dirs.has(p),
      mkdir: (p) => { dirs.add(p) },
      readFile: (p) => { const v = files.get(p); if (v === undefined) throw new Error(`ENOENT ${p}`); return v },
      writeFile: (p, s) => { files.set(p, s) },
      appendFile: (p, s) => { files.set(p, (files.get(p) ?? '') + s) },
      copyFile: (a, b) => { const v = files.get(a); if (v === undefined) throw new Error(`ENOENT ${a}`); files.set(b, v) },
      unlink: (p) => { if (!files.delete(p)) throw new Error(`ENOENT ${p}`) },
      rmrf: (p) => { removed.push(p); dirs.delete(p) },
      createExclusive: (p, s) => { if (files.has(p)) throw new Error(`EEXIST ${p}`); files.set(p, s) },
      rename: (a, b) => { const v = files.get(a); if (v === undefined) throw new Error(`ENOENT ${a}`); files.delete(a); files.set(b, v) },
      list: (d) => [...files.keys()].filter((k) => dirname(k) === d).map((k) => k.slice(d.length + 1)),
    },
    post: async (path, body) => {
      if (opts.failPosts?.(path, body)) { failedPosts.push({ path, body }); throw new Error('HTTP 500') }
      posts.push({ path, body })
    },
    now: () => clock.now,
    setTimer: (fn, ms) => { const t: Timer = { fn, ms, cleared: false, fired: false }; timers.push(t); return t },
    clearTimer: (h) => { (h as Timer).cleared = true },
    log: () => {},
  }
  const manager = new ThreadLaneManager(deps)
  const live = (ms: number) => timers.filter((t) => t.ms === ms && !t.cleared && !t.fired)
  const fire = (t: Timer) => { t.fired = true; t.fn() }
  return { manager, deps, files, dirs, spawned, posts, failedPosts, gitCalls, removed, branchesDeleted, timers, clock, live, fire, mainSrc, procs, procKills, ctl, procCwd }
}

/** The command the manager must build for a working lane in wt(root) (protected: the agent repo's own state). */
const PROTECTED = [
  join(AGENT, '.git/index'), join(AGENT, '.git/HEAD'), join(AGENT, '.git/packed-refs'), join(AGENT, '.git/config'), join(AGENT, '.git/hooks'),
  ...['refs/stash', 'logs/refs/stash', 'refs/tags', 'refs/remotes', 'refs/notes', 'refs/replace'].map((p) => join(AGENT, '.git', p)),
  join(AGENT, '.git/refs/heads/main'),
]
function workArgs(root: string, fork: string | null): string[] {
  return threadLaneArgs({
    mainSessionId: MAIN,
    forkSessionId: fork,
    emptyMcpConfigPath: MCP,
    confinement: { root: wt(root), readOnly: false, shellSandbox: !WINDOWS, protectedPaths: PROTECTED, secretPaths: [], readablePaths: [join(HOME, '.bgos-agent/email-files/7')] },
  })
}

const wt = (root: string) => join(AGENT, '.hoai', 'threads', root)
const turn = (rootId: string, over: Partial<ThreadTurnInput> = {}): ThreadTurnInput => ({
  chatId: '55', rootId, replyId: `${rootId}0`, mode: 'start', text: `work on ${rootId}`, title: `T${rootId}`, rootText: `root ${rootId}`, ...over,
})
/** Lets pending promise steps run without waiting on work that waits for a process exit. */
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done)) }
const statePosts = (r: ReturnType<typeof rig>) => r.posts.filter((p) => p.path === 'integrations/threads/state').map((p) => `${p.body.rootId}:${p.body.state}`)

test('a first turn makes the worktree, copies the main transcript beside it, and forks the main session there', async () => {
  const r = rig()
  assert.deepEqual(r.manager.turn(turn('101')), { accepted: true, state: 'working' })
  await r.manager.idle()
  assert.deepEqual(r.gitCalls, [
    ['-C', AGENT, 'rev-parse', '--show-prefix'],
    ['-C', AGENT, 'rev-parse', '--git-path', 'info/exclude'],
    ['-C', AGENT, 'worktree', 'add', join('.hoai', 'threads', '101'), '-b', 'hoai/thread-101'],
    // Only hosts with the POSIX sandbox read these confinement paths.
    ...(!WINDOWS ? [
    ['-C', AGENT, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    ['-C', wt('101'), 'rev-parse', '--path-format=absolute', '--git-dir'],
    ['-C', AGENT, 'for-each-ref', '--format=%(refname)', 'refs/heads'],
    ['-C', AGENT, 'rev-parse', '--show-ref-format'],
    ] : []),
  ])
  assert.equal(r.files.get(sessionTranscriptPath(HOME, wt('101'), MAIN, '')), '{"main":true}\n', 'the fork finds the main transcript from its own cwd')
  assert.equal(r.spawned.length, 1)
  const s = r.spawned[0]!
  assert.equal(s.command, '/bin/claude')
  assert.equal(s.cwd, wt('101'))
  assert.deepEqual(s.args, workArgs('101', null))
  assert.deepEqual(s.child.stdin, [userMessageLine(threadTurnPrompt({ mode: 'start', text: 'work on 101', title: 'T101', rootText: 'root 101' }))])
  assert.deepEqual(statePosts(r), ['101:working'])
})

test('.hoai/ is excluded through .git/info/exclude, once, and the tracked .gitignore is never written', async () => {
  const exclude = join(AGENT, '.git', 'info', 'exclude')
  const r = rig({ files: { [exclude]: '# git ls-files --others --exclude-from=.git/info/exclude\n' } })
  r.manager.turn(turn('101'))
  r.manager.turn(turn('102'))
  await r.manager.idle()
  assert.equal(r.files.get(exclude), '# git ls-files --others --exclude-from=.git/info/exclude\n.hoai/\n')
  assert.equal(r.files.has(join(AGENT, '.gitignore')), false)
})

test('the init frame records the fork id in the lane state file and deletes the copied main transcript, once', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const c = r.spawned[0]!.child
  c.init(FORK_A)
  await r.manager.idle()
  const saved = JSON.parse(r.files.get(join(STATE, '101.json'))!)
  assert.equal(saved.forkSessionId, FORK_A)
  assert.equal(saved.cwd, wt('101'))
  assert.equal(r.files.has(sessionTranscriptPath(HOME, wt('101'), MAIN, '')), false, 'the copy goes once the fork has read it')
  assert.equal(r.files.has(r.mainSrc), true, 'the main transcript itself is never touched')
  // stream json input repeats init at every turn: harmless.
  c.init(FORK_A)
  await r.manager.idle()
  assert.equal(JSON.parse(r.files.get(join(STATE, '101.json'))!).forkSessionId, FORK_A)
})

test('each result is posted as one thread reply, final unless it ends asking a question', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const c = r.spawned[0]!.child
  c.init(FORK_A)
  c.result('Done: the test is fixed.')
  await r.manager.idle()
  r.manager.turn(turn('101', { mode: 'reply', replyId: '1011', text: 'and the docs?' }))
  await r.manager.idle()
  assert.equal(c.stdin[1], userMessageLine('and the docs?'))
  c.result('Shall I update the README too?')
  await r.manager.idle()
  const replies = r.posts.filter((p) => p.path === 'integrations/threads/reply').map((p) => p.body)
  assert.deepEqual(replies, [
    { chatId: '55', rootId: '101', text: 'Done: the test is fixed.', final: true, clientId: 'thread-101-1010' },
    { chatId: '55', rootId: '101', text: 'Shall I update the README too?', final: false, clientId: 'thread-101-1011' },
  ])
})

test('a summary turn posts the draft to the summary route, never as a reply', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const c = r.spawned[0]!.child
  c.init(FORK_A)
  c.result('ok')
  r.manager.turn(turn('101', { mode: 'summary', replyId: '', text: '' }))
  await r.manager.idle()
  assert.match(c.stdin[1]!, /Write a short summary of this thread/)
  c.result('- asked X\n- did Y')
  await r.manager.idle()
  assert.deepEqual(r.posts.filter((p) => p.path === 'integrations/threads/summary').map((p) => p.body), [
    { chatId: '55', rootId: '101', summary: '- asked X\n- did Y' },
  ])
  assert.equal(r.posts.filter((p) => p.path === 'integrations/threads/reply').length, 1)
})

test('a failed result puts the thread back to open and says so in one plain sentence', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const c = r.spawned[0]!.child
  c.init(FORK_A)
  c.result('', true)
  await r.manager.idle()
  assert.deepEqual(statePosts(r), ['101:working', '101:open'])
  const reply = r.posts.filter((p) => p.path === 'integrations/threads/reply').map((p) => p.body)
  assert.equal(reply.length, 1)
  assert.equal(reply[0]!.final, false)
  assert.match(String(reply[0]!.text), /^This turn failed[^.]*\.$/)
})

test('two lanes run at once per agent; a third waits FIFO and starts when a slot frees', async () => {
  const r = rig()
  assert.equal(r.manager.turn(turn('101')).state, 'working')
  assert.equal(r.manager.turn(turn('102')).state, 'working')
  assert.equal(r.manager.turn(turn('103')).state, 'waiting')
  assert.equal(r.manager.turn(turn('104')).state, 'waiting')
  await r.manager.idle()
  assert.equal(r.spawned.length, 2)
  assert.deepEqual(statePosts(r).sort(), ['101:working', '102:working', '103:waiting', '104:waiting'])
  r.spawned[1]!.child.init(FORK_B)
  r.spawned[1]!.child.result('102 done.')
  await r.manager.idle()
  // 102's idle process still holds its slot: it gives it up for 103 and
  // the slot is free once that process has exited.
  assert.equal(r.spawned.length, 2)
  assert.deepEqual(r.spawned[1]!.child.killed, ['SIGTERM'])
  r.spawned[1]!.child.exit(null)
  await r.manager.idle()
  assert.equal(r.spawned.length, 3)
  assert.equal(r.spawned[2]!.cwd, wt('103'), 'the first that waited starts first')
  assert.ok(statePosts(r).includes('103:working'))
  assert.equal(r.manager.runningCount(), 2)
})

test('turns for one thread are serialized: the second waits for the first result', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  assert.deepEqual(r.manager.turn(turn('101', { mode: 'reply', replyId: '1011', text: 'also this' })), { accepted: true, state: 'working' })
  await r.manager.idle()
  const c = r.spawned[0]!.child
  assert.equal(c.stdin.length, 1)
  c.init(FORK_A)
  c.result('first answer.')
  await r.manager.idle()
  assert.equal(c.stdin.length, 2)
  assert.equal(c.stdin[1], userMessageLine('also this'))
  assert.equal(r.spawned.length, 1, 'the same lane, never a second process')
})

test('a re sent turn for the same reply is not run twice', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  r.manager.turn(turn('101'))
  await r.manager.idle()
  r.spawned[0]!.child.init(FORK_A)
  r.spawned[0]!.child.result('once.')
  await r.manager.idle()
  assert.equal(r.spawned[0]!.child.stdin.length, 1)
})

test('a lane idle for 20 minutes is stopped (SIGTERM, then SIGKILL after 10 s) and resumes by its own id', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const c = r.spawned[0]!.child
  c.init(FORK_A)
  c.result('done.')
  await r.manager.idle()
  const idle = r.live(20 * MIN)
  assert.equal(idle.length, 1)
  r.fire(idle[0]!)
  assert.deepEqual(c.killed, ['SIGTERM'])
  const grace = r.live(10_000)
  assert.equal(grace.length, 1)
  r.fire(grace[0]!)
  assert.deepEqual(c.killed, ['SIGTERM', 'SIGKILL'])
  c.exit(null)
  r.manager.turn(turn('101', { mode: 'reply', replyId: '1011', text: 'one more' }))
  await r.manager.idle()
  assert.equal(r.spawned.length, 2)
  assert.deepEqual(r.spawned[1]!.args, workArgs('101', FORK_A))
  assert.equal(r.spawned[1]!.cwd, wt('101'))
  assert.equal(r.gitCalls.filter((g) => g[2] === 'worktree').length, 1, 'the worktree is made once')
})

test('a turn before the idle stop cancels it', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const c = r.spawned[0]!.child
  c.init(FORK_A)
  c.result('done.')
  await r.manager.idle()
  const idle = r.live(20 * MIN)[0]!
  r.manager.turn(turn('101', { mode: 'reply', replyId: '1011', text: 'more' }))
  await r.manager.idle()
  assert.equal(idle.cleared, true)
  assert.deepEqual(c.killed, [])
})

test('a daemon restart resumes the lane by the fork id it saved', async () => {
  const first = rig()
  first.manager.turn(turn('101'))
  await first.manager.idle()
  first.spawned[0]!.child.init(FORK_A)
  await first.manager.idle()
  const saved = first.files.get(join(STATE, '101.json'))!
  const r = rig({ files: { [join(STATE, '101.json')]: saved } })
  r.dirs.add(wt('101'))
  r.manager.turn(turn('101', { mode: 'reply', replyId: '1011', text: 'back' }))
  await r.manager.idle()
  assert.deepEqual(r.spawned[0]!.args, workArgs('101', FORK_A))
  assert.equal(r.gitCalls.some((g) => g[2] === 'worktree'), false, 'the worktree is not made again')
})

test('a folder that is not a git repository runs the lane read only in a plain folder', async () => {
  const r = rig({ repo: false })
  r.manager.turn(turn('101'))
  await r.manager.idle()
  assert.ok(r.dirs.has(wt('101')))
  assert.equal(r.gitCalls.some((g) => g[2] === 'worktree'), false)
  const s = r.spawned[0]!
  assert.equal(s.cwd, wt('101'))
  assert.deepEqual(s.args, threadLaneArgs({
    mainSessionId: MAIN,
    forkSessionId: null,
    emptyMcpConfigPath: MCP,
    confinement: { root: wt('101'), readOnly: true, shellSandbox: false, readDirs: [AGENT] },
  }))
  assert.match(s.child.stdin[0]!, /read only/)
})

test('with no main session to fork the thread goes back to open with a plain reason, and frees its slot', async () => {
  const r = rig({ mainId: null })
  r.manager.turn(turn('101'))
  await r.manager.idle()
  assert.equal(r.spawned.length, 0)
  assert.deepEqual(statePosts(r), ['101:working', '101:open'])
  const reply = r.posts.find((p) => p.path === 'integrations/threads/reply')!.body
  assert.match(String(reply.text), /no running session/)
  assert.equal(r.manager.runningCount(), 0)
})

test('a lane that dies mid turn fails that turn and frees its slot', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  r.manager.turn(turn('102'))
  r.manager.turn(turn('103'))
  await r.manager.idle()
  r.spawned[0]!.child.init(FORK_A)
  r.spawned[0]!.child.exit(1)
  await r.manager.idle()
  assert.ok(statePosts(r).includes('101:open'))
  assert.equal(r.spawned.length, 3, 'the waiting thread took the slot')
})

test('close stops the lane, keeps the worktree, and the sweep removes it only after 7 days', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const c = r.spawned[0]!.child
  c.init(FORK_A)
  c.result('done.')
  await r.manager.idle()
  await r.manager.close({ rootId: '101', removeWorktree: false })
  assert.deepEqual(c.killed, ['SIGTERM'])
  c.exit(null)
  await r.manager.idle()
  assert.deepEqual(r.removed, [])
  assert.equal(JSON.parse(r.files.get(join(STATE, '101.json'))!).closedAt, r.clock.now)
  const forkFile = sessionTranscriptPath(HOME, wt('101'), FORK_A, '')
  r.files.set(forkFile, '{}\n')

  assert.deepEqual(await r.manager.sweepClosed(r.clock.now + 7 * DAY - 1), [])
  assert.deepEqual(r.removed, [])
  assert.deepEqual(await r.manager.sweepClosed(r.clock.now + 7 * DAY + 1), ['101'])
  assert.deepEqual(r.gitCalls.at(-1), ['-C', AGENT, 'worktree', 'remove', '--force', wt('101')])
  assert.equal(r.files.has(join(STATE, '101.json')), false)
  assert.equal(r.files.has(forkFile), false)
})

test('the sweep leaves open lanes alone, however old', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  r.spawned[0]!.child.init(FORK_A)
  await r.manager.idle()
  assert.deepEqual(await r.manager.sweepClosed(r.clock.now + 30 * DAY), [])
})

test('a turn on a closed thread reopens it, so the sweep no longer removes it', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  r.spawned[0]!.child.init(FORK_A)
  r.spawned[0]!.child.result('done.')
  await r.manager.idle()
  await r.manager.close({ rootId: '101', removeWorktree: false })
  r.spawned[0]!.child.exit(null)
  r.manager.turn(turn('101', { mode: 'reply', replyId: '1011', text: 'reopened' }))
  await r.manager.idle()
  assert.equal(JSON.parse(r.files.get(join(STATE, '101.json'))!).closedAt, null)
  assert.deepEqual(await r.manager.sweepClosed(r.clock.now + 8 * DAY), [])
})

test('a reopen waits for an in-flight sweep and starts in a recreated worktree', async () => {
  const state = { rootId: '101', chatId: '55', title: 'T', forkSessionId: FORK_A, folder: wt('101'), cwd: wt('101'), worktree: true, readOnly: false, closedAt: 1, lastReplyId: '1010', lastDelivered: true, pid: null, pidStamp: null }
  const forkFile = sessionTranscriptPath(HOME, wt('101'), FORK_A, '')
  const r = rig({ files: { [join(STATE, '101.json')]: JSON.stringify(state), [forkFile]: '{}\n' } })
  r.dirs.add(wt('101'))
  const git = r.deps.git
  let release: () => void = () => {}
  const gate = new Promise<void>((done) => { release = done })
  let removing = false
  r.deps.git = async (args, cwd) => {
    if (args[2] === 'worktree' && args[3] === 'remove') { removing = true; await gate }
    return git(args, cwd)
  }
  const sweep = r.manager.sweepClosed(30 * DAY)
  await flush()
  assert.equal(removing, true, 'the sweep has reached the paused git removal')
  r.manager.turn(turn('101', { mode: 'reply', replyId: '1011', text: 'reopened during sweep' }))
  await flush()
  const startedDuringRemoval = r.spawned.length
  const secondSweep = await r.manager.sweepClosed(30 * DAY)
  release()
  assert.deepEqual(await sweep, ['101'])
  await r.manager.idle()
  assert.equal(startedDuringRemoval, 0, 'no child may start in a worktree being removed')
  assert.deepEqual(secondSweep, [], 'a second sweep does not claim the same root')
  assert.equal(r.spawned.length, 1)
  assert.equal(r.dirs.has(wt('101')), true, 'the new child owns a recreated worktree')
  assert.equal(saved(r).closedAt, null)
  assert.equal(saved(r).pid, r.spawned[0]!.child.pid)
  assert.equal(r.files.has(forkFile), false, 'the swept fork is gone')
  assert.deepEqual(r.spawned[0]!.args, workArgs('101', null), 'fork main again instead of resuming the deleted transcript')
  assert.equal(r.files.get(sessionTranscriptPath(HOME, wt('101'), MAIN, '')), '{"main":true}\n')
  r.spawned[0]!.child.init(FORK_B)
  r.spawned[0]!.child.result('reopened safely')
  await r.manager.idle()
  assert.ok(replyTexts(r).includes('reopened safely'))
  assert.equal(saved(r).forkSessionId, FORK_B)
})

for (const scenario of ['sweep', 'delete', 'sweep then close'] as const) {
  test(`a reopen queued behind busy slots forks afresh after ${scenario} finishes`, async () => {
    const state = { rootId: '101', chatId: '55', title: 'T', forkSessionId: FORK_A, folder: wt('101'), cwd: wt('101'), worktree: true, readOnly: false, closedAt: 1, lastReplyId: '1010', lastDelivered: true, pid: null, pidStamp: null }
    const forkFile = sessionTranscriptPath(HOME, wt('101'), FORK_A, '')
    const r = rig({ files: { [join(STATE, '101.json')]: JSON.stringify(state), [forkFile]: '{}\n' } })
    r.dirs.add(wt('101'))
    r.manager.turn(turn('201'))
    r.manager.turn(turn('301'))
    await r.manager.idle()
    assert.equal(r.spawned.length, 2, 'both process slots are occupied')

    const git = r.deps.git
    let release: () => void = () => {}
    const gate = new Promise<void>((done) => { release = done })
    let removing = false
    r.deps.git = async (args, cwd) => {
      if (args[2] === 'worktree' && args[3] === 'remove') { removing = true; await gate }
      return git(args, cwd)
    }
    const removal = scenario === 'delete'
      ? r.manager.close({ rootId: '101', removeWorktree: true })
      : r.manager.sweepClosed(30 * DAY)
    await flush()
    assert.equal(removing, true, 'cleanup is paused in git removal')
    assert.deepEqual(r.manager.turn(turn('101', { mode: 'reply', replyId: '1011', text: 'queued reopen' })), { accepted: true, state: 'waiting' })
    assert.equal(saved(r).forkSessionId, FORK_A, 'the queued lane loaded the old fork')
    const closing = scenario === 'sweep then close'
      ? r.manager.close({ rootId: '101', removeWorktree: false })
      : Promise.resolve()
    release()
    await removal
    await closing
    await r.manager.idle()
    if (scenario === 'sweep then close') {
      assert.equal(saved(r).forkSessionId, null, 'a later close cannot persist the deleted fork')
      assert.deepEqual(r.manager.turn(turn('101', { mode: 'reply', replyId: '1012', text: 'queued reopen' })), { accepted: true, state: 'waiting' })
    } else {
      assert.equal(r.files.has(join(STATE, '101.json')), false, 'cleanup finishes before a slot frees')
    }
    assert.equal(r.files.has(forkFile), false, 'the old transcript is gone')
    assert.equal(r.spawned.length, 2, 'the reopen is still queued')

    r.spawned[0]!.child.result('slot released')
    r.spawned[0]!.child.exit()
    await r.manager.idle()
    assert.equal(r.spawned.length, 3)
    const reopened = r.spawned[2]!
    assert.equal(r.dirs.has(wt('101')), true, 'the worktree was recreated')
    assert.equal(reopened.args[reopened.args.indexOf('--resume') + 1], MAIN, 'resume main, never the deleted fork')
    assert.ok(reopened.args.includes('--fork-session'), 'start a fresh fork')
    assert.equal(r.files.get(sessionTranscriptPath(HOME, wt('101'), MAIN, '')), '{"main":true}\n')
    assert.ok(reopened.child.stdin[0]!.includes('queued reopen'), 'the accepted reply reaches the new child')
    reopened.child.init(FORK_B)
    reopened.child.result('queued reopen answered')
    await r.manager.idle()
    assert.equal(saved(r).forkSessionId, FORK_B)
    assert.equal(saved(r).closedAt, null)
    assert.ok(replyTexts(r).includes('queued reopen answered'))
  })
}

test('late delivery cannot restore a deleted fork while its reopen waits for capacity', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const oldChild = r.spawned[0]!.child
  oldChild.init(FORK_A)
  const forkFile = sessionTranscriptPath(HOME, wt('101'), FORK_A, '')
  r.files.set(forkFile, '{}\n')
  const post = r.deps.post
  let releasePost: () => void = () => {}
  const gate = new Promise<void>((done) => { releasePost = done })
  let delivering = false
  r.deps.post = async (path, body) => {
    if (path === 'integrations/threads/reply' && body.text === 'old answer') {
      delivering = true
      await gate
    }
    return post(path, body)
  }
  oldChild.result('old answer')
  await flush()
  assert.equal(delivering, true, 'the old answer is still being delivered')
  r.manager.turn(turn('201'))
  r.manager.turn(turn('301'))
  await flush()
  await r.manager.close({ rootId: '101', removeWorktree: true })
  assert.deepEqual(r.manager.turn(turn('101', { mode: 'reply', replyId: '1011', text: 'queued reopen' })), { accepted: true, state: 'waiting' })
  oldChild.exit()
  await flush()
  assert.equal(r.spawned.length, 3, '201 and 301 occupy both slots')
  const stateRemoved = !r.files.has(join(STATE, '101.json'))
  const forkRemoved = !r.files.has(forkFile)
  releasePost()
  await r.manager.idle()
  assert.equal(stateRemoved, true, 'deletion completed before the old answer landed')
  assert.equal(forkRemoved, true)
  assert.equal(saved(r).forkSessionId, null, 'delivery cannot restore the deleted fork')
  assert.equal(saved(r).lastDelivered, true, 'the old delivery still gets recorded')

  r.spawned[1]!.child.result('slot released')
  r.spawned[1]!.child.exit()
  await r.manager.idle()
  assert.equal(r.spawned.length, 4)
  const reopened = r.spawned[3]!
  assert.equal(reopened.args[reopened.args.indexOf('--resume') + 1], MAIN)
  assert.ok(reopened.args.includes('--fork-session'))
  assert.ok(reopened.child.stdin[0]!.includes('queued reopen'))
})

test('overlapping sweeps reserve a closed root only once', async () => {
  const state = { rootId: '101', chatId: '55', title: 'T', forkSessionId: FORK_A, folder: wt('101'), cwd: wt('101'), worktree: true, readOnly: false, closedAt: 1, pid: null, pidStamp: null }
  const r = rig({ files: { [join(STATE, '101.json')]: JSON.stringify(state) } })
  r.dirs.add(wt('101'))
  const git = r.deps.git
  let release: () => void = () => {}
  const gate = new Promise<void>((done) => { release = done })
  let removals = 0
  r.deps.git = async (args, cwd) => {
    if (args[2] === 'worktree' && args[3] === 'remove') { removals++; await gate }
    return git(args, cwd)
  }
  const first = r.manager.sweepClosed(30 * DAY)
  await flush()
  const second = r.manager.sweepClosed(30 * DAY)
  await flush()
  release()
  assert.deepEqual(await first, ['101'])
  assert.deepEqual(await second, [])
  assert.equal(removals, 1)
})

test('a close during a sweep cannot release its root for an early reopen', async () => {
  const state = { rootId: '101', chatId: '55', title: 'T', forkSessionId: FORK_A, folder: wt('101'), cwd: wt('101'), worktree: true, readOnly: false, closedAt: 1, pid: null, pidStamp: null }
  const r = rig({ files: { [join(STATE, '101.json')]: JSON.stringify(state) } })
  r.dirs.add(wt('101'))
  const git = r.deps.git
  let release: () => void = () => {}
  const gate = new Promise<void>((done) => { release = done })
  r.deps.git = async (args, cwd) => {
    if (args[2] === 'worktree' && args[3] === 'remove') await gate
    return git(args, cwd)
  }
  const sweep = r.manager.sweepClosed(30 * DAY)
  await flush()
  const closing = r.manager.close({ rootId: '101', removeWorktree: false })
  await flush()
  r.manager.turn(turn('101', { mode: 'reply', replyId: '1011', text: 'reopen after close' }))
  await flush()
  const startedDuringRemoval = r.spawned.length
  release()
  await Promise.all([sweep, closing])
  await r.manager.idle()
  assert.equal(startedDuringRemoval, 0, 'close must not replace the pending sweep owner')
  r.manager.turn(turn('101', { mode: 'reply', replyId: '1012', text: 'retry after cleanup' }))
  await r.manager.idle()
  assert.equal(r.spawned.length, 1)
  assert.equal(r.dirs.has(wt('101')), true)
  assert.equal(saved(r).pid, r.spawned[0]!.child.pid)
  assert.deepEqual(r.spawned[0]!.args, workArgs('101', null))
})

test('close with removeWorktree removes the worktree, the fork session file and the lane state', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const c = r.spawned[0]!.child
  c.init(FORK_A)
  c.result('done.')
  await r.manager.idle()
  const forkFile = sessionTranscriptPath(HOME, wt('101'), FORK_A, '')
  r.files.set(forkFile, '{}\n')
  assert.deepEqual(await r.manager.close({ rootId: '101', removeWorktree: true }), { stopped: true })
  c.exit(null)
  await r.manager.idle()
  assert.deepEqual(r.gitCalls.at(-2), ['-C', AGENT, 'worktree', 'remove', '--force', wt('101')])
  assert.equal(r.files.has(forkFile), false)
  assert.equal(r.files.has(join(STATE, '101.json')), false)
})

test('deleting a read only lane removes its plain folder', async () => {
  const r = rig({ repo: false })
  r.manager.turn(turn('101'))
  await r.manager.idle()
  r.spawned[0]!.child.init(FORK_A)
  await r.manager.close({ rootId: '101', removeWorktree: true })
  r.spawned[0]!.child.exit(null)
  await r.manager.idle()
  assert.deepEqual(r.removed, [wt('101'), sessionTranscriptPath(HOME, wt('101'), FORK_A, '').replace(/\.jsonl$/, '')])
})

test('closing a running lane frees its slot for a waiting thread and drops its late result', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  r.manager.turn(turn('102'))
  r.manager.turn(turn('103'))
  await r.manager.idle()
  const c = r.spawned[0]!.child
  c.init(FORK_A)
  await r.manager.close({ rootId: '101', removeWorktree: false })
  c.result('late answer.')
  await flush()
  assert.equal(r.posts.some((p) => p.body.text === 'late answer.'), false)
  assert.equal(r.spawned.length, 2, 'the closed lane holds its slot until its process has exited')
  c.exit(null)
  await r.manager.idle()
  assert.equal(r.spawned.length, 3)
})

test('reconcile runs a reply turn for each pending thread and skips one already working', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  let asked = 0
  // The server's answer, as GET api/v1/integrations/threads/pending gives it.
  const ran = await r.manager.reconcile(async () => {
    asked++
    return {
      turns: [
        { chatId: '55', rootId: '101', replyId: '1011', mode: 'reply', text: 'x', title: 'T', assistantId: '7' },
        { chatId: '55', rootId: '102', replyId: '1021', mode: 'reply', text: 'pending one', title: 'T102', assistantId: '7' },
        { chatId: '56', rootId: '103', replyId: '1031', mode: 'reply', text: 'not mine', title: 'T103', assistantId: '8' },
      ],
    }
  }, { assistantIds: ['7'] })
  await r.manager.idle()
  assert.equal(asked, 1)
  assert.equal(ran, 1)
  assert.equal(r.spawned.length, 2)
  assert.equal(r.spawned[1]!.cwd, wt('102'))
  assert.equal(r.spawned[1]!.child.stdin[0], userMessageLine('pending one'))
})

test('stopAll stops every lane on daemon shutdown', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  r.manager.turn(turn('102'))
  await r.manager.idle()
  r.manager.stopAll()
  assert.deepEqual(r.spawned.map((s) => s.child.killed), [['SIGTERM'], ['SIGTERM']])
})

test('a root id that could leave the threads folder is refused', () => {
  const r = rig()
  for (const rootId of ['../x', '', 'a/b', '.']) {
    assert.throws(() => r.manager.turn(turn(rootId)), (err: unknown) => err instanceof ThreadLaneError && err.code === 'bad_request', rootId)
  }
  assert.throws(() => r.manager.turn(turn('101', { mode: 'other' as 'reply' })), ThreadLaneError)
})

test('the pending route names the agents this daemon serves, and any other answer shape starts nothing', async () => {
  assert.equal(threadsPendingPath(['7']), 'integrations/threads/pending?assistantIds=7')
  assert.equal(threadsPendingPath(['7', '12']), 'integrations/threads/pending?assistantIds=7,12')
  const r = rig()
  const row = { chatId: '55', rootId: '102', replyId: '1021', mode: 'reply', text: 'x', title: 'T' }
  assert.equal(await r.manager.reconcile(async () => [row]), 0)
  assert.equal(await r.manager.reconcile(async () => ({ threads: [row] })), 0)
  assert.equal(await r.manager.reconcile(async () => ({ turns: [row] })), 1)
})

test('a turn that arrives while the idle stop is under way runs on a new process, never failed by the old one', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const old = r.spawned[0]!.child
  old.init(FORK_A)
  old.result('done.')
  await r.manager.idle()
  r.fire(r.live(20 * MIN)[0]!)
  assert.deepEqual(old.killed, ['SIGTERM'])
  r.manager.turn(turn('101', { mode: 'reply', replyId: '1011', text: 'one more' }))
  await flush()
  assert.equal(r.spawned.length, 1, 'no second process while the first still runs')
  old.exit(null)
  await r.manager.idle()
  assert.deepEqual(statePosts(r), ['101:working', '101:working'], 'never put back to open')
  assert.equal(r.posts.filter((p) => p.path === 'integrations/threads/reply').length, 1)
  assert.equal(r.spawned.length, 2)
  const next = r.spawned[1]!.child
  assert.deepEqual(next.stdin, [userMessageLine('one more')])
  assert.equal(r.manager.runningCount(), 1)
  next.result('the second answer.')
  await r.manager.idle()
  assert.equal(r.posts.at(-1)!.body.text, 'the second answer.')
  assert.equal(r.live(20 * MIN).length, 1, 'the new process has its own idle stop')
  assert.equal(r.manager.liveChildren(), 1)
})

test('a delete while the worktree is still being made removes it, its branch and the state, and starts nothing', async () => {
  const r = rig()
  let release: () => void = () => {}
  const gate = new Promise<void>((done) => { release = done })
  const git = r.deps.git
  r.deps.git = async (args, cwd) => {
    if (args[2] === 'worktree' && args[3] === 'add') await gate
    return git(args, cwd)
  }
  r.manager.turn(turn('101'))
  await new Promise((done) => setImmediate(done))
  await r.manager.close({ rootId: '101', removeWorktree: true })
  release()
  await r.manager.idle()
  assert.equal(r.spawned.length, 0)
  assert.equal(r.files.has(sessionTranscriptPath(HOME, wt('101'), MAIN, '')), false, 'no copy of the main transcript')
  assert.ok(r.gitCalls.some((g) => g[2] === 'worktree' && g[3] === 'remove' && g[5] === wt('101')), 'the worktree made meanwhile is removed')
  assert.deepEqual(r.branchesDeleted, ['hoai/thread-101'])
  assert.equal(r.files.has(join(STATE, '101.json')), false)
  assert.equal(r.manager.runningCount(), 0)
})

test('a plain close while the worktree is still being made records closedAt, so the 7 day sweep removes it', async () => {
  const r = rig()
  let release: () => void = () => {}
  const gate = new Promise<void>((done) => { release = done })
  const git = r.deps.git
  r.deps.git = async (args, cwd) => {
    if (args[2] === 'worktree' && args[3] === 'add') await gate
    return git(args, cwd)
  }
  r.manager.turn(turn('101'))
  await new Promise((done) => setImmediate(done))
  await r.manager.close({ rootId: '101', removeWorktree: false })
  release()
  await r.manager.idle()
  assert.equal(r.spawned.length, 0)
  assert.equal(r.files.has(sessionTranscriptPath(HOME, wt('101'), MAIN, '')), false)
  assert.equal(JSON.parse(r.files.get(join(STATE, '101.json'))!).closedAt, r.clock.now)
  assert.deepEqual(await r.manager.sweepClosed(r.clock.now + 7 * DAY + 1), ['101'])
  assert.deepEqual(r.branchesDeleted, [], 'the sweep keeps the branch; only Delete removes it')
})

test('delete removes the thread branch, only that one, once the worktree is gone', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  r.spawned[0]!.child.init(FORK_A)
  await r.manager.close({ rootId: '101', removeWorktree: true })
  r.spawned[0]!.child.exit(null)
  await r.manager.idle()
  assert.deepEqual(r.gitCalls.at(-1), ['-C', AGENT, 'branch', '-D', 'hoai/thread-101'])
  // A worktree that could not be removed keeps its branch.
  const k = rig()
  k.manager.turn(turn('102'))
  await k.manager.idle()
  const kGit = k.deps.git
  k.deps.git = async (args, cwd) => (args[2] === 'worktree' && args[3] === 'remove' ? { ok: false, stdout: '' } : kGit(args, cwd))
  k.deps.fs.rmrf = () => { throw new Error('busy') }
  await k.manager.close({ rootId: '102', removeWorktree: true })
  k.spawned[0]!.child.exit(null)
  await k.manager.idle()
  assert.deepEqual(k.branchesDeleted, [])
})

test('a reply longer than the server holds is cut to 20,000 characters with a plain note', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  r.spawned[0]!.child.result('z'.repeat(THREAD_TEXT_MAX + 100))
  await r.manager.idle()
  const text = String(r.posts.find((p) => p.path === 'integrations/threads/reply')!.body.text)
  assert.equal(text.length, THREAD_TEXT_MAX)
  assert.match(text, /cut here/)
})

test('a failed reply post is retried with backoff and lands', async () => {
  let failures = 2
  const r = rig({ failPosts: (path) => path === 'integrations/threads/reply' && failures-- > 0 })
  r.manager.turn(turn('101'))
  await r.manager.idle()
  r.spawned[0]!.child.result('the answer.')
  for (const ms of THREAD_POST_RETRY_MS.slice(0, 2)) {
    await new Promise((done) => setImmediate(done))
    const wait = r.live(ms)
    assert.equal(wait.length, 1, `a wait of ${ms} ms before the next try`)
    r.fire(wait[0]!)
  }
  await r.manager.idle()
  assert.equal(r.failedPosts.length, 2)
  assert.deepEqual(r.posts.filter((p) => p.path === 'integrations/threads/reply').map((p) => p.body.text), ['the answer.'])
  assert.deepEqual(statePosts(r), ['101:working'])
})

test('a reply post that keeps failing puts the thread back to open with a short reply, never stuck at working', async () => {
  const r = rig({ failPosts: (path, body) => path === 'integrations/threads/reply' && body.text === 'the answer.' })
  r.manager.turn(turn('101'))
  await r.manager.idle()
  r.spawned[0]!.child.result('the answer.')
  for (const ms of THREAD_POST_RETRY_MS) {
    await new Promise((done) => setImmediate(done))
    r.fire(r.live(ms)[0]!)
  }
  await r.manager.idle()
  assert.equal(r.failedPosts.length, THREAD_POST_RETRY_MS.length + 1)
  assert.deepEqual(statePosts(r), ['101:working', '101:open'])
  const reply = r.posts.find((p) => p.path === 'integrations/threads/reply')!.body
  assert.match(String(reply.text), /could not be delivered/)
  assert.equal(reply.final, false)
})

test('a turn with no result after 30 minutes is failed and its lane stopped, freeing the slot', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  r.manager.turn(turn('102'))
  r.manager.turn(turn('103'))
  await r.manager.idle()
  const c = r.spawned[0]!.child
  c.init(FORK_A)
  assert.equal(THREAD_TURN_TIMEOUT_MS, 30 * MIN)
  const timeout = r.live(THREAD_TURN_TIMEOUT_MS).filter((t) => r.timers.indexOf(t) === 0)
  assert.equal(timeout.length, 1, "the first lane's turn timer")
  r.fire(timeout[0]!)
  await r.manager.idle()
  assert.deepEqual(c.killed, ['SIGTERM'])
  assert.ok(statePosts(r).includes('101:open'))
  assert.match(String(r.posts.find((p) => p.path === 'integrations/threads/reply' && p.body.rootId === '101')!.body.text), /longer than 30 minutes/)
  assert.equal(r.spawned.length, 2, 'the slot frees when the stopped process exits')
  c.result('too late.')
  c.exit(null)
  await r.manager.idle()
  assert.equal(r.posts.some((p) => p.body.text === 'too late.'), false)
  assert.equal(r.posts.filter((p) => p.path === 'integrations/threads/reply' && p.body.rootId === '101').length, 1, 'failed once')
  assert.equal(r.spawned.length, 3)
})

test('a result ends its turn timer', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  r.spawned[0]!.child.result('quick.')
  await r.manager.idle()
  assert.equal(r.live(THREAD_TURN_TIMEOUT_MS).length, 0)
})

test('stopAll resolves once every lane has exited, and killAll sends SIGKILL to the rest', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  r.manager.turn(turn('102'))
  await r.manager.idle()
  let done = false
  const stopped = r.manager.stopAll().then(() => { done = true })
  assert.equal(r.manager.liveChildren(), 2)
  r.spawned[0]!.child.exit(null)
  await new Promise((d) => setImmediate(d))
  assert.equal(done, false)
  r.manager.killAll()
  assert.deepEqual(r.spawned[1]!.child.killed, ['SIGTERM', 'SIGKILL'])
  r.spawned[1]!.child.exit(null)
  await stopped
  assert.equal(done, true)
  assert.equal(r.manager.liveChildren(), 0)
})

test('on a host with no Bash sandbox the lane runs without Bash, and the repository state is not even read', async () => {
  const r = rig({ shell: false })
  r.manager.turn(turn('101'))
  await r.manager.idle()
  assert.deepEqual(r.spawned[0]!.args, threadLaneArgs({
    mainSessionId: MAIN,
    forkSessionId: null,
    emptyMcpConfigPath: MCP,
    confinement: { root: wt('101'), readOnly: false, shellSandbox: false },
  }))
  assert.equal(r.gitCalls.some((g) => g[2] === 'for-each-ref'), false)
})

test('a lane whose repository state cannot be read runs without Bash, never with an unprotected sandbox', async () => {
  const r = rig()
  const git = r.deps.git
  r.deps.git = async (args, cwd) => (args[2] === 'for-each-ref' ? { ok: false, stdout: '' } : git(args, cwd))
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const args = r.spawned[0]!.args
  assert.equal(args[args.indexOf('--tools') + 1]!.split(',').includes('Bash'), false)
})

test('a close while the lane confinement is being read starts nothing and copies nothing', POSIX_SANDBOX, async () => {
  const r = rig()
  let release: () => void = () => {}
  const gate = new Promise<void>((done) => { release = done })
  const git = r.deps.git
  let reading = false
  r.deps.git = async (args, cwd) => {
    if (args[2] === 'for-each-ref') { reading = true; await gate }
    return git(args, cwd)
  }
  r.manager.turn(turn('101'))
  await flush()
  assert.ok(reading, 'the start is reading the repository state')
  await r.manager.close({ rootId: '101', removeWorktree: true })
  release()
  await r.manager.idle()
  assert.equal(r.spawned.length, 0)
  assert.equal(r.files.has(sessionTranscriptPath(HOME, wt('101'), MAIN, '')), false)
  assert.deepEqual(r.branchesDeleted, ['hoai/thread-101'])
})

// -- gate review finding 7: removeLane stays inside the threads folder and takes the fork's own folder --

/** The CLI keeps a session's large tool results in <project dir>/<session id>/tool-results/. */
const forkDir = (cwd: string, id: string) => sessionTranscriptPath(HOME, cwd, id, '').replace(/\.jsonl$/, '')

test('delete removes the fork session folder (its tool-results) with the session file', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const c = r.spawned[0]!.child
  c.init(FORK_A)
  c.result('done.')
  await r.manager.idle()
  await r.manager.close({ rootId: '101', removeWorktree: true })
  c.exit(null)
  await r.manager.idle()
  assert.ok(r.removed.includes(forkDir(wt('101'), FORK_A)), `removed: ${r.removed.join(', ')}`)
})

test('a lane state file naming a folder outside <agent>/.hoai/threads/ never gets that folder removed', async () => {
  for (const folder of [resolve('/etc'), HOME, join(AGENT, 'src'), [AGENT, '.hoai', 'threads', '..', '..', 'src'].join(sep), join(AGENT, '.hoai/threads/102'), join(AGENT, '.hoai/threads')]) {
    for (const worktree of [true, false]) {
      const state = { rootId: '101', chatId: '55', title: 'T', forkSessionId: FORK_A, folder, cwd: folder, worktree, readOnly: !worktree, closedAt: 1 }
      const r = rig({ files: { [join(STATE, '101.json')]: JSON.stringify(state) } })
      r.dirs.add(folder)
      await r.manager.close({ rootId: '101', removeWorktree: true })
      await r.manager.idle()
      assert.deepEqual(r.removed.filter((p) => !p.startsWith(join(HOME, '.claude') + sep)), [], `${folder} (worktree ${worktree})`)
      assert.equal(r.gitCalls.some((a) => a.includes('worktree') && a.includes(folder)), false, `${folder}: no git worktree remove`)
      assert.equal(r.branchesDeleted.length, 0, `${folder}: no branch deleted`)
      assert.equal(r.files.has(join(STATE, '101.json')), false, 'the bad state file itself goes')
    }
  }
})

test('the 7 day sweep refuses a state folder outside the threads folder too', async () => {
  const state = { rootId: '101', chatId: '55', title: 'T', forkSessionId: null, folder: resolve('/work'), cwd: resolve('/work'), worktree: false, readOnly: true, closedAt: 1 }
  const r = rig({ files: { [join(STATE, '101.json')]: JSON.stringify(state) } })
  assert.deepEqual(await r.manager.sweepClosed(30 * DAY), ['101'])
  assert.deepEqual(r.removed, [])
})

// -- gate review finding 1: a reconnect never runs a finished turn again --

const pendingRow = (rootId: string, replyId: string, text: string) => ({ chatId: '55', rootId, replyId, mode: 'reply', text, title: `T${rootId}`, assistantId: '7' })
const replyTexts = (r: ReturnType<typeof rig>) => r.posts.filter((p) => p.path === 'integrations/threads/reply').map((p) => p.body.text)

test('a reconnect while the reply post is being retried never runs the finished turn again', async () => {
  let failures = 1
  const r = rig({ failPosts: (path) => path === 'integrations/threads/reply' && failures-- > 0 })
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const c = r.spawned[0]!.child
  c.init(FORK_A)
  c.result('the answer.')
  await flush()
  const retry = r.live(THREAD_POST_RETRY_MS[0]!)
  assert.equal(retry.length, 1, 'the reply post waits to be tried again')
  // The server still lists the thread: its last row is the person's.
  const pending = r.manager.reconcile(async () => ({ turns: [pendingRow('101', '1010', 'work on 101')] }), { assistantIds: ['7'] })
  await flush()
  r.fire(retry[0]!)
  assert.equal(await pending, 0)
  await r.manager.idle()
  assert.equal(c.stdin.length, 1, 'the turn was written to the lane once')
  assert.equal(r.spawned.length, 1)
  assert.deepEqual(replyTexts(r), ['the answer.'], 'one answer, never a second one')
})

test('a new reply listed while the last answer is still being posted runs once that post has settled', async () => {
  let failures = 1
  const r = rig({ failPosts: (path) => path === 'integrations/threads/reply' && failures-- > 0 })
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const c = r.spawned[0]!.child
  c.init(FORK_A)
  c.result('the answer.')
  await flush()
  const pending = r.manager.reconcile(async () => ({ turns: [pendingRow('101', '1011', 'and more')] }), { assistantIds: ['7'] })
  await flush()
  assert.equal(c.stdin.length, 1, 'nothing runs while a post for that thread is in flight')
  r.fire(r.live(THREAD_POST_RETRY_MS[0]!)[0]!)
  assert.equal(await pending, 1)
  await r.manager.idle()
  assert.deepEqual(c.stdin, [c.stdin[0], userMessageLine('and more')])
})

test('after a daemon restart a listed turn that already finished is never run again: the thread goes back to open', async () => {
  // The daemon dies while the answer is still being retried: it never lands.
  const r1 = rig({ failPosts: (path) => path === 'integrations/threads/reply' })
  r1.manager.turn(turn('101'))
  await r1.manager.idle()
  r1.spawned[0]!.child.init(FORK_A)
  r1.spawned[0]!.child.result('the answer.')
  await flush()
  assert.equal(JSON.parse(r1.files.get(join(STATE, '101.json'))!).lastReplyId, '1010', 'the finished reply is saved with the lane')
  assert.equal(JSON.parse(r1.files.get(join(STATE, '101.json'))!).lastDelivered, false)
  // The server still lists the thread.
  const r2 = rig({ files: Object.fromEntries(r1.files) })
  assert.equal(await r2.manager.reconcile(async () => ({ turns: [pendingRow('101', '1010', 'work on 101')] }), { assistantIds: ['7'] }), 0)
  await r2.manager.idle()
  assert.equal(r2.spawned.length, 0, 'no lane runs it again')
  assert.deepEqual(statePosts(r2), ['101:open'])
  const notice = r2.posts.find((p) => p.path === 'integrations/threads/reply')!.body
  assert.match(String(notice.text), /could not be delivered/)
  assert.equal(notice.clientId, 'thread-101-1010', 'the same client id as the lost answer, so the server keeps one')
  // A reply the person sent after it still runs.
  assert.equal(await r2.manager.reconcile(async () => ({ turns: [pendingRow('101', '1011', 'more')] }), { assistantIds: ['7'] }), 1)
  await r2.manager.idle()
  assert.equal(r2.spawned.length, 1)
})

test('a reconnect after every post of a finished turn failed puts the thread back to open, never runs it again', async () => {
  let down = true
  const r = rig({ failPosts: (path) => down && path === 'integrations/threads/reply' })
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const c = r.spawned[0]!.child
  c.init(FORK_A)
  c.result('the answer.')
  // The answer, then its failure reply, each given up after every retry.
  for (let round = 0; round < 2; round++) {
    for (const ms of THREAD_POST_RETRY_MS) {
      await flush()
      r.fire(r.live(ms)[0]!)
    }
  }
  await r.manager.idle()
  assert.deepEqual(replyTexts(r), [])
  down = false
  assert.equal(await r.manager.reconcile(async () => ({ turns: [pendingRow('101', '1010', 'work on 101')] }), { assistantIds: ['7'] }), 0)
  await r.manager.idle()
  assert.equal(c.stdin.length, 1, 'never written to the lane again')
  assert.match(String(replyTexts(r)[0]), /could not be delivered/)
  assert.equal(statePosts(r).at(-1), '101:open')
})

// -- gate review finding 2: a CLI that cannot run a lane says so --

test('on a claude too old for a confined lane the turn fails with the real cause, and nothing is made or started', async () => {
  const sentence = 'This turn failed because Claude Code on this computer cannot run threads: it is version 2.1.250 and threads need 2.1.301 or later. Update Claude Code, then send your reply again.'
  const r = rig({ cliProblem: sentence })
  r.manager.turn(turn('101'))
  await r.manager.idle()
  assert.equal(r.spawned.length, 0)
  assert.equal(r.gitCalls.some((a) => a.includes('worktree')), false, 'no worktree for a lane that cannot start')
  assert.deepEqual(statePosts(r), ['101:working', '101:open'])
  assert.deepEqual(replyTexts(r), [sentence])
  assert.equal(r.manager.runningCount(), 0, 'its slot is free')
})

// -- gate review finding 6: the manager hands the lane its secret paths --

test('a working lane refuses Bash reads of ~/.ssh, the CLI credentials and ~/.bgos-agent', POSIX_SANDBOX, async () => {
  const r = rig({ files: { [join(HOME, '.claude/.credentials.json')]: '{}', [join(HOME, '.bgos-agent/credentials-7.json')]: '{}' } })
  r.dirs.add(join(HOME, '.ssh'))
  r.dirs.add(join(HOME, '.bgos-agent'))
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const args = r.spawned[0]!.args
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]!)
  assert.deepEqual(settings.sandbox.filesystem.denyRead, [join(HOME, '.ssh'), join(HOME, '.claude/.credentials.json'), join(HOME, '.bgos-agent')])
  assert.deepEqual(settings.sandbox.filesystem.allowRead, [join(HOME, '.bgos-agent/email-files/7')])
})

// -- gate review finding 4: the source repository's refs, all of them --

const laneSettings = (r: ReturnType<typeof rig>, i = 0) => {
  const args = r.spawned[i]!.args
  return { tools: args[args.indexOf('--tools') + 1]!.split(','), settings: JSON.parse(args[args.indexOf('--settings') + 1]!) }
}

test('a repository on the reftable backend keeps every ref in one place the sandbox cannot split: the lane runs without Bash', POSIX_SANDBOX, async () => {
  const r = rig({ git: (sub) => (sub[0] === 'rev-parse' && sub[1] === '--show-ref-format' ? { ok: true, stdout: 'reftable\n' } : undefined) })
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const { tools, settings } = laneSettings(r)
  assert.equal(tools.includes('Bash'), false)
  assert.equal(settings.sandbox, undefined)
})

test('on Linux a branch kept only in packed-refs is written out as a loose ref before the lane starts, so the sandbox can protect it', POSIX_SANDBOX, async () => {
  const SHA = 'a'.repeat(40)
  const r = rig({
    platform: 'linux',
    git: (sub) => (sub[0] === 'rev-parse' && sub[1] === '--verify' ? { ok: true, stdout: `${SHA}\n` } : undefined),
  })
  r.manager.turn(turn('101'))
  await r.manager.idle()
  assert.equal(r.files.get(join(AGENT, '.git/refs/heads/main')), `${SHA}\n`, 'the loose ref, same commit as the packed one')
  assert.equal(r.files.has(join(AGENT, '.git/refs/heads/main.lock')), false, 'written through a lock, then renamed')
  assert.ok(r.gitCalls.some((a) => a.join(' ') === `-C ${AGENT} rev-parse --verify --quiet refs/heads/main^{commit}`))
  assert.equal(r.files.has(join(AGENT, '.git/refs/heads/hoai/thread-101')), false, "never the lane's own branch")
  for (const d of ['refs/tags', 'refs/remotes', 'refs/notes', 'refs/replace']) assert.ok(r.dirs.has(join(AGENT, '.git', d)), `${d} exists, so it can be bound read only`)
  assert.ok(laneSettings(r).tools.includes('Bash'))
})

test('on Linux a packed-only branch that cannot be written out leaves the lane without Bash, never unprotected', POSIX_SANDBOX, async () => {
  const r = rig({ platform: 'linux', git: (sub) => (sub[0] === 'rev-parse' && sub[1] === '--verify' ? { ok: false, stdout: '' } : undefined) })
  r.manager.turn(turn('101'))
  await r.manager.idle()
  assert.equal(laneSettings(r).tools.includes('Bash'), false)
})

test('on macOS nothing is written into the source repository (the sandbox denies a path that does not exist yet)', POSIX_SANDBOX, async () => {
  const r = rig({ platform: 'darwin' })
  r.manager.turn(turn('101'))
  await r.manager.idle()
  assert.equal(r.files.has(join(AGENT, '.git/refs/heads/main')), false)
  assert.equal(r.gitCalls.some((a) => a.includes('--verify')), false)
})

// -- gate review finding 3: never two lanes on one thread after a daemon crash --

const saved = (r: ReturnType<typeof rig>, root = '101') => JSON.parse(r.files.get(join(STATE, `${root}.json`))!)
/** A daemon that crashed while lane 101 ran: its state names the process, which is still finishing its turn. */
function crashedWithOrphan(dies: 'SIGTERM' | 'SIGKILL' | 'never', stamp = 'S777') {
  const state = { rootId: '101', chatId: '55', title: 'T', forkSessionId: FORK_A, folder: wt('101'), cwd: wt('101'), worktree: true, readOnly: false, closedAt: null, lastReplyId: '1010', pid: 777, pidStamp: 'S777' }
  const r = rig({ files: { [join(STATE, '101.json')]: JSON.stringify(state) } })
  r.dirs.add(wt('101'))
  r.procs.set(777, { stamp, alive: true, dies })
  return r
}
/** Fire the orphan wait's poll timers until the lane spawns or the wait gives up. */
async function pollOut(r: ReturnType<typeof rig>) {
  for (let i = 0; i < 200; i++) {
    await flush()
    const t = r.live(THREAD_ORPHAN_POLL_MS)
    if (t.length === 0) break
    r.fire(t[0]!)
  }
  await r.manager.idle()
}

test('a lane process is written into the lane state with its start stamp, and taken out when it exits', async () => {
  const r = rig()
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const pid = r.spawned[0]!.child.pid!
  assert.equal(saved(r).pid, pid)
  assert.equal(saved(r).pidStamp, `S${pid}`)
  r.spawned[0]!.child.exit(0)
  await r.manager.idle()
  assert.equal(saved(r).pid, null)
  assert.equal(saved(r).pidStamp, null)
})

test('after a daemon crash the old lane process is stopped (its whole group) before the thread runs again', async () => {
  const r = crashedWithOrphan('SIGTERM')
  r.manager.turn(turn('101', { mode: 'reply', replyId: '1011', text: 'again' }))
  await pollOut(r)
  assert.deepEqual(r.procKills, [[777, 'SIGTERM']])
  assert.equal(r.procs.get(777)!.alive, false)
  assert.equal(r.spawned.length, 1, 'one lane, never two')
  assert.equal(saved(r).pid, r.spawned[0]!.child.pid)
})

test('an old lane process that ignores SIGTERM gets SIGKILL after the grace, then the new one starts', async () => {
  const r = crashedWithOrphan('SIGKILL')
  r.manager.turn(turn('101', { mode: 'reply', replyId: '1011', text: 'again' }))
  await flush()
  assert.equal(r.spawned.length, 0, 'nothing starts while the old one lives')
  await pollOut(r)
  assert.deepEqual(r.procKills, [[777, 'SIGTERM'], [777, 'SIGKILL']])
  assert.equal(r.spawned.length, 1)
})

test('an old lane process that cannot be stopped fails the turn in plain words, and starts nothing', async () => {
  const r = crashedWithOrphan('never')
  r.manager.turn(turn('101', { mode: 'reply', replyId: '1011', text: 'again' }))
  await pollOut(r)
  assert.equal(r.spawned.length, 0)
  assert.match(String(replyTexts(r).at(-1)), /earlier run of this thread is still stopping/)
  assert.equal(statePosts(r).at(-1), '101:open')
})

test('a pid now held by another process (its start stamp differs) is never signalled', async () => {
  const r = crashedWithOrphan('SIGTERM', 'S-someone-else')
  r.manager.turn(turn('101', { mode: 'reply', replyId: '1011', text: 'again' }))
  await pollOut(r)
  assert.deepEqual(r.procKills, [])
  assert.equal(r.spawned.length, 1)
})

test('closing or deleting a thread after a daemon crash stops its old lane process too', async () => {
  for (const removeWorktree of [false, true]) {
    const r = crashedWithOrphan('SIGTERM')
    await r.manager.close({ rootId: '101', removeWorktree })
    await pollOut(r)
    assert.deepEqual(r.procKills, [[777, 'SIGTERM']], `removeWorktree ${removeWorktree}`)
  }
})

// -- follow up (Data, item 1): a summary or answer that landed is never reopened after a restart --

test('after a restart a listed row naming a summary that already landed leaves the thread alone', async () => {
  const r1 = rig()
  r1.manager.turn(turn('101'))
  await r1.manager.idle()
  const c = r1.spawned[0]!.child
  c.init(FORK_A)
  c.result('done.')
  await r1.manager.idle()
  r1.manager.turn(turn('101', { mode: 'summary', replyId: '1012', text: '' }))
  await r1.manager.idle()
  c.result('- what was asked\n- what was done')
  await r1.manager.idle()
  assert.ok(r1.posts.some((p) => p.path === 'integrations/threads/summary'), 'the summary landed')
  assert.equal(JSON.parse(r1.files.get(join(STATE, '101.json'))!).lastDelivered, true)
  // The server's pending list still names the summary request (a summary is no thread reply).
  const r2 = rig({ files: Object.fromEntries(r1.files) })
  assert.equal(await r2.manager.reconcile(async () => ({ turns: [{ ...pendingRow('101', '1012', ''), mode: 'summary' }] }), { assistantIds: ['7'] }), 0)
  await r2.manager.idle()
  assert.deepEqual(r2.posts, [], 'no state change, no notice: the thread is not reopened')
  assert.equal(r2.spawned.length, 0)
})

test('after a restart a listed row naming an answer that already landed posts nothing either', async () => {
  const r1 = rig()
  r1.manager.turn(turn('101'))
  await r1.manager.idle()
  r1.spawned[0]!.child.init(FORK_A)
  r1.spawned[0]!.child.result('the answer.')
  await r1.manager.idle()
  const r2 = rig({ files: Object.fromEntries(r1.files) })
  assert.equal(await r2.manager.reconcile(async () => ({ turns: [pendingRow('101', '1010', 'work on 101')] }), { assistantIds: ['7'] }), 0)
  await r2.manager.idle()
  assert.deepEqual(r2.posts, [])
  assert.equal(r2.spawned.length, 0)
})

test('a delayed summary from a closed lane cannot overwrite its reopened lane state', async () => {
  for (const closeAgain of [false, true]) {
    const r = rig()
    let release: () => void = () => {}
    const pending = new Promise<void>((resolve) => { release = resolve })
    const post = r.deps.post
    r.deps.post = async (path, body) => {
      if (path === 'integrations/threads/summary') await pending
      return post(path, body)
    }
    try {
      r.manager.turn(turn('101'))
      await r.manager.idle()
      const first = r.spawned[0]!.child
      first.init(FORK_A)
      first.result('done.')
      await r.manager.idle()
      r.manager.turn(turn('101', { mode: 'summary', replyId: '1012', text: '' }))
      await r.manager.idle()
      first.result('the summary')
      await flush()
      await r.manager.close({ rootId: '101', removeWorktree: false })
      first.exit()
      await flush()
      r.manager.turn(turn('101', { mode: 'reply', replyId: '1013', text: 'new work' }))
      await flush()
      assert.equal(r.spawned.length, 2)
      let reopened = saved(r)
      assert.equal(reopened.closedAt, null)
      assert.equal(reopened.pid, r.spawned[1]!.child.pid)
      if (closeAgain) {
        r.clock.now += 1234
        await r.manager.close({ rootId: '101', removeWorktree: false })
        r.spawned[1]!.child.exit()
        await flush()
        reopened = saved(r)
        assert.equal(reopened.closedAt, r.clock.now)
      }
      release()
      await r.manager.idle()
      assert.deepEqual(saved(r), { ...reopened, lastDelivered: true }, 'mark the matching reply without erasing the new pid or restoring closedAt')
    } finally {
      release()
      await r.manager.idle()
    }
  }
})

test('a lane state saved before lastDelivered existed still gets the notice (never a silent stuck thread)', async () => {
  const state = { rootId: '101', chatId: '55', title: 'T', forkSessionId: FORK_A, folder: wt('101'), cwd: wt('101'), worktree: true, readOnly: false, closedAt: null, lastReplyId: '1010' }
  const r = rig({ files: { [join(STATE, '101.json')]: JSON.stringify(state) } })
  assert.equal(await r.manager.reconcile(async () => ({ turns: [pendingRow('101', '1010', 'x')] }), { assistantIds: ['7'] }), 0)
  await r.manager.idle()
  assert.deepEqual(statePosts(r), ['101:open'])
})

// -- follow up (Data, item 4): on Linux the stash paths exist before the lane starts --

test('on Linux with no stash yet, refs/stash is made an empty folder and logs/refs/stash an empty file, so both can be bound read only', POSIX_SANDBOX, async () => {
  const SHA = 'a'.repeat(40)
  const r = rig({ platform: 'linux', git: (sub) => (sub[0] === 'rev-parse' && sub[1] === '--verify' ? { ok: true, stdout: `${SHA}\n` } : undefined) })
  r.manager.turn(turn('101'))
  await r.manager.idle()
  assert.ok(r.dirs.has(join(AGENT, '.git/refs/stash')), 'an empty folder git ignores, and replaces on the owner\'s own git stash')
  assert.equal(r.files.has(join(AGENT, '.git/refs/stash')), false, 'never an empty ref file (git warns of a broken ref)')
  assert.equal(r.files.get(join(AGENT, '.git/logs/refs/stash')), '')
  assert.ok(r.dirs.has(join(AGENT, '.git/hooks')))
  assert.ok(laneSettings(r).tools.includes('Bash'))
})

test('on Linux an existing stash is left exactly as it is', POSIX_SANDBOX, async () => {
  const SHA = 'a'.repeat(40)
  const r = rig({
    platform: 'linux',
    files: { [join(AGENT, '.git/refs/stash')]: `${SHA}\n`, [join(AGENT, '.git/logs/refs/stash')]: 'entries\n' },
    git: (sub) => (sub[0] === 'rev-parse' && sub[1] === '--verify' ? { ok: true, stdout: `${SHA}\n` } : undefined),
  })
  r.manager.turn(turn('101'))
  await r.manager.idle()
  assert.equal(r.files.get(join(AGENT, '.git/refs/stash')), `${SHA}\n`)
  assert.equal(r.files.get(join(AGENT, '.git/logs/refs/stash')), 'entries\n')
  assert.equal(r.dirs.has(join(AGENT, '.git/refs/stash')), false)
})

test('on Linux a stash log that cannot be made leaves the lane without Bash', POSIX_SANDBOX, async () => {
  const SHA = 'a'.repeat(40)
  const r = rig({ platform: 'linux', git: (sub) => (sub[0] === 'rev-parse' && sub[1] === '--verify' ? { ok: true, stdout: `${SHA}\n` } : undefined) })
  const create = r.deps.fs.createExclusive
  r.deps.fs.createExclusive = (p, d) => { if (p.endsWith(join('logs', 'refs', 'stash'))) throw new Error('EACCES'); create(p, d) }
  r.manager.turn(turn('101'))
  await r.manager.idle()
  assert.equal(laneSettings(r).tools.includes('Bash'), false)
})

test('a working lane can read its own email files but not the rest of ~/.bgos-agent', POSIX_SANDBOX, async () => {
  const r = rig({ files: { [join(HOME, '.bgos-agent/credentials-7.json')]: '{}', [join(HOME, '.bgos-agent/email-files/7/1/a.pdf')]: 'x', [join(HOME, '.bgos-agent/email-files/8/1/b.pdf')]: 'y' } })
  for (const d of ['.bgos-agent', '.bgos-agent/email-files', '.bgos-agent/email-files/7', '.bgos-agent/email-files/8']) r.dirs.add(join(HOME, d))
  r.deps.fs.list = (d) => ({
    [join(HOME, '.bgos-agent')]: ['credentials-7.json', 'email-files'],
    [join(HOME, '.bgos-agent/email-files')]: ['7', '8'],
  } as Record<string, string[]>)[d] ?? []
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const deny: string[] = laneSettings(r).settings.sandbox.filesystem.denyRead
  assert.deepEqual(deny, [join(HOME, '.bgos-agent')])
  assert.deepEqual(laneSettings(r).settings.sandbox.filesystem.allowRead, [join(HOME, '.bgos-agent/email-files/7')])
})

test('pairing another agent after a lane starts cannot expose its new credentials through the attachment exception', POSIX_SANDBOX, async () => {
  const agents = join(HOME, '.bgos-agent')
  const ownFiles = join(agents, 'email-files/7')
  const r = rig({ files: { [join(agents, 'credentials-7.json')]: '{}', [join(ownFiles, '1/a.pdf')]: 'attachment' } })
  for (const path of [agents, join(agents, 'email-files'), ownFiles]) r.dirs.add(path)
  r.deps.fs.list = (dir) => dir === agents ? ['credentials-7.json', 'email-files'] : dir === join(agents, 'email-files') ? ['7'] : []
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const filesystem = laneSettings(r).settings.sandbox.filesystem
  // The owner pairs agent 8 after this child's settings have been frozen.
  const futureCredential = join(agents, 'credentials-8.json')
  r.files.set(futureCredential, '{"token":"new-agent"}')
  assert.ok(filesystem.denyRead.includes(agents), 'the parent deny covers credentials created after startup')
  assert.deepEqual(filesystem.allowRead, [ownFiles], 'only this agent attachments reopen the denied tree')
  assert.equal(filesystem.allowRead.some((path: string) => futureCredential === path || futureCredential.startsWith(`${path}${sep}`)), false)
  assert.ok(laneSettings(r).tools.includes('Bash'), 'attachment access does not cost the working lane its shell')
})

test('a workspace inside the credential tree and its attachments reopen only their own directories', POSIX_SANDBOX, async () => {
  const agents = join(HOME, '.bgos-agent')
  const workspace = join(agents, '7-workspace')
  const ownFiles = join(agents, 'email-files/7')
  const r = rig()
  r.deps.agentFolder = workspace
  r.dirs.add(agents)
  r.files.set(sessionTranscriptPath(HOME, workspace, MAIN, ''), '{"main":true}\n')
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const filesystem = laneSettings(r).settings.sandbox.filesystem
  assert.ok(filesystem.denyRead.includes(agents))
  assert.deepEqual(filesystem.allowRead, [workspace, ownFiles])
})

// -- follow up (Data, item 3): the pid is kept even when no start stamp can be read at spawn --

test('a lane whose start stamp cannot be read at spawn still has its pid saved, and its stamp once it can be read', async () => {
  const r = rig()
  r.ctl.stampDown = true
  r.manager.turn(turn('101'))
  await r.manager.idle()
  const c = r.spawned[0]!.child
  assert.equal(saved(r).pid, c.pid, 'the pid from the child handle')
  assert.equal(saved(r).pidStamp, null)
  r.ctl.stampDown = false
  c.init(FORK_A)
  await r.manager.idle()
  assert.equal(saved(r).pidStamp, `S${c.pid}`, 'read again on the next frame')
})

test('after a crash, an unstamped pid is never signalled and blocks a duplicate while still in the lane folder', async () => {
  for (const where of [wt('101'), '/somewhere/else']) {
    const state = { rootId: '101', chatId: '55', title: 'T', forkSessionId: FORK_A, folder: wt('101'), cwd: wt('101'), worktree: true, readOnly: false, closedAt: null, lastReplyId: '1010', lastDelivered: true, pid: 777, pidStamp: null }
    const r = rig({ files: { [join(STATE, '101.json')]: JSON.stringify(state) } })
    r.dirs.add(wt('101'))
    r.procs.set(777, { stamp: 'S777', alive: true, dies: 'SIGTERM' })
    r.procCwd.set(777, where)
    r.manager.turn(turn('101', { mode: 'reply', replyId: '1011', text: 'again' }))
    await pollOut(r)
    assert.deepEqual(r.procKills, [], where)
    assert.equal(r.spawned.length, where === wt('101') ? 0 : 1)
    if (where === wt('101')) {
      assert.equal(saved(r).pid, 777, 'keep the uncertain pid for the next check')
      assert.match(String(replyTexts(r).at(-1)), /earlier run of this thread is still stopping/)
      r.procs.get(777)!.alive = false
      r.manager.turn(turn('101', { mode: 'reply', replyId: '1012', text: 'retry after it exited' }))
      await pollOut(r)
      assert.equal(r.spawned.length, 1, 'the next turn can run once the old process is gone')
    }
  }
})

test('delete and the closed-thread sweep retain a folder used by an unstamped process', async () => {
  for (const action of ['delete', 'sweep']) {
    const state = { rootId: '101', chatId: '55', title: 'T', forkSessionId: FORK_A, folder: wt('101'), cwd: wt('101'), worktree: true, readOnly: false, closedAt: 1, lastReplyId: '1010', lastDelivered: true, pid: 777, pidStamp: null }
    const r = rig({ files: { [join(STATE, '101.json')]: JSON.stringify(state) } })
    r.dirs.add(wt('101'))
    r.procs.set(777, { stamp: 'a reused pid', alive: true, dies: 'SIGTERM' })
    r.procCwd.set(777, wt('101'))
    if (action === 'delete') {
      await r.manager.close({ rootId: '101', removeWorktree: true })
      await pollOut(r)
    } else {
      assert.deepEqual(await r.manager.sweepClosed(30 * DAY), [])
    }
    assert.deepEqual(r.procKills, [], action)
    assert.deepEqual(r.removed, [], action)
    assert.deepEqual(r.branchesDeleted, [], action)
    assert.equal(saved(r).pid, 777, action)
  }
})

for (const action of ['replacement', 'delete', 'sweep']) {
  test(`unknown cwd inspection preserves a live unstamped PID during ${action}`, async () => {
    const state = { rootId: '101', chatId: '55', title: 'T', forkSessionId: FORK_A, folder: wt('101'), cwd: wt('101'), worktree: true, readOnly: false, closedAt: action === 'replacement' ? null : 1, lastReplyId: '1010', lastDelivered: true, pid: 777, pidStamp: null }
    const r = rig({ files: { [join(STATE, '101.json')]: JSON.stringify(state) } })
    r.dirs.add(wt('101'))
    r.procs.set(777, { stamp: 'S777', alive: true, dies: 'SIGTERM' })
    r.procCwd.set(777, wt('101'))
    // The process survived the daemon. Its initial stamp and recovery lsof failed.
    r.deps.processes.runsIn = async () => null
    if (action === 'replacement') {
      r.manager.turn(turn('101', { mode: 'reply', replyId: '1011', text: 'again' }))
      await pollOut(r)
    } else if (action === 'delete') {
      await r.manager.close({ rootId: '101', removeWorktree: true })
      await pollOut(r)
    } else {
      await r.manager.sweepClosed(30 * DAY)
    }
    assert.equal(r.spawned.length, 0, `${action}: no replacement while inspection is unknown`)
    assert.equal(r.removed.length, 0, `${action}: preserve the active folder`)
    assert.equal(r.files.has(join(STATE, '101.json')), true, `${action}: preserve the lane state`)
    assert.equal(saved(r).pid, 777, `${action}: retain the uncertain PID`)
    assert.equal(saved(r).pidStamp, null)
    assert.deepEqual(r.procKills, [], `${action}: never signal an unverified process`)
    assert.deepEqual(r.branchesDeleted, [], `${action}: preserve the active branch`)
    assert.equal(r.procs.get(777)!.alive, true)
    // Once inspection confirms it is gone, the retained state can make progress.
    r.procs.get(777)!.alive = false
    r.deps.processes.runsIn = async () => false
    if (action === 'replacement') {
      r.manager.turn(turn('101', { mode: 'reply', replyId: '1012', text: 'retry' }))
      await pollOut(r)
      assert.equal(r.spawned.length, 1)
    } else {
      if (action === 'delete') await r.manager.close({ rootId: '101', removeWorktree: true })
      else await r.manager.sweepClosed(30 * DAY)
      await pollOut(r)
      assert.ok(r.removed.includes(wt('101')), `${action}: cleanup resumes after confirmed exit`)
    }
  })
}

for (const action of ['replacement', 'delete', 'sweep']) {
  test(`unknown stamp inspection preserves a live stamped PID during ${action}`, async () => {
    const r = crashedWithOrphan('SIGTERM')
    if (action === 'sweep') {
      const state = saved(r)
      state.closedAt = 1
      r.files.set(join(STATE, '101.json'), JSON.stringify(state))
    }
    r.ctl.stampDown = true
    if (action === 'replacement') r.manager.turn(turn('101', { mode: 'reply', replyId: '1011', text: 'again' }))
    else if (action === 'delete') await r.manager.close({ rootId: '101', removeWorktree: true })
    else assert.deepEqual(await r.manager.sweepClosed(30 * DAY), [])
    await pollOut(r)
    assert.equal(r.spawned.length, 0, 'do not replace an unverified live process')
    assert.equal(r.files.has(join(STATE, '101.json')), true, 'keep the uncertain process state')
    assert.equal(saved(r).pid, 777)
    assert.equal(saved(r).pidStamp, 'S777')
    assert.equal(r.dirs.has(wt('101')), true)
    assert.deepEqual(r.removed, [])
    assert.deepEqual(r.branchesDeleted, [])
    assert.deepEqual(r.procKills, [], 'do not signal an unverified identity')
    assert.equal(r.procs.get(777)!.alive, true)
    // Once the saved identity is readable again, normal recovery may stop it.
    r.ctl.stampDown = false
    if (action === 'replacement') r.manager.turn(turn('101', { mode: 'reply', replyId: '1012', text: 'retry' }))
    else if (action === 'delete') await r.manager.close({ rootId: '101', removeWorktree: true })
    else assert.deepEqual(await r.manager.sweepClosed(30 * DAY), ['101'])
    await pollOut(r)
    assert.deepEqual(r.procKills, [[777, 'SIGTERM']])
    assert.equal(r.procs.get(777)!.alive, false)
    if (action === 'replacement') assert.equal(r.spawned.length, 1)
    else assert.equal(r.files.has(join(STATE, '101.json')), false)
  })
}

test('stamp inspection lost after SIGTERM preserves the PID and does not signal an unverified process again', async () => {
  const r = crashedWithOrphan('never')
  const kill = r.deps.processes.kill
  r.deps.processes.kill = (pid, signal) => { kill(pid, signal); r.ctl.stampDown = true }
  r.manager.turn(turn('101', { mode: 'reply', replyId: '1011', text: 'again' }))
  await pollOut(r)
  assert.deepEqual(r.procKills, [[777, 'SIGTERM']], 'only the initially verified identity may be signalled')
  assert.equal(r.spawned.length, 0)
  assert.equal(saved(r).pid, 777)
  assert.equal(saved(r).pidStamp, 'S777')
  assert.equal(r.procs.get(777)!.alive, true)
  r.procs.get(777)!.alive = false
  r.ctl.stampDown = false
  r.manager.turn(turn('101', { mode: 'reply', replyId: '1012', text: 'retry after exit' }))
  await pollOut(r)
  assert.equal(r.spawned.length, 1, 'confirmed absence permits a later retry')
})

test('a turn waits for the CLI answer without blocking, and fails with its cause when it comes', async () => {
  let answer: (s: string | null) => void = () => {}
  const r = rig({ cliProblem: () => new Promise((done) => { answer = done }) })
  assert.deepEqual(r.manager.turn(turn('101')), { accepted: true, state: 'working' }, 'answered at once')
  await flush()
  assert.equal(r.spawned.length, 0)
  answer('This turn failed because Claude Code on this computer cannot run threads: its version could not be read. Update Claude Code, then send your reply again.')
  await r.manager.idle()
  assert.equal(r.spawned.length, 0)
  assert.match(String(replyTexts(r).at(-1)), /version could not be read/)
})
