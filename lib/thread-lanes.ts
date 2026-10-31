/**
 * Thread lanes on Claude Code (Threads phase 1, spec 7.3 and 19).
 *
 * A thread is a parallel conversation about one message of the agent chat. On
 * this host it runs as its own headless `claude -p` (stream json in and out),
 * forked from the chat's MAIN session on its first start (`--resume <main>
 * --fork-session`) and resumed by its own session id after that, so it knows
 * everything the chat knew and never writes into it.
 *
 *  - Key: the thread's root message id. Phase 1 is the owner's lanes only, and
 *    one manager serves one agent, so the root alone is the
 *    `${assistantId}:${rootId}` key.
 *  - Slots: at most 2 lanes run a turn at once per agent; a third waits FIFO
 *    (state "waiting" posted) and starts when a slot frees. Turns for one
 *    thread are serialized.
 *  - Idle stop: a lane with no turn for 20 minutes is stopped (SIGTERM, then
 *    SIGKILL after 10 s); its next turn resumes it by its own id.
 *  - Working tree: the daemon (never the lane) runs `git worktree add
 *    .hoai/threads/<root> -b hoai/thread-<root>` in the agent folder, and the
 *    lane works there; `.hoai/` is excluded through `.git/info/exclude`, never
 *    the tracked .gitignore. A folder that is no repository gets a plain
 *    folder and a read only lane (the editing tools refused).
 *  - Transcript: the CLI looks a `--resume` id up in the project dir of its
 *    cwd, so before the first start the main transcript is copied into the
 *    worktree's project dir; the copy goes once the fork's init frame shows it
 *    was read. The fork's own file stays: it is the thread's memory.
 *  - Each result is ONE thread reply (`final` unless it ends asking a
 *    question); a summary turn posts the draft to the summary route instead.
 *  - Close stops the lane and keeps the worktree for 7 days (sweepClosed);
 *    delete also removes the worktree, the fork's session file and the state.
 *
 * Every effect is an injected dependency, so the whole manager is unit tested
 * with fakes (test/thread-lanes.test.ts). Erasable TypeScript only.
 */

import { dirname, join, resolve } from 'node:path'

import { isFinalReply, isSessionId, threadLaneArgs, threadTurnPrompt, type ThreadTurnMode } from './thread-lane-args.ts'
import { lineSplitter, userMessageLine, type SpawnStreamJson, type StreamJsonChild } from './stream-json-child.ts'
import { sessionTranscriptPath } from '../bin/hoai-core.mjs'

export const THREAD_LANE_MAX_RUNNING = 2
export const THREAD_LANE_IDLE_MS = 20 * 60_000
export const THREAD_LANE_KILL_GRACE_MS = 10_000
export const THREAD_LANE_KEEP_CLOSED_MS = 7 * 24 * 60 * 60_000

const ROOT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MODES: readonly string[] = ['start', 'reply', 'summary']

const FAILED_TURN = 'This turn failed before the agent could answer, so send your reply again to retry.'
const NO_SESSION = 'This thread could not start because the agent has no running session to fork yet.'
const NO_CLAUDE = 'This turn failed because this computer cannot run Claude Code right now.'
const NO_WORKTREE = 'This thread could not start because its working copy could not be made.'

export class ThreadLaneError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface ThreadTurnInput {
  chatId: string
  rootId: string
  replyId: string
  mode: ThreadTurnMode
  text: string
  title: string
  rootText: string
}

export interface ThreadLaneFs {
  exists(path: string): boolean
  mkdir(path: string): void
  readFile(path: string): string
  writeFile(path: string, data: string): void
  appendFile(path: string, data: string): void
  copyFile(from: string, to: string): void
  unlink(path: string): void
  rmrf(path: string): void
  list(dir: string): string[]
}

export interface ThreadLaneDeps {
  spawn: SpawnStreamJson
  claudeBin(): string | null
  mainSessionId(): string | null
  /** The folder the main session runs in. */
  agentFolder: string
  /** Where lane state files live, ~/.bgos-agent/<assistantId>/threads. */
  stateDir: string
  home: string
  /** CLAUDE_CONFIG_DIR, '' for ~/.claude. */
  configDir: string
  emptyMcpConfigPath(): string
  git(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string }>
  fs: ThreadLaneFs
  post(path: string, body: Record<string, unknown>): Promise<unknown>
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  log(msg: string): void
  maxRunning?: number
  idleMs?: number
  killGraceMs?: number
  keepClosedMs?: number
}

/** What a lane keeps on disk, one JSON file per thread. */
export interface ThreadLaneState {
  rootId: string
  chatId: string
  title: string
  forkSessionId: string | null
  /** The worktree (or plain folder) root, '' before it exists. */
  folder: string
  /** Where the lane runs: the folder, or the agent folder's place inside the worktree. */
  cwd: string
  worktree: boolean
  readOnly: boolean
  closedAt: number | null
}

interface Lane {
  state: ThreadLaneState
  child: StreamJsonChild | null
  stopping: boolean
  exited: Promise<void>
  graceTimer: unknown
  idleTimer: unknown
  queue: ThreadTurnInput[]
  current: ThreadTurnInput | null
  copiedMainPath: string | null
  posts: Promise<void>
  closed: boolean
  turnCount: number
}

export class ThreadLaneManager {
  private readonly deps: ThreadLaneDeps
  private readonly lanes = new Map<string, Lane>()
  private readonly running = new Set<string>()
  private waiting: string[] = []
  /** A closed lane's child that is still exiting: a reopen waits for it. */
  private readonly exiting = new Map<string, Promise<void>>()
  private readonly work = new Set<Promise<unknown>>()

  constructor(deps: ThreadLaneDeps) {
    this.deps = deps
  }

  private get maxRunning(): number {
    return this.deps.maxRunning ?? THREAD_LANE_MAX_RUNNING
  }

  /** Lanes running a turn right now. */
  runningCount(): number {
    return this.running.size
  }

  /** Resolves once every background step (starts, posts, removals) has settled. */
  async idle(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work])
  }

  /**
   * Take one turn for a thread. Answers at once: the turn runs in the
   * background and its answer arrives through the thread routes.
   */
  turn(input: ThreadTurnInput): { accepted: true; state: 'working' | 'waiting' } {
    validateTurn(input)
    const lane = this.laneFor(input)
    if (lane.state.closedAt !== null) {
      // A turn on a closed thread means it was reopened.
      lane.state.closedAt = null
      if (lane.state.folder) this.persist(lane)
    }
    lane.closed = false
    if (lane.state.title === '' && input.title) lane.state.title = input.title
    const duplicate =
      input.replyId !== '' &&
      (lane.current?.replyId === input.replyId || lane.queue.some((t) => t.replyId === input.replyId))
    if (!duplicate) lane.queue.push(input)
    this.clearIdle(lane)
    if (lane.current) return { accepted: true, state: 'working' }
    if (this.waiting.includes(input.rootId)) return { accepted: true, state: 'waiting' }
    if (this.running.size < this.maxRunning) {
      this.start(lane)
      return { accepted: true, state: 'working' }
    }
    this.waiting.push(input.rootId)
    this.post(lane, 'integrations/threads/state', { chatId: lane.state.chatId, rootId: input.rootId, state: 'waiting' })
    return { accepted: true, state: 'waiting' }
  }

  /** Stop a thread's lane. removeWorktree (delete) also removes its worktree, session file and state. */
  async close(input: { rootId: string; removeWorktree: boolean }): Promise<{ stopped: true }> {
    if (typeof input.rootId !== 'string' || !ROOT_ID_RE.test(input.rootId)) {
      throw new ThreadLaneError('bad_request', 'The thread id is not valid.')
    }
    const rootId = input.rootId
    let lane = this.lanes.get(rootId)
    if (!lane) {
      const saved = this.load(rootId)
      if (!saved) return { stopped: true }
      lane = this.newLane(saved)
    }
    lane.closed = true
    lane.queue = []
    this.waiting = this.waiting.filter((id) => id !== rootId)
    if (lane.current) {
      lane.current = null
      this.running.delete(rootId)
    }
    this.clearIdle(lane)
    let exited: Promise<void> = Promise.resolve()
    if (lane.child) {
      this.stopChild(lane)
      exited = lane.exited
      this.exiting.set(rootId, exited)
      void exited.then(() => {
        if (this.exiting.get(rootId) === exited) this.exiting.delete(rootId)
      })
    }
    this.lanes.delete(rootId)
    if (input.removeWorktree) {
      const state = lane.state
      this.track(exited.then(() => this.removeLane(state)))
    } else if (lane.state.folder) {
      lane.state.closedAt = this.deps.now()
      this.persist(lane)
    }
    this.pump()
    return { stopped: true }
  }

  /** Remove the worktrees of threads closed more than 7 days ago. Answers the root ids removed. */
  async sweepClosed(now: number): Promise<string[]> {
    const keep = this.deps.keepClosedMs ?? THREAD_LANE_KEEP_CLOSED_MS
    let names: string[] = []
    try {
      names = this.deps.fs.list(this.deps.stateDir)
    } catch {
      return []
    }
    const removed: string[] = []
    for (const name of names) {
      const m = /^([A-Za-z0-9_-]{1,64})\.json$/.exec(name)
      if (!m || m[1] === 'empty-mcp') continue
      const rootId = m[1]!
      if (this.lanes.has(rootId)) continue
      const state = this.load(rootId)
      if (!state || state.closedAt === null) continue
      if (now - state.closedAt <= keep) continue
      await this.removeLane(state)
      removed.push(rootId)
    }
    return removed
  }

  /**
   * After a reconnect: ask the server which threads wait on this agent (the
   * newest row is the person's and no lane works on it) and run a reply turn
   * for each that is not already running here. Answers how many started.
   */
  async reconcile(fetchPending: () => Promise<unknown>): Promise<number> {
    const raw = await fetchPending()
    const body = raw as Record<string, unknown> | null
    const rows: unknown[] = Array.isArray(raw)
      ? raw
      : Array.isArray(body?.threads)
        ? (body!.threads as unknown[])
        : Array.isArray(body?.pending)
          ? (body!.pending as unknown[])
          : []
    let started = 0
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      const input: ThreadTurnInput = {
        chatId: str(r.chatId),
        rootId: str(r.rootId),
        replyId: str(r.replyId),
        mode: (MODES.includes(str(r.mode)) ? str(r.mode) : 'reply') as ThreadTurnMode,
        text: str(r.text),
        title: str(r.title),
        rootText: str(r.rootText),
      }
      const lane = this.lanes.get(input.rootId)
      if (lane && (lane.current || lane.queue.length > 0)) continue
      try {
        this.turn(input)
        started++
      } catch (err) {
        this.deps.log(`threads: a pending thread was skipped (${err instanceof Error ? err.message : 'error'})`)
      }
    }
    return started
  }

  /** Daemon shutdown: stop every lane now (synchronous, the process exits next). */
  stopAll(): void {
    this.waiting = []
    for (const lane of this.lanes.values()) {
      this.clearIdle(lane)
      lane.queue = []
      lane.child?.kill('SIGTERM')
    }
  }

  // -- internals --------------------------------------------------------------

  private laneFor(input: ThreadTurnInput): Lane {
    const existing = this.lanes.get(input.rootId)
    if (existing) return existing
    const saved = this.load(input.rootId)
    const lane = this.newLane(
      saved ?? {
        rootId: input.rootId,
        chatId: input.chatId,
        title: input.title,
        forkSessionId: null,
        folder: '',
        cwd: '',
        worktree: false,
        readOnly: false,
        closedAt: null,
      },
    )
    if (saved && saved.chatId === '') lane.state.chatId = input.chatId
    this.lanes.set(input.rootId, lane)
    return lane
  }

  private newLane(state: ThreadLaneState): Lane {
    return {
      state,
      child: null,
      stopping: false,
      exited: Promise.resolve(),
      graceTimer: null,
      idleTimer: null,
      queue: [],
      current: null,
      copiedMainPath: null,
      posts: Promise.resolve(),
      closed: false,
      turnCount: 0,
    }
  }

  private start(lane: Lane): void {
    const turn = lane.queue.shift()
    if (!turn) return
    lane.current = turn
    lane.turnCount++
    this.running.add(lane.state.rootId)
    this.post(lane, 'integrations/threads/state', { chatId: turn.chatId, rootId: turn.rootId, state: 'working' })
    this.track(this.runTurn(lane, turn))
  }

  private async runTurn(lane: Lane, turn: ThreadTurnInput): Promise<void> {
    try {
      await this.ensureChild(lane)
      if (lane.current !== turn || !lane.child) return
      lane.child.write(userMessageLine(threadTurnPrompt({ ...turn, readOnly: lane.state.readOnly })))
    } catch (err) {
      this.deps.log(`threads: turn ${turn.rootId} could not start (${err instanceof ThreadLaneError ? err.code : 'error'})`)
      this.failTurn(lane, turn, err instanceof ThreadLaneError ? err.message : FAILED_TURN)
    }
  }

  /** Give the freed slots to the threads that waited longest. */
  private pump(): void {
    while (this.running.size < this.maxRunning && this.waiting.length > 0) {
      const rootId = this.waiting.shift()!
      const lane = this.lanes.get(rootId)
      if (lane && !lane.closed && !lane.current && lane.queue.length > 0) this.start(lane)
    }
  }

  private afterTurn(lane: Lane): void {
    if (lane.closed) {
      this.pump()
      return
    }
    if (lane.queue.length > 0) {
      // The thread's own next turn queues behind the threads already waiting.
      this.waiting.push(lane.state.rootId)
      this.pump()
      if (this.waiting.includes(lane.state.rootId)) {
        this.post(lane, 'integrations/threads/state', { chatId: lane.state.chatId, rootId: lane.state.rootId, state: 'waiting' })
      }
      return
    }
    this.armIdle(lane)
    this.pump()
  }

  private onResult(lane: Lane, frame: Record<string, unknown>): void {
    const turn = lane.current
    if (!turn) return
    lane.current = null
    this.running.delete(lane.state.rootId)
    const text = typeof frame.result === 'string' ? frame.result : ''
    const failed = frame.is_error === true || (frame.subtype !== undefined && frame.subtype !== 'success') || text.trim() === ''
    if (failed) {
      this.postFailure(lane, turn, FAILED_TURN)
    } else if (turn.mode === 'summary') {
      this.post(lane, 'integrations/threads/summary', { chatId: turn.chatId, rootId: turn.rootId, summary: text })
    } else {
      this.post(lane, 'integrations/threads/reply', {
        chatId: turn.chatId,
        rootId: turn.rootId,
        text,
        final: isFinalReply(text),
        clientId: this.clientId(lane, turn),
      })
    }
    this.afterTurn(lane)
  }

  private failTurn(lane: Lane, turn: ThreadTurnInput, sentence: string): void {
    if (lane.current !== turn) return
    lane.current = null
    this.running.delete(lane.state.rootId)
    this.postFailure(lane, turn, sentence)
    this.afterTurn(lane)
  }

  private postFailure(lane: Lane, turn: ThreadTurnInput, sentence: string): void {
    this.post(lane, 'integrations/threads/state', { chatId: turn.chatId, rootId: turn.rootId, state: 'open' })
    this.post(lane, 'integrations/threads/reply', {
      chatId: turn.chatId,
      rootId: turn.rootId,
      text: sentence,
      final: false,
      clientId: this.clientId(lane, turn),
    })
  }

  private clientId(lane: Lane, turn: ThreadTurnInput): string {
    return `thread-${turn.rootId}-${turn.replyId || `turn${lane.turnCount}`}`
  }

  private async ensureChild(lane: Lane): Promise<void> {
    const before = this.exiting.get(lane.state.rootId)
    if (before) await before
    if (lane.child && lane.stopping) await lane.exited
    if (lane.child) return
    const claude = this.deps.claudeBin()
    if (!claude) throw new ThreadLaneError('unavailable', NO_CLAUDE)
    await this.prepareFolder(lane)
    const mcp = this.deps.emptyMcpConfigPath()
    let args: string[]
    if (lane.state.forkSessionId) {
      args = threadLaneArgs({
        mainSessionId: this.deps.mainSessionId(),
        forkSessionId: lane.state.forkSessionId,
        emptyMcpConfigPath: mcp,
        readOnly: lane.state.readOnly,
      })
    } else {
      const mainId = this.deps.mainSessionId()
      if (!isSessionId(mainId)) throw new ThreadLaneError('no_session', NO_SESSION)
      this.copyMainTranscript(lane, mainId)
      args = threadLaneArgs({ mainSessionId: mainId, forkSessionId: null, emptyMcpConfigPath: mcp, readOnly: lane.state.readOnly })
    }
    if (lane.closed) return
    const child = this.deps.spawn(claude, args, { cwd: lane.state.cwd })
    lane.child = child
    lane.stopping = false
    lane.exited = new Promise<void>((done) => {
      child.onExit(() => {
        this.onExit(lane, child)
        done()
      })
    })
    child.onStdout(lineSplitter((frame) => this.onFrame(lane, child, frame)))
  }

  private copyMainTranscript(lane: Lane, mainId: string): void {
    const { fs, home, configDir, agentFolder } = this.deps
    const from = sessionTranscriptPath(home, agentFolder, mainId, configDir)
    const to = sessionTranscriptPath(home, lane.state.cwd, mainId, configDir)
    if (from === to) return
    try {
      fs.mkdir(dirname(to))
      fs.copyFile(from, to)
    } catch {
      throw new ThreadLaneError('no_session', NO_SESSION)
    }
    lane.copiedMainPath = to
  }

  private onFrame(lane: Lane, child: StreamJsonChild, frame: Record<string, unknown>): void {
    if (lane.child !== child) return
    if (frame.type === 'system' && frame.subtype === 'init') {
      const id = frame.session_id
      // Stream json input repeats init at every turn: the first one counts.
      if (!lane.state.forkSessionId && isSessionId(id) && id !== this.deps.mainSessionId()) {
        lane.state.forkSessionId = id
        this.persist(lane)
      }
      this.dropCopiedMain(lane)
      return
    }
    if (frame.type === 'result') this.onResult(lane, frame)
  }

  private onExit(lane: Lane, child: StreamJsonChild): void {
    if (lane.child !== child) return
    lane.child = null
    lane.stopping = false
    if (lane.graceTimer !== null) {
      this.deps.clearTimer(lane.graceTimer)
      lane.graceTimer = null
    }
    this.clearIdle(lane)
    this.dropCopiedMain(lane)
    if (lane.current) this.failTurn(lane, lane.current, FAILED_TURN)
  }

  private dropCopiedMain(lane: Lane): void {
    if (!lane.copiedMainPath) return
    try {
      this.deps.fs.unlink(lane.copiedMainPath)
    } catch {}
    lane.copiedMainPath = null
  }

  private stopChild(lane: Lane): void {
    const child = lane.child
    if (!child || lane.stopping) return
    lane.stopping = true
    child.kill('SIGTERM')
    lane.graceTimer = this.deps.setTimer(() => {
      lane.graceTimer = null
      if (lane.child === child) child.kill('SIGKILL')
    }, this.deps.killGraceMs ?? THREAD_LANE_KILL_GRACE_MS)
  }

  private armIdle(lane: Lane): void {
    this.clearIdle(lane)
    if (!lane.child) return
    lane.idleTimer = this.deps.setTimer(() => {
      lane.idleTimer = null
      if (!lane.current && lane.queue.length === 0) this.stopChild(lane)
    }, this.deps.idleMs ?? THREAD_LANE_IDLE_MS)
  }

  private clearIdle(lane: Lane): void {
    if (lane.idleTimer === null) return
    this.deps.clearTimer(lane.idleTimer)
    lane.idleTimer = null
  }

  private async prepareFolder(lane: Lane): Promise<void> {
    const { fs, git, agentFolder } = this.deps
    if (lane.state.folder && fs.exists(lane.state.folder)) return
    const rootId = lane.state.rootId
    const rel = join('.hoai', 'threads', rootId)
    const folder = join(agentFolder, rel)
    const prefix = await git(['-C', agentFolder, 'rev-parse', '--show-prefix'], agentFolder)
    if (prefix.ok) {
      await this.ensureExcluded()
      if (!fs.exists(folder)) {
        const branch = `hoai/thread-${rootId}`
        let added = await git(['-C', agentFolder, 'worktree', 'add', rel, '-b', branch], agentFolder)
        // The branch is left from an earlier worktree of this thread.
        if (!added.ok) added = await git(['-C', agentFolder, 'worktree', 'add', rel, branch], agentFolder)
        if (!added.ok) throw new ThreadLaneError('worktree_failed', NO_WORKTREE)
      }
      const inside = prefix.stdout.trim()
      lane.state.folder = folder
      lane.state.cwd = inside ? join(folder, inside) : folder
      lane.state.worktree = true
      lane.state.readOnly = false
    } else {
      fs.mkdir(folder)
      lane.state.folder = folder
      lane.state.cwd = folder
      lane.state.worktree = false
      lane.state.readOnly = true
    }
    this.persist(lane)
  }

  /** `.hoai/` in .git/info/exclude (local, untracked), added once. */
  private async ensureExcluded(): Promise<void> {
    const { fs, git, agentFolder } = this.deps
    const found = await git(['-C', agentFolder, 'rev-parse', '--git-path', 'info/exclude'], agentFolder)
    if (!found.ok || found.stdout.trim() === '') return
    const path = resolve(agentFolder, found.stdout.trim())
    let current = ''
    try {
      current = fs.readFile(path)
    } catch {}
    if (current.split(/\r?\n/).some((line) => ['.hoai/', '/.hoai/', '.hoai'].includes(line.trim()))) return
    try {
      fs.mkdir(dirname(path))
      fs.appendFile(path, `${current !== '' && !current.endsWith('\n') ? '\n' : ''}.hoai/\n`)
    } catch (err) {
      this.deps.log(`threads: could not exclude .hoai/ locally (${err instanceof Error ? err.name : 'error'})`)
    }
  }

  private async removeLane(state: ThreadLaneState): Promise<void> {
    const { fs, git, agentFolder, home, configDir } = this.deps
    if (state.worktree && state.folder) {
      const removed = await git(['-C', agentFolder, 'worktree', 'remove', '--force', state.folder], agentFolder)
      if (!removed.ok) {
        try {
          fs.rmrf(state.folder)
        } catch {}
        await git(['-C', agentFolder, 'worktree', 'prune'], agentFolder)
      }
    } else if (state.folder) {
      try {
        fs.rmrf(state.folder)
      } catch {}
    }
    if (state.forkSessionId && state.cwd) {
      try {
        fs.unlink(sessionTranscriptPath(home, state.cwd, state.forkSessionId, configDir))
      } catch {}
    }
    try {
      fs.unlink(this.statePath(state.rootId))
    } catch {}
  }

  private statePath(rootId: string): string {
    return join(this.deps.stateDir, `${rootId}.json`)
  }

  private persist(lane: Lane): void {
    try {
      this.deps.fs.mkdir(this.deps.stateDir)
      this.deps.fs.writeFile(this.statePath(lane.state.rootId), `${JSON.stringify(lane.state)}\n`)
    } catch (err) {
      this.deps.log(`threads: could not save lane state (${err instanceof Error ? err.name : 'error'})`)
    }
  }

  private load(rootId: string): ThreadLaneState | null {
    let raw: unknown
    try {
      raw = JSON.parse(this.deps.fs.readFile(this.statePath(rootId)))
    } catch {
      return null
    }
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    return {
      rootId,
      chatId: str(r.chatId),
      title: str(r.title),
      forkSessionId: isSessionId(r.forkSessionId) ? r.forkSessionId : null,
      folder: str(r.folder),
      cwd: str(r.cwd) || str(r.folder),
      worktree: r.worktree === true,
      readOnly: r.readOnly === true,
      closedAt: typeof r.closedAt === 'number' && Number.isFinite(r.closedAt) ? r.closedAt : null,
    }
  }

  /** Posts for one lane go out in order. */
  private post(lane: Lane, path: string, body: Record<string, unknown>): void {
    lane.posts = lane.posts.then(
      () => this.deps.post(path, body).then(
        () => undefined,
        (err: unknown) => this.deps.log(`threads: ${path} failed (${err instanceof Error ? err.name : 'error'})`),
      ),
    )
    this.track(lane.posts)
  }

  private track(p: Promise<unknown>): void {
    this.work.add(p)
    void p.finally(() => this.work.delete(p)).catch(() => {})
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
}

function validateTurn(input: ThreadTurnInput): void {
  if (!input || typeof input !== 'object') throw new ThreadLaneError('bad_request', 'The thread turn is missing.')
  if (typeof input.rootId !== 'string' || !ROOT_ID_RE.test(input.rootId)) {
    throw new ThreadLaneError('bad_request', 'The thread id is not valid.')
  }
  if (typeof input.chatId !== 'string' || input.chatId === '') throw new ThreadLaneError('bad_request', 'The chat id is missing.')
  if (!MODES.includes(input.mode)) throw new ThreadLaneError('bad_request', 'The thread turn mode is not valid.')
}
