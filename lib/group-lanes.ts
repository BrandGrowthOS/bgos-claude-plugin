/**
 * Group threads on Claude Code (the server's group threads contract).
 *
 * A group (a room) the agent sits in runs as the agent's OWN session for that
 * group, so group traffic never waits behind or interrupts the owner's main
 * session, and the owner's private context never enters the group.
 *
 *  - Key: `group:<chatId>`, the lane stamp the server puts on every delivery
 *    of that group's messages to this agent. One manager serves one agent.
 *  - Folder: `<laneRoot>/<chatId>`, outside the home folder and the agent
 *    folder. Below Full a lane is fenced (lib/group-lane-args.ts): every
 *    Bash, Read, Grep, Glob, Edit and Write call goes to the gate, and the
 *    home folder, the agent folder, ~/.bgos-agent and the CLI config dir are
 *    refused outright (and to Bash by the CLI sandbox where the host has one).
 *  - Session: FRESH on the first start (`--session-id <new uuid>`, never a
 *    fork, never the main session), seeded with a group brief built from the
 *    delivery (title, the owner's note, the last pause summary, roster,
 *    backlog, the message; about 12,000 characters at most). Every later
 *    start resumes it by id: the id this lane saw, or the server's
 *    `groupThread.sessionId` after a daemon restart, a week later too.
 *  - Turns for one group are serialized (one chain of operations per lane).
 *  - Slots: at most 3 live group lanes, counted apart from the thread lanes.
 *    A 4th group's wake PAUSES the longest idle lane and takes its slot.
 *  - Idle for the group's "Pause after idle" (`groupThread.idlePauseMinutes`:
 *    15, 30 or 60, else 30) PAUSES the lane, never closes it: a summary turn (at
 *    most 6 lines, with its "Needs you" items), the process stopped, the
 *    session kept, and `state: paused` posted with the summary. The summary
 *    is also handed to onPaused, which queues it for the main session's next
 *    turn (lib/group-summary-queue.ts).
 *  - Context: past about 150,000 tokens the session compacts itself in place
 *    (`/compact` as its next user message); it is never closed and reopened.
 *  - `group_thread_end` (owner ended, left, removed, group deleted) stops the
 *    lane, forgets its session and posts `state: closed`. A 409
 *    `group_thread_closed` from the state route means the server closed it:
 *    the session is forgotten here too.
 *  - Replies go to the group through the injected reply (the normal send
 *    path, with the delivery's session handle), never the owner's main chat.
 *  - A daemon crash leaves a lane finishing its turn: its pid and start stamp
 *    are in the lane state (lib/lane-process.ts), so the next start, resume or
 *    end stops it first and waits for it to exit. Never two processes on one
 *    group session.
 *  - The server's `state: new` drops the local session only when the server
 *    ACCEPTED a live or paused report for it (`acked`); a session it never
 *    heard of is kept, resumed, and reported live again.
 *  - The level (talk, approvals, full) is enforced by the command
 *    (lib/group-lane-args.ts) and by the injected approve, which the CLI asks
 *    for every permission prompt over stdio.
 *
 * Every effect is an injected dependency, so the whole manager is unit tested
 * with fakes (test/group-lanes.test.ts). Erasable TypeScript only.
 */

import { join } from 'node:path'

import {
  clipGroupReply,
  contextTokensOf,
  framedCarriesBacklog,
  withoutBacklogRepeats,
  GROUP_COMPACT_COMMAND,
  GROUP_SUMMARY_FALLBACK,
  GROUP_SUMMARY_INSTRUCTION,
  groupLaneArgs,
  groupIdlePauseMs,
  groupLevel,
  groupSeedBrief,
  stricterLevel,
  groupTurnText,
  isGroupChatId,
  isGroupSilent,
  parseGroupSummary,
  toolInputPreview,
  type GroupBacklogLine,
  type GroupEarlierMessage,
  type GroupLevel,
  type GroupRosterEntry,
} from './group-lane-args.ts'
import { isSessionId } from './thread-lane-args.ts'
import { lineSplitter, userMessageLine, type SpawnStreamJson, type StreamJsonChild } from './stream-json-child.ts'
import { THREAD_ORPHAN_POLL_MS } from './thread-lanes.ts'
import { GROUP_LANE_ENV } from './private-turn.mjs'

export const GROUP_LANE_MAX_LIVE = 3
export const GROUP_LANE_IDLE_MS = 30 * 60_000
export const GROUP_LANE_KILL_GRACE_MS = 10_000
/** A turn with no result after this long is failed and its lane stopped (an approval card may wait 30 minutes). */
export const GROUP_TURN_TIMEOUT_MS = 45 * 60_000
/** The summary turn of a pause, and a compaction, get this long. */
export const GROUP_SUMMARY_TIMEOUT_MS = 5 * 60_000
export const GROUP_COMPACT_TIMEOUT_MS = 10 * 60_000
/** Past this many tokens of context the session compacts in place. */
export const GROUP_CONTEXT_BUDGET_TOKENS = 150_000
/** The waits between attempts of a state post (so 4 attempts in all). */
export const GROUP_POST_RETRY_MS: readonly number[] = Object.freeze([2_000, 10_000, 30_000])
/** Message ids remembered for the dedupe across transports. */
export const GROUP_SEEN_MAX = 2_000

export const GROUP_STATE_PATH = 'integrations/group-threads/state'

/** True for the state route's 409 `group_thread_closed`: the server closed the thread. */
export function isGroupThreadClosed(err: unknown): boolean {
  const e = err as { status?: unknown; body?: unknown; message?: unknown } | null
  if (!e || e.status !== 409) return false
  return [e.body, e.message].some((v) => typeof v === 'string' && v.includes('group_thread_closed'))
}

function isClientError(err: unknown): boolean {
  const s = (err as { status?: unknown } | null)?.status
  return typeof s === 'number' && s >= 400 && s < 500
}

/** One delivery of a group message (or a tap) for this agent, read off any transport. */
export interface GroupDelivery {
  chatId: string
  /** The dedupe key across transports: the message id (a tap adds its own suffix). */
  key: string
  /** The message id, when numeric: the first and last message of the stretch. */
  messageId: number | null
  text: string
  sender: string | null
  sessionHandle: string | null
  title: string
  /** The level this delivery states, or null: it states none, and the lane keeps its own. */
  level: GroupLevel | null
  note: string | null
  summary: string | null
  /** The thread's session id the server last heard, or null. */
  sessionId: string | null
  state: 'new' | 'live' | 'paused'
  frame: string | null
  /** The owner's "Pause after idle" for this group (15, 30 or 60), or null. */
  idlePauseMinutes: number | null
  roster: GroupRosterEntry[]
  agents: string[]
  backlog: GroupBacklogLine[]
  /** Group messages the lane never had as turns, oldest first (shown before the message as data). */
  earlier?: GroupEarlierMessage[]
}

export interface GroupApproval {
  allow: boolean
  message?: string
}

export interface GroupLaneFs {
  exists(path: string): boolean
  mkdir(path: string): void
  readFile(path: string): string
  writeFile(path: string, data: string): void
  appendFile(path: string, data: string): void
  unlink(path: string): void
}

export interface GroupLaneDeps {
  assistantId: string
  spawn: SpawnStreamJson
  claudeBin(): string | null
  /** Why this claude cannot run a lane, as a plain sentence, or null. */
  cliProblem?(): string | null | Promise<string | null>
  /** The owner's main session: a group lane never runs on it. */
  mainSessionId(): string | null
  /** A new random UUID for a fresh group session. */
  newSessionId(): string
  agentFolder: string
  /**
   * The machine's processes (lib/lane-process.ts), as thread lanes use them:
   * a process's start stamp while it is alive, and a signal to its group.
   */
  processes: {
    /** Start stamp while alive, null if gone, undefined if inspection failed. */
    stamp(pid: number): Promise<string | null | undefined>
    /** True if in this folder, false if absent or elsewhere, null if inspection failed. */
    runsIn(pid: number, dir: string): Promise<boolean | null>
    kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void
  }
  /**
   * The folder the lanes work in, one subfolder per group: OUTSIDE the home
   * folder, private to this user (server.ts makes it 0700 and checks its
   * owner; it throws when it cannot, and the lane then starts nothing).
   */
  laneRoot(): string
  /** Where a lane below Full may never reach (lib/group-lane-args.ts GroupLaneFence), less the lane's own folder. */
  fence(): { home: string; configDir: string; stateRoot: string; sandbox: boolean }
  /** Where lane state files live, ~/.bgos-agent/<assistantId>/groups. */
  stateDir: string
  emptyMcpConfigPath(): string
  fs: GroupLaneFs
  /** POST to BGOS (the state route). Throws an error carrying `status` on a refusal. */
  post(path: string, body: Record<string, unknown>): Promise<unknown>
  /** Post the lane's answer in the group through the normal reply path. */
  reply(input: { chatId: string; text: string; sessionHandle: string | null }): Promise<unknown>
  /** Answer one permission prompt of a lane, by its level (the owner's approval card, or the owner's own gate). */
  approve(input: { chatId: string; title: string; level: GroupLevel; toolName: string; input: unknown; inputPreview: string; description: string }): Promise<GroupApproval>
  /** A pause summary, for the main session's next turn. */
  onPaused?(input: { chatId: string; title: string; summary: string; needsYou: string[] }): void
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  log(msg: string): void
  platform?: NodeJS.Platform
  maxLive?: number
  /** TEST ONLY (HOAI_GROUP_LANE_IDLE_MS, lib/group-lane-args.ts groupIdleOverrideMs): wins over every group's own idle pause. */
  idleOverrideMs?: number | null
  killGraceMs?: number
  turnTimeoutMs?: number
  summaryTimeoutMs?: number
  compactTimeoutMs?: number
  contextBudgetTokens?: number
  postRetryMs?: readonly number[]
}

/** What a lane keeps on disk, one JSON file per group. */
export interface GroupLaneState {
  chatId: string
  title: string
  sessionId: string | null
  /** The session has had a turn (its transcript exists): later starts resume it. */
  started: boolean
  firstMessageId: number | null
  lastMessageId: number | null
  /** The server answered 2xx to a live or paused report for this session: it knows it. */
  acked: boolean
  /**
   * The lane's process while it runs, and its start stamp: a daemon that
   * crashed leaves it finishing its turn, and the next start stops it first.
   */
  pid: number | null
  pidStamp: string | null
}

type Waited = Record<string, unknown> | 'timeout' | null

interface Lane {
  chatId: string
  st: GroupLaneState
  loaded: boolean
  level: GroupLevel
  /** The level the running process was started with. */
  childLevel: GroupLevel
  /** This group's idle pause (the owner's "Pause after idle"), from its latest delivery. */
  idleMs: number
  sessionHandle: string | null
  child: StreamJsonChild | null
  exited: Promise<void>
  stopping: boolean
  graceTimer: unknown
  idleTimer: unknown
  chain: Promise<void>
  pendingOps: number
  busy: boolean
  pausing: boolean
  hasSlot: boolean
  lastActive: number
  contextTokens: number
  waiter: ((frame: Waited) => void) | null
  closed: boolean
  /** The server answered 409 group_thread_closed: the session goes once the current step ends. */
  serverClosed: boolean
}

export class GroupLaneManager {
  private readonly deps: GroupLaneDeps
  private readonly lanes = new Map<string, Lane>()
  private readonly ending = new Map<string, Promise<void>>()
  private readonly seen = new Set<string>()
  private slotWaiters: Array<() => void> = []
  private readonly work = new Set<Promise<unknown>>()

  constructor(deps: GroupLaneDeps) {
    this.deps = deps
  }

  private get maxLive(): number {
    return this.deps.maxLive ?? GROUP_LANE_MAX_LIVE
  }

  /** Group lane processes alive right now. */
  liveChildren(): number {
    let n = 0
    for (const lane of this.lanes.values()) if (lane.child) n++
    return n
  }

  /** Slots in use (a lane holding a live process or starting one). */
  slotsUsed(): number {
    let n = 0
    for (const lane of this.lanes.values()) if (lane.hasSlot) n++
    return n
  }

  /** Work a restart would cut off: a turn, a pause or an end running or queued, and posts in flight. */
  activeWork(): number {
    let n = this.work.size
    for (const lane of this.lanes.values()) n += lane.pendingOps
    return n
  }

  /** Resolves once every background step has settled. */
  async idle(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work])
  }

  /** The session id a group's lane holds, or null (for the owner's diagnostics and tests). */
  sessionOf(chatId: string): string | null {
    const lane = this.lanes.get(chatId)
    if (lane?.loaded) return lane.st.sessionId
    return this.load(chatId)?.sessionId ?? null
  }

  /**
   * Take one delivery for a group. Answers at once: false for a delivery this
   * manager already took (the poll and the stream repeat the socket), true
   * when it was queued. The turn runs in the background; its answer is posted
   * in the group.
   */
  deliver(d: GroupDelivery): boolean {
    if (!d || !isGroupChatId(d.chatId)) return false
    if (!this.claim(d.chatId, d.key)) return false
    this.queue(d, [])
    return true
  }

  /**
   * The backlog rows of one poll read of a group (review finding 6): ONE
   * turn, never one per row. Rows the lane already took (the socket or the
   * stream handed them over) are dropped; the newest row left is the
   * message and the others ride before it as earlier messages. False when
   * nothing is left.
   */
  deliverBatch(rows: readonly GroupDelivery[]): boolean {
    const chatId = rows[0]?.chatId ?? ''
    if (!isGroupChatId(chatId)) return false
    const kept = rows.filter((d) => d && d.chatId === chatId && this.claim(chatId, d.key))
    const last = kept.at(-1)
    if (!last) return false
    const earlier: GroupEarlierMessage[] = kept.slice(0, -1).map((d) => ({ messageId: d.messageId, sender: d.sender, text: d.text, sentAt: null }))
    this.queue(last, earlier)
    return true
  }

  /** Claim a delivery key for a group: false when it was taken already. */
  private claim(chatId: string, key: string): boolean {
    if (key === '') return true
    const full = `${chatId}:${key}`
    if (this.seen.has(full)) return false
    this.seen.add(full)
    while (this.seen.size > GROUP_SEEN_MAX) this.seen.delete(this.seen.values().next().value as string)
    return true
  }

  private queue(input: GroupDelivery, rows: GroupEarlierMessage[]): void {
    // Earlier messages the server sent are dropped when the lane already had them.
    const sent = (input.earlier ?? []).filter((m) => m.messageId === null || this.claim(input.chatId, String(m.messageId)))
    const earlier = [...sent, ...rows].sort((a, b) => (a.messageId ?? 0) - (b.messageId ?? 0))
    const d: GroupDelivery = { ...input, earlier }
    const lane = this.laneFor(d.chatId)
    // The level applies AT ONCE (review finding 4): a lowered level must not
    // wait behind a turn still running under the old one. The gate answers by
    // the stricter of this and the level the process started with.
    // A delivery that states no level keeps the lane's (talk for a new lane): review finding 5.
    if (d.level !== null) lane.level = groupLevel(d.level)
    // Lowered below the running process (finding C): its turn stops NOW, so
    // nothing the CLI would allow by itself keeps running under the old
    // level; the queued turn then resumes the session under the new one.
    if (lane.child && !lane.stopping && lane.level !== lane.childLevel && stricterLevel(lane.level, lane.childLevel) === lane.level) {
      this.deps.log(`groups: group ${lane.chatId} level lowered to ${lane.level}, its running turn is stopped`)
      this.stopChild(lane)
    }
    if (d.sessionHandle) lane.sessionHandle = d.sessionHandle
    void this.enqueue(lane, () => this.runTurn(lane, d))
  }

  /** True when this manager already took the delivery (a transport repeating it). */
  hasSeen(chatId: string, key: string): boolean {
    return this.seen.has(`${chatId}:${key}`)
  }

  /**
   * The server's `group_thread_end`: stop the lane, forget its session, post
   * `state: closed`, and answer `{ ok: true }`.
   */
  async end(input: { chatId: string; reason?: string }): Promise<{ ok: true; summary?: string }> {
    const chatId = String(input?.chatId ?? '')
    if (!isGroupChatId(chatId)) throw new GroupLaneError('bad_request', 'Ending a group thread needs its chat.')
    while (this.ending.has(chatId)) await this.ending.get(chatId)
    const lane = this.lanes.get(chatId)
    const done = (async () => {
      let sessionId: string | null = null
      if (lane) {
        lane.closed = true
        this.clearIdle(lane)
        // A turn waiting for a slot sees the close; one in flight ends now:
        // its process stops and its wait answers null.
        this.wakeSlotWaiters()
        this.stopChild(lane)
        await lane.chain
        // A start that was already past its last check stops too.
        this.stopChild(lane)
        await lane.exited
        if (!lane.loaded) {
          const saved = this.load(chatId)
          if (saved) lane.st = saved
        }
        // Its process from before a daemon crash stops too.
        if (!(await this.stopOrphan(lane.st))) this.deps.log(`groups: group ${chatId} has a process from before a restart that would not stop`)
        sessionId = lane.st.sessionId
        if (this.lanes.get(chatId) === lane) this.lanes.delete(chatId)
        this.releaseSlot(lane)
      } else {
        const saved = this.load(chatId)
        if (saved && !(await this.stopOrphan(saved))) this.deps.log(`groups: group ${chatId} has a process from before a restart that would not stop`)
        sessionId = saved?.sessionId ?? null
      }
      this.forget(chatId)
      this.deps.log(`groups: group ${chatId} thread ended (${String(input?.reason ?? 'unknown')})`)
      this.postState({ chatId, state: 'closed', sessionId }, null)
    })()
    this.ending.set(chatId, done)
    this.track(done)
    try {
      await done
    } finally {
      if (this.ending.get(chatId) === done) this.ending.delete(chatId)
    }
    return { ok: true }
  }

  /** Daemon shutdown: SIGTERM to every lane, resolved once they have exited. Sessions are kept. */
  stopAll(): Promise<void> {
    const exits: Array<Promise<void>> = []
    for (const lane of this.lanes.values()) {
      this.clearIdle(lane)
      if (lane.child) {
        lane.stopping = true
        lane.child.kill('SIGTERM')
        exits.push(lane.exited)
      }
    }
    return Promise.all(exits).then(() => undefined)
  }

  killAll(): void {
    for (const lane of this.lanes.values()) lane.child?.kill('SIGKILL')
  }

  // -- internals --------------------------------------------------------------

  private laneFor(chatId: string): Lane {
    const existing = this.lanes.get(chatId)
    if (existing && !existing.closed) return existing
    const lane: Lane = {
      chatId,
      st: { chatId, title: '', sessionId: null, started: false, firstMessageId: null, lastMessageId: null, acked: false, pid: null, pidStamp: null },
      loaded: false,
      // Until a delivery states one, a new lane can only reply (review finding 5).
      level: 'talk',
      childLevel: 'talk',
      idleMs: GROUP_LANE_IDLE_MS,
      sessionHandle: null,
      child: null,
      exited: Promise.resolve(),
      stopping: false,
      graceTimer: null,
      idleTimer: null,
      chain: Promise.resolve(),
      pendingOps: 0,
      busy: false,
      pausing: false,
      hasSlot: false,
      lastActive: this.deps.now(),
      contextTokens: 0,
      waiter: null,
      closed: false,
      serverClosed: false,
    }
    this.lanes.set(chatId, lane)
    return lane
  }

  private enqueue(lane: Lane, fn: () => Promise<void>): Promise<void> {
    lane.pendingOps++
    this.clearIdle(lane)
    const run = lane.chain.then(async () => {
      lane.busy = true
      this.clearIdle(lane)
      try {
        // An end of this group still settling owns its state file first.
        const ending = this.ending.get(lane.chatId)
        if (ending && !lane.closed) await ending
        if (!lane.loaded) {
          const saved = this.load(lane.chatId)
          if (saved) lane.st = saved
          lane.loaded = true
        }
        if (!lane.closed) await fn()
      } catch (err) {
        this.deps.log(`groups: group ${lane.chatId} step failed (${err instanceof Error ? err.message : 'error'})`)
      } finally {
        lane.busy = false
        lane.pendingOps--
        lane.lastActive = this.deps.now()
        await this.afterOp(lane)
      }
    })
    lane.chain = run.catch(() => {})
    this.track(run)
    return run
  }

  private async afterOp(lane: Lane): Promise<void> {
    // A lane with no process never keeps a slot past its step.
    if (!lane.child && lane.hasSlot) this.releaseSlot(lane)
    if (lane.closed) return
    if (lane.serverClosed && !lane.closed) {
      // The server closed this thread: the next wake starts a new session.
      lane.serverClosed = false
      this.stopChild(lane)
      await lane.exited
      lane.st.sessionId = null
      lane.st.started = false
      lane.st.acked = false
      lane.st.firstMessageId = null
      lane.st.lastMessageId = null
      this.forget(lane.chatId)
      return
    }
    if (lane.pendingOps === 0 && lane.child && !lane.closed && !lane.stopping) this.armIdle(lane)
  }

  private async runTurn(lane: Lane, d: GroupDelivery): Promise<void> {
    if (d.title) lane.st.title = d.title
    // The server's word on the session (restart, or a thread it closed).
    if (!lane.child) {
      if (d.state === 'new' && lane.st.sessionId !== null && d.sessionId === null) {
        if (lane.st.acked) {
          // The server knew this session and now has none: it closed the
          // thread since this lane last ran, so the next start is a new one.
          lane.st.sessionId = null
          lane.st.started = false
          lane.st.acked = false
          lane.st.firstMessageId = null
          lane.st.lastMessageId = null
        }
        // Never acknowledged (a live report that never landed): the server
        // cannot have closed what it never heard of, so the session is kept,
        // resumed, and reported live again below.
      } else if (lane.st.sessionId === null && isSessionId(d.sessionId)) {
        lane.st.sessionId = d.sessionId
        lane.st.started = true
        lane.st.acked = true
      }
    }
    lane.idleMs = groupIdlePauseMs(d.idlePauseMinutes)
    // The owner changed the level (deliver() set it, from the newest
    // delivery): the running process was started with the old one, so it
    // stops first and the session resumes under the new one.
    if (lane.child && lane.childLevel !== lane.level) {
      this.deps.log(`groups: group ${lane.chatId} level is now ${lane.level}, its lane restarts under it`)
      this.stopChild(lane)
      await lane.exited
    }
    await this.acquireSlot(lane)
    if (lane.closed) return
    await this.ensureChild(lane)
    if (lane.closed || !lane.child) return
    const seed = !lane.st.started
    // Each group message once per turn: a held or backlog row the turn already
    // shows (the seed's recent messages, or the server's framed backlog) is
    // left out of the earlier messages.
    const shown = seed || framedCarriesBacklog(d.text)
    const turn: GroupDelivery = shown ? { ...d, earlier: withoutBacklogRepeats(d.earlier ?? [], d.backlog) } : d
    const prompt = seed ? groupSeedBrief({ ...turn, level: lane.level }) : groupTurnText(turn)
    const sessionId = lane.st.sessionId!
    lane.st.started = true
    if (d.messageId !== null) {
      if (lane.st.firstMessageId === null) lane.st.firstMessageId = d.messageId
      lane.st.lastMessageId = d.messageId
    }
    this.persist(lane)
    this.postState({ chatId: lane.chatId, state: 'live', sessionId }, lane)
    const frame = await this.ask(lane, prompt, this.deps.turnTimeoutMs ?? GROUP_TURN_TIMEOUT_MS)
    if (frame === 'timeout') {
      this.deps.log(`groups: a turn in group ${lane.chatId} timed out, its lane is stopped`)
      this.stopChild(lane)
      await lane.exited
      return
    }
    if (frame === null) {
      if (!lane.closed) this.deps.log(`groups: a turn in group ${lane.chatId} ended without an answer`)
      return
    }
    const raw = typeof frame.result === 'string' ? frame.result : ''
    const failed = frame.is_error === true || (frame.subtype !== undefined && frame.subtype !== 'success')
    if (failed) {
      this.deps.log(`groups: a turn in group ${lane.chatId} failed (${String(frame.subtype ?? 'error')})`)
    } else if (!isGroupSilent(raw) && !lane.closed) {
      try {
        await this.deps.reply({ chatId: lane.chatId, text: clipGroupReply(raw.trim()), sessionHandle: lane.sessionHandle })
      } catch (err) {
        this.deps.log(`groups: the reply in group ${lane.chatId} could not be posted (${err instanceof Error ? err.name : 'error'})`)
      }
    }
    if (!lane.closed && lane.child && lane.contextTokens >= (this.deps.contextBudgetTokens ?? GROUP_CONTEXT_BUDGET_TOKENS)) {
      await this.compact(lane)
    }
  }

  /** Compact the lane's own session in place: `/compact` as its next user message. */
  private async compact(lane: Lane): Promise<void> {
    this.deps.log(`groups: group ${lane.chatId} passed its context budget (${lane.contextTokens} tokens), compacting in its own session`)
    const frame = await this.ask(lane, GROUP_COMPACT_COMMAND, this.deps.compactTimeoutMs ?? GROUP_COMPACT_TIMEOUT_MS)
    if (frame === 'timeout') {
      this.stopChild(lane)
      await lane.exited
      return
    }
    lane.contextTokens = 0
  }

  /** Pause: a summary turn, the process stopped, the session kept, `state: paused` posted. */
  private async pauseNow(lane: Lane, why: 'idle' | 'slot'): Promise<void> {
    lane.pausing = false
    if (lane.closed || !lane.child) return
    const sessionId = lane.st.sessionId
    let summary = GROUP_SUMMARY_FALLBACK
    let needsYou: string[] = []
    const frame = await this.ask(lane, GROUP_SUMMARY_INSTRUCTION, this.deps.summaryTimeoutMs ?? GROUP_SUMMARY_TIMEOUT_MS)
    if (frame && frame !== 'timeout' && frame.is_error !== true && (frame.subtype === undefined || frame.subtype === 'success')) {
      const parsed = parseGroupSummary(typeof frame.result === 'string' ? frame.result : '')
      if (parsed.summary.trim() !== '') {
        summary = parsed.summary
        needsYou = parsed.needsYou
      }
    }
    this.stopChild(lane)
    await lane.exited
    if (lane.closed) return
    this.deps.log(`groups: group ${lane.chatId} paused (${why}), its session is kept`)
    const body = {
      chatId: lane.chatId,
      state: 'paused' as const,
      sessionId,
      summary,
      needsYou,
      firstMessageId: lane.st.firstMessageId,
      lastMessageId: lane.st.lastMessageId,
    }
    lane.st.firstMessageId = null
    lane.st.lastMessageId = null
    this.persist(lane)
    this.postState(body, lane)
    this.deps.onPaused?.({ chatId: lane.chatId, title: lane.st.title, summary, needsYou })
  }

  /** Write one user message and wait for its result frame, the timeout, or the process's end (null). */
  private ask(lane: Lane, text: string, ms: number): Promise<Waited> {
    const child = lane.child
    if (!child || lane.stopping) return Promise.resolve(null)
    return new Promise<Waited>((done) => {
      let timer: unknown = null
      const finish = (frame: Waited): void => {
        if (lane.waiter !== finish) return
        lane.waiter = null
        if (timer !== null) this.deps.clearTimer(timer)
        done(frame)
      }
      lane.waiter = finish
      timer = this.deps.setTimer(() => {
        timer = null
        finish('timeout')
      }, ms)
      child.write(userMessageLine(text))
    })
  }

  private async acquireSlot(lane: Lane): Promise<void> {
    while (!lane.hasSlot) {
      if (lane.closed) return
      if (this.slotsUsed() < this.maxLive) {
        lane.hasSlot = true
        return
      }
      const victim = this.longestIdle(lane)
      if (victim) {
        victim.pausing = true
        await this.enqueue(victim, () => this.pauseNow(victim, 'slot'))
        continue
      }
      await new Promise<void>((wake) => this.slotWaiters.push(wake))
    }
  }

  /** The lane holding a slot that has been idle longest, or null when every slot is busy. */
  private longestIdle(except: Lane): Lane | null {
    let oldest: Lane | null = null
    for (const lane of this.lanes.values()) {
      if (lane === except || !lane.hasSlot || !lane.child || lane.busy || lane.pendingOps > 0 || lane.pausing || lane.stopping) continue
      if (!oldest || lane.lastActive < oldest.lastActive) oldest = lane
    }
    return oldest
  }

  private releaseSlot(lane: Lane): void {
    if (!lane.hasSlot) return
    lane.hasSlot = false
    this.wakeSlotWaiters()
  }

  private wakeSlotWaiters(): void {
    const waiters = this.slotWaiters
    this.slotWaiters = []
    for (const wake of waiters) wake()
  }

  private async ensureChild(lane: Lane): Promise<void> {
    if (lane.child && lane.stopping) await lane.exited
    if (lane.closed || lane.child) return
    try {
      const claude = this.deps.claudeBin()
      if (!claude) throw new GroupLaneError('unavailable', 'this computer cannot run Claude Code right now')
      const problem = this.deps.cliProblem ? await this.deps.cliProblem() : null
      if (problem) throw new GroupLaneError('unsupported', problem)
      if (lane.closed) return
      // A process left from before a daemon crash still runs this session: never a second one.
      if (!(await this.stopOrphan(lane.st))) {
        throw new GroupLaneError('busy', 'an earlier run of this group thread is still stopping')
      }
      if (lane.closed || lane.child) return
      const folder = await this.prepareFolder(lane.chatId)
      let resume = lane.st.started && isSessionId(lane.st.sessionId)
      if (!isSessionId(lane.st.sessionId)) {
        lane.st.sessionId = this.deps.newSessionId()
        lane.st.started = false
        lane.st.acked = false
        resume = false
      }
      const args = groupLaneArgs({
        sessionId: lane.st.sessionId!,
        resume,
        level: lane.level,
        emptyMcpConfigPath: this.deps.emptyMcpConfigPath(),
        agentFolder: this.deps.agentFolder,
        mainSessionId: this.deps.mainSessionId(),
        platform: this.deps.platform,
        fence: { ...this.deps.fence(), laneFolder: folder },
      })
      this.persist(lane)
      // The private turn hook reads this: a group lane has no private tools and no daemon of its own to attach to.
      const child = this.deps.spawn(claude, args, { cwd: folder, env: { [GROUP_LANE_ENV]: lane.chatId } })
      lane.child = child
      lane.childLevel = lane.level
      lane.stopping = false
      lane.contextTokens = 0
      this.recordPid(lane, child)
      lane.exited = new Promise<void>((done) => {
        child.onExit(() => {
          this.onExit(lane, child)
          done()
        })
      })
      child.onStdout(lineSplitter((frame) => this.onFrame(lane, child, frame)))
    } catch (err) {
      this.releaseSlot(lane)
      throw err
    }
  }

  private onFrame(lane: Lane, child: StreamJsonChild, frame: Record<string, unknown>): void {
    if (lane.child !== child) return
    if (frame.type === 'system' && frame.subtype === 'init') {
      // A stamp that could not be read at spawn is asked for again.
      if (lane.st.pidStamp === null) this.readStamp(lane, child)
      return
    }
    if (frame.type === 'assistant') {
      const tokens = contextTokensOf(frame)
      if (tokens !== null) lane.contextTokens = tokens
      return
    }
    if (frame.type === 'control_request') {
      this.onControlRequest(lane, child, frame)
      return
    }
    if (frame.type === 'result') lane.waiter?.(frame)
  }

  /** A permission prompt of the lane (`--permission-prompt-tool stdio`): answered by its level. */
  private onControlRequest(lane: Lane, child: StreamJsonChild, frame: Record<string, unknown>): void {
    const requestId = typeof frame.request_id === 'string' ? frame.request_id : ''
    const request = (frame.request && typeof frame.request === 'object' ? frame.request : {}) as Record<string, unknown>
    if (!requestId) return
    if (request.subtype !== 'can_use_tool') {
      child.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'not supported by this host' } })}\n`)
      return
    }
    const toolName = typeof request.tool_name === 'string' ? request.tool_name : 'a tool'
    const input = request.input ?? {}
    const answer = (verdict: GroupApproval): void => {
      if (lane.child !== child) return
      const response = verdict.allow
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: verdict.message ?? 'Your owner did not allow this in the group.' }
      child.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })}\n`)
    }
    const level = stricterLevel(lane.level, lane.childLevel)
    if (level === 'talk') {
      answer({ allow: false, message: 'In this group you can only reply.' })
      return
    }
    const description = typeof request.description === 'string' && request.description
      ? request.description
      : `${toolName} in the group "${lane.st.title || lane.chatId}"`
    this.track(
      this.deps
        .approve({ chatId: lane.chatId, title: lane.st.title, level, toolName, input, inputPreview: toolInputPreview(input), description })
        .then(answer, () => answer({ allow: false, message: 'The approval could not be asked, so this was not done.' })),
    )
  }

  private onExit(lane: Lane, child: StreamJsonChild): void {
    if (lane.child !== child) return
    lane.child = null
    lane.stopping = false
    if (lane.st.pid !== null && lane.st.pid === child.pid) {
      lane.st.pid = null
      lane.st.pidStamp = null
      if (this.lanes.get(lane.chatId) === lane) this.persist(lane)
    }
    if (lane.graceTimer !== null) {
      this.deps.clearTimer(lane.graceTimer)
      lane.graceTimer = null
    }
    this.clearIdle(lane)
    lane.waiter?.(null)
    this.releaseSlot(lane)
  }

  /** The pid goes into the lane state at once, and its start stamp as soon as it can be read. */
  private recordPid(lane: Lane, child: StreamJsonChild): void {
    const pid = child.pid
    if (typeof pid !== 'number') return
    lane.st.pid = pid
    lane.st.pidStamp = null
    this.persist(lane)
    this.readStamp(lane, child)
  }

  private readStamp(lane: Lane, child: StreamJsonChild): void {
    const pid = child.pid
    if (typeof pid !== 'number' || lane.st.pid !== pid || lane.st.pidStamp !== null) return
    this.track(
      this.deps.processes.stamp(pid).then((stamp) => {
        if (typeof stamp !== 'string' || lane.child !== child || lane.st.pid !== pid || lane.st.pidStamp !== null) return
        lane.st.pidStamp = stamp
        this.persist(lane)
      }),
    )
  }

  /**
   * Stop the process a lane state names if it still runs under the same start
   * stamp (a daemon crash left it finishing its turn): SIGTERM to its group,
   * SIGKILL after the grace, and true once it is gone. A pid now held by
   * another process is never signalled. False when it would not stop, or its
   * identity cannot be verified while something may still use the folder.
   * The thread lanes' rule, lib/thread-lanes.ts stopOrphan.
   */
  private async stopOrphan(st: GroupLaneState): Promise<boolean> {
    const { pid, pidStamp } = st
    if (pid === null) return true
    const procs = this.deps.processes
    let cwd = ''
    try {
      cwd = this.laneFolder(st.chatId)
    } catch {}
    if (pidStamp === null && (cwd === '' || (await procs.runsIn(pid, cwd)) !== false)) {
      this.deps.log(`groups: group ${st.chatId} has an unverified process that may still use its folder; waiting for it to exit`)
      return false
    }
    const alive = async (): Promise<boolean | null> => {
      if (pidStamp === null) return false
      const stamp = await procs.stamp(pid)
      return stamp === undefined ? null : stamp === pidStamp
    }
    const inspected = await alive()
    if (inspected === null) {
      this.deps.log(`groups: group ${st.chatId} has an unreadable process stamp; waiting for verified identity or exit`)
      return false
    }
    if (inspected) {
      this.deps.log(`groups: group ${st.chatId} still runs from before a restart, it is stopped first`)
      const grace = this.deps.killGraceMs ?? GROUP_LANE_KILL_GRACE_MS
      procs.kill(pid, 'SIGTERM')
      if (!(await this.gone(alive, grace))) {
        const current = await alive()
        if (current === null) return false
        if (current) {
          procs.kill(pid, 'SIGKILL')
          if (!(await this.gone(alive, grace))) {
            this.deps.log(`groups: group ${st.chatId} from before a restart would not stop`)
            return false
          }
        }
      }
    }
    if (st.pid === pid) {
      st.pid = null
      st.pidStamp = null
      this.persistState(st)
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

  private stopChild(lane: Lane): void {
    const child = lane.child
    if (!child || lane.stopping) return
    lane.stopping = true
    child.kill('SIGTERM')
    lane.graceTimer = this.deps.setTimer(() => {
      lane.graceTimer = null
      if (lane.child === child) child.kill('SIGKILL')
    }, this.deps.killGraceMs ?? GROUP_LANE_KILL_GRACE_MS)
  }

  private armIdle(lane: Lane): void {
    this.clearIdle(lane)
    lane.idleTimer = this.deps.setTimer(() => {
      lane.idleTimer = null
      if (lane.pendingOps === 0 && lane.child && !lane.closed && !lane.pausing) {
        lane.pausing = true
        void this.enqueue(lane, () => this.pauseNow(lane, 'idle'))
      }
    }, this.deps.idleOverrideMs ?? lane.idleMs)
  }

  private clearIdle(lane: Lane): void {
    if (lane.idleTimer === null) return
    this.deps.clearTimer(lane.idleTimer)
    lane.idleTimer = null
  }

  /**
   * The lane's own folder: under the lane root, OUTSIDE the home folder and
   * the agent folder, so the fence below Full (lib/group-lane-args.ts) can
   * refuse all of those while the lane still works in its own folder.
   */
  private laneFolder(chatId: string): string {
    return join(this.deps.laneRoot(), chatId)
  }

  private async prepareFolder(chatId: string): Promise<string> {
    const folder = this.laneFolder(chatId)
    if (!this.deps.fs.exists(folder)) this.deps.fs.mkdir(folder)
    return folder
  }

  /**
   * One state post, retried with backoff; a refusal (4xx) is not retried. A
   * 409 group_thread_closed forgets the lane's session once its step ends.
   */
  private postState(
    body: { chatId: string; state: 'live' | 'paused' | 'closed'; sessionId: string | null } & Record<string, unknown>,
    lane: Lane | null,
  ): void {
    const full = { assistantId: Number(this.deps.assistantId), ...body, chatId: Number(body.chatId) }
    const waits = this.deps.postRetryMs ?? GROUP_POST_RETRY_MS
    const run = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await this.deps.post(GROUP_STATE_PATH, full)
          // The server accepted a live or paused report: it knows this session.
          if (lane && (body.state === 'live' || body.state === 'paused') && body.sessionId !== null && lane.st.sessionId === body.sessionId && !lane.st.acked) {
            lane.st.acked = true
            this.persist(lane)
          }
          return
        } catch (err) {
          if (isGroupThreadClosed(err)) {
            this.deps.log(`groups: the server closed the thread of group ${body.chatId}, its session is forgotten`)
            if (lane && !lane.closed) {
              if (lane.busy || lane.pendingOps > 0) lane.serverClosed = true
              else {
                lane.serverClosed = true
                await this.afterOp(lane)
              }
            }
            return
          }
          const why = err instanceof Error ? err.name : 'error'
          if (isClientError(err) || attempt >= waits.length) {
            this.deps.log(`groups: ${GROUP_STATE_PATH} (${body.state}) failed, giving up (${why})`)
            return
          }
          await new Promise<void>((done) => this.deps.setTimer(done, waits[attempt]!))
        }
      }
    })()
    this.track(run)
  }

  private statePath(chatId: string): string {
    return join(this.deps.stateDir, `${chatId}.json`)
  }

  private persist(lane: Lane): void {
    if (lane.closed) return
    this.persistState(lane.st)
  }

  private persistState(st: GroupLaneState): void {
    try {
      this.deps.fs.mkdir(this.deps.stateDir)
      this.deps.fs.writeFile(this.statePath(st.chatId), `${JSON.stringify(st)}\n`)
    } catch (err) {
      this.deps.log(`groups: could not save lane state (${err instanceof Error ? err.name : 'error'})`)
    }
  }

  private forget(chatId: string): void {
    try {
      this.deps.fs.unlink(this.statePath(chatId))
    } catch {}
  }

  private load(chatId: string): GroupLaneState | null {
    let raw: unknown
    try {
      raw = JSON.parse(this.deps.fs.readFile(this.statePath(chatId)))
    } catch {
      return null
    }
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    const id = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null)
    const sessionId = isSessionId(r.sessionId) ? r.sessionId : null
    return {
      chatId,
      title: typeof r.title === 'string' ? r.title : '',
      sessionId,
      started: sessionId !== null && r.started === true,
      firstMessageId: id(r.firstMessageId),
      lastMessageId: id(r.lastMessageId),
      acked: sessionId !== null && r.acked === true,
      pid: typeof r.pid === 'number' && Number.isInteger(r.pid) && r.pid > 0 ? r.pid : null,
      pidStamp: typeof r.pidStamp === 'string' && r.pidStamp !== '' ? r.pidStamp : null,
    }
  }

  private track(p: Promise<unknown>): void {
    this.work.add(p)
    void p.finally(() => this.work.delete(p)).catch(() => {})
  }
}

export class GroupLaneError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}
