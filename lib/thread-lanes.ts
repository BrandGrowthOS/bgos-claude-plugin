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
 *  - Slots: at most 2 lane processes per agent. A slot is held by a lane
 *    running a turn or by a lane whose process is alive (idle or still
 *    exiting), so a closed or stopped lane frees its slot only once its
 *    process has exited. A third thread waits FIFO (state "waiting" posted);
 *    an idle lane gives its slot to it (stopped, resumed by id later). Turns
 *    for one thread are serialized.
 *  - Idle stop: a lane with no turn for 20 minutes is stopped (SIGTERM to its
 *    process group, then SIGKILL after 10 s); its next turn resumes it by its
 *    own id. A turn that has neither answered nor ended after 30 minutes is
 *    failed and its lane stopped the same way.
 *  - Confinement: every lane runs `--restricted` with its own tools,
 *    permission mode and settings (lib/thread-lane-args.ts threadLaneArgs):
 *    edits only in its worktree, Bash only in the CLI's sandbox.
 *  - Working tree: the daemon (never the lane) runs `git worktree add
 *    .hoai/threads/<root> -b hoai/thread-<root>` in the agent folder, and the
 *    lane works there; `.hoai/` is excluded through `.git/info/exclude`, never
 *    the tracked .gitignore. A folder that is no repository gets a plain
 *    folder and a read only lane (the editing tools refused).
 *  - Transcript: the CLI looks a `--resume` id up in the project dir of its
 *    cwd, so before the first start the main transcript is copied into the
 *    worktree's project dir; the copy goes once the fork's init frame shows it
 *    was read. The fork's own file stays: it is the thread's memory.
 *  - A summary turn posts the draft to the summary route instead of a reply.
 *  - Each result is ONE thread reply (`final` unless it ends asking a
 *    question), clipped to the server's 20,000 characters; a post that fails
 *    is retried with backoff, and one that still fails puts the thread back
 *    to Open with a short plain reply, never a thread stuck at Working.
 *  - A daemon crash leaves a lane finishing its turn (its stdin closed): its
 *    pid and start stamp are in the lane state, so the next start, a close or
 *    a delete stops it first (lib/lane-process.ts), never two lanes on one
 *    thread.
 *  - Close stops the lane and keeps the worktree for 7 days (sweepClosed);
 *    delete also removes the worktree, its hoai/thread-<root> branch, the
 *    fork's session file and the state. Either waits for a start in flight,
 *    so a worktree being made while the person deletes is removed too.
 *
 * Every effect is an injected dependency, so the whole manager is unit tested
 * with fakes (test/thread-lanes.test.ts). Erasable TypeScript only.
 */

import { dirname, join, resolve } from 'node:path'

import {
  clipThreadText,
  isFinalReply,
  isSessionId,
  laneSecretPaths,
  protectedGitPaths,
  THREAD_LANE_REF_DIRS,
  threadLaneArgs,
  threadTurnPrompt,
  type ThreadLaneConfinement,
  type ThreadTurnMode,
} from './thread-lane-args.ts'
import { lineSplitter, userMessageLine, type SpawnStreamJson, type StreamJsonChild } from './stream-json-child.ts'
import { sessionTranscriptPath } from '../bin/hoai-core.mjs'

export const THREAD_LANE_MAX_RUNNING = 2
export const THREAD_LANE_IDLE_MS = 20 * 60_000
export const THREAD_LANE_KILL_GRACE_MS = 10_000
export const THREAD_LANE_KEEP_CLOSED_MS = 7 * 24 * 60 * 60_000
/** A turn with no result and no exit after this long is failed and its lane stopped. */
export const THREAD_TURN_TIMEOUT_MS = 30 * 60_000
/** How often a stop of a lane process left from before a daemon crash checks whether it is gone. */
export const THREAD_ORPHAN_POLL_MS = 250
/** The waits between attempts of a post to BGOS (so 4 attempts in all). */
export const THREAD_POST_RETRY_MS: readonly number[] = Object.freeze([2_000, 10_000, 30_000])

const ROOT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MODES: readonly string[] = ['start', 'reply', 'summary']

const FAILED_TURN = 'This turn failed before the agent could answer, so send your reply again to retry.'
const NO_SESSION = 'This thread could not start because the agent has no running session to fork yet.'
const NO_CLAUDE = 'This turn failed because this computer cannot run Claude Code right now.'
const NO_WORKTREE = 'This thread could not start because its working copy could not be made.'
const TIMED_OUT = 'This turn took longer than 30 minutes, so it was stopped. Send your reply again to retry.'
const POST_FAILED = 'The answer to this turn could not be delivered, so send your reply again to retry.'
const ORPHAN_ALIVE = 'This turn could not start because an earlier run of this thread is still stopping. Send your reply again in a minute.'

/** The pending route, scoped to the agents this daemon serves (the server answers nothing without them). */
export function threadsPendingPath(assistantIds: readonly string[]): string {
  return `integrations/threads/pending?assistantIds=${assistantIds.map((id) => encodeURIComponent(id)).join(',')}`
}

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
  /** Create a file that must not exist yet (git's own lock convention); throws when it does. */
  createExclusive(path: string, data: string): void
  rename(from: string, to: string): void
}

export interface ThreadLaneDeps {
  spawn: SpawnStreamJson
  claudeBin(): string | null
  /**
   * Why this claude cannot run a confined lane (lib/threads-cli.ts
   * threadsCliProblem), as the plain sentence the person reads, or null.
   */
  cliProblem(): string | null | Promise<string | null>
  mainSessionId(): string | null
  /** The folder the main session runs in. */
  agentFolder: string
  /** Where lane state files live, ~/.bgos-agent/<assistantId>/threads. */
  stateDir: string
  home: string
  /** CLAUDE_CONFIG_DIR, '' for ~/.claude. */
  configDir: string
  emptyMcpConfigPath(): string
  /** This agent's email files (~/.bgos-agent/email-files/<id>): a lane's Bash may read them. */
  emailFilesDir?: string | null
  /** BGOS_PLUGIN_STATE_DIR when set: refused to a lane's Bash like ~/.bgos-plugin-state. */
  pluginStateDir?: string
  /**
   * The machine's processes (lib/lane-process.ts): a process's start stamp
   * while it is alive, and a signal to the process group it leads.
   */
  processes: {
    /** Start stamp while alive, null if gone, undefined if inspection failed. Asynchronous. */
    stamp(pid: number): Promise<string | null | undefined>
    /** True if in this folder, false if absent/elsewhere, null if inspection failed. */
    runsIn(pid: number, dir: string): Promise<boolean | null>
    kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void
  }
  /** This host can run the CLI's Bash sandbox (lib/lane-policy.mjs laneShellSandboxAvailable). */
  shellSandbox(): boolean
  /** process.platform: on Linux the sandbox protects only paths that exist (protectedPaths). */
  platform?: NodeJS.Platform
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
  turnTimeoutMs?: number
  postRetryMs?: readonly number[]
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
  /**
   * The reply id of the last turn this lane finished (answered or failed), ''
   * before any. A reconnect's pending list can still name it while its answer
   * is being posted, or when that post never landed: it never runs again.
   */
  lastReplyId: string
  /** That turn's answer, summary or failure reply landed. False until it does (and in a state saved before this field). */
  lastDelivered: boolean
  /**
   * The lane's process while it runs, and its start stamp (finding 3): a
   * daemon that crashed leaves it finishing its turn, and the next start stops
   * it first. Null when none runs (or its stamp could not be read).
   */
  pid: number | null
  pidStamp: string | null
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
  /** The turn written to the CURRENT child: only its exit or its result may end that turn. */
  childTurn: ThreadTurnInput | null
  turnTimer: unknown
  /** A start in flight (worktree, confinement, spawn): close and delete wait for it. */
  starting: Promise<void> | null
  /** When the lane last finished a turn: the oldest idle lane gives its slot first. */
  idleSince: number
  copiedMainPath: string | null
  posts: Promise<void>
  /** Posts queued or being tried for this lane (a reply retried with backoff counts until it settles). */
  postsInFlight: number
  closed: boolean
  turnCount: number
}

export class ThreadLaneManager {
  private readonly deps: ThreadLaneDeps
  private readonly lanes = new Map<string, Lane>()
  private readonly running = new Set<string>()
  private waiting: string[] = []
  /** A closed lane still settling (its start, its exit, its removal): a reopen waits for it. */
  private readonly exiting = new Map<string, Promise<void>>()
  /** Closed lanes whose process has not exited yet: they still hold a slot. */
  private readonly closing = new Set<Lane>()
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

  /** Lane processes alive right now (running, idle or exiting). */
  liveChildren(): number {
    let n = 0
    for (const lane of [...this.lanes.values(), ...this.closing]) if (lane.child) n++
    return n
  }

  /**
   * Work a restart would cut off: a turn running or waiting for a slot, a lane whose next turn is queued, and any
   * background step still going (a start, an answer being posted, a read of pending turns, a removal). A lane that only
   * sits idle is not work: liveChildren() counts it for 20 minutes after its turn, and its next turn resumes by its id.
   */
  activeWork(): number {
    let n = this.work.size
    for (const lane of this.lanes.values()) if (lane.current || lane.queue.length > 0) n++
    return n
  }

  /** Slots in use: lanes running a turn or holding a live process, and closed lanes still exiting. */
  private slotsUsed(): number {
    let n = this.closing.size
    for (const lane of this.lanes.values()) if (lane.current || lane.child) n++
    return n
  }

  /** A lane can start a turn now: it already holds a slot, or one is free. */
  private canStart(lane: Lane): boolean {
    return lane.child !== null || this.slotsUsed() < this.maxRunning
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
    if (this.waiting.length === 0 && this.canStart(lane)) {
      this.start(lane)
      return { accepted: true, state: 'working' }
    }
    this.waiting.push(input.rootId)
    this.post(lane, 'integrations/threads/state', { chatId: lane.state.chatId, rootId: input.rootId, state: 'waiting' })
    this.pump()
    return { accepted: true, state: this.waiting.includes(input.rootId) ? 'waiting' : 'working' }
  }

  /** Stop a thread's lane. removeWorktree (delete) also removes its worktree, session file and state. */
  async close(input: { rootId: string; removeWorktree: boolean }): Promise<{ stopped: true }> {
    if (typeof input.rootId !== 'string' || !ROOT_ID_RE.test(input.rootId)) {
      throw new ThreadLaneError('bad_request', 'The thread id is not valid.')
    }
    const rootId = input.rootId
    // A sweep or an earlier close owns this root until its removal settles.
    while (this.exiting.has(rootId)) await this.exiting.get(rootId)
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
      this.endTurn(lane)
    }
    this.clearIdle(lane)
    this.lanes.delete(rootId)
    // A start in flight (the worktree being made) settles first: it sees
    // lane.closed and spawns nothing, and its folder is then known here.
    const starting = (lane.starting ?? Promise.resolve()).catch(() => {})
    let exited: Promise<void> = Promise.resolve()
    if (lane.child) {
      this.closing.add(lane)
      this.stopChild(lane)
      exited = lane.exited
    } else if (lane.state.pid !== null) {
      // Its process from before a daemon crash stops too.
      exited = this.stopOrphan(lane.state).then(() => undefined)
    }
    const state = lane.state
    const settled: Promise<void> = input.removeWorktree
      ? Promise.all([starting, exited]).then(async () => { await this.removeLane(state, { deleteBranch: true }) })
      : starting.then(() => {
          // Not when the thread was reopened meanwhile: that lane owns the file now.
          if (!state.folder || this.lanes.has(rootId)) return
          state.closedAt = this.deps.now()
          this.persistState(state)
        })
    const done = Promise.all([settled, exited]).then(() => undefined)
    this.exiting.set(rootId, done)
    void done.then(() => {
      if (this.exiting.get(rootId) === done) this.exiting.delete(rootId)
    })
    this.track(done)
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
      if (this.lanes.has(rootId) || this.exiting.has(rootId)) continue
      const state = this.load(rootId)
      if (!state || state.closedAt === null) continue
      if (now - state.closedAt <= keep) continue
      // Reserve the root before removal yields, just like explicit deletion.
      // A reopening turn may queue, but ensureChild waits for this owner.
      const removal = this.removeLane(state, { deleteBranch: false })
      const done = removal.then(() => undefined)
      this.exiting.set(rootId, done)
      try {
        if (await removal) removed.push(rootId)
      } finally {
        if (this.exiting.get(rootId) === done) this.exiting.delete(rootId)
      }
    }
    return removed
  }

  /**
   * After a reconnect, and when the channel arms: ask the server which
   * threads wait on this agent (GET integrations/threads/pending, answered
   * `{ turns: [{ chatId, rootId, replyId, mode, text, title, assistantId }] }`)
   * and run a reply turn for each that is not already running here. A row for
   * an agent this daemon does not serve is skipped. Answers how many started.
   *
   * The server lists every open thread whose newest row is the person's, so a
   * turn this lane already finished is listed while its answer is still being
   * posted (a retry with backoff), and after that post never landed. Neither
   * runs again (its edits would be redone, a second answer posted): a row for
   * a lane with a post in flight waits for those posts to settle, and a row
   * naming the lane's last finished reply only puts the thread back to Open
   * with a short plain reply when nothing is left to land.
   */
  reconcile(fetchPending: () => Promise<unknown>, opts: { assistantIds?: readonly string[] } = {}): Promise<number> {
    // Tracked from its first step: a read still out may start a turn, so a restart waits for it (activeWork).
    const run = this.reconcileNow(fetchPending, opts)
    this.track(run)
    return run
  }

  private async reconcileNow(fetchPending: () => Promise<unknown>, opts: { assistantIds?: readonly string[] }): Promise<number> {
    const raw = await fetchPending()
    const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
    const rows: unknown[] = Array.isArray(body?.turns) ? (body!.turns as unknown[]) : []
    const served = opts.assistantIds ? new Set(opts.assistantIds.map(String)) : null
    let started = 0
    const later: Array<Promise<number>> = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      if (served && str(r.assistantId) !== '' && !served.has(str(r.assistantId))) continue
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
      if (lane && lane.postsInFlight > 0) {
        later.push(this.postsSettled(lane).then(() => this.reconcileTurn(input)))
        continue
      }
      started += this.reconcileTurn(input)
    }
    for (const n of await Promise.all(later)) started += n
    return started
  }

  /** One pending row, once no post for its lane is in flight: 1 when a turn started. */
  private reconcileTurn(input: ThreadTurnInput): number {
    try {
      validateTurn(input)
    } catch (err) {
      this.deps.log(`threads: a pending thread was skipped (${err instanceof Error ? err.message : 'error'})`)
      return 0
    }
    const lane = this.lanes.get(input.rootId)
    if (lane && (lane.current || lane.queue.length > 0)) return 0
    const saved = lane ? null : this.load(input.rootId)
    const state = lane ? lane.state : saved
    if (input.replyId !== '' && state !== null && input.replyId === state.lastReplyId) {
      // Its answer (a reply or a summary) is still on its way, or landed: also
      // before a restart, and a summary leaves the row listed (it is no
      // thread reply), so a landed one never reopens the thread.
      if ((lane && lane.postsInFlight > 0) || state.lastDelivered) return 0
      // Finished here, and its answer never landed: back to Open, never run again.
      this.deps.log(`threads: thread ${input.rootId} turn ${input.replyId} already finished, its answer is marked undelivered`)
      this.postFailure(lane ?? this.newLane(saved!), input, POST_FAILED)
      return 0
    }
    try {
      this.turn(input)
      return 1
    } catch (err) {
      this.deps.log(`threads: a pending thread was skipped (${err instanceof Error ? err.message : 'error'})`)
      return 0
    }
  }

  /** Resolves once no post for this lane is queued or being tried. */
  private async postsSettled(lane: Lane): Promise<void> {
    while (lane.postsInFlight > 0) await lane.posts.catch(() => {})
  }

  /**
   * Daemon shutdown: SIGTERM to every lane's process group now, and resolve
   * once they have all exited. The caller bounds the wait and then calls
   * killAll for whatever is left.
   */
  stopAll(): Promise<void> {
    this.waiting = []
    const exits: Array<Promise<void>> = []
    for (const lane of [...this.lanes.values(), ...this.closing]) {
      this.clearIdle(lane)
      this.clearTurnTimer(lane)
      lane.queue = []
      if (lane.child) {
        lane.stopping = true
        lane.child.kill('SIGTERM')
        exits.push(lane.exited)
      }
    }
    return Promise.all(exits).then(() => undefined)
  }

  /** The end of the shutdown wait: SIGKILL to every lane process group still alive. */
  killAll(): void {
    for (const lane of [...this.lanes.values(), ...this.closing]) lane.child?.kill('SIGKILL')
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
        lastReplyId: '',
        lastDelivered: false,
        pid: null,
        pidStamp: null,
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
      childTurn: null,
      turnTimer: null,
      starting: null,
      idleSince: 0,
      copiedMainPath: null,
      posts: Promise.resolve(),
      postsInFlight: 0,
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
      const starting = this.ensureChild(lane)
      lane.starting = starting
      try {
        await starting
      } finally {
        if (lane.starting === starting) lane.starting = null
      }
      if (lane.current !== turn || !lane.child || lane.closed) return
      lane.childTurn = turn
      this.armTurnTimer(lane, turn)
      lane.child.write(userMessageLine(threadTurnPrompt({ ...turn, readOnly: lane.state.readOnly })))
    } catch (err) {
      this.deps.log(`threads: turn ${turn.rootId} could not start (${err instanceof ThreadLaneError ? err.code : 'error'})`)
      this.failTurn(lane, turn, err instanceof ThreadLaneError ? err.message : FAILED_TURN)
    }
  }

  /**
   * Give the free slots to the threads that waited longest. When none is free
   * and a lane only sits idle on one, that lane is stopped (oldest idle
   * first) and its exit frees the slot.
   */
  private pump(): void {
    while (this.waiting.length > 0) {
      const rootId = this.waiting[0]!
      const lane = this.lanes.get(rootId)
      if (!lane || lane.closed || lane.current || lane.queue.length === 0) {
        this.waiting.shift()
        continue
      }
      if (!this.canStart(lane)) {
        this.stopOldestIdle()
        return
      }
      this.waiting.shift()
      this.start(lane)
    }
  }

  private stopOldestIdle(): void {
    let oldest: Lane | null = null
    for (const lane of this.lanes.values()) {
      if (!lane.child || lane.stopping || lane.current || lane.queue.length > 0) continue
      if (!oldest || lane.idleSince < oldest.idleSince) oldest = lane
    }
    if (oldest) {
      this.clearIdle(oldest)
      this.stopChild(oldest)
    }
  }

  private afterTurn(lane: Lane): void {
    lane.idleSince = this.deps.now()
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

  /** The current turn is over: its slot, its timer and its child's claim on it go. */
  private endTurn(lane: Lane): void {
    lane.current = null
    lane.childTurn = null
    this.clearTurnTimer(lane)
    this.running.delete(lane.state.rootId)
  }

  private onResult(lane: Lane, frame: Record<string, unknown>): void {
    const turn = lane.childTurn
    if (!turn || lane.current !== turn) return
    this.endTurn(lane)
    this.finished(lane, turn)
    const raw = typeof frame.result === 'string' ? frame.result : ''
    const failed = frame.is_error === true || (frame.subtype !== undefined && frame.subtype !== 'success') || raw.trim() === ''
    const text = clipThreadText(raw)
    if (failed) {
      this.postFailure(lane, turn, FAILED_TURN)
    } else if (turn.mode === 'summary') {
      this.post(
        lane,
        'integrations/threads/summary',
        { chatId: turn.chatId, rootId: turn.rootId, summary: text },
        () => this.postFailure(lane, turn, POST_FAILED),
        () => this.landed(lane, turn),
      )
    } else {
      this.post(
        lane,
        'integrations/threads/reply',
        { chatId: turn.chatId, rootId: turn.rootId, text, final: isFinalReply(raw), clientId: this.clientId(lane, turn) },
        () => this.postFailure(lane, turn, POST_FAILED),
        () => this.landed(lane, turn),
      )
    }
    this.afterTurn(lane)
  }

  private failTurn(lane: Lane, turn: ThreadTurnInput, sentence: string): void {
    if (lane.current !== turn) return
    this.endTurn(lane)
    this.finished(lane, turn)
    this.postFailure(lane, turn, sentence)
    this.afterTurn(lane)
  }

  /** Remember the turn as finished (finding 1): a pending list naming it never runs it again. */
  private finished(lane: Lane, turn: ThreadTurnInput): void {
    if (turn.replyId === '') return
    lane.state.lastReplyId = turn.replyId
    lane.state.lastDelivered = false
    if (lane.state.folder) this.persist(lane)
  }

  private postFailure(lane: Lane, turn: ThreadTurnInput, sentence: string): void {
    this.post(lane, 'integrations/threads/state', { chatId: turn.chatId, rootId: turn.rootId, state: 'open' })
    this.post(
      lane,
      'integrations/threads/reply',
      { chatId: turn.chatId, rootId: turn.rootId, text: sentence, final: false, clientId: this.clientId(lane, turn) },
      undefined,
      () => this.landed(lane, turn),
    )
  }

  /** The finished turn's answer (or its failure reply) landed: saved, so a restart knows. */
  private landed(lane: Lane, turn: ThreadTurnInput): void {
    if (turn.replyId === '' || lane.state.lastReplyId !== turn.replyId || lane.state.lastDelivered) return
    lane.state.lastDelivered = true
    // A close and reopen may have replaced this lane while its post was in
    // flight. Update only the matching reply on the current owner's state.
    const current = this.lanes.get(lane.state.rootId)?.state ?? this.load(lane.state.rootId)
    if (!current || current.lastReplyId !== turn.replyId) return
    current.lastDelivered = true
    // Never recreate a state file a delete removed meanwhile.
    if (current.folder) this.persistState(current)
  }

  private clientId(lane: Lane, turn: ThreadTurnInput): string {
    return `thread-${turn.rootId}-${turn.replyId || `turn${lane.turnCount}`}`
  }

  private async ensureChild(lane: Lane): Promise<void> {
    const before = this.exiting.get(lane.state.rootId)
    if (before) await before
    // Cleanup can finish while this turn waits for a slot, leaving no
    // exiting entry. Check at startup before recreating the saved state.
    if (!this.deps.fs.exists(this.statePath(lane.state.rootId))) {
      lane.state.forkSessionId = null
      lane.state.pid = null
      lane.state.pidStamp = null
    }
    if (lane.child && lane.stopping) await lane.exited
    if (lane.closed || lane.child) return
    // A process left from before a daemon crash still runs this thread: never a second one.
    if (!(await this.stopOrphan(lane.state))) throw new ThreadLaneError('busy', ORPHAN_ALIVE)
    if (lane.closed || lane.child) return
    const claude = this.deps.claudeBin()
    if (!claude) throw new ThreadLaneError('unavailable', NO_CLAUDE)
    // An older CLI refuses --restricted: say so, never the generic "turn failed".
    // Asynchronous: a probe still running is waited for off the event loop.
    const problem = await this.deps.cliProblem()
    if (problem) throw new ThreadLaneError('unsupported', problem)
    if (lane.closed || lane.child) return
    await this.prepareFolder(lane)
    if (lane.closed) return
    const confinement = await this.confinement(lane)
    // Closed while the worktree or its confinement was being made: no copy of
    // the main transcript, no process (close removes or keeps the folder).
    if (lane.closed) return
    const mcp = this.deps.emptyMcpConfigPath()
    let args: string[]
    if (lane.state.forkSessionId) {
      args = threadLaneArgs({
        mainSessionId: this.deps.mainSessionId(),
        forkSessionId: lane.state.forkSessionId,
        emptyMcpConfigPath: mcp,
        confinement,
      })
    } else {
      const mainId = this.deps.mainSessionId()
      if (!isSessionId(mainId)) throw new ThreadLaneError('no_session', NO_SESSION)
      args = threadLaneArgs({ mainSessionId: mainId, forkSessionId: null, emptyMcpConfigPath: mcp, confinement })
      this.copyMainTranscript(lane, mainId)
    }
    const child = this.deps.spawn(claude, args, { cwd: lane.state.cwd })
    lane.child = child
    lane.stopping = false
    this.recordPid(lane, child)
    lane.exited = new Promise<void>((done) => {
      child.onExit(() => {
        this.onExit(lane, child)
        done()
      })
    })
    child.onStdout(lineSplitter((frame) => this.onFrame(lane, child, frame)))
  }

  /** Where this lane may write and what it may run (lib/thread-lane-args.ts). */
  private async confinement(lane: Lane): Promise<ThreadLaneConfinement> {
    const { agentFolder } = this.deps
    const root = lane.state.folder
    if (lane.state.readOnly) {
      return { root, readOnly: true, shellSandbox: false, readDirs: [agentFolder] }
    }
    if (!this.deps.shellSandbox()) return { root, readOnly: false, shellSandbox: false }
    const protectedPaths = await this.protectedPaths(lane)
    // Without the source repository's git state to protect, no Bash at all.
    if (protectedPaths === null) {
      this.deps.log(`threads: lane ${lane.state.rootId} runs without Bash, its repository's git state could not be read`)
      return { root, readOnly: false, shellSandbox: false }
    }
    const { home, configDir, fs } = this.deps
    const secretPaths = laneSecretPaths({
      home,
      configDir,
      pluginStateDir: this.deps.pluginStateDir,
      exists: (p) => fs.exists(p),
    })
    const agents = resolve(home, '.bgos-agent')
    const readablePaths = [agentFolder, this.deps.emailFilesDir]
      .filter((p): p is string => !!p)
      .map((p) => resolve(p))
      .filter((p) => p.startsWith(`${agents}/`))
    return { root, readOnly: false, shellSandbox: true, protectedPaths, secretPaths, readablePaths }
  }

  private async protectedPaths(lane: Lane): Promise<string[] | null> {
    const { git, fs, agentFolder } = this.deps
    const folder = lane.state.folder
    const common = await git(['-C', agentFolder, 'rev-parse', '--path-format=absolute', '--git-common-dir'], agentFolder)
    const own = await git(['-C', folder, 'rev-parse', '--path-format=absolute', '--git-dir'], folder)
    const refs = await git(['-C', agentFolder, 'for-each-ref', '--format=%(refname)', 'refs/heads'], agentFolder)
    const commonDir = common.stdout.trim()
    const ownGitDir = own.stdout.trim()
    if (!common.ok || !own.ok || !refs.ok || !commonDir.startsWith('/') || !ownGitDir.startsWith('/')) return null
    // The reftable backend keeps every ref in reftable/: no path protects one
    // branch and leaves the lane its own. An older git, without the question,
    // has no reftable.
    const format = await git(['-C', agentFolder, 'rev-parse', '--show-ref-format'], agentFolder)
    if (format.ok && format.stdout.trim() !== '' && format.stdout.trim() !== 'files') {
      this.deps.log(`threads: lane ${lane.state.rootId} runs without Bash, its repository keeps refs as ${format.stdout.trim()}`)
      return null
    }
    let worktreeNames: string[] = []
    try {
      worktreeNames = fs.list(join(commonDir, 'worktrees'))
    } catch {}
    const branches = refs.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const paths = protectedGitPaths({
      commonDir,
      ownGitDir,
      ownBranch: `hoai/thread-${lane.state.rootId}`,
      branches,
      worktreeNames,
    })
    if ((this.deps.platform ?? process.platform) === 'linux' && !(await this.materializeRefs(commonDir, paths))) return null
    return paths
  }

  /**
   * Linux (gate review finding 4): the sandbox binds a denied path read only,
   * so a path that does not exist is not protected, and a branch kept only in
   * packed-refs could be shadowed by a loose ref the lane writes. Each such
   * branch is written out loose (same commit, through a `.lock` like git
   * itself), and the ref folders are made. False when a branch could not be:
   * then the lane gets no Bash.
   */
  private async materializeRefs(commonDir: string, paths: readonly string[]): Promise<boolean> {
    const { fs, git, agentFolder } = this.deps
    for (const dir of [...THREAD_LANE_REF_DIRS, 'hooks']) {
      try {
        fs.mkdir(join(commonDir, dir))
      } catch {}
    }
    if (!this.stashPlaceholders(commonDir)) return false
    const heads = `${commonDir}/refs/heads/`
    for (const path of paths) {
      if (!path.startsWith(heads) || fs.exists(path)) continue
      const ref = path.slice(commonDir.length + 1)
      const sha = await git(['-C', agentFolder, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], agentFolder)
      const id = sha.stdout.trim()
      if (!sha.ok || !/^[0-9a-f]{40,64}$/.test(id)) {
        this.deps.log(`threads: a packed branch could not be written out, the lane runs without Bash`)
        return false
      }
      const lock = `${path}.lock`
      try {
        fs.mkdir(dirname(path))
        fs.createExclusive(lock, `${id}\n`)
      } catch {
        // git holds the lock (or the folder cannot be made): not protectable now.
        this.deps.log(`threads: a packed branch is locked, the lane runs without Bash`)
        return false
      }
      try {
        fs.rename(lock, path)
      } catch {
        try {
          fs.unlink(lock)
        } catch {}
        return false
      }
    }
    return true
  }

  /**
   * Linux, no stash yet: refs/stash becomes an empty FOLDER (git ignores it,
   * and the owner's own `git stash` replaces it; an empty file would be a
   * broken ref) and logs/refs/stash an empty file, so the sandbox can bind
   * both read only. An existing stash is left as it is. False when either
   * could not be made: then the lane gets no Bash.
   */
  private stashPlaceholders(commonDir: string): boolean {
    const { fs } = this.deps
    const ref = join(commonDir, 'refs', 'stash')
    const log = join(commonDir, 'logs', 'refs', 'stash')
    try {
      if (!fs.exists(ref)) fs.mkdir(ref)
      if (!fs.exists(log)) {
        fs.mkdir(dirname(log))
        fs.createExclusive(log, '')
      }
      return true
    } catch {
      this.deps.log('threads: the stash could not be protected, the lane runs without Bash')
      return false
    }
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
    // A stopping child (closed, timed out, idle) speaks for no turn any more.
    if (lane.child !== child || lane.stopping) return
    if (frame.type === 'system' && frame.subtype === 'init') {
      const id = frame.session_id
      // Stream json input repeats init at every turn: the first one counts.
      if (!lane.state.forkSessionId && isSessionId(id) && id !== this.deps.mainSessionId()) {
        lane.state.forkSessionId = id
        this.persist(lane)
      }
      this.dropCopiedMain(lane)
      // A stamp that could not be read at spawn is asked for again.
      if (lane.state.pidStamp === null) this.readStamp(lane, child)
      return
    }
    if (frame.type === 'result') this.onResult(lane, frame)
  }

  private onExit(lane: Lane, child: StreamJsonChild): void {
    if (lane.child !== child) return
    lane.child = null
    lane.stopping = false
    if (lane.state.pid !== null && lane.state.pid === child.pid) {
      lane.state.pid = null
      lane.state.pidStamp = null
      // Not over a reopened lane's own state file.
      const current = this.lanes.get(lane.state.rootId)
      if (lane.state.folder && (current === lane || current === undefined)) this.persist(lane)
    }
    if (lane.graceTimer !== null) {
      this.deps.clearTimer(lane.graceTimer)
      lane.graceTimer = null
    }
    this.clearIdle(lane)
    this.dropCopiedMain(lane)
    this.closing.delete(lane)
    // Only the turn this child was running fails. A turn that arrived while
    // it was stopping waits in ensureChild and runs on the next child.
    const ran = lane.childTurn
    lane.childTurn = null
    if (ran && lane.current === ran) this.failTurn(lane, ran, FAILED_TURN)
    else this.pump()
  }

  /**
   * The pid from the child handle goes into the lane state at once (follow up
   * to finding 3: before, a ps that failed at spawn left none), and its start
   * stamp as soon as it can be read (readStamp, again on the next init frame).
   */
  private recordPid(lane: Lane, child: StreamJsonChild): void {
    const pid = child.pid
    if (typeof pid !== 'number') return
    lane.state.pid = pid
    lane.state.pidStamp = null
    if (lane.state.folder) this.persist(lane)
    this.readStamp(lane, child)
  }

  private readStamp(lane: Lane, child: StreamJsonChild): void {
    const pid = child.pid
    if (typeof pid !== 'number' || lane.state.pid !== pid || lane.state.pidStamp !== null) return
    this.track(
      this.deps.processes.stamp(pid).then((stamp) => {
        if (typeof stamp !== 'string' || lane.child !== child || lane.state.pid !== pid || lane.state.pidStamp !== null) return
        lane.state.pidStamp = stamp
        if (lane.state.folder) this.persist(lane)
      }),
    )
  }

  /**
   * Stop the process a lane state names if it still runs under the same start
   * stamp (a daemon crash left it finishing its turn): SIGTERM to its group,
   * SIGKILL after the grace, and true once it is gone. A pid now held by
   * another process is never signalled. False when it would not stop.
   */
  private async stopOrphan(state: ThreadLaneState): Promise<boolean> {
    const { pid, pidStamp, cwd } = state
    if (pid === null) return true
    const procs = this.deps.processes
    // A working directory is not process identity: a shell or test may reuse
    // this pid in the same worktree. Preserve the state and refuse a second
    // lane until it leaves, without signalling a process we cannot identify.
    if (pidStamp === null && (await procs.runsIn(pid, cwd)) !== false) {
      this.deps.log(`threads: lane ${state.rootId} has an unverified process that may still use its folder; waiting for it to exit`)
      return false
    }
    const alive = async (): Promise<boolean | null> => {
      if (pidStamp === null) return false
      const stamp = await procs.stamp(pid)
      return stamp === undefined ? null : stamp === pidStamp
    }
    const inspected = await alive()
    if (inspected === null) {
      this.deps.log(`threads: lane ${state.rootId} has an unreadable process stamp; waiting for verified identity or exit`)
      return false
    }
    if (inspected) {
      this.deps.log(`threads: lane ${state.rootId} still runs from before a restart, it is stopped first`)
      const grace = this.deps.killGraceMs ?? THREAD_LANE_KILL_GRACE_MS
      procs.kill(pid, 'SIGTERM')
      if (!(await this.gone(alive, grace))) {
        // A failed poll must not authorize signalling an unverified identity.
        const current = await alive()
        if (current === null) return false
        if (current) {
          procs.kill(pid, 'SIGKILL')
          if (!(await this.gone(alive, grace))) {
            this.deps.log(`threads: lane ${state.rootId} from before a restart would not stop`)
            return false
          }
        }
      }
    }
    if (state.pid === pid) {
      state.pid = null
      state.pidStamp = null
      if (state.folder) this.persistState(state)
    }
    return true
  }

  /** Only affirmative absence ends the wait; failed inspection keeps polling up to ms. */
  private async gone(alive: () => Promise<boolean | null>, ms: number): Promise<boolean> {
    for (let waited = 0; ; waited += THREAD_ORPHAN_POLL_MS) {
      if ((await alive()) === false) return true
      if (waited >= ms) return false
      await new Promise<void>((done) => this.deps.setTimer(done, THREAD_ORPHAN_POLL_MS))
    }
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

  private armTurnTimer(lane: Lane, turn: ThreadTurnInput): void {
    this.clearTurnTimer(lane)
    lane.turnTimer = this.deps.setTimer(() => {
      lane.turnTimer = null
      if (lane.current !== turn) return
      this.deps.log(`threads: turn ${turn.rootId} timed out, its lane is stopped`)
      this.stopChild(lane)
      this.failTurn(lane, turn, TIMED_OUT)
    }, this.deps.turnTimeoutMs ?? THREAD_TURN_TIMEOUT_MS)
  }

  private clearTurnTimer(lane: Lane): void {
    if (lane.turnTimer === null) return
    this.deps.clearTimer(lane.turnTimer)
    lane.turnTimer = null
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
    // A delete that came meanwhile removes the folder and this file next.
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

  /**
   * The lane's folder as the daemon made it, <agentFolder>/.hoai/threads/<root>,
   * or null for anything else a state file names: removeLane never removes a
   * folder (nor asks git to) that is not the thread's own.
   */
  private ownFolder(state: ThreadLaneState): string | null {
    if (!state.folder) return null
    const expected = resolve(this.deps.agentFolder, '.hoai', 'threads', state.rootId)
    return ROOT_ID_RE.test(state.rootId) && resolve(state.folder) === expected ? expected : null
  }

  private async removeLane(state: ThreadLaneState, opts: { deleteBranch: boolean }): Promise<boolean> {
    const { fs, git, agentFolder, home, configDir } = this.deps
    if (!(await this.stopOrphan(state))) return false
    const folder = this.ownFolder(state)
    if (state.folder && folder === null) {
      this.deps.log(`threads: lane ${state.rootId} names a folder outside the threads folder, it is not removed`)
    }
    if (folder === null) {
      // Nothing of the folder's: only the session files and the state below.
    } else if (state.worktree) {
      const removed = await git(['-C', agentFolder, 'worktree', 'remove', '--force', folder], agentFolder)
      if (!removed.ok) {
        try {
          fs.rmrf(folder)
        } catch {}
        await git(['-C', agentFolder, 'worktree', 'prune'], agentFolder)
      }
      // Delete takes the thread's branch too, only that one and only once its
      // worktree is gone (git refuses a branch a worktree still has out).
      if (opts.deleteBranch && !fs.exists(folder)) {
        await git(['-C', agentFolder, 'branch', '-D', `hoai/thread-${state.rootId}`], agentFolder)
      }
    } else {
      try {
        fs.rmrf(folder)
      } catch {}
    }
    if (state.forkSessionId && state.cwd && isSessionId(state.forkSessionId)) {
      const transcript = sessionTranscriptPath(home, state.cwd, state.forkSessionId, configDir)
      try {
        fs.unlink(transcript)
      } catch {}
      // The session's own folder beside it (<id>/tool-results/, where the CLI
      // keeps large tool outputs): named by the UUID, under the project dir.
      if (transcript.endsWith(`${state.forkSessionId}.jsonl`)) {
        try {
          fs.rmrf(transcript.slice(0, -'.jsonl'.length))
        } catch {}
      }
    }
    try {
      fs.unlink(this.statePath(state.rootId))
    } catch {}
    // A queued reopen may have loaded this fork before cleanup. Invalidate
    // that copy too, so a close or late delivery cannot save it again.
    const reopened = this.lanes.get(state.rootId)
    if (reopened) {
      reopened.state.forkSessionId = null
      reopened.state.pid = null
      reopened.state.pidStamp = null
    }
    return true
  }

  private statePath(rootId: string): string {
    return join(this.deps.stateDir, `${rootId}.json`)
  }

  private persist(lane: Lane): void {
    this.persistState(lane.state)
  }

  private persistState(state: ThreadLaneState): void {
    try {
      this.deps.fs.mkdir(this.deps.stateDir)
      this.deps.fs.writeFile(this.statePath(state.rootId), `${JSON.stringify(state)}\n`)
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
      lastReplyId: str(r.lastReplyId),
      lastDelivered: r.lastDelivered === true,
      pid: typeof r.pid === 'number' && Number.isInteger(r.pid) && r.pid > 0 ? r.pid : null,
      pidStamp: typeof r.pidStamp === 'string' && r.pidStamp !== '' ? r.pidStamp : null,
    }
  }

  /**
   * Posts for one lane go out in order. A failed post is tried again after
   * each wait of THREAD_POST_RETRY_MS; when the last try fails too, onGiveUp
   * runs (a reply or a summary: the thread goes back to Open with a short
   * plain reply, so it never reads Working for good). onLanded runs once the
   * post went through.
   */
  private post(lane: Lane, path: string, body: Record<string, unknown>, onGiveUp?: () => void, onLanded?: () => void): void {
    lane.postsInFlight++
    lane.posts = lane.posts
      .then(() => this.postWithRetry(path, body))
      .then((ok) => {
        // A give up queues its own posts first, so the count never dips to 0 between.
        if (ok) onLanded?.()
        else onGiveUp?.()
      })
      .finally(() => {
        lane.postsInFlight--
      })
    this.track(lane.posts)
  }

  private async postWithRetry(path: string, body: Record<string, unknown>): Promise<boolean> {
    const waits = this.deps.postRetryMs ?? THREAD_POST_RETRY_MS
    for (let attempt = 0; ; attempt++) {
      try {
        await this.deps.post(path, body)
        return true
      } catch (err) {
        const why = err instanceof Error ? err.name : 'error'
        if (attempt >= waits.length) {
          this.deps.log(`threads: ${path} failed ${attempt + 1} times, giving up (${why})`)
          return false
        }
        this.deps.log(`threads: ${path} failed (${why}), trying again`)
        await new Promise<void>((done) => this.deps.setTimer(done, waits[attempt]!))
      }
    }
  }

  private track(p: Promise<unknown>): void {
    this.work.add(p)
    void p.finally(() => this.work.delete(p)).catch(() => {})
  }
}

/**
 * What a restart must wait for in threads: the lanes' work and every By the way fork with a live process. A fork
 * counts until its process exits, past its answer, because the fork may still be writing.
 */
export function liveThreadWork(lanes: { activeWork(): number }, forks: { size(): number }): number {
  return lanes.activeWork() + forks.size()
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
