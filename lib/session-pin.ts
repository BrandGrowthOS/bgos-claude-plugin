/**
 * The session pin: the daemon records the LIVE Claude session it serves into
 * ~/.bgos-agent/<id>/session-id (finding 7, design section 4).
 *
 * WHY (finding 7, Data supervising five real agents on kc-server,
 * 2026-10-06). `bgos-agent install --always-on` started a FRESH conversation;
 * Ava had to add `--resume <pinned session id>` to each spawn line by hand so
 * her agent kept its memory. The product supervisor now runs hoai, which
 * already owns resumption (bin/hoai-core.mjs: resume the pin when its
 * transcript exists, create it with that exact id when it does not, never
 * --continue). That only helps an agent whose pin names its real
 * conversation. An agent first started with plain `claude` has no pin, or a
 * pin naming an older session, so the moment the supervisor takes over (after
 * a crash, a reboot, an update restart) it resumes the wrong conversation or
 * starts an empty one. Only the daemon knows which session is live: its own
 * hook events name it. So it writes it into the pin.
 *
 * The guards, each with its reason:
 *   - Only the daemon HOLDING the channel (pairing lock held and delivery
 *     armed). A `claude -p` or a subagent started in the same folder runs a
 *     daemon too; it is passive while the agent lives, and its session must
 *     never become the agent's identity. The hook intake is holder-only and
 *     admits only the session it positively bound (lib/hook-intake.ts), so
 *     the id itself is already this agent's own.
 *   - Only a daemon that PASSED THE HOME CHECK (lib/agent-credentials.ts
 *     homeCheckPassed): a pin, a matching home, or the kill-switch. A stray
 *     that found the agent by elimination while the agent was down holds the
 *     channel legitimately, but it has proven nothing about being the agent,
 *     and repointing the pin to its session would make the next supervised
 *     relaunch open the stray's conversation (board fc75c7c3).
 *   - Never a print-mode claude (`-p` / `--print` on the claude ancestor's
 *     command line): a one-shot run that took the lock while the agent was
 *     down is not the agent. Unknown (no ps, e.g. Windows) does not veto.
 *   - The session must have stayed up for SESSION_PIN_SETTLE_MS, longer than
 *     hoai's own health window: hoai commits a fresh fallback session to the
 *     pin only after it survived RELAUNCH_HEALTHY_MS (zaid, 2026-09-02, a
 *     fast-dying fresh session must not burn the pin), and pinning earlier
 *     would undo that rule. It is also the one-minute transient filter the
 *     home binding used up to 0.64.3.
 *   - The live session's transcript must exist where hoai looks for it
 *     (<config>/projects/<munged cwd>/<id>.jsonl, the exact hoai-core
 *     functions, imported, never re-derived): a pin hoai cannot resume would
 *     only be recreated by id, an empty conversation under the right name.
 *   - Write only when the pin is missing, not UUID shaped, names a session
 *     with no transcript, or differs from the live session; never a non-UUID
 *     live id (hoai passes the pin straight to --resume / --session-id).
 *   - Once per live session: after it is pinned (or found pinned) the keeper
 *     leaves a pin that CHANGED alone for that session, so a deliberate repin
 *     (`hoai --new`) is never fought. A pin that VANISHED is restored: no one
 *     deletes a pin on purpose, but `bgos-agent uninstall` (always-on turned
 *     off) removes the whole state dir today, and an agent turned back on
 *     must still resume this conversation. A new live session is a new
 *     question.
 *   - Atomic (temp file, rename), never throws.
 */

import {
  RELAUNCH_HEALTHY_MS,
  SESSION_ID_FILE_NAME,
  isSessionIdLike,
  joinDir,
  sessionTranscriptPath,
} from '../bin/hoai-core.mjs'
import { type AgentStateFs, writeTextAtomic } from './agent-state.js'
import { agentStateDir } from './update-readiness.js'

/** How long a live session must have been seen before it may be pinned.
 *  At least hoai's RELAUNCH_HEALTHY_MS (pinned by test), and one minute. */
export const SESSION_PIN_SETTLE_MS = Math.max(60_000, RELAUNCH_HEALTHY_MS)
/** How often server.ts asks while the live session is not pinned yet. */
export const SESSION_PIN_CHECK_MS = 30_000

export type SessionPinDecision =
  | { action: 'write'; sessionId: string; reason: 'missing' | 'malformed' | 'no-transcript' | 'differs' }
  | {
      action: 'skip'
      reason:
        | 'not-holder'
        | 'home-unconfirmed'
        | 'no-live-session'
        | 'live-not-uuid'
        | 'print-mode'
        | 'settling'
        | 'no-live-transcript'
        | 'pinned'
    }

type LiveGuardReason =
  | 'not-holder'
  | 'home-unconfirmed'
  | 'no-live-session'
  | 'live-not-uuid'
  | 'print-mode'
  | 'settling'

/** The guards that need no file read: who is asking, and about which
 *  session. Null when the live session may be considered at all. */
export function liveSessionGuard(input: {
  holdsChannel: boolean
  homeConfirmed: boolean
  liveSessionId: string | null
  liveSessionAgeMs: number
  printMode: boolean | null
}): LiveGuardReason | null {
  if (!input.holdsChannel) return 'not-holder'
  if (input.homeConfirmed !== true) return 'home-unconfirmed'
  const live = String(input.liveSessionId ?? '').trim()
  if (!live) return 'no-live-session'
  if (!isSessionIdLike(live)) return 'live-not-uuid'
  if (input.printMode === true) return 'print-mode'
  if (!(input.liveSessionAgeMs >= SESSION_PIN_SETTLE_MS)) return 'settling'
  return null
}

/** The pure decision. `printMode` null means unknown, which does not veto. */
export function decideSessionPin(input: {
  holdsChannel: boolean
  homeConfirmed: boolean
  liveSessionId: string | null
  liveSessionAgeMs: number
  printMode: boolean | null
  liveTranscriptExists: boolean
  pinRaw: string | null
  pinTranscriptExists: boolean
}): SessionPinDecision {
  const blocked = liveSessionGuard(input)
  if (blocked) return { action: 'skip', reason: blocked }
  const live = String(input.liveSessionId ?? '').trim()
  if (!input.liveTranscriptExists) return { action: 'skip', reason: 'no-live-transcript' }
  const pin = String(input.pinRaw ?? '').trim()
  if (pin === live) return { action: 'skip', reason: 'pinned' }
  if (!pin) return { action: 'write', sessionId: live, reason: 'missing' }
  if (!isSessionIdLike(pin)) return { action: 'write', sessionId: live, reason: 'malformed' }
  if (!input.pinTranscriptExists) return { action: 'write', sessionId: live, reason: 'no-transcript' }
  return { action: 'write', sessionId: live, reason: 'differs' }
}

/** ~/.bgos-agent/<id>/session-id, the file hoai-core pins and resumes. Null
 *  without a digits-only assistant id. */
export function sessionPinPath(home: string, assistantId: string | number | null | undefined): string | null {
  const dir = agentStateDir(home, assistantId)
  return dir ? joinDir(dir, SESSION_ID_FILE_NAME) : null
}

/** Where hoai looks for this session's transcript: hoai-core's own function,
 *  so the munge (every non alphanumeric cwd character to '-') and the
 *  CLAUDE_CONFIG_DIR rule can never drift from the launcher's. */
export function liveTranscriptPath(input: { home: string; cwd: string; sessionId: string; configDir: string }): string {
  return sessionTranscriptPath(input.home, input.cwd, input.sessionId, input.configDir)
}

/** Is this claude command line a one-shot print-mode run? */
export function isPrintModeCommand(command: string | null | undefined): boolean {
  if (typeof command !== 'string') return false
  return command
    .split(/\s+/)
    .some((token) => token === '-p' || token === '--print' || token.startsWith('--print='))
}

/** `ps -o command= -p <pid>`: the full command line, or null. */
export function readProcessCommand(
  pid: number,
  execSync: (file: string, args: string[]) => { code: number; stdout: string },
): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  try {
    const result = execSync('ps', ['-o', 'command=', '-p', String(pid)])
    const text = String(result.stdout ?? '').trim()
    return result.code === 0 && text ? text : null
  } catch {
    return null
  }
}

/** Write the pin through a temp file and a rename (hoai may read it at any
 *  moment, and a torn read would resume nothing); exactly the id, no newline,
 *  as hoai-core writes it. False on failure; never throws. */
export function writeSessionPinAtomic(path: string, sessionId: string, fs?: AgentStateFs): boolean {
  return writeTextAtomic(path, sessionId, fs)
}

export type SessionPinCheck =
  | SessionPinDecision
  | { action: 'skip'; reason: 'done' | 'no-assistant-id' | 'write-failed' | 'error' }

/**
 * The stateful half: reads the files, applies decideSessionPin, writes, and
 * remembers the live session it settled so it never rewrites the pin for that
 * session again. One per daemon process.
 */
export class SessionPinKeeper {
  private readonly deps: {
    home: string
    cwd: string
    /** process.env.CLAUDE_CONFIG_DIR raw ('' when unset), as hoai passes it. */
    configDir: string
    assistantId: string | number | null | undefined
    exists: (path: string) => boolean
    readFile: (path: string) => string | null
    write?: (path: string, sessionId: string) => boolean
    log?: (line: string) => void
  }
  private settledFor: string | null = null

  constructor(deps: SessionPinKeeper['deps']) {
    this.deps = deps
  }

  check(
    live: {
      holdsChannel: boolean
      /** Passed the home check (lib/agent-credentials.ts homeCheckPassed). */
      homeConfirmed: boolean
      sessionId: string | null
      seenAtMs: number
      printMode: boolean | null
    },
    nowMs: number,
  ): SessionPinCheck {
    try {
      const liveId = String(live.sessionId ?? '').trim() || null
      const path = sessionPinPath(this.deps.home, this.deps.assistantId)
      if (!path) return { action: 'skip', reason: 'no-assistant-id' }
      // Settled for this session: one existence check, and the full decision
      // only when the pin is gone (see the header: restore, never fight).
      if (liveId !== null && liveId === this.settledFor && this.deps.exists(path)) {
        return { action: 'skip', reason: 'done' }
      }
      // Cheap guards first: nothing is read for a passive or unsettled daemon.
      const blocked = liveSessionGuard({
        holdsChannel: live.holdsChannel,
        homeConfirmed: live.homeConfirmed,
        liveSessionId: liveId,
        liveSessionAgeMs: nowMs - live.seenAtMs,
        printMode: live.printMode,
      })
      if (blocked) {
        // A print-mode session never becomes pinnable; stop asking about it.
        if (blocked === 'print-mode') this.settledFor = liveId
        return { action: 'skip', reason: blocked }
      }
      const transcript = (id: string) =>
        liveTranscriptPath({ home: this.deps.home, cwd: this.deps.cwd, sessionId: id, configDir: this.deps.configDir })
      const pinRaw = this.deps.readFile(path)
      const pin = String(pinRaw ?? '').trim()
      const decision = decideSessionPin({
        holdsChannel: live.holdsChannel,
        homeConfirmed: live.homeConfirmed,
        liveSessionId: liveId,
        liveSessionAgeMs: nowMs - live.seenAtMs,
        printMode: live.printMode,
        liveTranscriptExists: this.deps.exists(transcript(liveId as string)),
        pinRaw,
        pinTranscriptExists: isSessionIdLike(pin) ? this.deps.exists(transcript(pin)) : false,
      })
      if (decision.action === 'skip') {
        if (decision.reason === 'pinned') this.settledFor = liveId
        return decision
      }
      const write = this.deps.write ?? writeSessionPinAtomic
      if (!write(path, decision.sessionId)) return { action: 'skip', reason: 'write-failed' }
      this.settledFor = decision.sessionId
      this.deps.log?.(
        `session pin: recorded the live session ${decision.sessionId} for this agent (${decision.reason}); ` +
          'a supervised relaunch now resumes this conversation',
      )
      return decision
    } catch {
      return { action: 'skip', reason: 'error' }
    }
  }
}
