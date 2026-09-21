// ── Remote /compact injection (supervisor tmux path) ─────────────────────────
//
// The daemon is an MCP stdio child of the claude CLI process, so it cannot
// type into its parent's composer. When that CLI runs inside a tmux pane,
// `tmux send-keys` CAN type into the composer from the outside. This module
// is the ONLY place injection argv vectors are built, and it is structurally
// incapable of injecting anything except the fixed literals below:
//
//   - the injected command text comes exclusively from the frozen
//     INJECTABLE_LITERALS map, looked up by a TypeScript-narrowed key;
//     free strings (chat content, user input, backend payloads) can never
//     reach send-keys because no parameter accepts them
//   - the only other key ever sent is the literal 'Enter'
//
// SAFETY INVARIANT (tested in test/compact-inject.test.ts): EXACTLY ONE
// parameter carries chat-derived text into a key sequence, it is the owner's
// goal condition, and it is validated HERE and nowhere else. Stage 6 of the
// Mission program added it deliberately rather than by relaxing the rule: the
// owner's Keep working switch has to put `/goal <condition>` into the
// composer, and a native goal is the only thing on this channel that makes an
// agent keep working until a condition holds. Every other injected string is
// still a fixed literal looked up by a TypeScript-narrowed key, and no second
// parameter may be added. buildGoalSetInjectionSteps refuses (returns null,
// never throws) a condition that is empty, is more than one line, carries any
// control character, is longer than the runtime's own 4000 character cap, or
// begins with '/', because a condition beginning with a slash would type a
// DIFFERENT slash command into the composer. Target and socket identifiers
// come only from supervisor-set environment variables and are validated
// against strict character sets as defense in depth (argv exec means no shell
// is ever involved).
//
// Capability contract (documented for supervisors):
//   BGOS_TMUX_SESSION  tmux session (or any -t target spec) that hosts the
//                      claude CLI. Set by the supervisor that launches
//                      claude inside tmux. Presence turns the capability ON.
//   BGOS_TMUX_SOCKET   optional tmux socket NAME (tmux -L). Omit for the
//                      default socket.
//   auto-detect        when BGOS_TMUX_SESSION is absent but the daemon
//                      inherited TMUX + TMUX_PANE (claude itself runs in a
//                      tmux pane), the exact pane is targeted via the socket
//                      path from $TMUX. Zero supervisor changes needed.
//   BGOS_REMOTE_COMPACT=off  hard opt-out, wins over everything.

import { GOAL_CONDITION_MAX } from './goal-status.ts'

/** The runtime's own cap on a /goal condition, shared with the lane's mapper
 *  so both halves read one number. Re-exported because this file is where a
 *  caller building an injection asks about it. */
export { GOAL_CONDITION_MAX }

export const INJECTABLE_LITERALS = Object.freeze({
  compact: '/compact',
  /** Stops a native goal. FIXED, no parameter: clearing is the same keystroke
   *  whatever the goal was, so the cap, the stall rule, a pause and an
   *  abandon all send this one constant. */
  goalClear: '/goal clear',
} as const)

export type InjectableCommand = keyof typeof INJECTABLE_LITERALS

// tmux target specs: session names, window/pane ids (%5, @2, sess:1.0).
// No whitespace, no shell metacharacters.
const TARGET_RE = /^[@%A-Za-z0-9_.:-]+$/
// Socket NAME for -L (a filename component, not a path).
const SOCKET_NAME_RE = /^[A-Za-z0-9_.-]+$/
// Socket PATH from $TMUX (absolute path; no control chars).
// eslint-disable-next-line no-control-regex
const SOCKET_PATH_RE = /^\/[^\0\n]+$/

export interface TmuxTarget {
  /** tmux target spec passed to -t (session name or pane id). */
  target: string
  /** Socket selector args: ['-L', name], ['-S', path], or []. */
  socketArgs: readonly string[]
  /** How the target was determined (for logs). */
  source: 'env-session' | 'tmux-pane'
}

/**
 * Detect the remote-compact capability from the environment. Returns null
 * when the capability is OFF (no supervisor contract, not inside tmux, or
 * explicitly disabled).
 */
export function resolveTmuxTarget(
  env: Record<string, string | undefined> = process.env,
): TmuxTarget | null {
  if ((env.BGOS_REMOTE_COMPACT ?? '').toLowerCase() === 'off') return null
  const session = env.BGOS_TMUX_SESSION
  if (session !== undefined && session !== '') {
    if (!TARGET_RE.test(session)) return null
    const socket = env.BGOS_TMUX_SOCKET
    if (socket !== undefined && socket !== '' && !SOCKET_NAME_RE.test(socket)) {
      return null
    }
    return {
      target: session,
      socketArgs: socket ? ['-L', socket] : [],
      source: 'env-session',
    }
  }
  // Auto-detect: the CLI (our parent) runs inside a tmux pane, so this
  // process inherited TMUX (socket_path,server_pid,session_id) and
  // TMUX_PANE (%N). Targeting the exact pane is MORE precise than a session
  // name (a session's active pane can change; a pane id cannot).
  const tmux = env.TMUX
  const pane = env.TMUX_PANE
  if (tmux && pane && /^%\d+$/.test(pane)) {
    const socketPath = tmux.split(',')[0] ?? ''
    if (!SOCKET_PATH_RE.test(socketPath)) return null
    return { target: pane, socketArgs: ['-S', socketPath], source: 'tmux-pane' }
  }
  return null
}

/**
 * Probe argv: exits 0 when the target pane/session exists. display-message
 * resolves ANY target spec (has-session only accepts sessions, so it cannot
 * probe a pane id).
 */
export function buildProbeArgs(t: TmuxTarget): string[] {
  return ['tmux', ...t.socketArgs, 'display-message', '-p', '-t', t.target, 'ok']
}

export interface InjectionStep {
  argv: string[]
  /** Milliseconds to wait BEFORE running this step. */
  delayMsBefore: number
}

/**
 * Build the exact key-injection sequence for an allow-listed command:
 *   1. type the fixed literal (send-keys -l disables key-name lookup, so the
 *      text is typed verbatim, never interpreted as key names)
 *   2. Enter to run it (the CLI's slash menu has the fully-typed command as
 *      its top match, so Enter executes it)
 *   3. a second Enter after a beat: if the composer treated the text as a
 *      bracketed paste the first Enter only confirmed the paste; a second
 *      Enter on an already-submitted (empty) composer is a harmless no-op.
 */
export function buildInjectionSteps(
  t: TmuxTarget,
  command: InjectableCommand,
): InjectionStep[] {
  const literal: string = INJECTABLE_LITERALS[command]
  if (typeof literal !== 'string') {
    throw new Error(`not an injectable command: ${String(command)}`)
  }
  return typeSteps(t, literal)
}

/**
 * The three steps that type one line into the composer and submit it.
 *
 * The `--` is what makes the text SAFE to parameterise: without it tmux reads
 * a payload beginning with a dash as a flag of send-keys, so a condition like
 * "-r must still be handled" would be swallowed or refused. The fixed literals
 * never hit that (both begin with a slash) and they carry the separator too,
 * so there is one argv shape in this file rather than two.
 */
function typeSteps(t: TmuxTarget, literal: string): InjectionStep[] {
  const base = ['tmux', ...t.socketArgs, 'send-keys', '-t', t.target]
  return [
    { argv: [...base, '-l', '--', literal], delayMsBefore: 0 },
    { argv: [...base, 'Enter'], delayMsBefore: 400 },
    { argv: [...base, 'Enter'], delayMsBefore: 400 },
  ]
}

// Any C0 or C1 control character, DEL included. A composer line is one line of
// printable text; anything else is either a second line or a terminal escape,
// and neither belongs in a key sequence.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/

/**
 * The ONE parameterised literal in this file: type `/goal <condition>` into
 * the composer.
 *
 * Returns null for a condition this daemon will not type, and never throws,
 * because the callers are a socket handler and a transcript poll and a throw
 * in either takes something larger down. Null is a complete answer: the caller
 * tells the owner it could not arm the goal, and nothing half typed is ever
 * sent, because the refusal happens before the first argv exists.
 *
 * The rules, and why each one is here:
 *
 *   empty or whitespace only  the runtime refuses it and the owner would see
 *                             a goal called nothing
 *   more than one line        the first Enter would submit a fragment and the
 *                             rest would be typed into the next prompt
 *   any control character     a terminal escape typed into the composer is a
 *                             different kind of instruction entirely
 *   longer than 4000          the runtime's own cap, so a longer one is
 *                             rejected after it has already been typed
 *   begins with '/'           the whole reason this parameter is allowed at
 *                             all is that it cannot become another command
 */
export function buildGoalSetInjectionSteps(
  t: TmuxTarget,
  condition: string,
): InjectionStep[] | null {
  if (typeof condition !== 'string') return null
  const trimmed = condition.trim()
  if (trimmed === '') return null
  if (trimmed.length > GOAL_CONDITION_MAX) return null
  if (CONTROL_CHAR_RE.test(trimmed)) return null
  if (trimmed.startsWith('/')) return null
  return typeSteps(t, `/goal ${trimmed}`)
}
