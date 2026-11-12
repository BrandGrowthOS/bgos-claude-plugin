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
 *  - Full access (0.88.0): a thread its OWNER opens is a true fork with the
 *    agent's own access, in the agent's own folder, on a repository of any
 *    size (threadFullArgs), unless the owner's setting `threads.fullAccess`
 *    is off. No worktree, no copy of the repository; the prompts it still
 *    raises are answered as the main chat's are (deps.approve). Decided at
 *    every start by threadAccess: a thread a share recipient opens, and one
 *    whose opener is not known, is confined as below, exactly as before.
 *  - Confinement: every other lane runs `--restricted` with its own tools,
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
 *  - Selective hooks: a lane retains the plugin's non-Stop hooks, and its
 *    transcript clears the inherited /goal before resume. Defence
 *    below that: a turn a Stop hook blocks from ending more than twice is
 *    stopped and failed with a reply naming the cause, never left looping.
 *  - Each result is ONE thread reply (`final` unless it ends asking a
 *    question), clipped to the server's 20,000 characters; a post that fails
 *    is retried with backoff, and one that still fails puts the thread back
 *    to Open with a short plain reply, never a thread stuck at Working. A 403
 *    is the server's decision, so it is never retried: the answer is saved
 *    beside the lane state and the owner is told in the thread.
 *  - A reply carries no client key. The server refuses an assistant write with
 *    a key unless it proves that one assistant, and this daemon holds no such
 *    proof for this route. The cost: a retry after a lost response can post an
 *    answer more than once, which beats losing it.
 *  - A daemon crash leaves a lane finishing its turn (its stdin closed): its
 *    pid and start stamp are in the lane state, so the next start, a close or
 *    a delete stops it first (lib/lane-process.ts), never two lanes on one
 *    thread.
 *  - Close (0.88.0: the owner closes the thread or merges it back) stops the
 *    lane and removes everything the thread put on this computer: its
 *    worktree (git worktree remove and prune), its fork's session files, its
 *    temp files and its state, and logs the bytes freed. Its branch goes
 *    when it holds nothing that is in no other branch; otherwise the branch
 *    is kept and the owner is told (uncommitted changes are first saved on
 *    it as a commit). Delete does the same and removes the branch whatever
 *    it holds, as before. Either waits for a start in flight, so a worktree
 *    being made while the person closes is removed too. A reply to a closed
 *    thread starts a new fork and says its earlier turns are not in memory.
 *  - sweepLeftovers, when the daemon starts: what a crash left of threads
 *    that are already closed, thread folders with no state at all, and a
 *    main transcript copy named by a state. Never an open thread, never
 *    anything of the main session.
 *
 * Every effect is an injected dependency, so the whole manager is unit tested
 * with fakes (test/thread-lanes.test.ts). Erasable TypeScript only.
 */

import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve, sep } from 'node:path'

import {
  clipThreadText,
  isFinalReply,
  isSessionId,
  laneSecretPaths,
  protectedGitPaths,
  THREAD_LANE_REF_DIRS,
  threadAccess,
  threadFullArgs,
  threadLaneArgs,
  threadLaneTranscript,
  threadOpener,
  threadTurnPrompt,
  type ThreadAccess,
  type ThreadLaneConfinement,
  type ThreadOpener,
  type ThreadTurnMode,
} from './thread-lane-args.ts'
import { THREAD_LANE_ENV } from './thread-lane-marker.mjs'
import { formatBytes } from './thread-repo-size.ts'
import { lineSplitter, userMessageLine, type SpawnStreamJson, type StreamJsonChild } from './stream-json-child.ts'
import { sessionTranscriptPath } from '../bin/hoai-core.mjs'

export const THREAD_LANE_MAX_RUNNING = 2
export const THREAD_LANE_IDLE_MS = 20 * 60_000
export const THREAD_LANE_KILL_GRACE_MS = 10_000
/** 0.88.0: a closed thread is removed at once. Kept for a caller that sets its own wait (deps.keepClosedMs). */
export const THREAD_LANE_KEEP_CLOSED_MS = 0
/** A turn with no result and no exit after this long is failed and its lane stopped. */
export const THREAD_TURN_TIMEOUT_MS = 30 * 60_000
/**
 * A thread folder with no state that changed less than this long ago is not
 * an orphan yet: another daemon working in the same agent folder may be in
 * the middle of `git worktree add`, and writes its state only once that ends.
 */
export const THREAD_ORPHAN_MIN_AGE_MS = 10 * 60_000
/** How often a stop of a lane process left from before a daemon crash checks whether it is gone. */
export const THREAD_ORPHAN_POLL_MS = 250
/**
 * How many times a Stop hook may block one turn from ending before the lane is
 * stopped (THREADGOAL defence; the CLI's own cap is 9 and then it ends the
 * turn with an empty result).
 */
export const THREAD_STOP_HOOK_BLOCKS_MAX = 2
/** The prefix the CLI gives the synthetic user message a blocking Stop hook adds (measured, 2.1.319). */
const STOP_HOOK_FEEDBACK = 'Stop hook feedback:'
/** The waits between attempts of a post to BGOS (so 4 attempts in all). */
export const THREAD_POST_RETRY_MS: readonly number[] = Object.freeze([2_000, 10_000, 30_000])

const ROOT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MODES: readonly string[] = ['start', 'reply', 'summary']

const FAILED_TURN = 'This turn failed before the agent could answer, so send your reply again to retry.'
/**
 * Every way a thread can fail to open reads the same in the thread
 * (THREADCRASH): this prefix and a plain reason, never silence.
 */
export const COULD_NOT_OPEN = 'I could not open this thread:'
function couldNotOpen(reason: string): string {
  return `${COULD_NOT_OPEN} ${reason}`
}
const NO_SESSION = couldNotOpen('the agent has no running session to fork yet. Send your reply again once the agent has answered in the main chat.')
const NO_CLAUDE = couldNotOpen('this computer cannot run Claude Code right now.')
const NO_WORKTREE = couldNotOpen('its working copy could not be made. Send your reply again to retry.')
const NO_COPY = couldNotOpen('the main conversation could not be copied for it. Send your reply again to retry.')
const TIMED_OUT = 'This turn took longer than 30 minutes, so it was stopped. Send your reply again to retry.'
const POST_FAILED = 'The answer to this turn could not be delivered, so send your reply again to retry.'
const ANSWER_REFUSED_SAVED = "The server refused this answer, so it is saved on the agent's computer instead, and you can send your reply again to retry."
const ANSWER_REFUSED = 'The server refused this answer, so it did not arrive, and you can send your reply again to retry.'
const STOP_HOOK_LOOP =
  'This turn was stopped because a Stop hook (such as a /goal set in the main chat) kept blocking it from ending. Send your reply again to retry.'
const ORPHAN_ALIVE = couldNotOpen('an earlier run of this thread is still stopping. Send your reply again in a minute.')

/** A synthetic user message a blocking Stop hook added: its text starts with the CLI's feedback prefix. */
function isStopHookFeedback(frame: Record<string, unknown>): boolean {
  const message = frame.message as { content?: unknown } | undefined
  const content = message?.content
  if (typeof content === 'string') return content.startsWith(STOP_HOOK_FEEDBACK)
  if (!Array.isArray(content)) return false
  return content.some((block) => {
    const b = block as { type?: unknown; text?: unknown } | null
    return b?.type === 'text' && typeof b.text === 'string' && b.text.startsWith(STOP_HOOK_FEEDBACK)
  })
}

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
  /**
   * Who opened the thread, from the frame's own lane stamp
   * (lib/thread-lane-args.ts threadOpener). Absent or anything but `owner`:
   * the thread runs confined.
   */
  opener?: ThreadOpener
}

/** A prompt of an owner's full access thread, for the owner's own approval path. */
export interface ThreadApprovalInput {
  rootId: string
  chatId: string
  title: string
  toolName: string
  input: unknown
  description: string
}

/** What a close kept, for the owner to be told: a branch with work of its own, or a worktree that could not be saved. */
export interface ThreadKeptInfo {
  rootId: string
  title: string
  branch: string
  /** Set when the worktree itself was kept. */
  folder?: string
  reason: string
}

export interface ThreadLaneFs {
  exists(path: string): boolean
  mkdir(path: string): void
  readFile(path: string): string
  writeFile(path: string, data: string): void
  appendFile(path: string, data: string, mode?: number): void
  copyFile(from: string, to: string): void
  unlink(path: string): void
  rmrf(path: string): void
  list(dir: string): string[]
  /** Create a file that must not exist yet (git's own lock convention); throws when it does. */
  createExclusive(path: string, data: string): void
  rename(from: string, to: string): void
  /**
   * What a path is, links not followed, and when it last changed; null when
   * it is not there. The start sweep reads it to leave alone a link and a
   * folder that is still being made. Absent (unit fakes): no such check.
   */
  stat?(path: string): { kind: 'dir' | 'file' | 'link' | 'other'; modifiedMs: number } | null
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
  /**
   * Why a worktree of the agent folder would copy too much (lib/thread-repo-size.ts),
   * as a short plain phrase, or null. When it answers a reason the lane runs
   * read only in a plain folder and reads the agent folder in place. Absent:
   * every repository gets its worktree.
   */
  checkoutTooLarge?(agentFolder: string): Promise<string | null>
  /**
   * The transcript work on disk, in pieces and off the event loop
   * (lib/thread-transcript.ts). Absent (unit fakes), it goes through `fs`.
   */
  transcripts?: {
    copyClearingGoal(from: string, to: string): Promise<void>
    clearGoal(path: string): Promise<unknown>
    /** The transcript holds a goal that is still active (lib/thread-transcript.ts findActiveGoalRow). */
    hasActiveGoal?(path: string): Promise<boolean>
  }
  /**
   * The owner's setting `threads.fullAccess` (lib/thread-access.ts), read at
   * every start. Absent (a person's lane, a unit fake): every thread is
   * confined.
   */
  fullAccess?(): boolean
  /** The main session's permission mode now (lib/thread-transcript.ts latestPermissionMode), or null. */
  mainPermissionMode?(): Promise<string | null>
  /**
   * A prompt of a full access thread, answered as the owner's own chat
   * answers one (auto approve, the hard floor, the approval card). Absent,
   * or failing: the prompt is refused.
   */
  approve?(input: ThreadApprovalInput): Promise<{ allow: boolean; message?: string }>
  /** A new session id for a goal cleared copy of the main transcript. */
  newSessionId?(): string
  /** The bytes a file or a folder holds (lib/thread-access.ts diskUsage), for the close log line. */
  diskUsage?(path: string): Promise<number>
  /** Where the CLI keeps a session's temp files: <root>/<project folder name>/<session id>. */
  tempRoots?: readonly string[]
  /** A close kept a branch or a worktree: the owner is told once. */
  onBranchKept?(info: ThreadKeptInfo): void
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
  /**
   * How the lane last started: `full` in the agent's own folder (cwd is the
   * agent folder; `folder` is '' or an earlier worktree still to remove), or
   * `confined` in its own folder. A state saved before 0.88.0 has none and
   * reads as confined.
   */
  access: ThreadAccess
  /**
   * A copy of the main transcript made for a start (its goal cleared), until
   * the fork has read it. Named here so a crash leaves no unknown file
   * beside the main session's own.
   */
  tempCopy: string | null
  /**
   * The thread is closed and its working copy had to stay (its changes could
   * not be saved, or it is not on the thread's own branch). The owner was
   * told once; no sweep touches it again. A reply reopens the thread in it,
   * and a delete removes it.
   */
  kept?: boolean
  closedAt: number | null
  /**
   * The reply id of the last turn this lane finished (answered or failed), ''
   * before any. A reconnect's pending list can still name it while its answer
   * is being posted, or when that post never landed: it never runs again.
   */
  lastReplyId: string
  /** That turn's post is settled: its answer, summary or failure reply landed, or the server refused it. False until then (and in a state saved before this field). */
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
  /** Times a Stop hook blocked the current child turn from ending. */
  stopHookBlocks: number
  /**
   * The child sent an assistant frame since the current turn was written to it.
   * A result before that answers something else: the CLI's notice for a
   * background task the forked main session left behind ends in a result of
   * its own, empty and with no model turn, before the thread's message is read.
   */
  turnSawAssistant: boolean
  /**
   * The turn this child last failed with the generic sentence, until the next
   * turn is written to it or it exits: a result that still comes is its answer.
   */
  failedTurn: ThreadTurnInput | null
  /** The current child sent its init frame: an exit before it means the thread never opened. */
  sawInit: boolean
  /** A start in flight (worktree, confinement, spawn): close and delete wait for it. */
  starting: Promise<void> | null
  /** When the lane last finished a turn: the oldest idle lane gives its slot first. */
  idleSince: number
  copiedMainPath: string | null
  /** The lane's session moved to the agent's own folder at this start: its next turn says so, once. */
  upgraded: boolean
  /** The current child started a new fork: a reply written to it is framed like a first turn. */
  fresh: boolean
  posts: Promise<void>
  /** Posts queued or being tried for this lane (a reply retried with backoff counts until it settles). */
  postsInFlight: number
  closed: boolean
}

export class ThreadLaneManager {
  private readonly deps: ThreadLaneDeps
  private readonly lanes = new Map<string, Lane>()
  private readonly running = new Set<string>()
  /** rootId:replyId of a failure sentence a reconnect has out: a second reconnect does not queue another. */
  private readonly noticing = new Set<string>()
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
   * background step still going (a start, an answer being posted, a read of pending turns, a close or a delete). A lane
   * that only sits idle is not work: liveChildren() counts it for 20 minutes after its turn, and its next turn resumes
   * by its id. The hourly sweep of closed lanes is not counted: it runs no turn.
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
      if (lane.state.kept) lane.state.kept = false
      if (this.hasState(lane.state)) this.persist(lane)
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

  /**
   * Stop a thread's lane and remove everything it put on this computer (its
   * worktree, its session files, its temp files, its state). A plain close
   * (the owner closed the thread or merged it back) keeps the thread's branch
   * when it holds work found in no other branch; removeWorktree (delete)
   * removes the branch whatever it holds.
   */
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
    const settled: Promise<void> = Promise.all([starting, exited]).then(async () => {
      // Closed on disk before anything is removed: a crash from here on leaves a state the start sweep finishes.
      if (this.hasState(state) && this.deps.fs.exists(this.statePath(rootId)) && !this.lanes.has(rootId)) {
        state.closedAt = this.deps.now()
        this.persistState(state)
      }
      await this.removeLane(state, input.removeWorktree ? { branch: 'force', why: 'deleted' } : { branch: 'safe', why: 'closed' })
    })
    // Never a rejection: a removal that failed is logged, and the root is released either way.
    const done = Promise.all([settled, exited]).then(() => undefined, (err) => {
      this.deps.log(`threads: thread ${rootId} could not be cleaned up (${describeError(err)})`)
    })
    this.exiting.set(rootId, done)
    void done.then(() => {
      if (this.exiting.get(rootId) === done) this.exiting.delete(rootId)
    })
    this.track(done)
    this.pump()
    return { stopped: true }
  }

  /**
   * Remove what is left of every thread whose state says it is closed (a
   * close a crash cut short, or a thread an older version kept for 7 days).
   * An open thread is never touched. Answers the root ids removed.
   */
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
      // Its working copy had to stay and the owner knows: only a reply or a delete changes that.
      if (state.kept === true) continue
      if (keep > 0 && now - state.closedAt <= keep) continue
      // Reserve the root before removal yields, just like explicit deletion.
      // A reopening turn may queue, but ensureChild waits for this owner.
      const removal = this.removeLane(state, { branch: 'safe', why: 'closed earlier' })
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
   * THE START SWEEP (crash safety): once when the daemon starts, and with
   * the hourly sweep. Removes
   *  - what is left of every thread already closed (sweepClosed),
   *  - a copy of the main transcript a start left behind, named by its state,
   *  - a thread folder under <agent>/.hoai/threads with no state at all, in
   *    this agent's state folder or any other agent's on this computer.
   * Never a thread that is open (idle, running or only known from its state
   * file), and never a file of the main session. Answers the root ids removed.
   */
  async sweepLeftovers(): Promise<string[]> {
    const { fs, agentFolder, stateDir } = this.deps
    const removed = await this.sweepClosed(this.deps.now())
    let stateNames: string[] = []
    try {
      stateNames = fs.list(stateDir)
    } catch {}
    for (const name of stateNames) {
      const m = /^([A-Za-z0-9_-]{1,64})\.json$/.exec(name)
      if (!m || m[1] === 'empty-mcp') continue
      const lane = this.lanes.get(m[1]!)
      // A lane starting right now may be reading its copy.
      if (lane && (lane.child || lane.starting || lane.current)) continue
      const state = lane ? lane.state : this.load(m[1]!)
      if (!state || state.tempCopy === null) continue
      this.removeTempCopy(state)
      state.tempCopy = null
      this.persistState(state)
    }
    const base = join(agentFolder, '.hoai', 'threads')
    let folders: string[] = []
    try {
      folders = fs.list(base)
    } catch {}
    for (const rootId of folders) {
      if (!ROOT_ID_RE.test(rootId)) continue
      if (this.lanes.has(rootId) || this.exiting.has(rootId) || fs.exists(this.statePath(rootId))) continue
      // Another agent that works in this same folder may own it.
      if (this.knownToAnotherAgent(rootId)) continue
      const folder = join(base, rootId)
      if (fs.stat) {
        let info: ReturnType<NonNullable<ThreadLaneFs['stat']>> = null
        try {
          info = fs.stat(folder)
        } catch {}
        // Only a real folder (never a link: nothing is run in, or removed from, what it points to), and only
        // one that has been still for a while (THREAD_ORPHAN_MIN_AGE_MS).
        if (info === null || info.kind !== 'dir') continue
        if (this.deps.now() - info.modifiedMs < THREAD_ORPHAN_MIN_AGE_MS) continue
      }
      const state: ThreadLaneState = {
        rootId, chatId: '', title: '', forkSessionId: null, folder, cwd: folder, worktree: fs.exists(join(folder, '.git')), readOnly: false,
        access: 'confined', tempCopy: null, closedAt: this.deps.now(), lastReplyId: '', lastDelivered: true, pid: null, pidStamp: null,
      }
      const removal = this.removeLane(state, { branch: 'safe', why: 'left behind with no state' })
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

  /** A state file for this thread in another agent's state folder (<state root>/<agent>/threads). */
  private knownToAnotherAgent(rootId: string): boolean {
    const { fs, stateDir } = this.deps
    const root = dirname(dirname(stateDir))
    let agents: string[] = []
    try {
      agents = fs.list(root)
    } catch {
      return false
    }
    return agents.some((agent) => {
      const path = join(root, agent, basename(stateDir), `${rootId}.json`)
      return path !== this.statePath(rootId) && fs.exists(path)
    })
  }

  /**
   * A main transcript copy a state names. Removed only where a start puts
   * one (the agent folder's own project folder under a new id, or the lane's
   * own project folder), and never the main transcript itself.
   */
  private removeTempCopy(state: ThreadLaneState): void {
    const { fs, home, configDir, agentFolder } = this.deps
    const path = state.tempCopy
    if (path === null || !path.endsWith('.jsonl')) return
    const id = basename(path).slice(0, -'.jsonl'.length)
    if (!isSessionId(id)) return
    const main = this.deps.mainSessionId()
    if (isSessionId(main) && resolve(path) === resolve(sessionTranscriptPath(home, agentFolder, main, configDir))) return
    const allowed = [sessionTranscriptPath(home, agentFolder, id, configDir), ...(state.cwd ? [sessionTranscriptPath(home, state.cwd, id, configDir)] : [])]
    if (!allowed.some((p) => resolve(p) === resolve(path))) return
    try {
      fs.unlink(path)
    } catch {}
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
        // The row's own lane stamp, like a frame's: the owner's own row carries none.
        opener: threadOpener(r),
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
      // Only one sentence per turn at a time: a lane built here is not registered, so its post count guards nothing.
      const noticing = `${input.rootId}:${input.replyId}`
      if (this.noticing.has(noticing)) return 0
      this.noticing.add(noticing)
      this.deps.log(`threads: thread ${input.rootId} turn ${input.replyId} already finished, its answer is marked undelivered`)
      const target = lane ?? this.newLane(saved!)
      this.postFailure(target, input, POST_FAILED)
      void target.posts.catch(() => {}).finally(() => this.noticing.delete(noticing))
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
      // A copy made for a start is of no use to a process that is being stopped.
      this.dropCopiedMain(lane)
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
        access: 'confined',
        tempCopy: null,
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
      stopHookBlocks: 0,
      turnSawAssistant: false,
      failedTurn: null,
      sawInit: false,
      starting: null,
      idleSince: 0,
      copiedMainPath: null,
      upgraded: false,
      fresh: false,
      posts: Promise.resolve(),
      postsInFlight: 0,
      closed: false,
    }
  }

  private start(lane: Lane): void {
    const turn = lane.queue.shift()
    if (!turn) return
    lane.current = turn
    this.running.add(lane.state.rootId)
    this.post(lane, 'integrations/threads/state', { chatId: turn.chatId, rootId: turn.rootId, state: 'working' })
    this.track(this.runTurn(lane, turn))
  }

  private async runTurn(lane: Lane, turn: ThreadTurnInput): Promise<void> {
    try {
      const starting = this.ensureChild(lane, turn)
      lane.starting = starting
      try {
        await starting
      } finally {
        if (lane.starting === starting) lane.starting = null
      }
      if (lane.current !== turn || !lane.child || lane.closed) return
      lane.childTurn = turn
      lane.stopHookBlocks = 0
      lane.turnSawAssistant = false
      lane.failedTurn = null
      this.armTurnTimer(lane, turn)
      const full = lane.state.access === 'full'
      const upgraded = lane.upgraded
      const fresh = lane.fresh
      lane.upgraded = false
      lane.fresh = false
      const earlierWork = upgraded && lane.state.worktree && lane.state.folder
        ? { folder: lane.state.folder, branch: `hoai/thread-${lane.state.rootId}` }
        : null
      lane.child.write(userMessageLine(threadTurnPrompt({
        mode: turn.mode,
        text: turn.text,
        title: turn.title,
        rootText: turn.rootText,
        readOnly: lane.state.readOnly,
        agentFolder: this.deps.agentFolder,
        ...(full ? { access: 'full' as const } : {}),
        ...(fresh ? { fresh: true } : {}),
        ...(upgraded ? { upgraded: true, earlierWork } : {}),
      })))
    } catch (err) {
      // Nothing on a thread's start may reach the daemon's fault handlers: every
      // error ends here, as one plain log line and one reply in the thread.
      this.safely(`turn ${turn.rootId} failure`, () => {
        this.deps.log(`threads: turn ${turn.rootId} could not start (${describeError(err)})`)
        this.failTurn(lane, turn, err instanceof ThreadLaneError ? err.message : couldNotOpen(`something went wrong while starting it (${errorName(err)}). Send your reply again to retry.`))
      })
    }
  }

  /** Run a callback that must never throw into the event loop (a child's exit, a frame, a timer). */
  private safely(what: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      try {
        this.deps.log(`threads: ${what} failed (${describeError(err)})`)
      } catch {}
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
    const raw = typeof frame.result === 'string' ? frame.result : ''
    const empty = raw.trim() === ''
    const failed = frame.is_error === true || (frame.subtype !== undefined && frame.subtype !== 'success') || empty
    if (!turn || lane.current !== turn) {
      this.onStrayResult(lane, frame, raw, failed)
      return
    }
    // Not this turn's answer: the empty result of a notice (no model turn), or
    // any result before the CLI said anything since the message was written.
    const noModelTurn = frame.num_turns === 0 && empty && frame.is_error !== true
    if (noModelTurn || !lane.turnSawAssistant) {
      const why = noModelTurn ? 'it is empty and ran no model turn' : 'it came before the first assistant frame'
      this.deps.log(`threads: thread ${turn.rootId} turn ${turn.replyId} skipped a result that is not its answer, ${why} (${describeResult(frame, raw)})`)
      return
    }
    this.endTurn(lane)
    this.finished(lane, turn)
    if (failed) {
      // The process lives on: an answer it still sends is this turn's (onStrayResult).
      lane.failedTurn = turn
      this.postFailure(lane, turn, FAILED_TURN)
    } else {
      this.postAnswer(lane, turn, raw)
    }
    this.afterTurn(lane)
  }

  /**
   * A result with no turn waiting for it. After a turn failed with the generic
   * sentence, the first good one from the same process is that turn's answer
   * and is posted as a reply in the thread, whatever the turn's mode. Every
   * other one is dropped, with one log line.
   */
  private onStrayResult(lane: Lane, frame: Record<string, unknown>, raw: string, failed: boolean): void {
    const late = lane.failedTurn
    if (late && !failed && !lane.closed) {
      lane.failedTurn = null
      this.deps.log(`threads: thread ${late.rootId} turn ${late.replyId} answered after it was reported failed, its answer is posted (${describeResult(frame, raw)})`)
      this.postAnswer(lane, late, raw, true)
      return
    }
    this.deps.log(`threads: lane ${lane.state.rootId} dropped a result that belongs to no turn (${describeResult(frame, raw)})`)
  }

  /** Post a turn's answer where its mode sends it: the summary route, or a reply in the thread (`asReply`: always a reply). */
  private postAnswer(lane: Lane, turn: ThreadTurnInput, raw: string, asReply = false): void {
    const text = clipThreadText(raw)
    const refused = () => this.answerRefused(lane, turn, text)
    if (turn.mode === 'summary' && !asReply) {
      this.post(
        lane,
        'integrations/threads/summary',
        { chatId: turn.chatId, rootId: turn.rootId, summary: text },
        () => this.postFailure(lane, turn, POST_FAILED),
        () => this.landed(lane, turn),
        refused,
      )
    } else {
      this.post(
        lane,
        'integrations/threads/reply',
        { chatId: turn.chatId, rootId: turn.rootId, text, final: isFinalReply(raw) },
        () => this.postFailure(lane, turn, POST_FAILED),
        () => this.landed(lane, turn),
        refused,
      )
    }
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
    if (this.hasState(lane.state)) this.persist(lane)
  }

  private postFailure(lane: Lane, turn: ThreadTurnInput, sentence: string): void {
    this.post(lane, 'integrations/threads/state', { chatId: turn.chatId, rootId: turn.rootId, state: 'open' })
    this.post(
      lane,
      'integrations/threads/reply',
      { chatId: turn.chatId, rootId: turn.rootId, text: sentence, final: false },
      undefined,
      () => this.landed(lane, turn),
      // A refused sentence settles the turn too: a reconnect must not post it again.
      () => this.landed(lane, turn),
    )
  }

  /** The server refused this turn's answer: keep it on this computer and say so once in the thread. */
  private answerRefused(lane: Lane, turn: ThreadTurnInput, text: string): void {
    this.deps.log(`threads: thread ${turn.rootId} turn ${turn.replyId} answer was refused by the server`)
    this.postFailure(lane, turn, this.saveRefused(turn, text) ? ANSWER_REFUSED_SAVED : ANSWER_REFUSED)
  }

  private saveRefused(turn: ThreadTurnInput, text: string): boolean {
    // A thread deleted while this post was out stays deleted: nothing would ever remove this file.
    if (!this.deps.fs.exists(this.statePath(turn.rootId))) return false
    try {
      this.deps.fs.appendFile(this.undeliveredPath(turn.rootId), `--- reply ${turn.replyId} ---\n${text}\n`, 0o600)
      this.deps.log(`threads: thread ${turn.rootId} refused answer is saved in ${turn.rootId}.undelivered.txt`)
      return true
    } catch (err) {
      this.deps.log(`threads: thread ${turn.rootId} refused answer could not be saved (${err instanceof Error ? err.name : 'error'})`)
      return false
    }
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
    if (this.hasState(current)) this.persistState(current)
  }

  /** The lane has a state file to keep current: it has a folder of its own, or runs in the agent's. */
  private hasState(state: ThreadLaneState): boolean {
    return state.folder !== '' || state.access === 'full'
  }

  /** THE SPLIT, at every start: full access for the owner with the setting on, confined for everything else. */
  private accessFor(turn: ThreadTurnInput): ThreadAccess {
    let on = false
    try {
      on = this.deps.fullAccess ? this.deps.fullAccess() === true : false
    } catch {
      on = false
    }
    return threadAccess({ opener: turn.opener, fullAccess: on })
  }

  private async ensureChild(lane: Lane, turn: ThreadTurnInput): Promise<void> {
    const before = this.exiting.get(lane.state.rootId)
    if (before) await before
    // Cleanup can finish while this turn waits for a slot, leaving no
    // exiting entry. Check at startup before recreating the saved state.
    if (!this.deps.fs.exists(this.statePath(lane.state.rootId))) {
      lane.state.forkSessionId = null
      lane.state.pid = null
      lane.state.pidStamp = null
    }
    // THE SPLIT holds for a process that is still alive too: one started with another access than this
    // turn may have (the owner turned the setting off or on, or this turn is not the owner's) is stopped,
    // never reused, and the turn runs on a new one.
    if (lane.child && !lane.stopping && !lane.closed && this.accessFor(turn) !== lane.state.access) {
      this.deps.log(`threads: lane ${lane.state.rootId} is restarted, its access changed`)
      this.clearIdle(lane)
      this.stopChild(lane)
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
    if (problem) throw new ThreadLaneError('unsupported', couldNotOpen(problem))
    if (lane.closed || lane.child) return
    if (this.accessFor(turn) === 'full') {
      await this.startFull(lane, claude)
      return
    }
    // The owner turned full access off: the thread goes back to a folder of its own, with its session.
    const cameFrom = lane.state.access === 'full' ? lane.state.cwd : ''
    if (lane.state.access === 'full') {
      const { folder, cwd } = lane.state
      const own = this.ownFolder(lane.state)
      if (own !== null && !lane.state.worktree && this.deps.fs.exists(own)) {
        // It ran read only in a plain folder of its own before it had full access (a repository too large to
        // copy, or no repository): read only there again, never taken for a worktree.
        lane.state.access = 'confined'
        lane.state.cwd = own
        lane.state.readOnly = true
        this.persist(lane)
      } else {
        lane.state.access = 'confined'
        lane.state.folder = ''
        lane.state.cwd = ''
        try {
          await this.prepareFolder(lane)
        } catch (err) {
          // No folder of its own could be made: the state still says where its session is.
          lane.state.access = 'full'
          lane.state.folder = folder
          lane.state.cwd = cwd
          throw err
        }
      }
    } else {
      await this.prepareFolder(lane)
    }
    if (cameFrom && lane.state.forkSessionId) {
      const fork = lane.state.forkSessionId
      if (!(await this.moveFork(fork, cameFrom, lane.state.cwd))) {
        // It starts as a new fork. The session it could not take along is the thread's own and nobody would
        // name it again: it goes, never left beside the main session's.
        lane.state.forkSessionId = null
        this.dropFork(fork, cameFrom)
      }
      this.persist(lane)
    }
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
      // Also clear goals in forks saved by versions that disabled all hooks.
      const path = sessionTranscriptPath(this.deps.home, lane.state.cwd, lane.state.forkSessionId, this.deps.configDir)
      if (this.deps.fs.exists(path)) {
        try {
          await this.clearForkGoal(path)
        } catch (err) {
          // The fork resumes as it is: its goal, if any, is caught by the Stop hook defence.
          this.deps.log(`threads: lane ${lane.state.rootId} could not clear its inherited goal (${describeError(err)})`)
        }
        // Closed while its transcript was being read: no process for it.
        if (lane.closed) return
      }
    } else {
      const mainId = this.deps.mainSessionId()
      if (!isSessionId(mainId)) throw new ThreadLaneError('no_session', NO_SESSION)
      args = threadLaneArgs({ mainSessionId: mainId, forkSessionId: null, emptyMcpConfigPath: mcp, confinement })
      await this.copyMainTranscript(lane, mainId)
      if (lane.closed) {
        this.dropCopiedMain(lane)
        return
      }
    }
    this.attach(lane, claude, args, { cwd: lane.state.cwd })
  }

  /**
   * An OWNER's thread (lib/thread-lane-args.ts threadFullArgs): a true fork
   * in the agent's own folder with the main session's permission mode. No
   * worktree and no copy of the repository, whatever its size. A main chat
   * goal that is still active is cleared in a copy the fork reads instead.
   */
  private async startFull(lane: Lane, claude: string): Promise<void> {
    const { agentFolder, home, configDir, fs } = this.deps
    await this.enterFullAccess(lane)
    if (lane.closed) return
    let mode: string | null = null
    try {
      mode = this.deps.mainPermissionMode ? await this.deps.mainPermissionMode() : null
    } catch {
      // Not known: the thread starts in `default`, where every prompt reaches the owner.
      mode = null
    }
    if (lane.closed) return
    let args: string[]
    const own = lane.state.forkSessionId
    const ownPath = own ? sessionTranscriptPath(home, agentFolder, own, configDir) : ''
    if (own && fs.exists(ownPath)) {
      args = threadFullArgs({ mainSessionId: this.deps.mainSessionId(), forkSessionId: own, permissionMode: mode })
      try {
        await this.clearForkGoal(ownPath)
      } catch (err) {
        this.deps.log(`threads: lane ${lane.state.rootId} could not clear its inherited goal (${describeError(err)})`)
      }
      // Closed while its transcript was being read: no process for it.
      if (lane.closed) return
    } else {
      // No session of its own (a first start, or its files are gone): a new fork of the main session.
      lane.state.forkSessionId = null
      const mainId = this.deps.mainSessionId()
      if (!isSessionId(mainId)) throw new ThreadLaneError('no_session', NO_SESSION)
      const from = sessionTranscriptPath(home, agentFolder, mainId, configDir)
      if (!fs.exists(from)) throw new ThreadLaneError('no_session', NO_SESSION)
      const forkFrom = await this.goalClearedCopy(lane, mainId, from)
      if (lane.closed) {
        this.dropCopiedMain(lane)
        return
      }
      args = threadFullArgs({ mainSessionId: mainId, forkSessionId: null, forkFrom, permissionMode: mode })
    }
    // The owner's environment, and the mark that keeps a second copy of this plugin out
    // (lib/thread-lane-marker.mjs): the path of this lane's own state file, which names its process.
    this.attach(lane, claude, args, { cwd: agentFolder, ownerEnv: true, env: { [THREAD_LANE_ENV]: this.statePath(lane.state.rootId) } })
    const child = lane.child
    const named = this.load(lane.state.rootId)
    if (child && typeof child.pid === 'number' && named?.pid !== child.pid) {
      // Its state could not be saved, so the mark names nobody and a second copy of this plugin would start in the thread.
      this.deps.log(`threads: lane ${lane.state.rootId} was stopped, its state could not be saved`)
      this.stopChild(lane)
      throw new ThreadLaneError('state_failed', couldNotOpen('its state could not be saved on this computer. Send your reply again to retry.'))
    }
  }

  /** The lane runs in the agent's own folder from here on; a session it has from a confined start moves there. */
  private async enterFullAccess(lane: Lane): Promise<void> {
    const { agentFolder } = this.deps
    const state = lane.state
    if (state.access === 'full' && state.cwd === agentFolder) return
    const from = state.cwd
    if (state.forkSessionId && from && from !== agentFolder) {
      if (await this.moveFork(state.forkSessionId, from, agentFolder)) lane.upgraded = true
      else state.forkSessionId = null
    }
    // `folder` and `worktree` stay as they are: an earlier worktree is still the thread's own and goes when it closes.
    state.access = 'full'
    state.cwd = agentFolder
    state.readOnly = false
    this.persist(lane)
  }

  /**
   * Move a lane's own session transcript to the project folder of another
   * working folder (the CLI looks a `--resume` id up by its cwd). False when
   * there is no transcript to move, or it could not be moved.
   */
  private async moveFork(forkId: string, fromCwd: string, toCwd: string): Promise<boolean> {
    const { fs, home, configDir } = this.deps
    if (!isSessionId(forkId) || this.isMainSession(forkId)) return false
    const from = sessionTranscriptPath(home, fromCwd, forkId, configDir)
    const to = sessionTranscriptPath(home, toCwd, forkId, configDir)
    if (from === to) return fs.exists(from)
    if (!fs.exists(from)) return false
    try {
      fs.mkdir(dirname(to))
      if (this.deps.transcripts) await this.deps.transcripts.copyClearingGoal(from, to)
      else fs.copyFile(from, to)
      fs.unlink(from)
    } catch (err) {
      this.deps.log(`threads: a thread's session could not be moved (${describeError(err)})`)
      try {
        fs.unlink(to)
      } catch {}
      return false
    }
    // The session's own folder beside it (its tool results) follows when the file system can move it.
    try {
      const dir = from.slice(0, -'.jsonl'.length)
      if (from.endsWith('.jsonl') && fs.exists(dir)) fs.rename(dir, to.slice(0, -'.jsonl'.length))
    } catch {}
    return true
  }

  /** Remove a thread's own session transcript and the folder beside it from one working folder's project folder. Never the main session's. */
  private dropFork(forkId: string, cwd: string): void {
    const { fs, home, configDir } = this.deps
    if (!isSessionId(forkId) || this.isMainSession(forkId) || !cwd) return
    const transcript = sessionTranscriptPath(home, cwd, forkId, configDir)
    if (!transcript.endsWith(`${forkId}.jsonl`)) return
    for (const path of [transcript, transcript.slice(0, -'.jsonl'.length)]) {
      try {
        fs.rmrf(path)
      } catch {}
    }
  }

  /**
   * A copy of the main transcript with its active goal cleared, beside the
   * main transcript under a new session id, for the fork to read; null when
   * the main chat has no active goal (the fork then reads the main
   * transcript where it is). Named in the lane state before it is made.
   */
  private async goalClearedCopy(lane: Lane, mainId: string, from: string): Promise<string | null> {
    const { fs, home, configDir, agentFolder } = this.deps
    let active = true
    try {
      active = this.deps.transcripts?.hasActiveGoal
        ? await this.deps.transcripts.hasActiveGoal(from)
        : threadLaneTranscript(fs.readFile(from)) !== fs.readFile(from)
    } catch (err) {
      // Not known: the copy is made, which is right either way.
      this.deps.log(`threads: lane ${lane.state.rootId} could not read the main chat's goal (${describeError(err)})`)
    }
    if (!active) return null
    const id = (this.deps.newSessionId ?? randomUUID)()
    if (!isSessionId(id) || this.isMainSession(id)) throw new ThreadLaneError('copy_failed', NO_COPY)
    const to = sessionTranscriptPath(home, agentFolder, id, configDir)
    if (to === from || fs.exists(to)) throw new ThreadLaneError('copy_failed', NO_COPY)
    lane.copiedMainPath = to
    lane.state.tempCopy = to
    this.persist(lane)
    try {
      if (this.deps.transcripts) await this.deps.transcripts.copyClearingGoal(from, to)
      else fs.writeFile(to, threadLaneTranscript(fs.readFile(from)))
    } catch (err) {
      this.deps.log(`threads: lane ${lane.state.rootId} could not copy the main transcript (${describeError(err)})`)
      this.dropCopiedMain(lane)
      throw new ThreadLaneError('copy_failed', NO_COPY)
    }
    return id
  }

  /** True for the main session's own id: nothing keyed by it is ever a thread's to move or remove. */
  private isMainSession(id: string): boolean {
    const main = this.deps.mainSessionId()
    return typeof main === 'string' && main.toLowerCase() === id.toLowerCase()
  }

  /** Start the lane's process and wire its frames and its exit. */
  private attach(lane: Lane, claude: string, args: string[], opts: { cwd: string; env?: Record<string, string>; ownerEnv?: boolean }): void {
    let child: StreamJsonChild
    try {
      child = this.deps.spawn(claude, args, opts)
    } catch (err) {
      this.dropCopiedMain(lane)
      throw new ThreadLaneError('spawn_failed', couldNotOpen(`Claude Code could not be started for it (${errorName(err)}). Send your reply again to retry.`))
    }
    lane.child = child
    lane.stopping = false
    lane.sawInit = false
    // A new fork: a reply written to it is framed like a first turn (threadTurnPrompt `fresh`).
    lane.fresh = lane.state.forkSessionId === null
    this.recordPid(lane, child)
    lane.exited = new Promise<void>((done) => {
      child.onExit((code) => {
        this.safely(`lane ${lane.state.rootId} exit`, () => this.onExit(lane, child, code))
        done()
      })
    })
    child.onStdout(lineSplitter((frame) => this.safely(`lane ${lane.state.rootId} frame`, () => this.onFrame(lane, child, frame))))
  }

  /** The fork's own transcript, its inherited goal cleared in place. */
  private async clearForkGoal(path: string): Promise<void> {
    if (this.deps.transcripts) {
      await this.deps.transcripts.clearGoal(path)
      return
    }
    const before = this.deps.fs.readFile(path)
    const after = threadLaneTranscript(before)
    if (after === before) return
    // A crash during an upgrade must not truncate the fork's memory.
    const temporary = `${path}.thread-goal.tmp`
    try {
      this.deps.fs.writeFile(temporary, after)
      this.deps.fs.rename(temporary, path)
    } finally {
      try { this.deps.fs.unlink(temporary) } catch {}
    }
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

  /**
   * The main transcript, copied where the CLI looks a `--resume` id up for the
   * lane's folder, with its active goal cleared in the copy. On disk and in
   * pieces (THREADCRASH): an agent's main transcript can be hundreds of
   * megabytes, and reading it whole on the event loop took the daemon down.
   */
  private async copyMainTranscript(lane: Lane, mainId: string): Promise<void> {
    const { fs, home, configDir, agentFolder } = this.deps
    const from = sessionTranscriptPath(home, agentFolder, mainId, configDir)
    const to = sessionTranscriptPath(home, lane.state.cwd, mainId, configDir)
    if (from === to) throw new ThreadLaneError('no_session', NO_SESSION)
    if (!fs.exists(from)) throw new ThreadLaneError('no_session', NO_SESSION)
    // Named before the copy: a copy cut short is removed like a finished one.
    lane.copiedMainPath = to
    try {
      fs.mkdir(dirname(to))
      if (this.deps.transcripts) {
        await this.deps.transcripts.copyClearingGoal(from, to)
      } else {
        fs.writeFile(to, threadLaneTranscript(fs.readFile(from)))
      }
    } catch (err) {
      this.deps.log(`threads: lane ${lane.state.rootId} could not copy the main transcript (${describeError(err)})`)
      this.dropCopiedMain(lane)
      throw new ThreadLaneError('copy_failed', NO_COPY)
    }
  }

  private onFrame(lane: Lane, child: StreamJsonChild, frame: Record<string, unknown>): void {
    // A stopping child (closed, timed out, idle) speaks for no turn any more.
    if (lane.child !== child || lane.stopping) {
      if (frame.type === 'result') {
        this.deps.log(`threads: lane ${lane.state.rootId} dropped a result from a process that is stopping or was replaced (${describeResult(frame, typeof frame.result === 'string' ? frame.result : '')})`)
      }
      return
    }
    if (frame.type === 'system' && frame.subtype === 'init') {
      lane.sawInit = true
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
    if (frame.type === 'control_request') {
      this.onControlRequest(lane, child, frame)
      return
    }
    if (frame.type === 'assistant') lane.turnSawAssistant = true
    if (frame.type === 'user' && isStopHookFeedback(frame)) this.onStopHookBlock(lane)
    if (frame.type === 'result') this.onResult(lane, frame)
  }

  /**
   * A permission prompt of the lane (`--permission-prompt-tool stdio`, only a
   * full access thread carries it): answered by the owner's own approval
   * path. A confined lane never gets one allowed here, and with no approval
   * path, or one that fails, the prompt is refused: never left unanswered,
   * never allowed by default.
   */
  private onControlRequest(lane: Lane, child: StreamJsonChild, frame: Record<string, unknown>): void {
    const requestId = typeof frame.request_id === 'string' ? frame.request_id : ''
    const request = (frame.request && typeof frame.request === 'object' ? frame.request : {}) as Record<string, unknown>
    if (!requestId) return
    if (request.subtype !== 'can_use_tool') {
      child.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'not supported by this host' } })}\n`)
      return
    }
    const input = request.input ?? {}
    const answer = (verdict: { allow: boolean; message?: string } | null | undefined): void => {
      if (lane.child !== child) return
      // Only an explicit yes allows: an answer that is no verdict at all refuses.
      const response = verdict?.allow === true
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: typeof verdict?.message === 'string' ? verdict.message : 'Your owner did not allow this.' }
      child.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })}\n`)
    }
    const approve = this.deps.approve
    if (lane.state.access !== 'full' || !approve) {
      answer({ allow: false, message: 'This thread has nobody to ask, so this was not done.' })
      return
    }
    const toolName = typeof request.tool_name === 'string' ? request.tool_name : 'a tool'
    const title = lane.state.title || lane.state.rootId
    const description = typeof request.description === 'string' && request.description ? request.description : `${toolName} in the thread "${title}"`
    const failed = () => answer({ allow: false, message: 'The approval could not be asked, so this was not done.' })
    try {
      this.track(approve({ rootId: lane.state.rootId, chatId: lane.state.chatId, title, toolName, input, description }).then(answer, failed))
    } catch {
      failed()
    }
  }

  /**
   * A Stop hook blocked the turn from ending. Inherited Stop hooks are excluded, so this is
   * a defence: past THREAD_STOP_HOOK_BLOCKS_MAX the lane is stopped and the
   * turn failed with its cause, never a loop and never the generic failure.
   */
  private onStopHookBlock(lane: Lane): void {
    const turn = lane.childTurn
    if (!turn || lane.current !== turn) return
    lane.stopHookBlocks++
    if (lane.stopHookBlocks <= THREAD_STOP_HOOK_BLOCKS_MAX) return
    this.deps.log(`threads: turn ${turn.rootId} was stopped, a Stop hook blocked it ${lane.stopHookBlocks} times`)
    this.stopChild(lane)
    this.failTurn(lane, turn, STOP_HOOK_LOOP)
  }

  private onExit(lane: Lane, child: StreamJsonChild, code: number | null = null): void {
    if (lane.child !== child) return
    // Gone before it ever said it started: the fork itself failed to open.
    const neverStarted = !lane.sawInit && !lane.stopping
    lane.child = null
    lane.stopping = false
    if (lane.state.pid !== null && lane.state.pid === child.pid) {
      lane.state.pid = null
      lane.state.pidStamp = null
      // Not over a reopened lane's own state file.
      const current = this.lanes.get(lane.state.rootId)
      if (this.hasState(lane.state) && (current === lane || current === undefined)) this.persist(lane)
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
    lane.failedTurn = null
    if (ran && lane.current === ran) {
      if (neverStarted) {
        this.deps.log(`threads: lane ${lane.state.rootId} exited before it started (exit code ${code === null ? 'none' : code})`)
        this.failTurn(lane, ran, couldNotOpen(`Claude Code stopped before it could start the thread (exit code ${code === null ? 'none' : code}). Send your reply again to retry.`))
      } else {
        this.failTurn(lane, ran, FAILED_TURN)
      }
    } else this.pump()
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
    if (this.hasState(lane.state)) this.persist(lane)
    this.readStamp(lane, child)
  }

  private readStamp(lane: Lane, child: StreamJsonChild): void {
    const pid = child.pid
    if (typeof pid !== 'number' || lane.state.pid !== pid || lane.state.pidStamp !== null) return
    this.track(
      this.deps.processes.stamp(pid).then((stamp) => {
        if (typeof stamp !== 'string' || lane.child !== child || lane.state.pid !== pid || lane.state.pidStamp !== null) return
        lane.state.pidStamp = stamp
        if (this.hasState(lane.state)) this.persist(lane)
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
      if (this.hasState(state)) this.persistState(state)
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
    if (lane.state.tempCopy !== null) {
      lane.state.tempCopy = null
      // Not over a state file a close removed meanwhile.
      if (this.hasState(lane.state) && this.deps.fs.exists(this.statePath(lane.state.rootId))) this.persist(lane)
    }
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
    lane.turnTimer = this.deps.setTimer(() => this.safely(`turn ${turn.rootId} timer`, () => {
      lane.turnTimer = null
      if (lane.current !== turn) return
      this.deps.log(`threads: turn ${turn.rootId} timed out, its lane is stopped`)
      this.stopChild(lane)
      this.failTurn(lane, turn, TIMED_OUT)
    }), this.deps.turnTimeoutMs ?? THREAD_TURN_TIMEOUT_MS)
  }

  private clearTurnTimer(lane: Lane): void {
    if (lane.turnTimer === null) return
    this.deps.clearTimer(lane.turnTimer)
    lane.turnTimer = null
  }

  private armIdle(lane: Lane): void {
    this.clearIdle(lane)
    if (!lane.child) return
    lane.idleTimer = this.deps.setTimer(() => this.safely(`lane ${lane.state.rootId} idle stop`, () => {
      lane.idleTimer = null
      if (!lane.current && lane.queue.length === 0) this.stopChild(lane)
    }), this.deps.idleMs ?? THREAD_LANE_IDLE_MS)
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
    // A repository too large to check out again (THREADCRASH): the lane reads it in place, read only.
    let tooLarge: string | null = null
    if (prefix.ok && this.deps.checkoutTooLarge && !fs.exists(folder)) {
      try {
        tooLarge = await this.deps.checkoutTooLarge(agentFolder)
      } catch (err) {
        tooLarge = `its size could not be measured (${errorName(err)})`
      }
      if (tooLarge) this.deps.log(`threads: thread ${rootId} runs read only in the agent folder, no worktree: the repository is too large to copy (${tooLarge})`)
    }
    // `.hoai/` stays out of the owner's git status either way.
    if (prefix.ok) await this.ensureExcluded()
    if (prefix.ok && !tooLarge) {
      if (!fs.exists(folder)) {
        const branch = `hoai/thread-${rootId}`
        let added = await git(['-C', agentFolder, 'worktree', 'add', rel, '-b', branch], agentFolder)
        // The branch is left from an earlier worktree of this thread.
        if (!added.ok) added = await git(['-C', agentFolder, 'worktree', 'add', rel, branch], agentFolder)
        if (!added.ok) {
          // A checkout cut short (a timeout) leaves a half folder git knows: it goes, so a retry starts clean.
          if (fs.exists(folder)) {
            const removed = await git(['-C', agentFolder, 'worktree', 'remove', '--force', folder], agentFolder)
            if (!removed.ok) {
              try {
                fs.rmrf(folder)
              } catch {}
            }
            await git(['-C', agentFolder, 'worktree', 'prune'], agentFolder)
          }
          this.deps.log(`threads: thread ${rootId} could not get its worktree (git worktree add failed)`)
          throw new ThreadLaneError('worktree_failed', NO_WORKTREE)
        }
      }
      const inside = prefix.stdout.trim()
      lane.state.folder = folder
      lane.state.cwd = inside ? join(folder, inside) : folder
      lane.state.worktree = true
      lane.state.readOnly = false
    } else {
      try {
        fs.mkdir(folder)
      } catch (err) {
        this.deps.log(`threads: thread ${rootId} could not make its folder (${describeError(err)})`)
        throw new ThreadLaneError('worktree_failed', NO_WORKTREE)
      }
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

  private async removeLane(state: ThreadLaneState, opts: { branch: 'force' | 'safe'; why: string }): Promise<boolean> {
    const { fs } = this.deps
    if (!(await this.stopOrphan(state))) return false
    const freed = { bytes: 0 }
    const notes: string[] = []
    const folder = this.ownFolder(state)
    if (state.folder && folder === null) {
      this.deps.log(`threads: lane ${state.rootId} names a folder outside the threads folder, it is not removed`)
    }
    let keptFolder = false
    if (folder === null) {
      // Nothing of the folder's: only the session files and the state below.
    } else if (state.worktree) {
      keptFolder = await this.removeWorktree(state, folder, opts.branch, freed, notes)
    } else {
      const bytes = await this.usage(folder)
      try {
        fs.rmrf(folder)
        freed.bytes += bytes
      } catch {}
    }
    for (const path of this.sessionPaths(state, keptFolder ? null : folder)) {
      const bytes = await this.usage(path)
      try {
        fs.rmrf(path)
        freed.bytes += bytes
      } catch {}
    }
    this.removeTempCopy(state)
    if (keptFolder) {
      // The working copy stays, so its state stays too, marked: the folder is nobody's orphan, the owner is
      // told once, a reply finds it again and a delete removes it. Its session is gone, so it has no fork.
      const kept: ThreadLaneState = { ...state, forkSessionId: null, pid: null, pidStamp: null, tempCopy: null, closedAt: state.closedAt ?? this.deps.now(), kept: true }
      this.persistState(kept)
    } else {
      try {
        fs.unlink(this.statePath(state.rootId))
      } catch {}
    }
    try {
      fs.unlink(this.undeliveredPath(state.rootId))
    } catch {}
    // A queued reopen may have loaded this fork before cleanup. Invalidate
    // that copy too, so a close or late delivery cannot save it again.
    const reopened = this.lanes.get(state.rootId)
    if (reopened) {
      reopened.state.forkSessionId = null
      reopened.state.pid = null
      reopened.state.pidStamp = null
    }
    const what = keptFolder ? 'its working copy is kept and its other files on this computer are removed' : 'its files on this computer are removed'
    this.deps.log(`threads: thread ${state.rootId} ${opts.why}, ${what}: freed ${freed.bytes} bytes (${formatBytes(freed.bytes)})${notes.map((n) => `; ${n}`).join('')}`)
    // False while something of the thread is still here: a sweep does not count it as removed.
    return !keptFolder
  }

  /** The bytes a path holds, for the close log line; 0 where the daemon cannot measure. */
  private async usage(path: string): Promise<number> {
    try {
      const n = this.deps.diskUsage ? await this.deps.diskUsage(path) : 0
      return Number.isFinite(n) && n > 0 ? n : 0
    } catch {
      return 0
    }
  }

  /**
   * Remove a thread's worktree (git worktree remove, then prune) and its
   * branch. `safe` (a close): uncommitted changes are first saved on the
   * branch as a commit, and the branch goes only when nothing on it is
   * missing from every other branch and remote; otherwise it is kept and the
   * owner is told. `force` (a delete): the branch goes, as before 0.88.0.
   * True when the worktree itself had to be kept (its changes could not be
   * saved): then nothing of the folder is removed.
   */
  private async removeWorktree(state: ThreadLaneState, folder: string, mode: 'force' | 'safe', freed: { bytes: number }, notes: string[]): Promise<boolean> {
    const { fs, git, agentFolder } = this.deps
    const branch = `hoai/thread-${state.rootId}`
    const keep = (reason: string, keptFolder?: string): void => {
      notes.push(keptFolder ? `kept the worktree ${keptFolder} and the branch ${branch} (${reason})` : `kept the branch ${branch} (${reason})`)
      try {
        this.deps.onBranchKept?.({ rootId: state.rootId, title: state.title, branch, ...(keptFolder ? { folder: keptFolder } : {}), reason })
      } catch {}
    }
    let saved: 'clean' | 'saved' | 'failed' = 'clean'
    if (mode === 'safe' && fs.exists(folder)) {
      // What the worktree holds is on the thread's branch only while its HEAD is that branch. Detached, or on a
      // branch the thread made itself, a commit (one of its own, or the save below) goes with the checkout.
      const head = await git(['-C', folder, 'symbolic-ref', '-q', 'HEAD'], folder)
      if (!head.ok || head.stdout.trim() !== `refs/heads/${branch}`) {
        keep('its working copy is not on the thread\'s own branch, so its work would be lost with it', folder)
        return true
      }
      saved = await this.saveUncommitted(state, folder)
    }
    if (saved === 'failed') {
      keep('its uncommitted changes could not be saved on the branch', folder)
      return true
    }
    const bytes = await this.usage(folder)
    const removed = await git(['-C', agentFolder, 'worktree', 'remove', '--force', folder], agentFolder)
    if (!removed.ok) {
      try {
        fs.rmrf(folder)
      } catch {}
    }
    await git(['-C', agentFolder, 'worktree', 'prune'], agentFolder)
    // The branch goes only once its worktree is gone (git refuses a branch a worktree still has out).
    if (fs.exists(folder)) {
      this.deps.log(`threads: thread ${state.rootId} worktree could not be removed`)
      return false
    }
    freed.bytes += bytes
    if (mode === 'force') {
      await git(['-C', agentFolder, 'branch', '-D', branch], agentFolder)
      return false
    }
    const own = saved === 'saved' ? 'own' : await this.branchWork(branch)
    if (own === 'none') await git(['-C', agentFolder, 'branch', '-D', branch], agentFolder)
    else if (own === 'own') keep(saved === 'saved' ? 'the uncommitted changes of its worktree were saved on it as a commit' : 'it holds commits that are in no other branch and were not pushed')
    return false
  }

  /**
   * Commit whatever a worktree holds uncommitted onto the thread's own branch,
   * so removing the checkout loses nothing. `clean`: nothing to save.
   * `failed`: it could not be read or committed, and the worktree must stay.
   */
  private async saveUncommitted(state: ThreadLaneState, folder: string): Promise<'clean' | 'saved' | 'failed'> {
    const { git } = this.deps
    const status = await git(['-C', folder, 'status', '--porcelain'], folder)
    if (!status.ok) return 'failed'
    if (status.stdout.trim() === '') return 'clean'
    const added = await git(['-C', folder, 'add', '-A'], folder)
    if (!added.ok) return 'failed'
    const message = `Uncommitted work of the thread "${state.title || state.rootId}", saved when the thread was closed`
    const commit = (identity: string[]) => git(['-C', folder, ...identity, 'commit', '--no-verify', '-q', '-m', message], folder)
    if ((await commit([])).ok) return 'saved'
    // No git identity on this computer: the daemon's own, for this one commit.
    return (await commit(['-c', 'user.name=HOAI', '-c', 'user.email=hoai@localhost'])).ok ? 'saved' : 'failed'
  }

  /**
   * What the thread's branch holds: `none` when its tip is also in another
   * branch or a remote (merged or pushed, or never committed to), `own` when
   * it is in none, `gone` when there is no such branch. Not known reads as
   * `own`: a branch is never deleted on a guess.
   */
  private async branchWork(branch: string): Promise<'none' | 'own' | 'gone'> {
    const { git, agentFolder } = this.deps
    const ref = `refs/heads/${branch}`
    const tip = await git(['-C', agentFolder, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], agentFolder)
    const sha = tip.stdout.trim()
    if (!tip.ok || sha === '') return 'gone'
    const holders = await git(['-C', agentFolder, 'for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads', 'refs/remotes'], agentFolder)
    if (!holders.ok) return 'own'
    const others = holders.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && l !== ref)
    return others.length > 0 ? 'none' : 'own'
  }

  /**
   * Every path the thread's forked session left on this computer, outermost
   * first and none inside another: its transcript and the folder beside it,
   * what the CLI keeps per session id (its environment, file history, tasks,
   * debug log, temp folder), this plugin's hook spool for it, and, for a
   * lane that ran in a folder of its own, that folder's whole project folder
   * and temp folder. Nothing keyed by the main session's id, and never the
   * agent folder's own project folder.
   */
  private sessionPaths(state: ThreadLaneState, folder: string | null): string[] {
    const { home, configDir, agentFolder } = this.deps
    const config = configDir.trim() || join(home, '.claude')
    const temps = (this.deps.tempRoots ?? []).filter((root) => root.trim() !== '')
    const pluginState = this.deps.pluginStateDir?.trim() || join(home, '.bgos-plugin-state')
    const projectOf = (cwd: string) => dirname(sessionTranscriptPath(home, cwd, '00000000-0000-4000-8000-000000000000', configDir))
    const agentProject = projectOf(agentFolder)
    const out: string[] = []
    // A folder of the thread's own: every session started in it was the thread's.
    const own = new Set<string>()
    if (folder !== null) {
      own.add(projectOf(folder))
      if (state.cwd && inside(resolve(state.cwd), folder)) own.add(projectOf(state.cwd))
    }
    for (const project of own) {
      if (project === agentProject) continue
      out.push(project)
      for (const root of temps) out.push(join(root, basename(project)))
    }
    const fork = state.forkSessionId
    if (fork && isSessionId(fork) && !this.isMainSession(fork)) {
      // Wherever the fork may have run: its saved folder, the agent's own (a full access thread, and a state
      // that lost its folder), and the thread's own folder. Each path is named by the fork's own id.
      const ran = [...new Set([state.cwd, agentFolder, ...(folder !== null ? [folder] : [])].filter((cwd) => cwd !== ''))]
      for (const cwd of ran) {
        const transcript = sessionTranscriptPath(home, cwd, fork, configDir)
        if (!transcript.endsWith(`${fork}.jsonl`)) continue
        out.push(transcript, transcript.slice(0, -'.jsonl'.length))
        for (const root of temps) out.push(join(root, basename(dirname(transcript)), fork))
      }
      for (const kind of ['session-env', 'file-history', 'tasks']) out.push(join(config, kind, fork))
      out.push(join(config, 'debug', `${fork}.txt`))
      out.push(join(pluginState, 'hooks', fork))
    }
    const sorted = [...new Set(out.map((p) => resolve(p)))].sort((a, b) => a.length - b.length)
    return sorted.filter((p, i) => !sorted.slice(0, i).some((parent) => inside(p, parent)))
  }

  private statePath(rootId: string): string {
    return join(this.deps.stateDir, `${rootId}.json`)
  }

  /** Every answer of this thread the server refused, oldest first. */
  private undeliveredPath(rootId: string): string {
    return join(this.deps.stateDir, `${rootId}.undelivered.txt`)
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
      access: r.access === 'full' ? 'full' : 'confined',
      tempCopy: typeof r.tempCopy === 'string' && r.tempCopy !== '' ? r.tempCopy : null,
      ...(r.kept === true ? { kept: true } : {}),
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
   * post went through. A 403 is not retried: onRefused runs at once. A 409 is
   * a thread the owner closed: the server says the answer is not kept, so it
   * settles like a landed post, with nothing more to tell.
   */
  private post(lane: Lane, path: string, body: Record<string, unknown>, onGiveUp?: () => void, onLanded?: () => void, onRefused?: () => void): void {
    lane.postsInFlight++
    lane.posts = lane.posts
      .then(() => this.postWithRetry(path, body))
      .then((outcome) => {
        // A give up queues its own posts first, so the count never dips to 0 between.
        if (outcome === 'landed' || outcome === 'closed') onLanded?.()
        else if (outcome === 'refused') onRefused?.()
        else onGiveUp?.()
      })
      .finally(() => {
        lane.postsInFlight--
      })
    this.track(lane.posts)
  }

  private async postWithRetry(path: string, body: Record<string, unknown>): Promise<'landed' | 'refused' | 'closed' | 'gave_up'> {
    const waits = this.deps.postRetryMs ?? THREAD_POST_RETRY_MS
    for (let attempt = 0; ; attempt++) {
      try {
        await this.deps.post(path, body)
        return 'landed'
      } catch (err) {
        const why = err instanceof Error ? err.name : 'error'
        if ((err as { status?: unknown } | null)?.status === 403) {
          this.deps.log(`threads: ${path} was refused (403), it is not tried again`)
          return 'refused'
        }
        if ((err as { status?: unknown } | null)?.status === 409) {
          this.deps.log(`threads: ${path} found the thread closed, it is not tried again`)
          return 'closed'
        }
        if (attempt >= waits.length) {
          this.deps.log(`threads: ${path} failed ${attempt + 1} times, giving up (${why})`)
          return 'gave_up'
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

/** An error's kind for the person (never its message: it can carry this machine's paths). */
function errorName(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) return code
    const name = (err as { name?: unknown }).name
    if (typeof name === 'string' && name !== '') return name
  }
  return 'error'
}

/** An error for this machine's own log: its kind and its message, on one line. */
function describeError(err: unknown): string {
  if (err instanceof ThreadLaneError) return err.code
  const message = err instanceof Error ? err.message : String(err)
  return `${errorName(err)}: ${message.replace(/\s+/g, ' ').slice(0, 300)}`
}

/** A result frame for this machine's own log: its shape, never what it says. */
function describeResult(frame: Record<string, unknown>, raw: string): string {
  const subtype = typeof frame.subtype === 'string' && /^[a-z_]{1,40}$/.test(frame.subtype) ? frame.subtype : 'unknown'
  const turns = typeof frame.num_turns === 'number' && Number.isFinite(frame.num_turns) ? String(frame.num_turns) : 'unknown'
  return `subtype ${subtype}, is_error ${frame.is_error === true}, num_turns ${turns}, ${raw.length} characters`
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
}

/** `child` is `parent` or lies under it (both absolute, resolved). */
function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

function validateTurn(input: ThreadTurnInput): void {
  if (!input || typeof input !== 'object') throw new ThreadLaneError('bad_request', 'The thread turn is missing.')
  if (typeof input.rootId !== 'string' || !ROOT_ID_RE.test(input.rootId)) {
    throw new ThreadLaneError('bad_request', 'The thread id is not valid.')
  }
  if (typeof input.chatId !== 'string' || input.chatId === '') throw new ThreadLaneError('bad_request', 'The chat id is missing.')
  if (!MODES.includes(input.mode)) throw new ThreadLaneError('bad_request', 'The thread turn mode is not valid.')
}
