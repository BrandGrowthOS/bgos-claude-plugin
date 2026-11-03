/**
 * The stream json plumbing that thread lanes (lib/thread-lanes.ts) and By the
 * way (lib/aside-fork.ts) share: a child `claude -p` written to on stdin and
 * read as NDJSON on stdout.
 *
 * The child handle is an interface so both managers are unit tested with
 * fakes; spawnStreamJson is the real one server.ts passes in.
 */

import { spawn } from 'node:child_process'

export interface StreamJsonChild {
  /** The process id (it leads its own process group off Windows), when it started. */
  readonly pid?: number
  /** Write to stdin. A no op once the child is gone. */
  write(chunk: string): void
  /** Close stdin. */
  end(): void
  kill(signal: 'SIGTERM' | 'SIGKILL'): void
  onStdout(cb: (chunk: string) => void): void
  /** Called once: the exit, or a start that failed (code null). */
  onExit(cb: (code: number | null, signal: string | null) => void): void
}

export type SpawnStreamJson = (command: string, args: string[], opts: { cwd: string }) => StreamJsonChild

/** NDJSON: whole lines only, JSON objects only; anything else is skipped. */
export function lineSplitter(onFrame: (frame: Record<string, unknown>) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk: string) => {
    buffer += chunk
    let at = buffer.indexOf('\n')
    while (at >= 0) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      at = buffer.indexOf('\n')
      if (line === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) onFrame(parsed as Record<string, unknown>)
    }
  }
}

/** One user message in the CLI's `--input-format stream-json` shape. */
export function userMessageLine(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`
}

/**
 * The variables that tie a process to the session that launched this daemon.
 * A lane or a By the way fork is a session of its own: inheriting these would
 * let its hooks or its bridge speak as the main session.
 */
const PARENT_SESSION_VARS = [
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_PID',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
]

/**
 * The daemon's own BGOS credentials and its terminal. Nothing in a lane or a
 * By the way fork uses them: both load an empty MCP config (no BGOS server),
 * a lane runs --restricted (no hooks, no plugin), and an aside runs no hook
 * at all (lib/thread-lane-args.ts ASIDE_SETTINGS). A lane's Bash could read
 * every one of them.
 */
export const LANE_CREDENTIAL_VARS: readonly string[] = Object.freeze([
  'BGOS_API_KEY',
  'BGOS_PAIRING_TOKEN',
  'BGOS_CREDENTIALS_PATH',
  'BGOS_OPENAI_API_KEY',
  'HOAI_BROWSER_HOST_PAIRING_TOKEN',
  'HOAI_RELAY_PAIRING_TOKEN',
  'BGOS_TMUX_SESSION',
  'BGOS_TMUX_SOCKET',
  'TMUX',
  'TMUX_PANE',
])

/** Any other BGOS_ or HOAI_ variable whose name says it is a secret. */
const SECRET_NAME_RE = /^(?:BGOS|HOAI)_\w*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i

export function laneChildEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || PARENT_SESSION_VARS.includes(key)) continue
    if (LANE_CREDENTIAL_VARS.includes(key) || SECRET_NAME_RE.test(key)) continue
    out[key] = value
  }
  return out
}

/**
 * The real child: node's spawn with three pipes; stderr is drained and
 * dropped. Off Windows it leads its own process group (detached), and kill
 * signals the whole group, so the tools a lane started (a shell, a test run,
 * a dev server) stop with it. Its stdin stays a pipe, so a daemon that dies
 * outright still closes it, and `claude -p` ends on that.
 */
export function spawnStreamJson(command: string, args: string[], opts: { cwd: string }): StreamJsonChild {
  const ownGroup = process.platform !== 'win32'
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: laneChildEnv(process.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: ownGroup,
  })
  let gone = false
  const exitCallbacks: Array<(code: number | null, signal: string | null) => void> = []
  const finish = (code: number | null, signal: string | null): void => {
    if (gone) return
    gone = true
    for (const cb of exitCallbacks) cb(code, signal)
  }
  child.on('error', () => finish(null, null))
  child.on('exit', (code, signal) => finish(code, signal))
  child.stdin?.on('error', () => {})
  child.stdout?.setEncoding('utf8')
  child.stderr?.resume()
  return {
    pid: child.pid,
    write(chunk) {
      if (gone || !child.stdin || child.stdin.destroyed) return
      child.stdin.write(chunk)
    },
    end() {
      if (gone || !child.stdin || child.stdin.destroyed) return
      child.stdin.end()
    },
    kill(signal) {
      if (gone) return
      if (ownGroup && typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {}
      }
      try {
        child.kill(signal)
      } catch {}
    },
    onStdout(cb) {
      child.stdout?.on('data', (d: string) => cb(d))
    },
    onExit(cb) {
      exitCallbacks.push(cb)
    },
  }
}
