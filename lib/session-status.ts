/**
 * The session status this daemon reports on its heartbeat (HOAI board row
 * 9c3d6b2c, session liveness, option C approved by Kc on 2026-10-09).
 *
 * WHY. The server only ever hears from this daemon, and this daemon keeps
 * checking in while the Claude Code session behind it has frozen, so a frozen
 * agent read `online` in green. This daemon already knows what its session is
 * doing (lib/agent-state.ts writes it for the watcher every 30 s); the facts
 * below go to the server, which turns them into a word and, for two weeks,
 * only logs it. The wire shape is the shared contract in
 * lib/session-status-contract.ts (a byte identical copy of the BGOS file).
 *
 * FACTS, NEVER CONTENT. Counts, one flag per fact and instants: no message
 * text, no file name, no command. The builder takes numbers only, so nothing
 * else can reach the wire (test/session-status.test.ts replays a real hook
 * stream full of commands and paths and checks none of it leaks).
 *
 * THE SESSION'S ACTIVITY, NOT THIS DAEMON'S. agent-state.json's
 * lastActivityAt also counts the daemon's boot, its deliveries and the edges
 * of busy, because the watcher wants the quiet window to start there. Here
 * that would be wrong: a frozen session's daemon keeps delivering and
 * polling. So the caller passes only what the session itself did (a hook
 * event, a bgos tool call, a transcript write). The same reason keeps
 * agent-state's `activeOperations` out: it counts this daemon's own chat polls
 * and tool handlers, so a frozen session's daemon would read "running" every
 * time a poll happened to be in flight. Running is read off the hook rail's
 * open rows instead (countRunningWork).
 */
import { type TurnState } from './hook-events.ts'
import {
  SESSION_STATUS_BUSY_MS,
  SESSION_STATUS_CHANGE_MS,
  SESSION_STATUS_MAX_COUNT,
  SESSION_STATUS_VERSION,
  type SessionStatusReport,
} from './session-status-contract.ts'

/** What the daemon reads off its live state for one report. */
export interface SessionFacts {
  /** A turn is in flight on the hook rail, a child still working included. */
  turnInFlight: boolean
  /** Whether turnInFlight means anything (lib/agent-state.ts TurnSignal). */
  turnSignal: 'hooks' | 'none'
  /** Permission requests, blocking questions and plan cards on the owner. */
  questionsWaiting: number
  /** Messages delivered to the session and not answered yet. */
  messagesWaiting: number
  /** When the oldest of those reached this daemon (epoch ms), or null. */
  oldestMessageAtMs: number | null
  /** Commands and helper agents the session started, still running. */
  running: number
  /** Every time the SESSION itself did something (epoch ms; null when never). */
  sessionActivityAtMs: Array<number | null | undefined>
}

/** How often the daemon looks for a change (a few object reads, no I/O). */
export const SESSION_STATUS_TICK_MS = 5_000

/**
 * The shortest gap between two sends. Gap plus tick is the contract's change
 * window, so a change waits at most a minute, and the daemon sends at most one
 * report a minute however busy its session is (the design's cost bound).
 */
export const SESSION_STATUS_MIN_GAP_MS = SESSION_STATUS_CHANGE_MS - SESSION_STATUS_TICK_MS

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.min(Math.floor(value), SESSION_STATUS_MAX_COUNT)
}

function iso(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  try {
    return new Date(ms).toISOString()
  } catch {
    return null
  }
}

/** The report, field for field in the contract's wire order. */
export function buildSessionStatus(facts: SessionFacts, nowMs: number): SessionStatusReport {
  // Fail toward "cannot tell": a task the hook rail does not vouch for is
  // unknown, never a false "no task" the server would read as idle.
  const taskOpen = facts.turnSignal === 'hooks' ? facts.turnInFlight === true : null
  const questionsWaiting = count(facts.questionsWaiting)
  const messagesWaiting = count(facts.messagesWaiting)
  const running = count(facts.running)
  const times = (Array.isArray(facts.sessionActivityAtMs) ? facts.sessionActivityAtMs : []).filter(
    (t): t is number => typeof t === 'number' && Number.isFinite(t),
  )
  return {
    v: SESSION_STATUS_VERSION,
    at: iso(nowMs) ?? new Date(0).toISOString(),
    busy: taskOpen === true || questionsWaiting > 0 || messagesWaiting > 0 || running > 0,
    lastActivityAt: times.length > 0 ? iso(Math.max(...times)) : null,
    taskOpen,
    questionsWaiting,
    messagesWaiting,
    oldestMessageAt: messagesWaiting > 0 ? iso(facts.oldestMessageAtMs) : null,
    running,
  }
}

/**
 * What the session started and is still running, off the hook rail: the live
 * turn's open rows (a command between its PreToolUse and PostToolUse, a helper
 * agent not yet stopped), plus the helpers of a turn that ended while they
 * worked (a carried card). This daemon's own MCP tools never draw a row, so a
 * blocking question to the owner is counted as a question, not as running.
 */
export function countRunningWork(turn: TurnState): number {
  let running = 0
  for (const row of turn.tools.values()) if (row.status === 'running') running += 1
  for (const card of turn.carried.values()) {
    for (const row of card.tools.values()) {
      if (row.kind === 'subagent' && row.status === 'running') running += 1
    }
  }
  return running
}

/** Everything but the build time: two reports with one signature are the same news. */
export function sessionStatusSignature(report: SessionStatusReport): string {
  const { at: _at, ...rest } = report
  return JSON.stringify(rest)
}

export type SessionStatusDue = 'first' | 'changed' | 'busy' | null

/**
 * Whether a report goes out on this tick. `lastAttemptAtMs` is the last send
 * TRIED (the gap holds after a failure too, so a down server is not hammered);
 * `lastSentSignature` is the last one the server took (a failed send is tried
 * again after the gap, because the server never saw it).
 */
export function sessionStatusDue(input: {
  nowMs: number
  lastAttemptAtMs: number | null
  lastSentSignature: string | null
  report: SessionStatusReport
}): SessionStatusDue {
  const since = input.lastAttemptAtMs === null ? Infinity : input.nowMs - input.lastAttemptAtMs
  if (input.lastSentSignature === null && input.lastAttemptAtMs === null) return 'first'
  if (sessionStatusSignature(input.report) !== input.lastSentSignature) {
    return since >= SESSION_STATUS_MIN_GAP_MS ? 'changed' : null
  }
  if (input.report.busy && since >= SESSION_STATUS_BUSY_MS) return 'busy'
  return null
}
