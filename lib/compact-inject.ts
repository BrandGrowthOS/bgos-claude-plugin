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
// SAFETY INVARIANT (tested in test/compact-inject.test.ts): never add a
// parameter that lets user/chat-derived content flow into an injected key
// sequence. Target and socket identifiers come only from supervisor-set
// environment variables and are validated against strict character sets as
// defense in depth (argv exec means no shell is ever involved).
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

export const INJECTABLE_LITERALS = Object.freeze({
  compact: '/compact',
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
  const base = ['tmux', ...t.socketArgs, 'send-keys', '-t', t.target]
  return [
    { argv: [...base, '-l', literal], delayMsBefore: 0 },
    { argv: [...base, 'Enter'], delayMsBefore: 400 },
    { argv: [...base, 'Enter'], delayMsBefore: 400 },
  ]
}
